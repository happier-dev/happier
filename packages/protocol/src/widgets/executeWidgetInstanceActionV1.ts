import { ActionExecuteFailureSchema, type ActionExecuteResult } from '../actions/actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../actions/executor/types.js';
import {
  WidgetInstanceActionInputSchemasV1, WidgetSurfaceReadV1Schema,
  WidgetMoveCaptureV1Schema, WidgetMoveDestinationV1Schema, WidgetInstanceActionOutputSchemasV1,
  readWidgetActionSurfaceV1,
  type WidgetInstanceActionIdV1, type WidgetSurfaceMutationV1, type WidgetActionSurfacePortV1, type WidgetProjectAreaV1,
} from './actionsV1.js';
import { WidgetInstanceRefV1Schema, WidgetSurfaceRefV1Schema, setWidgetInputBindingsV1, type WidgetSurfaceRefV1, type WidgetInstanceRefV1, type WidgetInstanceV1 } from './widgetInstanceV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { SessionBoardErrorCodeSchema } from '../sessions/board/errors.js';
import { createHomeWidgetActionPortV1 } from './homeWidgetActionPortV1.js';
import { createWorkBoardWidgetActionPortV1 } from './workBoardWidgetActionPortV1.js';
import { createSessionBoardWidgetActionPortV1 } from './sessionBoardWidgetActionPortV1.js';
import { admitWidgetActionSurfaceV1 } from './widgetActionScopeV1.js';
import { resolveWidgetSizeChoicesV1, normalizeWidgetSizeForSurfaceV1, supportsWidgetGroupsV1, type WidgetSizeV1 } from './widgetPresentationV1.js';
import { isWidgetTargetHostableV1 } from './widgetInputAdmissionV1.js';
import { readBuiltinWidgetDescriptorV1 } from './builtinWidgetDescriptorV1.js';
import { buildWidgetSurfaceArtifactIdV1, WidgetAreaMutationErrorV1 } from './widgetSurfaceArtifactV1.js';
import { findWidgetLayoutItemV1, WidgetLayoutMutationErrorV1 } from './widgetLayoutItemV1.js';

const failure = (errorCode: string): Extract<ActionExecuteResult, { ok: false }> => ({ ok: false, errorCode, error: errorCode });
export const readWidgetActionSurfacePortV1 = (deps: Pick<ActionExecutorDeps, 'widgetSurfaceActions' | 'homeHubArtifacts' | 'workBoardArtifacts' | 'sessionBoardAction'>, surface: WidgetSurfaceRefV1): WidgetActionSurfacePortV1 | undefined => deps.widgetSurfaceActions?.[surface.owner.kind]
  ?? (surface.owner.kind === 'home' && deps.homeHubArtifacts ? createHomeWidgetActionPortV1(deps.homeHubArtifacts) : undefined)
  ?? (surface.owner.kind === 'workBoard' && deps.workBoardArtifacts ? createWorkBoardWidgetActionPortV1(deps.workBoardArtifacts) : undefined)
  ?? (surface.owner.kind === 'sessionBoard' && deps.sessionBoardAction ? createSessionBoardWidgetActionPortV1(deps.sessionBoardAction) : undefined);
const surfacePort = readWidgetActionSurfacePortV1;

/** All configured-instance frontdoors admit saved values before invoking their owner writer. */
export async function admitWidgetInstanceConfigurationV1(
  deps: ActionExecutorDeps, ref: WidgetInstanceRefV1, instance: WidgetInstanceV1, context: ActionExecutorContext,
  groupBindings?: WidgetInstanceV1['bindings'],
): Promise<Extract<ActionExecuteResult, { ok: false }> | null> {
  if (!deps.widgetInputs) return failure('widget_inputs_unavailable');
  const validation = await deps.widgetInputs.resolve({ ref, instance, context, admission: 'configuration',
    ...(groupBindings ? { groupBindings } : {}),
    ...(context.signal ? { signal: context.signal } : {}) });
  context.signal?.throwIfAborted();
  return validation.status === 'ready' ? null : { ...failure('widget_inputs_invalid'), details: validation };
}

/** A refused owner write is known not to have committed; all other failures stay unknown. */
const knownRefusal = (code: string) => SessionBoardErrorCodeSchema.safeParse(code).success
  || code === 'widget_shared_input_forbidden' || code === 'artifact_access_forbidden'
  || code === 'widget_private_connection_selection' || code === 'widget_shared_resource_input_literal'
  || code === 'widget_group_width_no_fit' || code === 'widget_group_not_found' || code === 'widget_group_nesting_forbidden'
  || /^(widget_(instance_(changed|already_exists|not_found)|placement_(changed|ambiguous|required|unsupported)|index_placement_unsupported|size_unsupported|edit_denied|view_not_found)|widgets_move_conflict|invalid_widget_shared_content|account_target_mismatch|server_target_mismatch)$/.test(code);

async function readSizeChoices(deps: ActionExecutorDeps, ref: WidgetInstanceRefV1, instance: WidgetInstanceV1, context: ActionExecutorContext, groupBindings?: WidgetInstanceV1['bindings']) {
  if (!deps.widgetInputs) return null;
  const declaration = await deps.widgetInputs.readSizeDeclaration({ ref, instance, context, ...(groupBindings ? { groupBindings } : {}), ...(context.signal ? { signal: context.signal } : {}) });
  context.signal?.throwIfAborted();
  return declaration ? resolveWidgetSizeChoicesV1(ref.surface.owner.kind, declaration) : null;
}

/** Universal and native Action frontdoors share exact-definition presentation admission. */
export async function admitWidgetInstanceSizeV1(deps: ActionExecutorDeps, ref: WidgetInstanceRefV1, instance: WidgetInstanceV1,
  requested: WidgetSizeV1 | undefined, context: ActionExecutorContext, groupBindings?: WidgetInstanceV1['bindings']): Promise<Readonly<{ size: WidgetSizeV1 | undefined }> | Extract<ActionExecuteResult, { ok: false }>> {
  const choices = await readSizeChoices(deps, ref, instance, context, groupBindings);
  if (!choices) return failure('widget_type_unavailable');
  if (requested !== undefined && !choices.sizes.includes(requested)) return failure('widget_size_unsupported');
  return { size: requested ?? choices.defaultSize };
}

async function transferWidget(
  deps: ActionExecutorDeps, fromRef: WidgetInstanceRefV1, to: ReturnType<typeof WidgetMoveDestinationV1Schema.parse>,
  sourcePort: WidgetActionSurfacePortV1, instance: WidgetInstanceV1, context: ActionExecutorContext,
): Promise<ActionExecuteResult> {
  const toRef = { surface: to.surface, instanceId: instance.id };
  let phase: 'preflight' | 'destination_add' | 'source_remove' | 'compensation' = 'preflight';
  let destinationPresence: 'present' | 'absent' | 'unknown' = 'unknown';
  let destinationArea: WidgetProjectAreaV1 | undefined;
  const destinationPort = surfacePort(deps, to.surface);
  const refused = (reasonCode: string) => ({ ...failure('widget_transfer_refused'), details: { fromRef, toRef, phase, source: 'present', destination: destinationPresence, reasonCode } });
  const moved = (area = destinationArea) => ({ ok: true as const, result: { ref: toRef, fromRef, instance, status: 'moved' as const, ...(area ? { area } : {}) } });
  const read = async (port: WidgetActionSurfacePortV1 | undefined, surface: WidgetSurfaceRefV1) => {
      try {
        if (!port) return { state: 'unknown' as const, instance: undefined, area: undefined };
        const value = WidgetSurfaceReadV1Schema.safeParse(await port.read(surface, context, context.signal));
        if (!value.success || !sameStrictJsonValue(value.data.surface, surface)) return { state: 'unknown' as const, instance: undefined, area: undefined };
        const found = value.data.instances.find(entry => entry.instance.id === instance.id);
        return { state: found ? 'present' as const : 'absent' as const, instance: found?.instance, area: found?.area };
      } catch { return { state: 'unknown' as const, instance: undefined, area: undefined }; }
  };
  const readFacts = () => Promise.all([read(sourcePort, fromRef.surface), read(destinationPort, to.surface)]);
  const observedResult = (reasonCode: string, [source, destination]: Awaited<ReturnType<typeof readFacts>>, allowRefusal = false): ActionExecuteResult => {
    // One bounded observation per owner, never an unbounded recovery loop or an unsafe retry.
    if (source.state === 'absent' && destination.state === 'present' && sameStrictJsonValue(destination.instance, instance)) return moved(destination.area);
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
    const destinationGroup = to.groupId && target.data.items ? findWidgetLayoutItemV1(target.data.items, to.groupId) : undefined;
    if (to.groupId && destinationGroup?.kind !== 'group') return refused('widget_group_not_found');
    const groupBindings = destinationGroup?.kind === 'group' ? destinationGroup.context : undefined;
    if (target.data.instances.some(entry => entry.instance.id === instance.id)) return { ...refused('widget_instance_already_exists'), details: { fromRef, toRef, phase, source: 'present', destination: 'present', reasonCode: 'widget_instance_already_exists' } };
    const captureValue = await sourcePort.captureMove(fromRef.surface, instance.id, context, context.signal);
    const captureFailure = ActionExecuteFailureSchema.safeParse(captureValue);
    if (captureFailure.success) return refused(captureFailure.data.errorCode);
    const captured = WidgetMoveCaptureV1Schema.safeParse(captureValue);
    if (!captured.success) return refused('widget_source_capture_unavailable');
    if (!sameStrictJsonValue(captured.data.expectedInstance, instance)) return refused('widget_instance_changed');
    if (!deps.widgetInputs) return refused('widget_inputs_unavailable');
    const validation = await deps.widgetInputs.resolve({ ref: toRef, instance, context, admission: 'configuration', ...(groupBindings ? { groupBindings } : {}), ...(context.signal ? { signal: context.signal } : {}) });
    if (validation.status !== 'ready') return refused(`widget_destination_${validation.status}`);
    const choices = await readSizeChoices(deps, toRef, instance, context, groupBindings);
    if (!choices) return refused('widget_type_unavailable');
    context.signal?.throwIfAborted();
    phase = 'destination_add';
    const sourcePresentation = captured.data.expectedPresentation;
    const normalized = normalizeWidgetSizeForSurfaceV1(to.surface.owner.kind, sourcePresentation?.size);
    const size = normalized && choices.sizes.includes(normalized) ? normalized : choices.defaultSize;
    const added = await destinationPort.apply(to.surface, { kind: 'add', instance,
      position: { index: to.index, ...(to.tabId ? { tabId: to.tabId } : {}), ...(to.area ? { area: to.area } : {}), ...(to.groupId ? { groupId: to.groupId } : {}) }, captureForMove: true,
      presentation: { ...(size ? { size } : {}), ...(sourcePresentation?.frameStyle ? { frameStyle: sourcePresentation.frameStyle } : {}) },
    }, context, context.signal);
    if (!added.ok) return await observe(added.errorCode, knownRefusal(added.errorCode));
    const payload = added.result && typeof added.result === 'object' ? added.result : {};
    const destinationCapture = WidgetMoveCaptureV1Schema.safeParse(Reflect.get(payload, 'moveCapture'));
    if (!sameStrictJsonValue(Reflect.get(payload, 'ref'), toRef) || !destinationCapture.success
      || !sameStrictJsonValue(destinationCapture.data.expectedInstance, instance)) return await observe('widget_destination_ack_unknown');
    destinationArea = destinationCapture.data.expectedPresentation?.area;
    phase = 'source_remove';
    const removed = await sourcePort.apply(fromRef.surface, { kind: 'remove', instanceId: instance.id, ...captured.data }, context, context.signal);
    if (removed.ok) {
      const acknowledged = WidgetInstanceActionOutputSchemasV1['widgets.item.remove'].safeParse(removed.result);
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
  const surface = readWidgetActionSurfaceV1(args);
  if (!surface) return failure('invalid_parameters');
  const scopeRefusal = await admitWidgetActionSurfaceV1(deps, surface, context);
  if (scopeRefusal) return scopeRefusal;
  if (actionId === 'widgets.area.layout.select') return deps.widgetAreaLayoutSelect
    ? deps.widgetAreaLayoutSelect(surface, context, context.signal) : failure('widget_area_layout_owner_unavailable');
  if (actionId.startsWith('widgets.area.layout.')) {
    if (actionId === 'widgets.area.layout.delete' && surface.owner.kind === 'project' && !surface.owner.layoutId)
      return failure('widget_area_layout_default_protected');
    if (!deps.widgetAreaLayouts) return failure('widget_layouts_unavailable');
    try {
      let result: unknown;
      switch (actionId) {
        case 'widgets.area.layout.list': {
          const layouts = await deps.widgetAreaLayouts.list(WidgetInstanceActionInputSchemasV1[actionId].parse(args), context, context.signal);
          const refusal = ActionExecuteFailureSchema.safeParse(layouts);
          if (refusal.success) return refusal.data;
          result = { surface, layouts }; break;
        }
        case 'widgets.area.layout.create': result = await deps.widgetAreaLayouts.create(WidgetInstanceActionInputSchemasV1[actionId].parse(args), context, context.signal); break;
        case 'widgets.area.layout.rename': result = await deps.widgetAreaLayouts.rename(WidgetInstanceActionInputSchemasV1[actionId].parse(args), context, context.signal); break;
        case 'widgets.area.layout.delete': result = await deps.widgetAreaLayouts.delete(WidgetInstanceActionInputSchemasV1[actionId].parse(args), context, context.signal); break;
        case 'widgets.area.layout.reorder': result = await deps.widgetAreaLayouts.reorder(WidgetInstanceActionInputSchemasV1[actionId].parse(args), context, context.signal); break;
        case 'widgets.area.layout.reset': result = await deps.widgetAreaLayouts.reset(WidgetInstanceActionInputSchemasV1[actionId].parse(args), context, context.signal); break;
        case 'widgets.area.layout.undo': result = await deps.widgetAreaLayouts.undo(WidgetInstanceActionInputSchemasV1[actionId].parse(args).capture, context, context.signal); break;
        default: return failure('unsupported_action');
      }
      const refused = ActionExecuteFailureSchema.safeParse(result);
      return refused.success ? refused.data : { ok: true, result };
    } catch (error) {
      if (error instanceof WidgetAreaMutationErrorV1) return failure(error.code);
      throw error;
    }
  }

  if (actionId === 'widgets.catalog.list') {
    if (!deps.widgetCatalog) return failure('widget_catalog_unavailable');
    const catalog = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
    if (catalog.boundSession && catalog.boundSession.serverId !== surface.serverId) return failure('server_target_mismatch');
    const source = await deps.widgetCatalog.list(surface, context, context.signal, catalog.boundSession);
    const failed = ActionExecuteFailureSchema.safeParse(source);
    if (failed.success) return failed.data;
    if (!Array.isArray(source)) return failure('invalid_action_output');
    // Only what this surface can host: a checkout widget needs a surface that supplies the checkout.
    const entries = source.filter(entry => isWidgetTargetHostableV1({ inputs: { fields: entry.fields } }, surface.owner.kind))
      .map(entry => ({ ...entry, presentation: resolveWidgetSizeChoicesV1(surface.owner.kind, entry.sizeDeclaration) }));
    return { ok: true, result: { surface, entries, presentation: resolveWidgetSizeChoicesV1(surface.owner.kind) } };
  }
  if (actionId === 'widgets.item.refresh') {
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
  if (actionId === 'widgets.item.list') return { ok: true, result: state };
  const item = ref && state.items ? findWidgetLayoutItemV1(state.items, ref.instanceId) : undefined;
  if (actionId.startsWith('widgets.group.') || item?.kind === 'group') {
    if (!state.canEdit) return failure('widget_edit_denied');
    if (ref && item?.kind !== 'group') return failure('widget_group_not_found');
    let groupIntent: WidgetSurfaceMutationV1;
    switch (actionId) {
      case 'widgets.group.create': {
        const { surface: _surface, groupId, instanceIds, ...options } = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
        groupIntent = { kind: 'group_create', groupId, instanceIds, ...options }; break;
      }
      case 'widgets.group.add': {
        const add = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
        for (const child of add.group.children) {
          const childRef = { surface, instanceId: child.instance.id };
          const configuration = await admitWidgetInstanceConfigurationV1(deps, childRef, child.instance, context, add.group.context);
          if (configuration) return configuration;
          const size = await admitWidgetInstanceSizeV1(deps, childRef, child.instance, child.size, context, add.group.context);
          if ('ok' in size) return size;
        }
        groupIntent = { kind: 'group_add', group: add.group, ...(add.toIndex === undefined ? {} : { toIndex: add.toIndex }) }; break;
      }
      case 'widgets.group.ungroup': groupIntent = { kind: 'group_ungroup', instanceId: ref!.instanceId }; break;
      case 'widgets.group.set': {
        const { ref: _ref, ...options } = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
        groupIntent = { kind: 'group_set', instanceId: ref!.instanceId, ...options }; break;
      }
      case 'widgets.group.inputs.set': groupIntent = { kind: 'group_inputs', instanceId: ref!.instanceId, bindings: WidgetInstanceActionInputSchemasV1[actionId].parse(args).bindings }; break;
      case 'widgets.item.remove': groupIntent = { kind: 'remove', instanceId: ref!.instanceId }; break;
      case 'widgets.item.rename': groupIntent = { kind: 'rename', instanceId: ref!.instanceId, displayName: WidgetInstanceActionInputSchemasV1[actionId].parse(args).displayName }; break;
      case 'widgets.item.frame.set': groupIntent = { kind: 'frame', instanceId: ref!.instanceId, frameStyle: WidgetInstanceActionInputSchemasV1[actionId].parse(args).frameStyle }; break;
      case 'widgets.item.size.set': {
        const resize = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
        if (!('width' in resize)) return failure('widget_group_width_required');
        groupIntent = { kind: 'width', instanceId: ref!.instanceId, width: resize.width }; break;
      }
      case 'widgets.item.move': {
        const move = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
        if ('to' in move && !sameStrictJsonValue(move.to.surface, surface)) return failure('widget_group_transfer_unsupported');
        const target = 'to' in move ? move.to : move;
        // An explicit destination is native for groups too; Home's order includes builtin sections.
        groupIntent = { kind: 'move', instanceId: ref!.instanceId, ...('to' in move ? { nativeIndex: move.to.index } : { toIndex: move.toIndex }),
          ...(target.groupId === undefined ? {} : { groupId: target.groupId }), ...(target.area ? { area: target.area } : {}) }; break;
      }
      default: return failure('widget_group_operation_unsupported');
    }
    try { return await port.apply(surface, groupIntent, context, context.signal); }
    catch (error) {
      if (error instanceof WidgetLayoutMutationErrorV1) return { ...failure(error.code), ...(error.blockingChildId ? { details: { blockingChildId: error.blockingChildId } } : {}) };
      throw error;
    }
  }
  const existing = ref ? state.instances.find(entry => entry.instance.id === ref.instanceId)?.instance : undefined;
  if (ref && !existing) return failure('widget_instance_not_found');
  if (actionId === 'widgets.item.inputs.get') return { ok: true, result: { ref, bindings: existing!.bindings } };
  if (actionId === 'widgets.item.inputs.validate') {
    if (!deps.widgetInputs || !ref || !existing || !('bindings' in args)) return failure('widget_inputs_unavailable');
    const { bindings } = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
    return { ok: true, result: await deps.widgetInputs.resolve({ ref, instance: { ...existing, bindings }, context, admission: 'configuration', ...(context.signal ? { signal: context.signal } : {}) }) };
  }
  if (!state.canEdit) return failure('widget_edit_denied');
  let intent: WidgetSurfaceMutationV1;
  switch (actionId) {
    case 'widgets.item.add': {
      const add = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
      if (add.area && surface.owner.kind !== 'project') return failure('widget_placement_unsupported');
      if (add.groupId && !supportsWidgetGroupsV1(surface.owner.kind)) return failure('widget_placement_unsupported');
      // A checkout widget needs a surface that supplies the checkout (the target owner decides).
      const native = readBuiltinWidgetDescriptorV1(add.instance.definition);
      if (native && !isWidgetTargetHostableV1(native, surface.owner.kind)) return failure('unsupported_widget_surface');
      if (state.instances.some(entry => entry.instance.id === add.instance.id)) return failure('widget_instance_already_exists');
      const admitted = await admitWidgetInstanceSizeV1(deps, { surface, instanceId: add.instance.id }, add.instance, add.size, context);
      if ('ok' in admitted) return admitted;
      const { size } = admitted;
      intent = { kind: 'add', instance: add.instance, ...(add.area ? { area: add.area } : {}), ...(size ? { presentation: { size } } : {}), ...(add.toIndex === undefined ? {} : { toIndex: add.toIndex }), ...(add.placement ? { placement: add.placement } : {}), ...(add.groupId ? { groupId: add.groupId } : {}) };
      break;
    }
    case 'widgets.item.remove': intent = { kind: 'remove', instanceId: ref!.instanceId }; break;
    case 'widgets.item.move': {
      const move = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
      const area = 'to' in move ? move.to.area : move.area;
      if (area && ('to' in move ? move.to.surface : surface).owner.kind !== 'project') return failure('widget_placement_unsupported');
      if ('to' in move) {
        if (move.to.surface.serverId !== surface.serverId) return failure('server_target_mismatch');
        if (move.to.surface.accountId !== surface.accountId) return failure('account_target_mismatch');
        if (move.to.tabId && move.to.surface.owner.kind !== 'sessionBoard') return failure('widget_placement_unsupported');
        let sameDocument = sameStrictJsonValue(move.to.surface, surface);
        if (!sameDocument && surface.owner.kind === 'project' && move.to.surface.owner.kind === 'project') {
          const sourceId = buildWidgetSurfaceArtifactIdV1(surface);
          const destinationId = buildWidgetSurfaceArtifactIdV1(move.to.surface);
          sameDocument = sourceId === destinationId && (surface.artifactId ?? sourceId) === (move.to.surface.artifactId ?? destinationId);
          if (sameDocument) {
            const refusal = await admitWidgetActionSurfaceV1(deps, move.to.surface, context);
            if (refusal) return refusal;
          }
        }
        if (!sameDocument) return await transferWidget(deps, ref!, move.to, port, existing!, context);
        intent = { kind: 'move', instanceId: ref!.instanceId, nativeIndex: move.to.index, ...(move.to.groupId === undefined ? {} : { groupId: move.to.groupId }), ...(move.to.tabId ? { tabId: move.to.tabId } : {}), ...(area ? { area } : {}) };
      } else intent = { kind: 'move', instanceId: ref!.instanceId, toIndex: move.toIndex, ...(move.groupId === undefined ? {} : { groupId: move.groupId }), ...(area ? { area } : {}) };
      if (surface.owner.kind === 'project') {
        if (!port.captureMove) return failure('widget_source_capture_unavailable');
        const captured = await port.captureMove(surface, ref!.instanceId, context, context.signal);
        const refusal = ActionExecuteFailureSchema.safeParse(captured);
        if (refusal.success) return refusal.data;
        const capture = WidgetMoveCaptureV1Schema.safeParse(captured);
        if (!capture.success) return failure('widget_source_capture_unavailable');
        if (!sameStrictJsonValue(capture.data.expectedInstance, existing)) return failure('widget_instance_changed');
        intent = { ...intent, expectedInstance: capture.data.expectedInstance,
          ...(capture.data.expectedPresentation ? { expectedPresentation: capture.data.expectedPresentation } : {}) };
      }
      break;
    }
    case 'widgets.item.rename': intent = { kind: 'rename', instanceId: ref!.instanceId, displayName: WidgetInstanceActionInputSchemasV1[actionId].parse(args).displayName }; break;
    case 'widgets.item.size.set': {
      const resize = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
      if (!('size' in resize)) return failure('widget_size_required');
      const size = resize.size;
      const admitted = await admitWidgetInstanceSizeV1(deps, ref!, existing!, size, context);
      if ('ok' in admitted) return admitted;
      intent = { kind: 'size', instanceId: ref!.instanceId, size };
      break;
    }
    case 'widgets.item.frame.set': intent = { kind: 'frame', instanceId: ref!.instanceId, frameStyle: WidgetInstanceActionInputSchemasV1[actionId].parse(args).frameStyle }; break;
    case 'widgets.item.inputs.reset': {
      const { paths } = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
      // The owner removes choices from its current winner; stale Action reads cannot overwrite siblings.
      intent = { kind: 'inputs_reset', instanceId: ref!.instanceId, ...(paths ? { paths } : {}) };
      break;
    }
    case 'widgets.item.inputs.set': {
      const { bindings: selectedBindings, paths } = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
      const bindings = setWidgetInputBindingsV1(existing!.bindings, selectedBindings, paths);
      const refusal = await admitWidgetInstanceConfigurationV1(deps, ref!, { ...existing!, bindings }, context);
      if (refusal) return refusal;
      intent = { kind: 'inputs', instanceId: ref!.instanceId, bindings: selectedBindings, ...(paths ? { paths } : {}) };
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
    const acknowledged = WidgetInstanceActionOutputSchemasV1['widgets.item.add'].safeParse(added.result);
    if (!acknowledged.success || !sameStrictJsonValue(acknowledged.data.ref, instanceRef) || !sameStrictJsonValue(acknowledged.data.instance, intent.instance))
      return { ...failure('widget_add_unknown'), details: { ref: instanceRef, reasonCode: 'widget_add_ack_unknown' } };
    return { ok: true, result: acknowledged.data };
  }
  context.signal?.throwIfAborted();
  return await port.apply(surface, intent, context, context.signal);
}
