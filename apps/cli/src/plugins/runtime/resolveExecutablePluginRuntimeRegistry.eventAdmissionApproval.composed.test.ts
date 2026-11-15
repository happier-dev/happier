import axios, { AxiosHeaders, type AxiosResponse } from 'axios';
import { readAuthoritativePluginSlotOccurrence } from '@/plugins/runtime/reload/runtimeLease';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { AccountProfileSchema, FeaturesResponseSchema, AutomationSourceSelectorIdV1Schema, AutomationTriggerIdSchema,
    sealAutomationTriggerDefinitionStoredEnvelopeV1, createActionExecutor, MachineServicesDetailResultV1Schema,
    type HealthCheckSourceConfigV1 } from '@happier-dev/protocol';
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
} from '@happier-dev/protocol/automations/event';

import * as persistence from '@/persistence';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { artifactListResponse, artifactReadResponse } from '@/testkit/http/artifactHome';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { configuration } from '@/configuration';
import { fetchAccountProfile } from '@/api/accountProfile';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { AccountNoticeArtifactHeaderV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';

const machineId = 'machine-event-admission';
const sourceConfigSchema = { type: 'object' } as const;

function httpResponse<T>(data: T): AxiosResponse<T> {
    return { data, status: 200, statusText: 'OK', headers: new AxiosHeaders(), config: { headers: new AxiosHeaders() } };
}

afterEach(() => vi.restoreAllMocks());

describe('trigger-started Event admission approval', () => {
    // A checkpointed observer replays one unsettled occurrence with the same
    // admission input on every eligible cycle (P03 QA: 1,691 Asks for 2 occurrences).
    it.each([
        { title: 'admits ongoing observations under persisted trigger approval by default', retries: 1, requireApproval: false, rejected: false },
        { title: 'completes an explicitly approved observation-only health occurrence', retries: 1, requireApproval: true, rejected: false },
        { title: 'publishes no health notice when an observation-only occurrence is rejected', retries: 1, requireApproval: true, rejected: true },
        { title: 'keeps one pending Ask per occurrence across explicitly required approval retries', retries: 6, requireApproval: true, rejected: false },
    ])('$title', ({ retries, requireApproval, rejected }) => withConfiguredDaemonTestHome({
        prefix: 'event-admission-approval-', env: { HAPPIER_ACCOUNT_SETTINGS_MODE: 'auto', HAPPIER_ACTIONS_SETTINGS_V1: undefined },
    }, async () => {
        const socket = await createRequesterCurrentnessSocketHarness();
        const pluginId = 'example.event-admission';
        const homeId = 'srv_event_admission';
        const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-admission' })).toString('base64url')}.signature`,
            encryption: null, credentialProvenance: 'stored_session' as const };
        const eventRef = { pluginId, localId: 'changed' };
        const sourceConfig: HealthCheckSourceConfigV1 = { v: 1,
            subject: { kind: 'machineService', machineId, serviceId: 'web' },
            checks: [{ checkId: 'http', kind: { pluginId: 'happier.machine.services', localId: 'http' },
                binding: { kind: 'healthCheck' }, config: { endpoint: 'https://example.test/health', expectStatus: 200 },
                periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 },
            { checkId: 'http-secondary', kind: { pluginId: 'happier.machine.services', localId: 'http' },
                binding: { kind: 'healthCheck' }, config: { endpoint: 'https://example.test/health/secondary', expectStatus: 200 },
                periodMs: 1000, consecutiveFailuresBeforeAlerting: 1 }] };
        const detail = MachineServicesDetailResultV1Schema.parse({ kind: 'service', service: {
            serviceId: 'web', name: 'Web', authority: 'machine', lifecyclePurpose: 'deployment', generation: 'native-generation',
            state: 'running', watchId: 'web', watchRevision: '1', native: { phase: 'running', readiness: 'not_reported' },
            nativeInstance: { adapter: { pluginId: 'happier.machine.services', localId: 'systemd' }, nativeResourceId: 'web.service' },
            capabilities: { start: true, stop: true, restart: true, logs: true, accounting: false },
        } });
        const serviceExecutor = createActionExecutor({ machineServiceAction: async () => detail });
        const serviceReads: unknown[] = [];
        // The Machine RPC boundary runs the real receiving Action parser and
        // returns the native detail or the Action's typed refusal, as production does.
        vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => {
            const result = await serviceExecutor.execute('machines.services.detail', request.request,
                { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } });
            serviceReads.push({ input: request.request, result });
            return result.ok ? result.result : result;
        });
        const selector = { automationId: 'cmautomation00000000000001', triggerId: AutomationTriggerIdSchema.parse('trigger-1'), triggerRevision: 1,
            sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse('3f1c2a4e-8b7d-4c3e-9f2a-1b2c3d4e5f60') };
        vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, machineId });
        vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return Response.json(createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
            if (!['/v1/features', '/v1/features/authenticated'].includes(path)) throw new Error('Unexpected fetch');
            return new Response(JSON.stringify(FeaturesResponseSchema.parse({
                features: {}, capabilities: { serverIdentity: { serverIdentityId: homeId } },
            })), { status: 200 });
        });
        const artifacts = new Map<string, { id: string; header: string; body: string; headerVersion: number; bodyVersion: number; dataEncryptionKey: string;
            ownerAccountId: string; access: 'owner'; encryptionMode: 'plain'; seq: number; createdAt: number; updatedAt: number }>();
        const notices = new Map<string, Record<string, unknown>>();
        const coordinator = getSharedBlockingApprovalCoordinator();
        const unmatched: string[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return httpResponse(createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
            if (path === '/v1/account/profile') return httpResponse(AccountProfileSchema.parse({ id: 'account-admission' }));
            if (path === '/v1/account/encryption') return httpResponse({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/artifacts') return httpResponse(artifactListResponse(String(url), [...notices.values()]));
            const artifact = artifacts.get(path.split('/').at(-1)!);
            if (artifact) return httpResponse(artifact);
            const notice = notices.get(path.split('/').at(-1)!);
            if (notice) return httpResponse(notice);
            if (path === '/v2/changes') return httpResponse({ changes: [], nextCursor: 0 });
            if (path.startsWith('/v1/artifacts/')) return { ...httpResponse({ error: 'not_found' }), status: 404 };
            unmatched.push(path);
            throw new Error(`Unexpected GET ${path}`);
        });
        let admissionPosts = 0;
        const settlement = rejected
            ? { kind: 'skipped', reason: 'occurrenceRejected', checkpointSafe: true } as const
            : { kind: 'observed', checkpointSafe: true } as const;
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const path = new URL(String(url)).pathname;
            if (path === AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1) {
                const request = AutomationEventStoredDefinitionsReadHttpRequestV1Schema.parse(body);
                return httpResponse(AutomationEventStoredDefinitionsReadResultV1Schema.parse({ kind: 'page', revision: '1',
                    definitions: [{ ...selector, eventRef, sourceContractVersion: 1, observationOnly: { kind: 'observationOnly' },
                        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
                            machineId, pluginId, materializationId: request.caller.materialization.materializationId,
                        } }, payloadSchema: { type: 'object' },
                        storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
                            binding: { v: 1, ...selector, triggerKind: 'pluginEvent', eventRef },
                            definition: { v: 1, sourceInstanceId: 'source:approval', sourceConfig, displayLabel: 'Observed change',
                                filter: null, maximumObservationAgeMs: null } }) }], nextCursor: null, eventDeclarationRelease: { release: { pluginId, version: '1.0.0' },
                        archiveDigestSha256: `sha256:${'a'.repeat(64)}` } }));
            }
            if (path === '/v1/artifacts/read') return httpResponse(artifactReadResponse(body, id => artifacts.get(id)
                ?? (notices.has(id) ? { id, ...notices.get(id) } : null)).data);
            if (path === '/v1/artifacts') {
                const mutation = readCarrierMutation(body);
                if (typeof mutation.header === 'string'
                    && AccountNoticeArtifactHeaderV1Schema.safeParse(decodePlainArtifactStoredContent(mutation.header)).success) {
                    const value = mutation;
                    const id = String(value.id);
                    notices.set(id, { ...value, ownerAccountId: 'account-admission', access: 'owner', publicAudience: 'none',
                        encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
                    return httpResponse({ id, headerVersion: 1, bodyVersion: 1 });
                }
                const value = body as { id: string; header: string; body: string };
                if (artifacts.has(value.id)) throw Object.assign(new Error('conflict'), { code: 'conflict' });
                artifacts.set(value.id, { ...value, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
                    ownerAccountId: 'account-admission', access: 'owner', encryptionMode: 'plain', seq: 1, createdAt: 1, updatedAt: 1 });
                return httpResponse({ id: value.id, headerVersion: 1, bodyVersion: 1 });
            }
            if (path.startsWith('/v1/artifacts/')) {
                const artifact = artifacts.get(path.split('/').at(-1)!);
                if (!artifact) throw new Error('Unknown approval');
                const value = body as { header: string; body: string; expectedHeaderVersion: number; expectedBodyVersion: number };
                if (value.expectedHeaderVersion !== artifact.headerVersion || value.expectedBodyVersion !== artifact.bodyVersion)
                    return httpResponse({ success: false, error: 'version-mismatch' });
                Object.assign(artifact, { header: value.header, body: value.body,
                    headerVersion: artifact.headerVersion + 1, bodyVersion: artifact.bodyVersion + 1 });
                return httpResponse({ success: true, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion });
            }
            if (path.includes('/automations/events/admit')) {
                admissionPosts += 1;
                return httpResponse({ results: [settlement],
                    continuation: { kind: 'ready', accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } } });
            }
            throw new Error(`Unexpected POST ${path}`);
        });
        let admit: ((occurrenceId: string) => Promise<unknown>) | undefined;
        const plugin = definePlugin({ id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            actions: {
                setup: { title: 'Setup', surfaces: ['plugin'], dangerLevel: 'safe', inputSchema: sourceConfigSchema,
                    resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, sourceConfigSchema),
                    run: () => { throw new Error('unused'); } },
                reset: { title: 'Reset', surfaces: ['plugin'], dangerLevel: 'safe', inputSchema: PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
                    resultSchema: PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
                    run: () => { throw new Error('unused'); } },
            },
            events: { changed: { declaration: { kind: 'event', title: 'Changed', payloadSchema: { type: 'object' },
                automation: { v: 1, eligible: true, source: { sourceContractVersion: 1, supportedObservationTransports: ['checkpointedPull'],
                    sourceConfigSchema, setupActionRef: { pluginId, localId: 'setup' },
                    historyGapResetActionRef: { pluginId, localId: 'reset' }, connectedAccountPurposeBindings: [] } },
            } } },
            backgroundServices: [{ declaration: { id: 'observer', title: 'Observer' }, runner: async context => {
                admit = occurrenceId => context.services.actions.execute('automation.event.admit', {
                    eventRef: { pluginId, localId: 'changed' }, occurrenceId, occurredAt: 1_700_000_000_000,
                    observationReceivedAt: 1_700_000_000_100, payload: { sourceInstanceId: 'source:approval', subject: sourceConfig.subject,
                        checkId: occurrenceId === 'occurrence-b' ? 'http-secondary' : 'http',
                        transition: 'failed', observedAt: 1_700_000_000_000 },
                    definitions: [{ automationId: 'cmautomation00000000000001', triggerId: 'trigger-1', triggerRevision: 1,
                        sourceSelectorId: '3f1c2a4e-8b7d-4c3e-9f2a-1b2c3d4e5f60' }],
                }, { signal: context.signal });
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
                    actionsSettingsV1: { v: 1, actions: requireApproval
                        ? { 'automation.event.admit': { approvalRequiredSurfaces: ['plugin'] } } : {} },
                }), allowEnvironmentOverride: false }) }, resolveCurrentMachineId: () => machineId,
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId }) },
        });
        const approvals = createCliApprovalsArtifactStore({ credentials });
        const decisionExecutor = createCliActionExecutorHarness({ credentials, token: credentials.token,
            sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverId: configuration.activeServerId, serverHttpBaseUrl: configuration.apiServerUrl,
            actionsSettingsProvider: createActionSettingsProvider({ getAccountSettings: () => accountSettingsParse({}), allowEnvironmentOverride: false }),
        }, { isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({ accountId: 'account-admission', machineId,
            serverId: configuration.activeServerId,
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId }),
            isPluginInstalled: id => readAuthoritativePluginSlotOccurrence(id, { controller: fixture.controller }) !== null,
            resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: configuration.apiServerUrl }),
            isAccountCurrent: async () => (await fetchAccountProfile({ token: credentials.token, projection: 'self' })).id === 'account-admission',
            listAccountApiTokens: async () => { throw new Error('Stored Account source must not enumerate API tokens'); },
        }) }).executor;
        const attempts: Promise<unknown>[] = [];
        const outcomes: string[] = [];
        let waiting = 0;
        const liveWaiters = () => [...artifacts.keys()].reduce((sum, id) => sum + coordinator.getLiveWaiterCount(id), 0);
        const retry = async (occurrenceId: string) => {
            let settled = false;
            const attempt = admit!(occurrenceId).then(value => { outcomes.push(JSON.stringify(value).slice(0, 80)); },
                (error: unknown) => { outcomes.push(`error:${(error as { code?: string }).code ?? String(error)}`); })
                .finally(() => { settled = true; });
            attempts.push(attempt);
            if (!requireApproval) {
                await attempt;
                return;
            }
            // A retry either settles (a deferred receipt or a failure) or joins an open Ask's live waiter.
            await vi.waitFor(() => expect(settled || liveWaiters() === waiting + 1).toBe(true));
            if (!settled) waiting += 1;
        };
        try {
            fixture.registry.startAdoptedBackgroundServices?.();
            await vi.waitFor(() => expect(admit).toBeDefined());
            for (let index = 0; index < retries; index++) await retry('occurrence-a');
            const asksForOneOccurrence = artifacts.size;
            await retry('occurrence-b');
            if (!requireApproval) {
                expect({ asksForOneOccurrence, asksAfterNewOccurrence: artifacts.size })
                    .toEqual({ asksForOneOccurrence: 0, asksAfterNewOccurrence: 0 });
                await Promise.all(attempts);
                expect({ admissionPosts, notices: notices.size, unmatched })
                    .toEqual({ admissionPosts: 2, notices: 2, unmatched: [] });
                expect(outcomes).toEqual(Array.from({ length: 2 }, () =>
                    JSON.stringify({ results: [settlement] }).slice(0, 80)));
                return;
            }
            expect({ asksForOneOccurrence, asksAfterNewOccurrence: artifacts.size, admissionPosts, outcomes: outcomes.slice(0, 2), unmatched: unmatched.slice(0, 4) })
                .toEqual({ asksForOneOccurrence: 1, asksAfterNewOccurrence: 2, admissionPosts: 0, outcomes: [], unmatched: [] });
            const [first] = artifacts.keys();
            expect(ApprovalRequestV2Schema.parse(await approvals.approvalsGet({ artifactId: first! })))
                .toMatchObject({ actionId: 'automation.event.admit', status: 'open', approval: { flow: 'blocking' } });
            // Replayed pending attempts preserve the existing one-Ask contract.
            // The real serial observer has one waiter when the person approves.
            if (retries !== 1) return;
            const decided = await decisionExecutor.execute('approval.request.decide', { artifactId: first!, decision: 'approve' }, {
                surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                serverIdentityId: homeId, runtimeAccountId: 'account-admission',
            });
            expect(decided.ok).toBe(true);
            await Promise.all(attempts.slice(0, retries));
            const approved = ApprovalRequestV2Schema.parse(await approvals.approvalsGet({ artifactId: first! }));
            expect(approved, JSON.stringify({ execution: 'execution' in approved ? approved.execution : approved, serviceReads, outcomes }))
                .toMatchObject({ status: 'executed', execution: { ok: true } });
            expect(outcomes.slice(0, retries)).toEqual(Array.from({ length: retries }, () =>
                JSON.stringify({ results: [settlement] }).slice(0, 80)));
            if (rejected) expect(serviceReads).toEqual([]);
            else expect(serviceReads).toContainEqual({
                input: { serverId: configuration.activeServerId, machineId, serviceId: 'web' }, result: { ok: true, result: detail },
            });
            expect(notices.size).toBe(rejected ? 0 : 1);
        } finally {
            for (const artifactId of artifacts.keys()) coordinator.cancelApproval(artifactId);
            await fixture.lease.release();
            await fixture.controller.shutdown();
            await Promise.allSettled(attempts);
            await fixture.dispose();
            await socket.close();
        }
    }));
});
