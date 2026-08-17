// V1 is the only public Triage source-protocol epoch. There is no default,
// current, latest, legacy, or compatibility alias.
export * from './bounds.js';
export {
    TRIAGE_SOURCE_INSTANCE_ID_PATTERN_V1,
    TriageEntryLocatorV1JsonSchema,
    TriageEntryLocatorV1Schema,
    TriageEntryRefV1JsonSchema,
    TriageEntryRefV1Schema,
    TriageSourceEntryLocalRefV1JsonSchema,
    TriageSourceEntryLocalRefV1Schema,
    TriageSourceInstanceIdV1JsonSchema,
    TriageSourceInstanceIdV1Schema,
    TriageSourceInstanceRefV1JsonSchema,
    TriageSourceInstanceRefV1Schema,
    TriageSourceWorkflowSubjectV1JsonSchema,
    TriageSourceWorkflowSubjectV1Schema,
} from './identity.js';
export type {
    TriageEntryLocatorV1,
    TriageEntryRefV1,
    TriageSourceEntryLocalRefV1,
    TriageSourceInstanceIdV1,
    TriageSourceInstanceRefV1,
    TriageSourceWorkflowSubjectV1,
} from './identity.js';

export {
    normalizeTriageSingleLineV1,
    projectTriageDisplayTextV1,
    truncateTriageUtf8V1,
} from './text.js';
export type { TriageBoundedTextV1 } from './text.js';

export {
    TriageSourceFailureV1JsonSchema,
    TriageSourceFailureV1Schema,
} from './diagnostics.js';
export type { TriageSourceFailureV1 } from './diagnostics.js';

export {
    TriageSourceDescriptorV1JsonSchema,
    TriageSourceDescriptorV1Schema,
} from './descriptor.js';
export type { TriageSourceDescriptorV1 } from './descriptor.js';

export {
    TriageConfiguredSourceInstanceV1JsonSchema,
    TriageConfiguredSourceInstanceV1Schema,
    TriageListInstancesInputV1JsonSchema,
    TriageListInstancesInputV1Schema,
    TriageListInstancesResultV1JsonSchema,
    TriageListInstancesResultV1Schema,
    TriageSourceAccountBindingV1JsonSchema,
    TriageSourceAccountBindingV1Schema,
    TriageSourceInstanceConfigurationV1JsonSchema,
    TriageSourceInstanceConfigurationV1Schema,
    TriageSourceInstanceDraftV1JsonSchema,
    TriageSourceInstanceDraftV1Schema,
    TriageSourceInstanceLocatorV1JsonSchema,
    TriageSourceInstanceLocatorV1Schema,
} from './instances.js';
export type {
    TriageConfiguredSourceInstanceV1,
    TriageListInstancesInputV1,
    TriageListInstancesResultV1,
    TriageSourceAccountBindingV1,
    TriageSourceInstanceConfigurationV1,
    TriageSourceInstanceDraftV1,
    TriageSourceInstanceLocatorV1,
} from './instances.js';

export {
    TRIAGE_SOURCES_ADMINISTER_ACTION_ID_V1,
    TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
    TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1,
    TriageSourceAdministrationActionInputV1JsonSchema,
    TriageSourceAdministrationActionInputV1Schema,
    TriageSourceAdministrationActionResultV1JsonSchema,
    TriageSourceAdministrationActionResultV1Schema,
} from './sourceAdministration.js';
export type {
    TriageSourceAdministrationActionInputV1,
    TriageSourceAdministrationActionResultV1,
} from './sourceAdministration.js';

export {
    TRIAGE_SOURCES_READ_CONFIGURED_ACTION_ID_V1,
    TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1,
    TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
    TriageConfiguredSourceInstanceRecordV1JsonSchema,
    TriageConfiguredSourceInstanceRecordV1Schema,
    TriageReadConfiguredSourceInstancesInputV1JsonSchema,
    TriageReadConfiguredSourceInstancesInputV1Schema,
    TriageReadConfiguredSourceInstancesResultV1JsonSchema,
    TriageReadConfiguredSourceInstancesResultV1Schema,
} from './configuredInstances.js';
export type {
    TriageConfiguredSourceInstanceRecordV1,
    TriageReadConfiguredSourceInstancesInputV1,
    TriageReadConfiguredSourceInstancesResultV1,
} from './configuredInstances.js';

export {
    TriageRowFactV1JsonSchema,
    TriageRowFactV1Schema,
    TriageRowFactValueV1JsonSchema,
    TriageRowFactValueV1Schema,
    TriageScanContinuationV1JsonSchema,
    TriageScanContinuationV1Schema,
    TriageSourceEntrySnapshotV1JsonSchema,
    TriageSourceEntrySnapshotV1Schema,
    TriageSourceObservationV1JsonSchema,
    TriageSourceObservationV1Schema,
    TriageSourceScanEvidenceV1JsonSchema,
    TriageSourceScanEvidenceV1Schema,
    TriageSourceScanObservationV1JsonSchema,
    TriageSourceScanObservationV1Schema,
    TriageSourceViewerFactsV1JsonSchema,
    TriageSourceViewerFactsV1Schema,
} from './observations.js';
export type {
    TriageRowFactV1,
    TriageRowFactValueV1,
    TriageScanContinuationV1,
    TriageSourceEntrySnapshotV1,
    TriageSourceObservationV1,
    TriageSourceScanEvidenceV1,
    TriageSourceScanObservationV1,
    TriageSourceViewerFactsV1,
} from './observations.js';

export {
    TriageGetInputV1JsonSchema,
    TriageGetInputV1Schema,
    TriageGetResultV1JsonSchema,
    TriageGetResultV1Schema,
    TriageScanInputV1JsonSchema,
    TriageScanInputV1Schema,
    TriageScanResultV1JsonSchema,
    TriageScanResultV1Schema,
} from './operations.js';
export type {
    TriageGetInputV1,
    TriageGetResultV1,
    TriageScanInputV1,
    TriageScanResultV1,
} from './operations.js';

export {
    TriagePrepareReviewWorkspaceInputV1JsonSchema,
    TriagePrepareReviewWorkspaceInputV1Schema,
    TriagePrepareReviewWorkspaceResultV1JsonSchema,
    TriagePrepareReviewWorkspaceResultV1Schema,
    TriageReviewWorkspaceCurrentnessV1JsonSchema,
    TriageReviewWorkspaceCurrentnessV1Schema,
    TriageReviewWorkspaceObservedRevisionV1JsonSchema,
    TriageReviewWorkspaceObservedRevisionV1Schema,
    TriageSelectedWorkspaceScopeV1JsonSchema,
    TriageSelectedWorkspaceScopeV1Schema,
} from './workspace.js';
export type {
    TriagePrepareReviewWorkspaceInputV1,
    TriagePrepareReviewWorkspaceResultV1,
    TriageReviewWorkspaceCurrentnessV1,
    TriageReviewWorkspaceObservedRevisionV1,
    TriageSelectedWorkspaceScopeV1,
} from './workspace.js';

export {
    TriageDetailSurfaceInputV1JsonSchema,
    TriageDetailSurfaceInputV1Schema,
    TriageLinkedSessionProjectionV1JsonSchema,
    TriageLinkedSessionProjectionV1Schema,
} from './detail.js';
export type {
    TriageDetailSurfaceInputV1,
    TriageLinkedSessionProjectionV1,
} from './detail.js';

export {
    TriageSourcesContributionPointV1,
    TriageSourcesContributionProtocolV1,
} from './contribution.js';
