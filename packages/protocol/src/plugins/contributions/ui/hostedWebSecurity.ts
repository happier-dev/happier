import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';

const HTTP_ORIGIN_PROTOCOLS = new Set(['http:', 'https:']);

function isExactHttpOrigin(value: string): boolean {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    return HTTP_ORIGIN_PROTOCOLS.has(url.protocol)
      // `new URL('https://*.example').origin` round-trips unchanged, so the
      // round-trip alone admits a CSP wildcard host. Every directive built from
      // these values would then be widened by an author-supplied pattern, which
      // is the opposite of "exact".
      && !url.hostname.includes('*')
      && url.origin === trimmed
      && url.pathname === '/'
      && url.search.length === 0
      && url.hash.length === 0;
  } catch {
    return false;
  }
}

export const PluginHostedWebOriginV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.refine(isExactHttpOrigin, 'Expected an exact http(s) origin without path, query, hash, or wildcard')));
export type PluginHostedWebOriginV1 = z.infer<typeof PluginHostedWebOriginV1Schema>;

function createDefaultPluginHostedWebCspPolicyV1() {
  return {
  connectSrc: 'selfOnly' as const,
  allowDataUrls: false,
  allowBlobUrls: false,
  allowInlineStyles: false,
  allowEval: false,
  };
}

export const PluginHostedWebCspPolicyV1Schema = lazyZodSchema(() => z._default(z.strictObject({
  connectSrc: z._default(z.enum(['none', 'selfOnly', 'declaredOrigins']), 'selfOnly'),
  allowDataUrls: z._default(z.boolean(), false),
  allowBlobUrls: z._default(z.boolean(), false),
  allowInlineStyles: z._default(z.boolean(), false),
  allowEval: z._default(z.boolean(), false),
}), createDefaultPluginHostedWebCspPolicyV1));
export type PluginHostedWebCspPolicyV1 = z.infer<typeof PluginHostedWebCspPolicyV1Schema>;

export const PluginHostedWebSecurityPolicyV1Schema = lazyZodSchema(() => z.strictObject({
  allowedNavigationOrigins: z._default(z.array(PluginHostedWebOriginV1Schema), []),
  allowedCallbackOrigins: z._default(z.array(PluginHostedWebOriginV1Schema), []),
  allowedConnectOrigins: z._default(z.array(PluginHostedWebOriginV1Schema), []),
  csp: PluginHostedWebCspPolicyV1Schema,
  sourceMaps: z._default(z.enum(['disabled', 'devOrInternalOnly', 'declaredDigestOnly']), 'disabled'),
  mixedContent: z._default(z.enum(['deny', 'devLoopbackOnly']), 'deny'),
}));
export type PluginHostedWebSecurityPolicyV1 = z.infer<typeof PluginHostedWebSecurityPolicyV1Schema>;

/**
 * Who may embed a served hosted-web asset (§3.12, EU-8).
 *
 * The directive is **host-derived and author-proof**: it is not part of
 * `PluginHostedWebSecurityPolicyV1`, so no manifest can widen it, and it is
 * supplied by the embedding host through this options bag instead. An ancestor
 * that is not an exact `http(s)` origin — a wildcard, a scheme-only value, an
 * origin with a path — is dropped rather than normalized, and an empty result
 * fails closed to `'none'`.
 *
 * `'none'` used to be unconditional, which meant Happier's own iframe could
 * never load a plugin's own served asset; `*` would let any page that can reach
 * the loopback port embed it. Neither is a policy, so the exact set is required.
 */
export type PluginHostedWebStaticAssetCspOptionsV1 = Readonly<{
  frameAncestors?: readonly string[];
}>;

function resolveFrameAncestors(options: PluginHostedWebStaticAssetCspOptionsV1 | undefined): string {
  const ancestors = (options?.frameAncestors ?? []).filter(isExactHttpOrigin);
  return ancestors.length > 0 ? [...new Set(ancestors)].join(' ') : "'none'";
}

/** Trusted plugin resources are unrestricted; the host still owns who may embed them. */
export function buildPluginHostedWebStaticAssetContentSecurityPolicyV1(
  _security: PluginHostedWebSecurityPolicyV1,
  options?: PluginHostedWebStaticAssetCspOptionsV1,
): string {
  return `frame-ancestors ${resolveFrameAncestors(options)}; block-all-mixed-content`;
}
