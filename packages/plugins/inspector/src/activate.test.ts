import type { PluginApi, PluginHookPayloadMapV1 } from '@happier-dev/plugin-sdk';
import { describe, expect, it, vi } from 'vitest';

import * as inspectorActivation from './activate';

describe('Plugin Inspector activation', () => {
  it('registers the reload hook and records reload state updates', async () => {
    const api = {
      registerHook: vi.fn(() => ({ dispose: vi.fn() })),
      onDispose: vi.fn(),
    } as unknown as PluginApi;
    const readSnapshot = (
      inspectorActivation as Readonly<{
        readInspectorRuntimeStateSnapshot?: () => unknown;
        resetInspectorRuntimeStateForTest?: () => void;
      }>
    ).readInspectorRuntimeStateSnapshot;
    const resetState = (
      inspectorActivation as Readonly<{
        resetInspectorRuntimeStateForTest?: () => void;
      }>
    ).resetInspectorRuntimeStateForTest;

    resetState?.();
    inspectorActivation.activate(api);

    expect(api.registerHook).toHaveBeenCalledWith({
      hookId: 'plugin.reload.after',
      handler: expect.any(Function),
    });
    expect(api.onDispose).not.toHaveBeenCalled();
    expect(readSnapshot).toBeTypeOf('function');

    const handler = (api.registerHook as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.handler as
      | ((payload: PluginHookPayloadMapV1['plugin.reload.after']) => void | Promise<void>)
      | undefined;
    await handler?.({
      pluginId: 'acme.plugin',
      success: true,
      timestampMs: 1,
      generation: 7,
      attemptedGeneration: 7,
      activeGenerationId: 'reload:7',
      registryStatus: 'active',
      affectedPluginIds: ['acme.plugin'],
      changedPluginIds: ['acme.plugin'],
    });

    expect(readSnapshot?.()).toEqual({
      lastReload: {
        generation: 7,
        attemptedGeneration: 7,
        activeGenerationId: 'reload:7',
        registryStatus: 'active',
        affectedPluginIds: ['acme.plugin'],
        changedPluginIds: ['acme.plugin'],
      },
    });
  });
});
