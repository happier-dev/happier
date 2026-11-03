import { readMachineDaemonOwnershipMetadataFromSocketAuth } from '@happier-dev/protocol/machines/ownership/daemonOwnership';

import {
    machineInstallationPublicKeysEqual,
    validateMachineInstallationProof,
} from "@/app/machines/installationProof";

export const VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY = "verifiedMachineInstallationId";

export type MachineSocketInstallationRow = Readonly<{
    installationId: string | null;
    installationPublicKey: Uint8Array | null;
}>;

export type MachineSocketInstallationIdentity =
    | Readonly<{ kind: 'verified'; installationId: string }>
    | Readonly<{ kind: 'unverified' }>
    | Readonly<{ kind: 'displaced' }>;

/** Valid proofs identify the current or displaced installation; legacy proofs remain unverified. */
export function resolveMachineSocketInstallationIdentity(params: Readonly<{
    accountId: string;
    machineId: string;
    machine: MachineSocketInstallationRow;
    socketAuth: unknown;
}>): MachineSocketInstallationIdentity {
    const ownership = readMachineDaemonOwnershipMetadataFromSocketAuth(params.socketAuth);
    const verification = validateMachineInstallationProof({
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
    if (!verification.ok || !verification.identity) return { kind: 'unverified' };
    if (params.machine.installationId !== verification.identity.installationId) return { kind: 'displaced' };
    if (!machineInstallationPublicKeysEqual(
        params.machine.installationPublicKey,
        verification.identity.installationPublicKey,
    )) {
        return { kind: 'displaced' };
    }
    return { kind: 'verified', installationId: verification.identity.installationId };
}

/** Existing attestation consumers need only the verified installation, not the refusal classification. */
export function resolveVerifiedMachineSocketInstallationId(
    params: Parameters<typeof resolveMachineSocketInstallationIdentity>[0],
): string | null {
    const identity = resolveMachineSocketInstallationIdentity(params);
    return identity.kind === 'verified' ? identity.installationId : null;
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
