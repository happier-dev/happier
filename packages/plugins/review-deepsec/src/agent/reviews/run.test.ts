import type {
  PluginProcessResult,
  ResolvedSystemTool as PluginResolvedSystemTool,
} from '@happier-dev/plugin-sdk/exec';
import { describe, expect, it, vi } from 'vitest';

import { runDeepSecReview, type DeepSecTempFiles } from './run.js';

const resolvedTool: PluginResolvedSystemTool = {
  executable: { kind: 'systemTool', id: 'deepsec-cli' },
  executablePath: '/tools/deepsec',
};

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

function createTempFiles(overrides?: Partial<DeepSecTempFiles>): DeepSecTempFiles {
  return {
    async createTextFile() {
      return '/tmp/deepsec-comments.md';
    },
    async createScopedPathListFile({ paths }) {
      return { status: 'created', path: '/tmp/deepsec-files.txt', paths };
    },
    async readText() {
      return '';
    },
    async cleanup() {},
    ...overrides,
  };
}

describe('runDeepSecReview', () => {
  it.each(['current_diff', 'staged', 'working_tree', 'selected_files'] as const)(
    'preserves direct-mode findings on exit 1 (%s)', async mode => {
      const result = await runDeepSecReview({
        cwd: '/repo', mode, selectedFiles: ['src/auth.ts'], confirmedCostWarning: true,
        exec: { systemTools: { resolve: async () => resolvedTool }, run: async () => processResult(1) },
        tempFiles: createTempFiles({ readText: async () => '### src/auth.ts\n\nCheck auth.' }),
      });
      expect(result).toMatchObject({ status: 'completed', commentOutMarkdown: '### src/auth.ts\n\nCheck auth.' });
    },
  );

  it('does not treat a failed scan as direct-mode findings', async () => {
    const run = vi.fn(async () => processResult(1));
    const result = await runDeepSecReview({
      cwd: '/repo', mode: 'repository_security_audit', confirmedCostWarning: true,
      exec: { systemTools: { resolve: async () => resolvedTool }, run }, tempFiles: createTempFiles(),
    });
    expect(result.status).toBe('failed');
    expect(run).toHaveBeenCalledOnce();
  });

  it('keeps direct-mode exit 1 without a written finding report failed', async () => {
    const result = await runDeepSecReview({
      cwd: '/repo', mode: 'staged', confirmedCostWarning: true,
      exec: { systemTools: { resolve: async () => resolvedTool }, run: async () => processResult(1) },
      tempFiles: createTempFiles(),
    });
    expect(result.status).toBe('failed');
  });

  it('keeps requested cancellation from becoming completed findings', async () => {
    const result = await runDeepSecReview({
      cwd: '/repo', mode: 'staged', confirmedCostWarning: true,
      exec: { systemTools: { resolve: async () => resolvedTool }, run: async () => ({
        ...processResult(1), termination: { observed: { kind: 'exit', exitCode: 1 }, requestedBy: { kind: 'abort' } },
      }) }, tempFiles: createTempFiles(),
    });
    expect(result.status).toBe('failed');
  });

  it.each(['selected_files', 'current_diff'] as const)('runs the canonical file list and cleans temporary artifacts (%s)', async mode => {
    const resolve = vi.fn(async () => resolvedTool);
    const run = vi.fn(async () => processResult());
    const createScopedPathListFile = vi.fn(async ({ paths }: { paths: readonly string[] }) => ({
      status: 'created' as const,
      path: '/tmp/deepsec-files.txt',
      paths,
    }));
    const cleanup = vi.fn(async () => {});

    const result = await runDeepSecReview({
      cwd: '/repo',
      mode,
      selectedFiles: ['src/auth.ts', 'src/brand-new.ts', 'src/brand-new.test.ts'],
      confirmedCostWarning: true,
      environment: { AI_GATEWAY_API_KEY: 'gateway-key' },
      exec: { systemTools: { resolve }, run },
      tempFiles: createTempFiles({ createScopedPathListFile, cleanup }),
    });

    expect(result.status).toBe('completed');
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'deepsec-cli',
      purpose: 'review security findings',
      cwd: '/repo',
    }));
    expect(run).toHaveBeenCalledWith({
      executable: resolvedTool.executable,
      args: [
        'process',
        '--files-from',
        '/tmp/deepsec-files.txt',
        '--no-ignore',
        '--comment-out',
        '/tmp/deepsec-comments.md',
      ],
      cwd: { root: 'workspace', relativePath: '' },
      env: { AI_GATEWAY_API_KEY: 'gateway-key' },
    }, { signal: undefined });
    expect(createScopedPathListFile).toHaveBeenCalledWith({
      suffix: '.files.txt',
      paths: ['src/auth.ts', 'src/brand-new.ts', 'src/brand-new.test.ts'],
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('blocks expensive scopes before resolving or launching', async () => {
    const resolve = vi.fn(async () => resolvedTool);
    const run = vi.fn(async () => processResult());
    const createTextFile = vi.fn(async () => '/tmp/deepsec-comments.md');

    const result = await runDeepSecReview({
      cwd: '/repo',
      mode: 'repository_security_audit',
      confirmedCostWarning: false,
      exec: { systemTools: { resolve }, run },
      tempFiles: createTempFiles({ createTextFile }),
    });

    expect(result).toMatchObject({
      status: 'requires_confirmation',
      warning: { costClass: 'expensive', reason: 'repository_scan' },
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(createTextFile).not.toHaveBeenCalled();
  });

  it('returns readiness remediation before creating temporary artifacts or launching', async () => {
    const run = vi.fn(async () => processResult());
    const createTextFile = vi.fn(async () => '/tmp/deepsec-comments.md');
    const cleanup = vi.fn(async () => {});

    const result = await runDeepSecReview({
      cwd: '/repo',
      mode: 'current_diff',
      selectedFiles: ['src/auth.ts'],
      confirmedCostWarning: true,
      readiness: {
        toolRuntime: { kind: 'node', version: '20.19.0', majorVersion: 20, diagnostics: [] },
        agentCli: null,
      },
      exec: { systemTools: { resolve: async () => resolvedTool }, run },
      tempFiles: createTempFiles({ createTextFile, cleanup }),
    });

    expect(result).toEqual({
      status: 'readiness_failed',
      readiness: {
        status: 'missing',
        missing: ['node>=22', 'claude-or-codex'],
        toolRuntime: { kind: 'node', version: '20.19.0', majorVersion: 20, diagnostics: [] },
        installUrl: 'https://github.com/vercel-labs/deepsec',
        commandPreview: ['deepsec', '--help'],
        messageKey: 'plugins.deepsec.readiness.missing',
      },
      commentOutMarkdown: '',
    });
    expect(createTextFile).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('exports repository findings after processing instead of assuming a comment report exists', async () => {
    const run = vi.fn(async () => processResult());
    const cleanup = vi.fn(async () => {});

    const result = await runDeepSecReview({
      cwd: '/repo',
      mode: 'repository_security_audit',
      confirmedCostWarning: true,
      exec: { systemTools: { resolve: async () => resolvedTool }, run },
      tempFiles: createTempFiles({
        async readText(path) {
          return path.endsWith('.json') ? JSON.stringify([{
            title: '[HIGH] Missing authorization', description: '**File:** `src/auth.ts`\n\n## Finding\n\nCheck auth.\n\n## Recommendation\n\nRequire a role.',
            severity: 'HIGH', metadata: { filePath: 'src/auth.ts', lineNumbers: [2, 4], vulnSlug: 'missing-auth' },
          }]) : '';
        },
        cleanup,
      }),
    });

    expect(result).toMatchObject({ status: 'completed', exportedEntries: [{
      anchor: { kind: 'range', filePath: 'src/auth.ts', startLine: 2, endLine: 4 }, severity: 'HIGH', ruleId: 'missing-auth',
      body: 'Missing authorization\n\n**File:** `src/auth.ts`\n\n## Finding\n\nCheck auth.\n\n## Recommendation\n\nRequire a role.',
    }] });
    expect(run).toHaveBeenNthCalledWith(1, {
      executable: resolvedTool.executable,
      args: ['scan', '--root', '/repo'],
      cwd: { root: 'workspace', relativePath: '' },
      env: { DEEPSEC_DATA_ROOT: '/tmp/deepsec-comments.md.data' },
    }, { signal: undefined });
    expect(run).toHaveBeenNthCalledWith(2, {
      executable: resolvedTool.executable,
      args: ['process', '--root', '/repo'],
      cwd: { root: 'workspace', relativePath: '' },
      env: { DEEPSEC_DATA_ROOT: '/tmp/deepsec-comments.md.data' },
    }, { signal: undefined });
    expect(run).toHaveBeenNthCalledWith(3, expect.objectContaining({
      args: ['export', '--format', 'json', '--out', '/tmp/deepsec-comments.md.json'],
    }), { signal: undefined });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each(['', '{', '{}', '[{"title":"finding"}]', JSON.stringify([{
    title: 'Finding', description: 'Escaping anchor', severity: 'HIGH', metadata: { filePath: '../outside.ts', lineNumbers: [1] },
  }])])('refuses invalid repository export evidence (%j)', async exported => {
    await expect(runDeepSecReview({
      cwd: '/repo', mode: 'repository_security_audit', confirmedCostWarning: true,
      exec: { systemTools: { resolve: async () => resolvedTool }, run: async () => processResult() },
      tempFiles: createTempFiles({ readText: async () => exported }),
    })).rejects.toThrow();
  });

  it('accepts an explicit empty repository export as zero findings', async () => {
    const result = await runDeepSecReview({
      cwd: '/repo', mode: 'repository_security_audit', confirmedCostWarning: true,
      exec: { systemTools: { resolve: async () => resolvedTool }, run: async () => processResult() },
      tempFiles: createTempFiles({ readText: async () => '[]' }),
    });
    expect(result).toMatchObject({ status: 'completed', exportedEntries: [] });
  });

  it('keeps export process failure failed even when a file exists', async () => {
    const run = vi.fn().mockResolvedValueOnce(processResult()).mockResolvedValueOnce(processResult()).mockResolvedValueOnce(processResult(1));
    const result = await runDeepSecReview({
      cwd: '/repo', mode: 'repository_security_audit', confirmedCostWarning: true,
      exec: { systemTools: { resolve: async () => resolvedTool }, run }, tempFiles: createTempFiles({ readText: async () => '[]' }),
    });
    expect(result.status).toBe('failed');
  });

  it('reports repository audit process failure as partial', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(processResult())
      .mockResolvedValueOnce(processResult(2))
      .mockResolvedValueOnce(processResult());
    const cleanup = vi.fn(async () => {});

    const result = await runDeepSecReview({
      cwd: '/repo',
      mode: 'repository_security_audit',
      confirmedCostWarning: true,
      exec: { systemTools: { resolve: async () => resolvedTool }, run },
      tempFiles: createTempFiles({ cleanup, readText: async () => '[]' }),
    });

    expect(result).toMatchObject({
      status: 'partial',
      stage: 'process',
      exportedEntries: [],
      diagnostics: [{
        code: 'deepsec_process_failed',
        detail: { exitCode: 2, signal: null },
      }],
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('cleans temporary artifacts when execution rejects', async () => {
    const cleanup = vi.fn(async () => {});

    await expect(runDeepSecReview({
      cwd: '/repo',
      mode: 'current_diff',
      selectedFiles: ['src/auth.ts'],
      confirmedCostWarning: true,
      exec: {
        systemTools: { resolve: async () => resolvedTool },
        async run() {
          throw new Error('aborted');
        },
      },
      tempFiles: createTempFiles({ cleanup }),
    })).rejects.toThrow('aborted');

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('cleans the temporary workspace when system-tool resolution rejects', async () => {
    const cleanup = vi.fn(async () => {});

    await expect(runDeepSecReview({
      cwd: '/repo',
      mode: 'current_diff',
      selectedFiles: ['src/auth.ts'],
      confirmedCostWarning: true,
      exec: {
        systemTools: {
          async resolve() {
            throw new Error('resolver unavailable');
          },
        },
        async run() {
          return processResult();
        },
      },
      tempFiles: createTempFiles({ cleanup }),
    })).rejects.toThrow('resolver unavailable');

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('rejects invalid selected-file scopes before resolution', async () => {
    const resolve = vi.fn(async () => resolvedTool);
    const createTextFile = vi.fn(async () => '/tmp/deepsec-comments.md');
    const base = {
      cwd: '/repo',
      mode: 'selected_files' as const,
      confirmedCostWarning: true,
      exec: { systemTools: { resolve }, run: async () => processResult() },
      tempFiles: createTempFiles({ createTextFile }),
    };

    await expect(runDeepSecReview({ ...base, selectedFiles: [] }))
      .rejects.toThrow('selectedFiles must include at least one file path');
    await expect(runDeepSecReview({ ...base, selectedFiles: ['src/auth.ts\nsrc/extra.ts'] }))
      .rejects.toThrow('selectedFiles must be non-empty single-line paths');
    expect(resolve).not.toHaveBeenCalled();
    expect(createTextFile).not.toHaveBeenCalled();
  });

  it('fails closed when selected-file materialization blocks a path', async () => {
    const run = vi.fn(async () => processResult());
    const createTextFile = vi.fn(async () => '/tmp/deepsec-comments.md');
    const cleanup = vi.fn(async () => {});

    const result = await runDeepSecReview({
      cwd: '/repo',
      mode: 'selected_files',
      selectedFiles: ['src/outside/secret.ts'],
      confirmedCostWarning: true,
      exec: { systemTools: { resolve: async () => resolvedTool }, run },
      tempFiles: createTempFiles({
        async createScopedPathListFile() {
          return {
            status: 'blocked',
            diagnostics: [{
              code: 'path_escape',
              severity: 'error',
              messageKey: 'plugins.fs.scopedPathList.pathEscape',
              path: 'src/outside/secret.ts',
            }],
          };
        },
        createTextFile,
        cleanup,
      }),
    });

    expect(result).toEqual({
      status: 'selected_scope_failed',
      diagnostics: [{
        code: 'path_escape',
        severity: 'error',
        messageKey: 'plugins.fs.scopedPathList.pathEscape',
        path: 'src/outside/secret.ts',
      }],
      commentOutMarkdown: '',
    });
    expect(createTextFile).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
