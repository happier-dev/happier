import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
    canonicalSessionDraftAddressV1,
    SessionDraftMutateRequestV1Schema,
    SessionDraftMutateResponseV1Schema,
    type SessionDraftRecordV1,
} from '@happier-dev/protocol';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { Encryption, EncryptionMaterialUnavailableError } from '@/sync/encryption/encryption';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import {
    configureSessionDraftRepository,
    flushSessionDraft,
    getSessionDraftSnapshot,
    writeExistingSessionDraft,
    writeNewSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { sync } from './sync';

const initialState = storage.getState();
const credentials: AuthCredentials = { token: 'keyless-draft-token' };
const runtime = sync as unknown as {
    credentials: AuthCredentials | null;
    encryption: Encryption | null;
    sessionDraftSyncEnabled: boolean;
};

describe('keyless account draft synchronization', () => {
    beforeEach(() => {
        runtime.credentials = credentials;
        runtime.encryption = Encryption.createWithoutKeyMaterial();
        runtime.sessionDraftSyncEnabled = true;
    });

    afterEach(() => {
        resetRuntimeFetch();
        configureSessionDraftRepository({ syncEnabled: false });
        runtime.credentials = null;
        runtime.encryption = null;
        runtime.sessionDraftSyncEnabled = false;
        storage.setState(initialState, true);
    });

    it('persists new and existing plain drafts through the configured repository and HTTP transport', async () => {
        const scope = { serverId: getActiveServerSnapshot().serverId, accountId: randomUUID() };
        const sessionId = randomUUID();
        const draftId = randomUUID();
        storage.setState({ profileScope: scope });
        storage.getState().applySessions([createSessionFixture({ id: sessionId, encryptionMode: 'plain' })]);
        const records = new Map<string, SessionDraftRecordV1>();
        // The network boundary models the server's typed response. Repository, cipher,
        // credential handling and HTTP request serialization all remain real.
        setRuntimeFetch(async (input, init) => {
            const pathname = new URL(String(input)).pathname;
            if (pathname === '/health' || pathname === '/v1/auth/ping') {
                return Response.json({ ok: true });
            }
            if (pathname !== '/v1/account/session-drafts/mutate') throw new Error(`Unexpected request ${pathname}`);
            const request = SessionDraftMutateRequestV1Schema.parse(JSON.parse(String(init?.body)));
            const response = SessionDraftMutateResponseV1Schema.parse({
                status: 'updated',
                record: {
                    address: request.address,
                    revision: 1,
                    content: request.content,
                    createdAt: 1,
                    updatedAt: 1,
                },
            });
            if (response.status === 'updated') records.set(canonicalSessionDraftAddressV1(request.address), response.record);
            return Response.json(response);
        });

        sync.reconfigureSessionDraftRepositoryForAccountMode(credentials, 'plain');
        writeNewSessionDraft({ scope, draftId, patch: { text: 'new draft' }, materializationIntent: 'userEdit' });
        writeExistingSessionDraft({ scope, sessionId, patch: { text: 'existing draft' } });
        const cases = [
            { address: { kind: 'newSession', draftId } as const, text: 'new draft' },
            { address: { kind: 'session', sessionId } as const, text: 'existing draft' },
        ];
        for (const { address, text } of cases) {
            await expect(flushSessionDraft({ scope, address })).resolves.toEqual({ status: 'clean' });
            const record = records.get(canonicalSessionDraftAddressV1(address));
            expect(record?.content?.t).toBe('plain');
            if (record?.content?.t !== 'plain') throw new Error('Missing plain draft');
            expect(record.content.v.document.composer.text.value).toBe(text);
            expect(getSessionDraftSnapshot(scope, address)?.status).toBe('clean');
        }
    });

    it('rejects E2EE configuration without account material before any draft can be uploaded', () => {
        storage.setState({
            profileScope: { serverId: getActiveServerSnapshot().serverId, accountId: randomUUID() },
        });
        expect(() => sync.reconfigureSessionDraftRepositoryForAccountMode(credentials, 'e2ee'))
            .toThrow(EncryptionMaterialUnavailableError);
    });
});
