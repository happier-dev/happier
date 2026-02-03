import * as React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { ToolViewProps } from './_registry';
import { DiffView } from '@/components/diff/DiffView';
import { knownTools } from '../../tools/knownTools';
import { trimIdent } from '@/utils/trimIdent';
import { useSetting } from '@/sync/storage';
import { t } from '@/text';

export const MultiEditView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    const wrapLinesInDiffs = useSetting('wrapLinesInDiffs');
    
    let edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }> = [];
    
    const parsed = knownTools.MultiEdit.input.safeParse(tool.input);
    if (parsed.success && Array.isArray(parsed.data.edits)) {
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
                <Text>{`${edits.length} edit${edits.length === 1 ? '' : 's'}`}</Text>
            </ToolSectionView>
        );
    }

    const isFull = detailLevel === 'full';
    const maxEdits = isFull ? edits.length : 1;
    const visibleEdits = edits.slice(0, maxEdits);
    const remaining = edits.length - visibleEdits.length;
    const showLineNumbers = isFull ? true : !!showLineNumbersInToolViews;

    const content = (
        <View style={{ flex: 1 }}>
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
                        <DiffView 
                            oldText={oldString} 
                            newText={newString} 
                            wrapLines={wrapLinesInDiffs}
                            showLineNumbers={showLineNumbers}
                            showPlusMinusSymbols={showLineNumbers}
                        />
                        {isFull && index < visibleEdits.length - 1 ? <View style={styles.separator} /> : null}
                    </View>
                );
            })}
            {!isFull && remaining > 0 ? <Text style={styles.more}>{`+${remaining} more`}</Text> : null}
        </View>
    );

    if (wrapLinesInDiffs) {
        // When wrapping lines, no horizontal scroll needed
        return (
            <ToolSectionView fullWidth>
                {content}
            </ToolSectionView>
        );
    }

    // When not wrapping, use horizontal scroll
    return (
        <ToolSectionView fullWidth>
            <ScrollView 
                horizontal 
                showsHorizontalScrollIndicator={true}
                showsVerticalScrollIndicator={true}
                nestedScrollEnabled={true}
                contentContainerStyle={{ flexGrow: 1 }}
            >
                {content}
            </ScrollView>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create({
    editHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 8,
    },
    editNumber: {
        fontSize: 14,
        fontWeight: '600',
        color: '#5856D6',
    },
    replaceAllBadge: {
        backgroundColor: '#5856D6',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 12,
        marginLeft: 8,
    },
    replaceAllText: {
        fontSize: 12,
        color: '#fff',
        fontWeight: '600',
    },
    separator: {
        height: 8,
    },
    more: {
        marginTop: 8,
        fontSize: 12,
        color: '#8E8E93',
        fontFamily: 'Menlo',
    },
});
