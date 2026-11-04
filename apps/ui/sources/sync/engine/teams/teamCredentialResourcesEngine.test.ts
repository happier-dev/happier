import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    TEAM_CREDENTIAL_ACTION_PATHS_V1,
    TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1,
    TeamCredentialResourceCatalogEntryV1Schema,
    TeamCredentialResourceSummaryV1Schema,
    teamCredentialResourcesQueryKeyV1,
} from '@happier-dev/protocol/teams';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { createDeferred, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
const { createTeamAddress } = await import('@/sync/domains/teams/teamAddress');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const {
    getTeamCredentialResourceCatalogSnapshot,
    getTeamCredentialResourceSnapshot,
    getTeamCredentialResourcesSnapshot,
    resetTeamsSnapshotsForTests,
} = await import('@/sync/store/teams/teamsSnapshots');
const {
    observeTeamCredentialResourceCatalog,
    observeTeamCredentialResource,
    observeTeamCredentialResources,
    resetTeamsDirectoryEngineForTests,
} = await import('./teamsDirectoryEngine');

let scope: ServerAccountScope;
let address: TeamAddress;
const LIST = TEAM_CREDENTIAL_ACTION_PATHS_V1['teams.credentials.list'];
const GET = TEAM_CREDENTIAL_ACTION_PATHS_V1['teams.credentials.get'];
const DISCOVER = TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1;
const viewer = { manageCredentials: true, offerOwnCredential: true };

function credentialResource(id: string, teamId = 'team-1') {
    return TeamCredentialResourceSummaryV1Schema.parse({
        id, teamId, custodianAccountId: 'account',
        displayName: 'Deep-linked credential', enabled: true, revision: 1,
        deliveryPolicy: { preferredAllowedModes: ['brokered'] }, sessionUsePolicy: 'personal_allowed',
        source: null,
        sourcePresentation: {
            kind: 'provider', provider: {
                identity: { pluginId: 'happier.provider.test', localId: 'provider' }, definitionRevision: 1,
            },
        },
        requestPolicy: null, brokerPlacement: null, allMembersAllowedRoutes: null,
        groupGrants: [], memberGrants: [], readiness: { kind: 'available' }, recoveryAction: null,
        brokerPresentation: { selectedTarget: null, eligibleTargets: [], selectedPool: null, eligiblePools: [] },
        createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    });
}

function catalogResource(id: string) {
    const resource = credentialResource(id);
    return TeamCredentialResourceCatalogEntryV1Schema.parse({
        id, teamId: resource.teamId, displayName: resource.displayName, resourceRevision: 1,
        readiness: resource.readiness, recoveryAction: null,
        mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered',
        sessionUsePolicy: 'personal_allowed', providerModels: [], connectedServiceSelections: [],
        sourcePresentation: resource.sourcePresentation,
    });
}

beforeEach(async () => {
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
    await home.reset();
    const serverId = await home.addHome({ name: 'Credentials Home', serverUrl: 'https://credentials-engine.example.test',
        accountId: 'account', teamsEnabled: true, credentialResourcesEnabled: true });
    scope = createServerAccountScope(serverId, 'account')!;
    address = createTeamAddress(serverId, 'team-1')!;
});

afterEach(async () => {
    standardCleanup();
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
    await home.reset();
});

describe('Team credential resource observations', () => {
    it.each(['list', 'detail', 'catalog'] as const)('releases an abandoned Ask-first credential %s before reobservation', async kind => {
        const actionId = kind === 'list' ? 'teams.credentials.list' : kind === 'detail' ? 'teams.credentials.get' : 'teams.credentials.entitled.list';
        const path = kind === 'list' ? LIST : kind === 'detail' ? GET : DISCOVER;
        const resource = credentialResource('resource-1');
        await home.requireUiApproval(scope.serverId, actionId);
        home.answer(scope.serverId, path, { body: kind === 'list' ? { resources: [resource], nextCursor: null, viewer }
            : kind === 'detail' ? resource : { resources: [catalogResource(resource.id)], nextCursor: null, failures: [] } });
        const observe = () => kind === 'list' ? observeTeamCredentialResources(scope, address)
            : kind === 'detail' ? observeTeamCredentialResource(scope, address, resource.id)
                : observeTeamCredentialResourceCatalog(scope, address);
        const read = () => kind === 'list' ? getTeamCredentialResourcesSnapshot(scope, address)
            : kind === 'detail' ? getTeamCredentialResourceSnapshot(scope, address, resource.id)
                : getTeamCredentialResourceCatalogSnapshot(scope, address);
        const first = observe();
        await waitForHomeGovernance(() => expect(home.artifacts(scope.serverId).list().length).toBe(1));
        first();
        const second = observe();
        try {
            await waitForHomeGovernance(() => expect(home.artifacts(scope.serverId).list().length).toBe(2));
            expect(home.requestsFor(path)).toHaveLength(0);
            await decideApprovalAsInbox(scope.serverId, home.artifacts(scope.serverId).list()[1]!.id, 'approve');
            await waitForHomeGovernance(() => expect(read()).toMatchObject({ status: 'ready', stale: false }));
            expect(home.requestsFor(path)).toHaveLength(1);
        } finally { second(); }
    });

    it('keeps the catalog set approval alive while another demanded Team still needs it', async () => {
        await home.requireUiApproval(scope.serverId, 'teams.credentials.entitled.list');
        const other = { ...address, teamId: 'team-2' };
        home.answer(scope.serverId, DISCOVER, { body: { resources: [], nextCursor: null, failures: [] } });
        const releaseFirst = observeTeamCredentialResourceCatalog(scope, address);
        const releaseOther = observeTeamCredentialResourceCatalog(scope, other);
        try {
            await waitForHomeGovernance(() => expect(home.artifacts(scope.serverId).list().length).toBe(1));
            releaseFirst();
            await decideApprovalAsInbox(scope.serverId, home.artifacts(scope.serverId).list()[0]!.id, 'approve');
            await waitForHomeGovernance(() => expect(getTeamCredentialResourceCatalogSnapshot(scope, other)).toMatchObject({ status: 'ready', stale: false }));
            expect(getTeamCredentialResourceCatalogSnapshot(scope, address)).toMatchObject({ data: null, stale: true });
            expect(home.requestsFor(DISCOVER)).toHaveLength(1);
        } finally { releaseFirst(); releaseOther(); }
    });

    it('reobserves one abandoned catalog without waiting for the shared set still needed by another Team', async () => {
        await home.requireUiApproval(scope.serverId, 'teams.credentials.entitled.list');
        const other = { ...address, teamId: 'team-2' };
        home.answer(scope.serverId, DISCOVER, { body: { resources: [], nextCursor: null, failures: [] } });
        const first = observeTeamCredentialResourceCatalog(scope, address);
        const releaseOther = observeTeamCredentialResourceCatalog(scope, other);
        let releaseReturned = () => {};
        try {
            await waitForHomeGovernance(() => expect(home.artifacts(scope.serverId).list().length).toBe(1));
            const original = home.artifacts(scope.serverId).list()[0]!;
            first();
            releaseReturned = observeTeamCredentialResourceCatalog(scope, address);
            await waitForHomeGovernance(() => expect(home.artifacts(scope.serverId).list().length).toBe(2));
            expect(home.requestsFor(DISCOVER)).toHaveLength(0);
            await decideApprovalAsInbox(scope.serverId, home.artifacts(scope.serverId).list()[1]!.id, 'approve');
            await waitForHomeGovernance(() => expect(getTeamCredentialResourceCatalogSnapshot(scope, address)).toMatchObject({ status: 'ready', stale: false }));
            const returned = getTeamCredentialResourceCatalogSnapshot(scope, address);
            expect(getTeamCredentialResourceCatalogSnapshot(scope, other)?.status).toBe('loading');
            await decideApprovalAsInbox(scope.serverId, original.id, 'approve');
            await waitForHomeGovernance(() => expect(getTeamCredentialResourceCatalogSnapshot(scope, other)).toMatchObject({ status: 'ready', stale: false }));
            expect(getTeamCredentialResourceCatalogSnapshot(scope, address)).toBe(returned);
            expect(home.requestsFor(DISCOVER)).toHaveLength(2);
        } finally { first(); releaseOther(); releaseReturned(); }
    });

    it('delivers each approved 50-Team application set to its still-mounted catalog without redispatch', async () => {
        await home.requireUiApproval(scope.serverId, 'teams.credentials.entitled.list');
        const addresses = Array.from({ length: 50 }, (_, index) => createTeamAddress(scope.serverId, `team-${index}`)!);
        const application = {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            implementationIdentity: { pluginId: 'happier.provider.test', localId: 'test' },
            endpointTemplateId: 'responses', protocol: 'openai-responses',
        } as const;
        home.answer(scope.serverId, DISCOVER, { select: input => ({ body: {
            resources: addresses.map(target => ({
                ...catalogResource(`${target.teamId}-${typeof input === 'object' && input !== null && 'application' in input ? 'app' : 'generic'}`),
                teamId: target.teamId,
            })), nextCursor: null, failures: [],
        } }) });
        const releases = addresses.flatMap(target => [
            observeTeamCredentialResourceCatalog(scope, target),
            observeTeamCredentialResourceCatalog(scope, target, application),
        ]);
        try {
            await waitForHomeGovernance(() => expect(home.artifacts(scope.serverId).list().length).toBe(2));
            expect(home.requestsFor(DISCOVER)).toHaveLength(0);
            for (const artifact of home.artifacts(scope.serverId).list()) {
                expect(await decideApprovalAsInbox(scope.serverId, artifact.id, 'approve')).toMatchObject({ ok: true });
            }
            await waitForHomeGovernance(() => {
                for (const target of addresses) for (const app of [undefined, application]) {
                    expect(getTeamCredentialResourceCatalogSnapshot(scope, target, app)?.status).not.toBe('loading');
                }
            });
            for (const target of addresses) for (const app of [undefined, application]) {
                expect(getTeamCredentialResourceCatalogSnapshot(scope, target, app))
                    .toMatchObject({ status: 'ready', stale: false,
                        data: [{ id: `${target.teamId}-${app ? 'app' : 'generic'}` }], error: null });
            }
            expect(home.artifacts(scope.serverId).list().length).toBe(2);
            const requests = home.requestsFor(DISCOVER);
            expect(requests).toHaveLength(2);
            expect(requests.map(request => request.input)).toEqual(expect.arrayContaining([
                expect.objectContaining({ teamIds: addresses.map(target => target.teamId) }),
                expect.objectContaining({ teamIds: addresses.map(target => target.teamId), application }),
            ]));
        } finally { releases.forEach(release => release()); }
    });

    it.each(['reject', 'cancel'] as const)('keeps a %s approval as the exact refusal for every Team in the set', async decision => {
        await home.requireUiApproval(scope.serverId, 'teams.credentials.entitled.list');
        const addresses = Array.from({ length: 50 }, (_, index) => createTeamAddress(scope.serverId, `team-${index}`)!);
        const releases = addresses.map(target => observeTeamCredentialResourceCatalog(scope, target));
        try {
            await waitForHomeGovernance(() => expect(home.artifacts(scope.serverId).list().length).toBe(1));
            const artifact = home.artifacts(scope.serverId).list()[0]!;
            expect(await decideApprovalAsInbox(scope.serverId, artifact.id, decision)).toMatchObject({ ok: true });
            await waitForHomeGovernance(() => {
                for (const target of addresses) expect(getTeamCredentialResourceCatalogSnapshot(scope, target)?.status).not.toBe('loading');
            });
            for (const target of addresses) expect(getTeamCredentialResourceCatalogSnapshot(scope, target))
                .toMatchObject({ status: 'error', data: null,
                    error: { kind: 'forbidden', retryable: false,
                        code: decision === 'reject' ? 'approval_rejected' : 'approval_canceled' } });
            expect(home.requestsFor(DISCOVER)).toHaveLength(0);
            expect(home.artifacts(scope.serverId).list().length).toBe(1);
        } finally { releases.forEach(release => release()); }
    });

    it('does not revive a catalog when its final observer leaves before the approved response', async () => {
        await home.requireUiApproval(scope.serverId, 'teams.credentials.entitled.list');
        const response = createDeferred<void>();
        home.answer(scope.serverId, DISCOVER, { body: { resources: [], nextCursor: null, failures: [] }, respondAfter: response.promise });
        const release = observeTeamCredentialResourceCatalog(scope, address);
        try {
            await waitForHomeGovernance(() => expect(home.artifacts(scope.serverId).list().length).toBe(1));
            const artifact = home.artifacts(scope.serverId).list()[0]!;
            const decision = decideApprovalAsInbox(scope.serverId, artifact.id, 'approve');
            await waitForHomeGovernance(() => expect(home.requestsFor(DISCOVER)).toHaveLength(1));
            release();
            response.resolve();
            await decision;
            expect(getTeamCredentialResourceCatalogSnapshot(scope, address)).toMatchObject({ data: null, stale: true });
            expect(home.requestsFor(DISCOVER)).toHaveLength(1);
        } finally { release(); response.resolve(); }
    });

    it('publishes a complete recipient catalog only after following continuation', async () => {
        const first = catalogResource('resource-1');
        const second = catalogResource('resource-2');
        home.answer(scope.serverId, DISCOVER, { select: input => ({ body: {
            resources: typeof input === 'object' && input !== null && 'cursor' in input ? [second] : [first],
            nextCursor: typeof input === 'object' && input !== null && 'cursor' in input ? null : 'catalog-page-2',
            failures: [],
        } }) });
        const application = {
            agentTargetKey: 'agent:happier.agent.codex/codex',
            implementationIdentity: { pluginId: 'happier.provider.test', localId: 'test' },
            endpointTemplateId: 'responses', protocol: 'openai-responses',
        } as const;
        const release = observeTeamCredentialResourceCatalog(scope, address, application);
        await waitForHomeGovernance(() => expect(getTeamCredentialResourceCatalogSnapshot(scope, address, application))
            .toMatchObject({ status: 'ready', data: [{ id: first.id }, { id: second.id }] }));
        expect(home.requestsFor(DISCOVER)[1]?.input).toMatchObject({ teamIds: [address.teamId], application, cursor: 'catalog-page-2' });
        expect(getTeamCredentialResourceCatalogSnapshot(scope, address)).toBeNull();
        release();
    });

    it('loads one exact resource independently of the first administration page and scopes it by Home, Account and Team', async () => {
        const resource = credentialResource('resource-51');
        home.answer(scope.serverId, GET, { body: resource });
        const release = observeTeamCredentialResource(scope, address, resource.id);
        await waitForHomeGovernance(() => expect(getTeamCredentialResourceSnapshot(scope, address, resource.id)?.status).toBe('ready'));
        expect(home.requestsFor(GET)[0]?.input).toMatchObject({ resourceId: resource.id });
        expect(getTeamCredentialResourceSnapshot(scope, address, resource.id)?.data).toEqual(resource);
        expect(getTeamCredentialResourcesSnapshot(scope, address)).toBeNull();
        expect(getTeamCredentialResourceSnapshot(createServerAccountScope(scope.serverId, 'other-account')!, address, resource.id)).toBeNull();
        expect(getTeamCredentialResourceSnapshot(scope, createTeamAddress(scope.serverId, 'other-team')!, resource.id)).toBeNull();
        release();
    });

    it.each([
        { name: 'Team', response: credentialResource('resource-shared', 'other-team') },
        { name: 'resource id', response: credentialResource('other-resource') },
    ])('rejects a successful exact response whose $name does not match the observed route', async ({ response }) => {
        home.answer(scope.serverId, GET, { body: response });
        const release = observeTeamCredentialResource(scope, address, 'resource-shared');
        await waitForHomeGovernance(() => expect(getTeamCredentialResourceSnapshot(scope, address, 'resource-shared')).toMatchObject({
            data: null, stale: false, status: 'error',
            error: { kind: 'forbidden', retryable: false, code: 'not_found_or_not_visible' },
        }));
        release();
    });

    it('keeps an exact not-visible answer typed and does not borrow another Team resource', async () => {
        home.answer(scope.serverId, GET, { status: 403, body: { error: 'not_found_or_not_visible' } });
        const release = observeTeamCredentialResource(scope, address, 'resource-hidden');
        await waitForHomeGovernance(() => expect(getTeamCredentialResourceSnapshot(scope, address, 'resource-hidden')).toMatchObject({
            data: null, stale: false, status: 'error',
            error: { kind: 'forbidden', retryable: false, code: 'not_found_or_not_visible' },
        }));
        release();
    });

    it('keys administration reads by filter while observing the recipient catalog once per Team', async () => {
        home.answer(scope.serverId, LIST, { body: { resources: [], nextCursor: null, viewer } });
        home.answer(scope.serverId, DISCOVER, { body: { resources: [], nextCursor: null, failures: [] } });
        const releaseCatalog = observeTeamCredentialResourceCatalog(scope, address);
        const releaseAll = observeTeamCredentialResources(scope, address);
        await waitForHomeGovernance(() => {
            expect(getTeamCredentialResourcesSnapshot(scope, address)?.status).toBe('ready');
            expect(getTeamCredentialResourceCatalogSnapshot(scope, address)?.status).toBe('ready');
        });
        releaseAll();
        const releaseFiltered = observeTeamCredentialResources(scope, address, 'claude', 'brokered');
        const filteredKey = teamCredentialResourcesQueryKeyV1({ teamId: address.teamId, search: 'claude', filter: 'brokered' });
        await waitForHomeGovernance(() => expect(getTeamCredentialResourcesSnapshot(scope, address, filteredKey)?.status).toBe('ready'));
        expect(home.requestsFor(LIST)).toHaveLength(2);
        expect(home.requestsFor(LIST)[1]?.input).toMatchObject({ search: 'claude', filter: 'brokered' });
        expect(home.requestsFor(DISCOVER)).toHaveLength(1);
        releaseFiltered();
        releaseCatalog();
    });

    it('refreshes both projections on invalidation and retains admin rows while catalog selection fails closed', async () => {
        const resource = credentialResource('resource-1');
        home.answer(scope.serverId, LIST, { body: { resources: [resource], nextCursor: null, viewer } });
        home.answer(scope.serverId, DISCOVER, { body: { resources: [catalogResource(resource.id)], nextCursor: null, failures: [] } });
        const releaseCatalog = observeTeamCredentialResourceCatalog(scope, address);
        const releaseAdmin = observeTeamCredentialResources(scope, address);
        await waitForHomeGovernance(() => {
            expect(getTeamCredentialResourcesSnapshot(scope, address)?.status).toBe('ready');
            expect(getTeamCredentialResourceCatalogSnapshot(scope, address)?.status).toBe('ready');
        });
        home.answer(scope.serverId, DISCOVER, { dispatchThenFail: true });
        publishHomeAccountChange(scope.serverId);
        await waitForHomeGovernance(() => {
            expect(home.requestsFor(LIST)).toHaveLength(2);
            expect(home.requestsFor(DISCOVER)).toHaveLength(2);
            expect(getTeamCredentialResourceCatalogSnapshot(scope, address)?.status).toBe('error');
        });
        expect(getTeamCredentialResourcesSnapshot(scope, address)).toMatchObject({ status: 'ready', stale: false, data: [{ id: resource.id }] });
        expect(getTeamCredentialResourceCatalogSnapshot(scope, address)).toMatchObject({ status: 'error', stale: true, data: [{ id: resource.id }] });
        releaseAdmin();
        releaseCatalog();
    });
});
