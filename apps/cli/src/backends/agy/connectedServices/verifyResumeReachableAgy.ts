import type { VerifyResumeReachableInput, VerifyResumeReachableResult } from '@/backends/connectedServices/verifyResumeReachableTypes';
import { locateAgyConversation } from '../acp/agyConversationStore';

/** A conversation is reachable in the CLI store, or in the retired server's store from which launch imports it. */
export async function verifyResumeReachableAgy(input: VerifyResumeReachableInput): Promise<VerifyResumeReachableResult> {
  const home = input.targetMaterializedEnv.GEMINI_HOME?.trim();
  const id = input.vendorResumeId?.trim();
  if (!home || !id) return { ok: false, reason: 'agy_session_state_not_found' };
  const conversation = await locateAgyConversation(home, id);
  return conversation.path ? { ok: true, resolvedPath: conversation.path } : { ok: false, reason: 'agy_session_state_not_found' };
}
