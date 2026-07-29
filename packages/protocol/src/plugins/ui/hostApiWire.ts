import { z } from 'zod';

import { PluginUiJsonValueV1Schema } from '../contributions/ui/json.js';

export const PLUGIN_UI_HOST_API_WIRE_VERSION_V1 = 1 as const;
export const PLUGIN_UI_HOST_API_SEMVER_V1 = '1.0.0' as const;

export const PluginUiHostApiDomainMethodV1Schema = z.enum([
  'context', 'watchContext', 'executeAction', 'readResource', 'watchResource',
  'openSurface', 'diagnostic', 'readClipboard', 'writeClipboard', 'openExternalLink',
]);
export type PluginUiHostApiDomainMethodV1 = z.infer<typeof PluginUiHostApiDomainMethodV1Schema>;

export const PluginUiHostApiWireIdentityV1Schema = z.object({
  pluginId: z.string().trim().min(1),
  pluginVersion: z.string().trim().min(1),
  viewId: z.string().trim().min(1),
  generation: z.string().trim().min(1),
  sessionId: z.string().trim().min(1).optional(),
}).strict();
export type PluginUiHostApiWireIdentityV1 = z.infer<typeof PluginUiHostApiWireIdentityV1Schema>;

const WireBase = z.object({ wireVersion: z.literal(1), identity: PluginUiHostApiWireIdentityV1Schema });
const RequestBase = WireBase.extend({ requestId: z.string().trim().min(1) });
const PluginContributionRefSchema = z.object({
  pluginId: z.string().trim().min(1),
  localId: z.string().trim().min(1),
}).strict();
const PluginRemediationDataSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('retry') }).strict(),
  z.object({ kind: z.literal('openSettings'), path: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('selectAccount'), service: PluginContributionRefSchema }).strict(),
  z.object({ kind: z.literal('installDependency'), dependencyId: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('openUrl'), url: z.string().trim().min(1) }).strict(),
]);
const PluginDiagnosticDataSchema = z.object({
  code: z.string().trim().min(1),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string().optional(),
  details: PluginUiJsonValueV1Schema.optional(),
  remediation: PluginRemediationDataSchema.optional(),
}).strict();

export const PluginUiHostApiWireEnvelopeV1Schema = z.discriminatedUnion('kind', [
  WireBase.extend({ kind: z.literal('negotiate'), apiRange: z.string().trim().min(1), requiredMethods: z.array(PluginUiHostApiDomainMethodV1Schema) }).strict(),
  WireBase.extend({ kind: z.literal('negotiated'), apiVersion: z.string().trim().min(1), methods: z.array(PluginUiHostApiDomainMethodV1Schema), surface: PluginUiJsonValueV1Schema }).strict(),
  RequestBase.extend({ kind: z.literal('request'), method: PluginUiHostApiDomainMethodV1Schema, payload: PluginUiJsonValueV1Schema.optional() }).strict(),
  RequestBase.extend({ kind: z.literal('cancel') }).strict(),
  RequestBase.extend({ kind: z.literal('result'), method: PluginUiHostApiDomainMethodV1Schema, result: PluginUiJsonValueV1Schema.optional() }).strict(),
  RequestBase.extend({
    kind: z.literal('error'),
    method: PluginUiHostApiDomainMethodV1Schema,
    error: z.object({
      name: z.literal('PluginError'),
      code: z.string().trim().min(1),
      message: z.string().optional(),
      retryable: z.boolean().optional(),
      details: PluginUiJsonValueV1Schema.optional(),
      remediation: PluginRemediationDataSchema.optional(),
      diagnostics: z.array(PluginDiagnosticDataSchema).optional(),
    }).strict(),
  }).strict(),
  RequestBase.extend({ kind: z.literal('subscribe'), subscriptionId: z.string().trim().min(1), method: z.enum(['watchContext', 'watchResource']), payload: PluginUiJsonValueV1Schema.optional() }).strict(),
  WireBase.extend({ kind: z.literal('subscription'), subscriptionId: z.string().trim().min(1), event: PluginUiJsonValueV1Schema }).strict(),
  RequestBase.extend({ kind: z.literal('unsubscribe'), subscriptionId: z.string().trim().min(1) }).strict(),
  WireBase.extend({ kind: z.literal('disconnected'), reason: z.string().trim().min(1) }).strict(),
]);
export type PluginUiHostApiWireEnvelopeV1 = z.infer<typeof PluginUiHostApiWireEnvelopeV1Schema>;
