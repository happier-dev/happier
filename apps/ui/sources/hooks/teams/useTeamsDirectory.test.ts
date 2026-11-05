import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as React from 'react';
import { NO_TEAM_CAPABILITIES_V1, TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, TeamCredentialResourceDiscoverInputV1Schema, TeamCredentialResourceDiscoveryPageV1Schema, TeamsListInputV1Schema, teamDirectoryQueryKeyV1, type TeamSummaryV1 } from '@happier-dev/protocol/teams';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { HomeGovernanceEligibilityV1Schema, HomeGovernanceProjectionV1Schema } from '@happier-dev/protocol/home/governance';

const runtimeFetchMock = vi.hoisted(() => vi.fn());

// `@/auth/storage/tokenStorage` is an internal domain owner, not a boundary, and a hoisted
// `vi.mock` factory for it deadlocks any suite that also imports `@/dev/testkit`: the barrel
// value-imports `TokenStorage`, so the factory's own dynamic import waits on an evaluation that
// can never finish, and module evaluation is not covered by any Vitest timeout — the file simply
// never collects. The rule and its measurement live at
// `activity/badges/activityBadgeRuntimeTestHelpers.ts#installBadgeHomeIdentities`. The device
// credential store is spied on instead, which is the one thing here that genuinely leaves the
// process.

import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { readAccountAgentProviderRequirements, readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';

import { act } from 'react-test-renderer';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createDeferred, createRenderCommitCounter, homeGovernanceProjectionFixture, renderHook, renderScreen, useRenderCommitCounter } from '@/dev/testkit';
import { createHomeGovernanceHarness, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import {
    resetServerFeaturesClientForTests,
} from '@/sync/api/capabilities/serverFeaturesClient';
import { resolveServerProfileScopeIdForIdentifier, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { updateEffectiveHomeViewState } from '@/sync/domains/server/selection/homeViewSelectionState';
import { resetTeamsDirectoryEngineForTests } from '@/sync/engine/teams/teamsDirectoryEngine';
import { applyTeamCredentialResourceCatalog, applyTeamProjection, applyTeamsDirectoryPage, getTeamCredentialResourceCatalogSnapshot, getTeamsDirectorySnapshot, invalidateTeamCredentialResourceCatalog, resetTeamsSnapshotsForTests } from '@/sync/store/teams/teamsSnapshots';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { resetHomeGovernanceEngineForTests } from '@/sync/engine/home/governance/homeGovernanceEngine';
import { resetHomeGovernanceEligibilityEngineForTests } from '@/sync/engine/home/governance/homeGovernanceEligibilityEngine';
import { clearHomeGovernanceSnapshotsForServer } from '@/sync/store/home/governance/homeGovernanceSnapshots';
import { resetHomeGovernanceEligibilitySnapshotsForTests } from '@/sync/store/home/governance/homeGovernanceEligibilitySnapshots';
import { useHomeAdministrationSettingsAdmission } from '@/hooks/home/useHomeAdministrationSettingsAdmission';

import { useTeamsDirectory } from './useTeamsDirectory';
import { useHomeTeamCredentialModelCatalog } from './useHomeTeamCredentialModelCatalog';
import { useTeamsDestinationShown } from './useTeamsDestinationShown';

const directoryHome = createHomeGovernanceHarness();

function team(id: string, name = `Team ${id}`, archivedAt: number | null = null): TeamSummaryV1 {
    return {
        id,
        name,
        description: null,
        logo: null,
        archivedAt,
        recovery: null,
        policy: {
            v: 1,
            sessionCreationPolicy: 'team_default',
            externalSharingPolicy: 'allowed',
            defaultSessionHistoryAccess: 'from_membership',
            admissionMode: 'invite_only',
            authenticationPolicy: null,
        },
        viewerRole: 'member',
        capabilities: NO_TEAM_CAPABILITIES_V1,
        admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
        counts: null,
    };
}

async function addHome(name: string, serverUrl: string, teamsEnabled: boolean): Promise<string> {
    const id = await directoryHome.addHome({ name, serverUrl, teamsEnabled,
        accountId: 'account', currentAccount: true, credentialResourcesEnabled: true });
    await updateEffectiveHomeViewState((current) => ({
        ...current, activeTargetKind: 'server', activeTargetId: id,
    }), { scope: 'device' });
    return id;
}

let getCredentialsForServerUrlMock: MockInstance<typeof TokenStorage.getCredentialsForServerUrl>;

beforeEach(async () => {
    await directoryHome.reset();
    runtimeFetchMock.mockReset();
    getCredentialsForServerUrlMock = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
    getCredentialsForServerUrlMock.mockImplementation(async url => {
        const token = directoryHome.findByServerUrl(url)?.token;
        return token ? { token } : null;
    });
    // Only the Team directory HTTP leaf is varied by these cases. The real
    // Action owner also reads Account settings/currentness before dispatch.
    setRuntimeFetch((input, init) => {
        const url = String(input);
        return new URL(url).pathname === '/v1/teams/list'
            ? runtimeFetchMock({ url, init }) : directoryHome.request(input, init);
    });
    resetServerFeaturesClientForTests();
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
});

afterEach(async () => {
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
    resetServerFeaturesClientForTests();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetRuntimeFetch();
    await directoryHome.reset();
});

describe('useTeamsDirectory', () => {
    it('renders only addressed directory changes, including equal-time same-sized pages and cursor changes', async () => {
        const home = await addHome('Home A', 'https://home-a.example', true);
        await setActiveServerId(home, { scope: 'device' });
        const items = Array.from({ length: 400 }, (_, i) => team(`t${i}`));
        runtimeFetchMock.mockImplementation(async () => new Response(
            JSON.stringify({ items, nextCursor: null }), { status: 200 },
        ));
        const counter = createRenderCommitCounter();
        const rendered = await renderHook(() => {
            useRenderCommitCounter(counter);
            return useTeamsDirectory();
        });
        await waitForHomeGovernance(() => expect(rendered.getCurrent().rows).toHaveLength(400));
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(home), accountId: 'account' };
        const queryKey = teamDirectoryQueryKeyV1({ v: 1, scope: 'member', archived: 'active' });
        const snapshot = getTeamsDirectorySnapshot(scope, queryKey);
        if (!snapshot) throw new Error('Expected admitted directory');
        counter.reset();
        for (let i = 0; i < 100; i += 1) {
            await act(async () => applyTeamProjection({ scope,
                address: { serverId: scope.serverId, teamId: `other-${i}` },
                team: team(`other-${i}`), observedAt: i,
            }));
        }
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        const changed = items.map((row, i) => i === 200 ? { ...row, name: 'Renamed' } : row);
        await act(async () => applyTeamsDirectoryPage({ scope, queryKey,
            items: changed, observedAt: snapshot.lastObservedAt ?? 0,
        }));
        expect(counter.read()).toEqual({ renders: 1, commits: 1 });
        expect(rendered.getCurrent().rows[200]?.team.name).toBe('Renamed');
        await act(async () => applyTeamsDirectoryPage({ scope, queryKey,
            items: changed, nextCursor: 'next-page', observedAt: snapshot.lastObservedAt ?? 0,
        }));
        expect(rendered.getCurrent().hasMore).toBe(true);
        await rendered.unmount();
    });

    it('combines all directory sequences and continues each cursor independently', async () => {
        const home = await addHome('Home A', 'https://home-a.example', true);
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async (request) => {
            const input = TeamsListInputV1Schema.parse(JSON.parse(String(request.init.body)));
            const archived = input.archived === 'archived';
            const id = `${input.archived}-${input.cursor ? '2' : '1'}`;
            return new Response(JSON.stringify({
                items: [team(id, id, archived ? 1 : null)],
                nextCursor: input.cursor ? null : `${input.archived}-next`,
            }), { status: 200 });
        });
        const rendered = await renderHook(() => useTeamsDirectory({ archived: 'all' }));
        try {
            await waitForHomeGovernance(() => {
                expect(rendered.getCurrent().rows.map((row) => row.team.name)).toEqual(['active-1']);
                expect(rendered.getCurrent().archivedRows.map((row) => row.team.name)).toEqual(['archived-1']);
            });
            expect(rendered.getCurrent().partial).toBe(false);
            expect(rendered.getCurrent().hasMore).toBe(true);
            await act(async () => { rendered.getCurrent().loadMore(); });
            await waitForHomeGovernance(() => {
                expect(rendered.getCurrent().rows.map((row) => row.team.name)).toEqual(['active-1', 'active-2']);
                expect(rendered.getCurrent().archivedRows.map((row) => row.team.name)).toEqual(['archived-1', 'archived-2']);
                expect(rendered.getCurrent().hasMore).toBe(false);
            });
            const continuations = runtimeFetchMock.mock.calls
                .map(([request]) => TeamsListInputV1Schema.parse(JSON.parse(String(request.init.body))))
                .filter((input) => input.cursor)
                .map((input) => [input.archived, input.cursor]);
            expect(continuations).toEqual(expect.arrayContaining([
                ['active', 'active-next'], ['archived', 'archived-next'],
            ]));
        } finally {
            await rendered.unmount();
        }
    });

    it('keeps answered rows while the other sequence loads, fails and retries', async () => {
        const home = await addHome('Home A', 'https://home-a.example', true);
        await setActiveServerId(home, { scope: 'device' });
        const archivedPage = createDeferred<Response>();
        let retrying = false;
        runtimeFetchMock.mockImplementation(async (request) => {
            const input = TeamsListInputV1Schema.parse(JSON.parse(String(request.init.body)));
            if (input.archived === 'archived' && !retrying) {
                return archivedPage.promise;
            }
            return new Response(JSON.stringify({
                items: [team(input.archived, input.archived, input.archived === 'archived' ? 1 : null)],
                nextCursor: null,
            }), { status: 200 });
        });
        const rendered = await renderHook(() => useTeamsDirectory({ archived: 'all' }));
        try {
            await waitForHomeGovernance(() => expect(rendered.getCurrent().rows).toHaveLength(1));
            expect(rendered.getCurrent().kind).toBe('ready');
            expect(rendered.getCurrent().partial).toBe(true);
            expect(rendered.getCurrent().unavailableHomes).toEqual([
                expect.objectContaining({ serverId: home, reason: 'loading' }),
            ]);
            await act(async () => { archivedPage.reject(new Error('network down')); });
            await waitForHomeGovernance(() => expect(rendered.getCurrent().unavailableHomes).toEqual([
                expect.objectContaining({ serverId: home, reason: 'offline', retryable: true }),
            ]));
            expect(rendered.getCurrent().rows).toHaveLength(1);
            retrying = true;
            await act(async () => { rendered.getCurrent().refresh(); });
            await waitForHomeGovernance(() => {
                expect(rendered.getCurrent().archivedRows).toHaveLength(1);
                expect(rendered.getCurrent().partial).toBe(false);
                expect(rendered.getCurrent().unavailableHomes).toEqual([]);
            });
            expect(rendered.getCurrent().rows).toHaveLength(1);
        } finally {
            archivedPage.resolve(new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }));
            await rendered.unmount();
        }
    });

    it('binds a local Home alias to its published identity without borrowing the focused Home Account', async () => {
        const home = createHomeGovernanceHarness();
        const named = await home.addHome({ name: 'Named Home', serverUrl: 'https://team-alias.example',
            serverIdentityId: 'srv_team_alias', accountId: 'named-account', currentAccount: true,
            teamsEnabled: true, credentialResourcesEnabled: true });
        await home.addHome({ name: 'Focused Home', serverUrl: 'https://team-focused.example',
            serverIdentityId: 'srv_team_focused', accountId: 'focused-account', currentAccount: true,
            teamsEnabled: true, credentialResourcesEnabled: true });
        expect(named).not.toBe('srv_team_alias');
        home.answer(named, '/v1/teams/list', { body: { items: [team('shared-id', 'Named Team')], nextCursor: null } });
        home.answer(named, TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, { body: TeamCredentialResourceDiscoveryPageV1Schema.parse({ resources: [], nextCursor: null, failures: [] }) });
        home.answer(named, bindHomeDomainActionHttpRequestV1('home.governance.get', {}).path, {
            body: HomeGovernanceProjectionV1Schema.parse(homeGovernanceProjectionFixture({
                viewer: { accountId: 'named-account', homeRole: 'owner', status: 'active' },
            })),
        });
        home.answer(named, bindHomeDomainActionHttpRequestV1('home.governance.eligibility.get', {}).path, {
            body: HomeGovernanceEligibilityV1Schema.parse({ teamsEnabled: true, createTeam: true,
                createTeamForChosenAccount: false, showTeams: true }),
        });
        getCredentialsForServerUrlMock.mockImplementation(async (url) => {
            const token = home.findByServerUrl(url)?.token;
            return token ? { token } : null;
        });
        runtimeFetchMock.mockImplementation(async (request) => {
            const headers = new Headers(request.init?.headers);
            if (request.token) headers.set('Authorization', `Bearer ${request.token}`);
            return home.request(request.url, { ...request.init, headers });
        });
        // Action preparation uses the real endpoint fetch, below the reachability
        // fetch used by directory reads. Both HTTP leaves answer from the same Home.
        setRuntimeFetch((input, init) => home.request(input, init));
        const rendered = await renderHook(() => ({
            directory: useTeamsDirectory({ serverIds: [named] }),
            catalog: useHomeTeamCredentialModelCatalog({ serverId: named, enabled: true }),
            shown: useTeamsDestinationShown([named]),
            administration: useHomeAdministrationSettingsAdmission({ serverIds: [named] }),
        }));
        try {
            await waitForHomeGovernance(() => expect(rendered.getCurrent().directory.rows).toHaveLength(1));
            expect(rendered.getCurrent().directory.rows[0]?.address).toEqual({ serverId: named, teamId: 'shared-id' });
            expect(rendered.getCurrent().directory.scopes).toEqual([{ serverId: 'srv_team_alias', accountId: 'named-account' }]);
            await waitForHomeGovernance(() => expect(rendered.getCurrent().catalog.current).toBe(true));
            expect(rendered.getCurrent().catalog.teamNameById).toEqual({ 'shared-id': 'Named Team' });
            await waitForHomeGovernance(() => expect(rendered.getCurrent().shown).toBe(true));
            await waitForHomeGovernance(() => expect(rendered.getCurrent().administration.admittedServerIds).toEqual([named]));
            const reads = home.requests.filter((request) => request.path.startsWith('/v1/teams'));
            expect(reads.length).toBeGreaterThan(1);
            expect(reads.every((request) => request.serverId === named
                && request.token === home.findByServerUrl('https://team-alias.example')?.token)).toBe(true);
            expect(home.requests.filter((request) => request.path.startsWith('/v1/home/governance')).every((request) => request.serverId === named
                && request.token === home.findByServerUrl('https://team-alias.example')?.token)).toBe(true);
        } finally {
            await rendered.unmount();
            resetRuntimeFetch();
            resetHomeGovernanceEngineForTests();
            resetHomeGovernanceEligibilityEngineForTests();
            clearHomeGovernanceSnapshotsForServer('srv_team_alias');
            resetHomeGovernanceEligibilitySnapshotsForTests();
            await home.reset();
        }
    });

    it.each(['bundled', 'installed'] as const)('loads and reloads the %s Agent application without sharing generic or other Agent catalog rows', async (source) => {
        const home = createHomeGovernanceHarness();
        const serverId = await home.addHome({ name: 'Catalog Home', serverUrl: 'https://team-models.example',
            serverIdentityId: 'srv_team_models', accountId: 'account', currentAccount: true,
            teamsEnabled: true, credentialResourcesEnabled: true });
        home.answer(serverId, '/v1/teams/list', { body: { items: [team('team-1')], nextCursor: null } });
        const path = TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1;
        let revision = 1;
        let applicationFailureStatus: number | null = null;
        let applicationUnreachable = false;
        let respondAfter: Promise<void> | undefined;
        const agentKey = (id: string) => source === 'installed' ? `agent:acme.agents/${id}` : `agent:happier.agent.${id}/${id}`;
        const multiProtocolAgent = agentKey('opencode');
        const definition = readAccountProviderDeclarations({ kind: 'account' }).find(row => row.definition.managedRuntime)!.definition;
        const declarationProjection = source === 'installed' ? PluginProjectionV2Schema.parse({ v: 2, generation: 7,
            agentsById: Object.fromEntries(['codex', 'claude', 'opencode'].map(id => [id, { id,
                identity: { pluginId: 'acme.agents', localId: id },
                providerRequirements: readAccountAgentProviderRequirements(`agent:happier.agent.${id}/${id}`, { kind: 'account' }),
            }])),
            familiesById: { providers: { family: 'providers', entriesById: {
                'acme.gateway/managed': { id: 'acme.gateway/managed', pluginId: 'acme.gateway',
                    provenance: 'external', sourceKind: 'path', definition: { ...definition, id: 'managed' } },
            } } },
        }) : null;
        home.answer(serverId, path, { select: (input) => {
            const { application } = TeamCredentialResourceDiscoverInputV1Schema.parse(input);
            if (application && applicationUnreachable) throw new TypeError('fetch failed');
            if (application && applicationFailureStatus) return { respondAfter, status: applicationFailureStatus,
                body: { error: applicationFailureStatus === 403 ? 'forbidden' : 'unavailable' } };
            const modelId = application?.agentTargetKey === multiProtocolAgent ? 'shared-model'
                : application ? `${application.protocol}-${revision}` : '';
            const resource = {
                id: 'shared', teamId: 'team-1', displayName: 'Shared gateway', resourceRevision: revision,
                readiness: { kind: 'available' }, recoveryAction: null,
                mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered',
                sessionUsePolicy: 'personal_allowed', providerModels: application ? [{
                    selection: { kind: 'team_credential_provider_model', teamId: 'team-1', resourceId: 'shared',
                        expectedResourceRevision: revision, agentTargetKey: application.agentTargetKey, modelId, deliveryMode: 'brokered' },
                    descriptor: { id: modelId, name: modelId }, application, sourceRevision: `source-${revision}`, availability: 'available',
                }] : [], connectedServiceSelections: [],
                sourcePresentation: { kind: 'provider', provider: { identity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' }, definitionRevision: 1 } },
            };
            return { respondAfter, body: TeamCredentialResourceDiscoveryPageV1Schema.parse({ resources: application ? [resource]
                : [resource, { ...resource, id: 'generic-only',
                    sourcePresentation: { kind: 'connected_service', service: { pluginId: 'happier.service.test', localId: 'chat' } },
                    connectedServiceSelections: [{ source: 'team_resource', resourceId: 'generic-only', deliveryMode: 'brokered' }],
                }], nextCursor: null, failures: [] }) };
        } });
        getCredentialsForServerUrlMock.mockImplementation(async (url) => {
            const token = home.findByServerUrl(url)?.token;
            return token ? { token } : null;
        });
        runtimeFetchMock.mockImplementation(async (request) => {
            const headers = new Headers(request.init?.headers);
            if (request.token) headers.set('Authorization', `Bearer ${request.token}`);
            return home.request(request.url, { ...request.init, headers });
        });
        setRuntimeFetch((input, init) => home.request(input, init));
        const codex = agentKey('codex');
        const claude = agentKey('claude');
        const { SessionModelPicker } = await import('@/components/sessions/modelPicker/SessionModelPicker');
        const { sessionModelSelectionKey } = await import('@/components/sessions/modelPicker/sessionModelSelectionKey');
        const onSelect = vi.fn();
        const catalogCounter = createRenderCommitCounter();
        let current!: { selected: ReturnType<typeof useHomeTeamCredentialModelCatalog>; generic: ReturnType<typeof useHomeTeamCredentialModelCatalog> };
        function CatalogPicker({ agentTargetKey }: { agentTargetKey: string }) {
            useRenderCommitCounter(catalogCounter);
            current = {
                selected: useHomeTeamCredentialModelCatalog({ serverId, enabled: true, agentTargetKey, declarationProjection,
                    machineId: source === 'installed' ? 'installed-machine' : null }),
                generic: useHomeTeamCredentialModelCatalog({ serverId, enabled: true }),
            };
            return React.createElement(SessionModelPicker, {
                agentTargetKey, declarationContext: source === 'installed' ? { kind: 'machine', projection: declarationProjection } : { kind: 'account' },
                nativeModels: [], providerGroups: [], providerProjectionAuthoritative: true,
                selected: null, onSelect, onSelectTeamCredentialModel: onSelect,
                teamCredentialResources: current.selected.resources,
                currentTeamCredentialResourceKeys: current.selected.currentResourceKeys,
            });
        }
        const screen = await renderScreen(React.createElement(CatalogPicker, { agentTargetKey: codex }));
        const rendered = {
            getCurrent: () => current,
            rerender: async (props: { agentTargetKey: string }) => { await act(async () => { screen.update(React.createElement(CatalogPicker, props)); }); },
            unmount: () => screen.unmount(),
        };
        const models = () => rendered.getCurrent().selected.resources.flatMap(row => row.providerModels.map(model => model.descriptor.id));
        try {
            await waitForHomeGovernance(() => expect(rendered.getCurrent().selected.current).toBe(true));
            expect(models()).toEqual(['openai-responses-1']);
            expect(rendered.getCurrent().selected.resources.map(row => row.id)).toEqual(['shared', 'generic-only']);
            expect(rendered.getCurrent().selected.resources[1]?.connectedServiceSelections).toEqual([
                { source: 'team_resource', resourceId: 'generic-only', deliveryMode: 'brokered' },
            ]);
            expect(rendered.getCurrent().generic.resources.flatMap(row => row.providerModels)).toEqual([]);
            const catalogScope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'account' };
            const catalogAddress = { serverId: catalogScope.serverId, teamId: 'team-1' };
            const catalogSnapshot = getTeamCredentialResourceCatalogSnapshot(catalogScope, catalogAddress);
            if (!catalogSnapshot?.data) throw new Error('Expected admitted generic catalog');
            const equalProjection = rendered.getCurrent().generic;
            catalogCounter.reset();
            await act(async () => applyTeamCredentialResourceCatalog({
                scope: catalogScope, address: catalogAddress,
                resources: structuredClone(catalogSnapshot.data!),
                observedAt: (catalogSnapshot.lastObservedAt ?? 0) + 1,
            }));
            expect(catalogCounter.read()).toEqual({ renders: 0, commits: 0 });
            expect(rendered.getCurrent().generic).toBe(equalProjection);
            catalogCounter.reset();
            await act(async () => applyTeamCredentialResourceCatalog({
                scope: catalogScope, address: catalogAddress,
                resources: catalogSnapshot.data!.map((row) => row.id === 'generic-only'
                    ? { ...row, displayName: 'Same-time renamed credential' } : row),
                observedAt: catalogSnapshot.lastObservedAt ?? 0,
            }));
            expect(catalogCounter.read()).toEqual({ renders: 1, commits: 1 });
            expect(rendered.getCurrent().generic.resources.find((row) => row.id === 'generic-only')?.displayName)
                .toBe('Same-time renamed credential');
            await rendered.rerender({ agentTargetKey: claude });
            expect(models().some(id => id.startsWith('openai-responses'))).toBe(false);
            await waitForHomeGovernance(() => expect(rendered.getCurrent().selected.current).toBe(true));
            expect(models()).toEqual(['anthropic-1']);
            revision = 2;
            await act(async () => { await rendered.getCurrent().selected.reload(); });
            await waitForHomeGovernance(() => expect(rendered.getCurrent().selected.current).toBe(true));
            expect(models()).toEqual(['anthropic-2']);
            expect(rendered.getCurrent().generic.resources.flatMap(row => row.providerModels)).toEqual([]);
            await rendered.rerender({ agentTargetKey: codex });
            await waitForHomeGovernance(() => expect(rendered.getCurrent().selected.current).toBe(true));
            expect(models()).toEqual(['openai-responses-2']);
            const reads = home.requests.filter(request => request.path === path);
            expect(reads.some(request => JSON.stringify(request.input).includes('cliproxyapi-openai-responses'))).toBe(true);
            if (source === 'installed') expect(reads.some(request => JSON.stringify(request.input).includes('acme.gateway'))).toBe(true);
            await rendered.rerender({ agentTargetKey: multiProtocolAgent });
            await waitForHomeGovernance(() => expect(rendered.getCurrent().selected.current).toBe(true));
            expect(models()).toEqual(['shared-model']);
            const model = rendered.getCurrent().selected.resources[0]?.providerModels[0];
            expect(model?.application.endpointTemplateId).toBe('cliproxyapi-openai-responses');
            if (!model) throw new Error('Expected admitted Team model');
            const optionId = `model-picker-overlay-option:${sessionModelSelectionKey(model.selection)}`;
            const expectSelectable = () => {
                expect(screen.findByTestId(optionId)).not.toBeNull();
                expect(screen.findByTestId(optionId)?.props.disabled).not.toBe(true);
            };
            expectSelectable();
            expect(rendered.getCurrent().selected.currentResourceKeys.has('team-1:generic-only')).toBe(true);
            // A pending reread is not a refused catalog. Keep the exact offered
            // model selectable until the Home answers, including a wake that
            // arrives while this refresh is in flight.
            const refreshAnswer = createDeferred<void>();
            respondAfter = refreshAnswer.promise;
            let refreshing!: Promise<void>;
            await act(async () => { refreshing = rendered.getCurrent().selected.reload(); });
            expect(rendered.getCurrent().selected.currentResourceKeys.has('team-1:shared')).toBe(true);
            await act(async () => { publishHomeAccountChange(serverId); });
            expect(rendered.getCurrent().selected.currentResourceKeys.has('team-1:shared')).toBe(true);
            respondAfter = undefined;
            await act(async () => { refreshAnswer.resolve(); await refreshing; });
            await waitForHomeGovernance(() => expect(rendered.getCurrent().selected.current).toBe(true));
            // Explicit invalidation still withdraws a stale model observation.
            await act(async () => {
                const canonicalServerId = resolveServerProfileScopeIdForIdentifier(serverId);
                expect(invalidateTeamCredentialResourceCatalog({ serverId: canonicalServerId, accountId: 'account' },
                    { serverId: canonicalServerId, teamId: 'team-1' }, model!.application)).toBe(true);
            });
            expect(rendered.getCurrent().selected.currentResourceKeys.has('team-1:shared')).toBe(false);
            await act(async () => { await rendered.getCurrent().selected.reload(); });
            expect(rendered.getCurrent().selected.currentResourceKeys.has('team-1:shared')).toBe(true);
            applicationFailureStatus = 503;
            await act(async () => { await rendered.getCurrent().selected.reload(); });
            expect(rendered.getCurrent().selected.current).toBe(false);
            expect(models()).toEqual(['shared-model']);
            expect(rendered.getCurrent().selected.currentResourceKeys.has('team-1:shared')).toBe(true);
            expect(rendered.getCurrent().selected.currentResourceKeys.has('team-1:generic-only')).toBe(true);
            expectSelectable();
            await screen.pressByTestIdAsync(optionId);
            expect(onSelect).toHaveBeenLastCalledWith(model.selection);
            const retryAnswer = createDeferred<void>();
            respondAfter = retryAnswer.promise;
            applicationFailureStatus = null;
            await act(async () => { publishHomeAccountChange(serverId, undefined, { source: 'connected' }); });
            expectSelectable();
            respondAfter = undefined;
            await act(async () => { retryAnswer.resolve(); });
            await waitForHomeGovernance(() => expect(rendered.getCurrent().selected.current).toBe(true));
            applicationUnreachable = true;
            await act(async () => { await rendered.getCurrent().selected.reload(); });
            expect(rendered.getCurrent().selected.currentResourceKeys.has('team-1:shared')).toBe(false);
            expect(screen.findByTestId(optionId)?.props.disabled).toBe(true);
            onSelect.mockClear();
            await screen.pressByTestIdAsync(optionId);
            expect(onSelect).not.toHaveBeenCalled();
            const reconnectAnswer = createDeferred<void>();
            applicationUnreachable = false;
            respondAfter = reconnectAnswer.promise;
            await act(async () => { publishHomeAccountChange(serverId, undefined, { source: 'connected' }); });
            // A reconnect requests revalidation; it cannot itself revive an unavailable choice.
            expect(screen.findByTestId(optionId)?.props.disabled).toBe(true);
            respondAfter = undefined;
            await act(async () => { reconnectAnswer.resolve(); });
            await waitForHomeGovernance(() => expect(rendered.getCurrent().selected.current).toBe(true));
            expectSelectable();
            applicationFailureStatus = 403;
            await act(async () => { await rendered.getCurrent().selected.reload(); });
            expect(models()).toEqual([]);
            await rendered.rerender({ agentTargetKey: 'agent:acme.unknown/agent' });
            expect(models()).toEqual([]);
            expect(rendered.getCurrent().selected.current).toBe(false);
            // Generic Connected Account choices are independent of Agent model requirements.
            expect(rendered.getCurrent().selected.resources.find(row => row.id === 'generic-only')
                ?.connectedServiceSelections).toEqual([
                { source: 'team_resource', resourceId: 'generic-only', deliveryMode: 'brokered' },
            ]);
            expect(rendered.getCurrent().selected.currentResourceKeys.has('team-1:generic-only')).toBe(true);
        } finally {
            await rendered.unmount();
            resetRuntimeFetch();
            await home.reset();
        }
    });

    it('projects a failed Team credential discovery and retries the directory even with no resource rows', async () => {
        const home = await addHome('Home A', 'https://home-a.example', true);
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockRejectedValue(new Error('network down'));
        const rendered = await renderHook(() => useHomeTeamCredentialModelCatalog({ serverId: home, enabled: true }));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().condition).toEqual({ reason: 'offline', retryable: true }));
        expect(rendered.getCurrent().resources).toEqual([]);
        runtimeFetchMock.mockResolvedValue(new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }));
        await act(async () => { await rendered.getCurrent().reload(); });
        await waitForHomeGovernance(() => expect(rendered.getCurrent().current).toBe(true));
        expect(rendered.getCurrent().condition).toBeNull();
        await rendered.unmount();
    });

    it('does not claim a disabled Team credential catalog is stale or loading', async () => {
        const home = await addHome('Home A', 'https://home-a.example', true);
        await setActiveServerId(home, { scope: 'device' });
        const rendered = await renderHook(() => useHomeTeamCredentialModelCatalog({ serverId: null, enabled: false }));
        expect(rendered.getCurrent().condition).toBeNull();
        expect(runtimeFetchMock).not.toHaveBeenCalled();
        await rendered.unmount();
    });
    it('reads each capable Home as the Account that Home is signed in as', async () => {
        const home = await addHome('Home A', 'https://home-a.example', true);
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => new Response(
            JSON.stringify({ items: [team('t1', 'Acme')], nextCursor: null }),
            { status: 200 },
        ));

        const rendered = await renderHook(() => useTeamsDirectory());
        await waitForHomeGovernance(() => {
            expect(rendered.getCurrent().rows).toHaveLength(1);
        });

        const current = rendered.getCurrent();
        expect(current.kind).toBe('ready');
        expect(current.rows[0]?.address).toEqual({ serverId: home, teamId: 't1' });
        expect(current.rows[0]?.homeName).toBe('Home A');
        expect(runtimeFetchMock.mock.calls.some(([request]) => request.url === 'https://home-a.example/v1/teams/list')).toBe(true);
        await rendered.unmount();
    });

    it('settles a Home whose saved credential this device cannot read, and re-reads it on Retry', async () => {
        const home = await addHome('Home A', 'https://home-a.example', true);
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => new Response(
            JSON.stringify({ items: [team('t1', 'Acme')], nextCursor: null }),
            { status: 200 },
        ));
        getCredentialsForServerUrlMock.mockImplementation(async (
            _serverUrl: string,
            options?: Readonly<{ storageReadFailure?: 'absent' | 'surface' }>,
        ) => {
            if (options?.storageReadFailure === 'surface') throw new Error('secure storage read failed');
            return null;
        });

        const rendered = await renderHook(() => useTeamsDirectory());
        // Neither a spinner that never settles nor a silent sign-out.
        await waitForHomeGovernance(() => {
            expect(rendered.getCurrent().unavailableHomes).toEqual([
                expect.objectContaining({ serverId: home, reason: 'credential_unreadable', retryable: true }),
            ]);
        });
        expect(runtimeFetchMock).not.toHaveBeenCalled();

        getCredentialsForServerUrlMock.mockImplementation(async url => {
            const token = directoryHome.findByServerUrl(url)?.token;
            return token ? { token } : null;
        });
        await act(async () => {
            rendered.getCurrent().refresh();
        });
        await waitForHomeGovernance(() => {
            expect(rendered.getCurrent().rows).toHaveLength(1);
        });
        expect(rendered.getCurrent().unavailableHomes).toEqual([]);
        await rendered.unmount();
    });

    it('never asks a Home whose feature decision refused Teams', async () => {
        const refusing = await addHome('Home B', 'https://home-b.example', false);
        await setActiveServerId(refusing, { scope: 'device' });

        const rendered = await renderHook(() => useTeamsDirectory());
        // Nothing is claimed about a Home that said no, and nothing is asked of
        // it: an admission refusal is a settled answer, not an empty directory.
        await waitForHomeGovernance(() => expect(rendered.getCurrent().kind).toBe('loading'));
        expect(runtimeFetchMock).not.toHaveBeenCalled();
        expect(rendered.getCurrent().rows).toEqual([]);
        expect(rendered.getCurrent().unavailableHomes).toEqual([]);
        await rendered.unmount();
    });

    it('names a Home that could not answer instead of showing an empty directory', async () => {
        const home = await addHome('Home A', 'https://home-a.example', true);
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => {
            throw new Error('network down');
        });

        const rendered = await renderHook(() => useTeamsDirectory());
        await waitForHomeGovernance(() => {
            expect(rendered.getCurrent().unavailableHomes).toEqual([
                expect.objectContaining({ reason: 'offline' }),
            ]);
        });

        const current = rendered.getCurrent();
        expect(current.rows).toEqual([]);
        expect(current.partial).toBe(true);
        // "No Teams" would be a false statement about a Home that never answered.
        expect(current.kind).not.toBe('empty');
        expect(current.unavailableHomes[0]).toMatchObject({
            serverId: home,
            homeName: 'Home A',
            reason: 'offline',
            retryable: true,
        });
        await rendered.unmount();
    });

    it('reads the exact Home a Home-scoped surface named even when the view selection is elsewhere', async () => {
        // The Home administration Teams list is *about* Home A. Which Home the
        // person happens to be looking at is a different question, and letting
        // it decide here is what made that screen claim "no Teams".
        const administered = await addHome('Home A', 'https://home-a.example', true);
        const focused = await addHome('Home B', 'https://home-b.example', true);
        await setActiveServerId(focused, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => new Response(
            JSON.stringify({ items: [team('t1', 'Acme')], nextCursor: null }),
            { status: 200 },
        ));

        const rendered = await renderHook(() => useTeamsDirectory({
            scope: 'administered',
            serverIds: [administered],
        }));
        await waitForHomeGovernance(() => {
            expect(rendered.getCurrent().rows).toHaveLength(1);
        });

        expect(rendered.getCurrent().rows[0]?.address).toEqual({ serverId: administered, teamId: 't1' });
        // The named Home is the only Home asked; naming one never widens the read.
        expect(runtimeFetchMock.mock.calls.every(
            (call) => String(call[0]?.url).startsWith('https://home-a.example/'),
        )).toBe(true);
        await rendered.unmount();
    });

    it('still refuses a named Home whose own feature decision said no', async () => {
        const named = await addHome('Home A', 'https://home-a.example', false);
        const focused = await addHome('Home B', 'https://home-b.example', true);
        await setActiveServerId(focused, { scope: 'device' });

        const rendered = await renderHook(() => useTeamsDirectory({
            scope: 'administered',
            serverIds: [named],
        }));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().kind).toBe('loading'));
        expect(runtimeFetchMock).not.toHaveBeenCalled();
        await rendered.unmount();
    });

    it('requests the archived sequence only once that section is opened', async () => {
        const home = await addHome('Home A', 'https://home-a.example', true);
        await setActiveServerId(home, { scope: 'device' });
        runtimeFetchMock.mockImplementation(async () => new Response(
            JSON.stringify({ items: [], nextCursor: null }),
            { status: 200 },
        ));

        const disabled = await renderHook(() => useTeamsDirectory({ archived: 'archived', enabled: false }));
        expect(runtimeFetchMock).not.toHaveBeenCalled();
        expect(disabled.getCurrent().kind).toBe('loading');
        await disabled.unmount();

        const opened = await renderHook(() => useTeamsDirectory({ archived: 'archived' }));
        await waitForHomeGovernance(() => {
            expect(runtimeFetchMock).toHaveBeenCalled();
        });
        const listRequest = runtimeFetchMock.mock.calls.find(([request]) => request.url === 'https://home-a.example/v1/teams/list')?.[0];
        expect(listRequest).toBeDefined();
        expect(JSON.parse(String(listRequest.init.body))).toMatchObject({
            scope: 'member',
            archived: 'archived',
        });
        await opened.unmount();
    });
});
