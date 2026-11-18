import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { AgentExecutionRunEvent, AgentExecutionRunOpenRequest, AgentRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginServices } from '@happier-dev/plugin-sdk';
import type { PluginProcessOutput } from '@happier-dev/plugin-sdk/exec';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';

const finding = { type: 'finding', severity: 'major', fileName: 'src/auth.ts', startLine: 10, endLine: 12,
  title: 'Validate redirect', comment: 'An unchecked redirect allows an attacker-controlled destination.', codegenInstructions: 'Check the redirect against the allowlist.' };
const complete = { type: 'complete', status: 'review_completed', outcome: 'completed', findings: 0 };

function request(options: Record<string, unknown> = {}, scope: Record<string, unknown> = {}): Extract<AgentExecutionRunOpenRequest, { kind: 'create' }> {
  return { kind: 'create', runId: 'run-1', cwd: '/workspace',
    profile: { pluginId: 'happier.review.coderabbit', localId: 'review' },
    input: { text: 'Review this change.', structuredInput: {
      reviewers: [{ kind: 'engine', engineId: 'coderabbit' }], instructions: 'Review this change.', changeType: 'uncommitted', base: { kind: 'none' },
      engines: { coderabbit: options },
      scmReviewScope: { kind: 'review_scm_scope.v1', status: 'supported', scmBackendId: 'git', scmMode: '.git',
        repositoryRoot: '/workspace', worktreeRoot: '/workspace', baseRef: { source: 'unavailable', ref: null },
        selectedPaths: ['src/auth.ts'], committedPaths: [], uncommittedPaths: [], changedPaths: [],
        diff: { committedAvailable: false, uncommittedAvailable: true }, diagnostics: [], ...scope },
    } },
  };
}

async function runFixture(params: { records: readonly unknown[]; exitCode?: number; options?: Record<string, unknown>; scope?: Record<string, unknown>; cancel?: boolean; raw?: string }) {
  const activation = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate } });
  const factory = activation.registration('agents', 'coderabbit')?.factory;
  if (!factory) throw new Error('Expected CodeRabbit factory');
  const agent = await factory({ plugin: { id: PLUGIN_MANIFEST.id, version: '0.0.0' }, agent: { id: 'coderabbit' }, signal: new AbortController().signal });
  const text = params.raw ?? params.records.map(value => JSON.stringify(value)).join('\r\n');
  const bytes = new TextEncoder().encode(text);
  let listener: ((chunk: PluginProcessOutput) => void) | undefined;
  let processSignal: AbortSignal | undefined;
  const spawn: PluginServices['exec']['spawn'] = vi.fn(async (_request, options) => {
    processSignal = options?.signal;
    return { write: async () => {}, closeStdin: async () => {}, dispose: async () => {},
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
    services: { availability: () => ({ status: 'available' }), exec: { spawn,
      run: async () => ({ termination: { observed: { kind: 'exit', exitCode: params.exitCode ?? 0 }, requestedBy: { kind: 'none' } },
        stdout: bytes, stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false }),
    } },
  } as unknown as AgentRuntimeContext;
  const opened = await agent.executionRuns?.open(request(params.options, params.scope), context);
  if (!opened) throw new Error('Expected execution runtime');
  const events: AgentExecutionRunEvent[] = [];
  opened.watch(event => events.push(event));
  if (params.cancel) await opened.stop();
  await vi.waitFor(() => expect(['run-complete', 'run-failed', 'run-cancelled']).toContain(events.at(-1)?.kind));
  const output = events.filter(event => event.kind === 'output-delta').map(event => event.text).join('');
  await opened.dispose();
  await activation.dispose();
  return { events, output: output ? JSON.parse(output) : null, spawn, processSignal };
}

describe('CodeRabbit native review contract (CLI 0.9.5 documented agent events)', () => {
  it.each([
    { comparison: { id: 'captured-1', source: { kind: 'branch', base: 'main', head: 'feature' }, endpoints: { before: 'old-base', after: 'old-head' } } },
    { revisionRange: { kind: 'revisionRange', baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40) } },
  ])('refuses captured endpoints before starting an ambient worktree review: %j', async scope => {
    const result = await runFixture({ records: [complete], scope });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'coderabbit_scope_unsupported' } });
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
    const result = await runFixture({ records: [{ ...finding, title: 'Vérifier redirect' }, { ...complete, findings: 1, gate: { threshold: 'major', status: 'blocked', blockingFindings: 1 } }], exitCode: 2, options: { gate: 'major', configFiles: ['review.md', 'team.md'] } });
    expect(result.events.at(-1)?.kind).toBe('run-complete');
    expect(result.output).toMatchObject({ reviewOutcome: 'complete', findings: [{ title: 'Vérifier redirect', severity: 'high', filePath: 'src/auth.ts', startLine: 10, endLine: 12, suggestion: finding.codegenInstructions }] });
    expect(result.output.overviewMarkdown).toContain('blocked');
    expect(result.spawn).toHaveBeenCalledWith(expect.objectContaining({ args: ['review', '--agent', '--dir', '/workspace', '--uncommitted', '--gate', 'major', '--config', 'review.md', 'team.md'] }), expect.anything());
  });

  it('retains findings with partial coverage on exit 1', async () => {
    const result = await runFixture({ records: [finding, { ...complete, findings: 1, outcome: 'failed', unreviewedFileCount: 2, message: 'Two files could not be reviewed.' }], exitCode: 1 });
    expect(result.events.at(-1)).toMatchObject({ kind: 'run-failed', diagnostic: { code: 'coderabbit_review_failed' } });
    expect(result.output).toMatchObject({ reviewOutcome: 'partial', findings: [{ suggestion: finding.codegenInstructions }] });
    expect(result.output.overviewMarkdown).toContain('2 file(s) were not reviewed');
  });

  it('settles a rate limit once with recovery guidance and no retry', async () => {
    const result = await runFixture({ records: [{ type: 'error', errorType: 'rate_limit', message: 'Wait 4 minutes before retrying.' }], exitCode: 1 });
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
