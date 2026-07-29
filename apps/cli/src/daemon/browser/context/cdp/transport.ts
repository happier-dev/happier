/**
 * The CDP/Chromium boundary the BRW-11 context producer talks to. This is the ONLY seam that
 * reaches the live sidecar transport; everything above it (view resolution, redaction, protocol
 * shaping, media persistence) is daemon logic and is unit-tested for real against a fake transport.
 *
 * The shape intentionally mirrors `BrowserSidecarCdpControlTransport.dispatchPageCommand` so a
 * single live transport satisfies both the control adapter and the context producer.
 */
export type BrowserContextCdpPageHandle = Readonly<{
    targetId: string;
    sessionId?: string;
}>;

export type BrowserContextCdpTransport = Readonly<{
    dispatchPageCommand(input: BrowserContextCdpPageHandle & Readonly<{
        method: string;
        params?: Record<string, unknown>;
    }>): Promise<unknown>;
}>;

/**
 * Resolves a daemon view reference (browserSessionId/viewId) to the live CDP page handle bound by
 * the control adapter when the view was opened. Returns `null` when the view is not owned/bound —
 * the producer then reports the capture as unavailable (fail-closed/honest), never guessing a
 * target. The resolver is the only place that crosses from semantic view identity to a raw CDP
 * target; keeping it injectable lets the producer stay transport-agnostic and fully unit-tested.
 */
export type BrowserContextCdpViewResolver = (
    view: Readonly<{ browserSessionId: string; viewId: string }>,
) => BrowserContextCdpPageHandle | null;
