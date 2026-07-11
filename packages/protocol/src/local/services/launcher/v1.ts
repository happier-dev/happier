import { z } from 'zod';

import { BrowserViewTargetV1Schema } from '../../../browser/target/v1.js';
import { LocalServiceInventoryConfidenceV1Schema } from '../inventory/v1.js';

export const LocalServiceLaunchTargetSourceV1Schema = z.enum([
  'package_script',
  'managed_service',
  'inventory_entry',
  'registered_preview',
  'terminal_url',
  'workspace_file_asset',
  'recent',
]);
export type LocalServiceLaunchTargetSourceV1 = z.infer<typeof LocalServiceLaunchTargetSourceV1Schema>;

const LocalServiceLauncherIdV1Schema = z.string().trim().min(1).max(256);
const LocalServiceLauncherPathV1Schema = z.string().trim().min(1).max(2_048);
const LocalServiceLauncherLabelV1Schema = z.string().trim().min(1).max(512);
const LocalServiceLauncherAssetRefV1Schema = z.string().trim().min(1).max(2_048);

export const LocalServicePackageScriptLaunchSourceClassV1Schema = z
  .object({
    kind: z.literal('package_script'),
    runTargetId: LocalServiceLauncherIdV1Schema,
    packageName: LocalServiceLauncherIdV1Schema,
    scriptName: LocalServiceLauncherIdV1Schema,
    cwd: LocalServiceLauncherPathV1Schema.optional(),
  })
  .strict();
export type LocalServicePackageScriptLaunchSourceClassV1 = z.infer<typeof LocalServicePackageScriptLaunchSourceClassV1Schema>;

export const LocalServiceManagedLaunchSourceClassV1Schema = z
  .object({
    kind: z.literal('managed_service'),
    managedServiceId: LocalServiceLauncherIdV1Schema,
    inventoryEntryId: LocalServiceLauncherIdV1Schema.optional(),
  })
  .strict();
export type LocalServiceManagedLaunchSourceClassV1 = z.infer<typeof LocalServiceManagedLaunchSourceClassV1Schema>;

export const LocalServiceInventoryLaunchSourceClassV1Schema = z
  .object({
    kind: z.literal('inventory_entry'),
    inventoryEntryId: LocalServiceLauncherIdV1Schema,
  })
  .strict();
export type LocalServiceInventoryLaunchSourceClassV1 = z.infer<typeof LocalServiceInventoryLaunchSourceClassV1Schema>;

export const LocalServiceRegisteredPreviewLaunchSourceClassV1Schema = z
  .object({
    kind: z.literal('registered_preview'),
    previewId: LocalServiceLauncherIdV1Schema,
  })
  .strict();
export type LocalServiceRegisteredPreviewLaunchSourceClassV1 = z.infer<typeof LocalServiceRegisteredPreviewLaunchSourceClassV1Schema>;

export const LocalServiceTerminalUrlLaunchSourceClassV1Schema = z
  .object({
    kind: z.literal('terminal_url'),
    sourceId: LocalServiceLauncherIdV1Schema,
    addressLabel: LocalServiceLauncherLabelV1Schema,
    host: z.string().trim().min(1).max(256).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
  })
  .strict();
export type LocalServiceTerminalUrlLaunchSourceClassV1 = z.infer<typeof LocalServiceTerminalUrlLaunchSourceClassV1Schema>;

export const LocalServiceWorkspaceFileAssetLaunchSourceClassV1Schema = z
  .object({
    kind: z.literal('workspace_file_asset'),
    sourceId: LocalServiceLauncherIdV1Schema,
    assetRef: LocalServiceLauncherAssetRefV1Schema,
    mediaType: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type LocalServiceWorkspaceFileAssetLaunchSourceClassV1 = z.infer<typeof LocalServiceWorkspaceFileAssetLaunchSourceClassV1Schema>;

export const LocalServiceRecentLaunchSourceClassV1Schema = z
  .object({
    kind: z.literal('recent'),
    targetId: LocalServiceLauncherIdV1Schema,
  })
  .strict();
export type LocalServiceRecentLaunchSourceClassV1 = z.infer<typeof LocalServiceRecentLaunchSourceClassV1Schema>;

export const LocalServiceLaunchTargetSourceClassV1Schema = z.discriminatedUnion('kind', [
  LocalServicePackageScriptLaunchSourceClassV1Schema,
  LocalServiceManagedLaunchSourceClassV1Schema,
  LocalServiceInventoryLaunchSourceClassV1Schema,
  LocalServiceRegisteredPreviewLaunchSourceClassV1Schema,
  LocalServiceTerminalUrlLaunchSourceClassV1Schema,
  LocalServiceWorkspaceFileAssetLaunchSourceClassV1Schema,
  LocalServiceRecentLaunchSourceClassV1Schema,
]);
export type LocalServiceLaunchTargetSourceClassV1 = z.infer<typeof LocalServiceLaunchTargetSourceClassV1Schema>;

export const LocalServiceLaunchTargetActionV1Schema = z.enum([
  'start',
  'open',
  'open_preview',
  'register_preview',
  'manage',
  'terminate_detected',
]);
export type LocalServiceLaunchTargetActionV1 = z.infer<typeof LocalServiceLaunchTargetActionV1Schema>;

export const LocalServiceLaunchTargetStateV1Schema = z.enum([
  'available',
  'starting',
  'stale',
  'unavailable',
]);
export type LocalServiceLaunchTargetStateV1 = z.infer<typeof LocalServiceLaunchTargetStateV1Schema>;

export const LocalServiceLaunchTargetV1Schema = z
  .object({
    id: z.string().trim().min(1).max(256),
    source: LocalServiceLaunchTargetSourceV1Schema,
    sourceClass: LocalServiceLaunchTargetSourceClassV1Schema.optional(),
    machineId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256).optional(),
    workspaceId: z.string().trim().min(1).max(256).optional(),
    cwd: z.string().trim().min(1).max(2_048).optional(),
    title: z.string().trim().min(1).max(256),
    subtitle: z.string().trim().min(1).max(512).optional(),
    kind: z.string().trim().min(1).max(128).optional(),
    commandPreview: z.string().trim().min(1).max(1_000).optional(),
    confidence: LocalServiceInventoryConfidenceV1Schema,
    state: LocalServiceLaunchTargetStateV1Schema,
    unavailableReason: z.string().trim().min(1).max(256).optional(),
    actions: z.array(LocalServiceLaunchTargetActionV1Schema).default([]),
    browserTarget: BrowserViewTargetV1Schema.optional(),
  })
  .strict()
  .superRefine((target, ctx) => {
    if (target.sourceClass && target.sourceClass.kind !== target.source) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceClass', 'kind'],
        message: 'Launch target sourceClass.kind must match source.',
      });
    }
    if (target.state === 'unavailable' && !target.unavailableReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unavailableReason'],
        message: 'Unavailable launch targets must include an unavailableReason.',
      });
    }
    if (target.state === 'unavailable' && target.actions.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actions'],
        message: 'Unavailable launch targets cannot advertise enabled actions.',
      });
    }
  });
export type LocalServiceLaunchTargetV1 = z.infer<typeof LocalServiceLaunchTargetV1Schema>;

export const LocalServiceLauncherSnapshotV1Schema = z
  .object({
    v: z.literal(1),
    machineId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256).optional(),
    updatedAt: z.number().int().nonnegative(),
    targets: z.array(LocalServiceLaunchTargetV1Schema),
  })
  .strict();
export type LocalServiceLauncherSnapshotV1 = z.infer<typeof LocalServiceLauncherSnapshotV1Schema>;

export const DaemonLocalServiceLauncherSnapshotRequestV1Schema = z
  .object({
    machineId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256).optional(),
    // Explicit scope discriminator: `workspace` keeps the session/workspaceRoot scoping,
    // `machine` requests the full machine view even when a session is supplied. Defaults to
    // workspace when scoping data is present.
    scope: z.enum(['workspace', 'machine']).optional(),
    // Session-less project scoping: a project surface can scope by its repo root with no session.
    workspaceRoot: z.string().trim().min(1).max(1_024).optional(),
  })
  .strict();
export type DaemonLocalServiceLauncherSnapshotRequestV1 = z.infer<
  typeof DaemonLocalServiceLauncherSnapshotRequestV1Schema
>;

export const DaemonLocalServiceLauncherSnapshotResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    snapshot: LocalServiceLauncherSnapshotV1Schema,
  })
  .strict();
export type DaemonLocalServiceLauncherSnapshotResponseV1 = z.infer<
  typeof DaemonLocalServiceLauncherSnapshotResponseV1Schema
>;

export const DaemonLocalServiceLauncherStartRequestV1Schema = z
  .object({
    machineId: z.string().trim().min(1).max(256),
    targetId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256).optional(),
    workspaceId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type DaemonLocalServiceLauncherStartRequestV1 = z.infer<
  typeof DaemonLocalServiceLauncherStartRequestV1Schema
>;

export const DaemonLocalServiceLauncherStartResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    machineId: z.string().trim().min(1).max(256),
    targetId: z.string().trim().min(1).max(256),
    status: z.enum(['succeeded', 'denied', 'failed']),
    reasonCode: z.string().trim().min(1).max(256).optional(),
    snapshot: LocalServiceLauncherSnapshotV1Schema,
  })
  .strict()
  .superRefine((response, ctx) => {
    if (response.snapshot.machineId !== response.machineId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['snapshot', 'machineId'],
        message: 'Launcher start response snapshot machineId must match the response machineId.',
      });
    }
    if (response.status !== 'succeeded' && !response.reasonCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reasonCode'],
        message: 'Denied or failed launcher start responses must include a reasonCode.',
      });
    }
    if (response.status === 'succeeded' && response.reasonCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reasonCode'],
        message: 'Succeeded launcher start responses must not include a reasonCode.',
      });
    }
  });
export type DaemonLocalServiceLauncherStartResponseV1 = z.infer<
  typeof DaemonLocalServiceLauncherStartResponseV1Schema
>;

// ---------------------------------------------------------------------------
// Launcher leaf actions (LSV-1). `openPreview` resolves a target's browser view for a safe
// "open in browser" (Docker-style), `registerPreview` persists a loopback launcher target as
// a private preview, and `history.clear` dismisses the launcher feed history. Each takes the
// shared leaf request; responses are lean and carry the post-action snapshot where relevant.
// ---------------------------------------------------------------------------

export const DaemonLocalServiceLauncherLeafRequestV1Schema = z
  .object({
    machineId: z.string().trim().min(1).max(256),
    targetId: z.string().trim().min(1).max(256).optional(),
    sessionId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type DaemonLocalServiceLauncherLeafRequestV1 = z.infer<
  typeof DaemonLocalServiceLauncherLeafRequestV1Schema
>;

export const DaemonLocalServiceLauncherOpenPreviewResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    status: z.enum(['opened', 'unavailable']),
    targetId: z.string().trim().min(1).max(256),
    browserTarget: BrowserViewTargetV1Schema.optional(),
    reasonCode: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type DaemonLocalServiceLauncherOpenPreviewResponseV1 = z.infer<
  typeof DaemonLocalServiceLauncherOpenPreviewResponseV1Schema
>;

export const DaemonLocalServiceLauncherRegisterPreviewResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    status: z.enum(['registered', 'existing', 'unavailable']),
    targetId: z.string().trim().min(1).max(256),
    previewId: z.string().trim().min(1).max(256).optional(),
    browserTarget: BrowserViewTargetV1Schema.optional(),
    reasonCode: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
export type DaemonLocalServiceLauncherRegisterPreviewResponseV1 = z.infer<
  typeof DaemonLocalServiceLauncherRegisterPreviewResponseV1Schema
>;

export const DaemonLocalServiceLauncherHistoryClearResponseV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    cleared: z.number().int().nonnegative(),
    snapshot: LocalServiceLauncherSnapshotV1Schema,
  })
  .strict();
export type DaemonLocalServiceLauncherHistoryClearResponseV1 = z.infer<
  typeof DaemonLocalServiceLauncherHistoryClearResponseV1Schema
>;
