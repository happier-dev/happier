import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { buildSessionSpawnInitialInputLocalIdV1 } from '@happier-dev/protocol/sessions/messages/spawnedFirstTurn';
import { withSessionInputRequestV1, SESSION_MESSAGE_PROVENANCE_META_KEY } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { createSessionCreateOrLoad } from '../../../../apps/ui/sources/sync/domains/session/hostedSystemSession';
import { withCurrentAccountStoredContentCompatibilityHeaders } from '../../../../apps/ui/sources/sync/http/accountStoredContentCompatibility';
import { createLightSqliteHarness } from '../../../../apps/server/sources/testkit/lightSqliteHarness';
import { createSignedDiscussionHttpFixture } from '../../../../apps/server/sources/app/api/routes/actions/discussionExecutionAuthorization.testkit';
import { db } from '../../../../apps/server/sources/storage/db';
import { inTx } from '../../../../apps/server/sources/storage/inTx';
import { setEligibleMachineAccessGrantInTx } from '../../../../apps/server/sources/testkit/machineAccessGrant.testkit';
import { auth } from '../../../../apps/server/sources/app/auth/auth';
import { getOrCreateServerIdentityId } from '../../../../apps/server/sources/app/serverIdentity/serverIdentity';

describe('ordinary Account template Session birth over real HTTP', () => {
    let harness: Awaited<ReturnType<typeof createLightSqliteHarness>>;
    let fixture: Awaited<ReturnType<typeof createSignedDiscussionHttpFixture>>;
    let credentials: { token: string };
    let baseUrl: string;
    const birthStatuses: number[] = [];
    let birthBody: string | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'template-requester-birth-', initAuth: true, initEncrypt: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0',
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: 'true', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
        await getOrCreateServerIdentityId();
    });
    beforeEach(async () => {
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        fixture = await createSignedDiscussionHttpFixture('template.instantiate', [], false, custodian.id, { pending: true });
        await db.machine.update({ where: { id: fixture.machine.id }, data: {
            operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: {
                requesterExecutionIsolation: { protocolVersions: [1] }, sessionInputAdmission: { protocolVersions: [1] } },
        } });
        expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
            machineId: fixture.machine.id, principal: { kind: 'account', accountId: fixture.account.id }, level: 'view' })))
            .toMatchObject({ kind: 'saved' });
        baseUrl = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
        credentials = { token: fixture.presentUserToken };
        birthStatuses.length = 0;
    });
    afterEach(async () => {
        await fixture?.app.close();
    });
    afterAll(async () => { await harness?.close(); });

    function create(tag: string) {
        return createSessionCreateOrLoad({ credentials, accountMode: 'plain', encryption: null,
            tag, metadata: { path: '/tmp', host: 'shared', machineId: fixture.machine.id, flavor: 'codex' }, randomBytes,
            assertCurrent: () => {}, request: requestAsBearer });
    }
    // The captured B Account bearer crosses real HTTP; auth, admission and persistence stay real.
    async function requestAsBearer(path: string, init: RequestInit, token = credentials.token) {
        const headers = withCurrentAccountStoredContentCompatibilityHeaders(init.headers);
        headers.set('Authorization', `Bearer ${token}`);
        const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
        if (path === '/v1/sessions') {
            birthStatuses.push(response.status);
            birthBody = typeof init.body === 'string' ? init.body : undefined;
        }
        return response;
    }
    const accessKeyPath = (sessionId: string) => `/v1/access-keys/${sessionId}/${fixture.machine.id}`;
    function onboarding(sessionId: string, tag: string) {
        return { request: { v: 1, sessionId, targetMachineId: fixture.machine.id,
            localId: buildSessionSpawnInitialInputLocalIdV1({ sessionCreationTag: tag }),
            requestedAction: { v: 1, kind: 'send_now' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Introduce yourself.' },
                meta: withSessionInputRequestV1({ [SESSION_MESSAGE_PROVENANCE_META_KEY]: { v: 1, kind: 'host', producer: 'hostOnboarding' } },
                    { v: 1, producer: 'hostOnboarding', caller: { kind: 'host' }, permission: {} }) } } } };
    }
    const onboardingPath = (sessionId: string) => `/v2/sessions/${sessionId}/pending/template-onboarding`;
    const postAsOwner = (path: string, body: unknown) => requestAsBearer(path, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    it('creates as B on a shared Use Machine and admits control binding and onboarding with the ordinary bearer', async () => {
        const tag = deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: randomUUID() });
        const outcome = await create(tag).then(value => ({ value }), error => ({ error }));
        expect(birthStatuses).toEqual([200]);
        if ('error' in outcome) throw outcome.error;
        const created = outcome.value;
        expect(created.disposition).toBe('created');
        expect(await db.session.findUnique({ where: { id: created.session.id }, select: { accountId: true, tag: true } }))
            .toEqual({ accountId: fixture.account.id, tag });
        const control = await postAsOwner(accessKeyPath(created.session.id), { data: `session-machine-control:${randomUUID()}` });
        expect(control.status).toBe(200);
        expect(await control.json()).toMatchObject({ success: true });
        expect(await db.accessKey.count({ where: { sessionId: created.session.id, machineId: fixture.machine.id,
            accountId: fixture.account.id } })).toBe(1);
        const request = onboarding(created.session.id, tag);
        const pending = await postAsOwner(onboardingPath(created.session.id), request);
        expect(pending.status).toBe(200);
        const pendingResult = await pending.json();
        expect(pendingResult, JSON.stringify(pendingResult)).toMatchObject({ result: { status: 'accepted', localId: request.request.localId } });
        const retried = await postAsOwner(onboardingPath(created.session.id), request);
        expect(await retried.json()).toMatchObject({ result: { status: 'alreadyAccepted' } });
    });

    it('refuses foreign control binding and onboarding, including an editor, and rejects an invalid Account bearer', async () => {
        const tag = deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: randomUUID() });
        const created = await create(tag);
        const otherToken = await auth.createToken(fixture.machine.accountId, undefined, { kind: 'account', authority: 'present_user' });
        const postAsOther = (path: string, body: unknown) => requestAsBearer(path, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, otherToken);
        expect((await postAsOther(accessKeyPath(created.session.id), { data: 'foreign-binding' })).status).toBe(404);
        const request = onboarding(created.session.id, tag);
        const foreign = await postAsOther(onboardingPath(created.session.id), request);
        expect(foreign.status).toBe(200);
        expect(await foreign.json()).toMatchObject({ result: { status: 'rejected', code: 'session_input_target_unavailable' } });
        await db.sessionShare.create({ data: { sessionId: created.session.id, sharedByUserId: fixture.account.id,
            sharedWithUserId: fixture.machine.accountId, accessLevel: 'edit' } });
        const editor = await postAsOther(onboardingPath(created.session.id), request);
        expect(editor.status).toBe(200);
        expect(await editor.json()).toMatchObject({ result: { status: 'rejected', code: 'session_input_target_unavailable' } });
        expect(await db.accessKey.count({ where: { sessionId: created.session.id, accountId: fixture.machine.accountId } })).toBe(0);
        for (const path of ['/v1/sessions', accessKeyPath(created.session.id), onboardingPath(created.session.id)]) {
            const unauthenticated = await requestAsBearer(path, { method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: path === '/v1/sessions' ? birthBody : JSON.stringify(path === accessKeyPath(created.session.id) ? { data: 'invalid' } : request) }, 'invalid-account-token');
            expect(unauthenticated.status).toBe(401);
        }
    });
});
