import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  filterProviderIdsForScenarioSelection,
  parseMaxParallel,
  parseScenarioSelection,
  resolveProviderPresetIds,
} from '../src/testkit/providers/presets.mjs';
import { terminateProcessTreeByPid } from './processTree.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../../..');

export function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  let maxParallelRaw;
  let retrySerial = true;
  const flags = new Set();
  const knownFlags = new Set([
    '--update-baselines',
    '--strict-keys',
    '--flake-retry',
    '--no-flake-retry',
    '--no-retry-serial',
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--max-parallel') {
      maxParallelRaw = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--no-retry-serial') {
      retrySerial = false;
      continue;
    }
    if (arg.startsWith('-')) {
      if (!knownFlags.has(arg)) throw new Error(`Unknown flag: ${arg}`);
      flags.add(arg);
      continue;
    }
    positional.push(arg);
  }

  if (flags.has('--flake-retry') && flags.has('--no-flake-retry')) {
    throw new Error('Conflicting flags: --flake-retry and --no-flake-retry');
  }
  return {
    presetId: positional[0] ?? null,
    tier: positional[1] ?? null,
    maxParallelRaw,
    retrySerial,
    updateBaselines: flags.has('--update-baselines'),
    strictKeys: flags.has('--strict-keys'),
    flakeRetry: !flags.has('--no-flake-retry'),
  };
}

function usage(exitCode) {
  // eslint-disable-next-line no-console
  console.error(
    [
      'Usage:',
      '  yarn providers:run:parallel <preset> <tier> [--max-parallel N] [--update-baselines] [--strict-keys] [--flake-retry|--no-flake-retry] [--no-retry-serial]',
      '',
      'Presets: opencode | claude | codex | kilo | gemini | qwen | kimi | auggie | all',
      'Tiers:   smoke | extended',
      '',
      'Notes:',
      '  - Default max parallel: 4',
      '  - Failures are retried serially once by default (disable with --no-retry-serial)',
      '  - Serial retry first targets failed scenario tail (failed scenario -> end of tier)',
      '',
      'Examples:',
      '  yarn providers:run:parallel all extended',
      '  yarn providers:run:parallel all extended --max-parallel 5',
      '  yarn providers:run:parallel opencode extended --strict-keys',
    ].join('\n'),
  );
  return exitCode;
}

function yarnCommand() {
  return process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
}

function signalExitCode(signal) {
  return signal ? 128 : 1;
}

function resolveDbProviderForServerGenerate(baseEnv) {
  const raw = (baseEnv.HAPPIER_E2E_DB_PROVIDER ?? baseEnv.HAPPY_E2E_DB_PROVIDER ?? '').toString().trim().toLowerCase();
  if (raw === 'postgres' || raw === 'postgresql') return 'postgres';
  if (raw === 'mysql') return 'mysql';
  if (raw === 'sqlite') return 'sqlite';
  return 'pglite';
}

export async function filterProviderIdsByScenarioRegistry(params) {
  const providerIds = Array.isArray(params.providerIds) ? params.providerIds : [];
  if (providerIds.length === 0) return [];

  const scenarioSelection = parseScenarioSelection(params.scenarioSelectionRaw);
  if (scenarioSelection.length === 0) return [...providerIds];

  const filtered = [];
  for (const providerId of providerIds) {
    const scenariosPath = resolve(
      REPO_ROOT,
      'apps',
      'cli',
      'src',
      'backends',
      providerId,
      'e2e',
      'providerScenarios.json',
    );

    const raw = await readFile(scenariosPath, 'utf8').catch(() => null);
    if (!raw) {
      filtered.push(providerId);
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      filtered.push(providerId);
      continue;
    }

    const tierIds = parsed?.tiers?.[params.tier];
    if (!Array.isArray(tierIds)) {
      filtered.push(providerId);
      continue;
    }

    const hasAnySelectedScenario = scenarioSelection.some((scenarioId) => tierIds.includes(scenarioId));
    if (hasAnySelectedScenario) filtered.push(providerId);
  }

  return filtered.length > 0 ? filtered : [...providerIds];
}

function buildProviderRunArgs(params) {
  const args = ['-s', 'providers:run', params.providerId, params.tier];
  if (params.updateBaselines) args.push('--update-baselines');
  if (params.strictKeys) args.push('--strict-keys');
  if (!params.flakeRetry) args.push('--no-flake-retry');
  return args;
}

export function parseFailureReportJson(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const report = parsed;
  if (report.v !== 1) return null;
  if (typeof report.providerId !== 'string' || report.providerId.length === 0) return null;
  if (typeof report.scenarioId !== 'string' || report.scenarioId.length === 0) return null;
  if (typeof report.error !== 'string' || report.error.length === 0) return null;
  if (typeof report.ts !== 'number' || !Number.isFinite(report.ts)) return null;
  return {
    v: 1,
    providerId: report.providerId,
    scenarioId: report.scenarioId,
    error: report.error,
    ts: report.ts,
  };
}

export function resolveRetryScenarioIds(params) {
  const failed = typeof params.failedScenarioId === 'string' ? params.failedScenarioId.trim() : '';
  if (!failed) return null;
  const ordered = Array.isArray(params.orderedScenarioIds) ? params.orderedScenarioIds : [];
  const clean = ordered
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const index = clean.indexOf(failed);
  if (index < 0) return null;
  return clean.slice(index);
}

async function readFailureReport(reportPath) {
  const raw = await readFile(reportPath, 'utf8').catch(() => null);
  if (!raw) return null;
  return parseFailureReportJson(raw);
}

function createRunnerState() {
  return {
    activeChildren: new Set(),
    shuttingDown: false,
  };
}

export function buildProviderChildEnv(params) {
  const scenarioSelection = Array.isArray(params.scenarioIds) ? params.scenarioIds.join(',') : '';
  return {
    ...params.baseEnv,
    HAPPIER_E2E_PROVIDER_FAILURE_REPORT_PATH: params.reportPath,
    HAPPY_E2E_PROVIDER_FAILURE_REPORT_PATH: params.reportPath,
    // Parallel workers should not trigger preflight rebuilds independently. Use one shared dist snapshot.
    HAPPIER_E2E_PROVIDER_ALLOW_CLI_PREBUILD_REBUILD: '0',
    HAPPY_E2E_PROVIDER_ALLOW_CLI_PREBUILD_REBUILD: '0',
    // Prisma provider generation writes into a shared generated directory. Run it once in parent process.
    HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1',
    HAPPY_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1',
    ...(scenarioSelection.length > 0
      ? {
          HAPPIER_E2E_PROVIDER_SCENARIOS: scenarioSelection,
          HAPPY_E2E_PROVIDER_SCENARIOS: scenarioSelection,
        }
      : null),
  };
}

async function stopActiveChildren(state) {
  const children = [...state.activeChildren];
  await Promise.all(
    children.map(async (child) => {
      if (!child?.pid) return;
      await terminateProcessTreeByPid(child.pid, { graceMs: 5_000, pollMs: 100 });
    }),
  );
}

async function shutdown(state) {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  await stopActiveChildren(state);
}

async function runProvider(params, state) {
  const reportDir = await mkdtemp(join(tmpdir(), 'happier-provider-failure-'));
  const reportPath = join(reportDir, 'failure-report.json');
  return new Promise((resolveResult) => {
    const startedAt = Date.now();
    const child = spawn(yarnCommand(), buildProviderRunArgs(params), {
      stdio: 'inherit',
      env: buildProviderChildEnv({
        baseEnv: process.env,
        reportPath,
        scenarioIds: params.scenarioIds ?? null,
      }),
      detached: process.platform !== 'win32',
    });
    state.activeChildren.add(child);

    const finalize = async (code, signal) => {
      state.activeChildren.delete(child);
      const failureReport = await readFailureReport(reportPath);
      await rm(reportDir, { recursive: true, force: true }).catch(() => undefined);
      resolveResult({
        providerId: params.providerId,
        code: code ?? signalExitCode(signal),
        signal: signal ?? null,
        elapsedMs: Date.now() - startedAt,
        failureReport,
      });
    };

    child.on('error', () => {
      void finalize(1, null);
    });
    child.on('exit', (code, signal) => {
      void finalize(code, signal);
    });
  });
}

async function prewarmServerGenerateProviders(state) {
  const env = {
    ...process.env,
    CI: '1',
    PORT: '0',
    PUBLIC_URL: 'http://127.0.0.1:0',
    DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/postgres?sslmode=disable',
    HAPPIER_BUILD_DB_PROVIDERS: resolveDbProviderForServerGenerate(process.env),
  };

  await new Promise((resolveResult, rejectResult) => {
    const child = spawn(yarnCommand(), ['-s', 'workspace', '@happier-dev/server', 'generate:providers'], {
      stdio: 'inherit',
      env,
      detached: process.platform !== 'win32',
    });
    state.activeChildren.add(child);
    child.once('exit', () => state.activeChildren.delete(child));
    child.once('error', (error) => rejectResult(error));
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveResult(undefined);
        return;
      }
      rejectResult(new Error(`server generate:providers failed (code=${code ?? 'null'}, signal=${signal ?? 'none'})`));
    });
  });
}

async function runWithConcurrency(params, state) {
  const queue = [...params.providerIds];
  const results = [];

  const workers = Array.from({ length: Math.min(params.maxParallel, queue.length) }, async () => {
    while (queue.length > 0) {
      if (state.shuttingDown) break;
      const providerId = queue.shift();
      if (!providerId) break;
      // eslint-disable-next-line no-console
      console.log(`[providers:parallel] start ${providerId} (${params.tier})`);
      const result = await runProvider(
        {
          providerId,
          tier: params.tier,
          updateBaselines: params.updateBaselines,
          strictKeys: params.strictKeys,
          flakeRetry: params.flakeRetry,
        },
        state,
      );
      // eslint-disable-next-line no-console
      console.log(
        `[providers:parallel] done ${providerId} code=${result.code} elapsed=${Math.round(result.elapsedMs / 1000)}s`,
      );
      results.push(result);
    }
  });

  await Promise.all(workers);
  return results;
}

async function loadOrderedScenarioIdsForRetry(params) {
  const explicitSelectionRaw = (
    process.env.HAPPIER_E2E_PROVIDER_SCENARIOS ??
    process.env.HAPPY_E2E_PROVIDER_SCENARIOS ??
    ''
  ).trim();
  const explicitSelection = parseScenarioSelection(explicitSelectionRaw);
  if (explicitSelection.length > 0) return explicitSelection;

  const scenariosPath = resolve(
    REPO_ROOT,
    'apps',
    'cli',
    'src',
    'backends',
    params.providerId,
    'e2e',
    'providerScenarios.json',
  );
  const raw = await readFile(scenariosPath, 'utf8').catch(() => null);
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const list = parsed?.tiers?.[params.tier];
  if (!Array.isArray(list)) return null;
  return list
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export async function main(argv = process.argv) {
  const parsed = parseArgs(argv);
  if (!parsed.presetId || !parsed.tier) return usage(2);

  const resolvedProviderIds = resolveProviderPresetIds(parsed.presetId);
  if (!resolvedProviderIds) return usage(2);
  if (parsed.tier !== 'smoke' && parsed.tier !== 'extended') return usage(2);

  const maxParallel = parseMaxParallel(parsed.maxParallelRaw, 4);
  if (!maxParallel) return usage(2);

  const providerIdsPre = filterProviderIdsForScenarioSelection(
    resolvedProviderIds,
    process.env.HAPPIER_E2E_PROVIDER_SCENARIOS,
  );
  const providerIds = await filterProviderIdsByScenarioRegistry({
    providerIds: providerIdsPre,
    tier: parsed.tier,
    scenarioSelectionRaw:
      process.env.HAPPIER_E2E_PROVIDER_SCENARIOS ?? process.env.HAPPY_E2E_PROVIDER_SCENARIOS ?? '',
  });
  if (providerIds.length === 0) return usage(2);

  const state = createRunnerState();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      if (state.shuttingDown) return;
      state.shuttingDown = true;
      void stopActiveChildren(state).finally(() => process.exit(128));
    });
  }

  try {
    await prewarmServerGenerateProviders(state);

    const initial = await runWithConcurrency(
      {
        providerIds,
        tier: parsed.tier,
        maxParallel,
        updateBaselines: parsed.updateBaselines,
        strictKeys: parsed.strictKeys,
        flakeRetry: parsed.flakeRetry,
      },
      state,
    );

    const initialFailures = initial.filter((item) => item.code !== 0);
    if (!parsed.retrySerial || initialFailures.length === 0) {
      return initialFailures.length === 0 ? 0 : 1;
    }

    // eslint-disable-next-line no-console
    console.log(`[providers:parallel] retrying ${initialFailures.length} provider(s) serially`);

    const retryFailures = [];
    for (const failed of initialFailures) {
      if (state.shuttingDown) break;
      const providerId = failed.providerId;
      const failedScenarioId =
        failed.failureReport && failed.failureReport.providerId === providerId
          ? failed.failureReport.scenarioId
          : null;

      let targetedRetrySucceeded = false;
      if (typeof failedScenarioId === 'string' && failedScenarioId.length > 0) {
        const orderedScenarioIds = await loadOrderedScenarioIdsForRetry({
          providerId,
          tier: parsed.tier,
        });
        const tailScenarioIds = resolveRetryScenarioIds({
          orderedScenarioIds: orderedScenarioIds ?? [],
          failedScenarioId,
        });
        const scenarioIds = tailScenarioIds && tailScenarioIds.length > 0 ? tailScenarioIds : [failedScenarioId];
        // eslint-disable-next-line no-console
        console.log(`[providers:parallel] retry start ${providerId} scenarios=${scenarioIds.join(',')}`);
        const retry = await runProvider(
          {
            providerId,
            tier: parsed.tier,
            updateBaselines: parsed.updateBaselines,
            strictKeys: parsed.strictKeys,
            flakeRetry: parsed.flakeRetry,
            scenarioIds,
          },
          state,
        );
        // eslint-disable-next-line no-console
        console.log(
          `[providers:parallel] retry done ${providerId} code=${retry.code} elapsed=${Math.round(retry.elapsedMs / 1000)}s`,
        );
        if (retry.code === 0) {
          targetedRetrySucceeded = true;
        } else {
          // eslint-disable-next-line no-console
          console.log(`[providers:parallel] targeted retry failed for ${providerId}; falling back to full provider retry`);
        }
      }

      if (targetedRetrySucceeded) continue;

      // eslint-disable-next-line no-console
      console.log(`[providers:parallel] retry start ${providerId}`);
      const retry = await runProvider(
        {
          providerId,
          tier: parsed.tier,
          updateBaselines: parsed.updateBaselines,
          strictKeys: parsed.strictKeys,
          flakeRetry: parsed.flakeRetry,
        },
        state,
      );
      // eslint-disable-next-line no-console
      console.log(
        `[providers:parallel] retry done ${providerId} code=${retry.code} elapsed=${Math.round(retry.elapsedMs / 1000)}s`,
      );
      if (retry.code !== 0) retryFailures.push(providerId);
    }

    return retryFailures.length === 0 ? 0 : 1;
  } finally {
    await shutdown(state);
  }
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
  main()
    .then((code) => {
      if (typeof code === 'number' && Number.isFinite(code)) process.exit(code);
      process.exit(1);
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    });
}
