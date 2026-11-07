import * as React from 'react';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { useProviderCatalog } from '@/sync/store/useProviderCatalog';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { refreshProviderCatalog } from '@/sync/engine/settings/providerCatalogEngine';
import { getProviderCatalogSnapshot } from '@/sync/store/settings/providerCatalogSnapshot';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useProviderConnectionMutation } from '@/providers/hooks/useProviderConnectionMutation';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createProviderGateway, chooseProviderGatewayContributionV1 } from '@/providers/connection/gatewayConfiguration';
import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import { areProviderGatewayDeclarationsKnown, buildProviderGatewayCollection } from '../../providers/collection/providerCollectionModel';
import { buildPoolGatewayChoices, buildPoolGatewayMutation, type PoolGatewayChoice } from './poolGatewayChoices';

const NO_CHOICES: readonly PoolGatewayChoice[] = Object.freeze([]);
const FIRST_GATEWAY_KEY = 'gateway:pool:first';

/** Pool assignment uses the same saved connection, contribution projection and update Action as its detail. */
export function usePoolGatewayChoices(input: Readonly<{
    target: Extract<QualifiedConnectedAccountPurposeBindingTargetV1, { kind: 'group' }>;
    enabled: boolean;
    accountServerId: string | null;
    accountAddressAvailable: boolean;
    resolveTarget: () => Readonly<{ machineId: string; serverId: string }> | null;
}>) {
    const scope = useAccountSettingsScope();
    const accountMatchesTarget = Boolean(scope && input.accountAddressAvailable && input.accountServerId
        && areServerProfileIdentifiersEquivalent(scope.serverId, input.accountServerId));
    const catalog = useProviderCatalog(input.enabled ? scope : null);
    const choices = React.useMemo(() => accountMatchesTarget && catalog?.data
        ? buildPoolGatewayChoices({ connections: catalog.data.connections, target: input.target })
        : NO_CHOICES, [accountMatchesTarget, catalog?.data, input.target]);
    const gatewayContributionChoice = React.useMemo(() => chooseProviderGatewayContributionV1(
        readAccountProviderDeclarations({ kind: 'account' }), { service: input.target.service }), [input.target.service]);
    const newGatewayAvailable = React.useMemo(() => {
        if (!accountMatchesTarget || !catalog?.data) return false;
        const saved = { connections: catalog.data.connections, declarationContext: { kind: 'account' as const },
            accountGrants: catalog.data.accountGrants };
        return areProviderGatewayDeclarationsKnown(saved) && buildProviderGatewayCollection(saved).length === 0;
    }, [accountMatchesTarget, catalog?.data]);
    // No gateway yet (D19): the switch stays, and turning it on creates the first one with this pool.
    const firstGateway = React.useMemo(() => {
        // Pool configuration is Account-only; it has no selected declaration Machine.
        const contribution = gatewayContributionChoice.status === 'selected' ? gatewayContributionChoice.contribution : null;
        if (!newGatewayAvailable || !contribution) return null;
        const serviceKey = buildQualifiedPluginContributionKey(input.target.service);
        const slot = contribution.purposes.find(purpose => buildQualifiedPluginContributionKey(purpose.service) === serviceKey);
        return slot ? { purpose: slot.purpose } : null;
    }, [gatewayContributionChoice, input.target, newGatewayAvailable]);
    const allocatedConnectionId = React.useMemo(() => newGatewayAvailable && gatewayContributionChoice.status !== 'unavailable'
        ? `pc_${randomUUID()}` : null, [gatewayContributionChoice, newGatewayAvailable, scope]);
    const refresh = React.useCallback(async () => {
        if (scope) await refreshProviderCatalog(scope);
    }, [scope]);
    const mutation = useProviderConnectionMutation({ resolveTarget: input.resolveTarget, serverId: input.accountServerId,
        initiatingLifetime: accountMatchesTarget ? undefined : null, refresh });
    const { clearError } = mutation;
    // An unknown outcome asks for a fresh read, never a second write; once the catalog is current again the question is answered.
    const reviewCurrentState = React.useCallback(async (): Promise<void> => {
        if (!scope) return;
        try { await refreshProviderCatalog(scope); } catch { return; }
        const snapshot = getProviderCatalogSnapshot(scope);
        if (snapshot?.status === 'ready' && !snapshot.stale) clearError();
    }, [clearError, scope]);
    const setEnabled = React.useCallback(async (connectionId: string, enabled: boolean): Promise<boolean> => {
        const choice = choices.find(candidate => candidate.connectionId === connectionId);
        if (!input.enabled || !accountMatchesTarget || catalog?.status !== 'ready' || catalog.stale || !choice) {
            throw createProviderErrorV1('provider_authorization_changed', { connectionId });
        }
        const request = buildPoolGatewayMutation({ choice, target: input.target, enabled });
        if (!request) return true;
        const result = await mutation.run(request, `gateway:pool:${connectionId}`);
        return result?.status === 'success';
    }, [accountMatchesTarget, catalog?.stale, catalog?.status, choices, input.enabled, input.target, mutation.run]);
    const createFirstGateway = React.useCallback(async (contributionKey?: string): Promise<boolean> => {
        const selected = chooseProviderGatewayContributionV1(readAccountProviderDeclarations({ kind: 'account' }), {
            service: input.target.service, contributionKey,
        });
        if (selected.status !== 'selected') return false;
        const contribution = selected.contribution;
        const slot = contribution.purposes.find(purpose => purpose.service.pluginId === input.target.service.pluginId
            && purpose.service.localId === input.target.service.localId);
        if (!input.enabled || !accountMatchesTarget || catalog?.status !== 'ready' || catalog.stale
            || !newGatewayAvailable || !slot || !allocatedConnectionId) {
            throw createProviderErrorV1('provider_authorization_changed');
        }
        const created = await createProviderGateway({ run: mutation.run, contribution, connectionId: allocatedConnectionId,
            displayName: t('settingsProvidersCollection.gateway.mainGatewayName'),
            slot: { purpose: slot.purpose, target: input.target }, key: FIRST_GATEWAY_KEY });
        return created !== null;
    }, [accountMatchesTarget, allocatedConnectionId, catalog?.stale, catalog?.status, input.enabled, input.target, mutation.run, newGatewayAvailable]);
    return { choices, setEnabled, firstGateway, gatewayContributionChoice, createFirstGateway, refresh, loading: catalog?.status === 'loading',
        ready: input.enabled && accountMatchesTarget && catalog?.status === 'ready' && !catalog.stale,
        error: mutation.error, retry: mutation.retry, reviewCurrentState, pendingApproval: mutation.pendingApproval,
        pending: mutation.isPending(FIRST_GATEWAY_KEY) || choices.some(choice => mutation.isPending(`gateway:pool:${choice.connectionId}`)) };
}
