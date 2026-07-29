import { createHash } from 'node:crypto';

export type ConnectedServiceAccessTokenFingerprint = `sha256:${string}`;

export function computeConnectedServiceAccessTokenFingerprint(
  accessToken: string,
): ConnectedServiceAccessTokenFingerprint {
  return `sha256:${createHash('sha256').update(accessToken).digest('hex').slice(0, 8)}`;
}

export function normalizeConnectedServiceAccessTokenFingerprint(
  value: unknown,
): ConnectedServiceAccessTokenFingerprint | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return /^sha256:[a-f0-9]{8}$/u.test(text)
    ? text as ConnectedServiceAccessTokenFingerprint
    : null;
}
