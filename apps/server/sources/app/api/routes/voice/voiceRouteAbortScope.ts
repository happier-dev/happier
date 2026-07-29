interface AbortableVoiceReplyRaw {
    readonly destroyed?: boolean;
    readonly writableEnded?: boolean;
    on(event: "close" | "error", listener: () => void): unknown;
    off?(event: "close" | "error", listener: () => void): unknown;
    removeListener?(event: "close" | "error", listener: () => void): unknown;
}

export interface VoiceRouteAbortScope {
    readonly signal: AbortSignal | undefined;
    dispose(): void;
}

function isAbortableVoiceReplyRaw(value: unknown): value is AbortableVoiceReplyRaw {
    return value !== null && typeof value === "object" && typeof (value as { on?: unknown }).on === "function";
}

/**
 * Propagates a disconnected HTTP response to an in-flight provider request. The scope must be
 * disposed as soon as the provider operation settles so successful requests leave no socket listeners.
 */
export function createVoiceRouteAbortScope(reply: unknown): VoiceRouteAbortScope {
    const raw = (reply as { raw?: unknown } | null)?.raw;
    if (!isAbortableVoiceReplyRaw(raw)) {
        return { signal: undefined, dispose() {} };
    }

    const controller = new AbortController();
    let disposed = false;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        raw.off?.("close", abort);
        raw.off?.("error", abort);
        raw.removeListener?.("close", abort);
        raw.removeListener?.("error", abort);
    };
    const abort = () => {
        dispose();
        if (!controller.signal.aborted) controller.abort();
    };

    if (raw.destroyed && !raw.writableEnded) {
        abort();
    } else {
        raw.on("close", abort);
        raw.on("error", abort);
    }

    return { signal: controller.signal, dispose };
}
