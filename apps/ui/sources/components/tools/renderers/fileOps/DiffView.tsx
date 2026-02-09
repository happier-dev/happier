import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { ToolDiffView } from '@/components/tools/shell/presentation/ToolDiffView';
import { useSetting } from '@/sync/domains/state/storage';
import { buildDiffBlocks, buildDiffFileEntries, parseUnifiedDiff, type DiffFileEntry } from '@/components/diff/diffViewModel';
import { t } from '@/text';

export const DiffView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    const { input } = tool;

    const blocks = React.useMemo(() => buildDiffBlocks(input), [input]);

    const effectiveDetailLevel = detailLevel ?? 'summary';

    const files: DiffFileEntry[] = React.useMemo(() => buildDiffFileEntries(blocks), [blocks]);

    const [expandedKeys, setExpandedKeys] = React.useState<Set<string>>(() => new Set());
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
            {files.length > 1 ? (
                <View style={styles.controlsRow}>
                    <Pressable
                        onPress={() => setAllExpanded(!allExpanded)}
                        style={styles.controlButton}
                        accessibilityRole="button"
                    >
                        <Text style={styles.controlButtonText}>{allExpanded ? t('machineLauncher.showLess') : t('machineLauncher.showAll', { count: files.length })}</Text>
                    </Pressable>
                </View>
            ) : null}

            {files.map((file) => {
                const expanded = expandedKeys.has(file.key);
                const parsed =
                    expanded
                        ? file.unifiedDiff
                            ? parseUnifiedDiff(file.unifiedDiff)
                            : file.oldText != null && file.newText != null
                                ? { oldText: file.oldText, newText: file.newText, fileName: file.filePath }
                                : null
                        : null;

                return (
                    <React.Fragment key={file.key}>
                        <Pressable
                            onPress={() => toggleExpanded(file.key)}
                            style={styles.fileRow}
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

                        {canRenderInlineDiffs && expanded && parsed ? (
                            <ToolSectionView fullWidth>
                                <ToolDiffView
                                    oldText={parsed.oldText}
                                    newText={parsed.newText}
                                    showLineNumbers={showLineNumbersInToolViews}
                                    showPlusMinusSymbols={showLineNumbersInToolViews}
                                />
                            </ToolSectionView>
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
    controlsRow: {
        paddingHorizontal: 16,
        paddingTop: 6,
        paddingBottom: 4,
        flexDirection: 'row',
        justifyContent: 'flex-end',
    },
    controlButton: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    controlButtonText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontWeight: '600',
    },
    fileRow: {
        paddingHorizontal: 16,
        paddingVertical: 10,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
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
