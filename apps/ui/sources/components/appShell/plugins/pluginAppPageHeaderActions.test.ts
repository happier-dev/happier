import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { flattenTestStyle } from '@/dev/testkit';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

import type {
    PluginUiPageHeaderActionProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { PluginSurfaceLaunchAuthority } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';

import type { PluginAppPage } from './pluginAppPages';
import {
    dispatchPluginAppPageHeaderAction,
    PluginAppPageHeaderActions,
} from './pluginAppPageHeaderActions';

function page(): PluginAppPage {
    // The dispatcher needs only the catalog-issued page identity. This narrow
    // fixture deliberately does not recreate the surface-placement model.
    return {
        id: 'plugin:acme.notes:notes',
        pluginId: 'acme.notes',
    } as unknown as PluginAppPage;
}

function actionAuthority(generation: number): PluginSurfaceLaunchAuthority {
    return {
        machineId: 'machine-1',
        serverId: 'server-a',
        generation,
        accountLifetime: null,
        executionOrigin: null,
    };
}

describe('dispatchPluginAppPageHeaderAction', () => {
    it('uses the canonical Android 48dp physical target for page-header controls', async () => {
        const { Platform } = await import('react-native');
        const previousPlatform = Platform.OS;
        (Platform as { OS: string }).OS = 'android';
        try {
            let tree!: renderer.ReactTestRenderer;
            await act(async () => {
                tree = renderer.create(React.createElement(PluginAppPageHeaderActions, {
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
            const expectedTarget = resolveMinimumInteractiveTargetSize('android');
            expect(style.width).toBe(expectedTarget);
            expect(style.height).toBe(expectedTarget);
        } finally {
            (Platform as { OS: string }).OS = previousPlatform;
        }
    });

    it('delegates the compiled qualified openSurface command exactly once to the mounted app-page handler', async () => {
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

        await expect(dispatchPluginAppPageHeaderAction({
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

    it('routes executeAction through the canonical generation-leased dispatcher with the absent-input sentinel', async () => {
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

        await expect(dispatchPluginAppPageHeaderAction({
            action,
            page: page(),
            actionAuthority: actionAuthority(7),
            openSurface: vi.fn(),
            execute,
        })).resolves.toEqual({ ok: true, result: { refreshed: true } });

        expect(execute).toHaveBeenCalledWith('machine-1', {
            serverId: 'server-a',
            expectedGeneration: '7',
            qualifiedActionId: 'acme.notes/refresh-index',
            input: null,
            executionSurface: 'ui',
        });
    });

    it('fails closed without dispatch when the page-header invocation is no longer current', async () => {
        const execute = vi.fn(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { refreshed: true } },
        }));

        await expect(dispatchPluginAppPageHeaderAction({
            action: {
                id: 'refresh',
                title: 'Refresh',
                command: {
                    kind: 'executeAction',
                    action: { pluginId: 'acme.notes', localId: 'refresh-index' },
                },
            },
            page: page(),
            actionAuthority: actionAuthority(7),
            openSurface: vi.fn(),
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

        await expect(dispatchPluginAppPageHeaderAction({
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
            execute,
        })).resolves.toEqual({
            ok: false,
            code: 'unavailable',
            reason: 'plugin_ui_action_unavailable',
        });

        expect(execute).not.toHaveBeenCalled();
    });
});
