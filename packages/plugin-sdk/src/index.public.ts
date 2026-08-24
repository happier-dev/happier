export { ComposerReferenceCandidateIdV1Schema } from './composerReferenceProviders.js';
export type { ComposerReferenceCandidatePageV1 } from './composerReferenceProviders.js';
export type { ComposerReferenceRuntime } from './activation.js';
export type { ComposerReferencesRegistrationApi } from './activation.js';
export type { ComposerAttachmentRuntime } from './activation.js';
export type { ComposerAttachmentsRegistrationApi } from './activation.js';
export type {
    ComposerContentHandleV1,
    ComposerContentInspectRequestV1,
    ComposerContentInspectResultV1,
    ComposerContentMediaKindV1,
    ComposerContentMimeTypeV1,
    ComposerContentPickMediaRequestV1,
    ComposerMediaContentCapabilityV1,
    ComposerSessionMediaContentV1,
    ComposerStagedMediaContentV1,
} from './composer.js';
export { COMPOSER_MEDIA_CONTENT_CAPABILITY_V1 } from './composer.js';
/** Exact attachment runtime callback payloads/results. */
export type {
    ComposerAttachmentMessageAcceptedV1,
    ComposerAttachmentPrepareOutcomeV1,
    ComposerAttachmentPrepareRequestV1,
    ComposerAttachmentPrepareResultV1,
    ComposerAttachmentResolveRequestV1,
    ComposerAttachmentResolveResultV1,
} from './activation.js';
export type { ComposerReferenceResolutionV1 } from './composerReferenceProviders.js';
export {
    defineComposerAttachment,
    defineComposerControl,
    defineComposerReference,
    defineComposerRegion,
} from './composer.js';
export { defineUiSurfaceDefinition } from './ui/surface.js';
export type {
    UiSurfaceAppPageDefinition,
    UiSurfaceAppPageDefinitionFor,
    UiSurfaceDeclarativeDefinition,
    UiSurfaceDeclarativeRendererDefinition,
    UiSurfaceDetailedDefinition,
    UiSurfaceDetailedDefinitionFor,
    UiSurfaceDefinition,
    UiSurfaceHostedWebBuild,
    UiSurfaceHostedWebDefinition,
    UiSurfaceHostedWebRendererDefinition,
    UiSurfacePlacement,
    UiSurfaceReactNativeBuild,
    UiSurfaceReactNativeDefinition,
    UiSurfaceReactNativeRendererDefinition,
    UiSurfaceRendererDefinition,
    UiSurfaceSettingsPageDefinition,
} from './ui/surface.js';
export type {
    ActionOperationDeclarationV1,
    ComposerAttachmentAuthorDeclaration,
    ComposerAttachmentAuthorDisplay,
    ComposerAttachmentAuthorPreview,
    ComposerControlAuthorInteraction,
    ComposerRendererChainAuthorInput,
    PluginComposerAttachmentDefinition,
    PluginComposerControlDefinition,
    PluginComposerDefinition,
    PluginComposerReferenceDefinition,
    PluginComposerRegionDefinition,
} from './definePlugin.js';
export type { DefinePluginInput } from './definePlugin.js';
export type {
    ProtocolActionSchemaInput,
    ProtocolActionSchemaOutput,
} from './definePlugin.js';
export type { UiSurface } from './ui/surface.js';
export type { DefinedPlugin } from './definePlugin.js';
export type { DefinedPluginActionContracts } from './definePlugin.js';
export type { DefinedPluginContributes } from './definePlugin.js';
export type { DefinedPluginManifest } from './definePlugin.js';
export type { Disposable } from './lifecycle.js';
export type { JsonValue } from './identity.js';
export type { LoggerService } from './services/core.js';
export type { MessageActionAvailableSnapshotV1 } from './invocation.js';
export type { PluginApi } from './activation.js';
export type { PluginClientActivationModule } from './activation.js';
export type { PluginClientApi } from './activation.js';
export type { PluginCancellationOptions } from './lifecycle.js';
export type { PluginCleanup } from './activation.js';
export type { PluginContributionLocalId } from './identity.js';
export type { PluginContributionRef } from './identity.js';
export type { PluginDaemonDatabaseDeclaration } from './definePlugin.js';
export type { PluginDaemonDatabaseDefinition } from './definePlugin.js';
export type { PluginDaemonDatabaseRuntimeProjection } from './definePlugin.js';
export type { PluginAccountCollectionMigrationRuntimeProjection } from './definePlugin.js';
export type { PluginRequestInterceptorDefinition } from './definePlugin.js';
export type { PluginDiagnosticData } from './diagnostics.js';
export { isPluginError, PluginError } from './errors.js';
export type { PluginErrorData } from './errors.js';
export type { PluginIdentity } from './identity.js';
export type { PluginInvocationCaller } from './invocation.js';
export type {
    PluginActionOperationContextV1,
    PluginActionOperationProgressUpdateV1,
    PluginInvocationContext,
} from './invocation.js';
export type { PluginInvocationContributionIdentity } from './identity.js';
export type { PluginInvocationOriginSurface } from './invocation.js';
export type { PluginJsonValueV2 } from './identity.js';
export { computeCanonicalDomainSeparatedDigest } from './identity.js';
export type { PluginMachineMaterializationRefV1 } from './invocation.js';
export type { PluginOperationAvailability } from './availability.js';
export type { PluginPath } from './services/io.js';
export type { PluginReference } from './identity.js';
export type { PluginRemediationData } from './availability.js';
export type { PluginServiceId } from './services/index.js';
export type { PluginServices } from './services/index.js';
export type {
    ComposerContentCapabilitiesV1,
    ComposerContentService,
    ComposerContentStageMediaRequestV1,
} from './services/composerContent.js';
export type {
    TargetedContributionAdmittedEntry,
    TargetedContributionObservation,
    TargetedContributionPointRef,
    TargetedContributionSelectionResult,
    TargetedContributionSelectionUnavailableReason,
    TargetedContributionSnapshot,
    TargetedContributionsService,
} from './services/targetedContributions.js';
export { selectCurrentTargetedContribution } from './services/targetedContributions.js';
export type { PluginSettingDescriptor } from './services/core.js';
export type { PluginSettingDescriptorBase } from './services/core.js';
export type { PluginSettingsChange } from './services/core.js';
export type { PluginSettingsMutationResult } from './services/core.js';
export type { PluginSettingsSnapshot } from './services/core.js';
export { arePluginMachineExecutionOriginsEqual } from './executionOrigin.js';
export { definePlugin } from './definePlugin.js';
export type {
    ContributionAdmittedEntry,
    ContributionOperationContracts,
    ContributionSurfaceHandles,
    DefinedContributionPointRef,
    DefinedContributionPoints,
} from './targetedContributionAuthoring.js';
export { isRecord } from './sessions/fileStores/records.js';
export { normalizePluginDaemonDatabaseRuntimeProjection } from './definePlugin.js';
export { normalizePluginAccountCollectionMigrationRuntimeProjection } from './definePlugin.js';
export { projectPluginAccountCollectionDeclaration } from './definePlugin.js';
export { parseJsonLine } from './sessions/fileStores/records.js';
export { parseTimestampMs } from './sessions/fileStores/records.js';
export { readString } from './sessions/fileStores/records.js';
export { readTrimmedString } from './sessions/fileStores/records.js';
export { redactBugReportSensitiveText } from './diagnostics.js';
export { trimBugReportTextToMaxBytes } from './diagnostics.js';
