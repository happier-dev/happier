import { z } from 'zod';

import {
  resolveHostedWebAssetPolicy,
  type HostedWebAssetPolicyFailureCode,
  type HostedWebAssetPolicyInput,
  type HostedWebAssetPolicyResult,
} from './hostedWebAssetPolicy.js';
import {
  hasHostedWebAssetFileExtension,
  isWithinHostedWebAssetRoot,
  normalizeHostedWebAssetArtifactPath,
  normalizeHostedWebAssetRequestPath,
} from './hostedWebAssetPolicyPaths.js';

export const HOSTED_WEB_ASSET_NATIVE_POLICY_TABLE_VERSION_V1 = 1 as const;

const HostedWebAssetNativeResourceIdV1Schema = z.string().regex(/^r(?:0|[1-9]\d*)$/u);
const HostedWebAssetPolicyFailureCodeSchema = z.enum([
  'asset_not_declared',
  'directory_listing_disabled',
  'invalid_request_path',
  'mime_type_not_allowed',
  'source_map_unavailable',
]);
const HostedWebAssetNativeHeadersV1Schema = z.object({
  'Cache-Control': z.string().min(1),
  'Content-Security-Policy': z.string().min(1),
  ETag: z.string().min(1),
  'X-Content-Type-Options': z.string().min(1),
}).strict();

export const HostedWebAssetNativePolicyContentV1Schema = z.object({
  kind: z.literal('content'),
  resourceId: HostedWebAssetNativeResourceIdV1Schema,
  contentType: z.string().min(1),
  headers: HostedWebAssetNativeHeadersV1Schema,
}).strict();
export type HostedWebAssetNativePolicyContentV1 = Readonly<z.infer<
  typeof HostedWebAssetNativePolicyContentV1Schema
>>;

export const HostedWebAssetNativePolicyRejectionV1Schema = z.object({
  kind: z.literal('rejected'),
  code: HostedWebAssetPolicyFailureCodeSchema,
  status: z.union([z.literal(400), z.literal(404), z.literal(415)]),
}).strict().superRefine((value, context) => {
  const expectedStatus = statusForFailureCode(value.code);
  if (value.status !== expectedStatus) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${value.code} must use HTTP ${expectedStatus}`,
      path: ['status'],
    });
  }
});
export type HostedWebAssetNativePolicyRejectionV1 = Readonly<z.infer<
  typeof HostedWebAssetNativePolicyRejectionV1Schema
>>;

export const HostedWebAssetNativePolicyOutcomeV1Schema = z.discriminatedUnion('kind', [
  HostedWebAssetNativePolicyContentV1Schema,
  HostedWebAssetNativePolicyRejectionV1Schema,
]);
export type HostedWebAssetNativePolicyOutcomeV1 = Readonly<z.infer<
  typeof HostedWebAssetNativePolicyOutcomeV1Schema
>>;

const HostedWebAssetNativePolicyRouteV1Schema = z.object({
  path: z.string(),
  outcome: HostedWebAssetNativePolicyOutcomeV1Schema,
}).strict();
type HostedWebAssetNativePolicyRouteV1 = Readonly<z.infer<
  typeof HostedWebAssetNativePolicyRouteV1Schema
>>;

/**
 * JSON-only policy facts consumed by a native local-resource handler. The
 * table intentionally contains browser request paths and token-scoped opaque
 * resource ids—not Artifact paths, file paths, bytes, cache locations, or a
 * URL endpoint.
 */
export const HostedWebAssetNativePolicyTableV1Schema = z.object({
  version: z.literal(HOSTED_WEB_ASSET_NATIVE_POLICY_TABLE_VERSION_V1),
  routes: z.array(HostedWebAssetNativePolicyRouteV1Schema),
  pathFallback: HostedWebAssetNativePolicyContentV1Schema.optional(),
}).strict().superRefine((table, context) => {
  const paths = new Set<string>();
  for (const [index, route] of table.routes.entries()) {
    const normalized = normalizeHostedWebAssetArtifactPath(route.path);
    if (
      route.path.includes('\0')
      || (route.path.length > 0 && (normalized === null || normalized !== route.path))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'native policy routes must use canonical decoded relative paths',
        path: ['routes', index, 'path'],
      });
    }
    if (paths.has(route.path)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'native policy routes must be unique',
        path: ['routes', index, 'path'],
      });
    }
    paths.add(route.path);
  }
});
export type HostedWebAssetNativePolicyTableV1 = Readonly<{
  version: typeof HOSTED_WEB_ASSET_NATIVE_POLICY_TABLE_VERSION_V1;
  routes: readonly HostedWebAssetNativePolicyRouteV1[];
  pathFallback?: HostedWebAssetNativePolicyContentV1;
}>;

/**
 * This binding never enters the frame configuration. Artifact validates and
 * converts it to its verified native resource registry before the table is
 * registered under one revocable lease token.
 */
export const HostedWebAssetNativePolicyResourceBindingV1Schema = z.object({
  resourceId: HostedWebAssetNativeResourceIdV1Schema,
  relativePath: z.string().min(1),
}).strict();
export type HostedWebAssetNativePolicyResourceBindingV1 = Readonly<z.infer<
  typeof HostedWebAssetNativePolicyResourceBindingV1Schema
>>;

export type HostedWebAssetNativePolicyTableBuildV1 =
  | Readonly<{
      ok: true;
      table: HostedWebAssetNativePolicyTableV1;
      resourceBindings: readonly HostedWebAssetNativePolicyResourceBindingV1[];
    }>
  | Readonly<{
      ok: false;
      code: HostedWebAssetPolicyFailureCode;
      status: number;
    }>;

export type HostedWebAssetNativePolicyRequestOutcomeV1 =
  | HostedWebAssetNativePolicyContentV1
  | HostedWebAssetNativePolicyRejectionV1
  | Readonly<{
      kind: 'content';
      resourceId: string;
      contentType: string;
      headers: Readonly<Record<string, string>>;
      fallback: 'spa';
    }>;

export type HostedWebAssetNativePolicyConformanceCaseV1 = Readonly<{
  name: string;
  requestPath: string;
}>;

export type HostedWebAssetNativePolicyConformanceVectorV1 = Readonly<{
  name: string;
  requestPath: string;
  outcome: HostedWebAssetNativePolicyRequestOutcomeV1;
}>;

function statusForFailureCode(code: HostedWebAssetPolicyFailureCode): 400 | 404 | 415 {
  switch (code) {
    case 'invalid_request_path':
      return 400;
    case 'mime_type_not_allowed':
      return 415;
    case 'asset_not_declared':
    case 'directory_listing_disabled':
    case 'source_map_unavailable':
      return 404;
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requestPathForCanonicalRelativePath(path: string): string {
  if (path.length === 0) return '/';
  return `/${path.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`;
}

function collectCandidateRequestPaths(input: HostedWebAssetPolicyInput): readonly string[] {
  const assetRootId = normalizeHostedWebAssetArtifactPath(input.assetRootId);
  if (assetRootId === null) return Object.freeze(['']);

  const paths = new Set<string>(['']);
  for (const declaredFile of input.files) {
    const normalizedFile = normalizeHostedWebAssetArtifactPath(declaredFile);
    if (normalizedFile === null || !isWithinHostedWebAssetRoot(assetRootId, normalizedFile)) {
      continue;
    }
    if (normalizedFile === assetRootId) {
      continue;
    }
    const relativePath = normalizedFile.slice(assetRootId.length + 1);
    const normalizedRequest = normalizeHostedWebAssetRequestPath(
      requestPathForCanonicalRelativePath(relativePath),
    );
    if (normalizedRequest.ok) {
      paths.add(normalizedRequest.path);
    }
  }
  return Object.freeze([...paths].sort(compareStrings));
}

function toNativeRejection(result: Extract<HostedWebAssetPolicyResult, { ok: false }>): HostedWebAssetNativePolicyRejectionV1 {
  return cloneNativeRejection({
    kind: 'rejected',
    code: result.code,
    status: statusForFailureCode(result.code),
  });
}

function toNativeContent(
  result: Extract<HostedWebAssetPolicyResult, { ok: true }>,
  resourceId: string,
): HostedWebAssetNativePolicyContentV1 {
  return cloneNativeContent({
    kind: 'content',
    resourceId,
    contentType: result.contentType,
    headers: Object.freeze({
      'Cache-Control': result.headers['Cache-Control'] ?? '',
      'Content-Security-Policy': result.headers['Content-Security-Policy'] ?? '',
      ETag: result.headers.ETag ?? '',
      'X-Content-Type-Options': result.headers['X-Content-Type-Options'] ?? '',
    }),
  });
}

function cloneNativeContent(
  content: HostedWebAssetNativePolicyContentV1,
): HostedWebAssetNativePolicyContentV1 {
  return Object.freeze({
    kind: 'content',
    resourceId: content.resourceId,
    contentType: content.contentType,
    headers: Object.freeze({ ...content.headers }),
  });
}

function cloneNativeRejection(
  rejection: HostedWebAssetNativePolicyRejectionV1,
): HostedWebAssetNativePolicyRejectionV1 {
  return Object.freeze({
    kind: 'rejected',
    code: rejection.code,
    status: rejection.status,
  });
}

function tableBuildFailure(
  result: Extract<HostedWebAssetPolicyResult, { ok: false }>,
): HostedWebAssetNativePolicyTableBuildV1 {
  return Object.freeze({ ok: false, code: result.code, status: result.status });
}

/**
 * Derives a native-handler table solely by asking the canonical policy about
 * every visible declared route and one path-fallback probe. The private
 * bindings are the only place an Artifact-relative path survives; callers
 * must pass them directly to Artifact, never to the frame.
 */
export function createHostedWebAssetNativePolicyTableV1(
  input: HostedWebAssetPolicyInput,
): HostedWebAssetNativePolicyTableBuildV1 {
  const candidatePaths = collectCandidateRequestPaths(input);
  const candidates = candidatePaths.map((path) => Object.freeze({
    path,
    result: resolveHostedWebAssetPolicy({
      ...input,
      requestPath: requestPathForCanonicalRelativePath(path),
    }),
  }));
  const entry = candidates.find((candidate) => candidate.path.length === 0)?.result;
  if (entry === undefined) {
    return Object.freeze({ ok: false, code: 'invalid_request_path', status: 400 });
  }
  if (!entry.ok) {
    return tableBuildFailure(entry);
  }

  const servedPaths = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.result.ok) {
      servedPaths.add(candidate.result.relativePath);
    }
  }

  let fallbackResult: Extract<HostedWebAssetPolicyResult, { ok: true }> | undefined;
  if (input.routeMode === 'pathFallback') {
    let fallbackProbe = '__happier_path_fallback__';
    while (candidatePaths.includes(fallbackProbe)) {
      fallbackProbe = `${fallbackProbe}_`;
    }
    const resolved = resolveHostedWebAssetPolicy({
      ...input,
      requestPath: requestPathForCanonicalRelativePath(fallbackProbe),
    });
    if (resolved.ok && resolved.fallback === 'spa') {
      fallbackResult = resolved;
      servedPaths.add(resolved.relativePath);
    }
  }

  const resourceBindings = [...servedPaths]
    .sort(compareStrings)
    .map((relativePath, index) => Object.freeze({
      resourceId: `r${index}`,
      relativePath,
    }));
  const resourceIdsByRelativePath = new Map(
    resourceBindings.map((binding) => [binding.relativePath, binding.resourceId]),
  );

  const routes = candidates.map((candidate) => {
    if (!candidate.result.ok) {
      return Object.freeze({ path: candidate.path, outcome: toNativeRejection(candidate.result) });
    }
    const resourceId = resourceIdsByRelativePath.get(candidate.result.relativePath);
    if (resourceId === undefined) {
      throw new Error('Hosted-web native policy serialization lost a served resource binding.');
    }
    return Object.freeze({
      path: candidate.path,
      outcome: toNativeContent(candidate.result, resourceId),
    });
  });

  const tableInput = {
    version: HOSTED_WEB_ASSET_NATIVE_POLICY_TABLE_VERSION_V1,
    routes,
    ...(fallbackResult === undefined
      ? {}
      : (() => {
        const resourceId = resourceIdsByRelativePath.get(fallbackResult.relativePath);
        if (resourceId === undefined) {
          throw new Error('Hosted-web native policy serialization lost its fallback binding.');
        }
        return { pathFallback: toNativeContent(fallbackResult, resourceId) };
      })()),
  };
  const parsedTable = HostedWebAssetNativePolicyTableV1Schema.safeParse(tableInput);
  if (!parsedTable.success) {
    return Object.freeze({ ok: false, code: 'invalid_request_path', status: 400 });
  }

  return Object.freeze({
    ok: true,
    table: Object.freeze({
      version: parsedTable.data.version,
      routes: Object.freeze(parsedTable.data.routes.map((route) => Object.freeze({
        path: route.path,
        outcome: route.outcome.kind === 'content'
          ? cloneNativeContent(route.outcome)
          : cloneNativeRejection(route.outcome),
      }))),
      ...(parsedTable.data.pathFallback === undefined
        ? {}
        : { pathFallback: cloneNativeContent(parsedTable.data.pathFallback) }),
    }),
    resourceBindings: Object.freeze(resourceBindings),
  });
}

/**
 * Reference interpreter for native conformance tests. It does not inspect an
 * Artifact or select MIME/fallback policy: it only normalizes a request and
 * interprets facts generated by `createHostedWebAssetNativePolicyTableV1`.
 */
export function resolveHostedWebAssetNativePolicyRequestV1(
  table: HostedWebAssetNativePolicyTableV1,
  requestPath: string,
): HostedWebAssetNativePolicyRequestOutcomeV1 {
  const normalizedRequest = normalizeHostedWebAssetRequestPath(requestPath);
  if (!normalizedRequest.ok) {
    return Object.freeze({ kind: 'rejected', code: 'invalid_request_path', status: 400 });
  }
  if (normalizedRequest.directoryRequest && normalizedRequest.path.length > 0) {
    return Object.freeze({ kind: 'rejected', code: 'directory_listing_disabled', status: 404 });
  }

  const exact = table.routes.find((route) => route.path === normalizedRequest.path);
  if (exact !== undefined) {
    return exact.outcome;
  }
  if (table.pathFallback !== undefined && !hasHostedWebAssetFileExtension(normalizedRequest.path)) {
    return Object.freeze({ ...table.pathFallback, fallback: 'spa' });
  }
  return Object.freeze({ kind: 'rejected', code: 'asset_not_declared', status: 404 });
}

/**
 * Lets Kotlin/Swift tests consume protocol-owned expected outcomes for the
 * exact table they are about to register, rather than duplicating route/MIME
 * decisions in a platform test fixture.
 */
export function createHostedWebAssetNativePolicyConformanceVectorsV1(
  table: HostedWebAssetNativePolicyTableV1,
  cases: readonly HostedWebAssetNativePolicyConformanceCaseV1[],
): readonly HostedWebAssetNativePolicyConformanceVectorV1[] {
  return Object.freeze(cases.map((testCase) => Object.freeze({
    name: testCase.name,
    requestPath: testCase.requestPath,
    outcome: resolveHostedWebAssetNativePolicyRequestV1(table, testCase.requestPath),
  })));
}
