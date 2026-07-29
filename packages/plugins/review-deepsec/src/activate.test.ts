import { readFile, writeFile } from 'node:fs/promises';

import type {
  AgentExecutionRunEvent,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type {
  PluginExecSpawnRequest,
  PluginProcessResult,
  PluginResolvedSystemTool,
  PluginServices,
} from '@happier-dev/plugin-sdk/runtime';
import { ReviewFindingsV2Schema } from '@happier-dev/plugin-sdk/experimental/reviews';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

function processResult(exitCode = 0): PluginProcessResult {
  return {
    termination: {
      observed: { kind: 'exit', exitCode },
      requestedBy: { kind: 'none' },
    },
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function createRuntimeContext(params?: Readonly<{
  resolvedTool?: PluginResolvedSystemTool;
  run?: (request: PluginExecSpawnRequest & { timeoutMs?: number }, options?: { signal?: AbortSignal }) => Promise<PluginProcessResult>;
  checkReadiness?: (request: Readonly<{
    candidates: readonly string[];
    requirement: 'any' | 'all';
    cwd?: string;
    projectId?: string;
    workspaceId?: string;
    signal?: AbortSignal;
  }>) => Promise<Readonly<{ launchable: readonly Readonly<{ agentId: string }>[] }>>;
}>): Readonly<{
  context: AgentRuntimeContext;
  resolve: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  checkReadiness: ReturnType<typeof vi.fn>;
}> {
  const resolvedTool = params?.resolvedTool ?? {
    executable: { kind: 'systemTool', id: 'deepsec-cli' },
    executablePath: '/usr/local/bin/deepsec',
  };
  const resolve = vi.fn(async () => resolvedTool);
  const run = vi.fn(params?.run ?? (async () => processResult()));
  const checkReadiness = vi.fn(params?.checkReadiness ?? (async () => ({
    launchable: [{ agentId: 'claude' }],
  })));
  const services = {
    availability: (id: string) => id === 'exec'
      ? { status: 'available' as const }
      : { status: 'unavailable' as const },
    exec: {
      agentCli: { checkReadiness },
      systemTools: { resolve },
      run,
    },
  } as unknown as PluginServices;
  const unavailable = async (): Promise<never> => {
    throw new Error('unavailable');
  };
  return {
    context: {
      plugin: { id: 'happier.review.deepsec', version: '0.0.0' },
      contribution: {
        id: 'deepsec',
        qualifiedId: 'happier.review.deepsec/agents/deepsec',
      },
      surface: 'agent',
      signal: new AbortController().signal,
      services,
      ui: {
        askQuestions: unavailable,
        confirm: unavailable,
        notify: unavailable,
        status: { set: unavailable },
        widget: { set: unavailable },
        title: { set: unavailable },
        composer: { replace: unavailable },
      },
      agent: { id: 'deepsec' },
      protocols: { acp: { open: unavailable } },
    },
    resolve,
    run,
    checkReadiness,
  };
}

async function createNativeDeepSecRuntime() {
  const activation = await createPluginTestkit({
    manifest: PLUGIN_MANIFEST,
    module: { activate },
  });
  const factory = activation.registration('agents', 'deepsec')?.factory;
  if (!factory) throw new Error('Expected DeepSec Agent registration');
  const runtime = await factory({
    plugin: { id: 'happier.review.deepsec', version: '0.0.0' },
    agent: { id: 'deepsec' },
    signal: new AbortController().signal,
  });
  const registrations = activation.registrations();
  await activation.dispose();
  return { registrations, runtime };
}

function createSupportedScmReviewScope(paths: readonly string[] = ['src/auth.ts']): unknown {
  const changedPaths = paths.map((path) => ({
    path,
    previousPath: null,
    kind: 'modified',
    hasCommittedDelta: false,
    hasUncommittedDelta: true,
    diff: { committedAvailable: false, uncommittedAvailable: true, isBinary: false },
  }));
  return {
    kind: 'review_scm_scope.v1',
    status: 'supported',
    scmBackendId: 'git',
    scmMode: '.git',
    repositoryRoot: '/repo',
    worktreeRoot: '/repo',
    baseRef: { source: 'branch_upstream', ref: 'origin/main' },
    selectedPaths: paths,
    committedPaths: [],
    uncommittedPaths: changedPaths,
    changedPaths,
    diff: { committedAvailable: false, uncommittedAvailable: true },
    diagnostics: [],
  };
}

function createOpenRequest(params?: Readonly<{
  runId?: string;
  mode?: 'current_diff' | 'selected_files';
  includeExplicitMode?: boolean;
  confirmedCostWarning?: boolean;
  profileLocalId?: string;
  paths?: readonly string[];
  scmReviewScope?: unknown;
}>): Extract<AgentExecutionRunOpenRequest, { kind: 'create' }> {
  const paths = params?.paths ?? ['src/auth.ts'];
  return {
    kind: 'create',
    runId: params?.runId ?? 'run-1',
    cwd: '/repo',
    profile: {
      pluginId: 'happier.review.deepsec',
      localId: params?.profileLocalId ?? 'review',
    },
    launchEnvironment: {
      values: { AI_GATEWAY_API_KEY: 'gateway-key' },
      unset: [],
    },
    input: {
      text: 'Review the current diff.',
      structuredInput: {
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        engineIds: ['deepsec'],
        instructions: 'Review the current diff.',
        changeType: 'uncommitted',
        base: { kind: 'none' },
        scmReviewScope: params?.scmReviewScope ?? createSupportedScmReviewScope(paths),
        engines: {
          deepsec: {
            ...(params?.includeExplicitMode === false
              ? {}
              : { mode: params?.mode ?? 'current_diff' }),
            ...(params?.confirmedCostWarning ? { confirmedCostWarning: true } : {}),
          },
        },
      },
    },
  };
}

async function watchToTerminal(runtime: AgentExecutionRunRuntime): Promise<readonly AgentExecutionRunEvent[]> {
  const events: AgentExecutionRunEvent[] = [];
  runtime.watch((event) => events.push(event));
  await vi.waitFor(() => expect(['run-complete', 'run-failed', 'run-cancelled']).toContain(events.at(-1)?.kind));
  return events;
}

function readStructuredOutput(events: readonly AgentExecutionRunEvent[]) {
  const output = events.find((event): event is Extract<AgentExecutionRunEvent, { kind: 'output-delta' }> => (
    event.kind === 'output-delta' && event.channel === 'assistant'
  ));
  if (!output) throw new Error('Expected DeepSec output event');
  return ReviewFindingsV2Schema.parse(JSON.parse(output.text));
}

describe('activate', () => {
  it('registers a native execution-run runtime without a V1 compatibility session', async () => {
    const { registrations, runtime } = await createNativeDeepSecRuntime();

    expect(registrations).toContainEqual({ family: 'agents', localId: 'deepsec' });
    expect(runtime.sessions).toBeUndefined();
    expect(runtime.executionRuns).toEqual(expect.objectContaining({ open: expect.any(Function) }));
  });

  it('runs the DeepSec pipeline through native events and the resolved managed executable', async () => {
    const commentOutMarkdown = [
      '### src/auth.ts:2',
      '',
      '**Severity:** critical',
      '**Rule:** CWE-601',
      '**Category:** open_redirect',
      '',
      'Validate redirect destinations before use.',
    ].join('\n');
    const fixture = createRuntimeContext({
      async run(request) {
        const commentOutIndex = request.args?.indexOf('--comment-out') ?? -1;
        const commentOutPath = commentOutIndex >= 0 ? request.args?.[commentOutIndex + 1] : undefined;
        if (commentOutPath) await writeFile(commentOutPath, commentOutMarkdown, 'utf8');
        return processResult();
      },
    });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest(), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');

    const events = await watchToTerminal(opened);
    await opened.dispose();

    expect(events.map((event) => event.kind)).toEqual(['run-start', 'output-delta', 'run-complete']);
    expect(fixture.resolve).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'deepsec-cli',
      purpose: 'review security findings',
      cwd: '/repo',
    }));
    expect(fixture.run).toHaveBeenCalledWith(expect.objectContaining({
      executable: { kind: 'systemTool', id: 'deepsec-cli' },
      cwd: { root: 'workspace', relativePath: '' },
      env: { AI_GATEWAY_API_KEY: 'gateway-key' },
      args: expect.arrayContaining(['process', '--diff', '--comment-out']),
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(readStructuredOutput(events)).toMatchObject({
      runRef: { runId: 'run-1', callId: 'deepsec:run-1' },
      findings: [expect.objectContaining({
        severity: 'blocker',
        category: 'security',
        filePath: 'src/auth.ts',
        startLine: 2,
        ruleId: 'CWE-601',
      })],
      proposedComments: [expect.objectContaining({
        body: 'Validate redirect destinations before use.',
        anchor: { kind: 'line', filePath: 'src/auth.ts', line: 2 },
        severity: 'critical',
        tags: ['deepsec'],
      })],
    });
  });

  it('selects repository audit mode from the canonical execution-run profile', async () => {
    const fixture = createRuntimeContext();
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({
      runId: 'run-repository-audit-profile',
      profileLocalId: 'repository-security-audit',
      includeExplicitMode: false,
      confirmedCostWarning: true,
    }), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');

    const events = await watchToTerminal(opened);
    await opened.dispose();

    expect(events.at(-1)?.kind).toBe('run-complete');
    expect(fixture.run.mock.calls.map(([request]) => request.args)).toEqual([
      ['scan'],
      expect.arrayContaining(['process', '--comment-out']),
    ]);
  });

  it('uses host-resolved selected review-scope paths for selected-file reviews', async () => {
    let filesFromContents = '';
    const fixture = createRuntimeContext({
      async run(request) {
        const filesFromIndex = request.args?.indexOf('--files-from') ?? -1;
        const filesFromPath = filesFromIndex >= 0 ? request.args?.[filesFromIndex + 1] : undefined;
        if (filesFromPath) filesFromContents = await readFile(filesFromPath, 'utf8');
        return processResult();
      },
    });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({
      runId: 'run-selected-scope',
      mode: 'selected_files',
      paths: ['src/auth.ts', 'src/api.ts'],
    }), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');

    const events = await watchToTerminal(opened);
    await opened.dispose();

    expect(events.at(-1)?.kind).toBe('run-complete');
    expect(filesFromContents).toBe('src/auth.ts\nsrc/api.ts\n');
  });

  it('rejects unsupported host SCM scope before readiness or executable resolution', async () => {
    const fixture = createRuntimeContext();
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({
      runId: 'run-unsupported-scope',
      scmReviewScope: {
        kind: 'review_scm_scope.v1',
        status: 'unsupported',
        scmBackendId: null,
        scmMode: null,
        repositoryRoot: null,
        worktreeRoot: null,
        baseRef: { source: 'unavailable', ref: null },
        selectedPaths: [],
        committedPaths: [],
        uncommittedPaths: [],
        changedPaths: [],
        diff: { committedAvailable: false, uncommittedAvailable: false },
        diagnostics: [{
          code: 'not_repository',
          severity: 'error',
          message: 'The selected path is not a source-control repository.',
        }],
      },
    }), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');

    const events = await watchToTerminal(opened);
    await opened.dispose();

    expect(events.at(-1)).toMatchObject({
      kind: 'run-failed',
      diagnostic: { message: expect.stringMatching(/source-control repository/i) },
    });
    expect(fixture.checkReadiness).not.toHaveBeenCalled();
    expect(fixture.resolve).not.toHaveBeenCalled();
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it('uses host Agent CLI readiness without undeclared system-tool probes', async () => {
    const fixture = createRuntimeContext();
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest(), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');

    const events = await watchToTerminal(opened);
    await opened.dispose();

    expect(fixture.checkReadiness).toHaveBeenCalledWith(expect.objectContaining({
      candidates: ['claude', 'codex'],
      requirement: 'any',
      cwd: '/repo',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      signal: expect.any(AbortSignal),
    }));
    expect(fixture.resolve.mock.calls.map(([request]) => request.toolId)).toEqual(['deepsec-cli']);
    expect(events.at(-1)?.kind).toBe('run-complete');
    expect(JSON.stringify(readStructuredOutput(events))).not.toContain('claude-or-codex');
  });

  it('honors an explicit gateway-key unset without reading ambient environment', async () => {
    vi.stubEnv('AI_GATEWAY_API_KEY', 'ambient-key-must-not-be-used');
    const fixture = createRuntimeContext();
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open({
      ...createOpenRequest({ runId: 'run-unset' }),
      launchEnvironment: {
        values: { AI_GATEWAY_API_KEY: 'projected-key' },
        unset: ['ai_gateway_api_key'],
      },
    }, fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');

    const events = await watchToTerminal(opened);
    await opened.dispose();

    expect(events.at(-1)?.kind).toBe('run-complete');
    expect(readStructuredOutput(events).readiness).toMatchObject({
      status: 'missing',
      missing: ['AI_GATEWAY_API_KEY'],
    });
    expect(fixture.resolve).toHaveBeenCalledOnce();
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it('cancels the managed process and publishes one native terminal event', async () => {
    const fixture = createRuntimeContext({
      async run(_request, options) {
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) return resolve();
          options?.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          ...processResult(),
          termination: {
            observed: { kind: 'signal', signal: 'SIGTERM' },
            requestedBy: { kind: 'abort' },
          },
        };
      },
    });
    const { runtime } = await createNativeDeepSecRuntime();
    const opened = await runtime.executionRuns?.open(createOpenRequest({ runId: 'run-cancel' }), fixture.context);
    if (!opened) throw new Error('Expected native DeepSec execution run');
    const events: AgentExecutionRunEvent[] = [];
    opened.watch((event) => events.push(event));

    await vi.waitFor(() => expect(fixture.run).toHaveBeenCalledOnce());
    await expect(opened.stop()).resolves.toEqual({ status: 'requested' });
    await vi.waitFor(() => expect(events.at(-1)?.kind).toBe('run-cancelled'));
    await opened.dispose();

    expect(events.filter((event) => ['run-complete', 'run-failed', 'run-cancelled'].includes(event.kind)))
      .toEqual([expect.objectContaining({ kind: 'run-cancelled' })]);
  });
});
