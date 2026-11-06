import * as React from 'react';
import { resolveSavedSecretSlotBindingIdV1 } from '@happier-dev/protocol/providers/settings/operationsV1';
import { useProviderCatalogSelection } from '@/sync/store/useProviderCatalog';
import type { ProviderCatalogSnapshot } from '@/sync/store/settings/providerCatalogSnapshot';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { providerDeclarationContext, readAccountProviderDeclaration, type ProviderDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import { useProviderActionClient } from '@/providers/actions/useProviderActionClient';
import { presentProviderConnectionUsage } from '@/sync/domains/connectedServices/accountUsage/presentProviderConnectionUsage';
import { providerConnectionUsageAuthority, useProviderConnectionUsage } from './useProviderConnectionUsage';

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
