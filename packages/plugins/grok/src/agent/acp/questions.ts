import type {
  InteractionTransientAuthorQuestionV1,
  InteractionTransientQuestionAnswerV1,
  InteractionTransientQuestionsResultV1,
} from '@happier-dev/plugin-sdk/interactions';

export const GROK_ASK_USER_QUESTION_METHODS = Object.freeze([
  'x.ai/ask_user_question',
  '_x.ai/ask_user_question',
] as const);
export const GROK_FREEFORM_OPTION_LABEL = 'Other' as const;

const MAX_STRING_LENGTH = 16_384;
const MAX_TOTAL_STRING_LENGTH = 65_536;

type ProviderOption = Readonly<{
  id?: string;
  label: string;
  description?: string;
  preview?: string;
}>;
type ProviderQuestion = Readonly<{
  id?: string;
  question: string;
  options: readonly ProviderOption[];
  multiSelect?: boolean | null;
}>;
type ParsedQuestion = Readonly<{
  answerKey: string;
  responseKey: string;
  question: ProviderQuestion;
}>;
export type ParsedGrokQuestionRequest = Readonly<{
  sessionId: string;
  toolCallId: string;
  mode: 'default' | 'plan';
  questions: readonly ParsedQuestion[];
}>;
type QuestionAnnotation = Readonly<{ preview?: string; notes?: string }>;
export type GrokQuestionResponse =
  | Readonly<{
      outcome: 'accepted';
      answers: Readonly<Record<string, readonly string[]>>;
      annotations?: Readonly<Record<string, QuestionAnnotation>>;
    }>
  | Readonly<{ outcome: 'cancelled' }>;

function asRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function assertOnlyKeys(record: Readonly<Record<string, unknown>>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedSet.has(key))) {
    throw new Error(`${label} contains unsupported fields`);
  }
}

function readIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty exact identifier`);
  }
  return value;
}

function readText(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > MAX_STRING_LENGTH || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function parseOption(value: unknown): ProviderOption {
  const record = asRecord(value, 'Grok question option');
  assertOnlyKeys(record, ['id', 'label', 'description', 'preview'], 'Grok question option');
  return Object.freeze({
    ...(record.id === undefined ? {} : { id: readIdentifier(record.id, 'Grok option id') }),
    label: readText(record.label, 'Grok option label'),
    ...(record.description === undefined ? {} : { description: readText(record.description, 'Grok option description', true) }),
    ...(record.preview === undefined ? {} : { preview: readText(record.preview, 'Grok option preview', true) }),
  });
}

function parseQuestion(value: unknown): ProviderQuestion {
  const record = asRecord(value, 'Grok question');
  assertOnlyKeys(record, ['id', 'question', 'options', 'multiSelect'], 'Grok question');
  if (!Array.isArray(record.options) || record.options.length > 64) {
    throw new Error('Grok question options must be an array with at most 64 entries');
  }
  if (record.multiSelect !== undefined && record.multiSelect !== null && typeof record.multiSelect !== 'boolean') {
    throw new Error('Grok question multiSelect must be boolean or null');
  }
  return Object.freeze({
    ...(record.id === undefined ? {} : { id: readIdentifier(record.id, 'Grok question id') }),
    question: readText(record.question, 'Grok question text'),
    options: Object.freeze(record.options.map(parseOption)),
    ...(record.multiSelect === undefined ? {} : { multiSelect: record.multiSelect }),
  });
}

function validateCorrelations(questions: readonly ProviderQuestion[]): readonly ParsedQuestion[] {
  const responseKeys = new Set<string>();
  const answerKeys = new Set<string>();
  const allCorrelationOwners = new Map<string, number>();
  return Object.freeze(questions.map((question, index) => {
    if (responseKeys.has(question.question)) {
      throw new Error('Grok question response keys must be unique');
    }
    responseKeys.add(question.question);
    const answerKey = question.id ?? question.question;
    if (answerKeys.has(answerKey)) {
      throw new Error('Grok question correlation keys must be unique');
    }
    answerKeys.add(answerKey);
    for (const key of new Set([question.question, answerKey])) {
      const owner = allCorrelationOwners.get(key);
      if (owner !== undefined && owner !== index) {
        throw new Error('Grok question correlation keys must be unique across questions');
      }
      allCorrelationOwners.set(key, index);
    }
    const labels = new Set<string>();
    for (const option of question.options) {
      if (labels.has(option.label)) throw new Error('Grok question option labels must be unique');
      labels.add(option.label);
    }
    return Object.freeze({ answerKey, responseKey: question.question, question });
  }));
}

export function parseGrokQuestionRequest(
  input: unknown,
  boundProviderSessionId: string,
  method?: string,
): ParsedGrokQuestionRequest {
  const outer = asRecord(input, 'Grok question payload');
  const isWrapped = Object.hasOwn(outer, 'method') || Object.hasOwn(outer, 'params');
  let payload = outer;
  if (isWrapped) {
    assertOnlyKeys(outer, ['method', 'params'], 'Wrapped Grok question payload');
    if (!(GROK_ASK_USER_QUESTION_METHODS as readonly string[]).includes(String(outer.method))) {
      throw new Error('Wrapped Grok question method is unsupported');
    }
    if (method !== undefined && outer.method !== method) {
      throw new Error('Wrapped Grok question method does not match the ACP request method');
    }
    payload = asRecord(outer.params, 'Wrapped Grok question params');
  }
  assertOnlyKeys(payload, ['sessionId', 'toolCallId', 'questions', 'mode'], 'Grok question payload');
  const sessionId = readIdentifier(payload.sessionId, 'Grok question sessionId');
  const toolCallId = readIdentifier(payload.toolCallId, 'Grok question toolCallId');
  if (!Array.isArray(payload.questions) || payload.questions.length === 0 || payload.questions.length > 16) {
    throw new Error('Grok questions must contain between 1 and 16 entries');
  }
  if (payload.mode !== 'default' && payload.mode !== 'plan') {
    throw new Error('Grok question mode must be default or plan');
  }
  const questions = payload.questions.map(parseQuestion);
  const totalStringLength = questions.reduce((total, question) => total
    + (question.id?.length ?? 0)
    + question.question.length
    + question.options.reduce((optionTotal, option) => optionTotal
      + (option.id?.length ?? 0)
      + option.label.length
      + (option.description?.length ?? 0)
      + (option.preview?.length ?? 0), 0), 0);
  if (totalStringLength > MAX_TOTAL_STRING_LENGTH) {
    throw new Error('Grok question payload exceeds the total string limit');
  }
  if (sessionId !== boundProviderSessionId) {
    throw new Error('Grok question session does not match the bound ACP session');
  }
  return Object.freeze({
    sessionId,
    toolCallId,
    mode: payload.mode,
    questions: validateCorrelations(questions),
  });
}

export function buildGrokHostQuestions(
  request: ParsedGrokQuestionRequest,
): [InteractionTransientAuthorQuestionV1, ...InteractionTransientAuthorQuestionV1[]] {
  const questions = request.questions.map(({ answerKey, question }): InteractionTransientAuthorQuestionV1 => {
    if (question.options.length === 0) {
      return Object.freeze({ id: answerKey, prompt: question.question, type: 'text', required: true });
    }
    const choices = question.options.map((option) => ({
      id: option.label,
      label: option.label,
      description: option.description ?? option.label,
    })) as [
      Readonly<{ id: string; label: string; description: string }>,
      ...Readonly<{ id: string; label: string; description: string }>[],
    ];
    return Object.freeze({
      id: answerKey,
      prompt: question.question,
      type: question.multiSelect === true ? 'multipleChoice' : 'singleChoice',
      required: true,
      choices,
      allowCustom: true,
    });
  });
  return questions as [InteractionTransientAuthorQuestionV1, ...InteractionTransientAuthorQuestionV1[]];
}

function readAnswerItems(answer: InteractionTransientQuestionAnswerV1): readonly Readonly<{
  kind: 'choice' | 'custom';
  value: string;
}>[] {
  if (answer.kind === 'text') return [{ kind: 'custom', value: answer.value }];
  if (answer.kind === 'singleChoice') {
    return [{
      kind: answer.answer.kind,
      value: answer.answer.kind === 'choice' ? answer.answer.choiceId : answer.answer.value,
    }];
  }
  return answer.answers.map((item) => ({
    kind: item.kind,
    value: item.kind === 'choice' ? item.choiceId : item.value,
  }));
}

export function buildGrokQuestionResponse(
  request: ParsedGrokQuestionRequest,
  result: InteractionTransientQuestionsResultV1,
): GrokQuestionResponse {
  if (result.status !== 'answered') return { outcome: 'cancelled' };
  const answers: Record<string, readonly string[]> = Object.create(null);
  const annotations: Record<string, QuestionAnnotation> = Object.create(null);

  for (const parsedQuestion of request.questions) {
    const answer = result.answers[parsedQuestion.answerKey];
    if (!answer) throw new Error('Validated Grok answers are missing their correlation key');
    const items = readAnswerItems(answer);
    const optionsByLabel = new Map(
      parsedQuestion.question.options.map((option) => [option.label, option] as const),
    );
    const customItems = items.filter((item) => item.kind === 'custom');
    if (customItems.length > 1) throw new Error('Grok cannot encode multiple freeform answers');
    if (
      customItems.length === 1
      && items.some((item) => item.kind === 'choice' && item.value === GROK_FREEFORM_OPTION_LABEL)
      && optionsByLabel.has(GROK_FREEFORM_OPTION_LABEL)
    ) {
      throw new Error('Grok literal Other plus freeform response is ambiguous');
    }

    for (const item of items) {
      if (item.kind === 'choice' && !optionsByLabel.has(item.value)) {
        throw new Error('Grok answer references an unadvertised option');
      }
      if (item.kind === 'custom' && item.value.trim().length === 0) {
        throw new Error('Grok freeform answer must be non-empty');
      }
    }
    answers[parsedQuestion.responseKey] = Object.freeze(items.map((item) =>
      item.kind === 'custom' ? GROK_FREEFORM_OPTION_LABEL : item.value));

    const annotation: { preview?: string; notes?: string } = {};
    if (parsedQuestion.question.multiSelect !== true && items.length === 1 && items[0]?.kind === 'choice') {
      const preview = optionsByLabel.get(items[0].value)?.preview;
      if (preview?.trim()) annotation.preview = preview;
    }
    if (customItems[0]) annotation.notes = customItems[0].value;
    if (Object.keys(annotation).length > 0) {
      annotations[parsedQuestion.responseKey] = Object.freeze(annotation);
    }
  }

  return {
    outcome: 'accepted',
    answers: Object.freeze(answers),
    ...(Object.keys(annotations).length > 0 ? { annotations: Object.freeze(annotations) } : {}),
  };
}
