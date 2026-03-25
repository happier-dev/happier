import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  withCodexAppServerClientMock,
  readCodexAppServerSessionControlsMock,
} = vi.hoisted(() => ({
  withCodexAppServerClientMock: vi.fn(),
  readCodexAppServerSessionControlsMock: vi.fn(),
}));

vi.mock('@/backends/codex/appServer/client/withCodexAppServerClient', () => ({
  withCodexAppServerClient: withCodexAppServerClientMock,
}));

vi.mock('@/backends/codex/appServer/sessionControlsMetadata', () => ({
  readCodexAppServerSessionControls: readCodexAppServerSessionControlsMock,
}));

import { probeAgentModesBestEffort } from './agentModesProbe';

describe('probeAgentModesBestEffort (codex app-server)', () => {
  beforeEach(() => {
    withCodexAppServerClientMock.mockReset();
    readCodexAppServerSessionControlsMock.mockReset();
  });

  it('retries a transient Codex app-server failure within the same probe so the first result is rich', async () => {
    withCodexAppServerClientMock
      .mockRejectedValueOnce(new Error('temporary codex app-server failure'))
      .mockImplementationOnce(async ({ cwd, run }: any) => {
        expect(cwd).toBe('/repo-transient');
        return await run({ request: vi.fn() });
      });
    readCodexAppServerSessionControlsMock.mockResolvedValue({
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan', description: 'Reasoning effort: medium' },
      ],
      currentModeId: 'default',
      availableModels: [],
      currentModelId: null,
      configOptions: [],
    });

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
    expect(withCodexAppServerClientMock).toHaveBeenCalledTimes(2);
    expect(readCodexAppServerSessionControlsMock).toHaveBeenCalledTimes(1);
  });

  it('uses Codex app-server collaboration modes when account settings select appServer', async () => {
    withCodexAppServerClientMock.mockImplementation(async ({ cwd, run }: any) => {
      expect(cwd).toBe('/repo');
      return await run({ request: vi.fn() });
    });
    readCodexAppServerSessionControlsMock.mockResolvedValue({
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan', description: 'Reasoning effort: medium' },
      ],
      currentModeId: 'default',
      availableModels: [],
      currentModelId: null,
      configOptions: [],
    });

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
    expect(withCodexAppServerClientMock).toHaveBeenCalledTimes(1);
    expect(readCodexAppServerSessionControlsMock).toHaveBeenCalledTimes(1);
  });

  it('uses Codex app-server collaboration modes when the shared runtime defaults to appServer', async () => {
    withCodexAppServerClientMock.mockImplementation(async ({ cwd, run }: any) => {
      expect(cwd).toBe('/repo-default');
      return await run({ request: vi.fn() });
    });
    readCodexAppServerSessionControlsMock.mockResolvedValue({
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan' },
      ],
      currentModeId: 'default',
      availableModels: [],
      currentModelId: null,
      configOptions: [],
    });

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
    expect(withCodexAppServerClientMock).toHaveBeenCalledTimes(1);
    expect(readCodexAppServerSessionControlsMock).toHaveBeenCalledTimes(1);
  });
});
