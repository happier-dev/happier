import { describe, expect, it, vi } from 'vitest';

import type { Message } from '@/sync/domains/messages/messageTypes';

import {
  createVoiceHistoryConsumer,
  projectVoiceHistoryRows,
  type VoiceHistoryConsumerDeps,
  type VoiceHistoryProviderSource,
} from './voiceHistoryConsumer';

const OPENAI_SOURCE = Object.freeze({
  pluginId: 'happier.voice.openai',
  contributionId: 'realtime-openai',
});
const XAI_SOURCE = Object.freeze({
  pluginId: 'happier.voice.xai',
  contributionId: 'realtime-grok',
});
const ELEVENLABS_SOURCE = Object.freeze({
  pluginId: 'happier.voice.elevenlabs',
  contributionId: 'realtime-elevenlabs',
});
const HISTORICAL_ELEVENLABS_SOURCE = Object.freeze({
  pluginId: 'happier.voice.elevenlabs',
  contributionId: 'realtime_elevenlabs',
});

function voiceMessage(input: Readonly<{
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  source?: VoiceHistoryProviderSource;
}>): Message {
  const common = {
    id: input.id,
    localId: null,
    createdAt: input.createdAt,
    text: input.text,
    meta: {
      happier: {
        kind: 'conversation_turn.v1' as const,
        payload: { v: 1 },
        conversationTurnOriginV1: {
          v: 1 as const,
          channel: 'realtime_conversation' as const,
          modality: 'voice' as const,
          ...(input.source ? { source: input.source } : {}),
        },
      },
    },
  };
  return input.role === 'user'
    ? { ...common, kind: 'user-text' }
    : { ...common, kind: 'agent-text' };
}

function agentMessage(id: string, text: string, createdAt: number): Message {
  return {
    kind: 'agent-text',
    id,
    localId: null,
    createdAt,
    text,
  };
}

function createDeps(overrides: Partial<VoiceHistoryConsumerDeps> = {}): VoiceHistoryConsumerDeps {
  return {
    readScopeKey: () => 'server-a/account-a',
    captureScope: vi.fn(async () => ({ key: 'server-a/account-a' })),
    discoverHistorySession: vi.fn(async () => 'voice-history-session'),
    refreshSessionMessages: vi.fn(async () => undefined),
    loadOlderMessages: vi.fn(async () => ({
      loaded: 0,
      hasMore: false,
      status: 'no_more' as const,
    })),
    readMessages: vi.fn(() => []),
    readMessagesRevision: () => 0,
    subscribeHistorySources: () => () => {},
    resolveProviderLabel: (source) => source?.pluginId === OPENAI_SOURCE.pluginId
      ? 'OpenAI Realtime'
      : source?.pluginId === XAI_SOURCE.pluginId
        ? 'Grok Realtime'
        : 'Voice provider',
    deleteSession: vi.fn(async () => ({ success: true })),
    canDeleteSession: () => true,
    retireLocalSession: vi.fn(),
    runCarrierOperation: async (operation) => await operation(),
    now: () => new Date('2026-07-29T12:34:56.000Z'),
    ...overrides,
  };
}

describe('projectVoiceHistoryRows', () => {
  it('projects only exact Voice provenance in canonical chronology and searches loaded decrypted rows locally', () => {
    const messages = [
      voiceMessage({
        id: 'assistant-2',
        role: 'assistant',
        text: 'A later answer',
        createdAt: 300,
        source: XAI_SOURCE,
      }),
      agentMessage('coding-row', 'must stay in the coding transcript', 50),
      {
        ...agentMessage('malformed-origin', 'must fail closed', 75),
        // Deliberately malformed persisted boundary fixture: channel/modality literals disagree.
        meta: {
          happier: {
            kind: 'conversation_turn.v1',
            payload: { v: 1 },
            conversationTurnOriginV1: {
              v: 1,
              channel: 'realtime_conversation',
              modality: 'text',
            },
          },
        } as unknown as Message['meta'],
      },
      voiceMessage({
        id: 'user-1',
        role: 'user',
        text: 'First question',
        createdAt: 100,
        source: HISTORICAL_ELEVENLABS_SOURCE,
      }),
      voiceMessage({
        id: 'assistant-1',
        role: 'assistant',
        text: 'First answer',
        createdAt: 200,
        source: OPENAI_SOURCE,
      }),
    ];
    const resolveProviderLabel = (source: VoiceHistoryProviderSource | null) =>
      source?.pluginId === XAI_SOURCE.pluginId
        ? 'Grok Realtime'
        : source?.pluginId === ELEVENLABS_SOURCE.pluginId
          ? 'ElevenLabs Realtime'
          : 'OpenAI Realtime';

    expect(projectVoiceHistoryRows(messages, resolveProviderLabel)).toEqual([
      expect.objectContaining({
        id: 'user-1',
        role: 'user',
        providerLabel: 'ElevenLabs Realtime',
        source: ELEVENLABS_SOURCE,
      }),
      expect.objectContaining({
        id: 'assistant-1',
        role: 'assistant',
        providerLabel: 'OpenAI Realtime',
      }),
      expect.objectContaining({
        id: 'assistant-2',
        role: 'assistant',
        providerLabel: 'Grok Realtime',
      }),
    ]);
    expect(projectVoiceHistoryRows(messages, resolveProviderLabel, 'gRoK')).toEqual([
      expect.objectContaining({ id: 'assistant-2' }),
    ]);
    expect(projectVoiceHistoryRows(messages, resolveProviderLabel, 'first answer')).toEqual([
      expect.objectContaining({ id: 'assistant-1' }),
    ]);
  });
});

describe('createVoiceHistoryConsumer', () => {
  it('projects loaded messages once when applying a local search query', async () => {
    const resolveProviderLabel = vi.fn(() => 'OpenAI Realtime');
    const consumer = createVoiceHistoryConsumer(createDeps({
      readMessages: () => [
        voiceMessage({
          id: 'question',
          role: 'user',
          text: 'First question',
          createdAt: 100,
          source: OPENAI_SOURCE,
        }),
        voiceMessage({
          id: 'answer',
          role: 'assistant',
          text: 'Matching answer',
          createdAt: 200,
          source: OPENAI_SOURCE,
        }),
      ],
      resolveProviderLabel,
    }));

    await expect(consumer.open('matching')).resolves.toMatchObject({
      rows: [expect.objectContaining({ id: 'answer' })],
      loadedRowCount: 2,
    });
    expect(resolveProviderLabel).toHaveBeenCalledTimes(2);
  });

  it('reuses the chronological projection while only the local search query changes', async () => {
    const messages = [
      voiceMessage({
        id: 'question',
        role: 'user',
        text: 'First question',
        createdAt: 100,
        source: OPENAI_SOURCE,
      }),
      voiceMessage({
        id: 'answer',
        role: 'assistant',
        text: 'Matching answer',
        createdAt: 200,
        source: OPENAI_SOURCE,
      }),
    ];
    let projectionRevision = 1;
    const resolveProviderLabel = vi.fn(() => 'OpenAI Realtime');
    const consumer = createVoiceHistoryConsumer(createDeps({
      readMessages: () => messages,
      readProjectionRevision: () => projectionRevision,
      resolveProviderLabel,
    }));

    await consumer.open('question');
    expect(consumer.read('answer').rows).toEqual([
      expect.objectContaining({ id: 'answer' }),
    ]);
    expect(consumer.read('openai').rows).toHaveLength(2);

    expect(resolveProviderLabel).toHaveBeenCalledTimes(2);
    projectionRevision += 1;
    consumer.read();
    expect(resolveProviderLabel).toHaveBeenCalledTimes(4);
  });

  it('keeps the projection across reads when the message reader materializes a fresh array', async () => {
    // The canonical reader (`readStoredSessionMessages`) builds a new array on
    // every call, so a projection memo keyed on array identity never hits in
    // production even though a fixture returning one stable array says it does.
    const messages = [
      voiceMessage({
        id: 'question',
        role: 'user',
        text: 'First question',
        createdAt: 100,
        source: OPENAI_SOURCE,
      }),
      voiceMessage({
        id: 'answer',
        role: 'assistant',
        text: 'Matching answer',
        createdAt: 200,
        source: OPENAI_SOURCE,
      }),
    ];
    let messagesRevision = 7;
    const resolveProviderLabel = vi.fn(() => 'OpenAI Realtime');
    const consumer = createVoiceHistoryConsumer(createDeps({
      readMessages: () => [...messages],
      readMessagesRevision: () => messagesRevision,
      resolveProviderLabel,
    }));

    await consumer.open();
    expect(resolveProviderLabel).toHaveBeenCalledTimes(2);

    // Typing filters the already-projected rows; it never re-projects them.
    consumer.read('matching');
    consumer.read('question');
    consumer.read('');
    expect(resolveProviderLabel).toHaveBeenCalledTimes(2);

    // A real message write does re-project — exactly once for the new slice.
    messages.push(voiceMessage({
      id: 'follow-up',
      role: 'user',
      text: 'A follow-up',
      createdAt: 300,
      source: OPENAI_SOURCE,
    }));
    messagesRevision += 1;
    expect(consumer.read().rows).toHaveLength(3);
    expect(resolveProviderLabel).toHaveBeenCalledTimes(5);
  });

  it('publishes a History revision that moves on live writes and ignores unrelated ones', async () => {
    const listeners = new Set<() => void>();
    let messagesRevision = 1;
    let projectionRevision = 1;
    const messages = [
      voiceMessage({
        id: 'question',
        role: 'user',
        text: 'First question',
        createdAt: 100,
        source: OPENAI_SOURCE,
      }),
    ];
    const consumer = createVoiceHistoryConsumer(createDeps({
      readMessages: () => [...messages],
      readMessagesRevision: () => messagesRevision,
      readProjectionRevision: () => projectionRevision,
      subscribeHistorySources: (listener) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      loadOlderMessages: async () => ({ loaded: 0, hasMore: false, status: 'no_more' as const }),
    }));

    const notified = vi.fn();
    const unsubscribe = consumer.subscribe(notified);
    expect(listeners.size).toBe(1);

    const unbound = consumer.getRevision();
    await consumer.open();
    const bound = consumer.getRevision();
    // Binding a session is itself a change, and it is published without a read.
    expect(bound).not.toBe(unbound);
    expect(notified).toHaveBeenCalled();

    // An unrelated store write reaches the listener, but the revision is stable,
    // so the screen's external-store comparison ends it there.
    for (const listener of listeners) listener();
    expect(consumer.getRevision()).toBe(bound);

    // A voice turn landing in the bound session while History is open.
    messages.push(voiceMessage({
      id: 'answer',
      role: 'assistant',
      text: 'A live answer',
      createdAt: 200,
      source: OPENAI_SOURCE,
    }));
    messagesRevision += 1;
    const afterMessage = consumer.getRevision();
    expect(afterMessage).not.toBe(bound);
    expect(consumer.read().rows).toHaveLength(2);

    // A provider label resolving late changes the rendered rows too.
    projectionRevision += 1;
    const afterProjection = consumer.getRevision();
    expect(afterProjection).not.toBe(afterMessage);

    // Reaching the end of pagination retires the Load older control with no
    // message write behind it.
    await consumer.loadOlder();
    expect(consumer.getRevision()).not.toBe(afterProjection);
    expect(consumer.read().hasMore).toBe(false);

    unsubscribe();
    expect(listeners.size).toBe(0);
  });

  it('rejects a stale discovery instead of replacing a newer session binding', async () => {
    let resolveFirstDiscovery!: (sessionId: string | null) => void;
    const firstDiscovery = new Promise<string | null>((resolve) => {
      resolveFirstDiscovery = resolve;
    });
    const discoverHistorySession = vi.fn()
      .mockImplementationOnce(async () => await firstDiscovery)
      .mockResolvedValueOnce('voice-history-new');
    const consumer = createVoiceHistoryConsumer(createDeps({
      discoverHistorySession,
    }));

    const staleOpen = consumer.open();
    await expect(consumer.open()).resolves.toMatchObject({
      sessionId: 'voice-history-new',
    });
    resolveFirstDiscovery('voice-history-old');

    await expect(staleOpen).rejects.toMatchObject({
      name: 'VoiceHistoryOperationSupersededError',
    });
    expect(consumer.read()).toMatchObject({
      sessionId: 'voice-history-new',
    });
  });

  it('rejects stale paging and export work instead of consuming a newer binding', async () => {
    let carrierSessionId = 'voice-history-old';
    let resolveOlderPage!: (page: {
      loaded: number;
      hasMore: boolean;
      status: 'no_more';
    }) => void;
    const olderPage = new Promise<{
      loaded: number;
      hasMore: boolean;
      status: 'no_more';
    }>((resolve) => {
      resolveOlderPage = resolve;
    });
    const loadOlderMessages = vi.fn(async () => await olderPage);
    const consumer = createVoiceHistoryConsumer(createDeps({
      discoverHistorySession: vi.fn(async () => carrierSessionId),
      loadOlderMessages,
      readMessages: (sessionId) => [
        voiceMessage({
          id: sessionId,
          role: 'assistant',
          text: sessionId,
          createdAt: 1,
          source: OPENAI_SOURCE,
        }),
      ],
    }));

    await consumer.open();
    const staleExport = consumer.exportHistory({ range: 'all' });
    carrierSessionId = 'voice-history-new';
    await expect(consumer.open()).resolves.toMatchObject({
      sessionId: 'voice-history-new',
    });
    resolveOlderPage({ loaded: 0, hasMore: false, status: 'no_more' });

    await expect(staleExport).rejects.toMatchObject({
      name: 'VoiceHistoryOperationSupersededError',
    });
    expect(consumer.read()).toMatchObject({
      sessionId: 'voice-history-new',
      hasMore: null,
    });
  });

  it('discovers and refreshes the existing carrier, pages through canonical messages, and clears the whole session', async () => {
    const loaded: Message[] = [
      voiceMessage({
        id: 'new',
        role: 'assistant',
        text: 'newer',
        createdAt: 200,
        source: XAI_SOURCE,
      }),
    ];
    const deleteSession = vi.fn(async () => ({ success: true }));
    const retireLocalSession = vi.fn();
    const deps = createDeps({
      readMessages: () => loaded,
      loadOlderMessages: vi.fn(async () => {
        loaded.push(voiceMessage({
          id: 'old',
          role: 'user',
          text: 'older',
          createdAt: 100,
          source: OPENAI_SOURCE,
        }));
        return { loaded: 1, hasMore: false, status: 'no_more' as const };
      }),
      deleteSession,
      retireLocalSession,
    });
    const consumer = createVoiceHistoryConsumer(deps);

    await expect(consumer.open()).resolves.toMatchObject({
      sessionId: 'voice-history-session',
      rows: [expect.objectContaining({ id: 'new' })],
      hasMore: null,
    });
    await expect(consumer.loadOlder()).resolves.toMatchObject({
      rows: [
        expect.objectContaining({ id: 'old' }),
        expect.objectContaining({ id: 'new' }),
      ],
      hasMore: false,
    });
    await expect(consumer.clear()).resolves.toEqual({ cleared: true });
    expect(deleteSession).toHaveBeenCalledWith(
      'voice-history-session',
      { key: 'server-a/account-a' },
    );
    expect(retireLocalSession).toHaveBeenCalledWith('voice-history-session');
    expect(consumer.read()).toMatchObject({ sessionId: null, rows: [] });
  });

  it('fetches every requested page before building an all-history client export', async () => {
    const loaded: Message[] = [
      voiceMessage({
        id: 'newest',
        role: 'assistant',
        text: 'Newest answer',
        createdAt: 300,
        source: XAI_SOURCE,
      }),
    ];
    const pages = [
      voiceMessage({
        id: 'middle',
        role: 'assistant',
        text: 'Middle answer',
        createdAt: 200,
        source: OPENAI_SOURCE,
      }),
      voiceMessage({
        id: 'oldest',
        role: 'user',
        text: 'Oldest question',
        createdAt: 100,
        source: OPENAI_SOURCE,
      }),
    ];
    const loadOlderMessages = vi.fn(async () => {
      const next = pages.shift();
      if (next) loaded.push(next);
      return {
        loaded: next ? 1 : 0,
        hasMore: pages.length > 0,
        status: pages.length > 0 ? 'loaded' as const : 'no_more' as const,
      };
    });
    const resolveProviderLabel = vi.fn((source: VoiceHistoryProviderSource | null) =>
      source?.pluginId === XAI_SOURCE.pluginId ? 'Grok Realtime' : 'OpenAI Realtime');
    const consumer = createVoiceHistoryConsumer(createDeps({
      readMessages: () => loaded,
      loadOlderMessages,
      resolveProviderLabel,
    }));

    await consumer.open();
    resolveProviderLabel.mockClear();
    const artifact = await consumer.exportHistory({ range: 'all' });
    const payload = JSON.parse([...artifact.chunks()].join(''));

    expect(loadOlderMessages).toHaveBeenCalledTimes(2);
    // The growing slice is projected and re-sorted exactly ONCE, after the last
    // page, instead of once per page: three rows, three label resolutions.
    expect(resolveProviderLabel).toHaveBeenCalledTimes(3);
    expect(artifact).toMatchObject({
      mimeType: 'application/json',
      rowCount: 3,
      range: 'all',
    });
    expect(payload).toMatchObject({
      version: 1,
      exportedAt: '2026-07-29T12:34:56.000Z',
      entries: [
        expect.objectContaining({ id: 'oldest', provider: 'OpenAI Realtime' }),
        expect.objectContaining({ id: 'middle', provider: 'OpenAI Realtime' }),
        expect.objectContaining({ id: 'newest', provider: 'Grok Realtime' }),
      ],
    });
  });

  it('exports the complete history past every former page, row and byte ceiling', async () => {
    const loaded: Message[] = [];
    let pageIndex = 0;
    const TOTAL_PAGES = 80;
    const pagedConsumer = createVoiceHistoryConsumer(createDeps({
      readMessages: () => loaded,
      loadOlderMessages: vi.fn(async () => {
        pageIndex += 1;
        loaded.push(voiceMessage({
          id: `page-${pageIndex}`,
          role: 'assistant',
          text: `Page ${pageIndex}`,
          createdAt: TOTAL_PAGES - pageIndex,
          source: OPENAI_SOURCE,
        }));
        return {
          loaded: 1,
          hasMore: pageIndex < TOTAL_PAGES,
          status: pageIndex < TOTAL_PAGES ? 'loaded' as const : 'no_more' as const,
        };
      }),
    }));
    await pagedConsumer.open();

    const pagedArtifact = await pagedConsumer.exportHistory({ range: 'all' });
    const pagedPayload = JSON.parse([...pagedArtifact.chunks()].join(''));

    expect(pagedArtifact.rowCount).toBe(TOTAL_PAGES);
    expect(pagedPayload.entries).toHaveLength(TOTAL_PAGES);
    // Oldest first, unbroken: a partial or reordered artifact is not an export.
    expect(pagedPayload.entries.map((entry: { id: string }) => entry.id))
      .toEqual(Array.from({ length: TOTAL_PAGES }, (_, index) => `page-${TOTAL_PAGES - index}`));

    const rowConsumer = createVoiceHistoryConsumer(createDeps({
      readMessages: () => Array.from({ length: 5_001 }, (_, index) => voiceMessage({
        id: `row-${index}`,
        role: 'assistant',
        text: 'unbounded',
        createdAt: index,
        source: OPENAI_SOURCE,
      })),
    }));
    await rowConsumer.open();
    const rowArtifact = await rowConsumer.exportHistory({ range: 'loaded' });

    expect(rowArtifact.rowCount).toBe(5_001);
    expect(JSON.parse([...rowArtifact.chunks()].join('')).entries).toHaveLength(5_001);

    const byteConsumer = createVoiceHistoryConsumer(createDeps({
      readMessages: () => [
        voiceMessage({
          id: 'oversized',
          role: 'assistant',
          text: 'x'.repeat((8 * 1024 * 1024) + 1),
          createdAt: 1,
          source: OPENAI_SOURCE,
        }),
      ],
    }));
    await byteConsumer.open();
    const byteArtifact = await byteConsumer.exportHistory({ range: 'loaded' });
    const byteChunks = [...byteArtifact.chunks()];

    expect(byteChunks.reduce((total, chunk) => total + chunk.length, 0))
      .toBeGreaterThan(8 * 1024 * 1024);
    expect(JSON.parse(byteChunks.join('')).entries).toHaveLength(1);
  });

  it('does not create a carrier when history is absent and fails closed after account scope changes', async () => {
    let scope = 'server-a/account-a';
    const discoverHistorySession = vi.fn<() => Promise<string | null>>(async () => null);
    const refreshSessionMessages = vi.fn(async () => undefined);
    const consumer = createVoiceHistoryConsumer(createDeps({
      readScopeKey: () => scope,
      captureScope: async () => ({ key: scope }),
      discoverHistorySession,
      refreshSessionMessages,
    }));

    await expect(consumer.open()).resolves.toMatchObject({ sessionId: null, rows: [] });
    expect(refreshSessionMessages).not.toHaveBeenCalled();
    await expect(consumer.clear()).resolves.toEqual({ cleared: false });

    discoverHistorySession.mockResolvedValue('voice-history-session');
    await consumer.open();
    scope = 'server-b/account-b';
    expect(consumer.read()).toMatchObject({ sessionId: null, rows: [] });
    discoverHistorySession.mockResolvedValue(null);
    await expect(consumer.clear()).resolves.toEqual({ cleared: false });
  });

  it('forgets a cleared carrier so a later direct-media recreation is discovered under the same owner', async () => {
    let carrierSessionId: string | null = 'voice-history-old';
    const refreshSessionMessages = vi.fn(async () => undefined);
    const retireLocalSession = vi.fn();
    const consumer = createVoiceHistoryConsumer(createDeps({
      discoverHistorySession: vi.fn(async () => carrierSessionId),
      refreshSessionMessages,
      deleteSession: vi.fn(async (sessionId) => {
        expect(sessionId).toBe('voice-history-old');
        carrierSessionId = null;
        return { success: true };
      }),
      retireLocalSession,
    }));

    await expect(consumer.open()).resolves.toMatchObject({
      sessionId: 'voice-history-old',
    });
    await expect(consumer.clear()).resolves.toEqual({ cleared: true });
    expect(retireLocalSession).toHaveBeenCalledWith('voice-history-old');

    // The direct-media acquisition owner, not History, canonically recreates
    // the fixed tag. History must not retain or reuse the deleted session id.
    carrierSessionId = 'voice-history-recreated';
    await expect(consumer.open()).resolves.toMatchObject({
      sessionId: 'voice-history-recreated',
    });
    expect(refreshSessionMessages).toHaveBeenLastCalledWith(
      'voice-history-recreated',
      { key: 'server-a/account-a' },
    );
  });

  it('surfaces an attempted-and-failed older page instead of a silent no-op', async () => {
    const loaded: Message[] = [
      voiceMessage({
        id: 'newest',
        role: 'assistant',
        text: 'Newest answer',
        createdAt: 300,
        source: OPENAI_SOURCE,
      }),
    ];
    let attempt = 0;
    const consumer = createVoiceHistoryConsumer(createDeps({
      readMessages: () => loaded,
      loadOlderMessages: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) {
          return { loaded: 0, hasMore: true, status: 'retryable_error' as const };
        }
        loaded.push(voiceMessage({
          id: 'older',
          role: 'user',
          text: 'Older question',
          createdAt: 100,
          source: OPENAI_SOURCE,
        }));
        return { loaded: 1, hasMore: false, status: 'no_more' as const };
      }),
    }));
    await consumer.open();

    await expect(consumer.loadOlder()).rejects.toThrow(/older/iu);
    // The failed read retains rows and the older cursor, so the exact same
    // read is still available: the very next attempt must succeed.
    expect(consumer.read()).toMatchObject({
      sessionId: 'voice-history-session',
      hasMore: null,
    });
    expect(consumer.read().rows).toHaveLength(1);

    await expect(consumer.loadOlder()).resolves.toMatchObject({ hasMore: false });
    expect(consumer.read().rows).toHaveLength(2);
  });

  it('fails an all-history export on an attempted-and-failed page rather than truncating it', async () => {
    const loaded: Message[] = [
      voiceMessage({
        id: 'newest',
        role: 'assistant',
        text: 'Newest answer',
        createdAt: 300,
        source: OPENAI_SOURCE,
      }),
    ];
    const consumer = createVoiceHistoryConsumer(createDeps({
      readMessages: () => loaded,
      loadOlderMessages: vi.fn(async () => ({
        loaded: 0,
        hasMore: true,
        status: 'retryable_error' as const,
      })),
    }));
    await consumer.open();

    await expect(consumer.exportHistory({ range: 'all' })).rejects.toThrow(/older/iu);
  });

  it('refuses whole-session deletion while the carrier belongs to an active targetless attempt', async () => {
    const deleteSession = vi.fn(async () => ({ success: true }));
    const retireLocalSession = vi.fn();
    const consumer = createVoiceHistoryConsumer(createDeps({
      deleteSession,
      canDeleteSession: () => false,
      retireLocalSession,
    }));
    await consumer.open();

    await expect(consumer.clear()).rejects.toMatchObject({
      name: 'VoiceHistoryClearActiveCallError',
      code: 'voice_history_clear_active_call',
    });
    expect(deleteSession).not.toHaveBeenCalled();
    expect(retireLocalSession).not.toHaveBeenCalled();
    expect(consumer.read()).toMatchObject({
      sessionId: 'voice-history-session',
    });
  });

  it('retires the exact carrier and its decrypted rows when the server confirms it absent', async () => {
    const retireLocalSession = vi.fn();
    const consumer = createVoiceHistoryConsumer(createDeps({
      readMessages: () => [
        voiceMessage({
          id: 'stale-row',
          role: 'assistant',
          text: 'deleted from another device',
          createdAt: 100,
          source: OPENAI_SOURCE,
        }),
      ],
      // No socket deletion update ever arrives here: the HTTP answer alone has
      // to retire the binding, or a device that misses the socket echo keeps
      // showing decrypted rows for history the server no longer has.
      deleteSession: vi.fn(async () => ({
        success: false,
        code: 'session_absent' as const,
        message: 'Session not found or not owned by user',
      })),
      retireLocalSession,
    }));
    await consumer.open();
    expect(consumer.read().rows).toHaveLength(1);

    await expect(consumer.clear()).resolves.toEqual({ cleared: true });
    expect(retireLocalSession).toHaveBeenCalledWith('voice-history-session');
    expect(consumer.read()).toMatchObject({ sessionId: null, rows: [] });
  });

  it('keeps the carrier and stays retryable when the server lost the delete condition', async () => {
    const retireLocalSession = vi.fn();
    const deleteSession = vi.fn(async () => ({
      success: false,
      code: 'session_delete_conflict' as const,
      message: 'Session delete condition was lost',
    }));
    const consumer = createVoiceHistoryConsumer(createDeps({
      readMessages: () => [
        voiceMessage({
          id: 'live-row',
          role: 'assistant',
          text: 'still on the server',
          createdAt: 100,
          source: OPENAI_SOURCE,
        }),
      ],
      deleteSession,
      retireLocalSession,
    }));
    await consumer.open();

    await expect(consumer.clear()).rejects.toThrow(
      'Session delete condition was lost',
    );
    expect(retireLocalSession).not.toHaveBeenCalled();
    expect(consumer.read()).toMatchObject({ sessionId: 'voice-history-session' });
    expect(consumer.read().rows).toHaveLength(1);

    deleteSession.mockResolvedValueOnce({ success: true } as never);
    await expect(consumer.clear()).resolves.toEqual({ cleared: true });
    expect(retireLocalSession).toHaveBeenCalledWith('voice-history-session');
  });

  it('keeps an unclassified clear failure retryable without retiring local history', async () => {
    const retireLocalSession = vi.fn();
    const consumer = createVoiceHistoryConsumer(createDeps({
      deleteSession: vi.fn(async () => ({
        success: false,
        message: 'Failed to delete session',
      })),
      retireLocalSession,
    }));
    await consumer.open();

    await expect(consumer.clear()).rejects.toThrow('Failed to delete session');
    expect(retireLocalSession).not.toHaveBeenCalled();
    expect(consumer.read()).toMatchObject({
      sessionId: 'voice-history-session',
    });
  });

  it('drops its stale local binding even when post-delete local cache retirement reports a failure', async () => {
    const consumer = createVoiceHistoryConsumer(createDeps({
      retireLocalSession: () => {
        throw new Error('local cache retirement failed');
      },
    }));
    await consumer.open();

    await expect(consumer.clear()).rejects.toThrow('local cache retirement failed');
    expect(consumer.read()).toMatchObject({ sessionId: null, rows: [] });
  });

  it('rejects a stale clear completion without wiping a newer account binding', async () => {
    let scopeKey = 'server-a/account-a';
    let carrierSessionId = 'voice-history-a';
    let resolveDelete!: (result: { success: boolean }) => void;
    const deleteResult = new Promise<{ success: boolean }>((resolve) => {
      resolveDelete = resolve;
    });
    const retireLocalSession = vi.fn();
    const consumer = createVoiceHistoryConsumer(createDeps({
      readScopeKey: () => scopeKey,
      captureScope: async () => ({ key: scopeKey }),
      discoverHistorySession: vi.fn(async () => carrierSessionId),
      deleteSession: vi.fn(async () => await deleteResult),
      retireLocalSession,
    }));

    await expect(consumer.open()).resolves.toMatchObject({
      sessionId: 'voice-history-a',
    });
    const staleClear = consumer.clear();

    scopeKey = 'server-a/account-b';
    carrierSessionId = 'voice-history-b';
    await expect(consumer.open()).resolves.toMatchObject({
      sessionId: 'voice-history-b',
    });
    resolveDelete({ success: true });

    await expect(staleClear).rejects.toMatchObject({
      name: 'VoiceHistoryOperationSupersededError',
    });
    expect(retireLocalSession).not.toHaveBeenCalled();
    expect(consumer.read()).toMatchObject({
      sessionId: 'voice-history-b',
    });
  });

  it('retires an exactly rebound same-account session after its stale clear succeeds', async () => {
    let resolveDelete!: (result: { success: boolean }) => void;
    const deleteResult = new Promise<{ success: boolean }>((resolve) => {
      resolveDelete = resolve;
    });
    const retireLocalSession = vi.fn();
    const consumer = createVoiceHistoryConsumer(createDeps({
      discoverHistorySession: vi.fn(async () => 'voice-history-session'),
      deleteSession: vi.fn(async () => await deleteResult),
      retireLocalSession,
    }));

    await expect(consumer.open()).resolves.toMatchObject({
      sessionId: 'voice-history-session',
    });
    const staleClear = consumer.clear();

    // The delete has not settled yet, so a newer open can still rediscover
    // and bind the exact carrier that the server is about to remove.
    await expect(consumer.open()).resolves.toMatchObject({
      sessionId: 'voice-history-session',
    });
    resolveDelete({ success: true });

    await expect(staleClear).rejects.toMatchObject({
      name: 'VoiceHistoryOperationSupersededError',
    });
    expect(retireLocalSession).toHaveBeenCalledWith('voice-history-session');
    expect(consumer.read()).toMatchObject({
      sessionId: null,
      rows: [],
    });
  });
});
