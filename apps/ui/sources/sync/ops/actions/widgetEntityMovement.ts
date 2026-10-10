import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { admitWidgetActionSurfaceV1, readWidgetActionSurfacePortV1, findWidgetLayoutItemV1, getWidgetLayoutItemIdV1, WidgetMoveCaptureV1Schema, WidgetInstanceActionInputSchemasV1, WidgetInstanceActionOutputSchemasV1, WidgetSurfaceReadV1Schema, WidgetTransferFailureDetailsV1Schema, type WidgetLayoutItemV1, type WidgetInstanceRefV1, type WidgetInstanceV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import type { EntityDropAdmissionV1, EntityDropEffectV1, EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { t } from '@/text';
import { Modal } from '@/modal';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { WIDGET_MOVE_PENDING_CODE, WIDGET_MOVE_UNCHANGED_CODE, widgetEntitySourceRef } from '@/components/ui/treeDragDrop/widgetLayoutEntityDrop';
export { widgetEntitySourceRef };

export type WidgetEntityMovementAdmission = Readonly<
    { status: 'ready'; ref: WidgetInstanceRefV1; instance: WidgetInstanceV1 | null; sourceItem: WidgetLayoutItemV1; destination: WidgetSurfaceRefV1 }
    | { status: 'refused'; code: string; ref?: WidgetInstanceRefV1 }
>;

/** Host-bound incumbent owner; a mounted injected area binds both preview and execution together. */
export type WidgetEntityMovementPort = Readonly<{
    readAdmission(ref: WidgetInstanceRefV1, destination: WidgetSurfaceRefV1, signal?: AbortSignal): Promise<WidgetEntityMovementAdmission>;
    execute(effect: EntityDropEffectV1, scope: Readonly<{ serverId: string; accountId: string }>): Promise<EntityDropOutcomeV1>;
}>;

/** Read-only preview uses the same native ports, capture and input admission as the movement Action. */
export async function readWidgetEntityMovementAdmission(deps: ActionExecutorDeps, ref: WidgetInstanceRefV1, surface: WidgetSurfaceRefV1, context: ActionExecutorContext): Promise<WidgetEntityMovementAdmission> {
    let observedRef: WidgetInstanceRefV1 | undefined;
    const refused = (code: string): WidgetEntityMovementAdmission => ({ status: 'refused', code, ...(observedRef ? { ref: observedRef } : {}) });
    if (ref.surface.serverId !== surface.serverId) return refused('server_target_mismatch');
    if (ref.surface.accountId !== surface.accountId) return refused('account_target_mismatch');
    const authority = await admitWidgetActionSurfaceV1(deps, ref.surface, context) ?? await admitWidgetActionSurfaceV1(deps, surface, context);
    if (authority) return refused(authority.errorCode);
    const source = readWidgetActionSurfacePortV1(deps, ref.surface);
    const destination = readWidgetActionSurfacePortV1(deps, surface);
    if (!source || !destination) return refused('unsupported_widget_surface');
    const read = await source.read(ref.surface, context, context.signal);
    if ('ok' in read) return refused(read.errorCode);
    const parsed = WidgetSurfaceReadV1Schema.safeParse(read);
    if (!parsed.success) return refused('invalid_action_output');
    const inventory = parsed.data;
    if (!sameStrictJsonValue(inventory.surface, ref.surface)) return refused('invalid_action_output');
    const placement = inventory.instances.find(entry => entry.instance.id === ref.instanceId);
    const sourceItem = inventory.items ? findWidgetLayoutItemV1(inventory.items, ref.instanceId)
        : placement ? { kind: 'widget' as const, ...placement } : undefined;
    if (!sourceItem) return refused('widget_instance_not_found');
    observedRef = ref;
    if (!inventory.canEdit) return refused('widget_edit_denied');
    const same = sameStrictJsonValue(ref.surface, surface);
    if (sourceItem.kind === 'group') return same
        ? { status: 'ready', ref, instance: null, sourceItem, destination: surface }
        : refused('unsupported_widget_transfer');
    const instance = sourceItem.instance;
    if (source.captureMove) {
        const captured = await source.captureMove(ref.surface, ref.instanceId, context, context.signal);
        if ('ok' in captured) return refused(captured.errorCode);
        const capture = WidgetMoveCaptureV1Schema.safeParse(captured);
        if (!capture.success) return refused('invalid_action_output');
        if (!sameStrictJsonValue(capture.data.expectedInstance, instance)) return refused('widget_instance_changed');
    } else if (!same) return refused('unsupported_widget_transfer');
    if (!same) {
        if (!destination.captureMove) return refused('unsupported_widget_transfer');
        const targetRead = await destination.read(surface, context, context.signal);
        if ('ok' in targetRead) return refused(targetRead.errorCode);
        const parsedTarget = WidgetSurfaceReadV1Schema.safeParse(targetRead);
        if (!parsedTarget.success) return refused('invalid_action_output');
        const target = parsedTarget.data;
        if (!sameStrictJsonValue(target.surface, surface)) return refused('invalid_action_output');
        if (!target.canEdit) return refused('widget_edit_denied');
        if (target.items ? findWidgetLayoutItemV1(target.items, ref.instanceId) : target.instances.some(entry => entry.instance.id === ref.instanceId)) return refused('widget_instance_already_exists');
        if (!deps.widgetInputs) return refused('widget_inputs_unavailable');
        const resolved = await deps.widgetInputs.resolve({ ref: { surface, instanceId: ref.instanceId }, instance, context, admission: 'configuration', signal: context.signal });
        if (resolved.status !== 'ready') return refused(resolved.fields[0]?.reasonCode ?? `widget_destination_${resolved.status}`);
    }
    return { status: 'ready', ref, instance, sourceItem, destination: surface };
}

/**
 * The refusal's words (lab widget-groups wgdnd): why, and the way forward. Owners refuse with codes;
 * a person never reads one. An unknown code gets one plain sentence.
 */
function describeWidgetMovementRefusal(code: string): string {
    switch (code) {
        case WIDGET_MOVE_PENDING_CODE: return t('common.loading');
        case WIDGET_MOVE_UNCHANGED_CODE: return t('entityDragDrop.reasons.noChange');
        case 'widget_group_width_no_fit': return t('widgetFrame.groupRefusedWidth');
        case 'widget_group_nesting_forbidden': return t('widgetFrame.groupRefusedNesting');
        case 'widget_edit_denied': return t('entityDragDrop.surface.widgetReadOnly');
        case 'widget_instance_already_exists': return t('entityDragDrop.surface.widgetAlreadyHere');
        case 'unsupported_widget_surface':
        case 'unsupported_widget_transfer':
        case 'widget_placement_unsupported': return t('entityDragDrop.surface.widgetCantLiveHere');
        case 'scope-mismatch':
        case 'server_target_mismatch':
        case 'account_target_mismatch':
        case 'widget_area_scope_retired': return t('entityDragDrop.surface.scopeMismatch');
        case 'widget_instance_not_found':
        case 'widget_instance_changed':
        case 'widget_destination_changed':
        case 'widget_group_not_found':
        case 'anchor-gone':
        case 'invalid_action_output': return t('entityDragDrop.surface.widgetLayoutChanged');
        default:
            // Input admission refuses with the unresolved field's own reason code.
            return /^(widget_(inputs?|destination|viewer|target)_|input_)/.test(code)
                ? t('entityDragDrop.surface.widgetNeedsInputs') : t('entityDragDrop.surface.widgetMoveUnavailable');
    }
}

/** The one presenter of a widget movement refusal: every layout, area, Home and Board target refuses through it. */
export function widgetMovementRefused(code: string, preview?: EntityDropEffectV1['preview']): Extract<EntityDropAdmissionV1, { status: 'refused' }> {
    // The geometry owner says "same position"; for a carried widget that is "nothing to say", not "Already here".
    const presented = code === 'same-position' ? WIDGET_MOVE_UNCHANGED_CODE : code;
    return { status: 'refused', reason: { code: presented, message: describeWidgetMovementRefusal(presented) }, ...(preview ? { preview } : {}) };
}

/** Preview cannot turn incomplete/denied input admission into an allowed outline. Release still revalidates at the Action. */
export function admitWidgetEntityMovement(effect: EntityDropEffectV1, admission: WidgetEntityMovementAdmission | null): EntityDropAdmissionV1 {
    if (effect.actionId !== 'widgets.item.move') return { status: 'allowed', effect };
    if (!admission) return widgetMovementRefused(WIDGET_MOVE_PENDING_CODE, effect.preview);
    if (admission.status === 'refused') return widgetMovementRefused(admission.code, effect.preview);
    const move = WidgetInstanceActionInputSchemasV1['widgets.item.move'].safeParse(effect.input);
    if (!move.success || !sameStrictJsonValue(move.data.ref, admission.ref)) return widgetMovementRefused('widget_instance_changed', effect.preview);
    const destination = 'to' in move.data ? move.data.to.surface : move.data.ref.surface;
    if (!sameStrictJsonValue(destination, admission.destination)) return widgetMovementRefused('widget_destination_changed', effect.preview);
    return { status: 'allowed', effect };
}

/** The original typed Action outcome owns recovery; never retry, compensate or rewrite unknown as refusal here. */
export function projectWidgetEntityMovementResult(result: ActionExecuteResult, effect: EntityDropEffectV1): EntityDropOutcomeV1 {
    const move = WidgetInstanceActionInputSchemasV1['widgets.item.move'].safeParse(effect.input);
    const ack = result.ok ? WidgetInstanceActionOutputSchemasV1['widgets.item.move'].safeParse(result.result) : null;
    const expectedRef = move.success ? { surface: 'to' in move.data ? move.data.to.surface : move.data.ref.surface, instanceId: move.data.ref.instanceId } : null;
    const crossSurface = move.success && 'to' in move.data && !sameStrictJsonValue(move.data.ref.surface, move.data.to.surface);
    const acknowledgedId = ack?.success ? ack.data.item ? getWidgetLayoutItemIdV1(ack.data.item) : ack.data.instance?.id : null;
    if (ack?.success && expectedRef && sameStrictJsonValue(ack.data.ref, expectedRef) && acknowledgedId === expectedRef.instanceId
        && (!crossSurface || move.success && ack.data.status === 'moved' && sameStrictJsonValue(ack.data.fromRef, move.data.ref))) return { status: 'applied' };
    const details = !result.ok ? WidgetTransferFailureDetailsV1Schema.safeParse(result.details) : null;
    const correlatedDetails = details?.success && move.success && expectedRef
        && sameStrictJsonValue(details.data.fromRef, move.data.ref) && sameStrictJsonValue(details.data.toRef, expectedRef) ? details.data : null;
    const code = result.ok ? ActionApprovalRequestCreatedResultSchema.safeParse(result.result).success ? 'approval_pending' : 'widget_transfer_unknown' : result.errorCode;
    const unknown = result.ok || /unknown|unreachable|action_failed/.test(code);
    const message = unknown ? t('entityDragDrop.preview.unknownDetail') : t('entityDragDrop.preview.cantMoveHere');
    const diagnostic = correlatedDetails ? `${correlatedDetails.reasonCode} · ${correlatedDetails.phase} · ${correlatedDetails.source} / ${correlatedDetails.destination}` : code;
    publishPresentationNotice({ key: 'widgets.item.move', severity: unknown ? 'warning' : 'error',
        message: `${effect.preview.target}: ${message}`,
        undo: { label: t('common.details'), run: () => {
            if (!move.success || !areServerAccountScopesEqual(getActiveServerAccountScope(), move.data.ref.surface)) {
                Modal.alert(effect.preview.target, t('entityDragDrop.surface.scopeMismatch'));
                return;
            }
            // The owner alone supplies optional recovery content, after proving both copies absent.
            // Reveal it only in this Account; Details never retries, restores or removes a copy.
            Modal.alert(effect.preview.target, `${message}\n${correlatedDetails ? JSON.stringify(correlatedDetails, null, 2) : diagnostic}`);
        } },
    });
    return { status: unknown ? 'unknown' : 'refused', reason: { code, message: `${message} (${diagnostic})` } };
}

export async function executeWidgetEntityMovement(effect: EntityDropEffectV1, scope: Readonly<{ serverId: string; accountId: string }>, widgetAreaContext?: ActionExecutorContext['widgetAreaContext']): Promise<EntityDropOutcomeV1> {
    const parsed = WidgetInstanceActionInputSchemasV1['widgets.item.move'].safeParse(effect.input);
    if (effect.actionId !== 'widgets.item.move' || !parsed.success) return { status: 'refused', reason: { code: 'invalid_parameters', message: t('entityDragDrop.reasons.generic') } };
    try {
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const result = await createDefaultActionExecutor().execute('widgets.item.move', parsed.data, {
            surface: 'ui', actionCaller: { kind: 'host' }, serverId: scope.serverId, expectedAccountId: scope.accountId,
            ...(widgetAreaContext ? { widgetAreaContext } : {}),
        });
        return projectWidgetEntityMovementResult(result, effect);
    } catch {
        return projectWidgetEntityMovementResult({ ok: false, errorCode: 'widget_transfer_unknown', error: 'widget_transfer_unknown' }, effect);
    }
}
