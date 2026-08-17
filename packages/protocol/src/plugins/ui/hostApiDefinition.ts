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
  'watchContext',
  'executeAction',
  'readResource',
  'statOpenableContent',
  'readOpenableContent',
  'watchResource',
  'openSurface',
  'replacePageLocation',
  'notify',
  'confirm',
  'diagnostic',
  'readClipboard',
  'writeClipboard',
  'openExternalLink',
  'selectActionInput',
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
] as const);
export const PluginUiHostMethodV1Schema = z.enum(PLUGIN_UI_HOST_METHODS_V1);
export type PluginUiHostMethodV1 = z.infer<typeof PluginUiHostMethodV1Schema>;

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
export const PluginUiHostApiRequestMethodV1Schema = z.enum([
  ...PLUGIN_UI_HOST_METHODS_V1,
  ...PLUGIN_UI_HOST_TRANSPORT_OPERATIONS_V1,
]);
export type PluginUiHostApiRequestMethodV1 =
  z.infer<typeof PluginUiHostApiRequestMethodV1Schema>;

/** The subscription-establishing subset remains inside the sole tuple. */
export const PLUGIN_UI_HOST_SUBSCRIPTION_METHODS_V1 = Object.freeze([
  'watchContext',
  'watchResource',
  'watchComposer',
  'acquireComposerInputLock',
] as const satisfies readonly PluginUiHostMethodV1[]);
export const PluginUiHostSubscriptionMethodV1Schema = z.enum(
  PLUGIN_UI_HOST_SUBSCRIPTION_METHODS_V1,
);
export type PluginUiHostSubscriptionMethodV1 =
  z.infer<typeof PluginUiHostSubscriptionMethodV1Schema>;
