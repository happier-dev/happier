import * as React from 'react';

import { resolveIndexWindow } from '@/components/ui/scroll/resolveIndexWindow';

export type ScmDiffExpandedKeysState = Readonly<{
    collapsedKeys: ReadonlySet<string>;
    toggleCollapsed: (key: string) => void;
    expandedKeys: ReadonlySet<string>;
}>;

export function useScmDiffExpandedKeys(input: Readonly<{
    allKeys: readonly string[];
    viewableIndices: readonly number[];
    tooLarge: boolean;
    aheadCount: number;
    behindCount: number;
    resetKey: string;
    initialCollapsedKeys?: readonly string[] | null;
    onCollapsedKeysChange?: (keys: string[]) => void;
}>): ScmDiffExpandedKeysState {
    const initialCollapsedKeysSignature = React.useMemo(() => {
        const raw = Array.isArray(input.initialCollapsedKeys)
            ? input.initialCollapsedKeys.filter((k) => typeof k === 'string').map((k) => k.trim()).filter((k) => k.length > 0)
            : [];
        const uniqueSorted = Array.from(new Set(raw)).sort();
        return uniqueSorted.join('\n');
    }, [input.initialCollapsedKeys]);

    const initialCollapsedKeySet = React.useMemo(() => {
        const allowed = new Set(input.allKeys);
        const out = new Set<string>();
        const initial = initialCollapsedKeysSignature.length > 0 ? initialCollapsedKeysSignature.split('\n') : [];
        for (const key of initial) {
            if (!allowed.has(key)) continue;
            out.add(key);
        }
        return out;
    }, [input.allKeys, initialCollapsedKeysSignature]);

    const [collapsedKeys, setCollapsedKeys] = React.useState<Set<string>>(() => new Set(initialCollapsedKeySet));
    const toggleCollapsed = React.useCallback((key: string) => {
        setCollapsedKeys((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);

    const onCollapsedKeysChangeRef = React.useRef(input.onCollapsedKeysChange);
    React.useEffect(() => {
        onCollapsedKeysChangeRef.current = input.onCollapsedKeysChange;
    }, [input.onCollapsedKeysChange]);

    const initialAutoExpandedKeySet = React.useMemo(() => {
        const initialCount = Math.max(1, input.aheadCount + input.behindCount + 1);
        return new Set(input.allKeys.slice(0, initialCount));
    }, [input.aheadCount, input.allKeys, input.behindCount]);

    const [autoExpandedKeys, setAutoExpandedKeys] = React.useState<Set<string>>(() => new Set());

    React.useEffect(() => {
        if (!input.tooLarge) {
            setAutoExpandedKeys(new Set());
            setCollapsedKeys(new Set(initialCollapsedKeySet));
            return;
        }
        setAutoExpandedKeys(new Set(initialAutoExpandedKeySet));
        setCollapsedKeys(new Set(initialCollapsedKeySet));
    }, [initialAutoExpandedKeySet, initialCollapsedKeySet, input.resetKey, input.tooLarge]);

    React.useEffect(() => {
        if (!input.tooLarge) return;
        const window = resolveIndexWindow({
            viewableIndices: input.viewableIndices,
            aheadCount: input.aheadCount,
            // Never auto-expand diffs *above* the first visible row: expanding above the viewport
            // changes height "behind" the user's scroll position and makes scrolling feel like it
            // snaps back up on web. Prefetch can be bidirectional, but auto-expansion must not be.
            behindCount: 0,
            maxIndex: Math.max(0, input.allKeys.length - 1),
        });
        if (!window) return;
        const windowKeys = input.allKeys.slice(window.startIndex, window.endIndex + 1);
        setAutoExpandedKeys((prev) => {
            let changed = false;
            const next = new Set(prev);
            for (const key of windowKeys) {
                if (next.has(key)) continue;
                next.add(key);
                changed = true;
            }
            return changed ? next : prev;
        });
    }, [input.aheadCount, input.allKeys, input.tooLarge, input.viewableIndices]);

    const expandedKeys = React.useMemo(() => {
        if (!input.tooLarge) {
            const out = new Set<string>();
            for (const key of input.allKeys) {
                if (collapsedKeys.has(key)) continue;
                out.add(key);
            }
            return out;
        }

        const autoKeys = autoExpandedKeys.size > 0 ? autoExpandedKeys : initialAutoExpandedKeySet;
        const out = new Set<string>();
        for (const key of autoKeys) {
            if (collapsedKeys.has(key)) continue;
            out.add(key);
        }
        return out;
    }, [autoExpandedKeys, collapsedKeys, initialAutoExpandedKeySet, input.allKeys, input.tooLarge]);

    React.useEffect(() => {
        const cb = onCollapsedKeysChangeRef.current;
        if (!cb) return;
        const ordered = input.allKeys.filter((key) => collapsedKeys.has(key));
        cb(ordered);
    }, [collapsedKeys, input.allKeys]);

    return { collapsedKeys, toggleCollapsed, expandedKeys };
}
