import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { resolveYarnCommandInvocation } from '../../../scripts/workspaces/execYarnCommand.mjs';
import { resolveProviderRunPreset } from '../src/testkit/providers/presets/presets.mjs';
import { terminateProcessTreeByPid } from './processTree.mjs';

const KNOWN_FLAGS = new Set(['--update-baselines', '--strict-keys', '--flake-retry', '--no-flake-retry']);

export function resolveProviderRunYarnInvocation(args, options = {}) {
  return resolveYarnCommandInvocation(args, options);
}

export function resolveProvidersRunTimeoutFallbackMs({ presetId, tier }) {
  // Provider suites can take a long time, especially when running multiple providers sequentially.
  // Keep the defaults bounded so smoke runs always terminalize in practical time, while still
  // allowing explicit overrides via HAPPIER_E2E_PROVIDER_RUN_TIMEOUT_MS / HAPPY_E2E_PROVIDER_RUN_TIMEOUT_MS.
  const normalizedTier = tier === 'extended' ? 'extended' : 'smoke';
  const isAll = presetId === 'all';

  if (normalizedTier === 'extended') {
    // Extended runs can legitimately be multi-hour.
    return isAll ? 6 * 60 * 60 * 1000 : 3 * 60 * 60 * 1000;
  }

  // smoke
  return isAll ? 45 * 60 * 1000 : 20 * 60 * 1000;
}

export function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  const flags = new Set();

  for (const a of args) {
    if (a.startsWith('-')) {
      if (!KNOWN_FLAGS.has(a)) throw new Error(`Unknown flag: ${a}`);
      flags.add(a);
      continue;
    }

    positional.push(a);
  }
  if (positional.length > 2) {
    throw new Error(`Unexpected positional argument: ${positional[2]}`);
  }

  const presetId = positional[0] ?? null;
  const tier = positional[1] ?? null;
  if (flags.has('--flake-retry') && flags.has('--no-flake-retry')) {
    throw new Error('Conflicting flags: --flake-retry and --no-flake-retry');
  }
  return {
    presetId,
    tier,
    updateBaselines: flags.has('--update-baselines'),
    strictKeys: flags.has('--strict-keys'),
    flakeRetry: !flags.has('--no-flake-retry'),
  };
}

export function resolveProvidersRunTimeoutMs(raw, fallbackMs = 1_800_000) {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.max(60_000, parsed);
}

function usage(exitCode, message) {
  // eslint-disable-next-line no-console
  if (message) console.error(message);
  console.error(
    [
      'Usage:',
      '  yarn providers:run <preset> <tier> [--update-baselines] [--strict-keys] [--flake-retry|--no-flake-retry]',
      '',
      'Presets: opencode | claude | codex | kilo | gemini | qwen | kimi | auggie | pi | all',
      'Tiers:   smoke | extended',
      '',
      'Examples:',
      '  yarn providers:opencode:smoke',
      '  yarn providers:codex:smoke',
      '  yarn providers:qwen:extended',
      '  yarn providers:all:smoke --strict-keys',
      '  yarn providers:opencode:smoke:update-baselines',
    ].join('\n'),
  );
  return exitCode;
}

function signalExitCode(signal) {
  return signal ? 128 : 1;
}

export async function main(argv = process.argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return usage(2, reason);
  }
  if (!parsed.presetId || !parsed.tier) return usage(2);

  const preset = resolveProviderRunPreset(parsed.presetId, parsed.tier);
  if (!preset) return usage(2);

  // Provider suites validate provider contracts (tooltrace + normalization), not DB engine behavior.
  // Prefer sqlite for stability; allow overrides via HAPPIER_E2E_DB_PROVIDER / HAPPY_E2E_DB_PROVIDER.
  const dbProviderRaw = (process.env.HAPPIER_E2E_DB_PROVIDER ?? process.env.HAPPY_E2E_DB_PROVIDER ?? '').toString().trim();

  const env = {
    ...process.env,
    ...preset.env,
    ...(dbProviderRaw ? null : { HAPPIER_E2E_DB_PROVIDER: 'sqlite', HAPPY_E2E_DB_PROVIDER: 'sqlite' }),
    ...(parsed.updateBaselines ? { HAPPIER_E2E_PROVIDER_UPDATE_BASELINES: '1' } : null),
    ...(parsed.strictKeys ? { HAPPIER_E2E_PROVIDER_STRICT_KEYS: '1' } : null),
    ...(parsed.flakeRetry ? { HAPPIER_E2E_PROVIDER_FLAKE_RETRY: '1' } : null),
  };

  const fallbackTimeoutMs = resolveProvidersRunTimeoutFallbackMs({ presetId: parsed.presetId, tier: parsed.tier });
  const timeoutMs = resolveProvidersRunTimeoutMs(
    process.env.HAPPIER_E2E_PROVIDER_RUN_TIMEOUT_MS ?? process.env.HAPPY_E2E_PROVIDER_RUN_TIMEOUT_MS,
    fallbackTimeoutMs,
  );
  if (!(env.HAPPIER_TEST_WRAPPER_TIMEOUT_MS ?? '').trim() && !(env.HAPPY_TEST_WRAPPER_TIMEOUT_MS ?? '').trim()) {
    env.HAPPIER_TEST_WRAPPER_TIMEOUT_MS = String(timeoutMs);
  }
  const activeChildren = new Set();
  let shuttingDown = false;

  async function stopActiveChildren() {
    const children = [...activeChildren];
    await Promise.all(
      children.map(async (child) => {
        if (!child?.pid) return;
        await terminateProcessTreeByPid(child.pid, { graceMs: 5_000, pollMs: 100 });
      }),
    );
  }

  async function shutdownAndExit(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await stopActiveChildren();
    } finally {
      process.exit(code);
    }
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      void shutdownAndExit(128);
    });
  }

  const invocation = resolveProviderRunYarnInvocation(['-s', 'test:providers']);
  const child = spawn(invocation.command, invocation.args, {
    stdio: 'inherit',
    env,
    detached: process.platform !== 'win32',
    ...(invocation.windowsVerbatimArguments
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  });
  activeChildren.add(child);
  child.once('exit', () => {
    activeChildren.delete(child);
  });

  const result = await new Promise((resolve) => {
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({ code });
    };

    const timeoutHandle = setTimeout(() => {
      const pid = child.pid;
      // eslint-disable-next-line no-console
      console.error(
        `[providers] timed out after ${timeoutMs}ms while running test:providers ` +
          `(preset=${parsed.presetId}, tier=${parsed.tier}). ` +
          'Set HAPPIER_E2E_PROVIDER_RUN_TIMEOUT_MS to override.',
      );
      if (!pid) {
        done(124);
        return;
      }
      void terminateProcessTreeByPid(pid, { graceMs: 5_000, pollMs: 100 })
        .catch(() => undefined)
        .finally(() => done(124));
    }, timeoutMs);

    child.once('error', () => {
      activeChildren.delete(child);
      done(1);
    });
    child.once('exit', (code, signal) => {
      done(code ?? signalExitCode(signal));
    });
  });

  await shutdownAndExit(result.code ?? 1);
  return result.code ?? 1;
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  main()
    .then((code) => {
      if (typeof code === 'number' && Number.isFinite(code) && code !== 0) process.exit(code);
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    });
}
