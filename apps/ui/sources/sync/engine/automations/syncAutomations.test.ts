import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AutomationDefinitionListItemSchema,
    AutomationV3RunListItemSchema,
} from '@happier-dev/protocol/automations/automationApiV3';
import { AutomationSourceSelectorIdV1Schema } from '@happier-dev/protocol/automations/automationEventJsonBoundsV1';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';

import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { createSocketAccountEncryptionObservation } from '@/sync/api/account/apiAccountEncryptionMode';
import { bindAccountEncryptionObservation } from '@/sync/http/accountEncryptionObservationBinding';
import { storage } from '@/sync/domains/state/storage';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import type { AutomationRequestContext } from '@/sync/api/automations/apiAutomations';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createAutomationDefinitionSummary } from '@/sync/domains/automations/automationDefinitionProjection';
import { readPluginEventAutomationPrivateDetail } from '@/sync/domains/automations/pluginEventAutomationEditSeed';

import { fetchAndApplyAutomationRuns, fetchAndApplyAutomations } from './syncAutomations';

type ApplyAutomations = Parameters<typeof fetchAndApplyAutomations>[0]['applyAutomations'];

// Response factories run only at the genuine HTTP boundary; API schemas,
// projection, feature policy and concurrency owners remain real.
const listAutomationDefinitionsMock = vi.fn();
const listAutomationDefinitionRunsMock = vi.fn();
let network: Awaited<ReturnType<typeof installSessionOpsNetworkBoundary>>;
let credentials: AuthCredentials;
let requestContext: AutomationRequestContext;
const initialStorageState = storage.getState();

const eventSummary = AutomationDefinitionListItemSchema.parse({
    id: 'event-1',
    name: 'Repository updates',
    description: null,
    enabled: true,
    triggers: [{
        id: 'event-trigger-1',
        revision: 1,
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
        kind: 'pluginEvent',
        eventRef: {
            pluginId: 'happier.scm.github',
            localId: 'repository-event-v1',
        },
        sourceSelectorId: '11111111-1111-4111-8111-111111111111',
        sourceContractVersion: 1,
        observation: {
            kind: 'checkpointedPull',
            watcher: null,
        },
        sourceStatus: null,
        sourceCatalogStatus: null,
    }],
    targetType: 'existingSession',
    existingSessionId: 'session-1',
    templateVersion: 3,
    lastRunAt: null,
    createdAt: 1,
    updatedAt: 1,
    assignments: [],
});

const eventRun = AutomationV3RunListItemSchema.parse({
    id: 'run-event-1',
    automationId: 'event-1',
    revision: 1,
    triggerId: 'event-trigger-1',
    triggerRetired: false,
    state: 'succeeded',
    cause: {
        kind: 'trigger',
        triggerId: 'event-trigger-1',
        triggerRevision: 1,
        triggerKind: 'pluginEvent',
        occurrenceKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        occurredAt: 10,
        evidence: {
            eventRef: {
                pluginId: 'happier.scm.github',
                localId: 'repository-event-v1',
            },
            sourceSelectorId: '11111111-1111-4111-8111-111111111111',
        },
    },
    dueAt: 10,
    claimedAt: null,
    startedAt: 11,
    finishedAt: 12,
    claimedByMachineId: 'machine-1',
    leaseExpiresAt: null,
    attempt: 1,
    errorCode: null,
    producedSessionId: null,
    executionDispatchState: 'settled' as const,
    executionAttempt: 1,
    replyHandoffState: 'none' as const,
    replyHandoffAttempt: 0,
    replyHandoffDueAt: null,
    createdAt: 10,
    updatedAt: 12,
});

beforeEach(async () => {
        listAutomationDefinitionsMock.mockReset();
        listAutomationDefinitionRunsMock.mockReset();
        resetServerFeaturesClientForTests();
        network = await installSessionOpsNetworkBoundary();
        const home = await network.addHome('https://automations-sync.example.test', 'automation-account');
        credentials = { token: home.token };
        requestContext = { serverId: home.id, request: createServerFetchAtEndpoint({
            serverId: home.id, endpointUrl: home.serverUrl, credentials,
        }) };
        storage.setState({ settings: { ...initialStorageState.settings, experiments: true } });
        listAutomationDefinitionsMock.mockResolvedValue({ automations: [eventSummary], nextCursor: null });
        listAutomationDefinitionRunsMock.mockResolvedValue({
            runs: [eventRun],
            nextCursor: null,
        });
        network.setHttpResponder(async (input) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json({
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
            });
            if (url.pathname === '/v3/automations') return Response.json(await listAutomationDefinitionsMock());
            if (/^\/v3\/automations\/[^/]+\/runs$/u.test(url.pathname)) return Response.json(await listAutomationDefinitionRunsMock());
            return null;
        });
    });

afterEach(async () => {
    resetServerFeaturesClientForTests();
    await network.dispose();
    vi.restoreAllMocks();
    storage.setState(initialStorageState, true);
});

describe('fetchAndApplyAutomations', () => {

    it('acquires one private definition page instead of summaries for presented saved Checks, including never-observed sources', async () => {
        const trigger = eventSummary.triggers[0];
        if (!trigger || trigger.kind !== 'pluginEvent') throw new Error('Expected Event fixture');
        const eventRef = { pluginId: 'happier.machine.services', localId: 'health-check-failed' };
        const sourceConfig = { v: 1, subject: { kind: 'environment', environmentId: 'shop' }, checks: [{
            checkId: 'site', kind: { pluginId: eventRef.pluginId, localId: 'http' }, binding: { kind: 'healthCheck' },
            config: { endpoint: 'https://shop.example/ready', expectStatus: 200 }, periodMs: 300_000, consecutiveFailuresBeforeAlerting: 1,
        }] };
        const detail = { ...eventSummary, targetType: null, existingSessionId: null,
            observationOnly: { kind: 'observationOnly', templateVersion: eventSummary.templateVersion },
            triggers: [{ ...trigger, eventRef, triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
                mode: 'plain', binding: { v: 1, automationId: eventSummary.id, triggerId: trigger.id,
                    triggerRevision: trigger.revision, triggerKind: 'pluginEvent', eventRef, sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(trigger.sourceSelectorId) },
                definition: { v: 1, sourceInstanceId: 'health:shop', sourceConfig, displayLabel: 'Shop availability',
                    automationDisplay: { name: 'Shop availability', description: 'Public readiness route' },
                    filter: null, maximumObservationAgeMs: null },
            })) }] };
        const cursors: unknown[] = [];
        network.setHttpResponder(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/account/encryption/currentness') return Response.json({
                mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
            });
            if (path === '/v3/automations/query') {
                const query = JSON.parse(String(init?.body));
                cursors.push(query.cursor ?? null);
                const second = { ...detail, id: 'event-second', triggers: [{ ...detail.triggers[0]!,
                    triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
                        mode: 'plain', binding: { v: 1, automationId: 'event-second', triggerId: trigger.id,
                            triggerRevision: trigger.revision, triggerKind: 'pluginEvent', eventRef, sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(trigger.sourceSelectorId) },
                        definition: { v: 1, sourceInstanceId: 'health:second', sourceConfig, displayLabel: 'Second readiness',
                            filter: null, maximumObservationAgeMs: null },
                    })),
                }] };
                return Response.json({ automations: [query.cursor ? second : detail], nextCursor: query.cursor ? null : 'following-page' });
            }
            if (path === '/v3/automations') return Response.json(await listAutomationDefinitionsMock());
            return null;
        });
        const applyAutomations = vi.fn<ApplyAutomations>((...args) => storage.getState().applyAutomations(...args));
        const request = { credentials, requestContext, applyAutomations, includePrivateDefinitions: true };
        const first = await fetchAndApplyAutomations(request);
        const row = storage.getState().automations[eventSummary.id]!;
        expect(row.detail.kind).toBe('available');
        expect(row.name).toBe('Shop availability');
        expect(readPluginEventAutomationPrivateDetail(row, trigger.id, { mode: 'plain' })?.storedDefinition.sourceConfig)
            .toEqual(sourceConfig);
        expect(row.lastRunAt).toBeNull();
        expect(first.nextCursor).toBe('following-page');
        expect(network.httpRequests.filter(({ url }) => new URL(url).pathname.startsWith('/v3/automations'))
            .map(({ method, url }) => [method, new URL(url).pathname])).toEqual([['POST', '/v3/automations/query']]);
        await fetchAndApplyAutomations({ ...request, cursor: 'following-page', traversalToken: first.traversalToken!,
            appendAutomations: storage.getState().appendAutomations });
        expect(cursors).toEqual([null, 'following-page']);
        expect(storage.getState().automations[eventSummary.id]?.detail.kind).toBe('available');
        expect(storage.getState().automations['event-second']?.detail.kind).toBe('available');
        expect(storage.getState().automationDefinitionNextCursor).toBeNull();
        expect(network.httpRequests.filter(({ url }) => new URL(url).pathname === '/v3/automations')).toEqual([]);
    });

    it('applies content-free summaries and refreshes already-loaded Event runs through the current API', async () => {
        const applyAutomations = vi.fn<ApplyAutomations>((...args) => storage.getState().applyAutomations(...args));
        const refreshAutomationRunsWindow = vi.fn(storage.getState().refreshAutomationRunsWindow);

        await fetchAndApplyAutomations({
            credentials, requestContext,
            applyAutomations,
            getDemandedAutomationRunIds: () => ['event-1'],
            refreshAutomationRunsWindow,
        });

        expect(applyAutomations).toHaveBeenCalledWith([expect.objectContaining({
            id: 'event-1',
            triggers: eventSummary.triggers,
            detail: { kind: 'unloaded', templateVersion: 3 },
            // The bounded list carries the owner-projected association, so a
            // session-scoped consumer never reads private detail to find it.
            linkedExistingSessionId: 'session-1',
        })], null);
        const appliedSummary = applyAutomations.mock.calls[0]?.[0]?.[0];
        expect(appliedSummary).not.toHaveProperty('triggerDefinitionEnvelope');
        expect(appliedSummary).not.toHaveProperty('templateCiphertext');
        expect(appliedSummary).not.toHaveProperty('executionRecipe');
        expect(network.httpRequests).toEqual(expect.arrayContaining([{
            method: 'GET',
            url: 'https://automations-sync.example.test/v3/automations/event-1/runs?limit=20',
            token: `Bearer ${credentials.token}`,
        }]));
        expect(refreshAutomationRunsWindow).toHaveBeenCalledWith('event-1', [eventRun], null);
        expect(storage.getState().automations['event-1']?.detail).toEqual({ kind: 'unloaded', templateVersion: 3 });
        expect(storage.getState().automationRunIdsByAutomationId['event-1']).toEqual([eventRun.id]);
    });

    it('does not turn a list refresh into a private direct-detail fanout', async () => {
        const applyAutomations = vi.fn<ApplyAutomations>((...args) => storage.getState().applyAutomations(...args));

        await fetchAndApplyAutomations({
            credentials, requestContext,
            applyAutomations,
        });

        expect(listAutomationDefinitionsMock).toHaveBeenCalledTimes(1);
        expect(network.httpRequests.filter(({ url }) => new URL(url).pathname.startsWith('/v3/automations'))
            .map(({ url }) => new URL(url).pathname)).toEqual(['/v3/automations']);
        expect(applyAutomations.mock.calls[0]?.[0]?.[0]).toMatchObject({
            detail: { kind: 'unloaded', templateVersion: 3 },
        });
    });

    it('opens one current Workflow display carrier for the list without a detail fanout', async () => {
        const privateSummary = AutomationDefinitionListItemSchema.parse({
            ...eventSummary, id: 'private-workflow', name: 'Automation', description: null,
            targetType: null, existingSessionId: null,
            executionRecipe: { v: 2, templateVersion: 3, triggerEvidence: null,
                workflow: { t: 'plain', v: {
                    workspace: { directory: '/workspace/project' }, executionTarget: { kind: 'session' },
                    display: { name: 'Nightly release review', description: 'Review the release branch every night' },
                } } },
        });
        listAutomationDefinitionsMock.mockResolvedValue({ automations: [privateSummary], nextCursor: null });
        const applyAutomations = vi.fn<ApplyAutomations>((...args) => storage.getState().applyAutomations(...args));

        await fetchAndApplyAutomations({ credentials, requestContext, applyAutomations });

        expect(applyAutomations).toHaveBeenCalledWith([expect.objectContaining({
            id: 'private-workflow', name: 'Nightly release review',
            description: 'Review the release branch every night',
        })], null);
        expect(network.httpRequests.filter(({ url }) => new URL(url).pathname.startsWith('/v3/automations'))
            .map(({ url }) => new URL(url).pathname)).toEqual(['/v3/automations']);
        expect(network.httpRequests.filter(({ url }) => new URL(url).pathname === '/v1/account/encryption/currentness')).toHaveLength(2);
    });

    it('opens list displays from the held Account observation: repeated syncs add no currentness reads', async () => {
        const privateSummary = AutomationDefinitionListItemSchema.parse({
            ...eventSummary, id: 'private-workflow', name: 'Automation', description: null,
            targetType: null, existingSessionId: null,
            executionRecipe: { v: 2, templateVersion: 3, triggerEvidence: null,
                workflow: { t: 'plain', v: {
                    workspace: { directory: '/workspace/project' }, executionTarget: { kind: 'session' },
                    display: { name: 'Nightly release review', description: 'Review the release branch every night' },
                } } },
        });
        listAutomationDefinitionsMock.mockResolvedValue({ automations: [privateSummary], nextCursor: null });
        // The real socket observation owner; only HTTP is the boundary.
        const observation = createSocketAccountEncryptionObservation({
            credentials, serverId: requestContext.serverId, endpointUrl: 'https://automations-sync.example.test',
            runtimeOrigin: 'https://automations-sync.example.test', homeCarrierEndpointId: null,
            request: requestContext.request, isCurrent: () => true,
        });
        const held = { ...requestContext, request: bindAccountEncryptionObservation(requestContext.request, observation.binding) };
        const currentnessReads = () => network.httpRequests
            .filter(({ url }) => new URL(url).pathname === '/v1/account/encryption/currentness').length;
        try {
            observation.connected();
            const applyAutomations = vi.fn<ApplyAutomations>((...args) => storage.getState().applyAutomations(...args));
            for (let sync = 0; sync < 3; sync += 1) {
                await fetchAndApplyAutomations({ credentials, requestContext: held, applyAutomations });
            }
            expect(applyAutomations).toHaveBeenLastCalledWith([expect.objectContaining({
                id: 'private-workflow', name: 'Nightly release review',
            })], null);
            // One read when the observation connects; three list syncs borrow it.
            expect(currentnessReads()).toBe(1);
        } finally {
            observation.dispose('transport-withdrawal');
        }
    });

    it('opens one current Action display carrier for the list without a detail fanout', async () => {
        const privateSummary = AutomationDefinitionListItemSchema.parse({
            ...eventSummary, id: 'private-action', name: 'Automation', description: null,
            targetType: null, existingSessionId: null,
            executionRecipe: { v: 1, templateVersion: 3, triggerEvidence: null,
                template: { t: 'plain', v: { v: 1, prompt: '',
                    actionInput: { kind: 'literal', value: { incident: 'INC-42' } },
                    display: { name: 'Refresh incident index', description: 'Run the incident action' },
                } },
                target: { kind: 'contributedAction', action: { pluginId: 'com.example.incidents', localId: 'refresh' } },
            },
        });
        listAutomationDefinitionsMock.mockResolvedValue({ automations: [privateSummary], nextCursor: null });
        const applyAutomations = vi.fn<ApplyAutomations>((...args) => storage.getState().applyAutomations(...args));

        await fetchAndApplyAutomations({ credentials, requestContext, applyAutomations });

        expect(applyAutomations).toHaveBeenCalledWith([expect.objectContaining({
            id: 'private-action', name: 'Refresh incident index',
            description: 'Run the incident action',
        })], null);
        expect(network.httpRequests.filter(({ url }) => new URL(url).pathname.startsWith('/v3/automations'))
            .map(({ url }) => new URL(url).pathname)).toEqual(['/v3/automations']);
        expect(network.httpRequests.filter(({ url }) => new URL(url).pathname === '/v1/account/encryption/currentness')).toHaveLength(2);
    });

    it('opens one current observation-only Event display carrier for the list without a detail fanout', async () => {
        const trigger = eventSummary.triggers[0];
        if (!trigger || trigger.kind !== 'pluginEvent') throw new Error('Expected plugin Event trigger fixture');
        const privateSummary = AutomationDefinitionListItemSchema.parse({
            ...eventSummary, id: 'private-event', name: 'Automation', description: null,
            targetType: null, existingSessionId: null,
            observationOnly: { kind: 'observationOnly', templateVersion: 3 },
            triggers: [{
                ...trigger,
                triggerDefinitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
                    mode: 'plain',
                    binding: {
                        v: 1, automationId: 'private-event', triggerId: trigger.id,
                        triggerRevision: trigger.revision, triggerKind: 'pluginEvent',
                        eventRef: trigger.eventRef, sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(trigger.sourceSelectorId),
                    },
                    definition: {
                        v: 1, sourceInstanceId: 'github:repository:1234',
                        sourceConfig: { repository: 'happier-dev/happier' },
                        displayLabel: 'happier-dev/happier', filter: null, maximumObservationAgeMs: null,
                        automationDisplay: { name: 'Repository alerts', description: 'Notify on repository changes' },
                    },
                })),
            }],
        });
        listAutomationDefinitionsMock.mockResolvedValue({ automations: [privateSummary], nextCursor: null });
        const applyAutomations = vi.fn<ApplyAutomations>((...args) => storage.getState().applyAutomations(...args));

        await fetchAndApplyAutomations({ credentials, requestContext, applyAutomations });

        expect(applyAutomations).toHaveBeenCalledWith([expect.objectContaining({
            id: 'private-event', name: 'Repository alerts', description: 'Notify on repository changes',
        })], null);
        expect(network.httpRequests.filter(({ url }) => new URL(url).pathname.startsWith('/v3/automations'))
            .map(({ url }) => new URL(url).pathname)).toEqual(['/v3/automations']);
        expect(network.httpRequests.filter(({ url }) => new URL(url).pathname === '/v1/account/encryption/currentness')).toHaveLength(2);
    });

    it('refreshes already-loaded run lists through the shared request-concurrency owner', async () => {
        const applyAutomations = vi.fn<ApplyAutomations>((...args) => storage.getState().applyAutomations(...args));
        const refreshAutomationRunsWindow = vi.fn(storage.getState().refreshAutomationRunsWindow);
        const loadedAutomationRunIds = Array.from({ length: 20 }, (_unused, index) => `event-${index + 1}`);
        listAutomationDefinitionsMock.mockResolvedValue({
            automations: loadedAutomationRunIds.map((id) => ({ ...eventSummary, id })),
            nextCursor: null,
        });
        let inFlight = 0;
        let peakInFlight = 0;
        listAutomationDefinitionRunsMock.mockImplementation(async () => {
            inFlight += 1;
            peakInFlight = Math.max(peakInFlight, inFlight);
            await Promise.resolve();
            inFlight -= 1;
            return { runs: [eventRun], nextCursor: null };
        });

        await fetchAndApplyAutomations({
            credentials, requestContext,
            applyAutomations,
            getDemandedAutomationRunIds: () => loadedAutomationRunIds,
            refreshAutomationRunsWindow,
        });

        // Accounts may contain high-cardinality definition catalogs without an
        // invented aggregate ceiling, so one socket invalidation must never
        // open one request per cached run list at once.
        expect(listAutomationDefinitionRunsMock).toHaveBeenCalledTimes(20);
        expect(peakInFlight).toBeLessThanOrEqual(
            loadSyncTuning().automationDefinitionDetailHydrationConcurrencyLimit,
        );
    });

    it('drops fetched automations when the captured sync scope is stale before apply', async () => {
        const applyAutomations = vi.fn<ApplyAutomations>((...args) => storage.getState().applyAutomations(...args));
        const refreshAutomationRunsWindow = vi.fn(storage.getState().refreshAutomationRunsWindow);

        await fetchAndApplyAutomations({
            credentials, requestContext,
            applyAutomations,
            getDemandedAutomationRunIds: () => ['event-1'],
            refreshAutomationRunsWindow,
            shouldContinue: () => false,
        });

        expect(applyAutomations).not.toHaveBeenCalled();
        expect(listAutomationDefinitionRunsMock).not.toHaveBeenCalled();
        expect(refreshAutomationRunsWindow).not.toHaveBeenCalled();
        expect(storage.getState().automations).toEqual(initialStorageState.automations);
    });

    it('appends an exact continuation page without replacing the current definition window', async () => {
        listAutomationDefinitionsMock.mockResolvedValue({
            automations: [{ ...eventSummary, id: 'event-2' }],
            nextCursor: 'cursor-2',
        });
        const applyAutomations = vi.fn<ApplyAutomations>((...args) => storage.getState().applyAutomations(...args));
        const appendAutomations = vi.fn(storage.getState().appendAutomations);
        const traversalToken = storage.getState().applyAutomations([createAutomationDefinitionSummary(eventSummary)], 'cursor-1')!;

        await fetchAndApplyAutomations({
            credentials, requestContext,
            cursor: 'cursor-1',
            traversalToken,
            applyAutomations,
            appendAutomations,
        });

        const listRequest = network.httpRequests.find(({ url }) => new URL(url).pathname === '/v3/automations');
        expect(listRequest?.token).toBe(`Bearer ${credentials.token}`);
        expect(new URL(listRequest!.url).searchParams.get('cursor')).toBe('cursor-1');
        expect(applyAutomations).not.toHaveBeenCalled();
        expect(appendAutomations).toHaveBeenCalledWith(
            'cursor-1',
            traversalToken,
            [expect.objectContaining({ id: 'event-2' })],
            'cursor-2',
        );
        expect(listAutomationDefinitionRunsMock).not.toHaveBeenCalled();
        expect(storage.getState().automations['event-2']?.id).toBe('event-2');
        expect(storage.getState().automationDefinitionNextCursor).toBe('cursor-2');
    });

    it('does not apply a second-page result after the Account sync scope rejoins', async () => {
        let currentScope = true;
        listAutomationDefinitionsMock.mockImplementation(async () => {
            currentScope = false;
            return {
                automations: [{ ...eventSummary, id: 'event-from-prior-account' }],
                nextCursor: null,
            };
        });
        const applyAutomations = vi.fn<ApplyAutomations>((...args) => storage.getState().applyAutomations(...args));
        const appendAutomations = vi.fn(storage.getState().appendAutomations);
        const traversalToken = storage.getState().applyAutomations([createAutomationDefinitionSummary(eventSummary)], 'prior-account-page-2')!;

        await fetchAndApplyAutomations({
            credentials, requestContext,
            cursor: 'prior-account-page-2',
            traversalToken,
            shouldContinue: () => currentScope,
            applyAutomations,
            appendAutomations,
        });

        expect(applyAutomations).not.toHaveBeenCalled();
        expect(appendAutomations).not.toHaveBeenCalled();
        expect(storage.getState().automations).not.toHaveProperty('event-from-prior-account');
    });
});

describe('fetchAndApplyAutomationRuns', () => {
    it('passes an opaque continuation cursor to the current API and applies the result only through the continuation owner', async () => {
        listAutomationDefinitionRunsMock.mockResolvedValue({
            runs: [eventRun],
            nextCursor: null,
        });
        storage.getState().applyAutomations([createAutomationDefinitionSummary(eventSummary)], null);
        const traversalToken = storage.getState().setAutomationRuns('event-1', [], 'opaque-root-page')!;
        const setAutomationRuns = vi.fn(storage.getState().setAutomationRuns);
        const appendAutomationRuns = vi.fn(storage.getState().appendAutomationRuns);

        const result = await fetchAndApplyAutomationRuns({
            credentials, requestContext,
            automationId: 'event-1',
            limit: 20,
            cursor: 'opaque-root-page',
            traversalToken,
            setAutomationRuns,
            appendAutomationRuns,
        });

        expect(network.httpRequests).toEqual(expect.arrayContaining([{
            method: 'GET',
            url: 'https://automations-sync.example.test/v3/automations/event-1/runs?limit=20&cursor=opaque-root-page',
            token: `Bearer ${credentials.token}`,
        }]));
        expect(setAutomationRuns).not.toHaveBeenCalled();
        expect(appendAutomationRuns).toHaveBeenCalledWith('event-1', 'opaque-root-page', traversalToken, [eventRun], null);
        expect(storage.getState().automationRunIdsByAutomationId['event-1']).toEqual([eventRun.id]);
        expect(result).toEqual({ nextCursor: null, traversalToken: null });
    });
});
