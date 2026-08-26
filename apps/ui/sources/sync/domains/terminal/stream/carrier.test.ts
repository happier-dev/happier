import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

const machineTerminalStreamReadMock = vi.hoisted(() => vi.fn());
const machineTerminalStreamReadBytesMock = vi.hoisted(() => vi.fn());
const machineTerminalStreamAcknowledgeMock = vi.hoisted(() => vi.fn());
const machineTerminalStreamSendInputMock = vi.hoisted(() => vi.fn());
const machineTerminalInputMock = vi.hoisted(() => vi.fn());
const machineTerminalResizeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/machineTerminal', () => ({
    machineTerminalInput: machineTerminalInputMock,
    machineTerminalResize: machineTerminalResizeMock,
    machineTerminalStreamAcknowledge: machineTerminalStreamAcknowledgeMock,
    machineTerminalStreamRead: machineTerminalStreamReadMock,
    machineTerminalStreamReadBytes: machineTerminalStreamReadBytesMock,
    machineTerminalStreamSendInput: machineTerminalStreamSendInputMock,
}));

describe('machine RPC terminal stream carrier', () => {
    beforeEach(() => {
        machineTerminalStreamReadMock.mockReset();
        machineTerminalStreamReadBytesMock.mockReset();
        machineTerminalStreamAcknowledgeMock.mockReset();
        machineTerminalStreamSendInputMock.mockReset();
        machineTerminalInputMock.mockReset();
        machineTerminalResizeMock.mockReset();
    });

    it('uses the byte-stream RPC for byte-offset reads', async () => {
        machineTerminalStreamReadBytesMock.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-1',
            frames: [{
                t: 'bytes',
                terminalId: 'term-1',
                seq: 1,
                byteOffset: 0,
                byteLength: 3,
                encoding: 'base64',
                data: 'QUJD',
            }],
            nextByteOffset: 3,
            availableByteOffset: 3,
            droppedBeforeByteOffset: 0,
            done: false,
        });
        const { createMachineRpcTerminalStreamCarrier } = await import('./carrier');

        const carrier = createMachineRpcTerminalStreamCarrier({ machineId: 'machine-1', serverId: 'server-a' });
        const result = await carrier.read({
            terminalId: 'term-1',
            cursor: { mode: 'byte-offset', value: 0 },
            maxBytes: 64,
            maxFrames: 4,
            ackedByteOffset: 0,
            creditBytes: 128,
            rendererId: 'renderer-a',
            surfaceEpoch: 2,
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            terminalId: 'term-1',
            mode: 'byte-offset',
            nextCursor: 3,
        }));
        if (!result.ok) throw new Error('expected byte stream read');
        expect(result.frames[0]).toEqual(expect.objectContaining({
            t: 'bytes',
            byteOffset: 0,
            byteLength: 3,
            source: 'byte-stream',
        }));
        expect(machineTerminalStreamReadBytesMock).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({
                terminalId: 'term-1',
                byteOffset: 0,
                maxBytes: 64,
                maxFrames: 4,
                ackedByteOffset: 0,
                creditBytes: 128,
                rendererId: 'renderer-a',
                surfaceEpoch: 2,
            }),
            { serverId: 'server-a', timeoutMs: undefined },
        );
        expect(machineTerminalStreamReadMock).not.toHaveBeenCalled();
    });

    it('resets to the legacy event cursor when a byte-offset read falls back to legacy events', async () => {
        machineTerminalStreamReadBytesMock.mockResolvedValueOnce({
            ok: false,
            code: 'terminal_byte_stream_unavailable',
            message: 'unavailable',
        });
        machineTerminalStreamReadMock.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-1',
            events: [{ t: 'data', data: 'legacy' }],
            nextCursor: 11,
            done: false,
        });
        const { createMachineRpcTerminalStreamCarrier } = await import('./carrier');

        const carrier = createMachineRpcTerminalStreamCarrier({ machineId: 'machine-1' });
        const result = await carrier.read({
            terminalId: 'term-1',
            cursor: { mode: 'byte-offset', value: 9 },
            maxBytes: 64,
            maxFrames: 4,
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            mode: 'legacy-event-cursor',
            nextCursor: 11,
        }));
        expect(machineTerminalStreamReadMock).toHaveBeenCalledWith(
            'machine-1',
            { terminalId: 'term-1', cursor: 0, maxBytes: 64, maxEvents: 4 },
            { serverId: undefined, timeoutMs: undefined },
        );
        if (!result.ok) throw new Error('expected legacy fallback');
        expect(result.frames[0]).toEqual(expect.objectContaining({
            t: 'bytes',
            seq: 0,
            byteOffset: 0,
            source: 'legacy-string',
        }));
    });

    it.each([
        RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        RPC_ERROR_CODES.METHOD_NOT_FOUND,
    ])('negotiates legacy terminal streaming when a predecessor daemon rejects readBytes with %s', async (rpcErrorCode) => {
        machineTerminalStreamReadBytesMock.mockRejectedValueOnce(Object.assign(
            new Error('older daemon has no byte terminal stream'),
            { rpcErrorCode },
        ));
        machineTerminalStreamReadMock.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-1',
            events: [{ t: 'data', data: 'legacy' }],
            nextCursor: 1,
            done: false,
        });
        const { createMachineRpcTerminalStreamCarrier } = await import('./carrier');

        const carrier = createMachineRpcTerminalStreamCarrier({ machineId: 'machine-1' });
        const result = await carrier.read({
            terminalId: 'term-1',
            cursor: { mode: 'byte-offset', value: 9 },
            maxBytes: 64,
            maxFrames: 4,
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            mode: 'legacy-event-cursor',
            nextCursor: 1,
        }));
        expect(machineTerminalStreamReadMock).toHaveBeenCalledWith(
            'machine-1',
            { terminalId: 'term-1', cursor: 0, maxBytes: 64, maxEvents: 4 },
            { serverId: undefined, timeoutMs: undefined },
        );
    });

    it('preserves the legacy event cursor once legacy fallback mode is active', async () => {
        machineTerminalStreamReadMock.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-1',
            events: [{ t: 'data', data: 'legacy' }],
            nextCursor: 12,
            done: false,
        });
        const { createMachineRpcTerminalStreamCarrier } = await import('./carrier');

        const carrier = createMachineRpcTerminalStreamCarrier({ machineId: 'machine-1' });
        const result = await carrier.read({
            terminalId: 'term-1',
            cursor: { mode: 'legacy-event-cursor', value: 9 },
            maxBytes: 64,
            maxFrames: 4,
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            mode: 'legacy-event-cursor',
            nextCursor: 12,
        }));
        expect(machineTerminalStreamReadMock).toHaveBeenCalledWith(
            'machine-1',
            { terminalId: 'term-1', cursor: 9, maxBytes: 64, maxEvents: 4 },
            { serverId: undefined, timeoutMs: undefined },
        );
        expect(machineTerminalStreamReadBytesMock).not.toHaveBeenCalled();
    });

    it('routes acknowledgements and input events through TERM-2 stream RPC', async () => {
        machineTerminalStreamAcknowledgeMock.mockResolvedValueOnce({ ok: true });
        machineTerminalStreamSendInputMock.mockResolvedValueOnce({ ok: true });
        const { createMachineRpcTerminalStreamCarrier } = await import('./carrier');

        const carrier = createMachineRpcTerminalStreamCarrier({ machineId: 'machine-1', timeoutMs: 2000 });
        await carrier.acknowledge({
            terminalId: 'term-1',
            rendererId: 'renderer-a',
            surfaceEpoch: 2,
            ackedByteOffset: 24,
            creditBytes: 1024,
        });
        await carrier.sendInput('term-1', { t: 'paste', text: 'hello', bracketed: true });

        expect(machineTerminalStreamAcknowledgeMock).toHaveBeenCalledWith(
            'machine-1',
            {
                terminalId: 'term-1',
                rendererId: 'renderer-a',
                surfaceEpoch: 2,
                ackedByteOffset: 24,
                creditBytes: 1024,
            },
            { serverId: undefined, timeoutMs: 2000 },
        );
        expect(machineTerminalStreamSendInputMock).toHaveBeenCalledWith(
            'machine-1',
            { terminalId: 'term-1', event: { t: 'paste', text: 'hello', bracketed: true } },
            { serverId: undefined, timeoutMs: 2000 },
        );
        expect(machineTerminalInputMock).not.toHaveBeenCalled();
    });

    it.each([
        RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        RPC_ERROR_CODES.METHOD_NOT_FOUND,
    ])('negotiates legacy terminal input when a predecessor daemon rejects stream input with %s', async (rpcErrorCode) => {
        machineTerminalStreamSendInputMock.mockRejectedValueOnce(Object.assign(
            new Error('older daemon has no terminal stream input'),
            { rpcErrorCode },
        ));
        machineTerminalInputMock.mockResolvedValueOnce({ ok: true });
        const { createMachineRpcTerminalStreamCarrier } = await import('./carrier');

        const carrier = createMachineRpcTerminalStreamCarrier({ machineId: 'machine-1' });
        await carrier.sendInput('term-1', { t: 'text', text: 'clear\r' });

        expect(machineTerminalInputMock).toHaveBeenCalledWith(
            'machine-1',
            { terminalId: 'term-1', data: 'clear\r' },
            { serverId: undefined, timeoutMs: undefined },
        );
    });

    it.each([
        [RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, { t: 'mouse', kind: 'down', button: 0, x: 1, y: 1, modifiers: [] }],
        [RPC_ERROR_CODES.METHOD_NOT_FOUND, { t: 'key', key: 'Unsupported', modifiers: [] }],
    ] as const)('rejects unsupported legacy %s input with the canonical terminal error', async (rpcErrorCode, event) => {
        machineTerminalStreamSendInputMock.mockRejectedValueOnce(Object.assign(
            new Error('older daemon has no terminal stream input'),
            { rpcErrorCode },
        ));
        const { createMachineRpcTerminalStreamCarrier, readTerminalStreamInputErrorCode } = await import('./carrier');

        const carrier = createMachineRpcTerminalStreamCarrier({ machineId: 'machine-1' });
        let caught: unknown;
        await carrier.sendInput('term-1', event).catch((error) => {
            caught = error;
        });

        expect(readTerminalStreamInputErrorCode(caught)).toBe('terminal_input_unsupported');
        expect(machineTerminalInputMock).not.toHaveBeenCalled();
        expect(machineTerminalResizeMock).not.toHaveBeenCalled();
    });

    it('allows a no-op legacy fallback without a legacy mutation RPC', async () => {
        machineTerminalStreamSendInputMock.mockResolvedValueOnce({
            ok: false,
            code: 'terminal_byte_stream_unavailable',
            message: 'unavailable',
        });
        const { createMachineRpcTerminalStreamCarrier } = await import('./carrier');

        const carrier = createMachineRpcTerminalStreamCarrier({ machineId: 'machine-1' });
        await expect(carrier.sendInput('term-1', { t: 'ime', phase: 'start' })).resolves.toBeUndefined();

        expect(machineTerminalInputMock).not.toHaveBeenCalled();
        expect(machineTerminalResizeMock).not.toHaveBeenCalled();
    });

    it('does not start a second input send while the previous send is still in flight', async () => {
        let resolveFirst: (() => void) | undefined;
        machineTerminalStreamSendInputMock
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveFirst = () => resolve({ ok: true });
            }))
            .mockResolvedValueOnce({ ok: true });
        const { createMachineRpcTerminalStreamCarrier } = await import('./carrier');

        const carrier = createMachineRpcTerminalStreamCarrier({ machineId: 'machine-1' });
        const first = carrier.sendInput('term-1', { t: 'text', text: 'g' });
        await Promise.resolve();
        expect(machineTerminalStreamSendInputMock).toHaveBeenCalledTimes(1);

        const second = carrier.sendInput('term-1', { t: 'text', text: 'it status' });
        await Promise.resolve();
        expect(machineTerminalStreamSendInputMock).toHaveBeenCalledTimes(1);

        expect(resolveFirst).toBeDefined();
        resolveFirst?.();
        await first;
        await second;

        expect(machineTerminalStreamSendInputMock).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            { terminalId: 'term-1', event: { t: 'text', text: 'it status' } },
            { serverId: undefined, timeoutMs: undefined },
        );
    });

    it('continues queued input sends after a transient send failure', async () => {
        let rejectFirst: ((error: Error) => void) | undefined;
        machineTerminalStreamSendInputMock
            .mockImplementationOnce(() => new Promise((_resolve, reject) => {
                rejectFirst = reject;
            }))
            .mockResolvedValueOnce({ ok: true });
        const { createMachineRpcTerminalStreamCarrier } = await import('./carrier');

        const carrier = createMachineRpcTerminalStreamCarrier({ machineId: 'machine-1' });
        const first = carrier.sendInput('term-1', { t: 'text', text: 'git ' }).catch(() => undefined);
        await Promise.resolve();
        expect(machineTerminalStreamSendInputMock).toHaveBeenCalledTimes(1);

        const second = carrier.sendInput('term-1', { t: 'text', text: 'status' });
        await Promise.resolve();
        expect(machineTerminalStreamSendInputMock).toHaveBeenCalledTimes(1);

        expect(rejectFirst).toBeDefined();
        rejectFirst?.(new Error('transient'));
        await first;
        await second;

        expect(machineTerminalStreamSendInputMock).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            { terminalId: 'term-1', event: { t: 'text', text: 'status' } },
            { serverId: undefined, timeoutMs: undefined },
        );
    });

    it('keeps fallback input writes ordered before later stream input sends', async () => {
        let resolveFallback: (() => void) | undefined;
        machineTerminalStreamSendInputMock
            .mockResolvedValueOnce({ ok: false, code: 'terminal_byte_stream_unavailable' })
            .mockResolvedValueOnce({ ok: true });
        machineTerminalInputMock.mockImplementationOnce(() => new Promise((resolve) => {
            resolveFallback = () => resolve({ ok: true });
        }));
        const { createMachineRpcTerminalStreamCarrier } = await import('./carrier');

        const carrier = createMachineRpcTerminalStreamCarrier({ machineId: 'machine-1' });
        const first = carrier.sendInput('term-1', { t: 'text', text: 'git ' });
        await Promise.resolve();
        await Promise.resolve();
        expect(machineTerminalStreamSendInputMock).toHaveBeenCalledTimes(1);
        expect(machineTerminalInputMock).toHaveBeenCalledTimes(1);

        const second = carrier.sendInput('term-1', { t: 'text', text: 'status' });
        await Promise.resolve();
        expect(machineTerminalStreamSendInputMock).toHaveBeenCalledTimes(1);

        expect(resolveFallback).toBeDefined();
        resolveFallback?.();
        await first;
        await second;

        expect(machineTerminalStreamSendInputMock).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            { terminalId: 'term-1', event: { t: 'text', text: 'status' } },
            { serverId: undefined, timeoutMs: undefined },
        );
    });

    it('rejects non-fallback stream input failures instead of treating them as sent', async () => {
        machineTerminalStreamSendInputMock.mockResolvedValueOnce({
            ok: false,
            code: 'terminal_not_found',
            message: 'terminal_not_found',
        });
        const { createMachineRpcTerminalStreamCarrier } = await import('./carrier');

        const carrier = createMachineRpcTerminalStreamCarrier({ machineId: 'machine-1' });

        await expect(carrier.sendInput('term-missing', { t: 'text', text: 'echo hidden\r' }))
            .rejects.toThrow('terminal_not_found');
        expect(machineTerminalInputMock).not.toHaveBeenCalled();
        expect(machineTerminalResizeMock).not.toHaveBeenCalled();
    });

    it('rejects legacy fallback input failures with the structured terminal error code', async () => {
        machineTerminalStreamSendInputMock.mockResolvedValueOnce({
            ok: false,
            code: 'terminal_byte_stream_unavailable',
            message: 'unavailable',
        });
        machineTerminalInputMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'terminal_not_found',
            error: 'terminal_not_found',
        });
        const {
            createMachineRpcTerminalStreamCarrier,
            readTerminalStreamInputErrorCode,
        } = await import('./carrier');

        const carrier = createMachineRpcTerminalStreamCarrier({ machineId: 'machine-1' });
        let caught: unknown;
        await carrier.sendInput('term-missing', { t: 'text', text: 'echo hidden\r' }).catch((error) => {
            caught = error;
        });

        expect(caught).toBeInstanceOf(Error);
        expect(caught).toEqual(expect.objectContaining({ message: 'terminal_not_found' }));
        expect(readTerminalStreamInputErrorCode(caught)).toBe('terminal_not_found');
    });

    it('rejects legacy fallback resize failures with the structured terminal error code', async () => {
        machineTerminalStreamSendInputMock.mockResolvedValueOnce({
            ok: false,
            code: 'terminal_byte_stream_unavailable',
            message: 'unavailable',
        });
        machineTerminalResizeMock.mockResolvedValueOnce({
            ok: false,
            errorCode: 'terminal_not_found',
            error: 'terminal_not_found',
        });
        const {
            createMachineRpcTerminalStreamCarrier,
            readTerminalStreamInputErrorCode,
        } = await import('./carrier');

        const carrier = createMachineRpcTerminalStreamCarrier({ machineId: 'machine-1' });
        let caught: unknown;
        await carrier.sendInput('term-missing', { t: 'resize', cols: 120, rows: 40 }).catch((error) => {
            caught = error;
        });

        expect(caught).toBeInstanceOf(Error);
        expect(caught).toEqual(expect.objectContaining({ message: 'terminal_not_found' }));
        expect(readTerminalStreamInputErrorCode(caught)).toBe('terminal_not_found');
    });

    it('prefers structured RPC input error codes over generic transport codes', async () => {
        const { readTerminalStreamInputErrorCode } = await import('./carrier');
        const error = Object.assign(new Error('terminal_not_found'), {
            code: 'ERR_SOCKET_CLOSED',
            rpcErrorCode: 'terminal_not_found',
        });

        expect(readTerminalStreamInputErrorCode(error)).toBe('terminal_not_found');
    });

    it('encodes only safe legacy input fallbacks when TERM-2 input is unavailable', async () => {
        machineTerminalStreamSendInputMock.mockResolvedValue({ ok: false, code: 'terminal_byte_stream_unavailable' });
        machineTerminalInputMock.mockResolvedValue({ ok: true });
        machineTerminalResizeMock.mockResolvedValue({ ok: true });
        const { createMachineRpcTerminalStreamCarrier } = await import('./carrier');

        const carrier = createMachineRpcTerminalStreamCarrier({ machineId: 'machine-1' });
        await carrier.sendInput('term-1', { t: 'paste', text: 'a\nb', bracketed: true });
        await carrier.sendInput('term-1', { t: 'key', key: 'Enter', modifiers: [] });
        await expect(carrier.sendInput('term-1', {
            t: 'mouse',
            kind: 'down',
            button: 0,
            x: 1,
            y: 1,
            modifiers: [],
        })).rejects.toEqual(expect.objectContaining({ code: 'terminal_input_unsupported' }));
        await carrier.sendInput('term-1', { t: 'resize', cols: 100, rows: 30 });

        expect(machineTerminalInputMock).toHaveBeenCalledTimes(2);
        expect(machineTerminalInputMock).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            { terminalId: 'term-1', data: '\u001b[200~a\rb\u001b[201~' },
            { serverId: undefined, timeoutMs: undefined },
        );
        expect(machineTerminalInputMock).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            { terminalId: 'term-1', data: '\r' },
            { serverId: undefined, timeoutMs: undefined },
        );
        expect(machineTerminalResizeMock).toHaveBeenCalledWith(
            'machine-1',
            { terminalId: 'term-1', cols: 100, rows: 30 },
            { serverId: undefined, timeoutMs: undefined },
        );
    });
});
