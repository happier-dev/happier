import {
    buildQualifiedPluginContributionKey,
    createPluginContributionIdentity,
    StrictJsonValueSchema,
    type ActionExecutorDeps,
} from '@happier-dev/protocol';

import type { InvokeContributedAction } from '../services/actions';
import type {
    RevalidatePluginActionCallerImmutableGeneration,
    RevalidatePluginActionCallerMaterialization,
} from '../services/actionCaller';

/**
 * Adapts the canonical ActionExecutor's `action.invoke` hook to the committed
 * plugin target dispatcher. Target selection and target currentness remain
 * there; this adapter revalidates the host-stamped caller before handoff.
 */
export function createHostContributedActionInvoker(params: Readonly<{
    invokeContributedAction: InvokeContributedAction;
    revalidatePluginActionCallerMaterialization: RevalidatePluginActionCallerMaterialization;
    revalidatePluginActionCallerImmutableGeneration: RevalidatePluginActionCallerImmutableGeneration;
}>): NonNullable<ActionExecutorDeps['invokeContributedAction']> {
    return async ({ action, input, context, signal }) => {
        const caller = context.actionCaller;
        if (
            caller?.kind !== 'plugin'
            || !caller.contributionLocalId
            || !caller.materialization
        ) {
            return {
                ok: false,
                errorCode: 'plugin_action_caller_unavailable',
                error: 'Plugin contributed action calls require current host-stamped caller provenance',
            };
        }
        const callerMaterialization = caller.materialization;
        const parsedInput = input === undefined
            ? undefined
            : StrictJsonValueSchema.safeParse(input);
        if (parsedInput !== undefined && !parsedInput.success) {
            return {
                ok: false,
                errorCode: 'invalid_parameters',
                error: 'invalid_parameters',
            };
        }
        const isCallerCurrent = async (): Promise<boolean> => {
            try {
                if (!await params.revalidatePluginActionCallerMaterialization(
                    callerMaterialization,
                )) return false;
                return !caller.immutableGenerationId
                    || await params.revalidatePluginActionCallerImmutableGeneration({
                        pluginId: caller.pluginId,
                        immutableGenerationId: caller.immutableGenerationId,
                    });
            } catch {
                return false;
            }
        };
        const callerNoLongerCurrent = () => ({
            ok: false as const,
            errorCode: 'plugin_action_caller_unavailable',
            error: 'Plugin contributed action caller is no longer current',
        });
        if (!await isCallerCurrent()) {
            return callerNoLongerCurrent();
        }
        const result = await params.invokeContributedAction({
            action,
            ...(parsedInput === undefined ? { input: undefined } : { input: parsedInput.data }),
            surface: 'plugin',
            caller: {
                kind: 'plugin',
                pluginId: caller.pluginId,
                contribution: {
                    id: caller.contributionLocalId,
                    qualifiedId: buildQualifiedPluginContributionKey(
                        createPluginContributionIdentity({
                            pluginId: caller.pluginId,
                            localId: caller.contributionLocalId,
                        }),
                    ),
                },
                materialization: callerMaterialization,
            },
            signal: signal ?? context.signal ?? new AbortController().signal,
        });
        if (!await isCallerCurrent()) {
            return callerNoLongerCurrent();
        }
        if (result.status === 'executed') {
            return { ok: true, result: result.value };
        }
        return {
            ok: false,
            errorCode: result.code,
            error: result.message,
        };
    };
}
