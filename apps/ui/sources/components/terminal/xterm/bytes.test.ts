import { describe, expect, it } from 'vitest';

import {
    buildXtermWriteCompleteEvent,
    copyTerminalBytes,
    decodeTerminalBytesForPreview,
    estimateUtf8ByteLength,
} from './bytes';

describe('xterm byte helpers', () => {
    it('copies byte chunks before enqueueing them into renderer queues', () => {
        const source = new Uint8Array([0x00, 0xff, 0x41]);
        const copy = copyTerminalBytes(source);

        source[2] = 0x42;

        expect(copy).toEqual(new Uint8Array([0x00, 0xff, 0x41]));
    });

    it('uses UTF-8 byte lengths for text caps and previews invalid bytes safely', () => {
        expect(estimateUtf8ByteLength('é€')).toBe(5);
        expect(decodeTerminalBytesForPreview(new Uint8Array([0x41, 0xff, 0x42]))).toBe('A\ufffdB');
    });

    it('builds write-complete ACK offsets from byte length', () => {
        expect(buildXtermWriteCompleteEvent({
            terminalId: 'terminal-1',
            seq: 9,
            byteOffset: 12,
            bytes: new Uint8Array([1, 2, 3]),
            writeGeneration: 7,
        })).toEqual({
            terminalId: 'terminal-1',
            seq: 9,
            byteOffset: 12,
            byteLength: 3,
            ackedByteOffset: 15,
            writeGeneration: 7,
        });
    });
});
