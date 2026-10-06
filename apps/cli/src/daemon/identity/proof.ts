import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import type { ContentPublicKeyFingerprint, MachineInstallationIdentityV1, MachineInstallationProofPayloadV1, MachineInstallationProofV1, MachineReplacementReason, MachineReplacementRegistrationIntent } from '@happier-dev/protocol';

import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';

export type InstallationMachineProofBundle = Readonly<{
    installationId: string;
    installationPublicKey: string;
    installationProof: MachineInstallationProofV1;
    payload: MachineInstallationProofPayloadV1;
    contentPublicKeyFingerprint?: ContentPublicKeyFingerprint;
    replacesMachineId?: string;
    replacementReason?: MachineReplacementReason;
}>;

export function buildInstallationProofForMachine(params: Readonly<{
    identity: MachineInstallationIdentityV1;
    machineId: string;
    token: string;
    contentPublicKey?: Uint8Array;
    replacementIntent?: MachineReplacementRegistrationIntent | null;
}>): InstallationMachineProofBundle {
    const contentPublicKeyFingerprint = params.contentPublicKey
        ? computeContentPublicKeyFingerprint(params.contentPublicKey)
        : undefined;
    const accountId = readAccountIdFromToken(params.token) ?? undefined;
    const payload: MachineInstallationProofPayloadV1 = {
        version: 1,
        installationId: params.identity.installationId,
        machineId: params.machineId,
        ...(params.replacementIntent?.replacesMachineId
            ? { replacesMachineId: params.replacementIntent.replacesMachineId }
            : null),
        ...(params.replacementIntent?.replacementReason
            ? { replacementReason: params.replacementIntent.replacementReason }
            : null),
        ...(contentPublicKeyFingerprint ? { contentPublicKeyFingerprint } : null),
        ...(accountId ? { accountId } : null),
    };

    return {
        installationId: params.identity.installationId,
        installationPublicKey: params.identity.publicKey,
        installationProof: signMachineInstallationProof({
            payload,
            privateKey: params.identity.privateKey,
        }),
        payload,
        ...(contentPublicKeyFingerprint ? { contentPublicKeyFingerprint } : null),
        ...(params.replacementIntent?.replacesMachineId
            ? {
                replacesMachineId: params.replacementIntent.replacesMachineId,
                replacementReason: params.replacementIntent.replacementReason,
            }
            : null),
    };
}
