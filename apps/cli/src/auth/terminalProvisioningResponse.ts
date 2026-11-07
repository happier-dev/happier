import { isTerminalProvisioningV3Payload, openTerminalProvisioningV3Response } from '@happier-dev/protocol/crypto/terminalProvisioningV2';

export type TerminalPairingAuthentication = Readonly<{
  secret: Uint8Array;
  createdAtMs: number;
  expiresAtMs: number;
  /** Effective approval deadline; absent/null when an older relay does not report it. */
  requestExpiresAtMs?: number | null;
}>;

export type OpenTerminalProvisioningResponseResult =
  | Readonly<{
      type: 'dataKey';
      key: Uint8Array;
      authenticated: true;
    }>
  | Readonly<{
      type: 'tokenOnly';
      authenticated: true;
    }>;

const TERMINAL_PAIRING_AUTHENTICATION_TTL_MS = 60 * 60 * 1_000;

export function createTerminalPairingAuthentication(params: Readonly<{
  nowMs: number;
  randomBytes: (length: number) => Uint8Array;
}>): TerminalPairingAuthentication {
  const secret = params.randomBytes(32);
  if (secret.length !== 32 || !Number.isSafeInteger(params.nowMs) || params.nowMs < 0) {
    throw new Error('Unable to create terminal pairing authentication');
  }
  return {
    secret,
    createdAtMs: params.nowMs,
    expiresAtMs: params.nowMs + TERMINAL_PAIRING_AUTHENTICATION_TTL_MS,
  };
}

export function applyTerminalAuthRequestExpiry(
  pairing: TerminalPairingAuthentication,
  response: unknown,
): TerminalPairingAuthentication {
  const expiresAt = response && typeof response === 'object' && 'expiresAt' in response
    ? response.expiresAt
    : undefined;
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= pairing.createdAtMs) {
    return { ...pairing, requestExpiresAtMs: null };
  }
  const expiresAtMs = Math.min(pairing.expiresAtMs, expiresAt);
  return { ...pairing, expiresAtMs, requestExpiresAtMs: expiresAtMs };
}

export function formatTerminalPairingExpiryNotice(pairing: TerminalPairingAuthentication): string {
  return pairing.requestExpiresAtMs == null
    ? 'This approval link expires soon. Rerun the command if approval fails.'
    : `This approval link expires at ${new Date(pairing.requestExpiresAtMs).toISOString()}. Rerun the command if approval fails.`;
}

export function openTerminalProvisioningResponse(params: Readonly<{
  payload: Uint8Array;
  terminalSecretKey: Uint8Array;
  terminalPublicKey: Uint8Array;
  pairing: TerminalPairingAuthentication | null;
  nowMs: number;
  supportsTokenOnly?: boolean;
}>): OpenTerminalProvisioningResponseResult | null {
  if (!params.pairing) return null;
  if (isTerminalProvisioningV3Payload(params.payload)) {
    const opened = openTerminalProvisioningV3Response({
      payload: params.payload,
      recipientSecretKeyOrSeed: params.terminalSecretKey,
      terminalEphemeralPublicKey: params.terminalPublicKey,
      pairingSecret: params.pairing.secret,
      createdAtMs: params.pairing.createdAtMs,
      expiresAtMs: params.pairing.expiresAtMs,
      nowMs: params.nowMs,
    });
    if (!opened) return null;
    if (opened.type === 'dataKey') {
      return { type: 'dataKey', key: opened.key, authenticated: true };
    }
    return params.supportsTokenOnly === true
      ? { type: 'tokenOnly', authenticated: true }
      : null;
  }

  // An active request with v3 context never falls back to an unbound v1/v2
  // response.
  return null;
}
