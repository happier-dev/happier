import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type {
  AgentExecutionRunEvent,
  AgentRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';
import type { PluginServices } from '@happier-dev/plugin-sdk/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function createRuntimeContext(run: PluginServices['exec']['run']): AgentRuntimeContext {
  // The process service is the only genuine host boundary consumed by this execution-only Agent.
  const services = {
    availability: (id: string) => id === 'exec' ? { status: 'available' as const } : { status: 'unavailable' as const },
    exec: { run },
  } as unknown as PluginServices;
  const unavailable = async (): Promise<never> => { throw new Error('unavailable'); };
  return {
    plugin: { id: 'happier.review.coderabbit', version: '0.0.0' },
    contribution: {
      id: 'coderabbit',
      qualifiedId: 'happier.review.coderabbit/agents/coderabbit',
    },
    surface: 'agent',
    signal: new AbortController().signal,
    services,
    ui: {
      confirm: unavailable,
      notify: unavailable,
      status: { set: unavailable },
      widget: { set: unavailable },
      title: { set: unavailable },
      composer: { replace: unavailable },
    },
    agent: { id: 'coderabbit' },
    protocols: { acp: { open: unavailable } },
  };
}

async function createCodeRabbitRuntime() {
  const activation = await createPluginTestkit({
    manifest: PLUGIN_MANIFEST,
    module: { activate },
  });
  const factory = activation.registration('agents', 'coderabbit')?.factory;
  if (!factory) throw new Error('Expected CodeRabbit Agent factory');
  const runtime = await factory({
    plugin: { id: 'happier.review.coderabbit', version: '0.0.0' },
    agent: { id: 'coderabbit' },
    signal: new AbortController().signal,
  });
  await activation.dispose();
  return runtime;
}

describe('activate', () => {
  it('does not publish the retired V1 execution backend from the plugin package', async () => {
    const pluginExports: Record<string, unknown> = await import('./index.js');

    expect(pluginExports).not.toHaveProperty('createCodeRabbitExecutionRunBackend');
  });

  it('runs CodeRabbit through the native Agent execution-run contract', async () => {
    const runtime = await createCodeRabbitRuntime();
    const run = vi.fn(async () => ({
      termination: {
        observed: { kind: 'exit' as const, exitCode: 0 },
        requestedBy: { kind: 'none' as const },
      },
      stdout: new Uint8Array(Buffer.from('plain review output')),
      stderr: new Uint8Array(),
      stdoutTruncated: false,
      stderrTruncated: false,
    }));
    const opened = await runtime.executionRuns?.open({
      kind: 'create',
      runId: 'run-1',
      cwd: '/workspace',
      profile: { pluginId: 'happier.review.coderabbit', localId: 'review' },
      launchEnvironment: {
        values: {
          HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS: '2400',
          HAPPIER_CODERABBIT_REVIEW_MAX_ELIGIBLE_FILES: '2',
        },
        unset: [],
      },
      input: {
        text: 'Review this change.',
        structuredInput: {
          engineIds: ['coderabbit'],
          instructions: 'Review this change.',
          changeType: 'uncommitted',
          base: { kind: 'none' },
          scmReviewScope: {
            kind: 'review_scm_scope.v1',
            status: 'supported',
            scmBackendId: 'git',
            scmMode: '.git',
            repositoryRoot: '/workspace',
            worktreeRoot: '/workspace',
            baseRef: { source: 'unavailable', ref: null },
            selectedPaths: ['src/auth.ts'],
            committedPaths: [],
            uncommittedPaths: [{
              path: 'src/auth.ts',
              previousPath: null,
              kind: 'modified',
              hasCommittedDelta: false,
              hasUncommittedDelta: true,
              diff: { committedAvailable: false, uncommittedAvailable: true, isBinary: false },
            }],
            changedPaths: [{
              path: 'src/auth.ts',
              previousPath: null,
              kind: 'modified',
              hasCommittedDelta: false,
              hasUncommittedDelta: true,
              diff: { committedAvailable: false, uncommittedAvailable: true, isBinary: false },
            }],
            diff: { committedAvailable: false, uncommittedAvailable: true },
            diagnostics: [],
          },
        },
      },
    }, createRuntimeContext(run));
    if (!opened) throw new Error('Expected native CodeRabbit execution runtime');
    const events: AgentExecutionRunEvent[] = [];
    opened.watch((event) => events.push(event));

    await vi.waitFor(() => expect(['run-complete', 'run-failed']).toContain(events.at(-1)?.kind));
    expect(events.at(-1)).toEqual(expect.objectContaining({ kind: 'run-complete' }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      executable: { kind: 'systemTool', id: 'coderabbit-cli' },
      cwd: { root: 'workspace', relativePath: '' },
      args: expect.arrayContaining(['review', '--no-color', '--cwd', '/workspace', '--type', 'uncommitted', '--plain']),
      timeoutMs: 2400,
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(events.map((event) => event.kind)).toEqual([
      'run-start',
      'output-delta',
      'run-complete',
    ]);
    expect(events[1]).toMatchObject({
      kind: 'output-delta',
      channel: 'assistant',
      text: expect.stringContaining('CodeRabbit review: no findings.'),
    });
    await opened.dispose();
  });

  it('cancels its active process through the native run and publishes one terminal event', async () => {
    const runtime = await createCodeRabbitRuntime();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let processSignal: AbortSignal | undefined;
    const run: PluginServices['exec']['run'] = vi.fn(async (_request, options) => {
      processSignal = options?.signal;
      if (!processSignal) throw new Error('Expected the native run cancellation signal');
      resolveStarted();
      await new Promise<void>((resolve) => {
        processSignal!.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        termination: {
          observed: { kind: 'signal' as const, signal: 'SIGTERM' },
          requestedBy: { kind: 'abort' as const },
        },
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    });
    const opened = await runtime.executionRuns?.open({
      kind: 'create',
      runId: 'run-cancel',
      cwd: '/workspace',
      profile: { pluginId: 'happier.review.coderabbit', localId: 'review' },
      launchEnvironment: { values: {}, unset: [] },
      input: {
        text: 'Review this change.',
        structuredInput: {
          engineIds: ['coderabbit'],
          instructions: 'Review this change.',
          changeType: 'uncommitted',
          base: { kind: 'none' },
          scmReviewScope: {
            kind: 'review_scm_scope.v1',
            status: 'supported',
            scmBackendId: 'git',
            scmMode: '.git',
            repositoryRoot: '/workspace',
            worktreeRoot: '/workspace',
            baseRef: { source: 'unavailable', ref: null },
            selectedPaths: ['src/auth.ts'],
            committedPaths: [],
            uncommittedPaths: [{
              path: 'src/auth.ts',
              previousPath: null,
              kind: 'modified',
              hasCommittedDelta: false,
              hasUncommittedDelta: true,
              diff: { committedAvailable: false, uncommittedAvailable: true, isBinary: false },
            }],
            changedPaths: [{
              path: 'src/auth.ts',
              previousPath: null,
              kind: 'modified',
              hasCommittedDelta: false,
              hasUncommittedDelta: true,
              diff: { committedAvailable: false, uncommittedAvailable: true, isBinary: false },
            }],
            diff: { committedAvailable: false, uncommittedAvailable: true },
            diagnostics: [],
          },
        },
      },
    }, createRuntimeContext(run));
    if (!opened) throw new Error('Expected native CodeRabbit execution runtime');
    const events: AgentExecutionRunEvent[] = [];
    opened.watch((event) => events.push(event));

    await started;
    await expect(opened.stop()).resolves.toEqual({ status: 'requested' });
    await vi.waitFor(() => expect(events.at(-1)?.kind).toBe('run-cancelled'));

    expect(processSignal?.aborted).toBe(true);
    expect(events.filter((event) => (
      event.kind === 'run-complete'
      || event.kind === 'run-failed'
      || event.kind === 'run-cancelled'
    ))).toEqual([expect.objectContaining({ kind: 'run-cancelled' })]);
    await opened.dispose();
  });

  it('honors explicit launch-environment unsets without reading ambient process env', async () => {
    vi.stubEnv('HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS', '9999');
    const runtime = await createCodeRabbitRuntime();
    const run = vi.fn(async () => ({
      termination: {
        observed: { kind: 'exit' as const, exitCode: 0 },
        requestedBy: { kind: 'none' as const },
      },
      stdout: new Uint8Array(Buffer.from('plain review output')),
      stderr: new Uint8Array(),
      stdoutTruncated: false,
      stderrTruncated: false,
    }));
    const opened = await runtime.executionRuns?.open({
      kind: 'create',
      runId: 'run-unset',
      cwd: '/workspace',
      profile: { pluginId: 'happier.review.coderabbit', localId: 'review' },
      launchEnvironment: {
        values: { HAPPIER_CODERABBIT_REVIEW_TIMEOUT_MS: '2400' },
        unset: ['happier_coderabbit_review_timeout_ms'],
      },
      input: {
        text: 'Review this change.',
        structuredInput: {
          engineIds: ['coderabbit'],
          instructions: 'Review this change.',
          changeType: 'uncommitted',
          base: { kind: 'none' },
          scmReviewScope: {
            kind: 'review_scm_scope.v1',
            status: 'supported',
            scmBackendId: 'git',
            scmMode: '.git',
            repositoryRoot: '/workspace',
            worktreeRoot: '/workspace',
            baseRef: { source: 'unavailable', ref: null },
            selectedPaths: ['src/auth.ts'],
            committedPaths: [],
            uncommittedPaths: [],
            changedPaths: [],
            diff: { committedAvailable: false, uncommittedAvailable: true },
            diagnostics: [],
          },
        },
      },
    }, createRuntimeContext(run));
    if (!opened) throw new Error('Expected native CodeRabbit execution runtime');
    const events: AgentExecutionRunEvent[] = [];
    opened.watch((event) => events.push(event));

    await vi.waitFor(() => expect(['run-complete', 'run-failed']).toContain(events.at(-1)?.kind));
    expect(events.at(-1)).toEqual(expect.objectContaining({ kind: 'run-complete' }));
    expect(run).toHaveBeenCalledWith(
      expect.not.objectContaining({ timeoutMs: expect.anything() }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await opened.dispose();
  });
});
