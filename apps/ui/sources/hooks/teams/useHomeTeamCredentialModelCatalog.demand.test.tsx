import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';

import { createDeferred, renderHook, standardCleanup, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { useHomeTeamCredentialModelCatalog } = await import('./useHomeTeamCredentialModelCatalog');
const { observeTeamCredentialResourceCatalog, refreshTeamCredentialResourceCatalog, resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { getTeamCredentialResourceCatalogSnapshot, resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');

const LIST = '/v1/teams/credential-resources/entitled/list';
const DISCOVER = '/v1/teams/credential-resources/entitled/discover';
const catalogRequests = () => [...home.requestsFor(LIST), ...home.requestsFor(DISCOVER)];

beforeEach(async () => {
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
    resetTeamActionClientForTests();
    await home.reset();
});

afterEach(async () => {
    standardCleanup();
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
    resetTeamActionClientForTests();
    await home.reset();
});

describe('Account-scoped Team credential catalog demand', () => {
    it('admits Connected Service credentials only for the selected Agent, including populated broker model catalogs', async () => {
        const serverId = await home.addHome({ name: 'Agent-scoped Home', serverUrl: 'https://agent-catalog.example.test',
            accountId: 'account-ada', teamsEnabled: true, credentialResourcesEnabled: true });
        home.answer(serverId, '/v1/teams/list', { body: { items: [teamSummaryFixture({ id: 'team-1' })], nextCursor: null } });
        const codex = 'agent:happier.agent.codex/codex';
        const resources = [
            ['codex', 'happier.agent.codex', 'openai-codex'],
            ['claude', 'happier.agent.claude', 'claude-subscription'],
            ['foreign-service', 'foreign.plugin', 'openai-codex'],
        ].map(([id, pluginId, localId]) => TeamCredentialResourceCatalogEntryV1Schema.parse({
            id, teamId: 'team-1', displayName: id, resourceRevision: 1,
            readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
            directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', connectedServiceSelections: [],
            sourcePresentation: { kind: 'connected_service', service: { pluginId, localId } },
            // A compatible broker can project Claude models for Codex. The source
            // credential's declared service must still apply to that Agent.
            providerModels: [{ selection: { kind: 'team_credential_provider_model', teamId: 'team-1', resourceId: id,
                expectedResourceRevision: 1, deliveryMode: 'brokered', agentTargetKey: codex, modelId: `${id}-model` },
                descriptor: { id: `${id}-model`, name: `${id} model` },
                application: { agentTargetKey: codex, implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
                    endpointTemplateId: 'responses', protocol: 'openai-responses' }, sourceRevision: 'source-1', availability: 'available' }],
        }));
        resources.push(TeamCredentialResourceCatalogEntryV1Schema.parse({ ...resources[1], id: 'claude-empty', providerModels: [] }));
        home.answer(serverId, LIST, { body: { resources, nextCursor: null } });
        home.answer(serverId, DISCOVER, { body: { resources, nextCursor: null, failures: [] } });
        const catalog = await renderHook(() => ({
            codex: useHomeTeamCredentialModelCatalog({ serverId, enabled: true, agentTargetKey: codex, declarationProjection: null }),
            claude: useHomeTeamCredentialModelCatalog({ serverId, enabled: true,
                agentTargetKey: 'agent:happier.agent.claude/claude', declarationProjection: null }),
            generic: useHomeTeamCredentialModelCatalog({ serverId, enabled: true }),
        }));
        await waitForHomeGovernance(() => {
            expect(catalog.getCurrent().codex.current).toBe(true);
            expect(catalog.getCurrent().claude.current).toBe(true);
            expect(catalog.getCurrent().generic.current).toBe(true);
        });
        expect(catalog.getCurrent().codex.resources.map(resource => resource.id)).toEqual(['codex']);
        expect(catalog.getCurrent().claude.resources.map(resource => resource.id)).toEqual(['claude', 'claude-empty']);
        expect(catalog.getCurrent().generic.resources.map(resource => resource.id)).toEqual(['codex', 'claude', 'foreign-service', 'claude-empty']);
    });

    it('keeps execution-Machine entitlement batches and retained results separate', async () => {
        const serverId = await home.addHome({ name: 'Machine-scoped Home', serverUrl: 'https://catalog-machines.example.test',
            accountId: 'account-ada', teamsEnabled: true, credentialResourcesEnabled: true });
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'account-ada' };
        const address = { serverId: scope.serverId, teamId: 'team-1' };
        home.answer(serverId, DISCOVER, { body: { resources: [], failures: [], nextCursor: null } });
        const releases = ['machine-a', 'machine-b'].map(machineId =>
            observeTeamCredentialResourceCatalog(scope, address, undefined, machineId));
        try {
            await Promise.all(['machine-a', 'machine-b'].map(machineId =>
                refreshTeamCredentialResourceCatalog(scope, address, undefined, machineId)));
            expect(home.requestsFor(DISCOVER).map(request => request.input)).toEqual(expect.arrayContaining([
                expect.objectContaining({ teamIds: ['team-1'], executionMachineId: 'machine-a' }),
                expect.objectContaining({ teamIds: ['team-1'], executionMachineId: 'machine-b' }),
            ]));
            expect(home.requestsFor(DISCOVER)).toHaveLength(2);
            const first = getTeamCredentialResourceCatalogSnapshot(scope, address, undefined, 'machine-a');
            const second = getTeamCredentialResourceCatalogSnapshot(scope, address, undefined, 'machine-b');
            expect(first?.selectionCurrent).toBe(true);
            expect(second?.selectionCurrent).toBe(true);
            expect(first).not.toBe(second);
        } finally { releases.forEach(release => release()); }
    });

    it.each([6, 40])('opens %i Teams with one read per application and stays quiet without a Team wake', async teamCount => {
        const serverId = await home.addHome({ name: 'Catalog Home', serverUrl: `https://catalog-${teamCount}.example.test`,
            accountId: 'account-ada', teamsEnabled: true, credentialResourcesEnabled: true });
        home.answer(serverId, '/v1/teams/list', { body: {
            items: Array.from({ length: teamCount }, (_, index) => teamSummaryFixture({ id: `team-${index}` })), nextCursor: null,
        } });
        home.answer(serverId, LIST, { body: { resources: [], nextCursor: null } });
        home.answer(serverId, DISCOVER, { body: { resources: [], nextCursor: null, failures: [] } });
        // Real admission awaits an Account settings HTTP read. Independently
        // settled responses must not split one known catalog demand into N reads.
        home.answer(serverId, '/v2/account/settings', { select: () => ({
            respondAfter: new Promise<void>(resolve => setImmediate(resolve)),
            body: { content: null, version: 0 },
        }) });

        const catalog = await renderHook(() => useHomeTeamCredentialModelCatalog({ serverId, enabled: true,
            agentTargetKey: 'agent:happier.agent.codex/codex', declarationProjection: null }));
        await waitForHomeGovernance(() => expect(catalog.getCurrent().current).toBe(true));
        // Generic Connected Account discovery plus the two bundled Codex applications;
        // physical request count must be independent of Team membership count.
        expect(catalogRequests()).toHaveLength(3);
        for (const request of home.requestsFor(DISCOVER)) {
            expect(request.input).toMatchObject({ teamIds: Array.from({ length: teamCount }, (_, index) => `team-${index}`) });
        }

        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
        try {
            await act(async () => {
                for (let minute = 0; minute < 5; minute += 1) {
                    publishHomeAccountChange(serverId, [`session-${minute}`, `machine-${minute}`]);
                    await vi.advanceTimersByTimeAsync(60_000);
                }
            });
            expect(catalogRequests()).toHaveLength(3);
            expect(catalog.getCurrent().current).toBe(true);
        } finally { vi.useRealTimers(); }

        // A real reconnect remains a freshness boundary. It revalidates every
        // demanded Team's authority, but still gathers each application once.
        await act(async () => { publishHomeAccountChange(serverId, undefined, { source: 'connected' }); });
        await waitForHomeGovernance(() => {
            expect(catalog.getCurrent().current).toBe(true);
            expect(catalogRequests()).toHaveLength(6);
        });
    });

    it('drains one shared page sequence, keeps each Team refusal and cancels abandoned continuations', async () => {
        const serverId = await home.addHome({ name: 'Catalog Home', serverUrl: 'https://catalog-pages.example.test',
            accountId: 'account-ada', teamsEnabled: true, credentialResourcesEnabled: true });
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'account-ada' };
        const addresses = ['team-1', 'team-2', 'team-3'].map(teamId => ({ serverId: scope.serverId, teamId }));
        const held = createDeferred<void>();
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: 'resource-1', teamId: 'team-1', displayName: 'Shared', resourceRevision: 1,
            readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
            directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
            providerModels: [], connectedServiceSelections: [],
            sourcePresentation: { kind: 'connected_service', service: { pluginId: 'happier.service.test', localId: 'chat' } } });
        home.answer(serverId, DISCOVER, { select: input => {
            const cursor = typeof input === 'object' && input !== null && 'cursor' in input ? input.cursor : null;
            return cursor ? { respondAfter: held.promise, body: { resources: [{ ...resource, id: 'resource-2', teamId: 'team-2' }],
                failures: [], nextCursor: null } }
                : { body: { resources: [resource], failures: [{ teamId: 'team-3', error: 'not_found_or_not_visible' }], nextCursor: 'next-page' } };
        } });
        const releases = addresses.map(address => observeTeamCredentialResourceCatalog(scope, address));
        await waitForHomeGovernance(() => expect(home.requestsFor(DISCOVER)).toHaveLength(2));
        expect(getTeamCredentialResourceCatalogSnapshot(scope, addresses[0]!)?.selectionCurrent).toBe(false);
        await act(async () => { held.resolve(); });
        await waitForHomeGovernance(() => {
            expect(getTeamCredentialResourceCatalogSnapshot(scope, addresses[0]!)?.data?.map(row => row.id)).toEqual(['resource-1']);
            expect(getTeamCredentialResourceCatalogSnapshot(scope, addresses[1]!)?.data?.map(row => row.id)).toEqual(['resource-2']);
            expect(getTeamCredentialResourceCatalogSnapshot(scope, addresses[2]!)?.error).toMatchObject({ kind: 'forbidden', code: 'not_found_or_not_visible' });
        });
        releases.forEach(release => release());

        // A later observer gap owns a new read. Leaving all targets while its
        // second page is pending must not launch the advertised third page.
        const pending = createDeferred<void>();
        home.answer(serverId, DISCOVER, { select: input => {
            const cursor = typeof input === 'object' && input !== null && 'cursor' in input ? input.cursor : null;
            return cursor ? { respondAfter: pending.promise, body: { resources: [], failures: [], nextCursor: 'unused-third-page' } }
                : { body: { resources: [], failures: [], nextCursor: 'next-page' } };
        } });
        const resumed = addresses.map(address => observeTeamCredentialResourceCatalog(scope, address));
        await waitForHomeGovernance(() => expect(home.requestsFor(DISCOVER)).toHaveLength(4));
        resumed.forEach(release => release());
        await act(async () => { pending.resolve(); });
        expect(home.requestsFor(DISCOVER)).toHaveLength(4);
    });

    it('keeps unsupported and refused discovery typed without retrying a different transport', async () => {
        const serverId = await home.addHome({ name: 'Older Home', serverUrl: 'https://catalog-old.example.test',
            accountId: 'account-ada', teamsEnabled: true, credentialResourcesEnabled: true });
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'account-ada' };
        home.answer(serverId, DISCOVER, { status: 404, body: { statusCode: 404, error: 'Not Found', message: 'Route not found' } });
        home.answer(serverId, LIST, { body: { resources: [], nextCursor: null } });
        const addresses = ['team-1', 'team-2'].map(teamId => ({ serverId: scope.serverId, teamId }));
        const releases = addresses.map(address => observeTeamCredentialResourceCatalog(scope, address));
        await Promise.all(addresses.map(address => refreshTeamCredentialResourceCatalog(scope, address)));
        expect(addresses.map(address => getTeamCredentialResourceCatalogSnapshot(scope, address)?.error?.kind)).toEqual(['unsupported', 'unsupported']);
        expect(home.requestsFor(DISCOVER)).toHaveLength(1);
        expect(home.requestsFor(LIST)).toHaveLength(0);
        releases.forEach(release => release());

        home.answer(serverId, DISCOVER, { status: 403, body: { error: 'forbidden' } });
        const next = addresses.map(address => observeTeamCredentialResourceCatalog(scope, address));
        await Promise.all(addresses.map(address => refreshTeamCredentialResourceCatalog(scope, address)));
        expect(addresses.map(address => getTeamCredentialResourceCatalogSnapshot(scope, address)?.error?.kind)).toEqual(['forbidden', 'forbidden']);
        expect(home.requestsFor(DISCOVER)).toHaveLength(2);
        expect(home.requestsFor(LIST)).toHaveLength(0);
        next.forEach(release => release());

        home.answer(serverId, DISCOVER, { body: { resources: [], nextCursor: null,
            failures: addresses.map(address => ({ teamId: address.teamId, error: 'team_authentication_policy_unavailable' })) } });
        const temporary = addresses.map(address => observeTeamCredentialResourceCatalog(scope, address));
        await Promise.all(addresses.map(address => refreshTeamCredentialResourceCatalog(scope, address)));
        for (const address of addresses) {
            expect(getTeamCredentialResourceCatalogSnapshot(scope, address)?.error).toMatchObject({
                code: 'team_authentication_policy_unavailable', retryable: true,
            });
        }
        expect(home.requestsFor(LIST)).toHaveLength(0);
        temporary.forEach(release => release());
    });

    it('withdraws an abandoned set while real asynchronous Action admission is pending', async () => {
        const serverId = await home.addHome({ name: 'Pending Home', serverUrl: 'https://catalog-abandoned.example.test',
            accountId: 'account-ada', teamsEnabled: true, credentialResourcesEnabled: true });
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'account-ada' };
        const held = createDeferred<void>();
        home.answer(serverId, '/v2/account/settings', { respondAfter: held.promise, body: { content: null, version: 0 } });
        home.answer(serverId, DISCOVER, { body: { resources: [], nextCursor: null, failures: [] } });
        const addresses = ['team-1', 'team-2'].map(teamId => ({ serverId: scope.serverId, teamId }));
        const releases = addresses.map(address => observeTeamCredentialResourceCatalog(scope, address));
        const completed = Promise.all(addresses.map(address => refreshTeamCredentialResourceCatalog(scope, address)));
        await waitForHomeGovernance(() => expect(home.requestsFor('/v2/account/settings').length).toBeGreaterThan(0));
        releases.forEach(release => release());
        held.resolve();
        await completed;
        expect(catalogRequests()).toHaveLength(0);
        for (const address of addresses) expect(getTeamCredentialResourceCatalogSnapshot(scope, address)?.selectionCurrent).toBe(false);
    });

    it('settles an independent Home without waiting for another Home catalog', async () => {
        const scopes: Parameters<typeof refreshTeamCredentialResourceCatalog>[0][] = [];
        for (const name of ['held', 'ready']) {
            const serverId = await home.addHome({ name, serverUrl: `https://catalog-${name}.example.test`,
                accountId: 'account-ada', teamsEnabled: true, credentialResourcesEnabled: true });
            scopes.push({ serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'account-ada' });
        }
        const held = createDeferred<void>();
        home.answer(scopes[0]!.serverId, DISCOVER, { respondAfter: held.promise, body: { resources: [], failures: [], nextCursor: null } });
        home.answer(scopes[1]!.serverId, DISCOVER, { body: { resources: [], failures: [], nextCursor: null } });
        const addresses = scopes.map(scope => ({ serverId: scope.serverId, teamId: 'team-1' }));
        const releases = scopes.map((scope, index) => observeTeamCredentialResourceCatalog(scope, addresses[index]!));
        const waiting = refreshTeamCredentialResourceCatalog(scopes[0]!, addresses[0]!);
        let completed = false;
        const ready = refreshTeamCredentialResourceCatalog(scopes[1]!, addresses[1]!).then(() => { completed = true; });
        try {
            await waitForHomeGovernance(() => {
                expect(getTeamCredentialResourceCatalogSnapshot(scopes[1]!, addresses[1]!)?.selectionCurrent).toBe(true);
                expect(completed).toBe(true);
            });
        } finally {
            releases.forEach(release => release());
            held.resolve();
            await Promise.all([waiting, ready]);
        }
    });

    it('keeps the original read Action policy ahead of discovery transport', async () => {
        const serverId = await home.addHome({ name: 'Policy Home', serverUrl: 'https://catalog-policy.example.test',
            accountId: 'account-ada', teamsEnabled: true, credentialResourcesEnabled: true, currentAccount: true });
        await home.requireUiApproval(serverId, 'teams.credentials.entitled.list');
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'account-ada' };
        const addresses = Array.from({ length: 6 }, (_, index) => ({ serverId: scope.serverId, teamId: `team-${index}` }));
        const releases = addresses.map(address => observeTeamCredentialResourceCatalog(scope, address));
        try {
            await waitForHomeGovernance(() => expect(home.artifacts(serverId).list()).toHaveLength(1));
            expect(home.requestsFor(DISCOVER)).toHaveLength(0);
            expect(home.requestsFor(LIST)).toHaveLength(0);
            for (const address of addresses) expect(getTeamCredentialResourceCatalogSnapshot(scope, address))
                .toMatchObject({ status: 'loading', selectionCurrent: false });
            const artifact = home.artifacts(serverId).list()[0]!;
            expect(JSON.parse(home.artifacts(serverId).readPlainBody(artifact.id)!)).toMatchObject({
                actionId: 'teams.credentials.entitled.list', actionArgs: { teamIds: addresses.map(address => address.teamId) },
            });
            expect(await decideApprovalAsInbox(serverId, artifact.id, 'reject')).toMatchObject({ ok: true });
            await waitForHomeGovernance(() => {
                for (const address of addresses) expect(getTeamCredentialResourceCatalogSnapshot(scope, address))
                    .toMatchObject({ status: 'error', selectionCurrent: false, error: { code: 'approval_rejected' } });
            });
            expect(catalogRequests()).toHaveLength(0);
            expect(home.artifacts(serverId).list()).toHaveLength(1);
        } finally { releases.forEach(release => release()); }
    });
});
