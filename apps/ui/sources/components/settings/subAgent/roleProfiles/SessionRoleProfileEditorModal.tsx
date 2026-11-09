import * as React from 'react';
import { Platform, ScrollView, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1, isCustomSessionRoleId, type AssignableSessionRole } from '@happier-dev/protocol';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ThemeColorPicker } from '@/components/ui/forms/color/ThemeColorPicker';
import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';

import { resolveSessionRoleDisplayName } from '@/components/sessions/roles/sessionRoleLabels';

export type SessionRoleProfileEditorResult =
    | Readonly<{ kind: 'save'; instructions: string; name?: string; displayName?: string | null; color?: string }>
    | Readonly<{ kind: 'reset' }>
    | Readonly<{ kind: 'delete' }>;

export function SessionRoleProfileEditorModal(props: Readonly<{
    role: AssignableSessionRole | null;
    name?: string;
    displayName?: string | null;
    color?: string | null;
    instructions: string;
    isCustom: boolean;
    /** A first-class custom identity, as distinct from a customized built-in prompt. */
    customProfile?: boolean;
    onResolve: (value: SessionRoleProfileEditorResult | null) => void;
}> & CustomModalInjectedProps) {
    const { theme } = useUnistyles();
    const { role, isCustom, customProfile = false, onClose, onResolve } = props;
    const [name, setName] = React.useState(props.name ?? '');
    const [displayName, setDisplayName] = React.useState(props.displayName ?? '');
    const [instructions, setInstructions] = React.useState(props.instructions);
    const fallbackColor = theme.colors.accent.blue;
    const [color, setColor] = React.useState(props.color ?? fallbackColor);
    const [colorChanged, setColorChanged] = React.useState(false);
    const [colorValid, setColorValid] = React.useState(true);
    const customIdentity = customProfile || (role !== null && isCustomSessionRoleId(role));
    const canSave = instructions.trim().length > 0 && (!customIdentity || name.trim().length > 0) && colorValid;
    const builtInRole = role && !isCustomSessionRoleId(role) ? role : null;
    const canReset = !customIdentity && Boolean(builtInRole) && (
        isCustom
        || instructions.trim() !== DEFAULT_SESSION_ROLE_INSTRUCTIONS_V1[builtInRole!]
        || props.color != null
        || Boolean(props.displayName?.trim())
    );
    const roleLabel = customIdentity
        ? (name.trim() || t('sessionRole.profiles.newCustomRole'))
        : builtInRole ? resolveSessionRoleDisplayName({ role: builtInRole, displayName }) : t('sessionRole.profiles.newCustomRole');
    const displayNameChanged = displayName.trim() !== (props.displayName?.trim() ?? '');

    const resolveAndClose = React.useCallback((value: SessionRoleProfileEditorResult | null) => {
        onResolve(value);
        onClose();
    }, [onClose, onResolve]);

    const footer = React.useMemo(() => (
        <View style={{ paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
                <RoundButton size="normal" display="inverted" title={t('common.cancel')} onPress={() => resolveAndClose(null)} />
                {customIdentity && role ? (
                    <RoundButton size="normal" display="inverted" title={t('common.delete')} onPress={() => resolveAndClose({ kind: 'delete' })} />
                ) : (
                    <RoundButton
                        size="normal"
                        display="inverted"
                        title={t('sessionRole.profiles.resetToDefault')}
                        disabled={!canReset}
                        onPress={() => resolveAndClose({ kind: 'reset' })}
                    />
                )}
            </View>
            <RoundButton
                size="normal"
                title={t('common.save')}
                disabled={!canSave}
                onPress={() => resolveAndClose({
                    kind: 'save',
                    instructions,
                    ...(customIdentity ? { name: name.trim(), color } : {}),
                    ...(!customIdentity && displayNameChanged ? { displayName: displayName.trim() || null } : {}),
                    ...(!customIdentity && (colorChanged || props.color) ? { color } : {}),
                })}
            />
        </View>
    ), [canReset, canSave, color, colorChanged, customIdentity, displayName, displayNameChanged, instructions, name, props.color, resolveAndClose, role]);

    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: t('sessionRole.profiles.editorTitle', { role: roleLabel }),
        testID: 'session-role-profile-editor-modal',
        layout: 'fill' as const,
        dimensions: { width: 640, maxHeightRatio: 0.92, size: 'lg' as const },
        footer,
    }), [footer, roleLabel]);
    useModalCardChrome(props.setChrome, chrome);

    return (
        <ScrollView
            style={{ flex: 1 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            {...(Platform.OS === 'ios' ? { automaticallyAdjustKeyboardInsets: true } : {})}
            contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 14, paddingBottom: 18, gap: 8 }}
        >
            {customIdentity ? (
                <>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: theme.colors.text.secondary }}>
                        {t('sessionRole.profiles.nameLabel')}
                    </Text>
                    <TextInput
                        testID="session-role-profile-name"
                        accessibilityLabel={t('sessionRole.profiles.nameLabel')}
                        style={[{
                            borderWidth: 1,
                            borderColor: theme.colors.border.default,
                            borderRadius: 10,
                            paddingHorizontal: 12,
                            paddingVertical: Platform.select({ web: 10, ios: 8, default: 10 }),
                            color: theme.colors.text.primary,
                            backgroundColor: theme.colors.input.background,
                        }, Typography.default()]}
                        value={name}
                        onChangeText={setName}
                        autoFocus={true}
                    />
                </>
            ) : null}
            {!customIdentity ? (
                <>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: theme.colors.text.secondary }}>
                        {t('sessionRole.profiles.displayNameLabel')}
                    </Text>
                    <TextInput
                        testID="session-role-profile-display-name"
                        accessibilityLabel={t('sessionRole.profiles.displayNameLabel')}
                        style={[{
                            borderWidth: 1,
                            borderColor: theme.colors.border.default,
                            borderRadius: 10,
                            paddingHorizontal: 12,
                            paddingVertical: Platform.select({ web: 10, ios: 8, default: 10 }),
                            color: theme.colors.text.primary,
                            backgroundColor: theme.colors.input.background,
                        }, Typography.default()]}
                        value={displayName}
                        onChangeText={setDisplayName}
                        autoFocus={true}
                    />
                    <Text style={{ fontSize: 13, color: theme.colors.text.secondary }}>
                        {t('sessionRole.profiles.displayNameHint')}
                    </Text>
                </>
            ) : null}
            <Text style={{ fontSize: 13, fontWeight: '600', color: theme.colors.text.secondary }}>
                {t('sessionRole.profiles.instructionsLabel')}
            </Text>
            <TextInput
                testID="session-role-profile-instructions"
                accessibilityLabel={t('sessionRole.profiles.editorTitle', { role: roleLabel })}
                style={[{
                    borderWidth: 1,
                    borderColor: theme.colors.border.default,
                    borderRadius: 10,
                    paddingHorizontal: 12,
                    paddingVertical: Platform.select({ web: 10, ios: 8, default: 10 }),
                    color: theme.colors.text.primary,
                    backgroundColor: theme.colors.input.background,
                    minHeight: 160,
                    textAlignVertical: 'top',
                }, Typography.default()]}
                placeholderTextColor={theme.colors.input.placeholder}
                value={instructions}
                onChangeText={setInstructions}
                multiline={true}
                autoFocus={false}
            />
            <Text style={{ fontSize: 13, fontWeight: '600', color: theme.colors.text.secondary }}>
                {t('sessionRole.profiles.colorLabel')}
            </Text>
            <ThemeColorPicker
                value={color}
                onChange={(next) => { setColor(next); setColorChanged(true); }}
                onValidityChange={setColorValid}
                inputTestID="session-role-profile-color"
                previewTestID="session-role-profile-color-preview"
                pickerTestID="session-role-profile-color-picker"
                allowAlpha={false}
                inline={true}
            />
            <Text testID="session-role-profile-editor-hint" style={{ fontSize: 13, color: theme.colors.text.secondary }}>
                {t(customIdentity ? 'sessionRole.profiles.editorHintCustom' : 'sessionRole.profiles.editorHint')}
            </Text>
        </ScrollView>
    );
}
