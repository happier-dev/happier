import type { ToolCall } from '@/sync/typesMessage';
import { maybeParseJson } from './parseJson';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function firstNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function hasNonEmptyRecord(value: unknown): boolean {
    const record = asRecord(value);
    return !!record && Object.keys(record).length > 0;
}

function normalizeDiffAliases(input: Record<string, unknown>): Record<string, unknown> | null {
    if (typeof input.unified_diff === 'string' && input.unified_diff.trim().length > 0) return null;

    const diff =
        typeof input.diff === 'string'
            ? input.diff
            : typeof input.patch === 'string'
                ? input.patch
                : null;
    if (!diff || diff.trim().length === 0) return null;
    return { ...input, unified_diff: diff };
}

type PatchChangeRecord = Record<string, unknown>;

function stripDiffPrefix(path: string): string {
    return path.replace(/^(a\/|b\/)/, '');
}

function parseUnifiedDiffFileBlock(unifiedDiff: string): {
    filePath: string | null;
    change: PatchChangeRecord | null;
} {
    const lines = unifiedDiff.split('\n');
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let isDelete = false;
    let isAdd = false;
    let inHunk = false;
    const oldLines: string[] = [];
    const newLines: string[] = [];

    for (const line of lines) {
        if (line.startsWith('deleted file mode')) {
            isDelete = true;
            continue;
        }
        if (line.startsWith('new file mode')) {
            isAdd = true;
            continue;
        }
        if (line.startsWith('--- ')) {
            const raw = line.replace(/^--- /, '');
            oldPath = raw === '/dev/null' ? '/dev/null' : stripDiffPrefix(raw);
            continue;
        }
        if (line.startsWith('+++ ')) {
            const raw = line.replace(/^\+\+\+ /, '');
            newPath = raw === '/dev/null' ? '/dev/null' : stripDiffPrefix(raw);
            continue;
        }

        if (line.startsWith('@@')) {
            inHunk = true;
            continue;
        }
        if (!inHunk) continue;

        if (line.startsWith('+')) {
            newLines.push(line.substring(1));
        } else if (line.startsWith('-')) {
            oldLines.push(line.substring(1));
        } else if (line.startsWith(' ')) {
            oldLines.push(line.substring(1));
            newLines.push(line.substring(1));
        } else if (line === '\\ No newline at end of file') {
            continue;
        } else if (line === '') {
            oldLines.push('');
            newLines.push('');
        }
    }

    const filePath = (newPath && newPath !== '/dev/null' ? newPath : oldPath && oldPath !== '/dev/null' ? oldPath : null) ?? null;
    if (!filePath) return { filePath: null, change: null };

    let oldText = oldLines.join('\n');
    let newText = newLines.join('\n');
    if (oldText.endsWith('\n')) oldText = oldText.slice(0, -1);
    if (newText.endsWith('\n')) newText = newText.slice(0, -1);

    const next: PatchChangeRecord = {};
    if (isDelete || newPath === '/dev/null') {
        next.type = 'delete';
        next.delete = { content: oldText };
    } else if (isAdd || oldPath === '/dev/null') {
        next.type = 'add';
        next.add = { content: newText };
    } else {
        next.type = 'update';
        next.modify = { old_content: oldText, new_content: newText };
    }

    return { filePath, change: next };
}

function normalizePatchFromUnifiedDiff(input: Record<string, unknown>): Record<string, unknown> | null {
    if (hasNonEmptyRecord(input.changes)) return null;

    const diff =
        typeof input.unified_diff === 'string'
            ? input.unified_diff
            : typeof input.diff === 'string'
                ? input.diff
                : typeof input.patch === 'string'
                    ? input.patch
                    : null;
    if (!diff || diff.trim().length === 0) return null;

    const blocks = diff.split(/\n(?=diff --git )/g);
    const changes: Record<string, unknown> = {};

    for (const block of blocks) {
        const { filePath, change } = parseUnifiedDiffFileBlock(block);
        if (!filePath || !change) continue;
        changes[filePath] = change;
    }

    if (Object.keys(changes).length === 0) return null;
    return { ...input, changes };
}

function normalizeAppliedResultAliases(result: unknown): Record<string, unknown> | null {
    const record = asRecord(result);
    if (!record) return null;
    if (typeof (record as any).applied === 'boolean') return null;
    const applied =
        typeof (record as any).ok === 'boolean'
            ? (record as any).ok
            : typeof (record as any).success === 'boolean'
                ? (record as any).success
                : null;
    if (typeof applied !== 'boolean') return null;
    return { ...record, applied };
}

type SearchMatch = { filePath?: string; line?: number; excerpt?: string };

function normalizeStringLines(value: string): string[] {
    return value
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
}

function parseGrepLine(line: string): SearchMatch | null {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;
    const match = trimmed.match(/^(.+?):(\d+):\s?(.*)$/);
    if (!match) return null;
    const n = Number(match[2]);
    return {
        filePath: match[1],
        line: Number.isFinite(n) ? n : undefined,
        excerpt: match[3],
    };
}

function normalizeMatchObject(value: unknown): SearchMatch | null {
    const record = asRecord(value);
    if (!record) return null;
    const filePath =
        typeof (record as any).filePath === 'string'
            ? (record as any).filePath
            : typeof (record as any).file_path === 'string'
                ? (record as any).file_path
                : typeof (record as any).path === 'string'
                    ? (record as any).path
                    : typeof (record as any).file === 'string'
                        ? (record as any).file
                        : undefined;
    const line =
        typeof (record as any).line === 'number'
            ? (record as any).line
            : typeof (record as any).line_number === 'number'
                ? (record as any).line_number
                : undefined;
    const excerpt =
        typeof (record as any).excerpt === 'string'
            ? (record as any).excerpt
            : typeof (record as any).text === 'string'
                ? (record as any).text
                : typeof (record as any).snippet === 'string'
                    ? (record as any).snippet
                    : undefined;

    if (!filePath && !excerpt) return null;
    return { filePath, line, excerpt };
}

function normalizeGlobResultForRendering(result: unknown): Record<string, unknown> | null {
    const record = asRecord(result);
    if (record && Array.isArray((record as any).matches) && (record as any).matches.every((v: any) => typeof v === 'string')) {
        return null;
    }

    if (Array.isArray(result) && result.every((v) => typeof v === 'string')) {
        return { matches: result };
    }

    if (typeof result === 'string') {
        const lines = normalizeStringLines(result);
        if (lines.length > 0) return { matches: lines };
    }

    if (record && Array.isArray((record as any).files) && (record as any).files.every((v: any) => typeof v === 'string')) {
        return { matches: (record as any).files };
    }

    return null;
}

function normalizeLsResultForRendering(result: unknown): Record<string, unknown> | null {
    const record = asRecord(result);
    if (record && Array.isArray((record as any).entries) && (record as any).entries.every((v: any) => typeof v === 'string')) {
        return null;
    }

    if (Array.isArray(result) && result.every((v) => typeof v === 'string')) {
        return { entries: result };
    }

    if (typeof result === 'string') {
        const lines = normalizeStringLines(result);
        if (lines.length > 0) return { entries: lines };
    }

    if (record && Array.isArray((record as any).files) && (record as any).files.every((v: any) => typeof v === 'string')) {
        return { entries: (record as any).files };
    }

    return null;
}

type TodoItem = { content?: string; status?: string; priority?: string; id?: string };

function normalizeTodoStatus(value: unknown): 'pending' | 'in_progress' | 'completed' | null {
    if (typeof value !== 'string') return null;
    const s = value.trim().toLowerCase();
    if (s === 'pending' || s === 'todo') return 'pending';
    if (s === 'in_progress' || s === 'in-progress' || s === 'doing') return 'in_progress';
    if (s === 'completed' || s === 'done') return 'completed';
    return null;
}

function coerceTodoItemForRendering(value: unknown): TodoItem | null {
    if (typeof value === 'string' && value.trim().length > 0) {
        return { content: value.trim(), status: 'pending' };
    }
    const record = asRecord(value);
    if (!record) return null;

    const content =
        firstNonEmptyString((record as any).content) ??
        firstNonEmptyString((record as any).title) ??
        firstNonEmptyString((record as any).text) ??
        null;
    if (!content) return null;

    const status = normalizeTodoStatus((record as any).status) ?? normalizeTodoStatus((record as any).state) ?? 'pending';
    const next: TodoItem = { content, status };

    const priority = firstNonEmptyString((record as any).priority);
    if (priority) next.priority = priority;
    const id = firstNonEmptyString((record as any).id);
    if (id) next.id = id;

    return next;
}

function normalizeTodoListForRendering(value: unknown): TodoItem[] | null {
    if (!Array.isArray(value)) return null;
    const out: TodoItem[] = [];
    for (const item of value) {
        const coerced = coerceTodoItemForRendering(item);
        if (!coerced) continue;
        out.push(coerced);
    }
    return out;
}

function normalizeTodoInputForRendering(input: Record<string, unknown>): Record<string, unknown> | null {
    if (Array.isArray((input as any).todos)) return null;

    const candidates =
        Array.isArray((input as any).items)
            ? (input as any).items
            : Array.isArray((input as any)._acp?.rawInput)
                ? (input as any)._acp.rawInput
                : null;
    if (!candidates) return null;

    const todos = normalizeTodoListForRendering(candidates) ?? [];
    return { ...input, todos };
}

function normalizeTodoResultForRendering(result: unknown): Record<string, unknown> | null {
    const record = asRecord(result);
    const todosFromRecord = Array.isArray((record as any)?.todos) ? (record as any).todos : null;
    const todosFromNew = record && Array.isArray((record as any).newTodos) ? (record as any).newTodos : null;

    const current = todosFromRecord ?? todosFromNew;
    if (current) {
        const normalized = normalizeTodoListForRendering(current);
        if (!normalized) return null;
        return { ...record, todos: normalized };
    }

    if (Array.isArray(result)) {
        const normalized = normalizeTodoListForRendering(result) ?? [];
        return { todos: normalized };
    }

    return null;
}

function normalizeGrepResultForRendering(result: unknown): Record<string, unknown> | null {
    const record = asRecord(result);
    if (record && Array.isArray((record as any).matches)) {
        const matches = (record as any).matches as unknown[];
        const normalized = matches
            .map((m) => {
                if (typeof m === 'string') return { excerpt: m } satisfies SearchMatch;
                return normalizeMatchObject(m);
            })
            .filter(Boolean);
        // If every entry was already a canonical-looking match object, keep the original.
        const allCanonicalObjects = matches.length > 0 && matches.every((m) => {
            const rec = asRecord(m);
            return !!rec && (typeof (rec as any).filePath === 'string' || typeof (rec as any).excerpt === 'string');
        });
        if (allCanonicalObjects) return null;
        return normalized.length > 0 ? { ...record, matches: normalized } : null;
    }

    if (typeof result === 'string') {
        const lines = normalizeStringLines(result);
        const matches: SearchMatch[] = [];
        for (const line of lines) {
            const parsed = parseGrepLine(line);
            if (parsed) matches.push(parsed);
            else matches.push({ excerpt: line });
        }
        return matches.length > 0 ? { matches } : null;
    }

    if (Array.isArray(result) && result.every((v) => typeof v === 'string')) {
        return { matches: (result as string[]).map((s) => ({ excerpt: s })) };
    }

    if (record && typeof (record as any).stdout === 'string') {
        return normalizeGrepResultForRendering((record as any).stdout);
    }

    return null;
}

function parseOpenCodeSearch(text: string): { matches: SearchMatch[] } | null {
    if (!text.includes('matches')) return null;
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const matches: SearchMatch[] = [];
    let currentFile: string | null = null;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        if (!line.startsWith(' ') && trimmed.endsWith(':') && trimmed.includes('/')) {
            currentFile = trimmed.slice(0, -1);
            continue;
        }

        const m = trimmed.match(/^Line\s+(\d+):\s?(.*)$/i);
        if (m && currentFile) {
            const n = Number(m[1]);
            matches.push({
                filePath: currentFile,
                line: Number.isFinite(n) ? n : undefined,
                excerpt: m[2],
            });
            continue;
        }

        const grep = parseGrepLine(line);
        if (grep) matches.push(grep);
    }

    return matches.length > 0 ? { matches } : null;
}

function normalizeCodeSearchResultForRendering(result: unknown): Record<string, unknown> | null {
    const record = asRecord(result);
    if (record && Array.isArray((record as any).matches)) {
        const matches = (record as any).matches as unknown[];
        const normalized = matches
            .map((m) => {
                if (typeof m === 'string') return { excerpt: m } satisfies SearchMatch;
                return normalizeMatchObject(m);
            })
            .filter(Boolean);
        const allCanonicalObjects = matches.length > 0 && matches.every((m) => {
            const rec = asRecord(m);
            return !!rec && (typeof (rec as any).filePath === 'string' || typeof (rec as any).excerpt === 'string');
        });
        if (allCanonicalObjects) return null;
        return normalized.length > 0 ? { ...record, matches: normalized } : null;
    }

    if (typeof result === 'string') {
        const parsed = parseOpenCodeSearch(result);
        if (parsed) return parsed;
        const lines = normalizeStringLines(result);
        if (lines.length > 0) return { matches: lines.map((line) => ({ excerpt: line })) };
        return null;
    }

    if (Array.isArray(result) && result.every((v) => typeof v === 'string')) {
        return { matches: (result as string[]).map((s) => ({ excerpt: s })) };
    }

    if (record && typeof (record as any).stdout === 'string') {
        return normalizeCodeSearchResultForRendering((record as any).stdout);
    }

    return null;
}

function normalizeReasoningResultForRendering(result: unknown): Record<string, unknown> | null {
    const record = asRecord(result);
    if (!record) return null;
    if (typeof (record as any).content === 'string' && (record as any).content.trim().length > 0) return null;

    const content =
        firstNonEmptyString((record as any).text) ??
        firstNonEmptyString((record as any).reasoning) ??
        null;
    if (!content) return null;
    return { ...record, content };
}

function coerceSingleLocationPath(locations: unknown): string | null {
    if (!Array.isArray(locations) || locations.length !== 1) return null;
    const first = asRecord(locations[0]);
    if (!first) return null;
    return (
        firstNonEmptyString(first.path) ??
        firstNonEmptyString(first.filePath) ??
        null
    );
}

function normalizeFilePathFromLocations(input: Record<string, unknown>): Record<string, unknown> | null {
    if (typeof input.file_path === 'string' && input.file_path.trim().length > 0) return null;
    const locPath = coerceSingleLocationPath(input.locations);
    if (!locPath) return null;
    return { ...input, file_path: locPath };
}

function normalizeFromAcpItems(input: Record<string, unknown>, opts: { toolNameLower: string }): Record<string, unknown> | null {
    const items = Array.isArray((input as any).items)
        ? ((input as any).items as unknown[])
        : Array.isArray((input as any).content)
            ? ((input as any).content as unknown[])
            : null;
    if (!items || items.length === 0) return null;
    const first = asRecord(items[0]);
    if (!first) return null;

    const itemPath =
        firstNonEmptyString(first.path) ??
        firstNonEmptyString(first.filePath) ??
        null;
    const oldText =
        firstNonEmptyString(first.oldText) ??
        firstNonEmptyString(first.old_string) ??
        firstNonEmptyString(first.oldString) ??
        null;
    const newText =
        firstNonEmptyString(first.newText) ??
        firstNonEmptyString(first.new_string) ??
        firstNonEmptyString(first.newString) ??
        null;

    let changed = false;
    const next: Record<string, unknown> = { ...input };

    if (itemPath && (typeof next.file_path !== 'string' || next.file_path.trim().length === 0)) {
        next.file_path = itemPath;
        changed = true;
    }

    if (opts.toolNameLower === 'write') {
        if (typeof next.content !== 'string' && newText) {
            next.content = newText;
            changed = true;
        }
    }

    if (opts.toolNameLower === 'edit') {
        if (typeof next.old_string !== 'string' && oldText) {
            next.old_string = oldText;
            changed = true;
        }
        if (typeof next.new_string !== 'string' && newText) {
            next.new_string = newText;
            changed = true;
        }
    }

    return changed ? next : null;
}

function normalizeFilePathAliases(input: Record<string, unknown>): Record<string, unknown> | null {
    const currentFilePath = typeof input.file_path === 'string' ? input.file_path : null;
    const alias =
        typeof input.filePath === 'string'
            ? input.filePath
            : typeof input.path === 'string'
                ? input.path
                : null;
    if (!currentFilePath && alias) {
        return { ...input, file_path: alias };
    }
    return null;
}

function normalizeEditAliases(input: Record<string, unknown>): Record<string, unknown> | null {
    const maybeWithPath = normalizeFilePathAliases(input) ?? input;

    const hasOld = typeof maybeWithPath.old_string === 'string';
    const hasNew = typeof maybeWithPath.new_string === 'string';
    const oldAlias =
        typeof maybeWithPath.oldText === 'string'
            ? maybeWithPath.oldText
            : typeof maybeWithPath.oldString === 'string'
                ? maybeWithPath.oldString
                : null;
    const newAlias =
        typeof maybeWithPath.newText === 'string'
            ? maybeWithPath.newText
            : typeof maybeWithPath.newString === 'string'
                ? maybeWithPath.newString
                : null;

    const next: Record<string, unknown> = { ...maybeWithPath };
    let changed = maybeWithPath !== input;
    if (!hasOld && oldAlias) {
        next.old_string = oldAlias;
        changed = true;
    }
    if (!hasNew && newAlias) {
        next.new_string = newAlias;
        changed = true;
    }
    return changed ? next : null;
}

function normalizeWriteAliases(input: Record<string, unknown>): Record<string, unknown> | null {
    const maybeWithPath = normalizeFilePathAliases(input) ?? input;

    const currentContent = typeof maybeWithPath.content === 'string' ? maybeWithPath.content : null;
    const alias =
        typeof maybeWithPath.newText === 'string'
            ? maybeWithPath.newText
            : typeof maybeWithPath.text === 'string'
                ? maybeWithPath.text
                : typeof maybeWithPath.file_content === 'string'
                    ? maybeWithPath.file_content
                    : typeof maybeWithPath.fileContent === 'string'
                        ? maybeWithPath.fileContent
                        : typeof maybeWithPath.newString === 'string'
                            ? maybeWithPath.newString
                            : typeof maybeWithPath.new_string === 'string'
                                ? maybeWithPath.new_string
                                : null;

    const next: Record<string, unknown> = { ...maybeWithPath };
    let changed = maybeWithPath !== input;
    if (!currentContent && alias) {
        next.content = alias;
        changed = true;
    }
    return changed ? next : null;
}

function normalizeDeleteAliases(input: Record<string, unknown>): Record<string, unknown> | null {
    const record = normalizeFilePathAliases(input) ?? input;
    const next: Record<string, unknown> = { ...record };
    let changed = record !== input;

    const current = Array.isArray((record as any).file_paths) ? ((record as any).file_paths as unknown[]) : null;
    const currentPaths =
        current
            ? current
                .filter((v): v is string => typeof v === 'string')
                .map((v) => v.trim())
                .filter((v) => v.length > 0)
            : null;

    if (!currentPaths || currentPaths.length === 0) {
        const single =
            firstNonEmptyString((record as any).file_path) ??
            firstNonEmptyString((record as any).filePath) ??
            firstNonEmptyString((record as any).path) ??
            null;
        if (single) {
            next.file_paths = [single];
            changed = true;
        }
    } else if (currentPaths.length !== current?.length) {
        next.file_paths = currentPaths;
        changed = true;
    }

    return changed ? next : null;
}

export function normalizeToolCallForRendering(tool: ToolCall): ToolCall {
    const parsedInput = maybeParseJson(tool.input);
    const parsedResult = maybeParseJson(tool.result);
    const canonicalizeName = (toolName: string, input: unknown): string => {
        const inputObj = asRecord(input);
        const happy = asRecord(inputObj?._happy);
        const canonicalFromHappy = firstNonEmptyString(happy?.canonicalToolName);
        if (canonicalFromHappy) return canonicalFromHappy;

        if (toolName === 'CodexPatch' || toolName === 'GeminiPatch') return 'Patch';
        if (toolName === 'CodexDiff' || toolName === 'GeminiDiff') return 'Diff';
        if (toolName === 'CodexReasoning' || toolName === 'GeminiReasoning' || toolName === 'think') return 'Reasoning';
        if (toolName === 'exit_plan_mode') return 'ExitPlanMode';

        if (toolName === 'mcp__happy__change_title') return 'change_title';

        const lower = toolName.toLowerCase();
        if (lower === 'patch') return 'Patch';
        if (lower === 'diff') return 'Diff';
        if (
            lower === 'execute' ||
            lower === 'shell' ||
            lower === 'bash' ||
            toolName === 'GeminiBash' ||
            toolName === 'CodexBash'
        ) {
            return 'Bash';
        }
        if (lower === 'read' || lower === 'read_file' || lower === 'readfile') return 'Read';
        if (lower === 'delete' || lower === 'remove') {
            const changes = asRecord(inputObj?.changes);
            if (changes && Object.keys(changes).length > 0) return 'Patch';
            return 'Delete';
        }
        if (lower === 'edit') {
            if (hasNonEmptyRecord(inputObj?.changes)) return 'Patch';
            return 'Edit';
        }
        if (lower === 'edit_file' || lower === 'editfile') {
            if (hasNonEmptyRecord(inputObj?.changes)) return 'Patch';
            return 'Edit';
        }
        if (lower === 'write') {
            const hasTodos = Array.isArray(inputObj?.todos) && inputObj?.todos.length > 0;
            return hasTodos ? 'TodoWrite' : 'Write';
        }
        if (lower === 'write_file' || lower === 'writefile') {
            const hasTodos = Array.isArray(inputObj?.todos) && inputObj?.todos.length > 0;
            return hasTodos ? 'TodoWrite' : 'Write';
        }

        if (lower === 'glob') return 'Glob';
        if (lower === 'grep') return 'Grep';
        if (lower === 'ls') return 'LS';
        if (lower === 'web_fetch' || lower === 'webfetch') return 'WebFetch';
        if (lower === 'web_search' || lower === 'websearch') return 'WebSearch';

        if (lower === 'search') {
            const hasQuery =
                !!firstNonEmptyString(inputObj?.query) ||
                !!firstNonEmptyString(inputObj?.pattern) ||
                !!firstNonEmptyString(inputObj?.text);
            // Gemini internal "search" often has only items/locations and is intentionally minimal/hidden.
            return hasQuery ? 'CodeSearch' : toolName;
        }

        if (lower === 'unknown tool') {
            const inputObj = asRecord(input);
            const title =
                firstNonEmptyString(inputObj?.title) ??
                firstNonEmptyString(asRecord(inputObj?.toolCall)?.title) ??
                null;
            if (title === 'Workspace Indexing Permission') return 'WorkspaceIndexingPermission';
        }

        return toolName;
    };

    const nextName = canonicalizeName(tool.name, parsedInput);
    const canonicalLower = nextName.toLowerCase();
    let nextInput: unknown = parsedInput;
    let nextResult: unknown = parsedResult;

    const inputRecord = asRecord(nextInput);
    if (inputRecord) {
        const toolNameLower = tool.name.toLowerCase();
        nextInput =
            normalizeFilePathFromLocations(inputRecord) ??
            normalizeFromAcpItems(inputRecord, { toolNameLower: canonicalLower }) ??
            inputRecord;
        const inputRecord2 = asRecord(nextInput) ?? inputRecord;
        if (canonicalLower === 'patch') {
            nextInput = normalizePatchFromUnifiedDiff(inputRecord2) ?? inputRecord2;
        }
        if (canonicalLower === 'edit') {
            nextInput = normalizeEditAliases(inputRecord2) ?? inputRecord2;
        } else if (canonicalLower === 'write') {
            nextInput = normalizeWriteAliases(inputRecord2) ?? inputRecord2;
        } else if (canonicalLower === 'todowrite') {
            nextInput = normalizeTodoInputForRendering(inputRecord2) ?? inputRecord2;
        } else if (canonicalLower === 'delete') {
            nextInput = normalizeDeleteAliases(inputRecord2) ?? inputRecord2;
        } else if (canonicalLower === 'read') {
            nextInput = normalizeFilePathAliases(inputRecord2) ?? inputRecord2;
        }

        if (nextName === 'Diff') {
            nextInput = normalizeDiffAliases(asRecord(nextInput) ?? inputRecord2) ?? nextInput;
        }
    }

    if (canonicalLower === 'patch') {
        nextResult = normalizeAppliedResultAliases(nextResult) ?? nextResult;
    }
    if (canonicalLower === 'glob') {
        nextResult = normalizeGlobResultForRendering(nextResult) ?? nextResult;
    }
    if (canonicalLower === 'ls') {
        nextResult = normalizeLsResultForRendering(nextResult) ?? nextResult;
    }
    if (canonicalLower === 'grep') {
        nextResult = normalizeGrepResultForRendering(nextResult) ?? nextResult;
    }
    if (canonicalLower === 'codesearch') {
        nextResult = normalizeCodeSearchResultForRendering(nextResult) ?? nextResult;
    }
    if (canonicalLower === 'reasoning') {
        nextResult = normalizeReasoningResultForRendering(nextResult) ?? nextResult;
    }
    if (canonicalLower === 'todowrite' || canonicalLower === 'todoread') {
        nextResult = normalizeTodoResultForRendering(nextResult) ?? nextResult;
    }

    const nameChanged = nextName !== tool.name;
    const inputChanged = nextInput !== tool.input;
    const resultChanged = nextResult !== tool.result;
    if (!nameChanged && !inputChanged && !resultChanged) return tool;
    return { ...tool, name: nextName, input: nextInput, result: nextResult };
}
