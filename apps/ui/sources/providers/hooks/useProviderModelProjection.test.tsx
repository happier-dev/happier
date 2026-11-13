import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1} from '@happier-dev/protocol/providers/errors';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { projectAgentProviderBrokerApplications } from '@happier-dev/protocol/providers/catalog/brokerApplicationProjectionV1';
import { parseProviderContributionIdentityV1 } from '@happier-dev/protocol/providers/contribution-identity';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';

import { createProviderModelProjectionFixture, createProviderModelProjectionGroupFixture, createProviderSettingsAccountHarness,
    createProviderSettingsHarness, installProviderSettingsRpcBoundary, installBundledProviderDeclarationsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpc/errors';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox, installOwnMachineApprovalReplayBoundary } from '@/dev/testkit/harness/approvalInbox';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const { describeProviderModels, projectionRequests } = vi.hoisted(() => ({
    describeProviderModels: vi.fn(),
    projectionRequests: [] as Readonly<{ serverId: string | null; payload: unknown }>[],
}));
// The Socket boundary alone supplies daemon answers; Action/Machine admission and the resource store stay real.
const rpc = createProviderSettingsHarness({ machines: ['machine-a', 'machine-b'].map(id => createMachineFixture({ id, activeAt: Date.now() })) });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
let serverId = '';

function projection(connectionIds: readonly string[] = []) {
    return createProviderModelProjectionFixture({
        agentTargetKey: 'agent:happier.agent.codex/codex',
        groups: connectionIds.map((connectionId) => createProviderModelProjectionGroupFixture({ connectionId })),
    });
}

const { useProviderModelProjection } = await import('./useProviderModelProjection');
const { useProviderConnectionModels } = await import('./useProviderConnectionModels');
await loadSyncSingletonForTests();

afterEach(async () => {
    standardCleanup();
    await account.reset();
    rpc.reset();
    describeProviderModels.mockReset();
    projectionRequests.length = 0;
});
beforeEach(async () => {
    rpc.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, request => {
        projectionRequests.push(request);
        return describeProviderModels(request.payload);
    });
    serverId = (await account.restore({ waivedActions: ['providers.models.refresh'] })).serverId;
});

describe('useProviderModelProjection', () => {
    describe.each(['projection', 'connection-list'] as const)('%s query retention', kind => {
        type QueryProps = { connectionId: string; active?: boolean };
        type QueryData = ReturnType<typeof useProviderModelProjection>['data'] | ReturnType<typeof useProviderConnectionModels>['models'];
        const useRead: (props: QueryProps) => QueryData = kind === 'projection'
            ? function useProjectionQuery(props: QueryProps) {
                return useProviderModelProjection({ enabled: true, machineId: 'machine-a', serverId, active: props.active,
                    agentTargetKey: 'agent:happier.agent.codex/codex', sourceConnectionId: props.connectionId }).data;
            }
            : function useConnectionListQuery(props: QueryProps) {
                const { models } = useProviderConnectionModels({ enabled: true, machineId: 'machine-a', serverId, ...props });
                return models.length ? models : null;
            };
        beforeEach(() => {
            describeProviderModels.mockResolvedValue(projection(['pc_result']));
            rpc.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODELS, request => ({ status: 'success', connectionId: (request.payload as { connectionId: string }).connectionId,
                connectionRevision: 1, manualModelPolicy: 'allowed', modelLoadAction: 'descriptor_absent',
                models: [{ id: 'model-a', source: 'probe', stale: false, loadState: 'unknown', visibility: 'visible' }] }));
        });

        it('releases superseded query snapshots as one mounted reader changes A to B to C', async () => {
            const reader = await renderHook(useRead, { initialProps: { connectionId: 'pc_a' } });
            await flushHookEffects();
            expect(reader.getCurrent()).not.toBeNull();
            await reader.rerender({ connectionId: 'pc_b' });
            await flushHookEffects();
            expect(reader.getCurrent()).not.toBeNull();
            await reader.rerender({ connectionId: 'pc_c' });
            await flushHookEffects();
            const current = reader.getCurrent();
            expect(current).not.toBeNull();
            for (const connectionId of ['pc_a', 'pc_b', 'pc_c']) {
                const retained = await renderHook(useRead, { initialProps: { connectionId, active: false } });
                expect(retained.getCurrent()).toBe(connectionId === 'pc_c' ? current : null);
                await retained.unmount();
            }
        });

        it('keeps another observer’s old query and retains it when that observer unmounts', async () => {
            const reader = await renderHook(useRead, { initialProps: { connectionId: 'pc_a' } });
            await flushHookEffects();
            const peer = await renderHook(useRead, { initialProps: { connectionId: 'pc_a' } });
            await flushHookEffects();
            const previous = peer.getCurrent();
            expect(previous).not.toBeNull();
            await reader.rerender({ connectionId: 'pc_b' });
            await flushHookEffects();
            expect(peer.getCurrent()).toBe(previous);
            await peer.unmount();
            const reopened = await renderHook(useRead, { initialProps: { connectionId: 'pc_a', active: false } });
            expect(reopened.getCurrent()).toBe(previous);
        });
    });

    it('preserves a failed Machine declaration projection instead of reporting model catalog loading', async () => {
        await account.reset();
        serverId = (await account.restore({ features: createRootLayoutFeaturesResponse({ features: {
            providers: { enabled: true }, teams: { enabled: true, credentialResources: { enabled: true, externalApi: { enabled: false } } },
        } }) })).serverId;
        account.home.answer(serverId, '/v1/teams/list', { body: { items: [], nextCursor: null } });
        rpc.intercept(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, () => {
            throw new RpcError('Machine transport unavailable', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE);
        });
        const { useHomeTeamCredentialModelCatalog } = await import('@/hooks/teams/useHomeTeamCredentialModelCatalog');
        const { useDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/useDaemonMergedProjectionInputs');
        const hook = await renderHook(() => ({
            projection: useDaemonMergedProjectionInputs({ serverId, machineId: 'machine-a', sections: 'complete' }),
            catalog: useHomeTeamCredentialModelCatalog({ serverId, enabled: true, machineId: 'machine-a',
                agentTargetKey: 'agent:happier.agent.codex/codex' }),
        }));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().projection).toMatchObject({
                phase: 'error', failureReason: 'transport-unavailable',
            }));
            await waitForHomeGovernance(() => expect(hook.getCurrent().catalog.condition).toMatchObject({
                reason: 'error', retryable: true,
            }));
            expect(hook.getCurrent().catalog.current).toBe(false);
            installBundledProviderDeclarationsRpcBoundary(rpc);
            await act(async () => { await hook.getCurrent().catalog.reload(); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().catalog).toMatchObject({
                current: true, condition: null,
            }));
        } finally { await hook.unmount(); }
    });

    it('renders the existing delivery owner batch from Home discovery and never falls back when an older Machine omits it', async () => {
        await account.reset();
        serverId = (await account.restore({ features: createRootLayoutFeaturesResponse({ features: {
            providers: { enabled: true }, teams: { enabled: true, credentialResources: { enabled: true, externalApi: { enabled: false } } },
        } }) })).serverId;
        const { readAccountAgentProviderRequirements, readAccountProviderDeclarations } = await import('@/providers/catalog/accountProviderDeclarations');
        const { getBundledAgentDeclaration } = await import('@/agents/registry/registryCore');
        const { qualifyPluginContributionReferenceV1 } = await import('@happier-dev/protocol/plugins/contribution-identity');
        const agentTargetKey = 'agent:happier.agent.codex/codex';
        const agentDeclaration = getBundledAgentDeclaration('codex')!;
        const connectedAccounts = agentDeclaration.connectedAccounts.map(purpose => ({ ...purpose,
            service: qualifyPluginContributionReferenceV1(purpose.service, agentDeclaration.identity.pluginId),
        }));
        const requirements = readAccountAgentProviderRequirements(agentTargetKey, { kind: 'account' })!;
        const declarations = readAccountProviderDeclarations({ kind: 'account' });
        const applications = projectAgentProviderBrokerApplications({ agentTargetKey, acceptedProtocols: requirements.acceptsProtocols,
            providers: declarations.flatMap(declaration => {
                const parsed = parseProviderContributionIdentityV1(declaration.contributionKey);
                return parsed ? [{ identity: parsed.identity, definition: declaration.definition }] : [];
            }) });
        const application = applications[0]!;
        expect(application).toBeDefined();
        const declaration = declarations.find(candidate => {
            const parsed = parseProviderContributionIdentityV1(candidate.contributionKey);
            return parsed?.identity.pluginId === application.implementationIdentity.pluginId
                && parsed.identity.localId === application.implementationIdentity.localId;
        })!;
        const declarationProjection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            agentsById: { codex: { id: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                providerRequirements: requirements, connectedAccounts } },
            familiesById: { providers: { family: 'providers', entriesById: { [declaration.contributionKey]: {
                id: declaration.contributionKey, pluginId: application.implementationIdentity.pluginId,
                provenance: declaration.provenance, sourceKind: 'path', definition: declaration.definition,
            } } } },
        });
        const rawBasis = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: 'shared', teamId: 'team-1', displayName: 'Gateway', resourceRevision: 1,
            deliveryPolicy: { preferredAllowedModes: ['vendor-native', 'brokered'] }, allowedRoutes: ['vendor-native', 'brokered'],
            readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
            directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', connectedServiceSelections: [],
            sourcePresentation: { kind: 'connected_service', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
            providerModels: [{ descriptor: { id: 'model-a', name: 'Shared model' }, sourceRevision: 'source-1', application, availability: 'available',
                selection: { kind: 'team_credential_provider_model', teamId: 'team-1', resourceId: 'shared', expectedResourceRevision: 1,
                    deliveryMode: 'brokered', agentTargetKey, modelId: 'model-a' } }],
        });
        const firstRow = rawBasis.providerModels[0]!;
        const raw = TeamCredentialResourceCatalogEntryV1Schema.parse({ ...rawBasis, providerModels: [
            firstRow,
            { ...firstRow, application: { ...application, endpointTemplateId: `${application.endpointTemplateId}-alternate` } },
            { ...firstRow, sourceRevision: 'source-2', nativeSource: { providerTicket: 'u'.repeat(43) } },
        ] });
        const resolved = TeamCredentialResourceCatalogEntryV1Schema.parse({ ...raw,
            providerModels: raw.providerModels.slice(0, 1).map(row => ({ ...row, selection: { ...row.selection, deliveryMode: 'vendor-native' },
                nativeSource: { providerTicket: 't'.repeat(43) } })),
        });
        account.home.answer(serverId, '/v1/teams/list', { body: { items: [teamSummaryFixture()], nextCursor: null } });
        account.home.answer(serverId, '/v1/teams/credential-resources/entitled/discover', { body: { resources: [raw], nextCursor: null, failures: [] } });
        describeProviderModels.mockResolvedValue({ ...projection(), teamCredentialResources: [resolved] });
        const { useHomeTeamCredentialModelCatalog } = await import('@/hooks/teams/useHomeTeamCredentialModelCatalog');
        const hook = await renderHook(() => useHomeTeamCredentialModelCatalog({ serverId, enabled: true, machineId: 'machine-a',
            agentTargetKey, declarationProjection }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().current).toBe(true));
        expect(hook.getCurrent().resources[0]?.providerModels.map(row => row.selection.deliveryMode)).toEqual(['vendor-native']);
        expect(projectionRequests).toHaveLength(1);
        expect.soft(projectionRequests[0]?.payload).toMatchObject({ teamCredentialResources: [raw] });
        expect(account.home.requestsFor('/v1/teams/credential-resources/entitled/discover').every(request =>
            typeof request.input === 'object' && request.input !== null && 'executionMachineId' in request.input && request.input.executionMachineId === 'machine-a')).toBe(true);
        let finishProjection!: (value: unknown) => void;
        describeProviderModels.mockImplementationOnce(() => new Promise(resolve => { finishProjection = resolve; }));
        let refreshing!: Promise<void>;
        await act(async () => { refreshing = hook.getCurrent().reload(); });
        await waitForHomeGovernance(() => expect(projectionRequests).toHaveLength(2));
        await waitForHomeGovernance(() => expect(hook.getCurrent().current).toBe(false));
        expect(hook.getCurrent().resources).toEqual([resolved]);
        expect.soft(hook.getCurrent().resourceStatusByKey?.get('team-1:shared')).toEqual({ kind: 'pending' });
        await act(async () => { finishProjection({ ...projection(), teamCredentialResources: [resolved] }); await refreshing; });
        await waitForHomeGovernance(() => expect(hook.getCurrent().current).toBe(true));
        describeProviderModels.mockResolvedValue(projection());
        await act(async () => { await hook.getCurrent().reload(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().current).toBe(false));
        expect(hook.getCurrent().resources).toEqual([resolved]);
        expect(hook.getCurrent().resourceStatusByKey?.get('team-1:shared')).toMatchObject({
            kind: 'failed', code: 'provider_rpc_response_invalid',
        });
        describeProviderModels.mockResolvedValue({ ...projection(), teamCredentialResources: [resolved] });
        account.home.answer(serverId, '/v1/teams/credential-resources/entitled/discover', {
            body: { resources: [], nextCursor: null, failures: [{ teamId: 'team-1', error: 'team_authentication_policy_unavailable' }] },
        });
        await act(async () => { await hook.getCurrent().reload(); });
        expect(hook.getCurrent().resourceStatusByKey?.get('team-1:shared')).toMatchObject({
            kind: 'failed', code: 'team_authentication_policy_unavailable',
        });
        account.home.answer(serverId, '/v1/teams/credential-resources/entitled/discover', { dispatchThenFail: true });
        await act(async () => { await hook.getCurrent().reload(); });
        expect(hook.getCurrent().resourceStatusByKey?.get('team-1:shared')).toEqual({ kind: 'homeUnreachable' });
        account.home.answer(serverId, '/v1/teams/credential-resources/entitled/discover', {
            body: { resources: [], nextCursor: null, failures: [] },
        });
        await act(async () => { await hook.getCurrent().reload(); });
        await waitForHomeGovernance(() => expect(hook.getCurrent().current).toBe(true));
        expect(hook.getCurrent().resources).toEqual([]);
        expect(hook.getCurrent().resourceStatusByKey?.size).toBe(0);

        const restored = TeamCredentialResourceCatalogEntryV1Schema.parse({ ...raw, resourceRevision: 3,
            providerModels: rawBasis.providerModels.map(row => ({ ...row,
                selection: { ...row.selection, expectedResourceRevision: 3 },
            })),
        });
        account.home.answer(serverId, '/v1/teams/credential-resources/entitled/discover', {
            body: { resources: [restored], nextCursor: null, failures: [] },
        });
        describeProviderModels.mockResolvedValue({ ...projection(), teamCredentialResources: [restored] });
        const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
        const { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } = await import('@happier-dev/protocol/changes');
        await act(async () => { publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]); });
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().current).toBe(true);
            expect(hook.getCurrent().resources[0]?.resourceRevision).toBe(3);
        });
        const { buildTeamCredentialModelPickerSections } = await import('@/components/sessions/modelPicker/buildTeamCredentialModelPickerSections');
        const sections = buildTeamCredentialModelPickerSections({
            declarationContext: { kind: 'machine', projection: declarationProjection },
            agentTargetKey, nativeModels: [], providerGroups: [], hiddenNativeModelKeys: new Set<string>(),
            providerProjectionAuthoritative: true, teamCredentialResources: hook.getCurrent().resources,
            teamCredentialResourceStatusByKey: hook.getCurrent().resourceStatusByKey,
        });
        expect(sections[0]?.options[0]).toMatchObject({ availability: 'available',
            value: { resourceId: restored.id, expectedResourceRevision: 3 } });
    });

    it('projects a gathered Team catalog once on the exact execution Machine and withdraws it on target change', async () => {
        const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: 'resource-1', teamId: 'team-1', displayName: 'Shared', resourceRevision: 1,
            readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
            directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
            providerModels: [], connectedServiceSelections: [],
            sourcePresentation: { kind: 'connected_service', service: { pluginId: 'happier.service.test', localId: 'chat' } } });
        const resources = Array.from({ length: 400 }, (_, index) => ({ ...resource, id: `resource-${index}` }));
        describeProviderModels.mockResolvedValue({ ...projection(), teamCredentialResources: resources });
        const rendered = await renderHook((props: { machineId: string; active: boolean }) => useProviderModelProjection({
            enabled: true, ...props, serverId, agentTargetKey: 'agent:happier.agent.codex/codex', teamCredentialResources: resources,
        }), { initialProps: { machineId: 'machine-a', active: true } });
        await flushHookEffects();
        expect(projectionRequests).toHaveLength(1);
        expect(projectionRequests[0]?.payload).toMatchObject({ teamCredentialResources: resources });
        expect(rendered.getCurrent().data?.teamCredentialResources).toEqual(resources);
        const stringify = JSON.stringify;
        let catalogSerializations = 0;
        const serialization = vi.spyOn(JSON, 'stringify').mockImplementation((...args: Parameters<typeof stringify>) => {
            const result = stringify(...args);
            if (result?.includes('resource-399')) catalogSerializations += 1;
            return result;
        });
        try {
            await rendered.rerender({ machineId: 'machine-a', active: true });
            expect(catalogSerializations).toBe(0);
        } finally { serialization.mockRestore(); }
        await rendered.rerender({ machineId: 'machine-a', active: false });
        await flushHookEffects();
        expect(projectionRequests).toHaveLength(1);
        await rendered.rerender({ machineId: 'machine-b', active: true });
        await flushHookEffects();
        expect(projectionRequests).toHaveLength(2);
        expect(rendered.getCurrent().data?.teamCredentialResources).toEqual(resources);
        expect(projectionRequests.at(-1)?.payload).toMatchObject({ teamCredentialResources: resources });
        describeProviderModels.mockResolvedValue(projection());
        await act(async () => { await rendered.getCurrent().refresh(); });
        expect(rendered.getCurrent().error?.code).toBe('provider_rpc_response_invalid');
        expect(rendered.getCurrent().data?.teamCredentialResources).toEqual(resources);
    });

    it('shares connection-model list demand and retains its distinct policy facts across reopen and failed refresh', async () => {
        const firstResult = { status: 'success' as const, connectionId: 'pc_a', connectionRevision: 2,
            manualModelPolicy: 'allowed' as const, modelLoadAction: 'descriptor_absent' as const,
            models: [{ id: 'model-a', source: 'probe' as const, stale: false,
                loadState: 'unknown' as const, visibility: 'visible' as const }] };
        let resolveRead!: (value: unknown) => void;
        const read = vi.fn(() => new Promise(resolve => { resolveRead = resolve; }));
        rpc.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODELS, () => read());
        const input = { enabled: true, machineId: 'machine-a', serverId, connectionId: 'pc_a' };
        const first = await renderHook(() => useProviderConnectionModels(input));
        // Omitted and explicit Home both resolve to this same applied Account.
        const second = await renderHook(() => useProviderConnectionModels({ ...input, serverId: null }));
        await act(async () => resolveRead(firstResult));
        expect(read).toHaveBeenCalledTimes(1);
        expect(first.getCurrent().models).toBe(second.getCurrent().models);
        expect(second.getCurrent()).toMatchObject({ connectionRevision: 2, manualModelPolicy: 'allowed', modelLoadAction: 'descriptor_absent' });
        const cached = first.getCurrent().models;
        await first.unmount();
        await second.unmount();
        const reopened = await renderHook(() => useProviderConnectionModels(input));
        expect(reopened.getCurrent().models).toBe(cached);
        expect(reopened.getCurrent().loading).toBe(true);
        await act(async () => resolveRead({ status: 'error', error: createProviderErrorV1('provider_endpoint_unavailable') }));
        expect(reopened.getCurrent().models).toBe(cached);
        expect(reopened.getCurrent().error?.code).toBe('provider_endpoint_unavailable');
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('keeps a live connection-list borrower after its sibling closes and isolates the next connection', async () => {
        const answer = (connectionId: string) => ({ status: 'success' as const, connectionId, connectionRevision: 1,
            manualModelPolicy: 'catalog-only' as const, modelLoadAction: 'descriptor_absent' as const,
            models: [{ id: connectionId, source: 'probe' as const, stale: false,
                loadState: 'unknown' as const, visibility: 'visible' as const }] });
        let resolveRead!: (value: unknown) => void;
        const read = vi.fn(() => new Promise(resolve => { resolveRead = resolve; }));
        rpc.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODELS, () => read());
        const input = { enabled: true, machineId: 'machine-a', serverId, connectionId: 'pc_a' };
        const first = await renderHook((props: { active: boolean }) => useProviderConnectionModels({ ...input, active: props.active }),
            { initialProps: { active: false } });
        expect(read).not.toHaveBeenCalled();
        await first.rerender({ active: true });
        const second = await renderHook((props: { connectionId: string }) => useProviderConnectionModels({ ...input, ...props }),
            { initialProps: { connectionId: 'pc_a' } });
        await first.unmount();
        await act(async () => resolveRead(answer('pc_a')));
        expect(read).toHaveBeenCalledTimes(1);
        expect(second.getCurrent().models[0]?.id).toBe('pc_a');
        await second.rerender({ connectionId: 'pc_b' });
        expect(second.getCurrent().models).toEqual([]);
        await act(async () => resolveRead(answer('pc_b')));
        expect(second.getCurrent().models[0]?.id).toBe('pc_b');
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('shares admitted display results across surfaces and paints cached content during reopen revalidation', async () => {
        describeProviderModels.mockResolvedValueOnce(projection(['pc_first']));
        const input = { enabled: true, machineId: 'machine-a', serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex' };
        const first = await renderHook(() => useProviderModelProjection(input));
        await flushHookEffects();
        const initialData = first.getCurrent().data;
        expect(initialData?.groups[0]?.connectionId).toBe('pc_first');
        let completeSecond!: (value: unknown) => void;
        describeProviderModels.mockImplementationOnce(() => new Promise(resolve => { completeSecond = resolve; }));
        const second = await renderHook(() => useProviderModelProjection(input));
        const secondWhileRefreshing = second.getCurrent();
        await act(async () => completeSecond(projection(['pc_updated'])));
        expect(secondWhileRefreshing.data).toBe(initialData);
        expect(secondWhileRefreshing.loading).toBe(true);
        expect(first.getCurrent().data).toBe(second.getCurrent().data);
        expect(first.getCurrent().data?.groups[0]?.connectionId).toBe('pc_updated');
        const updatedData = second.getCurrent().data;
        await first.unmount();
        await second.unmount();
        let completeReopen!: (value: unknown) => void;
        describeProviderModels.mockImplementationOnce(() => new Promise(resolve => { completeReopen = resolve; }));
        const reopened = await renderHook(() => useProviderModelProjection(input));
        const reopenedWhileRefreshing = reopened.getCurrent();
        await act(async () => completeReopen(projection(['pc_revalidated'])));
        expect(reopenedWhileRefreshing.data).toBe(updatedData);
        expect(reopenedWhileRefreshing.loading).toBe(true);
        expect(projectionRequests).toHaveLength(3);
        expect(reopened.getCurrent().data?.groups[0]?.connectionId).toBe('pc_revalidated');
    });

    describe('a refresh held for approval', () => {
        const input = () => ({ enabled: true, machineId: 'machine-a', serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex' });
        async function holdRefresh() {
            await account.reset();
            serverId = (await account.restore({ serverIdentityId: 'srv_a', currentAccount: true })).serverId;
            await installOwnMachineApprovalReplayBoundary({ harness: account.home, serverId, accountId: 'account-a', machineId: 'machine-a' });
            await account.home.requireUiApproval(serverId, 'providers.models.refresh');
            describeProviderModels.mockResolvedValue(projection([]));
            const hook = await renderHook(() => useProviderModelProjection(input()));
            await flushHookEffects();
            describeProviderModels.mockResolvedValue(projection(['pc_after_approval']));
            let settled = false;
            await act(async () => { void hook.getCurrent().refresh().then(() => { settled = true; }); });
            await waitForHomeGovernance(() => expect(account.home.artifacts(serverId).list()).toHaveLength(1));
            const artifactId = account.home.artifacts(serverId).list()[0]!.id;
            return { hook, artifactId, settled: () => settled };
        }

        it('exposes the approval while pending, then shows the approved rows without a second refresh', async () => {
            const { hook, artifactId } = await holdRefresh();
            await waitForHomeGovernance(() => expect(hook.getCurrent().pendingApproval?.artifactId).toBe(artifactId));
            expect(hook.getCurrent().pendingApproval).toEqual({ artifactId,
                href: `/inbox/approvals/${artifactId}?serverId=${encodeURIComponent(serverId)}` });
            expect(hook.getCurrent().loading).toBe(true);
            expect(hook.getCurrent().data?.groups ?? []).toEqual([]);
            const before = projectionRequests.filter(request => (request.payload as { forceRefresh?: boolean }).forceRefresh).length;
            await expect(decideApprovalAsInbox('srv_a', artifactId, 'approve')).resolves.toMatchObject({ ok: true });
            await waitForHomeGovernance(() => expect(hook.getCurrent().data?.groups[0]?.connectionId).toBe('pc_after_approval'));
            expect(hook.getCurrent().pendingApproval).toBeNull();
            expect(hook.getCurrent().loading).toBe(false);
            expect(projectionRequests.filter(request => (request.payload as { forceRefresh?: boolean }).forceRefresh))
                .toHaveLength(before + 1);
        });

        it('settles a rejection as the person\'s own decision, with no rows and no failure', async () => {
            const { hook, artifactId } = await holdRefresh();
            await expect(decideApprovalAsInbox('srv_a', artifactId, 'reject')).resolves.toMatchObject({ ok: true });
            await waitForHomeGovernance(() => expect(hook.getCurrent().pendingApproval).toBeNull());
            // A declined approval is neither a Provider failure nor an empty verdict: nothing ran, nothing failed.
            expect(hook.getCurrent().loading).toBe(false);
            expect(hook.getCurrent().error).toBeNull();
            expect(hook.getCurrent().data?.groups ?? []).toEqual([]);
        });
    });

    it('withdraws cached display results on same-Account credential replacement while closed', async () => {
        describeProviderModels.mockResolvedValue(projection(['pc_old_credential']));
        const input = { enabled: true, machineId: 'machine-a', serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex' };
        const first = await renderHook((props: { active: boolean }) => useProviderModelProjection({ ...input, active: props.active }),
            { initialProps: { active: true } });
        await flushHookEffects();
        expect(first.getCurrent().data?.groups[0]?.connectionId).toBe('pc_old_credential');
        await first.rerender({ active: false });
        const beforeReplacement = projectionRequests.length;
        const [{ TokenStorage }, { getServerProfileById }] = await Promise.all([
            import('@/auth/storage/tokenStorage'), import('@/sync/domains/server/serverProfiles'),
        ]);
        const serverUrl = getServerProfileById(serverId)!.serverUrl;
        const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
        expect(credentials).not.toBeNull();
        await act(async () => {
            await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId }, {
                ...credentials!, token: `${credentials!.token}-replacement`,
            });
        });
        await flushHookEffects();
        expect(first.getCurrent().data).toBeNull();
        expect(projectionRequests).toHaveLength(beforeReplacement);
        await first.unmount();
    });

    it('changes source browsing without changing the exact selected tuple or favorite identity', async () => {
        describeProviderModels.mockResolvedValue(projection(['pc_a']));
        const currentSelection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: ProviderConnectionIdSchema.parse('pc_a'), modelId: 'same' };
        const favorite = { ...currentSelection, providerConnectionId: ProviderConnectionIdSchema.parse('pc_off') };
        const initialProps: { sourceConnectionId?: string } = { sourceConnectionId: 'pc_off' };
        const rendered = await renderHook((props: { sourceConnectionId?: string }) => useProviderModelProjection({
            enabled: true, machineId: 'machine-a', serverId, agentTargetKey: currentSelection.agentTargetKey,
            currentSelection, sourceConnectionId: props.sourceConnectionId, favoriteSelections: [favorite],
        }), { initialProps });
        await flushHookEffects();
        expect(projectionRequests.at(-1)?.payload).toMatchObject({ sourceConnectionId: 'pc_off', currentSelection, favoriteSelections: [favorite] });
        await rendered.rerender({});
        await flushHookEffects();
        const payload = projectionRequests.at(-1)?.payload;
        expect(payload).toMatchObject({ currentSelection, favoriteSelections: [favorite] });
        expect(payload).not.toHaveProperty('sourceConnectionId');
    });
    it('requests models only on picker demand and retains its projection when the picker closes', async () => {
        describeProviderModels.mockResolvedValue(projection(['pc_a']));
        const rendered = await renderHook((props: { active: boolean }) => useProviderModelProjection({
            enabled: true, active: props.active, machineId: 'machine-a', serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
        }), { initialProps: { active: false } });
        await flushHookEffects();
        expect(describeProviderModels).toHaveBeenCalledTimes(0);
        await rendered.rerender({ active: true });
        await flushHookEffects();
        expect(describeProviderModels).toHaveBeenCalledTimes(1);
        const data = rendered.getCurrent().data;
        expect(data?.groups[0]?.connectionId).toBe('pc_a');
        const refresh = rendered.getCurrent().refresh;
        const refreshWithResult = rendered.getCurrent().refreshWithResult;
        await rendered.rerender({ active: false });
        await act(async () => { await refresh(); await refreshWithResult(); });
        expect(describeProviderModels).toHaveBeenCalledTimes(1);
        expect(rendered.getCurrent().data).toBe(data);
        expect(rendered.getCurrent().refresh).toBe(refresh);
        expect(rendered.getCurrent().refreshWithResult).toBe(refreshWithResult);
    });

    it('projects an API-token creation machine with an omitted Home through the applied Account and retires its old read', async () => {
        // ApiTokenGrantModelMachine omits the Home when the creation machine differs from the Administration target.
        const stagedServerId = await account.addHome({ name: 'Staged Provider Home',
            serverUrl: 'https://provider-settings-staged.test', accountId: 'account-staged', active: true });
        const [{ getAppliedActiveServerSnapshot }, { getActiveServerSnapshot }] = await Promise.all([
            import('@/sync/runtime/orchestration/connectionManager'),
            import('@/sync/domains/server/serverRuntime'),
        ]);
        expect(getActiveServerSnapshot().serverId).toBe(stagedServerId);
        expect(getAppliedActiveServerSnapshot().serverId).toBe(serverId);
        let resolveA!: (value: unknown) => void;
        describeProviderModels
            .mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; }))
            .mockResolvedValueOnce(projection(['pc_account_b']));
        const rendered = await renderHook(() => useProviderModelProjection({
            enabled: true, machineId: 'machine-a', serverId: null,
            agentTargetKey: 'agent:happier.agent.codex/codex',
        }));
        await flushHookEffects({ cycles: 2, turns: 3 });
        expect(projectionRequests).toHaveLength(1);
        expect(projectionRequests[0]?.serverId).toBe(serverId);
        const refreshFromAccountA = rendered.getCurrent().refresh;

        // Staging another Home intentionally leaves A's runtime applied. A
        // warm Account replacement therefore uses the serialized switch owner,
        // rather than cold restore on an already-initialized Sync instance.
        await account.restore({ accountId: 'account-b', activation: 'switch', waivedActions: ['providers.models.refresh'] });
        await rendered.rerender();
        await waitForHomeGovernance(() => expect(rendered.getCurrent().data?.groups).toMatchObject([
            { connectionId: 'pc_account_b' },
        ]));
        expect(projectionRequests).toHaveLength(2);
        expect(projectionRequests[1]?.serverId).toBe(serverId);

        await act(async () => { resolveA(projection(['pc_retired_a'])); await refreshFromAccountA(); });
        expect(rendered.getCurrent().data?.groups).toMatchObject([{ connectionId: 'pc_account_b' }]);
        expect(projectionRequests).toHaveLength(2);
    });

    it('clears Account A projection and starts one Account B read when routing ids stay equal', async () => {
        let resolveA!: (value: unknown) => void;
        let resolveB!: (value: unknown) => void;
        describeProviderModels
            .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
            .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
        const rendered = await renderHook(() => useProviderModelProjection({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
        }));
        const refreshFromAccountA = rendered.getCurrent().refresh;
        expect(describeProviderModels).toHaveBeenCalledTimes(1);

        await act(async () => {
            await account.restore({ accountId: 'account-b' });
            await rendered.rerender();
        });

        expect(rendered.getCurrent().data).toBeNull();
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(describeProviderModels).toHaveBeenCalledTimes(2);

        await act(async () => {
            resolveA(projection(['pc_a']));
        });
        expect(rendered.getCurrent().data).toBeNull();

        await act(async () => {
            resolveB(projection(['pc_b']));
        });
        expect(rendered.getCurrent().data?.groups).toMatchObject([{ connectionId: 'pc_b' }]);

        await act(async () => { await refreshFromAccountA(); });
        expect(describeProviderModels).toHaveBeenCalledTimes(2);
        expect(rendered.getCurrent().data?.groups).toMatchObject([{ connectionId: 'pc_b' }]);
    });

    it('clears a successful projection immediately when its machine scope changes', async () => {
        let resolveB!: (value: unknown) => void;
        const observed: Array<Readonly<{ machineId: string; connectionIds: readonly string[]; status?: string }>> = [];
        describeProviderModels
            .mockResolvedValueOnce(projection(['pc_a']))
            .mockImplementationOnce(() => new Promise((resolve) => { resolveB = resolve; }));
        const rendered = await renderHook((props: { machineId: string }) => {
            const projection = useProviderModelProjection({
                enabled: true, machineId: props.machineId, serverId, agentTargetKey: 'agent:happier.agent.codex/codex',
            });
            observed.push({
                machineId: props.machineId,
                connectionIds: (projection.data?.groups ?? []).map((group) => String(group.connectionId)),
                status: projection.status,
            });
            return projection;
        }, { initialProps: { machineId: 'machine-a' } });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().data?.groups).toMatchObject([{ connectionId: 'pc_a' }]);
        expect(rendered.getCurrent().status).toBe('success');

        const scopeChangeRenderStart = observed.length;
        await rendered.rerender({ machineId: 'machine-b' });
        expect(rendered.getCurrent().data).toBeNull();
        expect(rendered.getCurrent().status).toBe('pending');
        expect(observed.slice(scopeChangeRenderStart).every((entry) => (
            entry.machineId !== 'machine-b' || !entry.connectionIds.includes('pc_a')
        ))).toBe(true);
        await act(async () => resolveB(projection()));
    });

    it('drops a delayed old-machine response after the target machine changes', async () => {
        let resolveA!: (value: unknown) => void;
        describeProviderModels
            .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
            .mockResolvedValueOnce(projection());
        const rendered = await renderHook((props: { machineId: string }) => useProviderModelProjection({
            enabled: true, machineId: props.machineId, serverId, agentTargetKey: 'agent:happier.agent.codex/codex',
        }), { initialProps: { machineId: 'machine-a' } });

        await rendered.rerender({ machineId: 'machine-b' });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().data).toEqual(projection());

        await act(async () => {
            resolveA(projection(['pc_stale_a']));
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().data?.groups).toEqual([]);
        expect(describeProviderModels).toHaveBeenNthCalledWith(2, expect.objectContaining({ machineId: 'machine-b' }));
    });

    it('does no credential or RPC work until model projection is enabled', async () => {
        const [{ TokenStorage }, { getServerProfileById }] = await Promise.all([
            import('@/auth/storage/tokenStorage'), import('@/sync/domains/server/serverProfiles'),
        ]);
        const serverUrl = getServerProfileById(serverId)!.serverUrl;
        const credentialCallsites = new Map<string, number>();
        const readCredentials = TokenStorage.getCredentialsForServerUrl;
        const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation((...args) => {
            if (args[0] === serverUrl && args[1]?.storageReadFailure === 'surface') {
                const frames = (new Error().stack ?? '').split('\n').flatMap((line) => {
                    const source = line.match(/\/(?:apps\/ui\/)?sources\/([A-Za-z0-9_./-]+\.[cm]?[jt]sx?:\d+:\d+)/);
                    if (!source) return [];
                    const functionName = line.match(/^\s*at\s+([A-Za-z0-9_.$<>]+)\s+\(/)?.[1] ?? '<anonymous>';
                    return [`${functionName} sources/${source[1]}`];
                }).join(' ← ') || '<source frames unavailable>';
                credentialCallsites.set(frames, (credentialCallsites.get(frames) ?? 0) + 1);
            }
            return readCredentials(...args);
        });
        const targetCredentialReads = () => credentials.mock.calls.filter(([url, options]) => (
            url === serverUrl && options?.storageReadFailure === 'surface'
        )).length;
        describeProviderModels.mockResolvedValue(projection());
        const rendered = await renderHook((enabled: boolean) => useProviderModelProjection({
            enabled, machineId: 'machine-a', serverId, agentTargetKey: 'agent:happier.agent.codex/codex',
        }), { initialProps: false });
        try {
            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(describeProviderModels).not.toHaveBeenCalled();
            expect(rendered.getCurrent()).toMatchObject({ data: null, loading: false, status: 'disabled' });
            expect.soft(targetCredentialReads(), JSON.stringify([...credentialCallsites].map(([frames, count]) => ({ frames, count })))).toBe(0);
            await rendered.rerender(true);
            await waitForHomeGovernance(() => expect(rendered.getCurrent()).toMatchObject({ status: 'success', data: projection() }));
            expect(targetCredentialReads()).toBeGreaterThan(0);
            const boundReads = targetCredentialReads();
            const completedRequests = projectionRequests.length;
            await rendered.rerender(false);
            expect(rendered.getCurrent()).toMatchObject({ data: null, loading: false, status: 'disabled' });
            expect(targetCredentialReads()).toBe(boundReads);
            expect(projectionRequests).toHaveLength(completedRequests);
        } finally { await rendered.unmount(); credentials.mockRestore(); }
    });

    it('exposes a first-load typed error without treating the projection as authoritative', async () => {
        describeProviderModels.mockResolvedValueOnce({
            status: 'error',
            error: {
                v: 1,
                code: 'provider_endpoint_unreachable',
                retryable: true,
                action: 'retry',
            },
        });
        const rendered = await renderHook(() => useProviderModelProjection({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent()).toMatchObject({
            data: null,
            loading: false,
            status: 'error',
            error: expect.objectContaining({ code: 'provider_endpoint_unreachable' }),
        });
    });

    it('requests the daemon-owned hidden-row management projection explicitly', async () => {
        describeProviderModels.mockResolvedValueOnce(projection());
        await renderHook(() => useProviderModelProjection({
            enabled: true, machineId: 'machine-a', serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex', mode: 'management',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(describeProviderModels).toHaveBeenCalledWith(expect.objectContaining({ mode: 'management' }));
    });

    it('preserves the last successful same-scope projection and exposes an untyped transport failure', async () => {
        describeProviderModels.mockResolvedValueOnce(projection(['pc_a']));
        const rendered = await renderHook(() => useProviderModelProjection({
            enabled: true, machineId: 'machine-a', serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex', mode: 'management',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(rendered.getCurrent().data?.groups).toMatchObject([{ connectionId: 'pc_a' }]);

        describeProviderModels.mockRejectedValueOnce(new Error('socket closed'));
        await act(async () => { await rendered.getCurrent().refresh(); });

        expect(rendered.getCurrent().data?.groups).toMatchObject([{ connectionId: 'pc_a' }]);
        expect(rendered.getCurrent().error).toMatchObject({
            v: 1,
            code: 'agent_error',
            retryable: false,
            action: 'review_connection',
        });
    });

    it('preserves the last successful same-scope projection when the daemon returns a typed error', async () => {
        describeProviderModels.mockResolvedValueOnce(projection(['pc_a']));
        const rendered = await renderHook(() => useProviderModelProjection({
            enabled: true, machineId: 'machine-a', serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex', mode: 'management',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        describeProviderModels.mockResolvedValueOnce({
            status: 'error',
            error: {
                v: 1, code: 'provider_endpoint_rate_limited', retryable: true,
                action: 'retry', retryAfterMs: 500,
            },
        });
        await act(async () => { await rendered.getCurrent().refresh(); });

        expect(rendered.getCurrent().data?.groups).toMatchObject([{ connectionId: 'pc_a' }]);
        expect(rendered.getCurrent().error?.code).toBe('provider_endpoint_rate_limited');
    });

    it('keeps mixed cold-refresh groups authoritative while exposing their typed partial failure', async () => {
        describeProviderModels.mockResolvedValueOnce({
            ...projection(['pc_warm']),
            refreshFailures: [{
                connectionId: 'pc_cold',
                error: {
                    v: 1,
                    code: 'provider_endpoint_unavailable',
                    retryable: true,
                    action: 'retry',
                    connectionId: 'pc_cold',
                    machineId: 'machine-a',
                },
            }],
        });
        const rendered = await renderHook(() => useProviderModelProjection({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent()).toMatchObject({
            status: 'success',
            data: { groups: [{ connectionId: 'pc_warm' }] },
            error: null,
            refreshFailures: [{
                connectionId: 'pc_cold',
                error: { code: 'provider_endpoint_unavailable', connectionId: 'pc_cold' },
            }],
        });
    });

    it('keeps every per-connection refresh failure and forces only explicit retry reads', async () => {
        describeProviderModels.mockResolvedValue({
            ...projection(),
            refreshFailures: [
                {
                    connectionId: 'pc_secret',
                    error: createProviderErrorV1('provider_secret_missing', {
                        connectionId: 'pc_secret', machineId: 'machine-a',
                    }),
                },
                {
                    connectionId: 'pc_endpoint',
                    error: createProviderErrorV1('provider_endpoint_unavailable', {
                        connectionId: 'pc_endpoint', machineId: 'machine-a',
                    }),
                },
            ],
        });
        const rendered = await renderHook(() => useProviderModelProjection({
            enabled: true,
            machineId: 'machine-a',
            serverId,
            agentTargetKey: 'agent:happier.agent.codex/codex',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(describeProviderModels).toHaveBeenNthCalledWith(1, expect.not.objectContaining({ forceRefresh: true }));
        expect(rendered.getCurrent().refreshFailures.map((failure) => failure.connectionId))
            .toEqual(['pc_secret', 'pc_endpoint']);

        await act(async () => { await rendered.getCurrent().refresh(); });
        expect(describeProviderModels).toHaveBeenNthCalledWith(2, expect.objectContaining({ forceRefresh: true }));
    });
});
