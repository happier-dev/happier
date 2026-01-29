import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';

export type VendorConnectStatus =
  | { kind: 'not_connected' }
  | { kind: 'connected'; email: string | null }
  | { kind: 'expired'; email: string | null }
  | { kind: 'unknown'; email: string | null };

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function extractOauthEmail(oauth: unknown): string | null {
  if (!isRecord(oauth)) return null;
  const idToken = oauth.id_token;
  if (typeof idToken !== 'string') return null;

  try {
    const payload = decodeJwtPayload(idToken);
    const email = payload?.email;
    return typeof email === 'string' && email.trim() ? email : null;
  } catch {
    return null;
  }
}

function computeExpiresAtMs(oauth: unknown, nowMs: number): number | null {
  if (!isRecord(oauth)) return null;

  const expiresAt = oauth.expires_at;
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt)) {
    // Existing code compares expires_at directly against Date.now(), so treat it as ms since epoch.
    return expiresAt;
  }

  const expiresIn = oauth.expires_in;
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn)) {
    return nowMs + expiresIn * 1000;
  }

  return null;
}

export function deriveVendorConnectStatus(token: unknown, nowMs: number = Date.now()): VendorConnectStatus {
  if (!isRecord(token)) return { kind: 'not_connected' };

  const oauth = token.oauth;
  if (!oauth) return { kind: 'not_connected' };

  const email = extractOauthEmail(oauth);
  const expiresAtMs = computeExpiresAtMs(oauth, nowMs);
  if (typeof expiresAtMs === 'number' && expiresAtMs < nowMs) return { kind: 'expired', email };

  return { kind: 'connected', email };
}

export function deriveVendorConnectStatusForStatusCheck(
  params: Readonly<{ token: unknown; error?: unknown }>,
  nowMs: number = Date.now(),
): VendorConnectStatus {
  if (params.error) return { kind: 'unknown', email: null };
  return deriveVendorConnectStatus(params.token, nowMs);
}
