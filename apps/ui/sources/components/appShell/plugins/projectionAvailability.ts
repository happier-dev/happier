import { shallow } from 'zustand/shallow';
import type { PluginUiProjectionUnion } from '@/sync/domains/plugins/ui/projectionUnion';
import type { AppShellPluginUiProjectionValue } from './AppShellPluginUiProjection';

/** Settled declarations can coexist with other contributors still establishing. */
export function isAppShellPluginCatalogPending(projection: Pick<AppShellPluginUiProjectionValue, 'phase' | 'hasEstablishingMembers'>): boolean {
    return projection.phase === 'establishing' || projection.hasEstablishingMembers === true;
}

/** Explain failed discovery through the existing unavailable surface, retaining declarations. */
export function settleAppShellProjectionAvailability(
    projection: PluginUiProjectionUnion,
    unavailableReasonCode: string | undefined,
    previous: PluginUiProjectionUnion,
    accountCensusPending = false,
): PluginUiProjectionUnion {
    // Availability's first Account census has an actual Sync producer. Passive
    // Machine catalog absence is not a substitute for that pending discovery.
    if (accountCensusPending) {
        const pending = { ...projection, phase: 'establishing' as const, hasEstablishingMembers: true };
        return shallow(previous, pending) ? previous : Object.freeze(pending);
    }
    if (!unavailableReasonCode) return projection;
    const failed = { ...projection, phase: 'unavailable' as const, unavailableReasonCode,
        hasEstablishingMembers: false, interactionEnabled: false };
    return shallow(previous, failed) ? previous : Object.freeze(failed);
}
