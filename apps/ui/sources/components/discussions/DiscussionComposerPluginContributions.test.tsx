import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { changeTextTestInstance, flushHookEffects, renderWithAppProviders, standardCleanup } from '@/dev/testkit';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { DiscussionComposerValue } from './DiscussionComposer';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/discussions/discussion-1', segments: ['(app)', 'discussions', '[discussionId]'] }).module;
});

// Install only genuine transport/device boundaries before loading the real
// Sync, Administration, projection cache and Composer presentation owners.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
const { setPluginMachineExecutionOriginPreference } = await import('@/sync/domains/machines/administration/selectionPreferences');
const { normalizePluginUiProjection, EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
const { unionPluginUiProjections } = await import('@/sync/domains/plugins/ui/projectionUnion');
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { DiscussionComposerPluginContributions } = await import('./DiscussionComposerPluginContributions');
const { DiscussionComposer } = await import('./DiscussionComposer');
const { AgentInput } = await import('@/components/sessions/agentInput');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
afterAll(async () => { await network.dispose(); });

const PLUGIN_ID = 'acme.discussion';
const SERVER_IDENTITY = 'srv_discussion_composer_plugins';
const SELECTED_MACHINE = 'machine-selected';
const OTHER_MACHINE = 'machine-other';
const COMPOSER = Object.freeze({ kind: 'discussion' as const, discussionId: 'discussion-1' });
const ROSTER = DiscussionParticipantsListResponseV1Schema.parse({
    discussionId: COMPOSER.discussionId, ownerAccountId: 'account-discussion', access: 'owner', grants: [], participants: [],
});
const sourceCustody = Object.freeze({ kind: 'development' as const, registeredRootId: 'discussion-plugin-source' });
const originFor = (machineId: string) => PluginMachineExecutionOriginV1Schema.parse({
    serverIdentityId: SERVER_IDENTITY, sourceRef: { machineId, pluginId: PLUGIN_ID, sourceCustody },
});

function OfferedControls(props: Readonly<{ controlIds: readonly (string | undefined)[];
    suggestReferences(query: string, signal: AbortSignal): Promise<unknown[]>;
}>): React.ReactElement {
    return React.createElement('offered-controls', props);
}

function ControlledDiscussionComposer(props: Readonly<{
    lifetime: React.ComponentProps<typeof DiscussionComposer>['accountLifetime'];
    onSend?: React.ComponentProps<typeof DiscussionComposer>['onSend'];
}>): React.ReactElement {
    const [draft, setDraft] = React.useState<DiscussionComposerValue>({ text: 'Please review this.', mentions: [] });
    return <DiscussionComposer draftAddress={{ kind: 'discussion', discussionId: 'draft-address' }} scope={props.lifetime.scope} accountLifetime={props.lifetime}
        address={{ serverId: props.lifetime.scope.serverId }} discussionId={COMPOSER.discussionId}
        roster={ROSTER}
        availability="available" value={draft} onChange={setDraft} disabled={false} onSend={props.onSend ?? (() => {})} />;
}

function rawProjection(machineId: string, occurrenceId: string, includeOtherControls = false, referencesOnly = false) {
    const control = (pluginId: string, localId: string, scopes: readonly string[]) => ({
        id: `${pluginId}/${localId}`, pluginId, identity: { pluginId, localId }, occurrenceId,
        definition: { id: localId, label: `${machineId}:${localId}`, icon: 'preview', scopes, defaultPlacement: 'pinned',
            interaction: { kind: 'action', action: 'review' } },
    });
    return PluginProjectionV2Schema.parse({
        v: 2, generation: 7,
        installedPackagesById: { [PLUGIN_ID]: { id: PLUGIN_ID, displayName: 'Discussion helper', version: '1.0.0',
            enabled: true, occurrenceId, source: { kind: 'localPath', locator: 'discussion-plugin-source' },
            sourceCustody, executionOrigin: originFor(machineId), executionTarget: { default: 'installation' } } },
        familiesById: { composerControls: { family: 'composerControls', entriesById: {
            ...(!referencesOnly ? { [`${PLUGIN_ID}/review`]: control(PLUGIN_ID, 'review', ['discussion']) } : {}),
            ...(includeOtherControls ? {
                'other.plugin/leak': control('other.plugin', 'leak', ['discussion']),
                [`${PLUGIN_ID}/session-only`]: control(PLUGIN_ID, 'session-only', ['session']),
            } : {}),
        } } },
        contributionIntrospection: { version: 1, generation: 7, diagnostics: [], contributions: [{
            version: 1, occurrenceId,
            contribution: { kind: 'localId', pluginId: PLUGIN_ID, family: 'composerReferences', qualifiedId: `${PLUGIN_ID}/issues`, localId: 'issues' },
            progression: { declared: true, normalized: true, merged: true },
            registration: { requirement: 'required', state: 'bound', occurrenceId }, activation: { state: 'active', occurrenceId },
            projection: { state: 'projected' }, consumer: 'composer-reference-host', platforms: ['cli', 'ios'], diagnostics: [],
            presentation: { kind: 'composerReference', title: 'Issues', icon: 'search', triggers: ['@'] },
        }] },
    });
}

describe('Discussion Composer installed-plugin contributions', () => {
    let serverId: string;
    let lifetime: NonNullable<ReturnType<typeof captureActiveServerAccountScopeLifetime>>;
    let responseProjection: ReturnType<typeof rawProjection>;
    const requestedMachines: string[] = [];
    const referenceRequests: string[] = [];

    beforeEach(async () => {
        network.resetRequests();
        storage.setState(storage.getInitialState(), true);
        clearDaemonMergedProjectionCacheForTests();
        requestedMachines.length = 0;
        referenceRequests.length = 0;
        const url = 'https://discussion-composer-plugins.example.test';
        await network.addHome(url, 'account-discussion');
        await setServerProfileIdentityForUrl(url, SERVER_IDENTITY);
        const home = await network.addHome(url, 'account-discussion');
        serverId = home.id;
        network.setHttpResponder(async (input, init) => {
            const pathname = new URL(String(input)).pathname;
            return pathname === '/v1/machines'
                ? Response.json([OTHER_MACHINE, SELECTED_MACHINE].map(id => createPlainMachineRowFixture({ id, accountId: 'account-discussion' })))
                : createEmptyAccountBootstrapHttpResponse(pathname, init);
        });
        responseProjection = rawProjection(SELECTED_MACHINE, 'occurrence-a', true);
        network.setRpcAckResponder(async request => {
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_COMPOSER_REFERENCE_SEARCH) {
                referenceRequests.push(request.targetId);
                return { ok: true, result: { ok: true, reference: { pluginId: PLUGIN_ID, localId: 'issues' },
                    page: [{ id: 'issue-42', label: 'Issue 42' }] } };
            }
            if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
            }
            requestedMachines.push(request.targetId);
            return { ok: true, result: { protocolVersion: 1, projection: responseProjection } };
        });
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        await waitForHomeGovernance(() => expect(storage.getState().endpointStatus).toBe('online'));
        const captured = captureActiveServerAccountScopeLifetime();
        if (!captured) throw new Error('Account restoration must establish the real lifetime');
        lifetime = captured;
        const machines = [OTHER_MACHINE, SELECTED_MACHINE].map(id => createMachineFixture({ id, activeAt: Date.now() }));
        storage.setState({ isDataReady: true, machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
            machineListByServerId: { [serverId]: machines, [SERVER_IDENTITY]: machines },
            machineListStatusByServerId: { [serverId]: 'idle', [SERVER_IDENTITY]: 'idle' },
            settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1:
                setPluginMachineExecutionOriginPreference({}, PLUGIN_ID, originFor(SELECTED_MACHINE)) } });
        clearDaemonMergedProjectionCacheForTests();
    });

    afterEach(async () => {
        standardCleanup();
        clearPluginAccountAvailabilityProjection();
        clearDaemonMergedProjectionCacheForTests();
        await disconnectActiveServerConnection();
        await serverScopedRpcSocketPool.stopAll();
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
    });

    function accountProjection(phase: 'current' | 'unavailable' = 'current', referencesOnly = false) {
        return unionPluginUiProjections([OTHER_MACHINE, SELECTED_MACHINE].map(machineId => ({
            machineId, serverId, serverIdentityId: SERVER_IDENTITY, phase, interactionEnabled: phase === 'current',
            projection: normalizePluginUiProjection(rawProjection(machineId, 'occurrence-a', false, referencesOnly)),
        })), new Map([[PLUGIN_ID, originFor(SELECTED_MACHINE)]])).pluginUiProjection;
    }

    function renderContributions(projection = accountProjection(), enabled = true, content?: React.ReactNode) {
        return <AppShellPluginUiProjectionValueProvider value={{
            pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
            machineId: null, serverId: null, platform: 'ios', accountLifetime: lifetime,
            reloadConnectedAccountProjection() {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {},
        }}>{content ?? <DiscussionComposerPluginContributions composer={COMPOSER} lifetime={lifetime} enabled={enabled}>
            {slots => <OfferedControls controlIds={slots.extraActionChips.map(chip => chip.controlId)} suggestReferences={slots.suggestReferences} />}
        </DiscussionComposerPluginContributions>}</AppShellPluginUiProjectionValueProvider>;
    }

    it.each(['fresh Discussion route', 'transient Home loss'] as const)('discovers a cold portable Discussion contributor: %s, without warming or Machines navigation', async (sequence) => {
        const { PluginMachineMaterializationV1Schema, PluginReleaseFactsV1Schema,
            PluginAvailabilityIntentsListActionOutputV1Schema,
            PluginAccountAvailabilityIntentReadResponseV1Schema } = await import('@happier-dev/protocol/plugins/availability');
        const { buildDeferredDaemonProjectionSections } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
        const { replacePluginAccountAvailabilityProjection, readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
        const { AppShellPluginUiProjectionProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
        const { publishMachineContributionRegistryProjectionRefresh } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
        const { readMachineActivity } = await import('@/sync/domains/machines/machineActivity');
        const materializationId = 'cold-portable-discussion';
        const origin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: SERVER_IDENTITY,
            materializationRef: { machineId: SELECTED_MACHINE, materializationId, pluginId: PLUGIN_ID } });
        const projectedControl = responseProjection.familiesById.composerControls!.entriesById[`${PLUGIN_ID}/review`]!;
        const control = { ...projectedControl, definition: { ...projectedControl.definition,
            interaction: { kind: 'action' as const, action: 'review-action' },
        } };
        const release = PluginReleaseFactsV1Schema.parse({
            ref: { pluginId: PLUGIN_ID, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: { schemaVersion: 2, id: PLUGIN_ID, version: '1.0.0', displayName: 'Discussion helper',
                engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
                contributes: {
                    actions: [{ id: 'review-action', title: 'Review', surfaces: ['ui'], scopes: ['global'],
                        dangerLevel: 'safe', placementBindings: [],
                        execution: { target: 'daemon' }, inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                        resultSchema: { type: 'null' } }],
                    composerControls: [control.definition],
                } },
            collectionContracts: [], uiSlots: [],
            packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] },
        });
        expect(release.normalizedManifest.contributes.composerControls).toHaveLength(1);
        expect(release.normalizedManifest.contributes.actions).toHaveLength(1);
        const materialization = PluginMachineMaterializationV1Schema.parse({
            serverIdentityId: SERVER_IDENTITY, machineId: SELECTED_MACHINE, materializationId, pluginId: PLUGIN_ID,
            version: '1.0.0', sourceClass: 'registryPackage', portableRelease: true, enabled: true, trustState: 'trusted',
            archiveDigestSha256: release.archiveDigestSha256, declaredManifest: release.normalizedManifest,
            declaredUiEntries: {}, uiArtifacts: [], observedAt: Date.now(),
        });
        const snapshots = [{ serverIdentityId: SERVER_IDENTITY, machineId: SELECTED_MACHINE, materializations: [materialization] }];
        const intentRead = { pluginId: PLUGIN_ID, response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
            availabilityCursor: 1, hostingCapability: { enabled: false }, intent: null, release,
            packageAssets: [], uiArtifacts: [],
        }) };
        const { PluginAvailabilityActionHttpPathsV1 } = await import('@happier-dev/protocol/plugins/availability');
        let machineOnline = true;
        let machineObservedAt = Date.now();
        network.setHttpResponder(async (input, init) => {
            const pathname = new URL(String(input)).pathname;
            if (pathname === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read']) {
                // R43s's immutable Account releases carried these empty retired
                // families. Preserve that captured wire at the HTTP boundary;
                // the production stored-manifest reader, not the fixture, admits it.
                const retainedRelease = sequence === 'fresh Discussion route' ? { ...release,
                    normalizedManifest: { ...release.normalizedManifest, contributes: {
                        ...release.normalizedManifest.contributes, commands: [], tools: [],
                    } },
                } : release;
                return Response.json({ availabilityCursor: 1, snapshots, releases: [retainedRelease] });
            }
            if (pathname === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list']) {
                return Response.json(PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1,
                    pluginIds: [], intentReads: [intentRead], failedPluginIds: [] }));
            }
            return pathname === '/v1/machines'
                ? Response.json([OTHER_MACHINE, SELECTED_MACHINE].map(id => createPlainMachineRowFixture({ id, accountId: 'account-discussion',
                    machine: createMachineFixture({ id, active: id !== SELECTED_MACHINE || machineOnline, activeAt: machineObservedAt }) })))
                : createEmptyAccountBootstrapHttpResponse(pathname, init);
        });
        if (sequence === 'transient Home loss') {
            replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
                availabilityCursor: 1, materializations: [materialization], snapshots, releases: [release], intentReads: [intentRead],
            } });
        }
        responseProjection = PluginProjectionV2Schema.parse({ ...responseProjection,
            familiesById: { ...responseProjection.familiesById, composerControls: {
                ...responseProjection.familiesById.composerControls,
                entriesById: { ...responseProjection.familiesById.composerControls!.entriesById, [control.id]: control },
            } },
            installedPackagesById: { [PLUGIN_ID]: { ...responseProjection.installedPackagesById[PLUGIN_ID],
                source: { kind: 'registryPackage', locator: PLUGIN_ID }, sourceCustody: undefined, executionOrigin: origin } },
        });
        const deferred = buildDeferredDaemonProjectionSections({ protocolVersion: 1, projectionDigest: 'c'.repeat(64), projection: responseProjection });
        // The loaded R43u consumer restarted an unrestricted catalog read after
        // Composer discovery completed. An unrelated Agent section may remain
        // pending; it must not delay an admitted Discussion control.
        let releaseAgentCatalog!: () => void;
        const agentCatalog = new Promise<void>(resolve => { releaseAgentCatalog = resolve; });
        let agentCatalogRequested = false;
        network.setRpcAckResponder(async request => {
            if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { ok: false, error: 'Unsupported fixture RPC', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
            }
            requestedMachines.push(request.targetId);
            if (!machineOnline) return { ok: false, error: 'Fixture Home transport unavailable' };
            const { DaemonContributionRegistryProjectionDescribeRequestSchema} = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
            const question = DaemonContributionRegistryProjectionDescribeRequestSchema.parse(request.payload);
            if (question.selection !== undefined) throw new Error('Expected shared Composer discovery');
            if (question.sectionRead?.digest === deferred.manifest.sections.agentsById) {
                agentCatalogRequested = true;
                await agentCatalog;
            }
            return { ok: true, result: question.sectionRead ? deferred.read(question.sectionRead.digest,
                question.sectionRead.offset, question.sectionRead.includeDigests) : deferred.manifest };
        });
        storage.setState({ settings: { ...storage.getState().settings, machineAdministrationTargetsLocalV1: {} } });
        if (sequence === 'fresh Discussion route') {
            await disconnectActiveServerConnection();
            clearPluginAccountAvailabilityProjection();
            clearDaemonMergedProjectionCacheForTests();
            const home = await network.addHome('https://discussion-composer-plugins.example.test', 'account-discussion');
            await restoreConnectionToActiveServer({ token: home.token });
            const current = captureActiveServerAccountScopeLifetime();
            if (!current) throw new Error('Fresh Account must establish its lifetime');
            lifetime = current;
        }
        const render = (enabled: boolean) => <AppShellPluginUiProjectionProvider>
            {sequence === 'fresh Discussion route' ? <ControlledDiscussionComposer lifetime={lifetime} /> :
            <DiscussionComposerPluginContributions composer={COMPOSER} lifetime={lifetime} enabled={enabled}>
                {slots => <OfferedControls controlIds={slots.extraActionChips.map(chip => chip.controlId)} suggestReferences={slots.suggestReferences} />}
            </DiscussionComposerPluginContributions>}
        </AppShellPluginUiProjectionProvider>;
        const offered = () => sequence === 'fresh Discussion route'
            ? rendered.tree.root.findByType(AgentInput).props.extraActionChips?.map(chip => chip.controlId) ?? []
            : rendered.tree.root.findByType(OfferedControls).props.controlIds;
        const rendered = await renderWithAppProviders(render(false));
        try {
            if (sequence === 'transient Home loss') {
            await flushHookEffects();
            vi.useFakeTimers();
            await flushHookEffects({ advanceTimersMs: 180_000, cycles: 1 });
            vi.useRealTimers();
            expect(requestedMachines).toEqual([]);
            const withdrawnAt = Math.max(Date.now(), (readMachineActivity(storage.getState().machines[SELECTED_MACHINE]!)?.activeAt ?? 0) + 1);
            machineOnline = false;
            machineObservedAt = withdrawnAt;
            await act(async () => {
                storage.setState({ endpointStatus: 'offline' });
                storage.getState().applyMachines([createMachineFixture({ id: SELECTED_MACHINE, active: false, activeAt: withdrawnAt })],
                    true, { sourceServerId: serverId });
            });
            await rendered.update(render(true));
            await flushHookEffects();
            expect(rendered.tree.root.findByType(OfferedControls).props.controlIds).toEqual([]);
            // Unknown presence may perform the owning hook's first read, but
            // an unavailable Home must not turn that demand into a poll.
            const outageReads = requestedMachines.length;
            vi.useFakeTimers();
            await flushHookEffects({ advanceTimersMs: 180_000, cycles: 1 });
            vi.useRealTimers();
            expect(requestedMachines).toHaveLength(outageReads);
            machineOnline = true;
            machineObservedAt = withdrawnAt + 1;
            await act(async () => {
                storage.setState({ endpointStatus: 'online' });
                storage.getState().applyMachines([createMachineFixture({ id: SELECTED_MACHINE, active: true, activeAt: withdrawnAt + 1 })],
                    true, { sourceServerId: serverId });
                publishMachineContributionRegistryProjectionRefresh();
            });
            }
            // The real Sync refresh must retain installed release custody:
            // a manifest alone is descriptive, not executable admission.
            await waitForHomeGovernance(() => expect(readPluginAccountAvailability(lifetime.scope).classifyRelease(materialization).validation.kind)
                .toBe('admitted'));
            await waitForHomeGovernance(() => sequence === 'fresh Discussion route'
                ? expect(offered()).toContain(`plugin:control:${PLUGIN_ID}/review`)
                : expect(offered()).toEqual([`plugin:control:${PLUGIN_ID}/review`]));
            expect(agentCatalogRequested).toBe(false);
            expect(new Set(requestedMachines)).toEqual(new Set([SELECTED_MACHINE]));
            const settledReads = requestedMachines.length;
            vi.useFakeTimers();
            await flushHookEffects({ advanceTimersMs: 180_000, cycles: 1 });
            vi.useRealTimers();
            expect(requestedMachines).toHaveLength(settledReads);
        } finally { releaseAgentCatalog(); vi.useRealTimers(); await rendered.unmount(); }
    });

    it('renders only the selected source control in the actual Discussion chip rail and withdraws it with projection and scope', async () => {
        const composer = <ControlledDiscussionComposer lifetime={lifetime} />;
        const renderComposer = (projection = accountProjection()) => renderContributions(projection, true, composer);
        const rendered = await renderWithAppProviders(renderComposer());
        const chipHosts = (id: string) => rendered.tree.root.findAll(node => typeof node.type === 'string'
            && node.props.testID === `plugin-composer-control:${id}`);
        await waitForHomeGovernance(() => expect(chipHosts(`${PLUGIN_ID}/review`).length).toBeGreaterThan(0));
        expect(chipHosts(`${PLUGIN_ID}/review`)[0]!.props.accessibilityLabel).toBe(`${SELECTED_MACHINE}:review`);
        expect(chipHosts('other.plugin/leak')).toEqual([]);
        expect(chipHosts(`${PLUGIN_ID}/session-only`)).toEqual([]);
        expect(requestedMachines.length).toBeGreaterThan(0);
        expect(new Set(requestedMachines)).toEqual(new Set([SELECTED_MACHINE]));
        await rendered.update(renderComposer(EMPTY_PLUGIN_UI_PROJECTION));
        expect(chipHosts(`${PLUGIN_ID}/review`)).toEqual([]);
        await rendered.update(renderComposer());
        await waitForHomeGovernance(() => expect(chipHosts(`${PLUGIN_ID}/review`).length).toBeGreaterThan(0));
        await act(async () => storage.getState().activateProfileScope({ serverId, accountId: 'replacement-account' }));
        await rendered.update(renderComposer());
        expect(lifetime.isCurrent()).toBe(false);
        expect(chipHosts(`${PLUGIN_ID}/review`)).toEqual([]);
        await rendered.unmount();
    });

    it('refuses a cached daemon replacement occurrence until the Account supply matches it', async () => {
        responseProjection = rawProjection(SELECTED_MACHINE, 'occurrence-b', true);
        const cached = await loadDaemonMergedProjectionCacheEntry({ sections: 'complete', machineId: SELECTED_MACHINE, serverId, accountLifetime: lifetime });
        expect(cached?.kind).toBe('ready');
        if (cached?.kind !== 'ready') throw new Error('The genuine daemon cache must contain the replacement fixture');
        expect(cached.inputs.pluginProjectionById[PLUGIN_ID]?.occurrenceId).toBe('occurrence-b');
        const rendered = await renderWithAppProviders(renderContributions());
        await flushHookEffects({ cycles: 3, turns: 2 });
        expect(new Set(requestedMachines)).toEqual(new Set([SELECTED_MACHINE]));
        expect(rendered.tree.root.findByType(OfferedControls).props.controlIds).toEqual([]);
        await rendered.unmount();
    });

    it('demands declared reference search only for a query and withdraws it with the selected source', async () => {
        const onSend = vi.fn();
        const composer = <ControlledDiscussionComposer lifetime={lifetime} onSend={onSend} />;
        const rendered = await renderWithAppProviders(renderContributions(accountProjection(), true, composer));
        await waitForHomeGovernance(() => expect(rendered.tree.root.findAll(node =>
            typeof node.type === 'string' && node.props.testID === `plugin-composer-control:${PLUGIN_ID}/review`).length).toBeGreaterThan(0));
        expect(referenceRequests).toEqual([]);
        const input = () => rendered.tree.root.findByType('HappierComposerInput');
        await act(async () => { input().props.onComposerFocus?.(); changeTextTestInstance(input(), '@issue'); });
        await waitForHomeGovernance(() => expect(rendered.tree.root.findAll(node => node.props.children === 'Issue 42').length).toBeGreaterThan(0));
        expect(referenceRequests).toEqual([SELECTED_MACHINE]);
        const candidate = rendered.tree.root.findAll(node => typeof node.type === 'string'
            && typeof node.props.onPress === 'function'
            && node.findAll(child => child.props.children === 'Issue 42').length > 0).at(-1);
        if (!candidate) throw new Error('The native picker must offer the declared reference as a pressable row');
        await act(async () => { candidate.props.onPress(); });
        const token = '[Issue 42](happier-ref:composerReference:issue-42)';
        await flushHookEffects();
        expect(input().props.value).toBe(`${token} `);
        await act(async () => {
            rendered.tree.root.findAll(node => node.props.testID === 'new-session-composer-send'
                && typeof node.props.onPress === 'function')[0]!.props.onPress();
        });
        expect(onSend).toHaveBeenCalledWith({ v: 1, parts: [{ t: 'reference', reference: {
            kind: 'happier.composerReference', ref: 'composerReference:issue-42', label: 'Issue 42', token,
            composerReference: { pluginId: PLUGIN_ID, localId: 'issues' }, composerReferenceTrigger: '@',
        } }, { t: 'text', text: ' ' }] });
        await rendered.update(renderContributions(EMPTY_PLUGIN_UI_PROJECTION, true, composer));
        const suggest = () => {
            const source = rendered.tree.root.findByType(AgentInput).props.autocompleteSuggestions;
            if (typeof source !== 'function') throw new Error('The Discussion Composer must provide its composed suggestion handler');
            return source('@issue', new AbortController().signal, () => {});
        };
        expect(await suggest()).not.toContainEqual(expect.objectContaining({ kind: 'composerReference' }));
        expect(referenceRequests).toEqual([SELECTED_MACHINE]);
        await rendered.unmount();
    });

    it('offers no control and invents no Machine when declarations or an executable supply are absent', async () => {
        const rendered = await renderWithAppProviders(renderContributions(EMPTY_PLUGIN_UI_PROJECTION));
        const offered = () => rendered.tree.root.findByType(OfferedControls).props.controlIds;
        expect(offered()).toEqual([]);
        expect(requestedMachines).toEqual([]);
        await rendered.update(renderContributions(accountProjection('unavailable')));
        await flushHookEffects();
        expect(offered()).toEqual([]);
        expect(requestedMachines).toEqual([]);
        await rendered.update(renderContributions(accountProjection(), false));
        expect(offered()).toEqual([]);
        expect(requestedMachines).toEqual([]);
        await rendered.unmount();
    });

    it('keeps a reference-only plugin cold until search and reuses the same admitted acquisition on repeated queries', async () => {
        responseProjection = rawProjection(SELECTED_MACHINE, 'occurrence-a', false, true);
        const rendered = await renderWithAppProviders(renderContributions(accountProjection('current', true)));
        await flushHookEffects({ cycles: 3, turns: 2 });
        expect(requestedMachines).toEqual([]);
        expect(referenceRequests).toEqual([]);
        const suggest = () => rendered.tree.root.findByType(OfferedControls).props.suggestReferences('@issue', new AbortController().signal);
        expect(await suggest()).toContainEqual(expect.objectContaining({ kind: 'composerReference' }));
        expect(await suggest()).toContainEqual(expect.objectContaining({ kind: 'composerReference' }));
        expect(requestedMachines).toEqual([SELECTED_MACHINE]);
        expect(referenceRequests).toEqual([SELECTED_MACHINE, SELECTED_MACHINE]);
        await rendered.unmount();
    });
});
