import { describe, expect, it } from 'vitest';
import { PluginProjectedActionV2Schema, PluginProjectedComposerControlEntryV1Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

import { buildPluginComposerPlacementDefinitions } from './pluginComposerPlacement';

describe('plugin Composer placement metadata', () => {
    it('localizes admitted declarations without reading Resource metadata or treating an unavailable Action as absent', () => {
        const qualifiedId = 'acme.compose/mode';
        const projection: PluginUiProjectionModel = {
            ...EMPTY_PLUGIN_UI_PROJECTION,
            translationsByPluginId: {
                'acme.compose': {
                    id: 'translations:acme.compose', pluginId: 'acme.compose', contributionKind: 'translations',
                    locales: ['en', 'fr'], bundles: { fr: { modeAction: 'Action du mode', modeControl: 'Mode de composition' } },
                },
            },
            actionsById: {
                [qualifiedId]: PluginProjectedActionV2Schema.parse({
                    id: 'mode', pluginId: 'acme.compose', occurrenceId: 'compose-generation-1',
                    title: { key: 'modeAction', fallback: 'Mode Action' }, scopes: ['session'], surfaces: ['ui'],
                    execution: { target: 'daemon' }, dangerLevel: 'safe', available: false,
                    placementBindings: ['composer.primary', 'composer.more'],
                }),
            },
            composerControlsById: {
                [qualifiedId]: PluginProjectedComposerControlEntryV1Schema.parse({
                    id: qualifiedId, pluginId: 'acme.compose', identity: { pluginId: 'acme.compose', localId: 'mode' },
                    occurrenceId: 'compose-generation-1',
                    definition: {
                        id: 'mode', label: { key: 'modeControl', fallback: 'Composer mode' }, icon: 'add',
                        defaultPlacement: 'pinned', scopes: ['newSession'], state: { resource: 'mode-state' },
                        interaction: { kind: 'action', action: 'refresh' },
                    },
                }),
            },
            get resourcesById(): PluginUiProjectionModel['resourcesById'] { throw new Error('Static composer placement must not read Resources'); },
        };
        expect(buildPluginComposerPlacementDefinitions(projection, { locale: 'fr' })).toEqual([
            {
                controlId: `plugin:action:${qualifiedId}`,
                contexts: ['session'],
                placement: { id: `plugin:action:${qualifiedId}`, title: 'Action du mode', icon: 'puzzle-piece', defaultPlacement: 'pinned' },
            },
            {
                controlId: `plugin:control:${qualifiedId}`,
                contexts: ['newSession'],
                placement: { id: `plugin:control:${qualifiedId}`, title: 'Mode de composition', icon: 'plus', defaultPlacement: 'pinned' },
            },
        ]);
    });

    it('projects declared scope restrictions without making global Actions or unrelated control scopes available in every context', () => {
        const action = (id: string, scopes: readonly ('global' | 'session')[]) => PluginProjectedActionV2Schema.parse({
            id, pluginId: 'acme.compose', occurrenceId: 'compose-generation-1', title: id,
            scopes, surfaces: ['ui'], execution: { target: 'daemon' }, dangerLevel: 'safe',
            placementBindings: ['composer.more'],
        });
        const control = (id: string, scopes?: readonly string[]) => PluginProjectedComposerControlEntryV1Schema.parse({
            id: `acme.compose/${id}`, pluginId: 'acme.compose', identity: { pluginId: 'acme.compose', localId: id },
            occurrenceId: 'compose-generation-1', definition: {
                id, label: id, icon: 'add', ...(scopes ? { scopes } : {}),
                interaction: { kind: 'action', action: 'refresh' },
            },
        });
        const definitions = buildPluginComposerPlacementDefinitions({
            ...EMPTY_PLUGIN_UI_PROJECTION,
            actionsById: {
                'acme.compose/global': action('global', ['global']),
                'acme.compose/session': action('session', ['global', 'session']),
            },
            composerControlsById: Object.fromEntries([
                control('discussion', ['discussion']),
                control('workflow', ['workflowAuthoring']),
                control('session', ['pendingMessage', 'participantMessage', 'session']),
                control('automation', ['automationAuthoring']),
                control('unrestricted'),
            ].map(entry => [entry.id, entry])),
        });
        const contexts = (id: string) => definitions.find(definition => definition.placement.id === id)?.contexts;
        expect(contexts('plugin:action:acme.compose/global')).toEqual([]);
        expect(contexts('plugin:action:acme.compose/session')).toEqual(['session']);
        expect(contexts('plugin:control:acme.compose/discussion')).toEqual(['discussion']);
        expect(contexts('plugin:control:acme.compose/workflow')).toEqual(['workflow']);
        expect(contexts('plugin:control:acme.compose/session')).toEqual(['session']);
        expect(contexts('plugin:control:acme.compose/automation')).toEqual([]);
        expect(contexts('plugin:control:acme.compose/unrestricted')).toBeUndefined();
    });
});
