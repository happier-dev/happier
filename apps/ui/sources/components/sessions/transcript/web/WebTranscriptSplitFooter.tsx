import * as React from 'react';

import { TranscriptHotTail } from '@/components/sessions/transcript/segments/TranscriptHotTail';

export const TRANSCRIPT_WEB_HOT_TAIL_TEST_ID_PREFIX = 'transcript-web-hot-tail';
export const TRANSCRIPT_WEB_HOT_TAIL_ITEM_TEST_ID_PREFIX = `${TRANSCRIPT_WEB_HOT_TAIL_TEST_ID_PREFIX}-item-`;

/**
 * Web hot/cold split footer host. Thin adapter over the shared {@link TranscriptHotTail}
 * so web and native share one hot-tail implementation; web keeps its stable
 * `transcript-web-hot-tail` testIDs. (Phase 2 converges native onto this same host.)
 */
function WebTranscriptSplitFooterInner<T extends { id: string }>(props: {
    hotItems: readonly T[];
    startIndex: number;
    renderItemAtIndex: (item: T, index: number) => React.ReactNode;
    footer: React.ReactNode;
}) {
    return (
        <TranscriptHotTail
            hotItems={props.hotItems}
            startIndex={props.startIndex}
            renderItemAtIndex={props.renderItemAtIndex}
            footer={props.footer}
            testIDPrefix={TRANSCRIPT_WEB_HOT_TAIL_TEST_ID_PREFIX}
        />
    );
}

export const WebTranscriptSplitFooter = React.memo(WebTranscriptSplitFooterInner) as typeof WebTranscriptSplitFooterInner;
