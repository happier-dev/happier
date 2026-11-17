import type {
  ExecutionRunClass,
  ExecutionRunIntent,
  ExecutionRunIoMode,
  ExecutionRunRetentionPolicy,
} from '@happier-dev/protocol';
import type { PermissionIntent } from '@happier-dev/agents';

import { resolveExecutionRunIntentProfile } from '../profiles/intentRegistry';
import { permissionMode as normalizePermissionMode } from './permissionMode';

export type ExecutionRunPermissionInteractionMode =
  | 'deterministic'
  | 'prompt_in_execution_scope'
  | 'interaction_unavailable'
  | 'fail_closed';

export type ExecutionRunPermissionBackendCapabilities = Readonly<{
  canRespondToPermission: boolean;
  canSurfaceParentSessionPrompt: boolean;
  runtimeKind?: string | null;
  backendId?: string | null;
}>;

export type ExecutionRunPermissionInteractionContext = Readonly<{
  intent: ExecutionRunIntent;
  runClass: ExecutionRunClass;
  ioMode: ExecutionRunIoMode;
  retentionPolicy: ExecutionRunRetentionPolicy;
  permissionMode: string;
  /** Questions collect an answer without granting tool authority. */
  requestKind?: 'question' | 'permission';
  parentSessionId?: string | null;
  interactionTargetAvailable?: boolean;
  backendCapabilities?: ExecutionRunPermissionBackendCapabilities | null;
}>;

export type ExecutionRunPermissionResponseTarget = Readonly<{
  kind: 'execution_run_host_bridge';
  sessionId: string | null;
  runId: string;
  callId: string;
  sidechainId: string;
  backendId: string;
  runtimeKind: string;
  providerRequestId: string;
  controllerOccurrenceId?: string;
}>;

/** @deprecated Compatibility name for existing Session-scoped consumers. */
export type ExecutionRunParentSessionPermissionResponseTarget = ExecutionRunPermissionResponseTarget;

export type ExecutionRunPermissionRequestEnvelope = Readonly<{
  sessionId: string | null;
  runId: string;
  callId: string;
  sidechainId: string;
  backendId: string;
  runtimeKind: string;
  permissionMode: PermissionIntent;
  providerRequestId: string;
  controllerOccurrenceId: string;
  providerMetadata: Readonly<Record<string, unknown>> | null;
  providerPayload: unknown;
  toolName: string;
  reason: string;
  createdAtMs: number;
  responseTarget: ExecutionRunPermissionResponseTarget;
}>;

/** @deprecated Compatibility name for existing Session-scoped consumers. */
export type ExecutionRunParentSessionPermissionRequestEnvelope = ExecutionRunPermissionRequestEnvelope;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isPromptCapableIntent(intent: ExecutionRunIntent): boolean {
  return intent === 'agent' || intent === 'delegate' || intent === 'voice_agent';
}

function readCapabilityFlag(
  capabilities: ExecutionRunPermissionBackendCapabilities | null | undefined,
  key: 'canRespondToPermission' | 'canSurfaceParentSessionPrompt',
): boolean {
  return capabilities?.[key] === true;
}

export function resolveExecutionRunPermissionInteractionMode(
  context: ExecutionRunPermissionInteractionContext,
): ExecutionRunPermissionInteractionMode {
  const profile = resolveExecutionRunIntentProfile(context.intent);
  const canonicalPermissionMode = normalizePermissionMode(context.permissionMode);
  const reviewQuestion = profile.intent === 'review' && context.requestKind === 'question';

  if (!reviewQuestion && (canonicalPermissionMode === 'read-only' || canonicalPermissionMode === 'plan')) {
    return 'deterministic';
  }

  if (!reviewQuestion && canonicalPermissionMode === 'safe-yolo') {
    return 'deterministic';
  }

  if (!reviewQuestion && !isPromptCapableIntent(profile.intent)) {
    return 'deterministic';
  }

  if (context.interactionTargetAvailable !== true && (reviewQuestion || !context.parentSessionId)) {
    return 'interaction_unavailable';
  }

  if (
    !readCapabilityFlag(context.backendCapabilities, 'canRespondToPermission') ||
    !readCapabilityFlag(context.backendCapabilities, 'canSurfaceParentSessionPrompt')
  ) {
    return 'fail_closed';
  }

  return 'prompt_in_execution_scope';
}

export function buildExecutionRunPermissionRequestEnvelope(
  params: Readonly<{
    sessionId: string | null;
    runId: string;
    callId: string;
    sidechainId: string;
    backendId: string;
    runtimeKind: string;
    permissionMode: string;
    providerRequestId: string;
    controllerOccurrenceId: string;
    providerMetadata?: Readonly<Record<string, unknown>> | null;
    providerPayload: unknown;
    toolName: string;
    reason: string;
    createdAtMs?: number;
  }>,
): ExecutionRunPermissionRequestEnvelope {
  const permissionMode = normalizePermissionMode(params.permissionMode);
  const createdAtMs = typeof params.createdAtMs === 'number' && Number.isFinite(params.createdAtMs) && params.createdAtMs >= 0
    ? Math.floor(params.createdAtMs)
    : Date.now();

  return {
    sessionId: params.sessionId,
    runId: params.runId,
    callId: params.callId,
    sidechainId: params.sidechainId,
    backendId: params.backendId,
    runtimeKind: params.runtimeKind,
    permissionMode,
    providerRequestId: params.providerRequestId,
    controllerOccurrenceId: params.controllerOccurrenceId,
    providerMetadata: params.providerMetadata ?? null,
    providerPayload: params.providerPayload,
    toolName: params.toolName,
    reason: params.reason,
    createdAtMs,
    responseTarget: {
      kind: 'execution_run_host_bridge',
      sessionId: params.sessionId,
      runId: params.runId,
      callId: params.callId,
      sidechainId: params.sidechainId,
      backendId: params.backendId,
      runtimeKind: params.runtimeKind,
      providerRequestId: params.providerRequestId,
      controllerOccurrenceId: params.controllerOccurrenceId,
    },
  };
}

/** @deprecated Compatibility name for existing Session-scoped consumers. */
export const buildExecutionRunParentSessionPermissionRequestEnvelope = buildExecutionRunPermissionRequestEnvelope;

export function readExecutionRunPermissionResponseTarget(
  value: unknown,
): ExecutionRunPermissionResponseTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (record.kind !== 'execution_run_host_bridge') {
    return null;
  }

  const sessionId = record.sessionId === null ? null : readNonEmptyString(record.sessionId);
  const runId = readNonEmptyString(record.runId);
  const callId = readNonEmptyString(record.callId);
  const sidechainId = readNonEmptyString(record.sidechainId);
  const backendId = readNonEmptyString(record.backendId);
  const runtimeKind = readNonEmptyString(record.runtimeKind);
  const providerRequestId = readNonEmptyString(record.providerRequestId);
  const controllerOccurrenceId = readNonEmptyString(record.controllerOccurrenceId);

  if (
    record.sessionId !== null && !sessionId
    || !runId
    || !callId
    || !sidechainId
    || !backendId
    || !runtimeKind
    || !providerRequestId
  ) {
    return null;
  }

  return {
    kind: 'execution_run_host_bridge',
    sessionId,
    runId,
    callId,
    sidechainId,
    backendId,
    runtimeKind,
    providerRequestId,
    ...(controllerOccurrenceId ? { controllerOccurrenceId } : {}),
  };
}

/** @deprecated Compatibility name for existing Session-scoped consumers. */
export const readExecutionRunParentSessionPermissionResponseTarget = readExecutionRunPermissionResponseTarget;
