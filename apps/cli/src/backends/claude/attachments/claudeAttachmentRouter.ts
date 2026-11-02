import { parseClaudeGoalStatusAttachment } from '../workState/claudeGoalStatus';
import {
  parseClaudeQueuedCommandAttachment,
  parseClaudeCredentialOrganizationAttachment,
  readClaudeAttachmentRecord,
  type ClaudeAttachmentHandlers,
} from './claudeAttachmentTypes';

/**
 * Single deep seam (plan D1) for Claude transcript `attachment` records.
 *
 * The native Claude JSONL parser previously dropped attachments; this router is
 * the one place that knows the attachment envelope and dispatches by
 * `attachment.type` to typed handlers (`goal_status`, `queued_command`, …).
 * Unknown subtypes are ignored so new attachment kinds never break ingestion
 * (forward-compatible). Each handler owns the deeper parsing for its subtype.
 *
 * Allocation-light and side-effect free apart from the supplied callbacks, so it
 * is safe to call inside the tail-follow message loop for every transcript row.
 */
export function routeClaudeAttachment(value: unknown, handlers: ClaudeAttachmentHandlers): void {
  const record = readClaudeAttachmentRecord(value);
  if (!record) return;

  switch (record.attachment.type) {
    case 'credential_org': {
      if (!handlers.onCredentialOrganization) break;
      const event = parseClaudeCredentialOrganizationAttachment(record);
      if (event) handlers.onCredentialOrganization(event);
      break;
    }
    case 'goal_status': {
      if (!handlers.onGoalStatus) break;
      const event = parseClaudeGoalStatusAttachment(record);
      if (event) handlers.onGoalStatus(event);
      break;
    }
    case 'queued_command': {
      if (!handlers.onQueuedCommand) break;
      const command = parseClaudeQueuedCommandAttachment(record);
      if (command) handlers.onQueuedCommand(command);
      break;
    }
    default:
      handlers.onUnknown?.(record);
      break;
  }
}
