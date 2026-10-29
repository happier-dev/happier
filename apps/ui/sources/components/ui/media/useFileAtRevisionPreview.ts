import * as React from 'react';
import { Platform } from 'react-native';
import type { ScmFileAtRevisionRequest, ScmOperationErrorCode } from '@happier-dev/protocol/scm';
import { fetchWorkspaceFileAtRevision, type WorkspaceFileAtRevisionResult } from '@/scm/files/fetchWorkspaceFileAtRevision';
import { useSetting } from '@/sync/domains/state/storage';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveWebFileBufferMaxBytes } from '@/sync/runtime/files/webFileBufferBudget';
import { useFilePreviewSource, type UseFilePreviewSourceInput } from './useFilePreviewSource';
import { buildWorkspacePreviewIdentity } from './buildWorkspacePreviewIdentity';

/** Before and after images share the preview setting, URI/cache owner and cleanup. */
export function useFileAtRevisionPreview(input: Readonly<{
    enabled: boolean;
    scope: WorkspaceScopeBase;
    path: string;
    selector: ScmFileAtRevisionRequest['selector'];
    mimeType?: string | null;
    /** Current comparison/status signature for callers sharing a live-before read. */
    signature?: string | null;
    /** A retry after a failed read: each new value reads the revision again. */
    attempt?: number;
}>) {
    const previewBudget = useSetting('filesImagePreviewMaxBytes');
    const maxBytes = Platform.OS === 'web' ? Math.min(previewBudget, resolveWebFileBufferMaxBytes()) : previewBudget;
    // A read that threw (the RPC or its transfer did not finish) has no SCM verdict about the revision.
    const [settled, setSettled] = React.useState<Readonly<{ key: string;
        result: WorkspaceFileAtRevisionResult | Readonly<{ success: false; errorCode: null; error: string }> }> | null>(null);
    const blobId = 'blobId' in input.selector ? input.selector.blobId : undefined;
    const area = 'area' in input.selector ? input.selector.area : undefined;
    const { serverId, machineId, rootPath } = input.scope;
    const requestKey = input.enabled
        ? JSON.stringify([serverId, machineId, rootPath, input.path, blobId, area, maxBytes, input.signature, input.attempt ?? 0]) : '';
    const read = settled?.key === requestKey ? settled.result : null;
    React.useEffect(() => {
        if (!input.enabled) return;
        const abort = new AbortController();
        void fetchWorkspaceFileAtRevision({ scope: { serverId, machineId, rootPath }, path: input.path,
            selector: blobId ? { blobId } : { side: 'before', area: area! }, maxBytes, signal: abort.signal,
        }).then(result => {
            if (!abort.signal.aborted) setSettled({ key: requestKey, result });
        }, error => {
            if (!abort.signal.aborted) setSettled({ key: requestKey, result: { success: false, errorCode: null,
                error: error instanceof Error ? error.message : 'The file revision is unavailable.' } });
        });
        return () => abort.abort();
    }, [input.enabled, serverId, machineId, rootPath, input.path, blobId, area, maxBytes, requestKey]);

    const previewInput = React.useMemo<UseFilePreviewSourceInput>(() => ({
        enabled: input.enabled && read?.success === true,
        source: { kind: 'bytes', bytes: read?.success ? read.bytes : new Uint8Array(), name: input.path },
        ...buildWorkspacePreviewIdentity(input.scope, input.path, read?.success ? read.sizeBytes : null,
            read?.success ? `revision:${read.sha256}` : null),
        mimeType: input.mimeType,
        sizeBytes: read?.success ? read.sizeBytes : null,
        maxBytes,
    }), [input.enabled, read, input.path, input.mimeType, serverId, machineId, rootPath, maxBytes]);
    const preview = useFilePreviewSource(previewInput);
    const errorCode: ScmOperationErrorCode | null = read && !read.success ? read.errorCode : null;
    if (!input.enabled) return { status: 'disabled' as const, uri: null, error: null, errorCode: null, previewInput };
    if (read && !read.success) return { status: 'error' as const, uri: null,
        error: read.error ?? read.errorCode ?? 'blob_unavailable', errorCode, previewInput };
    if (!read) return { status: 'loading' as const, uri: null, error: null, errorCode: null, previewInput };
    return { ...preview, errorCode: preview.status === 'error' ? preview.errorCode : errorCode,
        previewInput, sizeBytes: read.sizeBytes, sha256: read.sha256 };
}
