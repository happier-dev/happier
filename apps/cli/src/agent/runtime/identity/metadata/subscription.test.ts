import { describe, expect, it, vi } from 'vitest';

import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { Metadata } from '@/api/types';
import type { RuntimeTurnMessageHandler } from '@/agent/runtime/turns/runtimeTurnOperations';

import { subscribeSessionRuntimePublicationToMetadata } from './subscription';

type RuntimePublicationMetadata = Metadata & Readonly<{
  runtimeDescriptorV1?: unknown;
  agentRuntimeDescriptorV1?: unknown;
  agentRuntimeCapabilitiesV1?: unknown;
  agentRuntimeFacetsV1?: unknown;
}>;

function createRuntimePublicationMetadata(
  overrides?: Partial<RuntimePublicationMetadata>,
): RuntimePublicationMetadata {
  return {
    ...createTestMetadata(),
    ...overrides,
  };
}

function createHarness() {
  let runtimeHandler: RuntimeTurnMessageHandler | null = null;

  const session = {
    updateMetadata: vi.fn(async (updater: (metadata: RuntimePublicationMetadata) => RuntimePublicationMetadata) => {
      void updater(createRuntimePublicationMetadata());
    }),
  };
  const runtime = {
    subscribeRuntimeMessages: vi.fn((handler: RuntimeTurnMessageHandler) => {
      runtimeHandler = handler;
      return () => {
        if (runtimeHandler === handler) {
          runtimeHandler = null;
        }
      };
    }),
  };

  return {
    session,
    runtime,
    emit(message: unknown) {
      runtimeHandler?.(message);
    },
  };
}

describe('subscribeSessionRuntimePublicationToMetadata', () => {
  it('normalizes runtime publication events before writing metadata and dedupes equal facets', () => {
    const harness = createHarness();
    const unsubscribe = subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      runtime: harness.runtime as never,
    });

    harness.emit({
      type: 'event',
      name: 'runtime.descriptor',
      payload: {
        v: 1,
        providerId: 'acme.provider',
        provider: {
          backendMode: 'native',
        },
      },
    });
    harness.emit({
      type: 'event',
      name: 'runtime.capabilities',
      payload: {
        executionRun: {
          supported: true,
        },
      },
    });
    harness.emit({
      type: 'event',
      name: 'runtime.facets',
      payload: {
        v: 1,
        transcriptSource: {
          supported: true,
          followLeaseSupported: true,
        },
      },
    });
    harness.emit({
      type: 'event',
      name: 'runtime.facets',
      payload: {
        v: 1,
        transcriptSource: {
          supported: true,
          followLeaseSupported: true,
        },
      },
    });
    unsubscribe();

    const updates = harness.session.updateMetadata.mock.calls.map(([updater]) =>
      updater(createRuntimePublicationMetadata()),
    );

    expect(updates).toEqual([
      createRuntimePublicationMetadata({
        runtimeDescriptorV1: {
          v: 1,
          providerId: 'acme.provider',
          provider: {
            backendMode: 'native',
          },
        },
      }),
      createRuntimePublicationMetadata({
        agentRuntimeCapabilitiesV1: {
          executionRun: {
            supported: true,
          },
        },
      }),
      createRuntimePublicationMetadata({
        agentRuntimeFacetsV1: {
          v: 1,
          transcriptSource: {
            supported: true,
            followLeaseSupported: true,
          },
        },
      }),
    ]);
  });

  it('clears both runtimeDescriptorV1 and the legacy alias when the runtime descriptor payload is invalid', () => {
    const harness = createHarness();
    subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      runtime: harness.runtime as never,
    });

    harness.emit({
      type: 'event',
      name: 'runtime.descriptor',
      payload: {
        providerId: 'missing-version',
      },
    });

    const updates = harness.session.updateMetadata.mock.calls.map(([updater]) =>
      updater(createRuntimePublicationMetadata({
        runtimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
          },
        },
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
          },
        },
      })),
    );

    expect(updates).toEqual([
      createRuntimePublicationMetadata(),
    ]);
  });

  it('removes invalid runtime facets from metadata and later restores a valid normalized publication', () => {
    const harness = createHarness();
    subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      runtime: harness.runtime as never,
    });

    harness.emit({
      type: 'event',
      name: 'runtime.facets',
      payload: {
        v: 1,
        transcriptSource: {
          supported: false,
        },
      },
    });
    harness.emit({
      type: 'event',
      name: 'runtime.facets',
      payload: {
        v: 1,
        transcriptSource: {
          supported: true,
        },
      },
    });

    const updates = harness.session.updateMetadata.mock.calls.map(([updater]) =>
      updater(createRuntimePublicationMetadata({
        agentRuntimeFacetsV1: {
          v: 1,
          transcriptSource: {
            supported: true,
            followLeaseSupported: true,
          },
        },
      })),
    );

    expect(updates).toEqual([
      createRuntimePublicationMetadata(),
      createRuntimePublicationMetadata({
        agentRuntimeFacetsV1: {
          v: 1,
          transcriptSource: {
            supported: true,
          },
        },
      }),
    ]);
  });
});
