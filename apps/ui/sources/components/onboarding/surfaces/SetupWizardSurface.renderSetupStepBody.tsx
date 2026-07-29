import * as React from 'react';
import { View } from 'react-native';

import type { AgentId } from '@happier-dev/agents';
import type { RelayAccessProviderId } from '@happier-dev/cli-common/relayAccess/catalog';
import type { RelayAccessTaskTarget } from '@happier-dev/cli-common/systemTasks';
import type { SystemTaskRunState } from '@/components/systemTasks/types';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type {
    EndpointReachabilityRemediation,
    EndpointReachabilityRemediationAction,
} from '@/components/serverReachability/remediation';
import { Text, TextInput } from '@/components/ui/text/Text';
import { t, tLoose } from '@/text';

import { LocalRelayAccessControlSection } from '@/components/settings/server/localControl/LocalRelayAccessControlSection';
import { ServerReachabilityRemediationCard } from '@/components/settings/server/sections/ServerReachabilityRemediationCard';
import { RelayAccessPrerequisitesStep } from '@/components/onboarding/steps/relayAccess/RelayAccessPrerequisitesStep';
import { WizardTerminalHandoff } from '@/components/onboarding/ui/WizardTerminalHandoff';
import { SetupThisComputerWizardStep } from '@/components/onboarding/steps/SetupThisComputerWizardStep';
import {
    buildCliInstallAndRunCommandForCurrentApp,
    buildCliInstallAndRunPowershellCommandForCurrentApp,
} from '@/components/onboarding/commands/wizardCliCommands';
import { MachineArrivalCard } from '@/components/onboarding/detection/MachineArrivalCard';
import { WebDesktopDownloadCta } from '@/components/onboarding/steps/webDesktop/WebDesktopDownloadCta';
import { WebDesktopRelayHostHandoffContent } from '@/components/onboarding/steps/webDesktop/WebDesktopRelayHostHandoffContent';
import { WebDesktopRemoteSshHandoffContent } from '@/components/onboarding/steps/webDesktop/WebDesktopRemoteSshHandoffContent';
import { AgentsLogoMultiSelect } from '@/components/onboarding/steps/AgentsLogoMultiSelect';
import { WizardAgentSetupStep } from '@/components/onboarding/steps/WizardAgentSetupStep';
import { RelayHostLocalChecklistStep } from '@/components/onboarding/checklists/relayHostLocal/RelayHostLocalChecklistStep';
import { RemoteSshChecklistStep } from '@/components/onboarding/checklists/remoteSsh/RemoteSshChecklistStep';
import type { ProviderReadinessPill } from '@/components/onboarding/detection/useProviderReadiness';

import type { SshCredentialsDraft } from '@/components/ssh/SshCredentialsFields';
import { ConfirmSwitchRelayStep, type RelaySwitchDecision } from '../steps/ConfirmSwitchRelayStep';
import type { WizardBackOverride, WizardPrimaryOverride, WizardSkipOverride } from '../hooks/useWizardChromeOverrides';
import type { WizardStepId } from '../state/wizardTypes';
import type { RemoteRelayRuntimeCompletion, RemoteSetupIntent, SetupWizardSurfaceStyles } from './useSetupWizardController';

// D22 (r2 user decision): provider readiness merges INTO the selection grid — detected
// providers render locked-selected with a green dot in `AgentsLogoMultiSelect`; there is
// no standalone readiness row and never a raw "checking" text badge.
function resolveReadyProviderIds(pills: readonly ProviderReadinessPill[]): AgentId[] {
    return pills.filter((pill) => pill.status === 'ready').map((pill) => pill.providerId);
}

export function renderSetupStepBody(params: Readonly<{
    theme: Readonly<{ colors: Readonly<{ text: Readonly<{ secondary: string }> }> }>;
    styles: SetupWizardSurfaceStyles;
    stepId: WizardStepId;
    testIDPrefix: string;
    platform: 'desktop' | 'web' | 'native';
    isDesktopShell: boolean;
    remoteSetupIntent: RemoteSetupIntent;
    allowNativeSshMachineSetup: boolean;
    webRemoteSshDraft: SshCredentialsDraft;
    onWebRemoteSshDraftChange: (next: SshCredentialsDraft) => void;
    activeServerUrl: string | null;
    activeLocalRelayUrl: string | null;
    relayUrl: string | null;
    webRelayHostUrlDraft: string;
    webRelayHostInvalidUrl: boolean;
    confirmRelayUrl: string | null;
    serverProfileId: string | null;
    relayAccessTarget: RelayAccessTaskTarget;
    reachabilityRemediation: EndpointReachabilityRemediation | null;
    webRelayHostReachabilityRemediation: EndpointReachabilityRemediation | null;
    reachabilityRemediationTaskSnapshot: SystemTaskRunState | null;
    reachabilityRemediationError: string | null;
    onReachabilityRemediationAction: (actionId: EndpointReachabilityRemediationAction['id']) => void | Promise<void>;
    machineArrivalSince: number | null;
    onMachineArrived: (machine: Machine) => void;
    providerMachineId: string | null;
    providerSelectionProviderIds: readonly AgentId[];
    selectedAgentIds: readonly AgentId[];
    providerReadiness: readonly ProviderReadinessPill[];
    onToggleAgentId: (providerId: AgentId) => void;
    onLocalSetupSucceeded: (machineId: string | null) => void;
    onLocalSetupNeedsAuth: () => void;
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
    connectedMachineLabel: string | null;
    existingSessionCount: number;
}>): React.ReactNode {
    const requiresDesktop = params.isDesktopShell !== true;
    switch (params.stepId) {
        case 'setup_this_computer':
            if (requiresDesktop) {
                return (
                    <View testID="setupWizard-machine-arrival-stack" style={params.styles.webRelayHostHandoff}>
                        <MachineArrivalCard
                            mode="live"
                            testID="setupWizard-machine-arrival"
                            serverUrl={params.activeServerUrl ?? ''}
                            since={params.machineArrivalSince}
                            onArrived={params.onMachineArrived}
                        />
                        <WebDesktopDownloadCta testIDPrefix="setupWizard-machine-arrival-desktop-app" />
                        <Text style={params.styles.urlHint}>{t('setupOnboarding.setupThisComputerConnectHonesty')}</Text>
                    </View>
                );
            }
            return (
                <SetupThisComputerWizardStep
                    testID="setupWizard-setup-this-computer"
                    onSucceeded={params.onLocalSetupSucceeded}
                    onNeedsAuth={params.onLocalSetupNeedsAuth}
                />
            );
        case 'host_relay_local':
            if (requiresDesktop) {
                return (
                    <View testID="setupWizard-web-relay-host-handoff" style={params.styles.webRelayHostHandoff}>
                        <WebDesktopRelayHostHandoffContent testID="setupWizard-web-relay" />
                        <View style={params.styles.urlBlock}>
                            <TextInput
                                testID="setupWizard-relay-url-input"
                                placeholder={t('common.urlPlaceholder')}
                                placeholderTextColor={params.theme.colors.text.secondary}
                                autoCapitalize="none"
                                autoCorrect={false}
                                value={params.webRelayHostUrlDraft}
                                onChangeText={params.onRelayUrlPasteChange}
                                style={params.styles.urlInput}
                            />
                            <Text style={params.styles.urlHint}>{t('setupOnboarding.webDesktopOnlyRelayStatusSubtitle')}</Text>
                            {params.webRelayHostInvalidUrl ? (
                                <Text style={params.styles.urlHint}>{t('setupOnboarding.webRelayHostInvalidUrl')}</Text>
                            ) : null}
                        </View>
                        {params.webRelayHostReachabilityRemediation ? (
                            <ServerReachabilityRemediationCard
                                remediation={params.webRelayHostReachabilityRemediation}
                                taskSnapshot={params.reachabilityRemediationTaskSnapshot}
                                onAction={params.onReachabilityRemediationAction}
                            />
                        ) : null}
                        {params.reachabilityRemediationError ? (
                            <Text style={params.styles.urlHint}>{params.reachabilityRemediationError}</Text>
                        ) : null}
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
                                placeholderTextColor={params.theme.colors.text.secondary}
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
            if (
                requiresDesktop
                && !(
                    params.platform === 'native'
                    && params.remoteSetupIntent === 'remoteMachine'
                    && params.allowNativeSshMachineSetup
                )
            ) {
                return (
                    <WebDesktopRemoteSshHandoffContent
                        testID="setupWizard-web-remote-ssh"
                        terminalTestID="setupWizard-terminal-handoff"
                        sshFieldTestIDPrefix="setupWizard-web-remote-ssh"
                        draft={params.webRemoteSshDraft}
                        onDraftChange={params.onWebRemoteSshDraftChange}
                        relayUrl={params.activeServerUrl}
                        installRelayRuntime={params.remoteSetupIntent === 'remoteRelayHost'}
                    />
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
                // Detected providers are locked-selected in the grid, so the effective
                // selection (and the generated setup command) always includes them.
                const readyProviderIds = resolveReadyProviderIds(params.providerReadiness);
                const effectiveSelectedAgentIds = [...new Set([...params.selectedAgentIds, ...readyProviderIds])];
                const providerArgv = effectiveSelectedAgentIds.length > 0
                    ? ['--providers', effectiveSelectedAgentIds.join(',')]
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
                        <AgentsLogoMultiSelect
                            testID="setupWizard-web-providers-select"
                            agentIds={params.providerSelectionProviderIds}
                            selectedAgentIds={params.selectedAgentIds}
                            readyAgentIds={readyProviderIds}
                            onToggleAgent={params.onToggleAgentId}
                        />
                        <WizardTerminalHandoff
                            testID="setupWizard-terminal-handoff"
                            steps={[
                                {
                                    title: tLoose('settingsAgents.setup.startTitle'),
                                    subtitle: tLoose('settingsAgents.setup.startDescription'),
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
                <View style={params.styles.webRelayHostHandoff}>
                    <WizardAgentSetupStep
                        machineId={params.providerMachineId}
                        onWizardPrimaryChange={params.onWizardPrimaryChange}
                        onRequestAdvance={params.onRequestAdvance}
                    />
                </View>
            );
        case 'done':
            return (
                <View style={params.styles.webRelayHostHandoff}>
                    <Text style={params.styles.doneLine}>{t('setupOnboarding.doneFirstSessionLine')}</Text>
                    <Text testID="setupWizard-done-machine-summary" style={params.styles.doneSummary}>
                        {t('setupOnboarding.doneConnectedMachineSummary', {
                            machine: params.connectedMachineLabel ?? t('setupOnboarding.doneMachineFallback'),
                        })}
                    </Text>
                    {params.existingSessionCount > 0 ? (
                        <Text testID="setupWizard-done-existing-sessions" style={params.styles.doneLine}>
                            {t('setupOnboarding.doneExistingSessionsLine', { count: params.existingSessionCount })}
                        </Text>
                    ) : null}
                </View>
            );
        default:
            return <Text>{t('setupOnboarding.postAuthBody')}</Text>;
    }
}
