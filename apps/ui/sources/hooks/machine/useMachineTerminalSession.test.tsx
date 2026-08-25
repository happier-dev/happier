import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import type {
    EmbeddedTerminalRendererHandle,
    EmbeddedTerminalWriteBytesResult,
    EmbeddedTerminalWriteCompleteEvent,
} from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { replaceTerminalSurfaceState } from '@/components/sessions/terminal/terminalSurfaceStateCache';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const terminalOps = vi.hoisted(() => ({
    ensure: vi.fn(),
    restart: vi.fn(),
    streamRead: vi.fn(),
    streamReadBytes: vi.fn(),
    streamAcknowledge: vi.fn(),
    streamSendInput: vi.fn(),
    close: vi.fn(),
    input: vi.fn(),
    resize: vi.fn(),
}));

const useFeatureEnabledMock = vi.hoisted(() => vi.fn((_featureId: string) => true));
const queuedWriteResult = { status: 'queued' } satisfies EmbeddedTerminalWriteBytesResult;
const clipboardState = vi.hoisted(() => ({
    setClipboardStringSafe: vi.fn(async () => true),
}));

function rendererWriteComplete(input: EmbeddedTerminalWriteCompleteEvent & Readonly<{
    writeGeneration: number;
}>): EmbeddedTerminalWriteCompleteEvent {
    return input;
}

function readWriteGeneration(value: unknown): number | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    const writeGeneration = (value as Readonly<{ writeGeneration?: unknown }>).writeGeneration;
    return typeof writeGeneration === 'number' && Number.isFinite(writeGeneration)
        ? writeGeneration
        : null;
}

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => useFeatureEnabledMock(featureId),
}));

vi.mock('@/sync/ops/machineTerminal', () => ({
    machineTerminalEnsure: (...args: unknown[]) => terminalOps.ensure(...args),
    machineTerminalRestart: (...args: unknown[]) => terminalOps.restart(...args),
    machineTerminalStreamRead: (...args: unknown[]) => terminalOps.streamRead(...args),
    machineTerminalStreamReadBytes: (...args: unknown[]) => terminalOps.streamReadBytes(...args),
    machineTerminalStreamAcknowledge: (...args: unknown[]) => terminalOps.streamAcknowledge(...args),
    machineTerminalStreamSendInput: (...args: unknown[]) => terminalOps.streamSendInput(...args),
    machineTerminalClose: (...args: unknown[]) => terminalOps.close(...args),
    machineTerminalInput: (...args: unknown[]) => terminalOps.input(...args),
    machineTerminalResize: (...args: unknown[]) => terminalOps.resize(...args),
}));

vi.mock('@/utils/ui/clipboard', () => ({
    setClipboardStringSafe: clipboardState.setClipboardStringSafe,
}));

describe('useMachineTerminalSession', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        terminalOps.ensure.mockReset();
        terminalOps.restart.mockReset();
        terminalOps.streamRead.mockReset();
        terminalOps.streamReadBytes.mockReset();
        terminalOps.streamAcknowledge.mockReset();
        terminalOps.streamSendInput.mockReset();
        terminalOps.close.mockReset();
        terminalOps.input.mockReset();
        terminalOps.resize.mockReset();
        useFeatureEnabledMock.mockReset();
        useFeatureEnabledMock.mockReturnValue(true);
        clipboardState.setClipboardStringSafe.mockReset();
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    it('keeps the stable terminal key on a typed session-attach request', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-attach', reused: false });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-attach',
            frames: [],
            nextByteOffset: 0,
            availableByteOffset: 0,
            droppedBeforeByteOffset: 0,
            done: true,
        });

        const terminalRef = {
            current: {
                write: vi.fn(),
                writeBytes: vi.fn(),
                clear: vi.fn(),
            } satisfies EmbeddedTerminalRendererHandle,
        };
        const launch = { kind: 'session_attach', sessionId: 'session-1' } as const;

        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: null,
                launch,
                terminalKey: 'session:session-1:attached',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.ensure).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            terminalKey: 'session:session-1:attached',
            launch: { kind: 'session_attach', sessionId: 'session-1' },
        }));

        await hook.unmount();
    });

    it('owns bounded title, bell, and user-selection copy policy at the session controller', async () => {
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            clear: vi.fn(),
            hasSelection: () => true,
            getSelectionText: () => 'selected terminal output',
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: null,
                cwd: null,
                terminalKey: 'session:terminal-presentation-policy',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );
        const controller = hook.getCurrent() as typeof hook extends { getCurrent: () => infer T } ? T & Readonly<{
            terminalTitle?: string | null;
            terminalBell?: string | null;
            copySelection?: (request?: Readonly<{ source: 'user-selection' | 'remote-osc52'; text: string }>) => void;
        }> : never;

        await act(async () => {
            controller.onTitle?.(`status\u001b[31m${'x'.repeat(160)}`);
            controller.onBell?.('ding\u0007\u001b[31m');
            controller.copySelection?.();
            controller.copySelection?.({ source: 'remote-osc52', text: 'remote clipboard payload' });
        });

        const updatedController = hook.getCurrent() as typeof controller;
        expect(updatedController.terminalTitle).toHaveLength(120);
        expect(updatedController.terminalTitle).toContain('status[31m');
        expect(updatedController.terminalTitle).not.toContain('\u001b');
        expect(updatedController.terminalBell).toBe('ding[31m');
        expect(clipboardState.setClipboardStringSafe).toHaveBeenCalledWith('selected terminal output');
        expect(clipboardState.setClipboardStringSafe).not.toHaveBeenCalledWith('remote clipboard payload');

        await hook.unmount();
    });

    it('credits synchronously accepted byte writes without accepting an unsolicited renderer completion', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-1', reused: false });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
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
            done: true,
        });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s1:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(renderer.writeBytes).toHaveBeenCalledWith(expect.objectContaining({
            terminalId: 'term-1',
            byteOffset: 0,
            bytes: new Uint8Array([65, 66, 67]),
        }));
        expect(terminalOps.streamReadBytes).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({ terminalId: 'term-1', byteOffset: 0 }),
            expect.any(Object),
        );
        expect(terminalOps.streamRead).not.toHaveBeenCalled();
        expect(renderer.write).not.toHaveBeenCalledWith('ABC');

        expect(terminalOps.streamAcknowledge).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({
                terminalId: 'term-1',
                ackedByteOffset: 3,
                rendererId: 'embedded-terminal',
            }),
            expect.any(Object),
        );

        const acknowledgementsBeforeUnsolicitedCompletion = terminalOps.streamAcknowledge.mock.calls.length;
        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-1',
                seq: 1,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 3,
                writeGeneration: 0,
            }));
        });

        expect(terminalOps.streamAcknowledge).toHaveBeenCalledTimes(acknowledgementsBeforeUnsolicitedCompletion);

        await hook.unmount();
    });

    it('does not advance the byte replay cursor when the renderer rejects a byte write', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-retry', reused: false });
        terminalOps.streamReadBytes
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-retry',
                frames: [{
                    t: 'bytes',
                    terminalId: 'term-retry',
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
            })
            .mockResolvedValue({
                ok: true,
                terminalId: 'term-retry',
                frames: [],
                nextByteOffset: 0,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(() => false),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-retry:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 5, turns: 2, runOnlyPendingTimers: true });

        expect(renderer.writeBytes).toHaveBeenCalledTimes(1);
        expect(terminalOps.streamReadBytes).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            expect.objectContaining({ terminalId: 'term-retry', byteOffset: 0 }),
            expect.any(Object),
        );
        expect(terminalOps.streamReadBytes).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            expect.objectContaining({ terminalId: 'term-retry', byteOffset: 0 }),
            expect.any(Object),
        );

        await hook.unmount();
    });

    it('waits for queued native write ACK before advancing the byte replay cursor', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-native-queue', reused: false });
        terminalOps.streamReadBytes
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-native-queue',
                frames: [{
                    t: 'bytes',
                    terminalId: 'term-native-queue',
                    seq: 5,
                    byteOffset: 0,
                    byteLength: 3,
                    encoding: 'base64',
                    data: 'QUJD',
                }],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            })
            .mockResolvedValue({
                ok: true,
                terminalId: 'term-native-queue',
                frames: [],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            });

        const writeBytes = vi.fn(() => queuedWriteResult);
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes,
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-native-queue:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(renderer.writeBytes).toHaveBeenCalledTimes(1);
        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-native-queue',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 99,
                writeGeneration: 0,
            }));
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);
        expect(terminalOps.streamAcknowledge).not.toHaveBeenCalled();

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-native-queue',
                seq: 5,
                byteOffset: 0,
                byteLength: 2,
                ackedByteOffset: 3,
                writeGeneration: 0,
            }));
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);
        expect(terminalOps.streamAcknowledge).not.toHaveBeenCalled();

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-native-queue',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 3,
                writeGeneration: 1,
            }));
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(1);
        expect(terminalOps.streamAcknowledge).not.toHaveBeenCalled();

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-native-queue',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 3,
                writeGeneration: 0,
            }));
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            expect.objectContaining({ terminalId: 'term-native-queue', byteOffset: 3 }),
            expect.any(Object),
        );
        expect(terminalOps.streamAcknowledge).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({
                terminalId: 'term-native-queue',
                ackedByteOffset: 3,
                rendererId: 'embedded-terminal',
            }),
            expect.any(Object),
        );

        const acknowledgedBeforeClear = terminalOps.streamAcknowledge.mock.calls.length;
        await act(async () => {
            hook.getCurrent().clearTerminal();
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-native-queue',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 3,
                writeGeneration: 0,
            }));
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamAcknowledge).toHaveBeenCalledTimes(acknowledgedBeforeClear);

        await hook.unmount();
    });

    it('rejects a same-identity parser completion from before terminal restart', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-restart-generation', reused: false });
        terminalOps.restart.mockResolvedValue({ ok: true, terminalId: 'term-restart-generation', reused: false });
        terminalOps.streamReadBytes
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-restart-generation',
                frames: [{
                    t: 'bytes',
                    terminalId: 'term-restart-generation',
                    seq: 5,
                    byteOffset: 0,
                    byteLength: 3,
                    encoding: 'base64',
                    data: 'QUJD',
                }],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            })
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-restart-generation',
                frames: [{
                    t: 'bytes',
                    terminalId: 'term-restart-generation',
                    seq: 5,
                    byteOffset: 0,
                    byteLength: 3,
                    encoding: 'base64',
                    data: 'QUJD',
                }],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            })
            .mockResolvedValue({
                ok: true,
                terminalId: 'term-restart-generation',
                frames: [],
                nextByteOffset: 3,
                availableByteOffset: 3,
                droppedBeforeByteOffset: 0,
                done: false,
            });

        const writeBytes = vi.fn(() => queuedWriteResult);
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes,
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-restart-generation:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        const initialGeneration = readWriteGeneration(writeBytes.mock.calls[0]?.[0]);
        expect(initialGeneration).not.toBeNull();

        await act(async () => {
            hook.getCurrent().requestRestart();
        });
        await flushHookEffects({ cycles: 5, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.restart).toHaveBeenCalledTimes(1);
        expect(writeBytes).toHaveBeenCalledTimes(2);
        const restartedGeneration = readWriteGeneration(writeBytes.mock.calls[1]?.[0]);
        expect(restartedGeneration).not.toBeNull();
        expect(restartedGeneration).not.toBe(initialGeneration);

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-restart-generation',
                seq: 5,
                byteOffset: 0,
                byteLength: 3,
                ackedByteOffset: 3,
                writeGeneration: initialGeneration!,
            }));
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamAcknowledge).not.toHaveBeenCalled();
        expect(terminalOps.streamReadBytes).toHaveBeenCalledTimes(2);

        await hook.unmount();
    });

    it('keeps the legacy event cursor and suppresses byte ACKs after a queued compatibility write', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-legacy-queue', reused: false });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: false,
            code: 'terminal_byte_stream_unavailable',
            message: 'older daemon',
        });
        terminalOps.streamRead
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-legacy-queue',
                events: [{ t: 'data', data: 'legacy' }],
                nextCursor: 1,
                done: false,
            })
            .mockResolvedValueOnce({
                ok: true,
                terminalId: 'term-legacy-queue',
                events: [],
                nextCursor: 1,
                done: true,
            });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(() => queuedWriteResult),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-legacy-queue:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.streamRead).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            { terminalId: 'term-legacy-queue', cursor: 0, maxBytes: undefined, maxEvents: undefined },
            expect.any(Object),
        );

        await act(async () => {
            hook.getCurrent().onWriteComplete(rendererWriteComplete({
                terminalId: 'term-legacy-queue',
                seq: 0,
                byteOffset: 0,
                byteLength: 6,
                ackedByteOffset: 6,
                writeGeneration: 0,
            }));
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.streamRead).toHaveBeenNthCalledWith(
            2,
            'machine-1',
            { terminalId: 'term-legacy-queue', cursor: 1, maxBytes: undefined, maxEvents: undefined },
            expect.any(Object),
        );
        expect(terminalOps.streamAcknowledge).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('clears cached preview output when it cannot be tied to the ensured terminal id', async () => {
        const terminalKey = 'session:s-stale:terminal';
        replaceTerminalSurfaceState(terminalKey, {
            terminalId: null,
            cursor: 42,
            output: 'stale cached terminal output',
            detectedUrl: null,
        });
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-fresh', reused: true });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-fresh',
            frames: [],
            nextByteOffset: 0,
            availableByteOffset: 0,
            droppedBeforeByteOffset: 0,
            done: true,
        });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey,
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(renderer.clear).toHaveBeenCalled();
        expect(renderer.write).not.toHaveBeenCalledWith('stale cached terminal output');
        expect(terminalOps.streamReadBytes).toHaveBeenCalledWith(
            'machine-1',
            expect.objectContaining({ terminalId: 'term-fresh', byteOffset: 0 }),
            expect.any(Object),
        );

        await hook.unmount();
    });

    it('routes user input through the stream carrier after connection', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-input', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({
            ok: true,
            terminalId: 'term-input',
            frames: [],
            nextByteOffset: 0,
            availableByteOffset: 0,
            droppedBeforeByteOffset: 0,
            done: false,
        });
        terminalOps.streamSendInput.mockResolvedValue({ ok: true });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-input:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        hook.getCurrent().onInput('ls\r');
        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });

        expect(terminalOps.streamSendInput).toHaveBeenCalledWith(
            'machine-1',
            {
                terminalId: 'term-input',
                event: { t: 'text', text: 'ls\r' },
            },
            expect.any(Object),
        );
        expect(terminalOps.input).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('stops routing user input after the stream read loop fails', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-input-error', reused: false });
        terminalOps.streamReadBytes.mockResolvedValueOnce({
            ok: false,
            code: 'terminal_rpc_target_unavailable',
            message: 'terminal RPC target unavailable',
        });
        terminalOps.streamSendInput.mockResolvedValue({ ok: true });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-input-error:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(hook.getCurrent().status).toBe('error');

        hook.getCurrent().onInput('echo hidden\r');
        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });

        expect(terminalOps.streamSendInput).not.toHaveBeenCalled();

        await hook.unmount();
    });

    it('recovers from stale terminal ids reported by stream input', async () => {
        terminalOps.ensure
            .mockResolvedValueOnce({ ok: true, terminalId: 'term-input-stale', reused: false })
            .mockResolvedValueOnce({ ok: true, terminalId: 'term-input-fresh', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({
            ok: true,
            terminalId: 'term-input-stale',
            frames: [],
            nextByteOffset: 0,
            availableByteOffset: 0,
            droppedBeforeByteOffset: 0,
            done: false,
        });
        terminalOps.streamSendInput
            .mockResolvedValueOnce({
                ok: false,
                code: 'terminal_not_found',
                message: 'terminal_not_found',
            })
            .mockResolvedValue({ ok: true });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-input-recovery:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        hook.getCurrent().onInput('echo stale\r');
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        await flushHookEffects({ cycles: 3, turns: 2, runOnlyPendingTimers: true });

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            status: 'connected',
            error: null,
        }));
        expect(terminalOps.ensure).toHaveBeenCalledTimes(2);
        expect(terminalOps.streamSendInput).toHaveBeenCalledTimes(1);
        expect(terminalOps.streamSendInput).toHaveBeenNthCalledWith(
            1,
            'machine-1',
            {
                terminalId: 'term-input-stale',
                event: { t: 'text', text: 'echo stale\r' },
            },
            expect.any(Object),
        );

        hook.getCurrent().onInput('echo fresh\r');
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamSendInput).toHaveBeenLastCalledWith(
            'machine-1',
            {
                terminalId: 'term-input-fresh',
                event: { t: 'text', text: 'echo fresh\r' },
            },
            expect.any(Object),
        );

        await hook.unmount();
    });

    it('recovers from stale terminal ids reported by scoped stream input RPC rejections', async () => {
        terminalOps.ensure
            .mockResolvedValueOnce({ ok: true, terminalId: 'term-rpc-stale', reused: false })
            .mockResolvedValueOnce({ ok: true, terminalId: 'term-rpc-fresh', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({
            ok: true,
            terminalId: 'term-rpc-stale',
            frames: [],
            nextByteOffset: 0,
            availableByteOffset: 0,
            droppedBeforeByteOffset: 0,
            done: false,
        });
        terminalOps.streamSendInput
            .mockRejectedValueOnce(Object.assign(new Error('terminal_not_found'), {
                rpcErrorCode: 'terminal_not_found',
            }))
            .mockResolvedValue({ ok: true });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-input-rpc-recovery:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        hook.getCurrent().onInput('echo stale rpc\r');
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });
        await flushHookEffects({ cycles: 3, turns: 2, runOnlyPendingTimers: true });

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            status: 'connected',
            error: null,
        }));
        expect(terminalOps.ensure).toHaveBeenCalledTimes(2);

        hook.getCurrent().onInput('echo fresh rpc\r');
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(terminalOps.streamSendInput).toHaveBeenLastCalledWith(
            'machine-1',
            {
                terminalId: 'term-rpc-fresh',
                event: { t: 'text', text: 'echo fresh rpc\r' },
            },
            expect.any(Object),
        );

        await hook.unmount();
    });

    it('reports non-recoverable stream input failures instead of silently staying connected', async () => {
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-input-failure', reused: false });
        terminalOps.streamReadBytes.mockResolvedValue({
            ok: true,
            terminalId: 'term-input-failure',
            frames: [],
            nextByteOffset: 0,
            availableByteOffset: 0,
            droppedBeforeByteOffset: 0,
            done: false,
        });
        terminalOps.streamSendInput.mockResolvedValueOnce({
            ok: false,
            code: 'terminal_rpc_target_unavailable',
            message: 'terminal RPC target unavailable',
        });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-input-failure:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        hook.getCurrent().onInput('echo hidden\r');
        await flushHookEffects({ cycles: 2, turns: 1, runOnlyPendingTimers: true });

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            status: 'error',
            error: 'terminal RPC target unavailable',
        }));

        await hook.unmount();
    });

    it('uses legacy event-cursor reads when terminal.transport.byteStream is disabled', async () => {
        useFeatureEnabledMock.mockImplementation((featureId: string) => featureId !== 'terminal.transport.byteStream');
        terminalOps.ensure.mockResolvedValue({ ok: true, terminalId: 'term-legacy-feature', reused: false });
        terminalOps.streamRead.mockResolvedValueOnce({
            ok: true,
            terminalId: 'term-legacy-feature',
            events: [{ t: 'data', data: 'legacy output' }],
            nextCursor: 1,
            done: true,
        });

        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(),
            clear: vi.fn(),
        };
        const terminalRef = { current: renderer };
        const { useMachineTerminalSession } = await import('./useMachineTerminalSession');
        const hook = await renderHook(
            () => useMachineTerminalSession({
                machineId: 'machine-1',
                cwd: '/repo',
                terminalKey: 'session:s-legacy-feature:terminal',
                terminalRef,
            }),
            { flushOptions: { cycles: 1, turns: 1 } },
        );

        await act(async () => {
            hook.getCurrent().onReady(80, 24);
        });
        await flushHookEffects({ cycles: 4, turns: 2, runOnlyPendingTimers: true });

        expect(terminalOps.streamReadBytes).not.toHaveBeenCalled();
        expect(terminalOps.streamRead).toHaveBeenCalledWith(
            'machine-1',
            {
                terminalId: 'term-legacy-feature',
                cursor: 0,
                maxBytes: undefined,
                maxEvents: undefined,
            },
            expect.any(Object),
        );
        expect(renderer.writeBytes).toHaveBeenCalledWith(expect.objectContaining({
            terminalId: 'term-legacy-feature',
            byteOffset: 0,
            bytes: new TextEncoder().encode('legacy output'),
        }));

        await hook.unmount();
    });
});
