import { actionOperationPresentationCoordinator } from '@/components/inbox/actionOperations/actionOperationPresentationRuntime';
import type { ActionOperationReentryOrigin } from '@/components/inbox/actionOperations/actionOperationPresentationCoordinator';
import { randomUUID } from '@/platform/randomUUID';

import {
    dispatchPluginSurfaceAction,
    type DispatchPluginSurfaceActionInput,
    type PluginSurfaceActionDispatchOutcome,
} from './pluginSurfaceActionDispatch';

export type PluginSurfaceActionLaunchOutcome =
    Readonly<{ kind: 'settled'; outcome: PluginSurfaceActionDispatchOutcome }>;

export type LaunchPluginSurfaceActionInput = DispatchPluginSurfaceActionInput & Readonly<{
    operationOrigin?: ActionOperationReentryOrigin;
}>;

/**
 * The thin presentation adapter over the canonical Action dispatcher.
 *
 * It allocates the host request identity — allocation alone creates no lasting
 * state — and lets the dispatcher decide, at its single admission moment, that
 * a daemon operation really is about to exist. Registering before that decision
 * left presentation custody behind for every locally refused launch, and the
 * coordinator has no per-registration removal to undo it.
 */
export async function launchPluginSurfaceAction(
    input: LaunchPluginSurfaceActionInput,
): Promise<PluginSurfaceActionLaunchOutcome> {
    const { operationOrigin, ...dispatchInput } = input;
    const requestId = dispatchInput.actionRequestId ?? randomUUID();
    const outcome = await dispatchPluginSurfaceAction({
        ...dispatchInput,
        actionRequestId: requestId,
        onDaemonActionOperationAdmitted: (operation) => {
            actionOperationPresentationCoordinator.register({
                requestId,
                onStart: operation.presentation.onStart,
                ...(operationOrigin ? { origin: operationOrigin } : {}),
            });
        },
    });
    return { kind: 'settled', outcome };
}
