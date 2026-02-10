import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';

const { probeAcpAgentCapabilitiesMock } = vi.hoisted(() => ({
  probeAcpAgentCapabilitiesMock: vi.fn(),
}));

vi.mock('@/capabilities/probes/acpProbe', () => ({
  probeAcpAgentCapabilities: probeAcpAgentCapabilitiesMock,
}));

describe.sequential('probeCodexAcpLoadSessionSupport', () => {
  const originalEnv = {
    HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR,
    HAPPIER_CODEX_ACP_ALLOW_NPX: process.env.HAPPIER_CODEX_ACP_ALLOW_NPX,
    HAPPIER_CODEX_ACP_NPX_MODE: process.env.HAPPIER_CODEX_ACP_NPX_MODE,
    PATH: process.env.PATH,
  };
  let homeDir: string;
  let pathDir: string;

  beforeEach(() => {
    vi.resetModules();
    probeAcpAgentCapabilitiesMock.mockReset();
    homeDir = mkdtempSync(resolve(tmpdir(), 'happier-codex-acp-probe-'));
    pathDir = mkdtempSync(resolve(tmpdir(), 'happier-codex-acp-probe-path-'));
    process.env.HAPPIER_HOME_DIR = homeDir;
    delete process.env.HAPPIER_CODEX_ACP_ALLOW_NPX;
    delete process.env.HAPPIER_CODEX_ACP_NPX_MODE;
    process.env.PATH = pathDir;
  });

  afterEach(() => {
    if (originalEnv.HAPPIER_HOME_DIR === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalEnv.HAPPIER_HOME_DIR;
    if (originalEnv.HAPPIER_CODEX_ACP_ALLOW_NPX === undefined) delete process.env.HAPPIER_CODEX_ACP_ALLOW_NPX;
    else process.env.HAPPIER_CODEX_ACP_ALLOW_NPX = originalEnv.HAPPIER_CODEX_ACP_ALLOW_NPX;
    if (originalEnv.HAPPIER_CODEX_ACP_NPX_MODE === undefined) delete process.env.HAPPIER_CODEX_ACP_NPX_MODE;
    else process.env.HAPPIER_CODEX_ACP_NPX_MODE = originalEnv.HAPPIER_CODEX_ACP_NPX_MODE;
    if (originalEnv.PATH === undefined) delete process.env.PATH;
    else process.env.PATH = originalEnv.PATH;
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(pathDir, { recursive: true, force: true });
  });

  it('uses npx fallback by default and includes shims in probe env', async () => {
    probeAcpAgentCapabilitiesMock.mockResolvedValue({
      ok: true,
      checkedAt: 123,
      agentCapabilities: { loadSession: true },
    });

    const { probeCodexAcpLoadSessionSupport } = await import('./probeLoadSessionSupport');
    const result = await probeCodexAcpLoadSessionSupport();

    expect(result).toMatchObject({
      ok: true,
      checkedAt: 123,
      loadSession: true,
      agentCapabilities: {
        loadSession: true,
      },
    });
    expect(probeAcpAgentCapabilitiesMock).toHaveBeenCalledTimes(1);

    const args = probeAcpAgentCapabilitiesMock.mock.calls[0]?.[0];
    expect(args?.command).toBe('npx');
    const shimsDir = resolve(process.cwd(), 'scripts', 'shims');
    expect(String(args?.env?.PATH ?? '')).toContain(shimsDir);
    expect(String(args?.env?.PATH ?? '')).toContain(pathDir);
  }, 15_000);
});
