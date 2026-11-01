import { setImmediate } from 'node:timers/promises';
import axios, { AxiosHeaders, type AxiosResponse } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin, type PluginServices } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionForDefinition } from '@happier-dev/plugin-sdk/collections';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountProfileSchema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import {
    createPluginEventAutomationSetupResultV1JsonSchema,
    PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
    PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
} from '@happier-dev/plugin-sdk/events';
import {
    AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1,
    AutomationEventStoredDefinitionsReadHttpRequestV1Schema,
    AutomationEventStoredDefinitionsReadResultV1Schema,
    AutomationEventActionHttpPathsV1,
    AutomationEventActionHttpRequestSchemasV1,
    AutomationConversationActionHttpPathsV1,
    AutomationConversationActionHttpRequestSchemasV1,
} from '@happier-dev/protocol/automations/event';

import * as persistence from '@/persistence';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { readAuthoritativePluginSlotOccurrence } from '@/plugins/runtime/reload/runtimeLease';
import { fetchAccountProfile } from '@/api/accountProfile';
import { configuration } from '@/configuration';
import { createGithubAutomationEventCheckpointedPullObserver } from '../../../../../packages/plugins/scm-github/src/observations/githubAutomationEventObserver';
import { GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION } from '../../../../../packages/plugins/scm-github/src/observations/githubAutomationEventCheckpoint';

const pluginId = 'happier.scm.forge.github';
const machineId = 'machine-automation-observer';
const listInput = { transport: { kind: 'checkpointedPull' } } as const;
const sourceConfigSchema = { type: 'object' } as const;

function httpResponse<T>(data: T): AxiosResponse<T> {
    return { data, status: 200, statusText: 'OK', headers: new AxiosHeaders(), config: { headers: new AxiosHeaders() } };
}

afterEach(() => vi.restoreAllMocks());

describe('admitted Automation Event background caller composition', () => {
    it('retains one explicitly required external-source health approval across wakes until the report executes', async () => {
        const externalPluginId = 'example.pending-event-source';
        const homeId = 'srv_automation_event_observer';
        let currentMachineId = machineId;
        const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-observer' })).toString('base64url')}.signature`,
            encryption: null, credentialProvenance: 'stored_session' as const };
        const report = { kind: 'catalogReconciliation', scope: { kind: 'checkpointedPull' },
            observedRevision: '7', adoptedRevision: '7', state: 'current', scanStartedAt: null, nextRetryAt: null } as const;
        vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, machineId });
        vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
            if (!['/v1/features', '/v1/features/authenticated'].includes(new URL(String(url)).pathname)) throw new Error('Unexpected fetch');
            return new Response(JSON.stringify(FeaturesResponseSchema.parse({
                features: {}, capabilities: { serverIdentity: { serverIdentityId: homeId } },
            })), { status: 200 });
        });
        const artifacts = new Map<string, { id: string; header: string; body: string; headerVersion: number; bodyVersion: number; dataEncryptionKey: string;
            ownerAccountId: string; access: 'owner'; encryptionMode: 'plain'; seq: number; createdAt: number; updatedAt: number }>();
        const coordinator = getSharedBlockingApprovalCoordinator();
        const catalogStates: string[] = [];
        let invalidateDuringClaim = false;
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return httpResponse({ mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
            if (path === '/v1/account/profile') return httpResponse(AccountProfileSchema.parse({ id: 'account-observer' }));
            if (path === '/v1/account/encryption') return httpResponse({ mode: 'plain', updatedAt: 1 });
            const artifact = artifacts.get(path.split('/').at(-1)!);
            if (artifact) return httpResponse(artifact);
            throw new Error(`Unexpected GET ${path}`);
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const path = new URL(String(url)).pathname;
            if (path === AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1) {
                AutomationEventStoredDefinitionsReadHttpRequestV1Schema.parse(body);
                return httpResponse(AutomationEventStoredDefinitionsReadResultV1Schema.parse({ kind: 'page', revision: '7',
                    definitions: [], nextCursor: null, eventDeclarationRelease: { release: { pluginId: externalPluginId, version: '1.0.0' },
                        archiveDigestSha256: `sha256:${'a'.repeat(64)}` } }));
            }
            if (path === '/v1/artifacts') {
                const value = body as { id: string; header: string; body: string };
                artifacts.set(value.id, { ...value, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, ownerAccountId: 'account-observer',
                    access: 'owner', encryptionMode: 'plain', seq: 1, createdAt: 1, updatedAt: 1 });
                return httpResponse({ id: value.id, headerVersion: 1, bodyVersion: 1 });
            }
            if (path.startsWith('/v1/artifacts/')) {
                const artifact = artifacts.get(path.split('/').at(-1)!);
                if (!artifact) throw new Error('Unknown approval');
                const value = body as { header: string; body: string; expectedHeaderVersion: number; expectedBodyVersion: number };
                expect(value.expectedHeaderVersion).toBe(artifact.headerVersion);
                expect(value.expectedBodyVersion).toBe(artifact.bodyVersion);
                Object.assign(artifact, { header: value.header, body: value.body,
                    headerVersion: artifact.headerVersion + 1, bodyVersion: artifact.bodyVersion + 1 });
                if (invalidateDuringClaim && (await approvals.approvalsGet({ artifactId: artifact.id }))?.status === 'executing') {
                    // OS/source identity changes after the human decision but
                    // before its retained invocation reaches the status write.
                    invalidateDuringClaim = false;
                    currentMachineId = 'replacement-machine';
                }
                return httpResponse({ success: true, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion });
            }
            if (path === AutomationEventActionHttpPathsV1['automation.event.source.status.report']) {
                const request = AutomationEventActionHttpRequestSchemasV1['automation.event.source.status.report'].parse(body);
                expect(request.caller.pluginId).toBe(externalPluginId);
                if (request.input.kind === 'catalogReconciliation') catalogStates.push(request.input.state);
                return httpResponse({});
            }
            throw new Error(`Unexpected POST ${path}`);
        });
        let wake: (() => Promise<void>) | undefined;
        let published = 0;
        const plugin = definePlugin({ id: externalPluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            actions: {
                setup: { title: 'Setup', surfaces: ['plugin'], dangerLevel: 'safe', inputSchema: sourceConfigSchema,
                    resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, sourceConfigSchema),
                    run: () => { throw new Error('Empty catalog must not run setup'); } },
                reset: { title: 'Reset', surfaces: ['plugin'], dangerLevel: 'safe', inputSchema: PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
                    resultSchema: PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
                    run: () => { throw new Error('Empty catalog must not reset a source'); } },
            },
            events: { changed: { declaration: { kind: 'event', title: 'Changed', payloadSchema: { type: 'object' },
                automation: { v: 1, eligible: true, source: { sourceContractVersion: 1, supportedObservationTransports: ['checkpointedPull'],
                    sourceConfigSchema, setupActionRef: { pluginId: externalPluginId, localId: 'setup' },
                    historyGapResetActionRef: { pluginId: externalPluginId, localId: 'reset' }, connectedAccountPurposeBindings: [] } },
            } } },
            backgroundServices: [{ declaration: { id: 'observer', title: 'External source' }, runner: async context => {
                await context.services.actions.execute('automation.event.sources.list', listInput);
                wake = async () => {
                    await context.services.actions.execute('automation.event.source.status.report', report, { signal: context.signal });
                    published += 1;
                };
                await new Promise<void>(resolve => {
                    if (context.signal.aborted) resolve();
                    else context.signal.addEventListener('abort', () => resolve(), { once: true });
                });
            } }],
        });
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins: [{ manifest: plugin.manifest,
            files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: plugin.activate }) }],
            async resolveContributes(happyHomeDir) { return createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external' })); },
            runtimeOptions: { scopedActionRuntime: { credentials,
                actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => accountSettingsParse({
                    actionsSettingsV1: { v: 1, actions: { 'automation.event.source.status.report': { approvalRequiredSurfaces: ['plugin'] } } },
                }), allowEnvironmentOverride: false }) }, resolveCurrentMachineId: () => currentMachineId,
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: currentMachineId }) },
        });
        const pending: Promise<void>[] = [];
        const approvals = createCliApprovalsArtifactStore({ credentials });
        // The deciding person's boundary supplies UI presence. The ordinary
        // Action executor, policy, Artifact store and source currentness stay real.
        const decisionExecutor = createCliActionExecutorHarness({ credentials, token: credentials.token,
            sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverId: configuration.activeServerId, serverHttpBaseUrl: configuration.apiServerUrl,
            actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => accountSettingsParse({}), allowEnvironmentOverride: false }),
        }, {
            isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({ accountId: 'account-observer', machineId,
                serverId: configuration.activeServerId,
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: currentMachineId }),
                resolveCurrentPluginSourceCustody: async pluginId => readAuthoritativePluginSlotOccurrence(pluginId, { controller: fixture.controller })?.sourceCustody ?? null,
                resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: configuration.apiServerUrl }),
                isAccountCurrent: async () => (await fetchAccountProfile({ token: credentials.token })).id === 'account-observer',
                listAccountApiTokens: async () => { throw new Error('A stored Account source must not enumerate API tokens'); },
            }),
        }).executor;
        const decide = async (artifactId: string, decision: 'approve' | 'reject') => {
            const result = await decisionExecutor.execute('approval.request.decide', { artifactId, decision }, {
                surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                serverIdentityId: homeId, runtimeAccountId: 'account-observer',
            });
            if (!result.ok) throw new Error(result.errorCode);
            return result;
        };
        let wakeError: unknown;
        const wakeSource = () => {
            const promise = wake!();
            void promise.catch(error => { wakeError = error; });
            pending.push(promise);
        };
        try {
            fixture.registry.startAdoptedBackgroundServices?.();
            await vi.waitFor(() => expect(wake).toBeDefined());
            wakeSource();
            await vi.waitFor(() => { if (wakeError) throw wakeError; expect(artifacts.size).toBe(1); });
            wakeSource();
            await setImmediate();
            expect(published).toBe(0); // Returning an approval envelope as success must fail here.
            expect(catalogStates).toEqual([]);
            expect(artifacts.size).toBe(1);
            const artifactId = artifacts.keys().next().value!;
            const request = ApprovalRequestV2Schema.parse(await approvals.approvalsGet({ artifactId }));
            expect(request).toMatchObject({ actionId: 'automation.event.source.status.report', status: 'open',
                approval: { flow: 'blocking' }, executionOriginV1: { machineId, caller: { kind: 'plugin', pluginId: externalPluginId } } });
            await vi.waitFor(() => expect(coordinator.getLiveWaiterCount(artifactId)).toBe(1));
            await decide(artifactId, 'approve');
            const completed = await Promise.allSettled(pending);
            const settledApproval = ApprovalRequestV2Schema.parse(await approvals.approvalsGet({ artifactId }));
            expect(settledApproval.execution?.details ?? null).toBeNull();
            expect(settledApproval.execution?.errorCode ?? null).toBeNull();
            expect({ status: settledApproval.status, execution: settledApproval.execution }).toMatchObject({ status: 'executed', execution: { ok: true } });
            expect(completed).toEqual([{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }]);
            expect(catalogStates).toEqual(['current']);
            expect(published).toBe(2);
            expect(artifacts.size).toBe(1);
            wakeSource();
            await vi.waitFor(() => expect(artifacts.size).toBe(2));
            expect(published).toBe(2);
            const rejectedId = [...artifacts.keys()][1]!;
            await vi.waitFor(() => expect(coordinator.getLiveWaiterCount(rejectedId)).toBe(1));
            await decide(rejectedId, 'reject');
            await expect(pending[2]).rejects.toMatchObject({ code: 'approval_rejected' });
            expect(catalogStates).toEqual(['current']);
            expect(published).toBe(2);
            expect(ApprovalRequestV2Schema.parse(await approvals.approvalsGet({ artifactId: rejectedId })).status).toBe('rejected');
            wakeError = undefined;
            wakeSource();
            await vi.waitFor(() => { if (wakeError) throw wakeError; expect(artifacts.size).toBe(3); });
            const staleId = [...artifacts.keys()][2]!;
            await vi.waitFor(() => expect(coordinator.getLiveWaiterCount(staleId)).toBe(1));
            invalidateDuringClaim = true;
            await decide(staleId, 'approve');
            await expect(pending[3]).rejects.toMatchObject({ code: 'approval_stale' });
            expect(catalogStates).toEqual(['current']);
            currentMachineId = machineId;
            wakeError = undefined;
            wakeSource();
            await vi.waitFor(() => { if (wakeError) throw wakeError; expect(artifacts.size).toBe(4); });
            const retiredId = [...artifacts.keys()][3]!;
            await vi.waitFor(() => expect(coordinator.getLiveWaiterCount(retiredId)).toBe(1));
            await fixture.lease.release();
            await fixture.controller.shutdown();
            expect((await Promise.allSettled([pending[4]]))[0]?.status).toBe('rejected');
            expect(ApprovalRequestV2Schema.parse(await approvals.approvalsGet({ artifactId: retiredId })).status).toBe('canceled');
            expect(catalogStates).toEqual(['current']);
        } finally {
            for (const artifactId of artifacts.keys()) coordinator.cancelApproval(artifactId);
            await fixture.lease.release();
            await fixture.controller.shutdown();
            await Promise.allSettled(pending);
            await fixture.dispose();
        }
    });

    it('admits current Conversation callers but never borrows replacement or retired occurrence authority', async () => {
        const conversationPluginId = 'example.conversation-caller';
        vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, machineId });
        const callers: Array<ReturnType<typeof AutomationConversationActionHttpRequestSchemasV1['automation.conversation.targets.list']['parse']>['caller']> = [];
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (!String(url).endsWith(AutomationConversationActionHttpPathsV1['automation.conversation.targets.list'])) {
                throw new Error(`Unexpected POST ${url}`);
            }
            callers.push(AutomationConversationActionHttpRequestSchemasV1['automation.conversation.targets.list'].parse(body).caller);
            return httpResponse({ items: [], nextCursor: null });
        });
        const get = vi.spyOn(axios, 'get').mockImplementation(async url => { throw new Error(`Unexpected GET ${url}`); });
        const createOccurrence = async (predecessor?: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>) => {
            const observed: { actions?: PluginServices['actions']; result?: unknown; error?: unknown } = {};
            const plugin = definePlugin({
                id: conversationPluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
                backgroundServices: [{ declaration: { id: 'conversation', title: 'Conversation caller' }, runner: async context => {
                    observed.actions = context.services.actions;
                    try { observed.result = await context.services.actions.execute('automation.conversation.targets.list', { limit: 2 }); }
                    catch (error) { observed.error = error; }
                } }],
            });
            const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
                ...(predecessor ? { happyHomeDir: predecessor.happyHomeDir, controller: predecessor.controller } : {}),
                plugins: [{ manifest: plugin.manifest,
                    files: { 'daemon.mjs': `export function activate() {} // ${predecessor ? 'successor' : 'incumbent'}` },
                    replaceExisting: predecessor !== undefined,
                    instantiateCommittedModule: () => ({ activate: plugin.activate }),
                }],
                async resolveContributes(happyHomeDir) {
                    return createResolvedContributionRegistry(projectLoadedPluginContributes({
                        loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'builtin',
                    }));
                },
                runtimeOptions: {
                    scopedActionRuntime: { credentials: { token: 'fixture-conversation-token', encryption: null },
                        actionsSettingsProvider: createActionSettingsProvider({
                            getAccountSettings: () => accountSettingsParse({}), allowEnvironmentOverride: false,
                        }) },
                    resolveCurrentMachineId: () => machineId,
                    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'server-observer', machineId }),
                },
            });
            return { fixture, observed };
        };
        const incumbent = await createOccurrence();
        let successor: Awaited<ReturnType<typeof createOccurrence>> | undefined;
        try {
            incumbent.fixture.registry.startAdoptedBackgroundServices?.();
            await vi.waitFor(() => {
                if (incumbent.observed.error) throw incumbent.observed.error;
                expect(incumbent.observed.result).toEqual({ items: [], nextCursor: null });
            });
            expect(callers[0]).toMatchObject({ pluginId: conversationPluginId, occurrenceId: expect.any(String),
                sourceCustody: { kind: 'managed' },
                materialization: incumbent.fixture.registry.resolveCurrentPluginMaterializationRef?.(conversationPluginId) });
            successor = await createOccurrence(incumbent.fixture);
            await vi.waitFor(() => {
                if (successor?.observed.error) throw successor.observed.error;
                expect(successor?.observed.result).toEqual({ items: [], nextCursor: null });
            });
            expect(callers).toHaveLength(2);
            expect(callers[1]?.occurrenceId).not.toBe(callers[0]?.occurrenceId);
            const before = { get: get.mock.calls.length, post: post.mock.calls.length };
            const invoke = (actions: PluginServices['actions']) => actions.execute('automation.conversation.targets.list',
                { limit: 2 }, { signal: new AbortController().signal });
            await expect(invoke(incumbent.observed.actions!)).rejects.toMatchObject({ code: 'plugin_action_generation_retired' });
            expect({ get: get.mock.calls.length, post: post.mock.calls.length }).toEqual(before);
            await successor.fixture.lease.release();
            await incumbent.fixture.lease.release();
            await incumbent.fixture.controller.shutdown();
            await expect(invoke(successor.observed.actions!)).rejects.toMatchObject({ code: 'plugin_action_generation_retired' });
            expect({ get: get.mock.calls.length, post: post.mock.calls.length }).toEqual(before);
        } finally {
            await successor?.fixture.lease.release();
            await incumbent.fixture.lease.release();
            await incumbent.fixture.controller.shutdown();
            await successor?.fixture.dispose();
            await incumbent.fixture.dispose();
        }
    });

    it('adopts an empty catalog with default-policy status writes and parks, without lending successor authority', async () => {
        // HTTP and OS persistence are boundaries; signing, source admission,
        // caller stamping, Action execution and definition adoption stay real.
        vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, onboardingCompleted: true, machineId });
        const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (String(url).endsWith('/v1/account/encryption/currentness')) return httpResponse({
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
                updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
            });
            if (String(url).endsWith('/v1/account/profile')) return httpResponse({ id: 'account-observer' });
            throw new Error(`Unexpected GET ${url}`);
        });
        const callers: Array<ReturnType<typeof AutomationEventStoredDefinitionsReadHttpRequestV1Schema.parse>['caller']> = [];
        const catalogStates: string[] = [];
        const accountSettings = accountSettingsParse({});
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (String(url).endsWith(AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1)) {
                callers.push(AutomationEventStoredDefinitionsReadHttpRequestV1Schema.parse(body).caller);
                return httpResponse(AutomationEventStoredDefinitionsReadResultV1Schema.parse({
                    kind: 'page', revision: '7', definitions: [], nextCursor: null,
                    eventDeclarationRelease: {
                        release: { pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                    },
                }));
            }
            if (String(url).endsWith(AutomationEventActionHttpPathsV1['automation.event.source.status.report'])) {
                const request = AutomationEventActionHttpRequestSchemasV1['automation.event.source.status.report'].parse(body);
                if (request.input.kind === 'catalogReconciliation') catalogStates.push(request.input.state);
                return httpResponse({});
            }
            throw new Error(`Unexpected POST ${url}`);
        });

        const createOccurrence = async (predecessor?: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>) => {
            const sleep = vi.fn(async (_delay: number, signal: AbortSignal) => {
                await new Promise<void>(resolve => {
                    if (signal.aborted) resolve();
                    else signal.addEventListener('abort', () => resolve(), { once: true });
                });
            });
            const observer = createGithubAutomationEventCheckpointedPullObserver({ sleep });
            const checkpointTable = {
                query: async () => ({ rows: [], changeCursor: 0 }),
            } satisfies Pick<PluginAccountCollectionForDefinition<typeof GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION>, 'query'>;
            const observed: { actions?: PluginServices['actions']; page?: unknown; error?: unknown; completed: boolean } = { completed: false };
            const plugin = definePlugin({
                id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
                actions: {
                    setup: { title: 'Setup', surfaces: ['plugin'], dangerLevel: 'safe',
                        inputSchema: sourceConfigSchema,
                        resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, sourceConfigSchema),
                        run: () => { throw new Error('Empty catalog must not run setup'); } },
                    reset: { title: 'Reset', surfaces: ['plugin'], dangerLevel: 'safe',
                        inputSchema: PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
                        resultSchema: PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
                        run: () => { throw new Error('Empty catalog must not reset a source'); } },
                },
                events: { changed: { declaration: {
                    kind: 'event', title: 'Changed', payloadSchema: { type: 'object' },
                    automation: { v: 1, eligible: true, source: {
                        sourceContractVersion: 1, supportedObservationTransports: ['checkpointedPull'],
                        sourceConfigSchema,
                        setupActionRef: { pluginId, localId: 'setup' },
                        historyGapResetActionRef: { pluginId, localId: 'reset' },
                        connectedAccountPurposeBindings: [],
                    } },
                } } },
                backgroundServices: [{ declaration: { id: 'observer', title: 'Observer' }, runner: async context => {
                    observed.actions = context.services.actions;
                    try {
                        observed.page = await context.services.actions.execute('automation.event.sources.list', listInput);
                        // Only the empty persistent checkpoint table is substituted.
                        // Its query is outside this caller/adoption wiring contract.
                        const storage = { ...context.services.storage, account: { collection(definition: { id: string }) {
                            if (definition.id !== GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION.id) throw new Error('Unexpected Collection');
                            return checkpointTable;
                        } } } as unknown as PluginServices['storage'];
                        await observer.run({ ...context, services: { ...context.services, storage } });
                    } catch (error) {
                        observed.error = error;
                    } finally {
                        observed.completed = true;
                    }
                } }],
            });
            const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
                ...(predecessor ? { happyHomeDir: predecessor.happyHomeDir, controller: predecessor.controller } : {}),
                plugins: [{ manifest: plugin.manifest,
                    files: { 'daemon.mjs': `export function activate() {} // ${predecessor ? 'successor' : 'incumbent'}` },
                    replaceExisting: predecessor !== undefined,
                    instantiateCommittedModule: () => ({ activate: plugin.activate }),
                }],
                async resolveContributes(happyHomeDir) {
                    return createResolvedContributionRegistry(projectLoadedPluginContributes({
                        loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'builtin',
                    }));
                },
                runtimeOptions: {
                    scopedActionRuntime: {
                        credentials: { token: 'fixture-account-token', encryption: null },
                        actionsSettingsProvider: createActionSettingsProvider({
                            getAccountSettings: () => accountSettings,
                            allowEnvironmentOverride: false,
                        }),
                    },
                    resolveCurrentMachineId: () => machineId,
                    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'server-observer', machineId }),
                },
            });
            return { fixture, observed, sleep };
        };

        const incumbent = await createOccurrence();
        let successor: Awaited<ReturnType<typeof createOccurrence>> | undefined;
        try {
            incumbent.fixture.registry.startAdoptedBackgroundServices?.();
            await vi.waitFor(() => {
                if (incumbent.observed.error) throw incumbent.observed.error;
                expect(incumbent.observed.page).toEqual({ kind: 'page', revision: '7', definitions: [], nextCursor: null });
            });
            await vi.waitFor(() => {
                if (incumbent.observed.error) throw incumbent.observed.error;
                expect(incumbent.sleep.mock.calls).toEqual([]);
                expect(catalogStates).toContain('current');
            });
            await setImmediate();
            expect(incumbent.observed.completed).toBe(false);
            expect(incumbent.sleep).not.toHaveBeenCalled();
            expect(callers[0]).toMatchObject({ pluginId, occurrenceId: expect.any(String),
                sourceCustody: { kind: 'managed' },
                materialization: incumbent.fixture.registry.resolveCurrentPluginMaterializationRef?.(pluginId) });
            const oldOccurrenceId = callers[0]!.occurrenceId;

            const currentReports = catalogStates.filter(state => state === 'current').length;
            successor = await createOccurrence(incumbent.fixture);
            expect(callers.at(-1)?.occurrenceId).not.toBe(oldOccurrenceId);
            await vi.waitFor(() => {
                if (successor?.observed.error) throw successor.observed.error;
                expect(successor?.observed.page).toMatchObject({ kind: 'page', revision: '7', definitions: [] });
            });
            await vi.waitFor(() => {
                expect(catalogStates.filter(state => state === 'current')).toHaveLength(currentReports + 1);
                expect(incumbent.observed.completed).toBe(true);
            });
            await setImmediate();
            expect(successor.sleep).not.toHaveBeenCalled();
            expect(successor.observed.completed).toBe(false);
            const before = { get: get.mock.calls.length, post: post.mock.calls.length };
            await expect(incumbent.observed.actions!.execute('automation.event.sources.list', listInput,
                { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'plugin_action_generation_retired' });
            expect({ get: get.mock.calls.length, post: post.mock.calls.length }).toEqual(before);
        } finally {
            // Drain both idempotent leases before stopping their shared owner;
            // borrowed-fixture disposal must not publish another runtime.
            await successor?.fixture.lease.release();
            await incumbent.fixture.lease.release();
            await incumbent.fixture.controller.shutdown();
            await successor?.fixture.dispose();
            await incumbent.fixture.dispose();
        }
    });
});
