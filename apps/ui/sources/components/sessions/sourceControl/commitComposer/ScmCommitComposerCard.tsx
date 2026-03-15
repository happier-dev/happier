import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';

export type ScmCommitComposerCardProps = Readonly<{
    theme: any;
    commitActionLabel: string;
    draftMessage: string;
    onDraftMessageChange: (value: string) => void;
    busy: boolean;
    status: string | null;
    commitAllowed: boolean;
    commitBlockedMessage: string | null;
    onCommitFromMessage: (message: string) => void;
    selectionCount?: number;
    onClearSelection?: () => void;
    onSelectAllSelection?: () => void;
    variant?: 'card' | 'railFooter';
    commitMessageGeneratorEnabled?: boolean;
    onGenerateCommitMessageSuggestion?: () => Promise<
        | { ok: true; message: string }
        | { ok: false; error: string }
    >;
}>;

export const ScmCommitComposerCard = React.memo((props: ScmCommitComposerCardProps) => {
    const trimmedMessage = String(props.draftMessage ?? '').trim();
    const commitDisabled = props.busy || !props.commitAllowed || trimmedMessage.length === 0;
    const variant = props.variant ?? 'card';
    const generatorEnabled = props.commitMessageGeneratorEnabled === true && typeof props.onGenerateCommitMessageSuggestion === 'function';
    const [generating, setGenerating] = React.useState(false);

    const onGenerate = React.useCallback(async () => {
        if (!generatorEnabled || !props.onGenerateCommitMessageSuggestion) return;
        if (props.busy || generating) return;
        setGenerating(true);
        try {
            const res = await props.onGenerateCommitMessageSuggestion();
            if (res.ok) {
                props.onDraftMessageChange(res.message);
            } else {
                Modal.alert(t('common.error'), res.error);
            }
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : String(error));
        } finally {
            setGenerating(false);
        }
    }, [generatorEnabled, generating, props]);

    return (
        <View
            style={{
                ...(variant === 'card'
                    ? {
                        marginHorizontal: 12,
                        marginTop: 12,
                        marginBottom: 12,
                        padding: 12,
                        borderRadius: 14,
                        borderWidth: 1,
                        borderColor: props.theme.colors.divider,
                    }
                    : {
                        paddingHorizontal: 12,
                        paddingTop: 10,
                        paddingBottom: 12,
                    }),
                backgroundColor: variant === 'card' ? props.theme.colors.surface : 'transparent',
            }}
        >
            {typeof props.selectionCount === 'number' ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <Text style={{ fontSize: 12, color: props.theme.colors.textSecondary, ...Typography.default('semiBold') }}>
                        {t('files.sourceControlOperations.selection', { count: props.selectionCount })}
                    </Text>
                    {(props.onSelectAllSelection || (props.selectionCount > 0 && props.onClearSelection)) ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            {props.onSelectAllSelection ? (
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel={t('common.all')}
                                    onPress={props.onSelectAllSelection}
                                    style={({ pressed }) => ({
                                        paddingHorizontal: 8,
                                        paddingVertical: 4,
                                        borderRadius: 999,
                                        borderWidth: 1,
                                        borderColor: props.theme.colors.divider,
                                        backgroundColor: props.theme.colors.surfaceHigh ?? props.theme.colors.surface,
                                        opacity: pressed ? 0.75 : 1,
                                    })}
                                >
                                    <Text style={{ fontSize: 11, color: props.theme.colors.textSecondary, ...Typography.default('semiBold') }}>
                                        {t('common.all')}
                                    </Text>
                                </Pressable>
                            ) : null}

                            {(props.selectionCount > 0 && props.onClearSelection) ? (
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel={t('files.fileActions.clearSelection')}
                                    onPress={props.onClearSelection}
                                    style={({ pressed }) => ({
                                        paddingHorizontal: 8,
                                        paddingVertical: 4,
                                        borderRadius: 999,
                                        borderWidth: 1,
                                        borderColor: props.theme.colors.divider,
                                        backgroundColor: props.theme.colors.surfaceHigh ?? props.theme.colors.surface,
                                        opacity: pressed ? 0.75 : 1,
                                    })}
                                >
                                    <Text style={{ fontSize: 11, color: props.theme.colors.textSecondary, ...Typography.default('semiBold') }}>
                                        {t('files.sourceControlOperations.clear')}
                                    </Text>
                                </Pressable>
                            ) : null}
                        </View>
                    ) : null}
                </View>
            ) : null}
            {props.status ? (
                <Text style={{ marginBottom: 8, fontSize: 11, color: props.theme.colors.textSecondary, ...Typography.default() }}>
                    {props.status}
                </Text>
            ) : null}
            <View
                style={{
                    borderRadius: 12,
                    borderWidth: variant === 'card' ? 1 : 0,
                    borderColor: props.theme.colors.divider,
                    backgroundColor:
                        variant === 'card'
                            ? (props.theme.colors.surfaceHigh ?? props.theme.colors.surface)
                            : 'transparent',
                    paddingHorizontal: 10,
                    paddingVertical: Platform.OS === 'web' ? 10 : 8,
                }}
            >
                <TextInput
                    testID="scm-commit-message"
                    value={props.draftMessage}
                    onChangeText={props.onDraftMessageChange}
                    editable={!props.busy}
                    multiline
                    placeholder={t('files.commitMessageEditor.placeholder')}
                    placeholderTextColor={props.theme.colors.textSecondary}
                    style={{
                        fontSize: 13,
                        color: props.theme.colors.text,
                        minHeight: 44,
                        maxHeight: 96,
                        padding: 0,
                        textAlignVertical: 'top' as any,
                        ...(Platform.select({ web: { outlineStyle: 'none' as any } }) as any),
                    }}
                />
            </View>

            {!props.commitAllowed && props.commitBlockedMessage ? (
                <Text style={{ marginTop: 8, fontSize: 11, color: props.theme.colors.textSecondary, ...Typography.default() }}>
                    {props.commitBlockedMessage}
                </Text>
            ) : null}

            <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                {generatorEnabled ? (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('files.commitMessageEditor.generate')}
                        disabled={props.busy || generating}
                        onPress={onGenerate}
                        style={({ pressed }) => ({
                            width: 38,
                            height: 38,
                            borderRadius: 12,
                            borderWidth: 1,
                            borderColor: props.theme.colors.divider,
                            backgroundColor: props.theme.colors.surfaceHigh ?? props.theme.colors.surface,
                            alignItems: 'center',
                            justifyContent: 'center',
                            opacity: props.busy || generating ? 0.5 : pressed ? 0.85 : 1,
                        })}
                    >
                        {generating ? (
                            <ActivityIndicator color={props.theme.colors.textSecondary} />
                        ) : (
                            <Ionicons
                                name="sparkles-outline"
                                size={16}
                                color={props.theme.colors.textSecondary}
                            />
                        )}
                    </Pressable>
                ) : null}
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={props.commitActionLabel}
                    disabled={commitDisabled}
                    onPress={() => props.onCommitFromMessage(trimmedMessage)}
                    testID="scm-commit-submit"
                    style={({ pressed }) => ({
                        flex: 1,
                        height: 38,
                        borderRadius: 12,
                        borderWidth: 1,
                        borderColor: commitDisabled ? props.theme.colors.divider : props.theme.colors.success,
                        backgroundColor: commitDisabled ? (props.theme.colors.surfaceHigh ?? props.theme.colors.surface) : props.theme.colors.success,
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: commitDisabled ? 0.55 : pressed ? 0.85 : 1,
                    })}
                >
                    <Text style={{ fontSize: 12, color: commitDisabled ? props.theme.colors.textSecondary : 'white', ...Typography.default('semiBold') }}>
                        {props.commitActionLabel}
                    </Text>
                </Pressable>
            </View>
        </View>
    );
});
