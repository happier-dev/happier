import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createReviewedChildAuthorizationFixture } from './reviewedChildAuthorization.composed.testkit';

describe('signed execution Run Session preparation', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-run-preparation-', initAuth: true,
            initEncrypt: true, env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '',
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: 'true',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 300_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['execution.run.start', 'execution.run.ensure'] as const)('%s prepares Account currentness and the exact Session without borrowing a read Action', async actionId => {
        const f = await createReviewedChildAuthorizationFixture({ sessionDetail: true });
        try {
            const session = await db.session.create({ data: { accountId: f.account.id,
                tag: crypto.randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
            const input = actionId === 'execution.run.ensure' ? { sessionId: session.id, runId: 'retained-run', resume: true }
                : { sessionId: session.id, intent: 'delegate',
                backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
                instructions: 'Read the selected Session.', permissionMode: 'read_only',
                retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response' };
            const root = await f.root(actionId, input);
            const paths = ['/v1/account/encryption/currentness', `/v2/sessions/${session.id}`];
            const responses = await Promise.all(paths.map(async path => f.app.inject({ method: 'GET', url: path,
                headers: await f.headers(root, { effectActionId: actionId, method: 'GET', path }) })));
            expect(responses.map(response => response.statusCode), responses.map(response => response.body).join('\n'))
                .toEqual([200, 200]);
            const path = paths[0];
            const borrowed = await f.app.inject({ method: 'GET', url: path,
                headers: await f.headers(root, { effectActionId: 'session.transcript.get', method: 'GET', path }) });
            expect(borrowed.statusCode, borrowed.body).toBe(401);
        } finally { await f.app.close(); }
    });
});
