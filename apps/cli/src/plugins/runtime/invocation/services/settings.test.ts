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
        generation: 'generation-7',
        correlationId: 'correlation-1',
        surface: 'cli',
        signal: controller.signal,
        isGenerationCurrent: current,
    });
}

describe('stable typed settings foundation', () => {
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
        const adapter = {
            // Account plugin Settings must not read host preference roots after
            // the destination record becomes live.
            readSettings: () => Object.freeze({ codexBackendMode: 'acp' }),
            async updateSettings(): Promise<Readonly<Record<string, unknown>>> {
                throw new Error('legacy Account Settings writer must not be called');
            },
            async readRecord() {
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
        const service = createStablePluginSettingsOwner({
            recordStore: createPluginStorageBackedSettingsRecordStore({
                storageForPlugin: () => storage.daemon,
                scope: 'account',
            }),
            broker: createStablePluginEventsBroker(),
        }).bind({ model, seed: seed(() => true) });

        expect(validateStablePluginSettingValue(model, 'endpointByServer', oversized)).toBe(false);
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
