import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';

import { useMachineTerminalSession } from './useMachineTerminalSession';

const machineTerminalEnsureMock = vi.hoisted(() => vi.fn());
const machineTerminalRestartMock = vi.hoisted(() => vi.fn());
const machineTerminalStreamReadMock = vi.hoisted(() => vi.fn());
const machineTerminalCloseMock = vi.hoisted(() => vi.fn());
const clearTerminalOutputMock = vi.hoisted(() => vi.fn());
const hydrateTerminalRendererIfNeededMock = vi.hoisted(() => vi.fn());
const replaceSurfaceStateMock = vi.hoisted(() => vi.fn());
const setDetectedUrlMock = vi.hoisted(() => vi.fn());
const syncDetectedUrlMock = vi.hoisted(() => vi.fn());
const updateSurfaceStateMock = vi.hoisted(() => vi.fn());
const writeTerminalOutputMock = vi.hoisted(() => vi.fn());
const onInputMock = vi.hoisted(() => vi.fn());
const onResizeMock = vi.hoisted(() => vi.fn());
const onReadyMock = vi.hoisted(() => vi.fn());
const initialTerminalSize = vi.hoisted(() => ({
    cols: 80,
    rows: 24,
}));
const latestTerminalSizeRef = vi.hoisted(() => ({
    current: initialTerminalSize,
}));
const terminalReaderLeaseState = vi.hoisted(() => ({
    ownerByKey: new Map<string, symbol>(),
}));

vi.mock('@/components/sessions/terminal/terminalSurfaceStateCache', () => ({
    createEmptyTerminalSurfaceState: () => ({
        terminalId: null,
        cursor: 0,
        output: '',
        detectedUrl: null,
    }),
    readTerminalSurfaceState: () => null,
}));

vi.mock('@/components/sessions/terminal/useEmbeddedTerminalTransportHandlers', () => ({
    useEmbeddedTerminalTransportHandlers: () => ({
        initialTerminalSize,
        latestTerminalSizeRef,
        onInput: onInputMock,
        onResize: onResizeMock,
        onReady: onReadyMock,
    }),
}));

vi.mock('@/components/sessions/terminal/useTerminalSurfaceState', () => ({
    useTerminalSurfaceState: () => ({
        detectedUrl: null,
        clearTerminalOutput: clearTerminalOutputMock,
        hydrateTerminalRendererIfNeeded: hydrateTerminalRendererIfNeededMock,
        replaceSurfaceState: replaceSurfaceStateMock,
        setDetectedUrl: setDetectedUrlMock,
        syncDetectedUrl: syncDetectedUrlMock,
        updateSurfaceState: updateSurfaceStateMock,
        writeTerminalOutput: writeTerminalOutputMock,
    }),
}));

vi.mock('@/sync/ops/machineTerminal', () => ({
    machineTerminalEnsure: (...args: unknown[]) => machineTerminalEnsureMock(...args),
    machineTerminalRestart: (...args: unknown[]) => machineTerminalRestartMock(...args),
    machineTerminalStreamRead: (...args: unknown[]) => machineTerminalStreamReadMock(...args),
    machineTerminalClose: (...args: unknown[]) => machineTerminalCloseMock(...args),
}));

vi.mock('@/components/sessions/terminal/terminalReaderLeaseRegistry', () => ({
    claimTerminalReaderLease: (terminalKey: string, ownerToken: symbol) => {
        const currentOwner = terminalReaderLeaseState.ownerByKey.get(terminalKey);
        if (currentOwner && currentOwner !== ownerToken) {
            return false;
        }
        terminalReaderLeaseState.ownerByKey.set(terminalKey, ownerToken);
        return true;
    },
    hasTerminalReaderLease: (terminalKey: string, ownerToken: symbol) =>
        terminalReaderLeaseState.ownerByKey.get(terminalKey) === ownerToken,
    releaseTerminalReaderLease: (terminalKey: string, ownerToken: symbol) => {
        if (terminalReaderLeaseState.ownerByKey.get(terminalKey) === ownerToken) {
            terminalReaderLeaseState.ownerByKey.delete(terminalKey);
        }
    },
    subscribeTerminalReaderLeaseAvailability: () => () => {},
}));

vi.mock('@/utils/timing/time', () => ({
    delay: vi.fn(async () => undefined),
}));

describe('useMachineTerminalSession', () => {
    beforeEach(() => {
        machineTerminalEnsureMock.mockReset();
        machineTerminalRestartMock.mockReset();
        machineTerminalStreamReadMock.mockReset();
        machineTerminalCloseMock.mockReset();
        terminalReaderLeaseState.ownerByKey.clear();
        clearTerminalOutputMock.mockReset();
        hydrateTerminalRendererIfNeededMock.mockReset();
        replaceSurfaceStateMock.mockReset();
        setDetectedUrlMock.mockReset();
        syncDetectedUrlMock.mockReset();
        updateSurfaceStateMock.mockReset();
        writeTerminalOutputMock.mockReset();
        onInputMock.mockReset();
        onResizeMock.mockReset();
        onReadyMock.mockReset();

        machineTerminalEnsureMock.mockResolvedValue({
            ok: true,
            terminalId: 'terminal-1',
            reused: false,
        });
        machineTerminalRestartMock.mockResolvedValue({
            ok: true,
            terminalId: 'terminal-2',
            reused: false,
        });
        machineTerminalStreamReadMock.mockResolvedValue({
            ok: true,
            terminalId: 'terminal-1',
            events: [],
            nextCursor: 0,
            done: true,
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('releases the reader lease after an early validation error so another pane can connect', async () => {
        const terminalRef = { current: null };
        const failed = await renderHook(() => useMachineTerminalSession({
            machineId: null,
            cwd: '/repo',
            machineReachable: true,
            machineRpcTargetAvailable: true,
            terminalKey: 'terminal-key-validation',
            terminalRef,
        }));
        await flushHookEffects();

        expect(failed.getCurrent().error).toBe('terminal_missing_machine_target');

        const next = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine-1',
            cwd: '/repo',
            machineReachable: true,
            machineRpcTargetAvailable: true,
            terminalKey: 'terminal-key-validation',
            terminalRef,
        }));
        await flushHookEffects();

        expect(machineTerminalEnsureMock).toHaveBeenCalledTimes(1);

        await failed.unmount();
        await next.unmount();
    });

    it('releases the reader lease after a fatal RPC failure so another pane can retry', async () => {
        const terminalRef = { current: null };
        machineTerminalEnsureMock.mockRejectedValueOnce(new Error('rpc exploded'));

        const failed = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine-1',
            cwd: '/repo',
            machineReachable: true,
            machineRpcTargetAvailable: true,
            terminalKey: 'terminal-key-rpc-error',
            terminalRef,
        }));
        await flushHookEffects();

        expect(failed.getCurrent().error).toBe('rpc exploded');

        const next = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine-1',
            cwd: '/repo',
            machineReachable: true,
            machineRpcTargetAvailable: true,
            terminalKey: 'terminal-key-rpc-error',
            terminalRef,
        }));
        await flushHookEffects();

        expect(machineTerminalEnsureMock).toHaveBeenCalledTimes(2);

        await failed.unmount();
        await next.unmount();
    });

    it.each([
        {
            name: 'the stream finishes with done',
            firstReadResult: {
                ok: true,
                terminalId: 'terminal-1',
                events: [],
                nextCursor: 0,
                done: true,
            },
        },
        {
            name: 'the stream emits exit',
            firstReadResult: {
                ok: true,
                terminalId: 'terminal-1',
                events: [{ t: 'exit', exitCode: 0 }],
                nextCursor: 0,
                done: false,
            },
        },
        {
            name: 'the stream fails with a non-recoverable error',
            firstReadResult: {
                ok: false,
                errorCode: 'terminal_session_missing',
            },
        },
    ])('releases the reader lease after $name so another pane can reconnect', async ({ firstReadResult }) => {
        const terminalRef = { current: null };
        machineTerminalStreamReadMock
            .mockResolvedValueOnce(firstReadResult)
            .mockResolvedValue({
                ok: true,
                terminalId: 'terminal-2',
                events: [],
                nextCursor: 0,
                done: true,
            });

        const finished = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine-1',
            cwd: '/repo',
            machineReachable: true,
            machineRpcTargetAvailable: true,
            terminalKey: 'terminal-key-stream-release',
            terminalRef,
        }));
        await flushHookEffects();

        const next = await renderHook(() => useMachineTerminalSession({
            machineId: 'machine-1',
            cwd: '/repo',
            machineReachable: true,
            machineRpcTargetAvailable: true,
            terminalKey: 'terminal-key-stream-release',
            terminalRef,
        }));
        await flushHookEffects();

        expect(machineTerminalEnsureMock).toHaveBeenCalledTimes(2);

        await finished.unmount();
        await next.unmount();
    });
});
