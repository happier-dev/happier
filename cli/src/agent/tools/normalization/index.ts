import { truncateDeep } from '../redaction/redact';
import type { CanonicalToolName, ToolNormalizationHappyMetaV2, ToolNormalizationProtocol } from './types';
import { normalizeBashInput, normalizeBashResult } from './families/execute';
import { normalizeReadInput, normalizeReadResult } from './families/read';
import { normalizeEditInput } from './families/edit';
import { normalizeCodeSearchInput, normalizeGlobInput, normalizeGrepInput, normalizeLsInput } from './families/search';
import { normalizeWriteInput } from './families/write';
import { normalizeWebFetchInput, normalizeWebSearchInput } from './families/web';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as UnknownRecord;
}

function mergeHappyMeta(input: unknown, meta: ToolNormalizationHappyMetaV2): UnknownRecord {
    const record = asRecord(input) ?? {};
    const current = asRecord(record._happy) ?? {};
    return { ...record, _happy: { ...current, ...meta } };
}

export function canonicalizeToolNameV2(opts: {
    protocol: ToolNormalizationProtocol;
    toolName: string;
    toolInput?: unknown;
    callId?: string;
}): string {
    const name = opts.toolName;
    const lower = name.toLowerCase();

    // Shell / terminal.
    if (lower === 'execute' || lower === 'shell' || name === 'GeminiBash' || name === 'CodexBash') return 'Bash';

    // Files.
    if (lower === 'read') return 'Read';
    if (lower === 'write') {
        const callId = opts.callId ?? '';
        const record = asRecord(opts.toolInput) ?? {};
        const hasTodos = Array.isArray((record as any).todos) && (record as any).todos.length > 0;
        if (callId.startsWith('write_todos') || hasTodos) return 'TodoWrite';
        return 'Write';
    }
    if (lower === 'edit') {
        const record = asRecord(opts.toolInput) ?? {};
        if (Array.isArray((record as any).edits) && (record as any).edits.length > 0) return 'MultiEdit';
        return 'Edit';
    }

    // Search / listing.
    if (lower === 'glob') return 'Glob';
    if (lower === 'grep') return 'Grep';
    if (lower === 'ls') return 'LS';
    if (lower === 'search') return 'CodeSearch';

    // Web.
    if (lower === 'webfetch' || lower === 'web_fetch') return 'WebFetch';
    if (lower === 'websearch' || lower === 'web_search') return 'WebSearch';

    // Tasks / notebooks.
    if (lower === 'task') return 'Task';
    if (lower === 'todowrite') return 'TodoWrite';
    if (lower === 'todoread') return 'TodoRead';

    // Provider special-cases.
    if (name === 'CodexPatch' || name === 'GeminiPatch') return 'Patch';
    if (name === 'CodexDiff' || name === 'GeminiDiff') return 'Diff';
    if (name === 'GeminiReasoning' || name === 'CodexReasoning' || lower === 'think') return 'Reasoning';
    if (lower === 'exit_plan_mode') return 'ExitPlanMode';
    if (lower === 'askuserquestion' || lower === 'ask_user_question') return 'AskUserQuestion';
    if (lower === 'mcp__happy__change_title') return 'change_title';
    return name;
}

export function normalizeToolCallInputV2(opts: {
    protocol: ToolNormalizationProtocol;
    provider: string;
    toolName: string;
    canonicalToolName: string;
    rawInput: unknown;
}): unknown {
    if (opts.canonicalToolName === 'Bash') {
        const normalized = normalizeBashInput(opts.rawInput);
        const meta: ToolNormalizationHappyMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappy = mergeHappyMeta(normalized, meta);
        return { ...withHappy, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'Read') {
        const normalized = normalizeReadInput(opts.rawInput);
        const meta: ToolNormalizationHappyMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappy = mergeHappyMeta(normalized, meta);
        return { ...withHappy, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'Write' || opts.canonicalToolName === 'TodoWrite') {
        const normalized = normalizeWriteInput(opts.rawInput);
        const meta: ToolNormalizationHappyMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappy = mergeHappyMeta(normalized, meta);
        return { ...withHappy, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'Edit' || opts.canonicalToolName === 'MultiEdit') {
        const normalized = normalizeEditInput(opts.rawInput);
        const meta: ToolNormalizationHappyMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappy = mergeHappyMeta(normalized, meta);
        return { ...withHappy, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'Glob') {
        const normalized = normalizeGlobInput(opts.rawInput);
        const meta: ToolNormalizationHappyMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappy = mergeHappyMeta(normalized, meta);
        return { ...withHappy, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'CodeSearch') {
        const normalized = normalizeCodeSearchInput(opts.rawInput);
        const meta: ToolNormalizationHappyMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappy = mergeHappyMeta(normalized, meta);
        return { ...withHappy, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'Grep') {
        const normalized = normalizeGrepInput(opts.rawInput);
        const meta: ToolNormalizationHappyMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappy = mergeHappyMeta(normalized, meta);
        return { ...withHappy, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'LS') {
        const normalized = normalizeLsInput(opts.rawInput);
        const meta: ToolNormalizationHappyMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappy = mergeHappyMeta(normalized, meta);
        return { ...withHappy, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'WebFetch') {
        const normalized = normalizeWebFetchInput(opts.rawInput);
        const meta: ToolNormalizationHappyMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappy = mergeHappyMeta(normalized, meta);
        return { ...withHappy, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'WebSearch') {
        const normalized = normalizeWebSearchInput(opts.rawInput);
        const meta: ToolNormalizationHappyMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappy = mergeHappyMeta(normalized, meta);
        return { ...withHappy, _raw: truncateDeep(opts.rawInput) };
    }

    const meta: ToolNormalizationHappyMetaV2 = {
        v: 2,
        protocol: opts.protocol,
        provider: opts.provider,
        rawToolName: opts.toolName,
        canonicalToolName: opts.canonicalToolName,
    };
    const record = asRecord(opts.rawInput) ?? {};
    const withHappy = mergeHappyMeta(record, meta);
    return { ...withHappy, _raw: truncateDeep(opts.rawInput) };
}

export function normalizeToolCallV2(opts: {
    protocol: ToolNormalizationProtocol;
    provider: string;
    toolName: string;
    rawInput: unknown;
    callId?: string;
}): { canonicalToolName: string; input: unknown } {
    const canonicalToolName = canonicalizeToolNameV2({
        protocol: opts.protocol,
        toolName: opts.toolName,
        toolInput: opts.rawInput,
        callId: opts.callId,
    });
    const input = normalizeToolCallInputV2({
        protocol: opts.protocol,
        provider: opts.provider,
        toolName: opts.toolName,
        canonicalToolName,
        rawInput: opts.rawInput,
    });
    return { canonicalToolName, input };
}

export function normalizeToolResultV2(opts: {
    protocol: ToolNormalizationProtocol;
    provider: string;
    rawToolName: string;
    canonicalToolName: string;
    rawOutput: unknown;
}): unknown {
    const meta: ToolNormalizationHappyMetaV2 = {
        v: 2,
        protocol: opts.protocol,
        provider: opts.provider,
        rawToolName: opts.rawToolName,
        canonicalToolName: opts.canonicalToolName,
    };

    const normalized: UnknownRecord = (() => {
        if (opts.canonicalToolName === 'Bash') {
            return normalizeBashResult(opts.rawOutput);
        }
        if (opts.canonicalToolName === 'Read') {
            return normalizeReadResult(opts.rawOutput);
        }
        const record = asRecord(opts.rawOutput);
        if (record) return { ...record };
        return { value: opts.rawOutput };
    })();

    const withHappy = mergeHappyMeta(normalized, meta);
    return { ...withHappy, _raw: truncateDeep(opts.rawOutput) };
}
