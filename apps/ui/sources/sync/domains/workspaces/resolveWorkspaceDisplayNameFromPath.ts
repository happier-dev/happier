import { resolveWorkspacePathBasenameV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

export function resolveWorkspaceDisplayNameFromPath(path: string): string {
    return resolveWorkspacePathBasenameV1(String(path)) ?? 'workspace';
}
