import { resolve } from 'node:path';
import fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { DaemonPluginUiTargetedContributionsReadRequestSchema, DaemonPluginUiTargetedContributionsReadResponseSchema,
    DaemonPluginTargetedSourceDeclarationV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { DaemonPluginStructuredMessageActionExecuteRequestSchema } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import { readSignedHomeAuthorizationHttpError } from '@/api/client/homeAuthorizationHttpFailure';
import { createRpcCallError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { MachineRpcEncryptionModeMismatchError } from '@/session/transport/rpc/machineRpc';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAccountHomeHttp } from '@/session/actions/widgetApproval.testkit';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { executeAccountPluginAction } from '@/session/actions/executeAccountPluginAction';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import type { MachineActionDirectTargetTransport } from '@/session/actions/createCliActionDeps';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';
import { manifest as admittedSourceManifest } from './accountMachineActionIntent.fixture';
import { resolveAccountMachineSourceActionMachine } from './invocation/actions/accountMachineActionTransport';

const { machineRpc } = vi.hoisted(() => ({ machineRpc: vi.fn() }));
vi.mock('@/session/transport/rpc/machineRpc', async importOriginal => ({
    ...await importOriginal<typeof import('@/session/transport/rpc/machineRpc')>(),
    // The exact Machine RPC transport is the external system boundary. Strict
    // producer/consumer schemas and the whole local invocation stay real.
    callExactMachineRpc: machineRpc,
}));
afterEach(() => vi.restoreAllMocks());

it('keeps the selected Machine for a declared optional Session operand that is absent', async () => {
    expect(await resolveAccountMachineSourceActionMachine({ credentials: { token: 'owner', encryption: null, credentialProvenance: 'stored_session' },
        serverUrl: 'http://unused-home.test', machineId: 'selected-machine',
        declaration: { field: 'sessionId', cardinality: 'one' }, input: { entry: 'account-entry' } }))
        .toEqual({ status: 'available', machineId: 'selected-machine' });
});

const inputSchema = defineProtocolObject({ key: defineProtocolString() }, { policy: 'closed' });
const resultSchema = defineProtocolObject({ key: defineProtocolString(), machine: defineProtocolLiteral(true) }, { policy: 'closed' });
const protocol = defineContributionProtocol({ id: 'account-machine-read', version: 1, operations: {
    read: { required: true, input: { kind: 'protocolDefined', schema: inputSchema }, resultSchema,
        action: { surfaces: ['plugin'], dangerLevel: 'safe' } },
} });
const provider = definePlugin({ id: 'acme.account-source-provider', version: '1.0.0', actions: {
    read: { title: 'Read provider', surfaces: ['plugin'], dangerLevel: 'safe', inputSchema, resultSchema,
        run: async ({ key }) => ({ key, machine: true as const }) },
}, contributesTo: { 'acme.account-actions': { sources: {
    provider: protocol.contribute({ operations: { read: protocol.operations.read.bind('read') } }),
} }, 'acme.account-admitted': { sources: {
    provider: protocol.contribute({ operations: { read: protocol.operations.read.bind('read') } }),
} } } });

it.each([
    { outcome: 'acknowledged', placement: 'selected' },
    { outcome: 'ui', placement: 'selected' },
    { outcome: 'uiAutomation', placement: 'selected' },
    { outcome: 'workflow', placement: 'selected' },
    { outcome: 'lostAck', placement: 'selected' },
    { outcome: 'authoredRefusal', placement: 'selected' },
    { outcome: 'notSent', placement: 'selected' },
    { outcome: 'authorizationRefused', placement: 'selected' },
    { outcome: 'modeMismatch', placement: 'selected' },
    { outcome: 'unclassified', placement: 'selected' },
    { outcome: 'declarationRefusal', placement: 'selected' },
    { outcome: 'declarationRefusalTransport', placement: 'selected' },
    { outcome: 'acknowledged', placement: 'session' },
    { outcome: 'acknowledged', placement: 'sessionLookup' },
] as const)('keeps an authored Account aggregate local and preserves its $placement Machine source outcome ($outcome)', async ({ outcome, placement }) => {
    const presentUi = outcome === 'ui' || outcome === 'authoredRefusal';
    const app = fastify();
    const endpoint = 'http://account-machine.test';
    const features = registerAccountHomeHttp(app, { accountId: 'owner', serverId: 'account-machine' });
    if (placement === 'sessionLookup') app.get('/v2/sessions/bound-session', async () => ({ session: {
        id: 'bound-session', seq: 1, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        encryptionMode: 'plain', metadata: JSON.stringify({ machineId: 'selected-machine' }), metadataVersion: 1,
        dataEncryptionKey: null, agentState: null, agentStateVersion: 0, responsibleAccountId: null, responsibleAccount: null,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
    } }));
    const { pluginId } = await registerAuthoredAccountActionRelease(app, 'owner', presentUi || outcome === 'uiAutomation' ? { primary: {
        manifest: admittedSourceManifest, projectRoot: resolve(import.meta.dirname, '../../../../../packages/plugin-sdk/fixtures/account-actions'),
        entryPath: resolve(import.meta.dirname, 'accountMachineActionIntent.fixture.ts'),
    } } : {});
    const manifest = normalizePluginManifestV2(provider.manifest);
    const source = DaemonPluginTargetedSourceDeclarationV1Schema.parse({ manifest: { id: manifest.id, contributes: {
        actions: manifest.contributes.actions, pluginContributionPoints: [],
        targetedPluginContributions: manifest.contributes.targetedPluginContributions.filter(entry => entry.target.pluginId === pluginId), ui: { renderers: [] },
    } }, occurrenceId: 'provider-machine-occurrence', sourceCustody: {
        kind: 'managed', immutableGenerationId: 'provider-machine-generation', installSource: 'archive',
    } });
    let providerEffects = 0;
    const requests: Parameters<typeof import('@/session/transport/rpc/machineRpc').callExactMachineRpc>[0][] = [];
    machineRpc.mockImplementation(async (request: Parameters<typeof import('@/session/transport/rpc/machineRpc').callExactMachineRpc>[0]) => {
        requests.push(request);
        if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) {
            if ((outcome === 'declarationRefusal' || outcome === 'declarationRefusalTransport') && request.request && typeof request.request === 'object'
                && 'sourcePluginId' in request.request) {
                if (outcome === 'declarationRefusalTransport') throw markRpcRequestDisposition(createRpcCallError({
                    error: 'Machine transport unavailable', errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE }), 'notSent');
                return { status: 'unavailable', code: 'plugin_targeted_contributions_unavailable' };
            }
            return DaemonPluginUiTargetedContributionsReadResponseSchema.parse({ status: 'sourceDeclarations',
                pluginId, sourceDeclarations: [source] });
        }
        if (outcome === 'notSent') throw markRpcRequestDisposition(createRpcCallError({
            error: 'Machine transport unavailable', errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE }), 'notSent');
        if (outcome === 'authorizationRefused') {
            const refusal = readSignedHomeAuthorizationHttpError(403, {
                error: 'credential_scope_denied', authorizationRefusal: 'effect_family',
            });
            if (!refusal) throw new Error('Expected a signed Home authorization refusal');
            throw markRpcRequestDisposition(refusal, 'notSent');
        }
        if (outcome === 'modeMismatch') throw markRpcRequestDisposition(new MachineRpcEncryptionModeMismatchError('selected-machine'), 'notSent');
        if (outcome === 'unclassified') throw markRpcRequestDisposition(new Error('Unclassified preparation failure'), 'notSent');
        providerEffects++;
        if (outcome === 'lostAck') throw new Error('Machine acknowledgement lost after effect');
        if (outcome === 'authoredRefusal') return { ok: false, code: 'credential_unavailable',
            message: 'Reconnect the selected account.', remediation: { kind: 'retry' } };
        return { ok: true, result: { key: 'provider', machine: true } };
    });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(features));
    try {
        const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`,
            encryption: null, credentialProvenance: 'stored_session' as const };
        const cli = createCliActionExecutorFromCredentials({ credentials, serverId: 'account-machine',
            serverIdentityId: 'account-machine', serverApiUrl: endpoint,
            ...(placement === 'selected' ? { machineId: 'selected-machine' } : {}) });
        const workflowRunId = 'admitted-run';
        const workflowActionMachineTransport: MachineActionDirectTargetTransport = {
            machineId: 'selected-machine', workflowRunId,
            invoke: async (method, request, options) => {
                expect(method).toBe(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
                expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request)).toMatchObject({
                    executionSurface: 'agent', expectedContributorOccurrenceId: source.occurrenceId,
                    invocation: { kind: 'clientPluginAction', clientActionBinding: { pluginId } },
                });
                expect(options?.localActionContext).toMatchObject({
                    actionCaller: { kind: 'workflowRun', runId: workflowRunId },
                    authority: 'account_automation', executionRunWorkflowRunId: workflowRunId,
                    runtimeAccountId: 'owner',
                });
                providerEffects++;
                return { ok: true, result: { key: 'provider-with-workflow-custody', machine: true } };
            },
        };
        const context: ActionExecutorContext & { workflowActionMachineTransport?: MachineActionDirectTargetTransport } = {
            surface: outcome === 'workflow' ? 'agent' : presentUi || outcome === 'uiAutomation' ? 'ui' : 'cli',
            ...(outcome === 'workflow' ? {
                actionCaller: { kind: 'workflowRun' as const, runId: workflowRunId,
                    authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const } },
                executionRunWorkflowRunId: workflowRunId, executionRunTargetMachineId: 'selected-machine',
                workflowActionMachineTransport,
            } : {}),
            ...(presentUi ? { authority: 'present_user' as const } : outcome === 'uiAutomation' ? { authority: 'account_automation' as const } : {}),
            actionRequestId: '4d13dc15-d859-4c0e-9abe-d561a12894d5',
            runtimeAccountId: 'owner', serverId: 'account-machine', serverIdentityId: 'account-machine',
            ...(placement !== 'selected' ? { defaultSessionId: 'bound-session' } : {}),
            ...(placement === 'session' ? { defaultSessionMachineId: 'selected-machine' } : {}),
        };
        const input = { action: { pluginId, localId: 'source' }, input: { key: 'provider' } };
        const result = presentUi || outcome === 'uiAutomation' || outcome === 'workflow'
            ? await (async () => {
                const host = { token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain' as const, ctx: null,
                    serverHttpBaseUrl: endpoint, runtimeActionMachineId: 'selected-machine',
                    serverId: 'account-machine', serverIdentityId: 'account-machine' };
                const { deps } = createCliActionExecutorHarness(host);
                const attempt = await executeAccountPluginAction({ host, deps, actionId: 'action.invoke', input, context });
                if (!attempt.matched) throw new Error('Expected Account Action placement');
                return attempt.result;
            })()
            : await cli.execute('action.invoke', input, context);
        expect(result, JSON.stringify(result)).toMatchObject(outcome === 'notSent' || outcome === 'declarationRefusalTransport'
            ? { ok: false, errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE }
            : outcome === 'authorizationRefused' ? { ok: false, errorCode: 'action_forbidden' }
            : outcome === 'modeMismatch' ? { ok: false, errorCode: 'machine_content_mode_mismatch' }
            : outcome === 'unclassified' ? { ok: false, errorCode: 'plugin_action_execution_failed' }
            : outcome === 'declarationRefusal' ? { ok: false, errorCode: 'plugin_targeted_contributions_unavailable' }
            : outcome === 'lostAck' ? { ok: false, errorCode: 'plugin_action_outcome_unknown' }
            : outcome === 'authoredRefusal' ? { ok: false, errorCode: 'credential_unavailable',
                details: { name: 'PluginError', remediation: { kind: 'retry' } } }
            : { ok: true, result: { key: outcome === 'workflow' ? 'provider-with-workflow-custody' : 'provider', machine: true } });
        for (const request of requests) {
            expect(request.machineId).toBe('selected-machine');
            expect(request.requireCurrentMachine).toBe(true);
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) {
                expect(DaemonPluginUiTargetedContributionsReadRequestSchema.parse(request.request))
                    .toMatchObject({ pluginId, readMode: 'sourceDeclarations' });
            } else {
                expect(request.method).toBe(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE);
                const input = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request.request);
                expect(input).toMatchObject({ qualifiedActionId: `${manifest.id}/read`, expectedContributorOccurrenceId: source.occurrenceId,
                    invocation: { kind: 'clientPluginAction', clientActionBinding: { pluginId, contributionLocalId: 'source',
                        sourceCustody: { kind: 'account_release', pluginId } } } });
                expect(input.invocation?.kind === 'clientPluginAction' && input.invocation.clientActionBinding.materializationRef).toBeUndefined();
                expect(input.executionSurface).toBe(presentUi ? 'ui' : 'cli');
                expect(input.presentUserIntent).toBe(presentUi ? 'confirmed' : undefined);
                expect(input.requestId).toBe(context.actionRequestId);
                expect(request.authorityCeiling).toBe(presentUi ? undefined : 'account_automation');
            }
        }
        expect(providerEffects).toBe(['notSent', 'authorizationRefused', 'modeMismatch', 'unclassified', 'declarationRefusal', 'declarationRefusalTransport'].includes(outcome) ? 0 : 1);
    } finally { restore(); await app.close(); }
});
