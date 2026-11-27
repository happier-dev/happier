import { ActionExecuteFailureSchema, type ActionExecuteResult } from '../actions/actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../actions/executor/types.js';
import {
  WidgetInstanceActionInputSchemasV1, WidgetSurfaceReadV1Schema,
  WidgetMoveCaptureV1Schema, WidgetMoveDestinationV1Schema, WidgetInstanceActionOutputSchemasV1,
  readWidgetActionSurfaceV1,
  type WidgetInstanceActionIdV1, type WidgetSurfaceMutationV1, type WidgetActionSurfacePortV1, type WidgetProjectAreaV1, type WidgetSurfaceReadV1,
} from './actionsV1.js';
import { WidgetInstanceRefV1Schema, WidgetSurfaceRefV1Schema, setWidgetInputBindingsV1, type WidgetSurfaceRefV1, type WidgetInstanceRefV1, type WidgetInstanceV1 } from './widgetInstanceV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { SessionBoardErrorCodeSchema } from '../sessions/board/errors.js';
import { createHomeWidgetActionPortV1 } from './homeWidgetActionPortV1.js';
import { createWorkBoardWidgetActionPortV1 } from './workBoardWidgetActionPortV1.js';
import { createSessionBoardWidgetActionPortV1 } from './sessionBoardWidgetActionPortV1.js';
import { admitWidgetActionSurfaceV1, readWidgetActionAccountScopeAdmissionV1, readWidgetActionSurfaceAdmissionV1 } from './widgetActionScopeV1.js';
import { resolveWidgetSizeChoicesV1, normalizeWidgetSizeForSurfaceV1, supportsWidgetGroupsV1, type WidgetSizeV1 } from './widgetPresentationV1.js';
import { isWidgetTargetHostableV1 } from './widgetInputAdmissionV1.js';
import { readBuiltinWidgetDescriptorV1 } from './builtinWidgetDescriptorV1.js';
import { buildWidgetSurfaceArtifactIdV1, WidgetAreaMutationErrorV1 } from './widgetSurfaceArtifactV1.js';
import { findWidgetLayoutItemV1, findWidgetLayoutParentV1, WidgetLayoutMutationErrorV1 } from './widgetLayoutItemV1.js';
import { isPublicProfileWidgetSurfaceV1, projectWidgetPublicProfileDescriptorV1 } from './widgetPublicProfileAdmissionV1.js';
import { createWidgetAreaReadFailureV1, projectWidgetAreaReadExceptionV1 } from './widgetAreaReadFailureV1.js';
import { isUsageMainWidgetSurfaceV1 } from './usageWidgetPresetsV1.js';
import { MACHINE_RPC_TIMEOUT_ERROR_CODE, RPC_ERROR_CODES } from '../rpc/errors.js';

const failure = (errorCode: string): Extract<ActionExecuteResult, { ok: false }> => ({ ok: false, errorCode, error: errorCode });
export const readWidgetActionSurfacePortV1 = (deps: Pick<ActionExecutorDeps, 'widgetSurfaceActions' | 'homeHubArtifacts' | 'workBoardArtifacts' | 'sessionBoardAction'>, surface: WidgetSurfaceRefV1): WidgetActionSurfacePortV1 | undefined => deps.widgetSurfaceActions?.[surface.owner.kind]
  ?? (surface.owner.kind === 'home' && deps.homeHubArtifacts ? createHomeWidgetActionPortV1(deps.homeHubArtifacts) : undefined)
  ?? (surface.owner.kind === 'workBoard' && deps.workBoardArtifacts ? createWorkBoardWidgetActionPortV1(deps.workBoardArtifacts) : undefined)
  ?? (surface.owner.kind === 'sessionBoard' && deps.sessionBoardAction ? createSessionBoardWidgetActionPortV1(deps.sessionBoardAction) : undefined);
const surfacePort = readWidgetActionSurfacePortV1;

function isWidgetInputAcquisitionFailure(reasonCode: string): boolean {
  switch (reasonCode) {
    case 'connected_account_purpose_catalog_unavailable':
    case 'widget_workspace_authority_unavailable':
    case 'input_type_options_unavailable':
    case 'server_unreachable':
    case 'machine_unavailable':
    case 'machine_offline':
    case 'machine_socket_unavailable':
    case RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE:
    case MACHINE_RPC_TIMEOUT_ERROR_CODE:
      return true;
    default:
      return false;
  }
}

async function readWidgetPlacementReviewFacts<T>(read: () => Promise<T>): Promise<Readonly<{ ok: true; value: T }> | Extract<ActionExecuteResult, { ok: false }>> {
  try { return { ok: true, value: await read() }; }
  catch (error) { return projectWidgetAreaReadExceptionV1(error); }
}

/** Shared Project writes may name an unnamed instance; every other captured field stays exact. */
export function matchesWidgetWriteAcknowledgement(surface: WidgetSurfaceRefV1, expected: WidgetInstanceV1, actual: WidgetInstanceV1 | null | undefined): boolean {
  if (sameStrictJsonValue(actual, expected)) return true;
  return surface.owner.kind === 'project' && expected.displayName === undefined && actual?.displayName !== undefined
    && sameStrictJsonValue(actual, { ...expected, displayName: actual.displayName });
}

/** All configured-instance frontdoors admit saved values before invoking their owner writer. */
export async function admitWidgetInstanceConfigurationV1(
  deps: ActionExecutorDeps, ref: WidgetInstanceRefV1, instance: WidgetInstanceV1, context: ActionExecutorContext,
  groupBindings?: WidgetInstanceV1['bindings'],
  configurationPatch?: Parameters<NonNullable<ActionExecutorDeps['widgetInputs']>['resolve']>[0]['configurationPatch'],
  admittedSurfaceRead?: WidgetSurfaceReadV1,
): Promise<Extract<ActionExecuteResult, { ok: false }> | null> {
  if (!deps.widgetInputs) return failure('widget_inputs_unavailable');
  const validation = await deps.widgetInputs.resolve({ ref, instance, context, admission: 'configuration',
    ...(admittedSurfaceRead ? { admittedSurfaceRead } : {}),
    ...(groupBindings ? { groupBindings } : {}),
    ...(configurationPatch ? { configurationPatch } : {}),
    ...(context.signal ? { signal: context.signal } : {}) });
  context.signal?.throwIfAborted();
  return validation.status === 'ready' ? null : { ...failure('widget_inputs_invalid'), details: validation };
}

type WidgetGroupConfigurationChangeV1 = Extract<WidgetSurfaceMutationV1, { kind: 'group_inputs' | 'group_create' | 'group_add' }>;

/** Both widget and Home Actions admit group inputs before invoking their owner writer. */
export async function admitWidgetGroupConfigurationV1(
  deps: ActionExecutorDeps, state: WidgetSurfaceReadV1, change: WidgetGroupConfigurationChangeV1, context: ActionExecutorContext,
  reviewGroupAdd?: true,
): Promise<Extract<ActionExecuteResult, { ok: false }> | null> {
  const surface = state.surface;
  const currentItems = state.items ?? [];
  let group: Readonly<{ context?: WidgetInstanceV1['bindings']; children: readonly { instance: WidgetInstanceV1 }[] }>;
  switch (change.kind) {
    case 'group_inputs': {
      const existing = findWidgetLayoutItemV1(currentItems, change.instanceId);
      if (existing?.kind !== 'group') return failure('widget_group_not_found');
      group = { children: existing.children, context: change.bindings };
      break;
    }
    case 'group_create': {
      if (!change.context || Object.keys(change.context).length === 0) return null;
      const children = change.instanceIds.flatMap(id => {
        const child = findWidgetLayoutItemV1(currentItems, id);
        return child?.kind === 'widget' ? [child] : [];
      });
      group = { children, context: change.context };
      break;
    }
    case 'group_add': group = change.group; break;
  }
  const bindings = group.context ?? {};
  if (isPublicProfileWidgetSurfaceV1(surface) && Object.keys(bindings).length) return failure('widget_public_profile_input_forbidden');
  for (const { instance } of group.children) {
    const previousBindings = findWidgetLayoutParentV1(currentItems, instance.id)?.context ?? {};
    const followsChangedSlot = Object.values(instance.bindings).some(binding =>
      binding.kind === 'context' && !sameStrictJsonValue(previousBindings[binding.slot], bindings[binding.slot]));
    if (change.kind !== 'group_add' && !followsChangedSlot) continue;
    const widgetInputs = deps.widgetInputs;
    if (!widgetInputs) return reviewGroupAdd
      ? createWidgetAreaReadFailureV1('widget_inputs_unavailable') : failure('widget_inputs_unavailable');
    const resolve = (groupBindings: WidgetInstanceV1['bindings']) => widgetInputs.resolve({
      ref: { surface, instanceId: instance.id }, instance, context, groupBindings, admission: 'configuration',
      admittedSurfaceRead: state, ...(context.signal ? { signal: context.signal } : {}),
    });
    const read = reviewGroupAdd ? await readWidgetPlacementReviewFacts(() => resolve(bindings))
      : { ok: true as const, value: await resolve(bindings) };
    if (!read.ok) return read;
    const proposed = read.value;
    context.signal?.throwIfAborted();
    if (proposed.status === 'ready') continue;
    const refusal = { ...failure('widget_inputs_invalid'), details: { ...proposed, blockingChildId: instance.id } };
    // A new imported group admits all child inputs. An edit must preserve unrelated, pre-existing issues.
    if (change.kind === 'group_add') {
      const deciding = reviewGroupAdd
        ? proposed.fields.find(issue => !isWidgetInputAcquisitionFailure(issue.reasonCode))
        : proposed.fields.find(issue => issue.status === proposed.status);
      if (reviewGroupAdd && !deciding && proposed.fields[0]) {
        return createWidgetAreaReadFailureV1(proposed.fields[0].reasonCode);
      }
      return deciding ? { ...refusal, details: { ...refusal.details, blockingFieldPath: deciding.path } } : refusal;
    }
    const blocking = proposed.fields.filter(issue => issue.status === 'invalid' || issue.status === 'selection_required');
    if (blocking.length === 0) continue;
    const previous = await resolve(previousBindings);
    context.signal?.throwIfAborted();
    const deciding = blocking.find(issue => previous.status === 'ready' || !previous.fields.some(old => sameStrictJsonValue(old, issue)));
    if (deciding) return { ...refusal, details: { ...refusal.details, blockingFieldPath: deciding.path } };
  }
  return null;
}

/**
 * A refusal is only a determination about the inputs when the read could answer. A caller whose authority
 * cannot make a Home read (an agent's Session caller signs with its root Action's authorization) is
 * answered "not authenticated" for every pick, which says nothing about this one: the approved execution,
 * where the person's own Account reads, decides.
 */
export function isWidgetAdmissionUndecidableHereV1(refusal: Extract<ActionExecuteResult, { ok: false }>): boolean {
  const details = refusal.details as Readonly<{ status?: unknown; fields?: unknown }> | undefined;
  const fields = details?.status === 'unavailable' && Array.isArray(details.fields) ? details.fields : [];
  return fields.length > 0 && fields.every(field => (field as Readonly<{ reasonCode?: unknown }>)?.reasonCode === 'not_authenticated');
}

/** A refused owner write is known not to have committed; all other failures stay unknown. */
const knownRefusal = (code: string) => SessionBoardErrorCodeSchema.safeParse(code).success
  || code === 'widget_shared_input_forbidden' || code === 'artifact_access_forbidden'
  || code === 'widget_private_connection_selection' || code === 'widget_shared_resource_input_literal'
  || code === 'widget_group_width_no_fit' || code === 'widget_group_not_found' || code === 'widget_group_nesting_forbidden'
  || /^(widget_(instance_(changed|already_exists|not_found)|placement_(changed|ambiguous|required|unsupported)|index_placement_unsupported|size_unsupported|edit_denied|view_not_found)|widgets_move_conflict|invalid_widget_shared_content|account_target_mismatch|server_target_mismatch)$/.test(code);

async function readSizeChoices(deps: ActionExecutorDeps, ref: WidgetInstanceRefV1, instance: WidgetInstanceV1, context: ActionExecutorContext, groupBindings?: WidgetInstanceV1['bindings'], admittedSurfaceRead?: WidgetSurfaceReadV1) {
  if (!deps.widgetInputs) return null;
  const declaration = await deps.widgetInputs.readSizeDeclaration({ ref, instance, context, ...(groupBindings ? { groupBindings } : {}), ...(admittedSurfaceRead ? { admittedSurfaceRead } : {}), ...(context.signal ? { signal: context.signal } : {}) });
  context.signal?.throwIfAborted();
  return declaration ? resolveWidgetSizeChoicesV1(ref.surface.owner.kind, declaration) : null;
}

/** Universal and native Action frontdoors share exact-definition presentation admission. */
export async function admitWidgetInstanceSizeV1(deps: ActionExecutorDeps, ref: WidgetInstanceRefV1, instance: WidgetInstanceV1,
  requested: WidgetSizeV1 | undefined, context: ActionExecutorContext, groupBindings?: WidgetInstanceV1['bindings'], admittedSurfaceRead?: WidgetSurfaceReadV1): Promise<Readonly<{ size: WidgetSizeV1 | undefined }> | Extract<ActionExecuteResult, { ok: false }>> {
  const choices = await readSizeChoices(deps, ref, instance, context, groupBindings, admittedSurfaceRead);
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
  let destinationInstance = instance;
  const destinationPort = surfacePort(deps, to.surface);
  const refused = (reasonCode: string) => ({ ...failure('widget_transfer_refused'), details: { fromRef, toRef, phase, source: 'present', destination: destinationPresence, reasonCode } });
  const moved = (area = destinationArea) => ({ ok: true as const, result: { ref: toRef, fromRef, instance: destinationInstance, status: 'moved' as const, ...(area ? { area } : {}) } });
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
    if (source.state === 'absent' && destination.state === 'present' && matchesWidgetWriteAcknowledgement(to.surface, destinationInstance, destination.instance)) {
      destinationInstance = destination.instance!;
      return moved(destination.area);
    }
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
    const validation = await deps.widgetInputs.resolve({ ref: toRef, instance, context, admission: 'configuration', admittedSurfaceRead: target.data, ...(groupBindings ? { groupBindings } : {}), ...(context.signal ? { signal: context.signal } : {}) });
    if (validation.status !== 'ready') return refused(`widget_destination_${validation.status}`);
    const choices = await readSizeChoices(deps, toRef, instance, context, groupBindings, target.data);
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
      || !matchesWidgetWriteAcknowledgement(to.surface, instance, destinationCapture.data.expectedInstance)) return await observe('widget_destination_ack_unknown');
    destinationInstance = destinationCapture.data.expectedInstance;
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
  admittedSurfaceRead?: WidgetSurfaceReadV1,
  reviewGroupAdd?: true,
): Promise<ActionExecuteResult> {
  const args = WidgetInstanceActionInputSchemasV1[actionId].parse(input);
  const ref = 'ref' in args ? args.ref : undefined;
  const surface = readWidgetActionSurfaceV1(args);
  if (!surface) return failure('invalid_parameters');
  if (actionId === 'widgets.area.layout.select') {
    const account = readWidgetActionAccountScopeAdmissionV1(deps, surface, context);
    if (!account.ok) return account;
    // The answering mounted area owns its route/local selection and captured defaults.
    return deps.widgetAreaLayoutSelect ? deps.widgetAreaLayoutSelect(surface, context, context.signal)
      : failure('widget_area_layout_owner_unavailable');
  }
  const admission = admittedSurfaceRead ? { ok: true as const, read: admittedSurfaceRead }
    : await readWidgetActionSurfaceAdmissionV1(deps, surface, context, reviewGroupAdd ? { readPlacement: true } : undefined);
  if (!admission.ok) return admission;
  if (actionId.startsWith('widgets.area.layout.')) {
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
    if (catalog.boundSession) {
      const boundScope = readWidgetActionAccountScopeAdmissionV1(deps,
        { serverId: catalog.boundSession.serverId, accountId: surface.accountId, owner: surface.owner, ...(surface.artifactId ? { artifactId: surface.artifactId } : {}) }, context);
      if (!boundScope.ok) return boundScope;
    }
    const source = await deps.widgetCatalog.list(surface, context, context.signal, catalog.boundSession);
    const failed = ActionExecuteFailureSchema.safeParse(source);
    if (failed.success) return failed.data;
    if (!Array.isArray(source)) return failure('invalid_action_output');
    // Share declared-target admission with Gallery; bindings still require exact target authority.
    const admittedSource = isPublicProfileWidgetSurfaceV1(surface) ? source.flatMap(entry => {
      const descriptor = projectWidgetPublicProfileDescriptorV1(entry.definition, { ...entry, inputs: { fields: entry.fields } });
      return descriptor ? [{ ...entry, fields: [...descriptor.inputs?.fields ?? []], inputSchema: descriptor.inputSchema }] : [];
    }) : source;
    const entries = admittedSource.filter(entry => isWidgetTargetHostableV1({ target: entry.target, inputs: { fields: entry.fields } }, surface.owner.kind))
      .map(({ target: _target, ...entry }) => ({ ...entry, presentation: resolveWidgetSizeChoicesV1(surface.owner.kind, entry.sizeDeclaration) }));
    return { ok: true, result: { surface, entries, presentation: resolveWidgetSizeChoicesV1(surface.owner.kind) } };
  }
  if (actionId === 'widgets.item.refresh') {
    return ref && deps.widgetRefresh
      ? await deps.widgetRefresh({ ref, context, ...(context.signal ? { signal: context.signal } : {}) })
      : failure('widget_refresh_unavailable');
  }
  const port = surfacePort(deps, surface);
  if (!port) return failure('unsupported_widget_surface');
  // Admission already read Artifact-backed placements in this execution. No user/policy await
  // intervenes on this path; the writer still obtains fresh access/revision for its CAS below.
  const read = admission.read ?? await port.read(surface, context, context.signal);
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
        groupIntent = { kind: 'group_add', group: add.group, ...(add.toIndex === undefined ? {} : { toIndex: add.toIndex }) }; break;
      }
      case 'widgets.group.ungroup': groupIntent = { kind: 'group_ungroup', instanceId: ref!.instanceId }; break;
      case 'widgets.group.set': {
        const { ref: _ref, ...options } = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
        groupIntent = { kind: 'group_set', instanceId: ref!.instanceId, ...options }; break;
      }
      case 'widgets.group.inputs.set': {
        const { bindings } = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
        groupIntent = { kind: 'group_inputs', instanceId: ref!.instanceId, bindings }; break;
      }
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
    if (groupIntent.kind === 'group_inputs' || groupIntent.kind === 'group_create' || groupIntent.kind === 'group_add') {
      const refusal = await admitWidgetGroupConfigurationV1(deps, state, groupIntent, context, reviewGroupAdd);
      if (refusal) return refusal;
    }
    if (groupIntent.kind === 'group_add') {
      for (const child of groupIntent.group.children) {
        const childRef = { surface, instanceId: child.instance.id };
        const admitSize = () => admitWidgetInstanceSizeV1(deps, childRef, child.instance, child.size, context, groupIntent.group.context, state);
        const size = reviewGroupAdd ? await readWidgetPlacementReviewFacts(admitSize) : { ok: true as const, value: await admitSize() };
        if (!size.ok) return size;
        if ('ok' in size.value) return size.value;
      }
      if (reviewGroupAdd) return { ok: true, result: null };
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
    return { ok: true, result: await deps.widgetInputs.resolve({ ref, instance: { ...existing, bindings }, context, admission: 'configuration', admittedSurfaceRead: state, ...(context.signal ? { signal: context.signal } : {}) }) };
  }
  if (!state.canEdit) return failure('widget_edit_denied');
  let intent: WidgetSurfaceMutationV1;
  switch (actionId) {
    case 'widgets.item.add': {
      const add = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
      if (add.area && surface.owner.kind !== 'project') return failure('widget_placement_unsupported');
      if (add.groupId && !supportsWidgetGroupsV1(surface.owner.kind)) return failure('widget_placement_unsupported');
      // Reject invalid declarations before binding and size admission.
      const native = readBuiltinWidgetDescriptorV1(add.instance.definition);
      if (native && !isWidgetTargetHostableV1(native, surface.owner.kind)) return failure('unsupported_widget_surface');
      if (state.instances.some(entry => entry.instance.id === add.instance.id)) return failure('widget_instance_already_exists');
      const admitted = await admitWidgetInstanceSizeV1(deps, { surface, instanceId: add.instance.id }, add.instance, add.size, context, undefined, state);
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
        const destinationScope = readWidgetActionAccountScopeAdmissionV1(deps, move.to.surface, context);
        if (!destinationScope.ok) return destinationScope;
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
      const admitted = await admitWidgetInstanceSizeV1(deps, ref!, existing!, size, context, undefined, state);
      if ('ok' in admitted) return admitted;
      intent = { kind: 'size', instanceId: ref!.instanceId, size };
      break;
    }
    case 'widgets.item.frame.set': intent = { kind: 'frame', instanceId: ref!.instanceId, frameStyle: WidgetInstanceActionInputSchemasV1[actionId].parse(args).frameStyle }; break;
    case 'widgets.item.network.set':
      if (isPublicProfileWidgetSurfaceV1(surface)) return failure('widget_public_profile_input_forbidden');
      intent = { kind: 'network', instanceId: ref!.instanceId, network: WidgetInstanceActionInputSchemasV1[actionId].parse(args).network }; break;
    case 'widgets.item.inputs.reset': {
      const { paths } = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
      const selection = { instanceId: ref!.instanceId, ...(paths ? { paths } : {}) };
      // The writer applies exact paths to its current winner, preserving concurrent sibling edits.
      if (isUsageMainWidgetSurfaceV1(surface) && existing!.definition.kind !== 'builtin') {
        const bindings = await deps.widgetInputs?.readUsagePageFollowBindings?.({
          ref: ref!, instance: existing!, context, admittedSurfaceRead: state,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        if (!bindings) return failure('widget_type_unavailable');
        intent = { kind: 'inputs_reset', ...selection, usageFollow: { definition: existing!.definition, bindings } };
      } else {
        intent = { kind: 'inputs_reset', ...selection };
      }
      break;
    }
    case 'widgets.item.inputs.set': {
      const { bindings: selectedBindings, paths } = WidgetInstanceActionInputSchemasV1[actionId].parse(args);
      const bindings = setWidgetInputBindingsV1(existing!.bindings, selectedBindings, paths);
      const refusal = await admitWidgetInstanceConfigurationV1(deps, ref!, { ...existing!, bindings }, context, undefined,
        paths ? { paths, previousBindings: existing!.bindings } : undefined, state);
      if (refusal) return refusal;
      intent = { kind: 'inputs', instanceId: ref!.instanceId, bindings: selectedBindings, ...(paths ? { paths } : {}) };
      break;
    }
    default: return failure('unsupported_action');
  }
  if (intent.kind === 'add') {
    const instanceRef = WidgetInstanceRefV1Schema.parse({ surface, instanceId: intent.instance.id });
    const refusal = await admitWidgetInstanceConfigurationV1(deps, instanceRef, intent.instance, context, undefined, undefined, state);
    if (refusal) return refusal;
    let added: ActionExecuteResult;
    try { added = await port.apply(surface, intent, context, context.signal); }
    catch { return { ...failure('widget_add_unknown'), details: { ref: instanceRef, reasonCode: context.signal?.aborted ? 'cancelled' : 'widget_write_ack_unknown' } }; }
    if (!added.ok) return knownRefusal(added.errorCode) ? added : { ...failure('widget_add_unknown'), details: { ref: instanceRef, reasonCode: added.errorCode } };
    const acknowledged = WidgetInstanceActionOutputSchemasV1['widgets.item.add'].safeParse(added.result);
    if (!acknowledged.success || !sameStrictJsonValue(acknowledged.data.ref, instanceRef) || !matchesWidgetWriteAcknowledgement(surface, intent.instance, acknowledged.data.instance))
      return { ...failure('widget_add_unknown'), details: { ref: instanceRef, reasonCode: 'widget_add_ack_unknown' } };
    return { ok: true, result: acknowledged.data };
  }
  context.signal?.throwIfAborted();
  return await port.apply(surface, intent, context, context.signal);
}
