import * as React from 'react';
import { ScrollView } from 'react-native';

import { ScmDiffDisplay } from '@/components/sessions/files/file/ScmDiffDisplay';
import { Text } from '@/components/ui/text/StyledText';
import { SimpleSyntaxHighlighter } from '@/components/ui/media/SimpleSyntaxHighlighter';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

type FileContentPanelProps = {
    theme: any;
    displayMode: 'file' | 'diff';
    diffContent: string | null;
    fileContent: string | null;
    language: string | null;
    selectedLineIndexes: Set<number>;
    lineSelectionEnabled: boolean;
    onToggleLine: (index: number) => void;
};

export function FileContentPanel({
    theme,
    displayMode,
    diffContent,
    fileContent,
    language,
    selectedLineIndexes,
    lineSelectionEnabled,
    onToggleLine,
}: FileContentPanelProps) {
    return (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }} showsVerticalScrollIndicator>
            {displayMode === 'diff' && diffContent ? (
                <ScmDiffDisplay
                    diffContent={diffContent}
                    selectedLineIndexes={selectedLineIndexes}
                    onToggleLine={lineSelectionEnabled ? onToggleLine : undefined}
                />
            ) : displayMode === 'file' && fileContent ? (
                <SimpleSyntaxHighlighter code={fileContent} language={language} selectable />
            ) : displayMode === 'file' && fileContent === '' ? (
                <Text
                    style={{
                        fontSize: 16,
                        color: theme.colors.textSecondary,
                        fontStyle: 'italic',
                        ...Typography.default(),
                    }}
                >
                    {t('files.fileEmpty')}
                </Text>
            ) : !diffContent && !fileContent ? (
                <Text
                    style={{
                        fontSize: 16,
                        color: theme.colors.textSecondary,
                        fontStyle: 'italic',
                        ...Typography.default(),
                    }}
                >
                    {t('files.noChanges')}
                </Text>
            ) : null}
        </ScrollView>
    );
}
