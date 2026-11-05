import * as React from 'react';
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
import { readConnectedAccountPurposeSetupDeclaration, resolveConnectedAccountPurposeSetupSelectedAccount,
    type ConnectedAccountPurposeSetupRequest, type ConnectedAccountPurposeSetupRuntime } from '@/sync/domains/connectedServices/connectedAccountPurposeSetup';
import { usePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import { projectConnectedServiceRegistryEntries, type ConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { connectedAccountPurposeServiceTargets } from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';
import { Modal } from '@/modal';
import { t } from '@/text';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { resolveConnectedServiceSettingsErrorMessage } from '../connectedServiceSettingsErrors';

/** Purpose admission, returned selections and Resource-default settlement share one owner. */
export function useConnectedAccountPurposeSetup(input: Readonly<{
    request: ConnectedAccountPurposeSetupRequest | null;
    selectedTarget?: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
    onSelected?: (account: QualifiedConnectedAccountRef, kind: 'selected' | 'connected') => void | Promise<void>;
    onSettled?: (account: QualifiedConnectedAccountRef, kind: 'selected' | 'connected') => void | Promise<void>;
    onClose: () => void;
}>) {
    const { request } = input;
    const viewer = useActiveServerAccountScope();
    const profile = useProfile(profile => request ? ({ id: profile.id, connectedAccountsV4: profile.connectedAccountsV4,
        connectedAccountGroupsV4: profile.connectedAccountGroupsV4 }) : null);
    const { catalog: purposeCatalog, mutateDefaults, execution } = useConnectedAccountPurposeDefaults(undefined,
        { enabled: Boolean(request) && !input.onSelected });
    const lifetime = React.useMemo(() => captureActiveServerAccountScopeLifetime(), [viewer]);
    const accountRequest = Boolean(request && request.machineId === undefined);
    const pluginId = request?.purpose.consumer.pluginId;
    const accountReader = usePluginAccountAvailabilityReader(accountRequest ? request?.scope : null, pluginId,
        { enabled: accountRequest });
    const accountSelection = accountRequest && pluginId ? accountReader?.readCurrentAccountExecution(pluginId) : null;
    React.useEffect(() => {
        if (accountRequest && pluginId && accountReader && accountSelection?.kind === 'unavailable'
            && accountSelection.code === 'plugin_ui_declaration_pending') void accountReader.ensureCurrentAccountExecution(pluginId);
    }, [accountRequest, pluginId, accountReader, accountSelection?.kind,
        accountSelection?.kind === 'unavailable' ? accountSelection.code : null]);
    const machineRuntime = useScopedPluginUiProjection({ machineId: request?.machineId, serverId: request?.scope.serverId,
        enabled: Boolean(request) && !accountRequest, includeConnectedAccountPurposes: Boolean(request) && !accountRequest });
    const accountDescriptors = accountRequest ? accountReader?.readAccountUiProjection()?.connectedAccountDescriptorsById : null;
    const connectedAccountProjection = React.useMemo(() => accountRequest ? { kind: 'ready' as const,
        descriptors: Object.values(accountDescriptors ?? {}).map(({ pluginId, definition, hostAccountOrigin }) =>
            projectConnectedAccountDescriptorV1({ descriptor: definition, pluginId, serviceId: definition.id,
                provenance: hostAccountOrigin.sourceCustody.kind === 'bundled_first_party' ? 'first_party' : 'external',
                sourceKind: hostAccountOrigin.sourceCustody.kind === 'bundled_first_party' ? 'bundled' : 'account_release',
                availability: { state: 'available', reason: 'account_declaration' }, diagnostics: [] })) }
        : machineRuntime.connectedAccountProjection, [accountRequest, accountDescriptors, machineRuntime.connectedAccountProjection]);
    // A Machine-less purpose consumes the admitted Account manifest, never a substitute daemon.
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
        kind: 'selected' | 'connected' = 'selected'): Promise<QualifiedConnectedAccountRef | null> => {
        if (!request) return null;
        try {
            const selected = resolveConnectedAccountPurposeSetupSelectedAccount({ request,
                viewer: getActiveServerAccountScope(), runtime: latestRuntime.current,
                profile: getStorage().getState().profile, target: next });
            if (lifetime?.isCurrent() !== true) throw new ConnectedAccountCatalogOperationError('scope-retired');
            if (!selected || !next) throw new ConnectedAccountCatalogOperationError('connected_account_purpose_unavailable');
            if (input.onSelected) await input.onSelected(selected.ref, kind);
            else {
                if (!declaration || declaration.consumerKind === 'machineProvisioner') throw new ConnectedAccountCatalogOperationError('connected_account_purpose_unavailable');
                await mutateDefaults({ kind: 'resource', input: { machineId: request.machineId, purpose: request.purpose, target: next } });
                if (lifetime?.isCurrent()) {
                    if (input.onSettled) await input.onSettled(selected.ref, kind);
                    else input.onClose();
                }
            }
            return selected.ref;
        } catch (error) {
            Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(error));
            return null;
        }
    };
    const onConnected = (account: QualifiedConnectedAccountRef) => {
        // Authentication settling refreshes the canonical Account inventory before selection.
        void (async () => {
            try {
                if (!lifetime?.isCurrent()) return;
                await getSyncSingleton().refreshProfile();
                if (lifetime.isCurrent()) await select({ kind: 'account', account }, 'connected');
            } catch (error) { Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(error)); }
        })();
    };
    const selected = input.onSelected ? input.selectedTarget ?? null
        : request ? purposeCatalog.value?.bindings.find(binding => qualifiedPurposeKey(binding.purpose) === qualifiedPurposeKey(request.purpose))?.target ?? null : null;
    const reconnectAccounts = input.onSelected && declaration && profile ? profile.connectedAccountsV4.filter(account => account.status === 'needs_reauth'
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
    const unavailableReason = !request ? null
        : profile?.id !== request.scope.accountId ? 'profile_account_mismatch' as const
        : !declaration ? 'purpose_unavailable' as const
        : declaration.consumerKind === 'machineProvisioner' && !input.onSelected ? 'purpose_requires_selection' as const
        : null;
    return {
        registry, declaration, selected, reconnectAccounts,
        selectableServices: declaration?.serviceRefs.filter(hasTargetsToChoose) ?? [],
        unavailableReason,
        loading: accountRequest ? accountSelection?.kind === 'unavailable' && accountSelection.code === 'plugin_ui_declaration_pending'
            : machineRuntime.phase === 'establishing',
        selectionDisabled: !input.onSelected && (purposeCatalog.status !== 'ready' || purposeCatalog.stale),
        selectionDisabledReason: input.onSelected || purposeCatalog.status === 'ready' && !purposeCatalog.stale ? undefined
            : t(purposeCatalog.status === 'loading' ? 'common.loading' : 'common.unavailable'),
        select, onConnected, filterCatalog, execution,
    };
}
