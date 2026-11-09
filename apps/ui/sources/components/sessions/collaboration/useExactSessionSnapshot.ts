import * as React from 'react';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readExternalSessionLink } from '@/sync/domains/session/external/readExternalSessionLink';
import { readExternalSessionTranscriptStorageState } from '@/sync/runtime/external/externalSessionTranscriptAuthority';
import { useSessionListRowSelector } from '@/sync/store/hooks';
import {
    runWithServerRequestAuthorityForServerAccountScope,
} from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import {
    readSessionSnapshotForAuthority,
    SessionSnapshotReadError,
} from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';

type ExactSessionSnapshot = Omit<Session, 'presence'> & { presence?: 'online' | number };

export type ExactSessionSnapshotState =
    | Readonly<{ key: string; kind: 'loading'; session: ExactSessionSnapshot | null; retry: () => void }>
    | Readonly<{ key: string; kind: 'ready'; session: ExactSessionSnapshot; retry: () => void }>
    | Readonly<{
        key: string;
        kind: 'authorization_lost' | 'unsupported' | 'unavailable';
        session: ExactSessionSnapshot | null;
        retry: () => void;
    }>;

const noActiveRequest = async (): Promise<Response> => {
    throw new Error('Expected an exact Account request');
};

function classifySnapshotFailure(error: unknown): Exclude<ExactSessionSnapshotState['kind'], 'loading' | 'ready'> {
    if (!(error instanceof SessionSnapshotReadError)) return 'unavailable';
    if (error.errorCode === 'unauthorized' || error.errorCode === 'forbidden' || error.errorCode === 'not_found') {
        return 'authorization_lost';
    }
    if (error.errorCode === 'invalid_response' || error.httpStatus === 404) return 'unsupported';
    return 'unavailable';
}

/**
 * The canonical row facts this reader's projection depends on, as one value, so
 * a store publication that changed none of them publishes nothing here. A
 * transcript arrival advances only the row's message scalars (`seq`,
 * `updatedAt`, `meaningfulActivityAt`), which are sharing facts only for linked
 * storage, whose publication progress follows the transcript.
 */
function readSharingFacts(row: SessionListRenderableSession | null): string {
    if (!row) return '';
    return JSON.stringify([
        row.metadataVersion,
        row.metadataLayoutVersion ?? null,
        row.access ?? null,
        row.accessLevel ?? null,
        row.archivedAt ?? null,
        row.encryptionMode ?? null,
    ]);
}

function tracksTranscriptProgress(session: ExactSessionSnapshot | null): boolean {
    if (!session) return false;
    const linked = readExternalSessionLink(readSessionOwnerMetadataView(session)) !== null;
    return readExternalSessionTranscriptStorageState(session.currentStorageState, linked) !== 'hosted';
}

/**
 * Ephemeral exact-Home read for UI that needs the full Session projection.
 * The canonical scoped reader owns transport, decryption, and compatibility;
 * this hook owns only React lifetime, canonical invalidation and explicit retry.
 * It deliberately does not publish into or fall back to the active Home's
 * global Session store.
 *
 * Invalidation reuses the canonical Home-scoped Session row the concurrent
 * Session cache already maintains for this exact address, so a sharing fact
 * that changes while the surface is open (a completed materialization, an
 * access change) re-reads without a remount, while a transcript arrival on a
 * hosted Session neither re-reads nor renders. A row for the same raw Session
 * id on a different Home cannot reach this reader: the subscription is keyed by
 * the scope's own `serverId`.
 */
export function useExactSessionSnapshot(
    scope: ServerAccountScope,
    sessionId: string,
): ExactSessionSnapshotState {
    const key = JSON.stringify([
        serverAccountScopeKeySuffix(scope),
        sessionAddressKey({ serverId: scope.serverId, sessionId }),
    ]);
    const [revision, setRevision] = React.useState(0);
    const [state, setState] = React.useState<Readonly<{
        key: string;
        kind: ExactSessionSnapshotState['kind'];
        session: ExactSessionSnapshot | null;
    }>>({ key, kind: 'loading', session: null });
    const retry = React.useCallback(() => setRevision((value) => value + 1), []);
    // Until a read proves the Session hosted, its transcript progress may be a
    // sharing fact; afterwards a message arrival is not one.
    const hostedKnown = state.key === key && state.session !== null && !tracksTranscriptProgress(state.session);
    // The composites are the invalidation signal, not data.
    const sharingRevision = useSessionListRowSelector(scope.serverId, sessionId, readSharingFacts);
    const progressRevision = useSessionListRowSelector(
        scope.serverId,
        sessionId,
        (row) => (hostedKnown || !row ? null : `${row.seq}:${row.updatedAt}`),
    );
    // The inputs of the read in flight or last settled. Learning that the
    // Session is hosted stops progress tracking without changing any fact the
    // read reflects.
    const readBasis = React.useRef<Readonly<{ key: string; revision: number; sharingRevision: string }> | null>(null);

    React.useEffect(() => {
        const basis = readBasis.current;
        if (progressRevision === null && basis?.key === key && basis.revision === revision
            && basis.sharingRevision === sharingRevision) return;
        const nextBasis = { key, revision, sharingRevision };
        readBasis.current = nextBasis;
        let current = true;
        let settled = false;
        // A canonical invalidation refreshes an already-ready projection in
        // place; blanking it would replace the open panel with a spinner for
        // every Session change the surface is watching.
        setState((previous) => (previous.key === key && previous.kind === 'ready'
            ? previous
            : {
                key,
                kind: 'loading',
                // Preserve a same-scope last-good projection while retrying a
                // transient failure. This keeps retained modal/controller
                // instances mounted so their authority fence can be updated
                // when the retry succeeds, without treating stale facts as
                // currently authorized.
                session: previous.key === key ? previous.session : null,
            }));
        void runWithServerRequestAuthorityForServerAccountScope(
            { scope, activeRequest: noActiveRequest },
            async (authority) => await readSessionSnapshotForAuthority({
                authority,
                sessionId,
                isCurrent: () => current,
            }),
        ).then(
            (snapshot) => {
                settled = true;
                if (current) setState({ key, kind: 'ready', session: snapshot.session });
            },
            (error: unknown) => {
                settled = true;
                if (current) {
                    const kind = classifySnapshotFailure(error);
                    setState((previous) => ({
                        key,
                        kind,
                        // Only an unavailable read is transient. Definitive
                        // authorization loss or an unsupported response must
                        // purge the stale Session so retained controls and
                        // one-time bearers cannot survive a real scope loss.
                        session: kind === 'unavailable' && previous.key === key ? previous.session : null,
                    }));
                }
            },
        );
        return () => {
            current = false;
            // A read cancelled before it settled reflects nothing; the next run must read.
            if (!settled && readBasis.current === nextBasis) readBasis.current = null;
        };
    }, [key, progressRevision, revision, scope.accountId, scope.serverId, sessionId, sharingRevision]);

    if (state.key !== key) return { key, kind: 'loading', session: null, retry };
    if (state.kind === 'ready' && state.session) return { key, kind: 'ready', session: state.session, retry };
    return { key, kind: state.kind === 'ready' ? 'unavailable' : state.kind, session: state.session, retry };
}
