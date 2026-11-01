import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import { SESSION_ACTION_SET_APPEARANCE_COLOR_ID } from '@/components/sessions/actions/sessionActionIds';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The picker's lazily loaded chunk is the boundary: each test decides when (and whether) it arrives.
const chunk = vi.hoisted(() => ({ settle: null as null | ((ok: boolean) => void) }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

const THEME = { colors: { accent: { blue: '#0000FF', green: '#00FF00', orange: '#FFAA00', yellow: '#FFFF00', red: '#FF0000', indigo: '#4400FF', purple: '#AA00FF' } } };

async function renderMenu(closeMenus: () => void) {
    const { useSessionRowActionMenu } = await import('./useSessionRowActionMenu');
    const session: SessionListRenderableSession = {
        id: 'session_1', active: false, archivedAt: null, owner: 'user_1', accessLevel: undefined, seq: 4,
        lastViewedSessionSeq: 4, latestTurnStatus: 'completed', createdAt: 1, updatedAt: 1, activeAt: 1,
        metadataVersion: 1, agentStateVersion: 1, metadata: null, thinking: false, thinkingAt: 0, presence: 1,
    };
    const target = createSessionActionTarget({ session, serverId: 'server_1', currentUserId: 'user_1', isConnected: true, isPinned: false });
    return renderHook(() => useSessionRowActionMenu({
        target, sessionName: 'Session 1', hideInactiveSessions: false, iconColor: '#999', activeTags: [], knownTags: [],
        tagsEnabled: false, isNativeMobile: false, setContextMenuOpen: vi.fn(), openTagsMenuFromContext: vi.fn(),
        closeMenus,
        appearance: { current: null, customColors: [], theme: THEME, onChange: vi.fn() },
    }));
}

function customPicker(hook: Awaited<ReturnType<typeof renderMenu>>) {
    const submenu = hook.getCurrent().moreMenuItems.find((item) => item.id === SESSION_ACTION_SET_APPEARANCE_COLOR_ID)!.submenu!;
    return submenu.items.find((item) => item.id.endsWith(':custom-picker'))!;
}

describe('useSessionRowActionMenu custom colour', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        chunk.settle = null;
        // Re-registered per test so each one controls its own arrival of the chunk.
        vi.doMock('@/components/sessions/shell/appearance/SessionAppearanceCustomColorModal', async () => {
            const ok = await new Promise<boolean>((resolve) => { chunk.settle = resolve; });
            if (!ok) throw new Error('chunk failed');
            return { SessionAppearanceCustomColorModal: () => null };
        });
    });
    afterEach(() => {
        standardCleanup();
    });

    it('keeps the menu open and shows progress while the picker loads, then closes it and opens the dialog', async () => {
        const closeMenus = vi.fn();
        const hook = await renderMenu(closeMenus);
        const { Modal } = await import('@/modal');
        expect(customPicker(hook).keepMenuOpen).toBe(true);

        let selection: Promise<void> | undefined;
        await act(async () => {
            selection = hook.getCurrent().handleMoreMenuSelect(customPicker(hook).id);
        });
        await vi.waitFor(() => expect(chunk.settle).not.toBeNull());
        expect(customPicker(hook).loading).toBe(true);
        expect(closeMenus).not.toHaveBeenCalled();
        expect(Modal.show).not.toHaveBeenCalled();

        await act(async () => {
            chunk.settle?.(true);
        });
        await vi.waitFor(() => expect(Modal.show).toHaveBeenCalledOnce());
        expect(closeMenus).toHaveBeenCalledOnce();
        expect(customPicker(hook).loading).not.toBe(true);
        void selection;
        await hook.unmount();
    });

    it('clears the progress and reports the failure when the picker cannot load', async () => {
        const closeMenus = vi.fn();
        const hook = await renderMenu(closeMenus);
        const { Modal } = await import('@/modal');

        await act(async () => {
            void hook.getCurrent().handleMoreMenuSelect(customPicker(hook).id);
        });
        await vi.waitFor(() => expect(chunk.settle).not.toBeNull());
        await act(async () => {
            chunk.settle?.(false);
        });
        await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalled());
        expect(customPicker(hook).loading).not.toBe(true);
        expect(closeMenus).not.toHaveBeenCalled();
        expect(Modal.show).not.toHaveBeenCalled();
        await hook.unmount();
    });
});
