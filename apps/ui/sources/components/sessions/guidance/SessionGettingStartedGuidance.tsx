import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';
import { useRouter } from 'expo-router';
import { Modal } from '@/modal';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useVisibleSessionListViewData } from '@/hooks/session/useVisibleSessionListViewData';
import { useResolvedActiveServerSelection } from '@/hooks/server/useEffectiveServerSelection';
import { useMachineListByServerId, useMachineListStatusByServerId, useSetting } from '@/sync/domains/state/storage';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { useConnectTerminal } from '@/hooks/session/useConnectTerminal';
import type { FeatureId } from '@happier-dev/protocol';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { config } from '@/config';
import { resolveAppVariant, type AppVariant } from '@/sync/runtime/appVariant';
import { isTauriDesktop } from '@/utils/platform/tauri';

import type { SessionGettingStartedDecisionKind } from './gettingStartedModel';
import type { SessionGettingStartedViewModel } from './gettingStartedModel';
import { buildSessionGettingStartedViewModel } from './gettingStartedModel';
import { Text } from '@/components/ui/text/Text';
import { buildHappierCliInstallCommand } from './happierCliInstallCommand';
import { listSessionGettingStartedCliCommands } from './listSessionGettingStartedCliCommands';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';


export type SessionGettingStartedGuidanceVariant = 'phone' | 'sidebar' | 'primaryPane' | 'newSessionBlocking';

const SESSION_GETTING_STARTED_GUIDANCE_FEATURE_ID = 'app.ui.sessionGettingStartedGuidance' as const satisfies FeatureId;

export type SessionGettingStartedGuidanceViewModel = Readonly<{
    kind: SessionGettingStartedDecisionKind;
    targetLabel: string;
    serverUrl: string;
    serverName: string;
    showServerSetup: boolean;
    onOpenSetup?: () => void;
    onStartNewSession?: () => void;
    onConnectTerminal?: () => void;
    onEnterUrlManually?: () => void;
    connectIsLoading?: boolean;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    scrollContainer: {
        flex: 1,
        width: '100%',
    },
    contentContainer: {
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'flex-start',
        paddingHorizontal: 20,
        paddingTop: 32,
        paddingBottom: 20,
    },
    logo: {
        height: 44,
        width: 44,
        marginBottom: 16,
    },
    title: {
        width: '100%',
        maxWidth: 720,
        gap: 28,
        marginTop: 10,
        fontSize: 20,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    subtitle: {
        width: '100%',
        maxWidth: 720,
        marginBottom: 16,
        fontSize: 14,
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
    primaryCard: {
        width: '100%',
        maxWidth: 720,
        gap: 16,
        marginBottom: 20,
        paddingHorizontal: 18,
        paddingVertical: 18,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surfaceHigh,
    },
    sectionTitle: {
        width: '100%',
        maxWidth: 720,
        marginBottom: 14,
        fontSize: 13,
        color: theme.colors.textSecondary,
        ...Typography.default('semiBold'),
    },
    terminalText: {
        ...Typography.mono(),
        fontSize: 12,
        color: theme.colors.status.connected,
    },
    stepsContainer: {
        width: '100%',
        maxWidth: 720,
        gap: 28,
    },
    stepHeader: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        marginBottom: 10,
    },
    stepTitle: {
        fontSize: 14,
        color: theme.colors.text,
        ...Typography.default('semiBold'),
    },
    stepDescription: {
        marginTop: 2,
        fontSize: 12,
        color: theme.colors.textSecondary,
        ...Typography.default(),
        maxWidth: 560,
    },
    stepTextCol: {
        flex: 1,
        flexBasis: 0,
    },
    codeBlock: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 10,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
    },
    codeText: {
        flex: 1,
        flexBasis: 0,
    },
    codeCopyButton: {
        marginTop: 1,
    },
    buttonsContainer: {
        alignItems: 'center',
        width: '100%',
        marginTop: 20,
        gap: 12,
    },
    buttonWrapper: {
        width: 260,
    },
}));

function titleForKind(kind: SessionGettingStartedDecisionKind): string {
    switch (kind) {
        case 'connect_machine':
            return t('sessionGettingStarted.title.connectMachine');
        case 'start_daemon':
            return t('sessionGettingStarted.title.startDaemon');
        case 'create_session':
            return t('sessionGettingStarted.title.createSession');
        case 'select_session':
            return t('sessionGettingStarted.title.selectSession');
        case 'loading':
        default:
            return t('sessionGettingStarted.title.loading');
    }
}

function subtitleForKind(kind: SessionGettingStartedDecisionKind, targetLabel: string): string {
    switch (kind) {
        case 'connect_machine':
            return t('sessionGettingStarted.subtitle.connectMachine', { targetLabel });
        case 'start_daemon':
            return t('sessionGettingStarted.subtitle.startDaemon', { targetLabel });
        case 'create_session':
            return t('sessionGettingStarted.subtitle.createSession');
        case 'select_session':
            return t('sessionGettingStarted.subtitle.selectSession');
        case 'loading':
        default:
            return t('sessionGettingStarted.subtitle.loading');
    }
}

function resolveAppVariantForCliInstall(): AppVariant {
    return (
        resolveAppVariant({
            appVariant: config.variant,
            updatesReleaseChannel: (Updates as any)?.releaseChannel,
            updatesChannel: (Updates as any)?.channel,
            manifestReleaseChannel: (Constants as any)?.manifest?.releaseChannel,
            expoConfigReleaseChannel: (Constants as any)?.expoConfig?.releaseChannel,
            envAppEnv: process.env.APP_ENV,
            envExpoPublicAppEnv: process.env.EXPO_PUBLIC_APP_ENV,
        }) ?? 'production'
    );
}

function buildCliInstallCommand(): string {
    return buildHappierCliInstallCommand({
        appVariant: resolveAppVariantForCliInstall(),
        distTagOverride: config.cliNpmDistTag,
    });
}

type SessionGettingStartedGuidanceStep = Readonly<{
    id: string;
    title: string;
    description?: string;
    command?: string;
    copyLabel?: string;
}>;

function buildSteps(model: SessionGettingStartedGuidanceViewModel): SessionGettingStartedGuidanceStep[] {
    switch (model.kind) {
        case 'connect_machine': {
            const steps: SessionGettingStartedGuidanceStep[] = [];
            steps.push({
                id: 'install_cli',
                title: t('sessionGettingStarted.steps.installCli.title'),
                description: t('sessionGettingStarted.steps.installCli.description'),
                command: buildCliInstallCommand(),
                copyLabel: t('sessionGettingStarted.steps.installCli.copyLabel'),
            });
            if (model.showServerSetup) {
                steps.push({
                    id: 'server_setup',
                    title: t('sessionGettingStarted.steps.serverSetup.title'),
                    description: t('sessionGettingStarted.steps.serverSetup.description'),
                    command: `happier server add --name \"${model.serverName}\" --server-url \"${model.serverUrl}\" --use`,
                    copyLabel: t('sessionGettingStarted.steps.serverSetup.copyLabel'),
                });
            }
            steps.push({
                id: 'auth_login',
                title: t('sessionGettingStarted.steps.authLogin.title'),
                description: t('sessionGettingStarted.steps.authLogin.description'),
                command: 'happier auth login',
                copyLabel: t('sessionGettingStarted.steps.authLogin.copyLabel'),
            });
            steps.push({
                id: 'daemon_install',
                title: t('sessionGettingStarted.steps.daemonInstall.title'),
                description: t('sessionGettingStarted.steps.daemonInstall.description'),
                command: 'happier daemon install',
                copyLabel: t('sessionGettingStarted.steps.daemonInstall.copyLabel'),
            });
            steps.push({
                id: 'create_session',
                title: t('sessionGettingStarted.steps.createSession.title'),
                description: t('sessionGettingStarted.steps.createSession.description'),
                command: listSessionGettingStartedCliCommands().join('\n'),
                copyLabel: t('sessionGettingStarted.steps.createSession.copyLabel'),
            });
            return steps;
        }
        case 'start_daemon': {
            return [
                {
                    id: 'daemon_install',
                    title: t('sessionGettingStarted.steps.daemonInstall.title'),
                    description: t('sessionGettingStarted.steps.startDaemonInstall.description'),
                    command: 'happier daemon install',
                    copyLabel: t('sessionGettingStarted.steps.daemonInstall.copyLabel'),
                },
                {
                    id: 'daemon_start',
                    title: t('sessionGettingStarted.steps.daemonStart.title'),
                    description: t('sessionGettingStarted.steps.daemonStart.description'),
                    command: 'happier daemon start',
                    copyLabel: t('sessionGettingStarted.steps.daemonStart.copyLabel'),
                },
            ];
        }
        case 'create_session': {
            return [
                {
                    id: 'start_session',
                    title: t('sessionGettingStarted.steps.startSession.title'),
                    description: t('sessionGettingStarted.steps.startSession.description'),
                    command: 'happier',
                    copyLabel: t('sessionGettingStarted.steps.startSession.copyLabel'),
                },
            ];
        }
        case 'select_session':
        case 'loading':
        default: {
            return [];
        }
    }
}

async function copyTextToClipboard(params: Readonly<{ label: string; text: string }>): Promise<void> {
    try {
        await Clipboard.setStringAsync(params.text);
        Modal.alert(t('common.copied'), t('items.copiedToClipboard', { label: params.label }));
    } catch {
        Modal.alert(t('common.error'), t('textSelection.failedToCopy'));
    }
}

export function SessionGettingStartedGuidanceView(props: Readonly<{
    variant: SessionGettingStartedGuidanceVariant;
    model: SessionGettingStartedGuidanceViewModel;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { model } = props;

    const title = titleForKind(model.kind);
    const subtitle = subtitleForKind(model.kind, model.targetLabel);
    const steps = buildSteps(model);
    const showLogo = props.variant === 'primaryPane' || props.variant === 'newSessionBlocking';
    const showSetupPrimaryCard = (model.kind === 'connect_machine' || model.kind === 'start_daemon') && Boolean(model.onOpenSetup);
    const [showManualSteps, setShowManualSteps] = React.useState(!showSetupPrimaryCard);

    React.useEffect(() => {
        setShowManualSteps(!showSetupPrimaryCard);
    }, [model.kind, model.serverUrl, model.targetLabel, showSetupPrimaryCard]);

    const showCliFollowUp = steps.length > 0 && (!showSetupPrimaryCard || showManualSteps);
    const showCliFollowUpTitle = showSetupPrimaryCard && showCliFollowUp;

    return (
        <ScrollView
            testID="session-getting-started-scroll"
            style={styles.scrollContainer}
            contentContainerStyle={styles.contentContainer}
            keyboardShouldPersistTaps="handled"
        >
            <View testID={`session-getting-started-kind-${model.kind}`} style={{ width: 0, height: 0, overflow: 'hidden' }} />

            {showLogo ? (
                <Image
                    testID="session-getting-started-logo"
                    source={theme.dark ? require('@/assets/images/logo-white.png') : require('@/assets/images/logo-black.png')}
                    contentFit="contain"
                    style={styles.logo}
                />
            ) : null}

            {showSetupPrimaryCard ? (
                <View testID="session-getting-started-setup-primary-card" style={styles.primaryCard}>
                    <Text style={styles.title}>{title}</Text>
                    <Text style={styles.subtitle}>{subtitle}</Text>
                    <View style={styles.buttonWrapper}>
                        <RoundButton
                            testID="session-getting-started-open-setup"
                            title={t('setupOnboarding.openSetupAction')}
                            onPress={model.onOpenSetup}
                            size="normal"
                        />
                    </View>
                    {steps.length > 0 ? (
                        <View style={styles.buttonWrapper}>
                            <RoundButton
                                testID="session-getting-started-show-manual"
                                title={showManualSteps
                                    ? t('sessionGettingStarted.manualDisclosure.hide')
                                    : t('sessionGettingStarted.manualDisclosure.show')}
                                onPress={() => {
                                    setShowManualSteps((current) => !current);
                                }}
                                size="normal"
                                display="inverted"
                            />
                        </View>
                    ) : null}
                </View>
            ) : (
                <>
                    <Text style={styles.title}>{title}</Text>
                    <Text style={styles.subtitle}>{subtitle}</Text>
                </>
            )}

            {showCliFollowUp ? (
                <View testID="session-getting-started-cli-follow-up" style={styles.stepsContainer}>
                    {showCliFollowUpTitle ? (
                        <Text style={styles.sectionTitle}>{t('sessionGettingStarted.cliFollowUpTitle')}</Text>
                    ) : null}
                    {steps.map((step) => (
                        <View key={step.id} testID={`session-getting-started-step-${step.id}`}>
                            <View style={styles.stepHeader}>
                                <View style={styles.stepTextCol}>
                                    <Text style={styles.stepTitle}>{step.title}</Text>
                                    {step.description ? <Text style={styles.stepDescription}>{step.description}</Text> : null}
                                </View>
                            </View>
                            {step.command ? (
                                <View style={styles.codeBlock}>
                                    <Text style={[styles.terminalText, styles.codeText]}>{step.command}</Text>
                                      <Pressable
                                          testID={`session-getting-started-copy-${step.id}`}
                                          accessibilityRole="button"
                                          accessibilityLabel={t('common.copyWithLabel', { label: step.copyLabel ?? t('common.command') })}
                                          style={styles.codeCopyButton}
                                          onPress={() => copyTextToClipboard({ label: step.copyLabel ?? t('common.command'), text: step.command ?? '' })}
                                      >
                                          {normalizeNodeForView(
                                              <Ionicons name="copy-outline" size={16} color={theme.colors.textSecondary} />,
                                          )}
                                      </Pressable>
                                </View>
                            ) : null}
                        </View>
                    ))}
                </View>
            ) : null}

            <View style={styles.buttonsContainer}>
                {model.kind === 'create_session' && model.onStartNewSession ? (
                    <View style={styles.buttonWrapper}>
                        <RoundButton
                            testID="session-getting-started-start-new-session"
                            title={t('components.emptySessionsTablet.startNewSessionButton')}
                            onPress={model.onStartNewSession}
                            size="normal"
                        />
                    </View>
                ) : null}

                {props.variant === 'phone' && Platform.OS !== 'web' && model.onConnectTerminal ? (
                    <View style={styles.buttonWrapper}>
                        <RoundButton
                            title={t('components.emptyMainScreen.openCamera')}
                            onPress={model.onConnectTerminal}
                            loading={Boolean(model.connectIsLoading)}
                            size="normal"
                        />
                    </View>
                ) : null}

                {props.variant === 'phone' && model.onEnterUrlManually ? (
                    <View style={styles.buttonWrapper}>
                        <RoundButton
                            title={t('connect.enterUrlManually')}
                            onPress={model.onEnterUrlManually}
                            loading={Boolean(model.connectIsLoading)}
                            size="normal"
                            display={Platform.OS === 'web' ? undefined : 'inverted'}
                        />
                    </View>
                ) : null}
            </View>
        </ScrollView>
    );
}

export function useSessionGettingStartedGuidanceBaseModel(): SessionGettingStartedViewModel {
    const sessions = useVisibleSessionListViewData();
    const selection = useResolvedActiveServerSelection();
    const serverSelectionGroups = useSetting('serverSelectionGroups');
    const machineListByServerId = useMachineListByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();

    return React.useMemo(() => {
        return buildSessionGettingStartedViewModel({
            sessions,
            selection,
            serverSelectionGroups,
            serverProfiles: listServerProfiles().map((p) => ({ id: p.id, name: p.name, serverUrl: p.serverUrl })),
            machineListByServerId,
            machineListStatusByServerId,
        });
    }, [machineListByServerId, machineListStatusByServerId, selection, serverSelectionGroups, sessions]);
}

function SessionGettingStartedGuidanceEnabled(props: Readonly<{ variant: SessionGettingStartedGuidanceVariant }>): React.ReactElement {
    const router = useRouter();
    const baseModel = useSessionGettingStartedGuidanceBaseModel();
    const canOpenSetup = isTauriDesktop();
    const onOpenSetup = React.useCallback(() => {
        router.push('/setup' as any);
    }, [router]);

    const onStartNewSession = React.useCallback(() => {
        router.push('/new' as any);
    }, [router]);

    const { connectTerminal, connectWithUrl, isLoading } = useConnectTerminal();

    const onEnterUrlManually = React.useCallback(async () => {
        const url = await Modal.prompt(
            t('modals.authenticateTerminal'),
            t('modals.pasteUrlFromTerminal'),
            {
                placeholder: t('connect.terminalUrlPlaceholder'),
                cancelText: t('common.cancel'),
                confirmText: t('common.authenticate'),
            },
        );
        if (url?.trim()) {
            connectWithUrl(url.trim());
        }
    }, [connectWithUrl]);

    const viewModel: SessionGettingStartedGuidanceViewModel = {
        kind: baseModel.kind,
        targetLabel: baseModel.targetLabel,
        serverUrl: baseModel.serverUrl,
        serverName: baseModel.serverName,
        showServerSetup: baseModel.showServerSetup,
        ...((baseModel.kind === 'connect_machine' || baseModel.kind === 'start_daemon') && canOpenSetup ? { onOpenSetup } : {}),
        ...(baseModel.kind === 'create_session' || baseModel.kind === 'select_session' ? { onStartNewSession } : {}),
        ...(props.variant === 'phone'
            ? {
                onConnectTerminal: connectTerminal,
                onEnterUrlManually,
                connectIsLoading: isLoading,
            }
            : {}),
    };

    return <SessionGettingStartedGuidanceView variant={props.variant} model={viewModel} />;
}

export function SessionGettingStartedGuidance(props: Readonly<{ variant: SessionGettingStartedGuidanceVariant }>): React.ReactElement | null {
    if (getFeatureBuildPolicyDecision(SESSION_GETTING_STARTED_GUIDANCE_FEATURE_ID) === 'deny') {
        return null;
    }
    return <SessionGettingStartedGuidanceEnabled variant={props.variant} />;
}
