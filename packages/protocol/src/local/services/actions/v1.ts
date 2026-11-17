import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';
import { ProjectNativeRefV1Schema } from '../../../workspaces/projectSetup/projectManifestV1.js';
import { WorkspaceRefV1WriteSchema } from '../../../workspaces/workspaceRefV1.js';
import { ProjectExecutionChoiceV1Schema } from '../../../workspaces/projectWorkerPreferencesV1.js';
import { BrowserHttpUrlV1Schema } from '../../../browser/url.js';
import { StrictJsonValueSchema } from '../../../json/strictJsonValue.js';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import type { WorkspaceRefV1 } from '../../../workspaces/workspaceRefV1.js';

/** Source identity retained by Local Services; this input does not confer launch/control authority. */
export const ProjectServiceDeclarationRefV1Schema = lazyZodSchema(() => z.strictObject({
  workspaceRefId: WorkspaceRefV1WriteSchema.shape.id,
  selection: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('manifest'), name: z.string().check(z.minLength(1)) }),
    z.strictObject({ kind: z.literal('native'), source: ProjectNativeRefV1Schema }),
  ]),
}));
export type ProjectServiceDeclarationRefV1 = z.infer<typeof ProjectServiceDeclarationRefV1Schema>;

/** Incumbent launcher identity, qualified by the actual Home, Machine and declaration. */
const projectServiceDeclarationTargetPrefix = 'project-service:';
export function isProjectServiceDeclarationTargetIdV1(value: string): boolean {
  return value.startsWith(projectServiceDeclarationTargetPrefix) && /^[a-f0-9]{64}$/.test(value.slice(projectServiceDeclarationTargetPrefix.length));
}

export function createProjectServiceDeclarationTargetIdV1(
  workspace: Pick<WorkspaceRefV1, 'id' | 'serverId' | 'machineId'>,
  selection: ProjectServiceDeclarationRefV1['selection'],
): string {
  const declaration = { workspaceRefId: workspace.id, selection };
  return `${projectServiceDeclarationTargetPrefix}${bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([
    workspace.serverId, workspace.machineId, declaration,
  ]))))}`;
}

export const LocalServiceActionKindV1Schema = lazyZodSchema(() => z.enum([
  'copy_url',
  'open_preview',
  'forget',
  'stop_managed',
  'restart_managed',
  'terminate_detected',
]));
export type LocalServiceActionKindV1 = z.infer<typeof LocalServiceActionKindV1Schema>;

export const LocalServiceManagedServiceActionTargetV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('managed_service'),
    managedServiceId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    sessionId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    workspaceId: z.optional(WorkspaceRefV1WriteSchema.shape.id),
    cwd: z.optional(WorkspaceRefV1WriteSchema.shape.rootPath),
    declaration: z.optional(ProjectServiceDeclarationRefV1Schema),
  }));
export type LocalServiceManagedServiceActionTargetV1 = z.infer<typeof LocalServiceManagedServiceActionTargetV1Schema>;

export const LocalServiceActionTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
      kind: z.literal('inventory_entry'),
      inventoryEntryId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
      machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
      sessionId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
      workspaceId: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    }),
  LocalServiceManagedServiceActionTargetV1Schema,
]));
export type LocalServiceActionTargetV1 = z.infer<typeof LocalServiceActionTargetV1Schema>;

export const LocalServiceActionDecisionV1Schema = lazyZodSchema(() => z.strictObject({
    kind: LocalServiceActionKindV1Schema,
    enabled: z.boolean(),
    requiresConfirmation: z.boolean(),
    requiresSecondConfirmation: z._default(z.optional(z.boolean()), false),
    reasonCode: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    auditRequired: z.boolean(),
  }).check(z.superRefine((decision, ctx) => {
    if (!decision.enabled && !decision.reasonCode) {
      ctx.addIssue({
        code: "custom",
        path: ['reasonCode'],
        message: 'Disabled action decisions must include a reasonCode.',
      });
    }
  })));
export type LocalServiceActionDecisionV1 = z.infer<typeof LocalServiceActionDecisionV1Schema>;

export const LocalServiceActionRequestV1Schema = lazyZodSchema(() => z.strictObject({
    requestId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    target: LocalServiceActionTargetV1Schema,
    action: LocalServiceActionKindV1Schema,
    // On Undo, both this key and the target id address the owner's persisted suppression.
    undoKey: z.optional(z.string().check(z.trim(), z.minLength(1))),
    confirmationNonce: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    force: z._default(z.optional(z.boolean()), false),
    expectedEffectDigest: z.optional(z.string().check(z.minLength(1))),
    choice: z.optional(ProjectExecutionChoiceV1Schema),
  }).check(z.superRefine((request, ctx) => {
    if (request.undoKey && (request.action !== 'forget' || request.target.kind !== 'inventory_entry'
      || request.target.inventoryEntryId !== request.undoKey)) {
      ctx.addIssue({ code: "custom", path: ['undoKey'], message: 'Undo must target the same detected service suppression key.' });
    }
  })));
export type LocalServiceActionRequestV1 = z.infer<typeof LocalServiceActionRequestV1Schema>;

const LOCAL_SERVICE_ACTION_CONFIRMATION_NONCE_PREFIX_V1 = 'lsact1_';

function normalizeConfirmationScopePart(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function canonicalLocalServiceActionConfirmationPayloadV1(
  request: LocalServiceActionRequestV1,
): string {
  const target = request.target.kind === 'inventory_entry'
    ? [
      request.target.kind,
      request.target.inventoryEntryId,
      request.target.machineId,
      normalizeConfirmationScopePart(request.target.sessionId),
      normalizeConfirmationScopePart(request.target.workspaceId),
    ]
    : [
      request.target.kind,
      request.target.managedServiceId,
      request.target.machineId,
      normalizeConfirmationScopePart(request.target.sessionId),
      request.target.workspaceId ?? '',
      ...(request.target.cwd ? ['cwd', request.target.cwd] : []),
      ...(request.target.declaration ? [
        'declaration',
        request.target.declaration.workspaceRefId,
        ...canonicalDeclarationSelection(request.target.declaration.selection),
      ] : []),
    ];
  return JSON.stringify([
    1,
    request.requestId,
    request.action,
    request.force === true,
    ...target,
    ...(request.expectedEffectDigest ? ['effect', request.expectedEffectDigest] : []),
    ...(request.choice ? ['choice', request.choice] : []),
  ]);
}

function canonicalDeclarationSelection(selection: ProjectServiceDeclarationRefV1['selection']): readonly string[] {
  if (selection.kind === 'manifest') return ['manifest', selection.name];
  const source = selection.source;
  return source.kind === 'native'
    ? ['native', source.kind, source.tool, source.file, source.target]
    : ['native', source.kind, source.adapter.pluginId, source.adapter.localId, source.file, source.target];
}

function stableConfirmationHashV1(payload: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
}

export function createLocalServiceActionConfirmationNonceV1(
  request: LocalServiceActionRequestV1,
): string {
  /*
   * Deterministic request-binding token for UI confirmation flows.
   * This is not secret authorization: any caller with the request can recompute it,
   * so daemon callers must still rely on authenticated routes and target ownership checks.
   */
  return `${LOCAL_SERVICE_ACTION_CONFIRMATION_NONCE_PREFIX_V1}${
    stableConfirmationHashV1(canonicalLocalServiceActionConfirmationPayloadV1(request))
  }`;
}

export function isLocalServiceActionConfirmationNonceV1(
  request: LocalServiceActionRequestV1,
): boolean {
  return request.confirmationNonce === createLocalServiceActionConfirmationNonceV1(request);
}

export const LocalServiceActionAuditEventV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    eventId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    requestId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    action: LocalServiceActionKindV1Schema,
    result: z.enum(['requested', 'denied', 'confirmed', 'succeeded', 'failed']),
    reasonCode: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    recordedAt: z.number().check(z.int(), z.nonnegative()),
  }));
export type LocalServiceActionAuditEventV1 = z.infer<typeof LocalServiceActionAuditEventV1Schema>;

export const LocalServiceActionResultV1Schema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1),
    requestId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
    action: LocalServiceActionKindV1Schema,
    status: z.enum(['succeeded', 'denied', 'failed']),
    undoKey: z.optional(z.string().check(z.trim(), z.minLength(1))),
    reasonCode: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))),
    auditEvents: z.array(LocalServiceActionAuditEventV1Schema),
    reviewedEffect: z.optional(StrictJsonValueSchema),
    reviewedEffectDigest: z.optional(z.string().check(z.minLength(1))),
  }).check(z.superRefine((result, ctx) => {
    if (result.status !== 'succeeded' && !result.reasonCode) {
      ctx.addIssue({
        code: "custom",
        path: ['reasonCode'],
        message: 'Unsuccessful action results must include a reasonCode.',
      });
    }
  })));
export type LocalServiceActionResultV1 = z.infer<typeof LocalServiceActionResultV1Schema>;

/** CLI Copy writes the destination to stdout; raw daemon receipts only establish eligibility. */
export const LocalServiceCopyUrlResultV1Schema = lazyZodSchema(() => z.extend(LocalServiceActionResultV1Schema, {
  destinationUrl: z.optional(BrowserHttpUrlV1Schema),
}));
export type LocalServiceCopyUrlResultV1 = z.infer<typeof LocalServiceCopyUrlResultV1Schema>;

// Preview Open uses its Machine Action RPC and the canonical preview lifecycle DTO.
// This retained aggregate accepts only controls with the audited result envelope below.
export const DaemonLocalServiceActionExecuteRequestV1Schema = lazyZodSchema(() => LocalServiceActionRequestV1Schema.check(z.refine(
  request => request.action !== 'open_preview',
  { path: ['action'], message: 'Preview Open requires its dedicated Machine Action RPC.' },
)));
export type DaemonLocalServiceActionExecuteRequestV1 = z.infer<
  typeof DaemonLocalServiceActionExecuteRequestV1Schema
>;

export const DaemonLocalServiceActionExecuteResponseV1Schema = lazyZodSchema(() => z.strictObject({
    protocolVersion: z.literal(1),
    result: LocalServiceActionResultV1Schema,
  }));
export type DaemonLocalServiceActionExecuteResponseV1 = z.infer<
  typeof DaemonLocalServiceActionExecuteResponseV1Schema
>;
