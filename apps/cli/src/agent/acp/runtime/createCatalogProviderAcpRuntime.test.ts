import { describe, expect, it, vi } from 'vitest';

import { createApprovedPermissionHandler } from '@/testkit/backends/permissionHandler';
import { createApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createCatalogProviderAcpRuntime } from './createCatalogProviderAcpRuntime';

function createParams() {
  return {
    provider: 'qwen' as const,
    loggerLabel: 'QwenACP',
    directory: '/tmp',
    session: createApiSessionClientFixture(),
    messageBuffer: new MessageBuffer(),
    mcpServers: {},
    permissionHandler: createApprovedPermissionHandler(),
    onThinkingChange: () => {},
    providerInputConsumer: {
      waitForNextInput: async () => null,
      runProviderInputDispatch: async <Value>({ dispatch }: { dispatch: () => Promise<Value> }) => ({ status: 'dispatched' as const, value: await dispatch() }),
      closeProviderInputAdmissionAndWaitForDispatches: async () => {},
      drainPending: async () => ({ materialized: 0, stoppedReason: 'no_pending' as const }),
      pumpPendingWhileActive: async () => {},
    },
  };
}

describe('createCatalogProviderAcpRuntime session identity ownership', () => {
  it('constructs the manifest-backed identity publisher for a resumable agent', () => {
    const runtime = createCatalogProviderAcpRuntime({
      ...createParams(),
      sessionIdentity: { kind: 'manifest-metadata' },
    });

    expect(runtime.getSessionId()).toBeNull();
  });

  it('rejects runtime-only identity when the manifest advertises vendor resume', () => {
    expect(() => createCatalogProviderAcpRuntime({
      ...createParams(),
      sessionIdentity: {
        kind: 'runtime-only',
        reason: 'vendor-resume-unsupported',
      },
    })).toThrow(/advertises vendor resume/i);
  });

  it('runs the shared active-turn pending pump so send-now can interrupt when in-flight steer is unsupported', async () => {
    const pumpPendingWhileActive = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        if (abortSignal.aborted) return resolve();
        abortSignal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const runtime = createCatalogProviderAcpRuntime({
      ...createParams(),
      provider: 'grok',
      loggerLabel: 'GrokACP',
      providerInputConsumer: {
        ...createParams().providerInputConsumer,
        pumpPendingWhileActive,
      },
      sessionIdentity: { kind: 'manifest-metadata' },
    });

    expect(runtime.supportsInFlightSteer()).toBe(false);
    runtime.beginTurn();
    await vi.waitFor(() => {
      expect(pumpPendingWhileActive).toHaveBeenCalledTimes(1);
    });

    await runtime.reset();
  });

  it('runs the shared active-turn pending pump for a steer-capable catalog provider', async () => {
    const pumpPendingWhileActive = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        if (abortSignal.aborted) return resolve();
        abortSignal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const runtime = createCatalogProviderAcpRuntime({
      ...createParams(),
      providerInputConsumer: {
        ...createParams().providerInputConsumer,
        pumpPendingWhileActive,
      },
      sessionIdentity: { kind: 'manifest-metadata' },
      inFlightSteer: { enabled: true },
    });

    runtime.beginTurn();
    await vi.waitFor(() => {
      expect(pumpPendingWhileActive).toHaveBeenCalledTimes(1);
    });

    await runtime.reset();
  });
});
