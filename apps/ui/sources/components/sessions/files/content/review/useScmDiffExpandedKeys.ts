import * as React from 'react';

function areStringSetsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>) {
    if (left === right) return true;
    if (left.size !== right.size) return false;
    for (const value of left) {
        if (!right.has(value)) return false;
    }
    return true;
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
        return new Set(input.allKeys.slice(0, 1));
    }, [input.allKeys]);
    const initialAutoExpandedKeysSignature = React.useMemo(() => {
        return Array.from(initialAutoExpandedKeySet).sort().join('\n');
    }, [initialAutoExpandedKeySet]);
    const initialCollapsedKeysStateSignature = React.useMemo(() => {
        return Array.from(initialCollapsedKeySet).sort().join('\n');
    }, [initialCollapsedKeySet]);

    const [autoExpandedKeys, setAutoExpandedKeys] = React.useState<Set<string>>(() => new Set());

    React.useEffect(() => {
        if (!input.tooLarge) {
            setAutoExpandedKeys((prev) => (prev.size === 0 ? prev : new Set()));
            setManualExpandedKeys((prev) => (prev.size === 0 ? prev : new Set()));
            setCollapsedKeys((prev) => (
                areStringSetsEqual(prev, initialCollapsedKeySet) ? prev : new Set(initialCollapsedKeySet)
            ));
            return;
        }
        setAutoExpandedKeys((prev) => (
            areStringSetsEqual(prev, initialAutoExpandedKeySet) ? prev : new Set(initialAutoExpandedKeySet)
        ));
        setManualExpandedKeys((prev) => (prev.size === 0 ? prev : new Set()));
        setCollapsedKeys((prev) => (
            areStringSetsEqual(prev, initialCollapsedKeySet) ? prev : new Set(initialCollapsedKeySet)
        ));
    }, [initialAutoExpandedKeysSignature, initialCollapsedKeysStateSignature, input.resetKey, input.tooLarge]);

    React.useEffect(() => {
        if (!input.tooLarge) return;
        if (input.viewableExpansionEnabled === false) return;
        const firstVisibleIndex = input.viewableIndices.find((index) => (
            typeof index === 'number'
            && Number.isFinite(index)
            && index >= 0
            && index < input.allKeys.length
        ));
        if (typeof firstVisibleIndex !== 'number') return;
        const key = input.allKeys[firstVisibleIndex];
        if (!key) return;
        const nextKeys = new Set([key]);
        setAutoExpandedKeys((prev) => {
            return areStringSetsEqual(prev, nextKeys) ? prev : nextKeys;
        });
    }, [input.allKeys, input.tooLarge, input.viewableExpansionEnabled, input.viewableIndices]);

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
        const cb = onCollapsedKeysChangeRef.current;
        if (!cb) return;
        const ordered = input.allKeys.filter((key) => collapsedKeys.has(key));
        cb(ordered);
    }, [collapsedKeys, input.allKeys]);

    return { collapsedKeys, toggleCollapsed, expandedKeys };
}
