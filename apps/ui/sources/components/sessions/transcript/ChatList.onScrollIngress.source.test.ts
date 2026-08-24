import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const CHAT_LIST_SOURCE = readFileSync(new URL('./ChatListInternal.tsx', import.meta.url), 'utf8');
const SCROLL_OBSERVATION_HOST_SOURCE = readFileSync(
    new URL('./viewport/lifecycle/host/useTranscriptScrollObservationHost.ts', import.meta.url),
    'utf8',
);

function extractMainOnScrollBody(): string {
    const start = CHAT_LIST_SOURCE.indexOf('onScroll={scrollObservationHost.onScroll}');
    expect(start, 'missing main TranscriptListShell onScroll handler').toBeGreaterThanOrEqual(0);
    const end = CHAT_LIST_SOURCE.indexOf('\n                    onScrollBeginDrag=', start);
    expect(end, 'missing end of main TranscriptListShell onScroll handler').toBeGreaterThan(start);
    return CHAT_LIST_SOURCE.slice(start, end);
}

describe('ChatList onScroll ingress boundary', () => {
    it('keeps the main scroll handler as a thin ingress adapter', () => {
        const onScrollBody = extractMainOnScrollBody();

        expect(CHAT_LIST_SOURCE).toContain('useTranscriptScrollObservationHost');
        expect(SCROLL_OBSERVATION_HOST_SOURCE).toContain('observeTranscriptScrollIngress');
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
});
