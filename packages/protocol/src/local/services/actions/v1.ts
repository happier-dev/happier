import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';
import { ProjectNativeRefV1Schema } from '../../../workspaces/projectSetup/projectManifestV1.js';
import { WorkspaceRefV1WriteSchema } from '../../../workspaces/workspaceRefV1.js';
import { ProjectExecutionChoiceV1Schema } from '../../../workspaces/projectWorkerPreferencesV1.js';
import { StrictJsonValueSchema } from '../../../json/strictJsonValue.js';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import type { WorkspaceRefV1 } from '../../../workspaces/workspaceRefV1.js';

/** Source identity retained by Local Services; this input does not confer launch/control authority. */
export const ProjectServiceDeclarationRefV1Schema = lazyZodSchema(() => z.object({
  workspaceRefId: WorkspaceRefV1WriteSchema.shape.id,
  selection: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('manifest'), name: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('native'), source: ProjectNativeRefV1Schema }).strict(),
  ]),
}).strict());
export type ProjectServiceDeclarationRefV1 = z.infer<typeof ProjectServiceDeclarationRefV1Schema>;

/** Incumbent launcher identity, qualified by the actual Home, Machine and declaration. */
export function createProjectServiceDeclarationTargetIdV1(
  workspace: Pick<WorkspaceRefV1, 'id' | 'serverId' | 'machineId'>,
  selection: ProjectServiceDeclarationRefV1['selection'],
): string {
  const declaration = { workspaceRefId: workspace.id, selection };
  return `project-service:${bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([
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

export const LocalServiceManagedServiceActionTargetV1Schema = lazyZodSchema(() => z
  .object({
    kind: z.literal('managed_service'),
    managedServiceId: z.string().trim().min(1).max(256),
    machineId: z.string().trim().min(1).max(256),
    sessionId: z.string().trim().min(1).max(256).optional(),
    workspaceId: WorkspaceRefV1WriteSchema.shape.id.optional(),
    cwd: WorkspaceRefV1WriteSchema.shape.rootPath.optional(),
    declaration: ProjectServiceDeclarationRefV1Schema.optional(),
  })
  .strict());
export type LocalServiceManagedServiceActionTargetV1 = z.infer<typeof LocalServiceManagedServiceActionTargetV1Schema>;

export const LocalServiceActionTargetV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('inventory_entry'),
      inventoryEntryId: z.string().trim().min(1).max(256),
      machineId: z.string().trim().min(1).max(256),
      sessionId: z.string().trim().min(1).max(256).optional(),
      workspaceId: z.string().trim().min(1).max(256).optional(),
    })
    .strict(),
  LocalServiceManagedServiceActionTargetV1Schema,
]));
export type LocalServiceActionTargetV1 = z.infer<typeof LocalServiceActionTargetV1Schema>;

export const LocalServiceActionDecisionV1Schema = lazyZodSchema(() => z
  .object({
    kind: LocalServiceActionKindV1Schema,
    enabled: z.boolean(),
    requiresConfirmation: z.boolean(),
    requiresSecondConfirmation: z.boolean().optional().default(false),
    reasonCode: z.string().trim().min(1).max(256).optional(),
    auditRequired: z.boolean(),
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (!decision.enabled && !decision.reasonCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reasonCode'],
        message: 'Disabled action decisions must include a reasonCode.',
      });
    }
  }));
export type LocalServiceActionDecisionV1 = z.infer<typeof LocalServiceActionDecisionV1Schema>;

export const LocalServiceActionRequestV1Schema = lazyZodSchema(() => z
  .object({
    requestId: z.string().trim().min(1).max(256),
    target: LocalServiceActionTargetV1Schema,
    action: LocalServiceActionKindV1Schema,
    // On Undo, both this key and the target id address the owner's persisted suppression.
    undoKey: z.string().trim().min(1).optional(),
    confirmationNonce: z.string().trim().min(1).max(256).optional(),
    force: z.boolean().optional().default(false),
    expectedEffectDigest: z.string().min(1).optional(),
    choice: ProjectExecutionChoiceV1Schema.optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.undoKey && (request.action !== 'forget' || request.target.kind !== 'inventory_entry'
      || request.target.inventoryEntryId !== request.undoKey)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['undoKey'], message: 'Undo must target the same detected service suppression key.' });
    }
    if (
      (request.action === 'stop_managed'
        || request.action === 'restart_managed'
        || request.action === 'terminate_detected')
      && !request.confirmationNonce
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmationNonce'],
        message: 'Managed and destructive local service actions require a confirmationNonce.',
      });
    }
    if (request.force && !request.confirmationNonce) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confirmationNonce'],
        message: 'Force actions require a confirmationNonce.',
      });
    }
  }));
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

export const LocalServiceActionAuditEventV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1),
    eventId: z.string().trim().min(1).max(256),
    requestId: z.string().trim().min(1).max(256),
    machineId: z.string().trim().min(1).max(256),
    action: LocalServiceActionKindV1Schema,
    result: z.enum(['requested', 'denied', 'confirmed', 'succeeded', 'failed']),
    reasonCode: z.string().trim().min(1).max(256).optional(),
    recordedAt: z.number().int().nonnegative(),
  })
  .strict());
export type LocalServiceActionAuditEventV1 = z.infer<typeof LocalServiceActionAuditEventV1Schema>;

export const LocalServiceActionResultV1Schema = lazyZodSchema(() => z
  .object({
    v: z.literal(1),
    requestId: z.string().trim().min(1).max(256),
    action: LocalServiceActionKindV1Schema,
    status: z.enum(['succeeded', 'denied', 'failed']),
    undoKey: z.string().trim().min(1).optional(),
    reasonCode: z.string().trim().min(1).max(256).optional(),
    auditEvents: z.array(LocalServiceActionAuditEventV1Schema),
    reviewedEffect: StrictJsonValueSchema.optional(),
    reviewedEffectDigest: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.status !== 'succeeded' && !result.reasonCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reasonCode'],
        message: 'Unsuccessful action results must include a reasonCode.',
      });
    }
  }));
export type LocalServiceActionResultV1 = z.infer<typeof LocalServiceActionResultV1Schema>;

export const DaemonLocalServiceActionExecuteRequestV1Schema = LocalServiceActionRequestV1Schema;
export type DaemonLocalServiceActionExecuteRequestV1 = z.infer<
  typeof DaemonLocalServiceActionExecuteRequestV1Schema
>;

export const DaemonLocalServiceActionExecuteResponseV1Schema = lazyZodSchema(() => z
  .object({
    protocolVersion: z.literal(1),
    result: LocalServiceActionResultV1Schema,
  })
  .strict());
export type DaemonLocalServiceActionExecuteResponseV1 = z.infer<
  typeof DaemonLocalServiceActionExecuteResponseV1Schema
>;
