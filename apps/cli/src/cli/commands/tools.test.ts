import { describe, expect, it, vi } from 'vitest';

import { handleToolsCommand } from './tools';
import { captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

function createBaseDeps() {
  return {
    readCredentials: async () => ({
      token: 'token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    }),
    initializeBackendApiContext: async () => ({ api: {} as any, machineId: 'machine-1' }),
    bootstrapAccountSettingsContext: async () => ({ settings: {}, source: 'network', settingsVersion: 1, loadedAtMs: 1, whenRefreshed: null }),
    resolveCustomHappierToolsContext: async () => ({ mcpServers: {}, warnings: [] }),
  };
}

describe('happier tools --json', () => {
  it('prints a tools_list JSON envelope grouped by source', async () => {
    const output = captureStdoutJsonOutput();
    const initializeBackendApiContext = vi.fn(async () => ({ api: {} as any, machineId: 'machine-1' }));
    const resolveCustomHappierToolsContext = vi.fn(async () => ({ mcpServers: {}, warnings: [] }));
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await handleToolsCommand(['list', '--session-id', 'sess-1', '--directory', '/tmp/workspace', '--json'], {
        ...createBaseDeps(),
        initializeBackendApiContext,
        resolveCustomHappierToolsContext,
        listBuiltInHappierTools: async () => [
          { name: 'change_title', title: 'Change title', description: 'Rename', inputSchema: { title: 'string' } },
        ],
        listResolvedCustomHappierTools: async () => ({
          tools: [
            { source: 'playwright', name: 'open_page', description: 'Open a page', inputSchema: { url: 'string' } },
          ],
          warnings: [],
        }),
      } as any);

      const parsed = output.json<any>();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('tools_list');
      expect(parsed.data?.sources?.happier).toEqual([
        expect.objectContaining({ name: 'change_title' }),
      ]);
      expect(parsed.data?.sources?.playwright).toEqual([
        expect.objectContaining({ name: 'open_page' }),
      ]);
      expect(initializeBackendApiContext).toHaveBeenCalledWith(expect.objectContaining({
        suppressMachineRegistrationRecoveryLogs: true,
      }));
      expect(resolveCustomHappierToolsContext).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(0);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('prints a tools_list JSON envelope with warnings when one custom source is unavailable', async () => {
    const output = captureStdoutJsonOutput();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await handleToolsCommand(['list', '--session-id', 'sess-1', '--directory', '/tmp/workspace', '--json'], {
        ...createBaseDeps(),
        listBuiltInHappierTools: async () => [
          { name: 'change_title', title: 'Change title', description: 'Rename', inputSchema: { title: 'string' } },
        ],
        listResolvedCustomHappierTools: async () => ({
          tools: [
            { source: 'playwright', name: 'open_page', description: 'Open a page', inputSchema: { url: 'string' } },
          ],
          warnings: [
            { source: 'qa_remote_http_saved_secret_20260306', error: 'Connection closed' },
          ],
        }),
      } as any);

      const parsed = output.json<any>();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('tools_list');
      expect(parsed.data?.sources?.playwright).toEqual([
        expect.objectContaining({ name: 'open_page' }),
      ]);
      expect(parsed.data?.warnings).toEqual([
        { source: 'qa_remote_http_saved_secret_20260306', error: 'Connection closed' },
      ]);
      expect(process.exitCode).toBe(0);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('allows happier tools list without a session id', async () => {
    const output = captureStdoutJsonOutput();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await handleToolsCommand(['list', '--directory', '/tmp/workspace', '--json'], {
        ...createBaseDeps(),
        listBuiltInHappierTools: async () => [
          { name: 'change_title', title: 'Change title', description: 'Rename', inputSchema: { title: 'string' } },
        ],
        listResolvedCustomHappierTools: async () => ({ tools: [], warnings: [] }),
      } as any);

      const parsed = output.json<any>();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('tools_list');
      expect(parsed.data?.sources?.happier).toEqual([
        expect.objectContaining({ name: 'change_title' }),
      ]);
      expect(process.exitCode).toBe(0);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('prints a tools_call JSON envelope for built-in Happier tools', async () => {
    const output = captureStdoutJsonOutput();
    const initializeBackendApiContext = vi.fn(async () => ({ api: {} as any, machineId: 'machine-1' }));
    const bootstrapAccountSettingsContext = vi.fn(async () => ({ settings: {}, source: 'network', settingsVersion: 1, loadedAtMs: 1, whenRefreshed: null }));
    const resolveCustomHappierToolsContext = vi.fn(async () => {
      throw new Error('built-in tools must not materialize custom MCP state');
    });
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await handleToolsCommand([
        'call',
        '--session-id',
        'sess-1',
        '--directory',
        '/tmp/workspace',
        '--source',
        'happier',
        '--tool',
        'change_title',
        '--args-json',
        '{"title":"Renamed"}',
        '--json',
      ], {
        ...createBaseDeps(),
        initializeBackendApiContext,
        bootstrapAccountSettingsContext,
        resolveCustomHappierToolsContext,
        callBuiltInHappierTool: async ({ toolName, args, sessionId }: any) => ({
          ok: true,
          result: { toolName, args, sessionId },
        }),
      } as any);

      const parsed = output.json<any>();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('tools_call');
      expect(parsed.data).toEqual({
        source: 'happier',
        tool: 'change_title',
        isError: false,
        output: {
          toolName: 'change_title',
          args: { title: 'Renamed' },
          sessionId: 'sess-1',
        },
      });
      expect(initializeBackendApiContext).not.toHaveBeenCalled();
      expect(bootstrapAccountSettingsContext).not.toHaveBeenCalled();
      expect(resolveCustomHappierToolsContext).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('prints a tools_call JSON envelope for custom Happier-managed tools', async () => {
    const output = captureStdoutJsonOutput();
    const resolveCustomHappierToolsContext = vi.fn(async () => ({ mcpServers: {}, warnings: [] }));
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await handleToolsCommand([
        'call',
        '--session-id',
        'sess-1',
        '--directory',
        '/tmp/workspace',
        '--source',
        'playwright',
        '--tool',
        'open_page',
        '--args-json',
        '{"url":"https://example.com"}',
        '--json',
      ], {
        ...createBaseDeps(),
        resolveCustomHappierToolsContext,
        callResolvedCustomHappierTool: async ({ source, toolName, args, sessionId }: any) => ({
          ok: true,
          result: { source, toolName, args, sessionId },
        }),
      } as any);

      const parsed = output.json<any>();
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe('tools_call');
      expect(parsed.data).toEqual({
        source: 'playwright',
        tool: 'open_page',
        isError: false,
        output: {
          source: 'playwright',
          toolName: 'open_page',
          args: { url: 'https://example.com' },
        },
      });
      expect(resolveCustomHappierToolsContext).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(0);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });

  it('includes session ambiguity candidates in the tools_call JSON error envelope for built-in Happier tools', async () => {
    const output = captureStdoutJsonOutput();
    const prevExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await handleToolsCommand([
        'call',
        '--session-id',
        'sess',
        '--directory',
        '/tmp/workspace',
        '--source',
        'happier',
        '--tool',
        'change_title',
        '--args-json',
        '{"title":"Renamed"}',
        '--json',
      ], {
        ...createBaseDeps(),
        callBuiltInHappierTool: async () => ({
          ok: false,
          errorCode: 'session_id_ambiguous',
          error: 'Session id is ambiguous',
          candidates: ['sess-1', 'sess-2'],
        }),
      } as any);

      const parsed = output.json<any>();
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBe('tools_call');
      expect(parsed.error).toEqual({
        code: 'session_id_ambiguous',
        message: 'Session id is ambiguous',
        candidates: ['sess-1', 'sess-2'],
      });
      expect(process.exitCode).toBe(1);
    } finally {
      output.restore();
      process.exitCode = prevExitCode;
    }
  });
});
