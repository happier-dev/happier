import * as React from 'react';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';

import { useProjectedConnectedServicesRegistry, useProjectedPluginLocalizedTextResolver } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolveQualifiedConnectedServiceRegistryDisplayName } from '@/components/settings/connectedServices/model/resolveConnectedServiceDisplayName';
import type { QualifiedConnectedAccountTargetPresentation } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { resolveMachineRpcTargetServerId } from '@/sync/runtime/orchestration/serverScopedRpc/resolveMachineRpcTargetServerId';
import { t } from '@/text';

import {
    useQualifiedConnectedAccountTargetPresentations,
    type QualifiedConnectedAccountPresentationTarget,
} from './useQualifiedConnectedAccountTargetPresentations';

export type ProjectedQualifiedConnectedAccountTarget = Readonly<{
    /** Caller-owned row identity, not a visible account or purpose label. */
    key: string;
    target: QualifiedConnectedAccountPurposeBindingTargetV1;
}>;

/**
 * Display names for recorded or configured Account/pool targets on one Home: the Account profile read, the
 * service title from the projected connected-services registry (only while it belongs to the active
 * scope) and the one target presentation rule. Display only; it never authorizes using a target.
 */
export function useProjectedQualifiedConnectedAccountTargetPresentations(
    serverId: string | null | undefined,
    targets: readonly ProjectedQualifiedConnectedAccountTarget[],
): Readonly<{
    presentationsByKey: Readonly<Record<string, QualifiedConnectedAccountTargetPresentation>>;
    serviceTitleByKey: Readonly<Record<string, string>>;
    loading: boolean;
}> {
    const resolvedServerId = resolveMachineRpcTargetServerId(serverId) ?? null;
    const requestedServerIds = React.useMemo(
        () => targets.length > 0 && resolvedServerId ? [resolvedServerId] : [],
        [resolvedServerId, targets.length],
    );
    const bindings = useServerCredentialAccountScopeBindings(requestedServerIds);
    const binding = React.useMemo(() => [...bindings.values()][0] ?? null, [bindings]);
    const activeScope = useActiveServerAccountScope();
    const registry = useProjectedConnectedServicesRegistry();
    const localize = useProjectedPluginLocalizedTextResolver();
    const registryMatchesScope = binding !== null && areServerAccountScopesEqual(binding.scope, activeScope);
    const titled = React.useMemo(() => targets.map((entry): QualifiedConnectedAccountPresentationTarget => ({
        ...entry,
        serviceTitle: resolveQualifiedConnectedServiceRegistryDisplayName(
            registryMatchesScope ? registry : { entries: [] },
            entry.target.kind === 'group' ? entry.target.service : entry.target.account.service,
            t,
            registryMatchesScope ? localize : undefined,
        ),
    })), [localize, registry, registryMatchesScope, targets]);
    const { presentationsByKey, loading } = useQualifiedConnectedAccountTargetPresentations({ binding, targets: titled });
    const serviceTitleByKey = React.useMemo(
        () => Object.fromEntries(titled.map(entry => [entry.key, entry.serviceTitle ?? ''])),
        [titled],
    );
    return { presentationsByKey, serviceTitleByKey, loading };
}
