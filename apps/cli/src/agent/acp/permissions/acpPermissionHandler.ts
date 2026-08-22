import type {
  SessionPermissionFollowUpPromptIntent as SessionPermissionFollowUpPromptIntentV1,
  SessionPermissionPersistAllowRule as SessionPermissionPersistAllowRuleV1,
} from '@happier-dev/plugin-sdk/sessions';
import type { SessionInputCausalPermissionAuthorityV1 } from '@happier-dev/protocol';

export type AcpPermissionDecisionResult = Readonly<{
  decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort';
  rationale?: string;
  followUpPrompt?: SessionPermissionFollowUpPromptIntentV1;
  persistAllowRule?: SessionPermissionPersistAllowRuleV1;
}>;

/**
 * Canonical protocol carrier stamped by the runtime from the exact terminal
 * user-input row(s) that caused this tool call. ACP only transports it.
 */
export type AcpPermissionCausalAuthority = SessionInputCausalPermissionAuthorityV1;

export type AcpPermissionCallContext = Readonly<{
  origin?: 'host_acp_fs_write';
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

  abortPendingRequestsAndFlush?(reason: string): Promise<void>;
}
