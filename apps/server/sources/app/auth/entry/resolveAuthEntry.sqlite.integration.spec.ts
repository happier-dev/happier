import { AuthEntryRequestV1Schema, FEATURES_RESPONSE_MAX_UTF8_BYTES_V1 } from '@happier-dev/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';

import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { registerAuthEntryRoute } from '@/app/api/routes/auth/registerAuthEntryRoute';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { inTx } from '@/storage/inTx';
import { createTeamInvitationInTx } from '@/app/teams/invitations/invitationLifecycle';
import { digestTeamInvitationToken } from '@/app/teams/invitations/token';
import {
    consumeNativeAuthOneTimeOperationInTx,
    issueNativeAuthOneTimeOperationInTx,
    readNativeAuthOneTimeOperation,
} from '@/app/auth/email/nativeAuthOneTimeOperations';
import { hashPasswordMaterial } from '@/app/auth/password/passwordMaterialVerifier';
import {
    acceptTeamInvitationPostAuthContinuationInTx,
    createTeamInvitationPostAuthContinuationInTx,
} from '@/app/teams/invitations/postAuthContinuation';

import { resolveAuthEntry } from './resolveAuthEntry';

const INVITATION_TOKEN = 'a'.repeat(43);
const MANAGED_OIDC_CONFIG = {
    v: 1,
    kind: 'oidc',
    issuer: 'https://id.example.test',
    clientId: 'happier',
    clientAuthenticationMethod: "client_secret_post",
    scopes: 'openid profile email',
    httpTimeoutSeconds: 30,
    claims: { login: 'preferred_username', email: 'email', groups: 'groups' },
    allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
    fetchUserInfo: true,
    storeRefreshToken: false,
    ui: { buttonColor: null, iconHint: 'oidc' },
} as const;

function oidcEntry(id: string): Record<string, unknown> {
    return {
        id,
        type: 'oidc',
        displayName: 'Acme identity',
        issuer: 'https://issuer.example.test',
        clientId: 'client-id-is-private',
        clientAuthenticationMethod: "client_secret_post",
        clientSecret: 'client-secret-is-private',
        redirectUrl: `https://home.example.test/v1/oauth/${id}/callback`,
    };
}

describe('resolveAuthEntry', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-auth-entry-',
            initAuth: true,
            initEncrypt: true,
            initFiles: false,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_FEATURE_TEAMS__ENABLED: 'true' },
        });
    }, 180_000);

    afterEach(async () => {
        harness.restoreEnv();
        await db.teamDirectorySource.deleteMany({});
        await db.teamIdentityConnection.deleteMany({});
        await db.identityProviderInstance.deleteMany({});
        await db.teamMembership.deleteMany({});
        await db.team.deleteMany({});
        await db.account.deleteMany({});
        await db.homeGovernancePolicy.deleteMany({});
        await db.repeatKey.deleteMany({});
    });

    async function member(
        teamId: string,
        overrides: Readonly<{
            status?: 'active' | 'suspended';
            accountStatus?: 'active' | 'disabled';
            name?: string;
            username?: string;
        }> = {},
    ) {
        const account = await db.account.create({
            data: {
                publicKey: crypto.randomUUID(),
                encryptionMode: 'plain',
                ...(overrides.name ? { name: overrides.name } : {}),
                ...(overrides.username ? { username: overrides.username } : {}),
                ...(overrides.accountStatus ? { status: overrides.accountStatus } : {}),
            },
        });
        await db.teamMembership.create({
            data: {
                teamId,
                accountId: account.id,
                role: 'member',
                ...(overrides.status ? { status: overrides.status } : {}),
            },
        });
        return account;
    }

    async function activeInvitation(authenticationPolicy?: Prisma.InputJsonValue) {
        const team = await db.team.create({ data: {
            name: 'Acme', ...(authenticationPolicy === undefined ? {} : { authenticationPolicy }),
        } });
        await inTx((tx) => createTeamInvitationInTx(tx, {
            teamId: team.id, role: 'member', historyAccess: 'from_membership',
            createdByAccountId: null, recipientEmailNormalized: 'invited@example.test',
            tokenHash: digestTeamInvitationToken(INVITATION_TOKEN), now: new Date(),
        }));
        return team;
    }

    function routeApp() {
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        registerAuthEntryRoute(app, { isEmailDeliveryReady: () => true });
        return app;
    }

    it('serves anonymous no-store entry and applies provisioning restrictions to the requesting address', async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: 'true',
            AUTH_ANONYMOUS_SIGNUP_ENABLED: 'true',
            HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS: 'key_challenge',
            HAPPIER_AUTH_PUBLIC_PROVISION_DENY_MODES: '*',
            HAPPIER_AUTH_PUBLIC_PROVISION_DENY_IP_CLASSES: 'public',
        });
        const app = routeApp();
        try {
            const entry = (remoteAddress: string) => app.inject({
                method: 'POST', url: '/v1/auth/entry', remoteAddress,
                payload: { v: 1, scope: { kind: 'home' } },
            });
            const privateEntry = await entry('127.0.0.1');
            expect(privateEntry.statusCode, privateEntry.body).toBe(200);
            expect(privateEntry.headers['cache-control']).toBe('no-store');
            expect(privateEntry.json()).toMatchObject({ state: 'ready', scope: { kind: 'home' } });
            expect(privateEntry.json().actions).toContainEqual(expect.objectContaining({ methodId: 'key_challenge', action: 'provision' }));
            const publicEntry = await entry('203.0.113.9');
            expect(publicEntry.statusCode, publicEntry.body).toBe(200);
            expect(publicEntry.json().actions).not.toContainEqual(expect.objectContaining({ methodId: 'key_challenge', action: 'provision' }));
        } finally {
            await app.close();
        }
    });

    it('discloses membership only to an eligible ordinary Account bearer through the real public route', async () => {
        const team = await db.team.create({ data: { name: 'Private membership' } });
        const account = await member(team.id);
        const ordinary = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const restricted = [
            await auth.createToken(account.id, undefined, { kind: 'account_directory', authority: 'present_user' }),
            await auth.createToken(account.id, undefined, { kind: 'terminal', authority: 'account_automation' }),
            (await auth.createApiToken({ accountId: account.id, tokenId: crypto.randomUUID(), label: 'Restricted entry' })).token,
            'invalid-bearer',
        ];
        const app = routeApp();
        try {
            const entry = (token?: string) => app.inject({
                method: 'POST', url: '/v1/auth/entry',
                ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
                payload: { v: 1, scope: { kind: 'team', teamId: team.id } },
            });
            const admitted = await entry(ordinary);
            expect(admitted.statusCode, admitted.body).toBe(200);
            expect(admitted.json()).toMatchObject({ state: 'already_member' });
            const anonymous = await entry();
            expect(anonymous.statusCode, anonymous.body).toBe(200);
            expect(anonymous.json().state).not.toBe('already_member');
            for (const token of restricted) {
                const result = await entry(token);
                expect(result.statusCode, result.body).toBe(200);
                expect(result.json()).toEqual(anonymous.json());
            }
            await db.account.update({ where: { id: account.id }, data: { status: 'disabled' } });
            const disabled = await entry(ordinary);
            expect(disabled.statusCode, disabled.body).toBe(200);
            expect(disabled.json()).toEqual(anonymous.json());
        } finally {
            await app.close();
        }
    });

    it('projects an immutable Team target from current Team and Home policy in one server owner', async () => {
        const team = await db.team.create({
            data: {
                name: 'Acme Team',
                authenticationPolicy: {
                    v: 1,
                    mode: 'restricted',
                    accepted: [{ kind: 'home_method', methodId: 'email_password' }],
                },
            },
        });

        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: team.id } },
            {
                env: {
                    HAPPIER_FEATURE_TEAMS__ENABLED: '1',
                    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
                },
            },
        );

        expect(projection).toMatchObject({
            v: 1,
            state: 'admission_required',
            scope: { kind: 'team' },
            team: { teamId: team.id, name: 'Acme Team', logo: null },
            autoRedirect: null,
        });
        if (projection.state !== 'admission_required') throw new Error('expected Team admission');
        expect(projection.actions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'authenticate',
                methodId: 'email_password',
                origin: 'home',
            }),
        ]));
    });

    it('offers a signed-in non-member another Account, and names directory delay on a provisioned Team', async () => {
        // Signed in as the wrong Account is the common way a Team link fails:
        // the person has an Account, it simply is not the one the Team admits.
        // Outside an invitation the Team surface had no way to say that, so the
        // only offers were sign-in methods the current credential already used.
        const restricted = await db.team.create({
            data: {
                name: 'Acme Team',
                authenticationPolicy: {
                    v: 1,
                    mode: 'restricted',
                    accepted: [{ kind: 'home_method', methodId: 'email_password' }],
                },
            },
        });
        const stranger = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' },
        });
        const env = {
            HAPPIER_FEATURE_TEAMS__ENABLED: '1',
            HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
        } as const;

        const wrongAccount = await resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: restricted.id } },
            { env, principal: { accountId: stranger.id } },
        );
        if (wrongAccount.state !== 'admission_required') throw new Error('expected Team admission');
        expect(wrongAccount.actions).toContainEqual({ kind: 'switch_account' });

        // An anonymous visitor has no other Account to offer, and proving one
        // exists would make this public endpoint an Account oracle.
        const anonymous = await resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: restricted.id } },
            { env },
        );
        if (anonymous.state !== 'admission_required') throw new Error('expected Team admission');
        expect(anonymous.actions).not.toContainEqual({ kind: 'switch_account' });

        // A provisioned Team's membership arrives from its directory. Telling a
        // signed-in visitor to try another sign-in method would be false: there
        // is nothing they can do but wait for the directory to catch up.
        const provisioned = await db.team.create({
            data: {
                name: 'Provisioned',
                admissionMode: 'provisioned',
                authenticationPolicy: { v: 1, mode: 'restricted', accepted: [] },
            },
        });
        const delayed = await resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: provisioned.id } },
            { env, principal: { accountId: stranger.id } },
        );
        expect(delayed).toMatchObject({ state: 'unavailable', reason: 'directory_delayed' });
    });

    it.each(['inherit', 'password'] as const)('offers a provisioned non-member only a directory-binding connection under %s authentication', async (authentication) => {
        // teams-lane-03/02 §8.1 / TA-R19: an existing Account imported by the
        // directory before it signed up proves the Team provider identity through
        // the authenticated connect flow, and the exact binder admits it. Only a
        // connection whose directory source can currently bind is such a proof;
        // otherwise waiting for the directory is the truthful answer.
        const previousTeamsBit = process.env.HAPPIER_FEATURE_TEAMS__ENABLED;
        process.env.HAPPIER_FEATURE_TEAMS__ENABLED = '1';
        try {
            const env = {
                HAPPIER_FEATURE_TEAMS__ENABLED: '1',
                HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test',
                WORKOS_API_KEY: 'sk_test',
                WORKOS_CLIENT_ID: 'client_test',
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            } as const;
            const team = await db.team.create({ data: {
                name: 'Directory Team', admissionMode: 'provisioned',
                ...(authentication === 'password' ? { authenticationPolicy: {
                    v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'email_password' }],
                } } : {}),
            } });
            const workos = await db.identityProviderInstance.create({ data: {
                ownerTeamId: team.id, kind: 'workos_sso', displayName: 'Company SSO', enabled: true,
                firstEnabledAt: new Date('2026-09-06T00:00:00.000Z'), config: { v: 1, kind: 'workos_sso' },
            } });
            const workosConnection = await db.teamIdentityConnection.create({ data: {
                teamId: team.id, providerInstanceId: workos.id, enabled: true,
                firstEnabledAt: new Date('2026-09-06T00:00:00.000Z'),
                externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org_exact', connectionId: 'conn_exact' },
                settings: { v: 1, kind: 'workos_sso' },
            } });
            // A plain OIDC connection can never bind a directory person.
            const oidc = await db.identityProviderInstance.create({ data: {
                ownerTeamId: team.id, kind: 'oidc', displayName: 'Other SSO', enabled: true,
                firstEnabledAt: new Date('2026-09-06T00:00:00.000Z'), config: MANAGED_OIDC_CONFIG,
            } });
            await db.teamIdentityConnection.create({ data: {
                teamId: team.id, providerInstanceId: oidc.id, enabled: true,
                firstEnabledAt: new Date('2026-09-06T00:00:00.000Z'),
                externalReference: { v: 1, kind: 'oidc' },
                settings: { v: 1, kind: 'oidc', allowedUsers: [], allowedEmailDomains: [], groupsAny: [], groupsAll: [] },
            } });
            const source = await db.teamDirectorySource.create({ data: {
                teamId: team.id, kind: 'workos_directory', state: 'initializing', displayName: 'Directory',
                externalSourceKey: 'directory_entry', bindingConfig: { v: 1, kind: 'workos_directory' },
                teamIdentityConnectionId: workosConnection.id,
                activeReconcileRunId: 'first-import', activeReconcileStartedAt: new Date(),
            } });
            const account = await db.account.create({
                data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' },
            });
            const entry = () => resolveAuthEntry(
                { v: 1, scope: { kind: 'team', teamId: team.id } },
                { env, principal: { accountId: account.id } },
            );

            // The first import is still running: nothing can bind yet.
            await expect(entry()).resolves.toMatchObject({ state: 'unavailable', reason: 'directory_delayed' });

            await db.teamDirectorySource.update({
                where: { id: source.id },
                data: {
                    state: 'active', activeReconcileRunId: null, activeReconcileStartedAt: null,
                    lastSuccessAt: new Date(), lastFullReconcileAt: new Date(),
                },
            });
            const offered = await entry();
            if (offered.state !== 'admission_required') throw new Error(`expected admission, got ${JSON.stringify(offered)}`);
            const authenticate = offered.actions.filter((action) => action.kind === 'authenticate');
            expect(authenticate).toEqual([expect.objectContaining({
                methodId: workos.id, action: 'connect', origin: 'team',
                presentation: expect.objectContaining({ providerKind: 'workos_sso' }),
            })]);
            expect(offered.actions).toContainEqual({ kind: 'switch_account' });

            // A paused directory cannot bind either.
            await db.teamDirectorySource.update({ where: { id: source.id }, data: { state: 'paused' } });
            await expect(entry()).resolves.toMatchObject({ state: 'unavailable', reason: 'directory_delayed' });
        } finally {
            if (previousTeamsBit === undefined) delete process.env.HAPPIER_FEATURE_TEAMS__ENABLED;
            else process.env.HAPPIER_FEATURE_TEAMS__ENABLED = previousTeamsBit;
        }
    });

    it('names directory delay for a signed-in non-member of a provisioned Team whose policy is usable', async () => {
        // A `provisioned` Team takes its roster from a directory, so no sign-in
        // this visitor performs can admit them. That is true whether or not the
        // Team's own authentication policy happens to be usable, and the
        // previous reading only reached it when the policy was unusable.
        const provisioned = await db.team.create({
            data: { name: 'Directory Team', admissionMode: 'provisioned', authenticationPolicy: undefined },
        });
        const stranger = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' },
        });
        const member = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' },
        });
        const env = {
            HAPPIER_FEATURE_TEAMS__ENABLED: '1',
            HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
        } as const;

        const delayed = await resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: provisioned.id } },
            { env, principal: { accountId: stranger.id } },
        );
        expect(delayed).toMatchObject({ state: 'unavailable', reason: 'directory_delayed' });

        // An anonymous visitor has proved nothing about themselves, so they get
        // the ordinary admission page every Team shows and no statement about
        // membership. Naming a directory delay here would make the public
        // endpoint say something about an Account that was never presented.
        const anonymous = await resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: provisioned.id } },
            { env },
        );
        if (anonymous.state !== 'admission_required') throw new Error('expected Team admission');
        expect(anonymous.actions).not.toContainEqual({ kind: 'switch_account' });

        // A member whose current credential does not qualify is a different
        // case: signing in with the accepted method does admit them, so the
        // sign-in actions stay.
        const restrictedProvisioned = await db.team.create({
            data: {
                name: 'Directory Team restricted',
                admissionMode: 'provisioned',
                authenticationPolicy: {
                    v: 1,
                    mode: 'restricted',
                    accepted: [{ kind: 'home_method', methodId: 'email_password' }],
                },
            },
        });
        await db.teamMembership.create({
            data: { teamId: restrictedProvisioned.id, accountId: member.id, role: 'member' },
        });
        const unqualifiedMember = await resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: restrictedProvisioned.id } },
            { env, principal: { accountId: member.id } },
        );
        if (unqualifiedMember.state !== 'admission_required') throw new Error('expected Team admission');
        expect(unqualifiedMember.actions).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'authenticate', methodId: 'email_password', origin: 'home' }),
        ]));
    });

    it('keeps unknown and archived Team targets non-enumerating', async () => {
        const archived = await db.team.create({
            data: { name: 'Do not disclose', archivedAt: new Date('2026-09-06T00:00:00.000Z') },
        });
        const unavailable = (teamId: string) => resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId } },
            { env: { HAPPIER_FEATURE_TEAMS__ENABLED: '1' } },
        );
        const expected = {
            v: 1,
            state: 'unavailable',
            scope: { kind: 'team' },
            reason: 'entry_not_available',
            autoRedirect: null,
        } as const;

        await expect(unavailable('missing-team')).resolves.toEqual(expected);
        await expect(unavailable(archived.id)).resolves.toEqual(expected);
    });

    it('projects a current Team-bound provider from the canonical Team catalog', async () => {
        // A fresh Home inherits the deployment ceiling; no narrowed row is seeded.
        const team = await db.team.create({ data: { name: 'Provider Team' } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: 'oidc',
                displayName: 'Provider Team SSO',
                enabled: true,
                firstEnabledAt: new Date('2026-09-06T00:00:00.000Z'),
                config: MANAGED_OIDC_CONFIG,
            },
        });
        await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: { v: 1, kind: 'oidc' },
                settings: {
                    v: 1,
                    kind: 'oidc',
                    allowedUsers: [],
                    allowedEmailDomains: [],
                    groupsAny: [],
                    groupsAll: [],
                },
                enabled: true,
                firstEnabledAt: new Date('2026-09-06T00:00:00.000Z'),
            },
        });

        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: team.id } },
            {
                env: {
                    HAPPIER_FEATURE_TEAMS__ENABLED: '1',
                    HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test',
                },
            },
        );

        expect(projection.state).toBe('admission_required');
        expect(projection).not.toHaveProperty('account');
        if (projection.state !== 'admission_required') throw new Error('expected Team admission');
        expect(projection.actions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'authenticate',
                methodId: provider.id,
                action: 'connect',
                origin: 'team',
                presentation: expect.objectContaining({ displayName: 'Provider Team SSO' }),
            }),
        ]));
    });

    it('carries the safe descriptor fields and names an accepted provider that cannot run yet', async () => {
        // teams-lane-03/01 §10.2: provider kind, icon, connect-button colour, badge
        // support and a per-provider safe unavailable reason are real wire fields.
        const team = await db.team.create({ data: { name: 'Descriptor Team' } });
        const connected = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: 'oidc',
                displayName: 'Descriptor SSO',
                enabled: true,
                firstEnabledAt: new Date('2026-09-06T00:00:00.000Z'),
                config: { ...MANAGED_OIDC_CONFIG, ui: { buttonColor: '#0f62fe', iconHint: 'oidc' } },
            },
        });
        const drafting = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: 'oidc',
                displayName: 'Backup SSO',
                enabled: true,
                config: MANAGED_OIDC_CONFIG,
            },
        });
        const oidcSettings = {
            v: 1, kind: 'oidc', allowedUsers: [], allowedEmailDomains: [], groupsAny: [], groupsAll: [],
        } as const;
        const connectedConnection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: connected.id,
                externalReference: { v: 1, kind: 'oidc' },
                settings: oidcSettings,
                enabled: true,
                firstEnabledAt: new Date('2026-09-06T00:00:00.000Z'),
            },
        });
        const draftConnection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: drafting.id,
                externalReference: { v: 1, kind: 'oidc' },
                settings: oidcSettings,
            },
        });
        await db.team.update({
            where: { id: team.id },
            data: {
                authenticationPolicy: {
                    v: 1,
                    mode: 'restricted',
                    accepted: [
                        { kind: 'team_connection', connectionId: connectedConnection.id },
                        { kind: 'team_connection', connectionId: draftConnection.id },
                    ],
                },
            },
        });

        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: team.id } },
            { env: { HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test' } },
        );

        if (projection.state !== 'admission_required') throw new Error(`expected Team admission, got ${JSON.stringify(projection)}`);
        expect(projection.actions).toEqual(expect.arrayContaining([
            {
                kind: 'authenticate',
                methodId: connected.id,
                action: 'connect',
                mode: 'either',
                origin: 'team',
                presentation: {
                    displayName: 'Descriptor SSO',
                    iconHint: 'oidc',
                    providerKind: 'oidc',
                    connectButtonColor: '#0f62fe',
                    supportsProfileBadge: false,
                },
            },
            {
                kind: 'provider_unavailable',
                methodId: drafting.id,
                origin: 'team',
                presentation: { displayName: 'Backup SSO', providerKind: 'oidc' },
                reason: 'provider_setup_incomplete',
            },
        ]));
        expect(JSON.stringify(projection)).not.toContain('revision');
    });

    it('never reveals membership to an anonymous Team entry request', async () => {
        const team = await db.team.create({ data: { name: 'Acme Team' } });
        await member(team.id);

        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: team.id } },
            {
                env: {
                    HAPPIER_FEATURE_TEAMS__ENABLED: '1',
                    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
                },
            },
        );

        expect(projection.state).toBe('admission_required');
        expect(projection).not.toHaveProperty('account');
    });

    it('continues an effective member of an inherited-policy Team without another login', async () => {
        const team = await db.team.create({ data: { name: 'Acme Team' } });
        const account = await member(team.id, { name: 'Alice', username: 'alice' });

        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: team.id } },
            {
                env: {
                    HAPPIER_FEATURE_TEAMS__ENABLED: '1',
                    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
                    HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test',
                },
                principal: { accountId: account.id },
            },
        );

        expect(projection).toEqual({
            v: 1,
            state: 'already_member',
            scope: { kind: 'team' },
            home: { serverId: expect.any(String), displayName: 'home.example.test', storageMode: 'encrypted', hosting: null },
            account: { name: 'Alice', firstName: 'Alice', lastName: null, username: 'alice', avatarUrl: null },
            team: { teamId: team.id, name: 'Acme Team', logo: null },
            actions: [{ kind: 'continue' }],
            autoRedirect: null,
        });
    });

    it('projects the exact authenticated Account on admission and changes it when the credential changes', async () => {
        const team = await db.team.create({ data: { name: 'Acme Team' } });
        const alice = await db.account.create({ data: {
            publicKey: crypto.randomUUID(), encryptionMode: 'plain', name: 'Alice', username: 'alice',
        } });
        const bob = await db.account.create({ data: {
            publicKey: crypto.randomUUID(), encryptionMode: 'plain', name: 'Bob', username: 'bob',
        } });
        const env = {
            HAPPIER_FEATURE_TEAMS__ENABLED: '1',
            HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
            HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test',
        };

        const entryFor = (accountId: string) => resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: team.id } },
            { env, principal: { accountId } },
        );

        await expect(entryFor(alice.id)).resolves.toMatchObject({
            state: 'admission_required',
            home: { displayName: 'home.example.test' },
            account: { name: 'Alice', firstName: 'Alice', username: 'alice' },
        });
        await expect(entryFor(bob.id)).resolves.toMatchObject({
            state: 'admission_required',
            home: { displayName: 'home.example.test' },
            account: { name: 'Bob', firstName: 'Bob', username: 'bob' },
        });
        await expect(resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: team.id } },
            { env },
        )).resolves.not.toHaveProperty('account');
    });

    it('keeps every non-effective authenticated caller on ordinary admission', async () => {
        const team = await db.team.create({ data: { name: 'Acme Team' } });
        const otherTeam = await db.team.create({ data: { name: 'Other Team' } });
        const nonMember = await db.account.create({
            data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' },
        });
        const suspended = await member(team.id, { status: 'suspended' });
        const disabled = await member(team.id, { accountStatus: 'disabled' });
        const otherTeamMember = await member(otherTeam.id);

        const entryFor = async (accountId: string) => await resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: team.id } },
            {
                env: {
                    HAPPIER_FEATURE_TEAMS__ENABLED: '1',
                    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
                },
                principal: { accountId },
            },
        );

        for (const accountId of [nonMember.id, suspended.id, disabled.id, otherTeamMember.id]) {
            await expect(entryFor(accountId).then((projection) => projection.state))
                .resolves.toBe('admission_required');
        }
    });

    it('holds a restricted-policy Team closed for a member until credential evidence exists', async () => {
        const team = await db.team.create({
            data: {
                name: 'Restricted Team',
                authenticationPolicy: {
                    v: 1,
                    mode: 'restricted',
                    accepted: [{ kind: 'home_method', methodId: 'email_password' }],
                },
            },
        });
        const account = await member(team.id);

        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: team.id } },
            {
                env: {
                    HAPPIER_FEATURE_TEAMS__ENABLED: '1',
                    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
                },
                principal: { accountId: account.id },
            },
        );

        // The Team is reachable and its accepted method is usable, so this is a
        // policy decision rather than an unavailable Team: membership alone must
        // not continue while nothing can prove how this credential authenticated.
        expect(projection.state).toBe('admission_required');
        if (projection.state !== 'admission_required') throw new Error('expected Team admission');
        expect(projection.actions).toEqual(expect.arrayContaining([
            expect.objectContaining({ methodId: 'email_password', origin: 'home' }),
        ]));
    });

    it('continues a restricted-policy member only while the exact Account owns the evidenced Home factor', async () => {
        const team = await db.team.create({
            data: {
                name: 'Restricted Evidence Team',
                authenticationPolicy: {
                    v: 1,
                    mode: 'restricted',
                    accepted: [{ kind: 'home_method', methodId: 'email_password' }],
                },
            },
        });
        const account = await member(team.id);
        const otherAccount = await db.account.create({
            data: { publicKey: null, encryptionMode: 'plain' },
        });
        await db.accountIdentity.create({
            data: {
                accountId: otherAccount.id,
                provider: 'email',
                providerUserId: 'other-factor@example.test',
                profile: {},
            },
        });
        await db.accountPasswordCredential.create({
            data: {
                accountId: otherAccount.id,
                credential: {
                    v: 1,
                    kind: 'plain_password_hash',
                    hash: await hashPasswordMaterial(new TextEncoder().encode('other Account password factor')),
                },
            },
        });

        const context = {
            env: {
                HAPPIER_FEATURE_TEAMS__ENABLED: '1',
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
                HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            },
            principal: {
                accountId: account.id,
                authenticationEvidence: [{ kind: 'home_method' as const, methodId: 'email_password' }],
            },
        };

        // A viable password factor on another Account cannot make this
        // credential's claimed method current.
        await expect(resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: team.id } },
            context,
        )).resolves.toMatchObject({ state: 'admission_required' });

        await db.accountIdentity.create({
            data: {
                accountId: account.id,
                provider: 'email',
                providerUserId: 'member-factor@example.test',
                profile: {},
            },
        });
        await db.accountPasswordCredential.create({
            data: {
                accountId: account.id,
                credential: {
                    v: 1,
                    kind: 'plain_password_hash',
                    hash: await hashPasswordMaterial(new TextEncoder().encode('member password factor')),
                },
            },
        });
        const membershipBefore = await db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        });

        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: team.id } },
            context,
        );

        expect(projection).toEqual({
            v: 1,
            state: 'already_member',
            scope: { kind: 'team' },
            home: { serverId: expect.any(String), displayName: null, storageMode: null, hosting: null },
            account: { name: null, firstName: null, lastName: null, username: null, avatarUrl: null },
            team: { teamId: team.id, name: 'Restricted Evidence Team', logo: null },
            actions: [{ kind: 'continue' }],
            autoRedirect: null,
        });
        expect(await db.teamMembership.findUniqueOrThrow({
            where: { teamId_accountId: { teamId: team.id, accountId: account.id } },
        })).toEqual(membershipBefore);
    });

    afterAll(async () => {
        if (harness) await harness.close();
    });

    it('projects an active invitation through the Home method owner without exposing invitation authority', async () => {
        const team = await activeInvitation();
        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'invitation', token: INVITATION_TOKEN } },
            {
                env: {
                    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
                    HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: 'self',
                    HAPPIER_FEATURE_ACCOUNT_DIRECTORY__ENABLED: '1',
                },
            },
        );

        expect(projection).toMatchObject({
            v: 1,
            state: 'admission_required',
            scope: { kind: 'invitation' },
            team: { teamId: team.id, name: 'Acme', logo: null },
            invitationEmailVerificationRequired: false,
            autoRedirect: null,
        });
        if (projection.state !== 'admission_required') throw new Error('expected invitation admission');
        expect(projection.actions).toEqual(expect.arrayContaining([
            expect.objectContaining({ methodId: 'email_password', action: 'login', origin: 'home' }),
        ]));
        expect(JSON.stringify(projection)).not.toContain(INVITATION_TOKEN);
        expect(JSON.stringify(projection)).not.toContain('role');
        expect(JSON.stringify(projection)).not.toContain('historyAccess');
        expect(JSON.stringify(projection)).not.toContain('recipientEmail');
        expect(projection).not.toHaveProperty('currentAccountRecipientStatus');
    });

    it('projects whether the addressed invitation mailbox is already verified by this Account', async () => {
        await activeInvitation();
        const account = await db.account.create({ data: {
            publicKey: crypto.randomUUID(),
            encryptionMode: 'plain',
        } });
        const context = {
            env: {
                HAPPIER_FEATURE_TEAMS__ENABLED: '1',
                HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
            },
            principal: { accountId: account.id },
        } as const;

        const before = await resolveAuthEntry(
            { v: 1, scope: { kind: 'invitation', token: INVITATION_TOKEN } },
            context,
        );
        expect(before).toMatchObject({
            currentAccountRecipientStatus: 'verification_required',
            actions: expect.arrayContaining([{ kind: 'switch_account' }]),
        });
        expect(JSON.stringify(before)).not.toContain('invited@example.test');

        await db.accountEmail.create({ data: {
            accountId: account.id,
            address: 'Invited@Example.Test',
            normalizedEmail: 'invited@example.test',
        } });
        const after = await resolveAuthEntry(
            { v: 1, scope: { kind: 'invitation', token: INVITATION_TOKEN } },
            context,
        );
        expect(after).toMatchObject({ currentAccountRecipientStatus: 'already_verified' });
        if (after.state !== 'admission_required') throw new Error('expected invitation admission');
        expect(after.actions).not.toContainEqual({ kind: 'switch_account' });
    });

    it('projects an unqualified effective member as already admitted without consuming the invitation', async () => {
        const team = await activeInvitation({ v: 1, mode: 'restricted', accepted: [] });
        const account = await member(team.id);

        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'invitation', token: INVITATION_TOKEN } },
            {
                env: {
                    HAPPIER_FEATURE_TEAMS__ENABLED: '1',
                    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
                },
                principal: { accountId: account.id },
            },
        );

        expect(projection).toEqual({
            v: 1,
            state: 'already_member',
            scope: { kind: 'invitation' },
            home: { serverId: expect.any(String), displayName: null, storageMode: 'encrypted', hosting: null },
            account: { name: null, firstName: null, lastName: null, username: null, avatarUrl: null },
            team: { teamId: team.id, name: 'Acme', logo: null },
            actions: [{ kind: 'continue' }],
            autoRedirect: null,
        });
        expect(await db.teamInvitation.findFirstOrThrow({
            where: { tokenHash: Uint8Array.from(digestTeamInvitationToken(INVITATION_TOKEN)) },
        })).toMatchObject({ acceptedAt: null, acceptedByAccountId: null });
    });

    it('offers Home-allowed invitation admission independently of protected Team authentication', async () => {
        const team = await activeInvitation({ v: 1, mode: 'restricted', accepted: [] });
        const account = await db.account.create({ data: {
            publicKey: crypto.randomUUID(), encryptionMode: 'plain',
        } });
        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'invitation', token: INVITATION_TOKEN } },
            {
                env: {
                    HAPPIER_FEATURE_TEAMS__ENABLED: '1',
                    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
                },
                principal: { accountId: account.id },
            },
        );
        expect(projection).toMatchObject({
            state: 'admission_required',
            scope: { kind: 'invitation' },
            currentAccountRecipientStatus: 'verification_required',
            actions: expect.arrayContaining([
                expect.objectContaining({ methodId: 'email_password', action: 'login', origin: 'home' }),
                { kind: 'switch_account' },
            ]),
        });
        // The invitation entry admits structure, not a credential for protected
        // Team work: the normal Team entry remains closed by its current policy.
        await expect(resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: team.id } },
            { env: { HAPPIER_FEATURE_TEAMS__ENABLED: '1' }, principal: { accountId: account.id } },
        )).resolves.toMatchObject({ state: 'unavailable' });
        expect(await db.teamMembership.count({ where: { teamId: team.id } })).toBe(0);
    });

    it('reads the current invitation offer and mailbox consent through only its bound post-auth Account', async () => {
        const team = await activeInvitation();
        const account = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { publicKey: crypto.randomUUID(), encryptionMode: 'plain' } });
        const invitation = await db.teamInvitation.findFirstOrThrow({ where: { teamId: team.id } });
        const continuation = await inTx((tx) => createTeamInvitationPostAuthContinuationInTx(tx, {
            accountId: account.id,
            teamId: team.id,
            invitationId: invitation.id,
            tokenHash: Buffer.from(invitation.tokenHash).toString('hex'),
            expiresAt: invitation.expiresAt,
        }));
        const request = AuthEntryRequestV1Schema.parse({
            v: 1, scope: { kind: 'invitation', continuation },
        });
        const env = { HAPPIER_FEATURE_TEAMS__ENABLED: '1' };
        const entry = await resolveAuthEntry(request, { env, principal: { accountId: account.id } });
        expect(entry).toMatchObject({
            state: 'admission_required',
            scope: { kind: 'invitation' },
            currentAccountRecipientStatus: 'verification_required',
            preview: {
                team: { teamId: team.id }, role: 'member', historyAccess: 'from_membership',
                recipientEmailMask: 'i•••@example.test', state: 'active',
            },
        });
        expect(JSON.stringify(entry)).not.toContain(INVITATION_TOKEN);
        expect(JSON.stringify(entry)).not.toContain(Buffer.from(invitation.tokenHash).toString('hex'));
        for (const principal of [undefined, { accountId: other.id }]) {
            await expect(resolveAuthEntry(request, { env, principal })).resolves.toEqual({
                v: 1, state: 'unavailable', scope: { kind: 'invitation' },
                reason: 'invitation_unavailable', autoRedirect: null,
            });
        }
        expect(await db.repeatKey.findUnique({ where: { key: continuation.reference } })).not.toBeNull();
        expect(await db.teamInvitation.findUnique({ where: { id: invitation.id } })).toMatchObject({ acceptedAt: null });
        await db.teamInvitation.update({ where: { id: invitation.id }, data: { revokedAt: new Date() } });
        await expect(resolveAuthEntry(request, { env, principal: { accountId: account.id } }))
            .resolves.toMatchObject({ state: 'unavailable', reason: 'invitation_unavailable' });
        await db.teamInvitation.update({ where: { id: invitation.id }, data: { revokedAt: null } });
        await expect(inTx((tx) => acceptTeamInvitationPostAuthContinuationInTx(tx, {
            continuation, accountId: account.id,
        }))).resolves.toMatchObject({ outcome: 'joined', teamId: team.id });
        expect(await db.repeatKey.findUnique({ where: { key: continuation.reference } })).toBeNull();
    });

    it('projects transferable invitation mailbox verification as a server-owned admission fact', async () => {
        await activeInvitation();
        await db.teamInvitation.updateMany({
            where: { tokenHash: Uint8Array.from(digestTeamInvitationToken(INVITATION_TOKEN)) },
            data: { recipientEmailNormalized: null },
        });

        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'invitation', token: INVITATION_TOKEN } },
            { env: { HAPPIER_FEATURE_TEAMS__ENABLED: '1', HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1' } },
        );

        expect(projection).toMatchObject({ invitationEmailVerificationRequired: true });
    });

    it('resolves a fresh-document verification bearer through its current transferable invitation context', async () => {
        const team = await activeInvitation();
        await db.teamInvitation.updateMany({
            where: { tokenHash: Uint8Array.from(digestTeamInvitationToken(INVITATION_TOKEN)) },
            data: { recipientEmailNormalized: null },
        });
        await db.homeGovernancePolicy.create({ data: {
            id: 'home',
            authenticationPolicy: {
                v: 1,
                enabledMethodIds: ['email_password'],
                admission: 'invitation_only',
            },
        } });
        const issued = await inTx(async (tx) => issueNativeAuthOneTimeOperationInTx(tx, {
            v: 1,
            purpose: 'verify_native_email',
            normalizedEmail: 'person@example.test',
            consumer: {
                kind: 'team_invitation',
                invitationId: (await tx.teamInvitation.findFirstOrThrow({
                    where: { teamId: team.id }, select: { id: true },
                })).id,
                tokenHash: Buffer.from(digestTeamInvitationToken(INVITATION_TOKEN)).toString('hex'),
                teamId: team.id,
            },
        }));

        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'native_email_verification', token: issued.rawBearer } },
            {
                env: {
                    HAPPIER_FEATURE_TEAMS__ENABLED: '1',
                    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
                    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__PROVISION_ENABLED: '1',
                },
                emailDeliveryReady: true,
            },
        );

        expect(projection).toMatchObject({
            state: 'admission_required',
            scope: { kind: 'invitation' },
            team: { teamId: team.id },
            actions: expect.arrayContaining([
                expect.objectContaining({ methodId: 'email_password', action: 'provision' }),
            ]),
        });
        expect(JSON.stringify(projection)).not.toContain(issued.rawBearer);
        expect(JSON.stringify(projection)).not.toContain(INVITATION_TOKEN);
        expect(JSON.stringify(projection)).not.toContain('tokenHash');
        expect(JSON.stringify(projection)).not.toContain('invitationId');

        await db.teamInvitation.updateMany({
            where: { teamId: team.id }, data: { revokedAt: new Date() },
        });
        // The bearer is still valid, so the refusal is about the invitation and
        // names itself; the bearer itself is untouched.
        await expect(resolveAuthEntry(
            { v: 1, scope: { kind: 'native_email_verification', token: issued.rawBearer } },
            { env: { HAPPIER_FEATURE_TEAMS__ENABLED: '1' }, emailDeliveryReady: true },
        )).resolves.toEqual({
            v: 1,
            state: 'unavailable',
            scope: { kind: 'invitation' },
            reason: 'invitation_unavailable',
            autoRedirect: null,
        });
        expect(await inTx((tx) => readNativeAuthOneTimeOperation(tx, {
            purpose: 'verify_native_email', token: issued.rawBearer,
        }))).not.toBeNull();
        expect(await db.account.count()).toBe(0);
        expect(await db.teamMembership.count()).toBe(0);

        await db.teamInvitation.updateMany({
            where: { teamId: team.id }, data: { revokedAt: null },
        });

        await inTx((tx) => consumeNativeAuthOneTimeOperationInTx(tx, {
            purpose: 'verify_native_email', token: issued.rawBearer,
        }));
        await expect(resolveAuthEntry(
            { v: 1, scope: { kind: 'native_email_verification', token: issued.rawBearer } },
            { env: { HAPPIER_FEATURE_TEAMS__ENABLED: '1' }, emailDeliveryReady: true },
        )).resolves.toEqual({
            v: 1,
            state: 'unavailable',
            scope: { kind: 'invitation' },
            reason: 'entry_not_available',
            autoRedirect: null,
        });
        expect(await db.account.count()).toBe(0);
        expect(await db.teamMembership.count()).toBe(0);
    });

    it('answers every unusable invitation identically and keeps a disabled Home opaque', async () => {
        const unusable = {
            v: 1,
            state: 'unavailable',
            scope: { kind: 'invitation' },
            reason: 'invitation_unavailable',
            autoRedirect: null,
        } as const;
        const read = (env: NodeJS.ProcessEnv) => resolveAuthEntry(
            { v: 1, scope: { kind: 'invitation', token: INVITATION_TOKEN } },
            { env },
        );

        // Never issued, revoked and already consumed are one answer, so the
        // reason can never be used to enumerate which invitations exist.
        await expect(read({})).resolves.toEqual(unusable);
        const team = await activeInvitation();
        await db.teamInvitation.updateMany({ where: { teamId: team.id }, data: { revokedAt: new Date() } });
        await expect(read({})).resolves.toEqual(unusable);
        await db.teamInvitation.updateMany({
            where: { teamId: team.id },
            data: { revokedAt: null, acceptedAt: new Date() },
        });
        await expect(read({})).resolves.toEqual(unusable);

        // A Home that does not run Teams at all has not let this request see any
        // destination, so its refusal stays the non-enumerating default.
        await db.teamInvitation.updateMany({ where: { teamId: team.id }, data: { acceptedAt: null } });
        await expect(read({ HAPPIER_FEATURE_TEAMS__ENABLED: '0' })).resolves.toEqual({
            v: 1,
            state: 'unavailable',
            scope: { kind: 'invitation' },
            reason: 'entry_not_available',
            autoRedirect: null,
        });
    });

    it('keeps structural invitation admission available when a Team connection is unavailable', async () => {
        await activeInvitation({
            v: 1, mode: 'restricted',
            accepted: [{ kind: 'team_connection', connectionId: 'connection-1' }],
        });
        await expect(resolveAuthEntry(
            { v: 1, scope: { kind: 'invitation', token: INVITATION_TOKEN } },
            {
                env: {},
            },
        )).resolves.toMatchObject({
            v: 1,
            state: 'admission_required',
            scope: { kind: 'invitation' },
            autoRedirect: null,
        });
    });

    it('passes invitation admission through the canonical restricted Home-method decision', async () => {
        await activeInvitation({
            v: 1,
            mode: 'restricted',
            accepted: [{ kind: 'home_method', methodId: 'email_password' }],
        });
        await db.homeGovernancePolicy.create({ data: {
            id: 'home',
            authenticationPolicy: {
                v: 1,
                enabledMethodIds: ['email_password'],
                admission: 'invitation_only',
            },
        } });
        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'invitation', token: INVITATION_TOKEN } },
            {
                env: {
                    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
                    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__PROVISION_ENABLED: '1',
                },
                emailDeliveryReady: true,
            },
        );

        expect(projection.state).toBe('admission_required');
        if (projection.state !== 'admission_required') throw new Error('expected invitation admission');
        expect(projection.actions).toEqual(expect.arrayContaining([
            expect.objectContaining({
                methodId: 'email_password',
                action: 'provision',
                origin: 'home',
            }),
        ]));
    });

    it('treats an explicit inherit document as inherited Home authentication', async () => {
        await activeInvitation({ v: 1, mode: 'inherit' });
        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'invitation', token: INVITATION_TOKEN } },
            {
                env: { HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1' },
            },
        );

        expect(projection.state).toBe('admission_required');
    });
    it('projects native and provider actions with their exact action/mode pairs', async () => {
        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'home' } },
            {
                env: {
                    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
                    HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
                    AUTH_SIGNUP_PROVIDERS: 'acme',
                    AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([oidcEntry('acme')]),
                },
                principal: { accountId: 'account-without-row' },
            },
        );

        expect(projection.state).toBe('ready');
        if (projection.state !== 'ready') throw new Error('expected ready projection');
        expect(projection.actions).toEqual(expect.arrayContaining([
            // `either`, not `keyed`: an Account that already exists keeps its own
            // stored mode, so the Home advertises password login to both Plain and
            // E2EE Accounts (`emailPasswordAuthMethodModule.ts#existingAccountMode`).
            expect.objectContaining({ methodId: 'email_password', action: 'login', mode: 'either' }),
            expect.objectContaining({ methodId: 'acme', action: 'connect', mode: 'either' }),
            expect.objectContaining({ methodId: 'acme', action: 'provision', mode: 'keyed' }),
        ]));
        expect(JSON.stringify(projection)).not.toContain('client-secret-is-private');
        expect(JSON.stringify(projection)).not.toContain('client-id-is-private');
    });

    it("carries the Home's recommended provisioning mode on the open provision action", async () => {
        await db.homeGovernancePolicy.create({ data: {
            id: 'home',
            authenticationPolicy: {
                v: 1,
                permittedAccountModes: ['plain', 'e2ee'],
                recommendedProvisioningMode: 'e2ee',
            },
        } });
        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'home' } },
            {
                env: {
                    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
                    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__PROVISION_ENABLED: '1',
                    HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
                    HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                },
                emailDeliveryReady: true,
            },
        );

        expect(projection.state).toBe('ready');
        if (projection.state !== 'ready') throw new Error('expected ready projection');
        const provision = projection.actions.find((action) => action.kind === 'authenticate'
            && action.methodId === 'email_password'
            && action.action === 'provision');
        const login = projection.actions.find((action) => action.kind === 'authenticate'
            && action.methodId === 'email_password'
            && action.action === 'login');
        // Both protections remain permitted, so the chooser is still offered; the
        // Home's own recommendation travels with it instead of the client seeding
        // from whichever permitted mode happens to sort first.
        expect(provision).toMatchObject({ mode: 'either', recommendedProvisionMode: 'e2ee' });
        // An existing Account keeps its stored mode, so login states no
        // provisioning recommendation at all.
        expect(login).toBeDefined();
        expect(login).not.toHaveProperty('recommendedProvisionMode');
    });

    it.each([
        { denied: 'keyed', mode: 'keyless', recommendation: 'plain' },
        { denied: 'keyless', mode: 'keyed', recommendation: 'e2ee' },
    ] as const)('narrows public native provision to $mode and its surviving recommendation', async ({ denied, mode, recommendation }) => {
        await db.homeGovernancePolicy.create({ data: {
            id: 'home', authenticationPolicy: {
                v: 1, permittedAccountModes: ['plain', 'e2ee'],
                recommendedProvisioningMode: recommendation === 'plain' ? 'e2ee' : 'plain',
            },
        } });
        const env = {
            HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
            HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__PROVISION_ENABLED: '1',
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS: 'email_password',
            HAPPIER_AUTH_PUBLIC_PROVISION_DENY_MODES: denied,
        };
        const projection = await resolveAuthEntry({ v: 1, scope: { kind: 'home' } }, {
            env, emailDeliveryReady: true, requestIp: '203.0.113.10',
        });
        if (projection.state !== 'ready') throw new Error('expected ready projection');
        expect(projection.actions).toEqual(expect.arrayContaining([
            expect.objectContaining({ methodId: 'email_password', action: 'provision', mode, recommendedProvisionMode: recommendation }),
            expect.objectContaining({ methodId: 'email_password', action: 'login', mode: 'either' }),
        ]));
        const deniedProjection = await resolveAuthEntry({ v: 1, scope: { kind: 'home' } }, {
            env: { ...env, HAPPIER_AUTH_PUBLIC_PROVISION_DENY_MODES: '*' },
            emailDeliveryReady: true, requestIp: '203.0.113.10',
        });
        if (deniedProjection.state !== 'ready') throw new Error('expected ready projection');
        expect(deniedProjection.actions.some(action => action.methodId === 'email_password' && action.action === 'provision')).toBe(false);
    });

    it('fails account-service purpose closed when the Home is not an Account Directory', async () => {
        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'home' }, purpose: 'account_service' },
            { env: {} },
        );

        expect(projection).toEqual({
            v: 1,
            state: 'unavailable',
            scope: { kind: 'home' },
            reason: 'not_account_service',
            autoRedirect: null,
        });
    });

    it('does not advertise self sign-in service when Account Directory is unavailable', async () => {
        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'home' } },
            { env: { HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: 'self' } },
        );

        expect(projection).not.toHaveProperty('signInService');
    });

    it('orders provider actions by immutable provider id regardless of deployment configuration order', async () => {
        const projectProviderIds = async (providers: readonly Record<string, unknown>[]) => {
            const projection = await resolveAuthEntry(
                { v: 1, scope: { kind: 'home' } },
                {
                    env: {
                        AUTH_SIGNUP_PROVIDERS: 'zeta,alpha',
                        AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify(providers),
                    },
                    principal: { accountId: 'account-without-row' },
                },
            );
            if (projection.state !== 'ready') throw new Error('expected ready projection');
            return projection.actions
                .filter((action) => action.methodId === 'alpha' || action.methodId === 'zeta')
                .map((action) => `${action.methodId}:${action.action}:${action.mode}`);
        };
        const alpha = { ...oidcEntry('alpha'), displayName: 'Alpha' };
        const zeta = { ...oidcEntry('zeta'), displayName: 'Zeta' };

        await expect(projectProviderIds([zeta, alpha])).resolves.toEqual(
            await projectProviderIds([alpha, zeta]),
        );
        await expect(projectProviderIds([zeta, alpha])).resolves.toEqual([
            'alpha:connect:either',
            'alpha:provision:keyed',
            'zeta:connect:either',
            'zeta:provision:keyed',
        ]);
    });

    it('returns an unavailable terminal result instead of emitting a partial oversized projection', async () => {
        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'home' } },
            {
                env: {
                    AUTH_PROVIDERS_CONFIG_JSON: JSON.stringify([{
                        ...oidcEntry('oversized'),
                        displayName: 'x'.repeat(FEATURES_RESPONSE_MAX_UTF8_BYTES_V1),
                    }]),
                },
                principal: { accountId: 'account-without-row' },
            },
        );

        expect(projection).toEqual({
            v: 1,
            state: 'unavailable',
            scope: { kind: 'home' },
            reason: 'authentication_policy_unavailable',
            autoRedirect: null,
        });
    });

    it('offers connect actions only to a request that carries an authenticated principal', async () => {
        const env = {
            HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        };
        await activeInvitation();

        const anonymous = await resolveAuthEntry({ v: 1, scope: { kind: 'home' } }, { env });
        const authenticated = await resolveAuthEntry(
            { v: 1, scope: { kind: 'home' } },
            { env, principal: { accountId: 'account-without-row' } },
        );
        const invitation = await resolveAuthEntry(
            { v: 1, scope: { kind: 'invitation', token: INVITATION_TOKEN } },
            { env },
        );

        if (anonymous.state !== 'ready' || authenticated.state !== 'ready') throw new Error('expected ready projections');
        if (invitation.state !== 'admission_required') throw new Error('expected invitation admission');
        expect(anonymous.actions).not.toContainEqual(expect.objectContaining({ action: 'connect' }));
        expect(anonymous.actions).toContainEqual(expect.objectContaining({ methodId: 'email_password', action: 'login' }));
        expect(invitation.actions).not.toContainEqual(expect.objectContaining({ action: 'connect', origin: 'home' }));
        expect(authenticated.actions).toContainEqual(expect.objectContaining({
            methodId: 'email_password',
            action: 'connect',
            origin: 'home',
        }));
    });

    it('keeps Team and invitation entry open while an accepted connection still awaits its activation test', async () => {
        // A fresh Home inherits the deployment ceiling; no narrowed row is seeded.
        const team = await db.team.create({ data: { name: 'Untested Team' } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: 'oidc',
                displayName: 'Untested SSO',
                enabled: true,
                firstEnabledAt: new Date('2026-09-06T00:00:00.000Z'),
                config: MANAGED_OIDC_CONFIG,
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: { v: 1, kind: 'oidc' },
                settings: {
                    v: 1,
                    kind: 'oidc',
                    allowedUsers: [],
                    allowedEmailDomains: [],
                    groupsAny: [],
                    groupsAll: [],
                },
                enabled: true,
                firstEnabledAt: new Date('2026-09-06T00:00:00.000Z'),
            },
        });
        await db.team.update({
            where: { id: team.id },
            data: {
                authenticationPolicy: {
                    v: 1,
                    mode: 'restricted',
                    accepted: [{ kind: 'team_connection', connectionId: connection.id }],
                },
            },
        });
        await inTx((tx) => createTeamInvitationInTx(tx, {
            teamId: team.id, role: 'member', historyAccess: 'from_membership',
            createdByAccountId: null, recipientEmailNormalized: 'invited@example.test',
            tokenHash: digestTeamInvitationToken(INVITATION_TOKEN), now: new Date(),
        }));
        const env = {
            HAPPIER_FEATURE_TEAMS__ENABLED: '1',
            HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test',
        };

        const teamEntry = await resolveAuthEntry({ v: 1, scope: { kind: 'team', teamId: team.id } }, { env });
        const invitationEntry = await resolveAuthEntry(
            { v: 1, scope: { kind: 'invitation', token: INVITATION_TOKEN } },
            { env },
        );

        // Both scopes project the connection through the one Team-connection
        // projector, so the invitation carries the same safe descriptor fields.
        for (const projection of [teamEntry, invitationEntry]) {
            expect(projection.state).toBe('admission_required');
            if (projection.state !== 'admission_required') throw new Error('expected admission');
            expect(projection.actions).toContainEqual(expect.objectContaining({
                methodId: provider.id,
                action: 'connect',
                origin: 'team',
                presentation: { displayName: 'Untested SSO', iconHint: 'oidc', providerKind: 'oidc', supportsProfileBadge: false },
            }));
        }
    });

    it('offers native provisioning on the Team page when transactional mail is ready', async () => {
        const team = await db.team.create({ data: { name: 'Open Team' } });

        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: team.id } },
            {
                env: {
                    HAPPIER_FEATURE_TEAMS__ENABLED: '1',
                    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
                    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__PROVISION_ENABLED: '1',
                },
                emailDeliveryReady: true,
            },
        );

        expect(projection.state).toBe('admission_required');
        if (projection.state !== 'admission_required') throw new Error('expected Team admission');
        expect(projection.actions).toContainEqual(expect.objectContaining({
            methodId: 'email_password',
            action: 'provision',
            origin: 'home',
        }));
    });

    it('withholds provisioning that the public-signup policy denies for the requesting address', async () => {
        const env = {
            HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
            HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__PROVISION_ENABLED: '1',
            HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS: 'email_password',
        };

        const publicVisitor = await resolveAuthEntry(
            { v: 1, scope: { kind: 'home' } },
            { env, emailDeliveryReady: true, requestIp: '8.8.8.8' },
        );
        const privateVisitor = await resolveAuthEntry(
            { v: 1, scope: { kind: 'home' } },
            { env, emailDeliveryReady: true, requestIp: '10.0.0.9' },
        );

        if (publicVisitor.state !== 'ready' || privateVisitor.state !== 'ready') throw new Error('expected ready projections');
        expect(publicVisitor.actions).not.toContainEqual(expect.objectContaining({ methodId: 'email_password', action: 'provision' }));
        expect(publicVisitor.actions).toContainEqual(expect.objectContaining({ methodId: 'email_password', action: 'login' }));
        expect(privateVisitor.actions).toContainEqual(expect.objectContaining({ methodId: 'email_password', action: 'provision' }));
    });

    it('keeps a restricted Team open through its other accepted alternatives when the Home does not offer one', async () => {
        // The Home prohibits the connection's provider kind, so the catalog omits it:
        // that accepted reference is currently not offered, which must not turn the
        // whole Team policy (and the other accepted Home method) unavailable.
        await db.homeGovernancePolicy.create({
            data: {
                id: 'home',
                teamProviderPolicy: {
                    v: 1,
                    allowedTeamProviderKinds: ['github_app_identity'],
                    teamJitAllowed: false,
                    approvedGitHubEnterpriseOrigins: [],
                },
            },
        });
        const team = await db.team.create({ data: { name: 'Narrowed Team' } });
        const provider = await db.identityProviderInstance.create({
            data: {
                ownerTeamId: team.id,
                kind: 'oidc',
                displayName: 'Prohibited SSO',
                enabled: true,
                firstEnabledAt: new Date('2026-09-06T00:00:00.000Z'),
                config: MANAGED_OIDC_CONFIG,
            },
        });
        const connection = await db.teamIdentityConnection.create({
            data: {
                teamId: team.id,
                providerInstanceId: provider.id,
                externalReference: { v: 1, kind: 'oidc' },
                settings: {
                    v: 1,
                    kind: 'oidc',
                    allowedUsers: [],
                    allowedEmailDomains: [],
                    groupsAny: [],
                    groupsAll: [],
                },
                enabled: true,
                firstEnabledAt: new Date('2026-09-06T00:00:00.000Z'),
            },
        });
        await db.team.update({
            where: { id: team.id },
            data: {
                authenticationPolicy: {
                    v: 1,
                    mode: 'restricted',
                    accepted: [
                        { kind: 'team_connection', connectionId: connection.id },
                        { kind: 'home_method', methodId: 'email_password' },
                    ],
                },
            },
        });

        const projection = await resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: team.id } },
            {
                env: {
                    HAPPIER_FEATURE_TEAMS__ENABLED: '1',
                    HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test',
                    HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: '1',
                },
            },
        );

        expect(projection.state).toBe('admission_required');
        if (projection.state !== 'admission_required') throw new Error('expected Team admission');
        expect(projection.actions).toContainEqual(expect.objectContaining({
            methodId: 'email_password',
            action: 'login',
            origin: 'home',
        }));
        // The prohibited connection is never startable, but as an accepted choice it
        // is named with its safe reason instead of vanishing (teams-lane-03/01 §10.2).
        expect(projection.actions).not.toContainEqual(expect.objectContaining({
            kind: 'authenticate', methodId: provider.id, origin: 'team',
        }));
        expect(projection.actions).toContainEqual(expect.objectContaining({
            kind: 'provider_unavailable', methodId: provider.id, origin: 'team', reason: 'provider_unavailable',
        }));
    });

    it('names a spent or unknown invitation to the bearer that presented it', async () => {
        // The bearer is the only visibility proof an invitation destination has,
        // and naming a spent one names no Team: the holder learns to ask for a new
        // invitation instead of reading "not found".
        await expect(resolveAuthEntry(
            { v: 1, scope: { kind: 'invitation', token: INVITATION_TOKEN } },
            { env: { HAPPIER_FEATURE_TEAMS__ENABLED: '1' } },
        )).resolves.toEqual({
            v: 1,
            state: 'unavailable',
            scope: { kind: 'invitation' },
            reason: 'invitation_unavailable',
            autoRedirect: null,
        });
    });

    it('names the required sign-in to a signed-in visitor a restricted Team cannot admit, and stays opaque to everyone else', async () => {
        const team = await db.team.create({
            data: {
                name: 'SSO Only Team',
                authenticationPolicy: {
                    v: 1,
                    mode: 'restricted',
                    // Accepted, but this Home never offers it: the policy resolves
                    // restricted with no usable choice.
                    accepted: [{ kind: 'team_connection', connectionId: 'connection-absent' }],
                },
            },
        });
        const account = await member(team.id);
        const entry = (principal?: { accountId: string }) => resolveAuthEntry(
            { v: 1, scope: { kind: 'team', teamId: team.id } },
            {
                env: { HAPPIER_FEATURE_TEAMS__ENABLED: '1' },
                ...(principal ? { principal } : {}),
            },
        );

        await expect(entry({ accountId: account.id })).resolves.toEqual({
            v: 1,
            state: 'unavailable',
            scope: { kind: 'team' },
            reason: 'sso_required',
            autoRedirect: null,
        });
        // An anonymous visitor proved nothing, so the refusal stays opaque.
        await expect(entry()).resolves.toEqual({
            v: 1,
            state: 'unavailable',
            scope: { kind: 'team' },
            reason: 'entry_not_available',
            autoRedirect: null,
        });
    });
});
