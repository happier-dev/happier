import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';
import { SessionCapabilitiesSchema } from '@happier-dev/protocol/features/payload/capabilities/sessionCapabilities';
import { composeSessionWorkerUpdateHeadlineV1 } from '@happier-dev/protocol/sessions/relations/workerUpdateV1';

import {
  createSessionFixture,
  createSessionListRenderableSessionFixture,
} from '@/dev/testkit/fixtures/sessionFixtures';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
  getAppliedActiveServerSnapshot,
  isAppliedActiveServerRuntimeAvailable,
  publishAppliedActiveServerSnapshot,
} from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { readStoredSessionMessagesForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';

import { resolveSessionRecap } from './sessionRecap';
import {
  getPreferredLanguage,
  preloadTranslations,
  setPreferredLanguageFromSettings,
  t,
} from '@/text';

/** The delivering worker Session: the Recap names it so the Work digest can open it. */
const WORKER_SESSION_ID = 'cworker0000000000000000000';

// Authenticated HTTP/device boundaries only: runtime admission, repository and codecs stay real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { readSessionRecapForAddress } = await import('@/sync/ops/sessionRecap');
const { storage } = await import('@/sync/domains/state/storageStore');
const { useSessionRecap, useSessionRecapState } = await import('./useSessionRecap');
const { projectSessionSummaryCard } =
  await import('./sessionSummaryProjection');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } =
  await import('@/sync/runtime/orchestration/connectionManager');
beforeEach(async () => {
  await homes.reset();
  await loadSyncSingletonForTests();
});
afterEach(async () => {
  await standardCleanup();
  await homes.reset();
});

describe('useSessionRecap delivered transcript fallback', () => {
  const address = { serverId: 'home-a', sessionId: 'lead' };
  function delivered(
    id: string,
    seq: number,
    createdAt: number,
    headline: string,
  ): Message {
    return {
      kind: 'agent-event',
      id,
      localId: null,
      seq,
      createdAt,
      event: {
        type: 'worker-update',
        update: {
          v: 1,
          workerKind: 'session',
          workerId: WORKER_SESSION_ID,
          ownerState: 'settled',
          wake: 'finished',
          headline,
          canInspect: true,
        },
      },
    };
  }
  function transcript(messages: Message[]) {
    return createSessionMessagesFixture({
      isLoaded: true,
      messageIdsOldestFirst: messages.map((message) => message.id),
      messagesById: Object.fromEntries(
        messages.map((message) => [message.id, message]),
      ),
    });
  }

  it('does no retained-history reconstruction or consumer render on unrelated arrivals, while updates and replacements stay current', async () => {
    const previous = storage.getState();
    let reconstructions = 0;
    let renders = 0;
    const rows: Message[] = Array.from({ length: 1_000 }, (_, index) => ({
      kind: 'agent-text', id: `ordinary-${index}`, localId: null, seq: index + 1,
      createdAt: index + 1, text: 'Ordinary retained text',
    }));
    const notice = delivered('latest', 1_001, 2_000, 'Initial report');
    const initial = transcript([...rows, notice]);
    // Observe the actual retained-history read boundary without replacing internal logic.
    const observedIds = new Proxy(initial.messageIdsOldestFirst, {
      get(target, property, receiver) {
        if (property === 'map') reconstructions += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    try {
      storage.setState({
        sessions: { lead: createSessionFixture({ id: 'lead', serverId: 'home-a' }) },
        sessionMessages: { lead: { ...initial, messageIdsOldestFirst: observedIds } },
      });
      const hook = await renderHook(() => {
        renders += 1;
        return useSessionRecap(address);
      });
      expect(hook.getCurrent()?.text).toContain('Initial report');
      renders = 0;
      reconstructions = 0;
      for (let index = 0; index < 5; index++) {
        await act(async () => {
          const current = storage.getState().sessionMessages.lead!;
          const ordinary: Message = { kind: 'agent-text', id: `arrival-${index}`, localId: null,
            seq: 1_002 + index, createdAt: 3_000 + index, text: 'Streaming text' };
          storage.setState({ sessionMessages: { lead: { ...current,
            messageIdsOldestFirst: new Proxy([...current.messageIdsOldestFirst, ordinary.id], {
              get(target, property, receiver) {
                if (property === 'map') reconstructions += 1;
                return Reflect.get(target, property, receiver);
              },
            }),
            messagesById: { ...current.messagesById, [ordinary.id]: ordinary },
            messagesVersion: current.messagesVersion + 1,
          } } });
        });
      }
      expect(reconstructions).toBe(0);
      expect(renders).toBe(0);
      // A result-body replacement keeps the compact per-worker facts equal.
      await act(async () => {
        const current = storage.getState().sessionMessages.lead!;
        if (notice.kind !== 'agent-event' || notice.event.type !== 'worker-update') throw new Error('Expected WorkerUpdate');
        const changed: Message = { ...notice, event: { ...notice.event,
          update: { ...notice.event.update, result: 'Revised delivered result' } } };
        storage.setState({ sessionMessages: { lead: { ...current,
          messagesById: { ...current.messagesById, latest: changed },
        } } });
      });
      expect(hook.getCurrent()).toMatchObject({ source: 'worker_update', body: 'Revised delivered result' });
      await act(async () => storage.setState({ sessionMessages: {
        lead: transcript([delivered('new', 2_000, 4_000, 'Next report')]),
      } }));
      expect(hook.getCurrent()?.text).toContain('Next report');
      // Replacement, removal and an older transcript must not retain the prior pointer/body.
      await act(async () => storage.setState({ sessionMessages: {
        lead: transcript([delivered('replacement', 2, 10, 'Replacement history')]),
      } }));
      expect(hook.getCurrent()?.text).toContain('Replacement history');
      await act(async () => storage.setState({ sessionMessages: { lead: transcript([]) } }));
      expect(hook.getCurrent()).toBeNull();
      await hook.unmount();
    } finally {
      storage.setState(previous);
    }
  });

  it('renews synopsis observation on same-Account restore, respects memory off, and retains transcript custody', async () => {
    const previous = storage.getState();
    const applied = getAppliedActiveServerSnapshot();
    const available = isAppliedActiveServerRuntimeAvailable();
    let synopsis = 'Retained synopsis';
    let revision = 'ssr1.AAAACHN5c3JlY18xAAAAAQ';
    try {
      const home = await homes.addHome({
        name: 'Recap Home',
        serverUrl: 'https://recap.test',
        accountId: 'account-a',
      });
      const address: SessionAddress = { serverId: home, sessionId: 'lead' };
      const features = createRootLayoutFeaturesResponse({
        capabilities: {
          session: SessionCapabilitiesSchema.parse({
            systemRecords: { protocolVersions: [1] },
          }),
        },
      });
      homes.answer(home, '/v1/features', { body: features });
      homes.answer(home, '/v1/features/authenticated', { body: features });
      const credentials = await TokenStorage.getCredentialsForServerUrl(
        'https://recap.test',
        { serverId: home },
      );
      if (!credentials) throw new Error('Recap Home credentials unavailable');
      // Importing the singleton does not initialize it. Real sign-in/restore must
      // precede transcript hydration so switching runs the shared custody reset.
      await restoreConnectionToActiveServer(credentials);
      expect(storage.getState().profileScope).toEqual({
        serverId: home,
        accountId: 'account-a',
      });
      const synopsisPath =
        '/v2/sessions/lead/system-records?owner=host&namespace=memory&kind=synopsis.v1';
      homes.answer(home, synopsisPath, {
        select: () => ({
          body: {
            records: [
              {
                id: 'synopsis-one',
                address: {
                  owner: 'host',
                  namespace: 'memory',
                  kind: 'synopsis.v1',
                  localId: 'latest',
                },
                content: {
                  t: 'plain',
                  v: { v: 1, synopsis, seqTo: 5, updatedAtMs: 10 },
                },
                revision,
                createdAt: '2026-09-05T00:00:00.000Z',
                updatedAt: '2026-09-05T00:00:00.000Z',
              },
            ],
            nextCursor: null,
            hasNext: false,
          },
        }),
      });
      storage.setState({
        sessions: {
          lead: createSessionFixture(
            { id: 'lead', serverId: home },
            { memoryEnabled: true },
          ),
        },
        sessionListRowsByServerId: {
          [home]: {
            lead: createSessionListRenderableSessionFixture({ id: 'lead' }),
          },
        },
        sessionMessages: {
          lead: transcript([delivered('latest', 1, 20, 'New worker report')]),
        },
      });
      const hook = await renderHook(({ enabled }) => useSessionRecapState(address, enabled).recap, {
        initialProps: { enabled: true },
      });
      await act(async () => {
        await vi.waitFor(() =>
          expect(hook.getCurrent()?.text).toBe('Retained synopsis'),
        );
      });
      synopsis = 'Restored synopsis';
      revision = 'ssr1.AAAACHN5c3JlY18xAAAAAg';
      await act(async () => {
        retireActiveServerAccountScopeLifetime();
      });
      await act(async () => {
        await vi.waitFor(() =>
          expect(hook.getCurrent()?.text).toBe('Restored synopsis'),
        );
      });
      synopsis = 'Observer update';
      revision = 'ssr1.AAAACHN5c3JlY18xAAAAAw';
      await act(async () => {
        await getSyncSingleton().withSessionSystemRecordRuntime(
          address,
          (runtime) =>
            runtime.repository.refresh(address, {
              type: 'list',
              namespace: 'memory',
              kind: 'synopsis.v1',
            }),
        );
      });
      await act(async () => {
        await vi.waitFor(() =>
          expect(hook.getCurrent()?.text).toBe('Observer update'),
        );
      });
      let fallbackBodyReads = 0;
      await act(async () => {
        const retained = storage.getState().sessionMessages.lead!;
        storage.setState({ sessionMessages: { lead: { ...retained,
          messagesById: new Proxy(retained.messagesById, {
            get(target, property, receiver) {
              fallbackBodyReads += 1;
              return Reflect.get(target, property, receiver);
            },
          }),
        } } });
      });
      expect(hook.getCurrent()?.text).toBe('Observer update');
      expect(fallbackBodyReads).toBe(0);
      await expect(readSessionRecapForAddress(address)).resolves.toEqual({ status: 'ready', recap: hook.getCurrent() });
      expect(fallbackBodyReads).toBe(0);
      await hook.rerender({ enabled: false });
      synopsis = 'Changed while hidden';
      revision = 'ssr1.AAAACHN5c3JlY18xAAAABA';
      await act(async () => {
        await getSyncSingleton().withSessionSystemRecordRuntime(address, runtime => runtime.repository.refresh(address, {
          type: 'list', namespace: 'memory', kind: 'synopsis.v1',
        }));
      });
      expect(hook.getCurrent()?.text).toBe('Observer update');
      await hook.rerender({ enabled: true });
      await act(async () => {
        await vi.waitFor(() => expect(hook.getCurrent()?.text).toBe('Changed while hidden'));
      });
      // Layout-1 shared metadata is not the owner's Context policy.
      await act(async () =>
        storage.setState({
          sessions: {
            lead: createSessionFixture(
              {
                ...storage.getState().sessions.lead!,
                metadataLayoutVersion: 1,
                metadata: createSessionFixture().metadata,
                ownerMetadataView: createSessionFixture().metadata,
              },
              { memoryEnabled: true },
            ),
          },
        }),
      );
      expect(hook.getCurrent()?.text).toBe('Changed while hidden');
      await act(async () =>
        storage.setState({
          sessions: {
            lead: createSessionFixture(storage.getState().sessions.lead!, {
              memoryEnabled: false,
            }),
          },
        }),
      );
      expect(hook.getCurrent()).toEqual({
        source: 'worker_update',
        text: `${t('sessionWork.workerUpdate.state.settled')} · New worker report`,
        atMs: 20,
        workerSessionId: WORKER_SESSION_ID,
      });
      await expect(readSessionRecapForAddress(address)).resolves.toEqual({ status: 'ready', recap: hook.getCurrent() });
      // Switching Accounts must not relabel the retained transcript as the new Account's content.
      homes.answer(home, synopsisPath, {
        body: { records: [], nextCursor: null, hasNext: false },
      });
      await act(async () => {
        await homes.switchAccount(home, 'account-b');
      });
      expect(storage.getState().profileScope).toEqual({
        serverId: home,
        accountId: 'account-b',
      });
      expect(storage.getState().sessions.lead).toBeUndefined();
      expect(storage.getState().sessionMessages.lead).toBeUndefined();
      expect(
        readStoredSessionMessagesForAddress(storage.getState(), address),
      ).toEqual([]);
      expect(hook.getCurrent()).toBeNull();
      await hook.unmount();
      // A newly mounted reader must also start empty under the new Account,
      // then read only its freshly hydrated same-id Session and transcript.
      const remounted = await renderHook(() => useSessionRecap(address));
      expect(remounted.getCurrent()).toBeNull();
      await act(async () =>
        storage.setState({
          sessions: {
            lead: createSessionFixture(
              { id: 'lead', serverId: home },
              { memoryEnabled: false },
            ),
          },
          sessionMessages: {
            lead: transcript([delivered('b', 1, 30, 'Account B report')]),
          },
        }),
      );
      expect(remounted.getCurrent()?.text).toBe(
        `${t('sessionWork.workerUpdate.state.settled')} · Account B report`,
      );
      await remounted.unmount();
    } finally {
      await disconnectActiveServerConnection();
      await standardCleanup();
      act(() => {
        storage.setState(previous);
        publishAppliedActiveServerSnapshot(applied, available);
      });
    }
  });

  it('reads the latest delivered headline in transcript order, survives remount, and ignores sibling/ordinary messages', async () => {
    const previous = storage.getState();
    try {
      const rows = [
        delivered('older', 1, 900, 'Older report'),
        delivered('latest', 2, 500, 'Runbook published'),
        {
          kind: 'agent-text',
          id: 'heartbeat',
          localId: null,
          createdAt: 1000,
          seq: 3,
          text: 'Still working',
        } satisfies Message,
      ];
      storage.setState({
        sessions: {
          lead: createSessionFixture({ id: 'lead', serverId: 'home-a' }),
          child: createSessionFixture({ id: 'child', serverId: 'home-a' }),
        },
        sessionMessages: {
          lead: transcript(rows),
          child: transcript([delivered('child', 8, 2000, 'Child secret')]),
        },
      });
      const hook = await renderHook(() => useSessionRecap(address));
      expect(hook.getCurrent()).toEqual({
        source: 'worker_update',
        text: `${t('sessionWork.workerUpdate.state.settled')} · Runbook published`,
        atMs: 500,
        workerSessionId: WORKER_SESSION_ID,
      });
      await hook.unmount();
      const reloaded = await renderHook(() => useSessionRecap(address));
      expect(reloaded.getCurrent()).toEqual({
        source: 'worker_update',
        text: `${t('sessionWork.workerUpdate.state.settled')} · Runbook published`,
        atMs: 500,
        workerSessionId: WORKER_SESSION_ID,
      });

      await act(async () => {
        storage.setState({
          sessionMessages: {
            ...storage.getState().sessionMessages,
            lead: transcript([
              ...rows,
              delivered('new', 4, 1100, 'Next report'),
            ]),
          },
        });
      });
      expect(reloaded.getCurrent()).toEqual({
        source: 'worker_update',
        text: `${t('sessionWork.workerUpdate.state.settled')} · Next report`,
        atMs: 1100,
        workerSessionId: WORKER_SESSION_ID,
      });
      await reloaded.unmount();
    } finally {
      storage.setState(previous);
    }
  });

  it.each([
    { ownerState: 'settled', summary: null, stateKey: 'settled' },
    { ownerState: 'failed', summary: null, stateKey: 'failed' },
    { ownerState: 'failed', summary: '2 findings', stateKey: 'failed' },
  ] as const)(
    'presents native $ownerState reports and authored $summary through the localized Recap',
    async ({ ownerState, summary, stateKey }) => {
      const previous = storage.getState();
      const previousLanguage = getPreferredLanguage();
      try {
        await preloadTranslations('fr');
        setPreferredLanguageFromSettings('fr');
        const outcome = { ownerState, wake: 'finished' } as const;
        const headline =
          summary ?? composeSessionWorkerUpdateHeadlineV1(outcome);
        const message = delivered('native', 1, 10, headline);
        if (
          message.kind !== 'agent-event' ||
          message.event.type !== 'worker-update' ||
          message.event.update.workerKind !== 'session'
        )
          throw new Error('Expected a native Session WorkerUpdate');
        message.event.update = { ...message.event.update, ...outcome };
        storage.setState({
          sessions: {
            lead: createSessionFixture(
              { id: 'lead', serverId: 'home-a' },
              { memoryEnabled: false },
            ),
          },
          sessionMessages: { lead: transcript([message]) },
        });
        const hook = await renderHook(() => useSessionRecap(address));
        const localized = t(`sessionWork.workerUpdate.state.${stateKey}`);
        expect(localized).not.toBe(
          composeSessionWorkerUpdateHeadlineV1(outcome),
        );
        expect(hook.getCurrent()).toEqual({
          source: 'worker_update',
          text: summary ? `${localized} · ${summary}` : localized,
          atMs: 10,
          workerSessionId: WORKER_SESSION_ID,
        });
        await hook.unmount();
      } finally {
        setPreferredLanguageFromSettings(previousLanguage);
        storage.setState(previous);
      }
    },
  );

  it('does not disclose another Home or locked/unreadable retained content', async () => {
    const previous = storage.getState();
    try {
      storage.setState({
        sessions: {
          lead: createSessionFixture({ id: 'lead', serverId: 'home-a' }),
        },
        sessionMessages: {
          lead: transcript([delivered('private', 1, 1, 'Private report')]),
        },
      });
      const hook = await renderHook<
        ReturnType<typeof useSessionRecap>,
        SessionAddress | null
      >((target) => useSessionRecap(target), {
        initialProps: { serverId: 'home-b', sessionId: 'lead' },
      });
      expect(hook.getCurrent()).toBeNull();
      await hook.rerender(address);
      expect(hook.getCurrent()?.text).toBe(
        `${t('sessionWork.workerUpdate.state.settled')} · Private report`,
      );
      await act(async () => {
        storage.setState({
          sessions: {
            lead: createSessionFixture({
              id: 'lead',
              serverId: 'home-a',
              encryptionMode: 'e2ee',
              encryptedContentAvailability: 'encrypted_content_unavailable',
            }),
          },
        });
      });
      expect(hook.getCurrent()).toBeNull();
      await hook.rerender(null);
      expect(hook.getCurrent()).toBeNull();
      await hook.unmount();
    } finally {
      storage.setState(previous);
    }
  });
});

describe('resolveSessionRecap', () => {
  it('reads the latest synopsis when memory has produced one', () => {
    expect(
      resolveSessionRecap({
        memoryEnabled: true,
        synopses: [
          { synopsis: 'Older view of the work', seqTo: 10, updatedAtMs: 100 },
          {
            synopsis:
              'Two workers merged; the ledger backfill is still running.',
            seqTo: 42,
            updatedAtMs: 400,
          },
          { synopsis: 'Out of order but older', seqTo: 30, updatedAtMs: 900 },
        ],
        latestWorkerUpdate: {
          headline: 'Checkout UI finished its turn',
          atMs: 500,
        },
      }),
    ).toEqual({
      source: 'synopsis',
      text: 'Two workers merged; the ledger backfill is still running.',
      atMs: 400,
    });
  });

  it('falls back to the latest worker update headline when memory is off despite a retained synopsis', () => {
    expect(
      resolveSessionRecap({
        memoryEnabled: false,
        synopses: [
          {
            synopsis: 'Previously generated synopsis',
            seqTo: 10,
            updatedAtMs: 100,
          },
        ],
        latestWorkerUpdate: {
          headline: 'Runbook drafted and published as #2490',
          atMs: 500,
        },
      }),
    ).toEqual({
      source: 'worker_update',
      text: 'Runbook drafted and published as #2490',
      atMs: 500,
    });
  });

  it('carries what the worker delivered as the worker-update Recap body, beside its one-line headline', () => {
    expect(
      resolveSessionRecap({
        memoryEnabled: false,
        synopses: [],
        latestWorkerUpdate: {
          headline: 'finished its turn',
          body: '  Runbook published; two links still need owners.  ',
          atMs: 500,
          workerSessionId: WORKER_SESSION_ID,
        },
      }),
    ).toEqual({
      source: 'worker_update',
      text: 'finished its turn',
      body: 'Runbook published; two links still need owners.',
      atMs: 500,
      workerSessionId: WORKER_SESSION_ID,
    });
    expect(
      resolveSessionRecap({
        memoryEnabled: false,
        synopses: [],
        latestWorkerUpdate: {
          headline: 'finished its turn',
          body: '   ',
          atMs: 500,
        },
      }),
    ).toEqual({
      source: 'worker_update',
      text: 'finished its turn',
      atMs: 500,
    });
  });

  it('offers no recap when there is nothing to read, rather than inventing one', () => {
    expect(
      resolveSessionRecap({
        memoryEnabled: true,
        synopses: [{ synopsis: '   ', seqTo: 1, updatedAtMs: 1 }],
        latestWorkerUpdate: null,
      }),
    ).toBeNull();
  });
});

describe('Summary card Recap and Work rows', () => {
  const awareness = {
    v: 1,
    sessionId: 'lead',
    lifecycle: 'active',
    runtime: 'idle',
    freshness: 'live',
    operational: { primary: 'ready', reasons: ['ready'] },
    currentWork: { title: 'Payments rollout', activeWorkflowRunCount: 1 },
    encryption: { mode: 'plain', readable: true },
    availability: 'complete',
  } as unknown as Parameters<typeof projectSessionSummaryCard>[0]['awareness'];

  it('adds a Recap row and routes the work rows to the Work tab', () => {
    const model = projectSessionSummaryCard({
      awareness,
      agentLabel: null,
      activity: { live: 2, total: 3, headline: null },
      openApprovalCount: 0,
      scm: null,
      usage: null,
      recap: { source: 'worker_update', text: 'Runbook published', atMs: 1 },
    });

    expect(model.rows.find((row) => row.kind === 'recap')).toMatchObject({
      kind: 'recap',
      text: 'Runbook published',
      source: 'worker_update',
      destination: 'workTab',
    });
    expect(model.rows.find((row) => row.kind === 'activity')?.destination).toBe(
      'workTab',
    );
    expect(model.rows.find((row) => row.kind === 'workflow')?.destination).toBe(
      'workTab',
    );
  });

  it('has no Recap row without a recap', () => {
    const model = projectSessionSummaryCard({
      awareness,
      agentLabel: null,
      activity: null,
      openApprovalCount: 0,
      scm: null,
      usage: null,
      recap: null,
    });
    expect(model.rows.some((row) => row.kind === 'recap')).toBe(false);
  });
});
