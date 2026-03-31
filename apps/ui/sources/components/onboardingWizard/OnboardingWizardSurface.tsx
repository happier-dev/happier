import * as React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import { AuthEntryView } from '@/components/account/auth/AuthEntryView';
import { TextInput } from '@/components/ui/text/Text';
import { Text } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Modal } from '@/modal';

import { isSameServerUrl, normalizeServerUrl, setActiveServerAndSwitch, upsertActivateAndSwitchServer } from '@/sync/domains/server/activeServerSwitch';
import { getActiveServerSnapshot, isActiveServerSelectionExplicit } from '@/sync/domains/server/serverRuntime';
import { getResetToDefaultServerId, getServerProfileById, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { isLocalishServerUrl } from '@/sync/domains/server/url/serverUrlClassification';
import { toServerUrlDisplay } from '@/sync/domains/server/url/serverUrlDisplay';
import { isRunningOnMac } from '@/utils/platform/platform';
import { isWebQrScannerSupported } from '@/utils/platform/qrScannerSupport';
import { isWebMobileLikeQrScannerHost } from '@/utils/platform/webMobileHeuristics';
import { resolveKnownLocalRelayUrl } from '@/components/settings/server/localControl/resolveKnownLocalRelayUrl';
import { LocalRelayRuntimeControlSection } from '@/components/settings/server/localControl/LocalRelayRuntimeControlSection';
import type { useLocalRelayRuntimeControl } from '@/components/settings/server/localControl/useLocalRelayRuntimeControl';
import { MachineSetupTextField } from '@/components/settings/machines/shared/MachineSetupTextField';

import { QrCodeScannerView } from '@/components/qr/QrCodeScannerView';
import { RestoreIndexEmbedded } from '@/components/onboardingWizard/restore/RestoreIndexEmbedded';
import { LostAccessEmbedded } from '@/components/onboardingWizard/restore/LostAccessEmbedded';

import { RelayDiagram } from './RelayDiagram';
import { WizardLogotype } from './WizardLogotype';
import { WelcomeProvidersShowcase } from './WelcomeProvidersShowcase';
import { WizardTerminalHandoff } from './WizardTerminalHandoff';
import { WizardChoiceRow } from './WizardChoiceRow';
import { WebDesktopHandoffStep } from '@/components/onboardingWizard/WebDesktopHandoffStep';
import { WebDesktopBackgroundServiceHandoffStep } from '@/components/onboardingWizard/WebDesktopBackgroundServiceHandoffStep';
import { canSkipWizardStep, getWizardProgress } from './wizardSelectors';
import { createWizardState, wizardReducer } from './wizardReducer';
import type { WizardRelaySelection, WizardStepId } from './wizardTypes';
import { ConfirmSwitchRelayStep, type RelaySwitchDecision } from './ConfirmSwitchRelayStep';
import { parseOnboardingScanPayload } from './scanPayload';
import { WizardModalShell } from './WizardModalShell';
import { useEndpointReadinessMap } from './useEndpointReadinessMap';
import {
    setOnboardingWizardAwaitingAuthResumeIntent,
} from './wizardResume';
import { getWizardStepDefinition } from './wizardStepRegistry';
import { buildCliInstallCommandForCurrentApp } from './wizardCliCommands';

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
    relayHintLine: {
        ...Typography.default(),
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.textSecondary,
        textAlign: 'center',
    },
    relayGroupTitle: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        marginBottom: 6,
    },
    scanCtaBlock: {
        width: '100%',
        maxWidth: 360,
        alignSelf: 'center',
    },
    remoteRelayHostBlock: {
        width: '100%',
        gap: 16,
    },
    welcomeBody: {
        width: '100%',
        alignItems: 'center',
        gap: 16,
    },
    welcomeAuthBody: {
        width: '100%',
        alignItems: 'center',
        gap: 10,
    },
    authEntryWrapper: {
        width: '100%',
        alignItems: 'center',
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
    const savedProfiles = listServerProfiles()
        .map((profile) => ({
            id: profile.id,
            serverUrl: normalizeServerUrl(profile.serverUrl) ?? profile.serverUrl,
        }))
        .filter((profile) => profile.serverUrl && (!canonicalCloudUrl || !isSameServerUrl(profile.serverUrl, canonicalCloudUrl)));

    if (serverUrl && isLocalishServerUrl(serverUrl)) {
        return {
            choiceId: 'thisComputer',
            serverUrl,
            relayProfileId: null,
            locked: false,
        };
    }

    if (serverUrl) {
        const matchesCloud = canonicalCloudUrl ? isSameServerUrl(serverUrl, canonicalCloudUrl) : false;
        const matchingProfile = savedProfiles.find((profile) => isSameServerUrl(profile.serverUrl, serverUrl));
        return {
            choiceId: matchesCloud ? 'cloud' : 'customUrl',
            serverUrl,
            relayProfileId: matchesCloud ? null : (matchingProfile?.id ?? 'active'),
            locked: false,
        };
    }

    return {
        choiceId: 'cloud',
        serverUrl: canonicalCloudUrl || null,
        relayProfileId: null,
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
    const snapshotRelayUrl = React.useMemo(() => {
        const snapshot = getActiveServerSnapshot();
        return snapshot.serverUrl ? String(snapshot.serverUrl).trim() : '';
    }, []);
    const lastKnownSnapshotRelayUrlRef = React.useRef<string>(snapshotRelayUrl);
    React.useEffect(() => {
        const snapshot = getActiveServerSnapshot();
        const url = snapshot.serverUrl ? String(snapshot.serverUrl).trim() : '';
        if (url) {
            lastKnownSnapshotRelayUrlRef.current = url;
        }
    });

    const canScanQr = React.useMemo(
        () => resolveCanScanQr({ width, height, platform: Platform.OS }),
        [height, width],
    );

    const [urlDraft, setUrlDraft] = React.useState('');
    const [remoteSshTargetDraft, setRemoteSshTargetDraft] = React.useState('');
    const [remoteSshAuth, setRemoteSshAuth] = React.useState<'agent' | 'keyfile'>('agent');
    const [remoteIdentityFilePathDraft, setRemoteIdentityFilePathDraft] = React.useState('');
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
    const welcomeHasExplicitRelaySelection = stepId === 'welcome'
        && (
            state.history.length > 0
            || isActiveServerSelectionExplicit()
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

    const relayChoices: readonly WizardChoice[] = React.useMemo(() => ([
        {
            id: 'cloud',
            title: t('setupOnboarding.relayCloudTitle'),
            subtitle: t('setupOnboarding.relayCloudSubtitle'),
            icon: 'cloud-outline' as React.ComponentProps<typeof Ionicons>['name'],
            badge: t('setupOnboarding.recommendedBadge'),
        },
        {
            id: 'thisComputer',
            title: t('setupOnboarding.relayOnThisComputerTitle'),
            subtitle: t('setupOnboarding.relayOnThisComputerSubtitle'),
            icon: 'laptop-outline' as React.ComponentProps<typeof Ionicons>['name'],
            disabled: Platform.OS !== 'web' && !props.isDesktopShell,
        },
        ...(props.isDesktopShell ? [{
            id: 'remoteComputer' as const,
            title: t('setupOnboarding.relayOnRemoteComputerTitle'),
            subtitle: t('setupOnboarding.relayOnRemoteComputerSubtitle'),
            icon: 'desktop-outline' as React.ComponentProps<typeof Ionicons>['name'],
        }] : []),
    ]), [props.isDesktopShell]);

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
        if (knownPrefilledUrl && (!canonicalCloudUrl || !isSameServerUrl(knownPrefilledUrl, canonicalCloudUrl))) {
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

    const { readinessByEndpoint: relayReadinessByEndpoint, retryEndpoint } = useEndpointReadinessMap({
        endpoints: stepId === 'relay_select' ? profileChoices.map((profile) => profile.serverUrl) : [],
        enabled: stepId === 'relay_select',
        timeoutMs: 900,
    });

    const selectRelayChoice = React.useCallback((choiceId: WizardChoice['id']) => {
        const snapshot = getActiveServerSnapshot();
        const canonicalCloudProfile = resolveCanonicalCloudRelayProfile();
        const next: WizardRelaySelection =
            choiceId === 'cloud'
                ? {
                    choiceId,
                    serverUrl: canonicalCloudProfile?.serverUrl ?? null,
                    relayProfileId: null,
                    locked: false,
                }
                : choiceId === 'thisComputer'
                    ? {
                        choiceId,
                        serverUrl: resolveKnownLocalRelayUrl({
                            activeServerUrl: snapshot.serverUrl,
                            activeLocalRelayUrl: snapshot.activeLocalRelayUrl,
                        }),
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
    }, [state.context.relaySelection]);

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
            const selectedServerUrl = state.context.relaySelection.serverUrl ? String(state.context.relaySelection.serverUrl).trim() : '';
            const selected = Boolean(
                state.context.relaySelection.relayProfileId === profile.id
                || (
                    state.context.relaySelection.choiceId === 'customUrl'
                    && selectedServerUrl
                    && isSameServerUrl(selectedServerUrl, profile.serverUrl)
                ),
            );
            const readiness = relayReadinessByEndpoint.get(profile.serverUrl);
            const unavailable = readiness?.status === 'unavailable';
            const disabled = Boolean(profile.disabled) || state.context.relaySelection.locked || unavailable;
            return (
                <WizardChoiceRow
                    key={`profile:${profile.id}`}
                    testID={`${props.testID ?? 'onboarding-wizard'}-relay:profile:${profile.id}`}
                    selected={selected}
                    disabled={disabled}
                    onPress={() => selectProfileRelay(profile)}
                    icon="link-outline"
                    title={profile.name}
                    subtitle={toServerUrlDisplay(profile.serverUrl)}
                    badge={unavailable ? t('common.unavailable') : undefined}
                    secondaryAction={unavailable ? {
                        testID: `${props.testID ?? 'onboarding-wizard'}-relay:profile:${profile.id}-retry`,
                        title: t('common.retry'),
                        onPress: () => retryEndpoint(profile.serverUrl),
                    } : undefined}
                />
            );
        }

        const fixed = choice as WizardChoice;
        const selected = state.context.relaySelection.choiceId === fixed.id;
        const disabled = Boolean(fixed.disabled) || state.context.relaySelection.locked;
        return (
            <WizardChoiceRow
                key={fixed.id}
                testID={`${props.testID ?? 'onboarding-wizard'}-relay:${fixed.id}`}
                selected={selected}
                disabled={disabled}
                onPress={() => {
                    selectRelayChoice(fixed.id);
                }}
                icon={fixed.icon}
                title={fixed.title}
                subtitle={fixed.subtitle}
                badge={fixed.badge}
            />
        );
    };

    const renderManualRelayChoiceRow = () => {
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
                    relayProfileId: selection.relayProfileId ?? null,
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
                    serverUrl: canonicalCloudProfile?.serverUrl ?? null,
                    relayProfileId: null,
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
                        relayProfileId: null,
                        locked: false,
                    },
                });
                dispatch({ type: 'wizard/goToStep', stepId: 'auth' });
                return;
            }

            dispatch({ type: 'wizard/goToStep', stepId: 'host_relay_local' });
            return;
        }

        if (selection.choiceId === 'remoteComputer') {
            const rawServerUrl = selection.serverUrl ? String(selection.serverUrl).trim() : '';
            const resolved = rawServerUrl ? normalizeServerUrl(rawServerUrl) : null;
            if (resolved) {
                if (!isSameServerUrl(snapshot.serverUrl, resolved)) {
                    await upsertActivateAndSwitchServer({ serverUrl: resolved, source: 'url', scope: 'device' });
                }
                dispatch({
                    type: 'wizard/setRelaySelection',
                    relaySelection: {
                        choiceId: 'remoteComputer',
                        serverUrl: resolved,
                        relayProfileId: null,
                        locked: false,
                    },
                });
                setOnboardingWizardAwaitingAuthResumeIntent(resolved);
                dispatch({ type: 'wizard/goToStep', stepId: 'auth' });
                return;
            }
            dispatch({ type: 'wizard/goToStep', stepId: 'host_relay_remote' });
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
            dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: 'customUrl', serverUrl: null, relayProfileId: null, locked: true } });
            dispatch({ type: 'wizard/setScanStepEnabled', enabled: false });
            dispatch({ type: 'wizard/goToStep', stepId: 'relay_enter_url' });
            return;
        }
        if (parsed.kind === 'relay_url') {
            dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: 'customUrl', serverUrl: parsed.serverUrl, relayProfileId: null, locked: false } });
            dispatch({ type: 'wizard/setRelayLockConfirmationPending', pending: true });
            dispatch({ type: 'wizard/setScanStepEnabled', enabled: false });
            dispatch({ type: 'wizard/goToStep', stepId: 'confirm_relay_lock' });
            return;
        }
        if (parsed.kind === 'pairing_link') {
            dispatch({ type: 'wizard/setAuthIntent', authIntent: 'restore' });
            dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: 'customUrl', serverUrl: parsed.serverUrl, relayProfileId: null, locked: false } });
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
        dispatch({ type: 'wizard/setRelaySelection', relaySelection: { choiceId: nextChoiceId, serverUrl: normalized, relayProfileId: null, locked: false } });
        setOnboardingWizardAwaitingAuthResumeIntent(normalized);
        const nextStepId =
            state.context.platform === 'web' && nextChoiceId === 'thisComputer'
                ? 'background_service_handoff'
                : state.context.authIntent === 'restore'
                    ? 'auth_restore'
                    : 'auth';
        dispatch({ type: 'wizard/goToStep', stepId: nextStepId });
    }, [state.context.authIntent, state.context.platform, state.context.relaySelection.choiceId, urlDraft]);

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
            <Text testID={`${params.testID}-line`} style={styles.relayHintLine}>{params.relayLine}</Text>
        </View>
    ), [styles]);

    const selectedSavedRelayProfile = React.useMemo(() => {
        const selectedServerUrl = state.context.relaySelection.serverUrl ? String(state.context.relaySelection.serverUrl).trim() : '';
        if (!selectedServerUrl) return null;
        if (state.context.relaySelection.relayProfileId) {
            return profileChoices.find((profile) => profile.id === state.context.relaySelection.relayProfileId) ?? null;
        }
        return profileChoices.find((profile) => isSameServerUrl(profile.serverUrl, selectedServerUrl)) ?? null;
    }, [profileChoices, state.context.relaySelection.relayProfileId, state.context.relaySelection.serverUrl]);

    const footerHint = React.useMemo(() => {
        if (stepId === 'scan_code') return null;
        if (stepId === 'welcome' && !welcomeHasKnownRelay) return null;
        const rawRelayUrl = state.context.relaySelection.serverUrl ? String(state.context.relaySelection.serverUrl).trim() : '';
        const fallbackRelayUrl = welcomeRelayUrl || lastKnownSnapshotRelayUrlRef.current;
        const resolvedRelayUrl = rawRelayUrl || fallbackRelayUrl;
        if (!resolvedRelayUrl) return null;
        const relayLine =
            state.context.relaySelection.choiceId === 'cloud'
                ? t('setupOnboarding.selectedRelayFooterLine', { relay: t('setupOnboarding.relayCloudTitle') })
                : t('setupOnboarding.selectedRelayFooterLine', { relay: toServerUrlDisplay(resolvedRelayUrl) });
        return renderRelayHint({
            testID: `${props.testID ?? 'onboarding-wizard'}-relay-hint`,
            relayLine,
        });
    }, [renderRelayHint, state.context.relaySelection.choiceId, state.context.relaySelection.serverUrl, stepId, welcomeHasKnownRelay, welcomeRelayUrl]);

    const selectedRelayEndpointForReadiness = React.useMemo(() => {
        if (stepId !== 'relay_select') return null;
        if (state.context.relaySelection.choiceId === 'cloud') return null;
        const raw = state.context.relaySelection.serverUrl ? String(state.context.relaySelection.serverUrl).trim() : '';
        const normalized = raw ? normalizeServerUrl(raw) : null;
        return normalized ?? null;
    }, [state.context.relaySelection.choiceId, state.context.relaySelection.serverUrl, stepId]);

    const primaryDisabled =
        (stepId === 'relay_select' && (
            state.context.relaySelection.choiceId == null
            || (
                selectedRelayEndpointForReadiness != null
                && relayReadinessByEndpoint.get(selectedRelayEndpointForReadiness)?.status === 'unavailable'
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
    }, [handleRelaySelectAdvance, handleWelcomeAdvance, handleWelcomeLogin, showSkip, stepId, welcomeHasAuthActions]);

    const skipDisabled = showSkip && (stepId === 'relay_select' || stepId === 'welcome')
        ? primaryDisabled
        : false;

    const onPrimary =
        stepId === 'welcome'
            ? (welcomeHasKnownRelay ? undefined : handleWelcomeAdvance)
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
        showBack
            ? handleBack
            : undefined;

    let body: React.ReactNode = null;
    if (stepId === 'welcome') {
        if (welcomeHasKnownRelay) {
            body = (
                <View testID={`${props.testID ?? 'onboarding-wizard'}-welcome-auth`} style={styles.welcomeAuthBody}>
                    <View style={styles.authEntryWrapper}>
                        <AuthEntryView
                            layout={props.layout}
                            isDesktopShell={false}
                            options={props.authEntryOptions}
                            onOpenSetup={() => {}}
                            onChangeRelay={() => dispatch({ type: 'wizard/goToStep', stepId: 'relay_select' })}
                            onRestore={() => dispatch({ type: 'wizard/goToStep', stepId: 'auth_restore' })}
                            onCreateAccount={props.onCreateAccount}
                            onCreateAccountViaProvider={props.onCreateAccountViaProvider}
                            onLoginWithKeylessProvider={props.onLoginWithKeylessProvider}
                            onLoginWithMtls={props.onLoginWithMtls}
                        />
                    </View>
                    {welcomeHasAuthActions ? (
                        <View style={styles.scanCtaBlock}>
                            <RoundButton
                                testID={`${props.testID ?? 'onboarding-wizard'}-change-relay`}
                                size="small"
                                display="inverted"
                                title={t('setupOnboarding.changeRelayAction')}
                                onPress={() => dispatch({ type: 'wizard/goToStep', stepId: 'relay_select' })}
                            />
                        </View>
                    ) : null}
                </View>
            );
        } else {
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
        }
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
                    {profileChoices.length > 0 ? (
                        <Text testID={`${props.testID ?? 'onboarding-wizard'}-saved-relays-title`} style={styles.relayGroupTitle}>
                            {t('setupOnboarding.savedRelaysTitle')}
                        </Text>
                    ) : null}
                    {profileChoices.map(renderRelayChoiceRow)}
                    {relayChoices.map(renderRelayChoiceRow)}
                    {renderManualRelayChoiceRow()}
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
        const relayUrl = typeof state.context.relaySelection.serverUrl === 'string'
            ? state.context.relaySelection.serverUrl.trim()
            : '';
        body = (
            <WebDesktopBackgroundServiceHandoffStep
                testID={`${props.testID ?? 'onboarding-wizard'}-background-service-handoff`}
                relayUrl={relayUrl}
            />
        );
    } else if (stepId === 'host_relay_local') {
        body = (
            <LocalRelayRuntimeControlSection
                onStatusChange={setLocalRelayRuntimeStatus}
            />
        );
    } else if (stepId === 'host_relay_remote') {
        const relayUrl = typeof state.context.relaySelection.serverUrl === 'string'
            ? state.context.relaySelection.serverUrl
            : '';
        const sshTarget = remoteSshTargetDraft.trim() || t('settings.machineSetupRemoteSshTargetPlaceholder');
        const identityFileFlag = remoteSshAuth === 'keyfile' && remoteIdentityFilePathDraft.trim()
            ? ` --identity-file ${remoteIdentityFilePathDraft.trim()}`
            : '';
        const cliInstallCommand = buildCliInstallCommandForCurrentApp();
        body = (
            <View testID={`${props.testID ?? 'onboarding-wizard'}-host-remote-relay`} style={styles.remoteRelayHostBlock}>
                <MachineSetupTextField
                    testID={`${props.testID ?? 'onboarding-wizard'}-remote-ssh-target`}
                    label={t('settings.machineSetupRemoteSshTargetLabel')}
                    placeholder={t('settings.machineSetupRemoteSshTargetPlaceholder')}
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={remoteSshTargetDraft}
                    onChangeText={setRemoteSshTargetDraft}
                />
                <ItemGroup>
                    <Item
                        testID={`${props.testID ?? 'onboarding-wizard'}-remote-ssh-auth:agent`}
                        title={t('settings.machineSetupRemoteSshAgentAuthLabel')}
                        selected={remoteSshAuth === 'agent'}
                        onPress={() => {
                            setRemoteSshAuth('agent');
                            setRemoteIdentityFilePathDraft('');
                        }}
                    />
                    <Item
                        testID={`${props.testID ?? 'onboarding-wizard'}-remote-ssh-auth:keyfile`}
                        title={t('settings.machineSetupRemoteSshKeyFileAuthLabel')}
                        selected={remoteSshAuth === 'keyfile'}
                        onPress={() => setRemoteSshAuth('keyfile')}
                    />
                </ItemGroup>
                {remoteSshAuth === 'keyfile' ? (
                    <MachineSetupTextField
                        testID={`${props.testID ?? 'onboarding-wizard'}-remote-identity-file`}
                        label={t('settings.machineSetupRemoteSshIdentityFileLabel')}
                        autoCapitalize="none"
                        autoCorrect={false}
                        value={remoteIdentityFilePathDraft}
                        onChangeText={setRemoteIdentityFilePathDraft}
                    />
                ) : null}
                <WizardTerminalHandoff
                    testID={`${props.testID ?? 'onboarding-wizard'}-remote-relay-handoff`}
                    steps={[
                        {
                            title: t('setupOnboarding.webDesktopOnlyCliTitle'),
                            subtitle: t('setupOnboarding.webDesktopOnlyCliSubtitle'),
                            code: cliInstallCommand,
                            scrollTestIDSuffix: 'cli-install',
                        },
                        {
                            title: t('setupOnboarding.remoteRelayHostInstallTitle'),
                            subtitle: t('setupOnboarding.relayOnRemoteComputerSubtitle'),
                            code: `happier relay host install --ssh ${sshTarget}${identityFileFlag} --mode user`,
                            scrollTestIDSuffix: 'remote-relay-install',
                        },
                        {
                            title: t('setupOnboarding.webDesktopOnlyRelayStatusTitle'),
                            subtitle: t('setupOnboarding.webDesktopOnlyRelayStatusSubtitle'),
                            code: `happier relay host status --ssh ${sshTarget}${identityFileFlag} --json`,
                            scrollTestIDSuffix: 'remote-relay-status',
                        },
                    ]}
                />
                <View style={styles.urlBlock}>
                    <TextInput
                        testID={`${props.testID ?? 'onboarding-wizard'}-remote-relay-url-input`}
                        placeholder={t('common.urlPlaceholder')}
                        placeholderTextColor={theme.colors.textSecondary}
                        autoCapitalize="none"
                        autoCorrect={false}
                        value={relayUrl}
                        onChangeText={(value) => {
                            dispatch({
                                type: 'wizard/setRelaySelection',
                                relaySelection: {
                                    ...state.context.relaySelection,
                                    serverUrl: value,
                                },
                            });
                        }}
                        style={styles.urlInput}
                    />
                    <Text style={styles.urlHint}>{t('setupOnboarding.webDesktopOnlyRelayStatusSubtitle')}</Text>
                </View>
            </View>
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
                <View style={styles.authEntryWrapper}>
                    <AuthEntryView
                        layout={props.layout}
                        isDesktopShell={false}
                        options={props.authEntryOptions}
                        onOpenSetup={() => {}}
                        onChangeRelay={() => dispatch({ type: 'wizard/goToStep', stepId: 'relay_select' })}
                        onRestore={() => dispatch({ type: 'wizard/goToStep', stepId: 'auth_restore' })}
                        onCreateAccount={props.onCreateAccount}
                        onCreateAccountViaProvider={props.onCreateAccountViaProvider}
                        onLoginWithKeylessProvider={props.onLoginWithKeylessProvider}
                        onLoginWithMtls={props.onLoginWithMtls}
                    />
                </View>
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
            onSkip={onSkip}
            skipLabel={skipLabel}
            skipDisabled={skipDisabled}
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
