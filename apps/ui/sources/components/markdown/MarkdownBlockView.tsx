import type { MarkdownBlock, MarkdownSpan, MarkdownTableAlignment } from './parseMarkdown';
import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { Pressable, View, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '../ui/text/Text';
import { HorizontalOverflowScrollView } from '../ui/scroll/HorizontalOverflowScrollView';
import { Typography } from '@/constants/Typography';
import { MermaidRenderer } from './MermaidRenderer';
import { t } from '@/text';
import { MarkdownSpansView } from './MarkdownSpansView';
import { MarkdownCodeBlock } from './MarkdownCodeBlock';
import type { StreamingTextRevealPreset } from './streaming/streamingTextRevealConfig';

// Option type for callback
export type Option = {
    title: string;
};

type MarkdownBlockViewProps = {
    block: MarkdownBlock;
    first: boolean;
    last: boolean;
    selectable: boolean;
    onOptionPress?: (option: Option) => void;
    onLinkPress?: (url: string) => boolean | void;
    textStyle?: StyleProp<TextStyle>;
    variant: 'default' | 'thinking';
    streamingReveal: boolean;
    streamingRevealPreset?: StreamingTextRevealPreset;
};

function areMarkdownBlockViewPropsEqual(prev: MarkdownBlockViewProps, next: MarkdownBlockViewProps): boolean {
    return prev.block === next.block
        && prev.first === next.first
        && prev.last === next.last
        && prev.selectable === next.selectable
        && prev.onOptionPress === next.onOptionPress
        && prev.onLinkPress === next.onLinkPress
        && prev.textStyle === next.textStyle
        && prev.variant === next.variant
        && prev.streamingReveal === next.streamingReveal
        && prev.streamingRevealPreset === next.streamingRevealPreset;
}

export const MarkdownBlockView = React.memo((props: MarkdownBlockViewProps) => {
    const block = props.block;
    if (block.type === 'text') {
        return <RenderTextBlock spans={block.content} first={props.first} last={props.last} selectable={props.selectable} onLinkPress={props.onLinkPress} textStyle={props.textStyle} variant={props.variant} streamingReveal={props.streamingReveal} streamingRevealPreset={props.streamingRevealPreset} />;
    } else if (block.type === 'header') {
        return <RenderHeaderBlock level={block.level} spans={block.content} first={props.first} last={props.last} selectable={props.selectable} onLinkPress={props.onLinkPress} textStyle={props.textStyle} variant={props.variant} streamingReveal={props.streamingReveal} streamingRevealPreset={props.streamingRevealPreset} />;
    } else if (block.type === 'horizontal-rule') {
        return <View style={style.horizontalRule} />;
    } else if (block.type === 'list') {
        return <RenderListBlock items={block.items} first={props.first} last={props.last} selectable={props.selectable} onLinkPress={props.onLinkPress} textStyle={props.textStyle} variant={props.variant} streamingReveal={props.streamingReveal} streamingRevealPreset={props.streamingRevealPreset} />;
    } else if (block.type === 'numbered-list') {
        return <RenderNumberedListBlock items={block.items} first={props.first} last={props.last} selectable={props.selectable} onLinkPress={props.onLinkPress} textStyle={props.textStyle} variant={props.variant} streamingReveal={props.streamingReveal} streamingRevealPreset={props.streamingRevealPreset} />;
    } else if (block.type === 'code-block') {
        if (props.variant === 'thinking') {
            return <RenderThinkingCodeBlock content={block.content} language={block.language} first={props.first} last={props.last} selectable={props.selectable} textStyle={props.textStyle} />;
        }
        return <RenderCodeBlock content={block.content} language={block.language} first={props.first} last={props.last} selectable={props.selectable} />;
    } else if (block.type === 'mermaid') {
        return <MermaidRenderer content={block.content} />;
    } else if (block.type === 'options') {
        return <RenderOptionsBlock items={block.items} first={props.first} last={props.last} selectable={props.selectable} onOptionPress={props.onOptionPress} textStyle={props.textStyle} />;
    } else if (block.type === 'table') {
        return <RenderTableBlock headers={block.headers} rows={block.rows} alignments={block.alignments} first={props.first} last={props.last} selectable={props.selectable} textStyle={props.textStyle} />;
    }
    return null;
}, areMarkdownBlockViewPropsEqual);

function RenderTextBlock(props: { spans: MarkdownSpan[], first: boolean, last: boolean, selectable: boolean, onLinkPress?: (url: string) => boolean | void, textStyle?: StyleProp<TextStyle>, variant: 'default' | 'thinking', streamingReveal: boolean, streamingRevealPreset?: StreamingTextRevealPreset }) {
    const baseStyle = [style.text, props.textStyle];
    return (
        <Text selectable={props.selectable} style={[...baseStyle, props.first && style.first, props.last && style.last]}>
            <MarkdownSpansView
                spans={props.spans}
                baseStyle={baseStyle}
                linkStyle={style.link}
                onLinkPress={props.onLinkPress}
                resolveSpanStyle={(s) => {
                    if (props.variant === 'thinking' && s === 'code') return style.thinkingInlineCode;
                    return (style as any)[s];
                }}
                inlineTextSelectable={false}
                streamingReveal={props.streamingReveal}
                streamingRevealPreset={props.streamingRevealPreset}
            />
        </Text>
    );
}

function RenderHeaderBlock(props: { level: 1 | 2 | 3 | 4 | 5 | 6, spans: MarkdownSpan[], first: boolean, last: boolean, selectable: boolean, onLinkPress?: (url: string) => boolean | void, textStyle?: StyleProp<TextStyle>, variant: 'default' | 'thinking', streamingReveal: boolean, streamingRevealPreset?: StreamingTextRevealPreset }) {
    const s = (style as any)[`header${props.level}`];
    const headerStyle = [style.header, s, props.textStyle, props.first && style.first, props.last && style.last];
    return (
        <Text selectable={props.selectable} style={headerStyle}>
            <MarkdownSpansView
                spans={props.spans}
                baseStyle={headerStyle}
                linkStyle={style.link}
                onLinkPress={props.onLinkPress}
                resolveSpanStyle={(sn) => {
                    if (props.variant === 'thinking' && sn === 'code') return style.thinkingInlineCode;
                    return (style as any)[sn];
                }}
                inlineTextSelectable={false}
                streamingReveal={props.streamingReveal}
                streamingRevealPreset={props.streamingRevealPreset}
            />
        </Text>
    );
}

function RenderListBlock(props: { items: { depth: number, spans: MarkdownSpan[] }[], first: boolean, last: boolean, selectable: boolean, onLinkPress?: (url: string) => boolean | void, textStyle?: StyleProp<TextStyle>, variant: 'default' | 'thinking', streamingReveal: boolean, streamingRevealPreset?: StreamingTextRevealPreset }) {
    const listStyle = [style.text, style.listText, props.textStyle];
    return (
        <View style={[style.listContainer, props.first && style.first, props.last && style.last]}>
            {props.items.map((item, index) => (
                <View testID="markdown-list-item-row" style={[style.listRow, { paddingLeft: item.depth * 20 }]} key={index}>
                    <Text selectable={props.selectable} testID="markdown-list-item-marker" style={style.listMarker}>•</Text>
                    <View style={style.listContent}>
                        <Text selectable={props.selectable} style={listStyle}>
                            <MarkdownSpansView
                                spans={item.spans}
                                baseStyle={listStyle}
                                linkStyle={style.link}
                                onLinkPress={props.onLinkPress}
                                resolveSpanStyle={(sn) => {
                                    if (props.variant === 'thinking' && sn === 'code') return style.thinkingInlineCode;
                                    return (style as any)[sn];
                                }}
                                inlineTextSelectable={false}
                                streamingReveal={props.streamingReveal}
                                streamingRevealPreset={props.streamingRevealPreset}
                            />
                        </Text>
                    </View>
                </View>
            ))}
        </View>
    );
}

function RenderNumberedListBlock(props: { items: { depth: number, number: number, spans: MarkdownSpan[] }[], first: boolean, last: boolean, selectable: boolean, onLinkPress?: (url: string) => boolean | void, textStyle?: StyleProp<TextStyle>, variant: 'default' | 'thinking', streamingReveal: boolean, streamingRevealPreset?: StreamingTextRevealPreset }) {
    const listStyle = [style.text, style.listText, props.textStyle];
    return (
        <View style={[style.listContainer, props.first && style.first, props.last && style.last]}>
            {props.items.map((item, index) => (
                <View testID="markdown-list-item-row" style={[style.listRow, { paddingLeft: item.depth * 20 }]} key={index}>
                    <Text selectable={props.selectable} testID="markdown-list-item-marker" style={style.numberedListMarker}>{item.number.toString()}.</Text>
                    <View style={style.listContent}>
                        <Text selectable={props.selectable} style={listStyle}>
                            <MarkdownSpansView
                                spans={item.spans}
                                baseStyle={listStyle}
                                linkStyle={style.link}
                                onLinkPress={props.onLinkPress}
                                resolveSpanStyle={(sn) => {
                                    if (props.variant === 'thinking' && sn === 'code') return style.thinkingInlineCode;
                                    return (style as any)[sn];
                                }}
                                inlineTextSelectable={false}
                                streamingReveal={props.streamingReveal}
                                streamingRevealPreset={props.streamingRevealPreset}
                            />
                        </Text>
                    </View>
                </View>
            ))}
        </View>
    );
}

function RenderCodeBlock(props: { content: string, language: string | null, first: boolean, last: boolean, selectable: boolean }) {
    return (
        <View style={[style.codeBlock, props.first && style.first, props.last && style.last]}>
            <MarkdownCodeBlock
                content={props.content}
                language={props.language}
                selectable={props.selectable}
            />
        </View>
    );
}

function RenderThinkingCodeBlock(props: { content: string, language: string | null, first: boolean, last: boolean, selectable: boolean, textStyle?: StyleProp<TextStyle> }) {
    return (
        <View style={[style.thinkingCodeBlockContainer, props.first && style.first, props.last && style.last]}>
            <Text selectable={props.selectable} style={[style.text, props.textStyle, style.thinkingCodeBlockText]}>
                {props.content}
            </Text>
        </View>
    );
}

function RenderOptionsBlock(props: {
    items: string[],
    first: boolean,
    last: boolean,
    selectable: boolean,
    onOptionPress?: (option: Option) => void,
    textStyle?: StyleProp<TextStyle>,
}) {
    const optionTextStyle = [style.optionText, props.textStyle];
    return (
        <View style={[style.optionsContainer, props.first && style.first, props.last && style.last]}>
            {props.items.map((item, index) => {
                if (props.onOptionPress) {
                    return (
                        <Pressable
                            key={index}
                            style={({ pressed }) => [
                                style.optionItem,
                                pressed && style.optionItemPressed
                            ]}
                            onPress={() => props.onOptionPress?.({ title: item })}
                        >
                            <Text selectable={props.selectable} style={optionTextStyle}>{item}</Text>
                        </Pressable>
                    );
                } else {
                    return (
                        <View key={index} style={style.optionItem}>
                            <Text selectable={props.selectable} style={optionTextStyle}>{item}</Text>
                        </View>
                    );
                }
            })}
        </View>
    );
}

// NOTE: span rendering extracted into MarkdownSpansView for unit-testable link hardening.

// Table rendering uses column-first layout to ensure consistent column widths.
// Each column is rendered as a vertical container with all its cells (header + data).
// This ensures that cells in the same column have the same width, determined by the widest content.
function RenderTableBlock(props: {
    headers: string[],
    rows: string[][],
    alignments: MarkdownTableAlignment[],
    first: boolean,
    last: boolean,
    selectable: boolean,
    textStyle?: StyleProp<TextStyle>,
}) {
  const columnCount = props.headers.length;
  const rowCount = props.rows.length;
  const isLastRow = (rowIndex: number) => rowIndex === rowCount - 1;
  const resolveColumnAlignment = (columnIndex: number): MarkdownTableAlignment =>
      props.alignments[columnIndex] ?? 'default';

  const scrollContents = (
      <View style={style.tableContent}>
          {/* Render each column as a vertical container */}
          {props.headers.map((header, colIndex) => {
              const alignment = resolveColumnAlignment(colIndex);
              const cellAlignmentStyle = getTableCellAlignmentStyle(alignment);
              const textAlignmentStyle = getTableTextAlignmentStyle(alignment);

              return (
              <View
                  key={`column-${colIndex}`}
                  style={[
                      style.tableColumn,
                      colIndex === columnCount - 1 && style.tableColumnLast
                  ]}
              >
                  {/* Header cell for this column */}
                  <View style={[style.tableCell, cellAlignmentStyle, style.tableHeaderCell, style.tableCellFirst]}>
                      <Text selectable={props.selectable} style={[style.tableHeaderText, textAlignmentStyle, props.textStyle]}>{header}</Text>
                  </View>
                  {/* Data cells for this column */}
                  {props.rows.map((row, rowIndex) => (
                      <View
                          key={`cell-${rowIndex}-${colIndex}`}
                          style={[
                              style.tableCell,
                              cellAlignmentStyle,
                              isLastRow(rowIndex) && style.tableCellLast
                          ]}
                      >
                          <Text selectable={props.selectable} style={[style.tableCellText, textAlignmentStyle, props.textStyle]}>{row[colIndex] ?? ''}</Text>
                      </View>
                  ))}
              </View>
              );
          })}
      </View>
  );

  return (
      <View style={[style.tableContainer, props.first && style.first, props.last && style.last]}>
          <HorizontalOverflowScrollView
              testID="markdown-table-scroll"
              showsHorizontalScrollIndicator={true}
              style={style.tableScrollView}
          >
              {scrollContents}
          </HorizontalOverflowScrollView>
      </View>
  );
}

function getTableCellAlignmentStyle(alignment: MarkdownTableAlignment) {
    if (alignment === 'center') return style.tableCellAlignCenter;
    if (alignment === 'right') return style.tableCellAlignRight;
    return style.tableCellAlignLeft;
}

function getTableTextAlignmentStyle(alignment: MarkdownTableAlignment) {
    if (alignment === 'center') return style.tableTextAlignCenter;
    if (alignment === 'right') return style.tableTextAlignRight;
    return style.tableTextAlignLeft;
}


const style = StyleSheet.create((theme) => ({

    // Plain text

    text: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 24, // Reduced from 28 to 24
        marginTop: 8,
        marginBottom: 8,
        color: theme.colors.text,
        fontWeight: '400',
    },

    italic: {
        ...Typography.default('italic'),
    },
    bold: {
        ...Typography.default('semiBold'),
    },
    semibold: {
        ...Typography.default('semiBold'),
    },
    code: {
        ...Typography.mono(),
        backgroundColor: theme.colors.surfaceHighest,
    },
    thinkingInlineCode: {
        ...Typography.mono(),
        backgroundColor: 'transparent',
    },
    link: {
        ...Typography.default(),
        color: theme.colors.textLink,
        fontWeight: '400',
    },

    // Headers

    header: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
    header1: {
        fontSize: 16,
        lineHeight: 24,  // Reduced from 36 to 24
        fontWeight: '900',
        marginTop: 16,
        marginBottom: 8
    },
    header2: {
        fontSize: 20,
        lineHeight: 24,  // Reduced from 36 to 32
        fontWeight: '600',
        marginTop: 16,
        marginBottom: 8
    },
    header3: {
        fontSize: 16,
        lineHeight: 28,  // Reduced from 32 to 28
        fontWeight: '600',
        marginTop: 16,
        marginBottom: 8,
    },
    header4: {
        fontSize: 16,
        lineHeight: 24,
        fontWeight: '600',
        marginTop: 8,
        marginBottom: 8,
    },
    header5: {
        fontSize: 16,
        lineHeight: 24,  // Reduced from 28 to 24
        fontWeight: '600'
    },
    header6: {
        fontSize: 16,
        lineHeight: 24, // Reduced from 28 to 24
        fontWeight: '600'
    },

    //
    // List
    //

    listContainer: {
        flexDirection: 'column',
        marginBottom: 14,
        gap: 2,
    },
    listRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
    },
    listContent: {
        flexShrink: 1,
        minWidth: 0,
        maxWidth: '100%',
    },
    listText: {
        ...Typography.default(),
        color: theme.colors.text,
        marginTop: 0,
        marginBottom: 0,
    },
    listMarker: {
        ...Typography.default(),
        color: theme.colors.text,
        width: 20,
        flexShrink: 0,
        textAlign: 'center',
        marginTop: 0,
        marginBottom: 0,
    },
    numberedListMarker: {
        ...Typography.default(),
        color: theme.colors.text,
        minWidth: 28,
        paddingRight: 4,
        flexShrink: 0,
        textAlign: 'right',
        marginTop: 0,
        marginBottom: 0,
    },

    //
    // Common
    //

    first: {
        marginTop: 0
    },
    last: {
        marginBottom: 0
    },

    //
    // Code Block
    //

    codeBlock: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        marginVertical: 8,
        width: '100%',
        alignSelf: 'stretch',
        position: 'relative',
        zIndex: 1,
    },
    copyButtonWrapper: {
        position: 'absolute',
        top: 8,
        right: 8,
        opacity: 0,
        zIndex: 10,
        elevation: 10,
        pointerEvents: 'none',
    },
    copyButtonWrapperVisible: {
        opacity: 1,
        pointerEvents: 'auto',
    },
    codeLanguage: {
        ...Typography.mono(),
        color: theme.colors.textSecondary,
        fontSize: 12,
        marginTop: 8,
        paddingHorizontal: 16,
        marginBottom: 0,
    },
    codeText: {
        ...Typography.mono(),
        color: theme.colors.text,
        fontSize: 14,
        lineHeight: 20,
    },
    thinkingCodeBlockContainer: {
        marginVertical: 8,
        width: '100%',
        alignSelf: 'stretch',
    },
    thinkingCodeBlockText: {
        ...Typography.mono(),
        backgroundColor: 'transparent',
    },
    horizontalRule: {
        height: 1,
        backgroundColor: theme.colors.divider,
        marginTop: 8,
        marginBottom: 8,
    },
    copyButtonContainer: {
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 10,
        elevation: 10,
        opacity: 1,
    },
    copyButtonContainerHidden: {
        opacity: 0,
    },
    copyButton: {
        backgroundColor: theme.colors.surfaceHighest,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        cursor: 'pointer',
    },
    copyButtonHidden: {
        display: 'none',
    },
    copyButtonCopied: {
        backgroundColor: theme.colors.success,
        borderColor: theme.colors.success,
        opacity: 1,
    },
    copyButtonText: {
        ...Typography.default(),
        color: theme.colors.text,
        fontSize: 12,
        lineHeight: 16,
    },

    //
    // Options Block
    //

    optionsContainer: {
        flexDirection: 'column',
        gap: 8,
        marginVertical: 8,
    },
    optionItem: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    optionItemPressed: {
        opacity: 0.7,
        backgroundColor: theme.colors.surfaceHigh,
    },
    optionText: {
        ...Typography.default(),
        fontSize: 16,
        lineHeight: 24,
        color: theme.colors.text,
    },

    //
    // Table
    //

    tableContainer: {
        marginVertical: 8,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        borderRadius: 8,
        alignSelf: 'flex-start',
        maxWidth: '100%',
        overflow: Platform.OS === 'web' ? 'visible' : 'hidden',
    },
    tableScrollView: {
        flexGrow: 0,
        flexShrink: 0,
        maxWidth: '100%',
    },
    tableContent: {
        flexDirection: 'row',
    },
    tableColumn: {
        flexDirection: 'column',
        borderRightWidth: 1,
        borderRightColor: theme.colors.divider,
    },
    tableColumnLast: {
        borderRightWidth: 0,
    },
    tableCell: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
        minWidth: 40,
    },
    tableCellAlignLeft: {
        alignItems: 'flex-start',
    },
    tableCellAlignCenter: {
        alignItems: 'center',
    },
    tableCellAlignRight: {
        alignItems: 'flex-end',
    },
    tableTextAlignLeft: {
        textAlign: 'left',
    },
    tableTextAlignCenter: {
        textAlign: 'center',
    },
    tableTextAlignRight: {
        textAlign: 'right',
    },
    tableCellFirst: {
        borderTopWidth: 0,
    },
    tableCellLast: {
        borderBottomWidth: 0,
    },
    tableHeaderCell: {
        backgroundColor: theme.colors.surfaceHigh,
    },
    tableHeaderText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 24,
    },
    tableCellText: {
        ...Typography.default(),
        color: theme.colors.text,
        fontSize: 16,
        lineHeight: 24,
    },

    // Add global style for Web platform (Unistyles supports this via compiler plugin)
    ...(Platform.OS === 'web' ? {
        // Web-only CSS styles
        _____web_global_styles: {}
    } : {}),
}));
