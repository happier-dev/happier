import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import type { WorkflowDefinitionV1 } from './workflowV1.js';

/** The first proposal keeps the hold identity; a changed proposal has its own semantic identity. */
export function deriveWorkflowPlanRunIdV1(runId: string, invocationId: string, normalizedProposal?: WorkflowDefinitionV1): string {
  return deriveWorkflowReplacementId(['workflow.review.plan_run', runId, invocationId,
    ...(normalizedProposal === undefined ? [] : [createCanonicalJsonSigningInput(normalizedProposal)])]);
}

/** Stable request identity shared by admission, recovery and review rejoin. */
export function deriveWorkflowReplacementId(parts: readonly unknown[]): string {
  const hex = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(parts)))).slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}
