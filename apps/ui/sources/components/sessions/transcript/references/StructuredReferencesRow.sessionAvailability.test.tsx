import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

// Hoisted: the real storage barrel pulls `expo-router` in during module mocking, which happens
// before any file-level `const` is initialized.
const routerMockState = vi.hoisted(() => ({ push: vi.fn(), navigate: vi.fn() }));
const routerPushSpy = routerMockState.push;
const routerNavigateSpy = routerMockState.navigate;

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'tablet',
}));

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    useMappingHelper: () => ({
        getMappingKey: (itemKey: string | number | bigint) => itemKey,
    }),
}));

/**
 * The seam both previous attempts at this defect left untested. Every other suite around this
 * row (`StructuredReferencesRow.open.test.tsx`, `MessageView.structuredReferences.test.tsx`)
 * replaces `useSessionReferenceTarget` with a stub, so the chip's availability answer — the thing
 * that was wrong — was never computed from a real store in any test. Here the real hook runs
 * against the real store, and the rest of the storage module stays stubbed.
 */
vi.hoisted(async () => {
    const { installProjectFileLinkPickerCommonModuleMocks } = await import('@/components/sessions/linkedFiles/projectPicker/projectFileLinkPickerTestHelpers');

    installProjectFileLinkPickerCommonModuleMocks({
        reactNative: async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                useWindowDimensions: () => ({ width: 1400, height: 900 }),
            });
        },
        router: async () => {
            const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
            return createExpoRouterMock({ router: { push: routerMockState.push, navigate: routerMockState.navigate } }).module;
        },
        storage: async (importOriginal) => {
            const original = await importOriginal<typeof import('@/sync/domains/state/storage')>();
            const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
            return createStorageModuleStub({
                useLocalSetting: (key: string) => (key === 'uiMultiPanePanelsEnabled' ? true : undefined),
                useSessionReferenceTarget: original.useSessionReferenceTarget,
                storage: original.storage,
                getStorage: original.getStorage,
            });
        },
    });

    return null;
});

function renderableSession(
    id: string,
    overrides: Partial<SessionListRenderableSession> = {},
): SessionListRenderableSession {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1_000,
        active: false,
        activeAt: 1,
        metadataVersion: 1,
        agentStateVersion: 1,
        metadata: { name: `Session ${id}`, path: '/Users/dev/projects/app' },
        thinking: false,
        thinkingAt: 0,
        presence: 1,
        ...overrides,
    };
}

let previousState: ReturnType<typeof storage.getState>;

beforeEach(() => {
    routerPushSpy.mockClear();
    routerNavigateSpy.mockClear();
    previousState = storage.getState();
});

afterEach(() => {
    storage.setState(previousState);
});

async function renderSessionReference(sessionId: string, label: string | null) {
    const { StructuredReferencesRow } = await import('./StructuredReferencesRow');
    return await renderScreen(
        <AppPaneProvider>
            <StructuredReferencesRow
                sessionId="host-session"
                references={[{ kind: 'session', sessionId, label }]}
                fileOpenEnabled
            />
        </AppPaneProvider>,
    );
}

describe('StructuredReferencesRow session availability', () => {
    /**
     * OBSERVED live on the running stack (2026-08-10), with a stack trace on the eviction:
     * archiving `cmsnniaiq1w1rtmp7pz3m1svh` left it in NEITHER store map — `resumeViaChanges →
     * fetchSessionsOnce → fetchAndApplySessions → applySessionListRenderables →
     * replaceSessionListRenderables(468 rows, id omitted)` evicted its renderable because
     * `/v2/sessions` filters `archivedAt: null` server-side, and `state.sessions` never held it
     * (measured at that instant: `sessions \ renderables` = 0, `renderables \ sessions` = 97 —
     * `sessions` is a SUBSET of the renderables, so it can never rescue an evicted row).
     *
     * The session was still fully readable: navigating to `/session/cmsnniaiq1w1rtmp7pz3m1svh`
     * from that exact state loaded and rendered it. A cache miss is not evidence of deletion, so
     * it must not be presented as one.
     */
    it('keeps a reference pressable and openable when the session is in neither store map', async () => {
        storage.setState((state) => ({
            ...state,
            sessions: {},
            sessionListRenderables: {},
        }));

        const screen = await renderSessionReference('archived-target', 'L22c QA archive-target');

        const chip = screen.findByTestId('transcript-session-reference:archived-target');
        expect(chip?.type).toBe('Pressable');
        expect(chip?.props.accessibilityRole).toBe('button');
        expect(screen.getTextContent()).toContain('L22c QA archive-target');
        expect(screen.getTextContent()).not.toContain('message.sessionReferenceUnavailable');

        await pressTestInstanceAsync(chip!, 'transcript-session-reference:archived-target');
        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/archived-target', expect.any(Object));
    });

    /**
     * D-6's inert state, and the only evidence of "gone" this viewer actually has: the delete
     * signal the changes stream feeds to `deleteSession`. Driven through the real domain action
     * so the chip and the delete owner cannot drift apart.
     */
    it('renders a deleted session reference inert and refuses to navigate', async () => {
        storage.setState((state) => ({
            ...state,
            sessions: {},
            sessionListRenderables: { 'deleted-target': renderableSession('deleted-target') },
        }));
        storage.getState().deleteSession('deleted-target');

        const screen = await renderSessionReference('deleted-target', 'Release prep');

        const chip = screen.findByTestId('transcript-session-reference:deleted-target');
        expect(chip?.type).toBe('View');
        expect(chip?.props.accessibilityRole).toBe('text');
        expect(chip?.props.onPress).toBeUndefined();
        expect(screen.getTextContent()).toContain('message.sessionReferenceUnavailable');
        expect(screen.getTextContent()).toContain('Release prep');

        expect(routerPushSpy).not.toHaveBeenCalled();
        expect(routerNavigateSpy).not.toHaveBeenCalled();
    });

    it('prefers the live title over the composed label while the session is known', async () => {
        storage.setState((state) => ({
            ...state,
            sessions: {},
            sessionListRenderables: {
                'known-target': renderableSession('known-target', {
                    metadata: { name: 'ZZ Renamed Target QQ', path: '/Users/dev/projects/app' },
                }),
            },
        }));

        const screen = await renderSessionReference('known-target', 'Title at compose time');

        const chip = screen.findByTestId('transcript-session-reference:known-target');
        expect(chip?.type).toBe('Pressable');
        expect(screen.getTextContent()).toContain('ZZ Renamed Target QQ');
        expect(screen.getTextContent()).not.toContain('Title at compose time');
    });
});
