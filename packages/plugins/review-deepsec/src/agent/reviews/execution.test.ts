import type {
  ExecRunResultV1,
  PluginContextV1,
  SystemToolLaunchGrantV1,
} from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createDeepSecExecutionRunBackend } from './execution.js';

function createSupportedScmReviewScope(): unknown {
  const changedPath = {
    path: 'src/auth.ts',
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
    repositoryRoot: '/repo',
    worktreeRoot: '/repo',
    baseRef: { source: 'default_branch', ref: 'main' },
    selectedPaths: ['src/auth.ts'],
    committedPaths: [],
    uncommittedPaths: [changedPath],
    changedPaths: [changedPath],
    diff: { committedAvailable: false, uncommittedAvailable: true },
    diagnostics: [],
  };
}

function createPluginContextFixture() {
  const grant: SystemToolLaunchGrantV1 = {
    grantId: 'grant-1',
    toolId: 'deepsec',
    displayName: 'DeepSec',
    source: 'user_config',
    executablePath: '/tools/deepsec',
    launch: { kind: 'binary', executablePath: '/tools/deepsec' },
    expiresAt: null,
  };
  const run = vi.fn(async (): Promise<ExecRunResultV1> => ({
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
  }));
  const cleanup = vi.fn(async () => {});
  const createTempDirectory = vi.fn(async () => ({
    async createTextFile() {
      return '/tmp/deepsec-comments.md';
    },
    async createScopedPathListFile() {
      return {
        status: 'created' as const,
        path: '/tmp/deepsec-files.txt',
        paths: ['src/auth.ts'],
      };
    },
    async readText() {
      return [
        '### src/auth.ts',
        '',
        'Check auth.',
      ].join('\n');
    },
    cleanup,
  }));
  const checkReadiness = vi.fn(async () => ({
    launchable: [{ agentId: 'claude' }],
    unavailable: [],
    diagnostics: [],
  }));
  const ctx = {
    agents: {
      cli: {
        checkReadiness,
      },
    },
    env: {
      get: (key: string) => key === 'AI_GATEWAY_API_KEY' ? 'gateway-key' : undefined,
    },
    exec: {
      systemTools: {
        resolve: vi.fn(async () => grant),
      },
      run,
    },
    fs: {
      createTempDirectory,
    },
  } as unknown as PluginContextV1;

  return { ctx, run, cleanup, createTempDirectory, checkReadiness };
}

describe('createDeepSecExecutionRunBackend', () => {
  it('runs DeepSec review through the shared single-shot execution-run lifecycle', async () => {
    const { ctx, run, cleanup, createTempDirectory, checkReadiness } = createPluginContextFixture();
    const backend = createDeepSecExecutionRunBackend({
      ctx,
      executionRunParams: {
        cwd: '/repo',
        runId: 'run-deepsec',
        start: {
          intentInput: {
            engineIds: ['deepsec'],
            instructions: 'Review this change.',
            scmReviewScope: createSupportedScmReviewScope(),
            engines: {
              deepsec: { mode: 'current_diff' },
            },
          },
        },
      },
    });
    const messages: unknown[] = [];
    const unsubscribe = backend.subscribeMessages((message) => {
      messages.push(message);
    });

    await expect(backend.provisionSession({ initialPrompt: 'Review this change.' }))
      .resolves.toEqual({ sessionId: expect.stringMatching(/^deepsec_/) });
    unsubscribe();
    await backend.dispose();

    expect(checkReadiness).toHaveBeenCalledWith(expect.objectContaining({
      candidates: ['claude', 'codex'],
      requirement: 'any',
      cwd: '/repo',
    }));
    expect(createTempDirectory).toHaveBeenCalledWith({ prefix: 'happier-deepsec-' });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'binary',
      executablePath: '/tools/deepsec',
      cwd: '/repo',
      args: ['process', '--diff', '--comment-out', '/tmp/deepsec-comments.md'],
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(cleanup).toHaveBeenCalledOnce();
    expect(messages).toEqual([
      expect.objectContaining({
        type: 'model-output',
        fullText: expect.stringContaining('DeepSec review'),
      }),
    ]);
  });
});
