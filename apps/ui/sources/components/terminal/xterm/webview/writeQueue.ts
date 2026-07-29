import { estimateUtf8ByteLength } from '@/components/terminal/xterm/bytes';

export const DEFAULT_XTERM_WEBVIEW_MAX_PENDING_WRITE_BYTES = 4 * 1024 * 1024;

export function estimateXtermWebViewTextWriteBytes(data: string): number {
    return estimateUtf8ByteLength(data);
}
