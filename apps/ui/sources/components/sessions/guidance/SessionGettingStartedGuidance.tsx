import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';
import { router } from 'expo-router';
import { Modal } from '@/modal';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { useConnectTerminal } from '@/hooks/session/useConnectTerminal';
import type { FeatureId } from '@happier-dev/protocol';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { config } from '@/config';
import { resolveAppVariant, type AppVariant } from '@/sync/runtime/appVariant';
import { resolveCliInvokerNameForCurrentApp, resolvePreferredPublicReleaseRingIdForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';
import { buildMachineSetupWizardHref } from '@/utils/routes/setupWizardHref';

import type { SessionGettingStartedDecisionKind } from './gettingStartedModel';
import { Text } from '@/components/ui/text/Text';
import { buildHappierCliInstallCommand } from './happierCliInstallCommand';
import { listSessionGettingStartedCliCommands } from './listSessionGettingStartedCliCommands';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { getSessionGettingStartedSubtitle, getSessionGettingStartedTitle } from './sessionGettingStartedText';
import { SessionGettingStartedSummary } from './SessionGettingStartedSummary';
import { useSessionGettingStartedGuidanceBaseModel } from './useSessionGettingStartedGuidanceBaseModel';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';


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

type SessionGettingStartedGuidanceViewProps = Readonly<{
    variant: SessionGettingStartedGuidanceVariant;
    model: SessionGettingStartedGuidanceViewModel;
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
    contentContainerCentered: {
        justifyContent: 'center',
        paddingTop: 20,
        paddingBottom: 32,
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
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
        textAlign: 'center',
    },
    subtitle: {
        width: '100%',
        maxWidth: 720,
        marginBottom: 16,
        fontSize: 14,
        color: theme.colors.text.secondary,
        ...Typography.default(),
        textAlign: 'center',
    },
    primaryCard: {
        width: '100%',
        maxWidth: 720,
        gap: 16,
        marginBottom: 20,
        paddingHorizontal: 12,
        paddingVertical: 12,
        alignItems: 'center',
    },
    sectionTitle: {
        width: '100%',
        maxWidth: 720,
        marginBottom: 14,
        fontSize: 13,
        color: theme.colors.text.secondary,
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
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    stepDescription: {
        marginTop: 2,
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
        maxWidth: 560,
    },
    stepTextCol: {
        flex: 1,
        flexBasis: 0,
    },
    codeBlock: {
        backgroundColor: theme.colors.surface.elevated,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingTop: 10,
        paddingBottom: 10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
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
        publicReleaseRingOverride: resolvePreferredPublicReleaseRingIdForCurrentApp(),
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
    const invoker = resolveCliInvokerNameForCurrentApp();
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
                    command: `${invoker} server add --name \"${model.serverName}\" --server-url \"${model.serverUrl}\" --use`,
                    copyLabel: t('sessionGettingStarted.steps.serverSetup.copyLabel'),
                });
            }
            steps.push({
                id: 'auth_login',
                title: t('sessionGettingStarted.steps.authLogin.title'),
                description: t('sessionGettingStarted.steps.authLogin.description'),
                command: `${invoker} auth login`,
                copyLabel: t('sessionGettingStarted.steps.authLogin.copyLabel'),
            });
            steps.push({
                id: 'daemon_install',
                title: t('sessionGettingStarted.steps.daemonInstall.title'),
                description: t('sessionGettingStarted.steps.daemonInstall.description'),
                command: `${invoker} service install`,
                copyLabel: t('sessionGettingStarted.steps.daemonInstall.copyLabel'),
            });
            steps.push({
                id: 'create_session',
                title: t('sessionGettingStarted.steps.createSession.title'),
                description: t('sessionGettingStarted.steps.createSession.description'),
                command: listSessionGettingStartedCliCommands(invoker).join('\n'),
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
                    command: `${invoker} service install`,
                    copyLabel: t('sessionGettingStarted.steps.daemonInstall.copyLabel'),
                },
                {
                    id: 'daemon_start',
                    title: t('sessionGettingStarted.steps.daemonStart.title'),
                    description: t('sessionGettingStarted.steps.daemonStart.description'),
                    command: `${invoker} service start`,
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
                    command: invoker,
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

async function copyTextToClipboard(text: string): Promise<boolean> {
    const copied = await setClipboardStringSafe(text);
    if (!copied) {
        Modal.alert(t('common.error'), t('textSelection.failedToCopy'));
    }
    return copied;
}

function SessionGettingStartedGuidanceViewImpl(props: SessionGettingStartedGuidanceViewProps): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { model } = props;
    const copyFeedback = useTemporaryCopyFeedback();

    const title = getSessionGettingStartedTitle(model.kind);
    const subtitle = getSessionGettingStartedSubtitle(model.kind, model.targetLabel);
    const showSummaryOnly = model.kind === 'create_session' || model.kind === 'select_session';
    const showLogo = (props.variant === 'primaryPane' || props.variant === 'newSessionBlocking')
        && model.kind !== 'create_session'
        && model.kind !== 'select_session';
    const showSetupPrimaryCard = model.kind === 'connect_machine' || model.kind === 'start_daemon';
    const shouldBuildCliFollowUpSteps = !showSetupPrimaryCard && !showSummaryOnly;
    const steps = React.useMemo(() => (
        shouldBuildCliFollowUpSteps ? buildSteps(model) : []
    ), [
        model.kind,
        model.serverName,
        model.serverUrl,
        model.showServerSetup,
        shouldBuildCliFollowUpSteps,
    ]);
    const showCliFollowUp = steps.length > 0 && shouldBuildCliFollowUpSteps;
    const showCliFollowUpTitle = false;
    const handleOpenSetup = React.useCallback(() => {
        if (model.onOpenSetup) {
            model.onOpenSetup();
            return;
        }
        router.push(buildMachineSetupWizardHref({ action: 'local', step: 'setup_this_computer' }) as any);
    }, [model.onOpenSetup]);

    return (
        <ScrollView
            testID="session-getting-started-scroll"
            style={styles.scrollContainer}
            contentContainerStyle={[
                styles.contentContainer,
                props.variant === 'primaryPane' && showSummaryOnly ? styles.contentContainerCentered : null,
            ]}
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
                            onPress={handleOpenSetup}
                            size="normal"
                        />
                    </View>
                </View>
            ) : (
                showSummaryOnly ? (
                    <SessionGettingStartedSummary
                        testID="session-getting-started-summary"
                        titleTestID="session-getting-started-summary-title"
                        descriptionTestID="session-getting-started-summary-description"
                        kind={model.kind}
                        targetLabel={model.targetLabel}
                        surface={props.variant === 'primaryPane' ? 'primaryPane' : 'default'}
                    />
                ) : (
                    <>
                        <Text style={styles.title}>{title}</Text>
                        <Text style={styles.subtitle}>{subtitle}</Text>
                    </>
                )
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
                                          onPress={async () => {
                                              if (await copyTextToClipboard(step.command ?? '')) {
                                                  copyFeedback.markCopied(step.id);
                                              }
                                          }}
                                      >
                                          {normalizeNodeForView(
                                              <Ionicons name="copy-outline" size={16} color={theme.colors.text.secondary} />,
                                          )}
                                      </Pressable>
                                      <CopiedPill
                                          visible={copyFeedback.isCopied(step.id)}
                                          testID={`session-getting-started-copy-feedback-${step.id}`}
                                      />
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

                {model.kind !== 'connect_machine' && props.variant === 'phone' && Platform.OS !== 'web' && model.onConnectTerminal ? (
                    <View style={styles.buttonWrapper}>
                        <RoundButton
                            title={t('components.emptyMainScreen.openCamera')}
                            onPress={model.onConnectTerminal}
                            loading={Boolean(model.connectIsLoading)}
                            size="normal"
                        />
                    </View>
                ) : null}

                {model.kind !== 'connect_machine' && props.variant === 'phone' && model.onEnterUrlManually ? (
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

function areSessionGettingStartedGuidanceViewModelsEqual(
    previous: SessionGettingStartedGuidanceViewModel,
    next: SessionGettingStartedGuidanceViewModel,
): boolean {
    return previous.kind === next.kind
        && previous.targetLabel === next.targetLabel
        && previous.serverUrl === next.serverUrl
        && previous.serverName === next.serverName
        && previous.showServerSetup === next.showServerSetup
        && previous.onOpenSetup === next.onOpenSetup
        && previous.onStartNewSession === next.onStartNewSession
        && previous.onConnectTerminal === next.onConnectTerminal
        && previous.onEnterUrlManually === next.onEnterUrlManually
        && previous.connectIsLoading === next.connectIsLoading;
}

function areSessionGettingStartedGuidanceViewPropsEqual(
    previous: SessionGettingStartedGuidanceViewProps,
    next: SessionGettingStartedGuidanceViewProps,
): boolean {
    return previous.variant === next.variant
        && areSessionGettingStartedGuidanceViewModelsEqual(previous.model, next.model);
}

export const SessionGettingStartedGuidanceView = React.memo(
    SessionGettingStartedGuidanceViewImpl,
    areSessionGettingStartedGuidanceViewPropsEqual,
);
SessionGettingStartedGuidanceView.displayName = 'SessionGettingStartedGuidanceView';

function useSessionGettingStartedGuidanceViewModelBase(
    options: Readonly<{ ignoreConnectMachineDismissal?: boolean }> = {},
): SessionGettingStartedGuidanceViewModel | null {
    const baseModel = useSessionGettingStartedGuidanceBaseModel();
    const dismissed = useLocalSetting('sessionGettingStartedGuidanceDismissed') === true;
    const ignoreConnectMachineDismissal = options.ignoreConnectMachineDismissal === true;
    const onOpenSetup = React.useCallback(() => {
        router.push(buildMachineSetupWizardHref({ action: 'local', step: 'setup_this_computer' }) as any);
    }, []);

    const onStartNewSession = React.useCallback(() => {
        router.push('/new' as any);
    }, []);

    return React.useMemo(() => {
        if (dismissed && baseModel.kind === 'connect_machine' && !ignoreConnectMachineDismissal) {
            return null;
        }

        return {
            kind: baseModel.kind,
            targetLabel: baseModel.targetLabel,
            serverUrl: baseModel.serverUrl,
            serverName: baseModel.serverName,
            showServerSetup: baseModel.showServerSetup,
            ...((baseModel.kind === 'connect_machine' || baseModel.kind === 'start_daemon') ? { onOpenSetup } : {}),
            ...(baseModel.kind === 'create_session' || baseModel.kind === 'select_session' ? { onStartNewSession } : {}),
        };
    }, [
        baseModel.kind,
        baseModel.serverName,
        baseModel.serverUrl,
        baseModel.showServerSetup,
        baseModel.targetLabel,
        dismissed,
        ignoreConnectMachineDismissal,
        onOpenSetup,
        onStartNewSession,
    ]);
}

function SessionGettingStartedPhoneGuidanceEnabled(): React.ReactElement | null {
    const baseViewModel = useSessionGettingStartedGuidanceViewModelBase();
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

    const viewModel = React.useMemo<SessionGettingStartedGuidanceViewModel | null>(() => (
        baseViewModel
            ? {
                ...baseViewModel,
                onConnectTerminal: connectTerminal,
                onEnterUrlManually,
                connectIsLoading: isLoading,
            }
            : null
    ), [baseViewModel, connectTerminal, isLoading, onEnterUrlManually]);

    if (!viewModel) return null;
    return <SessionGettingStartedGuidanceView variant="phone" model={viewModel} />;
}

function SessionGettingStartedGuidanceEnabled(
    props: Readonly<{ variant: Exclude<SessionGettingStartedGuidanceVariant, 'phone'> }>,
): React.ReactElement | null {
    const viewModel = useSessionGettingStartedGuidanceViewModelBase({
        ignoreConnectMachineDismissal: props.variant === 'newSessionBlocking',
    });

    if (!viewModel) return null;
    return <SessionGettingStartedGuidanceView variant={props.variant} model={viewModel} />;
}

export function SessionGettingStartedGuidance(props: Readonly<{ variant: SessionGettingStartedGuidanceVariant }>): React.ReactElement | null {
    if (getFeatureBuildPolicyDecision(SESSION_GETTING_STARTED_GUIDANCE_FEATURE_ID) === 'deny') {
        return null;
    }
    if (props.variant === 'phone') {
        return <SessionGettingStartedPhoneGuidanceEnabled />;
    }
    return <SessionGettingStartedGuidanceEnabled variant={props.variant} />;
}
