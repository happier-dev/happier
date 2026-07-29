import { describe, expect, it } from 'vitest';

import { createTerminalStreamCreditState, applyTerminalRendererAck } from './credit';
import type { TerminalRendererAck } from './model';

describe('terminal stream credit', () => {
    it('accepts monotonic ACKs for the active renderer epoch', () => {
        const initial = createTerminalStreamCreditState({
            terminalId: 'term-1',
            rendererId: 'renderer-a',
            surfaceEpoch: 2,
            ackedByteOffset: 10,
            creditBytes: 1024,
        });
        const ack: TerminalRendererAck = {
            terminalId: 'term-1',
            rendererId: 'renderer-a',
            surfaceEpoch: 2,
            ackedByteOffset: 42,
            creditBytes: 2048,
        };

        const result = applyTerminalRendererAck(initial, ack);

        expect(result.accepted).toBe(true);
        expect(result.reason).toBeNull();
        expect(result.state.ackedByteOffset).toBe(42);
        expect(result.state.creditBytes).toBe(2048);
    });

    it('rejects stale ACKs from older renderer epochs', () => {
        const initial = createTerminalStreamCreditState({
            terminalId: 'term-1',
            rendererId: 'renderer-a',
            surfaceEpoch: 3,
            ackedByteOffset: 80,
            creditBytes: 1024,
        });

        const result = applyTerminalRendererAck(initial, {
            terminalId: 'term-1',
            rendererId: 'renderer-a',
            surfaceEpoch: 2,
            ackedByteOffset: 120,
            creditBytes: 4096,
        });

        expect(result.accepted).toBe(false);
        expect(result.reason).toBe('stale_epoch');
        expect(result.state).toEqual(initial);
    });

    it('rejects ACKs that move the acknowledged byte offset backwards', () => {
        const initial = createTerminalStreamCreditState({
            terminalId: 'term-1',
            rendererId: 'renderer-a',
            surfaceEpoch: 3,
            ackedByteOffset: 80,
            creditBytes: 1024,
        });

        const result = applyTerminalRendererAck(initial, {
            terminalId: 'term-1',
            rendererId: 'renderer-a',
            surfaceEpoch: 3,
            ackedByteOffset: 79,
            creditBytes: 4096,
        });

        expect(result.accepted).toBe(false);
        expect(result.reason).toBe('stale_offset');
        expect(result.state).toEqual(initial);
    });
});
