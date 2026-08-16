import { describe, expect, it, vi } from 'vitest';

const wasmBoundary = vi.hoisted(() => {
    let markdown = '';
    let initializationAttempts = 0;

    return {
        factory: vi.fn(async () => {
            initializationAttempts += 1;
            if (initializationAttempts === 1) {
                throw new Error('simulated WASM initialization failure');
            }

            return {
                cwrap: () => () => (
                    markdown === 'invalid-document'
                        ? JSON.stringify({ children: [] })
                        : JSON.stringify({ type: 'Document', children: [] })
                ),
                _malloc: () => 1,
                _free: () => undefined,
                stringToUTF8: (value: string) => {
                    markdown = value;
                },
                lengthBytesUTF8: (value: string) => value.length,
            };
        }),
    };
});

// The generated WASM module is the real parser's external runtime boundary.
vi.mock('../../../../node_modules/react-native-enriched-markdown/src/web/wasm/md4c.js', () => ({
    default: wasmBoundary.factory,
}));

import {
    parseMarkdown,
    parseMarkdownSyncIfReady,
    preloadMarkdownRuntime,
} from '../../../../node_modules/react-native-enriched-markdown/src/web/parseMarkdown';

describe('enriched Markdown parser runtime recovery', () => {
    it('retries initialization but retains a warm runtime after one document parse fails', async () => {
        await expect(preloadMarkdownRuntime()).rejects.toThrow('simulated WASM initialization failure');
        await expect(preloadMarkdownRuntime()).resolves.toBeUndefined();
        expect(wasmBoundary.factory).toHaveBeenCalledTimes(2);

        await expect(parseMarkdown('invalid-document')).rejects.toThrow('WASM parser returned invalid AST');

        expect(parseMarkdownSyncIfReady('next-document')).toMatchObject({ type: 'Document' });
        expect(wasmBoundary.factory).toHaveBeenCalledTimes(2);
    });
});
