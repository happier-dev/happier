import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  resolvePreflightSessionControlsProbeAdapterMock,
  probeModesRawMock,
} = vi.hoisted(() => ({
  resolvePreflightSessionControlsProbeAdapterMock: vi.fn(),
  probeModesRawMock: vi.fn(),
}));

vi.mock('./resolvePreflightSessionControlsProbeAdapter', () => ({
  resolvePreflightSessionControlsProbeAdapter: resolvePreflightSessionControlsProbeAdapterMock,
}));

import { probeAgentModesBestEffort } from './agentModesProbe';

describe('probeAgentModesBestEffort (codex app-server)', () => {
  beforeEach(() => {
    resolvePreflightSessionControlsProbeAdapterMock.mockReset();
    probeModesRawMock.mockReset();
    resolvePreflightSessionControlsProbeAdapterMock.mockResolvedValue({
      failureCacheStrategy: 'retry',
      probeModesRaw: probeModesRawMock,
    });
  });

  it('retries a transient Codex app-server preflight failure within the same probe so the first result is rich', async () => {
    probeModesRawMock
      .mockRejectedValueOnce(new Error('temporary codex app-server failure'))
      .mockResolvedValueOnce([
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan', description: 'Reasoning effort: medium' },
      ]);

    const result = await probeAgentModesBestEffort({
      agentId: 'codex',
      cwd: '/repo-transient',
      accountSettings: { codexBackendMode: 'appServer' },
    });

    expect(result).toEqual({
      provider: 'codex',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan', description: 'Reasoning effort: medium' },
      ],
      source: 'dynamic',
    });
    expect(resolvePreflightSessionControlsProbeAdapterMock).toHaveBeenCalledWith('codex');
    expect(probeModesRawMock).toHaveBeenCalledTimes(2);
    expect(probeModesRawMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      cwd: '/repo-transient',
      probeKind: 'modes',
      accountSettings: { codexBackendMode: 'appServer' },
    }));
  });

  it('uses Codex app-server collaboration modes when account settings select appServer', async () => {
    probeModesRawMock.mockResolvedValueOnce([
      { id: 'default', name: 'Default' },
      { id: 'plan', name: 'Plan', description: 'Reasoning effort: medium' },
    ]);

    const result = await probeAgentModesBestEffort({
      agentId: 'codex',
      cwd: '/repo',
      accountSettings: { codexBackendMode: 'appServer' },
    });

    expect(result).toEqual({
      provider: 'codex',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan', description: 'Reasoning effort: medium' },
      ],
      source: 'dynamic',
    });
    expect(probeModesRawMock).toHaveBeenCalledTimes(1);
    expect(probeModesRawMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      probeKind: 'modes',
      accountSettings: { codexBackendMode: 'appServer' },
    }));
  });

  it('uses Codex app-server collaboration modes when the shared runtime defaults to appServer', async () => {
    probeModesRawMock.mockResolvedValueOnce([
      { id: 'default', name: 'Default' },
      { id: 'plan', name: 'Plan' },
    ]);

    const result = await probeAgentModesBestEffort({
      agentId: 'codex',
      cwd: '/repo-default',
    });

    expect(result).toEqual({
      provider: 'codex',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan' },
      ],
      source: 'dynamic',
    });
    expect(probeModesRawMock).toHaveBeenCalledTimes(1);
    expect(probeModesRawMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo-default',
      probeKind: 'modes',
      accountSettings: null,
    }));
  });
});
