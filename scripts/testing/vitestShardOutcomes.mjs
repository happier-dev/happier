import { resolveSignalExitCode } from './process/managedChildLifecycle.mjs';

/**
 * A crashed or non-zero shard is recorded so later shards still run. Only an operator
 * interrupt stops the remaining work, which would otherwise be spawned into the same signal.
 */
export function classifyVitestShardTermination({ code, signal, timedOut = false }) {
  if (timedOut === true) {
    return { outcome: 'failed', exitCode: 124, signal: signal ?? null, timedOut: true };
  }
  if (signal) {
    const interrupted = signal === 'SIGINT' || signal === 'SIGTERM' || signal === 'SIGHUP';
    return {
      outcome: interrupted ? 'aborted' : 'failed',
      exitCode: resolveSignalExitCode(signal),
      signal,
    };
  }
  if (typeof code === 'number' && code !== 0) {
    return { outcome: 'failed', exitCode: code, signal: null };
  }
  return { outcome: 'passed', exitCode: 0, signal: null };
}

/** Produces one truthful terminal result for every shard that ran. */
export function summarizeVitestShardOutcomes({ shardCount, outcomes }) {
  const executed = Array.from(outcomes ?? []);
  const failedShards = executed.filter((entry) => entry.outcome === 'failed');
  const abortedShard = executed.find((entry) => entry.outcome === 'aborted') ?? null;
  const passedCount = executed.filter((entry) => entry.outcome === 'passed').length;

  const lines = [];
  if (abortedShard) {
    lines.push(
      `[vitest] run ABORTED by ${abortedShard.signal} at shard ${abortedShard.shardSpec};`
      + ' shards after it did not run',
    );
  }
  lines.push(
    `[vitest] ${executed.length} shard(s) ran of ${shardCount}:`
    + ` ${passedCount} passed, ${failedShards.length} failed`,
  );
  for (const entry of failedShards) {
    lines.push(
      `[vitest]   shard ${entry.shardSpec} FAILED`
      + (entry.signal ? ` (signal ${entry.signal})` : ` (exit ${entry.exitCode})`),
    );
  }

  const exitCode = abortedShard?.exitCode ?? failedShards[0]?.exitCode ?? 0;
  return { exitCode, failedShards, abortedShard, passedCount, executedCount: executed.length, lines };
}
