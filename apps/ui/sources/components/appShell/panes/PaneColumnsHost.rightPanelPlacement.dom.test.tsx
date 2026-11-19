/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

// Real RNW hosts and the real shell frame; only the viewport and native animation adapters are replaced.
const viewport = vi.hoisted(() => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }));
vi.mock('react-native', async () => ({
    ...await vi.importActual<typeof import('react-native-web')>('react-native-web'),
    useWindowDimensions: () => viewport,
    Dimensions: { get: () => viewport, addEventListener: () => ({ remove() {} }) },
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
const { useLayoutPresentationActive, usePluginSurfaceFocusEligibility } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllGlobals(); viewport.width = 1440; });

function mountRoot() {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
    return { container, root };
}

it('retains panel and rail DOM, local state and scroll across Separate, Line, Shadow and phone presentation', async () => {
    const { container, root } = mountRoot();
    let panelMounts = 0;
    let mainMounts = 0;
    let railMounts = 0;
    function Field({ name, onMount }: Readonly<{ name: string; onMount: () => void }>) {
        React.useEffect(onMount, [onMount]);
        const [count, setCount] = React.useState(0);
        const presented = useLayoutPresentationActive();
        const focusable = usePluginSurfaceFocusEligibility();
        return <div data-testid={`${name}-scroll`} style={{ height: 100, overflowY: 'auto' }}>
            <input data-testid={name} defaultValue={name} />
            <button data-testid={`${name}-step`} onClick={() => setCount(value => value + 1)}>{count}</button>
            <span data-testid={`${name}-presentation`} data-presented={presented} data-focusable={focusable} />
            <div style={{ height: 2000 }} />
        </div>;
    }
    const countMain = () => { mainMounts += 1; };
    const countPanel = () => { panelMounts += 1; };
    const countRail = () => { railMounts += 1; };
    const render = async (placement: 'separate' | 'line' | 'shadow', chrome = true) => {
        await act(async () => root.render(
        <AppShellMaterialFrame showChrome={chrome} dragEnabled={false} leftOffsetPx={0} sidebarWidth={0}
            titleStrip={null} rail={null} column={null} peek={null} rightPanelPlacement={placement}>
            <PaneColumnsHost testID="tail-columns" main={<Field name="main" onMount={countMain} />} arrangement="session"
                rightPane={<Field name="panel" onMount={countPanel} />} rightOpen
                actionRail={<Field name="rail-button" onMount={countRail} />} />
        </AppShellMaterialFrame>,
        ));
        // jsdom has no layout engine. Deliver the RNW SDK's measured onLayout event; pane policy stays real.
        const measured = q('tail-columns') as HTMLElement & {
            __reactLayoutHandler: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
        };
        await act(async () => measured.__reactLayoutHandler({ nativeEvent: { layout: {
            width: viewport.width, height: viewport.height,
        } } }));
    };
    const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    const inTail = (id: string) => q('app-shell-tail').contains(q(id));

    await render('separate');
    const main = q('main') as HTMLInputElement;
    const panel = q('panel') as HTMLInputElement;
    const panelScroll = q('panel-scroll');
    const rail = q('rail-button') as HTMLInputElement;
    const railScroll = q('rail-button-scroll');
    main.value = 'Retained draft';
    panel.value = 'Retained review note';
    rail.value = 'Retained rail choice';
    panelScroll.scrollTop = 650;
    railScroll.scrollTop = 37;
    await act(async () => { q('panel-step').click(); q('rail-button-step').click(); });
    const expectRetained = () => {
        expect(q('panel')).toBe(panel);
        expect(q('panel-scroll')).toBe(panelScroll);
        expect(panel.isConnected).toBe(true);
        expect(panel.value).toBe('Retained review note');
        expect(panelScroll.scrollTop).toBe(650);
        expect(q('panel-step').textContent).toBe('1');
        expect(q('rail-button')).toBe(rail);
        expect(q('rail-button-scroll')).toBe(railScroll);
        expect(rail.value).toBe('Retained rail choice');
        expect(railScroll.scrollTop).toBe(37);
        expect(q('rail-button-step').textContent).toBe('1');
    };
    expect(q('multi-pane-right-docked')).not.toBeNull();
    // Separate: the docked panel and the rail stand in the tail, in that order; the page keeps main.
    expect(q('app-shell-tail-right').contains(q('panel'))).toBe(true);
    expect(q('app-shell-tail-rail').contains(q('rail-button'))).toBe(true);
    expect(inTail('main')).toBe(false);
    expect(container.querySelector('[data-testid="multi-pane-right-joined-shade"]')).toBeNull();

    // Line: the panel joins the page with a hairline; the rail stays on the canvas (R11-1). The page never
    // remounts and keeps its draft.
    await render('line');
    expectRetained();
    expect(inTail('panel')).toBe(false);
    expect(q('app-shell-tail-rail').contains(q('rail-button'))).toBe(true);
    expect(q('main')).toBe(main);
    expect(main.value).toBe('Retained draft');
    const panelSheet = () => q('multi-pane-right-docked').querySelector<HTMLElement>('[data-happy-glass-backdrop="true"]')!.parentElement!;
    expect(panelSheet().style.borderLeftWidth).not.toBe('0px');
    expect(container.querySelector('[data-testid="multi-pane-right-joined-shade"]')).toBeNull();

    // Shadow: the same join, divided by the header's soft shade instead of the hairline.
    await render('shadow');
    expectRetained();
    expect(inTail('panel')).toBe(false);
    expect(q('app-shell-tail-rail').contains(q('rail-button'))).toBe(true);
    expect(panelSheet().style.borderLeftWidth).toBe('0px');
    expect(q('multi-pane-right-joined-shade')).not.toBeNull();

    // Without the shell's chrome (a phone) the page placement holds whatever the setting says.
    viewport.width = 390;
    await render('separate', false);
    expectRetained();
    expect(container.querySelector('[data-testid="app-shell-tail"]')).toBeNull();
    expect(q('multi-pane-right-overlay')).not.toBeNull();
    expect(q('panel-presentation').dataset).toMatchObject({ presented: 'true', focusable: 'true' });
    expect(q('main')).toBe(main);
    viewport.width = 1440;
    await render('separate');
    expectRetained();
    expect(q('app-shell-tail-right').contains(panel)).toBe(true);
    expect(q('app-shell-tail-rail').contains(rail)).toBe(true);
    expect(mainMounts).toBe(1);
    expect(panelMounts).toBe(1);
    expect(railMounts).toBe(1);
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

// DESIGN-ACCEPT-1116-D D-K1: a parked Session tab freezes its body before its rail's focus update commits. The
// portal sits outside the `display: none` that hides the frozen body, so the slot itself must leave with it:
// otherwise the parked tab's rail stands beside the open one, visible and reachable by Tab.
it('hides a slot whose retained body is frozen off screen, even before its own hidden update commits', async () => {
    const { RetainedPanelSurface } = await import('@/components/ui/panels/RetainedPanelSurface');
    const { root } = mountRoot();
    const host = document.createElement('div');
    document.body.appendChild(host);
    cleanups.push(async () => { host.remove(); });
    const render = async (active: boolean) => act(async () => root.render(
        <RetainedPanelSurface isActive={active} mode="flow" suspendWhenHidden>
            <AppShellTailSlot host={host} hidden={false}><span data-testid="parked-rail">rail</span></AppShellTailSlot>
        </RetainedPanelSurface>,
    ));
    await render(true);
    const rail = host.querySelector<HTMLElement>('[data-testid="parked-rail"]')!;
    expect((rail.parentElement as HTMLElement).style.display).toBe('contents');
    await render(false);
    await act(async () => {});
    expect(host.querySelector('[data-testid="parked-rail"]')).toBe(rail);
    expect((rail.parentElement as HTMLElement).style.display).toBe('none');
    await render(true);
    await act(async () => {});
    expect((rail.parentElement as HTMLElement).style.display).toBe('contents');
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

// UI refinements 2026-11-18 23:07Z: one decision per open. Details docks whenever its minimum fits beside main once
// the rail is reserved, clamped to that budget (1440 with the Sessions sidebar open leaves this host 1120 px:
// 1120 − 44 rail − 420 main = 656, so a stored 680 docks at 656, the DESIGN-LIVE-225 split). It overlays only
// where even its minimum doesn't fit (760 − 44 − 420 = 296 < 320), and the late companion moves neither.
it.each([
    { hostWidth: 1120, storedWidth: 680, placement: 'docked', dockedWidth: 656 },
    { hostWidth: 1120, storedWidth: 640, placement: 'docked', dockedWidth: 640 },
    { hostWidth: 760, storedWidth: 520, placement: 'overlay', dockedWidth: null },
])('keeps Details $placement when a late companion fills the action rail (host $hostWidth, stored $storedWidth)', async ({
    hostWidth, storedWidth, placement, dockedWidth,
}) => {
    const { container, root } = mountRoot();
    const { getStorage } = await import('@/sync/domains/state/storage');
    const { PaneActionRailContext } = await import('./PaneActionRailContext');
    const { AppShellTitleMoreSlot } = await import('@/components/navigation/shell/appShellTail');
    const storage = getStorage();
    const previousSettings = storage.getState().localSettings;
    storage.setState({ localSettings: { ...previousSettings, detailsPaneWidthPx: storedWidth } });
    cleanups.push(async () => { storage.setState({ localSettings: previousSettings }); });

    function Rail({ companion }: Readonly<{ companion: boolean }>) {
        const report = React.useContext(PaneActionRailContext)?.onVacantChange;
        React.useLayoutEffect(() => { report?.(!companion); }, [report, companion]);
        return companion ? <button>Session companion</button> : null;
    }
    const render = (open: boolean, companion: boolean) => act(async () => root.render(
        <AppShellMaterialFrame showChrome dragEnabled={false} leftOffsetPx={0} sidebarWidth={320}
            titleStrip={<AppShellTitleMoreSlot />} rail={null} column={<div />} peek={null}>
            <PaneColumnsHost testID="details-columns" main={<div />} destinationOwnsDetails
                detailsPane={open ? <input data-testid="triage-details" /> : null}
                actionRail={<Rail companion={companion} />} />
        </AppShellMaterialFrame>,
    ));
    const query = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    await render(false, false);
    const host = query('details-columns') as HTMLElement & {
        __reactLayoutHandler: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
    };
    await act(async () => host.__reactLayoutHandler({ nativeEvent: { layout: { width: hostWidth, height: viewport.height } } }));
    await render(true, false);
    const rail = document.querySelector<HTMLElement>('[data-testid="pane-action-rail-column"]')!;
    expect(getComputedStyle(rail).display).toBe('none');
    const readPlacement = () => query('triage-details')?.closest('[data-testid^="multi-pane-details-"]')?.dataset.testid;
    const beforeCompanion = readPlacement();
    const detail = query('triage-details');

    await render(true, true);
    expect(getComputedStyle(rail).display).not.toBe('none');
    expect(rail.textContent).toContain('Session companion');
    expect([beforeCompanion, readPlacement()]).toEqual([
        `multi-pane-details-${placement}`,
        `multi-pane-details-${placement}`,
    ]);
    expect(query('triage-details')).toBe(detail);
    if (dockedWidth !== null) {
        const column = query('triage-details')!.closest<HTMLElement>('[data-testid="multi-pane-details-docked"]')!;
        expect(parseFloat(column.style.width || getComputedStyle(column).width)).toBe(dockedWidth);
    }
});

// Owner 2026-11-11 (desktop #25a): the right rail stands on the chrome coat like the app rail, never on a content plate.
it('backs an in-page action rail with the chrome coat, not a content plate', async () => {
    const { root } = mountRoot();
    await act(async () => root.render(<PaneColumnsHost testID="host" main={<div data-testid="main" />} actionRail={<div data-testid="rail-body" />} />));
    const column = document.querySelector<HTMLElement>('[data-testid="pane-action-rail-column"]')!;
    const paints = [...column.querySelectorAll<HTMLElement>('*')].map(node => node.getAttribute('style') ?? '').join(' ');
    expect(paints).toContain('--happier-glass-chrome');
    expect(paints).not.toContain('--happier-glass-content');
});
