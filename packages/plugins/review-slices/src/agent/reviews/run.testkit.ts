import { afterEach, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecService, PluginProcessOutput, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { runClawpatchReview } from './run.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function completed(value: unknown, exitCode = 0, stderr = ''): PluginProcessResult {
  return { termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } },
    stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.from(stderr), stdoutTruncated: false, stderrTruncated: false };
}

// Published 0.8.4 native state shape, with distinct evidence for two slices and unrelated history.
function finding(id: string, featureId: string) {
  return { schemaVersion: 1, findingId: id, featureId, title: `Defect ${id}`, category: 'bug', severity: 'critical',
    confidence: 'high', evidence: [{ path: `${featureId}.ts`, startLine: 4, endLine: 6, symbol: 'run', quote: 'lost write' }],
    reasoning: 'The write is lost before commit.', reproduction: 'Run two concurrent writes.', recommendation: 'Commit before returning.',
    whyTestsDoNotAlreadyCoverThis: 'Only one writer is exercised.', suggestedRegressionTest: 'Run concurrent writers.',
    minimumFixScope: 'transaction', status: 'open', signature: id, linkedPatchAttemptIds: [], createdByRunId: 'native-run',
    createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z' };
}

export async function createClawpatchProcessFixture(mode: 'success' | 'counts-only' | 'failed' = 'success', reviewCompletion?: Promise<void>, cleanupFailure = false) {
  const directory = await mkdtemp(join(tmpdir(), 'happier-clawpatch-')); directories.push(directory);
  const controller = new AbortController();
  const state = join(directory, 'repository-a');
  const commands: string[][] = [];
  const environments: unknown[] = [];
  const configs: unknown[] = [];
  let selected: string[] = [];
  let pausedReview: (() => void) | undefined;
  const pauseNextReview = () => new Promise<void>(resolve => { pausedReview = resolve; });
  const exec: Pick<ExecService, 'run' | 'spawn'> = { async run(request, options) {
    const args = [...request.args ?? []]; commands.push(args); environments.push(request.env);
    if (args.includes('--config')) configs.push(JSON.parse(await readFile(args[args.indexOf('--config') + 1]!, 'utf8')));
    expect(request.executable).toEqual({ kind: 'managedDependency', id: 'review-executable' });
    expect(options?.signal?.aborted).toBe(false);
    expect(args.slice(-5)).toEqual(['--root', directory, '--state-dir', state, '--json']);
    if (args[0] === 'init') {
      await mkdir(state, { recursive: true }); await writeFile(join(state, 'project.json'), '{}');
      await writeFile(join(state, 'config.json'), JSON.stringify({ schemaVersion: 1, provider: { name: 'codex', model: null },
        review: { preservedNativeSetting: true } }));
      return completed({ initialized: true });
    }
    if (args[0] === 'map') {
      await mkdir(join(state, 'features'), { recursive: true });
      for (const featureId of ['slice-a', 'slice-b', 'stale']) await writeFile(join(state, 'features', `${featureId}.json`),
        JSON.stringify({ schemaVersion: 1, featureId, status: featureId === 'stale' ? 'skipped' : 'reviewed' }));
      return completed({ features: 2 });
    }
    expect(args[0]).toBe('review');
    selected = (await readFile(args[args.indexOf('--feature-list') + 1]!, 'utf8')).trim().split('\n');
    await mkdir(join(state, 'runs'), { recursive: true });
    await mkdir(join(state, 'findings'), { recursive: true });
    for (const [id, slice] of [['one', 'slice-a'], ['two', 'slice-b'], ['old', 'stale']]) {
      await writeFile(join(state, 'findings', `${id}.json`), JSON.stringify(finding(id!, slice!)));
    }
    if (mode !== 'counts-only') await writeFile(join(state, 'runs', 'native-run.json'), JSON.stringify({
      schemaVersion: 1, runId: 'native-run', status: mode === 'failed' ? 'failed' : 'completed',
      claimedFeatureIds: ['slice-a', 'slice-b'], findingIds: ['one', 'two'], errors: mode === 'failed' ? [{ message: 'provider unavailable', code: 'provider-failed' }] : [],
    }));
    if (pausedReview) {
      const started = pausedReview;
      pausedReview = undefined;
      // The native process boundary observes the runtime's local Stop signal.
      await new Promise<void>(resolve => {
        options!.signal!.addEventListener('abort', () => resolve(), { once: true });
        started();
      });
      return { ...completed({}), termination: { observed: { kind: 'signal', signal: 'SIGTERM' }, requestedBy: { kind: 'abort' } } };
    }
    await reviewCompletion;
    return mode === 'failed' ? completed({}, 1, 'clawpatch review start run=native-run features=2 jobs=2\n')
      : completed({ run: 'native-run', reviewed: 2, findings: 2 });
  }, async spawn(request, options) {
    let listener: ((chunk: PluginProcessOutput) => void) | undefined;
    return { write: async () => {}, closeStdin: async () => {}, dispose: async () => { if (cleanupFailure) throw new Error('OS cleanup failed'); },
      waitForExit: async () => completed({}).termination,
      onOutput(callback) { listener = callback; return { dispose() { listener = undefined; } }; },
      async wait() {
        // Published 0.8.4 stderr progress is independent of final stdout JSON.
        // Byte chunks exercise event framing rather than assuming one line per chunk.
        const bytes = Buffer.from('clawpatch review feature-start index=1 total=2 feature=slice-a title=First slice\n'
          + 'clawpatch review feature-done index=1 total=2 feature=slice-a findings=1 elapsed=1s\n'
          + 'clawpatch review feature-start index=2 total=2 feature=slice-b title=Second slice\n'
          + 'clawpatch review feature-done index=2 total=2 feature=slice-b findings=1 elapsed=1s\n');
        for (let offset = 0; offset < bytes.length; offset++) {
          listener?.({ sequence: offset, stream: 'stderr', data: bytes.subarray(offset, offset + 1) });
        }
        return exec.run(request, options);
      },
    };
  } };
  return { directory, state, commands, environments, configs, controller, exec, pauseNextReview, selected: () => selected,
    run: () => runClawpatchReview({ exec, fs: { getPluginDataDirectory: async () => state }, cwd: directory,
      stateRelativePath: 'repository-a', signal: controller.signal }) };
}
