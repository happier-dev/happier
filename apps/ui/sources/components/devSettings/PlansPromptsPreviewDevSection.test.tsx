import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';

vi.mock('@/components/qr', () => ({ QRCode: () => null }));

describe('PlansPromptsPreviewDevSection', () => {
    const rows = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.root
        .findAll((node) => String(node.props.testID ?? '').startsWith('dev-preview-') && typeof node.props.onPress === 'function')
        .map((node) => node.props.testID);

    it('offers the four plans and prompts previews only in Developer Mode', async () => {
        const { PlansPromptsPreviewDevSection } = await import('./PlansPromptsPreviewDevSection');

        storage.getState().applyLocalSettings({ devModeEnabled: false });
        const hidden = await renderScreen(<PlansPromptsPreviewDevSection />);
        expect(rows(hidden)).toEqual([]);

        storage.getState().applyLocalSettings({ devModeEnabled: true });
        const shown = await renderScreen(<PlansPromptsPreviewDevSection />);
        expect([...new Set(rows(shown))]).toEqual([
            'dev-preview-star-ask',
            'dev-preview-supporter-prompt',
            'dev-preview-keep-or-let-go',
            'dev-preview-supporter-thanks',
        ]);
    });
});
