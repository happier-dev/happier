import type { PluginServiceLaunchEnvironmentProjectionV1 } from '@happier-dev/plugin-sdk';
import type { ServiceLaunchEnvironmentHostInput, PreparedServiceLaunchEnvironmentContribution } from '@/plugins/runtime/lifecycle/contributions/targetServiceLaunchEnvironments';
import type { EnvVarRequirement } from '@happier-dev/protocol/profiles/environmentVariables';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { LocalServiceLaunchTargetV1, LocalServicePortSourceV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import { PluginDiagnosticDataV1Schema } from '@happier-dev/protocol/daemon/pluginContributionIntrospection';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';
import { mergeProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';
import { isProjectWorktreeRuntimeVariable } from '@/workspaces/execution/projectWorktreeRuntime';
import { resolvePhysicalWorktreeRootIdentity } from '@/workspaces/execution/worktreePorts';
import { isProjectSecretRequirement } from '@/settings/secrets/secretReferenceOverlay';
import { createProjectDotenvPreparation, type ProjectDotenvDiagnostic, type ProjectDotenvPreparation } from './projectDotenv';

/** Deliberate selections have one precedence owner for values and reference bindings. */
export function mergeProjectLaunchLayers<T>(project: Readonly<Record<string, T>> | undefined,
    profile?: Readonly<Record<string, T>>, invocation?: Readonly<Record<string, T>>): Record<string, T> {
    return Object.assign({}, project, profile, invocation);
}

type Environment = Readonly<Record<string, string>>;
export type ProjectServiceLaunchDiagnostics = Readonly<NonNullable<LocalServiceLaunchTargetV1['diagnostics']>>;
type UnavailableContribution = Extract<PreparedServiceLaunchEnvironmentContribution['result'], { kind: 'unavailable' }>;

function projectOptionalLaunchWarning(contribution: UnavailableContribution): ProjectServiceLaunchDiagnostics[number] {
    const diagnostic = contribution.diagnostic;
    if (diagnostic) {
        const parsed = PluginDiagnosticDataV1Schema.safeParse({
            code: diagnostic.code, message: diagnostic.message, severity: 'warning',
        });
        if (parsed.success) return parsed.data;
    }
    return { code: contribution.code, severity: 'warning', message: 'An optional Service integration is unavailable.' };
}
export type ProjectServiceLaunchEnvironmentInput = Omit<ServiceLaunchEnvironmentHostInput, 'workspace' | 'readEnvironment' | 'physicalRootIdentity'> & Readonly<{
    prepareServiceLaunchEnvironments(input: Omit<ServiceLaunchEnvironmentHostInput, 'workspace'>): Promise<readonly PreparedServiceLaunchEnvironmentContribution[]>;
}>;
export type PreparedProjectLaunchInput = Readonly<{
    environment: Environment;
    portSource?: LocalServicePortSourceV1;
    originalEnvironment: ProcessEnvInput;
    provenance: readonly Readonly<{ name: string; file: string }>[];
    serviceDiagnostics: ProjectServiceLaunchDiagnostics;
    /** Retained by the actual service process owner through settlement. */
    releaseServiceEnvironment?: () => Promise<void>;
}>;
export type ProjectLaunchEnvironmentPreparation = Readonly<{ kind: 'prepared'; launchInput: PreparedProjectLaunchInput }>
    | Readonly<{ kind: 'refused'; code: 'project_environment_binding_unavailable'; diagnostics: readonly ProjectDotenvDiagnostic[] }>;

/** The one merge policy for Project child environments. Materialized secrets join at final native production. */
export function composeProjectLaunchEnvironment(input: Readonly<{
    requirements: readonly EnvVarRequirement[]; originalEnvironment: ProcessEnvInput;
    privateEnvironment?: Environment; runtimeEnvironment?: Environment;
    projectEnvironment?: Environment; profileEnvironment?: Environment; invocationEnvironment?: ProcessEnvInput;
    platform?: NodeJS.Platform;
}>): Readonly<{ environment: Record<string, string>; portSource?: LocalServicePortSourceV1 }> {
    const identity = (name: string) => (input.platform ?? process.platform) === 'win32' ? name.toUpperCase() : name;
    const secretNames = new Set(input.requirements.filter(isProjectSecretRequirement).map(requirement => identity(requirement.name)));
    let result: ProcessEnvInput = input.runtimeEnvironment && Object.keys(input.runtimeEnvironment).length
        ? Object.fromEntries(Object.entries(input.originalEnvironment).filter(([name]) => !isProjectWorktreeRuntimeVariable(identity(name))))
        : input.originalEnvironment;
    for (const layer of [input.privateEnvironment, input.runtimeEnvironment, input.projectEnvironment, input.profileEnvironment, input.invocationEnvironment]) {
        const removedNames = new Set(Object.entries(layer ?? {}).filter(([, value]) => value === undefined).map(([name]) => identity(name)));
        if (removedNames.size) result = Object.fromEntries(Object.entries(result).filter(([name]) => !removedNames.has(identity(name))));
        result = mergeProcessEnv({ baseEnv: result, explicitEnv: layer, platform: input.platform });
    }
    let portSource: LocalServicePortSourceV1 | undefined;
    if (!secretNames.has(identity('PORT')) && Object.entries(result).some(([name, value]) => identity(name) === 'PORT' && value !== undefined)) {
        if (Object.keys(input.runtimeEnvironment ?? {}).some(name => identity(name) === 'PORT')) portSource = 'assigned';
        if ([input.projectEnvironment, input.profileEnvironment, input.invocationEnvironment]
            .some(layer => Object.keys(layer ?? {}).some(name => identity(name) === 'PORT'))) portSource = 'fixed';
    }
    return { environment: Object.fromEntries(Object.entries(result).filter((entry): entry is [string, string] =>
        entry[1] !== undefined && !secretNames.has(identity(entry[0])))), ...(portSource ? { portSource } : {}) };
}

/** This private preparation never enters Actions, review facts, consent digests or transcripts. */
export async function prepareProjectLaunchEnvironment(input: Readonly<{
    workspace: Pick<WorkspaceRefV1, 'rootPath'>; requirements: readonly EnvVarRequirement[]; originalEnvironment: ProcessEnvInput;
    projectEnvironment?: Environment; profileEnvironment?: Environment; invocationEnvironment?: ProcessEnvInput;
    runtimeEnvironment?: Environment; dotenvPreparation?: ProjectDotenvPreparation; service?: ProjectServiceLaunchEnvironmentInput;
    platform?: NodeJS.Platform;
}>): Promise<ProjectLaunchEnvironmentPreparation> {
    const originalEnvironment = Object.freeze({ ...input.originalEnvironment });
    const layers = { ...input, originalEnvironment };
    const identity = (name: string) => (input.platform ?? process.platform) === 'win32' ? name.toUpperCase() : name;
    const dotenv = input.dotenvPreparation ?? createProjectDotenvPreparation(input.workspace.rootPath, originalEnvironment);
    const configNames = input.requirements.filter(requirement => requirement.kind === 'config').map(requirement => requirement.name);
    const privateInput = await dotenv.read(configNames);
    if (privateInput.kind === 'refused') return privateInput;
    const composed = composeProjectLaunchEnvironment({ ...layers, privateEnvironment: privateInput.environment });
    const { environment } = composed;
    let portSource = composed.portSource;
    const serviceDiagnostics: ProjectServiceLaunchDiagnostics[number][] = [];
    const releases: (() => Promise<void>)[] = [];
    if (input.service) {
        const serviceInput = input.service;
        const secretNames = new Set(input.requirements.filter(isProjectSecretRequirement).map(requirement => identity(requirement.name)));
        const original = { ...environment };
        const deliberateSources = new Map<string, 'runtime' | 'project' | 'profile' | 'invocation'>();
        for (const [source, layer] of [['runtime', input.runtimeEnvironment], ['project', input.projectEnvironment],
            ['profile', input.profileEnvironment], ['invocation', input.invocationEnvironment]] as const) {
            for (const name of Object.keys(layer ?? {})) deliberateSources.set(identity(name), source);
        }
        const readEnvironment = async (names: readonly string[]): Promise<PluginServiceLaunchEnvironmentProjectionV1> => {
            const selectedNames = [...new Set(names)].filter(name => !secretNames.has(identity(name)));
            const selected = await dotenv.read(selectedNames);
            if (selected.kind === 'refused') return { projectedEnvironment: {}, provenance: {}, diagnostics: selected.diagnostics };
            const projected = composeProjectLaunchEnvironment({ ...layers, privateEnvironment: { ...privateInput.environment, ...selected.environment } }).environment;
            const entries = new Map(Object.entries(projected).map(([name, value]) => [identity(name), value]));
            const files = new Map(selected.sources.map(source => [identity(source.name), source.file]));
            const provenance: Record<string, PluginServiceLaunchEnvironmentProjectionV1['provenance'][string]> = {};
            const projectedEnvironment: Record<string, string> = {};
            for (const name of selectedNames) {
                const value = entries.get(identity(name));
                if (value === undefined) continue;
                projectedEnvironment[name] = value;
                original[name] = value;
                const deliberateSource = deliberateSources.get(identity(name));
                provenance[name] = deliberateSource ? { source: deliberateSource }
                    : files.has(identity(name)) ? { source: 'dotenv', file: files.get(identity(name))! } : { source: 'host' };
            }
            return { projectedEnvironment: Object.freeze(projectedEnvironment), provenance: Object.freeze(provenance) };
        };
        let contributions: readonly PreparedServiceLaunchEnvironmentContribution[];
        try { contributions = await serviceInput.prepareServiceLaunchEnvironments({
            physicalRootIdentity: await resolvePhysicalWorktreeRootIdentity(input.workspace.rootPath), project: serviceInput.project,
            ...(serviceInput.requester ? { requester: serviceInput.requester } : {}),
            serviceId: serviceInput.serviceId, serviceName: serviceInput.serviceName, executionPlacement: serviceInput.executionPlacement,
            assignedPorts: serviceInput.assignedPorts, requestListenerPorts: serviceInput.requestListenerPorts,
            readEnvironment, readDeclaredEnvironment: () => readEnvironment(configNames) }); }
        catch {
            serviceDiagnostics.push(projectOptionalLaunchWarning({ kind: 'unavailable', code: 'service_launch_environment_failed' }));
            contributions = [];
        }
        const replacements = new Map<string, { name: string; values: string[] }>();
        const defaults: Record<string, string> = {};
        const originalKeys = new Set(Object.keys(original).map(identity));
        for (const { result: contribution } of contributions) {
            if (contribution.kind === 'unavailable') {
                serviceDiagnostics.push(projectOptionalLaunchWarning(contribution));
                continue;
            }
            if (contribution.release) {
                const release = contribution.release;
                releases.push(() => release.call(contribution));
            }
            if (contribution.kind !== 'replace') continue;
            if (contribution.warning) serviceDiagnostics.push(projectOptionalLaunchWarning(contribution.warning));
            for (const [name, value] of Object.entries(contribution.defaults ?? {})) {
                if (!secretNames.has(identity(name)) && !originalKeys.has(identity(name))) defaults[name] = value;
            }
            for (const [name, value] of Object.entries(contribution.replacements ?? {})) {
                if (secretNames.has(identity(name))) continue;
                const entry = replacements.get(identity(name)) ?? { name, values: [] };
                entry.values.push(value); replacements.set(identity(name), entry);
            }
        }
        let conflict = false;
        const accepted: Record<string, string> = {};
        for (const { name, values } of replacements.values()) {
            if (values.length > 1) conflict = true;
            else accepted[name] = values[0]!;
        }
        if (Object.keys({ ...defaults, ...accepted }).some(name => identity(name) === 'PORT')) portSource = 'fixed';
        const merged = mergeProcessEnv({ baseEnv: original, explicitEnv: { ...defaults, ...accepted }, platform: input.platform });
        for (const name of Object.keys(environment)) delete environment[name];
        Object.assign(environment, merged);
        if (conflict) serviceDiagnostics.push({ code: 'replacement_key_conflict', severity: 'warning',
            message: 'Service integrations requested conflicting launch settings.' });
    }
    const valuesByIdentity = new Map(Object.entries(environment).map(([name, value]) => [identity(name), value]));
    for (const requirement of input.requirements) {
        if (requirement.kind !== 'config') continue;
        const value = valuesByIdentity.get(identity(requirement.name));
        if (requirement.required && (value === undefined || value === '') || value?.includes('\0')) {
            await Promise.all(releases.map(release => release()));
            return { kind: 'refused',
            code: 'project_environment_binding_unavailable', diagnostics: [{ name: requirement.name, file: 'environment', code: 'unreadable_definition' }] };
        }
    }
    return { kind: 'prepared', launchInput: { environment: Object.freeze(environment), originalEnvironment, ...(portSource ? { portSource } : {}),
        provenance: privateInput.sources, serviceDiagnostics,
        ...(releases.length ? { releaseServiceEnvironment: async () => { await Promise.all(releases.map(release => release())); } } : {}) } };
}
