import { describe, expect, it, vi } from 'vitest';

import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { Metadata } from '@/api/types';
import type {
  RuntimeTurnMessage,
  RuntimeTurnMessageHandler,
} from '@/agent/runtime/turns/runtimeTurnOperations';

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

function createHarness(options?: Readonly<{ providerSessionId?: string | null }>) {
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
    readSessionIdentity: vi.fn(() => ({ sessionId: options?.providerSessionId ?? null })),
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
    emit(message: RuntimeTurnMessage) {
      runtimeHandler?.(message);
    },
  };
}

describe('subscribeSessionRuntimePublicationToMetadata', () => {
  it('publishes the runtime provider session identity through the declared vendor metadata field', () => {
    const harness = createHarness({ providerSessionId: 'grok-provider-session-1' });
    subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
      providerSessionMetadataKey: 'grokSessionId',
    });

    expect(harness.sessionState.writeHappierField).toHaveBeenCalledWith({
      sessionId: 'session-1',
      fieldId: 'identity.providerSessionId',
      value: {
        metadataKey: 'grokSessionId',
        value: 'grok-provider-session-1',
        // Explicit: an id published with no log path CLEARS any stale slot.
        nativeSessionLogPath: null,
      },
      reason: 'reconciliation',
      metadataReason: 'runtime-provider-session-id',
      mirrorToProvider: false,
    });
  });

  it('publishes canonical provider-session-id events through the declared vendor metadata field', () => {
    const harness = createHarness();
    subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
      providerSessionMetadataKey: 'grokSessionId',
    });

    harness.emit({
      kind: 'provider-session-id',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      providerSessionId: 'grok-provider-session-1',
    });

    expect(harness.sessionState.writeHappierField).toHaveBeenCalledWith({
      sessionId: 'session-1',
      fieldId: 'identity.providerSessionId',
      value: {
        metadataKey: 'grokSessionId',
        value: 'grok-provider-session-1',
        // Explicit: an id published with no proof CLEARS any stale proof slot.
        nativeSessionLogPath: null,
      },
      reason: 'reconciliation',
      metadataReason: 'runtime-provider-session-id',
      mirrorToProvider: false,
    });
  });

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
        agentId: 'acme.provider',
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
        agentId: 'acme.provider',
        agent: {
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
      agentId: 'codex',
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
          agentId: 'codex',
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
          agentId: 'codex',
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

describe('subscribeSessionRuntimePublicationToMetadata — matched native resume identity', () => {
  it('carries a runtime-published continuity proof into the same metadata write as its id', () => {
    const harness = createHarness();
    subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
      providerSessionMetadataKey: 'claudeSessionId',
    });

    harness.emit({
      kind: 'provider-session-id',
      providerSessionId: 'claude-1',
      nativeSessionLogPath: '/home/u/.claude/x/claude-1.jsonl',
    } as never);

    expect(harness.sessionState.writeHappierField).toHaveBeenCalledWith(expect.objectContaining({
      fieldId: 'identity.providerSessionId',
      value: {
        metadataKey: 'claudeSessionId',
        value: 'claude-1',
        nativeSessionLogPath: '/home/u/.claude/x/claude-1.jsonl',
      },
    }));
  });

  it('republishes when a later generation learns the log path of an already-published id', () => {
    // The runtime knows its id before the conversation materializes. An id-keyed
    // dedupe would swallow the update that carries the path, and the successor
    // Agent would be offered no log to read.
    const harness = createHarness();
    subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
      providerSessionMetadataKey: 'claudeSessionId',
    });

    harness.emit({ kind: 'provider-session-id', providerSessionId: 'claude-1' } as never);
    harness.emit({
      kind: 'provider-session-id',
      providerSessionId: 'claude-1',
      nativeSessionLogPath: '/home/u/.claude/x/claude-1.jsonl',
    } as never);

    expect(harness.sessionState.writeHappierField).toHaveBeenCalledTimes(2);
    expect(harness.sessionState.writeHappierField).toHaveBeenLastCalledWith(expect.objectContaining({
      value: expect.objectContaining({
        nativeSessionLogPath: '/home/u/.claude/x/claude-1.jsonl',
      }),
    }));
  });

  it('still dedupes an unchanged id/log-path pair', () => {
    const harness = createHarness();
    subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
      providerSessionMetadataKey: 'claudeSessionId',
    });

    harness.emit({ kind: 'provider-session-id', providerSessionId: 'claude-1' } as never);
    harness.emit({ kind: 'provider-session-id', providerSessionId: 'claude-1' } as never);

    expect(harness.sessionState.writeHappierField).toHaveBeenCalledTimes(1);
  });

  it('publishes a null log path so a retracted one clears the persisted slot', () => {
    const harness = createHarness();
    subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
      providerSessionMetadataKey: 'claudeSessionId',
    });

    harness.emit({
      kind: 'provider-session-id',
      providerSessionId: 'claude-1',
      nativeSessionLogPath: '/home/u/.claude/x/claude-1.jsonl',
    } as never);
    harness.emit({ kind: 'provider-session-id', providerSessionId: 'claude-1' } as never);

    expect(harness.sessionState.writeHappierField).toHaveBeenLastCalledWith(expect.objectContaining({
      value: { metadataKey: 'claudeSessionId', value: 'claude-1', nativeSessionLogPath: null },
    }));
  });

  it('ignores a non-string log path rather than trusting it', () => {
    const harness = createHarness();
    subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
      providerSessionMetadataKey: 'claudeSessionId',
    });

    harness.emit({
      kind: 'provider-session-id',
      providerSessionId: 'claude-1',
      nativeSessionLogPath: { kind: 'sessionFile', value: '/tmp/x' },
    } as never);

    expect(harness.sessionState.writeHappierField).toHaveBeenCalledWith(expect.objectContaining({
      value: { metadataKey: 'claudeSessionId', value: 'claude-1', nativeSessionLogPath: null },
    }));
  });
});

/**
 * An external (manifest-contributed) Agent has no catalog-declared flat
 * `<vendor>SessionId` slot, so the host resolves no `providerSessionMetadataKey`
 * for it. The documented `provider-session-id` channel must still reach session
 * state — the binding decides where the id lands — or the Agent's native
 * conversation is never recorded and a later resume silently starts fresh.
 */
describe('subscribeSessionRuntimePublicationToMetadata — Agent with no catalog-declared slot', () => {
  it('publishes the native id with no metadata key instead of dropping the event', () => {
    const harness = createHarness();
    subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
      providerSessionMetadataKey: null,
    });

    harness.emit({
      kind: 'provider-session-id',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      providerSessionId: ' acme-native-1 ',
    });

    expect(harness.sessionState.writeHappierField).toHaveBeenCalledWith({
      sessionId: 'session-1',
      fieldId: 'identity.providerSessionId',
      value: {
        metadataKey: null,
        value: 'acme-native-1',
        nativeSessionLogPath: null,
      },
      reason: 'reconciliation',
      metadataReason: 'runtime-provider-session-id',
      mirrorToProvider: false,
    });
  });

  it('still refuses to publish an empty native id', () => {
    const harness = createHarness();
    subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
      providerSessionMetadataKey: null,
    });

    harness.emit({
      kind: 'provider-session-id',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      providerSessionId: '   ',
    });

    expect(harness.sessionState.writeHappierField).not.toHaveBeenCalled();
  });
});
