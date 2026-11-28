import axios from 'axios';
import { randomBytes } from 'node:crypto';
import { decodeBase64 } from '@/api/encryption';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { FeaturesResponseSchema, sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/socketRpc';
import { admitRequesterAccountActionContext, prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { materializeMcpServerConfigRecord, listSelectedMcpSharedSecretReferences } from '@/mcp/servers/materializeMcpServerConfigRecord';
import { readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { resolveSessionCapabilitiesForDirectory } from '@/mcp/servers/resolveSessionCapabilitiesForDirectory';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, type AccountSettingsSnapshotResolver } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createExecutionRunAccountSettingsSnapshotResolver } from './resolveExecutionRunAccountSettingsSnapshot';
import { ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import { createProjectSessionRuntimeFixture } from '@/daemon/testkit/projectSessionRuntimeFixture';
import { ExecutionRunHostBridge } from '@/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';
import { createTestExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/testkit';
import { resolveCliEngineRegistry } from '@/agent/runtime/registry/engineRegistry';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createInstalledProjectAgentLaunchFixture } from '@/daemon/testkit/installedProjectAgentLaunchFixture';
import { createRunnerAgentProjectLaunchInvocation } from '@/daemon/agentRuntime/runnerAgentProjectLaunch';
import type { ExecutionRunProjectLaunchContext } from '@/agent/runtime/registry/engineRegistryTypes';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { authorizePluginExecLaunchForHost, createStablePluginExecService, issueAgentNativeLaunchQualifierForHost } from '@/plugins/runtime/invocation/services/exec';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

// Load the publication policy before replacing its filesystem boundary.
const { createBundledPluginPublicationFsFixture } = await vi.hoisted(async () =>
    import('@/plugins/projection/registry/builtIn/locators.testkit'));
vi.mock('node:fs', async original =>
    createBundledPluginPublicationFsFixture(await original<typeof import('node:fs')>()));

import { prepareExecutionRunRuntimeProviderLaunch } from '@/agent/runtime/bridges/executionRun/runtime/providerPreparation';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetInMemoryAccountSettingsContextForTests(); });

const credentials: StoredCredentials = {
    token: `e30.${Buffer.from(JSON.stringify({ sub: 'run-mcp-owner' })).toString('base64url')}.signature`, encryption: null,
};

function captureHomeReads(onCatalogRead?: () => void, sharedSecret = false) {
    // Home HTTP and the caller-supplied credential-file reader are the genuine
    // boundaries. Bootstrap, invocation custody and catalog admission stay real.
    return vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
        const target = new URL(String(url));
        expect(target.origin).toBe('https://run-owner.test');
        expect(options?.headers?.Authorization).toBe(`Bearer ${credentials.token}`);
        if (target.pathname === '/v2/account/settings') return { status: 200, data: {
            version: 7, content: { t: 'plain', v: { preferredLanguage: 'fr' } },
        } };
        if (target.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
            mode: 'plain', version: 1, settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } };
        if (target.pathname === '/v1/account/entity-rows/mcp') {
            onCatalogRead?.();
            return { status: 200, data: { status: 'present', revision: 2, content: { t: 'plain', v: { v: 1,
                servers: [{ id: 'wilson-brief', name: 'wilson-brief', transport: 'stdio', stdio: { command: 'brief-server', args: [] },
                    env: sharedSecret ? { WILSON_TOKEN: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:wilson-token' } } : {},
                    createdAt: 1, updatedAt: 1 }, ...(sharedSecret ? [{
                        id: 'unselected', name: 'unselected', transport: 'stdio', stdio: { command: 'other-server', args: [] },
                        env: { OTHER_TOKEN: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:unavailable-unselected' } },
                        createdAt: 1, updatedAt: 1,
                    }] : [])], bindings: [{ id: 'all', serverId: 'wilson-brief', enabled: true,
                        target: { t: 'allMachines' }, createdAt: 1, updatedAt: 1 }],
            } } } };
        }
        if (target.pathname === '/v1/account/saved-secrets/resources/materials') return { status: 200, data: { resources: [{
            resourceId: 'wilson-token', encryptionMode: 'plain', recipientEnvelope: null,
            storedContent: sealSavedSecretResourceStoredContentV1({ resourceId: 'wilson-token', mode: 'plain',
                content: { v: 1, name: 'Wilson token', kind: 'token', value: 'synthetic-home-token' } }),
            entry: { ref: 'happier:shared-secret:v1:wilson-token', source: 'shared_resource', relationship: 'owner',
                ownerAccountId: 'run-mcp-owner', name: 'Wilson token', kind: 'token', revision: 1, materialStatus: 'ready',
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
        }] } };
        return { status: 404, data: {} };
    });
}

describe('Machine Execution Run owner account snapshot', () => {
    it('keeps newer captured Settings without extra Home reads when reusable active Settings are older', async () => {
        const home = captureHomeReads();
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'run-machine',
            serverHttpBaseUrl: 'https://run-owner.test', readCredentials: async () => credentials,
            isOwnerCurrent: () => true, onSettings() {} });
        try {
            const initial = await resolver();
            expect(initial.settingsVersion).toBe(7);
            setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({ preferredLanguage: 'de' }),
                settingsVersion: 5, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
                scopeKey: resolveAccountSettingsScopeKey(credentials) });
            const incumbent = getActiveAccountSettingsSnapshot();
            if (!incumbent) throw new Error('Expected the older active Settings snapshot');
            home.mockClear();
            for (let attempt = 0; attempt < 3; attempt++) {
                const refreshed = await resolver();
                expect(refreshed.settingsVersion).toBe(7);
                expect(refreshed.settings.preferredLanguage).toBe('fr');
            }
            expect(home).not.toHaveBeenCalled();
            expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
            home.mockRejectedValue(new Error('Home unavailable'));
            expect(await resolver()).toBe(initial);
            setActiveAccountSettingsSnapshot({ ...incumbent, settingsVersion: 8,
                settings: accountSettingsParse({ preferredLanguage: 'it' }) });
            expect(await resolver()).toMatchObject({ settingsVersion: 8, settings: { preferredLanguage: 'it' } });
            expect(home).not.toHaveBeenCalled();
        } finally { await resolver.dispose(); }
    });
    it('keeps an admitted Workflow requester snapshot separate from the Machine custodian and refuses retired custody', async () => {
        const f = await createProjectSessionRuntimeFixture({ serverId: 'session-home', serverUrl: 'https://session-home.test',
            machineAccess: { custodianAccountId: 'custodian', role: 'manage' }, accountSettings: { preferredLanguage: 'fr' } });
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({ preferredLanguage: 'de' }),
            settingsVersion: 99, loadedAtMs: 1, settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey({ token: 'custodian', encryption: null }) });
        const incumbent = getActiveAccountSettingsSnapshot();
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'machine',
            serverHttpBaseUrl: 'https://session-home.test', readCredentials: async () => null,
            isOwnerCurrent: () => true, onSettings() {} });
        try {
            const read = resolver.forInvocation({ signal: f.signal, requesterSessionBootstrap: f.bootstrap });
            const snapshot = await read();
            expect(snapshot?.settings.preferredLanguage).toBe('fr');
            expect(snapshot?.scopeKey).toBe(resolveAccountSettingsScopeKey(f.bootstrap.credentials));
            expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
            f.retire();
            expect((await read())?.settings.preferredLanguage).toBe('fr');
            await f.bootstrap.dispose();
            await expect(read()).rejects.toMatchObject({ code: 'provider_authorization_changed',
                failureCause: { phase: 'account_snapshot.requester_not_current' } });
            expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
        } finally { await resolver.dispose(); }
    });
    it('reads an admitted detached Machine Action Run’s requester settings and refuses after ingress retires', async () => {
        const f = await createProjectSessionRuntimeFixture({ serverId: 'session-home', serverUrl: 'https://session-home.test',
            homeServerIdentityId: 'srv_session_home', accountSettings: { preferredLanguage: 'fr' },
            machineAccess: { custodianAccountId: 'custodian', role: 'use' } });
        const ingressLifetime = new AbortController();
        const machineAdmission = SocketRpcMachineAdmissionContextV1Schema.parse({ actorAccountId: 'requester',
            custodianAccountId: 'custodian', machineId: 'machine', installationId: f.installation.installationId,
            role: 'use', encryptionMode: 'plain' });
        const requester = await admitRequesterAccountActionContext({
            authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'detached-run-root', binding: {
                accountId: machineAdmission.actorAccountId, custodianAccountId: machineAdmission.custodianAccountId,
                authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
                serverIdentityId: 'srv_session_home', machineId: machineAdmission.machineId,
                installationId: machineAdmission.installationId, actionId: 'execution.run.start', admittedMachineRole: 'use',
                requestId: 'detached-run', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
            } }),
            credentials: f.bootstrap.credentials, serverId: 'session-home', serverIdentityId: 'srv_session_home',
            serverHttpBaseUrl: 'https://session-home.test', isCurrent: async () => f.isHomeCurrent(),
            isRetainedCustodyCurrent: async () => f.isHomeCurrent(), signal: ingressLifetime.signal,
        });
        if (!requester) throw new Error('Account requester admission failed');
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'machine',
            serverHttpBaseUrl: 'https://session-home.test', readCredentials: async () => null,
            isOwnerCurrent: () => true, readHostAgentExecutionContext: async () => null, onSettings() {} });
        const release = requester.retain();
        const custody = requester.retainCustody?.();
        try {
            const read = resolver.forInvocation({ signal: ingressLifetime.signal, callerInputAuthorization: requester.authorization, machineAdmission });
            await expect(read()).resolves.toMatchObject({ settings: { preferredLanguage: 'fr' },
                scopeKey: resolveAccountSettingsScopeKey(f.bootstrap.credentials) });
            await expect(read({ mcpServerCatalog: true })).rejects.toMatchObject({ code: 'agent_isolation_unavailable',
                details: { reason: 'requester_authority_unavailable' } });
            // Raw admission is only a negative fixture for detached capture.
            await expect(read.captureForDetachedRun?.()).rejects.toMatchObject({ code: 'provider_authorization_changed',
                failureCause: { phase: 'account_snapshot.requester_not_current' } });
            const prepare = () => prepareExecutionRunRuntimeProviderLaunch({ scope: 'detached',
                runId: 'detached-run', agentId: 'codex', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                selection: { modelId: 'fixture-native-model', agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null },
                connectedServices: { v: 2, bindingsByServiceId: {} }, happyHomeDir: f.directory,
                resolveAccountSettingsSnapshot: read });
            await expect(prepare()).resolves.toMatchObject({ environment: {} });
            await requester.dispose();
            await expect(prepare()).resolves.toMatchObject({ environment: {} });
            ingressLifetime.abort();
            await expect(custody?.isCurrent()).resolves.toBe(true);
            await expect(prepare()).rejects.toMatchObject({ code: 'provider_authorization_changed',
                failureCause: { phase: 'account_snapshot.requester_not_current' } });
        } finally {
            await custody?.release();
            await release();
            await resolver.dispose();
            await requester.dispose();
        }
    });
    it('prepares a detached Machine Action Run with the admitted settings after the Action settles', async () => {
        let settingsReads = 0;
        const f = await createProjectSessionRuntimeFixture({ serverId: 'session-home', serverUrl: 'https://session-home.test',
            homeServerIdentityId: 'srv_session_home', accountSettings: { preferredLanguage: 'fr' },
            machineAccess: { custodianAccountId: 'custodian', role: 'use' },
            readAdditionalHttpResponse: async url => {
                if (new URL(url).pathname === '/v2/account/settings') settingsReads++;
                return undefined;
            } });
        const machineAdmission = SocketRpcMachineAdmissionContextV1Schema.parse({ actorAccountId: 'requester',
            custodianAccountId: 'custodian', machineId: 'machine', installationId: f.installation.installationId,
            role: 'use', encryptionMode: 'plain' });
        const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'detached-operation-root', binding: {
            accountId: machineAdmission.actorAccountId, custodianAccountId: machineAdmission.custodianAccountId,
            authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
            serverIdentityId: 'srv_session_home', machineId: machineAdmission.machineId,
            installationId: machineAdmission.installationId, actionId: 'execution.run.start', admittedMachineRole: 'use',
            requestId: 'detached-operation', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
        } });
        const purpose = { kind: 'external_action' } as const;
        const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose,
            credentials: { token: f.bootstrap.credentials.token, encryption: null },
            installationPublicKey: decodeBase64(f.installation.publicKey, 'base64url'), randomBytes });
        // Home's exact authorization verification and the installed daemon's
        // lifetime are the system boundaries. Keep private custody and Action cleanup real.
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
        const checking = Promise.withResolvers<void>();
        const continueCheck = Promise.withResolvers<void>();
        let checksBeforeRelease: number | undefined;
        let installedCurrent = true;
        const prepared = await prepareRequesterAccountActionContext({ authorization: sealed, purpose,
            machineId: 'machine', installationId: f.installation.installationId,
            installationPrivateKey: decodeBase64(f.installation.privateKey, 'base64url'),
            serverId: 'session-home', serverIdentityId: 'srv_session_home', serverHttpBaseUrl: 'https://session-home.test',
            isCurrent: async () => true, isCustodyCurrent: async () => true, signal: f.signal,
            isRetainedCustodyCurrent: async () => {
                if (checksBeforeRelease !== undefined && --checksBeforeRelease === 0) {
                    checking.resolve();
                    await continueCheck.promise;
                }
                return installedCurrent;
            },
            createExecutor: () => ({ execute: async () => ({ ok: true, result: null }) }),
        });
        if (!prepared) throw new Error('Account requester preparation failed');
        const operations = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'requester',
            custodyBinding: { serverId: 'session-home', installationId: f.installation.installationId } });
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'machine',
            serverHttpBaseUrl: 'https://session-home.test', readCredentials: async () => null,
            isOwnerCurrent: () => true, readHostAgentExecutionContext: async () => null, onSettings() {} });
        let provision: Promise<unknown> | undefined;
        let liveReader: AccountSettingsSnapshotResolver | undefined;
        let prepareProvider: (() => Promise<unknown>) | undefined;
        let capture: Awaited<ReturnType<NonNullable<AccountSettingsSnapshotResolver['captureForDetachedRun']>>> | undefined;
        let settingsReadsAtAdmission = 0;
        try {
            const started = await operations.runActionOperation({ actionId: 'execution.run.start', input: {},
                context: { surface: 'cli', signal: f.signal, actionRequestId: root.binding.requestId,
                    externalActionExecutionAuthorization: prepared.authorization, machineAdmission },
                execute: async context => {
                    const read = resolver.forInvocation({ signal: context.signal!, machineAdmission,
                        callerInputAuthorization: context.externalActionExecutionAuthorization });
                    expect(await read()).toMatchObject({ settings: { preferredLanguage: 'fr' },
                        scopeKey: resolveAccountSettingsScopeKey(f.bootstrap.credentials) });
                    if (!read.captureForDetachedRun) throw new Error('Missing detached Run custody');
                    installedCurrent = false;
                    await expect(read.captureForDetachedRun(context.signal)).rejects.toMatchObject({
                        code: 'provider_authorization_changed', failureCause: { phase: 'account_snapshot.requester_not_current' },
                    });
                    installedCurrent = true;
                    settingsReadsAtAdmission = settingsReads;
                    capture = await read.captureForDetachedRun(context.signal);
                    liveReader = read;
                    prepareProvider = () => prepareExecutionRunRuntimeProviderLaunch({ scope: 'detached',
                        runId: 'detached-operation', agentId: 'codex', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                        selection: { modelId: 'fixture-native-model', agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null },
                        connectedServices: { v: 2, bindingsByServiceId: {} }, happyHomeDir: f.directory,
                        resolveAccountSettingsSnapshot: capture?.read });
                    checksBeforeRelease = 2;
                    provision = prepareProvider().catch((error: unknown) => error);
                    await Promise.race([checking.promise, provision]);
                    return { ok: true, result: { runId: 'detached-operation' } };
                },
            });
            expect(started).toMatchObject({ ok: true, result: { runId: 'detached-operation' } });
            checksBeforeRelease = undefined;
            continueCheck.resolve();
            const outcome = await provision;
            if (outcome && typeof outcome === 'object' && 'code' in outcome) throw outcome;
            expect(outcome).toMatchObject({ environment: {} });
            await expect(liveReader?.()).rejects.toMatchObject({
                code: 'provider_authorization_changed', failureCause: { phase: 'account_snapshot.requester_not_current' },
            });
            await expect(prepareProvider?.()).resolves.toMatchObject({ environment: {} });
            expect(settingsReads).toBe(settingsReadsAtAdmission);
            const admitted = capture!.read;
            installedCurrent = false;
            await expect(admitted()).resolves.toMatchObject({ settings: { preferredLanguage: 'fr' },
                scopeKey: resolveAccountSettingsScopeKey(f.bootstrap.credentials) });
            await expect(admitted({ savedSecretReferences: [{ ref: 'retired-ref' }] })).rejects.toMatchObject({
                code: 'provider_authorization_changed', failureCause: { phase: 'account_snapshot.requester_not_current' },
            });
            const stopped = new AbortController();
            stopped.abort();
            await expect(admitted({ signal: stopped.signal })).rejects.toMatchObject({ name: 'AbortError' });
            await capture?.release();
            await expect(admitted()).rejects.toMatchObject({
                code: 'provider_authorization_changed', failureCause: { phase: 'account_snapshot.requester_snapshot_unavailable' },
            });
        } finally {
            continueCheck.resolve();
            await provision;
            await capture?.release();
            await resolver.dispose();
            await prepared.dispose();
        }
    });
    it.each(['completed Run', 'cancelled Run', 'failed Start', 'daemon shutdown'] as const)(
        'retires requester custody exactly once after a detached Machine Action %s', async outcome => {
            const serverHttpBaseUrl = `https://${outcome.toLowerCase().replaceAll(' ', '-')}.session-home.test`;
            const project = await createInstalledProjectAgentLaunchFixture({ serverId: 'session-home', serverUrl: serverHttpBaseUrl,
                homeServerIdentityId: 'srv_session_home', accountSettings: { preferredLanguage: 'fr' },
                machineAccess: { custodianAccountId: 'custodian', role: 'use' } });
            const { f } = project;
            const machineAdmission = SocketRpcMachineAdmissionContextV1Schema.parse({ actorAccountId: 'requester',
                custodianAccountId: 'custodian', machineId: 'machine', installationId: f.installation.installationId,
                role: 'use', encryptionMode: 'plain' });
            const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'test-action-root', binding: {
                accountId: machineAdmission.actorAccountId, custodianAccountId: machineAdmission.custodianAccountId,
                authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
                serverIdentityId: 'srv_session_home', machineId: machineAdmission.machineId,
                installationId: machineAdmission.installationId, actionId: 'execution.run.start', admittedMachineRole: 'use',
                requestId: 'requester-custody-start', requestEnvelopeDigest: 'a'.repeat(43),
                target: { kind: 'machine', machineId: machineAdmission.machineId },
            } });
            const request = new AbortController();
            const purpose = { kind: 'external_action' } as const;
            const prepared = await prepareRequesterAccountActionContext({
                authorization: sealExternalActionRequesterAccountContextV1({ authorization: root, purpose,
                    credentials: { token: f.bootstrap.credentials.token, encryption: null },
                    installationPublicKey: decodeBase64(f.installation.publicKey, 'base64url'), randomBytes }),
                purpose, machineId: machineAdmission.machineId, installationId: machineAdmission.installationId,
                installationPrivateKey: decodeBase64(f.installation.privateKey, 'base64url'),
                serverId: 'session-home', serverIdentityId: 'srv_session_home',
                serverHttpBaseUrl, isCurrent: async () => true, isCustodyCurrent: async () => true,
                isRetainedCustodyCurrent: async () => f.isHomeCurrent(), signal: request.signal,
                createExecutor: () => ({ execute: async () => ({ ok: true, result: null }) }),
            });
            const requester = readRequesterAccountActionContext(prepared?.authorization);
            if (!requester) throw new Error('Requester admission failed');

            const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: machineAdmission.machineId,
                serverHttpBaseUrl, readCredentials: async () => null, isOwnerCurrent: () => true,
                readHostAgentExecutionContext: async () => null, onSettings() {} });
            const operations = createHostActionOperationRuntime({ machineId: machineAdmission.machineId,
                resolveAccountId: async () => machineAdmission.actorAccountId,
                custodyBinding: { serverId: 'session-home', installationId: f.installation.installationId } });
            const agent = await createAdmittedPluginRuntimeFixture({ happyHomeDir: f.directory,
                runtimeOptions: { pluginIds: ['happier.agent.codex'] } });
            const registry = await resolveCliEngineRegistry({ runtimeRegistry: agent.registry });
            const inputDelivered = Promise.withResolvers<void>();
            const actionSettled = Promise.withResolvers<void>();
            const completeTurn = Promise.withResolvers<void>();
            let launch: ReturnType<typeof createRunnerAgentProjectLaunchInvocation> | undefined;
            let runtimeOptions: Readonly<{ projectLaunchContext?: ExecutionRunProjectLaunchContext }> | undefined;
            const projectOpened = vi.fn();
            const nativeDisposed = vi.fn();
            const native = createTestExecutionRunHostRuntime({
                onProvisionRuntime: async () => {
                    await actionSettled.promise;
                    const projectContext = runtimeOptions?.projectLaunchContext;
                    if (!projectContext) throw new Error('Missing Project launch context');
                    const signal = native.getRuntimeLifetimeSignal();
                    const captured = projectContext.forRunLifetime?.(signal) ?? projectContext;
                    const actionContext = captured.ingress && buildActionExecutorContextForRpc(captured.ingress);
                    const sealed = await actionContext?.externalActionExecutionAuthorization?.requesterAccountProjection?.sealRequesterAccountContext?.({
                        authorization: actionContext.externalActionExecutionAuthorization,
                        purpose: { kind: 'machine_rpc', method: RPC_METHODS.SCM_STATUS_SNAPSHOT, params: { cwd: project.cwd } },
                        installationPublicKey: decodeBase64(f.installation.publicKey, 'base64url'),
                    });
                    expect(sealed?.requesterAccountContext, 'Native reviewer Actions keep the Run custody after ingress settles').toBeDefined();
                    launch = createRunnerAgentProjectLaunchInvocation({ ...captured,
                        cwd: project.cwd, signal });
                    const exec = createStablePluginExecService({ signal, isOccurrenceCurrent: () => true,
                        resolveExecutable: async () => ({ command: '/installed/agent' }), resolvePath: async () => project.cwd,
                        prepareAgentNativeLaunch: launch.prepareAgentNativeLaunch });
                    const result = await authorizePluginExecLaunchForHost(exec, {
                        executable: { kind: 'systemTool', id: 'fixture.agent' }, cwd: project.cwd,
                    }, { agentIsolation: null, nativeLaunch: issueAgentNativeLaunchQualifierForHost(exec) });
                    try { projectOpened(result.env); } finally { await result.release(); }
                },
                onSendPrompt: async () => {
                    native.emitMessage({ type: 'model-output', fullText: 'Inspected.' });
                    inputDelivered.resolve();
                },
                onWaitForTurnCompletion: () => completeTurn.promise,
                onCancel: async () => { completeTurn.resolve(); },
                onDispose: async () => { nativeDisposed(); completeTurn.resolve(); await launch?.disposeProjectAgentLaunch(); },
            });
            // Replace the external Agent runtime only. Engine selection, provider preparation,
            // Start admission and the Run's cleanup still use their real owners.
            const createNative = vi.fn((options: typeof runtimeOptions) => { runtimeOptions = options; return native; });
            const withNativeBoundary = (engine: Awaited<ReturnType<typeof registry.resolveForBackendId>>) =>
                engine && { ...engine, engineAdapter: { ...engine.engineAdapter, runtimeCore: {
                    ...engine.engineAdapter.runtimeCore!, createExecutionRunBackend: createNative,
                } } };
            const engineRegistry = { ...registry,
                resolveForBackendId: async (id: string) => withNativeBoundary(await registry.resolveForBackendId(id)),
                resolveForAgentTarget: async (target: Parameters<typeof registry.resolveForAgentTarget>[0]) =>
                    withNativeBoundary(await registry.resolveForAgentTarget(target)),
            };
            const capturedReleases: Array<() => Promise<void>> = [];
            const released = vi.fn();
            const observedResolver: AccountSettingsSnapshotResolver = Object.assign(resolver.bind(null), {
                forInvocation: (ingress: Parameters<typeof resolver.forInvocation>[0]) => {
                    const read = resolver.forInvocation(ingress);
                    const capture = read.captureForDetachedRun;
                    if (!capture) throw new Error('The Machine Action must supply requester custody');
                    // Each successful real capture acquires one requester reference.
                    return Object.assign(read, { captureForDetachedRun: async (signal?: AbortSignal) => {
                        const captured = await capture(signal);
                        capturedReleases.push(captured.release);
                        return { ...captured, release: async () => { released(); await captured.release(); } };
                    } });
                },
            });
            let consultations = 0;
            let clockFailed = false;
            const bridge = new ExecutionRunHostBridge({ parentProvider: 'codex', cwd: project.cwd, happyHomeDir: f.directory,
                machineId: machineAdmission.machineId, sendAcp: async () => {},
                resolveExecutionRunProfileCatalog: outcome === 'failed Start' ? undefined : async () => ({
                    profileCatalog: await registry.resolveExecutionRunProfileCatalog(), engineRegistry,
                }),
                resolveAccountSettingsSnapshot: observedResolver,
                admitStart: async () => { consultations++; },
                getNowMs: () => {
                    // Startup persistence reads the clock after both consultations and
                    // before provider provisioning. The public Start acknowledges a known failed Run.
                    if (outcome === 'failed Start' && consultations >= 2 && !clockFailed) {
                        clockFailed = true;
                        throw new Error('Test startup clock unavailable');
                    }
                    return Date.now();
                },
            });
            try {
                expect(await requester.refreshAccountSettings()).toBe(true);
                let runId = '';
                const started = await operations.runActionOperation({ actionId: 'execution.run.start', input: {},
                    context: { surface: 'cli', signal: request.signal, actionRequestId: root.binding.requestId,
                        externalActionExecutionAuthorization: requester.authorization, machineAdmission },
                    execute: async context => {
                        const verifyMachineAdmissionCurrent = async () => !request.signal.aborted && f.isHomeCurrent();
                        const run = await bridge.start({ sessionId: null, intent: 'agent', cwd: project.cwd, signal: context.signal,
                            backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, instructions: 'Inspect.',
                            permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded',
                            ioMode: 'request_response', modelSelection: null, connectedServices: null,
                            projectLaunchContext: { isCurrent: async () => !context.signal!.aborted && await verifyMachineAdmissionCurrent(),
                                resolveRuntime: ingress => project.machine.resolveProjectFiniteRuntime(ingress),
                                ingress: { ...context, signal: context.signal!, machineAdmission, verifyMachineAdmissionCurrent,
                                    callerInputAuthorization: context.externalActionExecutionAuthorization } },
                        });
                        runId = run.runId;
                        return { ok: true, result: { runId } };
                    },
                });
                expect(started).toMatchObject({ ok: true });
                expect(runId).toBeTruthy();
                await requester.dispose();
                request.abort();
                actionSettled.resolve();

                if (outcome === 'failed Start') {
                    expect(bridge.get(runId)).toMatchObject({ status: 'failed' });
                    expect(clockFailed).toBe(true);
                    expect(createNative).not.toHaveBeenCalled();
                } else {
                    const authorization = bridge.get(runId)?.executionAuthorization;
                    await expect(authorization?.requesterHttpProjection?.isCurrent()).resolves.toBe(true);
                    await Promise.race([inputDelivered.promise, bridge.waitForTerminal(runId).then(() => {
                        throw new Error(`Run settled before Agent input: ${bridge.get(runId)?.error?.code}`);
                    })]);
                    expect(projectOpened).toHaveBeenCalledWith(expect.objectContaining({ NATIVE: 'active' }));
                    expect(released).toHaveBeenCalledTimes(0);
                    if (outcome === 'daemon shutdown') {
                        // Shutdown disposes the running Run; its Project launch and custody end with it.
                        await bridge.dispose();
                        expect(nativeDisposed).toHaveBeenCalled();
                    } else {
                        if (outcome === 'cancelled Run') {
                            expect(await bridge.stop(runId)).toMatchObject({ ok: true });
                        } else {
                            completeTurn.resolve();
                        }
                        await bridge.waitForTerminal(runId);
                        expect(bridge.get(runId)).toMatchObject({ status: outcome === 'cancelled Run' ? 'cancelled' : 'succeeded' });
                        expect(await bridge.stop(runId)).toMatchObject({ ok: false, errorCode: 'execution_run_not_allowed', error: 'Not running' });
                    }
                }
                // Observe retirement before disposing the bridge, which could mask a leak.
                expect(consultations).toBeGreaterThan(1);
                await expect.poll(() => ({ retains: capturedReleases.length, releases: released.mock.calls.length,
                    snapshotRetired: requester.savedSecretOperationContext.readSnapshot() === null }))
                    .toEqual({ retains: 1, releases: 1, snapshotRetired: true });
            } finally {
                actionSettled.resolve();
                completeTurn.resolve();
                await bridge.dispose();
                // Clean up even a deliberately leaked reference after the assertions.
                for (const release of capturedReleases) await release();
                await resolver.dispose();
                await requester.dispose();
                await agent.dispose();
            }
        });

    it('refuses a Run read after its owner retires even while the original credentials remain available', async () => {
        captureHomeReads();
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'run-machine',
            serverHttpBaseUrl: 'https://run-owner.test', readCredentials: async () => credentials,
            isOwnerCurrent: () => true, onSettings() {} });
        await resolver();
        const operation = resolver.readOperationContext();
        expect(operation?.readSnapshot()).not.toBeNull();
        await resolver.dispose();
        await expect(resolver()).rejects.toMatchObject({ code: 'provider_authorization_changed',
            failureCause: { phase: 'account_snapshot.machine_resolver_disposed' } });
        expect(operation?.readSnapshot()).toBeNull();
    });

    it.each(['', '   ', 'run-machine'])('preserves the typed Account refusal with diagnostic Machine %j', async machineId => {
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId, serverHttpBaseUrl: 'https://run-owner.test',
            readCredentials: async () => null, isOwnerCurrent: () => true, onSettings() {} });
        try {
            await expect(resolver()).rejects.toMatchObject({ code: 'provider_authorization_changed', retryable: true, action: 'retry' });
            const refusal = ProviderErrorV1Schema.parse(await resolver().catch(error => error));
            expect(refusal.machineId).toBe(machineId.trim() || undefined);
            expect(refusal.failureCause).toEqual({
                phase: 'account_snapshot.machine_credentials_unavailable', errorClass: 'Error',
                errorCode: 'provider_authorization_changed', httpStatus: null,
            });
        } finally { await resolver.dispose(); }
    });
    it('withdraws a demanded captured catalog when its Home refresh is unavailable', async () => {
        const reads = captureHomeReads();
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'run-machine', serverHttpBaseUrl: 'https://run-owner.test',
            readCredentials: async () => credentials, isOwnerCurrent: () => true, onSettings() {} });
        await resolver({ mcpServerCatalog: true });
        const operation = resolver.readOperationContext();
        reads.mockRejectedValueOnce(new Error('Home unavailable'));
        await expect(resolver.refreshDemandedMcpCatalog()).rejects.toThrow();
        expect(operation?.readSnapshot()?.mcpServerCatalog).toMatchObject({ status: 'unavailable', reason: 'encryption-material-unavailable' });
        await resolver.refreshDemandedMcpCatalog();
        expect(operation?.readSnapshot()?.mcpServerCatalog?.status).toBe('ready');
        await resolver.dispose();
    });
    it('publishes demanded MCP rows in the captured invocation holder without retargeting the focused Account', async () => {
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 99,
            loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey({ token: 'focused-other-account', encryption: null }) });
        const incumbent = getActiveAccountSettingsSnapshot();
        captureHomeReads();
        let current = true;
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'run-machine', serverHttpBaseUrl: 'https://run-owner.test',
            readCredentials: async () => current ? credentials : null, isOwnerCurrent: () => true, onSettings: () => {} });
        await resolver({ mcpServerCatalog: true });
        const operation = resolver.readOperationContext();
        expect(operation?.readSnapshot()?.mcpServerCatalog).toMatchObject({ status: 'ready', revision: 2 });
        await resolver({ mcpServerCatalog: true });
        expect(resolver.readOperationContext()).toBe(operation);
        expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
        current = false;
        await expect(resolver.refreshDemandedMcpCatalog()).rejects.toMatchObject({ code: 'provider_authorization_changed' });
        expect(operation?.readSnapshot()).toBeNull();
        expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
        current = true;
        await resolver({ mcpServerCatalog: true });
        expect(resolver.readOperationContext()).not.toBe(operation);
        expect(resolver.readOperationContext()?.readSnapshot()?.mcpServerCatalog?.status).toBe('ready');
        expect(operation?.readSnapshot()).toBeNull();
        await resolver.dispose();
    });
    it('admits only selected MCP shared-secret references through the owner Home before materializing', async () => {
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({ preferredLanguage: 'de' }),
            settingsVersion: 99, loadedAtMs: 1, settingsSecretsReadKeys: [],
            scopeKey: resolveAccountSettingsScopeKey({ token: 'focused-other-account', encryption: null }) });
        const incumbent = getActiveAccountSettingsSnapshot();
        captureHomeReads(undefined, true);
        const features = FeaturesResponseSchema.parse({ features: { teams: { enabled: true, credentialResources: { enabled: true } } }, capabilities: {} });
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, options) => {
            expect(new URL(String(url)).origin).toBe('https://run-owner.test');
            expect(new Headers(options?.headers).get('Authorization')).toBe(`Bearer ${credentials.token}`);
            return Response.json(features);
        }));
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'run-machine',
            serverHttpBaseUrl: 'https://run-owner.test', readCredentials: async () => credentials,
            isOwnerCurrent: () => true, onSettings: () => {} });
        const initial = await resolver({ mcpServerCatalog: true });
        const select = (snapshot: typeof initial) => resolveSessionCapabilitiesForDirectory({
            settings: readMcpServersSettingsFromAccountSettings(snapshot), machineId: 'run-machine', directory: '/repo',
            selection: { mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: ['wilson-brief'], forceExcludeServerIds: [] } },
        });
        const references = listSelectedMcpSharedSecretReferences(select(initial).selectedServersByName);
        expect(references).toEqual([{ ref: 'happier:shared-secret:v1:wilson-token' }]);
        const admitted = await resolver({ mcpServerCatalog: true, savedSecretReferences: references });
        const materialized = await materializeMcpServerConfigRecord({
            resolved: { directory: '/repo', strictMode: true, serversByName: select(admitted).selectedServersByName },
            savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(admitted), processEnv: {}, tmpDir: null,
        });
        try {
            const configPath = materialized.mcpServers['wilson-brief']?.env?.HAPPIER_MCP_STDIO_LAUNCHER_CONFIG_FILE;
            if (!configPath) throw new Error('Missing owned MCP launcher configuration');
            // The real stdio materializer protects secret values in this file,
            // rather than publishing them in the Agent-facing launcher env.
            const launch: unknown = JSON.parse(await readFile(configPath, 'utf8'));
            expect(launch).toMatchObject({ env: { WILSON_TOKEN: 'synthetic-home-token' } });
            expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
        } finally {
            materialized.cleanup();
            await resolver.dispose();
        }
    });

    it('admits the demanded MCP catalog from the exact owner Home without borrowing focused Account state', async () => {
        const focusedCredentials: StoredCredentials = { token: 'focused-other-account', encryption: null };
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({ preferredLanguage: 'de' }),
            settingsVersion: 99, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(focusedCredentials) });
        const incumbent = getActiveAccountSettingsSnapshot();
        captureHomeReads();
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'run-machine',
            serverHttpBaseUrl: 'https://run-owner.test', readCredentials: async () => credentials,
            isOwnerCurrent: () => true, onSettings: () => {} });
        const snapshot = await resolver({ mcpServerCatalog: true });
        expect(snapshot.settings.preferredLanguage).toBe('fr');
        expect(snapshot.mcpServerCatalog).toMatchObject({ status: 'ready', catalog: { servers: [{ id: 'wilson-brief' }] } });
        expect(getActiveAccountSettingsSnapshot()).toBe(incumbent);
    });

    it('rejects owner credential replacement during demanded catalog admission', async () => {
        let current: StoredCredentials | null = credentials;
        captureHomeReads(() => { current = null; });
        const resolver = createExecutionRunAccountSettingsSnapshotResolver({ machineId: 'run-machine',
            serverHttpBaseUrl: 'https://run-owner.test', readCredentials: async () => current,
            isOwnerCurrent: () => true, onSettings: () => {} });
        await expect(resolver({ mcpServerCatalog: true })).rejects.toMatchObject({ code: 'scope-retired' });
    });
});
