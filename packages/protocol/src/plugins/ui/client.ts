export {
  PLUGIN_UI_HOST_API_COMPATIBLE_RANGE_V1,
  PLUGIN_UI_HOST_API_VERSION_V1,
  PLUGIN_UI_HOST_METHODS_V1,
  PLUGIN_UI_HOST_SUBSCRIPTION_METHODS_V1,
  PLUGIN_UI_HOST_TRANSPORT_OPERATIONS_V1,
  PluginUiHostApiRequestMethodV1Schema,
  PluginUiHostMethodV1Schema,
  PluginUiHostSubscriptionMethodV1Schema,
  type PluginUiHostMethodV1,
  type PluginUiHostApiRequestMethodV1,
  type PluginUiHostSubscriptionMethodV1,
  type PluginUiHostTransportOperationV1,
} from './hostApiDefinition.js';
export {
  PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
  PluginUiHostApiWireEnvelopeV1Schema,
  PluginUiHostApiWireIdentityV1Schema,
  type PluginUiHostApiWireEnvelopeV1,
  type PluginUiHostApiWireIdentityV1,
} from './hostApiWire.js';
/**
 * The browser-safe client validates arbitrary host-wire values with the same
 * bounded JSON schema used by Protocol's contribution and transport owners.
 */
export { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';
export type { PluginUiJsonValueV1 } from '../contributions/ui/json.js';
export {
  PluginUiDisposeHostResourceRequestV1Schema,
  PluginUiResourceSubscriptionEventV1Schema,
  type PluginUiDisposeHostResourceRequestV1,
  type PluginUiResourceSubscriptionEventV1,
} from './subscriptions.js';
/**
 * Composer values are decoded by a mounted guest at the negotiated Host API
 * boundary. They stay on this browser-safe entry for the same reason as
 * openable-content result schemas below: a guest must not import Protocol's
 * root barrel merely to validate host-produced JSON.
 */
export {
  MAX_COMPOSER_ATTACHMENT_DESCRIPTION_CODE_POINTS_V1,
  MAX_COMPOSER_ATTACHMENT_LABEL_CODE_POINTS_V1,
} from '../../runtime/input/composerAttachmentV1.js';
export {
  COMPOSER_MEDIA_CONTENT_CAPABILITY_V1,
  ComposerContentDisplayNameV1Schema,
  ComposerContentHandleV1Schema,
  ComposerContentInspectRequestV1Schema,
  ComposerContentInspectWireResultV1Schema,
  ComposerContentMediaKindV1Schema,
  ComposerContentMimeTypeV1Schema,
  ComposerContentPickMediaRequestV1Schema,
  ComposerMediaContentCapabilityV1Schema,
  ComposerSessionMediaContentV1Schema,
  ComposerStagedMediaContentV1Schema,
} from '../../runtime/input/composerContentV1.js';
export type {
  ComposerContentDisplayNameV1,
  ComposerContentHandleV1,
  ComposerContentInspectRequestV1,
  ComposerContentInspectWireResultV1,
  ComposerContentMediaKindV1,
  ComposerContentMimeTypeV1,
  ComposerMediaContentCapabilityV1,
  ComposerContentPickMediaRequestV1,
  ComposerSessionMediaContentV1,
  ComposerStagedMediaContentV1,
} from '../../runtime/input/composerContentV1.js';
export {
  ComposerDecorationResultV1Schema,
  ComposerDecorationSetV1Schema,
  ComposerFocusResultV1Schema,
  ComposerInputLockRequestV1Schema,
  ComposerOperationV1Schema,
  ComposerReadResultV1Schema,
  ComposerRefV1Schema,
  ComposerSurfaceInputV1Schema,
  ComposerSnapshotV1Schema,
  ComposerTransactionResultV1Schema,
  ComposerTransactionV1Schema,
} from './composer.js';
export type {
  ComposerDecorationResultV1,
  ComposerDecorationSetV1,
  ComposerFocusResultV1,
  ComposerInputLockRequestV1,
  ComposerOperationV1,
  ComposerReadResultV1,
  ComposerRefV1,
  ComposerSurfaceInputV1,
  ComposerSnapshotV1,
  ComposerTransactionResultV1,
  ComposerTransactionV1,
} from './composer.js';
/**
 * The UI client decodes these host-returned values at runtime. Keep their
 * schemas on this browser-safe Protocol entry rather than making a mounted
 * plugin UI import the root Protocol barrel.
 */
export {
  OpenableContentReadResultV1Schema,
  OpenableContentStatRequestV1Schema,
  OpenableContentStatResultV1Schema,
  type OpenableContentStatRequestV1,
} from '../openableContent.js';
export {
  PluginUiAcquireComposerInputLockRequestV1Schema,
  PluginUiActiveComposerResultV1Schema,
  PluginUiApplyComposerRequestV1Schema,
  PluginUiApplyComposerResultV1Schema,
  PluginUiExecuteActionRequestV1Schema,
  PluginUiFocusComposerRequestV1Schema,
  PluginUiFocusComposerResultV1Schema,
  PluginUiInspectComposerContentRequestV1Schema,
  PluginUiInspectComposerContentResultV1Schema,
  PluginUiJsonObjectV1Schema,
  PluginUiPickComposerMediaRequestV1Schema,
  PluginUiPickComposerMediaResultV1Schema,
  PluginUiReadComposerRequestV1Schema,
  PluginUiReadComposerResultV1Schema,
  PluginUiReleaseComposerContentRequestV1Schema,
  PluginUiReplacePageLocationRequestV1Schema,
  PluginUiReplacePageLocationResultV1Schema,
  PluginUiSelectActionInputHostActionV1Schema,
  PluginUiSelectActionInputHostRequestV1Schema,
  PluginUiSelectActionInputRequestV1Schema,
  PluginUiSelectActionInputResultV1Schema,
  PluginUiSelectActionInputServerStartDraftV1Schema,
  PluginUiSelectActionInputTargetedRequestV1Schema,
  PluginUiSelectActionInputTargetedSubmittedV1Schema,
  PluginUiLaunchInputV1Schema,
  PluginUiSetComposerDecorationsRequestV1Schema,
  PluginUiSetComposerDecorationsResultV1Schema,
  PluginUiSubPathV1Schema,
  PluginUiWatchComposerEventV1Schema,
  PluginUiWatchComposerRequestV1Schema,
} from './hostApiRequests.js';
export type {
  PluginUiAcquireComposerInputLockRequestV1,
  PluginUiActiveComposerResultV1,
  PluginUiApplyComposerRequestV1,
  PluginUiApplyComposerResultV1,
  PluginUiFocusComposerRequestV1,
  PluginUiFocusComposerResultV1,
  PluginUiInspectComposerContentRequestV1,
  PluginUiInspectComposerContentResultV1,
  PluginUiJsonObjectV1,
  PluginUiPickComposerMediaRequestV1,
  PluginUiPickComposerMediaResultV1,
  PluginUiReadComposerRequestV1,
  PluginUiReadComposerResultV1,
  PluginUiReleaseComposerContentRequestV1,
  PluginUiReplacePageLocationRequestV1,
  PluginUiReplacePageLocationResultV1,
  PluginUiSelectActionInputHostActionV1,
  PluginUiSelectActionInputHostRequestV1,
  PluginUiSelectActionInputRequestV1,
  PluginUiSelectActionInputResultV1,
  PluginUiSelectActionInputServerStartDraftV1,
  PluginUiSelectActionInputTargetedRequestV1,
  PluginUiSelectActionInputTargetedSubmittedV1,
  PluginUiSetComposerDecorationsRequestV1,
  PluginUiSetComposerDecorationsResultV1,
  PluginUiWatchComposerEventV1,
  PluginUiWatchComposerRequestV1,
} from './hostApiRequests.js';
export {
  isPluginUiSelectedActionInput,
  pluginUiSelectedActionInputMatchesOperation,
  pluginUiSelectedActionInputsEqual,
  pluginUiTargetedContributionOperationKey,
  PluginUiSelectedActionInputCarrierV1Schema,
  reconstructPluginUiSelectedActionInput,
} from './selectedActionInput.js';
export type {
  PluginUiSelectedActionInputCarrierV1,
  PluginUiSelectedActionInputForReconstructionV1,
  PluginUiSelectedActionInputV1,
} from './selectedActionInput.js';
export {
  PluginTargetedContributionSelectionV1Schema,
  PluginUiTargetedContributionOperationV1Schema,
  PluginUiTargetedContributionPointRefV1Schema,
  PluginUiTargetedContributionPointSnapshotV1Schema,
  PluginUiTargetedContributionProtocolSnapshotV1Schema,
  PluginUiTargetedContributionProtocolV1Schema,
  PluginUiTargetedContributionSurfacePresentationV1Schema,
  PluginUiTargetedContributionSurfaceV1Schema,
  PluginUiTargetedContributionV1Schema,
  PluginUiTargetedContributionsV1Schema,
} from './targetedContributions.js';
export type {
  PluginTargetedContributionSelectionV1,
  PluginUiTargetedContributionOperationV1,
  PluginUiTargetedContributionPointRefV1,
  PluginUiTargetedContributionPointSnapshotV1,
  PluginUiTargetedContributionProtocolSnapshotV1,
  PluginUiTargetedContributionProtocolV1,
  PluginUiTargetedContributionSurfacePresentationV1,
  PluginUiTargetedContributionSurfaceV1,
  PluginUiTargetedContributionV1,
  PluginUiTargetedContributionsV1,
} from './targetedContributions.js';
export {
  PLUGIN_HOSTED_WEB_COLLECTION_UI_QUERY_BRIDGE_KIND_V1,
  PluginHostedWebCollectionUiQueryBridgeChangeV1Schema,
  PluginHostedWebCollectionUiQueryBridgeOperationV1Schema,
  PluginHostedWebCollectionUiQueryBridgeRequestV1Schema,
  PluginHostedWebCollectionUiQueryBridgeResponseV1Schema,
  PluginHostedWebCollectionUiQueryBridgeSnapshotV1Schema,
  type PluginHostedWebCollectionUiQueryBridgeChangeV1,
  type PluginHostedWebCollectionUiQueryBridgeOperationV1,
  type PluginHostedWebCollectionUiQueryBridgeRequestV1,
  type PluginHostedWebCollectionUiQueryBridgeResponseV1,
  type PluginHostedWebCollectionUiQueryBridgeSnapshotV1,
} from '../data/hostedWebCollectionUiQueryBridgeV1.js';
export {
  PLUGIN_HOSTED_WEB_NATIVE_ARTIFACT_URL_SCHEME_V1,
  PluginHostedWebBridgeBootstrapEnvelopeV1Schema,
  PluginHostedWebBridgeCollectionUiQueryMessageEnvelopeV1Schema,
  PluginHostedWebBridgeBootstrapPayloadV1Schema,
  PluginHostedWebBridgeEnvelopeV1Schema,
  PluginHostedWebBridgeHostMessageEnvelopeV1Schema,
  PluginHostedWebBridgeResponseEnvelopeV1Schema,
  isExactPluginHostedWebBridgeOriginV1,
  readPluginHostedWebBridgeFrameOriginV1,
  type PluginHostedWebBridgeBootstrapEnvelopeV1,
  type PluginHostedWebBridgeBootstrapPayloadV1,
  type PluginHostedWebBridgeCollectionUiQueryMessageEnvelopeV1,
  type PluginHostedWebBridgeEnvelopeV1,
  type PluginHostedWebBridgeHostMessageEnvelopeV1,
  type PluginHostedWebBridgeResponseEnvelopeV1,
} from './hostedWebBridge.js';
export type { PluginHostedWebContributionV1 } from '../contributions/ui/hostedWeb.js';
/** The normalized container vocabulary mirrored by the public SDK surface context. */
export type { PluginUiContainerV1 } from '../contributions/ui/surfaceRegistry.js';
export {
  PluginUiHostApiSurfaceContextV1Schema,
  PluginUiMountContextV1Schema,
} from './surfaceContext.js';
export type {
  PluginUiHostApiSurfaceContextV1,
  PluginUiHostApiSurfaceTargetV1,
  PluginUiHostApiSurfaceThemeV1,
  PluginUiMountContextV1,
} from './surfaceContext.js';
