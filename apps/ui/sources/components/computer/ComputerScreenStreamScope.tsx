import * as React from 'react';

import {
    resolveBrowserStreamedSurfaceState,
    useFirstFrameSize,
    type BrowserStreamedSurfaceRuntime,
} from '@/components/browser/adapters/BrowserStreamedTarget';

import { useComputerScreenStream, type ComputerScreenStreamInput } from './useComputerScreenStream';

export type ComputerScreenStreamRequest = ComputerScreenStreamInput & Readonly<{
    onStatusChange: () => void;
}>;

type ComputerScreenChrome = Readonly<{
    hasPlayer: boolean;
    connecting: boolean;
    surfaceState: ReturnType<typeof resolveBrowserStreamedSurfaceState>;
    phase: NonNullable<BrowserStreamedSurfaceRuntime['playerState']>['phase'] | undefined;
    diagnosticCode: string | undefined;
    pausedAtMs: number | undefined;
    frameSize: ReturnType<typeof useFirstFrameSize>;
    input: BrowserStreamedSurfaceRuntime['input'];
    onRetry: BrowserStreamedSurfaceRuntime['onRetry'];
}>;

const ChromeContext = React.createContext<ComputerScreenChrome>({
    hasPlayer: false, connecting: false, surfaceState: 'unavailable', phase: undefined,
    diagnosticCode: undefined, pausedAtMs: undefined, frameSize: null, input: null, onRetry: undefined,
});
const PictureContext = React.createContext<BrowserStreamedSurfaceRuntime | null>(null);

/** The existing relay owner lives below both Session and Machine control models. */
export function ComputerScreenStreamOwner(props: React.PropsWithChildren<Readonly<{
    input: ComputerScreenStreamRequest;
}>>): React.ReactElement {
    const runtime = useComputerScreenStream(props.input);
    const phase = runtime?.playerState?.phase ?? null;
    const { enabled, onStatusChange } = props.input;
    // Source availability changes refresh control; changing image URLs do not.
    React.useEffect(() => { if (enabled !== false) onStatusChange(); }, [enabled, onStatusChange, phase]);
    return <ComputerScreenStreamScope runtime={runtime}>{props.children}</ComputerScreenStreamScope>;
}

/** Chrome consumes only lifecycle, input and geometry; only the picture consumes frames. */
export function ComputerScreenStreamScope(props: React.PropsWithChildren<Readonly<{
    runtime: BrowserStreamedSurfaceRuntime | null;
}>>): React.ReactElement {
    const runtime = props.runtime;
    const player = runtime?.playerState;
    const hasPlayer = player != null;
    const connecting = runtime?.connecting === true;
    const surfaceState = resolveBrowserStreamedSurfaceState(player ?? null);
    const phase = player?.phase;
    const diagnosticCode = player?.diagnostic?.reasonCode;
    const pausedAtMs = surfaceState === 'stalled' ? player?.lastFrameAtMs : undefined;
    const pictureUp = surfaceState === 'live' || surfaceState === 'stalled';
    const frameSize = useFirstFrameSize(pictureUp ? player?.lastFrameUrl : null, phase);
    const input = runtime?.input;
    const onRetry = runtime?.onRetry;
    const chrome = React.useMemo<ComputerScreenChrome>(() => ({
        hasPlayer, connecting, surfaceState, phase, diagnosticCode, pausedAtMs, frameSize, input, onRetry,
    }), [hasPlayer, connecting, surfaceState, phase, diagnosticCode, pausedAtMs, frameSize, input, onRetry]);
    return <ChromeContext.Provider value={chrome}>
        <PictureContext.Provider value={runtime}>{props.children}</PictureContext.Provider>
    </ChromeContext.Provider>;
}

export function useComputerScreenChrome(): ComputerScreenChrome {
    return React.useContext(ChromeContext);
}

export function useComputerScreenPicture(): BrowserStreamedSurfaceRuntime | null {
    return React.useContext(PictureContext);
}
