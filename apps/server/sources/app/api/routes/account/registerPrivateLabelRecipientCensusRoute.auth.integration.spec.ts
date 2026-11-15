import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { admitTeamMemberInTx } from '@/app/teams/memberships/membershipService';
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
            env: { HAPPIER_FEATURE_TEAMS__ENABLED: '1' },
        });
    }, 120_000);

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.team.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    afterAll(async () => {
        await harness.close();
    });

    it('keeps Account and Team label audiences within the authenticated author authority', async () => {
        const author = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const ownTeam = await db.team.create({ data: { name: 'Author Team' } });
        const otherTeam = await db.team.create({ data: { name: 'Other Team' } });
        for (const [teamId, accountId] of [[ownTeam.id, author.id], [otherTeam.id, other.id]] as const) {
            const admitted = await inTx(tx => admitTeamMemberInTx(tx, {
                teamId, accountId, role: 'owner', historyAccess: 'all_existing',
            }));
            expect(admitted.ok).toBe(true);
        }
        await withAuthenticatedTestApp(registerPrivateLabelRecipientCensusRoute, async app => {
            const census = (owner: unknown) => app.inject({ method: 'POST',
                url: '/v1/account/private-labels/recipient-census',
                headers: { 'x-test-user-id': author.id }, payload: { owner } });
            const own = await census({ kind: 'team', teamId: ownTeam.id });
            expect(own.statusCode, own.body).toBe(200);
            expect(own.json().contentEncryptionMode).toBe('plain');
            const foreignAccount = await census({ kind: 'account', accountId: other.id });
            const foreignTeam = await census({ kind: 'team', teamId: otherTeam.id });
            expect(foreignAccount.statusCode).toBe(403);
            expect(foreignTeam.statusCode).toBe(403);
        });
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
