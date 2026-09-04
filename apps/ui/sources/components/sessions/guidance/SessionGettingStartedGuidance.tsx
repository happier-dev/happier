import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CenteredInfoTile } from '@/components/ui/lists/CenteredInfoTile';
import { t } from '@/text';
import { router } from 'expo-router';
import { Modal } from '@/modal';
import { Image } from 'expo-image';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useVisibleSessionListSessionSummary } from '@/hooks/session/useVisibleSessionListViewData';
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
import { buildSessionGettingStartedViewModel, computeMachinesSummaryForServerIds } from './gettingStartedModel';
import { Text } from '@/components/ui/text/Text';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { useTemporaryCopyFeedback } from '@/components/ui/copy/useTemporaryCopyFeedback';
import { buildHappierCliCommandName, buildHappierCliInstallCommand } from './happierCliInstallCommand';
import { listSessionGettingStartedCliCommands } from './listSessionGettingStartedCliCommands';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { runAfterInteractionsWithFallback } from '@/utils/timing/runAfterInteractionsWithFallback';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { Icon } from '@/components/ui/icons/Icon';
import {
    shouldForceFreshNewSessionEntryFromPressEvent,
    useResolveNewSessionOrdinaryEntryRoute,
} from '@/components/sessions/new/navigation/newSessionOrdinaryEntryRoute';

export type SessionGettingStartedGuidanceVariant = 'phone' | 'sidebar' | 'primaryPane' | 'newSessionBlocking';

const SESSION_GETTING_STARTED_GUIDANCE_FEATURE_ID = 'app.ui.sessionGettingStartedGuidance' as const satisfies FeatureId;
const DEFER_CLI_FOLLOW_UP_VARIANTS = new Set<SessionGettingStartedGuidanceVariant>(['phone', 'newSessionBlocking']);

type DeferredCliFollowUpState = Readonly<{
    key: string;
    ready: boolean;
}>;

export type SessionGettingStartedGuidanceViewModel = Readonly<{
    kind: SessionGettingStartedDecisionKind;
    targetLabel: string;
    serverUrl: string;
    serverName: string;
    showServerSetup: boolean;
    onOpenSetup?: () => void;
    onStartNewSession?: (event?: unknown) => void;
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
    },
    subtitle: {
        width: '100%',
        maxWidth: 720,
        marginBottom: 16,
        fontSize: 14,
        color: theme.colors.text.secondary,
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
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
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
    sidebarStartButton: {
        backgroundColor: theme.colors.button.primary.background,
    },
    sidebarStartButtonText: {
        color: theme.colors.button.primary.tint,
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

function buildCliInstallCommand(options?: Readonly<{ suppressAutomaticSetup?: boolean }>): string {
    return buildHappierCliInstallCommand({
        appVariant: resolveAppVariantForCliInstall(),
        distTagOverride: config.cliNpmDistTag,
        suppressAutomaticSetup: options?.suppressAutomaticSetup,
    });
}

function buildCliCommandName(): 'happier' | 'hprev' {
    return buildHappierCliCommandName({
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

function buildDeferredCliFollowUpKey(params: Readonly<{
    variant: SessionGettingStartedGuidanceVariant;
    model: SessionGettingStartedGuidanceViewModel;
    showSetupPrimaryCard: boolean;
}>): string {
    return [
        params.variant,
        params.model.kind,
        params.model.serverUrl,
        params.model.serverName,
        params.model.targetLabel,
        params.model.showServerSetup ? 'server-setup' : 'no-server-setup',
        params.showSetupPrimaryCard ? 'setup-card' : 'manual-only',
    ].join('\n');
}

function buildSteps(model: SessionGettingStartedGuidanceViewModel): SessionGettingStartedGuidanceStep[] {
    switch (model.kind) {
        case 'connect_machine': {
            const steps: SessionGettingStartedGuidanceStep[] = [];
            const cliCommandName = buildCliCommandName();
            steps.push({
                id: 'install_cli',
                title: t('sessionGettingStarted.steps.installCli.title'),
                description: t('sessionGettingStarted.steps.installCli.description'),
                // This card already knows which relay the user is connecting.
                // Suppress the installer's generic automatic handoff, then let
                // the one target-bound setup command own relay selection,
                // authentication, and service reconciliation.
                command: buildCliInstallCommand({ suppressAutomaticSetup: true }),
                copyLabel: t('sessionGettingStarted.steps.installCli.copyLabel'),
            });
            steps.push({
                id: 'auth_login',
                title: t('sessionGettingStarted.steps.authLogin.title'),
                description: t('sessionGettingStarted.steps.authLogin.description'),
                command: model.showServerSetup
                    ? `${cliCommandName} setup --relay \"${model.serverUrl}\"`
                    : `${cliCommandName} setup`,
                copyLabel: t('sessionGettingStarted.steps.authLogin.copyLabel'),
            });
            steps.push({
                id: 'create_session',
                title: t('sessionGettingStarted.steps.createSession.title'),
                description: t('sessionGettingStarted.steps.createSession.description'),
                command: listSessionGettingStartedCliCommands(cliCommandName).join('\n'),
                copyLabel: t('sessionGettingStarted.steps.createSession.copyLabel'),
            });
            return steps;
        }
        case 'start_daemon': {
            const cliCommandName = buildCliCommandName();
            return [
                {
                    id: 'daemon_install',
                    title: t('sessionGettingStarted.steps.daemonInstall.title'),
                    description: t('sessionGettingStarted.steps.startDaemonInstall.description'),
                    command: `${cliCommandName} service install`,
                    copyLabel: t('sessionGettingStarted.steps.daemonInstall.copyLabel'),
                },
                {
                    id: 'daemon_start',
                    title: t('sessionGettingStarted.steps.daemonStart.title'),
                    description: t('sessionGettingStarted.steps.daemonStart.description'),
                    command: `${cliCommandName} service start`,
                    copyLabel: t('sessionGettingStarted.steps.daemonStart.copyLabel'),
                },
            ];
        }
        case 'create_session': {
            const cliCommandName = buildCliCommandName();
            return [
                {
                    id: 'start_session',
                    title: t('sessionGettingStarted.steps.startSession.title'),
                    description: t('sessionGettingStarted.steps.startSession.description'),
                    command: cliCommandName,
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

function SessionGettingStartedGuidanceViewImpl(props: SessionGettingStartedGuidanceViewProps): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { model } = props;
    const copyFeedback = useTemporaryCopyFeedback();

    const title = titleForKind(model.kind);
    const subtitle = subtitleForKind(model.kind, model.targetLabel);
    const steps = React.useMemo(() => buildSteps(model), [
        model.kind,
        model.serverName,
        model.serverUrl,
        model.showServerSetup,
    ]);
    const showLogo = props.variant === 'primaryPane' || props.variant === 'newSessionBlocking';
    const showSetupPrimaryCard = (model.kind === 'connect_machine' || model.kind === 'start_daemon') && Boolean(model.onOpenSetup);
    const [showManualSteps, setShowManualSteps] = React.useState(!showSetupPrimaryCard);
    const shouldCenterContent = props.variant === 'primaryPane' && model.kind === 'select_session';
    const shouldDeferCliFollowUp = DEFER_CLI_FOLLOW_UP_VARIANTS.has(props.variant) && !showSetupPrimaryCard;
    const deferredCliFollowUpKey = buildDeferredCliFollowUpKey({ variant: props.variant, model, showSetupPrimaryCard });
    const [deferredCliFollowUpState, setDeferredCliFollowUpState] = React.useState<DeferredCliFollowUpState>(() => ({
        key: deferredCliFollowUpKey,
        ready: !shouldDeferCliFollowUp,
    }));
    const isDeferredCliFollowUpReady = !shouldDeferCliFollowUp
        || (deferredCliFollowUpState.key === deferredCliFollowUpKey && deferredCliFollowUpState.ready);

    React.useEffect(() => {
        setShowManualSteps(!showSetupPrimaryCard);
    }, [model.kind, model.serverUrl, model.targetLabel, showSetupPrimaryCard]);

    React.useEffect(() => {
        if (!shouldDeferCliFollowUp) {
            setDeferredCliFollowUpState((current) => (
                current.key === deferredCliFollowUpKey && current.ready
                    ? current
                    : { key: deferredCliFollowUpKey, ready: true }
            ));
            return;
        }

        setDeferredCliFollowUpState((current) => (
            current.key === deferredCliFollowUpKey && !current.ready
                ? current
                : { key: deferredCliFollowUpKey, ready: false }
        ));

        return runAfterInteractionsWithFallback(() => {
            setDeferredCliFollowUpState((current) => (
                current.key === deferredCliFollowUpKey && current.ready
                    ? current
                    : { key: deferredCliFollowUpKey, ready: true }
            ));
        });
    }, [deferredCliFollowUpKey, shouldDeferCliFollowUp]);

    const showCliFollowUp = steps.length > 0 && (!showSetupPrimaryCard || showManualSteps) && isDeferredCliFollowUpReady;
    const showCliFollowUpTitle = showSetupPrimaryCard && showCliFollowUp;
    const copyStepCommand = React.useCallback(async (params: Readonly<{ id: string; text: string }>) => {
        const copied = await setClipboardStringSafe(params.text);
        if (copied) {
            copyFeedback.markCopied(params.id);
            return;
        }
        Modal.alert(t('common.error'), t('textSelection.failedToCopy'));
    }, [copyFeedback]);

    return (
        <ScrollView
            testID="session-getting-started-scroll"
            style={styles.scrollContainer}
            contentContainerStyle={[
                styles.contentContainer,
                shouldCenterContent ? styles.contentContainerCentered : null,
            ]}
            keyboardShouldPersistTaps="handled"
        >
            <View testID={`session-getting-started-kind-${model.kind}`} style={{ width: 0, height: 0, overflow: 'hidden' }} />

            {model.kind === 'select_session' ? (
                <CenteredInfoTile
                    testID="session-empty-state-summary"
                    titleTestID="session-empty-state-title"
                    descriptionTestID="session-empty-state-description"
                    title={title}
                    description={subtitle}
                    icon={(
                        <Icon
                            testID="session-empty-state-icon"
                            name="chats-circle"
                            size={48}
                            color={theme.colors.text.secondary}
                            style={{ marginBottom: 12 }}
                        />
                    )}
                />
            ) : null}

            {showLogo && model.kind !== 'select_session' ? (
                <Image
                    testID="session-getting-started-logo"
                    source={theme.dark ? require('@/assets/images/logo-white.png') : require('@/assets/images/logo-black.png')}
                    contentFit="contain"
                    style={styles.logo}
                />
            ) : null}

            {model.kind !== 'select_session' && showSetupPrimaryCard ? (
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
            ) : model.kind !== 'select_session' ? (
                <>
                    <Text style={styles.title}>{title}</Text>
                    <Text style={styles.subtitle}>{subtitle}</Text>
                </>
            ) : null}

            {model.kind !== 'select_session' && showCliFollowUp ? (
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
                                          onPress={() => {
                                              void copyStepCommand({ id: step.id, text: step.command ?? '' });
                                          }}
                                      >
                                          {copyFeedback.isCopied(step.id) ? (
                                              <CopiedPill
                                                  visible
                                                  testID={`session-getting-started-copy-${step.id}-copied`}
                                              />
                                          ) : normalizeNodeForView(
                                              <Icon name="copy" size={16} color={theme.colors.text.secondary} />,
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
                            style={props.variant === 'sidebar' ? styles.sidebarStartButton : undefined}
                            textStyle={props.variant === 'sidebar' ? styles.sidebarStartButtonText : undefined}
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

export function useSessionGettingStartedGuidanceBaseModel(): SessionGettingStartedViewModel {
    const sessionSummary = useVisibleSessionListSessionSummary();
    const selection = useResolvedActiveServerSelection();
    const serverSelectionGroups = useSetting('serverSelectionGroups');
    const machineListByServerId = useMachineListByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();

    return React.useMemo(() => {
        return buildSessionGettingStartedViewModel({
            sessionsReady: sessionSummary.sessionsReady,
            sessionCount: sessionSummary.visibleSessionCount,
            selection,
            serverSelectionGroups,
            serverProfiles: listServerProfiles().map((p) => ({ id: p.id, name: p.name, serverUrl: p.serverUrl })),
            machineListByServerId,
            machineListStatusByServerId,
        });
    }, [machineListByServerId, machineListStatusByServerId, selection, serverSelectionGroups, sessionSummary]);
}

export function useShouldBlockNewSessionWithGettingStartedGuidance(): boolean {
    const selection = useResolvedActiveServerSelection();
    const machineListByServerId = useMachineListByServerId();

    return React.useMemo(() => {
        const machines = computeMachinesSummaryForServerIds({
            allowedServerIds: selection.allowedServerIds,
            machineListByServerId,
        });

        return machines.machineCount === 0 && !machines.hasUnknownServers;
    }, [machineListByServerId, selection.allowedServerIds]);
}

function useSessionGettingStartedGuidanceViewModelBase(): SessionGettingStartedGuidanceViewModel {
    const baseModel = useSessionGettingStartedGuidanceBaseModel();
    const resolveNewSessionOrdinaryEntryRoute = useResolveNewSessionOrdinaryEntryRoute();
    const canOpenSetup = isTauriDesktop();
    const onOpenSetup = React.useCallback(() => {
        router.push('/setup' as any);
    }, []);

    const onStartNewSession = React.useCallback((event?: unknown) => {
        const { draftId, draftOrigin } = resolveNewSessionOrdinaryEntryRoute({
            forceFresh: shouldForceFreshNewSessionEntryFromPressEvent(event),
        });
        router.push({ pathname: '/new', params: { draftId, draftOrigin } });
    }, [resolveNewSessionOrdinaryEntryRoute]);

    return React.useMemo(() => ({
        kind: baseModel.kind,
        targetLabel: baseModel.targetLabel,
        serverUrl: baseModel.serverUrl,
        serverName: baseModel.serverName,
        showServerSetup: baseModel.showServerSetup,
        ...((baseModel.kind === 'connect_machine' || baseModel.kind === 'start_daemon') && canOpenSetup ? { onOpenSetup } : {}),
        ...(baseModel.kind === 'create_session' || baseModel.kind === 'select_session' ? { onStartNewSession } : {}),
    }), [
        baseModel.kind,
        baseModel.serverName,
        baseModel.serverUrl,
        baseModel.showServerSetup,
        baseModel.targetLabel,
        canOpenSetup,
        onOpenSetup,
        onStartNewSession,
    ]);
}

function SessionGettingStartedPhoneGuidanceEnabled(): React.ReactElement {
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

    const viewModel = React.useMemo<SessionGettingStartedGuidanceViewModel>(() => ({
        ...baseViewModel,
        onConnectTerminal: connectTerminal,
        onEnterUrlManually,
        connectIsLoading: isLoading,
    }), [baseViewModel, connectTerminal, isLoading, onEnterUrlManually]);

    return <SessionGettingStartedGuidanceView variant="phone" model={viewModel} />;
}

function SessionGettingStartedGuidanceEnabled(
    props: Readonly<{ variant: Exclude<SessionGettingStartedGuidanceVariant, 'phone'> }>,
): React.ReactElement {
    const viewModel = useSessionGettingStartedGuidanceViewModelBase();

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
