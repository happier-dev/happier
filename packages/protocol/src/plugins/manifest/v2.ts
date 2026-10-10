import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";
import semver from 'semver';

import { PluginOptionalStringSchema } from '../_shared.js';
import { CanonicalHttpOriginSchema } from '../../http/canonicalHttpOrigin.js';
import { CanonicalPluginNetworkHostSuffixSchema } from '../networkHostSuffix.js';
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
import { PluginDirectSecretDeclarationV1Schema } from '../contributions/settings.js';

export const PluginEnginesV2Schema = lazyZodSchema(() => z.object({
  happier: z.string().trim().min(1).refine(
    (value) => !/[x*]/i.test(value) && semver.validRange(value) !== null,
    'engines.happier must be a non-wildcard semver range.',
  ).optional(),
}).strict().optional());
export type PluginEnginesV2 = z.infer<typeof PluginEnginesV2Schema>;

export const PLUGIN_RUNTIME_API_VERSION = 1 as const;
const PluginAgentFactoryLocatorV1Schema = lazyZodSchema(() => z.object({
  module: z.string().regex(/^\.[/][A-Za-z0-9._/-]+$/u),
  export: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/u),
  runtimeApiVersion: z.literal(1),
  externalSessionsExport: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/u).optional(),
}).strict());
const PluginRuntimeAgentFactoryV1Schema = lazyZodSchema(() => z.object({
  localAgentId: asProtocolZod(PluginContributionLocalIdSchema),
  locator: PluginAgentFactoryLocatorV1Schema,
  normalizedModulePath: z.string().trim().min(1).max(16_384),
  loadMode: z.literal('immutable-js'),
}).strict());
export const PluginRuntimeV2Schema = lazyZodSchema(() => z.object({
  apiVersion: z.literal(PLUGIN_RUNTIME_API_VERSION),
  /** Publisher-validated factories in this exact packaged runtime. */
  agentFactories: z.array(PluginRuntimeAgentFactoryV1Schema).superRefine((factories, ctx) => {
    const ids = new Set<string>();
    factories.forEach((factory, index) => {
      if (ids.has(factory.localAgentId)) {
        ctx.addIssue({ code: 'custom', path: [index, 'localAgentId'], message: 'Duplicate runtime Agent factory.' });
      }
      ids.add(factory.localAgentId);
    });
  }).optional(),
}).strict());
export type PluginRuntimeV2 = z.infer<typeof PluginRuntimeV2Schema>;

export const PluginEntrypointV2Schema = lazyZodSchema(() => z.string().trim().min(1));
export type PluginEntrypointV2 = z.infer<typeof PluginEntrypointV2Schema>;

export const PluginEntrypointsV2Schema = lazyZodSchema(() => z.object({
  daemon: PluginEntrypointV2Schema.optional(),
  development: PluginEntrypointV2Schema.optional(),
}).strict());
export type PluginEntrypointsV2 = z.infer<typeof PluginEntrypointsV2Schema>;

/**
 * One optional package-owned brand mark. The local Resource identity keeps the
 * declaration inside its own plugin; byte admission validates the packaged
 * PNG separately from the manifest shape.
 */
export const PluginBrandV2Schema = lazyZodSchema(() => z.object({
  iconResourceId: asProtocolZod(PluginContributionLocalIdSchema),
  /** A single-color alpha glyph rendered in the host's foreground color. */
  monochrome: z.boolean().optional(),
}).strict());
export type PluginBrandV2 = z.infer<typeof PluginBrandV2Schema>;

/** Preference for the supplying installation; never an execution grant. */
export const PluginExecutionTargetV2Schema = lazyZodSchema(() => z.object({
  default: z.literal('installation'),
}).strict());
export type PluginExecutionTargetV2 = z.infer<typeof PluginExecutionTargetV2Schema>;

export { PluginLocalizedStringV2Schema, type PluginLocalizedStringV2 } from '../contributions/publicTypes.js';
const HttpMethodSchema = lazyZodSchema(() => z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']));
export const MAX_PLUGIN_ENVIRONMENT_KEYS = 64;
export const MAX_PLUGIN_ENVIRONMENT_KEY_LENGTH = 128;
const PluginEnvironmentKeySchema = lazyZodSchema(() => z.string()
  .min(1)
  .max(MAX_PLUGIN_ENVIRONMENT_KEY_LENGTH)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/));
export const PluginNetworkTargetV2Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixedOrigin'), origin: CanonicalHttpOriginSchema }).strict(),
  /**
   * One HTTPS host family, for a provider that issues its own endpoint inside
   * a domain it owns. The suffix owner defines the exact semantics: standard
   * port, DNS label boundary, normalized ASCII, and no wildcard.
   */
  z.object({
    kind: z.literal('httpsHostSuffix'),
    hostSuffix: CanonicalPluginNetworkHostSuffixSchema,
  }).strict(),
  z.object({ kind: z.literal('connectedAccountOrigin'), service: asProtocolZod(PluginContributionReferenceV2Schema) }).strict(),
  z.object({ kind: z.literal('scmProviderOrigin'), provider: asProtocolZod(PluginContributionReferenceV2Schema) }).strict(),
]));
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
const PluginHostAccessCommonV2Schema = lazyZodSchema(() => z.object({
  id: z.string().trim().min(1),
  reason: PluginLocalizedStringV2Schema,
}));
const PluginConnectedAccountsHostAccessScopeV2Schema = lazyZodSchema(() => z.object({
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
}));
const PluginConnectedAccountsHostAccessRequestV2Schema = lazyZodSchema(() => PluginHostAccessCommonV2Schema.extend({
  capability: z.literal('connectedAccounts'),
  scope: PluginConnectedAccountsHostAccessScopeV2Schema,
}).strict());
const PluginSessionsHostAccessRequestV2Schema = lazyZodSchema(() => PluginHostAccessCommonV2Schema.extend({
  capability: z.literal('sessions'),
  scope: z.object({
    access: uniqueNonEmptyArray(z.enum(['read', 'write', 'control'])),
    machineIds: uniqueNonEmptyArray(z.string().trim().min(1)).optional(),
    projectIds: uniqueNonEmptyArray(z.string().trim().min(1)).optional(),
  }).strict(),
}).strict());
const PluginAccountStorageHostAccessRequestV2Schema = lazyZodSchema(() => PluginHostAccessCommonV2Schema.extend({
  capability: z.literal('storage.account'),
  scope: z.object({ enabled: z.literal(true) }).strict(),
}).strict());
const PluginMcpHostAccessScopeV2Schema = lazyZodSchema(() => z.object({
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
}));
const PluginMcpHostAccessRequestV2Schema = lazyZodSchema(() => PluginHostAccessCommonV2Schema.extend({
  capability: z.literal('mcp'),
  scope: PluginMcpHostAccessScopeV2Schema,
}).strict());
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
export const PluginHostAccessRequestV2Schema = lazyZodSchema(() => z.discriminatedUnion(
  'capability',
  PluginHostAccessRequestVariantsV2,
));
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

export const PluginManifestHostAccessV2Schema = lazyZodSchema(() => z.object({
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
}).default({ required: [], optional: [] }));
export type PluginManifestHostAccessV2 = z.infer<typeof PluginManifestHostAccessV2Schema>;

export const PluginManifestActivationV2Schema = lazyZodSchema(() => z.object({
  events: z.array(z.object({ kind: z.literal('startup') }).strict()).default([]),
}).strict().optional());
export type PluginManifestActivationV2 = z.infer<typeof PluginManifestActivationV2Schema>;

function createPluginManifestV2Schema() {
  return z.object({
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
  executionTarget: PluginExecutionTargetV2Schema.optional(),
  activation: PluginManifestActivationV2Schema,
  hostAccess: PluginManifestHostAccessV2Schema,
  secrets: z.array(PluginDirectSecretDeclarationV1Schema).default([]),
  contributes: PluginContributesV2Schema,
  metadata: z.record(z.string(), PluginJsonValueV2Schema).optional(),
}).strict().superRefine((manifest, ctx) => {
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
}
type PluginManifestV2ShapeDefinition = ReturnType<typeof createPluginManifestV2Schema>['shape'];
export interface PluginManifestV2Shape extends PluginManifestV2ShapeDefinition {}
export const PluginManifestV2Schema: z.ZodObject<PluginManifestV2Shape, z.core.$strict> =
  lazyZodSchema(createPluginManifestV2Schema);
export type PluginManifestV2 = z.input<typeof PluginManifestV2Schema>;
export type PluginManifest = z.input<typeof PluginManifestV2Schema>;
export type ParsedPluginManifestV2 = z.output<typeof PluginManifestV2Schema>;

export type ResolvedPluginManifestHostAccessRequestV2 = Readonly<{
  request: PluginHostAccessRequestV2;
  required: boolean;
}>;

/** Targeted contributions obtain only the HostAccess ids named by their declaration. */
export function resolvePluginContributionHostAccessRequestsV2(input: Readonly<{
  manifest: Pick<ParsedPluginManifestV2, 'hostAccess'>;
  pluginId: string;
  contribution: Readonly<{ family: string; localId: string }>;
  requestIds?: readonly string[];
}>): readonly ResolvedPluginManifestHostAccessRequestV2[] {
  return Object.freeze((input.requestIds ?? []).map(requestId => {
    const required = input.manifest.hostAccess.required.find(request => request.id === requestId);
    const request = required ?? input.manifest.hostAccess.optional.find(candidate => candidate.id === requestId);
    if (!request) {
      const kind = input.contribution.family === 'actions' ? 'action' : input.contribution.family === 'hooks' ? 'hook' : 'resource';
      throw new Error(`Target ${kind} '${input.pluginId}/${input.contribution.family}/${input.contribution.localId}' references missing host access request '${requestId}'`);
    }
    return Object.freeze({ request, required: required !== undefined });
  }));
}

export type PluginActionConnectedAccountUseRequestV2 = Readonly<{
  request: Extract<PluginHostAccessRequestV2, { capability: 'connectedAccounts' }>;
  required: boolean;
}>;

/** Declaration projection only; optional scope authorization stays with the executing host. */
export function resolvePluginActionConnectedAccountUseRequestsV2(
  manifest: Pick<ParsedPluginManifestV2, 'id' | 'hostAccess' | 'contributes'>,
  actionId: string,
): readonly PluginActionConnectedAccountUseRequestV2[] | null {
  const actions = manifest.contributes.actions.filter(action => action.id === actionId);
  if (actions.length !== 1) return null;
  try {
    return Object.freeze(resolvePluginContributionHostAccessRequestsV2({ manifest, pluginId: manifest.id,
      contribution: { family: 'actions', localId: actionId }, requestIds: actions[0]!.hostAccess,
    }).flatMap(entry => entry.request.capability === 'connectedAccounts' && entry.request.scope.operations.includes('use')
      ? [Object.freeze({ request: entry.request, required: entry.required })] : []));
  } catch { return null; }
}
