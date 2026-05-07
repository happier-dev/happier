import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { resetDynamicModelProbeCacheForTests } from '@/sync/domains/models/dynamicModelProbeCache';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type ProbeModelsResult = Readonly<{
  provider?: string;
  source?: 'dynamic' | 'static';
  availableModels: Array<{
    id: string;
    name: string;
    modelOptions?: Array<{
      id: string;
      name: string;
      type: string;
      currentValue: string;
      options?: Array<{ value: string; name: string }>;
    }>;
  }>;
  supportsFreeform: boolean;
}>;

type ProbeResponse = Readonly<{
  supported: true;
  response: Readonly<{
    ok: true;
    result: ProbeModelsResult;
  }>;
}>;

const machineCapabilitiesInvokeMock = vi.fn(async (_machineId: any, _request: any, _options: any): Promise<ProbeResponse> => ({
  supported: true as const,
  response: {
    ok: true as const,
    result: {
      availableModels: [{
        id: 'm1',
        name: 'Model 1',
        modelOptions: [{
          id: 'reasoning_effort',
          name: 'Thinking',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
          ],
        }],
      }],
      supportsFreeform: false,
    },
  },
}));

vi.mock('@/sync/ops/capabilities', () => ({
  machineCapabilitiesInvoke: machineCapabilitiesInvokeMock,
}));

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
  return {
    ...actual,
    getAgentCore: () => ({ model: { supportsSelection: true, allowedModes: [], defaultMode: 'default', supportsFreeform: false } }),
  };
});

describe('useNewSessionPreflightModelsState (persistence)', () => {
  it('hydrates cached results across module reloads (app restarts)', async () => {
    vi.resetModules();
    machineCapabilitiesInvokeMock.mockClear();
    resetDynamicModelProbeCacheForTests();

    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    let latestPreflightModels: any = null;
    function Harness() {
      latestPreflightModels = useNewSessionPreflightModelsState({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo',
      }).preflightModels;
      return null;
    }

    let root1!: renderer.ReactTestRenderer;
    root1 = (await renderScreen(React.createElement(Harness))).tree;
    await act(async () => {
      root1.unmount();
    });

    // Simulate app restart: module registry cleared, in-memory cache gone, MMKV/localStorage remains.
    vi.resetModules();

    const { useNewSessionPreflightModelsState: useNewSessionPreflightModelsState2 } = await import('./useNewSessionPreflightModelsState');

    let latestPreflightModelsAfterReload: any = null;
    function Harness2() {
      latestPreflightModelsAfterReload = useNewSessionPreflightModelsState2({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo',
      }).preflightModels;
      return null;
    }

    let root2!: renderer.ReactTestRenderer;
    root2 = (await renderScreen(React.createElement(Harness2))).tree;
    await act(async () => {
      root2.unmount();
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
    expect(latestPreflightModels).toEqual({
      availableModels: [{
        id: 'm1',
        name: 'Model 1',
        modelOptions: [{
          id: 'reasoning_effort',
          name: 'Thinking',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
          ],
        }],
      }],
      supportsFreeform: false,
    });
    expect(latestPreflightModelsAfterReload).toEqual(latestPreflightModels);
  });

  it('does not persist static fallback probe results across module reloads', async () => {
    vi.resetModules();
    resetDynamicModelProbeCacheForTests();
    machineCapabilitiesInvokeMock.mockClear();

    machineCapabilitiesInvokeMock.mockResolvedValue({
      supported: true as const,
      response: {
        ok: true as const,
        result: {
          provider: 'codex',
          source: 'static',
          availableModels: [{ id: 'm1', name: 'Model 1', modelOptions: [] }],
          supportsFreeform: false,
        },
      },
    });

    const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

    function Harness() {
      useNewSessionPreflightModelsState({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo',
      }).preflightModels;
      return null;
    }

    let root1!: renderer.ReactTestRenderer;
    root1 = (await renderScreen(React.createElement(Harness))).tree;
    await act(async () => {
      root1.unmount();
    });

    // Simulate app restart: module registry cleared, in-memory cache gone.
    vi.resetModules();

    const { useNewSessionPreflightModelsState: useNewSessionPreflightModelsState2 } = await import('./useNewSessionPreflightModelsState');

    function Harness2() {
      useNewSessionPreflightModelsState2({
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        selectedMachineId: 'machine-1',
        capabilityServerId: 'server-1',
        cwd: '/repo',
      }).preflightModels;
      return null;
    }

    let root2!: renderer.ReactTestRenderer;
    root2 = (await renderScreen(React.createElement(Harness2))).tree;
    await act(async () => {
      root2.unmount();
    });

    expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(2);
  });

  it('ignores legacy persisted model-option cache entries after the model-option contract changes', async () => {
    vi.resetModules();
    machineCapabilitiesInvokeMock.mockClear();

    const cacheKey = buildDynamicModelProbeCacheKey({
      machineId: 'machine-1',
      targetKey: 'agent:codex',
      serverId: 'server-1',
      cwd: '/repo',
    });
    if (!cacheKey) {
      throw new Error('expected dynamic model cache key');
    }

    const previousWindow = (globalThis as Record<string, unknown>).window;
    const previousDocument = (globalThis as Record<string, unknown>).document;
    const storageEntries = new Map<string, string>();
    const localStorage = {
      getItem(key: string): string | null {
        return storageEntries.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        storageEntries.set(key, value);
      },
      removeItem(key: string): void {
        storageEntries.delete(key);
      },
    };
    (globalThis as Record<string, unknown>).window = { localStorage };
    (globalThis as Record<string, unknown>).document = {};
    localStorage.setItem('dynamic-model-probe-cache-v1', JSON.stringify({
      version: 3,
      entries: {
        [cacheKey]: {
          updatedAt: Date.now(),
          value: {
            availableModels: [{
              id: 'gpt-5.4',
              name: 'gpt-5.4',
              modelOptions: [{
                id: 'speed',
                name: 'Fast',
                type: 'boolean',
                currentValue: false,
              }],
            }],
            supportsFreeform: false,
          },
        },
      },
    }));

    try {
      machineCapabilitiesInvokeMock.mockResolvedValueOnce({
        supported: true as const,
        response: {
          ok: true as const,
          result: {
            availableModels: [{
              id: 'gpt-5.4',
              name: 'gpt-5.4',
              modelOptions: [{
                id: 'speed',
                name: 'Fast',
                type: 'boolean',
                currentValue: 'standard',
                options: [
                  { value: 'standard', name: 'Standard' },
                  { value: 'fast', name: 'Fast' },
                ],
              }],
            }],
            supportsFreeform: false,
          },
        },
      });

      const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

      let latestPreflightModels: any = null;
      function Harness() {
        latestPreflightModels = useNewSessionPreflightModelsState({
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          selectedMachineId: 'machine-1',
          capabilityServerId: 'server-1',
          cwd: '/repo',
        }).preflightModels;
        return null;
      }

      let root!: renderer.ReactTestRenderer;
      root = (await renderScreen(React.createElement(Harness))).tree;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        root.unmount();
      });

      expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
      expect(latestPreflightModels).toEqual({
        availableModels: [{
          id: 'gpt-5.4',
          name: 'gpt-5.4',
          modelOptions: [{
            id: 'speed',
            name: 'Fast',
            type: 'boolean',
            currentValue: 'standard',
            options: [
              { value: 'standard', name: 'Standard' },
              { value: 'fast', name: 'Fast' },
            ],
          }],
        }],
        supportsFreeform: false,
      });
    } finally {
      if (previousWindow === undefined) {
        delete (globalThis as Record<string, unknown>).window;
      } else {
        (globalThis as Record<string, unknown>).window = previousWindow;
      }
      if (previousDocument === undefined) {
        delete (globalThis as Record<string, unknown>).document;
      } else {
        (globalThis as Record<string, unknown>).document = previousDocument;
      }
    }
  });

  it('re-probes when a persisted dynamic-model cache entry predates model options metadata', async () => {
    vi.resetModules();
    machineCapabilitiesInvokeMock.mockClear();

    const cacheKey = buildDynamicModelProbeCacheKey({
      machineId: 'machine-1',
      targetKey: 'agent:codex',
      serverId: 'server-1',
      cwd: '/repo',
    });
    if (!cacheKey) {
      throw new Error('expected dynamic model cache key');
    }

    const previousWindow = (globalThis as Record<string, unknown>).window;
    const previousDocument = (globalThis as Record<string, unknown>).document;
    const storageEntries = new Map<string, string>();
    const localStorage = {
      getItem(key: string): string | null {
        return storageEntries.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        storageEntries.set(key, value);
      },
      removeItem(key: string): void {
        storageEntries.delete(key);
      },
    };
    (globalThis as Record<string, unknown>).window = { localStorage };
    (globalThis as Record<string, unknown>).document = {};
    localStorage.setItem('dynamic-model-probe-cache-v1', JSON.stringify({
      version: 4,
      entries: {
        [cacheKey]: {
          updatedAt: Date.now(),
          value: {
            availableModels: [{
              id: 'gpt-5.4',
              name: 'gpt-5.4',
            }],
            supportsFreeform: false,
          },
        },
      },
    }));

    try {
      machineCapabilitiesInvokeMock.mockResolvedValueOnce({
        supported: true as const,
        response: {
          ok: true as const,
          result: {
            availableModels: [{
              id: 'gpt-5.4',
              name: 'gpt-5.4',
              modelOptions: [{
                id: 'reasoning_effort',
                name: 'Thinking',
                type: 'select',
                currentValue: 'medium',
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'medium', name: 'Medium' },
                ],
              }],
            }],
            supportsFreeform: false,
          },
        },
      });

      const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

      let latestPreflightModels: any = null;
      function Harness() {
        latestPreflightModels = useNewSessionPreflightModelsState({
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          selectedMachineId: 'machine-1',
          capabilityServerId: 'server-1',
          cwd: '/repo',
        }).preflightModels;
        return null;
      }

      let root!: renderer.ReactTestRenderer;
      root = (await renderScreen(React.createElement(Harness))).tree;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        root.unmount();
      });

      expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
      expect(latestPreflightModels).toEqual({
        availableModels: [{
          id: 'gpt-5.4',
          name: 'gpt-5.4',
          modelOptions: [{
            id: 'reasoning_effort',
            name: 'Thinking',
            type: 'select',
            currentValue: 'medium',
            options: [
              { value: 'low', name: 'Low' },
              { value: 'medium', name: 'Medium' },
            ],
          }],
        }],
        supportsFreeform: false,
      });
    } finally {
      if (previousWindow === undefined) {
        delete (globalThis as Record<string, unknown>).window;
      } else {
        (globalThis as Record<string, unknown>).window = previousWindow;
      }
      if (previousDocument === undefined) {
        delete (globalThis as Record<string, unknown>).document;
      } else {
        (globalThis as Record<string, unknown>).document = previousDocument;
      }
    }
  });

  it('re-probes when a persisted dynamic-model cache entry predates GPT 5.5 Speed metadata', async () => {
    vi.resetModules();
    machineCapabilitiesInvokeMock.mockClear();

    const cacheKey = buildDynamicModelProbeCacheKey({
      machineId: 'machine-1',
      targetKey: 'agent:codex',
      serverId: 'server-1',
      cwd: '/repo',
    });
    if (!cacheKey) {
      throw new Error('expected dynamic model cache key');
    }

    const previousWindow = (globalThis as Record<string, unknown>).window;
    const previousDocument = (globalThis as Record<string, unknown>).document;
    const storageEntries = new Map<string, string>();
    const localStorage = {
      getItem(key: string): string | null {
        return storageEntries.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        storageEntries.set(key, value);
      },
      removeItem(key: string): void {
        storageEntries.delete(key);
      },
    };
    (globalThis as Record<string, unknown>).window = { localStorage };
    (globalThis as Record<string, unknown>).document = {};
    localStorage.setItem('dynamic-model-probe-cache-v1', JSON.stringify({
      version: 5,
      entries: {
        [cacheKey]: {
          updatedAt: Date.now(),
          value: {
            availableModels: [{
              id: 'gpt-5.5',
              name: 'GPT 5.5',
            }],
            supportsFreeform: false,
          },
        },
      },
    }));

    try {
      machineCapabilitiesInvokeMock.mockResolvedValueOnce({
        supported: true as const,
        response: {
          ok: true as const,
          result: {
            availableModels: [{
              id: 'gpt-5.5',
              name: 'GPT 5.5',
              modelOptions: [{
                id: 'service_tier',
                name: 'Speed',
                type: 'select',
                currentValue: 'standard',
                options: [
                  { value: 'standard', name: 'Standard' },
                  { value: 'fast', name: 'Fast' },
                ],
              }],
            }],
            supportsFreeform: false,
          },
        },
      });

      const { useNewSessionPreflightModelsState } = await import('./useNewSessionPreflightModelsState');

      let latestPreflightModels: any = null;
      function Harness() {
        latestPreflightModels = useNewSessionPreflightModelsState({
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          selectedMachineId: 'machine-1',
          capabilityServerId: 'server-1',
          cwd: '/repo',
        }).preflightModels;
        return null;
      }

      let root!: renderer.ReactTestRenderer;
      root = (await renderScreen(React.createElement(Harness))).tree;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        root.unmount();
      });

      expect(machineCapabilitiesInvokeMock).toHaveBeenCalledTimes(1);
      expect(latestPreflightModels).toEqual({
        availableModels: [{
          id: 'gpt-5.5',
          name: 'GPT 5.5',
          modelOptions: [{
            id: 'service_tier',
            name: 'Speed',
            type: 'select',
            currentValue: 'standard',
            options: [
              { value: 'standard', name: 'Standard' },
              { value: 'fast', name: 'Fast' },
            ],
          }],
        }],
        supportsFreeform: false,
      });
    } finally {
      if (previousWindow === undefined) {
        delete (globalThis as Record<string, unknown>).window;
      } else {
        (globalThis as Record<string, unknown>).window = previousWindow;
      }
      if (previousDocument === undefined) {
        delete (globalThis as Record<string, unknown>).document;
      } else {
        (globalThis as Record<string, unknown>).document = previousDocument;
      }
    }
  });
});
