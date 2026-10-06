import { ActionExecuteFailureSchema, type ActionExecuteResult } from '../actions/actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../actions/executor/types.js';
import {
  WidgetInstanceActionInputSchemasV1, WidgetSurfaceReadV1Schema,
  WidgetMoveCaptureV1Schema, WidgetInstanceActionOutputSchemasV1,
  type WidgetInstanceActionIdV1, type WidgetSurfaceMutationV1, type WidgetActionSurfacePortV1,
} from './actionsV1.js';
import { WidgetInstanceRefV1Schema, WidgetSurfaceRefV1Schema, type WidgetSurfaceRefV1, type WidgetInstanceRefV1, type WidgetInstanceV1 } from './widgetInstanceV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { SessionBoardErrorCodeSchema } from '../sessions/board/errors.js';
import { createHomeWidgetActionPortV1 } from './homeWidgetActionPortV1.js';
import { createWorkBoardWidgetActionPortV1 } from './workBoardWidgetActionPortV1.js';
import { createSessionBoardWidgetActionPortV1 } from './sessionBoardWidgetActionPortV1.js';
import { admitWidgetActionSurfaceV1 } from './widgetActionScopeV1.js';

const failure = (errorCode: string): Extract<ActionExecuteResult, { ok: false }> => ({ ok: false, errorCode, error: errorCode });
export const readWidgetActionSurfacePortV1 = (deps: ActionExecutorDeps, surface: WidgetSurfaceRefV1): WidgetActionSurfacePortV1 | undefined => deps.widgetSurfaceActions?.[surface.owner.kind]
  ?? (surface.owner.kind === 'home' && deps.homeHubArtifacts ? createHomeWidgetActionPortV1(deps.homeHubArtifacts) : undefined)
  ?? (surface.owner.kind === 'workBoard' && deps.workBoardArtifacts ? createWorkBoardWidgetActionPortV1(deps.workBoardArtifacts) : undefined)
  ?? (surface.owner.kind === 'sessionBoard' && deps.sessionBoardAction ? createSessionBoardWidgetActionPortV1(deps.sessionBoardAction) : undefined);
const surfacePort = readWidgetActionSurfacePortV1;

/** All configured-instance frontdoors admit saved values before invoking their owner writer. */
export async function admitWidgetInstanceConfigurationV1(
  deps: ActionExecutorDeps, ref: WidgetInstanceRefV1, instance: WidgetInstanceV1, context: ActionExecutorContext,
): Promise<Extract<ActionExecuteResult, { ok: false }> | null> {
  if (!deps.widgetInputs) return failure('widget_inputs_unavailable');
  const validation = await deps.widgetInputs.resolve({ ref, instance, context, admission: 'configuration',
    ...(context.signal ? { signal: context.signal } : {}) });
  context.signal?.throwIfAborted();
  return validation.status === 'ready' ? null : { ...failure('widget_inputs_invalid'), details: validation };
}

/** A refused owner write is known not to have committed; all other failures stay unknown. */
const knownRefusal = (code: string) => SessionBoardErrorCodeSchema.safeParse(code).success
  || /^(widget_(instance_(changed|already_exists|not_found)|placement_(changed|ambiguous|required|unsupported)|index_placement_unsupported|width_unsupported|edit_denied|view_not_found)|widgets_move_conflict|invalid_widget_shared_content|account_target_mismatch|server_target_mismatch)$/.test(code);

async function transferWidget(
  deps: ActionExecutorDeps, fromRef: WidgetInstanceRefV1, to: Readonly<{ surface: WidgetSurfaceRefV1; tabId?: string; index: number }>,
  sourcePort: WidgetActionSurfacePortV1, instance: WidgetInstanceV1, context: ActionExecutorContext,
): Promise<ActionExecuteResult> {
  const toRef = { surface: to.surface, instanceId: instance.id };
  let phase: 'preflight' | 'destination_add' | 'source_remove' | 'compensation' = 'preflight';
  let destinationPresence: 'present' | 'absent' | 'unknown' = 'unknown';
  const destinationPort = surfacePort(deps, to.surface);
  const refused = (reasonCode: string) => ({ ...failure('widget_transfer_refused'), details: { fromRef, toRef, phase, source: 'present', destination: destinationPresence, reasonCode } });
  const moved = () => ({ ok: true as const, result: { ref: toRef, fromRef, instance, status: 'moved' as const } });
  const read = async (port: WidgetActionSurfacePortV1 | undefined, surface: WidgetSurfaceRefV1) => {
      try {
        if (!port) return { state: 'unknown' as const, instance: undefined };
        const value = WidgetSurfaceReadV1Schema.safeParse(await port.read(surface, context, context.signal));
        if (!value.success || !sameStrictJsonValue(value.data.surface, surface)) return { state: 'unknown' as const, instance: undefined };
        const found = value.data.instances.find(entry => entry.instance.id === instance.id)?.instance;
        return { state: found ? 'present' as const : 'absent' as const, instance: found };
      } catch { return { state: 'unknown' as const, instance: undefined }; }
  };
  const readFacts = () => Promise.all([read(sourcePort, fromRef.surface), read(destinationPort, to.surface)]);
  const observedResult = (reasonCode: string, [source, destination]: Awaited<ReturnType<typeof readFacts>>, allowRefusal = false): ActionExecuteResult => {
    // One bounded observation per owner, never an unbounded recovery loop or an unsafe retry.
    if (source.state === 'absent' && destination.state === 'present' && sameStrictJsonValue(destination.instance, instance)) return moved();
    const code = allowRefusal && source.state === 'present' && destination.state === 'absent' ? 'widget_transfer_refused' : 'widget_transfer_unknown';
    return { ...failure(code), details: { fromRef, toRef, phase, source: source.state, destination: destination.state, reasonCode,
      ...(source.state === 'absent' && destination.state === 'absent' ? { instance } : {}) } };
  };
  const observe = async (reasonCode: string, allowRefusal = false) => observedResult(reasonCode, await readFacts(), allowRefusal);
  try {
    if (!destinationPort?.captureMove || !sourcePort.captureMove) return refused('unsupported_widget_transfer');
    if (to.tabId && to.surface.owner.kind !== 'sessionBoard') return refused('widget_placement_unsupported');
    if (context.signal?.aborted) return refused('cancelled');
    const targetValue = await destinationPort.read(to.surface, context, context.signal);
    const targetFailure = ActionExecuteFailureSchema.safeParse(targetValue);
    if (targetFailure.success) return refused(targetFailure.data.errorCode);
    const target = WidgetSurfaceReadV1Schema.safeParse(targetValue);
    if (!target.success || !sameStrictJsonValue(target.data.surface, to.surface)) return refused('widget_destination_unavailable');
    destinationPresence = target.data.instances.some(entry => entry.instance.id === instance.id) ? 'present' : 'absent';
    if (!target.data.canEdit) return refused('widget_edit_denied');
    if (target.data.instances.some(entry => entry.instance.id === instance.id)) return { ...refused('widget_instance_already_exists'), details: { fromRef, toRef, phase, source: 'present', destination: 'present', reasonCode: 'widget_instance_already_exists' } };
    const captureValue = await sourcePort.captureMove(fromRef.surface, instance.id, context, context.signal);
    const captureFailure = ActionExecuteFailureSchema.safeParse(captureValue);
    if (captureFailure.success) return refused(captureFailure.data.errorCode);
    const captured = WidgetMoveCaptureV1Schema.safeParse(captureValue);
    if (!captured.success) return refused('widget_source_capture_unavailable');
    if (!sameStrictJsonValue(captured.data.expectedInstance, instance)) return refused('widget_instance_changed');
    if (!deps.widgetInputs) return refused('widget_inputs_unavailable');
    const validation = await deps.widgetInputs.resolve({ ref: toRef, instance, context, admission: 'configuration', ...(context.signal ? { signal: context.signal } : {}) });
    if (validation.status !== 'ready') return refused(`widget_destination_${validation.status}`);
    context.signal?.throwIfAborted();
    phase = 'destination_add';
    const sourcePresentation = captured.data.expectedPresentation;
    const added = await destinationPort.apply(to.surface, { kind: 'add', instance,
      position: { index: to.index, ...(to.tabId ? { tabId: to.tabId } : {}) }, captureForMove: true,
      ...(sourcePresentation ? { presentation: { ...(sourcePresentation.width && to.surface.owner.kind !== 'companion' ? { width: sourcePresentation.width } : {}), ...(sourcePresentation.frameStyle ? { frameStyle: sourcePresentation.frameStyle } : {}) } } : {}),
    }, context, context.signal);
    if (!added.ok) return await observe(added.errorCode, knownRefusal(added.errorCode));
    const payload = added.result && typeof added.result === 'object' ? added.result : {};
    const destinationCapture = WidgetMoveCaptureV1Schema.safeParse(Reflect.get(payload, 'moveCapture'));
    if (!sameStrictJsonValue(Reflect.get(payload, 'ref'), toRef) || !destinationCapture.success
      || !sameStrictJsonValue(destinationCapture.data.expectedInstance, instance)) return await observe('widget_destination_ack_unknown');
    phase = 'source_remove';
    const removed = await sourcePort.apply(fromRef.surface, { kind: 'remove', instanceId: instance.id, ...captured.data }, context, context.signal);
    if (removed.ok) {
      const acknowledged = WidgetInstanceActionOutputSchemasV1['widgets.instance.remove'].safeParse(removed.result);
      return acknowledged.success && acknowledged.data.instance === null && sameStrictJsonValue(acknowledged.data.ref, fromRef)
        ? moved() : await observe('widget_source_ack_unknown');
    }
    if (!knownRefusal(removed.errorCode)) return await observe(removed.errorCode);
    const beforeCompensation = await readFacts();
    if (beforeCompensation[0].state !== 'present') return observedResult(removed.errorCode, beforeCompensation);
    phase = 'compensation';
    const compensation = await destinationPort.apply(to.surface, { kind: 'remove', instanceId: instance.id, ...destinationCapture.data }, context, context.signal);
    return await observe(removed.errorCode, compensation.ok);
  } catch {
    return phase === 'preflight' ? refused(context.signal?.aborted ? 'cancelled' : 'widget_preflight_unavailable')
      : await observe(context.signal?.aborted ? 'cancelled' : 'widget_write_ack_unknown');
  }
}

export async function executeWidgetInstanceActionV1(
  deps: ActionExecutorDeps, actionId: WidgetInstanceActionIdV1, input: unknown, context: ActionExecutorContext,
): Promise<ActionExecuteResult> {
  const args = WidgetInstanceActionInputSchemasV1[actionId].parse(input);
  const ref = 'ref' in args ? args.ref : undefined;
  const surface = ref?.surface ?? ('surface' in args ? args.surface : undefined);
  if (!surface) return failure('invalid_parameters');
  const scopeRefusal = admitWidgetActionSurfaceV1(deps, surface, context);
  if (scopeRefusal) return scopeRefusal;
  if (actionId === 'widgets.area.layout.get') return executeWidgetInstanceActionV1(deps, 'widgets.instance.list', { surface }, context);
  if (actionId === 'widgets.area.layout.update') {
    const { intent } = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
    const ref = { surface, instanceId: intent.instanceId };
    if (intent.kind === 'move') return executeWidgetInstanceActionV1(deps, 'widgets.instance.move', { ref, toIndex: intent.toIndex }, context);
    if (intent.kind === 'width') return executeWidgetInstanceActionV1(deps, 'widgets.instance.width.set', { ref, width: intent.width }, context);
    return executeWidgetInstanceActionV1(deps, 'widgets.instance.frame.set', { ref, frameStyle: intent.frameStyle }, context);
  }

  if (actionId === 'widgets.catalog.list') {
    if (!deps.widgetCatalog) return failure('widget_catalog_unavailable');
    const catalog = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
    if (catalog.boundSession && catalog.boundSession.serverId !== surface.serverId) return failure('server_target_mismatch');
    const entries = await deps.widgetCatalog.list(surface, context, context.signal, catalog.boundSession);
    const failed = ActionExecuteFailureSchema.safeParse(entries);
    return failed.success ? failed.data : { ok: true, result: { surface, entries } };
  }
  if (actionId === 'widgets.instance.refresh') {
    return ref && deps.widgetRefresh
      ? await deps.widgetRefresh({ ref, context, ...(context.signal ? { signal: context.signal } : {}) })
      : failure('widget_refresh_unavailable');
  }
  const port = surfacePort(deps, surface);
  if (!port) return failure('unsupported_widget_surface');
  const read = await port.read(surface, context, context.signal);
  const refused = ActionExecuteFailureSchema.safeParse(read);
  if (refused.success) return refused.data;
  const parsedRead = WidgetSurfaceReadV1Schema.safeParse(read);
  if (!parsedRead.success || JSON.stringify(parsedRead.data.surface) !== JSON.stringify(WidgetSurfaceRefV1Schema.parse(surface))) return failure('invalid_action_output');
  const state = parsedRead.data;
  if (actionId === 'widgets.instance.list') return { ok: true, result: state };
  const existing = ref ? state.instances.find(entry => entry.instance.id === ref.instanceId)?.instance : undefined;
  if (ref && !existing) return failure('widget_instance_not_found');
  if (actionId === 'widgets.instance.inputs.get') return { ok: true, result: { ref, bindings: existing!.bindings } };
  if (actionId === 'widgets.instance.inputs.validate') {
    if (!deps.widgetInputs || !ref || !existing || !('bindings' in args)) return failure('widget_inputs_unavailable');
    const { bindings } = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
    return { ok: true, result: await deps.widgetInputs.resolve({ ref, instance: { ...existing, bindings }, context, admission: 'configuration', ...(context.signal ? { signal: context.signal } : {}) }) };
  }
  if (!state.canEdit) return failure('widget_edit_denied');
  let intent: WidgetSurfaceMutationV1;
  switch (actionId) {
    case 'widgets.instance.add': {
      const add = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
      if (state.instances.some(entry => entry.instance.id === add.instance.id)) return failure('widget_instance_already_exists');
      intent = { kind: 'add', instance: add.instance, ...(add.toIndex === undefined ? {} : { toIndex: add.toIndex }), ...(add.placement ? { placement: add.placement } : {}) };
      break;
    }
    case 'widgets.instance.remove': intent = { kind: 'remove', instanceId: ref!.instanceId }; break;
    case 'widgets.instance.move': {
      const move = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
      if ('to' in move) {
        if (move.to.surface.serverId !== surface.serverId) return failure('server_target_mismatch');
        if (move.to.surface.accountId !== surface.accountId) return failure('account_target_mismatch');
        if (move.to.tabId && move.to.surface.owner.kind !== 'sessionBoard') return failure('widget_placement_unsupported');
        if (!sameStrictJsonValue(move.to.surface, surface)) return await transferWidget(deps, ref!, move.to, port, existing!, context);
        intent = { kind: 'move', instanceId: ref!.instanceId, nativeIndex: move.to.index, ...(move.to.tabId ? { tabId: move.to.tabId } : {}) };
      } else intent = { kind: 'move', instanceId: ref!.instanceId, toIndex: move.toIndex };
      break;
    }
    case 'widgets.instance.rename': intent = { kind: 'rename', instanceId: ref!.instanceId, displayName: WidgetInstanceActionInputSchemasV1[actionId].parse(args).displayName }; break;
    case 'widgets.instance.width.set': intent = { kind: 'width', instanceId: ref!.instanceId, width: WidgetInstanceActionInputSchemasV1[actionId].parse(args).width }; break;
    case 'widgets.instance.frame.set': intent = { kind: 'frame', instanceId: ref!.instanceId, frameStyle: WidgetInstanceActionInputSchemasV1[actionId].parse(args).frameStyle }; break;
    case 'widgets.instance.inputs.set':
    case 'widgets.instance.inputs.reset': {
      const bindings = actionId === 'widgets.instance.inputs.reset' ? {} : WidgetInstanceActionInputSchemasV1[actionId].parse(args).bindings;
      // Reset deliberately leaves missing input repairable. A set cannot silently admit invalid pins.
      if (actionId === 'widgets.instance.inputs.set') {
        const refusal = await admitWidgetInstanceConfigurationV1(deps, ref!, { ...existing!, bindings }, context);
        if (refusal) return refusal;
      }
      intent = { kind: 'inputs', instanceId: ref!.instanceId, bindings };
      break;
    }
    default: return failure('unsupported_action');
  }
  if (intent.kind === 'add') {
    const instanceRef = WidgetInstanceRefV1Schema.parse({ surface, instanceId: intent.instance.id });
    const refusal = await admitWidgetInstanceConfigurationV1(deps, instanceRef, intent.instance, context);
    if (refusal) return refusal;
    let added: ActionExecuteResult;
    try { added = await port.apply(surface, intent, context, context.signal); }
    catch { return { ...failure('widget_add_unknown'), details: { ref: instanceRef, reasonCode: context.signal?.aborted ? 'cancelled' : 'widget_write_ack_unknown' } }; }
    if (!added.ok) return knownRefusal(added.errorCode) ? added : { ...failure('widget_add_unknown'), details: { ref: instanceRef, reasonCode: added.errorCode } };
    const acknowledged = WidgetInstanceActionOutputSchemasV1['widgets.instance.add'].safeParse(added.result);
    if (!acknowledged.success || !sameStrictJsonValue(acknowledged.data.ref, instanceRef) || !sameStrictJsonValue(acknowledged.data.instance, intent.instance))
      return { ...failure('widget_add_unknown'), details: { ref: instanceRef, reasonCode: 'widget_add_ack_unknown' } };
    return { ok: true, result: { ref: instanceRef, instance: intent.instance } };
  }
  context.signal?.throwIfAborted();
  return await port.apply(surface, intent, context, context.signal);
}
