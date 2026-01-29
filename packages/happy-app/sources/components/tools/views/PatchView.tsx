import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Octicons } from '@expo/vector-icons';
import type { ToolViewProps } from './_registry';
import { ToolSectionView } from '../ToolSectionView';
import { resolvePath } from '@/utils/pathUtils';
import { ToolDiffView } from '@/components/tools/ToolDiffView';
import { useSetting } from '@/sync/storage';

type PatchChange = {
    filePath: string;
    oldText: string;
    newText: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function firstNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function extractChanges(input: unknown): PatchChange[] {
    const obj = asRecord(input);
    const changes = asRecord(obj?.changes);
    if (!changes) return [];

    const out: PatchChange[] = [];
    for (const [filePath, rawChange] of Object.entries(changes)) {
        const change = asRecord(rawChange);
        if (!change) continue;

        const add = asRecord(change.add);
        const del = asRecord(change.delete);
        const modify = asRecord(change.modify);

        const addContent = firstNonEmptyString(add?.content);
        const deleteContent = firstNonEmptyString(del?.content) ?? '';
        const oldContent = firstNonEmptyString(modify?.old_content) ?? firstNonEmptyString(modify?.oldContent);
        const newContent = firstNonEmptyString(modify?.new_content) ?? firstNonEmptyString(modify?.newContent);

        if (typeof addContent === 'string') {
            out.push({ filePath, oldText: '', newText: addContent });
            continue;
        }

        if (typeof oldContent === 'string' && typeof newContent === 'string') {
            out.push({ filePath, oldText: oldContent, newText: newContent });
            continue;
        }

        if (del || typeof change.type === 'string') {
            const type = typeof change.type === 'string' ? String(change.type).toLowerCase() : null;
            if (type === 'delete' || type === 'remove' || del) {
                out.push({ filePath, oldText: deleteContent, newText: '' });
            }
        }
    }

    return out;
}

export const PatchView = React.memo<ToolViewProps>(({ tool, metadata, detailLevel }) => {
    const { theme } = useUnistyles();
    const { input } = tool;

    const files: string[] = [];
    if (input?.changes && typeof input.changes === 'object') {
        files.push(...Object.keys(input.changes));
    }

    if (detailLevel === 'full') {
        const showLineNumbersInToolViews = useSetting('showLineNumbersInToolViews');
        const changes = extractChanges(tool.input);
        if (changes.length > 0) {
            return (
                <ToolSectionView fullWidth>
                    <View style={styles.fullContainer}>
                        {changes.map((change) => {
                            const resolved = resolvePath(change.filePath, metadata);
                            const basename = resolved.split('/').pop() || resolved;
                            return (
                                <View key={change.filePath} style={styles.fullBlock}>
                                    <Text style={styles.fullFileName} numberOfLines={1}>
                                        {basename}
                                    </Text>
                                    <ToolDiffView
                                        oldText={change.oldText}
                                        newText={change.newText}
                                        showLineNumbers={showLineNumbersInToolViews}
                                        showPlusMinusSymbols={showLineNumbersInToolViews}
                                    />
                                </View>
                            );
                        })}
                    </View>
                </ToolSectionView>
            );
        }
        // If we cannot extract full diff context, fall back to summary rendering.
    }

    const allDeletes =
        input?.changes &&
        typeof input.changes === 'object' &&
        files.length > 0 &&
        Object.values(input.changes as any).every((change) => {
            if (!change || typeof change !== 'object' || Array.isArray(change)) return false;
            const type = typeof (change as any).type === 'string' ? String((change as any).type).toLowerCase() : null;
            return type === 'delete' || (change as any).delete != null;
        });

    const applied = !!(
        tool.result &&
        typeof tool.result === 'object' &&
        !Array.isArray(tool.result) &&
        (tool.result as any).applied === true
    );

    if (files.length === 0) {
        return null;
    }

    if (files.length === 1) {
        const filePath = resolvePath(files[0], metadata);
        const fileName = filePath.split('/').pop() || filePath;

        return (
            <ToolSectionView>
                <View style={styles.fileContainer}>
                    <Octicons name="file-diff" size={16} color={theme.colors.textSecondary} />
                    <Text style={styles.fileName}>{fileName}</Text>
                    {allDeletes ? <Text style={styles.applied}>Deleted</Text> : null}
                    {applied ? <Text style={styles.applied}>Applied</Text> : null}
                </View>
            </ToolSectionView>
        );
    }

    return (
        <ToolSectionView>
            <View style={styles.filesContainer}>
                {allDeletes ? <Text style={styles.applied}>Deleted</Text> : null}
                {applied ? <Text style={styles.applied}>Applied</Text> : null}
                {files.map((file, index) => {
                    const filePath = resolvePath(file, metadata);
                    const fileName = filePath.split('/').pop() || filePath;

                    return (
                        <View key={index} style={styles.fileRow}>
                            <Octicons name="file-diff" size={14} color={theme.colors.textSecondary} />
                            <Text style={styles.fileNameMulti}>{fileName}</Text>
                        </View>
                    );
                })}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    fullContainer: {
        gap: 12,
    },
    fullBlock: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 8,
        overflow: 'hidden',
    },
    fullFileName: {
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'Menlo',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.divider,
    },
    fileContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        padding: 12,
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 8,
    },
    filesContainer: {
        padding: 12,
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 8,
        gap: 8,
    },
    fileRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    fileName: {
        fontSize: 14,
        color: theme.colors.text,
        fontWeight: '500',
    },
    fileNameMulti: {
        fontSize: 13,
        color: theme.colors.text,
    },
    applied: {
        marginLeft: 'auto',
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'Menlo',
    },
}));
