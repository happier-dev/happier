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
    const flushPendingInput = React.useCallback(() => {
        if (!params.machineId) {
            return;
        }

        const terminalId = params.terminalIdRef.current;
        if (!terminalId) {
            return;
        }

        const data = pendingInputRef.current;
        pendingInputRef.current = '';
        if (!data) {
            return;
        }

        void machineTerminalInput(params.machineId, { terminalId, data }).catch(() => {
            // The read-loop owns error surfaces; ignore transient input failures.
        });
    }, [params.machineId, params.terminalIdRef]);
    const flushPendingInputRef = React.useRef(flushPendingInput);

    React.useEffect(() => {
        flushPendingInputRef.current = flushPendingInput;
    }, [flushPendingInput]);

    const onInput = React.useCallback((data: string) => {
        if (!data) return;
        pendingInputRef.current += data;

        if (inputFlushTimeoutRef.current !== null) {
            return;
        }

        inputFlushTimeoutRef.current = safeTimeoutSet(() => {
            inputFlushTimeoutRef.current = null;
            flushPendingInput();
        }, 0);
    }, [flushPendingInput]);

    React.useEffect(() => {
        if (!params.machineId) return;
        if (!params.terminalIdRef.current) return;
        if (!pendingInputRef.current) return;
        flushPendingInput();
    }, [flushPendingInput, params.machineId, params.terminalIdRef]);

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
                flushPendingInputRef.current();
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
