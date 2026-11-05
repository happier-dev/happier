import * as React from 'react';
import { t } from '@/text';
import { getActiveServerAccountScope, selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { subscribeAcknowledgedWorkspaceFileWrites } from '@/sync/domains/workspaces/files/workspaceFileAcknowledgements';
import { refreshWorkspaceFileDetails, type WorkspaceFileDetailsFileContent } from './refreshWorkspaceFileDetails';
import { publishSavedWorkspaceFileDetails, reconcileWorkspaceFileDetails } from './reconcileWorkspaceFileDetails';

type Input = Omit<Parameters<typeof refreshWorkspaceFileDetails>[0], 'scope' | 'signal'> & { scope: Parameters<typeof refreshWorkspaceFileDetails>[0]['scope'] | null } & Readonly<{ accountId?: string | null; isActive: boolean; refreshFingerprint: string }>;

/** Owns retained details state and publication for the currently active request. */
export function useWorkspaceFileDetailsLoading(input: Input) {
    const { scope, filePath, diffMode, fileEntryKind, filePreviousPath, fileHasIncludedDelta, isBinaryContent,
        maxImagePreviewBytes, previewSlice, readAsText, includeDiff, includeFile, snapshotSignature, isActive, refreshFingerprint } = input;
    // Explicit callers own their captured Account; only legacy unscoped callers may capture the matching active Home.
    const accountId = input.accountId === undefined
        ? selectActiveServerAccountScopeForServer(getActiveServerAccountScope(), scope?.serverId ?? null)?.accountId ?? null
        : input.accountId;
    const wantsDiff = includeDiff !== false && !previewSlice && !readAsText;
    const [fileContent, setFileContent] = React.useState<WorkspaceFileDetailsFileContent | null>(null);
    const [diffContent, setDiffContent] = React.useState<string | null>(null);
    const [isDiffLoading, setIsDiffLoading] = React.useState(wantsDiff);
    const [isLoading, setIsLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [fileWriteSupported, setFileWriteSupported] = React.useState(true);
    const [staleSince, setStaleSince] = React.useState<number | null>(null);
    const [lastOwnWriteHash, setLastOwnWriteHash] = React.useState<string | null>(null);
    const [tooLarge, setTooLarge] = React.useState<NonNullable<Awaited<ReturnType<typeof refreshWorkspaceFileDetails>>['tooLarge']> | null>(null);
    const publication = React.useRef({ fileContent, diffContent, fileWriteSupported, staleSince, lastOwnWriteHash });
    publication.current = { fileContent, diffContent, fileWriteSupported, staleSince, lastOwnWriteHash };
    const hydrated = React.useRef(false);
    const request = React.useRef<object | null>(null);
    const transferAbort = React.useRef<AbortController | null>(null);
    const reusableFile = React.useRef<{ key: string; diffMode: Input['diffMode']; includeDiff: Input['includeDiff']; value: NonNullable<Input['reuseFile']> } | null>(null);
    const resourceKey = JSON.stringify([scope?.serverId, accountId, scope?.machineId, scope?.rootPath, filePath, readAsText === true]);
    const activeResource = React.useRef(resourceKey);
    activeResource.current = resourceKey;
    const [contentResource, setContentResource] = React.useState(resourceKey);
    if (contentResource !== resourceKey) {
        setContentResource(resourceKey);
        setFileContent(null);
        setDiffContent(null);
        setError(null);
        setIsLoading(true);
        setFileWriteSupported(true);
        setStaleSince(null);
        setLastOwnWriteHash(null);
        setTooLarge(null);
        publication.current = { fileContent: null, diffContent: null, fileWriteSupported: true, staleSince: null, lastOwnWriteHash: null };
        hydrated.current = false;
        reusableFile.current = null;
        request.current = null;
    }
    const diffResourceKey = JSON.stringify([resourceKey, diffMode, previewSlice]);
    const [diffResource, setDiffResource] = React.useState(diffResourceKey);
    if (diffResource !== diffResourceKey) {
        setDiffResource(diffResourceKey);
        setDiffContent(null);
        setIsDiffLoading(wantsDiff);
        publication.current = { ...publication.current, diffContent: null };
        request.current = null;
    }
    const fileKey = JSON.stringify([resourceKey, snapshotSignature, refreshFingerprint, maxImagePreviewBytes, isBinaryContent, previewSlice]);
    const refreshAll = React.useCallback(async (options?: Readonly<{ background?: boolean; allowFileReuse?: boolean }>) => {
        if (!isActive || !scope) return;
        if (options?.allowFileReuse && includeFile === true && reusableFile.current?.key === fileKey
            && reusableFile.current.diffMode === diffMode
            && (includeDiff === false || reusableFile.current.includeDiff === includeDiff)) return;
        if (!options?.allowFileReuse) reusableFile.current = null;
        transferAbort.current?.abort();
        const abort = new AbortController();
        transferAbort.current = abort;
        const current = {};
        request.current = current;
        setIsDiffLoading(wantsDiff);
        if (!hydrated.current || (!publication.current.fileContent && !publication.current.diffContent)) setIsLoading(true);
        setError(null);
        try {
            const result = await refreshWorkspaceFileDetails({
                scope, filePath, diffMode, fileEntryKind, filePreviousPath, fileHasIncludedDelta, isBinaryContent,
                maxImagePreviewBytes, previewSlice, readAsText, includeDiff: wantsDiff, includeFile, snapshotSignature,
                signal: abort.signal,
                forceRefresh: options?.allowFileReuse !== true,
                reuseFile: options?.allowFileReuse && reusableFile.current?.key === fileKey
                    ? reusableFile.current.value : undefined,
                onDiffContent: (diff) => {
                    if (request.current !== current || !diff) return;
                    setDiffContent(diff);
                    setIsDiffLoading(false);
                    hydrated.current = true;
                    setIsLoading(false);
                },
            });
            if (request.current !== current) return;
            if (!result.error && result.fileContent) {
                reusableFile.current = { key: fileKey, diffMode, includeDiff, value: { fileContent: result.fileContent, fileWriteSupported: result.fileWriteSupported } };
            }
            if (result.error) reusableFile.current = null;
            const nextContent = result.fileContent ?? (includeFile === false && reusableFile.current?.key === fileKey
                ? reusableFile.current.value.fileContent : null);
            const next = reconcileWorkspaceFileDetails(publication.current, { ...result, fileContent: nextContent }, Date.now());
            publication.current = next;
            setFileContent(next.fileContent);
            setDiffContent(next.diffContent);
            setFileWriteSupported(next.fileWriteSupported);
            setStaleSince(next.staleSince);
            setTooLarge(result.tooLarge ?? null);
            setError(result.error);
            setIsDiffLoading(false);
            hydrated.current = true;
            setIsLoading(false);
        } catch (err) {
            if (request.current !== current) return;
            reusableFile.current = null;
            setIsDiffLoading(false);
            const message = err instanceof Error ? err.message : t('files.fileReadFailed');
            setError(message);
            const next = reconcileWorkspaceFileDetails(publication.current, { status: 'ready', error: message,
                fileContent: null, diffContent: null, fileWriteSupported: publication.current.fileWriteSupported }, Date.now());
            publication.current = next;
            setStaleSince(next.staleSince);
            setIsLoading(false);
        }
    }, [scope, filePath, diffMode, fileEntryKind, filePreviousPath, fileHasIncludedDelta, isBinaryContent, maxImagePreviewBytes, previewSlice, readAsText, includeDiff, wantsDiff, includeFile, snapshotSignature, isActive, fileKey]);
    const readFileForSave = React.useCallback(async () => {
        if (activeResource.current !== resourceKey) return null;
        // Restored drafts have a byte hash, not serialization metadata. Reuse this
        // read owner; the editor verifies the returned version before writing.
        if (!publication.current.fileContent?.encoding) await refreshAll();
        return activeResource.current === resourceKey ? publication.current.fileContent : null;
    }, [refreshAll, resourceKey]);
    React.useEffect(() => {
        void refreshAll({ allowFileReuse: true });
        return () => {
            request.current = null;
            transferAbort.current?.abort();
            transferAbort.current = null;
        };
    }, [refreshAll, refreshFingerprint]);
    React.useEffect(() => {
        if (!scope || !accountId) return;
        return subscribeAcknowledgedWorkspaceFileWrites({ ...scope, accountId }, filePath, write => {
            if (activeResource.current !== resourceKey) return;
            // Neither cached bytes nor a read begun before this acknowledgement may publish again.
            reusableFile.current = null;
            request.current = null;
            transferAbort.current?.abort();
            publication.current = { ...publication.current, lastOwnWriteHash: write.hash };
            setLastOwnWriteHash(write.hash);
            // A hidden page retains its useful display, but refreshAll performs no IO until activation.
            void refreshAll();
        });
    }, [scope, accountId, filePath, resourceKey, refreshAll]);
    const publishSavedFile = React.useCallback((value: Readonly<{ text: string; hash: string }>) => {
        if (activeResource.current !== resourceKey) return;
        // A read started before this acknowledged write no longer owns publication.
        request.current = null;
        transferAbort.current?.abort();
        reusableFile.current = null;
        const next = publishSavedWorkspaceFileDetails(publication.current, value);
        publication.current = next;
        hydrated.current = true;
        setFileContent(next.fileContent); setFileWriteSupported(true); setStaleSince(null); setError(null);
        setLastOwnWriteHash(next.lastOwnWriteHash);
        setTooLarge(null);
        setIsLoading(false); setIsDiffLoading(false);
    }, [resourceKey]);
    return { fileContent, diffContent, setDiffContent, isLoading, isDiffLoading, error, fileWriteSupported, setFileWriteSupported, staleSince, lastOwnWriteHash, tooLarge, refreshAll, readFileForSave, publishSavedFile };
}
