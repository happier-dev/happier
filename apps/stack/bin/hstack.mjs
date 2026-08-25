#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandHelpArgs, renderhstackRootHelp, resolvehstackCommand } from '../scripts/utils/cli/cli_registry.mjs';
import { expandHome, getCanonicalHomeEnvPathFromEnv } from '../scripts/utils/paths/canonical_home.mjs';
import { resolveExplicitStackEnvFilePath, resolveStackEnvPath } from '../scripts/utils/paths/paths.mjs';
import { SANDBOX_PRESERVE_KEYS, scrubHappierStackEnv } from '../scripts/utils/env/scrub_env.mjs';
import { resolveStackHappierPassthroughEntrypoint } from '../scripts/stack/stack_happier_passthrough_entrypoint.mjs';
import { readExecutionHostProfile } from '../scripts/utils/execution_host/config.mjs';
import { shouldDelegateToActiveExecutionHost } from '../scripts/utils/execution_host/controller.mjs';
import { runDelegatedHstackCommand } from '../scripts/utils/execution_host/delegation.mjs';
import {
  isBundledWorkspaceMetadataInvocation,
  refreshLocalBundledWorkspacePackages,
} from './localBundledWorkspacePreflight.mjs';

function getCliRootDir() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

// expandHome is imported from scripts/utils/paths/canonical_home.mjs

function dotenvGetQuick(envPath, key) {
  try {
    if (!envPath || !existsSync(envPath)) return '';
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (!trimmed.startsWith(`${key}=`)) continue;
      let v = trimmed.slice(`${key}=`.length).trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
      return v;
    }
  } catch {
    // ignore
  }
  return '';
}

function resolveCliRootDir() {
  const fromEnv = (
    process.env.HAPPIER_STACK_CLI_ROOT_DIR ??
    process.env.HAPPIER_STACK_DEV_CLI_ROOT_DIR ??
    ''
  ).trim();
  if (fromEnv) return expandHome(fromEnv);

  // Stable pointer file: even if the real home dir is elsewhere, `hstack init` writes the pointer here.
  const canonicalEnv = getCanonicalHomeEnvPathFromEnv(process.env);
  const v =
    dotenvGetQuick(canonicalEnv, 'HAPPIER_STACK_CLI_ROOT_DIR') ||
    dotenvGetQuick(canonicalEnv, 'HAPPIER_STACK_DEV_CLI_ROOT_DIR') ||
    '';
  return v ? expandHome(v) : '';
}

function shouldKeepCurrentCliRootForInvocation(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const cmd = args.find((a) => !String(a).startsWith('--')) ?? '';
  if (cmd !== 'init') return false;
  return args.some((a) => a === '--cli-root-dir' || String(a).startsWith('--cli-root-dir='));
}

function maybeReexecToCliRoot(cliRootDir, argv = []) {
  if ((process.env.HAPPIER_STACK_CLI_REEXEC ?? process.env.HAPPIER_STACK_DEV_REEXEC ?? '') === '1') return;
  if ((process.env.HAPPIER_STACK_CLI_ROOT_DISABLE ?? process.env.HAPPIER_STACK_DEV_CLI_DISABLE ?? '') === '1') return;
  if (shouldKeepCurrentCliRootForInvocation(argv)) return;

  const cliRoot = resolveCliRootDir();
  if (!cliRoot) return;
  if (cliRoot === cliRootDir) return;

  const cliBin = join(cliRoot, 'bin', 'hstack.mjs');
  if (!existsSync(cliBin)) return;

  const passthroughArgv = process.argv.slice(2);
  const res = spawnSync(process.execPath, [cliBin, ...passthroughArgv], {
    stdio: 'inherit',
    cwd: cliRoot,
    env: {
      ...process.env,
      HAPPIER_STACK_CLI_REEXEC: '1',
      HAPPIER_STACK_CLI_ROOT_DIR: cliRoot,
    },
  });
  process.exit(res.status ?? 1);
}

function resolveHomeDir() {
  const fromEnv = (process.env.HAPPIER_STACK_HOME_DIR ?? '').trim();
  if (fromEnv) return expandHome(fromEnv);

  // Stable pointer file: even if the real home dir is elsewhere, `hstack init` writes the pointer here.
  const canonicalEnv = getCanonicalHomeEnvPathFromEnv(process.env);
  const v = dotenvGetQuick(canonicalEnv, 'HAPPIER_STACK_HOME_DIR') || '';
  return v ? expandHome(v) : join(homedir(), '.happier-stack');
}

function stripGlobalOpt(argv, { name, aliases = [] }) {
  const names = [name, ...aliases];
  for (const n of names) {
    const eq = `${n}=`;
    const iEq = argv.findIndex((a) => a.startsWith(eq));
    if (iEq >= 0) {
      const value = argv[iEq].slice(eq.length);
      const next = [...argv.slice(0, iEq), ...argv.slice(iEq + 1)];
      return { value, argv: next };
    }
    const i = argv.indexOf(n);
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-')) {
      const value = argv[i + 1];
      const next = [...argv.slice(0, i), ...argv.slice(i + 2)];
      return { value, argv: next };
    }
  }
  return { value: '', argv };
}

function applyVerbosityIfRequested(argv) {
  // Global verbosity:
  // - supports -v/-vv/-vvv anywhere before/after the command
  // - supports --verbose and --verbose=N
  //
  // We set HAPPIER_STACK_VERBOSE (0-3) and strip these args so downstream scripts don't need to support them.
  let level = Number.isFinite(Number(process.env.HAPPIER_STACK_VERBOSE)) ? Number(process.env.HAPPIER_STACK_VERBOSE) : null;
  let next = [];
  for (const a of argv) {
    if (a === '-v' || a === '-vv' || a === '-vvv') {
      const n = a.length - 1;
      level = Math.max(level ?? 0, n);
      continue;
    }
    if (a === '--verbose') {
      level = Math.max(level ?? 0, 1);
      continue;
    }
    if (a.startsWith('--verbose=')) {
      const raw = a.slice('--verbose='.length).trim();
      const n = Number(raw);
      if (Number.isFinite(n)) {
        level = Math.max(level ?? 0, Math.max(0, Math.min(3, Math.floor(n))));
      } else {
        level = Math.max(level ?? 0, 1);
      }
      continue;
    }
    next.push(a);
  }
  if (level != null) {
    process.env.HAPPIER_STACK_VERBOSE = String(Math.max(0, Math.min(3, Math.floor(level))));
  }
  return next;
}

function applySandboxDirIfRequested(argv) {
  const explicit = (process.env.HAPPIER_STACK_SANDBOX_DIR ?? '').trim();
  const { value, argv: nextArgv } = stripGlobalOpt(argv, { name: '--sandbox-dir', aliases: ['--sandbox'] });
  const raw = value || explicit;
  if (!raw) return { argv: nextArgv, enabled: false };

  const sandboxDir = expandHome(raw);
  const allowGlobalRaw = (process.env.HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL ?? '').trim().toLowerCase();
  const allowGlobal = allowGlobalRaw === '1' || allowGlobalRaw === 'true' || allowGlobalRaw === 'yes' || allowGlobalRaw === 'y';
  // Keep all state under one folder that can be deleted to reset completely.
  const canonicalHomeDir = join(sandboxDir, 'canonical');
  const homeDir = join(sandboxDir, 'home');
  const workspaceOverrideRaw = (process.env.HAPPIER_STACK_SANDBOX_WORKSPACE_DIR ?? '').trim();
  const workspaceOverrideExpanded = workspaceOverrideRaw ? expandHome(workspaceOverrideRaw) : '';
  const workspaceOverride = workspaceOverrideExpanded
    ? isAbsolute(workspaceOverrideExpanded)
      ? workspaceOverrideExpanded
      : resolve(sandboxDir, workspaceOverrideExpanded)
    : '';
  const workspaceDir = workspaceOverride || join(sandboxDir, 'workspace');
  const runtimeDir = join(sandboxDir, 'runtime');
  const storageDir = join(sandboxDir, 'storage');

  // Sandbox isolation MUST win over any pre-exported hstack env vars.
  // Otherwise sandbox runs can accidentally read/write "real" machine state.
  //
  // Keep only a tiny set of sandbox-safe globals; everything else should be driven by flags
  // and stack env files inside the sandbox.
  const preserved = new Map();
  for (const k of SANDBOX_PRESERVE_KEYS) {
    if (process.env[k] != null && String(process.env[k]).trim() !== '') {
      preserved.set(k, process.env[k]);
    }
  }
  const scrubbed = scrubHappierStackEnv(process.env, {
    keepHappierStackKeys: Array.from(preserved.keys()),
    clearUnprefixedKeys: ['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL'],
  });
  for (const k of Object.keys(process.env)) {
    if (!(k in scrubbed)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(scrubbed)) {
    process.env[k] = v;
  }

  process.env.HAPPIER_STACK_SANDBOX_DIR = sandboxDir;
  process.env.HAPPIER_STACK_CLI_ROOT_DISABLE = '1'; // never re-exec into a user's "real" install when sandboxing

  // In sandbox mode, we MUST force all state directories into the sandbox, even if the user
  // exported HAPPIER_STACK_* in their shell. Otherwise sandbox runs can accidentally read/write
  // "real" machine state (breaking isolation).
  process.env.HAPPIER_STACK_CANONICAL_HOME_DIR = canonicalHomeDir;

  process.env.HAPPIER_STACK_HOME_DIR = homeDir;

    process.env.HAPPIER_STACK_WORKSPACE_DIR = workspaceDir;

    process.env.HAPPIER_STACK_RUNTIME_DIR = runtimeDir;

    process.env.HAPPIER_STACK_STORAGE_DIR = storageDir;

    // When sandboxing with a shared (non-temporary) workspace, keep package-manager caches stable
    // across runs. This makes `yarn install` much faster and avoids re-downloading toolchains.
    const pmCacheBaseRaw = (process.env.HAPPIER_STACK_PM_CACHE_BASE_DIR ?? '').trim();
    const sandboxAbs = resolve(sandboxDir);
    const wsAbs = resolve(workspaceDir);
    const isSharedWorkspace = wsAbs !== sandboxAbs && !wsAbs.startsWith(sandboxAbs + '/');
    if (!pmCacheBaseRaw && isSharedWorkspace) {
      const base = basename(wsAbs) === 'workspace'
        ? join(dirname(wsAbs), 'pm')
        : join(wsAbs, '.hstack-cache', 'pm');
      process.env.HAPPIER_STACK_PM_CACHE_BASE_DIR = base;
    }

    // When sandboxing with a shared workspace, keep Expo/Metro transform caches stable across runs.
    // This dramatically speeds up repeated `expo start` for review-pr flows.
    const expoTmpBaseRaw = (process.env.HAPPIER_STACK_EXPO_SHARED_TMPDIR_BASE_DIR ?? '').trim();
    if (!expoTmpBaseRaw && isSharedWorkspace) {
      const base = basename(wsAbs) === 'workspace'
        ? join(dirname(wsAbs), 'expo')
        : join(wsAbs, '.hstack-cache', 'expo');
      process.env.HAPPIER_STACK_EXPO_SHARED_TMPDIR_BASE_DIR = base;
    }
    const expoTmpKeyRaw = (process.env.HAPPIER_STACK_EXPO_SHARED_TMPDIR_KEY ?? '').trim();
    if (!expoTmpKeyRaw && isSharedWorkspace) {
      process.env.HAPPIER_STACK_EXPO_SHARED_TMPDIR_KEY = wsAbs;
    }

    // Sandbox default: disallow global side effects unless explicitly opted in.
    // This keeps sandbox runs fast, deterministic, and isolated.
    if (!allowGlobal) {
      // Network-y UX (background update checks) are not useful in a temporary sandbox.
      process.env.HAPPIER_STACK_UPDATE_CHECK = '0';
    process.env.HAPPIER_STACK_UPDATE_CHECK_INTERVAL_MS = '0';
    process.env.HAPPIER_STACK_UPDATE_NOTIFY_INTERVAL_MS = '0';

    // Never auto-enable or reset Tailscale Serve in sandbox.
    // (Tailscale is global machine state; sandbox runs must not touch it.)
    process.env.HAPPIER_STACK_TAILSCALE_SERVE = '0';
    process.env.HAPPIER_STACK_TAILSCALE_RESET_ON_EXIT = '0';
  }

  return { argv: nextArgv, enabled: true };
}

async function maybeAutoUpdateNotice(cliRootDir, cmd) {
  const { maybeAutoUpdateNotice: maybeAutoUpdateNoticeShared } = await import('../scripts/utils/update/auto_update_notice.mjs');
  maybeAutoUpdateNoticeShared({
    cliRootDir,
    cmd,
    homeDir: resolveHomeDir(),
    isTTY: Boolean(process.stdout.isTTY),
    env: process.env,
  });
}

function usage() {
  return renderhstackRootHelp();
}

function runNodeScript(cliRootDir, scriptRelPath, args) {
  const scriptPath = join(cliRootDir, scriptRelPath);
  if (!existsSync(scriptPath)) {
    console.error(`[hstack] missing script: ${scriptPath}`);
    process.exit(1);
  }
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: 'inherit',
    env: process.env,
    cwd: cliRootDir,
  });
  process.exit(res.status ?? 1);
}

function hasJsonFlag(args) {
  const argv = Array.isArray(args) ? args : [];
  return argv.some((a) => a === '--json' || String(a).startsWith('--json='));
}

function isHelpInvocation(args) {
  const argv = Array.isArray(args) ? args : [];
  const sepIndex = argv.indexOf('--');
  const helpScopeArgv = sepIndex === -1 ? argv : argv.slice(0, sepIndex);
  if (helpScopeArgv.length === 0) return true;
  if (helpScopeArgv.includes('--help') || helpScopeArgv.includes('-h')) return true;
  const command = helpScopeArgv.find((arg) => !String(arg).startsWith('-')) ?? '';
  return command === 'help';
}

function normalizeStackShorthandForPreflight(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const command = args.find((arg) => !String(arg).startsWith('--')) ?? '';
  if (!command || resolvehstackCommand(command)) return args;

  const { envPath } = resolveStackEnvPath(command, process.env);
  if (!existsSync(envPath)) return args;

  const commandIndex = args.indexOf(command);
  const rest = args.slice(commandIndex + 1);
  const stackCommandIndex = rest.findIndex((arg) => !String(arg).startsWith('-'));
  if (stackCommandIndex < 0) return args;

  const stackCommand = rest[stackCommandIndex];
  const preFlags = rest.slice(0, stackCommandIndex);
  const post = rest.slice(stackCommandIndex + 1);
  return [
    ...args.slice(0, commandIndex),
    'stack',
    stackCommand,
    command,
    ...preFlags,
    ...post,
  ];
}

const STACK_LOCAL_ENV_SUBCOMMANDS = new Set(['set', 'unset', 'remove', 'rm', 'get', 'list', 'path']);

function shouldSkipBundledWorkspacePreflight(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const sepIndex = args.indexOf('--');
  const preSeparatorArgs = sepIndex === -1 ? args : args.slice(0, sepIndex);
  const command = preSeparatorArgs.find((arg) => !String(arg).startsWith('-')) ?? '';

  // CLI metadata reads the already-admitted dependency tree. It must not turn a
  // help/version query into a workspace publication or wait behind one.
  if (command === 'happier') {
    const commandIndex = preSeparatorArgs.indexOf(command);
    return isBundledWorkspaceMetadataInvocation(preSeparatorArgs.slice(commandIndex + 1));
  }

  // Help renders the already-installed Stack control plane. It must never turn
  // an informational query into a workspace publisher or wait behind one.
  if (isHelpInvocation(args)) return true;

  const resolvedCommand = command ? resolvehstackCommand(command) : null;
  if (resolvedCommand?.scriptRelPath === 'scripts/setup.mjs' && hasJsonFlag(args)) {
    return true;
  }

  // Dev-target configuration and SSH diagnostics use only Stack-local modules.
  // Keep them available while an unrelated CLI/workspace publication owns the
  // shared build lock (notably for inspecting or repairing a running target).
  if (command === 'dev-targets' || command === 'host') return true;

  // The TUI must render before repository publication can block. Its long-lived
  // child delegates dependency admission to the server, daemon, and Expo owners,
  // which can reuse their last admitted outputs and publish successors in place.
  if (command === 'tui') return true;

  const isTuiManaged = String(process.env.HAPPIER_STACK_TUI ?? '').trim() === '1';
  if (isTuiManaged && (command === 'dev' || command === 'start')) return true;

  if (command !== 'stack') return false;

  const commandIndex = args.indexOf(command);
  const rest = commandIndex >= 0 ? args.slice(commandIndex + 1) : [];
  const positionals = rest.filter((arg) => arg !== '--' && !String(arg).startsWith('-'));
  const subcommand = positionals[0] ?? '';

  // Selection only consumes a producer snapshot and the named consumer's stack
  // metadata. Its owner also owns `select --help`, so neither path needs a
  // bundled-workspace repair/publication before dispatch.
  if (subcommand === 'runtime' && positionals.length === 3 && positionals[2] === 'select') {
    return true;
  }

  // A fresh no-auth stack only creates its own Stack-owned environment. It neither
  // starts a component nor reads an auth source, so controlled consumers must be
  // able to provision while an unrelated workspace publisher owns this global lock.
  // The Stack control-plane imports still fail loudly after dispatch if unavailable.
  if (subcommand === 'new' && (rest.includes('--no-copy-auth') || rest.includes('--fresh-auth'))) {
    return true;
  }

  // An explicit runtime start launches already-admitted immutable artifacts. Keep
  // restart availability independent of unrelated source workspace publication;
  // the existing bundled Stack control plane still fails loudly if it is unusable.
  if (subcommand === 'start' && preSeparatorArgs.includes('--runtime')) return true;

  // These management paths only inspect or edit Stack-owned metadata. Keep the
  // positive list narrow so dependency-consuming commands still repair bundled
  // workspace packages before they load.
  if (subcommand === 'list') return true;
  if (subcommand === 'info') return Boolean(positionals[1]);
  if (subcommand === 'status') return Boolean(positionals[1]);
  if (subcommand === 'auth') {
    return Boolean(positionals[1]) && positionals[2] === 'status';
  }
  // Stop owns only stack-recorded lifecycle cleanup. It must remain able to
  // reclaim that stack while an unrelated workspace publication holds the
  // shared build lock; it still fails loudly if the Stack control plane cannot
  // load after dispatch.
  if (subcommand === 'stop') return Boolean(positionals[1]);
  if (subcommand === 'env') {
    const envSubcommand = positionals[2] ?? 'list';
    return Boolean(positionals[1]) && STACK_LOCAL_ENV_SUBCOMMANDS.has(envSubcommand);
  }
  // Read-only doctor only inspects the stack and daemon state. Keep --fix behind
  // the preflight because it can mutate the local environment.
  if (subcommand === 'doctor') return !rest.includes('--fix');
  if (subcommand === 'runtime') {
    const runtimeSubcommand = positionals[2] ?? '';
    if (runtimeSubcommand !== 'activate') return true;
  }

  // The explicit runtime CLI consumes the selected immutable snapshot just as
  // `stack start --runtime` does. Publishing source workspace packages before
  // dispatch defeats that contract and can block read-only snapshot commands
  // behind an unrelated source build.
  if (subcommand === 'happier') {
    if (preSeparatorArgs.includes('--runtime')) return true;
    if (!preSeparatorArgs.includes('--source')) {
      const stackName = positionals[1] ?? '';
      const { envPath } = resolveStackEnvPath(stackName, process.env);
      if (dotenvGetQuick(envPath, 'HAPPIER_STACK_RUNTIME_MODE').trim().toLowerCase() === 'require') {
        return true;
      }
      const selectedRepoDir = dotenvGetQuick(envPath, 'HAPPIER_STACK_REPO_DIR');
      const selectedEntrypoint = resolveStackHappierPassthroughEntrypoint({
        rootDir: getCliRootDir(),
        env: { HAPPIER_STACK_REPO_DIR: selectedRepoDir },
      });
      if (
        selectedEntrypoint.source === 'stack-repo-wrapper'
        && resolve(selectedEntrypoint.cwd) !== resolve(getCliRootDir())
      ) {
        return true;
      }
    }
  }

  if (subcommand !== 'dev' && subcommand !== 'start') return false;

  // A TUI-owned child reaches the component-specific admission owners below the
  // Stack control plane. Re-running the global wrapper preflight here serializes
  // startup before incumbent/last-green adoption can occur.
  if (isTuiManaged) return true;

  const hasBackground = rest.some((arg) => arg === '--background');
  return hasBackground && hasJsonFlag(rest);
}

function isInstalledServiceStartInvocation(argv) {
  return Array.isArray(argv) && argv.length === 2 && argv[0] === 'start' && argv[1] === '--restart';
}

function handleMissingExplicitStackEnvBeforePreflight(argv) {
  const envPath = resolveExplicitStackEnvFilePath(process.env);
  if (!envPath || existsSync(envPath)) return false;
  if (isHelpInvocation(argv)) return false;

  console.error(`[hstack] configured stack env file is missing: ${envPath}`);
  const serviceMode = (process.env.HAPPIER_STACK_SERVICE_MODE ?? '').trim() === '1';
  if (serviceMode && isInstalledServiceStartInvocation(argv)) {
    console.error('[hstack] service start skipped; reinstall or remove the archived stack service before starting it again.');
    return true;
  }

  throw new Error(
    `Configured HAPPIER_STACK_ENV_FILE does not exist: ${envPath}\n` +
      'Fix the path, unset HAPPIER_STACK_ENV_FILE, or recreate the stack.',
  );
}

function maybeWarnDeprecatedSetup(cmd, rest) {
  if (cmd !== 'setup') return;
  if (hasJsonFlag(rest)) return;
  // Keep this on stderr so stdout remains script-friendly (especially when piping output).
  console.error('[hstack] DEPRECATED: `hstack setup` is deprecated and will be removed in a future release.');
  console.error('[hstack] Use `hstack setup-from-source` for from-source setup (workspace + deps).');
  console.error('[hstack] For managed self-hosting (service + rollback), use `hstack self-host install`.');
  console.error('');
}

async function main() {
  const cliRootDir = getCliRootDir();
  const initialArgv = process.argv.slice(2);
  const argv0 = applyVerbosityIfRequested(initialArgv);
  const { argv, enabled: sandboxed } = applySandboxDirIfRequested(argv0);
  void sandboxed;

  // Preserve the original working directory across re-exec to the CLI root so commands can infer
  // component/worktree context even when the actual scripts run with cwd=cliRootDir.
  if (!(process.env.HAPPIER_STACK_INVOKED_CWD ?? '').trim()) {
    process.env.HAPPIER_STACK_INVOKED_CWD = process.cwd();
  }

  const executionHostProfile = readExecutionHostProfile(process.env);
  if (shouldDelegateToActiveExecutionHost({
    profile: executionHostProfile,
    argv,
    platform: process.platform,
    env: process.env,
  })) {
    const outcome = await runDelegatedHstackCommand({
      profile: executionHostProfile,
      argv,
      cwd: process.cwd(),
      env: process.env,
    });
    if (outcome.signal) {
      process.kill(process.pid, outcome.signal);
      return;
    }
    process.exit(outcome.exitCode ?? 1);
  }

  if (handleMissingExplicitStackEnvBeforePreflight(argv)) return;

  maybeReexecToCliRoot(cliRootDir, argv);

  // If the user passed only flags (common via `npx --yes -p @happier-dev/stack hstack --help`),
  // treat it as root help rather than `help --help` (which would look like
  // "unknown command: --help").
  const cmd = argv.find((a) => !a.startsWith('--')) ?? 'help';
  const cmdIndex = argv.indexOf(cmd);
  const rest = cmdIndex >= 0 ? argv.slice(cmdIndex + 1) : [];

  if ((cmd === 'help' || cmd === '--help' || cmd === '-h') && (!rest[0] || rest[0].startsWith('-'))) {
    console.log(usage());
    return;
  }

  const preflightArgv = normalizeStackShorthandForPreflight(argv);
  const skipBundledWorkspacePreflight = shouldSkipBundledWorkspacePreflight(preflightArgv);
  if (!skipBundledWorkspacePreflight) {
    await refreshLocalBundledWorkspacePackages(cliRootDir, { argv: preflightArgv });
    await maybeAutoUpdateNotice(cliRootDir, cmd);
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    const target = rest[0];
    const targetCmd = resolvehstackCommand(target);
    if (!targetCmd || targetCmd.kind !== 'node') {
      console.error(`[hstack] unknown command: ${target}`);
      console.error('');
      console.log(usage());
      process.exit(1);
    }
    const helpArgs = commandHelpArgs(target) ?? ['--help'];
    return runNodeScript(cliRootDir, targetCmd.scriptRelPath, helpArgs);
  }

  let resolved = resolvehstackCommand(cmd);
  if (!resolved) {
    // Stack shorthand:
    // If the first token is not a known command, but it *is* an existing stack name,
    // treat `hstack <stack> <command> ...` as `hstack stack <command> <stack> ...`.
    const stackName = cmd;
    const { envPath } = resolveStackEnvPath(stackName, process.env);
    const stackExists = existsSync(envPath);
    if (stackExists) {
      const cmdIdx = rest.findIndex((a) => !a.startsWith('-'));
      if (cmdIdx < 0) {
        if (rest.includes('--help') || rest.includes('-h')) {
          const stackCmd = resolvehstackCommand('stack');
          if (!stackCmd || stackCmd.kind !== 'node') {
            console.error('[hstack] internal error: missing stack command');
            process.exit(1);
          }
          return runNodeScript(cliRootDir, stackCmd.scriptRelPath, ['--help']);
        }
        console.error(`[hstack] missing command after stack name: ${stackName}`);
        console.error('');
        console.error('Try one of:');
        console.error(`  hstack ${stackName} env list`);
        console.error(`  hstack ${stackName} dev`);
        console.error(`  hstack ${stackName} start`);
        console.error('');
        console.error('Equivalent long form:');
        console.error(`  hstack stack <command> ${stackName} ...`);
        process.exit(1);
      }

      const stackSubcmd = rest[cmdIdx];
      const preFlags = rest.slice(0, cmdIdx);
      const post = rest.slice(cmdIdx + 1);
      const stackArgs = [stackSubcmd, stackName, ...preFlags, ...post];

      resolved = resolvehstackCommand('stack');
      if (!resolved || resolved.kind !== 'node') {
        console.error('[hstack] internal error: missing stack command');
        process.exit(1);
      }
      return runNodeScript(cliRootDir, resolved.scriptRelPath, stackArgs);
    }

    console.error(`[hstack] unknown command: ${cmd}`);
    console.error('');
    console.error(usage());
    process.exit(1);
  }

  maybeWarnDeprecatedSetup(cmd, rest);

  if (resolved.kind === 'external') {
    const args = resolved.external?.argsFromRest ? resolved.external.argsFromRest(rest) : rest;
    const res = spawnSync(resolved.external.cmd, args, { stdio: 'inherit', env: process.env });
    process.exit(res.status ?? 1);
  }

  const args = resolved.argsFromRest ? resolved.argsFromRest(rest) : rest;
  return runNodeScript(cliRootDir, resolved.scriptRelPath, args);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
