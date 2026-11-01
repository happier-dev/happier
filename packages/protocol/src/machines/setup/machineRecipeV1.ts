import { z } from 'zod';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { MachineAdminAccessV1Schema } from '../adminAccessV1.js';
import { MachineAgentIsolationPolicyV1Schema } from '../agentIsolationV1.js';
import { PluginJsonSchemaV2Schema, isRecursivelyClosedPluginJsonSchemaV2, PluginJsonValueV2Schema } from '../../plugins/contributions/jsonSchema.js';
import { PluginLocalizedStringV2Schema } from '../../plugins/contributions/publicTypes.js';
import { PluginUiIconTokenV1Schema } from '../../plugins/contributions/ui/tokens.js';
import { PluginContributionLocalIdSchema } from '../../plugins/contributionIdentity.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { InputPathSchema, InputPredicateSchema, InputPrimitiveSchema, createInputPredicateSchema, mapInputPredicateValues, readInputPath } from '../../inputs/inputPredicates.js';
import { resolveValueRefPlaintextV1 } from '../../valueRefs/valueRefV1.js';
import { createInputHintsSchemasWithStaticOptionsOnly, InputOptionValueSchema } from '../../inputs/inputFields.js';
import { resolveDeclaredInputLeaves } from '../../plugins/actions/inputSchemaTraversal.js';
import { MachineRecipeReferenceV1Schema } from './machineRecipeReferenceV1.js';
import { MachineFirewallExposureV1Schema as FirewallExposure } from './machineFirewallV1.js';
export { MachineFirewallTransitionIntentV1Schema, type MachineFirewallTransitionIntentV1,
    MachineFirewallTransitionBindingsV1Schema, type MachineFirewallTransitionBindingsV1,
    MachineFirewallTransitionFactsV1Schema, type MachineFirewallTransitionFactsV1,
    MachineFirewallReviewFactsV1Schema, type MachineFirewallReviewFactsV1 } from './machineFirewallV1.js';
export { MachineRecipeReferenceV1Schema, type MachineRecipeReferenceV1 } from './machineRecipeReferenceV1.js';

const Name = z.string().regex(/^[a-z_][a-z0-9_.-]*[$]?$/i);
const Path = z.string().startsWith('/').refine((value) => !value.includes('\0'));
const NativeExecutable = z.string().min(1).refine(value => {
    if (value.includes('\0')) return false;
    const name = value.replace(/\\/g, '/').split('/').pop()?.replace(/\.exe$/i, '') ?? '';
    // This is an explicit-data contract, not a containment boundary. Scripts
    // retain the separate daemon-user setupScript owner.
    return !/^(?:sh|bash|dash|zsh|fish|ksh|csh|tcsh|cmd|powershell|pwsh|python[\d.]*|node|bun|perl|ruby|env)$/i.test(name);
});
export const MachineRecipeNativeCommandV1Schema = z.object({ executable: NativeExecutable, args: z.array(z.string().refine(value => !value.includes('\0'))) }).strict();
const Argv = MachineRecipeNativeCommandV1Schema;
const Architectures = z.array(z.string().regex(/^[a-z0-9][a-z0-9_.-]*(?:\/[a-z0-9][a-z0-9_.-]*)?$/)).min(1)
    .refine(values => new Set(values).size === values.length);
const KernelFact = z.object({ kind: z.literal('kernel'), capability: z.string().regex(/^[a-z][a-zA-Z0-9_.-]*$/),
    architectures: Architectures.optional() }).strict().refine(fact => !['binfmt', 'binfmtPersistent'].includes(fact.capability) || fact.architectures !== undefined,
    { message: 'Emulation facts require the exact requested architectures' });
const UserManagerGroups = z.object({ kind: z.literal('userManagerGroups'), username: Name }).strict();
export const MachineRecipeRequiredFactV1Schema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('packageManager'), manager: z.string().regex(/^[a-z][a-z0-9-]*$/) }).strict(),
    z.object({ kind: z.literal('init'), system: z.enum(['systemd', 'launchd', 'windowsScm']) }).strict(),
    z.object({ kind: z.literal('administrator') }).strict(),
    z.object({ kind: z.literal('path'), path: Path }).strict(),
    z.object({ kind: z.literal('command'), executable: NativeExecutable }).strict(),
    KernelFact,
    z.object({ kind: z.literal('journalReadGroup'), group: Name }).strict(),
]);
export const MachineRecipeImpactV1Schema = z.union([
    z.literal('none'), z.literal('dockerEngine'), z.object({ services: z.array(z.string().min(1)) }).strict(),
]);
export const MachineRecipeNativeCheckV1Schema = Argv.extend({
    unsatisfiedExitCodes: z.array(z.number().int()).refine((codes) => !codes.includes(0) && new Set(codes).size === codes.length),
    stdoutJson: z.optional(InputPredicateSchema),
}).strict();
/** Script probes share the checked-native-command contract; script bytes stay separate. */
export const MachineSetupScriptCheckV1Schema = MachineRecipeNativeCheckV1Schema.safeExtend({
    requiredFacts: z.array(MachineRecipeRequiredFactV1Schema).optional(),
    removal: MachineRecipeNativeCheckV1Schema.optional(),
}).strict();
const Step = { id: z.string().min(1), requiredFacts: z.array(MachineRecipeRequiredFactV1Schema).optional(),
    review: z.object({ title: PluginLocalizedStringV2Schema, description: z.optional(PluginLocalizedStringV2Schema) }).strict().optional() };
const SshContext = z.object({ user: Name, host: z.string().min(1).refine(value => !/[\r\n\0]/.test(value)), address: z.string().min(1).refine(value => !/[\r\n\0]/.test(value)) }).strict();
export const MachineRecipeFileProbeV1Schema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('sshd'), contexts: z.array(SshContext).min(1) }).strict(),
    z.object({ kind: z.literal('docker') }).strict(),
    z.object({ kind: z.literal('caddy') }).strict(),
    z.object({ kind: z.literal('nft') }).strict(),
    z.object({ kind: z.literal('sudoers') }).strict(),
]);
const Handler = z.object({ serviceStepId: z.string().min(1), action: z.enum(['reload', 'restart']) }).strict();
const Ownership = { owner: Name, group: Name, mode: z.number().int().min(0).max(0o7777) };
const JsonObject = z.record(z.string(), z.json());
const PackageManager = z.string().regex(/^[a-z][a-z0-9-]*$/);
// Exact native tokens include Homebrew's comma-separated cask versions.
const PackageVersion = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.,+:~_@-]*$/);
const PackageIdentityFields = {
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9+_.:@/-]*$/),
    kind: z.enum(['formula', 'cask']).optional(),
    source: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
    scope: z.enum(['user', 'machine']).optional(),
};
function packageIdentityError(identity: { manager: string; name: string; kind?: string; source?: string; scope?: string }): string | undefined {
    if (identity.manager === 'brew') {
        if (!identity.kind || !/^[a-z0-9][a-z0-9+_.@-]*(?:\/[a-z0-9][a-z0-9+_.@-]*\/[a-z0-9][a-z0-9+_.@-]*)?$/.test(identity.name)) {
            return 'Homebrew requires an exact formula or cask identity.';
        }
    } else if (identity.kind !== undefined) return 'Formula and cask identity belongs only to Homebrew.';
    if (identity.manager === 'winget') {
        const exactId = identity.source === 'msstore' ? /^[A-Za-z0-9]+$/ : /^[A-Za-z0-9][A-Za-z0-9_+-]*(?:\.[A-Za-z0-9][A-Za-z0-9_+-]*)+$/;
        if (!exactId.test(identity.name)) return 'Winget requires an exact package id, not a display name or query.';
    } else if (identity.source !== undefined || identity.scope !== undefined) return 'Package source and install scope belong only to winget.';
    if (identity.manager === 'apt' && !/^[a-z0-9][a-z0-9+.-]*$/.test(identity.name)) return 'An exact apt package name is required.';
    if (identity.manager === 'dnf' && !/^[A-Za-z0-9][A-Za-z0-9+_.-]*$/.test(identity.name)) return 'An exact dnf package name is required.';
    return undefined;
}
/** The same exact native identity is used by desired steps and compact observations. */
export const MachineRecipePackageIdentityV1Schema = z.object({ manager: PackageManager, ...PackageIdentityFields }).strict()
    .refine(identity => packageIdentityError(identity) === undefined, { message: 'A manager-native exact package identity is required.' });
export type MachineRecipePackageIdentityV1 = z.infer<typeof MachineRecipePackageIdentityV1Schema>;
export const MachineRecipePackageObservationV1Schema = MachineRecipePackageIdentityV1Schema.safeExtend({
    present: z.boolean(), version: PackageVersion.optional(),
}).refine(value => value.present || value.version === undefined, { message: 'An absent package has no installed version.' });

function refineFile(step: { state?: string; content?: { kind: string }; expectedContentDigest?: unknown }, context: z.RefinementCtx) {
    if (step.state === 'absent' ? step.content?.kind !== 'secretGrant' && (step.content !== undefined || !step.expectedContentDigest) : step.content === undefined) {
        context.addIssue({ code: 'custom', message: 'Present files require content; removal requires a secret grant reference or the exact prior digest without content' });
    }
    if (step.content?.kind === 'secretGrant' && step.expectedContentDigest !== undefined) {
        context.addIssue({ code: 'custom', path: ['expectedContentDigest'], message: 'Secret grants carry references only, never a content digest' });
    }
}

/** Epoch 1 executable declarations; M-P20F extends this same canonical owner. */
export const MachineRecipeUserStepV1Schema =
    z.object({ ...Step, kind: z.literal('user'), username: Name, home: Path.optional(), shell: Path.optional(), system: z.boolean().optional(), locked: z.boolean().optional(),
        uid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
        state: z.enum(['present', 'absent']).optional(), ownershipMarker: z.string().min(1).regex(/^[^:\r\n\0]+$/).optional(),
        supplementaryGroups: z.array(Name).optional(),
    }).strict().superRefine((step, context) => {
        if (step.state === 'absent' && !step.ownershipMarker) context.addIssue({ code: 'custom', message: 'Account removal requires exact recipe ownership' });
    });
export const MachineRecipeGroupStepV1Schema =
    z.object({ ...Step, kind: z.literal('group'), name: Name, members: z.array(Name),
        state: z.enum(['present', 'absent']).optional(), existingOnly: z.literal(true).optional(),
    }).strict();
export const MachineRecipeDirectoryStepV1Schema =
    z.object({ ...Step, kind: z.literal('directory'), path: Path, ...Ownership,
        preserveExistingOwnership: z.literal(true).optional(), protectedAncestors: z.literal(true).optional(),
        ownershipMarker: z.string().min(1).refine(value => !/[\r\n\0]/.test(value)).optional(),
    }).strict();
export const MachineRecipeWorkspaceAccessStepV1Schema =
    z.object({ ...Step, kind: z.literal('workspaceAccess'), path: Path, group: Name, agentUsername: Name }).strict();
export const MachineRecipePathTraversalStepV1Schema =
    z.object({ ...Step, kind: z.literal('pathTraversal'), path: Path, agentUsername: Name }).strict();
export const MachineRecipeFileStepV1Schema =
    z.object({ ...Step, kind: z.literal('file'), path: Path, ...Ownership,
        state: z.enum(['present', 'absent']).optional(),
        content: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('literal'), value: z.string() }).strict(),
            z.object({ kind: z.literal('jsonMerge'), value: JsonObject }).strict(),
            z.object({ kind: z.literal('template'), value: z.string(), variables: z.record(z.string(), z.string()) }).strict(),
            z.object({ kind: z.literal('iniKeys'), sections: z.record(z.string(), z.record(z.string(), z.string())) }).strict(),
            z.object({ kind: z.literal('secretGrant'), grantRef: z.string().min(1) }).strict(),
        ]).optional(),
        expectedContentDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        ownershipMarker: z.string().min(1).optional(), validate: z.union([z.enum(['sudoers', 'docker']), MachineRecipeFileProbeV1Schema]).optional(),
        probe: MachineRecipeFileProbeV1Schema.optional(), onChange: Handler.optional(),
    }).strict().superRefine(refineFile);
export const MachineRecipeCommandStepV1Schema =
    z.object({ ...Step, kind: z.literal('command'), ...Argv.shape,
        check: z.union([MachineRecipeNativeCheckV1Schema, KernelFact, UserManagerGroups]), remove: Argv.optional(), affects: MachineRecipeImpactV1Schema.optional(),
    }).strict();
export const MachineRecipePackageStepV1Schema =
    z.object({ ...Step, kind: z.literal('package'), manager: PackageManager, state: z.enum(['present', 'absent']).optional(),
        packages: z.array(z.object({ ...PackageIdentityFields, version: PackageVersion.optional() }).strict()).min(1),
    }).strict().superRefine((step, context) => {
        step.packages.forEach((item, index) => {
            const message = packageIdentityError({ manager: step.manager, ...item });
            if (message) context.addIssue({ code: 'custom', path: ['packages', index], message });
        });
    });
export const MachineRecipePackageSourceStepV1Schema =
    z.object({ ...Step, kind: z.literal('packageSource'), manager: z.literal('apt'), path: Path, keyPath: Path,
        url: z.url().startsWith('https://'), suite: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
        components: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1), architectures: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1),
        keyUrl: z.url().startsWith('https://'), keyFingerprint: z.string().regex(/^[A-F0-9]{40}$/),
    }).strict();
export const MachineRecipeServiceUnitStepV1Schema =
    z.object({ ...Step, kind: z.literal('serviceUnit'), unit: z.string().regex(/^[a-zA-Z0-9@_.-]+\.service$/), enabled: z.boolean(), running: z.boolean() }).strict();
export const MachineRecipeFirewallStepV1Schema =
    z.object({ ...Step, kind: z.literal('firewall'), rules: z.string().min(1), exposures: z.array(FirewallExposure).optional() }).strict();
// Host-built concrete effect only; recipes cannot declare reboot.
export const MachineRecipeRebootStepV1Schema = z.object({ ...Step, kind: z.literal('reboot') }).strict();
export const MachineRecipeStepV1Schema = z.discriminatedUnion('kind', [
    MachineRecipeUserStepV1Schema, MachineRecipeGroupStepV1Schema, MachineRecipeDirectoryStepV1Schema,
    MachineRecipeWorkspaceAccessStepV1Schema, MachineRecipePathTraversalStepV1Schema, MachineRecipeFileStepV1Schema,
    MachineRecipeCommandStepV1Schema, MachineRecipePackageStepV1Schema, MachineRecipePackageSourceStepV1Schema,
    MachineRecipeServiceUnitStepV1Schema, MachineRecipeFirewallStepV1Schema, MachineRecipeRebootStepV1Schema,
]);
export type MachineRecipeStepV1 = z.infer<typeof MachineRecipeStepV1Schema>;

export const MachineRecipeInputReferenceV1Schema = z.object({ kind: z.literal('input'), path: InputPathSchema }).strict();
type InputReference = z.infer<typeof MachineRecipeInputReferenceV1Schema>;
export const MachineRecipeTargetFactReferenceV1Schema = z.object({ kind: z.literal('targetFact'), fact: z.enum(['daemon.primaryGroup', 'daemon.username']) }).strict();
export type MachineRecipeTargetFactsV1 = Readonly<Partial<Record<z.infer<typeof MachineRecipeTargetFactReferenceV1Schema>['fact'], string | null>>>;
export class MachineRecipeTargetFactUnavailableErrorV1 extends Error {
    readonly code = 'machine_recipe_target_fact_unavailable';
    constructor() { super('machine_recipe_target_fact_unavailable'); }
}
const TemplateReference = z.object({ kind: z.literal('template'), value: z.string(),
    variables: z.record(z.string(), z.union([z.string(), MachineRecipeInputReferenceV1Schema, MachineRecipeTargetFactReferenceV1Schema])),
}).strict();
function bindable<T extends z.ZodType>(schema: T) {
    return z.union([schema, MachineRecipeInputReferenceV1Schema, MachineRecipeTargetFactReferenceV1Schema, TemplateReference]);
}
export const MachineRecipeConditionV1Schema = z.union([z.object({
    checkId: z.string().min(1),
    status: z.array(z.enum(['satisfied', 'drifted', 'packageUnavailable', 'packageManagerUnavailable'])).min(1)
        .refine(statuses => new Set(statuses).size === statuses.length),
    ifInput: z.optional(InputPredicateSchema),
}).strict(), z.object({ input: InputPredicateSchema }).strict()]);
const When = z.array(MachineRecipeConditionV1Schema).min(1).optional();
const User = MachineRecipeUserStepV1Schema, Directory = MachineRecipeDirectoryStepV1Schema;
const File = MachineRecipeFileStepV1Schema, Command = MachineRecipeCommandStepV1Schema, Package = MachineRecipePackageStepV1Schema;
const Content = File.shape.content.unwrap();
const LiteralContent = z.object({ ...Content.options[0].shape, value: bindable(Content.options[0].shape.value) }).strict();
const TemplateContent = z.object({ ...Content.options[2].shape, variables: TemplateReference.shape.variables }).strict();
const FileContent = z.discriminatedUnion('kind', [LiteralContent, Content.options[1], TemplateContent, Content.options[3], Content.options[4]]);
const SshdProbe = MachineRecipeFileProbeV1Schema.options[0];
const ProbeContext = SshdProbe.shape.contexts.element;
const ProbeDeclaration = z.discriminatedUnion('kind', [
    z.object({ ...SshdProbe.shape, contexts: z.array(z.object({ ...ProbeContext.shape,
        user: bindable(ProbeContext.shape.user), host: bindable(ProbeContext.shape.host), address: bindable(ProbeContext.shape.address),
    }).strict()).min(1) }).strict(),
    MachineRecipeFileProbeV1Schema.options[1], MachineRecipeFileProbeV1Schema.options[2],
    MachineRecipeFileProbeV1Schema.options[3], MachineRecipeFileProbeV1Schema.options[4],
]);
const UserDeclaration = z.object({ ...User.shape,
    username: bindable(User.shape.username), home: bindable(User.shape.home.unwrap()).optional(),
    shell: bindable(User.shape.shell.unwrap()).optional(),
    ownershipMarker: bindable(User.shape.ownershipMarker.unwrap()).optional(),
}).strict().superRefine((step, context) => {
    if (step.state === 'absent' && !step.ownershipMarker) context.addIssue({ code: 'custom', message: 'Account removal requires exact recipe ownership' });
});
const Group = MachineRecipeGroupStepV1Schema;
const JournalGroupFact = MachineRecipeRequiredFactV1Schema.options[6];
const GroupDeclaration = z.object({ ...Group.shape, name: bindable(Group.shape.name),
    requiredFacts: z.array(z.union([MachineRecipeRequiredFactV1Schema,
        z.object({ ...JournalGroupFact.shape, group: bindable(JournalGroupFact.shape.group) }).strict(),
    ])).optional(),
}).strict();
const DirectoryDeclaration = z.object({ ...Directory.shape,
    path: bindable(Directory.shape.path), owner: bindable(Directory.shape.owner),
    group: bindable(Directory.shape.group), mode: bindable(Directory.shape.mode),
    ownershipMarker: bindable(Directory.shape.ownershipMarker.unwrap()).optional(),
}).strict();
const FileDeclaration = z.object({ ...File.shape,
    path: bindable(File.shape.path), owner: bindable(File.shape.owner),
    group: bindable(File.shape.group), mode: bindable(File.shape.mode), content: FileContent.optional(),
    expectedContentDigest: z.union([File.shape.expectedContentDigest.unwrap(), z.object({ kind: z.literal('renderedContent'),
        content: z.discriminatedUnion('kind', [LiteralContent, TemplateContent]),
    }).strict()]).optional(),
    validate: z.union([File.shape.validate.unwrap().options[0], ProbeDeclaration]).optional(), probe: ProbeDeclaration.optional(),
}).strict().superRefine(refineFile);
const ServiceDeclaration = z.object({ ...MachineRecipeServiceUnitStepV1Schema.shape,
    unit: bindable(MachineRecipeServiceUnitStepV1Schema.shape.unit) }).strict();
const Args = bindable(z.array(bindable(z.string().refine(value => !value.includes('\0')))));
const KernelDeclaration = z.object({ ...KernelFact.shape, architectures: bindable(Architectures).optional() }).strict()
    .refine(fact => !['binfmt', 'binfmtPersistent'].includes(fact.capability) || fact.architectures !== undefined,
        { message: 'Emulation facts require the exact requested architectures' });
const CommandDeclaration = z.object({ ...Command.shape, args: Args,
    check: z.union([z.object({ ...MachineRecipeNativeCheckV1Schema.shape, args: Args,
        stdoutJson: z.optional(createInputPredicateSchema(z.union([InputPrimitiveSchema, MachineRecipeInputReferenceV1Schema, MachineRecipeTargetFactReferenceV1Schema]))),
    }).strict(), KernelDeclaration, UserManagerGroups]),
}).strict();
const PackageDeclaration = z.object({ ...Package.shape,
    manager: bindable(Package.shape.manager), packages: bindable(z.array(z.union([
        Package.shape.packages.element, MachineRecipeInputReferenceV1Schema,
    ])).min(1)),
}).strict().superRefine((step, context) => {
    // Bound identities are admitted by the same concrete native schema.
    if (typeof step.manager !== 'string' || !Array.isArray(step.packages)) return;
    const packages = step.packages.filter(entry => !isInputReference(entry));
    if (packages.length === 0) return;
    const { when: _when, ...identity } = { when: undefined, ...step, packages };
    const parsed = Package.safeParse(identity);
    if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ ...issue });
});
export const MachineRecipeCheckV1Schema = z.discriminatedUnion('kind', [Command, Package, KernelFact.safeExtend({ id: Step.id })]);
export const MachineRecipeCheckDeclarationV1Schema = z.discriminatedUnion('kind', [CommandDeclaration, PackageDeclaration,
    KernelDeclaration.safeExtend({ id: Step.id })]);
export const MachineRecipeStepDeclarationV1Schema = z.discriminatedUnion('kind', [
    UserDeclaration.safeExtend({ when: When }), GroupDeclaration.safeExtend({ when: When }),
    DirectoryDeclaration.safeExtend({ when: When }), MachineRecipeWorkspaceAccessStepV1Schema.safeExtend({ when: When }),
    MachineRecipePathTraversalStepV1Schema.safeExtend({ when: When }), FileDeclaration.safeExtend({ when: When }),
    CommandDeclaration.safeExtend({ when: When }), PackageDeclaration.safeExtend({ when: When }),
    MachineRecipePackageSourceStepV1Schema.safeExtend({ when: When }), ServiceDeclaration.safeExtend({ when: When }),
    MachineRecipeFirewallStepV1Schema.safeExtend({ when: When }),
]);
export type MachineRecipeStepDeclarationV1 = z.infer<typeof MachineRecipeStepDeclarationV1Schema>;
export type MachineRecipeCheckV1 = z.infer<typeof MachineRecipeCheckV1Schema>;
export type MachineRecipeCheckDeclarationV1 = z.infer<typeof MachineRecipeCheckDeclarationV1Schema>;

function isInputReference(value: unknown): value is InputReference {
    return value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'input';
}
function boundValue(value: unknown, inputs: unknown, targetFacts?: MachineRecipeTargetFactsV1): unknown {
    if (value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'targetFact') {
        const reference = MachineRecipeTargetFactReferenceV1Schema.parse(value);
        const resolved = targetFacts?.[reference.fact];
        if (!resolved || !Name.safeParse(resolved).success) throw new MachineRecipeTargetFactUnavailableErrorV1();
        return resolved;
    }
    if (value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'template') {
        const template = TemplateReference.parse(value);
        const vars = Object.fromEntries(Object.entries(template.variables).map(([name, variable]) =>
            [name, { t: 'literal' as const, v: z.string().parse(boundValue(variable, inputs, targetFacts)) }]));
        const rendered = resolveValueRefPlaintextV1({ t: 'template', template: template.value, vars }, () => null);
        if (rendered === null) throw new TypeError('invalid_machine_recipe_inputs');
        return rendered;
    }
    if (!isInputReference(value)) return value;
    const resolved = readInputPath(inputs, value.path);
    if (resolved === undefined) throw new TypeError('invalid_machine_recipe_inputs');
    return resolved;
}
function boundArgs(value: unknown, inputs: unknown, targetFacts?: MachineRecipeTargetFactsV1): unknown {
    return Array.isArray(value) ? value.map(arg => boundValue(arg, inputs, targetFacts)) : boundValue(value, inputs, targetFacts);
}
function boundProbe(probe: z.infer<typeof ProbeDeclaration>, inputs: unknown, targetFacts?: MachineRecipeTargetFactsV1): unknown {
    return probe.kind === 'sshd' ? { ...probe, contexts: probe.contexts.map(context => ({
        user: boundValue(context.user, inputs, targetFacts), host: boundValue(context.host, inputs, targetFacts), address: boundValue(context.address, inputs, targetFacts),
    })) } : probe;
}
function boundContent(content: z.infer<typeof FileContent> | undefined, inputs: unknown, targetFacts?: MachineRecipeTargetFactsV1): unknown {
    if (content?.kind === 'literal') return { kind: 'literal', value: boundValue(content.value, inputs, targetFacts) };
    if (content?.kind === 'template') return { kind: 'literal', value: boundValue(content, inputs, targetFacts) };
    return content;
}
/** Resolve authored fields only; reviewed JSON values are never recursively interpreted. */
export function resolveMachineRecipeStepInputsV1(step: MachineRecipeStepDeclarationV1, inputs: unknown, targetFacts?: MachineRecipeTargetFactsV1): MachineRecipeStepV1;
export function resolveMachineRecipeStepInputsV1(step: MachineRecipeCheckDeclarationV1, inputs: unknown, targetFacts?: MachineRecipeTargetFactsV1): MachineRecipeCheckV1;
export function resolveMachineRecipeStepInputsV1(step: MachineRecipeStepDeclarationV1 | MachineRecipeCheckDeclarationV1, inputs: unknown, targetFacts?: MachineRecipeTargetFactsV1): MachineRecipeStepV1 | MachineRecipeCheckV1 {
    const bind = (value: unknown) => boundValue(value, inputs, targetFacts);
    const { when: _when, ...concreteStep } = { when: undefined, ...step };
    let resolved: unknown = concreteStep;
    switch (step.kind) {
        case 'group':
            resolved = { ...concreteStep, name: bind(step.name),
                ...(step.requiredFacts ? { requiredFacts: step.requiredFacts.map(fact => fact.kind === 'journalReadGroup'
                    ? { ...fact, group: bind(fact.group) } : fact) } : {}) };
            break;
        case 'user':
            resolved = { ...concreteStep, username: bind(step.username),
                ...(step.home !== undefined ? { home: bind(step.home) } : {}),
                ...(step.shell !== undefined ? { shell: bind(step.shell) } : {}),
                ...(step.ownershipMarker !== undefined ? { ownershipMarker: bind(step.ownershipMarker) } : {}) };
            break;
        case 'directory':
        case 'file': {
            const ownership = { ...concreteStep, path: bind(step.path), owner: bind(step.owner),
                group: bind(step.group), mode: bind(step.mode) };
            if (step.kind === 'directory') {
                resolved = { ...ownership, ...(step.ownershipMarker !== undefined ? { ownershipMarker: bind(step.ownershipMarker) } : {}) };
                break;
            }
            const content = boundContent(step.content, inputs, targetFacts);
            const expectedContentDigest = typeof step.expectedContentDigest === 'object'
                ? bytesToHex(sha256(new TextEncoder().encode(z.object({ kind: z.literal('literal'), value: z.string() })
                    .parse(boundContent(step.expectedContentDigest.content, inputs, targetFacts)).value))) : step.expectedContentDigest;
            resolved = { ...ownership, ...(step.content !== undefined ? { content } : {}),
                ...(expectedContentDigest !== undefined ? { expectedContentDigest } : {}),
                ...(step.probe ? { probe: boundProbe(step.probe, inputs, targetFacts) } : {}),
                ...(typeof step.validate === 'object' ? { validate: boundProbe(step.validate, inputs, targetFacts) } : {}) };
            break;
        }
        case 'package':
            resolved = { ...concreteStep, manager: bind(step.manager),
                packages: Array.isArray(step.packages) ? step.packages.map(entry => bind(entry)) : bind(step.packages) };
            break;
        case 'serviceUnit':
            resolved = { ...concreteStep, unit: bind(step.unit) };
            break;
        case 'command':
            resolved = { ...concreteStep, args: boundArgs(step.args, inputs, targetFacts),
                check: 'kind' in step.check ? step.check.kind === 'kernel'
                    ? { ...step.check, architectures: bind(step.check.architectures) } : step.check
                    : { ...step.check, args: boundArgs(step.check.args, inputs, targetFacts),
                        ...(step.check.stdoutJson ? { stdoutJson: mapInputPredicateValues(step.check.stdoutJson,
                            value => InputPrimitiveSchema.parse(bind(value))) } : {}) } };
            break;
        case 'kernel':
            resolved = { ...concreteStep, ...(step.architectures !== undefined ? { architectures: bind(step.architectures) } : {}) };
            return MachineRecipeCheckV1Schema.parse(resolved);
    }
    return MachineRecipeStepV1Schema.parse(resolved);
}

export const MachineRecipeSelectionV1Schema = z.object({ ref: MachineRecipeReferenceV1Schema, inputs: PluginJsonValueV2Schema }).strict();
export type MachineRecipeSelectionV1 = z.infer<typeof MachineRecipeSelectionV1Schema>;
const RecipeInputHintsSchema = createInputHintsSchemasWithStaticOptionsOnly(PluginLocalizedStringV2Schema, InputOptionValueSchema).hintsSchema;
export const MachineRecipeV1Schema = z.object({
    id: asProtocolZod(PluginContributionLocalIdSchema), revision: z.string().min(1), title: PluginLocalizedStringV2Schema,
    description: z.optional(PluginLocalizedStringV2Schema),
    icon: z.optional(PluginUiIconTokenV1Schema),
    software: z.literal(true).optional(),
    inputSchema: PluginJsonSchemaV2Schema.check(z.refine(isRecursivelyClosedPluginJsonSchemaV2,
        { message: 'Recipe inputs require recursively closed portable schemas' })),
    inputHints: z.optional(RecipeInputHintsSchema),
    inputConstraints: z.array(z.object({ kind: z.literal('pathWithin'), path: InputPathSchema, root: InputPathSchema }).strict()).optional(),
    checks: z.array(MachineRecipeCheckDeclarationV1Schema).optional(),
    steps: z.array(MachineRecipeStepDeclarationV1Schema), removeSteps: z.array(MachineRecipeStepDeclarationV1Schema).optional(),
    appliesWhen: z.object({ posture: z.literal('publicSshOpen') }).strict().optional(),
}).strict().superRefine((recipe, context) => {
    recipe.inputHints?.fields.forEach((field, index) => {
        if (field.inputType !== undefined) context.addIssue({ code: 'custom', path: ['inputHints', 'fields', index, 'inputType'],
            message: 'Recipe input hints cannot request host options' });
        if (!resolveDeclaredInputLeaves(recipe.inputSchema, field.path, field.visibleWhen ? 'conditional-field' : 'every-arm')) {
            context.addIssue({ code: 'custom', path: ['inputHints', 'fields', index, 'path'],
                message: 'Recipe input fields must resolve to a declared inputSchema leaf' });
        }
    });
    const checkIds = new Set((recipe.checks ?? []).map(check => check.id));
    if (checkIds.size !== (recipe.checks ?? []).length) context.addIssue({ code: 'custom', path: ['checks'], message: 'Recipe check ids must be unique' });
    for (const [name, steps] of [['steps', recipe.steps], ['removeSteps', recipe.removeSteps ?? []]] as const) {
        const ids = new Set(steps.map(step => step.id));
        if (ids.size !== steps.length) context.addIssue({ code: 'custom', path: [name], message: 'Recipe step ids must be unique' });
        for (const step of steps) {
            if ((step.when ?? []).some(condition => 'checkId' in condition && !checkIds.has(condition.checkId))) {
                context.addIssue({ code: 'custom', path: [name], message: 'Conditions must reference a declared read-only check' });
            }
            if ('onChange' in step && step.onChange && !steps.some(candidate => candidate.kind === 'serviceUnit' && candidate.id === step.onChange?.serviceStepId)) {
                context.addIssue({ code: 'custom', path: [name], message: 'A change handler must reference a declared service step' });
            }
        }
    }
});
export type MachineRecipeV1 = z.infer<typeof MachineRecipeV1Schema>;

/** Cross-field path relationships are admitted alongside the portable input schema. */
export function machineRecipeInputConstraintsSatisfiedV1(recipe: Pick<MachineRecipeV1, 'inputConstraints'>, inputs: unknown): boolean {
    const canonicalPath = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/')
        && !/[\\\r\n\0]/.test(value) && (value === '/' || value.slice(1).split('/').every(part => part !== '' && part !== '.' && part !== '..'));
    return (recipe.inputConstraints ?? []).every(constraint => {
        const path = readInputPath(inputs, constraint.path), root = readInputPath(inputs, constraint.root);
        return canonicalPath(path) && canonicalPath(root) && path !== root && path.startsWith(root === '/' ? root : `${root}/`);
    });
}

export const MachineSetupStepObservationV1Schema = z.object({
    stepId: z.string(), status: z.enum(['satisfied', 'drifted', 'unsupported', 'unavailable']),
    reason: z.string().optional(), facts: JsonObject,
}).strict();
export type MachineSetupStepObservationV1 = z.infer<typeof MachineSetupStepObservationV1Schema>;

/** Creation-time bases never name or write an online desired-setup record. */
export const MachineSetupBootstrapBasisV1Schema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('bootstrap'), managedId: z.string().min(1), operationId: z.string().min(1),
        admittedInputDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    z.object({ kind: z.literal('sshBootstrap'), operationId: z.string().min(1),
        admittedInputDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
export type MachineSetupBootstrapBasisV1 = z.infer<typeof MachineSetupBootstrapBasisV1Schema>;
export function isMachineSetupBootstrapBasisV1(basis: MachineSetupEffectPlanV1['basis']): basis is MachineSetupBootstrapBasisV1 {
    return basis.kind === 'bootstrap' || basis.kind === 'sshBootstrap';
}
export const MachineSetupEffectBasisV1Schema = z.discriminatedUnion('kind', [
    ...MachineSetupBootstrapBasisV1Schema.options,
    z.object({ kind: z.literal('setup'), machineId: z.string().min(1), desiredRevision: z.number().int().nonnegative(),
        selection: MachineRecipeSelectionV1Schema.optional() }).strict(),
    // Administrator policy is its own admitted Machine operation, not a
    // desired setup revision. Both reviewed policies participate in the digest.
    z.object({ kind: z.literal('adminAccess'), machineId: z.string().min(1), operationId: z.string().min(1),
        previousPolicy: MachineAdminAccessV1Schema, policy: MachineAdminAccessV1Schema }).strict(),
    // Isolation is a Machine metadata field, not a desired-setup record.
    // Retain the reviewed pre-CAS policy; the accepted operation's own write
    // must not invalidate the root-side digest.
    z.object({ kind: z.literal('agentIsolation'), machineId: z.string().min(1), enabled: z.boolean(),
        expectedPolicy: MachineAgentIsolationPolicyV1Schema,
        review: z.object({ roots: z.array(z.object({ rootId: z.string().min(1), path: Path }).strict()),
            ancestorAcls: z.array(z.object({ path: Path, add: z.literal('x') }).strict()),
            sessionsToReplace: z.number().int().nonnegative(),
            memberProvisioning: z.literal('linuxUsersV1').optional() }).strict().optional(),
    }).strict(),
    z.object({ kind: z.literal('reboot'), machineId: z.string().min(1), operationId: z.string().min(1) }).strict(),
]);

export const MachineSetupEffectPlanV1Schema = z.object({
    v: z.literal(1), basis: MachineSetupEffectBasisV1Schema, steps: z.array(MachineRecipeStepV1Schema),
    nativeFacts: z.array(MachineSetupStepObservationV1Schema),
    checks: z.array(MachineRecipeCheckV1Schema).optional(), checkFacts: z.array(MachineSetupStepObservationV1Schema).optional(),
    selectedCheckIds: z.array(z.string().min(1)).optional(),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((plan, context) => {
    const checks = plan.checks ?? [], checkFacts = plan.checkFacts ?? [];
    const reboot = plan.steps.some(step => step.kind === 'reboot');
    if (plan.basis.kind === 'reboot' ? plan.steps.length !== 1 || !reboot || plan.checks !== undefined
        || plan.selectedCheckIds !== undefined : reboot) {
        context.addIssue({ code: 'custom', message: 'Reboot requires its exact standalone host operation basis' });
    }
    if (plan.selectedCheckIds && (new Set(plan.selectedCheckIds).size !== plan.selectedCheckIds.length
        || plan.selectedCheckIds.some(id => !checks.some(check => check.id === id)))) {
        context.addIssue({ code: 'custom', message: 'Selected condition checks must reference unique demanded checks' });
    }
    if ((plan.checks === undefined) !== (plan.checkFacts === undefined) || new Set(checks.map(check => check.id)).size !== checks.length
        || checks.length !== checkFacts.length || checkFacts.some((fact, index) => fact.stepId !== checks[index]?.id)) {
        context.addIssue({ code: 'custom', message: 'Read-only checks and ordered observations must match exactly' });
    }
    const ids = plan.steps.map((step) => step.id);
    if (new Set(ids).size !== ids.length || plan.nativeFacts.length !== ids.length
        || plan.nativeFacts.some((fact, index) => fact.stepId !== ids[index])) {
        context.addIssue({ code: 'custom', message: 'Step identities and ordered observations must match exactly' });
    }
});
export type MachineSetupEffectPlanV1 = z.infer<typeof MachineSetupEffectPlanV1Schema>;

export const MachineSetupElevatedEffectV1Schema = z.object({ kind: z.literal('setupOperation'),
    plans: z.array(z.object({ plan: MachineSetupEffectPlanV1Schema }).strict()).min(1)
        .refine(plans => plans.length === 1 || plans.every(entry => entry.plan.basis.kind !== 'reboot'),
            { message: 'Reboot cannot share an elevated batch' }),
}).strict();
export const MachineElevatedEffectV1Schema = MachineSetupElevatedEffectV1Schema;
export type MachineElevatedEffectV1 = z.infer<typeof MachineElevatedEffectV1Schema>;
