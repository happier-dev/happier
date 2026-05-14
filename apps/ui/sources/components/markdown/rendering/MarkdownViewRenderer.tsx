import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { Platform, View } from 'react-native';

import type { Option } from '../MarkdownBlockView';
import type { MarkdownSourceRange, MarkdownSourceRangeAction } from '../MarkdownView';
import type { MarkdownStreamingMode } from '../streaming/useStreamingMarkdownBlocks';
import { usePreparedStreamingMarkdown } from '../streaming/usePreparedStreamingMarkdown';
import type { StreamingTextRevealPreset } from '../streaming/streamingTextRevealConfig';
import type { MarkdownRenderingProfile } from './MarkdownRenderingProfile';
import { MarkdownSegmentView } from './MarkdownSegmentView';
import { splitMarkdownRenderSegments } from './splitMarkdownRenderSegments';
import { StaticMarkdownRenderPlaceholder } from './StaticMarkdownRenderPlaceholder';
import { useDelayedStaticMarkdownRenderPlaceholder } from './useDelayedStaticMarkdownRenderPlaceholder';

type MarkdownViewRendererProps = Readonly<{
    testID?: string;
    markdown: string;
    onOptionPress?: (option: Option) => void;
    onLinkPress?: (url: string) => boolean | void;
    textStyle?: StyleProp<TextStyle>;
    selectable: boolean;
    profile: MarkdownRenderingProfile;
    streamingMode: MarkdownStreamingMode;
    streamingAnimated: boolean;
    streamingRevealPreset?: StreamingTextRevealPreset;
    staticRenderPlaceholderEnabled?: boolean;
    onPressSourceRange?: (action: MarkdownSourceRangeAction) => void;
    renderAfterSourceRange?: (action: MarkdownSourceRangeAction) => React.ReactNode;
    highlightSourceRange?: MarkdownSourceRange | null;
}>;

export const MarkdownViewRenderer = React.memo((props: MarkdownViewRendererProps) => {
    const preparedMarkdown = usePreparedStreamingMarkdown({
        markdown: props.markdown,
        mode: props.streamingMode,
    });
    const segments = React.useMemo(() => splitMarkdownRenderSegments({
        markdown: preparedMarkdown,
        streamingMode: props.streamingMode,
        streamingRepair: 'prepared',
    }), [preparedMarkdown, props.streamingMode]);
    const streamingReveal = props.streamingMode === 'streaming' && props.streamingAnimated === true;
    const staticRenderPlaceholder = useDelayedStaticMarkdownRenderPlaceholder({
        enabled:
            props.staticRenderPlaceholderEnabled !== false &&
            Platform.OS !== 'web' &&
            props.streamingMode === 'static' &&
            props.markdown.trim().length > 0,
        contentKey: props.markdown,
    });

    return (
        <View testID={props.testID} style={styles.root}>
            <View
                testID="markdown-static-render-content"
                onLayout={staticRenderPlaceholder.onContentLayout}
                style={styles.content}
            >
                {segments.map((segment) => (
                    <MarkdownSegmentView
                        key={segment.key}
                        segment={segment}
                        selectable={props.selectable}
                        onOptionPress={props.onOptionPress}
                        onLinkPress={props.onLinkPress}
                        textStyle={props.textStyle}
                        profile={props.profile}
                        streamingReveal={streamingReveal}
                        streamingRevealPreset={props.streamingRevealPreset}
                        onPressSourceRange={props.onPressSourceRange}
                        renderAfterSourceRange={props.renderAfterSourceRange}
                        highlightSourceRange={props.highlightSourceRange}
                    />
                ))}
            </View>
            {staticRenderPlaceholder.visible ? <StaticMarkdownRenderPlaceholder /> : null}
        </View>
    );
});

const styles = {
    root: {
        width: '100%' as const,
    },
    content: {
        width: '100%' as const,
    },
};
