import { afterTx, type Tx } from "@/storage/inTx";
import { eventRouter } from "@/app/events/eventRouter";
import { machineInstallationPublicKeysEqual, type VerifiedMachineInstallationIdentity } from "./installationProof";
import { resolveMachineContentPublicKeyFingerprintForStorage } from "./machineMutations";
import { invalidateManagedMachineInTx } from "./managed/managedRows";

type ExistingMachineInstallationIdentity = Readonly<{
    dataEncryptionKey: Uint8Array | null;
    installationId?: string | null;
    installationPublicKey?: Uint8Array | null;
    contentPublicKeyFingerprint?: string | null;
}>;

export type InstallationIdentityUpdateResolution =
    | Readonly<{
        ok: true;
        data: {
            installationId?: string;
            installationPublicKey?: Uint8Array<ArrayBuffer>;
            contentPublicKeyFingerprint?: string | null;
        };
    }>
    | Readonly<{ ok: false; reason: string }>;

export function resolveInstallationIdentityUpdate(
    machine: ExistingMachineInstallationIdentity,
    identity: VerifiedMachineInstallationIdentity | null,
): InstallationIdentityUpdateResolution {
    if (!identity) {
        return { ok: true, data: {} };
    }

    const currentFingerprint = resolveMachineContentPublicKeyFingerprintForStorage({
        dataEncryptionKey: machine.dataEncryptionKey,
        contentPublicKeyFingerprint: machine.contentPublicKeyFingerprint ?? null,
    });
    const incomingFingerprint = resolveMachineContentPublicKeyFingerprintForStorage({
        dataEncryptionKey: machine.dataEncryptionKey,
        contentPublicKeyFingerprint: identity.contentPublicKeyFingerprint,
    });
    if (
        currentFingerprint
        && incomingFingerprint
        && currentFingerprint !== incomingFingerprint
    ) {
        return { ok: false, reason: "content_public_key_fingerprint_mismatch" };
    }

    return {
        ok: true,
        data: {
            ...(machine.installationId !== identity.installationId ? { installationId: identity.installationId } : {}),
            ...(!machineInstallationPublicKeysEqual(machine.installationPublicKey, identity.installationPublicKey)
                ? { installationPublicKey: identity.installationPublicKey } : {}),
            ...((machine.contentPublicKeyFingerprint ?? null) !== (currentFingerprint ?? incomingFingerprint)
                ? { contentPublicKeyFingerprint: currentFingerprint ?? incomingFingerprint }
                : {}),
        },
    };
}

/** Registration has admitted the Account and signature; keep managed controllers on that Machine. */
export async function updateMachineInstallationIdentityInTx(
    tx: Tx,
    machine: ExistingMachineInstallationIdentity & Readonly<{ id: string; accountId: string }>,
    data: Extract<InstallationIdentityUpdateResolution, { ok: true }>["data"],
) {
    const updated = await tx.machine.update({ where: { accountId_id: { accountId: machine.accountId, id: machine.id } }, data });
    if (data.installationId && data.installationId !== machine.installationId) {
        const managed = await tx.managedMachine.findMany({ where: { custodianAccountId: machine.accountId,
            controllerMachineId: machine.id, controllerInstallationId: { not: data.installationId } } });
        for (const row of managed) {
            await tx.managedMachine.update({ where: { id: row.id }, data: { controllerInstallationId: data.installationId } });
            await invalidateManagedMachineInTx(tx, row);
        }
    }
    if (data.installationId && data.installationId !== machine.installationId) {
        await tx.managedMachinePreset.updateMany({ where: { custodianAccountId: machine.accountId,
            controllerMachineId: machine.id, controllerInstallationId: { not: data.installationId } },
            data: { controllerInstallationId: data.installationId } });
    }
    if (data.installationId !== undefined || data.installationPublicKey !== undefined) {
        afterTx(tx, () => eventRouter.disconnectMachineAndSessionSockets({
            accountId: machine.accountId, machineId: machine.id, sessionBindings: [],
        }));
    }
    return updated;
}
