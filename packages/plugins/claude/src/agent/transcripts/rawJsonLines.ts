export type ClaudeRawUsage = Readonly<{
    input_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens: number;
    service_tier?: string | null;
    [key: string]: unknown;
}>;

export type RawJSONLines =
    | Readonly<{
        type: 'user';
        isSidechain?: boolean;
        isMeta?: boolean;
        uuid: string;
        message: Readonly<{ content: string | unknown; [key: string]: unknown }>;
        [key: string]: unknown;
    }>
    | Readonly<{
        type: 'assistant';
        isSidechain?: boolean;
        uuid: string;
        message?: Readonly<{
            usage?: ClaudeRawUsage;
            model?: string;
            [key: string]: unknown;
        }>;
        [key: string]: unknown;
    }>
    | Readonly<{
        type: 'result';
        subtype: string;
        uuid: string;
        session_id: string;
        usage: Readonly<Record<string, unknown>>;
        modelUsage: Readonly<Record<string, unknown>>;
        [key: string]: unknown;
    }>
    | Readonly<{
        type: 'summary';
        summary: string;
        leafUuid: string;
        [key: string]: unknown;
    }>
    | Readonly<{
        type: 'system';
        uuid: string;
        [key: string]: unknown;
    }>
    | Readonly<{
        type: 'progress';
        uuid?: string;
        [key: string]: unknown;
    }>
    | Readonly<{
        type: 'attachment';
        uuid: string;
        attachment: Readonly<Record<string, unknown>>;
        [key: string]: unknown;
    }>;

type SafeParseResult<T> =
    | Readonly<{ success: true; data: T }>
    | Readonly<{ success: false; error: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
    return value === undefined || typeof value === 'boolean';
}

function isNonNegativeInteger(value: unknown): value is number {
    return Number.isInteger(value) && Number(value) >= 0;
}

function parseUsageBestEffort(value: unknown): ClaudeRawUsage | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) return undefined;
    if (!isNonNegativeInteger(value.input_tokens)) return undefined;
    if (!isNonNegativeInteger(value.output_tokens)) return undefined;
    if (value.cache_creation_input_tokens !== undefined && !isNonNegativeInteger(value.cache_creation_input_tokens)) {
        return undefined;
    }
    if (value.cache_read_input_tokens !== undefined && !isNonNegativeInteger(value.cache_read_input_tokens)) {
        return undefined;
    }
    if (
        value.service_tier !== undefined &&
        value.service_tier !== null &&
        typeof value.service_tier !== 'string'
    ) {
        return undefined;
    }
    return value as ClaudeRawUsage;
}

function parseRawJsonLines(value: unknown): RawJSONLines | null {
    if (!isRecord(value)) return null;
    switch (value.type) {
        case 'user': {
            if (!isOptionalBoolean(value.isSidechain)) return null;
            if (!isOptionalBoolean(value.isMeta)) return null;
            if (!isNonEmptyString(value.uuid)) return null;
            if (!isRecord(value.message)) return null;
            if (!('content' in value.message)) return null;
            return value as RawJSONLines;
        }
        case 'assistant': {
            if (!isNonEmptyString(value.uuid)) return null;
            const message = value.message;
            if (message !== undefined) {
                if (!isRecord(message)) return null;
                const usage = parseUsageBestEffort(message.usage);
                if (message.usage !== undefined && usage === undefined) {
                    return {
                        ...value,
                        message: {
                            ...message,
                            usage: undefined,
                        },
                    } as RawJSONLines;
                }
                if (message.model !== undefined && typeof message.model !== 'string') return null;
            }
            return value as RawJSONLines;
        }
        case 'result': {
            if (!isNonEmptyString(value.subtype)) return null;
            if (!isNonEmptyString(value.uuid)) return null;
            if (!isNonEmptyString(value.session_id)) return null;
            if (!isRecord(value.usage)) return null;
            if (!isRecord(value.modelUsage)) return null;
            return value as RawJSONLines;
        }
        case 'summary': {
            if (!isNonEmptyString(value.summary)) return null;
            if (!isNonEmptyString(value.leafUuid)) return null;
            return value as RawJSONLines;
        }
        case 'system': {
            if (!isNonEmptyString(value.uuid)) return null;
            return value as RawJSONLines;
        }
        case 'progress': {
            if (value.uuid !== undefined && typeof value.uuid !== 'string') return null;
            return value as RawJSONLines;
        }
        case 'attachment': {
            if (!isNonEmptyString(value.uuid)) return null;
            if (!isRecord(value.attachment)) return null;
            return value as RawJSONLines;
        }
        default:
            return null;
    }
}

export const RawJSONLinesSchema = Object.freeze({
    safeParse(value: unknown): SafeParseResult<RawJSONLines> {
        const parsed = parseRawJsonLines(value);
        if (!parsed) return { success: false, error: 'invalid_claude_raw_jsonl_record' };
        return { success: true, data: parsed };
    },
});
