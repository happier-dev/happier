import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchAndApplyAccountPets } from './syncAccountPets';

const listAccountPetsMock = vi.hoisted(() => vi.fn());
const isRuntimeFeatureEnabledMock = vi.hoisted(() => vi.fn());
const getActiveServerSnapshotMock = vi.hoisted(() => vi.fn(() => ({ serverId: 'server-pets' })));

vi.mock('@/sync/api/pets/apiAccountPets', () => ({
    listAccountPets: listAccountPetsMock,
}));

vi.mock('@/sync/domains/features/featureDecisionInputs', () => ({
    isRuntimeFeatureEnabled: isRuntimeFeatureEnabledMock,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: getActiveServerSnapshotMock,
}));

describe('fetchAndApplyAccountPets', () => {
    beforeEach(() => {
        listAccountPetsMock.mockReset();
        isRuntimeFeatureEnabledMock.mockReset();
        getActiveServerSnapshotMock.mockClear();

        isRuntimeFeatureEnabledMock.mockResolvedValue(true);
        listAccountPetsMock.mockResolvedValue([
            {
                accountPetId: 'pet-1',
                packageFormat: 'codex-compatible-atlas-v1',
                manifest: {
                    id: 'blink',
                    displayName: 'Blink',
                    description: 'Pet',
                    spritesheetPath: 'spritesheet.webp',
                },
                spritesheetAssetRef: {
                    assetId: 'asset-1',
                    mediaType: 'image/webp',
                    digest: 'sha256:asset',
                    sizeBytes: 5,
                },
                digest: 'sha256:pkg',
                sizeBytes: 128,
                createdAt: 1,
                updatedAt: 2,
                origin: { kind: 'manualImport' },
            },
        ]);
    });

    it('does not fetch account pets when pets sync is disabled by the active server', async () => {
        isRuntimeFeatureEnabledMock.mockResolvedValue(false);
        const applyAccountPets = vi.fn();
        const applyAccountPetsForScope = vi.fn();

        await fetchAndApplyAccountPets({
            credentials: { accessToken: 'token' } as any,
            readScope: () => null,
            applyAccountPets,
            applyAccountPetsForScope,
        });

        expect(isRuntimeFeatureEnabledMock).toHaveBeenCalledWith({
            featureId: 'pets.sync',
            serverId: 'server-pets',
            timeoutMs: 400,
        });
        expect(listAccountPetsMock).not.toHaveBeenCalled();
        expect(applyAccountPets).not.toHaveBeenCalled();
        expect(applyAccountPetsForScope).not.toHaveBeenCalled();
    });

    it('applies account pets to the current account scope when sync is enabled', async () => {
        const scope = { serverId: 'server-pets', accountId: 'account-1' };
        const applyAccountPets = vi.fn();
        const applyAccountPetsForScope = vi.fn();

        await fetchAndApplyAccountPets({
            credentials: { accessToken: 'token' } as any,
            readScope: () => scope,
            applyAccountPets,
            applyAccountPetsForScope,
        });

        expect(listAccountPetsMock).toHaveBeenCalledWith({ accessToken: 'token' });
        expect(applyAccountPets).not.toHaveBeenCalled();
        expect(applyAccountPetsForScope).toHaveBeenCalledWith(scope, [
            expect.objectContaining({ accountPetId: 'pet-1' }),
        ]);
    });
});
