import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { WorkspaceFileEditSetFile } from '@happier-dev/protocol/machines/workspaceFiles';
import { applyWorkspaceFileTextEdits } from './documentText';
import { readLspObject, readLspRange } from './languageServerResults';
import { LspWorkspacePathError, resolveWorkspacePath, workspaceUriToPath } from './workspaceUris';

export class LspWorkspaceEditError extends Error {
    constructor(readonly code: 'invalid_request' | 'unsaved_editor_changes' | 'stale_query', readonly diskHash?: string) { super(code); }
}

/** The only LSP WorkspaceEdit → guarded filesystem operation adapter. */
export async function normalizeWorkspaceEdit(input: Readonly<{
    rootPath: string;
    platform: NodeJS.Platform;
    edit: unknown;
    document(path: string): Readonly<{ text: string; version: number; unsaved: boolean }> | undefined;
    /** Editor-only previews address the held buffer; guarded disk writes still require the returned hash. */
    text?: 'held' | 'disk';
    rename?: Readonly<{ path: string; newPath: string }>;
}>): Promise<WorkspaceFileEditSetFile[]> {
    const files = new Map<string, { edits: WorkspaceFileEditSetFile['edits']; renameTo?: string; version?: number }>();
    const renamedPaths = new Map<string, string>();
    function pathFromUri(uri: unknown): string {
        if (typeof uri !== 'string') throw new LspWorkspaceEditError('invalid_request');
        const target = workspaceUriToPath(input, uri);
        if (target.outsideWorkspace) throw new LspWorkspacePathError('invalid_path', 'Workspace edit leaves its root');
        return target.path;
    }
    function file(path: string) {
        let value = files.get(path);
        if (!value) { value = { edits: [] }; files.set(path, value); }
        return value;
    }
    function edits(path: string, raw: unknown, version?: unknown) {
        if (!Array.isArray(raw)) throw new LspWorkspaceEditError('invalid_request');
        const target = file(renamedPaths.get(path) ?? path);
        if (version !== undefined && version !== null) {
            if (!Number.isInteger(version) || (target.version !== undefined && target.version !== version)) throw new LspWorkspaceEditError('invalid_request');
            target.version = version as number;
        }
        for (const item of raw) {
            const edit = readLspObject(item);
            if (!edit || typeof edit.newText !== 'string' || edit.annotationId !== undefined) throw new LspWorkspaceEditError('invalid_request');
            target.edits.push({ range: readLspRange(edit.range), text: edit.newText });
        }
    }
    if (input.edit !== null && input.edit !== undefined) {
        const value = readLspObject(input.edit);
        if (!value) throw new LspWorkspaceEditError('invalid_request');
        if (value.changeAnnotations !== undefined) throw new LspWorkspaceEditError('invalid_request');
        if (value.changes !== undefined) {
            const changes = readLspObject(value.changes);
            if (!changes) throw new LspWorkspaceEditError('invalid_request');
            for (const [uri, raw] of Object.entries(changes)) edits(pathFromUri(uri), raw);
        }
        if (value.documentChanges !== undefined) {
            if (!Array.isArray(value.documentChanges)) throw new LspWorkspaceEditError('invalid_request');
            for (const raw of value.documentChanges) {
                const change = readLspObject(raw);
                if (!change) throw new LspWorkspaceEditError('invalid_request');
                if (change.kind !== undefined) {
                    const options = readLspObject(change.options);
                    if (change.kind !== 'rename' || change.options !== undefined && (!options || Object.entries(options).some(([key, value]) => !['overwrite', 'ignoreIfExists'].includes(key) || value !== false)) || change.annotationId !== undefined) throw new LspWorkspaceEditError('invalid_request');
                    const sourcePath = pathFromUri(change.oldUri);
                    if (renamedPaths.has(sourcePath)) throw new LspWorkspaceEditError('invalid_request');
                    const target = file(sourcePath);
                    const destination = pathFromUri(change.newUri);
                    if (target.renameTo && target.renameTo !== destination) throw new LspWorkspaceEditError('invalid_request');
                    target.renameTo = destination;
                    renamedPaths.set(destination, sourcePath);
                } else {
                    const document = readLspObject(change.textDocument);
                    if (!document) throw new LspWorkspaceEditError('invalid_request');
                    edits(pathFromUri(document.uri), change.edits, document.version);
                }
            }
        }
    }
    if (input.rename) {
        const target = file(input.rename.path);
        if (target.renameTo && target.renameTo !== input.rename.newPath) throw new LspWorkspaceEditError('invalid_request');
        target.renameTo = input.rename.newPath;
    }
    const results: WorkspaceFileEditSetFile[] = [];
    for (const [path, value] of files) {
        const held = input.document(path);
        const useHeld = input.text === 'held' && held !== undefined;
        const bytes = useHeld ? Buffer.from(held.text, 'utf8') : await readFile(resolveWorkspacePath(input, path));
        const expectedHash = createHash('sha256').update(bytes).digest('hex');
        if (held?.unsaved && !useHeld) throw new LspWorkspaceEditError('unsaved_editor_changes', expectedHash);
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        if (held && (held.text !== text || (value.version !== undefined && held.version !== value.version))) throw new LspWorkspaceEditError('stale_query');
        if (!held && value.version !== undefined) throw new LspWorkspaceEditError('stale_query');
        try { applyWorkspaceFileTextEdits(text, value.edits); }
        catch { throw new LspWorkspaceEditError('invalid_request'); }
        results.push({ path, expectedHash, edits: value.edits, ...(value.renameTo ? { renameTo: value.renameTo } : {}) });
    }
    return results;
}
