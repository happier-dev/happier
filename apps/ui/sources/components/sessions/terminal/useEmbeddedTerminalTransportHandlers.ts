import * as React from 'react';

import { machineTerminalInput, machineTerminalResize } from '@/sync/ops/machineTerminal';

import { safeTimeoutClear, safeTimeoutSet } from './terminalRpcRecovery';

export type TerminalSize = Readonly<{ cols: number; rows: number }>;

export function useEmbeddedTerminalTransportHandlers(params: Readonly<{
    machineId: string | null;
    terminalIdRef: React.MutableRefObject<string | null>;
}>) {
    const [initialTerminalSize, setInitialTerminalSize] = React.useState<TerminalSize | null>(null);
    const latestTerminalSizeRef = React.useRef<TerminalSize | null>(null);

    const pendingInputRef = React.useRef('');
    const inputFlushTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const inputDrainTailRef = React.useRef<Promise<void>>(Promise.resolve());

    // Terminal input must be serialized per terminal instance: async encryption happens before
    // socket emission, so parallel machineTerminalInput calls can otherwise reach the daemon out of order.
    const sendBufferedInput = React.useCallback(() => {
        inputDrainTailRef.current = inputDrainTailRef.current.then(async () => {
            if (!params.machineId) return;
            const terminalId = params.terminalIdRef.current;
            if (!terminalId) return;

            const data = pendingInputRef.current;
            pendingInputRef.current = '';
            if (!data) return;

            try {
                await machineTerminalInput(params.machineId, { terminalId, data });
            } catch {
                // The read-loop owns error surfaces; ignore transient input failures.
            }
        }).catch(() => {
            // Defensive: keep the drain chain alive if surrounding logic unexpectedly throws.
        });
    }, [params.machineId, params.terminalIdRef]);
    const sendBufferedInputRef = React.useRef(sendBufferedInput);

    React.useEffect(() => {
        sendBufferedInputRef.current = sendBufferedInput;
    }, [sendBufferedInput]);

    const onInput = React.useCallback((data: string) => {
        if (!data) return;
        pendingInputRef.current += data;

        if (inputFlushTimeoutRef.current !== null) {
            return;
        }

        inputFlushTimeoutRef.current = safeTimeoutSet(() => {
            inputFlushTimeoutRef.current = null;
            void sendBufferedInput();
        }, 0);
    }, [sendBufferedInput]);

    React.useEffect(() => {
        if (!params.machineId) return;
        if (!params.terminalIdRef.current) return;
        if (!pendingInputRef.current) return;
        void sendBufferedInput();
    }, [params.machineId, params.terminalIdRef, sendBufferedInput]);

    const resizeDebounceTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingResizeRef = React.useRef<TerminalSize | null>(null);

    const onResize = React.useCallback((cols: number, rows: number) => {
        const nextSize: TerminalSize = { cols, rows };
        latestTerminalSizeRef.current = nextSize;
        setInitialTerminalSize((current) => current ?? nextSize);
        pendingResizeRef.current = nextSize;

        if (!params.machineId) {
            return;
        }
        const machineId = params.machineId;

        const terminalId = params.terminalIdRef.current;
        if (!terminalId) {
            return;
        }

        safeTimeoutClear(resizeDebounceTimeoutRef.current);
        resizeDebounceTimeoutRef.current = safeTimeoutSet(() => {
            resizeDebounceTimeoutRef.current = null;
            const pending = pendingResizeRef.current;
            if (!pending) return;
            void machineTerminalResize(machineId, { terminalId, cols: pending.cols, rows: pending.rows }).catch(() => {});
        }, 120);
    }, [params.machineId, params.terminalIdRef]);

    const onReady = React.useCallback((cols: number, rows: number) => {
        const nextSize: TerminalSize = { cols, rows };
        latestTerminalSizeRef.current = nextSize;
        setInitialTerminalSize((current) => current ?? nextSize);
    }, []);

    React.useEffect(() => {
        return () => {
            if (pendingInputRef.current) {
                void sendBufferedInputRef.current();
            }
            safeTimeoutClear(inputFlushTimeoutRef.current);
            inputFlushTimeoutRef.current = null;
            safeTimeoutClear(resizeDebounceTimeoutRef.current);
            resizeDebounceTimeoutRef.current = null;
        };
    }, []);

    return {
        initialTerminalSize,
        latestTerminalSizeRef,
        onInput,
        onResize,
        onReady,
    } as const;
}
