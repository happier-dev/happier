import * as React from 'react';

import { getStorage } from '@/sync/domains/state/storageStore';
import { allowMarkdownRemoteImages, importMarkdownImageConsent, markdownImageConsentState } from '@/sync/domains/state/markdownImageConsentUiState';
import { usePersistentUiStateValue } from '@/sync/domains/state/persistentUiState';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolvePathRelativeToRoot } from '@/utils/path/resolvePathRelativeToRoot';
import { resolveWorkspaceFileReference, resolveWorkspaceMarkdownImage } from '@/utils/workspaceFileReferences/resolveWorkspaceFileReference';
import type { MarkdownImageResolver } from './markdownImages';

type WorkspaceMarkdownImages = Readonly<{
    images: MarkdownImageResolver;
    imageScope: WorkspaceScopeBase;
}>;

/** The File page and README share this explicit document context and device-local consent owner. */
export function useWorkspaceMarkdownImages(input: Readonly<{ scope: WorkspaceScopeBase; filePath: string }>): WorkspaceMarkdownImages;
export function useWorkspaceMarkdownImages(input: Readonly<{ scope?: WorkspaceScopeBase | null; filePath: string }>): Partial<WorkspaceMarkdownImages>;
export function useWorkspaceMarkdownImages(input: Readonly<{ scope?: WorkspaceScopeBase | null; filePath: string }>): Partial<WorkspaceMarkdownImages> {
    const { serverId, machineId, rootPath = '' } = input.scope ?? {};
    const imageScope = React.useMemo(() => serverId && machineId && rootPath ? { serverId, machineId, rootPath } : null, [serverId, machineId, rootPath]);
    const workspaceCacheKey = React.useMemo(() => imageScope ? tryBuildWorkspaceCacheKey(imageScope) : null, [imageScope]);
    const filePath = React.useMemo(() => rootPath ? resolveWorkspaceFileReference({ url: input.filePath, workspacePath: rootPath })?.filePath ?? null : null,
        [input.filePath, rootPath]);
    const identityPath = React.useMemo(() => filePath
        ? resolvePathRelativeToRoot({ path: `${rootPath.replace(/[\\/]+$/, '')}/${filePath}`, root: rootPath })
        : null, [filePath, rootPath]);
    const consentKey = React.useMemo(() => workspaceCacheKey && identityPath
        ? importMarkdownImageConsent(workspaceCacheKey, identityPath, () => getStorage().getState().localSettings.remoteImageConsentV1)
        : null, [workspaceCacheKey, identityPath]);
    const remoteLoaded = usePersistentUiStateValue(markdownImageConsentState, consentKey) === true;
    const onLoadRemote = React.useCallback(() => {
        if (consentKey) allowMarkdownRemoteImages(consentKey);
    }, [consentKey]);
    const resolve = React.useCallback<MarkdownImageResolver['resolve']>(destination => filePath
        ? resolveWorkspaceMarkdownImage({ destination, workspacePath: rootPath, sourceFilePath: filePath })
        : { kind: 'blocked' }, [filePath, rootPath]);
    const images = React.useMemo(() => ({ resolve, remoteLoaded, onLoadRemote }), [resolve, remoteLoaded, onLoadRemote]);
    return React.useMemo(() => imageScope ? { images, imageScope } : {}, [images, imageScope]);
}
