import {
    PLUGIN_UI_ICON_TOKENS_V1 as canonicalPluginUiIconTokensV1,
} from '@happier-dev/protocol/plugins/contributions/ui/tokens';
import type {
    PluginSessionHeaderActionDescriptor,
    PluginUiDeclarativeNodeV2,
    PluginUiDeclarativeToneV2,
    PluginUiIconTokenV1,
    PluginUiPageHeaderActionV1,
    PluginUiRendererV2,
    PluginUiSchema,
    PluginUiSettingsPageV1,
    PluginUiTranslationBundleV2,
    PluginUiViewV2Input,
    PluginUiViewTargetV2,
} from './ui/publicContract.js';

export type {
    PluginUiViewDestinationBindingInputV2,
    PluginUiViewV2,
    PluginUiViewV2Input,
    PluginUiViewTargetV2,
    PluginUiPageHeaderActionV1,
    PluginUiDeclarativeNodeV2,
    PluginUiDeclarativeToneV2,
    PluginUiSchema,
    PluginUiSettingsPageV1,
    PluginUiIconTokenV1,
    PluginUiSessionPlacementCandidateV1,
    PluginUiToneV1,
    PluginUiAttachmentToneV1,
} from './ui/publicContract.js';

/** Canonical Protocol-owned vocabulary projected without a Protocol type edge. */
export const PLUGIN_UI_ICON_TOKENS_V1: readonly PluginUiIconTokenV1[] = canonicalPluginUiIconTokensV1;

export type {
    OpenableContentBody,
    OpenableContentReadRequest,
    OpenableContentReadResult,
    OpenableContentRef,
    OpenableContentStatResult,
    PluginUiActionInputFor,
    PluginUiActionReference,
    PluginUiActionResultFor,
    PluginUiActionTransportResult,
    PluginUiHostApi,
    RenderContext,
    RenderSurface,
    ResourceContent,
    ResourceSubscriptionEvent,
    SurfaceContext,
    SurfaceHostMethod,
} from './ui/hostApi.js';
/** Concise author spelling for the canonical mounted UI host API. */
export type { PluginUiHostApi as UiHost } from './ui/hostApi.js';
/** Concise author spelling for one immutable Resource snapshot. */
export type { ResourceContent as UiResource } from './ui/hostApi.js';
export type {
    PluginUiChannel,
    PluginUiPlatform,
} from './ui/compatibility.js';
export type { PluginSessionHeaderActionDescriptor as SessionHeaderActionContribution } from './ui/publicContract.js';
export type {
    PluginUiRendererV2 as UiRenderer,
    PluginUiTranslationBundleV2 as UiTranslationBundle,
} from './ui/publicContract.js';
/** One cold manifest UI view declaration, preserving the canonical input grammar. */
export type UiView = PluginUiViewV2Input;
export {
    defineHostedWebBridgeMessage,
} from './ui/hostedWeb.js';
export type {
    PluginHostedWebBridgeEnvelopeV1 as HostedWebBridgeEnvelopeV1,
} from './ui/hostedWeb.js';
export {
    definePluginDeclarativeDocumentV1,
    PLUGIN_DECLARATIVE_DOCUMENT_CONTENT_TYPE_V1,
} from './ui/declarativeDocument.js';
export type {
    PluginDeclarativeDocumentContentTypeV1,
    PluginDeclarativeDocumentV1,
} from './ui/declarativeDocument.js';
