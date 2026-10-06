import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    openSavedSecretResourceStoredContentV1,
    sealSavedSecretResourceStoredContentV1,
} from '@happier-dev/protocol';

const { requestHomeDomain, readSavedSecretCatalog, mutateAccountSettingsOnce, runTeamAction, encryptDataKeyForRecipientV0, syncEncryption } = vi.hoisted(() => ({
    requestHomeDomain: vi.fn(),
    readSavedSecretCatalog: vi.fn(),
    mutateAccountSettingsOnce: vi.fn(),
    runTeamAction: vi.fn(),
    encryptDataKeyForRecipientV0: vi.fn((_dataKey: Uint8Array, _recipientPublicKey: string) => 'wrapped-key'),
    syncEncryption: { current: null as null | Readonly<{
        contentDataKey: Uint8Array;
        decryptEncryptionKey: (value: string, scope: unknown) => Promise<Uint8Array | null>;
    }> },
}));

vi.mock('@/sync/api/home/homeServerActionTransport', () => ({ requestHomeDomain }));
vi.mock('@/sync/api/account/apiSavedSecretCatalog', () => ({ readSavedSecretCatalog }));
vi.mock('@/sync/ops/teams/teamActionClient', () => ({
    runTeamAction,
    isTeamActionApprovalPendingError: (value: unknown) => (
        value instanceof Error && value.name === 'TeamActionApprovalPendingError'
    ),
}));
vi.mock('@/sync/encryption/directShareEncryption', () => ({ encryptDataKeyForRecipientV0 }));
vi.mock('@/sync/runtime/getSyncSingleton', () => ({
    getSyncSingleton: () => ({ mutateAccountSettingsOnce, decryptSecretValue: () => 'personal-value', encryption: syncEncryption.current }),
}));
vi.mock('@/platform/randomUUID', () => ({ randomUUID: () => 'resource-promoted' }));

describe('savedSecretResourceOperations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        syncEncryption.current = null;
    });

    it('creates an owner-only Plain resource without copying a personal secret', async () => {
        runTeamAction.mockResolvedValueOnce({
            kind: 'succeeded',
            value: { resourceId: 'resource-promoted', revision: 1 },
        });

        const { createSavedSecretResource } = await import('./savedSecretResourceOperations');
        await expect(createSavedSecretResource({
            scope: { serverId: 'home-a', accountId: 'owner-a' },
            name: 'Deploy token',
            kind: 'token',
            value: 'token-value',
            accountGrants: [],
            teamGrants: [],
            groupGrants: [],
        })).resolves.toEqual({
            ok: true,
            resourceRef: 'happier:shared-secret:v1:resource-promoted',
            revision: 1,
        });

        expect(runTeamAction).toHaveBeenCalledWith(expect.objectContaining({
            actionId: 'secrets.shared.create',
            input: {
                resourceId: 'resource-promoted',
                displayName: 'Deploy token',
                kind: 'token',
                encryptionMode: 'plain',
                storedContent: {
                    t: 'plain',
                    v: { v: 1, name: 'Deploy token', kind: 'token', value: 'token-value' },
                },
                accountGrants: [],
                teamGrants: [],
                groupGrants: [],
            },
        }));
        expect(mutateAccountSettingsOnce).not.toHaveBeenCalled();
    });

    it('creates an E2EE resource with its owner envelope and initial mixed grants', async () => {
        syncEncryption.current = {
            contentDataKey: new Uint8Array(32).fill(4),
            decryptEncryptionKey: vi.fn(async () => new Uint8Array(32).fill(8)),
        };
        runTeamAction.mockResolvedValueOnce({
            kind: 'succeeded',
            value: { resourceId: 'resource-promoted', revision: 1 },
        });
        requestHomeDomain.mockResolvedValueOnce({
            ok: true,
            value: { resourceId: 'resource-promoted', revision: 1, recipients: [], nextCursor: null },
        });

        const { createSavedSecretResource } = await import('./savedSecretResourceOperations');
        await expect(createSavedSecretResource({
            scope: { serverId: 'home-a', accountId: 'owner-a' },
            name: 'Shared API key',
            kind: 'apiKey',
            value: 'secret-value',
            accountGrants: ['account-b'],
            teamGrants: ['team-a'],
            groupGrants: ['group-a'],
        })).resolves.toEqual(expect.objectContaining({ ok: true, revision: 1 }));

        const request = runTeamAction.mock.calls[0]?.[0];
        expect(request.actionId).toBe('secrets.shared.create');
        expect(request.input).toEqual(expect.objectContaining({
            encryptionMode: 'e2ee',
            accountGrants: ['account-b'],
            teamGrants: ['team-a'],
            groupGrants: ['group-a'],
            keyEnvelopes: [{
                recipientAccountId: 'owner-a',
                encryptedDataKey: 'wrapped-key',
                recipientContentPublicKeyFingerprint: expect.any(String),
            }],
        }));
        expect(request.input.storedContent.t).toBe('encrypted');
    });

    it('returns the exact approved create result through a continuation and never redispatches', async () => {
        const approved = vi.fn();
        const rejected = vi.fn();
        runTeamAction.mockImplementationOnce(async (request) => {
            await request.onApprovalSucceeded({ resourceId: 'resource-promoted', revision: 1 });
            request.onApprovalFailed('approval_rejected');
            throw Object.assign(new Error('approval-pending'), {
                name: 'TeamActionApprovalPendingError',
            });
        });

        const { createSavedSecretResource } = await import('./savedSecretResourceOperations');
        await expect(createSavedSecretResource({
            scope: { serverId: 'home-a', accountId: 'owner-a' },
            name: 'Deploy token',
            kind: 'token',
            value: 'token-value',
            accountGrants: [],
            teamGrants: [],
            groupGrants: [],
            onApprovalSucceeded: approved,
            onApprovalFailed: rejected,
        })).rejects.toThrow('approval-pending');

        expect(approved).toHaveBeenCalledWith({
            ok: true,
            resourceRef: 'happier:shared-secret:v1:resource-promoted',
            revision: 1,
        });
        expect(rejected).toHaveBeenCalledWith('approval_rejected');
        expect(runTeamAction).toHaveBeenCalledOnce();
    });

    it('recovers an outcome-unknown create by reading back its stable resource id', async () => {
        runTeamAction.mockResolvedValueOnce({
            kind: 'failed',
            failure: { kind: 'outcome_unknown', retryable: true },
        });
        readSavedSecretCatalog.mockResolvedValueOnce({
            ok: true,
            resources: [{
                resourceId: 'resource-promoted',
                entry: { revision: 3 },
            }],
        });

        const { createSavedSecretResource } = await import('./savedSecretResourceOperations');
        await expect(createSavedSecretResource({
            scope: { serverId: 'home-a', accountId: 'owner-a' },
            name: 'Deploy token',
            kind: 'token',
            value: 'token-value',
            accountGrants: [],
            teamGrants: [],
            groupGrants: [],
        })).resolves.toEqual({
            ok: true,
            resourceRef: 'happier:shared-secret:v1:resource-promoted',
            revision: 3,
        });
        expect(runTeamAction).toHaveBeenCalledOnce();
    });

    it('promotes a personal secret through one externally committed Settings/resource transaction', async () => {
        mutateAccountSettingsOnce.mockImplementationOnce(async (input) => {
            const mutation = input.mutate({
                secrets: [{
                    id: 'personal-a', name: 'Provider key', kind: 'apiKey',
                    encryptedValue: { _isSecretValue: true, value: 'personal-value' },
                    createdAt: 1, updatedAt: 4,
                }],
                mcpServersSettingsV1: {
                    v: 1,
                    strictMode: false,
                    servers: [{
                        id: 'server-a',
                        env: { TOKEN: { t: 'savedSecret', secretId: 'personal-a' } },
                    }],
                    bindings: [],
                },
            });
            const committed = await input.commitPrepared({
                content: { t: 'plain', v: mutation.settings },
                expectedSettingsVersion: 7,
                accountMode: 'plain',
            });
            expect(committed).toEqual({ status: 'applied', settingsVersion: 8 });
            return { status: 'applied', settingsVersion: 8, value: mutation.value };
        });
        runTeamAction.mockResolvedValueOnce({
            kind: 'succeeded',
            value: { resourceId: 'resource-promoted', settingsVersion: 8 },
        });

        const { promotePersonalSavedSecretResource } = await import('./savedSecretResourceOperations');
        const result = await promotePersonalSavedSecretResource({
            scope: { serverId: 'home-a', accountId: 'owner-a' },
            expectedSettingsVersion: 7,
            secret: {
                id: 'personal-a', name: 'Provider key', kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'personal-value' },
                createdAt: 1, updatedAt: 4,
            },
            accountGrants: ['recipient-a'], teamGrants: [], groupGrants: [],
        });

        expect(result).toEqual({ ok: true, resourceRef: 'happier:shared-secret:v1:resource-promoted' });
        const request = runTeamAction.mock.calls[0]?.[0];
        expect(request.actionId).toBe('secrets.shared.promote');
        expect(request.input.nextSettings.v.secrets).toEqual([]);
        expect(request.input.nextSettings.v.mcpServersSettingsV1.servers[0].env.TOKEN.secretId)
            .toBe('happier:shared-secret:v1:resource-promoted');
        expect(request.input.storedContent).toEqual({
            t: 'plain',
            v: { v: 1, name: 'Provider key', kind: 'apiKey', value: 'personal-value' },
        });
    });

    it('promotes a secret a Profile binds and moves that Profile binding to the shared reference', async () => {
        mutateAccountSettingsOnce.mockImplementationOnce(async (input) => {
            const mutation = input.mutate({
                secrets: [{
                    id: 'personal-a', name: 'Provider key', kind: 'apiKey',
                    encryptedValue: { _isSecretValue: true, value: 'personal-value' },
                    createdAt: 1, updatedAt: 4,
                }],
                profiles: [{
                    id: 'profile-a',
                    name: 'Profile A',
                    backendType: 'claude',
                    envVarRequirements: [{ name: 'TOKEN', kind: 'secret' }],
                }],
                secretBindingsByProfileId: { 'profile-a': { TOKEN: 'personal-a' } },
            });
            const committed = await input.commitPrepared({
                content: { t: 'plain', v: mutation.settings },
                expectedSettingsVersion: 7,
                accountMode: 'plain',
            });
            return { ...committed, value: mutation.value };
        });
        runTeamAction.mockResolvedValueOnce({
            kind: 'succeeded',
            value: { resourceId: 'resource-promoted', settingsVersion: 8 },
        });

        const { promotePersonalSavedSecretResource } = await import('./savedSecretResourceOperations');
        await expect(promotePersonalSavedSecretResource({
            scope: { serverId: 'home-a', accountId: 'owner-a' },
            expectedSettingsVersion: 7,
            secret: {
                id: 'personal-a', name: 'Provider key', kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'personal-value' },
                createdAt: 1, updatedAt: 4,
            },
            accountGrants: [], teamGrants: [], groupGrants: [],
        })).resolves.toEqual({ ok: true, resourceRef: 'happier:shared-secret:v1:resource-promoted' });

        const request = runTeamAction.mock.calls[0]?.[0];
        expect(request.actionId).toBe('secrets.shared.promote');
        expect(request.input.nextSettings.v.secrets).toEqual([]);
        expect(request.input.nextSettings.v.secretBindingsByProfileId).toEqual({
            'profile-a': { TOKEN: 'happier:shared-secret:v1:resource-promoted' },
        });
    });

    it('reopens and reseals an E2EE resource for rename without retaining its DEK', async () => {
        const dataKey = new Uint8Array(32).fill(7);
        readSavedSecretCatalog.mockResolvedValue({
            ok: true,
            resources: [{
                resourceId: 'resource-a', encryptionMode: 'e2ee',
                entry: {
                    ref: 'happier:shared-secret:v1:resource-a', source: 'shared_resource', relationship: 'owner',
                    name: 'Old name', kind: 'apiKey', ownerAccountId: 'owner-a', revision: 3, materialStatus: 'ready',
                    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
                },
                storedContent: sealSavedSecretResourceStoredContentV1({
                    resourceId: 'resource-a', mode: 'e2ee', resourceDataKey: dataKey,
                    content: { v: 1, name: 'Old name', kind: 'apiKey', value: 'secret-value' },
                    randomBytes: (length) => new Uint8Array(length).fill(2),
                }),
                recipientEnvelope: { encryptedDataKey: 'opaque', recipientContentPublicKeyFingerprint: 'fingerprint' },
            }],
        });
        runTeamAction.mockResolvedValue({ kind: 'succeeded', value: { resourceId: 'resource-a', revision: 4 } });
        const openedKey = new Uint8Array(dataKey);

        const { updateSavedSecretResource } = await import('./savedSecretResourceOperations');
        const result = await updateSavedSecretResource({
            scope: { serverId: 'home-a', accountId: 'owner-a' }, resourceId: 'resource-a', expectedRevision: 3,
            nextName: 'New name', decryptDataKeyEnvelope: async () => openedKey,
        });

        expect(result).toEqual({ ok: true });
        expect(runTeamAction.mock.calls[0]?.[0]?.actionId).toBe('secrets.shared.update');
        const input = runTeamAction.mock.calls[0]?.[0]?.input;
        expect(openSavedSecretResourceStoredContentV1({
            resourceId: 'resource-a', mode: 'e2ee', resourceDataKey: dataKey, storedContent: input.storedContent,
        })).toEqual({ v: 1, name: 'New name', kind: 'apiKey', value: 'secret-value' });
        expect(openedKey).toEqual(new Uint8Array(32));
    });

    // Plan 10.08 §18.3(3): the E2EE owner client decrypts locally and submits
    // the Plain value; the Home never decrypts.
    it('converts an owned E2EE resource to Plain by opening it on this device and submitting a Plain payload', async () => {
        const dataKey = new Uint8Array(32).fill(7);
        readSavedSecretCatalog.mockResolvedValue({
            ok: true,
            resources: [{
                resourceId: 'resource-a', encryptionMode: 'e2ee',
                entry: {
                    ref: 'happier:shared-secret:v1:resource-a', source: 'shared_resource', relationship: 'owner',
                    name: 'Deploy key', kind: 'apiKey', ownerAccountId: 'owner-a', revision: 3, materialStatus: 'ready',
                    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
                },
                storedContent: sealSavedSecretResourceStoredContentV1({
                    resourceId: 'resource-a', mode: 'e2ee', resourceDataKey: dataKey,
                    content: { v: 1, name: 'Deploy key', kind: 'apiKey', value: 'secret-value' },
                    randomBytes: (length) => new Uint8Array(length).fill(2),
                }),
                recipientEnvelope: { encryptedDataKey: 'opaque', recipientContentPublicKeyFingerprint: 'fingerprint' },
            }],
        });
        runTeamAction.mockResolvedValue({ kind: 'succeeded', value: { resourceId: 'resource-a', revision: 4 } });
        const openedKey = new Uint8Array(dataKey);

        const { updateSavedSecretResource } = await import('./savedSecretResourceOperations');
        await expect(updateSavedSecretResource({
            scope: { serverId: 'home-a', accountId: 'owner-a' }, resourceId: 'resource-a', expectedRevision: 3,
            toMode: 'plain', decryptDataKeyEnvelope: async () => openedKey,
        })).resolves.toEqual({ ok: true });

        expect(runTeamAction).toHaveBeenCalledOnce();
        expect(runTeamAction.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            actionId: 'secrets.shared.update',
            input: {
                resourceId: 'resource-a',
                expectedRevision: 3,
                displayName: 'Deploy key',
                kind: 'apiKey',
                toMode: 'plain',
                storedContent: { t: 'plain', v: { v: 1, name: 'Deploy key', kind: 'apiKey', value: 'secret-value' } },
            },
        }));
        // No envelope census or repair follows: a Plain resource holds none.
        expect(requestHomeDomain).not.toHaveBeenCalled();
        expect(openedKey).toEqual(new Uint8Array(32));
    });

    it('converts an owned Plain resource to E2EE under a fresh data key with the owner envelope, then prepares recipients', async () => {
        syncEncryption.current = {
            contentDataKey: new Uint8Array(32).fill(4),
            decryptEncryptionKey: vi.fn(async () => null),
        };
        readSavedSecretCatalog.mockResolvedValue({
            ok: true,
            resources: [{
                resourceId: 'resource-a', encryptionMode: 'plain',
                entry: {
                    ref: 'happier:shared-secret:v1:resource-a', source: 'shared_resource', relationship: 'owner',
                    name: 'Deploy key', kind: 'apiKey', ownerAccountId: 'owner-a', revision: 3, materialStatus: 'ready',
                    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
                },
                storedContent: { t: 'plain', v: { v: 1, name: 'Deploy key', kind: 'apiKey', value: 'secret-value' } },
            }],
        });
        runTeamAction.mockResolvedValue({ kind: 'succeeded', value: { resourceId: 'resource-a', revision: 4 } });
        requestHomeDomain.mockResolvedValueOnce({
            ok: true,
            value: {
                resourceId: 'resource-a',
                revision: 4,
                recipients: [{
                    account: { accountId: 'recipient-b' },
                    readiness: { status: 'available', contentPublicKey: 'recipient-key', contentPublicKeyFingerprint: 'fp-b' },
                    envelopeStatus: 'missing',
                }],
                nextCursor: null,
            },
        }).mockResolvedValueOnce({ ok: true, value: { resourceId: 'resource-a', revision: 4 } });

        const { updateSavedSecretResource } = await import('./savedSecretResourceOperations');
        await expect(updateSavedSecretResource({
            scope: { serverId: 'home-a', accountId: 'owner-a' }, resourceId: 'resource-a', expectedRevision: 3,
            toMode: 'e2ee', decryptDataKeyEnvelope: async () => null,
        })).resolves.toEqual({ ok: true });

        const input = runTeamAction.mock.calls[0]?.[0]?.input;
        expect(input).toEqual(expect.objectContaining({
            resourceId: 'resource-a',
            expectedRevision: 3,
            toMode: 'e2ee',
            keyEnvelopes: [{
                recipientAccountId: 'owner-a',
                encryptedDataKey: 'wrapped-key',
                recipientContentPublicKeyFingerprint: expect.any(String),
            }],
        }));
        expect(input.storedContent.t).toBe('encrypted');
        expect(JSON.stringify(input)).not.toContain('secret-value');
        // The fresh data key sealed the content, wrapped the owner envelope,
        // and prepared the ready recipient at the committed revision.
        const sealedKey = encryptDataKeyForRecipientV0.mock.calls[0]?.[0];
        expect(sealedKey).toBeInstanceOf(Uint8Array);
        expect(requestHomeDomain).toHaveBeenLastCalledWith(expect.objectContaining({
            path: '/v1/account/saved-secrets/resources/envelopes/repair',
            input: {
                resourceId: 'resource-a',
                expectedRevision: 4,
                keyEnvelopes: [{
                    recipientAccountId: 'recipient-b',
                    encryptedDataKey: 'wrapped-key',
                    recipientContentPublicKeyFingerprint: 'fp-b',
                }],
            },
        }));
        // The key never outlives the operation.
        expect(sealedKey).toEqual(new Uint8Array(32));
    });

    it('forwards exact approved update settlement and preserves the pending continuation', async () => {
        readSavedSecretCatalog.mockResolvedValue({
            ok: true,
            resources: [{
                resourceId: 'resource-a', encryptionMode: 'plain',
                entry: {
                    ref: 'happier:shared-secret:v1:resource-a', source: 'shared_resource', relationship: 'owner',
                    name: 'Old name', kind: 'apiKey', ownerAccountId: 'owner-a', revision: 3, materialStatus: 'ready',
                    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
                },
                storedContent: { t: 'plain', v: { v: 1, name: 'Old name', kind: 'apiKey', value: 'secret-value' } },
            }],
        });
        const approved = vi.fn();
        const failed = vi.fn();
        const pending = Object.assign(new Error('approval pending'), { name: 'TeamActionApprovalPendingError' });
        runTeamAction.mockImplementationOnce(async (request) => {
            await request.onApprovalSucceeded({ resourceId: 'resource-a', revision: 4 });
            request.onApprovalFailed('approval_rejected');
            throw pending;
        });

        const { updateSavedSecretResource } = await import('./savedSecretResourceOperations');
        await expect(updateSavedSecretResource({
            scope: { serverId: 'home-a', accountId: 'owner-a' }, resourceId: 'resource-a', expectedRevision: 3,
            nextName: 'New name', decryptDataKeyEnvelope: async () => null,
            onApprovalSucceeded: approved, onApprovalFailed: failed,
        })).rejects.toBe(pending);

        expect(approved).toHaveBeenCalledWith({ resourceId: 'resource-a', revision: 4 });
        expect(failed).toHaveBeenCalledWith('approval_rejected');
        expect(runTeamAction).toHaveBeenCalledOnce();
    });

    it('routes delete through the canonical shared Saved Secret Action', async () => {
        runTeamAction.mockResolvedValueOnce({ kind: 'succeeded', value: { resourceId: 'resource-a' } });
        mutateAccountSettingsOnce.mockImplementationOnce(async ({ mutate }: { mutate: (raw: Record<string, unknown>) => { value: unknown } }) => ({
            status: 'applied', settingsVersion: 8, value: mutate({}).value,
        }));
        const { deleteSavedSecretResource } = await import('./savedSecretResourceOperations');

        await expect(deleteSavedSecretResource({
            scope: { serverId: 'home-a', accountId: 'owner-a' },
            resourceId: 'resource-a',
            expectedRevision: 4,
            expectedSettingsVersion: 8,
            confirmedByPresentUser: true,
        })).resolves.toEqual({ ok: true });

        expect(runTeamAction).toHaveBeenCalledWith(expect.objectContaining({
            actionId: 'secrets.shared.delete',
            input: { resourceId: 'resource-a', expectedRevision: 4 },
            approval: 'surface_confirmed',
        }));
    });

    it('forwards exact approved delete settlement without redispatching', async () => {
        const approved = vi.fn();
        const failed = vi.fn();
        runTeamAction.mockImplementationOnce(async (request) => {
            await request.onApprovalSucceeded({ resourceId: 'resource-a' });
            request.onApprovalFailed('approval_canceled');
            throw Object.assign(new Error('approval pending'), { name: 'TeamActionApprovalPendingError' });
        });
        const { deleteSavedSecretResource } = await import('./savedSecretResourceOperations');

        mutateAccountSettingsOnce.mockImplementationOnce(async ({ mutate }: { mutate: (raw: Record<string, unknown>) => { value: unknown } }) => ({
            status: 'applied', settingsVersion: 8, value: mutate({}).value,
        }));
        await expect(deleteSavedSecretResource({
            scope: { serverId: 'home-a', accountId: 'owner-a' }, resourceId: 'resource-a', expectedRevision: 4,
            expectedSettingsVersion: 8, confirmedByPresentUser: true,
            onApprovalSucceeded: approved, onApprovalFailed: failed,
        })).rejects.toMatchObject({ name: 'TeamActionApprovalPendingError' });
        expect(approved).toHaveBeenCalledWith({ resourceId: 'resource-a' });
        expect(failed).toHaveBeenCalledWith('approval_canceled');
        expect(runTeamAction).toHaveBeenCalledOnce();
    });

    // Plan 10.08 §11.6: the owner client is the only place that can see an
    // E2EE Account's own references, so a promoted MCP/Voice/Provider binding
    // must block the shared delete instead of being left dangling.
    it('refuses to delete a shared Saved Secret the owner Settings still reference', async () => {
        mutateAccountSettingsOnce.mockImplementationOnce(async ({ mutate }: { mutate: (raw: Record<string, unknown>) => { value: unknown } }) => ({
            status: 'applied',
            settingsVersion: 8,
            value: mutate({
                mcpServersSettingsV1: {
                    servers: [{
                        id: 'srv',
                        env: { TOKEN: { t: 'savedSecret', secretId: 'happier:shared-secret:v1:resource-a' } },
                    }],
                },
            }).value,
        }));
        const { deleteSavedSecretResource } = await import('./savedSecretResourceOperations');

        await expect(deleteSavedSecretResource({
            scope: { serverId: 'home-a', accountId: 'owner-a' },
            resourceId: 'resource-a',
            expectedRevision: 4,
            expectedSettingsVersion: 8,
            confirmedByPresentUser: true,
        })).resolves.toMatchObject({ ok: false, reason: 'in_use' });
        expect(runTeamAction).not.toHaveBeenCalled();
    });

    it('routes plain audience replacement through the canonical shared Saved Secret Action', async () => {
        runTeamAction.mockResolvedValueOnce({
            kind: 'succeeded',
            value: { resourceId: 'resource-a', revision: 5 },
        });
        const { setSavedSecretResourceGrants } = await import('./savedSecretResourceOperations');

        await expect(setSavedSecretResourceGrants({
            scope: { serverId: 'home-a', accountId: 'owner-a' },
            resourceId: 'resource-a',
            expectedRevision: 4,
            encryptionMode: 'plain',
            accountGrants: ['account-b'],
            teamGrants: ['team-a'],
            groupGrants: ['group-a'],
            decryptDataKeyEnvelope: async () => null,
        })).resolves.toEqual({ ok: true });

        expect(runTeamAction).toHaveBeenCalledWith(expect.objectContaining({
            actionId: 'secrets.shared.grants.set',
            input: {
                resourceId: 'resource-a',
                expectedRevision: 4,
                accountGrants: ['account-b'],
                teamGrants: ['team-a'],
                groupGrants: ['group-a'],
            },
        }));
    });

    it('preserves an outcome-unknown audience replacement so the editor requires read-back recovery', async () => {
        runTeamAction.mockResolvedValueOnce({
            kind: 'failed',
            failure: { kind: 'outcome_unknown', retryable: true },
        });
        const { setSavedSecretResourceGrants } = await import('./savedSecretResourceOperations');

        await expect(setSavedSecretResourceGrants({
            scope: { serverId: 'home-a', accountId: 'owner-a' },
            resourceId: 'resource-a',
            expectedRevision: 4,
            encryptionMode: 'plain',
            accountGrants: ['account-b'],
            teamGrants: [],
            groupGrants: [],
            decryptDataKeyEnvelope: async () => null,
        })).resolves.toEqual({ ok: false, reason: 'outcome_unknown' });
    });

    it('forwards approved grants settlement after envelope repair and preserves pending', async () => {
        const approved = vi.fn();
        const failed = vi.fn();
        runTeamAction.mockImplementationOnce(async (request) => {
            await request.onApprovalSucceeded({ resourceId: 'resource-a', revision: 5 });
            request.onApprovalFailed('approval_failed');
            throw Object.assign(new Error('approval pending'), { name: 'TeamActionApprovalPendingError' });
        });
        const { setSavedSecretResourceGrants } = await import('./savedSecretResourceOperations');

        await expect(setSavedSecretResourceGrants({
            scope: { serverId: 'home-a', accountId: 'owner-a' }, resourceId: 'resource-a', expectedRevision: 4,
            encryptionMode: 'plain', accountGrants: ['account-b'], teamGrants: [], groupGrants: [],
            decryptDataKeyEnvelope: async () => null, onApprovalSucceeded: approved, onApprovalFailed: failed,
        })).rejects.toMatchObject({ name: 'TeamActionApprovalPendingError' });
        expect(approved).toHaveBeenCalledWith({ resourceId: 'resource-a', revision: 5 });
        expect(failed).toHaveBeenCalledWith('approval_failed');
        expect(runTeamAction).toHaveBeenCalledOnce();
    });

    it('keeps mixed-mode grants and prepares envelopes only for ready E2EE recipients', async () => {
        const openedKey = new Uint8Array(32).fill(9);
        readSavedSecretCatalog.mockResolvedValueOnce({
            ok: true,
            resources: [{
                resourceId: 'resource-a', encryptionMode: 'e2ee',
                entry: {
                    ref: 'happier:shared-secret:v1:resource-a', source: 'shared_resource', relationship: 'owner',
                    name: 'Key', kind: 'apiKey', ownerAccountId: 'owner-a', revision: 3, materialStatus: 'ready',
                    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
                },
                storedContent: { t: 'encrypted', c: 'AA==' },
                recipientEnvelope: { encryptedDataKey: 'owner-envelope', recipientContentPublicKeyFingerprint: 'owner-key' },
            }],
        });
        requestHomeDomain.mockResolvedValueOnce({
            ok: true,
            value: {
                resourceId: 'resource-a', revision: 4,
                recipients: [
                    { account: { kind: 'account', accountId: 'plain-a' }, readiness: { status: 'unavailable', reason: 'plain_account' }, envelopeStatus: 'missing' },
                    { account: { kind: 'account', accountId: 'e2ee-a' }, readiness: { status: 'available', contentPublicKey: 'public-key', contentPublicKeyFingerprint: 'fp' }, envelopeStatus: 'missing' },
                ],
                nextCursor: null,
            },
        });
        runTeamAction.mockResolvedValueOnce({ kind: 'succeeded', value: { resourceId: 'resource-a', revision: 4 } });
        requestHomeDomain.mockResolvedValueOnce({
            ok: true,
            value: { resourceId: 'resource-a', revision: 4 },
        });

        const { setSavedSecretResourceGrants } = await import('./savedSecretResourceOperations');
        await expect(setSavedSecretResourceGrants({
            scope: { serverId: 'home-a', accountId: 'owner-a' },
            resourceId: 'resource-a', expectedRevision: 3, encryptionMode: 'e2ee',
            accountGrants: ['plain-a', 'e2ee-a'], teamGrants: [], groupGrants: [],
            decryptDataKeyEnvelope: async () => openedKey,
        })).resolves.toEqual({ ok: true });

        expect(runTeamAction).toHaveBeenCalledWith(expect.objectContaining({
            actionId: 'secrets.shared.grants.set',
            input: expect.objectContaining({
                accountGrants: ['plain-a', 'e2ee-a'],
            }),
        }));
        expect(requestHomeDomain).toHaveBeenNthCalledWith(1, expect.objectContaining({
            path: '/v1/account/saved-secrets/resources/envelope-census?resourceId=resource-a&limit=100',
            method: 'GET',
            input: undefined,
        }));
        expect(requestHomeDomain).toHaveBeenNthCalledWith(2, expect.objectContaining({
            path: '/v1/account/saved-secrets/resources/envelopes/repair',
            method: 'POST',
            input: {
                resourceId: 'resource-a',
                expectedRevision: 4,
                keyEnvelopes: [{
                    recipientAccountId: 'e2ee-a', encryptedDataKey: 'wrapped-key', recipientContentPublicKeyFingerprint: 'fp',
                }],
            },
        }));
        expect([...openedKey]).toEqual(new Array(32).fill(0));
    });
    it('prepares an owed envelope for a custodied resource without mutating the resource', async () => {
        const openedKey = new Uint8Array(32).fill(9);
        readSavedSecretCatalog.mockResolvedValueOnce({
            ok: true,
            resources: [
                {
                    // Shared with this Account by someone else: the census and
                    // repair routes are custodian-only, so asking here is a 403.
                    resourceId: 'resource-received', encryptionMode: 'e2ee',
                    entry: {
                        ref: 'happier:shared-secret:v1:resource-received', source: 'shared_resource', relationship: 'recipient',
                        name: 'Theirs', kind: 'apiKey', ownerAccountId: 'owner-b', revision: 2, materialStatus: 'ready',
                        capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
                    },
                    storedContent: { t: 'encrypted', c: 'AA==' },
                    recipientEnvelope: { encryptedDataKey: 'their-envelope', recipientContentPublicKeyFingerprint: 'owner-key' },
                },
                {
                    // Plain custody carries no envelopes at all.
                    resourceId: 'resource-plain', encryptionMode: 'plain',
                    entry: {
                        ref: 'happier:shared-secret:v1:resource-plain', source: 'shared_resource', relationship: 'owner',
                        name: 'Plain', kind: 'token', ownerAccountId: 'owner-a', revision: 1, materialStatus: 'ready',
                        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
                    },
                    storedContent: { t: 'plain', v: { v: 1, name: 'Plain', kind: 'token', value: 'v' } },
                    recipientEnvelope: null,
                },
                {
                    resourceId: 'resource-a', encryptionMode: 'e2ee',
                    entry: {
                        ref: 'happier:shared-secret:v1:resource-a', source: 'shared_resource', relationship: 'owner',
                        name: 'Key', kind: 'apiKey', ownerAccountId: 'owner-a', revision: 3, materialStatus: 'ready',
                        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
                    },
                    storedContent: { t: 'encrypted', c: 'AA==' },
                    recipientEnvelope: { encryptedDataKey: 'owner-envelope', recipientContentPublicKeyFingerprint: 'owner-key' },
                },
            ],
        });
        requestHomeDomain.mockResolvedValueOnce({
            ok: true,
            value: {
                resourceId: 'resource-a', revision: 3,
                recipients: [
                    { account: { kind: 'account', accountId: 'owner-a' }, readiness: { status: 'available', contentPublicKey: 'owner-public', contentPublicKeyFingerprint: 'owner-key' }, envelopeStatus: 'prepared' },
                    { account: { kind: 'account', accountId: 'e2ee-a' }, readiness: { status: 'available', contentPublicKey: 'public-key', contentPublicKeyFingerprint: 'fp' }, envelopeStatus: 'missing' },
                ],
                nextCursor: null,
            },
        });
        requestHomeDomain.mockResolvedValueOnce({ ok: true, value: { resourceId: 'resource-a', revision: 3 } });

        const { repairCustodiedSavedSecretResourceEnvelopesBestEffort } = await import('./savedSecretResourceOperations');
        await repairCustodiedSavedSecretResourceEnvelopesBestEffort({
            scope: { serverId: 'home-a', accountId: 'owner-a' },
            decryptDataKeyEnvelope: async () => openedKey,
        });

        // Only the custodied E2EE resource is asked about, and the sweep writes
        // nothing but the owed envelopes.
        expect(runTeamAction).not.toHaveBeenCalled();
        expect(requestHomeDomain).toHaveBeenCalledTimes(2);
        expect(requestHomeDomain).toHaveBeenNthCalledWith(1, expect.objectContaining({
            path: '/v1/account/saved-secrets/resources/envelope-census?resourceId=resource-a&limit=100',
            method: 'GET',
            input: undefined,
        }));
        expect(requestHomeDomain).toHaveBeenNthCalledWith(2, expect.objectContaining({
            path: '/v1/account/saved-secrets/resources/envelopes/repair',
            method: 'POST',
            input: {
                resourceId: 'resource-a',
                expectedRevision: 3,
                keyEnvelopes: [{
                    recipientAccountId: 'e2ee-a', encryptedDataKey: 'wrapped-key', recipientContentPublicKeyFingerprint: 'fp',
                }],
            },
        }));
        expect([...openedKey]).toEqual(new Array(32).fill(0));
    });

    it('writes nothing when every available recipient already holds a prepared envelope', async () => {
        readSavedSecretCatalog.mockResolvedValueOnce({
            ok: true,
            resources: [{
                resourceId: 'resource-a', encryptionMode: 'e2ee',
                entry: {
                    ref: 'happier:shared-secret:v1:resource-a', source: 'shared_resource', relationship: 'owner',
                    name: 'Key', kind: 'apiKey', ownerAccountId: 'owner-a', revision: 3, materialStatus: 'ready',
                    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
                },
                storedContent: { t: 'encrypted', c: 'AA==' },
                recipientEnvelope: { encryptedDataKey: 'owner-envelope', recipientContentPublicKeyFingerprint: 'owner-key' },
            }],
        });
        requestHomeDomain.mockResolvedValueOnce({
            ok: true,
            value: {
                resourceId: 'resource-a', revision: 3,
                recipients: [
                    { account: { kind: 'account', accountId: 'owner-a' }, readiness: { status: 'available', contentPublicKey: 'owner-public', contentPublicKeyFingerprint: 'owner-key' }, envelopeStatus: 'prepared' },
                    { account: { kind: 'account', accountId: 'plain-a' }, readiness: { status: 'unavailable', reason: 'plain_account' }, envelopeStatus: 'missing' },
                ],
                nextCursor: null,
            },
        });

        const { repairCustodiedSavedSecretResourceEnvelopesBestEffort } = await import('./savedSecretResourceOperations');
        await repairCustodiedSavedSecretResourceEnvelopesBestEffort({
            scope: { serverId: 'home-a', accountId: 'owner-a' },
            decryptDataKeyEnvelope: async () => new Uint8Array(32).fill(9),
        });

        expect(requestHomeDomain).toHaveBeenCalledTimes(1);
    });
});
