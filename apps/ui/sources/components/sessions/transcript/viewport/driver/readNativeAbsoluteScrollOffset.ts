import type { ScrollableChatListRef } from '@/components/sessions/transcript/viewport/transcriptScrollableListTypes';

/**
 * The single guarded read of the native FlashList's raw absolute scroll offset.
 *
 * `getAbsoluteLastScrollOffset` is a native-module call that can throw mid-recycle, so every read must be
 * try/catch-wrapped; it can also report a non-finite value. Centralizing the read here (rather than inlining
 * the same try/catch at each host observation site) keeps the G1-banned raw primitive in ONE place and
 * guarantees every caller gets the same finite-or-null contract.
 */
export function readNativeAbsoluteScrollOffset(node: ScrollableChatListRef | null | undefined): number | null {
    try {
        const value = node?.getAbsoluteLastScrollOffset?.();
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}
