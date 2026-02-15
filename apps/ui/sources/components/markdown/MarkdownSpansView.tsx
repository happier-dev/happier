import { MarkdownSpan } from './parseMarkdown';
import { Link } from 'expo-router';
import * as React from 'react';
import { Text } from '../ui/text/StyledText';

export type MarkdownSpansViewProps = {
    spans: MarkdownSpan[];
    baseStyle?: any;
    linkStyle?: any;
    resolveSpanStyle?: (styleName: MarkdownSpan['styles'][number]) => any;
};

export const MarkdownSpansView = React.memo((props: MarkdownSpansViewProps) => {
    const resolveSpanStyle = props.resolveSpanStyle ?? (() => undefined);

    return (
        <>
            {props.spans.map((span, index) => {
                if (span.url) {
                    return (
                        <Link
                            key={index}
                            href={span.url as any}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={[props.linkStyle, span.styles.map(resolveSpanStyle)]}
                        >
                            {span.text}
                        </Link>
                    );
                }

                return (
                    <Text
                        key={index}
                        selectable
                        style={[props.baseStyle, span.styles.map(resolveSpanStyle)]}
                    >
                        {span.text}
                    </Text>
                );
            })}
        </>
    );
});

