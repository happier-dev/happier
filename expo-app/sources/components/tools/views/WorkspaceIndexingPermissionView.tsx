import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from './_registry';
import { ToolSectionView } from '../ToolSectionView';

type IndexingOption = { id?: string; name?: string; kind?: string };

function asOptions(input: unknown): IndexingOption[] {
    if (!input || typeof input !== 'object') return [];
    const obj = input as any;
    const options = Array.isArray(obj.options) ? (obj.options as unknown[]) : [];
    return options
        .filter((v) => v && typeof v === 'object')
        .map((v) => {
            const o = v as any;
            return {
                id: typeof o.id === 'string' ? o.id : undefined,
                name: typeof o.name === 'string' ? o.name : undefined,
                kind: typeof o.kind === 'string' ? o.kind : undefined,
            };
        });
}

export const WorkspaceIndexingPermissionView = React.memo<ToolViewProps>(({ tool }) => {
    const input = tool.input as any;
    const title =
        (typeof input?.title === 'string' && input.title.trim().length > 0
            ? input.title.trim()
            : typeof input?.toolCall?.title === 'string' && input.toolCall.title.trim().length > 0
                ? input.toolCall.title.trim()
                : null) ?? 'Workspace indexing';

    const options = asOptions(tool.input);

    return (
        <ToolSectionView>
            <View style={styles.container}>
                <Text style={styles.title}>{title}</Text>
                <Text style={styles.body}>
                    Indexing helps the agent search your codebase faster and provide more accurate answers. This may scan files in your workspace.
                </Text>
                {options.length > 0 ? (
                    <View style={styles.options}>
                        {options.map((opt, idx) => (
                            <Text key={`${opt.id ?? 'opt'}-${idx}`} style={styles.optionLine}>
                                • {opt.name ?? opt.id ?? 'Option'}
                            </Text>
                        ))}
                    </View>
                ) : null}
                <Text style={styles.hint}>Choose an option below to continue.</Text>
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 10,
        paddingVertical: 4,
    },
    title: {
        fontSize: 15,
        fontWeight: '700',
        color: theme.colors.text,
    },
    body: {
        fontSize: 13,
        color: theme.colors.text,
        lineHeight: 18,
    },
    options: {
        gap: 6,
        padding: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHighest,
    },
    optionLine: {
        fontSize: 13,
        color: theme.colors.text,
    },
    hint: {
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
}));

