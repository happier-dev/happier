import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { z } from 'zod';

import { createCanonicalJsonSigningInput } from '../../../../crypto/canonicalJson.js';

export const PeerMachineRpcCommandReceiptIssuerV1Schema = z.enum(['ui', 'daemon']);

export const PeerMachineRpcCommandReceiptRequestV1Schema = z
  .object({
    v: z.literal(1),
    issuer: PeerMachineRpcCommandReceiptIssuerV1Schema,
    issuedAtMs: z.number().int().nonnegative(),
    requestHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    replayKey: z.string().min(1),
    resultHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  })
  .strict();

export const PeerMachineRpcCommandReceiptSuccessV1Schema = PeerMachineRpcCommandReceiptRequestV1Schema.extend({
  issuer: z.literal('daemon'),
  resultHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
}).strict();

export type PeerMachineRpcCommandReceiptIssuerV1 = z.infer<typeof PeerMachineRpcCommandReceiptIssuerV1Schema>;
export type PeerMachineRpcCommandReceiptRequestV1 = z.infer<typeof PeerMachineRpcCommandReceiptRequestV1Schema>;
export type PeerMachineRpcCommandReceiptSuccessV1 = z.infer<typeof PeerMachineRpcCommandReceiptSuccessV1Schema>;

function computeSha256Digest(value: string): string {
  return `sha256:${bytesToHex(sha256(utf8ToBytes(value)))}`;
}

export function createPeerMachineRpcRequestHashV1(input: Readonly<{
  method: string;
  params: unknown;
  grantId: string;
  endpointFingerprint: string;
  replayKey: string;
}>): string {
  return computeSha256Digest(createCanonicalJsonSigningInput({
    v: 1,
    method: input.method,
    params: input.params,
    grantId: input.grantId,
    endpointFingerprint: input.endpointFingerprint,
    replayKey: input.replayKey,
  }));
}

export function createPeerMachineRpcResultHashV1(result: unknown): string {
  return computeSha256Digest(createCanonicalJsonSigningInput({
    v: 1,
    result,
  }));
}
