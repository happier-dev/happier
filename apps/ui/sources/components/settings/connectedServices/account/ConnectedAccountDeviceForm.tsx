import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { fieldBoxShapeStyle } from '@/components/ui/forms/fieldBox';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { requestOpenExternalUrl as openExternalUrl } from '@/utils/url/requestOpenExternalUrl';

import { ConnectedServiceSetupFlowActions } from '../setup/ConnectedServiceSetupFlowBody';
import { ConnectedAccountFormSection } from './ConnectedAccountFormSection';

function formatExpiry(msLeft: number): string {
    const totalSeconds = Math.max(0, Math.ceil(msLeft / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** The code's remaining life, ticking once a second in this leaf only while the code is shown. */
function useCodeExpiry(expiresAtMs: number | undefined): number | null {
    const [now, setNow] = React.useState(() => Date.now());
    const expired = expiresAtMs !== undefined && expiresAtMs <= now;
    React.useEffect(() => {
        if (expiresAtMs === undefined) return;
        const current = Date.now();
        setNow(current);
        if (expiresAtMs <= current) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [expiresAtMs, expired]);
    return expiresAtMs === undefined ? null : expiresAtMs - now;
}

/**
 * The waiting line and the code's deadline: the only part of the form that ticks. It tells the form once,
 * when the code runs out, so the code and its controls stay still while the seconds count down.
 */
const DeviceCodeWaitingLine = React.memo(function DeviceCodeWaitingLine(props: Readonly<{
    expiresAtMs: number | undefined;
    onExpired: (expiresAtMs: number) => void;
}>) {
    const { expiresAtMs, onExpired } = props;
    const msLeft = useCodeExpiry(expiresAtMs);
    const expired = msLeft !== null && msLeft <= 0;
    React.useEffect(() => {
        if (expired && expiresAtMs !== undefined) onExpired(expiresAtMs);
    }, [expired, expiresAtMs, onExpired]);
    return (
        <Text style={stylesheet.waitingText} numberOfLines={1}>{msLeft !== null
            ? t('connectedServicesSettings.deviceWaitingApprovalExpires', { time: formatExpiry(msLeft) })
            : t('connectedServicesSettings.deviceWaitingApproval')}</Text>
    );
});

/**
 * Signing in with a code (lab `credentials` crSignin-bGptCode): nothing here is sequential, so it is one
 * status row, as the browser form is: the code, where to enter it with the wait and its deadline under
 * it, and Copy. The footer's one primary opens that page; once the code ran out it offers a new one.
 * Happier checks at the provider's cadence; a service without a cadence keeps its manual check.
 */
export const ConnectedAccountDeviceForm = React.memo(function ConnectedAccountDeviceForm(props: Readonly<{
    /** Inside the new-account draft row instead of as page sections. */
    embedded?: boolean;
    verificationUri?: string;
    verificationUriComplete?: string;
    userCode?: string;
    /** When the code stops working (the provider's own expiry). */
    expiresAtMs?: number;
    /** The service's name, so the action says where it goes ("Open ChatGPT"). */
    serviceTitle?: string;
    busy: boolean;
    /** False only when a valid external attempt publishes no automatic polling cadence. */
    automaticPolling?: boolean;
    /** In a setup panel: Cancel (local), beside the primary. */
    onCancel?: () => void;
    onPoll(): Promise<void> | void;
    onResume(): Promise<void> | void;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const openUrl = props.verificationUriComplete ?? props.verificationUri ?? '';
    const where = props.verificationUri ? props.verificationUri.replace(/^https?:\/\//, '') : null;
    // The deadline that has run out; a new code (a new deadline) is live again until its own runs out.
    const [expiredAtMs, setExpiredAtMs] = React.useState<number | null>(null);
    const expired = props.expiresAtMs !== undefined
        && (expiredAtMs === props.expiresAtMs || props.expiresAtMs <= Date.now());
    const [copied, setCopied] = React.useState(false);
    const writeClipboard = useClipboardWrite(undefined, { enabled: Boolean(props.userCode) });
    const service = props.serviceTitle ?? null;
    const enterLine = where
        ? t('connectedServicesSetup.deviceEnterAt', { where })
        : service ? t('connectedServicesSetup.deviceEnterIn', { service }) : null;
    const pollManually = !expired && props.automaticPolling === false;

    return (
        <ConnectedAccountFormSection embedded={props.embedded}>
            <View style={props.embedded ? styles.embedded : styles.page}>
                <View testID="connected-account-device:status" style={styles.status}>
                    <Text
                        testID="connected-account-device:code"
                        selectable
                        style={[styles.code, expired ? styles.expired : null]}
                        accessibilityLabel={props.userCode ? props.userCode.split('').join(' ') : undefined}
                    >
                        {props.userCode ?? t('connectedServices.deviceAuth.preparing')}
                    </Text>
                    <View style={styles.statusText} accessibilityLiveRegion="polite">
                        {enterLine ? (
                            <Text testID="connected-account-device:where" style={[styles.enterLine, expired ? styles.expired : null]}>
                                {enterLine}
                            </Text>
                        ) : null}
                        {expired ? (
                            <View style={styles.expiredLine}>
                                <Icon name="clock" size={14} color={theme.colors.text.secondary} />
                                <Text style={styles.expiredText}>{t('connectedServicesSettings.deviceExpired')}</Text>
                            </View>
                        ) : (
                            // One status line, never wrapped: the wait and its deadline, the time in tabular figures.
                            <DeviceCodeWaitingLine expiresAtMs={props.expiresAtMs} onExpired={setExpiredAtMs} />
                        )}
                    </View>
                    {pollManually ? (
                        <RoundButton testID="connected-account-device:poll" size="small" display="secondary"
                            title={t('connectedServicesSetup.deviceCheckNow')} disabled={props.busy} onPress={props.onPoll} />
                    ) : null}
                    {props.userCode && !expired ? (
                        <RoundButton
                            testID="connected-account-device:copy"
                            size="small"
                            display="secondary"
                            title={copied ? t('common.copied') : t('common.copy')}
                            leading={<Icon name={copied ? 'check' : 'copy'} size={14} color={theme.colors.text.secondary} />}
                            onPress={async () => {
                                setCopied(await writeClipboard(props.userCode ?? ''));
                            }}
                        />
                    ) : null}
                </View>
                <ConnectedServiceSetupFlowActions
                    onCancel={props.onCancel}
                    primary={expired ? {
                        testID: 'connected-account-device:resume',
                        label: t('connectedServicesSettings.deviceNewCode'),
                        disabled: props.busy,
                        onPress: () => void props.onResume(),
                    } : {
                        testID: 'connected-account-device:open',
                        label: service
                            ? t('connectedServicesSettings.deviceOpenService', { service })
                            : t('connectedServices.deviceAuth.openVerificationUrl'),
                        opensOutside: true,
                        disabled: props.busy || !openUrl,
                        onPress: () => void openExternalUrl(openUrl),
                    }}
                />
            </View>
        </ConnectedAccountFormSection>
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    page: {
        paddingHorizontal: theme.space.s16,
        paddingVertical: theme.space.s12,
        gap: theme.space.s12,
    },
    embedded: {
        gap: theme.space.s12,
    },
    // The browser form's status row (`ConnectedAccountOAuthForm`): one hairline box on the field shape.
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
    code: {
        ...Typography.variant('heading'),
        ...Typography.mono('semiBold'),
        color: theme.colors.text.primary,
    },
    expired: {
        opacity: 0.45,
    },
    statusText: {
        flex: 1,
        minWidth: 0,
    },
    enterLine: {
        ...Typography.variant('body'),
        color: theme.colors.text.primary,
    },
    waitingText: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
        flexShrink: 1,
        minWidth: 0,
    },
    expiredLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
    },
    expiredText: {
        ...Typography.variant('meta'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
}));
