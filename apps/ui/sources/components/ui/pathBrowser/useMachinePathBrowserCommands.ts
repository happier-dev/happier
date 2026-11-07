import * as React from 'react';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';
import { useCurrentUiContextLocalCommands, type CurrentUiContextLocalCommand } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import type { FilesystemBrowserNode } from '@/components/ui/filesystemBrowser/filesystemBrowserTypes';
import { isFilesystemErrorRetryable } from '@/components/ui/filesystemBrowser/filesystemErrorReason';
import { t } from '@/text';

type BrowserCommandKey = 'activate' | 'disclosure' | 'search' | 'clearSearch' | 'hidden' | 'refresh' | 'collapseAll'
    | 'confirm' | 'close' | 'createFolder' | 'contextMenu' | 'closeContextMenu' | 'contextCreateFolder'
    | 'retryRoot' | 'retryDirectory' | 'retrySearch';

/** The row and contextual command share the browser's existing selection and mutation owners. */
export function useMachinePathBrowserCommands(props: Readonly<{
    scope?: string;
    nodes: readonly FilesystemBrowserNode[];
    selectedPath: string | null;
    searchQuery: string;
    showHidden: boolean;
    selectionMode: 'file' | 'directory';
    interaction: 'confirm' | 'immediate';
    modal: boolean;
    canConfirm: boolean;
    canCreateFolder: boolean;
    canClearSearch: boolean;
    canCollapse: boolean;
    contextMenuDirectoryPath: string | null;
    rootError: string | null;
    searchError: boolean;
    onSelectPath(path: string): void;
    onPickPathImmediately(path: string): void;
    onToggleDirectory(path: string, context?: ActionExecutorContext): void;
    onOpenContextMenu(path: string): void;
    onCloseContextMenu(): void;
    onSearch(value: string, context?: ActionExecutorContext): void;
    onToggleHidden(context?: ActionExecutorContext): void;
    onRefresh(context?: ActionExecutorContext): void;
    onCollapseAll(): void;
    onConfirm(): void;
    onClose?: () => void;
    onCreateFolder(context?: ActionExecutorContext): void;
    onContextCreateFolder(context?: ActionExecutorContext): void;
    onRetryRoot(context?: ActionExecutorContext): void | Promise<void>;
    onRetryDirectory(path: string, context?: ActionExecutorContext): void | Promise<void>;
    onRetrySearch(context?: ActionExecutorContext): void | Promise<void>;
}>) {
    const readString = (input: PluginUiJsonValueV1 | undefined, key: string) => input !== null && typeof input === 'object'
        && !Array.isArray(input) && typeof input[key] === 'string' ? input[key] : null;
    const apply = (key: BrowserCommandKey, input?: PluginUiJsonValueV1, context?: ActionExecutorContext) => {
        const path = readString(input, 'path');
        const node = path === null ? undefined : props.nodes.find(candidate => candidate.path === path);
        switch (key) {
            case 'activate':
                if (!node || node.type !== 'file' && node.type !== 'directory') return false;
                if (node.type === 'directory' && props.selectionMode === 'file') props.onToggleDirectory(node.path, context);
                else if (node.type === props.selectionMode) {
                    if (props.interaction === 'immediate') props.onPickPathImmediately(node.path);
                    else props.onSelectPath(node.path);
                } else return false;
                return true;
            case 'disclosure':
                if (node?.type !== 'directory') return false;
                props.onToggleDirectory(node.path, context); return true;
            case 'search': {
                const value = readString(input, 'value');
                if (value === null) return false;
                props.onSearch(value, context); return true;
            }
            case 'clearSearch': if (!props.canClearSearch) return false; props.onSearch('', context); return true;
            case 'hidden': props.onToggleHidden(context); return true;
            case 'refresh': props.onRefresh(context); return true;
            case 'collapseAll': if (!props.canCollapse) return false; props.onCollapseAll(); return true;
            case 'confirm': if (!props.canConfirm) return false; props.onConfirm(); return true;
            case 'close': if (!props.onClose) return false; props.onClose(); return true;
            case 'createFolder': if (!props.canCreateFolder) return false; props.onCreateFolder(context); return true;
            case 'contextMenu':
                if (!props.modal || node?.type !== 'directory') return false;
                props.onOpenContextMenu(node.path); return true;
            case 'closeContextMenu': if (!props.contextMenuDirectoryPath) return false; props.onCloseContextMenu(); return true;
            case 'contextCreateFolder':
                if (!props.contextMenuDirectoryPath) return false;
                props.onContextCreateFolder(context); return true;
            case 'retryRoot':
                if (!props.rootError || !isFilesystemErrorRetryable(props.rootError)) return false;
                void props.onRetryRoot(context); return true;
            case 'retryDirectory':
                if (!path || !props.nodes.some(candidate => candidate.type === 'error' && candidate.parentDirectoryPath === path
                    && isFilesystemErrorRetryable(candidate.errorMessage))) return false;
                void props.onRetryDirectory(path, context); return true;
            case 'retrySearch': if (!props.searchError) return false; void props.onRetrySearch(context); return true;
        }
    };
    const declarations: ReadonlyArray<Readonly<{ key: BrowserCommandKey; title: string; present?: boolean }>> = props.scope === undefined ? [] : [
        { key: 'activate', title: t('common.use') },
        { key: 'disclosure', title: t('toolView.expand') },
        { key: 'search', title: t('files.searchPlaceholder') },
        { key: 'clearSearch', title: t('files.clearSearchA11y'), present: props.canClearSearch },
        { key: 'hidden', title: t('files.toolbar.hiddenFiles') },
        { key: 'refresh', title: t('common.refresh') },
        { key: 'collapseAll', title: t('files.repositoryCollapseAll') },
        { key: 'createFolder', title: t('files.createFolderA11y') },
        { key: 'confirm', title: t('common.use'), present: props.modal && props.interaction === 'confirm' },
        { key: 'close', title: t('common.close'), present: props.onClose !== undefined },
        { key: 'contextMenu', title: t('common.moreActions'), present: props.modal },
        { key: 'closeContextMenu', title: t('common.close'), present: props.contextMenuDirectoryPath !== null },
        { key: 'contextCreateFolder', title: t('files.createFolderA11y'), present: props.contextMenuDirectoryPath !== null },
        { key: 'retryRoot', title: t('common.retry'), present: Boolean(props.rootError) },
        { key: 'retryDirectory', title: t('common.retry'), present: props.nodes.some(node => node.type === 'error') },
        { key: 'retrySearch', title: t('common.retry'), present: props.searchError },
    ];
    const definitions: CurrentUiContextLocalCommand[] = props.scope === undefined ? [] : declarations
        .filter(declaration => declaration.present !== false).map(({ key, title }) => ({ key, title,
            description: JSON.stringify({ control: `${props.scope}.${key}`,
                ...(key === 'search' ? { input: { value: 'string' } }
                    : key === 'activate' || key === 'disclosure' || key === 'contextMenu' || key === 'retryDirectory'
                        ? { input: { path: 'rendered node path' } } : {}) }),
            invoke: (input, context) => key === 'activate' && input === undefined
                ? { ok: true, result: { selectedPath: props.selectedPath, searchQuery: props.searchQuery, showHidden: props.showHidden,
                    canConfirm: props.canConfirm, canCreateFolder: props.canCreateFolder,
                    nodes: props.nodes.flatMap(node => node.type === 'directory' || node.type === 'file'
                    ? [{ path: node.path, type: node.type, expanded: node.type === 'directory' && node.isExpanded }] : []) } }
                : apply(key, input, context),
        } satisfies CurrentUiContextLocalCommand));
    const commands = useCurrentUiContextLocalCommands(definitions, { foregroundOverlay: true, contextKey: props.scope });
    const latestApply = React.useRef(apply);
    React.useLayoutEffect(() => { latestApply.current = apply; });
    return React.useCallback((key: BrowserCommandKey, input?: PluginUiJsonValueV1) => {
        if (props.scope === undefined) return latestApply.current(key, input);
        return commands.invoke(key, input);
    }, [commands.invoke, props.scope]);
}
