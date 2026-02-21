import React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';

import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Modal } from '@/modal';
import { formatSecretKeyForBackup } from '@/auth/recovery/secretKeyBackup';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';


const stylesheet = StyleSheet.create((theme) => ({
    modal: {
        width: 360,
        maxWidth: '92%',
        backgroundColor: theme.colors.surface,
        borderRadius: 14,
        padding: 16,
        borderWidth: 1,
        borderColor: theme.colors.divider,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 10,
    },
    title: {
        fontSize: 18,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    description: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        lineHeight: 20,
        marginBottom: 14,
        ...Typography.default(),
    },
    keyContainer: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        marginBottom: 12,
    },
    keyLabelRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 8,
    },
    keyLabel: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        letterSpacing: 0.5,
        textTransform: 'uppercase',
        ...Typography.default('semiBold'),
    },
    keyText: {
        fontSize: 13,
        letterSpacing: 0.5,
        lineHeight: 20,
        color: theme.colors.text,
        ...Typography.mono(),
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 4,
    },
    link: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));

export function SecretKeyBackupModal(props: { secret: string; onClose: () => void }) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const [revealed, setRevealed] = React.useState(false);

    const formattedSecret = React.useMemo(() => formatSecretKeyForBackup(props.secret), [props.secret]);
    const maskedSecret = React.useMemo(() => formattedSecret.replace(/[A-Za-z0-9]/g, '•'), [formattedSecret]);

    const handleCopy = React.useCallback(async () => {
        try {
            await Clipboard.setStringAsync(formattedSecret);
            Modal.alert(t('common.success'), t('settingsAccount.secretKeyCopied'));
        } catch {
            Modal.alert(t('common.error'), t('settingsAccount.secretKeyCopyFailed'));
        }
    }, [formattedSecret]);

    return (
        <View style={styles.modal}>
            <View style={styles.header}>
                <Text style={styles.title}>{t('settingsAccount.secretKey')}</Text>
                <Pressable onPress={props.onClose} hitSlop={12}>
                    <Ionicons name="close" size={20} color={theme.colors.textSecondary} />
                </Pressable>
            </View>

            <Text style={styles.description}>{t('settingsAccount.backupDescription')}</Text>

            <View style={styles.keyContainer}>
                <View style={styles.keyLabelRow}>
                    <Text style={styles.keyLabel}>{t('settingsAccount.secretKeyLabel')}</Text>
                    <Ionicons
                        name={revealed ? 'eye-off-outline' : 'eye-outline'}
                        size={18}
                        color={theme.colors.textSecondary}
                    />
                </View>
                <Text style={styles.keyText}>{revealed ? formattedSecret : maskedSecret}</Text>
                <View style={styles.row}>
                    <Pressable
                        onPress={() => setRevealed((v) => !v)}
                        hitSlop={8}
                    >
                        <Text style={styles.link}>
                            {revealed ? t('settingsAccount.tapToHide') : t('settingsAccount.tapToReveal')}
                        </Text>
                    </Pressable>
                    <RoundButton title={t('common.copy')} onPress={handleCopy} size="normal" />
                </View>
            </View>

            <RoundButton title={t('common.ok')} onPress={props.onClose} size="normal" />
        </View>
    );
}
