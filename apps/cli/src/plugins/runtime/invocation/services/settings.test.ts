import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1,
    type PluginSettingsContributionV2,
} from '@happier-dev/protocol';
import type { JsonValue } from '@happier-dev/plugin-sdk';

import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createPluginStorageOwner } from '../../context/storage';
import { createStablePluginEventsBroker, type StablePluginEventsBroker } from './events';
import {
    createAccountSettingsBackedSettingsRecordStore,
    createPluginStorageBackedSettingsRecordStore,
    createStablePluginSettingsModel,
    createStablePluginSettingsModels,
    createStablePluginSettingsHost,
    createStablePluginSettingsOwner,
    PLUGIN_SETTINGS_STORAGE_KEY,
    readPluginSettingsValuesWithDefaults,
    validateStablePluginSettingValue,
} from './settings';
import type { PluginInvocationServicesSeed } from './types';

describe('retired Settings fields are never pruned', () => {
    it('keeps declarations available while Account storage is unavailable and rechecks storage when it recovers', async () => {
        let available = false;
        let reads = 0;
        const host = createStablePluginSettingsHost({
            declarations: [{ pluginId: 'acme.plugin', contribution: {
                id: 'preferences', version: 1, title: 'Preferences', target: { kind: 'plugin' }, scope: 'account',
                fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' }, default: false }],
                presentation: { sections: [], subagentSections: [] },
            } }],
            recordStore: createAccountSettingsBackedSettingsRecordStore({
                isAvailable: () => available,
                async bindOperation() {
                    return {
                        async readRecord() { reads += 1; return { status: 'absent' as const }; },
                        async writeRecord() { throw new Error('This read-only fixture must not write'); },
                    };
                },
            }),
            broker: createStablePluginEventsBroker(),
        });
        const service = host.bind(seed(() => true))!.forScope({ kind: 'account' });
        expect(service.describe().map(field => field.id)).toEqual(['enabled']);
        await expect(service.get('enabled')).rejects.toMatchObject({ code: 'plugin_settings_scope_unavailable' });
        expect(reads).toBe(0);
        available = true;
        await expect(service.get('enabled')).resolves.toBe(false);
        expect(reads).toBe(1);
    });

    it('drops retired envelope and declared value fields on stored reads while preserving opaque field ids and strict set admission', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-settings-stored-'));
        const storage = createPluginStorageOwner({ pluginId: 'acme.plugin', paths: resolvePluginStorePaths({ happyHomeDir }) });
        await storage.daemon.set(PLUGIN_SETTINGS_STORAGE_KEY, { t: 'happier_plugin_settings_record_v1', revision: 3,
            retired: true, values: { config: { name: 'retained', retired: true, metadata: { nested: { retained: true } } }, oldField: { opaque: true } },
        });
        const model = createStablePluginSettingsModel({ pluginId: 'acme.plugin', contribution: {
            id: 'preferences', version: 1, title: 'Preferences', target: { kind: 'plugin' }, scope: 'daemon',
            fields: [
                { id: 'config', title: 'Configuration', schema: { type: 'object', properties: { name: { type: 'string' }, metadata: { type: 'object', additionalProperties: true } }, required: ['name'], additionalProperties: false } },
                { id: 'enabled', title: 'Enabled', schema: { type: 'boolean' } },
            ], presentation: { sections: [], subagentSections: [] },
        } });
        const owner = createStablePluginSettingsOwner({ recordStore: createPluginStorageBackedSettingsRecordStore({ storageForPlugin: () => storage.daemon }),
            broker: createStablePluginEventsBroker(),
        });
        const service = owner.bind({ model, seed: seed(() => true) });
        await expect(service.get('config')).resolves.toEqual({ name: 'retained', metadata: { nested: { retained: true } } });
        await expect(service.set('config', { name: 'new', retired: true })).rejects.toMatchObject({ code: 'plugin_settings_validation_failed' });
        await service.set('enabled', true);
        expect(await storage.daemon.get(PLUGIN_SETTINGS_STORAGE_KEY)).toEqual({ t: 'happier_plugin_settings_record_v1', revision: 4,
            values: { config: { name: 'retained', metadata: { nested: { retained: true } } }, oldField: { opaque: true }, enabled: true },
        });
    });
    const accountDeclaration = (): PluginSettingsContributionV2 => ({
        id: 'general',
        version: 1,
        title: { key: 'settings.general', fallback: 'General' },
        target: { kind: 'plugin' },
        scope: 'account',
        fields: [
            {
                id: 'theme',
                title: 'Theme',
                schema: { type: 'string', enum: ['light', 'dark'] },
                default: 'light',
            },
        ],
        presentation: { sections: [], subagentSections: [] },
    });
    const rollbackDeclaration = (): PluginSettingsContributionV2 => ({
        ...accountDeclaration(),
        fields: [
            ...accountDeclaration().fields,
            {
                id: 'legacyMode',
                title: 'Legacy mode',
                schema: { type: 'string', enum: ['turbo', 'safe'] },
                default: 'safe',
            },
        ],
    });

    /** One in-memory Account record shared by every plugin version bound to it. */
    function sharedAccountRecord() {
        let record: Readonly<{
            status: 'present';
            revision: number;
            values: Readonly<Record<string, JsonValue>>;
        }> = Object.freeze({
            status: 'present' as const,
            revision: 3,
            values: Object.freeze({
                theme: 'dark',
                // Removed from the current declaration; written by an earlier version.
                legacyMode: 'turbo',
                futureOpaque: { writtenBy: 'newer-client' },
            }),
        });
        let writeCount = 0;
        const recordStore = createAccountSettingsBackedSettingsRecordStore({
            async bindOperation() {
                return {
                    async readRecord() {
                        return record;
                    },
                    async writeRecord(_model: unknown, request: unknown) {
                        writeCount += 1;
                        const values = (request as { values: Readonly<Record<string, JsonValue>> }).values;
                        record = Object.freeze({
                            status: 'present' as const,
                            revision: record.revision + 1,
                            values: Object.freeze({ ...values }),
                        });
                        return Object.freeze({ status: 'updated' as const, revision: record.revision });
                    },
                };
            },
        });
        const bindVersion = (contribution: PluginSettingsContributionV2) => {
            const host = createStablePluginSettingsHost({
                declarations: [{ pluginId: 'acme.plugin', contribution }],
                recordStore,
                broker: createStablePluginEventsBroker(),
            });
            const bound = host.bind(seed(() => true));
            if (!bound) throw new Error('settings host did not bind the fixture plugin');
            return bound.forScope({ kind: 'account' });
        };
        return {
            bindVersion,
            readRawValues: () => record.values,
            writes: () => writeCount,
        };
    }

    it('hides an undeclared field from reads while its persisted value survives writes', async () => {
        const record = sharedAccountRecord();
        const current = record.bindVersion(accountDeclaration());
        await expect(current.snapshot()).resolves.toEqual({
            scope: { kind: 'account' },
            revision: '3',
            values: { theme: 'dark' },
        });
        await expect(current.get('legacyMode')).rejects.toMatchObject({
            code: 'plugin_settings_unknown_id',
        });
        // Reads never mutate.
        expect(record.writes()).toBe(0);
        await current.set('theme', 'light');
        expect(record.readRawValues()).toEqual({
            theme: 'light',
            legacyMode: 'turbo',
            futureOpaque: { writtenBy: 'newer-client' },
        });
    });

    it('keeps a retired value across an update and returns it after rollback', async () => {
        const record = sharedAccountRecord();
        // The installed version declares legacyMode.
        await expect(record.bindVersion(rollbackDeclaration()).get('legacyMode')).resolves.toBe('turbo');
        // An update retires legacyMode; the user keeps editing current fields.
        const updated = record.bindVersion(accountDeclaration());
        await updated.set('theme', 'light');
        await updated.reset('theme');
        // Rolling back to the version that declares it reads the same value.
        const rolledBack = record.bindVersion(rollbackDeclaration());
        await expect(rolledBack.get('legacyMode')).resolves.toBe('turbo');
        expect(record.readRawValues()).toMatchObject({ legacyMode: 'turbo' });
    });

    it('reads released Account fields before defaults while scoped values including null win', async () => {
        let persisted: Readonly<Record<string, JsonValue>> = {};
        const host = createStablePluginSettingsHost({
            declarations: [{ pluginId: 'acme.plugin', contribution: {
                ...accountDeclaration(),
                fields: [
                    { id: 'theme', title: 'Theme', schema: { anyOf: [{ type: 'string', enum: ['light', 'dark'] }, { type: 'null' }] }, default: 'light', presentation: { control: 'json', hidden: true } },
                    { id: 'analyticsOptOut', title: 'Owned host field', schema: { type: 'boolean' }, default: false },
                ],
            } }],
            recordStore: createAccountSettingsBackedSettingsRecordStore({
                async bindOperation() { return {
                    async readRecord() { return { status: 'present' as const, revision: 1, values: persisted }; },
                    async writeRecord() { throw new Error('Reading released fields cannot write a second record'); },
                }; },
            }),
            broker: createStablePluginEventsBroker(),
            onPluginSettingsUnavailable: ({ error }) => { throw error; },
        });
        const service = host.bind(seed(() => true))!.forScope({ kind: 'account' });
        const releasedAccountSettings = {
            settings: { theme: 'dark', analyticsOptOut: true },
            hostDefaults: { analyticsOptOut: false },
        };
        await expect(readPluginSettingsValuesWithDefaults(service, { releasedAccountSettings })).resolves.toEqual({ theme: 'dark', analyticsOptOut: false });
        persisted = { theme: null };
        await expect(readPluginSettingsValuesWithDefaults(service, { releasedAccountSettings })).resolves.toEqual({ theme: null, analyticsOptOut: false });
        persisted = { theme: 'light' };
        await expect(readPluginSettingsValuesWithDefaults(service, { releasedAccountSettings })).resolves.toEqual({ theme: 'light', analyticsOptOut: false });
        persisted = {};
        await expect(readPluginSettingsValuesWithDefaults(service, { releasedAccountSettings: {
            ...releasedAccountSettings, settings: { theme: { malformed: true } },
        } })).rejects.toMatchObject({ code: 'plugin_settings_record_invalid' });
    });

    it('projects declaration defaults with persisted non-secret fields while excluding secrets', async () => {
        const declaration = {
            ...accountDeclaration(),
            fields: [
                ...accountDeclaration().fields,
                {
                    id: 'apiKey',
                    title: 'API key',
                    schema: { type: 'string' as const },
                    secret: true as const,
                },
            ],
        };
        const host = createStablePluginSettingsHost({
            declarations: [{ pluginId: 'acme.plugin', contribution: declaration }],
            recordStore: createAccountSettingsBackedSettingsRecordStore({
                async bindOperation() {
                    return {
                        async readRecord() {
                            return Object.freeze({ status: 'present' as const, revision: 1, values: { theme: 'dark' } });
                        },
                        async writeRecord() {
                            return Object.freeze({ status: 'updated' as const, revision: 2 });
                        },
                    };
                },
            }),
            broker: createStablePluginEventsBroker(),
        });
        const service = host.bind(seed(() => true))?.forScope({ kind: 'account' });
        if (!service) throw new Error('settings host did not bind the fixture plugin');
        await expect(readPluginSettingsValuesWithDefaults(service)).resolves.toEqual({
            theme: 'dark',
        });
    });
});

function declaration(): PluginSettingsContributionV2 {
    return {
        id: 'preferences',
        version: 1,
        title: { key: 'settings.preferences', fallback: 'Preferences' },
        target: { kind: 'plugin' },
        scope: 'daemon',
        fields: [
            {
                id: 'endpoint',
                title: 'Endpoint',
                schema: { type: 'string', minLength: 4 },
                default: 'https://default.example',
            },
            {
                id: 'enabled',
                title: 'Enabled',
                schema: { type: 'boolean' },
                default: false,
            },
            {
                id: 'token',
                title: 'Token',
                schema: { type: 'string' },
                secret: true,
            },
        ],
        presentation: { sections: [], subagentSections: [] },
    };
}

function perActiveServerDeclaration(): PluginSettingsContributionV2 {
    return {
        id: 'server-preferences',
        version: 1,
        title: { key: 'settings.serverPreferences', fallback: 'Server preferences' },
        target: { kind: 'plugin' },
        scope: 'account',
        fields: [
            {
                id: 'endpoint',
                title: 'Endpoint',
                schema: { type: 'string', minLength: 1 },
                presentation: {
                    binding: {
                        kind: 'perActiveServer',
                        fallbackSettingId: 'endpoint',
                        byServerIdSettingId: 'endpointByServer',
                    },
                },
            },
            {
                id: 'endpointByServer',
                title: 'Endpoint by server',
                schema: {
                    type: 'object',
                    additionalProperties: { type: 'string', minLength: 1 },
                },
                presentation: { hidden: true },
            },
        ],
        presentation: { sections: [], subagentSections: [] },
    };
}

function seed(current: () => boolean, controller = new AbortController()): PluginInvocationServicesSeed {
    return Object.freeze({
        plugin: Object.freeze({ id: 'acme.plugin', version: '1.0.0' }),
        contribution: Object.freeze({
            id: 'configure',
            qualifiedId: 'acme.plugin/actions/configure',
        }),
        occurrenceId: 'occurrenceId-7',
        correlationId: 'correlation-1',
        surface: 'cli',
        signal: controller.signal,
        isOccurrenceCurrent: current,
    });
}

describe('stable typed settings foundation', () => {
    it('preserves an issued Settings Action commit when its occurrenceId retires before settlement', async () => {
        let current = true;
        let values: Readonly<Record<string, JsonValue>> = {};
        const model = createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: { ...declaration(), scope: 'account' },
        });
        const owner = createStablePluginSettingsOwner({
            recordStore: createAccountSettingsBackedSettingsRecordStore({
                async bindOperation() {
                    return {
                        async readRecord() { return { status: 'absent' }; },
                        async writeRecord(_model, request) {
                            values = request.values;
                            current = false;
                            return { status: 'updated', revision: 1 };
                        },
                    };
                },
            }),
            broker: createStablePluginEventsBroker(),
        });

        await expect(owner.applyActionPatch({
            model,
            seed: seed(() => current),
            contributionId: 'preferences',
            allowedFieldIds: ['endpoint'],
            expectedRevision: '0',
            patch: { endpoint: 'https://settled.example' },
        })).resolves.toMatchObject({ scope: { kind: 'account' }, revision: '1' });
        expect(values).toEqual({ endpoint: 'https://settled.example' });
    });

    it('applies a bounded contribution-scoped settings action patch atomically', async () => {
        let record: unknown | null = null;
        const recordStore = {
            supports: () => true,
            read: async () => record,
            async update<T>(
                _model: unknown,
                operation: (current: unknown | null) => Readonly<{
                    record: import('./settings').CanonicalPluginSettingsRecord;
                    result: T;
                }>,
            ): Promise<T> {
                const next = operation(record);
                record = next.record;
                return next.result;
            },
        };
        const model = createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: declaration(),
        });
        const owner = createStablePluginSettingsOwner({
            recordStore,
            broker: createStablePluginEventsBroker(),
        });

        await expect(owner.applyActionPatch({
            model,
            seed: seed(() => true),
            contributionId: 'preferences',
            allowedFieldIds: ['endpoint', 'enabled'],
            expectedRevision: '0',
            patch: {
                endpoint: 'https://action.example',
                enabled: true,
            },
        })).resolves.toEqual({
            scope: { kind: 'daemon' },
            revision: '1',
            changedIds: ['enabled', 'endpoint'],
            values: {
                endpoint: 'https://action.example',
                enabled: true,
            },
        });

        await expect(owner.applyActionPatch({
            model,
            seed: seed(() => true),
            contributionId: 'preferences',
            allowedFieldIds: ['endpoint'],
            patch: { enabled: false },
        })).rejects.toMatchObject({ code: 'plugin_settings_action_patch_forbidden' });
        await expect(owner.applyActionPatch({
            model,
            seed: seed(() => true),
            contributionId: 'preferences',
            allowedFieldIds: ['token'],
            patch: { token: 'must-not-write' },
        })).rejects.toMatchObject({ code: 'plugin_settings_action_patch_forbidden' });

        expect(record).toMatchObject({
            revision: 1,
            values: {
                endpoint: 'https://action.example',
                enabled: true,
            },
        });
    });

    it('uses the reserved Account plugin-settings record instead of unrelated host preference roots', async () => {
        const hostSettingsOutsidePluginRecord: Readonly<Record<string, unknown>> = Object.freeze({
            codexBackendMode: 'appServer',
            unrelatedHostPreferenceV1: {
                source: 'fixture',
                revision: 1,
            },
        });
        let record: Readonly<{
            status: 'present';
            revision: number;
            values: Readonly<Record<string, JsonValue>>;
        }> = Object.freeze({
            status: 'present' as const,
            revision: 7,
            values: Object.freeze({ codexBackendMode: 'acp' }),
        });
        const writes: unknown[] = [];
        const adapter = {
            // An unrelated host root makes accidental host-preference access loud.
            readSettings: () => hostSettingsOutsidePluginRecord,
            async updateSettings(): Promise<Readonly<Record<string, unknown>>> {
                throw new Error('legacy Account Settings writer must not be called');
            },
            async bindOperation() {
                return {
                    async readRecord() {
                        return record;
                    },
                    async writeRecord(_model: unknown, request: unknown) {
                        writes.push(request);
                        record = Object.freeze({
                            status: 'present' as const,
                            revision: 8,
                            values: Object.freeze({ codexBackendMode: 'appServer' }),
                        });
                        return Object.freeze({ status: 'updated' as const, revision: 8 });
                    },
                };
            },
        };
        const createRecordStore = () => createAccountSettingsBackedSettingsRecordStore(adapter);
        const model = createStablePluginSettingsModel({
            pluginId: 'happier.agent.codex',
            contribution: {
                id: 'agent-settings',
                version: 1,
                title: 'Codex settings',
                target: { kind: 'agent', agent: 'codex' },
                scope: 'account',
                fields: [{
                    id: 'codexBackendMode',
                    title: 'Backend mode',
                    schema: { type: 'string', enum: ['appServer', 'acp'] },
                    default: 'appServer',
                }],
                presentation: { sections: [], subagentSections: [] },
            },
        });
        const service = createStablePluginSettingsOwner({
            recordStore: createRecordStore(),
            broker: createStablePluginEventsBroker(),
        }).bind({ model, seed: seed(() => true) });

        await expect(service.snapshot()).resolves.toEqual({
            scope: { kind: 'account' },
            revision: '7',
            values: { codexBackendMode: 'acp' },
        });
        await expect(service.set('codexBackendMode', 'appServer', { expectedRevision: '7' }))
            .resolves.toEqual({ scope: { kind: 'account' }, revision: '8' });
        expect(writes).toEqual([{
            expectedRevision: 7,
            values: { codexBackendMode: 'appServer' },
        }]);
        expect(hostSettingsOutsidePluginRecord).toEqual({
            codexBackendMode: 'appServer',
            unrelatedHostPreferenceV1: {
                source: 'fixture',
                revision: 1,
            },
        });

        const restarted = createStablePluginSettingsOwner({
            recordStore: createRecordStore(),
            broker: createStablePluginEventsBroker(),
        }).bind({ model, seed: seed(() => true) });
        await expect(restarted.snapshot()).resolves.toEqual({
            scope: { kind: 'account' },
            revision: '8',
            values: { codexBackendMode: 'appServer' },
        });
        await expect(restarted.set('codexBackendMode', 'acp', { expectedRevision: '0' }))
            .rejects.toMatchObject({
                code: 'plugin_settings_revision_conflict',
                details: { currentRevision: '8' },
            });
    });

    it('re-reads the reserved Account record after its content-free change notification', async () => {
        let record: Readonly<{
            status: 'present';
            revision: number;
            values: Readonly<Record<string, JsonValue>>;
        }> = Object.freeze({
            status: 'present' as const,
            revision: 1,
            values: Object.freeze({ codexBackendMode: 'appServer' }),
        });
        const subscribers = new Set<(hint: Readonly<{ revision: number }>) => void>();
        const readRevisions: number[] = [];
        const adapter = {
            // Account plugin Settings must not read host preference roots after
            // the destination record becomes live.
            readSettings: () => Object.freeze({ codexBackendMode: 'acp' }),
            async updateSettings(): Promise<Readonly<Record<string, unknown>>> {
                throw new Error('legacy Account Settings writer must not be called');
            },
            async bindOperation() {
                return {
                    async readRecord() {
                        readRevisions.push(record.revision);
                        return record;
                    },
                    async writeRecord(_model: unknown, request: Readonly<{
                        expectedRevision: number | 'absent';
                        values: Readonly<Record<string, JsonValue>>;
                    }>) {
                        if (request.expectedRevision !== record.revision) {
                            return Object.freeze({ status: 'conflict' as const, revision: record.revision });
                        }
                        record = Object.freeze({
                            status: 'present' as const,
                            revision: record.revision + 1,
                            values: Object.freeze({ ...request.values }),
                        });
                        return Object.freeze({ status: 'updated' as const, revision: record.revision });
                    },
                };
            },
            watchRecord(_model: unknown, listener: (hint: Readonly<{ revision: number }>) => void) {
                subscribers.add(listener);
                return () => subscribers.delete(listener);
            },
        };
        const recordStore = createAccountSettingsBackedSettingsRecordStore(adapter);
        const model = createStablePluginSettingsModel({
            pluginId: 'happier.agent.codex',
            contribution: {
                id: 'agent-settings',
                version: 1,
                title: 'Codex settings',
                target: { kind: 'agent', agent: 'codex' },
                scope: 'account',
                fields: [{
                    id: 'codexBackendMode',
                    title: 'Backend mode',
                    schema: { type: 'string', enum: ['appServer', 'acp'] },
                    default: 'appServer',
                }],
                presentation: { sections: [], subagentSections: [] },
            },
        });
        const service = createStablePluginSettingsOwner({
            recordStore,
            broker: createStablePluginEventsBroker(),
        }).bind({ model, seed: seed(() => true) });
        const changes: unknown[] = [];
        const disposable = service.watch((change) => changes.push(change));
        await vi.waitFor(() => expect(readRevisions).toEqual([1]));

        record = Object.freeze({
            status: 'present' as const,
            revision: 2,
            values: Object.freeze({ codexBackendMode: 'acp' }),
        });
        for (const listener of subscribers) listener({ revision: 2 });

        await vi.waitFor(() => expect(changes).toEqual([{
            scope: { kind: 'account' },
            revision: '2',
            changedIds: ['codexBackendMode'],
            values: { codexBackendMode: 'acp' },
        }]));
        await expect(service.set('codexBackendMode', 'appServer', { expectedRevision: '2' }))
            .resolves.toEqual({ scope: { kind: 'account' }, revision: '3' });
        await vi.waitFor(() => expect(changes).toEqual([{
            scope: { kind: 'account' },
            revision: '2',
            changedIds: ['codexBackendMode'],
            values: { codexBackendMode: 'acp' },
        }, {
            scope: { kind: 'account' },
            revision: '3',
            changedIds: ['codexBackendMode'],
            values: { codexBackendMode: 'appServer' },
        }]));
        await disposable.dispose();
        expect(subscribers.size).toBe(0);
    });

    it('settles an ambiguous Account write only through an explicit readback postcondition', async () => {
        const records = [
            { status: 'present' as const, revision: 3, values: { codexBackendMode: 'acp' } },
            { status: 'present' as const, revision: 4, values: { codexBackendMode: 'appServer' } },
        ];
        const adapter = {
            async bindOperation() {
                return {
                    async readRecord() {
                        return records.shift() ?? { status: 'unavailable' as const };
                    },
                    async writeRecord() {
                        return { status: 'outcomeUnknown' as const };
                    },
                };
            },
        };
        const model = createStablePluginSettingsModel({
            pluginId: 'happier.agent.codex',
            contribution: {
                id: 'agent-settings',
                version: 1,
                title: 'Codex settings',
                target: { kind: 'agent', agent: 'codex' },
                scope: 'account',
                fields: [{
                    id: 'codexBackendMode',
                    title: 'Backend mode',
                    schema: { type: 'string', enum: ['appServer', 'acp'] },
                    default: 'appServer',
                }],
                presentation: { sections: [], subagentSections: [] },
            },
        });
        const service = createStablePluginSettingsOwner({
            recordStore: createAccountSettingsBackedSettingsRecordStore(adapter),
            broker: createStablePluginEventsBroker(),
        }).bind({ model, seed: seed(() => true) });

        await expect(service.set('codexBackendMode', 'appServer')).resolves.toEqual({
            scope: { kind: 'account' },
            revision: '4',
        });

        const oneShotAdapter = {
            async bindOperation() {
                return {
                    async readRecord() {
                        return { status: 'present' as const, revision: 4, values: { codexBackendMode: 'appServer' } };
                    },
                    async writeRecord() {
                        return { status: 'outcomeUnknown' as const };
                    },
                };
            },
        };
        const oneShotService = createStablePluginSettingsOwner({
            recordStore: createAccountSettingsBackedSettingsRecordStore(oneShotAdapter),
            broker: createStablePluginEventsBroker(),
        }).bind({ model, seed: seed(() => true) });
        await expect(oneShotService.set('codexBackendMode', 'acp', { expectedRevision: '4' }))
            .rejects.toMatchObject({
                code: 'plugin_settings_outcome_unknown',
                details: { lastKnownRevision: '4' },
            });
    });

    it('settles an ambiguous Account write readback after caller cancellation without treating the commit as lost', async () => {
        const controller = new AbortController();
        let reads = 0;
        const adapter = {
            async bindOperation() {
                return {
                    async readRecord(_model: unknown, options?: { signal?: AbortSignal }) {
                        reads += 1;
                        if (reads === 1) {
                            expect(options?.signal).toBe(controller.signal);
                            return { status: 'present' as const, revision: 3, values: { codexBackendMode: 'acp' } };
                        }
                        expect(options?.signal).toBeUndefined();
                        return { status: 'present' as const, revision: 4, values: { codexBackendMode: 'appServer' } };
                    },
                    async writeRecord() {
                        controller.abort();
                        return { status: 'outcomeUnknown' as const };
                    },
                };
            },
        };
        const model = createStablePluginSettingsModel({
            pluginId: 'happier.agent.codex',
            contribution: {
                id: 'agent-settings',
                version: 1,
                title: 'Codex settings',
                target: { kind: 'agent', agent: 'codex' },
                scope: 'account',
                fields: [{
                    id: 'codexBackendMode',
                    title: 'Backend mode',
                    schema: { type: 'string', enum: ['appServer', 'acp'] },
                    default: 'appServer',
                }],
                presentation: { sections: [], subagentSections: [] },
            },
        });
        const service = createStablePluginSettingsOwner({
            recordStore: createAccountSettingsBackedSettingsRecordStore(adapter),
            broker: createStablePluginEventsBroker(),
        }).bind({ model, seed: seed(() => true) });

        await expect(service.set('codexBackendMode', 'appServer', { signal: controller.signal }))
            .resolves.toEqual({ scope: { kind: 'account' }, revision: '4' });
    });

    it('rejects retired Settings scopes instead of translating them into a supported owner', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-settings-scopes-'));
        const recordStore = createPluginStorageBackedSettingsRecordStore({
            storageForPlugin: (pluginId) => createPluginStorageOwner({
                pluginId,
                paths: resolvePluginStorePaths({ happyHomeDir }),
            }).daemon,
        });
        const retiredContribution = {
            ...declaration(),
            scope: 'project',
        } as unknown as PluginSettingsContributionV2;
        expect(() => createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: retiredContribution,
        })).toThrowError(expect.objectContaining({
            code: 'plugin_settings_declaration_invalid',
        }));
        const host = createStablePluginSettingsHost({
            declarations: [{
                pluginId: 'acme.plugin',
                contribution: declaration(),
            }],
            recordStore,
            broker: createStablePluginEventsBroker(),
        });
        expect(host.bind(seed(() => true))?.forScope({ kind: 'daemon' }))
            .toBeDefined();
    });

    it('isolates one plugin whose settings declaration cannot be modelled', () => {
        const invalidDefault = {
            ...declaration(),
            id: 'prefs',
            fields: [{
                id: 'endpoint',
                title: 'Endpoint',
                schema: { type: 'string', minLength: 40 },
                default: 'short',
            }],
        } as unknown as PluginSettingsContributionV2;
        const isolationRecordStore = {
            supports: () => true,
            read: async () => null,
            update: async <T>(
                _model: unknown,
                operation: (current: unknown | null) => Readonly<{ record: unknown; result: T }>,
            ): Promise<T> => operation(null).result,
        } as unknown as Parameters<typeof createStablePluginSettingsHost>[0]['recordStore'];
        const unavailable: { pluginId: string; message: string }[] = [];
        const host = createStablePluginSettingsHost({
            declarations: [
                { pluginId: 'bad.plugin', contribution: invalidDefault },
                { pluginId: 'acme.plugin', contribution: declaration() },
            ],
            recordStore: isolationRecordStore,
            broker: createStablePluginEventsBroker(),
            onPluginSettingsUnavailable({ pluginId, error }) {
                unavailable.push({ pluginId, message: (error as Error).message });
            },
        });
        // The mis-authored plugin loses its own Settings service and nothing else.
        expect(host.hasPlugin('acme.plugin')).toBe(true);
        expect(host.hasPlugin('bad.plugin')).toBe(false);
        expect(host.bind(seed(() => true))?.forScope({ kind: 'daemon' })).toBeDefined();
        // The refusal is reported with its real cause, never silently dropped.
        expect(unavailable).toHaveLength(1);
        expect(unavailable[0]?.pluginId).toBe('bad.plugin');
        expect(unavailable[0]?.message).toContain('invalid default');
    });

    it('keeps a healthy same-plugin group writable beside invalid defaults and controls without pruning stored opaque fields', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-settings-isolation-'));
        const storage = createPluginStorageOwner({ pluginId: 'acme.plugin', paths: resolvePluginStorePaths({ happyHomeDir }) });
        await storage.daemon.set(PLUGIN_SETTINGS_STORAGE_KEY, { t: 'happier_plugin_settings_record_v1', revision: 1,
            values: { rejected: 'opaque', retired: { keep: true } } });
        const errors: unknown[] = [];
        const host = createStablePluginSettingsHost({
            declarations: [
                { pluginId: 'acme.plugin', contribution: { ...declaration(), id: 'bad-default', fields: [
                    { id: 'rejected', title: 'Rejected', schema: { type: 'boolean' }, default: 'true' },
                ] } },
                { pluginId: 'acme.plugin', contribution: { ...declaration(), id: 'ambiguous', fields: [
                    { id: 'ambiguous', title: 'Ambiguous', schema: { anyOf: [{ type: 'integer' }, { type: 'null' }] }, default: null },
                ] } },
                { pluginId: 'acme.plugin', contribution: declaration() },
            ],
            recordStore: createPluginStorageBackedSettingsRecordStore({ storageForPlugin: () => storage.daemon }),
            broker: createStablePluginEventsBroker(),
            onPluginSettingsUnavailable({ error }) { errors.push(error); },
        });
        expect(host.hasPlugin('acme.plugin')).toBe(true);
        const service = host.bind(seed(() => true))!.forScope({ kind: 'daemon' });
        expect(service.describe().map(field => field.id)).not.toContain('rejected');
        expect(service.describe().map(field => field.id)).not.toContain('ambiguous');
        await expect(service.get('rejected')).rejects.toMatchObject({ code: 'plugin_settings_unknown_id' });
        await expect(service.set('endpoint', false)).rejects.toMatchObject({ code: 'plugin_settings_validation_failed' });
        await service.set('endpoint', 'https://healthy.example');
        await expect(service.get('endpoint')).resolves.toBe('https://healthy.example');
        expect(await storage.daemon.get(PLUGIN_SETTINGS_STORAGE_KEY)).toMatchObject({ values: {
            rejected: 'opaque', retired: { keep: true }, endpoint: 'https://healthy.example',
        } });
        expect(errors).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'PLUGIN_SETTINGS_DEFAULT_INVALID', contributionId: 'bad-default', fieldId: 'rejected' }),
            expect.objectContaining({ code: 'PLUGIN_SETTINGS_PROJECTION_INVALID', contributionId: 'ambiguous', fieldId: 'ambiguous' }),
        ]));
    });

    it('permits the same non-secret local id across account and daemon scopes', () => {
        const accountEndpoint: PluginSettingsContributionV2 = {
            ...declaration(),
            scope: 'account',
            fields: [{
                id: 'endpoint',
                title: 'Endpoint',
                schema: { type: 'string', minLength: 4 },
                default: 'https://account.example',
            }],
        };
        const daemonEndpoint: PluginSettingsContributionV2 = {
            ...declaration(),
            fields: [{
                id: 'endpoint',
                title: 'Endpoint',
                schema: { type: 'boolean' },
                default: false,
            }],
        };

        const models = createStablePluginSettingsModels({
            pluginId: 'acme.plugin',
            contributions: [accountEndpoint, daemonEndpoint],
        });

        expect(models.get('account')?.fields.map((field) => field.qualifiedId)).toContain(
            'acme.plugin/settings/account/preferences/fields/endpoint',
        );
        expect(models.get('daemon')?.fields.map((field) => field.qualifiedId)).toContain(
            'acme.plugin/settings/daemon/preferences/fields/endpoint',
        );
    });

    it('uses one plugin-local revision across every flattened settings contribution', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-settings-flattened-'));
        const storage = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths: resolvePluginStorePaths({ happyHomeDir }),
        });
        const model = createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contributions: [
                declaration(),
                {
                    ...declaration(),
                    id: 'appearance',
                    fields: [{ id: 'theme', title: 'Theme', schema: { type: 'string' }, default: 'system' }],
                },
            ],
        });
        const service = createStablePluginSettingsOwner({
            recordStore: createPluginStorageBackedSettingsRecordStore({ storageForPlugin: () => storage.daemon }),
            broker: createStablePluginEventsBroker(),
        }).bind({ model, seed: seed(() => true) });

        expect(service.describe().map((field) => field.id)).toEqual(['endpoint', 'enabled', 'token', 'theme']);
        await expect(service.set('endpoint', 'https://one.example', { expectedRevision: '0' }))
            .resolves.toEqual({ scope: { kind: 'daemon' }, revision: '1' });
        await expect(service.set('theme', 'dark', { expectedRevision: '0' }))
            .rejects.toMatchObject({ code: 'plugin_settings_revision_conflict' });
        await expect(service.set('theme', 'dark', { expectedRevision: '1' }))
            .resolves.toEqual({ scope: { kind: 'daemon' }, revision: '2' });
        await expect(service.snapshot()).resolves.toEqual({
            scope: { kind: 'daemon' },
            revision: '2',
            values: { endpoint: 'https://one.example', theme: 'dark' },
        });
        await service.set('enabled', true);
        await expect(service.snapshot()).resolves.toEqual({
            scope: { kind: 'daemon' },
            revision: '3',
            values: { endpoint: 'https://one.example', theme: 'dark', enabled: true },
        });
        expect(await storage.daemon.get(PLUGIN_SETTINGS_STORAGE_KEY)).toEqual({
            t: 'happier_plugin_settings_record_v1',
            revision: 3,
            values: { endpoint: 'https://one.example', theme: 'dark', enabled: true },
        });
        expect(await storage.daemon.get('typed-settings/preferences')).toBeNull();
        expect(await storage.daemon.get('typed-settings/appearance')).toBeNull();
    });

    it('hides removed fields while preserving their raw evidence across current-field writes', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-settings-removed-field-'));
        const storage = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths: resolvePluginStorePaths({ happyHomeDir }),
        });
        await storage.daemon.set(PLUGIN_SETTINGS_STORAGE_KEY, {
            t: 'happier_plugin_settings_record_v1',
            revision: 4,
            values: {
                endpoint: 'https://current.example',
                removedPreference: { retained: 'raw-evidence' },
            },
        });
        const model = createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: declaration(),
        });
        const service = createStablePluginSettingsOwner({
            recordStore: createPluginStorageBackedSettingsRecordStore({ storageForPlugin: () => storage.daemon }),
            broker: createStablePluginEventsBroker(),
        }).bind({ model, seed: seed(() => true) });

        await expect(service.get('endpoint')).resolves.toBe('https://current.example');
        await expect(service.snapshot()).resolves.toEqual({
            scope: { kind: 'daemon' },
            revision: '4',
            values: { endpoint: 'https://current.example' },
        });
        await expect(service.set('enabled', true, { expectedRevision: '4' }))
            .resolves.toEqual({ scope: { kind: 'daemon' }, revision: '5' });
        expect(await storage.daemon.get(PLUGIN_SETTINGS_STORAGE_KEY)).toEqual({
            t: 'happier_plugin_settings_record_v1',
            revision: 5,
            values: {
                endpoint: 'https://current.example',
                removedPreference: { retained: 'raw-evidence' },
                enabled: true,
            },
        });
    });

    it('validates a retained raw field when that id is current again', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-settings-reintroduced-field-'));
        const storage = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths: resolvePluginStorePaths({ happyHomeDir }),
        });
        await storage.daemon.set(PLUGIN_SETTINGS_STORAGE_KEY, {
            t: 'happier_plugin_settings_record_v1',
            revision: 4,
            values: { endpoint: { incompatible: true } },
        });
        const model = createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: declaration(),
        });
        const service = createStablePluginSettingsOwner({
            recordStore: createPluginStorageBackedSettingsRecordStore({ storageForPlugin: () => storage.daemon }),
            broker: createStablePluginEventsBroker(),
        }).bind({ model, seed: seed(() => true) });

        await expect(service.get('endpoint'))
            .rejects.toMatchObject({ code: 'plugin_settings_record_invalid' });
        await expect(service.snapshot())
            .rejects.toMatchObject({ code: 'plugin_settings_record_invalid' });
    });

    it('rejects an unpublished raw predecessor record instead of importing it', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-settings-direct-cut-'));
        const storage = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths: resolvePluginStorePaths({ happyHomeDir }),
        });
        await storage.daemon.set(PLUGIN_SETTINGS_STORAGE_KEY, {
            endpoint: 'https://predecessor.example',
        });
        const model = createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: declaration(),
        });
        const service = createStablePluginSettingsOwner({
            recordStore: createPluginStorageBackedSettingsRecordStore({
                storageForPlugin: () => storage.daemon,
            }),
            broker: createStablePluginEventsBroker(),
        }).bind({ model, seed: seed(() => true) });

        await expect(service.snapshot())
            .rejects.toMatchObject({ code: 'plugin_settings_record_invalid' });
    });

    it('keeps nested contribution and field identities collision-free', () => {
        const nestedContribution = createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: {
                ...declaration(),
                id: 'preferences/fields/layout',
                fields: [{ id: 'mode', title: 'Mode', schema: { type: 'string' } }],
            },
        });
        const nestedField = createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: {
                ...declaration(),
                id: 'preferences',
                fields: [{ id: 'layout/fields/mode', title: 'Mode', schema: { type: 'string' } }],
            },
        });

        expect(nestedContribution.fields[0]?.qualifiedId).not.toBe(nestedField.fields[0]?.qualifiedId);
        expect(nestedContribution.fields[0]?.qualifiedId)
            .toBe('acme.plugin/settings/daemon/preferences%2Ffields%2Flayout/fields/mode');
        expect(nestedField.fields[0]?.qualifiedId)
            .toBe('acme.plugin/settings/daemon/preferences/fields/layout%2Ffields%2Fmode');
    });

    it('passes deep strict JSON to the declared setting schema without a generic depth quota', () => {
        const model = createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: {
                ...declaration(),
                fields: [{ id: 'nested', title: 'Nested', schema: { type: 'object' } }],
            },
        });
        let value: JsonValue = {};
        for (let depth = 0; depth < 128; depth += 1) value = { child: value };

        expect(validateStablePluginSettingValue(model, 'nested', value)).toBe(true);
    });

    it('rejects oversized per-active-server maps on direct validation, writes, and record reads', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-settings-per-active-server-'));
        const storage = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths: resolvePluginStorePaths({ happyHomeDir }),
        });
        const model = createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: perActiveServerDeclaration(),
        });
        const oversized = Object.fromEntries(
            Array.from({ length: 257 }, (_, index) => [`server-${index}`, 'https://example.test']),
        ) as JsonValue;
        const owner = createStablePluginSettingsOwner({
            recordStore: createPluginStorageBackedSettingsRecordStore({
                storageForPlugin: () => storage.daemon,
                scope: 'account',
            }),
            broker: createStablePluginEventsBroker(),
        });
        const invocationSeed = seed(() => true);
        const service = owner.bind({ model, seed: invocationSeed });

        expect(validateStablePluginSettingValue(model, 'endpointByServer', oversized)).toBe(false);
        await expect(owner.applyActionPatch({
            model,
            seed: invocationSeed,
            contributionId: 'server-preferences',
            allowedFieldIds: ['endpointByServer'],
            patch: { endpointByServer: oversized },
            expectedRevision: '0',
        })).rejects.toMatchObject({ code: 'plugin_settings_validation_failed' });
        await expect(service.set('endpointByServer', oversized, { expectedRevision: '0' }))
            .rejects.toMatchObject({ code: 'plugin_settings_validation_failed' });

        await storage.daemon.set(PLUGIN_SETTINGS_STORAGE_KEY, {
            t: 'happier_plugin_settings_record_v1',
            revision: 1,
            values: { endpointByServer: oversized },
        });
        await expect(service.snapshot()).rejects.toMatchObject({ code: 'plugin_settings_record_invalid' });
    });

    it('normalizes qualified field identities and rejects accessor-bearing or invalid defaults without reading accessors', () => {
        const model = createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: declaration(),
        });

        expect(model.identity).toEqual({
            pluginId: 'acme.plugin',
            qualifiedId: 'acme.plugin/settings/daemon',
        });
        expect(model.descriptors.map((descriptor) => descriptor.id)).toEqual([
            'endpoint',
            'enabled',
            'token',
        ]);
        expect(model.fields.find((field) => field.id === 'endpoint')?.qualifiedId)
            .toBe('acme.plugin/settings/daemon/preferences/fields/endpoint');
        expect(model.descriptors[0]).toMatchObject({
            title: 'Endpoint',
            target: { kind: 'plugin' },
            scope: 'daemon',
            default: 'https://default.example',
        });
        expect(structuredClone(model).fields.map((field) => field.id)).toEqual([
            'endpoint',
            'enabled',
            'token',
        ]);

        let reads = 0;
        const accessorField = {
            id: 'danger',
            title: 'Danger',
            schema: { type: 'string' },
        } as Record<string, unknown>;
        Object.defineProperty(accessorField, 'default', {
            enumerable: true,
            get() {
                reads += 1;
                return 'stolen';
            },
        });
        const accessorDeclaration = {
            ...declaration(),
            fields: [accessorField],
        } as unknown as PluginSettingsContributionV2;

        expect(() => createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: accessorDeclaration,
        })).toThrowError(expect.objectContaining({ code: 'plugin_settings_invalid_plain_data' }));
        expect(reads).toBe(0);

        const cyclicMetadata: Record<string, unknown> = {};
        cyclicMetadata.self = cyclicMetadata;
        expect(() => createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: {
                ...declaration(),
                metadata: cyclicMetadata,
            } as unknown as PluginSettingsContributionV2,
        })).toThrowError(expect.objectContaining({ code: 'plugin_settings_invalid_plain_data' }));

        const prototypeKeyDefault = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(prototypeKeyDefault, '__proto__', {
            value: 'preserved',
            enumerable: true,
        });
        const prototypeKeyModel = createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: {
                ...declaration(),
                fields: [{
                    id: 'prototype-key',
                    title: 'Prototype key',
                    schema: { type: 'object', additionalProperties: { type: 'string' } },
                    default: prototypeKeyDefault,
                }],
            } as PluginSettingsContributionV2,
        });
        const prototypeKeyValue = prototypeKeyModel.descriptors[0]?.default;
        expect(Object.prototype.hasOwnProperty.call(prototypeKeyValue, '__proto__')).toBe(true);
        expect(Reflect.get(prototypeKeyValue as object, '__proto__')).toBe('preserved');

        expect(() => createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: {
                ...declaration(),
                fields: [{
                    id: 'count',
                    title: 'Count',
                    schema: { type: 'integer', minimum: 1 },
                    default: 0,
                }],
            },
        })).toThrowError(expect.objectContaining({ code: 'plugin_settings_invalid_default' }));

        expect(() => createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: {
                ...declaration(),
                fields: [{
                    id: 'nested-default',
                    title: 'Nested default',
                    schema: { type: 'string', default: 'not-the-owner' },
                }],
            } as unknown as PluginSettingsContributionV2,
        })).toThrowError(expect.objectContaining({ code: 'plugin_settings_declaration_invalid' }));

        const valueTypes = createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: {
                id: 'agent-preferences',
                version: 1,
                title: 'Agent preferences',
                target: { kind: 'agent', agent: 'primary' },
                scope: 'daemon',
                fields: [
                    { id: 'null-value', title: 'Null', schema: { type: 'null' }, default: null },
                    { id: 'boolean-value', title: 'Boolean', schema: { type: 'boolean' }, default: true },
                    { id: 'number-value', title: 'Number', schema: { type: 'number' }, default: 1.5 },
                    { id: 'integer-value', title: 'Integer', schema: { type: 'integer' }, default: 2 },
                    { id: 'string-value', title: 'String', schema: { type: 'string' }, default: 'value' },
                    { id: 'array-value', title: 'Array', schema: { type: 'array', items: { type: 'string' } }, default: ['value'] },
                    { id: 'object-value', title: 'Object', schema: { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] }, default: { enabled: true } },
                ],
                presentation: { sections: [], subagentSections: [] },
            },
        });
        expect(valueTypes.descriptors.map((descriptor) => descriptor.default)).toEqual([
            null,
            true,
            1.5,
            2,
            'value',
            ['value'],
            { enabled: true },
        ]);
        expect(valueTypes.descriptors[0]?.target).toEqual({
            kind: 'agent',
            agent: { pluginId: 'acme.plugin', localId: 'primary' },
        });
    });

    it('persists revisioned non-secret values, publishes canonical broker changes, and fences conflicts and retired generations', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-settings-'));
        const storage = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths: resolvePluginStorePaths({ happyHomeDir }),
        });
        const recordStore = createPluginStorageBackedSettingsRecordStore({
            storageForPlugin: () => storage.daemon,
        });
        const broker = createStablePluginEventsBroker();
        const owner = createStablePluginSettingsOwner({ recordStore, broker });
        const model = createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: declaration(),
        });
        let current = true;
        const controller = new AbortController();
        const service = owner.bind({ model, seed: seed(() => current, controller) });
        const changes: unknown[] = [];
        const disposable = service.watch((change) => changes.push(change));

        expect(service.describe()).toEqual(model.descriptors);
        await expect(service.snapshot()).resolves.toEqual({
            scope: { kind: 'daemon' },
            revision: '0',
            values: {},
        });
        await expect(service.get('endpoint')).resolves.toBe('https://default.example');
        await expect(service.get('enabled')).resolves.toBe(false);

        await expect(service.set('endpoint', 'https://one.example', { expectedRevision: '0' }))
            .resolves.toEqual({ scope: { kind: 'daemon' }, revision: '1' });
        await vi.waitFor(() => expect(changes).toEqual([{
            scope: { kind: 'daemon' },
            revision: '1',
            changedIds: ['endpoint'],
            values: { endpoint: 'https://one.example' },
        }]));
        await expect(service.set('enabled', true, { expectedRevision: '0' }))
            .rejects.toMatchObject({
                code: 'plugin_settings_revision_conflict',
                details: { currentRevision: '1' },
            });
        await expect(service.set('enabled', 'true' as never))
            .rejects.toMatchObject({ code: 'plugin_settings_validation_failed' });

        const restarted = createStablePluginSettingsOwner({
            recordStore: createPluginStorageBackedSettingsRecordStore({
                storageForPlugin: () => createPluginStorageOwner({
                    pluginId: 'acme.plugin',
                    paths: resolvePluginStorePaths({ happyHomeDir }),
                }).daemon,
            }),
            broker,
        }).bind({ model, seed: seed(() => true) });
        await expect(restarted.snapshot()).resolves.toEqual({
            scope: { kind: 'daemon' },
            revision: '1',
            values: { endpoint: 'https://one.example' },
        });
        await expect(restarted.reset('endpoint', { expectedRevision: '1' }))
            .resolves.toEqual({ scope: { kind: 'daemon' }, revision: '2' });
        await expect(restarted.get('endpoint')).resolves.toBe('https://default.example');

        await expect(service.get('token')).rejects.toMatchObject({
            code: 'plugin_settings_secret_materialization_required',
        });
        await expect(service.set('token', 'must-not-persist')).rejects.toMatchObject({
            code: 'plugin_settings_secret_materialization_required',
        });
        expect(await storage.daemon.get(PLUGIN_SETTINGS_STORAGE_KEY)).toEqual({
            t: 'happier_plugin_settings_record_v1',
            revision: 2,
            values: {},
        });

        current = false;
        await expect(service.set('enabled', true)).rejects.toMatchObject({
            code: 'plugin_settings_generation_retired',
        });
        expect(() => service.describe()).toThrowError(expect.objectContaining({
            code: 'plugin_settings_generation_retired',
        }));
        controller.abort();
        await expect(broker.emit({
            event: {
                ref: { pluginId: '@happier', localId: 'runtime/plugin-settings-changed' },
                payload: {
                    settings: { pluginId: 'acme.plugin', scope: 'daemon' },
                    revision: '3',
                    changedIds: ['enabled'],
                    values: { enabled: true },
                },
            },
            identity: {
                pluginId: 'acme.plugin',
                pluginVersion: '1.0.0',
                contributionId: 'configure',
                contributionQualifiedId: 'acme.plugin/actions/configure',
                occurrenceId: 'occurrenceId-8',
                correlationId: 'cleanup-check',
                surface: 'cli',
            },
        })).resolves.toMatchObject({ subscriberCount: 0 });
        await disposable.dispose();
    });

    it('serializes concurrent revision checks and fails closed for corrupt records and unsupported persistence scopes', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-settings-cas-'));
        const storage = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths: resolvePluginStorePaths({ happyHomeDir }),
        });
        const model = createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: declaration(),
        });
        const service = createStablePluginSettingsOwner({
            recordStore: createPluginStorageBackedSettingsRecordStore({
                storageForPlugin: () => storage.daemon,
            }),
            broker: createStablePluginEventsBroker(),
        }).bind({ model, seed: seed(() => true) });
        const peerService = createStablePluginSettingsOwner({
            recordStore: createPluginStorageBackedSettingsRecordStore({
                storageForPlugin: () => createPluginStorageOwner({
                    pluginId: 'acme.plugin',
                    paths: resolvePluginStorePaths({ happyHomeDir }),
                }).daemon,
            }),
            broker: createStablePluginEventsBroker(),
        }).bind({ model, seed: seed(() => true) });

        const concurrent = await Promise.allSettled([
            service.set('endpoint', 'https://winner.example', { expectedRevision: '0' }),
            peerService.set('enabled', true, { expectedRevision: '0' }),
        ]);
        expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(concurrent.filter((result) => result.status === 'rejected')).toEqual([
            expect.objectContaining({
                reason: expect.objectContaining({
                    code: 'plugin_settings_revision_conflict',
                    details: { currentRevision: '1' },
                }),
            }),
        ]);

        await storage.daemon.set(PLUGIN_SETTINGS_STORAGE_KEY, {
            t: 'happier_plugin_settings_record_v1',
            revision: 2,
            values: { token: 'leaked-secret' },
        });
        await expect(service.snapshot()).rejects.toMatchObject({
            code: 'plugin_settings_record_invalid',
        });

        const unavailableDaemonService = createStablePluginSettingsOwner({
            recordStore: createPluginStorageBackedSettingsRecordStore({
                scope: 'account',
                storageForPlugin: () => storage.daemon,
            }),
            broker: createStablePluginEventsBroker(),
        }).bind({ model, seed: seed(() => true) });
        await expect(unavailableDaemonService.snapshot()).rejects.toMatchObject({
            code: 'plugin_settings_scope_unavailable',
        });
    });

    it('does not turn transient broker admission failure into a durable event log', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-settings-outbox-'));
        const storage = createPluginStorageOwner({
            pluginId: 'acme.plugin',
            paths: resolvePluginStorePaths({ happyHomeDir }),
        });
        const realBroker = createStablePluginEventsBroker();
        const failingBroker = Object.freeze({
            ...realBroker,
            async emit(): Promise<never> {
                throw new Error('broker admission unavailable');
            },
        }) satisfies StablePluginEventsBroker;
        const model = createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: declaration(),
        });
        const recordStore = createPluginStorageBackedSettingsRecordStore({
            storageForPlugin: () => storage.daemon,
        });
        const first = createStablePluginSettingsOwner({
            recordStore,
            broker: failingBroker,
        }).bind({ model, seed: seed(() => true) });

        await expect(first.set('endpoint', 'https://durable.example', { expectedRevision: '0' }))
            .resolves.toEqual({ scope: { kind: 'daemon' }, revision: '1' });
        expect(await storage.daemon.get(PLUGIN_SETTINGS_STORAGE_KEY)).toEqual({
            t: 'happier_plugin_settings_record_v1',
            revision: 1,
            values: { endpoint: 'https://durable.example' },
        });

        const delivered: unknown[] = [];
        const recovered = createStablePluginSettingsOwner({ recordStore, broker: realBroker })
            .bind({ model, seed: seed(() => true) });
        const disposable = recovered.watch((change) => delivered.push(change));
        await Promise.resolve();
        expect(delivered).toEqual([]);
        await disposable.dispose();
    });
});

describe('canonical Settings record bounds', () => {
    function boundedDeclaration(scope: 'account' | 'daemon'): PluginSettingsContributionV2 {
        return { ...declaration(), scope };
    }

    function boundedFixture(
        scope: 'account' | 'daemon',
        initialValues?: Readonly<Record<string, JsonValue>>,
        fields: PluginSettingsContributionV2['fields'] = declaration().fields,
    ) {
        let record: unknown | null = initialValues === undefined
            ? null
            : Object.freeze({
                t: 'happier_plugin_settings_record_v1',
                revision: 4,
                values: Object.freeze({ ...initialValues }),
            });
        const recordStore = {
            supports: () => true,
            read: async () => record,
            async update<T>(
                _model: unknown,
                operation: (current: unknown | null) => Readonly<{
                    record: import('./settings').CanonicalPluginSettingsRecord;
                    result: T;
                    skipWrite?: boolean;
                }>,
            ): Promise<T> {
                const next = operation(record);
                if (next.skipWrite !== true) record = next.record;
                return next.result;
            },
        };
        return {
            recordStore,
            model: createStablePluginSettingsModel({
                pluginId: 'acme.plugin',
                contribution: { ...boundedDeclaration(scope), fields },
            }),
            owner: createStablePluginSettingsOwner({
                recordStore,
                broker: createStablePluginEventsBroker(),
            }),
            readRecord: () => record,
        };
    }

    it('applies the canonical Account record bounds to an Account-scope set', async () => {
        const fixture = boundedFixture('account');
        const service = fixture.owner.bind({ model: fixture.model, seed: seed(() => true) });

        // Well under the 512 KiB record ceiling this owner used to transcribe on
        // its own, so only the canonical Account per-field bound — the same one
        // the Account record adapter enforces before persisting — can refuse it.
        await expect(service.set(
            'endpoint',
            'x'.repeat(PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1.maximumFieldEncodedBytes),
        )).rejects.toMatchObject({ code: 'plugin_settings_values_too_large' });
        expect(fixture.readRecord()).toBeNull();

        await expect(service.set('endpoint', 'https://bounded.example'))
            .resolves.toEqual({ scope: { kind: 'account' }, revision: '1' });
    });

    it('applies the same canonical record bounds to a daemon-scope set', async () => {
        const objectField = {
            id: 'layout',
            title: 'Layout',
            schema: { type: 'object', additionalProperties: true },
        } satisfies PluginSettingsContributionV2['fields'][number];
        const fixture = boundedFixture('daemon', undefined, [objectField]);
        const service = fixture.owner.bind({ model: fixture.model, seed: seed(() => true) });

        // Byte-small but one level deeper than the canonical record depth bound.
        // Only the one Protocol scoped-record validator sees depth; a byte-total
        // transcription cannot refuse this, which is exactly why both scopes
        // must share that validator.
        let deep: JsonValue = '';
        for (let depth = 0; depth < PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1.maximumJsonDepth + 1; depth += 1) {
            deep = { child: deep };
        }
        await expect(service.set('layout', deep))
            .rejects.toMatchObject({ code: 'plugin_settings_values_too_large' });
        expect(fixture.readRecord()).toBeNull();

        // Individually over the per-field canonical-byte ceiling yet far under
        // the record ceiling: only the shared per-field bound refuses it.
        await expect(service.set(
            'layout',
            { x: 'y'.repeat(PLUGIN_ACCOUNT_SETTINGS_LIMITS_V1.maximumFieldEncodedBytes) },
        )).rejects.toMatchObject({ code: 'plugin_settings_values_too_large' });
        expect(fixture.readRecord()).toBeNull();

        await expect(service.set('layout', { mode: 'compact' }))
            .resolves.toEqual({ scope: { kind: 'daemon' }, revision: '1' });
    });

    it('refuses an action patch that grows the record past the canonical record bound', async () => {
        // Eight retained values, each individually inside the per-field bound,
        // leaving the stored record just under the canonical record ceiling.
        const filler = 'y'.repeat(60 * 1024);
        const retained: Record<string, JsonValue> = {};
        for (let index = 0; index < 8; index += 1) retained[`retained${index}`] = filler;
        const fixture = boundedFixture('daemon', retained);

        await expect(fixture.owner.applyActionPatch({
            model: fixture.model,
            seed: seed(() => true),
            contributionId: 'preferences',
            allowedFieldIds: ['endpoint'],
            patch: { endpoint: `https://${'z'.repeat(40 * 1024)}.example` },
        })).rejects.toMatchObject({ code: 'plugin_settings_values_too_large' });
        expect(fixture.readRecord()).toMatchObject({ revision: 4 });

        // A patch that keeps the record inside the same bound still applies.
        await expect(fixture.owner.applyActionPatch({
            model: fixture.model,
            seed: seed(() => true),
            contributionId: 'preferences',
            allowedFieldIds: ['endpoint'],
            patch: { endpoint: 'https://bounded.example' },
        })).resolves.toMatchObject({ revision: '5' });
    });
});
