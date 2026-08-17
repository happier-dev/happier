import { z } from 'zod';

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

export const PluginHostedWebOriginV1Schema = z.string().trim().min(1).refine(
  isExactHttpOrigin,
  'Expected an exact http(s) origin without path, query, hash, or wildcard',
);
export type PluginHostedWebOriginV1 = z.infer<typeof PluginHostedWebOriginV1Schema>;

function createDefaultPluginHostedWebCspPolicyV1() {
  return {
  scriptSrc: 'selfOnly' as const,
  styleSrc: 'selfOnly' as const,
  imgSrc: 'selfOnly' as const,
  fontSrc: 'selfOnly' as const,
  connectSrc: 'selfOnly' as const,
  allowDataUrls: false,
  allowBlobUrls: false,
  allowInlineStyles: false,
  allowEval: false as const,
  };
}

export const PluginHostedWebCspPolicyV1Schema = z.object({
  scriptSrc: z.enum(['selfOnly', 'selfAndDeclared']).default('selfOnly'),
  styleSrc: z.enum(['selfOnly', 'selfAndDeclared']).default('selfOnly'),
  imgSrc: z.enum(['selfOnly', 'selfDataBlobAndDeclared']).default('selfOnly'),
  fontSrc: z.enum(['selfOnly', 'selfAndDeclared']).default('selfOnly'),
  connectSrc: z.enum(['selfOnly', 'declaredOrigins']).default('selfOnly'),
  allowDataUrls: z.boolean().default(false),
  allowBlobUrls: z.boolean().default(false),
  allowInlineStyles: z.boolean().default(false),
  allowEval: z.literal(false).default(false),
}).strict().default(createDefaultPluginHostedWebCspPolicyV1);
export type PluginHostedWebCspPolicyV1 = z.infer<typeof PluginHostedWebCspPolicyV1Schema>;

export const PluginHostedWebSecurityPolicyV1Schema = z.object({
  allowedNavigationOrigins: z.array(PluginHostedWebOriginV1Schema).default([]),
  allowedCallbackOrigins: z.array(PluginHostedWebOriginV1Schema).default([]),
  allowedConnectOrigins: z.array(PluginHostedWebOriginV1Schema).default([]),
  csp: PluginHostedWebCspPolicyV1Schema,
  sourceMaps: z.enum(['disabled', 'devOrInternalOnly', 'declaredDigestOnly']).default('disabled'),
  mixedContent: z.enum(['deny', 'devLoopbackOnly']).default('deny'),
}).strict();
export type PluginHostedWebSecurityPolicyV1 = z.infer<typeof PluginHostedWebSecurityPolicyV1Schema>;

function directiveValues(values: readonly string[]): string {
  return values.join(' ');
}

function withOptionalSchemes(
  values: readonly string[],
  policy: PluginHostedWebCspPolicyV1,
): readonly string[] {
  return [
    ...values,
    ...(policy.allowDataUrls ? ['data:'] : []),
    ...(policy.allowBlobUrls ? ['blob:'] : []),
  ];
}

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
  return ancestors.length > 0 ? directiveValues([...new Set(ancestors)]) : "'none'";
}

export function buildPluginHostedWebStaticAssetContentSecurityPolicyV1(
  security: PluginHostedWebSecurityPolicyV1,
  options?: PluginHostedWebStaticAssetCspOptionsV1,
): string {
  const csp = security.csp;
  const callbackOrigins = [...security.allowedCallbackOrigins];
  const connectOrigins = csp.connectSrc === 'declaredOrigins'
    ? [...security.allowedConnectOrigins]
    : [];
  const formAction = callbackOrigins.length > 0
    ? directiveValues(["'self'", ...callbackOrigins])
    : "'none'";
  const styleSrc = csp.allowInlineStyles
    ? directiveValues(["'self'", "'unsafe-inline'"])
    : "'self'";
  const imgSrc = csp.imgSrc === 'selfDataBlobAndDeclared'
    || csp.allowDataUrls
    || csp.allowBlobUrls
      ? directiveValues(withOptionalSchemes(["'self'"], csp))
      : "'self'";
  const fontSrc = csp.allowDataUrls || csp.allowBlobUrls
    ? directiveValues(withOptionalSchemes(["'self'"], csp))
    : "'self'";
  const directives = [
    "default-src 'none'",
    "base-uri 'none'",
    `form-action ${formAction}`,
    `frame-ancestors ${resolveFrameAncestors(options)}`,
    "object-src 'none'",
    "script-src 'self'",
    "worker-src 'none'",
    `style-src ${styleSrc}`,
    `img-src ${imgSrc}`,
    `font-src ${fontSrc}`,
    `connect-src ${directiveValues(["'self'", ...connectOrigins])}`,
    'block-all-mixed-content',
  ];
  return directives.join('; ');
}

export function resolvePluginHostedWebSourceMapPolicyV1(input: Readonly<{
  security: PluginHostedWebSecurityPolicyV1;
  digest: string;
  internalChannel?: boolean;
}>): Readonly<{
  enabled: boolean;
  allowedDigests?: ReadonlySet<string>;
}> {
  if (input.security.sourceMaps === 'declaredDigestOnly') {
    return Object.freeze({
      enabled: true,
      allowedDigests: new Set([input.digest]),
    });
  }
  if (input.security.sourceMaps === 'devOrInternalOnly' && input.internalChannel === true) {
    return Object.freeze({
      enabled: true,
      allowedDigests: new Set([input.digest]),
    });
  }
  return Object.freeze({ enabled: false });
}
