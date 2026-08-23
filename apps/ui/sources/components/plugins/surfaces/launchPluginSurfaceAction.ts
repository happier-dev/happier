import {
    normalizePluginUiMountedContributedActionReferenceV1,
    PluginUiQualifiedActionReferenceV1Schema,
} from '@happier-dev/protocol/plugins/ui';

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

function resolveRequestedAction(input: DispatchPluginSurfaceActionInput) {
    if (input.callerPluginId !== undefined) {
        return normalizePluginUiMountedContributedActionReferenceV1({
            callerPluginId: input.callerPluginId,
            action: input.action,
        });
    }
    const exact = PluginUiQualifiedActionReferenceV1Schema.safeParse(input.action);
    return exact.success ? exact.data : null;
}

export async function launchPluginSurfaceAction(
    input: LaunchPluginSurfaceActionInput,
): Promise<PluginSurfaceActionLaunchOutcome> {
    const { operationOrigin, ...dispatchInput } = input;
    const identity = resolveRequestedAction(dispatchInput);
    const projected = identity ? dispatchInput.resolveContributedAction?.(identity) ?? null : null;
    const operation = projected?.execution.target === 'daemon' ? projected.operation : undefined;
    const requestId = operation ? randomUUID() : undefined;
    if (requestId && operation) {
        actionOperationPresentationCoordinator.register({
            requestId,
            onStart: operation.presentation.onStart,
            ...(operationOrigin ? { origin: operationOrigin } : {}),
        });
    }
    const outcome = await dispatchPluginSurfaceAction({
        ...dispatchInput,
        ...(requestId ? { actionRequestId: requestId } : {}),
    });
    return { kind: 'settled', outcome };
}
