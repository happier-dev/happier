import * as React from 'react';
import { ScrollView, View, Text, Pressable, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { ToolDiffView } from '@/components/tools/shell/presentation/ToolDiffView';
import { useSetting } from '@/sync/domains/state/storage';
import { CodeLinesView } from '@/components/ui/code/view/CodeLinesView';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { buildDiffBlocks, buildDiffFileEntries, type DiffFileEntry } from '@/components/ui/code/model/diff/diffViewModel';
import { t } from '@/text';
import { useToolHeaderActions } from '../../shell/presentation/ToolHeaderActionsContext';

function UnifiedDiffInlineView(props: Readonly<{
    unifiedDiff: string;
    wrapLines: boolean;
    showLineNumbers: boolean;
    showPrefix: boolean;
}>) {
    const lines = React.useMemo(() => buildCodeLinesFromUnifiedDiff({ unifiedDiff: props.unifiedDiff }), [props.unifiedDiff]);
    const view = (
        <View style={{ flex: 1 }}>
            <CodeLinesView
                lines={lines}
                wrapLines={props.wrapLines}
                virtualized={false}
                showLineNumbers={props.showLineNumbers}
                showPrefix={props.showPrefix}
            />
        </View>
    );

    if (props.wrapLines) return view;

    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={true}
            contentContainerStyle={{ flexGrow: 1 }}
        >
            {view}
        </ScrollView>
    );
}

export const DiffView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    const wrapLines = useSetting('wrapLinesInDiffs');
    const { input } = tool;

    const blocks = React.useMemo(() => buildDiffBlocks(input), [input]);

    const effectiveDetailLevel = detailLevel ?? 'summary';

    const files: DiffFileEntry[] = React.useMemo(() => buildDiffFileEntries(blocks), [blocks]);

    const [expandedKeys, setExpandedKeys] = React.useState<Set<string>>(() => new Set());
    const [focusedFileKey, setFocusedFileKey] = React.useState<string | null>(null);
    const keysFingerprint = React.useMemo(() => files.map((f) => f.key).join('|'), [files]);

    React.useEffect(() => {
        setExpandedKeys((prev) => {
            const next = new Set<string>();
            const keys = new Set(files.map((f) => f.key));
            for (const key of prev) {
                if (keys.has(key)) next.add(key);
            }

            // In full view, default to expanded (including new files that appear mid-stream).
            if (effectiveDetailLevel === 'full') {
                for (const key of keys) next.add(key);
            }

            return next;
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [effectiveDetailLevel, keysFingerprint]);

    const canRenderInlineDiffs = effectiveDetailLevel !== 'title';
    const showFileList = effectiveDetailLevel !== 'title';

    const allExpanded = files.length > 0 && files.every((f) => expandedKeys.has(f.key));

    const setAllExpanded = React.useCallback(
        (expanded: boolean) => {
            setExpandedKeys(() => {
                if (!expanded) return new Set();
                return new Set(files.map((f) => f.key));
            });
        },
        [files],
    );

    const toggleExpanded = React.useCallback((key: string) => {
        setExpandedKeys((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);

    const headerActionsNode = React.useMemo(() => {
        if (!showFileList) return null;
        if (files.length <= 1) return null;

        return (
            <Pressable
                onPress={() => setAllExpanded(!allExpanded)}
                style={styles.headerControlButton}
                accessibilityRole="button"
            >
                <Text style={styles.headerControlButtonText}>
                    {allExpanded ? t('machineLauncher.showLess') : t('machineLauncher.showAll', { count: files.length })}
                </Text>
            </Pressable>
        );
    }, [allExpanded, files.length, setAllExpanded, showFileList]);

    useToolHeaderActions(headerActionsNode);

    if (files.length === 0) {
        return null;
    }

    if (!showFileList) {
        // Title view: compact summary only.
        const first = files[0];
        return (
            <View style={styles.titleRow}>
                <Text style={styles.titleText}>
                    {files.length === 1
                        ? `${first.filePath ?? t('files.diff')} (+${first.added} -${first.removed})`
                        : t('tools.desc.modifyingFiles', { count: files.length })}
                </Text>
            </View>
        );
    }

    return (
        <>
            {files.map((file) => {
                const expanded = expandedKeys.has(file.key);

                return (
                    <React.Fragment key={file.key}>
                        <Pressable
                            onPress={() => toggleExpanded(file.key)}
                            onFocus={() => setFocusedFileKey(file.key)}
                            onBlur={() => setFocusedFileKey((prev) => (prev === file.key ? null : prev))}
                            style={({ hovered, pressed }) => ([
                                styles.fileRow,
                                hovered ? styles.fileRowHovered : null,
                                pressed ? styles.fileRowPressed : null,
                                focusedFileKey === file.key ? styles.fileRowFocused : null,
                            ])}
                            accessibilityRole="button"
                        >
                            <Text style={styles.disclosure}>{expanded ? '▾' : '▸'}</Text>
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
                                            {file.kind === 'new' ? t('common.create') : file.kind === 'deleted' ? t('common.delete') : t('common.rename')}
                                        </Text>
                                    </View>
                                ) : null}
                            </View>
                            <Text style={styles.statsText}>
                                +{file.added} -{file.removed}
                            </Text>
                        </Pressable>

                        {canRenderInlineDiffs && expanded ? (
                            file.unifiedDiff ? (
                                <ToolSectionView fullWidth>
                                    <UnifiedDiffInlineView
                                        unifiedDiff={file.unifiedDiff}
                                        wrapLines={wrapLines}
                                        showLineNumbers={showLineNumbersInToolViews}
                                        showPrefix={showLineNumbersInToolViews}
                                    />
                                </ToolSectionView>
                            ) : file.oldText != null && file.newText != null ? (
                                <ToolSectionView fullWidth>
                                    <ToolDiffView
                                        oldText={file.oldText}
                                        newText={file.newText}
                                        showLineNumbers={showLineNumbersInToolViews}
                                        showPlusMinusSymbols={showLineNumbersInToolViews}
                                    />
                                </ToolSectionView>
                            ) : null
                        ) : null}
                    </React.Fragment>
                );
            })}
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    titleRow: {
        paddingHorizontal: 16,
        paddingVertical: 8,
    },
    titleText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        fontFamily: 'monospace',
    },
    headerControlButton: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    headerControlButtonText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontWeight: '600',
    },
    fileRow: {
        paddingHorizontal: 12,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
        marginBottom: 8,
        overflow: 'hidden',
        ...Platform.select({
            web: {
                outlineStyle: 'none',
            } as any,
            default: {},
        }),
    },
    fileRowHovered: {
        backgroundColor: theme.colors.surfaceHighest,
    },
    fileRowPressed: {
        backgroundColor: theme.colors.surfaceHighest,
    },
    fileRowFocused: {
        borderColor: theme.colors.textLink,
        ...(Platform.OS === 'web'
            ? ({ boxShadow: `0 0 0 2px ${theme.colors.textLink}33` } as any)
            : {
                shadowColor: theme.colors.textLink,
                shadowOpacity: 0.25,
                shadowRadius: 6,
                shadowOffset: { width: 0, height: 0 },
                elevation: 2,
            }),
    },
    disclosure: {
        width: 16,
        textAlign: 'center',
        color: theme.colors.textSecondary,
        fontFamily: 'monospace',
    },
    fileRowMain: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        gap: 8,
        minWidth: 0,
    },
    filePath: {
        flex: 1,
        minWidth: 0,
        fontSize: 13,
        color: theme.colors.text,
        fontFamily: 'monospace',
    },
    statsText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'monospace',
    },
    kindBadge: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 999,
        borderWidth: 1,
    },
    kindText: {
        fontSize: 11,
        fontWeight: '600',
    },
    kindBadgeNew: {
        backgroundColor: theme.colors.diff.addedBg,
        borderColor: theme.colors.diff.addedBorder,
    },
    kindTextNew: {
        color: theme.colors.diff.addedText,
    },
    kindBadgeDeleted: {
        backgroundColor: theme.colors.diff.removedBg,
        borderColor: theme.colors.diff.removedBorder,
    },
    kindTextDeleted: {
        color: theme.colors.diff.removedText,
    },
    kindBadgeRenamed: {
        backgroundColor: theme.colors.box.warning.background,
        borderColor: theme.colors.box.warning.border,
    },
    kindTextRenamed: {
        color: theme.colors.box.warning.text,
    },
}));
