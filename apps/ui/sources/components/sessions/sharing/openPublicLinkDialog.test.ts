import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PublicSessionShare } from '@/sync/domains/social/sharingTypes';

const modalModuleState = vi.hoisted(() => ({
    show: vi.fn(),
    update: vi.fn(),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            show: modalModuleState.show,
            update: modalModuleState.update,
        },
    }).module;
});

vi.mock('./components/PublicLinkDialog', () => ({
    PublicLinkDialog: () => null,
}));

function createPublicShare(overrides: Partial<PublicSessionShare> = {}): PublicSessionShare {
    return {
        id: 'public-share-1',
        sessionId: 'session-1',
        token: 'share-token-1',
        expiresAt: null,
        maxUses: null,
        useCount: 0,
        isConsentRequired: true,
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    };
}

describe('openPublicLinkDialog', () => {
    beforeEach(() => {
        modalModuleState.show.mockReset();
        modalModuleState.update.mockReset();
        modalModuleState.show.mockReturnValue('modal-1');
    });

    it('updates the open modal with the created public share after create succeeds', async () => {
        const { openPublicLinkDialog } = await import('./openPublicLinkDialog');

        const createdShare = createPublicShare({
            id: 'public-share-created',
            token: 'created-token',
        });
        const onCreate = vi.fn().mockResolvedValue(createdShare);

        await openPublicLinkDialog({
            publicShare: null,
            onCreate,
            onDelete: vi.fn(),
        });

        const dialogConfig = modalModuleState.show.mock.calls[0]?.[0];
        expect(dialogConfig?.props?.publicShare).toBeNull();

        await dialogConfig.props.onCreate({
            expiresInDays: 7,
            maxUses: 10,
            isConsentRequired: true,
        });

        expect(onCreate).toHaveBeenCalledWith({
            expiresInDays: 7,
            maxUses: 10,
            isConsentRequired: true,
        });
        expect(modalModuleState.update).toHaveBeenCalledWith('modal-1', {
            publicShare: createdShare,
        });
    });
});
