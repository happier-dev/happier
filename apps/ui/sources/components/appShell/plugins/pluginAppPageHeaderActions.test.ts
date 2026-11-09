import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { flattenTestStyle } from '@/dev/testkit';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import type {
    PluginProjectedActionV2,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import {
    createPluginUiProjectedActionResolver,
    type PluginUiPageHeaderActionProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { PluginSurfaceLaunchAuthority } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import type { PluginUiAccountExecutableOrigin } from '@/sync/domains/plugins/ui/projectionOrigins';

import type { PluginPage } from '@/components/plugins/pages/pluginPages';
import {
    dispatchPluginPageHeaderAction,
    PluginPageHeaderActions,
} from '@/components/plugins/pages/pluginPageHeaderActions';
import { createPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import { getInstalledPluginUiClientExecutableComposition } from '@/components/plugins/reactNative/clientExecutableContributions';
import { createPluginUiCommonJsLoaderBackend } from '@/components/plugins/reactNative/commonJsLoaderBackend';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';

function page(): PluginPage {
    // The dispatcher needs only the catalog-issued page identity. This narrow
    // fixture deliberately does not recreate the surface-placement model.
    return {
        id: 'plugin:acme.notes:notes',
        pluginId: 'acme.notes',
    } as unknown as PluginPage;
}

const NOTES_OCCURRENCE_ID = 'acme.notes-occurrence-current';

function actionAuthority(): PluginSurfaceLaunchAuthority {
    return {
        machineId: 'machine-1',
        serverId: 'server-a',
        occurrenceId: NOTES_OCCURRENCE_ID,
        accountLifetime: null,
        executionOrigin: null,
    };
}

function projectedAction(
    execution: PluginProjectedActionV2['execution'],
    available = true,
): PluginProjectedActionV2 {
    return {
        id: 'refresh-index',
        pluginId: 'acme.notes',
        occurrenceId: NOTES_OCCURRENCE_ID,
        title: 'Refresh index',
        scopes: ['session'],
        surfaces: ['ui'],
        execution,
        dangerLevel: 'safe',
        available,
    };
}

// Projected registry DTOs are fixtures; reference resolution remains the real owner.
const resolveClientTargetAction = createPluginUiProjectedActionResolver({
    'acme.notes/refresh-index': projectedAction({
        target: 'client',
        client: { artifactId: 'client-action-bundle', exportName: 'execute' },
        platforms: ['web'],
    }),
});
const resolveDaemonTargetAction = createPluginUiProjectedActionResolver({
    'acme.notes/refresh-index': projectedAction({ target: 'daemon' }),
});
const resolveUnavailableDaemonTargetAction = createPluginUiProjectedActionResolver({
    'acme.notes/refresh-index': projectedAction({ target: 'daemon' }, false),
});

describe('dispatchPluginPageHeaderAction', () => {
    it('enables a committed Account Action in the page header without Machine authority', async () => {
        const pluginId = 'acme.notes';
        const target = { realm: 'account' as const, artifactId: 'account-header', exportName: 'activate', platform: 'web' as const };
        const authority = { kind: 'account' as const, serverId: 'home', accountId: 'account', custodyId: 'header-custody' };
        // Match the Account bundled-selection producer's admitted source custody.
        const hostAccountOrigin = { ...authority, sourceCustody: { kind: 'bundled_first_party',
            packagedRuntime: { kind: 'source_declaration', packageName: '@acme/notes' } } } satisfies PluginUiAccountExecutableOrigin;
        const action = { ...projectedAction({ target: 'account', account: { artifactId: target.artifactId, exportName: target.exportName } }), occurrenceId: authority.custodyId,
            hostAccountOrigin,
            authorization: { generation: { targetGeneration: authority.custodyId, desiredGeneration: authority.custodyId,
                appliedGeneration: authority.custodyId }, resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [] } };
        const identity = { pluginId, contributionId: 'refresh-index', artifactId: target.artifactId, platform: target.platform,
            artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const };
        const cache = createPluginReactNativeBundleCache();
        cache.putInstalledArtifact({ identity, format: 'plainJs', bytes: new TextEncoder().encode(
            "exports.activate = function(api) { api.actions.register('refresh-index', async function() { return null; }); };",
        ) });
        const composition = getInstalledPluginUiClientExecutableComposition();
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            expect(await composition.reconcile([{ pluginId, contributes: { actions: [action] }, target, executionOrigin: null,
                occurrenceId: authority.custodyId, pluginVersion: '1.0.0', hostUiApiRange: '^1.0.0', authority,
                cache, identity, moduleReference: { exportName: target.exportName }, backend: createPluginUiCommonJsLoaderBackend(),
                isCurrent: () => true }])).toMatchObject([{ result: { ok: true } }]);
            await act(async () => {
                tree = renderer.create(React.createElement(PluginPageHeaderActions, {
                    actions: [{ id: 'account-refresh', title: 'Refresh', command: { kind: 'executeAction',
                        action: { pluginId, localId: action.id } } }], page: page(),
                    projection: { ...EMPTY_PLUGIN_UI_PROJECTION, actionsById: { [`${pluginId}/${action.id}`]: action } },
                    actionAuthority: null, openSurface: vi.fn(),
                }));
            });
            expect(tree!.root.findByProps({ testID: 'plugin-app-page-header-action:account-refresh' }).props.disabled).toBe(false);
        } finally {
            await act(async () => { tree?.unmount(); });
            await composition.unload();
        }
    });
    it('withdraws daemon execution independently of still-current page navigation', async () => {
        const execute = vi.fn(async () => ({ supported: true as const, result: { ok: true as const, result: {} } }));
        const openSurface = vi.fn(async () => ({ ok: true as const }));
        const shared = { page: page(), actionAuthority: actionAuthority(), openSurface,
            resolveContributedAction: resolveDaemonTargetAction, execute, isCurrent: () => true,
            isDaemonExecutionCurrent: () => false };
        await expect(dispatchPluginPageHeaderAction({ ...shared, action: { id: 'refresh', title: 'Refresh',
            command: { kind: 'executeAction', action: { pluginId: 'acme.notes', localId: 'refresh-index' } } } }))
            .resolves.toMatchObject({ ok: false, code: 'unavailable' });
        expect(execute).not.toHaveBeenCalled();
        await dispatchPluginPageHeaderAction({ ...shared, action: { id: 'details', title: 'Details',
            command: { kind: 'openSurface', destination: { pluginId: 'acme.notes', localId: 'details' } } } });
        expect(openSurface).toHaveBeenCalled();
    });

    it('does not require daemon authority or call the daemon for a client-target Action', async () => {
        const execute = vi.fn();

        await expect(dispatchPluginPageHeaderAction({
            action: {
                id: 'refresh',
                title: 'Refresh',
                command: {
                    kind: 'executeAction',
                    action: { pluginId: 'acme.notes', localId: 'refresh-index' },
                },
            },
            page: page(),
            actionAuthority: null,
            openSurface: vi.fn(),
            resolveContributedAction: resolveClientTargetAction,
            execute,
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_surface_client_action_unavailable',
        });

        expect(execute).not.toHaveBeenCalled();
    });

    it('draws page-header controls at the shared control height and leaves the Android target to the hit area', async () => {
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;
        (Platform as { OS: string }).OS = 'android';
        try {
            let tree!: renderer.ReactTestRenderer;
            await act(async () => {
                tree = renderer.create(React.createElement(PluginPageHeaderActions, {
                    actions: [{
                            id: 'open-details',
                            title: 'Open details',
                            icon: 'action',
                            command: {
                                kind: 'openSurface',
                                destination: { pluginId: 'acme.details', localId: 'panel' },
                            },
                        }],
                    page: page(),
                    projection: null,
                    actionAuthority: null,
                    openSurface: vi.fn(),
                }));
            });

            const control = tree.root.findByProps({ testID: 'plugin-app-page-header-action:open-details' });
            const style = flattenTestStyle(control.props.style({ pressed: false }));
            expect(style.width).toBe(HAPPIER_PAGE_METRICS.controlHeightPx);
            expect(style.height).toBe(HAPPIER_PAGE_METRICS.controlHeightPx);
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });

    it('delegates the compiled qualified openSurface action exactly once to the mounted app-page handler', async () => {
        const action: PluginUiPageHeaderActionProjection = {
            id: 'open-details',
            title: 'Open details',
            command: {
                kind: 'openSurface',
                destination: { pluginId: 'acme.details', localId: 'panel' },
                input: { source: 'page-header' },
                subPath: 'recent',
                instanceKey: 'current',
            },
        };
        const openSurface = vi.fn(async () => ({ ok: true as const }));

        await expect(dispatchPluginPageHeaderAction({
            action,
            page: page(),
            actionAuthority: null,
            openSurface,
        })).resolves.toEqual({ ok: true });

        expect(openSurface).toHaveBeenCalledWith({
            destination: { pluginId: 'acme.details', localId: 'panel' },
            input: { source: 'page-header' },
            subPath: 'recent',
            instanceKey: 'current',
        });
    });

    it('routes executeAction through the exact contributor occurrence with input absent', async () => {
        const action: PluginUiPageHeaderActionProjection = {
            id: 'refresh',
            title: 'Refresh',
            command: {
                kind: 'executeAction',
                action: { pluginId: 'acme.notes', localId: 'refresh-index' },
            },
        };
        const execute = vi.fn(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { refreshed: true } },
        }));

        await expect(dispatchPluginPageHeaderAction({
            action,
            page: page(),
            actionAuthority: actionAuthority(),
            openSurface: vi.fn(),
            resolveContributedAction: resolveDaemonTargetAction,
            execute,
        })).resolves.toEqual({ ok: true, result: { refreshed: true } });

        expect(execute).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-a',
            expectedContributorOccurrenceId: NOTES_OCCURRENCE_ID,
            qualifiedActionId: 'acme.notes/refresh-index',
            executionSurface: 'ui',
        }));
    });

    it('refuses a terminally unavailable projected Action before app-page header dispatch', async () => {
        const execute = vi.fn();

        await expect(dispatchPluginPageHeaderAction({
            action: {
                id: 'refresh',
                title: 'Refresh',
                command: {
                    kind: 'executeAction',
                    action: { pluginId: 'acme.notes', localId: 'refresh-index' },
                },
            },
            page: page(),
            actionAuthority: actionAuthority(),
            openSurface: vi.fn(),
            resolveContributedAction: resolveUnavailableDaemonTargetAction,
            execute,
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_ui_action_unavailable',
        });
        expect(execute).not.toHaveBeenCalled();
    });

    it('fails closed without dispatch when the page-header invocation is no longer current', async () => {
        const execute = vi.fn(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { refreshed: true } },
        }));

        await expect(dispatchPluginPageHeaderAction({
            action: {
                id: 'refresh',
                title: 'Refresh',
                command: {
                    kind: 'executeAction',
                    action: { pluginId: 'acme.notes', localId: 'refresh-index' },
                },
            },
            page: page(),
            actionAuthority: actionAuthority(),
            openSurface: vi.fn(),
            resolveContributedAction: resolveDaemonTargetAction,
            execute,
            isCurrent: () => false,
        })).resolves.toEqual({
            ok: false,
            code: 'stale_surface',
            reason: 'plugin_ui_generation_retired',
        });

        expect(execute).not.toHaveBeenCalled();
    });

    it('fails closed before dispatch when the current page has no execution origin', async () => {
        const execute = vi.fn();

        await expect(dispatchPluginPageHeaderAction({
            action: {
                id: 'refresh',
                title: 'Refresh',
                command: {
                    kind: 'executeAction',
                    action: { pluginId: 'acme.notes', localId: 'refresh-index' },
                },
            },
            page: page(),
            actionAuthority: null,
            openSurface: vi.fn(),
            resolveContributedAction: resolveDaemonTargetAction,
            execute,
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_ui_action_unavailable',
        });

        expect(execute).not.toHaveBeenCalled();
    });
});
