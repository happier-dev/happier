import * as React from 'react';
import { useHappierTreeInteraction, type HappierTreeNode } from '@happier-dev/plugin-ui/presentation';
import type { ItemProps } from '@/components/ui/lists/Item';

export type FilesystemTreeKeyboardNode = Readonly<{ path: string; parentPath?: string | null; depth: number; type: string; isExpanded: boolean }>;
export type FilesystemTreeRowProps = Pick<ItemProps, 'webRole' | 'webTabIndex' | 'accessibilityLevel' | 'accessibilityPositionInSet' | 'accessibilitySetSize' | 'webKeyShortcuts' | 'accessibilityExpanded' | 'pressableRef' | 'onFocus' | 'onBlur' | 'onKeyDown'>;
const ignoreActivation = () => {};

/** The tree's single tab stop, read per row so moving it redraws only the old and the new row. */
export type FilesystemTreeActivePath = Readonly<{ subscribe: (listener: () => void) => () => void; get: () => string | null }>;

function createActivePathSource(initial: string | null) {
    let current = initial;
    const listeners = new Set<() => void>();
    return {
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        get: () => current,
        set(next: string | null) {
            if (next === current) return;
            current = next;
            for (const listener of listeners) listener();
        },
    };
}

/** Whether `path` holds the tree's tab stop; re-renders only when that answer changes. */
export function useFilesystemTreeRowActive(source: FilesystemTreeActivePath, path: string): boolean {
    return React.useSyncExternalStore(source.subscribe, () => source.get() === path, () => source.get() === path);
}

/** Render-prop form for a row renderer that is a callback rather than a component. */
export function FilesystemTreeRowActive(props: Readonly<{
    source: FilesystemTreeActivePath;
    path: string;
    children: (active: boolean) => React.ReactElement;
}>): React.ReactElement {
    return props.children(useFilesystemTreeRowActive(props.source, props.path));
}

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

    const [activePath] = React.useState(() => createActivePathSource(tree.activeKey));
    // Published after commit; rows subscribed to the source re-render only when their own answer flips.
    React.useLayoutEffect(() => { activePath.set(tree.activeKey); }, [activePath, tree.activeKey]);

    // Stable across tab-stop moves: the caller passes the row's `active` answer from `useFilesystemTreeRowActive`.
    const { positionOf } = tree;
    const getRowProps = React.useCallback((node: FilesystemTreeKeyboardNode, active: boolean, onDisclosure?: () => void, pin?: () => void): FilesystemTreeRowProps => {
        // The list is windowed: the row's place in the whole tree, not among the rows it built.
        const position = positionOf(node.path);
        return {
            webRole: 'treeitem',
            webKeyShortcuts: pin ? 'P' : undefined,
            webTabIndex: active ? 0 : -1,
            accessibilityLevel: node.depth + 1,
            ...(position ? { accessibilityPositionInSet: position.positionInSet, accessibilitySetSize: position.setSize } : {}),
            accessibilityExpanded: node.type === 'directory' ? node.isExpanded : undefined,
            pressableRef: target => tree.bindFocusTarget(node.path, target?.focus ? { focus: () => target.focus?.() } : null),
            onFocus: () => tree.onFocusChange(node.path, true),
            onBlur: () => tree.onFocusChange(node.path, false),
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
        };
    }, [positionOf, tree.bindFocusTarget, tree.onFocusChange, tree.onKeyDown]);
    return { activePath: activePath as FilesystemTreeActivePath, getRowProps, focusPath: tree.focusKey };
}
