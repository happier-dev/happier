import { triageListSourceSchemasV1 } from './listSourceSchemaInstances.js';
export type { TriageEntryRepositoryRefV1 } from './listSourceSchemas.js';

export const {
    TriageRowFactValueV1Schema,
    TriageRowFactV1Schema,
    TriageEntryStateV1ProtocolSchema,
    TriageTaskFieldV1Schema,
    TriageTaskTransitionRequiredFieldV1Schema,
    TriageTaskTransitionV1Schema,
    TriageTaskCapabilitiesV1Schema,
    TriageEntryRelationsV1Schema,
    TriageSourceEntrySnapshotV1Schema,
    TriageSourceViewerFactsV1Schema,
    TriageEntryRepositoryRefV1Schema,
    TriageSourcePresentObservationV1Fields,
    TriageSourcePresentObservationV1ProtocolSchema,
    TriageSourceMergedObservationV1ProtocolSchema,
    TriageSourceUnresolvedObservationV1ProtocolSchema,
    TriageSourceAbsentObservationV1ProtocolSchema,
    TriageSourceObservationV1Schema,
    TriageSourceScanObservationV1Schema,
    TriageScanContinuationV1Schema,
    TriageSourceScanEvidenceV1Schema,
    TriageScanObservationsV1ProtocolSchema,
} = triageListSourceSchemasV1;

export type TriageRowFactValueV1 = ReturnType<typeof TriageRowFactValueV1Schema.parse>;

export type TriageRowFactV1 = ReturnType<typeof TriageRowFactV1Schema.parse>;

export type TriageEntryStateV1 = ReturnType<typeof TriageSourceEntrySnapshotV1Schema.parse>['state'];

export type TriageTaskFieldV1 = ReturnType<typeof TriageTaskFieldV1Schema.parse>;

export type TriageTaskTransitionRequiredFieldV1 = ReturnType<typeof TriageTaskTransitionRequiredFieldV1Schema.parse>;

export type TriageTaskCapabilitiesV1 = ReturnType<typeof TriageTaskCapabilitiesV1Schema.parse>;

export type TriageEntryRelationsV1 = ReturnType<typeof TriageEntryRelationsV1Schema.parse>;

export type TriageSourceEntrySnapshotV1 = ReturnType<
    typeof TriageSourceEntrySnapshotV1Schema.parse
>;

export type TriageSourceViewerFactsV1 = ReturnType<
    typeof TriageSourceViewerFactsV1Schema.parse
>;

export type TriageSourceObservationV1 = ReturnType<typeof TriageSourceObservationV1Schema.parse>;

export type TriageSourceScanObservationV1 = ReturnType<
    typeof TriageSourceScanObservationV1Schema.parse
>;

export type TriageScanContinuationV1 = ReturnType<typeof TriageScanContinuationV1Schema.parse>;

export type TriageSourceScanEvidenceV1 = ReturnType<
    typeof TriageSourceScanEvidenceV1Schema.parse
>;

export function triageTaskStatusCategoryV1(state: TriageEntryStateV1): 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled' | null {
    if (state.presentation === 'active') return state.stage ?? 'unstarted';
    if (state.presentation === 'resolved' || state.presentation === 'closed') return state.completionReason ?? 'completed';
    return null;
}
