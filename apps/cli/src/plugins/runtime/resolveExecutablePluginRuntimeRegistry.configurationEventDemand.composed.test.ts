import axios, { AxiosHeaders, type AxiosResponse } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import {
    createPluginEventAutomationSetupResultV1JsonSchema,
    PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
    PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
} from '@happier-dev/plugin-sdk/events';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import {
    AutomationSourceSelectorIdV1Schema,
    AutomationTriggerIdSchema,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
} from '@happier-dev/protocol';
import {
    AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1,
    AutomationEventStoredDefinitionsReadHttpRequestV1Schema,
    AutomationEventStoredDefinitionsReadResultV1Schema,
} from '@happier-dev/protocol/automations/event';
import { PluginCollectionPresenceRequestV1Schema } from '@happier-dev/protocol/plugins/data/collectionPresenceV1';

import * as persistence from '@/persistence';
import { createDaemonPluginRuntimeOwner } from '@/plugins/daemon/runtimeOwner';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { loadCurrentBundledPluginLocatorResult } from '@/plugins/projection/registry/builtIn/locators';
import { createPluginRegistryStateStore } from '@/plugins/store/registry/currentState';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { clearActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { StablePluginConnectedAccountsOwner } from './invocation/services/connectedAccounts';
import { createStablePluginEventsBroker } from './invocation/services/events';

const pluginId = 'example.event-demand';
const machineId = 'machine-event-demand';
const credentials = { token: 'fixture.' + Buffer.from(JSON.stringify({ sub: 'event-demand-account' })).toString('base64url') + '.signature', encryption: null } as const;
const sourceConfigSchema = { type: 'object', additionalProperties: false } as const;
type SourceRead = ReturnType<typeof AutomationEventStoredDefinitionsReadHttpRequestV1Schema.parse>;

function httpResponse<T>(data: T): AxiosResponse<T> {
    return { data, status: 200, statusText: 'OK', headers: new AxiosHeaders(), config: { headers: new AxiosHeaders() } };
}

function sourcePage(request: SourceRead, present: boolean) {
    const triggerId = AutomationTriggerIdSchema.parse('trigger-event-demand');
    const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse('9d5af559-2c82-4c22-b6a0-ecabce38a631');
    const eventRef = { pluginId, localId: 'changed' };
    return AutomationEventStoredDefinitionsReadResultV1Schema.parse({
        kind: 'page', revision: '1', nextCursor: null,
        eventDeclarationRelease: { release: { pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}` },
        definitions: present ? [{
            automationId: 'automation-event-demand', triggerId, triggerRevision: 1,
            eventRef, sourceSelectorId, sourceContractVersion: 1,
            observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: request.caller.materialization },
            payloadSchema: { type: 'object' },
            storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({
                mode: 'plain',
                binding: { v: 1, automationId: 'automation-event-demand', triggerId, triggerRevision: 1,
                    triggerKind: 'pluginEvent', eventRef, sourceSelectorId },
                definition: { v: 1, sourceInstanceId: 'source-event-demand', sourceConfig: {},
                    displayLabel: 'Event source', filter: null, maximumObservationAgeMs: null },
            }),
        }] : [],
    });
}

function unusedConnectedAccounts(): StablePluginConnectedAccountsOwner {
    const unavailable = async () => { throw new Error('Event source fixture must not access a Connected Account'); };
    return {
        getBinding: unavailable, requestSelection: unavailable, materialize: unavailable,
        listAccounts: unavailable, materializeListedAccount: unavailable,
        watch: () => ({ dispose() {} }),
    };
}

async function createEventDemandFixture(params: Readonly<{
    present(): boolean;
    published?(): boolean;
    beforeResponse?(request: SourceRead): Promise<void>;
    beforeActivate?(): Promise<void>;
    failRead?: boolean;
    unscoped?: boolean;
    undemandedCollection?: boolean;
    accountStorageDependencies?: NonNullable<Parameters<typeof createAuthoredAdmittedPluginRuntimeFixture>[0]['runtimeOptions']>['accountStorageDependencies'];
    broker?: ReturnType<typeof createStablePluginEventsBroker>;
    eager?: boolean;
    deferConfiguredActivation?: boolean;
    actionCompletion?: boolean;
    actionCompletionPhase?: 'before';
}>) {
    const observed = { activations: 0, starts: 0, sourcePages: [] as unknown[], errors: [] as unknown[],
        requests: [] as SourceRead[], queriedBeforePublication: false,
        activeBeforeConfiguration: false, sourceReadsBeforeConfiguration: 0 };
    const broker = params.broker ?? createStablePluginEventsBroker();
    // Filesystem credentials and HTTP are the only substituted boundaries.
    // Source custody, publisher signing, activation, services and adoption stay real.
    vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, onboardingCompleted: true, machineId });
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (String(url).endsWith('/v1/account/profile')) return httpResponse({ id: 'account-event-demand' });
        if (String(url).endsWith('/v1/account/encryption/currentness')) return httpResponse({
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null,
            updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
        });
        throw new Error(`Unexpected GET ${String(url)}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        if (!String(url).endsWith(AUTOMATION_EVENT_STORED_DEFINITIONS_READ_HTTP_PATH_V1)) {
            throw new Error(`Unexpected POST ${String(url)}`);
        }
        const request = AutomationEventStoredDefinitionsReadHttpRequestV1Schema.parse(body);
        observed.requests.push(request);
        if (params.published?.() === false) {
            observed.queriedBeforePublication = true;
            // Mirrors the incumbent stored-definition route's currentness
            // refusal when its exact Machine materialization is not published.
            throw new Error('caller_materialization_not_current');
        }
        if (params.failRead) throw new Error('stored_definition_route_unavailable');
        const present = params.present();
        await params.beforeResponse?.(request);
        return httpResponse(sourcePage(request, present));
    });
    if (params.actionCompletion) {
        const rows = [{ automationId: 'action-completion', triggerId: 'after', triggerRevision: 1,
            ownerAccountId: 'event-demand-account', workflowId: 'workflow', workflowRevision: 1,
            actionIds: ['deployments.deploy'], phase: params.actionCompletionPhase ?? 'after',
            subjectKind: 'environment', subjectKey: 'private-subject-key' }];
        vi.spyOn(axios, 'request').mockResolvedValue(httpResponse({ v: 1, rows }));
        // The authenticated socket boundary supplies the current structural row to a retained Account index.
        const { applyCliActionAutomationUpdateV1 } = await import('@/api/actionAutomations');
        const { resolveServerHttpBaseUrl } = await import('@/api/client/serverHttpBaseUrl');
        applyCliActionAutomationUpdateV1({ token: credentials.token, serverHttpBaseUrl: resolveServerHttpBaseUrl(),
            body: { actionIndex: { automationId: 'action-completion', rows } } });
    }
    const plugin = definePlugin({
        id: pluginId, version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
        activation: params.eager ? { events: [{ kind: 'startup' }] } : { events: [], configuration: { automationEventSources: true } },
        actions: {
            setup: { title: 'Setup', surfaces: ['plugin'], dangerLevel: 'safe', inputSchema: sourceConfigSchema,
                resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, sourceConfigSchema),
                run: () => { throw new Error('Demand observation must not configure a source'); } },
            reset: { title: 'Reset', surfaces: ['plugin'], dangerLevel: 'safe',
                inputSchema: PluginEventAutomationHistoryGapResetActionInputV1JsonSchema,
                resultSchema: PluginEventAutomationHistoryGapResetActionResultV1JsonSchema,
                run: () => { throw new Error('Demand observation must not reset a source'); } },
        },
        events: { changed: { declaration: { kind: 'event', title: 'Changed', payloadSchema: { type: 'object' },
            automation: { v: 1, eligible: true, ...(params.actionCompletion ? { completesActionIds: ['deployments.deploy'], completionOutcome: 'failed' as const } : {}), source: { sourceContractVersion: 1,
                supportedObservationTransports: ['checkpointedPull'], sourceConfigSchema,
                setupActionRef: { pluginId, localId: 'setup' }, historyGapResetActionRef: { pluginId, localId: 'reset' },
                connectedAccountPurposeBindings: [] } },
        } } },
        backgroundServices: [{ declaration: { id: 'observer', title: 'Observer' }, runner: async context => {
            observed.starts += 1;
            try {
                observed.sourcePages.push(await context.services.actions.execute('automation.event.sources.list', {
                    transport: { kind: 'checkpointedPull' },
                }));
            } catch (error) { observed.errors.push(error); }
            await new Promise<void>(resolve => {
                if (context.signal.aborted) resolve();
                else context.signal.addEventListener('abort', () => resolve(), { once: true });
            });
        } }],
    });
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
        coldStart: true,
        plugins: [{ manifest: plugin.manifest, includeAvailability: true, files: { 'daemon.mjs': 'export function activate() {}' },
            instantiateCommittedModule: () => ({ activate: async (...args: Parameters<typeof plugin.activate>) => {
                observed.activations += 1;
                await params.beforeActivate?.();
                return await plugin.activate(...args);
            } }),
        }],
        async resolveContributes(happyHomeDir) {
            const installed = await loadInstalledPlugins({ happyHomeDir });
            return createResolvedContributionRegistry(projectLoadedPluginContributes({
                loadResult: { ...installed, loadedPlugins: [...installed.loadedPlugins,
                    ...(params.undemandedCollection ? loadCurrentBundledPluginLocatorResult().loadedPlugins
                        .filter(entry => entry.pluginId === 'happier.channels') : [])] }, provenance: 'first_party',
            }));
        },
        runtimeOptions: { resolveCurrentMachineId: () => machineId, stableEventsBroker: broker,
            ...(params.accountStorageDependencies ? { accountStorageDependencies: params.accountStorageDependencies } : {}),
            resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'server-event-demand', machineId }),
            ...(!params.unscoped ? { scopedActionRuntime: { credentials, actionsSettingsProvider: createActionSettingsProvider({
                getAccountSettings: () => accountSettingsParse({}), allowEnvironmentOverride: false,
            }) } } : {}) },
    });
    observed.activeBeforeConfiguration = fixture.registry.activatedPluginIds.has(pluginId);
    observed.sourceReadsBeforeConfiguration = observed.requests.length;
    if (!params.deferConfiguredActivation) await fixture.registry.startConfiguredActivation();
    return { fixture, observed, broker };
}

function invalidateSources(broker: ReturnType<typeof createStablePluginEventsBroker>): void {
    broker.publishHostEventEnvelope({ eventId: '@happier/automation/event-sources-invalidated', scope: { kind: 'account' }, payload: {} });
}

afterEach(() => vi.restoreAllMocks());

describe('configuration-driven Automation Event activation', () => {
    it('keeps native terminal observers dormant for only a before Action row and no Event definition', async () => {
        const { fixture, observed } = await createEventDemandFixture({ present: () => false, actionCompletion: true, actionCompletionPhase: 'before' });
        try {
            expect(observed.activations).toBe(0);
            expect(observed.starts).toBe(0);
        } finally { await fixture.dispose(); }
    });

    it('activates native terminal observers for a scoped after Action row without an Event definition', async () => {
        const { fixture, observed } = await createEventDemandFixture({ present: () => false, actionCompletion: true });
        try {
            await vi.waitFor(() => expect(observed.starts).toBe(1));
            expect(observed.activations).toBe(1);
            expect(observed.errors).toEqual([]);
        } finally { await fixture.dispose(); }
    });

    it('handles a rejected background declaration while configured source admission is still pending', async () => {
        let readStarted = false;
        let claimRefused = false;
        let releaseRead!: () => void;
        const heldRead = new Promise<void>(resolve => { releaseRead = resolve; });
        const unhandled: unknown[] = [];
        const recordUnhandled = (error: unknown) => { unhandled.push(error); };
        const { fixture, observed } = await createEventDemandFixture({ present: () => true,
            deferConfiguredActivation: true, unscoped: true, undemandedCollection: true,
            beforeResponse: async () => { readStarted = true; await heldRead; },
            accountStorageDependencies: {
                readCredentials: async () => credentials, isCurrentAccount: () => true,
                resolveAccountScopeKey: () => 'account-event-demand', resolveBaseUrl: () => 'https://data.example.test',
                http: { get: async () => { throw new Error('Unexpected declaration GET'); },
                    post: async (url, encoded) => {
                        if (url.endsWith('/v1/plugins/data/presence')) {
                            const request = PluginCollectionPresenceRequestV1Schema.parse(JSON.parse(encoded));
                            return { status: 200, data: { collections: request.collections.map(ref => ({ ...ref, present: false })), changeCursor: 1 } };
                        }
                        if (!url.endsWith('/collection-writers/claim')) throw new Error(`Unexpected declaration POST ${url}`);
                        claimRefused = true;
                        return { status: 409, data: { error: 'plugin_collection_contract_conflict' } };
                    } },
            } });
        const owner = createDaemonPluginRuntimeOwner({
            happyHomeDir: fixture.happyHomeDir, reloadController: fixture.controller,
            staleCandidateCleanup: 'disabled', connectedAccounts: unusedConnectedAccounts(),
            availabilityReporter: { report: async () => {} },
        });
        process.on('unhandledRejection', recordUnhandled);
        const initializing = owner.initialize();
        try {
            await vi.waitFor(() => expect(readStarted && claimRefused).toBe(true));
            // Node reports an unobserved rejection at the next event-loop turn;
            // the source census remains held, independent of any time budget.
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(unhandled).toEqual([]);
        } finally {
            releaseRead();
            await initializing;
            await vi.waitFor(() => expect(observed.starts).toBe(1));
            await owner.changeService.shutdown();
            await fixture.dispose();
            process.off('unhandledRejection', recordUnhandled);
        }
    });

    it('joins published configured source readiness without waiting for an undemanded declaration claim', async () => {
        let published = false;
        let initialized = false;
        let settledClaim = false;
        let releaseClaim!: () => void;
        let claimStarted = false;
        let reports = 0;
        let releaseEarlierReport!: () => void;
        const heldEarlierReport = new Promise<void>(resolve => { releaseEarlierReport = resolve; });
        const heldClaim = new Promise<void>(resolve => { releaseClaim = resolve; });
        const { fixture, observed } = await createEventDemandFixture({ present: () => true, published: () => published,
            deferConfiguredActivation: true, unscoped: true, undemandedCollection: true,
            accountStorageDependencies: {
                readCredentials: async () => credentials, isCurrentAccount: () => true,
                resolveAccountScopeKey: () => 'account-event-demand', resolveBaseUrl: () => 'https://data.example.test',
                http: { get: async () => { throw new Error('Unexpected declaration GET'); },
                    post: async (url, encoded) => {
                        if (url.endsWith('/v1/plugins/data/presence')) {
                            const request = PluginCollectionPresenceRequestV1Schema.parse(JSON.parse(encoded));
                            return { status: 200, data: { collections: request.collections.map(ref => ({ ...ref, present: false })), changeCursor: 1 } };
                        }
                        if (!url.endsWith('/collection-writers/claim')) throw new Error(`Unexpected declaration POST ${url}`);
                        const request = JSON.parse(encoded);
                        if (request.manifest.id === 'happier.channels') {
                            claimStarted = true;
                            await heldClaim;
                            settledClaim = true;
                        }
                        return { status: 200, data: {} };
                    } },
            } });
        const owner = createDaemonPluginRuntimeOwner({
            happyHomeDir: fixture.happyHomeDir, reloadController: fixture.controller,
            staleCandidateCleanup: 'disabled', connectedAccounts: unusedConnectedAccounts(),
            availabilityReporter: { report: async inventory => {
                expect(inventory.materializations.map(row => row.pluginId)).toContain(pluginId);
                // Hold an overlapping reconnect report at its genuine network
                // boundary, so initialize owns the first declaration claim.
                if (++reports === 1) await heldEarlierReport;
                published = true;
            } },
        });
        const earlierReporting = owner.reportCurrentAvailability();
        await vi.waitFor(() => expect(reports).toBe(1));
        const initializing = owner.initialize().then(() => { initialized = true; });
        try {
            await vi.waitFor(() => expect(claimStarted).toBe(true));
            await vi.waitFor(() => expect(initialized).toBe(true));
            expect(settledClaim).toBe(false);
            expect(published).toBe(true);
            expect(observed.queriedBeforePublication).toBe(false);
            expect(observed.requests.length).toBeGreaterThan(0);
            expect(observed.activations).toBe(1);
            await vi.waitFor(() => expect(observed.starts).toBe(1));
            expect(fixture.registry.activatedPluginIds.has('happier.channels')).toBe(false);
        } finally {
            releaseEarlierReport();
            releaseClaim();
            await Promise.all([earlierReporting, initializing]);
            await vi.waitFor(() => expect(settledClaim).toBe(true));
            await owner.changeService.shutdown();
            await fixture.dispose();
        }
    });

    it('queries an absent source only after the real first-start availability publication and remains dormant', async () => {
        let published = false;
        const publications: string[][] = [];
        const { fixture, observed } = await createEventDemandFixture({ present: () => false, published: () => published,
            deferConfiguredActivation: true });
        const owner = createDaemonPluginRuntimeOwner({
            happyHomeDir: fixture.happyHomeDir, reloadController: fixture.controller,
            staleCandidateCleanup: 'disabled', connectedAccounts: unusedConnectedAccounts(),
            availabilityReporter: { report: async inventory => {
                publications.push(inventory.materializations.map(row => row.pluginId));
                published = true;
            } },
        });
        try {
            const inventory = await createPluginRegistryStateStore({ happyHomeDir: fixture.happyHomeDir }).readAvailabilityInventory();
            expect(fixture.lease.durableRevision).toBe(inventory.revision);
            await owner.initialize();
            await vi.waitFor(() => expect(published).toBe(true));
            expect(publications).toContainEqual(expect.arrayContaining([pluginId]));
            expect(observed.queriedBeforePublication).toBe(false);
            expect(observed.requests).toHaveLength(1);
            expect(observed.requests[0]?.input).toEqual({ transport: { kind: 'checkpointedPull' }, pageSize: 1 });
            expect(observed.activations).toBe(0);
            expect(observed.starts).toBe(0);
        } finally {
            await owner.changeService.shutdown();
            await fixture.dispose();
        }
    });

    it.each([false, true])('starts a configured source with an adopted source page available to its real service (eager control: %s)', async eager => {
        const { fixture, observed } = await createEventDemandFixture({ present: () => true, eager });
        try {
            expect(observed.activeBeforeConfiguration).toBe(eager);
            await vi.waitFor(() => expect(observed.starts).toBe(1));
            expect(observed.activations).toBe(1);
            await vi.waitFor(() => expect(observed.errors.length + observed.sourcePages.length).toBe(1));
            expect(observed.errors).toEqual([]);
            await vi.waitFor(() => expect(observed.sourcePages).toHaveLength(1));
            expect(observed.sourcePages[0]).toMatchObject({ kind: 'page', definitions: [{ eventRef: { pluginId, localId: 'changed' } }] });
        } finally { await fixture.dispose(); }
    });

    it('activates immediately after late enrollment and retires the source invalidation subscription', async () => {
        let present = false;
        const { fixture, observed, broker } = await createEventDemandFixture({ present: () => present });
        try {
            expect(observed.activations).toBe(0);
            present = true;
            invalidateSources(broker);
            await vi.waitFor(() => expect(observed.starts).toBe(1));
            await vi.waitFor(() => expect(observed.sourcePages).toHaveLength(1));
            expect(observed.errors).toEqual([]);
        } finally { await fixture.dispose(); }
        const settledReads = observed.requests.length;
        invalidateSources(broker);
        await Promise.resolve();
        await Promise.resolve();
        expect(observed.requests).toHaveLength(settledReads);
    });

    it('catches enrollment invalidation received while the initial demand read is in flight', async () => {
        let present = false;
        let reads = 0;
        let release!: () => void;
        let began!: () => void;
        const initialRead = new Promise<void>(resolve => { began = resolve; });
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const broker = createStablePluginEventsBroker();
        const creating = createEventDemandFixture({ broker, present: () => present, beforeResponse: async () => {
            if (++reads === 1) { began(); await blocked; }
        } });
        await initialRead;
        present = true;
        invalidateSources(broker);
        // Let the real broker deliver the push before the first response.
        await Promise.resolve();
        await Promise.resolve();
        release();
        const { fixture, observed } = await creating;
        try {
            await vi.waitFor(() => expect(observed.starts).toBe(1));
            await vi.waitFor(() => expect(observed.sourcePages).toHaveLength(1));
            expect(observed.errors).toEqual([]);
        } finally { await fixture.dispose(); }
    });

    it('does not treat an empty response from a retired Account lifetime as current absence', async () => {
        setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}),
            settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'old-event-demand-account' });
        let reads = 0;
        const { fixture, observed } = await createEventDemandFixture({ present: () => false, beforeResponse: async () => {
            if (++reads === 1) clearActiveAccountSettingsSnapshot();
        } });
        try {
            // Unknown demand retains the incumbent eager recovery path. Its
            // services still enforce currentness before reading or effects.
            expect(observed.activations).toBe(1);
            await vi.waitFor(() => expect(observed.starts).toBe(1));
        } finally {
            await fixture.dispose();
            clearActiveAccountSettingsSnapshot();
        }
    });

    it('does not activate after registry retirement while an enrollment read is pending', async () => {
        let present = false;
        let reads = 0;
        let began!: () => void;
        let release!: () => void;
        const pendingRead = new Promise<void>(resolve => { began = resolve; });
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const { fixture, observed, broker } = await createEventDemandFixture({ present: () => present,
            beforeResponse: async () => {
                if (++reads === 2) { began(); await blocked; }
            },
        });
        try {
            present = true;
            invalidateSources(broker);
            await pendingRead;
            const retiring = fixture.controller.shutdown();
            release();
            await fixture.lease.release();
            await retiring;
            expect(observed.activations).toBe(0);
            expect(observed.starts).toBe(0);
        } finally {
            release();
            await fixture.dispose();
        }
    });

    it('does not start an adopted service after its held registry retires during source preparation', async () => {
        let reads = 0;
        let releasePreparation!: () => void;
        let reportPreparation!: () => void;
        const preparationStarted = new Promise<void>(resolve => { reportPreparation = resolve; });
        const blocked = new Promise<void>(resolve => { releasePreparation = resolve; });
        const { fixture, observed } = await createEventDemandFixture({ present: () => true,
            deferConfiguredActivation: true, beforeResponse: async () => {
                if (++reads !== 2) return;
                reportPreparation();
                await blocked;
            } });
        const starting = fixture.registry.startConfiguredActivation();
        // Keep cancellation observed even if it settles before the assertion.
        const settled = starting.catch(error => error);
        try {
            await preparationStarted;
            expect(observed.activations).toBe(1);
            expect(observed.starts).toBe(0);
            fixture.registry.retireLiveSubscriptionConsumers!();
            releasePreparation();
            await settled;
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(observed.starts).toBe(0);
            await expect(starting).rejects.toMatchObject({ code: 'plugin_generation_stale' });
        } finally {
            releasePreparation();
            await settled;
            await fixture.dispose();
        }
    });

    it('does not start an adopted service after its held registry retires during module activation', async () => {
        let releaseActivation!: () => void;
        let reportActivation!: () => void;
        const activationStarted = new Promise<void>(resolve => { reportActivation = resolve; });
        const blocked = new Promise<void>(resolve => { releaseActivation = resolve; });
        const { fixture, observed } = await createEventDemandFixture({ present: () => true,
            deferConfiguredActivation: true, beforeActivate: async () => {
                reportActivation();
                await blocked;
            } });
        const starting = fixture.registry.startConfiguredActivation();
        const settled = starting.catch(error => error);
        try {
            await activationStarted;
            expect(observed.activations).toBe(1);
            expect(observed.starts).toBe(0);
            fixture.registry.retireLiveSubscriptionConsumers!();
            releaseActivation();
            await settled;
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(observed.starts).toBe(0);
            await expect(starting).rejects.toMatchObject({ code: 'plugin_generation_stale' });
        } finally {
            releaseActivation();
            await settled;
            await fixture.dispose();
        }
    });

    it('recovers a failed preparation read through the same adopted source owner before disclosure', async () => {
        let reads = 0;
        const { fixture, observed } = await createEventDemandFixture({ present: () => true,
            beforeResponse: async () => {
                if (++reads === 2) throw new Error('source_preparation_transport_unavailable');
            } });
        try {
            await vi.waitFor(() => expect(observed.errors.length + observed.sourcePages.length).toBe(1));
            expect(observed.errors).toEqual([]);
            expect(observed.activations).toBe(1);
            expect(observed.starts).toBe(1);
            expect(reads).toBeGreaterThanOrEqual(3);
            expect(observed.sourcePages[0]).toMatchObject({ kind: 'page', definitions: [{ eventRef: { pluginId, localId: 'changed' } }] });
        } finally { await fixture.dispose(); }
    });

    it('retains eager service startup when an older or failed Home cannot answer source demand', async () => {
        const { fixture, observed } = await createEventDemandFixture({ present: () => false, failRead: true });
        try {
            expect(observed.activations).toBe(1);
            await vi.waitFor(() => expect(observed.starts).toBe(1));
        } finally { await fixture.dispose(); }
    });

    it.each(['missing', 'failed'] as const)('joins conservative startup through the real daemon owner with a %s availability reporter', async reporter => {
        const { fixture, observed } = await createEventDemandFixture({ present: () => false,
            failRead: true, deferConfiguredActivation: true });
        const owner = createDaemonPluginRuntimeOwner({
            happyHomeDir: fixture.happyHomeDir, reloadController: fixture.controller,
            staleCandidateCleanup: 'disabled', connectedAccounts: unusedConnectedAccounts(),
            ...(reporter === 'failed' ? { availabilityReporter: { report: async () => { throw new Error('availability_transport_unavailable'); } } } : {}),
        });
        try {
            expect(observed.activations).toBe(0);
            await owner.initialize();
            expect(observed.activations).toBe(1);
            await vi.waitFor(() => expect(observed.starts).toBe(1));
        } finally {
            await owner.changeService.shutdown();
            await fixture.dispose();
        }
    });
});
