import { describe, expect, it } from 'vitest';
import { PluginProjectionV2Schema, projectPluginSettingsContributionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { MachineSetupObservationV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupObservationV1';
import { mcpPluginServerProjectionKeyV1 } from '@happier-dev/protocol/mcp/servers/pluginItemsV1';
import { mcpPluginItemIdV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { PluginSettingsContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/settings';

import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import { mapV2EditableSettingsGroup } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';

import { projectInstalledPluginSetup } from './installedPluginSetup';
import { installedPluginSetupDismissals, skipInstalledPluginSetupStep } from './installedPluginSetupDismissals';

describe('installed plugin setup', () => {
    it('counts configured and saved skipped steps without dismissing another Account or Machine’s setup', () => {
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
                machineRecipes: {
                    family: 'machineRecipes',
                    entriesById: {
                        [`${pluginId}/${ref.recipeId}`]: {
                            id: `${pluginId}/${ref.recipeId}`, pluginId, pluginVersion: '1.0.0',
                            definition: { id: ref.recipeId, revision: ref.revision, title: 'Set up tools',
                                inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [] },
                        },
                    },
                },
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
        const input = { pluginId, projection, machineId: 'machine-a', machineSetup, connections: { groups: [], profiles: [] }, settings };
        const pending = projectInstalledPluginSetup(input);
        expect(pending.progress).toEqual({ done: 0, total: 5 });
        expect(pending.rows).toMatchObject([
            { kind: 'connectedAccount', service, title: null },
            { kind: 'mcpSignIn', serverId: mcpPluginItemIdV1(server), title: 'Remote tools' },
            { kind: 'setting', fieldId: 'workspace', title: 'Workspace' },
            { kind: 'secret', fieldId: 'token', title: 'Token' },
            { kind: 'machineRecipe', item: { kind: 'setupRecipe', selection: { ref, inputs: {} } }, title: 'Set up tools' },
        ]);
        const scopeKey = serverAccountScopedResourceKey({ serverId: 'home-a', accountId: 'account-a' }, pluginId);
        const otherAccountKey = serverAccountScopedResourceKey({ serverId: 'home-a', accountId: 'account-b' }, pluginId);
        try {
            const mcpStep = pending.rows[1].id;
            const machineStep = pending.rows[4].id;
            skipInstalledPluginSetupStep(scopeKey, mcpStep);
            skipInstalledPluginSetupStep(scopeKey, machineStep);
            skipInstalledPluginSetupStep(scopeKey, mcpStep);
            // Admission reads the backing device record, independently of the owner’s in-memory observation.
            const persisted = installedPluginSetupDismissals.readStrict(scopeKey, value => {
                if (!Array.isArray(value)) throw new TypeError('Expected saved step IDs');
                return value;
            });
            expect(persisted).toEqual([mcpStep, machineStep]);
            const skipped = projectInstalledPluginSetup({
                ...input,
                skippedStepIds: installedPluginSetupDismissals.read(scopeKey),
                settings: settings.map(entry => entry.field.key === 'workspace' ? { ...entry, status: 'configured' as const } : entry),
            });
            expect(skipped.progress).toEqual({ done: 3, total: 5 });
            expect(skipped.steps.map(step => step.status)).toEqual(['pending', 'skipped', 'done', 'pending', 'skipped']);
            expect(skipped.rows.map(row => row.kind)).toEqual(['connectedAccount', 'secret']);
            expect(projectInstalledPluginSetup({
                ...input, machineId: 'machine-b', skippedStepIds: installedPluginSetupDismissals.read(scopeKey),
            }).progress).toEqual({ done: 1, total: 5 });
            expect(projectInstalledPluginSetup({
                ...input, skippedStepIds: installedPluginSetupDismissals.read(otherAccountKey),
            }).progress).toEqual({ done: 0, total: 5 });
        } finally {
            installedPluginSetupDismissals.remove(scopeKey);
        }
        const unresolved = projectInstalledPluginSetup({
            ...input, connections: null, machineSetup: null,
            settings: settings.map(entry => ({ ...entry, status: 'unknown' })),
        });
        expect(unresolved.progress).toEqual({ done: 0, total: 1 });
        expect(unresolved.rows.map(row => row.kind)).toEqual(['machineRecipe']);

        const observeRecipe = (revision: string) => projectInstalledPluginSetup({
            ...input, machineSetup: { ...machineSetup, recipes: [{ ref: { ...ref, revision }, status: 'satisfied', steps: [] }] },
        }).steps.find(step => step.kind === 'machineRecipe')?.status;
        expect(observeRecipe('older-revision')).toBe('pending');
        expect(observeRecipe(ref.revision)).toBe('done');
    });
});
