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
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';
import { buildToolFileDiffLines, projectToolDiffLines } from './toolDiffDisplayText';


function readMultiEditInput(input: unknown) {
    let edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }> = [];
    let filePath: string | null = null;
    
    const parsed = knownTools.MultiEdit.input.safeParse(input);
    if (parsed.success && Array.isArray(parsed.data.edits)) {
        filePath = typeof parsed.data.file_path === 'string' ? parsed.data.file_path : null;
        edits = parsed.data.edits.flatMap((edit) => typeof edit.old_string === 'string' && typeof edit.new_string === 'string'
            ? [{ old_string: trimIdent(edit.old_string), new_string: trimIdent(edit.new_string), replace_all: Boolean(edit.replace_all) }]
            : []);
    }
    return { edits, filePath };
}

export const projectMultiEditDisplayText: ToolDisplayTextProjector = (tool) => {
    const { edits } = readMultiEditInput(tool.input);
    return edits.flatMap((edit, index) => [
        ...toolTextBlock(`tool-multi-edit-${index}-header`, t('tools.multiEdit.editNumber', { index: index + 1, total: edits.length })),
        ...toolTextBlock(`tool-multi-edit-${index}-replace-all`, edit.replace_all ? t('tools.multiEdit.replaceAll') : null),
        ...projectToolDiffLines(buildToolFileDiffLines({ oldText: edit.old_string, newText: edit.new_string }), `tool-multi-edit-${index}`),
    ]);
};

export const MultiEditView = React.memo<ToolViewProps>(({ tool, detailLevel, sessionId, serverId, messageId }) => {
    const find = useToolFindState(messageId);
    const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
    const { edits, filePath } = readMultiEditInput(tool.input);

    if (edits.length === 0) {
        return null;
    }

    if (detailLevel === 'title' && !find.active) {
        return (
            <ToolSectionView>
                <Text style={styles.summaryText}>{t('tools.multiEdit.summaryEdits', { count: edits.length })}</Text>
            </ToolSectionView>
        );
    }

    const isFull = detailLevel === 'full';
    const maxEdits = isFull || find.active ? edits.length : 1;
    const visibleEdits = edits.slice(0, maxEdits);
    const remaining = edits.length - visibleEdits.length;
    const showLineNumbers = isFull ? true : !!showLineNumbersInToolViews;

    return (
        <ToolSectionView fullWidth>
            <View>
                {visibleEdits.map((edit, index) => {
                    const oldString = edit.old_string;
                    const newString = edit.new_string;
                    
                    return (
                        <View key={index}>
                            {isFull || find.active ? (
                                <View style={styles.editHeader}>
                                    <ToolFindText style={styles.editNumber} text={t('tools.multiEdit.editNumber', { index: index + 1, total: edits.length })} blockId={`tool-multi-edit-${index}-header`} messageId={messageId} />
                                    {edit.replace_all ? (
                                        <View style={styles.replaceAllBadge}>
                                            <ToolFindText text={t('tools.multiEdit.replaceAll')} blockId={`tool-multi-edit-${index}-replace-all`} messageId={messageId} style={styles.replaceAllText} />
                                        </View>
                                    ) : null}
                                </View>
                            ) : null}
                            <ToolDiffView
                                messageId={messageId}
                                findBlockPrefix={`tool-multi-edit-${index}`}
                                sessionId={sessionId}
                                serverId={serverId}
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
