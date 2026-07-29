import { z } from 'zod';
import semver from 'semver';

import { PluginOptionalStringSchema } from '../_shared.js';
import { PluginContributesV2Schema } from '../contributions/v2.js';
import { ManagedExecutableRefSchema } from '../contributions/agentAcpTransport.js';
import { PluginIdSchema } from '../pluginId.js';
import {
  PluginConnectedAccountMaterializationKindsSchema,
} from '../../connect/connectedAccountPurposes.js';
import {
  PluginContributionReferenceV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from '../contributions/publicTypes.js';

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectForbiddenKey(
  ctx: z.RefinementCtx,
  key: string,
  message: string,
): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [key],
    message,
  });
}

export const PluginEnginesV2Schema = z.object({
  happier: z.string().trim().min(1).refine(
    (value) => !/[x*]/i.test(value) && semver.validRange(value) !== null,
    'engines.happier must be a non-wildcard semver range.',
  ),
}).strict();
export type PluginEnginesV2 = z.infer<typeof PluginEnginesV2Schema>;

export const PLUGIN_RUNTIME_API_VERSION = 1 as const;
export const PluginRuntimeV2Schema = z.object({
  apiVersion: z.literal(PLUGIN_RUNTIME_API_VERSION),
}).strict();
export type PluginRuntimeV2 = z.infer<typeof PluginRuntimeV2Schema>;

export const PluginEntrypointV2Schema = z.string().trim().min(1);
export type PluginEntrypointV2 = z.infer<typeof PluginEntrypointV2Schema>;

export const PluginEntrypointsV2Schema = z.object({
  daemon: PluginEntrypointV2Schema.optional(),
  development: PluginEntrypointV2Schema.optional(),
}).strict();
export type PluginEntrypointsV2 = z.infer<typeof PluginEntrypointsV2Schema>;

export { PluginLocalizedStringV2Schema, type PluginLocalizedStringV2 } from '../contributions/publicTypes.js';
const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
export const MAX_PLUGIN_ENVIRONMENT_KEYS = 64;
export const MAX_PLUGIN_ENVIRONMENT_KEY_LENGTH = 128;
const PluginEnvironmentKeySchema = z.string()
  .min(1)
  .max(MAX_PLUGIN_ENVIRONMENT_KEY_LENGTH)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const CanonicalHttpOriginSchema = z.string().superRefine((value, ctx) => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== value) throw new Error();
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Expected a canonical http/https origin without credentials.' });
  }
});
export const PluginNetworkTargetV2Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixedOrigin'), origin: CanonicalHttpOriginSchema }).strict(),
  z.object({ kind: z.literal('connectedAccountOrigin'), service: PluginContributionReferenceV2Schema }).strict(),
  z.object({ kind: z.literal('scmProviderOrigin'), provider: PluginContributionReferenceV2Schema }).strict(),
]);
export type PluginNetworkTargetV2 = z.infer<typeof PluginNetworkTargetV2Schema>;
function uniqueNonEmptyArray<T extends z.ZodTypeAny>(schema: T): z.ZodArray<T> {
  return z.array(schema).min(1).superRefine((values, ctx) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      const key = JSON.stringify(value);
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: [index], message: 'Duplicate set entry.' });
      seen.add(key);
    });
  });
}
const PluginHostAccessCommonV2Schema = z.object({
  id: z.string().trim().min(1),
  reason: PluginLocalizedStringV2Schema,
});
const PluginSecretsHostAccessRequestV2Schema = PluginHostAccessCommonV2Schema.extend({
  capability: z.literal('secrets'),
  scope: z.object({
    secretIds: uniqueNonEmptyArray(z.string().trim().min(1)),
    access: uniqueNonEmptyArray(z.enum(['read', 'write', 'delete'])),
  }).strict(),
}).strict();
const PluginConnectedAccountsHostAccessScopeV2Schema = z.object({
  serviceRefs: uniqueNonEmptyArray(PluginContributionReferenceV2Schema),
  accountScopes: uniqueNonEmptyArray(z.string().trim().min(1)).optional(),
  operations: uniqueNonEmptyArray(z.enum(['select', 'use'])),
  materializationKinds: PluginConnectedAccountMaterializationKindsSchema.optional(),
}).strict().superRefine((scope, context) => {
  if (scope.materializationKinds !== undefined && !scope.operations.includes('use')) {
    context.addIssue({
      code: 'custom',
      path: ['materializationKinds'],
      message: "Connected Account materialization kinds require the 'use' operation.",
    });
  }
});
const PluginConnectedAccountsHostAccessRequestV2Schema = PluginHostAccessCommonV2Schema.extend({
  capability: z.literal('connectedAccounts'),
  scope: PluginConnectedAccountsHostAccessScopeV2Schema,
}).strict();
const PluginSessionsHostAccessRequestV2Schema = PluginHostAccessCommonV2Schema.extend({
  capability: z.literal('sessions'),
  scope: z.object({
    access: uniqueNonEmptyArray(z.enum(['read', 'write', 'control'])),
    machineIds: uniqueNonEmptyArray(z.string().trim().min(1)).optional(),
    projectIds: uniqueNonEmptyArray(z.string().trim().min(1)).optional(),
  }).strict(),
}).strict();
const PluginSyncedStorageHostAccessRequestV2Schema = PluginHostAccessCommonV2Schema.extend({
  capability: z.literal('storage.synced'),
  scope: z.object({ enabled: z.literal(true) }).strict(),
}).strict();
const PluginMcpHostAccessRequestV2Schema = PluginHostAccessCommonV2Schema.extend({
  capability: z.literal('mcp'),
  scope: z.object({
    serverRefs: uniqueNonEmptyArray(PluginContributionReferenceV2Schema),
    operations: uniqueNonEmptyArray(z.enum(['listTools', 'callTools', 'discover'])),
  }).strict(),
}).strict();
const PluginOptionalHostAccessRequestVariantsV2 = [
  PluginSecretsHostAccessRequestV2Schema,
  PluginConnectedAccountsHostAccessRequestV2Schema,
  PluginSessionsHostAccessRequestV2Schema,
  PluginSyncedStorageHostAccessRequestV2Schema,
  PluginMcpHostAccessRequestV2Schema,
] as const;
const PluginHostAccessRequestVariantsV2 = [
  PluginHostAccessCommonV2Schema.extend({
    capability: z.literal('network'),
    scope: z.object({
      targets: uniqueNonEmptyArray(PluginNetworkTargetV2Schema),
      methods: uniqueNonEmptyArray(HttpMethodSchema).optional(),
      privateNetwork: z.boolean().optional(),
    }).strict(),
  }).strict(),
  PluginHostAccessCommonV2Schema.extend({
    capability: z.literal('network.intercept'),
    scope: z.object({ origins: uniqueNonEmptyArray(CanonicalHttpOriginSchema) }).strict(),
  }).strict(),
  PluginHostAccessCommonV2Schema.extend({
    capability: z.literal('network.client'),
    scope: z.object({
      targets: uniqueNonEmptyArray(PluginNetworkTargetV2Schema),
      transports: uniqueNonEmptyArray(z.enum(['websocket', 'webrtc'])),
    }).strict(),
  }).strict(),
  PluginHostAccessCommonV2Schema.extend({
    capability: z.literal('filesystem'),
    scope: z.object({
      locations: uniqueNonEmptyArray(z.union([
        z.object({ root: z.enum(['pluginData', 'workspace']), pathPrefix: z.string().min(1).optional() }).strict(),
        z.object({ root: z.literal('project'), projectId: z.string().min(1).optional(), pathPrefix: z.string().min(1).optional() }).strict(),
      ])),
      access: uniqueNonEmptyArray(z.enum(['read', 'write', 'delete'])),
    }).strict(),
  }).strict(),
  PluginHostAccessCommonV2Schema.extend({
    capability: z.literal('process'),
    scope: z.object({
      executables: uniqueNonEmptyArray(ManagedExecutableRefSchema),
      envKeys: uniqueNonEmptyArray(PluginEnvironmentKeySchema).max(MAX_PLUGIN_ENVIRONMENT_KEYS).optional(),
    }).strict(),
  }).strict(),
  PluginHostAccessCommonV2Schema.extend({
    capability: z.literal('environment'),
    scope: z.object({
      keys: uniqueNonEmptyArray(PluginEnvironmentKeySchema).max(MAX_PLUGIN_ENVIRONMENT_KEYS),
    }).strict(),
  }).strict(),
  PluginSecretsHostAccessRequestV2Schema,
  PluginConnectedAccountsHostAccessRequestV2Schema,
  PluginSessionsHostAccessRequestV2Schema,
  PluginHostAccessCommonV2Schema.extend({
    capability: z.literal('terminal'),
    scope: z.object({ operations: uniqueNonEmptyArray(z.enum(['open', 'send', 'resize', 'close'])) }).strict(),
  }).strict(),
  PluginHostAccessCommonV2Schema.extend({
    capability: z.literal('browser'),
    scope: z.object({
      operations: uniqueNonEmptyArray(z.enum(['read', 'navigate', 'interact', 'automate'])),
      origins: uniqueNonEmptyArray(CanonicalHttpOriginSchema).optional(),
    }).strict(),
  }).strict(),
  PluginHostAccessCommonV2Schema.extend({
    capability: z.literal('clipboard'),
    scope: z.object({ access: uniqueNonEmptyArray(z.enum(['read', 'write'])) }).strict(),
  }).strict(),
  PluginHostAccessCommonV2Schema.extend({
    capability: z.literal('externalLinks'),
    scope: z.object({ origins: uniqueNonEmptyArray(CanonicalHttpOriginSchema) }).strict(),
  }).strict(),
  PluginSyncedStorageHostAccessRequestV2Schema,
  PluginMcpHostAccessRequestV2Schema,
] as const;
export const PluginHostAccessRequestV2Schema = z.discriminatedUnion(
  'capability',
  PluginHostAccessRequestVariantsV2,
);
export type PluginHostAccessRequestV2 = z.infer<typeof PluginHostAccessRequestV2Schema>;
const PluginHostAccessAuthorizationClassByCapabilityV2 = {
  network: 'cooperativeDisclosure',
  'network.intercept': 'cooperativeDisclosure',
  'network.client': 'cooperativeDisclosure',
  filesystem: 'cooperativeDisclosure',
  process: 'cooperativeDisclosure',
  environment: 'cooperativeDisclosure',
  secrets: 'hostResourceSelection',
  connectedAccounts: 'hostResourceSelection',
  sessions: 'hostResourceSelection',
  terminal: 'presentIntentOrOs',
  browser: 'presentIntentOrOs',
  clipboard: 'presentIntentOrOs',
  externalLinks: 'presentIntentOrOs',
  'storage.synced': 'hostResourceSelection',
  mcp: 'hostResourceSelection',
} as const satisfies Record<
  PluginHostAccessRequestV2['capability'],
  'cooperativeDisclosure' | 'hostResourceSelection' | 'presentIntentOrOs'
>;
export const PLUGIN_HOST_ACCESS_CAPABILITY_CATALOG_V2 = Object.freeze(
  PluginHostAccessRequestVariantsV2.map((schema) => Object.freeze({
    capability: schema.shape.capability.value,
    authorizationClass: PluginHostAccessAuthorizationClassByCapabilityV2[schema.shape.capability.value],
    schema,
    reviewProjectionField: 'normalizedScope' as const,
  })),
);

export const PluginManifestHostAccessV2Schema = z.object({
  required: z.array(PluginHostAccessRequestV2Schema).default([]),
  optional: z.array(z.discriminatedUnion('capability', PluginOptionalHostAccessRequestVariantsV2)).default([]),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const [group, requests] of [['required', value.required], ['optional', value.optional]] as const) {
    requests.forEach((request, index) => {
      if (seen.has(request.id)) ctx.addIssue({ code: 'custom', path: [group, index, 'id'], message: 'Duplicate hostAccess request id.' });
      seen.add(request.id);
    });
  }
}).default({ required: [], optional: [] });
export type PluginManifestHostAccessV2 = z.infer<typeof PluginManifestHostAccessV2Schema>;

export const PluginManifestActivationV2Schema = z.object({
  events: z.array(z.object({ kind: z.literal('startup') }).strict()).default([]),
}).strict().optional();
export type PluginManifestActivationV2 = z.infer<typeof PluginManifestActivationV2Schema>;

export const PluginManifestV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: PluginIdSchema,
  version: z.string().trim().refine(
    (value) => semver.valid(value) === value,
    'Plugin manifest version must be a canonical semver version.',
  ),
  displayName: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  engines: PluginEnginesV2Schema,
  runtime: PluginRuntimeV2Schema,
  entrypoints: PluginEntrypointsV2Schema.optional(),
  activation: PluginManifestActivationV2Schema,
  hostAccess: PluginManifestHostAccessV2Schema,
  contributes: PluginContributesV2Schema,
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict().superRefine((manifest, ctx) => {
  const retiredKeys = new Map([
    ['uses', 'Plugin manifest runtime demand is contribution-derived; uses is not supported.'],
    ['declares', 'Plugin manifest capabilities are contribution-derived; declares is not supported.'],
    ['permissions', 'Plugin manifest host access must use hostAccess.required/optional.'],
    ['source', 'Plugin installation source is host-owned.'],
    ['activationEvents', 'Plugin activation events must use activation.events.'],
    ['marketplace', 'Marketplace review and source metadata are host-owned.'],
    ['targets', `Plugin manifest v2 uses entrypoints; targets.${'daemon'} is not supported.`],
    ['capabilities', 'Plugin manifest host access must use hostAccess.required/hostAccess.optional; capabilities permissions are not supported.'],
    ['contributions', 'Plugin manifest v2 uses contributes; flat contributions are not supported.'],
  ]);
  for (const [key, message] of retiredKeys) {
    if (hasOwn(manifest, key)) {
      rejectForbiddenKey(ctx, key, message);
    }
  }

});
export type PluginManifestV2 = z.input<typeof PluginManifestV2Schema>;
export type PluginManifest = z.input<typeof PluginManifestV2Schema>;
export type ParsedPluginManifestV2 = z.output<typeof PluginManifestV2Schema>;
