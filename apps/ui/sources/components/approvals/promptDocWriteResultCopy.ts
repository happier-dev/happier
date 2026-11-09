import type { PromptDocInstructionWriteFacts } from './promptDocApprovalModel';

export type PromptDocWriteStatus = NonNullable<PromptDocInstructionWriteFacts['agentWriteResult']>['status'];

/**
 * How an Agent's `prompt_doc.update` result reads where it was asked for (plan 61 copy table): the
 * Instructions section and the approval card say the same words for the same outcome. A canceled
 * request kept the previous instructions exactly as a denied one did.
 */
export const PROMPT_DOC_WRITE_RESULT_KEY = {
  pending: 'sessionInstructions.savePending',
  updated: 'sessionInstructions.updated',
  denied: 'sessionInstructions.saveDenied',
  canceled: 'sessionInstructions.saveDenied',
  conflict: 'sessionInstructions.saveConflict',
  failed: 'sessionInstructions.setFailed',
  outcome_unknown: 'automations.detail.runMeta.dispatchState.outcomeUnknown',
} as const satisfies Record<PromptDocWriteStatus, string>;

/** Outcomes that need the person (waiting, or something did not land); the rest are settled facts. */
export function promptDocWriteNeedsAttention(status: PromptDocWriteStatus): boolean {
  return status === 'pending' || status === 'conflict' || status === 'failed' || status === 'outcome_unknown';
}
