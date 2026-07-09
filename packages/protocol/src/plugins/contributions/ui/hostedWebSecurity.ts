import { z } from 'zod';

const HTTP_ORIGIN_PROTOCOLS = new Set(['http:', 'https:']);

function isExactHttpOrigin(value: string): boolean {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    return HTTP_ORIGIN_PROTOCOLS.has(url.protocol)
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

export function buildPluginHostedWebStaticAssetContentSecurityPolicyV1(
  security: PluginHostedWebSecurityPolicyV1,
): string {
  const csp = security.csp;
  const callbackOrigins = [...security.allowedCallbackOrigins];
  const connectOrigins = csp.connectSrc === 'declaredOrigins'
    ? [...security.allowedConnectOrigins]
    : [];
  const formAction = callbackOrigins.length > 0
    ? directiveValues(["'self'", ...callbackOrigins])
    : "'none'";
  const navigation = callbackOrigins.length > 0 || security.allowedNavigationOrigins.length > 0
    ? directiveValues(["'self'", ...callbackOrigins, ...security.allowedNavigationOrigins])
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
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self'",
    `style-src ${styleSrc}`,
    `img-src ${imgSrc}`,
    `font-src ${fontSrc}`,
    `connect-src ${directiveValues(["'self'", ...connectOrigins])}`,
    `navigate-to ${navigation}`,
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
