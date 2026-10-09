import * as React from 'react';
import { useHappierTreeInteraction, type HappierTreeNode } from '@happier-dev/plugin-ui/presentation';
import type { ItemProps } from '@/components/ui/lists/Item';

export type FilesystemTreeKeyboardNode = Readonly<{ path: string; parentPath?: string | null; depth: number; type: string; isExpanded: boolean }>;
export type FilesystemTreeRowProps = Pick<ItemProps, 'webRole' | 'webTabIndex' | 'accessibilityLevel' | 'webKeyShortcuts' | 'accessibilityExpanded' | 'pressableRef' | 'onFocus' | 'onKeyDown'>;
const ignoreActivation = () => {};

/** One keyboard/focus owner for filesystem trees and their changed-file projection. */
export function useFilesystemTreeKeyboard(nodes: readonly FilesystemTreeKeyboardNode[], onFocusIndex?: (index: number) => void) {
    const [focusedPath, setFocusedPath] = React.useState<string | null>(null);
    const visibleNodes = React.useMemo(() => {
        const ancestors: FilesystemTreeKeyboardNode[] = [];
        const result: HappierTreeNode[] = [];
        for (const node of nodes) {
            if (node.type === 'info') continue;
            while (ancestors.length && ancestors[ancestors.length - 1].depth >= node.depth) ancestors.pop();
            result.push({ key: node.path,
                parentKey: node.parentPath === undefined ? ancestors[ancestors.length - 1]?.path ?? null : node.parentPath,
                depth: node.depth, kind: node.type === 'directory' ? 'branch' : 'leaf', expanded: node.isExpanded });
            if (node.type === 'directory') ancestors.push(node);
        }
        return result;
    }, [nodes]);
    const onRevealIndex = React.useCallback((index: number) => {
        onFocusIndex?.(nodes.findIndex(node => node.path === visibleNodes[index]?.key));
    }, [nodes, onFocusIndex, visibleNodes]);
    const tree = useHappierTreeInteraction({ visibleNodes, focusedKey: focusedPath, onFocus: setFocusedPath,
        onExpandedChange: ignoreActivation, onActivate: ignoreActivation, onRevealIndex });

    const getRowProps = React.useCallback((node: FilesystemTreeKeyboardNode, onDisclosure?: () => void, pin?: () => void): FilesystemTreeRowProps => ({
        webRole: 'treeitem',
        webKeyShortcuts: pin ? 'P' : undefined,
        webTabIndex: node.path === tree.activeKey ? 0 : -1,
        accessibilityLevel: node.depth + 1,
        accessibilityExpanded: node.type === 'directory' ? node.isExpanded : undefined,
        pressableRef: target => tree.bindFocusTarget(node.path, target?.focus ? { focus: () => target.focus?.() } : null),
        onFocus: () => setFocusedPath(node.path),
        onKeyDown: event => {
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.target && event.currentTarget && event.target !== event.currentTarget) return;
            const key = event.nativeEvent?.key ?? event.key;
            if ((key === 'p' || key === 'P') && pin) {
                pin();
                event.preventDefault?.();
            } else if (key && key !== 'Enter' && tree.onKeyDown(node.path, key, event, {
                onExpandedChange: () => onDisclosure?.(), onActivate: ignoreActivation,
            })) event.preventDefault?.(); // Plain Enter remains owned by Pressable, avoiding double activation.
        },
    }), [tree.activeKey, tree.bindFocusTarget, tree.onKeyDown]);
    return { activePath: tree.activeKey, getRowProps, focusPath: tree.focusKey };
}
