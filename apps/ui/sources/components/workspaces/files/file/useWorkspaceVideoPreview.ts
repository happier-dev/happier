import * as React from 'react';
import { createSessionFilePreviewSource, type SessionFilePreviewSource } from '@/sync/domains/sessionFilePreviews/createSessionFilePreviewSource';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';

type VideoPreviewState =
    | Readonly<{ status: 'disabled' | 'loading'; uri: null; error: null }>
    | Readonly<{ status: 'loaded'; uri: string; error: null }>
    | Readonly<{ status: 'error'; uri: null; error: string }>;

function releaseSource(source: SessionFilePreviewSource): void {
    fireAndForget(Promise.resolve().then(() => source.kind === 'object-url' ? source.revoke() : source.delete()), { tag: 'workspace video preview cleanup' });
}

export function useWorkspaceVideoPreview(input: Readonly<{
    workspaceScope: WorkspaceScopeBase;
    filePath: string;
    mimeType: string;
    enabled: boolean;
    revision?: string | null;
}>) {
    const { filePath, mimeType, enabled, revision } = input;
    const { serverId, machineId, rootPath } = input.workspaceScope;
    const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
    const identity = JSON.stringify([serverId, machineId, rootPath, filePath, mimeType, revision ?? null, attempt]);
    const [resource, setResource] = React.useState<Readonly<{ identity: string; state: VideoPreviewState }> | null>(null);
    // Never expose a previous file's URI during the render before the new effect.
    const state: VideoPreviewState = !enabled ? { status: 'disabled', uri: null, error: null }
        : resource?.identity === identity ? resource.state : { status: 'loading', uri: null, error: null };

    React.useEffect(() => {
        if (!enabled) {
            setResource(null);
            return;
        }
        const controller = new AbortController();
        let source: SessionFilePreviewSource | null = null;
        setResource({ identity, state: { status: 'loading', uri: null, error: null } });
        void (async () => {
            try {
                const result = await createSessionFilePreviewSource({
                    scope: { serverId, machineId, rootPath }, filePath, mimeType,
                    maxBytes: null, signal: controller.signal,
                });
                if (controller.signal.aborted) {
                    if (result.ok) releaseSource(result.source);
                    return;
                }
                if (!result.ok) {
                    setResource({ identity, state: { status: 'error', uri: null, error: result.error || t('files.fileReadFailed') } });
                    return;
                }
                source = result.source;
                setResource({ identity, state: { status: 'loaded', uri: source.uri, error: null } });
            } catch (error) {
                if (controller.signal.aborted) return;
                setResource({ identity, state: { status: 'error', uri: null, error: error instanceof Error ? error.message : t('files.fileReadFailed') } });
            }
        })();
        return () => {
            controller.abort();
            if (source) releaseSource(source);
        };
    }, [identity, serverId, machineId, rootPath, filePath, mimeType, enabled]);

    return { state, retry };
}
