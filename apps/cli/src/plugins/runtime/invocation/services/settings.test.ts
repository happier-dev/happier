import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { PluginSettingsContributionV2 } from '@happier-dev/protocol';
import type { JsonValue } from '@happier-dev/plugin-sdk';

import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createPluginStorageOwner } from '../../context/storage';
import { createStablePluginEventsBroker, type StablePluginEventsBroker } from './events';
import {
    createAccountSettingsBackedSettingsRecordStore,
    createPluginStorageBackedSettingsRecordStore,
    createStablePluginSettingsModel,
    createStablePluginSettingsHost,
    createStablePluginSettingsOwner,
    PLUGIN_SETTINGS_STORAGE_KEY,
    validateStablePluginSettingValue,
} from './settings';
import type { PluginInvocationServicesSeed } from './types';

function declaration(): PluginSettingsContributionV2 {
    return {
        id: 'preferences',
        version: 1,
        title: { key: 'settings.preferences', fallback: 'Preferences' },
        target: { kind: 'plugin' },
        scope: 'local',
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

function seed(current: () => boolean, controller = new AbortController()): PluginInvocationServicesSeed {
    return Object.freeze({
        plugin: Object.freeze({ id: 'acme.plugin', version: '1.0.0' }),
        contribution: Object.freeze({
            id: 'configure',
            qualifiedId: 'acme.plugin/actions/configure',
        }),
        generation: 'generation-7',
        correlationId: 'correlation-1',
        surface: 'cli',
        signal: controller.signal,
        isGenerationCurrent: current,
    });
}

describe('stable typed settings foundation', () => {
    it('persists synced Agent settings at their existing account roots with only revision metadata beside them', async () => {
        let accountSettings: Readonly<Record<string, unknown>> = Object.freeze({
            codexBackendMode: 'appServer',
        });
        const createRecordStore = () => createAccountSettingsBackedSettingsRecordStore({
            readSettings: () => accountSettings,
            async updateSettings(mutate) {
                accountSettings = Object.freeze(mutate(accountSettings));
                return accountSettings;
            },
        });
        const model = createStablePluginSettingsModel({
            pluginId: 'happier.agent.codex',
            contribution: {
                id: 'agent-settings',
                version: 1,
                title: 'Codex settings',
                target: { kind: 'agent', agent: 'codex' },
                scope: 'synced',
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
            revision: '0',
            values: { codexBackendMode: 'appServer' },
        });
        await expect(service.set('codexBackendMode', 'acp', { expectedRevision: '0' }))
            .resolves.toEqual({ revision: '1' });
        expect(accountSettings.codexBackendMode).toBe('acp');
        expect(accountSettings.pluginSettingsStateV1).toEqual({
            'happier.agent.codex': {
                t: 'happier_plugin_settings_record_v1',
                revision: 1,
            },
        });
        expect(JSON.stringify(accountSettings.pluginSettingsStateV1)).not.toContain('"values"');

        const restarted = createStablePluginSettingsOwner({
            recordStore: createRecordStore(),
            broker: createStablePluginEventsBroker(),
        }).bind({ model, seed: seed(() => true) });
        await expect(restarted.snapshot()).resolves.toEqual({
            revision: '1',
            values: { codexBackendMode: 'acp' },
        });
        await expect(restarted.set('codexBackendMode', 'appServer', { expectedRevision: '0' }))
            .rejects.toMatchObject({
                code: 'plugin_settings_revision_conflict',
                details: { currentRevision: '1' },
            });
    });

    it('observes externally committed synced Agent settings without creating a second revision owner', async () => {
        let accountSettings: Readonly<Record<string, unknown>> = Object.freeze({
            codexBackendMode: 'appServer',
            pluginSettingsStateV1: {
                'happier.agent.codex': {
                    t: 'happier_plugin_settings_record_v1',
                    revision: 1,
                },
            },
        });
        const subscribers = new Set<(
            previous: Readonly<Record<string, unknown>>,
            next: Readonly<Record<string, unknown>>,
        ) => void>();
        const recordStore = createAccountSettingsBackedSettingsRecordStore({
            readSettings: () => accountSettings,
            subscribeSettings(listener) {
                subscribers.add(listener);
                return () => subscribers.delete(listener);
            },
            async updateSettings(mutate) {
                const previous = accountSettings;
                accountSettings = Object.freeze(mutate(accountSettings));
                for (const listener of subscribers) listener(previous, accountSettings);
                return accountSettings;
            },
        });
        const model = createStablePluginSettingsModel({
            pluginId: 'happier.agent.codex',
            contribution: {
                id: 'agent-settings',
                version: 1,
                title: 'Codex settings',
                target: { kind: 'agent', agent: 'codex' },
                scope: 'synced',
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

        const previous = accountSettings;
        accountSettings = Object.freeze({
            ...accountSettings,
            codexBackendMode: 'acp',
            pluginSettingsStateV1: {
                'happier.agent.codex': {
                    t: 'happier_plugin_settings_record_v1',
                    revision: 2,
                },
            },
        });
        for (const listener of subscribers) listener(previous, accountSettings);

        await vi.waitFor(() => expect(changes).toEqual([{
            revision: '2',
            changedIds: ['codexBackendMode'],
            values: { codexBackendMode: 'acp' },
        }]));
        await expect(service.set('codexBackendMode', 'appServer', { expectedRevision: '2' }))
            .resolves.toEqual({ revision: '3' });
        await vi.waitFor(() => expect(changes).toEqual([{
            revision: '2',
            changedIds: ['codexBackendMode'],
            values: { codexBackendMode: 'acp' },
        }, {
            revision: '3',
            changedIds: ['codexBackendMode'],
            values: { codexBackendMode: 'appServer' },
        }]));
        await disposable.dispose();
        expect(subscribers.size).toBe(0);
    });

    it('fails closed instead of dropping unsupported or mixed persistence scopes from the stable host', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-settings-scopes-'));
        const recordStore = createPluginStorageBackedSettingsRecordStore({
            storageForPlugin: (pluginId) => createPluginStorageOwner({
                pluginId,
                paths: resolvePluginStorePaths({ happyHomeDir }),
            }).local,
        });
        const projectContribution = { ...declaration(), scope: 'project' as const };
        const projectHost = createStablePluginSettingsHost({
            declarations: [{ pluginId: 'acme.plugin', contribution: projectContribution }],
            recordStore,
            broker: createStablePluginEventsBroker(),
        });

        expect(projectHost.hasPlugin('acme.plugin')).toBe(true);
        const projectService = projectHost.bind(seed(() => true));
        expect(projectService).toBeNull();
        expect(() => createStablePluginSettingsHost({
            declarations: [
                { pluginId: 'acme.plugin', contribution: declaration() },
                { pluginId: 'acme.plugin', contribution: projectContribution },
            ],
            recordStore,
            broker: createStablePluginEventsBroker(),
        })).toThrowError(expect.objectContaining({ code: 'plugin_settings_scope_mixed' }));
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
            recordStore: createPluginStorageBackedSettingsRecordStore({ storageForPlugin: () => storage.local }),
            broker: createStablePluginEventsBroker(),
        }).bind({ model, seed: seed(() => true) });

        expect(service.describe().map((field) => field.id)).toEqual(['endpoint', 'enabled', 'token', 'theme']);
        await expect(service.set('endpoint', 'https://one.example', { expectedRevision: '0' }))
            .resolves.toEqual({ revision: '1' });
        await expect(service.set('theme', 'dark', { expectedRevision: '0' }))
            .rejects.toMatchObject({ code: 'plugin_settings_revision_conflict' });
        await expect(service.set('theme', 'dark', { expectedRevision: '1' }))
            .resolves.toEqual({ revision: '2' });
        await expect(service.snapshot()).resolves.toEqual({
            revision: '2',
            values: { endpoint: 'https://one.example', theme: 'dark' },
        });
        await service.set('enabled', true);
        await expect(service.snapshot()).resolves.toEqual({
            revision: '3',
            values: { endpoint: 'https://one.example', theme: 'dark', enabled: true },
        });
        expect(await storage.local.get(PLUGIN_SETTINGS_STORAGE_KEY)).toEqual({
            t: 'happier_plugin_settings_record_v1',
            revision: 3,
            values: { endpoint: 'https://one.example', theme: 'dark', enabled: true },
        });
        expect(await storage.local.get('typed-settings/preferences')).toBeNull();
        expect(await storage.local.get('typed-settings/appearance')).toBeNull();
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
            .toBe('acme.plugin/settings/preferences%2Ffields%2Flayout/fields/mode');
        expect(nestedField.fields[0]?.qualifiedId)
            .toBe('acme.plugin/settings/preferences/fields/layout%2Ffields%2Fmode');
    });

    it('bounds deeply nested setting values before recursive schema validation', () => {
        const model = createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: {
                ...declaration(),
                fields: [{ id: 'nested', title: 'Nested', schema: { type: 'object' } }],
            },
        });
        let value: JsonValue = {};
        for (let depth = 0; depth < 128; depth += 1) value = { child: value };

        expect(() => validateStablePluginSettingValue(model, 'nested', value))
            .toThrowError(expect.objectContaining({ code: 'plugin_settings_plain_data_bounded' }));
    });

    it('normalizes qualified field identities and rejects accessor-bearing or invalid defaults without reading accessors', () => {
        const model = createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: declaration(),
        });

        expect(model.identity).toEqual({
            pluginId: 'acme.plugin',
            qualifiedId: 'acme.plugin/settings',
        });
        expect(model.descriptors.map((descriptor) => descriptor.id)).toEqual([
            'endpoint',
            'enabled',
            'token',
        ]);
        expect(model.fields.find((field) => field.id === 'endpoint')?.qualifiedId)
            .toBe('acme.plugin/settings/preferences/fields/endpoint');
        expect(model.descriptors[0]).toMatchObject({
            title: 'Endpoint',
            target: { kind: 'plugin' },
            scope: 'local',
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
                scope: 'local',
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
            storageForPlugin: () => storage.local,
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
        await expect(service.snapshot()).resolves.toEqual({ revision: '0', values: {} });
        await expect(service.get('endpoint')).resolves.toBe('https://default.example');
        await expect(service.get('enabled')).resolves.toBe(false);

        await expect(service.set('endpoint', 'https://one.example', { expectedRevision: '0' }))
            .resolves.toEqual({ revision: '1' });
        await vi.waitFor(() => expect(changes).toEqual([{
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
                }).local,
            }),
            broker,
        }).bind({ model, seed: seed(() => true) });
        await expect(restarted.snapshot()).resolves.toEqual({
            revision: '1',
            values: { endpoint: 'https://one.example' },
        });
        await expect(restarted.reset('endpoint', { expectedRevision: '1' }))
            .resolves.toEqual({ revision: '2' });
        await expect(restarted.get('endpoint')).resolves.toBe('https://default.example');

        await expect(service.get('token')).rejects.toMatchObject({
            code: 'plugin_settings_secret_materialization_required',
        });
        await expect(service.set('token', 'must-not-persist')).rejects.toMatchObject({
            code: 'plugin_settings_secret_materialization_required',
        });
        expect(await storage.local.get(PLUGIN_SETTINGS_STORAGE_KEY)).toEqual({
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
                    settings: { pluginId: 'acme.plugin' },
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
                generation: 'generation-8',
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
                storageForPlugin: () => storage.local,
            }),
            broker: createStablePluginEventsBroker(),
        }).bind({ model, seed: seed(() => true) });
        const peerService = createStablePluginSettingsOwner({
            recordStore: createPluginStorageBackedSettingsRecordStore({
                storageForPlugin: () => createPluginStorageOwner({
                    pluginId: 'acme.plugin',
                    paths: resolvePluginStorePaths({ happyHomeDir }),
                }).local,
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

        await storage.local.set(PLUGIN_SETTINGS_STORAGE_KEY, {
            t: 'happier_plugin_settings_record_v1',
            revision: 2,
            values: { token: 'leaked-secret' },
        });
        await expect(service.snapshot()).rejects.toMatchObject({
            code: 'plugin_settings_record_invalid',
        });

        const projectModel = createStablePluginSettingsModel({
            pluginId: 'acme.plugin',
            contribution: { ...declaration(), scope: 'project', fields: [] },
        });
        const projectService = createStablePluginSettingsOwner({
            recordStore: createPluginStorageBackedSettingsRecordStore({
                storageForPlugin: () => storage.local,
            }),
            broker: createStablePluginEventsBroker(),
        }).bind({ model: projectModel, seed: seed(() => true) });
        await expect(projectService.snapshot()).rejects.toMatchObject({
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
            storageForPlugin: () => storage.local,
        });
        const first = createStablePluginSettingsOwner({
            recordStore,
            broker: failingBroker,
        }).bind({ model, seed: seed(() => true) });

        await expect(first.set('endpoint', 'https://durable.example', { expectedRevision: '0' }))
            .resolves.toEqual({ revision: '1' });
        expect(await storage.local.get(PLUGIN_SETTINGS_STORAGE_KEY)).toEqual({
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
