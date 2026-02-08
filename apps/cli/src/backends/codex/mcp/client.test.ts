import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockTransportCtor = vi.fn();
const mockGetCodexVersionInfo = vi.fn();
const mockGetCodexMcpCommand = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class MockStdioClientTransport {
    constructor(opts: unknown) {
      mockTransportCtor(opts);
    }
  },
}));

vi.mock('./version', () => ({
  getCodexVersionInfo: (...args: unknown[]) => mockGetCodexVersionInfo(...args),
  getCodexMcpCommand: (...args: unknown[]) => mockGetCodexMcpCommand(...args),
}));

describe('createCodexTransport', () => {
  beforeEach(() => {
    mockTransportCtor.mockReset();
    mockGetCodexVersionInfo.mockReset();
    mockGetCodexMcpCommand.mockReset();
  });

  it('computes codex version once in codex-cli mode', async () => {
    const versionInfo = { raw: '0.1.2', parsed: true, major: 0, minor: 1, patch: 2 };
    mockGetCodexVersionInfo.mockReturnValue(versionInfo);
    mockGetCodexMcpCommand.mockReturnValue('mcp');

    const { createCodexTransport } = await import('./client');
    const result = createCodexTransport({
      codexCommand: 'codex',
      mode: 'codex-cli',
      mcpServerArgs: [],
    });

    expect(mockGetCodexVersionInfo).toHaveBeenCalledTimes(1);
    expect(mockGetCodexVersionInfo).toHaveBeenCalledWith('codex');
    expect(mockGetCodexMcpCommand).toHaveBeenCalledWith('codex');
    expect(result.versionInfo).toEqual(versionInfo);
    expect(mockTransportCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'codex',
        args: ['mcp'],
      }),
    );
  });
});
