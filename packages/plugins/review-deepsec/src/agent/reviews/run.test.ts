import type {
  PluginProcessResult,
  PluginResolvedSystemTool,
} from '@happier-dev/plugin-sdk/runtime';
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
  it('runs the resolved managed executable and cleans temporary artifacts', async () => {
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
      mode: 'selected_files',
      selectedFiles: ['src/auth.ts', 'src/api.ts'],
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
        '--comment-out',
        '/tmp/deepsec-comments.md',
      ],
      cwd: { root: 'workspace', relativePath: '' },
      env: { AI_GATEWAY_API_KEY: 'gateway-key' },
    }, { signal: undefined });
    expect(createScopedPathListFile).toHaveBeenCalledWith({
      suffix: '.files.txt',
      paths: ['src/auth.ts', 'src/api.ts'],
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
      confirmedCostWarning: true,
      readiness: {
        toolRuntime: { kind: 'node', version: '20.19.0', majorVersion: 20, diagnostics: [] },
        agentCli: null,
        hasGatewayKey: false,
      },
      exec: { systemTools: { resolve: async () => resolvedTool }, run },
      tempFiles: createTempFiles({ createTextFile, cleanup }),
    });

    expect(result).toEqual({
      status: 'readiness_failed',
      readiness: {
        status: 'missing',
        missing: ['node>=22', 'claude-or-codex', 'AI_GATEWAY_API_KEY'],
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

  it('runs repository audits as scan then process', async () => {
    const run = vi.fn(async () => processResult());
    const cleanup = vi.fn(async () => {});

    const result = await runDeepSecReview({
      cwd: '/repo',
      mode: 'repository_security_audit',
      confirmedCostWarning: true,
      exec: { systemTools: { resolve: async () => resolvedTool }, run },
      tempFiles: createTempFiles({
        async readText() {
          return '### src/auth.ts\n\nCheck auth.';
        },
        cleanup,
      }),
    });

    expect(result).toMatchObject({ status: 'completed', commentOutMarkdown: '### src/auth.ts\n\nCheck auth.' });
    expect(run).toHaveBeenNthCalledWith(1, {
      executable: resolvedTool.executable,
      args: ['scan'],
      cwd: { root: 'workspace', relativePath: '' },
    }, { signal: undefined });
    expect(run).toHaveBeenNthCalledWith(2, {
      executable: resolvedTool.executable,
      args: ['process', '--comment-out', '/tmp/deepsec-comments.md'],
      cwd: { root: 'workspace', relativePath: '' },
    }, { signal: undefined });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('reports repository audit process failure as partial', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(processResult())
      .mockResolvedValueOnce(processResult(2));
    const cleanup = vi.fn(async () => {});

    const result = await runDeepSecReview({
      cwd: '/repo',
      mode: 'repository_security_audit',
      confirmedCostWarning: true,
      exec: { systemTools: { resolve: async () => resolvedTool }, run },
      tempFiles: createTempFiles({ cleanup }),
    });

    expect(result).toMatchObject({
      status: 'partial',
      stage: 'process',
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

  it('rejects unsafe selected-file paths before resolution', async () => {
    const resolve = vi.fn(async () => resolvedTool);
    const base = {
      cwd: '/repo',
      mode: 'selected_files' as const,
      confirmedCostWarning: true,
      exec: { systemTools: { resolve }, run: async () => processResult() },
      tempFiles: createTempFiles(),
    };

    for (const selectedFile of [
      '/etc/passwd',
      '../secret.ts',
      'src/../secret.ts',
      'C:\\Users\\alice\\secret.ts',
      '\\\\server\\share\\secret.ts',
      '~/.ssh/config',
      'src/\0secret.ts',
    ]) {
      await expect(runDeepSecReview({ ...base, selectedFiles: [selectedFile] }))
        .rejects.toThrow('selectedFiles must be safe workspace-relative paths');
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it('deduplicates selected-file paths before writing the list', async () => {
    let filesListContents = '';
    const createScopedPathListFile = vi.fn(async ({ paths }: { paths: readonly string[] }) => {
      filesListContents = `${paths.join('\n')}\n`;
      return { status: 'created' as const, path: '/tmp/deepsec-files.txt', paths };
    });

    await runDeepSecReview({
      cwd: '/repo',
      mode: 'selected_files',
      selectedFiles: [' src/auth.ts ', 'src\\auth.ts', './src/api.ts'],
      confirmedCostWarning: true,
      exec: { systemTools: { resolve: async () => resolvedTool }, run: async () => processResult() },
      tempFiles: createTempFiles({ createScopedPathListFile }),
    });

    expect(filesListContents).toBe('src/auth.ts\nsrc/api.ts\n');
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
