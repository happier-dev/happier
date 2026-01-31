import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from './_registry';
import { ToolSectionView } from '../ToolSectionView';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { useSetting } from '@/sync/storage';

export const DiffView = React.memo<ToolViewProps>(({ tool }) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    const { input } = tool;

    let oldText = '';
    let newText = '';
    let fileName: string | undefined;

    if (input?.unified_diff && typeof input.unified_diff === 'string') {
        const parsed = parseUnifiedDiff(input.unified_diff);
        oldText = parsed.oldText;
        newText = parsed.newText;
        fileName = parsed.fileName;
    }

    const fileHeader = fileName ? (
        <View style={styles.fileHeader}>
            <Text style={styles.fileName}>{fileName}</Text>
        </View>
    ) : null;

    return (
        <>
            {fileHeader}
            <ToolSectionView fullWidth>
                <ToolDiffView
                    oldText={oldText}
                    newText={newText}
                    showLineNumbers={showLineNumbersInToolViews}
                    showPlusMinusSymbols={showLineNumbersInToolViews}
                />
            </ToolSectionView>
        </>
    );
});

/**
 * Parse a unified diff to extract old and new content
 * This is a simplified parser that handles basic unified diff format
 */
function parseUnifiedDiff(unifiedDiff: string): { oldText: string; newText: string; fileName?: string } {
    const lines = unifiedDiff.split('\n');
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let fileName: string | undefined;
    let inHunk = false;

    for (const line of lines) {
        if (line.startsWith('+++ b/') || line.startsWith('+++ ')) {
            fileName = line.replace(/^\+\+\+ (b\/)?/, '');
            continue;
        }

        if (
            line.startsWith('diff --git') ||
            line.startsWith('index ') ||
            line.startsWith('---') ||
            line.startsWith('new file mode') ||
            line.startsWith('deleted file mode')
        ) {
            continue;
        }

        if (line.startsWith('@@')) {
            inHunk = true;
            continue;
        }

        if (!inHunk) continue;

        if (line.startsWith('+')) {
            newLines.push(line.substring(1));
        } else if (line.startsWith('-')) {
            oldLines.push(line.substring(1));
        } else if (line.startsWith(' ')) {
            oldLines.push(line.substring(1));
            newLines.push(line.substring(1));
        } else if (line === '\\ No newline at end of file') {
            continue;
        } else if (line === '') {
            oldLines.push('');
            newLines.push('');
        }
    }

    return {
        oldText: oldLines.join('\n'),
        newText: newLines.join('\n'),
        fileName,
    };
}

const styles = StyleSheet.create((theme) => ({
    fileHeader: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        backgroundColor: theme.colors.surfaceHigh,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    fileName: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        fontFamily: 'monospace',
    },
}));
