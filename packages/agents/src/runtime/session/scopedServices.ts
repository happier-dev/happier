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
  SessionSystemRecordKind,
  SessionSystemRecordNamespace,
  ConnectedServiceCredentialRevisionV1,
  AgentSessionAuthRefreshClassificationV1,
  AgentSessionAuthRefreshErrorV1,
  AgentSessionAuthRefreshPayloadV1,
  AgentSessionAuthRefreshRecoveryV1,
  AgentSessionAuthRefreshSelectionV1,
  SubagentId,
  SubagentLifecycleDetailV1 as ProtocolSubagentLifecycleDetailV1,
  SubagentRefInputV1 as ProtocolSubagentRefInputV1,
  SubagentRefV1 as ProtocolSubagentRefV1,
  SubagentStatusV1 as ProtocolSubagentStatusV1,
  StructuredQuestionAnswersV1,
} from '@happier-dev/protocol';

import type { SessionStateFieldWriteValue } from '../../session/state/_types.js';

export type SessionRuntimeAuthRefreshRequestV1 = Readonly<{
  agentId: string;
  serviceId: string;
  refreshAttemptId?: string;
  targetId?: string | null;
  selection?: AgentSessionAuthRefreshSelectionV1;
  planType?: string | null;
  env?: Readonly<Record<string, string>> | null;
  materializedEnv?: Readonly<Record<string, string>> | null;
  targetMaterializedEnv?: Readonly<Record<string, string>> | null;
  classification?: AgentSessionAuthRefreshClassificationV1;
  failingAccessTokenFingerprint?: string | null;
  expectedCredentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
  reason?: string | null;
}>;

export type SessionRuntimeAuthRefreshResultV1 = Readonly<
  | {
      status: 'refreshed';
      result?: AgentSessionAuthRefreshPayloadV1;
    }
  | {
      status: 'unavailable';
      reason: string;
      recovery?: AgentSessionAuthRefreshRecoveryV1;
    }
  | {
      status: 'failed';
      reason: string;
      error?: AgentSessionAuthRefreshErrorV1;
      runtimeAuthClassification?: AgentSessionAuthRefreshClassificationV1;
      recovery?: AgentSessionAuthRefreshRecoveryV1;
    }
  | {
      status: 'pending';
      refreshAttemptId: string;
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
  agentId?: string;
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
  agentId: string;
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
  agentId: string;
  remoteSessionId: string;
  source: ExternalSessionSourceV1;
  direction: 'older' | 'newer';
  cursor?: string;
  maxBytes?: number;
  maxItems?: number;
}>;

export type ExternalSessionTranscriptReadAfterParamsV1 = Readonly<{
  agentId: string;
  remoteSessionId: string;
  source: ExternalSessionSourceV1;
  cursor: string;
  maxBytes?: number;
  maxItems?: number;
}>;

export type ExternalSessionTranscriptUpdateV1 = Readonly<{
  items: readonly ExternalSessionTranscriptItemV1[];
  fromCursor?: string | null;
  nextCursor?: string | null;
}>;

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

export type PublicSessionStateFieldId = Exclude<
  SessionStateFieldId,
  'runtime.activity' | 'runtime.externalAgent'
>;

export type SessionStateFieldWriteRequestV1<F extends PublicSessionStateFieldId = PublicSessionStateFieldId> = Readonly<{
  fieldId: F;
  value: SessionStateFieldWriteValue<F>;
  reason?: string;
}>;

/**
 * Narrow, generic, session-scoped durable system-record write (the durable detail counterpart of
 * `writeMetadata`). The HOST owns credentials, the data-encryption key, content sealing, and the
 * `/v2/sessions/:id/system-records` transport — mirroring how the host writes MEMORY system records.
 * A runtime contributes a typed `payload`; it never sees the token or DEK. The host resolves the
 * session's stored-content encryption mode/context (lazy + cached) and seals `payload` into a plain
 * or encrypted envelope before upserting. Rejects on failure so a caller can isolate/retry per write.
 */
export type SessionSystemRecordWriteRequestV1 = Readonly<{
  namespace: SessionSystemRecordNamespace;
  kind: SessionSystemRecordKind;
  /** Stable, idempotent record id within the namespace/kind (upsert key). */
  localId: string;
  /** Provider-agnostic record payload; the host seals it per the session's encryption mode. */
  payload: unknown;
  reason?: string;
}>;

/**
 * Narrow, generic, session-scoped durable system-record read. The HOST owns credentials, the
 * data-encryption key, content opening, and transport. A runtime asks for a stable record id and
 * receives an opened provider-agnostic payload, never the encrypted/plain storage envelope.
 */
export type SessionSystemRecordReadRequestV1 = Readonly<{
  namespace: SessionSystemRecordNamespace;
  localId: string;
  reason?: string;
}>;

export type SessionSystemRecordReadResultV1 = Readonly<{
  namespace: SessionSystemRecordNamespace;
  kind: SessionSystemRecordKind;
  localId: string;
  payload: unknown;
}>;

export type SessionPermissionModeV1 = string;

export type SessionPermissionDecisionRequestV1 = Readonly<{
  provider?: string;
  /**
   * Runtime-owned provenance for the published request. This is carried separately from tool
   * input so provider-authored arguments cannot impersonate a host/runtime-owned request kind.
   */
  source?: string;
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

export type SessionPermissionFollowUpPromptDeliveryV1 = 'nextTurn' | 'followUp';

export type SessionPermissionFollowUpPromptIntentV1 = Readonly<{
  prompt: string;
  delivery: SessionPermissionFollowUpPromptDeliveryV1;
}>;

export type SessionPermissionPersistAllowRuleScopeV1 = 'session' | 'workspace' | 'account';

export type SessionPermissionPersistAllowRuleV1 = Readonly<{
  scope: SessionPermissionPersistAllowRuleScopeV1;
  toolName?: string;
}>;

export type SessionPermissionDecisionResultV1 = Readonly<{
  decision: SessionPermissionDecisionV1;
  rationale?: string;
  /**
   * Provider-neutral structured answers for question-style permission/user-action requests.
   *
   * Claude AskUserQuestion uses this to answer the native tool call without a follow-up text turn.
   */
  answers?: StructuredQuestionAnswersV1;
  /**
   * Optional typed prompt the host/runtime should deliver as a later user turn after this
   * permission decision settles. This reserves follow-up/next-turn intent explicitly instead
   * of smuggling user text through provider-local permission payloads.
   */
  followUpPrompt?: SessionPermissionFollowUpPromptIntentV1;
  /**
   * Optional typed persistence intent for an approved permission rule. Provider-specific
   * permission update payloads can still ride `updatedPermissions`, but the persistence scope is
   * explicit on the public decision surface before it freezes.
   */
  persistAllowRule?: SessionPermissionPersistAllowRuleV1;
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
