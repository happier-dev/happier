import {
  TransferEndpointCandidateSchema,
  type TransferEndpointCandidate,
} from './transferStream.js';

export const DIRECT_TRANSFER_SESSION_EXPIRES_AT_HEADER =
  'x-happier-transfer-session-expires-at' as const;

function isLoopbackDirectTransferHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (normalized === 'localhost' || normalized === '::1') {
    return true;
  }
  const ipv4Parts = normalized.split('.');
  return ipv4Parts.length === 4
    && ipv4Parts[0] === '127'
    && ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function isSafeDirectTransferEndpointCandidate(
  candidate: unknown,
): candidate is TransferEndpointCandidate {
  const parsedCandidate = TransferEndpointCandidateSchema.safeParse(candidate);
  if (!parsedCandidate.success) {
    return false;
  }
  if (parsedCandidate.data.kind !== 'http' && parsedCandidate.data.kind !== 'https') {
    return false;
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(parsedCandidate.data.url);
  } catch {
    return false;
  }
  if (parsedCandidate.data.kind === 'https') {
    return parsedUrl.protocol === 'https:';
  }
  return parsedUrl.protocol === 'http:' && isLoopbackDirectTransferHostname(parsedUrl.hostname);
}

function normalizeAbsoluteHttpUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl ?? '').trim());
  } catch {
    throw new Error('Invalid direct peer endpoint candidate');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid direct peer endpoint candidate');
  }

  // Never allow credentialed URLs to propagate.
  parsed.username = '';
  parsed.password = '';
  // Do not allow query/hash routing or auth.
  parsed.search = '';
  parsed.hash = '';
  return parsed;
}
function normalizePathSegments(pathname: string): string[] {
  return String(pathname ?? '')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function assertTailSegments(
  segments: readonly string[],
  expectedTail: ReadonlyArray<string | null>,
): void {
  if (segments.length < expectedTail.length) {
    throw new Error('Invalid direct peer endpoint candidate');
  }

  const tail = segments.slice(-expectedTail.length);
  for (let idx = 0; idx < expectedTail.length; idx += 1) {
    const expected = expectedTail[idx];
    const actual = tail[idx] ?? '';
    if (expected === null) {
      if (!actual) {
        throw new Error('Invalid direct peer endpoint candidate');
      }
      continue;
    }
    if (actual !== expected) {
      throw new Error('Invalid direct peer endpoint candidate');
    }
  }
}

function normalizeWithTail(rawUrl: string, expectedTail: ReadonlyArray<string | null>): string {
  const parsed = normalizeAbsoluteHttpUrl(rawUrl);
  const segments = normalizePathSegments(parsed.pathname);
  assertTailSegments(segments, expectedTail);
  parsed.pathname = `/${segments.join('/')}`;
  return parsed.toString();
}

export function normalizeDirectPeerTransferEndpointBaseUrl(candidateUrl: string): string {
  // Accept optional prefix segments (e.g. Tailscale Serve path mount), but require the URL ends at
  // /machine-transfers/direct/<transferKey>.
  return normalizeWithTail(candidateUrl, ['machine-transfers', 'direct', null]);
}

export function normalizeDirectPeerImportEndpointBaseUrl(candidateUrl: string): string {
  // Accept optional prefix segments (e.g. Tailscale Serve path mount), but require the URL ends at
  // /machine-transfers/direct/imports/<uploadId>.
  return normalizeWithTail(candidateUrl, ['machine-transfers', 'direct', 'imports', null]);
}
