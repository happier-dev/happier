import * as React from 'react';
import type { Message } from '@happier-dev/session-core/messages';
import { Text } from '@/components/ui/text/Text';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';
import { useTranscriptFindActive, useTranscriptFindRow } from '../find/TranscriptFindContext';
import type { ReviewRunCommentsSnapshot } from '@/sync/domains/reviews/comments/reviewRunComments';
import { useTranscriptRowLayoutMutation } from '../measurement/TranscriptRowLayoutMutationContext';

export type StructuredFindTextBlock = Readonly<{
    id: string;
    text: string;
    format?: 'plain' | 'markdown';
}>;

export type StructuredFindProjectionContext = Readonly<{
    sessionId?: string;
    serverId?: string | null;
    canSendMessages?: boolean;
    canNavigate?: boolean;
    hasWorkspacePath?: boolean;
    sessionMessages?: readonly Message[];
    debugInformationEnabled?: boolean;
    canJumpToAnchor?: boolean;
    readReviewComments?: (runId: string) => Pick<ReviewRunCommentsSnapshot, 'status' | 'comments'> | undefined;
}>;
export type StructuredFindTextContext = StructuredFindProjectionContext;

const StructuredFindMessageContext = React.createContext<string | undefined>(undefined);

export function StructuredFindMessageProvider(props: Readonly<{ messageId: string; children: React.ReactNode }>) {
    return <StructuredFindMessageContext.Provider value={props.messageId}>{props.children}</StructuredFindMessageContext.Provider>;
}

export function useStructuredFindState() {
    const messageId = React.useContext(StructuredFindMessageContext);
    const row = useTranscriptFindRow(messageId);
    const findActive = useTranscriptFindActive();
    return {
        ranges: (blockId: string) => row?.blocks.find((block) => block.id === blockId)?.sourceRanges,
        revealBlockId: row?.reveal?.blockId,
        revealRequestId: row?.reveal?.requestId,
        active: Boolean(row?.blocks.length),
        findActive,
    };
}

/** Keep the incumbent Text host and typography; only matched glyphs gain nested spans. */
export function StructuredFindText(props: Omit<React.ComponentProps<typeof Text>, 'children'> & Readonly<{ blockId: string; text: string }>) {
    const { blockId, text, numberOfLines, ...textProps } = props;
    const find = useStructuredFindState();
    const ranges = find.ranges(blockId);
    const mutateLayout = useTranscriptRowLayoutMutation();
    React.useLayoutEffect(() => {
        if (numberOfLines === undefined || find.revealBlockId !== blockId) return;
        mutateLayout({ reason: 'expand', sourceId: `structured-find:${blockId}` });
    }, [blockId, find.revealBlockId, find.revealRequestId, mutateLayout, numberOfLines]);
    return <Text {...textProps} numberOfLines={find.revealBlockId === blockId ? undefined : numberOfLines}>
        {ranges?.length ? <FindHighlightedText text={text} ranges={ranges} selectable={textProps.selectable} /> : text}
    </Text>;
}
