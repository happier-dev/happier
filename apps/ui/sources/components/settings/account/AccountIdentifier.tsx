import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';

/**
 * The Account ID this device is signed in with on the current Home, with a copy action. It is the
 * identifier that tells two devices apart when they are signed in to different Accounts.
 */
export const AccountIdentifier = React.memo(function AccountIdentifier(props: Readonly<{ accountId: string }>) {
    const copyFeedback = useHappierCopyFeedback();
    const writeClipboard = useClipboardWrite();
    const copy = React.useCallback(async () => {
        if (!await writeClipboard(props.accountId)) {
            Modal.alert(t('common.error'), t('items.failedToCopyToClipboard'));
            return;
        }
        copyFeedback.markCopied();
    }, [copyFeedback, props.accountId, writeClipboard]);

    return (
        <View testID="settings-account-id" style={styles.row}>
            <Text style={styles.label}>{t('settingsAccount.accountIdLabel')}</Text>
            <Text style={styles.value} numberOfLines={1} ellipsizeMode="middle" selectable>
                {props.accountId}
            </Text>
            {copyFeedback.isCopied() ? (
                <CopiedPill visible testID="settings-account-id-copied" />
            ) : (
                <IconButton
                    testID="settings-account-id-copy"
                    accessibilityLabel={t('settingsAccount.accountIdCopy')}
                    tooltip={t('settingsAccount.accountIdCopy')}
                    iconName="copy"
                    variant="plain"
                    size={24}
                    iconSize={14}
                    onPress={() => { void copy(); }}
                />
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        minWidth: 0,
    },
    label: {
        ...Typography.variant('body'),
        color: theme.colors.text.secondary,
        flexShrink: 0,
    },
    value: {
        // The id beside its body label: the meta role in the one mono face.
        ...Typography.variant('meta'),
        ...Typography.mono(),
        color: theme.colors.text.secondary,
        flexShrink: 1,
        minWidth: 0,
    },
}));
