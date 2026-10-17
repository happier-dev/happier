import { describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';

import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { Metadata } from '@/api/types';
import type { NormalizedRuntimeIdentityPublicationV1 } from '@/agent/runtime/events/createNormalizedRuntimeEventWriter';
import { createSessionOwnerMetadataV1, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { readSessionCapabilityAgentFactsV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';

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

type IdentityPublicationHandler = (publication: NormalizedRuntimeIdentityPublicationV1) => void;

function createHarness(options?: Readonly<{ providerSessionId?: string | null }>) {
  let identityHandler: IdentityPublicationHandler | null = null;

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
    subscribeRuntimeIdentityPublication: vi.fn((handler: IdentityPublicationHandler) => {
      identityHandler = handler;
      return () => {
        if (identityHandler === handler) {
          identityHandler = null;
        }
      };
    }),
  };

  return {
    session,
    sessionState,
    runtime,
    publish(publication: NormalizedRuntimeIdentityPublicationV1) {
      identityHandler?.(publication);
    },
  };
}

describe('subscribeSessionRuntimePublicationToMetadata', () => {
  it('fences lifecycle events after metadata observation is disposed', () => {
    const harness = createHarness({ providerSessionId: 'initial-native-session' });
    const publication = subscribeSessionRuntimePublicationToMetadata({
      session: harness.session, sessionState: harness.sessionState, runtime: harness.runtime,
    });
    expect(harness.sessionState.writeHappierField).toHaveBeenCalledTimes(1);
    publication();
    publication.observeRuntimeEvent({ kind: 'provider-session-id', providerSessionId: 'late-native-session',
      sessionId: harness.session.sessionId, sequence: 1, emittedAtMs: 1 });
    expect(harness.sessionState.writeHappierField).toHaveBeenCalledTimes(1);
  });

  it('contains a refused capability metadata transport publication and accepts a later native publication', async () => {
    const harness = createHarness();
    let metadata = createRuntimePublicationMetadata();
    let refused = false;
    const session = { ...harness.session, updateMetadata: async (updater: (metadata: Metadata) => Metadata) => {
      if (!refused) { refused = true; throw new Error('metadata transport refused'); }
      metadata = updater(metadata);
    } };
    const unhandled: unknown[] = [];
    const observeUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on('unhandledRejection', observeUnhandled);
    const facts = { vendorResume: 'unsupported', skillsLiveReload: 'supported' } as const;
    const unsubscribe = subscribeSessionRuntimePublicationToMetadata({ session,
      sessionState: harness.sessionState, runtime: harness.runtime as never, capabilitySelection: facts });
    try {
      await setImmediate();
      harness.publish({ fact: 'runtimeCapabilities', value: { localControl: { supported: false } } });
      await setImmediate();
      expect(readSessionCapabilityAgentFactsV1(metadata)).toEqual(facts);
      expect(unhandled).toEqual([]);
    } finally { unsubscribe(); process.off('unhandledRejection', observeUnhandled); }
  });
  it('keeps host-resolved capability apply facts through native capability publications and strict owner envelopes', async () => {
    const harness = createHarness();
    const updates: RuntimePublicationMetadata[] = [];
    let metadata = createRuntimePublicationMetadata();
    harness.session.updateMetadata.mockImplementation(async updater => { metadata = updater(metadata); updates.push(metadata); });
    const facts = { vendorResume: 'unsupported', skillsLiveReload: 'supported' } as const;
    const unsubscribe = subscribeSessionRuntimePublicationToMetadata({
      session: harness.session, sessionState: harness.sessionState, runtime: harness.runtime as never,
      capabilitySelection: facts,
    });
    harness.publish({ fact: 'runtimeCapabilities', value: { localControl: { supported: false },
      capabilitySelection: { vendorResume: 'supported', skillsLiveReload: 'unsupported' } } });
    await Promise.resolve();
    expect(readSessionCapabilityAgentFactsV1(metadata)).toEqual(facts);
    expect(metadata.agentRuntimeCapabilitiesV1).toMatchObject({ localControl: { supported: false } });
    const owner = createSessionOwnerMetadataV1({ metadata });
    if (!owner.ok) throw new Error(`Published capability facts rejected: ${JSON.stringify(owner)}`);
    expect(SessionOwnerMetadataV1Schema.parse(owner.ownerMetadata)).toEqual(owner.ownerMetadata);
    expect(updates.length).toBeGreaterThan(0);
    unsubscribe();
  });
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
    const publication = subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
      providerSessionMetadataKey: 'grokSessionId',
    });

    publication.observeRuntimeEvent({
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

  it('publishes an opaque provider session id byte-exact', () => {
    // The Agent minted these bytes; whitespace, newline and base64 punctuation
    // are identity. Publishing a trimmed value makes the successor runtime ask
    // the Agent for a session it never issued.
    const opaqueProviderSessionId = '  provider\nses/AB+cd==  ';
    const harness = createHarness({ providerSessionId: opaqueProviderSessionId });
    subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
      providerSessionMetadataKey: 'grokSessionId',
    });

    expect(harness.sessionState.writeHappierField).toHaveBeenCalledWith(
      expect.objectContaining({
        fieldId: 'identity.providerSessionId',
        value: {
          metadataKey: 'grokSessionId',
          value: opaqueProviderSessionId,
          nativeSessionLogPath: null,
        },
      }),
    );
  });

  it('does not publish a whitespace-only provider session id', () => {
    const harness = createHarness({ providerSessionId: '   \n  ' });
    subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
      providerSessionMetadataKey: 'grokSessionId',
    });

    expect(harness.sessionState.writeHappierField).not.toHaveBeenCalled();
  });

  it('routes each typed runtime publication fact to its single writer and dedupes equal facets', () => {
    const harness = createHarness();
    const unsubscribe = subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
    });

    harness.publish({
      fact: 'runtimeDescriptor',
      value: {
        v: 1,
        agentId: 'acme.provider',
        agent: {
          backendMode: 'native',
        },
      },
    });
    harness.publish({
      fact: 'runtimeCapabilities',
      value: {
        executionRun: {
          supported: true,
        },
      },
    });
    harness.publish({
      fact: 'runtimeFacets',
      value: {
        v: 1,
        transcriptSource: {
          supported: true,
          followLeaseSupported: true,
        },
      },
    });
    harness.publish({
      fact: 'runtimeFacets',
      value: {
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

  it('never routes host-owned identity facts through the canonical Agent Session event stream', () => {
    const harness = createHarness();
    const publication = subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
    });

    // A pseudo-event is no longer a member of the canonical union, so even a
    // hand-forged one must not be interpreted as a host identity publication.
    publication.observeRuntimeEvent({
      type: 'event',
      name: 'runtime.descriptor',
      payload: { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } },
    } as never);

    expect(harness.sessionState.writeHappierField).not.toHaveBeenCalled();
    expect(harness.session.updateMetadata).not.toHaveBeenCalled();
  });

  it('retains session-state identity publication but suppresses owner metadata for a shared-editor runtime', () => {
    const harness = createHarness();
    subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
      publishOwnerMetadata: false,
    });

    harness.publish({
      fact: 'runtimeDescriptor',
      value: { v: 1, agentId: 'external-agent', agent: { backendMode: 'appServer' } },
    });
    harness.publish({ fact: 'runtimeCapabilities', value: { v: 1 } });
    harness.publish({ fact: 'runtimeFacets', value: { v: 1 } });

    expect(harness.sessionState.writeHappierField).toHaveBeenCalledWith(expect.objectContaining({
      fieldId: 'identity.runtimeDescriptor',
    }));
    expect(harness.session.updateMetadata).not.toHaveBeenCalled();
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
      agent: {
        backendMode: 'appServer',
        providerSessionId: 'thread-1',
      },
    } as const;
    harness.publish({ fact: 'runtimeDescriptor', value: descriptor });
    await Promise.resolve();
    harness.publish({ fact: 'runtimeDescriptor', value: descriptor });

    expect(harness.sessionState.writeHappierField).toHaveBeenCalledTimes(2);
  });

  it('publishes legacy runtime facets through metadata while runtime identity stays session-state routed', () => {
    const harness = createHarness();
    subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
    });

    harness.publish({
      fact: 'runtimeFacets',
      value: {
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

  it('replaces a stale runtime facets publication with the newest published value', () => {
    const harness = createHarness();
    subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
    });

    harness.publish({
      fact: 'runtimeFacets',
      value: {
        v: 1,
        transcriptSource: {
          supported: true,
          followLeaseSupported: true,
        },
      },
    });
    harness.publish({
      fact: 'runtimeFacets',
      value: {
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
      createRuntimePublicationMetadata({
        agentRuntimeFacetsV1: {
          v: 1,
          transcriptSource: {
            supported: true,
            followLeaseSupported: true,
          },
        },
      }),
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
    const publication = subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
      providerSessionMetadataKey: 'claudeSessionId',
    });

    publication.observeRuntimeEvent({
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
    const publication = subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
      providerSessionMetadataKey: 'claudeSessionId',
    });

    publication.observeRuntimeEvent({ kind: 'provider-session-id', providerSessionId: 'claude-1' } as never);
    publication.observeRuntimeEvent({
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
    const publication = subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
      providerSessionMetadataKey: 'claudeSessionId',
    });

    publication.observeRuntimeEvent({ kind: 'provider-session-id', providerSessionId: 'claude-1' } as never);
    publication.observeRuntimeEvent({ kind: 'provider-session-id', providerSessionId: 'claude-1' } as never);

    expect(harness.sessionState.writeHappierField).toHaveBeenCalledTimes(1);
  });

  it('publishes a null log path so a retracted one clears the persisted slot', () => {
    const harness = createHarness();
    const publication = subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
      providerSessionMetadataKey: 'claudeSessionId',
    });

    publication.observeRuntimeEvent({
      kind: 'provider-session-id',
      providerSessionId: 'claude-1',
      nativeSessionLogPath: '/home/u/.claude/x/claude-1.jsonl',
    } as never);
    publication.observeRuntimeEvent({ kind: 'provider-session-id', providerSessionId: 'claude-1' } as never);

    expect(harness.sessionState.writeHappierField).toHaveBeenLastCalledWith(expect.objectContaining({
      value: { metadataKey: 'claudeSessionId', value: 'claude-1', nativeSessionLogPath: null },
    }));
  });

  it('ignores a non-string log path rather than trusting it', () => {
    const harness = createHarness();
    const publication = subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
      providerSessionMetadataKey: 'claudeSessionId',
    });

    publication.observeRuntimeEvent({
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
    const publication = subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
      providerSessionMetadataKey: null,
    });

    publication.observeRuntimeEvent({
      kind: 'provider-session-id',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      // The external Agent minted these bytes; they are published verbatim.
      providerSessionId: ' acme-native-1 ',
    });

    expect(harness.sessionState.writeHappierField).toHaveBeenCalledWith({
      sessionId: 'session-1',
      fieldId: 'identity.providerSessionId',
      value: {
        metadataKey: null,
        value: ' acme-native-1 ',
        nativeSessionLogPath: null,
      },
      reason: 'reconciliation',
      metadataReason: 'runtime-provider-session-id',
      mirrorToProvider: false,
    });
  });

  it('still refuses to publish an empty native id', () => {
    const harness = createHarness();
    const publication = subscribeSessionRuntimePublicationToMetadata({
      session: harness.session,
      sessionState: harness.sessionState,
      runtime: harness.runtime as never,
      providerSessionMetadataKey: null,
    });

    publication.observeRuntimeEvent({
      kind: 'provider-session-id',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      providerSessionId: '   ',
    });

    expect(harness.sessionState.writeHappierField).not.toHaveBeenCalled();
  });
});
