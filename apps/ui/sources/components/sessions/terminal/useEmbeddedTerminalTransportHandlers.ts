import * as React from 'react';

import { resolveTerminalPasteAction, type TerminalPasteAction } from '@/components/terminal/interaction/paste';
import { Modal } from '@/modal';
import type { TerminalInputEvent, TerminalStreamCarrier } from '@/sync/domains/terminal/stream/model';
import { t } from '@/text';

import { safeTimeoutClear, safeTimeoutSet } from './terminalRpcRecovery';

export type TerminalSize = Readonly<{ cols: number; rows: number }>;

export function useEmbeddedTerminalTransportHandlers(params: Readonly<{
    machineId: string | null;
    terminalIdRef: React.MutableRefObject<string | null>;
    terminalStreamCarrierRef: React.MutableRefObject<TerminalStreamCarrier | null>;
    onInputError?: (error: unknown) => void;
}>) {
    const [initialTerminalSize, setInitialTerminalSize] = React.useState<TerminalSize | null>(null);
    const latestTerminalSizeRef = React.useRef<TerminalSize | null>(null);

    const pendingInputRef = React.useRef('');
    const inputFlushTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const sendInputEvent = React.useCallback((event: TerminalInputEvent) => {
        if (!params.machineId) {
            return;
        }

        const terminalId = params.terminalIdRef.current;
        if (!terminalId) {
            return;
        }
        const carrier = params.terminalStreamCarrierRef.current;
        if (!carrier) {
            return;
        }

        void carrier.sendInput(terminalId, event).catch((error) => {
            params.onInputError?.(error);
        });
    }, [params.machineId, params.onInputError, params.terminalIdRef, params.terminalStreamCarrierRef]);

    const flushPendingInput = React.useCallback(() => {
        if (!params.machineId || !params.terminalIdRef.current || !params.terminalStreamCarrierRef.current) {
            return;
        }

        const data = pendingInputRef.current;
        pendingInputRef.current = '';
        if (!data) {
            return;
        }

        sendInputEvent({ t: 'text', text: data });
    }, [params.machineId, params.terminalIdRef, params.terminalStreamCarrierRef, sendInputEvent]);
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

    const onPaste = React.useCallback(async (text: string): Promise<TerminalPasteAction> => {
        const action = resolveTerminalPasteAction(text);
        if (action.kind === 'send') {
            sendInputEvent({ t: 'paste', text: action.input, bracketed: action.bracketed });
            return action;
        }
        if (action.kind === 'confirm') {
            const confirmed = await Modal.confirm(
                t('terminalEmbedded.largePasteTitle'),
                t('terminalEmbedded.largePasteDescription'),
                {
                    cancelText: t('common.cancel'),
                    confirmText: t('terminalEmbedded.largePasteConfirm'),
                },
            );
            if (confirmed) {
                sendInputEvent({
                    t: 'paste',
                    text: action.afterConfirm.input,
                    bracketed: action.afterConfirm.bracketed,
                });
            }
        }
        return action;
    }, [sendInputEvent]);

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

        const terminalId = params.terminalIdRef.current;
        if (!terminalId) {
            return;
        }

        safeTimeoutClear(resizeDebounceTimeoutRef.current);
        resizeDebounceTimeoutRef.current = safeTimeoutSet(() => {
            resizeDebounceTimeoutRef.current = null;
            const pending = pendingResizeRef.current;
            if (!pending) return;
            const carrier = params.terminalStreamCarrierRef.current;
            if (!carrier) return;
            void carrier.sendInput(terminalId, { t: 'resize', cols: pending.cols, rows: pending.rows }).catch((error) => {
                params.onInputError?.(error);
            });
        }, 120);
    }, [params.machineId, params.terminalIdRef, params.terminalStreamCarrierRef]);

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
        onPaste,
        onResize,
        onReady,
    } as const;
}
