/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

// Real RNW hosts and the real shell frame; only the viewport and native animation adapters are replaced.
vi.mock('react-native', async () => ({
    ...await vi.importActual<typeof import('react-native-web')>('react-native-web'),
    useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-gesture-handler', async () => ({
    ...(await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock(),
    ScrollView: (await vi.importActual<typeof import('react-native-web')>('react-native-web')).ScrollView,
}));

await import('@/sync/syncEngine');
const { PaneColumnsHost } = await import('./PaneColumnsHost');
const { AppShellMaterialFrame } = await import('@/components/navigation/shell/AppShellMaterialFrame');
const { AppShellTailSlot } = await import('@/components/navigation/shell/appShellTail');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllGlobals(); });

function mountRoot() {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
    return { container, root };
}

it('stands the docked right panel and its rail on the canvas beside the page, and inside it for Sheet, without replacing the page', async () => {
    const { container, root } = mountRoot();
    let panelMounts = 0;
    let mainMounts = 0;
    function Field({ name, onMount }: Readonly<{ name: string; onMount: () => void }>) {
        React.useEffect(onMount, [onMount]);
        return <input data-testid={name} defaultValue={name} />;
    }
    const countMain = () => { mainMounts += 1; };
    const countPanel = () => { panelMounts += 1; };
    const render = async (placement: 'canvas' | 'sheet', chrome = true) => act(async () => root.render(
        <AppShellMaterialFrame showChrome={chrome} dragEnabled={false} leftOffsetPx={0} sidebarWidth={0}
            titleStrip={null} rail={null} column={null} peek={null} rightPanelPlacement={placement}>
            <PaneColumnsHost main={<Field name="main" onMount={countMain} />} arrangement="session"
                rightPane={<Field name="panel" onMount={countPanel} />} rightOpen
                actionRail={<button data-testid="rail-button">Info</button>} />
        </AppShellMaterialFrame>,
    ));
    const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    const inTail = (id: string) => q('app-shell-tail').contains(q(id));

    await render('canvas');
    const main = q('main') as HTMLInputElement;
    main.value = 'Retained draft';
    expect(q('multi-pane-right-docked')).not.toBeNull();
    // Canvas: the docked panel and the rail stand in the tail, in that order; the page keeps main.
    expect(q('app-shell-tail-right').contains(q('panel'))).toBe(true);
    expect(q('app-shell-tail-rail').contains(q('rail-button'))).toBe(true);
    expect(inTail('main')).toBe(false);

    // Sheet: both return inside the page; the page itself never remounts and keeps its draft.
    await render('sheet');
    expect(inTail('panel')).toBe(false);
    expect(inTail('rail-button')).toBe(false);
    expect(q('main')).toBe(main);
    expect(main.value).toBe('Retained draft');

    // Without the shell's chrome (a phone) the page placement holds whatever the setting says.
    await render('canvas', false);
    expect(container.querySelector('[data-testid="app-shell-tail"]')).toBeNull();
    expect(q('main')).toBe(main);
    expect(mainMounts).toBe(1);
    // The setting change moves the side column once each way at most; it never mounts twice per move.
    expect(panelMounts).toBeLessThanOrEqual(3);
});

it('keeps a slot in its tail host but shows nothing while its page is off screen', async () => {
    const { container, root } = mountRoot();
    const host = document.createElement('div');
    document.body.appendChild(host);
    cleanups.push(async () => { host.remove(); });
    let mounts = 0;
    function Probe() {
        React.useEffect(() => { mounts += 1; }, []);
        return <span data-testid="probe">panel</span>;
    }
    const render = async (target: HTMLElement | null, hidden: boolean) => act(async () => root.render(
        <AppShellTailSlot host={target} hidden={hidden}><Probe /></AppShellTailSlot>,
    ));
    await render(null, false);
    expect(container.contains(host.querySelector('[data-testid="probe"]'))).toBe(false);
    expect(container.querySelector('[data-testid="probe"]')).not.toBeNull();
    await render(host, false);
    const probe = host.querySelector<HTMLElement>('[data-testid="probe"]')!;
    expect(probe).not.toBeNull();
    expect((probe.parentElement as HTMLElement).style.display).toBe('contents');
    await render(host, true);
    expect(host.querySelector('[data-testid="probe"]')).toBe(probe);
    expect((probe.parentElement as HTMLElement).style.display).toBe('none');
    await render(null, true);
    expect(container.querySelector('[data-testid="probe"]')).toBe(probe);
    expect(mounts).toBe(1);
});

it('gives a vacant rail no column only where its More has a home in the title strip, and stands again when it has an action', async () => {
    const { container, root } = mountRoot();
    const { PaneActionRailContext } = await import('./PaneActionRailContext');
    const { AppShellTitleMoreSlot } = await import('@/components/navigation/shell/appShellTail');
    let moreHost: HTMLElement | null | undefined;
    function Rail({ vacant }: Readonly<{ vacant: boolean }>) {
        const rail = React.useContext(PaneActionRailContext);
        const report = rail?.onVacantChange;
        moreHost = rail?.vacantMoreHost;
        React.useLayoutEffect(() => { report?.(vacant); }, [report, vacant]);
        return <div data-testid="rail-body" />;
    }
    let railVisibleInPage: boolean | undefined;
    function Main() {
        railVisibleInPage = React.useContext(PaneActionRailContext)?.visible;
        return <div data-testid="main" />;
    }
    const render = (vacant: boolean, slot: boolean) => act(async () => root.render(
        <AppShellMaterialFrame showChrome dragEnabled={false} leftOffsetPx={0} sidebarWidth={0}
            titleStrip={slot ? <AppShellTitleMoreSlot /> : <div />} rail={null} column={null} peek={null}>
            <PaneColumnsHost testID="host" main={<Main />} actionRail={<Rail vacant={vacant} />} />
        </AppShellMaterialFrame>,
    ));
    const column = () => document.querySelector<HTMLElement>('[data-testid="pane-action-rail-column"]')!;
    const slotNode = () => container.querySelector('[data-testid="app-shell-title-more"]');
    // No home for its More: it keeps its column, so its panels stay reachable.
    await render(true, false);
    expect(getComputedStyle(column()).display).not.toBe('none');
    expect(railVisibleInPage).toBe(true);
    await render(true, true);
    expect(getComputedStyle(column()).display).toBe('none');
    expect(railVisibleInPage).toBe(false);
    expect(moreHost).toBe(slotNode());
    expect(document.querySelector('[data-testid="rail-body"]')).not.toBeNull();
    await render(false, true);
    expect(getComputedStyle(column()).display).not.toBe('none');
    expect(railVisibleInPage).toBe(true);
    expect(moreHost).toBeNull();
});
