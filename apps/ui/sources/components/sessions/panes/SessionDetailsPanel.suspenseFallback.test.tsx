import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { SessionDetailsPanel } from './SessionDetailsPanelHost.web';
import { SessionScmReviewDetailsViewForPanel } from './SessionDetailsPanelDetailViews';

describe('cold Details on web', () => {
    it('draws the destination body while the cockpit waits for the Details module', async () => {
        const delivery = Promise.withResolvers<void>();
        // Delay delivery of the route chunk after the harness has loaded.
        vi.doMock('./SessionDetailsPanel', async () => {
            await delivery.promise;
            return { SessionDetailsPanel: () => null };
        });
        try {
            const screen = await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
            try {
                expect(screen.findHostByTestId('workspace-destination-body-loading-header')).not.toBeNull();
            } finally {
                await screen.unmount();
            }
        } finally {
            await act(async () => {
                delivery.resolve();
                await vi.dynamicImportSettled();
            });
            vi.doUnmock('./SessionDetailsPanel');
        }
    });

    it('draws the destination body while the selected Review tab waits for its module', async () => {
        const delivery = Promise.withResolvers<void>();
        vi.doMock('@/components/sessions/files/views/SessionScmReviewDetailsView', async () => {
            await delivery.promise;
            return { SessionScmReviewDetailsView: () => null };
        });
        try {
            const screen = await renderScreen(<SessionScmReviewDetailsViewForPanel sessionId="s1" scopeId="session:s1" />);
            try {
                expect(screen.findHostByTestId('session-scm-review-details-loading-header')).not.toBeNull();
            } finally {
                await screen.unmount();
            }
        } finally {
            await act(async () => {
                delivery.resolve();
                await vi.dynamicImportSettled();
            });
            vi.doUnmock('@/components/sessions/files/views/SessionScmReviewDetailsView');
        }
    });
});
