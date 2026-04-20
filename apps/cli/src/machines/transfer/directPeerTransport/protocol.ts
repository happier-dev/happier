import { createHash } from 'node:crypto';

import {
  normalizeDirectPeerTransferEndpointBaseUrl,
  type TransferEndpointCandidate,
} from '@happier-dev/protocol';

export const DIRECT_PEER_AUTH_SCHEME = 'Bearer';
export const DIRECT_PEER_RECIPIENT_PUBLIC_KEY_HEADER = 'x-happier-transfer-recipient-public-key';
export const DIRECT_PEER_AUTH_TOKEN_HARD_MAX_CHARS = 256;
export const DIRECT_PEER_RECIPIENT_PUBLIC_KEY_BASE64_HARD_MAX_CHARS = 128;

const DIRECT_PEER_TRANSFER_ID_HARD_MAX_CHARS = 512;
const BASE64URL_KEY_REGEX = /^[A-Za-z0-9_-]+$/;

export function encodeDirectPeerTransferPathKey(transferId: string): string {
  return Buffer.from(transferId, 'utf8').toString('base64url');
}

export function decodeDirectPeerTransferPathKey(transferKey: string): string | null {
  const normalizedTransferKey = transferKey.trim();
  if (normalizedTransferKey.length === 0) {
    return null;
  }

  if (!BASE64URL_KEY_REGEX.test(normalizedTransferKey)) {
    return null;
  }

  try {
    const decoded = Buffer.from(normalizedTransferKey, 'base64url').toString('utf8');
    if (decoded.length === 0 || decoded.length > DIRECT_PEER_TRANSFER_ID_HARD_MAX_CHARS) {
      return null;
    }
    return encodeDirectPeerTransferPathKey(decoded) === normalizedTransferKey
      ? decoded
      : null;
  } catch {
    return null;
  }
}

export function hashTransferToken(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function formatCandidateHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function readDirectPeerAuthorizationToken(value: string | undefined): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const [scheme, token] = raw.split(/\s+/, 2);
  if (scheme !== DIRECT_PEER_AUTH_SCHEME) return null;
  const normalizedToken = String(token ?? '').trim();
  return normalizedToken.length > 0 ? normalizedToken : null;
}

export function extractDirectPeerRequestAuth(candidate: TransferEndpointCandidate): Readonly<{
  requestUrl: string;
  authorizationHeader?: string;
}> {
  const explicitAuthorizationToken = typeof candidate.authorizationToken === 'string'
    ? candidate.authorizationToken.trim()
    : '';
  try {
    const requestUrl = normalizeDirectPeerTransferEndpointBaseUrl(candidate.url);
    if (!explicitAuthorizationToken) {
      return { requestUrl };
    }
    return {
      requestUrl,
      authorizationHeader: `${DIRECT_PEER_AUTH_SCHEME} ${explicitAuthorizationToken}`,
    };
  } catch {
    throw new Error('Invalid direct peer endpoint candidate');
  }
}
