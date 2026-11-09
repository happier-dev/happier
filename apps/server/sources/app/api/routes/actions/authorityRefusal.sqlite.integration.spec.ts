import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { ExternalActionHttpErrorSchema, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { decodeBase64 } from 'privacy-kit';
import nacl from 'tweetnacl';

import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';

describe('external Action authority refusals through real authentication', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-action-authority-', initAuth: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0' } });
    }, 300_000);
    afterAll(async () => { await harness?.close(); });

    it('distinguishes insufficient Action authority from invalid credentials on issuance and dispatch', async () => {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: 'controller', platform: 'linux' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(nacl.sign.keyPair().publicKey) } });
        const terminal = await auth.createToken(account.id, undefined, { kind: 'terminal', authority: 'account_automation' });
        const person = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        enableAuthentication(app);
        // Only the daemon transport is replaced; credential and Action admission remain real.
        const dispatch = vi.fn(async () => ({ kind: 'placement_error' as const, code: 'target_unavailable' as const }));
        registerExternalActionRoutes(app, { dispatch });
        const target = { kind: 'machine' as const, machineId: machine.id };
        const request = (actionId: string, token: string, suffix: string, lowered = false) => {
            const envelope = { v: 1, requestId: crypto.randomUUID(), target, input: {} };
            return app.inject({ method: 'POST', url: `/v1/actions/${actionId}${suffix}`,
                headers: { authorization: `Bearer ${token}`, ...(lowered ? { [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' } : {}) },
                payload: suffix ? { v: 1, machineId: machine.id, envelope } : envelope });
        };
        try {
            for (const suffix of ['/execution-authorization', '']) {
                for (const actionId of ['machines.terminal.list', 'approval.request.decide']) {
                    for (const [token, lowered] of [[terminal, false], [person, true]] as const) {
                        const denied = await request(actionId, token, suffix, lowered);
                        expect([denied.statusCode, denied.json()], `${actionId}${suffix}`)
                            .toEqual([403, { error: 'present_user_required' }]);
                        expect(ExternalActionHttpErrorSchema.parse(denied.json())).toEqual({ error: 'present_user_required' });
                    }
                }
                const invalid = await request('machines.terminal.list', 'invalid-credential', suffix);
                expect([invalid.statusCode, invalid.json()]).toEqual([401, { error: 'invalid_token' }]);
            }
            expect(dispatch).not.toHaveBeenCalled();
            const allowed = await request('machines.guard.get', terminal, '/execution-authorization');
            expect(allowed.statusCode, allowed.body).toBe(200);
            expect(ExternalActionExecutionAuthorizationV1Schema.parse(allowed.json()).binding)
                .toMatchObject({ authentication: { kind: 'terminal' }, actionId: 'machines.guard.get' });
            await db.account.update({ where: { id: account.id }, data: { tokenEpoch: { increment: 1 } } });
            for (const suffix of ['/execution-authorization', '']) {
                const expired = await request('machines.terminal.list', terminal, suffix);
                expect([expired.statusCode, expired.json()]).toEqual([401, { error: 'invalid_token' }]);
            }
        } finally {
            await app.close();
            await db.machine.delete({ where: { id: machine.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
