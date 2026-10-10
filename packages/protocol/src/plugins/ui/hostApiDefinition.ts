import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

/**
 * The browser-safe, static definition of the initial Host API contract.
 *
 * Range admission is intentionally separate: only a host decides whether a
 * guest's requested range is compatible. Mounted guests need this definition
 * to construct and validate the one wire contract, but never need a semver
 * implementation to repeat the host's admission decision.
 */

/**
 * The one initial semantic Host API version. This author surface is
 * unpublished, so its former 1.0/1.1/1.2 draft strata are one direct cut, not
 * compatibility epochs.
 */
export const PLUGIN_UI_HOST_API_VERSION_V1 = '1.0.0' as const;

/** The default compatibility request is derived from the one semantic version. */
export const PLUGIN_UI_HOST_API_COMPATIBLE_RANGE_V1 = `^${PLUGIN_UI_HOST_API_VERSION_V1}` as const;

/**
 * The sole producer-backed host-method vocabulary (SDK-EU-28).
 *
 * Every declaration, wire envelope, mount advertisement, transport subset,
 * build/static stamp, fixture and SDK member derives from this tuple. A
 * transport can serve a subset, but it cannot rename a method or introduce a
 * version-specific tuple. `selectActionInput` is included because its host
 * producer and exact private currentness carrier are already real.
 */
export const PLUGIN_UI_HOST_METHODS_V1 = Object.freeze([
  'context',
  'publishCurrentUiContext',
  'watchContext',
  'executeAction',
  'readResource',
  'statOpenableContent',
  'readOpenableContent',
  'watchResource',
  'openSurface',
  'openConnectedAccounts',
  'replacePageLocation',
  'notify',
  'confirm',
  'diagnostic',
  'readClipboard',
  'writeClipboard',
  'openExternalLink',
  'selectActionInput',
  'openNewSession',
  'settleEphemeralInput',
  'activeComposer',
  'readComposer',
  'watchComposer',
  'applyComposer',
  'focusComposer',
  'setComposerDecorations',
  'acquireComposerInputLock',
  'pickComposerMedia',
  'inspectComposerContent',
  'releaseComposerContent',
  'readSession',
  'readStoredImage',
  'watchSession',
  'watchLiveStream',
  'respondToSessionPermission',
  'readEntityDragItem',
  'updateEntityDragDrop',
  'watchEntityDragDrop',
  'widgetArea',
] as const);
export const PluginUiHostMethodV1Schema = lazyZodSchema(() => z.enum(PLUGIN_UI_HOST_METHODS_V1));
export type PluginUiHostMethodV1 = z.infer<typeof PluginUiHostMethodV1Schema>;

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
