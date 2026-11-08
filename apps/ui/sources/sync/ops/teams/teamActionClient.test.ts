import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { createDeferred, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { TeamUpdateInputV1Schema } from '@happier-dev/protocol/teams';

import {
    homeDomainFailureCode,
    homeDomainFailureFromActionFailure,
} from '@/sync/api/home/homeDomainActions';

const confirmNative = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: confirmNative } }).module;
});

const PageSchema = z.object({ items: z.array(z.unknown()), nextCursor: z.nullable(z.string()) });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { getTeamCredentialPreparation } = await import('./teamCredentialOperations');
const { resetTeamActionClientForTests, runTeamAction } = await import('./teamActionClient');
await import('@/sync/ops/actions/defaultActionExecutor');
const GROUPS_PATH = '/v1/teams/groups/list';

function addHome(serverUrl = 'https://home-a.example') {
    return harness.addHome({ name: serverUrl, serverUrl, accountId: 'account', credentialResourcesEnabled: true });
}

beforeEach(async () => {
    confirmNative.mockReset();
    confirmNative.mockResolvedValue(true);
    await harness.reset();
    resetTeamActionClientForTests();
});

afterEach(() => {
    resetTeamActionClientForTests();
    standardCleanup();
});

describe('runTeamAction', () => {
    it('commits the exact Team operands at the designed confirmation before lazy admission suspends', async () => {
        const serverId = await addHome();
        let received: unknown;
        harness.answer(serverId, '/v1/teams/update', { select: input => {
            const request = TeamUpdateInputV1Schema.parse(input);
            received = request;
            return { body: teamSummaryFixture({ name: request.name ?? 'Platform' }) };
        } });
        const input = { v: 1 as const, teamId: 'team-1', name: 'Reviewed name' };
        const pending = runTeamAction({ scope: createServerAccountScope(serverId, 'account')!,
            actionId: 'teams.update', input, approval: 'surface_confirmed', parse: value => value });
        input.name = 'Changed after confirmation';
        expect(await pending).toMatchObject({ kind: 'succeeded' });
        expect(received).toMatchObject({ name: 'Reviewed name' });
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
    });

    it('returns a natively confirmed roster read to the original caller after another Home is focused', async () => {
        const homeA = await addHome();
        const homeB = await addHome('https://home-b.example');
        await harness.requireUiApproval(homeA, 'teams.groups.list');
        harness.answer(homeA, GROUPS_PATH, { body: { items: [], nextCursor: 'next-group-page' } });
        const decision = createDeferred<boolean>();
        confirmNative.mockReturnValueOnce(decision.promise);
        const pending = runTeamAction({
            scope: createServerAccountScope(homeA, 'account')!, actionId: 'teams.groups.list',
            input: { v: 1, teamId: 'team-1', archived: 'active' }, parse: value => PageSchema.parse(value),
        });
        try {
            await waitForHomeGovernance(() => expect(confirmNative).toHaveBeenCalledOnce());
            expect(harness.requestsFor(GROUPS_PATH)).toHaveLength(0);
            expect(harness.artifacts(homeA).list()).toHaveLength(0);
            await setActiveServerId(homeB, { scope: 'device' });
            expect(harness.requestsFor(GROUPS_PATH)).toHaveLength(0);
            decision.resolve(true);
            await expect(pending).resolves.toEqual({ kind: 'succeeded', value: { items: [], nextCursor: 'next-group-page' } });
            expect(harness.requestsFor(GROUPS_PATH).map(request => request.serverId)).toEqual([homeA]);
            expect(confirmNative).toHaveBeenCalledOnce();
            expect(harness.artifacts(homeA).list()).toHaveLength(0);
            expect(harness.artifacts(homeB).list()).toHaveLength(0);
        } finally { decision.resolve(false); await pending; }
    });

    it('reads material-safe readiness through the captured Home transport', async () => {
        const serverId = await addHome();
        const observation = { status: 'not_ready', reason: 'preparation_pending', counts: { pending: 1 } };
        const path = '/v2/teams/team%20%2F1/credential-resources/resource%3F%2F1/direct-material';
        harness.answer(serverId, path, { select: (_input, request) => {
            expect(new URL(request.url).searchParams.get('view')).toBe('readiness');
            return { body: observation };
        } });
        const outcome = await getTeamCredentialPreparation({
            scope: createServerAccountScope(serverId, 'account')!, teamId: 'team /1', resourceId: 'resource?/1',
        });
        expect(outcome).toEqual({ kind: 'succeeded', value: observation });
        expect(harness.requestsFor(`${path}?view=readiness`)).toHaveLength(1);
        expect(harness.requestsFor(`${path}?view=readiness`)[0]).toMatchObject({ serverId, serverUrl: 'https://home-a.example' });
    });
    it('carries a Team intent to the path its Action row declares, naming no path itself', async () => {
        const serverId = await addHome();
        harness.answer(serverId, GROUPS_PATH, { body: { items: [], nextCursor: null } });

        const outcome = await runTeamAction({
            scope: createServerAccountScope(serverId, 'account')!,
            actionId: 'teams.groups.list',
            input: { v: 1, teamId: 'team-1', archived: 'active' },
            parse: (value) => PageSchema.parse(value),
        });

        expect(outcome.kind).toBe('succeeded');
        // The path came from the registered row through the shared front door,
        // not from any table in the Team wrappers.
        expect(harness.requestsFor(GROUPS_PATH)).toHaveLength(1);
        expect(harness.requestsFor(GROUPS_PATH)[0]).toMatchObject({ serverId, serverUrl: 'https://home-a.example' });
    });

    it('completes against the Home it captured even when focus moves first', async () => {
        const homeA = await addHome();
        const homeB = await addHome('https://home-b.example');
        await setActiveServerId(homeA, { scope: 'device' });
        const reply = createDeferred<void>();
        harness.answer(homeA, GROUPS_PATH, { body: { items: [], nextCursor: null }, respondAfter: reply.promise });

        const pending = runTeamAction({
            scope: createServerAccountScope(homeA, 'account')!,
            actionId: 'teams.groups.list',
            input: { v: 1, teamId: 'team-1', archived: 'active' },
            parse: (value) => PageSchema.parse(value),
        });

        try {
            await waitForHomeGovernance(() => expect(harness.requestsFor(GROUPS_PATH)).toHaveLength(1));
            // Focus may move, but the captured Home owns the in-flight request.
            await setActiveServerId(homeB, { scope: 'device' });
            reply.resolve();
            await expect(pending).resolves.toMatchObject({ kind: 'succeeded' });
            const requests = harness.requestsFor(GROUPS_PATH);
            expect(requests.every(request => request.serverId === homeA)).toBe(true);
            expect(requests.some(request => request.serverId === homeB)).toBe(false);
        } finally { reply.resolve(); await pending; }
    });

    it('addresses two Homes independently rather than sharing one bound port', async () => {
        const homeA = await addHome();
        const homeB = await addHome('https://home-b.example');
        await setActiveServerId(homeA, { scope: 'device' });
        for (const serverId of [homeA, homeB]) harness.answer(serverId, GROUPS_PATH, { body: { items: [], nextCursor: null } });

        const input = { v: 1, teamId: 'team-1', archived: 'active' } as const;
        await runTeamAction({
            scope: createServerAccountScope(homeA, 'account')!,
            actionId: 'teams.groups.list',
            input,
            parse: (value) => PageSchema.parse(value),
        });
        await runTeamAction({
            scope: createServerAccountScope(homeB, 'account')!,
            actionId: 'teams.groups.list',
            input,
            parse: (value) => PageSchema.parse(value),
        });

        expect(harness.requestsFor(GROUPS_PATH).map(request => request.serverId)).toEqual([homeA, homeB]);
    });

    it('reports a Home refusal in the vocabulary the Team surfaces already speak', async () => {
        const serverId = await addHome('https://home-c.example');
        harness.answer(serverId, GROUPS_PATH, { body: {}, status: 403 });

        const outcome = await runTeamAction({
            scope: createServerAccountScope(serverId, 'account')!,
            actionId: 'teams.groups.list',
            input: { v: 1, teamId: 'team-1', archived: 'active' },
            parse: (value) => PageSchema.parse(value),
        });

        expect(outcome).toMatchObject({
            kind: 'failed',
            failure: { kind: 'forbidden', retryable: false },
        });
    });

    it('preserves an issued mutation whose outcome cannot be confirmed', async () => {
        const serverId = await addHome('https://home-d.example');
        harness.answer(serverId, '/v1/teams/update', { dispatchThenFail: true });

        const outcome = await runTeamAction({
            scope: createServerAccountScope(serverId, 'account')!,
            actionId: 'teams.update',
            input: { v: 1, teamId: 'team-1', name: 'Platform' },
            parse: (value) => value,
        });

        expect(outcome).toEqual({
            kind: 'failed',
            failure: { kind: 'outcome_unknown', retryable: false, code: null },
        });
    });

});

describe('Home domain Action failure decoding', () => {
    it('preserves the canonical expired-approval refusal without disclosing an unvalidated detail bag', () => {
        expect(homeDomainFailureFromActionFailure({
            errorCode: 'approval_stale', details: { reason: 'credential_expired' },
        }, 'teams.credentials.entitled.list')).toEqual({
            kind: 'forbidden', retryable: false, code: 'approval_stale', details: { reason: 'credential_expired' },
        });
        expect(homeDomainFailureFromActionFailure({
            errorCode: 'approval_stale', details: { reason: 'credential_expired', undeclared: true },
        }, 'teams.credentials.entitled.list')).not.toHaveProperty('details');
    });

    it('inverts the family port encoding without inventing a second vocabulary', () => {
        expect(homeDomainFailureFromActionFailure({ errorCode: 'home_unreachable' }))
            .toEqual({ kind: 'unreachable', retryable: true, code: null });
        expect(homeDomainFailureFromActionFailure({ errorCode: 'home_conflict' }))
            .toEqual({ kind: 'conflict', retryable: false, code: null });
        expect(homeDomainFailureFromActionFailure({ errorCode: 'unsupported_action:teams.archive' }))
            .toEqual({ kind: 'unsupported', retryable: false, code: null });
        expect(homeDomainFailureFromActionFailure({ errorCode: 'outcome_unknown' }))
            .toEqual({ kind: 'outcome_unknown', retryable: false, code: null });
    });

    it('projects transport outcomes to stable consumer codes without flattening ambiguity', () => {
        expect(homeDomainFailureCode({ kind: 'outcome_unknown', retryable: false, code: null }))
            .toBe('outcome_unknown');
        expect(homeDomainFailureCode({ kind: 'unreachable', retryable: true, code: null }))
            .toBe('home_unreachable');
        expect(homeDomainFailureCode({ kind: 'forbidden', retryable: false, code: 'group_name_taken' }))
            .toBe('group_name_taken');
    });

    it('preserves a code the Home itself named rather than flattening it', () => {
        // The Home's own code is the most precise explanation available, so a
        // surface keeps the ability to explain the real refusal.
        expect(homeDomainFailureFromActionFailure({ errorCode: 'group_name_taken' }))
            .toEqual({ kind: 'conflict', retryable: false, code: 'group_name_taken' });
        expect(homeDomainFailureFromActionFailure({ errorCode: 'home_policy_invalid' }))
            .toEqual({ kind: 'invalid', retryable: false, code: 'home_policy_invalid' });
        // The Home answered with a resource refusal; an absent operation is
        // separately represented by unsupported_action above.
        expect(homeDomainFailureFromActionFailure({ errorCode: 'home_account_not_found' }))
            .toEqual({ kind: 'forbidden', retryable: false, code: 'home_account_not_found' });
        expect(homeDomainFailureFromActionFailure({ errorCode: 'home_policy_revision_conflict' }))
            .toEqual({ kind: 'conflict', retryable: false, code: 'home_policy_revision_conflict' });
    });

    it('preserves only canonical details that match the Action failure code', () => {
        const details = {
            v: 1,
            code: 'provider_endpoint_rate_limited',
            retryable: true,
            retryAfterMs: 1_500,
            action: 'retry',
        } as const;

        expect(homeDomainFailureFromActionFailure({
            errorCode: 'provider_endpoint_rate_limited',
            details,
        })).toEqual({
            kind: 'unknown',
            retryable: true,
            code: 'provider_endpoint_rate_limited',
            details,
        });

        expect(homeDomainFailureFromActionFailure({
            errorCode: 'provider_endpoint_unavailable',
            details,
        })).toEqual({ kind: 'unknown', retryable: false, code: 'provider_endpoint_unavailable' });
        expect(homeDomainFailureFromActionFailure({
            errorCode: 'provider_endpoint_rate_limited',
            details: { code: 'provider_endpoint_rate_limited', bearer: 'must-not-pass' },
        })).toEqual({ kind: 'unknown', retryable: false, code: 'provider_endpoint_rate_limited' });

        const authenticationDetails = {
            error: 'team_authentication_policy_unavailable',
            details: { reason: 'provider_test_required' },
        } as const;
        expect(homeDomainFailureFromActionFailure({
            errorCode: 'team_authentication_policy_unavailable',
            details: authenticationDetails,
        })).toEqual({
            kind: 'conflict',
            retryable: false,
            code: 'team_authentication_policy_unavailable',
            details: authenticationDetails,
        });
    });
});
