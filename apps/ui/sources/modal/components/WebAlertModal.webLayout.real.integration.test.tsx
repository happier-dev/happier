// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

/** The shared alert's buttons as a browser lays them out (DESIGN-9 N33). */
it('stacks three choices as three full-width rows in their given order, never two beside one', async () => {
    const { WebAlertModal } = await import('./WebAlertModal');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(<WebAlertModal
            config={{
                id: 'unsaved',
                type: 'alert',
                title: 'Discard changes',
                message: 'You have unsaved changes.',
                buttons: [
                    { text: 'Discard', style: 'destructive' },
                    { text: 'Save', style: 'default' },
                    { text: 'Keep editing', style: 'cancel' },
                ],
            }}
            onClose={() => {}}
        />));
        // The modal portals to the document, so the whole body is what a browser lays out.
        const layout = await measureWebLayout(document.body, { viewport: { width: 1440, height: 1000 } });
        const rows = [0, 1, 2].map((index) => layout.rect(`web-modal-button-${index}`));
        // One column: each row starts where the previous one ended, in the order the caller gave.
        expect(rows[1]!.top).toBeGreaterThanOrEqual(rows[0]!.bottom - 1);
        expect(rows[2]!.top).toBeGreaterThanOrEqual(rows[1]!.bottom - 1);
        // Every row spans the card: the same left edge and width.
        for (const row of rows) {
            expect(Math.abs(row.left - rows[0]!.left)).toBeLessThanOrEqual(1);
            expect(Math.abs(row.width - rows[0]!.width)).toBeLessThanOrEqual(1);
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
