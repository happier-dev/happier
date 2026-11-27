import { afterEach, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import axios from 'axios';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createActionExecutor, computeExternalActionRequestEnvelopeDigestV1, openExternalActionResponseV2,
    sealExternalActionRequestV2 } from '@happier-dev/protocol/actions';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { DATABASE_DESCRIBE_ACTION_ID_V1, DATABASE_PLUGIN_ID_V1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { deriveAccountMachineKeyFromRecoverySecret, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { projectDeploymentReadAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentReadAdmissionV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { PluginUiResourceSubscriptionEventV1 } from '@happier-dev/protocol/plugins/ui/subscriptions';
import type { RpcHandler } from '@/api/rpc/types';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { registerDaemonContributionRegistryProjectionHandler } from '@/rpc/handlers/daemonContributionRegistryProjection';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createDaemonExternalActionTargetResolver } from './daemonExternalActionTargetResolver';
import { executeExternalAction } from './executeExternalAction';
import { prepareRequesterAccountActionContext } from '../sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';

const credentials = vi.hoisted(() => ({ token: `e30.${Buffer.from(JSON.stringify({ sub: 'resource-owner' })).toString('base64url')}.signature`,
    encryption: null as null | { type: 'legacy'; secret: Uint8Array } }));
// Stored credentials are an OS boundary. Admission, crypto, registry and Resource lifecycle stay real.
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(), readStoredCredentials: async () => credentials }));
afterEach(() => resetActiveAccountSettingsSnapshotForTests());

it.each(['plain', 'e2ee'] as const)('captures and closes one database producer through signed %s Resource ingress', async mode => {
    const secret = new Uint8Array(32).fill(18);
    credentials.encryption = mode === 'plain' ? null : { type: 'legacy', secret };
    const channel = await createRequesterCurrentnessSocketHarness();
    // Home HTTP and its push socket are genuine transport boundaries. The
    // requester admission, settings crypto and private custody owner stay real.
    const http = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
        if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'resource-owner' } };
        if (url.includes('/v2/changes?')) return { status: 200, data: { changes: [], nextCursor: 0 } };
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
            mode, version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (url.endsWith('/v2/account/settings')) return { status: 200, data: { version: 1,
            content: mode === 'plain' ? { t: 'plain', v: {} } : { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
                kind: 'account_settings', material: { type: 'legacy', secret }, payload: {}, randomBytes: tweetnacl.randomBytes }) } } };
        throw new Error(`Unexpected requester HTTP read: ${url}`);
    });
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token) });
    let acquisitions = 0;
    let disposals = 0;
    let producerSignal: AbortSignal | undefined;
    let invalidate: (() => void) | undefined;
    let revision = 0;
    const database = definePlugin({ id: DATABASE_PLUGIN_ID_V1, version: '0.0.0', entrypoints: { daemon: './daemon.mjs' }, resources: {
        connection: { source: 'dynamic', kind: 'config', contentType: 'application/json', scope: 'surface', execution: { target: 'daemon' },
            runtime: { read() { throw new Error('A captured producer is required'); }, observe() { throw new Error('A captured producer is required'); },
                createProducer(context) {
                    if (context.requesterAccount?.accountId !== 'resource-owner' || !context.secrets) throw new Error('Requester custody is required');
                    acquisitions++; producerSignal = context.signal;
                    return {
                        read: () => JSON.stringify({ revision,
                            selected: context.context.kind === 'surface' ? context.context.launchInput : null }),
                        invoke: value => value,
                        observe(callback) { invalidate = callback; return { dispose() { invalidate = undefined; } }; },
                        dispose() { disposals++; },
                    };
                } },
        },
    } });
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: database.manifest,
        files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: database.activate }) }],
        async resolveContributes(happyHomeDir) { return createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })); },
        runtimeOptions: { resolveCurrentMachineId: () => 'resource-machine',
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_resource', machineId: 'resource-machine' }) } });
    const handlers = new Map<string, RpcHandler>();
    registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
        resolveRuntimeRegistry: async () => fixture.registry, resolveInstalledPackages: async () => [],
        readHostResourceAccountId: () => 'resource-owner',
        resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: 'srv_resource', machineId: 'resource-machine' }),
    });
    const action = parseQualifiedPluginActionId(DATABASE_DESCRIBE_ACTION_ID_V1)!;
    const describeInput = { operation: 'describe', target: { kind: 'managed_deployment',
        environment: { serverId: 'srv_resource', projectSourceId: 'source', environmentId: 'environment' },
        targetLinkId: 'selected-link', contribution: { pluginId: 'happier.neon', contributionId: 'database' },
        platformProjectId: 'project', branchId: 'branch', database: 'selected' } };
    const input = { action, input: describeInput };
    const occurrenceId = fixture.registry.readPluginOccurrenceId?.(DATABASE_PLUGIN_ID_V1);
    if (!occurrenceId) throw new Error('The admitted database occurrence is required');
    const resource = { hostRead: 'database.connection' as const, input, binding: {
        expectedCallerOccurrenceId: occurrenceId, callerPluginId: DATABASE_PLUGIN_ID_V1,
        resource: { pluginId: DATABASE_PLUGIN_ID_V1, localId: 'connection' },
        context: { kind: 'surface' as const, mountInstanceKey: 'selected-surface', launchInput: describeInput },
    } };
    const target = { kind: 'machine' as const, machineId: 'resource-machine' };
    const material = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) };
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
    const executor = createActionExecutor(createUnavailableActionTransportDeps());
    const run = async (method: typeof RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN | typeof RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ | typeof RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE,
        selected = resource, stream?: { signal: AbortSignal; receive(value: unknown): void }) => {
        const binding = { serverIdentityId: 'srv_resource', accountId: 'resource-owner', authentication: { kind: 'account' as const, tokenEpoch: 0 },
            actionId: 'action.invoke' as const, requestId: `${mode}-${method}`, target };
        const resourceContinuation = method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ
            ? { method, params: { machineId: target.machineId, resource: selected } }
            : { method, params: { machineId: target.machineId, resource: selected, subscriptionId: 'held-database' } };
        const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
            binding, input, material, randomBytes: tweetnacl.randomBytes, resourceContinuation })
            : { v: 1 as const, requestId: binding.requestId, target, input, resourceContinuation };
        const admitted = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-home-proof', binding: {
            ...binding, custodianAccountId: 'resource-owner', machineId: target.machineId, installationId: 'installation',
            admittedMachineRole: 'manage', accountEncryptionMode: mode, deploymentReadAdmission: projectDeploymentReadAdmissionV1(binding.actionId, input),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } });
        const result = await executeExternalAction({ actionId: binding.actionId, envelope,
            principal: { accountId: binding.accountId, authentication: binding.authentication, authority: 'present_user' },
            executionAuthorization: admitted, currentMachineId: target.machineId, currentAccountId: binding.accountId,
            currentInstallationId: 'installation', currentServerId: 'srv_resource', surface: 'ui', signal: stream?.signal ?? new AbortController().signal,
            externalActionMachineRequestPrivateKey: installation.secretKey, verifyExecutionAuthorization: async () => true,
            resolveTarget: createDaemonExternalActionTargetResolver({ credentials }), executor,
            prepareRequesterAccountContext: preparation => prepareRequesterAccountActionContext({
                authorization: preparation.authorization, purpose: { kind: 'external_action' },
                machineId: target.machineId, installationId: 'installation', installationPrivateKey: installation.secretKey,
                serverId: 'srv_resource', serverIdentityId: 'srv_resource', serverHttpBaseUrl: channel.serverUrl,
                ownCredentials: credentials, isCurrent: async () => true, isCustodyCurrent: async () => true,
                isRetainedCustodyCurrent: async () => true,
                createExecutor: () => executor }),
            invokeResource: async (resourceMethod, params, context) => handlers.get(resourceMethod)!(params, context),
            ...(stream ? { sendHostResourceWatchFrame: async frame => {
                const response = frame as Parameters<typeof openExternalActionResponseV2>[0]['envelope'] | {
                    v: 1; execution: { ok: true; result: unknown };
                };
                const execution = response.v === 2
                    ? openExternalActionResponseV2({ envelope: response, binding, material, request: envelope })
                    : response.execution;
                if (!execution?.ok) throw new Error('Could not open Resource frame');
                stream.receive(execution.result);
            } } : {}),
        });
        if (result.kind !== 'response') return result;
        return envelope.v === 2 ? openExternalActionResponseV2({ envelope: result.response, binding, material, request: envelope })
            : result.response.v === 1 ? result.response.execution : null;
    };
    try {
        const opened = await run(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN);
        expect(opened).toEqual(expect.objectContaining({ ok: true,
            result: expect.objectContaining({ ok: true, subscriptionId: 'held-database' }) }));
        expect(acquisitions).toBe(1);
        expect(await run(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ)).toMatchObject({ ok: true, result: { ok: true } });
        expect(acquisitions).toBe(1);
        expect(await run(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ, { ...resource, binding: { ...resource.binding,
            context: { ...resource.binding.context, launchInput: { ...describeInput, target: { ...describeInput.target, targetLinkId: 'neighbor' } } } } }))
            .toMatchObject({ kind: 'invalid_request' });
        expect(await run(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_CLOSE)).toMatchObject({ ok: true, result: { ok: true, closed: true } });
        await Promise.resolve();
        expect(producerSignal?.aborted).toBe(true);
        expect(disposals).toBe(1);

        const signal = new AbortController();
        const frames: unknown[] = [];
        const openedFrame = Promise.withResolvers<void>();
        const invalidatedFrame = Promise.withResolvers<void>();
        const following = run(RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN, resource, {
            signal: signal.signal,
            receive(value) {
                frames.push(value);
                if (frames.length === 1) openedFrame.resolve();
                if (frames.length === 2) invalidatedFrame.resolve();
            },
        });
        try {
            await Promise.race([openedFrame.promise, following.then(result => {
                throw new Error(`Resource stream settled before it opened: ${JSON.stringify(result)}`);
            })]);
            expect(acquisitions).toBe(2);
            expect(frames).toEqual([expect.objectContaining({ ok: true, subscriptionId: 'held-database' })]);
            const watches = fixture.registry.uiResourceWatches!;
            const invoke = () => watches.invokeDemand({ callerPluginId: DATABASE_PLUGIN_ID_V1,
                resourceId: 'connection', requesterAccountId: 'resource-owner', subscriptionId: 'held-database',
                occurrenceId, input: 'selected-operation' });
            expect(await invoke()).toBe('selected-operation');
            revision++;
            if (!invalidate) throw new Error('The stream must hold one producer observer');
            invalidate();
            await Promise.race([invalidatedFrame.promise, following.then(result => {
                throw new Error(`Resource stream settled before invalidation: ${JSON.stringify(result)}`);
            })]);
            expect(frames[1]).toMatchObject({ ok: true, status: 'event',
                event: { kind: 'invalidated', digest: expect.any(String) } });
            await watches.retireHostAccount('resource-owner');
            expect(await following).toMatchObject({ ok: true });
            expect(frames[2]).toMatchObject({ ok: true, status: 'event',
                event: { kind: 'error', code: 'expired_resource' } satisfies Partial<PluginUiResourceSubscriptionEventV1> });
            expect(producerSignal?.aborted).toBe(true);
            expect(disposals).toBe(2);
            await expect(invoke()).rejects.toMatchObject({ code: 'plugin_resource_demand_unavailable' });
        } finally { signal.abort(); await following; }
    } finally { await fixture.dispose(); http.mockRestore(); await channel.close(); }
});
