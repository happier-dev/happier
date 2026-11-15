/** CDP Frame.unreachableUrl names the attempted page when Chromium renders its error document. */
export function readSidecarFrameAddress(frame: unknown): string | undefined {
    if (!frame || typeof frame !== 'object') return undefined;
    if ('unreachableUrl' in frame && typeof frame.unreachableUrl === 'string' && frame.unreachableUrl.length > 0) return frame.unreachableUrl;
    return 'url' in frame && typeof frame.url === 'string' ? frame.url : undefined;
}
