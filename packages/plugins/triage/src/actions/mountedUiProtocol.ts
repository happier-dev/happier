import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import { TriageEntryRefV1Schema } from '@happier-dev/triage-protocol/v1';
import { TriageSourcePanelSelectionV1Schema, TriageSourcePanelRevealV1Schema, TriageSourcePanelInsertV1Schema } from '@happier-dev/triage-sources/runtime';
import { TriageListFilterSelectionV1Schema, TriageListSettledQueryV1Schema } from './listEntriesProtocol.js';

export const TRIAGE_MOUNTED_UI_ACTION_LOCAL_ID_V1 = 'ui/mounted-v1';
const identifier = defineProtocolString({ minLength: 1 });
const closed = { policy: 'closed' } as const;
export const TriageMountedUiOperationV1Schema = defineProtocolUnion([
  TriageSourcePanelSelectionV1Schema,
  defineProtocolObject({ kind: defineProtocolLiteral('focusRow'), entryRef: TriageEntryRefV1Schema }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('peekRow'), entryRef: TriageEntryRefV1Schema,
    expanded: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]).optional() }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('openDetail'), entryRef: TriageEntryRefV1Schema, tab: identifier.optional() }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('closeDetail') }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('selectDetailTab'), tab: identifier }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('switchView'), view: defineProtocolUnion([defineProtocolLiteral('list'), defineProtocolLiteral('board')]) }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('setLens'), query: TriageListSettledQueryV1Schema, filters: TriageListFilterSelectionV1Schema,
    order: defineProtocolUnion([defineProtocolLiteral('newest'), defineProtocolLiteral('oldest'), defineProtocolLiteral('smart')]) }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('selectSavedView'), viewId: identifier.nullable() }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('setSelection'), entryRefs: defineProtocolArray(TriageEntryRefV1Schema) }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('retryRun') }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('cancelRun') }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('refresh') }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('loadMore'), section: defineProtocolUnion([defineProtocolLiteral('entries'), defineProtocolLiteral('pins')]) }, closed),
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
