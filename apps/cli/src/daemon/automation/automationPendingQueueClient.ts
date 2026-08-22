import type { StoredCredentials } from '@/persistence';
import { discardPendingQueueV2Messages } from '@/api/session/pendingQueueV2Transport';
import { sendSessionMessage } from '@/session/services/sendSessionMessage';
import {
  buildAutomationSessionInputAdmissionV1,
  deriveAutomationSessionInputLocalIdV1,
} from '@/session/services/sessionInputAdmissionIdentity';
import {
  HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1,
  type MentionRefV1,
  type SessionInputAdmissionResultV1,
} from '@happier-dev/protocol';

/**
 * Automation is a non-interactive producer. It delegates the complete
 * request-envelope, encryption, equality-evidence, and authenticated-machine
 * admission path to the canonical Session Message sender. This leaf owns only
 * Automation's run facts and the stable local identity.
 */
export async function enqueueAutomationPrompt(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  automationId: string;
  runId: string;
  prompt: string;
  displayText?: string;
  /**
   * The composer references the frozen template carried, already admitted
   * against this exact rendered prompt by the Protocol materializer. They are
   * handed to the canonical Session sender in the one structured-input
   * envelope an interactive send uses, so provider context is still
   * reconstructed at dispatch rather than frozen here.
   */
  mentions?: readonly MentionRefV1[];
  signal?: AbortSignal;
  machineAdmissionTransport: NonNullable<Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']>;
}>): Promise<SessionInputAdmissionResultV1> {
  const prompt = params.prompt.trim();
  if (!prompt) return { status: 'rejected', code: 'session_input_invalid' };

  const localId = deriveAutomationSessionInputLocalIdV1({
    automationId: params.automationId,
    runId: params.runId,
  });
  const inputAdmission = buildAutomationSessionInputAdmissionV1({
    automationId: params.automationId,
    runId: params.runId,
  });
  const displayText = typeof params.displayText === 'string' && params.displayText.trim().length > 0
    ? params.displayText
    : undefined;
  const mentions = params.mentions ?? [];
  const messageMeta = {
    ...(displayText ? { displayText } : {}),
    ...(mentions.length > 0
      ? { [HAPPIER_STRUCTURED_INPUT_METADATA_KEY_V1]: { v: 1, mentions: [...mentions] } }
      : {}),
  };
  const result = await sendSessionMessage({
    credentials: params.credentials,
    idOrPrefix: params.sessionId,
    message: prompt,
    wait: false,
    timeoutMs: 30_000,
    localId,
    requestedAction: { v: 1, kind: 'enqueue' },
    ...(Object.keys(messageMeta).length > 0 ? { messageMeta } : {}),
    inputAdmission,
    machineAdmissionTransport: params.machineAdmissionTransport,
    ...(params.signal ? { signal: params.signal } : {}),
  });

  return result.admissionResult;
}

/**
 * Authoritative Automation Run cancellation retires only its stable input.
 * Generic worker/lease/attempt aborts must never call this function.
 */
export async function discardAutomationPromptAfterRunCancellation(params: Readonly<{
  token: string;
  sessionId: string;
  automationId: string;
  runId: string;
}>): Promise<void> {
  const localId = deriveAutomationSessionInputLocalIdV1({
    automationId: params.automationId,
    runId: params.runId,
  });
  await discardPendingQueueV2Messages({
    token: params.token,
    sessionId: params.sessionId,
    localIds: [localId],
    reason: 'session_input_cancelled',
  });
}
