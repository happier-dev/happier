import { createArtifactInventoryDemandHarness, initializeArtifactInventoryDemandHarness } from '@/dev/testkit/harness/artifactInventoryDemandHarness';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi, onTestFailed, onTestFinished } from 'vitest';
import { createDeferred, createMachineFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainPromptLibraryCatalogHomeFixture, createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { parseThemeProfileDocument } from '@happier-dev/protocol/account/settings/themeProfiles';
import { projectThemeLibraryEntry, projectThemeMiniaturePalette } from '@/theme/profiles/themeProfilePresentation';
import { createPromptRegistrySkillFixture } from '@/dev/testkit/harness/promptMachineTransferBoundary';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture, createHydratedPlainMachineFixture, createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { PromptBundleArtifactHeaderV1Schema, PromptBundleBodyV1Schema } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { SkillLockV1Schema, encodeSkillRevisionV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { createUiPromptLibraryArtifactStore } from '@/sync/ops/promptLibrary/promptLibraryArtifactStore';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { observeMachinePresenceForTest, publishMachineActivityForTest, publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { listRegistrySourcesV1, projectPluginRegistrySourceDeclarationV1, REGISTRY_ACTION_INPUT_SCHEMAS_V1, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1, RegistryFetchErrorV1, RegistryFetchRequestV1Schema, type RegistryFetchRequestV1, type RegistrySourceV1 } from '@happier-dev/protocol/registries';
import type { ServerScopedMachineRpcParams } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import nacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ExternalActionRequestEnvelopeV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionMachineBootstrapV1Schema,
    ExternalActionResponseEnvelopeV1Schema, projectExternalActionRegistryAppUpdateEnvelopeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { DEFAULT_CURATED_MARKETPLACE_SOURCE_URL } from '@happier-dev/protocol/marketplace';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { checkRegistryAppUpdatesV1, checkRegistryUpstreamV1, createRegistryHostV1, type RegistryRemoteSourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createUiRegistryHttpV1 } from './registryHttpV1';
import { digest } from '@/platform/digest';
import type { DirectoryGroup } from '@/components/store/StoreKindPage';
import type { StoreDirectorySectionInput } from '@/components/store/discover/StoreDirectorySection';

const transport = vi.hoisted(() => ({ calls: [] as ServerScopedMachineRpcParams<RegistryFetchRequestV1>[], platform: 'web', unreachableList: false,
    petFetch: undefined as undefined | ((request: RegistryFetchRequestV1) => Promise<unknown>) }));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
// Machine RPC leaves this process; source ownership, supplier selection and REACH stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (request: ServerScopedMachineRpcParams<RegistryFetchRequestV1>) => {
        transport.calls.push(request);
        const input = RegistryFetchRequestV1Schema.parse(request.payload);
        if ('kind' in input && input.kind === 'pet' && transport.petFetch) return transport.petFetch(input);
        if (input.op === 'link') return { op: 'error', status: { state: 'unreachable' } };
        if (input.op === 'read' && input.kind === 'browserExtension') return { op: 'read', item: {
            summary: { sourceId: input.sourceId, kind: 'browserExtension', itemId: input.itemId, title: 'Dark Reader', version: `sha256:${'a'.repeat(64)}` },
            payload: { kind: 'browserExtension', extension: { kind: 'webStore', extensionId: input.itemId },
                ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } }, fetchedAt: 1,
        } };
        if (input.op !== 'list') throw new Error('Fixture serves registry lists');
        if (input.sourceId === 'builtin:chrome-web-store') return { op: 'list', page: {
            sourceId: input.sourceId, status: { state: 'ok', fetchedAt: 1 }, nextCursor: null,
            items: [{ sourceId: input.sourceId, kind: 'browserExtension', itemId: 'eimadpbcbfnmbkopoojfekhnkhdbieeh', title: 'Dark Reader' }],
            discovery: { items: [{ id: 'dark', title: 'Dark Reader', reference: { type: 'registryItem', kind: 'browserExtension',
                sourceId: input.sourceId, itemId: 'eimadpbcbfnmbkopoojfekhnkhdbieeh' } }],
                categories: [{ id: 'featured', title: 'Featured', items: ['dark'] }], jobs: [] },
        } };

        if (transport.unreachableList) return { op: 'error', status: { state: 'unreachable' } };
        return { op: 'list', page: { sourceId: input.sourceId, status: { state: 'ok', fetchedAt: 1 }, items: input.kind === 'app' && input.sourceId === 'environment-databases'
            ? [{ sourceId: input.sourceId, kind: 'app', itemId: 'postgresql', title: `${request.machineId} database`, appMetadata: { category: 'database' } }]
            : [], nextCursor: input.sourceId === 'carried-git' ? 'next' : null } };
    },
}));
vi.mock('react-native', async () => {
    return (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
        Platform: { get OS() { return transport.platform; } },
    });
});
installDisconnectedServerSocketBoundary();

// Compile the real production graph after transport installation and before the
// interaction budget, as the canonical Home/Action composed harnesses do.
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { normalizePluginInstalledUiDeclarations } = await import('@/sync/domains/plugins/ui/projection');
const { unionPluginUiProjections } = await import('@/sync/domains/plugins/ui/projectionUnion');
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { createConnectedAccountDescriptorProjectionLoadingState } = await import('@/sync/domains/connectedServices/connectedAccountDescriptorProjection');
const { createUiRegistryHostV1, createUiRegistryActionExecuteV1, invalidateUiRegistryUpdateMemoV1 } = await import('./registryHostDeps');
const { recordMachineRequestFailed, clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
const { readCurrentAppShellPluginUiProjection } = await import('@/components/appShell/plugins/committedPluginUiProjection');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { useRegistrySuggestions } = await import('./useRegistrySuggestions');
const { useRegistryItems } = await import('./useRegistryItems');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { useSkillsLibrary } = await import('@/sync/domains/skills/useSkillsLibrary');
const { useSkillsUpdates } = await import('@/components/settings/skills/updates/useSkillsUpdates');
const { useSkillDetail } = await import('@/components/settings/skills/detail/useSkillDetail');
const { useRegistrySources } = await import('./useRegistrySources');

it('checks installed theme header provenance through the captured Account without reading face bodies', async () => {
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources',
        value: { v: 2, disabledSourceIds: [], sources: [] } }], revision: 1, settingsVersion: 1 });
    const fixture = await createArtifactInventoryDemandHarness({ handleRequest: async (url, init) => {
        const response = await catalog.handle(`${url.pathname}${url.search}`, init);
        if (response) return response;
        if (url.href === 'https://open-vsx.org/api/sample/palette/latest') return Response.json({
            namespace: 'sample', name: 'palette', version: '2.0.0', displayName: 'Palette',
            files: { manifest: 'https://open-vsx.org/manifest.json', download: 'https://open-vsx.org/package.vsix',
                sha256: 'https://open-vsx.org/package.sha256' } });
        return null;
    } });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    const scope = storage.getState().settingsScope!;
    const provenance = { sourceId: 'builtin:open-vsx', sourceUrl: 'https://open-vsx.org/api', format: 'open-vsx' as const,
        itemId: 'sample/palette', ref: { kind: 'version' as const, version: '1.0.0' }, importedAt: 1 };
    fixture.inventory = (['dark', 'light'] as const).map((mode, index) => {
        const id = `11111111-1111-4111-8111-00000000000${index}`;
        const parsed = parseThemeProfileDocument({ schemaVersion: 1, id, name: mode, createdAt: '2026-11-16', updatedAt: '2026-11-16',
            base: { light: 'light', dark: 'dark' }, overrides: { light: {}, dark: {} }, assetAppearance: mode,
            source: { kind: 'store', provenance, contributionId: mode } });
        if (!parsed.ok) throw new Error('Invalid theme boundary fixture');
        const entry = projectThemeLibraryEntry(parsed.document);
        return { ...fixture.inventory[0]!, id, ownerAccountId: scope.accountId, kindHint: 'theme_profile.v1',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ v: 1, kind: 'theme_profile.v1', title: entry.name, mode: entry.mode,
                themeSource: entry.source, compatibility: entry.compatibility, palette: projectThemeMiniaturePalette(parsed.document.profile) }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(parsed.document.raw) }) };
    });
    fixture.pages.length = 0; fixture.bodyReads.length = 0;
    const account = await captureLazyActionAccountContext(scope.serverId);
    onTestFinished(() => account.dispose());
    const port = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account).organization!;
    const host = await createUiRegistryHostV1(account, port, {});
    const result = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse(
        await host.execute('registries.updates.check', { kind: 'theme' }));
    expect(Object.fromEntries(result.results.map(item => [item.key, { kind: item.kind, state: item.upstream.state }])))
        .toEqual(Object.fromEntries(fixture.inventory.map(row => [row.id, { kind: 'theme', state: 'update_available' }])));
    expect(fixture.bodyReads).toEqual([]);
    expect(fixture.pages).toEqual([{ kinds: '["theme_profile.v1"]', headers: 2 }]);
    expect(fixture.network.httpRequests.filter(request => request.url.startsWith('https://open-vsx.org/'))
        .map(request => request.token)).toEqual([null]);
});

it('reads the Environment database picker on its controller when another own Machine is first', async () => {
    const sourceId = 'environment-databases';
    const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-environment-controller.test', {
        key: 'registry-sources', value: { v: 2, disabledSourceIds: [], sources: [{ id: sourceId, title: 'Environment databases',
            format: 'happier-catalog', kinds: ['app'], url: 'https://private.example.test/apps.json', enabled: true, addedAt: 0 }] },
    }, 'updated', { handleExternalRequest: async url => {
        // Browser network/CORS failure enters the registry owner's existing daemon fallback.
        if (url === 'https://private.example.test/apps.json') throw new TypeError('Network request failed');
        return new Response(null, { status: 503 });
    } });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    await setServerProfileIdentityForUrl(fixture.home.serverUrl, 'srv_registry_environment_controller');
    const account = await captureLazyActionAccountContext(fixture.home.id);
    onTestFinished(() => account.dispose());
    await storage.getState().activateSettingsScope(account.accountLifetime.scope);
    storage.getState().applySettingsForScope(account.accountLifetime.scope, storage.getState().settings, 1);
    storage.getState().activateProfileScope(account.accountLifetime.scope);
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const arbitrary = createMachineFixture({ id: 'c71-arbitrary-own-machine', createdAt: 2, activeAt: Date.now() });
    const controller = createMachineFixture({ id: 'environment-controller', createdAt: 1, activeAt: Date.now() });
    const inventory = [arbitrary, controller];
    await publishMachineInventoryForTest(account.accountLifetime.scope, inventory);
    transport.calls.length = 0;
    const { StoreRegistryItemPicker, Directory } = await import('@/components/store/StoreKindPage');
    const screen = await renderScreen(<StoreRegistryItemPicker presented machine={{ serverId: account.serverId, machineId: controller.id }}
        initialFilters={{ source: { include: [sourceId], exclude: [] } }} onSelect={() => {}} testID="environment-database-picker" />);
    // The renderer has no native viewport for the virtualized Collection. Read its
    // real Directory model, as the composed Store search tests do.
    await waitForHomeGovernance(() => expect(screen.findAllByType(Directory).flatMap(node => node.props.rows)
        .map((row: { title: string }) => row.title)).toContain('environment-controller database'));
    expect(new Set(transport.calls.filter(call => call.payload.op === 'list' && call.payload.sourceId === sourceId)
        .map(call => call.machineId))).toEqual(new Set([controller.id]));
});

it('Link preview skips active Machines without usable content and retains its typed registry refusal', async () => {
    const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-link-carrier.test', {
        key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
    });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    await setServerProfileIdentityForUrl(fixture.home.serverUrl, 'srv_registry_link_carrier');
    const retryAccount = await captureLazyActionAccountContext(fixture.home.id);
    onTestFinished(() => { retryAccount.dispose(); clearMachineRequestReachabilityForTest(); });
    const older = createMachineFixture({ id: 'older-carrier', createdAt: 1, activeAt: Date.now() });
    const newer = createMachineFixture({ id: 'newer-carrier', createdAt: 2, activeAt: Date.now() });
    const unopened = createMachineFixture({ id: 'newest-unopened-carrier', createdAt: 4, activeAt: Date.now(), metadata: null });
    const presenceOnly = Array.from({ length: 128 }, (_, index) => createMachineFixture({
        id: `presence-only-${index}`, createdAt: 5 + index, activeAt: Date.now(), metadata: null,
    }));
    const locked = createMachineFixture({ id: 'locked-carrier', createdAt: 3, activeAt: Date.now(),
        availability: { kind: 'locked', reason: 'encryption_material_unavailable' } });
    const inventory = [older, newer, unopened, locked, ...presenceOnly];
    // Keep the deliberately unopened/locked hydration projections while answering live presence.
    publishMachineActivityForTest(inventory);
    storage.setState({ machines: Object.fromEntries(inventory.map(machine => [machine.id, machine])),
        machineListByServerId: { [fixture.home.id]: inventory },
        machineListStatusByServerId: { [fixture.home.id]: 'idle' } });
    observeMachinePresenceForTest(retryAccount.accountLifetime.scope, inventory.map(machine => machine.id));
    transport.calls.length = 0;
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { previewSkillInstall } = await import('@/components/settings/skills/add/skillInstall');
    const executor = createDefaultActionExecutor();
    const actionRequestId = '3aba615b-3b79-4caf-a79f-7cef156c9db0';
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId: fixture.home.id, actionRequestId };
    const source = { kind: 'link' as const, url: 'https://git.example.test/skills.git' };
    expect(await previewSkillInstall((actionId, input) => executor.execute(actionId, input, context), source))
        .toMatchObject({ ok: false, status: { state: 'unreachable' } });
    expect(transport.calls.map(call => ({ machineId: call.machineId, method: call.method, op: call.payload.op })))
        .toEqual([{ machineId: newer.id, method: 'daemon.registries.fetch', op: 'link' }]);
    expect(await previewSkillInstall((actionId, input) => executor.execute(actionId, input, {
        ...context, externalActionTarget: { kind: 'machine', machineId: older.id },
    }), source)).toMatchObject({ ok: false, status: { state: 'unreachable' } });
    expect(transport.calls.at(-1)?.machineId).toBe(older.id);
    // Raw RPCs need their own cancellation/correlation identity: one parent Action can fan out.
    expect(transport.calls.map(call => call.requestId)).not.toContain(actionRequestId);
    recordMachineRequestFailed({ serverId: fixture.home.id, accountId: retryAccount.accountId, machineId: newer.id });
    const retryPort = createUiPromptLibraryArtifactStore(retryAccount.workflowArtifacts, retryAccount).organization!;
    const retryDefault = await createUiRegistryHostV1(retryAccount, retryPort, {}, { explicitRefresh: true });
    expect(await retryDefault.fetchRequest({ op: 'link', url: source.url })).toMatchObject({ op: 'error', status: { state: 'unreachable' } });
    expect(transport.calls.at(-1)?.machineId).toBe(older.id);
    const retryExplicit = await createUiRegistryHostV1(retryAccount, retryPort, {
        externalActionTarget: { kind: 'machine', machineId: newer.id },
    }, { explicitRefresh: true });
    expect(await retryExplicit.fetchRequest({ op: 'link', url: source.url })).toMatchObject({ op: 'error', status: { state: 'unreachable' } });
    expect(transport.calls.at(-1)?.machineId).toBe(newer.id);
    const beforeUnavailable = transport.calls.length;
    expect(await previewSkillInstall((actionId, input) => executor.execute(actionId, input, {
        ...context, externalActionTarget: { kind: 'machine', machineId: unopened.id },
    }), source)).toMatchObject({ ok: false, status: { state: 'needs_machine' } });
    expect(transport.calls).toHaveLength(beforeUnavailable);
    storage.setState({ machines: { [unopened.id]: unopened, [locked.id]: locked },
        machineListByServerId: { [fixture.home.id]: [unopened, locked] } });
    observeMachinePresenceForTest(retryAccount.accountLifetime.scope, [unopened.id, locked.id]);
    expect(await previewSkillInstall((actionId, input) => executor.execute(actionId, input, context), source))
        .toMatchObject({ ok: false, status: { state: 'needs_machine' } });
    expect(transport.calls).toHaveLength(beforeUnavailable);
    expect(await retryDefault.fetchRequest({ op: 'link', url: source.url }))
        .toMatchObject({ op: 'error', status: { state: 'needs_machine' } });
    expect(transport.calls).toHaveLength(beforeUnavailable);
});

it.each([false, true])('previews a multi-plugin skill link with one repository read (manifest absent: %s)', async absentManifest => {
    const requests: string[] = [];
    const commit = '1'.repeat(40);
    const names = ['review', 'release', 'debug'];
    const skills = names.map(name => createPromptRegistrySkillFixture({ sourceId: 'marketplace', itemId: `plugins/${name}/skills/${name}`, title: name,
        files: [{ path: 'SKILL.md', content: `---\nname: ${name}\n---\nInstructions for ${name}` }] }));
    const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-link-preview.test', {
        key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
    }, 'updated', { handleExternalRequest: async input => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith('/marketplace.json')) return Response.json({ plugins: names.map(name => ({ name, source: `./plugins/${name}` })) });
        if (url.includes('/commits/')) return Response.json({ sha: commit });
        if (url.includes('/git/trees/')) return Response.json({ sha: '2'.repeat(40), tree: skills.flatMap(fixture => {
            if (fixture.item.payload.kind !== 'skill') throw new Error('Expected canonical skill fixture');
            const skill = fixture.item.payload.skill;
            return [{ path: skill.ref.path, type: 'tree', mode: '040000', sha: skill.ref.treeSha },
                ...skill.files.map(file => ({ path: `${skill.ref.path}/${file.path}`, type: 'blob', mode: '100644', sha: file.blobSha, size: file.size }))];
        }) });
        if (url.endsWith('/plugin.json')) return absentManifest ? new Response('', { status: 404 }) : Response.json({});
        const index = names.findIndex(name => url.endsWith(`/skills/${name}/SKILL.md`));
        const payload = skills[index]?.item.payload;
        if (payload?.kind === 'skill') return new Response(payload.skill.skillMarkdown);
        throw new Error(`Unexpected external registry request: ${url}`);
    } });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    transport.calls.length = 0;
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const result = await createDefaultActionExecutor().execute('skills.install', {
        source: { kind: 'link', url: 'https://github.com/owner/market' }, dryRun: true,
    }, { surface: 'ui', authority: 'present_user', serverId: fixture.home.id });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(JSON.stringify(result));
    const preview = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse(result.result);
    expect(preview).toMatchObject({ items: names.map(name => ({ name })) });
    expect(requests.filter(url => url.includes('/commits/'))).toHaveLength(1);
    expect(requests.filter(url => url.includes('/git/trees/'))).toHaveLength(1);
    expect(requests.filter(url => url.endsWith('/plugin.json'))).toHaveLength(names.length);
    expect(transport.calls).toEqual([]);
});

it.each([403, 429])('preserves an upstream %s quota failure during link detection or repository read without another API request', async status => {
    const requests: string[] = [];
    const fixture = await createPlainPromptLibraryCatalogHomeFixture(`https://registry-link-quota-${status}.test`, {
        key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
    }, 'updated', { handleExternalRequest: async url => {
        requests.push(url);
        if (status === 403 && !url.startsWith('https://api.github.com/')) return Response.json({ plugins: [
            { name: 'review', source: './plugins/review' }, { name: 'release', source: './plugins/release' },
        ] });
        return new Response('', { status, ...(status === 403 ? { headers: { 'x-ratelimit-remaining': '0' } } : {}) });
    } });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    transport.calls.length = 0;
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const result = await createDefaultActionExecutor().execute('skills.install', {
        source: { kind: 'link', url: 'https://github.com/owner/limited' }, dryRun: true,
    }, { surface: 'ui', authority: 'present_user', serverId: fixture.home.id });
    expect(result).toMatchObject({ ok: false, details: { registryStatus: { state: 'rate_limited' } } });
    if (status === 403) {
        expect(requests.filter(url => url.startsWith('https://api.github.com/')))
            .toEqual(['https://api.github.com/repos/owner/limited/commits/HEAD']);
        expect(requests.some(url => url.endsWith('/SKILL.md') || url.endsWith('/plugin.json'))).toBe(false);
    } else expect(requests).toEqual(['https://raw.githubusercontent.com/owner/limited/HEAD/.claude-plugin/marketplace.json']);
    expect(transport.calls).toEqual([]);
});

it('opens an empty web skill recommendation shelf without a daemon browse even with a reachable Machine', async () => {
    const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-homepage-direct.test', {
        key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
    }, 'updated', { handleExternalRequest: async () => new Response(null, { status: 503 }) });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    const account = await captureLazyActionAccountContext(fixture.home.id);
    onTestFinished(() => account.dispose());
    const machine = createMachineFixture({ id: 'homepage-online', activeAt: Date.now() });
    await publishMachineInventoryForTest(account.accountLifetime.scope, [machine]);
    const before = transport.calls.length;
    const hook = await renderHook(() => useRegistrySuggestions('skill'));
    await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
    expect(hook.getCurrent()).toMatchObject({ items: [], sourceId: null });
    expect(transport.calls.length).toBe(before);
});

await initializeArtifactInventoryDemandHarness();

it('browses browser pets through the existing Machine carrier and preserves selected sheet bytes', async () => {
    const daemonReads: string[] = [];
    const externalReads: string[] = [];
    const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-browser-pets.test', {
        key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
    }, 'updated', { handleRequest: async (path, init) => createPlainMachineReadHttpResponseFixture(path, init), handleExternalRequest: async url => {
        externalReads.push(url);
        throw new TypeError('Pet APIs do not allow browser CORS');
    } });
    onTestFinished(async () => {
        transport.petFetch = undefined;
        await standardCleanup();
        await fixture.dispose();
    });
    await setServerProfileIdentityForUrl(fixture.home.serverUrl, 'srv_registry_browser_pets');
    const account = await captureLazyActionAccountContext(fixture.home.id);
    onTestFinished(() => account.dispose());
    await publishMachineInventoryForTest(account.accountLifetime.scope, []);
    transport.calls.length = 0;
    const sourceIds = ['builtin:codex-pets', 'builtin:petdex'];
    const sheets = {
        winter: 'https://codex-pets.net/assets/winter/spritesheet.webp',
        boba: 'https://assets.petdex.dev/boba/sprite.webp',
    };
    const sheetBytes = new Uint8Array([0, 127, 128, 255]);
    const downloads: string[] = [];
    const codexPet = { id: 'winter', displayName: 'Winter', description: 'A white cat', spritesheetUrl: sheets.winter };
    const daemon = createRegistryHostV1({ host: 'node', readSources: async () => listRegistrySourcesV1({
        record: { v: 2, sources: [], disabledSourceIds: [] }, pluginSources: [],
    }), http: {
        getText: async () => { throw new Error('Unexpected text request'); },
        getBytes: async url => { downloads.push(url); return { ok: true, fetchedAt: 1, value: sheetBytes }; },
        getJson: async url => {
            daemonReads.push(url);
            const address = new URL(url);
            const value = address.hostname === 'codex-pets.net' && address.pathname === '/api/pets'
                ? { pets: [codexPet], page: 1, total: 1, totalPages: 1 }
                : url === 'https://codex-pets.net/api/pets/winter' ? { pet: codexPet }
                : address.hostname === 'petdex.dev' && address.pathname === '/api/pets/search'
                    ? { pets: [{ slug: 'boba', displayName: 'Boba', description: 'A companion', spritesheetPath: sheets.boba }], nextCursor: null, total: 1 }
                : url === 'https://petdex.dev/api/manifest' ? { pets: [{ slug: 'boba', displayName: 'Boba', spritesheetUrl: sheets.boba,
                    petJsonUrl: 'https://assets.petdex.dev/boba/pet.json' }] }
                : url === 'https://assets.petdex.dev/boba/pet.json' ? { id: 'Boba Cat', displayName: 'Boba', description: 'A companion' }
                : undefined;
            if (!value) throw new Error(`Unexpected pet request: ${url}`);
            return { ok: true, fetchedAt: 1, value };
        },
    } });
    // Machine RPC is a JSON boundary; the real daemon host, adapters and UI parser run beneath it.
    transport.petFetch = async request => JSON.parse(JSON.stringify(await daemon.fetchRequest(request)));
    const port = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account).organization!;
    const host = await createUiRegistryHostV1(account, port, {});
    for (const query of [undefined, 'cat']) {
        expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list',
            { kind: 'pet', sourceIds, query })).pages.map(page => page.status.state))
            .toEqual(['needs_machine', 'needs_machine']);
    }
    await expect(host.readRegistryPet({ sourceId: sourceIds[0]!, itemId: 'winter' }))
        .rejects.toMatchObject({ status: { state: 'needs_machine' } });
    expect(transport.calls).toEqual([]);
    const machine = createHydratedPlainMachineFixture({ id: 'pet-registry-carrier', accountId: account.accountId,
        machine: { activeAt: Date.now() } });
    await publishMachineInventoryForTest(account.accountLifetime.scope, [machine]);
    for (const query of [undefined, 'cat']) {
        for (const [index, sourceId] of sourceIds.entries()) {
            expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list',
                { kind: 'pet', sourceIds: [sourceId], query })).pages.flatMap(page => page.items.map(item => item.itemId)))
                .toEqual([index === 0 ? 'winter' : 'boba']);
        }
    }
    expect(daemonReads.filter(url => new URL(url).searchParams.get('q') === 'cat')).toHaveLength(2);
    for (const [sourceId, itemId, packageId] of [[sourceIds[0]!, 'winter', 'winter'], [sourceIds[1]!, 'boba', 'Boba Cat']]) {
        expect(await host.readRegistryPet({ sourceId: sourceId!, itemId: itemId! })).toMatchObject({
            manifest: { id: packageId }, spritesheetBytes: sheetBytes, mediaType: 'image/webp',
            origin: { kind: 'registry', sourceId, itemId },
        });
    }
    expect(downloads).toEqual([sheets.winter, sheets.boba]);
    expect(transport.calls.filter(call => call.payload.op === 'read').map(call => call.payload))
        .toEqual(sourceIds.map((sourceId, index) => ({ op: 'read', kind: 'pet', sourceId,
            itemId: index === 0 ? 'winter' : 'boba', petContent: true })));
    expect(new Set(transport.calls.map(call => call.machineId))).toEqual(new Set([machine.id]));
    expect(externalReads).toEqual([]);
});

it('opens authenticated Open VSX theme faces through captured requester custody while public reads stay metadata-only', async () => {
    const machineId = 'private-theme-machine', installationId = 'private-theme-installation', homeIdentityId = 'srv_private_theme_home';
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
    const machineRow = { ...ExternalActionMachineBootstrapV1Schema.parse({ id: machineId, kind: 'persistent', active: true,
        installationId, revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
        access: { custodian: { accountId: 'theme-custodian', displayName: 'Custodian' }, role: 'use', resourceMode: 'plain', accessState: 'ready' } }),
        installationPublicKey: encodeBase64(installation.publicKey) };
    const { runnerClaim: _runnerClaim, ...publishedThemeMachine } = machineRow;
    const themeSource: RegistrySourceV1 = { id: 'requester-private-themes', title: 'Private themes', enabled: true, addedAt: 0,
        token: { secretRef: 'happier:shared-secret:v1:requester-secret' },
        format: 'open-vsx', kinds: ['theme'], url: 'https://private-themes.example.test/api' };
    const themeManifest = { publisher: 'sample', name: 'palette', version: '1.0.0', contributes: { themes: [
        { label: 'Private Night', uiTheme: 'vs-dark', path: './themes/night.json' },
    ] } };
    const themeZip = new ZipWriter(new Uint8ArrayWriter());
    for (const [path, content] of Object.entries({ 'extension/package.json': themeManifest,
        'extension/themes/night.json': { colors: { 'editor.background': '#123456' } } })) {
        await themeZip.add(path, new Uint8ArrayReader(new TextEncoder().encode(JSON.stringify(content))), { useWebWorkers: false });
    }
    const themeBytes = await themeZip.close();
    const themeReads: string[] = [];
    // Remote HTTP is the boundary; source placement, requester sealing and the full registry adapter stay real.
    const daemonThemeHost = createRegistryHostV1({ host: 'node', sha256Bytes: bytes => digest('SHA-256', bytes), readSources: async () => listRegistrySourcesV1({
        record: { v: 2, sources: [themeSource], disabledSourceIds: [] }, pluginSources: [] }), http: {
        async getJson(url) { themeReads.push(url); return { ok: true, fetchedAt: 1, value: url.endsWith('/manifest.json')
            ? themeManifest : { namespace: 'sample', name: 'palette', version: '1.0.0', files: {
                manifest: 'https://private-themes.example.test/manifest.json', download: 'https://private-themes.example.test/package.vsix',
                sha256: 'https://private-themes.example.test/package.sha256' } } }; },
        async getBytes(url) { themeReads.push(url); return { ok: true, fetchedAt: 1, value: themeBytes }; },
        async getText(url) { themeReads.push(url); return { ok: true, fetchedAt: 1, value: bytesToHex(sha256(themeBytes)) }; },
    } });
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources',
        value: { v: 2, sources: [themeSource], disabledSourceIds: [] } }] });
    const homes = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://private-theme-home.example.test',
        accountId: 'theme-requester', serverIdentityId: homeIdentityId, currentAccount: true }], route: async request => {
        const catalogResponse = await catalog.handle(request.path, { method: request.method, headers: request.headers,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
        if (catalogResponse) return catalogResponse;
        if (request.path === '/v1/machines') return Response.json([machineRow]);
        if (request.path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(request.body, id => id === machineId
            ? { ...createPlainMachineRowFixture({ id: machineId, accountId: 'theme-custodian' }), ...publishedThemeMachine } : null);
        if (!request.path.startsWith('/v1/actions/')) return undefined;
        expect(request.accountId).toBe('theme-requester');
        const body = request.body as Readonly<{ envelope: unknown; executionAuthorization?: unknown }>;
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body.envelope);
        const actionId = request.path.split('/')[3]!;
        expect(actionId).toBe('registries.items.read');
        if (request.path.endsWith('/execution-authorization')) return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({
            v: 1, token: 'home-signed-theme-requester', binding: { accountId: request.accountId, authentication: { kind: 'account', tokenEpoch: 0 },
                serverIdentityId: homeIdentityId, machineId, installationId, custodianAccountId: 'theme-custodian', accountEncryptionMode: 'plain',
                actionId, requestId: envelope.requestId, target: envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) },
        }));
        expect(openExternalActionRequesterAccountContextV1({ authorization: body.executionAuthorization,
            purpose: { kind: 'external_action' }, machineId, installationId, serverIdentityId: homeIdentityId,
            installationPrivateKey: installation.secretKey })).toMatchObject({ token: expect.any(String) });
        const result = await daemonThemeHost.execute('registries.items.read', envelope.input,
            envelope.registryThemeContent ? { themeContent: envelope.registryThemeContent } : undefined);
        return Response.json({ v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result } });
    } });
    onTestFinished(async () => { await standardCleanup(); await homes.dispose(); });
    setRuntimeFetch((input, init) => String(input) === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL
        ? Promise.resolve(new Response(null, { status: 503 })) : homes.fetch(input, init));
    await setServerProfileIdentityForUrl(homes.homes.home!.serverUrl, homeIdentityId);
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const account = await captureLazyActionAccountContext(homes.homes.home!.id);
    onTestFinished(() => account.dispose());
    await storage.getState().activateSettingsScope({ serverId: account.serverId, accountId: account.accountId });
    storage.getState().applySettingsForScope({ serverId: account.serverId, accountId: account.accountId }, storage.getState().settings, 1);
    await publishMachineInventoryForTest(account.accountLifetime.scope, [createMachineFixture({ id: machineId, activeAt: Date.now() })]);
    const port = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account).organization!;
    transport.calls.length = 0;
    const host = await createUiRegistryHostV1(account, port, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
    expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read',
        { kind: 'theme', sourceId: themeSource.id, itemId: 'sample/palette' })).item.payload).toMatchObject({ kind: 'theme', state: 'listing' });
    expect(themeReads).toHaveLength(2);
    themeReads.length = 0;
    const privateTheme = await host.readRegistryTheme({ sourceId: themeSource.id, itemId: 'sample/palette' });
    expect(privateTheme.item.payload.themes[0]).toMatchObject({ mode: 'dark', document: { profile: {
        assetAppearance: 'dark', overrides: { dark: { 'background.canvas': '#123456' } },
    } } });
    expect(themeReads).toHaveLength(4);
    expect(transport.calls).toEqual([]);
});

it('refreshes daemon-created sources in the UI and reads tokened sources through the captured requester Account', async () => {
    let phase = 'prepare requester Home';
    let listState: Readonly<{ loading: boolean; error: string | null; count: number }> | undefined;
    onTestFailed(() => console.error('FIX50 composed phase:', phase, listState));
    // The shared admission presenter is a UI boundary; accept so writes reach the requester transport.
    const { Modal } = await import('@/modal');
    const confirmation = vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
    onTestFinished(() => confirmation.mockRestore());
    let upstreamFails = false;
    let allUpstreamsFail = false;
    const checkedSources: RegistryRemoteSourceDescriptorV1[] = ['healthy', '403', '429', 'unreachable'].map(id => ({
        id, title: id, format: 'git', kinds: ['skill'], url: `https://github.com/fixture/${id}`,
        enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true,
    }));
    const produceCheck = async () => {
        const http = createUiRegistryHttpV1(async url => {
            const path = String(url);
            if (allUpstreamsFail) throw new TypeError('offline');
            if (upstreamFails && path.includes('/403/')) return new Response('', { status: 403 });
            if (upstreamFails && path.includes('/429/')) return new Response('', { status: 429 });
            if (upstreamFails && path.includes('/unreachable/')) throw new TypeError('offline');
            return Response.json({ sha: '1'.repeat(40) });
        });
        const upstream = await checkRegistryUpstreamV1({ http }, { sources: checkedSources, items: checkedSources.map(source => ({
            key: source.id, provenance: { sourceId: source.id, sourceUrl: source.url, format: source.format, itemId: 'review', importedAt: 0,
                ref: { kind: 'gitTree' as const, repo: source.url, path: 'review', commit: '1'.repeat(40), treeSha: '2'.repeat(40) } },
        })) });
        return REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse({ checkedAt: upstreamFails ? 20 : 10,
            results: checkedSources.map(source => ({ kind: 'skill', key: source.id, upstream: upstream.get(source.id),
                ...(upstream.get(source.id)?.state === 'unchecked' ? { sourceId: source.id, sourceTitle: source.title } : {}) })) });
    };
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
    const machineId = 'shared-registry-machine';
    const packagePluginId = 'com.acme.requester-apps';
    const packageSourceId = `${packagePluginId}/apps`;
    const installationId = 'shared-registry-installation';
    const homeIdentityId = 'srv_registry_requester_home';
    const machineRow = { ...ExternalActionMachineBootstrapV1Schema.parse({ id: machineId, kind: 'persistent', active: true,
        installationId, revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
        access: { custodian: { accountId: 'registry-custodian', displayName: 'Custodian' }, role: 'use', resourceMode: 'plain', accessState: 'ready' } }),
        installationPublicKey: encodeBase64(installation.publicKey) };
    const source: RegistrySourceV1 = { id: 'private-requester-source', title: 'Private requester source', format: 'git',
        kinds: ['skill'], url: 'https://github.com/requester/private', enabled: true, addedAt: 0,
        token: { secretRef: 'happier:shared-secret:v1:requester-secret' } };
    const addedSource: RegistrySourceV1 = { ...source, id: 'daemon-created-source', title: 'New private source',
        url: 'https://github.com/requester/new-private' };
    const botSource: RegistrySourceV1 = { id: 'requester-bots', title: 'Requester Bots', format: 'happier-npm', kinds: ['plugin'],
        url: 'https://registry.example.test', enabled: true, addedAt: 0 };
    const botPointer = { sourceId: botSource.id, itemId: '@requester/helper', version: '1.0.0' };
    const botRelease = { v: 1, version: '2.0.0', releasedAtMs: 1, changelog: '', content: {
        v: 1, identity: { name: 'Requester helper', description: '' }, instructions: { markdown: 'Help privately.' },
        memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] },
    } };
    const actionCalls: string[] = [];
    let appRevision = 3, appReadable = true, appUpstreamReads = 0, appAdmissionReads = 0;
    const appEnvironment = createDeploymentEnvironmentHeaderV1({ id: 'template-environment', serverId: homeIdentityId,
        controllerMachineId: machineId });
    let appContentBodyVersion = appEnvironment.contentBodyVersion;
    let appMetadataReads = 0;
    const appSource = listRegistrySourcesV1({ record: { v: 2, sources: [], disabledSourceIds: [] }, pluginSources: [] })
        .find(source => source.format === 'happier-catalog' && source.kinds.includes('app'))!;
    const appHttp = createUiRegistryHttpV1(async () => {
        appUpstreamReads++;
        return Response.json({ schemaVersion: 1, apps: [{ itemId: 'web', app: { schemaVersion: 1, title: 'Web',
            compose: { document: 'services:\n  web:\n    image: nginx:1\n', services: ['web'], profiles: [] },
            variables: [], generatedSecrets: [], domains: [], volumes: [] } }] });
    });
    const appItem = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await createRegistryHostV1({
        host: 'node', http: appHttp, readSources: async () => [appSource],
    }).execute('registries.items.read', { kind: 'app', sourceId: appSource.id, itemId: 'web' })).item;
    if (appItem.payload.kind !== 'app') throw new Error('Expected selected app');
    const appRef = { sourceId: appSource.id, itemId: 'web', version: appItem.summary.version!, ref: appItem.payload.ref };
    let currentAppRef = appRef;
    appUpstreamReads = 0;
    let remoteExecution: ActionExecuteResult | null = null;
    let afterRemoteAck: (() => void) | undefined;
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'registry-requester', encryptionMode: 'plain' });
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources',
        value: { v: 2, sources: [source, botSource], disabledSourceIds: [] } }] });
    const homes = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://registry-requester.example.test',
        accountId: 'registry-requester', serverIdentityId: homeIdentityId, currentAccount: true }], route: async request => {
        const artifactResponse = artifacts.handle(request.path, { method: request.method,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
        if (artifactResponse) return await artifactResponse;
        const catalogResponse = await catalog.handle(request.path, { method: request.method, headers: request.headers,
            ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
        if (catalogResponse) return catalogResponse;
        if (request.path === `/v1/deployments/environments/${appEnvironment.id}`) {
            appMetadataReads++;
            return Response.json(appReadable
                ? { ok: true, environment: { ...appEnvironment, revision: appRevision, contentBodyVersion: appContentBodyVersion }, targetLinks: [] }
                : { ok: false, error: 'deployment_access_denied' });
        }
        if (request.path === '/v1/machines') return Response.json([machineRow]);
        if (request.path === '/v1/machines/read-batch' && request.method === 'POST') {
            // The batched read publishes the stored row; its bootstrap fields keep the installation identity.
            const { runnerClaim: _bootstrapOnly, ...publishedFields } = machineRow;
            return createMachineReadBatchResponseFixture(request.body, id => id === machineId
                ? { ...createPlainMachineRowFixture({ id: machineId, accountId: 'registry-custodian' }), ...publishedFields } : null);
        }
        if (!request.path.startsWith('/v1/actions/')) return undefined;
        expect(request.accountId).toBe('registry-requester');
        const body = request.body as Readonly<{ envelope: unknown; executionAuthorization?: unknown }>;
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(body.envelope);
        const actionId = request.path.split('/')[3]!;
        if (request.path.endsWith('/execution-authorization')) return Response.json(ExternalActionExecutionAuthorizationV1Schema.parse({
            v: 1, token: 'home-signed-requester', binding: { accountId: request.accountId, authentication: { kind: 'account', tokenEpoch: 0 },
                serverIdentityId: homeIdentityId, machineId, installationId, custodianAccountId: 'registry-custodian', accountEncryptionMode: 'plain',
                actionId, requestId: envelope.requestId, target: envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                ...(projectExternalActionRegistryAppUpdateEnvelopeAdmissionV1({ actionId, envelope })
                    ? { registryAppUpdateAdmission: projectExternalActionRegistryAppUpdateEnvelopeAdmissionV1({ actionId, envelope }) } : {}) },
        }));
        expect(openExternalActionRequesterAccountContextV1({ authorization: body.executionAuthorization,
            purpose: { kind: 'external_action' }, machineId, installationId, serverIdentityId: homeIdentityId,
            installationPrivateKey: installation.secretKey })).toMatchObject({ token: expect.any(String) });
        actionCalls.push(actionId);
        if (actionId === 'template.preview') {
            expect(envelope.input).toEqual({ source: { kind: 'plugin', registryItem: botPointer, contributionId: 'helper' } });
            return Response.json({ v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result: {
                source: { kind: 'plugin', registryItem: botPointer, contributionId: 'helper' }, release: botRelease,
            } } });
        }
        if (actionId === 'registries.sources.create') {
            // The remote process is the boundary: commit its row through the same Home CAS protocol,
            // without sending a socket echo. The UI must revalidate on the acknowledged Action alone.
            const record = catalog.read('registry-sources');
            if (record.key !== 'registry-sources') throw new Error('Expected registry row');
            const written = await catalog.handle('/v1/account/entity-rows/prompt-library/registry-sources', {
                method: 'POST', body: JSON.stringify({ expectedRevision: catalog.revision('registry-sources'),
                    content: { t: 'plain', v: { ...record, value: { ...record.value, sources: [...record.value.sources, addedSource] } } } }),
            });
            expect(await written?.json()).toMatchObject({ status: 'updated' });
            const output = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.sources.create'].parse({ existing: false,
                source: listRegistrySourcesV1({ record: { ...record.value, sources: [addedSource] }, pluginSources: [] })
                    .find(candidate => candidate.id === addedSource.id) });
            return Response.json({ v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result: output } });
        }
        if (actionId.startsWith('skills.') || actionId === 'prompt_registry.install') {
            const response = ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: envelope.requestId,
                execution: remoteExecution ?? { ok: false, errorCode: 'origin_probe_refused', error: 'origin_probe_refused' } });
            afterRemoteAck?.();
            return Response.json(response);
        }
        const appDemand = actionId === 'registries.updates.check' && envelope.input !== null
            && typeof envelope.input === 'object' && 'kind' in envelope.input && envelope.input.kind === 'app';
        const appInput = appDemand ? REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.updates.check'].parse(envelope.input) : null;
        const result = appInput?.kind === 'app' ? await checkRegistryAppUpdatesV1({ http: appHttp }, {
            environments: appInput.environments,
            readEnvironment: async id => {
                appAdmissionReads++;
                if (!appReadable) throw new RegistryFetchErrorV1({ state: 'auth_failed' });
                return { environment: { id, revision: appRevision }, content: { template: { templateRef: currentAppRef } } };
            },
            readSources: async () => [appSource],
        }) : actionId === 'registries.updates.check' ? await produceCheck()
            : actionId === 'registries.items.list' ? { pages: [source.id, packageSourceId].map(sourceId => ({ sourceId,
                status: { state: 'ok', fetchedAt: 1 }, items: [], nextCursor: null })) }
            : { item: { summary: { sourceId: source.id, kind: 'skill', itemId: 'private-skill', title: 'Requester skill', version: '1'.repeat(40) },
                payload: { kind: 'skill', skill: { ref: { kind: 'gitTree', repo: source.url, path: '', commit: '1'.repeat(40), treeSha: '2'.repeat(40) },
                    skillMarkdown: '---\nname: requester-skill\n---\nPrivate content', files: [] } }, fetchedAt: 1 } };
        return Response.json({ v: 1, actionId, requestId: envelope.requestId, execution: { ok: true, result } });
    } });
    onTestFinished(() => homes.dispose());
    setRuntimeFetch(async (input, init) => {
        const url = String(input);
        if (url === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL) return new Response(null, { status: 503 });
        return homes.fetch(input, init);
    });
    const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
    await setServerProfileIdentityForUrl(homes.homes.home!.serverUrl, homeIdentityId);
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const account = await captureLazyActionAccountContext(homes.homes.home!.id);
    expect(account.serverIdentityId).toBe(homeIdentityId);
    // A scoped echo does not activate a different scope. Identity adoption
    // must activate the canonical Home scope before publishing its Settings.
    await storage.getState().activateSettingsScope({ serverId: account.serverId, accountId: account.accountId });
    storage.getState().applySettingsForScope({ serverId: account.serverId, accountId: account.accountId }, storage.getState().settings, 1);
    onTestFinished(() => account.dispose());
    const previous = storage.getState().machineListByServerId;
    const machines = storage.getState().machines;
    const machine = createMachineFixture({ id: machineId, activeAt: Date.now() });
    await publishMachineInventoryForTest(account.accountLifetime.scope, [machine]);
    onTestFinished(() => storage.setState({ machines, machineListByServerId: previous }));
    const port = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account).organization;
    if (!port) throw new Error('Canonical prompt-library store must expose its organization port');
    const baseline = await port.readCatalog(undefined, 'registry-sources');
    expect(baseline.catalog).toMatchObject({ status: 'ready' });
    transport.calls.length = 0;
    const host = await createUiRegistryHostV1(account, port, { surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' }, actionRequestId: 'requester-registry-read' });
    phase = 'mount UI source list';
    const sourceList = await renderHook(() => {
        const value = useRegistrySources('skill');
        listState = { loading: value.loading, error: value.error, count: value.sources.length };
        return value;
    });
    phase = 'wait for initial UI source list';
    await waitForHomeGovernance(() => expect(sourceList.getCurrent().sources.some(candidate => candidate.id === source.id)).toBe(true));
    const beforeCreate = catalog.revision('registry-sources');
    phase = 'execute daemon create and acknowledge catalog invalidation';
    await act(async () => { await host.execute('registries.sources.create', {
        url: addedSource.url, token: addedSource.token,
    }); });
    expect(catalog.revision('registry-sources')).toBe(beforeCreate + 1);
    phase = 'wait for daemon-created source in mounted UI list';
    await waitForHomeGovernance(() => expect(sourceList.getCurrent().sources.some(candidate => candidate.id === addedSource.id)).toBe(true));
    expect(actionCalls).toEqual(['registries.sources.create']);
    actionCalls.length = 0;
    const { createUiBotTemplateAction } = await import('@/sync/ops/actions/botTemplateActionDeps');
    const botPreview = await createUiBotTemplateAction(account, () => {}, port)({ actionId: 'template.preview',
        input: { source: { kind: 'plugin', registryItem: botPointer, contributionId: 'helper' } },
        context: { surface: 'ui', authority: 'present_user', serverId: account.serverId },
    });
    expect(botPreview).toEqual({ source: { kind: 'plugin', registryItem: botPointer, contributionId: 'helper' }, release: botRelease });
    expect(actionCalls.splice(0)).toEqual(['template.preview']);
    expect(transport.calls).toEqual([]);
    phase = 'existing requester private-read corridor';
    expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list',
        { kind: 'skill', sourceIds: [source.id], refresh: true })).pages[0]).toMatchObject({ sourceId: source.id, machineId });
    expect(actionCalls).toEqual(['registries.items.list']);
    expect(transport.calls).toEqual([]);
    expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await host.execute('registries.items.read',
        { kind: 'skill', sourceId: source.id, itemId: 'private-skill', version: '1'.repeat(40) })).item.summary.title).toBe('Requester skill');
    expect(actionCalls).toEqual(['registries.items.list', 'registries.items.read']);
    expect(transport.calls).toEqual([]);
    phase = 'packaged app requester read after its supplier reloads independently';
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Requester Account lifetime must be applied');
    const packageOccurrenceId = 'requester-apps:1';
    const packageOrigin = { serverIdentityId: homeIdentityId, materializationRef: {
        machineId, pluginId: packagePluginId, materializationId: 'requester-apps',
    } };
    const packageEntry = projectPluginRegistrySourceDeclarationV1({ pluginId: packagePluginId, pluginVersion: '1.0.0', definition: {
        id: 'apps', title: 'Requester apps', format: 'happier-catalog', kinds: ['app'], packageContent: { path: 'resources/apps.json' },
    } });
    const packageModel = normalizePluginInstalledUiDeclarations({}, undefined, { id: packagePluginId, displayName: 'Requester apps',
        version: '1.0.0', enabled: true, occurrenceId: packageOccurrenceId, source: { kind: 'path', locator: '/plugins/requester-apps' } },
    [{ ...packageEntry, occurrenceId: packageOccurrenceId, executionOrigin: packageOrigin }]);
    const otherOccurrenceId = 'requester-apps:older';
    const otherOrigin = { serverIdentityId: homeIdentityId, materializationRef: {
        machineId: 'other-package-supplier', pluginId: packagePluginId, materializationId: 'other-requester-apps',
    } };
    const otherModel = normalizePluginInstalledUiDeclarations({}, undefined, { id: packagePluginId, displayName: 'Requester apps',
        version: '1.0.0', enabled: true, occurrenceId: otherOccurrenceId, source: { kind: 'path', locator: '/plugins/requester-apps' } },
    [{ ...packageEntry, occurrenceId: otherOccurrenceId, executionOrigin: otherOrigin }]);
    const packageProjection = unionPluginUiProjections([
        { machineId: 'other-package-supplier', serverId: account.serverId, phase: 'current', interactionEnabled: true,
            selectableExecutionOrigins: [otherOrigin], projection: otherModel },
        { machineId, serverId: account.serverId, phase: 'current', interactionEnabled: true,
            selectableExecutionOrigins: [packageOrigin], projection: packageModel },
    ], new Map([[packagePluginId, otherOrigin]])).pluginUiProjection;
    expect(packageProjection?.registrySourcesById[packageSourceId]).toMatchObject({ occurrenceId: otherOccurrenceId });
    const packageScreen = await renderScreen(React.createElement(AppShellPluginUiProjectionValueProvider, { value: {
        pluginUiProjection: packageProjection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
        machineId, serverId: account.serverId, platform: 'web', accountLifetime: lifetime,
        reloadConnectedAccountProjection: () => {}, connectedAccountProjectionState: createConnectedAccountDescriptorProjectionLoadingState('package-fixture'),
        clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
    }, children: null }));
    expect(lifetime.isCurrent()).toBe(true);
    expect(lifetime.scope).toEqual({ serverId: account.serverId, accountId: account.accountId });
    expect(readCurrentAppShellPluginUiProjection()).toBe(packageProjection);
    expect(readCurrentAppShellPluginUiProjection({ scope: account, declarationsOnly: true })?.registrySourcesById[packageSourceId])
        .toMatchObject({ occurrenceId: otherOccurrenceId });
    const packagedPage = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', {
        kind: 'app', sourceIds: [packageSourceId], refresh: true,
    })).pages[0];
    expect(packagedPage).toMatchObject({ sourceId: packageSourceId, machineId, status: { state: 'ok' } });
    expect(actionCalls.at(-1)).toBe('registries.items.list');
    expect(transport.calls).toEqual([]);
    await packageScreen.unmount();
    const checked = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'].parse(await host.execute('registries.updates.check', {
        kind: 'skill', keys: ['tracked-private-skill'],
    }));
    expect(checked.results).toHaveLength(4);
    expect(checked.results.every(item => item.upstream.state === 'current')).toBe(true);
    expect(actionCalls.at(-1)).toBe('registries.updates.check');
    expect(transport.calls).toEqual([]);
    phase = 'same-session app memo hits add no Environment GET or daemon admission';
    const appDemand = { kind: 'app', environments: [{ environmentId: appEnvironment.id, expectedRevision: appRevision }] };
    // Passthrough instrumentation counts schema traversals; every real parser and transport remains active.
    const inputParses = vi.spyOn(REGISTRY_ACTION_INPUT_SCHEMAS_V1['registries.updates.check'], 'parse');
    const outputParses = vi.spyOn(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.updates.check'], 'parse');
    onTestFinished(() => { inputParses.mockRestore(); outputParses.mockRestore(); });
    const firstApp = await host.execute('registries.updates.check', appDemand);
    expect(firstApp).toMatchObject({ results: [{ kind: 'app', key: appEnvironment.id, upstream: { state: 'current', latest: appRef.ref } }] });
    expect.soft({ metadata: appMetadataReads, admissions: appAdmissionReads, upstream: appUpstreamReads })
        .toEqual({ metadata: 0, admissions: 1, upstream: 1 });
    // One UI ingress, two existing protocol-owner parses, and one remote test transport ingress.
    expect.soft(inputParses).toHaveBeenCalledTimes(4);
    // The remote result and protocol result validate their boundaries; the UI trusts that result.
    expect.soft(outputParses).toHaveBeenCalledTimes(2);
    const reopened = await createUiRegistryHostV1(account, port, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
    for (let open = 0; open < 3; open++) expect(await reopened.execute('registries.updates.check', appDemand)).toEqual(firstApp);
    expect.soft({ metadata: appMetadataReads, admissions: appAdmissionReads, upstream: appUpstreamReads })
        .toEqual({ metadata: 0, admissions: 1, upstream: 1 });
    phase = 'the UI Action adapter parses one ingress and reuses its typed memo result';
    inputParses.mockClear(); outputParses.mockClear();
    expect(await createUiRegistryActionExecuteV1(account, port)({ actionId: 'registries.updates.check', input: appDemand,
        context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } })).toEqual(firstApp);
    expect.soft(inputParses).toHaveBeenCalledTimes(1);
    expect.soft(outputParses).toHaveBeenCalledTimes(0);
    inputParses.mockRestore(); outputParses.mockRestore();
    phase = 'a real requested revision change admits a new finite observation';
    appRevision++;
    const currentAppDemand = { ...appDemand, environments: [{ environmentId: appEnvironment.id, expectedRevision: appRevision }] };
    expect(await reopened.execute('registries.updates.check', currentAppDemand)).toMatchObject({ results: [{ upstream: { state: 'current' } }] });
    expect.soft({ metadata: appMetadataReads, admissions: appAdmissionReads, upstream: appUpstreamReads })
        .toEqual({ metadata: 0, admissions: 2, upstream: 2 });
    phase = 'daemon admission rejects a stale requested revision on the next finite check';
    invalidateUiRegistryUpdateMemoV1(account, appDemand);
    expect(await reopened.execute('registries.updates.check', appDemand)).toMatchObject({
        results: [{ upstream: { state: 'unchecked', reason: { state: 'invalid_source' } } }],
    });
    expect(appUpstreamReads).toBe(2);
    phase = 'explicit refresh delegates withdrawn access to daemon admission';
    appReadable = false;
    invalidateUiRegistryUpdateMemoV1(account, currentAppDemand);
    expect(await reopened.execute('registries.updates.check', currentAppDemand)).toMatchObject({
        results: [{ upstream: { state: 'unchecked', reason: { state: 'auth_failed' } } }],
    });
    expect(appUpstreamReads).toBe(2);
    appReadable = true;
    phase = 'restored Source authority requires a new finite observation';
    expect(await reopened.execute('registries.updates.check', currentAppDemand)).toMatchObject({
        results: [{ kind: 'app', key: appEnvironment.id, upstream: { state: 'current', latest: appRef.ref } }],
    });
    expect(appUpstreamReads).toBe(3);
    phase = 'open Environment consumes the finite registry observation without another content reader';
    const { createDeploymentReadControllerV1 } = await import('@happier-dev/deployments');
    const { createDeploymentEnvironmentDetailV1 } = await import('@happier-dev/deployments/testing/v1');
    const { useDeploymentEnvironment } = await import('@/components/projects/deployments/useDeploymentReads');
    const baseDetail = createDeploymentEnvironmentDetailV1();
    let appDetail = createDeploymentEnvironmentDetailV1({ environment: { ...appEnvironment, revision: appRevision }, targetLinks: [],
        content: { ...baseDetail.content, template: { templateRef: appRef, services: ['web'],
            definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'a'.repeat(64)}` } } } });
    const controller = createDeploymentReadControllerV1({ scope: { serverId: appEnvironment.serverId, accountId: account.accountId,
        projectSourceId: appEnvironment.projectSourceId }, transport: {
        readEnvironment: async () => ({ ok: true, value: appDetail }),
        listEnvironments: async () => { throw new Error('An app observation cannot list Environments'); },
        listHistory: async () => { throw new Error('An app observation cannot load History'); },
        readReceipt: async () => { throw new Error('An app observation cannot load receipts'); },
    } });
    // An unrelated/offline Store choice must not place an installed App's catalog read.
    const { StoreMachineScopeContext } = await import('@/components/settings/plugins/model/useStoreMachineScope');
    const unrelatedStore = ({ children }: React.PropsWithChildren) => <StoreMachineScopeContext.Provider
        value={{ serverId: account.serverId, machineId: 'offline-store-choice' }}>{children}</StoreMachineScopeContext.Provider>;
    let appPage = await renderHook(() => useDeploymentEnvironment(controller, appEnvironment.id,
        { mounted: true, visible: true, focused: true }), { wrapper: unrelatedStore });
    onTestFinished(() => controller.retire());
    await waitForHomeGovernance(() => expect(appPage.getCurrent()).toMatchObject({
        catalogUpdate: { upstream: { state: 'current', latest: appRef.ref }, loading: false, error: null },
    }));
    expect(appUpstreamReads).toBe(3);
    phase = 'closing and reopening the Environment retains only the registry session observation';
    await appPage.unmount();
    const hiddenAppPage = await renderHook(() => useDeploymentEnvironment(controller, appEnvironment.id,
        { mounted: true, visible: false, focused: false }));
    expect(hiddenAppPage.getCurrent().catalogUpdate.upstream).toBeNull();
    expect(appUpstreamReads).toBe(3);
    await hiddenAppPage.unmount();
    appPage = await renderHook(() => useDeploymentEnvironment(controller, appEnvironment.id,
        { mounted: true, visible: true, focused: true }));
    await waitForHomeGovernance(() => expect(appPage.getCurrent()).toMatchObject({
        catalogUpdate: { upstream: { state: 'current', latest: appRef.ref }, loading: false, error: null },
    }));
    expect(appUpstreamReads).toBe(3);
    phase = 'private content revision acquires one new admitted observation';
    const metadataBeforeRewrite = appMetadataReads;
    appRevision++;
    appContentBodyVersion++;
    appDetail = { ...appDetail, environment: { ...appDetail.environment, revision: appRevision, contentBodyVersion: appContentBodyVersion },
        content: { ...appDetail.content, name: 'A renamed Environment with the same template' } };
    await act(async () => { await appPage.getCurrent().refresh(); });
    await waitForHomeGovernance(() => {
        expect(appUpstreamReads).toBe(4);
        expect(appPage.getCurrent().catalogUpdate.loading).toBe(false);
    });
    expect(appMetadataReads).toBe(metadataBeforeRewrite);
    phase = 'a changed template reference cannot retain the previous observation';
    currentAppRef = { ...appRef, ref: { kind: 'content', digest: `sha256:${'b'.repeat(64)}` } };
    appRevision++;
    appContentBodyVersion++;
    appDetail = { ...appDetail, environment: { ...appDetail.environment, revision: appRevision, contentBodyVersion: appContentBodyVersion },
        content: { ...appDetail.content, template: { ...appDetail.content.template!, templateRef: currentAppRef } } };
    await act(async () => { await appPage.getCurrent().refresh(); });
    await waitForHomeGovernance(() => expect(appPage.getCurrent().catalogUpdate.upstream?.state).toBe('update_available'));
    expect(appUpstreamReads).toBe(5);
    phase = 'only an explicit catalog refresh repeats the unchanged upstream observation';
    await act(async () => { await appPage.getCurrent().catalogUpdate.refresh(); });
    expect(appUpstreamReads).toBe(6);
    phase = 'a revoked Source cannot retain a successful catalog observation';
    appReadable = false;
    await act(async () => { await appPage.getCurrent().catalogUpdate.refresh(); });
    expect(appPage.getCurrent().catalogUpdate.upstream).toMatchObject({ state: 'unchecked', reason: { state: 'auth_failed' } });
    expect(appUpstreamReads).toBe(6);
    appReadable = true;
    phase = 'restored access is admitted on the next requested check';
    const pendingDemand = { kind: 'app', environments: [{ environmentId: appEnvironment.id, expectedRevision: appRevision }] };
    await reopened.execute('registries.updates.check', pendingDemand);
    expect(appUpstreamReads).toBe(7);
    const fixture = createPromptRegistrySkillFixture({ sourceId: source.id, itemId: 'private-skill', title: 'Requester skill',
        files: [{ path: 'SKILL.md', content: '---\nname: requester-skill\n---\nPrivate content' }] });
    const store = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account);
    const created = await store.create!({ header: PromptBundleArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_bundle.v2',
        title: 'Requester skill', bundleSchemaId: 'skills.skill_md_v1', skillLock: SkillLockV1Schema.parse({ updatePolicy: 'manual',
            upstream: { state: 'update_available', latest: fixture.item.payload.kind === 'skill' ? fixture.item.payload.skill.ref : undefined },
            provenance: { kind: 'registry', registry: { sourceId: source.id, format: source.format, sourceUrl: source.url, importedAt: 0,
                itemId: 'private-skill', ref: fixture.item.payload.kind === 'skill'
                ? fixture.item.payload.skill.ref : undefined } } }) }),
        body: JSON.stringify(PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 0, updatedAtMs: 0,
            entries: fixture.files.map(file => ({ ...file, contentKind: 'utf8' })) })) });
    const skillId = typeof created === 'string' ? created : created.artifactId;
    const expectedRevision = typeof created === 'string' ? '1:1' : encodeSkillRevisionV1(created.revision);
    onTestFinished(() => storage.getState().deleteArtifact(skillId));
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const executor = createDefaultActionExecutor();
    for (const [actionId, input] of [
        ['skills.install', { source: { kind: 'registry', sourceId: source.id, itemId: 'private-skill', version: '1'.repeat(40) }, dryRun: true }],
        ['skills.updates.diff', { skillId }],
        ['skills.updates.apply', { skillId, expectedRevision }],
        ['prompt_registry.install', { machineId, sourceId: source.id, itemId: 'private-skill' }],
    ] as const) {
        expect.soft(await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user', serverId: account.serverId }))
            .toMatchObject({ ok: false, errorCode: 'origin_probe_refused', error: 'origin_probe_refused' });
        expect.soft(actionCalls.at(-1)).toBe(actionId);
    }
    expect(artifacts.list()).toHaveLength(1);
    expect(transport.calls).toEqual([]);
    const installInput = { source: { kind: 'registry', sourceId: source.id, itemId: 'private-skill', version: '1'.repeat(40) } } as const;
    remoteExecution = { ok: true, result: SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse({ skillIds: [skillId], includedInSessionId: null }) };
    expect(storage.getState().settingsScope).toEqual({ serverId: account.serverId, accountId: account.accountId });
    await account.fetchArtifact(skillId);
    expect(storage.getState().artifacts[skillId]?.body).toBe(artifacts.readPlainBody(skillId));
    storage.getState().deleteArtifact(skillId);
    expect(await executor.execute('skills.install', installInput, { surface: 'ui', serverId: account.serverId }))
        .toEqual(remoteExecution);
    expect(storage.getState().artifacts[skillId]?.body).toBe(artifacts.readPlainBody(skillId));
    const cancelledAfterAck = new AbortController();
    afterRemoteAck = () => cancelledAfterAck.abort();
    expect(await executor.execute('skills.install', installInput, { surface: 'ui', serverId: account.serverId, signal: cancelledAfterAck.signal }))
        .toEqual(remoteExecution);
    const cancelledPreview = new AbortController();
    afterRemoteAck = () => cancelledPreview.abort();
    remoteExecution = { ok: true, result: SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.install'].parse({ items: [] }) };
    const preview = await executor.execute('skills.install', { ...installInput, dryRun: true },
        { surface: 'ui', serverId: account.serverId, signal: cancelledPreview.signal }).then(
            result => ({ kind: 'returned' as const, result }), error => ({ kind: 'rejected' as const, error }));
    if (preview.kind === 'returned') expect(preview.result.ok).toBe(false);
    else expect(preview.error).toMatchObject({ name: 'AbortError' });
    expect(artifacts.list()).toHaveLength(1);
    expect(transport.calls).toEqual([]);
    const updates = await renderHook(() => useSkillsUpdates(useSkillsLibrary()));
    const detail = await renderHook(() => useSkillDetail(skillId));
    await waitForHomeGovernance(() => expect(updates.getCurrent().ready).toBe(true));
    await act(async () => { await updates.getCurrent().checkNow(); });
    expect(updates.getCurrent().check).toMatchObject({ failed: false, checkedAt: 10 });
    upstreamFails = true;
    await act(async () => { await updates.getCurrent().checkNow(); });
    expect(updates.getCurrent().check).toMatchObject({ failed: true, checkedAt: 10, results: [
        { key: 'healthy', upstream: { state: 'current' } },
        { key: '403', sourceId: '403', sourceTitle: '403', upstream: { state: 'unchecked', reason: { state: 'auth_failed' } } },
        { key: '429', sourceId: '429', sourceTitle: '429', upstream: { state: 'unchecked', reason: { state: 'rate_limited' } } },
        { key: 'unreachable', sourceId: 'unreachable', sourceTitle: 'unreachable', upstream: { state: 'unchecked', reason: { state: 'unreachable' } } },
    ] });
    expect(artifacts.readPlainBody(skillId)).toBe(JSON.stringify(PromptBundleBodyV1Schema.parse({ v: 1, createdAtMs: 0, updatedAtMs: 0,
        entries: fixture.files.map(file => ({ ...file, contentKind: 'utf8' })) })));
    await act(async () => { await detail.getCurrent().checkNow(); });
    expect(detail.getCurrent().checkFailed).toBe(true);
    allUpstreamsFail = true;
    await act(async () => { await updates.getCurrent().checkNow(); await detail.getCurrent().checkNow(); });
    expect(updates.getCurrent().check).toMatchObject({ failed: true, checkedAt: 10 });
    expect(updates.getCurrent().check.results).toHaveLength(4);
    expect(updates.getCurrent().check.results.every(item => item.upstream.state === 'unchecked')).toBe(true);
    expect(detail.getCurrent().checkFailed).toBe(true);
    allUpstreamsFail = false;
    upstreamFails = false;
    await act(async () => { await updates.getCurrent().checkNow(); await detail.getCurrent().checkNow(); });
    expect(updates.getCurrent().check.failed).toBe(false);
    expect(detail.getCurrent().checkFailed).toBe(false);
    await updates.unmount();
    await detail.unmount();
    await sourceList.unmount();
});

it('routes native non-GitHub Git through the captured Account Machine transport while keeping public GitHub direct', async () => {
    transport.platform = 'ios';
    const sources: RegistrySourceV1[] = [
        { id: 'native-other-git', title: 'Other Git', format: 'git', kinds: ['skill'], url: 'https://git.example.test/a/b.git', enabled: true, addedAt: 0 },
        { id: 'native-github', title: 'GitHub', format: 'git', kinds: ['skill'], url: 'https://github.com/a/b', enabled: true, addedAt: 0 },
    ];
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources', value: { v: 2, sources, disabledSourceIds: [] } }] });
    const homes = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://registry-native.example.test', accountId: 'native-registry-account', serverIdentityId: 'srv_registry_native' }],
        route: async request => await catalog.handle(request.path, { method: request.method, headers: request.headers,
            body: request.body === undefined ? undefined : JSON.stringify(request.body) }) ?? undefined });
    onTestFinished(async () => { try { await homes.dispose(); } finally { transport.platform = 'web'; } });
    onTestFailed(() => console.error('Native registry Home requests:', JSON.stringify(homes.requests.map(request => ({ path: request.path, method: request.method })))));
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const account = await captureLazyActionAccountContext(homes.homes.home!.id);
    onTestFinished(() => account.dispose());
    const previousMachines = storage.getState().machineListByServerId;
    const previousActiveMachines = storage.getState().machines;
    const previousStatuses = storage.getState().machineListStatusByServerId;
    const machine = createMachineFixture({ id: 'native-git-machine', activeAt: Date.now() });
    await publishMachineInventoryForTest(account.accountLifetime.scope, [machine]);
    const port = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account).organization!;
    transport.calls.length = 0;
    setRuntimeFetch(async (url, init) => new URL(String(url)).origin === new URL(homes.homes.home!.serverUrl).origin
        ? homes.fetch(url, init)
        : Response.json(String(url).includes('/commits/') ? { sha: '1'.repeat(40) } : { sha: '2'.repeat(40), tree: [] }));
    try {
        const host = await createUiRegistryHostV1(account, port, {});
        const output = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', {
            kind: 'skill', sourceIds: ['native-other-git', 'native-github'], refresh: true,
        }));
        expect(output.pages.map(page => ({ sourceId: page.sourceId, state: page.status.state, machineId: page.machineId })))
            .toEqual([{ sourceId: 'native-other-git', state: 'ok', machineId: machine.id }, { sourceId: 'native-github', state: 'ok', machineId: undefined }]);
        expect(transport.calls.map(call => ({ machineId: call.machineId, serverId: call.serverId, accountId: call.accountId, method: call.method, payload: call.payload })))
            .toEqual([{ machineId: machine.id, serverId: account.serverId, accountId: account.accountId, method: 'daemon.registries.fetch',
                payload: { op: 'list', kind: 'skill', sourceId: 'native-other-git' } }]);
        const selectedMachine = createMachineFixture({ id: 'zz-explicit-registry-machine', createdAt: machine.createdAt - 1, activeAt: Date.now() });
        await publishMachineInventoryForTest(account.accountLifetime.scope, [machine, selectedMachine]);
        const targeted = await createUiRegistryHostV1(account, port, {
            externalActionTarget: { kind: 'machine', machineId: selectedMachine.id },
        });
        const defaultRead = { kind: 'skill' as const, sourceIds: ['native-other-git'] };
        await host.execute('registries.items.list', defaultRead);
        const targetedOutput = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(
            await targeted.execute('registries.items.list', defaultRead));
        expect(targetedOutput.pages[0]?.machineId).toBe(selectedMachine.id);
        expect(transport.calls.at(-1)?.machineId).toBe(selectedMachine.id);
        await publishMachineInventoryForTest(account.accountLifetime.scope, [machine]);
        const missingTarget = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(
            await targeted.execute('registries.items.list', { ...defaultRead, refresh: true }));
        expect(missingTarget.pages[0]?.status.state).toBe('needs_machine');
        await publishMachineInventoryForTest(account.accountLifetime.scope, []);
        const offline = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', {
            kind: 'skill', sourceIds: ['native-other-git', 'native-github'], refresh: true,
        }));
        expect(offline.pages.map(page => ({ sourceId: page.sourceId, state: page.status.state })))
            .toEqual([{ sourceId: 'native-other-git', state: 'needs_machine' }, { sourceId: 'native-github', state: 'ok' }]);
    } finally {
        storage.setState({ machines: previousActiveMachines, machineListByServerId: previousMachines, machineListStatusByServerId: previousStatuses });
        clearMachineRequestReachabilityForTest();
    }
});

it.each([
    { platform: 'web', query: undefined },
    { platform: 'ios', query: undefined },
    { platform: 'web', query: 'review' },
])('recovers only failed sources on $platform (query: $query) and preserves explicit Retry for healthy sources', async ({ platform, query }) => {
    transport.platform = platform;
    const sources: RegistrySourceV1[] = [
        { id: 'carried-git', title: 'Carried Git', format: 'git', kinds: ['skill'], url: 'https://git.example.test/a/b.git', enabled: true, addedAt: 0 },
        { id: 'healthy-github', title: 'Healthy GitHub', format: 'git', kinds: ['skill'], url: 'https://github.com/a/healthy', enabled: true, addedAt: 0 },
    ];
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources', value: { v: 2, sources, disabledSourceIds: [] } }] });
    const fixtureId = `carrier-arrives-${platform}-${query ?? 'browse'}`;
    const homes = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: `https://${fixtureId}.example.test`, accountId: fixtureId, serverIdentityId: `srv_${fixtureId}` }],
        route: async request => await catalog.handle(request.path, { method: request.method, headers: request.headers,
            body: request.body === undefined ? undefined : JSON.stringify(request.body) }) ?? undefined });
    onTestFinished(async () => { try { await homes.dispose(); } finally { transport.platform = 'web'; } });
    const healthyRequests: string[] = [];
    setRuntimeFetch(async (url, init) => {
        const address = new URL(String(url));
        if (address.origin === new URL(homes.homes.home!.serverUrl).origin) return homes.fetch(url, init);
        healthyRequests.push(address.pathname);
        return Response.json(address.pathname.includes('/commits/') ? { sha: '1'.repeat(40) } : { sha: '2'.repeat(40),
            tree: [{ path: 'review/SKILL.md', mode: '100644', type: 'blob', sha: '3'.repeat(40), size: 10 }] });
    });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const account = await captureLazyActionAccountContext(homes.homes.home!.id);
    onTestFinished(() => account.dispose());
    const previous = storage.getState();
    onTestFinished(() => storage.setState({ machines: previous.machines, machineListByServerId: previous.machineListByServerId,
        machineListStatusByServerId: previous.machineListStatusByServerId }));
    await publishMachineInventoryForTest(account.accountLifetime.scope, []);
    transport.calls.length = 0;
    const input = { kind: 'skill' as const, sourceIds: sources.map(source => source.id), query };
    const hook = await renderHook(() => useRegistryItems(input));
    onTestFinished(() => hook.unmount());
    await waitForHomeGovernance(() => expect(hook.getCurrent().sourceFailures.map(failure => failure.status.state)).toEqual(['needs_machine']));
    expect(hook.getCurrent().items.map(item => item.itemId)).toEqual(['review']);
    expect(transport.calls).toHaveLength(0);
    expect(healthyRequests.length).toBeGreaterThan(0);
    const coldHealthyRequests = [...healthyRequests];
    const machine = createMachineFixture({ id: 'carrier-arrives-machine', activeAt: Date.now() });
    await act(async () => { await publishMachineInventoryForTest(account.accountLifetime.scope, [machine]); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().sourceFailures).toEqual([]));
    expect(hook.getCurrent().items.map(item => item.itemId)).toEqual(['review']);
    expect(transport.calls.map(call => call.machineId)).toEqual([machine.id]);
    expect(healthyRequests).toEqual(coldHealthyRequests);
    await act(async () => { await hook.getCurrent().refresh(); });
    expect(transport.calls.map(call => call.payload.op === 'list' ? call.payload.sourceId : call.payload.op))
        .toEqual(['carried-git', 'carried-git']);
    expect(healthyRequests).toEqual([...coldHealthyRequests, ...coldHealthyRequests]);
    // Losing the carrier while paging must retire this source's healthy first
    // page memo, otherwise recovery merely replays it without reaching the supplier.
    await act(async () => { await publishMachineInventoryForTest(account.accountLifetime.scope, []); });
    await act(async () => { await hook.getCurrent().nextPage(); });
    expect(hook.getCurrent().sourceFailures.map(failure => failure.status.state)).toEqual(['needs_machine']);
    await act(async () => { await publishMachineInventoryForTest(account.accountLifetime.scope, [machine]); });
    await waitForHomeGovernance(() => expect({ requests: transport.calls.length, failures: hook.getCurrent().sourceFailures })
        .toEqual({ requests: 3, failures: [] }));
    expect(hook.getCurrent().items.map(item => item.itemId)).toEqual(['review']);
    expect(healthyRequests).toEqual([...coldHealthyRequests, ...coldHealthyRequests]);
    await hook.unmount();
});

it('reads same-Account offline declarations, routes only to suppliers, retries unreachable suppliers, and retires sources and cached pages', async () => {
    let phase = 'Home credential fixture';
    onTestFailed(() => { console.error(`Registry source composed failure phase: ${phase}`); });
    const catalog = createPromptLibraryCatalogBoundary();
    const homes = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://registry-suppliers.example.test', accountId: 'registry-account', serverIdentityId: 'srv_registry_suppliers' }],
        route: async request => await catalog.handle(request.path, { method: request.method, headers: request.headers,
            body: request.body === undefined ? undefined : JSON.stringify(request.body) }) ?? undefined });
    setRuntimeFetch(async (url, init) => String(url) === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL
        ? new Response(null, { status: 503 }) : homes.fetch(url, init));
    onTestFinished(() => homes.dispose());
    phase = 'captured Account';
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const account = await captureLazyActionAccountContext(homes.homes.home!.id);
    onTestFinished(() => account.dispose());
    phase = 'declaration and AppShell owners';
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Fixture Account lifetime must be applied');
    const pluginId = 'com.acme.sources';
    const entry = projectPluginRegistrySourceDeclarationV1({ pluginId, pluginVersion: '1.0.0', definition: {
        id: 'team', title: 'Team skills', format: 'git', kinds: ['skill'], url: 'https://git.example.test/skills',
    } });
    const model = normalizePluginInstalledUiDeclarations({}, undefined, { id: pluginId, displayName: 'Acme', version: '1.0.0',
        enabled: true, source: { kind: 'path', locator: '/plugins/acme' } }, [entry]);
    let projected = unionPluginUiProjections([{ machineId: 'supplier-a', serverId: account.serverId, phase: 'retainedOffline',
        interactionEnabled: false, projection: model }]).pluginUiProjection;
    expect(projected?.registrySourcesById[entry.id]).toBeDefined();
    const value = () => ({ pluginUiProjection: projected, pluginBrowserProjection: null, phase: 'retainedOffline' as const,
        interactionEnabled: false, machineId: 'supplier-a', serverId: account.serverId, platform: 'web' as const,
        accountLifetime: lifetime, reloadConnectedAccountProjection: () => {},
        connectedAccountProjectionState: createConnectedAccountDescriptorProjectionLoadingState('fixture'),
        clientExecutableActivation: { status: 'ready' as const }, reloadClientExecutables: () => {} });
    const content = () => React.createElement(AppShellPluginUiProjectionValueProvider, { value: value(), children: null });
    phase = 'committed declaration publisher';
    const screen = await renderScreen(content());
    expect(lifetime.isCurrent()).toBe(true);
    expect(readCurrentAppShellPluginUiProjection()).toBeNull();
    expect(readCurrentAppShellPluginUiProjection({ scope: account, declarationsOnly: true })?.registrySourcesById[entry.id]).toBeDefined();
    expect(readCurrentAppShellPluginUiProjection({ scope: { serverId: account.serverId, accountId: 'another-account' }, declarationsOnly: true })).toBeNull();
    const previousMachines = storage.getState().machineListByServerId;
    const previousActiveMachines = storage.getState().machines;
    const previousStatuses = storage.getState().machineListStatusByServerId;
    const machines = [
        createMachineFixture({ id: 'supplier-a', activeAt: Date.now() }), createMachineFixture({ id: 'general-b', activeAt: Date.now(), createdAt: 10 }),
    ];
    await publishMachineInventoryForTest(account.accountLifetime.scope, machines);
    const port = createUiPromptLibraryArtifactStore(account.workflowArtifacts, account).organization!;
    transport.calls.length = 0;
    try {
        phase = 'registry source list and supplier route';
        const host = await createUiRegistryHostV1(account, port, {});
        const sources = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.sources.list'].parse(await host.execute('registries.sources.list', { kind: 'skill' }));
        expect(sources.sources.find(source => source.id === entry.id)?.origin).toEqual({ kind: 'plugin', pluginId, localId: 'team', suppliers: ['supplier-a'] });
        const input = { kind: 'skill', sourceIds: [entry.id], refresh: true };
        const page = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', input));
        expect(page.pages[0]?.machineId).toBe('supplier-a');
        expect(transport.calls[0]?.machineId).toBe('supplier-a');
        expect(transport.calls[0]?.payload).toEqual({ op: 'list', kind: 'skill', sourceId: entry.id });
        recordMachineRequestFailed({ serverId: account.serverId, accountId: account.accountId, machineId: 'supplier-a' });
        phase = 'unreachable supplier and explicit retry';
        expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', input)).pages[0]?.status)
            .toEqual({ state: 'needs_machine' });
        const retry = await createUiRegistryHostV1(account, port, {}, { explicitRefresh: true });
        transport.unreachableList = true;
        const callsBeforeRetry = transport.calls.length;
        expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await retry.execute('registries.items.list', input)).pages[0]?.status.state).toBe('unreachable');
        expect(transport.calls).toHaveLength(callsBeforeRetry + 1);
        expect(transport.calls.at(-1)?.machineId).toBe('supplier-a');
        transport.unreachableList = false;
        const publicModel = normalizePluginInstalledUiDeclarations({}, undefined, model.installedPackagesById[pluginId], [
            projectPluginRegistrySourceDeclarationV1({ pluginId, pluginVersion: '1.0.0', definition: {
                ...entry.definition, url: 'https://github.com/acme/skills',
            } }),
        ]);
        projected = unionPluginUiProjections([{ machineId: 'supplier-a', serverId: account.serverId, phase: 'retainedOffline',
            interactionEnabled: false, projection: publicModel }]).pluginUiProjection;
        await act(async () => { screen.tree.update(content()); });
        await publishMachineInventoryForTest(account.accountLifetime.scope, []);
        setRuntimeFetch(async (url, init) => String(url) === DEFAULT_CURATED_MARKETPLACE_SOURCE_URL
            ? new Response(null, { status: 503 }) : new URL(String(url)).origin === new URL(homes.homes.home!.serverUrl).origin
            ? homes.fetch(url, init)
            : Response.json(String(url).includes('/commits/') ? { sha: '1'.repeat(40) } : { sha: '2'.repeat(40), tree: [] }));
        const callsBeforeDirect = transport.calls.length;
        phase = 'public Git source without any online supplier';
        expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', input)).pages[0]?.status.state).toBe('ok');
        expect(transport.calls.length).toBe(callsBeforeDirect);
        projected = unionPluginUiProjections([]).pluginUiProjection;
        phase = 'supplier retirement and memo withdrawal';
        await act(async () => { screen.tree.update(content()); });
        expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.sources.list'].parse(await host.execute('registries.sources.list', { kind: 'skill' })).sources.some(source => source.id === entry.id)).toBe(false);
        expect(REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', { kind: 'skill', sourceIds: [entry.id] })).pages).toEqual([]);
        await homes.switchAccount('home', 'another-account');
        phase = 'Account retirement';
        expect(readCurrentAppShellPluginUiProjection({ scope: account, declarationsOnly: true })).toBeNull();
        await expect(host.execute('registries.sources.list', {})).rejects.toThrow();
    } finally {
        transport.unreachableList = false;
        clearMachineRequestReachabilityForTest();
        storage.setState({ machines: previousActiveMachines, machineListByServerId: previousMachines, machineListStatusByServerId: previousStatuses });
        await act(async () => { screen.tree.unmount(); });
    }
});

it('uses the Store Machine choice for search and detail instead of the first live Machine', async () => {
    const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-store-machine.test', {
        key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
    });
    onTestFinished(async () => { await standardCleanup(); await fixture.dispose(); });
    const identity = 'srv_registry_store_machine';
    await setServerProfileIdentityForUrl(fixture.home.serverUrl, identity);
    const account = await captureLazyActionAccountContext(fixture.home.id);
    onTestFinished(() => account.dispose());
    await storage.getState().activateSettingsScope(account.accountLifetime.scope);
    storage.getState().applySettingsForScope(account.accountLifetime.scope, { ...storage.getState().settings,
        machineAdministrationTargetsLocalV1: { 'plugins.home': { serverIdentityId: identity, machineId: 'store-selected' } } }, 1);
    storage.getState().activateProfileScope(account.accountLifetime.scope);
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const inventory = [createMachineFixture({ id: 'first-live', createdAt: 2, activeAt: Date.now() }),
        createMachineFixture({ id: 'store-selected', createdAt: 1, activeAt: Date.now() })];
    await publishMachineInventoryForTest(account.accountLifetime.scope, inventory);
    transport.calls.length = 0;
    const { useRegistryItem } = await import('./useRegistryItem');
    const { useRegistryActionRead } = await import('./useRegistryActionRead');
    const result = await renderHook(() => ({
        search: useRegistryItems({ kind: 'browserExtension', sourceIds: ['builtin:chrome-web-store'], query: 'ublock' }),
        detail: useRegistryItem({ kind: 'browserExtension', sourceId: 'builtin:chrome-web-store', itemId: 'eimadpbcbfnmbkopoojfekhnkhdbieeh' }),
        update: useRegistryActionRead('registries.updates.check', {}, value => value, undefined, false),
    }));
    await waitForHomeGovernance(() => expect(result.getCurrent().search.items.map(item => item.title)).toContain('Dark Reader'));
    await waitForHomeGovernance(() => expect(result.getCurrent().detail.item?.summary.title).toBe('Dark Reader'));
    const calls = transport.calls.filter(call => 'sourceId' in call.payload && call.payload.sourceId === 'builtin:chrome-web-store');
    expect(new Set(calls.map(call => call.payload.op))).toEqual(new Set(['list', 'read']));
    expect(new Set(calls.map(call => call.machineId))).toEqual(new Set(['store-selected']));
    // A catalog choice cannot narrow the existing Account-wide update carrier contract.
    expect(result.getCurrent().update.externalActionTarget).toBeUndefined();
    const beforeInstallRead = transport.calls.length;
    const installRead = await renderHook(() => useRegistryItem({ kind: 'browserExtension', sourceId: 'builtin:chrome-web-store',
        itemId: 'eimadpbcbfnmbkopoojfekhnkhdbieeh' }, true, { installMachineId: 'first-live' }));
    await waitForHomeGovernance(() => expect(installRead.getCurrent().item?.summary.title).toBe('Dark Reader'));
    expect(transport.calls.slice(beforeInstallRead).filter(call => 'sourceId' in call.payload
        && call.payload.sourceId === 'builtin:chrome-web-store').map(call => call.machineId)).toEqual(['first-live']);
});

it('opens a native catalog category with the only online Store Machine and one catalog indicator', async () => {
    const fixture = await createPlainPromptLibraryCatalogHomeFixture('https://registry-store-native-category.test', {
        key: 'registry-sources', value: { v: 2, sources: [], disabledSourceIds: [] },
    }, 'updated', { handleExternalRequest: async () => new Response(null, { status: 503 }) });
    const restorePopoverGlobals = withPopoverWebGlobals();
    onTestFinished(async () => { await standardCleanup(); restorePopoverGlobals(); await fixture.dispose(); });
    await setServerProfileIdentityForUrl(fixture.home.serverUrl, 'srv_registry_native_category');
    const account = await captureLazyActionAccountContext(fixture.home.id);
    onTestFinished(() => account.dispose());
    await storage.getState().activateSettingsScope(account.accountLifetime.scope);
    storage.getState().applySettingsForScope(account.accountLifetime.scope, { ...storage.getState().settings,
        machineAdministrationTargetsLocalV1: {} }, 1);
    storage.getState().activateProfileScope(account.accountLifetime.scope);
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const machine = createMachineFixture({ id: 'category-machine', activeAt: Date.now(), presenceProtocolVersion: 1 });
    transport.calls.length = 0;
    const alternative = createMachineFixture({ id: 'another-category-machine', activeAt: Date.now(), presenceProtocolVersion: 1 });
    await publishMachineInventoryForTest(account.accountLifetime.scope, [machine, alternative]);
    const { Directory } = await import('@/components/store/StoreKindPage');
    const { StoreScreen } = await import('@/components/store/StoreScreen');
    const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const navigate = vi.fn();
    const navigation = { push: navigate, pushRetainingCurrent: navigate, replace: () => {}, back: () => {}, setParams: () => {} };
    const kindPage = await renderScreen(<DestinationInstanceHost tabId="native-category" ref={{ kind: 'plugins',
        params: { view: 'kind', kind: 'browserExtension', browserProfile: 'selected-profile' } }} pathname="/plugins" focused visible navigation={navigation}>
        <AppPaneProvider><StoreScreen /></AppPaneProvider>
    </DestinationInstanceHost>);
    const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
    const { MachineAdministrationTargetSelector } = await import('@/components/settings/machines/MachineAdministrationTargetSelector');
    const unavailable = kindPage.findAllByType(SurfaceStateCard).find(node => node.props.diagnosticCode === 'needs_machine');
    expect(unavailable).toBeTruthy();
    expect(transport.calls.filter(call => 'sourceId' in call.payload && call.payload.sourceId === 'builtin:chrome-web-store')).toEqual([]);
    await act(async () => { unavailable!.props.action.onPress(); });
    expect(kindPage.findAllByType(MachineAdministrationTargetSelector)[0]!.props.chipOpen).toBe(true);
    await act(async () => { await publishMachineInventoryForTest(account.accountLifetime.scope, [machine]); });
    await waitForHomeGovernance(() => {
        const directory = kindPage.findAllByType(Directory).find(node => node.props.kind === 'browserExtension');
        const group = directory?.props.groups.find((group: DirectoryGroup) => group.category?.categoryId === 'featured');
        expect(group?.category).toEqual({ categoryId: 'featured', catalogSourceId: 'builtin:chrome-web-store', total: 1 });
        expect(directory?.props.groupAction?.(group?.key)).toMatchObject({ kind: 'link', onPress: expect.any(Function) });
    });
    const directory = kindPage.findAllByType(Directory).find(node => node.props.kind === 'browserExtension')!;
    const group = directory.props.groups.find((group: DirectoryGroup) => group.category?.categoryId === 'featured')!;
    await act(async () => { directory.props.groupAction(group.key).onPress(); });
    const destination = new URL(navigate.mock.calls.at(-1)![0], 'https://app.test');
    expect(destination.searchParams.get('category')).toBe('featured');
    expect(destination.searchParams.get('catalogSource')).toBe('builtin:chrome-web-store');
    expect(destination.searchParams.get('browserProfile')).toBe('selected-profile');
    expect(JSON.parse(destination.searchParams.get('machine')!)).toEqual({ serverId: 'srv_registry_native_category', machineId: 'category-machine' });
    await kindPage.unmount();
    const { CollectionConditionTokens } = await import('@/components/ui/lists/collection/CollectionConditionTokens');
    const filteredPage = await renderScreen(<DestinationInstanceHost tabId="native-category-filter" ref={{ kind: 'plugins',
        params: { view: 'kind', kind: 'browserExtension', filters: JSON.stringify({ source: { include: ['builtin:chrome-web-store'], exclude: [] } }) } }}
        pathname="/plugins" focused visible navigation={navigation}>
        <AppPaneProvider><StoreScreen /></AppPaneProvider>
    </DestinationInstanceHost>);
    await waitForHomeGovernance(() => expect(filteredPage.findAllByType(Directory).flatMap(node => node.props.rows).map(row => row.title)).toContain('Dark Reader'));
    expect(filteredPage.findAllByType(CollectionConditionTokens).flatMap(node => node.props.tokens)).toEqual([]);
    await filteredPage.unmount();
    const { StoreCategoryPage } = await import('@/components/store/discover/StoreDiscoverPages');
    const { StoreDirectory } = await import('@/components/store/discover/StoreDirectorySection');
    const screen = await renderScreen(<AppPaneProvider><StoreCategoryPage categoryId="featured" catalogSourceId="builtin:chrome-web-store" /></AppPaneProvider>);
    await waitForHomeGovernance(() => expect(screen.findAllByType(StoreDirectory).flatMap(node => node.props.sections as readonly StoreDirectorySectionInput[])
        .flatMap(section => section.items).map(item => item.title)).toEqual(['Dark Reader']));
});
