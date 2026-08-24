export type { ActionOperationDeclarationV1 } from './definePlugin.js';
export type { DefinePluginInput } from './definePlugin.js';
export type { DefinedPlugin } from './definePlugin.js';
export type { DefinedPluginActionContracts } from './definePlugin.js';
export type { DefinedPluginContributes } from './definePlugin.js';
export type { DefinedPluginManifest } from './definePlugin.js';
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
export type {
    ProtocolActionSchemaInput,
    ProtocolActionSchemaOutput,
} from './definePlugin.js';
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
export type { PluginClientActivationModule } from './activation.js';
export type { PluginClientApi } from './activation.js';
export type { PluginRequestInterceptorDefinition } from './definePlugin.js';
export type { PluginDiagnosticData } from './diagnostics.js';
export type { PluginErrorData } from './errors.js';
export type { PluginOperationAvailability, PluginRemediationData } from './availability.js';
export { isPluginError, PluginError } from './errors.js';
export { computeCanonicalDomainSeparatedDigest } from './identity.js';
export { arePluginMachineExecutionOriginsEqual } from './executionOrigin.js';
export { definePlugin } from './definePlugin.js';
export {
    defineComposerAttachment,
    defineComposerControl,
    defineComposerReference,
    defineComposerRegion,
} from './composer.js';
export {
    COMPOSER_MEDIA_CONTENT_CAPABILITY_V1,
} from './composer.js';
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
export { defineUiSurfaceDefinition } from './ui/surface.js';
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
export type {
    ContributionAdmittedEntry,
    ContributionOperationContracts,
    ContributionSurfaceHandles,
    DefinedContributionPointRef,
    DefinedContributionPoints,
} from './targetedContributionAuthoring.js';
export { ComposerReferenceCandidateIdV1Schema } from './composerReferenceProviders.js';
export type {
    ComposerReferenceCandidatePageV1,
    ComposerReferenceResolutionV1,
} from './composerReferenceProviders.js';
export {
    normalizePluginAccountCollectionMigrationRuntimeProjection,
    projectPluginAccountCollectionDeclaration,
} from './definePlugin.js';
export { normalizePluginDaemonDatabaseRuntimeProjection } from './definePlugin.js';
export { selectCurrentTargetedContribution } from './services/targetedContributions.js';
export {
    isRecord,
    parseJsonLine,
    parseTimestampMs,
    readString,
    readTrimmedString,
} from './sessions/fileStores/records.js';
export {
    redactBugReportSensitiveText,
    trimBugReportTextToMaxBytes,
} from './diagnostics.js';
