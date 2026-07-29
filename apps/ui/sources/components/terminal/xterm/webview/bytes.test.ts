import { describe, expect, it } from 'vitest';

import { decodeTerminalBytesBase64, encodeTerminalBytesBase64 } from './bytes';

describe('xterm WebView byte bridge helpers', () => {
    it('round-trips arbitrary terminal bytes through base64', () => {
        const bytes = new Uint8Array([0x00, 0xff, 0x41, 0xc3, 0x28]);

        const encoded = encodeTerminalBytesBase64(bytes);
        const decoded = decodeTerminalBytesBase64(encoded);

        expect(encoded).toBe('AP9Bwyg=');
        expect(decoded).toEqual(bytes);
    });
});
