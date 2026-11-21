import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecService, PluginProcessOutput, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { runSliceReview } from './run.js';
import { createSliceExecutionRunFactory } from './execution.js';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { activate, PLUGIN_MANIFEST } from '../../manifest.js';
import type { AgentExecutionRunEvent, AgentExecutionRunOpenRequest, AgentExecutionRunRuntimeContextV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { ReviewFindingsV2Schema } from '@happier-dev/plugin-sdk/reviews';

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

async function fixture(mode: 'success' | 'counts-only' | 'failed' | 'cancelled' = 'success', reviewCompletion?: Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'happier-slices-')); directories.push(directory);
  const controller = new AbortController();
  const state = join(directory, 'repository-a');
  const commands: string[][] = [];
  const environments: unknown[] = [];
  let selected: string[] = [];
  const exec: Pick<ExecService, 'run' | 'spawn'> = { async run(request, options) {
    const args = [...request.args ?? []]; commands.push(args); environments.push(request.env);
    expect(request.executable).toEqual({ kind: 'managedDependency', id: 'review-executable' });
    expect(options?.signal?.aborted).toBe(false);
    expect(args.slice(-5)).toEqual(['--root', directory, '--state-dir', state, '--json']);
    if (args[0] === 'init') { await mkdir(state, { recursive: true }); await writeFile(join(state, 'project.json'), '{}'); return completed({ initialized: true }); }
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
    if (mode === 'cancelled') {
      controller.abort();
      return { ...completed({}), termination: { observed: { kind: 'signal', signal: 'SIGTERM' }, requestedBy: { kind: 'abort' } } };
    }
    await reviewCompletion;
    return mode === 'failed' ? completed({}, 1, 'clawpatch review start run=native-run features=2 jobs=2\n')
      : completed({ run: 'native-run', reviewed: 2, findings: 2 });
  }, async spawn(request, options) {
    let listener: ((chunk: PluginProcessOutput) => void) | undefined;
    return { write: async () => {}, closeStdin: async () => {}, dispose: async () => {},
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
  return { directory, state, commands, environments, controller, exec, selected: () => selected,
    run: () => runSliceReview({ exec, fs: { getPluginDataDirectory: async () => state }, cwd: directory,
      stateRelativePath: 'repository-a', signal: controller.signal }) };
}

describe('native slice review', () => {
  it.each([
    { workspaceWrites: 'deny', unset: [], expected: 'read-only' },
    { workspaceWrites: 'allow', unset: [], expected: 'bypass' },
    { workspaceWrites: undefined, unset: [], expected: 'bypass' },
  ] as const)('binds the admitted $workspaceWrites policy to the native Codex sandbox', async ({ workspaceWrites, unset, expected }) => {
    const f = await fixture();
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    try {
      const factory = activation.registration('agents', 'slices')?.factory;
      if (!factory) throw new Error('Missing slice reviewer registration');
      const agent = await factory({ plugin: { id: PLUGIN_MANIFEST.id, version: '0.0.0' }, agent: { id: 'slices' }, signal: f.controller.signal });
      // Host OS/process services are the boundary; registered factory and finite flow remain real.
      const context = { agent: { id: 'slices' }, signal: f.controller.signal, services: {
        exec: f.exec, fs: { getPluginDataDirectory: async () => f.state },
      } } as unknown as AgentExecutionRunRuntimeContextV1;
      const request: AgentExecutionRunOpenRequest = { kind: 'create', runId: 'native-write-policy', cwd: f.directory,
        profile: { pluginId: 'happier.review.slices', localId: 'review' },
        configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
          permissionIntent: { value: null, updatedAtMs: 0 }, options: {}, ...(workspaceWrites ? { workspaceWrites } : {}) },
        launchEnvironment: { values: { CLAWPATCH_CODEX_SANDBOX: 'bypass', NATIVE_REVIEW_MARKER: 'retained' }, unset: [...unset] },
        input: { text: 'Review the repository', structuredInput: { scope: 'repository',
          engines: { slices: { provider: 'mock' } }, scmReviewScope: {
            scope: 'repository', status: 'supported', worktreeRoot: f.directory,
          } } } };
      const runtime = await agent.executionRuns!.open(request, context);
      try {
        const terminal = await new Promise<AgentExecutionRunEvent>(resolve => { runtime.watch(event => {
          if (event.kind === 'run-complete' || event.kind === 'run-failed') resolve(event);
        }); });
        expect(terminal.kind).toBe('run-complete');
        expect(f.commands.map(args => args[0])).toEqual(['init', 'map', 'review']);
        for (const environment of f.environments) expect(environment).toMatchObject({
          CLAWPATCH_CODEX_SANDBOX: expected, NATIVE_REVIEW_MARKER: 'retained',
        });
      } finally { await runtime.dispose(); }
    } finally { await activation.dispose(); }
  });
  it('streams both native slice starts and completions before the finite result is available', async () => {
    let releaseReview = () => {};
    const reviewCompletion = new Promise<void>(resolve => { releaseReview = resolve; });
    const f = await fixture('success', reviewCompletion);
    const context = { agent: { id: 'slices' }, signal: f.controller.signal, services: { exec: f.exec, fs: { getPluginDataDirectory: async () => f.state } } } as unknown as AgentExecutionRunRuntimeContextV1;
    const runtime = await createSliceExecutionRunFactory().open({ kind: 'create', runId: 'live-progress', cwd: f.directory,
      profile: { pluginId: 'happier.review.slices', localId: 'review' }, input: { text: 'Review the repository', structuredInput: {
        scope: 'repository', engines: { slices: { provider: 'mock' } }, scmReviewScope: {
          scope: 'repository', status: 'supported', worktreeRoot: f.directory,
        },
      } } }, context);
    const events: AgentExecutionRunEvent[] = [];
    const terminal = new Promise<void>(resolve => { runtime.watch(event => {
      events.push(event); if (event.kind === 'run-complete' || event.kind === 'run-failed') resolve();
    }); });
    try {
      await vi.waitFor(() => {
        const progress = events.filter(event => event.kind === 'output-delta' && event.channel === 'reasoning');
        expect(progress).toHaveLength(4);
        expect(progress).toMatchObject([
          { text: expect.stringContaining('slice-a (1/2)') }, { text: expect.stringContaining('slice-a (1/2)') },
          { text: expect.stringContaining('slice-b (2/2)') }, { text: expect.stringContaining('slice-b (2/2)') },
        ]);
      });
      expect(events.some(event => event.kind === 'run-complete' || event.kind === 'run-failed'
        || (event.kind === 'output-delta' && event.channel === 'assistant'))).toBe(false);
    } finally {
      releaseReview();
      await terminal;
      await runtime.dispose();
    }
    expect(events.at(-1)?.kind).toBe('run-complete');
    const output = events.find(event => event.kind === 'output-delta' && event.channel === 'assistant');
    if (!output || output.kind !== 'output-delta') throw new Error('Missing canonical review result');
    expect(ReviewFindingsV2Schema.parse(JSON.parse(output.text)).findings).toHaveLength(2);
  });
  it.each(['success', 'failed'] as const)('publishes substantive native findings for host normalization when the native result is %s', async mode => {
    const engineId = mode === 'success' ? 'happier.review.slices/slices' : 'slices';
    const f = await fixture(mode);
    const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
    const factory = activation.registration('agents', 'slices')?.factory;
    if (!factory) throw new Error('Missing slice reviewer registration');
    const agent = await factory({ plugin: { id: PLUGIN_MANIFEST.id, version: '0.0.0' }, agent: { id: engineId }, signal: f.controller.signal });
    // Only host I/O services are substituted; the runtime, scope schema and adapter remain real.
    const context = { agent: { id: engineId }, signal: f.controller.signal, services: {
      exec: f.exec, fs: { getPluginDataDirectory: async () => f.state },
      managedServices: { dependencies: { ensure: async () => ({ state: 'ready', id: 'review-executable', version: '0.8.4', sourceId: 'test' }) } },
    } } as unknown as AgentExecutionRunRuntimeContextV1;
    const request: AgentExecutionRunOpenRequest = { kind: 'create', runId: 'host-run', cwd: f.directory,
      profile: { pluginId: 'happier.review.slices', localId: 'review' }, input: { text: 'Find lost writes', structuredInput: {
        reviewers: [{ kind: 'engine', engineId }], instructions: 'Find lost writes', scope: 'repository', engines: { [engineId]: { provider: 'mock' } },
        scmReviewScope: { kind: 'review_scm_scope.v1', scope: 'repository', status: 'supported', scmBackendId: 'git', scmMode: '.git',
          repositoryRoot: f.directory, worktreeRoot: f.directory, baseRef: { source: 'unavailable', ref: null },
          selectedPaths: [], committedPaths: [], uncommittedPaths: [], changedPaths: [], diagnostics: [],
          diff: { committedAvailable: false, uncommittedAvailable: false } },
      } } };
    const runtime = await agent.executionRuns!.open(request, context);
    const events: AgentExecutionRunEvent[] = [];
    await new Promise<void>(resolve => { runtime.watch(event => {
      events.push(event); if (event.kind === 'run-complete' || event.kind === 'run-failed') resolve();
    }); });
    expect(events.at(-1)?.kind).toBe('run-complete');
    const output = events.find(event => event.kind === 'output-delta' && event.channel === 'assistant');
    if (!output || output.kind !== 'output-delta') throw new Error('Missing canonical review output');
    const review = ReviewFindingsV2Schema.parse(JSON.parse(output.text));
    expect(review.reviewOutcome).toBe(mode === 'failed' ? 'failed' : 'complete');
    expect(review.findings[0]?.extensions?.['happier.review.slices']).toMatchObject({
      nativeFindingId: 'one', featureId: 'slice-a', confidence: 'high', reproduction: 'Run two concurrent writes.',
    });
    expect(f.commands.at(-1)).toContain('--prompt-file');
    expect(f.commands.at(-1)).toEqual(expect.arrayContaining(['--provider', 'mock']));
    await runtime.dispose();
    const before = f.commands.length;
    const bound = await createSliceExecutionRunFactory().open({ ...request, providerBinding: {
      connectionId: 'selected-provider', upstream: { protocol: 'openai.responses', normalizedUrl: 'https://example.com/v1', credential: 'apiKey' },
      model: { id: 'selected-model', name: 'Selected model' }, materialization: { v: 1, kind: 'spawnEnv' },
    } }, context);
    const terminal = await new Promise<AgentExecutionRunEvent>(resolve => { bound.watch(event => {
      if (event.kind === 'run-complete' || event.kind === 'run-failed') resolve(event);
    }); });
    expect(terminal.kind).toBe('run-failed');
    expect(f.commands).toHaveLength(before);
    await bound.dispose();
    await activation.dispose();
  });
  it('explicitly reviews every active slice and joins only the selected run IDs to full finding evidence', async () => {
    const f = await fixture(); const result = await f.run();
    expect(f.selected()).toEqual(['slice-a', 'slice-b']);
    expect(result.status).toBe('completed');
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toMatchObject({ id: 'slices-1', filePath: 'slice-a.ts', startLine: 4, severity: 'blocker',
      summary: 'The write is lost before commit.', suggestion: 'Commit before returning.' });
    expect(result.findings[0]?.confidence).toBeUndefined();
    expect(result.findingEvidence[0]).toMatchObject({ runId: 'native-run', featureId: 'slice-a', confidence: 'high',
      reproduction: 'Run two concurrent writes.', suggestedRegressionTest: 'Run concurrent writers.' });
    expect(f.commands.map(args => args[0])).toEqual(['init', 'map', 'review']);
    expect(await readdir(join(f.state, 'findings'))).toContain('old.json');
  });
  it('refuses counts-only success without the full native run record', async () => {
    const f = await fixture('counts-only'); await expect(f.run()).rejects.toThrow();
  });
  it('retains substantive evidence from a failed native run without calling it a clean review', async () => {
    const f = await fixture('failed'); const result = await f.run();
    expect(result.status).toBe('failed'); expect(result.findings).toHaveLength(2);
    expect(result.errors).toEqual([{ message: 'provider unavailable', code: 'provider-failed' }]);
  });
  it('propagates local cancellation while retaining native state for retry', async () => {
    const f = await fixture('cancelled'); await expect(f.run()).rejects.toMatchObject({ name: 'AbortError' });
    expect(JSON.parse(await readFile(join(f.state, 'findings', 'one.json'), 'utf8'))).toMatchObject({ status: 'open' });
  });
});
