import {
  isTerminalProvisioningV3Payload,
  openBoxBundle,
  openTerminalProvisioningV3Response,
  parseTerminalProvisioningV2Plaintext,
} from '@happier-dev/protocol';

export type TerminalPairingAuthentication = Readonly<{
  secret: Uint8Array;
  createdAtMs: number;
  expiresAtMs: number;
  /** Effective approval deadline; absent/null when an older relay does not report it. */
  requestExpiresAtMs?: number | null;
}>;

export type TerminalPairingRequirement = 'v3';

export const TERMINAL_PAIRING_REQUIRE_ENV = 'HAPPIER_TERMINAL_PAIRING_REQUIRE';

export type OpenTerminalProvisioningResponseResult = Readonly<{
  type: 'legacy' | 'dataKey';
  key: Uint8Array;
  authenticated: boolean;
}> | Readonly<{ type: 'tokenOnly'; authenticated: boolean }>;

const TERMINAL_PAIRING_AUTHENTICATION_TTL_MS = 60 * 60 * 1_000;

export function readTerminalPairingRequirement(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TerminalPairingRequirement | null {
  const raw = String(env[TERMINAL_PAIRING_REQUIRE_ENV] ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'v3') return 'v3';
  throw new Error(
    `Invalid ${TERMINAL_PAIRING_REQUIRE_ENV} value "${raw}". Supported values: v3`,
  );
}

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
    ? 'This link expires soon. Rerun the command if approval fails.'
    : `This link expires at ${new Date(pairing.requestExpiresAtMs).toISOString()}. Rerun the command if approval fails.`;
}

export function openTerminalProvisioningResponse(params: Readonly<{
  payload: Uint8Array;
  terminalSecretKey: Uint8Array;
  terminalPublicKey: Uint8Array;
  pairing: TerminalPairingAuthentication | null;
  requirement: TerminalPairingRequirement | null;
  nowMs: number;
}>): OpenTerminalProvisioningResponseResult | null {
  const isV3 = isTerminalProvisioningV3Payload(params.payload);
  if (params.requirement === 'v3' && !isV3) return null;

  if (isV3) {
    if (!params.pairing) return null;
    const opened = openTerminalProvisioningV3Response({
      payload: params.payload,
      recipientSecretKeyOrSeed: params.terminalSecretKey,
      terminalEphemeralPublicKey: params.terminalPublicKey,
      pairingSecret: params.pairing.secret,
      createdAtMs: params.pairing.createdAtMs,
      expiresAtMs: params.pairing.expiresAtMs,
      nowMs: params.nowMs,
    });
    return opened ? { ...opened, authenticated: true } : null;
  }

  const opened = openBoxBundle({
    bundle: params.payload,
    recipientSecretKeyOrSeed: params.terminalSecretKey,
  });
  if (!opened) return null;
  if (opened.length === 32) {
    return { type: 'legacy', key: opened, authenticated: false };
  }
  const response = parseTerminalProvisioningV2Plaintext(opened);
  return response ? { ...response, authenticated: false } : null;
}
