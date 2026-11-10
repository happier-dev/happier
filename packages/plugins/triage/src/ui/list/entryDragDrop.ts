import type { PluginClientApi, PluginDragSourceRuntime, PluginDropTargetRuntime } from '@happier-dev/plugin-sdk';
import { defineProtocolArray, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import {
  TriageEntryRefV1Schema,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
} from '@happier-dev/triage-protocol/v1';

import {
  TriageEntrySessionLinkDisplayV1Schema,
  TriageLinkEntryToSessionInputV1Schema,
  TriageLinkEntryToSessionActionResultV1Schema,
  TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1,
} from '../../actions/sessionLinksProtocol.js';
import { parseTriageComposerEntryAttachmentValue } from '../../composer/attachmentValue.js';
import { buildTriageEntryAttachmentDraftV1 } from '../../composer/mutationPlan.js';
import { isPersonalTaskReferenceV1 } from '../../internalTasks/identity.js';
import { PersonalTaskOrderScopeSchema } from '../../internalTasks/listProjection.js';
import { TRIAGE_WORK_ITEMS_RUNTIME } from '../../workItems/runtime.js';
import { TriageTransitionTaskActionInputV1Schema, TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1 } from '../../actions/tasksProtocol.js';
import { sameTriageEntryReference } from '../../corpus/identity/components.js';
import { settleTriageTaskDropResult } from './taskDropOutcome.js';
import { triageEntryRowKey } from '../../projection/listWindow.js';

import { TRIAGE_ENTRY_DRAG_SOURCE_ID_V1, TRIAGE_ENTRY_SESSION_DROP_TARGET_ID_V1,
  TRIAGE_PERSONAL_TASK_ORDER_TARGET_ID_V1, TRIAGE_TASK_STATUS_DROP_TARGET_ID_V1, TriageEntryDragReferenceV1Schema } from './entryDragDropProtocol.js';
export { TRIAGE_ENTRY_DRAG_SOURCE_ID_V1, TRIAGE_ENTRY_SESSION_DROP_TARGET_ID_V1,
  TRIAGE_PERSONAL_TASK_ORDER_TARGET_ID_V1, TRIAGE_TASK_STATUS_DROP_TARGET_ID_V1, TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1,
  TriageEntryDragReferenceV1Schema } from './entryDragDropProtocol.js';

const text = defineProtocolString({ minLength: 1 });
const closed = { policy: 'closed' } as const;

/** The destination's live row and already-localized release promise. */
export const TriageEntrySessionDropInputV1Schema = defineProtocolObject({
  entryRef: TriageEntryRefV1Schema,
  display: TriageEntrySessionLinkDisplayV1Schema,
  preview: defineProtocolObject({ verb: text, target: text, consequence: text }, closed),
}, closed);

/** Only the visible source's offered, field-free native transitions are column destinations. */
const TaskStatusDropMetadata = defineProtocolObject({
  preview: defineProtocolObject({ verb: text, target: text }, closed),
  unavailableReason: text,
}, closed);

/** A row keeps same-group ordering and consumes its Collection column's status destination. */
const PersonalTaskOrderInput = defineProtocolObject({
  scope: PersonalTaskOrderScopeSchema.optional(),
  targetId: text,
  orderedIds: defineProtocolArray(text),
  preview: defineProtocolObject({ before: text, after: text, target: text }, closed),
  unavailableReason: text,
}, closed);

export const triageTaskStatusDropTargetRuntime: PluginDropTargetRuntime = {
  settle: settleTriageTaskDropResult,
  resolve({ item, targetInput }) {
    const targetRecord = targetInput !== null && typeof targetInput === 'object' && !Array.isArray(targetInput) ? targetInput : null;
    const target = TaskStatusDropMetadata.safeParse({ preview: targetRecord?.preview, unavailableReason: targetRecord?.unavailableReason });
    const reference = item.kind === 'plugin' && item.contribution.pluginId === TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1
      && item.contribution.localId === TRIAGE_ENTRY_DRAG_SOURCE_ID_V1
      ? TriageEntryDragReferenceV1Schema.safeParse(item.reference) : null;
    if (!target.success || !reference?.success) return { status: 'refused', reason: {
      code: 'triage_task_status_unavailable', message: 'This task cannot change status here. Use its status menu.',
    } };
    // Indexing is the group producer's job; a pointer frame validates only this dragged entry's Action input.
    const candidates = targetRecord?.candidatesByEntry;
    const candidate = TriageTransitionTaskActionInputV1Schema.safeParse(candidates !== null && typeof candidates === 'object' && !Array.isArray(candidates)
      ? candidates[triageEntryRowKey(reference.data.entryRef)] : undefined);
    if (!candidate.success || candidate.data.sourceInstanceId !== reference.data.sourceInstance.sourceInstanceId
      || !sameTriageEntryReference(candidate.data.entryRef, reference.data.entryRef)) return { status: 'refused', reason: {
      code: 'triage_task_status_unavailable', message: target.data.unavailableReason,
    } };
    return { status: 'allowed', effect: {
      actionId: `plugin:${TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1}/${TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1}`,
      input: candidate.data, preview: { ...target.data.preview, glyph: 'move' },
    } };
  },
};

export const triagePersonalTaskOrderTargetRuntime: PluginDropTargetRuntime = {
  settle: settleTriageTaskDropResult,
  resolve(context) {
    const { item, targetInput } = context;
    const target = PersonalTaskOrderInput.safeParse(targetInput);
    const reference = item.kind === 'plugin' && item.contribution.pluginId === TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1
      && item.contribution.localId === TRIAGE_ENTRY_DRAG_SOURCE_ID_V1
      ? TriageEntryDragReferenceV1Schema.safeParse(item.reference) : null;
    if (!target.success) return { status: 'refused', reason: { code: 'task_order_unavailable', message:
      targetInput !== null && typeof targetInput === 'object' && 'unavailableReason' in targetInput && typeof targetInput.unavailableReason === 'string'
        ? targetInput.unavailableReason : 'Task order is unavailable. Refresh and try again.' } };
    const refuse = () => ({ status: 'refused' as const, reason: { code: 'task_order_unavailable', message: target.data.unavailableReason } });
    const scope = target.data.scope;
    if (context.parentTargetInput != null && (!reference?.success || scope === undefined
      || !isPersonalTaskReferenceV1(reference.data.entryRef, scope.accountId)
      || !target.data.orderedIds.includes(reference.data.entryRef.entryId))) {
      return triageTaskStatusDropTargetRuntime.resolve({ ...context, targetInput: context.parentTargetInput });
    }
    if (!reference?.success || scope === undefined || item.scope.serverId !== scope.serverId || item.scope.accountId !== scope.accountId) return refuse();
    const entry = reference.data.entryRef;
    if (!isPersonalTaskReferenceV1(entry, scope.accountId)) return refuse();
    const sourceIndex = target.data.orderedIds.indexOf(entry.entryId);
    const targetIndex = target.data.orderedIds.indexOf(target.data.targetId);
    if (sourceIndex < 0 || targetIndex < 0) return refuse();
    if (sourceIndex === targetIndex) return { status: 'refused', reason: { code: 'same-position', message: target.data.unavailableReason } };
    const placement = sourceIndex < targetIndex ? 'after' : 'before';
    return { status: 'allowed', effect: {
      actionId: 'tasks.internal.reorder',
      input: { scope, sourceId: entry.entryId, position: { anchorId: target.data.targetId, placement } },
      preview: { verb: target.data.preview[placement], target: target.data.preview.target, glyph: placement === 'before' ? 'above' : 'below' },
    } };
  },
};

export const triageEntryDragSourceRuntime: PluginDragSourceRuntime = {
  toComposerAttachment(reference) {
    const parsed = TriageEntryDragReferenceV1Schema.safeParse(reference);
    if (!parsed.success) return null;
    return buildTriageEntryAttachmentDraftV1({
      entryRef: parsed.data.entryRef, sourceInstance: parsed.data.sourceInstance,
      lastKnownLocator: parsed.data.lastKnownLocator,
      presentation: { label: parsed.data.title, description: parsed.data.subtitle },
    })?.value ?? null;
  },
  describe(reference) {
    const parsed = TriageEntryDragReferenceV1Schema.safeParse(reference);
    if (!parsed.success) return null;
    // The existing attachment parser owns agreement of entry and configured source.
    const attachment = parseTriageComposerEntryAttachmentValue({
      v: 1, entryRef: parsed.data.entryRef, sourceInstance: parsed.data.sourceInstance,
      lastKnownLocator: parsed.data.lastKnownLocator,
    });
    return attachment.status === 'valid'
      ? { title: parsed.data.title, subtitle: parsed.data.subtitle }
      : null;
  },
};

export const triageEntrySessionDropTargetRuntime: PluginDropTargetRuntime = {
  settle(result) {
    const parsed = TriageLinkEntryToSessionActionResultV1Schema.safeParse(result);
    if (!parsed.success) return { status: 'unknown', reason: {
      code: 'triage_session_link_invalid_result', message: 'The link result could not be read. Check the linked Sessions before trying again.',
    } };
    // The writer's failed result includes a lost response as well as a refusal.
    return parsed.data.status === 'linked' ? { status: 'applied' } : { status: 'unknown', reason: {
      code: 'triage_session_link_failed', message: 'The Session link is not confirmed. Check the linked Sessions before trying again.',
    } };
  },
  resolve({ item, targetInput }) {
    const parsed = TriageEntrySessionDropInputV1Schema.safeParse(targetInput);
    if (!parsed.success || item.kind !== 'session') {
      return { status: 'refused', reason: { code: 'triage_entry_session_drop_invalid', message: 'This entry cannot link that item.' } };
    }
    const input = TriageLinkEntryToSessionInputV1Schema.safeParse({
      v: 1, sessionId: item.address.sessionId, entryRef: parsed.data.entryRef, display: parsed.data.display,
    });
    if (!input.success) return { status: 'refused', reason: { code: 'triage_entry_session_drop_invalid', message: 'This Session cannot be linked.' } };
    return {
      status: 'allowed',
      effect: {
        actionId: `plugin:${TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1}/${TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1}`,
        input: input.data,
        preview: { ...parsed.data.preview, glyph: 'add' },
      },
    };
  },
};

/** The ordinary client activation ABI; the mounted host owns effects and retirement. */
export function activate(api: PluginClientApi): void {
  api.workItems.register('work-items', TRIAGE_WORK_ITEMS_RUNTIME);
  api.dragSources.register(TRIAGE_ENTRY_DRAG_SOURCE_ID_V1, triageEntryDragSourceRuntime);
  api.dropTargets.register(TRIAGE_ENTRY_SESSION_DROP_TARGET_ID_V1, triageEntrySessionDropTargetRuntime);
  api.dropTargets.register(TRIAGE_PERSONAL_TASK_ORDER_TARGET_ID_V1, triagePersonalTaskOrderTargetRuntime);
  api.dropTargets.register(TRIAGE_TASK_STATUS_DROP_TARGET_ID_V1, triageTaskStatusDropTargetRuntime);
}
