import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { formatRecoveryKeyForDisplay, maskRecoveryKeyForDisplay } from '@/auth/recovery/secretKeyBackup';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { Icon } from '@/components/ui/icons/Icon';
import { downloadWebFile } from '@/sync/runtime/files/downloadWebFile';
import { createNativeCacheFileSink, shareNativeCacheFile } from '@/sync/runtime/files/nativeCacheFileSink';


const stylesheet = StyleSheet.create((theme) => ({
    body: {
        paddingHorizontal: 16,
        paddingVertical: 16,
        gap: 12,
    },
    footerContent: {
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 16,
        alignItems: 'stretch',
    },
    description: {
        fontSize: 14,
        color: theme.colors.text.secondary,
        lineHeight: 20,
        ...Typography.default(),
    },
    keyContainer: {
        backgroundColor: theme.colors.surface.base,
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        marginBottom: 12,
    },
    keyText: {
        fontSize: 13,
        letterSpacing: 0.5,
        lineHeight: 20,
        color: theme.colors.text.primary,
        ...Typography.mono(),
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 4,
    },
    revealToggle: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    link: {
        fontSize: 14,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
}));

type Props = CustomModalInjectedProps & Readonly<{
    secret: string | Uint8Array;
    onSaved?: () => void | Promise<void>;
    onDefer?: () => void | Promise<void>;
}>;

export function SecretKeyBackupModal(props: Props) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const [revealed, setRevealed] = React.useState(false);
    const copyFeedback = useTemporaryCopyFeedback();

    const formattedSecret = React.useMemo(() => formatRecoveryKeyForDisplay(props.secret), [props.secret]);
    const maskedSecret = React.useMemo(() => maskRecoveryKeyForDisplay(formattedSecret), [formattedSecret]);

    React.useEffect(() => () => {
        if (props.secret instanceof Uint8Array) props.secret.fill(0);
    }, [props.secret]);

    const handleCopy = React.useCallback(async () => {
        const copied = await setClipboardStringSafe(formattedSecret);
        if (!copied) {
            Modal.alert(t('common.error'), t('settingsAccount.secretKeyCopyFailed'));
            return;
        }
        copyFeedback.markCopied();
    }, [copyFeedback, formattedSecret]);

    const handleExport = React.useCallback(async () => {
        const contents = `${formattedSecret}\n`;
        try {
            if (Platform.OS === 'web') {
                downloadWebFile(new Blob([contents], { type: 'text/plain;charset=utf-8' }), 'happier-recovery-key.txt', async () => {});
                return;
            }
            const sink = await createNativeCacheFileSink({
                directoryName: 'happier-downloads',
                fileName: 'happier-recovery-key.txt',
            });
            if (!sink.ok) throw new Error(sink.error);
            let retainCacheFile = false;
            try {
                await sink.writeBytes(new TextEncoder().encode(contents));
                await sink.close();
                const result = await shareNativeCacheFile({
                    fileUri: sink.fileUri, name: 'happier-recovery-key.txt', mimeType: 'text/plain',
                });
                if (result.status !== 'shared') throw new Error('sharing_unavailable');
                retainCacheFile = result.retainCacheFile;
            } finally {
                if (!retainCacheFile) await sink.cleanup();
            }
        } catch {
            Modal.alert(t('common.error'), t('settingsAccount.secretKeyCopyFailed'));
        }
    }, [formattedSecret]);

    const finish = React.useCallback(async (kind: 'saved' | 'later') => {
        if (kind === 'saved') await props.onSaved?.();
        else await props.onDefer?.();
        props.onClose();
    }, [props.onClose, props.onDefer, props.onSaved]);

    const footer = React.useMemo(() => (
        <View style={[styles.footerContent, { gap: 8 }]}>
            <RoundButton testID="recovery-key-saved" title={t('settingsApiTokens.reveal.savedIt')} onPress={() => finish('saved')} size="normal" />
            <RoundButton testID="recovery-key-later" display="inverted" title={t('settingsAccount.nativePassword.recoveryKeyLater')} onPress={() => finish('later')} size="normal" />
        </View>
    ), [finish]);

    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: t('settingsAccount.secretKey'),
        testID: 'secret-key-backup-modal',
        closeButtonTestID: 'secret-key-backup-close',
        bodyScroll: 'auto' as const,
        footer,
        dimensions: { width: 360, maxHeightRatio: 0.85, size: 'dialog' as const },
    }), [footer]);

    useModalCardChrome(props.setChrome, chrome);

    return (
        <View style={styles.body}>
            <Text style={styles.description}>{t('settingsAccount.backupDescription')}</Text>

            <View style={styles.keyContainer}>
                <Text style={styles.keyText}>{revealed ? formattedSecret : maskedSecret}</Text>
                <View style={styles.row}>
                    <Pressable
                        onPress={() => setRevealed((v) => !v)}
                        hitSlop={8}
                        accessibilityRole="button"
                        style={styles.revealToggle}
                    >
                        <Icon
                            name={revealed ? 'eye-slash' : 'eye'}
                            size={16}
                            color={theme.colors.text.secondary}
                        />
                        <Text style={styles.link}>
                            {revealed ? t('settingsAccount.tapToHide') : t('settingsAccount.tapToReveal')}
                        </Text>
                    </Pressable>
                    {copyFeedback.isCopied() ? (
                        <CopiedPill visible testID="secret-key-backup-copy-feedback" />
                    ) : (
                        <RoundButton testID="recovery-key-copy" display="secondary" title={t('common.copy')} onPress={handleCopy} size="normal" />
                    )}
                </View>
            </View>
            <RoundButton
                testID="recovery-key-download"
                title={Platform.OS === 'web' ? t('settingsAccount.nativePassword.recoveryKeyDownload') : t('common.share')}
                display="secondary"
                onPress={handleExport}
                size="normal"
            />
        </View>
    );
}
