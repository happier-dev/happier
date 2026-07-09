import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const CHAT_LIST_SOURCE = readFileSync(new URL('./ChatList.tsx', import.meta.url), 'utf8');

function extractMainOnScrollBody(): string {
    const start = CHAT_LIST_SOURCE.indexOf('onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {');
    expect(start, 'missing main TranscriptListShell onScroll handler').toBeGreaterThanOrEqual(0);
    const end = CHAT_LIST_SOURCE.indexOf('\n\t                            onScrollBeginDrag=', start);
    expect(end, 'missing end of main TranscriptListShell onScroll handler').toBeGreaterThan(start);
    return CHAT_LIST_SOURCE.slice(start, end);
}

describe('ChatList onScroll ingress boundary', () => {
    it('keeps the main scroll handler as a thin ingress adapter', () => {
        const onScrollBody = extractMainOnScrollBody();

        expect(onScrollBody).toContain('observeTranscriptScrollIngress');
        expect(onScrollBody).not.toContain('Platform.OS');
        expect(onScrollBody).not.toMatch(/contentH\s*-\s*layoutH\s*-\s*y/);
        expect(onScrollBody).not.toContain('getWebTranscriptDistanceFromBottom');
        expect(onScrollBody).not.toContain('observeWebGenuineScrollMovement');
    });

    it('keeps entry-restore and prepend sequencing behind the lifecycle ingress owner', () => {
        const onScrollBody = extractMainOnScrollBody();

        expect(onScrollBody).not.toContain('preemptEntryRestoreTransaction()');
        expect(onScrollBody).not.toContain('observeNativeEntryRestoreHostFacts');
        expect(onScrollBody).not.toContain('observeNativePrependOwner()');
        expect(onScrollBody).not.toContain('nativePrependOwner.trustedScroll');
        expect(onScrollBody).not.toContain('observeNativeConfirmation');
    });

    it('wires web navigation visibility through the visibility owner callback', () => {
        expect(CHAT_LIST_SOURCE).toContain('observeWebTranscriptNavigationVisibilityOwner({');
        expect(CHAT_LIST_SOURCE).not.toContain('observeWebTranscriptNavigationVisibility: () => {}');
    });
});
