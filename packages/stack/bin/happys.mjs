#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandHelpArgs, renderHappysRootHelp, resolveHappysCommand } from '../scripts/utils/cli/cli_registry.mjs';
import { expandHome, getCanonicalHomeEnvPathFromEnv } from '../scripts/utils/paths/canonical_home.mjs';
import { resolveStackEnvPath } from '../scripts/utils/paths/paths.mjs';

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
    process.env.HAPPY_STACKS_CLI_ROOT_DIR ??
    process.env.HAPPY_STACKS_DEV_CLI_ROOT_DIR ??
    ''
  ).trim();
  if (fromEnv) return expandHome(fromEnv);

  // Stable pointer file: even if the real home dir is elsewhere, `happys init` writes the pointer here.
  const canonicalEnv = getCanonicalHomeEnvPathFromEnv(process.env);
  const v =
    dotenvGetQuick(canonicalEnv, 'HAPPY_STACKS_CLI_ROOT_DIR') ||
    dotenvGetQuick(canonicalEnv, 'HAPPY_STACKS_DEV_CLI_ROOT_DIR') ||
    '';
  return v ? expandHome(v) : '';
}

function maybeReexecToCliRoot(cliRootDir) {
  if ((process.env.HAPPY_STACKS_CLI_REEXEC ?? process.env.HAPPY_STACKS_DEV_REEXEC ?? '') === '1') return;
  if ((process.env.HAPPY_STACKS_CLI_ROOT_DISABLE ?? process.env.HAPPY_STACKS_DEV_CLI_DISABLE ?? '') === '1') return;

  const cliRoot = resolveCliRootDir();
  if (!cliRoot) return;
  if (cliRoot === cliRootDir) return;

  const cliBin = join(cliRoot, 'bin', 'happys.mjs');
  if (!existsSync(cliBin)) return;

  const argv = process.argv.slice(2);
  const res = spawnSync(process.execPath, [cliBin, ...argv], {
    stdio: 'inherit',
    cwd: cliRoot,
    env: {
      ...process.env,
      HAPPY_STACKS_CLI_REEXEC: '1',
      HAPPY_STACKS_CLI_ROOT_DIR: cliRoot,
    },
  });
  process.exit(res.status ?? 1);
}

function resolveHomeDir() {
  const fromEnv = (process.env.HAPPY_STACKS_HOME_DIR ?? '').trim();
  if (fromEnv) return expandHome(fromEnv);

  // Stable pointer file: even if the real home dir is elsewhere, `happys init` writes the pointer here.
  const canonicalEnv = getCanonicalHomeEnvPathFromEnv(process.env);
  const v = dotenvGetQuick(canonicalEnv, 'HAPPY_STACKS_HOME_DIR') || '';
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
  // We set HAPPY_STACKS_VERBOSE (0-3) and strip these args so downstream scripts don't need to support them.
  let level = Number.isFinite(Number(process.env.HAPPY_STACKS_VERBOSE)) ? Number(process.env.HAPPY_STACKS_VERBOSE) : null;
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
    process.env.HAPPY_STACKS_VERBOSE = String(Math.max(0, Math.min(3, Math.floor(level))));
  }
  return next;
}

function applySandboxDirIfRequested(argv) {
  const explicit = (process.env.HAPPY_STACKS_SANDBOX_DIR ?? '').trim();
  const { value, argv: nextArgv } = stripGlobalOpt(argv, { name: '--sandbox-dir', aliases: ['--sandbox'] });
  const raw = value || explicit;
  if (!raw) return { argv: nextArgv, enabled: false };

  const sandboxDir = expandHome(raw);
  const allowGlobalRaw = (process.env.HAPPY_STACKS_SANDBOX_ALLOW_GLOBAL ?? '').trim().toLowerCase();
  const allowGlobal = allowGlobalRaw === '1' || allowGlobalRaw === 'true' || allowGlobalRaw === 'yes' || allowGlobalRaw === 'y';
  // Keep all state under one folder that can be deleted to reset completely.
  const canonicalHomeDir = join(sandboxDir, 'canonical');
  const homeDir = join(sandboxDir, 'home');
  const workspaceDir = join(sandboxDir, 'workspace');
  const runtimeDir = join(sandboxDir, 'runtime');
  const storageDir = join(sandboxDir, 'storage');

  // Sandbox isolation MUST win over any pre-exported Happy Stacks env vars.
  // Otherwise sandbox runs can accidentally read/write "real" machine state.
  //
  // Keep only a tiny set of sandbox-safe globals; everything else should be driven by flags
  // and stack env files inside the sandbox.
  const preserved = new Map();
  const keepKeys = [
    'HAPPY_STACKS_VERBOSE',
    'HAPPY_STACKS_INVOKED_CWD',
    'HAPPY_STACKS_SANDBOX_DIR',
    'HAPPY_STACKS_SANDBOX_ALLOW_GLOBAL',
    'HAPPY_STACKS_UPDATE_CHECK',
    'HAPPY_STACKS_UPDATE_CHECK_INTERVAL_MS',
    'HAPPY_STACKS_UPDATE_NOTIFY_INTERVAL_MS',
  ];
  for (const k of keepKeys) {
    if (process.env[k] != null && String(process.env[k]).trim() !== '') {
      preserved.set(k, process.env[k]);
    }
  }
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('HAPPY_STACKS_')) {
      delete process.env[k];
      continue;
    }
    // Also clear unprefixed Happy vars; sandbox commands should compute these from stack state.
    if (k === 'HAPPY_HOME_DIR' || k === 'HAPPY_SERVER_URL' || k === 'HAPPY_WEBAPP_URL') {
      delete process.env[k];
    }
  }
  for (const [k, v] of preserved.entries()) {
    process.env[k] = v;
  }

  process.env.HAPPY_STACKS_SANDBOX_DIR = sandboxDir;
  process.env.HAPPY_STACKS_CLI_ROOT_DISABLE = '1'; // never re-exec into a user's "real" install when sandboxing

  // In sandbox mode, we MUST force all state directories into the sandbox, even if the user
  // exported HAPPY_STACKS_* in their shell. Otherwise sandbox runs can accidentally read/write
  // "real" machine state (breaking isolation).
  process.env.HAPPY_STACKS_CANONICAL_HOME_DIR = canonicalHomeDir;

  process.env.HAPPY_STACKS_HOME_DIR = homeDir;

  process.env.HAPPY_STACKS_WORKSPACE_DIR = workspaceDir;

  process.env.HAPPY_STACKS_RUNTIME_DIR = runtimeDir;

  process.env.HAPPY_STACKS_STORAGE_DIR = storageDir;

  // Sandbox default: disallow global side effects unless explicitly opted in.
  // This keeps sandbox runs fast, deterministic, and isolated.
  if (!allowGlobal) {
    // Network-y UX (background update checks) are not useful in a temporary sandbox.
    process.env.HAPPY_STACKS_UPDATE_CHECK = '0';
    process.env.HAPPY_STACKS_UPDATE_CHECK_INTERVAL_MS = '0';
    process.env.HAPPY_STACKS_UPDATE_NOTIFY_INTERVAL_MS = '0';

    // Never auto-enable or reset Tailscale Serve in sandbox.
    // (Tailscale is global machine state; sandbox runs must not touch it.)
    process.env.HAPPY_STACKS_TAILSCALE_SERVE = '0';
    process.env.HAPPY_STACKS_TAILSCALE_RESET_ON_EXIT = '0';
  }

  return { argv: nextArgv, enabled: true };
}

function maybeAutoUpdateNotice(cliRootDir, cmd) {
  // Non-blocking, cached update checks:
  // - never run network calls in-process
  // - optionally print a notice (TTY only) if cache says an update is available
  // - periodically kick off a background check that refreshes the cache
  const enabled = (process.env.HAPPY_STACKS_UPDATE_CHECK ?? '1') !== '0';
  if (!enabled) return;
  // Never do background checks for non-interactive invocations (CI, LaunchAgents, scripts).
  if (!process.stdout.isTTY) return;
  if (process.env.HAPPY_STACKS_UPDATE_CHECK_SPAWNED === '1') return;
  if (cmd === 'self' || cmd === 'help' || cmd === '--help' || cmd === '-h') return;

  const homeDir = resolveHomeDir();
  const cacheDir = join(homeDir, 'cache');
  const cachePath = join(cacheDir, 'update.json');

  const intervalMsRaw = (process.env.HAPPY_STACKS_UPDATE_CHECK_INTERVAL_MS ?? '').trim();
  const intervalMs = intervalMsRaw ? Number(intervalMsRaw) : 24 * 60 * 60 * 1000;
  const notifyIntervalMsRaw = (process.env.HAPPY_STACKS_UPDATE_NOTIFY_INTERVAL_MS ?? '').trim();
  const notifyIntervalMs = notifyIntervalMsRaw ? Number(notifyIntervalMsRaw) : 24 * 60 * 60 * 1000;

  let cached = null;
  try {
    if (existsSync(cachePath)) {
      cached = JSON.parse(readFileSync(cachePath, 'utf-8'));
    }
  } catch {
    cached = null;
  }

  const now = Date.now();
  const checkedAt = typeof cached?.checkedAt === 'number' ? cached.checkedAt : 0;
  const shouldCheck = !checkedAt || (Number.isFinite(intervalMs) && now - checkedAt > intervalMs);

  const updateAvailable = Boolean(cached?.updateAvailable);
  const latest = typeof cached?.latest === 'string' ? cached.latest : '';
  const current = typeof cached?.current === 'string' ? cached.current : '';
  const notifiedAt = typeof cached?.notifiedAt === 'number' ? cached.notifiedAt : 0;
  const shouldNotify =
    Boolean(updateAvailable && latest) &&
    Boolean(process.stdout.isTTY) &&
    (!notifiedAt || (Number.isFinite(notifyIntervalMs) && now - notifiedAt > notifyIntervalMs));

  if (shouldNotify) {
    const from = current ? current : 'current';
    // Keep it short; no network calls here.
    console.error(`[happys] update available: ${from} -> ${latest} (run: happys self update)`);
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        cachePath,
        JSON.stringify(
          {
            ...(cached ?? {}),
            notifiedAt: now,
          },
          null,
          2
        ) + '\n',
        'utf-8'
      );
    } catch {
      // ignore
    }
  }

  if (!shouldCheck) return;

  // Kick off a background refresh (best-effort, no logs).
  try {
    const child = spawn(process.execPath, [join(cliRootDir, 'scripts', 'self.mjs'), 'check', '--quiet'], {
      stdio: 'ignore',
      cwd: cliRootDir,
      env: { ...process.env, HAPPY_STACKS_UPDATE_CHECK_SPAWNED: '1' },
      detached: true,
    });
    child.unref();
  } catch {
    // ignore
  }
}

function usage() {
  return renderHappysRootHelp();
}

function runNodeScript(cliRootDir, scriptRelPath, args) {
  const scriptPath = join(cliRootDir, scriptRelPath);
  if (!existsSync(scriptPath)) {
    console.error(`[happys] missing script: ${scriptPath}`);
    process.exit(1);
  }
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: 'inherit',
    env: process.env,
    cwd: cliRootDir,
  });
  process.exit(res.status ?? 1);
}

function main() {
  const cliRootDir = getCliRootDir();
  const initialArgv = process.argv.slice(2);
  const argv0 = applyVerbosityIfRequested(initialArgv);
  const { argv, enabled: sandboxed } = applySandboxDirIfRequested(argv0);
  void sandboxed;

  // Preserve the original working directory across re-exec to the CLI root so commands can infer
  // component/worktree context even when the actual scripts run with cwd=cliRootDir.
  if (!(process.env.HAPPY_STACKS_INVOKED_CWD ?? '').trim()) {
    process.env.HAPPY_STACKS_INVOKED_CWD = process.cwd();
  }

  maybeReexecToCliRoot(cliRootDir);

  // If the user passed only flags (common via `npx happy-stacks --help`),
  // treat it as root help rather than `help --help` (which would look like
  // "unknown command: --help").
  const cmd = argv.find((a) => !a.startsWith('--')) ?? 'help';
  const cmdIndex = argv.indexOf(cmd);
  const rest = cmdIndex >= 0 ? argv.slice(cmdIndex + 1) : [];

  maybeAutoUpdateNotice(cliRootDir, cmd);

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    const target = rest[0];
    if (!target || target.startsWith('-')) {
      console.log(usage());
      return;
    }
    const targetCmd = resolveHappysCommand(target);
    if (!targetCmd || targetCmd.kind !== 'node') {
      console.error(`[happys] unknown command: ${target}`);
      console.error('');
      console.log(usage());
      process.exit(1);
    }
    const helpArgs = commandHelpArgs(target) ?? ['--help'];
    return runNodeScript(cliRootDir, targetCmd.scriptRelPath, helpArgs);
  }

  let resolved = resolveHappysCommand(cmd);
  if (!resolved) {
    // Stack shorthand:
    // If the first token is not a known command, but it *is* an existing stack name,
    // treat `happys <stack> <command> ...` as `happys stack <command> <stack> ...`.
    const stackName = cmd;
    const { envPath } = resolveStackEnvPath(stackName, process.env);
    const stackExists = existsSync(envPath);
    if (stackExists) {
      const cmdIdx = rest.findIndex((a) => !a.startsWith('-'));
      if (cmdIdx < 0) {
        if (rest.includes('--help') || rest.includes('-h')) {
          const stackCmd = resolveHappysCommand('stack');
          if (!stackCmd || stackCmd.kind !== 'node') {
            console.error('[happys] internal error: missing stack command');
            process.exit(1);
          }
          return runNodeScript(cliRootDir, stackCmd.scriptRelPath, ['--help']);
        }
        console.error(`[happys] missing command after stack name: ${stackName}`);
        console.error('');
        console.error('Try one of:');
        console.error(`  happys ${stackName} env list`);
        console.error(`  happys ${stackName} dev`);
        console.error(`  happys ${stackName} start`);
        console.error('');
        console.error('Equivalent long form:');
        console.error(`  happys stack <command> ${stackName} ...`);
        process.exit(1);
      }

      const stackSubcmd = rest[cmdIdx];
      const preFlags = rest.slice(0, cmdIdx);
      const post = rest.slice(cmdIdx + 1);
      const stackArgs = [stackSubcmd, stackName, ...preFlags, ...post];

      resolved = resolveHappysCommand('stack');
      if (!resolved || resolved.kind !== 'node') {
        console.error('[happys] internal error: missing stack command');
        process.exit(1);
      }
      return runNodeScript(cliRootDir, resolved.scriptRelPath, stackArgs);
    }

    console.error(`[happys] unknown command: ${cmd}`);
    console.error('');
    console.error(usage());
    process.exit(1);
  }

  if (resolved.kind === 'external') {
    const args = resolved.external?.argsFromRest ? resolved.external.argsFromRest(rest) : rest;
    const res = spawnSync(resolved.external.cmd, args, { stdio: 'inherit', env: process.env });
    process.exit(res.status ?? 1);
  }

  const args = resolved.argsFromRest ? resolved.argsFromRest(rest) : rest;
  return runNodeScript(cliRootDir, resolved.scriptRelPath, args);
}

main();
