import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { PdfChangeRow } from './PdfChange';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});

const present = (sizeBytes: number) => ({ kind: 'present' as const, uri: 'blob:pdf', sizeBytes });

describe('PdfChangeRow', () => {
    it('reads a changed PDF as pages and size delta and opens each revision', async () => {
        const onOpen = vi.fn();
        const screen = await renderScreen(<PdfChangeRow filePath="docs/spec.pdf" before={present(1_000_000)} after={present(1_210_000)}
            beforePages={12} afterPages={14} onOpen={onOpen} />);
        try {
            expect(screen.getTextContent()).toContain('PDF · 12 → 14 pages · +210 KB');
            screen.pressByTestId('pdf-change-open-before');
            screen.pressByTestId('pdf-change-open-after');
            expect(onOpen.mock.calls).toEqual([['before'], ['after']]);
        } finally { await screen.unmount(); }
    });

    it('states the size alone when the host cannot count pages, and says why a revision has no preview', async () => {
        const screen = await renderScreen(<PdfChangeRow filePath="docs/spec.pdf" before={present(1_000_000)}
            after={{ kind: 'unavailable', reason: { kind: 'tooLarge', sizeBytes: 80_000_000 } }}
            beforePages={null} afterPages={null} onOpen={vi.fn()} />);
        try {
            const text = screen.getTextContent();
            expect(text).toContain('PDF');
            expect(text).not.toContain('pages');
            expect(text).toContain('Too large to preview');
            expect(screen.findByTestId('pdf-change-open-after')!.props.disabled).toBe(true);
            expect(screen.findByTestId('pdf-change-open-before')!.props.disabled).toBeFalsy();
        } finally { await screen.unmount(); }
    });
});
