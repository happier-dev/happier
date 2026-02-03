import './utils/env/env.mjs';
import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getHappyStacksHomeDir, getRootDir } from './utils/paths/paths.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { ensureEnvLocalUpdated } from './utils/env/env_local.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './utils/env/sandbox.mjs';
import { normalizeProfile } from './utils/cli/normalize.mjs';
import { banner, kv, sectionTitle } from './utils/ui/layout.mjs';
import { cyan, dim, green } from './utils/ui/ansi.mjs';
import { detectSwiftbarPluginInstalled } from './utils/menubar/swiftbar.mjs';

async function ensureSwiftbarAssets({ cliRootDir }) {
  const homeDir = getHappyStacksHomeDir();
  const destDir = join(homeDir, 'extras', 'swiftbar');
  const srcDir = join(cliRootDir, 'extras', 'swiftbar');

  if (!existsSync(srcDir)) {
    throw new Error(`[menubar] missing assets at: ${srcDir}`);
  }

  await mkdir(destDir, { recursive: true });
  await cp(srcDir, destDir, {
    recursive: true,
    force: true,
    filter: (p) => !p.includes('.DS_Store'),
  });

  return { homeDir, destDir };
}

function openSwiftbarPluginsDir() {
  const s = 'DIR="$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null)"; if [[ -z "$DIR" ]]; then DIR="$HOME/Library/Application Support/SwiftBar/Plugins"; fi; open "$DIR"';
  const res = spawnSync('bash', ['-lc', s], { stdio: 'inherit' });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

function sandboxPluginBasename() {
  const sandboxDir = (process.env.HAPPIER_STACK_SANDBOX_DIR ?? '').trim();
  if (!sandboxDir) return '';
  const hash = createHash('sha256').update(sandboxDir).digest('hex').slice(0, 10);
  return `hstack.sandbox-${hash}`;
}

function removeSwiftbarPlugins({ patterns }) {
  const pats = (patterns ?? []).filter(Boolean);
  const args = pats.length ? pats.map((p) => `"${p}"`).join(' ') : '"hstack.*.sh"';
  const s =
    `DIR="$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null)"; ` +
    `if [[ -z "$DIR" ]]; then DIR="$HOME/Library/Application Support/SwiftBar/Plugins"; fi; ` +
    `if [[ -d "$DIR" ]]; then rm -f "$DIR"/${args} 2>/dev/null || true; echo "$DIR"; else echo ""; fi`;
  const res = spawnSync('bash', ['-lc', s], { encoding: 'utf-8' });
  if (res.status !== 0) {
    return null;
  }
  const out = String(res.stdout ?? '').trim();
  return out || null;
}

async function main() {
  const rawArgv = process.argv.slice(2);
  const argv = rawArgv[0] === 'menubar' ? rawArgv.slice(1) : rawArgv;
  const helpSepIdx = argv.indexOf('--');
  const helpScopeArgv = helpSepIdx === -1 ? argv : argv.slice(0, helpSepIdx);
  const { flags } = parseArgs(helpScopeArgv);
  const json = wantsJson(helpScopeArgv, { flags });

  const cmd = helpScopeArgv.find((a) => a && a !== '--' && !a.startsWith('-')) || 'help';
  const wantsHelpFlag = wantsHelp(helpScopeArgv, { flags });
  const usageByCmd = new Map([
    ['install', 'hstack menubar install [--json]'],
    ['uninstall', 'hstack menubar uninstall [--json]'],
    ['open', 'hstack menubar open [--json]'],
    ['mode', 'hstack menubar mode <selfhost|dev> [--json]'],
    ['status', 'hstack menubar status [--json]'],
  ]);

  if (wantsHelpFlag && cmd !== 'help') {
    const usage = usageByCmd.get(cmd);
    if (usage) {
      printResult({
        json,
        data: { ok: true, cmd, usage },
        text: [`[menubar ${cmd}] usage:`, `  ${usage}`, '', 'see also:', '  hstack menubar --help'].join('\n'),
      });
      return;
    }
  }

  if (wantsHelpFlag || cmd === 'help') {
    printResult({
      json,
      data: { commands: ['install', 'uninstall', 'open', 'mode', 'status'] },
      text: [
        banner('menubar', { subtitle: 'SwiftBar menu bar plugin (macOS).' }),
        '',
        sectionTitle('usage:'),
        `  ${cyan('hstack menubar')} install [--json]`,
        `  ${cyan('hstack menubar')} uninstall [--json]`,
        `  ${cyan('hstack menubar')} open [--json]`,
        `  ${cyan('hstack menubar')} mode <selfhost|dev> [--json]`,
        `  ${cyan('hstack menubar')} status [--json]`,
        '',
        sectionTitle('notes:'),
        `- ${dim('Installs the SwiftBar plugin into the active SwiftBar plugin folder')}`,
        `- ${dim('Keeps plugin source under <homeDir>/extras/swiftbar for stability')}`,
        `- ${dim('Sandbox mode: install/uninstall are disabled by default (set HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL=1 to override)')}`,
      ].join('\n'),
    });
    return;
  }

  const cliRootDir = getRootDir(import.meta.url);

  if (cmd === 'menubar:open' || cmd === 'open') {
    if (json) {
      printResult({ json, data: { ok: true } });
      return;
    }
    openSwiftbarPluginsDir();
    return;
  }

  if (cmd === 'menubar:uninstall' || cmd === 'uninstall') {
    if (isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
      printResult({ json, data: { ok: true, skipped: 'sandbox' }, text: '[menubar] uninstall skipped (sandbox mode)' });
      return;
    }
    const patterns = isSandboxed()
      ? [`${sandboxPluginBasename()}.*.sh`]
      : ['hstack.*.sh'];
    const dir = removeSwiftbarPlugins({ patterns });
    printResult({ json, data: { ok: true, pluginsDir: dir }, text: dir ? `[menubar] removed plugins from ${dir}` : '[menubar] no plugins dir found' });
    return;
  }

  if (cmd === 'status') {
    const mode = (process.env.HAPPIER_STACK_MENUBAR_MODE ?? 'dev').trim() || 'dev';
    const swift = await detectSwiftbarPluginInstalled();
    printResult({
      json,
      data: { ok: true, mode, pluginsDir: swift.pluginsDir, installed: swift.installed },
      text: [
        sectionTitle('Menubar'),
        `- ${kv('mode:', cyan(mode))}`,
        `- ${kv('swiftbar plugin:', swift.installed ? green('installed') : dim('not installed'))}`,
        swift.pluginsDir ? `- ${kv('plugins dir:', swift.pluginsDir)}` : null,
      ].filter(Boolean).join('\n'),
    });
    return;
  }

  if (cmd === 'mode') {
    const positionals = argv.filter((a) => !a.startsWith('--'));
    const raw = positionals[1] ?? '';
    const mode = normalizeProfile(raw);
    if (!mode) {
      throw new Error('[menubar] usage: hstack menubar mode <selfhost|dev> [--json]');
    }
    await ensureEnvLocalUpdated({
      rootDir: cliRootDir,
      updates: [
        { key: 'HAPPIER_STACK_MENUBAR_MODE', value: mode },
      ],
    });
    printResult({ json, data: { ok: true, mode }, text: `[menubar] mode set: ${mode}` });
    return;
  }

  if (cmd === 'menubar:install' || cmd === 'install') {
    if (isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
      throw new Error(
        '[menubar] install is disabled in sandbox mode.\n' +
          'Reason: SwiftBar plugin installation writes to a global user folder.\n' +
          'If you really want this, set: HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL=1'
      );
    }
    const { destDir } = await ensureSwiftbarAssets({ cliRootDir });
    const installer = join(destDir, 'install.sh');
    const env = {
      ...process.env,
      HAPPIER_STACK_HOME_DIR: getHappyStacksHomeDir(),
      ...(isSandboxed()
        ? {
            HAPPIER_STACK_SWIFTBAR_PLUGIN_BASENAME: sandboxPluginBasename(),
            HAPPIER_STACK_SWIFTBAR_PLUGIN_WRAPPER: '1',
          }
        : {}),
    };
    const res = spawnSync('bash', [installer, '--force'], { stdio: 'inherit', env });
    if (res.status !== 0) {
      process.exit(res.status ?? 1);
    }
    printResult({ json, data: { ok: true }, text: '[menubar] installed' });
    return;
  }

  throw new Error(`[menubar] unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error('[menubar] failed:', err);
  process.exit(1);
});
