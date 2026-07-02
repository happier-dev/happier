import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { ToolViewProps } from '../core/_registry';
import { ToolDiffView } from '@/components/tools/shell/presentation/ToolDiffView';
import { knownTools } from '../../catalog';
import { trimIdent } from '@/utils/strings/trimIdent';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';


export const MultiEditView = React.memo<ToolViewProps>(({ tool, detailLevel, sessionId }) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    
    let edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }> = [];
    let filePath: string | null = null;
    
    const parsed = knownTools.MultiEdit.input.safeParse(tool.input);
    if (parsed.success && Array.isArray(parsed.data.edits)) {
        filePath = typeof parsed.data.file_path === 'string' ? parsed.data.file_path : null;
        edits = parsed.data.edits
            .filter((e): e is { old_string: string; new_string: string; replace_all?: boolean } =>
                typeof (e as any)?.old_string === 'string' &&
                typeof (e as any)?.new_string === 'string',
            )
            .map((e) => ({
                old_string: (e as any).old_string,
                new_string: (e as any).new_string,
                replace_all: typeof (e as any).replace_all === 'boolean' ? (e as any).replace_all : undefined,
            }));
    }

    if (edits.length === 0) {
        return null;
    }

    if (detailLevel === 'title') {
        return (
            <ToolSectionView>
                <Text style={styles.summaryText}>{t('tools.multiEdit.summaryEdits', { count: edits.length })}</Text>
            </ToolSectionView>
        );
    }

    const isFull = detailLevel === 'full';
    const maxEdits = isFull ? edits.length : 1;
    const visibleEdits = edits.slice(0, maxEdits);
    const remaining = edits.length - visibleEdits.length;
    const showLineNumbers = isFull ? true : !!showLineNumbersInToolViews;

    return (
        <ToolSectionView fullWidth>
            <View>
                {visibleEdits.map((edit, index) => {
                    const oldString = trimIdent(edit.old_string || '');
                    const newString = trimIdent(edit.new_string || '');
                    
                    return (
                        <View key={index}>
                            {isFull ? (
                                <View style={styles.editHeader}>
                                    <Text style={styles.editNumber}>
                                        {t('tools.multiEdit.editNumber', { index: index + 1, total: edits.length })}
                                    </Text>
                                    {edit.replace_all ? (
                                        <View style={styles.replaceAllBadge}>
                                            <Text style={styles.replaceAllText}>{t('tools.multiEdit.replaceAll')}</Text>
                                        </View>
                                    ) : null}
                                </View>
                            ) : null}
                            <ToolDiffView
                                sessionId={sessionId}
                                filePath={filePath}
                                oldText={oldString}
                                newText={newString}
                                showLineNumbers={showLineNumbers}
                                showPlusMinusSymbols={showLineNumbers}
                            />
                            {isFull && index < visibleEdits.length - 1 ? <View style={styles.separator} /> : null}
                        </View>
                    );
                })}
                {!isFull && remaining > 0 ? <Text style={styles.more}>{t('tools.common.more', { count: remaining })}</Text> : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    editHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 8,
    },
    editNumber: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.accent.indigo,
    },
    replaceAllBadge: {
        backgroundColor: theme.colors.accent.indigo,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 12,
        marginLeft: 8,
    },
    replaceAllText: {
        fontSize: 12,
        color: theme.colors.button.primary.tint,
        fontWeight: '600',
    },
    separator: {
        height: 8,
    },
    more: {
        marginTop: 8,
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
    summaryText: {
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
}));
