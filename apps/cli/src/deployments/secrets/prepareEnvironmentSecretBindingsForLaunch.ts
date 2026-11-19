import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { encodeTelemetryAuthorizationHeaderV1 } from '@happier-dev/deployments/telemetry';
import { join } from 'node:path';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { EnvironmentSecretBindingStoredReadV1Schema, environmentSecretBindingIdentityV1, type EnvironmentSecretBindingV1 } from '@happier-dev/deployments/contracts/v1';
import { machineSecretGrantSubjectKey, type MachineSecretGrantV1 } from '@happier-dev/protocol/deployments/machineSecretGrantV1';
import { parseSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { openMachineSecretGrant, type MachineSecretGrantReadContentV1 } from './machineSecretGrant';
import { configuration } from '@/configuration';
import { createEnvironmentRegistryConfigForHost } from './environmentRegistryConfig';
import { createEnvironmentBackupDestinationConfigForHost } from './environmentBackupDestinationConfig';
import type { DeploymentReferenceAddressV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import { listMissingProjectSecretRequirements, type ProjectSecretReferenceEnvironmentInput } from '@/settings/secrets/secretReferenceOverlay';
import type { DeploymentMissingRequiredSecretsV1 } from '@happier-dev/protocol/deployments/deploymentReviewV1';
import type { BackupDestinationOpenV1 } from '@happier-dev/plugin-sdk';

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
    requirements?: ProjectSecretReferenceEnvironmentInput['requirements'];
    /** An exact host-admitted non-variable row; never an application variable alias. */
    use?: Exclude<EnvironmentSecretBindingV1, { purpose: 'variable' }>;
    /** Exact registry rows, alone or alongside build variables. Explicit []
     * supplies empty private Docker custody without opening variable grants. */
    registryUses?: readonly Extract<EnvironmentSecretBindingV1, { purpose: 'registry' }>[];
    /** Host-owned finite-operation scratch, never a Docker global config directory. */
    registryConfigBaseDir?: string;
    /** Exact roles from one current host-admitted destination configuration. */
    backupDestinationUses?: readonly Extract<EnvironmentSecretBindingV1, { purpose: 'backupDestination' }>[];
    backupDestinationSftp?: BackupDestinationOpenV1['sftp'];
    /** Selected nonsecret runtime database names, acquired with backup credentials.
     * The host keeps these operands outside the lent restic environment. */
    backupDatabaseBindings?: readonly Extract<EnvironmentSecretBindingV1, { purpose: 'variable' }>[];
    backupConfigBaseDir?: string;
    bindings: readonly EnvironmentSecretBindingV1[];
    grants: readonly MachineSecretGrantV1[];
    assertCurrent: () => Promise<void>;
    resolveNonSecret?: (source: Exclude<Extract<EnvironmentSecretBindingV1, { purpose: 'variable' }>['source'],
        { kind: 'secret' } | { kind: 'value' }>) => Promise<string | Readonly<{
            value: string; route: NonNullable<DeploymentReferenceAddressV1['route']>;
        }>>;
}>) {
    await input.assertCurrent();
    const bindings = input.bindings.map(binding => {
        const parsed = EnvironmentSecretBindingStoredReadV1Schema.safeParse(binding);
        return parsed.success ? parsed.data : missing();
    });
    const admitUse = (value: EnvironmentSecretBindingV1) => {
        const parsed = EnvironmentSecretBindingStoredReadV1Schema.safeParse(value);
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
    if (input.backupDatabaseBindings !== undefined && !backupConfigRequested) return missing();
    let selected: readonly EnvironmentSecretBindingV1[];
    if (backupConfigRequested) {
        if (input.phase !== undefined || input.use !== undefined || input.registryUses !== undefined) return missing();
        const uses = input.backupDestinationUses!.map(value => {
            const use = admitUse(value);
            return use.purpose === 'backupDestination' ? use : missing();
        });
        const roles = new Set(uses.map(use => use.role));
        const s3 = roles.has('accessKeyId') || roles.has('secretAccessKey') || roles.has('sessionToken');
        if (roles.size !== uses.length || !roles.has('repositoryPassword')
            || s3 && (!roles.has('accessKeyId') || !roles.has('secretAccessKey') || roles.has('sshPrivateKey'))
            || input.backupDestinationSftp && !roles.has('sshPrivateKey')) return missing();
        const databases = input.backupDatabaseBindings ?? [];
        for (const database of databases) {
            if (database.purpose !== 'variable' || database.phase !== 'runtime' || database.source.kind === 'secret'
                || !bindings.some(binding => isDeepStrictEqual(binding, database))) return missing();
        }
        selected = [...uses, ...databases];
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
    const openedGrants = new Map<string, MachineSecretGrantReadContentV1>();
    const definitions = new Map<string, Readonly<{ name: string; value: string }>>();
    const referenceAddresses: DeploymentReferenceAddressV1[] = [];
    const refs: { resourceId: string; resourceRevision: number }[] = [];
    const env: Record<string, string> = Object.create(null);
    const operationalValues = new Map<string, string>();
    const secretValues: string[] = [];
    let telemetryTokenHash: string | undefined;
    const telemetryEnvironmentNames = selected.flatMap(binding => binding.purpose === 'variable' && binding.managedBy === 'telemetry'
        ? [binding.name] : []);
    const telemetryBindings = selected.filter(binding => binding.purpose === 'variable' && binding.managedBy === 'telemetry');
    const missingRequiredSecretNames = new Set<string>();
    const availableSecretNames = new Set<string>();
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
    const materialize = async (selectedBindings: readonly EnvironmentSecretBindingV1[]) => {
    for (const binding of selectedBindings) {
        const base = { v: 1 as const, machineId: input.machineId, installationId: input.installationId,
            environmentId: input.environmentId };
        if (binding.source.kind === 'secret') {
            const ref = parseSavedSecretRefV1(binding.source.ref);
            if (ref.kind !== 'shared_resource') return missing();
            const subject = { ...base, kind: 'secret' as const, resourceId: ref.resourceId,
                resourceRevision: binding.source.resourceRevision };
            const key = machineSecretGrantSubjectKey(subject);
            const grant = grants.get(key);
            if (!grant) {
                if (binding.purpose !== 'variable') return missing();
                missingRequiredSecretNames.add(binding.name);
                continue;
            }
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
            if (!opened || opened.kind !== 'secret' || binding.purpose === 'variable' && opened.value.length === 0) {
                if (binding.purpose !== 'variable') return missing();
                missingRequiredSecretNames.add(binding.name);
            } else if (binding.purpose === 'variable') availableSecretNames.add(binding.name);
        } else {
            if (binding.purpose !== 'variable') return missing();
            const subjectBase = { ...base, kind: 'environmentValues' as const };
            const subject = binding.grantRef
                ? { ...subjectBase, binding: { purpose: 'variable' as const, phase: binding.phase, grantRef: binding.grantRef } }
                : { ...subjectBase, binding: { purpose: 'variable' as const, phase: binding.phase, name: binding.name } };
            const grant = grants.get(machineSecretGrantSubjectKey(subject));
            if (!grant) return missing();
            const opened = openMachineSecretGrant({ grant, machineId: input.machineId,
                installationId: input.installationId, installationPrivateSeed: input.installationPrivateSeed });
            if (!opened || opened.kind !== 'environmentValues'
                || !isDeepStrictEqual(opened.binding, { purpose: 'variable', phase: binding.phase,
                    name: binding.name, ...(binding.grantRef ? { grantRef: binding.grantRef } : {}) })
                || !isDeepStrictEqual(opened.definition, binding.source)) return missing();
            const resolved = opened.definition.kind === 'value' ? opened.definition.value
                : input.resolveNonSecret ? await input.resolveNonSecret(opened.definition) : missing();
            const value = typeof resolved === 'string' ? resolved : resolved.value;
            definitions.set(environmentSecretBindingIdentityV1(binding), { name: opened.binding.name, value });
            if (opened.definition.kind === 'reference') referenceAddresses.push({
                machineId: input.machineId, installationId: input.installationId, phase: opened.binding.phase,
                name: opened.binding.name, source: opened.definition, address: value,
                ...(typeof resolved === 'string' ? {} : { route: resolved.route }),
            });
        }
    }
    const requirements = (input.requirements ?? []).filter(requirement => !telemetryEnvironmentNames.includes(requirement.name)
        || selectedBindings.some(binding => binding.purpose === 'variable' && binding.name === requirement.name));
    for (const name of listMissingProjectSecretRequirements(requirements, availableSecretNames)) {
        missingRequiredSecretNames.add(name);
    }
    if (missingRequiredSecretNames.size > 0) {
        const details: DeploymentMissingRequiredSecretsV1 = { deployable: false,
            missingRequiredSecretNames: [...missingRequiredSecretNames] };
        throw new PluginError({ code: 'secret_missing', message: 'Required Environment secrets are unavailable', details });
    }
    for (const binding of selectedBindings) {
        if (binding.source.kind === 'secret') {
            const ref = parseSavedSecretRefV1(binding.source.ref);
            if (ref.kind !== 'shared_resource') return missing();
            const opened = openedGrants.get(machineSecretGrantSubjectKey({ v: 1, kind: 'secret',
                environmentId: input.environmentId, machineId: input.machineId, installationId: input.installationId,
                resourceId: ref.resourceId, resourceRevision: binding.source.resourceRevision }));
            if (!opened || opened.kind !== 'secret') return missing();
            const value = opened.value;
            if (binding.purpose === 'variable') {
                const delivered = binding.valueFormat === 'otelAuthorizationHeader' ? encodeTelemetryAuthorizationHeaderV1(value) : value;
                env[binding.name] = delivered;
                if (binding.managedBy === 'telemetry' && binding.valueFormat === 'otelAuthorizationHeader') {
                    telemetryTokenHash = createHash('sha256').update(value).digest('hex');
                }
                if (delivered !== value && !secretValues.includes(delivered)) secretValues.push(delivered);
            }
            else operationalValues.set(environmentSecretBindingIdentityV1(binding), value);
            if (!secretValues.includes(value)) secretValues.push(value);
        } else if (binding.purpose === 'variable') {
            const definition = definitions.get(environmentSecretBindingIdentityV1(binding)) ?? missing();
            // A database operand never occupies the destination credential env,
            // including when its binding key happens to be an AWS/restic name.
            if (!backupConfigRequested) env[definition.name] = definition.value;
        }
        else return missing();
    }
    await input.assertCurrent();
    };
    try {
    await materialize(selected.filter(binding => binding.purpose !== 'variable' || binding.managedBy !== 'telemetry'));
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
                repositoryPassword: credential('repositoryPassword'),
                ...(selected.some(binding => binding.purpose === 'backupDestination' && binding.role === 'accessKeyId')
                    ? { accessKeyId: credential('accessKeyId'), secretAccessKey: credential('secretAccessKey') } : {}),
                ...(selected.some(binding => binding.purpose === 'backupDestination' && binding.role === 'sshPrivateKey')
                    ? { sshPrivateKey: credential('sshPrivateKey'), sftp: input.backupDestinationSftp } : {}),
                ...(selected.some(binding => binding.purpose === 'backupDestination' && binding.role === 'sessionToken')
                    ? { sessionToken: credential('sessionToken') } : {}),
            });
            await input.assertCurrent();
            Object.assign(env, backupConfig.env);
        } finally { operationalValues.clear(); }
    }
    return {
        env, operationalValues, secretValues, refs, referenceAddresses, telemetryEnvironmentNames,
        get telemetryTokenHash() { return telemetryTokenHash; },
        async resolveTelemetry(names: readonly string[]) {
            if (disposed) return missing();
            await materialize(telemetryBindings.filter(binding => binding.purpose === 'variable' && names.includes(binding.name)));
        },
        backupDatabases: new Map((input.backupDatabaseBindings ?? []).map(database =>
            [definitions.get(environmentSecretBindingIdentityV1(database))?.name ?? missing(), definitions.get(environmentSecretBindingIdentityV1(database))?.value ?? missing()] as const)),
        credentialFiles: backupConfig?.credentialFiles ?? [],
        async recheck() {
            if (disposed) return missing();
            await input.assertCurrent();
        },
        dispose,
    };
    } catch (error) { dispose(); throw error; }
}
