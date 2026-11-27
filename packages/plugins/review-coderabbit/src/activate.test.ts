import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentExecutionRunEvent, AgentExecutionRunOpenRequest, AgentRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import type { PluginProcessOutput } from '@happier-dev/plugin-sdk/exec';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';

const finding = { type: 'finding', severity: 'major', fileName: 'src/auth.ts', startLine: 10, endLine: 12,
  title: 'Validate redirect', comment: 'An unchecked redirect allows an attacker-controlled destination.', codegenInstructions: 'Check the redirect against the allowlist.' };
const complete = { type: 'complete', status: 'review_completed', outcome: 'completed', findings: 0 };

function checkoutSnapshot(headOid: string): PluginActionResultById['scm.status.snapshot'] {
  return { success: true, snapshot: {
    projectKey: '/workspace', fetchedAt: 1,
    repo: { isRepo: true, rootPath: '/workspace', backendId: 'git', mode: '.git', worktrees: [], remotes: [] },
    capabilities: { capabilityScope: 'local-backend', readStatus: true, readDiffFile: true, readDiffCommit: true, readLog: true,
      writeInclude: false, writeExclude: false, writeCommit: false, writeCommitPathSelection: false,
      writeCommitLineSelection: false, writeBackout: false, writeRemoteFetch: false, writeRemotePull: false,
      writeRemotePush: false, worktreeCreate: false, changeSetModel: 'index', supportedDiffAreas: ['both'] },
    branch: { head: 'feature', headOid, upstream: 'origin/main', ahead: 1, behind: 0, detached: false },
    hasConflicts: false, entries: [], totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0,
      includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
  } };
}

function request(options: Record<string, unknown> = {}, scope: Record<string, unknown> = {}, engineId = 'coderabbit'): Extract<AgentExecutionRunOpenRequest, { kind: 'create' }> {
  return { kind: 'create', runId: 'run-1', cwd: '/workspace',
    profile: { pluginId: 'happier.review.coderabbit', localId: 'review' },
    input: { text: 'Review this change.', structuredInput: {
      reviewers: [{ kind: 'engine', engineId }], instructions: 'Review this change.', changeType: 'uncommitted', base: { kind: 'none' },
      engines: { [engineId]: options },
      scmReviewScope: { kind: 'review_scm_scope.v1', status: 'supported', scmBackendId: 'git', scmMode: '.git',
        repositoryRoot: '/workspace', worktreeRoot: '/workspace', baseRef: { source: 'unavailable', ref: null },
        selectedPaths: ['src/auth.ts'], committedPaths: [], uncommittedPaths: [], changedPaths: [],
        diff: { committedAvailable: false, uncommittedAvailable: true }, diagnostics: [], ...scope },
    } },
  };
}

async function runFixture(params: { cleanupFailure?: boolean; launchEnvironment?: AgentExecutionRunOpenRequest['launchEnvironment']; records: readonly unknown[]; engineId?: string; exitCode?: number; options?: Record<string, unknown>; scope?: Record<string, unknown>; cancel?: boolean; cancelPreflight?: 'reject' | 'result'; raw?: string; changeType?: 'committed' | 'uncommitted'; checkout?: PluginActionResultById['scm.status.snapshot'] }) {
  const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  const factory = activation.registration('agents', 'coderabbit')?.factory;
  if (!factory) throw new Error('Expected CodeRabbit factory');
  const agent = await factory({ plugin: { id: PLUGIN_MANIFEST.id, version: '0.0.0' }, agent: { id: 'coderabbit' }, signal: new AbortController().signal });
  const text = params.raw ?? params.records.map(value => JSON.stringify(value)).join('\r\n');
  const bytes = new TextEncoder().encode(text);
  let listener: ((chunk: PluginProcessOutput) => void) | undefined;
  let processSignal: AbortSignal | undefined;
  let enterPreflight = () => {};
  const preflightEntered = new Promise<void>(resolve => { enterPreflight = resolve; });
  const spawn: PluginServices['exec']['spawn'] = vi.fn(async (_request, options) => {
    processSignal = options?.signal;
    return { write: async () => {}, closeStdin: async () => {}, dispose: async () => { if (params.cleanupFailure) throw new Error('OS cleanup failed'); },
      waitForExit: async () => ({ observed: { kind: 'exit', exitCode: params.exitCode ?? 0 }, requestedBy: { kind: 'none' } }),
      onOutput(callback) { listener = callback; return { dispose() { listener = undefined; } }; },
      async wait() {
        if (params.cancel) {
          await new Promise<void>(resolve => {
            if (processSignal?.aborted) resolve();
            else processSignal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        // Exercise UTF-8, JSON and CRLF boundaries, including an unterminated final line.
        for (let offset = 0; offset < bytes.length; offset++) listener?.({ sequence: offset, stream: 'stdout', data: bytes.slice(offset, offset + 1) });
        return { termination: params.cancel
          ? { observed: { kind: 'signal' as const, signal: 'SIGTERM' }, requestedBy: { kind: 'abort' as const } }
          : { observed: { kind: 'exit' as const, exitCode: params.exitCode ?? 0 }, requestedBy: { kind: 'none' as const } },
          stdout: bytes, stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false };
      },
    };
  });
  // The host process service is the genuine system boundary; plugin/runtime logic stays real.
  const context = { plugin: { id: PLUGIN_MANIFEST.id, version: '0.0.0' }, contribution: { id: 'coderabbit', qualifiedId: `${PLUGIN_MANIFEST.id}/agents/coderabbit` },
    surface: 'agent', signal: new AbortController().signal, agent: { id: 'coderabbit' },
    // SCM Actions cross the host transport boundary; the adapter's scope decision stays real.
    services: { availability: () => ({ status: 'available' }), actions: { execute: vi.fn(async (_action: 'scm.status.snapshot', _input: unknown, options?: { signal?: AbortSignal }) => {
      if (!params.cancelPreflight) return params.checkout ?? checkoutSnapshot('live-head');
      enterPreflight();
      return new Promise<PluginActionResultById['scm.status.snapshot']>((resolve, reject) => {
        const aborted = () => params.cancelPreflight === 'reject' ? reject(options?.signal?.reason) : resolve({ success: false });
        if (options?.signal?.aborted) aborted();
        else options?.signal?.addEventListener('abort', aborted, { once: true });
      });
    }) }, exec: { spawn,
      run: async () => ({ termination: { observed: { kind: 'exit', exitCode: params.exitCode ?? 0 }, requestedBy: { kind: 'none' } },
        stdout: bytes, stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false }),
    } },
  } as unknown as AgentRuntimeContext;
  const openRequest = { ...request(params.options, params.scope, params.engineId), ...(params.launchEnvironment ? { launchEnvironment: params.launchEnvironment } : {}) };
  const opened = await agent.executionRuns?.open({ ...openRequest, input: { ...openRequest.input,
    ...(params.changeType ? { structuredInput: { ...openRequest.input.structuredInput, changeType: params.changeType } } : {}),
  } }, context);
  if (!opened) throw new Error('Expected execution runtime');
  const events: AgentExecutionRunEvent[] = [];
  opened.watch(event => events.push(event));
  if (params.cancelPreflight) { await preflightEntered; await opened.stop(); }
  if (params.cancel) await opened.stop();
  await vi.waitFor(() => expect(['run-complete', 'run-failed', 'run-cancelled']).toContain(events.at(-1)?.kind));
  const output = events.filter(event => event.kind === 'output-delta' && event.channel === 'assistant').map(event => event.text).join('');
  await opened.dispose();
  await activation.dispose();
  return { events, output: output ? JSON.parse(output) : null, spawn, processSignal };
}

describe('CodeRabbit native review contract (CLI 0.9.5 documented agent events)', () => {
  it('preserves native findings when process cleanup fails', async () => {
    const result = await runFixture({ cleanupFailure: true, records: [finding, { ...complete, findings: 1 }] });
    expect(result.events.at(-1)?.kind).toBe('run-complete');
    expect(result.output).toMatchObject({ findings: [expect.objectContaining({ title: 'Validate redirect' })] });
    expect(result.events).toContainEqual(expect.objectContaining({ kind: 'output-delta', channel: 'reasoning', text: expect.stringContaining('cleanup') }));
  });
  it('launches review in the selected host-materialized account home without credentials on argv', async () => {
    const selectedHome = '/fixture/selected-account-home';
    const result = await runFixture({ records: [complete], launchEnvironment: {
      values: { HOME: selectedHome, CODERABBIT_API_KEY: '' }, unset: [],
    } });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-complete' });
    expect(result.spawn).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({ HOME: selectedHome, CODERABBIT_API_KEY: '' }),
    }), expect.anything());
    expect(vi.mocked(result.spawn).mock.calls[0]?.[0].args).not.toContain('--api-key');
  });

  it.each(['reject', 'result'] as const)('cancels a stopped live SCM preflight before vendor launch (%s)', async cancelPreflight => {
    const result = await runFixture({ records: [complete], cancelPreflight, scope: {
      comparison: { id: 'captured-current', source: { kind: 'workingTree', area: 'both' },
        endpoints: { before: 'live-head', after: 'captured-worktree-tree' } },
    } });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-cancelled' });
    expect(result.spawn).not.toHaveBeenCalled();
  });

  it('reviews a captured whole working tree at the current HEAD through the ordinary native adapter', async () => {
    const result = await runFixture({ records: [complete], scope: {
      comparison: { id: 'captured-current', source: { kind: 'workingTree', area: 'both' },
        endpoints: { before: 'live-head', after: 'captured-worktree-tree' } },
    } });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-complete' });
    expect(result.spawn).toHaveBeenCalledWith(expect.objectContaining({
      args: ['review', '--agent', '--dir', '/workspace', '--uncommitted'],
    }), expect.anything());
  });

  it('pins the captured committed base when its head is the live checkout HEAD', async () => {
    const result = await runFixture({ records: [complete], changeType: 'committed', scope: {
      baseRef: { source: 'explicit', ref: 'captured-base' },
      comparison: { id: 'captured-current', source: { kind: 'branch', base: 'main', head: 'feature' },
        endpoints: { before: 'captured-base', after: 'live-head' } },
    } });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-complete' });
    expect(result.spawn).toHaveBeenCalledWith(expect.objectContaining({
      args: ['review', '--agent', '--dir', '/workspace', '--committed', '--base-commit', 'captured-base'],
    }), expect.anything());
  });

  it.each([
    { source: { kind: 'workingTree', area: 'both' }, endpoints: { before: 'old-head', after: 'tree' } },
    { source: { kind: 'workingTree', area: 'included' }, endpoints: { before: 'live-head', after: 'index' } },
    { source: { kind: 'workingTree', area: 'pending' }, endpoints: { before: 'index', after: 'tree' } },
  ])('refuses a moved HEAD or a partial working-tree scope before the vendor starts: %j', async comparison => {
    const result = await runFixture({ records: [complete], scope: { comparison: { id: 'unsupported', ...comparison } } });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'coderabbit_scope_unsupported' } });
    expect(result.spawn).not.toHaveBeenCalled();
  });

  it.each([
    { comparison: { id: 'captured-1', source: { kind: 'branch', base: 'main', head: 'feature' }, endpoints: { before: 'old-base', after: 'old-head' } } },
    { revisionRange: { kind: 'revisionRange', baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40) } },
  ])('refuses captured endpoints before starting an ambient worktree review: %j', async scope => {
    const result = await runFixture({ records: [complete], scope, changeType: 'committed' });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'coderabbit_scope_unsupported' } });
    expect(result.spawn).not.toHaveBeenCalled();
  });

  it('returns a visible unsupported-scope refusal when live checkout facts are unavailable', async () => {
    const result = await runFixture({ records: [complete], checkout: { success: false }, scope: {
      comparison: { id: 'captured-current', source: { kind: 'workingTree' },
        endpoints: { before: 'live-head', after: 'tree' } },
    } });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: {
      code: 'coderabbit_scope_unsupported', message: expect.stringMatching(/checkout|SCM/),
    } });
    expect(result.spawn).not.toHaveBeenCalled();
  });

  it('folds split NDJSON and heartbeats into one complete clean result', async () => {
    const result = await runFixture({ records: [{ type: 'review_context' }, { type: 'heartbeat' }, { type: 'status', status: 'reviewing' }, complete] });
    expect(result.events.map(event => event.kind)).toEqual(['run-start', 'output-delta', 'run-complete']);
    expect(result.output).toMatchObject({ reviewOutcome: 'complete', findings: [] });
    expect(result.spawn).toHaveBeenCalledTimes(1);
    expect(result.spawn).toHaveBeenCalledWith(expect.objectContaining({ args: ['review', '--agent', '--dir', '/workspace', '--uncommitted'] }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('preserves fix instructions, severity, Unicode and locations when gate exit 2 blocks', async () => {
    const result = await runFixture({ engineId: 'happier.review.coderabbit/coderabbit', records: [{ ...finding, title: 'Vérifier redirect' }, { ...complete, findings: 1, gate: { threshold: 'major', status: 'blocked', blockingFindings: 1 } }], exitCode: 2, options: { gate: 'major', configFiles: ['review.md', 'team.md'] } });
    expect(result.events.at(-1)?.kind).toBe('run-complete');
    expect(result.output).toMatchObject({ reviewOutcome: 'complete', findings: [{ title: 'Vérifier redirect', severity: 'high', filePath: 'src/auth.ts', startLine: 10, endLine: 12, suggestion: finding.codegenInstructions }] });
    expect(result.output.overviewMarkdown).toContain('blocked');
    expect(result.spawn).toHaveBeenCalledWith(expect.objectContaining({ args: ['review', '--agent', '--dir', '/workspace', '--uncommitted', '--gate', 'major', '--config', 'review.md', 'team.md'] }), expect.anything());
  });

  it('retains findings with partial coverage on exit 1', async () => {
    const result = await runFixture({ records: [finding, { ...complete, findings: 1, outcome: 'failed', unreviewedFileCount: 2, message: 'Two files could not be reviewed.' }], exitCode: 1 });
    expect(result.events.at(-1)?.kind).toBe('run-complete');
    expect(result.output).toMatchObject({ reviewOutcome: 'partial', findings: [{ suggestion: finding.codegenInstructions }] });
    expect(result.output.overviewMarkdown).toContain('2 file(s) were not reviewed');
  });

  it('preserves a valid failed review document and its typed cause with no findings', async () => {
    const result = await runFixture({ records: [{ ...complete, outcome: 'failed' }], exitCode: 1 });
    expect(result.events.at(-1)?.kind).toBe('run-complete');
    expect(result.output).toMatchObject({ reviewOutcome: 'failed', findings: [],
      error: { code: 'coderabbit_review_failed' } });
  });

  it('preserves the installed CLI terminal error from a logged-out saved-prompt read', async () => {
    // Real CodeRabbit 0.9.5 on linux-x64, 2026-11-26: `review --agent
    // --uncommitted --dir <external fixture repository> --show-prompts`, empty
    // selected account home. This read does not generate a review. Vendor
    // diagnostic detail was omitted; no event or completion was added.
    const captured = '{"type":"error","errorType":"review"}\n';
    const result = await runFixture({ records: [], raw: captured, exitCode: 1 });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'coderabbit_review' } });
    expect(result.output).toMatchObject({ reviewOutcome: 'failed', findings: [], error: { code: 'coderabbit_review' } });
    expect(result.events.some(event => event.kind === 'run-complete')).toBe(false);
  });

  it.each([false, true])('settles a rate limit once with recovery guidance and no retry (terminal present: %s)', async terminalPresent => {
    const result = await runFixture({ records: [{ type: 'error', errorType: 'rate_limit', message: 'Wait 4 minutes before retrying.' },
      ...(terminalPresent ? [complete] : [])], exitCode: 1 });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'coderabbit_rate_limit' } });
    expect(result.output).toMatchObject({ reviewOutcome: 'failed', findings: [] });
    expect(result.output.overviewMarkdown).toContain('quota');
    expect(result.spawn).toHaveBeenCalledTimes(1);
  });

  it('keeps native account and organization text out of review status and diagnostics', async () => {
    for (const records of [
      [{ type: 'error', errorType: 'rate_limit', message: 'Wait 4 minutes for private@example.test in Secret Org.' }],
      [{ ...complete, message: 'Review completed for private@example.test in Secret Org.', persistence: { status: 'failed', errorCode: 'private@example.test' } }],
      [{ ...complete, gate: { status: 'private@example.test in Secret Org' } }],
    ]) {
      const result = await runFixture({ records });
      const published = JSON.stringify({ output: result.output, events: result.events });
      expect(published).not.toContain('private@example.test');
      expect(published).not.toContain('Secret Org');
    }
  });

  it.each([
    ['missing completion', [finding], undefined],
    ['malformed completion', [finding], `${JSON.stringify(finding)}\n{"type":"complete"`],
    ['contradictory finding count', [{ ...complete, findings: 1 }], undefined],
  ])('never reports clean success for %s', async (_name, records, raw) => {
    const result = await runFixture({ records, raw });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'coderabbit_invalid_output' } });
    expect(result.output.reviewOutcome).not.toBe('complete');
  });

  it('preserves reused results and completed warnings without inventing incomplete coverage', async () => {
    const result = await runFixture({ records: [{ ...complete, reused: true, outcome: 'completed_with_warnings', unreviewedFileCount: 0 }] });
    expect(result.output.reviewOutcome).toBe('complete');
    expect(result.output.overviewMarkdown).toContain('reused');
  });

  it('passes cancellation through and emits one canceled terminal event', async () => {
    const result = await runFixture({ records: [], cancel: true });
    expect(result.processSignal?.aborted).toBe(true);
    expect(result.events.filter(event => ['run-complete', 'run-failed', 'run-cancelled'].includes(event.kind))).toEqual([expect.objectContaining({ kind: 'run-cancelled' })]);
  });
});
