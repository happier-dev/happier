import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createSessionFixture,
    createResolveServerIdForSessionIdFromLocalCacheModuleMock,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { Session } from '@/sync/domains/state/storageTypes';

import { TranscriptSendToSessionModal } from './TranscriptSendToSessionModal';

const sessionsRef = vi.hoisted((): { current: Session[] } => ({ current: [] }));
const sessionListIndexByServerIdRef = vi.hoisted((): { current: Record<string, SessionListIndexItem[] | null> } => ({ current: {} }));
const sessionListRowRenderablesByKeyRef = vi.hoisted((): { current: ReadonlyMap<string, SessionListRenderableSession> } => ({ current: new Map() }));
const keyboardLayoutState = vi.hoisted(() => ({
    keyboardHeight: 0,
    windowHeight: 800,
    windowWidth: 390,
}));

vi.mock('@/agents/registry/registryUiBehavior', async () => {
    const { createRegistryUiBehaviorModuleMock } = await import('@/dev/testkit/mocks/registryUiBehavior');
    return createRegistryUiBehaviorModuleMock();
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({
            width: keyboardLayoutState.windowWidth,
            height: keyboardLayoutState.windowHeight,
            scale: 1,
            fontScale: 1,
        }),
    });
});

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => keyboardLayoutState.keyboardHeight,
}));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: 'AgentIcon',
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSessions: () => sessionsRef.current,
        useSessionListIndexByServerId: () => sessionListIndexByServerIdRef.current,
        useSessionListRowRenderablesForItems: () => sessionListRowRenderablesByKeyRef.current,
    });
});

vi.mock(
    '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache',
    async (importOriginal) => createResolveServerIdForSessionIdFromLocalCacheModuleMock({
        importOriginal,
        overrides: {
            resolveServerIdForSessionIdFromLocalCache: (sessionId: string) => (
                sessionId === 'cached-same-server' ? 'server-a' : null
            ),
        },
    }),
);

function createNamedMetadata(name: string): Session['metadata'] {
    return {
        path: `/Users/tester/${name.toLowerCase().replace(/\s+/g, '-')}`,
        host: 'tester.local',
        name,
    };
}

function createSessionListIndexItem(session: Session, serverId: string): SessionListIndexItem {
    return {
        type: 'session',
        sessionId: session.id,
        serverId,
    };
}

function createSessionListRowRenderableMap(sessions: ReadonlyArray<Session>, serverId: string): ReadonlyMap<string, SessionListRenderableSession> {
    return new Map(sessions.map((session) => [`${serverId}:${session.id}`, session as SessionListRenderableSession]));
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('TranscriptSendToSessionModal', () => {
    afterEach(() => {
        sessionsRef.current = [];
        sessionListIndexByServerIdRef.current = {};
        sessionListRowRenderablesByKeyRef.current = new Map();
        keyboardLayoutState.keyboardHeight = 0;
        keyboardLayoutState.windowHeight = 800;
        keyboardLayoutState.windowWidth = 390;
        standardCleanup();
    });

    it('lists the new-session action first, hides the preview, and lists only destinations with a concrete same-server scope', async () => {
        sessionsRef.current = [
            createSessionFixture({ id: 'source', serverId: 'server-a', metadata: createNamedMetadata('Source') }),
            createSessionFixture({ id: 'same-server', serverId: 'server-a', accessLevel: 'edit', metadata: createNamedMetadata('Same server') }),
            createSessionFixture({ id: 'cached-same-server', accessLevel: 'edit', metadata: createNamedMetadata('Cached same server') }),
            createSessionFixture({ id: 'unknown-server', accessLevel: 'edit', metadata: createNamedMetadata('Unknown server') }),
            createSessionFixture({ id: 'other-server', serverId: 'server-b', accessLevel: 'edit', metadata: createNamedMetadata('Other server') }),
        ];

        const screen = await renderScreen(
            <TranscriptSendToSessionModal
                sourceSessionId="source"
                sourceServerId="server-a"
                previewText="Prompt preview that should not render"
                onResolve={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        const renderedText = screen.getTextContent();
        expect(renderedText).toContain('New session');
        expect(renderedText.indexOf('New session')).toBeLessThan(renderedText.indexOf('Same server'));
        expect(renderedText).toContain('Same server');
        expect(renderedText).toContain('Cached same server');
        expect(renderedText).not.toContain('Prompt preview that should not render');
        expect(renderedText).not.toContain('Unknown server');
        expect(renderedText).not.toContain('Other server');
        expect(renderedText).not.toContain('Source');
    });

    it('lists destination sessions from the session-list cache when full sessions are not loaded', async () => {
        const source = createSessionFixture({ id: 'source', metadata: createNamedMetadata('Source') });
        const cachedDestination = createSessionFixture({
            id: 'list-only-destination',
            accessLevel: 'edit',
            metadata: createNamedMetadata('List only destination'),
        });
        sessionsRef.current = [source];
        sessionListIndexByServerIdRef.current = {
            'server-a': [
                createSessionListIndexItem(source, 'server-a'),
                createSessionListIndexItem(cachedDestination, 'server-a'),
            ],
        };
        sessionListRowRenderablesByKeyRef.current = createSessionListRowRenderableMap([source, cachedDestination], 'server-a');

        const screen = await renderScreen(
            <TranscriptSendToSessionModal
                sourceSessionId="source"
                sourceServerId="server-a"
                previewText="Preview"
                onResolve={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        expect(screen.getTextContent()).toContain('List only destination');
    });

    it('resolves the new-session action from the top option', async () => {
        sessionsRef.current = [
            createSessionFixture({ id: 'source', serverId: 'server-a', metadata: createNamedMetadata('Source') }),
            createSessionFixture({ id: 'same-server', serverId: 'server-a', accessLevel: 'edit', metadata: createNamedMetadata('Same server') }),
        ];
        const onResolve = vi.fn();
        const onClose = vi.fn();

        const screen = await renderScreen(
            <TranscriptSendToSessionModal
                sourceSessionId="source"
                sourceServerId="server-a"
                previewText="Preview"
                onResolve={onResolve}
                onClose={onClose}
            />,
        );

        await screen.pressByTestIdAsync('transcript-send-to-session-list:transcript-send-to-session-root:option:new-session');

        expect(onResolve).toHaveBeenCalledWith({ kind: 'newSession' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('shows provider logos plus status and meaningful activity on the right of session rows', async () => {
        const nowMs = Date.now();
        const activityAt = nowMs - 2 * 60 * 60 * 1000;
        const sameServerMetadata = createNamedMetadata('Same server');
        if (!sameServerMetadata) throw new Error('expected session metadata fixture');
        sessionsRef.current = [
            createSessionFixture({ id: 'source', serverId: 'server-a', metadata: createNamedMetadata('Source') }),
            createSessionFixture({
                id: 'same-server',
                serverId: 'server-a',
                accessLevel: 'edit',
                active: true,
                activeAt: nowMs,
                thinking: true,
                thinkingAt: nowMs,
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: nowMs,
                meaningfulActivityAt: activityAt,
                metadata: {
                    ...sameServerMetadata,
                    flavor: 'claude',
                },
            }),
        ];

        const screen = await renderScreen(
            <TranscriptSendToSessionModal
                sourceSessionId="source"
                sourceServerId="server-a"
                previewText="Preview"
                onResolve={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        expect(screen.findByTestId('transcript-send-to-session-agent-logo-same-server')).not.toBeNull();
        const meta = screen.findByTestId('transcript-send-to-session-meta-same-server');
        expect(meta).not.toBeNull();
        expect(screen.getTextContent()).toContain('working...');
        expect(screen.getTextContent()).toContain('2h');
    });

    it('uses a native-safe fixed-height scroll viewport that grows with the modal and exposes scroll affordances', async () => {
        keyboardLayoutState.windowHeight = 1000;
        keyboardLayoutState.windowWidth = 1200;
        sessionsRef.current = [
            createSessionFixture({ id: 'source', serverId: 'server-a', metadata: createNamedMetadata('Source') }),
            ...Array.from({ length: 12 }, (_, index) => createSessionFixture({
                id: `same-server-${index}`,
                serverId: 'server-a',
                accessLevel: 'edit',
                metadata: createNamedMetadata(`Same server ${index}`),
            })),
        ];

        const screen = await renderScreen(
            <TranscriptSendToSessionModal
                sourceSessionId="source"
                sourceServerId="server-a"
                previewText="Preview"
                onResolve={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        const list = screen.findByTestId('transcript-send-to-session-list');
        if (!list) throw new Error('expected transcript send-to session list to render');
        const listStyle = flattenStyle(list.props.style);
        expect(listStyle.height).toBe(listStyle.maxHeight);
        expect(listStyle.height).toBeGreaterThanOrEqual(500);

        const bodyScroll = screen.findByTestId('transcript-send-to-session-list:bodyScroll');
        expect(bodyScroll).not.toBeNull();
        expect(bodyScroll?.props.showsVerticalScrollIndicator).toBe(true);
        const fadeHost = screen.findByTestId('transcript-send-to-session-list:bodyScroll:fadeHost');
        const bottomFade = screen.findByTestId('transcript-send-to-session-list:bodyScroll:fadeBottom');
        expect(fadeHost).not.toBeNull();
        expect(bottomFade?.props.pointerEvents).toBe('none');
    });

    it('reduces the destination list height while the native keyboard is open', async () => {
        keyboardLayoutState.keyboardHeight = 320;
        keyboardLayoutState.windowHeight = 760;
        sessionsRef.current = [
            createSessionFixture({ id: 'source', serverId: 'server-a', metadata: createNamedMetadata('Source') }),
            createSessionFixture({ id: 'same-server', serverId: 'server-a', accessLevel: 'edit', metadata: createNamedMetadata('Same server') }),
        ];

        const screen = await renderScreen(
            <TranscriptSendToSessionModal
                sourceSessionId="source"
                sourceServerId="server-a"
                previewText="Preview"
                onResolve={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        const list = screen.findByTestId('transcript-send-to-session-list');
        if (!list) throw new Error('expected transcript send-to session list to render');
        const listStyle = flattenStyle(list.props.style);
        expect(listStyle.maxHeight).toBeLessThan(360);
        expect(listStyle.maxHeight).toBeGreaterThanOrEqual(160);
    });
});
