import {
  classifyProviderHostnameSyntax,
  normalizeProviderEndpointUrlSyntax,
  parseProviderIpAddress,
} from '@happier-dev/protocol';

/**
 * Canonical download/manifest URL policy for voice model packs (SD-L5).
 *
 * One owner for the transport-safety rules every host (UI native + daemon)
 * shares: a model-pack URL MUST be `https:` and, when an allowlist is supplied,
 * its host MUST be on that allowlist. Plain `http:`, `file:`, `data:`, and other
 * schemes are refused before any network round-trip.
 */

export class ModelPackUrlPolicyError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'ModelPackUrlPolicyError';
  }
}

export type ModelPackUrlPolicy = Readonly<{
  /**
   * When non-empty, a URL is accepted only if its lowercase host is one of these
   * entries (exact host match, e.g. `github.com`). Empty/undefined allows any
   * host (scheme is still enforced).
   */
  allowedHosts?: readonly string[];
  /** Exact HTTPS origins allowed after redirects (scheme + host + port). */
  allowedOrigins?: readonly string[];
  /** DNS-capable hosts set this for public plugin assets; missing evidence fails closed. */
  requireResolvedAddresses?: boolean;
  /**
   * Permit `http:` (and `https:`) when the host is a loopback address
   * (`localhost`, `127.0.0.0/8`, `::1`). Off by default — the production policy
   * requires `https:`. Hosts (e.g. the daemon talking to a dev/self-hosted asset
   * server) may opt in for loopback dev URLs only.
   */
  allowInsecureLoopback?: boolean;
}>;

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host).replace(/^\[|\]$/g, '');
  const literal = parseProviderIpAddress(normalized);
  return literal?.locality === 'loopback'
    || (!literal && classifyProviderHostnameSyntax(normalized) === 'loopback');
}

export function assertModelPackResolvedAddressesAllowed(
  addresses: readonly string[],
  policy: Pick<ModelPackUrlPolicy, 'requireResolvedAddresses' | 'allowInsecureLoopback'> & Readonly<{
    requestUrl?: string;
  }> = {},
): void {
  if (policy.requireResolvedAddresses === true && addresses.length === 0) {
    throw new ModelPackUrlPolicyError('model_pack_url_dns_evidence_required');
  }
  const requestedLoopback = policy.allowInsecureLoopback === true
    && typeof policy.requestUrl === 'string'
    && isLoopbackHost(assertModelPackUrlAllowed(policy.requestUrl, policy).hostname);
  for (const address of addresses) {
    const parsed = parseProviderIpAddress(address);
    if (!parsed) {
      throw new ModelPackUrlPolicyError('model_pack_url_invalid_address_evidence');
    }
    if (parsed.locality !== 'public' && !(requestedLoopback && parsed.locality === 'loopback')) {
      throw new ModelPackUrlPolicyError('model_pack_url_private_destination');
    }
  }
}

/**
 * Validate a single model-pack URL against the policy. Returns the parsed URL on
 * success; throws {@link ModelPackUrlPolicyError} with a stable code otherwise.
 */
export function assertModelPackUrlAllowed(rawUrl: string, policy: ModelPackUrlPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(normalizeProviderEndpointUrlSyntax(rawUrl).normalizedUrl);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
    if (code === 'userinfo_forbidden' || code === 'secret_in_url') {
      throw new ModelPackUrlPolicyError('model_pack_url_credentials_forbidden');
    }
    if (code === 'unsupported_scheme') {
      throw new ModelPackUrlPolicyError('model_pack_url_insecure_scheme');
    }
    if (code === 'unsafe_address') {
      throw new ModelPackUrlPolicyError('model_pack_url_private_destination');
    }
    throw new ModelPackUrlPolicyError('model_pack_url_invalid');
  }

  const loopbackOk = policy.allowInsecureLoopback === true && isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackOk)) {
    throw new ModelPackUrlPolicyError('model_pack_url_insecure_scheme');
  }
  const literal = parseProviderIpAddress(url.hostname.replace(/^\[|\]$/g, ''));
  if (!loopbackOk && (
    (literal && literal.locality !== 'public')
    || (!literal && classifyProviderHostnameSyntax(url.hostname) === 'loopback')
  )) {
    throw new ModelPackUrlPolicyError('model_pack_url_private_destination');
  }

  const allowed = policy.allowedHosts;
  if (allowed && allowed.length > 0) {
    const host = normalizeHost(url.hostname);
    const ok = allowed.some((entry) => normalizeHost(entry) === host);
    if (!ok) {
      throw new ModelPackUrlPolicyError('model_pack_url_host_not_allowed');
    }
  }
  const allowedOrigins = policy.allowedOrigins;
  if (allowedOrigins && allowedOrigins.length > 0) {
    const normalizedOrigins = new Set(allowedOrigins.flatMap((raw) => {
      try {
        return [new URL(raw).origin.toLowerCase()];
      } catch {
        return [];
      }
    }));
    if (!normalizedOrigins.has(url.origin.toLowerCase())) {
      throw new ModelPackUrlPolicyError('model_pack_url_origin_not_allowed');
    }
  }

  return url;
}

/** Assert every manifest file URL satisfies the policy (manifest URL checked separately). */
export function assertManifestUrlsAllowed(
  manifest: Readonly<{ files: readonly Readonly<{ url: string }>[] }>,
  policy: ModelPackUrlPolicy = {},
): void {
  for (const file of manifest.files) {
    assertModelPackUrlAllowed(file.url, policy);
  }
}
