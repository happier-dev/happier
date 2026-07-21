import { createHash } from 'node:crypto';
import { z } from 'zod';

import type {
  AcpExtensionHandlerContext,
  AcpExtensionHandlers,
  AcpPermissionHandler,
} from '@/agent/acp/AcpBackend';
import {
  STRUCTURED_QUESTION_LIMITS,
  type StructuredQuestionAnswersV1,
} from '@happier-dev/protocol';
import {
  InvalidAskUserQuestionInputError,
  normalizeAskUserQuestionInputForPublication,
} from '@/agent/questions/normalizeAskUserQuestionInput';
import {
  GROK_MCP_SERVERS_UPDATED_METHOD,
  handleGrokMcpServersUpdatedNotification,
} from './mcpServersUpdatedNotification';

export const GROK_ASK_USER_QUESTION_METHODS = [
  'x.ai/ask_user_question',
  '_x.ai/ask_user_question',
] as const;

type GrokAskUserQuestionMethod = (typeof GROK_ASK_USER_QUESTION_METHODS)[number];
const GROK_FREEFORM_OPTION_LABEL = 'Other' as const;

const NonEmptyExactString = z.string()
  .max(STRUCTURED_QUESTION_LIMITS.maxStringLength)
  .refine((value) => value.trim().length > 0, 'must be non-empty');
const NonEmptyExactIdentifier = z.string()
  .max(512)
  .refine((value) => value.length > 0 && value === value.trim(), 'must be a non-empty exact identifier');

const GrokQuestionOptionSchema = z.object({
  id: NonEmptyExactIdentifier.optional(),
  label: NonEmptyExactString,
  description: z.string().max(STRUCTURED_QUESTION_LIMITS.maxStringLength).optional(),
  preview: z.string().max(STRUCTURED_QUESTION_LIMITS.maxStringLength).optional(),
}).strict();

const GrokQuestionSchema = z.object({
  id: NonEmptyExactIdentifier.optional(),
  question: NonEmptyExactString,
  options: z.array(GrokQuestionOptionSchema)
    .max(STRUCTURED_QUESTION_LIMITS.maxOptionsPerQuestion),
  multiSelect: z.boolean().nullable().optional(),
}).strict();

const GrokQuestionPayloadSchema = z.object({
  sessionId: NonEmptyExactIdentifier,
  toolCallId: NonEmptyExactIdentifier,
  questions: z.array(GrokQuestionSchema)
    .min(1, 'A Grok question request must contain at least one question')
    .max(STRUCTURED_QUESTION_LIMITS.maxQuestions),
  mode: z.enum(['default', 'plan']),
}).strict();

const GrokWrappedQuestionPayloadSchema = z.object({
  method: z.enum(GROK_ASK_USER_QUESTION_METHODS),
  params: GrokQuestionPayloadSchema,
}).strict();

type GrokQuestionPayload = z.infer<typeof GrokQuestionPayloadSchema>;
type GrokQuestion = GrokQuestionPayload['questions'][number];

type ParsedGrokQuestion = Readonly<{
  localAnswerKey: string;
  responseKey: string;
  question: GrokQuestion;
}>;

export type ParsedGrokAskUserQuestionRequest = Readonly<{
  sessionId: string;
  toolCallId: string;
  mode: 'default' | 'plan';
  questions: ReadonlyArray<ParsedGrokQuestion>;
  askUserQuestionInput: Readonly<{
    _grokCorrelation: Readonly<{
      v: 1;
      digest: string;
    }>;
    questions: ReadonlyArray<Readonly<{
      id: string;
      header: 'Question';
      question: string;
      multiSelect: boolean;
      options: ReadonlyArray<Readonly<{ label: string; description: string }>>;
      freeform: Readonly<{ placeholder: typeof GROK_FREEFORM_OPTION_LABEL }>;
    }>>;
  }>;
}>;

type GrokQuestionAnnotation = Readonly<{ preview?: string; notes?: string }>;
export type GrokAskUserQuestionResponse =
  | Readonly<{
      outcome: 'accepted';
      answers: Readonly<Record<string, ReadonlyArray<string>>>;
      annotations?: Readonly<Record<string, GrokQuestionAnnotation>>;
    }>
  | Readonly<{ outcome: 'cancelled' }>;

export class GrokAskUserQuestionCodecError extends Error {
  readonly name = 'GrokAskUserQuestionCodecError';

  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function isGrokAskUserQuestionMethod(value: string): value is GrokAskUserQuestionMethod {
  return (GROK_ASK_USER_QUESTION_METHODS as readonly string[]).includes(value);
}

function parsePayload(rawParams: Record<string, unknown>): GrokQuestionPayload {
  const wrapped = Object.prototype.hasOwnProperty.call(rawParams, 'method')
    || Object.prototype.hasOwnProperty.call(rawParams, 'params');
  const parsed = wrapped
    ? GrokWrappedQuestionPayloadSchema.safeParse(rawParams)
    : GrokQuestionPayloadSchema.safeParse(rawParams);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    throw new GrokAskUserQuestionCodecError(
      'GROK_QUESTION_PAYLOAD_INVALID',
      `Invalid Grok question payload: ${location}${issue?.message ?? 'payload validation failed'}`,
    );
  }
  return 'params' in parsed.data ? parsed.data.params : parsed.data;
}

function validateQuestionCorrelations(questions: readonly GrokQuestion[]): ReadonlyArray<ParsedGrokQuestion> {
  const responseKeys = new Set<string>();
  const localKeys = new Set<string>();
  const correlationKeyOwners = new Map<string, number>();
  let totalStringLength = 0;
  const parsed: ParsedGrokQuestion[] = [];

  for (const [questionIndex, question] of questions.entries()) {
    totalStringLength += question.question.length;
    if (responseKeys.has(question.question)) {
      throw new GrokAskUserQuestionCodecError(
        'GROK_QUESTION_RESPONSE_KEY_DUPLICATE',
        'Grok question response keys must be unique',
      );
    }
    responseKeys.add(question.question);

    const localAnswerKey = question.id ?? question.question;
    if (localKeys.has(localAnswerKey)) {
      throw new GrokAskUserQuestionCodecError(
        'GROK_QUESTION_CORRELATION_KEY_DUPLICATE',
        'Grok question correlation keys must be unique',
      );
    }
    localKeys.add(localAnswerKey);
    for (const key of new Set([question.question, localAnswerKey])) {
      const existingOwner = correlationKeyOwners.get(key);
      if (existingOwner !== undefined && existingOwner !== questionIndex) {
        throw new GrokAskUserQuestionCodecError(
          'GROK_QUESTION_CORRELATION_KEY_DUPLICATE',
          'Grok question correlation keys must not overlap another response key',
        );
      }
      correlationKeyOwners.set(key, questionIndex);
    }

    const optionLabels = new Set<string>();
    for (const option of question.options) {
      totalStringLength += option.label.length
        + (option.description?.length ?? 0)
        + (option.preview?.length ?? 0)
        + (option.id?.length ?? 0);
      if (optionLabels.has(option.label)) {
        throw new GrokAskUserQuestionCodecError(
          'GROK_QUESTION_OPTION_LABEL_DUPLICATE',
          'Grok question option labels must be unique',
        );
      }
      optionLabels.add(option.label);
    }

    parsed.push({ localAnswerKey, responseKey: question.question, question });
  }

  if (totalStringLength > STRUCTURED_QUESTION_LIMITS.maxTotalStringLength) {
    throw new GrokAskUserQuestionCodecError(
      'GROK_QUESTION_PAYLOAD_TOO_LARGE',
      'Grok question payload exceeds the structured-interaction size limit',
    );
  }
  return parsed;
}

export function parseGrokAskUserQuestionRequest(
  rawParams: Record<string, unknown>,
  context: AcpExtensionHandlerContext,
): ParsedGrokAskUserQuestionRequest {
  if (!isGrokAskUserQuestionMethod(context.method)) {
    throw new GrokAskUserQuestionCodecError(
      'GROK_QUESTION_METHOD_INVALID',
      'Unsupported Grok question method',
    );
  }
  if (typeof context.sessionId !== 'string' || context.sessionId.length === 0) {
    throw new GrokAskUserQuestionCodecError(
      'GROK_QUESTION_SESSION_NOT_BOUND',
      'Grok question arrived before an ACP session was bound',
    );
  }

  const payload = parsePayload(rawParams);
  if (payload.sessionId !== context.sessionId) {
    throw new GrokAskUserQuestionCodecError(
      'GROK_QUESTION_SESSION_MISMATCH',
      'Grok question session does not match the bound ACP session',
    );
  }

  const questions = validateQuestionCorrelations(payload.questions);
  const correlationDigest = createHash('sha256')
    .update(JSON.stringify({ mode: payload.mode, questions: payload.questions }))
    .digest('hex');
  const askUserQuestionInput = {
    // The shared coordinator deduplicates by its complete tool input. Preserve every
    // validated provider field in a non-reversible digest so a reused tool id cannot
    // silently share a decision or persist provider-only preview data.
    _grokCorrelation: {
      v: 1 as const,
      digest: correlationDigest,
    },
    questions: questions.map(({ localAnswerKey, question }) => ({
      id: localAnswerKey,
      header: 'Question' as const,
      question: question.question,
      multiSelect: question.multiSelect === true,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description ?? option.label,
      })),
      freeform: { placeholder: GROK_FREEFORM_OPTION_LABEL },
    })),
  } satisfies ParsedGrokAskUserQuestionRequest['askUserQuestionInput'];
  try {
    normalizeAskUserQuestionInputForPublication('AskUserQuestion', askUserQuestionInput);
  } catch (error) {
    if (error instanceof InvalidAskUserQuestionInputError) {
      throw new GrokAskUserQuestionCodecError(
        'GROK_QUESTION_PAYLOAD_TOO_LARGE',
        'Grok question payload exceeds the structured-interaction size limit',
      );
    }
    throw error;
  }
  return {
    sessionId: payload.sessionId,
    toolCallId: payload.toolCallId,
    mode: payload.mode,
    questions,
    askUserQuestionInput,
  };
}

function readOwnAnswer(
  answers: StructuredQuestionAnswersV1,
  question: ParsedGrokQuestion,
): ReadonlyArray<string> {
  const hasLocalKey = Object.prototype.hasOwnProperty.call(answers, question.localAnswerKey);
  const answerKey = hasLocalKey ? question.localAnswerKey : question.responseKey;
  const values = answers[answerKey];
  if (!values) {
    throw new GrokAskUserQuestionCodecError(
      'GROK_QUESTION_ANSWER_CONTRACT_VIOLATION',
      'Validated Grok question answers are missing their correlation key',
    );
  }
  return values;
}

export function buildGrokAskUserQuestionAcceptedResponse(
  parsed: ParsedGrokAskUserQuestionRequest,
  answers: StructuredQuestionAnswersV1,
): Extract<GrokAskUserQuestionResponse, { outcome: 'accepted' }> {
  const responseAnswers = Object.create(null) as Record<string, ReadonlyArray<string>>;
  const responseAnnotations = Object.create(null) as Record<string, GrokQuestionAnnotation>;

  for (const parsedQuestion of parsed.questions) {
    const values = readOwnAnswer(answers, parsedQuestion);
    const optionsByLabel = new Map(
      parsedQuestion.question.options.map((option) => [option.label, option] as const),
    );
    if (
      optionsByLabel.has(GROK_FREEFORM_OPTION_LABEL) &&
      values.includes(GROK_FREEFORM_OPTION_LABEL) &&
      values.some((value) => !optionsByLabel.has(value))
    ) {
      throw new GrokAskUserQuestionCodecError(
        'GROK_QUESTION_ANSWER_CONTRACT_VIOLATION',
        'A Grok question response is ambiguous when a known Other option is combined with freeform text',
      );
    }
    let freeformNotes: string | undefined;
    const providerValues = values.map((value) => {
      if (optionsByLabel.has(value)) return value;
      if (freeformNotes !== undefined) {
        throw new GrokAskUserQuestionCodecError(
          'GROK_QUESTION_ANSWER_CONTRACT_VIOLATION',
          'A Grok question response cannot encode multiple freeform answers',
        );
      }
      freeformNotes = value;
      return GROK_FREEFORM_OPTION_LABEL;
    });
    responseAnswers[parsedQuestion.responseKey] = Object.freeze(providerValues);
    const annotation: { preview?: string; notes?: string } = {};
    if (parsedQuestion.question.multiSelect !== true) {
      const preview = optionsByLabel.get(values[0] ?? '')?.preview;
      if (typeof preview === 'string' && preview.trim().length > 0) {
        annotation.preview = preview;
      }
    }
    if (freeformNotes !== undefined) annotation.notes = freeformNotes;
    if (Object.keys(annotation).length > 0) {
      responseAnnotations[parsedQuestion.responseKey] = Object.freeze(annotation);
    }
  }

  return {
    outcome: 'accepted',
    answers: Object.freeze(responseAnswers),
    ...(Object.keys(responseAnnotations).length > 0
      ? { annotations: Object.freeze(responseAnnotations) }
      : {}),
  };
}

function isApprovedDecision(decision: string): boolean {
  return decision === 'approved'
    || decision === 'approved_for_session'
    || decision === 'approved_execpolicy_amendment';
}

function awaitPermissionDecision(
  decision: Promise<PermissionDecision>,
  context: AcpExtensionHandlerContext,
): Promise<PermissionDecision> {
  if (context.signal.aborted) {
    return Promise.reject(
      context.signal.reason instanceof Error
        ? context.signal.reason
        : new Error('Grok question request aborted'),
    );
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(
      context.signal.reason instanceof Error
        ? context.signal.reason
        : new Error('Grok question request aborted'),
    );
    context.signal.addEventListener('abort', onAbort, { once: true });
    decision.then(resolve, reject).finally(() => {
      context.signal.removeEventListener('abort', onAbort);
    });
  });
}

type PermissionDecision = Awaited<ReturnType<AcpPermissionHandler['handleToolCall']>> & {
  answers?: StructuredQuestionAnswersV1;
};

export function buildGrokExtensionHandlers(params: Readonly<{
  permissionHandler?: AcpPermissionHandler;
}>): AcpExtensionHandlers {
  const permissionHandler = params.permissionHandler;
  const notifications = {
    [GROK_MCP_SERVERS_UPDATED_METHOD]: handleGrokMcpServersUpdatedNotification,
  };

  if (!permissionHandler) {
    return { notifications };
  }

  const handleAskUserQuestion = async (
    rawParams: Record<string, unknown>,
    context: AcpExtensionHandlerContext,
  ): Promise<Record<string, unknown>> => {
    const parsed = parseGrokAskUserQuestionRequest(rawParams, context);
    const decision = await awaitPermissionDecision(
      permissionHandler.handleToolCall(
        parsed.toolCallId,
        'AskUserQuestion',
        parsed.askUserQuestionInput,
      ) as Promise<PermissionDecision>,
      context,
    );
    if (!isApprovedDecision(decision.decision)) return { outcome: 'cancelled' };
    if (!decision.answers) {
      throw new GrokAskUserQuestionCodecError(
        'GROK_QUESTION_ANSWER_CONTRACT_VIOLATION',
        'Approved Grok question decision did not include validated answers',
      );
    }
    return buildGrokAskUserQuestionAcceptedResponse(parsed, decision.answers);
  };

  return {
    requests: {
      'x.ai/ask_user_question': handleAskUserQuestion,
      '_x.ai/ask_user_question': handleAskUserQuestion,
    },
    notifications,
  };
}
