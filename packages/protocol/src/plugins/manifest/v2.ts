import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";
import semver from 'semver';
import { PluginEnginesV2Schema } from './engines.js';
export { PluginEnginesV2Schema, type PluginEnginesV2 } from './engines.js';

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

export const PLUGIN_RUNTIME_API_VERSION = 1 as const;
const PluginAgentFactoryLocatorV1Schema = lazyZodSchema(() => z.strictObject({
  module: z.string().check(z.regex(/^\.[/][A-Za-z0-9._/-]+$/u)),
  export: z.string().check(z.regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/u)),
  runtimeApiVersion: z.literal(1),
  externalSessionsExport: z.optional(z.string().check(z.regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/u))),
}));
const PluginRuntimeAgentFactoryV1Schema = lazyZodSchema(() => z.strictObject({
  localAgentId: asProtocolZod(PluginContributionLocalIdSchema),
  locator: PluginAgentFactoryLocatorV1Schema,
  normalizedModulePath: z.string().check(z.trim(), z.minLength(1), z.maxLength(16_384)),
  loadMode: z.literal('immutable-js'),
}));
export const PluginRuntimeV2Schema = lazyZodSchema(() => z.strictObject({
  apiVersion: z.literal(PLUGIN_RUNTIME_API_VERSION),
  /** Publisher-validated factories in this exact packaged runtime. */
  agentFactories: z.optional(z.array(PluginRuntimeAgentFactoryV1Schema).check(z.superRefine((factories, ctx) => {
    const ids = new Set<string>();
    factories.forEach((factory, index) => {
      if (ids.has(factory.localAgentId)) {
        ctx.addIssue({ code: 'custom', path: [index, 'localAgentId'], message: 'Duplicate runtime Agent factory.' });
      }
      ids.add(factory.localAgentId);
    });
  }))),
}));
export type PluginRuntimeV2 = z.infer<typeof PluginRuntimeV2Schema>;

export const PluginEntrypointV2Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
export type PluginEntrypointV2 = z.infer<typeof PluginEntrypointV2Schema>;

export const PluginEntrypointsV2Schema = lazyZodSchema(() => z.strictObject({
  daemon: z.optional(PluginEntrypointV2Schema),
  development: z.optional(PluginEntrypointV2Schema),
}));
export type PluginEntrypointsV2 = z.infer<typeof PluginEntrypointsV2Schema>;

/**
 * One optional package-owned brand mark. The local Resource identity keeps the
 * declaration inside its own plugin; byte admission validates the packaged
 * PNG separately from the manifest shape.
 */
export const PluginBrandV2Schema = lazyZodSchema(() => z.strictObject({
  iconResourceId: asProtocolZod(PluginContributionLocalIdSchema),
  /** A single-color alpha glyph rendered in the host's foreground color. */
  monochrome: z.optional(z.boolean()),
}));
export type PluginBrandV2 = z.infer<typeof PluginBrandV2Schema>;

/** Run-on preferences; omitted autoPick enables automatic placement, never execution authority. */
export const PluginExecutionTargetV2Schema = lazyZodSchema(() => z.strictObject({
  default: z.optional(z.literal('installation')),
  /** False keeps the explicit-choice flow when several Machines are eligible. */
  autoPick: z.optional(z.boolean()),
}));
export type PluginExecutionTargetV2 = z.infer<typeof PluginExecutionTargetV2Schema>;

export { PluginLocalizedStringV2Schema, type PluginLocalizedStringV2 } from '../contributions/publicTypes.js';
const HttpMethodSchema = lazyZodSchema(() => z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']));
export const MAX_PLUGIN_ENVIRONMENT_KEYS = 64;
export const MAX_PLUGIN_ENVIRONMENT_KEY_LENGTH = 128;
const PluginEnvironmentKeySchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(MAX_PLUGIN_ENVIRONMENT_KEY_LENGTH), z.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)));
export const PluginNetworkTargetV2Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fixedOrigin'), origin: CanonicalHttpOriginSchema }),
  /**
   * One HTTPS host family, for a provider that issues its own endpoint inside
   * a domain it owns. The suffix owner defines the exact semantics: standard
   * port, DNS label boundary, normalized ASCII, and no wildcard.
   */
  z.strictObject({
    kind: z.literal('httpsHostSuffix'),
    hostSuffix: CanonicalPluginNetworkHostSuffixSchema,
  }),
  z.strictObject({ kind: z.literal('connectedAccountOrigin'), service: asProtocolZod(PluginContributionReferenceV2Schema) }),
  z.strictObject({ kind: z.literal('scmProviderOrigin'), provider: asProtocolZod(PluginContributionReferenceV2Schema) }),
]));
export type PluginNetworkTargetV2 = z.infer<typeof PluginNetworkTargetV2Schema>;
function uniqueArray<T extends z.ZodMiniType>(schema: T): z.ZodMiniArray<T> {
  return z.array(schema).check(z.superRefine((values, ctx) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      const key = JSON.stringify(value);
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: [index], message: 'Duplicate set entry.' });
      seen.add(key);
    });
  }));
}
function uniqueNonEmptyArray<T extends z.ZodMiniType>(schema: T): z.ZodMiniArray<T> {
  return uniqueArray(schema).check(z.minLength(1));
}
const PluginHostAccessCommonV2Schema = lazyZodSchema(() => z.object({
  id: z.string().check(z.trim(), z.minLength(1)),
  reason: PluginLocalizedStringV2Schema,
}));
const PluginConnectedAccountsHostAccessScopeV2Schema = lazyZodSchema(() => z.strictObject({
  serviceRefs: uniqueNonEmptyArray(asProtocolZod(PluginContributionReferenceV2Schema)),
  accountScopes: z.optional(uniqueNonEmptyArray(z.string().check(z.trim(), z.minLength(1)))),
  operations: uniqueNonEmptyArray(z.enum(['select', 'use'])),
  materializationKinds: z.optional(PluginConnectedAccountMaterializationKindsSchema),
}).check(z.meta({
  if: {
    properties: { materializationKinds: {} },
    required: ['materializationKinds'],
  },
  then: {
    properties: {
      operations: { type: 'array', contains: { const: 'use' } },
    },
  },
}), z.superRefine((scope, context) => {
  if (scope.materializationKinds !== undefined && !scope.operations.includes('use')) {
    context.addIssue({
      code: 'custom',
      path: ['materializationKinds'],
      message: "Connected Account materialization kinds require the 'use' operation.",
    });
  }
})));
const PluginConnectedAccountsHostAccessRequestV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginHostAccessCommonV2Schema, {
  capability: z.literal('connectedAccounts'),
  scope: PluginConnectedAccountsHostAccessScopeV2Schema,
})));
const PluginSessionsHostAccessRequestV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginHostAccessCommonV2Schema, {
  capability: z.literal('sessions'),
  scope: z.strictObject({
    access: uniqueNonEmptyArray(z.enum(['read', 'write', 'control'])),
    machineIds: z.optional(uniqueNonEmptyArray(z.string().check(z.trim(), z.minLength(1)))),
    projectIds: z.optional(uniqueNonEmptyArray(z.string().check(z.trim(), z.minLength(1)))),
  }),
})));
const PluginAccountStorageHostAccessRequestV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginHostAccessCommonV2Schema, {
  capability: z.literal('storage.account'),
  scope: z.strictObject({ enabled: z.literal(true) }),
})));
const PluginMcpHostAccessScopeV2Schema = lazyZodSchema(() => z.strictObject({
  serverRefs: z._default(uniqueArray(asProtocolZod(PluginContributionReferenceV2Schema)), []),
  discoverySourceRefs: z._default(uniqueArray(asProtocolZod(PluginContributionReferenceV2Schema)), []),
  operations: uniqueNonEmptyArray(z.enum(['listTools', 'callTools', 'discover'])),
}).check(z.meta({
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
}), z.superRefine((scope, context) => {
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
})));
const PluginMcpHostAccessRequestV2Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginHostAccessCommonV2Schema, {
  capability: z.literal('mcp'),
  scope: PluginMcpHostAccessScopeV2Schema,
})));
const PluginOptionalHostAccessRequestVariantsV2 = [
  PluginConnectedAccountsHostAccessRequestV2Schema,
  PluginSessionsHostAccessRequestV2Schema,
  PluginAccountStorageHostAccessRequestV2Schema,
  PluginMcpHostAccessRequestV2Schema,
] as const;
const PluginHostAccessRequestVariantsV2 = [
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginHostAccessCommonV2Schema, {
    capability: z.literal('network'),
    scope: z.strictObject({
      targets: uniqueNonEmptyArray(PluginNetworkTargetV2Schema),
      methods: z.optional(uniqueNonEmptyArray(HttpMethodSchema)),
      privateNetwork: z.optional(z.boolean()),
    }),
  }))),
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginHostAccessCommonV2Schema, {
    capability: z.literal('network.client'),
    scope: z.strictObject({
      targets: uniqueNonEmptyArray(PluginNetworkTargetV2Schema),
      transports: uniqueNonEmptyArray(z.enum(['websocket', 'webrtc'])),
      privateNetwork: z._default(z.boolean(), false),
    }),
  }))),
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginHostAccessCommonV2Schema, {
    capability: z.literal('filesystem'),
    scope: z.strictObject({
      locations: uniqueNonEmptyArray(z.union([
        z.strictObject({ root: z.enum(['pluginData', 'workspace']), pathPrefix: z.optional(z.string().check(z.minLength(1))) }),
        z.strictObject({ root: z.literal('project'), projectId: z.optional(z.string().check(z.minLength(1))), pathPrefix: z.optional(z.string().check(z.minLength(1))) }),
      ])),
      access: uniqueNonEmptyArray(z.enum(['read', 'write', 'delete'])),
    }),
  }))),
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginHostAccessCommonV2Schema, {
    capability: z.literal('process'),
    scope: z.strictObject({
      executables: uniqueNonEmptyArray(PluginDeclaredExecutableRefSchema),
      envKeys: z.optional(uniqueNonEmptyArray(PluginEnvironmentKeySchema).check(z.maxLength(MAX_PLUGIN_ENVIRONMENT_KEYS))),
    }),
  }))),
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginHostAccessCommonV2Schema, {
    capability: z.literal('environment'),
    scope: z.strictObject({
      keys: uniqueNonEmptyArray(PluginEnvironmentKeySchema).check(z.maxLength(MAX_PLUGIN_ENVIRONMENT_KEYS)),
    }),
  }))),
  PluginConnectedAccountsHostAccessRequestV2Schema,
  PluginSessionsHostAccessRequestV2Schema,
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginHostAccessCommonV2Schema, {
    capability: z.literal('terminal'),
    scope: z.strictObject({ operations: uniqueNonEmptyArray(z.enum(['open', 'send', 'resize', 'close'])) }),
  }))),
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginHostAccessCommonV2Schema, {
    capability: z.literal('browser'),
    scope: z.strictObject({
      operations: uniqueNonEmptyArray(z.enum(['read', 'navigate', 'interact', 'automate'])),
      origins: z.optional(uniqueNonEmptyArray(CanonicalHttpOriginSchema)),
    }),
  }))),
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginHostAccessCommonV2Schema, {
    capability: z.literal('clipboard'),
    scope: z.strictObject({ access: uniqueNonEmptyArray(z.enum(['read', 'write'])) }),
  }))),
  lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginHostAccessCommonV2Schema, {
    capability: z.literal('externalLinks'),
    scope: z.strictObject({ origins: uniqueNonEmptyArray(CanonicalHttpOriginSchema) }),
  }))),
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
  PluginHostAccessRequestVariantsV2.map((schema) => {
    const capability = schema.shape.capability._zod.def.values[0]!;
    return Object.freeze({
      capability,
      authorizationClass: PluginHostAccessAuthorizationClassByCapabilityV2[capability],
      schema,
      reviewProjectionField: 'normalizedScope' as const,
    });
  }),
);

export const PluginManifestHostAccessV2Schema = lazyZodSchema(() => z._default(z.strictObject({
  required: z._default(z.array(PluginHostAccessRequestV2Schema), []),
  optional: z._default(z.array(z.discriminatedUnion('capability', PluginOptionalHostAccessRequestVariantsV2)), []),
}).check(z.superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const [group, requests] of [['required', value.required], ['optional', value.optional]] as const) {
    requests.forEach((request, index) => {
      if (seen.has(request.id)) ctx.addIssue({ code: 'custom', path: [group, index, 'id'], message: 'Duplicate hostAccess request id.' });
      seen.add(request.id);
    });
  }
})), { required: [], optional: [] }));
export type PluginManifestHostAccessV2 = z.infer<typeof PluginManifestHostAccessV2Schema>;

export const PluginManifestActivationV2Schema = lazyZodSchema(() => z.optional(z.strictObject({
  events: z._default(z.array(z.strictObject({ kind: z.literal('startup') })), []),
  /** A declaration-only positive demand; plugin domain rules still run after activation. */
  configuration: z.optional(z.strictObject({
    accountCollections: z.optional(z.array(z.strictObject({
      pluginId: asProtocolZod(PluginIdSchema),
      collectionId: asProtocolZod(PluginContributionLocalIdSchema),
    })).check(z.minLength(1))),
    automationEventSources: z.optional(z.literal(true)),
  }).check(z.refine(value => Boolean(value.accountCollections?.length || value.automationEventSources),
    'Configuration activation requires a declared demand source.'))),
})));
export type PluginManifestActivationV2 = z.infer<typeof PluginManifestActivationV2Schema>;

function createPluginManifestV2Schema() {
  return z.strictObject({
  schemaVersion: z.literal(2),
  id: asProtocolZod(PluginIdSchema),
  version: z.string().check(z.trim(), z.refine((value) => semver.valid(value) === value, 'Plugin manifest version must be a canonical semver version.')),
  displayName: PluginLocalizedStringV2Schema,
  description: z.optional(PluginLocalizedStringV2Schema),
  engines: PluginEnginesV2Schema,
  runtime: PluginRuntimeV2Schema,
  entrypoints: z.optional(PluginEntrypointsV2Schema),
  brand: z.optional(PluginBrandV2Schema),
  executionTarget: z.optional(PluginExecutionTargetV2Schema),
  activation: PluginManifestActivationV2Schema,
  hostAccess: PluginManifestHostAccessV2Schema,
  secrets: z._default(z.array(PluginDirectSecretDeclarationV1Schema), []),
  contributes: PluginContributesV2Schema,
  metadata: z.optional(z.record(z.string(), PluginJsonValueV2Schema)),
}).check(z.superRefine((manifest, ctx) => {
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

}));
}
type PluginManifestV2ShapeDefinition = ReturnType<typeof createPluginManifestV2Schema>['shape'];
export interface PluginManifestV2Shape extends PluginManifestV2ShapeDefinition {}
export const PluginManifestV2Schema: z.ZodMiniObject<PluginManifestV2Shape, z.core.$strict> =
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
