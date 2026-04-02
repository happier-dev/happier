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
import { WebDesktopBackgroundServiceHandoffContent } from '@/components/onboarding/steps/webDesktop/WebDesktopBackgroundServiceHandoffContent';
import { LocalRelayAccessControlSection } from '@/components/settings/server/localControl/LocalRelayAccessControlSection';

import { RestoreIndexEmbedded } from '@/components/onboarding/restore/RestoreIndexEmbedded';
import { LostAccessEmbedded } from '@/components/onboarding/restore/LostAccessEmbedded';
import { SecretKeyLoginEmbedded } from '@/components/onboarding/restore/SecretKeyLoginEmbedded';

import type { RelayHostLocalChecklistRuntimeStatus } from '../checklists/relayHostLocal/types';
import { RelayHostLocalChecklistStep } from '../checklists/relayHostLocal/RelayHostLocalChecklistStep';
import { RemoteSshChecklistStep } from '../checklists/remoteSsh/RemoteSshChecklistStep';
import type { RemoteSshChecklistMode } from '../checklists/remoteSsh/types';
import type { WizardStepId } from '../state/wizardTypes';
import { RelayDiagram } from '../ui/RelayDiagram';
import { WelcomeProvidersShowcase } from '../preAuth/WelcomeProvidersShowcase';
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
    theme: Readonly<{ colors: Readonly<{ textSecondary: string }> }>;

    layout: 'portrait' | 'landscape';
    authEntryOptions: AuthEntryOptions;

    canScanQr: boolean;
    welcomeHasKnownRelay: boolean;
    welcomeHasAuthActions: boolean;
    allowRelaySelection: boolean;

    relaySelectBody: React.ReactNode;

    urlDraft: string;
    onUrlDraftChange: (next: string) => void;

    relaySelectionServerUrl: string | null;
    lastKnownSnapshotRelayUrl: string;

    relaySwitchDecision: RelaySwitchDecision;
    onRelaySwitchDecisionChange: (next: RelaySwitchDecision) => void;

    onLocalRelayRuntimeStatusChange: (next: RelayHostLocalChecklistRuntimeStatus | null) => void;

    onWizardPrimaryChange: (next: WizardPrimaryOverride | null) => void;
    onWizardBackChange: (next: WizardBackOverride | null) => void;
    onWizardSkipChange: (next: WizardSkipOverride | null) => void;

    onCreateAccount: () => Promise<void> | void;
    onCreateAccountViaProvider: (providerId: string) => Promise<void> | void;
    onLoginWithKeylessProvider: (providerId: string) => Promise<void> | void;
    onLoginWithMtls: () => Promise<void> | void;

    onStartScan: () => void;
    onCancelScan: () => void;
    onScan: (payload: string) => void;

    onOpenRelaySelectionFromWelcome: () => void;
    onOpenRelaySelectionFromAuth: () => void;
    onChangeRelayViaServerConfig: () => void;

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
        mode: RemoteSshChecklistMode;
    }>) => void;
}>): React.ReactNode {
    if (params.stepId === 'welcome') {
        return (
            <View testID={`${params.testIDPrefix}-welcome-auth`} style={params.styles.welcomeBody}>
                <View style={params.styles.labelContainer}>
                    <Text style={params.styles.label}>{t('setupOnboarding.welcomeBody2')}</Text>
                    <Text style={params.styles.label}>{t('setupOnboarding.welcomeBody3')}</Text>
                </View>
                <WelcomeProvidersShowcase
                    testID={`${params.testIDPrefix}-welcome-showcase`}
                    testIDPrefix={`${params.testIDPrefix}-welcome`}
                />
                {params.canScanQr ? (
                    <View style={params.styles.scanCtaBlock}>
                        <RoundButton
                            testID={`${params.testIDPrefix}-scan`}
                            size="normal"
                            display="inverted"
                            title={t('setupOnboarding.scanQrCode')}
                            onPress={params.onStartScan}
                        />
                    </View>
                ) : null}
                {params.welcomeHasKnownRelay ? (
                    <>
                        <View style={params.styles.authEntryWrapper}>
                            <AuthEntryView
                                layout={params.layout}
                                isDesktopShell={false}
                                options={params.authEntryOptions}
                                onOpenSetup={() => {}}
                                onChangeRelay={params.allowRelaySelection ? params.onOpenRelaySelectionFromWelcome : () => {}}
                                onRestore={params.onOpenRestore}
                                onCreateAccount={params.onCreateAccount}
                                onCreateAccountViaProvider={params.onCreateAccountViaProvider}
                                onLoginWithKeylessProvider={params.onLoginWithKeylessProvider}
                                onLoginWithMtls={params.onLoginWithMtls}
                            />
                        </View>
                        {params.welcomeHasAuthActions && params.allowRelaySelection ? (
                            <View style={params.styles.scanCtaBlock}>
                                <RoundButton
                                    testID={`${params.testIDPrefix}-change-relay`}
                                    size="small"
                                    display="inverted"
                                    title={t('setupOnboarding.changeRelayAction')}
                                    onPress={() => {
                                        params.onOpenRelaySelectionFromWelcome();
                                    }}
                                />
                            </View>
                        ) : null}
                    </>
                ) : null}
            </View>
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
            <>
                <View style={params.styles.diagramContainer}>
                    <RelayDiagram testID={`${params.testIDPrefix}-relay-diagram`} />
                </View>
                {params.relaySelectBody}
            </>
        );
    }

    if (params.stepId === 'confirm_relay_lock') {
        return (
            <View testID={`${params.testIDPrefix}-confirm-relay-lock`}>
                <Text style={params.styles.urlHint}>{t('setupOnboarding.confirmSwitchRelayWarning')}</Text>
            </View>
        );
    }

    if (params.stepId === 'relay_enter_url') {
        return (
            <View style={params.styles.urlBlock}>
                <TextInput
                    testID={`${params.testIDPrefix}-relay-url-input`}
                    placeholder={t('common.urlPlaceholder')}
                    placeholderTextColor={params.theme.colors.textSecondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={params.urlDraft}
                    onChangeText={params.onUrlDraftChange}
                    style={params.styles.urlInput}
                />
                <Text style={params.styles.urlHint}>{t('setupOnboarding.relayCustomUrlSubtitle')}</Text>
            </View>
        );
    }

    if (params.stepId === 'background_service_handoff') {
        return (
            <WebDesktopBackgroundServiceHandoffContent
                testID={`${params.testIDPrefix}-background-service-handoff`}
                relayUrl={params.relaySelectionServerUrl ?? ''}
            />
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
                presentation="wizard"
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
            <ConfirmSwitchRelayStep
                testIDPrefix={params.testIDPrefix}
                relayUrl={params.relaySelectionServerUrl ?? ''}
                decision={params.relaySwitchDecision}
                onDecisionChange={params.onRelaySwitchDecisionChange}
            />
        );
    }

    if (params.stepId === 'auth') {
        return (
            <>
                <View style={params.styles.authEntryWrapper}>
                    <AuthEntryView
                        layout={params.layout}
                        isDesktopShell={false}
                        options={params.authEntryOptions}
                        onOpenSetup={() => {}}
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
            <RestoreIndexEmbedded
                onBack={params.onRestoreBackToAuth}
                onOpenSecretKeyLogin={params.onOpenSecretKeyLogin}
            />
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
