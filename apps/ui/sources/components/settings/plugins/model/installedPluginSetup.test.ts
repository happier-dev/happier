import { describe, expect, it } from 'vitest';
import { PluginProjectionV2Schema, projectPluginSettingsContributionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { MachineSetupObservationV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupObservationV1';
import { mcpPluginServerProjectionKeyV1 } from '@happier-dev/protocol/mcp/servers/pluginItemsV1';
import { mcpPluginItemIdV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { PluginSettingsContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/settings';

import { mapV2EditableSettingsGroup } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';

import { projectInstalledPluginSetup } from './installedPluginSetup';

describe('installed plugin setup', () => {
    it('keeps only unmet steps published by the four setup owners', () => {
        const pluginId = 'example.setup';
        const service = { pluginId, localId: 'account' };
        const server = { pluginId, localId: 'remote' };
        const ref = { pluginId, recipeId: 'tools', revision: '1' };
        const projection = PluginProjectionV2Schema.parse({
            v: 2,
            generation: 1,
            agentsById: {
                agent: {
                    id: 'agent',
                    identity: { pluginId, localId: 'agent' },
                    connectedAccounts: [
                        { purpose: 'primary', service, required: true },
                        { purpose: 'duplicate', service, required: true },
                        { purpose: 'optional', service: { pluginId, localId: 'optional' } },
                    ],
                },
            },
            familiesById: {
                mcp: {
                    family: 'mcp',
                    entriesById: {
                        [mcpPluginServerProjectionKeyV1(server)]: {
                            id: 'remote', ...server, contributionKind: 'server', title: 'Remote tools',
                            kind: 'static', transport: { kind: 'http', url: 'https://mcp.example.test/', auth: { kind: 'oauth' } },
                        },
                    },
                },
            },
        });
        const declaration = PluginSettingsContributionV2Schema.parse({
            id: 'settings', title: 'Settings', target: { kind: 'plugin' }, scope: 'account',
            fields: [
                { id: 'workspace', title: 'Workspace', schema: { type: 'string' }, required: true },
                { id: 'token', title: 'Token', schema: { type: 'string' }, secret: true, required: true },
                { id: 'defaulted', title: 'Default', schema: { type: 'string' }, default: 'default', required: true },
                { id: 'optional', title: 'Optional', schema: { type: 'string' } },
            ],
        });
        const projectedSettings = projectPluginSettingsContributionV2({ pluginId, definition: declaration });
        const settings = mapV2EditableSettingsGroup(projectedSettings).fields.map(field => ({
            field,
            status: 'missing' as const,
        }));
        const machineSetup = MachineSetupObservationV1Schema.parse({
            version: 1, desiredRevision: 1, status: 'drifted',
            recipes: [{ ref, status: 'drifted', steps: [] }, {
                ref: { ...ref, pluginId: 'example.other' }, status: 'drifted', steps: [],
            }],
        });
        const input = { pluginId, projection, machineSetup, connections: { groups: [], profiles: [] }, settings };
        expect(projectInstalledPluginSetup(input)).toEqual([
            { kind: 'connectedAccount', service },
            { kind: 'mcpSignIn', serverId: mcpPluginItemIdV1(server), title: 'Remote tools' },
            { kind: 'setting', fieldId: 'workspace', title: 'Workspace' },
            { kind: 'secret', fieldId: 'token', title: 'Token' },
            { kind: 'machineRecipe', ref },
        ]);
        expect(projectInstalledPluginSetup({
            ...input, connections: null, machineSetup: null,
            settings: settings.map(entry => ({ ...entry, status: 'unknown' })),
        })).toEqual([]);
    });
});
