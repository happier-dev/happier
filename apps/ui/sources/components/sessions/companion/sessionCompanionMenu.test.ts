import { describe, expect, it, vi } from 'vitest';

import { t } from '@/text';

import {
    buildSessionCompanionItemActions,
    buildSessionCompanionMenuActions,
} from './sessionCompanionMenu';
import {
    HIDDEN_SESSION_COMPANION_PREFERENCE_V1,
    SESSION_SUMMARY_COMPANION_ITEM,
    type SessionCompanionPreferenceV1,
} from './state/sessionCompanionPreference';

const shown: SessionCompanionPreferenceV1 = {
    ...HIDDEN_SESSION_COMPANION_PREFERENCE_V1,
    visible: true,
    items: [SESSION_SUMMARY_COMPANION_ITEM],
};

function menu(overrides: Parameters<typeof buildSessionCompanionMenuActions>[0] | null = null) {
    return buildSessionCompanionMenuActions({
        preference: shown,
        setEdge: () => {},
        setDensity: () => {},
        setCollapsed: () => {},
        hide: () => {},
        ...(overrides ?? {}),
    });
}

const ids = (actions: readonly { id: string }[]) => actions.map((action) => action.id);

describe('buildSessionCompanionMenuActions', () => {
    it('exposes every controller operation the person can actually perform', () => {
        expect(ids(menu())).toEqual([
            'edge-leading',
            'edge-trailing',
            'density-compact',
            'density-comfortable',
            'collapse',
            'hide',
        ]);
    });

    it('marks the applied edge and density as selected rather than disabled', () => {
        const actions = menu();

        expect(actions.find((action) => action.id === 'edge-trailing')?.selected).toBe(true);
        expect(actions.find((action) => action.id === 'edge-trailing')?.disabled).toBeUndefined();
        expect(actions.find((action) => action.id === 'density-compact')?.selected).toBe(true);
    });

    it('names and icons logical edges by their physical side in RTL', () => {
        const actions = menu({ ...menuBase(), layoutDirection: 'rtl' });
        const leading = actions.find((action) => action.id === 'edge-leading');
        const trailing = actions.find((action) => action.id === 'edge-trailing');

        expect(leading).toEqual(expect.objectContaining({
            title: t('sessionBoard.companion.actions.moveToTrailing'),
            icon: 'arrow-right',
        }));
        expect(trailing).toEqual(expect.objectContaining({
            title: t('sessionBoard.companion.actions.moveToLeading'),
            icon: 'arrow-left',
        }));
    });

    it('offers Open full only when a real navigation handler exists', () => {
        expect(ids(menu())).not.toContain('open-full');
        expect(ids(menu({ ...menuBase(), openFullSurface: () => {} }))).toContain('open-full');
    });

    it('offers Expand instead of Collapse for a collapsed Companion', () => {
        const actions = menu({ ...menuBase(), preference: { ...shown, collapsed: true } });

        expect(ids(actions)).toContain('expand');
        expect(ids(actions)).not.toContain('collapse');
    });

    it('holds only layout choices: adding lives in the one Add to Companion picker', () => {
        const actions = menu({ ...menuBase(), preference: { ...shown, items: [] } });

        expect(ids(actions).some((id) => id.startsWith('add'))).toBe(false);
    });
});

function menuBase() {
    return {
        preference: shown,
        setEdge: () => {},
        setDensity: () => {},
        setCollapsed: () => {},
        hide: () => {},
    };
}

describe('buildSessionCompanionItemActions', () => {
    it('hides reorder controls that would do nothing', () => {
        const single = buildSessionCompanionItemActions({
            index: 0,
            count: 1,
            moveTo: () => {},
            remove: () => {},
        });

        expect(ids(single)).toEqual(['remove']);
    });

    it('offers both directions for a middle item and one for an edge item', () => {
        const middle = buildSessionCompanionItemActions({
            index: 1,
            count: 3,
            moveTo: () => {},
            remove: () => {},
        });
        const first = buildSessionCompanionItemActions({
            index: 0,
            count: 3,
            moveTo: () => {},
            remove: () => {},
        });

        expect(ids(middle)).toEqual(['move-up', 'move-down', 'remove']);
        // At the end of a three-item list, "move to last" is a two-position jump that
        // "move down" cannot make, so it is reach rather than noise.
        expect(ids(first)).toEqual(['move-down', 'move-last', 'remove']);
    });

    it('adds first/last jumps only once they differ from a single step', () => {
        const threeItems = buildSessionCompanionItemActions({
            index: 1, count: 3, moveTo: () => {}, remove: () => {},
        });
        const middleOfFive = buildSessionCompanionItemActions({
            index: 2, count: 5, moveTo: () => {}, remove: () => {},
        });

        expect(ids(threeItems)).toEqual(['move-up', 'move-down', 'remove']);
        expect(ids(middleOfFive)).toEqual(['move-up', 'move-down', 'move-first', 'move-last', 'remove']);
        // Each end of a three-item list gets exactly the one jump that is distinct.
        expect(ids(buildSessionCompanionItemActions({
            index: 0, count: 3, moveTo: () => {}, remove: () => {},
        }))).toEqual(['move-down', 'move-last', 'remove']);
        expect(ids(buildSessionCompanionItemActions({
            index: 2, count: 3, moveTo: () => {}, remove: () => {},
        }))).toEqual(['move-up', 'move-first', 'remove']);
    });

    it('jumps to the exact end index through the controller', () => {
        const moveTo = vi.fn();
        const actions = buildSessionCompanionItemActions({
            index: 2, count: 5, moveTo, remove: () => {},
        });

        actions.find((action) => action.id === 'move-first')?.onPress?.();
        expect(moveTo).toHaveBeenLastCalledWith(0);
        actions.find((action) => action.id === 'move-last')?.onPress?.();
        expect(moveTo).toHaveBeenLastCalledWith(4);
    });

    it('moves by index through the controller rather than mutating a list itself', () => {
        const moveTo = vi.fn();
        buildSessionCompanionItemActions({ index: 2, count: 3, moveTo, remove: () => {} })
            .find((action) => action.id === 'move-up')?.onPress?.();

        expect(moveTo).toHaveBeenCalledWith(1);
    });

    it('steps past sections that draw nothing, so Move up and Move down always change what is seen', () => {
        // Summary, Environment, Running (nothing running), Usage (no usage), Links.
        const drawn = new Set([0, 1, 4]);
        const moveTo = vi.fn();
        const links = buildSessionCompanionItemActions({ index: 4, count: 5, moveTo, remove: () => {}, isPresented: index => drawn.has(index) });
        links.find((action) => action.id === 'move-up')?.onPress?.();
        expect(moveTo).toHaveBeenLastCalledWith(1);
        const environment = buildSessionCompanionItemActions({ index: 1, count: 5, moveTo, remove: () => {}, isPresented: index => drawn.has(index) });
        environment.find((action) => action.id === 'move-down')?.onPress?.();
        expect(moveTo).toHaveBeenLastCalledWith(4);
    });

    it('offers Open on Board only when the Board is currently reachable', () => {
        expect(ids(buildSessionCompanionItemActions({
            index: 0, count: 1, moveTo: () => {}, remove: () => {},
        }))).not.toContain('open-board');
        expect(ids(buildSessionCompanionItemActions({
            index: 0, count: 1, moveTo: () => {}, remove: () => {}, openOnBoard: () => {},
        }))).toContain('open-board');
    });

    it('offers Manage plugin as recovery for a plugin widget, never Board deletion', () => {
        const actions = buildSessionCompanionItemActions({
            index: 0, count: 1, moveTo: () => {}, remove: () => {}, managePlugin: () => {},
        });
        expect(ids(actions)).toEqual(['manage-plugin', 'remove']);
    });

    it('never marks local removal destructive: the shared record survives', () => {
        const remove = buildSessionCompanionItemActions({
            index: 0, count: 1, moveTo: () => {}, remove: () => {},
        }).find((action) => action.id === 'remove');

        expect(remove?.destructive).not.toBe(true);
    });
});
