import { z } from 'zod/mini';
import { createHash } from 'node:crypto';
import { EnvironmentVariableBindingGrantReferenceV1Schema } from '@happier-dev/deployments/contracts/v1';
import { MachineSecretGrantV1Schema, MachineSecretGrantStoredReadV1Schema, machineSecretGrantSubjectKey, type MachineSecretGrantV1, type MachineSecretGrantSubjectV1, type MachineSecretGrantSubjectStoredReadV1, type MachineConnectorSecretGrantSubjectV1 } from '@happier-dev/protocol/deployments/machineSecretGrantV1';
import { projectEnvironmentSecretBindingRequiredUsesV1, selectEnvironmentSecretCapturePurposesV1,
    type EnvironmentSecretRequiredUseV1 } from '@happier-dev/deployments';
import type { Tx } from '@/storage/inTx';
import { deploymentInProgressStates, readDeploymentAcceptedExecution } from './deploymentAcceptedExecution';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { DeploymentFailure } from './deploymentAdmission';

type GrantRow = NonNullable<Awaited<ReturnType<Tx['machineSecretGrant']['findUnique']>>>;

function invalidGrant(): never {
    throw Object.assign(new Error('An exact Environment installation grant is unavailable'), { code: 'secret_missing' });
}

/** Index encoding only; the public canonical subject remains the grant identity. */
function storageKey(grant: MachineSecretGrantSubjectStoredReadV1): string {
    return createHash('sha256').update(machineSecretGrantSubjectKey(grant)).digest('hex');
}

/** Environment read admission may inspect exact grant coverage, never its sealed material. */
export async function readEnvironmentSecretGrantCoverageInTx(tx: Tx, input: Readonly<{
    environmentId: string;
    requiredSecretUses: readonly EnvironmentSecretRequiredUseV1[];
}>): Promise<Readonly<{ requiredGrantCount: number; missingGrantCount: number }>> {
    const keys = [...new Set(input.requiredSecretUses.map(use => storageKey({
        v: 1, kind: 'secret', environmentId: input.environmentId, ...use,
    })))];
    let found = 0;
    for (const chunk of portableQueryChunks({ values: keys, bindingsPerValue: 1 })) {
        found += (await tx.machineSecretGrant.findMany({
            where: { subjectKey: { in: [...chunk] } }, select: { subjectKey: true },
        })).length;
    }
    return { requiredGrantCount: keys.length, missingGrantCount: keys.length - found };
}

/** P21's admitted configure lifecycle is the Machine-scoped writer of the same installation table. */
export async function setMachineConnectorSecretGrantInTx(tx: Tx, input: Readonly<{
    subject: MachineConnectorSecretGrantSubjectV1;
    grant: MachineSecretGrantV1 | null;
}>): Promise<MachineSecretGrantV1 | null> {
    const subjectKey = storageKey(input.subject);
    const previous = await tx.machineSecretGrant.findUnique({ where: { subjectKey } });
    if (!input.grant) {
        if (previous) await tx.machineSecretGrant.delete({ where: { subjectKey } });
        return null;
    }
    const parsed = MachineSecretGrantV1Schema.safeParse(input.grant);
    if (!parsed.success || parsed.data.kind !== 'connectorToken'
        || machineSecretGrantSubjectKey(parsed.data) !== machineSecretGrantSubjectKey(input.subject)) return invalidGrant();
    if (!previous) await tx.machineSecretGrant.create({ data: grantRow(parsed.data) });
    else if (storedGrant(previous).sealedContent !== parsed.data.sealedContent) {
        await tx.machineSecretGrant.update({ where: { subjectKey }, data: { contentEnvelope: parsed.data.sealedContent } });
    }
    return parsed.data;
}

/** Exact Machine/installation/provider/connector demand only, never an inventory or Environment alias. */
export async function readMachineConnectorSecretGrantInTx(tx: Tx,
    subject: MachineConnectorSecretGrantSubjectV1,
): Promise<MachineSecretGrantV1 | null> {
    const row = await tx.machineSecretGrant.findUnique({ where: { subjectKey: storageKey(subject) } });
    return row ? storedGrant(row) : null;
}

function storedGrant(row: GrantRow): MachineSecretGrantV1 {
    const common = { v: 1, kind: row.kind, machineId: row.machineId,
        installationId: row.installationId, sealedContent: row.contentEnvelope };
    const parsed = MachineSecretGrantStoredReadV1Schema.safeParse(row.kind === 'secret'
        ? { ...common, environmentId: row.environmentId, resourceId: row.resourceId, resourceRevision: row.resourceRevision }
        : row.kind === 'environmentValues'
            // UUID references and legacy env identifiers have disjoint syntax. Reads
            // preserve old name subjects; new writes accept only the opaque arm.
            ? { ...common, environmentId: row.environmentId, binding: { purpose: 'variable', phase: row.phase,
                ...(EnvironmentVariableBindingGrantReferenceV1Schema.safeParse(row.name).success
                    ? { grantRef: row.name } : { name: row.name }) } }
            : { ...common, provider: row.providerPluginId === null
                ? { kind: 'builtin', id: row.providerLocalId }
                : { pluginId: row.providerPluginId, localId: row.providerLocalId }, connectorId: row.connectorId });
    if (!parsed.success || storageKey(parsed.data) !== row.subjectKey) return invalidGrant();
    return parsed.data;
}

function grantRow(grant: z.infer<typeof MachineSecretGrantV1Schema>) {
    return {
        subjectKey: storageKey(grant), kind: grant.kind, machineId: grant.machineId, installationId: grant.installationId,
        environmentId: grant.kind === 'connectorToken' ? null : grant.environmentId,
        resourceId: grant.kind === 'secret' ? grant.resourceId : null,
        resourceRevision: grant.kind === 'secret' ? grant.resourceRevision : null,
        phase: grant.kind === 'environmentValues' ? grant.binding.phase : null,
        // No plaintext environment-variable name is stored in the grant row.
        name: grant.kind === 'environmentValues' ? grant.binding.grantRef : null,
        // A null plugin id distinguishes a built-in reference in the existing columns.
        providerPluginId: grant.kind === 'connectorToken' && !('kind' in grant.provider) ? grant.provider.pluginId : null,
        providerLocalId: grant.kind === 'connectorToken'
            ? 'kind' in grant.provider ? grant.provider.id : grant.provider.localId : null,
        connectorId: grant.kind === 'connectorToken' ? grant.connectorId : null,
        contentEnvelope: grant.sealedContent,
    };
}

/** Called only inside the sole bindings/content CAS after current capture admission. */
export async function syncEnvironmentSecretGrantsInTx(tx: Tx, input: Readonly<{
    environmentId: string;
    grants: readonly MachineSecretGrantV1[];
    /** The semantic writer has proved unchanged immutable content and captures. */
    retainAcceptedBuildCustody?: true;
    /** The public semantic writer admits an actual seal mutation, not equal-seal maintenance. */
    admitMutation?: () => Promise<DeploymentFailure | null>;
}>): Promise<boolean | null | DeploymentFailure> {
    let changed = false;
    const desired = new Map<string, z.infer<typeof MachineSecretGrantV1Schema>>();
    for (const grant of input.grants) {
        const parsed = MachineSecretGrantV1Schema.safeParse(grant);
        if (!parsed.success || parsed.data.kind === 'connectorToken' || parsed.data.environmentId !== input.environmentId) return invalidGrant();
        const key = storageKey(parsed.data);
        if (desired.has(key)) return invalidGrant();
        desired.set(key, parsed.data);
    }
    const existing = new Map((await tx.machineSecretGrant.findMany({ where: { environmentId: input.environmentId } }))
        .map(row => [row.subjectKey, storedGrant(row)]));
    const acceptedBuilders = new Set((input.retainAcceptedBuildCustody ? await tx.deployment.findMany({
        where: { environmentId: input.environmentId, state: { in: deploymentInProgressStates() } },
        select: { acceptedControllerMachineId: true, acceptedControllerInstallationId: true,
            acceptedBuildMachineId: true, acceptedBuildInstallationId: true },
    }) : []).flatMap(row => {
        const accepted = readDeploymentAcceptedExecution(row);
        return accepted?.builder ? [JSON.stringify([accepted.builder.machineId, accepted.builder.installationId])] : [];
    }));
    const retainedBuild = (grant: MachineSecretGrantV1) => grant.kind !== 'connectorToken'
        && (grant.kind === 'secret' || grant.binding.phase === 'build')
        && acceptedBuilders.has(JSON.stringify([grant.machineId, grant.installationId]));
    // One subject has one live seal. Refuse all conflicts before any write;
    // accepted custody has no historical ciphertext fallback.
    if ([...desired].some(([key, grant]) => {
        const previous = existing.get(key);
        return previous && retainedBuild(previous) && previous.sealedContent !== grant.sealedContent;
    })) return null;
    const willChange = [...desired].some(([key, grant]) => existing.get(key)?.sealedContent !== grant.sealedContent)
        || [...existing].some(([key, grant]) => !desired.has(key) && !retainedBuild(grant));
    if (willChange && input.admitMutation) {
        const denied = await input.admitMutation();
        if (denied) return denied;
    }
    for (const [key, grant] of desired) {
        const previous = existing.get(key);
        if (!previous) {
            await tx.machineSecretGrant.create({ data: grantRow(grant) });
            changed = true;
        }
        else if (previous.sealedContent !== grant.sealedContent) {
            await tx.machineSecretGrant.update({ where: { subjectKey: key }, data: { contentEnvelope: grant.sealedContent } });
            changed = true;
        }
    }
    for (const [key, grant] of existing) {
        if (!desired.has(key) && !retainedBuild(grant)) {
            await tx.machineSecretGrant.delete({ where: { subjectKey: key } });
            changed = true;
        }
    }
    return changed;
}

/** The source backup uses one installation opens to read a copy. The copy read and the copy seal writer share it;
 * unknown routing stays incomplete and cannot be guessed from possession of an installation seal. */
export function readEnvironmentCopySourceRequiredUses(referencedSavedSecretRevisions: unknown,
    installation: Readonly<{ machineId: string; installationId: string }>): readonly EnvironmentSecretRequiredUseV1[] | null {
    const backupCaptures = selectEnvironmentSecretCapturePurposesV1(referencedSavedSecretRevisions, ['backupDestination']);
    const required = projectEnvironmentSecretBindingRequiredUsesV1({ referencedSavedSecretRevisions: backupCaptures,
        runtimeInstallations: [{ machineId: installation.machineId, installationId: installation.installationId }] });
    return required.status === 'complete' ? required.requiredSecretUses : null;
}

/** A cross-Machine copy restore's own seal of the source backup credential: the required uses for one admitted
 * recipient installation. It only creates subjects the installation lacks. It never deletes or rewrites an existing
 * seal: an installation that already holds a subject (a member, a builder, a controller) already opens it, and the
 * source's own writers keep their custody. */
export async function setEnvironmentCopyRestoreSealInTx(tx: Tx, input: Readonly<{
    environmentId: string;
    recipient: Readonly<{ machineId: string; installationId: string }>;
    requiredSecretUses: readonly EnvironmentSecretRequiredUseV1[];
    grants: readonly MachineSecretGrantV1[];
}>): Promise<boolean> {
    const required = new Set(input.requiredSecretUses.map(use => storageKey({ v: 1, kind: 'secret', environmentId: input.environmentId, ...use })));
    const desired = new Map<string, Extract<MachineSecretGrantV1, { kind: 'secret' }>>();
    for (const grant of input.grants) {
        const parsed = MachineSecretGrantV1Schema.safeParse(grant);
        if (!parsed.success || parsed.data.kind !== 'secret' || parsed.data.environmentId !== input.environmentId
            || parsed.data.machineId !== input.recipient.machineId || parsed.data.installationId !== input.recipient.installationId) return false;
        const key = storageKey(parsed.data);
        if (!required.has(key) || desired.has(key)) return false;
        desired.set(key, parsed.data);
    }
    if (desired.size !== required.size) return false;
    const present = new Set<string>();
    for (const chunk of portableQueryChunks({ values: [...desired.keys()], bindingsPerValue: 1 })) {
        (await tx.machineSecretGrant.findMany({ where: { subjectKey: { in: [...chunk] } }, select: { subjectKey: true } }))
            .forEach(row => present.add(row.subjectKey));
    }
    for (const [subjectKey, grant] of desired) {
        if (!present.has(subjectKey)) await tx.machineSecretGrant.create({ data: grantRow(grant) });
    }
    return true;
}

/** Private target read; authorization is established by the owning deployment admission. */
export async function readEnvironmentMachineSecretGrantsInTx(tx: Tx, input: Readonly<{
    environmentId: string;
    secret?: Readonly<{ resourceId: string; resourceRevision: number }>;
} & ({ machineId: string; installationId: string } | { machineId?: never; installationId?: never })>): Promise<MachineSecretGrantV1[]> {
    const { secret, ...subject } = input;
    return (await tx.machineSecretGrant.findMany({ where: { ...subject, ...(secret ? { kind: 'secret', ...secret } : {}) },
        orderBy: { subjectKey: 'asc' } })).map(storedGrant);
}

/** Resource revision changes retire delivery authority, never incumbent memory sanitizers. */
export async function deleteObsoleteSavedSecretInstallationGrantsInTx(tx: Tx, input: Readonly<{
    resourceId: string;
    revision: number;
}>): Promise<void> {
    await tx.machineSecretGrant.deleteMany({ where: { kind: 'secret', resourceId: input.resourceId,
        resourceRevision: { lt: input.revision } } });
}

/** Disposition withdraws future delivery custody; shared surviving installations keep their exact grants. */
export async function withdrawEnvironmentSecretGrantsInTx(tx: Tx, input: Readonly<{
    environmentId: string;
    withdrawnInstallations?: readonly Readonly<{ machineId: string; installationId: string }>[];
    retainedInstallations?: readonly Readonly<{ machineId: string; installationId: string }>[];
}>): Promise<void> {
    if (!input.withdrawnInstallations) {
        await tx.machineSecretGrant.deleteMany({ where: { environmentId: input.environmentId } });
        return;
    }
    const identity = (member: Readonly<{ machineId: string; installationId: string }>) => JSON.stringify([member.machineId, member.installationId]);
    const removed = new Set(input.withdrawnInstallations.map(identity));
    const retained = new Set((input.retainedInstallations ?? []).map(identity));
    const rows = await tx.machineSecretGrant.findMany({ where: { environmentId: input.environmentId },
        select: { subjectKey: true, machineId: true, installationId: true } });
    const keys = rows.filter(row => removed.has(identity(row)) && !retained.has(identity(row))).map(row => row.subjectKey);
    for (const chunk of portableQueryChunks({ values: keys, bindingsPerValue: 1 })) {
        await tx.machineSecretGrant.deleteMany({ where: { subjectKey: { in: [...chunk] } } });
    }
}
