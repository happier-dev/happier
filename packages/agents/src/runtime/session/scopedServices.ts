import type {
  ExternalSessionCandidateV1 as ProtocolExternalSessionCandidateV1,
  ExternalSessionsSearchMode,
  ExternalSessionsSource,
  ExternalSessionTakeoverInputV1 as ProtocolExternalSessionTakeoverInputV1,
  ExternalSessionTakeoverResultV1 as ProtocolExternalSessionTakeoverResultV1,
  ExternalSessionTranscriptPageResponse,
  ExternalSessionTranscriptRawMessageV1,
  ExternalSessionTranscriptReadAfterResponse,
  SessionId,
  SessionStateFieldId,
  SubagentId,
  SubagentLifecycleDetailV1 as ProtocolSubagentLifecycleDetailV1,
  SubagentRefInputV1 as ProtocolSubagentRefInputV1,
  SubagentRefV1 as ProtocolSubagentRefV1,
  SubagentStatusV1 as ProtocolSubagentStatusV1,
} from '@happier-dev/protocol';
import type { RuntimeEventV1 } from '@happier-dev/protocol/runtime';

import type { SessionStateFieldWriteValue } from '../../session/state/_types.js';

export interface SubscriptionV1 {
  unsubscribe(): void;
}

export type SessionRuntimeAuthRefreshRequestV1 = Readonly<{
  agentId: string;
  serviceId: string;
  targetId?: string | null;
  selection?: unknown;
  planType?: string | null;
  env?: Readonly<Record<string, string>> | null;
  materializedEnv?: Readonly<Record<string, string>> | null;
  targetMaterializedEnv?: Readonly<Record<string, string>> | null;
  classification?: unknown;
  reason?: string | null;
}>;

export type SessionRuntimeAuthRefreshResultV1 = Readonly<
  | {
      status: 'refreshed';
      result?: unknown;
    }
  | {
      status: 'unavailable';
      reason: string;
      recovery?: unknown;
    }
  | {
      status: 'failed';
      reason: string;
      error?: unknown;
      runtimeAuthClassification?: unknown;
      recovery?: unknown;
    }
>;

export interface SessionRuntimeAuthServicesV1 {
  refreshRuntimeAuth(
    request: SessionRuntimeAuthRefreshRequestV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<SessionRuntimeAuthRefreshResultV1>;
}

export interface SessionAuthServiceV1 {
  readonly services: SessionRuntimeAuthServicesV1;
}

export type SessionMcpElicitDecisionV1 =
  | 'approved'
  | 'approved_for_session'
  | 'denied'
  | 'abort';

export type SessionMcpElicitRequestV1 = Readonly<{
  requestId?: string;
  toolCallId?: string;
  serverName?: string;
  toolName: string;
  input?: unknown;
  prompt?: string;
  schema?: unknown;
  meta?: Readonly<Record<string, unknown>>;
}>;

export type SessionMcpElicitResultV1 = Readonly<
  | {
      status: 'accepted';
      decision: 'approved' | 'approved_for_session';
      content?: Readonly<Record<string, unknown>>;
    }
  | {
      status: 'declined';
      decision: 'denied';
      content?: Readonly<Record<string, unknown>>;
    }
  | {
      status: 'cancelled';
      decision: 'abort';
      content?: Readonly<Record<string, unknown>>;
    }
  | {
      status: 'unavailable';
      reason: string;
      content?: Readonly<Record<string, unknown>>;
    }
  | {
      status: 'failed';
      reason: string;
      error?: unknown;
      content?: Readonly<Record<string, unknown>>;
    }
>;

export interface SessionMcpServiceV1 {
  elicit(
    request: SessionMcpElicitRequestV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<SessionMcpElicitResultV1>;
}

export type ExternalSessionSourceV1 = ExternalSessionsSource;
export type ExternalSessionCandidateV1 = ProtocolExternalSessionCandidateV1;
export type ExternalSessionTranscriptItemV1 = ExternalSessionTranscriptRawMessageV1;
export type ExternalSessionTranscriptPageResultV1 = ExternalSessionTranscriptPageResponse;
export type ExternalSessionTranscriptReadAfterResultV1 = ExternalSessionTranscriptReadAfterResponse;
export type ExternalSessionTakeoverInputV1 = ProtocolExternalSessionTakeoverInputV1;
export type ExternalSessionTakeoverResultV1 = ProtocolExternalSessionTakeoverResultV1;

export type ExternalSessionListCandidatesParamsV1 = Readonly<{
  providerId?: string;
  source?: ExternalSessionSourceV1;
  cursor?: string;
  limit?: number;
  searchTerm?: string;
  searchMode?: ExternalSessionsSearchMode;
}>;

export type ExternalSessionListCandidatesResultV1 = Readonly<{
  candidates: readonly ExternalSessionCandidateV1[];
  nextCursor: string | null;
  searchIncomplete?: boolean;
}>;

export type ExternalSessionAttachParamsV1 = Readonly<{
  providerId: string;
  remoteSessionId: string;
  source?: ExternalSessionSourceV1;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type ExternalSessionAttachResultV1 = Readonly<{
  ok: boolean;
  sessionId?: string;
  error?: string;
}>;

export type ExternalSessionTranscriptPageParamsV1 = Readonly<{
  providerId: string;
  remoteSessionId: string;
  source: ExternalSessionSourceV1;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes?: number;
  maxItems?: number;
}>;

export type ExternalSessionTranscriptReadAfterParamsV1 = Readonly<{
  providerId: string;
  remoteSessionId: string;
  source: ExternalSessionSourceV1;
  cursor: string;
  maxBytes?: number;
  maxItems?: number;
}>;

export type ExternalSessionTranscriptUpdateV1 = Readonly<{
  items: readonly ExternalSessionTranscriptItemV1[];
  nextCursor?: string | null;
}>;

export interface PluginExternalSessionsServiceV1 {
  listCandidates(
    params?: ExternalSessionListCandidatesParamsV1,
  ): Promise<ExternalSessionListCandidatesResultV1>;
  attach(params: ExternalSessionAttachParamsV1): Promise<ExternalSessionAttachResultV1>;
  takeover(params: ExternalSessionTakeoverInputV1): Promise<ExternalSessionTakeoverResultV1>;
  pageTranscript(
    params: ExternalSessionTranscriptPageParamsV1,
  ): Promise<ExternalSessionTranscriptPageResultV1>;
  readAfterTranscript(
    params: ExternalSessionTranscriptReadAfterParamsV1,
  ): Promise<ExternalSessionTranscriptReadAfterResultV1>;
  followTranscript(
    params: ExternalSessionTranscriptReadAfterParamsV1,
    onEvent: (event: ExternalSessionTranscriptUpdateV1) => void,
  ): SubscriptionV1;
}

export type SubagentListParamsV1 = Readonly<{
  parentSessionId?: SessionId;
  groupId?: string | null;
}>;

export type SubagentGetParamsV1 = Readonly<{
  id: SubagentId;
  parentSessionId?: SessionId;
}>;

export type SubagentWatchParamsV1 = Readonly<{
  parentSessionId?: SessionId;
  id?: SubagentId;
}>;

export type SubagentWatchEventV1 = Readonly<{
  kind: 'snapshot' | 'changed' | 'removed';
  subagents?: readonly ProtocolSubagentRefV1[];
  subagent?: ProtocolSubagentRefV1;
  id?: SubagentId;
}>;
export type SubagentLifecycleDetailV1 = ProtocolSubagentLifecycleDetailV1;
export type SubagentRefInputV1 = ProtocolSubagentRefInputV1;
export type SubagentRefV1 = ProtocolSubagentRefV1;
export type SubagentStatusV1 = ProtocolSubagentStatusV1;

export type SubagentStatusUpdateParamsV1 = Readonly<{
  id: SubagentId;
  parentSessionId?: SessionId;
  status: ProtocolSubagentStatusV1;
  lifecycleDetail?: ProtocolSubagentLifecycleDetailV1;
  completedAt?: number;
}>;

export type SubagentCompleteParamsV1 = Readonly<{
  id: SubagentId;
  parentSessionId?: SessionId;
  status?: Extract<ProtocolSubagentStatusV1, 'completed' | 'failed' | 'aborted'>;
  lifecycleDetail?: ProtocolSubagentLifecycleDetailV1;
  completedAt?: number;
}>;

export interface PluginSubagentsServiceV1 {
  list(params?: SubagentListParamsV1): Promise<readonly ProtocolSubagentRefV1[]>;
  get(params: SubagentGetParamsV1): Promise<ProtocolSubagentRefV1 | null>;
  watch(params: SubagentWatchParamsV1, onEvent: (event: SubagentWatchEventV1) => void): SubscriptionV1;
  upsert(input: ProtocolSubagentRefInputV1): Promise<ProtocolSubagentRefV1>;
  updateStatus(params: SubagentStatusUpdateParamsV1): Promise<ProtocolSubagentRefV1>;
  complete(params: SubagentCompleteParamsV1): Promise<ProtocolSubagentRefV1>;
}

export type SessionScopedSubscriptionEventV1 = Readonly<{
  kind: string;
  payload?: unknown;
}>;

export type SessionScopedSendUserTextRequestV1 = Readonly<{
  kind: 'userText';
  text: string;
  opts?: Readonly<{
    localId?: string;
    meta?: Readonly<Record<string, unknown>>;
  }>;
}>;

export type SessionScopedSendSessionEventRequestV1 = Readonly<{
  kind: 'sessionEvent';
  event: RuntimeEventV1 | Readonly<Record<string, unknown>>;
  id?: string;
}>;

export type SessionScopedSendProviderDispatchRequestV1 = Readonly<{
  kind: 'providerDispatch';
  body: unknown;
  meta?: Readonly<Record<string, unknown>>;
}>;

export type SessionScopedAgentMessageOptionsV1 = Readonly<{
  localId: string;
  createdAt?: number;
  updatedAt?: number;
  meta?: Readonly<Record<string, unknown>>;
}>;

export type SessionScopedSendAgentMessageRequestV1 = Readonly<{
  kind: 'agentMessageEphemeral' | 'agentMessageCommitted';
  provider: string;
  body: Readonly<Record<string, unknown>>;
  opts: SessionScopedAgentMessageOptionsV1;
}>;

export type SessionScopedSendRequestV1 =
  | SessionScopedSendUserTextRequestV1
  | SessionScopedSendSessionEventRequestV1
  | SessionScopedSendProviderDispatchRequestV1
  | SessionScopedSendAgentMessageRequestV1;

export type SessionScopedSendResultV1 = Readonly<
  | { ok: true }
  | { ok: false; error: 'invalid_request' | 'unsupported_kind' | string }
>;

export type SessionScopedSubscribeRequestV1 = Readonly<{
  eventName?: string;
}>;

export type SessionMetadataWriteRequestV1 = Readonly<
  | {
      kind: 'set';
      metadata: Readonly<Record<string, unknown>>;
    }
  | {
      kind: 'update';
      handler: (current: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
      reason?: string;
    }
>;

export type SessionAgentStateWriteRequestV1 = Readonly<
  | {
      kind: 'set';
      agentState: Readonly<Record<string, unknown>>;
    }
  | {
      kind: 'update';
      handler: (current: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
    }
>;

export type SessionStateFieldWriteRequestV1<F extends SessionStateFieldId = SessionStateFieldId> = Readonly<{
  fieldId: F;
  value: SessionStateFieldWriteValue<F>;
  reason?: string;
}>;

export type SessionPermissionModeV1 = string;

export type SessionPermissionDecisionRequestV1 = Readonly<{
  provider?: string;
  requestId?: string;
  toolCallId?: string;
  toolName?: string;
  input?: Readonly<Record<string, unknown>>;
  approved?: boolean;
  reason?: string;
}>;

export type SessionPermissionDecisionV1 =
  | 'approved'
  | 'approved_for_session'
  | 'approved_execpolicy_amendment'
  | 'denied'
  | 'abort';

/**
 * Provider-neutral permission/mode update returned by a permission surface alongside an
 * approval decision. Mirrors the Claude `updatedPermissions` payload shape (e.g.
 * `{ type: 'setMode', mode }` or `{ type: 'addRules', rules: [...] }`) without binding the
 * host to a provider-specific union, so any runtime can carry "always allow" / mode-change
 * updates back through the decision result.
 */
export type SessionPermissionUpdateV1 = Readonly<Record<string, unknown>>;

export type SessionPermissionDecisionResultV1 = Readonly<{
  decision: SessionPermissionDecisionV1;
  rationale?: string;
  /**
   * Provider-neutral structured answers for question-style permission/user-action requests.
   *
   * Claude AskUserQuestion uses this to answer the native tool call without a follow-up text turn.
   */
  answers?: Readonly<Record<string, string>>;
  /**
   * Optional host-rewritten tool input returned by the active permission surface.
   */
  updatedInput?: Readonly<Record<string, unknown>>;
  /**
   * Optional permission/mode updates ("always allow", mode transitions) returned by the
   * permission surface. These must survive the engine -> host -> hook path so the provider can
   * apply allowlist/mode changes instead of re-asking. Claude's ExitPlanMode mode clear and
   * Codex "always allow" responses both ride this field.
   */
  updatedPermissions?: readonly SessionPermissionUpdateV1[];
}>;

export interface SessionPermissionsServiceV1 {
  requestDecision(
    request: SessionPermissionDecisionRequestV1,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<SessionPermissionDecisionResultV1>;
  getMode(): SessionPermissionModeV1;
}

export interface SessionScopedServicesV1 {
  readonly sessionId?: string;
  send(request: SessionScopedSendRequestV1): Promise<SessionScopedSendResultV1>;
  subscribe(
    request: SessionScopedSubscribeRequestV1,
    onEvent: (event: SessionScopedSubscriptionEventV1) => void,
  ): SubscriptionV1;
  writeMetadata(request: SessionMetadataWriteRequestV1): Promise<void>;
  writeAgentState(request: SessionAgentStateWriteRequestV1): Promise<void>;
  writeStateField<F extends SessionStateFieldId>(request: SessionStateFieldWriteRequestV1<F>): Promise<void>;
  readonly mcp: SessionMcpServiceV1;
  readonly auth: SessionAuthServiceV1;
  readonly permissions: SessionPermissionsServiceV1;
  readonly subagents: PluginSubagentsServiceV1;
  readonly external: PluginExternalSessionsServiceV1;
}
