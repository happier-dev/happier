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
  | 'prompt_in_parent_session'
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
  parentSessionId?: string | null;
  backendCapabilities?: ExecutionRunPermissionBackendCapabilities | null;
}>;

export type ExecutionRunParentSessionPermissionResponseTarget = Readonly<{
  kind: 'execution_run_host_bridge';
  sessionId: string;
  runId: string;
  callId: string;
  sidechainId: string;
  backendId: string;
  runtimeKind: string;
  providerRequestId: string;
}>;

export type ExecutionRunParentSessionPermissionRequestEnvelope = Readonly<{
  sessionId: string;
  runId: string;
  callId: string;
  sidechainId: string;
  backendId: string;
  runtimeKind: string;
  permissionMode: PermissionIntent;
  providerRequestId: string;
  providerMetadata: Readonly<Record<string, unknown>> | null;
  providerPayload: unknown;
  toolName: string;
  reason: string;
  createdAtMs: number;
  responseTarget: ExecutionRunParentSessionPermissionResponseTarget;
}>;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isPromptCapableIntent(intent: ExecutionRunIntent): boolean {
  return intent === 'delegate' || intent === 'voice_agent';
}

function isSessionShapedRun(params: Readonly<{
  runClass: ExecutionRunClass;
  ioMode: ExecutionRunIoMode;
  retentionPolicy: ExecutionRunRetentionPolicy;
}>): boolean {
  return params.runClass === 'long_lived' || params.ioMode === 'streaming' || params.retentionPolicy === 'resumable';
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

  if (canonicalPermissionMode === 'read-only' || canonicalPermissionMode === 'plan') {
    return 'deterministic';
  }

  if (!isPromptCapableIntent(profile.intent)) {
    return 'deterministic';
  }

  if (!isSessionShapedRun(context)) {
    return 'deterministic';
  }

  if (!context.parentSessionId) {
    return 'deterministic';
  }

  if (
    !readCapabilityFlag(context.backendCapabilities, 'canRespondToPermission') ||
    !readCapabilityFlag(context.backendCapabilities, 'canSurfaceParentSessionPrompt')
  ) {
    return 'fail_closed';
  }

  return 'prompt_in_parent_session';
}

export function buildExecutionRunParentSessionPermissionRequestEnvelope(
  params: Readonly<{
    sessionId: string;
    runId: string;
    callId: string;
    sidechainId: string;
    backendId: string;
    runtimeKind: string;
    permissionMode: string;
    providerRequestId: string;
    providerMetadata?: Readonly<Record<string, unknown>> | null;
    providerPayload: unknown;
    toolName: string;
    reason: string;
    createdAtMs?: number;
  }>,
): ExecutionRunParentSessionPermissionRequestEnvelope {
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
    },
  };
}

export function readExecutionRunParentSessionPermissionResponseTarget(
  value: unknown,
): ExecutionRunParentSessionPermissionResponseTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (record.kind !== 'execution_run_host_bridge') {
    return null;
  }

  const sessionId = readNonEmptyString(record.sessionId);
  const runId = readNonEmptyString(record.runId);
  const callId = readNonEmptyString(record.callId);
  const sidechainId = readNonEmptyString(record.sidechainId);
  const backendId = readNonEmptyString(record.backendId);
  const runtimeKind = readNonEmptyString(record.runtimeKind);
  const providerRequestId = readNonEmptyString(record.providerRequestId);

  if (
    !sessionId
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
  };
}
