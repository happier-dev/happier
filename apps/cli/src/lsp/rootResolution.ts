import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';
import { posix, win32 } from 'node:path';

import type { WorkspacePathContext } from './workspaceUris';
import { resolveWorkspacePath } from './workspaceUris';

export async function resolveLanguageServerRoot(input: WorkspacePathContext & Readonly<{ path: string; rootMarkers?: readonly string[] }>): Promise<string> {
    const api = (input.platform ?? process.platform) === 'win32' ? win32 : posix;
    const filePath = resolveWorkspacePath(input, input.path);
    const rootPath = resolveWorkspacePath(input, '.');
    if (!input.rootMarkers?.length) return rootPath;
    const relativeDirectory = api.relative(rootPath, api.dirname(filePath));
    const segments = relativeDirectory ? relativeDirectory.split(api.sep) : [];
    // Walk from the workspace down, so a monorepo's topmost marker owns the
    // session rather than spawning one server for every nested package.
    for (let depth = 0; depth <= segments.length; depth++) {
        const directory = api.join(rootPath, ...segments.slice(0, depth));
        for (const marker of input.rootMarkers) {
            const markerPath = resolveWorkspacePath(input, api.join(...segments.slice(0, depth), marker));
            try {
                await currentWorkspaceSource().stat(markerPath);
                return directory;
            } catch (error) {
                if (error !== null && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue;
                throw error;
            }
        }
    }
    return rootPath;
}
