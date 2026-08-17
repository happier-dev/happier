/** @experimental */
export type { DefinePluginInput } from './definePlugin.js';
/** @experimental */
export type { DefinedPlugin } from './definePlugin.js';
/** @experimental */
export type { DefinedPluginActionContracts } from './definePlugin.js';
/** @experimental */
export type { DefinedPluginManifest } from './definePlugin.js';
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
export type {
    PluginAccountCollectionMigrationRuntimeProjection,
    PluginDaemonDatabaseDeclaration,
    PluginDaemonDatabaseDefinition,
    PluginDaemonDatabaseRuntimeProjection,
} from './definePlugin.js';
export type { Disposable, PluginCancellationOptions } from './lifecycle.js';
export type {
    JsonValue,
    PluginContributionLocalId,
    PluginContributionRef,
    PluginIdentity,
    PluginInvocationContributionIdentity,
    PluginJsonValueV2,
    PluginReference,
} from './identity.js';
export type { PluginActivationModule } from './activation.js';
export type { PluginRequestInterceptorDefinition } from './definePlugin.js';
export type { PluginDiagnosticData } from './diagnostics.js';
export type { PluginErrorData } from './errors.js';
export type { PluginOperationAvailability, PluginRemediationData } from './availability.js';
export { PluginError } from './errors.js';
/** @experimental */
export { computeCanonicalDomainSeparatedDigest } from './identity.js';
/** @experimental */
export { arePluginMachineExecutionOriginsEqual } from './executionOrigin.js';
export { definePlugin } from './definePlugin.js';
/** @experimental */
export {
    defineComposerAttachment,
    defineComposerControl,
    defineComposerReference,
    defineComposerRegion,
} from './composer.js';
/** @experimental */
export {
    COMPOSER_MEDIA_CONTENT_CAPABILITY_V1,
} from './composer.js';
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
export { defineUiSurface } from './ui/surface.js';
/** @experimental */
export type {
    UiSurface,
    UiSurfaceAppPageDefinition,
    UiSurfaceAppPageDefinitionFor,
    UiSurfaceDeclarativeDefinition,
    UiSurfaceDeclarativeRendererDefinition,
    UiSurfaceDefinition,
    UiSurfaceDetailedDefinition,
    UiSurfaceDetailedDefinitionFor,
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
    ContributionAdmittedEntry,
    ContributionOperationContracts,
    ContributionSurfaceHandles,
    DefinedContributionPointRef,
    DefinedContributionPoints,
} from './targetedContributionAuthoring.js';
/** @experimental */
export { ComposerReferenceCandidateIdV1Schema } from './composerReferenceProviders.js';
/** @experimental */
export type {
    ComposerReferenceCandidatePageV1,
    ComposerReferenceResolutionV1,
} from './composerReferenceProviders.js';
/** @experimental */
export {
    normalizePluginAccountCollectionMigrationRuntimeProjection,
    projectPluginAccountCollectionDeclaration,
} from './definePlugin.js';
/** @experimental */
export { normalizePluginDaemonDatabaseRuntimeProjection } from './definePlugin.js';
/** @experimental */
export { selectCurrentTargetedContribution } from './services/targetedContributions.js';
export {
    isRecord,
    parseJsonLine,
    parseTimestampMs,
    readString,
    readTrimmedString,
} from './sessions/fileStores/records.js';
/** @experimental */
export {
    redactBugReportSensitiveText,
    trimBugReportTextToMaxBytes,
} from './diagnostics.js';
