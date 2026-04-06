import * as React from 'react';
import { View } from 'react-native';

import type { AgentId } from '@happier-dev/agents';
import type { RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';
import type { SystemTaskRunState } from '@/components/systemTasks/types';
import type {
    EndpointReachabilityRemediation,
    EndpointReachabilityRemediationAction,
} from '@/components/serverReachability/remediation';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t, tLoose } from '@/text';

import { SshCredentialsFields } from '@/components/ssh/SshCredentialsFields';
import { LocalRelayAccessControlSection } from '@/components/settings/server/localControl/LocalRelayAccessControlSection';
import { ServerReachabilityRemediationCard } from '@/components/settings/server/sections/ServerReachabilityRemediationCard';
import { RelayAccessPrerequisitesStep } from '@/components/onboarding/steps/relayAccess/RelayAccessPrerequisitesStep';
import { WizardTerminalHandoff } from '@/components/onboarding/ui/WizardTerminalHandoff';
import { SetupThisComputerWizardStep } from '@/components/onboarding/steps/SetupThisComputerWizardStep';
import {
    buildCliInstallAndRunCommandForCurrentApp,
    buildCliInstallAndRunPowershellCommandForCurrentApp,
    buildHappierSetupCommand,
    buildRemoteMachineSetupCommand,
} from '@/components/onboarding/commands/wizardCliCommands';
import { buildWebDesktopRelayHostHandoffSteps } from '@/components/onboarding/commands/webDesktopHandoffSteps';
import { WebDesktopBackgroundServiceHandoffContent } from '@/components/onboarding/steps/webDesktop/WebDesktopBackgroundServiceHandoffContent';
import { WebDesktopDownloadCta } from '@/components/onboarding/steps/webDesktop/WebDesktopDownloadCta';
import { ProvidersLogoMultiSelect } from '@/components/onboarding/steps/ProvidersLogoMultiSelect';
import { WizardProviderSetupStep } from '@/components/onboarding/steps/WizardProviderSetupStep';
import { RelayHostLocalChecklistStep } from '@/components/onboarding/checklists/relayHostLocal/RelayHostLocalChecklistStep';
import { RemoteSshChecklistStep } from '@/components/onboarding/checklists/remoteSsh/RemoteSshChecklistStep';

import type { SshCredentialsDraft } from '@/components/ssh/SshCredentialsFields';
import { ConfirmSwitchRelayStep, type RelaySwitchDecision } from '../steps/ConfirmSwitchRelayStep';
import type { WizardBackOverride, WizardPrimaryOverride, WizardSkipOverride } from '../hooks/useWizardChromeOverrides';
import type { WizardStepId } from '../state/wizardTypes';
import type { RemoteRelayRuntimeCompletion, RemoteSetupIntent, SetupWizardSurfaceStyles } from './SetupWizardSurface';

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
    confirmRelayUrl: string | null;
    serverProfileId: string | null;
    relayAccessTarget: RelayAccessTaskTarget;
    reachabilityRemediation: EndpointReachabilityRemediation | null;
    reachabilityRemediationTaskSnapshot: SystemTaskRunState | null;
    reachabilityRemediationError: string | null;
    onReachabilityRemediationAction: (actionId: EndpointReachabilityRemediationAction['id']) => void | Promise<void>;
    providerMachineId: string | null;
    providerSelectionProviderIds: readonly AgentId[];
    selectedProviderIds: readonly AgentId[];
    onToggleProviderId: (providerId: AgentId) => void;
    onLocalSetupSucceeded: (machineId: string | null) => void;
    onLocalSetupNeedsAuth: () => void;
    onLocalSetupNeedsApproval: () => void;
    relaySwitchDecision: RelaySwitchDecision;
    onRelaySwitchDecisionChange: (decision: RelaySwitchDecision) => void;
    onLocalRelayStatusChange: (status: unknown) => void;
    onRemoteRelayRuntimeCompletedChange: (payload: RemoteRelayRuntimeCompletion) => void;
    onRelayUrlPasteChange: (value: string) => void;
    onRelayShareUrlPasteChange: (value: string) => void;
    onRelayAccessShareUrlChange: (shareUrl: string | null) => void;
    relayAccessProviderId: RelayAccessProviderId | null;
    onRelayAccessProviderIdChange: (next: RelayAccessProviderId | null) => void;
    onRelayAccessProviderDetailsRequested: (providerId: RelayAccessProviderId) => void;
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
                    testID="setupWizard-setup-this-computer"
                    onSucceeded={params.onLocalSetupSucceeded}
                    onNeedsAuth={params.onLocalSetupNeedsAuth}
                    onNeedsApproval={params.onLocalSetupNeedsApproval}
                />
            );
        case 'host_relay_local':
            if (requiresDesktop) {
                const installAndSetupRelayCommand = buildCliInstallAndRunCommandForCurrentApp({ action: 'setup-relay' });
                const installAndSetupRelayWindowsCommand = buildCliInstallAndRunPowershellCommandForCurrentApp({ action: 'setup-relay' });
                return (
                    <View testID="setupWizard-web-relay-host-handoff" style={params.styles.webRelayHostHandoff}>
                        <WizardTerminalHandoff
                            testID="setupWizard-terminal-handoff"
                            steps={buildWebDesktopRelayHostHandoffSteps({
                                installAndSetupRelayCommand,
                                installAndSetupRelayWindowsCommand,
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
            return (
                <LocalRelayAccessControlSection
                    target={params.relayAccessTarget}
                    upstreamUrl={params.relayUrl}
                    serverProfileId={params.serverProfileId}
                    presentation="wizard"
                    onShareUrlChange={params.onRelayAccessShareUrlChange}
                    onWizardPrimaryChange={params.onWizardPrimaryChange}
                    onRequestAdvance={params.onRequestAdvance}
                    onWizardSelectedProviderIdChange={params.onRelayAccessProviderIdChange}
                    onWizardRequestProviderDetails={params.onRelayAccessProviderDetailsRequested}
                    wizardSelectedProviderId={params.relayAccessProviderId}
                />
            );
        case 'relay_access_prereqs':
            return (
                <RelayAccessPrerequisitesStep
                    testID="setupWizard-relay-access-prereqs"
                    providerId={params.relayAccessProviderId}
                    upstreamUrl={params.relayUrl}
                    serverProfileId={params.serverProfileId}
                    target={params.relayAccessTarget}
                    onShareUrlChange={params.onRelayAccessShareUrlChange}
                    onWizardPrimaryChange={params.onWizardPrimaryChange}
                    onRequestAdvance={params.onRequestAdvance}
                />
            );
        case 'remote_ssh_setup':
            if (requiresDesktop) {
                const setupArgs: string[] = [];
                if (params.activeServerUrl) {
                    setupArgs.push('--relay-url', params.activeServerUrl);
                }
                setupArgs.push('--skip-providers', '--yes');
                const installAndSetupCommand = buildCliInstallAndRunCommandForCurrentApp({
                    action: 'setup',
                    args: setupArgs,
                });
                const installAndSetupWindowsCommand = buildCliInstallAndRunPowershellCommandForCurrentApp({
                    action: 'setup',
                    args: setupArgs,
                });
                const sshCommand = buildRemoteMachineSetupCommand({
                    draft: params.webRemoteSshDraft,
                    installRelayRuntime: params.remoteSetupIntent === 'remoteRelayHost',
                });
                return (
                    <View testID="setupWizard-web-remote-ssh-handoff" style={params.styles.webRelayHostHandoff}>
                        <SshCredentialsFields
                            testIDPrefix="setupWizard-web-remote-ssh"
                            layoutVariant="wizard"
                            value={params.webRemoteSshDraft}
                            onChange={params.onWebRemoteSshDraftChange}
                        />
                        <WizardTerminalHandoff
                            testID="setupWizard-terminal-handoff"
                            steps={[
                                {
                                    title: t('setupOnboarding.webDesktopOnlySetupCommandTitle'),
                                    subtitle: t('setupOnboarding.webDesktopOnlySetupRemotePrereqsSubtitle'),
                                    code: installAndSetupCommand,
                                    windowsCode: installAndSetupWindowsCommand,
                                    windowsLanguage: 'powershell',
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
            const relayUrl = typeof params.confirmRelayUrl === 'string' ? params.confirmRelayUrl.trim() : '';
            return (
                <>
                    <ConfirmSwitchRelayStep
                        testIDPrefix={params.testIDPrefix}
                        relayUrl={relayUrl}
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
        case 'providers_optional':
            if (requiresDesktop) {
                const providerArgv = params.selectedProviderIds.length > 0
                    ? ['--providers', params.selectedProviderIds.join(',')]
                    : [];
                const installAndProvidersSetupCommand = buildCliInstallAndRunCommandForCurrentApp({
                    action: 'providers-setup',
                    args: providerArgv,
                });
                const installAndProvidersSetupWindowsCommand = buildCliInstallAndRunPowershellCommandForCurrentApp({
                    action: 'providers-setup',
                    args: providerArgv,
                });
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
                                    code: installAndProvidersSetupCommand,
                                    windowsCode: installAndProvidersSetupWindowsCommand,
                                    windowsLanguage: 'powershell',
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
        case 'done':
            return <Text>{t('setupOnboarding.nextActionReady')}</Text>;
        default:
            return <Text>{t('setupOnboarding.postAuthBody')}</Text>;
    }
}
