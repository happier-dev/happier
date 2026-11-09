import type {
    ActionApprovalRequestCreatedResult,
    PluginAccountActionContext,
    PluginActionResultById,
    PluginInvocableActionId,
} from '@happier-dev/plugin-sdk/actions';
import { isPluginActionApprovalRequestCreated, parsePluginHostActionInvocation } from '@happier-dev/plugin-sdk/actions';
import { SessionStatusActionResultV1Schema } from '@happier-dev/plugin-sdk/sessions';

/** Development-source example: only the host supplies Home/Account identity
 * and exact Session operands; neither comes from a plugin input bag. */
export async function readSelectedAccountSession(context: PluginAccountActionContext, sessionId: string) {
    if (!context.accountScope) return null;
    const targets = context.sessionTargetsV1?.targets;
    const address = targets?.length === 1 ? targets[0] : undefined;
    if (!address || address.sessionId !== sessionId) return null;
    const executed = await context.services.actions.execute(
        'session.status.get', { sessionId, includeAcceptedWorkspace: true },
        { signal: context.signal, sessionAddress: address },
    );
    if (isPluginActionApprovalRequestCreated(executed)) return null;
    const result = SessionStatusActionResultV1Schema.safeParse(executed);
    return result.success && 'session' in result.data && result.data.session.id === sessionId ? result.data : null;
}

/** Dynamic data still uses canonical plugin input validation and ordinary
 * dispatch. The original result includes any canonical approval deferral. */
export async function executeDynamicAccountHostAction(
    context: PluginAccountActionContext, action: unknown, input: unknown,
): Promise<PluginActionResultById[PluginInvocableActionId] | ActionApprovalRequestCreatedResult> {
    const request = parsePluginHostActionInvocation(action, input);
    return await context.services.actions.execute(request.actionId, request.input, { signal: context.signal });
}

/** The same portable handler may offer ordinary UI composition. Headless
 * callers get an explicit refusal, never a fabricated draft. */
export async function composeAccountSession(context: PluginAccountActionContext,
    seed: Parameters<NonNullable<PluginAccountActionContext['ui']>['openNewSession']>[0]) {
    if (!context.ui) return { kind: 'unavailable' } as const;
    await context.ui.openNewSession(seed, { signal: context.signal });
    return { kind: 'composed' } as const;
}
