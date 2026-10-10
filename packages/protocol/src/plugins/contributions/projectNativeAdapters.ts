import { z } from 'zod';
import * as mini from 'zod/mini';
import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginContributionIdentityV1Schema, PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { ManagedExecutableRefSchema } from './agentAcpTransport.js';
import { ProjectEnvironmentSelectionV1Schema, ProjectNativeFilePathV1Schema } from '../../workspaces/projectSetup/projectManifestV1.js';

export const PROJECT_NATIVE_ADAPTER_ROLES_V1 = ['detect', 'resolveCommand', 'produceEnvironment', 'nativeServiceLifecycle'] as const;
export type ProjectNativeAdapterRoleV1 = typeof PROJECT_NATIVE_ADAPTER_ROLES_V1[number];

type NativeEnvironmentQualificationV1 = Readonly<{
    id: 'mise' | 'devbox' | 'devenv' | 'flox' | 'nix_flake'; title: string;
    platform: 'linux'; nativeVersion: string;
    executable: string;
    versionArgs: readonly string[];
    versionPattern: string;
}>;
/** Preserve the incumbent global-only descriptor contract for Machine callers. */
export type BuiltinNativeEnvironmentAdapterV1 = NativeEnvironmentQualificationV1 & Readonly<{
    id: 'mise';
    globalEnvironment: Readonly<{ configFile: 'config.toml'; installArgs: readonly string[] }>;
}>;
export type BuiltinProjectNativeEnvironmentAdapterV1 = BuiltinNativeEnvironmentAdapterV1 | (NativeEnvironmentQualificationV1 & Readonly<{
    id: Exclude<NativeEnvironmentQualificationV1['id'], 'mise'>;
    globalEnvironment?: never;
}>);

/** Builtin native qualification shares this descriptor owner with plugin
 * declarations. Plugin produceEnvironment alone does not promise global setup. */
const builtinNativeEnvironmentAdapters: readonly BuiltinProjectNativeEnvironmentAdapterV1[] = Object.freeze([
    Object.freeze({ id: 'mise', title: 'Mise', platform: 'linux', nativeVersion: '2026.10.4', executable: 'mise',
        versionArgs: Object.freeze(['--version']), versionPattern: '^(\\d{4}\\.\\d+\\.\\d+) linux-x64 \\([^\\r\\n]*\\)\\s*$',
        globalEnvironment: Object.freeze({ configFile: 'config.toml', installArgs: Object.freeze(['install']) }) }),
    Object.freeze({ id: 'devbox', title: 'Devbox', platform: 'linux', nativeVersion: '0.18.4', executable: 'devbox',
        versionArgs: Object.freeze(['version']), versionPattern: '^([0-9]+\\.[0-9]+\\.[0-9]+)\\s*$' }),
    Object.freeze({ id: 'devenv', title: 'devenv', platform: 'linux', nativeVersion: '2.4.0', executable: 'devenv',
        versionArgs: Object.freeze(['--version']), versionPattern: '^devenv ([0-9]+\\.[0-9]+\\.[0-9]+) \\(x86_64-linux\\)\\s*$' }),
    Object.freeze({ id: 'flox', title: 'Flox', platform: 'linux', nativeVersion: '1.18.1-gf264cf2', executable: 'flox',
        versionArgs: Object.freeze(['--version']), versionPattern: '^([0-9]+\\.[0-9]+\\.[0-9]+(?:-g[0-9a-f]+)?)\\s*$' }),
    Object.freeze({ id: 'nix_flake', title: 'Nix flake', platform: 'linux', nativeVersion: '2.35.2', executable: 'nix',
        versionArgs: Object.freeze(['--version']), versionPattern: '^nix \\(Nix\\) ([0-9]+\\.[0-9]+\\.[0-9]+)\\s*$' }),
]);
export function findBuiltinNativeEnvironmentAdapterV1(id: string, platform: string): BuiltinProjectNativeEnvironmentAdapterV1 | undefined {
    return builtinNativeEnvironmentAdapters.find(adapter => adapter.id === id && adapter.platform === platform);
}
export function listMachineEnvironmentAdaptersV1(platform: string): readonly BuiltinNativeEnvironmentAdapterV1[] {
    return builtinNativeEnvironmentAdapters.filter((adapter): adapter is BuiltinNativeEnvironmentAdapterV1 =>
        adapter.platform === platform && adapter.globalEnvironment !== undefined);
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
