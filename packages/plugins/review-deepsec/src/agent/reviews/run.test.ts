import type {
  ExecRunResultV1,
  SystemToolLaunchGrantV1,
  SystemToolResolveRequestV1,
} from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import { runDeepSecReview } from './run.js';

describe('runDeepSecReview', () => {
  it('runs through a host-granted system tool launch and cleans temp artifacts', async () => {
    const grant: SystemToolLaunchGrantV1 = {
      grantId: 'grant-1',
      toolId: 'deepsec',
      displayName: 'DeepSec',
      source: 'user_config',
      executablePath: '/tools/deepsec',
      launch: { kind: 'binary', executablePath: '/tools/deepsec', args: ['--quiet'] },
      expiresAt: null,
    };
    const resolve = vi.fn(async (_request: SystemToolResolveRequestV1) => grant);
    const run = vi.fn(async (): Promise<ExecRunResultV1> => ({
      exitCode: 0,
      signal: null,
      stdout: 'ok',
      stderr: '',
    }));
    const createScopedPathListFile = vi.fn(async () => ({
      status: 'created' as const,
      path: '/tmp/deepsec-files.txt',
      paths: ['src/auth.ts', 'src/api.ts'],
    }));
    const cleanup = vi.fn(async () => {});

    const result = await runDeepSecReview({
      cwd: '/repo',
      mode: 'selected_files',
      selectedFiles: ['src/auth.ts', 'src/api.ts'],
      confirmedCostWarning: true,
      exec: {
        systemTools: { resolve },
        run,
      },
      tempFiles: {
        createScopedPathListFile,
        async createTextFile({ suffix }) {
          return suffix === '.comments.md' ? '/tmp/deepsec-comments.md' : '/tmp/unused';
        },
        async readText() {
          return '';
        },
        cleanup,
      },
    });

    expect(result.status).toBe('completed');
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      toolId: 'deepsec',
      purpose: 'review security findings',
      cwd: '/repo',
    }));
    expect(run).toHaveBeenCalledWith({
      kind: 'binary',
      executablePath: '/tools/deepsec',
      args: [
        '--quiet',
        'process',
        '--files-from',
        '/tmp/deepsec-files.txt',
        '--comment-out',
        '/tmp/deepsec-comments.md',
      ],
      cwd: '/repo',
    }, expect.objectContaining({ signal: undefined }));
    expect(createScopedPathListFile).toHaveBeenCalledWith({
      suffix: '.files.txt',
      paths: ['src/auth.ts', 'src/api.ts'],
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('blocks expensive scopes until the caller explicitly confirms cost', async () => {
    const result = await runDeepSecReview({
      cwd: '/repo',
      mode: 'repository_security_audit',
      confirmedCostWarning: false,
      exec: {
        systemTools: {
          async resolve() {
            throw new Error('should not resolve before confirmation');
          },
        },
        async run() {
          throw new Error('should not run before confirmation');
        },
      },
      tempFiles: {
        async createTextFile() {
          throw new Error('should not create temp files before confirmation');
        },
        async readText() {
          return '';
        },
        async cleanup() {},
      },
    });

    expect(result).toMatchObject({
      status: 'requires_confirmation',
      warning: {
        status: 'requires_confirmation',
        costClass: 'expensive',
        reason: 'repository_scan',
      },
    });
  });

  it('returns structured readiness remediation before creating temp artifacts or launching DeepSec', async () => {
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
    const createTextFile = vi.fn(async () => '/tmp/deepsec-comments.md');
    const cleanup = vi.fn(async () => {});

    const result = await runDeepSecReview({
      cwd: '/repo',
      mode: 'current_diff',
      confirmedCostWarning: true,
      readiness: {
        toolRuntime: {
          kind: 'node',
          version: '20.19.0',
          majorVersion: 20,
          diagnostics: [],
        },
        agentCli: null,
        hasGatewayKey: false,
      },
      exec: {
        systemTools: { resolve: async () => grant },
        run,
      },
      tempFiles: {
        createTextFile,
        async readText() {
          return '';
        },
        cleanup,
      },
    });

    expect(result).toEqual({
      status: 'readiness_failed',
      readiness: {
        status: 'missing',
        missing: ['node>=22', 'claude-or-codex', 'AI_GATEWAY_API_KEY'],
        toolRuntime: {
          kind: 'node',
          version: '20.19.0',
          majorVersion: 20,
          diagnostics: [],
        },
        installUrl: 'https://github.com/relari-ai/deepsec',
        commandPreview: ['deepsec', '--help'],
        messageKey: 'plugins.deepsec.readiness.missing',
      },
      commentOutMarkdown: '',
    });
    expect(createTextFile).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('runs repository security audits as scan then process and cleans comment artifacts', async () => {
    const grant: SystemToolLaunchGrantV1 = {
      grantId: 'grant-1',
      toolId: 'deepsec',
      displayName: 'DeepSec',
      source: 'user_config',
      executablePath: '/tools/deepsec',
      launch: { kind: 'binary', executablePath: '/tools/deepsec', args: ['--quiet'] },
      expiresAt: null,
    };
    const run = vi.fn(async (): Promise<ExecRunResultV1> => ({
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
    }));
    const cleanup = vi.fn(async () => {});

    const result = await runDeepSecReview({
      cwd: '/repo',
      mode: 'repository_security_audit',
      confirmedCostWarning: true,
      exec: {
        systemTools: { resolve: async () => grant },
        run,
      },
      tempFiles: {
        async createTextFile({ suffix }) {
          return suffix === '.comments.md' ? '/tmp/deepsec-comments.md' : '/tmp/unused';
        },
        async readText(path) {
          return path === '/tmp/deepsec-comments.md' ? '### src/auth.ts\n\nCheck auth.' : '';
        },
        cleanup,
      },
    });

    expect(result).toMatchObject({
      status: 'completed',
      commentOutMarkdown: '### src/auth.ts\n\nCheck auth.',
    });
    expect(run).toHaveBeenNthCalledWith(1, {
      kind: 'binary',
      executablePath: '/tools/deepsec',
      args: ['--quiet', 'scan'],
      cwd: '/repo',
    }, expect.objectContaining({ signal: undefined }));
    expect(run).toHaveBeenNthCalledWith(2, {
      kind: 'binary',
      executablePath: '/tools/deepsec',
      args: ['--quiet', 'process', '--comment-out', '/tmp/deepsec-comments.md'],
      cwd: '/repo',
    }, expect.objectContaining({ signal: undefined }));
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('reports repository audit process failure as partial after scan succeeds', async () => {
    const grant: SystemToolLaunchGrantV1 = {
      grantId: 'grant-1',
      toolId: 'deepsec',
      displayName: 'DeepSec',
      source: 'user_config',
      executablePath: '/tools/deepsec',
      launch: { kind: 'binary', executablePath: '/tools/deepsec' },
      expiresAt: null,
    };
    const run = vi
      .fn<() => Promise<ExecRunResultV1>>()
      .mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 2, signal: null, stdout: 'raw stdout', stderr: 'raw stderr' });
    const cleanup = vi.fn(async () => {});

    const result = await runDeepSecReview({
      cwd: '/repo',
      mode: 'repository_security_audit',
      confirmedCostWarning: true,
      exec: {
        systemTools: { resolve: async () => grant },
        run,
      },
      tempFiles: {
        async createTextFile() {
          return '/tmp/deepsec-comments.md';
        },
        async readText() {
          return '';
        },
        cleanup,
      },
    });

    expect(result).toEqual({
      status: 'partial',
      stage: 'process',
      diagnostics: [{
        code: 'deepsec_process_failed',
        severity: 'warning',
        messageKey: 'plugins.deepsec.runtime.partial',
        detail: { exitCode: 2, signal: null },
      }],
      result: { exitCode: 2, signal: null, stdout: 'raw stdout', stderr: 'raw stderr' },
      commentOutMarkdown: '',
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('cleans temp artifacts when DeepSec execution rejects', async () => {
    const grant: SystemToolLaunchGrantV1 = {
      grantId: 'grant-1',
      toolId: 'deepsec',
      displayName: 'DeepSec',
      source: 'user_config',
      executablePath: '/tools/deepsec',
      launch: { kind: 'binary', executablePath: '/tools/deepsec' },
      expiresAt: null,
    };
    const cleanup = vi.fn(async () => {});

    await expect(runDeepSecReview({
      cwd: '/repo',
      mode: 'current_diff',
      confirmedCostWarning: true,
      exec: {
        systemTools: { resolve: async () => grant },
        async run() {
          throw new Error('aborted');
        },
      },
      tempFiles: {
        async createTextFile() {
          return '/tmp/deepsec-comments.md';
        },
        async readText() {
          return '';
        },
        cleanup,
      },
    })).rejects.toThrow('aborted');

    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('rejects invalid selected-file scopes before resolving or creating temp files', async () => {
    const resolve = vi.fn(async () => {
      throw new Error('should not resolve invalid selected file scope');
    });
    const createTextFile = vi.fn(async () => {
      throw new Error('should not create temp files for invalid selected file scope');
    });

    await expect(runDeepSecReview({
      cwd: '/repo',
      mode: 'selected_files',
      selectedFiles: [],
      confirmedCostWarning: true,
      exec: {
        systemTools: { resolve },
        async run() {
          throw new Error('should not run invalid selected file scope');
        },
      },
      tempFiles: {
        createTextFile,
        async readText() {
          return '';
        },
        async cleanup() {},
      },
    })).rejects.toThrow('selectedFiles must include at least one file path');

    await expect(runDeepSecReview({
      cwd: '/repo',
      mode: 'selected_files',
      selectedFiles: ['src/auth.ts\nsrc/extra.ts'],
      confirmedCostWarning: true,
      exec: {
        systemTools: { resolve },
        async run() {
          throw new Error('should not run invalid selected file scope');
        },
      },
      tempFiles: {
        createTextFile,
        async readText() {
          return '';
        },
        async cleanup() {},
      },
    })).rejects.toThrow('selectedFiles must be non-empty single-line paths');

    expect(resolve).not.toHaveBeenCalled();
    expect(createTextFile).not.toHaveBeenCalled();
  });

  it('rejects unsafe selected-file paths before resolving or creating temp files', async () => {
    const resolve = vi.fn(async () => {
      throw new Error('should not resolve unsafe selected file scope');
    });
    const createTextFile = vi.fn(async () => {
      throw new Error('should not create temp files for unsafe selected file scope');
    });

    for (const selectedFile of [
      '/etc/passwd',
      '../secret.ts',
      'src/../secret.ts',
      'C:\\Users\\alice\\secret.ts',
      '\\\\server\\share\\secret.ts',
      '~/.ssh/config',
      'src/\0secret.ts',
    ]) {
      await expect(runDeepSecReview({
        cwd: '/repo',
        mode: 'selected_files',
        selectedFiles: [selectedFile],
        confirmedCostWarning: true,
        exec: {
          systemTools: { resolve },
          async run() {
            throw new Error('should not run unsafe selected file scope');
          },
        },
        tempFiles: {
          createTextFile,
          async readText() {
            return '';
          },
          async cleanup() {},
        },
      })).rejects.toThrow('selectedFiles must be safe workspace-relative paths');
    }

    expect(resolve).not.toHaveBeenCalled();
    expect(createTextFile).not.toHaveBeenCalled();
  });

  it('deduplicates selected-file paths before writing the file list', async () => {
    const grant: SystemToolLaunchGrantV1 = {
      grantId: 'grant-1',
      toolId: 'deepsec',
      displayName: 'DeepSec',
      source: 'user_config',
      executablePath: '/tools/deepsec',
      launch: { kind: 'binary', executablePath: '/tools/deepsec' },
      expiresAt: null,
    };
    let filesListContents = '';
    const createScopedPathListFile = vi.fn(async ({ paths }) => {
      filesListContents = `${paths.join('\n')}\n`;
      return {
        status: 'created' as const,
        path: '/tmp/deepsec-files.txt',
        paths,
      };
    });

    await runDeepSecReview({
      cwd: '/repo',
      mode: 'selected_files',
      selectedFiles: [' src/auth.ts ', 'src\\auth.ts', './src/api.ts'],
      confirmedCostWarning: true,
      exec: {
        systemTools: { resolve: async () => grant },
        async run(): Promise<ExecRunResultV1> {
          return { exitCode: 0, signal: null, stdout: '', stderr: '' };
        },
      },
      tempFiles: {
        createScopedPathListFile,
        async createTextFile() {
          return '/tmp/deepsec-comments.md';
        },
        async readText() {
          return '';
        },
        async cleanup() {},
      },
    });

    expect(filesListContents).toBe('src/auth.ts\nsrc/api.ts\n');
    expect(createScopedPathListFile).toHaveBeenCalledWith({
      suffix: '.files.txt',
      paths: ['src/auth.ts', 'src/api.ts'],
    });
  });

  it('fails closed when host selected-file scope materialization blocks a path', async () => {
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
    const createScopedPathListFile = vi.fn(async () => ({
      status: 'blocked' as const,
      diagnostics: [{
        code: 'path_escape',
        severity: 'error' as const,
        messageKey: 'plugins.fs.scopedPathList.pathEscape',
        path: 'src/outside/secret.ts',
      }],
    }));
    const createTextFile = vi.fn(async () => '/tmp/deepsec-comments.md');
    const cleanup = vi.fn(async () => {});
    const tempFiles = {
      createTextFile,
      createScopedPathListFile,
      async readText() {
        return '';
      },
      cleanup,
    };

    const result = await runDeepSecReview({
      cwd: '/repo',
      mode: 'selected_files',
      selectedFiles: ['src/outside/secret.ts'],
      confirmedCostWarning: true,
      exec: {
        systemTools: { resolve: async () => grant },
        run,
      },
      tempFiles,
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
    expect(createScopedPathListFile).toHaveBeenCalledWith({
      suffix: '.files.txt',
      paths: ['src/outside/secret.ts'],
    });
    expect(createTextFile).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
