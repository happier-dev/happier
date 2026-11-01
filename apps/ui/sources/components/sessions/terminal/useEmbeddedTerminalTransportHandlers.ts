import * as React from 'react';
import { TerminalInputEventSchema } from '@happier-dev/protocol/terminal/input';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';

import { resolveTerminalPasteAction, type TerminalPasteAction } from '@/components/terminal/interaction/paste';
import { Modal } from '@/modal';
import { readTerminalStreamInputErrorCode } from '@/sync/domains/terminal/stream/carrier';
import type { TerminalInputEvent, TerminalStreamCarrier } from '@/sync/domains/terminal/stream/model';
import { t } from '@/text';

import { safeTimeoutClear, safeTimeoutSet } from './terminalRpcRecovery';

export type TerminalSize = Readonly<{ cols: number; rows: number }>;

function normalizeTerminalSize(cols: number, rows: number): TerminalSize | null {
    const parsed = TerminalInputEventSchema.safeParse({ t: 'resize', cols, rows });
    return parsed.success && parsed.data.t === 'resize'
        ? { cols: parsed.data.cols, rows: parsed.data.rows }
        : null;
}

export function useEmbeddedTerminalTransportHandlers(params: Readonly<{
    machineId: string | null;
    readOnly?: boolean;
    terminalIdRef: React.MutableRefObject<string | null>;
    terminalStreamCarrierRef: React.MutableRefObject<TerminalStreamCarrier | null>;
    onInputError?: (error: unknown) => void;
}>) {
    const readOnlyRef = React.useRef(params.readOnly === true);
    readOnlyRef.current = params.readOnly === true;
    const [initialTerminalSize, setInitialTerminalSize] = React.useState<TerminalSize | null>(null);
    const latestTerminalSizeRef = React.useRef<TerminalSize | null>(null);

    const pendingInputRef = React.useRef('');
    type QueuedInput = Readonly<{
        event: Extract<TerminalInputEvent, { t: 'text' | 'paste' }>;
        terminalId: string | null;
        machineId: string | null;
    }>;
    const pendingInputTargetRef = React.useRef<Pick<QueuedInput, 'terminalId' | 'machineId'> | null>(null);
    const queuedInputRef = React.useRef<QueuedInput[]>([]);
    const inputInFlightRef = React.useRef<QueuedInput | null>(null);
    const failedCarrierRef = React.useRef<TerminalStreamCarrier | null>(null);
    const inputRecoveryRef = React.useRef(false);
    const [inputRecoveryAvailable, setInputRecoveryAvailable] = React.useState(false);
    const inputFlushTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const drainInputRef = React.useRef<() => void>(() => {});
    const drainInput = React.useCallback(() => {
        if (readOnlyRef.current || !params.machineId || inputInFlightRef.current || inputRecoveryRef.current) return;
        const terminalId = params.terminalIdRef.current;
        const carrier = params.terminalStreamCarrierRef.current;
        let queued = queuedInputRef.current[0];
        if (!terminalId || !carrier || !queued || carrier === failedCarrierRef.current) return;
        // Retained input belongs to this process. A restart must never type it into its replacement.
        if ((queued.machineId && queued.machineId !== params.machineId) || (queued.terminalId && queued.terminalId !== terminalId)) {
            inputRecoveryRef.current = true;
            setInputRecoveryAvailable(true);
            return;
        }
        // Input typed before attachment acquires its process identity at the first send.
        if (!queued.terminalId || !queued.machineId) {
            queued = { ...queued, terminalId, machineId: params.machineId };
            queuedInputRef.current[0] = queued;
        }
        inputInFlightRef.current = queued;
        void carrier.sendInput(terminalId, queued.event).then(() => {
            if (queuedInputRef.current[0] === queued) queuedInputRef.current.shift();
            inputInFlightRef.current = null;
            drainInputRef.current();
        }, (error: unknown) => {
            inputInFlightRef.current = null;
            failedCarrierRef.current = carrier;
            if (queuedInputRef.current[0] === queued && readRpcRequestDisposition(error) !== 'notSent') {
                // An acknowledgement may have been lost after the PTY wrote. Keep the entire tail for
                // explicit recovery; neither replaying it nor sending its Enter is safe automatically.
                inputRecoveryRef.current = true;
                setInputRecoveryAvailable(true);
            }
            if (params.terminalIdRef.current === terminalId && params.terminalStreamCarrierRef.current === carrier) {
                params.onInputError?.(error);
            }
            drainInputRef.current();
        });
    }, [params.machineId, params.onInputError, params.terminalIdRef, params.terminalStreamCarrierRef]);
    drainInputRef.current = drainInput;

    const sendInputEvent = React.useCallback((event: QueuedInput['event']) => {
        if (readOnlyRef.current) return;
        queuedInputRef.current.push({ event, terminalId: params.terminalIdRef.current, machineId: params.machineId });
        drainInput();
    }, [drainInput, params.machineId, params.terminalIdRef]);

    const flushPendingInput = React.useCallback(() => {
        if (readOnlyRef.current) {
            pendingInputRef.current = '';
            queuedInputRef.current = [];
            inputRecoveryRef.current = false;
            setInputRecoveryAvailable(false);
            return;
        }
        const data = pendingInputRef.current;
        pendingInputRef.current = '';
        if (data) {
            const target = pendingInputTargetRef.current ?? { terminalId: null, machineId: params.machineId };
            const tail = queuedInputRef.current.at(-1);
            if (tail && tail !== inputInFlightRef.current && tail.event.t === 'text'
                && (!tail.machineId || tail.machineId === target.machineId)
                && (!tail.terminalId || tail.terminalId === target.terminalId)) {
                queuedInputRef.current[queuedInputRef.current.length - 1] = {
                    ...target, event: { t: 'text', text: tail.event.text + data },
                };
            } else {
                queuedInputRef.current.push({ event: { t: 'text', text: data }, ...target });
            }
            pendingInputTargetRef.current = null;
        }
        drainInput();
    }, [drainInput, params.machineId]);
    const flushPendingInputRef = React.useRef(flushPendingInput);

    React.useEffect(() => {
        flushPendingInputRef.current = flushPendingInput;
    }, [flushPendingInput]);

    const onInput = React.useCallback((data: string) => {
        if (readOnlyRef.current || !data) return;
        if (!pendingInputRef.current) pendingInputTargetRef.current = {
            terminalId: params.terminalIdRef.current, machineId: params.machineId,
        };
        pendingInputRef.current += data;

        if (inputFlushTimeoutRef.current !== null) {
            return;
        }

        inputFlushTimeoutRef.current = safeTimeoutSet(() => {
            inputFlushTimeoutRef.current = null;
            flushPendingInput();
        }, 0);
    }, [flushPendingInput, params.machineId, params.terminalIdRef]);

    const onPaste = React.useCallback(async (text: string): Promise<TerminalPasteAction> => {
        if (readOnlyRef.current) return { kind: 'ignore', reason: 'read_only' };
        const action = resolveTerminalPasteAction(text);
        if (action.kind === 'send') {
            flushPendingInput();
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
                flushPendingInput();
                sendInputEvent({
                    t: 'paste',
                    text: action.afterConfirm.input,
                    bracketed: action.afterConfirm.bracketed,
                });
            }
        }
        return action;
    }, [flushPendingInput, sendInputEvent]);

    const readInputRecovery = React.useCallback(() => queuedInputRef.current.map(input => input.event.text).join('')
        + pendingInputRef.current, []);
    const discardInputRecovery = React.useCallback(() => {
        queuedInputRef.current = [];
        pendingInputRef.current = '';
        pendingInputTargetRef.current = null;
        inputRecoveryRef.current = false;
        failedCarrierRef.current = null;
        setInputRecoveryAvailable(false);
    }, []);

    React.useEffect(() => {
        if (!params.machineId) return;
        if (!params.terminalIdRef.current) return;
        if (!pendingInputRef.current) return;
        flushPendingInput();
    }, [flushPendingInput, params.machineId, params.terminalIdRef]);

    const resizeDebounceTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingResizeRef = React.useRef<TerminalSize | null>(null);

    const onResize = React.useCallback((cols: number, rows: number) => {
        const nextSize = normalizeTerminalSize(cols, rows);
        if (!nextSize) return;
        latestTerminalSizeRef.current = nextSize;
        setInitialTerminalSize((current) => current ?? nextSize);
        if (readOnlyRef.current) return;
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
            if (readOnlyRef.current) return;
            const pending = pendingResizeRef.current;
            if (!pending) return;
            if (params.terminalIdRef.current !== terminalId) return;
            const carrier = params.terminalStreamCarrierRef.current;
            if (!carrier) return;
            void carrier.sendInput(terminalId, { t: 'resize', cols: pending.cols, rows: pending.rows }).catch((error) => {
                if (params.terminalIdRef.current !== terminalId || params.terminalStreamCarrierRef.current !== carrier) return;
                // Fixed-size PTYs remain usable for input and output after an unsupported resize.
                if (readTerminalStreamInputErrorCode(error) === 'terminal_resize_unavailable') return;
                params.onInputError?.(error);
            });
        }, 120);
    }, [params.machineId, params.onInputError, params.terminalIdRef, params.terminalStreamCarrierRef]);

    const onReady = React.useCallback((cols: number, rows: number) => {
        const nextSize = normalizeTerminalSize(cols, rows);
        if (!nextSize) return;
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
        flushPendingInput,
        inputRecoveryAvailable,
        readInputRecovery,
        discardInputRecovery,
    } as const;
}
