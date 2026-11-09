import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import { SESSION_ACTION_SET_APPEARANCE_COLOR_ID } from '@/components/sessions/actions/sessionActionIds';
import { createSessionListRenderableSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { SessionAppearanceColor } from '@/sync/domains/session/organization/appearanceColor';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { storage } = await import('@/sync/domains/state/storageStore');
const { useSessionRowActionMenu } = await import('./useSessionRowActionMenu');
let serverId: string;
let previousState = storage.getState();

const ACCENT_COLORS = {
    blue: '#0000FF', green: '#00FF00', orange: '#FFAA00', yellow: '#FFFF00', red: '#FF0000', indigo: '#4400FF', purple: '#AA00FF',
} as const;
const THEME = { colors: { accent: ACCENT_COLORS } };

function renderRowMenu(appearance: Parameters<typeof useSessionRowActionMenu>[0]['appearance']) {
    const target = createSessionActionTarget({
        session: createSessionListRenderableSessionFixture({
            id: 'session_1', active: false, owner: 'user_1', metadata: null,
            seq: 4, lastViewedSessionSeq: 4, latestTurnStatus: 'completed',
        }),
        serverId,
        currentUserId: 'user_1',
        isConnected: false,
    });
    return renderHook(() => useSessionRowActionMenu({
        target,
        sessionName: 'Session one',
        hideInactiveSessions: false,
        iconColor: '#000000',
        activeTags: [],
        knownTags: [],
        tagsEnabled: false,
        touchPrimaryPointer: false,
        setContextMenuOpen: () => undefined,
        openTagsMenuFromContext: () => undefined,
        appearance,
    }));
}

function colorSubmenu(hook: Awaited<ReturnType<typeof renderRowMenu>>) {
    return hook.getCurrent().moreMenuItems.find((item) => item.id === SESSION_ACTION_SET_APPEARANCE_COLOR_ID)?.submenu?.items ?? null;
}

beforeEach(async () => {
    previousState = storage.getState();
    await home.reset();
    serverId = await home.addHome({ name: 'Row colour Home', serverUrl: 'https://row-menu-colour.test', accountId: 'user_1' });
});
afterEach(async () => {
    await standardCleanup();
    await home.reset();
    storage.setState(previousState, true);
});

describe('useSessionRowActionMenu colour', () => {
    it('offers presets, colours in use, custom and remove, and writes the chosen colour', async () => {
        const onChange = vi.fn<(color: SessionAppearanceColor | null) => void>();
        const hook = await renderRowMenu({ current: { kind: 'accent', key: 'green' }, customColors: ['#123456'], theme: THEME, onChange });

        const submenu = colorSubmenu(hook)!;
        const swatches = submenu.filter((item) => item.swatch && !item.swatch.empty);
        expect(swatches.map((item) => item.swatch!.color)).toEqual([...Object.values(ACCENT_COLORS), '#123456']);
        expect(swatches.filter((item) => item.checked).map((item) => item.swatch!.color)).toEqual(['#00FF00']);
        const custom = swatches.find((item) => item.swatch!.color === '#123456')!;
        expect(custom.title).toContain('#123456');
        expect(custom.title).not.toBe('#123456');
        // Remove is a struck-through swatch in the custom row; Custom color… is the one text row.
        expect(submenu.filter((item) => !item.swatch)).toHaveLength(1);
        const remove = submenu.find((item) => item.swatch?.empty)!;
        // One continuous grid: presets, then colours in use, then Remove last.
        const grid = submenu.filter((item) => item.swatch);
        expect(new Set(grid.map((item) => item.swatch!.group)).size).toBe(1);
        expect(grid.at(-1)).toBe(remove);

        await act(async () => {
            await hook.getCurrent().handleMoreMenuSelect(swatches.find((item) => item.swatch!.color === '#FF0000')!.id);
            await hook.getCurrent().handleMoreMenuSelect(custom.id);
            await hook.getCurrent().handleMoreMenuSelect(remove.id);
        });
        expect(onChange.mock.calls).toEqual([[{ kind: 'accent', key: 'red' }], [{ kind: 'custom', hex: '#123456' }], [null]]);
        await hook.unmount();
    });

    it('shows an inherited project colour quietly, without removal, and picking it sets the session\'s own', async () => {
        const onChange = vi.fn<(color: SessionAppearanceColor | null) => void>();
        const hook = await renderRowMenu({ current: null, inherited: { kind: 'accent', key: 'orange' }, customColors: [], theme: THEME, onChange });

        const submenu = colorSubmenu(hook)!;
        const orange = submenu.find((item) => item.swatch?.color === '#FFAA00')!;
        expect(orange.swatch).toMatchObject({ inherited: true });
        expect(orange.checked).not.toBe(true);
        expect(orange.subtitle).toBeTruthy();
        expect(submenu.filter((item) => item.checked)).toHaveLength(0);
        expect(submenu.filter((item) => item.swatch?.empty)).toHaveLength(0);

        await act(async () => {
            await hook.getCurrent().handleMoreMenuSelect(orange.id);
        });
        expect(onChange).toHaveBeenCalledWith({ kind: 'accent', key: 'orange' });
        await hook.unmount();
    });

    it('hides the session colour action when the server cannot store it', async () => {
        const hook = await renderRowMenu(null);
        expect(colorSubmenu(hook)).toBeNull();
        await hook.unmount();
    });
});
