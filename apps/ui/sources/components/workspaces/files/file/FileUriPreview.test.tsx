import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { Platform } from 'react-native';
import { renderScreen } from '@/dev/testkit';
import { FileUriPreview } from './FileUriPreview';

describe('FileUriPreview', () => {
    it('uses the existing URI engine for web PDF and never activates an HTML file', async () => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        try {
            const pdf = await renderScreen(<FileUriPreview uri="blob:private-pdf" mime="application/pdf" title="Document" fallback={null} />);
            expect(pdf.findByType('iframe').props.src).toBe('blob:private-pdf');
            expect(pdf.findByType('iframe').props.sandbox).toBe('');
            const html = await renderScreen(<FileUriPreview uri="blob:private-html" mime="text/html" title="HTML"
                fallback={<span {...{ testID: 'download' }}>Download</span>} />);
            expect(html.tree.root.findAllByType('iframe')).toHaveLength(0);
            expect(html.findByTestId('download')).not.toBeNull();
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: previous });
        }
    });

    it('offers native PDF through the caller OS-open fallback without claiming embedded rendering', async () => {
        const previous = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
        try {
            const pdf = await renderScreen(<FileUriPreview uri="file:///private.pdf" mime="application/pdf" title="Document"
                fallback={<span {...{ testID: 'open' }}>Open file</span>} />);
            expect(pdf.tree.root.findAllByType('iframe')).toHaveLength(0);
            expect(pdf.findByTestId('open')).not.toBeNull();
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: previous });
        }
    });
});
