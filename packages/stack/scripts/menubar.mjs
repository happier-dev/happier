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
  const sandboxDir = (process.env.HAPPY_STACKS_SANDBOX_DIR ?? '').trim();
  if (!sandboxDir) return '';
  const hash = createHash('sha256').update(sandboxDir).digest('hex').slice(0, 10);
  return `happy-stacks.sandbox-${hash}`;
}

function removeSwiftbarPlugins({ patterns }) {
  const pats = (patterns ?? []).filter(Boolean);
  const args = pats.length ? pats.map((p) => `"${p}"`).join(' ') : '"happy-stacks.*.sh" "happy-local.*.sh"';
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
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const cmd = argv.find((a) => !a.startsWith('--')) || 'help';
  if (wantsHelp(argv, { flags }) || cmd === 'help') {
    printResult({
      json,
      data: { commands: ['install', 'uninstall', 'open', 'mode', 'status'] },
      text: [
        banner('menubar', { subtitle: 'SwiftBar menu bar plugin (macOS).' }),
        '',
        sectionTitle('usage:'),
        `  ${cyan('happys menubar')} install [--json]`,
        `  ${cyan('happys menubar')} uninstall [--json]`,
        `  ${cyan('happys menubar')} open [--json]`,
        `  ${cyan('happys menubar')} mode <selfhost|dev> [--json]`,
        `  ${cyan('happys menubar')} status [--json]`,
        '',
        sectionTitle('notes:'),
        `- ${dim('Installs the SwiftBar plugin into the active SwiftBar plugin folder')}`,
        `- ${dim('Keeps plugin source under <homeDir>/extras/swiftbar for stability')}`,
        `- ${dim('Sandbox mode: install/uninstall are disabled by default (set HAPPY_STACKS_SANDBOX_ALLOW_GLOBAL=1 to override)')}`,
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
      : ['happy-stacks.*.sh', 'happy-local.*.sh'];
    const dir = removeSwiftbarPlugins({ patterns });
    printResult({ json, data: { ok: true, pluginsDir: dir }, text: dir ? `[menubar] removed plugins from ${dir}` : '[menubar] no plugins dir found' });
    return;
  }

  if (cmd === 'status') {
    const mode = (process.env.HAPPY_STACKS_MENUBAR_MODE ?? process.env.HAPPY_LOCAL_MENUBAR_MODE ?? 'dev').trim() || 'dev';
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
      throw new Error('[menubar] usage: happys menubar mode <selfhost|dev> [--json]');
    }
    await ensureEnvLocalUpdated({
      rootDir: cliRootDir,
      updates: [
        { key: 'HAPPY_STACKS_MENUBAR_MODE', value: mode },
        { key: 'HAPPY_LOCAL_MENUBAR_MODE', value: mode },
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
          'If you really want this, set: HAPPY_STACKS_SANDBOX_ALLOW_GLOBAL=1'
      );
    }
    const { destDir } = await ensureSwiftbarAssets({ cliRootDir });
    const installer = join(destDir, 'install.sh');
    const env = {
      ...process.env,
      HAPPY_STACKS_HOME_DIR: getHappyStacksHomeDir(),
      ...(isSandboxed()
        ? {
            HAPPY_STACKS_SWIFTBAR_PLUGIN_BASENAME: sandboxPluginBasename(),
            HAPPY_STACKS_SWIFTBAR_PLUGIN_WRAPPER: '1',
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
