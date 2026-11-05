import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

/**
 * The browser-safe, static definition of the Host API contract.
 *
 * Range admission is intentionally separate: only a host decides whether a
 * guest's requested range is compatible. Mounted clients consume that same
 * selection owner when validating their separately negotiated generation.
 */

/**
 * Semantic API generations are independent of wire epoch 1 and package SemVer.
 * Installed 1.0 SDKs have a closed method enum and require an exact 1.0 reply.
 */
export const PLUGIN_UI_HOST_API_VERSIONS_V1 = Object.freeze(['1.0.0', '1.1.0'] as const);
/** The pre-negotiation bootstrap carries no methods and retains its base shape. */
export const PLUGIN_UI_HOST_API_BASE_VERSION_V1 = PLUGIN_UI_HOST_API_VERSIONS_V1[0];
export const PLUGIN_UI_HOST_API_VERSION_V1 = PLUGIN_UI_HOST_API_VERSIONS_V1[1];

/** The default compatibility request is derived from the one semantic version. */
export const PLUGIN_UI_HOST_API_COMPATIBLE_RANGE_V1 = `^${PLUGIN_UI_HOST_API_VERSION_V1}` as const;

/**
 * The sole producer-backed host-method vocabulary (SDK-EU-28).
 *
 * Every method names its first semantic API generation here. Declarations,
 * wire schemas and transport projections derive from this one vocabulary;
 * adding a method must explicitly choose its generation.
 */
const HOST_METHOD_INTRODUCTION_VERSION = Object.freeze({
  context: '1.0.0',
  publishCurrentUiContext: '1.0.0',
  watchContext: '1.0.0',
  executeAction: '1.0.0',
  admitAction: '1.0.0',
  readResource: '1.0.0',
  statOpenableContent: '1.0.0',
  readOpenableContent: '1.0.0',
  watchResource: '1.0.0',
  openSurface: '1.0.0',
  openConnectedAccounts: '1.0.0',
  replacePageLocation: '1.0.0',
  notify: '1.0.0',
  confirm: '1.0.0',
  diagnostic: '1.0.0',
  readClipboard: '1.0.0',
  writeClipboard: '1.0.0',
  openExternalLink: '1.0.0',
  selectActionInput: '1.0.0',
  openNewSession: '1.0.0',
  openAutomationEvent: '1.0.0',
  settleEphemeralInput: '1.0.0',
  activeComposer: '1.0.0',
  readComposer: '1.0.0',
  readDiscussionComposer: '1.0.0',
  watchComposer: '1.0.0',
  applyComposer: '1.0.0',
  focusComposer: '1.0.0',
  setComposerDecorations: '1.0.0',
  acquireComposerInputLock: '1.0.0',
  pickComposerMedia: '1.0.0',
  inspectComposerContent: '1.0.0',
  releaseComposerContent: '1.0.0',
  readSession: '1.0.0',
  readStoredImage: '1.0.0',
  watchSession: '1.0.0',
  watchLiveStream: '1.0.0',
  respondToSessionPermission: '1.0.0',
  readEntityDragItem: '1.0.0',
  updateEntityDragDrop: '1.0.0',
  watchEntityDragDrop: '1.0.0',
  widgetArea: '1.0.0',
} as const satisfies Record<string, (typeof PLUGIN_UI_HOST_API_VERSIONS_V1)[number]>);
export const PLUGIN_UI_HOST_METHODS_V1 = Object.freeze(
  Object.keys(HOST_METHOD_INTRODUCTION_VERSION) as (keyof typeof HOST_METHOD_INTRODUCTION_VERSION)[],
);
export const PluginUiHostMethodV1Schema = lazyZodSchema(() => z.enum(PLUGIN_UI_HOST_METHODS_V1));
export type PluginUiHostMethodV1 = z.infer<typeof PluginUiHostMethodV1Schema>;

/** Browser-safe projection of the sole method/version definition. */
export function isPluginUiHostMethodSupportedInVersionV1(method: PluginUiHostMethodV1, version: string): boolean {
  const supportedIndex = PLUGIN_UI_HOST_API_VERSIONS_V1.findIndex(candidate => candidate === version);
  return supportedIndex >= PLUGIN_UI_HOST_API_VERSIONS_V1.indexOf(HOST_METHOD_INTRODUCTION_VERSION[method]);
}

/**
 * The closed declarable ceiling for caller-authored hosted HTML.
 *
 * Installed code is admitted through a manifest, an immutable generation and
 * its grants, so its negotiated subset is decided by the plugin authority
 * owner. A by-value document authored inside a Session has none of those, so
 * the vocabulary it may even ASK for is capped here, beside the one method
 * tuple. It is read/act/notify only: no clipboard, Composer, navigation,
 * open-content, connected-account or current-UI-publication authority can be
 * requested, advertised or dispatched, whatever an outer message claims.
 *
 * This is a ceiling, not a grant. The mounting host still intersects it with
 * the document's own request and the currently admitted set, and every
 * individual Resource and Action keeps its ordinary admission and confirmation
 * policy.
 */
export const PLUGIN_UI_CALLER_HOSTED_HTML_HOST_METHODS_V1 = Object.freeze([
  'context',
  'watchContext',
  'readResource',
  'watchResource',
  'executeAction',
  'notify',
] as const satisfies readonly PluginUiHostMethodV1[]);
export const PluginUiCallerHostedHtmlHostMethodV1Schema = lazyZodSchema(() => z.enum(
  PLUGIN_UI_CALLER_HOSTED_HTML_HOST_METHODS_V1,
));
export type PluginUiCallerHostedHtmlHostMethodV1 =
  z.infer<typeof PluginUiCallerHostedHtmlHostMethodV1Schema>;

/**
 * Transport operations are not host API methods. `disposeHostResource` retires
 * an established context, Resource, Composer observation, or input-lock lease;
 * it is never declarable, advertised, or a public SDK member.
 */
export const PLUGIN_UI_HOST_TRANSPORT_OPERATIONS_V1 = Object.freeze([
  'disposeHostResource',
] as const);
export type PluginUiHostTransportOperationV1 =
  (typeof PLUGIN_UI_HOST_TRANSPORT_OPERATIONS_V1)[number];

/** Every host method plus the transport-only operations, derived once. */
export const PluginUiHostApiRequestMethodV1Schema = lazyZodSchema(() => z.enum([
  ...PLUGIN_UI_HOST_METHODS_V1,
  ...PLUGIN_UI_HOST_TRANSPORT_OPERATIONS_V1,
]));
export type PluginUiHostApiRequestMethodV1 =
  z.infer<typeof PluginUiHostApiRequestMethodV1Schema>;

/** The subscription-establishing subset remains inside the sole tuple. */
export const PLUGIN_UI_HOST_SUBSCRIPTION_METHODS_V1 = Object.freeze([
  'watchEntityDragDrop',
  'watchContext',
  'watchResource',
  'watchComposer',
  'acquireComposerInputLock',
  'watchSession',
  'watchLiveStream',
] as const satisfies readonly PluginUiHostMethodV1[]);
export const PluginUiHostSubscriptionMethodV1Schema = lazyZodSchema(() => z.enum(
  PLUGIN_UI_HOST_SUBSCRIPTION_METHODS_V1,
));
export type PluginUiHostSubscriptionMethodV1 =
  z.infer<typeof PluginUiHostSubscriptionMethodV1Schema>;
