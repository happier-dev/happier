import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability';
import { ApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PluginSettingsContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/settings';
import { PluginAccountSettingsMutationRequestV1Schema, PluginAccountSettingsValuesV1Schema } from '@happier-dev/protocol/plugins/settings/accountSettingsV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { projectPluginSettingsContributionV2, PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';

// Only Home HTTP, device credentials and disconnected sockets are replaced.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
const { replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');

beforeEach(async () => { await homes.reset(); await loadSyncSingletonForTests(); });
afterEach(async () => {
    clearPluginAccountAvailabilityProjection();
    await disconnectActiveServerConnection();
    await homes.reset();
});

describe('Plugin Settings through the default Account Action host', () => {
    it('reads and changes bundled Claude Account preferences without a selected machine or Account-installed release', async () => {
        const serverUrl = 'https://bundled-settings-actions.test';
        const serverId = await homes.addHome({ name: 'Bundled Settings Home', serverUrl, serverIdentityId: 'srv_bundled_settings',
            accountId: 'alice', currentAccount: true });
        const home = homes.findByServerUrl(serverUrl);
        if (!home?.token) throw new Error('Missing bundled Settings Home credential');
        await restoreConnectionToActiveServer({ token: home.token });
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected applied bundled Settings Account');
        replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1,
            intentReads: [], materializations: [], snapshots: [], inventoryComplete: true } });
        const pluginId = 'happier.agent.claude';
        const path = `/v1/account/plugin-settings/${pluginId}`;
        let revision = 7;
        let values: Record<string, unknown> = { claudeUnifiedTerminalEnabled: false, claudeRemoteAgentSdkEnabled: true,
            claudeUnifiedTerminalWorkspaceTrust: 'ask_every_time' };
        homes.answer(serverId, path, { select: () => ({ body: { status: 'present', revision,
            content: { t: 'plain', v: { v: 1, values } } } }) });
        homes.answer(serverId, `POST ${path}`, { select: input => {
            const write = PluginAccountSettingsMutationRequestV1Schema.parse(input);
            expect(write.expectedRevision).toBe(revision);
            if (write.content?.t !== 'plain') throw new Error('Plain Account Settings required');
            values = PluginAccountSettingsValuesV1Schema.parse(write.content.v).values;
            return { body: { status: 'updated', revision: ++revision } };
        } });
        const executor = createDefaultActionExecutor();
        const input = { pluginId, scope: { kind: 'account' }, target: { kind: 'account' }, localId: 'claudeUnifiedTerminalEnabled' };
        const context = { serverId, expectedAccountId: 'alice', surface: 'ui' as const };
        const read = await executor.execute('plugins.settings.get', input, context);
        expect(read, JSON.stringify(read)).toMatchObject({ ok: true, result: { data: { value: false, revision: '7' } } });
        const write = await executor.execute('plugins.settings.set', { ...input, value: true, expectedRevision: '7' }, context);
        expect(write, JSON.stringify(write)).toMatchObject({ ok: true, result: { data: { revision: '8' } } });
        expect(values).toEqual({ claudeUnifiedTerminalEnabled: true, claudeRemoteAgentSdkEnabled: true,
            claudeUnifiedTerminalWorkspaceTrust: 'ask_every_time' });
        await homes.requireUiApproval(serverId, 'plugins.settings.set');
        homes.answer(serverId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, actions: { 'plugins.settings.set': { approvalRequiredSurfaces: ['ui'] } } },
        } } } });
        const proposed = await executor.execute('plugins.settings.set', {
            ...input, localId: 'claudeRemoteAgentSdkEnabled', value: false, expectedRevision: '8',
        }, { ...context, externalActionTarget: { kind: 'machine', machineId: 'origin-machine' } });
        expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        const { artifactId } = ActionApprovalRequestCreatedResultSchema.parse(proposed.ok ? proposed.result : null);
        const approval = ApprovalRequestSchema.parse(JSON.parse(homes.artifacts(serverId).readPlainBody(artifactId) ?? 'null'));
        expect(approval).toMatchObject({ v: 2, executionOriginV1: { surface: 'ui', authority: 'present_user', accountId: 'alice',
            machineId: 'origin-machine', target: { kind: 'machine', machineId: 'origin-machine' } } });
        expect(await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, context))
            .toMatchObject({ ok: true, result: { status: 'executed' } });
        expect(values.claudeRemoteAgentSdkEnabled).toBe(false);
        replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 2,
            intentReads: [{ pluginId, response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
                availabilityCursor: 2, hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
                intent: { pluginId, desiredVersion: '9.0.0', enabled: true, offlineUiHosting: 'enabled', writableCollections: [], revision: 'selected-release' },
                release: null, packageAssets: [], uiArtifacts: [],
            }) }], materializations: [], snapshots: [], inventoryComplete: true } });
        expect(await executor.execute('plugins.settings.get', input, context))
            .toMatchObject({ ok: false, errorCode: 'plugin_settings_unavailable' });
    });

    it('keeps source Settings current across unrelated registry generations while admitting fresh declaration changes', async () => {
        const serverUrl = 'https://source-settings-actions.test';
        const pluginId = 'acme.source-settings';
        const machineId = 'source-machine';
        const identity = 'srv_source_settings';
        const serverId = await homes.addHome({ name: 'Source Settings Home', serverUrl, serverIdentityId: identity,
            accountId: 'alice', currentAccount: true });
        const origin = { serverIdentityId: identity, sourceRef: { machineId, pluginId,
            sourceCustody: { kind: 'development' as const, registeredRootId: 'source-root' } } };
        // The real page can use Administration's sole admitted source without
        // persisting an explicit preference.
        const settings = { machineAdministrationSelectionsV1: { v: 1, pluginExecutionOriginsByPluginId: {} } };
        homes.answer(serverId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: settings } } });
        homes.answer(serverId, '/v1/machines', { body: [createPlainMachineRowFixture({ id: machineId, accountId: 'alice' })] });
        homes.answer(serverId, `/v1/machines/${machineId}`, { body: {
            machine: createPlainMachineRowFixture({ id: machineId, accountId: 'alice' }),
        } });
        const definition = PluginSettingsContributionV2Schema.parse({ id: 'preferences', title: 'Preferences', scope: 'account',
            target: { kind: 'plugin' }, fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' } }] });
        const projectedSettings = projectPluginSettingsContributionV2({ pluginId, definition });
        let projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {}, actionsById: {},   resourcesById: {},
            settingsById: { [projectedSettings.id]: projectedSettings }, diagnostics: [], installedPackagesById: {
                [pluginId]: { id: pluginId, displayName: 'Source Settings', version: '1.0.0', enabled: true,
                    source: { kind: 'localPath', locator: 'source-root' }, occurrenceId: 'source-occurrence',
                    executionOrigin: origin, sourceCustody: origin.sourceRef.sourceCustody },
            }, familiesById: { pluginUi: { family: 'pluginUi', entriesById: { home: {
                id: 'home', pluginId, occurrenceId: 'source-occurrence', executionOrigin: origin,
                contributionKind: 'surfacePlacement', descriptorId: 'home',
                binding: normalizePluginUiDestinationBindingV1({ pluginId, destinationId: 'home', rendererId: 'home',
                    container: 'appPage', target: { kind: 'app' } }),
                target: { kind: 'app' }, renderer: { kind: 'hostedHtml', contributionId: 'home',
                    source: artifactHtmlBundleFromBodyV1('<p>Settings</p>'), requiredHostMethods: ['context'] },
                display: {}, headerActions: [], availability: { state: 'available', reason: 'available', diagnostics: [] },
            } } } } });
        let transportReady = false;
        const home = homes.findByServerUrl(serverUrl);
        if (!home?.token) throw new Error('Missing source Settings Home credential');
        const connection = await restoreServerAccountForTest({ serverUrl, serverIdentityId: identity, accountId: 'alice',
            credentials: { token: home.token }, request: homes.request, configureSocket: socket => {
                vi.mocked(socket.connect).mockImplementation(() => {
                    if (transportReady) { socket.connected = true; for (const listener of socket.listeners('connect')) listener(); }
                    return socket;
                });
                vi.spyOn(socket, 'timeout').mockReturnValue(socket);
                vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload) => {
                    if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
                    if (!payload || typeof payload !== 'object' || !('method' in payload)
                        || payload.method !== `${machineId}:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`)
                        throw new Error('Account Settings must not call a daemon storage method');
                    return { ok: true, result: { protocolVersion: 1, projection } };
                });
            } });
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
        const { createPluginUiExecutionOriginCandidatePublication, unionPluginUiProjections, readPluginUiExecutionOriginCandidates } = await import('@/sync/domains/plugins/ui/projectionUnion');
        const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
        const { readPluginAccountAvailability } = await import('@/sync/domains/plugins/availability/projection');
        const { resolveFreshPluginMachineExecutionOrigin } = await import('@/sync/domains/machines/administration/usePluginExecutionOriginSelection');
        const { loadDaemonMergedProjectionInputs, readCachedDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
        const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Missing source Settings Account lifetime');
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now());
        const machine = createMachineFixture({ id: machineId, activeAt: Date.now(), storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
        storage.setState({ profileScope: lifetime.scope, settingsScope: lifetime.scope, settings: settingsParse(settings), settingsVersion: 1,
            isDataReady: true, machines: { [machineId]: machine }, machineListByServerId: { [connection.home.id]: [machine] },
            machineListStatusByServerId: { [connection.home.id]: 'idle' } });
        const readModel = () => unionPluginUiProjections([{ machineId, serverId: connection.home.id, serverIdentityId: identity,
            phase: 'current', interactionEnabled: true, projection: normalizePluginUiProjection(projection) }]).pluginUiProjection;
        const model = readModel();
        let currentModel = model;
        const candidates = createPluginUiExecutionOriginCandidatePublication();
        candidates.publish(model, [], [pluginId]);
        const publishCurrentSource = () => {
            currentModel = readModel();
            candidates.publish(currentModel, [], [pluginId]);
        };
        const invalidateProjection = () => publishMachineContributionRegistryProjectionInvalidation({ machineId, serverId: connection.home.id });
        const unpublish = publishCommittedAppShellPluginUiProjection(() => currentModel,
            id => currentModel ? candidates.getSnapshot().get(id) ?? null : null);
        try {
            const reader = readPluginAccountAvailability(lifetime.scope);
            expect(reader.readCurrentSettingsDeclaration({ pluginId })).toMatchObject({ kind: 'unavailable' });
            expect(resolveFreshPluginMachineExecutionOrigin({ pluginId, origin: null, reader, classifyRelease: reader.classifyRelease,
                ...readPluginUiExecutionOriginCandidates({ projection: model, pluginId }) }), 'Fresh source must be admitted before exercising Settings')
                .toMatchObject({ origin });
            transportReady = true;
            const declarations = await loadDaemonMergedProjectionInputs({ machineId, serverId: connection.home.id, accountLifetime: lifetime });
            expect(declarations?.pluginProjectionById[pluginId]?.editableSettingsGroups[0]?.fields[0]?.key,
                JSON.stringify(readCachedDaemonMergedProjectionCacheEntry({ machineId, serverId: connection.home.id }))).toBe('enabled');
            let revision = 7;
            let values: Record<string, unknown> = { enabled: false, unrelated: 'retained' };
            let withdrawOnRead = false;
            let advanceUnrelatedGenerationOnRead = false;
            const path = `/v1/account/plugin-settings/${pluginId}`;
            homes.answer(serverId, path, { select: () => {
                if (withdrawOnRead) currentModel = null;
                if (advanceUnrelatedGenerationOnRead) {
                    advanceUnrelatedGenerationOnRead = false;
                    projection = { ...projection, generation: projection.generation + 1 };
                    publishCurrentSource();
                }
                return { body: { status: 'present', revision, content: { t: 'plain', v: { v: 1, values } } } };
            } });
            homes.answer(serverId, `POST ${path}`, { select: input => {
                const write = PluginAccountSettingsMutationRequestV1Schema.parse(input);
                expect(write.expectedRevision).toBe(revision);
                if (write.content?.t !== 'plain') throw new Error('Plain Account Settings required');
                values = PluginAccountSettingsValuesV1Schema.parse(write.content.v).values;
                revision++;
                return { body: { status: 'updated', revision } };
            } });
            const executor = createDefaultActionExecutor();
            const input = { pluginId, scope: { kind: 'account' }, target: { kind: 'account' }, localId: 'enabled' };
            const context = { serverId: connection.home.id, expectedAccountId: 'alice', surface: 'ui' as const };
            // A neighboring plugin changes the registry observation, not this
            // source's occurrence, authority or editable declaration.
            projection = { ...projection, generation: projection.generation + 1 };
            invalidateProjection();
            const write = await executor.execute('plugins.settings.set', { ...input, value: true, expectedRevision: '7' }, context);
            expect(write, JSON.stringify(write))
                .toMatchObject({ ok: true, result: { data: { target: { kind: 'account' }, revision: '8' } } });
            expect(values).toEqual({ enabled: true, unrelated: 'retained' });
            expect(await executor.execute('plugins.settings.get', input, context)).toMatchObject({ ok: true, result: { data: { value: true } } });
            publishCurrentSource();
            advanceUnrelatedGenerationOnRead = true;
            expect(await executor.execute('plugins.settings.set', { ...input, value: false, expectedRevision: '8' }, context))
                .toMatchObject({ ok: true, result: { data: { revision: '9' } } });
            expect(values).toEqual({ enabled: false, unrelated: 'retained' });

            // A real source edit publishes a new occurrence and its schema
            // together. A stale selection cannot borrow that fresh declaration.
            const changedDefinition = PluginSettingsContributionV2Schema.parse({ ...definition,
                fields: [{ id: 'enabled', title: 'Mode', schema: { type: 'string', enum: ['stable', 'preview'] } }] });
            const changedSettings = projectPluginSettingsContributionV2({ pluginId, definition: changedDefinition });
            projection = { ...projection, generation: projection.generation + 1,
                installedPackagesById: { ...projection.installedPackagesById,
                    [pluginId]: { ...projection.installedPackagesById[pluginId]!, occurrenceId: 'replacement-occurrence' } },
                settingsById: { [changedSettings.id]: changedSettings },
                familiesById: { pluginUi: { family: 'pluginUi', entriesById: {
                    home: { ...projection.familiesById.pluginUi!.entriesById.home!, occurrenceId: 'replacement-occurrence' },
                } } },
            };
            invalidateProjection();
            expect(await executor.execute('plugins.settings.set', { ...input, value: 'preview', expectedRevision: '9' }, context))
                .toMatchObject({ ok: false, errorCode: 'plugin_settings_unavailable' });
            expect(revision).toBe(9);
            publishCurrentSource();
            expect(await executor.execute('plugins.settings.set', { ...input, value: true, expectedRevision: '9' }, context))
                .toMatchObject({ ok: false, errorCode: 'plugin_settings_invalid_value' });
            expect(revision).toBe(9);
            expect(await executor.execute('plugins.settings.set', { ...input, value: 'preview', expectedRevision: '9' }, context))
                .toMatchObject({ ok: true, result: { data: { revision: '10' } } });
            expect(values).toEqual({ enabled: 'preview', unrelated: 'retained' });

            projection = { ...projection, installedPackagesById: { ...projection.installedPackagesById,
                [pluginId]: { ...projection.installedPackagesById[pluginId]!, enabled: false } } };
            publishCurrentSource();
            expect(await executor.execute('plugins.settings.set', { ...input, value: 'stable', expectedRevision: '10' }, context))
                .toMatchObject({ ok: false, errorCode: 'plugin_settings_unavailable' });
            expect(revision).toBe(10);
            projection = { ...projection, installedPackagesById: { ...projection.installedPackagesById,
                [pluginId]: { ...projection.installedPackagesById[pluginId]!, enabled: true } } };
            publishCurrentSource();
            withdrawOnRead = true;
            expect(await executor.execute('plugins.settings.set', { ...input, value: 'stable', expectedRevision: '10' }, context))
                .toMatchObject({ ok: false, errorCode: 'plugin_settings_target_not_current' });
            expect(await executor.execute('plugins.settings.set', { ...input, value: 'stable', expectedRevision: '10' }, context))
                .toMatchObject({ ok: false, errorCode: 'plugin_settings_unavailable' });
            expect(revision).toBe(10);
        } finally { unpublish(); vi.useRealTimers(); await connection.dispose(); }
    });
    it.each([false, true])('preserves default approval or executes the user-waived MCP operation (waived=%s)', async waived => {
        const serverUrl = 'https://plugin-settings-actions.test';
        const serverId = await homes.addHome({ name: 'Plugin Settings Home', serverUrl, serverIdentityId: 'srv_settings',
            accountId: 'alice', currentAccount: true });
        homes.answer(serverId, '/v2/cursor', { body: { cursor: '0' } });
        homes.answer(serverId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: waived ? { 'plugins.settings.set': ['mcp'] } : {} },
        } } } });
        const home = homes.findByServerUrl(serverUrl);
        if (!home?.token) throw new Error('Missing Settings Home credential');
        await restoreConnectionToActiveServer({ token: home.token });
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('Expected applied Settings Account runtime');
        const pluginId = 'acme.settings';
        const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
            availabilityCursor: 42, hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
            intent: { pluginId, desiredVersion: '1.0.0', enabled: true, offlineUiHosting: 'enabled', writableCollections: [], revision: 'intent-1' },
            release: {
                ref: { pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                normalizedManifest: { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Settings fixture',
                    engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: {
                        settings: [PluginSettingsContributionV2Schema.parse({ id: 'preferences', title: 'Preferences', scope: 'account',
                            target: { kind: 'plugin' }, fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' } }] })],
                    } },
                collectionContracts: [], uiSlots: [],
                packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] },
            }, packageAssets: [], uiArtifacts: [],
        });
        replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 42,
            intentReads: [{ pluginId, response }], materializations: [], snapshots: [], inventoryComplete: true } });
        let revision = 7;
        let values: Record<string, unknown> = { enabled: false, unrelated: 'retained' };
        const path = `/v1/account/plugin-settings/${pluginId}`;
        homes.answer(serverId, path, { select: () => ({ body: { status: 'present', revision,
            content: { t: 'plain', v: { v: 1, values } } } }) });
        homes.answer(serverId, `POST ${path}`, { select: input => {
            const write = PluginAccountSettingsMutationRequestV1Schema.parse(input);
            expect(write.expectedRevision).toBe(revision);
            if (!write.content || write.content.t !== 'plain') throw new Error('Plain Account must not fabricate encrypted Settings');
            values = PluginAccountSettingsValuesV1Schema.parse(write.content.v).values;
            revision += 1;
            return { body: { status: 'updated', revision } };
        } });
        const input = { pluginId, scope: { kind: 'account' }, target: { kind: 'account' }, localId: 'enabled' };
        const context = { serverId, expectedAccountId: 'alice', surface: 'mcp' as const };
        const executor = createDefaultActionExecutor();
        const read = await executor.execute('plugins.settings.get', input, context);
        expect(read, JSON.stringify(read))
            .toMatchObject({ ok: true, result: { data: { value: false, revision: '7' } } });
        const result = await executor.execute('plugins.settings.set', { ...input, value: true, expectedRevision: '7' },
            { ...context, actionRequestId: 'settings-write-1' });
        if (waived) {
            expect(result).toMatchObject({ ok: true, result: { data: { revision: '8' } } });
            expect(values).toEqual({ enabled: true, unrelated: 'retained' });
            clearPluginAccountAvailabilityProjection();
            expect(await executor.execute('plugins.settings.set', { ...input, value: false, expectedRevision: '8' }, context))
                .toMatchObject({ ok: false, errorCode: 'plugin_settings_unavailable' });
            expect(revision).toBe(8);
        } else {
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            expect(values).toEqual({ enabled: false, unrelated: 'retained' });
            expect(revision).toBe(7);
        }
    });
});
