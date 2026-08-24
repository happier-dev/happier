import { z } from 'zod';

export const STRUCTURED_QUESTION_LIMITS = Object.freeze({
  maxQuestions: 16,
  maxOptionsPerQuestion: 128,
  maxAnswersPerQuestion: 32,
  maxStringLength: 16_384,
  maxTotalStringLength: 262_144,
  maxLegacyDecodeStates: 4_096,
});

export type AskUserQuestionToolName = 'AskUserQuestion' | 'ask_user_question';

export function isAskUserQuestionToolName(value: unknown): value is AskUserQuestionToolName {
  return value === 'AskUserQuestion' || value === 'ask_user_question';
}

export type StructuredQuestionOptionAnswerLike =
  | string
  | Readonly<{
      value?: unknown;
      choice?: unknown;
      label?: unknown;
    }>;

function readExactNonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Resolves the exact value sent back to a question producer. Labels remain presentation
 * text; a producer may provide a distinct value or choice identifier for its wire reply.
 */
export function resolveStructuredQuestionOptionAnswerValue(option: unknown): string | null {
  if (typeof option === 'string') return readExactNonBlankString(option);
  if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
  const candidate = option as Exclude<StructuredQuestionOptionAnswerLike, string>;
  return readExactNonBlankString(candidate.value)
    ?? readExactNonBlankString(candidate.choice)
    ?? readExactNonBlankString(candidate.label);
}

export type StructuredQuestionLike = Readonly<{
  id?: unknown;
  question?: unknown;
  header?: unknown;
  multiSelect?: unknown;
  multiple?: unknown;
  options?: unknown;
  freeform?: unknown;
}>;

export type StructuredQuestionDescriptorOption = Readonly<{
  label: string;
  answerValue: string;
  value?: string;
  choice?: string;
  description?: string;
}>;

export type StructuredQuestionDescriptor = Readonly<{
  id?: string;
  question?: string;
  header?: string;
  responseKey: string;
  keys: readonly string[];
  options: readonly StructuredQuestionDescriptorOption[];
  multiSelect: boolean;
  freeform?: Readonly<{
    placeholder?: string;
    description?: string;
    initialValue?: string;
    multiline?: boolean;
    allowEmpty?: boolean;
  }>;
  allowsFreeform: boolean;
}>;

export type NormalizeStructuredQuestionDescriptorsResult =
  | Readonly<{ ok: true; questions: readonly StructuredQuestionDescriptor[] }>
  | Readonly<{ ok: false }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Canonical grammar and projection for published AskUserQuestion descriptors.
 * Unknown provider fields deliberately remain outside this projection so the
 * publication boundary can preserve them in its detached source snapshot.
 */
export function normalizeStructuredQuestionDescriptors(
  input: unknown,
): NormalizeStructuredQuestionDescriptorsResult {
  try {
    if (!Array.isArray(input) || input.length === 0 || input.length > STRUCTURED_QUESTION_LIMITS.maxQuestions) {
      return { ok: false };
    }

    let totalStringLength = 0;
    const readString = (value: unknown, optional = false): string | undefined => {
      if (value === undefined && optional) return undefined;
      if (typeof value !== 'string' || value.length > STRUCTURED_QUESTION_LIMITS.maxStringLength) {
        throw new Error('invalid structured-question string');
      }
      totalStringLength += value.length;
      if (totalStringLength > STRUCTURED_QUESTION_LIMITS.maxTotalStringLength) {
        throw new Error('structured-question descriptors exceed bounds');
      }
      return value;
    };
    const readOptionalBoolean = (value: unknown): boolean | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== 'boolean') throw new Error('invalid structured-question boolean');
      return value;
    };

    const seenKeys = new Set<string>();
    const questions = input.map((rawQuestion): StructuredQuestionDescriptor => {
      if (!isRecord(rawQuestion)) throw new Error('invalid structured question');
      const id = readString(rawQuestion.id, true);
      const question = readString(rawQuestion.question, true);
      const header = readString(rawQuestion.header, true);
      const responseKey = readExactNonBlankString(question) ?? readExactNonBlankString(header);
      if (!responseKey) throw new Error('missing structured-question display/response key');

      const keys = Object.freeze([...new Set([
        readExactNonBlankString(id),
        responseKey,
      ].filter((key): key is string => key !== null))]);
      for (const key of keys) {
        if (seenKeys.has(key)) throw new Error('duplicate structured-question key');
        seenKeys.add(key);
      }

      const rawOptions = rawQuestion.options === undefined ? [] : rawQuestion.options;
      if (!Array.isArray(rawOptions) || rawOptions.length > STRUCTURED_QUESTION_LIMITS.maxOptionsPerQuestion) {
        throw new Error('invalid structured-question options');
      }
      const seenOptionValues = new Set<string>();
      const options = Object.freeze(rawOptions.map((rawOption): StructuredQuestionDescriptorOption => {
        if (typeof rawOption === 'string') {
          const label = readString(rawOption)!;
          const answerValue = readExactNonBlankString(label);
          if (!answerValue || seenOptionValues.has(answerValue)) throw new Error('invalid structured-question option');
          seenOptionValues.add(answerValue);
          return Object.freeze({ label, answerValue });
        }
        if (!isRecord(rawOption)) throw new Error('invalid structured-question option');
        const value = readString(rawOption.value, true);
        const choice = readString(rawOption.choice, true);
        const label = readString(rawOption.label, true);
        const description = readString(rawOption.description, true);
        const answerValue = resolveStructuredQuestionOptionAnswerValue({ value, choice, label });
        const displayLabel = readExactNonBlankString(label) ?? answerValue;
        if (!answerValue || !displayLabel || seenOptionValues.has(answerValue)) {
          throw new Error('invalid structured-question option');
        }
        seenOptionValues.add(answerValue);
        return Object.freeze({
          ...(value !== undefined ? { value } : {}),
          ...(choice !== undefined ? { choice } : {}),
          label: displayLabel,
          ...(description !== undefined ? { description } : {}),
          answerValue,
        });
      }));

      let freeform: StructuredQuestionDescriptor['freeform'];
      if (rawQuestion.freeform === true) {
        freeform = Object.freeze({});
      } else if (rawQuestion.freeform !== undefined && rawQuestion.freeform !== false && rawQuestion.freeform !== null) {
        if (!isRecord(rawQuestion.freeform)) throw new Error('invalid structured-question freeform descriptor');
        const placeholder = readString(rawQuestion.freeform.placeholder, true);
        const description = readString(rawQuestion.freeform.description, true);
        const initialValue = readString(rawQuestion.freeform.initialValue, true);
        const multiline = readOptionalBoolean(rawQuestion.freeform.multiline);
        const allowEmpty = readOptionalBoolean(rawQuestion.freeform.allowEmpty);
        freeform = Object.freeze({
          ...(placeholder !== undefined ? { placeholder } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(initialValue !== undefined ? { initialValue } : {}),
          ...(multiline !== undefined ? { multiline } : {}),
          ...(allowEmpty !== undefined ? { allowEmpty } : {}),
        });
      }

      const multiSelectField = readOptionalBoolean(rawQuestion.multiSelect);
      const multipleField = readOptionalBoolean(rawQuestion.multiple);
      const multiSelect = multiSelectField === true || multipleField === true;
      return Object.freeze({
        ...(id !== undefined ? { id } : {}),
        ...(question !== undefined ? { question } : {}),
        ...(header !== undefined ? { header } : {}),
        responseKey,
        keys,
        options,
        multiSelect,
        ...(freeform !== undefined ? { freeform } : {}),
        allowsFreeform: freeform !== undefined || options.length === 0,
      });
    });

    return { ok: true, questions: Object.freeze(questions) };
  } catch {
    return { ok: false };
  }
}

export const StructuredQuestionAnswersV1Schema = z
  .unknown()
  .superRefine((input, ctx) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Structured answers must be an object' });
      return;
    }
    const entries = Object.entries(input);
    if (entries.length > STRUCTURED_QUESTION_LIMITS.maxQuestions) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Too many structured questions' });
    }

    let totalLength = 0;
    for (const [question, values] of entries) {
      if (question.length === 0 || question.length > STRUCTURED_QUESTION_LIMITS.maxStringLength) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [question], message: 'Invalid structured question key' });
      }
      totalLength += question.length;
      if (!Array.isArray(values) || values.length > STRUCTURED_QUESTION_LIMITS.maxAnswersPerQuestion) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [question], message: 'Invalid structured answer list' });
        continue;
      }
      const seen = new Set<string>();
      for (const value of values) {
        if (typeof value !== 'string' || value.length > STRUCTURED_QUESTION_LIMITS.maxStringLength) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [question], message: 'Invalid structured answer value' });
          continue;
        }
        totalLength += value.length;
        if (seen.has(value)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [question], message: 'Duplicate structured answer value' });
        }
        seen.add(value);
      }
    }
    if (totalLength > STRUCTURED_QUESTION_LIMITS.maxTotalStringLength) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Structured answers exceed the total size limit' });
    }
  })
  .transform((input) => {
    const normalized = Object.create(null) as Record<string, readonly string[]>;
    for (const [question, values] of Object.entries(input as Record<string, unknown>)) {
      normalized[question] = Object.freeze([...(values as string[])]);
    }
    return Object.freeze(normalized) as StructuredQuestionAnswersV1;
  });

export type StructuredQuestionAnswersV1 = Readonly<Record<string, ReadonlyArray<string>>>;

export type BuiltAskUserQuestionAnswerPayload =
  | Readonly<{
      kind: 'modern';
      send: Readonly<{
        protocol: 'structured-question-v1';
        structuredAnswersV1: StructuredQuestionAnswersV1;
      }>;
    }>
  | Readonly<{
      kind: 'legacy';
      send: Readonly<{
        protocol: 'legacy-permission';
        answers: Readonly<Record<string, string>>;
      }>;
    }>
  | Readonly<{
      kind: 'requires_cli_update';
      unsafeQuestionKeys: ReadonlyArray<string>;
    }>;

export type SendableAskUserQuestionAnswerPayload = Extract<
  BuiltAskUserQuestionAnswerPayload,
  { kind: 'modern' | 'legacy' }
>['send'];

export const StructuredQuestionResponseV1Schema = z.object({
  id: z.string().trim().min(1).max(512),
  structuredAnswersV1: StructuredQuestionAnswersV1Schema,
}).strict();

export type StructuredQuestionResponseV1 = z.infer<typeof StructuredQuestionResponseV1Schema>;

function historicalParseLegacyAnswer(value: string): string[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Builds the deployed comma-delimited permission payload only when its historical parser
 * reconstructs the exact canonical arrays. A null result means the caller must not downgrade.
 */
export function buildLegacyStructuredQuestionAnswers(
  answers: StructuredQuestionAnswersV1,
): Readonly<Record<string, string>> | null {
  const legacy = Object.create(null) as Record<string, string>;
  for (const [question, values] of Object.entries(answers)) {
    if (values.length === 0) return null;
    const encoded = values.join(', ');
    if (!arraysEqual(historicalParseLegacyAnswer(encoded), values)) return null;
    legacy[question] = encoded;
  }
  return Object.freeze(legacy);
}

export function buildStructuredQuestionAnswerPayload(
  answers: StructuredQuestionAnswersV1,
  structuredQuestionAnswersV1Supported: boolean,
): BuiltAskUserQuestionAnswerPayload {
  const normalized = StructuredQuestionAnswersV1Schema.parse(answers);
  if (structuredQuestionAnswersV1Supported) {
    return {
      kind: 'modern',
      send: { protocol: 'structured-question-v1', structuredAnswersV1: normalized },
    };
  }
  const legacy = buildLegacyStructuredQuestionAnswers(normalized);
  const unsafeQuestionKeys = legacy
    ? []
    : Object.entries(normalized)
        .filter(([question, values]) => buildLegacyStructuredQuestionAnswers({ [question]: values }) === null)
        .map(([question]) => question);
  return legacy
    ? { kind: 'legacy', send: { protocol: 'legacy-permission', answers: legacy } }
    : { kind: 'requires_cli_update', unsafeQuestionKeys };
}
