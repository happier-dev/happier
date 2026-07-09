import { z } from 'zod';

import { PluginUiFallbackRefV1Schema } from './actions.js';
import { PluginUiCompatibilityV1Schema } from './compatibility.js';
import { PluginHostedWebSecurityPolicyV1Schema } from './hostedWebSecurity.js';
import { PluginUiDisplayV1Schema } from './tokens.js';

export const PluginHostedWebServiceRefV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('managedService'),
    serviceId: z.string().trim().min(1),
  }).strict(),
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

export const PluginHostedWebBridgeMessageKindV1Schema = z.enum([
  'copy',
  'error',
  'heightChanged',
  'logDiagnostic',
  'openSurface',
  'openExternal',
  'ready',
  'requestHostAction',
  'requestSessionResource',
  'subscribeResource',
  'unsubscribeResource',
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
