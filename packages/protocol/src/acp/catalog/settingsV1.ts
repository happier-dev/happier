import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../../json/storedReadSchema.js';

import { ValueRefV1Schema, type ValueRefV1 } from '../../valueRefs/valueRefV1.js';
import { PluginAgentAcpStderrRulesV2Schema } from '../../plugins/contributions/agentAcpStderrRules.js';
import { PluginAgentAcpPermissionModeMappingV2Schema } from '../../plugins/contributions/agentAcpPermissionModeMapping.js';
import { PinnedArchiveAssetsByPlatformSchema, PinnedArchivePlatformSchema } from '../../installables/sourceKind.js';
import { RegistryProvenanceV1Schema } from '../../registries/registryItemsV1.js';
import { RegistryUpstreamV1Schema } from '../../registries/registryUpstreamV1.js';

const ACP_CATALOG_ID_REGEX = /^[a-z0-9][a-z0-9._-]*$/;
const ACP_ENV_KEY_REGEX = /^[A-Z_][A-Z0-9_]*$/;

const AcpCatalogIdV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1), z.regex(ACP_CATALOG_ID_REGEX, 'Invalid ACP catalog id')));
export const AcpEnvKeyV1Schema = lazyZodSchema(() => z.string().check(z.regex(ACP_ENV_KEY_REGEX, 'Invalid environment variable name')));

export const AcpCatalogAuthSupportV1Schema = lazyZodSchema(() => z.enum(['login_terminal', 'status_only', 'manual_only', 'unsupported']));
export type AcpCatalogAuthSupportV1 = z.infer<typeof AcpCatalogAuthSupportV1Schema>;

export const AcpCatalogSupportHintV1Schema = lazyZodSchema(() => z.enum(['unknown', 'yes', 'no']));
export type AcpCatalogSupportHintV1 = z.infer<typeof AcpCatalogSupportHintV1Schema>;


export const AcpCatalogCommandV1Schema = lazyZodSchema(() => z.object({
  command: z.string().check(z.minLength(1)),
  args: z._default(z.array(z.string()), []),
}));

export type AcpCatalogCommandV1 = z.infer<typeof AcpCatalogCommandV1Schema>;

export const AcpBackendAuthConfigV1Schema = lazyZodSchema(() => z.object({
  support: AcpCatalogAuthSupportV1Schema,
  machineLoginKey: z.optional(z.string().check(z.minLength(1))),
  docsUrl: z.optional(z.string().check(z.url())),
  loginCommand: z.optional(AcpCatalogCommandV1Schema),
  envVars: z.optional(z.array(AcpEnvKeyV1Schema)),
}));

export type AcpBackendAuthConfigV1 = z.infer<typeof AcpBackendAuthConfigV1Schema>;

export const AcpBackendCapabilitiesV1Schema = lazyZodSchema(() => z.object({
  supportsLoadSession: z._default(z.boolean(), false),
  supportsModes: z._default(AcpCatalogSupportHintV1Schema, 'unknown'),
  supportsModels: z._default(AcpCatalogSupportHintV1Schema, 'unknown'),
  supportsConfigOptions: z._default(AcpCatalogSupportHintV1Schema, 'unknown'),
  promptImageSupport: z._default(AcpCatalogSupportHintV1Schema, 'unknown'),
}));

export type AcpBackendCapabilitiesV1 = z.infer<typeof AcpBackendCapabilitiesV1Schema>;

export const AcpConfiguredRuntimeV1Schema = lazyZodSchema(() => z.strictObject({
  stderrRules: z.optional(PluginAgentAcpStderrRulesV2Schema),
  permissionModeMapping: z.optional(PluginAgentAcpPermissionModeMappingV2Schema),
}));
export type AcpConfiguredRuntimeV1 = z.infer<typeof AcpConfiguredRuntimeV1Schema>;

/** Retained authored status metadata has no executable authority; the predecessor did not run it for configured Agents. */
export const AcpBackendCompatibilityV1Schema = lazyZodSchema(() => z.strictObject({
  source: z.literal('acp-catalog-v2'),
  authStatus: z.strictObject({
    statusCommand: z.optional(z.array(z.string())),
    parser: z.optional(z.enum(['unknown', 'exitCodeOnly', 'stdoutNonEmpty', 'kiroWhoamiJson'])),
  }),
}));

export const AcpBackendLaunchV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('command'), command: z.string().check(z.minLength(1)), args: z._default(z.array(z.string()), []) }),
  z.strictObject({ kind: z.literal('npm'), package: z.string().check(z.minLength(1)), version: z.string().check(z.minLength(1)),
    bin: z.optional(z.string().check(z.minLength(1))), args: z._default(z.array(z.string()), []) }),
  z.strictObject({ kind: z.literal('archive'), version: z.string().check(z.minLength(1)),
    assetsByPlatform: PinnedArchiveAssetsByPlatformSchema, args: z._default(z.array(z.string()), []),
    envByPlatform: z.optional(z.partialRecord(PinnedArchivePlatformSchema, z.record(z.string(), z.string()))) }),
  z.strictObject({ kind: z.literal('uv'), package: z.string().check(z.minLength(1)), version: z.string().check(z.minLength(1)),
    command: z.optional(z.string().check(z.minLength(1))), args: z._default(z.array(z.string()), []) }),
]));
export type AcpBackendLaunchV1 = z.infer<typeof AcpBackendLaunchV1Schema>;

export const AcpBackendOriginV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('registry'),
  provenance: RegistryProvenanceV1Schema,
  iconUrl: z.optional(z.string()),
  publisher: z.optional(z.string()),
  license: z.optional(z.string()),
  repository: z.optional(z.string()),
  website: z.optional(z.string()),
  upstream: z.optional(RegistryUpstreamV1Schema),
}));
export type AcpBackendOriginV1 = Readonly<z.infer<typeof AcpBackendOriginV1Schema>>;

export const AcpBackendDefinitionV1Schema = lazyZodSchema(() => z.strictObject({
  id: AcpCatalogIdV1Schema,
  name: AcpCatalogIdV1Schema,
  title: z.string().check(z.minLength(1)),
  description: z.optional(z.string().check(z.minLength(1))),
  launch: AcpBackendLaunchV1Schema,
  origin: z.optional(AcpBackendOriginV1Schema),
  env: z._default(z.record(AcpEnvKeyV1Schema, ValueRefV1Schema), {}),
  auth: z.optional(AcpBackendAuthConfigV1Schema),
  runtime: z.optional(AcpConfiguredRuntimeV1Schema),
  compatibility: z.optional(AcpBackendCompatibilityV1Schema),
  defaultMode: z.optional(z.string().check(z.minLength(1))),
  defaultModel: z.optional(z.string().check(z.minLength(1))),
  capabilities: z._default(AcpBackendCapabilitiesV1Schema, {
    supportsLoadSession: false,
    supportsModes: 'unknown',
    supportsModels: 'unknown',
    supportsConfigOptions: 'unknown',
    promptImageSupport: 'unknown',
  }),
  createdAt: z.number(),
  updatedAt: z.number(),
}));

export type AcpBackendDefinitionV1 = z.infer<typeof AcpBackendDefinitionV1Schema>;

/** Persistence ingress only: fold the released command/args carrier into the one current launch. */
export function foldStoredAcpBackendLaunchV1(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.hasOwn(raw, 'launch')) return raw;
  const { command, args, ...fields } = raw as Record<string, unknown>;
  return { ...fields, launch: { kind: 'command', command, ...(args === undefined ? {} : { args }) } };
}

defineStoredReadProjection(AcpBackendDefinitionV1Schema, () => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(foldStoredAcpBackendLaunchV1), createStoredReadSchema(lazyZodSchema(() => z.extend(AcpBackendDefinitionV1Schema, {})))));
export const AcpBackendDefinitionV1StoredSchema = createStoredReadSchema(AcpBackendDefinitionV1Schema);

export const AcpCatalogSettingsV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw;
  }), z
    .object({
      v: z._default(z.literal(2), 2),
      backends: z._default(z.array(AcpBackendDefinitionV1Schema), []),
    }).check(z.superRefine((value, ctx) => {
      const backendIds = new Set<string>();
      const backendNames = new Set<string>();
      for (let i = 0; i < value.backends.length; i++) {
        const backend = value.backends[i];
        if (backendIds.has(backend.id)) {
          ctx.addIssue({ code: 'custom', message: `Duplicate ACP backend id: ${backend.id}`, path: ['backends', i, 'id'] });
        } else {
          backendIds.add(backend.id);
        }
        if (backendNames.has(backend.name)) {
          ctx.addIssue({ code: 'custom', message: `Duplicate ACP backend name: ${backend.name}`, path: ['backends', i, 'name'] });
        } else {
          backendNames.add(backend.name);
        }
      }
    }))));

export type AcpCatalogSettingsV1 = z.infer<typeof AcpCatalogSettingsV1Schema>;
export const AcpCatalogSettingsV1StoredSchema = createStoredReadSchema(AcpCatalogSettingsV1Schema);

export type AcpCatalogEnvValueRefV1 = ValueRefV1;
