/** @experimental */
/** @experimental */
export { ComposerReferenceCandidateIdV1Schema } from './composerReferenceProviders.js';
/** @experimental */
export type { ComposerReferenceCandidatePageV1 } from './composerReferenceProviders.js';
/** @experimental */
export type { ComposerReferenceRuntime } from './activation.js';
/** @experimental */
export type { ComposerReferencesRegistrationApi } from './activation.js';
/** @experimental */
export type { ComposerAttachmentRuntime } from './activation.js';
/** @experimental */
export type { ComposerAttachmentsRegistrationApi } from './activation.js';
/** @experimental */
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
/** @experimental */
export { COMPOSER_MEDIA_CONTENT_CAPABILITY_V1 } from './composer.js';
/** @experimental Exact attachment runtime callback payloads/results. */
export type {
    ComposerAttachmentMessageAcceptedV1,
    ComposerAttachmentPrepareOutcomeV1,
    ComposerAttachmentPrepareRequestV1,
    ComposerAttachmentPrepareResultV1,
    ComposerAttachmentResolveRequestV1,
    ComposerAttachmentResolveResultV1,
} from './activation.js';
/** @experimental */
export type { ComposerReferenceResolutionV1 } from './composerReferenceProviders.js';
/** @experimental */
export {
    defineComposerAttachment,
    defineComposerControl,
    defineComposerReference,
    defineComposerRegion,
} from './composer.js';
/** @experimental */
export { defineUiSurface } from './ui/surface.js';
/** @experimental */
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
/** @experimental */
export type {
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
/** @experimental */
export type { DefinePluginInput } from './definePlugin.js';
/** @experimental */
export type {
    ProtocolActionSchemaInput,
    ProtocolActionSchemaOutput,
} from './definePlugin.js';
/** @experimental */
export type { UiSurface } from './ui/surface.js';
/** @experimental */
export type { DefinedPlugin } from './definePlugin.js';
/** @experimental */
export type { DefinedPluginActionContracts } from './definePlugin.js';
/** @experimental */
export type { DefinedPluginManifest } from './definePlugin.js';
export type { Disposable } from './lifecycle.js';
export type { JsonValue } from './identity.js';
/** @experimental */
export type { LoggerService } from './services/core.js';
/** @experimental */
export type { MessageActionAvailableSnapshotV1 } from './invocation.js';
/** @experimental */
export type { PluginActivationModule } from './activation.js';
/** @experimental */
export type { PluginApi } from './activation.js';
/** @experimental */
export type { PluginCancellationOptions } from './lifecycle.js';
export type { PluginCleanup } from './activation.js';
/** @experimental */
export type { PluginContributionLocalId } from './identity.js';
/** @experimental */
export type { PluginContributionRef } from './identity.js';
/** @experimental */
export type { PluginDaemonDatabaseDeclaration } from './definePlugin.js';
/** @experimental */
export type { PluginDaemonDatabaseDefinition } from './definePlugin.js';
/** @experimental */
export type { PluginDaemonDatabaseRuntimeProjection } from './definePlugin.js';
/** @experimental */
export type { PluginAccountCollectionMigrationRuntimeProjection } from './definePlugin.js';
/** @experimental */
export type { PluginRequestInterceptorDefinition } from './definePlugin.js';
/** @experimental */
export type { PluginDiagnosticData } from './diagnostics.js';
/** @experimental */
export { PluginError } from './errors.js';
/** @experimental */
export type { PluginErrorData } from './errors.js';
/** @experimental */
export type { PluginIdentity } from './identity.js';
/** @experimental */
export type { PluginInvocationCaller } from './invocation.js';
/** @experimental */
export type { PluginInvocationContext } from './invocation.js';
/** @experimental */
export type { PluginInvocationContributionIdentity } from './identity.js';
/** @experimental */
export type { PluginInvocationOriginSurface } from './invocation.js';
export type { PluginJsonValueV2 } from './identity.js';
/** @experimental */
export { computeCanonicalDomainSeparatedDigest } from './identity.js';
/** @experimental */
export type { PluginMachineMaterializationRefV1 } from './invocation.js';
/** @experimental */
export type { PluginOperationAvailability } from './availability.js';
/** @experimental */
export type { PluginPath } from './services/io.js';
/** @experimental */
export type { PluginReference } from './identity.js';
/** @experimental */
export type { PluginRemediationData } from './availability.js';
export type { PluginServiceId } from './services/index.js';
/** @experimental */
export type { PluginServices } from './services/index.js';
/** @experimental */
export type {
    ComposerContentCapabilitiesV1,
    ComposerContentService,
    ComposerContentStageMediaRequestV1,
} from './services/composerContent.js';
/** @experimental */
export type {
    TargetedContributionAdmittedEntry,
    TargetedContributionObservation,
    TargetedContributionPointRef,
    TargetedContributionSelectionResult,
    TargetedContributionSelectionUnavailableReason,
    TargetedContributionSnapshot,
    TargetedContributionsService,
} from './services/targetedContributions.js';
/** @experimental */
export { selectCurrentTargetedContribution } from './services/targetedContributions.js';
/** @experimental */
export type { PluginSettingDescriptor } from './services/core.js';
/** @experimental */
export type { PluginSettingDescriptorBase } from './services/core.js';
/** @experimental */
export type { PluginSettingsChange } from './services/core.js';
/** @experimental */
export type { PluginSettingsMutationResult } from './services/core.js';
/** @experimental */
export type { PluginSettingsSnapshot } from './services/core.js';
/** @experimental */
export { arePluginMachineExecutionOriginsEqual } from './executionOrigin.js';
/** @experimental */
export { definePlugin } from './definePlugin.js';
/** @experimental */
export type {
    ContributionAdmittedEntry,
    ContributionOperationContracts,
    ContributionSurfaceHandles,
    DefinedContributionPointRef,
    DefinedContributionPoints,
} from './targetedContributionAuthoring.js';
export { isRecord } from './sessions/fileStores/records.js';
/** @experimental */
export { normalizePluginDaemonDatabaseRuntimeProjection } from './definePlugin.js';
/** @experimental */
export { normalizePluginAccountCollectionMigrationRuntimeProjection } from './definePlugin.js';
/** @experimental */
export { projectPluginAccountCollectionDeclaration } from './definePlugin.js';
/** @experimental */
export { parseJsonLine } from './sessions/fileStores/records.js';
export { parseTimestampMs } from './sessions/fileStores/records.js';
export { readString } from './sessions/fileStores/records.js';
export { readTrimmedString } from './sessions/fileStores/records.js';
/** @experimental */
export { redactBugReportSensitiveText } from './diagnostics.js';
/** @experimental */
export { trimBugReportTextToMaxBytes } from './diagnostics.js';
