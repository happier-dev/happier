import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';
import { useDestinationRouter } from '@/components/appShell/workspace/DestinationInstanceHost';
import { Modal } from '@/modal';
import { Image } from 'expo-image';
import { useConnectTerminal } from '@/hooks/session/useConnectTerminal';
import type { FeatureId } from '@happier-dev/protocol';
import { getFeatureBuildPolicyDecision } from '@/sync/domains/features/featureBuildPolicy';
import { resolveCliInvokerNameForCurrentApp } from '@/sync/runtime/resolvePublicReleaseRing';
import { buildMachineAddHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { useLocalDaemonControl } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { presentThisComputerConnection } from '@/components/settings/machines/localControl/thisComputerConnectionPresentation';
import {
    useAppAccountIdentity,
    useThisComputerConnection,
} from '@/components/settings/machines/localControl/useThisComputerConnection';
import { resolveViewerAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';

import type { SessionGettingStartedDecisionKind } from './gettingStartedModel';
import { Text } from '@/components/ui/text/Text';
import { HomeReachabilityGate } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { listSessionGettingStartedCliCommands } from './listSessionGettingStartedCliCommands';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { getSessionGettingStartedSubtitle, getSessionGettingStartedTitle } from './sessionGettingStartedText';
import { SessionGettingStartedSummary } from './SessionGettingStartedSummary';
import { useSessionGettingStartedGuidanceBaseModel } from './useSessionGettingStartedGuidanceBaseModel';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { HAPPIER_PAGE_METRICS, useHappierCopyFeedback } from '@happier-dev/plugin-ui/presentation';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';
import { Icon } from '@/components/ui/icons/Icon';
import {
    shouldForceFreshNewSessionEntryFromPressEvent,
    useResolveNewSessionOrdinaryEntryRoute,
} from '@/components/sessions/new/navigation/newSessionOrdinaryEntryRoute';


export type SessionGettingStartedGuidanceVariant = 'phone' | 'sidebar' | 'primaryPane';

const SESSION_GETTING_STARTED_GUIDANCE_FEATURE_ID = 'app.ui.sessionGettingStartedGuidance' as const satisfies FeatureId;

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
    /** What the host adds beneath the setup card, in the same column (Home's own setup asks). */
    accessory?: React.ReactNode;
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
        paddingHorizontal: theme.space.s20,
        paddingTop: theme.space.s32,
        paddingBottom: theme.space.s20,
    },
    contentContainerCentered: {
        justifyContent: 'center',
        paddingTop: theme.space.s20,
        paddingBottom: theme.space.s32,
    },
    logo: {
        height: 44,
        width: 44,
        marginBottom: theme.space.s16,
    },
    title: {
        width: '100%',
        maxWidth: 720,
        gap: 28,
        marginTop: theme.space.s10,
        ...Typography.variant('title'),
        color: theme.colors.text.primary,
        textAlign: 'center',
    },
    subtitle: {
        width: '100%',
        maxWidth: 720,
        marginBottom: theme.space.s16,
        fontSize: 14,
        color: theme.colors.text.secondary,
        ...Typography.default(),
        textAlign: 'center',
    },
    // A compact measure under the card: the asks read as quiet notes, not a second card as wide as the page.
    accessory: {
        width: '100%',
        maxWidth: HAPPIER_PAGE_METRICS.dialogWidthPx.default,
        marginTop: theme.space.s12,
    },
    primaryCard: {
        width: '100%',
        maxWidth: 720,
        gap: theme.space.s16,
        marginBottom: theme.space.s20,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s12,
        alignItems: 'center',
    },
    sectionTitle: {
        width: '100%',
        maxWidth: 720,
        marginBottom: 14,
        ...Typography.variant('body', 'semiBold'),
        color: theme.colors.text.secondary,
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
        gap: theme.space.s12,
        marginBottom: theme.space.s10,
    },
    stepTitle: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
    stepDescription: {
        marginTop: theme.space.s2,
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
        maxWidth: 560,
    },
    stepTextCol: {
        flex: 1,
        flexBasis: 0,
    },
    codeBlock: {
        backgroundColor: theme.colors.surface.elevated,
        borderRadius: 8,
        paddingHorizontal: theme.space.s12,
        paddingTop: theme.space.s10,
        paddingBottom: theme.space.s10,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: theme.space.s12,
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
        marginTop: theme.space.s20,
        gap: theme.space.s12,
    },
    buttonWrapper: {
        width: 260,
    },
}));

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
        case 'connect_machine':
            return [];
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

/**
 * "No machines yet", explained in one sentence with one action. Mounted only for `connect_machine`,
 * so its local status read never runs for any other state. On desktop the shared this-computer owner
 * says why this computer is not one of the account's machines (another account, another Home…) and
 * the action opens the page that repairs it; otherwise the sentence names the account and the Home,
 * and the action is setup.
 */
function ConnectMachinePrimaryCardContent(props: Readonly<{
    targetLabel: string;
    onOpenSetup: () => void;
}>): React.ReactElement {
    const router = useDestinationRouter();
    const styles = stylesheet;
    const { status } = useLocalDaemonControl();
    const connection = useThisComputerConnection(status);
    const { accountLabel } = useAppAccountIdentity();
    const presentation = connection ? presentThisComputerConnection(connection) : null;
    const openThisComputer = React.useCallback(() => {
        router.push(SETTINGS_ROUTES.machinesThisComputer);
    }, [router]);

    return (
        <>
            <Text style={styles.title}>{presentation?.title ?? t('sessionGettingStarted.title.connectMachine')}</Text>
            <Text style={styles.subtitle}>
                {presentation?.description ?? t('machine.thisComputer.noComputers', {
                    home: props.targetLabel,
                    appAccount: resolveViewerAccountDisplayName(accountLabel),
                })}
            </Text>
            <View style={styles.buttonWrapper}>
                <RoundButton
                    testID={presentation ? 'session-getting-started-open-this-computer' : 'session-getting-started-open-setup'}
                    title={presentation ? t('machine.thisComputer.openThisComputer') : t('setupOnboarding.openSetupAction')}
                    onPress={presentation ? openThisComputer : props.onOpenSetup}
                    size="normal"
                />
            </View>
        </>
    );
}

function SessionGettingStartedGuidanceViewImpl(props: SessionGettingStartedGuidanceViewProps): React.ReactElement {
    const router = useDestinationRouter();
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { model } = props;
    const copyFeedback = useHappierCopyFeedback();

    const title = getSessionGettingStartedTitle(model.kind);
    const subtitle = getSessionGettingStartedSubtitle(model.kind, model.targetLabel);
    const showSummaryOnly = model.kind === 'create_session' || model.kind === 'select_session';
    const showLogo = props.variant === 'primaryPane'
        && model.kind !== 'create_session'
        && model.kind !== 'select_session';
    const showSetupPrimaryCard = model.kind === 'connect_machine' || model.kind === 'start_daemon';
    const shouldBuildCliFollowUpSteps = !showSetupPrimaryCard && !showSummaryOnly;
    const steps = React.useMemo(() => (
        shouldBuildCliFollowUpSteps ? buildSteps(model) : []
    ), [
        model.kind,
        shouldBuildCliFollowUpSteps,
    ]);
    const showCliFollowUp = steps.length > 0 && shouldBuildCliFollowUpSteps;
    const showCliFollowUpTitle = false;
    const handleOpenSetup = React.useCallback(() => {
        if (model.onOpenSetup) {
            model.onOpenSetup();
            return;
        }
        router.push(buildMachineAddHref({ path: 'thisComputer' }) as any);
    }, [model.onOpenSetup, router]);

    // An unreachable Home never blocks: the reachability owner settles "Loading…" into
    // "Can't reach {Home} · Retry" (a line in the sidebar list, a pane elsewhere).
    const loadingGateVariant = props.variant === 'sidebar' || props.variant === 'phone' ? 'line' : 'pane';
    const content = (
        <ScrollView
            testID="session-getting-started-scroll"
            style={styles.scrollContainer}
            contentContainerStyle={[
                styles.contentContainer,
                props.variant === 'primaryPane' && (showSummaryOnly || showSetupPrimaryCard)
                    ? styles.contentContainerCentered
                    : null,
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
                    {model.kind === 'connect_machine' ? (
                        <ConnectMachinePrimaryCardContent targetLabel={model.targetLabel} onOpenSetup={handleOpenSetup} />
                    ) : (
                        <>
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
                        </>
                    )}
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

            {showSetupPrimaryCard && props.accessory ? (
                <View style={styles.accessory}>{props.accessory}</View>
            ) : null}

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
                                              <Icon name="copy" size={16} color={theme.colors.text.secondary} />,
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
    if (model.kind !== 'loading') return content;
    return <HomeReachabilityGate variant={loadingGateVariant}>{content}</HomeReachabilityGate>;
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
        && previous.accessory === next.accessory
        && areSessionGettingStartedGuidanceViewModelsEqual(previous.model, next.model);
}

export const SessionGettingStartedGuidanceView = React.memo(
    SessionGettingStartedGuidanceViewImpl,
    areSessionGettingStartedGuidanceViewPropsEqual,
);
SessionGettingStartedGuidanceView.displayName = 'SessionGettingStartedGuidanceView';

/**
 * The empty state always orients: "I'll do this later" defers the setup wizard (recorded per
 * account on the pending setup intent), it never blanks the place that explains what is missing.
 */
function useSessionGettingStartedGuidanceViewModelBase(): SessionGettingStartedGuidanceViewModel {
    const router = useDestinationRouter();
    const baseModel = useSessionGettingStartedGuidanceBaseModel();
    const resolveNewSessionOrdinaryEntryRoute = useResolveNewSessionOrdinaryEntryRoute();
    const onOpenSetup = React.useCallback(() => {
        router.push(buildMachineAddHref({ path: 'thisComputer' }) as any);
    }, [router]);

    const onStartNewSession = React.useCallback((event?: unknown) => {
        const { draftId, draftOrigin } = resolveNewSessionOrdinaryEntryRoute({
            forceFresh: shouldForceFreshNewSessionEntryFromPressEvent(event),
        });
        router.push({ pathname: '/new', params: { draftId, draftOrigin } });
    }, [resolveNewSessionOrdinaryEntryRoute, router]);

    return React.useMemo(() => {
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
    props: Readonly<{ variant: Exclude<SessionGettingStartedGuidanceVariant, 'phone'>; accessory?: React.ReactNode }>,
): React.ReactElement {
    const viewModel = useSessionGettingStartedGuidanceViewModelBase();

    return <SessionGettingStartedGuidanceView variant={props.variant} model={viewModel} accessory={props.accessory} />;
}

export function SessionGettingStartedGuidance(props: Readonly<{
    variant: SessionGettingStartedGuidanceVariant;
    /** Beneath the setup card, in its column: the host's own asks (Home's "Add your name"). */
    accessory?: React.ReactNode;
}>): React.ReactElement | null {
    if (getFeatureBuildPolicyDecision(SESSION_GETTING_STARTED_GUIDANCE_FEATURE_ID) === 'deny') {
        return null;
    }
    if (props.variant === 'phone') {
        return <SessionGettingStartedPhoneGuidanceEnabled />;
    }
    return <SessionGettingStartedGuidanceEnabled variant={props.variant} accessory={props.accessory} />;
}
