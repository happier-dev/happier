import * as React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { FlowSurfaceActions, FlowSurfaceChrome } from '@/components/ui/flowSurface';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

type TerminalConnectMessageState = Readonly<{
    kind: 'message';
    title: string;
    description?: string;
    tone?: 'default' | 'critical';
    loading?: boolean;
}>;

type TerminalConnectApprovalState = Readonly<{
    kind: 'approval';
    publicKey: string;
    isLoading: boolean;
    onApprove: () => void | Promise<void>;
    onReject: () => void | Promise<void>;
}>;

export type TerminalConnectSurfaceState =
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
    section: {
        gap: 8,
    },
    sectionTitle: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        lineHeight: 18,
        color: theme.colors.text,
    },
    sectionBody: {
        gap: 6,
    },
    sectionLine: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.textSecondary,
    },
    securityBlock: {
        paddingTop: 6,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.divider,
        gap: 8,
    },
    securityRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
    },
    securityCopy: {
        flex: 1,
        gap: 4,
    },
    securityTitle: {
        ...Typography.default('semiBold'),
        fontSize: 14,
        lineHeight: 18,
        color: theme.colors.text,
    },
    securitySubtitle: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
    message: {
        alignItems: 'center',
        gap: 12,
        paddingVertical: 10,
    },
}));

function truncatePublicKey(publicKey: string): string {
    const value = String(publicKey ?? '').trim();
    if (value.length <= 12) return value;
    return `${value.slice(0, 12)}...`;
}

export function TerminalConnectSurface(props: TerminalConnectSurfaceProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    if (props.state.kind === 'message') {
        return (
            <FlowSurfaceChrome
                testID={props.testID}
                showScrim={false}
                title={props.state.title}
                subtitle={props.state.description}
            >
                <View style={styles.message}>
                    {props.state.loading ? (
                        <ActivityIndicator color={theme.colors.button.primary.background} />
                    ) : (
                        <Ionicons
                            name={props.state.tone === 'critical' ? 'warning-outline' : 'terminal-outline'}
                            size={34}
                            color={props.state.tone === 'critical' ? theme.colors.textDestructive : theme.colors.radio.active}
                        />
                    )}
                </View>
            </FlowSurfaceChrome>
        );
    }

    return (
        <FlowSurfaceChrome
            testID={props.testID}
            showScrim={false}
            titleLeading={(
                <View style={styles.icon}>
                    <Ionicons name="terminal-outline" size={32} color={theme.colors.radio.active} />
                </View>
            )}
            title={t('terminal.connectTerminal')}
            subtitle={t('terminal.terminalRequestDescription')}
            footer={(
                <FlowSurfaceActions
                    primary={{
                        testID: 'terminal-connect-approve',
                        label: props.state.isLoading ? t('terminal.connecting') : t('terminal.acceptConnection'),
                        onPress: props.state.onApprove,
                        disabled: props.state.isLoading,
                        loading: props.state.isLoading,
                    }}
                    secondary={{
                        testID: 'terminal-connect-reject',
                        label: t('terminal.reject'),
                        onPress: props.state.onReject,
                        disabled: props.state.isLoading,
                    }}
                />
            )}
        >
            <View style={styles.section}>
                <Text style={styles.sectionTitle}>{t('terminal.connectionDetails')}</Text>
                <View style={styles.sectionBody}>
                    <Text style={styles.sectionLine}>
                        {t('terminal.publicKey')}: {truncatePublicKey(props.state.publicKey)}
                    </Text>
                    <Text style={styles.sectionLine}>
                        {t('terminal.encryption')}: {t('terminal.endToEndEncrypted')}
                    </Text>
                </View>
            </View>

            <View style={styles.securityBlock}>
                <Text style={styles.sectionTitle}>{t('terminal.security')}</Text>
                <View style={styles.securityRow}>
                    <Ionicons name="shield-checkmark-outline" size={20} color={theme.colors.success} />
                    <View style={styles.securityCopy}>
                        <Text style={styles.securityTitle}>{t('terminal.clientSideProcessing')}</Text>
                        <Text style={styles.securitySubtitle}>{t('terminal.linkProcessedOnDevice')}</Text>
                        <Text style={styles.securitySubtitle}>{t('terminal.securityFooterDevice')}</Text>
                    </View>
                </View>
            </View>
        </FlowSurfaceChrome>
    );
}
