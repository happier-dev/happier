import { describe, expect, it, vi } from 'vitest';

import type { CustomModalShowConfig, IModal } from '@/modal';

import type { ApiTokenSettingsController } from './apiTokenSettingsController';
import { ApiTokenCreateModal } from './ApiTokenCreateModal';
import { showApiTokenCreateModal } from './showApiTokenCreateModal';

describe('showApiTokenCreateModal', () => {
    it('routes shared/action dismissal and host teardown through the secret lifecycle owner', async () => {
        const controller = {
            requestRevealDismiss: vi.fn(async (confirm: () => Promise<boolean>) => await confirm()),
            clearReveal: vi.fn(),
        } as unknown as ApiTokenSettingsController;
        const show = vi.fn((_config: CustomModalShowConfig<typeof ApiTokenCreateModal>) => 'api-token-modal');
        const modal = {
            show,
            confirm: vi.fn(async () => true),
        };

        showApiTokenCreateModal(controller, modal as Pick<IModal, 'show' | 'confirm'>);
        const config = show.mock.calls[0]![0];
        expect(config).toMatchObject({
            closeOnBackdrop: true,
            props: { controller },
        });
        await expect(config.onDismissRequest?.('shared')).resolves.toBe(true);
        expect(controller.requestRevealDismiss).toHaveBeenCalledWith(expect.any(Function), 'shared');
        config.onHostUnmount?.();
        expect(controller.clearReveal).toHaveBeenCalledTimes(1);
    });

    it('fails open when the warning host cannot present, so a one-time secret never traps the user', async () => {
        const controller = {
            requestRevealDismiss: vi.fn(async (confirm: () => Promise<boolean>) => await confirm()),
            clearReveal: vi.fn(),
        } as unknown as ApiTokenSettingsController;
        const show = vi.fn((_config: CustomModalShowConfig<typeof ApiTokenCreateModal>) => 'api-token-modal');
        const modal = {
            show,
            confirm: vi.fn(async (): Promise<boolean> => { throw new Error('modal host unavailable'); }),
        };

        showApiTokenCreateModal(controller, modal as Pick<IModal, 'show' | 'confirm'>);
        await expect(show.mock.calls[0]![0].onDismissRequest?.('action')).resolves.toBe(true);
    });
});
