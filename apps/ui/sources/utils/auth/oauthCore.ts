import { getRandomBytes } from '@/platform/cryptoRandom';
import { digest } from '@/platform/digest';
import { encodeBase64 } from '@/encryption/base64';

export type PkceCodes = Readonly<{
  verifier: string;
  challenge: string;
}>;

function clampPkceVerifierBytes(bytes: number): number {
  const n = Number.isFinite(bytes) ? Math.floor(bytes) : 32;
  return Math.min(96, Math.max(32, n));
}

export async function generatePkceCodes(bytes: number = 32): Promise<PkceCodes> {
  const verifier = encodeBase64(getRandomBytes(clampPkceVerifierBytes(bytes)), 'base64url');
  const challengeBytes = await digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = encodeBase64(challengeBytes, 'base64url');
  return { verifier, challenge };
}

export function generateOauthState(bytes: number = 32): string {
  return encodeBase64(getRandomBytes(bytes), 'base64url');
}

export function parseOauthCallbackUrl(params: Readonly<{ url: string; redirectUri: string }>): Readonly<{
  code?: string;
  state?: string;
  error?: string;
}> {
  const rawUrl = String(params.url ?? '').trim();
  const rawRedirect = String(params.redirectUri ?? '').trim();
  if (!rawUrl || !rawRedirect) return {};

  let url: URL;
  let redirect: URL;
  try {
    url = new URL(rawUrl);
    redirect = new URL(rawRedirect);
  } catch {
    return {};
  }

  if (url.origin !== redirect.origin) return {};
  if (url.pathname !== redirect.pathname) return {};

  const code = url.searchParams.get('code') || undefined;
  const state = url.searchParams.get('state') || undefined;
  const error = url.searchParams.get('error') || undefined;

  const out: { code?: string; state?: string; error?: string } = {};
  if (code) out.code = code;
  if (state) out.state = state;
  if (error) out.error = error;
  return out;
}

