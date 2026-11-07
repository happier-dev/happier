import type { ProviderDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import type { DaemonProviderConnectionViewV1 } from '@happier-dev/protocol/rpc';
import { resolveProviderConnectionIcon } from '@/components/settings/providers/collection/providerCollectionModel';
import { presentProviderError } from '@/providers/connection/errorPresentation';
import { presentProviderConnection, PROVIDER_CONNECTION_STATUS_KEY } from '@/providers/connection/presentation';
import { t } from '@/text';

import { providerConnectionSourceLabel } from './resolveSessionRoutePresentation';

/** One Gateway or Provider the "Runs through" popover names for an Agent. It only browses; it never commits. */
export type SessionRouteSourceRow = Readonly<{
    connectionId: string;
    label: string;
    /** Already-admitted qualified identity for packaged artwork, absent for custom sources. */
    contributionKey: string | null;
    /** The Provider's contributed icon name, when it has one. */
    icon: string | null;
    /** Models this Agent can pick from it; null when it offers this Agent none. */
    modelCount: number | null;
    /** Switched off for the main picker, so browsing is the only way in. */
    hiddenFromPicker: boolean;
    /** Set when this Agent cannot use it: the Agents that can (never empty). */
    worksWith: readonly string[] | null;
    availability: 'available' | 'unavailable';
    unavailableReason: string | null;
}>;

/**
 * Joins three existing facts for one Agent and decides nothing itself: the picker projection's shown
 * and hidden sources (what can be browsed) and the connection's own "Works with" summaries (why a
 * source that offers this Agent nothing is still listed). Compatibility keeps
 * sources browseable when discovery has not produced rows yet.
 */
export function buildSessionRouteSourceRows(input: Readonly<{
    declarationContext: ProviderDeclarationContext;
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
        const compatible = view.compatibility.some(summary => summary.agentTargetKey === input.agentTargetKey && summary.status !== 'incompatible');
        const incompatible = !shown && !hidden
            && view.compatibility.some(summary => summary.agentTargetKey === input.agentTargetKey && summary.status === 'incompatible');
        const worksWith = incompatible
            ? view.compatibility.filter(summary => summary.status !== 'incompatible').map(summary => summary.agentName)
            : [];
        if (!shown && !hidden && !compatible && worksWith.length === 0) continue;
        const presentation = presentProviderConnection(view);
        const available = view.authorized && !incompatible
            && (presentation.status === 'available' || presentation.status === 'partial' || presentation.status === 'notChecked');
        (input.isGateway(view) ? gateways : providers).push({
            connectionId: view.connectionId,
            contributionKey: view.contributionKey,
            label: providerConnectionSourceLabel({ providerName: view.providerName, connectionName: view.displayName,
                connectionRole: view.role, connectionDisplayNameMode: view.displayNameMode }),
            icon: resolveProviderConnectionIcon(view, input.declarationContext),
            // A hidden source can still show its favorites or the current model in the main picker,
            // so its rows there and the ones it withholds add up to what browsing it offers.
            modelCount: shown || hidden ? (shown?.rows.length ?? 0) + (hidden?.modelCount ?? 0) : null,
            hiddenFromPicker: hidden !== undefined,
            worksWith: worksWith.length > 0 ? worksWith : null,
            availability: available ? 'available' : 'unavailable',
            unavailableReason: available ? null
                : view.authorizationError ? t(presentProviderError(view.authorizationError).titleKey)
                    : incompatible ? t('connectedServices.authChip.worksWith', { agents: worksWith.join(', ') })
                        : t(PROVIDER_CONNECTION_STATUS_KEY[presentation.status]),
        });
    }
    const byLabel = (left: SessionRouteSourceRow, right: SessionRouteSourceRow) =>
        Number(left.availability === 'unavailable') - Number(right.availability === 'unavailable')
        || left.label.localeCompare(right.label);
    return { gateways: gateways.sort(byLabel), providers: providers.sort(byLabel) };
}
