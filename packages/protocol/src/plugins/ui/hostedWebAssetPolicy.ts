import {
  buildPluginHostedWebStaticAssetContentSecurityPolicyV1,
  PluginHostedWebSecurityPolicyV1Schema,
  type PluginHostedWebSecurityPolicyV1,
} from '../contributions/ui/hostedWebSecurity.js';
import {
  hasHostedWebAssetFileExtension,
  isWithinHostedWebAssetRoot,
  normalizeHostedWebAssetArtifactPath,
  normalizeHostedWebAssetRequestPath,
} from './hostedWebAssetPolicyPaths.js';
import { PluginUiArtifactsManifestEntryV1Schema } from './uiArtifactsManifest.js';

export type HostedWebAssetPolicyFailureCode =
  | 'asset_not_declared'
  | 'directory_listing_disabled'
  | 'invalid_request_path'
  | 'mime_type_not_allowed'
  | 'source_map_unavailable';

export type HostedWebAssetPolicyInput = Readonly<{
  assetRootId: string;
  entryPath: string;
  files: readonly string[];
  digest: string;
  routeMode: 'hostOrigin' | 'pathFallback';
  requestPath: string;
  security: PluginHostedWebSecurityPolicyV1;
  /**
   * Exact host origins allowed to embed this response. This is host input, not
   * manifest policy; no artifact may widen its own frame-ancestor boundary.
   */
  frameAncestors?: readonly string[];
  sourceMaps?: Readonly<{
    enabled: boolean;
    allowedDigests?: ReadonlySet<string>;
  }>;
  /**
   * Browser Artifact capabilities are short-lived bearer paths. Their
   * responses must never outlive that capability in an HTTP cache or reveal
   * it through a navigation referrer. Native/daemon delivery keeps the
   * incumbent immutable profile by default.
   */
  delivery?: 'immutable' | 'ephemeralCapability';
}>;

/**
 * Generated V2 has one host-owned Artifact policy profile. It is derived from
 * the verified graph, never supplied by a renderer/client, so CLI projection,
 * UI adoption, and server delivery share the same policy authority.
 */
export const GENERATED_HOSTED_WEB_ASSET_PROFILE_V1 = 'generatedV2' as const;

export type GeneratedHostedWebAssetPolicyV1 = Readonly<{
  profile: typeof GENERATED_HOSTED_WEB_ASSET_PROFILE_V1;
  assetRootId: string;
  entryPath: string;
  files: readonly string[];
  digest: string;
  routeMode: 'pathFallback';
  security: PluginHostedWebSecurityPolicyV1;
  sourceMaps: Readonly<{ enabled: false }>;
}>;

/**
 * Derives the fixed generated-V2 hosted-web profile from one persisted
 * Artifact graph. The graph digest remains the integrity commitment for the
 * complete file set; consumers need not create their own policy projection.
 */
export function deriveGeneratedHostedWebAssetPolicyV1(
  artifactGraph: unknown,
): GeneratedHostedWebAssetPolicyV1 | null {
  const graph = PluginUiArtifactsManifestEntryV1Schema.safeParse(artifactGraph);
  if (
    !graph.success
    || graph.data.tier !== 'hostedWeb'
    || graph.data.platform !== 'web'
  ) {
    return null;
  }

  const separator = graph.data.entry.lastIndexOf('/');
  const assetRootId = separator > 0 ? graph.data.entry.slice(0, separator) : null;
  if (
    assetRootId === null
    || normalizeHostedWebAssetArtifactPath(assetRootId) !== assetRootId
    || !graph.data.files.every((file) => (
      normalizeHostedWebAssetArtifactPath(file.relativePath) === file.relativePath
      && isWithinHostedWebAssetRoot(assetRootId, file.relativePath)
    ))
  ) {
    return null;
  }

  return Object.freeze({
    profile: GENERATED_HOSTED_WEB_ASSET_PROFILE_V1,
    assetRootId,
    entryPath: graph.data.entry,
    files: Object.freeze(graph.data.files.map((file) => file.relativePath)),
    digest: graph.data.digest,
    routeMode: 'pathFallback',
    security: PluginHostedWebSecurityPolicyV1Schema.parse({}),
    sourceMaps: Object.freeze({ enabled: false }),
  });
}

export type HostedWebAssetPolicyResult =
  | Readonly<{
      ok: true;
      assetRootId: string;
      relativePath: string;
      contentType: string;
      fallback?: 'spa';
      headers: Readonly<Record<string, string>>;
    }>
  | Readonly<{
      ok: false;
      code: HostedWebAssetPolicyFailureCode;
      status: number;
    }>;

/**
 * The nonpersistent delivery profile shared by every browser-capability
 * response, including denials. It intentionally excludes CSP because an
 * error response has no Artifact-specific static-resource policy to apply.
 */
export const EPHEMERAL_HOSTED_WEB_ASSET_DELIVERY_HEADERS_V1: Readonly<Record<string, string>> = Object.freeze({
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
});

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

function failure(code: HostedWebAssetPolicyFailureCode, status: number): HostedWebAssetPolicyResult {
  return Object.freeze({ ok: false, code, status });
}

function extensionFor(path: string): string {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  const lastDot = basename.lastIndexOf('.');
  return lastDot > 0 ? basename.slice(lastDot).toLowerCase() : '';
}

function contentTypeFor(relativePath: string): string | null {
  return MIME_BY_EXTENSION[extensionFor(relativePath)] ?? null;
}

function isSourceMap(relativePath: string): boolean {
  return relativePath.toLowerCase().endsWith('.map');
}

function canServeSourceMap(input: HostedWebAssetPolicyInput): boolean {
  return input.sourceMaps?.enabled === true
    && input.sourceMaps.allowedDigests?.has(input.digest) === true;
}

/**
 * The cross-realm policy owner for hosted-web artifact requests. Platform
 * adapters own containment and bytes; they consume this result for every
 * request-path, declaration, MIME, source-map, cache, and CSP decision.
 */
export function resolveHostedWebAssetPolicy(input: HostedWebAssetPolicyInput): HostedWebAssetPolicyResult {
  const assetRootId = normalizeHostedWebAssetArtifactPath(input.assetRootId);
  const entryPath = normalizeHostedWebAssetArtifactPath(input.entryPath);
  if (
    assetRootId === null
    || entryPath === null
    || !isWithinHostedWebAssetRoot(assetRootId, entryPath)
  ) {
    return failure('invalid_request_path', 400);
  }

  const requestPath = normalizeHostedWebAssetRequestPath(input.requestPath);
  if (!requestPath.ok) {
    return failure('invalid_request_path', 400);
  }
  if (requestPath.directoryRequest && requestPath.path.length > 0) {
    return failure('directory_listing_disabled', 404);
  }

  const requestedRelativePath = requestPath.path.length === 0
    ? entryPath
    : `${assetRootId}/${requestPath.path}`;
  const declaredFiles = new Set(
    input.files
      .map((file) => normalizeHostedWebAssetArtifactPath(file))
      .filter((file): file is string => file !== null),
  );
  const declared = declaredFiles.has(requestedRelativePath);
  const requestedSourceMap = isSourceMap(requestedRelativePath);
  const sourceMapAllowed = !requestedSourceMap || canServeSourceMap(input);

  let relativePath = requestedRelativePath;
  let fallback: 'spa' | undefined;
  if (!declared || !sourceMapAllowed) {
    if (requestedSourceMap && declared && !sourceMapAllowed) {
      return failure('source_map_unavailable', 404);
    }
    if (
      input.routeMode === 'pathFallback'
      && !requestPath.directoryRequest
      && !hasHostedWebAssetFileExtension(requestPath.path)
      && declaredFiles.has(entryPath)
    ) {
      relativePath = entryPath;
      fallback = 'spa';
    } else {
      return failure('asset_not_declared', 404);
    }
  }

  const contentType = contentTypeFor(relativePath);
  if (!contentType) {
    return failure('mime_type_not_allowed', 415);
  }

  const ephemeralCapability = input.delivery === 'ephemeralCapability';
  return Object.freeze({
    ok: true,
    assetRootId,
    relativePath,
    contentType,
    fallback,
    headers: Object.freeze({
      ...(ephemeralCapability
        ? EPHEMERAL_HOSTED_WEB_ASSET_DELIVERY_HEADERS_V1
        : {
          'Cache-Control': 'public, max-age=31536000, immutable',
          ETag: `"${input.digest}"`,
          'X-Content-Type-Options': 'nosniff',
        }),
      'Content-Security-Policy': buildPluginHostedWebStaticAssetContentSecurityPolicyV1(
        input.security,
        { frameAncestors: input.frameAncestors ?? [] },
      ),
    }),
  });
}
