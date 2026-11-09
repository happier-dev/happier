// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { createPluginClientTestkit, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { PLUGIN_MANIFEST } from '@happier-dev/plugins-triage/manifest';
import { activate } from '@happier-dev/plugins-triage/happier-plugin-ui/triage-mounted-ui-action-native';
import { renderSurface } from '@happier-dev/plugins-triage/happier-plugin-ui/triage-list-page-native';

import { createTestkitAccountKv } from '../../../../../../packages/plugins/triage/src/settings/testkit/accountKv.test-support';
import { createTestkitCorpusCollections } from '../../../../../../packages/plugins/triage/src/corpus/testkit/corpusCollections.test-support';
import { TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1 } from '../../../../../../packages/plugins/triage/src/settings/savedViews';
import { readTriageSavedViewsForSurface, administerTriageSavedView } from '../../../../../../packages/plugins/triage/src/actions/savedViews';
import { TriageReadSavedViewsInputV1Schema, TriageAdministerSavedViewInputV1Schema } from '../../../../../../packages/plugins/triage/src/actions/savedViewsProtocol';
import { readTriageActionsForSurface } from '../../../../../../packages/plugins/triage/src/actions/actionsCatalog';
import { TriageReadActionsInputV1Schema } from '../../../../../../packages/plugins/triage/src/actions/actionsCatalogProtocol';
import { TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 } from '../../../../../../packages/plugins/triage/src/settings/actions';
import { listTriageEntries } from '../../../../../../packages/plugins/triage/src/actions/listEntries';
import { TriageListEntriesInputV1Schema } from '../../../../../../packages/plugins/triage/src/actions/listEntriesProtocol';
import { listTriagePinnedEntries } from '../../../../../../packages/plugins/triage/src/actions/userMarks';
import { TriageListPinnedEntriesInputV1Schema } from '../../../../../../packages/plugins/triage/src/actions/userMarksProtocol';
import { TriageMountedUiInputV1Schema } from '../../../../../../packages/plugins/triage/src/actions/mountedUiProtocol';
import { toolbarMenuItem } from '../../../../../../packages/plugins/triage/src/ui/shell/toolbarMenus.test-support';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getPluginUiEphemeralSharedScope } from './pluginUiEphemeralSharedScope';

// This DOM composition needs the shipped RNW platform, rather than the UI
// package's default native test-renderer boundary.
vi.mock('react-native', () => import('react-native-web'));

it('applies UI and agent saved-view selections across distinct mounted and client Artifacts without catalog writes', async () => {
    const retirement = new AbortController();
    const accountLifetime: ActiveServerAccountScopeLifetime = {
        scope: { serverId: 'fx80-home', accountId: 'fx80-account' },
        isCurrent: () => !retirement.signal.aborted,
        onRetire: listener => {
            retirement.signal.addEventListener('abort', listener);
            return { dispose: () => retirement.signal.removeEventListener('abort', listener) };
        },
    };
    // Loaded r78: the Account renderer and Machine client registration have
    // distinct occurrence ids, but the same admitted package generation.
    const identity = { accountLifetime, pluginId: PLUGIN_MANIFEST.id,
        pluginGenerationId: '["@happier-dev/plugins-triage","happier.triage","0.0.0"]',
        executionOrigin: { serverIdentityId: 'fx80-server', materializationRef: {
            pluginId: PLUGIN_MANIFEST.id, machineId: 'fx80-machine', materializationId: 'triage-install',
        } }, isCurrent: accountLifetime.isCurrent };
    const pageScope = getPluginUiEphemeralSharedScope({ ...identity, occurrenceId: identity.pluginGenerationId,
        artifactDigest: `sha256:${'a'.repeat(64)}` });
    const accountKv = createTestkitAccountKv();
    const { collections } = createTestkitCorpusCollections();
    const viewId = '0000000a-0000-4000-8000-00000000000a';
    accountKv.seed(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1, { v: 1, views: [{ viewId, label: 'Review queue', query: 'normalizer',
        filters: { sources: [], types: [], scopes: [], states: ['done'], attention: [] }, order: 'smart',
        smartPolicy: { v: 1, precedence: ['activity', 'attention'] } }] });
    const viewDeps = { catalog: accountKv.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1),
        mintViewId: () => '0000000b-0000-4000-8000-00000000000b' };
    const declaration = PLUGIN_MANIFEST.contributes.actions.find(action => action.id === 'ui/mounted-v1');
    if (declaration?.execution.target !== 'client') throw new Error('Missing mounted Action');
    const client = await createPluginClientTestkit({ manifest: PLUGIN_MANIFEST,
        target: { ...declaration.execution.client, platform: 'web' }, activate });
    const handler = client.registration('actions', declaration.id);
    if (!handler) throw new Error('Missing mounted registration');
    let mountId: string | undefined;
    const locations: string[] = [];
    let shell: Awaited<ReturnType<typeof createPluginUiTestkit>> | undefined;
    const invoke = async (input: unknown, invocationSurface: 'ui' | 'agent') => {
        const parsed = TriageMountedUiInputV1Schema.parse(input);
        mountId = parsed.mountId;
        if (!shell) throw new Error('Missing mounted page');
        return await handler(parsed, {
            plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
            contribution: { id: declaration.id, qualifiedId: `${PLUGIN_MANIFEST.id}/actions/${declaration.id}` },
            signal: new AbortController().signal, invocationSurface, ui: shell.context.hostApi,
            ephemeralSharedScope: getPluginUiEphemeralSharedScope({ ...identity, occurrenceId: 'happier.triage:64',
                artifactDigest: `sha256:${'b'.repeat(64)}` }),
        });
    };
    try {
        await act(async () => {
            shell = await createPluginUiTestkit({ identity: { instanceId: 'fx80-page', mountNonce: 'page' },
                authorPlugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version }, surface: renderSurface,
                surfaceContext: createSurfaceContextFixture(),
                adapter: createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: pageScope!, overlays: true }),
                handlers: {
                    publishCurrentUiContext: () => undefined,
                    replacePageLocation: ({ subPath }) => { locations.push(subPath); return subPath; },
                    // Substitute only the remote Account/daemon boundary; all catalog and mounted logic is real.
                    executeAction: async ({ action, input }) => {
                        if (action === 'ui/mounted-v1') return await invoke(input, 'ui');
                        if (action === 'views/read-v1') return await readTriageSavedViewsForSurface(TriageReadSavedViewsInputV1Schema.parse(input), viewDeps);
                        if (action === 'views/administer-v1') return await administerTriageSavedView(TriageAdministerSavedViewInputV1Schema.parse(input), viewDeps);
                        if (action === 'actions/read-v1') return await readTriageActionsForSurface(TriageReadActionsInputV1Schema.parse(input), {
                            catalog: accountKv.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1),
                        });
                        if (action === 'marks/list-pinned-v1') return await listTriagePinnedEntries(TriageListPinnedEntriesInputV1Schema.parse(input), { collections });
                        if (action === 'entries/list-v1') return await listTriageEntries(TriageListEntriesInputV1Schema.parse(input), {
                            sourceInstances: collections.sourceInstances, readAdmittedSources: async () => [],
                            executeScan: async () => { throw new Error('No configured source'); },
                        });
                        throw new Error(`Unexpected remote Action ${String(action)}`);
                    },
                } });
        });
        const page = shell!;
        await act(async () => { await page.press(await toolbarMenuItem(page, 'Views', 'menuitemradio', { name: 'Review queue' })); });
        expect((await page.getByRole('textbox')).value).toBe('normalizer');
        expect(locations.at(-1)).toContain(`sv,${viewId}`);
        await act(async () => { expect(await invoke({ mountId, operation: { kind: 'selectSavedView', viewId: null } }, 'agent')).toEqual({ status: 'applied' }); });
        await expect(toolbarMenuItem(page, 'Views', 'menuitemradio', { name: 'No saved view', state: { checked: true } })).resolves.toBeTruthy();
        await act(async () => { expect(await invoke({ mountId, operation: { kind: 'selectSavedView', viewId } }, 'agent')).toEqual({ status: 'applied' }); });
        expect((await page.getByRole('textbox')).value).toBe('normalizer');
        await act(async () => { expect(await invoke({ mountId, operation: { kind: 'setLens', query: 'changed lens',
            filters: { sources: [], types: [], scopes: [], states: [], attention: [] }, order: 'smart' } }, 'agent')).toEqual({ status: 'applied' }); });
        expect((await page.getByRole('textbox')).value).toBe('changed lens');
        expect(accountKv.setCallCount()).toBe(0);
        await act(async () => { await page.dispose(); });
        expect(await invoke({ mountId, operation: { kind: 'selectSavedView', viewId: null } }, 'agent')).toEqual({ status: 'unavailable' });
    } finally {
        await act(async () => { await shell?.dispose(); });
        await client.dispose();
        retirement.abort();
    }
});
