import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import type { PopoverAnchor } from '@/components/ui/popover';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { ValueRefV1 } from '@happier-dev/protocol/valueRefs/valueRefV1';

import type { CustomModalInjectedProps } from '@/modal';
import { Modal } from '@/modal';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SETTINGS_TEXT_INPUT_METRICS } from '@/components/ui/forms/settingsTextInputMetrics';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { Text, TextInput } from '@/components/ui/text/Text';

import { presentConnectSheet } from '@/components/settings/connectedServices/setup/ConnectedServiceSetupModal';
import { Icon } from '@/components/ui/icons/Icon';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { useValueRefEditorDraft } from './useValueRefRowsEditor';

type ValueRefKind = 'env' | 'header';
type ValueRefSource = ValueRefV1['t'];

const stylesheet = StyleSheet.create((theme) => ({
    groupContent: {
        padding: theme.space.s16,
        gap: theme.space.s12,
    },
    fieldLabel: {

        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    textInput: {
        ...Typography.default('regular'),
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s10,
        ...SETTINGS_TEXT_INPUT_METRICS,
        color: theme.colors.input.text,
        borderWidth: 0.5,
        borderColor: theme.colors.border.default,
    },
    actions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: theme.space.s8,
        paddingHorizontal: theme.space.s16,
        paddingTop: theme.space.s8,
        paddingBottom: theme.space.s16,
    },
}));

export function getValueRefEditorModalTitle(kind: ValueRefKind): string {
    if (kind === 'env') return t('settings.mcpServersEnvEditorTitle');
    return t('settings.mcpServersHeadersEditorTitle');
}

export type ValueRefEditorModalProps = CustomModalInjectedProps & Readonly<{
    kind: ValueRefKind;
    initialKey: string;
    /** The name is declared elsewhere: shown, not edited. */
    lockKey?: boolean;
    initialValueRef: ValueRefV1;
    secrets: SavedSecret[];
    scope?: AccountSettingsScope | null;
    onSubmit: (result: Readonly<{ key: string; valueRef: ValueRefV1 }>) => boolean;
    onDelete?: (() => void) | null;
}>;

export function ValueRefEditorModal(props: ValueRefEditorModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const catalog = useSavedSecretCatalog(props.scope === undefined ? undefined : { scope: props.scope });

    const editor = useValueRefEditorDraft({ kind: props.kind, initial: { key: props.initialKey, valueRef: props.initialValueRef } });
    const keyText = editor.draft?.key ?? props.initialKey;
    const setKeyText = editor.setDraftKey;
    // The existing modal presents machine references in its text field until the row renderer migrates.
    const source: ValueRefSource = editor.draft?.source === 'machine' ? 'literal' : editor.draft?.source ?? props.initialValueRef.t;
    const setSource = editor.setDraftSource;
    const [sourceMenuOpen, setSourceMenuOpen] = React.useState(false);
    const literalValue = editor.draft?.literalValue ?? '';
    const setLiteralValue = React.useCallback((value: string) => {
        editor.setDraftSource('literal');
        editor.setDraftLiteralValue(value);
    }, [editor.setDraftSource, editor.setDraftLiteralValue]);
    const secretId = editor.draft?.secretId || null;
    const setSecretId = editor.setDraftSecretId;
    const { normalizedKey, keyValid } = editor;

    const secretName = React.useMemo(() => {
        if (!secretId) return null;
        return catalog.entries.find((entry) => entry.ref === secretId)?.name ?? null;
    }, [catalog.entries, secretId]);

    const sourceItems = React.useMemo((): DropdownMenuItem[] => {
        return [
            {
                id: 'literal',
                title: t('settings.mcpServersValueSourceLiteral'),
                subtitle: t('settings.mcpServersValueSourceLiteralSubtitle'),
                icon: <Icon name="text-aa" size={20} color={theme.colors.text.secondary} />,
            },
            {
                id: 'savedSecret',
                title: t('settings.mcpServersValueSourceSavedSecret'),
                subtitle: t('settings.mcpServersValueSourceSavedSecretSubtitle'),
                icon: <Icon name="key" size={20} color={theme.colors.text.secondary} />,
            },
        ];
    }, [theme.colors.text.secondary]);

    const canSave = editor.canSubmit;

    const pickSecret = React.useCallback((event?: unknown, anchor?: PopoverAnchor) => {
        void presentConnectSheet({
            service: { kind: 'key', suggestedName: normalizedKey || undefined },
            anchor: anchor ?? resolvePressTriggerAnchor(event),
            ...(props.scope === undefined ? {} : { scope: props.scope }),
            ...(secretId ? { current: secretId } : {}),
        }).then(result => {
            if (result.kind !== 'dismissed') setSecretId(result.secretRef);
        });
    }, [normalizedKey, props.scope, secretId, setSecretId]);

    const onSave = React.useCallback(() => {
        if (!keyValid) {
            Modal.alert(t('common.error'), t('settings.mcpServersKeyInvalid'));
            return;
        }

        if (!editor.canSubmit || !editor.valueRef) return;
        const accepted = props.onSubmit({ key: normalizedKey, valueRef: editor.valueRef });
        if (accepted !== false) {
            props.onClose();
        }
    }, [keyValid, normalizedKey, props, editor.canSubmit, editor.valueRef]);

    const deleteAllowed = typeof props.onDelete === 'function';

    return (
        <ItemList presentation="grouped" keyboardShouldPersistTaps="handled">
            <ItemGroup>
                <View style={styles.groupContent}>
                    <Text style={styles.fieldLabel}>{props.kind === 'env' ? t('settings.mcpServersEnvKeyLabel') : t('settings.mcpServersHeaderKeyLabel')}</Text>
                    <TextInput
                        style={styles.textInput}
                        value={keyText}
                        autoCapitalize="none"
                        autoCorrect={false}
                        editable={props.lockKey !== true}
                        onChangeText={setKeyText}
                        placeholder={props.kind === 'env' ? t('settings.mcpServersEnvKeyPlaceholder') : t('settings.mcpServersHeaderKeyPlaceholder')}
                        placeholderTextColor={theme.colors.input.placeholder}
                        testID="mcp.valueRefEditor.key"
                    />

                    <DropdownMenu
                        open={sourceMenuOpen}
                        onOpenChange={setSourceMenuOpen}
                        items={sourceItems}
                        selectedId={source}
                        onSelect={(id, selection) => {
                            if (id !== 'literal' && id !== 'savedSecret') return;
                            const next = id;
                            setSource(next);
                            if (next !== 'savedSecret') return;
                            if (!secretId) {
                                pickSecret(undefined, selection?.anchor);
                            }
                        }}
                        itemTrigger={{
                            title: t('settings.mcpServersValueSourceTitle'),
                            subtitle: source === 'literal' ? t('settings.mcpServersValueSourceLiteral') : t('settings.mcpServersValueSourceSavedSecret'),
                        }}
                        rowKind="item"
                        connectToTrigger
                        variant="default"
                    />
                </View>
            </ItemGroup>

            <ItemGroup>
                <View style={styles.groupContent}>
                    {source === 'literal' ? (
                        <>
                            <Text style={styles.fieldLabel}>{t('settings.mcpServersValueLiteralLabel')}</Text>
                            <TextInput
                                style={styles.textInput}
                                value={literalValue}
                                autoCapitalize="none"
                                autoCorrect={false}
                                multiline
                                onChangeText={setLiteralValue}
                                placeholder={t('settings.mcpServersValueLiteralPlaceholder')}
                                placeholderTextColor={theme.colors.input.placeholder}
                                testID="mcp.valueRefEditor.literal"
                            />
                        </>
                    ) : (
                        <>
                            <Text style={styles.fieldLabel}>{t('settings.mcpServersValueSecretLabel')}</Text>
                            <Item
                                testID="mcp.valueRefEditor.secret"
                                title={secretName ?? t('settings.mcpServersValueSecretSelect')}
                                subtitle={secretId ? secretId : t('settings.mcpServersValueSecretSelectSubtitle')}
                                icon={<Icon name="key" size={18} color={theme.colors.text.secondary} />}
                                onPress={pickSecret}
                                // Dismissing the picker never clears a key; this is the explicit way, on every width.
                                rightElement={secretId ? (
                                    <IconButton
                                        testID="mcp.valueRefEditor.secret.clear"
                                        iconName="x"
                                        variant="plain"
                                        size={18}
                                        accessibilityLabel={t('connectedServicesSettings.keyClear')}
                                        onPress={() => setSecretId(null)}
                                    />
                                ) : undefined}
                                rightElementOutsidePressable
                            />
                        </>
                    )}
                </View>
            </ItemGroup>

            <View style={styles.actions}>
                {deleteAllowed ? (
                    <RoundButton
                        testID="mcp.valueRefEditor.delete"
                        size="small"
                        display="quietDestructive"
                        title={t('common.delete')}
                        onPress={() => {
                            props.onDelete?.();
                            props.onClose();
                        }}
                    />
                ) : null}
                <RoundButton
                    testID="mcp.valueRefEditor.save"
                    size="small"
                    title={t('common.save')}
                    onPress={onSave}
                    disabled={!canSave}
                />
            </View>
        </ItemList>
    );
}
