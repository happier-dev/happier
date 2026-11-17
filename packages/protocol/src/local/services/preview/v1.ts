import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import { BrowserLocalServicePreviewTargetV1Schema } from '../../../browser/target/v1.js';
import { LocalServiceLoopbackHostV1Schema } from '../hosts.js';
import { LocalServicePreviewDiagnosticV1Schema } from './diagnostics/v1.js';
import { LocalServiceManagedServiceActionTargetV1Schema } from '../actions/v1.js';

export type LocalServiceDeclarationPreviewLocatorV1 = Readonly<{ serverId: string; machineId: string; targetId: string }>;

/** Private UI route consumer opens this stable target through the existing preview Action.
 * This URL carries no grant; each visit requires the person's current Home admission.
 */
export function formatLocalServiceDeclarationPreviewLandingPathV1(locator: LocalServiceDeclarationPreviewLocatorV1): string {
  return `/preview-service/${encodeURIComponent(locator.machineId)}/${encodeURIComponent(locator.targetId)}?serverId=${encodeURIComponent(locator.serverId)}`;
}

export function buildLocalServiceDeclarationPreviewLandingUrlV1(uiBaseUrl: string, locator: LocalServiceDeclarationPreviewLocatorV1): string {
  return new URL(formatLocalServiceDeclarationPreviewLandingPathV1(locator), uiBaseUrl).toString();
}

export function parseLocalServiceDeclarationPreviewLandingUrlV1(value: string): LocalServiceDeclarationPreviewLocatorV1 | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const match = /^\/preview-service\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    const serverId = url.searchParams.get('serverId');
    if (!match || !serverId?.trim()) return null;
    const target = BrowserLocalServicePreviewTargetV1Schema.safeParse({ kind: 'localServicePreview',
      machineId: decodeURIComponent(match[1]!), targetId: decodeURIComponent(match[2]!) });
    return target.success ? { serverId, machineId: target.data.machineId, targetId: target.data.targetId } : null;
  } catch { return null; }
}

export const LocalServicePreviewOwnerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user'), id: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)) }),
  z.strictObject({ kind: z.literal('session'), id: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)) }),
  z.strictObject({ kind: z.literal('plugin'), id: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)) }),
  z.strictObject({ kind: z.literal('agent'), id: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)) }),
]));
export type LocalServicePreviewOwnerV1 = z.infer<typeof LocalServicePreviewOwnerV1Schema>;

export const LocalServicePreviewTargetV1Schema = lazyZodSchema(() => z.strictObject({
    scheme: z.enum(['http', 'https']),
    host: LocalServiceLoopbackHostV1Schema,
    port: z.number().check(z.int(), z.minimum(1), z.maximum(65_535)),
  }));
export type LocalServicePreviewTargetV1 = z.infer<typeof LocalServicePreviewTargetV1Schema>;

export const LocalServicePreviewInitialPathV1Schema = lazyZodSchema(() => z.strictObject({
    pathname: z.string().check(z.startsWith('/'), z.maxLength(2_048)),
    search: z._default(z.optional(z
      .string().check(z.maxLength(2_048), z.refine((value) => value.length === 0 || value.startsWith('?'), {
        message: 'Search must be empty or start with "?".',
      }))), ''),
  }));
export type LocalServicePreviewInitialPathV1 = z.infer<typeof LocalServicePreviewInitialPathV1Schema>;

export const LocalServicePreviewDisplayV1Schema = lazyZodSchema(() => z.strictObject({
    title: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    label: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    addressLabel: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    folderLabel: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    iconToken: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(64))),
    tone: z.optional(z.enum(['neutral', 'info', 'success', 'warning', 'danger', 'accent'])),
    diagnostics: z.optional(z.record(z.string(), z.unknown())),
  }));
export type LocalServicePreviewDisplayV1 = z.infer<typeof LocalServicePreviewDisplayV1Schema>;

export const LocalServicePreviewPolicyV1Schema = lazyZodSchema(() => z.strictObject({
    allowedMethods: z._default(z
      .array(z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])).check(z.minLength(1)), ['GET', 'HEAD', 'OPTIONS']),
    cookiePolicy: z._default(z.enum(['drop', 'isolate', 'rewrite']), 'drop'),
    compressionPolicy: z._default(z.enum(['identity', 'decode_reencode']), 'identity'),
    redirectPolicy: z._default(z.enum(['preserve_host_origin']), 'preserve_host_origin'),
    maxRequestBodyBytes: z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER)),
    maxResponseBodyBytes: z.number().check(z.int(), z.positive(), z.maximum(Number.MAX_SAFE_INTEGER)),
  }));
export type LocalServicePreviewPolicyV1 = z.infer<typeof LocalServicePreviewPolicyV1Schema>;

export const LocalServicePreviewOriginModeV1Schema = lazyZodSchema(() => z.enum(['host']));
export type LocalServicePreviewOriginModeV1 = z.infer<typeof LocalServicePreviewOriginModeV1Schema>;

export const LocalServicePreviewServiceTargetV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.omit(z.required(LocalServiceManagedServiceActionTargetV1Schema, { cwd: true, declaration: true }), { sessionId: true })));
export type LocalServicePreviewServiceTargetV1 = z.infer<typeof LocalServicePreviewServiceTargetV1Schema>;

export function refineLocalServicePreviewServiceBindingV1(
  value: Readonly<{ machineId: string; sessionId?: string; serviceTarget?: LocalServicePreviewServiceTargetV1; owner?: LocalServicePreviewOwnerV1 }>,
  context: z.core.$RefinementCtx,
): void {
  if (!value.serviceTarget) return;
  if (value.sessionId !== undefined || value.serviceTarget.machineId !== value.machineId
    || (value.owner !== undefined && value.owner.kind !== 'user')) {
    context.addIssue({ code: "custom", path: ['serviceTarget'], message: 'A service preview must bind one Machine and starter without Session authority.' });
  }
}

const LocalServicePreviewResourceShapeV1Schema = lazyZodSchema(() => z.strictObject({
    previewId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    sessionId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    serviceTarget: z.optional(LocalServicePreviewServiceTargetV1Schema),
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    owner: LocalServicePreviewOwnerV1Schema,
    target: LocalServicePreviewTargetV1Schema,
    initialPath: LocalServicePreviewInitialPathV1Schema,
    display: LocalServicePreviewDisplayV1Schema,
    originMode: LocalServicePreviewOriginModeV1Schema,
    policy: z.optional(LocalServicePreviewPolicyV1Schema),
    browserTarget: z.optional(BrowserLocalServicePreviewTargetV1Schema),
  }));
export const LocalServicePreviewResourceV1Schema = lazyZodSchema(() => LocalServicePreviewResourceShapeV1Schema.check(z.superRefine(refineLocalServicePreviewServiceBindingV1)));
export type LocalServicePreviewResourceV1 = z.infer<typeof LocalServicePreviewResourceV1Schema>;

// The authority-bearing subset stays bound to one registered resource. Display and
// navigation changes do not retarget an admitted preview.
export const LocalServicePreviewDirectBindingV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.pick(LocalServicePreviewResourceShapeV1Schema, {
  previewId: true, machineId: true, sessionId: true, serviceTarget: true, owner: true, target: true, policy: true,
})).check(z.superRefine(refineLocalServicePreviewServiceBindingV1)));
export type LocalServicePreviewDirectBindingV1 = z.infer<typeof LocalServicePreviewDirectBindingV1Schema>;

export function localServicePreviewDirectBindingV1(resource: LocalServicePreviewResourceV1): LocalServicePreviewDirectBindingV1 {
  const { previewId, machineId, sessionId, serviceTarget, owner, target, policy } = resource;
  return { previewId, machineId, ...(sessionId ? { sessionId } : {}), ...(serviceTarget ? { serviceTarget } : {}), owner, target, ...(policy ? { policy } : {}) };
}

export const DaemonLocalServicePreviewAdmissionRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ v: z.literal(1), kind: z.literal('read'), target: LocalServicePreviewServiceTargetV1Schema }),
  z.strictObject({ v: z.literal(1), kind: z.literal('wait_retirement'), target: LocalServicePreviewServiceTargetV1Schema,
    instanceId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)) }),
]).check(z.refine(request => request.kind !== 'wait_retirement' || request.instanceId === request.target.managedServiceId, { message: 'Retirement must address the admitted service occurrence.', path: ['instanceId'] })));
export type DaemonLocalServicePreviewAdmissionRequestV1 = z.infer<typeof DaemonLocalServicePreviewAdmissionRequestV1Schema>;

export const DaemonLocalServicePreviewAdmissionResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ v: z.literal(1), kind: z.literal('admitted'), instanceId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    serviceTarget: LocalServicePreviewServiceTargetV1Schema, starterAccountId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    endpoint: LocalServicePreviewTargetV1Schema }),
  z.strictObject({ v: z.literal(1), kind: z.literal('retired'), instanceId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)) }),
  z.strictObject({ v: z.literal(1), kind: z.literal('refused'), reasonCode: z.literal('service_unavailable') }),
]));
export type DaemonLocalServicePreviewAdmissionResponseV1 = z.infer<typeof DaemonLocalServicePreviewAdmissionResponseV1Schema>;

export const LocalServicePreviewNativeDirectDescriptorV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), kind: z.literal('iroh_preview'),
  previewId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
}));
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
  .string().check(z.trim(), z.url(), z.maxLength(4_096), z.refine(hasPreviewHttpProtocol, { message: 'Preview access URL must use http(s).' })));
export type LocalServicePreviewAccessUrlV1 = z.infer<typeof LocalServicePreviewAccessUrlV1Schema>;

// A registered preview resource projected together with its minted access URL. This is
// the canonical render contract the UI preview domain consumes: `accessUrl` is null when
// no served dev server URL could be minted (surface stays unavailable, never crashes).
export const LocalServicePreviewSnapshotRowV1Schema = lazyZodSchema(() => z.strictObject({
    previewId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    resource: LocalServicePreviewResourceV1Schema,
    accessUrl: z._default(z.nullable(LocalServicePreviewAccessUrlV1Schema), null),
    expiresAt: z._default(z.nullable(z.number().check(z.int(), z.nonnegative())), null),
    accessUnavailableReasonCode: z.optional(z.literal('preview_private_route_unavailable')),
    nativeDirect: z.optional(LocalServicePreviewNativeDirectDescriptorV1Schema),
    diagnostics: z._default(z.array(LocalServicePreviewDiagnosticV1Schema), []),
  }));
export type LocalServicePreviewSnapshotRowV1 = z.infer<typeof LocalServicePreviewSnapshotRowV1Schema>;

export const LocalServicePreviewSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    generatedAt: z.number().check(z.int(), z.nonnegative()),
    refreshState: z.enum(['idle', 'refreshing', 'error']),
    // Registered resources are metadata, not browser locations. Browser consumers
    // use only the server-issued render rows below; no resources fallback is authorized.
    resources: z.array(LocalServicePreviewResourceV1Schema),
    // Canonical render rows carrying the server-issued `accessUrl`. A snapshot without
    // rows supplies no browser admission; consumers must never reconstruct a location.
    previews: z.optional(z.array(LocalServicePreviewSnapshotRowV1Schema)),
    diagnostics: z._default(z.array(z.record(z.string(), z.unknown())), []),
  }));
export type LocalServicePreviewSnapshotV1 = z.infer<typeof LocalServicePreviewSnapshotV1Schema>;

export const DaemonLocalServicePreviewSnapshotRequestV1Schema = lazyZodSchema(() => z.strictObject({
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  }));
export type DaemonLocalServicePreviewSnapshotRequestV1 = z.infer<
  typeof DaemonLocalServicePreviewSnapshotRequestV1Schema
>;

export const DaemonLocalServicePreviewSnapshotResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    snapshot: LocalServicePreviewSnapshotV1Schema,
  }));
export type DaemonLocalServicePreviewSnapshotResponseV1 = z.infer<
  typeof DaemonLocalServicePreviewSnapshotResponseV1Schema
>;

export const LocalServicePreviewTokenV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('preview_access'),
    tokenId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    previewId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    sessionId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    issuedAt: z.number().check(z.int(), z.nonnegative()),
    expiresAt: z.nullable(z.number().check(z.int(), z.nonnegative())),
    exchangeMode: z.enum(['url', 'cookie']),
  }).check(z.refine((token) => token.exchangeMode === 'cookie' || token.expiresAt !== null, {
    message: 'URL admissions require an expiry.', path: ['expiresAt'],
  })));
export type LocalServicePreviewTokenV1 = z.infer<typeof LocalServicePreviewTokenV1Schema>;

// ---------------------------------------------------------------------------
// Private-preview lifecycle requests/responses (PRV-2). `openOrCreate` resolves a
// canonical launch/inventory target into a server-registered private preview and
// returns its minted-row projection; `revoke` removes a registered preview. These are
// the daemon-owned counterparts to the public-preview create/revoke shape — never a raw
// token, only the `BrowserViewTarget`-bearing snapshot row.
// ---------------------------------------------------------------------------

export const DaemonLocalServicePreviewOpenOrCreateRequestV1Schema = lazyZodSchema(() => z.strictObject({
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    sessionId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    // Exactly one canonical target reference resolves the preview (UI never sends a raw URL):
    // a detected inventory entry, a managed service, or a launcher target.
    inventoryEntryId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    managedServiceId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    launchTargetId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    serviceTarget: z.optional(LocalServicePreviewServiceTargetV1Schema),
    initialPath: z.optional(LocalServicePreviewInitialPathV1Schema),
  }).check(z.superRefine((request, context) => {
    refineLocalServicePreviewServiceBindingV1(request, context);
    if (request.serviceTarget && (request.inventoryEntryId || request.managedServiceId || request.launchTargetId)) {
      context.addIssue({ code: "custom", path: ['serviceTarget'], message: 'A source-qualified service is the only preview target.' });
    }
  })));
export type DaemonLocalServicePreviewOpenOrCreateRequestV1 = z.infer<
  typeof DaemonLocalServicePreviewOpenOrCreateRequestV1Schema
>;

export const DaemonLocalServicePreviewOpenOrCreateResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    status: z.enum(['created', 'existing']),
    preview: LocalServicePreviewSnapshotRowV1Schema,
    snapshot: LocalServicePreviewSnapshotV1Schema,
  }));
export type DaemonLocalServicePreviewOpenOrCreateResponseV1 = z.infer<
  typeof DaemonLocalServicePreviewOpenOrCreateResponseV1Schema
>;

export const DaemonLocalServicePreviewRevokeRequestV1Schema = lazyZodSchema(() => z.strictObject({
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    previewId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    serviceTarget: z.optional(LocalServicePreviewServiceTargetV1Schema),
  }).check(z.superRefine(refineLocalServicePreviewServiceBindingV1)));
export type DaemonLocalServicePreviewRevokeRequestV1 = z.infer<
  typeof DaemonLocalServicePreviewRevokeRequestV1Schema
>;

export const DaemonLocalServicePreviewRevokeResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    previewId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    revoked: z.boolean(),
    snapshot: LocalServicePreviewSnapshotV1Schema,
  }));
export type DaemonLocalServicePreviewRevokeResponseV1 = z.infer<
  typeof DaemonLocalServicePreviewRevokeResponseV1Schema
>;
