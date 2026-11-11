import { TriageListSortV1Schema } from '@happier-dev/triage-protocol/v1';
import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import { TriageActionEditorLaunchInputV1Schema, TriageEntryRefV1Schema } from '@happier-dev/triage-protocol/v1';
import { TriageSourcePanelSelectionV1Schema, TriageSourcePanelRevealV1Schema, TriageSourcePanelInsertV1Schema } from '@happier-dev/triage-sources/runtime';
import { TriageSurfaceFilterSelectionV1Schema, TriageListSettledQueryV1Schema, TriageSmartPolicyV1Schema, TriageListOrderV1Schema } from './listEntriesProtocol.js';
import { TriageSavedViewPresentationV1Schema } from './savedViewsProtocol.js';

export const TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1 = 'ui/mounted-v1';
const identifier = defineProtocolString({ minLength: 1 });
const closed = { policy: 'closed' } as const;
export const TriageMountedUiOperationV1Schema = defineProtocolUnion([
  TriageSourcePanelSelectionV1Schema,
  defineProtocolObject({ kind: defineProtocolLiteral('setSourceManagementOpen'), open: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]) }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('setSourceDiagnosticExpanded'), sourceInstanceId: identifier,
    expanded: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]) }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('setOrganizing'), organizing: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]) }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('openActionEditor'), launch: TriageActionEditorLaunchInputV1Schema }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('closeActionEditor') }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('setAddSourceOpen'), open: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]) }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('configureSource'), sourceId: identifier }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('selectBulkAction'), actionId: identifier }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('focusRow'), entryRef: TriageEntryRefV1Schema }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('peekRow'), entryRef: TriageEntryRefV1Schema,
    expanded: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]).optional() }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('openDetail'), entryRef: TriageEntryRefV1Schema, tab: identifier.optional() }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('closeDetail') }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('attachEntry'), entryRef: TriageEntryRefV1Schema }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('removeEntry'), entryRef: TriageEntryRefV1Schema }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('setPickerQuery'), query: defineProtocolString() }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('selectDetailTab'), tab: identifier }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('selectLinkedSession'), sessionId: identifier }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('switchView'), view: TriageSavedViewPresentationV1Schema }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('setGroupExpanded'), group: defineProtocolLiteral('completed'),
    expanded: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]) }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('setLens'), query: TriageListSettledQueryV1Schema, filters: TriageSurfaceFilterSelectionV1Schema,
    order: TriageListOrderV1Schema, sort: TriageListSortV1Schema.optional(),
    smartPolicy: TriageSmartPolicyV1Schema.optional() }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('selectSavedView'), viewId: identifier.nullable() }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('setSelection'), entryRefs: defineProtocolArray(TriageEntryRefV1Schema) }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('retryRun') }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('retryAccountData') }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('retrySessionActivity') }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('retryFixPullRequests') }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('cancelRun') }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('refresh') }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('loadMore'), section: defineProtocolUnion([defineProtocolLiteral('entries'), defineProtocolLiteral('pins'), defineProtocolLiteral('linkedSessions')]) }, closed),
]);
export type TriageMountedUiOperationV1 = ReturnType<typeof TriageMountedUiOperationV1Schema.parse>;
export const TriageMountedUiInputV1Schema = defineProtocolObject({ mountId: identifier, operation: TriageMountedUiOperationV1Schema }, closed);
export type TriageMountedUiInputV1 = ReturnType<typeof TriageMountedUiInputV1Schema.parse>;
export const TriageMountedSourceRevealInputV1Schema = defineProtocolObject({ mountId: identifier, operation: TriageSourcePanelRevealV1Schema }, closed);
export const TriageMountedSourceInsertInputV1Schema = defineProtocolObject({ mountId: identifier, operation: TriageSourcePanelInsertV1Schema }, closed);
export const TriageMountedUiResultV1Schema = defineProtocolObject({ status: defineProtocolUnion([
  defineProtocolLiteral('applied'), defineProtocolLiteral('unavailable'), defineProtocolLiteral('rejected'),
]) }, closed);
export type TriageMountedUiResultV1 = ReturnType<typeof TriageMountedUiResultV1Schema.parse>;
