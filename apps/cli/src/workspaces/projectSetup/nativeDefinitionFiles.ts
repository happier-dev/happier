import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { ProjectNativeFilePathV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

export type ProjectDefinitionFileRead =
    | { kind: 'read'; content: string }
    | { kind: 'absent' }
    | { kind: 'refused'; code: 'outside_root' | 'unreadable_definition' };

export type ProjectDefinitionFileBytesRead =
    | { kind: 'read'; bytes: Buffer }
    | Exclude<ProjectDefinitionFileRead, { kind: 'read' }>;

function contained(root: string, path: string): boolean {
    const pathFromRoot = relative(root, path);
    return pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

/** Readonly native-file boundary shared by builtins and admitted passive plugin detection. */
export async function readProjectDefinitionFile(root: string, file: string): Promise<ProjectDefinitionFileRead> {
    const result = await readProjectDefinitionFileBytes(root, file);
    return result.kind === 'read' ? { kind: 'read', content: result.bytes.toString('utf8') } : result;
}

/** Explicit setup inputs retain their raw bytes through the same contained file owner. */
export async function readProjectDefinitionFileBytes(root: string, file: string): Promise<ProjectDefinitionFileBytesRead> {
    if (!ProjectNativeFilePathV1Schema.safeParse(file).success || isAbsolute(file) || win32.isAbsolute(file)) return { kind: 'refused', code: 'outside_root' };
    const path = resolve(root, file.replaceAll('\\', '/'));
    if (!contained(resolve(root), path)) return { kind: 'refused', code: 'outside_root' };
    try {
        const [actualRoot, actualPath] = await Promise.all([realpath(root), realpath(path)]);
        if (!contained(actualRoot, actualPath)) return { kind: 'refused', code: 'outside_root' };
        return { kind: 'read', bytes: await readFile(actualPath) };
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { kind: 'absent' };
        return { kind: 'refused', code: 'unreadable_definition' };
    }
}
