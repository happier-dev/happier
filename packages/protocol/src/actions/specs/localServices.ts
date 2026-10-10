import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import type { RuntimeActionIdV1 } from '../actionIds.js';
import {
  LocalServiceActionRequestV1Schema,
  LocalServiceActionResultV1Schema,
  type LocalServiceActionKindV1,
  type LocalServiceActionRequestV1,
} from '../../local/services/actions/v1.js';
import { DaemonLocalServiceInventorySnapshotRequestV1Schema, DaemonLocalServiceInventorySnapshotResponseV1Schema,
  LocalServiceInventorySnapshotV1Schema } from '../../local/services/inventory/v1.js';
import {
  DaemonLocalServiceLauncherHistoryClearResponseV1Schema,
  DaemonLocalServiceLauncherLeafRequestV1Schema,
  DaemonLocalServiceLauncherOpenPreviewResponseV1Schema,
  DaemonLocalServiceLauncherRegisterPreviewResponseV1Schema,
  DaemonLocalServiceLauncherStartRequestV1Schema,
  DaemonLocalServiceLauncherStartResponseV1Schema,
  DaemonLocalServiceLauncherSnapshotRequestV1Schema,
  DaemonLocalServiceLauncherSnapshotResponseV1Schema,
  LocalServiceLauncherSnapshotV1Schema,
} from '../../local/services/launcher/v1.js';
import {
  DaemonLocalServicePreviewOpenOrCreateResponseV1Schema,
  DaemonLocalServicePreviewOpenOrCreateRequestV1Schema,
  DaemonLocalServicePreviewRevokeRequestV1Schema,
  DaemonLocalServicePreviewRevokeResponseV1Schema,
  DaemonLocalServicePreviewSnapshotRequestV1Schema,
  DaemonLocalServicePreviewSnapshotResponseV1Schema,
  LocalServicePreviewSnapshotV1Schema,
  LocalServicePreviewServiceTargetV1Schema,
} from '../../local/services/preview/v1.js';
import {
  DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema,
  DaemonLocalServicePublicPreviewCreateResponseV1Schema,
  DaemonLocalServicePublicPreviewCreateRequestV1Schema,
  DaemonLocalServicePublicPreviewRevokeRequestV1Schema,
  DaemonLocalServicePublicPreviewRevokeResponseV1Schema,
  DaemonLocalServicePublicPreviewStatusRequestV1Schema,
  DaemonLocalServicePublicPreviewStatusResponseV1Schema,
  LocalServicePublicPreviewSnapshotV1Schema,
} from '../../local/services/public/v1.js';
import type { RuntimeActionSpecFamily } from './common.js';
import { ProjectServiceRelocateInputV1Schema, ProjectServiceRelocateResultV1Schema } from '../../workspaces/projectServiceRelocationV1.js';
import { RPC_METHODS } from '../../rpc/methods.js';
import { actionCliDerivedDefault, type ActionCliProjection } from '../actionCliProjection.js';

const RuntimeLocalServiceMachineInputSchema = lazyZodSchema(() => z
  .object({
    machineId: z.string().trim().min(1).max(256).optional(),
    sessionId: z.string().trim().min(1).max(256).optional(),
    workspaceId: z.string().trim().min(1).max(256).optional(),
  })
  .passthrough());

const RuntimeLocalServiceLauncherActionInputSchema = lazyZodSchema(() => RuntimeLocalServiceMachineInputSchema.extend({
  targetId: z.string().trim().min(1).max(256).optional(),
  scope: DaemonLocalServiceLauncherLeafRequestV1Schema.shape.scope,
  workspaceRoot: DaemonLocalServiceLauncherLeafRequestV1Schema.shape.workspaceRoot,
}).passthrough());

const RuntimeLocalServicePreviewActionInputSchema = lazyZodSchema(() => RuntimeLocalServiceMachineInputSchema.extend({
  previewId: z.string().trim().min(1).max(256).optional(),
  targetId: z.string().trim().min(1).max(256).optional(),
}).passthrough());

const RuntimeLocalServicePublicPreviewActionInputSchema = lazyZodSchema(() => RuntimeLocalServicePreviewActionInputSchema.extend({
  exposureId: z.string().trim().min(1).max(256).optional(),
  mode: z.enum(['authenticated', 'secret_link', 'public']).optional(),
  ttlMs: z.number().int().positive().optional(),
}).passthrough());

type LocalServicesRuntimeActionId = Extract<RuntimeActionIdV1, `localServices.${string}` | 'projects.service.relocate'>;

const LOCAL_SERVICE_ACTION_KINDS_BY_RUNTIME_ACTION = Object.freeze({
  'localServices.actions.copyUrl': 'copy_url',
  'localServices.actions.openPreview': 'open_preview',
  'localServices.actions.forget': 'forget',
  'localServices.actions.stopManaged': 'stop_managed',
  'localServices.actions.restartManaged': 'restart_managed',
  'localServices.actions.terminateDetected': 'terminate_detected',
} as const satisfies Readonly<Partial<Record<RuntimeActionIdV1, LocalServiceActionKindV1>>>);

type LocalServiceActionRuntimeActionId = keyof typeof LOCAL_SERVICE_ACTION_KINDS_BY_RUNTIME_ACTION;

/** Distinct methods let the ordinary Action RPC owner enforce each control's current policy. */
export const LOCAL_SERVICE_CONTROL_ACTION_RPC_METHODS = Object.freeze({
  'localServices.actions.copyUrl': RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_COPY_URL,
  'localServices.actions.openPreview': RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_OPEN_PREVIEW,
  'localServices.actions.forget': RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_FORGET,
  'localServices.actions.stopManaged': RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_STOP_MANAGED,
  'localServices.actions.restartManaged': RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_RESTART_MANAGED,
  'localServices.actions.terminateDetected': RPC_METHODS.DAEMON_LOCAL_SERVICES_ACTIONS_TERMINATE_DETECTED,
} satisfies Readonly<Record<LocalServiceActionRuntimeActionId, string>>);

/** Existing raw daemon leaves, distinct from the targeted Start/control Action RPCs. */
export const LOCAL_SERVICE_DOMAIN_ACTION_RPC_BINDINGS = Object.freeze({
  'localServices.inventory.list': { rpcMethod: RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT,
    requestSchema: DaemonLocalServiceInventorySnapshotRequestV1Schema, snapshotResponseSchema: DaemonLocalServiceInventorySnapshotResponseV1Schema },
  'localServices.inventory.refresh': { rpcMethod: RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH,
    requestSchema: DaemonLocalServiceInventorySnapshotRequestV1Schema, snapshotResponseSchema: DaemonLocalServiceInventorySnapshotResponseV1Schema },
  'localServices.launcher.snapshot': { rpcMethod: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
    requestSchema: DaemonLocalServiceLauncherSnapshotRequestV1Schema, snapshotResponseSchema: DaemonLocalServiceLauncherSnapshotResponseV1Schema },
  'localServices.launcher.registerPreview': { rpcMethod: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_REGISTER_PREVIEW,
    requestSchema: DaemonLocalServiceLauncherLeafRequestV1Schema },
  'localServices.launcher.history.clear': { rpcMethod: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_HISTORY_CLEAR,
    requestSchema: DaemonLocalServiceLauncherLeafRequestV1Schema },
  'localServices.preview.openOrCreate': { rpcMethod: RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_OPEN_OR_CREATE,
    requestSchema: DaemonLocalServicePreviewOpenOrCreateRequestV1Schema },
  'localServices.preview.status': { rpcMethod: RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_SNAPSHOT,
    requestSchema: DaemonLocalServicePreviewSnapshotRequestV1Schema, snapshotResponseSchema: DaemonLocalServicePreviewSnapshotResponseV1Schema },
  'localServices.preview.revoke': { rpcMethod: RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_REVOKE,
    requestSchema: DaemonLocalServicePreviewRevokeRequestV1Schema },
  'localServices.publicPreview.create': { rpcMethod: RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_CREATE,
    requestSchema: DaemonLocalServicePublicPreviewCreateRequestV1Schema },
  'localServices.publicPreview.status': { rpcMethod: RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_STATUS,
    requestSchema: DaemonLocalServicePublicPreviewStatusRequestV1Schema, snapshotResponseSchema: DaemonLocalServicePublicPreviewStatusResponseV1Schema },
  'localServices.publicPreview.revoke': { rpcMethod: RPC_METHODS.DAEMON_LOCAL_SERVICES_PUBLIC_PREVIEW_REVOKE,
    requestSchema: DaemonLocalServicePublicPreviewRevokeRequestV1Schema },
});

type LocalServiceDomainActionId = keyof typeof LOCAL_SERVICE_DOMAIN_ACTION_RPC_BINDINGS;

export function resolveLocalServiceDomainActionRpcBinding(actionId: RuntimeActionIdV1) {
  return Object.hasOwn(LOCAL_SERVICE_DOMAIN_ACTION_RPC_BINDINGS, actionId)
    ? LOCAL_SERVICE_DOMAIN_ACTION_RPC_BINDINGS[actionId as LocalServiceDomainActionId] : null;
}

/** Action context is not raw daemon authority. Preserve complete canonical selectors and paths. */
export function parseLocalServiceDomainActionRpcRequest(actionId: RuntimeActionIdV1, input: unknown) {
  const binding = resolveLocalServiceDomainActionRpcBinding(actionId);
  if (!binding || !input || typeof input !== 'object' || Array.isArray(input)) return null;
  const request: Record<string, unknown> = { ...input };
  delete request.workspaceId;
  if (!Object.hasOwn(binding.requestSchema.shape, 'sessionId')) delete request.sessionId;
  if (actionId === 'localServices.preview.openOrCreate') {
    // Retained runtime spelling: targetId meant detected inventory, never a URL.
    if (!request.serviceTarget && !request.inventoryEntryId && request.targetId !== undefined) request.inventoryEntryId = request.targetId;
    delete request.targetId;
    delete request.previewId;
  }
  if (actionId === 'localServices.preview.status') {
    delete request.previewId;
    delete request.targetId;
  }
  return binding.requestSchema.safeParse(request);
}

const LOCAL_SERVICE_CLI_PATHS = {
  'localServices.inventory.list': ['services', 'inventory', 'list'],
  'localServices.inventory.refresh': ['services', 'inventory', 'refresh'],
  'localServices.launcher.snapshot': ['services', 'launcher', 'snapshot'],
  'localServices.launcher.start': ['services', 'start'],
  'localServices.launcher.registerPreview': ['services', 'launcher', 'register-preview'],
  'localServices.launcher.history.clear': ['services', 'launcher', 'history', 'clear'],
  'localServices.preview.openOrCreate': ['services', 'preview', 'create'],
  'localServices.preview.status': ['services', 'preview', 'status'],
  'localServices.preview.revoke': ['services', 'preview', 'revoke'],
  'localServices.publicPreview.create': ['services', 'public-preview', 'create'],
  'localServices.publicPreview.status': ['services', 'public-preview', 'status'],
  'localServices.publicPreview.revoke': ['services', 'public-preview', 'revoke'],
  'localServices.actions.forget': ['services', 'forget'],
  'localServices.actions.stopManaged': ['services', 'stop'],
  'localServices.actions.restartManaged': ['services', 'restart'],
  'localServices.actions.terminateDetected': ['services', 'terminate'],
} as const satisfies Readonly<Partial<Record<RuntimeActionIdV1, readonly [string, ...string[]]>>>;

export function createLocalServiceActionCliProjection(actionId: RuntimeActionIdV1): ActionCliProjection | null {
  if (!Object.hasOwn(LOCAL_SERVICE_CLI_PATHS, actionId)) return null;
  const path = LOCAL_SERVICE_CLI_PATHS[actionId as keyof typeof LOCAL_SERVICE_CLI_PATHS];
  const base = { acceptsServerId: true as const, commands: [{ path: [...path], visibility: 'canonical' as const }] };
  const kind = resolveLocalServiceActionKindForRuntimeActionId(actionId);
  if (kind) return { ...base,
    inputSchema: lazyZodSchema(() => z.object({ ...LocalServiceActionRequestV1Schema.shape,
      action: z.literal(kind).optional(), requestId: LocalServiceActionRequestV1Schema.shape.requestId.optional() }).strict()),
    bindInput: (value, context) => ({ ...(value as Readonly<Record<string, unknown>>),
      action: actionCliDerivedDefault(kind),
      ...((value as Readonly<Record<string, unknown>>).requestId === undefined ? { requestId: actionCliDerivedDefault(context.invocationId) } : {}) }),
  };
  const domain = resolveLocalServiceDomainActionRpcBinding(actionId);
  const inputSchema = domain?.requestSchema ?? DaemonLocalServiceLauncherStartRequestV1Schema;
  return { ...base, inputSchema, wholeInputSchema: inputSchema };
}

export function resolveLocalServiceActionKindForRuntimeActionId(
  actionId: RuntimeActionIdV1,
): LocalServiceActionKindV1 | null {
  return LOCAL_SERVICE_ACTION_KINDS_BY_RUNTIME_ACTION[
    actionId as LocalServiceActionRuntimeActionId
  ] ?? null;
}

function localServiceActionRequestSchema(
  actionId: LocalServiceActionRuntimeActionId,
) {
  const expectedAction = LOCAL_SERVICE_ACTION_KINDS_BY_RUNTIME_ACTION[actionId];
  return LocalServiceActionRequestV1Schema.refine(
    (request) => request.action === expectedAction,
    {
      message: `Local service action must be ${expectedAction}.`,
      path: ['action'],
    },
  );
}

export const LOCAL_SERVICES_RUNTIME_ACTION_TITLES: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  'projects.service.relocate': 'Move service',
  'localServices.inventory.list': 'List local services',
  'localServices.inventory.refresh': 'Refresh local services',
  'localServices.launcher.snapshot': 'Get local service launcher snapshot',
  'localServices.launcher.start': 'Start local service launcher target',
  'localServices.launcher.openPreview': 'Open local service launcher preview',
  'localServices.launcher.registerPreview': 'Register local service launcher preview',
  'localServices.launcher.history.clear': 'Clear local service launcher history',
  'localServices.preview.openOrCreate': 'Open or create local service preview',
  'localServices.preview.status': 'Get local service preview status',
  'localServices.preview.revoke': 'Revoke local service preview',
  'localServices.publicPreview.create': 'Create public local service preview',
  'localServices.publicPreview.status': 'Get public local service preview status',
  'localServices.publicPreview.revoke': 'Revoke public local service preview',
  'localServices.publicPreview.copyUrl': 'Copy public local service preview URL',
  'localServices.actions.copyUrl': 'Copy local service URL',
  'localServices.actions.openPreview': 'Open local service preview',
  'localServices.actions.forget': 'Forget local service',
  'localServices.actions.stopManaged': 'Stop managed local service',
  'localServices.actions.restartManaged': 'Restart managed local service',
  'localServices.actions.terminateDetected': 'Terminate detected local service',
});

export const LOCAL_SERVICES_RUNTIME_ACTION_DESCRIPTIONS: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  'projects.service.relocate': 'Stop the exact current service, prepare current files, then start on the reviewed destination. A failed start leaves the service stopped; sharing must be reviewed again.',
  'localServices.inventory.list': 'List the local services detected on a machine.',
  'localServices.inventory.refresh': 'Refresh the detected local services inventory.',
  'localServices.launcher.snapshot': 'Read the current local service launcher state.',
  'localServices.launcher.start': 'Start a managed local service from a launch target.',
  'localServices.launcher.openPreview': 'Open a browser preview for a local service launch target.',
  'localServices.launcher.registerPreview': 'Register a browser preview for a local service launch target.',
  'localServices.launcher.history.clear': 'Clear the local service launcher history.',
  'localServices.preview.openOrCreate': 'Open an existing or create a new private local service preview.',
  'localServices.preview.status': 'Read the status of a local service preview.',
  'localServices.preview.revoke': 'Revoke a local service preview.',
  'localServices.publicPreview.create': 'Create a public exposure for a local service preview (requires confirmation).',
  'localServices.publicPreview.status': 'Read the status of a local service public exposure.',
  'localServices.publicPreview.revoke': 'Revoke a local service public exposure.',
  'localServices.publicPreview.copyUrl': 'Copy the public URL of a local service exposure.',
  'localServices.actions.copyUrl': 'Copy the URL of a local service.',
  'localServices.actions.openPreview': 'Open a browser preview for a local service.',
  'localServices.actions.forget': 'Forget a detected local service.',
  'localServices.actions.stopManaged': 'Stop a Happier-managed local service.',
  'localServices.actions.restartManaged': 'Restart a Happier-managed local service.',
  'localServices.actions.terminateDetected': 'Terminate a detected (non-managed) local service.',
});

/**
 * Canonical per-id schema projection for every backed local-services Action.
 * The daemon routes already own the differing leaf result contracts; this map
 * retains those contracts instead of widening them with `z.unknown()` when
 * the Action becomes publicly discoverable.
 */
export const LOCAL_SERVICES_RUNTIME_ACTION_INPUT_SCHEMAS = Object.freeze({
  'projects.service.relocate': ProjectServiceRelocateInputV1Schema,
  'localServices.inventory.list': RuntimeLocalServiceMachineInputSchema,
  'localServices.inventory.refresh': RuntimeLocalServiceMachineInputSchema,
  'localServices.launcher.snapshot': RuntimeLocalServiceMachineInputSchema,
  'localServices.launcher.start': DaemonLocalServiceLauncherStartRequestV1Schema,
  'localServices.launcher.openPreview': RuntimeLocalServiceLauncherActionInputSchema,
  'localServices.launcher.registerPreview': RuntimeLocalServiceLauncherActionInputSchema,
  'localServices.launcher.history.clear': RuntimeLocalServiceLauncherActionInputSchema,
  'localServices.preview.openOrCreate': RuntimeLocalServicePreviewActionInputSchema,
  'localServices.preview.status': RuntimeLocalServicePreviewActionInputSchema,
  'localServices.preview.revoke': RuntimeLocalServicePreviewActionInputSchema,
  'localServices.publicPreview.create': RuntimeLocalServicePublicPreviewActionInputSchema,
  'localServices.publicPreview.status': RuntimeLocalServicePublicPreviewActionInputSchema,
  'localServices.publicPreview.revoke': RuntimeLocalServicePublicPreviewActionInputSchema,
  'localServices.publicPreview.copyUrl': RuntimeLocalServicePublicPreviewActionInputSchema,
  'localServices.actions.copyUrl': localServiceActionRequestSchema('localServices.actions.copyUrl'),
  'localServices.actions.openPreview': localServiceActionRequestSchema('localServices.actions.openPreview'),
  'localServices.actions.forget': localServiceActionRequestSchema('localServices.actions.forget'),
  'localServices.actions.stopManaged': localServiceActionRequestSchema('localServices.actions.stopManaged'),
  'localServices.actions.restartManaged': localServiceActionRequestSchema('localServices.actions.restartManaged'),
  'localServices.actions.terminateDetected': localServiceActionRequestSchema('localServices.actions.terminateDetected'),
} as const satisfies Readonly<Record<LocalServicesRuntimeActionId, z.ZodTypeAny>>);

export const LOCAL_SERVICES_RUNTIME_ACTION_OUTPUT_SCHEMAS = Object.freeze({
  'projects.service.relocate': ProjectServiceRelocateResultV1Schema,
  'localServices.inventory.list': LocalServiceInventorySnapshotV1Schema,
  'localServices.inventory.refresh': LocalServiceInventorySnapshotV1Schema,
  'localServices.launcher.snapshot': LocalServiceLauncherSnapshotV1Schema,
  'localServices.launcher.start': DaemonLocalServiceLauncherStartResponseV1Schema,
  'localServices.launcher.openPreview': DaemonLocalServiceLauncherOpenPreviewResponseV1Schema,
  'localServices.launcher.registerPreview': DaemonLocalServiceLauncherRegisterPreviewResponseV1Schema,
  'localServices.launcher.history.clear': DaemonLocalServiceLauncherHistoryClearResponseV1Schema,
  'localServices.preview.openOrCreate': DaemonLocalServicePreviewOpenOrCreateResponseV1Schema,
  'localServices.preview.status': LocalServicePreviewSnapshotV1Schema,
  'localServices.preview.revoke': DaemonLocalServicePreviewRevokeResponseV1Schema,
  'localServices.publicPreview.create': DaemonLocalServicePublicPreviewCreateResponseV1Schema,
  'localServices.publicPreview.status': LocalServicePublicPreviewSnapshotV1Schema,
  'localServices.publicPreview.revoke': DaemonLocalServicePublicPreviewRevokeResponseV1Schema,
  'localServices.publicPreview.copyUrl': DaemonLocalServicePublicPreviewCopyUrlResponseV1Schema,
  'localServices.actions.copyUrl': LocalServiceActionResultV1Schema,
  'localServices.actions.openPreview': LocalServiceActionResultV1Schema,
  'localServices.actions.forget': LocalServiceActionResultV1Schema,
  'localServices.actions.stopManaged': LocalServiceActionResultV1Schema,
  'localServices.actions.restartManaged': LocalServiceActionResultV1Schema,
  'localServices.actions.terminateDetected': LocalServiceActionResultV1Schema,
} as const satisfies Readonly<Record<LocalServicesRuntimeActionId, z.ZodTypeAny>>);

export const LOCAL_SERVICES_RUNTIME_ACTION_SPEC_FAMILY = Object.freeze({
  titles: LOCAL_SERVICES_RUNTIME_ACTION_TITLES,
  descriptions: LOCAL_SERVICES_RUNTIME_ACTION_DESCRIPTIONS,
  inputSchemas: LOCAL_SERVICES_RUNTIME_ACTION_INPUT_SCHEMAS,
  outputSchemas: LOCAL_SERVICES_RUNTIME_ACTION_OUTPUT_SCHEMAS,
} satisfies RuntimeActionSpecFamily);

/** Explicit current-service provenance is not the invoking Session's scope. */
export function isSourceQualifiedLocalServicePreviewActionInput(actionId: string, input: unknown): boolean {
  if (actionId !== 'localServices.preview.openOrCreate' && actionId !== 'localServices.preview.revoke'
    && actionId !== 'localServices.publicPreview.create' && actionId !== 'localServices.publicPreview.status'
    && actionId !== 'localServices.publicPreview.revoke' && actionId !== 'localServices.publicPreview.copyUrl') return false;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  return LocalServicePreviewServiceTargetV1Schema.safeParse((input as Readonly<Record<string, unknown>>).serviceTarget).success;
}

/** One schema-owned selector for approval provenance and transport locality. */
export function readLocalServiceControlActionRequest(actionId: string, input: unknown): LocalServiceActionRequestV1 | null {
  if (!Object.hasOwn(LOCAL_SERVICE_ACTION_KINDS_BY_RUNTIME_ACTION, actionId)) return null;
  const parsed = LOCAL_SERVICES_RUNTIME_ACTION_INPUT_SCHEMAS[actionId as LocalServiceActionRuntimeActionId].safeParse(input);
  return parsed.success ? parsed.data : null;
}
