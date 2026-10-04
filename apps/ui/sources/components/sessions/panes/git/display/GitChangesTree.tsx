import * as React from 'react';
import type { ScrollViewProps } from 'react-native';
import type { useUnistyles } from 'react-native-unistyles';

import { WorkspaceRepositoryTreeList, type WorkspaceRepositoryTreeRowProposal, type WorkspaceRepositoryTreeRowSelection } from '@/components/projects/files/WorkspaceRepositoryTreeList';
import type { FilesystemBrowserRowActionsControl } from '@/components/ui/filesystemBrowser/FilesystemBrowserRow';
import {
    activeReviewFileKeyForSession,
    openChangedFileFromList,
    useActiveReviewFilePath,
} from '@/components/workspaces/scm/review/activeReviewFile';
import { selectScmFolderSelections } from '@/scm/scmFolderSelection';
import { narrowScmSnapshotToPaths, selectScmChangedFiles, type ScmFileStatus } from '@/scm/scmStatusFiles';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { LazyDirectoryTreeNode } from '@/hooks/ui/filesystem/lazyDirectoryTreeTypes';
import { t } from '@/text';

type AppTheme = ReturnType<typeof useUnistyles>['theme'];

export type GitChangesTreeProps = Readonly<{
    theme: AppTheme;
    sessionId: string;
    serverId?: string;
    /** The machine the working copy lives on (the tree's workspace identity). */
    machineId?: string | null;
    snapshot: ScmWorkingSnapshot;
    /** The files of the current scope (each one of `selectScmChangedFiles(snapshot)`). */
    files: readonly ScmFileStatus[];
    selectedPaths: ReadonlySet<string>;
    selectionEnabled: boolean;
    /** While a proposed commit is selected the checkboxes keep their meaning but do not write. */
    selectionReadOnly?: boolean;
    /** The selected proposed commit's exact files, as the list highlights them (lab WT4-C2). */
    proposal?: Readonly<{ paths: ReadonlySet<string>; notes: ReadonlyMap<string, string> }> | null;
    onToggleFile: (file: ScmFileStatus) => void;
    /** Every changed file beneath a folder, and whether to select (true) or clear (false) them. */
    onToggleFolder: (paths: readonly string[], select: boolean) => void;
    onOpenFile: (path: string) => void;
    onOpenFilePinned?: (path: string) => void;
    renderTrailingActions?: ((file: ScmFileStatus, control: FilesystemBrowserRowActionsControl) => React.ReactNode) | null;
    /** Drawn under the tree in the same scroll (the Unified layout's timeline). */
    listFooter?: React.ReactElement | null;
    onLayout?: ScrollViewProps['onLayout'];
    onContentSizeChange?: ScrollViewProps['onContentSizeChange'];
    onScroll?: ScrollViewProps['onScroll'];
}>;

const NO_EXPANDED_PATHS: readonly string[] = [];
const noop = () => {};

/**
 * The Git pane's changes as a folder tree (Git lab TV): the one tree primitive of the Files pane, pruned
 * to the changes of the current scope, with a checkbox for the next commit and the status letter in the
 * icon slot. A folder's box is checked when all of its changes are selected, mixed when some are; it
 * selects or clears every change beneath it. Folder counts and states come from the one folder
 * selector over the scope's snapshot, so a folder counts exactly the rows it holds.
 */
export const GitChangesTree = React.memo(function GitChangesTree(props: GitChangesTreeProps) {
    const { snapshot, files, selectedPaths, onToggleFile, onToggleFolder } = props;
    const scopedSnapshot = React.useMemo(
        () => narrowScmSnapshotToPaths(snapshot, new Set(files.map((file) => file.fullPath))),
        [files, snapshot],
    );
    const fileByPath = React.useMemo(
        () => new Map(selectScmChangedFiles(scopedSnapshot).map((file) => [file.fullPath, file])),
        [scopedSnapshot],
    );
    const folderByPath = React.useMemo(() => {
        const selected = Array.from(selectedPaths);
        return new Map(selectScmFolderSelections(scopedSnapshot, selected).map((folder) => [folder.path, folder]));
    }, [scopedSnapshot, selectedPaths]);
    const selectionRevision = React.useMemo(
        () => Array.from(folderByPath.values(), (folder) => `${folder.path}:${folder.state}`).join('|')
            + `#${Array.from(selectedPaths).sort().join('|')}`,
        [folderByPath, selectedPaths],
    );

    const latestRef = React.useRef({ fileByPath, folderByPath, selectedPaths, onToggleFile, onToggleFolder });
    latestRef.current = { fileByPath, folderByPath, selectedPaths, onToggleFile, onToggleFolder };
    const selectionEnabled = props.selectionEnabled;
    const rowSelection = React.useMemo((): WorkspaceRepositoryTreeRowSelection | null => {
        if (!selectionEnabled) return null;
        return {
            revision: selectionRevision,
            ...(props.selectionReadOnly ? { isDisabled: () => true } : {}),
            getState: (node: LazyDirectoryTreeNode) => {
                const current = latestRef.current;
                if (node.type === 'directory') return stateOf(current.folderByPath.get(node.path)?.state);
                return current.selectedPaths.has(node.path) ? 'checked' : 'unchecked';
            },
            onToggle: (node: LazyDirectoryTreeNode) => {
                const current = latestRef.current;
                if (node.type === 'directory') {
                    const folder = current.folderByPath.get(node.path);
                    if (folder) current.onToggleFolder(folder.filePaths, folder.state !== 'all');
                    return;
                }
                const file = current.fileByPath.get(node.path);
                if (file) current.onToggleFile(file);
            },
            accessibilityLabel: (node: LazyDirectoryTreeNode) => node.type === 'directory'
                ? t('sessionGitDisplay.selectFolder', { folder: node.name })
                : t('sessionGitDisplay.selectFile', { file: node.name }),
        };
    }, [selectionEnabled, selectionRevision, props.selectionReadOnly]);

    const renderTrailing = props.renderTrailingActions;
    const renderRowActions = React.useMemo(() => {
        if (!renderTrailing) return null;
        return (node: LazyDirectoryTreeNode, control: FilesystemBrowserRowActionsControl) => {
            const file = latestRef.current.fileByPath.get(node.path);
            return file ? renderTrailing(file, control) : null;
        };
    }, [renderTrailing]);

    // A row press brings the file into Review when Review is on screen; otherwise it opens the file.
    const activeReviewFileKey = activeReviewFileKeyForSession(props.sessionId, props.serverId);
    const activeReviewPath = useActiveReviewFilePath(activeReviewFileKey);
    const openFileSource = props.onOpenFile;
    const onOpenFile = React.useCallback((path: string) => {
        openChangedFileFromList(activeReviewFileKey, path, openFileSource);
    }, [activeReviewFileKey, openFileSource]);
    const revealRequest = React.useMemo(
        () => (activeReviewPath ? { path: activeReviewPath } : undefined),
        [activeReviewPath],
    );

    const proposal = props.proposal ?? null;
    const rowProposal = React.useMemo((): WorkspaceRepositoryTreeRowProposal | null => (proposal ? {
        ...proposal,
        revision: [...proposal.paths].sort().map((path) => `${path}:${proposal.notes.get(path) ?? ''}`).join('|'),
    } : null), [proposal]);

    const scope = React.useMemo(() => ({
        serverId: props.serverId ?? '',
        machineId: props.machineId ?? '',
        rootPath: snapshot.repo.rootPath ?? '',
    }), [props.machineId, props.serverId, snapshot.repo.rootPath]);

    return (
        <WorkspaceRepositoryTreeList
            theme={props.theme}
            scope={scope}
            scmSnapshot={scopedSnapshot}
            changedOnly
            directoryListing={false}
            expandedPaths={NO_EXPANDED_PATHS}
            onExpandedPathsChange={noop}
            onOpenFile={onOpenFile}
            onOpenFilePinned={props.onOpenFilePinned}
            selectedPath={activeReviewPath}
            revealRequest={revealRequest}
            rowSelection={rowSelection}
            rowProposal={rowProposal}
            renderRowActions={renderRowActions}
            listFooter={props.listFooter}
            onLayout={props.onLayout}
            onContentSizeChange={props.onContentSizeChange}
            onScroll={props.onScroll}
        />
    );
});

function stateOf(state: 'none' | 'some' | 'all' | undefined): 'checked' | 'unchecked' | 'mixed' {
    return state === 'all' ? 'checked' : state === 'some' ? 'mixed' : 'unchecked';
}
