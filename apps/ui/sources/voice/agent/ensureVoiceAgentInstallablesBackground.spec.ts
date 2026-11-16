import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildQualifiedPluginContributionKey} from '@happier-dev/protocol/plugins/contribution-key';
import { createPluginContributionIdentity} from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { createPlainMachineRowFixture, createSessionFixture, standardCleanup } from '@/dev/testkit';
import { createHydratedPlainMachineFixture, createMachineReadBatchResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';

const fixtureMetadata = (() => {
    const metadata = createSessionFixture().metadata;
    if (!metadata) throw new Error('Canonical Session fixture metadata missing');
    return metadata;
})();
import { clearProjectedAgentUiBehaviorDescriptors } from '@/agents/registry/agentUiBehaviorProjection';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

const requests: Array<{ machineId: string; method: string; payload: unknown }> = [];
const installs: string[] = [];
let account: Awaited<ReturnType<typeof import('@/voice/settings/panels/voiceSettingsAccountTestHarness').createVoiceSettingsAccountTestHarness>>;

const externalAgentIdentity = createPluginContributionIdentity({ pluginId: 'acme.tools', localId: 'agent' });
const externalAgentId = buildQualifiedPluginContributionKey(externalAgentIdentity);
const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {
    [externalAgentId]: {
        id: externalAgentId, identity: externalAgentIdentity, title: 'Acme Agent', channel: 'plugin',
        ui: { behavior: { newSession: { relevantInstallableDepKeys: ['codex-acp'] } } },
    },
}, familiesById: {
    managedDependencies: { family: 'managedDependencies', entriesById: { 'codex-acp': {
        id: 'codex-acp', pluginId: externalAgentIdentity.pluginId, key: 'codex-acp', capabilityId: 'dep.codex-acp',
        sourceKind: 'github_release_binary', display: { name: 'Codex ACP' },
        defaultPolicy: { autoInstallWhenNeeded: true, autoUpdateMode: 'auto' }, experimental: true,
    } } },
} });

beforeEach(async () => {
    requests.length = 0;
    installs.length = 0;
    const { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    installDisconnectedServerSocketBoundary(socket => {
        configureConnectedServerSocketBoundary(socket);
        socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
            if (event !== 'rpc-call') throw new Error('Unexpected Machine RPC event');
            const input = payload as { method: string; params: unknown };
            const separator = input.method.indexOf(':');
            const request = { machineId: input.method.slice(0, separator),
                method: input.method.slice(separator + 1), payload: input.params };
            requests.push(request);
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: true, result: { protocolVersion: 1, projection } };
            }
            if (request.method === RPC_METHODS.CAPABILITIES_DETECT) {
                return { ok: true, result: { protocolVersion: 1, results: { 'dep.codex-acp': {
                    ok: true, checkedAt: Date.now(), data: {
                        installed: installs.includes(request.machineId), installDir: '/managed',
                        binPath: null, installedVersion: null, sourceKind: 'github_release_binary',
                        lastInstallLogPath: null, lastBackgroundUpdateCheckAtMs: null,
                    },
                } } } };
            }
            if (request.method === RPC_METHODS.CAPABILITIES_INVOKE) {
                expect(request.payload).toMatchObject({ id: 'dep.codex-acp', method: 'install' });
                installs.push(request.machineId);
                return { ok: true, result: { ok: true, result: null } };
            }
            return { ok: true, result: { error: 'Method not found', errorCode: 'RPC_METHOD_NOT_FOUND' } };
        });
    });
    const { createVoiceSettingsAccountTestHarness } = await import('@/voice/settings/panels/voiceSettingsAccountTestHarness');
    account = await createVoiceSettingsAccountTestHarness(settingsParse({}));
    const fallback = account.request.getMockImplementation();
    if (!fallback) throw new Error('Expected canonical Account HTTP boundary');
    account.request.mockImplementation(async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/machines/read-batch' && init?.method === 'POST') {
            return createMachineReadBatchResponseFixture(init.body,
                id => createPlainMachineRowFixture({ id, accountId: account.scope.accountId }));
        }
        const match = /^\/v1\/machines\/([^/]+)(\/access)?$/.exec(path);
        if (match) {
            const machineId = decodeURIComponent(match[1]);
            const machine = createPlainMachineRowFixture({ id: machineId, accountId: account.scope.accountId });
            if (!machine.access) throw new Error('Canonical Machine access missing');
            return Response.json(match[2] ? MachineAccessGrantsListResponseV1Schema.parse({
                machineId, custodian: machine.access.custodian, access: machine.access,
                canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [],
            }) : { machine });
        }
        return fallback(input, init);
    });
    const machineIds = ['machine-raw', 'machine-cached', 'machine-target'];
    storage.setState({ sessions: {}, machines: Object.fromEntries(machineIds.map(id => [id,
        createHydratedPlainMachineFixture({ id, accountId: account.scope.accountId,
            machine: { activeAt: Date.now() } })])), sessionListRowsByServerId: {},
        ordinarySessionListMembershipByServerId: {}, sessionListIndexByServerId: {},
        concurrentSessionListCacheByServerId: {} });
    await publishMachineInventoryForTest(account.scope, Object.values(storage.getState().machines));
    const { loadDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
    for (const machineId of machineIds) {
        await expect(loadDaemonMergedProjectionInputs({ sections: 'complete', machineId, serverId: account.scope.serverId }))
            .resolves.toMatchObject({ pluginProjectionV2: { agentsById: { [externalAgentId]: { identity: externalAgentIdentity } } } });
    }
    // Separate real projection preparation from the target-selection operation's transport receipts.
    requests.length = 0;
});
afterEach(async () => {
    clearProjectedAgentUiBehaviorDescriptors();
    await account?.dispose();
    await standardCleanup();
});
async function publishTarget(withReplacement = false) {
    const serverId = account.scope.serverId;
    storage.setState({ sessions: { s1: createSessionFixture({ id: 's1', serverId,
        // A stale raw row has no usable execution path; the visible row supplies it.
        metadata: { ...fixtureMetadata, machineId: 'machine-raw', path: withReplacement ? '/tmp/raw' : '' } }) },
        machines: {
            'machine-raw': createHydratedPlainMachineFixture({ id: 'machine-raw', accountId: account.scope.accountId,
                machine: { active: !withReplacement,
                activeAt: withReplacement ? 1 : Date.now(),
                ...(withReplacement ? { replacedByMachineId: 'machine-target', replacedAt: 2 } : {}) } }),
            'machine-cached': createHydratedPlainMachineFixture({ id: 'machine-cached', accountId: account.scope.accountId,
                machine: { activeAt: Date.now() } }),
            'machine-target': createHydratedPlainMachineFixture({ id: 'machine-target', accountId: account.scope.accountId,
                machine: { activeAt: Date.now() } }),
        },
        sessionListRowsByServerId: { [serverId]: { s1: createSessionFixture({ id: 's1', serverId,
            metadata: { ...fixtureMetadata, machineId: 'machine-cached', path: '/tmp/cached' } }) } },
        ordinarySessionListMembershipByServerId: { [serverId]: ['s1'] },
        sessionListIndexByServerId: { [serverId]: [{ type: 'session', sessionId: 's1', serverId, serverName: 'Test' }] },
    });
    await publishMachineInventoryForTest(account.scope, Object.values(storage.getState().machines));
}

describe('ensureVoiceAgentInstallablesBackground', () => {
    it('installs on the visible lookup machine when raw session metadata is stale', async () => {
        await publishTarget();
        const { ensureVoiceAgentInstallablesBackground } = await import('./ensureVoiceAgentInstallablesBackground');
        await ensureVoiceAgentInstallablesBackground({ agentId: externalAgentId, sessionId: 's1' });
        expect(installs).toEqual(['machine-cached']);
        expect(requests.filter(request => request.method === RPC_METHODS.CAPABILITIES_DETECT))
            .toEqual(expect.arrayContaining([expect.objectContaining({ machineId: 'machine-cached' })]));
        expect(new Set(requests.map(request => request.machineId))).toEqual(new Set(['machine-cached']));
    });
    it('installs on the resolved replacement before raw or visible metadata', async () => {
        await publishTarget(true);
        const { ensureVoiceAgentInstallablesBackground } = await import('./ensureVoiceAgentInstallablesBackground');
        await ensureVoiceAgentInstallablesBackground({ agentId: externalAgentId, sessionId: 's1' });
        expect(installs).toEqual(['machine-target']);
        expect(requests.filter(request => request.method === RPC_METHODS.CAPABILITIES_DETECT))
            .toEqual(expect.arrayContaining([expect.objectContaining({ machineId: 'machine-target' })]));
        expect(new Set(requests.map(request => request.machineId))).toEqual(new Set(['machine-target']));
    });
    it('honors an installed external Agent declaration at the raw session machine', async () => {
        await publishTarget();
        storage.setState({ sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {},
            sessionListIndexByServerId: {} });
        storage.setState({ sessions: { s1: createSessionFixture({ id: 's1', serverId: account.scope.serverId,
            metadata: { ...fixtureMetadata, machineId: 'machine-raw', path: '/tmp/raw' } }) } });
        const { ensureVoiceAgentInstallablesBackground } = await import('./ensureVoiceAgentInstallablesBackground');
        await ensureVoiceAgentInstallablesBackground({ agentId: externalAgentId, sessionId: 's1' });
        expect(installs).toEqual(['machine-raw']);
    });
});
