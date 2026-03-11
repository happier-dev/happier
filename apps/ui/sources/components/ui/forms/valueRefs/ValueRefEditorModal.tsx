import * as React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { McpValueRefV1 } from '@happier-dev/protocol';

import type { CustomModalInjectedProps } from '@/modal';
import { Modal } from '@/modal';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { SETTINGS_TEXT_INPUT_METRICS } from '@/components/ui/forms/settingsTextInputMetrics';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { SavedSecret } from '@/sync/domains/settings/savedSecretTypes';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';
import { Text, TextInput } from '@/components/ui/text/Text';

import { SavedSecretPickerModal } from './SavedSecretPickerModal';

type ValueRefKind = 'env' | 'header';
type ValueRefSource = 'literal' | 'savedSecret';

const ENV_KEY_REGEX = /^[A-Z_][A-Z0-9_]*$/;
const HEADER_KEY_REGEX = /^[A-Za-z0-9-]+$/;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        maxWidth: 720,
        maxHeight: 720,
        backgroundColor: theme.colors.groupped.background,
        borderRadius: 14,
        overflow: 'hidden',
    },
    header: {
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 8,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    headerText: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        color: theme.colors.text,
    },
    groupContent: {
        padding: 16,
        gap: 12,
    },
    fieldLabel: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.groupped.sectionTitle,
    },
    textInput: {
        ...Typography.default('regular'),
        backgroundColor: theme.colors.input.background,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 10,
        ...SETTINGS_TEXT_INPUT_METRICS,
        color: theme.colors.input.text,
        borderWidth: 0.5,
        borderColor: theme.colors.divider,
    },
}));

function normalizeKey(kind: ValueRefKind, raw: string): string {
    const trimmed = raw.trim();
    if (kind === 'env') return trimmed.toUpperCase();
    return trimmed;
}

function validateKey(kind: ValueRefKind, key: string): boolean {
    if (!key) return false;
    if (kind === 'env') return ENV_KEY_REGEX.test(key);
    return HEADER_KEY_REGEX.test(key);
}

function titleForKind(kind: ValueRefKind): string {
    if (kind === 'env') return t('settings.mcpServersEnvEditorTitle');
    return t('settings.mcpServersHeadersEditorTitle');
}

export type ValueRefEditorModalProps = CustomModalInjectedProps & Readonly<{
    kind: ValueRefKind;
    initialKey: string;
    initialValueRef: McpValueRefV1;
    secrets: SavedSecret[];
    onChangeSecrets: (next: SavedSecret[]) => void;
    onSubmit: (result: Readonly<{ key: string; valueRef: McpValueRefV1 }>) => boolean;
    onDelete?: (() => void) | null;
}>;

export function ValueRefEditorModal(props: ValueRefEditorModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [liveSecrets, setLiveSecrets] = useSettingMutable('secrets');

    const initialSource: ValueRefSource = props.initialValueRef.t === 'savedSecret' ? 'savedSecret' : 'literal';

    const [keyText, setKeyText] = React.useState(() => props.initialKey);
    const [source, setSource] = React.useState<ValueRefSource>(initialSource);
    const [sourceMenuOpen, setSourceMenuOpen] = React.useState(false);
    const [literalValue, setLiteralValue] = React.useState(() => (props.initialValueRef.t === 'literal' ? props.initialValueRef.v : ''));
    const [secretId, setSecretId] = React.useState(() => (props.initialValueRef.t === 'savedSecret' ? props.initialValueRef.secretId : null));

    const normalizedKey = React.useMemo(() => normalizeKey(props.kind, keyText), [keyText, props.kind]);
    const keyValid = React.useMemo(() => validateKey(props.kind, normalizedKey), [normalizedKey, props.kind]);

    const secretName = React.useMemo(() => {
        if (!secretId) return null;
        const found = liveSecrets.find((s) => s.id === secretId);
        return found?.name ?? null;
    }, [liveSecrets, secretId]);

    const sourceItems = React.useMemo((): DropdownMenuItem[] => {
        return [
            {
                id: 'literal',
                title: t('settings.mcpServersValueSourceLiteral'),
                subtitle: t('settings.mcpServersValueSourceLiteralSubtitle'),
                icon: <Ionicons name="text-outline" size={22} color={theme.colors.textSecondary} />,
            },
            {
                id: 'savedSecret',
                title: t('settings.mcpServersValueSourceSavedSecret'),
                subtitle: t('settings.mcpServersValueSourceSavedSecretSubtitle'),
                icon: <Ionicons name="key-outline" size={22} color={theme.colors.textSecondary} />,
            },
        ];
    }, [theme.colors.textSecondary]);

    const canSave = keyValid && (source === 'literal' || Boolean(secretId));

    const pickSecret = React.useCallback(() => {
        Modal.show({
            component: SavedSecretPickerModal,
            props: {
                secrets: liveSecrets,
                onChangeSecrets: setLiveSecrets,
                selectedId: secretId,
                onSelectId: (id) => setSecretId(id),
            },
            closeOnBackdrop: true,
        });
    }, [liveSecrets, secretId, setLiveSecrets]);

    const onSave = React.useCallback(() => {
        if (!keyValid) {
            Modal.alert(t('common.error'), t('settings.mcpServersKeyInvalid'));
            return;
        }

        const valueRef: McpValueRefV1 = source === 'literal'
            ? { t: 'literal', v: literalValue }
            : { t: 'savedSecret', secretId: secretId ?? '' };

        const accepted = props.onSubmit({ key: normalizedKey, valueRef });
        if (accepted !== false) {
            props.onClose();
        }
    }, [keyValid, literalValue, normalizedKey, props, secretId, source]);

    const deleteAllowed = typeof props.onDelete === 'function';

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.headerText}>{titleForKind(props.kind)}</Text>
                <Pressable
                    onPress={props.onClose}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
                >
                    <Ionicons
                        name="close"
                        size={22}
                        color={theme.colors.textSecondary}
                    />
                </Pressable>
            </View>

            <ItemList keyboardShouldPersistTaps="handled">
                <ItemGroup>
                    <View style={styles.groupContent}>
                        <Text style={styles.fieldLabel}>{props.kind === 'env' ? t('settings.mcpServersEnvKeyLabel') : t('settings.mcpServersHeaderKeyLabel')}</Text>
                        <TextInput
                            style={styles.textInput}
                            value={keyText}
                            autoCapitalize="none"
                            autoCorrect={false}
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
                            onSelect={(id) => {
                                const next = id as ValueRefSource;
                                setSource(next);
                                if (next === 'literal') return;
                                if (!secretId) {
                                    pickSecret();
                                }
                            }}
                            itemTrigger={{
                                title: t('settings.mcpServersValueSourceTitle'),
                                subtitle: source === 'literal' ? t('settings.mcpServersValueSourceLiteral') : t('settings.mcpServersValueSourceSavedSecret'),
                                icon: <Ionicons name="swap-horizontal-outline" size={29} color={theme.colors.accent.purple} />,
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
                                    icon={<Ionicons name="key-outline" size={29} color={theme.colors.accent.indigo} />}
                                    onPress={pickSecret}
                                />
                            </>
                        )}
                    </View>
                </ItemGroup>

                <ItemGroup title={t('common.actions')}>
                    <Item
                        testID="mcp.valueRefEditor.save"
                        title={t('common.save')}
                        icon={<Ionicons name="save-outline" size={29} color={theme.colors.success} />}
                        onPress={onSave}
                        disabled={!canSave}
                    />

                    {deleteAllowed ? (
                        <Item
                            testID="mcp.valueRefEditor.delete"
                            title={t('common.delete')}
                            icon={<Ionicons name="trash-outline" size={29} color={theme.colors.textDestructive} />}
                            onPress={() => {
                                props.onDelete?.();
                                props.onClose();
                            }}
                            destructive
                        />
                    ) : null}
                </ItemGroup>
            </ItemList>
        </View>
    );
}
