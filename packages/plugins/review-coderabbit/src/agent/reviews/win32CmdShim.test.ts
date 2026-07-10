import type {
  ExecProcessHandleV1,
  ExecRunResultV1,
  PluginContextV1,
  SystemToolLaunchGrantV1,
} from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createCodeRabbitExecutionRunBackend } from './run.js';

function createPluginContextFixture(params?: Readonly<{
  grant?: SystemToolLaunchGrantV1;
  exit?: Promise<ExecRunResultV1>;
}>) {
  const grant = params?.grant ?? {
    grantId: 'grant-1',
    toolId: 'coderabbit',
    displayName: 'CodeRabbit',
    source: 'user_config',
    executablePath: 'C:\\Users\\me\\AppData\\Roaming\\npm\\coderabbit.CMD',
    launch: {
      kind: 'binary' as const,
      executablePath: 'C:\\Users\\me\\AppData\\Roaming\\npm\\coderabbit.CMD',
    },
    expiresAt: null,
  };
  const processHandle: ExecProcessHandleV1 = {
    pid: 123,
    exit: params?.exit ?? Promise.resolve({
      exitCode: 0,
      signal: null,
      stdout: 'plain review output',
      stderr: '',
    }),
    writeStdin: vi.fn(async () => undefined),
    kill: vi.fn(),
    dispose: vi.fn(async () => undefined),
  };
  const ctx = {
    agentRuntime: {
      exec: {
        systemTools: {
          resolve: vi.fn(async () => grant),
        },
        spawn: vi.fn(async () => processHandle),
      },
    },
  } as unknown as PluginContextV1;

  return { ctx };
}

function createSupportedScmReviewScope(): unknown {
  const path = 'src/auth.ts';
  const entry = {
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
  };
  return {
    kind: 'review_scm_scope.v1',
    status: 'supported',
    scmBackendId: 'git',
    scmMode: '.git',
    repositoryRoot: 'C:\\repo',
    worktreeRoot: 'C:\\repo',
    baseRef: { source: 'default_branch', ref: 'main' },
    selectedPaths: [path],
    committedPaths: [],
    uncommittedPaths: [entry],
    changedPaths: [entry],
    diff: { committedAvailable: false, uncommittedAvailable: true },
    diagnostics: [],
  };
}

describe('CodeRabbit Windows command shim routing', () => {
  it('routes absolute .CMD overrides as host-validated preferred paths', async () => {
    const cmdPath = 'C:\\Users\\me\\AppData\\Roaming\\npm\\coderabbit.CMD';
    const { ctx } = createPluginContextFixture();
    const backend = createCodeRabbitExecutionRunBackend({
      ctx,
      executionRunParams: {
        cwd: 'C:\\repo',
        env: {
          HAPPIER_CODERABBIT_REVIEW_CMD: cmdPath,
        },
        runId: 'run-win32-cmd',
        start: {
          intentInput: {
            engineIds: ['coderabbit'],
            instructions: 'Review this change.',
            changeType: 'uncommitted',
            base: { kind: 'none' },
            scmReviewScope: createSupportedScmReviewScope(),
          },
        },
      } as never,
    });

    await expect(backend.provisionSession({ initialPrompt: 'Review this change.' }))
      .resolves.toEqual({ sessionId: expect.stringMatching(/^coderabbit_/) });

    expect(ctx.agentRuntime.exec.systemTools.resolve).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'coderabbit',
      preferredPath: cmdPath,
      preferredCommand: null,
    }));
  });
});
