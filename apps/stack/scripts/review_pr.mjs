import './utils/env/env.mjs';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getRootDir } from './utils/paths/paths.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { getVerbosityLevel } from './utils/cli/verbosity.mjs';
import { createStepPrinter } from './utils/cli/progress.mjs';
import { prompt, promptSelect, withRl } from './utils/cli/wizard.mjs';
import { assertCliPrereqs } from './utils/cli/prereqs.mjs';
import { randomToken } from './utils/crypto/tokens.mjs';
import { inferPrStackBaseName } from './utils/stack/pr_stack_name.mjs';
import { sanitizeStackName } from './utils/stack/names.mjs';
import { listReviewPrSandboxes, reviewPrSandboxPrefixPath, writeReviewPrSandboxMeta } from './utils/sandbox/review_pr_sandbox.mjs';
import { bold, cyan, dim } from './utils/ui/ansi.mjs';
import { expandHome } from './utils/paths/canonical_home.mjs';
import { fastForwardBranchToRemote } from './utils/git/fast_forward_to_remote.mjs';
import { resolveDefaultRemoteBranch } from './utils/git/default_branch.mjs';
import { shouldRunYarnInstall } from './utils/worktrees/yarn_install_guard.mjs';
import { run } from './utils/proc/proc.mjs';
import { applyStackCacheEnv } from './utils/proc/pm.mjs';
 
function usage() {
  return [
    '[review-pr] usage:',
    '  hstack tools review-pr --repo=<pr-url|number> [--name=<stack>] [--dev|--start] [--mobile|--no-mobile] [--workspace-cache|--no-workspace-cache] [--workspace-cache-dir=<dir>] [--forks|--upstream] [--seed-auth|--no-seed-auth] [--copy-auth-from=<stack>] [--link-auth|--copy-auth] [--update] [--force] [--keep-sandbox] [--json] [-- <stack dev/start args...>]',
    '',
    'VM port forwarding (optional):',
    '- `--vm-ports`: convenience preset for port-forwarded VMs (stack ports ~13xxx, Expo ports ~18xxx)',
    '- `--stack-port-start=<n>`: sets HAPPIER_STACK_STACK_PORT_START inside the sandbox',
    '- `--expo-dev-port-strategy=stable|ephemeral`: sets HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY inside the sandbox',
    '- `--expo-dev-port-base=<n>` / `--expo-dev-port-range=<n>`: stable Expo port hashing params',
    '- `--expo-dev-port=<n>`: force the Expo dev (Metro) port inside the sandbox',
    '',
    'What it does:',
    '- creates a temporary sandbox dir',
    '- runs `hstack tools setup-pr ...` inside that sandbox (sandboxed home/runtime/storage; optional shared workspace cache)',
    '- on exit (including Ctrl+C): stops sandbox processes and deletes the sandbox dir',
    '- prints a "Terminal usage" section with the exact env exports + `happier` command to run sessions against the sandbox server/account',
    '',
  ].join('\n');
}
 
function waitForExit(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.on('error', rejectPromise);
    child.on('close', (code, signal) => resolvePromise({ code: code ?? 1, signal: signal ?? null }));
  });
}
 
async function tryStopSandbox({ rootDir, sandboxDir }) {
  const bin = join(rootDir, 'bin', 'hstack.mjs');
  const child = spawn(process.execPath, [bin, '--sandbox-dir', sandboxDir, 'stop', '--yes', '--aggressive', '--sweep-owned', '--no-service'], {
    cwd: rootDir,
    env: process.env,
    stdio: 'ignore',
  });
  await waitForExit(child);
}
 
function argvHasFlag(argv, names) {
  for (const n of names) {
    if (argv.includes(n)) return true;
  }
  return false;
}

function kvValue(argv, names) {
  for (const a of argv) {
    for (const n of names) {
      if (a === n) {
        return '';
      }
      if (a.startsWith(`${n}=`)) {
        return a.slice(`${n}=`.length);
      }
    }
  }
  return null;
}

function stripArgv(argv, names) {
  const out = [];
  for (const a of argv) {
    let keep = true;
    for (const n of names) {
      if (a === n || a.startsWith(`${n}=`)) {
        keep = false;
        break;
      }
    }
    if (keep) out.push(a);
  }
  return out;
}

function resolveSandboxPortEnvOverrides(argv) {
  const overrides = {};

  // Convenience preset for VM review flows (pairs with Lima port-forward ranges in docs).
  if (argvHasFlag(argv, ['--vm-ports'])) {
    overrides.HAPPIER_STACK_STACK_PORT_START = '13005';

    // Keep Expo dev ports stable per stack so forwarded ports remain predictable.
    overrides.HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY = 'stable';
    overrides.HAPPIER_STACK_EXPO_DEV_PORT_BASE = '18081';
    overrides.HAPPIER_STACK_EXPO_DEV_PORT_RANGE = '1000';
  }

  const stackPortStart = (kvValue(argv, ['--stack-port-start']) ?? '').trim();
  if (stackPortStart) {
    overrides.HAPPIER_STACK_STACK_PORT_START = stackPortStart;
  }

  const expoStrategy = (kvValue(argv, ['--expo-dev-port-strategy']) ?? '').trim().toLowerCase();
  if (expoStrategy === 'stable' || expoStrategy === 'ephemeral') {
    overrides.HAPPIER_STACK_EXPO_DEV_PORT_STRATEGY = expoStrategy;
  }

  const expoBase = (kvValue(argv, ['--expo-dev-port-base']) ?? '').trim();
  if (expoBase) {
    overrides.HAPPIER_STACK_EXPO_DEV_PORT_BASE = expoBase;
  }

  const expoRange = (kvValue(argv, ['--expo-dev-port-range']) ?? '').trim();
  if (expoRange) {
    overrides.HAPPIER_STACK_EXPO_DEV_PORT_RANGE = expoRange;
  }

  const expoForced = (kvValue(argv, ['--expo-dev-port']) ?? '').trim();
  if (expoForced) {
    overrides.HAPPIER_STACK_EXPO_DEV_PORT = expoForced;
  }

  return Object.keys(overrides).length ? overrides : null;
}

function resolveWorkspaceCacheConfig(argv) {
  const enabledByDefault = true;
  const disabled = argvHasFlag(argv, ['--no-workspace-cache']);
  const enabled = argvHasFlag(argv, ['--workspace-cache']) ? true : !disabled && enabledByDefault;
  const explicitDirRaw = (kvValue(argv, ['--workspace-cache-dir']) ?? '').trim();

  if (!enabled) return { enabled: false, workspaceDir: '', legacy: false, suggestedDir: '' };

  const workspaceDir = (() => {
    if (explicitDirRaw) {
      return resolve(expandHome(explicitDirRaw));
    }
    const baseHome = (process.env.HAPPIER_STACK_HOME_DIR ?? '').trim()
      ? process.env.HAPPIER_STACK_HOME_DIR.trim()
      : join(homedir(), '.happier-stack');
    const nextDefault = resolve(join(baseHome, 'cache', 'sandbox', 'workspace'));
    const legacyDefault = resolve(join(baseHome, 'cache', 'review-pr', 'workspace'));
    // Backwards-compat: if an existing cache already lives at the legacy path, keep using it
    // unless the new default exists too.
    if (existsSync(legacyDefault) && !existsSync(nextDefault)) {
      return legacyDefault;
    }
    return nextDefault;
  })();

  const baseHome = (process.env.HAPPIER_STACK_HOME_DIR ?? '').trim()
    ? process.env.HAPPIER_STACK_HOME_DIR.trim()
    : join(homedir(), '.happier-stack');
  const suggestedDir = resolve(join(baseHome, 'cache', 'sandbox', 'workspace'));
  const legacyDir = resolve(join(baseHome, 'cache', 'review-pr', 'workspace'));
  const legacy = !explicitDirRaw && resolve(workspaceDir) === legacyDir;

  return { enabled: true, workspaceDir, legacy, suggestedDir };
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function resolvePmCacheBaseDirFromWorkspaceDir(workspaceDir) {
  const ws = String(workspaceDir ?? '').trim();
  if (!ws) return '';
  const abs = resolve(ws);
  // Default cache layout: <home>/cache/sandbox/{workspace,pm}
  if (basename(abs) === 'workspace') {
    return join(dirname(abs), 'pm');
  }
  // Custom workspace roots: keep caches inside to avoid surprising global writes.
  return join(abs, '.hstack-cache', 'pm');
}

async function acquireWorkspaceCacheLock(workspaceDir) {
  const dir = String(workspaceDir ?? '').trim();
  if (!dir) return { ok: true, lockPath: '' };
  await mkdir(dir, { recursive: true });

  const lockPath = join(dir, '.hstack-sandbox-workspace.lock');
  try {
    await writeFile(lockPath, `${process.pid}\n${Date.now()}\n`, { encoding: 'utf-8', flag: 'wx' });
    return { ok: true, lockPath };
  } catch {
    // Best-effort stale lock recovery.
    try {
      const raw = await readFile(lockPath, 'utf-8');
      const pid = Number(raw.split('\n')[0] ?? NaN);
      if (isPidAlive(pid)) {
        return {
          ok: false,
          lockPath,
          error:
            `[review-pr] workspace cache is currently in use (lock: ${lockPath}, pid=${pid}).\n` +
            `[review-pr] Fix: wait for the other run to finish, or re-run with --no-workspace-cache, or set --workspace-cache-dir=...`,
        };
      }
    } catch {
      // ignore
    }
    // Stale or unreadable lock: remove and retry once.
    await rm(lockPath, { force: true }).catch(() => {});
    await writeFile(lockPath, `${process.pid}\n${Date.now()}\n`, { encoding: 'utf-8', flag: 'wx' });
    return { ok: true, lockPath };
  }
}

async function main() {
  const rootDir = getRootDir(import.meta.url);
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const verbosity = getVerbosityLevel(process.env);
  const steps = createStepPrinter({ enabled: Boolean(process.stdout.isTTY && !json && verbosity === 0) });
 
  if (wantsHelp(argv, { flags })) {
    printResult({ json, data: { usage: usage() }, text: usage() });
    return;
  }
 
  await assertCliPrereqs({ git: true, yarn: true });

  // Determine a stable base stack name from PR inputs (used for sandbox discovery),
  // and a per-run unique stack name by default (prevents browser storage collisions across deleted sandboxes).
  const prRepo = (kvValue(argv, ['--repo', '--pr']) ?? '').trim();
  const legacyHappy = (kvValue(argv, ['--happy']) ?? '').trim();
  if (legacyHappy) {
    throw new Error('[review-pr] use --repo=<pr-url|number> (the old --happy flag has been removed)');
  }
  if (!prRepo) {
    throw new Error('[review-pr] missing PR input. Provide --repo=<pr-url|number>.');
  }
  for (const legacy of ['--happy-cli', '--happy-server', '--happy-server-light']) {
    const v = (kvValue(argv, [legacy]) ?? '').trim();
    if (v) {
      throw new Error(`[review-pr] legacy split-repo flag is not supported anymore: ${legacy}\nFix: use --repo=<pr-url|number>`);
    }
  }
  const explicitName = (kvValue(argv, ['--name']) ?? '').trim();

  const baseStackName = explicitName
    ? sanitizeStackName(explicitName, { fallback: 'pr', maxLen: 64 })
    : inferPrStackBaseName({ happy: prRepo, happyCli: '', server: '', serverLight: '', fallback: 'pr' });

  const shouldAutoSuffix = !explicitName;
  const uniqueSuffix = randomToken(4); // short, URL-safe-ish
  const newStackName = shouldAutoSuffix
    ? sanitizeStackName(`${baseStackName}-${uniqueSuffix}`, { fallback: baseStackName, maxLen: 64 })
    : baseStackName;

  // Look for leftover sandboxes for the same PR base name (typically due to --keep-sandbox / failures).
  const canPrompt = Boolean(process.stdout.isTTY && process.stdin.isTTY && !json);
  const existingSandboxes = canPrompt ? await listReviewPrSandboxes({ baseStackName }) : [];
  const workspaceCache = resolveWorkspaceCacheConfig(argv);

  if (process.stdout.isTTY && !json) {
    const intro = [
      '',
      '',
      bold(`✨ ${cyan('hstack')} review-pr ✨`),
      '',
      'It will help you review a PR for Happier in a completely isolated environment.',
      dim('Uses the light server flavor by default (no Redis, no Postgres, no Docker).'),
      dim('Desktop browser + optional mobile review (Expo dev-client).'),
      '',
      workspaceCache.enabled
        ? dim(
            `Workspace cache: enabled (${workspaceCache.workspaceDir}). Disable with --no-workspace-cache.${
              workspaceCache.legacy && workspaceCache.suggestedDir
                ? ` (legacy path; recommended: ${workspaceCache.suggestedDir})`
                : ''
            }`
          )
        : dim('Workspace cache: disabled (fresh workspace per run).'),
      '',
      bold('What will happen:'),
      `- ${cyan('sandbox')}: temporary isolated Happier install`,
      workspaceCache.enabled
        ? `- ${cyan('repos')}: update cached sandbox workspace (faster repeats)`
        : `- ${cyan('repos')}: clone/install (inside the sandbox only)`,
      `- ${cyan('start')}: start the Happier stack in sandbox (server, daemon, web, mobile)`,
      `- ${cyan('login')}: guide you through Happier login for this sandbox`,
      `- ${cyan('browser')}: open the Happier web app`,
      `- ${cyan('mobile')}: start Expo dev-client (optional)`,
      `- ${cyan('cleanup')}: stop processes + delete sandbox on exit`,
      '',
      dim(
        workspaceCache.enabled
          ? 'Sandbox dirs are deleted automatically when you exit. Workspace cache is preserved.'
          : 'Everything is deleted automatically when you exit.'
      ),
      dim('Your main Happier installation remains untouched.'),
      '',
      dim('Tips:'),
      dim('- Add `-v` / `-vv` / `-vvv` to show the full logs'),
      dim('- Add `--keep-sandbox` to keep the sandbox directory between runs'),
      dim('- To start a CLI session from another terminal, use the printed "Terminal usage" exports, then run `happier`'),
      '',
      existingSandboxes.length
        ? bold('Choose how to proceed') + dim(' (or Ctrl+C to cancel).')
        : bold('Press Enter to proceed') + dim(' (or Ctrl+C to cancel).'),
    ].join('\n');
    // eslint-disable-next-line no-console
    console.log(intro);
    if (!existingSandboxes.length) {
      await withRl(async (rl) => {
        await prompt(rl, '', { defaultValue: '' });
      });
    }
  }

  let sandboxDir = '';
  let createdNewSandbox = false;
  let reusedSandboxMeta = null;

  if (existingSandboxes.length) {
    const picked = await withRl(async (rl) => {
      const options = [
        { label: 'Create a new sandbox (recommended)', value: 'new' },
        ...existingSandboxes.map((s) => {
          const stackLabel = s.stackName ? `stack=${s.stackName}` : 'stack=?';
          return { label: `Reuse existing sandbox (${stackLabel}) — ${s.dir}`, value: s.dir };
        }),
      ];
      return await promptSelect(rl, {
        title: 'Review-pr sandbox:',
        options,
        defaultIndex: 0,
      });
    });
    if (picked === 'new') {
      steps.start('create temporary sandbox');
      const prefix = reviewPrSandboxPrefixPath(baseStackName);
      sandboxDir = resolve(await mkdtemp(prefix));
      createdNewSandbox = true;
      steps.stop('✓', 'create temporary sandbox');
    } else {
      sandboxDir = resolve(String(picked));
      reusedSandboxMeta = existingSandboxes.find((s) => resolve(s.dir) === sandboxDir) ?? null;
    }
  } else {
    steps.start('create temporary sandbox');
    const prefix = reviewPrSandboxPrefixPath(baseStackName);
    sandboxDir = resolve(await mkdtemp(prefix));
    createdNewSandbox = true;
    steps.stop('✓', 'create temporary sandbox');
  }

  // If we're reusing a sandbox, prefer the stack name recorded in its meta file (keeps hostname stable),
  // but only when the user did not explicitly pass --name.
  const effectiveStackName =
    !explicitName && reusedSandboxMeta?.stackName
      ? sanitizeStackName(reusedSandboxMeta.stackName, { fallback: baseStackName, maxLen: 64 })
      : newStackName;
 
  // Safety marker to ensure we only delete what we created.
  const markerPath = join(sandboxDir, '.happier-stack-sandbox-marker');
  // Always ensure the marker exists for safety; write meta only for new sandboxes.
  try {
    if (!existsSync(markerPath)) {
      await writeFile(markerPath, 'review-pr\n', 'utf-8');
    }
  } catch {
    // ignore; deletion guard will fail closed later if marker is missing
  }
  if (createdNewSandbox && existsSync(markerPath)) {
    try {
      await writeReviewPrSandboxMeta({ sandboxDir, baseStackName, stackName: effectiveStackName, argv });
    } catch {
      // ignore
    }
  }
 
  const bin = join(rootDir, 'bin', 'hstack.mjs');
 
  let child = null;
  let gotSignal = null;
  let childExitCode = null;
  const lock = workspaceCache.enabled ? await acquireWorkspaceCacheLock(workspaceCache.workspaceDir) : { ok: true, lockPath: '' };
  if (!lock.ok) {
    throw new Error(lock.error || '[review-pr] failed to acquire workspace cache lock');
  }
  const releaseWorkspaceLock = async () => {
    if (!lock.lockPath) return;
    await rm(lock.lockPath, { force: true }).catch(() => {});
  };
 
  const forwardSignal = (sig) => {
    const first = gotSignal == null;
    gotSignal = gotSignal ?? sig;
    if (first && process.stdout.isTTY && !json) {
      // eslint-disable-next-line no-console
      console.log('\n[review-pr] received Ctrl+C — cleaning up sandbox, please wait...');
    }
    try {
      child?.kill(sig);
    } catch {
      // ignore
    }
  };
 
  const onSigInt = () => forwardSignal('SIGINT');
  const onSigTerm = () => forwardSignal('SIGTERM');
  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);
 
    try {
      if (workspaceCache.enabled) {
        const updateSteps = createStepPrinter({ enabled: Boolean(process.stdout.isTTY && !json && verbosity === 0) });
        const mainDir = join(workspaceCache.workspaceDir, 'main');
        if (existsSync(join(mainDir, '.git'))) {
          const stableBranch =
            (process.env.HAPPIER_STACK_STABLE_BRANCH ?? '').trim() ||
            (await resolveDefaultRemoteBranch({ dir: mainDir, remote: 'origin' })) ||
            'main';
          const label = `update cached workspace (main:${stableBranch})`;
          updateSteps.start(label);
          try {
            const res = await fastForwardBranchToRemote({ dir: mainDir, remote: 'origin', branch: stableBranch });
            if (res.ok && (res.updated || res.reason === 'up-to-date')) {
              updateSteps.stop('✓', label);
            } else {
              updateSteps.stop('!', label);
              if (!json && res.reason && res.reason !== 'up-to-date') {
                // eslint-disable-next-line no-console
                console.warn(
                  `[review-pr] warning: could not update cached workspace main checkout (${mainDir}).\n` +
                    `Reason: ${res.reason}${res.error ? `\n${res.error}` : ''}`
                );
              }
            }
          } catch (e) {
            updateSteps.stop('!', label);
            if (!json) {
              // eslint-disable-next-line no-console
              console.warn(
                `[review-pr] warning: failed to update cached workspace main checkout (${mainDir}).\n` +
                  `${e instanceof Error ? e.message : String(e)}`
              );
            }
          }

          // Warm base dependencies in the cached workspace so new PR worktrees can seed node_modules quickly.
          // Best-effort: if it fails, PR worktrees will fall back to installing their own deps.
          const depsLabel = 'warm cached workspace deps (yarn)';
          updateSteps.start(depsLabel);
          try {
            const needs = await shouldRunYarnInstall({ installDir: mainDir, componentDir: mainDir });
            if (!needs) {
              updateSteps.stop('✓', depsLabel);
            } else {
              const pmCacheBaseDir = resolvePmCacheBaseDirFromWorkspaceDir(workspaceCache.workspaceDir);
              const env = await applyStackCacheEnv({
                ...process.env,
                HAPPIER_STACK_PM_CACHE_BASE_DIR: pmCacheBaseDir,
                HAPPIER_STACK_PM_ISOLATE_HOME: '1',
              });
              const quiet = verbosity === 0 && !json;
              try {
                await run('yarn', ['install', '--frozen-lockfile'], { cwd: mainDir, env, stdio: quiet ? 'ignore' : 'inherit' });
                updateSteps.stop('✓', depsLabel);
              } catch (e) {
                // Re-run once with logs for diagnosis, then warn and continue.
                if (quiet) {
                  try {
                    await run('yarn', ['install', '--frozen-lockfile'], { cwd: mainDir, env, stdio: 'inherit' });
                  } catch {
                    // ignore
                  }
                }
                updateSteps.stop('!', depsLabel);
                if (!json) {
                  // eslint-disable-next-line no-console
                  console.warn(
                    `[review-pr] warning: failed to warm cached workspace deps (${mainDir}).\n` +
                      `${e instanceof Error ? e.message : String(e)}`
                  );
                }
              }
            }
          } catch (e) {
            updateSteps.stop('!', depsLabel);
            if (!json) {
              // eslint-disable-next-line no-console
              console.warn(
                `[review-pr] warning: failed to warm cached workspace deps (${mainDir}).\n` +
                  `${e instanceof Error ? e.message : String(e)}`
              );
            }
          }
        }
      }

      const wantsStart = flags.has('--start') || flags.has('--prod');
      const hasMobileFlag = argv.includes('--mobile') || argv.includes('--with-mobile') || argv.includes('--no-mobile');
    const argvWithDefaults =
      process.stdout.isTTY && !json && !wantsStart && !hasMobileFlag ? [...argv, '--mobile'] : argv;

    // If the caller did not explicitly name the stack, make it unique per run.
    // This prevents browser storage collisions when sandboxes are deleted between runs.
    const hasNameFlag = argvWithDefaults.some((a) => a === '--name' || a.startsWith('--name='));
    const argvFinal = hasNameFlag ? argvWithDefaults : [...argvWithDefaults, `--name=${effectiveStackName}`];

    // Sandbox-only port overrides (useful for VM testing where host port-forwarding expects specific ranges).
    const portEnv = resolveSandboxPortEnvOverrides(argvFinal);
    const argvForSetupPr = stripArgv(argvFinal, [
      '--vm-ports',
      '--stack-port-start',
      '--expo-dev-port-strategy',
      '--expo-dev-port-base',
      '--expo-dev-port-range',
      '--expo-dev-port',
      '--workspace-cache',
      '--no-workspace-cache',
      '--workspace-cache-dir',
    ]);

    const childEnv = portEnv ? { ...process.env, ...portEnv } : { ...process.env };
    if (workspaceCache.enabled) {
      childEnv.HAPPIER_STACK_SANDBOX_WORKSPACE_DIR = workspaceCache.workspaceDir;
    } else {
      delete childEnv.HAPPIER_STACK_SANDBOX_WORKSPACE_DIR;
    }
    child = spawn(process.execPath, [bin, '--sandbox-dir', sandboxDir, 'setup-pr', ...argvForSetupPr], {
      cwd: rootDir,
      env: childEnv,
      stdio: 'inherit',
    });
 
    const { code } = await waitForExit(child);
    childExitCode = code;
    process.exitCode = code;
  } finally {
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);

    steps.start('stop sandbox processes (best-effort)');
    try {
      // Best-effort stop before deleting the sandbox.
      await tryStopSandbox({ rootDir, sandboxDir });
      steps.stop('✓', 'stop sandbox processes (best-effort)');
    } catch {
      steps.stop('x', 'stop sandbox processes (best-effort)');
      // eslint-disable-next-line no-console
      console.warn(`[review-pr] warning: failed to stop all sandbox processes. Attempting cleanup anyway.`);
    }
 
    // On failure, offer to keep the sandbox for inspection (TTY only).
    // - `--keep-sandbox` always wins (no prompt)
    // - on signals, don't prompt (just follow the normal cleanup rules)
    const keepSandbox = flags.has('--keep-sandbox');
    const failed = !json && (childExitCode ?? 0) !== 0;
    const canPromptKeep =
      failed &&
      !keepSandbox &&
      !gotSignal &&
      Boolean(process.stdout.isTTY && process.stdin.isTTY) &&
      !json;

    let keepOnFail = false;
    if (failed && !keepSandbox && !gotSignal) {
      if (canPromptKeep) {
        // Default: keep in verbose mode, delete otherwise.
        const defaultKeep = getVerbosityLevel(process.env) > 0;
        keepOnFail = await withRl(async (rl) => {
          return await promptSelect(rl, {
            title: 'Review-pr failed. Keep the sandbox for inspection?',
            options: [
              { label: 'yes (keep sandbox directory)', value: true },
              { label: 'no (delete sandbox directory)', value: false },
            ],
            defaultIndex: defaultKeep ? 0 : 1,
          });
        });
      } else {
        // Non-interactive: keep old behavior (verbose keeps, otherwise delete).
        keepOnFail = getVerbosityLevel(process.env) > 0;
      }
    }

    const shouldDeleteSandbox = !keepSandbox && !(failed && keepOnFail);

    steps.start('delete sandbox directory');
    // Only delete if marker exists (paranoia guard).
    // Note: if marker is missing, we intentionally leave the sandbox dir on disk.
    try {
      if (!existsSync(markerPath)) {
        throw new Error('missing marker');
      }
      if (!shouldDeleteSandbox) {
        steps.stop('!', 'delete sandbox directory');
        // eslint-disable-next-line no-console
        console.warn(`[review-pr] sandbox preserved at: ${sandboxDir}`);
        if (!json && (childExitCode ?? 0) !== 0) {
          // eslint-disable-next-line no-console
          console.warn(`[review-pr] tip: inspect stack wiring with:`);
          // eslint-disable-next-line no-console
          console.warn(`  npx --yes -p @happier-dev/stack hstack --sandbox-dir "${sandboxDir}" stack info ${effectiveStackName}`);
        }
      } else {
        await rm(markerPath, { force: false });
        await rm(sandboxDir, { recursive: true, force: true });
        steps.stop('✓', 'delete sandbox directory');
      }
    } catch {
      steps.stop('x', 'delete sandbox directory');
      // eslint-disable-next-line no-console
      console.warn(`[review-pr] warning: failed to delete sandbox directory: ${sandboxDir}`);
      // eslint-disable-next-line no-console
      console.warn(`[review-pr] you can remove it manually after stopping any remaining processes.`);
      // Preserve conventional exit codes on signals.
      if (gotSignal) {
        const code = gotSignal === 'SIGINT' ? 130 : gotSignal === 'SIGTERM' ? 143 : 1;
        process.exitCode = process.exitCode ?? code;
      }
      await releaseWorkspaceLock();
      return;
    }
    // Preserve conventional exit codes on signals.
    if (gotSignal) {
      const code = gotSignal === 'SIGINT' ? 130 : gotSignal === 'SIGTERM' ? 143 : 1;
      process.exitCode = process.exitCode ?? code;
    }
    await releaseWorkspaceLock();
  }
}
 
main().catch((err) => {
  console.error('[review-pr] failed:', err);
  process.exit(1);
});
 
