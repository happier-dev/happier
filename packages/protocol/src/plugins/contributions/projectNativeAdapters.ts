import { z } from 'zod/mini';
import * as mini from 'zod/mini';
import { lazyDefinition, lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginContributionIdentityV1Schema, PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { ManagedExecutableRefSchema } from './agentAcpTransport.js';
import { ProjectToolchainSelectionV1Schema, ProjectNativeFilePathV1Schema } from '../../workspaces/projectSetup/projectManifestV1.js';
import type { MachinePublishedMetadataV1 } from '../../machines/machinePublishedContentV1.js';
import type { InputHintOptionDescriptor } from '../../inputs/inputFields.js';

export const PROJECT_NATIVE_ADAPTER_ROLES_V1 = ['detect', 'resolveCommand', 'prepareToolchain', 'nativeServiceLifecycle'] as const;
export type ProjectNativeAdapterRoleV1 = typeof PROJECT_NATIVE_ADAPTER_ROLES_V1[number];

type NativeToolchainQualificationV1 = Readonly<{
    id: 'mise' | 'devbox' | 'devenv' | 'flox' | 'nix_flake'; title: string;
    platform: 'linux'; architecture: 'x64'; nativeVersion: string;
    executable: string;
    versionArgs: readonly string[];
    versionPattern: string;
}>;
/** Preserve the incumbent global-only descriptor contract for Machine callers. */
export type BuiltinNativeToolchainAdapterV1 = NativeToolchainQualificationV1 & Readonly<{
    id: 'mise';
    globalEnvironment: Readonly<{ configFile: 'config.toml'; installArgs: readonly string[] }>;
}>;
export type BuiltinProjectNativeToolchainAdapterV1 = BuiltinNativeToolchainAdapterV1 | (NativeToolchainQualificationV1 & Readonly<{
    id: Exclude<NativeToolchainQualificationV1['id'], 'mise'>;
    globalEnvironment?: never;
}>);

/** Builtin native qualification shares this descriptor owner with plugin
 * declarations. Plugin prepareToolchain alone does not promise global setup. */
const builtinNativeToolchainAdapters: readonly BuiltinProjectNativeToolchainAdapterV1[] = Object.freeze([
    Object.freeze({ id: 'mise', title: 'Mise', platform: 'linux', architecture: 'x64', nativeVersion: '2026.10.4', executable: 'mise',
        versionArgs: Object.freeze(['--version']), versionPattern: '^(\\d{4}\\.\\d+\\.\\d+) linux-x64 \\([^\\r\\n]*\\)\\s*$',
        globalEnvironment: Object.freeze({ configFile: 'config.toml', installArgs: Object.freeze(['install']) }) }),
    Object.freeze({ id: 'devbox', title: 'Devbox', platform: 'linux', architecture: 'x64', nativeVersion: '0.18.4', executable: 'devbox',
        versionArgs: Object.freeze(['version']), versionPattern: '^([0-9]+\\.[0-9]+\\.[0-9]+)\\s*$' }),
    Object.freeze({ id: 'devenv', title: 'devenv', platform: 'linux', architecture: 'x64', nativeVersion: '2.4.0', executable: 'devenv',
        versionArgs: Object.freeze(['--version']), versionPattern: '^devenv ([0-9]+\\.[0-9]+\\.[0-9]+) \\(x86_64-linux\\)\\s*$' }),
    Object.freeze({ id: 'flox', title: 'Flox', platform: 'linux', architecture: 'x64', nativeVersion: '1.18.1-gf264cf2', executable: 'flox',
        versionArgs: Object.freeze(['--version']), versionPattern: '^([0-9]+\\.[0-9]+\\.[0-9]+(?:-g[0-9a-f]+)?)\\s*$' }),
    Object.freeze({ id: 'nix_flake', title: 'Nix flake', platform: 'linux', architecture: 'x64', nativeVersion: '2.35.2', executable: 'nix',
        versionArgs: Object.freeze(['--version']), versionPattern: '^nix \\(Nix\\) ([0-9]+\\.[0-9]+\\.[0-9]+)\\s*$' }),
]);
export function findBuiltinNativeToolchainAdapterV1(id: string, platform: string): BuiltinProjectNativeToolchainAdapterV1 | undefined {
    return builtinNativeToolchainAdapters.find(adapter => adapter.id === id && adapter.platform === platform);
}
export function listMachineSetupAdaptersV1(platform: string): readonly BuiltinNativeToolchainAdapterV1[] {
    return builtinNativeToolchainAdapters.filter((adapter): adapter is BuiltinNativeToolchainAdapterV1 =>
        adapter.platform === platform && adapter.globalEnvironment !== undefined);
}

/** A configuration entry, not a Recipe, native version selection or installation fact. */
export const MachineSetupToolchainSoftwareChoiceV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('toolchain'),
    adapterId: z.literal('mise'),
    tool: z.enum(['node', 'python']),
}));
export type MachineSetupToolchainSoftwareChoiceV1 = z.infer<typeof MachineSetupToolchainSoftwareChoiceV1Schema>;

const machineSetupToolchainSoftwareEntries = [
    { value: { kind: 'toolchain', adapterId: 'mise', tool: 'node' }, label: 'Node.js', icon: 'terminal' },
    { value: { kind: 'toolchain', adapterId: 'mise', tool: 'python' }, label: 'Python', icon: 'terminal' },
] as const;

/** No target means an inert offering. Exact target facts alone qualify support; neither path probes native tools. */
export function projectMachineSetupToolchainSoftwareOptionsV1(
    target?: Pick<MachinePublishedMetadataV1, 'platform' | 'arch'>,
): readonly InputHintOptionDescriptor<string, MachineSetupToolchainSoftwareChoiceV1>[] {
    const adapter = target && listMachineSetupAdaptersV1(target.platform).find(candidate => candidate.id === 'mise');
    const supported = adapter !== undefined && target?.arch === adapter.architecture;
    const qualification = !target ? '' : target.arch === undefined
        ? ' Waiting for this Machine to report its architecture.'
        : supported ? '' : ' Needs a Linux x64 Machine.';
    return machineSetupToolchainSoftwareEntries.map(entry => ({
        ...entry,
        description: `Run ${entry.label} at the versions you choose.${qualification}`,
        ...(!target || supported ? {} : { disabled: true }),
    }));
}

/** File names are declarations, not permission to read outside the admitted root. */
export const PluginProjectNativeAdapterContributionV1Schema = lazyZodSchema(() => z.strictObject({
    id: asProtocolZod(PluginContributionLocalIdSchema),
    files: z.array(ProjectNativeFilePathV1Schema),
    roles: z.array(z.enum(PROJECT_NATIVE_ADAPTER_ROLES_V1)).check(z.minLength(1), z.refine(roles => new Set(roles).size === roles.length, 'Duplicate adapter role')),
}).check(z.refine(adapter => adapter.files.length > 0
    || adapter.roles.every(role => role === 'nativeServiceLifecycle'), 'Project adapter roles require native files')));
export type PluginProjectNativeAdapterContributionV1 = z.infer<typeof PluginProjectNativeAdapterContributionV1Schema>;

const ProcessValueSchema = mini.string().check(mini.regex(/^[^\0]*$/u));
export const PluginProjectNativeFileFactV1Schema = lazyDefinition(() => mini.strictObject({ file: ProjectNativeFilePathV1Schema, content: mini.string() }));
export const PluginProjectNativeCommandV1Schema = lazyDefinition(() => mini.strictObject({
    executable: ManagedExecutableRefSchema,
    args: mini.readonly(mini.array(ProcessValueSchema)),
    cwd: ProcessValueSchema.check(mini.minLength(1)),
    reviewInputs: mini.readonly(mini.array(PluginProjectNativeFileFactV1Schema)),
    toolchainApplied: mini.optional(ProjectToolchainSelectionV1Schema),
}));
const NativeFailureV1Schema = lazyDefinition(() => mini.strictObject({ kind: mini.enum(['unsupported', 'unavailable', 'failed', 'cancelled']), code: mini.string().check(mini.minLength(1)) }));
export const PluginProjectNativeCommandResultV1Schema = lazyDefinition(() => mini.union([
    mini.extend(PluginProjectNativeCommandV1Schema, { kind: mini.literal('resolved'), nativeInstance: mini.optional(mini.strictObject({
        adapter: asProtocolZod(PluginContributionIdentityV1Schema), nativeResourceId: ProcessValueSchema.check(mini.minLength(1)),
    })) }),
    NativeFailureV1Schema,
]));
export const PluginProjectNativeToolchainResultV1Schema = lazyDefinition(() => mini.union([
    mini.strictObject({
        kind: mini.literal('ready'),
        env: mini.record(ProcessValueSchema.check(mini.minLength(1)), ProcessValueSchema),
        launch: mini.optional(PluginProjectNativeCommandV1Schema),
        reviewInputs: mini.readonly(mini.array(PluginProjectNativeFileFactV1Schema)),
    }),
    NativeFailureV1Schema,
]));
