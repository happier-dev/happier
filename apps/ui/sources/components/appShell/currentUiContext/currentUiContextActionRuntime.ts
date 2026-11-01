import { PluginActionSurfaceV2Schema } from '@happier-dev/protocol/plugins/actions/v2';
import { PluginJsonValueV2Schema } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE } from '@happier-dev/protocol/plugins/actions/invocation';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionDefinitionSummaryV1 } from '@happier-dev/protocol/actions/actionDefinitionV1';
import type { CurrentUiContextVoiceToolPort } from './currentUiContextVoiceToolPort';
import type { PluginSurfaceActionInvocationSurface, PluginSurfaceHostActionBinding } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';
import type { CurrentUiContextReader } from './CurrentUiContextProvider';
import type { CurrentUiContextMountedCommand } from './currentUiContextModel';
import { isVoiceDictationActionId } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

type PortFactory = (surface: PluginSurfaceActionInvocationSurface, hostAction?: PluginSurfaceHostActionBinding) => CurrentUiContextVoiceToolPort | null;
let mountedPortFactory: PortFactory | null = null;

/** UI intents resolve their exact published command, then use the ordinary admitted dispatcher. */
export async function executeMountedCurrentUiContextCommand(input: Readonly<{
    reader: CurrentUiContextReader | null;
    command: CurrentUiContextMountedCommand | undefined;
    execute(actionId: 'ui.current_context.read' | 'ui.current_context.command.invoke', input: unknown): Promise<ActionExecuteResult>;
}>): Promise<ActionExecuteResult> {
    const unavailable = (): ActionExecuteResult => ({ ok: false, errorCode: 'unsupported_action', error: 'current_ui_command_unavailable' });
    if (!input.reader || !input.command) return unavailable();
    const read = await input.execute('ui.current_context.read', {});
    if (!read.ok) return read;
    const snapshot = CurrentUiContextSnapshotV1Schema.safeParse(read.result);
    if (!snapshot.success) return unavailable();
    const descriptor = snapshot.data.commands.find(candidate => {
        const resolved = input.reader?.resolveCurrentUiCommand(candidate.id);
        return resolved != null && resolved.command === input.command && !resolved.retirementSignal.aborted;
    });
    return descriptor ? input.execute('ui.current_context.command.invoke', { commandId: descriptor.id }) : unavailable();
}

/** Borrows the provider's reader/dispatcher for this AppShell lifetime, without copying its context. */
export function registerCurrentUiContextActionPort(createPort: PortFactory): () => void {
    mountedPortFactory = createPort;
    return () => { if (mountedPortFactory === createPort) mountedPortFactory = null; };
}

/** Declaration discovery shares the committed AppShell projection; the executor filters caller surfaces. */
export function listCurrentUiContextContributedActionDefinitions(
    selection?: Parameters<NonNullable<ActionExecutorDeps['listContributedActionDefinitions']>>[0],
): readonly ActionDefinitionSummaryV1[] {
    return mountedPortFactory?.('ui')?.listCurrentContributedActionDefinitions?.('allSurfaces', selection) ?? [];
}

/** Typed host Actions resolve through the incumbent current record, never a second mount registry. */
export function readCurrentUiContextActionReader(context: Pick<ActionExecutorContext, 'surface' | 'signal'>): CurrentUiContextReader | null {
    const surface = PluginActionSurfaceV2Schema.safeParse(context.surface);
    return surface.success && surface.data !== 'plugin' && !context.signal?.aborted
        ? mountedPortFactory?.(surface.data) ?? null : null;
}

export async function executeCurrentUiContextAction(
    request: Parameters<NonNullable<ActionExecutorDeps['uiCurrentContextAction']>>[0]
        | Parameters<NonNullable<ActionExecutorDeps['accountHomeContinuationAction']>>[0]
        | Parameters<NonNullable<ActionExecutorDeps['voiceConversationAction']>>[0],
    hostAction?: PluginSurfaceHostActionBinding,
): Promise<ActionExecuteResult> {
    const surface = PluginActionSurfaceV2Schema.safeParse(request.context.surface);
    // Declared field effects borrow the mounted UI reader, not generic plugin
    // current-context admission. The effect retains its original context below.
    const invocationSurface = surface.success
        ? surface.data === 'plugin' ? isVoiceDictationActionId(request.actionId) ? 'ui' : null : surface.data
        : null;
    const port = invocationSurface ? mountedPortFactory?.(invocationSurface, hostAction) : null;
    if (!port || request.context.signal?.aborted) {
        if (request.actionId.startsWith('ui.voice_global.dictation.')) return { ok: true,
            result: { status: 'unavailable', code: 'dictation_field_unmounted' } };
        return { ok: false, errorCode: 'unsupported_action', error: 'current_ui_context_not_mounted' };
    }
    if (request.actionId.startsWith('ui.voice_global.')) {
        if (!isVoiceDictationActionId(request.actionId)) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
        return port.invokeVoiceDictation?.({ actionId: request.actionId, input: request.input as Readonly<{ commandId: string }>, context: request.context })
            ?? { ok: true, result: { status: 'unavailable', code: 'dictation_field_unmounted' } };
    }
    if (request.actionId === 'ui.current_context.read') {
        const snapshot = port.readCurrentUiContext();
        return snapshot === null
            ? { ok: false, errorCode: 'unsupported_action', error: 'current_ui_context_unavailable' }
            : { ok: true, result: snapshot };
    }
    if (request.actionId === 'account.home_continuation.invoke') {
        return port.invokeAccountHomeContinuation?.({ input: request.input, context: request.context })
            ?? { ok: false, errorCode: 'unsupported_action', error: 'current_account_continuation_unavailable' };
    }
    // The ordinary Action executor has already admitted this strict input.
    const input = request.input as Readonly<{ commandId: string }>;
    const outcome = await port.invokeCurrentUiCommand?.({ commandId: input.commandId, signal: request.context.signal });
    if (outcome?.ok) return { ok: true, result: outcome.result ?? null };
    const errorCode = outcome?.code === 'outcome_unknown' ? PLUGIN_ACTION_OUTCOME_UNKNOWN_CODE
        : outcome?.errorCode ?? (outcome?.code === 'denied' ? 'permission_denied'
        : 'unsupported_action');
    return { ok: false, errorCode, error: outcome?.code ?? 'current_ui_command_unavailable' };
}

/** The generic executor borrows the mounted dispatcher, including its nested host services. */
export async function executeCurrentUiContextContributedAction(
    request: Parameters<NonNullable<ActionExecutorDeps['invokeContributedAction']>>[0],
    hostAction: PluginSurfaceHostActionBinding,
): Promise<ActionExecuteResult> {
    const retained = hostAction.context?.contributedActionInvocation;
    if (retained?.resume) return retained.resume(request, hostAction);
    const surface = PluginActionSurfaceV2Schema.safeParse(request.context.surface);
    const port = surface.success && surface.data !== 'plugin' ? mountedPortFactory?.(surface.data, hostAction) : null;
    const input = PluginJsonValueV2Schema.safeParse(request.input ?? null);
    if (!port?.invokeAction || request.signal?.aborted || !input.success) {
        return { ok: false, errorCode: 'contributed_action_unavailable', error: 'current_ui_context_not_mounted', details: { actionHandlerInvocation: 'notStarted' } };
    }
    const outcome = await port.invokeAction({
        action: request.action,
        input: input.data,
        ...(request.messageActionReference ? { messageActionReference: request.messageActionReference } : {}),
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
