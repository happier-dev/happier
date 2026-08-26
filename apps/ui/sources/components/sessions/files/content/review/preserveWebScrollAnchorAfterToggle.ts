type ScrollRoot = {
    scrollTop: number;
};

type RequestFrame = (callback: FrameRequestCallback) => number;

export function preserveWebScrollAnchorAfterToggle(params: Readonly<{
    anchorY: number;
    resolveScrollRoot: () => ScrollRoot | null;
    readAnchorY: () => number | null | undefined;
    requestFrame: RequestFrame;
}>): void {
    let remainingFrames = 12;
    const restoreAnchor = () => {
        const currentY = params.readAnchorY();
        if (typeof currentY === 'number') {
            const delta = currentY - params.anchorY;
            const scrollRoot = params.resolveScrollRoot();
            if (scrollRoot && Math.abs(delta) > 1) {
                scrollRoot.scrollTop += delta;
            }
        }
        remainingFrames -= 1;
        if (remainingFrames > 0) {
            params.requestFrame(restoreAnchor);
        }
    };
    params.requestFrame(restoreAnchor);
}
