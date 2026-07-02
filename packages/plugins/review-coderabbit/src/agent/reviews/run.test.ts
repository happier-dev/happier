import type {
  ExecProcessHandleV1,
  ExecRunResultV1,
  PluginReviewCommentCreateRequestV1,
  PluginReviewCommentCreateResultV1,
  PluginContextV1,
  ReviewCommentV1,
  SystemToolLaunchGrantV1,
} from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createCodeRabbitExecutionRunBackend } from './run.js';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function createPluginContextFixture(params?: Readonly<{
  grant?: SystemToolLaunchGrantV1;
  exit?: Promise<ExecRunResultV1>;
}>) {
  const exitDeferred = createDeferred<ExecRunResultV1>();
  const killed: string[] = [];
  const grant = params?.grant ?? {
    grantId: 'grant-1',
    toolId: 'coderabbit',
    displayName: 'CodeRabbit',
    source: 'user_config',
    executablePath: '/usr/local/bin/coderabbit',
    launch: {
      kind: 'binary' as const,
      executablePath: '/usr/local/bin/coderabbit',
    },
    expiresAt: null,
  };
  const processHandle: ExecProcessHandleV1 = {
    pid: 123,
    exit: params?.exit ?? exitDeferred.promise,
    writeStdin: vi.fn(async () => undefined),
    kill: vi.fn((signal?: string) => {
      killed.push(signal ?? '');
      exitDeferred.resolve({
        exitCode: null,
        signal: signal ?? 'SIGTERM',
        stdout: '',
        stderr: 'cancelled',
      });
    }),
    dispose: vi.fn(async () => undefined),
  };
  const createComment = vi.fn(async (
    request: PluginReviewCommentCreateRequestV1,
  ): Promise<PluginReviewCommentCreateResultV1> => {
    const comment: ReviewCommentV1 = {
      v: 1,
      id: `comment-${createComment.mock.calls.length}`,
      accountId: 'account-1',
      projectId: request.projectId,
      workspaceId: request.workspaceId,
      sessionId: request.sessionId,
      runId: request.runId,
      engineId: request.engineId,
      findingId: request.findingId,
      anchor: request.anchor,
      snapshot: request.snapshot,
      body: request.body,
      bodyVersion: 1,
      edits: [],
      author: { kind: 'plugin', pluginId: 'review-coderabbit', engineRunId: request.runId },
      state: 'proposed',
      flags: {},
      dispositions: {},
      threadId: `comment-${createComment.mock.calls.length}`,
      evidence: request.evidence,
      transitions: [{
        transitionId: `transition-${createComment.mock.calls.length}`,
        toState: 'proposed',
        transitionedAt: 1,
        transitionedBy: { kind: 'plugin', pluginId: 'review-coderabbit', engineRunId: request.runId },
        serverRevision: 1,
      }],
      fingerprint: request.fingerprint,
      linkedRefs: request.linkedRefs,
      suggestedFix: request.suggestedFix,
      createdAt: 1,
      updatedAt: 1,
      serverRevision: 1,
      metadata: request.metadata,
    };
    return { comment };
  });
  const readText = vi.fn(async () => Array.from(
    { length: 20 },
    (_, index) => `line ${index + 1}`,
  ).join('\n'));
  const resolveSnapshot = vi.fn(async () => ({
    kind: 'text' as const,
    selectedLines: ['host snapshot line'],
    beforeContext: [],
    afterContext: [],
    selectedLinesHash: 'host-selected',
    contextWindowHash: 'host-context',
    capturedAt: 1,
    fileLength: 1,
    source: 'workingTree' as const,
    isUncommitted: true,
    isUntracked: false,
    truncated: false,
    hasBidiControls: false,
    likelyMinified: false,
  }));
  const ctx = {
    exec: {
      systemTools: {
        resolve: vi.fn(async () => grant),
      },
      spawn: vi.fn(async () => processHandle),
    },
    fs: {
      readText,
    },
    reviews: {
      comments: {
        create: createComment,
        resolveSnapshot,
      },
    },
  } as unknown as PluginContextV1;

  return { ctx, grant, processHandle, exitDeferred, killed, createComment, readText, resolveSnapshot };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createSupportedScmReviewScope(paths: readonly string[] = ['src/auth.ts']): unknown {
  const changedPaths = paths.map((path) => ({
    path,
    previousPath: null,
    kind: 'modified',
    hasCommittedDelta: false,
    hasUncommittedDelta: true,
    diff: {
      committedAvailable: false,
      uncommittedAvailable: true,
      isBinary: false,
    },
  }));
  return {
    kind: 'review_scm_scope.v1',
    status: 'supported',
    scmBackendId: 'git',
    scmMode: '.git',
    repositoryRoot: '/workspace',
    worktreeRoot: '/workspace',
    baseRef: { source: 'default_branch', ref: 'main' },
    selectedPaths: paths,
    committedPaths: [],
    uncommittedPaths: changedPaths,
    changedPaths,
    diff: { committedAvailable: false, uncommittedAvailable: true },
    diagnostics: [],
  };
}

describe('createCodeRabbitExecutionRunBackend', () => {
  it('fails unsupported host SCM scope before resolving the CodeRabbit tool', async () => {
    const { ctx } = createPluginContextFixture({
      exit: Promise.resolve({
        exitCode: 0,
        signal: null,
        stdout: 'should not run',
        stderr: '',
      }),
    });
    const backend = createCodeRabbitExecutionRunBackend({
      ctx,
      executionRunParams: {
        cwd: '/workspace',
        runId: 'run-unsupported-scope',
        start: {
          intentInput: {
            engineIds: ['coderabbit'],
            instructions: 'Review this change.',
            changeType: 'uncommitted',
            base: { kind: 'none' },
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
      } as never,
    });

    await expect(backend.provisionSession({ initialPrompt: 'Review this change.' }))
      .rejects.toThrow(/source-control repository/i);
    expect(ctx.exec.systemTools.resolve).not.toHaveBeenCalled();
    expect(ctx.exec.spawn).not.toHaveBeenCalled();
  });

  it('resolves CodeRabbit through host system-tool grants and spawns the granted launch', async () => {
    const { ctx, exitDeferred } = createPluginContextFixture();
    const backend = createCodeRabbitExecutionRunBackend({
      ctx,
      executionRunParams: {
        cwd: '/workspace',
        env: {
          HAPPIER_CODERABBIT_REVIEW_CMD: '/usr/local/bin/coderabbit',
          HAPPIER_CODERABBIT_HOME_DIR: '/tmp/coderabbit-home',
        },
        runId: 'run-1',
        start: {
          intentInput: {
            engineIds: ['coderabbit'],
            instructions: 'Review this change.',
            changeType: 'uncommitted',
            base: { kind: 'none' },
            scmReviewScope: createSupportedScmReviewScope(['src/auth.ts']),
            engines: { coderabbit: { configFiles: ['coderabbit.yaml'], promptOnly: true } },
          },
        },
      } as never,
    });
    const messages: unknown[] = [];
    const unsubscribe = backend.subscribeMessages((message) => {
      messages.push(message);
    });

    const provisioned = backend.provisionSession({ initialPrompt: 'Review this change.' });
    await Promise.resolve();
    exitDeferred.resolve({
      exitCode: 0,
      signal: null,
      stdout: 'plain review output',
      stderr: '',
    });

    await expect(provisioned).resolves.toEqual({ sessionId: expect.stringMatching(/^coderabbit_/) });
    unsubscribe();
    await backend.dispose();

    expect(ctx.exec.systemTools.resolve).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'coderabbit',
      purpose: 'run CodeRabbit review',
      cwd: '/workspace',
      preferredPath: '/usr/local/bin/coderabbit',
    }));
    expect(ctx.exec.spawn).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'binary',
      executablePath: '/usr/local/bin/coderabbit',
      cwd: '/workspace',
      args: expect.arrayContaining([
        'review',
        '--no-color',
        '--cwd',
        '/workspace',
        '--type',
        'uncommitted',
        '--plain',
        '--prompt-only',
        '--config',
        'coderabbit.yaml',
      ]),
      env: expect.objectContaining({
        CODERABBIT_HOME: '/tmp/coderabbit-home/.coderabbit',
      }),
    }), expect.objectContaining({ timeoutMs: undefined }));
    expect(messages).toContainEqual({
      type: 'model-output',
      fullText: JSON.stringify({
        summary: 'CodeRabbit review: no findings.',
        overviewMarkdown: 'CodeRabbit review: no findings.\n\nParsed 0 finding(s) from CodeRabbit plain output.',
        findings: [],
        questions: [],
        assumptions: [],
      }),
    });
  });

  it('redacts secret values from CodeRabbit failure diagnostics', async () => {
    const secret = 'cr_secret_123';
    const { ctx } = createPluginContextFixture({
      exit: Promise.resolve({
        exitCode: 2,
        signal: null,
        stdout: '',
        stderr: `CODERABBIT_API_KEY=${secret} failed with --api-key ${secret}`,
      }),
    });
    const backend = createCodeRabbitExecutionRunBackend({
      ctx,
      executionRunParams: {
        cwd: '/workspace',
        env: {
          CODERABBIT_API_KEY: secret,
        },
        runId: 'run-secret-redaction',
        start: {
          intentInput: {
            engineIds: ['coderabbit'],
            instructions: 'Review this change.',
            changeType: 'uncommitted',
            base: { kind: 'none' },
            scmReviewScope: createSupportedScmReviewScope(['src/auth.ts']),
          },
        },
      } as never,
    });

    let failure: unknown;
    try {
      await backend.provisionSession({ initialPrompt: 'Review this change.' });
    } catch (error) {
      failure = error;
    }
    const message = failure instanceof Error ? failure.message : String(failure);

    expect(message).toContain('CodeRabbit exited with code 2');
    expect(message).toContain('[redacted]');
    expect(message).not.toContain(secret);
    expect(message).not.toContain(`CODERABBIT_API_KEY=${secret}`);
  });

  it('converts CodeRabbit plain stdout into generic review JSON output', async () => {
    const { ctx } = createPluginContextFixture({
      exit: Promise.resolve({
        exitCode: 0,
        signal: null,
        stdout: [
          '==============================',
          'File: src/auth.ts',
          'Line: 10 to 12',
          'Type: Security',
          'Comment:',
          'Validate the redirect target before use.',
          'Prompt for AI Agent:',
          'Add an allow-list check.',
          '==============================',
        ].join('\n'),
        stderr: '',
      }),
    });
    const backend = createCodeRabbitExecutionRunBackend({
      ctx,
      executionRunParams: {
        cwd: '/workspace',
        runId: 'run-json-output',
        start: {
          intentInput: {
            engineIds: ['coderabbit'],
            instructions: 'Review this change.',
            changeType: 'uncommitted',
            base: { kind: 'none' },
            scmReviewScope: createSupportedScmReviewScope(['src/auth.ts']),
          },
        },
      } as never,
    });
    const messages: unknown[] = [];
    const unsubscribe = backend.subscribeMessages((message) => {
      messages.push(message);
    });

    await expect(backend.provisionSession({ initialPrompt: 'Review this change.' }))
      .resolves.toEqual({ sessionId: expect.stringMatching(/^coderabbit_/) });
    unsubscribe();
    await backend.dispose();

    const output = messages.find((message): message is { type: 'model-output'; fullText: string } => (
      typeof message === 'object'
      && message !== null
      && (message as { type?: unknown }).type === 'model-output'
      && typeof (message as { fullText?: unknown }).fullText === 'string'
    ));
    expect(output).toBeTruthy();
    const parsed = JSON.parse(output!.fullText) as {
      summary?: unknown;
      overviewMarkdown?: unknown;
      findings?: unknown[];
    };
    expect(parsed).toMatchObject({
      summary: 'CodeRabbit review: 1 finding(s).',
      overviewMarkdown: expect.stringContaining('CodeRabbit plain output'),
      findings: [
        expect.objectContaining({
          severity: 'blocker',
          category: 'security',
          filePath: 'src/auth.ts',
          startLine: 10,
          endLine: 12,
          summary: 'Validate the redirect target before use.',
          suggestion: 'Add an allow-list check.',
        }),
      ],
    });
  });

  it('persists parsed CodeRabbit plain findings with host-resolved snapshots when projectId is present', async () => {
    const { ctx, createComment, readText, resolveSnapshot } = createPluginContextFixture({
      exit: Promise.resolve({
        exitCode: 0,
        signal: null,
        stdout: [
          '==============================',
          'File: src/auth.ts',
          'Line: 10 to 12',
          'Type: Security',
          'Comment:',
          'Validate the redirect target before use.',
          'Prompt for AI Agent:',
          'Add an allow-list check.',
          '==============================',
        ].join('\n'),
        stderr: '',
      }),
    });
    const backend = createCodeRabbitExecutionRunBackend({
      ctx,
      executionRunParams: {
        cwd: '/workspace',
        runId: 'run-comments',
        start: {
          intentInput: {
            projectId: 'project-1',
            workspaceId: 'workspace-1',
            sessionId: 'session-1',
            engineIds: ['coderabbit'],
            instructions: 'Review this change.',
            changeType: 'uncommitted',
            base: { kind: 'none' },
            scmReviewScope: createSupportedScmReviewScope(['src/auth.ts']),
          },
        },
      } as never,
    });

    await expect(backend.provisionSession({ initialPrompt: 'Review this change.' }))
      .resolves.toEqual({ sessionId: expect.stringMatching(/^coderabbit_/) });
    await backend.dispose();

    expect(readText).not.toHaveBeenCalled();
    expect(resolveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/workspace',
      anchor: { kind: 'range', filePath: 'src/auth.ts', startLine: 10, endLine: 12 },
      finding: expect.objectContaining({
        id: 'coderabbit-1',
        filePath: 'src/auth.ts',
      }),
    }));
    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      runId: 'run-comments',
      engineId: 'coderabbit',
      findingId: 'coderabbit-1',
      body: 'Validate the redirect target before use.',
      authorIntent: 'propose',
      anchor: { kind: 'range', filePath: 'src/auth.ts', startLine: 10, endLine: 12 },
      snapshot: expect.objectContaining({
        kind: 'text',
        selectedLines: ['host snapshot line'],
      }),
      metadata: expect.objectContaining({
        severity: 'critical',
        tags: ['coderabbit'],
      }),
    }));
  });

  it('routes non-absolute command overrides through host-declared preferredCommand', async () => {
    const { ctx } = createPluginContextFixture({
      exit: Promise.resolve({
        exitCode: 0,
        signal: null,
        stdout: 'plain review output',
        stderr: '',
      }),
    });
    const backend = createCodeRabbitExecutionRunBackend({
      ctx,
      executionRunParams: {
        cwd: '/workspace',
        env: {
          HAPPIER_CODERABBIT_REVIEW_CMD: 'coderabbit',
        },
        runId: 'run-absolute-override',
        start: {
          intentInput: {
            engineIds: ['coderabbit'],
            instructions: 'Review this change.',
            changeType: 'uncommitted',
            base: { kind: 'none' },
            scmReviewScope: createSupportedScmReviewScope(['src/auth.ts']),
          },
        },
      } as never,
    });

    await expect(backend.provisionSession({ initialPrompt: 'Review this change.' }))
      .resolves.toEqual({ sessionId: expect.stringMatching(/^coderabbit_/) });

    expect(ctx.exec.systemTools.resolve).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'coderabbit',
      preferredPath: null,
      preferredCommand: 'coderabbit',
    }));
  });

  it('cancels through the host process handle and waits for process settlement', async () => {
    const { ctx, processHandle } = createPluginContextFixture();
    const backend = createCodeRabbitExecutionRunBackend({
      ctx,
      executionRunParams: {
        cwd: '/workspace',
        runId: 'run-2',
        start: {
          intentInput: {
            engineIds: ['coderabbit'],
            instructions: 'Review this change.',
            changeType: 'uncommitted',
            base: { kind: 'none' },
            scmReviewScope: createSupportedScmReviewScope(['src/auth.ts']),
          },
        },
      } as never,
    });

    const started = await backend.provisionSession();
    const prompt = backend.sendPrompt(started.sessionId, 'Review this change.')
      .then(() => ({ ok: true as const }), (error) => ({ ok: false as const, error }));
    await waitFor(() => vi.mocked(ctx.exec.spawn).mock.calls.length > 0);
    await backend.cancel(started.sessionId);

    await expect(prompt).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ message: expect.stringMatching(/cancelled/i) }),
    });
    expect(processHandle.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('cancels promptly while waiting for CodeRabbit rate-limit retry backoff', async () => {
    const { ctx } = createPluginContextFixture({
      exit: Promise.resolve({
        ok: false,
        exitCode: 1,
        signal: null,
        stdout: '',
        stderr: 'Rate limit exceeded, please try after 0 minutes and 0 seconds',
      } as ExecRunResultV1),
    });
    const backend = createCodeRabbitExecutionRunBackend({
      ctx,
      executionRunParams: {
        cwd: '/workspace',
        runId: 'run-rate-limit-cancel',
        start: {
          intentInput: {
            engineIds: ['coderabbit'],
            instructions: 'Review this change.',
            changeType: 'uncommitted',
            base: { kind: 'none' },
            scmReviewScope: createSupportedScmReviewScope(['src/auth.ts']),
          },
        },
      } as never,
    });

    const started = await backend.provisionSession();
    const prompt = backend.sendPrompt(started.sessionId, 'Review this change.')
      .then(() => ({ ok: true as const }), (error) => ({ ok: false as const, error }));
    await waitFor(() => vi.mocked(ctx.exec.spawn).mock.calls.length > 0);

    await expect(withTimeout(backend.cancel(started.sessionId), 100)).resolves.toBeUndefined();
    await expect(prompt).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ message: expect.stringMatching(/cancelled|aborted/i) }),
    });
  });
});
