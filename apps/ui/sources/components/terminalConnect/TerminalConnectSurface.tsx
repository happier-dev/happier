import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useOptionalAuth } from '@/auth/context/AuthContext';
import { UnauthenticatedRouteStep, type AuthRouteStepAction } from '@/components/onboarding/ui/AuthRouteStepFrame';
import { StepMark } from '@/components/onboarding/unauthShell/StepMark';
import { FlowSurfaceActions, FlowSurfaceChrome } from '@/components/ui/flowSurface';
import { Text } from '@/components/ui/text/Text';
import type { TerminalConnectSuccess } from '@/hooks/session/useConnectTerminal';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';

type TerminalConnectMessageState = Readonly<{
    kind: 'message';
    title: string;
    description?: string;
    tone?: 'default' | 'critical';
    loading?: boolean;
    /** The one way forward from this state. */
    action?: Readonly<{ testID: string; label: string; onPress: () => void }>;
}>;

type TerminalConnectApprovalState = Readonly<{
    kind: 'approval';
    isLoading: boolean;
    homeUrl: string;
    storageMode: 'plain' | 'e2ee' | null;
    needsSignIn?: boolean;
    errorDescription?: string;
    onRetry?: () => void;
    onApprove: () => void | Promise<void>;
    onReject: () => void | Promise<void>;
}>;

export type TerminalConnectSurfaceState =
    | Readonly<{ kind: 'connected'; result?: TerminalConnectSuccess; onContinue: () => void }>
    | TerminalConnectMessageState
    | TerminalConnectApprovalState;

export type TerminalConnectSurfaceProps = Readonly<{
    testID?: string;
    state: TerminalConnectSurfaceState;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    icon: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    sectionBody: {
        gap: theme.space.s6,
    },
    sectionLine: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
    consequence: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s10,
        paddingTop: theme.space.s12,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.default,
    },
    consequenceText: {
        ...Typography.variant('body'),
        flex: 1,
        color: theme.colors.text.secondary,
    },
    paneProgress: {
        alignItems: 'flex-start',
    },
    message: {
        alignItems: 'center',
        gap: theme.space.s12,
        paddingVertical: theme.space.s10,
    },
}));

type TerminalConnectFrameProps = Readonly<{
    signedIn: boolean;
    testID?: string;
    titleLeading?: React.ReactNode;
    title: string;
    subtitle?: string;
    /** Signed out: the step's actions, drawn by the step (its primary, a quiet second). */
    step?: Readonly<{ primary?: AuthRouteStepAction; secondary?: AuthRouteStepAction; problem?: boolean }>;
    /** Signed in: the card's footer. */
    renderFooter?: () => React.ReactNode;
    children?: React.ReactNode;
}>;

/**
 * Signed out, a terminal link is one more step of the welcome split (it hands off to sign-in in
 * the same pane), drawn like every other link step: the terminal mark over its heading, and a link
 * that leads nowhere standing lower as a problem step. Signed in, it is the focused approval card.
 */
function TerminalConnectFrame(props: TerminalConnectFrameProps) {
    if (!props.signedIn) {
        return (
            <UnauthenticatedRouteStep
                shellTestID="unauth-shell-terminal-connect"
                stepId="terminal-connect"
                testID={props.testID ?? 'terminal-connect-surface'}
                title={props.title}
                subtitle={props.subtitle}
                mark={<StepMark iconName="terminal" />}
                status={props.step?.problem}
                primary={props.step?.primary}
                secondary={props.step?.secondary}
            >
                {props.children ?? null}
            </UnauthenticatedRouteStep>
        );
    }
    return (
        <FlowSurfaceChrome
            testID={props.testID}
            showScrim={false}
            titleLeading={props.titleLeading}
            title={props.title}
            subtitle={props.subtitle}
            footer={props.renderFooter?.()}
        >
            {props.children}
        </FlowSurfaceChrome>
    );
}

export function TerminalConnectSurface(props: TerminalConnectSurfaceProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const signedIn = useOptionalAuth()?.isAuthenticated === true;

    if (props.state.kind === 'connected') {
        return (
            <UnauthenticatedRouteStep
                shellTestID="unauth-shell-terminal-connect"
                stepId="terminal-connected"
                testID={props.testID ?? 'terminal-connect-surface'}
                title={t('terminal.connectedStep.title')}
                subtitle={props.state.result === 'approved_without_team_access'
                    ? t('terminal.connectedStep.restrictedTeamAccessUnavailable')
                    : t('terminal.connectedStep.body')}
                mark={<StepMark iconName="check" />}
                primary={{ testID: 'terminal-connect-continue', label: t('terminal.connectedStep.continue'), onPress: props.state.onContinue }}
            />
        );
    }

    if (props.state.kind === 'message') {
        const action = props.state.action;
        // In the welcome pane a message is a step: the terminal mark, its heading and sentence carry it, and only
        // real progress earns a spinner under them; a link that leads nowhere is a problem step.
        if (!signedIn) {
            return (
                <TerminalConnectFrame
                    signedIn={false}
                    testID={props.testID}
                    title={props.state.title}
                    subtitle={props.state.description}
                    step={{
                        problem: props.state.tone === 'critical',
                        primary: action ? { testID: action.testID, label: action.label, onPress: action.onPress } : undefined,
                    }}
                >
                    {props.state.loading ? (
                        <View style={styles.paneProgress}>
                            <ActivitySpinner color={theme.colors.text.secondary} />
                        </View>
                    ) : null}
                </TerminalConnectFrame>
            );
        }
        return (
            <TerminalConnectFrame
                signedIn
                testID={props.testID}
                title={props.state.title}
                subtitle={props.state.description}
                renderFooter={action ? () => (
                    <FlowSurfaceActions
                        placement="card"
                        primary={{ testID: action.testID, label: action.label, onPress: action.onPress }}
                    />
                ) : undefined}
            >
                <View style={styles.message}>
                    {props.state.loading ? (
                        <ActivitySpinner color={theme.colors.button.primary.background} />
                    ) : (
                        <Icon
                            name={props.state.tone === 'critical' ? 'warning' : 'terminal'}
                            size={34}
                            color={props.state.tone === 'critical' ? theme.colors.state.danger.foreground : theme.colors.text.secondary}
                        />
                    )}
                </View>
            </TerminalConnectFrame>
        );
    }

    const approval = props.state;
    const approvalLabel = approval.isLoading ? t('terminal.connecting')
        : approval.onRetry ? t('common.retry')
            : approval.needsSignIn ? t('common.continue') : t('terminal.acceptConnection');
    const approvalDisabled = approval.isLoading || (!approval.storageMode && !approval.needsSignIn && !approval.onRetry);
    return (
        <TerminalConnectFrame
            signedIn={signedIn}
            testID={props.testID}
            titleLeading={(
                <View style={styles.icon}>
                    <Icon name="terminal" size={32} color={theme.colors.text.secondary} />
                </View>
            )}
            title={t('terminal.connectTerminal')}
            subtitle={t('terminal.terminalRequestDescription')}
            step={{
                primary: {
                    testID: 'terminal-connect-approve',
                    label: approvalLabel,
                    onPress: approval.onRetry ?? approval.onApprove,
                    disabled: approvalDisabled,
                },
                secondary: {
                    testID: 'terminal-connect-reject',
                    label: t('terminal.reject'),
                    onPress: approval.onReject,
                    disabled: approval.isLoading,
                },
            }}
            renderFooter={() => (
                <FlowSurfaceActions
                    placement="card"
                    primary={{
                        testID: 'terminal-connect-approve',
                        label: approvalLabel,
                        onPress: approval.onRetry ?? approval.onApprove,
                        disabled: approvalDisabled,
                        loading: approval.isLoading,
                    }}
                    secondary={{
                        testID: 'terminal-connect-reject',
                        label: t('terminal.reject'),
                        onPress: approval.onReject,
                        disabled: approval.isLoading,
                    }}
                />
            )}
        >
            <View style={styles.sectionBody}>
                <Text style={styles.sectionLine}>
                    {t('server.customServerUrlLabel')}: {props.state.homeUrl}
                </Text>
                <Text style={styles.sectionLine}>
                    {t('terminal.encryption')}: {props.state.storageMode === 'e2ee'
                        ? t('terminal.endToEndEncrypted')
                        : props.state.storageMode === 'plain' ? t('terminal.plaintextStorage')
                            : props.state.errorDescription ?? (props.state.needsSignIn ? t('modals.pleaseSignInFirst') : t('common.loading'))}
                </Text>
            </View>

            <View style={styles.consequence}>
                <Icon name="shield-check" size={20} color={theme.colors.text.secondary} />
                <Text style={styles.consequenceText}>
                    {props.state.storageMode === 'plain' ? t('terminal.plaintextStorageDescription')
                        : props.state.storageMode === 'e2ee' ? t('terminal.securityFooterDevice')
                            : t('terminal.linkProcessedOnDevice')}
                </Text>
            </View>
        </TerminalConnectFrame>
    );
}
