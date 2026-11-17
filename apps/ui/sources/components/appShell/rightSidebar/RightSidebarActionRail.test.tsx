import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { withTiming } from 'react-native-reanimated';

import { renderScreen } from '@/dev/testkit';
import { RightSidebarActionRail, RightSidebarActionRailView, type RightSidebarRailAction } from './RightSidebarActionRail';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import type { NavigationPlacementPreferences } from '@/sync/domains/settings/navigationPlacement';
import { PaneActionRailContext } from '@/components/appShell/panes/PaneActionRailContext';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { storage } from '@/sync/domains/state/storage';
import type { AppRailBadgeSignal } from '@/components/navigation/shell/appRail/AppRailBadge';
import type { CustomModalShowConfig } from '@/modal';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const initialStorageState = storage.getState();
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

// Native animation is the boundary: keep real placement/presence logic and hold completion.
vi.mock('react-native-reanimated', async () => {
    const mock = (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock();
    return { ...mock, withTiming: vi.fn(mock.withTiming) };
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => `en:${key}` });
});

const { NavigationPlacementCustomizer } = await import('@/components/ui/navigation/NavigationPlacementCustomizer');

describe('a rail with nothing standing on it', () => {
    const tab = (overrides: Partial<RightSidebarRailAction> = {}): RightSidebarRailAction => ({
        id: 'inspector', label: 'Inspector', icon: 'folder', active: false, defaultPlacement: 'overflow', onPress: () => {}, ...overrides,
    });
    const preferences: NavigationPlacementPreferences = { orderedIds: [], placements: {} };
    async function reports(actions: readonly RightSidebarRailAction[]) {
        const onVacantChange = vi.fn();
        await renderScreen(
            <PaneActionRailContext.Provider value={{ visible: true, contentWidthPx: 1000, onVacantChange }}>
                <RightSidebarActionRailView surfaceId="workspaceRail" testIDPrefix="rail" actions={actions}
                    preferences={preferences} onCustomize={() => {}} />
            </PaneActionRailContext.Provider>,
        );
        return onVacantChange.mock.lastCall?.[0];
    }

    it('reports itself vacant when every action rests in More', async () => {
        expect(await reports([tab()])).toBe(true);
    });

    it('stands while an action is pinned, while its panel is open, and while More carries a signal', async () => {
        expect(await reports([tab({ defaultPlacement: 'pinned' })])).toBe(false);
        expect(await reports([tab({ active: true })])).toBe(false);
        expect(await reports([tab({ badgeCount: 3 })])).toBe(false);
    });
});

describe('Automatic rail content motion', () => {
    const automatic = (hasContent: boolean | null | undefined): RightSidebarRailAction => ({
        id: 'habits', label: 'Habits', icon: 'folder', active: false, defaultPlacement: 'auto', hasContent, onPress: () => {},
    });
    const preferences: NavigationPlacementPreferences = { orderedIds: [], placements: {} };
    const rail = (hasContent: boolean | null | undefined, placement = preferences, actions = [automatic(hasContent)]) =>
        <RightSidebarActionRailView surfaceId="sessionRail" testIDPrefix="rail" actions={actions}
            preferences={placement} onCustomize={() => {}} />;
    beforeEach(() => {
        setReducedMotionPreferenceOverride(false);
        vi.mocked(withTiming).mockClear();
    });
    afterEach(() => setReducedMotionPreferenceOverride(null));

    it('enters on known false→true and exits on known true→false, completing at the animation boundary', async () => {
        const screen = await renderScreen(rail(false));
        expect(screen.findByTestId('rail:habits')).toBeNull();
        expect(withTiming).not.toHaveBeenCalled();
        await screen.update(rail(true));
        expect(screen.findByTestId('rail:habits')).not.toBeNull();
        expect(vi.mocked(withTiming).mock.calls.map(call => call[0])).toEqual([1]);
        vi.mocked(withTiming).mockClear();
        await screen.update(rail(false));
        expect(screen.findByTestId('rail:habits')).toBeNull();
        expect(screen.findByTestId('rail:leaving:habits')).not.toBeNull();
        expect(vi.mocked(withTiming).mock.calls.map(call => call[0])).toEqual([0]);
        await act(async () => { vi.mocked(withTiming).mock.calls[0]![2]?.(true); });
        expect(screen.findByTestId('rail:leaving:habits')).toBeNull();
    });

    it.each([true, false])('stays still on unknown→%s hydration and on known→unknown', async (known) => {
        const screen = await renderScreen(rail(null));
        await screen.update(rail(known));
        expect(screen.findByTestId('rail:habits') !== null).toBe(known);
        await screen.update(rail(undefined));
        expect(screen.findByTestId('rail:habits')).toBeNull();
        expect(screen.findByTestId('rail:leaving:habits')).toBeNull();
        expect(withTiming).not.toHaveBeenCalled();
    });

    it('stays still when fit removes and restores a content-bearing Automatic action', async () => {
        const screen = await renderScreen(rail(true));
        const measure = async (height: number) => act(async () => {
            screen.findByTestId('right-sidebar-action-rail')!.props.onLayout({ nativeEvent: { layout: { height } } });
        });
        await measure(40);
        expect(screen.findByTestId('rail:habits')).toBeNull();
        expect(screen.findByTestId('rail:leaving:habits')).toBeNull();
        await measure(200);
        expect(screen.findByTestId('rail:habits')).not.toBeNull();
        expect(withTiming).not.toHaveBeenCalled();
    });

    it.each(['overflow', 'hidden'] as const)('stays still on explicit %s placement and reset', async (placement) => {
        const screen = await renderScreen(rail(true));
        await screen.update(rail(true, { orderedIds: [], placements: { habits: placement } }));
        expect(screen.findByTestId('rail:habits')).toBeNull();
        expect(screen.findByTestId('rail:leaving:habits')).toBeNull();
        await screen.update(rail(true));
        expect(screen.findByTestId('rail:habits')).not.toBeNull();
        expect(withTiming).not.toHaveBeenCalled();
    });

    it('does not reuse a removed catalog entry as a known content transition', async () => {
        const screen = await renderScreen(rail(false));
        await screen.update(rail(false, preferences, []));
        await screen.update(rail(true));
        expect(screen.findByTestId('rail:habits')).not.toBeNull();
        await screen.update(rail(true, preferences, []));
        expect(screen.findByTestId('rail:leaving:habits')).toBeNull();
        expect(withTiming).not.toHaveBeenCalled();
    });

    it('applies both known content transitions immediately with Reduced Motion', async () => {
        setReducedMotionPreferenceOverride(true);
        const screen = await renderScreen(rail(false));
        await screen.update(rail(true));
        expect(screen.findByTestId('rail:habits')).not.toBeNull();
        await screen.update(rail(false));
        expect(screen.findByTestId('rail:habits')).toBeNull();
        expect(screen.findByTestId('rail:leaving:habits')).toBeNull();
        expect(withTiming).not.toHaveBeenCalled();
    });
});

describe('RightSidebarActionRail', () => {
    beforeEach(() => storage.setState(initialStorageState, true));
    afterEach(() => storage.setState(initialStorageState, true));

    it('keeps an overflowed Work count on the More trigger', async () => {
        const screen = await renderScreen(<RightSidebarActionRail surfaceId="sessionRail" testIDPrefix="rail" actions={[
            { id: 'work', label: 'Work', icon: 'folder', active: false, defaultPlacement: 'overflow', badgeCount: 3, onPress: () => {} },
        ]} />);
        expect(screen.findByTestId('rail:work')).toBeNull();
        expect(screen.findByTestId('rail:more:badge')).not.toBeNull();
        expect(screen.findByTestId('rail:more')!.props.accessibilityLabel).toBe('en:common.more 3');
    });

    it('gives each overflow row its own trailing count or detail and separates the rail groups (lab csrail R1)', async () => {
        const actions: RightSidebarRailAction[] = [
            { id: 'services', label: 'Services', icon: 'folder', active: false, defaultPlacement: 'overflow', group: 'session',
                onPress: () => {}, renderBadgeSignal: (renderSignal) => renderSignal({ kind: 'count', value: 3, tone: 'neutral' }) },
            { id: 'computer', label: 'Computer', icon: 'desktop', active: false, defaultPlacement: 'overflow', group: 'machine',
                detail: 'MacBook Pro', onPress: () => {} },
        ];
        const screen = await renderScreen(<RightSidebarActionRail surfaceId="sessionRail" testIDPrefix="rail" actions={actions} />);
        const menu = screen.tree.findByType(DropdownMenu);
        expect(menu.props.separateCategories).toBe(true);
        const items = menu.props.items as ReadonlyArray<{ id: string; rightElement?: React.ReactElement }>;
        const services = await renderScreen(<>{items.find(item => item.id === 'services')!.rightElement}</>);
        expect(services.tree.findAllByType(TabBadge).map(node => node.props.value)).toEqual([3]);
        const computer = await renderScreen(<>{items.find(item => item.id === 'computer')!.rightElement}</>);
        expect(computer.getTextContent()).toContain('MacBook Pro');
    });

    it('lets the strongest admitted overflow signal win without summing unrelated counts', async () => {
        const actions = [
            { id: 'work', label: 'Work', icon: 'folder' as const, active: false, defaultPlacement: 'overflow' as const,
                badgeCount: 3, onPress: () => {} },
            { id: 'terminal', label: 'Terminal', icon: 'terminal' as const, active: false, defaultPlacement: 'overflow' as const,
                onPress: () => {}, renderBadgeSignal: (renderSignal: (signal: AppRailBadgeSignal | null) => React.ReactNode) =>
                    renderSignal({ kind: 'dot', tone: 'attention' }) },
        ];
        const screen = await renderScreen(<RightSidebarActionRail surfaceId="sessionRail" testIDPrefix="rail" actions={actions} />);
        const badge = screen.tree.findAllByType(TabBadge).find((node) => node.props.testID === 'rail:more:badge');
        expect(badge?.props).toMatchObject({ variant: 'dot', tone: 'attention' });
    });

    it('reuses the real controls in a static preview without mounting domain badges or invoking live actions', async () => {
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.show).mockClear();
        const pressed = vi.fn();
        const domainBadge = vi.fn(() => null);
        const DomainBadge = domainBadge;
        const screen = await renderScreen(<RightSidebarActionRail surfaceId="sessionRail" testIDPrefix="rail" actions={[
            { id: 'git', label: 'Git', icon: 'folder', active: false, onPress: pressed,
                badge: <DomainBadge />, tooltipContent: <DomainBadge /> },
        ]} />);
        await act(async () => { screen.findByTestId('rail:git')!.props.onLongPress(); });
        await vi.waitFor(() => expect(Modal.show).toHaveBeenCalled());
        // The modal adapter is the system boundary; keep its real controlled preview beneath it.
        const config = vi.mocked(Modal.show).mock.calls.at(-1)![0] as CustomModalShowConfig<typeof NavigationPlacementCustomizer>;
        const renderPreview = config.props?.renderPreview;
        if (!renderPreview) throw new Error('Expected the rail placement preview');
        domainBadge.mockClear();
        const preview = await renderScreen(<>{renderPreview({ orderedIds: [], placements: {} })}</>);
        expect(domainBadge).not.toHaveBeenCalled();
        await act(async () => { preview.findByTestId('rail:git')!.props.onPress(); });
        expect(pressed).not.toHaveBeenCalled();
    });

    it('uses shared ordering and placements, overflowing only after the measured rail no longer fits', async () => {
        storage.getState().applyLocalSettings({ navigationSurfacePlacementsV1: { sessionRail: {
            orderedIds: ['plugin:acme.review:panel', 'git', 'files', 'hidden'],
            placements: { hidden: 'hidden', files: 'overflow' },
        } } }, { persist: false });
        const screen = await renderScreen(<RightSidebarActionRail surfaceId="sessionRail" testIDPrefix="rail" actions={[
            ...['git', 'files', 'hidden', 'plugin:acme.review:panel'].map((id) => ({
                id, label: id, icon: 'folder' as const, active: false, onPress: () => {},
            })),
        ]} />);
        const menu = screen.tree.findByType(DropdownMenu);
        expect(menu.props.items.map((item: { id: string }) => item.id)).toEqual(['files', 'customize']);
        const measure = async (height: number) => {
            await act(async () => { screen.findByTestId('right-sidebar-action-rail')!.props.onLayout({ nativeEvent: { layout: { height } } }); });
        };
        await measure(200);
        expect(screen.findByTestId('rail:plugin:acme.review:panel')).toBeTruthy();
        expect(screen.findByTestId('rail:git')).toBeTruthy();
        expect(screen.findByTestId('rail:files')).toBeNull();
        expect(screen.findByTestId('rail:hidden')).toBeNull();
        await measure(88);
        expect(screen.findByTestId('rail:plugin:acme.review:panel')).toBeTruthy();
        expect(screen.findByTestId('rail:git')).toBeNull();
        expect(screen.findByTestId('rail:more')).toBeTruthy();
        expect(screen.tree.findByType(DropdownMenu).props.items.map((item: { id: string }) => item.id)).toEqual(['git', 'files', 'customize']);
    });

    it('keeps every pinned action visible when the measured height fits them without a More slot', async () => {
        const screen = await renderScreen(<RightSidebarActionRail surfaceId="workspaceRail" testIDPrefix="rail" actions={
            ['one', 'two', 'three'].map((id) => ({ id, label: id, icon: 'folder' as const, active: false, onPress: () => {} }))
        } />);
        await act(async () => { screen.findByTestId('right-sidebar-action-rail')!.props.onLayout({ nativeEvent: { layout: { height: 128 } } }); });
        expect(screen.findByTestId('rail:three')).toBeTruthy();
        expect(screen.findByTestId('rail:more')).toBeNull();
    });

    it('offers long-press and context customization after every action is hidden, retaining those actions in its catalog', async () => {
        storage.getState().applyLocalSettings({ navigationSurfacePlacementsV1: { sessionRail: { orderedIds: [], placements: { git: 'hidden' } } } }, { persist: false });
        const { Modal } = await import('@/modal');
        const screen = await renderScreen(<RightSidebarActionRail surfaceId="sessionRail" testIDPrefix="rail" actions={[
            { id: 'git', label: 'Git', icon: 'folder', active: false, onPress: () => {} },
        ]} />);
        expect(screen.findByTestId('rail:git')).toBeNull();
        expect(screen.findByTestId('rail:more')).toBeTruthy();
        await act(async () => { await screen.findByTestId('rail:more')!.props.onLongPress(); });
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({
            surfaceId: 'sessionRail', items: [expect.objectContaining({ id: 'git' })],
        }) }));
        vi.mocked(Modal.show).mockClear();
        const preventDefault = vi.fn();
        await act(async () => { screen.findByTestId('right-sidebar-action-rail')!.props.onContextMenu({ preventDefault }); });
        expect(preventDefault).toHaveBeenCalled();
        expect(Modal.show).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({ surfaceId: 'sessionRail' }) }));
    });
    it('selects the open action as the app rail does, standing on one canvas coat with no tab or edge marker', async () => {
        const actions = [
            { id: 'info', label: 'Info', icon: 'info' as const, active: true, onPress: () => {} },
            { id: 'files', label: 'Files', icon: 'folder' as const, active: false, onPress: () => {} },
        ];
        const screen = await renderScreen(<PaneActionRailContext.Provider value={{ visible: true, contentWidthPx: 1200, onCanvas: true }}>
            <RightSidebarActionRail surfaceId="sessionRail" testIDPrefix="rail" actions={actions} />
        </PaneActionRailContext.Provider>);
        // The app rail's selection: the translucent square drawn on the open action's surface, and on no other.
        const selectedOf = (id: string) => Boolean(Object.assign({}, ...[screen.findByTestId(`rail:${id}-surface`)!.props.style]
            .flat(Infinity).filter(Boolean)).backgroundColor);
        expect([selectedOf('info'), selectedOf('files')]).toEqual([true, false]);
        // No shape joins the open panel's sheet (a glass-on-glass join seams) and no 0.2 edge line.
        expect(screen.findAll(node => typeof node.props.testID === 'string' && /^rail:info:(tab|marker)/.test(node.props.testID))).toHaveLength(0);
        const coats = screen.findAll(node => typeof node.props.testID === 'string'
            && node.props.testID.startsWith('rail:canvas') && node.props.surfaceGroup !== undefined);
        expect(coats.map(node => [node.props.testID, node.props.surfaceGroup, node.props.plane])).toEqual([['rail:canvas', 'chrome', true]]);
    });

    it('separates the code, session and machine groups with one hairline each, keeping the given order', async () => {
        const action = (id: string, group: string) => ({
            id, group, label: id, icon: 'folder' as const, active: false, onPress: () => {},
        });
        const screen = await renderScreen(
            <RightSidebarActionRail
                surfaceId="sessionRail"
                testIDPrefix="rail"
                actions={[
                    action('git', 'code'), action('review', 'code'), action('files', 'code'),
                    action('agents', 'session'), action('navigation', 'session'),
                    action('services', 'machine'), action('terminal', 'machine'),
                ]}
            />,
        );

        const order = screen.findAll((node) => typeof node.type === 'string'
            && typeof node.props.testID === 'string'
            && /^rail:(git|review|files|agents|navigation|services|terminal|separator:\w+)$/.test(node.props.testID))
            .map((node) => node.props.testID as string)
            .filter((id, index, all) => all.indexOf(id) === index);
        expect(order).toEqual([
            'rail:git', 'rail:review', 'rail:files',
            'rail:separator:session',
            'rail:agents', 'rail:navigation',
            'rail:separator:machine',
            'rail:services', 'rail:terminal',
        ]);
    });
});
