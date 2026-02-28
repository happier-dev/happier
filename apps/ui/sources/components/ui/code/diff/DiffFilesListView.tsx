import * as React from 'react';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { Pressable, View, Platform, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';

import type { DiffFileEntry } from '@/components/ui/code/model/diff/diffViewModel';
import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { resolveInlineDiffVirtualization } from '@/components/ui/code/diff/resolveInlineDiffVirtualization';
import { PierreScrollRootVirtualizerProvider } from '@/components/ui/code/diff/pierre/PierreScrollRootVirtualizerProvider';
import { useInlineDiffVirtualizationThresholds } from '@/components/ui/code/diff/useInlineDiffVirtualizationThresholds';
import { resolveInlineDiffVirtualizedMaxHeight } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedMaxHeight';

const LINE_ADDED_PREFIX = '+';
const LINE_REMOVED_PREFIX = '-';

export type DiffFilesListViewProps = Readonly<{
    files: readonly DiffFileEntry[];
    expandedKeys: ReadonlySet<string>;
    onToggleExpanded: (key: string) => void;
    canRenderInlineDiffs: boolean;
    wrapLines: boolean;
    showLineNumbers: boolean;
    showPrefix: boolean;
    virtualizeFileList?: boolean;
    onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    onLayout?: (event: LayoutChangeEvent) => void;
    onContentSizeChange?: (width: number, height: number) => void;
    onViewableItemsChanged?: (info: any) => void;
    scrollEventThrottle?: number;
    onOpenFile?: (filePath: string) => void;
    onOpenFilePinned?: (filePath: string) => void;
    renderInlineUnifiedDiff?: (params: Readonly<{
        file: DiffFileEntry;
        virtualized: boolean;
        maxVirtualizedHeight: number;
        wrapLines: boolean;
        showLineNumbers: boolean;
        showPrefix: boolean;
    }>) => React.ReactNode;
}>;

export function DiffFilesListView(props: DiffFilesListViewProps) {
    const [focusedFileKey, setFocusedFileKey] = React.useState<string | null>(null);

    const { height: windowHeight } = useWindowDimensions();
    const { lineThreshold: virtualizationLineThreshold, byteThreshold: virtualizationByteThreshold } = useInlineDiffVirtualizationThresholds();

    if (props.files.length === 0) return null;

    const maxVirtualizedHeight = resolveInlineDiffVirtualizedMaxHeight(windowHeight);

    const renderFileNode = React.useCallback((file: DiffFileEntry) => {
        const expanded = props.expandedKeys.has(file.key);
        const presentationStyleOverride =
            file.kind === 'new' || file.kind === 'deleted' || file.oldText === '' || file.newText === ''
                ? 'unified'
                : undefined;
        const inlineVirtualized = props.canRenderInlineDiffs && expanded
            ? resolveInlineDiffVirtualization({
                unifiedDiff: typeof file.unifiedDiff === 'string' ? file.unifiedDiff : null,
                oldText: typeof file.oldText === 'string' ? file.oldText : null,
                newText: typeof file.newText === 'string' ? file.newText : null,
                lineThreshold: virtualizationLineThreshold,
                byteThreshold: virtualizationByteThreshold,
            })
            : false;

        return (
            <View>
                <View
                    style={[
                        styles.fileRowContainer,
                        focusedFileKey === file.key ? styles.fileRowFocused : null,
                    ]}
                >
                    <Pressable
                        onPress={() => props.onToggleExpanded(file.key)}
                        onFocus={() => setFocusedFileKey(file.key)}
                        onBlur={() => setFocusedFileKey((prev) => (prev === file.key ? null : prev))}
                        style={({ hovered, pressed }) => ([
                            styles.fileRowInteractive,
                            hovered ? styles.fileRowHovered : null,
                            pressed ? styles.fileRowPressed : null,
                        ])}
                        accessibilityRole="button"
                    >
                        <View style={styles.fileRowMain}>
                            <Text style={styles.filePath} numberOfLines={1}>
                                {file.filePath ?? t('status.unknown')}
                            </Text>
                            {file.kind ? (
                                <View
                                    style={[
                                        styles.kindBadge,
                                        file.kind === 'new'
                                            ? styles.kindBadgeNew
                                            : file.kind === 'deleted'
                                                ? styles.kindBadgeDeleted
                                                : styles.kindBadgeRenamed,
                                    ]}
                                >
                                    <Text
                                        style={[
                                            styles.kindText,
                                            file.kind === 'new'
                                                ? styles.kindTextNew
                                                : file.kind === 'deleted'
                                                    ? styles.kindTextDeleted
                                                    : styles.kindTextRenamed,
                                        ]}
                                    >
                                        {file.kind === 'new'
                                            ? t('common.create')
                                            : file.kind === 'deleted'
                                                ? t('common.delete')
                                                : t('common.rename')}
                                    </Text>
                                </View>
                            ) : null}
                        </View>
                        <Text style={styles.statsText}>
                            {`${LINE_ADDED_PREFIX}${file.added} ${LINE_REMOVED_PREFIX}${file.removed}`}
                        </Text>
                    </Pressable>

                    {typeof file.filePath === 'string' && (props.onOpenFile || props.onOpenFilePinned) ? (
                        <Pressable
                            testID={`diff-files-open:${file.key}`}
                            accessibilityRole="button"
                            accessibilityLabel={t('session.detailsPanel.openTabA11y', { title: file.filePath })}
                            hitSlop={8}
                            onPress={() => props.onOpenFile?.(file.filePath as string)}
                            // @ts-expect-error - react-native types do not model web-only double click props; RN Web supports onDoubleClick.
                            onDoubleClick={
                                Platform.OS === 'web' && props.onOpenFilePinned
                                    ? (event: any) => {
                                        event?.preventDefault?.();
                                        event?.stopPropagation?.();
                                        props.onOpenFilePinned?.(file.filePath as string);
                                    }
                                    : undefined
                            }
                            style={({ pressed, hovered }) => ([
                                styles.openFileButton,
                                hovered ? styles.openFileButtonHovered : null,
                                pressed ? styles.openFileButtonPressed : null,
                            ])}
                        >
                            <Octicons name="file" size={14} color={styles.openFileIcon.color as any} />
                        </Pressable>
                    ) : null}
                </View>

                {props.canRenderInlineDiffs && expanded ? (
                    file.unifiedDiff ? (
                        <View style={[styles.inlineDiffContainer, inlineVirtualized ? { maxHeight: maxVirtualizedHeight } : null]}>
                            {props.renderInlineUnifiedDiff ? props.renderInlineUnifiedDiff({
                                file,
                                virtualized: inlineVirtualized,
                                maxVirtualizedHeight,
                                wrapLines: props.wrapLines,
                                showLineNumbers: props.showLineNumbers,
                                showPrefix: props.showPrefix,
                            }) : (
                                <DiffViewer
                                    mode="unified"
                                    filePath={file.filePath ?? null}
                                    unifiedDiff={file.unifiedDiff}
                                    wrapLines={props.wrapLines}
                                    virtualized={inlineVirtualized}
                                    presentationStyleOverride={presentationStyleOverride}
                                    showLineNumbers={props.showLineNumbers}
                                    showPrefix={props.showPrefix}
                                />
                            )}
                        </View>
                    ) : file.oldText != null && file.newText != null ? (
                        <View style={[styles.inlineDiffContainer, inlineVirtualized ? { maxHeight: maxVirtualizedHeight } : null]}>
                            <DiffViewer
                                mode="text"
                                filePath={file.filePath ?? null}
                                oldText={file.oldText}
                                newText={file.newText}
                                contextLines={3}
                                wrapLines={props.wrapLines}
                                virtualized={inlineVirtualized}
                                presentationStyleOverride={presentationStyleOverride}
                                showLineNumbers={props.showLineNumbers}
                                showPrefix={props.showPrefix}
                            />
                        </View>
                    ) : null
                ) : null}
            </View>
        );
    }, [
        focusedFileKey,
        maxVirtualizedHeight,
        props,
        virtualizationByteThreshold,
        virtualizationLineThreshold,
    ]);

    return (
        <PierreScrollRootVirtualizerProvider>
            {props.virtualizeFileList === true ? (
                <FlashList
                    style={[
                        { flex: 1 },
                        Platform.select({ web: ({ overflowAnchor: 'none' } as any), default: null }) as any,
                    ]}
                    data={props.files as DiffFileEntry[]}
                    keyExtractor={(item) => item.key}
                    renderItem={({ item }) => renderFileNode(item)}
                    contentContainerStyle={{ paddingBottom: 12 }}
                    estimatedItemSize={56}
                    extraData={props.expandedKeys}
                    onScroll={props.onScroll}
                    onLayout={props.onLayout}
                    onContentSizeChange={props.onContentSizeChange}
                    onViewableItemsChanged={props.onViewableItemsChanged}
                    scrollEventThrottle={props.scrollEventThrottle}
                />
            ) : (
                props.files.map((file) => (
                    <React.Fragment key={file.key}>
                        {renderFileNode(file)}
                    </React.Fragment>
                ))
            )}
        </PierreScrollRootVirtualizerProvider>
    );
}

const styles = StyleSheet.create((theme) => ({
    fileRowContainer: {
        flexDirection: 'row',
        alignItems: 'stretch',
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        marginBottom: 8,
        overflow: 'hidden',
        ...Platform.select({
            web: { cursor: 'pointer', overflowAnchor: 'none' } as any,
            default: null,
        }),
    },
    fileRowInteractive: {
        flex: 1,
        paddingHorizontal: 12,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    fileRowHovered: {
        backgroundColor: theme.colors.surfaceHighest ?? theme.colors.surfaceHigh,
    },
    fileRowPressed: {
        opacity: 0.9,
    },
    fileRowFocused: {
        borderColor: theme.colors.textLink ?? theme.colors.divider,
    },
    fileRowMain: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    filePath: {
        fontSize: 13,
        color: theme.colors.text,
        fontFamily: 'monospace',
        flexShrink: 1,
        minWidth: 0,
    },
    statsText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'monospace',
    },
    openFileButton: {
        marginLeft: 10,
        width: 28,
        height: 28,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHighest ?? theme.colors.surface,
        ...Platform.select({
            web: { cursor: 'pointer' } as any,
            default: null,
        }),
    },
    openFileButtonHovered: {
        backgroundColor: theme.colors.surfaceHighest ?? theme.colors.surfaceHigh,
    },
    openFileButtonPressed: {
        opacity: 0.85,
    },
    openFileIcon: {
        color: theme.colors.textSecondary,
    },
    kindBadge: {
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHighest ?? theme.colors.surface,
    },
    kindBadgeNew: {
        borderColor: theme.colors.success,
    },
    kindBadgeDeleted: {
        borderColor: theme.colors.warningCritical ?? theme.colors.warning,
    },
    kindBadgeRenamed: {
        borderColor: theme.colors.accent.indigo,
    },
    kindText: {
        fontSize: 11,
        fontWeight: '600',
        fontFamily: 'monospace',
    },
    kindTextNew: {
        color: theme.colors.success,
    },
    kindTextDeleted: {
        color: theme.colors.warningCritical ?? theme.colors.warning,
    },
    kindTextRenamed: {
        color: theme.colors.accent.indigo,
    },
    inlineDiffContainer: {
        marginBottom: 12,
        borderRadius: 10,
        overflow: 'hidden',
        ...Platform.select({
            web: { overflowAnchor: 'none' as any } as any,
            default: null,
        }),
    },
}));
