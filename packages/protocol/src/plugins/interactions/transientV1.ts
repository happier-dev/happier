import { z } from 'zod';

import { StrictJsonValueSchema, type JsonValue } from '../../json/strictJsonValue.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginIdSchema } from '../pluginId.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

const textEncoder = new TextEncoder();

export const MAX_INTERACTION_TRANSIENT_QUESTIONS_V1 = 32;
export const MAX_INTERACTION_TRANSIENT_CHOICES_V1 = 64;
export const MAX_INTERACTION_TRANSIENT_IDENTIFIER_UTF8_BYTES_V1 = 128;
export const MAX_INTERACTION_TRANSIENT_TITLE_OR_LABEL_CODE_POINTS_V1 = 512;
export const MAX_INTERACTION_TRANSIENT_PROMPT_CODE_POINTS_V1 = 4_096;
export const MAX_INTERACTION_TRANSIENT_TEXT_ANSWER_CODE_POINTS_V1 = 16_384;
export const MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1 = 256 * 1024;

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function hasUnpairedSurrogate(value: string): boolean {
  const isWellFormed = (value as string & { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof isWellFormed === 'function') return !isWellFormed.call(value);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function boundedIdentifier(label: string): z.ZodString {
  return z.string().min(1).superRefine((value, context) => {
    if (utf8ByteLength(value) > MAX_INTERACTION_TRANSIENT_IDENTIFIER_UTF8_BYTES_V1) {
      context.addIssue({
        code: 'custom',
        message: `${label} must be at most ${MAX_INTERACTION_TRANSIENT_IDENTIFIER_UTF8_BYTES_V1} UTF-8 bytes.`,
      });
    }
    if (hasUnpairedSurrogate(value)) {
      context.addIssue({ code: 'custom', message: `${label} must be well-formed Unicode.` });
    }
  });
}

function boundedText(label: string, maxCodePoints: number): z.ZodString {
  return z.string().min(1).superRefine((value, context) => {
    if (codePointLength(value) > maxCodePoints) {
      context.addIssue({
        code: 'custom',
        message: `${label} must be at most ${maxCodePoints} code points.`,
      });
    }
    if (hasUnpairedSurrogate(value)) {
      context.addIssue({ code: 'custom', message: `${label} must be well-formed Unicode.` });
    }
  });
}

function boundedPrompt(label: string): z.ZodString {
  return boundedText(label, MAX_INTERACTION_TRANSIENT_PROMPT_CODE_POINTS_V1);
}

function boundedTitleOrLabel(label: string): z.ZodString {
  return boundedText(label, MAX_INTERACTION_TRANSIENT_TITLE_OR_LABEL_CODE_POINTS_V1);
}

function boundedTextAnswer(label: string): z.ZodString {
  return boundedText(label, MAX_INTERACTION_TRANSIENT_TEXT_ANSWER_CODE_POINTS_V1);
}

function jsonByteLength(value: unknown): number | null {
  try {
    return utf8ByteLength(JSON.stringify(value));
  } catch {
    return null;
  }
}

function issueForOversizedPayload(
  value: unknown,
  context: z.RefinementCtx,
  label: string,
): void {
  const byteLength = jsonByteLength(value);
  if (byteLength === null) {
    context.addIssue({ code: 'custom', message: `${label} must be JSON-safe.` });
  } else if (byteLength > MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1) {
    context.addIssue({
      code: 'custom',
      message: `${label} must be at most ${MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1} JSON bytes.`,
    });
  }
}

function containsMalformedUnicode(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === 'string') return hasUnpairedSurrogate(value);
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || hasUnpairedSurrogate(key)) return true;
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) continue;
      if (containsMalformedUnicode(descriptor.value, seen)) return true;
    }
    return false;
  } finally {
    seen.delete(value);
  }
}

function issueForMalformedUnicodePayload(
  value: unknown,
  context: z.RefinementCtx,
  label: string,
): void {
  if (containsMalformedUnicode(value)) {
    context.addIssue({ code: 'custom', message: `${label} must contain well-formed Unicode.` });
  }
}

function issueForInvalidPayload(
  value: unknown,
  context: z.RefinementCtx,
  label: string,
): void {
  issueForOversizedPayload(value, context, label);
  issueForMalformedUnicodePayload(value, context, label);
}

function issueForDuplicateIds(
  values: readonly { readonly id: string }[],
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  label: string,
): void {
  const ids = new Set<string>();
  values.forEach((value, index) => {
    if (ids.has(value.id)) {
      context.addIssue({
        code: 'custom',
        path: [...path, index, 'id'],
        message: `${label} ids must be unique.`,
      });
    }
    ids.add(value.id);
  });
}

export const InteractionTransientRequesterV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
  contributionId: asProtocolZod(PluginContributionLocalIdSchema),
  generationId: boundedIdentifier('Interaction generation ids'),
  invocationId: boundedIdentifier('Interaction invocation ids'),
}).strict();
export type InteractionTransientRequesterV1 = z.infer<typeof InteractionTransientRequesterV1Schema>;

/**
 * Host-stamped interaction reachability. Authors never receive this input:
 * Session identity comes only from the current Session adapter, while app
 * scope is available only from an exact present-user application invocation.
 */
export const InteractionTransientScopeV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('session'),
    sessionId: boundedIdentifier('Interaction session ids'),
  }).strict(),
  z.object({ kind: z.literal('app') }).strict(),
]);
export type InteractionTransientScopeV1 = z.infer<typeof InteractionTransientScopeV1Schema>;

export const InteractionTransientRequestStampV1Schema = z.object({
  requestId: boundedIdentifier('Interaction request ids'),
  scope: InteractionTransientScopeV1Schema,
  requester: InteractionTransientRequesterV1Schema,
  createdAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.expiresAtMs <= value.createdAtMs) {
    context.addIssue({
      code: 'custom',
      path: ['expiresAtMs'],
      message: 'Interaction expiry must be later than creation.',
    });
  }
});
export type InteractionTransientRequestStampV1 = z.infer<typeof InteractionTransientRequestStampV1Schema>;

export const InteractionTransientChoiceV1Schema = z.object({
  id: boundedIdentifier('Interaction choice ids'),
  label: boundedTitleOrLabel('Interaction choice labels'),
  description: boundedPrompt('Interaction choice descriptions').optional(),
}).strict();
export type InteractionTransientChoiceV1 = z.infer<typeof InteractionTransientChoiceV1Schema>;

const InteractionTransientAuthorChoiceV1Schema = z.object({
  id: boundedIdentifier('Interaction choice ids'),
  label: boundedTitleOrLabel('Interaction choice labels').optional(),
  description: boundedPrompt('Interaction choice descriptions').optional(),
}).strict();

const TextQuestionV1Schema = z.object({
  id: boundedIdentifier('Interaction question ids'),
  prompt: boundedPrompt('Interaction question prompts'),
  description: boundedPrompt('Interaction question descriptions').optional(),
  type: z.literal('text'),
  required: z.boolean(),
}).strict();
const ChoiceQuestionV1Schema = z.object({
  id: boundedIdentifier('Interaction question ids'),
  prompt: boundedPrompt('Interaction question prompts'),
  description: boundedPrompt('Interaction question descriptions').optional(),
  type: z.union([z.literal('singleChoice'), z.literal('multipleChoice')]),
  required: z.boolean(),
  allowCustom: z.boolean(),
  choices: z.array(InteractionTransientChoiceV1Schema).min(1).max(MAX_INTERACTION_TRANSIENT_CHOICES_V1),
}).strict().superRefine((question, context) => {
  issueForDuplicateIds(question.choices, context, ['choices'], 'Interaction choice');
});

export const InteractionTransientQuestionV1Schema = z.union([
  TextQuestionV1Schema,
  ChoiceQuestionV1Schema,
]);
export type InteractionTransientQuestionV1 = z.infer<typeof InteractionTransientQuestionV1Schema>;

const AuthorTextQuestionV1Schema = z.object({
  id: boundedIdentifier('Interaction question ids'),
  prompt: boundedPrompt('Interaction question prompts'),
  description: boundedPrompt('Interaction question descriptions').optional(),
  type: z.literal('text'),
  required: z.boolean().optional(),
}).strict();
const AuthorChoiceQuestionV1Schema = z.object({
  id: boundedIdentifier('Interaction question ids'),
  prompt: boundedPrompt('Interaction question prompts'),
  description: boundedPrompt('Interaction question descriptions').optional(),
  type: z.union([z.literal('singleChoice'), z.literal('multipleChoice')]),
  required: z.boolean().optional(),
  allowCustom: z.boolean().optional(),
  choices: z.array(InteractionTransientAuthorChoiceV1Schema).min(1).max(MAX_INTERACTION_TRANSIENT_CHOICES_V1),
}).strict().superRefine((question, context) => {
  issueForDuplicateIds(question.choices, context, ['choices'], 'Interaction choice');
});
export const InteractionTransientAuthorQuestionV1Schema = z.union([
  AuthorTextQuestionV1Schema,
  AuthorChoiceQuestionV1Schema,
]);
export type InteractionTransientAuthorQuestionV1 = z.infer<typeof InteractionTransientAuthorQuestionV1Schema>;

const InteractionTransientStrictJsonValueV1Schema = z.unknown().superRefine((value, context) => {
  issueForMalformedUnicodePayload(value, context, 'Interaction approval input');
}).pipe(StrictJsonValueSchema);

const InteractionTransientApprovalSubjectV1Schema = z.object({
  kind: z.literal('tool'),
  name: boundedIdentifier('Interaction approval tool names'),
  input: InteractionTransientStrictJsonValueV1Schema,
}).strict();
export type InteractionTransientApprovalSubjectV1 = z.infer<typeof InteractionTransientApprovalSubjectV1Schema>;

const QuestionsRequestV1Schema = InteractionTransientRequestStampV1Schema.extend({
  kind: z.literal('questions'),
  title: boundedTitleOrLabel('Interaction question titles').optional(),
  questions: z.array(InteractionTransientQuestionV1Schema)
    .min(1)
    .max(MAX_INTERACTION_TRANSIENT_QUESTIONS_V1),
}).strict().superRefine((request, context) => {
  issueForDuplicateIds(request.questions, context, ['questions'], 'Interaction question');
  issueForInvalidPayload(request, context, 'Interaction requests');
});
const ApprovalRequestV1Schema = InteractionTransientRequestStampV1Schema.extend({
  kind: z.literal('approval'),
  title: boundedTitleOrLabel('Interaction approval titles'),
  description: boundedPrompt('Interaction approval descriptions').optional(),
  subject: InteractionTransientApprovalSubjectV1Schema,
  allowedPersistenceScopes: z.tuple([z.literal('session')]).optional(),
}).strict().superRefine((request, context) => {
  issueForInvalidPayload(request, context, 'Interaction requests');
  if (request.scope.kind === 'app' && request.allowedPersistenceScopes !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['allowedPersistenceScopes'],
      message: 'App-scoped interactions cannot request Session persistence.',
    });
  }
});
const ConfirmationRequestV1Schema = InteractionTransientRequestStampV1Schema.extend({
  kind: z.literal('confirmation'),
  title: boundedTitleOrLabel('Interaction confirmation titles'),
  message: boundedPrompt('Interaction confirmation messages'),
}).strict().superRefine((request, context) => issueForInvalidPayload(request, context, 'Interaction requests'));

export const InteractionTransientRequestV1Schema = z.discriminatedUnion('kind', [
  QuestionsRequestV1Schema,
  ApprovalRequestV1Schema,
  ConfirmationRequestV1Schema,
]).superRefine((request, context) => {
  issueForInvalidPayload(request, context, 'Interaction requests');
});
export type InteractionTransientRequestV1 = z.infer<typeof InteractionTransientRequestV1Schema>;

const QuestionsAuthorRequestV1Schema = z.object({
  kind: z.literal('questions'),
  title: boundedTitleOrLabel('Interaction question titles').optional(),
  questions: z.array(InteractionTransientAuthorQuestionV1Schema)
    .min(1)
    .max(MAX_INTERACTION_TRANSIENT_QUESTIONS_V1),
}).strict().superRefine((request, context) => {
  issueForDuplicateIds(request.questions, context, ['questions'], 'Interaction question');
});
const ApprovalAuthorRequestV1Schema = z.object({
  kind: z.literal('approval'),
  title: boundedTitleOrLabel('Interaction approval titles'),
  description: boundedPrompt('Interaction approval descriptions').optional(),
  subject: InteractionTransientApprovalSubjectV1Schema,
  allowSessionPersistence: z.boolean().optional(),
}).strict();
const ConfirmationAuthorRequestV1Schema = z.object({
  kind: z.literal('confirmation'),
  title: boundedTitleOrLabel('Interaction confirmation titles').optional(),
  message: boundedPrompt('Interaction confirmation messages'),
}).strict();

export const InteractionTransientAuthorRequestV1Schema = z.discriminatedUnion('kind', [
  QuestionsAuthorRequestV1Schema,
  ApprovalAuthorRequestV1Schema,
  ConfirmationAuthorRequestV1Schema,
]).superRefine((request, context) => issueForInvalidPayload(request, context, 'Interaction author requests'));
export type InteractionTransientAuthorRequestV1 = z.infer<typeof InteractionTransientAuthorRequestV1Schema>;
export type InteractionTransientQuestionsAuthorRequestV1 = Extract<InteractionTransientAuthorRequestV1, { kind: 'questions' }>;
export type InteractionTransientApprovalAuthorRequestV1 = Extract<InteractionTransientAuthorRequestV1, { kind: 'approval' }>;
export type InteractionTransientConfirmationAuthorRequestV1 = Extract<InteractionTransientAuthorRequestV1, { kind: 'confirmation' }>;

export type InteractionTransientRequestNormalizationV1 =
  | Readonly<{ ok: true; value: InteractionTransientRequestV1 }>
  | Readonly<{ ok: false; code: 'invalid_interaction_request' }>;

/**
 * The only conversion from author input to the request a presenter may see.
 * The caller supplies the host-stamped custody facts; author input cannot
 * carry, override, or infer any of them.
 */
export function normalizeInteractionTransientRequestV1(
  input: unknown,
  stamp: InteractionTransientRequestStampV1,
): InteractionTransientRequestNormalizationV1 {
  let parsedInput: ReturnType<typeof InteractionTransientAuthorRequestV1Schema.safeParse>;
  let parsedStamp: ReturnType<typeof InteractionTransientRequestStampV1Schema.safeParse>;
  try {
    parsedInput = InteractionTransientAuthorRequestV1Schema.safeParse(input);
    parsedStamp = InteractionTransientRequestStampV1Schema.safeParse(stamp);
  } catch {
    return { ok: false, code: 'invalid_interaction_request' };
  }
  if (!parsedInput.success || !parsedStamp.success) {
    return { ok: false, code: 'invalid_interaction_request' };
  }

  const request = parsedInput.data;
  const normalized: InteractionTransientRequestV1 = request.kind === 'questions'
    ? {
        ...parsedStamp.data,
        kind: 'questions',
        ...(request.title === undefined ? {} : { title: request.title }),
        questions: request.questions.map((question): InteractionTransientQuestionV1 => (
          question.type === 'text'
            ? {
                id: question.id,
                prompt: question.prompt,
                ...(question.description === undefined ? {} : { description: question.description }),
                type: 'text',
                required: question.required ?? false,
              }
            : {
                id: question.id,
                prompt: question.prompt,
                ...(question.description === undefined ? {} : { description: question.description }),
                type: question.type,
                required: question.required ?? false,
                allowCustom: question.allowCustom ?? false,
                choices: question.choices.map((choice) => ({
                  id: choice.id,
                  label: choice.label ?? choice.id,
                  ...(choice.description === undefined ? {} : { description: choice.description }),
                })),
              }
        )),
      }
    : request.kind === 'approval'
      ? {
          ...parsedStamp.data,
          kind: 'approval',
          title: request.title,
          ...(request.description === undefined ? {} : { description: request.description }),
          subject: request.subject,
          ...(request.allowSessionPersistence === true && parsedStamp.data.scope.kind === 'session'
            ? { allowedPersistenceScopes: ['session'] as const }
            : {}),
        }
      : {
          ...parsedStamp.data,
          kind: 'confirmation',
          title: request.title ?? 'Confirmation',
          message: request.message,
        };
  const parsedRequest = InteractionTransientRequestV1Schema.safeParse(normalized);
  return parsedRequest.success
    ? { ok: true, value: parsedRequest.data }
    : { ok: false, code: 'invalid_interaction_request' };
}

export const InteractionTerminalStatusV1Schema = z.enum([
  'userCancelled',
  'requesterAborted',
  'timedOut',
  'sessionEnded',
  'generationRetired',
  'hostRestarted',
  'unavailable',
]);
export type InteractionTerminalStatusV1 = z.infer<typeof InteractionTerminalStatusV1Schema>;

const InteractionTransientChoiceSelectionV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('choice'),
    choiceId: boundedIdentifier('Interaction answer choice ids'),
  }).strict(),
  z.object({
    kind: z.literal('custom'),
    value: boundedTextAnswer('Interaction custom answers'),
  }).strict(),
]);
export type InteractionTransientChoiceSelectionV1 = z.infer<typeof InteractionTransientChoiceSelectionV1Schema>;

export const InteractionTransientQuestionAnswerV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    value: boundedTextAnswer('Interaction text answers'),
  }).strict(),
  z.object({
    kind: z.literal('singleChoice'),
    answer: InteractionTransientChoiceSelectionV1Schema,
  }).strict(),
  z.object({
    kind: z.literal('multipleChoice'),
    answers: z.array(InteractionTransientChoiceSelectionV1Schema)
      .min(1)
      .max(MAX_INTERACTION_TRANSIENT_CHOICES_V1),
  }).strict(),
]).superRefine((answer, context) => {
  if (answer.kind !== 'multipleChoice') return;
  const selectionKeys = answer.answers.map((selection) => (
    selection.kind === 'choice' ? `choice:${selection.choiceId}` : `custom:${selection.value}`
  ));
  if (new Set(selectionKeys).size !== selectionKeys.length) {
    context.addIssue({ code: 'custom', message: 'Interaction multi-choice answers must not contain duplicates.' });
  }
  if (answer.answers.filter((selection) => selection.kind === 'custom').length > 1) {
    context.addIssue({ code: 'custom', message: 'Interaction multi-choice answers may contain at most one custom answer.' });
  }
});
export type InteractionTransientQuestionAnswerV1 = z.infer<typeof InteractionTransientQuestionAnswerV1Schema>;

const QuestionsAnsweredResultV1Schema = z.object({
  requestId: boundedIdentifier('Interaction result request ids'),
  kind: z.literal('questions'),
  status: z.literal('answered'),
  answers: z.record(boundedIdentifier('Interaction answer question ids'), InteractionTransientQuestionAnswerV1Schema),
}).strict();
const QuestionsTerminalResultV1Schema = z.object({
  requestId: boundedIdentifier('Interaction result request ids'),
  kind: z.literal('questions'),
  status: InteractionTerminalStatusV1Schema,
}).strict();
const ApprovalApprovedResultV1Schema = z.object({
  requestId: boundedIdentifier('Interaction result request ids'),
  kind: z.literal('approval'),
  status: z.literal('approved'),
  persistence: z.enum(['once', 'session']).optional(),
}).strict();
const ApprovalDeclinedResultV1Schema = z.object({
  requestId: boundedIdentifier('Interaction result request ids'),
  kind: z.literal('approval'),
  status: z.literal('declined'),
}).strict();
const ApprovalTerminalResultV1Schema = z.object({
  requestId: boundedIdentifier('Interaction result request ids'),
  kind: z.literal('approval'),
  status: InteractionTerminalStatusV1Schema,
}).strict();
const ConfirmationDecisionResultV1Schema = z.object({
  requestId: boundedIdentifier('Interaction result request ids'),
  kind: z.literal('confirmation'),
  status: z.enum(['approved', 'declined']),
}).strict();
const ConfirmationTerminalResultV1Schema = z.object({
  requestId: boundedIdentifier('Interaction result request ids'),
  kind: z.literal('confirmation'),
  status: InteractionTerminalStatusV1Schema,
}).strict();

export const InteractionTransientResultV1Schema = z.union([
  QuestionsAnsweredResultV1Schema,
  QuestionsTerminalResultV1Schema,
  ApprovalApprovedResultV1Schema,
  ApprovalDeclinedResultV1Schema,
  ApprovalTerminalResultV1Schema,
  ConfirmationDecisionResultV1Schema,
  ConfirmationTerminalResultV1Schema,
]).superRefine((result, context) => issueForInvalidPayload(result, context, 'Interaction results'));
export type InteractionTransientResultV1 = z.infer<typeof InteractionTransientResultV1Schema>;
export type InteractionTransientQuestionsResultV1 = Extract<InteractionTransientResultV1, { kind: 'questions' }>;
export type InteractionTransientApprovalResultV1 = Extract<InteractionTransientResultV1, { kind: 'approval' }>;
export type InteractionTransientConfirmationResultV1 = Extract<InteractionTransientResultV1, { kind: 'confirmation' }>;

export const InteractionTransientSettlementReceiptV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('settled'),
    result: InteractionTransientResultV1Schema,
  }).strict(),
  z.object({
    status: z.literal('notCurrent'),
    requestId: boundedIdentifier('Interaction settlement request ids'),
  }).strict(),
]);
export type InteractionTransientSettlementReceiptV1 = z.infer<typeof InteractionTransientSettlementReceiptV1Schema>;

export type InteractionTransientSettlementValidationV1 =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      code:
        | 'invalid_interaction_result'
        | 'interaction_request_mismatch'
        | 'interaction_kind_mismatch'
        | 'owner_only_interaction_terminal_status'
        | 'invalid_interaction_answer'
        | 'invalid_interaction_persistence';
    }>;

/** These terminal states are produced only by the host lifecycle owner. */
function isOwnerOnlyInteractionTerminalStatus(
  status: InteractionTransientResultV1['status'],
): boolean {
  return status === 'requesterAborted'
    || status === 'timedOut'
    || status === 'sessionEnded'
    || status === 'generationRetired'
    || status === 'hostRestarted'
    || status === 'unavailable';
}

function isQuestionAnswerValid(
  question: InteractionTransientQuestionV1,
  answer: InteractionTransientQuestionAnswerV1,
): boolean {
  if (question.type === 'text') {
    return answer.kind === 'text' && (!question.required || answer.value.trim().length > 0);
  }
  if (question.type === 'singleChoice') {
    if (answer.kind !== 'singleChoice') return false;
    const selection = answer.answer;
    return selection.kind === 'choice'
      ? question.choices.some((choice) => choice.id === selection.choiceId)
      : question.allowCustom && selection.value.trim().length > 0;
  }
  if (answer.kind !== 'multipleChoice') return false;
  return answer.answers.length > 0
    && answer.answers.every((selection) => (
      selection.kind === 'choice'
        ? question.choices.some((choice) => choice.id === selection.choiceId)
        : question.allowCustom && selection.value.trim().length > 0
    ));
}

/**
 * Validates a presenter candidate against the live request. The host lifecycle
 * owner still owns first-terminal-wins and currentness; this pure contract
 * rejects malformed, cross-request, cross-kind, and invalid-answer candidates
 * before that owner can settle anything.
 */
export function validateInteractionTransientSettlementV1(
  request: InteractionTransientRequestV1,
  result: unknown,
): InteractionTransientSettlementValidationV1 {
  const parsed = InteractionTransientResultV1Schema.safeParse(result);
  if (!parsed.success) return { ok: false, code: 'invalid_interaction_result' };
  if (parsed.data.requestId !== request.requestId) {
    return { ok: false, code: 'interaction_request_mismatch' };
  }
  if (parsed.data.kind !== request.kind) return { ok: false, code: 'interaction_kind_mismatch' };
  if (isOwnerOnlyInteractionTerminalStatus(parsed.data.status)) {
    return { ok: false, code: 'owner_only_interaction_terminal_status' };
  }
  if (
    request.kind === 'approval'
    && parsed.data.kind === 'approval'
    && parsed.data.status === 'approved'
    && parsed.data.persistence === 'session'
    && !request.allowedPersistenceScopes?.includes('session')
  ) {
    return { ok: false, code: 'invalid_interaction_persistence' };
  }
  if (request.kind !== 'questions' || parsed.data.kind !== 'questions' || parsed.data.status !== 'answered') {
    return { ok: true };
  }

  const answers = parsed.data.answers;

  const questions = new Map(request.questions.map((question) => [question.id, question]));
  for (const [questionId, answer] of Object.entries(answers)) {
    const question = questions.get(questionId);
    if (!question || !isQuestionAnswerValid(question, answer)) {
      return { ok: false, code: 'invalid_interaction_answer' };
    }
  }
  if (request.questions.some((question) => question.required && !Object.hasOwn(answers, question.id))) {
    return { ok: false, code: 'invalid_interaction_answer' };
  }
  return { ok: true };
}

export type { JsonValue };
