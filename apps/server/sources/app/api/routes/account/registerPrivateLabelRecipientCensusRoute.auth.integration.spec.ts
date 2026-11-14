import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '../../testkit/sqliteFastify';

import {
    registerAccountDirectoryPrivateLabelRecipientCensusRoute,
    registerPrivateLabelRecipientCensusRoute,
} from './registerPrivateLabelRecipientCensusRoute';

describe('private-label recipient census route authentication', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-private-label-census-auth-',
            initAuth: false,
        });
    }, 120_000);

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.account.deleteMany(),
        ]);
    });

    afterAll(async () => {
        await harness.close();
    });

    it('runs the canonical authentication prehandler with the normal and Directory paths inverted closed', async () => {
        const account = await db.account.create({
            data: { encryptionMode: 'plain' },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            app => {
                registerPrivateLabelRecipientCensusRoute(app);
                registerAccountDirectoryPrivateLabelRecipientCensusRoute(app);
            },
            async app => {
                const request = (path: string, kind: 'account' | 'terminal' | 'account_directory', owner: unknown) => app.inject({
                    method: 'POST',
                    url: path,
                    headers: {
                        'content-type': 'application/json',
                        'x-test-user-id': account.id,
                        ...(kind === 'account' ? {} : { 'x-test-auth-token-kind': kind }),
                    },
                    payload: { owner },
                });

                const [normalAccount, normalTerminal, normalDirectory, directoryDirectory, directoryAccount, directoryTeam] = await Promise.all([
                    request('/v1/account/private-labels/recipient-census', 'account', { kind: 'account', accountId: account.id }),
                    request('/v1/account/private-labels/recipient-census', 'terminal', { kind: 'account', accountId: account.id }),
                    request('/v1/account/private-labels/recipient-census', 'account_directory', { kind: 'account', accountId: account.id }),
                    request('/v1/account-directory/private-labels/recipient-census', 'account_directory', { kind: 'account', accountId: account.id }),
                    request('/v1/account-directory/private-labels/recipient-census', 'account', { kind: 'account', accountId: account.id }),
                    request('/v1/account-directory/private-labels/recipient-census', 'account_directory', { kind: 'team', teamId: 'team-1' }),
                ]);

                expect(normalAccount.statusCode).toBe(200);
                expect(normalTerminal.statusCode).toBe(200);
                expect(normalDirectory.statusCode).toBe(403);
                expect(directoryDirectory.statusCode).toBe(200);
                expect(directoryAccount.statusCode).toBe(403);
                // This is handler-level denial after the Directory prehandler,
                // proving a Directory bearer cannot enumerate a Team audience.
                expect(directoryTeam.statusCode).toBe(403);
            },
        );
    });
});
