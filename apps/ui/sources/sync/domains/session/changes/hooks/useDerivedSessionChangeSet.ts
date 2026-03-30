import * as React from 'react';

import type { SessionChangeSet, TurnChangeSet } from '@happier-dev/protocol';

import { useSession, useSessionMessages } from '@/sync/domains/state/storage';

import { deriveLatestTurnScopedChangeSet } from '../derivation/deriveLatestTurnScopedChangeSet';
import { deriveSessionChangeSet } from '../derivation/deriveSessionChangeSet';
import { deriveTurnChangeSetsFromMessages } from '../derivation/deriveTurnChangeSetsFromMessages';

type UseDerivedSessionChangeSetResult = Readonly<{
    turnChangeSets: readonly TurnChangeSet[];
    latestTurnChangeSet: TurnChangeSet | null;
    latestTurnScopedChangeSet: SessionChangeSet | null;
    sessionChangeSet: SessionChangeSet | null;
    latestTurnDiffByPath: ReadonlyMap<string, string> | null;
    providerDiffByPath: ReadonlyMap<string, string> | null;
}>;

function buildDiffByPath(changeSet: SessionChangeSet | null): ReadonlyMap<string, string> | null {
    if (!changeSet) return null;
    const entries = changeSet.files
        .map((file) => {
            const diff = typeof file.unifiedDiff === 'string' ? file.unifiedDiff.trim() : '';
            if (!diff) return null;
            return [file.filePath, diff] as const;
        })
        .filter((entry): entry is readonly [string, string] => entry !== null);
    return entries.length > 0 ? new Map(entries) : null;
}

export function useDerivedSessionChangeSet(sessionId: string): UseDerivedSessionChangeSetResult {
    const session = useSession(sessionId);
    const { messages } = useSessionMessages(sessionId);

    const turnChangeSets = React.useMemo(() => {
        return deriveTurnChangeSetsFromMessages(messages);
    }, [messages]);

    const latestTurnChangeSet = React.useMemo(() => {
        if (turnChangeSets.length === 0) return null;
        return turnChangeSets[turnChangeSets.length - 1] ?? null;
    }, [turnChangeSets]);

    const sessionChangeSet = React.useMemo(() => {
        return deriveSessionChangeSet({
            sessionId,
            metadata: session?.metadata ?? null,
            turnChangeSets,
        });
    }, [session?.metadata, sessionId, turnChangeSets]);

    const latestTurnScopedChangeSet = React.useMemo(() => {
        return deriveLatestTurnScopedChangeSet({
            sessionId,
            latestTurnChangeSet,
        });
    }, [latestTurnChangeSet, sessionId]);

    const latestTurnDiffByPath = React.useMemo<ReadonlyMap<string, string> | null>(() => {
        return buildDiffByPath(latestTurnScopedChangeSet);
    }, [latestTurnScopedChangeSet]);

    const providerDiffByPath = React.useMemo<ReadonlyMap<string, string> | null>(() => {
        return buildDiffByPath(sessionChangeSet);
    }, [sessionChangeSet]);

    return {
        turnChangeSets,
        latestTurnChangeSet,
        latestTurnScopedChangeSet,
        sessionChangeSet,
        latestTurnDiffByPath,
        providerDiffByPath,
    };
}
