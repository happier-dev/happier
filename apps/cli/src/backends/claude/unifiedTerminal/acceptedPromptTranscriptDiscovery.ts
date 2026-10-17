import type { RawJSONLines } from '../types';
import { parseClaudeQueuedCommandAttachment } from '../attachments/claudeAttachmentTypes';
import {
  readClaudeControlCommandRowShape,
  resolveClaudeControlCommandCompletionOwner,
  type ClaudeControlCommandCompletionOwner,
} from '../utils/controlCommandRows';
import { parseRawJsonLinesObject } from '../utils/parseRawJsonLines';
import { readClaudeTaskLifecycleEnvelope } from '../taskNotifications/claudeTaskLifecycleEnvelope';
import { normalizeClaudeUnifiedPromptIdentityText } from './promptIdentity';
import { readPendingLocalId } from '@happier-dev/protocol';

type AcceptedPrompt = Readonly<{
  id: string;
  text: string;
  normalizedText: string;
  deliveryIdentity: ClaudeUnifiedAcceptedPromptDeliveryIdentity | null;
  acceptedAtMs: number;
  expiresAtMs: number | null;
  registrationOrder: number;
  suppressTranscriptEcho: boolean;
}>;

type AcceptedPromptHookEcho = Readonly<{
  deliveryIdentity: ClaudeUnifiedAcceptedPromptDeliveryIdentity;
  promptId: string;
  sessionId: string;
}>;

type IndependentControlCommand = {
  id: string;
  normalizedText: string;
  submittedAtMs: number;
  expiresAtMs: number;
  registrationOrder: number;
  disposition: ClaudeUnifiedIndependentControlSubmissionDisposition;
};

export type ClaudeUnifiedIndependentControlSubmissionDisposition =
  | 'pending'
  | 'sent'
  | 'ambiguous';

export type ClaudeUnifiedIndependentControlSubmissionResolution = Readonly<{
  submissionId: string;
  disposition: Exclude<ClaudeUnifiedIndependentControlSubmissionDisposition, 'pending'> | 'not_sent';
}>;

type ControlCommandOrigin =
  | Readonly<{ kind: 'attempt'; acceptedPromptId: string }>
  | Readonly<{ kind: 'independent_control'; controlCommandId: string }>
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'ambiguous' }>;

type ControlCommandBinding = {
  transcriptKey: string;
  commandUuid: string | null;
  promptId: string | null;
  commandText: string;
  commandKind: 'command' | 'shell_command';
  transcriptTimestampMs: number | null;
  observedAtMs: number;
  expiresAtMs: number;
  completionOwner: ClaudeControlCommandCompletionOwner;
  origin: ControlCommandOrigin;
  attemptDeliveryIdentity: ClaudeUnifiedAcceptedPromptDeliveryIdentity | null;
  acceptedConfirmed: boolean;
  stdoutObserved: boolean;
  completionEmitted: boolean;
};

type NativeQueuedCommandOperation = Readonly<{
  content: string;
  operation: 'enqueue' | 'remove';
  sessionId: string;
  timestamp: string;
  timestampMs: number;
}>;

type NativeQueuedCommandConsumption = Readonly<{
  prompt: string;
  sessionId: string;
  transcriptKey: string;
  transcriptTimestampMs: number;
  transcriptUuid: string;
}>;

type NativeQueuedCommandCustody = {
  acceptedPromptId: string;
  content: string;
  enqueuedAtMs: number;
  episodeOrder: number;
  removedAtMs: number | null;
  sessionId: string;
};

export type ClaudeUnifiedAcceptedPromptDeliveryIdentity = Readonly<{
  localIds?: readonly string[] | undefined;
  userMessageSeq?: number | null | undefined;
  userMessageSeqs?: readonly number[] | undefined;
}>;

export type ClaudeUnifiedAcceptedPromptTranscriptMatch = Readonly<{
  acceptedPromptId: string;
  acceptedPromptNormalizedText: string;
  deliveryIdentity: ClaudeUnifiedAcceptedPromptDeliveryIdentity | null;
  transcriptUuid: string | null;
  transcriptPromptId: string | null;
  transcriptTimestampMs: number | null;
  matchKind: 'exact' | 'command_name';
  transcriptKey: string | null;
  suppressTranscriptEcho: boolean;
}>;

export type ClaudeUnifiedAcceptedPromptTranscriptDiscovery = Readonly<{
  recordAcceptedPrompt(input: Readonly<{
    message: string;
    acceptedAtMs?: number | undefined;
    deliveryIdentity?: ClaudeUnifiedAcceptedPromptDeliveryIdentity | null | undefined;
    suppressTranscriptEcho?: boolean | undefined;
  }>): string | null;
  recordAcceptedPromptHookEcho(input: Readonly<{
    deliveryIdentity: ClaudeUnifiedAcceptedPromptDeliveryIdentity;
    promptId: string;
    sessionId: string;
  }>): boolean;
  reserveAcceptedPromptTranscriptEcho(match: ClaudeUnifiedAcceptedPromptTranscriptMatch): boolean;
  consumeAcceptedPromptTranscriptEcho(message: RawJSONLines): boolean;
  recordIndependentControlCommand(input: Readonly<{
    message: string;
    submittedAtMs?: number | undefined;
  }>): string | null;
  recordIndependentControlCommandDisposition(
    input: ClaudeUnifiedIndependentControlSubmissionResolution,
  ): boolean;
  observeControlCommandTranscript(value: unknown): boolean;
  consumeAcceptedPromptByBatch(input: Readonly<{
    message: string;
    maxUserMessageSeq?: number | null | undefined;
    userMessageLocalIds?: readonly string[] | null | undefined;
  }>): boolean;
  forgetRetiredPromptByBatch(input: Parameters<ClaudeUnifiedAcceptedPromptTranscriptDiscovery['consumeAcceptedPromptByBatch']>[0]): boolean;
  findMatchingTranscript(messages: readonly unknown[]): ClaudeUnifiedAcceptedPromptTranscriptMatch | null;
  consumeAcceptedPromptMatch(match: ClaudeUnifiedAcceptedPromptTranscriptMatch): boolean;
  claimMatchingTranscript(messages: readonly unknown[]): ClaudeUnifiedAcceptedPromptTranscriptMatch | null;
  consumeMatchingTranscript(messages: readonly unknown[]): boolean;
}>;

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readMessageTimestampMs(message: unknown): number | null {
  const raw = (message as Record<string, unknown>).timestamp;
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function readCommandNamePromptText(content: string): string | null {
  const match = content.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/);
  const commandName = match?.[1]?.trim();
  return commandName && commandName.startsWith('/') ? commandName : null;
}

function readContentTextParts(content: unknown): readonly string[] {
  if (typeof content === 'string') return content.length > 0 ? [content] : [];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part.length > 0) parts.push(part);
      continue;
    }
    const record = readObject(part);
    const text = record?.text;
    if (typeof text === 'string' && text.length > 0) {
      parts.push(text);
    }
  }
  return parts;
}

function expandPromptText(contentText: string): readonly string[] {
  const commandName = readCommandNamePromptText(contentText);
  return commandName ? [contentText, commandName] : [contentText];
}

function readUserPromptTexts(message: RawJSONLines): readonly string[] {
  if (message.type !== 'user') return [];
  if (readObject((message as Record<string, unknown>).origin)?.kind === 'peer') return [];
  if (readClaudeTaskLifecycleEnvelope(message)?.subtype === 'task_notification') return [];
  if ((message as Record<string, unknown>).isMeta === true) return [];
  const content = message.message?.content;
  const textParts = readContentTextParts(content);
  if (textParts.length === 0) return [];
  const joinedText = textParts.length > 1 ? textParts.join('') : null;
  const candidates = joinedText && !textParts.includes(joinedText)
    ? [joinedText, ...textParts]
    : textParts;
  return candidates.flatMap(expandPromptText);
}

function readPromptTexts(message: unknown): readonly string[] {
  const record = readObject(message);
  if (!record) return [];
  if (record.isSidechain === true) return [];
  if (record.type === 'user') return readUserPromptTexts(record as RawJSONLines);
  return [];
}

function readNativeQueuedCommandOperation(value: unknown): NativeQueuedCommandOperation | null {
  const record = readObject(value);
  if (!record || record.type !== 'queue-operation') return null;
  const operation = record.operation;
  if (operation !== 'enqueue' && operation !== 'remove') return null;
  const content = readNonEmptyString(record.content);
  const sessionId = readNonEmptyString(record.sessionId);
  const timestamp = readNonEmptyString(record.timestamp);
  if (!content || !sessionId || sessionId.trim().length === 0 || !timestamp) return null;
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) return null;
  return { content, operation, sessionId, timestamp, timestampMs };
}

function readNativeQueuedCommandConsumption(value: unknown): NativeQueuedCommandConsumption | null {
  const record = readObject(value);
  if (!record || record.type !== 'attachment' || record.isSidechain !== false) return null;
  const command = parseClaudeQueuedCommandAttachment(record);
  if (!command) return null;
  const attachment = readObject(record.attachment);
  const origin = readObject(attachment?.origin);
  const sessionId = readNonEmptyString(record.sessionId);
  const transcriptUuid = readNonEmptyString(record.uuid);
  const parentUuid = readNonEmptyString(record.parentUuid);
  const timestamp = readNonEmptyString(record.timestamp);
  if (
    !sessionId
    || sessionId.trim().length === 0
    || !transcriptUuid
    || !parentUuid
    || !timestamp
    || attachment?.commandMode !== 'prompt'
    || origin?.kind !== 'human'
  ) return null;
  const transcriptTimestampMs = Date.parse(timestamp);
  if (!Number.isFinite(transcriptTimestampMs)) return null;
  return {
    prompt: command.prompt,
    sessionId,
    transcriptKey: `uuid:${transcriptUuid}`,
    transcriptTimestampMs,
    transcriptUuid,
  };
}

function promptTextsMatch(transcriptText: string, acceptedPrompt: AcceptedPrompt): boolean {
  const normalizedTranscriptText = normalizeClaudeUnifiedPromptIdentityText(transcriptText);
  if (normalizedTranscriptText === acceptedPrompt.normalizedText) return true;
  return normalizedTranscriptText.startsWith('/')
    && acceptedPrompt.normalizedText.startsWith(`${normalizedTranscriptText} `);
}

function isCommandNameOnlyFallbackMatch(transcriptText: string, acceptedPrompt: AcceptedPrompt): boolean {
  const normalizedTranscriptText = normalizeClaudeUnifiedPromptIdentityText(transcriptText);
  return normalizedTranscriptText.startsWith('/')
    && normalizedTranscriptText !== acceptedPrompt.normalizedText
    && acceptedPrompt.normalizedText.startsWith(`${normalizedTranscriptText} `);
}

function cloneDeliveryIdentity(
  value: ClaudeUnifiedAcceptedPromptDeliveryIdentity | null | undefined,
): ClaudeUnifiedAcceptedPromptDeliveryIdentity | null {
  if (!value) return null;
  return {
    ...(value.localIds ? { localIds: [...value.localIds] } : {}),
    ...(typeof value.userMessageSeq === 'number' || value.userMessageSeq === null
      ? { userMessageSeq: value.userMessageSeq }
      : {}),
    ...(value.userMessageSeqs ? { userMessageSeqs: [...value.userMessageSeqs] } : {}),
  };
}

function buildTranscriptKey(params: Readonly<{
  record: Record<string, unknown> | null;
  message: unknown;
  texts: readonly string[];
}>): string | null {
  const uuid = readNonEmptyString(params.record?.uuid);
  if (uuid) return `uuid:${uuid}`;
  const promptId = readNonEmptyString(params.record?.promptId);
  if (promptId) return `prompt:${promptId}`;
  const timestampMs = readMessageTimestampMs(params.message);
  if (timestampMs === null) return null;
  const normalizedTexts = params.texts
    .map((text) => normalizeClaudeUnifiedPromptIdentityText(text))
    .filter((text) => text.length > 0);
  return normalizedTexts.length > 0
    ? `ts:${timestampMs}:text:${normalizedTexts.join('\u0000')}`
    : `ts:${timestampMs}`;
}

function readValidSeqs(value: ClaudeUnifiedAcceptedPromptDeliveryIdentity | null | undefined): Set<number> {
  const seqs = new Set<number>();
  const userMessageSeq = value?.userMessageSeq;
  if (typeof userMessageSeq === 'number' && Number.isInteger(userMessageSeq) && userMessageSeq >= 0) {
    seqs.add(userMessageSeq);
  }
  for (const seq of value?.userMessageSeqs ?? []) {
    if (Number.isInteger(seq) && seq >= 0) {
      seqs.add(seq);
    }
  }
  return seqs;
}

function readValidLocalIds(value: ClaudeUnifiedAcceptedPromptDeliveryIdentity | null | undefined): Set<string> {
  const localIds = new Set<string>();
  for (const localId of value?.localIds ?? []) {
    const parsedLocalId = readPendingLocalId(localId);
    if (parsedLocalId !== null) localIds.add(parsedLocalId);
  }
  return localIds;
}

function doesBatchMatchDeliveryIdentity(
  acceptedPrompt: AcceptedPrompt,
  batch: Readonly<{
    maxUserMessageSeq?: number | null | undefined;
    userMessageLocalIds?: readonly string[] | null | undefined;
  }>,
): boolean {
  const seqs = readValidSeqs(acceptedPrompt.deliveryIdentity);
  const localIds = readValidLocalIds(acceptedPrompt.deliveryIdentity);
  const hasDeliveryIdentity = seqs.size > 0 || localIds.size > 0;
  if (!hasDeliveryIdentity) return false;

  const batchSeq = batch.maxUserMessageSeq;
  if (typeof batchSeq === 'number' && seqs.has(batchSeq)) return true;
  return (batch.userMessageLocalIds ?? []).some((localId) => (
    readPendingLocalId(localId) !== null && localIds.has(localId)
  ));
}

export function createClaudeUnifiedAcceptedPromptTranscriptDiscovery(opts: Readonly<{
  acceptedPromptWindowMs: number;
  nowMs?: (() => number) | undefined;
  onControlCommandConsumed?: ((message: RawJSONLines) => void) | undefined;
  onAttemptLocalCommandCompleted?: ((input: Readonly<{
    acceptedPromptId: string;
    deliveryIdentity: ClaudeUnifiedAcceptedPromptDeliveryIdentity | null;
  }>) => void | Promise<void>) | undefined;
}>): ClaudeUnifiedAcceptedPromptTranscriptDiscovery {
  const acceptedPrompts: AcceptedPrompt[] = [];
  const independentControlCommands: IndependentControlCommand[] = [];
  const controlCommandBindings = new Map<string, ControlCommandBinding>();
  // Native no-query shell episodes explicitly precede the input with a meta caveat.
  // Its UUID is the input's parentUuid (Claude Code 2.1.302); output alone cannot
  // establish completion because ordinary shell commands may continue into inference.
  const localCommandCaveats = new Map<string, number>();
  const nowMs = opts.nowMs ?? Date.now;
  const acceptedPromptWindowMs = Math.max(100, Math.trunc(opts.acceptedPromptWindowMs));
  const controlCommandBindingRetentionMs = acceptedPromptWindowMs * 2;
  // Durable Pending attempts do not expire. Keep closed evidence for this discovery's lifetime
  // so an old row cannot settle another attempt after a clock window or manual retirement.
  const closedTranscriptEvidence = new Set<string>();
  const acceptedPromptHookEchoes = new Map<string, AcceptedPromptHookEcho>();
  const reservedTranscriptEchoKeys = new Set<string>();
  const nativeQueuedCommandCustody: NativeQueuedCommandCustody[] = [];
  let nextAcceptedPromptId = 1;
  let nextIndependentControlCommandId = 1;
  let nextNativeQueuedCommandEpisodeOrder = 1;
  let nextRegistrationOrder = 1;

  function buildHookEchoKey(sessionId: string, promptId: string): string {
    return JSON.stringify([sessionId, promptId]);
  }

  function pruneExpired(referenceMs: number): void {
    for (let index = acceptedPrompts.length - 1; index >= 0; index -= 1) {
      const expiresAtMs = acceptedPrompts[index]?.expiresAtMs;
      if (expiresAtMs !== null && expiresAtMs !== undefined && expiresAtMs < referenceMs) {
        acceptedPrompts.splice(index, 1);
      }
    }
    // Related retry registrations share an episode horizon, so extending an older registration can
    // make expiry order differ from insertion order. Prune each entry independently while retaining
    // array order for FIFO ownership among the registrations that remain live.
    for (let index = independentControlCommands.length - 1; index >= 0; index -= 1) {
      if ((independentControlCommands[index]?.expiresAtMs ?? referenceMs) < referenceMs) {
        independentControlCommands.splice(index, 1);
      }
    }
    const liveAcceptedPromptIds = new Set(acceptedPrompts.map((prompt) => prompt.id));
    for (const [key, binding] of controlCommandBindings) {
      // Echo retention cannot retire the completion evidence for an ongoing local
      // command. Provider acceptance removes its prompt registration before stdout
      // necessarily arrives; its binding remains authoritative until completion.
      const awaitingAttemptLocalCompletion = binding.origin.kind === 'attempt'
        && binding.completionOwner === 'local_stdout'
        && !binding.completionEmitted
        && (binding.acceptedConfirmed || liveAcceptedPromptIds.has(binding.origin.acceptedPromptId));
      if (binding.expiresAtMs < referenceMs && !awaitingAttemptLocalCompletion) controlCommandBindings.delete(key);
    }
    for (const [uuid, expiresAtMs] of localCommandCaveats) {
      if (expiresAtMs < referenceMs) localCommandCaveats.delete(uuid);
    }
    for (let index = nativeQueuedCommandCustody.length - 1; index >= 0; index -= 1) {
      const custody = nativeQueuedCommandCustody[index];
      if (!custody) continue;
      if (!liveAcceptedPromptIds.has(custody.acceptedPromptId)) {
        nativeQueuedCommandCustody.splice(index, 1);
      }
    }
  }

  function readTranscriptIdentity(message: RawJSONLines): Readonly<{
    transcriptKey: string;
    uuid: string | null;
    promptId: string | null;
  }> {
    const record = message as Record<string, unknown>;
    const uuid = readNonEmptyString(record.uuid);
    const promptId = readNonEmptyString(record.promptId);
    const timestampMs = readMessageTimestampMs(message);
    return {
      transcriptKey: uuid
        ? `uuid:${uuid}`
        : promptId
          ? `prompt:${promptId}`
          : timestampMs === null
            ? `unkeyed:${JSON.stringify(message)}`
            : `ts:${timestampMs}`,
      uuid,
      promptId,
    };
  }

  function consumeAcceptedPromptTranscriptEcho(message: RawJSONLines): boolean {
    const record = message as Record<string, unknown>;
    if (record.isSidechain === true || record.type !== 'user') return false;
    const identity = readTranscriptIdentity(message);
    if (reservedTranscriptEchoKeys.delete(identity.transcriptKey)) return true;
    const sessionId = readNonEmptyString(record.sessionId);
    if (!sessionId || sessionId.trim().length === 0 || !identity.promptId) return false;
    const consumed = acceptedPromptHookEchoes.delete(buildHookEchoKey(sessionId, identity.promptId));
    if (consumed) closeTranscriptEvidence(identity.transcriptKey);
    return consumed;
  }

  function maybeEmitAttemptLocalCommandCompletion(binding: ControlCommandBinding): void {
    if (
      binding.completionEmitted
      || !binding.acceptedConfirmed
      || !binding.stdoutObserved
      || binding.origin.kind !== 'attempt'
      || binding.completionOwner !== 'local_stdout'
    ) return;
    binding.completionEmitted = true;
    try {
      const completion = opts.onAttemptLocalCommandCompleted?.({
        acceptedPromptId: binding.origin.acceptedPromptId,
        deliveryIdentity: cloneDeliveryIdentity(binding.attemptDeliveryIdentity),
      });
      if (completion) void Promise.resolve(completion).catch(() => undefined);
    } catch {
      // Lifecycle effects are best-effort at this provider-local observation boundary. The
      // canonical binding owns surfacing/retry; transcript parsing must remain deterministic.
    }
  }

  function commandTextMatchesRegisteredText(commandText: string, registeredText: string): boolean {
    const normalizedCommand = normalizeClaudeUnifiedPromptIdentityText(commandText);
    if (normalizedCommand === registeredText) return true;
    return normalizedCommand.startsWith('/') && registeredText.startsWith(`${normalizedCommand} `);
  }

  function controlRegistrationsMayShareTranscriptEvidence(
    leftNormalizedText: string,
    rightNormalizedText: string,
  ): boolean {
    if (leftNormalizedText === rightNormalizedText) return true;
    const leftCommandName = leftNormalizedText.match(/^\/[^\s]+/u)?.[0] ?? null;
    const rightCommandName = rightNormalizedText.match(/^\/[^\s]+/u)?.[0] ?? null;
    // Claude can omit command arguments in its JSONL echo. Registrations for the same slash command
    // therefore share one provenance episode even when their requested arguments differ.
    return leftCommandName !== null && leftCommandName === rightCommandName;
  }

  function resolveControlCommandOrigin(
    commandText: string,
    transcriptTimestampMs: number | null,
    observedAtMs: number,
  ): ControlCommandOrigin {
    pruneExpired(observedAtMs);
    // A timestamp-less control row has no causal position relative to either a pre-Enter control
    // fence or a durable attempt. It may be historical snapshot replay, so it is born permanently
    // ambiguous rather than `unknown` (which is intentionally eligible for early durable rebind).
    if (transcriptTimestampMs === null) return { kind: 'ambiguous' };
    type OriginCandidate = Readonly<{ origin: ControlCommandOrigin; order: number; exact: boolean }>;
    const independentCandidates: OriginCandidate[] = [];
    const normalizedCommand = normalizeClaudeUnifiedPromptIdentityText(commandText);
    let hasFencedIndependentMatch = false;
    for (const control of independentControlCommands) {
      if (!commandTextMatchesRegisteredText(commandText, control.normalizedText)) continue;
      // The registration is created at the verified pre-Enter boundary. Missing, older, or
      // equal-millisecond evidence cannot prove that this row followed Enter. Keep the row
      // permanently non-attributable without consuming the registration, so the actual later row
      // can still bind to the independent control and neither row can migrate to a durable attempt.
      if (transcriptTimestampMs <= control.submittedAtMs) {
        hasFencedIndependentMatch = true;
        continue;
      }
      independentCandidates.push({
        origin: { kind: 'independent_control', controlCommandId: control.id },
        order: control.registrationOrder,
        exact: normalizedCommand === control.normalizedText,
      });
    }

    // A strictly post-fence controller command is the strongest available origin evidence. Keep
    // independent controls in their own FIFO domain instead of comparing their registration order
    // with durable attempts: an older identical attempt must never steal controller-owned evidence.
    const exactIndependentCandidates = independentCandidates.filter((candidate) => candidate.exact);
    const eligibleIndependentCandidates = exactIndependentCandidates.length > 0
      ? exactIndependentCandidates
      : independentCandidates;
    if (eligibleIndependentCandidates.length > 0) {
      if (
        eligibleIndependentCandidates.length > 1
        && !eligibleIndependentCandidates.every((candidate) => candidate.exact)
      ) {
        return { kind: 'ambiguous' };
      }
      return [...eligibleIndependentCandidates].sort((a, b) => a.order - b.order)[0]?.origin
        ?? { kind: 'unknown' };
    }
    // Missing, older or equal-millisecond evidence cannot cross the pre-Enter provenance fence,
    // even when an older durable attempt has identical text.
    if (hasFencedIndependentMatch) return { kind: 'ambiguous' };

    const attemptCandidates: OriginCandidate[] = [];
    for (const acceptedPrompt of acceptedPrompts) {
      if (
        observedAtMs < acceptedPrompt.acceptedAtMs - acceptedPromptWindowMs
        || (acceptedPrompt.expiresAtMs !== null && observedAtMs > acceptedPrompt.expiresAtMs)
      ) continue;
      if (!commandTextMatchesRegisteredText(commandText, acceptedPrompt.normalizedText)) continue;
      attemptCandidates.push({
        origin: { kind: 'attempt', acceptedPromptId: acceptedPrompt.id },
        order: acceptedPrompt.registrationOrder,
        exact: normalizedCommand === acceptedPrompt.normalizedText,
      });
    }
    const exactCandidates = attemptCandidates.filter((candidate) => candidate.exact);
    const eligibleCandidates = exactCandidates.length > 0 ? exactCandidates : attemptCandidates;
    return eligibleCandidates.length === 0
      ? { kind: 'unknown' } as const
      : eligibleCandidates.length > 1 && !eligibleCandidates.every((candidate) => candidate.exact)
        ? { kind: 'ambiguous' } as const
        : [...eligibleCandidates].sort((a, b) => a.order - b.order)[0]?.origin ?? { kind: 'unknown' } as const;
  }

  function applyResolvedControlCommandOrigin(
    binding: ControlCommandBinding,
    origin: ControlCommandOrigin,
  ): void {
    binding.origin = origin;
    if (origin.kind === 'independent_control') {
      const index = independentControlCommands.findIndex((candidate) => candidate.id === origin.controlCommandId);
      if (index >= 0) independentControlCommands.splice(index, 1);
    }
    binding.attemptDeliveryIdentity = origin.kind === 'attempt'
      ? cloneDeliveryIdentity(acceptedPrompts.find((candidate) => candidate.id === origin.acceptedPromptId)?.deliveryIdentity)
      : null;
  }

  function bindControlCommandRow(message: RawJSONLines): ControlCommandBinding {
    const identity = readTranscriptIdentity(message);
    const existing = controlCommandBindings.get(identity.transcriptKey);
    if (existing) {
      if (existing.origin.kind === 'unknown') {
        applyResolvedControlCommandOrigin(
          existing,
          resolveControlCommandOrigin(
            existing.commandText,
            existing.transcriptTimestampMs,
            existing.observedAtMs,
          ),
        );
      }
      return existing;
    }
    const shape = readClaudeControlCommandRowShape(message);
    if (!shape || (shape.kind !== 'command' && shape.kind !== 'shell_command')) {
      throw new Error('bindControlCommandRow requires a command row');
    }
    const commandText = shape.kind === 'shell_command'
      ? shape.command
      : `${shape.name}${shape.args.length > 0 ? ` ${shape.args}` : ''}`;
    const transcriptTimestampMs = readMessageTimestampMs(message);
    const observedAtMs = transcriptTimestampMs ?? nowMs();
    const binding: ControlCommandBinding = {
      transcriptKey: identity.transcriptKey,
      commandUuid: identity.uuid,
      promptId: identity.promptId,
      commandText,
      commandKind: shape.kind,
      transcriptTimestampMs,
      observedAtMs,
      expiresAtMs: observedAtMs + controlCommandBindingRetentionMs,
      completionOwner: shape.kind === 'shell_command'
        ? localCommandCaveats.has(readNonEmptyString((message as Record<string, unknown>).parentUuid) ?? '')
          ? 'local_stdout'
          : 'external_lifecycle'
        : resolveClaudeControlCommandCompletionOwner(shape.name),
      origin: { kind: 'unknown' },
      attemptDeliveryIdentity: null,
      acceptedConfirmed: false,
      stdoutObserved: false,
      completionEmitted: false,
    };
    applyResolvedControlCommandOrigin(
      binding,
      resolveControlCommandOrigin(commandText, transcriptTimestampMs, observedAtMs),
    );
    controlCommandBindings.set(identity.transcriptKey, binding);
    return binding;
  }

  function observeControlCommandTranscript(value: unknown): boolean {
    const message = parseRawJsonLinesObject(value);
    if (!message) return false;
    if (message.isSidechain === true || readObject((message as Record<string, unknown>).origin)?.kind === 'peer') return false;
    const shape = readClaudeControlCommandRowShape(message);
    if (!shape) return false;
    pruneExpired(nowMs());
    const identity = readTranscriptIdentity(message);
    if (shape.kind === 'local_caveat') {
      if (identity.uuid) {
        localCommandCaveats.set(identity.uuid, (readMessageTimestampMs(message) ?? nowMs()) + controlCommandBindingRetentionMs);
      }
      return true;
    }
    // Shell input/output remain visible; only slash-control bookkeeping is consumed.
    if (shape.kind === 'command' || shape.kind === 'stdout') opts.onControlCommandConsumed?.(message);
    if (shape.kind === 'command' || shape.kind === 'shell_command') {
      bindControlCommandRow(message);
      return true;
    }
    const record = message as Record<string, unknown>;
    const parentUuid = readNonEmptyString(record.parentUuid);
    const matchingBindings = [...controlCommandBindings.values()].filter((binding) => (
      binding.commandKind === (shape.kind === 'shell_output' ? 'shell_command' : 'command')
      && (shape.kind === 'shell_output'
        ? parentUuid !== null && binding.commandUuid === parentUuid
        : (parentUuid !== null && binding.commandUuid === parentUuid)
          || (identity.promptId !== null && binding.promptId === identity.promptId))
    ));
    if (matchingBindings.length === 1) {
      const binding = matchingBindings[0];
      if (binding) {
        binding.stdoutObserved = true;
        maybeEmitAttemptLocalCommandCompletion(binding);
      }
    }
    return true;
  }

  function matchesPromptWindow(message: unknown, acceptedPrompt: AcceptedPrompt): boolean {
    const timestampMs = readMessageTimestampMs(message);
    if (timestampMs === null) {
      return acceptedPrompt.expiresAtMs === null || nowMs() <= acceptedPrompt.expiresAtMs;
    }
    return timestampMs >= acceptedPrompt.acceptedAtMs - acceptedPromptWindowMs
      && (acceptedPrompt.expiresAtMs === null || timestampMs <= acceptedPrompt.expiresAtMs);
  }

  function findAcceptedPromptForNativeQueueEnqueue(
    operation: NativeQueuedCommandOperation,
  ): AcceptedPrompt | null {
    const normalizedContent = normalizeClaudeUnifiedPromptIdentityText(operation.content);
    const assignedAcceptedPromptIds = new Set(
      nativeQueuedCommandCustody.map((custody) => custody.acceptedPromptId),
    );
    const matchingPrompts = acceptedPrompts.filter((acceptedPrompt) => (
      acceptedPrompt.normalizedText === normalizedContent
      && !assignedAcceptedPromptIds.has(acceptedPrompt.id)
    ));
    // Native queue evidence carries prompt text, not a Pending identity. Bind only a unique
    // unassigned attempt; an ambiguous predecessor must not steal a replacement's evidence.
    return matchingPrompts.length === 1 ? matchingPrompts[0] ?? null : null;
  }

  function observeNativeQueuedCommandOperation(operation: NativeQueuedCommandOperation): void {
    if (operation.operation === 'enqueue') {
      const acceptedPrompt = findAcceptedPromptForNativeQueueEnqueue(operation);
      if (!acceptedPrompt) return;
      nativeQueuedCommandCustody.push({
        acceptedPromptId: acceptedPrompt.id,
        content: operation.content,
        enqueuedAtMs: operation.timestampMs,
        episodeOrder: nextNativeQueuedCommandEpisodeOrder++,
        removedAtMs: null,
        sessionId: operation.sessionId,
      });
      return;
    }

    const candidate = nativeQueuedCommandCustody
      .filter((custody) => (
        custody.removedAtMs === null
        && custody.sessionId === operation.sessionId
        && custody.content === operation.content
      ))
      .sort((left, right) => left.episodeOrder - right.episodeOrder)[0];
    if (!candidate) return;
    candidate.removedAtMs = operation.timestampMs;
  }

  function closeTranscriptEvidence(transcriptKey: string | null): void {
    if (transcriptKey) closedTranscriptEvidence.add(transcriptKey);
  }

  function findNativeQueuedCommandConsumptionMatch(
    message: unknown,
  ): ClaudeUnifiedAcceptedPromptTranscriptMatch | null {
    const consumption = readNativeQueuedCommandConsumption(message);
    if (!consumption || closedTranscriptEvidence.has(consumption.transcriptKey)) return null;
    const custody = nativeQueuedCommandCustody
      .filter((candidate) => (
        candidate.removedAtMs !== null
        && candidate.sessionId === consumption.sessionId
        && candidate.content === consumption.prompt
      ))
      .sort((left, right) => left.episodeOrder - right.episodeOrder)[0];
    if (!custody) {
      const candidates = acceptedPrompts.filter((candidate) => (
        candidate.normalizedText === normalizeClaudeUnifiedPromptIdentityText(consumption.prompt)
      ));
      if (candidates.length > 1) closeTranscriptEvidence(consumption.transcriptKey);
      return null;
    }
    const acceptedPrompt = acceptedPrompts.find((candidate) => candidate.id === custody.acceptedPromptId);
    if (
      !acceptedPrompt
      || normalizeClaudeUnifiedPromptIdentityText(consumption.prompt) !== acceptedPrompt.normalizedText
    ) return null;
    return {
      acceptedPromptId: acceptedPrompt.id,
      acceptedPromptNormalizedText: acceptedPrompt.normalizedText,
      deliveryIdentity: cloneDeliveryIdentity(acceptedPrompt.deliveryIdentity),
      transcriptUuid: consumption.transcriptUuid,
      transcriptPromptId: null,
      transcriptTimestampMs: consumption.transcriptTimestampMs,
      matchKind: 'exact',
      transcriptKey: consumption.transcriptKey,
      suppressTranscriptEcho: acceptedPrompt.suppressTranscriptEcho,
    };
  }

  function findMatchingTranscript(messages: readonly unknown[]): ClaudeUnifiedAcceptedPromptTranscriptMatch | null {
    pruneExpired(nowMs());
    for (const message of messages) {
      const operation = readNativeQueuedCommandOperation(message);
      if (operation) observeNativeQueuedCommandOperation(operation);
    }
    for (const message of messages) {
      const record = readObject(message);
      const parsedMessage = parseRawJsonLinesObject(message);
      if (record?.isSidechain === true || readObject(record?.origin)?.kind === 'peer') continue;
      const providerPromptId = readNonEmptyString(record?.promptId);
      const providerSessionId = readNonEmptyString(record?.sessionId);
      if (parsedMessage && providerPromptId && providerSessionId
        && acceptedPromptHookEchoes.has(buildHookEchoKey(providerSessionId, providerPromptId))) {
        closeTranscriptEvidence(readTranscriptIdentity(parsedMessage).transcriptKey);
        continue;
      }
      const controlShape = parsedMessage ? readClaudeControlCommandRowShape(parsedMessage) : null;
      if (parsedMessage && (controlShape?.kind === 'stdout' || controlShape?.kind === 'shell_output' || controlShape?.kind === 'local_caveat')) {
        observeControlCommandTranscript(parsedMessage);
        continue;
      }
      if (parsedMessage && (controlShape?.kind === 'command' || controlShape?.kind === 'shell_command')) {
        const identity = readTranscriptIdentity(parsedMessage);
        if (closedTranscriptEvidence.has(identity.transcriptKey)) continue;
        observeControlCommandTranscript(parsedMessage);
        const binding = controlCommandBindings.get(identity.transcriptKey);
        const origin = binding?.origin;
        if (origin?.kind !== 'attempt') continue;
        const acceptedPrompt = acceptedPrompts.find((candidate) => candidate.id === origin.acceptedPromptId);
        if (!acceptedPrompt || !matchesPromptWindow(message, acceptedPrompt)) continue;
        return {
          acceptedPromptId: acceptedPrompt.id,
          acceptedPromptNormalizedText: acceptedPrompt.normalizedText,
          deliveryIdentity: cloneDeliveryIdentity(acceptedPrompt.deliveryIdentity),
          transcriptUuid: identity.uuid,
          transcriptPromptId: identity.promptId,
          transcriptTimestampMs: readMessageTimestampMs(message),
          matchKind: 'exact',
          transcriptKey: identity.transcriptKey,
          suppressTranscriptEcho: acceptedPrompt.suppressTranscriptEcho,
        };
      }
      const queuedCommandConsumptionMatch = findNativeQueuedCommandConsumptionMatch(message);
      if (queuedCommandConsumptionMatch) return queuedCommandConsumptionMatch;
      const texts = readPromptTexts(message);
      if (texts.length === 0) continue;
      const transcriptKey = buildTranscriptKey({ record, message, texts });
      if (transcriptKey && closedTranscriptEvidence.has(transcriptKey)) continue;
      let matchIndex = -1;
      let matchKind: ClaudeUnifiedAcceptedPromptTranscriptMatch['matchKind'] = 'exact';
      for (const text of texts) {
        const matchingIndices = acceptedPrompts
          .map((acceptedPrompt, index) => ({ acceptedPrompt, index }))
          .filter(({ acceptedPrompt }) => (
            promptTextsMatch(text, acceptedPrompt) && matchesPromptWindow(message, acceptedPrompt)
          ));
        if (matchingIndices.length === 0) continue;
        const normalizedText = normalizeClaudeUnifiedPromptIdentityText(text);
        const exactMatches = matchingIndices.filter(({ acceptedPrompt }) => acceptedPrompt.normalizedText === normalizedText);
        // A provider UUID deduplicates the row; it does not identify which Pending attempt
        // produced identical text. Preserve ambiguity until independently bound evidence settles it.
        if (exactMatches.length > 1) {
          closeTranscriptEvidence(transcriptKey);
          continue;
        }
        const exactMatch = exactMatches[0];
        if (exactMatch) {
          matchIndex = exactMatch.index;
          matchKind = 'exact';
          break;
        }
        const fallbackMatches = matchingIndices.filter(({ acceptedPrompt }) => (
          isCommandNameOnlyFallbackMatch(text, acceptedPrompt)
        ));
        if (fallbackMatches.length > 1 && fallbackMatches.length === matchingIndices.length) {
          continue;
        }
        matchIndex = matchingIndices[0]?.index ?? -1;
        matchKind = 'command_name';
        break;
      }
      if (matchIndex < 0) continue;
      const acceptedPrompt = acceptedPrompts[matchIndex];
      if (!acceptedPrompt) continue;
      return {
        acceptedPromptId: acceptedPrompt.id,
        acceptedPromptNormalizedText: acceptedPrompt.normalizedText,
        deliveryIdentity: cloneDeliveryIdentity(acceptedPrompt.deliveryIdentity),
        transcriptUuid: readNonEmptyString(record?.uuid),
        transcriptPromptId: readNonEmptyString(record?.promptId),
        transcriptTimestampMs: readMessageTimestampMs(message),
        matchKind,
        transcriptKey,
        suppressTranscriptEcho: acceptedPrompt.suppressTranscriptEcho,
      };
    }
    return null;
  }

  function consumeAcceptedPromptMatch(match: ClaudeUnifiedAcceptedPromptTranscriptMatch): boolean {
    const matchIndex = acceptedPrompts.findIndex((acceptedPrompt) => acceptedPrompt.id === match.acceptedPromptId);
    if (matchIndex < 0) return false;
    const acceptedPrompt = acceptedPrompts[matchIndex];
    if (!acceptedPrompt) return false;
    confirmAcceptedPromptControlBindings(acceptedPrompt.id);
    closeTranscriptEvidence(match.transcriptKey);
    for (let index = nativeQueuedCommandCustody.length - 1; index >= 0; index -= 1) {
      if (nativeQueuedCommandCustody[index]?.acceptedPromptId === acceptedPrompt.id) {
        nativeQueuedCommandCustody.splice(index, 1);
      }
    }
    acceptedPrompts.splice(matchIndex, 1);
    return true;
  }

  function confirmAcceptedPromptControlBindings(acceptedPromptId: string): void {
    for (const binding of controlCommandBindings.values()) {
      if (binding.origin.kind !== 'attempt' || binding.origin.acceptedPromptId !== acceptedPromptId) continue;
      binding.acceptedConfirmed = true;
      maybeEmitAttemptLocalCommandCompletion(binding);
    }
  }

  function claimMatchingTranscript(messages: readonly unknown[]): ClaudeUnifiedAcceptedPromptTranscriptMatch | null {
    const match = findMatchingTranscript(messages);
    if (!match) return null;
    return consumeAcceptedPromptMatch(match) ? match : null;
  }

  function removePromptByBatch(
    input: Parameters<ClaudeUnifiedAcceptedPromptTranscriptDiscovery['consumeAcceptedPromptByBatch']>[0],
    accepted: boolean,
  ): boolean {
    const normalizedText = normalizeClaudeUnifiedPromptIdentityText(input.message);
    if (normalizedText.length === 0) return false;
    pruneExpired(nowMs());
    const matchIndex = acceptedPrompts.findIndex((acceptedPrompt) => (
      acceptedPrompt.normalizedText === normalizedText
      && doesBatchMatchDeliveryIdentity(acceptedPrompt, input)
    ));
    if (matchIndex < 0) return false;
    const acceptedPrompt = acceptedPrompts[matchIndex];
    if (!acceptedPrompt) return false;
    if (accepted) confirmAcceptedPromptControlBindings(acceptedPrompt.id);
    for (let index = nativeQueuedCommandCustody.length - 1; index >= 0; index -= 1) {
      if (nativeQueuedCommandCustody[index]?.acceptedPromptId === acceptedPrompt.id) {
        nativeQueuedCommandCustody.splice(index, 1);
      }
    }
    acceptedPrompts.splice(matchIndex, 1);
    return true;
  }

  return {
    recordAcceptedPrompt(input) {
      const normalizedText = normalizeClaudeUnifiedPromptIdentityText(input.message);
      if (normalizedText.length === 0) return null;
      const rawAcceptedAtMs = input.acceptedAtMs;
      const acceptedAtMs =
        typeof rawAcceptedAtMs === 'number' && Number.isFinite(rawAcceptedAtMs)
          ? Math.trunc(rawAcceptedAtMs)
          : nowMs();
      pruneExpired(acceptedAtMs);
      const id = `accepted-prompt-${nextAcceptedPromptId++}`;
      const deliveryIdentity = cloneDeliveryIdentity(input.deliveryIdentity);
      const hasDurableDeliveryIdentity = readValidSeqs(deliveryIdentity).size > 0
        || readValidLocalIds(deliveryIdentity).size > 0;
      acceptedPrompts.push({
        id,
        text: input.message,
        normalizedText,
        deliveryIdentity,
        acceptedAtMs,
        // A canonical Pending attempt remains owned by this concrete terminal-host generation
        // until exact provider evidence accepts it or the arbiter/run is disposed. Claude may keep
        // a resume dialog or compaction open indefinitely, so elapsed time cannot discard the only
        // acceptance correlation and strand the durable row in `delivering`.
        expiresAtMs: hasDurableDeliveryIdentity ? null : acceptedAtMs + acceptedPromptWindowMs,
        registrationOrder: nextRegistrationOrder++,
        suppressTranscriptEcho: input.suppressTranscriptEcho === true && hasDurableDeliveryIdentity,
      });
      return id;
    },

    recordAcceptedPromptHookEcho(input) {
      const sessionId = readNonEmptyString(input.sessionId);
      const promptId = readNonEmptyString(input.promptId);
      const deliveryIdentity = cloneDeliveryIdentity(input.deliveryIdentity);
      const hasDurableDeliveryIdentity = readValidSeqs(deliveryIdentity).size > 0
        || readValidLocalIds(deliveryIdentity).size > 0;
      if (
        !sessionId
        || sessionId.trim().length === 0
        || !promptId
        || promptId.trim().length === 0
        || !deliveryIdentity
        || !hasDurableDeliveryIdentity
      ) return false;
      acceptedPromptHookEchoes.set(
        buildHookEchoKey(sessionId, promptId),
        { deliveryIdentity, promptId, sessionId },
      );
      return true;
    },

    reserveAcceptedPromptTranscriptEcho(match) {
      if (!match.suppressTranscriptEcho || !match.transcriptKey) return false;
      reservedTranscriptEchoKeys.add(match.transcriptKey);
      return true;
    },

    consumeAcceptedPromptTranscriptEcho,

    recordIndependentControlCommand(input) {
      const normalizedText = normalizeClaudeUnifiedPromptIdentityText(input.message);
      if (normalizedText.length === 0) return null;
      const rawSubmittedAtMs = input.submittedAtMs;
      const submittedAtMs = typeof rawSubmittedAtMs === 'number' && Number.isFinite(rawSubmittedAtMs)
        ? Math.trunc(rawSubmittedAtMs)
        : nowMs();
      pruneExpired(submittedAtMs);
      const id = `independent-control-${nextIndependentControlCommandId++}`;
      const expiresAtMs = submittedAtMs + acceptedPromptWindowMs;
      // A delayed predecessor row must never consume a newer retry during the gap between their
      // individual expiry times. All registrations whose provider echoes are indistinguishable stay
      // live through the newest registration's horizon, then expire as one bounded episode.
      for (const control of independentControlCommands) {
        if (!controlRegistrationsMayShareTranscriptEvidence(control.normalizedText, normalizedText)) continue;
        control.expiresAtMs = Math.max(control.expiresAtMs, expiresAtMs);
      }
      independentControlCommands.push({
        id,
        normalizedText,
        submittedAtMs,
        expiresAtMs,
        registrationOrder: nextRegistrationOrder++,
        disposition: 'pending',
      });
      return id;
    },

    recordIndependentControlCommandDisposition(input) {
      const index = independentControlCommands.findIndex((control) => control.id === input.submissionId);
      if (index < 0) return false;
      if (input.disposition === 'not_sent') {
        independentControlCommands.splice(index, 1);
        return true;
      }
      const control = independentControlCommands[index];
      if (!control) return false;
      control.disposition = input.disposition;
      return true;
    },

    observeControlCommandTranscript,

    consumeAcceptedPromptByBatch: (input) => removePromptByBatch(input, true),
    forgetRetiredPromptByBatch: (input) => removePromptByBatch(input, false),

    findMatchingTranscript,

    consumeAcceptedPromptMatch,

    claimMatchingTranscript,

    consumeMatchingTranscript(messages) {
      return claimMatchingTranscript(messages) !== null;
    },
  };
}
