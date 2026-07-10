import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CreateExecutionRunBackendParamsV1,
  ExecLaunchInputV1,
  ExecRunResultV1,
  ExecutionRunHostMessageV1,
  PluginContextV1,
  PluginReviewCommentCreateRequestV1,
  PluginReviewCommentCreateResultV1,
  RegisterAgentRuntimeV1,
  ReviewCommentSnapshotV1,
  ReviewCommentV1,
  SystemToolLaunchGrantV1,
  SystemToolResolveRequestV1,
} from '@happier-dev/plugin-sdk';
import { ReviewFindingsV2Schema } from '@happier-dev/plugin-sdk/reviews';
import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';

function readRegisteredBackend(registerAgentRuntime: ReturnType<typeof vi.fn>): RegisterAgentRuntimeV1 {
  const registration = registerAgentRuntime.mock.calls[0]?.[0];
  if (!registration || typeof registration !== 'object') {
    throw new Error('Expected DeepSec activation to register a backend engine');
  }
  return registration as RegisterAgentRuntimeV1;
}

function createDeepSecComment(
  request: PluginReviewCommentCreateRequestV1,
  id = 'deepsec-comment-1',
): ReviewCommentV1 {
  const now = 123;
  return {
    v: 1,
    id,
    accountId: 'account-1',
    projectId: request.projectId,
    workspaceId: request.workspaceId,
    sessionId: request.sessionId,
    runId: request.runId,
    engineId: request.engineId,
    findingId: request.findingId,
    state: 'proposed',
    body: request.body,
    bodyVersion: 1,
    anchor: request.anchor,
    snapshot: request.snapshot,
    author: { kind: 'plugin', pluginId: 'review-deepsec', engineRunId: request.runId },
    flags: {},
    dispositions: {},
    threadId: id,
    evidence: request.evidence,
    transitions: [],
    fingerprint: request.fingerprint,
    createdAt: now,
    updatedAt: now,
    serverRevision: 1,
    edits: [],
    metadata: request.metadata,
  };
}

function createContextFixture(params?: Readonly<{
  grant?: SystemToolLaunchGrantV1;
  run?: (input: ExecLaunchInputV1) => Promise<ExecRunResultV1>;
  checkAgentCliReadiness?: (
    request: Readonly<{
      candidates: readonly string[];
      requirement: 'any' | 'all';
      cwd?: string;
      projectId?: string;
      workspaceId?: string;
    }>,
  ) => Promise<unknown>;
  createComment?: (
    request: PluginReviewCommentCreateRequestV1,
  ) => Promise<PluginReviewCommentCreateResultV1>;
  resolveSnapshot?: () => Promise<ReviewCommentSnapshotV1 | null>;
}>): Readonly<{
  ctx: PluginContextV1;
  resolve: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  checkAgentCliReadiness: ReturnType<typeof vi.fn>;
  createComment: ReturnType<typeof vi.fn>;
  resolveSnapshot: ReturnType<typeof vi.fn>;
  readText: ReturnType<typeof vi.fn>;
}> {
  const grant = params?.grant ?? {
    grantId: 'grant-1',
    toolId: 'deepsec',
    displayName: 'DeepSec',
    source: 'user_config' as const,
    executablePath: '/usr/local/bin/deepsec',
    launch: {
      kind: 'binary' as const,
      executablePath: '/usr/local/bin/deepsec',
      args: ['--quiet'],
    },
    expiresAt: null,
  };
  const resolve = vi.fn(async (_request: SystemToolResolveRequestV1) => grant);
  const run = vi.fn(params?.run ?? (async () => ({
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
  })));
  const checkAgentCliReadiness = vi.fn(params?.checkAgentCliReadiness ?? (async () => ({
    status: 'launchable',
    launchable: [{
      agentId: 'claude',
      status: 'launchable',
      source: 'system',
      scope: 'launch',
      checks: { launch: 'passed', auth: 'not_checked', buildPolicy: 'not_checked' },
    }],
    missing: [],
    blocked: [],
  })));
  const createComment = vi.fn(params?.createComment ?? (async (request) => ({
    comment: createDeepSecComment(request),
  })));
  const resolveSnapshot = vi.fn(params?.resolveSnapshot ?? (async () => ({
    kind: 'text' as const,
    selectedLines: ['  res.redirect(next);'],
    beforeContext: ['export function redirect(next: string) {'],
    afterContext: ['}'],
    selectedLinesHash: 'selected-hash',
    contextWindowHash: 'context-hash',
    capturedAt: 123,
    fileLength: 3,
    source: 'workingTree' as const,
    isUncommitted: true,
    isUntracked: false,
    truncated: false,
    hasBidiControls: false,
    likelyMinified: false,
  })));
    const readText = vi.fn(async () => [
        'export function redirect(next: string) {',
        '  res.redirect(next);',
        '}',
    ].join('\n'));
    const createTempDirectory = vi.fn(async () => {
      const directory = await mkdtemp(join(tmpdir(), 'happier-deepsec-test-'));
      return {
        path: directory,
        async createTextFile(input: { suffix?: string; contents: string }) {
          const path = join(directory, `${randomUUID()}${input.suffix ?? ''}`);
          await writeFile(path, input.contents, 'utf8');
          return path;
        },
        async createScopedPathListFile(input: { suffix?: string; paths: readonly string[] }) {
          const path = join(directory, `${randomUUID()}${input.suffix ?? ''}`);
          await writeFile(path, `${input.paths.join('\n')}\n`, 'utf8');
          return {
            status: 'created' as const,
            path,
            paths: input.paths,
          };
        },
        async readText(input: { path: string }) {
          return await readFile(input.path, 'utf8');
        },
        async cleanup() {
          await rm(directory, { recursive: true, force: true });
        },
      };
    });

  // Boundary fixture: the activation path uses only these PluginContext services.
  const ctx = {
    agentRuntime: {
      exec: {
        systemTools: { resolve },
        run,
      },
      agents: {
        cli: {
          checkReadiness: checkAgentCliReadiness,
        },
      },
    },
    reviews: {
      comments: {
        create: createComment,
        resolveSnapshot,
      },
    },
    fs: {
      readText,
      createTempDirectory,
    },
  } as unknown as PluginContextV1;

  return { ctx, resolve, run, checkAgentCliReadiness, createComment, resolveSnapshot, readText };
}

function modelOutput(messages: readonly ExecutionRunHostMessageV1[]): string {
  const output = messages.find((message): message is { type: 'model-output'; fullText: string } => (
    typeof message === 'object'
    && message !== null
    && (message as { type?: unknown }).type === 'model-output'
    && typeof (message as { fullText?: unknown }).fullText === 'string'
  ));
  if (!output) throw new Error('Expected a model-output message');
  return output.fullText;
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

describe('activate', () => {
  it('registers DeepSec as a review-only backend engine', async () => {
    const registerAgentRuntime = vi.fn();

    activate({ registerAgentRuntime });

    const registration = readRegisteredBackend(registerAgentRuntime);
    expect(registration.agentId).toBe('deepsec');

    const { ctx } = createContextFixture();
    const engine = await registration.create(ctx);
    await expect(engine.runtimeCore?.createSessionRuntime({
      sessionId: 'session-1',
      cwd: '/repo',
    })).rejects.toThrow(/review-only/i);
    expect(engine.runtimeCore?.createExecutionRunBackend({ cwd: '/repo' })).toMatchObject({
      readResumeSupport: expect.any(Function),
      provisionSession: expect.any(Function),
      sendPrompt: expect.any(Function),
      cancel: expect.any(Function),
      subscribeMessages: expect.any(Function),
      dispose: expect.any(Function),
    });
  });

  it('runs the DeepSec review pipeline through the activation backend', async () => {
    const commentOutMarkdown = `
### src/auth.ts:2

**Severity:** critical
**Rule:** CWE-601
**Category:** open_redirect

Validate redirect destinations before use.
`;
    const { ctx, resolve, run, createComment, resolveSnapshot, readText } = createContextFixture({
      async run(input) {
        if (input.kind !== 'binary') throw new Error('Expected DeepSec to launch as a binary');
        const commentOutIndex = input.args?.indexOf('--comment-out') ?? -1;
        const commentOutPath = commentOutIndex >= 0 ? input.args?.[commentOutIndex + 1] : undefined;
        if (commentOutPath) await writeFile(commentOutPath, commentOutMarkdown);
        return {
          exitCode: 0,
          signal: null,
          stdout: 'DeepSec completed',
          stderr: '',
        };
      },
    });
    const registerAgentRuntime = vi.fn();
    activate({ registerAgentRuntime });
    const registration = readRegisteredBackend(registerAgentRuntime);
    const engine = await registration.create(ctx);
    const executionRunParams = {
      cwd: '/repo',
      runId: 'run-1',
      start: {
        intentInput: {
          sessionId: 'session-1',
          projectId: 'project-1',
          workspaceId: 'workspace-1',
          engineIds: ['deepsec'],
          instructions: 'Review the current diff.',
          changeType: 'uncommitted',
          base: { kind: 'none' },
          scmReviewScope: createSupportedScmReviewScope(['src/auth.ts']),
          engines: {
            deepsec: { mode: 'current_diff', agentCli: 'both' },
          },
        },
      },
    } satisfies CreateExecutionRunBackendParamsV1 & {
      start: { intentInput: unknown };
    };
    const backend = engine.runtimeCore?.createExecutionRunBackend(executionRunParams);
    if (!backend || !('subscribeMessages' in backend)) {
      throw new Error('Expected DeepSec activation to create a host execution-run backend');
    }
    const messages: ExecutionRunHostMessageV1[] = [];
    const unsubscribe = backend.subscribeMessages((message) => {
      messages.push(message);
    });

    await expect(backend.provisionSession({ initialPrompt: 'Review the current diff.' }))
      .resolves.toEqual({ sessionId: expect.stringMatching(/^deepsec_/) });
    unsubscribe();
    await backend.dispose();

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'deepsec',
      purpose: 'review security findings',
      cwd: '/repo',
    }));
    expect(resolve.mock.calls.map(([request]) => request.toolId)).toEqual(['deepsec']);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'binary',
      executablePath: '/usr/local/bin/deepsec',
      cwd: '/repo',
      args: expect.arrayContaining(['process', '--diff', '--comment-out']),
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(readText).not.toHaveBeenCalled();
    expect(resolveSnapshot).toHaveBeenCalledWith({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      runId: 'run-1',
      engineId: 'deepsec',
      anchor: { kind: 'line', filePath: 'src/auth.ts', line: 2 },
    });
    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      runId: 'run-1',
      engineId: 'deepsec',
      authorIntent: 'propose',
      anchor: { kind: 'line', filePath: 'src/auth.ts', line: 2 },
      metadata: expect.objectContaining({
        severity: 'critical',
        taxonomyIds: ['CWE-601', 'open_redirect'],
      }),
    }));

    const structuredOutput = ReviewFindingsV2Schema.parse(JSON.parse(modelOutput(messages)));
    expect(structuredOutput).toMatchObject({
      runRef: {
        runId: 'run-1',
        callId: 'deepsec:run-1',
      },
      summary: expect.stringContaining('1'),
      findings: [
        expect.objectContaining({
          severity: 'blocker',
          category: 'security',
          filePath: 'src/auth.ts',
          startLine: 2,
          ruleId: 'CWE-601',
        }),
      ],
    });
  });

  it('uses host-resolved selected review-scope paths for selected-file reviews', async () => {
    let filesFromContents = '';
    const { ctx, run } = createContextFixture({
      async run(input) {
        if (input.kind !== 'binary') throw new Error('Expected DeepSec to launch as a binary');
        const filesFromIndex = input.args?.indexOf('--files-from') ?? -1;
        if (filesFromIndex >= 0) {
          const filesFromPath = input.args?.[filesFromIndex + 1];
          if (!filesFromPath) throw new Error('Expected --files-from path');
          filesFromContents = await readFile(filesFromPath, 'utf8');
        }
        return {
          exitCode: 0,
          signal: null,
          stdout: 'DeepSec completed',
          stderr: '',
        };
      },
    });
    const registerAgentRuntime = vi.fn();
    activate({ registerAgentRuntime });
    const registration = readRegisteredBackend(registerAgentRuntime);
    const engine = await registration.create(ctx);
    const backend = engine.runtimeCore?.createExecutionRunBackend({
      cwd: '/repo',
      runId: 'run-selected-scope',
      start: {
        intentInput: {
          sessionId: 'session-1',
          projectId: 'project-1',
          workspaceId: 'workspace-1',
          engineIds: ['deepsec'],
          instructions: 'Review selected files.',
          changeType: 'uncommitted',
          base: { kind: 'none' },
          engines: {
            deepsec: { mode: 'selected_files' },
          },
          scmReviewScope: createSupportedScmReviewScope(['src/auth.ts', 'src/api.ts']),
        },
      },
    } satisfies CreateExecutionRunBackendParamsV1 & {
      start: { intentInput: unknown };
    });
    if (!backend || !('provisionSession' in backend)) {
      throw new Error('Expected DeepSec activation to create a host execution-run backend');
    }

    await expect(backend.provisionSession({ initialPrompt: 'Review selected files.' }))
      .resolves.toEqual({ sessionId: expect.stringMatching(/^deepsec_/) });
    await backend.dispose();

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.arrayContaining(['process', '--files-from']),
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(filesFromContents).toBe('src/auth.ts\nsrc/api.ts\n');
  });

  it('rejects unsupported host SCM scope before resolving the DeepSec executable', async () => {
    const { ctx, resolve, run } = createContextFixture();
    const registerAgentRuntime = vi.fn();
    activate({ registerAgentRuntime });
    const registration = readRegisteredBackend(registerAgentRuntime);
    const engine = await registration.create(ctx);
    const backend = engine.runtimeCore?.createExecutionRunBackend({
      cwd: '/repo',
      runId: 'run-unsupported-scope',
      start: {
        intentInput: {
          sessionId: 'session-1',
          projectId: 'project-1',
          workspaceId: 'workspace-1',
          engineIds: ['deepsec'],
          instructions: 'Review current diff.',
          changeType: 'uncommitted',
          base: { kind: 'none' },
          engines: {
            deepsec: { mode: 'current_diff' },
          },
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
        },
      },
    } satisfies CreateExecutionRunBackendParamsV1 & {
      start: { intentInput: unknown };
    });
    if (!backend || !('provisionSession' in backend)) {
      throw new Error('Expected DeepSec activation to create a host execution-run backend');
    }

    await expect(backend.provisionSession({ initialPrompt: 'Review current diff.' }))
      .rejects.toThrow(/source-control repository/i);
    await backend.dispose();

    expect(resolve).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('uses host agent CLI readiness for default Claude-or-Codex support without undeclared system-tool probes', async () => {
    const { ctx, resolve, run, checkAgentCliReadiness, createComment } = createContextFixture();
    const registerAgentRuntime = vi.fn();
    activate({ registerAgentRuntime });
    const registration = readRegisteredBackend(registerAgentRuntime);
    const engine = await registration.create(ctx);
    const backend = engine.runtimeCore?.createExecutionRunBackend({
      cwd: '/repo',
      runId: 'run-1',
      start: {
        intentInput: {
          sessionId: 'session-1',
          projectId: 'project-1',
          engineIds: ['deepsec'],
          instructions: 'Review the current diff.',
          changeType: 'uncommitted',
          base: { kind: 'none' },
          scmReviewScope: createSupportedScmReviewScope(['src/auth.ts']),
          engines: {
            deepsec: { mode: 'current_diff' },
          },
        },
      },
    } as CreateExecutionRunBackendParamsV1 & { start: { intentInput: unknown } });
    if (!backend || !('subscribeMessages' in backend)) {
      throw new Error('Expected DeepSec activation to create a host execution-run backend');
    }
    const messages: ExecutionRunHostMessageV1[] = [];
    const unsubscribe = backend.subscribeMessages((message) => {
      messages.push(message);
    });

    await expect(backend.provisionSession({ initialPrompt: 'Review the current diff.' }))
      .resolves.toEqual({ sessionId: expect.stringMatching(/^deepsec_/) });
    unsubscribe();
    await backend.dispose();

    expect(resolve.mock.calls.map(([request]) => request.toolId)).toEqual(['deepsec']);
    expect(checkAgentCliReadiness).toHaveBeenCalledWith({
      candidates: ['claude', 'codex'],
      requirement: 'any',
      cwd: '/repo',
      projectId: 'project-1',
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'binary',
      executablePath: '/usr/local/bin/deepsec',
      cwd: '/repo',
      args: expect.arrayContaining(['process', '--diff', '--comment-out']),
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(createComment).not.toHaveBeenCalled();
    const structuredOutput = ReviewFindingsV2Schema.parse(JSON.parse(modelOutput(messages)));
    expect(structuredOutput).toMatchObject({
      runRef: {
        runId: 'run-1',
        callId: 'deepsec:run-1',
      },
      findings: [],
    });
    expect(JSON.stringify(structuredOutput)).not.toContain('claude-or-codex');
  });
});
