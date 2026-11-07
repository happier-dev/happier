import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ComputerSecretFillRequestV1Schema, SecretFillSettlementV1Schema } from '../computer/v1.js';
import { BrowserAutomationSecretFillRequestV1Schema } from '../browser/automation/v1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { ApprovalExecutionV2Schema, ApprovalRequestOriginV1Schema } from './approvalRequestV1.js';
import { ApprovalStaleFailureDetailsSchema } from './approvalStaleReason.js';

const ConfidentialApprovalFailureCodeSchema = lazyZodSchema(() => z.enum([
  'approval_stale', 'approval_context_unavailable', 'approval_execution_outcome_unknown',
  'confidential_choice_required', 'unsupported_action', 'invalid_parameters', 'present_user_required',
  'approval_not_found', 'approval_invalid', 'approval_not_open', 'action_disabled', 'credential_scope_denied',
]));

/** The durable record keeps the exact value-free input; the domain admits its target at execution. */
export function validateConfidentialApprovalRequest(value: Readonly<Record<string, unknown>>, ctx: z.core.$RefinementCtx): void {
  const actionId = value.actionId;
  if (actionId !== 'computer.secret.fill' && actionId !== 'browser.automation.secret.fill') return;
  const issue = (path: (string | number)[]) => ctx.addIssue({
    code: 'custom', path, message: 'Confidential approval requires exact value-free custody',
  });
  if (value.v !== 2) { issue(['v']); return; }
  const inputSchema = actionId === 'computer.secret.fill'
    ? ComputerSecretFillRequestV1Schema : BrowserAutomationSecretFillRequestV1Schema;
  const args = inputSchema.safeParse(value.actionArgs);
  if (!args.success) issue(['actionArgs']);
  if (value.preview !== undefined) {
    const preview = z.strictObject({ actionId: z.literal(actionId), actionArgs: inputSchema }).safeParse(value.preview);
    if (!preview.success || !args.success || !sameStrictJsonValue(preview.data.actionArgs, args.data)) issue(['preview']);
  }
  const transcriptOrigin = ApprovalRequestOriginV1Schema.safeParse(value.origin);
  if (transcriptOrigin.success && transcriptOrigin.data.toolInput !== undefined) {
    const toolInput = transcriptOrigin.data.toolInput;
    const direct = inputSchema.safeParse(toolInput);
    const wrapped = z.strictObject({ actionId: z.literal(actionId), input: inputSchema }).safeParse(toolInput);
    const parsedInput = direct.success ? direct.data : wrapped.success ? wrapped.data.input : undefined;
    if (!args.success || parsedInput === undefined || !sameStrictJsonValue(parsedInput, args.data)) issue(['origin', 'toolInput']);
  }
  const execution = ApprovalExecutionV2Schema.safeParse(value.execution);
  if (execution.success) {
    const record = execution.data;
    if (record.result !== undefined && !SecretFillSettlementV1Schema.safeParse(record.result).success) issue(['execution', 'result']);
    if (record.ok && record.result === undefined) issue(['execution', 'result']);
    if (record.details !== undefined && (record.ok || record.errorCode !== 'approval_stale'
      || !ApprovalStaleFailureDetailsSchema.safeParse(record.details).success)) issue(['execution', 'details']);
    if (!record.ok && (!ConfidentialApprovalFailureCodeSchema.safeParse(record.errorCode).success || record.error !== record.errorCode)) issue(['execution', 'error']);
    if (record.ok && (record.error !== undefined || record.errorCode !== undefined)) issue(['execution', 'error']);
  }
}
