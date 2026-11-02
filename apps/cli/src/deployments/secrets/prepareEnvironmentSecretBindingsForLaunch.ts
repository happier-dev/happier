import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { EnvironmentSecretBindingV1Schema, environmentSecretBindingIdentityV1, machineSecretGrantSubjectKey, type EnvironmentSecretBindingV1, type MachineSecretGrantV1 } from '@happier-dev/deployment-protocol';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { openMachineSecretGrant, type MachineSecretGrantContentV1 } from './machineSecretGrant';
import { configuration } from '@/configuration';
import { createEnvironmentRegistryConfigForHost } from './environmentRegistryConfig';
import { createEnvironmentBackupDestinationConfigForHost } from './environmentBackupDestinationConfig';

function missing(): never {
    throw new PluginError({ code: 'secret_missing', message: 'An exact current Environment binding is unavailable' });
}

/**
 * Host-private phase materializer behind DeploymentExecEnvPortV1. The current
 * storage admission owns Environment principal, resource audience/mode/revision,
 * installation, requested phase/Machine assignment and root Action authority.
 * Ciphertext possession never supplies any of those permissions.
 */
export async function prepareEnvironmentSecretBindingsForLaunch(input: Readonly<{
    environmentId: string;
    machineId: string;
    installationId: string;
    installationPrivateSeed: Uint8Array;
    phase?: 'build' | 'runtime';
    /** An exact host-admitted non-variable row; never an application variable alias. */
    use?: Exclude<EnvironmentSecretBindingV1, { purpose: 'variable' }>;
    /** Exact registry rows, alone or alongside build variables. Explicit []
     * supplies empty private Docker custody without opening variable grants. */
    registryUses?: readonly Extract<EnvironmentSecretBindingV1, { purpose: 'registry' }>[];
    /** Host-owned finite-operation scratch, never a Docker global config directory. */
    registryConfigBaseDir?: string;
    /** Exact roles from one current host-admitted S3 destination configuration. */
    backupDestinationUses?: readonly Extract<EnvironmentSecretBindingV1, { purpose: 'backupDestination' }>[];
    /** One nonsecret runtime database name, acquired with its backup credentials.
     * The host removes this operand before lending the restic environment. */
    backupDatabaseBinding?: Extract<EnvironmentSecretBindingV1, { purpose: 'variable' }>;
    backupConfigBaseDir?: string;
    bindings: readonly EnvironmentSecretBindingV1[];
    grants: readonly MachineSecretGrantV1[];
    assertCurrent: () => Promise<void>;
    resolveNonSecret?: (source: Exclude<Extract<EnvironmentSecretBindingV1, { purpose: 'variable' }>['source'],
        { kind: 'secret' } | { kind: 'value' }>) => Promise<string>;
}>) {
    await input.assertCurrent();
    const bindings = input.bindings.map(binding => {
        const parsed = EnvironmentSecretBindingV1Schema.safeParse(binding);
        return parsed.success ? parsed.data : missing();
    });
    const admitUse = (value: EnvironmentSecretBindingV1) => {
        const parsed = EnvironmentSecretBindingV1Schema.safeParse(value);
        if (!parsed.success || parsed.data.purpose === 'variable') return missing();
        const use = parsed.data;
        // A pushPull binding permits a narrower pull; a pull binding cannot
        // authorize push. The current binding owns that distinction.
        if (!bindings.some(binding => isDeepStrictEqual(binding, use)
            || binding.purpose === 'registry' && use.purpose === 'registry' && use.access === 'pull'
                && isDeepStrictEqual({ ...binding, access: 'pull' }, use))) return missing();
        return use;
    };
    const registryConfigRequested = input.use?.purpose === 'registry' || input.registryUses !== undefined;
    const backupConfigRequested = input.backupDestinationUses !== undefined;
    if (input.backupDatabaseBinding !== undefined && !backupConfigRequested) return missing();
    let selected: readonly EnvironmentSecretBindingV1[];
    if (backupConfigRequested) {
        if (input.phase !== undefined || input.use !== undefined || input.registryUses !== undefined) return missing();
        const uses = input.backupDestinationUses!.map(value => {
            const use = admitUse(value);
            return use.purpose === 'backupDestination' ? use : missing();
        });
        const roles = new Set(uses.map(use => use.role));
        if (roles.size !== uses.length || !roles.has('repositoryPassword') || !roles.has('accessKeyId')
            || !roles.has('secretAccessKey') || roles.has('sshPrivateKey')) return missing();
        const database = input.backupDatabaseBinding;
        if (database && (database.purpose !== 'variable' || database.phase !== 'runtime' || database.source.kind === 'secret'
            || !bindings.some(binding => isDeepStrictEqual(binding, database)))) return missing();
        selected = database ? [...uses, database] : uses;
    } else if (input.use) {
        if (input.phase || input.registryUses !== undefined) return missing();
        selected = [admitUse(input.use)];
    } else {
        if (!input.phase && input.registryUses === undefined) return missing();
        if (input.registryUses !== undefined && input.phase === 'runtime') return missing();
        const registryUses = (input.registryUses ?? []).map(value => {
            const use = admitUse(value);
            return use.purpose === 'registry' ? use : missing();
        });
        selected = [...(input.phase ? bindings.filter(binding => binding.purpose === 'variable' && binding.phase === input.phase) : []), ...registryUses];
    }
    const grants = new Map(input.grants.map(grant => [machineSecretGrantSubjectKey(grant), grant]));
    const openedGrants = new Map<string, MachineSecretGrantContentV1>();
    const definitions = new Map<string, string>();
    const refs: { resourceId: string; resourceRevision: number }[] = [];
    const env: Record<string, string> = Object.create(null);
    const operationalValues = new Map<string, string>();
    const secretValues: string[] = [];
    let registryConfig: ReturnType<typeof createEnvironmentRegistryConfigForHost> | undefined;
    let backupConfig: Awaited<ReturnType<typeof createEnvironmentBackupDestinationConfigForHost>> | undefined;
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        try { registryConfig?.dispose(); backupConfig?.dispose(); }
        finally {
            for (const name of Object.keys(env)) delete env[name];
            secretValues.length = 0;
            openedGrants.clear();
            definitions.clear();
            operationalValues.clear();
        }
    };
    try {
    for (const binding of selected) {
        const base = { v: 1 as const, machineId: input.machineId, installationId: input.installationId,
            environmentId: input.environmentId };
        if (binding.source.kind === 'secret') {
            const ref = parseSavedSecretRefV1(binding.source.ref);
            if (ref.kind !== 'shared_resource') return missing();
            const subject = { ...base, kind: 'secret' as const, resourceId: ref.resourceId,
                resourceRevision: binding.source.resourceRevision };
            const key = machineSecretGrantSubjectKey(subject);
            const grant = grants.get(key);
            if (!grant) return missing();
            // Current binding admission already selected each use; shared
            // resource ciphertext is opened once per exact installed subject.
            let opened = openedGrants.get(key);
            if (!opened) {
                opened = openMachineSecretGrant({ grant, machineId: input.machineId,
                    installationId: input.installationId, installationPrivateSeed: input.installationPrivateSeed }) ?? undefined;
                if (opened) {
                    openedGrants.set(key, opened);
                    refs.push({ resourceId: ref.resourceId, resourceRevision: binding.source.resourceRevision });
                }
            }
            if (!opened || opened.kind !== 'secret') return missing();
        } else {
            if (binding.purpose !== 'variable') return missing();
            const subject = { ...base, kind: 'environmentValues' as const,
                binding: { purpose: 'variable' as const, phase: binding.phase, name: binding.name } };
            const grant = grants.get(machineSecretGrantSubjectKey(subject));
            if (!grant) return missing();
            const opened = openMachineSecretGrant({ grant, machineId: input.machineId,
                installationId: input.installationId, installationPrivateSeed: input.installationPrivateSeed });
            if (!opened || opened.kind !== 'environmentValues' || !isDeepStrictEqual(opened.definition, binding.source)) return missing();
            const value = opened.definition.kind === 'value' ? opened.definition.value
                : input.resolveNonSecret ? await input.resolveNonSecret(opened.definition) : missing();
            definitions.set(binding.name, value);
        }
    }
    for (const binding of selected) {
        if (binding.source.kind === 'secret') {
            const ref = parseSavedSecretRefV1(binding.source.ref);
            if (ref.kind !== 'shared_resource') return missing();
            const opened = openedGrants.get(machineSecretGrantSubjectKey({ v: 1, kind: 'secret',
                environmentId: input.environmentId, machineId: input.machineId, installationId: input.installationId,
                resourceId: ref.resourceId, resourceRevision: binding.source.resourceRevision }));
            if (!opened || opened.kind !== 'secret') return missing();
            const value = opened.value;
            if (binding.purpose === 'variable') env[binding.name] = value;
            else operationalValues.set(environmentSecretBindingIdentityV1(binding), value);
            if (!secretValues.includes(value)) secretValues.push(value);
        } else if (binding.purpose === 'variable') {
            const value = definitions.get(binding.name) ?? missing();
            // A database operand never occupies the destination credential env,
            // including when its binding key happens to be an AWS/restic name.
            if (!backupConfigRequested) env[binding.name] = value;
        }
        else return missing();
    }
    await input.assertCurrent();
    const registryUses = selected.filter((binding): binding is Extract<EnvironmentSecretBindingV1, { purpose: 'registry' }> => binding.purpose === 'registry');
    if (registryConfigRequested) {
        try {
            registryConfig = createEnvironmentRegistryConfigForHost({
                baseDir: input.registryConfigBaseDir ?? join(configuration.happyHomeDir, 'deployments', 'registry-configs'),
                registries: registryUses.map(use => ({ registryOrigin: use.registryOrigin,
                    credential: operationalValues.get(environmentSecretBindingIdentityV1(use)) ?? missing() })),
            });
            Object.assign(env, registryConfig.env);
            secretValues.push(...registryConfig.redactionValues.filter(value => value.length > 0 && !secretValues.includes(value)));
        } finally { operationalValues.clear(); }
    }
    if (backupConfigRequested) {
        const credential = (role: Extract<EnvironmentSecretBindingV1, { purpose: 'backupDestination' }>['role']) => {
            const use = selected.find(binding => binding.purpose === 'backupDestination' && binding.role === role) ?? missing();
            return operationalValues.get(environmentSecretBindingIdentityV1(use)) ?? missing();
        };
        try {
            backupConfig = await createEnvironmentBackupDestinationConfigForHost({
                baseDir: input.backupConfigBaseDir ?? join(configuration.happyHomeDir, 'deployments', 'backup-configs'),
                repositoryPassword: credential('repositoryPassword'), accessKeyId: credential('accessKeyId'),
                secretAccessKey: credential('secretAccessKey'),
                ...(selected.some(binding => binding.purpose === 'backupDestination' && binding.role === 'sessionToken')
                    ? { sessionToken: credential('sessionToken') } : {}),
            });
            await input.assertCurrent();
            Object.assign(env, backupConfig.env);
        } finally { operationalValues.clear(); }
    }
    return {
        env, operationalValues, secretValues, refs,
        backupDatabase: input.backupDatabaseBinding ? definitions.get(input.backupDatabaseBinding.name) ?? missing() : undefined,
        credentialFiles: backupConfig?.credentialFiles ?? [],
        async recheck() {
            if (disposed) return missing();
            await input.assertCurrent();
        },
        dispose,
    };
    } catch (error) { dispose(); throw error; }
}
