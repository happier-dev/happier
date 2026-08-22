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
}>;

export type TerminalPairingRequirement = 'v3';

export const TERMINAL_PAIRING_REQUIRE_ENV = 'HAPPIER_TERMINAL_PAIRING_REQUIRE';

export type OpenTerminalProvisioningResponseResult =
  | Readonly<{
      type: 'legacy' | 'dataKey';
      key: Uint8Array;
      authenticated: boolean;
    }>
  | Readonly<{
      type: 'tokenOnly';
      authenticated: true;
    }>;

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

export function openTerminalProvisioningResponse(params: Readonly<{
  payload: Uint8Array;
  terminalSecretKey: Uint8Array;
  terminalPublicKey: Uint8Array;
  pairing: TerminalPairingAuthentication | null;
  requirement: TerminalPairingRequirement | null;
  nowMs: number;
  supportsTokenOnly?: boolean;
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
    if (!opened) return null;
    if (opened.type === 'dataKey') {
      return { type: 'dataKey', key: opened.key, authenticated: true };
    }
    return params.supportsTokenOnly === true
      ? { type: 'tokenOnly', authenticated: true }
      : null;
  }

  const opened = openBoxBundle({
    bundle: params.payload,
    recipientSecretKeyOrSeed: params.terminalSecretKey,
  });
  if (!opened) return null;
  if (opened.length === 32) {
    return { type: 'legacy', key: opened, authenticated: false };
  }
  const parsed = parseTerminalProvisioningV2Plaintext(opened);
  return parsed?.type === 'dataKey'
    ? { type: 'dataKey', key: parsed.key, authenticated: false }
    : null;
}
