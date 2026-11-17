import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { iconMatchedSpinnerSize } from '@happier-dev/plugin-ui/presentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { fieldBoxShapeStyle } from '@/components/ui/forms/fieldBox';
import { Icon } from '@/components/ui/icons/Icon';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { ConnectedServiceSetupFlowActions } from '../setup/ConnectedServiceSetupFlowBody';
import { ConnectedAccountFormSection } from './ConnectedAccountFormSection';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
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
    status: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s12,
        borderRadius: fieldBoxShapeStyle.borderRadius,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    statusText: {
        flex: 1,
        minWidth: 0,
    },
    statusTitle: {
        ...Typography.variant('body', 'medium'),
        color: theme.colors.text.primary,
    },
    statusBody: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    pasteBlock: {
        minWidth: 0,
        gap: theme.space.s6,
    },
    description: {
        ...Typography.variant('meta'),
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
        ...Typography.variant('meta'),
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
 * Signing in with a browser (lab `credentials` crSignin-bCode): nothing here is sequential (owner), so
 * it is one status row and the field. The row offers the sign-in page; once that page opened it says
 * it waits there, with Open again. Below it the person pastes what the provider shows (a code, or the
 * address the browser lands on). The pasted answer is checked locally for its shape before anything
 * is sent (G5); the daemon still validates it.
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
        <FieldItem label={callbackLabel} labelNativeID="connected-account-oauth:callback-label" controlContainerStyle={styles.pasteBlock}>
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
        </FieldItem>
    );
    const host = React.useMemo(() => {
        try { return new URL(props.authorizationUrl).host || props.authorizationUrl; }
        catch { return props.authorizationUrl; }
    }, [props.authorizationUrl]);
    const statusTitle = opened
        ? t('connectedServicesSettings.oauthWaitingTitle', { host })
        : t('connectedServicesSettings.oauthOpenTitle', { host });
    const statusBody = !opened
        ? t('connectedServicesSettings.oauthOpenBody')
        : props.allowRawAuthorizationCode === true
            ? t('connectedServicesSettings.oauthWaitingBodyCode')
            : t('connectedServicesSettings.oauthWaitingBodyAddress');
    const status = (
        <View>
            <View testID="connected-account-oauth:status" style={styles.status} accessible
                accessibilityLabel={`${statusTitle}. ${statusBody}`} accessibilityLiveRegion="polite">
                {opened ? (
                    <View testID="connected-account-oauth:waiting-spinner">
                        <ActivitySpinner size={iconMatchedSpinnerSize(16)} color={theme.colors.text.secondary} />
                    </View>
                ) : null}
                <View style={styles.statusText}>
                    <Text style={styles.statusTitle}>{statusTitle}</Text>
                    <Text style={styles.statusBody}>{statusBody}</Text>
                </View>
                <RoundButton
                    testID="connected-account-oauth:open"
                    size="small"
                    leading={<Icon name="arrow-square-out" size={14}
                        color={opened ? theme.colors.button.secondary.tint : theme.colors.button.primary.tint} />}
                    display={opened ? 'secondary' : 'default'}
                    title={opened
                        ? t('connectedServicesSettings.oauthOpenAgain')
                        : t('connectedServices.oauthPaste.openAuthorizationUrl')}
                    disabled={props.submitting || !props.authorizationUrl}
                    onPress={() => void openAuthorizationUrl()}
                />
            </View>
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
    return (
        <ConnectedAccountFormSection embedded={props.embedded}>
            <View style={props.embedded ? styles.embedded : styles.page}>
                {status}
                {field}
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
