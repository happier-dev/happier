import { MarkdownSpan } from './parseMarkdown';
import { Link } from 'expo-router';
import * as React from 'react';
import { Platform } from 'react-native';
import { Text } from '../ui/text/Text';
import { StreamingTextReveal } from './streaming/StreamingTextReveal';
import { isStreamingIncompleteLinkHref } from './streaming/streamingMarkdownRepairConfig';
import type { StreamingTextRevealPreset } from './streaming/streamingTextRevealConfig';
import { FindHighlightedText, sliceFindRanges } from '@/components/ui/text/FindHighlightedText';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';
import { MarkdownFindDecorationContext } from './rendering/MarkdownFindDecorationContext';

export type MarkdownSpansViewProps = {
    spans: MarkdownSpan[];
    baseStyle?: any;
    linkStyle?: any;
    onLinkPress?: (url: string) => boolean | void;
    resolveSpanStyle?: (styleName: MarkdownSpan['styles'][number]) => any;
    inlineTextSelectable?: boolean;
    streamingReveal?: boolean;
    streamingRevealPreset?: StreamingTextRevealPreset;
    findRanges?: readonly FindTextRange[];
};

export const MarkdownSpansView = React.memo((props: MarkdownSpansViewProps) => {
    const resolveSpanStyle = props.resolveSpanStyle ?? (() => undefined);
    const inlineTextSelectable = props.inlineTextSelectable ?? true;
    const findDecoration = React.useContext(MarkdownFindDecorationContext);
    let offset = 0;

    return (
        <>
            {props.spans.map((span, index) => {
                const ranges = findDecoration?.get(span) ?? sliceFindRanges(props.findRanges, offset, span.text.length);
                offset += span.text.length;
                const text = ranges?.length ? <FindHighlightedText text={span.text} ranges={ranges} selectable={inlineTextSelectable} /> : span.text;
                if (span.url) {
                    const linkStyle = [props.linkStyle, span.styles.map(resolveSpanStyle)];
                    // Special blocks render from the same repaired source as prose, so a link
                    // whose URL is still streaming reaches here as the repair placeholder.
                    // Unlike the enriched path there is no link-target normalization between
                    // the span and the caller, so the placeholder is kept out of both the
                    // press callback and Expo Router until the real destination arrives.
                    if (isStreamingIncompleteLinkHref(span.url)) {
                        return (
                            <Text
                                key={index}
                                selectable={inlineTextSelectable}
                                style={linkStyle}
                            >
                                {text}
                            </Text>
                        );
                    }
                    if (props.onLinkPress) {
                        return (
                            <Text
                                key={index}
                                accessibilityRole="link"
                                onPress={() => props.onLinkPress?.(span.url!)}
                                selectable={inlineTextSelectable}
                                style={linkStyle}
                            >
                                {text}
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
                                text
                            ) : (
                                <Text
                                    selectable={inlineTextSelectable}
                                    style={linkStyle}
                                >
                                    {text}
                                </Text>
                            )}
                        </Link>
                    );
                }

                const spanStyle = [props.baseStyle, span.styles.map(resolveSpanStyle)];
                if (props.streamingReveal === true && !span.styles.includes('code') && !ranges?.length) {
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
                        {text}
                    </Text>
                );
            })}
        </>
    );
});
