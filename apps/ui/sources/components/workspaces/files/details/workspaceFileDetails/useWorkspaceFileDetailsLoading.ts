import * as React from 'react';
import { t } from '@/text';
import { refreshWorkspaceFileDetails, type WorkspaceFileDetailsFileContent } from './refreshWorkspaceFileDetails';

type Input = Omit<Parameters<typeof refreshWorkspaceFileDetails>[0], 'scope' | 'signal'> & { scope: Parameters<typeof refreshWorkspaceFileDetails>[0]['scope'] | null } & Readonly<{ isActive: boolean; refreshFingerprint: string }>;

function sameContent(a: WorkspaceFileDetailsFileContent | null, b: WorkspaceFileDetailsFileContent | null): boolean {
    return a === b || Boolean(a && b && a.content === b.content && a.isBinary === b.isBinary
        && a.contentHash === b.contentHash && a.binaryBase64 === b.binaryBase64
        && a.binaryMime === b.binaryMime && a.binarySizeBytes === b.binarySizeBytes
        && a.binaryPreviewRevision === b.binaryPreviewRevision);
}

/** Owns retained details state and publication for the currently active request. */
export function useWorkspaceFileDetailsLoading(input: Input) {
    const { scope, filePath, diffMode, fileEntryKind, fileHasIncludedDelta,
        maxImagePreviewBytes, includeDiff, includeFile, snapshotSignature, isActive, refreshFingerprint } = input;
    const [fileContent, setFileContent] = React.useState<WorkspaceFileDetailsFileContent | null>(null);
    const [diffContent, setDiffContent] = React.useState<string | null>(null);
    const [isDiffLoading, setIsDiffLoading] = React.useState(includeDiff !== false);
    const [isLoading, setIsLoading] = React.useState(true);
    const [error, setError] = React.useState<string | null>(null);
    const [fileWriteSupported, setFileWriteSupported] = React.useState(true);
    const hydrated = React.useRef(false);
    const request = React.useRef<object | null>(null);
    const transferAbort = React.useRef<AbortController | null>(null);
    const reusableFile = React.useRef<{ key: string; diffMode: Input['diffMode']; includeDiff: Input['includeDiff']; value: NonNullable<Input['reuseFile']> } | null>(null);
    const resourceKey = JSON.stringify([scope?.serverId, scope?.machineId, scope?.rootPath, filePath]);
    const [contentResource, setContentResource] = React.useState(resourceKey);
    if (contentResource !== resourceKey) {
        setContentResource(resourceKey);
        setFileContent(null);
        setDiffContent(null);
        setError(null);
        setIsLoading(true);
        setFileWriteSupported(true);
        hydrated.current = false;
        reusableFile.current = null;
        request.current = null;
    }
    const diffResourceKey = JSON.stringify([resourceKey, diffMode]);
    const [diffResource, setDiffResource] = React.useState(diffResourceKey);
    if (diffResource !== diffResourceKey) {
        setDiffResource(diffResourceKey);
        setDiffContent(null);
        setIsDiffLoading(includeDiff !== false);
        request.current = null;
    }
    const fileKey = JSON.stringify([scope?.serverId, scope?.machineId, scope?.rootPath, filePath, snapshotSignature, refreshFingerprint, maxImagePreviewBytes]);
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
        setIsDiffLoading(includeDiff !== false);
        if (!hydrated.current) setIsLoading(true);
        setError(null);
        try {
            const result = await refreshWorkspaceFileDetails({
                scope, filePath, diffMode, fileEntryKind, fileHasIncludedDelta,
                maxImagePreviewBytes, includeDiff, includeFile, snapshotSignature,
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
            setDiffContent(previous => result.error && !result.diffContent ? previous : result.diffContent);
            const nextContent = result.fileContent ?? (includeFile === false && reusableFile.current?.key === fileKey
                ? reusableFile.current.value.fileContent : null);
            setFileContent(previous => {
                if (result.error && !nextContent) return previous;
                return sameContent(previous, nextContent) ? previous : nextContent;
            });
            setFileWriteSupported(result.fileWriteSupported);
            setError(result.error);
            setIsDiffLoading(false);
            hydrated.current = true;
            setIsLoading(false);
        } catch (err) {
            if (request.current !== current) return;
            reusableFile.current = null;
            setIsDiffLoading(false);
            setError(err instanceof Error ? err.message : t('files.fileReadFailed'));
            setIsLoading(false);
        }
    }, [scope, filePath, diffMode, fileEntryKind, fileHasIncludedDelta, maxImagePreviewBytes, includeDiff, includeFile, snapshotSignature, isActive, fileKey]);
    React.useEffect(() => {
        void refreshAll({ allowFileReuse: true });
        return () => {
            request.current = null;
            transferAbort.current?.abort();
            transferAbort.current = null;
        };
    }, [refreshAll, refreshFingerprint]);
    return { fileContent, diffContent, setDiffContent, isLoading, isDiffLoading, error, fileWriteSupported, setFileWriteSupported, refreshAll };
}
