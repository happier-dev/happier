import { z } from 'zod';

import {
  PluginHostedWebBridgeMessageKindV1Schema,
} from '../contributions/ui/hostedWeb.js';
import {
  PLUGIN_HOSTED_WEB_COLLECTION_UI_QUERY_BRIDGE_KIND_V1,
  PluginHostedWebCollectionUiQueryBridgeChangeV1Schema,
} from '../data/hostedWebCollectionUiQueryBridgeV1.js';
import { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';
import {
  PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
  PluginUiHostApiWireEnvelopeV1Schema,
  PluginUiHostApiWireIdentityV1Schema,
} from './hostApiWire.js';
import { PLUGIN_UI_HOST_API_VERSION_V1 } from './hostApiDefinition.js';
import { PluginUiLaunchInputV1Schema, PluginUiSubPathV1Schema } from './hostApiRequests.js';
import { ComposerRefV1Schema } from './composer.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';

const BridgeIdSchema = z.string().trim().min(1);
const ComposerRefV1ZodSchema = asProtocolZod(ComposerRefV1Schema);
const HOSTED_WEB_NATIVE_ARTIFACT_PARTITION_PATTERN = /^hpa_[a-f0-9]{64}$/u;
const HOSTED_WEB_ANDROID_ARTIFACT_FRAME_HOST_SUFFIX = '.plugins.happier.dev';

/**
 * iOS serves verified Artifact bytes through a token-qualified `WKURLSchemeHandler`.
 * This is intentionally the only non-HTTP frame address the bridge admits.
 */
export const PLUGIN_HOSTED_WEB_NATIVE_ARTIFACT_URL_SCHEME_V1 = 'happier-hosted-artifact';

/**
 * Native Artifact frames have three renderer adapters. Android's WebView asset
 * loader requires an HTTPS origin; iOS's `WKURLSchemeHandler` and the factual
 * macOS direct-Wry desktop adapter have no HTTP server and therefore use
 * Protocol's explicitly admitted token scheme. This does not claim a desktop
 * implementation on Windows or Linux.
 */
export type PluginHostedWebNativeArtifactFramePlatformV1 = 'ios' | 'android' | 'desktop';

/**
 * The one bridge-origin derivation for registered native Artifact frames.
 * Consumers receive only a verified opaque partition id and must not derive a
 * URL from an Artifact path, cache locator, bytes, or an author-provided URL.
 */
export function resolvePluginHostedWebNativeArtifactFrameOriginV1(input: Readonly<{
  platform: PluginHostedWebNativeArtifactFramePlatformV1;
  storagePartitionId: string;
}>): string | null {
  if (!HOSTED_WEB_NATIVE_ARTIFACT_PARTITION_PATTERN.test(input.storagePartitionId)) {
    return null;
  }
  const origin = input.platform === 'android'
    ? `https://${input.storagePartitionId}${HOSTED_WEB_ANDROID_ARTIFACT_FRAME_HOST_SUFFIX}`
    : `${PLUGIN_HOSTED_WEB_NATIVE_ARTIFACT_URL_SCHEME_V1}://${input.storagePartitionId}`;
  return isExactPluginHostedWebBridgeOriginV1(origin) ? origin : null;
}

function isExactNativeArtifactBridgeOrigin(value: string, parsed: URL): boolean {
  return parsed.protocol === `${PLUGIN_HOSTED_WEB_NATIVE_ARTIFACT_URL_SCHEME_V1}:`
    && HOSTED_WEB_NATIVE_ARTIFACT_PARTITION_PATTERN.test(parsed.hostname)
    && parsed.username === ''
    && parsed.password === ''
    && parsed.port === ''
    && parsed.pathname === ''
    && parsed.search === ''
    && parsed.hash === ''
    && parsed.href === value;
}

/** The protocol owner for an exact hosted frame bridge address. */
export function isExactPluginHostedWebBridgeOriginV1(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.origin === value && parsed.origin !== 'null')
      || isExactNativeArtifactBridgeOrigin(value, parsed);
  } catch {
    return false;
  }
}

/**
 * Normalize a concrete frame URL to the bridge address the bootstrap must echo.
 * HTTP(S) retains WHATWG's origin; the native token scheme has a null WHATWG
 * origin, so Protocol derives its one explicit canonical form here.
 */
export function readPluginHostedWebBridgeFrameOriginV1(url: URL): string | null {
  if (url.origin !== 'null' && isExactPluginHostedWebBridgeOriginV1(url.origin)) {
    return url.origin;
  }
  if (
    url.protocol === `${PLUGIN_HOSTED_WEB_NATIVE_ARTIFACT_URL_SCHEME_V1}:`
    && HOSTED_WEB_NATIVE_ARTIFACT_PARTITION_PATTERN.test(url.hostname)
    && url.username === ''
    && url.password === ''
    && url.port === ''
  ) {
    return `${PLUGIN_HOSTED_WEB_NATIVE_ARTIFACT_URL_SCHEME_V1}://${url.hostname}`;
  }
  return null;
}

const BridgeOriginSchema = z.string().trim().url().refine(isExactPluginHostedWebBridgeOriginV1, {
  message: 'Hosted-web bridge origins must be exact absolute origins.',
});

const PluginHostedWebBridgeEnvelopeBaseV1Schema = z.object({
  version: z.literal(1),
  pluginId: BridgeIdSchema,
  contributionId: BridgeIdSchema,
  surfaceId: BridgeIdSchema,
  sessionId: BridgeIdSchema.optional(),
  nonce: BridgeIdSchema,
  sequence: z.number().int().nonnegative(),
}).strict();

export const PluginHostedWebBridgeEnvelopeV1Schema =
  PluginHostedWebBridgeEnvelopeBaseV1Schema.extend({
    kind: PluginHostedWebBridgeMessageKindV1Schema,
    payload: PluginUiJsonValueV1Schema,
  }).strict();
export type PluginHostedWebBridgeEnvelopeV1 =
  z.infer<typeof PluginHostedWebBridgeEnvelopeV1Schema>;

export const PluginHostedWebBridgeResponseKindV1Schema = z.enum([
  'ack',
  'result',
  'error',
]);
export type PluginHostedWebBridgeResponseKindV1 =
  z.infer<typeof PluginHostedWebBridgeResponseKindV1Schema>;

export const PluginHostedWebBridgeResponseEnvelopeV1Schema =
  PluginHostedWebBridgeEnvelopeBaseV1Schema.extend({
    requestSequence: z.number().int().nonnegative(),
    kind: PluginHostedWebBridgeResponseKindV1Schema,
    payload: PluginUiJsonValueV1Schema,
  }).strict();
export type PluginHostedWebBridgeResponseEnvelopeV1 =
  z.infer<typeof PluginHostedWebBridgeResponseEnvelopeV1Schema>;

/**
 * The bridge envelope kinds the HOST may originate (EU-8).
 *
 * `hostApi` transports canonical request/response/subscription wire. `bootstrap`
 * is a separate strict host-only record sent after a frame is ready, so it does
 * not become an author-declared guest message kind or a generic JSON channel.
 */
export const PLUGIN_HOSTED_WEB_BRIDGE_HOST_MESSAGE_KINDS_V1 = Object.freeze([
  'hostApi',
  'bootstrap',
  PLUGIN_HOSTED_WEB_COLLECTION_UI_QUERY_BRIDGE_KIND_V1,
] as const);
export const PluginHostedWebBridgeHostMessageKindV1Schema = z.enum(
  PLUGIN_HOSTED_WEB_BRIDGE_HOST_MESSAGE_KINDS_V1,
);
export type PluginHostedWebBridgeHostMessageKindV1 =
  z.infer<typeof PluginHostedWebBridgeHostMessageKindV1Schema>;

/**
 * The unsolicited host->frame envelope: the transport's push direction.
 *
 * The bridge used to be request/response only — a frame could ask and be
 * answered, and nothing else. That left `watchContext`, dynamic-resource
 * invalidation, host-side retirement and launch/theme updates with no way to
 * reach a mounted hosted-web surface at all.
 *
 * Two things make this envelope structurally distinct from the other two, both
 * of which are `.strict()` extensions of the same base:
 *
 * - `direction: 'hostToFrame'` is present ONLY here, so a hostile frame that
 *   reflects or replays a host push at the host fails the guest->host parse
 *   closed (`invalid_message`) instead of being accepted as a request;
 * - the payload is the canonical wire envelope itself rather than free JSON, so
 *   the push channel cannot grow a vocabulary the request path does not have.
 *
 * `sequence` is the host's own monotonic push counter and is deliberately NOT a
 * `requestSequence`: a push answers no request, which is how the guest tells the
 * two apart.
 */
export const PluginHostedWebBridgeHostApiMessageEnvelopeV1Schema =
  PluginHostedWebBridgeEnvelopeBaseV1Schema.extend({
    direction: z.literal('hostToFrame'),
    kind: z.literal('hostApi'),
    payload: PluginUiHostApiWireEnvelopeV1Schema,
  }).strict();

/**
 * Frame bootstrap is limited to facts a hosted renderer needs to create the
 * canonical SDK client and receive its current navigation argument. The base
 * envelope supplies exact plugin/contribution/surface address and nonce; the
 * explicit origin binds the postMessage peer. A Composer-mounted frame alone
 * receives its exact host-stamped Composer ref; generic mounts omit it.
 * Account, runtime target, lifecycle currentness and host-installed methods
 * are intentionally absent.
 */
export const PluginHostedWebBridgeBootstrapPayloadV1Schema = z.object({
  apiVersion: z.literal(PLUGIN_UI_HOST_API_VERSION_V1),
  wireVersion: z.literal(PLUGIN_UI_HOST_API_WIRE_VERSION_V1),
  identity: PluginUiHostApiWireIdentityV1Schema,
  subPath: PluginUiSubPathV1Schema.optional(),
  launchInput: PluginUiLaunchInputV1Schema.optional(),
  composerRef: ComposerRefV1ZodSchema.optional(),
}).strict();
export type PluginHostedWebBridgeBootstrapPayloadV1 =
  z.infer<typeof PluginHostedWebBridgeBootstrapPayloadV1Schema>;

export const PluginHostedWebBridgeBootstrapEnvelopeV1Schema =
  PluginHostedWebBridgeEnvelopeBaseV1Schema.extend({
    direction: z.literal('hostToFrame'),
    origin: BridgeOriginSchema,
    kind: z.literal('bootstrap'),
    payload: PluginHostedWebBridgeBootstrapPayloadV1Schema,
  }).strict();
export type PluginHostedWebBridgeBootstrapEnvelopeV1 =
  z.infer<typeof PluginHostedWebBridgeBootstrapEnvelopeV1Schema>;

/**
 * The Data-owned hosted-query push. It shares the one authenticated bridge
 * base, nonce, and host sequence with host API delivery while retaining a
 * strict Data payload rather than borrowing the host-API wire envelope.
 */
export const PluginHostedWebBridgeCollectionUiQueryMessageEnvelopeV1Schema =
  PluginHostedWebBridgeEnvelopeBaseV1Schema.extend({
    direction: z.literal('hostToFrame'),
    kind: z.literal(PLUGIN_HOSTED_WEB_COLLECTION_UI_QUERY_BRIDGE_KIND_V1),
    payload: PluginHostedWebCollectionUiQueryBridgeChangeV1Schema,
  }).strict();
export type PluginHostedWebBridgeCollectionUiQueryMessageEnvelopeV1 =
  z.infer<typeof PluginHostedWebBridgeCollectionUiQueryMessageEnvelopeV1Schema>;

export const PluginHostedWebBridgeHostMessageEnvelopeV1Schema = z.union([
  PluginHostedWebBridgeHostApiMessageEnvelopeV1Schema,
  PluginHostedWebBridgeBootstrapEnvelopeV1Schema,
  PluginHostedWebBridgeCollectionUiQueryMessageEnvelopeV1Schema,
]);
export type PluginHostedWebBridgeHostMessageEnvelopeV1 =
  z.infer<typeof PluginHostedWebBridgeHostMessageEnvelopeV1Schema>;
