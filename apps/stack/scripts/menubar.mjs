import './utils/env/env.mjs';
import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getHappyStacksHomeDir, getRootDir, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { ensureEnvLocalUpdated } from './utils/env/env_local.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './utils/env/sandbox.mjs';
import { normalizeProfile } from './utils/cli/normalize.mjs';
import { banner, kv, sectionTitle } from './utils/ui/layout.mjs';
import { cyan, dim, green } from './utils/ui/ansi.mjs';
import { detectSwiftbarPluginInstalled, removeSwiftbarPlugins } from './utils/menubar/swiftbar.mjs';
import { normalizeStackNameOrNull, sanitizeStackName } from './utils/stack/names.mjs';

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

function stackPluginBasename(stackName) {
  const normalized = sanitizeStackName(stackName, { fallback: 'stack', maxLen: 64 });
  const hash = createHash('sha256').update(String(stackName ?? '')).digest('hex').slice(0, 6);
  const short = normalized.length > 32 ? normalized.slice(0, 32) : normalized;
  return sanitizeStackName(`hstack-${short}-${hash}`, { fallback: 'hstack', maxLen: 64 });
}

async function main() {
  const rawArgv = process.argv.slice(2);
  const argv = rawArgv[0] === 'menubar' ? rawArgv.slice(1) : rawArgv;
  const helpSepIdx = argv.indexOf('--');
  const helpScopeArgv = helpSepIdx === -1 ? argv : argv.slice(0, helpSepIdx);
  const { flags } = parseArgs(helpScopeArgv);
  const { kv: kvFlags } = parseArgs(helpScopeArgv);
  const json = wantsJson(helpScopeArgv, { flags });
  const dryRun = flags.has('--dry-run') || helpScopeArgv.includes('--dry-run');

  const cmd = helpScopeArgv.find((a) => a && a !== '--' && !a.startsWith('-')) || 'help';
  const wantsHelpFlag = wantsHelp(helpScopeArgv, { flags });
  const usageByCmd = new Map([
    ['install', 'hstack menubar install [--stack=<name>] [--mode=selfhost|dev] [--json]'],
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
        `  ${cyan('hstack menubar')} install [--stack=<name>] [--mode=selfhost|dev] [--json]`,
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
      : ['hstack.*.sh', 'hstack-*.sh'];
    const res = await removeSwiftbarPlugins({ patterns });
    const dir = res.pluginsDir;
    printResult({
      json,
      data: { ok: res.ok, pluginsDir: dir, removed: res.removed },
      text: dir
        ? (res.ok ? `[menubar] removed plugins from ${dir}` : `[menubar] failed to remove plugins from ${dir}`)
        : '[menubar] no plugins dir found',
    });
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

    const explicitStackRaw = String(kvFlags.get('--stack') ?? '').trim();
    const explicitStack = explicitStackRaw ? normalizeStackNameOrNull(explicitStackRaw) : null;
    if (explicitStackRaw && !explicitStack) {
      throw new Error('[menubar] invalid --stack name (expected letters, numbers, and dashes)');
    }
    const explicitModeRaw = String(kvFlags.get('--mode') ?? '').trim();
    const explicitMode = explicitModeRaw ? normalizeProfile(explicitModeRaw) : null;
    if (explicitModeRaw && !explicitMode) {
      throw new Error('[menubar] invalid --mode (expected selfhost or dev)');
    }
    const effectiveMode = explicitMode || String(process.env.HAPPIER_STACK_MENUBAR_MODE ?? 'dev').trim() || 'dev';
    const stackName = explicitStack || String((process.env.HAPPIER_STACK_STACK ?? '').trim() || 'main');
    const normalizedStack = sanitizeStackName(stackName, { fallback: 'main', maxLen: 64 });
    const stackScoped = normalizedStack !== 'main';

    const interval = String(process.env.HAPPIER_STACK_SWIFTBAR_INTERVAL ?? '').trim() || '5m';
    const defaultBasename = isSandboxed()
      ? sandboxPluginBasename()
      : (stackScoped ? stackPluginBasename(normalizedStack) : 'hstack');
    const pluginBasename = String(process.env.HAPPIER_STACK_SWIFTBAR_PLUGIN_BASENAME ?? '').trim() || defaultBasename;
    const pluginFile = `${pluginBasename}.${interval}.sh`;

    const defaultEnvFile = (process.env.HAPPIER_STACK_ENV_FILE ?? '').toString().trim();
    const resolvedEnvFile = explicitStack
      ? resolveStackEnvPath(normalizedStack, process.env).envPath
      : (defaultEnvFile || resolveStackEnvPath(normalizedStack, process.env).envPath);

    const env = {
      ...process.env,
      HAPPIER_STACK_HOME_DIR: getHappyStacksHomeDir(),
      HAPPIER_STACK_MENUBAR_MODE: effectiveMode,
      ...(pluginBasename ? { HAPPIER_STACK_SWIFTBAR_PLUGIN_BASENAME: pluginBasename } : {}),
      ...((isSandboxed() || stackScoped)
        ? {
            HAPPIER_STACK_SWIFTBAR_PLUGIN_WRAPPER: '1',
            ...(stackScoped
              ? {
                  HAPPIER_STACK_SWIFTBAR_PRIMARY_STACK: normalizedStack,
                  HAPPIER_STACK_SWIFTBAR_PRIMARY_ENV_FILE: resolvedEnvFile,
                }
              : {}),
          }
        : {}),
    };

    if (dryRun) {
      const data = {
        ok: true,
        stack: {
          name: normalizedStack,
          scoped: stackScoped,
          envFile: resolvedEnvFile || null,
        },
        mode: effectiveMode,
        swiftbar: {
          pluginBasename,
          pluginInterval: interval,
          pluginFile,
          wrapper: Boolean(isSandboxed() || stackScoped),
        },
        installer: {
          cmd: 'bash',
          args: [installer, '--force'],
        },
      };
      printResult({
        json,
        data,
        text: [
          sectionTitle('Menubar install (dry-run)'),
          `- ${kv('stack:', cyan(normalizedStack))}`,
          `- ${kv('plugin:', cyan(pluginFile))}`,
          `- ${kv('wrapper:', cyan(String(data.swiftbar.wrapper)))}`,
          `- ${kv('env file:', resolvedEnvFile ? cyan(resolvedEnvFile) : dim('(none)'))}`,
        ].join('\n'),
      });
      return;
    }

    if (explicitMode) {
      await ensureEnvLocalUpdated({
        rootDir: cliRootDir,
        updates: [{ key: 'HAPPIER_STACK_MENUBAR_MODE', value: explicitMode }],
      });
    }

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
