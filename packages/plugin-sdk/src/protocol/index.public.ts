/**
 * Browser-safe validator-neutral data-only protocol/schema algebra, plus the
 * host-owned protocol values a feature protocol embeds in its own declarations.
 * Cross-plugin contribution authoring lives on the sibling `/contributions`
 * entrypoint so the two public owners remain disjoint.
 */
export type {
    EnvVarRequirement,
    EnvVarRequirementInput,
} from './environmentVariables.js';
export type {
    PluginJsonSchema,
    ProtocolArrayOptions,
    ProtocolComposableSchema,
    ProtocolJsonValue,
    ProtocolJsonValueOptions,
    ProtocolNumberOptions,
    ProtocolObjectEvolutionPolicy,
    ProtocolObjectOptions,
    ProtocolObjectProjection,
    ProtocolSchemaInput,
    ProtocolSchemaOutput,
    ProtocolSchemaSafeParseResult,
    ProtocolStringOptions,
    ProtocolStoredReadSchema,
    ProtocolUniqueJsonArrayOptions,
    ProtocolUtf8StringOptions,
    ProtocolValidationIssue,
} from './protocolFacade.js';
export {
    createProtocolStoredReadSchema,
    defineProtocolArray,
    defineProtocolJsonValue,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    embedProtocolJsonSchema,
    defineProtocolString,
    defineProtocolUnion,
    defineProtocolUniqueArray,
    defineProtocolUtf8String,
    pluginJsonValuesEqual,
    ProtocolValidationError,
} from './protocolFacade.js';
/**
 * The composable projection of one exact Composer scope. `/ui` publishes the
 * same canonical value as `ComposerRefV1Schema`, declaration-only, for reading
 * Host API payloads; this one is composable, for declaring protocol objects.
 */
export type { ProtocolComposerRefV1 } from './composerRef.js';
export { ProtocolComposerRefV1Schema } from './composerRef.js';
export { CURRENT_UI_CONTEXT_ATTACHMENT_IDENTITY_V1, ProtocolCurrentUiContextSnapshotV1Schema } from './currentUiContext.js';
export { TRANSCRIPT_ANNOTATION_ATTACHMENT_IDENTITY_V1, ProtocolTranscriptAnnotationV1Schema, buildTranscriptAnnotationPresentationV1 } from './transcriptAnnotation.js';
export type { TranscriptAnnotationV1 } from './transcriptAnnotation.js';
/** Canonical Discussion content projection for human reads and previews. */
export { readDiscussionMessagePartsV1, resolveAccountDisplayLabelV1 } from './discussionContent.js';
export type { DiscussionMessageContentV1, DiscussionMessagePartV1 } from './discussionContent.js';
/**
 * The canonical executable parser for a complete Composer reference
 * resolution, including Protocol's whole-value 16KiB boundary.
 */
export { ProtocolComposerReferenceResolutionV1Schema } from './composerReferenceResolution.js';
export { ProtocolComposerAttachmentAuthorValueV1Schema } from './composerAttachment.js';
/**
 * The composable projection of the Account Data Collection's opaque
 * continuation cursor, for feature protocols declaring their own Action wire
 * shapes. It is the one canonical Protocol value; the 4096-character base64url
 * grammar is owned and bounded by the Protocol parser alone.
 */
export type { ProtocolCollectionOpaqueCursorV1 } from './collectionCursor.js';
export { ProtocolCollectionOpaqueCursorV1Schema } from './collectionCursor.js';
/** Canonical Launch Profile V2 identity admission for feature Action references. */
export { ProtocolLaunchProfileIdV2Schema } from './launchProfileId.js';
export { ProtocolLaunchProfilePlacementPreferenceV1Schema, ProtocolLaunchProfileCheckoutPreferenceV1Schema, resolveLaunchProfilePlacementDirectoryIntentV1, type LaunchProfilePlacementPreferenceV1, type LaunchProfileCheckoutPreferenceV1, type SessionDirectoryIntentV1 } from './launchProfilePreferences.js';
/** Canonical policy deferral for feature protocols forwarding host Action results. */
export { ProtocolActionApprovalRequestCreatedResultSchema } from './actionApproval.js';
/** Declared environment requirements contain names and policy, never secret values. */
export { ProtocolEnvVarRequirementV1Schema } from './environmentVariables.js';
/** Project admission and preference values remain owned by the host's existing Actions. */
export {
    ProtocolWorkspaceAddressV1Schema,
    ProtocolSecretReferenceOverlayV1Schema,
    ProtocolWorkspaceExecutionConfigAddressV1Schema,
    ProtocolWorkspaceWorkerPreferenceSetInputV1Schema,
    ProtocolWorkspaceWorkerPreferenceReadResultV1Schema,
    ProtocolWorkspaceWorkerPreferenceMutationResultV1Schema,
    ProtocolProjectDefinitionInspectOutputSchema,
    ProtocolProjectComputeExecResultV1Schema,
} from './projectExecution.js';
/** Receiver destinations and transfer outcomes retain the filesystem Action's authority. */
export type { FileDownloadDestinationV1, FileDownloadResultV1 } from './fileDownload.js';
export { FileDownloadDestinationV1ProtocolSchema, FileDownloadResultV1ProtocolSchema } from './fileDownload.js';
/** SCM owns the types on `/scm`; these are its composable schema projections. */
export { ScmHostingRepositoryIdentityV1ProtocolSchema } from './hostingRepositoryIdentity.js';
export { ScmPullRequestSummaryProtocolSchema } from './scmPullRequest.js';
export { PluginUiResourceIntentV1Schema, type PluginUiResourceIntentV1 } from './resourceIntent.js';
export { ProjectExecutionOperationRefV1ProtocolSchema } from './projectExecution.js';
export { ActionOperationGetV1ResponseProtocolSchema } from './projectExecution.js';
export { PluginUiActionOperationHostReadResultV1ProtocolSchema } from './projectExecution.js';
export type { PluginUiActionOperationHostReadResultV1 } from './projectExecution.js';
export type { ActionOperationGetV1Response, ProjectSetupConsentRequiredV1 } from './projectExecution.js';
/** Portable byte encoding; Protocol remains the single implementation owner. */
export { encodeBase64, decodeBase64 } from './encoding.js';
export { projectNativeJsonValueForTransport } from './strictJsonValue.js';
/** Fresh exact Artifact reads for feature handoffs; stored operands are not grants. */
export { ProtocolArtifactGetOutputV1Schema } from './artifact.js';
export {
    ProtocolDeploymentPreviewProvenanceV1Schema,
    ProtocolDeploymentSourceIntentV1Schema,
    ProtocolDeploymentReceiptOperationV1Schema,
    readDeploymentArtifactJsonBodyV1,
    readDeploymentReceiptArtifactV1,
    readDeploymentTargetLinkArtifactV1,
    readDeploymentDomainServingUrlV1,
    DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
    DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1,
} from './deployment.js';
export type {
    DeploymentPreviewProvenanceV1,
    DeploymentSourceIntentV1,
    DeploymentArtifactContentReferenceV1,
    DeploymentArtifactReadFailureV1,
    OpenedDeploymentArtifactV1,
} from './deployment.js';
export type { ProtocolNoticeArtifactV1, ProtocolOwnedNoticeV1 } from './accountNotice.js';
export { readOwnedNoticeArtifactV1 } from './accountNotice.js';
export { ProtocolServiceHealthNoticeSourceV1Schema, ProtocolServiceHealthNoticePageV1Schema } from './accountNotice.js';
export { ProtocolServiceHealthNoticeMachineV1Schema, ProtocolDeploymentEnvironmentGetResultV1Schema } from './accountNotice.js';
export type { ServiceHealthNoticeSourceV1, ServiceHealthNoticePageV1, ServiceHealthNoticeMachineV1 } from './accountNotice.js';
export { ProtocolLocalServiceLauncherSnapshotV1Schema } from './localServices.js';
/** Minimal Task/entry identity and the single V1 identity/string grammar owner. */
export type { TriageEntryRefV1, TriageSourceInstanceIdV1 } from './triageEntryRef.js';
export {
    INTERNAL_TASK_SOURCE_V1,
    internalTaskLocalRefV1,
    internalTaskOwnerAccountIdV1,
    isInternalTaskReferenceV1,
    TriageSourceInstanceIdV1Schema,
    TRIAGE_SOURCE_INSTANCE_ID_PATTERN_V1,
    TriageEntryRefV1Fields,
    TriageEntryRefV1Schema,
    TriageEntryRefV1JsonSchema,
    TriageIdentifierV1ProtocolSchema,
    TriageCollisionScopeV1ProtocolSchema,
    defineTriageSingleLineStringV1,
    defineTriageCompositeIdentifierStringV1,
    MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
    MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1,
    TRIAGE_SINGLE_LINE_STRING_PATTERN_V1,
    TRIAGE_COMPOSITE_IDENTIFIER_PATTERN_V1,
} from './triageEntryRef.js';

/** Deployment target choice readers embed the same preparation custody schema. */
export { DeploymentTargetPreparationBaseV1ProtocolSchema } from '../deploymentTargets.js';
