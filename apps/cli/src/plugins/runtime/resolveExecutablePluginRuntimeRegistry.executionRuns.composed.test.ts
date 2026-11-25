import fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { enableLocalSessionRpcCalls, registerLocalSessionRpcTarget } from '@/session/transport/rpc/localSessionRpcChannel';
import { captureProcessBirthWitness } from '@/daemon/processIdentity';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createCapabilitiesService } from '@/capabilities/service';
import { executionRunsCapability } from '@/capabilities/registry/toolExecutionRuns';
import { CHECKLIST_IDS } from '@/capabilities/checklistIds';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';

// The native OS peer check is the boundary; local routing, caller admission,
// contributed Actions and the Session RPC handler all use their real owners.
vi.mock('@/subprocess/supervision/processCustody', async original => ({
    ...await original<typeof import('@/subprocess/supervision/processCustody')>(),
    resolveProcessCustodyPeerIdentityExecutable: () => '/fixture/peer-identity',
    observeLocalIpcPeerIdentity: async () => ({ pid: process.pid, uid: process.getuid?.() ?? null }),
}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const custodyCases = [
    { name: 'owner starts a Run', approvalContext: {}, allowed: true },
    { name: 'broker owner Account requester starts a Run', broker: true,
        approvalContext: { runtimeAccountId: 'owner', actionRequestId: 'home-operation' }, allowed: true },
    { name: 'current Machine custodian starts a Run', approvalContext: {
        runtimeAccountId: 'owner',
        machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner',
            machineId: 'contributed-run-machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => true,
    }, allowed: true },
    { name: 'Manage guest cannot borrow the installed Account', approvalContext: {
        runtimeAccountId: 'machine-guest',
        machineAdmission: { actorAccountId: 'machine-guest', custodianAccountId: 'owner',
            machineId: 'contributed-run-machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => true,
    }, allowed: false },
    { name: 'Machine guest admission takes precedence over runtime Account attribution', approvalContext: {
        runtimeAccountId: 'owner',
        machineAdmission: { actorAccountId: 'machine-guest', custodianAccountId: 'owner',
            machineId: 'contributed-run-machine', installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => true,
    }, allowed: false },
    { name: 'another Account attribution cannot borrow the installed Account', approvalContext: {
        requesterWorkAttributionV1: { serverId: 'home', machineId: 'contributed-run-machine',
            installationId: 'installation', accountId: 'other-account' },
    }, allowed: false },
    { name: 'broker runtime Account requester alone cannot borrow the installed Account', broker: true,
        approvalContext: { runtimeAccountId: 'other-account', actionRequestId: 'home-operation' }, allowed: false },
] satisfies readonly { name: string; approvalContext: Partial<ActionExecutorContext>; allowed: boolean; broker?: boolean }[];

it.each(custodyCases.flatMap(testCase => (['attached', 'detached'] as const).map(scope => ({ ...testCase, scope,
    broker: 'broker' in testCase && testCase.broker }))))(
'$name through the $scope daemon transport', async ({ approvalContext, allowed, scope, broker }) => {
    const home = fastify();
    const homeUrl = 'http://contributed-run-home.test';
    const sessionId = 'c123456789012345678901234';
    const machineId = 'contributed-run-machine';
    const token = `h.${Buffer.from(JSON.stringify({ sub: 'owner', extras: { provenance: {
        v: 1, kind: 'terminal', authority: 'account_automation',
    } } })).toString('base64url')}.s`;
    const credentials = { token, encryption: null } as const;
    const session = createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain',
        metadata: JSON.stringify({ machineId, path: '/repo', permissionMode: 'read_only' }) });
    home.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
    home.get(`/v2/sessions/${sessionId}`, async () => ({ session }));
    home.get(`/v1/machines/${machineId}`, async () => ({ machine: { id: machineId, kind: 'persistent',
        managedMachineRef: null, active: true, revokedAt: null, replacedByMachineId: null } }));
    const restoreHttp = installAxiosFastifyAdapter({ app: home, origin: homeUrl });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ features: {}, capabilities: {} }), { status: 200 }));
    const plugin = definePlugin({ id: 'example.review-launch', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
        actions: { start: { title: 'Start review', surfaces: ['cli', 'plugin'], dangerLevel: 'safe',
            inputSchema: defineProtocolObject({}, { policy: 'closed' }),
            run: async (_input, context) => context.services.actions.execute('execution.run.start', {
                sessionId: scope === 'attached' ? sessionId : null, intent: 'delegate', backendTarget: { kind: 'agent',
                    identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                instructions: 'Review selected changes', permissionMode: 'read_only', retentionPolicy: 'ephemeral',
                runClass: 'bounded', ioMode: 'request_response',
            }),
        } },
    });
    const capabilities = createCapabilitiesService({ capabilities: [executionRunsCapability],
        checklists: { [CHECKLIST_IDS.NEW_SESSION]: [], [CHECKLIST_IDS.MACHINE_DETAILS]: [] },
        buildContext: async () => { throw new Error('No capability probes during start'); } });
    const admitted: unknown[] = [];
    const runtime = await runWithServerHttpBaseUrl(homeUrl, () => createAuthoredAdmittedPluginRuntimeFixture({
        plugins: [{ manifest: plugin.manifest, files: { 'daemon.mjs': 'export function activate() {}' },
            instantiateCommittedModule: () => ({ activate: plugin.activate }) }],
        runtimeOptions: { scopedActionRuntime: { credentials, actionsSettingsProvider: createActionSettingsProvider({
            getAccountSettings: () => ({ actionsSettingsV1: { v: 1, actions: {},
                approvalWaivedSurfaces: { 'execution.run.start': ['plugin'] } } }), allowEnvironmentOverride: false,
        }) }, resolveCurrentMachineId: () => machineId,
        machineActionDirectTargetTransport: { machineId, invoke: async (method, _request, options) => {
            if (method === RPC_METHODS.CAPABILITIES_DESCRIBE) return capabilities.describe();
            if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return null;
            // The installed Machine RPC adapter is the detached transport boundary.
            if (method === SESSION_RPC_METHODS.EXECUTION_RUN_START) {
                admitted.push(options?.localActionContext);
                return { runId: 'review-run', callId: 'review-call', sidechainId: 'review-call' };
            }
            throw new Error(`Unexpected Machine method ${method}`);
        } } },
    }));
    const environment = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    environment.patch({ HAPPIER_HOME_DIR: runtime.happyHomeDir });
    reloadConfiguration();
    enableLocalSessionRpcCalls();
    const manager = new RpcHandlerManager({ scopePrefix: sessionId, scopeKind: 'session', localMachineId: machineId,
        encryptionMode: 'plain', logger: () => {} });
    manager.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START, async (_request, context) => {
        admitted.push(context?.localActionContext);
        return { runId: 'review-run', callId: 'review-call', sidechainId: 'review-call' };
    });
    const birth = await captureProcessBirthWitness(process.pid);
    const retire = await registerLocalSessionRpcTarget({ sessionId, credentialToken: token,
        handleRequest: (request, context) => manager.handleRequest(request, undefined, 'local_session_channel', context),
        cancelRequest: requestId => manager.cancelTransportRequest(requestId), readTrustedCaller: async () => birth });
    try {
        const action = { pluginId: plugin.manifest.id, localId: 'start' };
        const sourceContext: ActionExecutorContext = { surface: broker ? 'plugin' : 'cli', callerPermissionMode: 'read_only',
            defaultSessionId: sessionId, defaultSessionMachineId: machineId, authority: 'account_automation', ...approvalContext };
        const result = await runWithServerHttpBaseUrl(homeUrl, () => runtime.registry.targetActionInvocations!.invoke({
            ...action, input: {}, surface: broker ? 'plugin' : 'cli',
            ...(broker ? { invocationSurface: 'plugin' as const, invocationAuthority: 'account_automation' as const,
                requestId: sourceContext.actionRequestId } : {}),
            approvalContext: { ...sourceContext, ...(broker ? { hostReviewedChild: createHostReviewedChildPortV1({
                actionId: ACTION_INVOKE_ACTION_ID_V1, input: { action, input: {} }, context: sourceContext, reviewAdmitted: true,
            }) } : {}) },
        }));
        if (allowed) {
            expect(result, JSON.stringify(result)).toMatchObject({ status: 'executed', value: { runId: 'review-run' } });
            expect(admitted).toMatchObject([{ callerPermissionMode: 'read_only', authority: 'account_automation' }]);
        } else {
            expect(result).toMatchObject({ status: 'failed', code: 'execution_run_target_unavailable',
                data: { details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } } });
            expect(admitted).toEqual([]);
        }
    } finally {
        await retire(); environment.restore(); reloadConfiguration();
        try { await runtime.dispose(); } finally { restoreHttp(); await home.close(); }
    }
});
