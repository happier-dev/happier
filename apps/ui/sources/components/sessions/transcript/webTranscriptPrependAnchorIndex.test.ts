import { describe, expect, it } from 'vitest';

import { resolvePendingWebPrependAnchorIndex } from '@/components/sessions/transcript/viewport/prepend/webTranscriptPrependAnchorIndex';

const ITEMS = [
    { kind: 'message', id: 'msg:m1', messageId: 'm1' },
    { kind: 'tool-calls-group', id: 'tools:tool-1', toolMessageIds: ['tool-1', 'tool-2'] },
    { kind: 'message', id: 'msg:m2', messageId: 'm2' },
    { kind: 'pending-queue', id: 'pending-queue' },
] as const;

describe('resolvePendingWebPrependAnchorIndex', () => {
    it('resolves stable message anchors to the canonical rendered item index', () => {
        expect(resolvePendingWebPrependAnchorIndex({
            anchorTestId: 'transcript-anchor-message-m2',
            itemTestId: null,
            items: ITEMS,
        })).toBe(2);
    });

    it('resolves stable tool anchors to the owning tool group index', () => {
        expect(resolvePendingWebPrependAnchorIndex({
            anchorTestId: 'transcript-anchor-tool-call-tool-2',
            itemTestId: null,
            items: ITEMS,
        })).toBe(1);
    });

    it('falls back to item anchors when no stable anchor is available', () => {
        expect(resolvePendingWebPrependAnchorIndex({
            anchorTestId: null,
            itemTestId: 'transcript-item-pending-queue',
            items: ITEMS,
        })).toBe(3);
    });
});
