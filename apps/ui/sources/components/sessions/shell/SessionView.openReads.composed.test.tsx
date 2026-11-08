import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { SessionDestinationBody } from './SessionDestinationBody';
import { storage } from '@/sync/domains/state/storageStore';
import { sync } from '@/sync/sync';
import { hasCurrentSessionTurnsProjection } from '@/sync/domains/session/hasAuthoritativeSessionRouteData';
import { buildSessionTurnsProjectionV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { SESSION_CONSUMPTION_REPLACE_EVENT, SessionConsumptionReplaceV1Schema } from '@happier-dev/protocol/sessions';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/control/contract';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// Only platform/transport boundaries are replaced; route hydration, navigation
// backfill, the composer, transcript and live-consumption admission stay real.
vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        Platform: { OS: 'web' }, useWindowDimensions: () => ({ width: 1400, height: 900 }),
    }));
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/session/ordinary-open' }).module);
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock({ renderInitialNavigatorScreen: true }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1400, height: 900 }),
}));

const reads: string[] = [];
const runtime = installSessionPaneRuntimeTestHarness({
    rpc: async () => null,
    configureSocket: socket => {
        const originalAck = vi.mocked(socket.emitWithAck).getMockImplementation();
        if (!originalAck) throw new Error('Expected the canonical Socket boundary');
        vi.mocked(socket.emitWithAck).mockImplementation(async (event, payload: unknown) => {
            if (event === SESSION_CONSUMPTION_REPLACE_EVENT) {
                const request = SessionConsumptionReplaceV1Schema.parse(payload);
                return { v: 1, ok: true, liveSessionIds: request.liveSessionIds, durableSessionIds: request.durableSessionIds };
            }
            return originalAck.call(socket, event, payload);
        });
    },
    request: async (input, init) => {
        const url = new URL(String(input));
        if (/^\/v1\/sessions\/[^/]+\/messages$/.test(url.pathname) && (init?.method ?? 'GET') === 'GET') {
            reads.push(url.pathname + url.search);
            return Response.json({ messages: url.searchParams.has('afterSeq') ? [] : [1, 2, 3].map(seq => ({
                id: `message-${seq}`, seq, localId: null, sidechainId: null,
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `Turn ${seq}` } } },
                createdAt: seq, updatedAt: seq,
            })), hasMore: false, nextBeforeSeq: null, nextAfterSeq: null });
        }
        if (/^\/v1\/sessions\/[^/]+\/turns$/.test(url.pathname)) {
            const sessionId = url.pathname.split('/')[3]!;
            // Reproduce the live ordering: the retained Session can open before
            // its bounded turn projection finishes. Finishing hydration must
            // consume that transcript rather than request another tail page.
            await waitForHomeGovernance(() => expect(storage.getState().sessionMessages[sessionId]?.isLoaded).toBe(true));
            return Response.json(buildSessionTurnsProjectionV1({ sessionId, updatedAt: 1, turns: [] }));
        }
        return null;
    },
});

it('reads one page per ordinary or Voice Session open and preserves a warm reopen probe', async () => {
    reads.length = 0;
    installShippedNativeFrameScheduler();
    for (const [id, expectedReads] of [['ordinary-open', 1], ['voice-open', 1], ['ordinary-open', 2]] as const) {
        // The live report's shell hint was ahead of its main transcript frontier.
        // An admission-triggered re-open must not manufacture another tail read.
        const session = createSessionFixture({ id, serverId: runtime.serverId, seq: 4, encryptionMode: 'plain' });
        if (id === 'voice-open') session.metadata = { ...session.metadata, ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }) };
        storage.getState().applySessions([session]);
        await expect(sync.ensureSessionVisibleForMessageRoute(id, {
            serverId: runtime.serverId, hydrateMessages: false,
        })).resolves.toMatchObject({ kind: 'available' });
        const screen = await renderScreen(<DestinationInstanceHost tabId={id}
            ref={{ kind: 'session', params: { id, serverId: runtime.serverId } }}
            pathname={`/session/${id}`} focused visible
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <SessionDestinationBody />
        </DestinationInstanceHost>, { wrapper: runtime.Wrapper });
        try {
            await act(async () => {
                await waitForHomeGovernance(() => expect(storage.getState().sessionMessages[id]?.isLoaded).toBe(true));
                await waitForHomeGovernance(() => expect(hasCurrentSessionTurnsProjection(storage.getState().sessions[id] ?? {})).toBe(true));
            });
            await flushHookEffects({ cycles: 3, turns: 3 });
            expect(reads.filter(path => path.startsWith(`/v1/sessions/${id}/messages`))).toHaveLength(expectedReads);
        } finally { await screen.unmount(); }
    }
    expect(reads).toHaveLength(3);
});
