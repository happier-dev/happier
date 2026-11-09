import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ConnectedServiceSetupFlowActions } from '../setup/ConnectedServiceSetupFlowBody';
import { ConnectedAccountFormSection } from './ConnectedAccountFormSection';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Text } from '@/components/ui/text/Text';
import { SetupSteps } from '@/components/ui/setupBlocks/SetupSteps';
import { t } from '@/text';
import { parseOauthCallbackUrl } from '@/utils/auth/oauthCore';
import { getClipboardStringTrimmedSafe } from '@/utils/ui/clipboard';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';

import { useConnectedAccountInvalidFieldFocus } from './useConnectedAccountInvalidFieldFocus';
import { useConnectedAccountDraftNavigationGuard } from './useConnectedAccountDraftNavigationGuard';

const stylesheet = StyleSheet.create((theme) => ({
    page: {
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s12,
        gap: 14,
    },
    embedded: {
        gap: 14,
    },
    openBlock: {
        gap: theme.space.s6,
    },
    pasteBlock: {
        flex: 1,
        minWidth: 0,
        gap: theme.space.s6,
    },
    description: {
        fontSize: 12.5,
        lineHeight: 17,
        color: theme.colors.text.secondary,
    },
    fieldRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s8,
    },
    field: {
        flex: 1,
        minWidth: 0,
    },
    shapeOk: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.state.success.foreground,
    },
}));

type ConnectedAccountOAuthFormProps = Readonly<{
    /** Inside the new-account draft row instead of as page sections. */
    embedded?: boolean;
    authorizationUrl: string;
    callbackUrl: string;
    allowRawAuthorizationCode?: boolean;
    submitting: boolean;
    navigation?: unknown;
    /** In a setup panel: Cancel (local) beside Connect. */
    onCancel?: () => void;
    onSubmit(completion: Readonly<{
        code: string;
        callbackUrl: string;
        state: string;
        iss?: string;
    }>): Promise<boolean | void> | boolean | void;
}>;

/**
 * Signing in with a browser (lab `csvc` A3): three visible steps — open the provider's sign-in,
 * approve, paste back what the provider shows (a code, or the address the browser lands on). The
 * pasted answer is checked locally for its shape before anything is sent (G5); the daemon still
 * validates it.
 */
function ConnectedAccountOAuthFormBody(props: ConnectedAccountOAuthFormProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const [callbackInput, setCallbackInput] = React.useState('');
    const [validationFailed, setValidationFailed] = React.useState(false);
    const [openFailed, setOpenFailed] = React.useState(false);
    const [opened, setOpened] = React.useState(false);
    const callbackInvalidFieldIds = validationFailed ? ['callback'] : [];
    const registerInvalidFieldTarget = useConnectedAccountInvalidFieldFocus({
        invalidFieldIds: callbackInvalidFieldIds,
        announcement: t('connectedServices.oauthPaste.invalidConfig'),
    });
    const authorizationState = React.useMemo(() => {
        try { return new URL(props.authorizationUrl).searchParams.get('state') || null; }
        catch { return null; }
    }, [props.authorizationUrl]);
    const parsed = React.useMemo(() => parseOauthCallbackUrl({
        url: callbackInput,
        redirectUri: props.callbackUrl,
        allowRawAuthorizationCode: props.allowRawAuthorizationCode,
    }), [callbackInput, props.callbackUrl, props.allowRawAuthorizationCode]);
    const returnedState = parsed.rawAuthorizationCode ? authorizationState : parsed.state;
    const shapeOk = Boolean(parsed.code && returnedState && !parsed.error
        && (!authorizationState || returnedState === authorizationState));

    const submit = React.useCallback(async () => {
        if (!shapeOk || !parsed.code || !returnedState) {
            setValidationFailed(true);
            return false;
        }
        const accepted = await props.onSubmit({
            code: parsed.code,
            callbackUrl: props.callbackUrl,
            state: returnedState,
            ...(parsed.iss === undefined ? {} : { iss: parsed.iss }),
        });
        return accepted !== false;
    }, [parsed.code, parsed.iss, returnedState, props, shapeOk]);
    const discardDraft = React.useCallback(() => {
        setCallbackInput('');
        setValidationFailed(false);
    }, []);
    useConnectedAccountDraftNavigationGuard({
        navigation: props.navigation,
        isDirty: callbackInput.length > 0,
        onDiscard: discardDraft,
        onSave: submit,
        tag: 'ConnectedAccountOAuthForm',
    });
    const openAuthorizationUrl = React.useCallback(async () => {
        setOpenFailed(false);
        try {
            if (!await openExternalUrl(props.authorizationUrl)) {
                setOpenFailed(true);
            } else {
                setOpened(true);
            }
        } catch {
            setOpenFailed(true);
        }
    }, [props.authorizationUrl]);
    const paste = React.useCallback(async () => {
        const value = await getClipboardStringTrimmedSafe();
        if (!value) return;
        setCallbackInput(value);
        setValidationFailed(false);
    }, []);

    const callbackLabel = t(props.allowRawAuthorizationCode === true
        ? 'connectedServicesSettings.oauthPastePlaceholder'
        : 'connectedServices.oauthPaste.pasteRedirectUrl');
    const field = (
        <View style={styles.pasteBlock}>
            <View style={styles.fieldRow}>
                <View style={styles.field}>
                    <FieldTextInput
                        testID="connected-account-oauth:callback"
                        ref={registerInvalidFieldTarget('callback')}
                        accessibilityLabel={validationFailed
                            ? `${callbackLabel}: ${t('connectedServices.oauthPaste.invalidConfig')}`
                            : callbackLabel}
                        error={validationFailed ? t('connectedServices.oauthPaste.invalidConfig') : null}
                        value={callbackInput}
                        onChangeText={(value) => {
                            setCallbackInput(value);
                            setValidationFailed(false);
                        }}
                        placeholder={t('connectedServicesSettings.oauthPastePlaceholder')}
                        editable={!props.submitting}
                        monospace
                        trailing={<IconButton testID="connected-account-oauth:paste" iconName="clipboard" variant="plain" size={20}
                            accessibilityLabel={t('common.paste')} disabled={props.submitting} onPress={() => void paste()} />}
                    />
                </View>
            </View>
            {shapeOk ? (
                <Text testID="connected-account-oauth:callback.shape-ok" style={styles.shapeOk}>
                    {t('connectedServicesSettings.oauthShapeOk')}
                </Text>
            ) : null}
        </View>
    );
    const open = (
        <View style={styles.openBlock}>
            <RoundButton
                testID="connected-account-oauth:open"
                size="small"
                leading={<Icon name="arrow-square-out" size={14} color={theme.colors.button.primary.tint} />}
                display={opened ? 'secondary' : 'default'}
                title={t('connectedServices.oauthPaste.openAuthorizationUrl')}
                disabled={props.submitting || !props.authorizationUrl}
                onPress={() => void openAuthorizationUrl()}
            />
            {openFailed ? (
                <Text
                    testID="connected-account-oauth:open-error"
                    accessibilityRole="alert"
                    accessibilityLiveRegion="assertive"
                    style={styles.description}
                >
                    {t('connectedServices.oauthPaste.alerts.failedToOpenUrl')}
                </Text>
            ) : null}
        </View>
    );
    const pasted = callbackInput.trim().length > 0;
    return (
        <ConnectedAccountFormSection embedded={props.embedded}>
            <View style={props.embedded ? styles.embedded : styles.page}>
                <SetupSteps
                    testID="connected-account-oauth:steps"
                    steps={[
                        { key: 'open', state: opened ? 'done' : 'current', title: t('connectedServicesSettings.oauthStepOpen'), body: open },
                        { key: 'approve', state: pasted ? 'done' : opened ? 'current' : 'upcoming', title: t('connectedServicesSettings.oauthStepApprove') },
                        { key: 'paste', state: opened || pasted ? 'current' : 'upcoming', title: t('connectedServicesSettings.oauthStepPaste'), body: field },
                    ]}
                />
                <ConnectedServiceSetupFlowActions
                    onCancel={props.onCancel}
                    primary={{
                        testID: 'connected-account-oauth:submit',
                        label: t('connectedServicesSettings.connect'),
                        disabled: props.submitting || !callbackInput.trim(),
                        loading: props.submitting,
                        onPress: () => void submit(),
                    }}
                />
            </View>
        </ConnectedAccountFormSection>
    );
}

/** A changed OAuth redirect contract starts a new callback-paste lifetime. */
export const ConnectedAccountOAuthForm = React.memo(function ConnectedAccountOAuthForm(
    props: ConnectedAccountOAuthFormProps,
) {
    const draftKey = React.useMemo(
        () => JSON.stringify([props.authorizationUrl, props.callbackUrl]),
        [props.authorizationUrl, props.callbackUrl],
    );
    return <ConnectedAccountOAuthFormBody key={draftKey} {...props} />;
});
