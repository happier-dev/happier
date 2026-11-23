import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { deriveHomeQrBindingKeyV2 } from '@happier-dev/protocol/crypto/qrProvisioningV2';
import {
  sealTerminalProvisioningV3Payload,
  sealTerminalProvisioningV3TokenOnlyPayload,
  type TerminalProvisioningV2Response,
} from '@happier-dev/protocol/crypto/terminalProvisioningV2';

import { CredentialRequestRedirectError } from '../homeTarget/credentialRequestRedirectPolicy.js';

export class InvalidAccountCompletionTargetError extends Error {
  readonly code = 'invalid_target' as const;

  constructor() {
    super('Account completion target does not match the bound Home identity');
    this.name = 'InvalidAccountCompletionTargetError';
  }
}

export class AccountCompletionError extends Error {
  readonly code = 'account_completion_failed' as const;

  constructor(readonly status: number, readonly retryable: boolean) {
    super(`Failed to complete account auth request: ${status}`);
    this.name = 'AccountCompletionError';
  }
}

export type HomeQrCompletionTarget = Readonly<{
  homeServerIdentityId: string;
  request: (path: string, init: RequestInit) => Promise<Response>;
}>;

/** Seal locally supplied material for the requester already verified by the Home QR lifecycle. */
export async function completeHomeQrRequest(params: Readonly<{
  target: HomeQrCompletionTarget;
  context: Readonly<{
    pairId: string;
    homeServerIdentityId: string;
    qrSecret: Uint8Array;
    issuedAtMs: number;
    expiresAtMs: number;
  }>;
  requesterPublicKey: Uint8Array;
  material: TerminalProvisioningV2Response;
  randomBytes: (length: number) => Uint8Array;
  signal?: AbortSignal;
}>): Promise<'completed' | 'already_completed'> {
  const { target, context, requesterPublicKey, material, randomBytes, signal } = params;
  if (target.homeServerIdentityId !== context.homeServerIdentityId) {
    throw new InvalidAccountCompletionTargetError();
  }
  if (signal?.aborted) throw new AccountCompletionError(0, true);

  const common = {
    terminalEphemeralPublicKey: requesterPublicKey,
    pairingSecret: deriveHomeQrBindingKeyV2(context.qrSecret),
    createdAtMs: context.issuedAtMs,
    expiresAtMs: context.expiresAtMs,
    randomBytes,
  };
  const sealed = material.type === 'tokenOnly'
    ? sealTerminalProvisioningV3TokenOnlyPayload(common)
    : sealTerminalProvisioningV3Payload({ ...common, contentPrivateKey: material.key });

  let response: Response;
  try {
    response = await target.request('/v1/auth/account/response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(signal ? { signal } : {}),
      body: JSON.stringify({
        pairId: context.pairId,
        publicKey: encodeBase64(requesterPublicKey, 'base64'),
        response: encodeBase64(sealed, 'base64'),
        homeServerIdentityId: context.homeServerIdentityId,
        responseKind: material.type,
      }),
    });
  } catch (error) {
    if (error instanceof CredentialRequestRedirectError) throw error;
    throw new AccountCompletionError(0, true);
  }
  if (response.ok) return 'completed';
  if (response.status === 409) {
    const body: unknown = await response.json().catch(() => null);
    if (body && typeof body === 'object' && 'error' in body && body.error === 'already_completed') {
      return 'already_completed';
    }
  }
  throw new AccountCompletionError(
    response.status,
    response.status === 408 || response.status === 429 || response.status >= 500,
  );
}
