import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { DiffFilesListView } from '@/components/ui/code/diff/DiffFilesListView';
import { useDiffFilesExpansionState } from '@/components/ui/code/diff/useDiffFilesExpansionState';
import { buildDiffBlocks, buildDiffFileEntries, type DiffFileEntry } from '@/components/ui/code/model/diff/diffViewModel';
import { useSetting } from '@/sync/domains/state/storage';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { t } from '@/text';

function normalizeFenceLanguage(language: string | null | undefined): string | null {
    const raw = typeof language === 'string' ? language.trim().toLowerCase() : '';
    return raw ? raw : null;
}

function isDiffFenceLanguage(language: string | null): boolean {
    if (!language) return false;
    return language === 'diff' || language === 'patch';
}

export const MarkdownCodeBlock = React.memo((props: Readonly<{
    content: string;
    language: string | null;
    selectable: boolean;
}>) => {
    const normalizedLanguage = normalizeFenceLanguage(props.language);
    const tokenizationMaxBytesSetting = useSetting('filesDiffTokenizationMaxBytes');
    const tokenizationMaxBytes = typeof tokenizationMaxBytesSetting === 'number'
        ? tokenizationMaxBytesSetting
        : (settingsDefaults.filesDiffTokenizationMaxBytes as number);

    const canRenderDiff = isDiffFenceLanguage(normalizedLanguage)
        && typeof props.content === 'string'
        && props.content.length <= tokenizationMaxBytes;

    const [mode, setMode] = React.useState<'diff' | 'code'>(canRenderDiff ? 'diff' : 'code');

    const wrapLinesInDiffs = useSetting('wrapLinesInDiffs');
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    const fileListVirtualizationMinFilesSetting = useSetting('filesDiffFileListVirtualizationMinFiles');

    const wrapLines = wrapLinesInDiffs !== false;
    const showLineNumbers = showLineNumbersInToolViews === true;
    const showPrefix = showLineNumbers;

    const blocks = React.useMemo(() => {
        if (!canRenderDiff) return [];
        return buildDiffBlocks({ unified_diff: props.content });
    }, [canRenderDiff, props.content]);

    const files: DiffFileEntry[] = React.useMemo(() => {
        if (!canRenderDiff) return [];
        return buildDiffFileEntries(blocks);
    }, [blocks, canRenderDiff]);

    const effectiveMode: 'diff' | 'code' = React.useMemo(() => {
        if (!canRenderDiff) return 'code';
        if (files.length === 0) return 'code';
        return mode;
    }, [canRenderDiff, files.length, mode]);

    const fileListVirtualizationMinFiles = typeof fileListVirtualizationMinFilesSetting === 'number' && fileListVirtualizationMinFilesSetting > 0
        ? fileListVirtualizationMinFilesSetting
        : (settingsDefaults.filesDiffFileListVirtualizationMinFiles as number);
    const virtualizeFileList = files.length >= fileListVirtualizationMinFiles;

    const { expandedKeys, toggleExpanded } = useDiffFilesExpansionState({
        files,
        defaultExpanded: files.length <= 1,
    });

    if (!canRenderDiff) {
        return (
            <CodeBlockView
                code={props.content}
                language={props.language}
                selectable={props.selectable}
                wrap={false}
                showCopyButton={true}
                scrollTestID="markdown-code-block-scroll"
            />
        );
    }

    if (files.length === 0) {
        return (
            <CodeBlockView
                code={props.content}
                language={props.language}
                selectable={props.selectable}
                wrap={false}
                showCopyButton={true}
                scrollTestID="markdown-code-block-scroll"
            />
        );
    }

    return (
        <View>
            <View style={styles.toggleRow}>
                <Pressable
                    testID="markdown-code-block-toggle:diff"
                    accessibilityRole="button"
                    onPress={() => setMode('diff')}
                    style={[styles.toggleButton, effectiveMode === 'diff' ? styles.toggleButtonActive : null]}
                >
                    <Text style={[styles.toggleText, effectiveMode === 'diff' ? styles.toggleTextActive : null]}>
                        {t('markdown.diffLabel')}
                    </Text>
                </Pressable>
                <Pressable
                    testID="markdown-code-block-toggle:code"
                    accessibilityRole="button"
                    onPress={() => setMode('code')}
                    style={[styles.toggleButton, effectiveMode === 'code' ? styles.toggleButtonActive : null]}
                >
                    <Text style={[styles.toggleText, effectiveMode === 'code' ? styles.toggleTextActive : null]}>
                        {t('markdown.codeLabel')}
                    </Text>
                </Pressable>
            </View>

            {effectiveMode === 'diff' ? (
                <DiffFilesListView
                    files={files}
                    expandedKeys={expandedKeys}
                    onToggleExpanded={toggleExpanded}
                    canRenderInlineDiffs={true}
                    wrapLines={wrapLines}
                    showLineNumbers={showLineNumbers}
                    showPrefix={showPrefix}
                    virtualizeFileList={virtualizeFileList}
                    virtualizedListLayout="intrinsic"
                />
            ) : (
                <CodeBlockView
                    code={props.content}
                    language={props.language}
                    selectable={props.selectable}
                    wrap={false}
                    showCopyButton={true}
                    scrollTestID="markdown-code-block-scroll"
                />
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    toggleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 8,
        paddingTop: 8,
        paddingBottom: 4,
    },
    toggleButton: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.inset,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    toggleButtonActive: {
        backgroundColor: theme.colors.surface.elevated,
        borderColor: theme.colors.text.link ?? theme.colors.border.default,
    },
    toggleText: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontWeight: '600',
    },
    toggleTextActive: {
        color: theme.colors.text.primary,
    },
}));
