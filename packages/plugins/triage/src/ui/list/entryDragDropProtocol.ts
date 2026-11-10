import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { TriageEntryLocatorV1Schema, TriageEntryRefV1Schema, TriageSourceInstanceRefV1Schema } from '@happier-dev/triage-protocol/v1';

export const TRIAGE_ENTRY_DRAG_SOURCE_ID_V1 = 'entry-reference';
export const TRIAGE_ENTRY_SESSION_DROP_TARGET_ID_V1 = 'entry-session';
export const TRIAGE_PERSONAL_TASK_ORDER_TARGET_ID_V1 = 'personal-task-order';
export const TRIAGE_TASK_STATUS_DROP_TARGET_ID_V1 = 'task-status';
export const TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1 = 'triage-entity-drag-drop-native';

const text = defineProtocolString({ minLength: 1 });

/** Manifest declarations do not import the executable client and its Account callbacks. */
export const TriageEntryDragReferenceV1Schema = defineProtocolObject({
  entryRef: TriageEntryRefV1Schema,
  sourceInstance: TriageSourceInstanceRefV1Schema,
  lastKnownLocator: TriageEntryLocatorV1Schema,
  title: text,
  subtitle: text,
}, { policy: 'closed' });
