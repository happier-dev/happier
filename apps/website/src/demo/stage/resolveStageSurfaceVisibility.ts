import type { DemoSurfaceView } from '../timeline/scenarioTypes';

export type StageLayout =
    | 'terminal-phone'
    | 'terminal-phone-desktop'
    | 'desktop-phone'
    | 'phone-only'
    | 'triple-parallel';

export type StageSurface = DemoSurfaceView | 'terminal';

type VisibleDevice = 'terminal' | 'phone' | 'desktop';

const phoneViews = new Set<DemoSurfaceView>(['phone-session', 'phone-new-session', 'voice']);
const desktopViews = new Set<DemoSurfaceView>([
    'desktop-session',
    'desktop-new-session',
    'direct-browse',
]);

function firstMatchingView(
    visibleSurfaces: readonly StageSurface[],
    views: ReadonlySet<DemoSurfaceView>,
    fallback: DemoSurfaceView,
): DemoSurfaceView {
    return (
        visibleSurfaces.find(
            (surface): surface is DemoSurfaceView =>
                surface !== 'terminal' && views.has(surface),
        ) ?? fallback
    );
}

function layoutAllowsDevice(layout: StageLayout, device: VisibleDevice): boolean {
    if (layout === 'triple-parallel') return true;
    if (layout === 'phone-only') return device === 'phone';
    if (layout === 'desktop-phone') return device === 'desktop' || device === 'phone';
    if (layout === 'terminal-phone') return device === 'terminal' || device === 'phone';
    return true;
}

export function resolveStageSurfaceVisibility(input: {
    layout: StageLayout;
    visibleSurfaces: readonly StageSurface[];
    phoneView: DemoSurfaceView;
    desktopView: DemoSurfaceView;
}): {
    showTerminal: boolean;
    showPhone: boolean;
    showDesktop: boolean;
    resolvedPhoneView: DemoSurfaceView;
    resolvedDesktopView: DemoSurfaceView;
} {
    const resolvedPhoneView = firstMatchingView(input.visibleSurfaces, phoneViews, input.phoneView);
    const resolvedDesktopView = firstMatchingView(
        input.visibleSurfaces,
        desktopViews,
        input.desktopView,
    );

    return {
        showTerminal:
            layoutAllowsDevice(input.layout, 'terminal') &&
            input.visibleSurfaces.includes('terminal'),
        showPhone:
            layoutAllowsDevice(input.layout, 'phone') &&
            input.visibleSurfaces.includes(resolvedPhoneView),
        showDesktop:
            layoutAllowsDevice(input.layout, 'desktop') &&
            input.visibleSurfaces.includes(resolvedDesktopView),
        resolvedPhoneView,
        resolvedDesktopView,
    };
}
