import * as React from 'react';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { useProviderCatalog } from '@/sync/store/useProviderCatalog';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { refreshProviderCatalog } from '@/sync/engine/settings/providerCatalogEngine';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useProviderConnections } from '@/providers/hooks/useProviderConnections';
import { useProviderConnectionMutation } from '@/providers/hooks/useProviderConnectionMutation';
import { areProviderGatewayDeclarationsKnown } from '../../providers/collection/providerCollectionModel';
import { buildPoolGatewayChoices, buildPoolGatewayMutation, type PoolGatewayChoice } from './poolGatewayChoices';

const NO_CHOICES: readonly PoolGatewayChoice[] = Object.freeze([]);

/** Pool assignment uses the same saved connection, contribution projection and update Action as its detail. */
export function usePoolGatewayChoices(input: Readonly<{
    target: Extract<QualifiedConnectedAccountPurposeBindingTargetV1, { kind: 'group' }>;
    enabled: boolean;
    resolveTarget: () => Readonly<{ machineId: string; serverId: string }> | null;
}>) {
    const scope = useAccountSettingsScope();
    const target = input.resolveTarget();
    const accountMatchesTarget = Boolean(scope && target && areServerProfileIdentifiersEquivalent(scope.serverId, target.serverId));
    const catalog = useProviderCatalog(input.enabled ? scope : null);
    const query = useProviderConnections({ enabled: input.enabled && accountMatchesTarget,
        machineId: target?.machineId ?? null, serverId: target?.serverId ?? scope?.serverId ?? null });
    const choices = React.useMemo(() => catalog?.data && query.data
        ? buildPoolGatewayChoices({ connections: catalog.data.connections, views: query.data.connections, target: input.target })
        : NO_CHOICES, [catalog?.data, query.data, input.target]);
    const declarationsKnown = Boolean(catalog?.data && areProviderGatewayDeclarationsKnown({
        connections: catalog.data.connections, views: query.data?.connections ?? null,
    }));
    const refresh = React.useCallback(async () => {
        await Promise.all([query.refresh(), scope ? refreshProviderCatalog(scope) : Promise.resolve()]);
    }, [query.refresh, scope]);
    const mutation = useProviderConnectionMutation({ resolveTarget: input.resolveTarget, refresh });
    const setEnabled = React.useCallback(async (connectionId: string, enabled: boolean): Promise<boolean> => {
        const choice = choices.find(candidate => candidate.connectionId === connectionId);
        if (!input.enabled || !target || !accountMatchesTarget || catalog?.status !== 'ready' || catalog.stale || !choice) {
            throw createProviderErrorV1('provider_authorization_changed', { connectionId });
        }
        const request = buildPoolGatewayMutation({ choice, target: input.target, enabled, machineId: target.machineId });
        if (!request) return true;
        const result = await mutation.run(request, `gateway:pool:${connectionId}`);
        return result?.status === 'success';
    }, [accountMatchesTarget, catalog?.stale, catalog?.status, choices, input.enabled, input.target, mutation.run, target]);
    return { choices, setEnabled, refresh, loading: query.loading || catalog?.status === 'loading',
        ready: input.enabled && (!target || accountMatchesTarget) && catalog?.status === 'ready' && !catalog.stale && declarationsKnown,
        error: mutation.error ?? query.error,
        pending: choices.some(choice => mutation.isPending(`gateway:pool:${choice.connectionId}`)) };
}
