import * as React from 'react';
import type { ComposerContentHandleV1, SessionAttachmentHandleV1 } from '@happier-dev/protocol';

import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';
import { useSessionWorkspaceTarget } from '@/hooks/session/useSessionWorkspaceTarget';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import {
    createBytesPreviewSource,
    createComposerStagedMediaPreviewSource,
    createSessionFilePreviewSource,
    createSessionAttachmentPreviewSource,
    type SessionFilePreviewSource,
} from '@/sync/domains/sessionFilePreviews/createSessionFilePreviewSource';
import { ImagePreviewCache, resolveImagePreviewCacheKey, type ImagePreviewCacheProgress, type ImagePreviewCacheValue } from './imagePreviewCache';
import { buildWorkspacePreviewIdentity } from './buildWorkspacePreviewIdentity';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

export type ResourceFilePreviewSource = Readonly<{
    kind: 'resource';
    /** Qualified resource/message/blob identity, including the owning Home and Account. */
    id: string;
    name: string;
    readBytes: (signal: AbortSignal) => Promise<Uint8Array>;
    lifetime: Pick<ServerAccountScopeLifetime, 'isCurrent' | 'onRetire'>;
}>;

export type FilePreviewSource =
    | Readonly<{ kind: 'workspace'; scope: WorkspaceScopeBase; filePath: string }>
    | Readonly<{ kind: 'session'; sessionId: string; filePath: string }>
    | Readonly<{ kind: 'attachment'; handle: SessionAttachmentHandleV1; fileName: string }>
    | Readonly<{ kind: 'composerStage'; handle: ComposerContentHandleV1 }>
    | Readonly<{ kind: 'bytes'; bytes: Uint8Array; name: string }>
    | ResourceFilePreviewSource
    | Readonly<{ kind: 'uri'; uri: string }>;

export type UseFilePreviewSourceInput = Readonly<{
    enabled: boolean;
    source: FilePreviewSource;
    cacheKey?: string | null;
    /** Owner-allocated admitted read shared by dependent wells/stage, not a mutable file's version. */
    acquisitionKey?: string;
    /** Explicit consumer retry; restarts unkeyed reads and requests fresh keyed bytes. */
    retryCount?: number;
    cacheScopeId?: string | null;
    mimeType?: string | null;
    sizeBytes?: number | null;
    maxBytes?: number | null;
    /** Observe already materialized bytes; never starts a transfer or a bytes sink. */
    cacheOnly?: boolean;
}>;
/** The bytes of a preview still on its way: "Downloading 2.1 of 8.4 MB" (lab files FV6d, FV5l). */
export type FilePreviewProgress = Readonly<{ receivedBytes: number; totalBytes: number }>;

export type FilePreviewSourceState =
    | Readonly<{ status: 'disabled'; uri: null; error: null }>
    | Readonly<{ status: 'loading'; uri: null; error: null; progress?: FilePreviewProgress }>
    | Readonly<{ status: 'loaded'; uri: string; error: null; byteLength?: number; mimeType?: string }>
    | Readonly<{ status: 'error'; uri: null; error: string; errorCode: string | null }>;

const imagePreviewCache = new ImagePreviewCache({
    maxEntries: 32,
    maxTotalBytes: 96 * 1024 * 1024,
    now: () => Date.now(),
});

/** Progress re-renders only when what it shows moves: a tenth of a megabyte or half a percent of the bar. */
function sameShownProgress(previous: FilePreviewProgress, next: FilePreviewProgress): boolean {
    if (previous.totalBytes !== next.totalBytes) return false;
    if (next.receivedBytes >= next.totalBytes) return previous.receivedBytes >= previous.totalBytes;
    const step = Math.max(100_000, next.totalBytes / 200);
    return Math.floor(previous.receivedBytes / step) === Math.floor(next.receivedBytes / step);
}

function cleanupPreviewSource(source: SessionFilePreviewSource): () => void | Promise<void> {
    return source.kind === 'object-url' ? source.revoke : source.delete;
}

function previewState(value: ImagePreviewCacheValue): FilePreviewSourceState {
    if (value.status === 'error') return { status: 'error', uri: null, error: value.error, errorCode: value.errorCode ?? null };
    return { status: 'loaded', uri: value.uri, error: null,
        ...(typeof value.byteLength === 'number' ? { byteLength: value.byteLength } : {}),
        ...(value.mimeType ? { mimeType: value.mimeType } : {}) };
}

export function useFilePreviewSource(input: UseFilePreviewSourceInput): FilePreviewSourceState {
    const source = input.source;
    const enabled = input.enabled === true;
    const cacheOnly = input.cacheOnly === true;
    const kind = source.kind;
    const sessionScope = useSessionWorkspaceTarget(enabled && source.kind === 'session' ? source.sessionId : null);
    const rawScope = source.kind === 'workspace' ? source.scope : source.kind === 'session' ? sessionScope : null;
    const scope = React.useMemo<WorkspaceScopeBase | null>(() => rawScope
        ? { serverId: rawScope.serverId, machineId: rawScope.machineId, rootPath: rawScope.rootPath } : null,
    [rawScope?.serverId, rawScope?.machineId, rawScope?.rootPath]);
    const stage = source.kind === 'composerStage' ? source.handle : null;
    const attachment = source.kind === 'attachment' ? source.handle : null;
    const bytes = source.kind === 'bytes' ? source.bytes : null;
    const directUri = source.kind === 'uri' ? source.uri : null;
    const resourceLifetime = source.kind === 'resource' ? source.lifetime : null;
    const filePath = source.kind === 'workspace' || source.kind === 'session' ? source.filePath
        : source.kind === 'attachment' ? source.fileName
        : source.kind === 'composerStage' ? source.handle.name
        : source.kind === 'bytes' || source.kind === 'resource' ? source.name : source.uri;
    const sizeBytes = stage?.sizeBytes ?? bytes?.byteLength ?? input.sizeBytes ?? null;
    const viewer = resolveFileViewerKind({ path: filePath, mimeType: stage?.mimeType ?? input.mimeType });
    const mimeType = viewer.mimeType;
    const cacheMaxEntries = useSetting('filesImagePreviewCacheMaxEntries');
    const cacheMaxTotalBytes = useSetting('filesImagePreviewCacheMaxTotalBytes');
    const previewLimit = useSetting('filesImagePreviewMaxBytes');
    const maxBytes = input.maxBytes !== undefined ? input.maxBytes : viewer.kind === 'video' ? null : previewLimit;
    const normalizedMaxBytes = maxBytes === null ? null : typeof maxBytes === 'number' && Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : 0;
    const retryCount = input.retryCount ?? 0;
    const cacheScopeId = !enabled ? '' : input.cacheScopeId?.trim() || (attachment
        ? JSON.stringify(['session-attachment', attachment.sessionId, attachment.id])
        : stage ? JSON.stringify(['composer-stage', stage.executionTarget.serverId, stage.executionTarget.machineId, stage.owner.pluginId, stage.owner.localId, stage.id])
        : scope ? buildWorkspacePreviewIdentity(scope, filePath, sizeBytes, null).cacheScopeId
        : source.kind === 'session' ? source.sessionId : source.kind === 'resource' ? source.id : source.kind === 'bytes' ? 'bytes' : '');
    const cacheKey = enabled ? resolveImagePreviewCacheKey({ cacheScopeId, filePath,
        cacheKey: input.cacheKey ?? stage?.sha256, acquisitionKey: input.acquisitionKey, retryCount })?.signature ?? null : null;
    const stageIdentity = enabled && stage ? JSON.stringify(stage) : null;
    const attachmentIdentity = enabled && attachment ? JSON.stringify(attachment) : null;
    // Disabled previews have no acquisition identity. A Review text row may carry a repository-sized
    // revision; only a consumer of preview bytes needs to prepare or serialize it.
    const identity = enabled ? JSON.stringify([kind, cacheScopeId, cacheKey, retryCount, filePath, mimeType, sizeBytes, normalizedMaxBytes, stageIdentity, attachmentIdentity]) : '';
    const [resource, setResource] = React.useState<Readonly<{ identity: string; bytes: Uint8Array | null; state: FilePreviewSourceState }> | null>(null);
    const [progress, setProgress] = React.useState<Readonly<{ identity: string; value: FilePreviewProgress }> | null>(null);
    const sourceRef = React.useRef(source);
    sourceRef.current = source;

    React.useEffect(() => {
        imagePreviewCache.setLimits({
            maxEntries: typeof cacheMaxEntries === 'number' && Number.isFinite(cacheMaxEntries) ? Math.max(0, cacheMaxEntries) : 0,
            maxTotalBytes: typeof cacheMaxTotalBytes === 'number' && Number.isFinite(cacheMaxTotalBytes) ? Math.max(0, cacheMaxTotalBytes) : 0,
        });
    }, [cacheMaxEntries, cacheMaxTotalBytes]);

    React.useEffect(() => {
        if (!enabled || kind === 'uri' || ((kind === 'workspace' || kind === 'session') && !scope)) {
            setResource(null);
            return;
        }
        let active = true;
        let retired = resourceLifetime?.isCurrent() === false;
        const controller = new AbortController();
        const key = cacheKey ? { sessionId: cacheScopeId, signature: cacheKey, filePath } : null;
        let uncached: ImagePreviewCacheValue | null = null;
        const publish = (value: ImagePreviewCacheValue) => {
            if (active && !retired && resourceLifetime?.isCurrent() !== false) setResource({ identity, bytes, state: previewState(value) });
        };
        const retirement = resourceLifetime?.onRetire(() => {
            retired = true;
            controller.abort();
            imagePreviewCache.invalidateSession(cacheScopeId);
            if (active) { setResource(null); setProgress(null); }
        });
        if (retired) {
            imagePreviewCache.invalidateSession(cacheScopeId);
            setResource(null);
            return () => { active = false; retirement?.dispose(); };
        }
        if (cacheOnly) {
            if (!key) { setResource(null); retirement?.dispose(); return; }
            imagePreviewCache.retain(key);
            const stop = imagePreviewCache.observeValue(key, value => {
                if (value) publish(value);
                else if (active) setResource(null);
            });
            return () => { active = false; retirement?.dispose(); stop(); imagePreviewCache.release(key); };
        }
        const report = (value: ImagePreviewCacheProgress) => {
            if (!active) return;
            setProgress(previous => previous?.identity === identity && sameShownProgress(previous.value, value)
                ? previous : { identity, value });
        };
        const load = async (signal: AbortSignal, onProgress: (value: ImagePreviewCacheProgress) => void): Promise<ImagePreviewCacheValue> => {
            const current = sourceRef.current;
            try {
                const result = current.kind === 'resource'
                    ? await createBytesPreviewSource({ bytes: await current.readBytes(signal), fileName: filePath, mimeType, maxBytes: normalizedMaxBytes, signal })
                    : current.kind === 'composerStage'
                    ? await createComposerStagedMediaPreviewSource({ handle: current.handle, maxBytes: normalizedMaxBytes, signal })
                    : current.kind === 'attachment'
                    ? await createSessionAttachmentPreviewSource({ handle: current.handle, fileName: filePath, mimeType, maxBytes: normalizedMaxBytes, expectedSizeBytes: sizeBytes, signal, onProgress })
                    : current.kind === 'bytes'
                    ? await createBytesPreviewSource({ bytes: current.bytes, fileName: filePath, mimeType, maxBytes: normalizedMaxBytes, signal })
                    : await createSessionFilePreviewSource({ scope: scope!, filePath, mimeType, maxBytes: normalizedMaxBytes, expectedSizeBytes: sizeBytes, signal, onProgress });
                if (!result.ok) return { status: 'error', error: result.errorCode === 'too_large' ? t('files.imagePreviewTooLarge') : result.error || t('files.fileReadFailed'),
                    ...(result.errorCode ? { errorCode: result.errorCode } : {}) };
                return { status: 'loaded', uri: result.source.uri, byteLength: result.source.byteLength, mimeType: result.source.mimeType, cleanup: cleanupPreviewSource(result.source) };
            } catch (error) {
                return { status: 'error', error: error instanceof Error ? error.message : t('files.fileReadFailed'),
                    ...(error instanceof Error && 'code' in error && typeof error.code === 'string' ? { errorCode: error.code } : {}) };
            }
        };
        if (key) imagePreviewCache.retain(key);
        const stopObserving = key ? imagePreviewCache.observeProgress(key, report) : null;
        const tooLarge = viewer.previewable && normalizedMaxBytes !== null && sizeBytes !== null && sizeBytes > normalizedMaxBytes;
        const pending = tooLarge ? Promise.resolve<ImagePreviewCacheValue>({ status: 'error', error: t('files.imagePreviewTooLarge'), errorCode: 'too_large' }) : key ? imagePreviewCache.load(key, load, resourceLifetime ?? undefined) : load(controller.signal, report).then(value => {
            uncached = value;
            if (!active && value.status === 'loaded') void Promise.resolve(value.cleanup?.()).catch(() => undefined);
            return value;
        });
        void pending.then(publish);
        return () => {
            active = false;
            retirement?.dispose();
            stopObserving?.();
            controller.abort();
            if (key) imagePreviewCache.release(key);
            else if (uncached?.status === 'loaded') void Promise.resolve(uncached.cleanup?.()).catch(() => undefined);
        };
    }, [enabled, cacheOnly, identity, kind, cacheScopeId, cacheKey, filePath, mimeType, sizeBytes, normalizedMaxBytes, scope, bytes, viewer.previewable, resourceLifetime]);

    if (!enabled) return { status: 'disabled', uri: null, error: null };
    if (resourceLifetime?.isCurrent() === false) return { status: 'error', uri: null, error: t('files.fileReadFailed'), errorCode: 'resource_unavailable' };
    if (directUri !== null) return { status: 'loaded', uri: directUri, error: null };
    if (resource?.identity === identity && resource.bytes === bytes) return resource.state;
    if (cacheOnly) return { status: 'disabled', uri: null, error: null };
    return progress?.identity === identity
        ? { status: 'loading', uri: null, error: null, progress: progress.value }
        : { status: 'loading', uri: null, error: null };
}

