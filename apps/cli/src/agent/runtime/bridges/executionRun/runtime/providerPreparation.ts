import type { ProviderBoundModelRef, TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol';

import { traceRunPreparationPhase } from '@/providers/diagnostics';
import type { AccountSettingsSnapshotResolver } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { SessionTeamCredentialLaunchUnavailableError } from '@/session/services/sessionTeamCredentialLaunchError';

import { executionRunContributionSnapshotUnavailable } from '../contributionSnapshotLease';
import type { ExecutionRunRetainedInteractionScope } from '../retainedInteractionEligibility';
import {
    prepareExecutionRunProviderLaunch,
    type ExecutionRunProviderLaunchServices,
    type PreparedExecutionRunProviderLaunch,
} from './providerLaunch';

/** Session runners consume their pinned daemon service. Native Team delivery
 * never acquires guest-local preparation or detached Run custody. */
export function assertExecutionRunProviderLaunchPlacement(input: Readonly<{
    scope: ExecutionRunRetainedInteractionScope;
    selection?: ProviderBoundModelRef;
    teamCredentialModel?: Pick<TeamCredentialProviderModelSelectionV1, 'deliveryMode'>;
    providerLaunch?: ExecutionRunProviderLaunchServices;
}>): void {
    const isNativeTeamDelivery = input.teamCredentialModel?.deliveryMode === 'vendor-native';
    if (isNativeTeamDelivery && input.scope === 'detached') {
        throw new SessionTeamCredentialLaunchUnavailableError();
    }
    if (input.scope === 'session_owned' && (input.selection?.providerConnectionId || isNativeTeamDelivery) && !input.providerLaunch) {
        throw executionRunContributionSnapshotUnavailable();
    }
}

type RuntimeProviderPreparation = Omit<Parameters<typeof prepareExecutionRunProviderLaunch>[0],
    'featureEnabled' | 'accountSettingsSnapshot' | 'savedSecretOperationContext'> & Readonly<{
    scope: ExecutionRunRetainedInteractionScope;
    controllerOccurrenceId?: string;
    providerLaunch?: ExecutionRunProviderLaunchServices;
    resolveProvidersFeatureEnabled?: () => boolean | Promise<boolean>;
    resolveAccountSettingsSnapshot?: AccountSettingsSnapshotResolver;
}>;

export async function prepareExecutionRunRuntimeProviderLaunch(
    input: RuntimeProviderPreparation,
): Promise<PreparedExecutionRunProviderLaunch> {
    assertExecutionRunProviderLaunchPlacement(input);
    const { scope: _scope, controllerOccurrenceId, providerLaunch, resolveProvidersFeatureEnabled,
        resolveAccountSettingsSnapshot, ...preparation } = input;
    const trace = <T>(phase: Parameters<typeof traceRunPreparationPhase>[1], work: () => T | Promise<T>) =>
        traceRunPreparationPhase(input.runId, phase, input.signal, work);
    const featureEnabled = !input.selection || input.selection.providerConnectionId === null
        || await trace('provider_features', () => resolveProvidersFeatureEnabled?.()) === true;
    const accountSettingsSnapshot = await trace('account_snapshot', () => resolveAccountSettingsSnapshot?.()) ?? null;
    const selection = input.selection;
    const nativeTeam = input.teamCredentialModel?.deliveryMode === 'vendor-native' ? input.teamCredentialModel : undefined;
    if (providerLaunch && (selection?.providerConnectionId || nativeTeam)) {
        const expectedAccountSettingsScopeKey = accountSettingsSnapshot?.scopeKey;
        if (!expectedAccountSettingsScopeKey) {
            if (nativeTeam) throw new SessionTeamCredentialLaunchUnavailableError();
            throw Object.assign(new Error('provider_connection_not_found'), { code: 'provider_connection_not_found' });
        }
        const prepared = await trace('provider_launch', () => providerLaunch.prepareLaunch({
            selection: nativeTeam ? { agentTargetKey: nativeTeam.agentTargetKey,
                providerConnectionId: null, modelId: nativeTeam.modelId } : selection!,
            ...(nativeTeam ? { teamCredentialModel: nativeTeam } : {}),
            backendTarget: input.backendTarget,
            agentId: input.agentId, runId: input.runId,
            ...(controllerOccurrenceId ? { controllerOccurrenceId } : {}),
            connectedServices: input.connectedServices ?? null,
            expectedAccountSettingsScopeKey,
        }, input.signal));
        if (prepared.cleanupOnExit) input.retainCleanup?.(prepared.cleanupOnExit);
        return prepared;
    }
    return await trace('provider_launch', () => prepareExecutionRunProviderLaunch({
        ...preparation, featureEnabled, accountSettingsSnapshot,
        savedSecretOperationContext: resolveAccountSettingsSnapshot?.readOperationContext?.() ?? undefined,
    }));
}
