import * as React from 'react';

import type { DaemonTerminalStreamEventUrl } from '@happier-dev/protocol/daemon/terminal';

import type { EmbeddedTerminalRendererHandle } from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import type { TerminalOutputRetention } from '@/sync/domains/terminal/stream/model';
import {
    appendTerminalPreviewText,
    createEmptyTerminalSurfaceState,
    readTerminalSurfaceState,
    replaceTerminalSurfaceState,
    type TerminalSurfaceState,
    updateTerminalSurfaceState,
} from './terminalSurfaceStateCache';

/** What a surface shows of the daemon's retained window: whether earlier output was dropped. */
type TerminalOutputDisplayFacts = Readonly<{ terminalId: string; truncated: boolean; empty: boolean }>;

function toOutputDisplayFacts(terminalId: string | null, value: TerminalOutputRetention | null | undefined): TerminalOutputDisplayFacts | null {
    return terminalId && value ? { terminalId, truncated: value.truncated, empty: value.availableCursor === 0 } : null;
}

export function useTerminalSurfaceState(params: Readonly<{
    terminalKey: string;
    terminalRef: React.MutableRefObject<EmbeddedTerminalRendererHandle | null>;
    terminalIdRef: React.MutableRefObject<string | null>;
    cursorRef: React.MutableRefObject<number>;
    terminalRendererHandleRef: React.MutableRefObject<EmbeddedTerminalRendererHandle | null>;
    clearNonceRef: React.MutableRefObject<number>;
    hydrateOnRender?: boolean;
    onPreviewOutput?: (state: TerminalSurfaceState) => void;
}>) {
    const initialSurfaceState = React.useMemo(
        () => readTerminalSurfaceState(params.terminalKey) ?? createEmptyTerminalSurfaceState(),
        [params.terminalKey],
    );
    const [detectedUrl, setDetectedUrl] = React.useState<DaemonTerminalStreamEventUrl | null>(initialSurfaceState.detectedUrl);
    // The surface cache keeps the exact daemon window. React sees only changes
    // to emptiness and truncation, so cursor advances alone do not trigger a render.
    const [outputRetention, setOutputRetention] = React.useState<TerminalOutputDisplayFacts | null>(
        () => toOutputDisplayFacts(initialSurfaceState.terminalId, initialSurfaceState.outputRetention));
    const retentionRef = React.useRef<Readonly<{ terminalId: string; value: TerminalOutputRetention }> | null>(
        initialSurfaceState.terminalId && initialSurfaceState.outputRetention
            ? { terminalId: initialSurfaceState.terminalId, value: initialSurfaceState.outputRetention } : null);
    const publishedRetentionRef = React.useRef(outputRetention);
    const publishRetention = React.useCallback((next: TerminalOutputDisplayFacts | null) => {
        const published = publishedRetentionRef.current;
        if (published?.terminalId === next?.terminalId && published?.truncated === next?.truncated
            && published?.empty === next?.empty) return;
        publishedRetentionRef.current = next;
        setOutputRetention(next);
    }, []);

    const updateSurfaceState = React.useCallback((updater: (current: ReturnType<typeof createEmptyTerminalSurfaceState>) => ReturnType<typeof createEmptyTerminalSurfaceState>) => {
        return updateTerminalSurfaceState(params.terminalKey, updater);
    }, [params.terminalKey]);

    const replaceSurfaceState = React.useCallback((nextState: ReturnType<typeof createEmptyTerminalSurfaceState>) => {
        return replaceTerminalSurfaceState(params.terminalKey, nextState);
    }, [params.terminalKey]);

    const syncOutputRetention = React.useCallback((terminalId: string, value: TerminalOutputRetention | null) => {
        const current = retentionRef.current;
        // Polls can repeat the same window; record only a changed daemon fact.
        if (value === null ? current === null : current?.terminalId === terminalId
            && current.value.retainedFromCursor === value.retainedFromCursor
            && current.value.availableCursor === value.availableCursor
            && current.value.truncated === value.truncated) return;
        retentionRef.current = value ? { terminalId, value } : null;
        publishRetention(toOutputDisplayFacts(terminalId, value));
        updateSurfaceState(state => ({ ...state, terminalId, outputRetention: value ?? undefined }));
    }, [publishRetention, updateSurfaceState]);

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
        updateSurfaceState((current) => ({
            ...current,
            terminalId: params.terminalIdRef.current,
            cursor: params.cursorRef.current,
            output: '',
        }));
    }, [params.clearNonceRef, params.cursorRef, params.terminalIdRef, params.terminalRef, params.terminalRendererHandleRef, updateSurfaceState]);

    const recordTerminalPreviewOutput = React.useCallback((data: string) => {
        if (!data) return;
        const state = updateSurfaceState((current) => ({
            ...appendTerminalPreviewText(current, data),
            terminalId: params.terminalIdRef.current,
            cursor: params.cursorRef.current,
        }));
        params.onPreviewOutput?.(state);
    }, [params.cursorRef, params.onPreviewOutput, params.terminalIdRef, updateSurfaceState]);

    const writeTerminalOutput = React.useCallback((data: string) => {
        if (!data) {
            return true;
        }
        const renderer = params.terminalRef.current;
        if (renderer) {
            params.terminalRendererHandleRef.current = renderer;
            if (renderer.write(data) === false) {
                return false;
            }
        }
        recordTerminalPreviewOutput(data);
        return true;
    }, [params.terminalRef, params.terminalRendererHandleRef, recordTerminalPreviewOutput]);

    const hydrateTerminalRendererIfNeeded = React.useCallback(() => {
        const renderer = params.terminalRef.current;
        if (!renderer) {
            return;
        }
        if (params.terminalRendererHandleRef.current === renderer) {
            return;
        }

        params.terminalRendererHandleRef.current = renderer;
        if (renderer.hasRetainedOutput?.()) return;
        const cached = readTerminalSurfaceState(params.terminalKey) ?? createEmptyTerminalSurfaceState();
        renderer.clear();
        if (cached.output) {
            renderer.write(cached.output, { intent: 'replay' });
        }
    }, [params.terminalKey, params.terminalRef, params.terminalRendererHandleRef]);

    React.useEffect(() => {
        if (params.hydrateOnRender === false) {
            return;
        }
        hydrateTerminalRendererIfNeeded();
    });

    React.useEffect(() => {
        const cached = readTerminalSurfaceState(params.terminalKey) ?? createEmptyTerminalSurfaceState();
        params.terminalIdRef.current = cached.terminalId;
        params.cursorRef.current = cached.cursor;
        params.terminalRendererHandleRef.current = null;
        setDetectedUrl(cached.detectedUrl);
        retentionRef.current = cached.terminalId && cached.outputRetention
            ? { terminalId: cached.terminalId, value: cached.outputRetention } : null;
        publishRetention(toOutputDisplayFacts(cached.terminalId, cached.outputRetention));
        const renderer = params.terminalRef.current;
        // First-layout adoption may already own the complete parsed history, beyond the preview.
        if (!renderer?.hasRetainedOutput?.()) renderer?.clear();
    }, [params.cursorRef, params.terminalIdRef, params.terminalKey, params.terminalRef, params.terminalRendererHandleRef, publishRetention]);

    return {
        initialSurfaceState,
        detectedUrl,
        outputRetention,
        syncOutputRetention,
        updateSurfaceState,
        replaceSurfaceState,
        syncDetectedUrl,
        clearTerminalOutput,
        writeTerminalOutput,
        recordTerminalPreviewOutput,
        hydrateTerminalRendererIfNeeded,
        setDetectedUrl,
    } as const;
}
