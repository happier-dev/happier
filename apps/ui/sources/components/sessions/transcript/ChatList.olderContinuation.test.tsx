import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { storage } from '@/sync/domains/state/storage';
import '@/sync/syncEngine';
import { sync } from '@/sync/sync';
import {
    activateSessionMessagesWindow,
    createInactiveSessionMessagesWindowState,
    type SessionMessagesWindowState,
} from '@/sync/runtime/sessionMessagesWindowState';
import { ChatList } from './ChatList';

// Only the native recycler and immutable packaged asset inventory are replaced. The
// mounted ChatList, target-window projection, pager, Sync and storage remain real.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({
        original: await importOriginal<Record<string, unknown>>(),
        renderItems: false,
    }).module;
});
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', async () => {
    const { emptyBundledPluginUiAssetsModule } = await import('@/dev/testkit/mocks/bundledPluginUiAssets');
    return emptyBundledPluginUiAssetsModule;
});

describe('ChatList older continuation scope', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('does not offer the main older cursor while a non-scrollable target window is active', async () => {
        const initialStorage = storage.getState();
        const session = createSessionFixture({ id: 'underfilled-target-window', metadata: null });
        // Seed the existing window lifecycle, not a substitute getter or projection.
        const windowOwner = sync as unknown as {
            setSessionTargetWindowState: (sessionId: string, state: SessionMessagesWindowState) => void;
        };
        const initialWindow = sync.getSessionTargetWindowState(session.id);
        storage.getState().applySessions([session]);
        storage.getState().applyMessagesLoaded(session.id);
        const screen = await renderScreen(
            <ChatList session={session} sessionSurfaceKey={sessionAddressKey({ serverId: 'test-server', sessionId: session.id })} />,
        );
        try {
            // Positive control: bounded, empty main history has the explicit recovery action.
            expect(screen.findByTestId('transcript.olderLoad.continue.action')).not.toBeNull();
            await act(async () => {
                windowOwner.setSessionTargetWindowState(session.id, activateSessionMessagesWindow(
                    createInactiveSessionMessagesWindowState(),
                    {
                        windowId: `${session.id}:main:seq:100`,
                        targetSeq: 100,
                        windowMinSeq: 100,
                        windowMaxSeq: 100,
                        olderCursor: 100,
                        newerCursor: 100,
                        hasMoreOlder: false,
                        hasMoreNewer: false,
                        activatedAtMs: Date.now(),
                    },
                ));
            });
            expect(sync.getSessionTargetWindowState(session.id).isWindowMode).toBe(true);
            expect(screen.findByTestId('transcript.olderLoad.continue.action')).toBeNull();
            await act(async () => {
                windowOwner.setSessionTargetWindowState(session.id, createInactiveSessionMessagesWindowState());
            });
            expect(screen.findByTestId('transcript.olderLoad.continue.action')).not.toBeNull();
        } finally {
            await screen.unmount();
            windowOwner.setSessionTargetWindowState(session.id, initialWindow);
            storage.setState(initialStorage, true);
        }
    });
});
