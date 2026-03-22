export type ResolvedBottomPanePresentation = 'docked' | 'overlay';

export type ResolvedBottomPaneLayout = Readonly<{
    presentation: ResolvedBottomPanePresentation;
    dockMaxHeightPx: number;
    overlayMaxHeightPx: number;
}>;

export function resolveBottomPaneLayout(input: Readonly<{
    containerHeightPx: number;
    mainMinHeightPx: number;
    bottomMinHeightPx: number;
    preferredHeightPx?: number | null;
}>): ResolvedBottomPaneLayout {
    const height = input.containerHeightPx;
    const mainMinHeightPx = input.mainMinHeightPx;
    const bottomMinHeightPx = input.bottomMinHeightPx;

    if (!Number.isFinite(height) || height <= 0) {
        return {
            presentation: 'overlay',
            dockMaxHeightPx: bottomMinHeightPx,
            overlayMaxHeightPx: bottomMinHeightPx,
        };
    }

    const dockMaxHeightPx = Math.max(bottomMinHeightPx, height - mainMinHeightPx);
    const preferredHeightPx =
        typeof input.preferredHeightPx === 'number' && Number.isFinite(input.preferredHeightPx)
            ? input.preferredHeightPx
            : null;
    const canDock = height >= mainMinHeightPx + bottomMinHeightPx;
    const prefersOverlayWhenPreferredDoesNotFit = preferredHeightPx != null && preferredHeightPx > dockMaxHeightPx + 1;

    return {
        presentation: canDock && !prefersOverlayWhenPreferredDoesNotFit ? 'docked' : 'overlay',
        dockMaxHeightPx,
        overlayMaxHeightPx: Math.max(bottomMinHeightPx, height),
    };
}
