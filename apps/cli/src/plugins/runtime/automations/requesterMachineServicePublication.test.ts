import { afterAll, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import fastify from 'fastify';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { ExternalActionExecutionAuthorizationV1Schema, bindExternalActionExecutionAuthorizationVerifyHttpPathV1, ExternalActionExecutionAuthorizationVerifyResponseV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import { AutomationEventActionHttpPathsV1, AutomationEventActionHttpRequestSchemasV1,
    AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1, AutomationEventStoredDefinitionsReadResultV1Schema,
} from '@happier-dev/protocol/automations/automationEventV1';
import { AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol';
import { machineOutcomeEvents, machineOutcomeEventActions } from '@happier-dev/plugins-machine-services/native-events';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { updateSettings } from '@/persistence';
import { configuration } from '@/configuration';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { decodeBase64 } from '@/api/encryption';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { createInstalledProjectFiniteRuntime } from '@/daemon/startup/createInstalledProjectFiniteRuntime';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createProjectNativeIo } from '@/workspaces/projectSetup/projectNativeIo';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';
import { prepareProjectCheckoutRemoval } from '@/workspaces/projectSetup/projectCheckoutRemoval';
import { SCM_WORKTREE_REMOVE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/scmActionIdsV1';
import { MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1 } from '@happier-dev/protocol/plugins/events/machineServiceObservationV1';
import { getHostWorktreePortsOwner, resolvePhysicalWorktreeRootIdentity } from '@/workspaces/execution/worktreePorts';
import { ApiMachineClient } from '@/api/apiMachine';
import { createApiMachineSocketFixture } from '@/testkit/apiMachineTransport';
import type { publishRequesterMachineServiceObservation as PublishRequesterMachineServiceObservation } from './requesterMachineServicePublication';

// Keep the receiver's optional native publisher cold: its first demand import
// must not borrow custody from a caller that has already returned and disposed.
async function publishRequesterMachineServiceObservation(input: Parameters<typeof PublishRequesterMachineServiceObservation>[0]) {
    return await (await import('./requesterMachineServicePublication')).publishRequesterMachineServiceObservation(input);
}

const isolated = vi.hoisted(() => {
    const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const { join } = require('node:path') as typeof import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'requester-native-publication-'));
    const previousHome = process.env.HAPPIER_HOME_DIR;
    const previousServer = process.env.HAPPIER_SERVER_URL;
    const previousServerId = process.env.HAPPIER_ACTIVE_SERVER_ID;
    process.env.HAPPIER_HOME_DIR = home;
    process.env.HAPPIER_SERVER_URL = 'http://requester-native-publication.test';
    process.env.HAPPIER_ACTIVE_SERVER_ID = 'home';
    return { home, previousHome, previousServer, previousServerId,
        machineSocket: null as ReturnType<typeof createApiMachineSocketFixture> | null };
});
vi.mock('socket.io-client', async importOriginal => {
    const actual = await importOriginal<typeof import('socket.io-client')>();
    return { ...actual, io: (...args: Parameters<typeof actual.io>) => {
        const auth = args[1]?.auth;
        if (auth && typeof auth === 'object' && Reflect.get(auth, 'clientType') === 'machine-scoped'
            && isolated.machineSocket) return isolated.machineSocket;
        return actual.io(...args);
    } };
});
afterAll(async () => {
    await pluginReloadController.shutdown();
    await rm(isolated.home, { recursive: true, force: true });
    if (isolated.previousHome === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = isolated.previousHome;
    if (isolated.previousServer === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = isolated.previousServer;
    if (isolated.previousServerId === undefined) delete process.env.HAPPIER_ACTIVE_SERVER_ID;
    else process.env.HAPPIER_ACTIVE_SERVER_ID = isolated.previousServerId;
});

it.each(['backup', 'backup receiver', 'Project setup', 'Project removal', 'Project removal through action.invoke'] as const)('publishes %s through the installed inactive writer for the admitted requester', async kind => {
    const backup = kind === 'backup' || kind === 'backup receiver';
    const projectRemoval = kind === 'Project removal' || kind === 'Project removal through action.invoke';
    const eventId = backup ? 'backup-succeeded' : projectRemoval ? 'worktree-removed' : 'project-setup-finished';
    const rootActionId = backup ? 'deployments.backups.run' : projectRemoval
        ? SCM_WORKTREE_REMOVE_ACTION_ID_V1 : 'projects.prepare';
    const authorizationActionId = kind === 'Project removal through action.invoke' ? 'action.invoke' : rootActionId;
    const event = machineOutcomeEvents[eventId];
    if (!event) throw new Error('Missing canonical backup Event');
    const setup = event.declaration.automation.source.setupActionRef;
    const setupAction = machineOutcomeEventActions[setup.localId];
    if (!setupAction) throw new Error('Missing canonical setup Action');
    const plugin = definePlugin({ id: setup.pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
        activation: { events: [], configuration: { automationEventSources: true } },
        events: { [eventId]: event }, actions: { [setup.localId]: setupAction } });
    const socket = await createRequesterCurrentnessSocketHarness();
    const app = fastify();
    const origin = 'http://requester-native-publication.test';
    const requesterCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'requester' })).toString('base64url')}.fixture`,
        encryption: null };
    app.post(bindExternalActionExecutionAuthorizationVerifyHttpPathV1(authorizationActionId), async () =>
        ExternalActionExecutionAuthorizationVerifyResponseV1Schema.parse({ ok: true }));
    app.get('/v1/account/profile', async request => ({ id:
        request.headers.authorization === `Bearer ${requesterCredentials.token}` ? 'requester' : 'custodian' }));
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
    app.get('/v2/changes', async () => ({ changes: [], nextCursor: 0 }));
    app.get(AUTOMATION_ACTION_INDEX_HTTP_PATH_V1, async request => {
        expect(request.headers.authorization).toBe(`Bearer ${requesterCredentials.token}`);
        return { v: 1, rows: [] };
    });
    const published: unknown[] = [];
    app.post(AutomationEventActionHttpPathsV1['automation.event.admit'], async request => {
        expect(request.headers.authorization).toBe('Bearer custodian');
        const body = AutomationEventActionHttpRequestSchemasV1['automation.event.admit'].parse(request.body);
        published.push(body);
        return { results: [] };
    });
    const selector = { automationId: 'requester-automation', triggerId: 'backup-trigger', triggerRevision: 1,
        sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631' };
    const eventRef = { pluginId: setup.pluginId, localId: eventId };
    app.post(AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1, async request => {
        expect(request.headers.authorization).toBe('Bearer custodian');
        return AutomationEventStoredDefinitionsReadResultV1Schema.parse({ kind: 'page', revision: '1', nextCursor: null,
            eventDeclarationRelease: { release: { pluginId: setup.pluginId, version: plugin.manifest.version },
                archiveDigestSha256: `sha256:${'a'.repeat(64)}` }, definitions: [{ ...selector, eventRef,
            sourceContractVersion: 1, observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef:
                fixture?.registry.resolveCurrentPluginMaterializationRef(setup.pluginId) },
            payloadSchema: event.declaration.payloadSchema,
            storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
                binding: { v: 1, ...selector, triggerKind: 'pluginEvent', eventRef }, definition: {
                    v: 1, sourceInstanceId: 'requester-backup-source', sourceConfig: { v: 1, serverId: 'home',
                        machineId: 'machine', environmentId: 'environment' }, displayLabel: 'Requester backup',
                    filter: null, maximumObservationAgeMs: null,
                } }),
        }] });
    });
    const restoreHttp = installAxiosFastifyAdapter({ app, origin });
    let fixture: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>> | undefined;
    let requester: Awaited<ReturnType<typeof admitRequesterAccountActionContext>> = null;
    try {
        await updateSettings(settings => ({ ...settings, activeServerId: configuration.activeServerId,
            machineIdByServerId: { [configuration.activeServerId]: 'machine' } }));
        fixture = await createAuthoredAdmittedPluginRuntimeFixture({ happyHomeDir: isolated.home,
            controller: pluginReloadController, coldStart: true,
            plugins: [{ manifest: plugin.manifest, replaceExisting: true, files: { 'daemon.mjs':
                `export function activate(api) { api.actions.register(${JSON.stringify(setup.localId)}, async () => {
                    throw new Error('Publication must not execute source setup');
                }); }` } }],
            resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
            })),
            runtimeOptions: { resolveCurrentMachineId: () => 'machine', scopedActionRuntime: {
                credentials: { token: 'custodian', encryption: null }, actionsSettingsProvider: createActionSettingsProvider(),
            } },
        });
        expect(fixture.registry.resolveCurrentPluginMaterializationRef(setup.pluginId)).toBeNull();
        const installation = await readOrCreateInstallationIdentity();
        const installationId = kind === 'backup' ? 'installation' : installation.installationId;
        const input = { serverId: 'home', environmentId: 'environment', machineId: 'machine', installationId,
            targetLinkId: 'target', deploymentId: 'deployment', expectedRevision: 1, configRevision: 1 };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-root', binding: {
            accountId: 'requester', custodianAccountId: 'custodian', accountEncryptionMode: 'plain',
            authentication: { kind: 'account', tokenEpoch: 0 },
            serverIdentityId: 'home', machineId: 'machine', installationId,
            actionId: authorizationActionId, requestId: 'original-request', ...(backup ? { environmentId: input.environmentId,
                deploymentNativeAdmission: projectDeploymentNativeAdmissionV1('deployments.backups.run', input) } : {}),
            requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
        } });
        requester = await admitRequesterAccountActionContext({ authorization, credentials: requesterCredentials,
            serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: origin, isCurrent: async () => true });
        if (!requester) throw new Error('Requester admission failed');
        if (kind === 'backup receiver') {
            isolated.machineSocket = createApiMachineSocketFixture();
            const client = new ApiMachineClient('custodian', { id: 'machine', encryptionMode: 'plain', metadata: null,
                metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
            try {
                expect(await client.runActionOperation({ actionId: rootActionId, input,
                    context: { surface: 'cli', serverId: 'home', actionRequestId: 'original-request',
                        externalActionExecutionAuthorization: requester.authorization,
                        machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'custodian', machineId: 'machine',
                            installationId, role: 'use', encryptionMode: 'plain' } },
                    execute: async operation => ({ ok: true, result: { kind: 'verified',
                        operationId: operation.operationAcceptance!.operationId, manifests: [] } }),
                })).toMatchObject({ ok: true });
                await requester.dispose();
                requester = null;
                await vi.waitFor(() => expect(published).toHaveLength(1));
            } finally { await client.shutdown(); isolated.machineSocket = null; }
        } else if (kind === 'backup') await publishRequesterMachineServiceObservation({ publisherCredentials: { token: 'custodian' },
            authorization: requester.authorization, observation: { kind: 'backup', serverId: 'home', machineId: 'machine',
                environmentId: 'environment', operationId: 'native-backup', state: 'succeeded', errorCode: null, occurredAt: Date.now() } });
        else {
            const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: requester.authorization,
                serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: origin, target: authorization.binding.target,
                installationId, privateKey: decodeBase64(installation.privateKey, 'base64url'), isCurrent: requester.isCurrent });
            if (!carrier?.requesterHttpProjection) throw new Error('Requester HTTP admission failed');
            const ingress = { signal: new AbortController().signal, callerInputAuthorization: carrier,
                machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'custodian', machineId: 'machine',
                    installationId, role: 'use' as const, encryptionMode: 'plain' as const }, verifyMachineAdmissionCurrent: async () => true };
            let nextId = 0;
            const operationRuntime = createHostActionOperationRuntime({ machineId: 'machine', serverId: 'home',
                custodyBinding: { serverId: 'home', installationId }, resolveAccountId: async () => 'custodian',
                generateOperationId: () => `project-operation-${++nextId}` });
            const terminalSessions = createTerminalPtySessionManager({
                ptyProvider: { spawn: () => { throw new Error('No process expected'); } },
                config: readDaemonTerminalPtyConfig({}).sessionManager, env: {}, platform: 'linux' });
            try {
                const factory = createInstalledProjectFiniteRuntime({ api: { getMachine: async () => null },
                    credentials: { token: 'custodian', encryption: null }, externalActionAccountId: 'custodian',
                    finiteServerId: 'home', finiteServerHttpBaseUrl: origin, registeredMachineId: 'machine',
                    admission: createProjectWorkerAdmission({ machineId: 'machine', admissionDrain: createDaemonAdmissionDrain(),
                        readPolicy: async () => ({ status: 'ready', policy: { accepting: true, runAtMost: null }, source: 'default', metadataVersion: 1 }) }),
                    nativeIo: createProjectNativeIo(), successHomeDir: isolated.home, isCurrent: async () => true,
                    prepareBetween: async () => { throw new Error('No worker preparation expected'); },
                    resolveCurrentMachineExecutionOriginContext: async () => null });
                const runtime = await factory({ operationRuntime, terminalSessions }, ingress);
                if (!runtime) throw new Error('Requester Project runtime refused');
                const workspace = { id: 'workspace', serverId: 'home', machineId: 'machine', rootPath: '/project',
                    label: null, createdAtMs: 1, lastOpenedAtMs: null };
                if (projectRemoval) {
                    const worktreePath = join(isolated.home, 'requester-removal');
                    const siblingPath = join(isolated.home, 'requester-retained-sibling');
                    await Promise.all([mkdir(worktreePath), mkdir(siblingPath)]);
                    const ports = getHostWorktreePortsOwner();
                    const capturedRoot = await resolvePhysicalWorktreeRootIdentity(worktreePath);
                    const siblingRoot = await resolvePhysicalWorktreeRootIdentity(siblingPath);
                    expect(await ports.assign({ rootPath: worktreePath, slots: 1 })).toMatchObject({ kind: 'ready' });
                    expect(await ports.assign({ rootPath: siblingPath, slots: 1 })).toMatchObject({ kind: 'ready' });
                    const portsStatePath = join(configuration.happyHomeDir, 'worktree-ports.json');
                    const before = JSON.parse(await readFile(portsStatePath, 'utf8'));
                    const custodianFacts: unknown[] = [];
                    const subscription = fixture.registry.stableEventsBroker!.subscribeHost({
                        target: { eventId: MACHINE_SERVICE_OBSERVED_HOST_EVENT_V1, scope: { kind: 'account' } },
                        isCurrent: () => true, listener(event) { custodianFacts.push(event.payload); },
                    });
                    const result = await operationRuntime.observeExecution({ actionId: rootActionId, input: {}, rpcContext: ingress,
                        actionRequestId: 'original-request', execute: async operation => {
                            const removal = await prepareProjectCheckoutRemoval({ runtime, ingress, context: {}, operation,
                                worktreePath, association: { workspace, project: { serverId: 'home', projectId: 'project' } },
                                skipCleanup: true });
                            await rm(worktreePath, { recursive: true });
                            removal.settle('deleted');
                            return { ok: true, result: null };
                        } });
                    expect(result).toMatchObject({ ok: true });
                    await vi.waitFor(() => expect(published).toHaveLength(1));
                    expect(custodianFacts).toEqual([]);
                    await vi.waitFor(async () => {
                        const after = JSON.parse(await readFile(portsStatePath, 'utf8'));
                        expect(after.assignments[capturedRoot]).toBeUndefined();
                        expect(after.assignments[siblingRoot]).toEqual(before.assignments[siblingRoot]);
                    });
                    await subscription.dispose();
                } else {
                expect(runtime.publishSetupSettlement).toBeTypeOf('function');
                const settle = (operationId: string) => runtime.publishSetupSettlement!({ workspace,
                    project: { serverId: 'home', projectId: 'project' }, operationId, outcome: 'finished' });
                await operationRuntime.observeExecution({ actionId: 'projects.prepare', input: {}, rpcContext: ingress,
                    actionRequestId: 'other-request', execute: async () => ({ ok: true, result: null }) });
                const result = await operationRuntime.observeExecution({ actionId: 'projects.prepare', input: {}, rpcContext: ingress,
                    actionRequestId: 'original-request', execute: async operation => {
                        await settle('project-operation-1');
                        expect(published).toHaveLength(0);
                        await settle(operation.operationAcceptance!.operationId);
                        await vi.waitFor(() => expect(published).toHaveLength(1));
                        return { ok: true, result: null };
                    } });
                expect(result).toMatchObject({ ok: true });
                expect(published).toMatchObject([{ input: { payload: { operationId: 'project-operation-2' } } }]);
                }
            } finally { terminalSessions.dispose(); }
        }
        expect(published).toMatchObject([{ caller: { materialization: { pluginId: setup.pluginId, machineId: 'machine' },
            requesterOperation: { authorizationToken: 'original-root', requestId: 'original-request' } },
            input: { eventRef, sourceInstanceId: 'requester-backup-source', definitions: [selector] } }]);
    } finally {
        await requester?.dispose();
        await fixture?.dispose();
        restoreHttp(); await socket.close(); await app.close();
    }
});
