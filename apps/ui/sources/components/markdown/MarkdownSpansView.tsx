import { MarkdownSpan } from './parseMarkdown';
import { Link } from 'expo-router';
import * as React from 'react';
import { Platform, type StyleProp, type TextStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Text } from '../ui/text/Text';
import { openMarkdownLinkUrl } from './enriched/enrichedMarkdownLinkHandling';
import { StreamingTextReveal } from './streaming/StreamingTextReveal';
import { isStreamingIncompleteLinkHref } from './streaming/streamingMarkdownRepairConfig';
import type { StreamingTextRevealPreset } from './streaming/streamingTextRevealConfig';

export type MarkdownSpansViewProps = {
    spans: MarkdownSpan[];
    baseStyle?: StyleProp<TextStyle>;
    onLinkPress?: (url: string) => boolean | void;
    variant?: 'default' | 'thinking';
    inlineTextSelectable?: boolean;
    streamingReveal?: boolean;
    streamingRevealPreset?: StreamingTextRevealPreset;
};

export const MarkdownSpansView = React.memo((props: MarkdownSpansViewProps) => {
    const resolveSpanStyle = (name: MarkdownSpan['styles'][number]) =>
        props.variant === 'thinking' && name === 'code' ? styles.thinkingInlineCode : styles[name];
    const inlineTextSelectable = props.inlineTextSelectable ?? true;

    return (
        <>
            {props.spans.map((span, index) => {
                if (span.url) {
                    const linkStyle = [styles.link, span.styles.map(resolveSpanStyle)];
                    // Keep a streaming link label inert until its destination arrives.
                    if (isStreamingIncompleteLinkHref(span.url)) {
                        return (
                            <Text
                                key={index}
                                selectable={inlineTextSelectable}
                                style={linkStyle}
                            >
                                {span.text}
                            </Text>
                        );
                    }
                    if (props.onLinkPress) {
                        return (
                            <Text
                                key={index}
                                accessibilityRole="link"
                                onPress={() => { void openMarkdownLinkUrl(span.url!, props.onLinkPress); }}
                                selectable={inlineTextSelectable}
                                style={linkStyle}
                            >
                                {span.text}
                            </Text>
                        );
                    }
                    const isWeb = Platform.OS === 'web';
                    return (
                        <Link
                            key={index}
                            href={span.url as any}
                            target="_blank"
                            rel="noopener noreferrer"
                            // On web, avoid `asChild` so Expo Router can forward `href`/`target`/`rel` to an anchor-like
                            // element (RN Web `hrefAttrs`). On native, use `asChild` so selection works reliably.
                            asChild={!isWeb}
                            style={isWeb ? linkStyle : undefined}
                        >
                            {isWeb ? (
                                span.text
                            ) : (
                                <Text
                                    selectable={inlineTextSelectable}
                                    style={linkStyle}
                                >
                                    {span.text}
                                </Text>
                            )}
                        </Link>
                    );
                }

                const spanStyle = [props.baseStyle, span.styles.map(resolveSpanStyle)];
                if (props.streamingReveal === true && !span.styles.includes('code')) {
                    return (
                        <StreamingTextReveal
                            key={index}
                            selectable={inlineTextSelectable}
                            style={spanStyle}
                            text={span.text}
                            animated
                            preset={props.streamingRevealPreset}
                        />
                    );
                }

                return (
                    <Text
                        key={index}
                        selectable={inlineTextSelectable}
                        style={spanStyle}
                    >
                        {span.text}
                    </Text>
                );
            })}
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    italic: Typography.default('italic'),
    bold: Typography.default('semiBold'),
    semibold: Typography.default('semiBold'),
    code: {
        ...Typography.mono(),
        fontSize: 14,
        lineHeight: 20,
        backgroundColor: theme.colors.surface.selected,
    },
    thinkingInlineCode: {
        ...Typography.mono(),
        backgroundColor: 'transparent',
    },
    link: {
        ...Typography.default(),
        color: theme.colors.text.link,
        fontWeight: '400',
    },
}));
