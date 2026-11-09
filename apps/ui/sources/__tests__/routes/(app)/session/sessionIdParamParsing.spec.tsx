import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// The static storage graph reaches the Socket.IO transport; register its external boundary before any import.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import { createDeferred, createSessionFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { installSessionRouteCommonModuleMocks } from './[id]/sessionRouteTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type SearchParams = { id?: string; serverId?: string; jumpSeq?: string; right?: string; details?: string; path?: string };
let searchParams: SearchParams = {};
let deferredSession: ReturnType<typeof createDeferred<Response>> | null = null;
const sessionReads: string[] = [];

installSessionRouteCommonModuleMocks({
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        params: () => searchParams,
    }).module,
    nativeNavigation: async () => (await import('@/dev/testkit/mocks/reactNavigation'))
        .createReactNavigationNativeMock({ renderInitialNavigatorScreen: true }),
});
async function sessionResponse() {
    const { SessionCurrentProjectionRecordV1Schema} = await import('@happier-dev/protocol/sessions/listing/response');
    const session = createSessionFixture({ id: 'session-123', serverId: runtime.serverId });
    if (!session.access) throw new Error('Expected owner access fixture');
    return Response.json({ session: SessionCurrentProjectionRecordV1Schema.parse({
        ...session, metadataLayoutVersion: 0, metadata: JSON.stringify(session.metadata),
        effectiveAccess: { v: 1, level: session.access.level, sources: [{ kind: 'owner' }], capabilities: session.access.capabilities },
        responsibleAccountId: null, responsibleAccount: null, share: null, archivedAt: null,
        agentState: null, dataEncryptionKey: null, pendingCount: 0, pendingVersion: 0,
    }) });
}
const runtime = installSessionPaneRuntimeTestHarness({
    sessionId: 'session-123',
    scopeId: ({ sessionId, serverId }) => createSessionPaneScopeId(sessionId, serverId),
    request: async (url, init) => {
        const address = new URL(String(url));
        if ((init?.method ?? 'GET') !== 'GET' || address.pathname !== '/v2/sessions/session-123') return null;
        sessionReads.push(address.origin);
        return deferredSession ? await deferredSession.promise : await sessionResponse();
    },
});

beforeEach(() => {
    searchParams = { id: 'session-123', serverId: runtime.serverId };
    deferredSession = null;
    sessionReads.length = 0;
    storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'classic' });
});
function makeSessionCold() {
    storage.setState({ sessions: {}, sessionListRowsByServerId: {}, sessionListIndexByServerId: {} });
}
async function renderSessionScreenTree() {
    const Screen = (await import('@/app/(app)/session/[id]')).default;
    return renderScreen(<runtime.Wrapper><Screen /></runtime.Wrapper>);
}
async function renderSessionScreen() {
    const { SessionView } = await import('@/components/sessions/shell/SessionView');
    const screen = await renderSessionScreenTree();
    return { screen, sessionView: screen.findByType(SessionView) };
}

describe('session/[id] param parsing', () => {
    it('omits jumpToSeq when jumpSeq is missing', async () => {
        const { sessionView } = await renderSessionScreen();
        expect(sessionView.props.jumpToSeq ?? null).toBeNull();
    });

    it('omits jumpToSeq for an empty or whitespace route value', async () => {
        searchParams = { ...searchParams, jumpSeq: '   ' };
        const { sessionView } = await renderSessionScreen();
        expect(sessionView.props.jumpToSeq ?? null).toBeNull();
    });

    it('hydrates a cold deep link through its qualified Home before mounting Session view', async () => {
        makeSessionCold();
        const { SessionView } = await import('@/components/sessions/shell/SessionView');
        const screen = await renderSessionScreenTree();
        await flushHookEffects();
        expect(sessionReads).toEqual(['https://session-pane.test']);
        expect(storage.getState().sessions['session-123']).toMatchObject({ serverId: runtime.serverId, encryptionMode: 'plain' });
        expect(screen.findByType(SessionView).props.id).toBe('session-123');
    });

    it('retains the hydration boundary until the Home response resolves', async () => {
        makeSessionCold();
        deferredSession = createDeferred<Response>();
        const deferred = deferredSession;
        const { SessionView } = await import('@/components/sessions/shell/SessionView');
        try {
            const screen = await renderSessionScreenTree();
            expect(screen.findAllByType(SessionView)).toHaveLength(0);
            expect(sessionReads).toEqual(['https://session-pane.test']);
            deferred.resolve(await sessionResponse());
            await flushHookEffects();
            expect(screen.findByType(SessionView).props.id).toBe('session-123');
        } finally {
            deferred.resolve(await sessionResponse());
        }
    });

    it('renders the actual invalid-link fallback without a Session fetch for a missing id', async () => {
        searchParams = {};
        const { SessionView } = await import('@/components/sessions/shell/SessionView');
        const screen = await renderSessionScreenTree();
        expect(sessionReads).toEqual([]);
        expect(screen.findAllByType(SessionView)).toHaveLength(0);
        expect(screen.findByTestId('session-invalid-link')).toBeTruthy();
    });
});
