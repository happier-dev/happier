import * as React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Modal } from '@/modal';

import { isSameServerUrl, normalizeServerUrl, setActiveServerAndSwitch, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { getActiveServerSnapshot, isActiveServerSelectionExplicit } from '@/sync/domains/server/serverRuntime';
import { readConfiguredServerUrlEnv } from '@/sync/domains/server/readConfiguredServerUrlEnv';
import { listServerProfiles, removeServerProfile } from '@/sync/domains/server/serverProfiles';
import { removeServerProfileUiAction } from '@/components/serverProfiles/removeServerProfileUiAction';
import { resolveSetupSurfacePolicy } from '@/sync/domains/server/setup/setupSurfacePolicy';
import { isLocalishServerUrl } from '@/sync/domains/server/url/serverUrlClassification';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { readServerReachabilityProbeTimeoutMs } from '@/sync/runtime/connectivity/serverReachabilityTuning';
import { isRunningOnMac } from '@/utils/platform/platform';
import { isWebQrScannerSupported } from '@/utils/platform/qrScannerSupport';
import { isWebMobileLikeQrScannerHost } from '@/utils/platform/webMobileHeuristics';
import type { RelayHostLocalChecklistRuntimeStatus } from '../relayHostLocalChecklist/types';

import { WizardLogotype } from '../WizardLogotype';
import { WizardChoiceRow } from '../WizardChoiceRow';
import { WebDesktopRelayHostHandoffContent } from '@/components/onboardingWizard/WebDesktopRelayHostHandoffContent';
import { WebDesktopBackgroundServiceHandoffContent } from '@/components/onboardingWizard/WebDesktopBackgroundServiceHandoffContent';
import { resolveWizardCapabilities } from '../capabilities/resolveWizardCapabilities';
import { canSkipWizardStep, getWizardProgress } from '../wizardSelectors';
import { createWizardState, wizardReducer } from '../wizardReducer';
import type { WizardPlatform, WizardRelaySelection, WizardStepId } from '../wizardTypes';
import { ConfirmSwitchRelayStep, type RelaySwitchDecision } from '../ConfirmSwitchRelayStep';
import { parseOnboardingScanPayload } from '../scanPayload';
import { WizardModalShell } from '../WizardModalShell';
import { useEndpointReadinessMap } from '../useEndpointReadinessMap';
import {
    setOnboardingWizardAwaitingAuthResumeIntent,
} from '../wizardResume';
import { getWizardStepDefinition } from '../wizardStepRegistry';
import { renderOnboardingWizardStepBody } from './OnboardingWizardSurface.renderWizardStepBody';
import { onboardingWizardSurfaceStylesheet } from './OnboardingWizardSurface.styles';
import {
    buildDefaultRelaySelection,
    isWebMixedContentBlockedEndpoint,
    resolveCanonicalCloudRelayProfile,
    resolveRelayProfileIdForServerUrl,
    resolveTrueLocalRelayRuntimeBindUrl,
} from './onboardingWizardRelaySelectionHelpers';

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

type WizardPrimaryOverride = Readonly<{
    label: React.ReactNode;
    disabled: boolean;
    onPress: (() => void) | (() => Promise<void>);
}>;

type WizardBackOverride = Readonly<{
    hidden?: boolean;
    label?: React.ReactNode;
    onPress?: () => void;
}>;

type WizardSkipOverride = Readonly<{
    hidden?: boolean;
    label?: React.ReactNode;
    disabled?: boolean;
    onPress?: () => void;
}>;

type ScopedOverride<T> = Readonly<{ __stepId: WizardStepId }> & T;

type WizardChoice = Readonly<{
    id: 'cloud' | 'thisComputer' | 'remoteComputer' | 'customUrl';
    title: string;
    subtitle: string;
    icon: React.ComponentProps<typeof Ionicons>['name'];
    badge?: string;
    disabled?: boolean;
}>;

type WizardProfileChoice = Readonly<{
    kind: 'profile';
    id: string;
    name: string;
    serverUrl: string;
    disabled?: boolean;
}>;

function resolveCanScanQr(params: Readonly<{ width: number; height: number; platform: string }>): boolean {
    if (isRunningOnMac()) return false;
    if (params.platform !== 'web') return true;
    if (!isWebQrScannerSupported()) return false;
    return isWebMobileLikeQrScannerHost({ width: params.width, height: params.height });
}

export function OnboardingWizardSurface(props: OnboardingWizardSurfaceProps) {
    const { theme } = useUnistyles();
    const styles = onboardingWizardSurfaceStylesheet;
    const { width, height } = useWindowDimensions();
    const wizardPlatform: WizardPlatform = props.isDesktopShell ? 'desktop' : (Platform.OS === 'web' ? 'web' : 'native');
    const wizardCapabilities = React.useMemo(
        () => resolveWizardCapabilities({ platform: wizardPlatform, isDesktopShell: props.isDesktopShell }),
        [props.isDesktopShell, wizardPlatform],
    );
    const setupPolicy = React.useMemo(() => resolveSetupSurfacePolicy(), []);
    const canonicalCloudProfile = resolveCanonicalCloudRelayProfile();
    const canonicalCloudUrl = canonicalCloudProfile?.serverUrl ?? '';
    const snapshotRelayUrl = React.useMemo(() => {
        const snapshot = getActiveServerSnapshot();
        const serverUrl = snapshot.serverUrl ? String(snapshot.serverUrl).trim() : '';
        if (serverUrl) return serverUrl;
        const localUrl = snapshot.activeLocalRelayUrl ? String(snapshot.activeLocalRelayUrl).trim() : '';
        return localUrl;
    }, []);
    const lastKnownSnapshotRelayUrlRef = React.useRef<string>(snapshotRelayUrl);
    React.useEffect(() => {
        const snapshot = getActiveServerSnapshot();
        const serverUrl = snapshot.serverUrl ? String(snapshot.serverUrl).trim() : '';
        const localUrl = snapshot.activeLocalRelayUrl ? String(snapshot.activeLocalRelayUrl).trim() : '';
        const url = serverUrl || localUrl;
        if (url) {
            lastKnownSnapshotRelayUrlRef.current = url;
        }
    });

    const canScanQr = React.useMemo(
        () => resolveCanScanQr({ width, height, platform: Platform.OS }),
        [height, width],
    );

    const [urlDraft, setUrlDraft] = React.useState('');
    const [relaySwitchDecision, setRelaySwitchDecision] = React.useState<RelaySwitchDecision>('switch');
    const [wizardPrimaryOverride, setWizardPrimaryOverride] = React.useState<ScopedOverride<WizardPrimaryOverride> | null>(null);
    const [wizardBackOverride, setWizardBackOverride] = React.useState<ScopedOverride<WizardBackOverride> | null>(null);
    const [wizardSkipOverride, setWizardSkipOverride] = React.useState<ScopedOverride<WizardSkipOverride> | null>(null);
    type LocalRelayRuntimeStatus = RelayHostLocalChecklistRuntimeStatus | null;
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

    React.useEffect(() => {
        if (stepId !== 'relay_enter_url') {
            return;
        }
        if (urlDraft.trim().length > 0) {
            return;
        }
        const selectedRelayUrl = typeof state.context.relaySelection.serverUrl === 'string'
            ? state.context.relaySelection.serverUrl.trim()
            : '';
        if (!selectedRelayUrl) return;
        setUrlDraft(selectedRelayUrl);
    }, [stepId, state.context.relaySelection.serverUrl, urlDraft]);
    const activePrimaryOverride = wizardPrimaryOverride?.__stepId === stepId ? wizardPrimaryOverride : null;
    const activeBackOverride = wizardBackOverride?.__stepId === stepId ? wizardBackOverride : null;
    const activeSkipOverride = wizardSkipOverride?.__stepId === stepId ? wizardSkipOverride : null;
    const handleWizardPrimaryChange = React.useCallback((next: WizardPrimaryOverride | null) => {
        setWizardPrimaryOverride(next ? { __stepId: stepId, ...next } : null);
    }, [stepId]);
    const handleWizardBackChange = React.useCallback((next: WizardBackOverride | null) => {
        setWizardBackOverride(next ? { __stepId: stepId, ...next } : null);
    }, [stepId]);
    const handleWizardSkipChange = React.useCallback((next: WizardSkipOverride | null) => {
        setWizardSkipOverride(next ? { __stepId: stepId, ...next } : null);
    }, [stepId]);
    const progress = getWizardProgress(state.context, stepId);
    const welcomeHasExplicitRelaySelection = stepId === 'welcome'
        && (
            state.history.length > 0
            || isActiveServerSelectionExplicit()
            || Boolean(readConfiguredServerUrlEnv())
            || state.context.relaySelection.choiceId !== 'cloud'
            || state.context.relaySelection.relayProfileId != null
        );
    const welcomeRelayUrl = React.useMemo(() => {
        if (!welcomeHasExplicitRelaySelection) {
            return '';
        }
        const selectedRelayUrl = state.context.relaySelection.serverUrl ? String(state.context.relaySelection.serverUrl).trim() : '';
        if (selectedRelayUrl) {
            return selectedRelayUrl;
        }
        const snapshot = getActiveServerSnapshot();
        return snapshot.serverUrl ? String(snapshot.serverUrl).trim() : '';
    }, [state.context.relaySelection.relayProfileId, state.context.relaySelection.choiceId, state.context.relaySelection.serverUrl, state.history.length, welcomeHasExplicitRelaySelection]);
    const welcomeHasKnownRelay = stepId === 'welcome' && Boolean(welcomeRelayUrl);
    const welcomeHasAuthActions = welcomeHasKnownRelay && (
        props.authEntryOptions.serverAvailability === 'ready'
        || props.authEntryOptions.serverAvailability === 'legacy'
    );

    // Note: capability is captured at init time; if device size changes, we tolerate it until reload.

    const relayChoices: readonly WizardChoice[] = React.useMemo(() => {
        const thisComputerTitleKey = wizardCapabilities.thisComputerLabelVariant === 'your'
            ? 'setupOnboarding.relayOnYourComputerTitle'
            : 'setupOnboarding.relayOnThisComputerTitle';
        const thisComputerSubtitleKey = wizardCapabilities.thisComputerLabelVariant === 'your'
            ? 'setupOnboarding.relayOnYourComputerSubtitle'
            : 'setupOnboarding.relayOnThisComputerSubtitle';

        const choices: WizardChoice[] = [];

        if (setupPolicy.relay.allowHappierCloud) {
            choices.push({
                id: 'cloud',
                title: t('setupOnboarding.relayCloudTitle'),
                subtitle: t('setupOnboarding.relayCloudSubtitle'),
                icon: 'cloud-outline' as React.ComponentProps<typeof Ionicons>['name'],
                badge: t('setupOnboarding.recommendedBadge'),
            });
        }

        if (setupPolicy.relay.allowLocalRelayHost) {
            choices.push({
                id: 'thisComputer',
                title: t(thisComputerTitleKey),
                subtitle: t(thisComputerSubtitleKey),
                icon: 'laptop-outline' as React.ComponentProps<typeof Ionicons>['name'],
                disabled: false,
            });
        }

        if (wizardCapabilities.allowRemoteSshRelayChoice) {
            choices.push({
                id: 'remoteComputer' as const,
                title: t('setupOnboarding.relayOnRemoteComputerTitle'),
                subtitle: t('setupOnboarding.relayOnRemoteComputerSubtitle'),
                icon: 'desktop-outline' as React.ComponentProps<typeof Ionicons>['name'],
            });
        }

        return choices;
    }, [setupPolicy.relay.allowHappierCloud, setupPolicy.relay.allowLocalRelayHost, wizardCapabilities]);

    const profileChoices = React.useMemo((): WizardProfileChoice[] => {
        const canonicalCloudProfile = resolveCanonicalCloudRelayProfile();
        const canonicalCloudUrl = canonicalCloudProfile?.serverUrl ?? '';
        const profiles = listServerProfiles()
            .filter((profile) => {
                const serverUrl = profile?.serverUrl ? normalizeServerUrl(profile.serverUrl) : '';
                if (!serverUrl) return false;
                if (canonicalCloudUrl && isSameServerUrl(serverUrl, canonicalCloudUrl)) return false;
                return true;
            })
            .map((profile) => ({
                kind: 'profile' as const,
                id: profile.id,
                name: profile.name,
                serverUrl: normalizeServerUrl(profile.serverUrl) ?? profile.serverUrl,
            }));

        const selectionServerUrl = normalizeServerUrl(state.context.relaySelection.serverUrl ?? '') ?? '';
        const knownPrefilledUrl = selectionServerUrl || (normalizeServerUrl(getActiveServerSnapshot().serverUrl ?? '') ?? '');
        if (
            knownPrefilledUrl
            && (!canonicalCloudUrl || !isSameServerUrl(knownPrefilledUrl, canonicalCloudUrl))
            && !(isLocalishServerUrl(knownPrefilledUrl) && isActiveServerSelectionExplicit() && state.context.relaySelection.choiceId === 'thisComputer')
        ) {
            const alreadyListed = profiles.some((existing) => isSameServerUrl(existing.serverUrl, knownPrefilledUrl));
            if (!alreadyListed) {
                profiles.unshift({
                    kind: 'profile' as const,
                    id: 'active',
                    name: t('setupOnboarding.currentRelayTitle'),
                    serverUrl: knownPrefilledUrl,
                });
            }
        }

        return profiles;
    }, [state.context.relaySelection.serverUrl]);

    const canonicalCloudReadinessEndpoint = React.useMemo(() => {
        if (!canonicalCloudUrl) return null;
        return normalizeServerUrl(canonicalCloudUrl) ?? canonicalCloudUrl;
    }, [canonicalCloudUrl]);

    const activeServerSnapshotForLocalBind = getActiveServerSnapshot();
    const trueLocalRelayRuntimeBindUrl = React.useMemo(() => {
        return resolveTrueLocalRelayRuntimeBindUrl({
            activeServerUrl: activeServerSnapshotForLocalBind.serverUrl ?? null,
            activeLocalRelayUrl: activeServerSnapshotForLocalBind.activeLocalRelayUrl ?? null,
        });
    }, [activeServerSnapshotForLocalBind.activeLocalRelayUrl, activeServerSnapshotForLocalBind.serverUrl]);

    const { readinessByEndpoint: relayReadinessByEndpoint, retryEndpoint } = useEndpointReadinessMap({
        endpoints: stepId === 'relay_select'
            ? [
                ...profileChoices.map((profile) => profile.serverUrl),
                ...(canonicalCloudReadinessEndpoint ? [canonicalCloudReadinessEndpoint] : []),
                ...(trueLocalRelayRuntimeBindUrl ? [trueLocalRelayRuntimeBindUrl] : []),
            ]
            : [],
        enabled: stepId === 'relay_select',
        timeoutMs: readServerReachabilityProbeTimeoutMs(),
    });

    const handleRemoveRelayProfile = React.useCallback(async (profileId: string) => {
        const id = String(profileId ?? '').trim();
        if (!id || id === 'active') {
            return;
        }

        const confirmed = await Modal.confirm(
            t('setupOnboarding.removeRelayConfirmTitle'),
            t('setupOnboarding.removeRelayConfirmBody'),
            { confirmText: t('common.remove'), cancelText: t('common.cancel') },
        );
        if (!confirmed) return;

        const serverUrl = profileChoices.find((profile) => profile.id === id)?.serverUrl ?? '';
        try {
            await removeServerProfileUiAction({ profileId: id, serverUrl });
        } catch {
            // ignore: profile may have been removed elsewhere
        }

        if (state.context.relaySelection.relayProfileId === id) {
            dispatch({ type: 'wizard/setRelaySelection', relaySelection: buildDefaultRelaySelection() });
        }
    }, [profileChoices, state.context.relaySelection.relayProfileId]);

    const selectRelayChoice = React.useCallback((choiceId: WizardChoice['id']) => {
        const next: WizardRelaySelection =
            choiceId === 'cloud'
                ? {
                    choiceId,
                    serverUrl: canonicalCloudUrl || null,
                    relayProfileId: null,
                    locked: false,
                }
                : choiceId === 'thisComputer'
                    ? {
                        choiceId,
                        serverUrl: null,
                        relayProfileId: null,
                        locked: false,
                    }
                    : choiceId === 'remoteComputer'
                        ? {
                            choiceId,
                            serverUrl: null,
                            relayProfileId: null,
                            locked: false,
                        }
                    : {
                        choiceId,
                        serverUrl: null,
                        relayProfileId: null,
                        locked: state.context.relaySelection.locked,
                    };
        dispatch({ type: 'wizard/setRelaySelection', relaySelection: next });
    }, [canonicalCloudUrl, state.context.relaySelection]);

    const selectProfileRelay = React.useCallback((profile: WizardProfileChoice) => {
        dispatch({
            type: 'wizard/setRelaySelection',
            relaySelection: {
                choiceId: 'customUrl',
                serverUrl: profile.serverUrl,
                relayProfileId: profile.id,
                locked: state.context.relaySelection.locked,
            },
        });
    }, [state.context.relaySelection.locked]);

    const renderRelayChoiceRow = (choice: WizardChoice | WizardProfileChoice) => {
        if ((choice as WizardProfileChoice).kind === 'profile') {
            const profile = choice as WizardProfileChoice;
            const selected = state.context.relaySelection.choiceId === 'customUrl'
                && state.context.relaySelection.relayProfileId === profile.id;
            const readiness = relayReadinessByEndpoint.get(profile.serverUrl);
            const blocked = readiness?.status === 'blocked' || isWebMixedContentBlockedEndpoint(profile.serverUrl);
            const unavailable = readiness?.status === 'unavailable';
            const disabled = Boolean(profile.disabled)
                || state.context.relaySelection.locked
                ;
            return (
                <WizardChoiceRow
                    key={`profile:${profile.id}`}
                    testID={`${props.testID ?? 'onboarding-wizard'}-relay:profile:${profile.id}`}
                    selected={selected}
                    disabled={disabled}
                    dimmed={unavailable || blocked}
                    onPress={() => selectProfileRelay(profile)}
                    icon="link-outline"
                    title={profile.name}
                    subtitle={toServerUrlDisplay(profile.serverUrl)}
                    badge={blocked ? t('common.blocked') : unavailable ? t('common.unreachable') : undefined}
                    menuActions={[
                        ...((unavailable || blocked) ? [{
                            id: 'retry',
                            title: t('common.retry'),
                            onPress: () => retryEndpoint(profile.serverUrl),
                        }] : []),
                        ...(profile.id !== 'active' ? [{
                            id: 'remove',
                            title: t('common.remove'),
                            destructive: true,
                            onPress: () => { void handleRemoveRelayProfile(profile.id); },
                        }] : []),
                    ]}
                />
            );
        }

        const fixed = choice as WizardChoice;
        const selected = state.context.relaySelection.choiceId === fixed.id;
        const cloudReadinessEndpoint = fixed.id === 'cloud' ? canonicalCloudReadinessEndpoint : null;
        const cloudBlocked =
            fixed.id === 'cloud'
                && Boolean(cloudReadinessEndpoint)
                && relayReadinessByEndpoint.get(cloudReadinessEndpoint!)?.status === 'blocked';
        const cloudUnavailable =
            fixed.id === 'cloud'
                && Boolean(cloudReadinessEndpoint)
                && relayReadinessByEndpoint.get(cloudReadinessEndpoint!)?.status === 'unavailable';
        const disabled = Boolean(fixed.disabled)
            || state.context.relaySelection.locked
            || (fixed.id === 'cloud' && (cloudUnavailable || cloudBlocked) && !selected);
        return (
            <WizardChoiceRow
                key={fixed.id}
                testID={`${props.testID ?? 'onboarding-wizard'}-relay:${fixed.id}`}
                selected={selected}
                disabled={disabled}
                dimmed={cloudUnavailable || cloudBlocked}
                onPress={() => {
                    selectRelayChoice(fixed.id);
                }}
                icon={fixed.icon}
                title={fixed.title}
                subtitle={fixed.subtitle}
                badge={cloudBlocked ? t('common.blocked') : cloudUnavailable ? t('common.unreachable') : fixed.badge}
                secondaryAction={(cloudUnavailable || cloudBlocked) ? {
                    testID: `${props.testID ?? 'onboarding-wizard'}-relay:${fixed.id}-retry`,
                    title: t('common.retry'),
                    onPress: () => retryEndpoint(cloudReadinessEndpoint!),
                } : undefined}
            />
        );
    };

    const renderManualRelayChoiceRow = () => {
        if (!setupPolicy.relay.allowRelaySelection || !setupPolicy.relay.allowCustomRelayUrl) {
            return null;
        }
        const rawServerUrl = state.context.relaySelection.serverUrl
            ? String(state.context.relaySelection.serverUrl).trim()
            : '';
        const selected = state.context.relaySelection.choiceId === 'customUrl'
            && !state.context.relaySelection.relayProfileId
            && !selectedSavedRelayProfile;

        return (
            <WizardChoiceRow
                testID={`${props.testID ?? 'onboarding-wizard'}-relay:customUrl`}
                selected={selected}
                disabled={state.context.relaySelection.locked && !selected}
                onPress={() => {
                    dispatch({
                        type: 'wizard/setRelaySelection',
                        relaySelection: {
                            choiceId: 'customUrl',
                            serverUrl: rawServerUrl || null,
                            relayProfileId: null,
                            locked: state.context.relaySelection.locked,
                        },
                    });
                    if (stepId === 'relay_select') {
                        dispatch({ type: 'wizard/goToStep', stepId: 'relay_enter_url' });
                    }
                }}
                icon="link-outline"
                title={t('setupOnboarding.relayCustomUrlTitle')}
                subtitle={t('setupOnboarding.relayCustomUrlSubtitle')}
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
            if (!selection.relayProfileId) {
                dispatch({ type: 'wizard/goToStep', stepId: 'relay_enter_url' });
                return;
            }
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
            const relayProfileId = selection.relayProfileId ?? resolveRelayProfileIdForServerUrl({ serverUrl: resolved, canonicalCloudUrl });
            dispatch({
                type: 'wizard/setRelaySelection',
                relaySelection: {
                    choiceId: 'customUrl',
                    serverUrl: resolved,
                    relayProfileId,
                    locked: selection.locked,
                },
            });
            setOnboardingWizardAwaitingAuthResumeIntent(resolved);
            dispatch({ type: 'wizard/goToStep', stepId: state.context.authIntent === 'restore' ? 'auth_restore' : 'auth' });
            return;
        }

        const snapshot = getActiveServerSnapshot();
        if (selection.choiceId === 'cloud') {
            if (canonicalCloudProfile && !isSameServerUrl(snapshot.serverUrl, canonicalCloudProfile.serverUrl)) {
                await setActiveServerAndSwitch({ serverId: canonicalCloudProfile.serverId, scope: 'device' });
            }
            dispatch({
                type: 'wizard/setRelaySelection',
                relaySelection: {
                    choiceId: 'cloud',
                    serverUrl: canonicalCloudProfile?.serverUrl ?? null,
                    relayProfileId: null,
                    locked: false,
                },
            });
            dispatch({ type: 'wizard/goToStep', stepId: 'auth' });
            return;
        }

        if (selection.choiceId === 'thisComputer') {
            if (props.isDesktopShell) {
                const status = trueLocalRelayRuntimeBindUrl
                    ? relayReadinessByEndpoint.get(trueLocalRelayRuntimeBindUrl)?.status
                    : null;
                if (trueLocalRelayRuntimeBindUrl && status === 'ready') {
                    dispatch({
                        type: 'wizard/setRelaySelection',
                        relaySelection: { choiceId: 'thisComputer', serverUrl: trueLocalRelayRuntimeBindUrl, relayProfileId: null, locked: false },
                    });
                    dispatch({ type: 'wizard/goToStep', stepId: 'relay_access' });
                    return;
                }

                dispatch({ type: 'wizard/goToStep', stepId: 'host_relay_local' });
                return;
            }

            dispatch({ type: 'wizard/goToStep', stepId: 'desktop_handoff' });
            return;
        }

        if (selection.choiceId === 'remoteComputer') {
            dispatch({ type: 'wizard/goToStep', stepId: 'host_relay_remote' });
            return;
        }

        dispatch({ type: 'wizard/goToStep', stepId: 'auth' });
    }, [canonicalCloudProfile, props.isDesktopShell, relayReadinessByEndpoint, state.context.relaySelection, stepId, trueLocalRelayRuntimeBindUrl]);

    const handleRemoteRelayRuntimeCompletedChange = React.useCallback((payload: Readonly<{
        machineId: string | null;
        relayRuntimeUrl: string | null;
        mode: 'remoteMachine' | 'remoteRelayHost';
    }>) => {
        const relayUrl = typeof payload.relayRuntimeUrl === 'string' ? payload.relayRuntimeUrl.trim() : '';
        if (!relayUrl) {
            return;
        }

        setRelaySwitchDecision('switch');
        const relayProfileId = resolveRelayProfileIdForServerUrl({ serverUrl: relayUrl, canonicalCloudUrl });
        dispatch({
            type: 'wizard/setRelaySelection',
            relaySelection: {
                choiceId: 'customUrl',
                serverUrl: relayUrl,
                relayProfileId,
                locked: false,
            },
        });
        dispatch({ type: 'wizard/setRelaySwitchConfirmationPending', pending: true });
        setOnboardingWizardAwaitingAuthResumeIntent(relayUrl);
    }, [canonicalCloudUrl]);

    const handleBack = React.useCallback(() => {
        dispatch({ type: 'wizard/back' });
    }, []);

    const handleOpenRelaySelectionFromWelcome = React.useCallback(() => {
        if (!setupPolicy.relay.allowRelaySelection) {
            return;
        }
        if (!state.context.relaySelection.locked) {
            dispatch({ type: 'wizard/setRelaySelection', relaySelection: buildDefaultRelaySelection() });
        }
        dispatch({ type: 'wizard/goToStep', stepId: 'relay_select' });
    }, [setupPolicy.relay.allowRelaySelection, state.context.relaySelection.locked]);

    const handleOpenRelaySelectionPreservingSelection = React.useCallback(() => {
        if (!setupPolicy.relay.allowRelaySelection) {
            return;
        }
        dispatch({ type: 'wizard/goToStep', stepId: 'relay_select' });
    }, [setupPolicy.relay.allowRelaySelection]);

    const handleScan = React.useCallback(async (data: string) => {
        const parsed = parseOnboardingScanPayload(data);
        dispatch({ type: 'wizard/setParsedScanPayload', parsedScanPayload: parsed });
        if (parsed.kind === 'pairing_link' && parsed.serverUrl == null) {
            dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: 'customUrl', serverUrl: null, relayProfileId: null, locked: true } });
            dispatch({ type: 'wizard/setScanStepEnabled', enabled: false });
            dispatch({ type: 'wizard/goToStep', stepId: 'relay_enter_url' });
            return;
        }
        if (parsed.kind === 'relay_url') {
            const relayProfileId = resolveRelayProfileIdForServerUrl({ serverUrl: parsed.serverUrl, canonicalCloudUrl });
            dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: 'customUrl', serverUrl: parsed.serverUrl, relayProfileId, locked: false } });
            dispatch({ type: 'wizard/setRelayLockConfirmationPending', pending: true });
            dispatch({ type: 'wizard/setScanStepEnabled', enabled: false });
            dispatch({ type: 'wizard/goToStep', stepId: 'confirm_relay_lock' });
            return;
        }
        if (parsed.kind === 'pairing_link') {
            dispatch({ type: 'wizard/setAuthIntent', authIntent: 'restore' });
            const relayProfileId = resolveRelayProfileIdForServerUrl({ serverUrl: parsed.serverUrl, canonicalCloudUrl });
            dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: 'customUrl', serverUrl: parsed.serverUrl, relayProfileId, locked: false } });
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
    }, [canonicalCloudUrl]);

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
        const relayProfileId = nextChoiceId === 'customUrl'
            ? resolveRelayProfileIdForServerUrl({ serverUrl: normalized, canonicalCloudUrl })
            : null;
        dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: nextChoiceId, serverUrl: normalized, relayProfileId, locked: false } });
        setOnboardingWizardAwaitingAuthResumeIntent(normalized);
        const nextStepId =
            state.context.platform === 'web' && nextChoiceId === 'thisComputer'
                ? 'auth'
                : state.context.authIntent === 'restore'
                    ? 'auth_restore'
                    : 'auth';
        dispatch({ type: 'wizard/goToStep', stepId: nextStepId });
    }, [canonicalCloudUrl, state.context.authIntent, state.context.platform, state.context.relaySelection.choiceId, urlDraft]);

    const showBack = stepId !== 'welcome';
    const showSkip = canSkipWizardStep(state.context, stepId)
        && stepId !== 'auth'
        && !(
            stepId === 'welcome'
            && welcomeHasKnownRelay
            && (
                props.authEntryOptions.serverAvailability === 'loading'
                || props.authEntryOptions.serverAvailability === 'unavailable'
                || props.authEntryOptions.serverAvailability === 'incompatible'
            )
        );

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
        relayLine: string;
    }>) => (
        <View testID={params.testID} style={styles.relayHintBlock}>
            <Ionicons name="cloud-outline" size={12} style={styles.relayHintIcon} color={theme.colors.textSecondary} />
            <Text testID={`${params.testID}-line`} style={styles.relayHintLine}>{params.relayLine}</Text>
        </View>
    ), [styles]);

    const selectedSavedRelayProfile = React.useMemo(() => {
        const relayProfileId = state.context.relaySelection.relayProfileId;
        if (!relayProfileId) return null;
        return profileChoices.find((profile) => profile.id === relayProfileId) ?? null;
    }, [profileChoices, state.context.relaySelection.relayProfileId, state.context.relaySelection.serverUrl]);

    const selectedRelayFooterUrl = React.useMemo(() => {
        if (stepId !== 'relay_select') return null;
        if (state.context.relaySelection.choiceId === 'cloud') {
            return canonicalCloudUrl || null;
        }
        const rawRelayUrl = state.context.relaySelection.serverUrl ? String(state.context.relaySelection.serverUrl).trim() : '';
        if (rawRelayUrl) {
            return rawRelayUrl;
        }
        return selectedSavedRelayProfile?.serverUrl ?? null;
    }, [canonicalCloudUrl, selectedSavedRelayProfile?.serverUrl, state.context.relaySelection.choiceId, state.context.relaySelection.serverUrl, stepId]);

    const footerHint = React.useMemo(() => {
        if (stepId === 'scan_code') return null;
        if (stepId === 'relay_select') {
            const resolvedRelayUrl = selectedRelayFooterUrl || lastKnownSnapshotRelayUrlRef.current;
            if (!resolvedRelayUrl) return null;
            const relayLine = t('setupOnboarding.currentRelayDescription', { relayUrl: toServerUrlDisplay(resolvedRelayUrl) });
            return renderRelayHint({
                testID: `${props.testID ?? 'onboarding-wizard'}-relay-hint`,
                relayLine,
            });
        }
        if (stepId === 'welcome' && !welcomeHasKnownRelay) return null;
        const rawRelayUrl = state.context.relaySelection.serverUrl ? String(state.context.relaySelection.serverUrl).trim() : '';
        const fallbackRelayUrl = welcomeRelayUrl || lastKnownSnapshotRelayUrlRef.current;
        const resolvedRelayUrl = rawRelayUrl || fallbackRelayUrl;
        if (!resolvedRelayUrl) return null;
        const relayLine = t('setupOnboarding.currentRelayDescription', { relayUrl: toServerUrlDisplay(resolvedRelayUrl) });
        return renderRelayHint({
            testID: `${props.testID ?? 'onboarding-wizard'}-relay-hint`,
            relayLine,
        });
    }, [renderRelayHint, selectedRelayFooterUrl, state.context.relaySelection.choiceId, state.context.relaySelection.serverUrl, stepId, welcomeHasKnownRelay, welcomeRelayUrl]);

    const selectedRelayEndpointForReadiness = React.useMemo(() => {
        if (stepId !== 'relay_select') return null;
        if (state.context.relaySelection.choiceId === 'cloud') {
            const normalizedCloud = canonicalCloudUrl ? normalizeServerUrl(canonicalCloudUrl) : null;
            return normalizedCloud ?? null;
        }
        if (state.context.relaySelection.choiceId === 'customUrl' && !state.context.relaySelection.relayProfileId) {
            // Manual entry mode ("Existing relay"): Continue should always open the URL entry step.
            // Reachability gating applies only to concrete selections (saved profiles / cloud).
            return null;
        }
        if (
            state.context.relaySelection.choiceId === 'thisComputer'
            || state.context.relaySelection.choiceId === 'remoteComputer'
        ) {
            return null;
        }
        const raw = state.context.relaySelection.serverUrl ? String(state.context.relaySelection.serverUrl).trim() : '';
        const normalized = raw ? normalizeServerUrl(raw) : null;
        return normalized ?? null;
    }, [canonicalCloudUrl, state.context.relaySelection.choiceId, state.context.relaySelection.serverUrl, stepId]);

    const primaryDisabled =
        (stepId === 'relay_select' && (
            state.context.relaySelection.choiceId == null
            || (
                selectedRelayEndpointForReadiness != null
                && (
                    relayReadinessByEndpoint.get(selectedRelayEndpointForReadiness)?.status === 'unavailable'
                    || relayReadinessByEndpoint.get(selectedRelayEndpointForReadiness)?.status === 'blocked'
                    || isWebMixedContentBlockedEndpoint(selectedRelayEndpointForReadiness)
                )
            )
        ))
        || (stepId === 'host_relay_local' && !localRelayRuntimeStatus?.relayUrl)
        || (stepId === 'host_relay_remote' && !normalizeServerUrl(String(state.context.relaySelection.serverUrl ?? '').trim()));

    const handleWelcomeAdvance = React.useCallback(() => {
        const selection = state.context.relaySelection;
        const relayUrl = selection.serverUrl ? String(selection.serverUrl).trim() : '';
        if (selection.choiceId === 'customUrl' && relayUrl.length > 0) {
            setOnboardingWizardAwaitingAuthResumeIntent(relayUrl);
            dispatch({ type: 'wizard/goToStep', stepId: state.context.authIntent === 'restore' ? 'auth_restore' : 'auth' });
            return;
        }
        dispatch({ type: 'wizard/goToStep', stepId: 'relay_select' });
    }, [state.context.authIntent, state.context.relaySelection]);

    const handleWelcomeLogin = React.useCallback(() => {
        const relayUrl = welcomeRelayUrl;
        if (relayUrl) {
            setOnboardingWizardAwaitingAuthResumeIntent(relayUrl);
        }
        dispatch({ type: 'wizard/goToStep', stepId: state.context.authIntent === 'restore' ? 'auth_restore' : 'auth' });
    }, [state.context.authIntent, welcomeRelayUrl]);

    const handleRelaySelectAdvance = React.useCallback(async () => {
        setOnboardingWizardAwaitingAuthResumeIntent(state.context.relaySelection.serverUrl);
        await handleAdvance();
    }, [handleAdvance, state.context.relaySelection.serverUrl]);

    const skipLabel = React.useMemo(() => {
        if (stepId === 'welcome') return welcomeHasAuthActions ? t('common.login') : t('common.start');
        if (stepId === 'relay_select') return t('common.next');
        return t('common.skip');
    }, [stepId, welcomeHasAuthActions]);

    const onSkip = React.useMemo(() => {
        if (activeSkipOverride) {
            if (activeSkipOverride.hidden) return undefined;
            return activeSkipOverride.onPress ?? (() => undefined);
        }
        if (!showSkip) return undefined;
        if (stepId === 'welcome') {
            return welcomeHasAuthActions
                ? () => handleWelcomeLogin()
                : () => handleWelcomeAdvance();
        }
        if (stepId === 'relay_select') {
            return async () => handleRelaySelectAdvance();
        }
        return () => dispatch({ type: 'wizard/advance' });
    }, [
        handleRelaySelectAdvance,
        handleWelcomeAdvance,
        handleWelcomeLogin,
        showSkip,
        stepId,
        welcomeHasAuthActions,
        activeSkipOverride,
    ]);

    const skipDisabled = activeSkipOverride?.disabled ?? (
        showSkip && (stepId === 'relay_select' || stepId === 'welcome')
            ? primaryDisabled
            : false
    );

    const onPrimary =
        activePrimaryOverride
            ? activePrimaryOverride.onPress
            : stepId === 'welcome'
                ? (welcomeHasKnownRelay ? undefined : handleWelcomeAdvance)
                : stepId === 'auth_secret_key'
                    ? undefined
                : stepId === 'relay_enter_url'
                    ? handleSaveCustomRelayUrl
                    : stepId === 'relay_select'
                        ? handleRelaySelectAdvance
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
                                    relayProfileId: state.context.relaySelection.relayProfileId ?? null,
                                    locked: true,
                                },
                            });
                            dispatch({ type: 'wizard/setRelayLockConfirmationPending', pending: false });
                            setOnboardingWizardAwaitingAuthResumeIntent(relayUrl);
                            dispatch({ type: 'wizard/goToStep', stepId: state.context.authIntent === 'restore' ? 'auth_restore' : 'auth' });
                        }
                    : stepId === 'desktop_handoff'
                        ? () => {
                            dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: 'thisComputer', serverUrl: null, relayProfileId: null, locked: false } });
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
                            dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: 'thisComputer', serverUrl: relayUrl, relayProfileId: null, locked: false } });
                            dispatch({ type: 'wizard/goToStep', stepId: 'relay_access' });
                        }
                        : stepId === 'relay_access'
                            ? () => {
                                setRelaySwitchDecision('switch');
                                dispatch({ type: 'wizard/setRelaySwitchConfirmationPending', pending: true });
                                dispatch({ type: 'wizard/goToStep', stepId: 'confirm_switch_relay' });
                            }
                        : stepId === 'host_relay_remote'
                            ? async () => {
                                const relayUrlRaw = typeof state.context.relaySelection.serverUrl === 'string'
                                    ? state.context.relaySelection.serverUrl.trim()
                                    : '';
                                const relayUrl = relayUrlRaw ? normalizeServerUrl(relayUrlRaw) : null;
                                if (!relayUrl) {
                                    await Modal.alert(t('common.error'), t('modals.invalidAuthUrl'));
                                    return;
                                }
                                setRelaySwitchDecision('switch');
                                dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: 'customUrl', serverUrl: relayUrl, relayProfileId: null, locked: false } });
                                dispatch({ type: 'wizard/setRelaySwitchConfirmationPending', pending: true });
                                dispatch({ type: 'wizard/goToStep', stepId: 'confirm_switch_relay' });
                            }
                        : stepId === 'confirm_switch_relay'
                            ? async () => {
                                const relayUrlRaw = typeof state.context.relaySelection.serverUrl === 'string'
                                    ? state.context.relaySelection.serverUrl.trim()
                                    : '';
                                const relayUrl = relayUrlRaw ? normalizeServerUrl(relayUrlRaw) : null;
                                if (!relayUrl) {
                                    dispatch({ type: 'wizard/setRelaySwitchConfirmationPending', pending: false });
                                    dispatch({ type: 'wizard/goToStep', stepId: 'relay_select' });
                                    return;
                                }

                                if (relaySwitchDecision === 'switch') {
                                    await upsertActivateAndSwitchServer({ serverUrl: relayUrl, source: 'url', scope: 'device' });
                                    dispatch({
                                        type: 'wizard/setRelaySelection',
                                        relaySelection: {
                                            choiceId: state.context.relaySelection.choiceId ?? 'customUrl',
                                            serverUrl: relayUrl,
                                            relayProfileId: null,
                                            locked: false,
                                        },
                                    });
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
        activeBackOverride?.hidden
            ? undefined
            : (activeBackOverride?.onPress ?? (showBack ? handleBack : undefined));

    let body: React.ReactNode = null;
    const relaySelectionServerUrl = typeof state.context.relaySelection.serverUrl === 'string'
        ? state.context.relaySelection.serverUrl.trim()
        : null;
    const relaySelectBody = (
        <View>
            {profileChoices.map(renderRelayChoiceRow)}
            {relayChoices.map(renderRelayChoiceRow)}
            {renderManualRelayChoiceRow()}
        </View>
    );
    body = renderOnboardingWizardStepBody({
        stepId,
        testIDPrefix: props.testID ?? 'onboarding-wizard',
        styles,
        theme,
        layout: props.layout,
        authEntryOptions: props.authEntryOptions,
        canScanQr,
        welcomeHasKnownRelay,
        welcomeHasAuthActions,
        allowRelaySelection: setupPolicy.relay.allowRelaySelection,
        relaySelectBody,
        urlDraft,
        onUrlDraftChange: setUrlDraft,
        relaySelectionServerUrl,
        lastKnownSnapshotRelayUrl: lastKnownSnapshotRelayUrlRef.current || '',
        relaySwitchDecision,
        onRelaySwitchDecisionChange: setRelaySwitchDecision,
        onLocalRelayRuntimeStatusChange: setLocalRelayRuntimeStatus,
        onWizardPrimaryChange: handleWizardPrimaryChange,
        onWizardBackChange: handleWizardBackChange,
        onWizardSkipChange: handleWizardSkipChange,
        onCreateAccount: props.onCreateAccount,
        onCreateAccountViaProvider: props.onCreateAccountViaProvider,
        onLoginWithKeylessProvider: props.onLoginWithKeylessProvider,
        onLoginWithMtls: props.onLoginWithMtls,
        onStartScan: () => {
            dispatch({ type: 'wizard/setScanStepEnabled', enabled: true });
            dispatch({ type: 'wizard/goToStep', stepId: 'scan_code' });
        },
        onCancelScan: () => {
            dispatch({ type: 'wizard/setScanStepEnabled', enabled: false });
            dispatch({ type: 'wizard/goToStep', stepId: 'welcome' });
        },
        onScan: handleScan,
        onOpenRelaySelectionFromWelcome: handleOpenRelaySelectionFromWelcome,
        onOpenRelaySelectionFromAuth: handleOpenRelaySelectionPreservingSelection,
        onOpenRestore: () => dispatch({ type: 'wizard/goToStep', stepId: 'auth_restore' }),
        onOpenLostAccess: () => dispatch({ type: 'wizard/goToStep', stepId: 'auth_lost_access' }),
        onOpenSecretKeyLogin: () => dispatch({ type: 'wizard/goToStep', stepId: 'auth_secret_key' }),
        onRestoreBackToAuth: () => dispatch({ type: 'wizard/goToStep', stepId: 'auth' }),
        onLostAccessBackToAuth: () => dispatch({ type: 'wizard/goToStep', stepId: 'auth' }),
        onHostRelayLocalAdvance: () => dispatch({ type: 'wizard/goToStep', stepId: 'relay_access' }),
        onHostRelayRemoteAdvance: () => dispatch({ type: 'wizard/goToStep', stepId: 'confirm_switch_relay' }),
        onHostRelayRemoteCancel: () => dispatch({ type: 'wizard/goToStep', stepId: 'relay_select' }),
        onRemoteRelayRuntimeCompleted: handleRemoteRelayRuntimeCompletedChange,
    });

    return (
        <WizardModalShell
            testID={props.testID ?? 'onboarding-wizard'}
            stepIndex={Math.max(0, progress.current - 1)}
            stepCount={Math.max(1, progress.total)}
            titleLeading={stepId === 'welcome' ? <WizardLogotype height={45} testID={`${props.testID ?? 'onboarding-wizard'}-logotype`} /> : undefined}
            title={title}
            subtitle={subtitle ?? undefined}
            onSkip={onSkip}
            skipLabel={activeSkipOverride?.label ?? skipLabel}
            skipDisabled={skipDisabled}
            onBack={onBack ?? (() => {})}
            onPrimary={onPrimary}
            primaryLabel={activePrimaryOverride?.label ?? primaryLabel}
            primaryDisabled={activePrimaryOverride?.disabled ?? primaryDisabled}
            showBack={Boolean(onBack)}
            showSkip={activeSkipOverride ? !activeSkipOverride.hidden : undefined}
            footerHint={footerHint ?? undefined}
        >
            {body}
        </WizardModalShell>
    );
}
