import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { definePlugin, PluginError } from '@happier-dev/plugin-sdk';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

import { DaemonPluginStructuredMessageActionExecuteResponseSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { RpcHandler } from '@/api/rpc/types';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedActionContribution } from '@/plugins/projection/registry/types';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createTargetActionInvocationRegistry } from '@/plugins/runtime/invocation/targetActionRegistry';
import { createTargetActionHostBindingResolver } from '@/plugins/runtime/hostAccess/resolve';
import { createUnavailablePluginServicesFactory } from '@/plugins/runtime/invocation/services/factory';
import * as persistence from '@/persistence';
import * as socketEvents from '@/session/transport/socket/sessionSocketAgentState';
import { registerDaemonContributionRegistryProjectionHandler } from './daemonContributionRegistryProjection';
import { createDaemonExternalActionContributedApprovalReplay } from '@/daemon/externalActions/createDaemonExternalActionContributedInvoker';
import { ApiMachineClient } from '@/api/apiMachine';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import * as runtimeLease from '@/plugins/runtime/reload/runtimeLease';
import * as installationIdentity from '@/daemon/identity/store';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { bindApiSessionSocketMock, createApiSessionSocketStub } from '@/testkit/backends/apiSessionSocketHarness';

const sockets = vi.hoisted(() => ({ io: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: sockets.io }));

beforeEach(() => { bindApiSessionSocketMock(sockets.io, createApiSessionSocketStub()); });
afterEach(() => vi.restoreAllMocks());

describe('plugin Action current intent through the registered daemon ingress', () => {
    it('admits Environment scope on the receiving daemon before requesting and consuming UI confirmation', async () => {
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null };
        const serverId = configuration.activeServerId;
        const homeUrl = resolveServerHttpBaseUrl();
        const template = createDeploymentEnvironmentHeaderV1({ serverId });
        const environment = createDeploymentEnvironmentHeaderV1({ serverId, id: 'preview-child', purpose: 'preview',
            previewTemplateEnvironmentId: template.id, previewRepositoryId: 'source-app',
            previewPullRequestId: 'pr-42', previewTargetLinkId: 'template-link' });
        const effects: unknown[] = [];
        vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(null);
        const plugin = definePlugin({ id: 'acme.rpc-environment-scope', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            actions: { publish: { title: 'Publish preview', scopes: ['global'], surfaces: ['ui'],
                dangerLevel: 'writesRemote', approvalScope: 'environment', confirmation: { title: 'Publish preview status?' },
                inputSchema: { type: 'object', properties: { serverId: { type: 'string' }, environmentId: { type: 'string' } },
                    required: ['serverId', 'environmentId'], additionalProperties: false },
                resultSchema: { type: 'object', properties: { published: { type: 'boolean' } }, required: ['published'], additionalProperties: false },
                run: async input => { effects.push(input); return { published: true }; },
            } },
        });
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: plugin.manifest,
            files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: plugin.activate }) }],
            resolveContributes: async happyHomeDir => createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })),
            runtimeOptions: { deploymentAccountExecution: { credentials, serverUrl: homeUrl, serverId,
                    serverIdentityId: serverId, machineId: 'machine-1', isCurrent: async () => true },
                resolveCurrentMachineId: () => 'machine-1',
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: serverId, machineId: 'machine-1' }) },
        });
        vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockResolvedValue(credentials);
        vi.spyOn(installationIdentity, 'readInstallationIdentityIfExistsSync').mockReturnValue({
            version: 1, installationId: 'scope-installation', createdAt: 1, publicKey: '', privateKey: '',
        });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'account-1' } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            throw new Error(`Unexpected Account read: ${path}`);
        });
        vi.spyOn(runtimeLease, 'acquireAuthoritativePluginRuntimeRegistryLease').mockImplementation(async () => ({
            registry: fixture.registry, source: 'ephemeral', durableRevision: -1, release: async () => {},
        }));
        // Home HTTP is the boundary; the receiving registry and scope resolver remain real.
        const reads = vi.spyOn(axios, 'request').mockImplementation(async request => {
            expect(new URL(request.url!).origin).toBe(new URL(homeUrl).origin);
            expect(new URL(request.url!).pathname).toBe(`/v1/deployments/environments/${environment.id}`);
            expect(request.headers?.Authorization).toBe(`Bearer ${token}`);
            return { status: 200, data: { ok: true, environment, targetLinks: [] } };
        });
        const client = new ApiMachineClient(token, { id: 'machine-1', encryptionMode: 'plain', metadata: null,
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
        const manager: unknown = Reflect.get(client, 'rpcHandlerManager');
        if (!(manager instanceof RpcHandlerManager)) throw new Error('missing_machine_rpc_owner');
        const request = { machineId: 'machine-1', expectedContributorOccurrenceId: fixture.registry.readPluginOccurrenceId?.(plugin.manifest.id),
            qualifiedActionId: `${plugin.manifest.id}/publish`, input: { serverId, environmentId: environment.id }, executionSurface: 'ui' };
        try {
            expect(await manager.invokeLocal(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE, request))
                .toMatchObject({ ok: false, code: 'plugin_action_current_intent_unavailable', actionHandlerInvocation: 'notStarted' });
            expect(effects).toEqual([]);
            expect(reads).toHaveBeenCalledTimes(1);
            expect(await manager.invokeLocal(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
                { ...request, presentUserIntent: 'confirmed' })).toMatchObject({ ok: true, result: { published: true } });
            expect(effects).toEqual([request.input]);
            expect(reads).toHaveBeenCalledTimes(2);
        } finally { await client.shutdown(); await fixture.dispose(); }
    });
    it('creates approval with the production machine Account binding and admitted plugin policy producer', async () => {
        const unavailableReasons: unknown[] = [];
        const requests: string[] = [];
        vi.spyOn(logger, 'debug').mockImplementation((message, data) => {
            if (message === '[RPC] Target Action current intent unavailable') unavailableReasons.push(data);
        });
        const pluginId = 'acme.production-intent';
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
            plugins: [{ manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: { actions: [{
                id: 'apply', title: 'Apply', scopes: ['global'], surfaces: ['agent', 'cli', 'mcp'],
                dangerLevel: 'writesLocal', confirmation: { title: 'Apply change?' },
                execution: { target: 'daemon' }, inputSchema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'], additionalProperties: false },
                resultSchema: { type: 'object', properties: { applied: { type: 'boolean' } }, required: ['applied'], additionalProperties: false },
            }] } }), files: { 'daemon.mjs': "export function activate(api) { api.actions.register('apply', input => ({ applied: input.enabled })); }" } }],
            runtimeOptions: { resolveCurrentMachineId: () => 'machine-1',
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_production_intent', machineId: 'machine-1' }) },
        });
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`;
        vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockResolvedValue({ token, encryption: null });
        vi.spyOn(installationIdentity, 'readInstallationIdentityIfExistsSync').mockReturnValue({
            version: 1, installationId: 'approval-installation', createdAt: 1, publicKey: '', privateKey: '',
        });
        vi.spyOn(runtimeLease, 'acquireAuthoritativePluginRuntimeRegistryLease').mockImplementation(async () => ({
            registry: fixture.registry, source: 'ephemeral', durableRevision: -1, release: async () => {},
        }));
        const stored: TargetActionApprovalRequestV1[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            requests.push(path);
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'account-1' } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            throw new Error(`Unexpected approval read: ${path}`);
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, input) => {
            requests.push(new URL(String(url)).pathname);
            expect(String(url)).toMatch(/\/v1\/artifacts$/u);
            const envelope = decodePlainArtifactStoredContent(input.body);
            if (!envelope || typeof envelope !== 'object' || !('body' in envelope) || typeof envelope.body !== 'string') throw new Error('invalid_approval_body');
            stored.push(TargetActionApprovalRequestV1Schema.parse(JSON.parse(envelope.body)));
            return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
        });
        const client = new ApiMachineClient(token, { id: 'machine-1', encryptionMode: 'plain', metadata: null,
            metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
        const manager: unknown = Reflect.get(client, 'rpcHandlerManager');
        if (!(manager instanceof RpcHandlerManager)) throw new Error('missing_machine_rpc_owner');
        try {
            expect(await fixture.registry.resolveCurrentPluginApprovalReplayPlacement?.(pluginId)).toEqual({
                serverId: configuration.activeServerId, machineId: 'machine-1',
            });
            const result = await manager.invokeLocal(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE, {
                machineId: 'machine-1', expectedContributorOccurrenceId: fixture.registry.readPluginOccurrenceId?.(pluginId),
                qualifiedActionId: `${pluginId}/apply`, input: { enabled: false }, executionSurface: 'cli',
            });
            expect(result, JSON.stringify({ result, unavailableReasons, requests })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: expect.any(String) } });
            expect(stored).toHaveLength(1);
            expect(stored[0]).toMatchObject({ input: { enabled: false }, requestedSurface: 'cli',
                replayPlacement: { serverId: configuration.activeServerId, machineId: 'machine-1' } });
        } finally { await client.shutdown(); await fixture.dispose(); }
    });
    it.each([
        { executionSurface: 'ui', tracked: false },
        { executionSurface: 'cli', tracked: false },
        { executionSurface: 'agent', tracked: false },
        { executionSurface: 'mcp', tracked: false },
        { executionSurface: 'cli', tracked: true },
    ] as const)('asks for $executionSurface approval before the external plugin handler and honors rejection (tracked $tracked)', async ({ executionSurface, tracked }) => {
        const unavailableReasons: unknown[] = [];
        vi.spyOn(logger, 'debug').mockImplementation((message, data) => {
            if (message === '[RPC] Target Action current intent unavailable') unavailableReasons.push(data);
        });
        const confidential = executionSurface === 'agent';
        const pluginId = 'acme.current-intent';
        const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'intent-root' };
        const confirmation = { title: 'Apply this change?' };
        const inputSchema = { type: 'object', properties: { value: { type: 'string' }, releaseTag: { type: 'string' }, requestId: { type: 'string' } }, required: ['value', 'releaseTag', 'requestId'], additionalProperties: false };
        const resultSchema = { type: 'object', properties: { applied: { type: 'string' } }, required: ['applied'], additionalProperties: false };
        let applied: unknown;
        let decision: 'approve' | 'reject' = 'approve';
        let stored: TargetActionApprovalRequestV1 | null = null;
        let nextRequestId = 0;
        let artifactId = '';
        const action = { provenance: 'external', source: { kind: 'path' }, pluginId,
            definition: { kindVersion: 1, id: 'apply', title: 'Apply', description: null, safety: 'safe', dangerLevel: 'writesLocal', confirmation,
                execution: { target: 'daemon' }, scopes: ['global'], placements: [], slash: null, bindings: null, examples: null,
                ...(tracked ? { operation: { version: 1 as const, visibility: 'activity' as const, progress: 'reported' as const, presentation: { onStart: 'detail' as const } } } : {}),
                surfaces: { ui: true, agent: true, mcp: true, cli: true, voice: false, rpc: false, api: false, plugin: false },
                inputHints: null, inputSchema, outputSchema: resultSchema, contributionSurfaces: ['ui'], placementBindings: [] },
        } satisfies ResolvedActionContribution;
        const contributes = createResolvedContributionRegistry({ agents: [], actions: [action], occurrenceIdsByPluginId: { [pluginId]: occurrenceId } });
        const targetActionInvocations = createTargetActionInvocationRegistry({
            actions: [{ pluginId, pluginVersion: '1.0.0', occurrenceId, sourceCustody, localId: 'apply',
                definition: { id: 'apply', dangerLevel: 'writesLocal', confirmation, scopes: ['global'], surfaces: ['ui', 'agent', 'mcp', 'cli'], inputSchema, resultSchema,
                    ...(confidential ? { secretInputPaths: ['releaseTag'], secretInputLabels: { releaseTag: 'Release credential' } } : {}) },
                inputParser: input => ({ success: true, data: {
                    value: `${String(Reflect.get(input as object, 'value'))}-normalized`,
                    releaseTag: Reflect.get(input as object, 'releaseTag') ?? 'v1.2.3-public-release',
                    requestId: Reflect.get(input as object, 'requestId') ?? `request-${++nextRequestId}`,
                } }),
                handler: async input => {
                    if (Reflect.get(input as object, 'value') === 'blocked-normalized') {
                        throw new PluginError({ code: 'integration_account_needs_reauth',
                            message: 'Reconnect the integration account before continuing. Authorization: Bearer token-secret-must-not-cross /home/private/operator/credential.json' });
                    }
                    applied = input;
                    return { applied: String(Reflect.get(input as object, 'value')) };
                } }],
            resolveAuthorizationFacts: target => ({ generation: { targetGeneration: target.occurrenceId,
                desiredGeneration: target.occurrenceId, appliedGeneration: target.occurrenceId },
                resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [] }),
            createServices: createUnavailablePluginServicesFactory(), resolveHostBinding: createTargetActionHostBindingResolver(),
            readCurrentPluginOccurrenceId: id => id === pluginId ? occurrenceId : null,
        });
        // Filesystem package loading/registry leases are the boundary; registration, policy, approval and plugin dispatch stay real.
        const registry = { contributes, targetActionInvocations, generation: 7,
            resolveCurrentPluginApprovalReplayPlacement: async () => ({ serverId: 'server-1', machineId: 'machine-1' }),
            readPluginOccurrenceId: (id: string) => id === pluginId ? occurrenceId : null,
            readPluginSourceCustody: (id: string) => id === pluginId ? sourceCustody : null,
            isPluginOccurrenceCurrent: (id: string, candidate: string) => id === pluginId && candidate === occurrenceId,
        } as unknown as ResolvedExecutablePluginRuntimeRegistry;
        // Only credential files, HTTP persistence and socket transport are replaced.
        // The production credentialed approval factory, Artifact codecs and strict reader stay real.
        const rows = new Map<string, Record<string, unknown>>();
        const token = `e30.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`;
        vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue({ token, encryption: null });
        vi.spyOn(persistence, 'readStoredCredentialsForServerId').mockResolvedValue({ token, encryption: null });
        vi.spyOn(installationIdentity, 'readInstallationIdentityIfExistsSync').mockReturnValue({
            version: 1, installationId: 'approval-installation', createdAt: 1, publicKey: '', privateKey: '',
        });
        vi.spyOn(runtimeLease, 'acquireAuthoritativePluginRuntimeRegistryLease').mockImplementation(async () => ({
            registry, source: 'ephemeral', durableRevision: -1, release: async () => {},
        }));
        vi.spyOn(socketEvents, 'observeSessionSocketEvents').mockReturnValue({ dispose: async () => {} });
        vi.spyOn(axios, 'post').mockImplementation(async (url, input) => {
            if (!url.endsWith('/v1/artifacts') || !input || typeof input !== 'object'
                || typeof input.id !== 'string' || typeof input.body !== 'string') throw new Error('unexpected_artifact_create');
            const envelope = decodePlainArtifactStoredContent(input.body);
            if (!envelope || typeof envelope !== 'object' || !('body' in envelope) || typeof envelope.body !== 'string') throw new Error('invalid_approval_body');
            expect(applied).toBeUndefined();
            stored = TargetActionApprovalRequestV1Schema.parse(JSON.parse(envelope.body));
            artifactId = input.id;
            rows.set(input.id, { ...input, ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
                publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
        });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'account-1' } };
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            const row = rows.get(url.split('/').at(-1)!);
            if (!row || !stored) throw new Error('unexpected_artifact_read');
            const decided = TargetActionApprovalRequestV1Schema.parse({ ...stored,
                status: decision === 'approve' ? 'approved' : 'rejected',
                decision: { kind: decision, decidedAtMs: Date.now() } });
            return { status: 200, data: { ...row,
                header: encodePlainArtifactStoredContent(buildTargetActionApprovalArtifactHeaderV1(decided)),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(decided) }) } };
        });
        let client: ApiMachineClient | undefined;
        try {
            client = new ApiMachineClient(token, {
                id: 'machine-1', encryptionMode: 'plain', metadata: null, metadataVersion: 0,
                daemonState: null, daemonStateVersion: 0,
            });
            const manager: unknown = Reflect.get(client, 'rpcHandlerManager');
            if (!(manager instanceof RpcHandlerManager)) throw new Error('missing_machine_rpc_owner');
            const handler: RpcHandler = input => manager.invokeLocal(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE, input);
            const request = { machineId: 'machine-1', expectedContributorOccurrenceId: occurrenceId,
                qualifiedActionId: `${pluginId}/apply`, input: { value: 'approved' }, executionSurface };
            if (executionSurface === 'ui') {
                expect(await handler(request)).toMatchObject({ ok: false,
                    code: 'plugin_action_current_intent_unavailable', actionHandlerInvocation: 'notStarted' });
                expect(stored).toBeNull();
                expect(applied).toBeUndefined();
                expect(await handler({ ...request, presentUserIntent: 'confirmed' })).toMatchObject({
                    ok: true, result: { applied: 'approved-normalized' },
                });
                expect(applied).toMatchObject({ value: 'approved-normalized' });
                expect(stored).toBeNull();
                return;
            }
            const result = await handler(request);
            if (confidential) expect(result, JSON.stringify({ result, unavailableReasons })).toEqual({ ok: true, result: { applied: 'approved-normalized' } });
            else {
                expect(result, JSON.stringify({ result, unavailableReasons })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId, actionId: 'action.invoke' } });
                expect(applied).toBeUndefined();
                const replay = createDaemonExternalActionContributedApprovalReplay({
                    credentials: { token, encryption: null },
                    acquireRuntimeRegistryLease: async () => ({ registry, source: 'ephemeral', durableRevision: -1, release: async () => {} }),
                    isApprovalExecutionOriginCurrent: async () => true,
                    targetActionApprovals: {
                        targetActionApprovalsGet: async () => stored,
                        targetActionApprovalsUpdate: async ({ request }) => { stored = TargetActionApprovalRequestV1Schema.parse(request); return { ok: true }; },
                    },
                });
                expect(await replay({ artifactId, decision: 'approve' })).toMatchObject({ ok: true,
                    result: { status: 'executed', execution: { ok: true } } });
            }
            expect(stored).toMatchObject({ kind: 'plugin_target_action', requestedSurface: executionSurface,
                qualifiedActionId: `${pluginId}/actions/apply`, input: {
                    value: 'approved-normalized', releaseTag: confidential ? '[REDACTED]' : 'v1.2.3-public-release',
                    requestId: expect.stringMatching(/^request-\d+$/),
                } });
            expect(applied).toMatchObject({ value: 'approved-normalized', releaseTag: 'v1.2.3-public-release',
                requestId: expect.stringMatching(/^request-\d+$/) });
            if (confidential) {
                expect(stored).toMatchObject({ approvalInputCustody: 'live_only',
                    replayPlacement: { serverId: 'server-1', machineId: 'machine-1' } });
                expect(JSON.stringify(stored)).not.toContain('v1.2.3-public-release');
            } else { expect(applied).toEqual(stored?.input); }
            applied = undefined;
            // Confidential invocation exercises blocking settlement; public inputs
            // above prove deferred replay through the same handler and parser.
            if (confidential) {
                const blocked = DaemonPluginStructuredMessageActionExecuteResponseSchema.parse(await handler({ ...request, input: { value: 'blocked' } }));
                expect(blocked).toMatchObject({
                    ok: false, code: 'integration_account_needs_reauth',
                    message: expect.stringContaining('Reconnect the integration account before continuing.'),
                });
                expect(JSON.stringify(blocked)).not.toContain('token-secret-must-not-cross');
                expect(JSON.stringify(blocked)).not.toContain('/home/private/operator/credential.json');
                applied = undefined;
                decision = 'reject';
                expect(await handler({ ...request, input: { value: 'rejected' } })).toMatchObject({ ok: false, code: 'plugin_action_current_intent_rejected' });
            } else {
                expect(await handler({ ...request, input: { value: 'rejected' } })).toMatchObject({ ok: true,
                    result: { kind: 'approval_request_created', artifactId } });
                const replay = createDaemonExternalActionContributedApprovalReplay({ credentials: { token, encryption: null },
                    targetActionApprovals: {
                        targetActionApprovalsGet: async () => stored,
                        targetActionApprovalsUpdate: async ({ request }) => { stored = TargetActionApprovalRequestV1Schema.parse(request); return { ok: true }; },
                    },
                });
                expect(await replay({ artifactId, decision: 'reject' })).toMatchObject({ ok: true, result: { status: 'rejected' } });
            }
            expect(applied).toBeUndefined();
            if (executionSurface === 'cli') {
                const artifactCount = rows.size;
                vi.mocked(persistence.readStoredCredentials).mockResolvedValue(null);
                vi.mocked(persistence.readStoredCredentialsForServerId).mockResolvedValue(null);
                expect(await handler(request)).toMatchObject({ ok: false, code: 'plugin_action_current_intent_unavailable' });
                expect(rows.size).toBe(artifactCount);
                expect(applied).toBeUndefined();
                const unbound = new Map<string, RpcHandler>();
                registerDaemonContributionRegistryProjectionHandler({ registerHandler: (method, handler) => { unbound.set(method, handler); } }, {
                    resolveRuntimeRegistry: async () => registry, resolveGeneration: async () => 7, resolveInstalledPackages: async () => [],
                });
                expect(await unbound.get(RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE)?.(request))
                    .toMatchObject({ ok: false, code: 'plugin_action_current_intent_unavailable' });
                expect(rows.size).toBe(artifactCount);
            }
        } finally { await client?.shutdown(); targetActionInvocations.dispose(); }
    });
});
