import * as React from 'react';

import { compareTurnChangeSetChronology } from '@happier-dev/protocol/sessions/changes/mergeTurnChangeSets';
import type { SessionChangeSet, TurnChangeSet } from '@happier-dev/protocol/sessions/changes/types';

import { useSession, useSessionMessages } from '@/sync/domains/state/storage';
import { readStoredSessionMessagesForAddress } from '@/sync/domains/messages/readStoredSessionMessagesForAddress';
import {
    areSessionAddressesEqual,
    normalizeSessionAddress,
    type SessionAddress,
} from '@/sync/domains/session/sessionAddress';

import { deriveLatestTurnScopedChangeSet } from '../derivation/deriveLatestTurnScopedChangeSet';
import { deriveFileChangeDiff } from '../derivation/deriveFileChangeDiff';
import { deriveSessionChangeSet } from '../derivation/deriveSessionChangeSet';
import { deriveTurnChangeSetsFromMessages } from '../derivation/deriveTurnChangeSetsFromMessages';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

type UseDerivedSessionChangeSetResult = Readonly<{
    turnChangeSets: readonly TurnChangeSet[];
    /** The presented turn: `presentedTurnId` when given, otherwise the Session's latest turn. */
    latestTurnId: string | null;
    /** The Session's canonical latest turn, whatever turn is presented. */
    sessionLatestTurnId: string | null;
    latestTurnChangeSet: TurnChangeSet | null;
    latestTurnScopedChangeSet: SessionChangeSet | null;
    sessionChangeSet: SessionChangeSet | null;
    latestTurnDiffByPath: ReadonlyMap<string, string | null> | null;
    latestTurnAgentReportedDiffByPath: ReadonlyMap<string, string | null> | null;
    latestTurnCheckpointDiffByPath: ReadonlyMap<string, string | null> | null;
    providerDiffByPath: ReadonlyMap<string, string | null> | null;
}>;

function buildDiffByPath(changeSet: SessionChangeSet | null): ReadonlyMap<string, string | null> | null {
    if (!changeSet) return null;
    // Preserve explicit unavailable entries: review must not replace scoped evidence with SCM.
    const entries = changeSet.files.map((file) => [file.filePath, deriveFileChangeDiff(file)] as const);
    return entries.length > 0 ? new Map(entries) : null;
}

export type UseDerivedSessionChangeSetOptions = Readonly<{
    /**
     * Present this turn's evidence in the `latestTurn*` fields instead of the latest turn's (a turn
     * card's link opens that exact turn). A turn without published evidence presents nothing.
     */
    presentedTurnId?: string | null;
}>;

export function useDerivedSessionChangeSet(
    address: SessionAddress | null,
    repoRootPath?: string | null,
    options?: UseDerivedSessionChangeSetOptions,
): UseDerivedSessionChangeSetResult {
    const presentedTurnId = typeof options?.presentedTurnId === 'string' && options.presentedTurnId.trim().length > 0
        ? options.presentedTurnId.trim()
        : null;
    const requestedAddress = React.useMemo(
        () => normalizeSessionAddress(address?.serverId, address?.sessionId),
        [address?.serverId, address?.sessionId],
    );
    const sessionId = requestedAddress?.sessionId ?? '';
    const session = useSession(sessionId);
    const { messages: storedMessages } = useSessionMessages(sessionId, {
        enabled: requestedAddress !== null,
    });

    const messages = React.useMemo(() => readStoredSessionMessagesForAddress(
        {
            sessions: sessionId ? { [sessionId]: session } : {},
            sessionMessages: sessionId ? { [sessionId]: { messages: storedMessages } } : {},
        },
        requestedAddress,
    ), [requestedAddress, session, sessionId, storedMessages]);

    const exactSession = React.useMemo(() => {
        if (!requestedAddress || !session) return null;
        const storedAddress = normalizeSessionAddress(session.serverId, sessionId);
        return areSessionAddressesEqual(storedAddress, requestedAddress) ? session : null;
    }, [requestedAddress, session, sessionId]);

    const turnChangeSets = React.useMemo(() => {
        return deriveTurnChangeSetsFromMessages(messages);
    }, [messages]);

    const latestTurnChangeSet = React.useMemo(() => {
        if (presentedTurnId) return turnChangeSets.find((turn) => turn.turnId === presentedTurnId) ?? null;
        const latestTurnId = exactSession?.latestTurnId;
        if (typeof latestTurnId === 'string' && latestTurnId.trim().length > 0) {
            // Empty and unavailable turns publish lifecycle facts without a Diff transcript row.
            return turnChangeSets.find((turn) => turn.turnId === latestTurnId) ?? null;
        }
        // "Latest" is canonical turn identity, not transcript arrival order: a turn's evidence can
        // be published after a later turn's, and the presented scope must still be the later turn.
        // Retain evidence chronology for Sessions whose host has not supplied lifecycle identity.
        return turnChangeSets.reduce<TurnChangeSet | null>((latest, turn) => (
            latest === null || compareTurnChangeSetChronology(latest, turn) <= 0 ? turn : latest
        ), null);
    }, [exactSession?.latestTurnId, presentedTurnId, turnChangeSets]);

    const sessionChangeSet = React.useMemo(() => {
        return deriveSessionChangeSet({
            sessionId,
            repoRootPath,
            metadata: exactSession ? readSessionOwnerMetadataView(exactSession) : null,
            turnChangeSets,
        });
    }, [
        exactSession?.metadata,
        exactSession?.metadataLayoutVersion,
        exactSession?.ownerMetadataView,
        sessionId,
        repoRootPath,
        turnChangeSets,
    ]);

    const latestTurnScopedChangeSet = React.useMemo(() => {
        return deriveLatestTurnScopedChangeSet({
            sessionId,
            repoRootPath,
            latestTurnChangeSet,
        });
    }, [latestTurnChangeSet, repoRootPath, sessionId]);

    const latestTurnDiffByPath = React.useMemo(() => {
        return buildDiffByPath(latestTurnScopedChangeSet);
    }, [latestTurnScopedChangeSet]);

    const latestTurnAgentReportedDiffByPath = React.useMemo(() => {
        return buildDiffByPath(deriveLatestTurnScopedChangeSet({
            sessionId,
            repoRootPath,
            latestTurnChangeSet,
            evidenceScope: 'agent_reported',
        }));
    }, [latestTurnChangeSet, repoRootPath, sessionId]);

    const latestTurnCheckpointDiffByPath = React.useMemo(() => {
        return buildDiffByPath(deriveLatestTurnScopedChangeSet({
            sessionId,
            repoRootPath,
            latestTurnChangeSet,
            evidenceScope: 'checkpoint',
        }));
    }, [latestTurnChangeSet, repoRootPath, sessionId]);

    const providerDiffByPath = React.useMemo(() => {
        return buildDiffByPath(sessionChangeSet);
    }, [sessionChangeSet]);

    return {
        turnChangeSets,
        latestTurnId: presentedTurnId ?? exactSession?.latestTurnId ?? null,
        sessionLatestTurnId: exactSession?.latestTurnId ?? null,
        latestTurnChangeSet,
        latestTurnScopedChangeSet,
        sessionChangeSet,
        latestTurnDiffByPath,
        latestTurnAgentReportedDiffByPath,
        latestTurnCheckpointDiffByPath,
        providerDiffByPath,
    };
}
