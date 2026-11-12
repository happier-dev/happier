import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountSettingsParse, normalizeActionsSettingsV1 } from '@happier-dev/protocol';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { accountRoutes } from '../account/accountRoutes';
import { artifactsRoutes } from '../artifacts/artifactsRoutes';
import { registerAccountApiTokenManagementRoutes } from './registerAccountApiTokenManagementRoutes';

async function importCli<T>(specifier: string): Promise<T> {
    // Run actual CLI source composition without expanding the server TS rootDir.
    return import(specifier) as Promise<T>;
}

describe('API-token creation admission through CLI wiring and real Account storage', () => {
    let sqlite: LightSqliteHarness;
    beforeAll(async () => {
        sqlite = await createLightSqliteHarness({ tempDirPrefix: 'happier-token-act-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 120_000);
    afterAll(async () => { if (sqlite) await sqlite.close(); });

    // OWNER-RULINGS 2026-11-07 and f8da9619de2: new PAT bearers stay human-only.
    it.each(['agent', 'mcp'] as const)('refuses %s token creation before approval or effect', async surface => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const credentials = { token: await auth.createToken(account.id, undefined,
            { kind: 'account', authority: 'present_user' }), encryption: null, credentialProvenance: 'stored_session' as const };
        const home = createAuthenticatedTestApp({ authentication: 'real' });
        const writes: string[] = [];
        home.addHook('onRequest', async request => { if (request.method === 'POST') writes.push(request.url); });
        accountRoutes(home); artifactsRoutes(home); registerAccountApiTokenManagementRoutes(home);
        const url = await home.listen({ port: 0, host: '127.0.0.1' });
        try {
            const { createCliActionExecutorFromCredentials } = await importCli<
                typeof import('../../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials')>(
                '../../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials');
            const artifactsBefore = await db.artifact.count({ where: { accountId: account.id } });
            const executor = createCliActionExecutorFromCredentials({ credentials, serverId: 'token-refusal',
                serverApiUrl: url, readCredentials: async () => credentials,
                actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1 }),
                    getAccountSettings: () => accountSettingsParse({}) } });
            for (const bypassApprovals of [false, true]) {
                const result = await executor.execute('account.apiTokens.create', { tokenId: randomUUID(), label: 'Human only' }, {
                    surface, authority: 'account_automation', runtimeAccountId: account.id, bypassApprovals,
                    ...(surface === 'agent' ? { actionCaller: { kind: 'session' as const, sessionId: 'requesting-session',
                        starterDepth: 0, turnDepth: 0 }, defaultSessionId: 'requesting-session',
                        sessionInputSource: { sourceSessionId: 'requesting-session', sourceTurnId: 'requesting-turn' } }
                        : { actionCaller: { kind: 'host' as const } }),
                });
                expect(result).toMatchObject({ ok: false, errorCode: 'action_disabled' });
            }
            expect(writes).toEqual([]);
            expect(await db.artifact.count({ where: { accountId: account.id } })).toBe(artifactsBefore);
            expect(await db.accountApiToken.count({ where: { accountId: account.id } })).toBe(0);
        } finally { await home.close(); }
    });

});
