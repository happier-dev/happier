import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPlaywrightSpawnOptions,
  parseHeartbeatArgs,
  runHeartbeatWrappedCommand,
  resolveSignalExitCode,
} from './runPlaywrightWithHeartbeat.shared.mjs';

import { exitWithCommandResult, runCommand } from '../../../apps/stack/scripts/utils/proc/proc.mjs';
import { resolvePnpmCommandInvocation } from '../../../scripts/workspaces/execPnpmCommand.mjs';
import { resolvePlaywrightWrapperTimeoutFallbackMs } from './playwrightWrapperTimeout.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '../../..');

const { config, passThrough } = parseHeartbeatArgs(process.argv);
if (!config) {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/run-playwright-with-heartbeat.mjs --config <playwright.config.mjs> [extra args]');
  process.exit(2);
}

if (process.platform === 'linux' && !process.env.CI && !process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT) {
  const cwd = process.cwd();
  const relativeCwd = relative(repoRoot, cwd);
  const relativeConfig = relative(repoRoot, resolve(cwd, config));
  const script = relative(cwd, fileURLToPath(import.meta.url));
  const launcher = resolve(repoRoot, 'apps/stack/bin/hstack-exec');
  const options = { cwd, stdio: 'inherit', ownedProcessGroup: true };
  const args = [script, ...process.argv.slice(2)];
  // Current-stack, packed-artifact and interactive runs need the host that
  // holds their inputs. A placed command already has a selected host.
  const hostOptions = /^(HAPPIER_E2E_|HAPPY_E2E_|HAPPIER_QA_STACK|HAPPIER_PACKED_|HAPPIER_PLAYWRIGHT_|PLAYWRIGHT_|PWDEBUG$|HAPPIER_PLUGIN_PLATFORM_CANDIDATE_MANIFEST$|HAPPIER_CI_DIAGNOSTIC_PATH$|DATABASE_URL$)/u;
  const local = process.env.HAPPIER_DEV_TARGET_EXECUTION === '1' || process.env.HAPPIER_HSTACK_EXECUTION === '1'
    || relativeCwd === '..' || relativeCwd.startsWith('../')
    || relativeConfig === '..' || relativeConfig.startsWith('../') || isAbsolute(config)
    || Object.keys(process.env).some(name => hostOptions.test(name) && process.env[name])
    || passThrough.some(arg => isAbsolute(arg) || /^(--headed|--debug|--ui|--last-failed|--output=\/)/u.test(arg));
  if (local) {
    exitWithCommandResult(await runCommand(launcher, [
      '--heavyweight-admission', '--class=validation', '--', process.execPath, ...args,
    ], options));
  } else {
    // Only launcher discovery and local transport settings enter AUTO.
    const launcherEnv = Object.fromEntries([
      'HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TERM', 'SSH_AUTH_SOCK',
      'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'XDG_STATE_HOME',
      'HAPPIER_EXEC_CONFIG_PATH', 'HAPPIER_STACK_HOME_DIR', 'HAPPIER_STACK_STORAGE_DIR',
    ].filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
    exitWithCommandResult(await runCommand(launcher, ['--', 'node', ...args], { ...options, env: launcherEnv }));
  }
} else {
  const childArgs = ['exec', 'playwright', 'test', '-c', config, ...passThrough];
  const invocation = resolvePnpmCommandInvocation(childArgs, { npmExecPath: '' });

  await runHeartbeatWrappedCommand({
    toolName: 'playwright',
    config,
    diagnosticPath: process.env.HAPPIER_CI_DIAGNOSTIC_PATH
      || resolve(repoRoot, '.project/logs/e2e/playwright-heartbeat-diagnostic.ndjson'),
    command: invocation.command,
    args: invocation.args,
    spawnOptions: {
      ...createPlaywrightSpawnOptions(process.env),
      ...(invocation.windowsVerbatimArguments
        ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
        : {}),
    },
    defaultTimeoutMs: resolvePlaywrightWrapperTimeoutFallbackMs(process.env),
    resolveExitCode(result) {
      return typeof result.code === 'number' ? result.code : resolveSignalExitCode(result.signal);
    },
  });
}
