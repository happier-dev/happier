import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';

import { SESSION_ACTION_SET_APPEARANCE_COLOR_ID } from '@/components/sessions/actions/sessionActionIds';
import type { SessionAppearanceColor } from '@/sync/domains/session/organization/appearanceColor';

import { useSessionRowActionMenu } from './useSessionRowActionMenu';

const ACCENT_COLORS = {
    blue: '#0000FF', green: '#00FF00', orange: '#FFAA00', yellow: '#FFFF00', red: '#FF0000', indigo: '#4400FF', purple: '#AA00FF',
} as const;

function createRowTarget() {
    const session: SessionListRenderableSession = {
        id: 'session_1', active: false, archivedAt: null, owner: 'user_1', accessLevel: undefined, seq: 4,
        lastViewedSessionSeq: 4, latestTurnStatus: 'completed', createdAt: 1, updatedAt: 1, activeAt: 1,
        metadataVersion: 1, agentStateVersion: 1, metadata: null, thinking: false, thinkingAt: 0, presence: 1,
    };
    return createSessionActionTarget({ session, serverId: 'server_1', currentUserId: 'user_1', isConnected: true, isPinned: false });
}

async function renderRowMenu(appearance: Parameters<typeof useSessionRowActionMenu>[0]['appearance']) {
    const target = createRowTarget();
    return renderHook(() => useSessionRowActionMenu({
        target,
        sessionName: 'Session 1',
        hideInactiveSessions: false,
        iconColor: '#999',
        activeTags: [],
        knownTags: [],
        tagsEnabled: false,
        isNativeMobile: false,
        setContextMenuOpen: vi.fn(),
        openTagsMenuFromContext: vi.fn(),
        appearance,
    }));
}

describe('useSessionRowActionMenu', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('dispatches contextual menu item selections through their owning handler', async () => {
        const session: SessionListRenderableSession = {
            id: 'session_1',
            active: false,
            archivedAt: null,
            owner: 'user_1',
            accessLevel: undefined,
            seq: 4,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'completed',
            createdAt: 1,
            updatedAt: 1,
            activeAt: 1,
            metadataVersion: 1,
            agentStateVersion: 1,
            metadata: null,
            thinking: false,
            thinkingAt: 0,
            presence: 1,
        };
        const target = createSessionActionTarget({
            session,
            serverId: 'server_1',
            currentUserId: 'user_1',
            isConnected: true,
            isPinned: false,
        });
        const onSelectCustomMenuItem = vi.fn(async () => undefined);

        const hook = await renderHook(() => useSessionRowActionMenu({
            target,
            sessionName: 'Session 1',
            hideInactiveSessions: false,
            iconColor: '#999',
            activeTags: [],
            knownTags: [],
            tagsEnabled: false,
            leadingMenuItems: [
                { id: 'session.copyDebugInformation', title: 'Copy information' },
            ],
            onSelectCustomMenuItem,
            selectionModeAvailable: false,
            selectionModeActive: false,
            isNativeMobile: false,
            setContextMenuOpen: vi.fn(),
            openTagsMenuFromContext: vi.fn(),
        }));

        expect(hook.getCurrent().moreMenuItems.some((item) => item.id === 'session.copyDebugInformation')).toBe(true);

        await act(async () => {
            await hook.getCurrent().handleMoreMenuSelect('session.copyDebugInformation');
        });

        expect(onSelectCustomMenuItem).toHaveBeenCalledWith('session.copyDebugInformation');
    });

    it('offers a session colour beside the frequent session actions and writes the chosen colour', async () => {
        const onChange = vi.fn<(color: SessionAppearanceColor | null) => void>();
        const hook = await renderRowMenu({
            current: { kind: 'accent', key: 'green' },
            customColors: ['#123456'],
            theme: { colors: { accent: ACCENT_COLORS } },
            onChange,
        });

        const items = hook.getCurrent().moreMenuItems;
        const colorItem = items.find((item) => item.id === SESSION_ACTION_SET_APPEARANCE_COLOR_ID);
        expect(colorItem?.submenu).toBeDefined();
        const submenu = colorItem!.submenu!.items;
        const swatches = submenu.filter((item) => item.swatch);
        const colorSwatches = swatches.filter((item) => !item.swatch!.empty);
        expect(colorSwatches.map((item) => item.swatch!.color)).toEqual([
            ...Object.values(ACCENT_COLORS),
            '#123456',
        ]);
        expect(swatches.filter((item) => item.swatch!.checked).map((item) => item.swatch!.color)).toEqual(['#00FF00']);
        // Remove is a struck-through swatch in the custom row; Custom color… is the one text row.
        expect(submenu.filter((item) => !item.swatch)).toHaveLength(1);
        expect(swatches.filter((item) => item.swatch!.empty)).toHaveLength(1);

        const red = swatches.find((item) => item.swatch!.color === '#FF0000')!;
        const custom = swatches.find((item) => item.swatch!.color === '#123456')!;
        // Screen readers hear what the swatch is, not a bare hex code.
        expect(custom.title).toContain('#123456');
        expect(custom.title).not.toBe('#123456');
        const remove = swatches.find((item) => item.swatch!.empty)!;
        // One continuous grid: presets, then colours in use, then Remove last.
        expect(new Set(swatches.map((item) => item.swatch!.group)).size).toBe(1);
        expect(swatches.at(-1)).toBe(remove);
        await act(async () => {
            await hook.getCurrent().handleMoreMenuSelect(red.id);
            await hook.getCurrent().handleMoreMenuSelect(custom.id);
            await hook.getCurrent().handleMoreMenuSelect(remove.id);
        });

        expect(onChange.mock.calls).toEqual([
            [{ kind: 'accent', key: 'red' }],
            [{ kind: 'custom', hex: '#123456' }],
            [null],
        ]);
    });

    it('only offers removal when the session has its own colour', async () => {
        const hook = await renderRowMenu({ current: null, customColors: [], theme: { colors: { accent: ACCENT_COLORS } }, onChange: vi.fn() });

        const submenu = hook.getCurrent().moreMenuItems
            .find((item) => item.id === SESSION_ACTION_SET_APPEARANCE_COLOR_ID)!.submenu!.items;
        expect(submenu.filter((item) => item.swatch?.checked)).toHaveLength(0);
        expect(submenu.filter((item) => item.swatch?.empty)).toHaveLength(0);
    });

    it('hides the session colour action when the server cannot store it', async () => {
        const hook = await renderRowMenu(null);

        expect(hook.getCurrent().moreMenuItems.some((item) => item.id === SESSION_ACTION_SET_APPEARANCE_COLOR_ID)).toBe(false);
    });

    it('shows a colour inherited from the project quietly, and picking it gives the session its own colour', async () => {
        const onChange = vi.fn<(color: SessionAppearanceColor | null) => void>();
        const hook = await renderRowMenu({
            current: null,
            inherited: { kind: 'accent', key: 'orange' },
            customColors: [],
            theme: { colors: { accent: ACCENT_COLORS } },
            onChange,
        });

        const submenu = hook.getCurrent().moreMenuItems
            .find((item) => item.id === SESSION_ACTION_SET_APPEARANCE_COLOR_ID)!.submenu!.items;
        const orange = submenu.find((item) => item.swatch?.color === '#FFAA00')!;
        expect(orange.swatch).toMatchObject({ inherited: true });
        expect(orange.swatch?.checked).not.toBe(true);
        expect(orange.subtitle).toBeTruthy();
        expect(submenu.filter((item) => item.swatch?.inherited)).toHaveLength(1);
        expect(submenu.filter((item) => item.swatch?.empty)).toHaveLength(0);

        await act(async () => {
            await hook.getCurrent().handleMoreMenuSelect(orange.id);
        });
        expect(onChange).toHaveBeenCalledWith({ kind: 'accent', key: 'orange' });
    });

    it('does not mark an inherited colour once the session has its own', async () => {
        const hook = await renderRowMenu({
            current: { kind: 'accent', key: 'red' },
            inherited: { kind: 'accent', key: 'orange' },
            customColors: [],
            theme: { colors: { accent: ACCENT_COLORS } },
            onChange: vi.fn(),
        });

        const submenu = hook.getCurrent().moreMenuItems
            .find((item) => item.id === SESSION_ACTION_SET_APPEARANCE_COLOR_ID)!.submenu!.items;
        expect(submenu.filter((item) => item.swatch?.inherited)).toHaveLength(0);
        expect(submenu.filter((item) => item.swatch?.checked).map((item) => item.swatch!.color)).toEqual(['#FF0000']);
    });
});
