import { readMachineDaemonOwnershipMetadataFromSocketAuth } from "@happier-dev/protocol";

import {
    machineInstallationPublicKeysEqual,
    verifyMachineInstallationRegistration,
} from "@/app/machines/installationProof";

export const VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY = "verifiedMachineInstallationId";

export type MachineSocketInstallationRow = Readonly<{
    installationId: string | null;
    installationPublicKey: Uint8Array | null;
}>;

/**
 * Verifies the machine-scoped Socket proof against the persisted installation
 * identity. A missing or invalid proof stays compatible for general machine
 * sockets, but it cannot attest a reserved server-origin daemon method.
 */
export function resolveVerifiedMachineSocketInstallationId(params: Readonly<{
    accountId: string;
    machineId: string;
    machine: MachineSocketInstallationRow;
    socketAuth: unknown;
}>): string | null {
    const ownership = readMachineDaemonOwnershipMetadataFromSocketAuth(params.socketAuth);
    const verification = verifyMachineInstallationRegistration({
        accountId: params.accountId,
        machineId: params.machineId,
        installationId: ownership.installationId,
        installationPublicKey: ownership.installationPublicKey,
        installationProof: ownership.installationProof,
        replacesMachineId: null,
        replacementReason: null,
        // The connection proof is freshly signed for this Socket and does not
        // carry machine-registration-only replacement/content-key fields.
        contentPublicKeyFingerprint: null,
    });
    if (!verification.ok || !verification.identity) return null;
    if (params.machine.installationId !== verification.identity.installationId) return null;
    if (!machineInstallationPublicKeysEqual(
        params.machine.installationPublicKey,
        verification.identity.installationPublicKey,
    )) {
        return null;
    }
    return verification.identity.installationId;
}

/** Reads only the identity the Socket authentication owner has attested. */
export function readVerifiedMachineSocketInstallationIdFromSocketData(socketData: unknown): string | null {
    if (!socketData || typeof socketData !== "object" || Array.isArray(socketData)) return null;
    const installationId = (socketData as Record<string, unknown>)[
        VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY
    ];
    if (typeof installationId !== "string") return null;
    const trimmed = installationId.trim();
    return trimmed || null;
}
