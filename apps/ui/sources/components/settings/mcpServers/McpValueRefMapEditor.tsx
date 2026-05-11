import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { McpValueRefV1 } from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Modal } from '@/modal';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { t } from '@/text';

import { ValueRefEditorModal, getValueRefEditorModalTitle } from '@/components/ui/forms/valueRefs/ValueRefEditorModal';

type ValueRefKind = 'env' | 'header';

function describeValueRef(valueRef: McpValueRefV1, secrets: readonly SavedSecret[]): string {
    if (valueRef.t === 'literal') {
        return t('settings.mcpServersValueSourceLiteral');
    }
    const secretId = valueRef.secretId;
    const secretName = secrets.find((s) => s.id === secretId)?.name ?? null;
    if (secretName) {
        return t('settings.mcpServersValueSourceSavedSecretNamed', { name: secretName });
    }
    return t('settings.mcpServersValueSourceSavedSecret');
}

export const McpValueRefMapEditor = React.memo(function McpValueRefMapEditor(props: Readonly<{
    kind: ValueRefKind;
    title: string;
    iconName: React.ComponentProps<typeof Ionicons>['name'];
    entries: Record<string, McpValueRefV1>;
    secrets: SavedSecret[];
    onChangeSecrets: (next: SavedSecret[]) => void;
    onChangeEntries: (next: Record<string, McpValueRefV1>) => void;
    addRowTitle: string;
    addRowSubtitle?: string;
    emptyTitle: string;
    emptySubtitle: string;
    testIdPrefix: string;
}>) {
    const { theme } = useUnistyles();

    const rows = React.useMemo(() => {
        return Object.entries(props.entries)
            .map(([key, valueRef]) => ({ key, valueRef }))
            .sort((a, b) => a.key.localeCompare(b.key));
    }, [props.entries]);

    const openEditor = React.useCallback((params: Readonly<{
        mode: 'add' | 'edit';
        initialKey: string;
        initialValueRef: McpValueRefV1;
        onDelete?: (() => void) | null;
        onSubmit: (result: Readonly<{ key: string; valueRef: McpValueRefV1 }>) => boolean;
    }>) => {
        Modal.show({
            component: ValueRefEditorModal,
            props: {
                kind: props.kind,
                initialKey: params.initialKey,
                initialValueRef: params.initialValueRef,
                secrets: props.secrets,
                onChangeSecrets: props.onChangeSecrets,
                onDelete: params.onDelete ?? null,
                onSubmit: params.onSubmit,
            },
            chrome: {
                kind: 'card',
                title: getValueRefEditorModalTitle(props.kind),
                dimensions: { size: 'lg' },
            },
            closeOnBackdrop: true,
        });
    }, [props.kind, props.onChangeSecrets, props.secrets]);

    const handleAdd = React.useCallback(() => {
        openEditor({
            mode: 'add',
            initialKey: '',
            initialValueRef: { t: 'literal', v: '' },
            onSubmit: ({ key, valueRef }) => {
                if (props.entries[key]) {
                    Modal.alert(t('common.error'), t('settings.mcpServersKeyAlreadyExists'));
                    return false;
                }
                props.onChangeEntries({ ...props.entries, [key]: valueRef });
                return true;
            },
        });
    }, [openEditor, props.entries, props.onChangeEntries]);

    return (
        <>
            <ItemGroup title={props.title}>
                {rows.length === 0 ? (
                    <Item
                        testID={`${props.testIdPrefix}.empty`}
                        title={props.emptyTitle}
                        subtitle={props.emptySubtitle}
                        icon={<Ionicons name={props.iconName} size={29} color={theme.colors.text.secondary} />}
                        showChevron={false}
                    />
                ) : null}

                {rows.map(({ key, valueRef }, idx) => (
                    <Item
                        key={key}
                        testID={`${props.testIdPrefix}.row.${idx}`}
                        title={key}
                        subtitle={describeValueRef(valueRef, props.secrets)}
                        icon={<Ionicons name={props.iconName} size={29} color={theme.colors.accent.purple} />}
                        onPress={() => {
                            openEditor({
                                mode: 'edit',
                                initialKey: key,
                                initialValueRef: valueRef,
                                onDelete: () => {
                                    const { [key]: _removed, ...rest } = props.entries;
                                    props.onChangeEntries(rest);
                                },
                                onSubmit: ({ key: nextKey, valueRef: nextValueRef }) => {
                                    if (nextKey !== key && props.entries[nextKey]) {
                                        Modal.alert(t('common.error'), t('settings.mcpServersKeyAlreadyExists'));
                                        return false;
                                    }
                                    const next: Record<string, McpValueRefV1> = { ...props.entries };
                                    delete next[key];
                                    next[nextKey] = nextValueRef;
                                    props.onChangeEntries(next);
                                    return true;
                                },
                            });
                        }}
                        showDivider={idx < rows.length - 1}
                    />
                ))}
            </ItemGroup>

            <ItemGroup>
                <Item
                    testID={`${props.testIdPrefix}.add`}
                    title={props.addRowTitle}
                    subtitle={props.addRowSubtitle}
                    icon={<Ionicons name="add-circle-outline" size={29} color={theme.colors.state.success.foreground} />}
                    onPress={handleAdd}
                />
            </ItemGroup>
        </>
    );
});
