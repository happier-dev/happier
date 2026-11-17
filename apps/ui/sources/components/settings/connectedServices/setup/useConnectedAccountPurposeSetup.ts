import * as React from 'react';
import { isConnectedAccountSignedOut } from '@/sync/domains/connectedServices/parseDisplayableCredentialHealthStatus';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { qualifiedPurposeKey, type QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { projectConnectedAccountDescriptorV1 } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { useActiveServerAccountScope, useProfile } from '@/sync/store/hooks';
import { useConnectedAccountPurposeDefaults } from '@/hooks/server/connectedServices/useConnectedAccountPurposeDefaults';
import { ConnectedAccountCatalogOperationError } from '@/sync/api/account/apiConnectedAccountCatalog';
import { getStorage } from '@/sync/domains/state/storageStore';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { readConnectedAccountPurposeSetupDeclaration, resolveConnectedAccountPurposeSetupSelectedAccount, resolveConnectedAccountPurposeSetupPlacement,
    type ConnectedAccountPurposeSetupRequest, type ConnectedAccountPurposeSetupRuntime } from '@/sync/domains/connectedServices/connectedAccountPurposeSetup';
import { usePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import { projectConnectedServiceRegistryEntries, type ConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { connectedAccountPurposeServiceTargets } from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';
import { t } from '@/text';
import type { ConnectedAccountSetupFacts } from '../account/useConnectedAccountSetupCompletion';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { readConnectedServiceSettingsErrorDetailsCode, readConnectedServiceSettingsErrorRequestId,
    resolveConnectedServiceSettingsErrorMessage } from '../connectedServiceSettingsErrors';

function presentPurposeSetupFailure(error: unknown): void {
    const requestId = readConnectedServiceSettingsErrorRequestId(error);
    alertActionFailure({ reason: resolveConnectedServiceSettingsErrorMessage(error),
        code: readConnectedServiceSettingsErrorDetailsCode(error),
        ...(requestId ? { context: { requestId } } : {}) });
}

/** Purpose admission, returned selections and Resource-default settlement share one owner. */
export function useConnectedAccountPurposeSetup(input: Readonly<{
    request: ConnectedAccountPurposeSetupRequest | null;
    selectedTarget?: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
    onSelected?: (account: QualifiedConnectedAccountRef, kind: 'selected' | 'connected', facts?: ConnectedAccountSetupFacts) => void | Promise<void>;
    onSettled?: (account: QualifiedConnectedAccountRef, kind: 'selected' | 'connected', facts?: ConnectedAccountSetupFacts) => void | Promise<void>;
    onClose: () => void;
}>) {
    const requested = input.request;
    const pluginId = requested?.purpose.consumer.pluginId;
    const accountReader = usePluginAccountAvailabilityReader(requested?.scope, pluginId,
        { enabled: Boolean(requested) });
    const accountSelection = pluginId ? accountReader?.readCurrentAccountExecution(pluginId) : null;
    const placement = React.useMemo(() => resolveConnectedAccountPurposeSetupPlacement(requested, accountSelection),
        [requested, accountSelection]);
    const request = placement?.request ?? null;
    const viewer = useActiveServerAccountScope();
    const profile = useProfile(profile => request ? ({ id: profile.id, connectedAccountsV4: profile.connectedAccountsV4,
        connectedAccountGroupsV4: profile.connectedAccountGroupsV4 }) : null,
        request ? ['id', 'connectedAccountsV4', 'connectedAccountGroupsV4'] : []);
    const { catalog: purposeCatalog, mutateDefaults, execution } = useConnectedAccountPurposeDefaults(undefined,
        { enabled: Boolean(request) && !input.onSelected });
    const lifetime = React.useMemo(() => captureActiveServerAccountScopeLifetime(), [viewer]);
    const accountRequest = placement?.kind === 'account';
    React.useEffect(() => {
        if (requested && pluginId && accountReader && accountSelection?.kind === 'unavailable'
            && accountSelection.code === 'plugin_ui_declaration_pending') void accountReader.ensureCurrentAccountExecution(pluginId);
    }, [requested, pluginId, accountReader, accountSelection?.kind,
        accountSelection?.kind === 'unavailable' ? accountSelection.code : null]);
    const machineRuntime = useScopedPluginUiProjection({ machineId: request?.machineId, serverId: request?.scope.serverId,
        enabled: Boolean(request) && !accountRequest, includeConnectedAccountPurposes: Boolean(request) && !accountRequest });
    const accountDescriptors = accountRequest ? accountReader?.readAccountUiProjection()?.connectedAccountDescriptorsById : null;
    const connectedAccountProjection = React.useMemo(() => accountRequest ? { kind: 'ready' as const,
        descriptors: Object.values(accountDescriptors ?? {}).map(({ pluginId, definition, hostAccountOrigin, nativeLoginRequiredBy }) =>
            projectConnectedAccountDescriptorV1({ descriptor: definition, pluginId, serviceId: definition.id,
                nativeLoginRequiredBy,
                provenance: hostAccountOrigin.sourceCustody.kind === 'bundled_first_party' ? 'first_party' : 'external',
                sourceKind: hostAccountOrigin.sourceCustody.kind === 'bundled_first_party' ? 'bundled' : 'account_release',
                availability: { state: 'available', reason: 'account_declaration' }, diagnostics: [] })) }
        : machineRuntime.connectedAccountProjection, [accountRequest, accountDescriptors, machineRuntime.connectedAccountProjection]);
    // Account placement consumes the admitted Account manifest.
    const runtime: ConnectedAccountPurposeSetupRuntime | null = accountRequest
        ? accountSelection?.kind === 'available' && lifetime ? { accountSelection, accountLifetime: lifetime, connectedAccountProjection,
            readAccountExecution: accountReader?.readCurrentAccountExecution } : null
        : machineRuntime;
    const latestRuntime = React.useRef(runtime);
    latestRuntime.current = runtime;
    const declaration = readConnectedAccountPurposeSetupDeclaration(request, viewer, runtime);
    const registry = React.useMemo<ConnectedServiceRegistrySnapshot | undefined>(() => {
        if (!request) return undefined;
        const descriptors = connectedAccountProjection;
        const state = { scopeKey: JSON.stringify([request.scope, request.machineId]),
            status: (accountRequest ? accountSelection?.kind === 'available' : machineRuntime.phase === 'current')
                && descriptors?.kind === 'ready' ? 'ready' as const : 'loading' as const,
            descriptors: descriptors?.kind === 'ready' ? descriptors.descriptors : [], conflicts: [], errorReason: null };
        return { ...state, entries: projectConnectedServiceRegistryEntries(state) };
    }, [request, accountRequest, accountSelection?.kind, machineRuntime.phase, connectedAccountProjection]);
    const select = async (next: QualifiedConnectedAccountPurposeBindingTargetV1 | null,
        kind: 'selected' | 'connected' = 'selected', facts?: ConnectedAccountSetupFacts): Promise<QualifiedConnectedAccountRef | null> => {
        if (!request) return null;
        try {
            const selected = resolveConnectedAccountPurposeSetupSelectedAccount({ request,
                viewer: getActiveServerAccountScope(), runtime: latestRuntime.current,
                profile: getStorage().getState().profile, target: next });
            if (lifetime?.isCurrent() !== true) throw new ConnectedAccountCatalogOperationError('scope-retired');
            if (!selected || !next) throw new ConnectedAccountCatalogOperationError('connected_account_purpose_unavailable');
            if (input.onSelected) await input.onSelected(selected.ref, kind, facts);
            else {
                if (!declaration || declaration.consumerKind === 'machineProvisioner') throw new ConnectedAccountCatalogOperationError('connected_account_purpose_unavailable');
                await mutateDefaults({ kind: 'resource', input: { machineId: request.machineId, purpose: request.purpose, target: next } });
                if (lifetime?.isCurrent()) {
                    if (input.onSettled) await input.onSettled(selected.ref, kind, facts);
                    else input.onClose();
                }
            }
            return selected.ref;
        } catch (error) {
            presentPurposeSetupFailure(error);
            return null;
        }
    };
    const onConnected = (account: QualifiedConnectedAccountRef, facts?: ConnectedAccountSetupFacts) => {
        // Authentication settling refreshes the canonical Account inventory before selection.
        void (async () => {
            try {
                if (!lifetime?.isCurrent()) return;
                await getSyncSingleton().refreshProfile();
                if (lifetime.isCurrent()) await select({ kind: 'account', account }, 'connected', facts);
            } catch (error) { presentPurposeSetupFailure(error); }
        })();
    };
    const selected = input.onSelected ? input.selectedTarget ?? null
        : request ? purposeCatalog.value?.bindings.find(binding => qualifiedPurposeKey(binding.purpose) === qualifiedPurposeKey(request.purpose))?.target ?? null : null;
    const reconnectAccounts = input.onSelected && declaration && profile ? profile.connectedAccountsV4.filter(account => isConnectedAccountSignedOut(account.status)
        || account.status === 'refresh_failed_retryable').filter(account => declaration.serviceRefs.some(service =>
            service.pluginId === account.ref.service.pluginId && service.localId === account.ref.service.localId)) : [];
    const profileRead = typeof profile?.id === 'string' && profile.id.trim() === viewer?.accountId;
    const hasTargetsToChoose = (service: PluginContributionIdentityV1) => {
        if (selected !== null || !profileRead) return true;
        const targets = connectedAccountPurposeServiceTargets(profile?.connectedAccountsV4 ?? [], profile?.connectedAccountGroupsV4 ?? [], service);
        return targets.accounts.length > 0 || targets.groups.length > 0;
    };
    const filterCatalog = <Entry extends Readonly<{ service: PluginContributionIdentityV1 }>>(catalog: readonly Entry[]): Entry[] => catalog.filter(entry => !request ||
        declaration?.serviceRefs.some(service => service.pluginId === entry.service.pluginId && service.localId === entry.service.localId));
    const loading = accountRequest ? accountSelection?.kind === 'unavailable' && accountSelection.code === 'plugin_ui_declaration_pending'
        : machineRuntime.phase === 'establishing';
    const unavailableReason = !request ? null
        : profile?.id !== request.scope.accountId ? 'profile_account_mismatch' as const
        : loading ? null
        : !declaration ? 'purpose_unavailable' as const
        : declaration.consumerKind === 'machineProvisioner' && !input.onSelected ? 'purpose_requires_selection' as const
        : null;
    return {
        registry, declaration, selected, reconnectAccounts,
        selectableServices: declaration?.serviceRefs.filter(hasTargetsToChoose) ?? [],
        unavailableReason,
        loading,
        selectionDisabled: !input.onSelected && (purposeCatalog.status !== 'ready' || purposeCatalog.stale),
        selectionDisabledReason: input.onSelected || purposeCatalog.status === 'ready' && !purposeCatalog.stale ? undefined
            : t(purposeCatalog.status === 'loading' ? 'common.loading' : 'common.unavailable'),
        select, onConnected, filterCatalog, execution,
    };
}
