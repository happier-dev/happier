import { PluginError, type JsonValue, type PluginContributionRef } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext, AdmittedTargetedOperationExecutionHandle, AdmittedTargetedOperationExecutionOptions, ActionExecutionOptions } from '@happier-dev/plugin-sdk/actions';
import { createManifestTargetedContributionsService, requireAdmittedTargetedOperationExecutionBinding, resolveAdmittedTargetedOperationInput, validateTargetedOperationInput, validateTargetedOperationResult } from '@happier-dev/cli-common/plugins/registration';
import { createPluginActionHandlerNotStartedError } from '@happier-dev/cli-common/plugins/registration/actionHandlerInvocation';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { createPluginUiAccountStorageScope } from '@/sync/api/plugins/data/pluginUiDataClient';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { createUiAccountActionSettingsService } from '@/sync/domains/plugins/settings/accountActionSettings';
import { createPluginSurfaceTargetedDeclarationSource } from './pluginSurfaceTargetedDeclarations';
import { observePluginSurfaceActionRead } from './pluginSurfaceActionReadObservation';
import type { DispatchPluginSurfaceActionInput } from './pluginSurfaceActionDispatch';
import type { PluginSourceCustodyV1 } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { createPluginSurfaceAccountNetworkServices } from './pluginSurfaceAccountNetworkServices';
import { createUiConnectedAccountActionServices } from '@/sync/ops/connectedAccounts/connectedAccountActionServices';
import type { ConnectedAccountInvocationPurposeBinding } from '@happier-dev/cli-common/connectedAccounts';
import type { ManagedBootstrapCredentialInvocationBinding } from '@happier-dev/protocol/actions/executor/types';
import { createManagedBootstrapCredentialByteService } from '@happier-dev/cli-common/machines/managed';

/** Physical UI services over the existing Account Data, Action and admission owners. */
export function createPluginSurfaceAccountActionServices(input: Readonly<{
    pluginId: string;
    actionId?: string;
    actionInput?: unknown;
    connectedAccountPurposeBinding?: ConnectedAccountInvocationPurposeBinding;
    managedBootstrapCredential?: ManagedBootstrapCredentialInvocationBinding;
    occurrenceId: string;
    /** Client contributions may carry a materialization instead of durable source custody. */
    sourceCustody?: PluginSourceCustodyV1;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal: AbortSignal;
    retireReadObservation?(): void;
    machine?: Readonly<{ machineId: string; serverId?: string | null }>;
    resolveMachine?(): Promise<Readonly<{ machineId: string; serverId?: string | null }> | undefined>;
    isMachineAvailable?(): boolean;
    isCurrent(): boolean;
    execute(action: string | PluginContributionRef, value: JsonValue, options: Readonly<{
        signal: AbortSignal;
        expectedContributorOccurrenceId?: string;
        requiredReadOnly?: true;
        readObservation?: DispatchPluginSurfaceActionInput['readObservation'];
        sessionAddress?: ActionExecutionOptions['sessionAddress'];
        machineAvailability?: ActionExecutionOptions['machineAvailability'];
        isCurrent(): boolean;
    }>): Promise<JsonValue>;
}>): {
    services: PluginAccountActionContext['services'];
    signal: AbortSignal;
    redactDiagnosticText(value: string): string;
    snapshotRedactor(): (value: string) => string;
    dispose(): Promise<void>;
} {
    const lifecycle = new AbortController();
    const invocation = mergeAbortSignals([input.signal, lifecycle.signal]);
    const availability = readPluginAccountAvailability(input.accountLifetime.scope);
    const isCurrent = () => !invocation.signal.aborted && input.isCurrent() && input.accountLifetime.isCurrent();
    const assertCurrent = () => {
        if (!isCurrent()) throw new PluginError({ code: 'plugin_action_generation_retired' });
    };
    const declarationSource = createPluginSurfaceTargetedDeclarationSource({ ...input, signal: invocation.signal, isCurrent });
    const declarations = declarationSource.readDeclarations;
    const readCurrentDeclarations = declarationSource.readCurrentDeclarations;
    const targetedContributions = createManifestTargetedContributionsService({
        readCurrentDeclarations,
        subscribeToCatalogChanges: declarationSource.subscribe,
    }).bind({ pluginId: input.pluginId, signal: invocation.signal, isCurrent });

    const execute: PluginAccountActionContext['services']['actions']['execute'] = (async (
        action: string | PluginContributionRef, value: JsonValue, options?: ActionExecutionOptions,
    ) => {
        assertCurrent();
        const sourceCancellation = new AbortController();
        const sourceRetirement = options?.sessionAddress === undefined ? undefined
            : input.accountLifetime.onRetire(() => sourceCancellation.abort());
        const cancellation = mergeAbortSignals([invocation.signal, options?.signal,
            ...(sourceRetirement ? [sourceCancellation.signal] : [])]);
        try { return await input.execute(action, value, { signal: cancellation.signal, isCurrent,
            machineAvailability: options?.machineAvailability,
            ...(options?.sessionAddress === undefined ? {} : { sessionAddress: options.sessionAddress }) }); }
        finally { sourceRetirement?.dispose(); cancellation.dispose(); }
    }) as PluginAccountActionContext['services']['actions']['execute'];

    const observe: PluginAccountActionContext['services']['actions']['observe'] = async (
        action, value, invalidate, options,
    ) => {
        assertCurrent();
        // Account Actions have no Machine origin, and this in-process dispatcher
        // cannot enforce Machine placement pins. Never erase an author precondition.
        if (options?.expectedExecutionOrigin !== undefined || options?.expectedExecutionRouting !== undefined) {
            throw new PluginError({ code: 'plugin_action_read_observation_unavailable',
                message: 'Pinned Machine Action observation is unavailable in this Account runtime' });
        }
        const cancellation = mergeAbortSignals([invocation.signal, options?.signal]);
        try {
            const subscription = await observePluginSurfaceActionRead({
                signal: cancellation.signal, isCurrent, invalidate,
                ...(input.retireReadObservation ? { retire: input.retireReadObservation } : {}),
                invoke: (observation, signal) => input.execute(action, value, {
                    signal, isCurrent, requiredReadOnly: true, readObservation: observation,
                }),
            });
            return Object.freeze({ dispose() {
                try { return subscription.dispose(); } finally { cancellation.dispose(); }
            } });
        } catch (error) { cancellation.dispose(); throw error; }
    };

    const prepareAdmittedTargetedOperation = async <TInput extends JsonValue, TResult extends JsonValue | void>(
        operation: AdmittedTargetedOperationExecutionHandle<TInput, TResult>, value: TInput,
        options: AdmittedTargetedOperationExecutionOptions | undefined, signal: AbortSignal,
    ) => {
        const seed = { plugin: { id: input.pluginId }, occurrenceId: input.occurrenceId, sourceCustody: input.sourceCustody };
        const requireCurrent = () => {
            assertCurrent();
            if (signal.aborted) throw new PluginError({ code: 'plugin_action_aborted' });
            return requireAdmittedTargetedOperationExecutionBinding(operation, seed, declarations());
        };
        await readCurrentDeclarations(signal);
        const binding = requireCurrent();
        const selected = await resolveAdmittedTargetedOperationInput({ seed, binding, input: value,
            expectedSelectedConnectedAccountRef: options?.expectedSelectedConnectedAccountRef,
            selectedActionInputClaimed: { current: false }, signal, assertCurrent: requireCurrent });
        const parsed = validateTargetedOperationInput(binding.targetProtocol, selected);
        if (!parsed.ok) throw createPluginActionHandlerNotStartedError({ code: parsed.result.errorCode, message: parsed.result.error });
        return { binding, value: parsed.value as JsonValue,
            isCurrent() { try { requireCurrent(); return true; } catch { return false; } } };
    };

    const executeAdmittedTargetedOperation = async <TInput extends JsonValue, TResult extends JsonValue | void>(
        operation: AdmittedTargetedOperationExecutionHandle<TInput, TResult>, value: TInput,
        options?: AdmittedTargetedOperationExecutionOptions,
    ): Promise<TResult> => {
        assertCurrent();
        const cancellation = mergeAbortSignals([invocation.signal, options?.signal]);
        try {
            const admitted = await prepareAdmittedTargetedOperation(operation, value, options, cancellation.signal);
            const result = await input.execute(admitted.binding.action, admitted.value, {
                signal: cancellation.signal, expectedContributorOccurrenceId: admitted.binding.contributorOccurrenceId,
                machineAvailability: options?.machineAvailability,
                isCurrent: admitted.isCurrent,
            });
            const accepted = validateTargetedOperationResult(admitted.binding.targetProtocol, result);
            if (!accepted.ok) throw new PluginError({ code: accepted.result.errorCode, message: accepted.result.error });
            // The target-owned parser proves the exact public handle result relationship.
            return accepted.value as TResult;
        } finally { cancellation.dispose(); }
    };

    const observeAdmittedTargetedOperation: PluginAccountActionContext['services']['actions']['observeAdmittedTargetedOperation'] = async (
        operation, value, invalidate, options,
    ) => {
        assertCurrent();
        const cancellation = mergeAbortSignals([invocation.signal, options?.signal]);
        try {
            const subscription = await observePluginSurfaceActionRead({
                signal: cancellation.signal, isCurrent, invalidate,
                ...(input.retireReadObservation ? { retire: input.retireReadObservation } : {}),
                async invoke(observation, signal) {
                    const admitted = await prepareAdmittedTargetedOperation(operation, value, options, signal);
                    return await input.execute(admitted.binding.action, admitted.value, {
                        signal, expectedContributorOccurrenceId: admitted.binding.contributorOccurrenceId,
                        requiredReadOnly: true, readObservation: observation,
                        machineAvailability: options?.machineAvailability,
                        isCurrent: admitted.isCurrent,
                    });
                },
            });
            return Object.freeze({ dispose() {
                try { return subscription.dispose(); } finally { cancellation.dispose(); }
            } });
        } catch (error) { cancellation.dispose(); throw error; }
    };

    const network = createPluginSurfaceAccountNetworkServices({ pluginId: input.pluginId, accountLifetime: input.accountLifetime,
        signal: invocation.signal, isCurrent,
        connectedAccounts: () => connectedAccounts });
    let connectedAccounts: PluginAccountActionContext['services']['connectedAccounts'];
    try {
        connectedAccounts = createUiConnectedAccountActionServices({ ...input, signal: invocation.signal, isCurrent,
            registerRawForRedaction: network.registerRawForRedaction });
    } catch (error) {
        network.dispose(); invocation.dispose();
        throw error;
    }
    const credentialCleanups: Readonly<{ dispose(): Promise<void> }>[] = [];
    const unavailableCredential = () => new PluginError({ code: 'plugin_service_unavailable', message: 'The admitted bootstrap credential is unavailable' });
    const byteService = createManagedBootstrapCredentialByteService({ binding: input.managedBootstrapCredential,
        signal: invocation.signal, isCurrent, unavailable: unavailableCredential,
        registerRawForRedaction: network.registerRawForRedaction,
        retainCleanup(cleanup) {
            if (invocation.signal.aborted) throw unavailableCredential();
            credentialCleanups.push(cleanup);
        },
    });
    const services: PluginAccountActionContext['services'] = {
        http: network.http, secrets: network.secrets,
        connectedAccounts,
        machineProvisioners: {
            materializeBootstrapCredential(request) {
                if (request.kind !== 'bytes') return Promise.reject(unavailableCredential());
                return byteService.materializeBootstrapCredential();
            },
            materializeGuestHostCredential: byteService.materializeGuestHostCredential,
            materializeNativeCredentialHeaders: async () => ({ ok: false, code: 'native_credential_binding_unavailable' }),
            withBootstrapCredentialFile: async () => { throw unavailableCredential(); },
        },
        settings: createUiAccountActionSettingsService({ pluginId: input.pluginId, accountLifetime: input.accountLifetime,
            signal: invocation.signal, isCurrent }),
        storage: { account: createPluginUiAccountStorageScope({
            pluginId: input.pluginId, accountLifetime: input.accountLifetime, readAvailability: () => availability,
            signal: invocation.signal, isCurrent,
        }) },
        actions: { execute, observe, executeAdmittedTargetedOperation, observeAdmittedTargetedOperation }, targetedContributions,
    };
    let disposal: Promise<void> | null = null;
    return { services, signal: invocation.signal,
        redactDiagnosticText: network.redactDiagnosticText, snapshotRedactor: network.snapshotRedactor,
        dispose() {
            lifecycle.abort();
            return disposal ??= (async () => {
                try { await Promise.all(credentialCleanups.map(cleanup => cleanup.dispose())); }
                finally { network.dispose(); invocation.dispose(); }
            })();
        },
    };
}
