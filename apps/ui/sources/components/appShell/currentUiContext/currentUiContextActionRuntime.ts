import { PluginActionSurfaceV2Schema } from '@happier-dev/protocol/plugins/actions/v2';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE } from '@happier-dev/protocol/plugins/actions/invocation';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { CurrentUiContextVoiceToolPort } from './currentUiContextVoiceToolPort';
import type { PluginSurfaceActionInvocationSurface, PluginSurfaceHostActionBinding } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';

type PortFactory = (surface: PluginSurfaceActionInvocationSurface, hostAction?: PluginSurfaceHostActionBinding) => CurrentUiContextVoiceToolPort | null;
let mountedPortFactory: PortFactory | null = null;

/** Borrows the provider's reader/dispatcher for this AppShell lifetime, without copying its context. */
export function registerCurrentUiContextActionPort(createPort: PortFactory): () => void {
    mountedPortFactory = createPort;
    return () => { if (mountedPortFactory === createPort) mountedPortFactory = null; };
}

export async function executeCurrentUiContextAction(
    request: Parameters<NonNullable<ActionExecutorDeps['uiCurrentContextAction']>>[0],
    hostAction?: PluginSurfaceHostActionBinding,
): Promise<ActionExecuteResult> {
    const surface = PluginActionSurfaceV2Schema.safeParse(request.context.surface);
    const port = surface.success && surface.data !== 'plugin' ? mountedPortFactory?.(surface.data, hostAction) : null;
    if (!port || request.context.signal?.aborted) {
        return { ok: false, errorCode: 'unsupported_action', error: 'current_ui_context_not_mounted' };
    }
    if (request.actionId === 'ui.current_context.read') {
        const snapshot = port.readCurrentUiContext();
        return snapshot === null
            ? { ok: false, errorCode: 'unsupported_action', error: 'current_ui_context_unavailable' }
            : { ok: true, result: snapshot };
    }
    // The ordinary Action executor has already admitted this strict input.
    const input = request.input as Readonly<{ commandId: string }>;
    const outcome = await port.invokeCurrentUiCommand?.({ commandId: input.commandId, signal: request.context.signal });
    return outcome?.ok
        ? { ok: true, result: outcome.result ?? null }
        : { ok: false, errorCode: outcome?.code === 'denied' ? 'permission_denied' : 'unsupported_action', error: outcome?.code ?? 'current_ui_command_unavailable' };
}

/** The generic executor borrows the mounted dispatcher, including its nested host services. */
export async function executeCurrentUiContextContributedAction(
    request: Parameters<NonNullable<ActionExecutorDeps['invokeContributedAction']>>[0],
    hostAction: PluginSurfaceHostActionBinding,
): Promise<ActionExecuteResult> {
    const surface = PluginActionSurfaceV2Schema.safeParse(request.context.surface);
    const port = surface.success && surface.data !== 'plugin' ? mountedPortFactory?.(surface.data, hostAction) : null;
    const input = PluginJsonValueV2Schema.safeParse(request.input ?? null);
    if (!port?.invokeAction || request.signal?.aborted || !input.success) {
        return { ok: false, errorCode: 'contributed_action_unavailable', error: 'current_ui_context_not_mounted', details: { actionHandlerInvocation: 'notStarted' } };
    }
    const outcome = await port.invokeAction({
        action: request.action,
        input: input.data,
        ...(request.context.expectedContributedActionOccurrenceId ? { expectedContributorOccurrenceId: request.context.expectedContributedActionOccurrenceId } : {}),
        ...(request.context.defaultSessionId ? { defaultSessionId: request.context.defaultSessionId } : {}),
        ...(request.requiredDangerLevel ? { requiredDangerLevel: request.requiredDangerLevel } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
    });
    if (outcome.ok) return { ok: true as const, result: outcome.result ?? null };
    const errorCode = outcome.code === 'outcome_unknown' ? PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE
        : outcome.errorCode ?? (outcome.code === 'denied' ? 'permission_denied' : 'contributed_action_unavailable');
    return { ok: false as const, errorCode, error: errorCode,
        ...(outcome.actionHandlerInvocation ? { details: { actionHandlerInvocation: outcome.actionHandlerInvocation } } : {}) };
}
