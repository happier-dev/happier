import { completeAccountAuthRequest } from '@/auth/flows/accountCompletion';
import type { HomeQrEnrollmentTarget } from '@/auth/flows/qrStart';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { resolveProvisioningMaterial } from '@/auth/terminal/resolveProvisioningMaterial';
import { buildTerminalResponseV3, buildTerminalTokenOnlyResponseV3 } from '@/auth/terminal/terminalProvisioning';
import {
    deriveHomeQrBindingKeyV2,
    type HomeQrInviteDirectionV2,
} from '@happier-dev/protocol/crypto/qrProvisioningV2';

export type TrustedHomeQrCompletionContext = Readonly<{
    direction: HomeQrInviteDirectionV2;
    pairId: string;
    target: HomeQrEnrollmentTarget;
    qrSecret: Uint8Array;
    issuedAtMs: number;
    expiresAtMs: number;
}>;

export class InvalidTrustedHomeQrRequestError extends Error {
    readonly code = 'invalid_trusted_home_qr_request' as const;

    constructor() {
        super('The Home QR request did not match the captured invite');
        this.name = 'InvalidTrustedHomeQrRequestError';
    }
}

/** Local credential/material sealing after the protocol owner verifies the requester. */
export async function completeTrustedHomeQrPairingRequest(input: Readonly<{
    context: TrustedHomeQrCompletionContext;
    requesterPublicKey: Uint8Array;
    signal?: AbortSignal;
}>): Promise<'completed' | 'already_completed'> {
    const { context, requesterPublicKey } = input;

    const credentials = await TokenStorage.getCredentialsForServerUrl(
        context.target.descriptor.canonicalServerUrl,
        { serverId: context.target.serverId },
    );
    if (input.signal?.aborted) {
        throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    }
    if (!credentials) throw new InvalidTrustedHomeQrRequestError();
    const material = await resolveProvisioningMaterial(credentials);
    if (input.signal?.aborted) {
        throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    }
    const common = {
        terminalEphemeralPublicKey: requesterPublicKey,
        pairingSecret: deriveHomeQrBindingKeyV2(context.qrSecret),
        createdAtMs: context.issuedAtMs,
        expiresAtMs: context.expiresAtMs,
    };
    const response = material.type === 'tokenOnly'
        ? buildTerminalTokenOnlyResponseV3(common)
        : buildTerminalResponseV3({ ...common, contentPrivateKey: material.key });
    if (input.signal?.aborted) {
        throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    }

    return await completeAccountAuthRequest({
        token: credentials.token,
        target: context.target,
        pairId: context.pairId,
        publicKey: requesterPublicKey,
        response,
        homeServerIdentityId: context.target.descriptor.homeServerIdentityId,
        responseKind: material.type,
        signal: input.signal,
    });
}
