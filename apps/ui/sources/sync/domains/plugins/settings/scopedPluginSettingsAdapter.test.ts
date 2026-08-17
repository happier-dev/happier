import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
    createAccountScopedPluginSettingsTransport,
    createScopedPluginSettingsAdapter,
    readScopedPluginSettingValue,
    resolveScopedPluginSettingsTarget,
    resolveScopedPluginSettingMutation,
} from './scopedPluginSettingsAdapter';
import type {
    MachinePluginSecretSetResult,
    MachinePluginSecretStatusResult,
} from '@/sync/ops/machineContributionRegistryProjection';

describe('scoped plugin Settings adapter', () => {
    it('routes an origin-bound daemon secret through the scoped adapter, preserves its exact origin, and performs one readback without replay after an unknown SET outcome', async () => {
        const daemonSecretStatus = vi.fn(async () => ({
            supported: true as const,
            result: {
                protocolVersion: 1 as const,
                pluginId: 'acme.settings',
                secretId: 'apiToken',
                state: 'configured' as const,
                revision: 'origin-8',
            },
        } satisfies Extract<MachinePluginSecretStatusResult, { supported: true }>));
        const daemonSecretSet = vi.fn(async () => ({
            supported: false as const,
            reason: 'outcomeUnknown' as const,
        } satisfies MachinePluginSecretSetResult));
        const dependencies = {
            daemonGet: vi.fn(),
            daemonSet: vi.fn(),
            accountRead: vi.fn(),
            accountWrite: vi.fn(),
            daemonSecretStatus,
            daemonSecretSet,
            daemonSecretDelete: vi.fn(),
        };
        const adapter = createScopedPluginSettingsAdapter(dependencies);
        const daemonSecret = adapter.daemonSecret;
        const target = {
            kind: 'daemon' as const,
            serverIdentityId: 'server-identity-b',
            machineId: 'machine-b',
            serverId: 'local-profile-b',
        };
        if (!daemonSecret) throw new Error('daemon-secret adapter was not installed');
        await expect(daemonSecret.write({
            pluginId: 'acme.settings',
            target,
            secretId: 'apiToken',
            canonicalOrigin: 'https://api.example.test',
            expectedRevision: 'origin-7',
            mutation: { kind: 'set', value: 'raw-secret-only-at-the-boundary' },
        })).resolves.toEqual({
            status: 'outcomeUnknown',
            snapshot: {
                target,
                pluginId: 'acme.settings',
                secretId: 'apiToken',
                state: 'configured',
                revision: 'origin-8',
            },
        });
        expect(daemonSecretSet).toHaveBeenCalledOnce();
        expect(daemonSecretSet).toHaveBeenCalledWith('machine-b', {
            serverId: 'local-profile-b',
            serverIdentityId: 'server-identity-b',
            pluginId: 'acme.settings',
            secretId: 'apiToken',
            canonicalOrigin: 'https://api.example.test',
            expectedRevision: 'origin-7',
            value: 'raw-secret-only-at-the-boundary',
        });
        expect(daemonSecretStatus).toHaveBeenCalledOnce();
        expect(daemonSecretStatus).toHaveBeenCalledWith('machine-b', {
            serverId: 'local-profile-b',
            serverIdentityId: 'server-identity-b',
            pluginId: 'acme.settings',
            secretId: 'apiToken',
            canonicalOrigin: 'https://api.example.test',
        });
    });

    it('routes daemon reads and writes only through the exact selected daemon target', async () => {
        const daemonGet = vi.fn(async () => ({
            supported: true as const,
            snapshot: {
                protocolVersion: 1 as const,
                pluginId: 'acme.settings',
                scope: { kind: 'daemon' as const },
                revision: '7',
                values: { endpoint: 'https://daemon.example.test' },
                redactedKeys: [],
            },
        }));
        const daemonSet = vi.fn(async () => ({
            supported: true as const,
            result: {
                status: 'applied' as const,
                snapshot: {
                    protocolVersion: 1 as const,
                    pluginId: 'acme.settings',
                    scope: { kind: 'daemon' as const },
                    revision: '8',
                    values: { endpoint: 'https://updated.example.test' },
                    redactedKeys: [],
                },
            },
        }));
        const accountRead = vi.fn();
        const accountWrite = vi.fn();
        const adapter = createScopedPluginSettingsAdapter({
            daemonGet,
            daemonSet,
            accountRead,
            accountWrite,
        });
        const target = {
            kind: 'daemon' as const,
            serverIdentityId: 'server-identity-b',
            machineId: 'machine-b',
            serverId: 'local-profile-b',
        };

        const read = await adapter.read({
            pluginId: 'acme.settings',
            scope: { kind: 'daemon' },
            target,
            fields: [{ key: 'endpoint', redacted: false }],
        });
        expect(read).toEqual(expect.objectContaining({
            status: 'ready',
            snapshot: expect.objectContaining({
                revision: { kind: 'daemon', value: '7' },
                values: { endpoint: 'https://daemon.example.test' },
            }),
        }));
        expect(daemonGet).toHaveBeenCalledWith('machine-b', {
            serverId: 'local-profile-b',
            serverIdentityId: 'server-identity-b',
            pluginId: 'acme.settings',
        });
        expect(accountRead).not.toHaveBeenCalled();

        const write = await adapter.write({
            pluginId: 'acme.settings',
            scope: { kind: 'daemon' },
            target,
            fields: [{ key: 'endpoint', redacted: false }],
            fieldId: 'endpoint',
            mutation: { kind: 'set', value: 'https://updated.example.test' },
            expectedRevision: { kind: 'daemon', value: '7' },
        });
        expect(write).toEqual(expect.objectContaining({ status: 'ready' }));
        expect(daemonSet).toHaveBeenCalledWith('machine-b', {
            serverId: 'local-profile-b',
            serverIdentityId: 'server-identity-b',
            pluginId: 'acme.settings',
            fieldId: 'endpoint',
            mutation: { kind: 'set', value: 'https://updated.example.test' },
            expectedRevision: '7',
        });
        expect(accountWrite).not.toHaveBeenCalled();
    });

    it('projects an acknowledged daemon CAS conflict without retrying or reclassifying it as applied', async () => {
        const daemonGet = vi.fn();
        const daemonSet = vi.fn(async () => ({
            supported: true as const,
            result: {
                status: 'conflict' as const,
                snapshot: {
                    protocolVersion: 1 as const,
                    pluginId: 'acme.settings',
                    scope: { kind: 'daemon' as const },
                    revision: '8',
                    values: { endpoint: 'https://newer.example.test' },
                    redactedKeys: [],
                },
            },
        }));
        const adapter = createScopedPluginSettingsAdapter({
            daemonGet,
            daemonSet,
            accountRead: vi.fn(),
            accountWrite: vi.fn(),
        });
        const target = {
            kind: 'daemon' as const,
            serverIdentityId: 'server-identity-b',
            machineId: 'machine-b',
            serverId: 'local-profile-b',
        };

        await expect(adapter.write({
            pluginId: 'acme.settings',
            scope: { kind: 'daemon' },
            target,
            fields: [{ key: 'endpoint', redacted: false }],
            fieldId: 'endpoint',
            mutation: { kind: 'set', value: 'https://lost-update.example.test' },
            expectedRevision: { kind: 'daemon', value: '7' },
        })).resolves.toEqual({
            status: 'conflict',
            snapshot: {
                scope: { kind: 'daemon' },
                target,
                revision: { kind: 'daemon', value: '8' },
                values: { endpoint: 'https://newer.example.test' },
            },
        });
        expect(daemonSet).toHaveBeenCalledOnce();
        expect(daemonGet).not.toHaveBeenCalled();
    });

    it('performs one safe daemon readback for an issued SET with an unknown outcome and never replays it', async () => {
        const daemonGet = vi.fn(async () => ({
            supported: true as const,
            snapshot: {
                protocolVersion: 1 as const,
                pluginId: 'acme.settings',
                scope: { kind: 'daemon' as const },
                revision: '8',
                values: { endpoint: 'https://possibly-applied.example.test' },
                redactedKeys: [],
            },
        }));
        const daemonSet = vi.fn(async () => ({
            supported: false as const,
            reason: 'outcomeUnknown' as const,
        }));
        const adapter = createScopedPluginSettingsAdapter({
            daemonGet,
            daemonSet,
            accountRead: vi.fn(),
            accountWrite: vi.fn(),
        });
        const target = {
            kind: 'daemon' as const,
            serverIdentityId: 'server-identity-b',
            machineId: 'machine-b',
            serverId: 'local-profile-b',
        };

        await expect(adapter.write({
            pluginId: 'acme.settings',
            scope: { kind: 'daemon' },
            target,
            fields: [{ key: 'endpoint', redacted: false }],
            fieldId: 'endpoint',
            mutation: { kind: 'set', value: 'https://possibly-applied.example.test' },
            expectedRevision: { kind: 'daemon', value: '7' },
        })).resolves.toEqual({
            status: 'outcomeUnknown',
            snapshot: {
                scope: { kind: 'daemon' },
                target,
                revision: { kind: 'daemon', value: '8' },
                values: { endpoint: 'https://possibly-applied.example.test' },
            },
        });
        expect(daemonSet).toHaveBeenCalledOnce();
        expect(daemonGet).toHaveBeenCalledOnce();
        expect(daemonGet).toHaveBeenCalledWith('machine-b', {
            serverId: 'local-profile-b',
            serverIdentityId: 'server-identity-b',
            pluginId: 'acme.settings',
        });
    });

    it('does not read back or replay a SET that failed before issuance', async () => {
        const daemonGet = vi.fn();
        const daemonSet = vi.fn(async () => ({
            supported: false as const,
            reason: 'error' as const,
        }));
        const adapter = createScopedPluginSettingsAdapter({
            daemonGet,
            daemonSet,
            accountRead: vi.fn(),
            accountWrite: vi.fn(),
        });

        await expect(adapter.write({
            pluginId: 'acme.settings',
            scope: { kind: 'daemon' },
            target: {
                kind: 'daemon',
                serverIdentityId: 'server-identity-b',
                machineId: 'machine-b',
                serverId: 'local-profile-b',
            },
            fields: [{ key: 'endpoint', redacted: false }],
            fieldId: 'endpoint',
            mutation: { kind: 'set', value: 'https://not-issued.example.test' },
            expectedRevision: { kind: 'daemon', value: '7' },
        })).resolves.toEqual({ status: 'unavailable', reason: 'transport' });
        expect(daemonSet).toHaveBeenCalledOnce();
        expect(daemonGet).not.toHaveBeenCalled();
    });

    it('rejects a mismatched daemon snapshot instead of falling through to Account Settings', async () => {
        const daemonGet = vi.fn(async () => ({
            supported: true as const,
            snapshot: {
                protocolVersion: 1 as const,
                pluginId: 'acme.other',
                scope: { kind: 'daemon' as const },
                revision: '7',
                values: { endpoint: 'wrong-record' },
                redactedKeys: [],
            },
        }));
        const accountRead = vi.fn();
        const adapter = createScopedPluginSettingsAdapter({
            daemonGet,
            daemonSet: vi.fn(),
            accountRead,
            accountWrite: vi.fn(),
        });

        await expect(adapter.read({
            pluginId: 'acme.settings',
            scope: { kind: 'daemon' },
            target: {
                kind: 'daemon',
                serverIdentityId: 'server-identity-b',
                machineId: 'machine-b',
                serverId: 'local-profile-b',
            },
            fields: [{ key: 'endpoint', redacted: false }],
        })).resolves.toEqual({ status: 'unavailable', reason: 'scope-mismatch' });
        expect(accountRead).not.toHaveBeenCalled();
    });

    it('fails closed when the daemon target has no portable server identity', async () => {
        const daemonGet = vi.fn();
        const adapter = createScopedPluginSettingsAdapter({
            daemonGet,
            daemonSet: vi.fn(),
            accountRead: vi.fn(),
            accountWrite: vi.fn(),
        });

        await expect(adapter.read({
            pluginId: 'acme.settings',
            scope: { kind: 'daemon' },
            target: {
                kind: 'daemon',
                serverIdentityId: '',
                machineId: 'machine-b',
                serverId: 'local-profile-b',
            },
            fields: [{ key: 'endpoint', redacted: false }],
        })).resolves.toEqual({ status: 'unavailable', reason: 'target-mismatch' });
        expect(daemonGet).not.toHaveBeenCalled();
    });

    it('keeps an Account target independent when the selected daemon target is unavailable', () => {
        expect(resolveScopedPluginSettingsTarget({
            scope: { kind: 'account' },
            serverIdentityId: 'account-server-identity',
            machineId: null,
            serverId: null,
        })).toEqual({
            kind: 'account',
            serverIdentityId: 'account-server-identity',
        });
        expect(resolveScopedPluginSettingsTarget({
            scope: { kind: 'daemon' },
            serverIdentityId: 'daemon-server-identity',
            machineId: null,
            serverId: null,
        })).toBeNull();
    });

    it('keeps host Settings renderers behind the scoped adapter boundary', () => {
        const genericRenderer = readFileSync(new URL(
            '../../../../components/settings/plugins/detail/PluginDetailGenericSettingsSection.tsx',
            import.meta.url,
        ), 'utf8');
        const declarativeRenderer = readFileSync(new URL(
            '../../../../components/plugins/surfaces/DeclarativePluginSurface.tsx',
            import.meta.url,
        ), 'utf8');

        for (const source of [genericRenderer, declarativeRenderer]) {
            expect(source).not.toContain('machinePluginSettingsGet');
            expect(source).not.toContain('machinePluginSettingsSet');
            expect(source).not.toContain('usePrimaryMachineFromActiveSelection');
            expect(source).not.toContain('primaryMachineId');
        }
    });

    it('keeps host-private SavedSecret binding intents out of generic Account and daemon record writers', async () => {
        const daemonSet = vi.fn();
        const accountWrite = vi.fn();
        const adapter = createScopedPluginSettingsAdapter({
            daemonGet: vi.fn(),
            daemonSet,
            accountRead: vi.fn(),
            accountWrite,
        });

        await expect(adapter.write({
            pluginId: 'acme.settings',
            scope: { kind: 'account' },
            target: { kind: 'account', serverIdentityId: 'server-identity-a' },
            fields: [{ key: 'apiToken', redacted: true }],
            fieldId: 'apiToken',
            mutation: { kind: 'bind', savedSecretId: 'opaque-saved-secret-id' },
            expectedRevision: { kind: 'account', value: 3 },
        })).resolves.toEqual({ status: 'unavailable', reason: 'scope-mismatch' });
        await expect(adapter.write({
            pluginId: 'acme.settings',
            scope: { kind: 'daemon' },
            target: {
                kind: 'daemon',
                serverIdentityId: 'server-identity-a',
                machineId: 'machine-a',
                serverId: 'profile-a',
            },
            fields: [{ key: 'apiToken', redacted: true }],
            fieldId: 'apiToken',
            mutation: { kind: 'unbind' },
            expectedRevision: { kind: 'daemon', value: '3' },
        })).resolves.toEqual({ status: 'unavailable', reason: 'scope-mismatch' });

        expect(accountWrite).not.toHaveBeenCalled();
        expect(daemonSet).not.toHaveBeenCalled();
    });

    it('uses the exact canonical server identity for per-active-server bindings', () => {
        const field = {
            key: 'endpoint',
            redacted: false,
            binding: {
                kind: 'perActiveServer' as const,
                byServerIdSettingId: 'endpointByServer',
                fallbackSettingId: 'endpointDefault',
            },
        };
        const values = {
            endpointDefault: 'https://default.example.test',
            endpointByServer: {
                'server-identity-b': 'https://server-b.example.test',
                'local-profile-b': 'must-not-be-read',
            },
        };

        expect(readScopedPluginSettingValue({
            values,
            field,
            serverIdentityId: 'server-identity-b',
        })).toBe('https://server-b.example.test');
        expect(resolveScopedPluginSettingMutation({
            values,
            field,
            serverIdentityId: 'server-identity-b',
            value: 'https://next.example.test',
        })).toEqual({
            fieldId: 'endpointByServer',
            value: {
                'server-identity-b': 'https://next.example.test',
                'local-profile-b': 'must-not-be-read',
            },
        });
    });

    it('keeps an empty per-active-server value as explicit data', () => {
        const field = {
            key: 'endpoint',
            redacted: false,
            binding: {
                kind: 'perActiveServer' as const,
                byServerIdSettingId: 'endpointByServer',
                fallbackSettingId: 'endpointDefault',
            },
        };

        expect(resolveScopedPluginSettingMutation({
            values: {
                endpointDefault: 'https://default.example.test',
                endpointByServer: {
                    'server-identity-b': 'https://server-b.example.test',
                },
            },
            field,
            serverIdentityId: 'server-identity-b',
            value: '',
        })).toEqual({
            fieldId: 'endpointByServer',
            value: { 'server-identity-b': '' },
        });
    });

    it('fails closed on oversized per-active-server maps before projecting or writing an Account record', async () => {
        const oversizedByServer = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [
            `server-identity-${index}`,
            `https://server-${index}.example.test`,
        ]));
        const fields = [{
            key: 'endpoint',
            redacted: false,
            binding: {
                kind: 'perActiveServer' as const,
                byServerIdSettingId: 'endpointByServer',
                fallbackSettingId: 'endpointDefault',
            },
        }];
        const target = { kind: 'account' as const, serverIdentityId: 'server-identity-a' };
        const oversizedRecord = createAccountScopedPluginSettingsTransport({
            readRecord: vi.fn(async () => ({
                status: 'present' as const,
                revision: 3,
                values: {
                    endpointDefault: 'https://default.example.test',
                    endpointByServer: oversizedByServer,
                },
            })),
            writeRecord: vi.fn(),
        });

        await expect(oversizedRecord.read({
            pluginId: 'acme.settings',
            target,
            fields,
        })).resolves.toEqual({ status: 'unavailable', reason: 'invalid-value' });

        const writeRecord = vi.fn(async () => ({ status: 'updated' as const, revision: 1 }));
        const writableRecord = createAccountScopedPluginSettingsTransport({
            readRecord: vi.fn(async () => ({ status: 'absent' as const })),
            writeRecord,
        });

        await expect(writableRecord.write({
            pluginId: 'acme.settings',
            target,
            fields,
            fieldId: 'endpointByServer',
            mutation: { kind: 'set', value: oversizedByServer },
            expectedRevision: { kind: 'account', value: 'absent' },
        })).resolves.toEqual({ status: 'unavailable', reason: 'invalid-value' });
        expect(writeRecord).not.toHaveBeenCalled();
    });

    it('merges an Account field through one CAS write while keeping raw and secret values out of the snapshot', async () => {
        const readRecord = vi.fn(async () => ({
            status: 'present' as const,
            revision: 6,
            values: {
                endpoint: 'https://before.example.test',
                apiToken: 'raw-secret-must-not-reach-rendering',
                retainedUnknownValue: { preserved: true },
            },
        }));
        const writeRecord = vi.fn(async () => ({ status: 'updated' as const, revision: 7 }));
        const account = createAccountScopedPluginSettingsTransport({ readRecord, writeRecord });
        const target = { kind: 'account' as const, serverIdentityId: 'server-identity-a' };

        const result = await account.write({
            pluginId: 'acme.settings',
            target,
            fields: [
                { key: 'endpoint', redacted: false },
                { key: 'apiToken', redacted: true },
            ],
            fieldId: 'endpoint',
            mutation: { kind: 'set', value: 'https://after.example.test' },
            expectedRevision: { kind: 'account', value: 6 },
        });

        expect(writeRecord).toHaveBeenCalledWith({
            pluginId: 'acme.settings',
            target,
            expectedRevision: 6,
            values: {
                endpoint: 'https://after.example.test',
                apiToken: 'raw-secret-must-not-reach-rendering',
                retainedUnknownValue: { preserved: true },
            },
        });
        expect(result).toEqual({
            status: 'ready',
            snapshot: {
                scope: { kind: 'account' },
                target,
                revision: { kind: 'account', value: 7 },
                values: { endpoint: 'https://after.example.test' },
            },
        });
    });

    it('performs one safe Account record readback after a possibly applied write without replaying it', async () => {
        const readRecord = vi.fn()
            .mockResolvedValueOnce({
                status: 'present' as const,
                revision: 6,
                values: { endpoint: 'https://before.example.test' },
            })
            .mockResolvedValueOnce({
                status: 'present' as const,
                revision: 7,
                values: { endpoint: 'https://possibly-applied.example.test' },
            });
        const writeRecord = vi.fn(async () => ({ status: 'outcomeUnknown' as const }));
        const account = createAccountScopedPluginSettingsTransport({ readRecord, writeRecord });
        const target = { kind: 'account' as const, serverIdentityId: 'server-identity-a' };

        await expect(account.write({
            pluginId: 'acme.settings',
            target,
            fields: [{ key: 'endpoint', redacted: false }],
            fieldId: 'endpoint',
            mutation: { kind: 'set', value: 'https://possibly-applied.example.test' },
            expectedRevision: { kind: 'account', value: 6 },
        })).resolves.toEqual({
            status: 'outcomeUnknown',
            snapshot: {
                scope: { kind: 'account' },
                target,
                revision: { kind: 'account', value: 7 },
                values: { endpoint: 'https://possibly-applied.example.test' },
            },
        });
        expect(writeRecord).toHaveBeenCalledOnce();
        expect(readRecord).toHaveBeenCalledTimes(2);
    });

    it('returns an explicit conflict snapshot for a stale Account revision without replaying the field mutation', async () => {
        const readRecord = vi.fn(async () => ({
            status: 'present' as const,
            revision: 8,
            values: { endpoint: 'https://newer.example.test' },
        }));
        const writeRecord = vi.fn();
        const account = createAccountScopedPluginSettingsTransport({ readRecord, writeRecord });

        await expect(account.write({
            pluginId: 'acme.settings',
            target: { kind: 'account', serverIdentityId: 'server-identity-a' },
            fields: [{ key: 'endpoint', redacted: false }],
            fieldId: 'endpoint',
            mutation: { kind: 'set', value: 'https://lost-update.example.test' },
            expectedRevision: { kind: 'account', value: 7 },
        })).resolves.toEqual({
            status: 'conflict',
            snapshot: {
                scope: { kind: 'account' },
                target: { kind: 'account', serverIdentityId: 'server-identity-a' },
                revision: { kind: 'account', value: 8 },
                values: { endpoint: 'https://newer.example.test' },
            },
        });
        expect(writeRecord).not.toHaveBeenCalled();
    });

    it('returns a refreshed conflict snapshot after one Account CAS rejection without replaying', async () => {
        const readRecord = vi.fn()
            .mockResolvedValueOnce({
                status: 'present' as const,
                revision: 7,
                values: { endpoint: 'https://before.example.test' },
            })
            .mockResolvedValueOnce({
                status: 'present' as const,
                revision: 8,
                values: { endpoint: 'https://newer.example.test' },
            });
        const writeRecord = vi.fn(async () => ({ status: 'conflict' as const, revision: 8 }));
        const account = createAccountScopedPluginSettingsTransport({ readRecord, writeRecord });

        await expect(account.write({
            pluginId: 'acme.settings',
            target: { kind: 'account', serverIdentityId: 'server-identity-a' },
            fields: [{ key: 'endpoint', redacted: false }],
            fieldId: 'endpoint',
            mutation: { kind: 'set', value: 'https://lost-update.example.test' },
            expectedRevision: { kind: 'account', value: 7 },
        })).resolves.toEqual({
            status: 'conflict',
            snapshot: {
                scope: { kind: 'account' },
                target: { kind: 'account', serverIdentityId: 'server-identity-a' },
                revision: { kind: 'account', value: 8 },
                values: { endpoint: 'https://newer.example.test' },
            },
        });
        expect(writeRecord).toHaveBeenCalledTimes(1);
    });
});
