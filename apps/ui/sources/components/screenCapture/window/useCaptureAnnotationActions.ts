import * as React from 'react';
import type { ImageAnnotator } from '@/components/ui/media/annotation/types';
import { registerCaptureAnnotationTarget } from '@/desktop/capture/captureAnnotationActions';

/** An editor's annotation endpoint exists only for that mounted capture and its active lifetime. */
export function useCaptureAnnotationActions(captureRef: string, annotator: ImageAnnotator, signal?: AbortSignal): void {
    React.useEffect(() => {
        const lifetime = new AbortController();
        const stop = () => lifetime.abort();
        if (signal?.aborted) stop();
        else signal?.addEventListener('abort', stop, { once: true });
        void registerCaptureAnnotationTarget({ captureRef, annotator, signal: lifetime.signal }).catch(() => undefined);
        return () => {
            signal?.removeEventListener('abort', stop);
            stop();
        };
    }, [captureRef, annotator, signal]);
}
