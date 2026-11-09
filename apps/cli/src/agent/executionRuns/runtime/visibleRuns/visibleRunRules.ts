import {
  isExecutionRunBindRoleCompatibleV1,
  readSessionOriginV1,
  readSessionRoleAssignmentV1,
  readSessionRoleV1,
  type AcpConfigOptionOverridesV1,
  type BackendTargetRefV1,
  type ExecutionRunBindRejectionReason,
  type ExecutionRunRole,
  type ExecutionRunVisibleIntent,
} from '@happier-dev/protocol';

import { permissionModeForExecutionRunPolicy } from '@/agent/executionRuns/policy/permissionModeForExecutionRunPolicy';

/**
 * Controls are match-only (plan 2A, F9): a run never changes a child's permission mode, model, or
 * session config. A bind is admitted only when the child's current controls already equal the run's.
 */
export type VisibleRunControls = Readonly<{
  backendTarget: BackendTargetRefV1;
  /** Session permission mode the child must run with (the one mapping owner: permissionModeForExecutionRunPolicy). */
  sessionPermissionMode: string;
  /** Null when the run leaves the model to the child. */
  modelId: string | null;
  sessionConfigOptionOverrides: AcpConfigOptionOverridesV1 | null;
}>;

export function resolveVisibleRunControls(params: Readonly<{
  backendTarget: BackendTargetRefV1;
  permissionMode: string;
  modelId?: string | null;
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1 | null;
}>): VisibleRunControls {
  return {
    backendTarget: params.backendTarget,
    sessionPermissionMode: permissionModeForExecutionRunPolicy(params.permissionMode),
    modelId: typeof params.modelId === 'string' && params.modelId.trim() ? params.modelId : null,
    sessionConfigOptionOverrides: params.sessionConfigOptionOverrides ?? null,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The child's current controls as published in its own metadata. */
export function readVisibleRunChildControls(metadata: unknown): Readonly<{
  agentId: string | null;
  permissionMode: string | null;
  modelId: string | null;
  configOverrides: Record<string, unknown>;
}> {
  const meta = record(metadata) ?? {};
  const modelOverride = record(meta.modelOverrideV1);
  const configOverrides = record(record(meta.sessionConfigOptionOverridesV1)?.overrides) ?? {};
  return {
    agentId: typeof meta.flavor === 'string' ? meta.flavor : null,
    permissionMode: typeof meta.permissionMode === 'string' ? meta.permissionMode : null,
    modelId: typeof modelOverride?.modelId === 'string' ? modelOverride.modelId : null,
    configOverrides,
  };
}

function controlsMatch(controls: VisibleRunControls, metadata: unknown): boolean {
  const child = readVisibleRunChildControls(metadata);
  if (controls.backendTarget.kind === 'builtInAgent' && child.agentId !== controls.backendTarget.agentId) return false;
  if (child.permissionMode !== controls.sessionPermissionMode) return false;
  if (controls.modelId !== null && child.modelId !== controls.modelId) return false;
  for (const [key, override] of Object.entries(controls.sessionConfigOptionOverrides?.overrides ?? {})) {
    const childValue = record(child.configOverrides[key])?.value;
    if (childValue !== (override as { value?: unknown }).value) return false;
  }
  return true;
}

export type VisibleRunChildSnapshot = Readonly<{
  sessionId: string;
  metadata: Record<string, unknown> | null;
  archived: boolean;
}>;

/** Bind admission, in the plan's order: foreign child, archived child, role, busy child, controls. */
export function admitVisibleRunBind(params: Readonly<{
  hostingSessionId: string;
  intent: ExecutionRunVisibleIntent;
  requestedRole?: ExecutionRunRole;
  child: VisibleRunChildSnapshot;
  busy: boolean;
  controls: VisibleRunControls;
}>): Readonly<{ ok: true; childRole: string; childAssignmentId: string | null } | { ok: false; reason: ExecutionRunBindRejectionReason }> {
  const origin = readSessionOriginV1(params.child.metadata);
  if (!origin || origin.creatorSessionId !== params.hostingSessionId) return { ok: false, reason: 'foreign_child' };
  // An archived child is refused before any link or task message is written.
  if (params.child.archived) return { ok: false, reason: 'child_archived' };
  const childRole = readSessionRoleV1(params.child.metadata);
  if (!isExecutionRunBindRoleCompatibleV1({ intent: params.intent, requestedRole: params.requestedRole ?? null, childRole })) {
    return { ok: false, reason: 'role_mismatch' };
  }
  if (params.busy) return { ok: false, reason: 'child_busy' };
  if (!controlsMatch(params.controls, params.child.metadata)) return { ok: false, reason: 'controls_mismatch' };
  return { ok: true, childRole: childRole!, childAssignmentId: readSessionRoleAssignmentV1(params.child.metadata)?.assignmentId ?? null };
}

/**
 * True when the child's permission mode or model left the run's controls, from its metadata (an
 * owner action) or from the controls recorded on any user message after the task message.
 */
export function detectVisibleRunControlsChange(params: Readonly<{
  controls: VisibleRunControls;
  metadata: unknown;
  userMessageMetas: readonly (Record<string, unknown> | null)[];
}>): boolean {
  const child = readVisibleRunChildControls(params.metadata);
  if (child.permissionMode !== null && child.permissionMode !== params.controls.sessionPermissionMode) return true;
  if (params.controls.modelId !== null && child.modelId !== null && child.modelId !== params.controls.modelId) return true;
  for (const meta of params.userMessageMetas) {
    if (!meta) continue;
    if (typeof meta.permissionMode === 'string' && meta.permissionMode !== params.controls.sessionPermissionMode) return true;
    const model = typeof meta.model === 'string' ? meta.model : null;
    if (model !== null && (params.controls.modelId === null ? (child.modelId !== null && model !== child.modelId) : model !== params.controls.modelId)) return true;
  }
  return false;
}

export type VisibleRunTranscriptMessage = Readonly<{
  seq: number | null;
  role: 'user' | 'assistant';
  text: string;
  localId: string | null;
  meta: Record<string, unknown> | null;
}>;

/**
 * Forward read from the task message: one final assistant output per user turn, in order, so a
 * coalesced wake-up or a quick user turn can neither skip nor misattribute the first valid output.
 */
export function readVisibleRunTurnOutputs(params: Readonly<{
  messages: readonly VisibleRunTranscriptMessage[];
  /** The task message: the bound child's message carrying this run's link, or a created child's first input. */
  isTaskMessage: (message: VisibleRunTranscriptMessage) => boolean;
}>): Readonly<{
  taskFound: boolean;
  turns: readonly Readonly<{ finalText: string }>[];
  userMessageMetas: readonly (Record<string, unknown> | null)[];
}> {
  const start = params.messages.findIndex((message) => message.role === 'user' && params.isTaskMessage(message));
  if (start < 0) return { taskFound: false, turns: [], userMessageMetas: [] };
  const turns: Array<{ finalText: string }> = [];
  const userMessageMetas: Array<Record<string, unknown> | null> = [];
  let current: string | null = null;
  for (const message of params.messages.slice(start)) {
    if (message.role === 'user') {
      if (current !== null) turns.push({ finalText: current });
      current = null;
      userMessageMetas.push(message.meta);
      continue;
    }
    if (message.text.trim()) current = message.text;
  }
  if (current !== null) turns.push({ finalText: current });
  return { taskFound: true, turns, userMessageMetas };
}
