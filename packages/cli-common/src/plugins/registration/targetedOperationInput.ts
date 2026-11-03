/** @moduleRealm any */
import type { JsonValue } from './contracts.js';
import type { PluginError } from '../errors.js';
import { createPluginActionHandlerNotStartedError } from './actionHandlerInvocation.js';
import type { AdmittedTargetedOperationExecutionBinding } from './admittedTargetedOperation.js';
import { pluginSourceCustodyV1Equal, type PluginSourceCustodyV1 } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import type { QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { readInputPath } from '@happier-dev/protocol/inputs/inputPredicates';
import { pluginUiSelectedActionInputMatchesOperation, pluginUiTargetedContributionOperationKey, reconstructPluginUiSelectedActionInput, PluginUiSelectedActionInputCarrierV1Schema, type PluginUiSelectedActionInputCarrierV1 } from '@happier-dev/protocol/plugins/ui/selectedActionInput';

function selectedActionInputInvalid(): PluginError {
    return createPluginActionHandlerNotStartedError({
        code: 'plugin_selected_action_input_invalid',
        message: 'Selected Action input does not match the admitted operation',
    });
}

function selectedActionInputUnavailable(): PluginError {
    return createPluginActionHandlerNotStartedError({
        code: 'plugin_selected_action_input_unavailable',
        message: 'Selected Action input is unavailable for the admitted operation',
    });
}

function mountedCallerUnavailable(): PluginError {
    return createPluginActionHandlerNotStartedError({
        code: 'plugin_mounted_caller_unavailable',
        message: 'Mounted plugin caller is no longer current',
    });
}

/**
 * The admitted-operation handle is the sole host consumer of a selected UI
 * settlement. It compares every carried identity to host-private admission,
 * then reconstructs at the last point before the provider Action receives
 * input. The carrier itself is deliberately neither a capability nor storage.
 */
export async function resolveAdmittedTargetedOperationInput(params: Readonly<{
    seed: Readonly<{
        plugin: Readonly<{ id: string }>;
        sourceCustody?: PluginSourceCustodyV1;
        selectedActionInputCarrier?: PluginUiSelectedActionInputCarrierV1;
        isMountedCallerCurrent?: () => boolean | Promise<boolean>;
    }>;
    assertCurrent(): void;
    binding: AdmittedTargetedOperationExecutionBinding;
    input: JsonValue;
    expectedSelectedConnectedAccountRef: QualifiedConnectedAccountRef | null | undefined;
    /** One outer UI invocation may reconstruct its selected settlement once. */
    selectedActionInputClaimed: { current: boolean };
    signal: AbortSignal;
}>): Promise<JsonValue> {
    if (params.seed.selectedActionInputCarrier === undefined) {
        // Retained setup input has no transient form carrier. Restore only the
        // exact Account supplied by the target through the admitted field path.
        const expectedRef = params.expectedSelectedConnectedAccountRef;
        if (expectedRef === undefined) return params.input;
        const selected = params.binding.selectedActionInput;
        if (selected.kind === 'unavailable') throw selectedActionInputUnavailable();
        if (selected.kind === 'none') {
            if (expectedRef !== null) throw selectedActionInputInvalid();
            return params.input;
        }
        if (expectedRef === null) {
            // An explicit native credential is not an omitted/default Account.
            // Preserve only null at the exact declared binding path; schema and
            // purpose admission still own whether that native mode is usable.
            if (readInputPath(params.input, selected.fieldPath) !== null) throw selectedActionInputInvalid();
            return params.input;
        }
        const reconstructed = reconstructPluginUiSelectedActionInput({
            input: params.input,
            connectedAccount: { kind: 'selected', fieldPath: selected.fieldPath, ref: expectedRef },
        }, { allowMatchingConnectedAccount: true });
        const parsedInput = reconstructed === null
            ? null
            : StrictJsonValueSchema.safeParse(reconstructed);
        if (!parsedInput || !parsedInput.success) throw selectedActionInputInvalid();
        return parsedInput.data;
    }
    const parsedCarrier = PluginUiSelectedActionInputCarrierV1Schema.safeParse(
        params.seed.selectedActionInputCarrier,
    );
    if (!parsedCarrier.success) {
        throw selectedActionInputUnavailable();
    }
    const carrier = parsedCarrier.data;
    const carrierMatchesBinding = pluginUiTargetedContributionOperationKey(carrier.operation)
        === pluginUiTargetedContributionOperationKey(params.binding.operation)
        && pluginSourceCustodyV1Equal(
            carrier.operation.contributor.sourceCustody,
            params.binding.operation.contributor.sourceCustody,
        );
    if (!carrierMatchesBinding) {
        // Supplying an outer selected-account fact to any other handle is a
        // confused-deputy attempt, never a request to run it ordinarily.
        if (params.expectedSelectedConnectedAccountRef !== undefined) {
            throw selectedActionInputInvalid();
        }
        return params.input;
    }
    // A failed validation/currentness read must leave the settlement usable.
    // The successful path claims it synchronously after the final await.
    if (params.selectedActionInputClaimed.current) throw selectedActionInputInvalid();
    if (params.expectedSelectedConnectedAccountRef === undefined) {
        throw selectedActionInputInvalid();
    }
    if (params.binding.selectedActionInput.kind === 'unavailable') {
        throw selectedActionInputUnavailable();
    }
    if (!params.seed.sourceCustody || !params.seed.isMountedCallerCurrent) {
        throw selectedActionInputUnavailable();
    }
    if (
        !pluginUiSelectedActionInputMatchesOperation(carrier.result, carrier.operation)
        || carrier.result.selection.target.pluginId !== params.binding.targetPluginId
        || carrier.result.selection.target.pluginId !== params.seed.plugin.id
        || !pluginSourceCustodyV1Equal(
            carrier.result.selection.target.sourceCustody,
            params.seed.sourceCustody,
        )
    ) {
        throw selectedActionInputInvalid();
    }
    params.assertCurrent();
    let mountedCallerCurrent = false;
    try {
        mountedCallerCurrent = await params.seed.isMountedCallerCurrent();
    } catch {
        // Current bound UI caller evidence is external to this service. A
        // failed re-read cannot authorize disclosure to a provider Action.
    }
    params.assertCurrent();
    if (!mountedCallerCurrent) throw mountedCallerUnavailable();
    if (!pluginJsonValuesEqual(params.input, carrier.result.input)) {
        throw selectedActionInputInvalid();
    }

    const expectedRef = params.expectedSelectedConnectedAccountRef;
    const selected = params.binding.selectedActionInput;
    if (selected.kind === 'none') {
        if (expectedRef !== null || carrier.result.connectedAccount.kind !== 'none') {
            throw selectedActionInputInvalid();
        }
    } else if (
        expectedRef === null
        || carrier.result.connectedAccount.kind !== 'selected'
        || carrier.result.connectedAccount.fieldPath !== selected.fieldPath
        || !sameQualifiedConnectedAccountRef(expectedRef, carrier.result.connectedAccount.ref)
    ) {
        throw selectedActionInputInvalid();
    }
    const reconstructed = reconstructPluginUiSelectedActionInput(carrier.result);
    const parsedInput = reconstructed === null
        ? null
        : StrictJsonValueSchema.safeParse(reconstructed);
    if (!parsedInput || !parsedInput.success) throw selectedActionInputInvalid();
    // Concurrent consumers may have validated across the same await. Only one
    // may return reconstructed input to the provider Action.
    if (params.selectedActionInputClaimed.current) throw selectedActionInputInvalid();
    params.selectedActionInputClaimed.current = true;
    return parsedInput.data;
}
