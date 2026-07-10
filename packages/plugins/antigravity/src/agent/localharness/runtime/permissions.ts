import type {
  SessionPermissionDecisionRequestV1,
  SessionPermissionDecisionResultV1,
} from '@happier-dev/plugin-sdk/sessions';

import type { AntigravityLocalharnessEvent } from '../client/protocol.js';
import { isHarnessSideTool } from '../client/protocol.js';

export type AntigravityLocalharnessPermissionDecision = SessionPermissionDecisionResultV1;

export type AntigravityLocalharnessPermissionRequester = (
  request: SessionPermissionDecisionRequestV1,
) => Promise<AntigravityLocalharnessPermissionDecision>;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeQuestionIds(event: Extract<AntigravityLocalharnessEvent, { type: 'user_questions_request' }>): string {
  return (event.questions ?? [])
    .map((question, index) => readString(question.id) ?? readString(question.prompt) ?? `question-${index}`)
    .join(',');
}

export function permissionRequestKey(
  event: Extract<AntigravityLocalharnessEvent, { type: 'tool_confirmation_request' }>,
): string {
  return [
    readString(event.trajectoryId) ?? 'trajectory',
    readString(event.stepId) ?? 'step',
    readString(event.requestId) ?? 'request',
    'tool',
    readString(event.toolName) ?? 'unknown',
    readString(event.command) ?? '',
  ].join('\u0000');
}

export function questionRequestKey(
  event: Extract<AntigravityLocalharnessEvent, { type: 'user_questions_request' }>,
): string {
  return [
    readString(event.trajectoryId) ?? 'trajectory',
    readString(event.stepId) ?? 'step',
    readString(event.requestId) ?? 'request',
    'question',
    normalizeQuestionIds(event),
  ].join('\u0000');
}

export function buildPermissionDecisionRequest(
  event: Extract<AntigravityLocalharnessEvent, { type: 'tool_confirmation_request' }>,
): SessionPermissionDecisionRequestV1 {
  const toolName = readString(event.toolName) ?? 'unknown';
  const requestId = readString(event.requestId) ?? permissionRequestKey(event);
  const command = readString(event.command);
  return {
    requestId,
    toolName,
    input: {
      toolName,
      command,
      prompt: readString(event.prompt),
      provider: 'antigravity',
      localharness: true,
      request: event.input ?? null,
    },
  };
}

export function defaultDenyDecisionFor(event: Extract<AntigravityLocalharnessEvent, { type: 'tool_confirmation_request' }>): AntigravityLocalharnessPermissionDecision | null {
  const toolName = readString(event.toolName);
  if (!toolName || !isHarnessSideTool(toolName)) {
    return { decision: 'denied', rationale: 'unsupported_tool' };
  }
  if (toolName === 'run_command' || toolName === 'shell') {
    return { decision: 'denied', rationale: 'run_command_default_denied' };
  }
  return null;
}
