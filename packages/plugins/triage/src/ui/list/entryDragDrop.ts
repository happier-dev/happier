import type { PluginClientApi, PluginDragSourceRuntime, PluginDropTargetRuntime } from '@happier-dev/plugin-sdk';
import { defineProtocolArray, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import {
  TriageEntryRefV1Schema,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
} from '@happier-dev/triage-protocol/v1';

import {
  TriageEntrySessionLinkDisplayV1Schema,
  TriageLinkEntryToSessionInputV1Schema,
  TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1,
} from '../../actions/sessionLinksProtocol.js';
import { parseTriageComposerEntryAttachmentValue } from '../../composer/attachmentValue.js';
import { buildTriageEntryAttachmentDraftV1 } from '../../composer/mutationPlan.js';
import { isPersonalTaskReferenceV1 } from '../../internalTasks/identity.js';
import { PersonalTaskOrderScopeSchema } from '../../internalTasks/listProjection.js';
import { TRIAGE_WORK_ITEMS_RUNTIME } from '../../workItems/runtime.js';

import { TRIAGE_ENTRY_DRAG_SOURCE_ID_V1, TRIAGE_ENTRY_SESSION_DROP_TARGET_ID_V1,
  TRIAGE_PERSONAL_TASK_ORDER_TARGET_ID_V1, TriageEntryDragReferenceV1Schema } from './entryDragDropProtocol.js';
export { TRIAGE_ENTRY_DRAG_SOURCE_ID_V1, TRIAGE_ENTRY_SESSION_DROP_TARGET_ID_V1,
  TRIAGE_PERSONAL_TASK_ORDER_TARGET_ID_V1, TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1,
  TriageEntryDragReferenceV1Schema } from './entryDragDropProtocol.js';

const text = defineProtocolString({ minLength: 1 });
const closed = { policy: 'closed' } as const;

/** The destination's live row and already-localized release promise. */
export const TriageEntrySessionDropInputV1Schema = defineProtocolObject({
  entryRef: TriageEntryRefV1Schema,
  display: TriageEntrySessionLinkDisplayV1Schema,
  preview: defineProtocolObject({ verb: text, target: text, consequence: text }, closed),
}, closed);

/** The current visible group's personal task anchors; never an order writer. */
const PersonalTaskOrderInput = defineProtocolObject({
  scope: PersonalTaskOrderScopeSchema,
  targetId: text,
  orderedIds: defineProtocolArray(text),
  preview: defineProtocolObject({ before: text, after: text, target: text }, closed),
  unavailableReason: text,
}, closed);

export const triagePersonalTaskOrderTargetRuntime: PluginDropTargetRuntime = {
  resolve({ item, targetInput }) {
    const target = PersonalTaskOrderInput.safeParse(targetInput);
    const reference = item.kind === 'plugin' && item.contribution.pluginId === TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1
      && item.contribution.localId === TRIAGE_ENTRY_DRAG_SOURCE_ID_V1
      ? TriageEntryDragReferenceV1Schema.safeParse(item.reference) : null;
    if (!target.success) return { status: 'refused', reason: { code: 'task_order_unavailable', message:
      targetInput !== null && typeof targetInput === 'object' && 'unavailableReason' in targetInput && typeof targetInput.unavailableReason === 'string'
        ? targetInput.unavailableReason : 'Task order is unavailable. Refresh and try again.' } };
    const refuse = () => ({ status: 'refused' as const, reason: { code: 'task_order_unavailable', message: target.data.unavailableReason } });
    if (!reference?.success || item.scope.serverId !== target.data.scope.serverId || item.scope.accountId !== target.data.scope.accountId) return refuse();
    const entry = reference.data.entryRef;
    if (!isPersonalTaskReferenceV1(entry, target.data.scope.accountId)) return refuse();
    const sourceIndex = target.data.orderedIds.indexOf(entry.entryId);
    const targetIndex = target.data.orderedIds.indexOf(target.data.targetId);
    if (sourceIndex < 0 || targetIndex < 0) return refuse();
    if (sourceIndex === targetIndex) return { status: 'refused', reason: { code: 'same-position', message: target.data.unavailableReason } };
    const placement = sourceIndex < targetIndex ? 'after' : 'before';
    return { status: 'allowed', effect: {
      actionId: 'tasks.internal.reorder',
      input: { scope: target.data.scope, sourceId: entry.entryId, position: { anchorId: target.data.targetId, placement } },
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
}
