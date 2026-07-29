import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockServerFetch } = vi.hoisted(() => ({
    mockServerFetch: vi.fn(),
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: (...args: any[]) => mockServerFetch(...args),
}));

import {
    machineClearReplacementFromAccount,
    machineReplaceInAccount,
    machineRevokeFromAccount,
    machineRevokeWithProviderCleanup,
} from './machineAccount';
import {
    DEFAULT_PROVIDER_SETTINGS_V1,
    ProviderSettingsV1Schema,
    readOwnRecordValue,
} from '@happier-dev/protocol';

function makeResponse(opts: Readonly<{ ok: boolean; status?: number; json?: unknown; text?: string }>) {
    return {
        ok: opts.ok,
        status: opts.status ?? (opts.ok ? 200 : 500),
        json: async () => opts.json ?? {},
        text: async () => opts.text ?? '',
        headers: new Map(),
    } as any;
}

describe('machineRevokeFromAccount', () => {
    beforeEach(() => {
        mockServerFetch.mockReset();
    });

    it('posts to the revoke endpoint', async () => {
        mockServerFetch.mockResolvedValue(makeResponse({ ok: true }));

        await expect(machineRevokeFromAccount('m1')).resolves.toEqual({ ok: true });
        expect(mockServerFetch).toHaveBeenCalledWith(
            '/v1/machines/m1/revoke',
            expect.objectContaining({ method: 'POST' }),
        );
    });

    it('returns a structured error when the server rejects the request', async () => {
        mockServerFetch.mockResolvedValue(makeResponse({ ok: false, status: 410, json: { error: 'machine_revoked' } }));

        await expect(machineRevokeFromAccount('m1')).resolves.toEqual({
            ok: false,
            status: 410,
            error: 'machine_revoked',
        });
    });
});

describe('machineRevokeWithProviderCleanup', () => {
    it('removes only the revoked machine Provider state through the settings CAS owner', async () => {
        let settings = ProviderSettingsV1Schema.parse({
            ...DEFAULT_PROVIDER_SETTINGS_V1,
            connections: [{
                v: 1, id: 'pc_a', source: { kind: 'custom', template: {
                    v: 1, name: 'Local', endpointTemplates: [{
                        id: 'chat', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1234/v1',
                        capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
                    }], catalog: { source: 'manual', manualModelPolicy: 'allowed' },
                } }, role: 'named', displayName: 'Local', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1,
                endpointOverridesByMachineId: {
                    revoked: [{ endpointTemplateId: 'chat', baseUrl: 'http://127.0.0.1:1234/v1' }],
                    kept: [{ endpointTemplateId: 'chat', baseUrl: 'http://127.0.0.1:2234/v1' }],
                },
            }],
            machineGrants: [{
                v: 1, machineId: 'revoked', connectionId: 'pc_a',
                endpointSetFingerprint: 'endpoint-set:v1:a', connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1,
            }],
            secretBindingsByConnectionId: { pc_a: { byMachineId: { revoked: { apiKey: 'secret-a' }, kept: { apiKey: 'secret-b' } } } },
        });
        const mutateProviderSettings = vi.fn(async (mutate: (current: typeof settings) => typeof settings) => {
            settings = mutate(settings);
        });
        await expect(machineRevokeWithProviderCleanup('revoked', {
            revoke: vi.fn(async () => ({ ok: true as const })),
            mutateProviderSettings,
        })).resolves.toEqual({ ok: true, machineAlreadyRevoked: false, providerCleanup: 'complete' });
        expect(settings.machineGrants).toEqual([]);
        expect(settings.connections[0]?.endpointOverridesByMachineId).toEqual({
            kept: [{ endpointTemplateId: 'chat', baseUrl: 'http://127.0.0.1:2234/v1' }],
        });
        expect(readOwnRecordValue(settings.secretBindingsByConnectionId, 'pc_a')?.byMachineId)
            .toEqual({ kept: { apiKey: 'secret-b' } });
    });

    it('reports a retryable partial failure after server revocation and treats retry as idempotent', async () => {
        const settings = ProviderSettingsV1Schema.parse({
            ...DEFAULT_PROVIDER_SETTINGS_V1,
            connections: [{
                v: 1, id: 'pc_a', source: { kind: 'custom', template: {
                    v: 1, name: 'Local', endpointTemplates: [{
                        id: 'chat', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1234/v1',
                        capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
                    }], catalog: { source: 'manual', manualModelPolicy: 'allowed' },
                } }, role: 'named', displayName: 'Local', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1,
                endpointOverridesByMachineId: {
                    revoked: [{ endpointTemplateId: 'chat', baseUrl: 'http://127.0.0.1:2234/v1' }],
                },
            }],
        });
        const mutateProviderSettings = vi.fn()
            .mockRejectedValueOnce(new Error('offline'))
            .mockImplementationOnce(async (mutate: (current: typeof settings) => typeof settings) => {
                mutate(settings);
            });
        const revoke = vi.fn()
            .mockResolvedValueOnce({ ok: true })
            .mockResolvedValueOnce({ ok: false, status: 410, error: 'machine_revoked' });
        const deps = { revoke, mutateProviderSettings };
        await expect(machineRevokeWithProviderCleanup('revoked', deps)).resolves.toEqual({
            ok: false, status: 503, error: 'provider_cleanup_pending', machineRevoked: true, providerCleanup: 'pending', retryable: true,
        });
        await expect(machineRevokeWithProviderCleanup('revoked', deps)).resolves.toEqual({
            ok: true, machineAlreadyRevoked: true, providerCleanup: 'complete',
        });
    });

    it('recomputes cleanup against the canonical CAS winner and preserves concurrent Provider changes', async () => {
        const initial = ProviderSettingsV1Schema.parse({
            ...DEFAULT_PROVIDER_SETTINGS_V1,
            connections: [{
                v: 1, id: 'pc_a', source: { kind: 'custom', template: {
                    v: 1, name: 'Local', endpointTemplates: [{
                        id: 'chat', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1234/v1',
                        capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
                    }], catalog: { source: 'manual', manualModelPolicy: 'allowed' },
                } }, role: 'named', displayName: 'Local', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1,
            }],
            machineGrants: [{
                v: 1, machineId: 'revoked', connectionId: 'pc_a',
                endpointSetFingerprint: 'endpoint-set:v1:a', connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1,
            }],
        });
        const concurrentWinner = ProviderSettingsV1Schema.parse({
            ...initial,
            manualModelsByConnectionId: {
                pc_a: [{ id: 'concurrent/model', addedAt: 9 }],
            },
        });
        let committed = initial;
        const mutateProviderSettings = vi.fn(async (mutate: (current: typeof initial) => typeof initial) => {
            mutate(initial); // first CAS candidate loses to the concurrent writer
            committed = mutate(concurrentWinner); // retry must derive from the winner
        });

        await expect(machineRevokeWithProviderCleanup('revoked', {
            revoke: vi.fn(async () => ({ ok: true as const })),
            mutateProviderSettings,
        })).resolves.toEqual({
            ok: true, machineAlreadyRevoked: false, providerCleanup: 'complete',
        });
        expect(committed.machineGrants).toEqual([]);
        expect(readOwnRecordValue(committed.manualModelsByConnectionId, 'pc_a')).toEqual([
            { id: 'concurrent/model', addedAt: 9 },
        ]);
    });
});

describe('machineReplaceInAccount', () => {
    beforeEach(() => {
        mockServerFetch.mockReset();
    });

    it('posts an explicit replacement machine id to the replacement endpoint as json', async () => {
        mockServerFetch.mockResolvedValue(makeResponse({ ok: true }));

        await expect(machineReplaceInAccount({
            oldMachineId: 'm-old',
            replacementMachineId: 'm-new',
            confirmActiveOldMachine: true,
        })).resolves.toEqual({ ok: true });
        expect(mockServerFetch).toHaveBeenCalledWith(
            '/v1/machines/m-old/replacement',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'Content-Type': 'application/json',
                }),
                body: JSON.stringify({
                    replacementMachineId: 'm-new',
                    confirmActiveOldMachine: true,
                }),
            }),
        );
    });

    it('requires both machine ids before posting a replacement', async () => {
        await expect(machineReplaceInAccount({
            oldMachineId: 'm-old',
            replacementMachineId: ' ',
        })).resolves.toEqual({ ok: false, status: 400, error: 'replacement_machine_id_required' });
        expect(mockServerFetch).not.toHaveBeenCalled();
    });
});

describe('machineClearReplacementFromAccount', () => {
    beforeEach(() => {
        mockServerFetch.mockReset();
    });

    it('deletes the replacement relation for a machine', async () => {
        mockServerFetch.mockResolvedValue(makeResponse({ ok: true }));

        await expect(machineClearReplacementFromAccount('m-old')).resolves.toEqual({ ok: true });
        expect(mockServerFetch).toHaveBeenCalledWith(
            '/v1/machines/m-old/replacement',
            expect.objectContaining({ method: 'DELETE' }),
        );
    });
});
