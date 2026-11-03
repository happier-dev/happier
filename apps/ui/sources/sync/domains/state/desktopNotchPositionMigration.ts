type LegacyAnchor = 'top_center' | 'top_left' | 'top_right' | 'bottom_center' | 'bottom_left' | 'bottom_right' | 'left_center' | 'right_center';

/** Historical input only; native notch-position.json owns the converted position. */
export type DesktopNotchLegacyPositionMigration = Readonly<
    { kind: 'floating_custom'; anchor: LegacyAnchor; extent: Readonly<{ width: number; height: number }> }
    | { kind: 'bottom'; x: 0 | 0.5 | 1 }
>;

export function projectDesktopNotchPositionMigration(storedValue: unknown): DesktopNotchLegacyPositionMigration | undefined {
    if (!storedValue || typeof storedValue !== 'object' || Array.isArray(storedValue)) return undefined;
    const source = storedValue as Record<string, unknown>;
    if (source.desktopOverlayDock !== undefined) return undefined;
    const anchor = source.desktopOverlayAnchor;
    if (source.desktopOverlayPresentationMode === 'floating_overlay' && source.desktopOverlayPlacementMode === 'custom') {
        const legacyAnchor = anchor === 'top_left' || anchor === 'top_right' || anchor === 'bottom_center'
            || anchor === 'bottom_left' || anchor === 'bottom_right' || anchor === 'left_center' || anchor === 'right_center'
            ? anchor : 'top_center';
        // Exact former collapsed sizes from the pre-notch native placement owner.
        const comfortable = source.desktopOverlayDensity === 'comfortable';
        const panel = source.desktopOverlayCompactStyle === 'panel';
        const extent = panel ? { width: comfortable ? 372 : 336, height: comfortable ? 76 : 68 }
            : { width: comfortable ? 270 : 254, height: comfortable ? 40 : 38 };
        return { kind: 'floating_custom', anchor: legacyAnchor, extent };
    }
    if (anchor === 'bottom_left' || anchor === 'bottom_center' || anchor === 'bottom_right') {
        return { kind: 'bottom', x: anchor === 'bottom_left' ? 0 : anchor === 'bottom_right' ? 1 : 0.5 };
    }
    return undefined;
}
