import { expect, it, vi } from 'vitest';
import { PluginProjectedResourceV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { widgetProjectionOf, widgetExecutionOrigin } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';

const byteBoundary = vi.hoisted(() => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    return { gate, release, entered, started, loads: 0 };
});

vi.mock('socket.io-client', async importOriginal => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

// The app-package/declaration byte boundary only. All selection, projection,
// Account establishment, executable activation and Resource logic stay real.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', async () => {
    const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
    const { PluginUiArtifactsManifestEntryV2Schema } = await import('@happier-dev/protocol/plugins/ui');
    const { projectPluginPortableUiDeclarationsV1 } = await import('@happier-dev/protocol/plugins/contributions/ui');
    const manifest = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: 'acme.genretire4',
        version: '1.0.0', displayName: 'Cold Account Resource', runtime: { apiVersion: 1 }, contributes: {
            resources: [{ id: 'session-pull-request-status-v1', source: 'dynamic', scope: 'session', kind: 'config',
                contentType: 'application/json', execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activate' } } }],
        } });
    const digest = `sha256:${'a'.repeat(64)}`;
    const graph = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: 'account-runtime', tier: 'reactNative',
        entry: 'react-native/account-runtime/entry.cjs.bundle', digest,
        files: [{ relativePath: 'react-native/account-runtime/entry.cjs.bundle', digest, byteSize: 1 }],
        builtWith: { bundler: 'esbuild', version: '0.27.2' }, executable: { exports: ['activate'] }, hostUiApiRange: '^1.0.0' });
    const declaration = { pluginId: manifest.id, pluginVersion: manifest.version, packageName: '@acme/genretire4',
        displayName: manifest.displayName, normalizedManifest: manifest, artifactGraphs: [graph],
        entriesById: projectPluginPortableUiDeclarationsV1(manifest) };
    const { normalizedManifest: _full, ...presentation } = declaration;
    return { BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [], BUNDLED_PLUGIN_BRAND_MARKS: [], BUNDLED_PLUGIN_PACKAGED_RESOURCES: [],
        BUNDLED_PLUGIN_UI_APP_DECLARATIONS: [{ ...presentation, presentationManifest: manifest,
            async loadDeclaration() { byteBoundary.loads++; byteBoundary.entered(); await byteBoundary.gate; return declaration; } }] };
});

const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } =
    await import('@/sync/domains/plugins/availability/projection');
const { unionPluginUiProjections, mergeInstalledPluginUiProjections } = await import('@/sync/domains/plugins/ui/projectionUnion');
const { publishCommittedAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
const { readPluginUiAccountExecutableOrigin } = await import('@/sync/domains/plugins/ui/projectionOrigins');
const { resolvePluginContextualResourceBinding } = await import('@/components/plugins/surfaces/pluginResourceBinding');
const { createPluginDeclaredResourceStore } = await import('@/components/plugins/surfaces/PluginContextualResourceStoreProvider');
const { resolveProjectedPluginUiClientExecutables } = await import('@/components/plugins/reactNative/clientExecutableProjection');
const { getInstalledPluginUiClientExecutableComposition } = await import('@/components/plugins/reactNative/clientExecutableContributions');
const { createPluginReactNativeBundleCache } = await import('@/components/plugins/reactNative/bundleCache');
const { createPluginUiCommonJsLoaderBackend } = await import('@/components/plugins/reactNative/commonJsLoaderBackend');
const { createBoundPluginSurfaceController } = await import('./boundPluginSurfaceController');
const { decodeBase64 } = await import('@/encryption/base64');
const { SessionPullRequestStatusResourceResultV1Schema } = await import('@happier-dev/triage-protocol/v1');
const { projectTriageSessionPullRequestCardsV1 } = await import('../../../../../../packages/plugins/triage/src/sessions/sessionPullRequestStatus');

it('selects committed Account Resource custody from a targeted daemon declaration before cold execution capture', async () => {
    const http = createHomeHubArtifactHttpBoundary('genretire4-account');
    const connection = await restoreServerAccountForTest({ serverUrl: 'http://genretire4.test',
        accountId: 'genretire4-account', request: http.request });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected real Account lifetime');
    const pluginId = 'acme.genretire4';
    const resourceId = 'session-pull-request-status-v1';
    const key = `${pluginId}/${resourceId}`;
    const account = readPluginAccountAvailability(lifetime.scope);
    replacePluginAccountAvailabilityProjection({ scope: lifetime.scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const publish = () => {
        const projected = account.readAccountUiProjection();
        return mergeInstalledPluginUiProjections(projected ? [projected] : [], unionPluginUiProjections([]).pluginUiProjection);
    };
    const unpublish = publishCommittedAppShellPluginUiProjection(publish);
    const cold = publish();
    const declaration = cold?.resourcesById[key];
    if (!cold || !declaration) throw new Error('Real cold projection omitted the Resource');
    const before = readPluginUiAccountExecutableOrigin(declaration);
    expect(account.readCurrentAccountExecution(pluginId)).toMatchObject({ kind: 'unavailable', code: 'plugin_ui_declaration_pending' });
    expect(byteBoundary.loads).toBe(0);
    expect(before).toMatchObject({ ...lifetime.scope, custodyId: declaration.occurrenceId });
    const targets = resolveProjectedPluginUiClientExecutables({ actionProjection: { projection: cold }, platform: 'web' });
    expect(targets).toHaveLength(1);
    const status = SessionPullRequestStatusResourceResultV1Schema.parse({ kind: 'ready', sessionId: 'genretire4-session', pullRequests: [{
        bindingId: 'pr54', revision: 1,
        link: { provider: 'github', repository: 'happier-dev/triage-qa-sandbox', number: 54,
            url: 'https://github.com/happier-dev/triage-qa-sandbox/pull/54' },
        watch: { policy: { mode: 'off', archiveAfterMerge: false }, reason: null, fixAttemptLimit: 3,
            roundsStarted: 0, watchingMachine: null }, latestUpdate: null,
        nativeStatus: { kind: 'unavailable', failure: { class: 'permission', code: 'credentialsExpired' } },
    }] });
    if (status.kind !== 'ready') throw new Error('Expected ready PR54 fixture');
    const cache = createPluginReactNativeBundleCache();
    for (const target of targets) cache.putInstalledArtifact({ identity: target.cacheIdentity, format: 'plainJs', bytes: new TextEncoder().encode(
        `exports.activate = function(api) { api.resources.registerDynamicResource('session-pull-request-status-v1', {read(options) { return JSON.stringify({...${JSON.stringify(status)}, sessionId: options.context.sessionId}); }, observe() { return {dispose() {}}; }}); };`,
    ) });
    const composition = getInstalledPluginUiClientExecutableComposition();
    let store: ReturnType<typeof createPluginDeclaredResourceStore> = null;
    let controller: ReturnType<typeof createBoundPluginSurfaceController> | undefined;
    try {
        const attempts = await composition.reconcile(targets.map(target => ({ pluginId, pluginVersion: target.pluginVersion,
            hostUiApiRange: target.hostUiApiRange, contributes: target.contributes, target: target.target,
            executionOrigin: target.executionOrigin, authority: target.authority, occurrenceId: target.occurrenceId,
            accountLifetime: lifetime, isCurrent: lifetime.isCurrent, cache, identity: target.cacheIdentity,
            moduleReference: target.moduleReference, backend: createPluginUiCommonJsLoaderBackend() })));
        expect(attempts).toMatchObject([{ result: { ok: true } }]);
        const machineId = 'machine-optional';
        const origin = widgetExecutionOrigin(pluginId, machineId);
        // Real daemon wire admission and UI normalization omit host Account stamps.
        const daemonResource = PluginProjectedResourceV2Schema.parse({ id: resourceId, pluginId,
            occurrenceId: `${pluginId}:55`, executionOrigin: origin, resourceKind: 'config',
            scope: 'session', contentType: 'application/json', execution: declaration.execution });
        const daemon = widgetProjectionOf([], { [pluginId]: { id: pluginId, displayName: 'Cold Account Resource',
            enabled: true, version: '1.0.0', occurrenceId: daemonResource.occurrenceId,
            executionOrigin: origin, source: { kind: 'local', locator: 'fixture' } } }, { [key]: daemonResource });
        const targeted = unionPluginUiProjections([{ machineId, serverId: lifetime.scope.serverId,
            serverIdentityId: origin.serverIdentityId, phase: 'current', interactionEnabled: true, projection: daemon }],
            new Map([[pluginId, origin]])).pluginUiProjection!;
        expect(targeted.resourcesById[key]?.occurrenceId).toBe(`${pluginId}:55`);
        expect(readPluginUiAccountExecutableOrigin(targeted.resourcesById[key])).toBeNull();
        const binding = resolvePluginContextualResourceBinding({ projection: targeted, machineId,
            serverId: lifetime.scope.serverId, accountLifetime: lifetime, isCurrent: lifetime.isCurrent },
            targeted.resourcesById[key]!, { kind: 'session', sessionId: 'genretire4-session' });
        expect(binding).toMatchObject({ machineId: null, expectedCallerOccurrenceId: declaration.occurrenceId,
            accountResource: declaration });
        store = createPluginDeclaredResourceStore({ accountLifetime: lifetime, pluginId, machineId: null,
            serverId: lifetime.scope.serverId, expectedCallerOccurrenceId: declaration.occurrenceId!,
            resourcesById: targeted.resourcesById, resourceDeclarationsComplete: true, sessionId: 'genretire4-session' });
        if (!store) throw new Error('Expected canonical declared Resource store');
        const pending = store.getEntry(resourceId).refresh();
        await byteBoundary.started;
        expect(byteBoundary.loads).toBe(1);
        expect(account.readCurrentAccountExecution(pluginId)).toMatchObject({ kind: 'unavailable', code: 'plugin_ui_declaration_pending' });
        byteBoundary.release();
        const snapshot = await pending;
        expect(snapshot.error).toBeUndefined();
        expect(snapshot.value).toBeDefined();
        expect(JSON.parse(new TextDecoder().decode(snapshot.value!.bytes))).toEqual(status);
        const after = readPluginUiAccountExecutableOrigin(publish()?.resourcesById[key]);
        expect(after).toEqual(before);
        expect(account.readCurrentAccountExecution(pluginId).kind).toBe('available');
        for (const accountMounted of [true, false]) {
            controller = createBoundPluginSurfaceController({ facts: {
                pluginId, contributionId: 'scm-pull-request', surfaceId: 'session-pr54', placement: 'sessionPane',
                platform: 'web', channel: 'internal', sessionId: status.sessionId, machineId,
                serverId: lifetime.scope.serverId, accountLifetime: lifetime,
                ...(accountMounted ? { occurrenceId: declaration.occurrenceId, accountExecutionOrigin: before! }
                    : { occurrenceId: daemonResource.occurrenceId, executionOrigin: origin,
                        resourceDeclarations: targeted.resourcesById }),
                pluginUiProjection: targeted, resourceCapability: { readable: false, dynamic: false },
                interactionEnabled: true, daemonInteractionEnabled: true,
            } });
            const result = await controller.hostApi.handleRequest({ version: 1, requestId: 'session-pr54-read',
                surface: controller.surfaceContext, method: 'readResource', payload: { resource: resourceId } });
            expect(result).toMatchObject({ contentType: 'application/json', bytesBase64: expect.any(String) });
            if (!result || typeof result !== 'object' || !('bytesBase64' in result) || typeof result.bytesBase64 !== 'string') {
                throw new Error('Mounted PR Resource returned no bytes');
            }
            const value = SessionPullRequestStatusResourceResultV1Schema.parse(JSON.parse(new TextDecoder().decode(decodeBase64(result.bytesBase64, 'base64'))));
            expect(projectTriageSessionPullRequestCardsV1(undefined, status.sessionId, value)).toMatchObject([
                { kind: 'bound', pullRequest: { number: 54, url: status.pullRequests[0]!.link.url } },
            ]);
            controller.dispose();
        }
    } finally {
        byteBoundary.release(); controller?.dispose(); store?.dispose(); unpublish();
        await composition.invalidatePlugin(pluginId); clearPluginAccountAvailabilityProjection(); await connection.dispose();
    }
});
