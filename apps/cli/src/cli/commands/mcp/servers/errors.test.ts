import { describe, expect, it } from 'vitest';
import { captureConsoleLogAndMuteStdout } from '@/testkit/logger/captureOutput';
import { reportMcpServerCatalogMutation } from './errors';

describe('MCP catalog mutation reporting', () => {
  it('waits for a catalog conflict and reports failure without unrelated settings', async () => {
    const output = captureConsoleLogAndMuteStdout();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const accepted = await reportMcpServerCatalogMutation(Promise.resolve({ status: 'conflict', revision: 7 }), {
        kind: 'mcp_servers_add', json: true,
      });
      expect(accepted).toBe(false);
      expect(JSON.parse(output.logs.join('\n'))).toMatchObject({
        ok: false, kind: 'mcp_servers_add',
        error: { code: 'mcp_catalog_conflict', settlement: { status: 'conflict', revision: 7 } },
      });
      expect(process.exitCode).toBe(1);
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });

  it('accepts an acknowledged catalog mutation before callers print success', async () => {
    const output = captureConsoleLogAndMuteStdout();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      expect(await reportMcpServerCatalogMutation(Promise.resolve({ status: 'updated', revision: 8, cursor: 8 }), {
        kind: 'mcp_servers_bind', json: true,
      })).toBe(true);
      expect(output.logs).toEqual([]);
      expect(process.exitCode).toBeUndefined();
    } finally {
      output.restore();
      process.exitCode = previousExitCode;
    }
  });
});
