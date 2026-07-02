import * as React from 'react';

function areStringSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>) {
    if (left === right) return true;
    if (left.size !== right.size) return false;
    for (const value of left) {
        if (!right.has(value)) return false;
    }
    return true;
}

function normalizeWindowCount(value: number) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.floor(value));
}

function buildExpandedWindow(input: Readonly<{
    allKeys: readonly string[];
    viewableIndices: readonly number[];
    aheadCount: number;
    behindCount: number;
}>): Set<string> | null {
    const validIndices = input.viewableIndices.filter((index) => (
        typeof index === 'number'
        && Number.isFinite(index)
        && index >= 0
        && index < input.allKeys.length
    ));
    if (validIndices.length === 0) return null;

    const aheadCount = normalizeWindowCount(input.aheadCount);
    const behindCount = normalizeWindowCount(input.behindCount);
    const start = Math.max(0, Math.min(...validIndices) - behindCount);
    const end = Math.min(input.allKeys.length - 1, Math.max(...validIndices) + aheadCount);
    return new Set(input.allKeys.slice(start, end + 1));
}

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
    viewableExpansionEnabled?: boolean;
}>): ScmDiffExpandedKeysState {
    const initialCollapsedKeysSignature = React.useMemo(() => {
        const raw = Array.isArray(input.initialCollapsedKeys)
            ? input.initialCollapsedKeys.filter((key) => typeof key === 'string').map((key) => key.trim()).filter((key) => key.length > 0)
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
    const [manualExpandedKeys, setManualExpandedKeys] = React.useState<Set<string>>(() => new Set());
    const expandedKeysRef = React.useRef<ReadonlySet<string>>(new Set());
    const toggleCollapsed = React.useCallback((key: string) => {
        if (!input.tooLarge) {
            setCollapsedKeys((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
            });
            return;
        }

        const isExpanded = expandedKeysRef.current.has(key);
        setCollapsedKeys((prev) => {
            const next = new Set(prev);
            if (isExpanded) next.add(key);
            else next.delete(key);
            return areStringSetsEqual(prev, next) ? prev : next;
        });
        setManualExpandedKeys((prev) => {
            const next = new Set(prev);
            if (isExpanded) next.delete(key);
            else next.add(key);
            return areStringSetsEqual(prev, next) ? prev : next;
        });
    }, [input.tooLarge]);

    const onCollapsedKeysChangeRef = React.useRef(input.onCollapsedKeysChange);
    React.useEffect(() => {
        onCollapsedKeysChangeRef.current = input.onCollapsedKeysChange;
    }, [input.onCollapsedKeysChange]);

    const initialAutoExpandedKeySet = React.useMemo(() => {
        const initialCount = Math.max(
            1,
            normalizeWindowCount(input.aheadCount) + normalizeWindowCount(input.behindCount) + 1,
        );
        return new Set(input.allKeys.slice(0, initialCount));
    }, [input.aheadCount, input.allKeys, input.behindCount]);

    const [autoExpandedKeys, setAutoExpandedKeys] = React.useState<Set<string>>(() => new Set());

    React.useEffect(() => {
        if (!input.tooLarge) {
            setAutoExpandedKeys(new Set());
            setManualExpandedKeys(new Set());
            setCollapsedKeys(new Set(initialCollapsedKeySet));
            return;
        }
        setAutoExpandedKeys((prev) => (
            areStringSetsEqual(prev, initialAutoExpandedKeySet) ? prev : new Set(initialAutoExpandedKeySet)
        ));
        setManualExpandedKeys((prev) => (prev.size === 0 ? prev : new Set()));
        setCollapsedKeys((prev) => (
            areStringSetsEqual(prev, initialCollapsedKeySet) ? prev : new Set(initialCollapsedKeySet)
        ));
    }, [initialAutoExpandedKeySet, initialCollapsedKeySet, input.resetKey, input.tooLarge]);

    React.useEffect(() => {
        if (!input.tooLarge) return;
        if (input.viewableExpansionEnabled === false) return;
        const nextKeys = buildExpandedWindow(input);
        if (!nextKeys) return;
        setAutoExpandedKeys((prev) => {
            return areStringSetsEqual(prev, nextKeys) ? prev : nextKeys;
        });
    }, [input.aheadCount, input.allKeys, input.behindCount, input.tooLarge, input.viewableExpansionEnabled, input.viewableIndices]);

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
        const allowedKeys = new Set(input.allKeys);
        const out = new Set<string>();
        for (const key of autoKeys) {
            if (collapsedKeys.has(key)) continue;
            out.add(key);
        }
        for (const key of manualExpandedKeys) {
            if (!allowedKeys.has(key) || collapsedKeys.has(key)) continue;
            out.add(key);
        }
        return out;
    }, [autoExpandedKeys, collapsedKeys, initialAutoExpandedKeySet, input.allKeys, input.tooLarge, manualExpandedKeys]);

    expandedKeysRef.current = expandedKeys;

    React.useEffect(() => {
        const onCollapsedKeysChange = onCollapsedKeysChangeRef.current;
        if (!onCollapsedKeysChange) return;
        const ordered = input.allKeys.filter((key) => collapsedKeys.has(key));
        onCollapsedKeysChange(ordered);
    }, [collapsedKeys, input.allKeys]);

    return { collapsedKeys, toggleCollapsed, expandedKeys };
}
