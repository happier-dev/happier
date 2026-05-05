import type { PopoverPlacement, ResolvedPopoverPlacement } from './_types';

export function resolvePlacement(params: {
    placement: PopoverPlacement;
    available: Record<ResolvedPopoverPlacement, number>;
    preferredMinAvailable?: number;
}): ResolvedPopoverPlacement {
    if (params.placement === 'auto-vertical') {
        const preferredMinAvailable = Math.max(0, params.preferredMinAvailable ?? 0);
        if (params.available.bottom >= preferredMinAvailable) return 'bottom';
        return params.available.top > params.available.bottom ? 'top' : 'bottom';
    }
    if (params.placement !== 'auto') return params.placement;
    const entries = Object.entries(params.available) as Array<[ResolvedPopoverPlacement, number]>;
    entries.sort((a, b) => b[1] - a[1]);
    return entries[0]?.[0] ?? 'top';
}
