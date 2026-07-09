import type { WebTranscriptViewportAnchorRestoreResult } from '@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchor';

export function didWebViewportAnchorRestoreSucceed(
    result: WebTranscriptViewportAnchorRestoreResult,
): boolean {
    return result.status === 'restored' || result.status === 'already_aligned';
}
