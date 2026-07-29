import { describe, expect, it, vi } from 'vitest';

import { createTerminalStreamRuntime } from './runtime';
import type {
    EmbeddedTerminalRendererHandle,
    EmbeddedTerminalWriteBytesResult,
} from '@/components/terminal/embedded/embeddedTerminalRendererHandle';

const queuedWriteResult = { status: 'queued' } satisfies EmbeddedTerminalWriteBytesResult;

describe('terminal stream runtime', () => {
    it('writes byte frames through writeBytes when the renderer supports bytes', async () => {
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(() => true),
            clear: vi.fn(),
        };
        const runtime = createTerminalStreamRuntime({
            terminalId: 'term-1',
            rendererId: 'renderer-a',
            renderer,
            surfaceEpoch: 1,
        });

        const result = runtime.applyFrames([
            {
                t: 'bytes',
                terminalId: 'term-1',
                seq: 1,
                byteOffset: 0,
                byteLength: 3,
                bytes: new Uint8Array([65, 66, 67]),
                source: 'byte-stream',
            },
        ]);

        expect(result.status).toBe('active');
        expect(result).toMatchObject({
            acceptedByteOffset: 3,
            rejectedByteOffset: null,
            queuedWrite: null,
        });
        expect(renderer.writeBytes).toHaveBeenCalledWith({
            terminalId: 'term-1',
            seq: 1,
            byteOffset: 0,
            bytes: new Uint8Array([65, 66, 67]),
        });
        expect(renderer.write).not.toHaveBeenCalled();
    });

    it('stops at rejected byte frames without accepting later frames', async () => {
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn((input) => input.byteOffset === 0),
            clear: vi.fn(),
        };
        const runtime = createTerminalStreamRuntime({
            terminalId: 'term-1',
            rendererId: 'renderer-a',
            renderer,
            surfaceEpoch: 1,
        });

        const result = runtime.applyFrames([
            {
                t: 'bytes',
                terminalId: 'term-1',
                seq: 1,
                byteOffset: 0,
                byteLength: 3,
                bytes: new Uint8Array([65, 66, 67]),
                source: 'byte-stream',
            },
            {
                t: 'bytes',
                terminalId: 'term-1',
                seq: 2,
                byteOffset: 3,
                byteLength: 3,
                bytes: new Uint8Array([68, 69, 70]),
                source: 'byte-stream',
            },
        ]);

        expect(result).toEqual({
            status: 'active',
            acceptedByteOffset: 3,
            rejectedByteOffset: 3,
            queuedWrite: null,
        });
        expect(renderer.writeBytes).toHaveBeenCalledTimes(2);
    });

    it('stops at queued async byte writes without accepting the frame cursor', async () => {
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(() => queuedWriteResult),
            clear: vi.fn(),
        };
        const runtime = createTerminalStreamRuntime({
            terminalId: 'term-1',
            rendererId: 'renderer-a',
            renderer,
            surfaceEpoch: 1,
        });

        const result = runtime.applyFrames([
            {
                t: 'bytes',
                terminalId: 'term-1',
                seq: 3,
                byteOffset: 12,
                byteLength: 3,
                bytes: new Uint8Array([65, 66, 67]),
                source: 'byte-stream',
            },
            {
                t: 'bytes',
                terminalId: 'term-1',
                seq: 4,
                byteOffset: 15,
                byteLength: 3,
                bytes: new Uint8Array([68, 69, 70]),
                source: 'byte-stream',
            },
        ]);

        expect(result).toEqual({
            status: 'active',
            acceptedByteOffset: null,
            rejectedByteOffset: null,
            queuedWrite: {
                terminalId: 'term-1',
                seq: 3,
                byteOffset: 12,
                byteLength: 3,
                ackedByteOffset: 15,
            },
        });
        expect(renderer.writeBytes).toHaveBeenCalledTimes(1);
    });

    it('falls back to decoded strings when a renderer has not implemented writeBytes yet', () => {
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            clear: vi.fn(),
        };
        const runtime = createTerminalStreamRuntime({
            terminalId: 'term-1',
            rendererId: 'renderer-a',
            renderer,
            surfaceEpoch: 1,
        });

        runtime.applyFrames([
            {
                t: 'bytes',
                terminalId: 'term-1',
                seq: 1,
                byteOffset: 0,
                byteLength: 3,
                bytes: new Uint8Array([65, 66, 67]),
                source: 'legacy-string',
            },
        ]);

        expect(renderer.write).toHaveBeenCalledWith('ABC');
    });

    it('preserves split UTF-8 sequences when falling back to string writes', () => {
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            clear: vi.fn(),
        };
        const runtime = createTerminalStreamRuntime({
            terminalId: 'term-1',
            rendererId: 'renderer-a',
            renderer,
            surfaceEpoch: 1,
        });

        runtime.applyFrames([
            {
                t: 'bytes',
                terminalId: 'term-1',
                seq: 1,
                byteOffset: 0,
                byteLength: 1,
                bytes: new Uint8Array([0xe2]),
                source: 'byte-stream',
            },
        ]);
        runtime.applyFrames([
            {
                t: 'bytes',
                terminalId: 'term-1',
                seq: 2,
                byteOffset: 1,
                byteLength: 2,
                bytes: new Uint8Array([0x82, 0xac]),
                source: 'byte-stream',
            },
        ]);

        expect(renderer.write).toHaveBeenCalledTimes(1);
        expect(renderer.write).toHaveBeenCalledWith('€');
    });

    it('routes gaps and URLs as host-owned control events', () => {
        const onGap = vi.fn();
        const onUrl = vi.fn();
        const runtime = createTerminalStreamRuntime({
            terminalId: 'term-1',
            rendererId: 'renderer-a',
            renderer: { write: vi.fn(), clear: vi.fn() },
            surfaceEpoch: 1,
            onGap,
            onUrl,
        });

        runtime.applyFrames([
            { t: 'gap', terminalId: 'term-1', droppedBefore: 8, reason: 'ring_overflow' },
            { t: 'url', terminalId: 'term-1', byteOffset: 9, url: 'https://example.com', kind: 'generic' },
        ]);

        expect(onGap).toHaveBeenCalledWith(expect.objectContaining({ droppedBefore: 8 }));
        expect(onUrl).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com' }));
    });
});
