import * as React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import { AuthEntryView } from '@/components/account/auth/AuthEntryView';
import { TextInput } from '@/components/ui/text/Text';
import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Modal } from '@/modal';

import { isSameServerUrl, normalizeServerUrl, setActiveServerAndSwitch, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getResetToDefaultServerId, getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { isLocalishServerUrl } from '@/sync/domains/server/url/serverUrlClassification';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { isRunningOnMac } from '@/utils/platform/platform';
import { isWebQrScannerSupported } from '@/utils/platform/qrScannerSupport';
import { isWebMobileLikeQrScannerHost } from '@/utils/platform/webMobileHeuristics';
import { resolveKnownLocalRelayUrl } from '@/components/settings/server/localControl/resolveKnownLocalRelayUrl';
import { LocalRelayRuntimeControlSection } from '@/components/settings/server/localControl/LocalRelayRuntimeControlSection';
import type { useLocalRelayRuntimeControl } from '@/components/settings/server/localControl/useLocalRelayRuntimeControl';

import { QrCodeScannerView } from '@/components/qr/QrCodeScannerView';
import { RestoreIndexEmbedded } from '@/components/onboardingWizard/restore/RestoreIndexEmbedded';
import { LostAccessEmbedded } from '@/components/onboardingWizard/restore/LostAccessEmbedded';

import { RelayDiagram } from './RelayDiagram';
import { WizardLogotype } from './WizardLogotype';
import { WelcomeProvidersShowcase } from './WelcomeProvidersShowcase';
import { WizardTerminalHandoff } from './WizardTerminalHandoff';
import { WizardChoiceRow } from './WizardChoiceRow';
import { WebDesktopHandoffStep } from '@/components/onboardingWizard/WebDesktopHandoffStep';
import { canSkipWizardStep, getWizardProgress } from './wizardSelectors';
import { createWizardState, wizardReducer } from './wizardReducer';
import type { WizardRelaySelection, WizardStepId } from './wizardTypes';
import { ConfirmSwitchRelayStep, type RelaySwitchDecision } from './ConfirmSwitchRelayStep';
import { parseOnboardingScanPayload } from './scanPayload';
import { WizardModalShell } from './WizardModalShell';
import {
    setOnboardingWizardAwaitingAuthResumeIntent,
    setOnboardingWizardPreAuthResumeIntent,
} from './wizardResume';
import { getWizardStepDefinition } from './wizardStepRegistry';

export type OnboardingWizardSurfaceProps = Readonly<{
    testID?: string;
    layout: 'portrait' | 'landscape';
    isDesktopShell: boolean;
    authEntryOptions: AuthEntryOptions;
    initialStepId?: WizardStepId;

    onCreateAccount: () => Promise<void> | void;
    onCreateAccountViaProvider: (providerId: string) => Promise<void> | void;
    onLoginWithKeylessProvider: (providerId: string) => Promise<void> | void;
    onLoginWithMtls: () => Promise<void> | void;
    onChangeRelayViaServerConfig: () => void;
}>;

type WizardChoice = Readonly<{
    id: 'cloud' | 'thisComputer' | 'customUrl';
    title: string;
    subtitle: string;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    badge?: string;
    disabled?: boolean;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    urlBlock: {
        width: '100%',
        gap: 10,
    },
    urlInput: {
        width: '100%',
        borderWidth: 1,
        borderColor: theme.colors.divider,
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 12,
        color: theme.colors.text,
    },
    urlHint: {
        color: theme.colors.textSecondary,
    },
    relayHintBlock: {
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
    },
    relayHintLabel: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    relayHintValue: {
        ...Typography.default('semiBold'),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text,
        textAlign: 'center',
    },
    relayHintUrl: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    scanCtaBlock: {
        width: '100%',
        maxWidth: 360,
        alignSelf: 'center',
        marginTop: 6,
    },
    welcomeBody: {
        width: '100%',
        alignItems: 'center',
        gap: 16,
    },
    diagramContainer: {
        width: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'center',
    },
    labelContainer: {
    },
    label: {
        fontSize: 16,
        textAlign: 'center',
        ...Typography.default('semiBold'),
        color: theme.colors.text,
    },
}));

function resolveCanScanQr(params: Readonly<{ width: number; height: number; platform: string }>): boolean {
    if (isRunningOnMac()) return false;
    if (params.platform !== 'web') return true;
    if (!isWebQrScannerSupported()) return false;
    return isWebMobileLikeQrScannerHost({ width: params.width, height: params.height });
}

function buildDefaultRelaySelection(): WizardRelaySelection {
    const snapshot = getActiveServerSnapshot();
    const serverUrl = snapshot.serverUrl ? String(snapshot.serverUrl).trim() : '';
    const canonicalCloudProfile = resolveCanonicalCloudRelayProfile();
    const canonicalCloudUrl = canonicalCloudProfile?.serverUrl ?? '';

    if (serverUrl && isLocalishServerUrl(serverUrl)) {
        return {
            choiceId: 'thisComputer',
            serverUrl,
            locked: false,
        };
    }

    if (serverUrl) {
        const matchesCloud = canonicalCloudUrl ? isSameServerUrl(serverUrl, canonicalCloudUrl) : false;
        return {
            choiceId: matchesCloud ? 'cloud' : 'customUrl',
            serverUrl,
            locked: false,
        };
    }

    return {
        choiceId: 'cloud',
        serverUrl: canonicalCloudUrl || null,
        locked: false,
    };
}

function resolveCanonicalCloudRelayProfile(): Readonly<{ serverId: string; serverUrl: string }> | null {
    const defaultServerId = getResetToDefaultServerId();
    if (!defaultServerId) return null;
    const profile = getServerProfileById(defaultServerId);
    const serverUrl = profile?.serverUrl ? normalizeServerUrl(profile.serverUrl) : '';
    if (!profile || !serverUrl) return null;
    return {
        serverId: profile.id,
        serverUrl,
    };
}

export function OnboardingWizardSurface(props: OnboardingWizardSurfaceProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const { width, height } = useWindowDimensions();

    const canScanQr = React.useMemo(
        () => resolveCanScanQr({ width, height, platform: Platform.OS }),
        [height, width],
    );

    const [urlDraft, setUrlDraft] = React.useState('');
    const [relaySwitchDecision, setRelaySwitchDecision] = React.useState<RelaySwitchDecision>('switch');
    type LocalRelayRuntimeStatus = ReturnType<typeof useLocalRelayRuntimeControl>['status'];
    const [localRelayRuntimeStatus, setLocalRelayRuntimeStatus] = React.useState<LocalRelayRuntimeStatus>(null);
    const [state, dispatch] = React.useReducer(
        wizardReducer,
        null,
        () => {
            const context = {
                mode: 'onboarding',
                platform: props.isDesktopShell ? 'desktop' : (Platform.OS === 'web' ? 'web' : 'native'),
                canScanQr,
                scanStepEnabled: false,
                    canRunSystemTasks: props.isDesktopShell,
                    relaySelection: buildDefaultRelaySelection(),
                    relayLockConfirmationPending: false,
                    relaySwitchConfirmationPending: false,
                    authIntent: 'standard',
                    setupAction: null,
                } as const;

            const requestedStepId = props.initialStepId ?? 'welcome';
            const isRequestedVisible = getWizardStepDefinition(requestedStepId).visibleWhen(context);
            const initialStepId = isRequestedVisible ? requestedStepId : 'welcome';

            return createWizardState({
                context: {
                    ...context,
                },
                currentStepId: initialStepId,
                history: [],
                resumeState: null,
                parsedScanPayload: null,
            });
        },
    );

    const stepId = state.currentStepId;
    const progress = getWizardProgress(state.context, stepId);

    // Note: capability is captured at init time; if device size changes, we tolerate it until reload.

    const handleSkip = React.useCallback(() => {
        setOnboardingWizardPreAuthResumeIntent(state.context.relaySelection.serverUrl);
        dispatch({ type: 'wizard/setAuthIntent', authIntent: 'standard' });
        dispatch({ type: 'wizard/goToStep', stepId: 'auth' });
    }, [state.context.relaySelection.serverUrl]);

    const choices: readonly WizardChoice[] = React.useMemo(() => ([
        {
            id: 'cloud',
            title: t('setupOnboarding.relayCloudTitle'),
            subtitle: t('setupOnboarding.relayCloudSubtitle'),
            icon: 'cloud-outline',
            badge: t('setupOnboarding.recommendedBadge'),
        },
        {
            id: 'thisComputer',
            title: t('setupOnboarding.relayOnThisComputerTitle'),
            subtitle: t('setupOnboarding.relayOnThisComputerSubtitle'),
            icon: 'laptop-outline',
            disabled: Platform.OS !== 'web' && !props.isDesktopShell,
        },
        {
            id: 'customUrl',
            title: t('setupOnboarding.relayCustomUrlTitle'),
            subtitle: t('setupOnboarding.relayCustomUrlSubtitle'),
            icon: 'link-outline',
        },
    ]), [props.isDesktopShell]);

    const selectRelayChoice = React.useCallback((choiceId: WizardChoice['id']) => {
        const snapshot = getActiveServerSnapshot();
        const canonicalCloudProfile = resolveCanonicalCloudRelayProfile();
        const currentCustomRelayUrl = state.context.relaySelection.choiceId === 'customUrl'
            ? state.context.relaySelection.serverUrl
            : null;
        const next: WizardRelaySelection =
            choiceId === 'cloud'
                ? {
                    choiceId,
                    serverUrl: canonicalCloudProfile?.serverUrl ?? currentCustomRelayUrl,
                    locked: false,
                }
                : choiceId === 'thisComputer'
                    ? {
                        choiceId,
                        serverUrl: resolveKnownLocalRelayUrl({
                            activeServerUrl: snapshot.serverUrl,
                            activeLocalRelayUrl: snapshot.activeLocalRelayUrl,
                        }),
                        locked: false,
                    }
                    : {
                        choiceId,
                        serverUrl: currentCustomRelayUrl,
                        locked: state.context.relaySelection.locked,
                    };
        dispatch({ type: 'wizard/setRelaySelection', relaySelection: next });
    }, [state.context.relaySelection]);

    const renderRelayChoiceRow = (choice: WizardChoice) => {
        const selected = state.context.relaySelection.choiceId === choice.id;
        const disabled = Boolean(choice.disabled) || (state.context.relaySelection.locked && choice.id !== 'customUrl');
        return (
            <WizardChoiceRow
                key={choice.id}
                testID={`${props.testID ?? 'onboarding-wizard'}-relay:${choice.id}`}
                selected={selected}
                disabled={disabled}
                onPress={() => selectRelayChoice(choice.id)}
                icon={choice.icon}
                title={choice.title}
                subtitle={choice.subtitle}
                badge={choice.badge}
            />
        );
    };

    const handleAdvance = React.useCallback(async () => {
        if (stepId !== 'relay_select') {
            dispatch({ type: 'wizard/advance' });
            return;
        }

        const selection = state.context.relaySelection;
        if (selection.choiceId === 'customUrl') {
            const selectedServerUrlRaw = selection.serverUrl ? String(selection.serverUrl).trim() : '';
            const resolved = selectedServerUrlRaw ? normalizeServerUrl(selectedServerUrlRaw) : null;

            if (!resolved) {
                dispatch({ type: 'wizard/goToStep', stepId: 'relay_enter_url' });
                return;
            }

            const snapshot = getActiveServerSnapshot();
            if (!isSameServerUrl(snapshot.serverUrl, resolved)) {
                await upsertActivateAndSwitchServer({ serverUrl: resolved, source: 'url', scope: 'device' });
            }
            dispatch({
                type: 'wizard/setRelaySelection',
                relaySelection: {
                    choiceId: 'customUrl',
                    serverUrl: resolved,
                    locked: selection.locked,
                },
            });
            setOnboardingWizardAwaitingAuthResumeIntent(resolved);
            dispatch({ type: 'wizard/goToStep', stepId: state.context.authIntent === 'restore' ? 'auth_restore' : 'auth' });
            return;
        }

        const snapshot = getActiveServerSnapshot();
        if (selection.choiceId === 'cloud') {
            const canonicalCloudProfile = resolveCanonicalCloudRelayProfile();
            if (canonicalCloudProfile && !isSameServerUrl(snapshot.serverUrl, canonicalCloudProfile.serverUrl)) {
                await setActiveServerAndSwitch({ serverId: canonicalCloudProfile.serverId, scope: 'device' });
            }
            dispatch({
                type: 'wizard/setRelaySelection',
                relaySelection: {
                    choiceId: 'cloud',
                    serverUrl: canonicalCloudProfile?.serverUrl ?? selection.serverUrl,
                    locked: false,
                },
            });
            dispatch({ type: 'wizard/goToStep', stepId: 'auth' });
            return;
        }

        if (selection.choiceId === 'thisComputer') {
            if (!props.isDesktopShell && Platform.OS === 'web') {
                dispatch({ type: 'wizard/goToStep', stepId: 'desktop_handoff' });
                return;
            }
            const knownLocalRelayUrl = resolveKnownLocalRelayUrl({
                activeServerUrl: snapshot.serverUrl,
                activeLocalRelayUrl: snapshot.activeLocalRelayUrl,
            });
            if (knownLocalRelayUrl) {
                if (!isSameServerUrl(snapshot.serverUrl, knownLocalRelayUrl)) {
                    await upsertActivateAndSwitchServer({ serverUrl: knownLocalRelayUrl, source: 'url', scope: 'device' });
                }
                dispatch({
                    type: 'wizard/setRelaySelection',
                    relaySelection: {
                        choiceId: 'thisComputer',
                        serverUrl: knownLocalRelayUrl,
                        locked: false,
                    },
                });
                dispatch({ type: 'wizard/goToStep', stepId: 'auth' });
                return;
            }

            dispatch({ type: 'wizard/goToStep', stepId: 'host_relay_local' });
            return;
        }

        dispatch({ type: 'wizard/goToStep', stepId: 'auth' });
    }, [props.isDesktopShell, state.context.relaySelection, stepId]);

    const handleBack = React.useCallback(() => {
        dispatch({ type: 'wizard/back' });
    }, []);

    const handleScan = React.useCallback(async (data: string) => {
        const parsed = parseOnboardingScanPayload(data);
        dispatch({ type: 'wizard/setParsedScanPayload', parsedScanPayload: parsed });
        if (parsed.kind === 'pairing_link' && parsed.serverUrl == null) {
            dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: 'customUrl', serverUrl: null, locked: true } });
            dispatch({ type: 'wizard/setScanStepEnabled', enabled: false });
            dispatch({ type: 'wizard/goToStep', stepId: 'relay_enter_url' });
            return;
        }
        if (parsed.kind === 'relay_url') {
            dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: 'customUrl', serverUrl: parsed.serverUrl, locked: false } });
            dispatch({ type: 'wizard/setRelayLockConfirmationPending', pending: true });
            dispatch({ type: 'wizard/setScanStepEnabled', enabled: false });
            dispatch({ type: 'wizard/goToStep', stepId: 'confirm_relay_lock' });
            return;
        }
        if (parsed.kind === 'pairing_link') {
            dispatch({ type: 'wizard/setAuthIntent', authIntent: 'restore' });
            dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: 'customUrl', serverUrl: parsed.serverUrl, locked: false } });
            dispatch({ type: 'wizard/setScanStepEnabled', enabled: false });
            if (parsed.serverUrl) {
                dispatch({ type: 'wizard/setRelayLockConfirmationPending', pending: true });
                dispatch({ type: 'wizard/goToStep', stepId: 'confirm_relay_lock' });
                return;
            }
            dispatch({ type: 'wizard/goToStep', stepId: 'relay_enter_url' });
            return;
        }
        if (parsed.kind === 'account_connect') {
            dispatch({ type: 'wizard/setAuthIntent', authIntent: 'restore' });
            dispatch({ type: 'wizard/setScanStepEnabled', enabled: false });
            dispatch({ type: 'wizard/goToStep', stepId: 'auth_restore' });
            return;
        }
        await Modal.alert(t('common.error'), t('modals.invalidAuthUrl'));
    }, []);

    const handleSaveCustomRelayUrl = React.useCallback(async () => {
        const trimmed = urlDraft.trim();
        const normalized = normalizeServerUrl(trimmed);
        if (!normalized) {
            await Modal.alert(t('common.error'), t('modals.invalidAuthUrl'));
            return;
        }
        await upsertActivateAndSwitchServer({ serverUrl: normalized, source: 'url', scope: 'device' });
        const nextChoiceId =
            state.context.platform === 'web' && state.context.relaySelection.choiceId === 'thisComputer'
                ? 'thisComputer'
                : 'customUrl';
        dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: nextChoiceId, serverUrl: normalized, locked: false } });
        setOnboardingWizardAwaitingAuthResumeIntent(normalized);
        if (state.context.platform === 'web' && nextChoiceId === 'thisComputer') {
            dispatch({ type: 'wizard/goToStep', stepId: 'background_service_handoff' });
            return;
        }
        dispatch({ type: 'wizard/goToStep', stepId: state.context.authIntent === 'restore' ? 'auth_restore' : 'auth' });
    }, [state.context.authIntent, state.context.platform, state.context.relaySelection.choiceId, urlDraft]);

    const showBack = stepId !== 'welcome';
    const showSkip = canSkipWizardStep(state.context, stepId) && stepId !== 'auth';

    const stepDefinition = getWizardStepDefinition(stepId);
    const title = t(stepDefinition.titleKey);
    const subtitle = stepDefinition.subtitleKey ? t(stepDefinition.subtitleKey) : null;

    const primaryLabel =
        stepId === 'welcome'
            ? t('setupOnboarding.letsStart')
            : stepId === 'confirm_relay_lock'
                ? t('setupOnboarding.confirmSwitchRelaySwitchTitle')
            : stepId === 'desktop_handoff'
                ? t('setupOnboarding.webDesktopOnlyPrimary')
            : t('common.continue');

    const renderRelayHint = React.useCallback((params: Readonly<{
        testID: string;
        label: string;
        relayLabel: string;
        relayUrl: string;
    }>) => (
        <View testID={params.testID} style={styles.relayHintBlock}>
            <Text style={styles.relayHintLabel}>{params.label}</Text>
            <Text style={styles.relayHintValue}>{params.relayLabel}</Text>
            <Text style={styles.relayHintUrl}>{params.relayUrl}</Text>
        </View>
    ), [styles]);

    const footerHint = React.useMemo(() => {
        if (stepId === 'welcome' || stepId === 'scan_code') return null;
        const rawRelayUrl = state.context.relaySelection.serverUrl ? String(state.context.relaySelection.serverUrl).trim() : '';
        if (!rawRelayUrl) return null;
        const display = toServerUrlDisplay(rawRelayUrl);
        const relayLabel =
            state.context.relaySelection.choiceId === 'cloud'
                ? t('setupOnboarding.relayCloudTitle')
                : state.context.relaySelection.choiceId === 'thisComputer'
                    ? t('setupOnboarding.relayOnThisComputerTitle')
                    : t('setupOnboarding.relayCustomUrlTitle');
        return renderRelayHint({
            testID: `${props.testID ?? 'onboarding-wizard'}-relay-hint`,
            label: t('setupOnboarding.selectedRelayFooterLabel'),
            relayLabel,
            relayUrl: display,
        });
    }, [state.context.relaySelection.choiceId, state.context.relaySelection.serverUrl, stepId]);

    const primaryDisabled =
        (stepId === 'relay_select' && state.context.relaySelection.choiceId == null)
        || (stepId === 'host_relay_local' && !localRelayRuntimeStatus?.relayUrl);

    const onPrimary =
        stepId === 'welcome'
            ? () => {
                const selection = state.context.relaySelection;
                const relayUrl = selection.serverUrl ? String(selection.serverUrl).trim() : '';
                if (selection.choiceId === 'customUrl' && relayUrl.length > 0) {
                    setOnboardingWizardAwaitingAuthResumeIntent(relayUrl);
                    dispatch({ type: 'wizard/goToStep', stepId: state.context.authIntent === 'restore' ? 'auth_restore' : 'auth' });
                    return;
                }
                dispatch({ type: 'wizard/goToStep', stepId: 'relay_select' });
            }
            : stepId === 'relay_enter_url'
                ? handleSaveCustomRelayUrl
                : stepId === 'relay_select'
                    ? async () => {
                        setOnboardingWizardAwaitingAuthResumeIntent(state.context.relaySelection.serverUrl);
                        await handleAdvance();
                    }
                    : stepId === 'confirm_relay_lock'
                        ? async () => {
                            const relayUrl = state.context.relaySelection.serverUrl ? String(state.context.relaySelection.serverUrl).trim() : '';
                            if (!relayUrl) {
                                dispatch({ type: 'wizard/goToStep', stepId: 'relay_select' });
                                return;
                            }
                            const snapshot = getActiveServerSnapshot();
                            if (!isSameServerUrl(snapshot.serverUrl, relayUrl)) {
                                await upsertActivateAndSwitchServer({ serverUrl: relayUrl, source: 'url', scope: 'device' });
                            }
                            dispatch({
                                type: 'wizard/setRelaySelection',
                                relaySelection: {
                                    ...state.context.relaySelection,
                                    serverUrl: relayUrl,
                                    locked: true,
                                },
                            });
                            dispatch({ type: 'wizard/setRelayLockConfirmationPending', pending: false });
                            setOnboardingWizardAwaitingAuthResumeIntent(relayUrl);
                            dispatch({ type: 'wizard/goToStep', stepId: state.context.authIntent === 'restore' ? 'auth_restore' : 'auth' });
                        }
                    : stepId === 'desktop_handoff'
                        ? () => {
                            dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: 'thisComputer', serverUrl: null, locked: false } });
                            dispatch({ type: 'wizard/goToStep', stepId: 'relay_enter_url' });
                        }
                    : stepId === 'background_service_handoff'
                        ? () => dispatch({ type: 'wizard/goToStep', stepId: state.context.authIntent === 'restore' ? 'auth_restore' : 'auth' })
                    : stepId === 'host_relay_local'
                        ? async () => {
                            const relayUrlRaw = localRelayRuntimeStatus?.relayUrl ?? '';
                            const relayUrl = relayUrlRaw ? normalizeServerUrl(relayUrlRaw) : null;
                            if (!relayUrl) {
                                return;
                            }
                            setRelaySwitchDecision('switch');
                            dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: 'thisComputer', serverUrl: relayUrl, locked: false } });
                            dispatch({ type: 'wizard/setRelaySwitchConfirmationPending', pending: true });
                            dispatch({ type: 'wizard/goToStep', stepId: 'confirm_switch_relay' });
                        }
                        : stepId === 'confirm_switch_relay'
                            ? async () => {
                                const relayUrl = typeof state.context.relaySelection.serverUrl === 'string'
                                    ? state.context.relaySelection.serverUrl.trim()
                                    : '';
                                if (!relayUrl) {
                                    dispatch({ type: 'wizard/setRelaySwitchConfirmationPending', pending: false });
                                    dispatch({ type: 'wizard/goToStep', stepId: 'relay_select' });
                                    return;
                                }

                                if (relaySwitchDecision === 'switch') {
                                    await upsertActivateAndSwitchServer({ serverUrl: relayUrl, source: 'url', scope: 'device' });
                                    dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: 'thisComputer', serverUrl: relayUrl, locked: false } });
                                    setOnboardingWizardAwaitingAuthResumeIntent(relayUrl);
                                } else {
                                    const fallbackSelection = buildDefaultRelaySelection();
                                    dispatch({ type: 'wizard/setRelaySelection', relaySelection: fallbackSelection });
                                    setOnboardingWizardAwaitingAuthResumeIntent(fallbackSelection.serverUrl);
                                }

                                dispatch({ type: 'wizard/setRelaySwitchConfirmationPending', pending: false });
                                dispatch({ type: 'wizard/goToStep', stepId: state.context.authIntent === 'restore' ? 'auth_restore' : 'auth' });
                            }
                    : undefined;

    const onBack =
        showBack
            ? handleBack
            : undefined;

    let body: React.ReactNode = null;
    if (stepId === 'welcome') {
        body = (
            <View testID={`${props.testID ?? 'onboarding-wizard'}-welcome-body`} style={styles.welcomeBody}>
                <View style={styles.labelContainer}>
                    <Text style={styles.label}>{t('setupOnboarding.welcomeBody2')}</Text>
                    <Text style={styles.label}>{t('setupOnboarding.welcomeBody3')}</Text>
                </View>
                <WelcomeProvidersShowcase
                    testID={`${props.testID ?? 'onboarding-wizard'}-welcome-showcase`}
                    testIDPrefix={`${props.testID ?? 'onboarding-wizard'}-welcome`}
                />
                {canScanQr ? (
                    <View style={styles.scanCtaBlock}>
                        <RoundButton
                            testID={`${props.testID ?? 'onboarding-wizard'}-scan`}
                            size="normal"
                            display="inverted"
                            title={t('setupOnboarding.scanQrCode')}
                            onPress={() => {
                                dispatch({ type: 'wizard/setScanStepEnabled', enabled: true });
                                dispatch({ type: 'wizard/goToStep', stepId: 'scan_code' });
                            }}
                        />
                    </View>
                ) : null}
            </View>
        );
    } else if (stepId === 'scan_code') {
        body = (
            <QrCodeScannerView
                testIDPrefix={`${props.testID ?? 'onboarding-wizard'}-scan`}
                title={t('setupOnboarding.scanQrCode')}
                permissionRequiredMessage={t('modals.cameraPermissionsRequiredToScanQr')}
                embedded
                onCancel={() => {
                    dispatch({ type: 'wizard/setScanStepEnabled', enabled: false });
                    dispatch({ type: 'wizard/goToStep', stepId: 'welcome' });
                }}
                onScan={handleScan}
            />
        );
    } else if (stepId === 'relay_select') {
        body = (
            <>
                <View style={styles.diagramContainer}>
                    <RelayDiagram testID={`${props.testID ?? 'onboarding-wizard'}-relay-diagram`} />
                </View>
                <View>
                    {choices.map(renderRelayChoiceRow)}
                </View>
            </>
        );
    } else if (stepId === 'confirm_relay_lock') {
        body = (
            <View testID={`${props.testID ?? 'onboarding-wizard'}-confirm-relay-lock`}>
                <Text style={styles.urlHint}>{t('setupOnboarding.confirmSwitchRelayWarning')}</Text>
            </View>
        );
    } else if (stepId === 'relay_enter_url') {
        body = (
            <View style={styles.urlBlock}>
                <TextInput
                    testID={`${props.testID ?? 'onboarding-wizard'}-relay-url-input`}
                    placeholder={t('common.urlPlaceholder')}
                    placeholderTextColor={theme.colors.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={urlDraft}
                    onChangeText={setUrlDraft}
                    style={styles.urlInput}
                />
                <Text style={styles.urlHint}>{t('setupOnboarding.relayCustomUrlSubtitle')}</Text>
            </View>
        );
    } else if (stepId === 'background_service_handoff') {
        body = (
            <WizardTerminalHandoff
                testID={`${props.testID ?? 'onboarding-wizard'}-background-service-handoff`}
                steps={[
                    {
                        title: t('sessionGettingStarted.steps.daemonInstall.title'),
                        subtitle: t('sessionGettingStarted.steps.daemonInstall.description'),
                        code: 'happier daemon install',
                        scrollTestIDSuffix: 'daemon-install',
                    },
                    {
                        title: t('sessionGettingStarted.steps.daemonStart.title'),
                        subtitle: t('sessionGettingStarted.steps.daemonStart.description'),
                        code: 'happier daemon start',
                        scrollTestIDSuffix: 'daemon-start',
                    },
                ]}
            />
        );
    } else if (stepId === 'host_relay_local') {
        body = (
            <LocalRelayRuntimeControlSection
                onStatusChange={setLocalRelayRuntimeStatus}
            />
        );
    } else if (stepId === 'confirm_switch_relay') {
        const relayUrl = typeof state.context.relaySelection.serverUrl === 'string' ? state.context.relaySelection.serverUrl : '';
        body = (
            <ConfirmSwitchRelayStep
                testIDPrefix={props.testID ?? 'onboarding-wizard'}
                relayUrl={relayUrl}
                decision={relaySwitchDecision}
                onDecisionChange={setRelaySwitchDecision}
            />
        );
    } else if (stepId === 'auth') {
        body = (
            <>
                <AuthEntryView
                    layout={props.layout}
                    isDesktopShell={false}
                    options={props.authEntryOptions}
                    onOpenSetup={() => {}}
                    onChangeRelay={props.onChangeRelayViaServerConfig}
                    onRestore={() => dispatch({ type: 'wizard/goToStep', stepId: 'auth_restore' })}
                    onCreateAccount={props.onCreateAccount}
                    onCreateAccountViaProvider={props.onCreateAccountViaProvider}
                    onLoginWithKeylessProvider={props.onLoginWithKeylessProvider}
                    onLoginWithMtls={props.onLoginWithMtls}
                />
                <View style={styles.scanCtaBlock}>
                    <RoundButton
                        testID={`${props.testID ?? 'onboarding-wizard'}-lost-access`}
                        size="small"
                        display="inverted"
                        title={t('setupOnboarding.authLostAccessTitle')}
                        onPress={() => dispatch({ type: 'wizard/goToStep', stepId: 'auth_lost_access' })}
                    />
                </View>
            </>
        );
    } else if (stepId === 'desktop_handoff') {
        body = (
            <WebDesktopHandoffStep testID={`${props.testID ?? 'onboarding-wizard'}-desktop-handoff`} />
        );
    } else if (stepId === 'auth_restore') {
        body = <RestoreIndexEmbedded onBack={() => dispatch({ type: 'wizard/goToStep', stepId: 'auth' })} />;
    } else if (stepId === 'auth_lost_access') {
        body = <LostAccessEmbedded onBack={() => dispatch({ type: 'wizard/goToStep', stepId: 'auth' })} />;
    }

    return (
        <WizardModalShell
            testID={props.testID ?? 'onboarding-wizard'}
            stepIndex={Math.max(0, progress.current - 1)}
            stepCount={Math.max(1, progress.total)}
            titleLeading={stepId === 'welcome' ? <WizardLogotype height={45} testID={`${props.testID ?? 'onboarding-wizard'}-logotype`} /> : undefined}
            title={title}
            subtitle={subtitle ?? undefined}
            onSkip={showSkip ? handleSkip : undefined}
            onBack={onBack}
            onPrimary={onPrimary}
            primaryLabel={primaryLabel}
            primaryDisabled={primaryDisabled}
            showBack={Boolean(onBack)}
            footerHint={footerHint ?? undefined}
        >
            {body}
        </WizardModalShell>
    );
}
