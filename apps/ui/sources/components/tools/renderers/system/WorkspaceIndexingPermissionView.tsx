import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';


type IndexingOption = { id?: string; name?: string; kind?: string };

function asOptions(input: unknown): IndexingOption[] {
    if (!input || typeof input !== 'object') return [];
    const obj = input as any;
    const options =
        Array.isArray(obj.options) ? (obj.options as unknown[])
            : Array.isArray(obj?.options?.options) ? (obj.options.options as unknown[])
                : Array.isArray(obj?.toolCall?.options) ? (obj.toolCall.options as unknown[])
                    : Array.isArray(obj?.toolCall?.options?.options) ? (obj.toolCall.options.options as unknown[])
                        : [];
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

export const WorkspaceIndexingPermissionView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    if (detailLevel === 'title') return null;
    const input = tool.input as any;
    const title =
        (typeof input?.title === 'string' && input.title.trim().length > 0
            ? input.title.trim()
            : typeof input?.toolCall?.title === 'string' && input.toolCall.title.trim().length > 0
                ? input.toolCall.title.trim()
                : null) ?? t('tools.workspaceIndexingPermission.defaultTitle');

    const options = asOptions(tool.input);
    const visibleOptions = detailLevel === 'full' ? options : options.slice(0, 2);
    const remainingOptions = Math.max(0, options.length - visibleOptions.length);

    return (
        <ToolSectionView>
            <View style={styles.container}>
                <Text style={styles.title}>{title}</Text>
                {detailLevel === 'full' ? (
                    <Text style={styles.body}>
                        {t('tools.workspaceIndexingPermission.description')}
                    </Text>
                ) : null}
                {visibleOptions.length > 0 ? (
                    <View style={styles.options}>
                        {visibleOptions.map((opt, idx) => (
                            <Text key={`${opt.id ?? 'opt'}-${idx}`} style={styles.optionLine}>
                                • {opt.name ?? opt.id ?? t('tools.workspaceIndexingPermission.optionFallback')}
                            </Text>
                        ))}
                        {remainingOptions > 0 ? (
                            <Text style={styles.optionMore}>
                                {t('tools.structuredResult.more', { count: remainingOptions })}
                            </Text>
                        ) : null}
                    </View>
                ) : null}
                {detailLevel === 'full' ? (
                    <Text style={styles.hint}>{t('tools.workspaceIndexingPermission.chooseOptionHint')}</Text>
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
