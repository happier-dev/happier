// @vitest-environment jsdom

import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createDeferred, createSessionFixture, createSessionMessagesFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { installPublicShareViewerCommonModuleMocks } from './publicShareViewerTestHelpers';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import type { SessionTranscriptSource } from '@/components/sessions/transcript/source/types';
import { storage } from '@/sync/domains/state/storageStore';
import type { Message } from '@happier-dev/session-core/messages';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { initializeTerminalRouteRuntimeForTests } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

installPublicShareViewerCommonModuleMocks();


// Shared Session UI also imports Expo's random APIs directly. The native SDK
// cannot initialize in Node; use the repository's real OS-crypto adapters.
vi.mock('expo-crypto', async () => {
    const [randomBytes, uuid] = await Promise.all([
        import('@/platform/cryptoRandom.node'),
        import('@/platform/randomUUID.node'),
    ]);
    return { ...randomBytes, ...uuid };
});
await initializeTerminalRouteRuntimeForTests();

// The installed Legend web build owns its div refs. jsdom supplies DOM behavior,
// while this OS/layout boundary supplies the geometry a headless renderer lacks.
function createMeasuredWebNode(element: React.ReactElement): HTMLElement {
    const node = document.createElement('div');
    const props = element.props as { style?: React.CSSProperties };
    const style = props.style;
    const scroller = style?.overflowY === 'auto' || style?.overflow === 'auto';
    const height = scroller ? 600 : typeof style?.height === 'number' ? style.height : 120;
    node.getBoundingClientRect = () => new DOMRect(0, 0, 800, height);
    Object.defineProperties(node, {
        clientHeight: { value: height }, clientWidth: { value: 800 },
        scrollHeight: { value: Math.max(height, 600) }, scrollWidth: { value: 800 },
    });
    node.scrollTo = (optionsOrX: ScrollToOptions | number = {}, y?: number) => {
        node.scrollLeft = typeof optionsOrX === 'number' ? optionsOrX : optionsOrX.left ?? node.scrollLeft;
        node.scrollTop = typeof optionsOrX === 'number' ? y ?? node.scrollTop : optionsOrX.top ?? node.scrollTop;
    };
    return node;
}

describe('public share transcript source', () => {
    it('renders shared rows and authorship under its own source despite a viewer row with the same session id', async () => {
        const olderPage = createDeferred<Response>();
        const sharedRequests: string[] = [];
        const viewerConnection = await restoreServerAccountForTest({
            serverUrl: 'https://share-source.example.test', accountId: 'private-viewer',
            request: async (input) => {
                const url = new URL(String(input));
                if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({}));
                if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (url.pathname === '/v1/public-share/tok-1') {
                    sharedRequests.push(url.href);
                    return Response.json({
                        session: {
                            id: 'same-session', seq: 1, encryptionMode: 'plain',
                            createdAt: 1, updatedAt: 2, active: false, activeAt: 2,
                            metadata: JSON.stringify({ path: '/shared', host: 'shared-host', name: 'Shared session' }),
                            metadataVersion: 1,
                        },
                        owner: { id: 'owner', username: 'alice', firstName: null, lastName: null, avatar: null },
                        accessLevel: 'view', encryptedDataKey: null, isConsentRequired: false,
                    });
                }
                if (url.pathname === '/v1/public-share/tok-1/messages') {
                    sharedRequests.push(url.href);
                    if (url.searchParams.has('beforeSeq')) return olderPage.promise;
                    return Response.json({ messages: [{
                        id: 'shared-message', seq: 1, localId: null, createdAt: 3, updatedAt: 3,
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Shared dataset content' } } },
                    }], hasMore: true, nextBeforeSeq: 1 });
                }
                return new Response('{}', { status: 404 });
            },
        });
        const before = storage.getState();
        const frameGlobals = ['requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver'] as const;
        const frameDescriptors = frameGlobals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
        // Use the canonical timer-backed frame scheduler rather than jsdom's
        // separate animation queue, so teardown can cancel every pending frame.
        Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
        Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
        vi.useFakeTimers();
        installShippedNativeFrameScheduler();
        // Geometry is static in this case; real Legend performs the initial DOM
        // measurements. There are no resize events for the platform to deliver.
        vi.stubGlobal('ResizeObserver', class implements ResizeObserver {
            observe() {}
            unobserve() {}
            disconnect() {}
        });
        const viewerMessage: Message = {
            kind: 'user-text', id: 'private-message', localId: null, createdAt: 1,
            text: 'Viewer private content',
        };
        const viewerSession = createSessionFixture({
            id: 'same-session',
            metadata: { path: '/viewer-private-workspace', host: 'viewer-private-host', name: 'Viewer private session', machineId: 'viewer-private-machine' },
        });
        const viewerMessages = createSessionMessagesFixture({
            messageIdsOldestFirst: [viewerMessage.id],
            messagesById: { [viewerMessage.id]: viewerMessage },
            messagesVersion: 1, isLoaded: true,
        });
        storage.setState({
            sessions: { ...before.sessions, [viewerSession.id]: viewerSession },
            sessionMessages: { ...before.sessionMessages, [viewerSession.id]: viewerMessages },
        });
        try {
            const { default: PublicShareViewerScreen } = await import('@/app/(app)/share/[token]');
            const screen = await renderScreen(<InjectedAuthProvider credentials={viewerConnection.credentials}><PublicShareViewerScreen /></InjectedAuthProvider>, {
                createNodeMock: createMeasuredWebNode,
            });
            await flushHookEffects({ cycles: 4, turns: 2, frames: 2 });

            expect(screen.getTextContent()).toContain('Shared dataset content');
            expect(screen.getTextContent()).not.toContain('Viewer private content');
            const source: SessionTranscriptSource = screen.findByType(SessionTranscriptSourceProvider).props.source;
            const selected = await renderHook(() => ({
                messages: source.useMessagesById(), metadata: source.useMetadata(),
                authorship: source.useAuthorship(), workspacePath: source.useWorkspacePath(),
                reducerState: source.useReducerState(),
                history: source.history.useState(),
            }));
            expect(source.kind).toBe('readOnly');
            expect(Object.values(selected.getCurrent().messages).map((message) => message.kind === 'user-text' ? message.text : null))
                .toEqual(['Shared dataset content']);
            expect(selected.getCurrent().metadata?.path).toBe('/shared');
            expect(selected.getCurrent().workspacePath).toBeNull();
            expect(selected.getCurrent().authorship.viewerScope).toBeNull();
            expect(selected.getCurrent().reducerState?.messageIds.has('shared-message')).toBe(true);
            expect(selected.getCurrent().reducerState?.messageIds.has('private-message')).toBe(false);
            expect(screen.getTextContent()).not.toContain('message.accountActorYou');
            expect(screen.getTextContent()).not.toContain('Viewer private session');
            expect(screen.getTextContent()).not.toContain('/viewer-private-workspace');
            expect(storage.getState().sessions[viewerSession.id]).toBe(viewerSession);
            expect(storage.getState().sessionMessages[viewerSession.id]).toBe(viewerMessages);
            const acceptedMessages = Object.values(selected.getCurrent().messages);
            let loading: Promise<unknown> | undefined;
            // The real list may already have requested its initial fill. Otherwise start
            // the same pending HTTP page through the source's public history boundary.
            await act(async () => {
                if (sharedRequests.length === 2) {
                    loading = source.history.loadOlder!();
                }
            });
            expect(selected.getCurrent().history.isLoadingOlder).toBe(true);
            // A failed page clears the pending state without discarding the accepted dataset.
            await act(async () => {
                olderPage.resolve(new Response('', { status: 503 }));
                await (loading ?? olderPage.promise);
            });
            expect(selected.getCurrent().history.isLoadingOlder).toBe(false);
            expect(selected.getCurrent().history.hasOlder).toBe(true);
            expect(Object.values(selected.getCurrent().messages)).toEqual(acceptedMessages);
            expect(Object.values(selected.getCurrent().messages)[0]).toBe(acceptedMessages[0]);
        } finally {
            await standardCleanup();
            // The installed web runtime can retain a queued bootstrap ticker.
            // Cancel this test's OS work after unmount, before removing its RAF.
            vi.clearAllTimers();
            vi.useRealTimers();
            storage.setState(before, true);
            vi.unstubAllGlobals();
            frameGlobals.forEach((name, index) => {
                const descriptor = frameDescriptors[index];
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            });
            await viewerConnection.dispose();
        }
    });
});
