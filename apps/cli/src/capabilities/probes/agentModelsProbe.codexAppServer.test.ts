import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  resolvePreflightSessionControlsProbeAdapterMock,
  probeModelsRawMock,
} = vi.hoisted(() => ({
  resolvePreflightSessionControlsProbeAdapterMock: vi.fn(),
  probeModelsRawMock: vi.fn(),
}));

vi.mock('./resolvePreflightSessionControlsProbeAdapter', () => ({
  resolvePreflightSessionControlsProbeAdapter: resolvePreflightSessionControlsProbeAdapterMock,
}));

import { probeAgentModelsBestEffort, resetAgentModelsProbeCacheForTests } from './agentModelsProbe';

describe('probeAgentModelsBestEffort (codex app-server)', () => {
  beforeEach(() => {
    resolvePreflightSessionControlsProbeAdapterMock.mockReset();
    probeModelsRawMock.mockReset();
    resolvePreflightSessionControlsProbeAdapterMock.mockResolvedValue({
      failureCacheStrategy: 'retry',
      probeModelsRaw: probeModelsRawMock,
    });
    resetAgentModelsProbeCacheForTests();
  });

  it('retries a transient Codex app-server preflight failure within the same probe so the first result is rich', async () => {
    probeModelsRawMock
      .mockRejectedValueOnce(new Error('temporary codex app-server failure'))
      .mockResolvedValueOnce([
        { id: 'gpt-5.4', name: 'GPT-5.4' },
        { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
      ]);

    const first = await probeAgentModelsBestEffort({
      agentId: 'codex',
      cwd: '/repo',
      accountSettings: { codexBackendMode: 'appServer' },
    });

    expect(first).toEqual({
      provider: 'codex',
      availableModels: [
        { id: 'default', name: 'Default' },
        { id: 'gpt-5.4', name: 'GPT-5.4' },
        { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' },
      ],
      supportsFreeform: false,
      source: 'dynamic',
    });
    expect(resolvePreflightSessionControlsProbeAdapterMock).toHaveBeenCalledWith('codex');
    expect(probeModelsRawMock).toHaveBeenCalledTimes(2);
    expect(probeModelsRawMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      cwd: '/repo',
      probeKind: 'models',
      accountSettings: { codexBackendMode: 'appServer' },
    }));
  });

  it('uses Codex app-server session controls when account settings select appServer', async () => {
    probeModelsRawMock.mockResolvedValueOnce([
      {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        description: 'Latest default',
        modelOptions: [
          {
            id: 'reasoning_effort',
            name: 'Thinking',
            type: 'select',
            currentValue: 'medium',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'medium', name: 'Medium' },
              { value: 'high', name: 'High' },
            ],
          },
        ],
      },
      { id: 'gpt-4.1', name: 'GPT-4.1' },
    ]);

    const result = await probeAgentModelsBestEffort({
      agentId: 'codex',
      cwd: '/repo-auth-settings',
      accountSettings: { codexBackendMode: 'appServer' },
    });

    expect(result).toEqual({
      provider: 'codex',
      availableModels: [
        { id: 'default', name: 'Default' },
        {
          id: 'gpt-5.4',
          name: 'GPT-5.4',
          description: 'Latest default',
          modelOptions: [
            {
              id: 'reasoning_effort',
              name: 'Thinking',
              type: 'select',
              currentValue: 'medium',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' },
                { value: 'high', name: 'High' },
              ],
            },
          ],
        },
        { id: 'gpt-4.1', name: 'GPT-4.1' },
      ],
      supportsFreeform: false,
      source: 'dynamic',
    });
    expect(probeModelsRawMock).toHaveBeenCalledTimes(1);
    expect(probeModelsRawMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo-auth-settings',
      probeKind: 'models',
      accountSettings: { codexBackendMode: 'appServer' },
    }));
  });

  it('uses Codex app-server session controls when the shared runtime defaults to appServer', async () => {
    probeModelsRawMock.mockResolvedValueOnce([
      { id: 'gpt-5.4', name: 'GPT-5.4' },
    ]);

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
    expect(probeModelsRawMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo-default',
      probeKind: 'models',
      accountSettings: null,
    }));
  });

  it('filters malformed dynamic model payload entries and normalizes invalid option values to null', async () => {
    probeModelsRawMock.mockResolvedValueOnce([
      {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        modelOptions: [
          {
            id: 'reasoning_effort',
            name: 'Thinking',
            type: 'select',
            currentValue: { invalid: true },
            options: [
              { value: { invalid: true }, name: 'Auto' },
              { value: 'medium', name: 'Medium' },
              { value: 'skip-me' },
            ],
          },
          {
            id: 'missing-type',
            name: 'Broken option',
            currentValue: 'ignored',
          },
        ],
      },
      {
        id: 'missing-name',
        modelOptions: [],
      },
    ]);

    const result = await probeAgentModelsBestEffort({
      agentId: 'codex',
      cwd: '/repo-parse',
      accountSettings: { codexBackendMode: 'appServer' },
    });

    expect(result).toEqual({
      provider: 'codex',
      availableModels: [
        { id: 'default', name: 'Default' },
        {
          id: 'gpt-5.4',
          name: 'GPT-5.4',
          modelOptions: [
            {
              id: 'reasoning_effort',
              name: 'Thinking',
              type: 'select',
              currentValue: null,
              options: [
                { value: null, name: 'Auto' },
                { value: 'medium', name: 'Medium' },
              ],
            },
          ],
        },
      ],
      supportsFreeform: false,
      source: 'dynamic',
    });
  });
});
