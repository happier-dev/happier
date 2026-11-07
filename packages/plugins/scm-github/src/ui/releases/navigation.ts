import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { ForgeReleaseIdV1Schema } from '@happier-dev/triage-protocol/releases/v1';

export type ReleaseLocationV1 = Readonly<{ subPath: string; backLocation: string }>;
export type ReleaseRouteV1 = Readonly<{ subPath: string; kind: 'list' | 'compose' }>
    | Readonly<{ subPath: string; kind: 'detail'; releaseId: string; fullPage: boolean }>;
export function parseReleaseLocationV1(subPath: string): ReleaseRouteV1 | null {
    if (subPath === '' || subPath === 'compose') return { subPath, kind: subPath === '' ? 'list' : 'compose' };
    const match = /^([1-9][0-9]*)(\/page)?$/u.exec(subPath);
    return match ? { subPath, kind: 'detail', releaseId: match[1]!, fullPage: match[2] !== undefined } : null;
}
export function releaseDetailLocationsV1(releaseId: string) {
    const id = ForgeReleaseIdV1Schema.parse(releaseId);
    return { fullPageLocation: { subPath: `${id}/page`, backLocation: id }, returnLocation: { subPath: id, backLocation: '' } };
}
/** The existing host pane/button owns composition, focus and topology. This binding owns only release subpaths. */
export function createReleaseLocationBindingV1(options: Readonly<{
    subPath: string; host: Pick<PluginUiHostApi, 'replacePageLocation'>;
    canLeave?: (next: ReleaseRouteV1, current: ReleaseRouteV1) => boolean | Promise<boolean>;
}>) {
    let route = parseReleaseLocationV1(options.subPath);
    const listeners = new Set<() => void>();
    return {
        getSnapshot: () => route,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        async replace(location: ReleaseLocationV1): Promise<boolean> {
            const next = parseReleaseLocationV1(location.subPath);
            if (!route || !next || parseReleaseLocationV1(location.backLocation) === null) return false;
            if (options.canLeave && !await options.canLeave(next, route)) return false;
            const prior = route;
            try {
                const result = await options.host.replacePageLocation(location.subPath, { backLocation: location.backLocation });
                const settled = parseReleaseLocationV1(result.subPath);
                if (!settled || route !== prior) return false;
                if (settled.subPath !== prior.subPath) { route = settled; for (const listener of listeners) listener(); }
                return true;
            } catch { return false; }
        },
    };
}
