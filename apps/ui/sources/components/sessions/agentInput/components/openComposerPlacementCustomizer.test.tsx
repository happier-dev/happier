import * as React from 'react';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { PluginProjectedActionV2Schema, PluginProjectedComposerControlEntryV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { activateStorageAccountScope } from '@/dev/testkit/runtime/storageRuntime';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import {
    AppShellPluginUiProjectionValueProvider,
    type AppShellPluginUiProjectionValue,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import type { NavigationPlacementItem } from '@/components/ui/navigation/NavigationPlacementCustomizer';
import type { IModal } from '@/modal';

import { openComposerPlacementCustomizer } from './openComposerPlacementCustomizer';
import type { ComposerPlacementPreview } from './ComposerPlacementPreview';
import type { NavigationPlacementPreferences } from '@/sync/domains/settings/mobileSurfacePinning';
import type { AgentInputPlacementContext, AgentInputPlacementDescriptor } from '../controls/agentInputControlTypes';
import { buildAgentInputPlacementDescriptors } from '../controls/buildAgentInputPlacementDescriptors';

const show = vi.hoisted(() => vi.fn<IModal['show']>(() => 'composer-customizer'));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { show } }).module);

afterEach(() => { standardCleanup(); show.mockClear(); });

describe('openComposerPlacementCustomizer installed metadata', () => {
    it('uses the admitted Account declaration catalog without a composer and excludes it after its Account retires', async () => {
        const scope = { serverId: 'srv_composer_catalog', accountId: 'composer-catalog-account' };
        const account = await activateStorageAccountScope(scope);
        onTestFinished(() => account.dispose());
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected the canonical active Account fixture');
        const qualifiedId = 'acme.compose/mode';
        const projection = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            actionsById: {
                [qualifiedId]: PluginProjectedActionV2Schema.parse({
                    id: 'mode', pluginId: 'acme.compose', occurrenceId: 'compose-generation-1',
                    title: 'Compose mode action', scopes: ['session'], surfaces: ['ui'],
                    execution: { target: 'daemon' }, dangerLevel: 'safe', available: false,
                    placementBindings: ['composer.primary', 'composer.more'],
                }),
            },
            composerControlsById: {
                [qualifiedId]: PluginProjectedComposerControlEntryV1Schema.parse({
                    id: qualifiedId, pluginId: 'acme.compose', identity: { pluginId: 'acme.compose', localId: 'mode' },
                    occurrenceId: 'compose-generation-1',
                    definition: {
                        id: 'mode', label: 'Compose mode control', icon: 'add', scopes: ['newSession'],
                        state: { resource: 'mode-state' }, interaction: { kind: 'action', action: 'refresh' },
                    },
                }),
            },
        };
        const value: AppShellPluginUiProjectionValue = {
            pluginUiProjection: projection, pluginBrowserProjection: null,
            phase: 'current', interactionEnabled: false, machineId: null, serverId: scope.serverId,
            platform: 'web', accountLifetime: lifetime,
            reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' },
            reloadClientExecutables: () => {},
        };
        // The real shell provider publishes the existing committed reader and Account fence.
        const screen = await renderScreen(<AppShellPluginUiProjectionValueProvider value={value}>{null}</AppShellPluginUiProjectionValueProvider>);
        onTestFinished(() => screen.unmount());
        expect(readCurrentAppShellPluginUiProjection({ scope, declarationsOnly: true })).toBe(projection);

        const openItems = async (context?: AgentInputPlacementContext, descriptors?: readonly AgentInputPlacementDescriptor[]): Promise<readonly NavigationPlacementItem[]> => {
            const calls = show.mock.calls.length;
            // Await the real presentation boundary under the enclosing test's lifecycle budget;
            // vi.waitFor's short polling deadline also timed the unrelated cold lazy-import graph.
            const shown = new Promise<Parameters<IModal['show']>[0]>((resolve) => {
                show.mockImplementationOnce(configuration => {
                    resolve(configuration);
                    return 'composer-customizer';
                });
            });
            openComposerPlacementCustomizer({ context, descriptors });
            const configuration = await shown;
            expect(show.mock.calls.length).toBe(calls + 1);
            const props = configuration?.props as Readonly<{ items: readonly NavigationPlacementItem[] }> | undefined;
            if (!props) throw new Error('Expected the customization presentation');
            return props.items;
        };
        const pluginItems = (items: readonly NavigationPlacementItem[]) => items.filter(item => item.id.startsWith('plugin:'));
        const items = await openItems();
        expect(new Set(items.map(item => item.id)).size).toBe(items.length);
        expect(items.find(item => item.id === 'shortcuts:workflow-step-options')?.group).toBeTruthy();
        const groupOrder = [...new Set(items.map(item => item.group))];
        expect(groupOrder).toHaveLength(4);
        const configuration = show.mock.calls.at(-1)?.[0];
        const previewProps = configuration?.props as Readonly<{
            renderPreview: (preferences: NavigationPlacementPreferences) => React.ReactElement<React.ComponentProps<typeof ComposerPlacementPreview>>;
        }>;
        expect(previewProps.renderPreview({ orderedIds: [], placements: {} }).props.descriptors.map(control => control.id))
            .not.toContain('shortcuts:workflow-step-options');
        expect(pluginItems(items)).toEqual([
            expect.objectContaining({ id: `plugin:action:${qualifiedId}`, title: 'Compose mode action', defaultPlacement: 'pinned' }),
            expect.objectContaining({ id: `plugin:control:${qualifiedId}`, title: 'Compose mode control', defaultPlacement: 'overflow' }),
        ]);
        expect(items.find(item => item.id === 'providerOption:auggie-allow-indexing')).toMatchObject({ defaultPlacement: 'overflow' });
        for (const [context, includedId, excludedId] of [
            ['newSession', 'automation:new-session-triggers', 'shortcuts:workflow-step-options'],
            ['workflow', 'shortcuts:workflow-step-options', 'shortcuts:mention'],
            ['discussion', 'shortcuts:mention', 'shortcuts:workflow-step-options'],
        ] as const) {
            const contextItems = await openItems(context);
            expect(new Set(contextItems.map(item => item.id)).size).toBe(contextItems.length);
            const props = show.mock.calls.at(-1)?.[0]?.props as typeof previewProps & Readonly<{ activeGroup: string }>;
            // The same grouped catalog in the same order from every opener; the opener's own context is where it opens.
            expect([...new Set(contextItems.map(item => item.group))]).toEqual(groupOrder);
            expect(groupOrder[['newSession', 'workflow', 'discussion'].indexOf(context) + 1]).toBe(props.activeGroup);
            const previewIds = props.renderPreview({ orderedIds: [], placements: {} }).props.descriptors.map(control => control.id);
            expect(previewIds).toContain(includedId);
            expect(previewIds).not.toContain(excludedId);
        }
        // Settings still configures the complete catalog, but a live + opener must preview
        // only the controls that its real capability inventory can actually render.
        const liveDescriptors = buildAgentInputPlacementDescriptors({ coreControls: [{ id: 'engine' }], phone: true });
        const liveItems = await openItems('session', liveDescriptors);
        expect(liveItems.some(item => item.id === 'machine')).toBe(true);
        const liveProps = show.mock.calls.at(-1)?.[0]?.props as typeof previewProps;
        expect(liveProps.renderPreview({ orderedIds: [], placements: {} }).props.descriptors).toBe(liveDescriptors);
        await openItems('session', []);
        const emptyProps = show.mock.calls.at(-1)?.[0]?.props as typeof previewProps;
        expect(emptyProps.renderPreview({ orderedIds: [], placements: {} }).props.descriptors).toEqual([]);
        retireActiveServerAccountScopeLifetime();
        expect(readCurrentAppShellPluginUiProjection({ scope, declarationsOnly: true })).toBeNull();
        expect(pluginItems(await openItems())).toEqual([]);
    });
});
