import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';

export type DirectSessionTakeoverDialogAction = 'direct' | 'persisted';

export type DirectSessionTakeoverDialogResult = Readonly<{
    action: DirectSessionTakeoverDialogAction | null;
    forceStop: boolean;
}>;

type DirectSessionTakeoverDialogProps = Readonly<{
    canTakeOverDirect: boolean;
    canTakeOverPersist: boolean;
    canForceStop: boolean;
    onResolve: (result: DirectSessionTakeoverDialogResult) => void;
    onClose: () => void;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        width: '100%',
        maxWidth: 560,
        backgroundColor: theme.colors.surface,
        borderRadius: 16,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    header: {
        paddingHorizontal: 18,
        paddingTop: 18,
        paddingBottom: 14,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    title: {
        ...Typography.default('semiBold'),
        fontSize: 17,
        color: theme.colors.text,
    },
    subtitle: {
        marginTop: 8,
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 19,
        color: theme.colors.textSecondary,
    },
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
    }, [props]);

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>{t('chatFooter.directTakeoverDialogTitle')}</Text>
                <Text style={styles.subtitle}>{t('chatFooter.directTakeoverDialogBody')}</Text>
            </View>
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
        </View>
    );
}

export async function showDirectSessionTakeoverDialog(params: Readonly<{
    canTakeOverDirect: boolean;
    canTakeOverPersist: boolean;
    canForceStop: boolean;
}>): Promise<DirectSessionTakeoverDialogResult> {
    return await new Promise<DirectSessionTakeoverDialogResult>((resolve) => {
        const onResolve = (result: DirectSessionTakeoverDialogResult) => resolve(result);

        type WrapperProps = Readonly<{
            onRequestClose?: () => void;
            onClose: () => void;
        }>;

        const Wrapper: React.FC<WrapperProps> = ({ onClose }) => (
            <DirectSessionTakeoverDialog
                canTakeOverDirect={params.canTakeOverDirect}
                canTakeOverPersist={params.canTakeOverPersist}
                canForceStop={params.canForceStop}
                onResolve={onResolve}
                onClose={onClose}
            />
        );

        Modal.show({
            component: Wrapper,
            props: {
                onRequestClose: () => onResolve({ action: null, forceStop: false }),
            },
            closeOnBackdrop: true,
        });
    });
}
