import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { CustomModalChromeConfig } from '@/modal';

import { TransferFinalizeRecoveryModal } from './TransferFinalizeRecoveryModal';

describe('TransferFinalizeRecoveryModal', () => {
    it.each([
        ['transfer-finalize-recovery-retry', 'retry_finalize'],
        ['transfer-finalize-recovery-discard', 'discard_staged'],
    ] as const)('renders and invokes only the explicit %s action', async (testID, expectedAction) => {
        const onClose = vi.fn();
        const onResolve = vi.fn();
        const chromeCalls: Array<CustomModalChromeConfig | null> = [];

        const modalBody = await renderScreen(
            <TransferFinalizeRecoveryModal
                title="Upload needs attention"
                message="The upload is staged."
                onClose={onClose}
                onResolve={onResolve}
                setChrome={(nextChrome) => {
                    chromeCalls.push(nextChrome);
                }}
            />,
        );

        const chrome = chromeCalls.at(-1);
        expect(modalBody.findByTestId('transfer-finalize-recovery-message')).toBeDefined();
        expect(chrome).toMatchObject({
            kind: 'card',
            title: 'Upload needs attention',
            testID: 'transfer-finalize-recovery-modal',
            closeButtonTestID: 'transfer-finalize-recovery-close',
        });
        if (!chrome || chrome.kind !== 'card' || !chrome.footer) {
            throw new Error('Expected rendered transfer recovery modal card footer');
        }

        const footer = await renderScreen(<>{chrome.footer}</>);
        const retryButton = footer.findByTestId('transfer-finalize-recovery-retry');
        const discardButton = footer.findByTestId('transfer-finalize-recovery-discard');
        if (!retryButton || !discardButton) {
            throw new Error('Expected both rendered transfer recovery actions');
        }
        expect(retryButton.props.accessibilityRole).toBe('button');
        expect(discardButton.props.accessibilityRole).toBe('button');

        footer.pressByTestId(testID);

        expect(onResolve).toHaveBeenCalledTimes(1);
        expect(onResolve).toHaveBeenCalledWith(expectedAction);
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
