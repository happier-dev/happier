import { describe, expect, it, vi } from 'vitest';

import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { Metadata } from '@/api/types';
import type { RuntimeTurnMessageHandler } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { RuntimeEventV1 } from '@happier-dev/protocol';

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
    sessionId: 'session-1',
    updateMetadata: vi.fn(async (updater: (metadata: RuntimePublicationMetadata) => RuntimePublicationMetadata) => {
      void updater(createRuntimePublicationMetadata());
    }),
  };
  const sessionState = {
    writeHappierField: vi.fn(async (): Promise<
      | { ok: true; version: number }
      | { ok: false; reason: 'unknown_error' }
    > => ({ ok: true, version: 1 })),
  };
  const runtime = {
    subscribeRuntimeEvents: vi.fn((handler: RuntimeTurnMessageHandler) => {
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
    sessionState,
    runtime,
    emit(message: unknown) {
      runtimeHandler?.(message as RuntimeEventV1);
    },
  };
}

describe('subscribeSessionRuntimePublicationToMetadata', () => {
  it('normalizes runtime publication events before writing metadata and dedupes equal facets', () => {
    const harness = createHarness();
    const unsubscribe = subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
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

    expect(harness.sessionState.writeHappierField).toHaveBeenCalledWith({
      sessionId: 'session-1',
      fieldId: 'identity.runtimeDescriptor',
      value: {
        v: 1,
        providerId: 'acme.provider',
        provider: {
          backendMode: 'native',
        },
      },
      reason: 'reconciliation',
      metadataReason: 'runtime-identity-publication',
    });

    const updates = harness.session.updateMetadata.mock.calls.map(([updater]) =>
      updater(createRuntimePublicationMetadata()),
    );

    expect(updates).toEqual([
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
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
    });

    harness.emit({
      type: 'event',
      name: 'runtime.descriptor',
      payload: {
        providerId: 'missing-version',
      },
    });

    expect(harness.sessionState.writeHappierField).toHaveBeenCalledWith({
      sessionId: 'session-1',
      fieldId: 'identity.runtimeDescriptor',
      value: null,
      reason: 'reconciliation',
      metadataReason: 'runtime-identity-publication',
    });
    expect(harness.session.updateMetadata).not.toHaveBeenCalledWith(expect.any(Function));
  });

  it('retries an unchanged runtime descriptor after a failed session-state write', async () => {
    const harness = createHarness();
    harness.sessionState.writeHappierField
      .mockResolvedValueOnce({ ok: false as const, reason: 'unknown_error' })
      .mockResolvedValueOnce({ ok: true as const, version: 2 });
    subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
    });

    const descriptor = {
      v: 1,
      providerId: 'codex',
      provider: {
        backendMode: 'appServer',
        providerSessionId: 'thread-1',
      },
    };
    harness.emit({
      type: 'event',
      name: 'runtime.descriptor',
      payload: descriptor,
    });
    await Promise.resolve();
    harness.emit({
      type: 'event',
      name: 'runtime.descriptor',
      payload: descriptor,
    });

    expect(harness.sessionState.writeHappierField).toHaveBeenCalledTimes(2);
  });

  it('publishes legacy runtime facets through metadata while runtime identity stays session-state routed', () => {
    const harness = createHarness();
    subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
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
        runtimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
          },
        },
      })),
    );

    expect(updates).toEqual([
      createRuntimePublicationMetadata({
        runtimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
          },
        },
        agentRuntimeFacetsV1: {
          v: 1,
          transcriptSource: {
            supported: true,
          },
        },
      }),
    ]);
  });

  it('removes invalid runtime facets from metadata and later restores a valid normalized publication', () => {
    const harness = createHarness();
    subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
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
