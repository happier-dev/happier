import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

/** Exact current owner-envelope identity for conditional Machine recipient delivery. */
export function computeMachineOwnerEnvelopeFingerprintV1(envelope: Uint8Array): string {
  return `machine-owner-envelope-sha256:${bytesToHex(sha256(envelope))}`;
}
