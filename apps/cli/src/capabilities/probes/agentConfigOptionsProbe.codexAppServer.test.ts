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

  it('retries a transient Codex app-server failure within the same probe so the first result is rich', async () => {
    withCodexAppServerClientMock
      .mockRejectedValueOnce(new Error('temporary codex app-server failure'))
      .mockImplementationOnce(async ({ cwd, run }: any) => {
        expect(cwd).toBe('/repo-transient');
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
      cwd: '/repo-transient',
      accountSettings: { codexBackendMode: 'appServer' },
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
    expect(withCodexAppServerClientMock).toHaveBeenCalledTimes(2);
    expect(readCodexAppServerSessionControlsMock).toHaveBeenCalledTimes(1);
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

  it('does not cache invalid dynamic config-options results as a 24h success fallback', async () => {
    vi.resetModules();
    const { probeAgentConfigOptionsBestEffort: probeFresh } = await import('./agentConfigOptionsProbe');

    withCodexAppServerClientMock.mockImplementation(async ({ cwd, run }: any) => {
      expect(cwd).toBe('/repo-invalid');
      return await run({ request: vi.fn() });
    });

    readCodexAppServerSessionControlsMock
      .mockResolvedValueOnce({
      availableModes: [],
      currentModeId: 'default',
      availableModels: [],
      currentModelId: null,
      // Invalid entry: array present, but nothing parseable.
      configOptions: [{}],
      })
      // Retry within the same probe should not freeze a bad payload; still ends up as a fallback.
      .mockResolvedValueOnce({
        availableModes: [],
        currentModeId: 'default',
        availableModels: [],
        currentModelId: null,
        configOptions: [{}],
      });

    const first = await probeFresh({
      agentId: 'codex',
      cwd: '/repo-invalid',
      accountSettings: { codexBackendMode: 'appServer' },
    });
    expect(first).toEqual({
      provider: 'codex',
      configOptions: [],
      source: 'static',
    });

    readCodexAppServerSessionControlsMock.mockResolvedValueOnce({
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

    const second = await probeFresh({
      agentId: 'codex',
      cwd: '/repo-invalid',
      accountSettings: { codexBackendMode: 'appServer' },
    });

    expect(second).toEqual({
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
    expect(readCodexAppServerSessionControlsMock).toHaveBeenCalledTimes(3);
  });
});
