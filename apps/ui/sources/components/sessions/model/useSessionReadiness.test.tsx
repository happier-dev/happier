import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { act, createDeferred, createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createReadyMachineAgentInventoryFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { AccessibleMachineAccessV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { buildConnectedAccountPurposeTargetChoices } from '@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createSessionRunnerRuntimeStatusFixture } from '@/dev/testkit/fixtures/sessionRunnerRuntimeFixtures';
import { MetadataSchema } from '@happier-dev/session-core';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readAccountAgentProviderRequirements } from '@/providers/catalog/accountProviderDeclarations';
import { buildSessionWorkspaceLocationV1 } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';

const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { useSessionReadiness } = await import('./useSessionReadiness');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { createUiSessionStatusGet } = await import('@/sync/ops/actions/sessionStatusAction');
const { refreshMachineAgents } = await import('@/agents/machineAgents/useMachineAgents');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');

afterEach(() => { standardCleanup(); storage.setState(storage.getInitialState(), true); network.resetRequests(); });
afterAll(() => network.dispose());

it.each(['brokered', 'direct', 'vendor-native'] as const)('uses a stopped Session Home-accepted Team provider binding instead of local native sign-in (%s)', async (deliveryMode) => {
    const home = await network.addHome('https://readiness-team-route.test', 'alice');
    const scope = { serverId: home.id, accountId: 'alice' };
    const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const machineId = 'team-route-machine';
    const agentTargetKey = 'agent:happier.agent.codex/codex';
    const runnerStatus = createSessionRunnerRuntimeStatusFixture({ sessionId: 'team-route-bot', machineId });
    const teamModel = {
        kind: 'team_credential_provider_model' as const,
        teamId: 'team-1', resourceId: 'resource-1', expectedResourceRevision: 3,
        deliveryMode, agentTargetKey, modelId: 'gpt-5.6-luna',
    };
    const metadata = MetadataSchema.parse({
        machineId, path: '/work', host: 'server', flavor: 'codex',
        modelSelectionIntentV1: { v: 1, updatedAt: 1,
            selection: { agentTargetKey, providerConnectionId: null, modelId: teamModel.modelId } },
        sessionModelsV1: {
            v: 1, agentId: 'codex', updatedAt: 2, currentModelId: teamModel.modelId,
            availableModels: [{ id: teamModel.modelId, name: 'Luna' }],
        },
    });
    const session = createSessionFixture({ id: runnerStatus.state.sessionId, serverId: home.id, encryptionMode: 'plain',
        active: false, metadata, access: { ...createSessionAccessFixture('owner'), primaryTeamId: teamModel.teamId } });
    const machine = createMachineFixture({ id: machineId, active: true, activeAt: Date.now(),
        access: AccessibleMachineAccessV1Schema.parse({ custodian: { accountId: 'alice', displayName: 'Alice' },
            role: 'manage', resourceMode: 'plain', accessState: 'ready' }) });
    storage.getState().applyMachines([machine], true, { sourceServerId: home.id });
    storage.getState().markMachineListSettled(home.id);
    const native = createReadyMachineAgentInventoryFixture([{ agentId: 'codex', title: 'Codex' }]);
    const providerRequirements = readAccountAgentProviderRequirements(agentTargetKey, { kind: 'account' });
    if (!providerRequirements) throw new Error('Expected bundled Codex Provider requirements');
    const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
        ...native.projection,
        agentsById: { ...native.projection.agentsById, codex: {
            ...native.projection.agentsById.codex,
            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            providerRequirements,
            connectedAccounts: [{ purpose: 'primary',
                service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
                required: false, materializationKinds: ['files'], credentialKinds: ['oauth'] }],
        } },
    } });
    let resourceReadiness: { kind: 'available' } | { kind: 'limit_reached'; metric: 'inference_requests'; resetsAtUtc: string } = { kind: 'available' };
    const resource = () => TeamCredentialResourceCatalogEntryV1Schema.parse({
        id: teamModel.resourceId, teamId: teamModel.teamId, displayName: { content: { t: 'plain', v: 'Coordination QA Codex pool' }, recipientEnvelope: null },
        resourceRevision: teamModel.expectedResourceRevision, readiness: resourceReadiness,
        recoveryAction: resourceReadiness.kind === 'available' ? null : 'source_owner_action',
        mayBroker: true, mayReceiveDirect: deliveryMode === 'direct', directMaterialState: deliveryMode === 'direct' ? 'current' : 'never_delivered',
        sessionUsePolicy: 'personal_allowed', connectedServiceSelections: deliveryMode === 'vendor-native' ? [] : [{
            source: 'team_resource', resourceId: teamModel.resourceId, deliveryMode: teamModel.deliveryMode,
            ...(deliveryMode === 'direct' ? { disclosedMember: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'shared-account' } } : {}),
        }],
        // The unqualified entitled-resource read intentionally omits model rows. The Home-accepted
        // Session binding is the durable proof of the selected model route for this stopped Session.
        providerModels: [],
        sourcePresentation: { kind: 'connected_service', service: {
            pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
    });
    const teamPath = new URL(bindHomeDomainActionHttpRequestV1('teams.credentials.entitled.list', { teamId: teamModel.teamId }).path,
        'https://readiness-team-route.test').pathname;
    network.resetRequests();
    network.setHttpResponder(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === `/v2/sessions/${session.id}`) {
            const response = createPlainSessionByIdResponseFixture(session);
            return Response.json({ session: { ...response.session, acceptedTeamCredentialBinding: {
                v: 1, slot: { kind: 'provider_model' }, resourceId: teamModel.resourceId,
                expectedResourceRevision: teamModel.expectedResourceRevision,
                deliveryMode: teamModel.deliveryMode, teamId: teamModel.teamId,
            }, effectiveAccess: {
                ...response.session.effectiveAccess!, primaryTeamId: teamModel.teamId,
            } } });
        }
        if (path === teamPath) return Response.json({ resources: [resource()], nextCursor: null });
        return null;
    });
    network.setRpcAckResponder(async request => {
        if (request.method.includes('contributionRegistryProjection.describe')) return { ok: true, result: projection };
        if (request.method === 'daemon.agents.install.list') return { ok: true, result: { jobs: [] } };
        if (request.method === 'capabilities.detect') return { ok: true, result: { protocolVersion: 1, results: { 'cli.codex': {
            ...native.capabilities.results['cli.codex'], data: { ...native.capabilities.results['cli.codex']!.data,
                signIn: { status: 'signedOut', loginSupport: 'login_terminal' }, isLoggedIn: false,
                authStatus: { state: 'logged_out', checkedAt: 1 } },
        } } } };
        if (request.method === RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET) return { ok: true, result: runnerStatus };
        throw new Error(`Unexpected Team-route readiness effect ${request.method}`);
    });
    const hook = await renderHook(() => useSessionReadiness({ accountLifetime, sessionId: session.id, enabled: true }));
    await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({
        readiness: { status: 'ready', cause: null, agent: { state: 'ready' },
            credential: { kind: 'team', teamId: teamModel.teamId, resourceId: teamModel.resourceId, readiness: { kind: 'available' } } },
        repair: null,
    }));
    expect(network.requests.filter(request => request.method === RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET)).toHaveLength(0);
    expect(network.httpRequests.filter(request => new URL(request.url).pathname === teamPath)).toHaveLength(1);

    resourceReadiness = { kind: 'limit_reached', metric: 'inference_requests', resetsAtUtc: '2026-10-26T00:00:00Z' };
    await act(async () => { publishHomeAccountChange(home.id, ['teams'], { source: 'socket', changeKinds: ['account'] }); });
    await vi.waitFor(() => expect(hook.getCurrent().readiness).toMatchObject({
        status: deliveryMode === 'brokered' ? 'unavailable' : 'ready', cause: deliveryMode === 'brokered' ? 'credential' : null,
        agent: { state: deliveryMode === 'brokered' ? 'unknown' : 'ready' },
        credential: { kind: 'team', readiness: deliveryMode === 'brokered' ? resourceReadiness : { kind: 'available' }, recoveryAction: 'source_owner_action' },
    }));
});

it('updates demanded readiness after a pushed Session access change without polling or unrelated reads', async () => {
    const home = await network.addHome('https://readiness-access.test', 'alice');
    const features = createRootLayoutFeaturesResponse();
    tryWriteServerEnabledBitInPlace(features, 'sharing.session', true);
    primeServerFeaturesSnapshot({ serverId: home.id, snapshot: { status: 'ready', features } });
    const scope = { serverId: home.id, accountId: 'alice' };
    const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    let level: 'view' | 'admin' = 'view';
    const session = createSessionFixture({ id: 'shared-bot', serverId: home.id, encryptionMode: 'plain',
        metadata: { machineId: 'sleeping', path: '/work', host: 'laptop', flavor: 'codex' },
        access: createSessionAccessFixture(level) });
    storage.getState().applyMachines([createMachineFixture({ id: 'sleeping', active: false, activeAt: 0 })], true, { sourceServerId: home.id });
    storage.getState().markMachineListSettled(home.id);
    network.resetRequests();
    network.setHttpResponder(async input => new URL(String(input)).pathname === `/v2/sessions/${session.id}`
        ? Response.json(createPlainSessionByIdResponseFixture({ ...session, access: createSessionAccessFixture(level) })) : null);
    const hook = await renderHook(({ enabled }: { enabled: boolean }) => useSessionReadiness({
        accountLifetime, sessionId: session.id, enabled,
    }), { initialProps: { enabled: true } });
    await vi.waitFor(() => expect(hook.getCurrent().readiness).toMatchObject({ cause: 'invocation', invocation: { level: 'view' } }));
    const readCount = () => network.httpRequests.filter(request => new URL(request.url).pathname === `/v2/sessions/${session.id}`).length;
    const before = readCount();
    level = 'admin';
    await act(async () => {
        publishHomeAccountChange('another-home', [session.id], { changeKinds: ['share'] });
        publishHomeAccountChange(home.id, ['another-session'], { changeKinds: ['share'] });
        publishHomeAccountChange(home.id, [session.id], { changeKinds: ['artifact'] });
    });
    expect(readCount()).toBe(before);
    await act(async () => { publishHomeAccountChange(home.id, [session.id], { changeKinds: ['share'] }); });
    await vi.waitFor(() => expect(hook.getCurrent().readiness).toMatchObject({ cause: 'machine', invocation: { level: 'admin' } }));
    expect(readCount()).toBe(before + 1);
    await hook.rerender({ enabled: false });
    await act(async () => { publishHomeAccountChange(home.id, [session.id], { changeKinds: ['share'] }); });
    expect(readCount()).toBe(before + 1);
});

it('demands the operation Account purpose and observes reconnect acknowledgement without changing conversation readiness', async () => {
    const home = await network.addHome('https://readiness-credential.test', 'alice');
    const scope = { serverId: home.id, accountId: 'alice' };
    const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const service = { pluginId: 'acme.external', localId: 'account' };
    const purpose = { consumer: { pluginId: 'acme.external', localId: 'helper' }, purpose: 'outside-write' };
    const account = { service, accountId: 'work' };
    const teamSelection = { source: 'team_resource' as const, resourceId: 'shared-resource', deliveryMode: 'direct' as const, disclosedMember: account };
    const teamResource = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: teamSelection.resourceId, teamId: 'team', displayName: { content: { t: 'plain', v: 'Shared Acme' }, recipientEnvelope: null },
        resourceRevision: 1, readiness: { kind: 'limit_reached', metric: 'inference_requests', resetsAtUtc: '2026-10-20T00:00:00Z' },
        recoveryAction: 'source_owner_action', mayBroker: false, mayReceiveDirect: true, directMaterialState: 'current',
        sessionUsePolicy: 'personal_allowed', providerModels: [], connectedServiceSelections: [teamSelection], sourcePresentation: { kind: 'connected_service', service } });
    const choice = buildConnectedAccountPurposeTargetChoices({ declaration: { purpose: purpose.purpose, service, required: true },
        selectedTarget: null, accounts: [], groups: [], labelsByKey: {}, serviceTitle: 'Acme', resolveAuthentication: () => null,
        teamResources: [{ ...teamResource, readiness: { kind: 'available' } }] }).find(candidate => candidate.teamResource);
    if (!choice?.teamResource) throw new Error('Expected the existing setup owner to offer the Team binding');
    const credentialTeamSelection = { purpose, ...choice.teamResource };
    const teamPath = new URL(bindHomeDomainActionHttpRequestV1('teams.credentials.entitled.list', { teamId: 'team' }).path, 'https://readiness-credential.test').pathname;
    let useTeamResource = false;
    let sharedInvoker = false;
    let legacySharedLocality = false;
    const session = createSessionFixture({ id: 'credential-bot', serverId: home.id, encryptionMode: 'plain',
        metadata: { machineId: 'credential-machine', path: '/work', host: 'server', flavor: 'codex' }, access: createSessionAccessFixture('owner') });
    const machine = createMachineFixture({ id: 'credential-machine', active: true, activeAt: Date.now(),
        access: AccessibleMachineAccessV1Schema.parse({ custodian: { accountId: 'alice', displayName: 'Alice' },
            role: 'manage', resourceMode: 'plain', accessState: 'ready' }) });
    storage.getState().applyMachines([machine], true, { sourceServerId: home.id });
    storage.getState().markMachineListSettled(home.id);
    let connected = false;
    const profile = () => AccountProfileSchema.parse({ id: 'alice', connectedAccountsV4: [{ ref: account, status: 'connected',
        revisionSemantics: 'revisioned', credentialRevision: `csr_${'a'.repeat(22)}`, authenticationModeId: 'manual',
        configurationReady: true, configurationRevision: null, expiresAt: connected ? null : 1 }] });
    network.resetRequests();
    network.setHttpResponder(async input => {
        const path = new URL(String(input)).pathname;
        if (path === `/v2/sessions/${session.id}`) {
            const response = createPlainSessionByIdResponseFixture(sharedInvoker
                ? { ...session, access: createSessionAccessFixture('edit') } : session);
            // Retained layout-0 Sessions expose locality in shared metadata; layout-1 recipients do not.
            return Response.json(legacySharedLocality ? { session: { ...response.session,
                metadataLayoutVersion: 0, metadata: JSON.stringify(session.metadata) } } : response);
        }
        if (path === '/v1/account/profile') return Response.json(profile());
        if (path === teamPath) return Response.json({ resources: [teamResource], nextCursor: null });
        if (path.endsWith('/connected-accounts/purposes')) return Response.json({ status: 'present', revision: 1,
            content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [{ purpose, target: { kind: 'account', account } }] } } } });
        return null;
    });
    const native = createReadyMachineAgentInventoryFixture([{ agentId: 'codex', title: 'Codex' }]);
    const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
        ...native.projection,
        installedPackagesById: { ...native.projection.installedPackagesById, 'acme.external': {
            id: 'acme.external', displayName: 'Acme', enabled: true, source: { kind: 'builtin', locator: 'acme.external' } } },
        resourcesById: { ...native.projection.resourcesById, helper: { id: 'helper', pluginId: 'acme.external', resourceKind: 'config', path: 'helper.json',
            connectedAccountPurposes: [{ purpose: purpose.purpose, serviceRefs: [service] }] } },
        familiesById: { ...native.projection.familiesById, connectedAccounts: { family: 'connectedAccounts', entriesById: { account: {
            id: service.localId, serviceId: service.localId, pluginId: service.pluginId, provenance: 'external', sourceKind: 'test', title: 'Acme',
            authentication: { defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none', fields: [] }] },
            capabilities: [], availability: { state: 'available', reason: 'enabled' }, diagnostics: [],
        } } } },
    } });
    network.setRpcAckResponder(async request => {
        if (request.method.includes('contributionRegistryProjection.describe')) return { ok: true, result: projection };
        if (request.method === 'daemon.agents.install.list') return { ok: true, result: { jobs: [] } };
        if (request.method === 'capabilities.detect') return { ok: true, result: native.capabilities };
        throw new Error(`Unexpected credential diagnostic effect ${request.method}`);
    });
    const hook = await renderHook(({ operation }: { operation: 'conversation' | 'credential' }) => useSessionReadiness({
        accountLifetime, sessionId: session.id, enabled: true, operation, credentialPurpose: purpose,
        ...(useTeamResource ? { credentialTeamSelection } : {}),
    }), { initialProps: { operation: 'credential' } });
    await vi.waitFor(() => expect(hook.getCurrent().readiness).toMatchObject({ operation: 'credential', status: 'unavailable', cause: 'credential',
        credential: { kind: 'personal', purpose, usable: false } }));
    expect(hook.getCurrent().repair).toEqual({ actionId: 'connectedServices.authentication.beginReconnect',
        input: { machineId: machine.id, account } });
    connected = true; // Acknowledgement at the authentication boundary; the same owner must be reread.
    await act(async () => { publishHomeAccountChange(home.id, ['connected-service:acme.external/account'], {
        source: 'socket', changeKinds: ['account'],
    }); });
    await vi.waitFor(() => expect(hook.getCurrent().readiness).toMatchObject({ operation: 'credential', status: 'ready',
        credential: { kind: 'personal', usable: true, repair: null } }));
    connected = false;
    await hook.rerender({ operation: 'conversation' });
    await vi.waitFor(() => expect(hook.getCurrent().readiness).toMatchObject({ operation: 'conversation', status: 'ready', credential: { kind: 'not_required' } }));
    useTeamResource = true;
    await hook.rerender({ operation: 'credential' });
    await vi.waitFor(() => expect(hook.getCurrent().readiness).toMatchObject({ operation: 'credential', status: 'ready', cause: null,
        credential: { kind: 'team', teamId: teamResource.teamId, resourceId: teamResource.id,
            readiness: { kind: 'available' }, recoveryAction: teamResource.recoveryAction } }));
    expect(hook.getCurrent().repair).toBeNull(); // Team source repair stays at its own resource owner.
    sharedInvoker = true;
    const privateReads = network.httpRequests.filter(request => request.url.endsWith('/v1/account/profile') || request.url.endsWith('/connected-accounts/purposes')).length;
    await act(async () => { await hook.getCurrent().refresh(); });
    await vi.waitFor(() => expect(hook.getCurrent().readiness?.credential).toEqual({ kind: 'unknown' }));
    legacySharedLocality = true;
    await act(async () => { await hook.getCurrent().refresh(); });
    await vi.waitFor(() => expect(hook.getCurrent().readiness?.credential).toMatchObject({ kind: 'team', readiness: { kind: 'available' } }));
    expect(network.httpRequests.filter(request => request.url.endsWith('/v1/account/profile') || request.url.endsWith('/connected-accounts/purposes'))).toHaveLength(privateReads);
    useTeamResource = false;
    await hook.rerender({ operation: 'conversation' });
    await hook.rerender({ operation: 'credential' });
    await vi.waitFor(() => expect(hook.getCurrent().readiness?.credential).toEqual({ kind: 'unknown' }));
    expect(network.httpRequests.filter(request => request.url.endsWith('/v1/account/profile') || request.url.endsWith('/connected-accounts/purposes'))).toHaveLength(privateReads);
});

it('demands the exact Session only while open and keeps an offline Bot visible with its cause', async () => {
    const home = await network.addHome('https://readiness-row.test', 'alice');
    const scope = { serverId: home.id, accountId: 'alice' };
    const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const session = createSessionFixture({ id: 'offline-bot', serverId: home.id, encryptionMode: 'plain',
        metadata: { machineId: 'sleeping', path: '/work', host: 'laptop', flavor: 'codex' }, access: createSessionAccessFixture('owner') });
    storage.getState().applyMachines([createMachineFixture({ id: 'sleeping', active: false, activeAt: 0 })], true, { sourceServerId: home.id });
    storage.getState().markMachineListSettled(home.id);
    network.resetRequests();
    network.setHttpResponder(async input => new URL(String(input)).pathname === `/v2/sessions/${session.id}`
        ? Response.json(createPlainSessionByIdResponseFixture(session)) : null);
    let renders = 0;
    const hook = await renderHook(({ enabled }: { enabled: boolean }) => {
        renders += 1;
        return useSessionReadiness({ accountLifetime, sessionId: session.id, enabled });
    }, { initialProps: { enabled: false } });
    expect(hook.getCurrent().readiness).toBeNull();
    expect(network.httpRequests).toEqual([]);
    expect(network.requests).toEqual([]);
    expect(network.credentialRequests).toEqual([]);
    await hook.rerender({ enabled: true });
    await vi.waitFor(() => expect(hook.getCurrent().readiness).toMatchObject({ configured: true,
        status: 'unavailable', cause: 'machine', machine: { status: 'offline', machineId: 'sleeping' } }));
    expect(hook.getCurrent().repair).toBeNull();
    expect(network.requests).toEqual([]);
    const requested = network.httpRequests.length;
    const openedRenders = renders;
    await act(async () => { storage.setState({ socketStatus: 'connecting' }); });
    expect(renders).toBe(openedRenders);
    expect(network.httpRequests).toHaveLength(requested);
    await hook.rerender({ enabled: false });
    const closedRenders = renders;
    await act(async () => { storage.setState({ socketStatus: 'disconnected' }); });
    expect(renders).toBe(closedRenders);
    await hook.getCurrent().refresh();
    expect(network.httpRequests).toHaveLength(requested);
});

it('shares exact native repair facts with the status Action and refreshes through the inventory owner', async () => {
    const home = await network.addHome('https://readiness-native.test', 'alice');
    const scope = { serverId: home.id, accountId: 'alice' };
    const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const session = createSessionFixture({ id: 'native-bot', serverId: home.id, encryptionMode: 'plain',
        metadata: { machineId: 'native-machine', path: '/work', host: 'server', flavor: 'codex' }, access: createSessionAccessFixture('owner') });
    const machine = createMachineFixture({ id: 'native-machine', active: true, activeAt: Date.now(),
        access: AccessibleMachineAccessV1Schema.parse({ custodian: { accountId: 'alice', displayName: 'Alice' },
            role: 'manage', resourceMode: 'plain', accessState: 'ready' }) });
    storage.getState().applyMachines([machine], true, { sourceServerId: home.id });
    storage.getState().markMachineListSettled(home.id);
    network.resetRequests();
    network.setHttpResponder(async input => new URL(String(input)).pathname === `/v2/sessions/${session.id}`
        ? Response.json(createPlainSessionByIdResponseFixture(session)) : null);
    const native = createReadyMachineAgentInventoryFixture([{ agentId: 'codex', title: 'Codex' }]);
    let signedIn = false;
    network.setRpcAckResponder(async request => {
        if (request.method.includes('contributionRegistryProjection.describe')) return { ok: true,
            result: { protocolVersion: 1, projection: native.projection } };
        if (request.method === 'daemon.agents.install.list') return { ok: true, result: { jobs: [] } };
        if (request.method === 'capabilities.detect') return { ok: true, result: { protocolVersion: 1, results: { 'cli.codex': {
            ...native.capabilities.results['cli.codex'], data: { ...native.capabilities.results['cli.codex']!.data,
                signIn: { status: signedIn ? 'signedIn' : 'signedOut', loginSupport: 'login_terminal' },
                isLoggedIn: signedIn, authStatus: { state: signedIn ? 'logged_in' : 'logged_out', checkedAt: 1 } },
        } } } };
        throw new Error(`Unexpected readiness effect ${request.method}`);
    });
    const hook = await renderHook(() => useSessionReadiness({ accountLifetime, sessionId: session.id, enabled: true }));
    const repair = { actionId: 'machines.agents.signIn.start', input: { machineId: machine.id, agentId: 'codex', method: 'native' } };
    await vi.waitFor(() => expect(hook.getCurrent().repair).toEqual(repair));
    await act(async () => {
        const account = await captureLazyActionAccountContext(home.id);
        try {
            expect(await createUiSessionStatusGet(account)({ sessionId: session.id, readiness: true }))
                .toMatchObject({ ok: true, readiness: { cause: 'agent', agent: { state: 'needsSignIn', repair } } });
        } finally { account.dispose(); }
    });
    await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
    const inventory = (await import('@/agents/machineAgents/machineAgentInventoryStore')).machineAgentInventoryStore;
    const inventoryKey = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
    const inventoryEvents: unknown[] = [];
    const offInventory = inventory.subscribeAgent(inventoryKey, 'codex', () => {
        const snapshot = inventory.read(inventoryKey);
        inventoryEvents.push({ status: snapshot.status, agents: snapshot.agents.map(agent => ({ state: agent.state,
            native: agent.signIn.native?.status, stale: agent.stale, unavailable: agent.unavailableReason?.reason })) });
    });
    signedIn = true; // Native acknowledgement supplied by the real inventory transport boundary.
    const before = network.httpRequests.filter(request => request.method === 'GET' && new URL(request.url).pathname === `/v2/sessions/${session.id}`).length;
    await act(async () => { await refreshMachineAgents({ serverId: home.id, machineId: machine.id,
        accountLifetime, agentId: 'codex', force: true }); });
    await vi.waitFor(() => expect(hook.getCurrent().readiness?.status).toBe('ready'));
    offInventory();
    expect(network.httpRequests.filter(request => request.method === 'GET' && new URL(request.url).pathname === `/v2/sessions/${session.id}`), JSON.stringify(inventoryEvents)).toHaveLength(before + 1);
    expect(network.requests.some(request => request.method === 'daemon.agents.signIn.prepare')).toBe(false);
});

it('discards a late exact-Session response after the readiness detail closes', async () => {
    const home = await network.addHome('https://readiness-close.test', 'alice');
    const accountLifetime = { scope: { serverId: home.id, accountId: 'alice' }, isCurrent: () => true,
        onRetire: () => ({ dispose() {} }) };
    const gate = createDeferred<void>();
    const session = createSessionFixture({ id: 'late-bot', encryptionMode: 'plain', access: createSessionAccessFixture('view') });
    network.resetRequests();
    network.setHttpResponder(async input => {
        if (new URL(String(input)).pathname !== `/v2/sessions/${session.id}`) return null;
        await gate.promise;
        return Response.json(createPlainSessionByIdResponseFixture(session));
    });
    const hook = await renderHook(({ enabled }: { enabled: boolean }) => useSessionReadiness({ accountLifetime,
        sessionId: session.id, enabled }), { initialProps: { enabled: true } });
    await vi.waitFor(() => expect(network.httpRequests.some(request => request.url.endsWith(`/v2/sessions/${session.id}`))).toBe(true));
    await hook.rerender({ enabled: false });
    await act(async () => { gate.resolve(); });
    expect(hook.getCurrent().readiness).toBeNull();
    expect(hook.getCurrent().repair).toBeNull();
    expect(network.requests).toEqual([]);
});

it('answers a Session the Home reports missing as not found, so a picked Session needs no inventory to be refused', async () => {
    const home = await network.addHome('https://status-missing.test', 'alice');
    network.resetRequests();
    network.setHttpResponder(async input => new URL(String(input)).pathname === '/v2/sessions/gone'
        ? Response.json({ error: 'Session not found' }, { status: 404 }) : null);
    const account = await captureLazyActionAccountContext(home.id);
    try {
        expect(await createUiSessionStatusGet(account)({ sessionId: 'gone' })).toEqual({ ok: false, code: 'session_not_found' });
    } finally { account.dispose(); }
});

it('reads a Session the Action context names by the Home profile id when the captured Account scope carries the portable Home id', async () => {
    const home = await network.addHome('https://status-portable.test', 'alice');
    const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
    await setServerProfileIdentityForUrl(home.serverUrl, 'srv_status_portable');
    network.resetRequests();
    network.setHttpResponder(async input => new URL(String(input)).pathname === '/v2/sessions/gone'
        ? Response.json({ error: 'Session not found' }, { status: 404 }) : null);
    const account = await captureLazyActionAccountContext(home.id);
    try {
        expect(account.serverId).toBe('srv_status_portable');
        // The Home answers; it is not refused as another Home's Session.
        expect(await createUiSessionStatusGet(account)({ sessionId: 'gone', serverId: home.id })).toEqual({ ok: false, code: 'session_not_found' });
        expect(await createUiSessionStatusGet(account)({ sessionId: 'gone', serverId: 'another-home' })).toEqual({ ok: false, code: 'server_scope_mismatch' });
    } finally { account.dispose(); }
});

it('settles while a busy Session publishes unrelated arrivals without another status read', async () => {
    const home = await network.addHome('https://readiness-busy.test', 'alice');
    const accountLifetime = { scope: { serverId: home.id, accountId: 'alice' }, isCurrent: () => true,
        onRetire: () => ({ dispose() {} }) };
    const session = createSessionFixture({ id: 'busy-coordinator', serverId: home.id, encryptionMode: 'plain',
        metadata: { machineId: 'sleeping', path: '/work', host: 'laptop', flavor: 'codex' },
        access: createSessionAccessFixture('view') });
    storage.getState().applyMachines([createMachineFixture({ id: 'sleeping', active: false, activeAt: 0 })], true, { sourceServerId: home.id });
    storage.getState().markMachineListSettled(home.id);
    const gates: Array<ReturnType<typeof createDeferred<void>>> = [];
    network.resetRequests();
    network.setHttpResponder(async input => {
        if (new URL(String(input)).pathname !== `/v2/sessions/${session.id}`) return null;
        const gate = createDeferred<void>();
        gates.push(gate);
        await gate.promise;
        return Response.json(createPlainSessionByIdResponseFixture(session));
    });
    const hook = await renderHook(() => useSessionReadiness({ accountLifetime, sessionId: session.id, enabled: true }));
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    // A running turn publishes Session changes faster than one status read answers.
    await act(async () => {
        for (let index = 0; index < 20; index++) {
            publishHomeAccountChange(home.id, [session.id], { changeKinds: ['session'] });
        }
    });
    await act(async () => { gates[0]!.resolve(); });
    await vi.waitFor(() => expect(hook.getCurrent().readiness).toMatchObject({ cause: 'invocation' }));
    await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
    expect(gates).toHaveLength(1);
    await act(async () => {
        for (let index = 0; index < 20; index++) {
            publishHomeAccountChange(home.id, [session.id], { changeKinds: ['session'] });
        }
    });
    expect(gates).toHaveLength(1);
});

it('lets explicit Retry supersede a pending readiness read and ignores its late result', async () => {
    const home = await network.addHome('https://readiness-retry.test', 'alice');
    const accountLifetime = { scope: { serverId: home.id, accountId: 'alice' }, isCurrent: () => true,
        onRetire: () => ({ dispose() {} }) };
    const session = createSessionFixture({ id: 'retry-bot', serverId: home.id, encryptionMode: 'plain',
        metadata: { machineId: 'sleeping', path: '/work', host: 'laptop', flavor: 'codex' },
        access: createSessionAccessFixture('view') });
    const gate = createDeferred<void>();
    let reads = 0;
    const signals: Array<AbortSignal | null | undefined> = [];
    network.resetRequests();
    network.setHttpResponder(async (input, init) => {
        if (new URL(String(input)).pathname !== `/v2/sessions/${session.id}`) return null;
        reads++;
        signals.push(init?.signal);
        const first = reads === 1;
        if (first) await gate.promise;
        return Response.json(createPlainSessionByIdResponseFixture({ ...session,
            access: createSessionAccessFixture(first ? 'view' : 'admin') }));
    });
    const hook = await renderHook(() => useSessionReadiness({ accountLifetime, sessionId: session.id, enabled: true }));
    await vi.waitFor(() => expect(reads).toBe(1));
    await act(async () => { void hook.getCurrent().refresh(); });
    await vi.waitFor(() => expect(hook.getCurrent().readiness?.invocation?.level).toBe('admin'));
    expect(reads).toBe(2);
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => { gate.resolve(); });
    expect(hook.getCurrent().readiness?.invocation?.level).toBe('admin');
});

it('observes admitted selection keys without reading status for title or projection changes', async () => {
    const home = await network.addHome('https://readiness-selection.test', 'alice');
    const accountLifetime = { scope: { serverId: home.id, accountId: 'alice' }, isCurrent: () => true,
        onRetire: () => ({ dispose() {} }) };
    let session = createSessionFixture({ id: 'selection-bot', serverId: home.id, encryptionMode: 'plain',
        metadata: { machineId: 'machine-a', path: '/work', host: 'laptop', flavor: 'codex',
            sessionWorkspaceLocationV1: buildSessionWorkspaceLocationV1({ machineId: 'machine-a', agentPath: '/work', machinePath: '/work' }),
            modelSelectionIntentV1: { v: 1, updatedAt: 1, selection: {
                agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-5.6-luna',
            } } },
        access: createSessionAccessFixture('owner') });
    storage.getState().applyMachines([
        createMachineFixture({ id: 'machine-a', active: false, activeAt: 0 }),
        createMachineFixture({ id: 'machine-b', active: false, activeAt: 0 }),
    ], true, { sourceServerId: home.id });
    storage.getState().markMachineListSettled(home.id);
    storage.getState().applySessions([session]);
    network.resetRequests();
    network.setHttpResponder(async input => new URL(String(input)).pathname === `/v2/sessions/${session.id}`
        ? Response.json(createPlainSessionByIdResponseFixture(session)) : null);
    const hook = await renderHook(() => useSessionReadiness({ accountLifetime, sessionId: session.id, enabled: true }));
    await vi.waitFor(() => expect(hook.getCurrent().readiness?.machine).toMatchObject({ machineId: 'machine-a' }));
    const readCount = () => network.httpRequests.filter(request => request.method === 'GET' && new URL(request.url).pathname === `/v2/sessions/${session.id}`).length;
    const before = readCount();
    await act(async () => {
        for (let index = 0; index < 20; index++) {
            session = { ...session, agentStateVersion: index + 1, metadataVersion: session.metadataVersion + 1,
                metadata: structuredClone({ ...session.metadata!, name: `Title ${index}` }) };
            storage.getState().applySessions([session]);
            publishHomeAccountChange(home.id, [session.id], { changeKinds: ['session'] });
        }
    });
    expect(readCount()).toBe(before);
    await act(async () => {
        session = { ...session, metadataVersion: session.metadataVersion + 1,
            metadata: { ...session.metadata!, machineId: 'machine-b' } };
        storage.getState().applySessions([session]);
    });
    await vi.waitFor(() => expect(hook.getCurrent().readiness?.machine).toMatchObject({ machineId: 'machine-b' }));
    expect(readCount()).toBe(before + 1);
});

it('refreshes exact Machine and reconnect facts, then retires all readiness demand with its Account', async () => {
    const home = await network.addHome('https://readiness-recovery.test', 'alice');
    let current = true;
    const retire = new Set<() => void>();
    const accountLifetime = { scope: { serverId: home.id, accountId: 'alice' }, isCurrent: () => current,
        onRetire: (listener: () => void) => { retire.add(listener); return { dispose() { retire.delete(listener); } }; } };
    let session = createSessionFixture({ id: 'recovery-bot', serverId: home.id, encryptionMode: 'plain',
        metadata: { machineId: 'sleeping', path: '/work', host: 'laptop', flavor: 'codex' },
        access: createSessionAccessFixture('owner', { submitAgentInput: false }) });
    storage.getState().applyMachines([createMachineFixture({ id: 'sleeping', active: false, activeAt: 0 })], true, { sourceServerId: home.id });
    storage.getState().markMachineListSettled(home.id);
    // Inventory and access are independent inputs: settle inventory before measuring access recovery.
    await refreshMachineAgents({ serverId: home.id, machineId: 'sleeping', accountLifetime, agentId: 'codex' });
    network.resetRequests();
    network.setHttpResponder(async input => new URL(String(input)).pathname === `/v2/sessions/${session.id}`
        ? Response.json(createPlainSessionByIdResponseFixture(session)) : null);
    const hook = await renderHook(() => useSessionReadiness({ accountLifetime, sessionId: session.id, enabled: true }));
    await vi.waitFor(() => expect(hook.getCurrent().readiness).toMatchObject({
        machine: { machineId: 'sleeping' }, invocation: { capabilities: { submitAgentInput: false } },
    }));
    const readCount = () => network.httpRequests.filter(request => request.method === 'GET' && new URL(request.url).pathname === `/v2/sessions/${session.id}`).length;
    const before = readCount();
    await act(async () => { publishHomeAccountChange(home.id, ['another-machine'], { changeKinds: ['machine'] }); });
    expect(readCount()).toBe(before);
    session = { ...session, access: createSessionAccessFixture('owner') };
    await act(async () => { publishHomeAccountChange(home.id, ['sleeping'], { changeKinds: ['machineRecipientAccess'] }); });
    await vi.waitFor(() => expect(hook.getCurrent().readiness?.invocation?.capabilities.submitAgentInput).toBe(true));
    expect(readCount()).toBe(before + 1);
    await act(async () => { publishHomeAccountChange(home.id, undefined, { source: 'connected' }); });
    await vi.waitFor(() => expect(readCount()).toBe(before + 2));
    await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
    await act(async () => { current = false; for (const listener of retire) listener(); });
    expect(hook.getCurrent().readiness).toBeNull();
    await act(async () => {
        publishHomeAccountChange(home.id);
        publishHomeAccountChange(home.id, [session.id], { changeKinds: ['share'] });
        await hook.getCurrent().refresh();
    });
    expect(readCount()).toBe(before + 2);
});
