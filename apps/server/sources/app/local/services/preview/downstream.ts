type LocalServicePreviewDownstreamEvent = "close" | "drain" | "error";

export type LocalServicePreviewWritableDownstream = {
    write?: (chunk: Uint8Array) => unknown;
    once?: (event: LocalServicePreviewDownstreamEvent, listener: () => void) => unknown;
    on?: (event: LocalServicePreviewDownstreamEvent, listener: () => void) => unknown;
    off?: (event: LocalServicePreviewDownstreamEvent, listener: () => void) => unknown;
    removeListener?: (event: LocalServicePreviewDownstreamEvent, listener: () => void) => unknown;
    destroyed?: boolean;
    writableEnded?: boolean;
};

function addDownstreamListener(
    downstream: LocalServicePreviewWritableDownstream,
    event: LocalServicePreviewDownstreamEvent,
    listener: () => void,
): void {
    if (downstream.once) {
        downstream.once(event, listener);
        return;
    }
    downstream.on?.(event, listener);
}

function removeDownstreamListener(
    downstream: LocalServicePreviewWritableDownstream,
    event: LocalServicePreviewDownstreamEvent,
    listener: () => void,
): void {
    downstream.off?.(event, listener);
    downstream.removeListener?.(event, listener);
}

export function waitForLocalServicePreviewDownstreamDrain(
    downstream: LocalServicePreviewWritableDownstream,
): Promise<void> {
    if (downstream.destroyed || downstream.writableEnded) {
        return Promise.reject(new Error("downstream_closed_before_drain"));
    }

    return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            removeDownstreamListener(downstream, "drain", onDrain);
            removeDownstreamListener(downstream, "close", onClose);
            removeDownstreamListener(downstream, "error", onError);
        };
        const onDrain = () => {
            cleanup();
            resolve();
        };
        const onClose = () => {
            cleanup();
            reject(new Error("downstream_closed_before_drain"));
        };
        const onError = () => {
            cleanup();
            reject(new Error("downstream_error_before_drain"));
        };

        addDownstreamListener(downstream, "drain", onDrain);
        addDownstreamListener(downstream, "close", onClose);
        addDownstreamListener(downstream, "error", onError);
    });
}

export function writeLocalServicePreviewDownstream(
    downstream: LocalServicePreviewWritableDownstream | undefined,
    chunk: Uint8Array,
): void | Promise<void> {
    const result = downstream?.write?.(chunk);
    return result === false && downstream
        ? waitForLocalServicePreviewDownstreamDrain(downstream)
        : undefined;
}
