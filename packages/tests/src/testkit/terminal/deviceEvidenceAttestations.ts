import { createPublicKey, verify } from 'node:crypto';

import { terminalEvidenceCanonicalJson, terminalEvidenceSha256 } from './deviceEvidenceCanonical';
import type { TerminalNativeDeviceRenderer } from './native';

export const TERMINAL_NATIVE_ATTESTATION_SCHEMA_VERSION = 1 as const;

export type TerminalNativeApprovalAuthority = Readonly<{
  id: string;
  publicKeyPem: string;
  rendererIds: readonly TerminalNativeDeviceRenderer[];
}>;

export type TerminalNativeApprovalPolicy = Readonly<{
  schemaVersion: 1;
  authorities: readonly TerminalNativeApprovalAuthority[];
}>;

export type TerminalNativeCaptureAuthority = Readonly<{
  id: string;
  publicKeyPem: string;
  validFrom: string;
  validUntil: string;
  scopes: readonly Readonly<{
    rendererId: TerminalNativeDeviceRenderer;
    allowedBuildIds: readonly string[];
  }>[];
}>;

export type TerminalNativeCapturePolicy = Readonly<{
  schemaVersion: 2;
  authorities: readonly TerminalNativeCaptureAuthority[];
}>;

export function terminalNativeCaptureAuthorityAllows(
  authority: TerminalNativeCaptureAuthority,
  rendererId: TerminalNativeDeviceRenderer,
  buildEvidenceId: string,
): boolean {
  return authority.scopes.some((scope) => (
    scope.rendererId === rendererId && scope.allowedBuildIds.includes(buildEvidenceId)
  ));
}

export function terminalNativeCaptureTimestampIsAllowed(
  authority: TerminalNativeCaptureAuthority,
  timestamp: string,
): boolean {
  const value = Date.parse(timestamp);
  const start = Date.parse(authority.validFrom);
  const end = Date.parse(authority.validUntil);
  return Number.isFinite(value) && Number.isFinite(start) && Number.isFinite(end)
    && start <= end && value >= start && value <= end;
}

export function terminalNativeObservationDigest(observation: Readonly<Record<string, unknown>>): string {
  const { reportArtifactId: _reportArtifactId, ...boundObservation } = observation;
  return terminalEvidenceSha256(boundObservation);
}

export function terminalNativeApprovalSigningPayload(record: Readonly<Record<string, unknown>>): string {
  const { signature: _signature, ...unsigned } = record;
  return terminalEvidenceCanonicalJson(unsigned);
}

export function verifyTerminalNativeApprovalSignature(
  record: Readonly<Record<string, unknown>>,
  authority: TerminalNativeApprovalAuthority,
): boolean {
  return verifyTerminalNativeAttestationSignature(record, authority);
}

function verifyTerminalNativeAttestationSignature(
  record: Readonly<Record<string, unknown>>,
  authority: Readonly<{ publicKeyPem: string }>,
): boolean {
  if (record.signatureAlgorithm !== 'ed25519' || typeof record.signature !== 'string') return false;
  try {
    return verify(
      null,
      Buffer.from(terminalNativeApprovalSigningPayload(record)),
      createPublicKey(authority.publicKeyPem),
      Buffer.from(record.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

export function terminalNativeCaptureSigningPayload(record: Readonly<Record<string, unknown>>): string {
  return terminalNativeApprovalSigningPayload(record);
}

export function verifyTerminalNativeCaptureSignature(
  record: Readonly<Record<string, unknown>>,
  authority: TerminalNativeCaptureAuthority,
): boolean {
  return verifyTerminalNativeAttestationSignature(record, authority);
}
