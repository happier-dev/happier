import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import { HappierReplyQuote, type HappierReplyQuoteSource, type HappierReplyQuoteTextProps, type ReplyQuoteProps } from '@happier-dev/plugin-ui/components';

import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';

const sourceMarks = { message: 'chats-circle', doc_passage: 'file-text', task: 'check-square' } satisfies Record<ReplyQuoteProps['kind'], IconName>;

/** Core supplies its scaled text and theme to the same source quote plugins use. */
export function ReplyQuote(props: Readonly<{
    testID?: string;
    kind: ReplyQuoteProps['kind'];
    source: HappierReplyQuoteSource;
    /** `passage` quotes the words alone, under the quote mark, where the surface names the source. */
    form?: 'reply' | 'passage';
}>) {
    const { theme } = useUnistyles();
    // A passage quotes the words alone in the shared passage box (lab T3-A), under the quote mark; a reply keeps its source mark.
    const passage = props.form === 'passage';
    return <HappierReplyQuote testID={props.testID} source={props.source} Text={QuoteText} form={props.form}
        leading={<Icon name={passage ? 'quotes' : sourceMarks[props.kind]} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
        colors={{ text: theme.colors.text.primary, secondaryText: theme.colors.text.secondary,
            border: theme.colors.border.default, focus: theme.colors.border.focus, passage: theme.colors.surface.inset }}
        space={theme.space} radius={theme.borderRadius.lg} />;
}

function QuoteText(props: HappierReplyQuoteTextProps) {
    return <Text testID={props.testID} variant="meta" emphasis={props.role === 'source' ? 'semiBold' : undefined}
        numberOfLines={props.numberOfLines} style={[{ color: props.color }, props.style]}>{props.children}</Text>;
}
