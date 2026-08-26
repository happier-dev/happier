type ScrollRoot = {
    scrollTop: number;
};

type CurrentAnchor = Readonly<{
    scrollRoot: ScrollRoot;
    anchorY: number;
}>;

type RequestFrame = (callback: FrameRequestCallback) => unknown;

export function preserveWebScrollAnchorAfterToggle(params: Readonly<{
    anchorY: number;
    readCurrentAnchor: () => CurrentAnchor | null;
    requestFrame: RequestFrame;
    onRestored?: (scrollTop: number) => void;
}>): void {
    let remainingFrames = 12;
    const restoreAnchor = () => {
        const current = params.readCurrentAnchor();
        if (current) {
            const delta = current.anchorY - params.anchorY;
            if (Math.abs(delta) > 1) {
                current.scrollRoot.scrollTop = Math.max(0, current.scrollRoot.scrollTop + delta);
                params.onRestored?.(current.scrollRoot.scrollTop);
            }
        }
        remainingFrames -= 1;
        if (remainingFrames > 0) {
            params.requestFrame(restoreAnchor);
        }
    };
    params.requestFrame(restoreAnchor);
}
