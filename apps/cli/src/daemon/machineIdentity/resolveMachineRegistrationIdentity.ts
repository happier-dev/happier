import type { MachineInstallationProofPayloadV1 } from '@happier-dev/protocol';

import type { MachineRegistrationIdentity } from '@/api/types';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { buildInstallationProofForMachine } from '@/daemon/identity/proof';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';

import { readMachineReplacementCandidateForActiveServer } from './machineReplacementCandidates';

export type ResolvedMachineRegistrationIdentity = MachineRegistrationIdentity & Readonly<{
    payload: MachineInstallationProofPayloadV1;
}>;

export function readAccountIdFromToken(token: string): string | null {
    try {
        const payload = decodeJwtPayload(token);
        if (!payload || typeof payload !== 'object') {
            return null;
        }
        return typeof payload.sub === 'string' && payload.sub.trim() ? payload.sub.trim() : null;
    } catch {
        return null;
    }
}

export async function resolveMachineRegistrationIdentity(params: Readonly<{
    machineId: string;
    token: string;
    contentPublicKey?: Uint8Array;
}>): Promise<ResolvedMachineRegistrationIdentity> {
    const identity = await readOrCreateInstallationIdentity();
    const accountId = readAccountIdFromToken(params.token);
    const replacementCandidate = await readMachineReplacementCandidateForActiveServer({ accountId });
    const proof = buildInstallationProofForMachine({
        identity,
        machineId: params.machineId,
        token: params.token,
        contentPublicKey: params.contentPublicKey,
        replacementIntent: replacementCandidate
            ? {
                replacesMachineId: replacementCandidate.machineId,
                replacementReason: replacementCandidate.replacementReason,
            }
            : null,
    });

    return {
        installationId: proof.installationId,
        installationPublicKey: proof.installationPublicKey,
        installationProof: proof.installationProof,
        payload: proof.payload,
        ...(proof.replacesMachineId ? { replacesMachineId: proof.replacesMachineId } : null),
        ...(proof.replacementReason ? { replacementReason: proof.replacementReason } : null),
        ...(proof.contentPublicKeyFingerprint ? { contentPublicKeyFingerprint: proof.contentPublicKeyFingerprint } : null),
        ...(proof.replacesMachineId && accountId ? { replacementCandidateAccountId: accountId } : null),
    };
}
