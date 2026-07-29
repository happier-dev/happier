import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { Text, TextInput } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

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
    /**
     * When true, the composer surfaces a "Select files to commit" affordance instead of
     * showing a per-row "+" on every changed file. Tapping it enters selection mode
     * (which reveals the row toggles and this selection summary). Defaults off so the
     * changed-files rows stay uncluttered and legible at narrow widths.
     */
    commitSelectionAvailable?: boolean;
    selectionModeActive?: boolean;
    onEnterSelectionMode?: () => void;
    onExitSelectionMode?: () => void;
    variant?: 'card' | 'railFooter';
    commitMessageGeneratorEnabled?: boolean;
    onGenerateCommitMessageSuggestion?: () => Promise<
        | { ok: true; message: string }
        | { ok: false; error: string }
    >;
    pushShortcut?: Readonly<{
        label: string;
        disabled: boolean;
        busy: boolean;
        onPress: () => void;
    }> | null;
}>;

function unwrapMarkdownCodeFence(value: string): string {
    const trimmed = value.trim();
    const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
    return match?.[1]?.trim() ?? trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeGeneratedCommitMessageSuggestion(value: string): string {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return '';

    const unwrapped = unwrapMarkdownCodeFence(trimmed);
    try {
        const parsed: unknown = JSON.parse(unwrapped);
        if (!isRecord(parsed)) return unwrapped;

        const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
        if (message) return message;

        const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
        const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
        if (title && body) return `${title}\n\n${body}`;
        return title || body || unwrapped;
    } catch {
        return unwrapped;
    }
}

function selectionPillStyle(theme: any) {
    return ({ pressed }: { pressed: boolean }) => ({
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset ?? theme.colors.surface.base,
        opacity: pressed ? 0.75 : 1,
    });
}

export const ScmCommitComposerCard = React.memo((props: ScmCommitComposerCardProps) => {
    const trimmedMessage = String(props.draftMessage ?? '').trim();
    const commitDisabled = props.busy || !props.commitAllowed || trimmedMessage.length === 0;
    const variant = props.variant ?? 'card';
    const generatorEnabled = props.commitMessageGeneratorEnabled === true && typeof props.onGenerateCommitMessageSuggestion === 'function';
    const [generating, setGenerating] = React.useState(false);
    const commitButtonContentColor = commitDisabled
        ? props.theme.colors.text.secondary
        : props.theme.colors.button?.primary?.tint ?? props.theme.colors.surface.base;

    const onGenerate = React.useCallback(async () => {
        if (!generatorEnabled || !props.onGenerateCommitMessageSuggestion) return;
        if (props.busy || generating) return;
        setGenerating(true);
        try {
            const res = await props.onGenerateCommitMessageSuggestion();
            if (res.ok) {
                props.onDraftMessageChange(normalizeGeneratedCommitMessageSuggestion(res.message));
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
                        borderColor: props.theme.colors.border.default,
                    }
                    : {
                        paddingHorizontal: 12,
                        paddingTop: 10,
                        paddingBottom: 12,
                    }),
                backgroundColor: variant === 'card' ? props.theme.colors.surface.base : 'transparent',
            }}
        >
            {props.commitSelectionAvailable ? (
                props.selectionModeActive ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
                        <Text
                            testID="scm-commit-selection-summary"
                            style={{ flex: 1, fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default('semiBold') }}
                        >
                            {t('files.sourceControlOperations.selection', { count: props.selectionCount ?? 0 })}
                        </Text>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                            {props.onSelectAllSelection ? (
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel={t('common.all')}
                                    onPress={props.onSelectAllSelection}
                                    style={selectionPillStyle(props.theme)}
                                >
                                    <Text style={{ fontSize: 11, color: props.theme.colors.text.secondary, ...Typography.default('semiBold') }}>
                                        {t('common.all')}
                                    </Text>
                                </Pressable>
                            ) : null}

                            {((props.selectionCount ?? 0) > 0 && props.onClearSelection) ? (
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityLabel={t('files.fileActions.clearSelection')}
                                    onPress={props.onClearSelection}
                                    style={selectionPillStyle(props.theme)}
                                >
                                    <Text style={{ fontSize: 11, color: props.theme.colors.text.secondary, ...Typography.default('semiBold') }}>
                                        {t('files.sourceControlOperations.clear')}
                                    </Text>
                                </Pressable>
                            ) : null}

                            {((props.selectionCount ?? 0) === 0 && props.onExitSelectionMode) ? (
                                <Pressable
                                    testID="scm-commit-exit-selection"
                                    accessibilityRole="button"
                                    accessibilityLabel={t('common.done')}
                                    onPress={props.onExitSelectionMode}
                                    style={selectionPillStyle(props.theme)}
                                >
                                    <Text style={{ fontSize: 11, color: props.theme.colors.text.secondary, ...Typography.default('semiBold') }}>
                                        {t('common.done')}
                                    </Text>
                                </Pressable>
                            ) : null}
                        </View>
                    </View>
                ) : (
                    <Pressable
                        testID="scm-commit-enter-selection"
                        accessibilityRole="button"
                        accessibilityLabel={t('files.fileActions.selectFilesToCommit')}
                        onPress={props.onEnterSelectionMode}
                        style={({ pressed }) => ({
                            flexDirection: 'row',
                            alignItems: 'center',
                            alignSelf: 'flex-start',
                            gap: 6,
                            marginBottom: 10,
                            paddingHorizontal: 10,
                            paddingVertical: 6,
                            borderRadius: 999,
                            borderWidth: 1,
                            borderColor: props.theme.colors.border.default,
                            backgroundColor: props.theme.colors.surface.inset ?? props.theme.colors.surface.base,
                            opacity: pressed ? 0.78 : 1,
                        })}
                    >
                        <Ionicons name="checkmark-circle-outline" size={14} color={props.theme.colors.text.secondary} />
                        <Text style={{ fontSize: 12, color: props.theme.colors.text.secondary, ...Typography.default('semiBold') }}>
                            {t('files.fileActions.selectFilesToCommit')}
                        </Text>
                    </Pressable>
                )
            ) : null}
            {props.status && !props.busy ? (
                <Text style={{ marginBottom: 8, fontSize: 11, color: props.theme.colors.text.secondary, ...Typography.default() }}>
                    {props.status}
                </Text>
            ) : null}
            <View
                style={{
                    borderRadius: 12,
                    borderWidth: variant === 'card' ? 1 : 0,
                    borderColor: props.theme.colors.border.default,
                    backgroundColor:
                        variant === 'card'
                            ? (props.theme.colors.surface.inset ?? props.theme.colors.surface.base)
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
                    placeholderTextColor={props.theme.colors.text.secondary}
                    style={{
                        fontSize: 13,
                        color: props.theme.colors.text.primary,
                        minHeight: 44,
                        maxHeight: 96,
                        padding: 0,
                        textAlignVertical: 'top' as any,
                        ...(Platform.select({ web: { outlineStyle: 'none' as any } }) as any),
                    }}
                />
            </View>

            {!props.commitAllowed && props.commitBlockedMessage ? (
                <Text style={{ marginTop: 8, fontSize: 11, color: props.theme.colors.text.secondary, ...Typography.default() }}>
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
                            borderColor: props.theme.colors.border.default,
                            backgroundColor: props.theme.colors.surface.inset ?? props.theme.colors.surface.base,
                            alignItems: 'center',
                            justifyContent: 'center',
                            opacity: props.busy || generating ? 0.5 : pressed ? 0.85 : 1,
                        })}
                    >
                        {generating ? (
                            <ActivitySpinner color={props.theme.colors.text.secondary} />
                        ) : (
                            <Ionicons
                                name="sparkles-outline"
                                size={16}
                                color={props.theme.colors.text.secondary}
                            />
                        )}
                    </Pressable>
                ) : null}
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={props.commitActionLabel}
                    accessibilityState={{ busy: props.busy, disabled: commitDisabled }}
                    disabled={commitDisabled}
                    onPress={() => props.onCommitFromMessage(trimmedMessage)}
                    testID="scm-commit-submit"
                    style={({ pressed }) => ({
                        flex: 1,
                        height: 38,
                        borderRadius: 12,
                        borderWidth: 1,
                        borderColor: commitDisabled ? props.theme.colors.border.default : props.theme.colors.state.success.foreground,
                        backgroundColor: commitDisabled ? (props.theme.colors.surface.inset ?? props.theme.colors.surface.base) : props.theme.colors.state.success.foreground,
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: commitDisabled ? 0.55 : pressed ? 0.85 : 1,
                    })}
                >
                    {props.busy ? (
                        <ActivitySpinner color={commitButtonContentColor} />
                    ) : (
                        <Text style={{ fontSize: 12, color: commitButtonContentColor, ...Typography.default('semiBold') }}>
                            {props.commitActionLabel}
                        </Text>
                    )}
                </Pressable>
                {props.pushShortcut ? (
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={props.pushShortcut.label}
                        accessibilityState={{ busy: props.pushShortcut.busy, disabled: props.pushShortcut.disabled }}
                        disabled={props.pushShortcut.disabled}
                        onPress={props.pushShortcut.onPress}
                        testID="scm-commit-adjacent-push"
                        style={({ pressed }) => ({
                            width: 38,
                            height: 38,
                            borderRadius: 12,
                            borderWidth: 1,
                            borderColor: props.theme.colors.border.default,
                            backgroundColor: props.theme.colors.surface.inset ?? props.theme.colors.surface.base,
                            alignItems: 'center',
                            justifyContent: 'center',
                            opacity: props.pushShortcut?.disabled ? 0.5 : pressed ? 0.85 : 1,
                        })}
                    >
                        {props.pushShortcut.busy ? (
                            <ActivitySpinner color={props.theme.colors.text.secondary} />
                        ) : (
                            <Ionicons
                                name="arrow-up-circle-outline"
                                size={17}
                                color={props.theme.colors.text.secondary}
                            />
                        )}
                    </Pressable>
                ) : null}
            </View>
        </View>
    );
});
