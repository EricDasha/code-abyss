#!/usr/bin/env node
'use strict';

// code-abyss → opencode 一键安装器（放在 EricDasha/code-abyss 仓库根目录）
//
// 用法:
//   node install.js              安装/刷新全部人设 agents，并把默认 agent 设为 abyss
//   node install.js --no-default 只装 agents，不改 default_agent
//   node install.js --uninstall  移除本安装器写入的 agents，还原 default_agent
//
// 复用 code-abyss 官方渲染管线（renderRuntimeGuidance）：
//   人格 voice card + 共享行为层(铁律/注入防御/内核路由/技能路由) + 输出风格 + 内核边界锚
// 技能不重复安装：opencode 已自动加载 ~/.claude/skills/ 下的 code-abyss 技能。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const MANIFEST_PATH = path.join(DIR, 'manifest.json');
const OPENCODE_DIR = path.join(os.homedir(), '.config', 'opencode');
const AGENT_DIR = path.join(OPENCODE_DIR, 'agent');
const CONFIG_PATH = path.join(OPENCODE_DIR, 'opencode.json');

// 人设 × 风格配对（与 README 的 persona·style 组合一致）
const PERSONA_STYLE_PAIR = Object.freeze({
  abyss: 'abyss-cultivator',
  scholar: 'scholar-classic',
  'elder-sister': 'elder-sister-gentle',
  'junior-sister': 'junior-sister-spark',
  'iron-dad': 'iron-dad-warm',
  'dongbei-yujie': 'dongbei-yujie-blunt',
});

const DEFAULT_PERSONA = 'abyss';

function log(msg) { console.log(msg); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ! ${msg}`); }

function ensurePackage() {
  const marker = path.join(DIR, 'node_modules', 'code-abyss', 'package.json');
  if (fs.existsSync(marker)) return;
  log('[1/4] 首次运行：安装 code-abyss 包 …');
  const r = spawnSync('npm install --no-audit --no-fund', {
    cwd: DIR,
    stdio: 'inherit',
    shell: true,
  });
  if (r.status !== 0) {
    console.error('npm install 失败');
    process.exit(1);
  }
}

function looksLikeRepo(root) {
  return ['bin/lib/style-registry.js', 'bin/lib/persona-fetch.js',
    'config/personas/index.json', 'output-styles/index.json']
    .every((rel) => fs.existsSync(path.join(root, rel)));
}

function loadLibs() {
  // 源码仓库优先：在 EricDasha/code-abyss 的 clone 根目录直接运行时，
  // 复用工作树自身的 bin/lib + config + output-styles（零安装、紧跟分支）。
  const candidates = [
    DIR,
    path.join(DIR, 'repo'),
    process.env.CODE_ABYSS_REPO && path.resolve(process.env.CODE_ABYSS_REPO),
  ].filter(Boolean);
  for (const repoRoot of candidates) {
    if (looksLikeRepo(repoRoot)) {
      const styleRegistry = require(path.join(repoRoot, 'bin', 'lib', 'style-registry.js'));
      const personaFetch = require(path.join(repoRoot, 'bin', 'lib', 'persona-fetch.js'));
      return { pkgRoot: repoRoot, styleRegistry, personaFetch };
    }
  }
  const pkgRoot = path.dirname(
    require.resolve('code-abyss/package.json', { paths: [DIR] })
  );
  const styleRegistry = require(path.join(pkgRoot, 'bin', 'lib', 'style-registry.js'));
  const personaFetch = require(path.join(pkgRoot, 'bin', 'lib', 'persona-fetch.js'));
  return { pkgRoot, styleRegistry, personaFetch };
}

function buildAgentFile(label, styleLabel, guidance) {
  const description = `code-abyss 人设：${label}（风格：${styleLabel}）`;
  return [
    '---',
    `description: ${JSON.stringify(description)}`,
    'mode: primary',
    '---',
    '',
    guidance.replace(/\s+$/, ''),
    '',
  ].join('\n');
}

async function install(opts) {
  const { pkgRoot, styleRegistry, personaFetch } = loadLibs();
  const personas = styleRegistry.listPersonas(pkgRoot);
  const defaultStyle = styleRegistry.getDefaultStyle(pkgRoot, 'codex');

  fs.mkdirSync(AGENT_DIR, { recursive: true });

  log('[2/4] 解析人格（远程人设按需抓取并缓存）…');
  const renderable = [];
  for (const p of personas) {
    if (p.core === false) {
      try {
        await personaFetch.ensurePersona(p.slug, styleRegistry.getRemoteBase(pkgRoot));
      } catch (e) {
        warn(`跳过 ${p.slug}：远程人格抓取失败（${e.message}）`);
        continue;
      }
    }
    renderable.push(p);
  }

  log('[3/4] 渲染并写入 opencode agents …');
  const written = [];
  for (const p of renderable) {
    const styleSlug = PERSONA_STYLE_PAIR[p.slug] || defaultStyle.slug;
    const style = styleRegistry.resolveStyle(pkgRoot, styleSlug, 'codex');
    if (!style) {
      warn(`跳过 ${p.slug}：未知风格 ${styleSlug}`);
      continue;
    }
    const guidance = styleRegistry.renderRuntimeGuidance(pkgRoot, styleSlug, 'codex', p.slug);
    const filePath = path.join(AGENT_DIR, `${p.slug}.md`);
    fs.writeFileSync(filePath, buildAgentFile(p.label, style.label, guidance), 'utf8');
    written.push(filePath);
    ok(`${p.label} × ${style.label} → agent/${p.slug}.md`);
  }

  const manifest = {
    installer: 'code-abyss-opencode',
    installed_at: new Date().toISOString(),
    files: written,
    default_agent: null,
  };

  if (!opts.noDefault && written.some((f) => path.basename(f) === `${DEFAULT_PERSONA}.md`)) {
    log('[4/4] 设置 default_agent → ' + DEFAULT_PERSONA);
    const result = setDefaultAgent(DEFAULT_PERSONA);
    if (result.changed) {
      manifest.default_agent = result;
      ok(result.backup ? `已备份原配置 → ${path.basename(result.backup)}` : 'opencode.json 已更新');
      ok(`default_agent: ${JSON.stringify(result.prev)} → ${JSON.stringify(DEFAULT_PERSONA)}`);
    } else {
      warn(result.reason || 'default_agent 未改动');
    }
  } else {
    log('[4/4] 跳过 default_agent 设置');
  }

  manifest.pkg_root = pkgRoot;
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  log('');
  log('⚚ 劫破。安装完成：');
  log(`  · ${written.length} 个人设 agent → ${AGENT_DIR}`);
  log(`  · 默认 agent → ${DEFAULT_PERSONA}（重启 opencode 生效）`);
  log('  · 切换人设：/agent（或重启时选择）');
  log('  · 技能已由 ~/.claude/skills 自动加载，无需重复安装');
  log('  · 卸载：node ' + path.join(DIR, 'install.js') + ' --uninstall');
}

function setDefaultAgent(value) {
  if (!fs.existsSync(CONFIG_PATH)) {
    const cfg = { $schema: 'https://opencode.ai/config.json', default_agent: value };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return { changed: true, prev: null, backup: null, value };
  }
  let cfg;
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    return { changed: false, reason: `opencode.json 解析失败，未改动（${e.message}）` };
  }
  if (cfg.default_agent === value) {
    return { changed: false, reason: 'default_agent 已是 ' + value };
  }
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const backup = `${CONFIG_PATH}.bak-codeabyss-${stamp}`;
  fs.copyFileSync(CONFIG_PATH, backup);
  const prev = cfg.default_agent === undefined ? null : cfg.default_agent;
  cfg.default_agent = value;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { changed: true, prev, backup, value };
}

function uninstall() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('未找到 manifest.json，无可卸载记录。');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  log('[1/2] 移除 agents …');
  for (const f of manifest.files || []) {
    if (fs.existsSync(f)) {
      fs.rmSync(f);
      ok(path.relative(AGENT_DIR, f));
    }
  }

  log('[2/2] 还原 default_agent …');
  if (manifest.default_agent && fs.existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (cfg.default_agent === manifest.default_agent.value) {
        if (manifest.default_agent.prev == null) delete cfg.default_agent;
        else cfg.default_agent = manifest.default_agent.prev;
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
        ok(`default_agent 还原为 ${JSON.stringify(manifest.default_agent.prev)}`);
      } else {
        warn('default_agent 已被手动改动，保持现状');
      }
    } catch (e) {
      warn(`opencode.json 处理失败：${e.message}`);
    }
  }

  fs.rmSync(MANIFEST_PATH);
  log('⚚ 卸载完成（技能与 abyss CLI 不在本安装器管辖内，保持原样）。');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--uninstall')) {
    uninstall();
    return;
  }
  log('[0/4] code-abyss → opencode 一键安装');
  ensurePackage();
  await install({ noDefault: args.includes('--no-default') });
}

main().catch((e) => {
  console.error('安装失败:', e);
  process.exit(1);
});
