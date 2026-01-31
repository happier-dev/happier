import { truncateDeep } from '../redaction/redact';
import type { CanonicalToolName, ToolNormalizationHappyMetaV2, ToolNormalizationProtocol } from './types';
import { normalizeBashInput, normalizeBashResult } from './families/execute';
import { normalizeReadInput, normalizeReadResult } from './families/read';
import { normalizeEditInput, normalizeEditResult } from './families/edit';
import { normalizeMultiEditInput } from './families/multiEdit';
import { normalizeDeleteInput, normalizeDeleteResult } from './families/delete';
import { normalizeDiffInput } from './families/diff';
import { normalizePatchInput, normalizePatchResult } from './families/patch';
import { normalizeReasoningInput, normalizeReasoningResult } from './families/reasoning';
import {
    normalizeCodeSearchInput,
    normalizeCodeSearchResult,
    normalizeGlobInput,
    normalizeGlobResult,
    normalizeGrepInput,
    normalizeGrepResult,
    normalizeLsInput,
    normalizeLsResult,
} from './families/search';
import { normalizeWriteInput, normalizeWriteResult } from './families/write';
import { normalizeTodoReadInput, normalizeTodoResult, normalizeTodoWriteInput } from './families/todo';
import { normalizeWebFetchInput, normalizeWebFetchResult, normalizeWebSearchInput, normalizeWebSearchResult } from './families/web';
import { normalizeTaskInput, normalizeTaskResult } from './families/task';
import { normalizeChangeTitleResult } from './families/changeTitle';
import { normalizeMcpInput, normalizeMcpResult } from './families/mcp';

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

function withCommonErrorMessage(normalized: UnknownRecord): UnknownRecord {
    const existing = typeof (normalized as any).errorMessage === 'string' ? String((normalized as any).errorMessage) : null;
    if (existing && existing.trim().length > 0) return normalized;

    const candidates: Array<unknown> = [
        (normalized as any).error,
        // Many tool results use `stderr` or `message` to convey failures.
        (normalized as any).stderr,
        (normalized as any).message,
        (normalized as any).text,
    ];

    let chosen: string | null = null;
    for (const c of candidates) {
        if (typeof c === 'string' && c.trim().length > 0) {
            chosen = c.trim();
            break;
        }
    }

    const isError =
        (normalized as any).isError === true ||
        (normalized as any).ok === false ||
        (normalized as any).success === false ||
        (normalized as any).applied === false;

    // Only promote message/text as an errorMessage when the result indicates failure.
    if (!isError && chosen === (normalized as any).message) chosen = null;
    if (!isError && chosen === (normalized as any).text) chosen = null;

    if (!chosen) return normalized;
    return { ...normalized, errorMessage: chosen };
}

export function canonicalizeToolNameV2(opts: {
    protocol: ToolNormalizationProtocol;
    toolName: string;
    toolInput?: unknown;
    callId?: string;
}): string {
    const name = opts.toolName;
    const lower = name.toLowerCase();
    const record = asRecord(opts.toolInput) ?? {};

    // Provider prompts that are represented as permission requests ("Unknown tool" etc.).
    // Auggie emits a workspace indexing prompt with toolName="Unknown tool". Normalize it so the UI can render it.
    if (lower === 'unknown tool') {
        const title =
            typeof (record as any).title === 'string'
                ? String((record as any).title)
                : typeof (record as any)?.toolCall?.title === 'string'
                    ? String((record as any).toolCall.title)
                    : null;
        if (title === 'Workspace Indexing Permission') return 'WorkspaceIndexingPermission';
    }

    // Shell / terminal.
    if (lower === 'execute' || lower === 'shell' || name === 'GeminiBash' || name === 'CodexBash') return 'Bash';

    // Files.
    if (lower === 'read') return 'Read';
    if (lower === 'delete' || lower === 'remove') {
        const changes = asRecord((record as any).changes);
        if (changes && Object.keys(changes).length > 0) return 'Patch';
        return 'Delete';
    }
    if (lower === 'write') {
        const callId = opts.callId ?? '';
        const hasTodos = Array.isArray((record as any).todos) && (record as any).todos.length > 0;
        if (callId.startsWith('write_todos') || hasTodos) return 'TodoWrite';
        return 'Write';
    }
    if (lower === 'edit') {
        const hasEdits = Array.isArray((record as any).edits) && (record as any).edits.length > 0;
        const hasOldNew =
            typeof (record as any).old_string === 'string' ||
            typeof (record as any).new_string === 'string' ||
            typeof (record as any).oldText === 'string' ||
            typeof (record as any).newText === 'string';
        const hasFullFileContent =
            typeof (record as any).file_content === 'string'
                ? (record as any).file_content.trim().length > 0
                : typeof (record as any).content === 'string'
                    ? (record as any).content.trim().length > 0
                    : typeof (record as any).text === 'string'
                        ? (record as any).text.trim().length > 0
                        : false;
        const changes = asRecord((record as any).changes);
        if (changes && Object.keys(changes).length > 0) return 'Patch';
        if (hasEdits) return 'MultiEdit';
        // Some providers (e.g. Auggie/OpenCode ACP) use "Edit" to write a full file's content.
        if (hasFullFileContent && !hasOldNew) return 'Write';
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
    if (lower === 'fetch') {
        const record = asRecord(opts.toolInput) ?? {};
        const urlCandidate =
            typeof (record as any).url === 'string'
                ? (record as any).url
                : typeof (record as any).href === 'string'
                    ? (record as any).href
                    : typeof (record as any).uri === 'string'
                        ? (record as any).uri
                        : typeof (record as any).link === 'string'
                            ? (record as any).link
                            : null;
        if (typeof urlCandidate === 'string' && urlCandidate.trim().length > 0) return 'WebFetch';

        const queryCandidate =
            typeof (record as any).query === 'string'
                ? (record as any).query
                : typeof (record as any).q === 'string'
                    ? (record as any).q
                    : typeof (record as any).text === 'string'
                        ? (record as any).text
                        : typeof (record as any).pattern === 'string'
                            ? (record as any).pattern
                            : typeof (record as any).information_request === 'string'
                                ? (record as any).information_request
                                : typeof (record as any).informationRequest === 'string'
                                    ? (record as any).informationRequest
                                    : null;
        if (typeof queryCandidate === 'string' && queryCandidate.trim().length > 0) return 'WebSearch';
    }

    // Tasks / notebooks.
    // Claude emits TaskCreate/TaskList/TaskUpdate; keep them unified for rendering.
    if (lower === 'task' || lower.startsWith('task')) return 'Task';
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
    if (opts.canonicalToolName.startsWith('mcp__')) {
        const normalized = normalizeMcpInput(opts.canonicalToolName, opts.rawInput);
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

    if (opts.canonicalToolName === 'Delete') {
        const normalized = normalizeDeleteInput(opts.rawInput);
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

    if (opts.canonicalToolName === 'TodoWrite') {
        const normalized = normalizeTodoWriteInput(opts.rawInput);
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

    if (opts.canonicalToolName === 'TodoRead') {
        const normalized = normalizeTodoReadInput(opts.rawInput);
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

    if (opts.canonicalToolName === 'Task') {
        const normalized = normalizeTaskInput(opts.toolName, opts.rawInput);
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

    if (opts.canonicalToolName === 'Write') {
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

    if (opts.canonicalToolName === 'Edit') {
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

    if (opts.canonicalToolName === 'MultiEdit') {
        const normalized = normalizeMultiEditInput(opts.rawInput);
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

    if (opts.canonicalToolName === 'Diff') {
        const normalized = normalizeDiffInput(opts.rawInput);
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

    if (opts.canonicalToolName === 'Patch') {
        const normalized = normalizePatchInput(opts.rawInput);
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

    if (opts.canonicalToolName === 'Reasoning') {
        const normalized = normalizeReasoningInput(opts.rawInput);
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
        if (opts.canonicalToolName.startsWith('mcp__')) {
            return normalizeMcpResult(opts.canonicalToolName, opts.rawOutput);
        }
        if (opts.canonicalToolName === 'Bash') {
            return normalizeBashResult(opts.rawOutput);
        }
        if (opts.canonicalToolName === 'Read') {
            return normalizeReadResult(opts.rawOutput);
        }
        if (opts.canonicalToolName === 'Write') {
            return normalizeWriteResult(opts.rawOutput);
        }
        if (opts.canonicalToolName === 'Edit' || opts.canonicalToolName === 'MultiEdit') {
            return normalizeEditResult(opts.rawOutput);
        }
        if (opts.canonicalToolName === 'TodoWrite' || opts.canonicalToolName === 'TodoRead') {
            return normalizeTodoResult(opts.rawOutput);
        }
        if (opts.canonicalToolName === 'Glob') {
            return normalizeGlobResult(opts.rawOutput);
        }
        if (opts.canonicalToolName === 'Grep') {
            return normalizeGrepResult(opts.rawOutput);
        }
        if (opts.canonicalToolName === 'CodeSearch') {
            return normalizeCodeSearchResult(opts.rawOutput);
        }
        if (opts.canonicalToolName === 'LS') {
            return normalizeLsResult(opts.rawOutput);
        }
        if (opts.canonicalToolName === 'WebSearch') {
            return normalizeWebSearchResult(opts.rawOutput);
        }
        if (opts.canonicalToolName === 'WebFetch') {
            return normalizeWebFetchResult(opts.rawOutput);
        }
        if (opts.canonicalToolName === 'Delete') {
            return normalizeDeleteResult(opts.rawOutput);
        }
        if (opts.canonicalToolName === 'Patch') {
            return normalizePatchResult(opts.rawOutput);
        }
        if (opts.canonicalToolName === 'Reasoning') {
            return normalizeReasoningResult(opts.rawOutput);
        }
        if (opts.canonicalToolName === 'Task') {
            return normalizeTaskResult(opts.rawOutput);
        }
        if (opts.canonicalToolName === 'change_title') {
            return normalizeChangeTitleResult(opts.rawOutput);
        }
        const record = asRecord(opts.rawOutput);
        if (record) return { ...record };
        return { value: opts.rawOutput };
    })();

    const withHappy = mergeHappyMeta(withCommonErrorMessage(normalized), meta);
    return { ...withHappy, _raw: truncateDeep(opts.rawOutput) };
}
