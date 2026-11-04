import * as React from 'react';
import type { ImageMarksDocumentV1 } from '@happier-dev/protocol';
import { NativeCaptureError, readNativeCaptureWindowText,
    requestNativeCapturePermission, subscribeNativeCapturePermissions,
    type NativeCaptureErrorCode, type NativeCaptureWindowText } from '@/desktop/capture/nativeCapture';
import { createCaptureDisclosureState, reduceCaptureDisclosure, reduceCaptureDisclosureDocument,
    type CaptureDisclosureEvent, type CaptureDisclosureState } from '../disclosure/captureDisclosureRule';

export type CaptureWindowTextRead = Readonly<{ status: 'idle' | 'loading' }>
    | Readonly<{ status: 'settled'; result: NativeCaptureWindowText }>
    | Readonly<{ status: 'failed'; errorCode: NativeCaptureErrorCode }>;

export type CaptureWindowText = Readonly<{
    disclosure: CaptureDisclosureState;
    read: CaptureWindowTextRead;
    setIncluded: (included: boolean) => void;
    resolveWarning: (include: boolean) => void;
    onDocumentChange: (document: ImageMarksDocumentV1, cause: 'edit' | 'undo' | 'redo') => void;
    onInput: () => void;
    prepareDisclosure: () => Promise<Readonly<{ includeWindowText: boolean }>>;
    requestPermission: () => Promise<void>;
}>;

type TextState = Readonly<{ captureRef: string | null; disclosure: CaptureDisclosureState; read: CaptureWindowTextRead;
    permissionRequired: boolean }>;
function initialState(captureRef: string | null, defaultIncluded: boolean): TextState {
    return { captureRef, disclosure: createCaptureDisclosureState(defaultIncluded), read: { status: 'idle' }, permissionRequired: false };
}

/** Transient state for the current capture; P1 owns text acquisition and its result. */
export function useCaptureWindowText(input: Readonly<{
    captureRef: string | null;
    defaultIncluded: boolean;
    signal?: AbortSignal;
    /** A video's disclosure lives in its recording document; this hook then only reads the text. */
    controlled?: Readonly<{ disclosure: CaptureDisclosureState; dispatch: (event: CaptureDisclosureEvent) => void }>;
}>): CaptureWindowText {
    const { captureRef, defaultIncluded, controlled, signal } = input;
    const [state, setState] = React.useState(() => initialState(captureRef, defaultIncluded));
    const included = (controlled?.disclosure ?? state.disclosure).included;
    const request = React.useRef<{ captureRef: string; promise: Promise<void>; pending: boolean; permissionRequired: boolean } | null>(null);
    const mounted = React.useRef(false);
    React.useEffect(() => { mounted.current = true; return () => {
        mounted.current = false;
        if (request.current?.pending) request.current = null;
    }; }, []);
    const readOnce = React.useCallback((afterPermission = false): Promise<void> => {
        if (!captureRef || !mounted.current || signal?.aborted) return Promise.resolve();
        const previous = request.current;
        if (previous?.captureRef === captureRef && (!afterPermission || previous.pending || !previous.permissionRequired)) return previous.promise;
        const active = { captureRef, promise: Promise.resolve(), pending: true, permissionRequired: previous?.captureRef === captureRef && previous.permissionRequired };
        request.current = active;
        setState(previous => ({ ...previous, read: { status: 'loading' } }));
        active.promise = readNativeCaptureWindowText(captureRef).then(result => {
            active.permissionRequired = result.status === 'unavailable' && result.reason === 'permission_required';
            if (mounted.current && !signal?.aborted && request.current === active) setState(previous => previous.captureRef === captureRef
                ? { ...previous, read: { status: 'settled', result }, permissionRequired: active.permissionRequired } : previous);
        }).catch((error: unknown) => {
            active.permissionRequired = false;
            const errorCode = error instanceof NativeCaptureError ? error.code : 'native_failure';
            if (mounted.current && !signal?.aborted && request.current === active) setState(previous => previous.captureRef === captureRef
                ? { ...previous, read: { status: 'failed', errorCode }, permissionRequired: false } : previous);
        }).finally(() => { active.pending = false; });
        return active.promise;
    }, [captureRef, signal]);
    React.useEffect(() => {
        if (state.captureRef !== captureRef) {
            setState(initialState(captureRef, defaultIncluded));
            return;
        }
        if (captureRef && included) void readOnce();
    }, [captureRef, defaultIncluded, state.captureRef, included, readOnce]);

    React.useEffect(() => {
        if (state.captureRef !== captureRef || !included || !state.permissionRequired) return;
        let disposed = false;
        let stop: (() => void) | undefined;
        void subscribeNativeCapturePermissions(snapshot => {
            if (!disposed && (snapshot.windowText === 'granted' || snapshot.windowText === 'not_required')) void readOnce(true);
        }, signal).then(unsubscribe => { if (disposed) unsubscribe(); else stop = unsubscribe; }).catch(() => undefined);
        return () => { disposed = true; stop?.(); };
    }, [captureRef, state.captureRef, included, state.permissionRequired, readOnce, signal]);

    const updateDisclosure = React.useCallback((update: (previous: CaptureDisclosureState) => CaptureDisclosureState) => {
        setState(previous => {
            const current = previous.captureRef === captureRef ? previous : initialState(captureRef, defaultIncluded);
            const disclosure = update(current.disclosure);
            return disclosure === current.disclosure ? current : { ...current, disclosure };
        });
    }, [captureRef, defaultIncluded]);
    const controlledDispatch = controlled?.dispatch;
    const dispatch = React.useCallback((event: CaptureDisclosureEvent) => {
        if (controlledDispatch) controlledDispatch(event);
        else updateDisclosure(previous => reduceCaptureDisclosure(previous, event));
    }, [controlledDispatch, updateDisclosure]);
    const setIncluded = React.useCallback((included: boolean) => dispatch({ type: 'toggle', included }), [dispatch]);
    const resolveWarning = React.useCallback((include: boolean) => dispatch({ type: 'warning', include }), [dispatch]);
    const onDocumentChange = React.useCallback((document: ImageMarksDocumentV1, cause: 'edit' | 'undo' | 'redo') => {
        if (!controlledDispatch) updateDisclosure(previous => reduceCaptureDisclosureDocument(previous, document, cause));
    }, [controlledDispatch, updateDisclosure]);
    const onInput = React.useCallback(() => dispatch({ type: 'input' }), [dispatch]);
    const current = state.captureRef === captureRef ? state : initialState(captureRef, defaultIncluded);
    const disclosure = controlled?.disclosure ?? current.disclosure;
    const prepareDisclosure = React.useCallback(async () => {
        const includeWindowText = disclosure.included;
        if (includeWindowText) await readOnce();
        return { includeWindowText };
    }, [disclosure.included, readOnce]);
    const requestPermission = React.useCallback(async () => {
        if (!disclosure.included) return;
        const { snapshot } = await requestNativeCapturePermission('window_text');
        if (signal?.aborted) return;
        if (snapshot.windowText === 'granted' || snapshot.windowText === 'not_required') await readOnce(true);
    }, [disclosure.included, readOnce, signal]);
    return { disclosure, read: current.read, setIncluded, resolveWarning, onDocumentChange, onInput,
        prepareDisclosure, requestPermission };
}
