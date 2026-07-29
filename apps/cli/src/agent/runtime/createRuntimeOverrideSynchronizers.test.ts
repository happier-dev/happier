import { describe, expect, it, vi } from 'vitest';

import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

import * as acpRuntimeOverrideSynchronizers from './createAcpRuntimeOverrideSynchronizers';
import { createRuntimeOverrideSynchronizers } from './createRuntimeOverrideSynchronizers';

describe('createRuntimeOverrideSynchronizers exports', () => {
  it('exposes the canonical export while keeping the ACP alias', () => {
    expect(typeof acpRuntimeOverrideSynchronizers.createRuntimeOverrideSynchronizers).toBe('function');
    expect(acpRuntimeOverrideSynchronizers.createAcpRuntimeOverrideSynchronizers).toBe(
      acpRuntimeOverrideSynchronizers.createRuntimeOverrideSynchronizers,
    );
  });

  it('applies metadata-only permission mode updates through the runtime target', async () => {
    const setPermissionMode = vi.fn(async (_mode: string) => {});

    const sync = createRuntimeOverrideSynchronizers({
      agentTargetKey: 'backend:codex',
      session: {
        getMetadataSnapshot: () => createTestMetadata({ permissionMode: 'yolo', permissionModeUpdatedAt: 42 }),
      },
      runtime: {
        setPermissionMode,
        setSessionMode: async () => {},
        setSessionConfigOption: async () => {},
        setSessionModelSelection: async () => {},
      },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await Promise.resolve();

    expect(setPermissionMode).toHaveBeenCalledTimes(1);
    expect(setPermissionMode).toHaveBeenCalledWith('yolo');
  });

  it('applies metadata model overrides before model-scoped config options', async () => {
    const calls: string[] = [];

    const sync = createRuntimeOverrideSynchronizers({
      agentTargetKey: 'backend:codex',
      session: {
        getMetadataSnapshot: () =>
          createTestMetadata({
            modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gpt-5.5' },
            sessionConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 11,
              overrides: {
                reasoning_effort: { updatedAt: 11, value: 'high' },
              },
            },
          }),
      },
      runtime: {
        setSessionMode: async (modeId: string) => {
          calls.push(`mode:${modeId}`);
        },
        setPermissionMode: async (permissionMode) => {
          calls.push(`permission:${permissionMode}`);
        },
        setSessionModelSelection: async (selection) => {
          calls.push(`model:${selection.modelId}`);
        },
        setSessionConfigOption: async (configId, value) => {
          calls.push(`config:${configId}:${String(value)}`);
        },
      },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();

    expect(calls).toEqual([
      'model:gpt-5.5',
      'config:reasoning_effort:high',
    ]);
  });

  it('waits for an async model override before applying model-scoped config options on started metadata sync', async () => {
    const calls: string[] = [];
    let resolveModel!: () => void;
    const modelApplied = new Promise<void>((resolve) => {
      resolveModel = resolve;
    });

    const sync = createRuntimeOverrideSynchronizers({
      agentTargetKey: 'backend:codex',
      session: {
        getMetadataSnapshot: () =>
          createTestMetadata({
            modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gpt-5.5' },
            sessionConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 11,
              overrides: {
                reasoning_effort: { updatedAt: 11, value: 'xhigh' },
              },
            },
          }),
      },
      runtime: {
        setSessionMode: async (modeId: string) => {
          calls.push(`mode:${modeId}`);
        },
        setPermissionMode: async (permissionMode) => {
          calls.push(`permission:${permissionMode}`);
        },
        setSessionModelSelection: async (selection) => {
          calls.push(`model:${selection.modelId}`);
          await modelApplied;
        },
        setSessionConfigOption: async (configId, value) => {
          calls.push(`config:${configId}:${String(value)}`);
        },
      },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(['model:gpt-5.5']);

    resolveModel();
    await modelApplied;
    await sync.flushPendingAfterStart();

    expect(calls).toEqual([
      'model:gpt-5.5',
      'config:reasoning_effort:xhigh',
    ]);
  });

  it('delegates a newer metadata model proposal while the owning transition is still in flight', async () => {
    let metadata = createTestMetadata({
      modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gpt-5.5' },
    });
    let resolveFirst!: () => void;
    const firstTransition = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const setSessionModelSelection = vi.fn(async (selection: { modelId: string }) => {
      if (selection.modelId === 'gpt-5.5') {
        await firstTransition;
      }
    });

    const sync = createRuntimeOverrideSynchronizers({
      agentTargetKey: 'backend:codex',
      session: {
        getMetadataSnapshot: () => metadata,
      },
      runtime: {
        setSessionMode: async () => {},
        setPermissionMode: async () => {},
        setSessionModelSelection,
        setSessionConfigOption: async () => {},
      },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await vi.waitFor(() => {
      expect(setSessionModelSelection).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: 'gpt-5.5' }),
      );
    });

    metadata = createTestMetadata({
      modelOverrideV1: { v: 1, updatedAt: 11, modelId: 'gpt-5.6' },
    });
    sync.syncFromMetadata();

    await vi.waitFor(() => {
      expect(setSessionModelSelection).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: 'gpt-5.6' }),
      );
    });

    resolveFirst();
    await sync.flushPendingAfterStart();
  });

  it('flushes pending model overrides before pending model-scoped config options after runtime start', async () => {
    const calls: string[] = [];
    let started = false;

    const sync = createRuntimeOverrideSynchronizers({
      agentTargetKey: 'backend:codex',
      session: {
        getMetadataSnapshot: () =>
          createTestMetadata({
            modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gpt-5.4-mini' },
            sessionConfigOptionOverridesV1: {
              v: 1,
              updatedAt: 11,
              overrides: {
                reasoning_effort: { updatedAt: 11, value: 'medium' },
              },
            },
          }),
      },
      runtime: {
        setSessionMode: async (modeId: string) => {
          calls.push(`mode:${modeId}`);
        },
        setPermissionMode: async (permissionMode) => {
          calls.push(`permission:${permissionMode}`);
        },
        setSessionModelSelection: async (selection) => {
          calls.push(`model:${selection.modelId}`);
        },
        setSessionConfigOption: async (configId, value) => {
          calls.push(`config:${configId}:${String(value)}`);
        },
      },
      isStarted: () => started,
    });

    sync.syncFromMetadata();
    expect(calls).toEqual([]);

    started = true;
    await sync.flushPendingAfterStart();

    expect(calls).toEqual([
      'model:gpt-5.4-mini',
      'config:reasoning_effort:medium',
    ]);
  });
});
