import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { cleanupTempDir, makeTempHomeDir, withResumeEnv, writeExecutable } from './resumeResolve.testkit';

describe('resolveCodexMcpServerSpawn', () => {
  it('uses codex CLI spawn when ACP is enabled', async () => {
    vi.resetModules();
    const mod = await import('./resolveCodexMcpServer');
    await expect(mod.resolveCodexMcpServerSpawn({
      useCodexAcp: true,
      experimentalCodexResumeEnabled: true,
      vendorResumeId: 'abc',
      localControlSupported: true,
    })).resolves.toEqual({ mode: 'codex-cli', command: 'codex' });
  });

  it('uses codex CLI spawn when resume server is not required', async () => {
    vi.resetModules();
    const mod = await import('./resolveCodexMcpServer');
    await expect(mod.resolveCodexMcpServerSpawn({
      useCodexAcp: false,
      experimentalCodexResumeEnabled: true,
      vendorResumeId: null,
      localControlSupported: false,
    })).resolves.toEqual({ mode: 'codex-cli', command: 'codex' });
  });

  it('treats whitespace vendor resume id as absent when local-control is unsupported', async () => {
    vi.resetModules();
    const mod = await import('./resolveCodexMcpServer');
    await expect(mod.resolveCodexMcpServerSpawn({
      useCodexAcp: false,
      experimentalCodexResumeEnabled: true,
      vendorResumeId: '   ',
      localControlSupported: false,
    })).resolves.toEqual({ mode: 'codex-cli', command: 'codex' });
  });

  it('uses resume MCP server when local-control needs it', async () => {
    const home = makeTempHomeDir('happier-codex-resume-server-');
    const override = join(home, 'bin', process.platform === 'win32' ? 'codex-mcp-resume.cmd' : 'codex-mcp-resume');
    writeExecutable(override);
    try {
      await withResumeEnv({
        HAPPIER_HOME_DIR: home,
        HAPPIER_CODEX_RESUME_MCP_SERVER_BIN: override,
      }, async () => {
        vi.resetModules();
        const mod = await import('./resolveCodexMcpServer');
        await expect(mod.resolveCodexMcpServerSpawn({
          useCodexAcp: false,
          experimentalCodexResumeEnabled: true,
          vendorResumeId: null,
          localControlSupported: true,
        })).resolves.toEqual({ mode: 'mcp-server', command: override });
      });
    } finally {
      cleanupTempDir(home);
    }
  });

  it('throws when resume server is required but cannot be resolved', async () => {
    const tempHome = makeTempHomeDir('happier-codex-resume-missing-');
    try {
      await withResumeEnv({
        HAPPIER_HOME_DIR: tempHome,
        HAPPIER_CODEX_RESUME_MCP_SERVER_BIN: undefined,
      }, async () => {
        vi.resetModules();
        const mod = await import('./resolveCodexMcpServer');
        await expect(mod.resolveCodexMcpServerSpawn({
          useCodexAcp: false,
          experimentalCodexResumeEnabled: true,
          vendorResumeId: 'abc',
          localControlSupported: true,
        })).rejects.toThrow(/codex.*resume/i);
      });
    } finally {
      cleanupTempDir(tempHome);
    }
  });

  it('throws when resume server command resolves to blank text', async () => {
    vi.resetModules();
    vi.doMock('./resolveMcpResumeServer', () => ({
      resolveCodexMcpResumeServerCommand: vi.fn(async () => '   '),
    }));

    try {
      const mod = await import('./resolveCodexMcpServer');
      await expect(mod.resolveCodexMcpServerSpawn({
        useCodexAcp: false,
        experimentalCodexResumeEnabled: true,
        vendorResumeId: 'abc',
        localControlSupported: true,
      })).rejects.toThrow(/not installed/i);
    } finally {
      vi.doUnmock('./resolveMcpResumeServer');
    }
  });

  it('fails closed when vendor resume is requested but experimental resume is disabled', async () => {
    vi.resetModules();
    const mod = await import('./resolveCodexMcpServer');
    await expect(mod.resolveCodexMcpServerSpawn({
      useCodexAcp: false,
      experimentalCodexResumeEnabled: false,
      vendorResumeId: 'abc',
      localControlSupported: false,
    })).rejects.toThrow(/experimental/i);
  });
});
