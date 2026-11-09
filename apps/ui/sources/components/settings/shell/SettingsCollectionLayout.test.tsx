import * as React from 'react';
import { View } from 'react-native';
import { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const windowState = vi.hoisted(() => ({ fontScale: 1, width: 1200, height: 800 }));

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Dimensions: {
                get: () => ({ width: windowState.width, height: windowState.height, scale: 1, fontScale: windowState.fontScale }),
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ pathname: '/settings/machines/machine-1' }).module;
    },
});

const { HorizontalSafeAreaProvider } = await import('@/components/navigation/safeArea/HorizontalSafeArea');
const { SettingsCollectionLayout } = await import('./SettingsCollectionLayout');
const { SettingsFloatingControlsHost } = await import('./SettingsModalFloatingControls');
const { COLLECTION_RAIL_MIN_WIDTH_PX, useHappierCollectionLayout } = await import('@happier-dev/plugin-ui/presentation');
const { HAPPIER_COLLECTION_RAIL_WIDTH_PX } = await import('@happier-dev/plugin-ui/advanced');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { AppShellTailContext, useAppShellTail } = await import('@/components/navigation/shell/appShellTail');

const modeSeen: Array<string | null> = [];
const detailMounts = { count: 0 };

function DetailProbe() {
    const mode = useHappierCollectionLayout()?.mode ?? null;
    modeSeen.push(mode);
    React.useEffect(() => {
        detailMounts.count += 1;
    }, []);
    return React.createElement('DetailProbe', { mode });
}

async function renderCollection() {
    return renderScreen(
        <SettingsCollectionLayout
            navigator="machines"
            rootPathname="/settings/machines"
            resolveChildRoute={() => '[id]'}
            rail={<View testID="machines-rail" />}
            railWidth="standard"
            detailMinWidthPx={480}
            testID="settings-machines"
            detailTop={<DetailProbe />}
        />,
    );
}

function hostByTestID(screen: Awaited<ReturnType<typeof renderCollection>>, testID: string): ReactTestInstance | null {
    return screen.root.findAll((node) => typeof node.type === 'string' && node.props.testID === testID)[0] ?? null;
}

async function layoutAt(screen: Awaited<ReturnType<typeof renderCollection>>, width: number) {
    const container = hostByTestID(screen, 'settings-machines-layout');
    if (!container) throw new Error('Missing collection layout');
    await act(async () => {
        (container.props.onLayout as (event: unknown) => void)({ nativeEvent: { layout: { width, height: 800, x: 0, y: 0 } } });
    });
}

function currentMode(screen: Awaited<ReturnType<typeof renderCollection>>): unknown {
    return screen.root.findAllByType('DetailProbe' as never)[0]?.props.mode;
}

describe('SettingsCollectionLayout', () => {
    it.each(['band', 'wallpaper'] as const)('inherits the page reading coat over a %s without hiding it behind collection paint', async (atmosphereBehind) => {
        const { GlassSurface } = await import('@/components/ui/glass/GlassSurface');
        const { GlassRuntimeEnvironmentProvider } = await import('@/components/ui/glass/glassRuntimeEnvironment');
        const { GlassMaterialSettingsProvider } = await import('@/components/ui/glass/useGlassMaterialSettings');
        const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
        const scene = (backing: 'band' | 'wallpaper' | 'none') => <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('everywhere') }}>
            <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: backing }}>
                <GlassSurface plane surfaceGroup="content" atmosphereCoat={backing === 'none' ? undefined : 'reading'}>
                    <SettingsCollectionLayout navigator="machines" rootPathname="/settings/machines"
                        resolveChildRoute={() => '[id]'} rail={<View />} railWidth="standard"
                        detailMinWidthPx={480} testID="settings-machines" detailTop={<DetailProbe />} />
                </GlassSurface>
            </GlassRuntimeEnvironmentProvider>
        </GlassMaterialSettingsProvider>;
        const screen = await renderScreen(scene(atmosphereBehind));
        const collectionGround = () => {
            let node = screen.findHostByTestId('settings-machines-layout')?.parent;
            while (node && typeof node.type !== 'string') node = node.parent;
            // Web binds this paint to the containing surface's plane variable, which that surface clears over a backing.
            expect(flattenTestStyle(node?.props.style).backgroundColor).toContain('var(--happier-glass-content-plane-background-color,');
            while (node && flattenTestStyle(node.props.style)['--happier-glass-content-plane-background-color'] === undefined) node = node.parent;
            return flattenTestStyle(node?.props.style)['--happier-glass-content-plane-background-color'];
        };
        expect(collectionGround()).toBe('transparent');
        const mounted = detailMounts.count;
        await screen.update(scene('none'));
        expect(collectionGround()).not.toBe('transparent');
        expect(detailMounts.count).toBe(mounted);
    });
    beforeEach(() => {
        windowState.fontScale = 1;
        windowState.width = 1200;
        windowState.height = 800;
        getStorage().getState().applyLocalSettings({ collectionRailWidthsV1: {} });
    });

    it('keeps intrinsic collection chrome safe while the surrounding planes reach the window edge', async () => {
        const screen = await renderScreen(<HorizontalSafeAreaProvider value={{ left: 16, right: 84, padded: false }}>
            <SettingsCollectionLayout navigator="machines" rootPathname="/settings/machines"
                resolveChildRoute={() => '[id]'} rail={<View />} railWidth="standard"
                detailMinWidthPx={480} testID="settings-machines"
                detailTop={<View testID="collection-detail-notice" />} />
        </HorizontalSafeAreaProvider>);
        await layoutAt(screen, 1200);
        const paddingAt = (testID: string) => {
            const insets = { left: 0, right: 0 };
            for (let node: ReactTestInstance | null = screen.findHostByTestId(testID); node; node = node.parent) {
                if (typeof node.type !== 'string') continue;
                const style = flattenTestStyle(node.props.style);
                if (typeof style.paddingLeft === 'number') insets.left += style.paddingLeft;
                if (typeof style.paddingRight === 'number') insets.right += style.paddingRight;
            }
            return insets;
        };
        expect(paddingAt('collection-detail-notice')).toEqual({ left: 0, right: 84 });
    });

    it('restores each navigator width and keeps the preference when a narrow pane temporarily clamps it', async () => {
        getStorage().getState().applyLocalSettings({ collectionRailWidthsV1: { machines: 380, teams: 310 } });
        const screen = await renderCollection();
        const railWidth = () => screen.findHostByTestId('settings-machines-layout-resize-handle')?.props['aria-valuenow'];
        await layoutAt(screen, 1200);
        expect(railWidth()).toBeCloseTo(380);
        await layoutAt(screen, 780);
        expect(railWidth()).toBeCloseTo(300);
        expect(getStorage().getState().localSettings.collectionRailWidthsV1.machines).toBe(380);
        await layoutAt(screen, 1200);
        expect(railWidth()).toBeCloseTo(380);
        await screen.update(<SettingsCollectionLayout navigator="teams" rootPathname="/settings/teams"
            resolveChildRoute={() => 'index'} rail={<View />} railWidth="standard" detailMinWidthPx={480}
            testID="settings-machines" />);
        await layoutAt(screen, 1200);
        expect(railWidth()).toBeCloseTo(310);
    });

    it('persists a divider adjustment and resets the navigator to its role default through the same handle', async () => {
        getStorage().getState().applyLocalSettings({ collectionRailWidthsV1: { machines: 350, teams: 310 } });
        const dividerTarget = new EventTarget();
        const screen = await renderScreen(
            <SettingsCollectionLayout navigator="machines" rootPathname="/settings/machines"
                resolveChildRoute={() => '[id]'} rail={<View />} railWidth="standard" detailMinWidthPx={480}
                testID="settings-machines" />,
            // The platform ref is the real event boundary the shared handle listens on.
            { createNodeMock: (element) => element.props.testID === 'settings-machines-layout-resize-handle' ? dividerTarget : null },
        );
        await layoutAt(screen, 1200);
        const handle = () => screen.findHostByTestId('settings-machines-layout-resize-handle');
        expect(handle()?.props['aria-valuenow']).toBe(350);
        await act(async () => handle()!.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }));
        const adjusted = handle()!.props['aria-valuenow'];
        expect(adjusted).toBeGreaterThan(350);
        expect(getStorage().getState().localSettings.collectionRailWidthsV1.machines).toBe(adjusted);
        await act(async () => { dividerTarget.dispatchEvent(new Event('dblclick')); });
        expect(handle()?.props['aria-valuenow']).toBe(HAPPIER_COLLECTION_RAIL_WIDTH_PX.standard);
        expect(getStorage().getState().localSettings.collectionRailWidthsV1).toEqual({ teams: 310 });
        await screen.unmount();
        const restored = await renderCollection();
        await layoutAt(restored, 1200);
        expect(restored.findHostByTestId('settings-machines-layout-resize-handle')?.props['aria-valuenow'])
            .toBe(HAPPIER_COLLECTION_RAIL_WIDTH_PX.standard);
    });

    /** The options the collection gives the one phone header above both panes. */
    function outerHeaderOptions(screen: Awaited<ReturnType<typeof renderScreen>>): Record<string, unknown> | undefined {
        return screen.root.findAll((node) => node.type === ('StackScreen' as never) && node.props.options !== undefined)[0]
            ?.props.options as Record<string, unknown> | undefined;
    }

    it('leaves the phone header untitled on every collection subpage, entity or list, keeping its Back control', async () => {
        windowState.width = 390;
        windowState.height = 844;
        const renderAt = (childRoute: string) => renderScreen(
            <SettingsCollectionLayout
                navigator="teams"
                rootPathname="/settings/teams"
                resolveChildRoute={() => childRoute}
                rail={<View testID="teams-rail" />}
                railWidth="standard"
                detailMinWidthPx={480}
                testID="settings-teams"
            />,
        );

        // A member, a Group and a Team head their own page with their name.
        for (const entityRoute of [
            '[serverId]/[teamId]/members/[membershipId]',
            '[serverId]/[teamId]/groups/[groupId]',
            '[serverId]/[teamId]/index',
        ]) {
            const screen = await renderAt(entityRoute);
            expect(outerHeaderOptions(screen)?.headerTitle).toBe('');
            act(() => screen.tree.unmount());
        }

        // A collection page names itself too: every Settings subpage leaves the phone bar to Back (one title on the page).
        const members = await renderAt('[serverId]/[teamId]/members/index');
        expect(outerHeaderOptions(members)?.headerTitle).toBe('');
        expect(outerHeaderOptions(members)?.headerLeft).toBeDefined();
    });

    it('puts the rail beside the detail when both fit, and shows the detail stack alone when they do not, keeping the detail mounted', async () => {
        detailMounts.count = 0;
        const screen = await renderCollection();

        // Before the first layout nothing claims the rail.
        expect(hostByTestID(screen, 'machines-rail')).toBeNull();

        await layoutAt(screen, 1200);
        expect(hostByTestID(screen, 'machines-rail')).not.toBeNull();
        expect(currentMode(screen)).toBe('split');

        await layoutAt(screen, 390);
        // Narrow: the detail stack's index page is the list, so the rail is gone ...
        expect(hostByTestID(screen, 'machines-rail')).toBeNull();
        expect(currentMode(screen)).toBe('stacked');
        // ... and the open detail kept its state across the change.
        expect(detailMounts.count).toBe(1);
    });

    it('keeps shared detail content mounted while measuring and across width changes', async () => {
        detailMounts.count = 0;
        const screen = await renderScreen(
            <SettingsCollectionLayout navigator="machines" rootPathname="/settings/machines"
                resolveChildRoute={() => '[id]'} rail={<View testID="machines-rail" />}
                railWidth="standard" detailMinWidthPx={480} testID="settings-machines"
                detailTop={<DetailProbe />}
            />,
        );
        expect(currentMode(screen)).toBe('measuring');
        await layoutAt(screen, 1200);
        expect(currentMode(screen)).toBe('split');
        await layoutAt(screen, 390);
        expect(currentMode(screen)).toBe('stacked');
        expect(detailMounts.count).toBe(1);
    });

    it('needs room for the rail and the detail minimum at the current text scale before splitting', async () => {
        const screen = await renderCollection();
        const needed = COLLECTION_RAIL_MIN_WIDTH_PX + 480;
        await layoutAt(screen, needed - 1);
        expect(hostByTestID(screen, 'machines-rail')).toBeNull();
        await layoutAt(screen, needed);
        expect(hostByTestID(screen, 'machines-rail')).not.toBeNull();
    });

    it('defaults each rail to its role width while both roles can shrink to the row-derived minimum', async () => {
        const renderRole = (railWidth: 'standard' | 'detailed') => renderScreen(
            <SettingsCollectionLayout navigator="machines" rootPathname="/settings/machines"
                resolveChildRoute={() => '[id]'} rail={<View testID="machines-rail" />}
                railWidth={railWidth} detailMinWidthPx={480} testID="settings-machines" />,
        );
        for (const role of ['standard', 'detailed'] as const) {
            const screen = await renderRole(role);
            await layoutAt(screen, 1200);
            expect(screen.findHostByTestId('settings-machines-layout-resize-handle')?.props['aria-valuenow'])
                .toBe(HAPPIER_COLLECTION_RAIL_WIDTH_PX[role]);
            const needed = COLLECTION_RAIL_MIN_WIDTH_PX + 480;
            await layoutAt(screen, needed - 1);
            expect(hostByTestID(screen, 'machines-rail'), `${role} one pixel short`).toBeNull();
            await layoutAt(screen, needed);
            expect(hostByTestID(screen, 'machines-rail'), `${role} exact fit`).not.toBeNull();
        }
    });

    it('gives the whole width to a page shown without its rail (a collection index that is itself the list)', async () => {
        const screen = await renderScreen(
            <SettingsCollectionLayout
                navigator="machines"
                rootPathname="/settings/machines"
                resolveChildRoute={() => 'index'}
                rail={null}
                railWidth="standard"
                detailMinWidthPx={480}
                testID="settings-machines"
                detailTop={<DetailProbe />}
            />,
        );
        // Wide enough for the detail alone but not for rail + detail: no rail column is reserved.
        await layoutAt(screen, 600);
        const listPane = hostByTestID(screen, 'settings-machines-list-pane');
        const flattened = [listPane?.props.style].flat(Infinity).filter(Boolean)
            .reduce((merged: Record<string, unknown>, part: Record<string, unknown>) => ({ ...merged, ...part }), {});
        expect(currentMode(screen)).toBe('split');
        expect(flattened.flex).toBe(0);
        expect(flattened.borderRightWidth ?? 0).toBe(0);
    });

    it('scales the rail and detail minimums with larger text', async () => {
        windowState.fontScale = 1.5;
        const screen = await renderCollection();
        const needed = (COLLECTION_RAIL_MIN_WIDTH_PX + 480) * windowState.fontScale;
        await layoutAt(screen, needed - 1);
        expect(hostByTestID(screen, 'machines-rail')).toBeNull();
        await layoutAt(screen, needed);
        expect(hostByTestID(screen, 'machines-rail')).not.toBeNull();
    });

    it('keeps the shell\'s canvas tail from a pane host inside the detail: the detail is one pane of a split, not the page sheet', async () => {
        const tailsSeen: unknown[] = [];
        function TailProbe() {
            tailsSeen.push(useAppShellTail());
            return null;
        }
        await renderScreen(
            <AppShellTailContext.Provider value={{ placement: 'canvas', divider: 'line', railOnCanvas: true, rightHost: null, railHost: null, railMoreHost: null, containerWidthPx: 1104, joinTrailingTopCorner: () => {} }}>
                <SettingsCollectionLayout navigator="machines" rootPathname="/settings/machines"
                    resolveChildRoute={() => '[id]'} rail={<View />} railWidth="standard" detailMinWidthPx={480}
                    testID="settings-machines" detailTop={<TailProbe />} />
            </AppShellTailContext.Provider>,
        );
        expect(tailsSeen.length).toBeGreaterThan(0);
        expect(tailsSeen.every((tail) => tail === null)).toBe(true);
    });
});
