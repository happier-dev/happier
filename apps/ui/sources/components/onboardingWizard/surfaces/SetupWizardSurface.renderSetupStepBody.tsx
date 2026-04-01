import * as React from 'react';
import { View } from 'react-native';

import type { AgentId } from '@happier-dev/agents';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t, tLoose } from '@/text';

import { WizardSshCredentialsFields } from '@/components/onboardingWizard/ssh/WizardSshCredentialsFields';
import { LocalRelayAccessControlSection } from '@/components/settings/server/localControl/LocalRelayAccessControlSection';
import { SecureAccessTailscaleStep } from '@/components/onboardingWizard/SecureAccessTailscaleStep';
import { WizardTerminalHandoff } from '@/components/onboardingWizard/WizardTerminalHandoff';
import { SetupThisComputerWizardStep } from '@/components/onboardingWizard/SetupThisComputerWizardStep';
import {
    buildCliInstallCommandForCurrentApp,
    buildHappierSetupCommand,
    buildRemoteMachineSetupCommand,
} from '@/components/onboardingWizard/wizardCliCommands';
import { buildWebDesktopRelayHostHandoffSteps } from '@/components/onboardingWizard/webDesktopHandoffSteps';
import { WebDesktopBackgroundServiceHandoffContent } from '@/components/onboardingWizard/WebDesktopBackgroundServiceHandoffContent';
import { WebDesktopDownloadCta } from '@/components/onboardingWizard/WebDesktopDownloadCta';
import { ProvidersLogoMultiSelect } from '@/components/onboardingWizard/ProvidersLogoMultiSelect';
import { WizardProviderSetupStep } from '@/components/onboardingWizard/WizardProviderSetupStep';
import { RelayHostLocalChecklistStep } from '@/components/onboardingWizard/relayHostLocalChecklist/RelayHostLocalChecklistStep';
import { RemoteSshChecklistStep } from '@/components/onboardingWizard/remoteSshChecklist/RemoteSshChecklistStep';

import type { SshCredentialsDraft } from '@/components/settings/machines/shared/SshCredentialsFields';
import { ConfirmSwitchRelayStep, type RelaySwitchDecision } from '../ConfirmSwitchRelayStep';
import type { WizardStepId } from '../wizardTypes';
import type {
    RemoteRelayRuntimeCompletion,
    RemoteSetupIntent,
    SetupWizardSurfaceStyles,
    WizardBackOverride,
    WizardPrimaryOverride,
    WizardSkipOverride,
} from './SetupWizardSurface';

export function renderSetupStepBody(params: Readonly<{
    theme: Readonly<{ colors: Readonly<{ textSecondary: string }> }>;
    styles: SetupWizardSurfaceStyles;
    stepId: WizardStepId;
    testIDPrefix: string;
    platform: 'desktop' | 'web' | 'native';
    isDesktopShell: boolean;
    remoteSetupIntent: RemoteSetupIntent;
    webRemoteSshDraft: SshCredentialsDraft;
    onWebRemoteSshDraftChange: (next: SshCredentialsDraft) => void;
    activeServerUrl: string | null;
    activeLocalRelayUrl: string | null;
    relayUrl: string | null;
    providerMachineId: string | null;
    providerSelectionProviderIds: readonly AgentId[];
    selectedProviderIds: readonly AgentId[];
    onToggleProviderId: (providerId: AgentId) => void;
    providersSetupCommand: string;
    onLocalSetupSucceeded: (machineId: string | null) => void;
    onLocalSetupNeedsAuth: () => void;
    onLocalSetupNeedsApproval: () => void;
    relaySwitchDecision: RelaySwitchDecision;
    onRelaySwitchDecisionChange: (decision: RelaySwitchDecision) => void;
    onLocalRelayStatusChange: (status: unknown) => void;
    onRemoteRelayRuntimeCompletedChange: (payload: RemoteRelayRuntimeCompletion) => void;
    onRelayUrlPasteChange: (value: string) => void;
    onRelayShareUrlPasteChange: (value: string) => void;
    onWizardPrimaryChange?: (state: WizardPrimaryOverride | null) => void;
    onWizardBackChange?: (state: WizardBackOverride | null) => void;
    onWizardSkipChange?: (state: WizardSkipOverride | null) => void;
    onRequestAdvance?: () => void;
}>): React.ReactNode {
    const requiresDesktop = params.isDesktopShell !== true;
    switch (params.stepId) {
        case 'setup_this_computer':
            if (requiresDesktop) {
                return (
                    <WebDesktopBackgroundServiceHandoffContent
                        testID="setupWizard-web-machine-setup-handoff"
                        relayUrl={params.activeServerUrl ?? ''}
                    />
                );
            }
            return (
                <SetupThisComputerWizardStep
                    onSucceeded={params.onLocalSetupSucceeded}
                    onNeedsAuth={params.onLocalSetupNeedsAuth}
                    onNeedsApproval={params.onLocalSetupNeedsApproval}
                />
            );
        case 'host_relay_local':
            if (requiresDesktop) {
                const cliInstallCommand = buildCliInstallCommandForCurrentApp();
                return (
                    <View testID="setupWizard-web-relay-host-handoff" style={params.styles.webRelayHostHandoff}>
                        <WizardTerminalHandoff
                            testID="setupWizard-terminal-handoff"
                            steps={buildWebDesktopRelayHostHandoffSteps({
                                cliInstallCommand,
                                includeDaemonInstall: false,
                            })}
                        />
                        <WebDesktopDownloadCta testIDPrefix="setupWizard-web-relay" />
                        <View style={params.styles.urlBlock}>
                            <TextInput
                                testID="setupWizard-relay-url-input"
                                placeholder={t('common.urlPlaceholder')}
                                placeholderTextColor={params.theme.colors.textSecondary}
                                autoCapitalize="none"
                                autoCorrect={false}
                                onChangeText={params.onRelayUrlPasteChange}
                                style={params.styles.urlInput}
                            />
                            <Text style={params.styles.urlHint}>{t('setupOnboarding.webDesktopOnlyRelayStatusSubtitle')}</Text>
                        </View>
                    </View>
                );
            }
            return (
                <RelayHostLocalChecklistStep
                    testID="setupWizard-relay-host-local"
                    onStatusChange={params.onLocalRelayStatusChange}
                    onWizardPrimaryChange={params.onWizardPrimaryChange}
                    onRequestAdvance={params.onRequestAdvance}
                />
            );
        case 'relay_access':
            if (requiresDesktop) {
                return (
                    <View testID="setupWizard-web-relay-access-handoff" style={params.styles.webRelayHostHandoff}>
                        <Text style={params.styles.branchHint}>{t('setupOnboarding.webDesktopOnlyBody')}</Text>
                        <WebDesktopDownloadCta testIDPrefix="setupWizard-web-relay-access" />
                        <View style={params.styles.urlBlock}>
                            <TextInput
                                testID="setupWizard-relay-share-url-input"
                                placeholder={t('common.urlPlaceholder')}
                                placeholderTextColor={params.theme.colors.textSecondary}
                                autoCapitalize="none"
                                autoCorrect={false}
                                onChangeText={params.onRelayShareUrlPasteChange}
                                style={params.styles.urlInput}
                            />
                            <Text style={params.styles.urlHint}>{t('settings.relayAccess.webHandoffSubtitle')}</Text>
                        </View>
                    </View>
                );
            }
            return <LocalRelayAccessControlSection upstreamUrl={params.relayUrl} presentation="wizard" />;
        case 'remote_ssh_setup':
            if (requiresDesktop) {
                const cliInstallCommand = buildCliInstallCommandForCurrentApp();
                const setupCommand = buildHappierSetupCommand({
                    relayUrl: params.activeServerUrl,
                    skipProviders: true,
                    yes: true,
                });
                const sshCommand = buildRemoteMachineSetupCommand({
                    draft: params.webRemoteSshDraft,
                    installRelayRuntime: params.remoteSetupIntent === 'remoteRelayHost',
                });
                return (
                    <View testID="setupWizard-web-remote-ssh-handoff" style={params.styles.webRelayHostHandoff}>
                        <WizardSshCredentialsFields
                            testIDPrefix="setupWizard-web-remote-ssh"
                            testIdStyle="wizard"
                            value={params.webRemoteSshDraft}
                            onChange={params.onWebRemoteSshDraftChange}
                        />
                        <WizardTerminalHandoff
                            testID="setupWizard-terminal-handoff"
                            steps={[
                                {
                                    title: t('sessionGettingStarted.steps.installCli.title'),
                                    subtitle: t('sessionGettingStarted.steps.installCli.description'),
                                    code: cliInstallCommand,
                                    scrollTestIDSuffix: 'cli-install',
                                },
                                {
                                    title: t('setupOnboarding.webDesktopOnlySetupCommandTitle'),
                                    subtitle: t('setupOnboarding.webDesktopOnlySetupRemotePrereqsSubtitle'),
                                    code: setupCommand,
                                    scrollTestIDSuffix: 'setup',
                                },
                                {
                                    title: t('settings.machineSetupSshMachineTitle'),
                                    subtitle: t('settings.machineSetupSshMachineSubtitle'),
                                    code: sshCommand,
                                    scrollTestIDSuffix: 'remote-ssh-setup',
                                },
                            ]}
                        />
                    </View>
                );
            }
            return (
                <RemoteSshChecklistStep
                    testID="setupWizard-remote-ssh"
                    mode={params.remoteSetupIntent}
                    relayUrl={params.activeLocalRelayUrl ?? params.activeServerUrl ?? ''}
                    webappUrl={params.activeServerUrl ?? undefined}
                    publicRelayUrl={params.activeLocalRelayUrl ? (params.activeServerUrl ?? undefined) : undefined}
                    initialDraft={params.webRemoteSshDraft}
                    initialInstallRelayRuntime={params.remoteSetupIntent === 'remoteRelayHost'}
                    onCompleted={params.onRemoteRelayRuntimeCompletedChange}
                    onWizardPrimaryChange={params.onWizardPrimaryChange}
                    onWizardBackChange={params.onWizardBackChange}
                    onWizardSkipChange={params.onWizardSkipChange}
                    onRequestAdvance={params.onRequestAdvance}
                />
            );
        case 'confirm_switch_relay': {
            const relayUrl = typeof params.relayUrl === 'string' ? params.relayUrl.trim() : '';
            return (
                <ConfirmSwitchRelayStep
                    testIDPrefix={params.testIDPrefix}
                    relayUrl={relayUrl}
                    decision={params.relaySwitchDecision}
                    onDecisionChange={params.onRelaySwitchDecisionChange}
                />
            );
        }
        case 'providers_optional':
            if (requiresDesktop) {
                return (
                    <View testID="setupWizard-web-providers-handoff" style={params.styles.webRelayHostHandoff}>
                        <ProvidersLogoMultiSelect
                            testID="setupWizard-web-providers-select"
                            providerIds={params.providerSelectionProviderIds}
                            selectedProviderIds={params.selectedProviderIds}
                            onToggleProvider={params.onToggleProviderId}
                        />
                        <WizardTerminalHandoff
                            testID="setupWizard-terminal-handoff"
                            steps={[
                                {
                                    title: tLoose('settingsProviders.setup.startTitle'),
                                    subtitle: tLoose('settingsProviders.setup.startDescription'),
                                    code: params.providersSetupCommand,
                                    scrollTestIDSuffix: 'providers',
                                },
                            ]}
                        />
                        <WebDesktopDownloadCta testIDPrefix="setupWizard-web-providers" />
                    </View>
                );
            }
            return (
                <WizardProviderSetupStep
                    machineId={params.providerMachineId}
                    onWizardPrimaryChange={params.onWizardPrimaryChange}
                    onRequestAdvance={params.onRequestAdvance}
                />
            );
        case 'secure_access_tailscale':
            if (requiresDesktop) {
                return (
                    <View testID="setupWizard-web-tailscale-handoff" style={params.styles.branchList}>
                        <Text style={params.styles.branchHint}>{t('setupOnboarding.webDesktopOnlyBody')}</Text>
                        <WebDesktopDownloadCta testIDPrefix="setupWizard-web-tailscale" />
                    </View>
                );
            }
            return <SecureAccessTailscaleStep />;
        case 'done':
            return <Text>{t('setupOnboarding.nextActionReady')}</Text>;
        default:
            return <Text>{t('setupOnboarding.postAuthBody')}</Text>;
    }
}
