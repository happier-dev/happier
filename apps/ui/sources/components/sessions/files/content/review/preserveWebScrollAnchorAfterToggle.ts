type ScrollRoot = {
    scrollTop: number;
};

type RequestFrame = (callback: FrameRequestCallback) => number;

export function preserveWebScrollAnchorAfterToggle(params: Readonly<{
    anchorY: number;
    scrollRoot: ScrollRoot;
    readAnchorY: () => number | null | undefined;
    requestFrame: RequestFrame;
}>): void {
    params.requestFrame(() => {
        params.requestFrame(() => {
            const currentY = params.readAnchorY();
            if (typeof currentY !== 'number') return;
            const delta = currentY - params.anchorY;
            if (Math.abs(delta) > 1) {
                params.scrollRoot.scrollTop += delta;
            }
        });
    });
}
