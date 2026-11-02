import { PluginError, type JsonValue, type PluginContributionRef } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext, AdmittedTargetedOperationExecutionHandle, AdmittedTargetedOperationExecutionOptions } from '@happier-dev/plugin-sdk/actions';
import {
    createManifestTargetedContributionsService,
    createPluginActionHandlerNotStartedError,
    requireAdmittedTargetedOperationExecutionBinding,
    resolveAdmittedTargetedOperationInput,
    validateTargetedOperationInput,
    validateTargetedOperationResult,
} from '@happier-dev/plugin-sdk/host/registration';
import type { PluginSourceCustodyV1 } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { createPluginUiAccountStorageScope } from '@/sync/api/plugins/data/pluginUiDataClient';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { createUiAccountActionSettingsService } from '@/sync/domains/plugins/settings/accountActionSettings';
import { createPluginSurfaceTargetedDeclarationSource } from './pluginSurfaceTargetedDeclarations';

/** Physical UI services over the existing Account Data, Action and admission owners. */
export function createPluginSurfaceAccountActionServices(input: Readonly<{
    pluginId: string;
    occurrenceId: string;
    sourceCustody: PluginSourceCustodyV1;
    accountLifetime: ActiveServerAccountScopeLifetime;
    signal: AbortSignal;
    machine?: Readonly<{ machineId: string; serverId?: string | null }>;
    isCurrent(): boolean;
    execute(action: string | PluginContributionRef, value: JsonValue, options: Readonly<{
        signal: AbortSignal;
        expectedContributorOccurrenceId?: string;
        isCurrent(): boolean;
    }>): Promise<JsonValue>;
}>) {
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
        action: string | PluginContributionRef, value: JsonValue, options?: Readonly<{ signal?: AbortSignal }>,
    ) => {
        assertCurrent();
        const cancellation = mergeAbortSignals([invocation.signal, options?.signal]);
        try { return await input.execute(action, value, { signal: cancellation.signal, isCurrent }); }
        finally { cancellation.dispose(); }
    }) as PluginAccountActionContext['services']['actions']['execute'];

    const executeAdmittedTargetedOperation = async <TInput extends JsonValue, TResult extends JsonValue | void>(
        operation: AdmittedTargetedOperationExecutionHandle<TInput, TResult>, value: TInput,
        options?: AdmittedTargetedOperationExecutionOptions,
    ): Promise<TResult> => {
        assertCurrent();
        const cancellation = mergeAbortSignals([invocation.signal, options?.signal]);
        const seed = { plugin: { id: input.pluginId }, occurrenceId: input.occurrenceId, sourceCustody: input.sourceCustody };
        const requireCurrent = () => {
            assertCurrent();
            return requireAdmittedTargetedOperationExecutionBinding(operation, seed, declarations());
        };
        try {
            await readCurrentDeclarations(cancellation.signal);
            const binding = requireCurrent();
            const selected = await resolveAdmittedTargetedOperationInput({ seed, binding, input: value,
                expectedSelectedConnectedAccountRef: options?.expectedSelectedConnectedAccountRef,
                selectedActionInputClaimed: { current: false }, signal: cancellation.signal, assertCurrent: requireCurrent });
            const parsed = validateTargetedOperationInput(binding.targetProtocol, selected);
            if (!parsed.ok) throw createPluginActionHandlerNotStartedError({ code: parsed.result.errorCode, message: parsed.result.error });
            const result = await input.execute(binding.action, parsed.value as JsonValue, {
                signal: cancellation.signal, expectedContributorOccurrenceId: binding.contributorOccurrenceId,
                isCurrent: () => { requireCurrent(); return true; },
            });
            const accepted = validateTargetedOperationResult(binding.targetProtocol, result);
            if (!accepted.ok) throw new PluginError({ code: accepted.result.errorCode, message: accepted.result.error });
            // The target-owned parser proves the exact public handle result relationship.
            return accepted.value as TResult;
        } finally { cancellation.dispose(); }
    };

    const services: PluginAccountActionContext['services'] = {
        settings: createUiAccountActionSettingsService({ pluginId: input.pluginId, accountLifetime: input.accountLifetime,
            signal: invocation.signal, isCurrent }),
        storage: { account: createPluginUiAccountStorageScope({
            pluginId: input.pluginId, accountLifetime: input.accountLifetime, readAvailability: () => availability,
            signal: invocation.signal, isCurrent,
        }) },
        actions: { execute, executeAdmittedTargetedOperation }, targetedContributions,
    };
    return { services, dispose() { lifecycle.abort(); invocation.dispose(); } };
}
