import { SessionCurrentProjectionRecordV1Schema, type SessionCurrentProjectionRecordV1 } from '@happier-dev/protocol/sessions/listing/response';
import { SessionAccessGrantsListRequestV1Schema, SessionAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
import { SessionResponsibilityCandidatesRequestSchema } from '@happier-dev/protocol/sessions/access/sessionResponsibilityV1';
import { SessionDiscussionListResponseV1Schema } from '@happier-dev/protocol/sessions/discussions/api';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { createRootLayoutFeaturesResponse } from '../fixtures/featureFixtures';
import { createSessionAccessFixture } from '../fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '../fixtures/accountEncryptionCurrentness';

export type CollaborationHttpRequest = Readonly<{
    url: URL;
    path: string;
    method: string;
    body: unknown;
    accountId: string | null;
}>;
type ResponseOverride = (request: CollaborationHttpRequest) => Response | Promise<Response> | undefined;

/** Real published Home records. Consumers never translate a projected UI Session back into wire data. */
export function createCollaborationSessionRecord(
    sessionId: string,
    overrides: Partial<SessionCurrentProjectionRecordV1> = {},
): SessionCurrentProjectionRecordV1 {
    return SessionCurrentProjectionRecordV1Schema.parse({
        id: sessionId, createdAt: 1, updatedAt: 2, seq: 3, active: true, activeAt: 2,
        encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 1,
        metadataVersion: 1, metadata: JSON.stringify({ v: 1 }), agentStateVersion: 1,
        agentState: null, ownerMetadata: { t: 'plain', v: { v: 1 } }, share: null, currentStorageState: 'hosted', transcriptShareable: true,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
            capabilities: createSessionAccessFixture().capabilities },
        responsibleAccountId: null, responsibleAccount: null, ...overrides,
    });
}

/**
 * One HTTP fixture for the actual Collaboration host and its integration tests.
 * Auth/credentials, Action admission, codecs, scoped readers and domain clients remain real.
 * It composes with serveActionHomes or the existing runtimeFetch SDK boundary; it owns no store.
 */
export function createSessionCollaborationHttpBoundary() {
    const requests: CollaborationHttpRequest[] = [];
    const homes = new Map<string, ReturnType<typeof createHome>>();
    function createHome(accountId: string) {
        const features = createRootLayoutFeaturesResponse();
        for (const id of ['sharing.session', 'sharing.public', 'sessions.conversations', 'teams'] as const) {
            if (!tryWriteServerEnabledBitInPlace(features, id, true)) throw new Error(`Unknown fixture feature: ${id}`);
        }
        const sessions = new Map<string, SessionCurrentProjectionRecordV1>();
        const publications = new Map<string, Record<string, unknown> | null>();
        return { accountId, features, sessions, publications,
            snapshotResponse: undefined as ResponseOverride | undefined,
            discussionResponse: undefined as ResponseOverride | undefined,
            publicationResponse: undefined as ResponseOverride | undefined,
            accessResponse: undefined as ResponseOverride | undefined,
        };
    }
    const addHome = (origin: string, accountId: string) => {
        const home = createHome(accountId);
        homes.set(new URL(origin).origin, home);
        return home;
    };
    const route = async (request: CollaborationHttpRequest): Promise<Response | undefined> => {
        const home = homes.get(request.url.origin);
        if (!home) return undefined;
        requests.push(request);
        if (request.path === '/v1/features') return Response.json(home.features);
        if (request.accountId === null) return Response.json({ error: 'unauthorized' }, { status: 401 });
        if (request.accountId !== home.accountId) return Response.json({ error: 'not_found' }, { status: 404 });
        if (request.path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (request.path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (request.path === '/v2/account/settings') return Response.json({ content: null, version: 0 });
        if (request.path === '/v2/cursor') return Response.json({ cursor: '0' });
        const snapshot = /^\/v2\/sessions\/([^/]+)$/.exec(request.path);
        if (snapshot) {
            if (home.snapshotResponse) return await home.snapshotResponse(request);
            const session = home.sessions.get(decodeURIComponent(snapshot[1]!));
            return session ? Response.json({ session }) : Response.json({ error: 'not_found' }, { status: 404 });
        }
        if (request.path === '/v2/sessions/access-grants/list') {
            if (home.accessResponse) return await home.accessResponse(request);
            const input = SessionAccessGrantsListRequestV1Schema.parse(request.body);
            const session = home.sessions.get(input.sessionId);
            if (!session) return Response.json({ error: 'session_access_session_not_found' }, { status: 404 });
            return Response.json(SessionAccessGrantsListResponseV1Schema.parse({ visibility: 'complete',
                owner: { kind: 'account', accountId: home.accountId, firstName: 'Leeroy', lastName: 'Brun', username: 'leeroy', avatarUrl: null },
                effectiveAccess: session.effectiveAccess, primaryTeamId: null, grants: [] }));
        }
        if (/^\/v2\/sessions\/[^/]+\/data-key\/envelopes$/.test(request.path)) return Response.json({ status: 'not_required' });
        if (request.path === '/v2/sessions/responsibility/candidates') {
            SessionResponsibilityCandidatesRequestSchema.parse(request.body);
            return Response.json({ candidates: [], nextCursor: null });
        }
        if (/^\/v2\/sessions\/[^/]+\/discussions$/.test(request.path)) {
            if (home.discussionResponse) return await home.discussionResponse(request);
            return Response.json(SessionDiscussionListResponseV1Schema.parse({ discussions: [], nextCursor: null }));
        }
        const publicShare = /^\/v1\/sessions\/([^/]+)\/public-share$/.exec(request.path);
        if (publicShare || request.path === '/v1/public-shares') {
            if (home.publicationResponse) return await home.publicationResponse(request);
            // A creation journey supplies its own stateful publication transport response.
            if (!publicShare) return Response.json({ error: 'fixture_publication_writer_unconfigured' }, { status: 501 });
            const sessionId = decodeURIComponent(publicShare[1]!);
            if (request.method === 'DELETE') home.publications.set(sessionId, null);
            return Response.json({ publicShare: home.publications.get(sessionId) ?? null,
                isolatedOrigin: 'https://public-viewer.example.test' });
        }
        if (request.path === '/v1/teams/list') return Response.json({ items: [], nextCursor: null });
        if (request.path === '/v1/user/search') return Response.json({ users: [], nextCursor: null });
        return undefined;
    };
    return { requests, addHome, route };
}
