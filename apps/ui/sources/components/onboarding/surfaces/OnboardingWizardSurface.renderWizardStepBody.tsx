import * as React from 'react';
import { View } from 'react-native';

import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import { AuthEntryView } from '@/components/account/auth/AuthEntryView';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';

import { normalizeServerUrl } from '@/sync/domains/server/activeServerSwitch';

import { QrCodeScannerView } from '@/components/qr/QrCodeScannerView';
import { WebDesktopRelayHostHandoffContent } from '@/components/onboarding/steps/webDesktop/WebDesktopRelayHostHandoffContent';
import { WebDesktopDownloadCta } from '@/components/onboarding/steps/webDesktop/WebDesktopDownloadCta';
import { MachineArrivalCard } from '@/components/onboarding/detection/MachineArrivalCard';
import { LocalRelayAccessControlSection } from '@/components/settings/server/localControl/LocalRelayAccessControlSection';
import { ServerReachabilityRemediationCard } from '@/components/settings/server/sections/ServerReachabilityRemediationCard';
import type {
    EndpointReachabilityRemediation,
    EndpointReachabilityRemediationAction,
} from '@/components/serverReachability/remediation';
import type { RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';
import { RelayAccessPrerequisitesStep } from '@/components/onboarding/steps/relayAccess/RelayAccessPrerequisitesStep';
import type { SystemTaskRunState } from '@/components/systemTasks/types';

import { RestoreIndexEmbedded } from '@/components/onboarding/restore/RestoreIndexEmbedded';
import { LostAccessEmbedded } from '@/components/onboarding/restore/LostAccessEmbedded';
import { SecretKeyLoginEmbedded } from '@/components/onboarding/restore/SecretKeyLoginEmbedded';
import { WelcomeDecisionPanel } from '../preAuth/WelcomeDecisionPanel';

import type { RelayHostLocalChecklistRuntimeStatus } from '../checklists/relayHostLocal/types';
import { RelayHostLocalChecklistStep } from '../checklists/relayHostLocal/RelayHostLocalChecklistStep';
import { RemoteSshChecklistStep } from '../checklists/remoteSsh/RemoteSshChecklistStep';
import type { RemoteSshChecklistMode } from '../checklists/remoteSsh/types';
import type { WizardStepId } from '../state/wizardTypes';
import { ConfirmSwitchRelayStep, type RelaySwitchDecision } from '../steps/ConfirmSwitchRelayStep';

import type { OnboardingWizardSurfaceStyles } from './OnboardingWizardSurface.styles';

type WizardPrimaryOverride = Readonly<{
    label: string;
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

export function renderOnboardingWizardStepBody(params: Readonly<{
    stepId: WizardStepId;
    testIDPrefix: string;
    styles: OnboardingWizardSurfaceStyles;
    theme: Readonly<{ colors: Readonly<{ text: Readonly<{ secondary: string }> }> }>;

    layout: 'portrait' | 'landscape';
    isDesktopShell: boolean;
    authEntryOptions: AuthEntryOptions;

    canScanQr: boolean;
    welcomeHasKnownRelay: boolean;
    welcomeHasAuthActions: boolean;
    allowRelaySelection: boolean;

    relaySelectBody: React.ReactNode;

    urlDraft: string;
    onUrlDraftChange: (next: string) => void;

    relaySelectionServerUrl: string | null;
    confirmRelayUrl: string | null;
    serverProfileId: string | null;
    relayAccessTarget: RelayAccessTaskTarget;
    lastKnownSnapshotRelayUrl: string;
    reachabilityRemediation: EndpointReachabilityRemediation | null;
    reachabilityRemediationTaskSnapshot: SystemTaskRunState | null;
    reachabilityRemediationError: string | null;
    onReachabilityRemediationAction: (actionId: EndpointReachabilityRemediationAction['id']) => Promise<void>;
    onRelayAccessShareUrlChange: (shareUrl: string | null) => void;

    relaySwitchDecision: RelaySwitchDecision;
    onRelaySwitchDecisionChange: (next: RelaySwitchDecision) => void;

    onLocalRelayRuntimeStatusChange: (next: RelayHostLocalChecklistRuntimeStatus | null) => void;

    onWizardPrimaryChange: (next: WizardPrimaryOverride | null) => void;
    onWizardBackChange: (next: WizardBackOverride | null) => void;
    onWizardSkipChange: (next: WizardSkipOverride | null) => void;

    relayAccessProviderId: RelayAccessProviderId | null;
    onRelayAccessProviderIdChange: (next: RelayAccessProviderId | null) => void;
    onRelayAccessProviderDetailsRequested: (providerId: RelayAccessProviderId) => void;

    onCreateAccount: () => Promise<void> | void;
    onCreateAccountViaProvider: (providerId: string) => Promise<void> | void;
    onLoginWithKeylessProvider: (providerId: string) => Promise<void> | void;
    onLoginWithMtls: () => Promise<void> | void;

    onStartScan: () => void;
    onCancelScan: () => void;
    onScan: (payload: string) => void;

    onOpenRelaySelectionFromWelcome: () => void;
    onOpenRelaySelectionFromAuth: () => void;
    onOpenSetup: () => void;

    onOpenRestore: () => void;
    onOpenLostAccess: () => void;
    onOpenSecretKeyLogin: () => void;
    onRestoreBackToAuth: () => void;
    onLostAccessBackToAuth: () => void;

    onHostRelayLocalAdvance: () => void;
    onRelayAccessAdvance: () => void;
    onHostRelayRemoteAdvance: () => void;
    onHostRelayRemoteCancel: () => void;

    onRemoteRelayRuntimeCompleted: (payload: Readonly<{
        machineId: string | null;
        relayRuntimeUrl: string | null;
        relayAccessTarget: RelayAccessTaskTarget | null;
        mode: RemoteSshChecklistMode;
    }>) => void;
}>): React.ReactNode {
    if (params.stepId === 'welcome') {
        return (
            <WelcomeDecisionPanel
                authEntryOptions={params.authEntryOptions}
                onCreateAccount={params.onCreateAccount}
                onCreateAccountViaProvider={params.onCreateAccountViaProvider}
                onLoginWithKeylessProvider={params.onLoginWithKeylessProvider}
                onLoginWithMtls={params.onLoginWithMtls}
                onOpenRestore={params.onOpenRestore}
                onChangeRelay={params.allowRelaySelection ? params.onOpenRelaySelectionFromWelcome : () => {}}
                canScanQr={params.canScanQr}
                onStartScan={params.onStartScan}
            />
        );
    }

    if (params.stepId === 'scan_code') {
        return (
            <QrCodeScannerView
                testIDPrefix={`${params.testIDPrefix}-scan`}
                title={t('setupOnboarding.scanQrCode')}
                permissionRequiredMessage={t('modals.cameraPermissionsRequiredToScanQr')}
                embedded
                onCancel={params.onCancelScan}
                onScan={params.onScan}
            />
        );
    }

    if (params.stepId === 'relay_select') {
        return (
            <View testID="relay-select-route-content" style={params.styles.relaySelectRouteContent}>
                {params.relaySelectBody}
            </View>
        );
    }

    if (params.stepId === 'confirm_relay_lock') {
        return (
            <View
                testID={`${params.testIDPrefix}-confirm-relay-lock`}
                style={params.styles.confirmRelayLockCard}
            >
                <Text style={params.styles.confirmRelayLockText}>
                    {t('setupOnboarding.confirmSwitchRelayWarning')}
                </Text>
            </View>
        );
    }

    if (params.stepId === 'relay_enter_url') {
        return (
            <>
                <View style={params.styles.urlBlock}>
                    <TextInput
                        testID={`${params.testIDPrefix}-relay-url-input`}
                        placeholder={t('common.urlPlaceholder')}
                        placeholderTextColor={params.theme.colors.text.secondary}
                        autoCapitalize="none"
                        autoCorrect={false}
                        value={params.urlDraft}
                        onChangeText={params.onUrlDraftChange}
                        style={params.styles.urlInput}
                    />
                    <Text style={params.styles.urlHint}>{t('setupOnboarding.relayCustomUrlSubtitle')}</Text>
                </View>
                {params.reachabilityRemediation ? (
                    <ServerReachabilityRemediationCard
                        remediation={params.reachabilityRemediation}
                        taskSnapshot={params.reachabilityRemediationTaskSnapshot}
                        onAction={params.onReachabilityRemediationAction}
                    />
                ) : null}
                {params.reachabilityRemediationError ? (
                    <Text style={params.styles.urlHint}>{params.reachabilityRemediationError}</Text>
                ) : null}
            </>
        );
    }

    if (params.stepId === 'background_service_handoff') {
        return (
            <View testID={`${params.testIDPrefix}-background-service-handoff`} style={params.styles.urlBlock}>
                <MachineArrivalCard
                    mode="instructional"
                    testID={`${params.testIDPrefix}-background-service-arrival`}
                    serverUrl={params.relaySelectionServerUrl ?? ''}
                />
                <WebDesktopDownloadCta testIDPrefix={`${params.testIDPrefix}-background-service-desktop-app`} />
            </View>
        );
    }

    if (params.stepId === 'host_relay_local') {
        return (
            <RelayHostLocalChecklistStep
                testID={`${params.testIDPrefix}-relay-host-local`}
                onStatusChange={params.onLocalRelayRuntimeStatusChange}
                onWizardPrimaryChange={params.onWizardPrimaryChange}
                onRequestAdvance={params.onHostRelayLocalAdvance}
            />
        );
    }

    if (params.stepId === 'relay_access') {
        const upstreamUrl = params.relaySelectionServerUrl ? normalizeServerUrl(params.relaySelectionServerUrl.trim()) : null;
        return (
            <LocalRelayAccessControlSection
                upstreamUrl={upstreamUrl}
                serverProfileId={params.serverProfileId}
                target={params.relayAccessTarget}
                presentation="wizard"
                onShareUrlChange={params.onRelayAccessShareUrlChange}
                onWizardPrimaryChange={params.onWizardPrimaryChange}
                onRequestAdvance={params.onRelayAccessAdvance}
                onWizardSelectedProviderIdChange={params.onRelayAccessProviderIdChange}
                onWizardRequestProviderDetails={params.onRelayAccessProviderDetailsRequested}
                wizardSelectedProviderId={params.relayAccessProviderId}
            />
        );
    }

    if (params.stepId === 'relay_access_prereqs') {
        const upstreamUrl = params.relaySelectionServerUrl ? normalizeServerUrl(params.relaySelectionServerUrl.trim()) : null;
        return (
            <RelayAccessPrerequisitesStep
                testID={`${params.testIDPrefix}-relay-access-prereqs`}
                providerId={params.relayAccessProviderId}
                upstreamUrl={upstreamUrl}
                serverProfileId={params.serverProfileId}
                target={params.relayAccessTarget}
                onWizardPrimaryChange={params.onWizardPrimaryChange}
                onRequestAdvance={params.onRelayAccessAdvance}
            />
        );
    }

    if (params.stepId === 'host_relay_remote') {
        const relayUrl = params.relaySelectionServerUrl ?? '';
        const fallbackRelayUrl = params.lastKnownSnapshotRelayUrl || '';
        return (
            <RemoteSshChecklistStep
                testID={`${params.testIDPrefix}-remote-ssh`}
                mode="remoteRelayHost"
                relayUrl={relayUrl || fallbackRelayUrl}
                webappUrl={relayUrl || fallbackRelayUrl || undefined}
                initialInstallRelayRuntime={true}
                onWizardPrimaryChange={params.onWizardPrimaryChange}
                onWizardBackChange={params.onWizardBackChange}
                onWizardSkipChange={params.onWizardSkipChange}
                onCompleted={params.onRemoteRelayRuntimeCompleted}
                onRequestAdvance={params.onHostRelayRemoteAdvance}
                onCancel={params.onHostRelayRemoteCancel}
            />
        );
    }

    if (params.stepId === 'confirm_switch_relay') {
        return (
            <>
                <ConfirmSwitchRelayStep
                    testIDPrefix={params.testIDPrefix}
                    relayUrl={params.confirmRelayUrl ?? ''}
                    decision={params.relaySwitchDecision}
                    onDecisionChange={params.onRelaySwitchDecisionChange}
                />
                {params.reachabilityRemediation ? (
                    <ServerReachabilityRemediationCard
                        remediation={params.reachabilityRemediation}
                        taskSnapshot={params.reachabilityRemediationTaskSnapshot}
                        onAction={params.onReachabilityRemediationAction}
                    />
                ) : null}
                {params.reachabilityRemediationError ? (
                    <Text style={params.styles.urlHint}>{params.reachabilityRemediationError}</Text>
                ) : null}
            </>
        );
    }

    if (params.stepId === 'auth') {
        return (
            <>
                <View style={params.styles.authEntryWrapper}>
                    <AuthEntryView
                        layout={params.layout}
                        isDesktopShell={params.isDesktopShell}
                        showOpenSetupAction={false}
                        options={params.authEntryOptions}
                        onOpenSetup={params.onOpenSetup}
                        onChangeRelay={params.onOpenRelaySelectionFromAuth}
                        onRestore={params.onOpenRestore}
                        onCreateAccount={params.onCreateAccount}
                        onCreateAccountViaProvider={params.onCreateAccountViaProvider}
                        onLoginWithKeylessProvider={params.onLoginWithKeylessProvider}
                        onLoginWithMtls={params.onLoginWithMtls}
                    />
                </View>
                <View style={params.styles.scanCtaBlock}>
                    <RoundButton
                        testID={`${params.testIDPrefix}-lost-access`}
                        size="small"
                        display="inverted"
                        title={t('setupOnboarding.authLostAccessTitle')}
                        onPress={params.onOpenLostAccess}
                    />
                </View>
            </>
        );
    }

    if (params.stepId === 'desktop_handoff') {
        return <WebDesktopRelayHostHandoffContent testID={`${params.testIDPrefix}-desktop-handoff`} />;
    }

    if (params.stepId === 'auth_restore') {
        return (
            <View testID="restore-route-content">
                <RestoreIndexEmbedded
                    onBack={params.onRestoreBackToAuth}
                    onOpenSecretKeyLogin={params.onOpenSecretKeyLogin}
                />
            </View>
        );
    }

    if (params.stepId === 'auth_secret_key') {
        return <SecretKeyLoginEmbedded />;
    }

    if (params.stepId === 'auth_lost_access') {
        return <LostAccessEmbedded onBack={params.onLostAccessBackToAuth} />;
    }

    return null;
}
