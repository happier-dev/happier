import * as React from 'react';
import { Pressable } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, pressTestInstance, renderScreen, withPopoverWebGlobals } from '@/dev/testkit';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';

import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks();

// The menu is exercised through the real shared DropdownMenu / SelectableRow path; only platform
// boundaries are mocked (by the common helper above).
const { PageHeaderMenu } = await import('@/components/ui/layout/PageHeaderEntityParts');
const { SelectableRow } = await import('@/components/ui/lists/SelectableRow');
const { ActivitySpinner } = await import('@/components/ui/feedback/ActivitySpinner');
const { OverlayPortalProvider, OverlayPortalHost } = await import('@/components/ui/popover/OverlayPortal');

// Layout is the platform boundary here: every host node reports a window rect so the popover can anchor.
const measuredHostNodes = {
    createNodeMock: () => ({
        offsetTop: 0,
        offsetHeight: 32,
        measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(900, 40, 32, 32),
        measure: (callback: (x: number, y: number, width: number, height: number, pageX: number, pageY: number) => void) => callback(0, 0, 32, 32, 900, 40),
    }),
};

async function openMenu(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const trigger = screen.findAllByType(Pressable).find((node) => node.props.testID === 'entity-menu.trigger') ?? null;
    expect(trigger, 'menu trigger').not.toBeNull();
    await act(async () => {
        pressTestInstance(trigger, 'entity menu trigger');
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
}

function findRow(screen: Awaited<ReturnType<typeof renderScreen>>, title: string) {
    return screen.findAllByType(SelectableRow as never)
        .find((node) => node.props.title === title) ?? null;
}

describe('PageHeaderMenu', () => {
    let restoreGlobals: (() => void) | null = null;
    beforeEach(() => {
        restoreGlobals = withPopoverWebGlobals();
    });
    afterEach(() => {
        restoreGlobals?.();
        restoreGlobals = null;
    });

    it('shows a destructive operation in the danger tone and an operation in progress as busy and unavailable', async () => {
        const onDelete = vi.fn();
        const onClear = vi.fn();
        const screen = await renderScreen(
            <OverlayPortalProvider>
            <PageHeaderMenu
                testID="entity-menu"
                actions={[
                    { id: 'duplicate', title: 'Duplicate', onSelect: () => {} },
                    { id: 'clear', title: 'Clear history', loading: true, destructive: true, onSelect: onClear },
                    { id: 'delete', title: 'Delete', destructive: true, onSelect: onDelete },
                ]}
            />
            <OverlayPortalHost />
            </OverlayPortalProvider>,
            measuredHostNodes,
        );

        await openMenu(screen);

        const danger = createThemeFixture().colors.state.danger.foreground;
        const deleteRow = findRow(screen, 'Delete');
        const duplicateRow = findRow(screen, 'Duplicate');
        const clearRow = findRow(screen, 'Clear history');
        expect(deleteRow, 'Delete row').not.toBeNull();
        expect(duplicateRow, 'Duplicate row').not.toBeNull();
        expect(clearRow, 'Clear row').not.toBeNull();

        expect(flattenTestStyle(deleteRow!.props.titleStyle).color).toBe(danger);
        expect(flattenTestStyle(duplicateRow!.props.titleStyle).color).not.toBe(danger);
        expect(deleteRow!.props.disabled).not.toBe(true);

        // In progress: the row cannot be chosen again and says it is working.
        expect(clearRow!.props.disabled).toBe(true);
        expect(clearRow!.findAllByType(ActivitySpinner)).toHaveLength(1);
        expect(deleteRow!.findAllByType(ActivitySpinner)).toHaveLength(0);
    });

    it('opens with no row looking chosen: a menu of operations has no current choice (DESIGN-9 N46)', async () => {
        const screen = await renderScreen(
            <OverlayPortalProvider>
            <PageHeaderMenu
                testID="entity-menu"
                actions={[
                    { id: 'discard', title: 'Discard', destructive: true, onSelect: () => {} },
                    { id: 'export', title: 'Export JSON', onSelect: () => {} },
                ]}
            />
            <OverlayPortalHost />
            </OverlayPortalProvider>,
            measuredHostNodes,
        );
        await openMenu(screen);
        const rows = ['Discard', 'Export JSON'].map((title) => findRow(screen, title));
        expect(rows.every((row) => row !== null)).toBe(true);
        expect(rows.map((row) => row!.props.selected === true)).toEqual([false, false]);
    });
});

describe('PageHeaderMenu: reached from search', () => {
    let restoreGlobals: (() => void) | null = null;
    beforeEach(() => {
        restoreGlobals = withPopoverWebGlobals();
    });
    afterEach(() => {
        restoreGlobals?.();
        restoreGlobals = null;
    });

    it('opens itself when search asks for one of its entries, and stays closed otherwise', async () => {
        const render = (openRequested: boolean) => (
            <OverlayPortalProvider>
            <PageHeaderMenu
                testID="entity-menu"
                openRequested={openRequested}
                actions={[{ id: 'create', title: 'Create a Personal Home', onSelect: () => {} }]}
            />
            <OverlayPortalHost />
            </OverlayPortalProvider>
        );
        const closed = await renderScreen(render(false), measuredHostNodes);
        await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
        expect(findRow(closed, 'Create a Personal Home')).toBeNull();
        await closed.unmount();

        const requested = await renderScreen(render(true), measuredHostNodes);
        await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
        expect(findRow(requested, 'Create a Personal Home')).not.toBeNull();
        await requested.unmount();
    });
});

describe('PageHeaderStateSwitch', () => {
    it('names the state it controls and, while a change saves, keeps its value but cannot be flipped again', async () => {
        const { PageHeaderStateSwitch } = await import('@/components/ui/layout/PageHeaderEntityParts');
        const onValueChange = vi.fn();
        const render = (busy: boolean) => (
            <PageHeaderStateSwitch testID="entity.enabled" label="Active" value={true} busy={busy} onValueChange={onValueChange} />
        );
        const screen = await renderScreen(render(false));
        const control = () => screen.findAll((node) => node.props.testID === 'entity.enabled' && node.props.accessibilityLabel !== undefined).at(-1)!;
        expect(control().props.accessibilityLabel).toBe('Active');
        expect(control().props.disabled).toBe(false);

        await screen.update(render(true));
        expect(control().props.value).toBe(true);
        expect(control().props.disabled).toBe(true);
        expect(control().props.accessibilityState).toMatchObject({ disabled: true, busy: true });
    });
});
