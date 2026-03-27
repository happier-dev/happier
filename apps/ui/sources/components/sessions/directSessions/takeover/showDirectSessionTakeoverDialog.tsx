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

export type DirectSessionTakeoverDialogAction = 'direct' | 'persisted';

export type DirectSessionTakeoverDialogResult = Readonly<{
    action: DirectSessionTakeoverDialogAction | null;
    forceStop: boolean;
}>;

type DirectSessionTakeoverDialogProps = CustomModalInjectedProps & Readonly<{
    canTakeOverDirect: boolean;
    canTakeOverPersist: boolean;
    canForceStop: boolean;
    onResolve: (result: DirectSessionTakeoverDialogResult) => void;
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
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    optionTitle: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.text,
    },
    optionSubtitle: {
        marginTop: 4,
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    forceStopCard: {
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
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
        color: theme.colors.text,
    },
    forceStopBody: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    cancelButton: {
        alignSelf: 'flex-start',
        paddingVertical: 8,
        paddingHorizontal: 4,
    },
    cancelText: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        color: theme.colors.textLink,
    },
}));

export function DirectSessionTakeoverDialog(props: DirectSessionTakeoverDialogProps) {
    useUnistyles();
    const styles = stylesheet;
    const [forceStop, setForceStop] = React.useState(false);

    const resolve = React.useCallback((result: DirectSessionTakeoverDialogResult) => {
        props.onResolve(result);
        props.onClose();
    }, [props.onClose, props.onResolve]);

    return (
        <View style={styles.body}>
            {props.canTakeOverDirect ? (
                <Pressable
                    testID="direct-session-takeover-dialog-direct"
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
                            value={forceStop}
                            onValueChange={setForceStop}
                        />
                    </View>
                    <Text style={styles.forceStopBody}>{t('chatFooter.directTakeoverDialogForceStopBody')}</Text>
                </View>
            ) : null}

            <Pressable
                testID="direct-session-takeover-dialog-cancel"
                onPress={() => resolve({ action: null, forceStop: false })}
                style={({ pressed }) => [styles.cancelButton, { opacity: pressed ? 0.7 : 1 }]}
            >
                <Text style={styles.cancelText}>{t('common.cancel')}</Text>
            </Pressable>
        </View>
    );
}

export async function showDirectSessionTakeoverDialog(params: Readonly<{
    canTakeOverDirect: boolean;
    canTakeOverPersist: boolean;
    canForceStop: boolean;
}>): Promise<DirectSessionTakeoverDialogResult> {
    const deferred = createDeferredOnce<DirectSessionTakeoverDialogResult>();
    Modal.show({
        component: DirectSessionTakeoverDialog,
        props: {
            canTakeOverDirect: params.canTakeOverDirect,
            canTakeOverPersist: params.canTakeOverPersist,
            canForceStop: params.canForceStop,
            onResolve: deferred.resolve,
        },
        onRequestClose: () => deferred.resolve({ action: null, forceStop: false }),
        chrome: {
            kind: 'card',
            title: t('chatFooter.directTakeoverDialogTitle'),
            subtitle: t('chatFooter.directTakeoverDialogBody'),
            testID: 'direct-session-takeover-dialog',
            dimensions: { width: 560, maxHeightRatio: 0.85, size: 'md' },
        },
        closeOnBackdrop: true,
    });
    return await deferred.promise;
}
