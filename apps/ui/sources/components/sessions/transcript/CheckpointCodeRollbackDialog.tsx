import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { Typography } from '@/constants/Typography';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import {
    requiresCheckpointCodeRollbackAdvancedConfirmation,
    resolveCheckpointCodeRollbackChoices,
} from '@/sync/domains/sessionRollback/checkpointCodeRollback';
import { t, type TranslationKeyNoParams } from '@/text';
import type { CheckpointCodeRollbackBackupMode, SessionRollbackCodeMode } from '@happier-dev/protocol';

export type CheckpointCodeRollbackDialogConfirmValue = Readonly<{
    mode: SessionRollbackCodeMode;
    backupMode: CheckpointCodeRollbackBackupMode;
    codeOnlyTranscriptDivergenceConfirmed?: true;
}>;

export type CheckpointCodeRollbackDialogProps = Readonly<{
    visible?: boolean;
    conversationRollbackSupported: boolean;
    onCancel?: () => void;
    onConfirm: (value: CheckpointCodeRollbackDialogConfirmValue) => void;
}> & Partial<CustomModalInjectedProps>;

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        gap: 12,
        padding: 16,
    },
    title: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 15,
    },
    choice: {
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        borderRadius: 12,
        paddingVertical: 10,
        paddingHorizontal: 12,
        backgroundColor: theme.colors.surface.inset,
    },
    choiceSelected: {
        borderColor: theme.colors.text.link,
    },
    choiceDisabled: {
        opacity: 0.45,
    },
    choiceText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 13,
    },
    hint: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 10,
    },
    footerButton: {
        borderRadius: 10,
        paddingVertical: 9,
        paddingHorizontal: 12,
    },
    confirmButton: {
        backgroundColor: theme.colors.surface.inset,
    },
    confirmDisabled: {
        opacity: 0.45,
    },
    footerText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.link,
        fontSize: 13,
    },
    advancedButton: {
        alignSelf: 'flex-start',
        borderRadius: 10,
        paddingVertical: 8,
    },
}));

const CHOICE_TITLE_KEYS = {
    conversation_only: 'session.rollback.checkpointCode.choices.conversation_only.title',
    conversation_and_code_with_stash: 'session.rollback.checkpointCode.choices.conversation_and_code_with_stash.title',
    conversation_and_code_without_stash: 'session.rollback.checkpointCode.choices.conversation_and_code_without_stash.title',
    code_only_with_stash: 'session.rollback.checkpointCode.choices.code_only_with_stash.title',
    code_only_without_stash: 'session.rollback.checkpointCode.choices.code_only_without_stash.title',
} as const satisfies Record<SessionRollbackCodeMode, TranslationKeyNoParams>;

const CHOICE_DESCRIPTION_KEYS = {
    conversation_only: 'session.rollback.checkpointCode.choices.conversation_only.description',
    conversation_and_code_with_stash: 'session.rollback.checkpointCode.choices.conversation_and_code_with_stash.description',
    conversation_and_code_without_stash: 'session.rollback.checkpointCode.choices.conversation_and_code_without_stash.description',
    code_only_with_stash: 'session.rollback.checkpointCode.choices.code_only_with_stash.description',
    code_only_without_stash: 'session.rollback.checkpointCode.choices.code_only_without_stash.description',
} as const satisfies Record<SessionRollbackCodeMode, TranslationKeyNoParams>;

function choiceTitle(mode: SessionRollbackCodeMode): string {
    return t(CHOICE_TITLE_KEYS[mode]);
}

function choiceDescription(mode: SessionRollbackCodeMode): string {
    return t(CHOICE_DESCRIPTION_KEYS[mode]);
}

export function CheckpointCodeRollbackDialog(props: CheckpointCodeRollbackDialogProps) {
    const styles = stylesheet;
    const minimumInteractiveTargetSize = resolveMinimumInteractiveTargetSize(Platform.OS);
    const choices = React.useMemo(
        () => resolveCheckpointCodeRollbackChoices({
            conversationRollbackSupported: props.conversationRollbackSupported,
        }),
        [props.conversationRollbackSupported],
    );
    const firstEnabledChoice = choices.find((candidate) => candidate.enabled);
    const [selectedMode, setSelectedMode] = React.useState<SessionRollbackCodeMode | null>(
        firstEnabledChoice?.mode ?? null,
    );
    const [codeOnlyConfirmed, setCodeOnlyConfirmed] = React.useState(false);
    const [showAdvancedChoices, setShowAdvancedChoices] = React.useState(false);

    if (props.visible === false) return null;

    const visibleChoices = choices.filter((candidate) => candidate.primary || showAdvancedChoices);
    const selectedChoice = visibleChoices.find((candidate) => candidate.mode === selectedMode && candidate.enabled) ?? null;
    const requiresAdvancedConfirmation = selectedChoice
        ? requiresCheckpointCodeRollbackAdvancedConfirmation(selectedChoice.mode)
        : false;
    const confirmDisabled = !selectedChoice || (requiresAdvancedConfirmation && !codeOnlyConfirmed);
    const hasHiddenAdvancedChoices = choices.some((candidate) => !candidate.primary) && !showAdvancedChoices;
    const handleCancel = props.onCancel ?? props.onClose ?? (() => undefined);

    return (
        <View testID="checkpoint-code-rollback-dialog" style={styles.body}>
            <Text style={styles.title}>{t('session.rollback.checkpointCode.title')}</Text>
            {visibleChoices.map((rollbackChoice) => (
                <Pressable
                    key={rollbackChoice.mode}
                    testID={`checkpoint-rollback-choice:${rollbackChoice.mode}`}
                    disabled={!rollbackChoice.enabled}
                    accessibilityRole="button"
                    accessibilityState={{
                        disabled: !rollbackChoice.enabled,
                        selected: selectedMode === rollbackChoice.mode,
                    }}
                    onPress={() => {
                        setSelectedMode(rollbackChoice.mode);
                        setCodeOnlyConfirmed(false);
                    }}
                    style={[
                        styles.choice,
                        { minHeight: minimumInteractiveTargetSize },
                        selectedMode === rollbackChoice.mode ? styles.choiceSelected : null,
                        !rollbackChoice.enabled ? styles.choiceDisabled : null,
                    ]}
                >
                    <Text style={styles.choiceText}>{choiceTitle(rollbackChoice.mode)}</Text>
                    <Text style={styles.hint}>
                        {rollbackChoice.enabled
                            ? choiceDescription(rollbackChoice.mode)
                            : t('session.rollback.checkpointCode.conversationUnavailable')}
                    </Text>
                </Pressable>
            ))}

            {hasHiddenAdvancedChoices ? (
                <Pressable
                    testID="checkpoint-rollback-show-advanced"
                    accessibilityRole="button"
                    onPress={() => {
                        setShowAdvancedChoices(true);
                        if (selectedMode && !choices.find((candidate) => candidate.mode === selectedMode && candidate.primary)) {
                            setSelectedMode(null);
                        }
                    }}
                    style={[styles.advancedButton, { minHeight: minimumInteractiveTargetSize }]}
                >
                    <Text style={styles.footerText}>{t('session.rollback.checkpointCode.showAdvanced')}</Text>
                </Pressable>
            ) : null}

            {requiresAdvancedConfirmation ? (
                <Pressable
                    testID="checkpoint-rollback-code-only-confirmation"
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: codeOnlyConfirmed }}
                    onPress={() => setCodeOnlyConfirmed((value) => !value)}
                    style={{ minHeight: minimumInteractiveTargetSize, justifyContent: 'center' }}
                >
                    <Text style={styles.hint}>{t('session.rollback.checkpointCode.codeOnlyConfirmation')}</Text>
                </Pressable>
            ) : null}

            <View style={styles.footer}>
                <Pressable
                    testID="checkpoint-rollback-cancel"
                    accessibilityRole="button"
                    onPress={handleCancel}
                    style={[styles.footerButton, { minHeight: minimumInteractiveTargetSize }]}
                >
                    <Text style={styles.footerText}>{t('common.cancel')}</Text>
                </Pressable>
                <Pressable
                    testID="checkpoint-rollback-confirm"
                    disabled={confirmDisabled}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: confirmDisabled }}
                    onPress={() => {
                        if (!selectedChoice || confirmDisabled) return;
                        props.onConfirm({
                            mode: selectedChoice.mode,
                            backupMode: selectedChoice.backupMode,
                            ...(requiresAdvancedConfirmation ? { codeOnlyTranscriptDivergenceConfirmed: true as const } : {}),
                        });
                    }}
                    style={[
                        styles.footerButton,
                        { minHeight: minimumInteractiveTargetSize },
                        styles.confirmButton,
                        confirmDisabled ? styles.confirmDisabled : null,
                    ]}
                >
                    <Text style={styles.footerText}>{t('common.continue')}</Text>
                </Pressable>
            </View>
        </View>
    );
}

export function showCheckpointCodeRollbackDialog(params: Readonly<{
    conversationRollbackSupported: boolean;
}>): Promise<CheckpointCodeRollbackDialogConfirmValue | null> {
    return new Promise((resolve) => {
        let resolved = false;
        let modalId = '';
        const finish = (value: CheckpointCodeRollbackDialogConfirmValue | null) => {
            if (resolved) return;
            resolved = true;
            if (modalId) {
                Modal.hide(modalId);
            }
            resolve(value);
        };

        modalId = Modal.show({
            component: CheckpointCodeRollbackDialog,
            props: {
                conversationRollbackSupported: params.conversationRollbackSupported,
                onCancel: () => finish(null),
                onConfirm: (value) => finish(value),
            },
            onRequestClose: () => finish(null),
        });
    });
}
