import { PluginError, type JsonValue, type PluginCancellationOptions, type PluginContributionRef } from '@happier-dev/plugin-sdk';
import type { ActionExecutionOptions, PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { isPluginActionApprovalRequestCreated, parsePluginHostActionInvocation } from '@happier-dev/plugin-sdk/actions';
import type { PluginClientActionUi } from '@happier-dev/plugin-sdk/actions';
import { SessionStatusActionResultV1Schema } from '@happier-dev/plugin-sdk/sessions';
import type { runTriageConfiguredHandoffV1 } from '../sessions/configuredActionRun.js';

type HandoffHost = Parameters<typeof runTriageConfiguredHandoffV1>[0];

/** Capability adapter only: configured choice, creation and delivery retain
 * their existing owners. No UI is fabricated for a headless invocation.
 * `bound.signal` replaces each call's own signal (a configured run is cancelled with its invocation). */
export function createTriageConfiguredActionHost(context: PluginAccountActionContext,
    bound?: Readonly<{ signal: AbortSignal }>): HandoffHost {
    const ui = context.ui;
    const executeAction = async (action: string | PluginContributionRef,
        input: JsonValue, callOptions?: ActionExecutionOptions): Promise<unknown> => {
        const options = bound ? { ...callOptions, signal: bound.signal } : callOptions;
        if (ui) return await ui.executeAction(action, input, options);
        if (typeof action !== 'string') return await context.services.actions.execute(action, input, options);
        const request = parsePluginHostActionInvocation(action, input);
        // Preserve the ordinary approval-deferral envelope. Each domain owner
        // validates its actual result; this adapter never calls it a success.
        return await context.services.actions.execute(request.actionId, request.input, options);
    };
    const selectFromUi = ui?.selectActionInput;
    const selectActionInput: PluginClientActionUi['selectActionInput'] = !selectFromUi
        ? () => Promise.reject(new PluginError({ code: 'plugin_action_input_selection_unavailable' }))
        : bound ? (request, options) => selectFromUi(request, { ...options, signal: bound.signal }) : selectFromUi;
    return {
        ...ui,
        version: () => ui?.version() ?? { methods: [] },
        context: async options => {
            const snapshot = await ui?.context(options);
            return { targetedContributions: snapshot?.targetedContributions ?? null,
                ...(context.accountScope ? { accountScope: context.accountScope }
                    : snapshot?.accountScope ? { accountScope: snapshot.accountScope } : {}) };
        },
        // The uniform Action transport retains the SDK's producer-derived signature.
        // Domain owners below still parse their results, including approval deferral.
        executeAction: executeAction as PluginClientActionUi['executeAction'],
        selectActionInput,
        ...(ui ? { readSession: ui.readSession } : {}),
        readSessionStatus: async (requested, options?: PluginCancellationOptions) => {
            const targets = context.sessionTargetsV1?.targets;
            // This Action declares cardinality one; never choose one Home from
            // an ambiguous list, even if two addresses share a Session id.
            const address = targets?.length === 1 ? targets[0] : undefined;
            if (!address || address.sessionId !== requested.sessionId || address.serverId !== requested.serverId) return null;
            const executed = await context.services.actions.execute('session.status.get', {
                sessionId: address.sessionId, includeAcceptedWorkspace: true,
            }, { ...options, sessionAddress: address });
            if (isPluginActionApprovalRequestCreated(executed)) return null;
            const result = SessionStatusActionResultV1Schema.safeParse(executed);
            return result.success && 'session' in result.data && result.data.session.id === address.sessionId ? result.data : null;
        },
    };
}
