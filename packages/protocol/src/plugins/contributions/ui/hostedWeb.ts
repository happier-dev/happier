import { z } from 'zod';

import { PLUGIN_HOSTED_WEB_ACCOUNT_DATA_BRIDGE_KIND_V1 } from '../../data/hostedWebAccountDataBridgeV1.js';
import { PluginUiFallbackRefV1Schema } from './actions.js';
import { PluginUiCompatibilityV1Schema } from './compatibility.js';
import { PluginHostedWebSecurityPolicyV1Schema } from './hostedWebSecurity.js';
import { PluginUiDisplayV1Schema } from './tokens.js';

export const PluginHostedWebServiceRefV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('staticAssets'),
    assetRootId: z.string().trim().min(1),
  }).strict(),
  z.object({
    kind: z.literal('sessionEndpoint'),
    endpointIdPath: z.string().trim().min(1),
  }).strict(),
]);
export type PluginHostedWebServiceRefV1 = z.infer<typeof PluginHostedWebServiceRefV1Schema>;

export const PluginHostedWebEntryV1Schema = z.object({
  path: z.string().trim().min(1).optional(),
  query: z.record(z.string(), z.string()).optional(),
  routeMode: z.enum(['hostOrigin', 'pathFallback']),
}).strict();
export type PluginHostedWebEntryV1 = z.infer<typeof PluginHostedWebEntryV1Schema>;

/**
 * Bridge envelope kinds that carry no host API request: frame lifecycle plus the
 * `hostApi` wrapper that transports a canonical `PluginUiHostApiWireEnvelopeV1`.
 */
export const PLUGIN_HOSTED_WEB_BRIDGE_LIFECYCLE_KINDS_V1 = Object.freeze([
    'ready',
    'error',
    'heightChanged',
    'hostApi',
] as const);
export type PluginHostedWebBridgeLifecycleKindV1 =
  (typeof PLUGIN_HOSTED_WEB_BRIDGE_LIFECYCLE_KINDS_V1)[number];

/**
 * Strict non-host-API operation arms. Each is owned by its domain schema and
 * remains opt-in through the existing hosted-web `allowedMessages` declaration.
 */
export const PLUGIN_HOSTED_WEB_BRIDGE_OPERATION_KINDS_V1 = Object.freeze([
  PLUGIN_HOSTED_WEB_ACCOUNT_DATA_BRIDGE_KIND_V1,
] as const);
export type PluginHostedWebBridgeOperationKindV1 =
  (typeof PLUGIN_HOSTED_WEB_BRIDGE_OPERATION_KINDS_V1)[number];

/**
 * The outer bridge vocabulary (UI-D27). Host API requests are carried only in
 * the `hostApi` lifecycle wrapper as canonical wire envelopes; an outer
 * host-method kind would bypass negotiation, cancellation, and currentness.
 * The narrow Data operation arm above is separately schema-owned and is not a
 * host method.
 */
export const PluginHostedWebBridgeMessageKindV1Schema = z.enum([
  ...PLUGIN_HOSTED_WEB_BRIDGE_LIFECYCLE_KINDS_V1,
  ...PLUGIN_HOSTED_WEB_BRIDGE_OPERATION_KINDS_V1,
]);
export type PluginHostedWebBridgeMessageKindV1 = z.infer<typeof PluginHostedWebBridgeMessageKindV1Schema>;

export const PluginHostedWebBridgePolicyV1Schema = z.object({
  allowedMessages: z.array(PluginHostedWebBridgeMessageKindV1Schema).default([]),
}).strict();
export type PluginHostedWebBridgePolicyV1 = z.infer<typeof PluginHostedWebBridgePolicyV1Schema>;

export const PluginHostedWebSandboxPolicyV1Schema = z.object({
  scripts: z.boolean().default(false),
  sameOrigin: z.boolean().default(false),
  popups: z.boolean().default(false),
  topNavigation: z.boolean().default(false),
  mixedContent: z.boolean().default(false),
}).strict();
export type PluginHostedWebSandboxPolicyV1 = z.infer<typeof PluginHostedWebSandboxPolicyV1Schema>;

export const PluginHostedWebContributionV1Schema = z.object({
  id: z.string().trim().min(1),
  service: PluginHostedWebServiceRefV1Schema,
  entry: PluginHostedWebEntryV1Schema,
  bridge: PluginHostedWebBridgePolicyV1Schema,
  display: PluginUiDisplayV1Schema,
  sandbox: PluginHostedWebSandboxPolicyV1Schema,
  security: PluginHostedWebSecurityPolicyV1Schema,
  compatibility: PluginUiCompatibilityV1Schema.optional(),
  fallback: PluginUiFallbackRefV1Schema,
}).strict();
export type PluginHostedWebContributionV1 = z.infer<typeof PluginHostedWebContributionV1Schema>;
export type PluginHostedWebContribution = z.infer<typeof PluginHostedWebContributionV1Schema>;
export type PluginHostedWebContributionInput = z.input<typeof PluginHostedWebContributionV1Schema>;
