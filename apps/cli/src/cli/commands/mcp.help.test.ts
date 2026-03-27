import { describe, expect, it, vi } from 'vitest';

import { handleMcpCommand } from './mcp';
import type { McpCommandDeps } from './mcp/deps';

describe('happier mcp --help', () => {
  it('prints usage for --help without requiring authentication', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readCredentials = vi.fn(async () => null);

    try {
      await handleMcpCommand(['--help'], { readCredentials } satisfies Partial<McpCommandDeps>);

      expect(readCredentials).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('happier mcp');
      expect(output).toContain('happier mcp serve');
      expect(output).toContain('happier mcp servers list');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('prints usage for `servers --help` without requiring authentication', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readCredentials = vi.fn(async () => null);

    try {
      await handleMcpCommand(['servers', '--help'], { readCredentials } satisfies Partial<McpCommandDeps>);

      expect(readCredentials).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('happier mcp servers');
      expect(output).toContain('happier mcp servers list');
      expect(output).toContain('happier mcp servers test');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('prints usage when `servers` subcommand is missing', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readCredentials = vi.fn(async () => null);

    try {
      await handleMcpCommand(['servers'], { readCredentials } satisfies Partial<McpCommandDeps>);

      expect(readCredentials).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('happier mcp servers');
      expect(output).toContain('happier mcp servers list');
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

