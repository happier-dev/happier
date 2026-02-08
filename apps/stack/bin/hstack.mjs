#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandHelpArgs, renderhstackRootHelp, resolvehstackCommand } from '../scripts/utils/cli/cli_registry.mjs';
import { expandHome, getCanonicalHomeEnvPathFromEnv } from '../scripts/utils/paths/canonical_home.mjs';
import { resolveStackEnvPath } from '../scripts/utils/paths/paths.mjs';
import { SANDBOX_PRESERVE_KEYS, scrubHappierStackEnv } from '../scripts/utils/env/scrub_env.mjs';
import { maybeAutoUpdateNotice as maybeAutoUpdateNoticeShared } from '../scripts/utils/update/auto_update_notice.mjs';

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

function maybeReexecToCliRoot(cliRootDir) {
  if ((process.env.HAPPIER_STACK_CLI_REEXEC ?? process.env.HAPPIER_STACK_DEV_REEXEC ?? '') === '1') return;
  if ((process.env.HAPPIER_STACK_CLI_ROOT_DISABLE ?? process.env.HAPPIER_STACK_DEV_CLI_DISABLE ?? '') === '1') return;

  const cliRoot = resolveCliRootDir();
  if (!cliRoot) return;
  if (cliRoot === cliRootDir) return;

  const cliBin = join(cliRoot, 'bin', 'hstack.mjs');
  if (!existsSync(cliBin)) return;

  const argv = process.argv.slice(2);
  const res = spawnSync(process.execPath, [cliBin, ...argv], {
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
  const workspaceDir = join(sandboxDir, 'workspace');
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

function maybeAutoUpdateNotice(cliRootDir, cmd) {
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

function main() {
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

  maybeReexecToCliRoot(cliRootDir);

  // If the user passed only flags (common via `npx --yes -p @happier-dev/stack hstack --help`),
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

  if (resolved.kind === 'external') {
    const args = resolved.external?.argsFromRest ? resolved.external.argsFromRest(rest) : rest;
    const res = spawnSync(resolved.external.cmd, args, { stdio: 'inherit', env: process.env });
    process.exit(res.status ?? 1);
  }

  const args = resolved.argsFromRest ? resolved.argsFromRest(rest) : rest;
  return runNodeScript(cliRootDir, resolved.scriptRelPath, args);
}

main();
