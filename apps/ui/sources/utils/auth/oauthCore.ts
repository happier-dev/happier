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
  const rawInput = String(params.url ?? '').trim();
  const rawRedirect = String(params.redirectUri ?? '').trim();
  if (!rawInput || !rawRedirect) return {};

  const tryParseCodeStatePaste = (text: string): { code: string; state: string } | null => {
    // Common headless OAuth paste form seen in the wild: "<code>#<state>"
    // We only accept this when it's clearly not a URL.
    if (text.includes('://')) return null;
    const trimmed = text.trim();
    const match = trimmed.match(/^([^\s#]+)#([^\s#]+)$/);
    if (!match) return null;
    const code = match[1] ?? '';
    const state = match[2] ?? '';
    if (!code || !state) return null;
    return { code, state };
  };

  const codeStatePaste = tryParseCodeStatePaste(rawInput);
  if (codeStatePaste) {
    return { code: codeStatePaste.code, state: codeStatePaste.state };
  }

  let redirect: URL;
  try {
    redirect = new URL(rawRedirect);
  } catch {
    return {};
  }

  const normalizePathname = (pathname: string): string => {
    const raw = pathname || '/';
    if (raw.length <= 1) return raw;
    return raw.replace(/\/+$/, '');
  };

  const isLoopbackHostname = (hostname: string): boolean => {
    const raw = String(hostname ?? '').toLowerCase();
    const host = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
    // Some URL implementations normalize IPv6 loopback as the expanded form.
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0:0:0:0:0:0:0:1'
    );
  };

  const resolveDefaultPort = (url: URL): string => {
    if (url.port) return url.port;
    if (url.protocol === 'https:') return '443';
    if (url.protocol === 'http:') return '80';
    return '';
  };

  const originsMatch = (url: URL, expected: URL): boolean => {
    if (url.origin === expected.origin) return true;
    if (url.protocol !== expected.protocol) return false;
    const expectedPort = resolveDefaultPort(expected);
    const urlPort = resolveDefaultPort(url);
    if (expectedPort !== urlPort) return false;
    return isLoopbackHostname(url.hostname) && isLoopbackHostname(expected.hostname);
  };

  const tryParseUrl = (candidate: string): URL | null => {
    try {
      return new URL(candidate);
    } catch {
      return null;
    }
  };

  const tryExtractAndParseUrlFromText = (text: string): URL | null => {
    const match = text.match(/https?:\/\/\S+/i);
    if (!match?.[0]) return null;
    // Common copy/paste artifacts: trailing punctuation or quotes.
    const cleaned = match[0].replace(/[)\].,;:'"]+$/, '');
    return tryParseUrl(cleaned);
  };

  const tryParseRelativeToRedirect = (text: string): URL | null => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
      return new URL(trimmed, redirect.toString());
    } catch {
      return null;
    }
  };

  const url =
    tryParseUrl(rawInput) ??
    tryExtractAndParseUrlFromText(rawInput) ??
    tryParseRelativeToRedirect(rawInput);

  if (!url) return {};

  if (!originsMatch(url, redirect)) return {};
  if (normalizePathname(url.pathname) !== normalizePathname(redirect.pathname)) return {};

  const hashParams = (() => {
    const rawHash = url.hash ? url.hash.replace(/^#+/, '') : '';
    if (!rawHash) return new URLSearchParams();
    // Accept both "code=..." and "?code=..." styles.
    const normalized = rawHash.startsWith('?') ? rawHash.slice(1) : rawHash;
    try {
      return new URLSearchParams(normalized);
    } catch {
      return new URLSearchParams();
    }
  })();

  const code = url.searchParams.get('code') || hashParams.get('code') || undefined;
  const state = url.searchParams.get('state') || hashParams.get('state') || undefined;
  const error = url.searchParams.get('error') || hashParams.get('error') || undefined;

  const out: { code?: string; state?: string; error?: string } = {};
  if (code) out.code = code;
  if (state) out.state = state;
  if (error) out.error = error;
  return out;
}
