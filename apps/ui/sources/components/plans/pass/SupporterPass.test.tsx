import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

// The QR renderer draws through Skia on native: a platform canvas boundary. The pass's contract
// is what it encodes, so the stub records the data it was given.
vi.mock('@/components/qr', () => ({
    QRCode: (props: { data: string }) => React.createElement('QRCode', props),
}));

describe('SupporterPass', () => {
    it('draws no code before joining and encodes the supporter page once the pass has a number', async () => {
        const { SupporterPass } = await import('./SupporterPass');

        const blank = await renderScreen(<SupporterPass editionLabel="Supporter" identity={null} width={240} />);
        expect(blank.root.findAll((node) => (node.type as unknown) === 'QRCode')).toHaveLength(0);
        const blankImage = blank.root.find((node) => node.props.accessibilityRole === 'image');
        expect(blankImage.props.accessibilityLabel).toBeTruthy();

        const joined = await renderScreen(
            <SupporterPass
                editionLabel="Plus"
                identity={{ number: 42, name: 'Leeroy Brun', sinceMs: Date.UTC(2026, 10, 3) }}
                width={240}
            />,
        );
        const codes = joined.root.findAll((node) => (node.type as unknown) === 'QRCode');
        expect(codes.map((node) => node.props.data)).toEqual(['https://happier.dev/s/0042']);
        const image = joined.root.find((node) => node.props.accessibilityRole === 'image');
        expect(image.props.accessibilityLabel).toContain('0042');
    });
});
