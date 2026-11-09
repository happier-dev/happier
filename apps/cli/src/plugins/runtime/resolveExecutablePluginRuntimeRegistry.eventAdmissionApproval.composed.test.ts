import axios, { AxiosHeaders, type AxiosResponse } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
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
} from '@happier-dev/protocol/automations/event';

import * as persistence from '@/persistence';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { artifactReadResponse } from '@/testkit/http/artifactHome';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';

const machineId = 'machine-event-admission';
const sourceConfigSchema = { type: 'object' } as const;

function httpResponse<T>(data: T): AxiosResponse<T> {
    return { data, status: 200, statusText: 'OK', headers: new AxiosHeaders(), config: { headers: new AxiosHeaders() } };
}

afterEach(() => vi.restoreAllMocks());

describe('trigger-started Event admission under a required approval', () => {
    // A checkpointed observer replays one unsettled occurrence with the same
    // admission input on every eligible cycle (P03 QA: 1,691 Asks for 2 occurrences).
    it('keeps one open Ask per occurrence across retries and asks again for a new occurrence', () => withConfiguredDaemonTestHome({
        prefix: 'event-admission-approval-', env: { HAPPIER_ACCOUNT_SETTINGS_MODE: 'auto', HAPPIER_ACTIONS_SETTINGS_V1: undefined },
    }, async () => {
        const socket = await createRequesterCurrentnessSocketHarness();
        const pluginId = 'example.event-admission';
        const homeId = 'srv_event_admission';
        const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-admission' })).toString('base64url')}.signature`,
            encryption: null, credentialProvenance: 'stored_session' as const };
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
        const coordinator = getSharedBlockingApprovalCoordinator();
        const unmatched: string[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return httpResponse(createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
            if (path === '/v1/account/profile') return httpResponse(AccountProfileSchema.parse({ id: 'account-admission' }));
            if (path === '/v1/account/encryption') return httpResponse({ mode: 'plain', updatedAt: 1 });
            const artifact = artifacts.get(path.split('/').at(-1)!);
            if (artifact) return httpResponse(artifact);
            if (path === '/v2/changes') return httpResponse({ changes: [], nextCursor: 0 });
            if (path.startsWith('/v1/artifacts/')) return { ...httpResponse({ error: 'not_found' }), status: 404 };
            unmatched.push(path);
            throw new Error(`Unexpected GET ${path}`);
        });
        let admissionPosts = 0;
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            const path = new URL(String(url)).pathname;
            if (path === AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1) {
                AutomationEventStoredDefinitionsReadHttpRequestV1Schema.parse(body);
                return httpResponse(AutomationEventStoredDefinitionsReadResultV1Schema.parse({ kind: 'page', revision: '1',
                    definitions: [], nextCursor: null, eventDeclarationRelease: { release: { pluginId, version: '1.0.0' },
                        archiveDigestSha256: `sha256:${'a'.repeat(64)}` } }));
            }
            if (path === '/v1/artifacts/read') return httpResponse(artifactReadResponse(body, id => artifacts.get(id) ?? null).data);
            if (path === '/v1/artifacts') {
                const value = body as { id: string; header: string; body: string };
                if (artifacts.has(value.id)) throw Object.assign(new Error('conflict'), { code: 'conflict' });
                artifacts.set(value.id, { ...value, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
                    ownerAccountId: 'account-admission', access: 'owner', encryptionMode: 'plain', seq: 1, createdAt: 1, updatedAt: 1 });
                return httpResponse({ id: value.id, headerVersion: 1, bodyVersion: 1 });
            }
            if (path.includes('/automations/events/admit')) { admissionPosts += 1; throw new Error('Admission must wait for consent'); }
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
                    observationReceivedAt: 1_700_000_000_100, payload: { status: 'down' },
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
                    actionsSettingsV1: { v: 1, actions: { 'automation.event.admit': { approvalRequiredSurfaces: ['plugin'] } } },
                }), allowEnvironmentOverride: false }) }, resolveCurrentMachineId: () => machineId,
                resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId }) },
        });
        const approvals = createCliApprovalsArtifactStore({ credentials });
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
            // A retry either settles (a deferred receipt or a failure) or joins an open Ask's live waiter.
            await vi.waitFor(() => expect(settled || liveWaiters() === waiting + 1).toBe(true));
            if (!settled) waiting += 1;
        };
        try {
            fixture.registry.startAdoptedBackgroundServices?.();
            await vi.waitFor(() => expect(admit).toBeDefined());
            const retries = 6;
            for (let index = 0; index < retries; index++) await retry('occurrence-a');
            const asksForOneOccurrence = artifacts.size;
            await retry('occurrence-b');
            expect({ asksForOneOccurrence, asksAfterNewOccurrence: artifacts.size, admissionPosts, outcomes: outcomes.slice(0, 2), unmatched: unmatched.slice(0, 4) })
                .toEqual({ asksForOneOccurrence: 1, asksAfterNewOccurrence: 2, admissionPosts: 0, outcomes: [], unmatched: [] });
            const [first] = artifacts.keys();
            expect(ApprovalRequestV2Schema.parse(await approvals.approvalsGet({ artifactId: first! })))
                .toMatchObject({ actionId: 'automation.event.admit', status: 'open', approval: { flow: 'blocking' } });
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
