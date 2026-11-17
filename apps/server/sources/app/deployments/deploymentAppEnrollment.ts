import { isDeepStrictEqual } from 'node:util';
import * as privacyKit from 'privacy-kit';
import nacl from 'tweetnacl';
import type { Prisma } from '@prisma/client';
import { DeploymentAppEnrollmentCorrelationV1Schema, type DeploymentAppEnrollmentCorrelationV1,
    type DeploymentAppMachineAssociationV1 } from '@happier-dev/protocol/machines/enrollmentV1';
import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { ManagedMachineError } from '@/app/machines/managed/managedRows';
import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import { readCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { resolveTerminalAuthRequestPolicyFromEnv, terminalAuthRequestExpiresAt } from '@/app/api/routes/auth/terminalAuthRequestPolicy';
import { deploymentInProgressStates, isOwnServerDeploymentTarget, readDeploymentAcceptedExecution } from './deploymentAcceptedExecution';

type Publisher = Readonly<{ machineId: string; installationId: string }>;
const receiptProjection = {
    id: true, environmentId: true, targetLinkId: true,
    acceptedControllerMachineId: true, acceptedControllerInstallationId: true,
    environment: { select: { deletedAt: true } }, targetLink: { select: { deletedAt: true, detachedAt: true } },
} satisfies Prisma.DeploymentSelect;

/** The accepted Compose controller binds existing pairing; no separate pending enrollment owner. */
export async function admitDeploymentAppEnrollmentInTx(tx: Tx, input: DeploymentAppEnrollmentCorrelationV1,
    publisher: Publisher, continuation: Readonly<{ pairingPublicKey?: string; existingMachineId?: string }> = {}) {
    const canonical = DeploymentAppEnrollmentCorrelationV1Schema.parse(input);
    const row = await tx.deployment.findUnique({ where: { id: canonical.deploymentId }, include: { targetLink: true } });
    const accepted = row && readDeploymentAcceptedExecution(row);
    if (!row || !accepted || canonical.homeId !== await readCurrentServerIdentityId(process.env, tx)
        || row.environmentId !== canonical.environmentId || row.actionOperationId !== canonical.actionOperationId
        || accepted.controller.machineId !== publisher.machineId || accepted.controller.installationId !== publisher.installationId
        || canonical.controller.machineId !== publisher.machineId || canonical.controller.installationId !== publisher.installationId
        || !isOwnServerDeploymentTarget(row.targetLink) || row.operation === 'teardown') {
        return { ok: false as const, error: 'deployment_access_denied' as const };
    }
    if (row.cancelRequestedAt || !deploymentInProgressStates().includes(row.state)) {
        return { ok: false as const, error: 'deployment_conflict' as const };
    }
    if (continuation.pairingPublicKey && continuation.existingMachineId) return { ok: false as const, error: 'deployment_invalid' as const };
    if (continuation.pairingPublicKey) {
        let key: Uint8Array;
        try { key = privacyKit.decodeBase64(continuation.pairingPublicKey); }
        catch { return { ok: false as const, error: 'deployment_invalid' as const }; }
        if (key.length !== nacl.box.publicKeyLength) return { ok: false as const, error: 'deployment_invalid' as const };
        const request = await tx.terminalAuthRequest.findUnique({ where: { publicKey: privacyKit.encodeHex(key) } });
        if (!request || Date.now() >= terminalAuthRequestExpiresAt(request.createdAt, resolveTerminalAuthRequestPolicyFromEnv(process.env))
            || request.responseAccountId !== null && request.responseAccountId !== row.requestedByAccountId
            || request.deploymentAppEnrollment !== null && !isDeepStrictEqual(request.deploymentAppEnrollment, canonical)) {
            return { ok: false as const, error: 'deployment_conflict' as const };
        }
        if (request.deploymentAppEnrollment === null) await tx.terminalAuthRequest.update({ where: { id: request.id },
            data: { deploymentAppEnrollment: canonical } });
    }
    if (continuation.existingMachineId) {
        const machine = await tx.machine.findUnique({ where: { id: continuation.existingMachineId } });
        const previous = machine?.deploymentAppDeploymentId && await tx.deployment.findUnique({ where: { id: machine.deploymentAppDeploymentId },
            select: { environmentId: true } });
        if (!machine || machine.accountId !== row.requestedByAccountId || classifyMachineAvailabilityState(machine) !== 'available'
            || !machine.installationId || machine.id === publisher.machineId || machine.installationId === publisher.installationId
            || !previous || previous.environmentId !== row.environmentId) return { ok: false as const, error: 'deployment_conflict' as const };
        if (machine.deploymentAppDeploymentId !== row.id) await tx.machine.update({ where: { id: machine.id },
            data: { deploymentAppDeploymentId: row.id } });
    }
    return { ok: true as const, enrollment: canonical, enrollmentAccountId: row.requestedByAccountId,
        ...(continuation.existingMachineId ? { machineId: continuation.existingMachineId } : {}) };
}

/** Approval and registration consume only the admitted request's Account and active-job fact. */
export async function deploymentAppTerminalEnrollmentIsActiveInTx(tx: Tx, input: unknown, accountId: string): Promise<boolean> {
    const parsed = DeploymentAppEnrollmentCorrelationV1Schema.safeParse(input);
    if (!parsed.success) return false;
    const row = await tx.deployment.findUnique({ where: { id: parsed.data.deploymentId },
        select: { requestedByAccountId: true, state: true, cancelRequestedAt: true } });
    return !!row && row.requestedByAccountId === accountId && row.cancelRequestedAt === null
        && deploymentInProgressStates().includes(row.state);
}

/** The installed child's ordinary registration is the sole producer of its completed association. */
export async function linkDeploymentAppEnrollmentInTx(tx: Tx, input: DeploymentAppEnrollmentCorrelationV1,
    accountId: string, machineId: string, terminalAuthRequestId?: string): Promise<void> {
    const machine = await tx.machine.findUnique({ where: { id: machineId } });
    if (!machine || machine.accountId !== accountId || classifyMachineAvailabilityState(machine) !== 'available'
        || !machine.installationId || machine.id === input.controller.machineId
        || machine.installationId === input.controller.installationId) throw new ManagedMachineError('resource_mismatch');
    if (machine.deploymentAppDeploymentId === input.deploymentId) return;
    if (machine.deploymentAppDeploymentId || !terminalAuthRequestId) throw new ManagedMachineError('enrollment_retired');
    const request = await tx.terminalAuthRequest.findUnique({ where: { id: terminalAuthRequestId },
        select: { deploymentAppEnrollment: true, responseAccountId: true } });
    if (!request || request.responseAccountId !== accountId || !isDeepStrictEqual(request.deploymentAppEnrollment, input)
        || !await deploymentAppTerminalEnrollmentIsActiveInTx(tx, request.deploymentAppEnrollment, accountId)) {
        throw new ManagedMachineError('enrollment_retired');
    }
    await tx.machine.update({ where: { id: machineId }, data: { deploymentAppDeploymentId: input.deploymentId } });
}

/** Existing Machine reads supply the pointer; ordinary Machines add no receipt lookup. */
export async function readDeploymentAppEnrollmentsForMachinesInTx(tx: Tx,
    input: Readonly<{ machines: readonly Readonly<{ id: string; deploymentAppDeploymentId: string | null;
        revokedAt: Date | null; replacedByMachineId: string | null }>[] }>): Promise<ReadonlyMap<string, DeploymentAppMachineAssociationV1>> {
    const result = new Map<string, DeploymentAppMachineAssociationV1>();
    const machines = input.machines;
    const ids = [...new Set(machines.flatMap(machine => machine.deploymentAppDeploymentId ? [machine.deploymentAppDeploymentId] : []))];
    if (!ids.length) return result;
    const byId = new Map<string, Prisma.DeploymentGetPayload<{ select: typeof receiptProjection }>>();
    for (const chunk of portableQueryChunks({ values: ids, bindingsPerValue: 1 })) {
        const receipts = await tx.deployment.findMany({ where: { id: { in: [...chunk] } }, select: receiptProjection });
        for (const receipt of receipts) byId.set(receipt.id, receipt);
    }
    for (const machine of machines) {
        const receipt = machine.deploymentAppDeploymentId && byId.get(machine.deploymentAppDeploymentId);
        if (classifyMachineAvailabilityState(machine) !== 'available' || !receipt || receipt.environment.deletedAt
            || receipt.targetLink.deletedAt || receipt.targetLink.detachedAt
            || !receipt.acceptedControllerMachineId || !receipt.acceptedControllerInstallationId) continue;
        result.set(machine.id, { environmentId: receipt.environmentId, deploymentId: receipt.id, targetLinkId: receipt.targetLinkId,
            controller: { machineId: receipt.acceptedControllerMachineId, installationId: receipt.acceptedControllerInstallationId } });
    }
    return result;
}

export async function readDeploymentAppEnrollmentForMachineInTx(tx: Tx,
    input: Readonly<{ machineId: string }>): Promise<DeploymentAppMachineAssociationV1 | null> {
    const machine = await tx.machine.findUnique({ where: { id: input.machineId },
        select: { id: true, deploymentAppDeploymentId: true, revokedAt: true, replacedByMachineId: true } });
    return machine ? (await readDeploymentAppEnrollmentsForMachinesInTx(tx, { machines: [machine] })).get(machine.id) ?? null : null;
}
