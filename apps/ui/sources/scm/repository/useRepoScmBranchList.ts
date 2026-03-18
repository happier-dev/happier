import * as React from 'react';

import type { ScmBranchListEntry } from '@happier-dev/protocol';

import { sortScmBranchListEntries } from './sortScmBranchListEntries';

export type RepoScmBranchListPhase = 'idle' | 'loading' | 'refreshing';

export function useRepoScmBranchList(input: Readonly<{
    ready: boolean;
    autoLoad: boolean;
    readCached: () => ReadonlyArray<ScmBranchListEntry>;
    fetch: () => Promise<ReadonlyArray<ScmBranchListEntry>>;
    onError?: (error: unknown) => void;
}>): Readonly<{
    branches: ReadonlyArray<ScmBranchListEntry>;
    phase: RepoScmBranchListPhase;
    refresh: (phase: Extract<RepoScmBranchListPhase, 'loading' | 'refreshing'>) => Promise<void>;
}> {
    const { autoLoad, fetch, onError, readCached, ready } = input;

    const readSortedCached = React.useCallback(() => {
        return sortScmBranchListEntries(readCached());
    }, [readCached]);

    const [branches, setBranches] = React.useState<ReadonlyArray<ScmBranchListEntry>>(() => {
        if (!ready) {
            return [];
        }
        return readSortedCached();
    });
    const [phase, setPhase] = React.useState<RepoScmBranchListPhase>('idle');
    const requestVersionRef = React.useRef(0);
    const mountedRef = React.useRef(true);

    React.useEffect(() => {
        return () => {
            mountedRef.current = false;
            requestVersionRef.current += 1;
        };
    }, []);

    const refresh = React.useCallback(async (
        nextPhase: Extract<RepoScmBranchListPhase, 'loading' | 'refreshing'>,
    ) => {
        if (!ready) {
            requestVersionRef.current += 1;
            setBranches([]);
            setPhase('idle');
            return;
        }

        const requestVersion = requestVersionRef.current + 1;
        requestVersionRef.current = requestVersion;
        setBranches(readSortedCached());
        setPhase(nextPhase);

        try {
            const nextBranches = await fetch();
            if (!mountedRef.current || requestVersionRef.current !== requestVersion) {
                return;
            }
            setBranches(sortScmBranchListEntries(nextBranches));
        } catch (error) {
            if (!mountedRef.current || requestVersionRef.current !== requestVersion) {
                return;
            }
            onError?.(error);
        } finally {
            if (mountedRef.current && requestVersionRef.current === requestVersion) {
                setPhase('idle');
            }
        }
    }, [fetch, onError, readSortedCached, ready]);

    React.useEffect(() => {
        if (!ready) {
            requestVersionRef.current += 1;
            setBranches([]);
            setPhase('idle');
            return;
        }
        setBranches(readSortedCached());
    }, [readSortedCached, ready]);

    React.useEffect(() => {
        if (!autoLoad) {
            return;
        }
        void refresh('loading');
    }, [autoLoad, refresh]);

    return {
        branches,
        phase,
        refresh,
    };
}
