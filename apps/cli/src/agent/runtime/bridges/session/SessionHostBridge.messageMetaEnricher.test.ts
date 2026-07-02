import type { ProviderMessageMetaEnricher, SessionStateFacet } from '@happier-dev/agents';
import { describe, expect, it, vi } from 'vitest';

import { SessionHostBridge } from './SessionHostBridge';

type MinimalEngineAdapterResolution = Readonly<{
  backend?: Readonly<{
    capabilities?: Readonly<Record<string, unknown>>;
  }>;
  engineAdapter: Readonly<{
    runtimeCore: Readonly<{
      createSessionRuntime: (params: unknown) => Promise<unknown>;
    }>;
    messageMeta?: ProviderMessageMetaEnricher;
    facets?: Readonly<{
      sessionState?: SessionStateFacet;
    }>;
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
    externalSession: null,
    attach: null,
    handoff: null,
    fork: null,
    checkpoint: null,
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

  it('injects the engineAdapter sessionState facet into the host session runtime config', async () => {
    const createSessionRuntime = vi.fn(async () => ({
      kind: 'hostSessionRuntimePlan',
      providerId: 'codex',
      opts: { startedBy: 'terminal' },
      config: {},
    }));
    const sessionState: SessionStateFacet = {
      capabilities: {
        display: {
          title: {
            supported: true,
            happierToProvider: { supported: true, transport: 'runtime-hook' },
            providerToHappier: { supported: false as const },
          },
        },
      },
      applyHappierField: async () => {},
      readField: async () => null,
    };

    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      engineAdapter: {
        runtimeCore: { createSessionRuntime },
        facets: { sessionState },
      },
    });

    const bridge = new SessionHostBridge();

    const plan = await bridge.createSessionRuntime('codex', { startedBy: 'terminal' });

    expect(plan.config.sessionState).toEqual({
      facet: sessionState,
      capabilities: sessionState.capabilities,
    });
  });

  it('uses backend capabilities.session.state as the provider session-state gate when the facet has no inline capabilities', async () => {
    const createSessionRuntime = vi.fn(async () => ({
      kind: 'hostSessionRuntimePlan',
      providerId: 'codex',
      opts: { startedBy: 'terminal' },
      config: {},
    }));
    const sessionState: SessionStateFacet = {
      applyHappierField: async () => {},
      readField: async () => null,
    };
    const capabilities = {
      display: {
        title: {
          supported: true,
          happierToProvider: { supported: true, transport: 'runtime-hook' as const },
          providerToHappier: { supported: false as const },
        },
      },
    };

    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      backend: {
        capabilities: {
          session: {
            state: capabilities,
          },
        },
      } as never,
      engineAdapter: {
        runtimeCore: { createSessionRuntime },
        facets: { sessionState },
      },
    });

    const bridge = new SessionHostBridge();

    const plan = await bridge.createSessionRuntime('codex', { startedBy: 'terminal' });

    expect(plan.config.sessionState).toEqual({
      facet: sessionState,
      capabilities: {
        display: {
          title: {
            ...capabilities.display.title,
            providerToHappier: { supported: false },
          },
        },
      },
    });
  });

  it('rejects facet inline capabilities that do not satisfy the closed session-state schema', async () => {
    const createSessionRuntime = vi.fn(async () => ({
      kind: 'hostSessionRuntimePlan',
      providerId: 'codex',
      opts: { startedBy: 'terminal' },
      config: {},
    }));
    const sessionState = {
      capabilities: {
        display: {
          title: {
            supported: true,
            futureDirection: { supported: true },
          },
        },
      },
      applyHappierField: async () => {},
      readField: async () => null,
    } as unknown as SessionStateFacet;

    resolveBackendEngineAdapterResolutionMock.mockResolvedValue({
      engineAdapter: {
        runtimeCore: { createSessionRuntime },
        facets: { sessionState },
      },
    });

    const bridge = new SessionHostBridge();

    const plan = await bridge.createSessionRuntime('codex', { startedBy: 'terminal' });

    expect(plan.config.sessionState).toEqual({
      facet: sessionState,
      capabilities: {},
    });
  });
});
