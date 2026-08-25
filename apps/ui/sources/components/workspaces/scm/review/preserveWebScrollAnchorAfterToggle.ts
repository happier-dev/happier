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
    params.requestFrame(() => {
        params.requestFrame(() => {
            const current = params.readCurrentAnchor();
            if (!current) return;
            const delta = current.anchorY - params.anchorY;
            if (Math.abs(delta) <= 1) return;
            current.scrollRoot.scrollTop = Math.max(0, current.scrollRoot.scrollTop + delta);
            params.onRestored?.(current.scrollRoot.scrollTop);
        });
    });
}
