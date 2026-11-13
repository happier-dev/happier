import {
    PluginUiSelectedActionInputCarrierV1Schema,
    PluginUiSelectActionInputResultV1Schema,
    PluginUiTargetedContributionOperationV1Schema,
    pluginUiSelectedActionInputsEqual,
    pluginUiTargetedContributionOperationKey,
    type PluginUiSelectActionInputResultV1,
    type PluginUiTargetedContributionOperationV1,
} from '@happier-dev/protocol/plugins/ui';
import { pluginSourceCustodyV1Equal } from '@happier-dev/protocol/plugins/runtime/sourceCustody';

type SubmittedInput = Extract<PluginUiSelectActionInputResultV1, Readonly<{ kind: 'submitted' }>>;
export type RetainedSelectedActionInput = Readonly<{
    carrier: Readonly<{ operation: PluginUiTargetedContributionOperationV1; result: SubmittedInput }>;
    release(): void;
}>;
type RetainedEntry = Readonly<{
    key: string;
    requestOperation: PluginUiTargetedContributionOperationV1;
    selected: RetainedSelectedActionInput;
}>;

/** Private selection custody shared by mounted UI and client Action adapters. */
export function createSelectedActionInputCustody() {
    const byAction = new WeakMap<object, RetainedEntry>();
    const byOperation = new Map<string, RetainedEntry>();
    const resolve = (candidate: unknown): RetainedSelectedActionInput | undefined => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
        const operation = PluginUiTargetedContributionOperationV1Schema.safeParse('operation' in candidate ? candidate.operation : undefined);
        if (!operation.success) return undefined;
        const retained = byOperation.get(pluginUiTargetedContributionOperationKey(operation.data));
        if (!retained || !pluginSourceCustodyV1Equal(operation.data.contributor.sourceCustody,
            retained.requestOperation.contributor.sourceCustody)) return undefined;
        // Only an active host-retained mapping may replace the caller's
        // descriptive operation with the runtime operation that was selected.
        const parsed = PluginUiSelectedActionInputCarrierV1Schema.safeParse({ ...candidate, operation: retained.selected.carrier.operation });
        if (!parsed.success) return undefined;
        return pluginUiSelectedActionInputsEqual(retained.selected.carrier.result, parsed.data.result)
            ? retained.selected
            : undefined;
    };
    return {
        resolve,
        settle(action: unknown, candidate: unknown, consume: boolean) {
            const direct = candidate === undefined && action && typeof action === 'object'
                ? byAction.get(action) : undefined;
            const selected = candidate === undefined
                ? direct && byOperation.get(direct.key) === direct
                    ? direct.selected : undefined
                : resolve(candidate);
            if ((candidate !== undefined || direct !== undefined) && !selected) {
                return { ok: false as const, reason: 'selected_action_input_inactive' as const };
            }
            if (consume && !selected) {
                return { ok: false as const, reason: 'selected_action_input_required_for_consumption' as const };
            }
            // Terminal relays consume synchronously before any external effect.
            if (consume) selected?.release();
            return { ok: true as const, selected };
        },
        retain(operation: PluginUiTargetedContributionOperationV1, result: SubmittedInput, signal?: AbortSignal,
            requestOperation: PluginUiTargetedContributionOperationV1 = operation) {
            // Author mutation cannot rewrite the private selected input or Account facts.
            const retainedResult = PluginUiSelectActionInputResultV1Schema.parse(JSON.parse(JSON.stringify(result)));
            if (retainedResult.kind !== 'submitted') throw new Error('select_action_input_response_invalid');
            const retainedRequest = PluginUiTargetedContributionOperationV1Schema.parse(requestOperation);
            const key = pluginUiTargetedContributionOperationKey(retainedRequest);
            let retained!: RetainedSelectedActionInput;
            const release = () => {
                if (byOperation.get(key)?.selected !== retained) return;
                byOperation.delete(key);
                signal?.removeEventListener('abort', release);
            };
            retained = Object.freeze({ carrier: Object.freeze({ operation, result: retainedResult }), release });
            const entry = Object.freeze({ key, requestOperation: retainedRequest, selected: retained });
            byOperation.get(key)?.selected.release();
            byOperation.set(key, entry);
            if (signal?.aborted) release();
            else signal?.addEventListener('abort', release, { once: true });
            byAction.set(result.action, entry);
        },
        dispose() {
            for (const retained of byOperation.values()) retained.selected.release();
        },
    };
}
