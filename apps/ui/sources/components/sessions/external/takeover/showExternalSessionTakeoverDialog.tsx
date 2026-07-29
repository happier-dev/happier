import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { createDeferredOnce } from '@/modal/async/createDeferredOnce';
import type { CustomModalInjectedProps } from '@/modal';
import { t } from '@/text';

export type ExternalSessionTakeoverDialogAction =
    | 'direct'
    | 'persisted'
    | 'recheck';

export type ExternalSessionTakeoverDialogResult = Readonly<{
    action: ExternalSessionTakeoverDialogAction | null;
    forceStop: boolean;
}>;

type ExternalSessionTakeoverDialogProps = CustomModalInjectedProps & Readonly<{
    canTakeOverDirect: boolean;
    canTakeOverPersist: boolean;
    canForceStop: boolean;
    runningProcessPid?: number | null;
    onResolve: (result: ExternalSessionTakeoverDialogResult) => void;
    onRequestClose?: () => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 12,
    },
    optionButton: {
        paddingVertical: 13,
        paddingHorizontal: 14,
        borderRadius: 12,
        backgroundColor: theme.colors.surface.inset,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    optionTitle: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text.primary,
    },
    optionSubtitle: {
        marginTop: 4,
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    forceStopCard: {
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 14,
        paddingVertical: 12,
        gap: 8,
    },
    forceStopHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    forceStopTitle: {
        flex: 1,
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text.primary,
    },
    forceStopBody: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    cancelButton: {
        alignSelf: 'flex-start',
        paddingVertical: 8,
        paddingHorizontal: 4,
    },
    cancelText: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text.link,
    },
}));

export function ExternalSessionTakeoverDialog(props: ExternalSessionTakeoverDialogProps) {
    useUnistyles();
    const styles = stylesheet;
    const [forceStop, setForceStop] = React.useState(false);
    const runningProcessActive = props.runningProcessPid !== undefined;

    const resolve = React.useCallback((result: ExternalSessionTakeoverDialogResult) => {
        props.onResolve(result);
        props.onClose();
    }, [props.onClose, props.onResolve]);

    return (
        <View style={styles.body}>
            {runningProcessActive ? (
                <View style={styles.forceStopCard}>
                    <Text style={styles.forceStopTitle}>
                        {t('chatFooter.externalSessionProcessRunning')}
                    </Text>
                    <Text style={styles.forceStopBody}>
                        {t('chatFooter.externalSessionTakeoverBlocked')}
                        {props.runningProcessPid === null
                            ? null
                            : ` ${t('runs.detail.pid', {
                                pid: props.runningProcessPid,
                            })}`}
                    </Text>
                </View>
            ) : null}

            {props.canTakeOverDirect ? (
                <Pressable
                    testID="direct-session-takeover-dialog-direct"
                    accessibilityRole="button"
                    accessibilityLabel={t('chatFooter.directTakeoverDialogDirectTitle')}
                    accessibilityHint={t('chatFooter.directTakeoverDialogDirectBody')}
                    onPress={() => resolve({ action: 'direct', forceStop: props.canForceStop ? forceStop : false })}
                    style={({ pressed }) => [styles.optionButton, { opacity: pressed ? 0.85 : 1 }]}
                >
                    <Text style={styles.optionTitle}>{t('chatFooter.directTakeoverDialogDirectTitle')}</Text>
                    <Text style={styles.optionSubtitle}>{t('chatFooter.directTakeoverDialogDirectBody')}</Text>
                </Pressable>
            ) : null}

            {props.canTakeOverPersist ? (
                <Pressable
                    testID="direct-session-takeover-dialog-persist"
                    accessibilityRole="button"
                    accessibilityLabel={t('chatFooter.directTakeoverDialogPersistTitle')}
                    accessibilityHint={t('chatFooter.directTakeoverDialogPersistBody')}
                    onPress={() => resolve({ action: 'persisted', forceStop: props.canForceStop ? forceStop : false })}
                    style={({ pressed }) => [styles.optionButton, { opacity: pressed ? 0.85 : 1 }]}
                >
                    <Text style={styles.optionTitle}>{t('chatFooter.directTakeoverDialogPersistTitle')}</Text>
                    <Text style={styles.optionSubtitle}>{t('chatFooter.directTakeoverDialogPersistBody')}</Text>
                </Pressable>
            ) : null}

            {props.canForceStop ? (
                <View style={styles.forceStopCard}>
                    <View style={styles.forceStopHeader}>
                        <Text style={styles.forceStopTitle}>{t('chatFooter.directTakeoverDialogForceStopTitle')}</Text>
                        <Switch
                            testID="direct-session-takeover-dialog-force-stop"
                            accessibilityRole="switch"
                            accessibilityLabel={t('chatFooter.directTakeoverDialogForceStopTitle')}
                            accessibilityHint={t('chatFooter.directTakeoverDialogForceStopBody')}
                            value={forceStop}
                            onValueChange={setForceStop}
                        />
                    </View>
                    <Text style={styles.forceStopBody}>{t('chatFooter.directTakeoverDialogForceStopBody')}</Text>
                </View>
            ) : null}

            {runningProcessActive ? (
                <Pressable
                    testID="direct-session-takeover-dialog-recheck"
                    accessibilityRole="button"
                    accessibilityLabel={t('chatFooter.externalSessionRecheck')}
                    accessibilityHint={t('chatFooter.externalSessionTakeoverBlocked')}
                    onPress={() => resolve({ action: 'recheck', forceStop: false })}
                    style={({ pressed }) => [
                        styles.optionButton,
                        { opacity: pressed ? 0.85 : 1 },
                    ]}
                >
                    <Text style={styles.optionTitle}>
                        {t('chatFooter.externalSessionRecheck')}
                    </Text>
                </Pressable>
            ) : null}

            <Pressable
                testID="direct-session-takeover-dialog-cancel"
                accessibilityRole="button"
                accessibilityLabel={t('common.cancel')}
                onPress={() => resolve({ action: null, forceStop: false })}
                style={({ pressed }) => [styles.cancelButton, { opacity: pressed ? 0.7 : 1 }]}
            >
                <Text style={styles.cancelText}>{t('common.cancel')}</Text>
            </Pressable>
        </View>
    );
}

export async function showExternalSessionTakeoverDialog(params: Readonly<{
    canTakeOverDirect: boolean;
    canTakeOverPersist: boolean;
    canForceStop: boolean;
    runningProcessPid?: number | null;
}>): Promise<ExternalSessionTakeoverDialogResult> {
    const deferred = createDeferredOnce<ExternalSessionTakeoverDialogResult>();
    Modal.show({
        component: ExternalSessionTakeoverDialog,
        props: {
            canTakeOverDirect: params.canTakeOverDirect,
            canTakeOverPersist: params.canTakeOverPersist,
            canForceStop: params.canForceStop,
            ...(params.runningProcessPid !== undefined
                ? { runningProcessPid: params.runningProcessPid }
                : {}),
            onResolve: deferred.resolve,
        },
        onRequestClose: () => deferred.resolve({ action: null, forceStop: false }),
        chrome: {
            kind: 'card',
            title: t('chatFooter.directTakeoverDialogTitle'),
            subtitle: t('chatFooter.directTakeoverDialogBody'),
            testID: 'direct-session-takeover-dialog',
            bodyScroll: 'auto',
            dimensions: { width: 560, maxHeightRatio: 0.85, size: 'md' },
        },
        closeOnBackdrop: true,
    });
    return await deferred.promise;
}
