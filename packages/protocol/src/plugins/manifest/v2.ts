import { z } from 'zod';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";
import semver from 'semver';

import { PluginOptionalStringSchema } from '../_shared.js';
import { CanonicalHttpOriginSchema } from '../canonicalHttpOrigin.js';
import { PluginContributesV2Schema } from '../contributions/v2.js';
import { PluginDeclaredExecutableRefSchema } from '../contributions/agentAcpTransport.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginIdSchema } from '../pluginId.js';
import {
  PluginConnectedAccountMaterializationKindsSchema,
} from '../../connect/connectedAccountPurposes.js';
import {
  PluginContributionReferenceV2Schema,
  PluginJsonValueV2Schema,
  PluginLocalizedStringV2Schema,
} from '../contributions/publicTypes.js';
import {
  PluginDirectSecretDeclarationV1Schema,
  readPluginSettingSecretCustody,
} from '../contributions/settings.js';

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
  ).optional(),
}).strict().optional();
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

/**
 * One optional package-owned brand mark. The local Resource identity keeps the
 * declaration inside its own plugin; byte admission validates the packaged
 * PNG separately from the manifest shape.
 */
export const PluginBrandV2Schema = z.object({
  iconResourceId: asProtocolZod(PluginContributionLocalIdSchema),
}).strict();
export type PluginBrandV2 = z.infer<typeof PluginBrandV2Schema>;

export { PluginLocalizedStringV2Schema, type PluginLocalizedStringV2 } from '../contributions/publicTypes.js';
const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
export const MAX_PLUGIN_ENVIRONMENT_KEYS = 64;
export const MAX_PLUGIN_ENVIRONMENT_KEY_LENGTH = 128;
const PluginEnvironmentKeySchema = z.string()
  .min(1)
  .max(MAX_PLUGIN_ENVIRONMENT_KEY_LENGTH)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export const PluginNetworkTargetV2Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixedOrigin'), origin: CanonicalHttpOriginSchema }).strict(),
  z.object({ kind: z.literal('connectedAccountOrigin'), service: asProtocolZod(PluginContributionReferenceV2Schema) }).strict(),
  z.object({ kind: z.literal('scmProviderOrigin'), provider: asProtocolZod(PluginContributionReferenceV2Schema) }).strict(),
]);
export type PluginNetworkTargetV2 = z.infer<typeof PluginNetworkTargetV2Schema>;
function uniqueArray<T extends z.ZodTypeAny>(schema: T): z.ZodArray<T> {
  return z.array(schema).superRefine((values, ctx) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      const key = JSON.stringify(value);
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: [index], message: 'Duplicate set entry.' });
      seen.add(key);
    });
  });
}
function uniqueNonEmptyArray<T extends z.ZodTypeAny>(schema: T): z.ZodArray<T> {
  return uniqueArray(schema).min(1);
}
const PluginHostAccessCommonV2Schema = z.object({
  id: z.string().trim().min(1),
  reason: PluginLocalizedStringV2Schema,
});
const PluginConnectedAccountsHostAccessScopeV2Schema = z.object({
  serviceRefs: uniqueNonEmptyArray(asProtocolZod(PluginContributionReferenceV2Schema)),
  accountScopes: uniqueNonEmptyArray(z.string().trim().min(1)).optional(),
  operations: uniqueNonEmptyArray(z.enum(['select', 'use'])),
  materializationKinds: PluginConnectedAccountMaterializationKindsSchema.optional(),
}).strict().meta({
  if: {
    properties: { materializationKinds: {} },
    required: ['materializationKinds'],
  },
  then: {
    properties: {
      operations: { type: 'array', contains: { const: 'use' } },
    },
  },
}).superRefine((scope, context) => {
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
const PluginAccountStorageHostAccessRequestV2Schema = PluginHostAccessCommonV2Schema.extend({
  capability: z.literal('storage.account'),
  scope: z.object({ enabled: z.literal(true) }).strict(),
}).strict();
const PluginMcpHostAccessScopeV2Schema = z.object({
  serverRefs: uniqueArray(asProtocolZod(PluginContributionReferenceV2Schema)).default([]),
  discoverySourceRefs: uniqueArray(asProtocolZod(PluginContributionReferenceV2Schema)).default([]),
  operations: uniqueNonEmptyArray(z.enum(['listTools', 'callTools', 'discover'])),
}).strict().meta({
  allOf: [{
    if: {
      properties: {
        operations: { type: 'array', contains: { enum: ['listTools', 'callTools'] } },
      },
    },
    then: {
      properties: { serverRefs: { type: 'array', minItems: 1 } },
      required: ['serverRefs'],
    },
  }, {
    if: {
      properties: { operations: { type: 'array', contains: { const: 'discover' } } },
    },
    then: {
      properties: { discoverySourceRefs: { type: 'array', minItems: 1 } },
      required: ['discoverySourceRefs'],
    },
  }],
}).superRefine((scope, context) => {
  const usesServers = scope.operations.some((operation) => (
    operation === 'listTools' || operation === 'callTools'
  ));
  if (usesServers && scope.serverRefs.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['serverRefs'],
      message: 'MCP server operations require at least one server reference.',
    });
  }
  if (scope.operations.includes('discover') && scope.discoverySourceRefs.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['discoverySourceRefs'],
      message: 'MCP discovery requires at least one discovery-source reference.',
    });
  }
});
const PluginMcpHostAccessRequestV2Schema = PluginHostAccessCommonV2Schema.extend({
  capability: z.literal('mcp'),
  scope: PluginMcpHostAccessScopeV2Schema,
}).strict();
const PluginOptionalHostAccessRequestVariantsV2 = [
  PluginConnectedAccountsHostAccessRequestV2Schema,
  PluginSessionsHostAccessRequestV2Schema,
  PluginAccountStorageHostAccessRequestV2Schema,
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
    capability: z.literal('network.client'),
    scope: z.object({
      targets: uniqueNonEmptyArray(PluginNetworkTargetV2Schema),
      transports: uniqueNonEmptyArray(z.enum(['websocket', 'webrtc'])),
      privateNetwork: z.boolean().default(false),
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
      executables: uniqueNonEmptyArray(PluginDeclaredExecutableRefSchema),
      envKeys: uniqueNonEmptyArray(PluginEnvironmentKeySchema).max(MAX_PLUGIN_ENVIRONMENT_KEYS).optional(),
    }).strict(),
  }).strict(),
  PluginHostAccessCommonV2Schema.extend({
    capability: z.literal('environment'),
    scope: z.object({
      keys: uniqueNonEmptyArray(PluginEnvironmentKeySchema).max(MAX_PLUGIN_ENVIRONMENT_KEYS),
    }).strict(),
  }).strict(),
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
  PluginAccountStorageHostAccessRequestV2Schema,
  PluginMcpHostAccessRequestV2Schema,
] as const;
export const PluginHostAccessRequestV2Schema = z.discriminatedUnion(
  'capability',
  PluginHostAccessRequestVariantsV2,
);
export type PluginHostAccessRequestV2 = z.infer<typeof PluginHostAccessRequestV2Schema>;
const PluginHostAccessAuthorizationClassByCapabilityV2 = {
  network: 'cooperativeDisclosure',
  'network.client': 'cooperativeDisclosure',
  filesystem: 'cooperativeDisclosure',
  process: 'cooperativeDisclosure',
  environment: 'cooperativeDisclosure',
  connectedAccounts: 'hostResourceSelection',
  sessions: 'hostResourceSelection',
  terminal: 'presentIntentOrOs',
  browser: 'presentIntentOrOs',
  clipboard: 'presentIntentOrOs',
  externalLinks: 'presentIntentOrOs',
  'storage.account': 'hostResourceSelection',
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

type DeclaredSettingsFieldIdentity = Readonly<{
  id: string;
  scope: 'account' | 'daemon';
  path: readonly (string | number)[];
}>;

type DeclaredSecretIdentity = Readonly<{
  id: string;
  custody: 'account' | 'daemon';
  path: readonly (string | number)[];
}>;

function addPluginSettingsFieldIdentityConflict(
  ctx: z.RefinementCtx,
  current: DeclaredSettingsFieldIdentity | DeclaredSecretIdentity,
  existing: DeclaredSettingsFieldIdentity | DeclaredSecretIdentity,
  kind: 'sameScope' | 'pluginGlobalSecret',
): void {
  const custodyDetails = 'custody' in current
    ? ` (${current.custody})`
    : '';
  ctx.addIssue({
    code: 'custom',
    path: [...current.path],
    message: `plugin_settings_field_id_conflict: '${current.id}' conflicts with ${kind} declaration at ${existing.path.join('.')}${custodyDetails}.`,
  });
}

export const PluginManifestV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: asProtocolZod(PluginIdSchema),
  version: z.string().trim().refine(
    (value) => semver.valid(value) === value,
    'Plugin manifest version must be a canonical semver version.',
  ),
  displayName: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema.optional(),
  engines: PluginEnginesV2Schema,
  runtime: PluginRuntimeV2Schema,
  entrypoints: PluginEntrypointsV2Schema.optional(),
  brand: PluginBrandV2Schema.optional(),
  activation: PluginManifestActivationV2Schema,
  hostAccess: PluginManifestHostAccessV2Schema,
  secrets: z.array(PluginDirectSecretDeclarationV1Schema).default([]),
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

  const nonSecretFields: DeclaredSettingsFieldIdentity[] = [];
  const secrets: DeclaredSecretIdentity[] = [];
  manifest.contributes.settings.forEach((contribution, contributionIndex) => {
    contribution.fields.forEach((field, fieldIndex) => {
      const path = ['contributes', 'settings', contributionIndex, 'fields', fieldIndex, 'id'] as const;
      const custody = readPluginSettingSecretCustody(field.secret);
      if (custody !== null) {
        secrets.push({ id: field.id, custody, path });
      } else {
        nonSecretFields.push({ id: field.id, scope: contribution.scope, path });
      }
    });
  });
  manifest.secrets.forEach((secret, secretIndex) => {
    secrets.push({
      id: secret.id,
      custody: secret.custody,
      path: ['secrets', secretIndex, 'id'],
    });
  });

  const nonSecretByScope = new Map<string, DeclaredSettingsFieldIdentity>();
  const nonSecretById = new Map<string, DeclaredSettingsFieldIdentity>();
  for (const field of nonSecretFields) {
    const scopeKey = `${field.scope}\u0000${field.id}`;
    const sameScope = nonSecretByScope.get(scopeKey);
    if (sameScope) {
      addPluginSettingsFieldIdentityConflict(ctx, field, sameScope, 'sameScope');
    } else {
      nonSecretByScope.set(scopeKey, field);
    }
    if (!nonSecretById.has(field.id)) nonSecretById.set(field.id, field);
  }
  const secretById = new Map<string, DeclaredSecretIdentity>();
  for (const secret of secrets) {
    const sameSecret = secretById.get(secret.id);
    if (sameSecret) {
      addPluginSettingsFieldIdentityConflict(ctx, secret, sameSecret, 'pluginGlobalSecret');
      continue;
    }
    secretById.set(secret.id, secret);
    const nonSecret = nonSecretById.get(secret.id);
    if (nonSecret) {
      addPluginSettingsFieldIdentityConflict(ctx, secret, nonSecret, 'pluginGlobalSecret');
    }
  }

  manifest.contributes.voiceProviders.forEach((provider, providerIndex) => {
    const seenConnectedServices = new Set<string>();
    provider.credentials?.sources.forEach((source, sourceIndex) => {
      if (source.kind !== 'connectedAccount') return;
      const service = typeof source.service === 'string'
        ? { pluginId: manifest.id, localId: source.service }
        : source.service;
      const key = `${service.pluginId}\0${service.localId}`;
      if (seenConnectedServices.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [
            'contributes',
            'voiceProviders',
            providerIndex,
            'credentials',
            'sources',
            sourceIndex,
            'service',
          ],
          message: 'Voice Connected Account alternatives must be unique after qualification.',
        });
      }
      seenConnectedServices.add(key);
    });
  });

});
export type PluginManifestV2 = z.input<typeof PluginManifestV2Schema>;
export type PluginManifest = z.input<typeof PluginManifestV2Schema>;
export type ParsedPluginManifestV2 = z.output<typeof PluginManifestV2Schema>;
