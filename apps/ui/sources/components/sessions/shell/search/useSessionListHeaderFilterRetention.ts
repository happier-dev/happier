import * as React from 'react';

type RetainedSessionListHeaderFilters = {
    searchQuery: string;
    selectedTags: string[];
};

const retainedHeaderFiltersByKey = new Map<string, RetainedSessionListHeaderFilters>();

export function clearSessionListHeaderFilterRetentionForTests(): void {
    retainedHeaderFiltersByKey.clear();
}

function getRetainedHeaderFilters(retentionKey: string): RetainedSessionListHeaderFilters {
    const existing = retainedHeaderFiltersByKey.get(retentionKey);
    if (existing) return existing;
    const entry: RetainedSessionListHeaderFilters = {
        searchQuery: '',
        selectedTags: [],
    };
    retainedHeaderFiltersByKey.set(retentionKey, entry);
    return entry;
}

function stringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
}

export function useSessionListHeaderFilterRetention(retentionKey: string): Readonly<{
    searchQuery: string;
    setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
    selectedHeaderTags: string[];
    setSelectedHeaderTags: React.Dispatch<React.SetStateAction<string[]>>;
}> {
    const retainedFilters = React.useMemo(
        () => getRetainedHeaderFilters(retentionKey),
        [retentionKey],
    );
    const [searchQuery, setSearchQueryState] = React.useState(() => retainedFilters.searchQuery);
    const [selectedHeaderTags, setSelectedHeaderTagsState] = React.useState(() => retainedFilters.selectedTags);

    const setSearchQuery = React.useCallback<React.Dispatch<React.SetStateAction<string>>>((value) => {
        setSearchQueryState((current) => {
            const next = typeof value === 'function'
                ? (value as (previous: string) => string)(current)
                : value;
            retainedFilters.searchQuery = next;
            return next;
        });
    }, [retainedFilters]);

    const setSelectedHeaderTags = React.useCallback<React.Dispatch<React.SetStateAction<string[]>>>((value) => {
        setSelectedHeaderTagsState((current) => {
            const next = typeof value === 'function'
                ? (value as (previous: string[]) => string[])(current)
                : value;
            if (!stringArraysEqual(retainedFilters.selectedTags, next)) {
                retainedFilters.selectedTags = [...next];
            }
            return next;
        });
    }, [retainedFilters]);

    React.useEffect(() => {
        retainedFilters.searchQuery = searchQuery;
    }, [retainedFilters, searchQuery]);

    React.useEffect(() => {
        if (stringArraysEqual(retainedFilters.selectedTags, selectedHeaderTags)) return;
        retainedFilters.selectedTags = [...selectedHeaderTags];
    }, [retainedFilters, selectedHeaderTags]);

    return React.useMemo(() => ({
        searchQuery,
        setSearchQuery,
        selectedHeaderTags,
        setSelectedHeaderTags,
    }), [searchQuery, selectedHeaderTags, setSearchQuery, setSelectedHeaderTags]);
}
