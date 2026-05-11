import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { McpValueRefV1 } from '@happier-dev/protocol';
import { McpValueRefV1Schema } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

type PatchKind = 'env' | 'header';

function describeValueRef(valueRef: McpValueRefV1): string {
    if (valueRef.t === 'literal') return t('settings.mcpServersValueSourceLiteral');
    return t('settings.mcpServersValueSourceSavedSecret');
}

function describePatchedValue(value: McpValueRefV1 | null): string {
    if (value === null) {
        return t('settings.mcpServersOverridesDeleteValue');
    }

    const parsed = McpValueRefV1Schema.safeParse(value);
    return parsed.success ? describeValueRef(parsed.data) : t('settings.mcpServersValidationFailed');
}

export type McpBindingOverridesValuePatchGroupProps = Readonly<{
    kind: PatchKind;
    patch: Record<string, McpValueRefV1 | null>;
    setPatch: React.Dispatch<React.SetStateAction<Record<string, McpValueRefV1 | null>>>;
    openValueRefModal: (params: Readonly<{
        kind: PatchKind;
        initialKey: string;
        initialValueRef: McpValueRefV1;
        existingKeys: ReadonlySet<string>;
        onDelete: () => void;
        onSubmit: (next: { key: string; valueRef: McpValueRefV1 }) => void;
    }>) => void;
    onPressDeleteKey: () => void;
}>;

export const McpBindingOverridesValuePatchGroup = React.memo(function McpBindingOverridesValuePatchGroup(
    props: McpBindingOverridesValuePatchGroupProps,
) {
    const { theme } = useUnistyles();
    const entries = React.useMemo(() => Object.entries(props.patch).sort((a, b) => a[0].localeCompare(b[0])), [props.patch]);
    const existingKeys = React.useMemo(() => new Set(Object.keys(props.patch)), [props.patch]);

    const isEnv = props.kind === 'env';
    const iconName = isEnv ? 'code-outline' : 'key-outline';

    const groupTitle = isEnv ? t('settings.mcpServersOverridesEnvPatchTitle') : t('settings.mcpServersOverridesHeadersPatchTitle');
    const emptyTitle = isEnv ? t('settings.mcpServersOverridesEnvPatchEmptyTitle') : t('settings.mcpServersOverridesHeadersPatchEmptyTitle');
    const emptySubtitle = isEnv ? t('settings.mcpServersOverridesEnvPatchEmptySubtitle') : t('settings.mcpServersOverridesHeadersPatchEmptySubtitle');
    const addTitle = isEnv ? t('settings.mcpServersOverridesEnvPatchAddTitle') : t('settings.mcpServersOverridesHeadersPatchAddTitle');
    const addSubtitle = isEnv ? t('settings.mcpServersOverridesEnvPatchAddSubtitle') : t('settings.mcpServersOverridesHeadersPatchAddSubtitle');
    const deleteTitle = isEnv ? t('settings.mcpServersOverridesEnvPatchDeleteTitle') : t('settings.mcpServersOverridesHeadersPatchDeleteTitle');
    const deleteSubtitle = isEnv ? t('settings.mcpServersOverridesEnvPatchDeleteSubtitle') : t('settings.mcpServersOverridesHeadersPatchDeleteSubtitle');

    return (
        <ItemGroup title={groupTitle}>
            {entries.length === 0 ? (
                <Item
                    title={emptyTitle}
                    subtitle={emptySubtitle}
                    icon={<Ionicons name={iconName} size={29} color={theme.colors.text.secondary} />}
                    showChevron={false}
                />
            ) : null}

            {entries.map(([key, value], idx) => (
                <Item
                    key={key}
                    title={key}
                    subtitle={describePatchedValue(value)}
                    icon={<Ionicons name={iconName} size={29} color={value === null ? theme.colors.state.danger.foreground : theme.colors.accent.indigo} />}
                    onPress={() => {
                        if (value === null) {
                            props.setPatch((prev) => {
                                const next = { ...prev };
                                delete next[key];
                                return next;
                            });
                            return;
                        }

                        props.openValueRefModal({
                            kind: props.kind,
                            initialKey: key,
                            initialValueRef: value,
                            existingKeys,
                            onDelete: () => props.setPatch((prev) => {
                                const next = { ...prev };
                                delete next[key];
                                return next;
                            }),
                            onSubmit: ({ key: nextKey, valueRef }) => {
                                props.setPatch((prev) => {
                                    const next = { ...prev };
                                    delete next[key];
                                    next[nextKey] = valueRef;
                                    return next;
                                });
                            },
                        });
                    }}
                    showDivider={idx < entries.length - 1}
                />
            ))}

            <Item
                title={addTitle}
                subtitle={addSubtitle}
                icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.state.success.foreground} />}
                onPress={() => {
                    props.openValueRefModal({
                        kind: props.kind,
                        initialKey: '',
                        initialValueRef: { t: 'literal', v: '' },
                        existingKeys,
                        onDelete: () => undefined,
                        onSubmit: ({ key, valueRef }) => props.setPatch((prev) => ({ ...prev, [key]: valueRef })),
                    });
                }}
            />

            <Item
                title={deleteTitle}
                subtitle={deleteSubtitle}
                icon={<Ionicons name="remove-circle-outline" size={29} color={theme.colors.state.danger.foreground} />}
                onPress={props.onPressDeleteKey}
                destructive
            />
        </ItemGroup>
    );
});
