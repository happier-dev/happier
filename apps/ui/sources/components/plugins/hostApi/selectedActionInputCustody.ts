import {
    PluginUiSelectedActionInputCarrierV1Schema,
    PluginUiSelectActionInputResultV1Schema,
    pluginUiSelectedActionInputsEqual,
    pluginUiTargetedContributionOperationKey,
    type PluginUiSelectActionInputResultV1,
    type PluginUiTargetedContributionOperationV1,
} from '@happier-dev/protocol/plugins/ui';

type SubmittedInput = Extract<PluginUiSelectActionInputResultV1, Readonly<{ kind: 'submitted' }>>;
export type RetainedSelectedActionInput = Readonly<{
    carrier: Readonly<{ operation: PluginUiTargetedContributionOperationV1; result: SubmittedInput }>;
    release(): void;
}>;

/** Private selection custody shared by mounted UI and client Action adapters. */
export function createSelectedActionInputCustody() {
    const byAction = new WeakMap<object, RetainedSelectedActionInput>();
    const byOperation = new Map<string, RetainedSelectedActionInput>();
    const resolve = (candidate: unknown): RetainedSelectedActionInput | undefined => {
        const parsed = PluginUiSelectedActionInputCarrierV1Schema.safeParse(candidate);
        if (!parsed.success) return undefined;
        const retained = byOperation.get(pluginUiTargetedContributionOperationKey(parsed.data.operation));
        return retained && pluginUiSelectedActionInputsEqual(retained.carrier.result, parsed.data.result)
            ? retained
            : undefined;
    };
    return {
        resolve,
        settle(action: unknown, candidate: unknown, consume: boolean) {
            const direct = candidate === undefined && action && typeof action === 'object'
                ? byAction.get(action) : undefined;
            const selected = candidate === undefined
                ? direct && byOperation.get(pluginUiTargetedContributionOperationKey(direct.carrier.operation)) === direct
                    ? direct : undefined
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
        retain(operation: PluginUiTargetedContributionOperationV1, result: SubmittedInput, signal?: AbortSignal) {
            // Author mutation cannot rewrite the private selected input or Account facts.
            const retainedResult = PluginUiSelectActionInputResultV1Schema.parse(JSON.parse(JSON.stringify(result)));
            if (retainedResult.kind !== 'submitted') throw new Error('select_action_input_response_invalid');
            const key = pluginUiTargetedContributionOperationKey(operation);
            let retained!: RetainedSelectedActionInput;
            const release = () => {
                if (byOperation.get(key) !== retained) return;
                byOperation.delete(key);
                signal?.removeEventListener('abort', release);
            };
            retained = Object.freeze({ carrier: Object.freeze({ operation, result: retainedResult }), release });
            byOperation.get(key)?.release();
            byOperation.set(key, retained);
            if (signal?.aborted) release();
            else signal?.addEventListener('abort', release, { once: true });
            byAction.set(result.action, retained);
        },
        dispose() {
            for (const retained of byOperation.values()) retained.release();
        },
    };
}
