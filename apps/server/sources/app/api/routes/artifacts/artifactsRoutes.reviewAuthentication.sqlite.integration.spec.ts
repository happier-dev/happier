import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { REVIEW_ARTIFACT_KIND_V1, ReviewArtifactBodyV1Schema, ReviewArtifactHeaderV1Schema } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { auth } from '@/app/auth/auth';
import { encryptIdentityProviderSecrets } from '@/app/auth/providers/managed/identityProviderSecretCipher';
import { readTeamAuthenticationConnectionDescriptorsInTx } from '@/app/auth/providers/identityProviderCatalog';
import { teamIdentityConnectionReferenceKey } from '@/app/teams/identity/teamIdentityConnectionLifecycle';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { projectSourceRoutes } from '@/app/api/routes/projects/projectSourceRoutes';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { artifactsRoutes } from './artifactsRoutes';

describe('Review create HTTP authentication (real SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'review-http-auth-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_PUBLIC_SERVER_URL: 'https://review-auth.example.test', HAPPIER_FEATURE_TEAMS__ENABLED: '1',
                HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST: 'server_sealed' } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('admits the accepted SSO credential and refuses missing or unaccepted evidence without creating a Review', async () => {
        const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Restricted Review Team', reviewCreationPolicy: 'team_required' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'owner' } });
        const providerId = randomUUID();
        await db.identityProviderInstance.create({ data: { id: providerId, ownerTeamId: team.id, kind: 'oidc',
            displayName: 'Review SSO', enabled: true, firstEnabledAt: new Date('2026-09-06T00:00:00Z'),
            config: { v: 1, kind: 'oidc', issuer: 'https://identity.example.test', clientId: 'happier',
                clientAuthenticationMethod: 'client_secret_post', scopes: 'openid profile email', httpTimeoutSeconds: 30,
                claims: { login: 'preferred_username', email: 'email', groups: 'groups' },
                allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
                fetchUserInfo: true, storeRefreshToken: false, ui: { buttonColor: null, iconHint: 'oidc' } },
            encryptedSecrets: encryptIdentityProviderSecrets({ id: providerId, kind: 'oidc',
                secrets: { v: 1, kind: 'oidc', clientSecret: 'disposable-review-fixture-secret' } }) } });
        const connection = await db.teamIdentityConnection.create({ data: { teamId: team.id, providerInstanceId: providerId,
            externalReference: { v: 1, kind: 'oidc' }, settings: { v: 1, kind: 'oidc', allowedUsers: [],
                allowedEmailDomains: [], groupsAny: [], groupsAll: [] }, enabled: true, firstEnabledAt: new Date() } });
        await db.team.update({ where: { id: team.id }, data: { authenticationPolicy: { v: 1, mode: 'restricted',
            accepted: [{ kind: 'team_connection', connectionId: connection.id }] } } });
        const identity = await db.accountIdentity.create({ data: { accountId: actor.id, provider: providerId,
            providerUserId: randomUUID(), eligibilityStatus: 'eligible' } });
        const source = await db.projectSource.create({ data: { name: 'Restricted Review Source', createdByAccountId: actor.id,
            owner: { kind: 'team', teamId: team.id }, audience: [], attachments: [] } });
        const descriptors = await inTx(tx => readTeamAuthenticationConnectionDescriptorsInTx(tx, {
            env: process.env, references: [{ teamId: team.id, id: connection.id }],
        }));
        const descriptor = descriptors.get(teamIdentityConnectionReferenceKey(connection));
        if (descriptor?.status !== 'ready' || !descriptor.descriptor) throw new Error('Expected usable SSO fixture');
        const accepted = await auth.createToken(actor.id, undefined, { kind: 'account', authority: 'present_user', authenticationEvidence: [{
            kind: 'provider', providerId, identityId: identity.id, teamConnectionId: connection.id,
            runtimeFingerprint: descriptor.descriptor.reference.runtimeFingerprint,
        }] });
        const missing = await auth.createToken(actor.id, undefined, { kind: 'account', authority: 'present_user' });
        const wrong = await auth.createToken(actor.id, undefined, { kind: 'account', authority: 'present_user',
            authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }] });
        await withAuthenticatedTestApp(app => { artifactsRoutes(app); projectSourceRoutes(app); }, async app => {
            const sourceRead = await app.inject({ method: 'GET', url: `/v1/projects/sources/${source.id}?serverId=home`,
                headers: { authorization: `Bearer ${accepted}` } });
            expect(sourceRead.statusCode, sourceRead.body).toBe(200);
            expect(sourceRead.json()).toMatchObject({ ok: true, source: { id: source.id } });
            const create = async (token: string) => {
                const id = randomUUID();
                const header = ReviewArtifactHeaderV1Schema.parse({ kind: REVIEW_ARTIFACT_KIND_V1, v: 1, reviewId: id, title: 'SSO Review' });
                const body = ReviewArtifactBodyV1Schema.parse({ v: 1, rounds: [{ ordinal: 1, state: 'running', startedAt: 10,
                    finishedAt: null, reviewerIds: [], runs: [] }] });
                const response = await app.inject({ method: 'POST', url: '/v1/artifacts', headers: {
                    authorization: `Bearer ${token}`, 'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
                }, payload: { id, kind: 'v1:other:review.v1', header: encodePlainArtifactStoredContent(header),
                    body: encodePlainArtifactStoredContent({ body: JSON.stringify(body) }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    reviewMetadata: { projectSourceId: source.id, workflowId: null, subjectKind: 'comparison', sourceKind: 'direct',
                        state: 'running', currentRoundOrdinal: 1, startedAt: 10, finishedAt: null } } });
                return { id, response };
            };
            for (const token of [missing, wrong]) {
                const { id, response } = await create(token);
                expect(response.statusCode, response.body).toBe(403);
                expect(response.json()).toEqual({ error: 'artifact_access_forbidden' });
                expect(await db.artifact.findUnique({ where: { id } })).toBeNull();
                expect(await db.reviewMetadata.findUnique({ where: { artifactId: id } })).toBeNull();
                expect(await db.artifactGrant.count({ where: { artifactId: id } })).toBe(0);
            }
            const { id, response } = await create(accepted);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ id, created: true });
            expect(await db.reviewMetadata.findUnique({ where: { artifactId: id } })).toMatchObject({ projectSourceId: source.id });
            expect(await db.artifactGrant.findMany({ where: { artifactId: id } })).toMatchObject([
                { principalKind: 'team', teamId: team.id, accessLevel: 'edit', requiredByTeamPolicy: true },
            ]);
        }, { authentication: 'real' });
    });
});
