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
  ): Promise<{ decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort'; rationale?: string } | null>;

  /**
   * Best-effort synchronous preview used to suppress UI/mobile permission prompts for
   * requests the handler can auto-approve immediately.
   */
  getImmediateDecision?(
    toolCallId: string,
    toolName: string,
    input: unknown
  ): { decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort'; rationale?: string } | null;

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
    input: unknown
  ): Promise<{ decision: 'approved' | 'approved_for_session' | 'approved_execpolicy_amendment' | 'denied' | 'abort'; rationale?: string }>;

  abortPendingRequestsAndFlush?(reason: string): Promise<void>;
}
