import * as React from 'react';

import { storage } from '@/sync/domains/state/storage';
import { REPOSITORY_TREE_AUTO_EXPAND_DELAY_MS } from '@/components/sessions/files/repositoryTree/repositoryTreeDragAndDropConfig';
import type { RepositoryTreeWebDropTarget } from '@/components/sessions/files/content/RepositoryTreeList';

function appendExpandedPath(expandedPaths: readonly string[], path: string): string[] {
    if (!path) return [...expandedPaths];
    if (expandedPaths.includes(path)) return [...expandedPaths];
    return [...expandedPaths, path];
}

export function useRepositoryTreeWebDropState(params: Readonly<{
    sessionId: string;
    enabled: boolean;
    expandedPaths: readonly string[];
}>) {
    const [fileDragActive, setFileDragActive] = React.useState(false);
    const [dropTarget, setDropTarget] = React.useState<RepositoryTreeWebDropTarget>({
        destinationDir: '',
        hoverPath: null,
        autoExpandDirectoryPath: null,
    });
    const expandedPathsRef = React.useRef(params.expandedPaths);
    const autoExpandTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const autoExpandPathRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        expandedPathsRef.current = params.expandedPaths;
    }, [params.expandedPaths]);

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
        if (params.enabled) return;
        setFileDragActive(false);
        resetDropTarget();
    }, [params.enabled, resetDropTarget]);

    React.useEffect(() => clearAutoExpandTimer, [clearAutoExpandTimer]);

    const scheduleAutoExpand = React.useCallback((directoryPath: string | null) => {
        if (!params.enabled) {
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
            storage.getState().setSessionRepositoryTreeExpandedPaths(
                params.sessionId,
                appendExpandedPath(expandedPathsRef.current, directoryPath),
            );
            autoExpandTimerRef.current = null;
            autoExpandPathRef.current = null;
        }, REPOSITORY_TREE_AUTO_EXPAND_DELAY_MS);
    }, [clearAutoExpandTimer, params.enabled, params.sessionId]);

    const onDropTargetChange = React.useCallback((target: RepositoryTreeWebDropTarget) => {
        if (!params.enabled) return;
        setDropTarget(target);
        scheduleAutoExpand(target.autoExpandDirectoryPath ?? null);
    }, [params.enabled, scheduleAutoExpand]);

    const onFileDragActiveChange = React.useCallback((active: boolean) => {
        if (!params.enabled) {
            setFileDragActive(false);
            resetDropTarget();
            return;
        }
        setFileDragActive(active);
        if (!active) {
            resetDropTarget();
        }
    }, [params.enabled, resetDropTarget]);

    const setRootDropTarget = React.useCallback(() => {
        if (!params.enabled) return;
        onDropTargetChange({
            destinationDir: '',
            hoverPath: null,
            autoExpandDirectoryPath: null,
        });
    }, [onDropTargetChange, params.enabled]);

    return {
        fileDragActive,
        dropDestinationDir: dropTarget.destinationDir,
        dropHoverPath: dropTarget.hoverPath,
        onDropTargetChange,
        onFileDragActiveChange,
        setRootDropTarget,
    };
}
