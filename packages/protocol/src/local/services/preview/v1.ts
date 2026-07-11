import { z } from 'zod';

import { BrowserLocalServicePreviewTargetV1Schema } from '../../../browser/target/v1.js';
import { LocalServiceLoopbackHostV1Schema } from '../hosts.js';
import { LocalServicePreviewDiagnosticV1Schema } from './diagnostics/v1.js';

export const LocalServicePreviewOwnerV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), id: z.string().trim().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('session'), id: z.string().trim().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('plugin'), id: z.string().trim().min(1).max(256) }).strict(),
  z.object({ kind: z.literal('agent'), id: z.string().trim().min(1).max(256) }).strict(),
]);
export type LocalServicePreviewOwnerV1 = z.infer<typeof LocalServicePreviewOwnerV1Schema>;

export const LocalServicePreviewTargetV1Schema = z
  .object({
    scheme: z.enum(['http', 'https']),
    host: LocalServiceLoopbackHostV1Schema,
    port: z.number().int().min(1).max(65_535),
  })
  .strict();
export type LocalServicePreviewTargetV1 = z.infer<typeof LocalServicePreviewTargetV1Schema>;

export const LocalServicePreviewInitialPathV1Schema = z
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
  .strict();
export type LocalServicePreviewInitialPathV1 = z.infer<typeof LocalServicePreviewInitialPathV1Schema>;

export const LocalServicePreviewDisplayV1Schema = z
  .object({
    title: z.string().trim().min(1).max(256),
    label: z.string().trim().min(1).max(256).optional(),
    addressLabel: z.string().trim().min(1).max(256),
    folderLabel: z.string().trim().min(1).max(256).optional(),
    iconToken: z.string().trim().min(1).max(64).optional(),
    tone: z.enum(['neutral', 'info', 'success', 'warning', 'danger', 'accent']).optional(),
    diagnostics: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type LocalServicePreviewDisplayV1 = z.infer<typeof LocalServicePreviewDisplayV1Schema>;

export const LocalServicePreviewPolicyV1Schema = z
  .object({
    allowedMethods: z
      .array(z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']))
      .min(1)
      .default(['GET', 'HEAD', 'OPTIONS']),
    cookiePolicy: z.enum(['drop', 'isolate', 'rewrite']).default('drop'),
    compressionPolicy: z.enum(['identity', 'decode_reencode']).default('identity'),
    redirectPolicy: z.enum(['preserve_host_origin', 'rewrite_path_mode']).default('preserve_host_origin'),
    maxRequestBodyBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxResponseBodyBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type LocalServicePreviewPolicyV1 = z.infer<typeof LocalServicePreviewPolicyV1Schema>;

export const LocalServicePreviewOriginModeV1Schema = z.enum(['host', 'path']);
export type LocalServicePreviewOriginModeV1 = z.infer<typeof LocalServicePreviewOriginModeV1Schema>;

export const LocalServicePreviewResourceV1Schema = z
  .object({
    previewId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256),
    machineId: z.string().trim().min(1).max(256),
    owner: LocalServicePreviewOwnerV1Schema,
    target: LocalServicePreviewTargetV1Schema,
    initialPath: LocalServicePreviewInitialPathV1Schema,
    display: LocalServicePreviewDisplayV1Schema,
    originMode: LocalServicePreviewOriginModeV1Schema,
    policy: LocalServicePreviewPolicyV1Schema.optional(),
    browserTarget: BrowserLocalServicePreviewTargetV1Schema.optional(),
  })
  .strict();
export type LocalServicePreviewResourceV1 = z.infer<typeof LocalServicePreviewResourceV1Schema>;

function hasPreviewHttpProtocol(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// The minted location a private preview iframe/WebView should load. For an own
// (private) dev server this is the loopback origin itself; only http(s) is allowed
// so no javascript:/data: location can be smuggled into the embed.
export const LocalServicePreviewAccessUrlV1Schema = z
  .string()
  .trim()
  .url()
  .max(4_096)
  .refine(hasPreviewHttpProtocol, { message: 'Preview access URL must use http(s).' });
export type LocalServicePreviewAccessUrlV1 = z.infer<typeof LocalServicePreviewAccessUrlV1Schema>;

// A registered preview resource projected together with its minted access URL. This is
// the canonical render contract the UI preview domain consumes: `accessUrl` is null when
// no served dev server URL could be minted (surface stays unavailable, never crashes).
export const LocalServicePreviewSnapshotRowV1Schema = z
  .object({
    previewId: z.string().trim().min(1).max(256),
    resource: LocalServicePreviewResourceV1Schema,
    accessUrl: LocalServicePreviewAccessUrlV1Schema.nullable().default(null),
    expiresAt: z.number().int().nonnegative().nullable().default(null),
    diagnostics: z.array(LocalServicePreviewDiagnosticV1Schema).default([]),
  })
  .strict();
export type LocalServicePreviewSnapshotRowV1 = z.infer<typeof LocalServicePreviewSnapshotRowV1Schema>;

export const LocalServicePreviewSnapshotV1Schema = z
  .object({
    v: z.literal(1),
    machineId: z.string().trim().min(1).max(256),
    generatedAt: z.number().int().nonnegative(),
    refreshState: z.enum(['idle', 'refreshing', 'error']),
    // Legacy registered-resource list, retained for backward compatibility: an
    // old-daemon snapshot omits `previews`, so consumers fall back to `resources`.
    resources: z.array(LocalServicePreviewResourceV1Schema),
    // Canonical render rows carrying the minted `accessUrl`. Optional (no default) so an
    // old-daemon snapshot without this key parses unchanged and the consumer's
    // resources-fallback path stays live (§12.13 backward compatibility).
    previews: z.array(LocalServicePreviewSnapshotRowV1Schema).optional(),
    diagnostics: z.array(z.record(z.string(), z.unknown())).default([]),
  })
  .strict();
export type LocalServicePreviewSnapshotV1 = z.infer<typeof LocalServicePreviewSnapshotV1Schema>;

export const DaemonLocalServicePreviewSnapshotRequestV1Schema = z
  .object({
    machineId: z.string().trim().min(1).max(256),
  })
  .strict();
export type DaemonLocalServicePreviewSnapshotRequestV1 = z.infer<
  typeof DaemonLocalServicePreviewSnapshotRequestV1Schema
>;

export const DaemonLocalServicePreviewSnapshotResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    snapshot: LocalServicePreviewSnapshotV1Schema,
  })
  .strict();
export type DaemonLocalServicePreviewSnapshotResponseV1 = z.infer<
  typeof DaemonLocalServicePreviewSnapshotResponseV1Schema
>;

export const LocalServicePreviewTokenV1Schema = z
  .object({
    kind: z.literal('preview_access'),
    tokenId: z.string().trim().min(1).max(256),
    previewId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256),
    machineId: z.string().trim().min(1).max(256),
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    exchangeMode: z.enum(['url', 'cookie']),
  })
  .strict();
export type LocalServicePreviewTokenV1 = z.infer<typeof LocalServicePreviewTokenV1Schema>;

// ---------------------------------------------------------------------------
// Private-preview lifecycle requests/responses (PRV-2). `openOrCreate` resolves a
// canonical launch/inventory target into a registered private (loopback) preview and
// returns its minted-row projection; `revoke` removes a registered preview. These are
// the daemon-owned counterparts to the public-preview create/revoke shape — never a raw
// token, only the `BrowserViewTarget`-bearing snapshot row.
// ---------------------------------------------------------------------------

export const DaemonLocalServicePreviewOpenOrCreateRequestV1Schema = z
  .object({
    machineId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256).optional(),
    // Exactly one canonical target reference resolves the preview (UI never sends a raw URL):
    // a detected inventory entry, a managed service, or a launcher target.
    inventoryEntryId: z.string().trim().min(1).max(256).optional(),
    managedServiceId: z.string().trim().min(1).max(256).optional(),
    launchTargetId: z.string().trim().min(1).max(256).optional(),
    initialPath: LocalServicePreviewInitialPathV1Schema.optional(),
  })
  .strict();
export type DaemonLocalServicePreviewOpenOrCreateRequestV1 = z.infer<
  typeof DaemonLocalServicePreviewOpenOrCreateRequestV1Schema
>;

export const DaemonLocalServicePreviewOpenOrCreateResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    status: z.enum(['created', 'existing']),
    preview: LocalServicePreviewSnapshotRowV1Schema,
    snapshot: LocalServicePreviewSnapshotV1Schema,
  })
  .strict();
export type DaemonLocalServicePreviewOpenOrCreateResponseV1 = z.infer<
  typeof DaemonLocalServicePreviewOpenOrCreateResponseV1Schema
>;

export const DaemonLocalServicePreviewRevokeRequestV1Schema = z
  .object({
    machineId: z.string().trim().min(1).max(256),
    previewId: z.string().trim().min(1).max(256),
  })
  .strict();
export type DaemonLocalServicePreviewRevokeRequestV1 = z.infer<
  typeof DaemonLocalServicePreviewRevokeRequestV1Schema
>;

export const DaemonLocalServicePreviewRevokeResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    previewId: z.string().trim().min(1).max(256),
    revoked: z.boolean(),
    snapshot: LocalServicePreviewSnapshotV1Schema,
  })
  .strict();
export type DaemonLocalServicePreviewRevokeResponseV1 = z.infer<
  typeof DaemonLocalServicePreviewRevokeResponseV1Schema
>;
