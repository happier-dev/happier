import * as React from 'react';
import { Text } from '@/components/ui/text/Text';
import { useTranscriptFindRow } from '@/components/sessions/transcript/find/TranscriptFindContext';
import { FindHighlightedText } from '@/components/ui/text/FindHighlightedText';

export function useToolFindState(messageId?: string) {
    const row = useTranscriptFindRow(messageId);
    return {
        active: row !== null,
        reveal: row?.reveal,
        blocks: row?.blocks,
        ranges: (blockId: string) => row?.blocks.find((block) => block.id === blockId)?.sourceRanges,
    };
}

/** Keeps decoration inside the renderer that owns the exact displayed string. */
export function ToolFindText({ text, blockId, messageId, ...props }: Omit<React.ComponentProps<typeof Text>, 'children'> & {
    text: string; blockId: string; messageId?: string;
}) {
    const find = useToolFindState(messageId);
    const ranges = find.ranges(blockId) ?? [];
    return <Text {...props} numberOfLines={find.active ? undefined : props.numberOfLines}>{ranges.length ? <FindHighlightedText text={text} ranges={ranges} /> : text}</Text>;
}
