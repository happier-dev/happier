import { describe, expect, it } from 'vitest';

import { mapShareIntentToNewSession } from './mapShareIntentToNewSession';

describe('mapShareIntentToNewSession', () => {
    it('pastes a shared link as prompt text', () => {
        expect(mapShareIntentToNewSession({ webUrl: 'https://example.com/a', text: null, files: null }))
            .toEqual({ prompt: 'https://example.com/a', sources: [] });
    });

    it('uses shared text as the prompt', () => {
        expect(mapShareIntentToNewSession({ text: 'hello', webUrl: null, files: null }))
            .toEqual({ prompt: 'hello', sources: [] });
    });

    it('maps shared files to native attachment sources', () => {
        const result = mapShareIntentToNewSession({
            text: null,
            webUrl: null,
            files: [
                { path: 'content://media/1', fileName: 'a.jpg', mimeType: 'image/jpeg', size: 12 },
                { path: 'file:///tmp/b.pdf', fileName: null, mimeType: 'application/pdf', size: null },
            ],
        });
        expect(result.prompt).toBeUndefined();
        expect(result.sources).toEqual([
            { kind: 'native', uri: 'content://media/1', name: 'a.jpg', sizeBytes: 12, mimeType: 'image/jpeg' },
            { kind: 'native', uri: 'file:///tmp/b.pdf', name: 'b.pdf', sizeBytes: null, mimeType: 'application/pdf' },
        ]);
    });

    it('returns nothing for an empty share', () => {
        expect(mapShareIntentToNewSession({ text: '  ', webUrl: null, files: null }))
            .toEqual({ prompt: undefined, sources: [] });
    });
});
