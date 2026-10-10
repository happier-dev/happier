import type { DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';

import { providerConnectionSourceLabel } from './resolveSessionRoutePresentation';

/** One Gateway or Provider the "Runs through" popover names for an Agent. It only browses; it never commits. */
export type SessionRouteSourceRow = Readonly<{
    connectionId: string;
    label: string;
    /** The Provider's contributed icon name, when it has one. */
    icon: string | null;
    /** Models this Agent can pick from it; null when it offers this Agent none. */
    modelCount: number | null;
    /** Switched off for the main picker, so browsing is the only way in. */
    hiddenFromPicker: boolean;
    /** Set when this Agent cannot use it: the Agents that can (never empty). */
    worksWith: readonly string[] | null;
}>;

/**
 * Joins three existing facts for one Agent and decides nothing itself: the picker projection's shown
 * and hidden sources (what can be browsed) and the connection's own "Works with" summaries (why a
 * source that offers this Agent nothing is still listed). A source in neither set is not a route.
 */
export function buildSessionRouteSourceRows(input: Readonly<{
    agentTargetKey: string;
    views: readonly DaemonProviderConnectionViewV1[];
    isGateway: (view: DaemonProviderConnectionViewV1) => boolean;
    shownSources: readonly Readonly<{ connectionId: string; rows: readonly unknown[] }>[];
    hiddenSources: readonly Readonly<{ connectionId: string; modelCount: number }>[];
}>): Readonly<{ gateways: readonly SessionRouteSourceRow[]; providers: readonly SessionRouteSourceRow[] }> {
    const gateways: SessionRouteSourceRow[] = [];
    const providers: SessionRouteSourceRow[] = [];
    for (const view of input.views) {
        const shown = input.shownSources.find(source => source.connectionId === view.connectionId);
        const hidden = input.hiddenSources.find(source => source.connectionId === view.connectionId);
        const incompatible = !shown && !hidden
            && view.compatibility.some(summary => summary.agentTargetKey === input.agentTargetKey && summary.status === 'incompatible');
        const worksWith = incompatible
            ? view.compatibility.filter(summary => summary.status !== 'incompatible').map(summary => summary.agentName)
            : [];
        if (!shown && !hidden && worksWith.length === 0) continue;
        (input.isGateway(view) ? gateways : providers).push({
            connectionId: view.connectionId,
            label: providerConnectionSourceLabel({ providerName: view.providerName, connectionName: view.displayName,
                connectionRole: view.role, connectionDisplayNameMode: view.displayNameMode }),
            icon: view.icon,
            // A hidden source can still show its favorites or the current model in the main picker,
            // so its rows there and the ones it withholds add up to what browsing it offers.
            modelCount: shown || hidden ? (shown?.rows.length ?? 0) + (hidden?.modelCount ?? 0) : null,
            hiddenFromPicker: hidden !== undefined,
            worksWith: worksWith.length > 0 ? worksWith : null,
        });
    }
    const byLabel = (left: SessionRouteSourceRow, right: SessionRouteSourceRow) => left.label.localeCompare(right.label);
    return { gateways: gateways.sort(byLabel), providers: providers.sort(byLabel) };
}
