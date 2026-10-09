import { z } from 'zod';
import * as mini from 'zod/mini';
import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginContributionIdentityV1Schema, PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { ManagedExecutableRefSchema } from './agentAcpTransport.js';
import { ProjectEnvironmentSelectionV1Schema, ProjectNativeFilePathV1Schema } from '../../workspaces/projectSetup/projectManifestV1.js';

export const PROJECT_NATIVE_ADAPTER_ROLES_V1 = ['detect', 'resolveCommand', 'produceEnvironment', 'nativeServiceLifecycle'] as const;
export type ProjectNativeAdapterRoleV1 = typeof PROJECT_NATIVE_ADAPTER_ROLES_V1[number];

export type BuiltinNativeEnvironmentAdapterV1 = Readonly<{
    id: 'mise'; title: string;
    platform: 'linux'; nativeVersion: string;
    globalEnvironment: Readonly<{ configFile: 'config.toml'; installArgs: readonly string[] }>;
}>;

/** Builtin native qualification shares this descriptor owner with plugin
 * declarations. Plugin produceEnvironment alone does not promise global setup. */
const builtinNativeEnvironmentAdapters: readonly BuiltinNativeEnvironmentAdapterV1[] = Object.freeze([
    Object.freeze({ id: 'mise', title: 'Mise', platform: 'linux', nativeVersion: '2026.10.4',
        globalEnvironment: Object.freeze({ configFile: 'config.toml', installArgs: Object.freeze(['install']) }) }),
]);
export function listMachineEnvironmentAdaptersV1(platform: string): readonly BuiltinNativeEnvironmentAdapterV1[] {
    return builtinNativeEnvironmentAdapters.filter(adapter => adapter.platform === platform);
}

/** File names are declarations, not permission to read outside the admitted root. */
export const PluginProjectNativeAdapterContributionV1Schema = lazyZodSchema(() => z.object({
    id: asProtocolZod(PluginContributionLocalIdSchema),
    files: z.array(ProjectNativeFilePathV1Schema).min(1),
    roles: z.array(z.enum(PROJECT_NATIVE_ADAPTER_ROLES_V1)).min(1).refine(roles => new Set(roles).size === roles.length, 'Duplicate adapter role'),
}).strict());
export type PluginProjectNativeAdapterContributionV1 = z.infer<typeof PluginProjectNativeAdapterContributionV1Schema>;

const ProcessValueSchema = mini.string().check(mini.regex(/^[^\0]*$/u));
export const PluginProjectNativeFileFactV1Schema = lazyDefinition(() => mini.strictObject({ file: ProjectNativeFilePathV1Schema, content: mini.string() }));
export const PluginProjectNativeCommandV1Schema = lazyDefinition(() => mini.strictObject({
    executable: ManagedExecutableRefSchema,
    args: mini.readonly(mini.array(ProcessValueSchema)),
    cwd: ProcessValueSchema.check(mini.minLength(1)),
    reviewInputs: mini.readonly(mini.array(PluginProjectNativeFileFactV1Schema)),
    environmentApplied: mini.optional(ProjectEnvironmentSelectionV1Schema),
}));
const NativeFailureV1Schema = lazyDefinition(() => mini.strictObject({ kind: mini.enum(['unsupported', 'unavailable', 'failed', 'cancelled']), code: mini.string().check(mini.minLength(1)) }));
export const PluginProjectNativeCommandResultV1Schema = lazyDefinition(() => mini.union([
    mini.extend(PluginProjectNativeCommandV1Schema, { kind: mini.literal('resolved'), nativeInstance: mini.optional(mini.strictObject({
        adapter: asProtocolZod(PluginContributionIdentityV1Schema), nativeResourceId: ProcessValueSchema.check(mini.minLength(1)),
    })) }),
    NativeFailureV1Schema,
]));
export const PluginProjectNativeEnvironmentResultV1Schema = lazyDefinition(() => mini.union([
    mini.strictObject({
        kind: mini.literal('ready'),
        env: mini.record(ProcessValueSchema.check(mini.minLength(1)), ProcessValueSchema),
        launch: mini.optional(PluginProjectNativeCommandV1Schema),
        reviewInputs: mini.readonly(mini.array(PluginProjectNativeFileFactV1Schema)),
    }),
    NativeFailureV1Schema,
]));
