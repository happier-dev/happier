import type { NormalizedMessage } from "@happier-dev/session-core/raw";
import { deriveCanonicalPatchFileDiffs } from '@happier-dev/protocol/tools/v2';
import { resolveToolMutationClassification } from '@/sync/domains/tools/toolMutationClassification';
import { LanguageIntelligenceCodeActionOperationSchema } from '@happier-dev/protocol/machines/languageIntelligence';
import { DaemonWorkspaceFileReplaceApplyResponseSchema, WorkspaceFileEditSetFileSchema } from '@happier-dev/protocol/machines/workspaceFiles';
import { isRecord, readHappierActionCallId, readHappierActionCallInput, readHappierActionToolResultCandidates } from '@/components/sessions/transcript/references/happierActionToolResult';
import { resolveMachineAbsolutePath } from '@/sync/domains/fileSystem/resolveMachineAbsolutePath';

export type WorkspaceMutationExtractionResult = Readonly<{
    paths: ReadonlySet<string>;
    hasUnknownMutations: boolean;
}>;

export type ToolCallFileMutation = Readonly<{
    kind: 'create' | 'modify' | 'delete' | 'rename';
    region?: Readonly<{ startLine: number; endLine: number }>;
    /** The text an edit replaces, when the call names no lines: the open file places it (P5 Track). */
    anchorText?: string;
    /** The canonical hunk parser, rather than a second header parser, reads this at projection. */
    unifiedDiff?: string;
}>;

export type ToolCallMutationPaths = WorkspaceMutationExtractionResult & Readonly<{
    mutations: ReadonlyMap<string, ToolCallFileMutation>;
}>;

type MutationToolKind =
    | 'single-path'
    | 'patch'
    | 'path-pair'
    | 'opaque-executor'
    | 'container'
    | 'unknown';

const FILE_PATH_FIELD_KEYS = ['path', 'filePath', 'file_path', 'filename', 'fileName'] as const;
const PATH_PAIR_FIELD_KEYS = ['path', 'from', 'to', 'src', 'dest'] as const;

function normalizeMutationToolName(name: string): string | null {
    const normalizedName = name.trim().toLowerCase();
    return normalizedName.length > 0 ? normalizedName : null;
}

function readHappierMetaRecord(input: unknown): Record<string, unknown> | null {
    if (input === null || input === undefined) return null;
    if (typeof input !== 'object') return null;

    const record = input as Record<string, unknown>;
    for (const happierKey of ['_happier', '_happy'] as const) {
        const meta = record[happierKey];
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
        return meta as Record<string, unknown>;
    }

    return null;
}

function readCanonicalMutationToolName(input: unknown): string | null {
    const meta = readHappierMetaRecord(input);
    if (meta) {
        const canonicalToolName = meta.canonicalToolName;
        if (typeof canonicalToolName === 'string') {
            const normalizedName = normalizeMutationToolName(canonicalToolName);
            if (normalizedName) return normalizedName;
        }
    }

    return null;
}

function hasWorkspaceMutationSignal(input: unknown): boolean {
    const meta = readHappierMetaRecord(input);
    return meta?.workspaceMutationSignal === 'turn-change-set';
}

function resolveMutationToolKind(name: string): MutationToolKind | null {
    const normalizedName = normalizeMutationToolName(name);
    if (!normalizedName) return null;
    const sharedClassification = resolveToolMutationClassification(normalizedName);
    switch (sharedClassification) {
        case 'single_path':
            return 'single-path';
        case 'patch':
            return 'patch';
        case 'path_pair':
            return 'path-pair';
        case 'opaque_executor':
            return 'opaque-executor';
        case 'container':
            return 'container';
        case 'mutating_unknown':
            return 'unknown';
        case 'read_only':
            return null;
        default:
            return null;
    }
}

function resolveMutationToolKindFromToolCall(name: string, input: unknown): MutationToolKind | null {
    const canonicalToolName = readCanonicalMutationToolName(input);
    if (canonicalToolName) {
        const canonicalToolKind = resolveMutationToolKind(canonicalToolName);
        if (canonicalToolKind) return canonicalToolKind;
    }

    return resolveMutationToolKind(name);
}

function resolveNormalizedMutationToolNameFromToolCall(name: string, input: unknown): string | null {
    return readCanonicalMutationToolName(input) ?? normalizeMutationToolName(name);
}

function readStringField(input: unknown, keys: readonly string[]): string | null {
    if (input === null || input === undefined) return null;
    if (typeof input !== 'object') return null;
    const record = input as Record<string, unknown>;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }
    return null;
}

function collectStringFields(input: unknown, keys: readonly string[]): string[] {
    if (input === null || input === undefined) return [];
    if (typeof input !== 'object') return [];

    const record = input as Record<string, unknown>;
    const out: string[] = [];
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim().length > 0) {
            out.push(value);
        }
    }
    return out;
}

function collectPathsFromChangeList(input: unknown, key: string): string[] {
    if (input === null || input === undefined) return [];
    if (typeof input !== 'object') return [];
    const record = input as Record<string, unknown>;
    const raw = record[key];
    if (!Array.isArray(raw)) return [];

    const out: string[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const path = (entry as Record<string, unknown>).path;
        if (typeof path === 'string' && path.trim().length > 0) {
            out.push(path);
        }
    }
    return out;
}

function collectPathsFromChangeMap(input: unknown, key: string): string[] {
    if (input === null || input === undefined) return [];
    if (typeof input !== 'object') return [];
    const record = input as Record<string, unknown>;
    const raw = record[key];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    return Object.keys(raw).filter((path) => path.trim().length > 0);
}

function collectPathsFromStringArrayField(input: unknown, key: string): string[] {
    if (input === null || input === undefined) return [];
    if (typeof input !== 'object') return [];
    const record = input as Record<string, unknown>;
    const raw = record[key];
    if (!Array.isArray(raw)) return [];

    const out: string[] = [];
    for (const entry of raw) {
        if (typeof entry === 'string' && entry.trim().length > 0) {
            out.push(entry);
        }
    }
    return out;
}

function collectPathsFromDiffFiles(input: unknown): string[] {
    if (input === null || input === undefined) return [];
    if (typeof input !== 'object') return [];
    const record = input as Record<string, unknown>;
    const raw = record.files;
    if (!Array.isArray(raw)) return [];

    const out: string[] = [];
    for (const entry of raw) {
        const path = readStringField(entry, FILE_PATH_FIELD_KEYS);
        if (path) out.push(path);
    }
    return out;
}

function readGuardedWriterMutations(result: unknown, input?: unknown): readonly Readonly<{ path: string; renameTo?: string }>[] {
    for (const candidate of readHappierActionToolResultCandidates(result, input)) {
        const parsed = DaemonWorkspaceFileReplaceApplyResponseSchema.safeParse(candidate);
        if (!parsed.success) continue;
        return parsed.data.ok ? parsed.data.results.filter(receipt => receipt.status === 'replaced' || receipt.status === 'restored') : [];
    }
    return [];
}

/** Shared per-call path owner for SCM invalidation and transient file-write projections. */
export function readToolCallMutationPaths(toolPart: Readonly<{ name: string; input: unknown; result?: unknown; state?: string }>): ToolCallMutationPaths {
    const paths = new Set<string>();
    let hasUnknownMutations = false;
    const { name, input: toolInput } = toolPart;
    const actionId = readHappierActionCallId(name, toolInput);
    if (actionId === 'code.rename.apply' || actionId === 'code.file.rename.apply' || actionId === 'code.codeAction.apply') {
        const mutations = new Map<string, ToolCallFileMutation>();
        const operands = readHappierActionCallInput(name, toolInput);
        const rootPath = isRecord(operands) && typeof operands.rootPath === 'string' ? operands.rootPath : null;
        const add = (path: string, renameTo?: string) => {
            if (!rootPath) return;
            path = resolveMachineAbsolutePath({ rootPath, requestPath: path, pathKind: 'workspace_entry' });
            if (renameTo) renameTo = resolveMachineAbsolutePath({ rootPath, requestPath: renameTo, pathKind: 'workspace_entry' });
            const mutation = { kind: renameTo ? 'rename' : 'modify' } as const;
            paths.add(path); mutations.set(path, mutation);
            if (renameTo) { paths.add(renameTo); mutations.set(renameTo, mutation); }
        };
        // Terminal evidence comes from the guarded writer, not the reviewed intent. A
        // server command may also write files absent from that intent, or partly fail.
        if (toolPart.state === 'completed' || toolPart.state === 'error' || toolPart.result !== undefined) {
            for (const receipt of readGuardedWriterMutations(toolPart.result, toolInput)) add(receipt.path, receipt.renameTo);
        } else {
            if (actionId === 'code.codeAction.apply') {
                const parsed = LanguageIntelligenceCodeActionOperationSchema.safeParse(isRecord(operands) ? operands.operation : undefined);
                if (parsed.success) {
                    for (const file of parsed.data.action.files) add(file.path, file.renameTo);
                    hasUnknownMutations = parsed.data.action.hasCommand;
                }
            } else {
                if (isRecord(operands) && Array.isArray(operands.files)) for (const entry of operands.files) {
                    const parsed = WorkspaceFileEditSetFileSchema.safeParse(entry);
                    if (parsed.success) add(parsed.data.path, parsed.data.renameTo);
                }
            }
        }
        return { paths, hasUnknownMutations, mutations };
    }
    const toolKind = resolveMutationToolKindFromToolCall(name, toolInput);
    const normalizedName = resolveNormalizedMutationToolNameFromToolCall(name, toolInput);
    const mutations = new Map<string, ToolCallFileMutation>();
    const defaultKind: ToolCallFileMutation['kind'] = normalizedName === 'rename' || normalizedName === 'move'
        ? 'rename'
        : normalizedName === 'delete' || normalizedName === 'delete_file' || normalizedName === 'rm' || normalizedName === 'unlink'
            ? 'delete'
            : normalizedName === 'write' || normalizedName === 'write_file' || normalizedName === 'create_file' || normalizedName === 'mkdir'
                ? 'create' : 'modify';
    if (normalizedName === 'diff' && hasWorkspaceMutationSignal(toolInput)) {
        const diffPaths = collectPathsFromDiffFiles(toolInput);
        for (const path of diffPaths) paths.add(path);
        hasUnknownMutations = diffPaths.length === 0;
        // A turn recap invalidates SCM, but does not perform a write. Its paths
        // belong to the repository checkpoint, not the live tool's Session cwd.
        return { paths, hasUnknownMutations, mutations };
    } else if (toolKind === 'single-path') {
        const path = readStringField(toolInput, FILE_PATH_FIELD_KEYS);
        if (path) paths.add(path);
        for (const extraPath of collectPathsFromStringArrayField(toolInput, 'file_paths')) paths.add(extraPath);
    } else if (toolKind === 'patch') {
        for (const path of collectPathsFromChangeList(toolInput, 'changes')) paths.add(path);
        for (const path of collectPathsFromChangeMap(toolInput, 'changes')) paths.add(path);
        const singlePath = readStringField(toolInput, FILE_PATH_FIELD_KEYS);
        if (singlePath) paths.add(singlePath);
        for (const path of collectPathsFromStringArrayField(toolInput, 'file_paths')) paths.add(path);
    } else if (toolKind === 'path-pair') {
        for (const path of collectStringFields(toolInput, PATH_PAIR_FIELD_KEYS)) paths.add(path);
    } else if (toolKind === 'opaque-executor' || toolKind === 'unknown') {
        // Shell commands can mutate any file; parsing command text would guess authority.
        hasUnknownMutations = true;
    } else if (toolKind !== 'container') {
        hasUnknownMutations = readStringField(toolInput, ['command', 'cmd']) !== null;
    }
    const region = readInputRegion(toolInput) ?? readWrittenContentRegion(toolInput);
    const anchorText = region ? undefined : readInputAnchorText(toolInput);
    for (const path of paths) mutations.set(path, { kind: defaultKind, ...(region ? { region } : {}), ...(anchorText ? { anchorText } : {}) });
    if (toolKind === 'patch') {
        // This normalizer owns ACP arrays, Codex apply_patch text and canonical change maps.
        for (const file of deriveCanonicalPatchFileDiffs(toolInput)) {
            const kind: ToolCallFileMutation['kind'] = file.changeKind === 'added' || file.changeKind === 'copied'
                ? 'create' : file.changeKind === 'deleted' ? 'delete' : file.changeKind === 'renamed' ? 'rename' : 'modify';
            const mutation: ToolCallFileMutation = { kind, ...(file.unifiedDiff ? { unifiedDiff: file.unifiedDiff } : {}) };
            paths.add(file.filePath);
            mutations.set(file.filePath, mutation);
            if (file.previousFilePath) {
                paths.add(file.previousFilePath);
                mutations.set(file.previousFilePath, mutation);
            }
        }
    }
    return { paths, hasUnknownMutations, mutations };
}

function readInputRegion(input: unknown): ToolCallFileMutation['region'] {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const record = input as Record<string, unknown>;
    const startLine = record.start_line ?? record.startLine ?? record.line_number;
    const endLine = record.end_line ?? record.endLine ?? startLine;
    return typeof startLine === 'number' && Number.isInteger(startLine) && startLine > 0
        && typeof endLine === 'number' && Number.isInteger(endLine) && endLine >= startLine
        ? Object.freeze({ startLine, endLine }) : undefined;
}

/** A Write lands as its whole content (P5 §3.10, lab tr T1 is a new file): lines 1 to its last line. */
function readWrittenContentRegion(input: unknown): ToolCallFileMutation['region'] {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const content = (input as Record<string, unknown>).content;
    if (typeof content !== 'string' || content.length === 0) return undefined;
    const lines = content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length;
    return Object.freeze({ startLine: 1, endLine: lines });
}

/** Edit's `old_string`, or MultiEdit's first edit's: where the write lands when no lines are named. */
function readInputAnchorText(input: unknown): string | undefined {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const record = input as Record<string, unknown>;
    const edits = Array.isArray(record.edits) ? record.edits : null;
    const first = edits?.[0];
    const source = first && typeof first === 'object' && !Array.isArray(first) ? first as Record<string, unknown> : record;
    const text = source.old_string ?? source.oldText;
    return typeof text === 'string' && text.trim().length > 0 ? text : undefined;
}

export function extractWorkspaceMutationsFromNormalizedMessages(input: Readonly<{
    messages: readonly NormalizedMessage[];
}>): WorkspaceMutationExtractionResult {
    const paths = new Set<string>();
    let hasUnknownMutations = false;
    for (const message of input.messages) {
        if (!message || message.role !== 'agent' || !Array.isArray(message.content)) continue;
        for (const part of message.content) {
            if (part.type === 'tool-call') {
                const extracted = readToolCallMutationPaths(part);
                for (const path of extracted.paths) paths.add(path);
                hasUnknownMutations ||= extracted.hasUnknownMutations;
            } else if (part.type === 'tool-result') {
                // A result-only socket batch has no Action root. It proves a write,
                // not that its relative paths belong to this Session's workspace.
                hasUnknownMutations ||= readGuardedWriterMutations(part.content).length > 0;
                for (const path of collectPathsFromChangeList(part.content, 'changedFiles')) paths.add(path);
            }
        }
    }

    return { paths, hasUnknownMutations };
}
