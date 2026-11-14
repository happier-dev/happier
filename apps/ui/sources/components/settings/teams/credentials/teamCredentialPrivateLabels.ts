import * as React from 'react';
import type { PrivateLabelReadV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import type { TeamCredentialResourceSummaryV1 } from '@happier-dev/protocol/teams';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { teamCredentialDisplayNameBinding } from '@/sync/ops/teams/teamCredentialLabels';
import {
    useOpenedPrivateLabels,
    type PrivateLabelOpenRequestV1,
} from '@/sync/ops/privateLabels/useOpenedPrivateLabels';

/**
 * The persisted credential resource is the label identity. Catalog rows,
 * administrative rows, session previews, and audit snapshots all bind their
 * recipient projection to this exact resource rather than to a view or event.
 */
export { teamCredentialDisplayNameBinding } from '@/sync/ops/teams/teamCredentialLabels';

/** A broker projection names a Pool only through this persisted Pool-label binding. */
export function teamCredentialBrokerPoolNameBinding(poolId: string) {
    return {
        entity: 'machine_pool' as const,
        field: 'name' as const,
        id: poolId,
    };
}

type TeamCredentialLabelCarrier = Readonly<{
    id: string;
    displayName: PrivateLabelReadV1;
}>;

/** Opens already-authorized resource labels locally; it never fetches detail rows. */
export function useOpenedTeamCredentialDisplayNames(params: Readonly<{
    scope: ServerAccountScope | null;
    resources: readonly TeamCredentialLabelCarrier[];
    enabled?: boolean;
}>): Readonly<Record<string, string | null>> {
    const requests = React.useMemo<readonly PrivateLabelOpenRequestV1[]>(() => params.resources.map((resource) => ({
        key: resource.id,
        binding: teamCredentialDisplayNameBinding(resource.id),
        label: resource.displayName,
        readPolicy: { kind: 'team-resource' },
    })), [params.resources]);
    return useOpenedPrivateLabels({
        scope: params.scope,
        requests,
        ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
    });
}

type TeamCredentialBrokerPresentation = TeamCredentialResourceSummaryV1['brokerPresentation'];

/**
 * Opens recipient-projected Pool labels used only in a credential's broker
 * presentation. Pool availability and membership remain the Home's opaque
 * projection; this hook supplies only the locally opened human label.
 */
export function useOpenedTeamCredentialBrokerPoolNames(params: Readonly<{
    scope: ServerAccountScope | null;
    brokerPresentation: TeamCredentialBrokerPresentation;
    enabled?: boolean;
}>): Readonly<Record<string, string | null>> {
    const requests = React.useMemo<readonly PrivateLabelOpenRequestV1[]>(() => {
        const candidates = [
            ...params.brokerPresentation.eligiblePools,
            ...(params.brokerPresentation.selectedPool === null ? [] : [params.brokerPresentation.selectedPool]),
        ];
        const seen = new Set<string>();
        return candidates.flatMap((pool) => {
            if (seen.has(pool.poolId)) return [];
            seen.add(pool.poolId);
            return pool.displayName?.kind === 'available' ? [{
                key: pool.poolId,
                binding: teamCredentialBrokerPoolNameBinding(pool.poolId),
                label: pool.displayName.label,
                readPolicy: { kind: 'team-resource' },
            }] : [];
        });
    }, [params.brokerPresentation]);
    return useOpenedPrivateLabels({
        scope: params.scope,
        requests,
        ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
    });
}
