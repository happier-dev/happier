import { normalizeProviderOriginRelativePathSyntax } from '@happier-dev/protocol/providers/safety/url';
import { isLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';

/**
 * Canonical download/manifest URL policy for voice model packs (SD-L5).
 *
 * One owner for the transport-safety rules every host (UI native + daemon)
 * shares: a model-pack URL MUST be `https:` without configured credentials.
 * Plain `http:`, `file:`, `data:`, and other
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
   * Permit `http:` (and `https:`) when the host is a loopback address
   * (`localhost`, `127.0.0.0/8`, `::1`). Off by default — the production policy
   * requires `https:`. Hosts (e.g. the daemon talking to a dev/self-hosted asset
   * server) may opt in for loopback dev URLs only.
   */
  allowInsecureLoopback?: boolean;
}>;

/**
 * Validate a single model-pack URL against the policy. Returns the parsed URL on
 * success; throws {@link ModelPackUrlPolicyError} with a stable code otherwise.
 */
export function assertModelPackUrlAllowed(rawUrl: string, policy: ModelPackUrlPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
    if (url.username || url.password) {
      throw new ModelPackUrlPolicyError('model_pack_url_credentials_forbidden');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ModelPackUrlPolicyError('model_pack_url_insecure_scheme');
    }
    if (url.hash) throw new ModelPackUrlPolicyError('model_pack_url_invalid');
    // Reuse credential-query validation without Provider endpoint locality rules:
    // trusted plugins may download from LAN and self-hosted HTTPS mirrors.
    normalizeProviderOriginRelativePathSyntax(`${url.pathname}${url.search}`, { allowQuery: true });
  } catch (error) {
    if (error instanceof ModelPackUrlPolicyError) throw error;
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
    if (code === 'userinfo_forbidden' || code === 'secret_in_url') {
      throw new ModelPackUrlPolicyError('model_pack_url_credentials_forbidden');
    }
    if (code === 'unsupported_scheme') {
      throw new ModelPackUrlPolicyError('model_pack_url_insecure_scheme');
    }
    throw new ModelPackUrlPolicyError('model_pack_url_invalid');
  }

  const loopbackOk = policy.allowInsecureLoopback === true && isLoopbackHostname(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackOk)) {
    throw new ModelPackUrlPolicyError('model_pack_url_insecure_scheme');
  }
  return url;
}

/**
 * Assess an HTTP Location received from an admitted HTTPS download. Signed
 * queries are transport credentials issued by that server, not configured
 * endpoint credentials. Keep them inside the host's request only: return a
 * query-free destination for address checks and response metadata. All other
 * configured-URL rules still apply, and HTTPS cannot downgrade to HTTP.
 */
export function assertModelPackRedirectUrlAllowed(rawUrl: string, policy: ModelPackUrlPolicy = {}): URL {
  let destination: URL;
  try {
    destination = new URL(rawUrl);
  } catch {
    throw new ModelPackUrlPolicyError('model_pack_url_invalid');
  }
  if (destination.protocol !== 'https:') {
    throw new ModelPackUrlPolicyError('model_pack_url_insecure_scheme');
  }
  destination.search = '';
  return assertModelPackUrlAllowed(destination.toString(), policy);
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
