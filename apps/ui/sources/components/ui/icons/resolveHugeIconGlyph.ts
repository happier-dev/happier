import type { IconName, IconWeight } from './Icon';
import * as React from 'react';
import type { HugeIconName } from './iconRegistryHuge.generated';

type HugeIconRegistry = typeof import('./iconRegistryHuge.generated').HUGE_ICON_REGISTRY;
let registry: HugeIconRegistry | undefined;
let pending: Promise<HugeIconRegistry> | undefined;
const listeners = new Set<() => void>();

export function preloadHugeIconRegistry(): Promise<HugeIconRegistry> {
    if (registry) return Promise.resolve(registry);
    return pending ??= import('./iconRegistryHuge.generated').then(({ HUGE_ICON_REGISTRY }) => {
        registry = HUGE_ICON_REGISTRY;
        for (const listener of listeners) listener();
        return registry;
    }).catch((error: unknown) => {
        pending = undefined;
        console.warn('[Icon] Unable to load HugeIcons registry', error);
        throw error;
    });
}

const readRegistry = () => registry;
const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

/** Icon and CSS-mask consumers share the same demand, readiness and retry owner. */
export function useHugeIconRegistry(enabled: boolean) {
    const loaded = React.useSyncExternalStore(subscribe, readRegistry, readRegistry);
    React.useEffect(() => {
        if (enabled && !loaded) void preloadHugeIconRegistry().catch(() => { /* The loader reports the failure. */ });
    }, [enabled, loaded]);
    return loaded;
}

/**
 * Concepts pinned to Phosphor regardless of the selected family.
 *
 * Not a fallback for a missing glyph — these are ones where Phosphor's drawing was judged better on
 * the actual surface. Keep this short: every entry is a second family loaded into the bundle and a
 * glyph that will not match its neighbours' grid.
 */
const PHOSPHOR_PINNED = new Set<IconName>([
    // HugeIcons' star is a thin, wide five-point outline that reads as a rating widget next to the
    // dense favourite rows it sits in; Phosphor's is tighter and more compact.
    'star',
    // The hang-up handset. Every HugeIcons `CallEnd*` carries a second mark (a down arrow or an
    // ×) that reads as "missed call" at 15-18px; Phosphor's plain handset, turned flat by
    // Icon's ICON_ROTATION_DEG, is the universal hang-up glyph.
    'phone-hang-up',
]);

/**
 * The HugeIcons drawing for a concept under the selected family, or undefined when Phosphor draws it.
 * HugeIcons draws outline only. `fill` is a Phosphor capability, so a filled request always goes
 * there regardless of the chosen family — and so does any concept HugeIcons has no glyph for.
 */
export function resolveHugeIconGlyph(name: IconName, weight: IconWeight | undefined, family: string) {
    if (family !== 'hugeicons' || weight === 'fill' || PHOSPHOR_PINNED.has(name)) return undefined;
    return registry?.[name as HugeIconName];
}
