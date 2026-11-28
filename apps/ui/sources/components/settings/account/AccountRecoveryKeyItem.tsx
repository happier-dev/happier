import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useAuth } from '@/auth/context/AuthContext';
import { formatRecoveryKeyForDisplay, maskRecoveryKeyForDisplay } from '@/auth/recovery/secretKeyBackup';
import { useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';
import { SecretValueControls, SecretValueText } from '@/components/ui/copy/SecretValueDisclosure';
import { Icon } from '@/components/ui/icons/Icon';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import type { FocusReturnTarget } from '@/keyboard/focusReturn';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';

import { useRecoveryKeyDisclosure, type RecoveryKeySource } from './useRecoveryKeyDisclosure';

const MASKED_RECOVERY_KEY = maskRecoveryKeyForDisplay();

/** Wipes a recovery secret handed over as bytes once its display form has been taken. */
function takeDisplayForm(secret: string | Uint8Array): string {
    const formatted = formatRecoveryKeyForDisplay(secret);
    if (secret instanceof Uint8Array) secret.fill(0);
    return formatted;
}

/**
 * The recovery key, masked in place, with reveal and copy. Both go through the same guard as the
 * backup disclosure (`useRecoveryKeyDisclosure`): password unlock or confirmation for a passwordless
 * Home. Hiding the key, leaving the page or changing Account clears the revealed value.
 */
export const AccountRecoveryKeyItem = React.memo(function AccountRecoveryKeyItem(props: Readonly<{
    recoveryEmail: string | null;
    showDivider?: boolean;
    /** Whose key this row shows; the signed-in Home Account by default. */
    source?: RecoveryKeySource;
    /** Test-ID stem for the row's parts, so two rows on one page stay distinct. */
    testIDPrefix?: string;
    /** Any change (another Account or service) forgets a revealed key, as an Account change does. */
    scopeKey?: string;
    onAddPassword?: () => void;
}>) {
    const { theme } = useUnistyles();
    const auth = useAuth();
    const triggerRef = React.useRef<FocusReturnTarget>(null);
    const { canDisclose, withRecoveryKey } = useRecoveryKeyDisclosure(props.recoveryEmail, triggerRef, props.source);
    const [revealed, setRevealed] = React.useState<string | null>(null);
    const copyFeedback = useHappierCopyFeedback();
    const writeClipboard = useClipboardWrite();
    const prefix = props.testIDPrefix ?? 'settings-account-recovery-key';

    // A different Account (or none) never inherits a key revealed for the previous one.
    React.useEffect(() => { setRevealed(null); }, [auth.credentials, props.scopeKey]);

    const toggleReveal = React.useCallback(() => {
        if (revealed) {
            setRevealed(null);
            return;
        }
        withRecoveryKey((secret) => { setRevealed(takeDisplayForm(secret)); });
    }, [revealed, withRecoveryKey]);

    const copy = React.useCallback(() => {
        withRecoveryKey(async (secret) => {
            if (!await writeClipboard(takeDisplayForm(secret))) {
                Modal.alert(t('common.error'), t('settingsAccount.secretKeyCopyFailed'));
                return;
            }
            copyFeedback.markCopied();
        });
    }, [copyFeedback, withRecoveryKey, writeClipboard]);

    return (
        <Item
            testID={props.testIDPrefix ? prefix : "settings-account-signin-recovery-key"}
            icon={<Icon name="key" size={18} color={theme.colors.text.secondary} />}
            title={t('settingsAccount.secretKey')}
            subtitle={(
                canDisclose ? <SecretValueText
                    testID={`${prefix}-value`}
                    revealed={revealed}
                    mask={MASKED_RECOVERY_KEY}
                    maskedAccessibilityLabel={t('settingsAccount.backupDescription')}
                    selectable
                /> : t('settingsAccount.nativePassword.recoveryKeyOffDevice')
            )}
            accessibilityHint={t('settingsAccount.backupDescription')}
            mode="info"
            showChevron={false}
            showDivider={props.showDivider}
            rightElementOutsidePressable
            rightElement={(
                canDisclose ? <SecretValueControls
                    testIDPrefix={prefix}
                    revealed={revealed !== null}
                    revealLabel={t('settingsAccount.showRecoveryKey')}
                    hideLabel={t('settingsAccount.hideRecoveryKey')}
                    onToggleReveal={toggleReveal}
                    onCopy={copy}
                    copied={copyFeedback.isCopied()}
                    copyAccessibilityLabel={`${t('common.copy')}: ${t('settingsAccount.secretKey')}`}
                    copyControlRef={(node) => { triggerRef.current = node; }}
                /> : props.onAddPassword ? <RoundButton
                    testID={prefix + '-add-password'}
                    size="small"
                    display="secondary"
                    title={t('settingsAccount.nativePassword.addPassword')}
                    onPress={props.onAddPassword}
                /> : null
            )}
        />
    );
});
