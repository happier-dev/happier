import * as React from 'react';

import type { DaemonTerminalStreamEventUrl } from '@happier-dev/protocol';

import type { EmbeddedTerminalRendererHandle } from './embeddedTerminalRendererHandle';
import {
    createEmptyTerminalSurfaceState,
    readTerminalSurfaceState,
    replaceTerminalSurfaceState,
    subscribeTerminalSurfaceState,
    updateTerminalSurfaceState,
} from './terminalSurfaceStateCache';

export function useTerminalSurfaceState(params: Readonly<{
    terminalKey: string;
    terminalRef: React.MutableRefObject<EmbeddedTerminalRendererHandle | null>;
    terminalIdRef: React.MutableRefObject<string | null>;
    cursorRef: React.MutableRefObject<number>;
    terminalRendererHandleRef: React.MutableRefObject<EmbeddedTerminalRendererHandle | null>;
    clearNonceRef: React.MutableRefObject<number>;
}>) {
    const initialSurfaceState = React.useMemo(
        () => readTerminalSurfaceState(params.terminalKey) ?? createEmptyTerminalSurfaceState(),
        [params.terminalKey],
    );
    const [detectedUrl, setDetectedUrl] = React.useState<DaemonTerminalStreamEventUrl | null>(initialSurfaceState.detectedUrl);
    const renderedOutputRef = React.useRef('');

    const updateSurfaceState = React.useCallback((updater: (current: ReturnType<typeof createEmptyTerminalSurfaceState>) => ReturnType<typeof createEmptyTerminalSurfaceState>) => {
        return updateTerminalSurfaceState(params.terminalKey, updater);
    }, [params.terminalKey]);

    const replaceSurfaceState = React.useCallback((nextState: ReturnType<typeof createEmptyTerminalSurfaceState>) => {
        return replaceTerminalSurfaceState(params.terminalKey, nextState);
    }, [params.terminalKey]);

    const syncDetectedUrl = React.useCallback((nextUrl: DaemonTerminalStreamEventUrl | null) => {
        setDetectedUrl(nextUrl);
        updateSurfaceState((current) => ({
            ...current,
            terminalId: params.terminalIdRef.current,
            cursor: params.cursorRef.current,
            detectedUrl: nextUrl,
        }));
    }, [params.cursorRef, params.terminalIdRef, updateSurfaceState]);

    const clearTerminalOutput = React.useCallback(() => {
        params.clearNonceRef.current += 1;
        const renderer = params.terminalRef.current;
        if (renderer) {
            params.terminalRendererHandleRef.current = renderer;
            renderer.clear();
        }
        renderedOutputRef.current = '';
        updateSurfaceState((current) => ({
            ...current,
            terminalId: params.terminalIdRef.current,
            cursor: params.cursorRef.current,
            output: '',
        }));
    }, [params.clearNonceRef, params.cursorRef, params.terminalIdRef, params.terminalRef, params.terminalRendererHandleRef, renderedOutputRef, updateSurfaceState]);

    const writeTerminalOutput = React.useCallback((data: string) => {
        if (!data) {
            return;
        }
        const renderer = params.terminalRef.current;
        if (renderer) {
            params.terminalRendererHandleRef.current = renderer;
            renderer.write(data);
        }
        renderedOutputRef.current += data;
        updateSurfaceState((current) => ({
            ...current,
            terminalId: params.terminalIdRef.current,
            cursor: params.cursorRef.current,
            output: current.output + data,
        }));
    }, [params.cursorRef, params.terminalIdRef, params.terminalRef, params.terminalRendererHandleRef, renderedOutputRef, updateSurfaceState]);

    const applySurfaceStateToRenderer = React.useCallback((state: ReturnType<typeof createEmptyTerminalSurfaceState>) => {
        const renderer = params.terminalRef.current;
        params.terminalIdRef.current = state.terminalId;
        params.cursorRef.current = state.cursor;
        setDetectedUrl(state.detectedUrl);

        if (!renderer) {
            renderedOutputRef.current = state.output;
            return;
        }

        if (params.terminalRendererHandleRef.current !== renderer) {
            params.terminalRendererHandleRef.current = renderer;
            renderer.clear();
            renderedOutputRef.current = '';
        }

        if (state.output === renderedOutputRef.current) {
            return;
        }

        if (!state.output) {
            renderer.clear();
            renderedOutputRef.current = '';
            return;
        }

        if (state.output.startsWith(renderedOutputRef.current)) {
            const suffix = state.output.slice(renderedOutputRef.current.length);
            if (suffix) {
                renderer.write(suffix);
            }
            renderedOutputRef.current = state.output;
            return;
        }

        renderer.clear();
        renderer.write(state.output);
        renderedOutputRef.current = state.output;
    }, [params.cursorRef, params.terminalIdRef, params.terminalRef, params.terminalRendererHandleRef]);

    const hydrateTerminalRendererIfNeeded = React.useCallback(() => {
        const renderer = params.terminalRef.current;
        if (!renderer) {
            return;
        }
        if (params.terminalRendererHandleRef.current === renderer) {
            return;
        }

        applySurfaceStateToRenderer(readTerminalSurfaceState(params.terminalKey) ?? createEmptyTerminalSurfaceState());
    }, [applySurfaceStateToRenderer, params.terminalKey, params.terminalRef, params.terminalRendererHandleRef]);

    React.useEffect(() => {
        hydrateTerminalRendererIfNeeded();
    });

    React.useEffect(() => {
        return subscribeTerminalSurfaceState(params.terminalKey, (state) => {
            applySurfaceStateToRenderer(state);
        });
    }, [applySurfaceStateToRenderer, params.terminalKey]);

    React.useEffect(() => {
        const cached = readTerminalSurfaceState(params.terminalKey) ?? createEmptyTerminalSurfaceState();
        params.terminalIdRef.current = cached.terminalId;
        params.cursorRef.current = cached.cursor;
        params.terminalRendererHandleRef.current = null;
        renderedOutputRef.current = '';
        setDetectedUrl(cached.detectedUrl);
        params.terminalRef.current?.clear();
    }, [params.cursorRef, params.terminalIdRef, params.terminalKey, params.terminalRef, params.terminalRendererHandleRef]);

    return {
        initialSurfaceState,
        detectedUrl,
        updateSurfaceState,
        replaceSurfaceState,
        syncDetectedUrl,
        clearTerminalOutput,
        writeTerminalOutput,
        hydrateTerminalRendererIfNeeded,
        setDetectedUrl,
    } as const;
}
