import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';


type IndexingOption = { id?: string; name?: string; kind?: string };

function asOptions(input: unknown): IndexingOption[] {
    const obj = asRecord(input);
    if (!obj) return [];
    const nestedOptions = asRecord(obj.options);
    const toolCall = asRecord(obj.toolCall);
    const toolCallOptions = asRecord(toolCall?.options);
    const options =
        Array.isArray(obj.options) ? (obj.options as unknown[])
            : Array.isArray(nestedOptions?.options) ? nestedOptions.options
                : Array.isArray(toolCall?.options) ? toolCall.options
                    : Array.isArray(toolCallOptions?.options) ? toolCallOptions.options
                        : [];
    return options
        .filter((v) => v && typeof v === 'object')
        .map((v) => {
            const o = v as Record<string, unknown>;
            return {
                id: typeof o.id === 'string' ? o.id : undefined,
                name: typeof o.name === 'string' ? o.name : undefined,
                kind: typeof o.kind === 'string' ? o.kind : undefined,
            };
        });
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export const projectWorkspaceIndexingPermissionDisplayText: ToolDisplayTextProjector = (tool) => {
    const input = asRecord(tool.input);
    const toolCall = asRecord(input?.toolCall);
    const title =
        (typeof input?.title === 'string' && input.title.trim().length > 0
            ? input.title.trim()
            : typeof toolCall?.title === 'string' && toolCall.title.trim().length > 0
                ? toolCall.title.trim()
                : null) ?? t('tools.workspaceIndexingPermission.defaultTitle');
    return [
        ...toolTextBlock('tool-indexing-title', title),
        ...toolTextBlock('tool-indexing-description', t('tools.workspaceIndexingPermission.description')),
        ...asOptions(tool.input).flatMap((option, index) => toolTextBlock(`tool-indexing-option-${index}`, `• ${option.name ?? option.id ?? t('tools.workspaceIndexingPermission.optionFallback')}`)),
        ...toolTextBlock('tool-indexing-hint', t('tools.workspaceIndexingPermission.chooseOptionHint')),
    ];
};

export const WorkspaceIndexingPermissionView = React.memo<ToolViewProps>(({ tool, detailLevel, messageId }) => {
    const find = useToolFindState(messageId);
    if (detailLevel === 'title') return null;
    const blocks = projectWorkspaceIndexingPermissionDisplayText(tool);
    const title = blocks.find((block) => block.id === 'tool-indexing-title')!;
    const options = blocks.filter((block) => block.id.startsWith('tool-indexing-option-'));
    const isFull = detailLevel === 'full' || find.active;
    const visibleOptions = isFull ? options : options.slice(0, 2);
    const remainingOptions = Math.max(0, options.length - visibleOptions.length);

    return (
        <ToolSectionView>
            <View style={styles.container}>
                <ToolFindText text={title.text} blockId={title.id} messageId={messageId} style={styles.title} />
                {isFull ? (
                    <ToolFindText text={t('tools.workspaceIndexingPermission.description')} blockId="tool-indexing-description" messageId={messageId} style={styles.body} />
                ) : null}
                {visibleOptions.length > 0 ? (
                    <View style={styles.options}>
                        {visibleOptions.map((opt) => (
                            <ToolFindText key={opt.id} text={opt.text} blockId={opt.id} messageId={messageId} style={styles.optionLine} />
                        ))}
                        {remainingOptions > 0 ? (
                            <Text style={styles.optionMore}>
                                {t('tools.structuredResult.more', { count: remainingOptions })}
                            </Text>
                        ) : null}
                    </View>
                ) : null}
                {isFull ? (
                    <ToolFindText text={t('tools.workspaceIndexingPermission.chooseOptionHint')} blockId="tool-indexing-hint" messageId={messageId} style={styles.hint} />
                ) : null}
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
        color: theme.colors.text.primary,
    },
    body: {
        fontSize: 13,
        color: theme.colors.text.primary,
        lineHeight: 18,
    },
    options: {
        gap: 6,
        padding: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.elevated,
    },
    optionLine: {
        fontSize: 13,
        color: theme.colors.text.primary,
    },
    optionMore: {
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    hint: {
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
}));
