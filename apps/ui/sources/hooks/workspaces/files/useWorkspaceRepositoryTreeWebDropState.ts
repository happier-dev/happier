import * as React from 'react';

import { REPOSITORY_TREE_AUTO_EXPAND_DELAY_MS } from '@/components/workspaces/files/repositoryTree/repositoryTreeDragAndDropConfig';
import type { WorkspaceRepositoryTreeWebDropTarget } from '@/components/projects/files/WorkspaceRepositoryTreeList';

function appendExpandedPath(expandedPaths: readonly string[], path: string): string[] {
    if (!path) return [...expandedPaths];
    if (expandedPaths.includes(path)) return [...expandedPaths];
    return [...expandedPaths, path];
}

export function useWorkspaceRepositoryTreeWebDropState(params: Readonly<{
    enabled: boolean;
    expandedPaths: readonly string[];
    onExpandedPathsChange: (paths: string[]) => void;
}>) {
    const { enabled, expandedPaths, onExpandedPathsChange } = params;
    const [fileDragActive, setFileDragActive] = React.useState(false);
    const [dropTarget, setDropTarget] = React.useState<WorkspaceRepositoryTreeWebDropTarget>({
        destinationDir: '',
        hoverPath: null,
        autoExpandDirectoryPath: null,
    });
    const expandedPathsRef = React.useRef(expandedPaths);
    const autoExpandTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const autoExpandPathRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        expandedPathsRef.current = expandedPaths;
    }, [expandedPaths]);

    const clearAutoExpandTimer = React.useCallback(() => {
        if (autoExpandTimerRef.current) {
            clearTimeout(autoExpandTimerRef.current);
            autoExpandTimerRef.current = null;
        }
        autoExpandPathRef.current = null;
    }, []);

    const resetDropTarget = React.useCallback(() => {
        clearAutoExpandTimer();
        setDropTarget({
            destinationDir: '',
            hoverPath: null,
            autoExpandDirectoryPath: null,
        });
    }, [clearAutoExpandTimer]);

    React.useEffect(() => {
        if (enabled) return;
        setFileDragActive(false);
        resetDropTarget();
    }, [enabled, resetDropTarget]);

    React.useEffect(() => clearAutoExpandTimer, [clearAutoExpandTimer]);

    const scheduleAutoExpand = React.useCallback((directoryPath: string | null) => {
        if (!enabled) {
            clearAutoExpandTimer();
            return;
        }
        if (!directoryPath || expandedPathsRef.current.includes(directoryPath)) {
            clearAutoExpandTimer();
            return;
        }
        if (autoExpandPathRef.current === directoryPath && autoExpandTimerRef.current) {
            return;
        }
        clearAutoExpandTimer();
        autoExpandPathRef.current = directoryPath;
        autoExpandTimerRef.current = setTimeout(() => {
            onExpandedPathsChange(appendExpandedPath(expandedPathsRef.current, directoryPath));
            autoExpandTimerRef.current = null;
            autoExpandPathRef.current = null;
        }, REPOSITORY_TREE_AUTO_EXPAND_DELAY_MS);
    }, [clearAutoExpandTimer, enabled, onExpandedPathsChange]);

    const onDropTargetChange = React.useCallback((target: WorkspaceRepositoryTreeWebDropTarget) => {
        if (!enabled) return;
        setDropTarget(target);
        scheduleAutoExpand(target.autoExpandDirectoryPath ?? null);
    }, [enabled, scheduleAutoExpand]);

    const onFileDragActiveChange = React.useCallback((active: boolean) => {
        if (!enabled) {
            setFileDragActive(false);
            resetDropTarget();
            return;
        }
        setFileDragActive(active);
        if (!active) {
            resetDropTarget();
        }
    }, [enabled, resetDropTarget]);

    const setRootDropTarget = React.useCallback(() => {
        if (!enabled) return;
        onDropTargetChange({
            destinationDir: '',
            hoverPath: null,
            autoExpandDirectoryPath: null,
        });
    }, [enabled, onDropTargetChange]);

    return React.useMemo(() => ({
        fileDragActive,
        dropDestinationDir: dropTarget.destinationDir,
        dropHoverPath: dropTarget.hoverPath,
        onDropTargetChange,
        onFileDragActiveChange,
        setRootDropTarget,
    }), [
        dropTarget.destinationDir,
        dropTarget.hoverPath,
        fileDragActive,
        onDropTargetChange,
        onFileDragActiveChange,
        setRootDropTarget,
    ]);
}
