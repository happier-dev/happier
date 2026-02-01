import './utils/env/env.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
 
function usage() {
  return [
    '[review-pr] usage:',
    '  hapsta tools review-pr --repo=<pr-url|number> [--name=<stack>] [--dev|--start] [--mobile|--no-mobile] [--forks|--upstream] [--seed-auth|--no-seed-auth] [--copy-auth-from=<stack>] [--link-auth|--copy-auth] [--update] [--force] [--keep-sandbox] [--json] [-- <stack dev/start args...>]',
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
    '- runs `hapsta tools setup-pr ...` inside that sandbox (fully isolated state)',
    '- on exit (including Ctrl+C): stops sandbox processes and deletes the sandbox dir',
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
  const bin = join(rootDir, 'bin', 'hapsta.mjs');
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

  if (process.stdout.isTTY && !json) {
    const intro = [
      '',
      '',
      bold(`✨ ${cyan('Hapsta')} review-pr ✨`),
      '',
      'It will help you review a PR for Happier in a completely isolated environment.',
      dim('Uses the light server flavor by default (no Redis, no Postgres, no Docker).'),
      dim('Desktop browser + optional mobile review (Expo dev-client).'),
      '',
      bold('What will happen:'),
      `- ${cyan('sandbox')}: temporary isolated Happier install`,
      `- ${cyan('repos')}: clone/install (inside the sandbox only)`,
      `- ${cyan('start')}: start the Happier stack in sandbox (server, daemon, web, mobile)`,
      `- ${cyan('login')}: guide you through Happier login for this sandbox`,
      `- ${cyan('browser')}: open the Happier web app`,
      `- ${cyan('mobile')}: start Expo dev-client (optional)`,
      `- ${cyan('cleanup')}: stop processes + delete sandbox on exit`,
      '',
      dim('Everything is deleted automatically when you exit.'),
      dim('Your main Happier installation remains untouched.'),
      '',
      dim('Tips:'),
      dim('- Add `-v` / `-vv` / `-vvv` to show the full logs'),
      dim('- Add `--keep-sandbox` to keep the sandbox directory between runs'),
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
 
  const bin = join(rootDir, 'bin', 'hapsta.mjs');
 
  let child = null;
  let gotSignal = null;
  let childExitCode = null;
 
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
    ]);

    child = spawn(process.execPath, [bin, '--sandbox-dir', sandboxDir, 'setup-pr', ...argvForSetupPr], {
      cwd: rootDir,
      env: portEnv ? { ...process.env, ...portEnv } : process.env,
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
          console.warn(`  npx --yes -p @happier-dev/stack hapsta --sandbox-dir "${sandboxDir}" stack info ${effectiveStackName}`);
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
      return;
    }
    // Preserve conventional exit codes on signals.
    if (gotSignal) {
      const code = gotSignal === 'SIGINT' ? 130 : gotSignal === 'SIGTERM' ? 143 : 1;
      process.exitCode = process.exitCode ?? code;
    }
  }
}
 
main().catch((err) => {
  console.error('[review-pr] failed:', err);
  process.exit(1);
});
 
