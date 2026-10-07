import * as React from 'react';
import { View } from 'react-native';

import type { AuthEntryOptions } from '@/components/account/auth/useAuthEntryOptions';
import type { AccountServiceEntryOptions } from '@/components/account/auth/useAccountServiceEntryOptions';
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
import { SecretKeyLoginForm } from '@/components/account/restore/SecretKeyLoginForm';
import { resolveHomeAuthenticationTarget } from '@/auth/flows/resolveHomeAuthenticationTarget';
import { AccountServiceSelectionForm, type AccountServiceSelectionFormProps } from '@/components/account/auth/AccountServiceSelectionForm';
import { readAccountServiceDisplayName } from '@/components/account/auth/accountServiceDisplayName';
import { AccountDirectoryKeyLoginForm, type AccountDirectoryKeyLoginOutcome } from '@/components/account/auth/AccountDirectoryKeyLoginForm';
import { AccountServiceHomeAuthenticationAdapter } from '@/components/account/auth/AccountServiceHomeAuthenticationAdapter';
import { AccountServiceContinuation } from '@/components/account/auth/AccountServiceContinuation';
import type { AccountPostAuthInput, AccountPostAuthResult } from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';
import { AUTHENTICATED_ACCOUNT_ENTRY_ROUTE } from '@/components/navigation/accountEntry/authenticatedAccountEntryRoute';
import type { AccountContinuationIntent } from '@happier-dev/cli-common/accountService';
import type { WelcomeAuthenticationMethod } from '../preAuth/composeWelcomeEntryModel';

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
    accountServiceEntry?: AccountServiceEntryOptions;
    accountContinuationIntent: AccountContinuationIntent;
    accountEntryReturnTo?: string;
    accountDirectoryKeyRequest: WelcomeAuthenticationMethod | null;
    accountDirectoryHomeRecovery: Readonly<{
        kind: 'home_auth' | 'continuation';
        input: AccountPostAuthInput;
        previous: AccountPostAuthResult;
        homeServerIdentityId: string;
    }> | null;

    canScanQr: boolean;
    welcomeHasKnownRelay: boolean;
    welcomeHasAuthActions: boolean;
    allowRelaySelection: boolean;
    canCreatePersonalHome: boolean;

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

    onContinueWithAccountServiceProvider?: (request: WelcomeAuthenticationMethod) => Promise<void> | void;
    onContinueWithAccountServiceKey?: (request: WelcomeAuthenticationMethod) => Promise<void> | void;
    onAccountDirectoryKeyResult: (result: AccountDirectoryKeyLoginOutcome) => Promise<void> | void;
    onAccountServiceReauthenticate: (input: AccountPostAuthInput) => Promise<void> | void;
    onChooseAccountService?: () => Promise<void> | void;
    onContinueWithHomeAuthentication?: (request: WelcomeAuthenticationMethod) => Promise<void> | void;
    onSelectAccountService: AccountServiceSelectionFormProps['onSelect'];
    onAccountServiceSelectionBack: () => void;
    onAccountDirectoryKeyBack: () => void;
    onOpenAccountDirectoryHomeAuthentication: (input: AccountPostAuthInput, homeServerIdentityId: string, previous: AccountPostAuthResult) => void;
    onAccountDirectoryHomeAuthenticationResult: (result: AccountPostAuthResult, input?: AccountPostAuthInput) => Promise<void> | void;
    onAccountDirectoryHomeAuthenticationBack: () => void;

    onCancelScan: () => void;
    onScan: (payload: string) => void;

    onOpenRelaySelectionFromWelcome: () => void;
    onOpenRelaySelectionFromAuth: () => void;
    onOpenSetup: () => void;
    onCreatePersonalHome: () => void;

    onOpenRestore: () => void;
    onOpenLostAccess: () => void;
    onOpenSecretKeyLogin: () => void;
    onRestoreBackToAuth: () => void;
    onRestoreNavigationLockChange: (locked: boolean) => void;
    initialPairingLink: string | null;
    restoreInitialView?: 'qr';
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
                accountServiceEntry={params.accountServiceEntry}
                onContinueWithAccountServiceProvider={params.onContinueWithAccountServiceProvider}
                onContinueWithAccountServiceKey={params.onContinueWithAccountServiceKey}
                onChooseAccountService={params.onChooseAccountService}
                onContinueWithHomeAuthentication={params.onContinueWithHomeAuthentication}
                onOpenRestore={params.onOpenRestore}
                onOpenSecretKeyLogin={params.onOpenSecretKeyLogin}
                onChangeRelay={params.allowRelaySelection ? params.onOpenRelaySelectionFromWelcome : () => {}}
                canChangeHome={params.allowRelaySelection}
                canScanQr={params.canScanQr}
                canCreatePersonalHome={params.canCreatePersonalHome}
                onCreatePersonalHome={params.canCreatePersonalHome ? params.onCreatePersonalHome : undefined}
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

    if (params.stepId === 'auth_service_select') {
        return (
            <AccountServiceSelectionForm
                currentEndpoint={params.accountServiceEntry?.endpoint ?? null}
                onBack={params.onAccountServiceSelectionBack}
                onSelect={params.onSelectAccountService}
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
                    <Text
                        nativeID={`${params.testIDPrefix}-relay-url-label`}
                        testID={`${params.testIDPrefix}-relay-url-label`}
                        style={params.styles.urlHint}
                    >
                        {t('setupOnboarding.customRelayUrlLabel')}
                    </Text>
                    <TextInput
                        testID={`${params.testIDPrefix}-relay-url-input`}
                        placeholder={t('common.urlPlaceholder')}
                        placeholderTextColor={params.theme.colors.text.secondary}
                        autoCapitalize="none"
                        autoCorrect={false}
                        value={params.urlDraft}
                        onChangeText={params.onUrlDraftChange}
                        style={params.styles.urlInput}
                        accessibilityLabel={t('setupOnboarding.customRelayUrlLabel')}
                        accessibilityLabelledBy={`${params.testIDPrefix}-relay-url-label`}
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
                    <Text
                        accessibilityRole="alert"
                        accessibilityLiveRegion="assertive"
                        style={params.styles.urlHint}
                    >
                        {params.reachabilityRemediationError}
                    </Text>
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
                    <WelcomeDecisionPanel
                        showGreeting={false}
                        authEntryOptions={params.authEntryOptions}
                        accountServiceEntry={params.accountServiceEntry}
                        onContinueWithAccountServiceProvider={params.onContinueWithAccountServiceProvider}
                        onContinueWithAccountServiceKey={params.onContinueWithAccountServiceKey}
                        onChooseAccountService={params.onChooseAccountService}
                        onContinueWithHomeAuthentication={params.onContinueWithHomeAuthentication}
                        onOpenRestore={params.onOpenRestore}
                        onOpenSecretKeyLogin={params.onOpenSecretKeyLogin}
                        onChangeRelay={params.onOpenRelaySelectionFromAuth}
                        canChangeHome={params.allowRelaySelection}
                        canScanQr={params.canScanQr}
                        canCreatePersonalHome={params.canCreatePersonalHome}
                        onCreatePersonalHome={params.canCreatePersonalHome ? params.onCreatePersonalHome : undefined}
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
                    entryIntent="enter_home"
                    onBack={params.onRestoreBackToAuth}
                    onOpenSecretKeyLogin={params.onOpenSecretKeyLogin}
                    initialPairingLink={params.initialPairingLink}
                    initialView={params.restoreInitialView}
                    onNavigationLockChange={params.onRestoreNavigationLockChange}
                />
            </View>
        );
    }

    if (params.stepId === 'auth_secret_key') {
        const homeRecovery = params.accountDirectoryHomeRecovery;
        if (homeRecovery?.kind === 'home_auth') {
            return <AccountServiceHomeAuthenticationAdapter
                input={homeRecovery.input}
                previous={homeRecovery.previous}
                homeServerIdentityId={homeRecovery.homeServerIdentityId}
                returnTo={AUTHENTICATED_ACCOUNT_ENTRY_ROUTE}
                accountEntryReturnTo={params.accountEntryReturnTo}
                onResult={params.onAccountDirectoryHomeAuthenticationResult}
                onBack={params.onAccountDirectoryHomeAuthenticationBack}
            />;
        }
        if (homeRecovery?.kind === 'continuation') {
            return <AccountServiceContinuation
                input={homeRecovery.input}
                result={homeRecovery.previous}
                onResult={params.onAccountDirectoryHomeAuthenticationResult}
                onReauthenticate={params.onAccountServiceReauthenticate}
                onOpenHomeAuthentication={params.onOpenAccountDirectoryHomeAuthentication}
                onBack={params.onAccountDirectoryHomeAuthenticationBack}
            />;
        }
        const request = params.accountDirectoryKeyRequest;
        if (request?.authority.purpose === 'account_service') {
            const service = request.authority.service;
            const accountServiceEntry = params.accountServiceEntry;
            const discovery = accountServiceEntry?.status === 'ready'
                ? accountServiceEntry.discovery
                : null;
            const serviceName = readAccountServiceDisplayName({
                url: service.endpointUrl,
                serverIdentityId: service.serverIdentityId,
                savedName: accountServiceEntry?.endpoint.displayName,
                advertisedName: discovery?.accountServiceDisplayName,
            }) ?? t('welcome.yourSignInService');
            return (
                <AccountDirectoryKeyLoginForm
                    service={service}
                    serviceName={serviceName}
                    intent={params.accountContinuationIntent}
                    mode={request.execution.kind === 'generated_key' ? 'provision' : 'login'}
                    transport={accountServiceEntry?.transport}
                    onResult={params.onAccountDirectoryKeyResult}
                    onBack={params.onAccountDirectoryKeyBack}
                    onReauthenticate={params.onAccountServiceReauthenticate}
                    onOpenHomeAuthentication={params.onOpenAccountDirectoryHomeAuthentication}
                    isCurrent={() => (
                        discovery != null
                        && discovery.endpointUrl === service.endpointUrl
                        && discovery.serverIdentityId === service.serverIdentityId
                    )}
                />
            );
        }
        if (request?.authority.purpose === 'home' && request.execution.kind === 'key_entry') {
            const target = resolveHomeAuthenticationTarget(request.authority.target);
            if (target) {
                return <SecretKeyLoginForm embedded target={{
                    ...target,
                    ...(params.authEntryOptions.homeTransport?.runtimeOrigin
                        ? { runtimeOrigin: params.authEntryOptions.homeTransport.runtimeOrigin }
                        : {}),
                    ...(params.authEntryOptions.homeTransport?.homeCarrier
                        ? { homeCarrier: params.authEntryOptions.homeTransport.homeCarrier }
                        : {}),
                    requireKeyChallengeV2: params.authEntryOptions.keyChallengeV2Available === true,
                }} onAuthenticated={() => {}} />;
            }
        }
        return <SecretKeyLoginEmbedded />;
    }

    if (params.stepId === 'auth_lost_access') {
        return <LostAccessEmbedded onBack={params.onLostAccessBackToAuth} />;
    }

    return null;
}
