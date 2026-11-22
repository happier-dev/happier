import * as React from 'react';
import { resolveSavedSecretSlotBindingIdV1 } from '@happier-dev/protocol/providers/settings/operationsV1';
import { buildQualifiedPluginContributionKey, parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { QualifiedConnectedAccountProfileV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { resolveProviderConnectedAccountDeclarationsV1 } from '@happier-dev/protocol/providers/contributions';
import type { ProviderConnectedAccountUsageSourceV1 } from '@happier-dev/protocol/rpc/providers';
import { useProviderCatalogSelection } from '@/sync/store/useProviderCatalog';
import type { ProviderCatalogSnapshot } from '@/sync/store/settings/providerCatalogSnapshot';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { providerDeclarationContext, readAccountProviderDeclaration, readAccountProviderDeclarations, type ProviderDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { presentProviderConnectionUsage } from '@/sync/domains/connectedServices/accountUsage/presentProviderConnectionUsage';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import { providerConnectionUsageAuthority, useProviderConnectionUsage } from './useProviderConnectionUsage';

export function readConnectedAccountProviderUsageSources(input: Readonly<{
    account: QualifiedConnectedAccountRef;
    credentialKind?: QualifiedConnectedAccountProfileV4['kind'];
    context: ProviderDeclarationContext;
    purpose?: ProviderConnectedAccountUsageSourceV1['purpose'];
}>) {
    const serviceKey = buildQualifiedPluginContributionKey(input.account.service);
    const declarations = input.purpose
        ? [readAccountProviderDeclaration(buildQualifiedPluginContributionKey(input.purpose.consumer), input.context)]
        : readAccountProviderDeclarations(input.context);
    return declarations.flatMap(declaration => {
        if (!declaration) return [];
        const consumer = parseQualifiedPluginContributionKey(declaration.contributionKey);
        if (!consumer) return [];
        const { connectedAccounts, requestAuthUses } = resolveProviderConnectedAccountDeclarationsV1({
            identity: consumer, definition: declaration.definition,
        });
        return (declaration.definition.usageSources ?? []).flatMap(source => {
            const purposeId = source.connectedAccount?.purpose;
            if (!purposeId || input.purpose && purposeId !== input.purpose.purpose) return [];
            const purpose = connectedAccounts.find(candidate =>
                candidate.purpose === purposeId
                && buildQualifiedPluginContributionKey(candidate.service) === serviceKey
                && (!input.credentialKind || !candidate.credentialKinds || candidate.credentialKinds.includes(input.credentialKind)));
            if (!purpose) return [];
            const selected = { account: input.account, purpose: { consumer, purpose: purposeId },
                endpointTemplateId: source.endpointTemplateId, usageSourceId: source.id };
            return [{ selected, sources: [source], providerName: declaration.definition.name,
                observationKey: JSON.stringify(['connectedAccount', selected]),
                declarationBasis: stableJsonStringify([source, purpose,
                    declaration.definition.endpointTemplates.find(endpoint => endpoint.id === source.endpointTemplateId),
                    requestAuthUses.find(use => use.purpose === purposeId)]),
            }];
        });
    });
}

/** Mounted only for one expanded source; the full picker never fans out billing reads. */
export function useProviderConnectionUsageForSource(input: Readonly<{
    serverId: string | null;
    machineId: string | null;
    connectionId: string;
    declarationContext?: ProviderDeclarationContext;
    active: boolean;
}>) {
    const activeScope = useAccountSettingsScope();
    const scope = activeScope && input.serverId && areServerProfileIdentifiersEquivalent(activeScope.serverId, input.serverId)
        ? activeScope : null;
    const connection = useProviderCatalogSelection(React.useCallback((snapshot: ProviderCatalogSnapshot | null) => snapshot?.data?.connections.find(row => row.id === input.connectionId) ?? null,
        [input.connectionId]), scope, { enabled: input.active });
    const connectionId = connection?.id;
    const bindings = useProviderCatalogSelection(React.useCallback((snapshot: ProviderCatalogSnapshot | null) => connectionId
        ? snapshot?.data?.secretBindingsByConnectionId[connectionId] : undefined,
    [connectionId]), scope, { enabled: input.active });
    const declarations = useDaemonMergedProjectionInputs({ machineId: input.machineId, serverId: input.serverId,
        sections: ['familiesById.providers'], enabled: input.active && input.declarationContext === undefined && Boolean(input.machineId) });
    const context = input.declarationContext ?? providerDeclarationContext(input.machineId,
        declarations.phase === 'ready' ? declarations.inputs?.pluginProjectionV2 : null);
    const declaration = connection?.source.kind === 'contribution'
        ? readAccountProviderDeclaration(connection.source.contributionKey, context) : null;
    const sources = declaration?.definition.usageSources ?? [];
    const { refreshProviderConnectionUsage } = useProviderActionClient(input.serverId);
    const authority = providerConnectionUsageAuthority({ sources, connection, declaration,
        secretBindings: bindings, machineId: input.machineId });
    // A loading catalog/declaration is not a replacement credential authority.
    // Do not let its placeholder identity retire another surface's admitted read.
    const usage = useProviderConnectionUsage({ scope: sources.length > 0 ? scope : null, connectionId: input.connectionId, machineId: input.machineId,
        ...authority, active: input.active && sources.length > 0, invoke: refreshProviderConnectionUsage });
    const presentation = presentProviderConnectionUsage({ sources, view: usage.view,
        isBillingSlotBound: slot => Boolean(input.machineId && resolveSavedSecretSlotBindingIdV1(bindings, input.machineId, slot)) });
    return { ...usage, presentation, supported: sources.length > 0 };
}
