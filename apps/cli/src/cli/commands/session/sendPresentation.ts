import { ok } from '@happier-dev/cli-common/output';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/sessions/creation/spawnSessionErrorCode';
import { readActionCliPresentationEnvelopeKind } from '@/cli/actions/commandPresentationMetadata';

import type {
  ActionCliFailure,
  ActionCliPresentation,
  ActionCliPresentationContext,
} from '@/cli/actions/commandPresentation';
import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';

/** Canonical `session.message.send` statuses that are not a delivered send. */
type UndeliveredSendStatus = 'rejected' | 'failed' | 'cancelled' | 'outcomeUnknown';

const UNDELIVERED_SEND_MESSAGES: Readonly<Record<UndeliveredSendStatus, string>> = {
  rejected: 'Message not accepted',
  failed: 'Message was accepted but its turn failed',
  cancelled: 'Message was accepted but its turn was cancelled',
  outcomeUnknown: 'Could not confirm whether the message was accepted',
};

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readLocalId(input: Readonly<Record<string, unknown>>): string | null {
  return readString(input.localId);
}

function isUndeliveredSendStatus(value: unknown): value is UndeliveredSendStatus {
  return value === 'rejected' || value === 'failed' || value === 'cancelled' || value === 'outcomeUnknown';
}

/** The send outcome a classified failure carries, or `null` for any other failure. */
function readClassifiedSendOutcome(
  failure: ActionCliFailure,
): Readonly<{ status: UndeliveredSendStatus; localId: string | null }> | null {
  const details = readRecord(failure.details);
  return isUndeliveredSendStatus(details.status)
    ? { status: details.status, localId: readString(details.localId) }
    : null;
}

function isRunSendSpelling(context: ActionCliPresentationContext): boolean {
  return context.command.path.join(' ') === 'session run send';
}

function readRunId(input: Readonly<Record<string, unknown>>): string | null {
  const recipient = input.recipient;
  if (!recipient || typeof recipient !== 'object' || Array.isArray(recipient)) return null;
  const record = recipient as Record<string, unknown>;
  return record.kind === 'execution_run' && typeof record.runId === 'string' ? record.runId : null;
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Presentation for the one canonical `session.message.send`.
 *
 * `session run send` keeps its released `session_run_send` envelope, including
 * the `runId`/`sent` fields it has always printed. That is a path-specific view
 * over the same canonical result — the three friendly spellings share one
 * parser, one binder and one Action invocation.
 *
 * Admission failures are classified before rendering success. A settled
 * inline reply carries the Action's result alongside the legacy envelope fields.
 */
export const SESSION_SEND_PRESENTATION: ActionCliPresentation = {
  envelopeKind: (command) => (
    readActionCliPresentationEnvelopeKind({ actionId: 'session.message.send', path: command.path })!
  ),
  classifyResult: (payload) => {
    // The executor has already validated the payload against the Action's
    // output schema, so only the canonical undelivered statuses are demoted
    // here; the presenter does not become a second output validator.
    const result = readRecord(payload);
    const status = result.status;
    if (!isUndeliveredSendStatus(status)) return null;
    const code = readString(result.code)
      ?? (status === 'outcomeUnknown' ? 'session_input_outcome_unknown' : `session_input_${status}`);
    const localId = readString(result.localId);
    const detail = readRecord(result.errorDetail);
    const missingDirectory = status === 'failed' && code === 'resume_failed'
      && detail.kind === 'launch_error' && detail.code === SPAWN_SESSION_ERROR_CODES.SESSION_DIRECTORY_MISSING;
    return {
      errorCode: code,
      errorMessage: missingDirectory
        ? `Message accepted. The Session folder is missing (${detail.code}). Use Re-queue to restore the retained message from Not sent.`
        : `${UNDELIVERED_SEND_MESSAGES[status]} (${code}).`,
      details: { status, ...(localId ? { localId } : {}),
        ...(result.admissionResult !== undefined ? { admissionResult: result.admissionResult } : {}),
        ...(result.errorDetail !== undefined ? { errorDetail: result.errorDetail } : {}) },
    };
  },
  presentSuccess: async (payload, context) => {
    const result = readRecord(payload);
    const runId = readRunId(context.input);
    const sessionId = typeof context.input.sessionId === 'string'
      ? context.input.sessionId
      : null;
    const replied = result.status === 'replied';
    const waited = replied && context.input.reply === 'wait';
    if (context.json) {
      const legacyFields = isRunSendSpelling(context)
        ? { sessionId, runId, sent: true }
        : { sessionId, localId: result.localId, waited };
      await printJsonEnvelope({
        ok: true,
        kind: isRunSendSpelling(context) ? 'session_run_send' : 'session_send',
        data: replied ? { ...result, ...legacyFields } : legacyFields,
      });
      return true;
    }
    // The localId is this message's stable identity. Printing it lets a human
    // retry `--local-id <id>` after an ambiguous failure and rejoin the same
    // durable input instead of queueing a second message.
    const localId = typeof result.localId === 'string' && result.localId.length > 0
      ? result.localId
      : null;
    console.log(ok(localId ? `Message sent (local id ${localId})` : 'Message sent'));
    if (replied) {
      const outcome = readRecord(result.outcome);
      const text = readString(outcome.text) ?? readString(outcome.partialText);
      if (outcome.kind !== 'answer' || text === null) console.log(`Reply outcome: ${outcome.kind}`);
      if (text !== null) console.log(text);
    }
    return true;
  },
  failureFields: (failure, context) => {
    const localId = readLocalId(context.input);
    const outcome = readClassifiedSendOutcome(failure);
    // `session run send` released a `sent` field: a proven-undelivered outcome
    // states it, while an unknown outcome stays silent rather than guessing.
    const sent = isRunSendSpelling(context) && outcome && outcome.status !== 'outcomeUnknown'
      ? { sent: false }
      : {};
    const fields = { ...(localId ? { localId } : {}), ...sent };
    return Object.keys(fields).length > 0 ? fields : null;
  },
  describeFailure: (failure, context) => {
    const outcome = readClassifiedSendOutcome(failure);
    // Rejoining the same durable input only helps while its outcome is still
    // unknown; a refusal, failure or cancellation is settled.
    if (outcome && outcome.status !== 'outcomeUnknown') return null;
    const localId = outcome?.localId ?? readLocalId(context.input);
    return localId
      ? `Retry with --local-id ${localId} to rejoin this exact input.`
      : null;
  },
};
