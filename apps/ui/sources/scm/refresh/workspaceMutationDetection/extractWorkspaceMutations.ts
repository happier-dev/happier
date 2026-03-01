import type { NormalizedMessage } from '@/sync/typesRaw';

export type WorkspaceMutationExtractionResult = Readonly<{
    paths: ReadonlySet<string>;
    hasUnknownMutations: boolean;
}>;

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

export function extractWorkspaceMutationsFromNormalizedMessages(input: Readonly<{
    messages: readonly NormalizedMessage[];
}>): WorkspaceMutationExtractionResult {
    const paths = new Set<string>();
    let hasUnknownMutations = false;

    for (const message of input.messages) {
        if (!message || message.role !== 'agent') continue;
        if (!Array.isArray(message.content)) continue;

        for (const part of message.content) {
            if (!part || typeof part !== 'object') continue;
            const type = (part as any).type;
            if (type === 'tool-call') {
                const name = typeof (part as any).name === 'string' ? String((part as any).name) : '';
                const toolInput = (part as any).input as unknown;

                if (name === 'file-edit') {
                    const path = readStringField(toolInput, ['filePath', 'path', 'file_path']);
                    if (path) paths.add(path);
                    continue;
                }

                if (name === 'patch' || name === 'apply_patch') {
                    for (const path of collectPathsFromChangeList(toolInput, 'changes')) {
                        paths.add(path);
                    }
                    const singlePath = readStringField(toolInput, ['path', 'filePath', 'file_path']);
                    if (singlePath) paths.add(singlePath);
                    continue;
                }

                if (name === 'write_file' || name === 'edit_file' || name === 'create_file' || name === 'delete_file') {
                    const path = readStringField(toolInput, ['path', 'filePath', 'file_path', 'filename', 'fileName']);
                    if (path) paths.add(path);
                    continue;
                }

                if (name === 'mkdir' || name === 'rm' || name === 'unlink' || name === 'rename' || name === 'move') {
                    const path = readStringField(toolInput, ['path', 'from', 'to', 'src', 'dest']);
                    if (path) paths.add(path);
                    continue;
                }

                if (name === 'bash' || name === 'exec' || name === 'shell') {
                    // Best-effort only: shell commands can mutate any files, but extracting paths is brittle.
                    hasUnknownMutations = true;
                    continue;
                }

                // Unknown tools: if we can't safely extract paths, mark unknown mutations only when
                // the tool is plausibly mutating (heuristic: it has an input with a command string).
                const command = readStringField(toolInput, ['command', 'cmd']);
                if (command) {
                    hasUnknownMutations = true;
                }
                continue;
            }

            if (type === 'tool-result') {
                // Tool results may contain structured “files changed” metadata, but providers vary a lot.
                // Keep this best-effort and conservative.
                const content = (part as any).content as unknown;
                const changed = collectPathsFromChangeList(content, 'changedFiles');
                for (const path of changed) paths.add(path);
            }
        }
    }

    return { paths, hasUnknownMutations };
}
