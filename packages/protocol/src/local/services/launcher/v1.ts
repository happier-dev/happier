import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';

import { BrowserViewTargetV1Schema } from '../../../browser/target/v1.js';
import { LocalServiceInventoryConfidenceV1Schema } from '../inventory/v1.js';
import { ProjectExecutionChoiceV1Schema } from '../../../workspaces/projectWorkerPreferencesV1.js';
import { ProjectServiceDeclarationRefV1Schema, LocalServiceManagedServiceActionTargetV1Schema } from '../actions/v1.js';
import { WorkspaceRefV1WriteSchema, WorkspaceAddressV1Schema } from '../../../workspaces/workspaceRefV1.js';
import { StrictJsonValueSchema } from '../../../json/strictJsonValue.js';

export const LocalServiceLaunchTargetSourceV1Schema = lazyZodSchema(() => z.enum([
  'package_script',
  'managed_service',
  'inventory_entry',
  'registered_preview',
  'terminal_url',
  'workspace_file_asset',
  'recent',
]));
export type LocalServiceLaunchTargetSourceV1 = z.infer<typeof LocalServiceLaunchTargetSourceV1Schema>;

const LocalServiceLauncherIdV1Schema = lazyZodSchema(() => z.string().trim().min(1).max(256));
const LocalServiceLauncherLabelV1Schema = lazyZodSchema(() => z.string().trim().min(1).max(512));
const LocalServiceLauncherAssetRefV1Schema = lazyZodSchema(() => z.string().trim().min(1).max(2_048));

export const LocalServicePackageScriptLaunchSourceClassV1Schema = lazyZodSchema(() => z
  .object({
    kind: z.literal('package_script'),
    runTargetId: LocalServiceLauncherIdV1Schema,
    packageName: z.string().trim().min(1),
    scriptName: LocalServiceLauncherIdV1Schema,
    cwd: WorkspaceRefV1WriteSchema.shape.rootPath.optional(),
  })
  .strict());
export type LocalServicePackageScriptLaunchSourceClassV1 = z.infer<typeof LocalServicePackageScriptLaunchSourceClassV1Schema>;

export const LocalServiceManagedLaunchSourceClassV1Schema = lazyZodSchema(() => z
  .object({
    kind: z.literal('managed_service'),
    managedServiceId: LocalServiceLauncherIdV1Schema,
    inventoryEntryId: LocalServiceLauncherIdV1Schema.optional(),
  })
  .strict());
export type LocalServiceManagedLaunchSourceClassV1 = z.infer<typeof LocalServiceManagedLaunchSourceClassV1Schema>;

export const LocalServiceInventoryLaunchSourceClassV1Schema = lazyZodSchema(() => z
  .object({
    kind: z.literal('inventory_entry'),
    inventoryEntryId: LocalServiceLauncherIdV1Schema,
  })
  .strict());
export type LocalServiceInventoryLaunchSourceClassV1 = z.infer<typeof LocalServiceInventoryLaunchSourceClassV1Schema>;

export const LocalServiceRegisteredPreviewLaunchSourceClassV1Schema = lazyZodSchema(() => z
  .object({
    kind: z.literal('registered_preview'),
    previewId: LocalServiceLauncherIdV1Schema,
  })
  .strict());
export type LocalServiceRegisteredPreviewLaunchSourceClassV1 = z.infer<typeof LocalServiceRegisteredPreviewLaunchSourceClassV1Schema>;

export const LocalServiceTerminalUrlLaunchSourceClassV1Schema = lazyZodSchema(() => z
  .object({
    kind: z.literal('terminal_url'),
    sourceId: LocalServiceLauncherIdV1Schema,
    addressLabel: LocalServiceLauncherLabelV1Schema,
    host: z.string().trim().min(1).max(256).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
  })
  .strict());
export type LocalServiceTerminalUrlLaunchSourceClassV1 = z.infer<typeof LocalServiceTerminalUrlLaunchSourceClassV1Schema>;

export const LocalServiceWorkspaceFileAssetLaunchSourceClassV1Schema = lazyZodSchema(() => z
  .object({
    kind: z.literal('workspace_file_asset'),
    sourceId: LocalServiceLauncherIdV1Schema,
    assetRef: LocalServiceLauncherAssetRefV1Schema,
    mediaType: z.string().trim().min(1).max(256).optional(),
  })
  .strict());
export type LocalServiceWorkspaceFileAssetLaunchSourceClassV1 = z.infer<typeof LocalServiceWorkspaceFileAssetLaunchSourceClassV1Schema>;

export const LocalServiceRecentLaunchSourceClassV1Schema = lazyZodSchema(() => z
  .object({
    kind: z.literal('recent'),
    targetId: LocalServiceLauncherIdV1Schema,
  })
  .strict());
export type LocalServiceRecentLaunchSourceClassV1 = z.infer<typeof LocalServiceRecentLaunchSourceClassV1Schema>;

export const LocalServiceLaunchTargetSourceClassV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  LocalServicePackageScriptLaunchSourceClassV1Schema,
  LocalServiceManagedLaunchSourceClassV1Schema,
  LocalServiceInventoryLaunchSourceClassV1Schema,
  LocalServiceRegisteredPreviewLaunchSourceClassV1Schema,
  LocalServiceTerminalUrlLaunchSourceClassV1Schema,
  LocalServiceWorkspaceFileAssetLaunchSourceClassV1Schema,
  LocalServiceRecentLaunchSourceClassV1Schema,
]));
export type LocalServiceLaunchTargetSourceClassV1 = z.infer<typeof LocalServiceLaunchTargetSourceClassV1Schema>;

export const LocalServiceLaunchTargetActionV1Schema = lazyZodSchema(() => z.enum([
  'start',
  'open',
  'open_preview',
  'register_preview',
  'manage',
  'terminate_detected',
]));
export type LocalServiceLaunchTargetActionV1 = z.infer<typeof LocalServiceLaunchTargetActionV1Schema>;

export const LocalServiceLaunchTargetStateV1Schema = lazyZodSchema(() => z.enum([
  'available',
  'starting',
  'stale',
  'unavailable',
]));
export type LocalServiceLaunchTargetStateV1 = z.infer<typeof LocalServiceLaunchTargetStateV1Schema>;

/** Presentation bound only; declaration identity remains lossless. */
export const LOCAL_SERVICE_LAUNCH_TARGET_TITLE_MAX_LENGTH = 256;

export const LocalServiceLaunchTargetV1Schema = lazyZodSchema(() => z
  .object({
    id: z.string().trim().min(1).max(256),
    source: LocalServiceLaunchTargetSourceV1Schema,
    sourceClass: LocalServiceLaunchTargetSourceClassV1Schema.optional(),
    machineId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256).optional(),
    workspaceId: WorkspaceRefV1WriteSchema.shape.id.optional(),
    workspace: WorkspaceAddressV1Schema.optional(),
    cwd: WorkspaceRefV1WriteSchema.shape.rootPath.optional(),
    declaration: ProjectServiceDeclarationRefV1Schema.optional(),
    // Observed managed lifetime is separate from an available launcher action/HTTP readiness.
    serviceState: z.enum(['starting', 'running', 'detecting', 'healthy', 'unhealthy', 'stopping', 'stopped', 'failed']).optional(),
    readiness: z.enum(['ready', 'not_ready', 'not_reported']).optional(),
    endpointUrl: z.string().url().optional(),
    startedAtMs: z.number().int().nonnegative().optional(),
    startedByAccountId: z.string().min(1).optional(),
    endpointKind: z.enum(['none', 'http', 'native']).optional(),
    title: z.string().trim().min(1).max(LOCAL_SERVICE_LAUNCH_TARGET_TITLE_MAX_LENGTH),
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
  }));
export type LocalServiceLaunchTargetV1 = z.infer<typeof LocalServiceLaunchTargetV1Schema>;

export const LocalServiceLauncherSnapshotV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1),
    machineId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256).optional(),
    updatedAt: z.number().int().nonnegative(),
    targets: z.array(LocalServiceLaunchTargetV1Schema),
  })
  .strict());
export type LocalServiceLauncherSnapshotV1 = z.infer<typeof LocalServiceLauncherSnapshotV1Schema>;

export const DaemonLocalServiceLauncherSnapshotRequestV1Schema = lazyZodSchema(() => z
  .object({
    machineId: z.string().trim().min(1).max(256),
    // Explicit native-custody read: complete owned targets, not dismissible launcher suggestions.
    projection: z.literal('managed_bindings').optional(),
    sessionId: z.string().trim().min(1).max(256).optional(),
    // Explicit scope discriminator: `workspace` keeps the session/workspaceRoot scoping,
    // `machine` requests the full machine view even when a session is supplied. Defaults to
    // workspace when scoping data is present.
    scope: z.enum(['workspace', 'machine']).optional(),
    // Session-less project scoping: a project surface can scope by its repo root with no session.
    workspaceRoot: WorkspaceRefV1WriteSchema.shape.rootPath.optional(),
  })
  .strict());
export type DaemonLocalServiceLauncherSnapshotRequestV1 = z.infer<
  typeof DaemonLocalServiceLauncherSnapshotRequestV1Schema
>;

export const DaemonLocalServiceLauncherSnapshotResponseV1Schema = lazyZodSchema(() => z
  .object({
    protocolVersion: z.literal(1),
    snapshot: LocalServiceLauncherSnapshotV1Schema,
  })
  .strict());
export type DaemonLocalServiceLauncherSnapshotResponseV1 = z.infer<
  typeof DaemonLocalServiceLauncherSnapshotResponseV1Schema
>;

export const DaemonLocalServiceLauncherStartRequestV1Schema = lazyZodSchema(() => z
  .object({
    machineId: z.string().trim().min(1).max(256),
    targetId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256).optional(),
    workspaceId: WorkspaceRefV1WriteSchema.shape.id.optional(),
    choice: ProjectExecutionChoiceV1Schema.optional(),
    workspace: WorkspaceAddressV1Schema.optional(),
    declaration: ProjectServiceDeclarationRefV1Schema.optional(),
    expectedEffectDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })
  .strict());
export type DaemonLocalServiceLauncherStartRequestV1 = z.infer<
  typeof DaemonLocalServiceLauncherStartRequestV1Schema
>;

export const DaemonLocalServiceLauncherStartResponseV1Schema = lazyZodSchema(() => z
  .object({
    protocolVersion: z.literal(1),
    machineId: z.string().trim().min(1).max(256),
    targetId: z.string().trim().min(1).max(256),
    status: z.enum(['succeeded', 'denied', 'failed']),
    reasonCode: z.string().trim().min(1).max(256).optional(),
    reviewedEffect: StrictJsonValueSchema.optional(),
    reviewedEffectDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    currentTarget: LocalServiceManagedServiceActionTargetV1Schema.optional(),
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
    if (response.currentTarget && response.currentTarget.machineId !== response.machineId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['currentTarget', 'machineId'],
        message: 'Current managed target must belong to the response Machine.' });
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
  }));
export type DaemonLocalServiceLauncherStartResponseV1 = z.infer<
  typeof DaemonLocalServiceLauncherStartResponseV1Schema
>;

// ---------------------------------------------------------------------------
// Launcher leaf actions (LSV-1). `openPreview` resolves a target's browser view for a safe
// "open in browser" (Docker-style), `registerPreview` persists a loopback launcher target as
// a private preview, and `history.clear` dismisses the launcher feed history. Each takes the
// shared leaf request; responses are lean and carry the post-action snapshot where relevant.
// ---------------------------------------------------------------------------

export const DaemonLocalServiceLauncherLeafRequestV1Schema = lazyZodSchema(() => DaemonLocalServiceLauncherSnapshotRequestV1Schema
  .omit({ projection: true })
  .extend({
    targetId: z.string().trim().min(1).max(256).optional(),
  })
  .strict());
export type DaemonLocalServiceLauncherLeafRequestV1 = z.infer<
  typeof DaemonLocalServiceLauncherLeafRequestV1Schema
>;

export const DaemonLocalServiceLauncherOpenPreviewResponseV1Schema = lazyZodSchema(() => z
  .object({
    protocolVersion: z.literal(1),
    status: z.enum(['opened', 'unavailable']),
    targetId: z.string().trim().min(1).max(256),
    browserTarget: BrowserViewTargetV1Schema.optional(),
    reasonCode: z.string().trim().min(1).max(256).optional(),
  })
  .strict());
export type DaemonLocalServiceLauncherOpenPreviewResponseV1 = z.infer<
  typeof DaemonLocalServiceLauncherOpenPreviewResponseV1Schema
>;

export const DaemonLocalServiceLauncherRegisterPreviewResponseV1Schema = lazyZodSchema(() => z
  .object({
    protocolVersion: z.literal(1),
    status: z.enum(['registered', 'existing', 'unavailable']),
    targetId: z.string().trim().min(1).max(256),
    previewId: z.string().trim().min(1).max(256).optional(),
    browserTarget: BrowserViewTargetV1Schema.optional(),
    reasonCode: z.string().trim().min(1).max(256).optional(),
  })
  .strict());
export type DaemonLocalServiceLauncherRegisterPreviewResponseV1 = z.infer<
  typeof DaemonLocalServiceLauncherRegisterPreviewResponseV1Schema
>;

export const DaemonLocalServiceLauncherHistoryClearResponseV1Schema = lazyZodSchema(() => z
  .object({
    protocolVersion: z.literal(1),
    cleared: z.number().int().nonnegative(),
    snapshot: LocalServiceLauncherSnapshotV1Schema,
  })
  .strict());
export type DaemonLocalServiceLauncherHistoryClearResponseV1 = z.infer<
  typeof DaemonLocalServiceLauncherHistoryClearResponseV1Schema
>;
