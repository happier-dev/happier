import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { t } from '@/text';

export type SwitchBranchWithChangesDialogResolution = 'stash_on_current_branch' | 'bring_changes' | 'cancel';

export type SwitchBranchWithChangesDialogProps = Readonly<{
    currentBranch: string;
    targetBranch: string;
    onResolve: (resolution: SwitchBranchWithChangesDialogResolution) => void;
    onClose: () => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        maxWidth: 520,
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    header: {
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 16,
        color: theme.colors.text,
    },
    subtitle: {
        marginTop: 6,
        ...Typography.default(),
        fontSize: 13,
        color: theme.colors.textSecondary,
    },
    body: {
        paddingHorizontal: 16,
        paddingVertical: 12,
        gap: 10,
        backgroundColor: theme.colors.surface,
    },
    button: {
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    buttonTitle: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text,
    },
    buttonSubtitle: {
        marginTop: 4,
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.textSecondary,
    },
    cancelButton: {
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: 'transparent',
        backgroundColor: 'transparent',
    },
    cancelText: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.textLink,
    },
}));

export function SwitchBranchWithChangesDialog(props: SwitchBranchWithChangesDialogProps) {
    useUnistyles();
    const styles = stylesheet;

    const resolve = React.useCallback(
        (resolution: SwitchBranchWithChangesDialogResolution) => {
            props.onResolve(resolution);
            props.onClose();
        },
        [props],
    );

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>{t('files.branchSwitchDialog.title')}</Text>
                <Text style={styles.subtitle}>{t('files.branchSwitchDialog.body')}</Text>
            </View>
            <View style={styles.body}>
                <Pressable
                    testID="switch-branch-leave-changes"
                    onPress={() => resolve('stash_on_current_branch')}
                    style={({ pressed }) => [styles.button, { opacity: pressed ? 0.8 : 1 }]}
                >
                    <Text style={styles.buttonTitle}>
                        {t('files.branchSwitchDialog.leaveTitle', { branch: props.currentBranch })}
                    </Text>
                    <Text style={styles.buttonSubtitle}>{t('files.branchSwitchDialog.leaveSubtitle')}</Text>
                </Pressable>

                <Pressable
                    testID="switch-branch-bring-changes"
                    onPress={() => resolve('bring_changes')}
                    style={({ pressed }) => [styles.button, { opacity: pressed ? 0.8 : 1 }]}
                >
                    <Text style={styles.buttonTitle}>
                        {t('files.branchSwitchDialog.bringTitle', { branch: props.targetBranch })}
                    </Text>
                    <Text style={styles.buttonSubtitle}>{t('files.branchSwitchDialog.bringSubtitle')}</Text>
                </Pressable>

                <Pressable
                    testID="switch-branch-cancel"
                    onPress={() => resolve('cancel')}
                    style={({ pressed }) => [styles.cancelButton, { opacity: pressed ? 0.7 : 1 }]}
                >
                    <Text style={styles.cancelText}>{t('common.cancel')}</Text>
                </Pressable>
            </View>
        </View>
    );
}

export async function showSwitchBranchWithChangesDialog(params: Readonly<{
    currentBranch: string;
    targetBranch: string;
}>): Promise<SwitchBranchWithChangesDialogResolution> {
    return await new Promise<SwitchBranchWithChangesDialogResolution>((resolve) => {
        const onResolve = (resolution: SwitchBranchWithChangesDialogResolution) => resolve(resolution);

        type WrapperProps = Readonly<{
            onRequestClose?: () => void;
            onClose: () => void;
        }>;

        const Wrapper: React.FC<WrapperProps> = ({ onClose }) => (
            <SwitchBranchWithChangesDialog
                currentBranch={params.currentBranch}
                targetBranch={params.targetBranch}
                onResolve={onResolve}
                onClose={onClose}
            />
        );

        Modal.show({
            component: Wrapper,
            props: {
                onRequestClose: () => onResolve('cancel'),
            },
            closeOnBackdrop: true,
        });
    });
}
