import type { ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { NotificationsNotifyMeResultV1Schema } from '@happier-dev/protocol/account/notifications/notifyMeV1';

import { createUiAccountAction, resolveUiAccountActionFallbackMachineId } from './accountActionDeps';

/** Notification delivery and catalog remain owned by the captured Account's daemon. */
export function createUiNotificationActionDeps(
    params: Parameters<typeof createUiAccountAction>[0],
): Pick<ActionExecutorDeps, 'notificationsNotifyMe' | 'notificationChannelsList'> {
    const execute = createUiAccountAction(params);
    return {
        notificationsNotifyMe: async (input, context) => {
            const result = await execute({ actionId: 'notifications.notify_me', input, context });
            const failure = ActionExecuteFailureSchema.safeParse(result);
            return failure.success ? failure.data : NotificationsNotifyMeResultV1Schema.parse(result);
        },
        notificationChannelsList: async (context) => {
            // The catalog is the captured Account's. A field pinned to another
            // person's Machine (a Use guest's workflow Where) is read on the
            // Account's own daemon; an own targeted Machine keeps serving it.
            const { externalActionTarget: target, ...accountContext } = context;
            const ownTarget = target?.kind === 'machine' && resolveUiAccountActionFallbackMachineId(params.account,
                { candidateMachineIds: [target.machineId], allowUnreachableFallback: true }) !== null;
            if (!ownTarget) context = accountContext;
            const result = await execute({
                actionId: 'action.options.resolve',
                // Trigger authoring reads the catalog; it does not send a notification.
                // Preserve the standalone source instead of borrowing notify_me's surface policy.
                input: { optionsSourceId: 'notifications.channels.available' },
                context,
            });
            const failure = ActionExecuteFailureSchema.safeParse(result);
            if (failure.success) return failure.data;
            const parsed = getActionSpec('action.options.resolve').outputSchema?.safeParse(result);
            const options: unknown = parsed?.success ? parsed.data : null;
            if (!options || typeof options !== 'object' || !('options' in options)
                || !Array.isArray(options.options)) {
                return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
            }
            return { items: options.options };
        },
    };
}
