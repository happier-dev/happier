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

import { probeAgentConfigOptionsBestEffort } from './agentConfigOptionsProbe';

describe('probeAgentConfigOptionsBestEffort (codex app-server)', () => {
  beforeEach(() => {
    withCodexAppServerClientMock.mockReset();
    readCodexAppServerSessionControlsMock.mockReset();
  });

  it('returns only session-level config options when model-scoped controls are present', async () => {
    withCodexAppServerClientMock.mockImplementation(async ({ cwd, run }: any) => {
      expect(cwd).toBe('/repo');
      return await run({ request: vi.fn() });
    });
    readCodexAppServerSessionControlsMock.mockResolvedValue({
      availableModes: [],
      currentModeId: 'default',
      availableModels: [
        {
          id: 'gpt-5.4',
          name: 'GPT-5.4',
          modelOptions: [
            {
              id: 'reasoning_effort',
              name: 'Thinking',
              type: 'select',
              currentValue: 'medium',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' },
              ],
            },
            {
              id: 'speed',
              name: 'Fast',
              type: 'boolean',
              currentValue: true,
            },
          ],
        },
      ],
      currentModelId: 'gpt-5.4',
      configOptions: [],
    });

    const result = await probeAgentConfigOptionsBestEffort({
      agentId: 'codex',
      cwd: '/repo',
      accountSettings: { codexBackendMode: 'appServer' },
    });

    expect(result).toEqual({
      provider: 'codex',
      configOptions: [],
      source: 'dynamic',
    });
    expect(withCodexAppServerClientMock).toHaveBeenCalledTimes(1);
    expect(readCodexAppServerSessionControlsMock).toHaveBeenCalledTimes(1);
  });

  it('uses Codex app-server session controls config options when the shared runtime defaults to appServer', async () => {
    withCodexAppServerClientMock.mockImplementation(async ({ cwd, run }: any) => {
      expect(cwd).toBe('/repo-default');
      return await run({ request: vi.fn() });
    });
    readCodexAppServerSessionControlsMock.mockResolvedValue({
      availableModes: [],
      currentModeId: 'default',
      availableModels: [],
      currentModelId: null,
      configOptions: [
        {
          id: 'speed',
          name: 'Speed',
          type: 'select',
          currentValue: 'fast',
          options: [
            { value: 'standard', name: 'Standard' },
            { value: 'fast', name: 'Fast' },
          ],
        },
      ],
    });

    const result = await probeAgentConfigOptionsBestEffort({
      agentId: 'codex',
      cwd: '/repo-default',
    });

    expect(result).toEqual({
      provider: 'codex',
      configOptions: [
        {
          id: 'speed',
          name: 'Speed',
          type: 'select',
          currentValue: 'fast',
          options: [
            { value: 'standard', name: 'Standard' },
            { value: 'fast', name: 'Fast' },
          ],
        },
      ],
      source: 'dynamic',
    });
    expect(withCodexAppServerClientMock).toHaveBeenCalledTimes(1);
    expect(readCodexAppServerSessionControlsMock).toHaveBeenCalledTimes(1);
  });
});
