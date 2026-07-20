import {
    STRUCTURED_QUESTION_LIMITS,
    StructuredQuestionAnswersV1Schema,
    normalizeStructuredQuestionDescriptors,
    type StructuredQuestionDescriptor,
    type StructuredQuestionAnswersV1,
    type StructuredQuestionLike,
} from '@happier-dev/protocol';
import {
    PUBLIC_RPC_HANDLER_ERROR_CODES,
    PublicRpcHandlerError,
    type PublicRpcHandlerErrorCode,
} from '@happier-dev/protocol/rpcErrors';

export type { StructuredQuestionLike } from '@happier-dev/protocol';

function addCandidate(candidates: Map<string, readonly string[]>, candidate: readonly string[]): void {
    candidates.set(JSON.stringify(candidate), candidate);
}

function parseQuestionDescriptors(
    questions: ReadonlyArray<StructuredQuestionLike>,
    errorCode: PublicRpcHandlerErrorCode,
): Readonly<{
    descriptors: readonly StructuredQuestionDescriptor[];
    descriptorByKey: ReadonlyMap<string, StructuredQuestionDescriptor>;
}> {
    const normalized = normalizeStructuredQuestionDescriptors(questions);
    if (!normalized.ok) {
        throw new PublicRpcHandlerError(errorCode);
    }

    const descriptorByKey = new Map<string, StructuredQuestionDescriptor>();
    for (const descriptor of normalized.questions) {
        for (const key of descriptor.keys) {
            descriptorByKey.set(key, descriptor);
        }
    }
    return { descriptors: normalized.questions, descriptorByKey };
}

export function validateStructuredQuestionDescriptors(
    questions: ReadonlyArray<StructuredQuestionLike>,
): void {
    parseQuestionDescriptors(
        questions,
        PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_INVALID,
    );
}

function validateAnswersAgainstQuestions(params: Readonly<{
    answers: StructuredQuestionAnswersV1;
    questions: ReadonlyArray<StructuredQuestionLike>;
    errorCode: PublicRpcHandlerErrorCode;
}>): StructuredQuestionAnswersV1 {
    const { descriptors, descriptorByKey } = parseQuestionDescriptors(params.questions, params.errorCode);
    const submittedKeyByDescriptor = new Map<StructuredQuestionDescriptor, string>();

    for (const [key, values] of Object.entries(params.answers)) {
        const descriptor = descriptorByKey.get(key);
        if (!descriptor || submittedKeyByDescriptor.has(descriptor)) {
            throw new PublicRpcHandlerError(params.errorCode);
        }
        submittedKeyByDescriptor.set(descriptor, key);
        if (
            values.length === 0
            || (!descriptor.multiSelect && values.length !== 1)
            || values.some((value) => value.trim().length === 0)
            || (!descriptor.allowsFreeform && values.some((value) => !descriptor.options.some((option) => option.answerValue === value)))
        ) {
            throw new PublicRpcHandlerError(params.errorCode);
        }
    }

    if (submittedKeyByDescriptor.size !== descriptors.length) {
        throw new PublicRpcHandlerError(params.errorCode);
    }
    return params.answers;
}

function decodeLegacyQuestion(params: Readonly<{
    raw: string;
    question: StructuredQuestionDescriptor;
}>): readonly string[] {
    const options = params.question.options.map((option) => option.answerValue);

    const candidates = new Map<string, readonly string[]>();
    const allowsFreeform = params.question.allowsFreeform;
    const multiSelect = params.question.multiSelect;

    if (allowsFreeform) addCandidate(candidates, [params.raw]);
    if (!multiSelect) {
        if (options.includes(params.raw)) addCandidate(candidates, [params.raw]);
    } else {
        let visited = 0;
        const visit = (
            remaining: readonly string[],
            selected: readonly string[],
            encoded: string,
        ): void => {
            visited += 1;
            if (visited > STRUCTURED_QUESTION_LIMITS.maxLegacyDecodeStates) {
                throw new PublicRpcHandlerError(PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_AMBIGUOUS);
            }
            if (selected.length > 0 && encoded === params.raw) {
                addCandidate(candidates, selected);
                if (candidates.size > 1) return;
            }
            if (selected.length >= STRUCTURED_QUESTION_LIMITS.maxAnswersPerQuestion) return;
            for (let index = 0; index < remaining.length; index += 1) {
                if (candidates.size > 1) return;
                const option = remaining[index]!;
                const nextEncoded = encoded ? `${encoded}, ${option}` : option;
                if (nextEncoded !== params.raw && !params.raw.startsWith(`${nextEncoded}, `)) continue;
                visit(
                    [...remaining.slice(0, index), ...remaining.slice(index + 1)],
                    [...selected, option],
                    nextEncoded,
                );
            }
        };
        visit(options, [], '');
    }

    if (candidates.size === 0) {
        throw new PublicRpcHandlerError(PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_INVALID);
    }
    if (candidates.size !== 1) {
        throw new PublicRpcHandlerError(PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_AMBIGUOUS);
    }
    return candidates.values().next().value!;
}

export function normalizeLegacyStructuredQuestionAnswers(params: Readonly<{
    answers: unknown;
    questions: ReadonlyArray<StructuredQuestionLike>;
}>): StructuredQuestionAnswersV1 {
    if (!params.answers || typeof params.answers !== 'object' || Array.isArray(params.answers)) {
        throw new PublicRpcHandlerError(PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_INVALID);
    }
    const { descriptorByKey } = parseQuestionDescriptors(
        params.questions,
        PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_INVALID,
    );

    const normalized = Object.create(null) as Record<string, readonly string[]>;
    for (const [key, raw] of Object.entries(params.answers)) {
        if (typeof raw !== 'string' || raw.length === 0) continue;
        const descriptor = descriptorByKey.get(key);
        if (!descriptor) {
            throw new PublicRpcHandlerError(PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_INVALID);
        }
        normalized[key] = decodeLegacyQuestion({ raw, question: descriptor });
    }

    const parsed = StructuredQuestionAnswersV1Schema.safeParse(normalized);
    if (!parsed.success) {
        throw new PublicRpcHandlerError(PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_INVALID);
    }
    return validateAnswersAgainstQuestions({
        answers: parsed.data,
        questions: params.questions,
        errorCode: PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_LEGACY_INVALID,
    });
}

export function normalizeStructuredQuestionAnswersV1(
    value: unknown,
    questions: ReadonlyArray<StructuredQuestionLike>,
): StructuredQuestionAnswersV1 {
    const parsed = StructuredQuestionAnswersV1Schema.safeParse(value);
    if (!parsed.success) {
        throw new PublicRpcHandlerError(PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_INVALID);
    }
    return validateAnswersAgainstQuestions({
        answers: parsed.data,
        questions,
        errorCode: PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_INVALID,
    });
}
