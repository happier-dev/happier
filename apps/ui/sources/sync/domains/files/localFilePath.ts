import { z } from 'zod';

import { resolveAbsolutePath } from '@/utils/path/pathUtils';

/**
 * A folder on a session's machine and the same folder as this computer reaches it, for example a
 * server's `/srv/projects` shared to Windows as `\\server\projects`. Device-local: only this computer
 * knows how it reaches the other machine.
 */
export const DesktopPathMappingSchema = z.object({
    remotePath: z.string().trim().min(1),
    localPath: z.string().trim().min(1),
});

export type DesktopPathMapping = z.infer<typeof DesktopPathMappingSchema>;

/** Keeps every valid mapping when one stored entry is malformed. */
export const DesktopPathMappingsSchema = z
    .array(z.unknown())
    .catch([])
    .transform((entries) => entries.flatMap((entry) => {
        const parsed = DesktopPathMappingSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
    }));

function usesWindowsSeparators(path: string): boolean {
    return path.startsWith('\\\\') || /^[A-Za-z]:/.test(path) || (path.includes('\\') && !path.includes('/'));
}

function splitPathSegments(path: string): string[] {
    return path.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

/** Joins segments onto `base`, keeping the separator style `base` already uses. */
function joinOntoBase(base: string, segments: readonly string[]): string {
    const separator = usesWindowsSeparators(base) ? '\\' : '/';
    const trimmedBase = base.length > 1 ? base.replace(/[\\/]+$/, '') : base;
    if (segments.length === 0) return trimmedBase;
    const glue = trimmedBase.endsWith(separator) ? '' : separator;
    return `${trimmedBase}${glue}${segments.join(separator)}`;
}

/** The segments of `path` below `folder`, or null when `path` is not inside `folder`. */
function segmentsBelow(path: string, folder: string): string[] | null {
    const pathSegments = splitPathSegments(path);
    const folderSegments = splitPathSegments(folder);
    if (folderSegments.length > pathSegments.length) return null;
    const caseInsensitive = usesWindowsSeparators(folder);
    for (let index = 0; index < folderSegments.length; index += 1) {
        const pathSegment = caseInsensitive ? pathSegments[index].toLowerCase() : pathSegments[index];
        const folderSegment = caseInsensitive ? folderSegments[index].toLowerCase() : folderSegments[index];
        if (pathSegment !== folderSegment) return null;
    }
    return pathSegments.slice(folderSegments.length);
}

/**
 * Where a session's workspace file is on this computer: the machine's own path when the session runs
 * here, otherwise the most specific mapping that covers it. Null when this computer cannot reach it.
 */
export function resolveSessionLocalFilePath(input: Readonly<{
    workspacePath: string | null;
    homeDir: string | null;
    relativePath: string;
    sessionOnThisComputer: boolean;
    mappings: readonly DesktopPathMapping[];
}>): string | null {
    if (!input.workspacePath) return null;
    const workspacePath = resolveAbsolutePath(input.workspacePath, input.homeDir ?? undefined);
    if (workspacePath.startsWith('~')) return null;
    const fileSegments = splitPathSegments(input.relativePath);
    const machineFilePath = joinOntoBase(workspacePath, fileSegments);

    if (input.sessionOnThisComputer) return machineFilePath;

    let best: { localPath: string; depth: number; rest: string[] } | null = null;
    for (const mapping of input.mappings) {
        const rest = segmentsBelow(machineFilePath, mapping.remotePath);
        if (!rest) continue;
        const depth = splitPathSegments(mapping.remotePath).length;
        if (!best || depth > best.depth) {
            best = { localPath: mapping.localPath, depth, rest };
        }
    }
    return best ? joinOntoBase(best.localPath, best.rest) : null;
}
