import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, normalizeActionsSettingsV1, createActionExecutor, deriveSessionCreationTagV1, ExternalActionExecutionAuthorizationRequestV1Schema, type ActionExecuteResult, type ActionExecutorContext, type ActionExecutorDeps } from '@happier-dev/protocol';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1, AccountApiTokensListActionOutputV1Schema } from '@happier-dev/protocol/auth/accountApiTokens';

import { configuration } from '@/configuration';
import { updateSettings, writeStoredCredentialsForServerId, readStoredCredentialsForServerId, removeStoredCredentialsForServerId, sameStoredCredentials } from '@/persistence';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createConnectedAccountPurposeBindingOwner } from '../connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '../connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { createManagedProviderOperationAuthority } from '../connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createDaemonManagedMachineActionAdapter, createManagedSessionStartApprovalObserver } from './managedMachineActionAdapter';
import { createDaemonSessionAccountActionExecutor } from '../agentRuntime/createDaemonSessionAccountActionExecutor';
import { dispatchManagedSessionStart, prepareExternalActionRequesterAccountAuthorization, projectExternalActionRequesterHttpAuthorization, verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import nacl from 'tweetnacl';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonApprovalExecutionOriginCurrentnessFromCredentials, createDaemonExternalActionTargetResolver } from '../externalActions/daemonExternalActionTargetResolver';
import { prepareSessionCreationTarget } from '@/session/creation/prepareSessionCreationTarget';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema as ChildRequestSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { applyTrackedSessionTurnLifecycle } from '../sessions/applyTrackedSessionTurnLifecycle';
import { authorizeTrackedRunnerAgentDaemonServiceOperation } from '../agentRuntime/authorizeTrackedRunnerAgentDaemonServiceOperation';
import { createAgentSessionRunnerFactoryBinding } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { readOrCreateInstallationIdentity } from '../identity/store';
import type { TrackedSession } from '../types';
import { AccountSettingsSchema } from '@happier-dev/protocol';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { signExternalActionApprovalInputV1, verifyExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { loadPromptLibraryCatalogV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { refreshActiveAcpCatalog } from '@/agent/acp/catalog/hydrateAcpCatalog';
import { AutomationDefinitionDetailSchema, AutomationDefinitionReconcileRequestSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { createPluginContributionIdentity } from '@happier-dev/protocol';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerManagedFiniteWake } from '@/rpc/handlers/managedFiniteWake';
import { MANAGED_FINITE_WAKE_RPC_METHOD } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { ACTION_API_SERVER_ORIGIN } from '@happier-dev/protocol/rpc';
import { executeManagedMachinePolicyAction } from './managedMachinePolicyAction';
import { fixture as nativeFixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';

const approvalWire = vi.hoisted(() => {
    const sockets: Array<{ wake(): void }> = [];
    return { sockets, io: () => {
        const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
        const emit = (event: string) => { for (const listener of listeners.get(event) ?? []) listener(); };
        const socket = { connected: false, io: { timeout() {}, on() {}, off() {} },
            on(event: string, listener: (...args: unknown[]) => void) { const group = listeners.get(event) ?? new Set(); group.add(listener); listeners.set(event, group); },
            off(event: string, listener: (...args: unknown[]) => void) { listeners.get(event)?.delete(listener); },
            connect() { socket.connected = true; emit('connect'); }, disconnect() { socket.connected = false; },
            removeAllListeners() { listeners.clear(); }, offAny() {}, wake() { emit('connect'); } };
        sockets.push(socket); return socket;
    } };
});
vi.mock('socket.io-client', () => ({ io: approvalWire.io }));

const serverUrl = 'https://managed-home.example';
const credentials = { token: 'token', encryption: null };
const unavailable = async (): Promise<never> => { throw new Error('Unexpected credential transport'); };
const authority = createManagedProviderOperationAuthority({
    materializationBaseDir: tmpdir(),
    purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
        store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
        selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
        projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
    }),
    requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
    createRedactionLease: () => ({ add() {}, close() {} }),
});

async function storeHome(homeServerIdentityId: string) {
    await updateSettings((settings) => ({ ...settings, servers: { ...settings.servers,
        [configuration.activeServerId]: { id: configuration.activeServerId, name: 'Managed Home',
            serverUrl, webappUrl: serverUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
            homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: { v: 1, homeServerIdentityId, canonicalServerUrl: serverUrl,
                revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] },
        },
    } }));
}

function adapter(withAuthority = true, executeSessionStart?: Parameters<typeof createDaemonManagedMachineActionAdapter>[0]['executeSessionStart'],
    preflightSessionStart?: Parameters<typeof createDaemonManagedMachineActionAdapter>[0]['preflightSessionStart'],
    privateKey: string | Uint8Array = 'not-used-by-passive-discovery', accountCredentials = credentials,
    observeSessionStartApproval?: Parameters<typeof createDaemonManagedMachineActionAdapter>[0]['observeSessionStartApproval']) {
    // The module-loading boundary has no installed plugin. The empty catalog
    // itself is produced by the real contribution registry owner.
    const registry = { contributes: createResolvedContributionRegistry({}) } as ResolvedExecutablePluginRuntimeRegistry;
    return createDaemonManagedMachineActionAdapter({ credentials: accountCredentials, machineId: 'controller', serverBaseUrl: serverUrl, serverId: configuration.activeServerId,
        ...(executeSessionStart ? { executeSessionStart } : {}),
        ...(preflightSessionStart ? { preflightSessionStart } : {}),
        ...(observeSessionStartApproval ? { observeSessionStartApproval } : {}),
        installationIdentity: { installationId: 'installation', privateKey },
        ...(withAuthority ? { managedProviderOperationAuthority: authority } : {}),
        resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
            serverUrl, resolveCurrentMachineId: () => 'controller',
        }),
        acquireRuntimeRegistryLease: async () => ({ registry, source: 'active', durableRevision: 1, release: async () => {} }),
    });
}

describe('daemon managed Machine Action factory', () => {
    it.each(['signed-ui', 'local-host'] as const)('consumes exact requester-owned recorded setup execution instead of treating Ask as setup success (%s)', async origin => {
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 0, provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const ownCredentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
        const guest = createCliActionExecutorHarness({ sessionId: 'setup-observer-fixture', token, credentials: ownCredentials, serverId: configuration.activeServerId,
            serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl, mode: 'plain', ctx: null });
        let artifact: { id: string; header: string; body: string; dataEncryptionKey: string } | undefined;
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (String(url).endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
            if (new URL(String(url)).pathname !== '/v1/artifacts') throw new Error('Setup must not run before approval');
            // Persistent Artifact transport is the only substituted boundary.
            artifact = body as typeof artifact;
            return { status: 200, data: { id: artifact!.id, headerVersion: 1, bodyVersion: 1 } };
        });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (new URL(String(url)).pathname === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (!artifact || new URL(String(url)).pathname !== `/v1/artifacts/${artifact.id}`) throw new Error('Unexpected requester-private read');
            const content = decodePlainArtifactStoredContent(artifact.body);
            const original = StoredApprovalRequestSchema.parse(JSON.parse(String(content && typeof content === 'object' ? Reflect.get(content, 'body') : null)));
            const recorded = StoredApprovalRequestSchema.parse({ ...original, status: 'executed', updatedAtMs: original.updatedAtMs + 1,
                decision: { kind: 'approve', decidedAtMs: original.updatedAtMs + 1 },
                execution: { executedAtMs: original.updatedAtMs + 1, ok: true, result: { operationId: 'actual-setup-operation', terminalId: 'actual-setup-terminal' } } });
            return { status: 200, data: { ...artifact, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
                headerVersion: 2, bodyVersion: 2, seq: 2, createdAt: original.createdAtMs, updatedAt: recorded.updatedAtMs,
                header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(recorded)),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(recorded) }) } };
        });
        const input = { homeId: 'srv_home', machineId: 'actual-guest', presetId: 'preset', presetRevision: 4 };
        const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: 'account',
            actionRequestId: 'creation', serverId: configuration.activeServerId, serverIdentityId: 'srv_home', signal: new AbortController().signal,
            actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: { 'machines.environment.apply': { approvalRequiredSurfaces: ['ui'] } } }) };
        const guestSigning = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(10));
        const guestAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-guest-setup', binding: {
            accountId: 'account', custodianAccountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
            machineId: 'actual-guest', installationId: 'guest-installation', serverIdentityId: 'srv_home', actionId: 'machines.environment.apply',
            requestId: 'creation', requestEnvelopeDigest: 'b'.repeat(43), target: { kind: 'machine', machineId: 'actual-guest' },
        } });
        const guestContext: ActionExecutorContext = { ...context, externalActionExecutionAuthorization: guestAuthorization,
            externalActionTarget: guestAuthorization.binding.target, signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({
                authorizationToken: guestAuthorization.token, actionId: args.actionId, input: args.input, target: args.target, privateKey: guestSigning.secretKey,
            }) };
        expect(await guest.executor.execute('machines.environment.apply', input, guestContext)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        const signing = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
        const original = await projectExternalActionRequesterHttpAuthorization({
            authorization: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-original-ui-acquire', binding: {
                accountId: 'account', custodianAccountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
                machineId: 'controller', installationId: 'installation', serverIdentityId: 'srv_home', actionId: 'machines.managed.acquire',
                requestId: 'creation', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'controller' },
            } }), serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl,
            target: { kind: 'machine', machineId: 'controller' }, installationId: 'installation', privateKey: signing.secretKey,
            signal: context.signal,
        });
        expect(original).not.toBeNull();
        const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_home', custodianAccountId: 'account', enrolledMachineId: 'actual-guest',
            controller: { machineId: 'controller', installationId: 'installation' }, launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
            allocation: 'bound', resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} }, creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const installedProfile = `setup-observer-${randomUUID()}`;
        try {
            // Dedicated installed credential-file boundary; no existing profile material is read or overwritten.
            await writeStoredCredentialsForServerId(installedProfile, ownCredentials);
            const observer = createManagedSessionStartApprovalObserver({ actionId: 'machines.environment.apply', credentials: ownCredentials, machineId: 'controller',
                isRequesterRuntimeCurrent: async () => sameStoredCredentials(ownCredentials, await readStoredCredentialsForServerId(installedProfile)),
                observeRecordedApprovalExecution: args => guest.observeRecordedApprovalExecution(args) });
            const observationContext = origin === 'signed-ui' ? { ...context, externalActionExecutionAuthorization: original! }
                : { ...context, surface: 'cli' as const, externalActionTarget: { kind: 'machine' as const, machineId: 'controller' } };
            expect(await observer({ artifactId: artifact!.id, context: observationContext, machine, isCurrent: async () => true })).toEqual({ ok: true,
                result: { operationId: 'actual-setup-operation', terminalId: 'actual-setup-terminal' } });
            const unsignedObserver = createManagedSessionStartApprovalObserver({ actionId: 'machines.environment.apply', credentials: ownCredentials, machineId: 'controller',
                observeRecordedApprovalExecution: args => guest.observeRecordedApprovalExecution(args) });
            expect(await unsignedObserver({ artifactId: artifact!.id, context, machine, isCurrent: async () => true }))
                .toMatchObject({ ok: false, errorCode: 'approval_context_unavailable' });
        } finally { await removeStoredCredentialsForServerId(installedProfile); }
    });
    it('refuses a foreign finite requester without controller-scoped C42 custody before using custodian policy or native IO', async () => {
        const custodian = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'alice', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
        const signing = nacl.sign.keyPair();
        const effects: string[] = [];
        const native = nativeFixture({ privateNative: true, supportedIntents: ['start'], onNativeRole: role => { effects.push(role); } });
        const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_home', custodianAccountId: 'alice',
            controller: { machineId: 'controller', installationId: 'installation' }, enrolledMachineId: 'guest',
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            allocation: 'bound', resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true });
        const actionOrigin = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-bob-finite-origin', binding: {
            accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
            machineId: 'guest', installationId: 'guest-installation', serverIdentityId: 'srv_home', actionId: 'projects.script.run',
            requestId: 'original-finite', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'guest' },
        } });
        const target = { homeId: machine.homeId, managedId: machine.id, enrolledMachineId: 'guest', expectedIntentRevision: machine.intentRevision,
            controller: machine.controller, origin: { kind: 'finite-command' as const, actionRequestId: 'original-finite' }, reason: 'admitted-work' as const };
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'alice' });
        const post = vi.spyOn(axios, 'post').mockImplementation(async url => {
            if (String(url).endsWith('/admit-policy')) return { status: 200, data: { machine: { ...machine, desired: 'start', intentRevision: 2 }, requestId: 'wake', replayed: false } };
            return { status: 200, data: { machine } };
        });
        const policy = createDaemonManagedMachineActionAdapter({ credentials: custodian, machineId: 'controller', serverBaseUrl: serverUrl,
            serverId: configuration.activeServerId, installationIdentity: { installationId: 'installation', privateKey: signing.secretKey },
            managedProviderOperationAuthority: authority,
            resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({ serverUrl, resolveCurrentMachineId: () => 'controller' }),
            acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
            observeActionExecution: request => operations.observeExecution(request),
            executeManagedPolicyAction: (current, context, runApproved) => executeManagedMachinePolicyAction({ machine: current, context,
                serverId: configuration.activeServerId, runApproved, createExecutor: overrides => createActionExecutor({ ...createUnavailableActionTransportDeps(), ...overrides }) }),
        });
        const rpc = new RpcHandlerManager({ scopePrefix: 'controller', encryptionMode: 'plain', logger: () => {} });
        registerManagedFiniteWake(rpc, { readCurrent: async () => machine, executePolicy: policy.executePolicy });
        expect(await rpc.handleRequest({ method: `controller:${MANAGED_FINITE_WAKE_RPC_METHOD}`, params: { target, actionOrigin },
            authorization: ACTION_API_SERVER_ORIGIN })).toMatchObject({ ok: false, errorCode: 'requester_account_context_unavailable' });
        expect(effects).toEqual([]); expect(post).not.toHaveBeenCalled();
    });
    it.each([false, true])('moves the custodian FIN scope binding for foreign Manage and exposes an incomplete FIN write (%s)', async failWrite => {
        const custodianCredentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 0,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`, encryption: null };
        const provider = createPluginContributionIdentity({ pluginId: 'acme.compute', localId: 'vm' });
        const moved = ManagedMachineV1Schema.parse({ id: 'managed', homeId: 'srv_home', custodianAccountId: 'account',
            launch: { provider, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'new-controller', installationId: 'new-installation' }, enrolledMachineId: 'guest',
            allocation: 'bound', resource: { contributionRef: provider, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 2, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const definition = { version: 1, defaults: {}, inputs: [], blocks: [{ kind: 'action', id: 'managed-scope-end',
            actionId: 'machines.managed.power.set', input: { homeId: { kind: 'literal', value: 'srv_home' },
                managedId: { kind: 'literal', value: 'managed' }, when: { kind: 'literal', value: 'after-idle' }, intent: { kind: 'literal', value: 'stop' } } }] };
        let row = AutomationDefinitionDetailSchema.parse({ id: 'scope-rule', name: 'Workflow triggers', description: null,
            enabled: true, targetType: null, existingSessionId: null, templateVersion: 1, createdAt: 1, updatedAt: 1, lastRunAt: null,
            workflowDefinitionId: null, scopeSessionId: 'source-session', assignments: [{ machineId: 'controller', enabled: true, priority: 0, updatedAt: 1 }],
            executionRecipe: { v: 2, templateVersion: 1, workflow: { t: 'plain', v: { workspace: { directory: '~' },
                inlineDefinition: definition, inputs: {}, executionTarget: { kind: 'detached_run' } } }, triggerEvidence: null },
            triggers: [{ id: 'scope-trigger', revision: 0, kind: 'sessionLifecycle', enabled: true, createdAt: 1, updatedAt: 1,
                sourceSessionId: 'source-session', events: ['sessionArchived'], policy: { kind: 'everyMatch' }, remainingOccurrences: null,
                status: { state: 'waiting', runId: null }, triggerDefinitionEnvelope: null }] });
        vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: {
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            if (path.startsWith('/v3/automations')) {
                expect(config?.headers?.Authorization).toBe(`Bearer ${custodianCredentials.token}`);
                const { executionRecipe: _private, ...summary } = row;
                return { status: 200, data: { automations: [{ ...summary,
                    triggers: summary.triggers.map(({ triggerDefinitionEnvelope: _envelope, ...trigger }) => trigger) }], nextCursor: null } };
            }
            throw new Error(`Unexpected Move HTTP GET ${path}`);
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            expect(new URL(String(request.url)).pathname).toBe('/v3/automations/scope-rule');
            expect(request.headers?.Authorization).toBe(`Bearer ${custodianCredentials.token}`);
            if (request.method === 'GET') return { status: 200, data: row };
            expect(request.method).toBe('PUT');
            if (failWrite) throw Object.assign(new Error('FIN transport unavailable'), { code: 'outcome_unknown' });
            const patch = AutomationDefinitionReconcileRequestSchema.parse(request.data);
            row = AutomationDefinitionDetailSchema.parse({ ...row, templateVersion: row.templateVersion + 1,
                executionRecipe: patch.executionRecipe, assignments: patch.assignments.map(value => ({ ...value, enabled: value.enabled ?? true, priority: value.priority ?? 0, updatedAt: 2 })) });
            return { status: 200, data: row };
        });
        vi.spyOn(axios, 'post').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith('/admit-control')) return { status: 200, data: { machine: moved, replayed: false } };
            if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (path.endsWith('/actions/get')) return { status: 200, data: moved };
            throw new Error(`Unexpected Move HTTP ${path}`);
        });
        const target = { kind: 'machine' as const, machineId: 'controller' };
        const actionId = 'machines.managed.controller.update' as const;
        const moveInput = { homeId: 'srv_home', managedId: 'managed', expectedIntentRevision: 1,
            controller: moved.controller, reviewedPendingEffects: true };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'foreign-manage', binding: {
            accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: 'srv_home',
            machineId: 'controller', custodianAccountId: 'account', installationId: 'installation', actionId, requestId: 'move', target,
            accountEncryptionMode: 'plain', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'move', target, input: moveInput }) } });
        const result = await adapter(true, undefined, undefined, nacl.sign.keyPair().secretKey, custodianCredentials)({ actionId,
            input: moveInput,
            context: { actionRequestId: 'move', surface: 'rpc', authority: 'account_automation', externalActionExecutionAuthorization: authorization,
                externalActionTarget: target }, signal: new AbortController().signal });
        if (failWrite) expect(result).toMatchObject({ ok: false, errorCode: 'managed_binding_move_incomplete', details: { machine: moved } });
        else expect(result).toEqual(moved);
        expect(row.assignments.map(value => value.machineId)).toEqual([failWrite ? 'controller' : 'new-controller']);
    });
    beforeEach(async () => {
        await storeHome('srv_home');
        // HTTP is the only identity boundary substituted; profile resolution,
        // current-origin resolution and the acquisition driver remain real.
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
            features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } },
        })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
    afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

    it.each([
        ['turn-ended-during-mint', 'machines.managed.acquire'], ['natural-end', 'machines.managed.acquire'],
        ['source-replaced', 'machines.managed.acquire'], ['permission-withdrawn', 'machines.managed.acquire'],
        ['managed-retired', 'machines.managed.acquire'], ['operation-canceled', 'machines.managed.acquire'],
        ['natural-end', 'machines.managed.bootstrap.retry'], ['source-replaced', 'machines.managed.bootstrap.retry'],
        ['permission-withdrawn', 'machines.managed.bootstrap.retry'], ['operation-canceled', 'machines.managed.bootstrap.retry'],
    ] as const)(
        'rechecks accepted Session origin through the incumbent policy owner after %s for %s without requiring the old turn to stay active', async (phase, actionId) => {
        const sessionId = 'c111111111111111111111111';
        const retained = createAgentSessionRunnerFactoryBinding({ v: 1, pluginId: 'acme.runner', pluginVersion: '1.0.0', agentId: 'coding', localAgentId: 'coding',
            sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-a', installSource: 'localPath' },
            locator: { module: './runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 }, normalizedModulePath: 'runtime.mjs', loadMode: 'immutable-js' });
        const runner = { pid: 42, processStartTimeMs: 123, processCommandHash: '5'.repeat(64), snapshotIdentity: 'fixture' };
        const tracked: TrackedSession = { pid: 41, sessionRunnerPid: runner.pid, startedBy: 'daemon', happySessionId: sessionId,
            processStartTimeMs: runner.processStartTimeMs, processCommandHash: runner.processCommandHash, runnerAgentSourceCustodyV1: retained.sourceCustody,
            activeTurnId: 'turn', agentRuntimeDaemonServiceAdmittedTurnId: 'turn', agentRuntimeDaemonServiceAdmittedInputId: 'input',
            agentRuntimeDaemonServiceAdmittedUserMessageSeq: 1, agentRuntimeDaemonServiceAdmittedUserMessageSeqs: [1] };
        const witness = { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1] };
        const currentTurn = () => authorizeTrackedRunnerAgentDaemonServiceOperation({ tracked, sessionId, runner, retainedAgent: retained,
            witness, allowIdleCurrentGeneration: false });
        const operation = new AbortController();
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 0,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const sourceCredentials = { token, encryption: null };
        const accountSettings = AccountSettingsSchema.parse({});
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettings, settingsVersion: 1, loadedAtMs: 1,
            settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(sourceCredentials) });
        const installation = await readOrCreateInstallationIdentity();
        const caller = { kind: 'session' as const, sessionId, starterDepth: 1, turnDepth: 2 };
        const causalPermissionAuthority = { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const };
        const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1, caller, sourceTurnId: 'turn', callerPermissionMode: 'yolo',
            causalPermissionAuthority, requestId: 'session-acquire' });
        const target = { kind: 'machine' as const, machineId: 'controller' };
        const input = actionId === 'machines.managed.bootstrap.retry'
            ? { homeId: 'srv_home', managedId: 'retained', expectedIntentRevision: 0 }
            : { selection: { kind: 'one-off' as const, homeId: 'srv_home', controller: { machineId: 'controller', installationId: installation.installationId },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false } };
        let currentPermission = 'yolo';
        let homeCurrent = true;
        // Network and the marker filesystem are substituted; lifecycle,
        // retained-source admission, permission/causal policy and proof verification stay real.
        vi.spyOn(axios, 'get').mockImplementation(async url => String(url).endsWith('/encryption/currentness')
            ? { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } }
            : { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', share: null,
                metadata: JSON.stringify({ machineId: 'controller', path: '/repo', permissionMode: currentPermission }) }) } });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            if (request.method === 'POST' && request.url === `${serverUrl}${ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1}`) {
                return { status: 200, data: AccountApiTokensListActionOutputV1Schema.parse({ tokens: [] }) };
            }
            throw new Error(`Unexpected accepted-origin HTTP request: ${request.method} ${request.url}`);
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (String(url).endsWith('/verify')) return { status: homeCurrent ? 200 : 403, data: homeCurrent ? { ok: true } : {} };
            if (!String(url).endsWith('/execution-authorization')) return { status: 200, data: { tokens: [] } };
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            if (phase === 'turn-ended-during-mint') await applyTrackedSessionTurnLifecycle({ trackedSessions: [tracked], sessionId,
                event: 'assistant_message_end', turnId: 'turn', updateSessionMarkerActiveTurn: async () => true });
            return { status: 200, data: { v: 1, token: 'accepted-session-proof', binding: {
                serverIdentityId: 'srv_home', accountId: 'account', custodianAccountId: 'account', machineId: 'controller',
                installationId: installation.installationId, authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
                actionId, requestId: sessionActionOrigin.requestId, target, sessionActionOrigin,
                sessionActionSource: { machineId: 'controller', installationId: installation.installationId },
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
            } } };
        });
        const acceptedCurrentness = createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials: sourceCredentials,
            machineId: 'controller', serverId: configuration.activeServerId, serverApiUrl: serverUrl,
            isSessionCallerCurrent: async ({ caller: source, signal }) => source.sessionId === sessionId && !signal?.aborted
                && authorizeTrackedRunnerAgentDaemonServiceOperation({ tracked, sessionId, runner, retainedAgent: retained,
                    witness: undefined, allowIdleCurrentGeneration: true }),
        });
        expect(acceptedCurrentness).toBeDefined();
        let acceptedOrigin: ReturnType<typeof buildApprovalExecutionOriginV1> | undefined;
        const args = { actionId, input, requestId: sessionActionOrigin.requestId, target, machineId: 'controller',
            accountId: 'account', accountEncryptionMode: 'plain' as const, tokenEpochHint: 0, token,
            serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl,
            installationId: installation.installationId, privateKey: installation.privateKey, sessionActionOrigin, sourceMachineId: 'controller', isCurrent: async () => currentTurn(),
            isContinuationCurrent: async (authorization: NonNullable<Awaited<ReturnType<typeof prepareExternalActionRequesterAccountAuthorization>>>) => {
                const origin = acceptedOrigin = buildApprovalExecutionOriginV1({ actionId, input, targetSessionId: null, context: {
                    surface: 'agent', authority: 'account_automation', actionCaller: caller, defaultSessionId: sessionId,
                    serverId: configuration.activeServerId, serverIdentityId: 'srv_home', runtimeAccountId: 'account',
                    actionRequestId: sessionActionOrigin.requestId, externalActionTarget: target, callerPermissionMode: 'yolo', causalPermissionAuthority,
                    sessionInputSource: { sourceSessionId: sessionId, sourceTurnId: 'turn', via: 'action' },
                    sessionAgentSpawnPolicyV1: accountSettings.sessionAgentSpawnPolicyV1, externalActionExecutionAuthorization: authorization,
                    signExternalActionApprovalInput: ({ actionId, input: signedInput, target: signedTarget }) => signExternalActionApprovalInputV1({
                        authorizationToken: authorization.token, actionId, input: signedInput, target: signedTarget, privateKey: installation.privateKey }),
                },
                });
                if (!origin) return false;
                return await acceptedCurrentness!({ origin, actionInput: input, signal: operation.signal });
            },
        };
        const prepared = await prepareExternalActionRequesterAccountAuthorization(args);
        if (phase === 'turn-ended-during-mint') {
            expect(prepared).toBeNull();
            expect(currentTurn()).toBe(false);
            return;
        }
        if (actionId === 'machines.managed.acquire') {
            expect(acceptedOrigin).toMatchObject({ surface: 'agent', authority: 'account_automation', caller });
        }
        expect(prepared).not.toBeNull();
        expect(currentTurn()).toBe(true);
        await expect(applyTrackedSessionTurnLifecycle({ trackedSessions: [tracked], sessionId, event: 'assistant_message_end', turnId: 'turn',
            updateSessionMarkerActiveTurn: async () => true })).resolves.toMatchObject({ status: 'recorded', activeTurnId: null });
        expect(currentTurn()).toBe(false);
        if (phase === 'source-replaced') tracked.processStartTimeMs = runner.processStartTimeMs + 1;
        if (phase === 'permission-withdrawn') currentPermission = 'default';
        if (phase === 'managed-retired') homeCurrent = false;
        if (phase === 'operation-canceled') operation.abort();
        const headers = await prepared!.requesterHttpProjection!.createRequestHeaders({ effectActionId: actionId,
            method: 'POST', path: '/v1/machines/managed/controller/current', body: {}, signal: operation.signal });
        expect(headers !== null).toBe(phase === 'natural-end');
        if (actionId === 'machines.managed.bootstrap.retry') return;
        // Ordinary Session creation's native boundary is substituted; the
        // canonical Agent permission/depth admission and result parser stay real.
        const starts: number[] = [];
        const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'acme.agent', localId: 'coding' } };
        const spawn = createActionExecutor({ sessionSpawnNew: async (args: Parameters<ActionExecutorDeps['sessionSpawnNew']>[0]) => {
            starts.push(args.workDepth ?? -1);
            return { type: 'success', disposition: 'created', sessionId: 'child', executionTarget: args.executionTarget,
                organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'accepted', localId: 'initial' } };
        } } as unknown as ActionExecutorDeps);
        if (headers) expect(await spawn.execute('session.spawn_new', { creationKey: 'session-acquire',
            executionTarget: { serverId: configuration.activeServerId, machineId: 'actual-guest' }, directory: { kind: 'managed' },
            agentTarget, initialInput: { text: 'Continue on guest' } }, {
            surface: 'agent', authority: 'account_automation', actionCaller: caller, defaultSessionId: sessionId,
            serverId: configuration.activeServerId, runtimeAccountId: prepared!.binding.accountId,
            sessionInputSource: { sourceSessionId: sessionId, sourceTurnId: sessionActionOrigin.sourceTurnId, via: 'action' },
            callerPermissionMode: 'yolo', causalPermissionAuthority,
            sessionAgentSpawnPolicyV1: accountSettings.sessionAgentSpawnPolicyV1, signal: operation.signal,
            agentStartContext: { caller, baseline: { machineId: 'controller', directory: '/repo', configuration: { agentTarget } },
                roles: {}, ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'yolo' },
        })).toMatchObject({ ok: true, result: { type: 'success', sessionId: 'child' } });
        expect(starts).toEqual(phase === 'natural-end' ? [3] : []);
    });

    it.each(['reviewed-waiver', 'default-ask', 'foreign-controller', 'cancel-default-ask'] as const)('preserves original Session authority through the Home minter under %s policy', async policy => {
        const actionId = policy === 'cancel-default-ask' ? 'machines.managed.cancel' as const : 'machines.managed.acquire' as const;
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 0,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const sourceCredentials = { token, encryption: null };
        const accountSettings = AccountSettingsSchema.parse(policy === 'reviewed-waiver' ? {
            actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.managed.acquire': ['agent'] } },
        } : {});
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettings, settingsVersion: 1, loadedAtMs: 1,
            settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(sourceCredentials) });
        const controller = policy === 'foreign-controller'
            ? { machineId: 'different-controller', installationId: 'different-installation' }
            : { machineId: 'controller', installationId: 'installation' };
        const selection = { kind: 'one-off' as const, homeId: 'srv_home', controller,
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false };
        const machine = { id: 'managed', homeId: 'srv_home', custodianAccountId: 'account', launch: selection.launch,
            controller: selection.controller, allocation: 'may-exist', creationState: 'active', desired: 'start',
            desiredWhen: 'now', intentRevision: 0, retention: selection.retention, wakeOnAcceptedMessage: false };
        const input = policy === 'cancel-default-ask'
            ? { homeId: 'srv_home', managedId: 'managed', expectedIntentRevision: 0 } : { selection };
        const target = { kind: 'machine' as const, machineId: controller.machineId };
        const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: 'lead', starterDepth: 1, turnDepth: 2 },
            sourceTurnId: 'turn', callerPermissionMode: 'yolo', causalPermissionAuthority: null, requestId: 'session-acquire' });
        const signing = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(27));
        const requests: string[] = [];
        const approvalRequests: ReturnType<typeof StoredApprovalRequestSchema.parse>[] = [];
        let storedApproval: Readonly<{ id: string; dataEncryptionKey: string }> | undefined;
        // Only Home HTTP is substituted. Session access, original minting,
        // Action policy, operation acceptance and managed reconciliation stay real.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (path.startsWith('/v1/artifacts/')) {
                if (!storedApproval || path !== `/v1/artifacts/${storedApproval.id}`) return { status: 404, data: {} };
                // The external approver rejects the stored request. Agent Ask
                // keeps its incumbent blocking lifecycle; no compute is approved.
                const original = approvalRequests[0];
                const rejected = StoredApprovalRequestSchema.parse({ ...original, status: 'rejected',
                    updatedAtMs: original.updatedAtMs + 1,
                    decision: { kind: 'reject', decidedAtMs: original.updatedAtMs + 1 } });
                return { status: 200, data: { ...storedApproval, ownerAccountId: 'account', access: 'owner',
                    encryptionMode: 'plain', publicAudience: 'none', headerVersion: 2, bodyVersion: 2,
                    seq: 2, createdAt: original.createdAtMs, updatedAt: rejected.updatedAtMs,
                    header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(rejected,
                        { legacyServerId: configuration.activeServerId })),
                    body: encodePlainArtifactStoredContent({ body: JSON.stringify(rejected) }) } };
            }
            return { status: 200, data: { session: createSessionRecordFixture({ id: 'lead', share: null }) } };
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
            const path = new URL(String(url)).pathname;
            requests.push(path);
            if (path.endsWith('/execution-authorization')) {
                expect(config?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                expect(body).toMatchObject({ sessionActionOrigin });
                return { status: 200, data: { v: 1, token: 'original-home-proof', binding: {
                    accountId: 'account', authentication: { kind: 'account', tokenEpoch: 0 },
                    serverIdentityId: 'srv_home', machineId: controller.machineId, custodianAccountId: 'account',
                    installationId: controller.installationId, actionId, requestId: 'session-acquire',
                    target, accountEncryptionMode: 'plain', sessionActionOrigin,
                    sessionActionSource: { machineId: 'controller', installationId: 'installation' },
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
                } } };
            }
            if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
            if (path.endsWith('/admit')) return { status: 200, data: { machine, replayed: true } };
            if (path === '/v1/artifacts') {
                // Artifact POST is the genuine persisted-content HTTP boundary.
                const record = body as Readonly<{ id: string; body: string; dataEncryptionKey: string }>;
                const content = decodePlainArtifactStoredContent(record.body);
                expect(content).toMatchObject({ body: expect.any(String) });
                const stored = typeof content === 'object' && content !== null ? Reflect.get(content, 'body') : null;
                approvalRequests.push(StoredApprovalRequestSchema.parse(JSON.parse(String(stored))));
                storedApproval = { id: record.id, dataEncryptionKey: record.dataEncryptionKey };
                return { status: 200, data: { id: record.id, headerVersion: 1, bodyVersion: 1 } };
            }
            throw new Error(`Unexpected managed Session producer path ${path}`);
        });
        const managedMachineAction = adapter(true, undefined, undefined, signing.secretKey, sourceCredentials);
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account',
            generateOperationId: () => 'session-operation' });
        const executor = createCliActionExecutorFromCredentials({ credentials: sourceCredentials,
            serverId: configuration.activeServerId, serverApiUrl: serverUrl, serverIdentityId: 'srv_home',
            // The live original Session factory has no Machine selector. Its
            // private source identity comes from the Home-verified Session proof.
            externalActionMachineRequestPrivateKey: signing.secretKey, externalActionMachineInstallationId: 'installation',
            managedMachineAction, pluginActionExecutionOwner: 'current_process' });
        const execute = createDaemonSessionAccountActionExecutor({ serverId: configuration.activeServerId, serverHttpBaseUrl: serverUrl, token,
            prepareExternalActionAuthorization: async admission => {
                const { operation, isCallerCurrent, authority: source } = admission;
                const args = { actionId: operation.actionId, input: operation.input,
                    requestId: operation.requestId, target, machineId: controller.machineId, accountId: 'account', accountEncryptionMode: 'plain',
                    tokenEpochHint: 0, token, serverId: configuration.activeServerId, serverIdentityId: 'srv_home',
                    serverHttpBaseUrl: serverUrl, installationId: 'installation', privateKey: signing.secretKey,
                    sessionActionOrigin: SessionActionRpcOriginV1Schema.parse(Reflect.get(admission, 'sessionActionOrigin')),
                    sourceMachineId: 'controller',
                    isCurrent: isCallerCurrent, signal: source.signal } as const;
                const authorization = await prepareExternalActionRequesterAccountAuthorization(args);
                return authorization ? { authorization, target } : null;
            },
            createExecutor: () => ({ execute: (actionId, actionInput, context) => operations.observeExecution({ actionId, input: actionInput,
                actionRequestId: context?.actionRequestId, execute: operationContext => executor.execute(actionId, actionInput, { ...context, ...operationContext }) }) }),
        });
        const result = await execute({ kind: 'action.execute', actionId, requestId: 'session-acquire', input,
            witness: { turnId: 'turn', inputId: 'input', userMessageSeq: 1, userMessageSeqs: [1], workDepth: 2,
                callerPermissionMode: 'yolo', causalPermissionAuthority: null,
                agentStartCaller: { kind: 'session', sessionId: 'lead', starterDepth: 1, turnDepth: 2 } } },
        { sessionId: 'lead', isCurrent: async () => true });
        if (policy === 'foreign-controller') {
            expect(result).toEqual({ ok: false, errorCode: 'approval_origin_unavailable', error: 'approval_origin_unavailable' });
            expect(approvalRequests).toEqual([]);
            expect(requests).not.toContain('/v1/machines/managed/controller/admit');
            return;
        }
        if (policy === 'default-ask' || policy === 'cancel-default-ask') {
            expect(result, JSON.stringify(result)).toEqual({ ok: false, errorCode: 'approval_rejected', error: 'approval_rejected' });
            expect(approvalRequests).toHaveLength(1);
            expect(approvalRequests[0]).toMatchObject({ v: 2, actionId, executionOriginV1: { authority: 'account_automation', surface: 'agent',
                accountId: 'account', caller: sessionActionOrigin.caller,
                sessionInputSource: { sourceSessionId: 'lead', sourceTurnId: 'turn', via: 'action' },
                externalActionExecutionAuthorization: { binding: { sessionActionOrigin } },
                externalActionInputSignature: expect.any(String) } });
            const approval = approvalRequests[0];
            if (approval.v !== 2 || !approval.executionOriginV1.externalActionInputSignature) throw new Error('Missing signed approval origin');
            expect(verifyExternalActionApprovalInputV1({ authorizationToken: 'original-home-proof',
                actionId, input: approval.actionArgs, target,
                publicKey: signing.publicKey, signature: approval.executionOriginV1.externalActionInputSignature })).toBe(true);
            expect(requests).not.toContain('/v1/machines/managed/controller/admit');
            expect(requests).not.toContain('/v1/machines/managed/actions/cancel');
            return;
        }
        expect(result).toEqual({ ok: true, result: { managedId: 'managed', operation: { operationId: 'session-operation' } } });
        expect(await operations.handlers.getV2({ operationId: 'session-operation', waitForTerminal: true }))
            .toMatchObject({ kind: 'found', operation: { state: 'succeeded', domainRef: { kind: 'managedMachine', id: 'managed' } } });
        const predecessorObservation = await operations.handlers.get({ operationId: 'session-operation' });
        expect(predecessorObservation).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
        if (predecessorObservation.kind === 'found') expect(predecessorObservation.operation).not.toHaveProperty('domainRef');
        expect(requests).toContain('/v1/machines/managed/controller/admit');
        expect(requests.some(path => path.endsWith('/submit'))).toBe(false);
    });

    it('uses ordinary exact-Machine availability for a fresh guest instead of the controller receiver', async () => {
        // HTTP is the real remote Machine availability boundary. A missing
        // guest must not be replaced by the locally available controller.
        const readMachine = vi.spyOn(axios, 'get').mockResolvedValue({ status: 404, data: {} });
        const deps = createCliActionDeps({ token: credentials.token, credentials, sessionId: 'lead' });
        const result = await deps.sessionSpawnNew({ creationKey: 'guest-start',
            sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: 'guest-start' }),
            executionTarget: { serverId: configuration.activeServerId, machineId: 'actual-guest' },
            directory: { kind: 'managed' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'coding' } },
            actionCaller: { kind: 'session', sessionId: 'lead' },
        });
        expect(result).toMatchObject({ type: 'error', code: 'incompatible_target' });
        expect(readMachine.mock.calls.map(([url]) => String(url))).toEqual([
            expect.stringContaining('/v1/machines/actual-guest'),
        ]);
    });

    it('re-enters ordinary Session admission with the actual enrolled Machine and retained private input', async () => {
        const selection = { kind: 'one-off' as const, homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false };
        const enrolled = { id: 'managed', homeId: 'srv_home', custodianAccountId: 'account', launch: selection.launch,
            controller: selection.controller, allocation: 'bound', resource: { contributionRef: selection.launch.provider, schemaVersion: 1, value: { id: 'native' } },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            enrolledMachineId: 'actual-guest', retention: selection.retention, wakeOnAcceptedMessage: false };
        const bodies: unknown[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            bodies.push(body);
            return { status: 200, data: String(url).endsWith('/admit') ? { machine: enrolled, replayed: false } : { machine: enrolled } };
        });
        // Ordinary spawn's daemon/network boundary is substituted; schema,
        // permission and Agent-start admission are the real Action executor.
        const started: unknown[] = [];
        const executor = createActionExecutor({ sessionSpawnNew: async (input: Parameters<ActionExecutorDeps['sessionSpawnNew']>[0]) => {
            started.push(input);
            return { type: 'success', disposition: 'created', sessionId: 'session', executionTarget: input.executionTarget,
                organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'accepted', localId: 'message' } };
        } } as unknown as ActionExecutorDeps);
        const start = { creationKey: 'start', directory: { kind: 'managed' as const },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'acme.agent', localId: 'coding' } }, initialInput: { text: 'Private task' } };
        const managedMachineAction = adapter(true, (input, context) => executor.execute('session.spawn_new', input, context));
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account', generateOperationId: () => 'operation' });
        await expect(operations.observeExecution({ actionId: 'machines.managed.acquire', input: { selection, agentStart: start }, actionRequestId: 'request',
            execute: async (context) => ({ ok: true, result: await managedMachineAction({ actionId: 'machines.managed.acquire', input: { selection, agentStart: start },
                context: { ...context, surface: 'agent', authority: 'account_automation', callerPermissionMode: 'yolo',
                    serverId: configuration.activeServerId, runtimeAccountId: 'account', actionCaller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
                    causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'yolo' },
                    defaultSessionId: 'lead', sessionInputSource: { sourceSessionId: 'lead', sourceTurnId: 'turn', via: 'action' },
                    agentStartContext: { caller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
                        baseline: { machineId: 'parent', directory: '/repo', configuration: { agentTarget: start.agentTarget } },
                        roles: {}, ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'yolo' },
                }, signal: context.signal }) }),
        })).resolves.toMatchObject({ ok: true, result: { managedId: 'managed', operation: { operationId: 'operation' } } });
        const terminal = await operations.handlers.get({ operationId: 'operation', waitForTerminal: true });
        if (terminal.kind === 'found') expect(terminal.operation.error).toBeUndefined();
        expect(terminal).toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
        expect(started).toMatchObject([{ executionTarget: { serverId: configuration.activeServerId, machineId: 'actual-guest' },
            actionCaller: { kind: 'session', sessionId: 'lead' }, workDepth: 1, initialInput: start.initialInput }]);
        expect(JSON.stringify(bodies)).not.toContain('Private task');
    });

    it.each(['success', 'error', 'cancel'] as const)('retains a pending guest start and observes %s on the same parent request without buying again', async settlement => {
        const selection = { kind: 'one-off' as const, homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false };
        const enrolled = { id: 'managed', homeId: 'srv_home', custodianAccountId: 'account', launch: selection.launch,
            controller: selection.controller, allocation: 'bound', resource: { contributionRef: selection.launch.provider, schemaVersion: 1, value: { id: 'native' } },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            enrolledMachineId: 'actual-guest', retention: selection.retention, wakeOnAcceptedMessage: false };
        const paths: string[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            paths.push(path);
            return { status: 200, data: path.endsWith('/admit') ? { machine: enrolled, replayed: true } : { machine: enrolled } };
        });
        const childOperations = createHostActionOperationRuntime({ machineId: 'actual-guest', resolveAccountId: async () => 'account',
            generateOperationId: () => 'actual-child-operation' });
        const nativeModes: Array<boolean | undefined> = [];
        // HTTP and native Session creation are the boundaries. Both operation
        // owners, the acquisition driver and ordinary Action admission stay real.
        const spawn = createActionExecutor({ ...createUnavailableActionTransportDeps(),
            sessionSpawnNew: async (input: Parameters<ActionExecutorDeps['sessionSpawnNew']>[0]) => {
            nativeModes.push(input.resumeActionRequest);
            if (!input.resumeActionRequest) return { type: 'pending' as const, retryWithSameCreationKey: true as const, outcome: 'unknown' as const };
            if (settlement === 'error') return { type: 'error' as const, code: 'agent_cli_missing' as const, retryable: false, agentId: 'coding' };
            if (settlement === 'cancel') return { type: 'error' as const, code: 'cancelled' as const, retryable: false };
            return { type: 'success' as const, disposition: 'rejoined' as const, sessionId: 'actual-session', executionTarget: input.executionTarget,
                organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' as const } };
        } });
        const managedMachineAction = adapter(true, (input, context) => childOperations.observeExecution({
            actionId: 'session.spawn_new', input, actionRequestId: 'request', execute: childContext => spawn.execute('session.spawn_new', input,
                { ...context, ...childContext, presentUserConfirmation: { actionId: 'session.spawn_new' } }),
        }));
        const parent = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account',
            generateOperationId: () => 'actual-parent-operation' });
        const input = { selection, agentStart: { directory: { kind: 'managed' as const },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'acme.agent', localId: 'coding' } } } };
        const invoke = async () => {
            let finished!: () => void;
            const completion = new Promise<void>(resolve => { finished = resolve; });
            const response = await parent.observeExecution({ actionId: 'machines.managed.acquire', input, actionRequestId: 'request',
                execute: async context => {
                    try { return { ok: true, result: await managedMachineAction({ actionId: 'machines.managed.acquire', input,
                        context: { ...context, surface: 'cli', authority: 'present_user', serverId: configuration.activeServerId,
                            presentUserConfirmation: { actionId: 'session.spawn_new' } }, signal: context.signal }) }; }
                    finally { finished(); }
                } });
            await completion;
            // Acceptance can precede the runner's terminal/uncertainty update.
            // Let that same invocation relinquish custody before exact replay.
            await new Promise<void>(resolve => setImmediate(resolve));
            return response;
        };
        expect(await invoke()).toMatchObject({ ok: true, result: { managedId: 'managed', operation: { operationId: 'actual-parent-operation' } } });
        expect(await parent.handlers.getV2({ operationId: 'actual-parent-operation' })).toMatchObject({ kind: 'found', operation: {
            state: 'running', domainRef: { kind: 'managedMachine', id: 'managed' },
            observation: { kind: 'outcome_uncertain', code: 'outcome_uncertain' },
        } });
        await invoke();
        const terminal = await parent.handlers.getV2({ operationId: 'actual-parent-operation', waitForTerminal: true });
        expect(terminal).toMatchObject({ kind: 'found', operation: {
            state: settlement === 'success' ? 'succeeded' : settlement === 'cancel' ? 'cancelled' : 'failed',
            ...(settlement === 'error' ? { error: { errorCode: 'agent_cli_missing' } } : {}),
        } });
        if (terminal.kind === 'found') expect(terminal.operation).not.toHaveProperty('observation');
        expect(nativeModes).toEqual([undefined, true]);
        expect(paths.some(path => path.endsWith('/submit'))).toBe(false);
    });

    it.each(['approval', 'invalid'] as const)('does not confirm a guest start from a %s Action result', async outcome => {
        const selection = { kind: 'one-off' as const, homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false };
        const enrolled = { id: 'managed', homeId: 'srv_home', custodianAccountId: 'account', launch: selection.launch,
            controller: selection.controller, allocation: 'bound', resource: { contributionRef: selection.launch.provider, schemaVersion: 1, value: { id: 'native' } },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            enrolledMachineId: 'actual-guest', retention: selection.retention, wakeOnAcceptedMessage: false };
        vi.spyOn(axios, 'post').mockImplementation(async url => ({ status: 200,
            data: String(url).endsWith('/admit') ? { machine: enrolled, replayed: true } : { machine: enrolled } }));
        const { executor: spawn } = createCliActionExecutorHarness({ token: credentials.token, credentials,
            sessionId: '', mode: 'plain', ctx: null }, { ...createUnavailableActionTransportDeps(),
            // Artifact persistence is the boundary, not the approval decision.
            approvalsCreate: async () => ({ artifactId: 'actual-child-approval' }),
        });
        let childResult: ActionExecuteResult | undefined;
        const managedMachineAction = adapter(true, async (input, context) => {
            childResult = outcome === 'approval'
                ? await spawn.execute('session.spawn_new', input, { ...context, actionsSettings: normalizeActionsSettingsV1({ v: 1,
                    actions: { 'session.spawn_new': { approvalRequiredSurfaces: ['cli'] } } }) })
                // This is the malformed external Session Action response boundary.
                : { ok: true, result: { type: 'success' } };
            return childResult;
        });
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account',
            generateOperationId: () => 'operation' });
        const input = { selection, agentStart: { directory: { kind: 'managed' as const },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'acme.agent', localId: 'coding' } } } };
        let finish!: () => void;
        const completion = new Promise<void>(resolve => { finish = resolve; });
        await operations.observeExecution({ actionId: 'machines.managed.acquire', input, actionRequestId: 'request',
            execute: async context => {
                try { return { ok: true, result: await managedMachineAction({ actionId: 'machines.managed.acquire', input,
                    context: { ...context, surface: 'cli', authority: 'present_user', runtimeAccountId: 'account', serverId: configuration.activeServerId },
                    signal: context.signal }) }; }
                finally { finish(); }
            } });
        await completion;
        await new Promise<void>(resolve => setImmediate(resolve));
        if (outcome === 'approval') expect(childResult).toEqual({ ok: true,
            result: { kind: 'approval_request_created', artifactId: 'actual-child-approval', actionId: 'session.spawn_new' } });
        const operation = await operations.handlers.getV2({ operationId: 'operation' });
        expect(operation).toMatchObject({ kind: 'found', operation: outcome === 'approval'
            ? { state: 'running', observation: { kind: 'outcome_uncertain', code: 'approval_pending' } }
            : { state: 'failed', error: { errorCode: 'invalid_action_output' } } });
    });

    it.each(['success', 'error', 'cancel', 'foreign-source-success', 'foreign-source-home-withdrawal'] as const)('keeps the original managed parent pending until the guest records %s through requester-private approval custody', async scenario => {
        const settlement = scenario === 'error' || scenario === 'cancel' ? scenario : 'success';
        const foreignSource = scenario.startsWith('foreign-source');
        const sourceMachineId = foreignSource ? 'original-source' : 'controller';
        const sourceInstallationId = foreignSource ? 'source-installation' : 'installation';
        let requesterHomeCurrent = true;
        const temporary = await mkdtemp(join(tmpdir(), 'c50-requester-approval-'));
        const lifetime = new AbortController();
        let completeNative!: () => void;
        const nativeCompletion = new Promise<void>(resolve => { completeNative = resolve; });
        let nativeEntered!: () => void;
        const nativeEntry = new Promise<void>(resolve => { nativeEntered = resolve; });
        try {
            const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account', tokenEpoch: 0,
                provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
            const sourceCredentials = { token, encryption: null };
            const settings = AccountSettingsSchema.parse({});
            // The genuine captured Account settings publication includes its
            // observed role row. The loader/role resolver remain real; absence
            // of this authority must not be interpreted as empty overrides.
            const promptLibraryCatalog = await loadPromptLibraryCatalogV1({ mode: 'plain', material: null,
                readRows: async () => PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: [{ key: 'role-overrides',
                    revision: 1, content: { t: 'plain', v: { key: 'role-overrides', value: { v: 1, overrides: {} } } } }] }) });
            setActiveAccountSettingsSnapshot({ source: 'network', settings, rawSettings: {}, settingsVersion: 1, loadedAtMs: Date.now(),
                settingsSecretsReadKeys: [], promptLibraryCatalog, scopeKey: resolveAccountSettingsScopeKey(sourceCredentials) });
            const sourceKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
            const controllerKeys = foreignSource ? nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(33)) : sourceKeys;
            const guestKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(32));
            const caller = { kind: 'session' as const, sessionId: 'lead', starterDepth: 1, turnDepth: 2 };
            const cause = { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const };
            const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1, caller, sourceTurnId: 'accepted-turn',
                callerPermissionMode: 'yolo', causalPermissionAuthority: cause, requestId: 'original-acquire' });
            const selection = { kind: 'one-off' as const, homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
                launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
                retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false };
            const enrolled = { id: 'managed', homeId: 'srv_home', custodianAccountId: 'account', launch: selection.launch,
                controller: selection.controller, allocation: 'bound', resource: { contributionRef: selection.launch.provider, schemaVersion: 1, value: { id: 'native' } },
                creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
                enrolledMachineId: 'actual-guest', retention: selection.retention, wakeOnAcceptedMessage: false };
            const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'acme.agent', localId: 'coding' } };
            const input = { selection, agentStart: { directory: { kind: 'path' as const, path: join(temporary, 'new-guest-project') }, agentTarget } };
            type ArtifactWire = { id: string; header: string; body: string; dataEncryptionKey: string;
                headerVersion: number; bodyVersion: number; seq: number; createdAt: number; updatedAt: number; provenance?: unknown };
            let artifact: ArtifactWire | undefined;
            const storedApproval = () => {
                if (!artifact) throw new Error('Guest approval was not persisted');
                const content = decodePlainArtifactStoredContent(artifact.body);
                return StoredApprovalRequestSchema.parse(JSON.parse(String(content && typeof content === 'object' ? Reflect.get(content, 'body') : null)));
            };
            let approvalPending!: () => void;
            const pendingObservation = new Promise<void>(resolve => { approvalPending = resolve; });
            const paths: string[] = [];
            let childExecution: ActionExecuteResult | undefined;
            let childTransportError: string | undefined;
            const sourceExecutor = createCliActionExecutorFromCredentials({ credentials: sourceCredentials,
                serverId: configuration.activeServerId, serverApiUrl: serverUrl, serverIdentityId: 'srv_home', pluginActionExecutionOwner: 'current_process' });
            const guestCurrentness = createDaemonApprovalExecutionOriginCurrentness({ accountId: 'account', machineId: 'actual-guest',
                serverId: configuration.activeServerId,
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_home', machineId: 'actual-guest' }),
                resolveTarget: createDaemonExternalActionTargetResolver({ credentials: sourceCredentials }),
                listAccountApiTokens: async () => AccountApiTokensListActionOutputV1Schema.parse({ tokens: [] }),
                externalActionMachinePublicKey: guestKeys.publicKey,
                verifyExternalExecutionAuthorization: args => verifyExternalActionExecutionAuthorizationCurrent({ ...args,
                    privateKey: guestKeys.secretKey, installationId: 'guest-installation', serverHttpBaseUrl: serverUrl }),
                isSessionCallerCurrent: async () => false,
                resolveCurrentPermissionMode: async () => 'yolo',
                resolveCurrentSessionAgentSpawnPolicyV1: async () => settings.sessionAgentSpawnPolicyV1,
            });
            const guest = createCliActionExecutorHarness({ token, credentials: sourceCredentials, sessionId: 'lead',
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl, mode: 'plain', ctx: null,
                getCurrentSessionMetadata: () => ({ machineId: sourceMachineId, path: temporary, flavor: 'claude', permissionMode: 'yolo' }),
                getCurrentSessionWorkDepth: () => caller.starterDepth,
                rawSession: { machineId: sourceMachineId, path: temporary },
                sessionSpawnDirectTargetTransport: { machineId: 'actual-guest', prepare: async (request, options) =>
                    prepareSessionCreationTarget({ request, signal: options?.signal }),
                    spawnedSession: { spawn: unavailable, resolveSpawnSessionByNonce: unavailable } },
            }, { isApprovalExecutionOriginCurrent: guestCurrentness,
                // Native Agent process creation is the only Session-start substitution.
                sessionSpawnNew: async request => {
                    const observed = { executionTarget: request.executionTarget, actionCaller: request.actionCaller, workDepth: request.workDepth,
                        sessionCreationDirectoryApproval: request.sessionCreationDirectoryApproval };
                    expect(observed, JSON.stringify(observed)).toMatchObject({ executionTarget: { serverId: 'srv_home', machineId: 'actual-guest' }, actionCaller: { kind: 'session', sessionId: caller.sessionId }, workDepth: 3,
                        sessionCreationDirectoryApproval: { v: 1, executionTarget: { serverId: 'srv_home', machineId: 'actual-guest' },
                            directory: input.agentStart.directory.path } });
                    nativeEntered();
                    await nativeCompletion;
                    if (settlement !== 'success') return { type: 'error', code: settlement === 'cancel' ? 'cancelled' : 'spawn_failed', retryable: false };
                    return { type: 'success', disposition: 'created', sessionId: 'actual-session', executionTarget: request.executionTarget,
                        organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
                },
            });
            vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return { status: 200,
                    data: AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 1 }) };
                if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
                    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                if (path === '/v1/account/entity-rows/acp') return { status: 200,
                    data: AcpCatalogRowReadResponseV1Schema.parse({ status: 'present', revision: 1,
                        content: { t: 'plain', v: { v: 1, definitions: [] } } }) };
                if (path === '/v1/artifacts') return { status: 200, data: [] };
                if (path.startsWith('/v1/artifacts/')) {
                    expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
                    return { status: artifact && path === `/v1/artifacts/${artifact.id}` ? 200 : 404,
                        data: artifact ? { ...artifact, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain', publicAudience: 'none' } : {} };
                }
                if (path.startsWith('/v1/sessions/')) return { status: 200, data: { session: createSessionRecordFixture({ id: caller.sessionId,
                    encryptionMode: 'plain', share: null, metadata: JSON.stringify({ machineId: sourceMachineId, path: temporary, flavor: 'claude', permissionMode: 'yolo' }) }) } };
                throw new Error(`Unexpected requester-private GET ${path}`);
            });
            vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
                const path = new URL(String(url)).pathname;
                paths.push(path);
                if (path.endsWith('/verify')) return { status: 200, data: { ok: true } };
                if (path === '/v1/actions/machines.managed.acquire/execution-authorization') {
                    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                    return { status: 200, data: { v: 1, token: 'root-proof', binding: { serverIdentityId: 'srv_home', accountId: 'account',
                        custodianAccountId: 'account', machineId: 'controller', installationId: 'installation', authentication: { kind: 'account', tokenEpoch: 0 },
                        accountEncryptionMode: 'plain', actionId: 'machines.managed.acquire', requestId: sessionActionOrigin.requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope), target: { kind: 'machine', machineId: 'controller' },
                        sessionActionOrigin, sessionActionSource: { machineId: sourceMachineId, installationId: sourceInstallationId } } } };
                }
                if (path.endsWith('/admit')) return { status: 200, data: { machine: enrolled, replayed: true } };
                if (path === '/v1/machines/managed/controller/current') return { status: 200, data: { machine: enrolled } };
                if (path === '/v1/actions/session.spawn_new') {
                    try {
                        const request = ChildRequestSchema.parse(body);
                        if (request.envelope.v !== 1 || !request.managedContinuation) throw new Error('Expected a Plain managed child wrapper');
                        const root = original!.binding;
                        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'child-proof', binding: {
                            ...root, machineId: 'actual-guest', installationId: 'guest-installation', actionId: 'session.spawn_new', target: request.envelope.target,
                            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
                            managedContinuation: { ...request.managedContinuation, controller: selection.controller, acquireRequestEnvelopeDigest: root.requestEnvelopeDigest },
                        } });
                        const childInput = SessionSpawnNewInputV2Schema.parse(request.envelope.input);
                        const childContext: ActionExecutorContext = { surface: 'agent', authority: 'account_automation',
                            actionCaller: caller, defaultSessionId: caller.sessionId, runtimeAccountId: 'account', actionRequestId: request.envelope.requestId,
                            externalActionTarget: request.envelope.target, externalActionExecutionAuthorization: authorization,
                            sessionInputSource: { sourceSessionId: caller.sessionId, sourceTurnId: sessionActionOrigin.sourceTurnId, via: 'action' },
                            callerPermissionMode: 'yolo', causalPermissionAuthority: cause, sessionAgentSpawnPolicyV1: settings.sessionAgentSpawnPolicyV1,
                            signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ authorizationToken: authorization.token,
                                ...args, privateKey: guestKeys.secretKey }), signal: lifetime.signal };
                        expect(await guest.deps.resolveAgentStartContext?.(childContext), 'The credentialed guest must observe the real source context before approval').not.toBeNull();
                        const execution = childExecution = await guest.executor.execute('session.spawn_new', childInput, childContext);
                        expect(execution).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId: 'session.spawn_new' } });
                        return { status: 200, data: { v: 1, actionId: 'session.spawn_new', requestId: request.envelope.requestId, execution } };
                    } catch (error) {
                        childTransportError = error instanceof Error ? error.stack ?? error.message : String(error);
                        throw error;
                    }
                }
                if (path === '/v1/artifacts' || path.startsWith('/v1/artifacts/')) {
                    expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
                    // Persistent HTTP is the boundary; parsing, CAS transitions,
                    // signatures and the approval coordinator remain production owners.
                    const record = body as { id?: string; header: string; body: string; dataEncryptionKey?: string;
                        expectedHeaderVersion?: number; expectedBodyVersion?: number; provenance?: unknown };
                    if (path === '/v1/artifacts') {
                        if (!record.id || !record.dataEncryptionKey) throw new Error('Missing canonical Artifact create fields');
                        artifact = { id: record.id, header: record.header, body: record.body, dataEncryptionKey: record.dataEncryptionKey,
                            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, provenance: record.provenance };
                        return { status: 200, data: { id: record.id, headerVersion: 1, bodyVersion: 1 } };
                    }
                    if (!artifact) throw new Error('No persisted Artifact to update');
                    expect(record.expectedHeaderVersion).toBe(artifact.headerVersion);
                    expect(record.expectedBodyVersion).toBe(artifact.bodyVersion);
                    artifact = { ...artifact, header: record.header, body: record.body, provenance: record.provenance,
                        headerVersion: artifact.headerVersion + 1, bodyVersion: artifact.bodyVersion + 1, seq: artifact.seq + 1, updatedAt: artifact.updatedAt + 1 };
                    return { status: 200, data: { success: true, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } };
                }
                throw new Error(`Unexpected requester-private POST ${path}`);
            });
            // Agent inventory requires observed configured-catalog authority,
            // including an empty catalog. Hydrate through its real HTTP owner.
            expect(await refreshActiveAcpCatalog({ credentials: sourceCredentials })).toMatchObject({ status: 'ready' });
            const preparedOriginal = await prepareExternalActionRequesterAccountAuthorization({ actionId: 'machines.managed.acquire', input,
                requestId: sessionActionOrigin.requestId, target: { kind: 'machine', machineId: 'controller' }, machineId: 'controller', accountId: 'account',
                accountEncryptionMode: 'plain', tokenEpochHint: 0, token, serverId: configuration.activeServerId, serverIdentityId: 'srv_home',
                serverHttpBaseUrl: serverUrl, installationId: sourceInstallationId, privateKey: sourceKeys.secretKey, sessionActionOrigin,
                sourceMachineId, isCurrent: async () => !lifetime.signal.aborted });
            expect(preparedOriginal).not.toBeNull();
            const original = foreignSource ? await projectExternalActionRequesterHttpAuthorization({ authorization: preparedOriginal!,
                serverId: configuration.activeServerId, serverIdentityId: 'srv_home', serverHttpBaseUrl: serverUrl,
                target: { kind: 'machine', machineId: 'controller' }, installationId: 'installation', privateKey: controllerKeys.secretKey,
                isCurrent: async () => requesterHomeCurrent && !lifetime.signal.aborted }) : preparedOriginal;
            expect(original).not.toBeNull();
            const managed = adapter(true, (spawnInput, context, machine) => dispatchManagedSessionStart({ authorization: original!, input: spawnInput,
                continuation: { managedId: machine.id, creationRequestId: sessionActionOrigin.requestId, expectedIntentRevision: machine.intentRevision },
                serverId: configuration.activeServerId, serverHttpBaseUrl: serverUrl, installationId: 'installation', privateKey: controllerKeys.secretKey,
                signal: context.signal }), async context => Boolean(context.externalActionExecutionAuthorization?.requesterHttpProjection),
                controllerKeys.secretKey, sourceCredentials, createManagedSessionStartApprovalObserver({ credentials: sourceCredentials,
                    machineId: 'controller', observeRecordedApprovalExecution: args => sourceExecutor.observeRecordedApprovalExecution(args) }));
            let parentSettled!: () => void;
            const parentSettlement = new Promise<void>(resolve => { parentSettled = resolve; });
            const parent = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account',
                generateOperationId: () => 'original-parent', publishSnapshot: snapshot => {
                    if (snapshot.observation?.code === 'approval_pending') approvalPending();
                    if (snapshot.state === 'succeeded' || snapshot.state === 'failed' || snapshot.state === 'cancelled') parentSettled();
                } });
            const accepted = await parent.observeExecution({ actionId: 'machines.managed.acquire', input, actionRequestId: sessionActionOrigin.requestId,
                execute: async context => ({ ok: true, result: await managed({ actionId: 'machines.managed.acquire', input, signal: context.signal,
                    context: { ...context, actionCaller: caller, surface: 'agent', authority: 'account_automation', runtimeAccountId: 'account',
                        defaultSessionId: caller.sessionId, serverId: configuration.activeServerId, externalActionTarget: { kind: 'machine', machineId: 'controller' },
                        externalActionExecutionAuthorization: original! } }) }) });
            expect(accepted).toMatchObject({ ok: true, result: { managedId: 'managed', operation: { operationId: 'original-parent' } } });
            await Promise.race([pendingObservation, parent.handlers.getV2({ operationId: 'original-parent', waitForTerminal: true })
                .then(result => { throw new Error(`Parent settled before observing guest approval: ${JSON.stringify({ result, childExecution, childTransportError })}`); })]);
            const approval = storedApproval();
            expect(approval).toMatchObject({ status: 'open', approval: { flow: 'deferred' }, actionId: 'session.spawn_new',
                sessionCreationDirectoryApproval: { executionTarget: { serverId: 'srv_home', machineId: 'actual-guest' },
                    directory: input.agentStart.directory.path } });
            const decision = guest.executor.execute('approval.request.decide', { artifactId: artifact!.id, decision: 'approve' },
                { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, runtimeAccountId: 'account', signal: lifetime.signal });
            await Promise.race([nativeEntry, decision.then(result => { throw new Error(`Guest replay did not reach native creation: ${JSON.stringify(result)}`); })]);
            expect(storedApproval()).toMatchObject({ status: 'executing' });
            expect(await parent.handlers.getV2({ operationId: 'original-parent' })).toMatchObject({ kind: 'found', operation: {
                state: 'running', domainRef: { kind: 'managedMachine', id: 'managed' }, observation: { code: 'approval_pending' } } });
            if (scenario === 'foreign-source-home-withdrawal') requesterHomeCurrent = false;
            completeNative();
            expect(await decision).toMatchObject({ ok: true });
            for (const socket of approvalWire.sockets) socket.wake();
            // Public waits may return an unresolved approval observation. The
            // existing publication boundary tells us when this parent settles.
            await parentSettlement;
            expect(await parent.handlers.getV2({ operationId: 'original-parent' })).toMatchObject({ kind: 'found', operation: {
                state: scenario === 'foreign-source-home-withdrawal' ? 'failed' : settlement === 'success' ? 'succeeded' : settlement === 'cancel' ? 'cancelled' : 'failed',
                ...(scenario === 'foreign-source-home-withdrawal' ? { error: { errorCode: 'approval_stale' } }
                    : settlement === 'error' ? { error: { errorCode: 'spawn_failed' } } : {}),
                domainRef: { kind: 'managedMachine', id: 'managed' } } });
            const terminal = await parent.handlers.getV2({ operationId: 'original-parent' });
            if (terminal.kind === 'found') expect(terminal.operation).not.toHaveProperty('observation');
            expect(storedApproval()).toMatchObject(settlement === 'success'
                ? { status: 'executed', execution: { ok: true, result: { type: 'success', sessionId: 'actual-session' } } }
                : { status: 'executed', execution: { ok: true, result: { type: 'error',
                    code: settlement === 'cancel' ? 'cancelled' : 'spawn_failed', retryable: false } } });
            expect(paths.some(path => path.endsWith('/submit'))).toBe(false);
        } finally {
            lifetime.abort();
            completeNative();
            await rm(temporary, { recursive: true, force: true });
        }
    });

    it('refuses an unavailable managed-operation authority before admitting any compute', async () => {
        const post = vi.spyOn(axios, 'post');
        await expect(adapter(false)({ actionId: 'machines.provisioners.list', input: { homeId: 'srv_home' },
            context: { actionRequestId: 'request' } })).rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(post).not.toHaveBeenCalled();
    });

    it('refuses a known continuation without its operation observation owner before admitting compute', async () => {
        const post = vi.spyOn(axios, 'post');
        const spawn = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials, sessionId: '' }));
        await expect(adapter(true, (input, context) => spawn.execute('session.spawn_new', input, context))({
            actionId: 'machines.managed.acquire', input: {
                selection: { kind: 'one-off', homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
                    launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
                agentStart: { directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'coding' } } },
            }, context: { actionRequestId: 'request', surface: 'cli', authority: 'present_user' },
        })).rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(post).not.toHaveBeenCalled();
    });

    it('projects a real ordinary Session-start domain refusal into the retained managed operation', async () => {
        const selection = { kind: 'one-off' as const, homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false };
        const enrolled = { id: 'managed', homeId: 'srv_home', custodianAccountId: 'account', launch: selection.launch,
            controller: selection.controller, allocation: 'bound', resource: { contributionRef: selection.launch.provider, schemaVersion: 1, value: { id: 'native' } },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            enrolledMachineId: 'actual-guest', retention: selection.retention, wakeOnAcceptedMessage: false };
        vi.spyOn(axios, 'post').mockImplementation(async url => ({ status: 200,
            data: String(url).endsWith('/admit') ? { machine: enrolled, replayed: false } : { machine: enrolled } }));
        // Session start is a real Action executor; only its native start
        // boundary returns the canonical Agent setup refusal.
        const spawn = createActionExecutor({ sessionSpawnNew: async () => ({
            type: 'error', code: 'agent_cli_missing', retryable: false, agentId: 'coding',
        }) } as unknown as ActionExecutorDeps);
        const managedMachineAction = adapter(true, (input, context) => spawn.execute('session.spawn_new', input, context));
        const input = { selection, agentStart: { directory: { kind: 'managed' as const },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'acme.agent', localId: 'coding' } } } };
        const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account', generateOperationId: () => 'operation' });
        await operations.observeExecution({ actionId: 'machines.managed.acquire', input, actionRequestId: 'request',
            execute: async context => ({ ok: true, result: await managedMachineAction({ actionId: 'machines.managed.acquire', input,
                context: { ...context, surface: 'cli', authority: 'present_user', serverId: configuration.activeServerId,
                    presentUserConfirmation: { actionId: 'session.spawn_new' } }, signal: context.signal }) }) });
        expect(await operations.handlers.getV2({ operationId: 'operation', waitForTerminal: true })).toMatchObject({ kind: 'found', operation: {
            state: 'failed', domainRef: { kind: 'managedMachine', id: 'managed' }, error: { errorCode: 'agent_cli_missing' },
        } });
    });

    it('binds the credentialed factory to the observed Home and refuses a changed profile', async () => {
        const managedMachineAction = adapter();
        const executor = createCliActionExecutorFromCredentials({ credentials,
            serverId: configuration.activeServerId, serverApiUrl: serverUrl,
            managedMachineAction, pluginActionExecutionOwner: 'current_process',
            actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1, actions: {} }) },
        });
        expect(await executor.execute('machines.provisioners.list', { homeId: 'srv_home' },
            { surface: 'cli', actionRequestId: 'request' })).toEqual({ ok: true, result: { controller: { machineId: 'controller', installationId: 'installation' }, provisioners: [] } });
        await storeHome('srv_different_home');
        await expect(managedMachineAction({ actionId: 'machines.provisioners.list', input: { homeId: 'srv_home' },
            context: { actionRequestId: 'request' } })).rejects.toMatchObject({ code: 'controller_unavailable' });
    });
    it('refuses a continuation whose original external credential cannot authorize a new enrolled Machine', async () => {
        const post = vi.spyOn(axios, 'post');
        await expect(adapter()({ actionId: 'machines.managed.acquire', input: {
            selection: { kind: 'one-off', homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
                launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            agentStart: { directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'coding' } } },
        }, context: { actionRequestId: 'request', externalActionCredential: {
            principalId: 'principal', credentialId: 'token-id', accountId: 'account', grant: API_TOKEN_FULL_GRANT_V1,
        } } })).rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(post).not.toHaveBeenCalled();
    });

    it('checks genuine signed continuation availability before admitting compute', async () => {
        const post = vi.spyOn(axios, 'post');
        const managedMachineAction = adapter(true, async () => ({ ok: true, result: {} }));
        await expect(managedMachineAction({ actionId: 'machines.managed.acquire', input: {
            selection: { kind: 'one-off', homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
                launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            agentStart: { directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'coding' } } },
        }, context: { actionRequestId: 'request', externalActionExecutionAuthorization: { v: 1, token: 'signed-root', binding: {
            serverIdentityId: 'srv_home', accountId: 'account', custodianAccountId: 'account',
            authentication: { kind: 'account', tokenEpoch: 0 }, machineId: 'controller', installationId: 'installation',
            actionId: 'machines.managed.acquire', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
            target: { kind: 'machine', machineId: 'controller' }, accountEncryptionMode: 'e2ee',
        } } } })).rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(post).not.toHaveBeenCalled();
    });

    it('does not erase a real Session-origin continuation on the public guest hop before compute', async () => {
        const post = vi.spyOn(axios, 'post');
        // Real credential-material availability is read by the production
        // transport owner; it is not a replacement for Session-origin proof.
        const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(9) };
        const managedMachineAction = adapter(true, async () => ({ ok: true, result: {} }), async context => {
            const { isManagedSessionStartTransportAvailable } = await import('@/api/externalActionExecutionAuthorization');
            return isManagedSessionStartTransportAvailable({ authorization: context.externalActionExecutionAuthorization,
                installationId: 'installation', material });
        });
        await expect(managedMachineAction({ actionId: 'machines.managed.acquire', input: {
            selection: { kind: 'one-off', homeId: 'srv_home', controller: { machineId: 'controller', installationId: 'installation' },
                launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} },
                retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            agentStart: { directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'coding' } } },
        }, context: { actionRequestId: 'request', actionCaller: { kind: 'session', sessionId: 'lead', starterDepth: 0, turnDepth: 0 },
            agentStartWorkDepth: 1, agentStartWorkspaceWrites: 'deny', externalActionExecutionAuthorization: {
                v: 1, token: 'signed-root', binding: { serverIdentityId: 'srv_home', accountId: 'account', custodianAccountId: 'account',
                    authentication: { kind: 'account', tokenEpoch: 0 }, machineId: 'controller', installationId: 'installation',
                    actionId: 'machines.managed.acquire', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
                    target: { kind: 'machine', machineId: 'controller' }, accountEncryptionMode: 'e2ee' },
            },
        } })).rejects.toMatchObject({ code: 'admission_unavailable' });
        expect(post).not.toHaveBeenCalled();
    });
});
