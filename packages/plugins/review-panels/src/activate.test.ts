import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentExecutionRunEvent, AgentExecutionRunOpenRequest, AgentRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { ExecService, PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import { ReviewFindingsV2Schema } from '@happier-dev/plugin-sdk/reviews';
import { describe, expect, it, vi } from 'vitest';
import selectedReview from './agent/reviews/fixtures/selected-review.json';
import { activate, PLUGIN_MANIFEST } from './manifest.js';

function completed(stdout = '', exitCode = 0): PluginProcessResult {
  return { stdout: new TextEncoder().encode(stdout), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
    termination: { observed: { kind: 'exit', exitCode }, requestedBy: { kind: 'none' } } };
}

async function runFixture(options: { failedMember?: boolean; unableToReview?: boolean; cancel?: boolean; missingDocument?: boolean; captured?: boolean; cleanupFailure?: boolean } = {}) {
  const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  const factory = activation.registration('agents', 'panels')?.factory;
  if (!factory) throw new Error('Expected panel reviewer Agent registration');
  const controller = new AbortController();
  const agent = await factory({ plugin: { id: PLUGIN_MANIFEST.id, version: '0.0.0' }, agent: { id: 'panels' }, signal: controller.signal });
  const record = structuredClone(selectedReview);
  if (options.failedMember) record.panel.members[1]!.status = 'failed';
  if (options.unableToReview) record.structured_output.verdict = 'unable_to_review';
  let waitStarted!: () => void;
  const waiting = new Promise<void>(resolve => { waitStarted = resolve; });
  // The process and durable-directory services are the genuine OS boundaries.
  const run = vi.fn<ExecService['run']>(async ({ args }, invocation) => {
    if (options.cleanupFailure && args?.[1] === 'stop') return completed('', 1);
    if (args?.[0] === 'review') return completed('Enqueued job 3 (panel: fixture, 2 reviewers) for review\n');
    if (args?.[1] === 'list') return completed('[{"id":3,"job_type":"synthesis"}]');
    if (args?.[1] === 'wait') {
      waitStarted();
      if (options.cancel) await new Promise<void>(resolve => invocation?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      invocation?.signal?.throwIfAborted();
      return completed('', 1);
    }
    if (args?.[1] === 'show') return completed(JSON.stringify(options.missingDocument ? { job_id: 3 } : record));
    return completed();
  });
  const writeFile = vi.fn(async () => {});
  const context = { plugin: { id: PLUGIN_MANIFEST.id, version: '0.0.0' }, contribution: { id: 'panels', qualifiedId: `${PLUGIN_MANIFEST.id}/agents/panels` },
    surface: 'agent', signal: controller.signal, agent: { id: 'panels' }, services: { availability: () => ({ status: 'available' }),
      exec: { run }, fs: { getPluginDataDirectory: async () => '/plugin-data/runs/test', writeFile } },
  } as unknown as AgentRuntimeContext;
  const request: Extract<AgentExecutionRunOpenRequest, { kind: 'create' }> = {
    kind: 'create', runId: 'test', cwd: '/workspace', profile: { pluginId: PLUGIN_MANIFEST.id, localId: 'review' },
    launchEnvironment: { values: { SELECTED_OVERLAY: 'value' }, unset: ['SELECTED_OVERLAY'] },
    input: { text: 'Review this change.', structuredInput: { engineIds: ['panels'], instructions: 'Review this change.',
      scope: 'changes', changeType: 'uncommitted', base: { kind: 'none' }, engines: { panels: { panel: 'fixture', reviewType: 'security', agent: 'codex', reasoning: 'high' } },
      scmReviewScope: { kind: 'review_scm_scope.v1', status: 'supported', scmBackendId: 'git', scmMode: '.git',
        repositoryRoot: '/workspace', worktreeRoot: '/workspace', baseRef: { source: 'unavailable', ref: null },
        selectedPaths: [], committedPaths: [], uncommittedPaths: [], changedPaths: [], diagnostics: [],
        diff: { committedAvailable: false, uncommittedAvailable: true },
        ...(options.captured ? { comparison: { id: 'captured', source: { kind: 'branch', head: 'feature', base: 'main' }, endpoints: { before: 'base-oid', after: 'head-oid' } } } : {}),
      } } },
  };
  const runtime = await agent.executionRuns?.open(request, context);
  if (!runtime) throw new Error('Expected finite review runtime');
  const events: AgentExecutionRunEvent[] = [];
  runtime.watch(event => events.push(event));
  if (options.cancel) { await waiting; await runtime.stop(); }
  await vi.waitFor(() => expect(['run-complete', 'run-failed', 'run-cancelled']).toContain(events.at(-1)?.kind));
  // The finite runtime must not settle before native cleanup finishes.
  expect(run.mock.calls.at(-1)?.[0].args).toEqual(['daemon', 'stop']);
  const output = events.filter(event => event.kind === 'output-delta').map(event => event.text).join('');
  await runtime.dispose();
  await activation.dispose();
  return { events, output: output ? ReviewFindingsV2Schema.parse(JSON.parse(output)) : null, run, writeFile };
}

describe('activated panel reviewer', () => {
  it('runs selected native panel/type and exposes attributed findings through the shared result schema', async () => {
    const result = await runFixture();
    expect(result.events.at(-1)?.kind).toBe('run-complete');
    expect(result.output).toMatchObject({ reviewOutcome: 'complete', findings: [{ extensions: { 'happier.review.panels': {
      verdict: 'fail', sources: [1], members: [{ name: 'first' }, { name: 'second' }],
    } } }] });
    expect(result.run.mock.calls.find(([request]) => request.args?.[0] === 'review')?.[0].args)
      .toEqual(['review', '--dirty', '--panel', 'fixture', '--type', 'security', '--agent', 'codex', '--reasoning', 'high', '--quiet']);
    expect(result.run.mock.calls[0]?.[0].env).toMatchObject({ SELECTED_OVERLAY: '' });
    expect(result.writeFile).toHaveBeenCalledWith({ root: 'pluginData', relativePath: 'runs/test/config.toml' },
      new TextEncoder().encode('review_guidelines = "Review this change."\n'), { signal: expect.any(AbortSignal) });
  });
  it('translates captured endpoints without re-resolving the ambient branch', async () => {
    const result = await runFixture({ captured: true });
    expect(result.output?.comparisonId).toBe('captured');
    expect(result.run.mock.calls.find(([request]) => request.args?.[0] === 'review')?.[0].args)
      .toEqual(['review', '--sha', 'base-oid..head-oid', '--panel', 'fixture', '--type', 'security', '--agent', 'codex', '--reasoning', 'high', '--quiet']);
  });
  it.each([
    { options: { failedMember: true }, outcome: 'partial', secondMemberStatus: 'failed' },
    { options: { unableToReview: true }, outcome: 'failed', secondMemberStatus: 'done' },
  ])('completes the transport so the host can materialize a $outcome review and its findings', async ({ options, outcome, secondMemberStatus }) => {
    const result = await runFixture(options);
    expect(result.events.at(-1)?.kind).toBe('run-complete');
    expect(result.output).toMatchObject({ reviewOutcome: outcome, findings: [{ extensions: { 'happier.review.panels': {
      members: [{ status: 'done' }, { status: secondMemberStatus }],
    } } }] });
  });
  it('refuses missing structured data through the real finite runtime', async () => {
    const result = await runFixture({ missingDocument: true });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'panel_document_unsupported' } });
    expect(result.output).toBeNull();
  });
  it('cancels the selected job before stopping its daemon and settling Stop', async () => {
    const result = await runFixture({ cancel: true });
    expect(result.events.at(-1)?.kind).toBe('run-cancelled');
    expect(result.run.mock.calls.slice(-2).map(([request]) => request.args)).toEqual([['job', 'cancel', '3'], ['daemon', 'stop']]);
  });
  it('keeps failed native cleanup visible when Stop was requested', async () => {
    const result = await runFixture({ cancel: true, cleanupFailure: true });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-cancelled', diagnostic: { code: 'panel_cleanup_failed' } });
  });
});
