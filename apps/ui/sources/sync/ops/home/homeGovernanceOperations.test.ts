import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    createHomeGovernanceHarness,
    homeAccountRowFixture,
    homeAdministrationEventFixture,
    homeGovernancePolicyProjectionFixture,
    homeSettingsProjectionFixture,
    installHomeGovernanceBoundaries,
    standardCleanup,
} from '@/dev/testkit';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';

/**
 * The Home operation wrappers, through the path they actually take.
 *
 * Every wrapper names a canonical Action id and nothing else. The method, path
 * and result shape come from that id's row by way of the shared Action executor,
 * so these tests watch the network boundary: a wrapper pointed at the wrong id,
 * or a row whose transport moved, changes what arrives there and fails here.
 * Only the network and the device credential store are replaced.
 */

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

const GOVERNANCE_PATH = '/v1/home/governance/get';

async function operations() {
    return await import('./homeGovernanceOperations');
}

async function addHome(): Promise<string> {
    return await harness.addHome({
        name: 'Home A',
        serverUrl: 'https://home-a.example',
        accountId: 'account-admin',
    });
}

beforeEach(async () => {
    const { resetHomeGovernanceSnapshotsForTests } = await import(
        '@/sync/store/home/governance/homeGovernanceSnapshots'
    );
    const { resetHomeGovernanceEngineForTests } = await import(
        '@/sync/engine/home/governance/homeGovernanceEngine'
    );
    resetHomeGovernanceSnapshotsForTests();
    resetHomeGovernanceEngineForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
});

afterEach(() => {
    standardCleanup();
});

describe('home governance mutations', () => {
    it('keeps a deferred approval distinct from a committed Home mutation', async () => {
        const { classifyHomeGovernanceActionOutcome } = await operations();

        expect(classifyHomeGovernanceActionOutcome({
            ok: true,
            result: {
                kind: 'approval_request_created',
                artifactId: 'approval-home-1',
                actionId: 'home.policy.set',
            },
        })).toEqual({ kind: 'approval_pending', artifactId: 'approval-home-1' });
    });

    it('rejects an explicitly signed-out Home intent instead of mutating the focused Home', async () => {
        const homeA = await harness.addHome({
            name: 'Home A', serverUrl: 'https://home-a.example', accountId: null,
        });
        const homeB = await harness.addHome({
            name: 'Home B',
            serverUrl: 'https://home-b.example',
            accountId: 'account-admin',
        });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ profileScope: { serverId: homeB, accountId: 'account-admin' } });
        harness.answer(homeB, '/v1/home/accounts/role/set', {
            body: homeAccountRowFixture('acc_target', { homeRole: 'admin' }),
        });

        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        await expect(createDefaultActionExecutor().execute(
            'home.accounts.role.set',
            { accountId: 'acc_target', homeRole: 'admin' },
            { surface: 'ui', serverId: homeA },
        )).rejects.toThrow('action_home_signed_out');
        expect(harness.requestsFor('/v1/home/accounts/role/set')).toEqual([]);
    });

    it('carries a role change to the exact Home over its own Action row transport', async () => {
        const home = await addHome();
        const focusedHome = await harness.addHome({
            name: 'Home B',
            serverUrl: 'https://home-b.example',
            accountId: 'account-admin',
        });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ profileScope: { serverId: focusedHome, accountId: 'account-admin' } });
        harness.answer(home, '/v1/home/accounts/role/set', {
            body: homeAccountRowFixture('acc_target', { homeRole: 'admin' }),
        });

        const { setHomeAccountRole } = await operations();
        const outcome = await setHomeAccountRole({
            scope: { serverId: home, accountId: 'account-admin' },
            accountId: 'acc_target',
            homeRole: 'admin',
        });

        expect(outcome.kind).toBe('succeeded');
        const [request] = harness.requestsFor('/v1/home/accounts/role/set');
        expect(request?.serverId).toBe(home);
        expect(request?.input).toEqual({ accountId: 'acc_target', homeRole: 'admin' });
    });

    it('re-reads the same Home only after a change it actually accepted', async () => {
        const home = await addHome();
        harness.answer(home, '/v1/home/accounts/disable', {
            body: homeAccountRowFixture('acc_target', { status: 'suspended' }),
        });

        const { disableHomeAccount } = await operations();
        await disableHomeAccount({
            scope: { serverId: home, accountId: 'account-admin' },
            accountId: 'acc_target',
        });

        // The refresh is the observable consequence of an accepted change.
        expect(harness.requestsFor(GOVERNANCE_PATH).length).toBeGreaterThan(0);
    });

    it('does not re-read a Home that refused the change', async () => {
        const home = await addHome();
        harness.answer(home, '/v1/home/accounts/disable', {
            status: 403,
            body: { error: 'home_governance_forbidden' },
        });

        const { disableHomeAccount } = await operations();
        const outcome = await disableHomeAccount({
            scope: { serverId: home, accountId: 'account-admin' },
            accountId: 'acc_target',
        });

        expect(outcome).toEqual({
            kind: 'failed',
            failure: {
                kind: 'forbidden',
                retryable: false,
                code: 'home_governance_forbidden',
                details: { error: 'home_governance_forbidden' },
            },
        });
        expect(harness.requestsFor(GOVERNANCE_PATH)).toHaveLength(0);
    });

    it('reports a Home with no such operation as unsupported rather than a generic failure', async () => {
        const home = await addHome();
        // No answer registered: this Home does not serve the operation.

        const { enableHomeAccount } = await operations();
        const outcome = await enableHomeAccount({
            scope: { serverId: home, accountId: 'account-admin' },
            accountId: 'acc_target',
        });

        expect(outcome.kind).toBe('failed');
        if (outcome.kind !== 'failed') throw new Error('unreachable');
        expect(outcome.failure.kind).toBe('unsupported');
        expect(outcome.failure.retryable).toBe(false);
    });

    it('keeps an unfinished erasure distinguishable from a completed one', async () => {
        const home = await addHome();
        harness.answer(home, '/v1/home/accounts/delete', {
            body: { status: 'disabled_pending_completion' },
        });

        const { deleteHomeAccount } = await operations();
        const outcome = await deleteHomeAccount({
            scope: { serverId: home, accountId: 'account-admin' },
            accountId: 'acc_target',
        });

        expect(outcome.kind).toBe('incomplete');
        // Either answer means the Account's access is gone, so the Home moved.
        expect(harness.requestsFor(GOVERNANCE_PATH).length).toBeGreaterThan(0);
    });

    it('reports a finished erasure as succeeded', async () => {
        const home = await addHome();
        harness.answer(home, '/v1/home/accounts/delete', { body: { status: 'deleted' } });

        const { deleteHomeAccount } = await operations();
        const outcome = await deleteHomeAccount({
            scope: { serverId: home, accountId: 'account-admin' },
            accountId: 'acc_target',
        });

        expect(outcome.kind).toBe('succeeded');
    });

    it('sends both policy wrappers to the Home one policy mutation with its revision', async () => {
        const home = await addHome();
        harness.answer(home, '/v1/home/policy/set', { body: homeGovernancePolicyProjectionFixture() });

        const { setHomeTeamCreationPolicy, setHomeAuthenticationPolicies } = await operations();
        const scope = { serverId: home, accountId: 'account-admin' } as const;

        await setHomeTeamCreationPolicy({
            scope,
            expectedRevision: 4,
            teamCreationPolicy: 'self_service',
        });
        await setHomeAuthenticationPolicies({
            scope,
            expectedRevision: 7,
            teamProviderPolicy: {
                v: 1,
                allowedTeamProviderKinds: ['oidc', 'workos_sso'],
                teamJitAllowed: false,
                approvedGitHubEnterpriseOrigins: [],
            },
            identityNetworkPolicy: null,
        });

        const [teamCreation, authentication] = harness.requestsFor('/v1/home/policy/set');
        expect(teamCreation?.input).toEqual({
            expectedRevision: 4,
            teamCreationPolicy: 'self_service',
        });
        expect(authentication?.input).toEqual({
            expectedRevision: 7,
            teamProviderPolicy: {
                v: 1,
                allowedTeamProviderKinds: ['oidc', 'workos_sso'],
                teamJitAllowed: false,
                approvedGitHubEnterpriseOrigins: [],
            },
            identityNetworkPolicy: null,
        });
    });

    it('asks before resending a widening the Home refused, and resends the identical patch confirmed', async () => {
        const home = await addHome();
        harness.answer(home, '/v1/home/policy/set', {
            select: (input) => (input as { confirmWidening?: unknown }).confirmWidening === true
                ? { body: homeGovernancePolicyProjectionFixture() }
                : { status: 409, body: { error: 'home_policy_widening_unconfirmed' } },
        });
        const { setHomeAuthenticationPolicies } = await operations();
        const scope = { serverId: home, accountId: 'account-admin' } as const;
        const asked: string[] = [];

        const outcome = await setHomeAuthenticationPolicies({
            scope,
            expectedRevision: 3,
            authenticationPolicy: { v: 1, admission: 'self_service' },
            confirmWidening: async () => { asked.push('asked'); return true; },
        });

        expect(outcome.kind).toBe('succeeded');
        expect(asked).toEqual(['asked']);
        const [refused, confirmed] = harness.requestsFor('/v1/home/policy/set');
        expect(refused?.input).toEqual({ expectedRevision: 3, authenticationPolicy: { v: 1, admission: 'self_service' } });
        expect(confirmed?.input).toEqual({
            expectedRevision: 3,
            authenticationPolicy: { v: 1, admission: 'self_service' },
            confirmWidening: true,
        });
    });

    it('writes nothing more when the widening is declined, and never asks for a narrowing', async () => {
        const home = await addHome();
        harness.answer(home, '/v1/home/policy/set', {
            select: (input) => {
                const policy = (input as { authenticationPolicy?: { admission?: string } }).authenticationPolicy;
                return policy?.admission === 'closed'
                    ? { body: homeGovernancePolicyProjectionFixture() }
                    : { status: 409, body: { error: 'home_policy_widening_unconfirmed' } };
            },
        });
        const { setHomeAuthenticationPolicies } = await operations();
        const scope = { serverId: home, accountId: 'account-admin' } as const;
        let asked = 0;
        const confirmWidening = async () => { asked += 1; return false; };

        const declined = await setHomeAuthenticationPolicies({
            scope, expectedRevision: 3, authenticationPolicy: { v: 1, admission: 'self_service' }, confirmWidening,
        });
        expect(declined).toMatchObject({ kind: 'failed', failure: { code: 'home_policy_widening_unconfirmed' } });
        expect(harness.requestsFor('/v1/home/policy/set')).toHaveLength(1);

        const narrowed = await setHomeAuthenticationPolicies({
            scope, expectedRevision: 3, authenticationPolicy: { v: 1, admission: 'closed' }, confirmWidening,
        });
        expect(narrowed.kind).toBe('succeeded');
        expect(asked).toBe(1);
        expect(harness.requestsFor('/v1/home/policy/set')).toHaveLength(2);
    });

    it('claims an ownerless Home with its code and re-reads the Home only once it was accepted', async () => {
        const home = await addHome();
        const { claimHomeWithCode } = await operations();
        const scope = { serverId: home, accountId: 'account-admin' } as const;

        harness.answer(home, '/v1/home/governance/claim', { status: 403, body: { error: 'home_claim_refused' } });
        const refusedReads = harness.requestsFor(GOVERNANCE_PATH).length;
        const refused = await claimHomeWithCode({ scope, code: 'ABCD' });
        expect(refused).toMatchObject({ kind: 'failed', failure: { code: 'home_claim_refused' } });
        expect(harness.requestsFor(GOVERNANCE_PATH)).toHaveLength(refusedReads);

        harness.answer(home, '/v1/home/governance/claim', { body: { status: 'claimed' } });
        const claimed = await claimHomeWithCode({ scope, code: 'ABCD' });
        expect(claimed.kind).toBe('succeeded');
        expect(harness.requestsFor('/v1/home/governance/claim').at(-1)?.input).toEqual({ code: 'ABCD' });
        expect(harness.requestsFor(GOVERNANCE_PATH).length).toBeGreaterThan(refusedReads);
    });

    it('reads a People page without re-reading the viewer own capabilities', async () => {
        const home = await addHome();
        harness.answer(home, '/v1/home/accounts/list', {
            body: { items: [], nextCursor: null },
        });

        const { listHomeAccounts } = await operations();
        const outcome = await listHomeAccounts({
            scope: { serverId: home, accountId: 'account-admin' },
            cursor: 'cur_2',
        });

        expect(outcome.kind).toBe('succeeded');
        expect(harness.requestsFor('/v1/home/accounts/list')[0]?.input).toEqual({ cursor: 'cur_2' });
        // A list page moving does not mean the viewer's capabilities did.
        expect(harness.requestsFor(GOVERNANCE_PATH)).toHaveLength(0);
    });

    it('searches the Home scope explicitly so managing one Team cannot widen the lookup', async () => {
        const home = await addHome();
        harness.answer(home, '/v1/home/accounts/search', { body: { accounts: [] } });

        const { searchHomeAccounts } = await operations();
        const outcome = await searchHomeAccounts({
            scope: { serverId: home, accountId: 'account-admin' },
            query: '  ada  ',
        });

        expect(outcome.kind).toBe('succeeded');
        expect(harness.requestsFor('/v1/home/accounts/search')[0]?.input).toEqual({
            query: 'ada',
            scope: { kind: 'home' },
        });
    });

    it('rejects an answer that does not satisfy the read contract', async () => {
        const home = await addHome();
        harness.answer(home, '/v1/home/accounts/list', { body: { items: 'not-a-list' } });

        const { listHomeAccounts } = await operations();
        const outcome = await listHomeAccounts({
            scope: { serverId: home, accountId: 'account-admin' },
        });

        expect(outcome.kind).toBe('failed');
        if (outcome.kind !== 'failed') throw new Error('unreachable');
        expect(outcome.failure.kind).toBe('invalid');
    });
});

describe('home settings, mail delivery and audit', () => {
    it('writes settings against the read revision and returns the Home projection without re-reading governance', async () => {
        const home = await addHome();
        const saved = homeSettingsProjectionFixture({ revision: 4 });
        harness.answer(home, '/v1/home/settings/set', { body: saved });

        const { setHomeSettings } = await operations();
        const outcome = await setHomeSettings({
            scope: { serverId: home, accountId: 'account-admin' },
            expectedRevision: 3,
            values: { HAPPIER_AUTH_EMAIL_SMTP_HOST: 'smtp.example.org', HAPPIER_AUTH_EMAIL_SMTP_PORT: null },
            secrets: { HAPPIER_AUTH_EMAIL_SMTP_PASSWORD: { replace: 'hunter2' } },
        });

        expect(outcome).toEqual({ kind: 'succeeded', value: saved });
        expect(harness.requestsFor('/v1/home/settings/set')[0]?.input).toEqual({
            expectedRevision: 3,
            values: { HAPPIER_AUTH_EMAIL_SMTP_HOST: 'smtp.example.org', HAPPIER_AUTH_EMAIL_SMTP_PORT: null },
            secrets: { HAPPIER_AUTH_EMAIL_SMTP_PASSWORD: { replace: 'hunter2' } },
        });
        // Settings are not part of the viewer's governance projection.
        expect(harness.requestsFor(GOVERNANCE_PATH)).toHaveLength(0);
    });

    it('names the refused key and reason when the Home rejects a settings value', async () => {
        const home = await addHome();
        harness.answer(home, '/v1/home/settings/set', {
            status: 400,
            body: { error: 'home_settings_invalid', key: 'HAPPIER_AUTH_EMAIL_SMTP_PORT', reason: 'out_of_bounds' },
        });

        const { setHomeSettings, readHomeSettingsInvalidFailure } = await operations();
        const outcome = await setHomeSettings({
            scope: { serverId: home, accountId: 'account-admin' },
            expectedRevision: 3,
            values: { HAPPIER_AUTH_EMAIL_SMTP_PORT: 70000 },
        });

        expect(outcome.kind).toBe('failed');
        if (outcome.kind !== 'failed') throw new Error('unreachable');
        expect(readHomeSettingsInvalidFailure(outcome.failure)).toEqual({
            key: 'HAPPIER_AUTH_EMAIL_SMTP_PORT',
            reason: 'out_of_bounds',
        });
    });

    it('reports a stale settings revision as the Home conflict code', async () => {
        const home = await addHome();
        harness.answer(home, '/v1/home/settings/set', {
            status: 409,
            body: { error: 'home_settings_revision_conflict' },
        });

        const { setHomeSettings, readHomeSettingsInvalidFailure } = await operations();
        const outcome = await setHomeSettings({
            scope: { serverId: home, accountId: 'account-admin' },
            expectedRevision: 1,
            values: { HAPPIER_AUTH_EMAIL_FROM_NAME: 'Acme' },
        });

        expect(outcome.kind).toBe('failed');
        if (outcome.kind !== 'failed') throw new Error('unreachable');
        expect(outcome.failure.code).toBe('home_settings_revision_conflict');
        expect(readHomeSettingsInvalidFailure(outcome.failure)).toBeNull();
    });

    it('reads settings and mail readiness from the exact Home', async () => {
        const home = await addHome();
        harness.answer(home, '/v1/home/settings/get', { body: homeSettingsProjectionFixture() });
        harness.answer(home, '/v1/home/mail-delivery/get', {
            body: { transportConfigured: true, linkTargetBuildable: false, linkOrigin: null, ready: false, passwordUnreadable: false },
        });

        const { getHomeSettings, getHomeMailDelivery } = await operations();
        const scope = { serverId: home, accountId: 'account-admin' } as const;
        const settings = await getHomeSettings({ scope });
        const readiness = await getHomeMailDelivery({ scope });

        expect(settings.kind === 'succeeded' ? settings.value.revision : null).toBe(3);
        expect(readiness).toEqual({
            kind: 'succeeded',
            value: { transportConfigured: true, linkTargetBuildable: false, linkOrigin: null, ready: false, passwordUnreadable: false },
        });
        expect(harness.requestsFor('/v1/home/settings/get')[0]?.serverId).toBe(home);
    });

    it('carries a failed test send as its class only', async () => {
        const home = await addHome();
        harness.answer(home, '/v1/home/mail-delivery/test', {
            body: { status: 'failed', reason: 'transport_failed' },
        });

        const { sendHomeTestEmail } = await operations();
        const outcome = await sendHomeTestEmail({
            scope: { serverId: home, accountId: 'account-admin' },
            to: '  ada@example.com ',
        });

        expect(outcome).toEqual({ kind: 'succeeded', value: { status: 'failed', reason: 'transport_failed' } });
        expect(harness.requestsFor('/v1/home/mail-delivery/test')[0]?.input).toEqual({ to: 'ada@example.com' });
    });

    it('runs a retention dry run on the exact Home and returns its per-domain counts', async () => {
        const home = await addHome();
        const result = {
            ranAt: '2026-09-27T10:42:00.000Z',
            byDomain: { sessions: { wouldDelete: 1204, candidatesExamined: 5000, stopReason: 'time_budget' } },
        };
        harness.answer(home, '/v1/home/retention/dry-run', { body: result });

        const { runHomeRetentionDryRun } = await operations();
        const outcome = await runHomeRetentionDryRun({ scope: { serverId: home, accountId: 'account-admin' } });

        expect(outcome).toEqual({ kind: 'succeeded', value: result });
        expect(harness.requestsFor('/v1/home/retention/dry-run')[0]?.input).toEqual({});
        expect(harness.requestsFor('/v1/home/retention/dry-run')[0]?.serverId).toBe(home);
    });

    it('carries a sweep that holds the lock as the Home conflict code', async () => {
        const home = await addHome();
        harness.answer(home, '/v1/home/retention/dry-run', {
            status: 409,
            body: { error: 'retention_sweep_in_progress' },
        });

        const { runHomeRetentionDryRun } = await operations();
        const outcome = await runHomeRetentionDryRun({ scope: { serverId: home, accountId: 'account-admin' } });

        expect(outcome.kind).toBe('failed');
        if (outcome.kind !== 'failed') throw new Error('unreachable');
        expect(outcome.failure.code).toBe('retention_sweep_in_progress');
    });

    it('pages the audit trail with the Home cursor', async () => {
        const home = await addHome();
        const event = homeAdministrationEventFixture({ id: 'evt-1', action: 'home.owner.claim', summary: {} });
        harness.answer(home, '/v1/home/audit/list', { body: { items: [event], nextCursor: 'cur-2' } });

        const { listHomeAudit } = await operations();
        const outcome = await listHomeAudit({
            scope: { serverId: home, accountId: 'account-admin' },
            cursor: 'cur-1',
        });

        expect(outcome).toEqual({ kind: 'succeeded', value: { items: [event], nextCursor: 'cur-2' } });
        expect(harness.requestsFor('/v1/home/audit/list')[0]?.input).toEqual({ cursor: 'cur-1' });
    });
});
