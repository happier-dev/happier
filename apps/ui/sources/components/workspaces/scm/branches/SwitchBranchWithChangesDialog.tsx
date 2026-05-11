import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { Modal } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import type { CustomModalInjectedProps } from '@/modal';
import { t } from '@/text';

export type SwitchBranchWithChangesDialogResolution = 'stash_on_current_branch' | 'bring_changes' | 'cancel';

export type SwitchBranchWithChangesDialogProps = CustomModalInjectedProps & Readonly<{
    currentBranch: string;
    targetBranch: string;
    onResolve: (resolution: SwitchBranchWithChangesDialogResolution) => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        flex: 1,
        minHeight: 0,
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 12,
        gap: 10,
    },
    button: {
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderRadius: 12,
        backgroundColor: theme.colors.surface.inset,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    buttonTitle: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text.primary,
    },
    buttonSubtitle: {
        marginTop: 4,
        ...Typography.default(),
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    cancelButton: {
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 12,
    },
    cancelText: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text.link,
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
    );
}

export async function showSwitchBranchWithChangesDialog(params: Readonly<{
    currentBranch: string;
    targetBranch: string;
}>): Promise<SwitchBranchWithChangesDialogResolution> {
    const deferred = createDeferredOnce<SwitchBranchWithChangesDialogResolution>();
    Modal.show({
        component: SwitchBranchWithChangesDialog,
        props: {
            currentBranch: params.currentBranch,
            targetBranch: params.targetBranch,
            onResolve: deferred.resolve,
        },
        onRequestClose: () => deferred.resolve('cancel'),
        chrome: {
            kind: 'card',
            title: t('files.branchSwitchDialog.title'),
            subtitle: t('files.branchSwitchDialog.body'),
            testID: 'switch-branch-with-changes-dialog',
            bodyScroll: 'auto',
            dimensions: { width: 520, maxHeightRatio: 0.85, size: 'md' },
        },
        closeOnBackdrop: true,
    });
    return await deferred.promise;
}
