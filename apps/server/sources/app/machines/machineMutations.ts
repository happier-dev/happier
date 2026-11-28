import { decodeMachineStoredContent, encodeMachineStoredContent } from '@/storage/sessionMachineStoredContent';
import { removeAutomationMachineAssignmentsTx } from "@/app/automations/automationMachineAssignmentRemoval";
import { type MachineKind, isPersistentMachine } from '@happier-dev/protocol/machines/machineKind';
import { isPlainMachineDataKeyMarker, machineStoredContentMatchesAccountMode } from "@happier-dev/protocol/machines/machineStoredContent";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { acquireAccountChangePublicationLocksInTx, beforeAccountChangePublication, markAccountChanged } from "@/app/changes/markAccountChanged";
import {
    buildNewMachineUpdate,
    buildUpdateMachineUpdate,
    eventRouter,
} from "@/app/events/eventRouter";
import { afterTx, TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { readMachineAccessKeySessionBindingsInTx } from "@/app/accessKeys/sessionMachineAccessKeyMutations";
import { serializeMachineKeyBasis } from "./machineSerialization";
import { acquireManagedMachinePublicationAccountsInTx, readMachineDevcontainerChildInTx, readManagedMachineInTx,
    readManagedAdmissionState, readManagedRowDeclarationBodiesInTx, type ManagedDeclarationBodies } from './managed/managedRows';
import { linkMachineEnrollmentInTx } from './machineEnrollment';
import { isDeploymentAppEnrollmentCorrelationV1, type MachineEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/enrollmentV1';
import { resolveMachineAccessInTx } from './machineAccess';
import { withManagedWakeAvailabilityInTx, invalidateManagedWakeControllerInTx,
    readManagedWakeControllerPublicationAccountIdsInTx } from './managed/managedWakeAvailability';

import {
    applyVerifiedMachineRegistrationReplacement,
    type MachineRegistrationReplacementResult,
} from "./applyVerifiedMachineRegistrationReplacement";
import type { VerifiedMachineInstallationIdentity } from "./installationProof";

function copyToArrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy;
}

export class MachineStorageModeMismatchError extends Error {
    readonly code = "machine_storage_mode_mismatch";

    constructor() {
        super("Machine content does not match the persisted Account encryption mode");
        this.name = "MachineStorageModeMismatchError";
    }
}

/** Normalize persistence only; callers must verify the complete signed proof first. */
export function resolveMachineContentPublicKeyFingerprintForStorage(params: Readonly<{
    dataEncryptionKey: string | Uint8Array | null | undefined;
    contentPublicKeyFingerprint: string | null;
}>): string | null {
    return isPlainMachineDataKeyMarker(params.dataEncryptionKey) ? null : params.contentPublicKeyFingerprint;
}

/** A peer key transition cannot make a legacy mutation return a plain carrier. */
export function recheckMachineStoredContentMutationAdmissionInTx(tx: Tx, input: Readonly<{
    accountId: string; machineId: string; supportsCurrentStoredContentProtocol: boolean;
}>): void {
    if (input.supportsCurrentStoredContentProtocol) return;
    beforeAccountChangePublication(tx, [input.accountId], async client => {
        const current = await client.machine.findFirst({ where: { id: input.machineId, accountId: input.accountId },
            select: { dataEncryptionKey: true } });
        if (current && isPlainMachineDataKeyMarker(current.dataEncryptionKey)) {
            throw new TransactionReplayRequiredError('transaction-account-audience-changed');
        }
    });
}

/** Persistent registration fences its predicates; Runner creation keeps activation's content admission. */
export async function acquireMachineRegistrationAccountsInTx(tx: Tx, input: Readonly<{
    accountId: string; machineId: string; kind?: MachineKind; managedEnrollment?: MachineEnrollmentCorrelationV1;
    installationIdentity?: VerifiedMachineInstallationIdentity | null;
    declarationBodies?: ManagedDeclarationBodies;
}>): Promise<ManagedDeclarationBodies | undefined> {
    const intent = isPersistentMachine(input) ? 'exclusive' : 'content';
    const managedEnrollment = input.managedEnrollment && !isDeploymentAppEnrollmentCorrelationV1(input.managedEnrollment)
        ? input.managedEnrollment : undefined;
    const declarationBodies = input.declarationBodies ?? (intent === 'exclusive' && managedEnrollment
        ? await readManagedRowDeclarationBodiesInTx(tx, await readManagedMachineInTx(tx, managedEnrollment)) : undefined);
    const replacesMachineId = input.installationIdentity?.replacesMachineId;
    const replacesMachine = replacesMachineId && replacesMachineId !== input.machineId && intent === 'exclusive'
        ? await tx.machine.findFirst({ where: { id: replacesMachineId, accountId: input.accountId, kind: 'persistent' },
            select: { id: true } })
        : null;
    const replacementControllers = replacesMachine ? [replacesMachine.id] : [];
    if (managedEnrollment) {
        await acquireManagedMachinePublicationAccountsInTx(tx, managedEnrollment,
            { intent, additionalAccountIds: [input.accountId], additionalMachineIds: [input.machineId],
                readAdditionalAccountIdsInTx: (client, row) => {
                    const previousId = readManagedAdmissionState(row.admittedInput).replacementEnrollment?.machineId;
                    return readManagedWakeControllerPublicationAccountIdsInTx(client,
                        previousId && previousId !== input.machineId ? [...replacementControllers, previousId] : replacementControllers);
                },
            });
    } else {
        const guestAccountIds = await readManagedWakeControllerPublicationAccountIdsInTx(tx, replacementControllers);
        await acquireAccountChangePublicationLocksInTx(tx, [input.accountId, ...guestAccountIds], { includeSingleAccount: true, intent });
    }
    return declarationBodies;
}

type MachineTerminalBinding = Readonly<{
    id: string;
    kind: MachineKind;
    accountId: string;
    terminalAuthRequestId: string | null;
    deploymentAppDeploymentId: string | null;
    replacedByMachineId: string | null;
}>;

type MachineRegistrationCredential = Readonly<{
    managedEnrollment?: MachineEnrollmentCorrelationV1;
    terminalAuthRequestId?: string;
}>;

export function readMachineRegistrationCredentialToBind(
    machine: MachineTerminalBinding,
    { managedEnrollment, terminalAuthRequestId }: MachineRegistrationCredential,
): string | undefined {
    if (managedEnrollment || machine.deploymentAppDeploymentId || machine.replacedByMachineId || !isPersistentMachine(machine)) {
        return undefined;
    }
    return terminalAuthRequestId === machine.terminalAuthRequestId ? undefined : terminalAuthRequestId;
}

/** The registration Account lock serializes writers for the signed, Account-owned terminal id. */
export async function bindMachineRegistrationCredentialInTx(
    tx: Tx,
    machine: MachineTerminalBinding,
    credential: MachineRegistrationCredential,
): Promise<void> {
    const terminalAuthRequestId = readMachineRegistrationCredentialToBind(machine, credential);
    if (!terminalAuthRequestId) return;
    const bound = await tx.machine.findUnique({ where: { terminalAuthRequestId }, select: { id: true } });
    if (bound) return;
    await tx.machine.update({
        where: { accountId_id: { accountId: machine.accountId, id: machine.id } },
        data: { terminalAuthRequestId },
    });
}

export async function createMachineWithInstallationIdentityInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        machineId: string;
        kind?: MachineKind;
        metadata: string;
        daemonState: string | null | undefined;
        dataEncryptionKey: string | null | undefined;
        /** Strict protocol parsing and creator-signature verification happen before this owner. */
        runnerContentKeyBinding?: Readonly<Record<string, unknown>> | null;
        installationIdentity: VerifiedMachineInstallationIdentity | null;
        contentPublicKeyFingerprint: string | null;
        replacementReason: string;
        managedEnrollment?: MachineEnrollmentCorrelationV1;
        declarationBodies?: ManagedDeclarationBodies;
        terminalAuthRequestId?: string;
    }>,
): Promise<Readonly<{
    machine: Awaited<ReturnType<Tx["machine"]["create"]>>;
    machineReplacement: MachineRegistrationReplacementResult | null;
}>> {
    const declarationBodies = await acquireMachineRegistrationAccountsInTx(tx, params);
    // Persistent registration must recheck Account mode in its creation transaction;
    // Runner content is admitted separately against its signed activation facts.
    if (isPersistentMachine(params)) {
        const account = await tx.account.findUnique({
            where: { id: params.accountId },
            select: { publicKey: true, encryptionMode: true, contentPublicKey: true, contentPublicKeySig: true },
        });
        const currentness = account ? deriveAccountEncryptionCurrentnessFromRow(account) : null;
        if (currentness?.status !== "ready" || !machineStoredContentMatchesAccountMode({
            mode: currentness.currentness.encryptionMode,
            metadata: params.metadata,
            ...(typeof params.daemonState === "string" ? { daemonState: params.daemonState } : {}),
            dataEncryptionKey: params.dataEncryptionKey,
        })) {
            throw new MachineStorageModeMismatchError();
        }
    }

    const machine = await tx.machine.create({
        data: encodeMachineStoredContent({
            id: params.machineId,
            kind: params.kind,
            accountId: params.accountId,
            metadata: params.metadata,
            metadataVersion: 1,
            daemonState: params.daemonState || null,
            daemonStateVersion: params.daemonState ? 1 : 0,
            dataEncryptionKey: params.dataEncryptionKey
                ? copyToArrayBufferBytes(Buffer.from(params.dataEncryptionKey, "base64"))
                : undefined,
            ...(params.runnerContentKeyBinding !== undefined
                ? { runnerContentKeyBinding: params.runnerContentKeyBinding }
                : {}),
            ...(params.installationIdentity
                ? {
                    installationId: params.installationIdentity.installationId,
                    installationPublicKey: params.installationIdentity.installationPublicKey,
                }
                : {}),
            contentPublicKeyFingerprint: resolveMachineContentPublicKeyFingerprintForStorage({
                dataEncryptionKey: params.dataEncryptionKey,
                contentPublicKeyFingerprint: params.installationIdentity
                    ? params.installationIdentity.contentPublicKeyFingerprint
                    : params.contentPublicKeyFingerprint,
            }),
            active: false,
        }),
    }).then(decodeMachineStoredContent);

    if (!params.managedEnrollment) await bindMachineRegistrationCredentialInTx(tx, machine, params);

    const machineReplacement = isPersistentMachine(machine) && params.installationIdentity?.replacesMachineId
        ? await applyVerifiedMachineRegistrationReplacement({
            tx,
            accountId: params.accountId,
            replacementMachineId: machine.id,
            replacementMachine: machine,
            replacesMachineId: params.installationIdentity.replacesMachineId,
            reason: params.replacementReason,
            terminalAuthRequestId: readMachineRegistrationCredentialToBind(machine, params),
        })
        : null;

    if (params.managedEnrollment) await linkMachineEnrollmentInTx(tx, params.managedEnrollment, params.accountId, machine.id, declarationBodies, params.terminalAuthRequestId);
    const [enrolled] = await withManagedWakeAvailabilityInTx(tx, [await tx.machine.findUniqueOrThrow({ where: { id: machine.id }, select: {
        managedResource: true,
    } })]);
    const child = await readMachineDevcontainerChildInTx(tx, machine.id);
    const access = await resolveMachineAccessInTx(tx, { actorAccountId: params.accountId, machineId: machine.id });
    const devcontainerChild = access?.accessState === 'ready' ? child : null;
    const cursor = await markAccountChanged(tx, {
        accountId: params.accountId,
        kind: "machine",
        entityId: machine.id,
    });

    afterTx(tx, () => {
        // Legacy inventory subscribers cannot distinguish temporary Machines.
        if (isPersistentMachine(machine)) {
            const newMachinePayload = buildNewMachineUpdate({ ...machine, ...enrolled, devcontainerChild }, cursor.resolveCursor(), randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId: params.accountId,
                payload: newMachinePayload,
                recipientFilter: { type: "user-scoped-only" },
            });
        }

        const updatePayload = buildUpdateMachineUpdate(
            machine.id,
            cursor.resolveCursor(),
            randomKeyNaked(12),
            { version: 1, value: params.metadata },
            undefined,
            { keyBasis: serializeMachineKeyBasis(machine), devcontainerChild },
        );
        eventRouter.emitUpdate({
            userId: params.accountId,
            payload: updatePayload,
            recipientFilter: { type: "machine-scoped-only", machineId: machine.id },
        });
    });

    return { machine, machineReplacement };
}

export type RevokeMachineInTxResult =
    | Readonly<{ ok: false; reason: "machine_not_found" }>
    | Readonly<{
        ok: true;
        machine: Awaited<ReturnType<Tx["machine"]["update"]>>;
        deletedAccessKeys: number;
    }>;

export async function revokeMachineInTx(
    tx: Tx,
    params: Readonly<{ accountId: string; machineId: string }>,
): Promise<RevokeMachineInTxResult> {
    const machine = await tx.machine.findFirst({
        where: { accountId: params.accountId, id: params.machineId },
    }).then(decodeMachineStoredContent);
    if (!machine) return { ok: false, reason: "machine_not_found" };

    const revokedAt = machine.revokedAt ?? new Date();
    let updated = machine;
    let invalidatedSessionBindings: Readonly<{ accountId: string; sessionId: string }>[] = [];
    let deletedAccessKeys = 0;

    // Automation owns assignment removal and stranded-Run settlement. Its
    // composition acquires the Account fence before invoking this mutation.
    await removeAutomationMachineAssignmentsTx({
        tx,
        accountId: params.accountId,
        machineId: params.machineId,
        markMachineUnavailableTx: async (fencedTx) => {
            invalidatedSessionBindings = await readMachineAccessKeySessionBindingsInTx(fencedTx, {
                accountId: params.accountId,
                machineId: params.machineId,
            });
            updated = await fencedTx.machine.update({
                where: {
                    accountId_id: {
                        accountId: params.accountId,
                        id: params.machineId,
                    },
                },
                data: { active: false, revokedAt },
            }).then(decodeMachineStoredContent);
            const deleted = await fencedTx.accessKey.deleteMany({
                where: {
                    machineId: params.machineId,
                },
            });
            deletedAccessKeys = deleted.count;
        },
    });

    await invalidateManagedWakeControllerInTx(tx, updated.id);
    const cursor = await markAccountChanged(tx, {
        accountId: params.accountId,
        kind: "machine",
        entityId: updated.id,
    });

    afterTx(tx, () => {
        eventRouter.disconnectMachineAndSessionSockets({
            accountId: params.accountId,
            machineId: params.machineId,
            terminalAuthRequestId: updated.terminalAuthRequestId,
            sessionBindings: invalidatedSessionBindings,
        });
        eventRouter.emitUpdate({
            userId: params.accountId,
            payload: buildUpdateMachineUpdate(
                updated.id,
                cursor.resolveCursor(),
                randomKeyNaked(12),
                undefined,
                undefined,
                { active: false, revokedAt: revokedAt.getTime(), devcontainerChild: null },
            ),
            recipientFilter: isPersistentMachine(updated)
                ? { type: "user-scoped-only" }
                : { type: "machine-scoped-only", machineId: updated.id },
        });
    });

    return { ok: true, machine: updated, deletedAccessKeys };
}
