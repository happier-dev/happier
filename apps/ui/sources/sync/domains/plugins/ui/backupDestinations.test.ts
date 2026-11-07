import { describe, expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { normalizePluginUiProjection } from './projection';
import { mergeInstalledPluginUiProjections, unionPluginUiProjections } from './projectionUnion';

describe('backup destination declaration carrying', () => {
    it('retains exact external declaration authority and withdraws a disabled supplier', () => {
        const pluginId = 'com.acme.backups';
        const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_backups',
            sourceRef: { machineId: 'supplier', pluginId, sourceCustody: { kind: 'development', registeredRootId: 'backup-root' } } });
        const entry = { id: `${pluginId}/disk`, pluginId, pluginVersion: '1.0.0', occurrenceId: 'backup-occurrence', executionOrigin,
            definition: { id: 'disk', title: 'Local recovery', configSchema: { type: 'object', properties: {}, additionalProperties: false },
                credentialRoles: [{ role: 'repositoryPassword' }, { role: 'sessionToken', optional: true }], resticTransport: 's3', locality: 'unknown',
                actions: { test: { pluginId, localId: 'test' }, open: { pluginId, localId: 'open' } } } };
        const wire = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {}, actionsById: {}, 
            resourcesById: {}, settingsById: {}, diagnostics: [], installedPackagesById: { [pluginId]: {
                id: pluginId, displayName: 'Backups', version: '1.0.0', enabled: true, occurrenceId: entry.occurrenceId, executionOrigin,
                sourceCustody: { kind: 'development', registeredRootId: 'backup-root' }, source: { kind: 'path', locator: '/plugins/acme' },
            } }, familiesById: { backupDestinations: { family: 'backupDestinations', entriesById: { [entry.id]: entry } } } });
        const model = normalizePluginUiProjection(wire);
        expect(model).toMatchObject({ backupDestinationsById: { [entry.id]: entry } });
        expect(normalizePluginUiProjection(wire, 'web', model, { previousInput: wire })).toBe(model);
        expect(mergeInstalledPluginUiProjections([model], null)).toMatchObject({ backupDestinationsById: { [entry.id]: entry } });
        const member = { machineId: 'supplier', serverId: 'server', serverIdentityId: 'srv_backups', phase: 'current' as const,
            interactionEnabled: true, projection: model };
        const origins = new Map([[pluginId, executionOrigin]]);
        expect(unionPluginUiProjections([member], origins).pluginUiProjection).toMatchObject({ backupDestinationsById: { [entry.id]: entry } });
        const disabled = { ...model, installedPackagesById: { ...model.installedPackagesById, [pluginId]: { ...model.installedPackagesById[pluginId]!, enabled: false } } };
        expect(unionPluginUiProjections([{ ...member, projection: disabled }], origins).pluginUiProjection?.backupDestinationsById ?? {}).toEqual({});
        expect(normalizePluginUiProjection(null)).toMatchObject({ backupDestinationsById: {} });
    });
});
