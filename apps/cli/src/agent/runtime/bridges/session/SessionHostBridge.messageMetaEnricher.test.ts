import type { ProviderMessageMetaEnricher } from '@happier-dev/agents';
import { describe, expect, it, vi } from 'vitest';

import { SessionHostBridge } from './SessionHostBridge';

type MinimalEngineAdapterResolution = Readonly<{
  engineAdapter: Readonly<{
    runtimeCore: Readonly<{
      createSessionRuntime: (params: unknown) => Promise<unknown>;
    }>;
    messageMeta?: ProviderMessageMetaEnricher;
  }>;
}>;

const { resolveBackendEngineAdapterResolutionMock } = vi.hoisted(() => ({
  resolveBackendEngineAdapterResolutionMock: vi.fn<
    (backendId: string) => Promise<MinimalEngineAdapterResolution | null>
  >(),
}));

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
  resolveBackendEngineAdapterResolution: (backendId: string) =>
    resolveBackendEngineAdapterResolutionMock(backendId),
  resolveBackendExecutionSurfaces: async () => ({
    terminalRuntime: null,
    directSessions: null,
    attach: null,
    sessionHandoff: null,
  }),
}));

describe('SessionHostBridge message-meta injection', () => {
  it('injects the engineAdapter messageMeta enricher into the session runtime params', async () => {
    const createSessionRuntime = vi.fn(async () => ({
      kind: 'hostSessionRuntimePlan',
      providerId: 'claude',
      opts: { startedBy: 'terminal' },
      config: {},
    }));
    const messageMetaEnricher: ProviderMessageMetaEnricher = Object.freeze({
      buildOutgoingMessageMetaExtras: () => ({ claudeRemoteAgentSdkEnabled: true }),
    });

    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      engineAdapter: {
        runtimeCore: { createSessionRuntime },
        messageMeta: messageMetaEnricher,
      },
    });

    const bridge = new SessionHostBridge();

    await bridge.createSessionRuntime('claude', { startedBy: 'terminal' });

    expect(createSessionRuntime).toHaveBeenCalledWith(expect.objectContaining({
      startedBy: 'terminal',
      providerMessageMetaEnricher: messageMetaEnricher,
    }));
  });
});
