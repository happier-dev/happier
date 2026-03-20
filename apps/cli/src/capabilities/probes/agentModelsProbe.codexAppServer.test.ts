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

import { probeAgentModelsBestEffort } from './agentModelsProbe';

describe('probeAgentModelsBestEffort (codex app-server)', () => {
  beforeEach(() => {
    withCodexAppServerClientMock.mockReset();
    readCodexAppServerSessionControlsMock.mockReset();
  });

  it('uses Codex app-server session controls when account settings select appServer', async () => {
    withCodexAppServerClientMock.mockImplementation(async ({ cwd, run }: any) => {
      expect(cwd).toBe('/repo');
      return await run({ request: vi.fn() });
    });
    readCodexAppServerSessionControlsMock.mockResolvedValue({
      availableModes: [],
      currentModeId: 'default',
      availableModels: [
        { id: 'gpt-5.4', name: 'GPT-5.4', description: 'Latest default' },
        { id: 'gpt-4.1', name: 'GPT-4.1' },
      ],
      currentModelId: 'gpt-5.4',
      configOptions: [],
    });

    const result = await probeAgentModelsBestEffort({
      agentId: 'codex',
      cwd: '/repo',
      accountSettings: { codexBackendMode: 'appServer' },
    });

    expect(result).toEqual({
      provider: 'codex',
      availableModels: [
        { id: 'default', name: 'Default' },
        { id: 'gpt-5.4', name: 'GPT-5.4', description: 'Latest default' },
        { id: 'gpt-4.1', name: 'GPT-4.1' },
      ],
      supportsFreeform: false,
      source: 'dynamic',
    });
    expect(withCodexAppServerClientMock).toHaveBeenCalledTimes(1);
    expect(readCodexAppServerSessionControlsMock).toHaveBeenCalledTimes(1);
  });

  it('uses Codex app-server session controls when the shared runtime defaults to appServer', async () => {
    withCodexAppServerClientMock.mockImplementation(async ({ cwd, run }: any) => {
      expect(cwd).toBe('/repo-default');
      return await run({ request: vi.fn() });
    });
    readCodexAppServerSessionControlsMock.mockResolvedValue({
      availableModes: [],
      currentModeId: 'default',
      availableModels: [
        { id: 'gpt-5.4', name: 'GPT-5.4' },
      ],
      currentModelId: 'gpt-5.4',
      configOptions: [],
    });

    const result = await probeAgentModelsBestEffort({
      agentId: 'codex',
      cwd: '/repo-default',
    });

    expect(result).toEqual({
      provider: 'codex',
      availableModels: [
        { id: 'default', name: 'Default' },
        { id: 'gpt-5.4', name: 'GPT-5.4' },
      ],
      supportsFreeform: false,
      source: 'dynamic',
    });
    expect(withCodexAppServerClientMock).toHaveBeenCalledTimes(1);
    expect(readCodexAppServerSessionControlsMock).toHaveBeenCalledTimes(1);
  });
});
