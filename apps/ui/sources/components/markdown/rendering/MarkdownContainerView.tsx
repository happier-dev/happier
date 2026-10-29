import * as React from 'react';
import { View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { HappierPressable, type FindTextRange } from '@happier-dev/plugin-ui/presentation';
import { MarkdownFindFallback } from './MarkdownFindFallback';
import { projectLeafRanges } from './MarkdownFindDecorationContext';
import type { MarkdownInlineReferences } from '../markdownInlineReferences';
import { MarkdownCodeBlockWrapKeyProvider, useMarkdownCodeBlockWrapKey } from '../MarkdownCodeBlockWrapState';
import { EnrichedMarkdownTextAdapter } from '../enriched/EnrichedMarkdownTextAdapter';
import { useEnrichedMarkdownStyle } from '../enriched/useEnrichedMarkdownStyle';
import type { MarkdownContainerBlock } from '../streaming/readMarkdownContainerBlock';
import { SpecialMarkdownBlockView } from './SpecialMarkdownBlockView';
import type { MarkdownRenderingProfile } from './MarkdownRenderingProfile';
import type { StyleProp, TextStyle } from 'react-native';
import type { StreamingTextRevealPreset } from '../streaming/streamingTextRevealConfig';
import type { MarkdownSelectionAction, MarkdownSourceRangeAction } from '../MarkdownView';
import { useMarkdownSelectionMenu } from './useMarkdownSelectionMenu';

type MarkdownContainerViewProps = Readonly<{
    block: MarkdownContainerBlock;
    sourceStart: number;
    sourceAction: MarkdownSourceRangeAction;
    selectionActions?: readonly MarkdownSelectionAction[];
    selectable: boolean;
    profile: MarkdownRenderingProfile;
    onLinkPress?: (url: string) => boolean | void;
    textStyle?: StyleProp<TextStyle>;
    streamingReveal: boolean;
    streamingRevealPreset?: StreamingTextRevealPreset;
    agentTexMath: boolean;
    findActive?: boolean;
    findSourceRanges?: readonly FindTextRange[];
    inlineReferences?: MarkdownInlineReferences;
}>;

export const MarkdownContainerView = React.memo((props: MarkdownContainerViewProps) => {
    const parentKey = useMarkdownCodeBlockWrapKey();
    const { markdownStyle } = useEnrichedMarkdownStyle({ profile: props.profile, textStyle: props.textStyle });
    const { block } = props;
    const proseSource = React.useMemo<MarkdownSourceRangeAction | null>(() => {
        if (block.type !== 'prose') return null;
        const start = block.sourceOffsets[0];
        const last = block.sourceOffsets.at(-1);
        if (start === undefined || last === undefined) return null;
        const parent = props.sourceAction;
        const relativeStart = start - parent.sourceStart;
        const markdown = parent.markdown.slice(relativeStart, last + 1 - parent.sourceStart);
        const startLine = parent.sourceRange.startLine + parent.markdown.slice(0, relativeStart).split('\n').length - 1;
        return {
            sourceStart: start, sourceLength: last + 1 - start, markdown, renderMarkdown: block.markdown,
            sourceRange: { startLine, endLine: startLine + markdown.split('\n').length - 1 },
        };
    }, [block, props.sourceAction]);
    const contextMenuItems = useMarkdownSelectionMenu(props.selectionActions, proseSource);
    const renderChild = (child: MarkdownContainerBlock) => <MarkdownContainerView {...props} key={child.sourceStart} block={child} />;

    if (block.type === 'code') {
        return (
            <MarkdownCodeBlockWrapKeyProvider value={parentKey ? JSON.stringify([parentKey, block.sourceStart - props.sourceStart]) : null}>
                <SpecialMarkdownBlockView
                    blocks={[block.block]}
                    codeFindRanges={block.block.type === 'code-block' && props.findSourceRanges?.length
                        ? projectLeafRanges({ text: block.block.content, sourceOffsets: block.sourceOffsets, sourceEnds: block.sourceOffsets.map(offset => offset + 1) }, 0, props.findSourceRanges)
                        : undefined}
                    first
                    last
                    selectable={props.selectable}
                    profile={props.profile}
                    onLinkPress={props.onLinkPress}
                    textStyle={props.textStyle}
                    streamingReveal={props.streamingReveal}
                    streamingRevealPreset={props.streamingRevealPreset}
                    agentTexMath={props.agentTexMath}
                />
            </MarkdownCodeBlockWrapKeyProvider>
        );
    }
    if (block.type === 'prose') {
        if (props.findActive || props.findSourceRanges?.length) return <MarkdownFindFallback
            markdown={block.markdown} sourceStart={block.sourceStart} sourceOffsets={block.sourceOffsets}
            contextMenuItems={contextMenuItems}
            ranges={props.findSourceRanges ?? EMPTY_FIND_RANGES}
            profile={props.profile} selectable={props.selectable} first last
            onLinkPress={props.onLinkPress} textStyle={props.textStyle}
            agentTexMath={props.agentTexMath} inlineReferences={props.inlineReferences} />;
        return <EnrichedMarkdownTextAdapter
            markdown={block.markdown}
            profile={props.profile}
            selectable={props.selectable}
            onLinkPress={props.onLinkPress}
            textStyle={props.textStyle}
            streamingAnimated={props.streamingReveal}
            streamingRevealPreset={props.streamingRevealPreset}
            suppressLeadingTopMargin
            inlineReferences={props.inlineReferences}
            agentTexMath={props.agentTexMath}
            contextMenuItems={contextMenuItems}
        />;
    }
    if (block.type === 'quote') {
        const quote = markdownStyle.blockquote;
        return <View style={{ borderLeftWidth: quote?.borderWidth, borderLeftColor: quote?.borderColor, paddingLeft: quote?.gapWidth, marginBottom: markdownStyle.paragraph?.marginBottom }}>
            {block.children.map(renderChild)}
        </View>;
    }
    const list = markdownStyle.list;
    const markerStyle: TextStyle = {
        fontFamily: list?.fontFamily,
        fontSize: list?.fontSize,
        lineHeight: list?.lineHeight,
        color: list?.markerColor,
        minWidth: list?.markerMinWidth,
        marginRight: list?.gapWidth,
    };
    return <View accessibilityRole="list" style={{ marginLeft: list?.marginLeft }}>
        {block.items.map(item => <MarkdownListItem key={item.sourceStart} item={item} markerStyle={markerStyle} renderProps={props} />)}
    </View>;
});

function MarkdownListItem({ item, markerStyle, renderProps }: Readonly<{
    item: Extract<MarkdownContainerBlock, { type: 'list' }>['items'][number];
    markerStyle: TextStyle;
    renderProps: MarkdownContainerViewProps;
}>) {
    const [checked, setChecked] = React.useState(item.checked);
    React.useEffect(() => { setChecked(item.checked); }, [item.checked]);
    const { markdownStyle } = useEnrichedMarkdownStyle({ profile: renderProps.profile, textStyle: renderProps.textStyle });
    const task = markdownStyle.taskList;
    const textStyle = React.useMemo(() => checked ? [renderProps.textStyle, {
        color: task?.checkedTextColor,
        textDecorationLine: task?.checkedStrikethrough ? 'line-through' as const : undefined,
    }] : renderProps.textStyle, [renderProps.textStyle, checked, task?.checkedTextColor, task?.checkedStrikethrough]);
    return <View role="listitem" style={{ flexDirection: 'row', marginBottom: markdownStyle.paragraph?.marginBottom }}>
        {checked === undefined
            ? <Text selectable={renderProps.selectable} style={markerStyle}>{item.marker}</Text>
            : <HappierPressable accessibilityRole="checkbox" accessibilityLabel={item.label} checked={checked} onPress={() => setChecked(value => !value)}>
                <Text style={markerStyle}>{checked ? '☑' : '☐'}</Text>
            </HappierPressable>}
        <View style={{ flex: 1, minWidth: 0 }}>{item.children.map(child => <MarkdownContainerView
            {...renderProps} key={child.sourceStart} block={child} textStyle={textStyle}
        />)}</View>
    </View>;
}

const EMPTY_FIND_RANGES: readonly FindTextRange[] = [];
