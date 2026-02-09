import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { cleanupTempDir, makeTempHomeDir, withResumeEnv, writeExecutable } from './resumeResolve.testkit';

describe('resolveCodexMcpResumeServerCommand', () => {
  it('prefers explicit env override when present', async () => {
    const home = makeTempHomeDir();
    const override = join(home, 'override', 'codex-mcp-resume');
    writeExecutable(override);

    try {
      await withResumeEnv({
        HAPPIER_HOME_DIR: home,
        HAPPIER_CODEX_RESUME_MCP_SERVER_BIN: override,
      }, async () => {
        vi.resetModules();
        const mod = await import('./resolveMcpResumeServer');
        const resolved = await mod.resolveCodexMcpResumeServerCommand();
        expect(resolved).toBe(override);
      });
    } finally {
      cleanupTempDir(home);
    }
  });

  it('finds the primary install bin when present', async () => {
    const home = makeTempHomeDir();
    const bin = join(home, 'tools', 'codex-mcp-resume', 'node_modules', '.bin', process.platform === 'win32' ? 'codex-mcp-resume.cmd' : 'codex-mcp-resume');
    writeExecutable(bin);

    try {
      await withResumeEnv({
        HAPPIER_HOME_DIR: home,
        HAPPIER_CODEX_RESUME_MCP_SERVER_BIN: undefined,
      }, async () => {
        vi.resetModules();
        const mod = await import('./resolveMcpResumeServer');
        const resolved = await mod.resolveCodexMcpResumeServerCommand();
        expect(resolved).toBe(bin);
      });
    } finally {
      cleanupTempDir(home);
    }
  });

  it('falls back to the legacy install bin when present', async () => {
    const home = makeTempHomeDir();
    const bin = join(home, 'tools', 'codex-resume', 'node_modules', '.bin', process.platform === 'win32' ? 'codex-mcp-resume.cmd' : 'codex-mcp-resume');
    writeExecutable(bin);

    try {
      await withResumeEnv({
        HAPPIER_HOME_DIR: home,
        HAPPIER_CODEX_RESUME_MCP_SERVER_BIN: undefined,
      }, async () => {
        vi.resetModules();
        const mod = await import('./resolveMcpResumeServer');
        const resolved = await mod.resolveCodexMcpResumeServerCommand();
        expect(resolved).toBe(bin);
      });
    } finally {
      cleanupTempDir(home);
    }
  });

  it('returns null when override is missing and no installed binary exists', async () => {
    const home = makeTempHomeDir();
    try {
      await withResumeEnv({
        HAPPIER_HOME_DIR: home,
        HAPPIER_CODEX_RESUME_MCP_SERVER_BIN: join(home, 'missing', 'codex-mcp-resume'),
      }, async () => {
        vi.resetModules();
        const mod = await import('./resolveMcpResumeServer');
        const resolved = await mod.resolveCodexMcpResumeServerCommand();
        expect(resolved).toBeNull();
      });
    } finally {
      cleanupTempDir(home);
    }
  });

  it('falls back to installed binary when override is whitespace', async () => {
    const home = makeTempHomeDir();
    const bin = join(home, 'tools', 'codex-mcp-resume', 'node_modules', '.bin', process.platform === 'win32' ? 'codex-mcp-resume.cmd' : 'codex-mcp-resume');
    writeExecutable(bin);

    try {
      await withResumeEnv({
        HAPPIER_HOME_DIR: home,
        HAPPIER_CODEX_RESUME_MCP_SERVER_BIN: '   ',
      }, async () => {
        vi.resetModules();
        const mod = await import('./resolveMcpResumeServer');
        const resolved = await mod.resolveCodexMcpResumeServerCommand();
        expect(resolved).toBe(bin);
      });
    } finally {
      cleanupTempDir(home);
    }
  });
});
