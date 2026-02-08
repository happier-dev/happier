import { truncateDeep } from '../redaction/redact';
import type { ToolHappierMetaV2, ToolNormalizationProtocol } from '@happier-dev/protocol';
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

function mergeHappierMeta(input: unknown, meta: ToolHappierMetaV2): UnknownRecord {
    const record = asRecord(input) ?? {};
    const currentHappier = asRecord(record._happier) ?? {};
    const legacyHappy = asRecord((record as any)._happy) ?? {};
    return { ...record, _happier: { ...legacyHappy, ...currentHappier, ...meta } };
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
    const titleCandidate =
        typeof (record as any).title === 'string'
            ? String((record as any).title)
            : typeof (record as any)?.toolCall?.title === 'string'
                ? String((record as any).toolCall.title)
                : null;
    const descriptionCandidate =
        typeof (record as any).description === 'string'
            ? String((record as any).description)
            : typeof (record as any)?._acp?.title === 'string'
                ? String((record as any)._acp.title)
                : null;
    const inferredFromTitle = (() => {
        const candidates = [titleCandidate, descriptionCandidate].filter((value): value is string => typeof value === 'string');
        for (const candidate of candidates) {
            const t = candidate.trim().toLowerCase();
            if (!t) continue;
            if (/^read(?:[\s_-]*file)?\b/.test(t) || t === 'readfile') return 'Read';
            if (/^write(?:[\s_-]*file)?\b/.test(t) || t === 'writefile') return 'Write';
            if (/^edit(?:[\s_-]*file)?\b/.test(t) || t === 'editfile') return 'Edit';
            if (/^delete(?:[\s_-]*file)?\b/.test(t) || t === 'deletefile') return 'Delete';
        }
        return null;
    })();

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

    // Some providers (notably Codex ACP) may emit tool events with toolName="unknown" but with enough
    // shape to infer the canonical tool. Prefer conservative inference to avoid silently dropping
    // important tool types from fixtures and UI rendering.
    if (lower === 'unknown') {
        if (inferredFromTitle) return inferredFromTitle;
        const hasLocationHint =
            typeof (record as any).path === 'string' ||
            typeof (record as any).file === 'string' ||
            (Array.isArray((record as any).locations) && (record as any).locations.length > 0);
        const hasQueryLike =
            (typeof (record as any).query === 'string' && String((record as any).query).trim().length > 0) ||
            (typeof (record as any).pattern === 'string' && String((record as any).pattern).trim().length > 0) ||
            (hasLocationHint &&
                typeof (record as any).text === 'string' &&
                String((record as any).text).trim().length > 0);
        if (hasQueryLike) return 'CodeSearch';
    }

    // Common provider variants (underscore-based).
    // Keep this list provider-agnostic: normalize obvious synonyms to our canonical tool families.
    if (lower === 'execute_command' || lower === 'exec_command') return 'Bash';
    if (lower === 'read_file') return 'Read';
    if (lower === 'write_file' || lower === 'write_to_file') return 'Write';
    if (lower === 'apply_diff' || lower === 'apply_patch') return 'Patch';
    if (lower === 'list_files' || lower === 'ls_files') return 'LS';
    if (lower === 'search_code' || lower === 'code_search') return 'CodeSearch';

    // Shell / terminal.
    if (lower === 'execute' || lower === 'bash' || lower === 'shell' || name === 'GeminiBash' || name === 'CodexBash') return 'Bash';

    // Files.
    if (lower === 'read' && inferredFromTitle && inferredFromTitle !== 'Read') return inferredFromTitle;
    if (lower === 'read') return 'Read';
    if (lower === 'delete' || lower === 'remove') {
        if (inferredFromTitle === 'Read' || inferredFromTitle === 'Write' || inferredFromTitle === 'Edit') return inferredFromTitle;
        const changes = asRecord((record as any).changes);
        if (changes && Object.keys(changes).length > 0) return 'Patch';
        return 'Delete';
    }
    if (lower === 'write') {
        if (inferredFromTitle === 'Read' || inferredFromTitle === 'Edit' || inferredFromTitle === 'Delete') return inferredFromTitle;
        const callId = opts.callId ?? '';
        const hasTodos = Array.isArray((record as any).todos) && (record as any).todos.length > 0;
        if (callId.startsWith('write_todos') || hasTodos) return 'TodoWrite';
        return 'Write';
    }
    if (lower === 'edit') {
        if (inferredFromTitle === 'Read' || inferredFromTitle === 'Delete') return inferredFromTitle;
        if (inferredFromTitle === 'Write') {
            const callId = opts.callId ?? '';
            const hasTodos = Array.isArray((record as any).todos) && (record as any).todos.length > 0;
            if (callId.startsWith('write_todos') || hasTodos) return 'TodoWrite';
            return 'Write';
        }
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
    if (lower === 'mcp__happier__change_title' || lower === 'mcp__happy__change_title') return 'change_title';
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
        const meta: ToolHappierMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappier = mergeHappierMeta(normalized, meta);
        return { ...withHappier, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'Bash') {
        const normalized = normalizeBashInput(opts.rawInput);
        const meta: ToolHappierMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappier = mergeHappierMeta(normalized, meta);
        return { ...withHappier, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'Read') {
        const normalized = normalizeReadInput(opts.rawInput);
        const meta: ToolHappierMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappier = mergeHappierMeta(normalized, meta);
        return { ...withHappier, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'Delete') {
        const normalized = normalizeDeleteInput(opts.rawInput);
        const meta: ToolHappierMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappier = mergeHappierMeta(normalized, meta);
        return { ...withHappier, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'TodoWrite') {
        const normalized = normalizeTodoWriteInput(opts.rawInput);
        const meta: ToolHappierMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappier = mergeHappierMeta(normalized, meta);
        return { ...withHappier, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'TodoRead') {
        const normalized = normalizeTodoReadInput(opts.rawInput);
        const meta: ToolHappierMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappier = mergeHappierMeta(normalized, meta);
        return { ...withHappier, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'Task') {
        const normalized = normalizeTaskInput(opts.toolName, opts.rawInput);
        const meta: ToolHappierMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappier = mergeHappierMeta(normalized, meta);
        return { ...withHappier, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'Write') {
        const normalized = normalizeWriteInput(opts.rawInput);
        const meta: ToolHappierMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappier = mergeHappierMeta(normalized, meta);
        return { ...withHappier, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'Edit') {
        const normalized = normalizeEditInput(opts.rawInput);
        const meta: ToolHappierMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappier = mergeHappierMeta(normalized, meta);
        return { ...withHappier, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'MultiEdit') {
        const normalized = normalizeMultiEditInput(opts.rawInput);
        const meta: ToolHappierMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappier = mergeHappierMeta(normalized, meta);
        return { ...withHappier, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'Diff') {
        const normalized = normalizeDiffInput(opts.rawInput);
        const meta: ToolHappierMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappier = mergeHappierMeta(normalized, meta);
        return { ...withHappier, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'Patch') {
        const normalized = normalizePatchInput(opts.rawInput);
        const meta: ToolHappierMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappier = mergeHappierMeta(normalized, meta);
        return { ...withHappier, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'Reasoning') {
        const normalized = normalizeReasoningInput(opts.rawInput);
        const meta: ToolHappierMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappier = mergeHappierMeta(normalized, meta);
        return { ...withHappier, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'Glob') {
        const normalized = normalizeGlobInput(opts.rawInput);
        const meta: ToolHappierMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappier = mergeHappierMeta(normalized, meta);
        return { ...withHappier, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'CodeSearch') {
        const normalized = normalizeCodeSearchInput(opts.rawInput);
        const meta: ToolHappierMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappier = mergeHappierMeta(normalized, meta);
        return { ...withHappier, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'Grep') {
        const normalized = normalizeGrepInput(opts.rawInput);
        const meta: ToolHappierMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappier = mergeHappierMeta(normalized, meta);
        return { ...withHappier, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'LS') {
        const normalized = normalizeLsInput(opts.rawInput);
        const meta: ToolHappierMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappier = mergeHappierMeta(normalized, meta);
        return { ...withHappier, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'WebFetch') {
        const normalized = normalizeWebFetchInput(opts.rawInput);
        const meta: ToolHappierMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappier = mergeHappierMeta(normalized, meta);
        return { ...withHappier, _raw: truncateDeep(opts.rawInput) };
    }

    if (opts.canonicalToolName === 'WebSearch') {
        const normalized = normalizeWebSearchInput(opts.rawInput);
        const meta: ToolHappierMetaV2 = {
            v: 2,
            protocol: opts.protocol,
            provider: opts.provider,
            rawToolName: opts.toolName,
            canonicalToolName: opts.canonicalToolName,
        };
        const withHappier = mergeHappierMeta(normalized, meta);
        return { ...withHappier, _raw: truncateDeep(opts.rawInput) };
    }

    const meta: ToolHappierMetaV2 = {
        v: 2,
        protocol: opts.protocol,
        provider: opts.provider,
        rawToolName: opts.toolName,
        canonicalToolName: opts.canonicalToolName,
    };
    const record = asRecord(opts.rawInput) ?? {};
    const withHappier = mergeHappierMeta(record, meta);
    return { ...withHappier, _raw: truncateDeep(opts.rawInput) };
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
    const meta: ToolHappierMetaV2 = {
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

    const withHappier = mergeHappierMeta(withCommonErrorMessage(normalized), meta);
    return { ...withHappier, _raw: truncateDeep(opts.rawOutput) };
}
