import { describe, expect, it, vi } from 'vitest';
import { SessionControlApplyError } from './sessionControlApplyError';

import * as acpRuntimeOverrideSynchronizers from './createAcpRuntimeOverrideSynchronizers';
import { createSessionConfigOptionOverrideSynchronizer } from './sessionConfigOptionOverrideSync';

describe('createRuntimeOverrideSynchronizers exports', () => {
  it('exposes the canonical export while keeping the ACP alias', () => {
    expect(typeof acpRuntimeOverrideSynchronizers.createRuntimeOverrideSynchronizers).toBe('function');
    expect(acpRuntimeOverrideSynchronizers.createAcpRuntimeOverrideSynchronizers).toBe(
      acpRuntimeOverrideSynchronizers.createRuntimeOverrideSynchronizers,
    );
  });

  it('publishes tombstone support only from the installed model+config composition owner', () => {
    let agentState: any = { capabilities: { inFlightSteer: true } };
    acpRuntimeOverrideSynchronizers.createRuntimeOverrideSynchronizers({
      session: {
        getMetadataSnapshot: () => null,
        updateAgentState: (updater) => { agentState = updater(agentState); },
      },
      runtime: {
        setSessionMode: vi.fn(async () => undefined),
        setSessionModel: vi.fn(async () => undefined),
        setSessionConfigOption: vi.fn(async () => undefined),
      },
      isStarted: () => false,
    });
    expect(agentState.capabilities).toEqual({
      inFlightSteer: true,
      modelScopedConfigTombstonesV1: true,
    });
  });

  it('does not apply a captured config command after the model command is definitively rejected', async () => {
    const setSessionConfigOption = vi.fn(async () => undefined);
    const sync = acpRuntimeOverrideSynchronizers.createRuntimeOverrideSynchronizers({
      session: {
        getMetadataSnapshot: () => ({
          modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'model-b' },
          sessionConfigOptionOverridesV1: {
            v: 1,
            updatedAt: 10,
            overrides: { reasoning_effort: { updatedAt: 10, value: 'high' } },
          },
        }) as any,
      },
      runtime: {
        setSessionMode: vi.fn(async () => undefined),
        setSessionModel: vi.fn(async () => {
          throw SessionControlApplyError.definitive(new Error('unsupported model'));
        }),
        setSessionConfigOption,
      },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();
    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();

    expect(setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('durably tombstones captured config when a model rejection settles so a fresh synchronizer cannot replay it', async () => {
    let metadata: any = {
      modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'model-b' },
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 10,
        overrides: { reasoning_effort: { updatedAt: 10, value: 'high' } },
      },
    };
    let metadataWriteAttempts = 0;
    const session = {
      getMetadataSnapshot: () => metadata,
      updateMetadata: async (updater: (value: any) => any) => {
        metadataWriteAttempts += 1;
        if (metadataWriteAttempts === 2) throw new Error('offline during config cleanup');
        metadata = updater(metadata);
      },
    };
    const setSessionConfigOption = vi.fn(async () => undefined);
    const reportTerminalFailure = vi.fn();
    const sync = acpRuntimeOverrideSynchronizers.createRuntimeOverrideSynchronizers({
      session,
      runtime: {
        setSessionMode: vi.fn(async () => undefined),
        setSessionModel: vi.fn(async () => {
          throw SessionControlApplyError.definitive(new Error('unsupported model'));
        }),
        setSessionConfigOption,
      },
      isStarted: () => true,
      reportTerminalFailure,
    });

    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();
    expect(metadata.sessionConfigOptionOverridesV1.overrides.reasoning_effort.value).toBe('high');

    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();

    const freshSetSessionConfigOption = vi.fn(async () => undefined);
    const freshConfigSync = createSessionConfigOptionOverrideSynchronizer({
      session,
      runtime: { setSessionConfigOption: freshSetSessionConfigOption },
      isStarted: () => true,
    });
    freshConfigSync.syncFromMetadata();
    await freshConfigSync.flushPendingAfterStart();

    expect(metadata.sessionConfigOptionOverridesV1.overrides.reasoning_effort.value).toBeNull();
    expect(setSessionConfigOption).not.toHaveBeenCalled();
    expect(freshSetSessionConfigOption).not.toHaveBeenCalled();
    expect(reportTerminalFailure).toHaveBeenCalledTimes(1);
    expect(reportTerminalFailure).toHaveBeenCalledWith(expect.objectContaining({ kind: 'model' }));
  });

  it('preserves a strictly newer config command after the model command is definitively rejected', async () => {
    let metadata: any = {
      modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'model-b' },
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 10,
        overrides: { reasoning_effort: { updatedAt: 10, value: 'high' } },
      },
    };
    const setSessionConfigOption = vi.fn(async () => undefined);
    const sync = acpRuntimeOverrideSynchronizers.createRuntimeOverrideSynchronizers({
      session: {
        getMetadataSnapshot: () => metadata,
        updateMetadata: async (updater) => { metadata = updater(metadata); },
      },
      runtime: {
        setSessionMode: vi.fn(async () => undefined),
        setSessionModel: vi.fn(async () => {
          throw SessionControlApplyError.definitive(new Error('unsupported model'));
        }),
        setSessionConfigOption,
      },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();
    metadata = {
      ...metadata,
      sessionConfigOptionOverridesV1: {
        v: 1,
        updatedAt: 11,
        overrides: { reasoning_effort: { updatedAt: 11, value: 'low' } },
      },
    };
    sync.syncFromMetadata();
    await sync.flushPendingAfterStart();

    expect(setSessionConfigOption).toHaveBeenCalledTimes(1);
    expect(setSessionConfigOption).toHaveBeenCalledWith('reasoning_effort', 'low');
  });

  it('applies pending model overrides before model-scoped config overrides after startup', async () => {
    const calls: string[] = [];
    let resolveModelApply!: () => void;
    const modelApply = new Promise<void>((resolve) => {
      resolveModelApply = resolve;
    });
    const setSessionModel = vi.fn(async (modelId: string) => {
      calls.push(`model:${modelId}`);
      await modelApply;
    });
    const setSessionConfigOption = vi.fn(async (configId: string, valueId: string) => {
      calls.push(`config:${configId}:${valueId}`);
    });

    const sync = acpRuntimeOverrideSynchronizers.createRuntimeOverrideSynchronizers({
      session: {
        getMetadataSnapshot: () => ({
          modelOverrideV1: { v: 1, updatedAt: 10, modelId: 'gpt-5.5' },
          sessionConfigOptionOverridesV1: {
            v: 1,
            updatedAt: 11,
            overrides: {
              fast: { updatedAt: 11, value: true },
            },
          },
        } as any),
      },
      runtime: {
        setSessionMode: vi.fn(async () => {}),
        setSessionModel,
        setSessionConfigOption,
      },
      isStarted: () => true,
    });

    sync.syncFromMetadata();
    await Promise.resolve();
    expect(calls).toEqual(['model:gpt-5.5']);

    resolveModelApply();
    await sync.flushPendingAfterStart();
    expect(calls).toEqual(['model:gpt-5.5', 'config:fast:true']);
  });
});
