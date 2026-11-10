import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';

import { BrowserViewTargetV1Schema } from '../../../browser/target/v1.js';
import { LocalServiceInventoryConfidenceV1Schema } from '../inventory/v1.js';
import { ProjectExecutionChoiceV1Schema } from '../../../workspaces/projectWorkerPreferencesV1.js';
import { ProjectServiceDeclarationRefV1Schema, LocalServiceManagedServiceActionTargetV1Schema } from '../actions/v1.js';
import { WorkspaceRefV1WriteSchema, WorkspaceAddressV1Schema } from '../../../workspaces/workspaceRefV1.js';
import { StrictJsonValueSchema } from '../../../json/strictJsonValue.js';
import { QualifiedProjectTrustProjectV1Schema } from '../../../workspaces/projectSetup/projectTrustRowV1.js';
import { ProjectSetupReviewV1Schema } from '../../../actions/projectSetupConsentFailure.js';
import { ActionSurfaceSchema } from '../../../actions/metadata.js';
import { ActionExecuteFailureSchema } from '../../../actions/actionExecutionResult.js';
import { PluginDiagnosticDataV1Schema } from '../../../daemon/pluginContributionIntrospection.js';
import { projectZodProtocolSchema } from '../../../plugins/actions/internalProtocolZodAdapter.js';

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

const LocalServiceLauncherIdV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));
const LocalServiceLauncherLabelV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(512)));
const LocalServiceLauncherAssetRefV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(2_048)));

export const LocalServicePackageScriptLaunchSourceClassV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('package_script'),
    runTargetId: LocalServiceLauncherIdV1Schema,
    packageName: z.string().check(z.trim(), z.minLength(1)),
    scriptName: LocalServiceLauncherIdV1Schema,
    cwd: z.optional(WorkspaceRefV1WriteSchema.shape.rootPath),
  }));
export type LocalServicePackageScriptLaunchSourceClassV1 = z.infer<typeof LocalServicePackageScriptLaunchSourceClassV1Schema>;

export const LocalServiceManagedLaunchSourceClassV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('managed_service'),
    managedServiceId: LocalServiceLauncherIdV1Schema,
    inventoryEntryId: z.optional(LocalServiceLauncherIdV1Schema),
  }));
export type LocalServiceManagedLaunchSourceClassV1 = z.infer<typeof LocalServiceManagedLaunchSourceClassV1Schema>;

export const LocalServiceInventoryLaunchSourceClassV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('inventory_entry'),
    inventoryEntryId: LocalServiceLauncherIdV1Schema,
  }));
export type LocalServiceInventoryLaunchSourceClassV1 = z.infer<typeof LocalServiceInventoryLaunchSourceClassV1Schema>;

export const LocalServiceRegisteredPreviewLaunchSourceClassV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('registered_preview'),
    previewId: LocalServiceLauncherIdV1Schema,
  }));
export type LocalServiceRegisteredPreviewLaunchSourceClassV1 = z.infer<typeof LocalServiceRegisteredPreviewLaunchSourceClassV1Schema>;

export const LocalServiceTerminalUrlLaunchSourceClassV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('terminal_url'),
    sourceId: LocalServiceLauncherIdV1Schema,
    addressLabel: LocalServiceLauncherLabelV1Schema,
    host: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    port: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(65_535))),
  }));
export type LocalServiceTerminalUrlLaunchSourceClassV1 = z.infer<typeof LocalServiceTerminalUrlLaunchSourceClassV1Schema>;

export const LocalServiceWorkspaceFileAssetLaunchSourceClassV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('workspace_file_asset'),
    sourceId: LocalServiceLauncherIdV1Schema,
    assetRef: LocalServiceLauncherAssetRefV1Schema,
    mediaType: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
  }));
export type LocalServiceWorkspaceFileAssetLaunchSourceClassV1 = z.infer<typeof LocalServiceWorkspaceFileAssetLaunchSourceClassV1Schema>;

export const LocalServiceRecentLaunchSourceClassV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('recent'),
    targetId: LocalServiceLauncherIdV1Schema,
  }));
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
export const LOCAL_SERVICE_LAUNCH_TARGET_COMMAND_PREVIEW_MAX_LENGTH = 1_000;

export const LocalServiceLaunchTargetV1Schema = lazyZodSchema(() => z.strictObject({
    id: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    source: LocalServiceLaunchTargetSourceV1Schema,
    sourceClass: z.optional(LocalServiceLaunchTargetSourceClassV1Schema),
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    sessionId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    workspaceId: z.optional(WorkspaceRefV1WriteSchema.shape.id),
    workspace: z.optional(WorkspaceAddressV1Schema),
    cwd: z.optional(WorkspaceRefV1WriteSchema.shape.rootPath),
    declaration: z.optional(ProjectServiceDeclarationRefV1Schema),
    /** Admitted Environment identity; release paths and actor attribution stay host-private. */
    environment: z.optional(z.strictObject({
      environmentId: LocalServiceLauncherIdV1Schema,
      environmentInstanceId: LocalServiceLauncherIdV1Schema,
      deploymentId: LocalServiceLauncherIdV1Schema,
      composeService: LocalServiceLauncherIdV1Schema,
    })),
    lifecyclePurpose: z.optional(z.enum(['development', 'deployment', 'infrastructure'])),
    // Captured by the admitted native start; omission grants no execution class.
    execution: z.optional(z.enum(['primary', 'portable'])),
    // Observed managed lifetime is separate from an available launcher action/HTTP readiness.
    serviceState: z.optional(z.enum(['starting', 'running', 'detecting', 'healthy', 'unhealthy', 'stopping', 'stopped', 'failed'])),
    /** Supervisor-bounded and sanitized failure presentation; no private diagnostic details. */
    diagnostics: z.optional(z.array(z.pick(PluginDiagnosticDataV1Schema, { code: true, severity: true, message: true }))),
    readiness: z.optional(z.enum(['ready', 'not_ready', 'not_reported'])),
    endpointUrl: z.optional(z.string().check(z.url())),
    startedAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
    startedByAccountId: z.optional(z.string().check(z.minLength(1))),
    endpointKind: z.optional(z.enum(['none', 'http', 'native'])),
    title: z.string().check(z.trim(), z.minLength(1), z.maxLength(LOCAL_SERVICE_LAUNCH_TARGET_TITLE_MAX_LENGTH)),
    subtitle: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
    kind: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(128))),
    commandPreview: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(LOCAL_SERVICE_LAUNCH_TARGET_COMMAND_PREVIEW_MAX_LENGTH))),
    confidence: LocalServiceInventoryConfidenceV1Schema,
    state: LocalServiceLaunchTargetStateV1Schema,
    unavailableReason: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    /** Exact Machine whose Project native-binding census could not settle. */
    unavailableMachineId: z.optional(WorkspaceRefV1WriteSchema.shape.machineId),
    actions: z._default(z.array(LocalServiceLaunchTargetActionV1Schema), []),
    browserTarget: z.optional(BrowserViewTargetV1Schema),
  }).check(z.superRefine((target, ctx) => {
    if (target.environment && (
      target.source !== 'managed_service'
      || target.id !== `${target.environment.environmentInstanceId}/${target.environment.composeService}`
      || target.lifecyclePurpose !== 'deployment'
      || target.workspace !== undefined || target.workspaceId !== undefined || target.cwd !== undefined
      || target.declaration !== undefined || target.execution !== undefined || target.sessionId !== undefined
      || target.startedByAccountId !== undefined
    )) {
      ctx.addIssue({ code: 'custom', path: ['environment'], message: 'Environment services require exact deployment identity without Workspace authority.' });
    }
    if (target.sourceClass && target.sourceClass.kind !== target.source) {
      ctx.addIssue({
        code: "custom",
        path: ['sourceClass', 'kind'],
        message: 'Launch target sourceClass.kind must match source.',
      });
    }
    if (target.state === 'unavailable' && !target.unavailableReason) {
      ctx.addIssue({
        code: "custom",
        path: ['unavailableReason'],
        message: 'Unavailable launch targets must include an unavailableReason.',
      });
    }
    if (target.state === 'unavailable' && target.actions.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ['actions'],
        message: 'Unavailable launch targets cannot advertise enabled actions.',
      });
    }
  })));
export type LocalServiceLaunchTargetV1 = z.infer<typeof LocalServiceLaunchTargetV1Schema>;

/** A live managed lifetime, independently of HTTP readiness. Starting/stopping are transitions.
 * Native custody must still be qualified separately before an executable action.
 */
export function isLocalServiceStateRunningV1(state: LocalServiceLaunchTargetV1['serviceState']): boolean {
  return state === 'running' || state === 'detecting' || state === 'healthy' || state === 'unhealthy';
}

/** An unhealthy observation can instead mean native custody has not settled. */
export function hasUncertainLocalServiceNativeCustodyV1(
  target: Pick<LocalServiceLaunchTargetV1, 'source' | 'unavailableReason'>,
): boolean {
  return target.source === 'managed_service' && (
    target.unavailableReason === 'managed_service_native_state_unknown'
    || target.unavailableReason === 'managed_service_native_cleanup_unconfirmed'
  );
}

export const LocalServiceLauncherSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    sessionId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    updatedAt: z.number().check(z.int(), z.nonnegative()),
    targets: z.array(LocalServiceLaunchTargetV1Schema),
  }));
export type LocalServiceLauncherSnapshotV1 = z.infer<typeof LocalServiceLauncherSnapshotV1Schema>;

export const DaemonLocalServiceLauncherSnapshotRequestV1Schema = lazyZodSchema(() => z.strictObject({
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    // Explicit native-custody read: complete owned targets, not dismissible launcher suggestions.
    projection: z.optional(z.literal('managed_bindings')),
    sessionId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    // Explicit scope discriminator: `workspace` keeps the session/workspaceRoot scoping,
    // `machine` requests the full machine view even when a session is supplied. Defaults to
    // workspace when scoping data is present.
    scope: z.optional(z.enum(['workspace', 'machine'])),
    // Session-less project scoping: a project surface can scope by its repo root with no session.
    workspaceRoot: z.optional(WorkspaceRefV1WriteSchema.shape.rootPath),
    /** Read-only native review for the ordinary Start approval, never execution. */
    startReview: z.optional(z.strictObject({ request: DaemonLocalServiceLauncherStartRequestV1Schema,
        surface: z.keyof(ActionSurfaceSchema) })),
  }));
export type DaemonLocalServiceLauncherSnapshotRequestV1 = z.infer<
  typeof DaemonLocalServiceLauncherSnapshotRequestV1Schema
>;

/** A mounted Workspace launcher contributes discovery demand to the Machine observation. */
export const LocalServiceLauncherScopeV1Schema = lazyZodSchema(() => z.pick(
  DaemonLocalServiceLauncherSnapshotRequestV1Schema, { sessionId: true, workspaceRoot: true },
));
export type LocalServiceLauncherScopeV1 = z.infer<typeof LocalServiceLauncherScopeV1Schema>;

export const DaemonLocalServiceLauncherSnapshotResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    snapshot: LocalServiceLauncherSnapshotV1Schema,
    startReview: z.optional(z.union([LocalServiceStartApprovalReviewV1Schema, ActionExecuteFailureSchema])),
  }));
export type DaemonLocalServiceLauncherSnapshotResponseV1 = z.infer<
  typeof DaemonLocalServiceLauncherSnapshotResponseV1Schema
>;

export const DaemonLocalServiceLauncherStartRequestV1Schema = lazyZodSchema(() => z.strictObject({
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    targetId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    sessionId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    workspaceId: z.optional(WorkspaceRefV1WriteSchema.shape.id),
    choice: z.optional(ProjectExecutionChoiceV1Schema),
    workspace: z.optional(WorkspaceAddressV1Schema),
    declaration: z.optional(ProjectServiceDeclarationRefV1Schema),
    expectedEffectDigest: z.optional(z.string().check(z.regex(/^[a-f0-9]{64}$/))),
    /** Move's signed child operand; consent still requires its admitted private root. */
    setupReview: z.optional(ProjectSetupReviewV1Schema),
  }));
export type DaemonLocalServiceLauncherStartRequestV1 = z.infer<
  typeof DaemonLocalServiceLauncherStartRequestV1Schema
>;

/** Native-produced approval custody. The signed Start request remains unchanged. */
export const LocalServiceStartApprovalReviewV1Schema = lazyZodSchema(() => z.strictObject({
    request: DaemonLocalServiceLauncherStartRequestV1Schema,
    target: WorkspaceAddressV1Schema,
    reviewedEffect: StrictJsonValueSchema,
    reviewedEffectDigest: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
    setup: z.strictObject({
        required: z.boolean(),
        project: QualifiedProjectTrustProjectV1Schema,
        ...ProjectSetupReviewV1Schema.shape,
    }),
}).check(z.superRefine((review, ctx) => {
    if (!review.request.workspace || !review.request.declaration
        || review.request.machineId !== review.target.machineId
        || review.request.workspace.serverId !== review.target.serverId) {
        ctx.addIssue({ code: 'custom', message: 'Native review must bind the declared Start and exact target.' });
    }
})));
export type LocalServiceStartApprovalReviewV1 = z.infer<typeof LocalServiceStartApprovalReviewV1Schema>;

/** Content-free native prerequisite; private CLI output never travels with it. */
export const LocalServiceNativePrerequisiteV1Schema = lazyZodSchema(() => z.strictObject({
  tool: z.literal('docker'),
  machineName: LocalServiceLauncherLabelV1Schema,
  cause: z.enum(['not_installed', 'not_running', 'permission_denied', 'unavailable']),
}));
export type LocalServiceNativePrerequisiteV1 = z.infer<typeof LocalServiceNativePrerequisiteV1Schema>;

/** Sanitized process evidence for the existing establishment-failure family. */
export const LocalServiceEstablishmentFailureV1Schema = lazyZodSchema(() => z.strictObject({
  cause: z.enum(['process_exited', 'port_in_use']),
  exitCode: z.optional(z.number().check(z.int())),
  signal: z.optional(z.string().check(z.minLength(1))),
  lastStderrLine: z.optional(z.string().check(z.minLength(1), z.maxLength(2_048))),
  port: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(65_535))),
  sameProject: z.optional(z.boolean()),
}).check(z.superRefine((failure, ctx) => {
  if (failure.cause === 'port_in_use' && failure.port === undefined) {
    ctx.addIssue({ code: "custom", path: ['port'], message: 'Port-in-use evidence requires a port.' });
  }
})));
export type LocalServiceEstablishmentFailureV1 = z.infer<typeof LocalServiceEstablishmentFailureV1Schema>;

export const DaemonLocalServiceLauncherStartResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    targetId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    status: z.enum(['succeeded', 'denied', 'failed']),
    reasonCode: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    prerequisite: z.optional(LocalServiceNativePrerequisiteV1Schema),
    establishmentFailure: z.optional(LocalServiceEstablishmentFailureV1Schema),
    reviewedEffect: z.optional(StrictJsonValueSchema),
    reviewedEffectDigest: z.optional(z.string().check(z.regex(/^[a-f0-9]{64}$/))),
    currentTarget: z.optional(LocalServiceManagedServiceActionTargetV1Schema),
    snapshot: LocalServiceLauncherSnapshotV1Schema,
  }).check(z.superRefine((response, ctx) => {
    if (response.snapshot.machineId !== response.machineId) {
      ctx.addIssue({
        code: "custom",
        path: ['snapshot', 'machineId'],
        message: 'Launcher start response snapshot machineId must match the response machineId.',
      });
    }
    if (response.currentTarget && response.currentTarget.machineId !== response.machineId) {
      ctx.addIssue({ code: "custom", path: ['currentTarget', 'machineId'],
        message: 'Current managed target must belong to the response Machine.' });
    }
    if (response.status !== 'succeeded' && !response.reasonCode) {
      ctx.addIssue({
        code: "custom",
        path: ['reasonCode'],
        message: 'Denied or failed launcher start responses must include a reasonCode.',
      });
    }
    if (response.status === 'succeeded' && response.reasonCode) {
      ctx.addIssue({
        code: "custom",
        path: ['reasonCode'],
        message: 'Succeeded launcher start responses must not include a reasonCode.',
      });
    }
  })));
export type DaemonLocalServiceLauncherStartResponseV1 = z.infer<
  typeof DaemonLocalServiceLauncherStartResponseV1Schema
>;

// ---------------------------------------------------------------------------
// Launcher leaf actions (LSV-1). `openPreview` resolves a target's browser view for a safe
// "open in browser" (Docker-style), `registerPreview` persists a loopback launcher target as
// a private preview, and `history.clear` dismisses the launcher feed history. Each takes the
// shared leaf request; responses are lean and carry the post-action snapshot where relevant.
// ---------------------------------------------------------------------------

export const DaemonLocalServiceLauncherLeafRequestV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(DaemonLocalServiceLauncherSnapshotRequestV1Schema, { projection: true }), {
    targetId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
  })));
export type DaemonLocalServiceLauncherLeafRequestV1 = z.infer<
  typeof DaemonLocalServiceLauncherLeafRequestV1Schema
>;

export const DaemonLocalServiceLauncherOpenPreviewResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    status: z.enum(['opened', 'unavailable']),
    targetId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    browserTarget: z.optional(BrowserViewTargetV1Schema),
    reasonCode: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
  }));
export type DaemonLocalServiceLauncherOpenPreviewResponseV1 = z.infer<
  typeof DaemonLocalServiceLauncherOpenPreviewResponseV1Schema
>;

export const DaemonLocalServiceLauncherRegisterPreviewResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    status: z.enum(['registered', 'existing', 'unavailable']),
    targetId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    previewId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    browserTarget: z.optional(BrowserViewTargetV1Schema),
    reasonCode: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
  }));
export type DaemonLocalServiceLauncherRegisterPreviewResponseV1 = z.infer<
  typeof DaemonLocalServiceLauncherRegisterPreviewResponseV1Schema
>;

export const DaemonLocalServiceLauncherHistoryClearResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    cleared: z.number().check(z.int(), z.nonnegative()),
    snapshot: LocalServiceLauncherSnapshotV1Schema,
  }));
export type DaemonLocalServiceLauncherHistoryClearResponseV1 = z.infer<
  typeof DaemonLocalServiceLauncherHistoryClearResponseV1Schema
>;

/** Same executable snapshot parser for feature protocols admitting live targets. */
export const LocalServiceLauncherSnapshotV1ProtocolSchema = projectZodProtocolSchema(LocalServiceLauncherSnapshotV1Schema);
