#!/usr/bin/env node
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runManagedChildCommand } from '../../../scripts/testing/process/managedChildLifecycle.mjs';
import {
  classifyVitestShardTermination,
  summarizeVitestShardOutcomes,
} from '../../../scripts/testing/vitestShardOutcomes.mjs';
import { resolveMaxOldSpaceSizeMb, upsertMaxOldSpaceSize } from './withNodeHeapLimit.mjs';

function parsePositiveInt(raw) {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveVitestShardCount(env, configPath = null) {
  const override = parsePositiveInt(env?.HAPPIER_CLI_VITEST_SHARDS);
  if (override !== null) return override;
  return typeof configPath === 'string' && basename(configPath) === 'vitest.config.ts' ? 64 : 8;
}

export function resolveVitestMaxWorkers(env, configPath = null) {
  if (typeof configPath !== 'string' || basename(configPath) !== 'vitest.config.ts') return null;
  return parsePositiveInt(env?.HAPPIER_CLI_VITEST_MAX_WORKERS) ?? 2;
}

export function resolveVitestWorkerArgs(env, configPath = null) {
  const maxWorkers = resolveVitestMaxWorkers(env, configPath);
  return maxWorkers === null ? [] : ['--maxWorkers', String(maxWorkers)];
}

export function resolveVitestShardRange(env, shardCount) {
  const part = parsePositiveInt(env?.HAPPIER_CLI_VITEST_PART);
  const parts = parsePositiveInt(env?.HAPPIER_CLI_VITEST_PARTS);
  if (part === null || parts === null || part > parts || parts > shardCount) {
    return { start: 1, end: shardCount, part: 1, parts: 1 };
  }
  const start = Math.floor(((part - 1) * shardCount) / parts) + 1;
  const end = Math.floor((part * shardCount) / parts);
  return { start, end, part, parts };
}

export function resolveVitestIsolationPlan(configPath) {
  if (typeof configPath !== 'string' || basename(configPath) !== 'vitest.config.ts') {
    return { shardExcludes: [], runs: [] };
  }
  const daemonServiceFile = 'src/daemon/service/cli.test.ts';
  const sessionHandoffFile = 'src/api/machine/rpcHandlers.sessionHandoff.test.ts';
  const unifiedTranscriptBridgeFile = 'src/backends/claude/unifiedTerminal/createClaudeUnifiedTranscriptBridge.test.ts';
  const sessionScannerFile = 'src/backends/claude/utils/sessionScanner.test.ts';
  const codexAppServerRuntimeFile = 'src/backends/codex/appServer/runtime.test.ts';
  const sessionClientEphemeralSendOutcomeFile = 'src/api/session/sessionClient.ephemeralSendOutcome.test.ts';
  const processTreeFile = 'src/agent/runtime/process/killProcessTree.test.ts';
  const acpDisposeProcessTreeFile = 'src/agent/acp/__tests__/AcpBackend.dispose.killsProcessTree.test.ts';
  const acpProbeProcessTreeFile = 'src/capabilities/probes/acpProbe.processTreeCleanup.test.ts';
  const piBrokerPreflightFile = 'src/backends/pi/rpc/PiRpcBackend.brokerPreflight.test.ts';
  const piPendingTurnLifecycleFile = 'src/backends/pi/rpc/PiRpcBackend.pendingTurnLifecycle.test.ts';
  const claudeSignalCleanupFile = 'src/backends/claude/sdk/query.signalCleanup.test.ts';
  const codexAppServerClientFile = 'src/backends/codex/appServer/client/createCodexAppServerClient.test.ts';
  const processRunStateFile = 'src/daemon/processRunState.test.ts';
  return {
    shardExcludes: [
      daemonServiceFile,
      sessionHandoffFile,
      unifiedTranscriptBridgeFile,
      sessionScannerFile,
      codexAppServerRuntimeFile,
      sessionClientEphemeralSendOutcomeFile,
      processTreeFile,
      acpDisposeProcessTreeFile,
      acpProbeProcessTreeFile,
      piBrokerPreflightFile,
      piPendingTurnLifecycleFile,
      claudeSignalCleanupFile,
      codexAppServerClientFile,
      processRunStateFile,
    ],
    runs: [
      { file: daemonServiceFile, testNamePattern: 'runDaemonServiceCliCommand (?:allows|expands|prefers|resolves|restarts|restores|sets|treats)\\b' },
      { file: daemonServiceFile, testNamePattern: 'runDaemonServiceCliCommand (?:defaults|fails|plans|refreshes|reports|stops|supports|uses)\\b' },
      { file: daemonServiceFile, testNamePattern: 'runDaemonServiceCliCommand (?:builds|includes|keeps|passes|rejects|respects|scopes|uninstalls)\\b' },
      { file: sessionHandoffFile, testNamePattern: '^rpcHandlers \\(session handoff\\) (?:aborts|acknowledges|applies|claims|classifies|delegates|does|durably)\\b' },
      { file: sessionHandoffFile, testNamePattern: '^rpcHandlers \\(session handoff\\) (?:fails|keeps)\\b' },
      { file: sessionHandoffFile, testNamePattern: '^rpcHandlers \\(session handoff\\) (?:maps|normalizes|omits|passes|persists|prefers|propagates|publishes|recovers|registers|rejects|retries)\\b' },
      { file: sessionHandoffFile, testNamePattern: '^rpcHandlers \\(session handoff\\) (?:returns|reuses|serves|starts|stops|surfaces|tracks|uses|waits)\\b' },
      { file: unifiedTranscriptBridgeFile, testNamePattern: '.*' },
      { file: sessionScannerFile, testNamePattern: '.*' },
      { file: codexAppServerRuntimeFile, testNamePattern: '.*' },
      { file: sessionClientEphemeralSendOutcomeFile, testNamePattern: '.*' },
      { file: processTreeFile, testNamePattern: '.*' },
      { file: acpDisposeProcessTreeFile, testNamePattern: '.*' },
      { file: acpProbeProcessTreeFile, testNamePattern: '.*' },
      { file: piBrokerPreflightFile, testNamePattern: '.*' },
      { file: piPendingTurnLifecycleFile, testNamePattern: '.*' },
      { file: claudeSignalCleanupFile, testNamePattern: '.*' },
      { file: codexAppServerClientFile, testNamePattern: '.*' },
      { file: processRunStateFile, testNamePattern: '.*' },
    ],
  };
}

export function resolveVitestConfigPath(argv) {
  const idx = argv.indexOf('--config');
  if (idx === -1) return null;
  const value = argv[idx + 1];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function spawnVitest({ args, nodeOptions }) {
  return runManagedChildCommand({
    command: 'vitest',
    args,
    spawnOptions: {
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptions,
      },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
    cleanupPollMs: 25,
    signalCleanupGraceMs: 0,
    exitCleanupGraceMs: 1_000,
    parentWatchdogPollMs: Number.parseInt(process.env.HAPPIER_TEST_PARENT_WATCHDOG_MS ?? '1000', 10),
  });
}

export async function runCliVitestShardRuns({ shardCount, startShard = 1, endShard = shardCount, runShard }) {
  const outcomes = [];
  let aborted = false;

  for (let shard = startShard; shard <= endShard; shard += 1) {
    if (aborted) {
      outcomes.push({ outcome: 'unexecuted', shard, fileCount: 1, exitCode: null, signal: null });
      continue;
    }

    const result = await runShard({ shard });
    if (!result.ok) throw result.error;
    const termination = classifyVitestShardTermination(result);
    outcomes.push({ ...termination, shard, fileCount: 1 });
    aborted = termination.outcome === 'aborted';
  }

  return outcomes;
}

async function main(argv) {
  const configPath = resolveVitestConfigPath(argv);
  if (!configPath) {
    // eslint-disable-next-line no-console
    console.error('Usage: node scripts/runVitestShards.mjs --config <vitest.config.ts>');
    process.exit(1);
  }

  const shardCount = resolveVitestShardCount(process.env, configPath);
  const workerArgs = resolveVitestWorkerArgs(process.env, configPath);
  const shardRange = resolveVitestShardRange(process.env, shardCount);
  const isolationPlan = shardRange.part === 1
    ? resolveVitestIsolationPlan(configPath)
    : { shardExcludes: resolveVitestIsolationPlan(configPath).shardExcludes, runs: [] };
  const sizeMb = resolveMaxOldSpaceSizeMb(process.env);
  const nodeOptions = upsertMaxOldSpaceSize(process.env.NODE_OPTIONS, sizeMb);

  const shardOutcomes = await runCliVitestShardRuns({
    shardCount,
    startShard: shardRange.start,
    endShard: shardRange.end,
    runShard: ({ shard }) => {
      // eslint-disable-next-line no-console
      console.log(`[vitest] shard ${shard}/${shardCount}`);
      return spawnVitest({
        args: [
          'run',
          '--config',
          configPath,
          '--shard',
          `${shard}/${shardCount}`,
          ...workerArgs,
          ...isolationPlan.shardExcludes.flatMap((exclude) => ['--exclude', exclude]),
        ],
        nodeOptions,
      });
    },
  });
  const shardSummary = summarizeVitestShardOutcomes({ shardCount, outcomes: shardOutcomes });
  for (const line of shardSummary.lines) {
    // eslint-disable-next-line no-console
    console.log(line);
  }
  if (shardSummary.abortedShard) {
    process.exit(shardSummary.exitCode);
    return;
  }

  const isolatedOutcomes = await runCliVitestShardRuns({
    shardCount: isolationPlan.runs.length,
    runShard: ({ shard }) => {
      const isolatedRun = isolationPlan.runs[shard - 1];
      // eslint-disable-next-line no-console
      console.log(`[vitest] isolated ${isolatedRun.file} (${isolatedRun.testNamePattern})`);
      return spawnVitest({
        args: [
          'run',
          '--config',
          configPath,
          isolatedRun.file,
          '--testNamePattern',
          isolatedRun.testNamePattern,
          ...workerArgs,
        ],
        nodeOptions,
      });
    },
  });
  const isolatedSummary = summarizeVitestShardOutcomes({
    shardCount: isolationPlan.runs.length,
    outcomes: isolatedOutcomes,
    unitLabel: 'isolated run',
  });
  for (const line of isolatedSummary.lines) {
    // eslint-disable-next-line no-console
    console.log(line);
  }

  const exitCode = shardSummary.exitCode || isolatedSummary.exitCode;
  if (exitCode !== 0) process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // eslint-disable-next-line no-void
  void main(process.argv);
}
