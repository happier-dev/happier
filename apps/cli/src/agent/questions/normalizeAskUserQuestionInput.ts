import { STRUCTURED_QUESTION_LIMITS, isAskUserQuestionToolName } from '@happier-dev/protocol';
import {
    validateStructuredQuestionDescriptors,
    type StructuredQuestionLike,
} from './normalizeStructuredQuestionAnswersV1';

export class InvalidAskUserQuestionInputError extends Error {
    readonly name = 'InvalidAskUserQuestionInputError';

    constructor() {
        super('Invalid AskUserQuestion input');
    }
}

function fail(): never {
    throw new InvalidAskUserQuestionInputError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type SnapshotBudget = {
    stringLength: number;
    nodes: number;
};

function accountString(value: string, budget: SnapshotBudget): void {
    if (value.length > STRUCTURED_QUESTION_LIMITS.maxStringLength) fail();
    budget.stringLength += value.length;
    if (budget.stringLength > STRUCTURED_QUESTION_LIMITS.maxTotalStringLength) fail();
}

function accountNode(budget: SnapshotBudget): void {
    budget.nodes += 1;
    if (budget.nodes > STRUCTURED_QUESTION_LIMITS.maxTotalStringLength) fail();
}

function snapshotJsonValue(value: unknown, active: WeakSet<object>, budget: SnapshotBudget): unknown {
    accountNode(budget);
    if (typeof value === 'string') {
        accountString(value, budget);
        return value;
    }
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) fail();
        return value;
    }
    if (typeof value !== 'object') fail();
    if (active.has(value)) fail();
    active.add(value);

    try {
        if (Array.isArray(value)) {
            if (value.length > STRUCTURED_QUESTION_LIMITS.maxTotalStringLength) fail();
            const ownKeys = Reflect.ownKeys(value);
            if (ownKeys.some((key) => {
                if (key === 'length') return false;
                if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) return true;
                const index = Number(key);
                return !Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key;
            })) fail();
            const snapshot: unknown[] = [];
            for (let index = 0; index < value.length; index += 1) {
                if (!Object.prototype.hasOwnProperty.call(value, index)) fail();
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
                if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail();
                snapshot.push(snapshotJsonValue(descriptor.value, active, budget));
            }
            return snapshot;
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) fail();
        const snapshot = Object.create(null) as Record<string, unknown>;
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== 'string') fail();
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail();
            accountString(key, budget);
            snapshot[key] = snapshotJsonValue(descriptor.value, active, budget);
        }
        return snapshot;
    } finally {
        active.delete(value);
    }
}

function validateQuestionDescriptors(toolInput: Record<string, unknown>): void {
    if (!Array.isArray(toolInput.questions)) fail();
    validateStructuredQuestionDescriptors(toolInput.questions as StructuredQuestionLike[]);
}

/**
 * Produces the bounded JSON-safe snapshot used by every AskUserQuestion publication path.
 * Non-question permissions intentionally bypass this contract unchanged.
 */
export function normalizeAskUserQuestionInputForPublication(toolName: string, toolInput: unknown): unknown {
    if (!isAskUserQuestionToolName(toolName)) return toolInput;
    try {
        const snapshot = snapshotJsonValue(
            toolInput,
            new WeakSet<object>(),
            { stringLength: 0, nodes: 0 },
        );
        if (!isRecord(snapshot)) fail();
        validateQuestionDescriptors(snapshot);
        return snapshot;
    } catch (error) {
        if (error instanceof InvalidAskUserQuestionInputError) throw error;
        fail();
    }
}
