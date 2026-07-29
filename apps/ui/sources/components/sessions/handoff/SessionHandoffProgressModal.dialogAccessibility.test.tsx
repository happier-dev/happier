import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installSessionHandoffCommonModuleMocks } from './sessionHandoffTestHelpers';

(globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT = true;

installSessionHandoffCommonModuleMocks();

vi.mock('@/modal/components/BaseModal', () => ({
    BaseModal: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('BaseModal', props, children),
}));

describe('SessionHandoffProgressModal dialog accessibility', () => {
    it('composes the changing handoff title into the shared dialog accessible name', async () => {
        const { CustomModal } = await import('@/modal/components/CustomModal');
        const { SessionHandoffProgressModal } = await import('./SessionHandoffProgressModal');
        const onClose = vi.fn();

        const createConfig = (status: 'pending' | 'failed') => ({
            id: 'handoff-progress',
            type: 'custom' as const,
            component: SessionHandoffProgressModal,
            props: {
                status: {
                    handoffId: 'handoff_accessible_dialog_1',
                    status,
                    phase: 'preparing' as const,
                    recoveryActions: [],
                },
            },
            closeOnBackdrop: false,
        });

        const screen = await renderScreen(
            <CustomModal
                config={createConfig('pending')}
                onClose={onClose}
                visible={true}
            />,
        );

        expect(screen.findByType('BaseModal' as never).props.accessibilityLabel)
            .toBe('sessionHandoff.progress.title');

        await screen.update(
            <CustomModal
                config={createConfig('failed')}
                onClose={onClose}
                visible={true}
            />,
        );

        expect(screen.findByType('BaseModal' as never).props.accessibilityLabel)
            .toBe('sessionHandoff.failure.title');
    });
});
