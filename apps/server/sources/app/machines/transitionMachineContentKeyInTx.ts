import * as privacyKit from "privacy-kit";
import {
    MachineContentKeyTransitionInputV1Schema,
    type MachineContentKeyTransitionInputV1,
    type MachineContentKeyTransitionResultV1,
} from "@happier-dev/protocol/machines/machineContentKeyTransitionV1";
import { isPlainMachineDataKeyMarker, machineStoredContentMatchesAccountMode } from '@happier-dev/protocol/machines/machineStoredContent';
import { parseEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import { markAccountsChanged } from "@/app/changes/markAccountChanged";
import { acquireMachineAccessPublicationLocksInTx } from './machineAccess';
import { afterTx, type Tx } from "@/storage/inTx";
import { buildUpdateMachineUpdate, eventRouter } from "@/app/events/eventRouter";
import { randomKeyNaked } from "@/utils/keys/randomKeyNaked";
import { compareAndSwapMachineContentInTx } from "./compareAndSwapMachineContentInTx";
import { serializeMachineKeyBasis, serializeMachineRow } from "./machineSerialization";
import { readMachineDevcontainerChildInTx } from './managed/managedRows';
import { resolveCurrentMachineRecipientAccountIdsInTx } from "./machineAccess";

/** Only the custodian may inspect raw historical content that ordinary mode-aware readers lock. */
export async function readMachineContentKeySnapshotInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    machineId: string;
}>): Promise<ReturnType<typeof serializeMachineRow> | null> {
    const machine = await params.tx.machine.findUnique({ where: { id: params.machineId },
        include: { managedResource: { select: { id: true, homeId: true } } } });
    if (!machine || machine.accountId !== params.accountId || machine.kind !== "persistent"
        || machine.revokedAt || machine.replacedByMachineId) return null;
    const account = await params.tx.account.findUnique({ where: { id: params.accountId }, select: {
        encryptionMode: true, publicKey: true, contentPublicKey: true, contentPublicKeySig: true,
    } });
    if (!account || deriveAccountEncryptionCurrentnessFromRow(account).status !== "ready") return null;
    return serializeMachineRow(machine, {
        storageMode: isPlainMachineDataKeyMarker(machine.dataEncryptionKey) ? "plain" : "e2ee",
        devcontainerChild: await readMachineDevcontainerChildInTx(params.tx, machine.id),
    });
}

/** Owner conversion commits the matching envelope and both opaque ciphertexts as one basis. */
export async function transitionMachineContentKeyInTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    input: MachineContentKeyTransitionInputV1;
}>): Promise<MachineContentKeyTransitionResultV1<ReturnType<typeof serializeMachineRow>>> {
    const { tx, accountId } = params;
    const input = MachineContentKeyTransitionInputV1Schema.parse(params.input);
    await acquireMachineAccessPublicationLocksInTx(tx, input.machineId);
    const machine = await tx.machine.findUnique({ where: { id: input.machineId } });
    if (!machine || machine.accountId !== accountId) return { kind: "refused", code: "forbidden" };
    if (machine.kind !== "persistent" || machine.revokedAt || machine.replacedByMachineId) {
        return { kind: "refused", code: "machine_unavailable" };
    }
    const account = await tx.account.findUnique({ where: { id: accountId }, select: {
        encryptionMode: true, publicKey: true, contentPublicKey: true, contentPublicKeySig: true,
    } });
    if (!account) return { kind: "refused", code: "forbidden" };
    const currentness = deriveAccountEncryptionCurrentnessFromRow(account);
    if (currentness.status !== "ready") return { kind: "refused", code: "encryption_material_unavailable" };
    const targetMode = currentness.currentness.encryptionMode;
    const current = serializeMachineKeyBasis(machine);
    if (current.dataEncryptionKey !== input.expected.dataEncryptionKey
        || current.metadataVersion !== input.expected.metadataVersion
        || current.daemonStateVersion !== input.expected.daemonStateVersion) {
        return { kind: "conflict", current };
    }
    if (!machineStoredContentMatchesAccountMode({
        mode: "e2ee", metadata: machine.metadata,
        ...(machine.daemonState === null ? {} : { daemonState: machine.daemonState }),
        dataEncryptionKey: machine.dataEncryptionKey,
    })) return { kind: "refused", code: "machine_storage_mode_mismatch" };
    // An absent legacy owner envelope is convertible. Present malformed
    // material cannot be silently reinterpreted or replaced through this owner.
    if (machine.dataEncryptionKey !== null && !parseEncryptedDataKeyEnvelopeV1(machine.dataEncryptionKey)) {
        return { kind: "refused", code: "encryption_material_unavailable" };
    }
    if (!machineStoredContentMatchesAccountMode({
        mode: targetMode, metadata: input.next.metadata,
        ...(input.next.daemonState === null ? {} : { daemonState: input.next.daemonState }),
        dataEncryptionKey: input.next.dataEncryptionKey,
    })) return { kind: "refused", code: "machine_storage_mode_mismatch" };
    let nextEnvelope: ReturnType<typeof privacyKit.decodeBase64>;
    try {
        nextEnvelope = privacyKit.decodeBase64(input.next.dataEncryptionKey);
    } catch {
        return { kind: "refused", code: "encryption_material_unavailable" };
    }
    if ((targetMode === "e2ee" && !parseEncryptedDataKeyEnvelopeV1(nextEnvelope))
        || privacyKit.encodeBase64(nextEnvelope) !== input.next.dataEncryptionKey) {
        return { kind: "refused", code: "encryption_material_unavailable" };
    }
    const applied = await compareAndSwapMachineContentInTx({
        tx, accountId, machineId: machine.id, expected: input.expected,
        next: { ...input.next, ...(targetMode === "plain" ? { contentPublicKeyFingerprint: null } : {}) },
        currentness: { installationId: machine.installationId, revokedAt: null, replacedByMachineId: null },
    });
    if (!applied) {
        const fresh = await tx.machine.findUnique({ where: { id: machine.id } });
        if (!fresh || fresh.accountId !== accountId || fresh.revokedAt || fresh.replacedByMachineId) {
            return { kind: "refused", code: "machine_unavailable" };
        }
        return { kind: "conflict", current: serializeMachineKeyBasis(fresh) };
    }
    const committed = await tx.machine.findUniqueOrThrow({ where: { id: machine.id },
        include: { managedResource: { select: { id: true, homeId: true } } } });
    const devcontainerChild = await readMachineDevcontainerChildInTx(tx, machine.id);
    // Recipient tuples are bound to the retired owner wrapping. Wake their
    // existing row readers without publishing the new owner-only wrapping as a
    // caller-openable key; C41 will project pending until delivery is current.
    const cursors = await markAccountsChanged(tx, { accountIds: [accountId,
        ...await resolveCurrentMachineRecipientAccountIdsInTx(tx, machine.id)], kind: "machine", entityId: machine.id });
    const cursor = cursors.find(recipient => recipient.accountId === accountId);
    if (cursor === undefined) throw new Error("Machine owner is missing from its publication audience");
    afterTx(tx, () => {
        eventRouter.emitUpdate({
            userId: accountId,
            payload: buildUpdateMachineUpdate(machine.id, cursor.resolveCursor(), randomKeyNaked(12),
                { value: committed.metadata, version: committed.metadataVersion },
                { value: committed.daemonState, version: committed.daemonStateVersion },
                { dataEncryptionKey: privacyKit.encodeBase64(nextEnvelope), keyBasis: serializeMachineKeyBasis(committed), devcontainerChild }),
            recipientFilter: { type: "machine-scoped-only", machineId: machine.id },
        });
    });
    return { kind: "committed", machine: serializeMachineRow(committed, { storageMode: targetMode, devcontainerChild }) };
}
