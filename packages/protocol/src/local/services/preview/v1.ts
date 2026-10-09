import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';

import { BrowserLocalServicePreviewTargetV1Schema } from '../../../browser/target/v1.js';
import { LocalServiceLoopbackHostV1Schema } from '../hosts.js';
import { LocalServicePreviewDiagnosticV1Schema } from './diagnostics/v1.js';
import { LocalServiceManagedServiceActionTargetV1Schema } from '../actions/v1.js';

export const LocalServicePreviewOwnerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), id: z.string().trim().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('session'), id: z.string().trim().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('plugin'), id: z.string().trim().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('agent'), id: z.string().trim().min(1).max(256) }).strict(),
]));
export type LocalServicePreviewOwnerV1 = z.infer<typeof LocalServicePreviewOwnerV1Schema>;

export const LocalServicePreviewTargetV1Schema = lazyZodSchema(() => z
  .object({
    scheme: z.enum(['http', 'https']),
    host: LocalServiceLoopbackHostV1Schema,
    port: z.number().int().min(1).max(65_535),
  })
  .strict());
export type LocalServicePreviewTargetV1 = z.infer<typeof LocalServicePreviewTargetV1Schema>;

export const LocalServicePreviewInitialPathV1Schema = lazyZodSchema(() => z
  .object({
    pathname: z.string().startsWith('/').max(2_048),
    search: z
      .string()
      .max(2_048)
      .refine((value) => value.length === 0 || value.startsWith('?'), {
        message: 'Search must be empty or start with "?".',
      })
      .optional()
      .default(''),
  })
  .strict());
export type LocalServicePreviewInitialPathV1 = z.infer<typeof LocalServicePreviewInitialPathV1Schema>;

export const LocalServicePreviewDisplayV1Schema = lazyZodSchema(() => z
  .object({
    title: z.string().trim().min(1).max(256),
    label: z.string().trim().min(1).max(256).optional(),
    addressLabel: z.string().trim().min(1).max(256),
    folderLabel: z.string().trim().min(1).max(256).optional(),
    iconToken: z.string().trim().min(1).max(64).optional(),
    tone: z.enum(['neutral', 'info', 'success', 'warning', 'danger', 'accent']).optional(),
    diagnostics: z.record(z.string(), z.unknown()).optional(),
  })
  .strict());
export type LocalServicePreviewDisplayV1 = z.infer<typeof LocalServicePreviewDisplayV1Schema>;

export const LocalServicePreviewPolicyV1Schema = lazyZodSchema(() => z
  .object({
    allowedMethods: z
      .array(z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']))
      .min(1)
      .default(['GET', 'HEAD', 'OPTIONS']),
    cookiePolicy: z.enum(['drop', 'isolate', 'rewrite']).default('drop'),
    compressionPolicy: z.enum(['identity', 'decode_reencode']).default('identity'),
    redirectPolicy: z.enum(['preserve_host_origin']).default('preserve_host_origin'),
    maxRequestBodyBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxResponseBodyBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict());
export type LocalServicePreviewPolicyV1 = z.infer<typeof LocalServicePreviewPolicyV1Schema>;

export const LocalServicePreviewOriginModeV1Schema = lazyZodSchema(() => z.enum(['host']));
export type LocalServicePreviewOriginModeV1 = z.infer<typeof LocalServicePreviewOriginModeV1Schema>;

export const LocalServicePreviewServiceTargetV1Schema = lazyZodSchema(() => LocalServiceManagedServiceActionTargetV1Schema
  .required({ cwd: true, declaration: true }).omit({ sessionId: true }).strict());
export type LocalServicePreviewServiceTargetV1 = z.infer<typeof LocalServicePreviewServiceTargetV1Schema>;

export function refineLocalServicePreviewServiceBindingV1(
  value: Readonly<{ machineId: string; sessionId?: string; serviceTarget?: LocalServicePreviewServiceTargetV1; owner?: LocalServicePreviewOwnerV1 }>,
  context: z.RefinementCtx,
): void {
  if (!value.serviceTarget) return;
  if (value.sessionId !== undefined || value.serviceTarget.machineId !== value.machineId
    || (value.owner !== undefined && value.owner.kind !== 'user')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['serviceTarget'], message: 'A service preview must bind one Machine and starter without Session authority.' });
  }
}

const LocalServicePreviewResourceShapeV1Schema = lazyZodSchema(() => z
  .object({
    previewId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256).optional(),
    serviceTarget: LocalServicePreviewServiceTargetV1Schema.optional(),
    machineId: z.string().trim().min(1).max(256),
    owner: LocalServicePreviewOwnerV1Schema,
    target: LocalServicePreviewTargetV1Schema,
    initialPath: LocalServicePreviewInitialPathV1Schema,
    display: LocalServicePreviewDisplayV1Schema,
    originMode: LocalServicePreviewOriginModeV1Schema,
    policy: LocalServicePreviewPolicyV1Schema.optional(),
    browserTarget: BrowserLocalServicePreviewTargetV1Schema.optional(),
  })
  .strict());
export const LocalServicePreviewResourceV1Schema = lazyZodSchema(() => LocalServicePreviewResourceShapeV1Schema
  .superRefine(refineLocalServicePreviewServiceBindingV1));
export type LocalServicePreviewResourceV1 = z.infer<typeof LocalServicePreviewResourceV1Schema>;

// The authority-bearing subset stays bound to one registered resource. Display and
// navigation changes do not retarget an admitted preview.
export const LocalServicePreviewDirectBindingV1Schema = lazyZodSchema(() => LocalServicePreviewResourceShapeV1Schema.pick({
  previewId: true, machineId: true, sessionId: true, serviceTarget: true, owner: true, target: true, policy: true,
}).strict().superRefine(refineLocalServicePreviewServiceBindingV1));
export type LocalServicePreviewDirectBindingV1 = z.infer<typeof LocalServicePreviewDirectBindingV1Schema>;

export function localServicePreviewDirectBindingV1(resource: LocalServicePreviewResourceV1): LocalServicePreviewDirectBindingV1 {
  const { previewId, machineId, sessionId, serviceTarget, owner, target, policy } = resource;
  return { previewId, machineId, ...(sessionId ? { sessionId } : {}), ...(serviceTarget ? { serviceTarget } : {}), owner, target, ...(policy ? { policy } : {}) };
}

export const DaemonLocalServicePreviewAdmissionRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ v: z.literal(1), kind: z.literal('read'), target: LocalServicePreviewServiceTargetV1Schema }).strict(),
  z.object({ v: z.literal(1), kind: z.literal('wait_retirement'), target: LocalServicePreviewServiceTargetV1Schema,
    instanceId: z.string().trim().min(1).max(256) }).strict(),
]).refine(request => request.kind !== 'wait_retirement' || request.instanceId === request.target.managedServiceId,
  { message: 'Retirement must address the admitted service occurrence.', path: ['instanceId'] }));
export type DaemonLocalServicePreviewAdmissionRequestV1 = z.infer<typeof DaemonLocalServicePreviewAdmissionRequestV1Schema>;

export const DaemonLocalServicePreviewAdmissionResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ v: z.literal(1), kind: z.literal('admitted'), instanceId: z.string().trim().min(1).max(256),
    serviceTarget: LocalServicePreviewServiceTargetV1Schema, starterAccountId: z.string().trim().min(1).max(256),
    endpoint: LocalServicePreviewTargetV1Schema }).strict(),
  z.object({ v: z.literal(1), kind: z.literal('retired'), instanceId: z.string().trim().min(1).max(256) }).strict(),
  z.object({ v: z.literal(1), kind: z.literal('refused'), reasonCode: z.literal('service_unavailable') }).strict(),
]));
export type DaemonLocalServicePreviewAdmissionResponseV1 = z.infer<typeof DaemonLocalServicePreviewAdmissionResponseV1Schema>;

export const LocalServicePreviewNativeDirectDescriptorV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1), kind: z.literal('iroh_preview'),
  previewId: z.string().trim().min(1).max(256),
  machineId: z.string().trim().min(1).max(256),
}).strict());
export type LocalServicePreviewNativeDirectDescriptorV1 = z.infer<typeof LocalServicePreviewNativeDirectDescriptorV1Schema>;

function hasPreviewHttpProtocol(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// The server-issued isolated-origin location a private preview iframe/WebView loads.
export const LocalServicePreviewAccessUrlV1Schema = lazyZodSchema(() => z
  .string()
  .trim()
  .url()
  .max(4_096)
  .refine(hasPreviewHttpProtocol, { message: 'Preview access URL must use http(s).' }));
export type LocalServicePreviewAccessUrlV1 = z.infer<typeof LocalServicePreviewAccessUrlV1Schema>;

// A registered preview resource projected together with its minted access URL. This is
// the canonical render contract the UI preview domain consumes: `accessUrl` is null when
// no served dev server URL could be minted (surface stays unavailable, never crashes).
export const LocalServicePreviewSnapshotRowV1Schema = lazyZodSchema(() => z
  .object({
    previewId: z.string().trim().min(1).max(256),
    resource: LocalServicePreviewResourceV1Schema,
    accessUrl: LocalServicePreviewAccessUrlV1Schema.nullable().default(null),
    expiresAt: z.number().int().nonnegative().nullable().default(null),
    accessUnavailableReasonCode: z.literal('preview_private_route_unavailable').optional(),
    nativeDirect: LocalServicePreviewNativeDirectDescriptorV1Schema.optional(),
    diagnostics: z.array(LocalServicePreviewDiagnosticV1Schema).default([]),
  })
  .strict());
export type LocalServicePreviewSnapshotRowV1 = z.infer<typeof LocalServicePreviewSnapshotRowV1Schema>;

export const LocalServicePreviewSnapshotV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1),
    machineId: z.string().trim().min(1).max(256),
    generatedAt: z.number().int().nonnegative(),
    refreshState: z.enum(['idle', 'refreshing', 'error']),
    // Registered resources are metadata, not browser locations. Browser consumers
    // use only the server-issued render rows below; no resources fallback is authorized.
    resources: z.array(LocalServicePreviewResourceV1Schema),
    // Canonical render rows carrying the server-issued `accessUrl`. A snapshot without
    // rows supplies no browser admission; consumers must never reconstruct a location.
    previews: z.array(LocalServicePreviewSnapshotRowV1Schema).optional(),
    diagnostics: z.array(z.record(z.string(), z.unknown())).default([]),
  })
  .strict());
export type LocalServicePreviewSnapshotV1 = z.infer<typeof LocalServicePreviewSnapshotV1Schema>;

export const DaemonLocalServicePreviewSnapshotRequestV1Schema = lazyZodSchema(() => z
  .object({
    machineId: z.string().trim().min(1).max(256),
  })
  .strict());
export type DaemonLocalServicePreviewSnapshotRequestV1 = z.infer<
  typeof DaemonLocalServicePreviewSnapshotRequestV1Schema
>;

export const DaemonLocalServicePreviewSnapshotResponseV1Schema = lazyZodSchema(() => z
  .object({
    protocolVersion: z.literal(1),
    snapshot: LocalServicePreviewSnapshotV1Schema,
  })
  .strict());
export type DaemonLocalServicePreviewSnapshotResponseV1 = z.infer<
  typeof DaemonLocalServicePreviewSnapshotResponseV1Schema
>;

export const LocalServicePreviewTokenV1Schema = lazyZodSchema(() => z
  .object({
    kind: z.literal('preview_access'),
    tokenId: z.string().trim().min(1).max(256),
    previewId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256).optional(),
    machineId: z.string().trim().min(1).max(256),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().nullable(),
    exchangeMode: z.enum(['url', 'cookie']),
  })
  .strict()
  .refine((token) => token.exchangeMode === 'cookie' || token.expiresAt !== null, {
    message: 'URL admissions require an expiry.', path: ['expiresAt'],
  }));
export type LocalServicePreviewTokenV1 = z.infer<typeof LocalServicePreviewTokenV1Schema>;

// ---------------------------------------------------------------------------
// Private-preview lifecycle requests/responses (PRV-2). `openOrCreate` resolves a
// canonical launch/inventory target into a server-registered private preview and
// returns its minted-row projection; `revoke` removes a registered preview. These are
// the daemon-owned counterparts to the public-preview create/revoke shape — never a raw
// token, only the `BrowserViewTarget`-bearing snapshot row.
// ---------------------------------------------------------------------------

export const DaemonLocalServicePreviewOpenOrCreateRequestV1Schema = lazyZodSchema(() => z
  .object({
    machineId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256).optional(),
    // Exactly one canonical target reference resolves the preview (UI never sends a raw URL):
    // a detected inventory entry, a managed service, or a launcher target.
    inventoryEntryId: z.string().trim().min(1).max(256).optional(),
    managedServiceId: z.string().trim().min(1).max(256).optional(),
    launchTargetId: z.string().trim().min(1).max(256).optional(),
    serviceTarget: LocalServicePreviewServiceTargetV1Schema.optional(),
    initialPath: LocalServicePreviewInitialPathV1Schema.optional(),
  })
  .strict().superRefine((request, context) => {
    refineLocalServicePreviewServiceBindingV1(request, context);
    if (request.serviceTarget && (request.inventoryEntryId || request.managedServiceId || request.launchTargetId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['serviceTarget'], message: 'A source-qualified service is the only preview target.' });
    }
  }));
export type DaemonLocalServicePreviewOpenOrCreateRequestV1 = z.infer<
  typeof DaemonLocalServicePreviewOpenOrCreateRequestV1Schema
>;

export const DaemonLocalServicePreviewOpenOrCreateResponseV1Schema = lazyZodSchema(() => z
  .object({
    protocolVersion: z.literal(1),
    status: z.enum(['created', 'existing']),
    preview: LocalServicePreviewSnapshotRowV1Schema,
    snapshot: LocalServicePreviewSnapshotV1Schema,
  })
  .strict());
export type DaemonLocalServicePreviewOpenOrCreateResponseV1 = z.infer<
  typeof DaemonLocalServicePreviewOpenOrCreateResponseV1Schema
>;

export const DaemonLocalServicePreviewRevokeRequestV1Schema = lazyZodSchema(() => z
  .object({
    machineId: z.string().trim().min(1).max(256),
    previewId: z.string().trim().min(1).max(256),
    serviceTarget: LocalServicePreviewServiceTargetV1Schema.optional(),
  })
  .strict().superRefine(refineLocalServicePreviewServiceBindingV1));
export type DaemonLocalServicePreviewRevokeRequestV1 = z.infer<
  typeof DaemonLocalServicePreviewRevokeRequestV1Schema
>;

export const DaemonLocalServicePreviewRevokeResponseV1Schema = lazyZodSchema(() => z
  .object({
    protocolVersion: z.literal(1),
    previewId: z.string().trim().min(1).max(256),
    revoked: z.boolean(),
    snapshot: LocalServicePreviewSnapshotV1Schema,
  })
  .strict());
export type DaemonLocalServicePreviewRevokeResponseV1 = z.infer<
  typeof DaemonLocalServicePreviewRevokeResponseV1Schema
>;
