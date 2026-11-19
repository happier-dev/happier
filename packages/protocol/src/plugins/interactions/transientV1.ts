import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { StrictJsonValueSchema, type JsonValue } from '../../json/strictJsonValue.js';
import { isStructuredQuestionSelectionCountValid, StructuredQuestionSelectionConstraintsV1Schema } from '../../tools/structuredQuestionAnswersV1.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginIdSchema } from '../pluginId.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";
import { PluginExecutionScopeV1Schema } from '../invocationScopeV1.js';
import { PluginUiRuntimeOccurrenceIdV1Schema } from '../ui/runtimeOccurrenceV1.js';
import { NativePermissionChoicesV1Schema, NativePermissionChoiceAnswerV1Schema } from '../../sessions/permissions/nativeChoicesV1.js';
import {
  MAX_INTERACTION_TRANSIENT_QUESTIONS_V1,
  MAX_INTERACTION_TRANSIENT_CHOICES_V1,
  MAX_INTERACTION_TRANSIENT_IDENTIFIER_UTF8_BYTES_V1,
  MAX_INTERACTION_TRANSIENT_TITLE_OR_LABEL_CODE_POINTS_V1,
  MAX_INTERACTION_TRANSIENT_PROMPT_CODE_POINTS_V1,
  MAX_INTERACTION_TRANSIENT_TEXT_ANSWER_CODE_POINTS_V1,
  MAX_INTERACTION_TRANSIENT_JSON_BYTES_V1,
} from './transientV1Limits.js';
export * from './transientV1Limits.js';

const textEncoder = new TextEncoder();

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

function boundedIdentifier(label: string): z.ZodMiniString<string> {
  return z.string().check(z.minLength(1), z.superRefine((value, context) => {
    if (utf8ByteLength(value) > MAX_INTERACTION_TRANSIENT_IDENTIFIER_UTF8_BYTES_V1) {
      context.addIssue({
        code: 'custom',
        message: `${label} must be at most ${MAX_INTERACTION_TRANSIENT_IDENTIFIER_UTF8_BYTES_V1} UTF-8 bytes.`,
      });
    }
    if (hasUnpairedSurrogate(value)) {
      context.addIssue({ code: 'custom', message: `${label} must be well-formed Unicode.` });
    }
  }));
}

function boundedText(label: string, maxCodePoints: number): z.ZodMiniString<string> {
  return z.string().check(z.minLength(1), z.superRefine((value, context) => {
    if (codePointLength(value) > maxCodePoints) {
      context.addIssue({
        code: 'custom',
        message: `${label} must be at most ${maxCodePoints} code points.`,
      });
    }
    if (hasUnpairedSurrogate(value)) {
      context.addIssue({ code: 'custom', message: `${label} must be well-formed Unicode.` });
    }
  }));
}

function boundedPrompt(label: string): z.ZodMiniString<string> {
  return boundedText(label, MAX_INTERACTION_TRANSIENT_PROMPT_CODE_POINTS_V1);
}

function boundedTitleOrLabel(label: string): z.ZodMiniString<string> {
  return boundedText(label, MAX_INTERACTION_TRANSIENT_TITLE_OR_LABEL_CODE_POINTS_V1);
}

function boundedTextAnswer(label: string): z.ZodMiniString<string> {
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
  context: z.core.$RefinementCtx,
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
  context: z.core.$RefinementCtx,
  label: string,
): void {
  if (containsMalformedUnicode(value)) {
    context.addIssue({ code: 'custom', message: `${label} must contain well-formed Unicode.` });
  }
}

function issueForInvalidPayload(
  value: unknown,
  context: z.core.$RefinementCtx,
  label: string,
): void {
  issueForOversizedPayload(value, context, label);
  issueForMalformedUnicodePayload(value, context, label);
}

function issueForDuplicateIds(
  values: readonly { readonly id: string }[],
  context: z.core.$RefinementCtx,
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

export const InteractionTransientRequesterV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: asProtocolZod(PluginIdSchema),
  contributionId: asProtocolZod(PluginContributionLocalIdSchema),
  occurrenceId: asProtocolZod(PluginUiRuntimeOccurrenceIdV1Schema).check(z.superRefine((value, context) => {
    if (hasUnpairedSurrogate(value)) context.addIssue({ code: 'custom', message: 'Interaction occurrence ids must be well-formed Unicode.' });
  })),
  // Host invocation identities may include the admitted opaque occurrence.
  // The existing whole-interaction JSON budget bounds their representation.
  invocationId: z.string().check(z.minLength(1), z.superRefine((value, context) => {
    if (hasUnpairedSurrogate(value)) context.addIssue({ code: 'custom', message: 'Interaction invocation ids must be well-formed Unicode.' });
  })),
}));
export type InteractionTransientRequesterV1 = z.infer<typeof InteractionTransientRequesterV1Schema>;

/**
 * Host-stamped interaction reachability. Authors never receive this input:
 * Session identity comes only from the current Session adapter, while app
 * scope is available only from an exact present-user application invocation.
 */
export const InteractionTransientScopeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  ...PluginExecutionScopeV1Schema._zod.def.options,
  z.strictObject({ kind: z.literal('app') }),
]));
export type InteractionTransientScopeV1 = z.infer<typeof InteractionTransientScopeV1Schema>;

export const InteractionTransientRequestStampV1Schema = lazyZodSchema(() => z.strictObject({
  requestId: boundedIdentifier('Interaction request ids'),
  scope: InteractionTransientScopeV1Schema,
  requester: InteractionTransientRequesterV1Schema,
  createdAtMs: z.number().check(z.int(), z.nonnegative()),
  /**
   * Two explicit arms. Present: the host imposed this deadline and its owner
   * arms a timer that settles `timedOut`. Absent: the host imposes no deadline
   * at all — the arm L-25 requires for interactive prompts — and the request
   * settles only on an observable lifecycle event (user answer, requester
   * abort, occurrence retirement, Session end, host restart, unavailability).
   * An absent deadline is never a very large one: no timer exists for it.
   */
  expiresAtMs: z.optional(z.number().check(z.int(), z.nonnegative())),
}).check(z.superRefine((value, context) => {
  if (value.expiresAtMs !== undefined && value.expiresAtMs <= value.createdAtMs) {
    context.addIssue({
      code: 'custom',
      path: ['expiresAtMs'],
      message: 'Interaction expiry must be later than creation.',
    });
  }
})));
export type InteractionTransientRequestStampV1 = z.infer<typeof InteractionTransientRequestStampV1Schema>;

export const InteractionTransientChoiceV1Schema = lazyZodSchema(() => z.strictObject({
  id: boundedIdentifier('Interaction choice ids'),
  label: boundedTitleOrLabel('Interaction choice labels'),
  description: z.optional(boundedPrompt('Interaction choice descriptions')),
}));
export type InteractionTransientChoiceV1 = z.infer<typeof InteractionTransientChoiceV1Schema>;

const InteractionTransientAuthorChoiceV1Schema = lazyZodSchema(() => z.strictObject({
  id: boundedIdentifier('Interaction choice ids'),
  label: z.optional(boundedTitleOrLabel('Interaction choice labels')),
  description: z.optional(boundedPrompt('Interaction choice descriptions')),
}));

function validateQuestionSelectionConstraints(
  question: Readonly<{ type: 'singleChoice' | 'multipleChoice'; choices: readonly unknown[]; minSelections?: number; maxSelections?: number }>,
  context: z.core.$RefinementCtx,
): void {
  const parsed = StructuredQuestionSelectionConstraintsV1Schema.safeParse({
    ...(question.minSelections === undefined ? {} : { minSelections: question.minSelections }),
    ...(question.maxSelections === undefined ? {} : { maxSelections: question.maxSelections }),
  });
  if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ ...issue });
  if ((question.minSelections !== undefined || question.maxSelections !== undefined) && question.type !== 'multipleChoice') {
    context.addIssue({ code: 'custom', message: 'Selection bounds require a multiple-choice question.' });
  }
  if (question.minSelections !== undefined && question.minSelections > question.choices.length) {
    context.addIssue({ code: 'custom', path: ['minSelections'], message: 'Selection minimum exceeds the offered choices.' });
  }
}

const TextQuestionV1Schema = lazyZodSchema(() => z.strictObject({
  id: boundedIdentifier('Interaction question ids'),
  prompt: boundedPrompt('Interaction question prompts'),
  description: z.optional(boundedPrompt('Interaction question descriptions')),
  initialValue: z.optional(boundedPrompt('Interaction question initial values')),
  type: z.literal('text'),
  required: z.boolean(),
  allowNote: z.optional(z.boolean()),
}));
const ChoiceQuestionV1Schema = lazyZodSchema(() => z.strictObject({
  id: boundedIdentifier('Interaction question ids'),
  prompt: boundedPrompt('Interaction question prompts'),
  description: z.optional(boundedPrompt('Interaction question descriptions')),
  type: z.union([z.literal('singleChoice'), z.literal('multipleChoice')]),
  required: z.boolean(),
  allowCustom: z.boolean(),
  allowNote: z.optional(z.boolean()),
  ...StructuredQuestionSelectionConstraintsV1Schema.shape,
  choices: z.array(InteractionTransientChoiceV1Schema).check(z.minLength(1), z.maxLength(MAX_INTERACTION_TRANSIENT_CHOICES_V1)),
}).check(z.superRefine((question, context) => {
  issueForDuplicateIds(question.choices, context, ['choices'], 'Interaction choice');
  validateQuestionSelectionConstraints(question, context);
})));

export const InteractionTransientQuestionV1Schema = lazyZodSchema(() => z.union([
  TextQuestionV1Schema,
  ChoiceQuestionV1Schema,
]));
export type InteractionTransientQuestionV1 = z.infer<typeof InteractionTransientQuestionV1Schema>;

const AuthorTextQuestionV1Schema = lazyZodSchema(() => z.strictObject({
  id: boundedIdentifier('Interaction question ids'),
  prompt: boundedPrompt('Interaction question prompts'),
  description: z.optional(boundedPrompt('Interaction question descriptions')),
  initialValue: z.optional(boundedPrompt('Interaction question initial values')),
  type: z.literal('text'),
  required: z.optional(z.boolean()),
  allowNote: z.optional(z.boolean()),
}));
const authorChoiceQuestionFields = () => ({
  id: boundedIdentifier('Interaction question ids'),
  prompt: boundedPrompt('Interaction question prompts'),
  description: z.optional(boundedPrompt('Interaction question descriptions')),
  required: z.optional(z.boolean()),
  allowCustom: z.optional(z.boolean()),
  allowNote: z.optional(z.boolean()),
  choices: z.array(InteractionTransientAuthorChoiceV1Schema).check(z.minLength(1), z.maxLength(MAX_INTERACTION_TRANSIENT_CHOICES_V1)),
});
const AuthorChoiceQuestionV1Schema = lazyZodSchema(() => z.strictObject({
  ...authorChoiceQuestionFields(),
  type: z.union([z.literal('singleChoice'), z.literal('multipleChoice')]),
  ...StructuredQuestionSelectionConstraintsV1Schema.shape,
}).check(z.superRefine((question, context) => {
  issueForDuplicateIds(question.choices, context, ['choices'], 'Interaction choice');
  validateQuestionSelectionConstraints(question, context);
})));
export const InteractionTransientAuthorQuestionV1Schema = lazyZodSchema(() => z.union([
  AuthorTextQuestionV1Schema,
  AuthorChoiceQuestionV1Schema,
]));
export type InteractionTransientAuthorQuestionV1 = z.infer<typeof InteractionTransientAuthorQuestionV1Schema>;

const InteractionTransientStrictJsonValueV1Schema = lazyZodSchema(() => z.pipe(z.unknown().check(z.superRefine((value, context) => {
  issueForMalformedUnicodePayload(value, context, 'Interaction approval input');
})), StrictJsonValueSchema));

const InteractionTransientApprovalSubjectV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('tool'),
  /** Native transcript correlation; interaction custody remains host-stamped. */
  toolCallId: z.optional(boundedIdentifier('Native tool call ids')),
  // Complete native tool names share the enclosing request's JSON-byte and
  // Unicode validation; they are not short host-generated custody identifiers.
  name: z.string().check(z.minLength(1)),
  input: InteractionTransientStrictJsonValueV1Schema,
}));
export type InteractionTransientApprovalSubjectV1 = z.infer<typeof InteractionTransientApprovalSubjectV1Schema>;

const QuestionsRequestV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(InteractionTransientRequestStampV1Schema, {
  kind: z.literal('questions'),
  title: z.optional(boundedTitleOrLabel('Interaction question titles')),
  questions: z.array(InteractionTransientQuestionV1Schema).check(z.minLength(1), z.maxLength(MAX_INTERACTION_TRANSIENT_QUESTIONS_V1)),
})).check(z.superRefine((request, context) => {
  issueForDuplicateIds(request.questions, context, ['questions'], 'Interaction question');
  issueForInvalidPayload(request, context, 'Interaction requests');
})));
const ApprovalRequestV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(InteractionTransientRequestStampV1Schema, {
  kind: z.literal('approval'),
  title: boundedTitleOrLabel('Interaction approval titles'),
  description: z.optional(boundedPrompt('Interaction approval descriptions')),
  subject: InteractionTransientApprovalSubjectV1Schema,
  allowedPersistenceScopes: z.optional(z.tuple([z.literal('session')])),
  nativeChoices: z.optional(NativePermissionChoicesV1Schema),
})).check(z.superRefine((request, context) => {
  issueForInvalidPayload(request, context, 'Interaction requests');
  if (request.scope.kind === 'app' && request.allowedPersistenceScopes !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['allowedPersistenceScopes'],
      message: 'App-scoped interactions cannot request Session persistence.',
    });
  }
})));
const ConfirmationRequestV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(InteractionTransientRequestStampV1Schema, {
  kind: z.literal('confirmation'),
  title: boundedTitleOrLabel('Interaction confirmation titles'),
  message: boundedPrompt('Interaction confirmation messages'),
})).check(z.superRefine((request, context) => issueForInvalidPayload(request, context, 'Interaction requests'))));

export const InteractionTransientRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  QuestionsRequestV1Schema,
  ApprovalRequestV1Schema,
  ConfirmationRequestV1Schema,
]).check(z.superRefine((request, context) => {
  issueForInvalidPayload(request, context, 'Interaction requests');
})));
export type InteractionTransientRequestV1 = z.infer<typeof InteractionTransientRequestV1Schema>;

export const InteractionTransientQuestionsAuthorRequestV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('questions'),
  title: z.optional(boundedTitleOrLabel('Interaction question titles')),
  questions: z.array(InteractionTransientAuthorQuestionV1Schema).check(z.minLength(1), z.maxLength(MAX_INTERACTION_TRANSIENT_QUESTIONS_V1)),
}).check(z.superRefine((request, context) => {
  issueForDuplicateIds(request.questions, context, ['questions'], 'Interaction question');
})));
/**
 * The author questions request as a shape a model can be given as JSON Schema: selection bounds are offered on
 * multiple choice; single choice admits only bounds that restate it (min 0 or 1, max 1), which models emit and the
 * consumer strips before admission. The cross-field refinements (duplicate ids, bounds) that JSON Schema can't carry
 * are left out. It describes what to answer; admission still goes through InteractionTransientQuestionsAuthorRequestV1Schema.
 */
export const InteractionTransientQuestionsAuthorModelShapeV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('questions'),
  title: z.optional(boundedTitleOrLabel('Interaction question titles')),
  questions: z.array(z.union([
    AuthorTextQuestionV1Schema,
    z.strictObject({ ...authorChoiceQuestionFields(), type: z.literal('singleChoice'),
      minSelections: z.optional(z.number().check(z.int(), z.gte(0), z.lte(1))), maxSelections: z.optional(z.literal(1)) }),
    z.strictObject({ ...authorChoiceQuestionFields(), type: z.literal('multipleChoice'), ...StructuredQuestionSelectionConstraintsV1Schema.shape }),
  ])).check(z.minLength(1), z.maxLength(MAX_INTERACTION_TRANSIENT_QUESTIONS_V1)),
}));
const ApprovalAuthorRequestV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('approval'),
  title: boundedTitleOrLabel('Interaction approval titles'),
  description: z.optional(boundedPrompt('Interaction approval descriptions')),
  subject: InteractionTransientApprovalSubjectV1Schema,
  allowSessionPersistence: z.optional(z.boolean()),
  nativeChoices: z.optional(NativePermissionChoicesV1Schema),
}));
const ConfirmationAuthorRequestV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('confirmation'),
  title: z.optional(boundedTitleOrLabel('Interaction confirmation titles')),
  message: boundedPrompt('Interaction confirmation messages'),
}));

export const InteractionTransientAuthorRequestV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  InteractionTransientQuestionsAuthorRequestV1Schema,
  ApprovalAuthorRequestV1Schema,
  ConfirmationAuthorRequestV1Schema,
]).check(z.superRefine((request, context) => issueForInvalidPayload(request, context, 'Interaction author requests'))));
export type InteractionTransientAuthorRequestV1 = z.infer<typeof InteractionTransientAuthorRequestV1Schema>;
export type InteractionTransientQuestionsAuthorRequestV1 = Extract<InteractionTransientAuthorRequestV1, { kind: 'questions' }>;
export type InteractionTransientApprovalAuthorRequestV1 = Extract<InteractionTransientAuthorRequestV1, { kind: 'approval' }>;
export type InteractionTransientConfirmationAuthorRequestV1 = Extract<InteractionTransientAuthorRequestV1, { kind: 'confirmation' }>;

export type InteractionTransientRequestNormalizationV1 =
  | Readonly<{ ok: true; value: InteractionTransientRequestV1 }>
  | Readonly<{ ok: false; code: 'invalid_interaction_request' }>;

/** Normalize a validated author form without manufacturing plugin custody. */
export function normalizeInteractionTransientQuestionsV1(request: InteractionTransientQuestionsAuthorRequestV1): Readonly<{
  kind: 'questions'; title?: string; questions: InteractionTransientQuestionV1[];
}> {
  return {
    kind: 'questions',
    ...(request.title === undefined ? {} : { title: request.title }),
    questions: request.questions.map((question): InteractionTransientQuestionV1 => (
      question.type === 'text'
        ? { ...question, required: question.required ?? false }
        : { ...question, required: question.required ?? false, allowCustom: question.allowCustom ?? false,
            choices: question.choices.map((choice) => ({ ...choice, label: choice.label ?? choice.id })) }
    )),
  };
}

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
        ...normalizeInteractionTransientQuestionsV1(request),
      }
    : request.kind === 'approval'
      ? {
          ...parsedStamp.data,
          kind: 'approval',
          title: request.title,
          ...(request.description === undefined ? {} : { description: request.description }),
          subject: request.subject,
          ...(request.nativeChoices === undefined ? {} : { nativeChoices: request.nativeChoices }),
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

export const InteractionTerminalStatusV1Schema = lazyZodSchema(() => z.enum([
  'userCancelled',
  'requesterAborted',
  'timedOut',
  'sessionEnded',
  'occurrenceRetired',
  'hostRestarted',
  'unavailable',
]));
export type InteractionTerminalStatusV1 = z.infer<typeof InteractionTerminalStatusV1Schema>;

const InteractionTransientChoiceSelectionV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('choice'),
    choiceId: boundedIdentifier('Interaction answer choice ids'),
  }),
  z.strictObject({
    kind: z.literal('custom'),
    value: boundedTextAnswer('Interaction custom answers'),
  }),
]));
export type InteractionTransientChoiceSelectionV1 = z.infer<typeof InteractionTransientChoiceSelectionV1Schema>;

export const InteractionTransientQuestionAnswerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    value: boundedTextAnswer('Interaction text answers'),
    note: z.optional(boundedTextAnswer('Interaction answer notes')),
  }),
  z.strictObject({
    kind: z.literal('singleChoice'),
    answer: InteractionTransientChoiceSelectionV1Schema,
    note: z.optional(boundedTextAnswer('Interaction answer notes')),
  }),
  z.strictObject({
    kind: z.literal('multipleChoice'),
    answers: z.array(InteractionTransientChoiceSelectionV1Schema).check(z.maxLength(MAX_INTERACTION_TRANSIENT_CHOICES_V1)),
    note: z.optional(boundedTextAnswer('Interaction answer notes')),
  }),
]).check(z.superRefine((answer, context) => {
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
})));
export type InteractionTransientQuestionAnswerV1 = z.infer<typeof InteractionTransientQuestionAnswerV1Schema>;

const QuestionsAnsweredResultV1Schema = lazyZodSchema(() => z.strictObject({
  requestId: boundedIdentifier('Interaction result request ids'),
  kind: z.literal('questions'),
  status: z.literal('answered'),
  answers: z.record(boundedIdentifier('Interaction answer question ids'), InteractionTransientQuestionAnswerV1Schema),
}));
const QuestionsTerminalResultV1Schema = lazyZodSchema(() => z.strictObject({
  requestId: boundedIdentifier('Interaction result request ids'),
  kind: z.literal('questions'),
  status: InteractionTerminalStatusV1Schema,
}));
const ApprovalApprovedResultV1Schema = lazyZodSchema(() => z.strictObject({
  nativeChoice: z.optional(NativePermissionChoiceAnswerV1Schema),
  requestId: boundedIdentifier('Interaction result request ids'),
  kind: z.literal('approval'),
  status: z.literal('approved'),
  persistence: z.optional(z.enum(['once', 'session'])),
}));
const ApprovalDeclinedResultV1Schema = lazyZodSchema(() => z.strictObject({
  nativeChoice: z.optional(NativePermissionChoiceAnswerV1Schema),
  requestId: boundedIdentifier('Interaction result request ids'),
  kind: z.literal('approval'),
  status: z.literal('declined'),
}));
const ApprovalTerminalResultV1Schema = lazyZodSchema(() => z.strictObject({
  nativeChoice: z.optional(NativePermissionChoiceAnswerV1Schema),
  requestId: boundedIdentifier('Interaction result request ids'),
  kind: z.literal('approval'),
  status: InteractionTerminalStatusV1Schema,
}));
const ConfirmationDecisionResultV1Schema = lazyZodSchema(() => z.strictObject({
  requestId: boundedIdentifier('Interaction result request ids'),
  kind: z.literal('confirmation'),
  status: z.enum(['approved', 'declined']),
}));
const ConfirmationTerminalResultV1Schema = lazyZodSchema(() => z.strictObject({
  requestId: boundedIdentifier('Interaction result request ids'),
  kind: z.literal('confirmation'),
  status: InteractionTerminalStatusV1Schema,
}));

export const InteractionTransientResultV1Schema = lazyZodSchema(() => z.union([
  QuestionsAnsweredResultV1Schema,
  QuestionsTerminalResultV1Schema,
  ApprovalApprovedResultV1Schema,
  ApprovalDeclinedResultV1Schema,
  ApprovalTerminalResultV1Schema,
  ConfirmationDecisionResultV1Schema,
  ConfirmationTerminalResultV1Schema,
]).check(z.superRefine((result, context) => issueForInvalidPayload(result, context, 'Interaction results'))));
export type InteractionTransientResultV1 = z.infer<typeof InteractionTransientResultV1Schema>;
export type InteractionTransientQuestionsResultV1 = Extract<InteractionTransientResultV1, { kind: 'questions' }>;
export type InteractionTransientApprovalResultV1 = Extract<InteractionTransientResultV1, { kind: 'approval' }>;
export type InteractionTransientConfirmationResultV1 = Extract<InteractionTransientResultV1, { kind: 'confirmation' }>;

export const InteractionTransientSettlementReceiptV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('settled'),
    result: InteractionTransientResultV1Schema,
  }),
  z.strictObject({
    status: z.literal('notCurrent'),
    requestId: boundedIdentifier('Interaction settlement request ids'),
  }),
]));
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
    || status === 'occurrenceRetired'
    || status === 'hostRestarted'
    || status === 'unavailable';
}

function isQuestionAnswerValid(
  question: InteractionTransientQuestionV1,
  answer: InteractionTransientQuestionAnswerV1,
): boolean {
  if (answer.note !== undefined && question.allowNote !== true) return false;
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
  const countIsValid = question.minSelections !== undefined || question.maxSelections !== undefined
    ? isStructuredQuestionSelectionCountValid(question, answer.answers.filter(selection => selection.kind === 'choice').length)
    : answer.answers.length > 0;
  return countIsValid
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
