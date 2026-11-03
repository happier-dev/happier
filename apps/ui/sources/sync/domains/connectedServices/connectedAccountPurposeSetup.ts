import { QualifiedConnectedAccountPurposeV1Schema, type QualifiedConnectedAccountPurposeV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeIdentity';
import { readDeclaredConnectedAccountPurposeV1, resolveConnectedAccountPurposeSelectedAccountV1, resolveConnectedAccountPurposeDefaultTargetV1 } from '@happier-dev/protocol/connect/connectedAccountPurposeSelectionV1';
import type { AccountProfile } from '@happier-dev/protocol/account/profile';
import { qualifiedPurposeKey, type QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { PluginAccountExecutionSelectionV1 } from '@happier-dev/protocol/plugins/availability';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { areServerAccountScopesEqual, createServerAccountScope, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { ConnectedAccountCatalogOperationError } from '@/sync/api/account/connectedAccountCatalogOperationError';

export type ConnectedAccountPurposeSetupRequest = Readonly<{
    scope: ServerAccountScope;
    machineId?: string;
    purpose: QualifiedConnectedAccountPurposeV1;
}>;

export type ConnectedAccountPurposeSetupHandoff = Readonly<{
    request: ConnectedAccountPurposeSetupRequest;
    lifetime: ServerAccountScopeLifetime;
    controller?: ManagedControllerV1;
    occurrenceId: string;
}>;

/** Each setup reads its admitted declaration origin, never a substitute Machine projection. */
export type ConnectedAccountPurposeSetupRuntime = PluginUiProjectionCurrentness | Readonly<{
    accountSelection: Extract<PluginAccountExecutionSelectionV1, { kind: 'available' }>;
    accountLifetime: ServerAccountScopeLifetime;
    readAccountExecution?(pluginId: string): Parameters<typeof resolveConnectedAccountPurposeDefaultTargetV1>[0]['accountServiceSelection'];
    connectedAccountProjection?: PluginUiProjectionCurrentness['connectedAccountProjection'];
}>;

/** Authentication and the returned choice consume the same captured draft context. */
export function resolveConnectedAccountPurposeSetupHandoff(captured: ConnectedAccountPurposeSetupHandoff,
    current: Readonly<{
        activeHandoff: ConnectedAccountPurposeSetupHandoff | null;
        binding: ServerAccountScopeLifetime | null;
        controller?: Readonly<{ machineId: string; installationId?: string | null }>;
        provisioner: MachineProvisionersListResultV1['provisioners'][number] | undefined;
        available: boolean;
    }>): Readonly<{ ok: true; provisioner: MachineProvisionersListResultV1['provisioners'][number] }>
        | Readonly<{ ok: false; error: ConnectedAccountCatalogOperationError }> {
    if (captured !== current.activeHandoff || !captured.lifetime.isCurrent()
        || !areServerAccountScopesEqual(captured.lifetime.scope, captured.request.scope) || !current.binding?.isCurrent()
        || !areServerAccountScopesEqual(captured.request.scope, current.binding.scope)) {
        return { ok: false, error: new ConnectedAccountCatalogOperationError('scope-retired') };
    }
    if (!current.available || current.controller?.machineId !== captured.controller?.machineId
        || current.controller?.installationId !== captured.controller?.installationId
        || captured.request.machineId !== captured.controller?.machineId
        || current.provisioner?.occurrenceId !== captured.occurrenceId
        || !current.provisioner.credentialPurposes?.some(entry => qualifiedPurposeKey(entry.purpose) === qualifiedPurposeKey(captured.request.purpose))) {
        return { ok: false, error: new ConnectedAccountCatalogOperationError('connected_account_purpose_unavailable') };
    }
    return { ok: true, provisioner: current.provisioner };
}

export function buildConnectedAccountPurposeSetupRoute(request: ConnectedAccountPurposeSetupRequest) {
    return { pathname: '/(app)/settings/connected-services/connect' as const, params: {
        purposeConsumerPlugin: request.purpose.consumer.pluginId, purposeConsumerId: request.purpose.consumer.localId,
        purpose: request.purpose.purpose, purposeServerId: request.scope.serverId,
        purposeAccountId: request.scope.accountId,
        ...(request.machineId === undefined ? {} : { purposeMachineId: request.machineId }),
    } };
}

/** Route values request a choice; current Account and Resource facts supply its authority. */
export function readConnectedAccountPurposeSetupRequest(params: Readonly<Record<string, unknown>>): ConnectedAccountPurposeSetupRequest | null {
    const purpose = QualifiedConnectedAccountPurposeV1Schema.safeParse({
        consumer: { pluginId: params.purposeConsumerPlugin, localId: params.purposeConsumerId }, purpose: params.purpose,
    });
    const scope = typeof params.purposeServerId === 'string' && typeof params.purposeAccountId === 'string'
        ? createServerAccountScope(params.purposeServerId, params.purposeAccountId) : null;
    const machineId = params.purposeMachineId === undefined ? undefined
        : typeof params.purposeMachineId === 'string' && params.purposeMachineId.trim()
            ? params.purposeMachineId.trim() : null;
    return purpose.success && scope && machineId !== null
        ? { purpose: purpose.data, scope, ...(machineId === undefined ? {} : { machineId }) } : null;
}

function readSetupDeclarationInput(request: ConnectedAccountPurposeSetupRequest | null,
    viewer: ServerAccountScope | null, runtime: ConnectedAccountPurposeSetupRuntime | null): Parameters<typeof readDeclaredConnectedAccountPurposeV1>[0] | null {
    if (!request || !runtime || !areServerAccountScopesEqual(viewer, request.scope)) return null;
    if ('accountSelection' in runtime) {
        if (request.machineId !== undefined || !runtime.accountLifetime.isCurrent()
            || !areServerAccountScopesEqual(runtime.accountLifetime.scope, request.scope)) return null;
        return { purpose: request.purpose, accountSelection: runtime.accountSelection };
    }
    if (runtime.serverId !== request.scope.serverId
        || runtime.machineId !== request.machineId || runtime.phase !== 'current' || !runtime.interactionEnabled) return null;
    return runtime.pluginUiProjection ? {
        purpose: request.purpose, projection: runtime.pluginUiProjection,
        machineProvisionersById: runtime.pluginUiProjection.machineProvisionersById,
    } : null;
}

export function readConnectedAccountPurposeSetupDeclaration(request: ConnectedAccountPurposeSetupRequest | null,
    viewer: ServerAccountScope | null, runtime: ConnectedAccountPurposeSetupRuntime | null) {
    const input = readSetupDeclarationInput(request, viewer, runtime);
    return input ? readDeclaredConnectedAccountPurposeV1(input) : null;
}

/** The same purpose resolver used by mounted widgets admits the chosen active personal target. */
export function resolveConnectedAccountPurposeSetupSelectedAccount(input: Readonly<{
    request: ConnectedAccountPurposeSetupRequest | null; viewer: ServerAccountScope | null;
    runtime: ConnectedAccountPurposeSetupRuntime | null; profile: AccountProfile;
    target: QualifiedConnectedAccountPurposeBindingTargetV1 | null;
}>) {
    const declared = readConnectedAccountPurposeSetupDeclaration(input.request, input.viewer, input.runtime);
    const runtime = input.runtime;
    if (!declared || !input.request || !runtime || input.profile.id !== input.request.scope.accountId) return null;
    // This journey repairs a missing connection, not the independent clear-default action.
    if (!input.target) return null;
    return resolveConnectedAccountPurposeSelectedAccountV1({ purpose: input.request.purpose, serviceRefs: declared.serviceRefs,
        bindings: { v: 1, bindings: [{ purpose: input.request.purpose, target: input.target }] },
        accounts: input.profile.connectedAccountsV4, groups: input.profile.connectedAccountGroupsV4, now: Date.now(),
        readAuthentication: service => runtime.connectedAccountProjection?.kind === 'ready'
            ? runtime.connectedAccountProjection.descriptors.find(descriptor => descriptor.pluginId === service.pluginId
                && descriptor.id === service.localId && descriptor.availability.state === 'available')?.authentication ?? null : null,
    });
}

/** Provisioner setup returns an explicit input choice rather than writing a default. */
export function isConnectedAccountPurposeSetupTargetCurrent(input: Parameters<typeof resolveConnectedAccountPurposeSetupSelectedAccount>[0]): boolean {
    const declaration = readSetupDeclarationInput(input.request, input.viewer, input.runtime);
    if (!declaration || !input.request || !input.target || input.profile.id !== input.request.scope.accountId) return false;
    const descriptors = input.runtime?.connectedAccountProjection;
    return resolveConnectedAccountPurposeDefaultTargetV1({ declaration, target: input.target,
        accountServiceSelection: input.target.kind === 'group' && input.runtime && 'accountSelection' in input.runtime
            ? input.runtime.readAccountExecution?.(input.target.service.pluginId) : undefined,
        accounts: input.profile.connectedAccountsV4, groups: input.profile.connectedAccountGroupsV4, now: Date.now(),
        readAuthentication: service => descriptors?.kind === 'ready' ? descriptors.descriptors.find(entry =>
            entry.pluginId === service.pluginId && entry.id === service.localId && entry.availability.state === 'available')?.authentication ?? null : null,
    }) !== null;
}
