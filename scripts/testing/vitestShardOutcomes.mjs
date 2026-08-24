import { resolveSignalExitCode } from './process/managedChildLifecycle.mjs';

/**
 * A crashed or non-zero shard is recorded so later shards still run. Only an operator
 * interrupt stops the remaining work, which would otherwise be spawned into the same signal.
 */
export function classifyVitestShardTermination({ code, signal }) {
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

/** Produces one truthful terminal result for every shard that ran, failed, or was skipped. */
export function summarizeVitestShardOutcomes({ shardCount, outcomes, unitLabel = 'shard' }) {
  const allOutcomes = Array.from(outcomes ?? []);
  const executed = allOutcomes.filter((entry) => (
    entry.outcome === 'passed' || entry.outcome === 'failed' || entry.outcome === 'aborted'
  ));
  const failedShards = allOutcomes.filter((entry) => entry.outcome === 'failed');
  const abortedShard = allOutcomes.find((entry) => entry.outcome === 'aborted') ?? null;
  const passedCount = allOutcomes.filter((entry) => entry.outcome === 'passed').length;
  const emptyCount = allOutcomes.filter((entry) => entry.outcome === 'empty').length;
  const unexecutedCount = allOutcomes.filter((entry) => entry.outcome === 'unexecuted').length;
  const pluralLabel = `${unitLabel}s`;

  const lines = [];
  if (abortedShard) {
    lines.push(
      `[vitest] run ABORTED by ${abortedShard.signal} at ${unitLabel} ${abortedShard.shard}/${shardCount};`
      + ` ${pluralLabel} after it did not run`,
    );
  }
  lines.push(
    `[vitest] ${executed.length} ${unitLabel}(s) ran of ${shardCount}:`
    + ` ${passedCount} passed, ${failedShards.length} failed`
    + (emptyCount > 0 ? `, ${emptyCount} empty` : '')
    + (unexecutedCount > 0 ? `, ${unexecutedCount} unexecuted` : ''),
  );
  for (const entry of failedShards) {
    lines.push(
      `[vitest]   ${unitLabel} ${entry.shard}/${shardCount} FAILED`
      + (entry.signal ? ` (signal ${entry.signal})` : ` (exit ${entry.exitCode})`)
      + ` — ${entry.fileCount} file(s)`,
    );
  }

  const exitCode = abortedShard?.exitCode ?? failedShards[0]?.exitCode ?? 0;
  return {
    exitCode,
    failedShards,
    abortedShard,
    passedCount,
    executedCount: executed.length,
    emptyCount,
    unexecutedCount,
    lines,
  };
}
