export type AttachActionBarMouseDragScrollParams = Readonly<{
    node: HTMLElement;
    onScroll: () => void;
    /**
     * Pixel threshold before we treat the gesture as a drag (vs. click).
     * Defaults to 3.
     */
    dragThresholdPx?: number;
}>;

export function attachActionBarMouseDragScroll(params: AttachActionBarMouseDragScrollParams) {
    const dragThresholdPx = params.dragThresholdPx ?? 3;
    const node = params.node;
    const w = (globalThis as any).window as Window | undefined;

    let isDown = false;
    let startX = 0;
    let startScrollLeft = 0;
    let didDrag = false;

    const onMouseDown = (e: MouseEvent) => {
        if (e.button !== 0) return;
        isDown = true;
        startX = e.clientX;
        startScrollLeft = node.scrollLeft ?? 0;
        didDrag = false;
        try {
            node.style.cursor = 'grabbing';
        } catch {}
    };

    const onMouseMove = (e: MouseEvent) => {
        if (!isDown) return;
        const dx = e.clientX - startX;
        if (Math.abs(dx) > dragThresholdPx) didDrag = true;

        node.scrollLeft = (startScrollLeft ?? 0) - dx;
        params.onScroll();

        if (didDrag) {
            e.preventDefault();
        }
    };

    const onMouseUp = () => {
        isDown = false;
        try {
            node.style.cursor = 'grab';
        } catch {}
    };

    const onClickCapture = (e: MouseEvent) => {
        if (!didDrag) return;
        e.preventDefault();
        e.stopPropagation();
        didDrag = false;
    };

    try {
        node.style.cursor = 'grab';
    } catch {}

    node.addEventListener('mousedown', onMouseDown, { capture: true });
    // Listen on window so the drag continues even if the cursor leaves the node.
    w?.addEventListener?.('mousemove', onMouseMove, { capture: true } as any);
    w?.addEventListener?.('mouseup', onMouseUp, { capture: true } as any);
    node.addEventListener('click', onClickCapture, { capture: true });

    return () => {
        node.removeEventListener('mousedown', onMouseDown, { capture: true } as any);
        w?.removeEventListener?.('mousemove', onMouseMove, { capture: true } as any);
        w?.removeEventListener?.('mouseup', onMouseUp, { capture: true } as any);
        node.removeEventListener('click', onClickCapture, { capture: true } as any);
    };
}
