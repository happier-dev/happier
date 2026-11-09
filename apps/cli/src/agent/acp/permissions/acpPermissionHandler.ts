import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
} from '@agentclientprotocol/sdk';
import type {
  SessionPermissionFollowUpPromptIntent as SessionPermissionFollowUpPromptIntentV1,
} from '@happier-dev/plugin-sdk/sessions';
import type { SessionInputCausalPermissionAuthorityV1 } from '@happier-dev/protocol';
import type { NativePermissionChoicesV1, NativePermissionChoiceAnswerV1, SessionPermissionRespondRpcParamsV1 } from '@happier-dev/protocol/sessions/permissions/respondRpcParamsV1';

export type AcpPermissionDecisionResult = Readonly<{
  decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
  nativeChoice?: NativePermissionChoiceAnswerV1;
  mode?: SessionPermissionRespondRpcParamsV1['mode'];
  allowedTools?: readonly string[];
  updatedPermissions?: unknown;
  execPolicyAmendment?: SessionPermissionRespondRpcParamsV1['execPolicyAmendment'];
  rationale?: string;
  followUpPrompt?: SessionPermissionFollowUpPromptIntentV1;
}>;

/**
 * Canonical protocol carrier stamped by the runtime from the exact terminal
 * user-input row(s) that caused this tool call. ACP only transports it.
 */
export type AcpPermissionCausalAuthority = SessionInputCausalPermissionAuthorityV1;

export type AcpPermissionCallContext = Readonly<{
  nativeChoices?: NativePermissionChoicesV1;
  /** Cancellation of this exact native ACP request, independent of its turn. */
  signal?: AbortSignal;
  /** Host-only child Run policy input; never an admitted user-input authority. */
  mcpToolPolicy?: Readonly<{
    permissionMode: string;
    readContext: () => import('@/mcp/runtime/resolveMcpToolIdentity').McpToolPolicyContext | null;
  }>;
  origin?: 'host_acp_fs_write' | 'host_occurrence_question';
  /** Request lifetime is independent of the causal turn's permission authority. */
  lifetime?: 'turn' | 'occurrence';
  /**
   * Exact host turn that admitted this permission request. ACP transports this
   * host-stamped identity; providers and plugins never create or infer it.
   */
  turnId?: string | null;
  /**
   * Absent only for legacy/host operations that have no admitted user-input
   * cause. An own null field means an active host turn lost its authority and
   * must fail closed rather than inherit mutable Session mode.
   */
  causalPermissionAuthority?: AcpPermissionCausalAuthority | null;
  /** Host-private current caller mode; the original admitted ceiling remains immutable. */
  callerPermissionMode?: string | null;
}>;

/**
 * Permission handler interface for ACP backends.
 *
 * This is intentionally ACP-owned. The shared host core consumes higher-level
 * permission policy; ACP needs a narrow hook to surface tool-call approval
 * requests through the host.
 */
export interface AcpPermissionHandler {
  resolvePrePromptDecision?(
    toolCallId: string,
    toolName: string,
    input: unknown
  ): Promise<AcpPermissionDecisionResult | null>;

  /**
   * Side-effect-free synchronous decision used both to suppress redundant prompts and
   * to revalidate host-mediated effects immediately before dispatch.
   */
  getImmediateDecision?(
    toolCallId: string,
    toolName: string,
    input: unknown,
    context?: AcpPermissionCallContext,
  ): AcpPermissionDecisionResult | null;

  /**
   * Handle a tool permission request.
   * @param toolCallId - The unique ID of the tool call
   * @param toolName - The name of the tool being called
   * @param input - The input parameters for the tool
   * @returns Promise resolving to permission result with decision
   */
  handleToolCall(
    toolCallId: string,
    toolName: string,
    input: unknown,
    context?: AcpPermissionCallContext,
  ): Promise<AcpPermissionDecisionResult>;

  /**
   * Handle an ACP `elicitation/create` request through the canonical session
   * interactions service.
   */
  handleElicitation?(
    request: CreateElicitationRequest,
    context?: AcpPermissionCallContext,
  ): Promise<CreateElicitationResponse>;

  /**
   * Abort one exact provider permission occurrence and settle its durable host
   * projection before returning. Execution-run wrappers use this instead of
   * the session-wide abort below so retiring one child cannot affect siblings.
   */
  abortPendingRequestAndFlush?(requestId: string, reason: string, options?: Readonly<{ preserveQuestions?: boolean }>): Promise<void>;

  abortPendingRequestsAndFlush?(reason: string, options?: Readonly<{ preserveQuestions?: boolean }>): Promise<void>;
}
