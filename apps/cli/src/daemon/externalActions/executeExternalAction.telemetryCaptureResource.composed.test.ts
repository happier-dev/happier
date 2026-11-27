import { afterEach, expect, it, vi } from 'vitest';
import axios from 'axios';
import nacl from 'tweetnacl';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import {
    computeExternalActionRequestEnvelopeDigestV1,
    createActionExecutor,
    openExternalActionResponseV2,
    sealExternalActionRequestV2,
} from '@happier-dev/protocol/actions';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { DATABASE_CAPTURE_LIST_ACTION_BY_VIEW_V1, DATABASE_CAPTURE_STATUS_ACTION_ID_V1, TELEMETRY_METRICS_READ_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { DATABASE_CAPTURE_RESOURCE_ID_V1, TELEMETRY_REQUESTS_WINDOW_MS_V1 } from '@happier-dev/database-protocol';
import { projectDeploymentReadAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentReadAdmissionV1';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { computeMachineInstallationKeyFingerprintV1 } from '@happier-dev/protocol/machines/identity/installationKeySchemas';
import { sealManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import type { RpcHandler } from '@/api/rpc/types';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { registerDaemonContributionRegistryProjectionHandler } from '@/rpc/handlers/daemonContributionRegistryProjection';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { executeExternalAction } from './executeExternalAction';

const credentials = vi.hoisted(() => ({ token: `e30.${Buffer.from(JSON.stringify({ sub: 'capture-owner' })).toString('base64url')}.signature`, encryption: null }));
// Stored credentials are an OS boundary. Action transport, registry and Resource custody run in process.
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(), readStoredCredentials: async () => credentials }));
afterEach(() => resetActiveAccountSettingsSnapshotForTests());

it.each([['worktree', 'endpoints'], ['environment', 'endpoints'], ['environment', 'costs'], ['environment', 'metrics'],
    ['environment', 'status'], ['environment', 'services']] as const)(
    'reuses the selected %s %s producer after signed ingress closes', async (kind, view) => {
    const action = parseQualifiedPluginActionId(view === 'status' ? DATABASE_CAPTURE_STATUS_ACTION_ID_V1
        : view === 'services' ? TELEMETRY_METRICS_READ_ACTION_ID_V1 : DATABASE_CAPTURE_LIST_ACTION_BY_VIEW_V1[view])!;
    const pluginId = action.pluginId;
    const localId = DATABASE_CAPTURE_RESOURCE_ID_V1;
    const serverIdentityId = 'srv_capture';
    const machineId = 'capture-machine';
    const installationId = 'fixture-installation';
    const environmentId = 'chosen-environment';
    const environmentIds = view === 'services' ? [environmentId, 'mounted-neighbor'] : [environmentId];
    const accountId = kind === 'worktree' ? 'capture-owner' : 'team-reader';
    const encryptionMode = kind === 'worktree' ? 'plain' : 'e2ee';
    const channel = await createRequesterCurrentnessSocketHarness();
    const http = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'capture-owner' } };
        if (url.includes('/v2/changes?')) return { status: 200, data: { changes: [], nextCursor: 0 } };
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (url.endsWith('/v2/account/settings')) return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
        throw new Error(`Unexpected Home read: ${new URL(url).pathname}`);
    });
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token) });

    let opened = 0;
    let captureRevision = 0;
    let disposed = 0;
    let producerInvalidate: (() => void) | undefined;
    let producerSignal: AbortSignal | undefined;
    const capture = definePlugin({ id: pluginId, version: '0.0.0', entrypoints: { daemon: './daemon.mjs' },
        resources: {
            [localId]: { source: 'dynamic', kind: 'config', contentType: 'application/json', scope: 'surface', execution: { target: 'daemon' },
                runtime: { read() { throw new Error('Expected the capture producer'); }, observe() { throw new Error('Expected the capture producer'); },
                    async createProducer(context) {
                        if (!context.daemonStorage) throw new Error('Missing retained storage');
                        const admission = kind === 'worktree'
                            ? { accountId: context.requesterAccount?.accountId }
                            : await Promise.all(environmentIds.map(environmentId => context.deploymentDatabases?.admitTelemetryRead?.({
                                serverId: serverIdentityId, environmentId,
                            })));
                        opened++;
                        producerSignal = context.signal;
                        return { read: () => JSON.stringify({ admission, scope: context.context, captureRevision }),
                            observe(invalidate) { producerInvalidate = invalidate; return { dispose() { producerInvalidate = undefined; } }; },
                            dispose() { disposed++; } };
                    } },
            },
        },
    });
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: capture.manifest,
        files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: capture.activate }) }],
        async resolveContributes(happyHomeDir) { return createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })); },
        runtimeOptions: { resolveCurrentMachineId: () => machineId,
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId, machineId }) } });
    const handlers = new Map<string, RpcHandler>();
    registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
        resolveRuntimeRegistry: async () => fixture.registry, resolveInstalledPackages: async () => [],
        readHostResourceAccountId: () => 'capture-owner',
        resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId, machineId }),
    });
    const target = { kind: 'machine' as const, machineId };
    const source = kind === 'worktree'
        ? { kind, serverId: serverIdentityId, machineId, projectId: 'billing-api', workspaceId: 'selected-folder' }
        : { kind, serverId: serverIdentityId, environmentId };
    const input = { action, input: view === 'services' ? { entity: 'service', serverId: serverIdentityId, environmentIds, includeTrend: false }
        : view === 'metrics'
        ? { view: 'overview', serverId: serverIdentityId, environmentId, serviceName: 'billing-api', serviceVersion: 'v42' }
        : view === 'costs'
            ? { source, serviceName: 'billing-api', serviceVersion: 'v42', granularity: 'day', groupByRoute: true }
            : view === 'status' ? { source } : { source, page: { limit: 6 } } };
    const resource = { hostRead: 'telemetry.capture' as const, input, ...(view === 'status' ? {}
        : { windowMs: view === 'services' ? TELEMETRY_REQUESTS_WINDOW_MS_V1 : 60_000 }) };
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(18) };
    const executor = createActionExecutor(createUnavailableActionTransportDeps());

    type Method = typeof RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ | typeof RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN
        | typeof RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE;
    async function run(method: Method, signal: AbortSignal, selected = resource,
        onFrame?: (frame: unknown) => void) {
        const binding = { serverIdentityId, accountId, authentication: { kind: 'account' as const, tokenEpoch: 0 },
            actionId: ACTION_INVOKE_ACTION_ID_V1, requestId: `${kind}-${method}`, target };
        const resourceContinuation = method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ
            ? { method, params: { machineId, resource: selected } }
            : { method, params: { machineId, resource: selected, subscriptionId: 'selected-capture' } };
        const envelope = encryptionMode === 'e2ee'
            ? { ...sealExternalActionRequestV2({ binding, input, material, resourceContinuation,
                projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, randomBytes: nacl.randomBytes }),
                telemetryCollectorCodec: true as const }
            : { v: 1 as const, requestId: binding.requestId, target, input, resourceContinuation };
        const admitted = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-signed-home-proof', binding: {
            ...binding, custodianAccountId: 'capture-owner', machineId, installationId, accountEncryptionMode: encryptionMode,
            ...(kind === 'worktree' ? { admittedMachineRole: 'manage' } : { telemetryCollectorCodec: true,
                deploymentReadAdmission: projectDeploymentReadAdmissionV1(binding.actionId, input),
                deploymentTelemetryRead: environmentIds.map(environmentId => ({ environmentId, revision: 7, capabilities: {} })) }),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } });
        const authorization = kind === 'worktree' ? admitted : sealManagedControllerActionCodecV1({ authorization: admitted, material,
            installationPublicKey: installation.publicKey, randomBytes: nacl.randomBytes,
            collectorKeyPins: environmentIds.map(environmentId => ({ environmentId, collector: { machineId,
                installationKeyFingerprint: computeMachineInstallationKeyFingerprintV1(installation.publicKey) } })) });
        const openExecution = (response: Extract<Awaited<ReturnType<typeof executeExternalAction>>, { kind: 'response' }>['response']) =>
            envelope.v === 2 ? openExternalActionResponseV2({ envelope: response, binding, material, request: envelope })
                : response.v === 1 ? response.execution : null;
        const result = await executeExternalAction({ actionId: binding.actionId, envelope, executionAuthorization: authorization,
            principal: { accountId, authentication: binding.authentication, authority: 'present_user' },
            currentMachineId: machineId, currentAccountId: 'capture-owner', currentInstallationId: installationId,
            currentServerId: serverIdentityId, surface: 'ui', signal,
            externalActionMachineRequestPrivateKey: installation.secretKey, verifyExecutionAuthorization: async () => true,
            resolveTarget: createDaemonExternalActionTargetResolver({ credentials }), executor,
            prepareRequesterAccountContext: preparation => prepareRequesterAccountActionContext({
                authorization: preparation.authorization, purpose: { kind: 'external_action' }, machineId, installationId,
                installationPrivateKey: installation.secretKey, serverId: serverIdentityId, serverIdentityId,
                serverHttpBaseUrl: channel.serverUrl, ownCredentials: credentials,
                isCurrent: async () => true, isCustodyCurrent: async () => true, isRetainedCustodyCurrent: async () => true,
                createExecutor: () => executor }),
            invokeResource: async (resourceMethod, params, context) => handlers.get(resourceMethod)!(params, context),
            ...(onFrame ? { sendHostResourceWatchFrame: async response => { onFrame(openExecution(response)); } } : {}),
        });
        if (result.kind !== 'response') return result;
        return openExecution(result.response);
    }

    try {
        const watch = new AbortController();
        const baseline = Promise.withResolvers<unknown>();
        const change = Promise.withResolvers<unknown>();
        let frames = 0;
        const stream = run(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN, watch.signal, resource,
            frame => (++frames === 1 ? baseline : change).resolve(frame));
        try {
            const ended = stream.then(() => { throw new Error('Capture watch ended before delivering the selected frame'); });
            expect(await Promise.race([baseline.promise, ended]))
                .toMatchObject({ ok: true, result: { ok: true, subscriptionId: 'selected-capture' } });
            expect(frames).toBe(1);
            captureRevision++;
            producerInvalidate!();
            expect(await Promise.race([change.promise, ended]))
                .toMatchObject({ ok: true, result: { status: 'event', event: { kind: 'invalidated' } } });
            expect(frames).toBe(2);
        } finally {
            watch.abort();
            await stream;
        }
        expect(disposed).toBe(1);
        const ingress = new AbortController();
        expect(await run(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN, ingress.signal))
            .toMatchObject({ ok: true, result: { ok: true, subscriptionId: 'selected-capture' } });
        ingress.abort();
        expect(producerSignal?.aborted).toBe(false);
        const current = await run(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ, new AbortController().signal);
        expect(current).toMatchObject({ ok: true, result: { ok: true } });
        if (!current || !('ok' in current) || !current.ok) throw new Error('Missing selected Resource read');
        expect(current.result).toHaveProperty('bytesBase64');
        const bytes = (current.result as { bytesBase64: string }).bytesBase64;
        expect(JSON.parse(Buffer.from(bytes, 'base64').toString('utf8'))).toMatchObject({
            admission: kind === 'worktree' ? { accountId }
                : environmentIds.map(environmentId => ({ collectorMachineId: machineId, environment: { environmentId, revision: 7 } })),
            scope: { launchInput: view === 'services' ? input.input : { view, input: input.input } },
        });
        expect(opened).toBe(2);
        const foreignSource = kind === 'worktree' ? { ...source, workspaceId: 'neighbor' } : { ...source, environmentId: 'neighbor' };
        const foreignInput = view === 'services' ? { ...input.input, environmentIds: [...environmentIds, 'unmounted-environment'] }
            : view === 'metrics' ? { ...input.input, environmentId: 'neighbor' } : { ...input.input, source: foreignSource };
        expect(await run(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ, new AbortController().signal,
            { ...resource, input: { ...input, input: foreignInput } })).toMatchObject({ kind: 'invalid_request' });
        expect(await run(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE, new AbortController().signal))
            .toMatchObject({ ok: true, result: { ok: true, closed: true } });
        expect(producerSignal?.aborted).toBe(true);
        expect(disposed).toBe(2);
    } finally {
        await fixture.dispose();
        http.mockRestore();
        await channel.close();
    }
});
