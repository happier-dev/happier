import * as React from 'react';

import { decodeBase64 } from '@/encryption/base64';
import { isBinaryContent, resolveFileViewerKind, type FileViewerClass } from '@/scm/utils/filePresentation';
import { workspaceReadFile } from '@/sync/ops/workspaceFileSystem/fileReadWrite';
import { workspaceFileSystemTargetFromScope } from '@/sync/ops/workspaceFileSystem/workspaceTarget';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { t } from '@/text';

export type CodeTextFileState =
    | Readonly<{ kind: 'idle' }>
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'ready'; text: string; viewer: FileViewerClass }>
    | Readonly<{ kind: 'error'; error: string }>;

const IDLE: CodeTextFileState = { kind: 'idle' };

/**
 * One text file's contents for a Code folder's contained README, read through the workspace file
 * owner (`daemon.filesystem.readFile`). The read belongs to its scope + path: a change of either
 * aborts it, and a late answer for an old folder never paints the new one. The last text stays
 * while the same file is read again.
 */
export function useCodeTextFile(scope: WorkspaceScopeBase, path: string | null, reloadToken?: number | string): CodeTextFileState {
    const scopeKey = tryBuildWorkspaceCacheKey(scope) ?? '';
    const [state, setState] = React.useState<Readonly<{ key: string; value: CodeTextFileState }>>({ key: '', value: IDLE });
    const key = path ? `${scopeKey}\u0000${path}` : '';
    React.useEffect(() => {
        if (!path || !scopeKey) return;
        const controller = new AbortController();
        setState((current) => (current.key === key && current.value.kind === 'ready' ? current : { key, value: { kind: 'loading' } }));
        void workspaceReadFile(workspaceFileSystemTargetFromScope(scope), path, { signal: controller.signal }).then((result) => {
            if (controller.signal.aborted) return;
            if (!result.success) {
                setState({ key, value: { kind: 'error', error: result.error } });
                return;
            }
            const bytes = decodeBase64(result.content);
            const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            setState({
                key,
                value: { kind: 'ready', text, viewer: resolveFileViewerKind({ path, head: bytes, isBinaryContent: isBinaryContent(text) }) },
            });
        }).catch((error: unknown) => {
            if (controller.signal.aborted) return;
            setState({ key, value: { kind: 'error', error: error instanceof Error ? error.message : t('files.fileReadFailed') } });
        });
        return () => controller.abort();
        // The scope object is read through its cache key: the same workspace never refetches on identity.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, reloadToken]);
    return state.key === key ? state.value : (path ? { kind: 'loading' } : IDLE);
}
