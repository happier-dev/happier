import type { FeatureId } from '@happier-dev/protocol';
import type { TranslationKeyNoParams } from '@/text';

export type UiFeatureToggleServerVisibilityScope = 'main_selection' | 'runtime';

export type UiFeatureDefinition = Readonly<{
    settingsToggle?: Readonly<{
        showInSettings: boolean;
        isExperimental: boolean;
        defaultEnabled: boolean;
        serverVisibilityScope?: UiFeatureToggleServerVisibilityScope;
        titleKey: TranslationKeyNoParams;
        subtitleKey: TranslationKeyNoParams;
    }>;
    analytics?: Readonly<{
        trackPreference?: boolean;
        trackEffective?: boolean;
    }>;
}>;

export const UI_FEATURE_REGISTRY = {
    automations: {
        settingsToggle: {
            showInSettings: true,
            // Graduated with the one Workflows destination: the switch governs triggers, and the
            // Experiments switch no longer turns them off (FIN 04 §3.1).
            isExperimental: false,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expAutomations',
            subtitleKey: 'settingsFeatures.expAutomationsSubtitle',
        },
    },
    workflows: {
        settingsToggle: undefined,
    },
    'execution.runs': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expExecutionRuns',
            subtitleKey: 'settingsFeatures.expExecutionRunsSubtitle',
        },
    },
    'pets.companion': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            serverVisibilityScope: 'main_selection',
            titleKey: 'settingsFeatures.expPetsCompanion',
            subtitleKey: 'settingsFeatures.expPetsCompanionSubtitle',
        },
    },
    'pets.sync': {
        settingsToggle: undefined,
    },
    'encryption.plaintextStorage': {
        settingsToggle: undefined,
    },
    'encryption.accountOptOut': {
        settingsToggle: undefined,
    },
    // Promoted (Voice Experience r1): Voice is a product surface, not an experiment; the switch in
    // Settings → Features stays the person's own way to turn it off. Its agent/daemon inference
    // sub-features remain experimental.
    voice: {
        settingsToggle: {
            showInSettings: true,
            isExperimental: false,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.voice',
            subtitleKey: 'settingsFeatures.voiceSubtitle',
        },
    },
    'voice.happierVoice': {
        settingsToggle: undefined,
    },
    'voice.agent': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expVoiceAgent',
            subtitleKey: 'settingsFeatures.expVoiceAgentSubtitle',
        },
    },
    'voice.daemonInference': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expVoiceDaemonInference',
            subtitleKey: 'settingsFeatures.expVoiceDaemonInferenceSubtitle',
        },
    },
    'connectedServices.quotas': {
        settingsToggle: undefined,
    },
    'connectedServices.subscription': {
        settingsToggle: undefined,
    },
    'connectedServices.accountGroups': {
        settingsToggle: undefined,
    },
    'connectedServices.autoQuotaReset': { settingsToggle: undefined },
    'connectedServices.autoDisablePlanInvalid': { settingsToggle: undefined },
    'connectedServices.poolQuotaLimitSelection': { settingsToggle: undefined },
    'connectedServices.accountFallback': {
        settingsToggle: undefined,
    },
    'remoteHosts.management': {
        settingsToggle: undefined,
    },
    'remoteHosts.secretMaterial': {
        settingsToggle: undefined,
    },
    'updates.ota': {
        settingsToggle: undefined,
    },
    'sharing.session': {
        settingsToggle: undefined,
    },
    'sharing.public': {
        settingsToggle: undefined,
    },
    'sharing.contentKeys': {
        settingsToggle: undefined,
    },
    'sharing.pendingQueueV2': {
        settingsToggle: undefined,
    },
    'sharing.pendingDeliveryState': {
        settingsToggle: undefined,
    },
    sessions: {
        settingsToggle: undefined,
    },
    'sessions.folders': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: false,
            defaultEnabled: true,
            serverVisibilityScope: 'main_selection',
            titleKey: 'settingsFeatures.expSessionsFolders',
            subtitleKey: 'settingsFeatures.expSessionsFoldersSubtitle',
        },
    },
    'sessions.handoff': {
        settingsToggle: undefined,
    },
    'sessions.agentSwitching': {
        settingsToggle: undefined,
    },
    'sessions.drafts': {
        settingsToggle: undefined,
    },
    'sessions.ephemeralRunner': {
        settingsToggle: undefined,
    },
    'sessions.filteredListing': {
        settingsToggle: undefined,
    },
    'sessions.following': {
        settingsToggle: undefined,
    },
    'sessions.conversations': {
        settingsToggle: undefined,
    },
    'sessions.board': {
        settingsToggle: undefined,
    },
    'sessions.usageLimitRecovery': {
        settingsToggle: undefined,
    },
    teams: {
        settingsToggle: undefined,
    },
    'teams.credentialResources': {
        settingsToggle: undefined,
    },
    'teams.credentialResources.externalApi': {
        settingsToggle: undefined,
    },
    machines: {
        settingsToggle: undefined,
    },
    'machines.pools': {
        settingsToggle: undefined,
    },
    'machines.transfer': {
        settingsToggle: undefined,
    },
    'machines.transfer.directPeer': {
        settingsToggle: undefined,
    },
    'machines.transfer.serverRouted': {
        settingsToggle: undefined,
    },
    'machines.tunnel': {
        settingsToggle: undefined,
    },
    'machines.tunnel.directPeer': {
        settingsToggle: undefined,
    },
    'machines.tunnel.serverRouted': {
        settingsToggle: undefined,
    },
    'machines.liveStream': {
        settingsToggle: undefined,
    },
    'machines.liveStream.directPeer': {
        settingsToggle: undefined,
    },
    'machines.liveStream.serverRouted': {
        settingsToggle: undefined,
    },
    'machines.rpc': {
        settingsToggle: undefined,
    },
    'machines.rpc.directPeer': {
        settingsToggle: undefined,
    },
    'machines.peerMediation': {
        settingsToggle: undefined,
    },
    'machines.peerMediation.observability': {
        settingsToggle: undefined,
    },
    localServices: {
        settingsToggle: undefined,
    },
    'localServices.inventory': {
        settingsToggle: undefined,
    },
    'localServices.managed': {
        settingsToggle: undefined,
    },
    'localServices.launcher': {
        settingsToggle: undefined,
    },
    'localServices.actions': {
        settingsToggle: undefined,
    },
    'localServices.actions.terminate': {
        settingsToggle: undefined,
    },
    'localServices.preview': {
        settingsToggle: undefined,
    },
    'localServices.publicPreview': {
        settingsToggle: undefined,
    },
    browser: {
        settingsToggle: undefined,
    },
    'browser.viewTargets': {
        settingsToggle: undefined,
    },
    'browser.internal': {
        settingsToggle: undefined,
    },
    'browser.sidecar': {
        settingsToggle: undefined,
    },
    'browser.diagnostics': {
        settingsToggle: undefined,
    },
    'browser.context': {
        settingsToggle: undefined,
    },
    'browser.automation': {
        settingsToggle: undefined,
    },
    'browser.automation.injectedPage': {
        settingsToggle: undefined,
    },
    'browser.automation.eval': {
        settingsToggle: undefined,
    },
    'browser.recording': {
        settingsToggle: undefined,
    },
    'browser.recording.attachments': {
        settingsToggle: undefined,
    },
    plugins: {
        settingsToggle: undefined,
    },
    'plugins.webhooks': {
        settingsToggle: undefined,
    },
    'plugins.ui': {
        settingsToggle: undefined,
    },
    'plugins.ui.hostedWeb': {
        settingsToggle: undefined,
    },
    'plugins.ui.reactNativeBundles': {
        settingsToggle: undefined,
    },
    devices: {
        settingsToggle: undefined,
    },
    'devices.simulatorPreview': {
        settingsToggle: undefined,
    },
    'social.friends': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            // Historically not auto-enabled by the experiments master switch; keep it opt-in.
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expFriends',
            subtitleKey: 'settingsFeatures.expFriendsSubtitle',
        },
    },
    'inbox.global': {
        settingsToggle: undefined,
    },
    'actions.approvals': {
        settingsToggle: undefined,
    },
    'prompts.library': {
        settingsToggle: undefined,
    },
    'prompts.assets.external': {
        settingsToggle: undefined,
    },
    'prompts.skills.registries': {
        settingsToggle: undefined,
    },
    'sessions.direct': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: false,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expSessionsDirect',
            subtitleKey: 'settingsFeatures.expSessionsDirectSubtitle',
        },
    },
    providers: {
        settingsToggle: undefined,
    },
    'providers.localDiscovery': {
        settingsToggle: undefined,
    },
    'providers.localModelManagement': {
        settingsToggle: undefined,
    },
    'agents.claude.unifiedTerminal': {
        settingsToggle: undefined,
    },
    'agents.claude.unifiedTerminal.tuiRuntimeControl': {
        settingsToggle: undefined,
    },
    'agents.goals': {
        settingsToggle: undefined,
    },
    'agents.codex.appServer.goals': {
        settingsToggle: undefined,
    },
    'agents.codex.appServer.plugins': {
        settingsToggle: undefined,
    },
    'agents.codex.appServer.structuredInput': {
        settingsToggle: undefined,
    },
    'agents.codex.appServer.permissionProfiles': {
        settingsToggle: undefined,
    },
    'auth.recovery.providerReset': {
        settingsToggle: undefined,
    },
    'auth.pairing.desktopQrMobileScan': {
        settingsToggle: undefined,
    },
    'auth.pairing.boundQrV2': {
        settingsToggle: undefined,
    },
    'auth.login.keyChallenge': {
        settingsToggle: undefined,
    },
    'auth.mtls': {
        settingsToggle: undefined,
    },
    'auth.ui.recoveryKeyReminder': {
        settingsToggle: undefined,
    },
    'e2ee.keylessAccounts': {
        settingsToggle: undefined,
    },
    'app.analytics': {
        settingsToggle: undefined,
    },
    'app.crashReports': {
        settingsToggle: undefined,
    },
    'app.ui.storeReviewPrompts': {
        settingsToggle: undefined,
    },
    'app.ui.sessionGettingStartedGuidance': {
        settingsToggle: undefined,
    },
    'app.ui.changelog': {
        settingsToggle: undefined,
    },
    'app.ui.releaseNotes': {
        settingsToggle: undefined,
    },
    // Deprecated first-launch showcase flag retained for compatibility with old feature payloads.
    'app.ui.onboardingShowcase': {
        settingsToggle: undefined,
    },
    'app.ui.onboardingTour': {
        settingsToggle: undefined,
    },
    'app.ui.liveActivities': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expLiveActivities',
            subtitleKey: 'settingsFeatures.expLiveActivitiesSubtitle',
        },
    },
    'app.ui.homeScreenWidgets': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expHomeScreenWidgets',
            subtitleKey: 'settingsFeatures.expHomeScreenWidgetsSubtitle',
        },
    },
    bugReports: {
        settingsToggle: undefined,
    },
    'attachments.uploads': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expAttachmentsUploads',
            subtitleKey: 'settingsFeatures.expAttachmentsUploadsSubtitle',
        },
    },
    'scm.writeOperations': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expScmOperations',
            subtitleKey: 'settingsFeatures.expScmOperationsSubtitle',
        },
    },
    'files.reviewComments': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: false,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expFilesReviewComments',
            subtitleKey: 'settingsFeatures.expFilesReviewCommentsSubtitle',
        },
    },
    'files.diffSyntaxHighlighting': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: false,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expFilesDiffSyntaxHighlighting',
            subtitleKey: 'settingsFeatures.expFilesDiffSyntaxHighlightingSubtitle',
        },
    },
    'files.syntaxHighlighting.advanced': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: false,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expFilesAdvancedSyntaxHighlighting',
            subtitleKey: 'settingsFeatures.expFilesAdvancedSyntaxHighlightingSubtitle',
        },
    },
    'memory.search': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expMemorySearch',
            subtitleKey: 'settingsFeatures.expMemorySearchSubtitle',
        },
    },
    search: {
        settingsToggle: undefined,
    },
    'terminal.embeddedPty': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: false,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expEmbeddedTerminal',
            subtitleKey: 'settingsFeatures.expEmbeddedTerminalSubtitle',
        },
    },
    'terminal.transport.byteStream': {
        settingsToggle: undefined,
    },
    'terminal.renderer.native': {
        settingsToggle: undefined,
    },
    'terminal.renderer.iosGhostty': {
        settingsToggle: undefined,
    },
    'terminal.renderer.androidTermux': {
        settingsToggle: undefined,
    },
    'mcp.servers': {
        settingsToggle: undefined,
    },
    'files.editor': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: false,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expFilesEditor',
            subtitleKey: 'settingsFeatures.expFilesEditorSubtitle',
        },
    },
    'files.markdownRichEditor': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expMarkdownRichEditor',
            subtitleKey: 'settingsFeatures.expMarkdownRichEditorSubtitle',
        },
    },
    'zen.navigation': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expZen',
            subtitleKey: 'settingsFeatures.expZenSubtitle',
        },
    },
    'usage.reporting': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: false,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expUsageReporting',
            subtitleKey: 'settingsFeatures.expUsageReportingSubtitle',
        },
    },
    'setup.relay.allowRelaySelection': {
        settingsToggle: undefined,
    },
    'setup.relay.allowHappierCloud': {
        settingsToggle: undefined,
    },
    'setup.relay.allowCustomRelayUrl': {
        settingsToggle: undefined,
    },
    'setup.relay.allowLocalRelayHost': {
        settingsToggle: undefined,
    },
    'setup.relay.allowRemoteSshRelayHost': {
        settingsToggle: undefined,
    },
    'setup.relayAccess.allowTailscale': {
        settingsToggle: undefined,
    },
    'setup.relayAccess.allowCloudflareTunnel': {
        settingsToggle: undefined,
    },
    'setup.machine.allowLocalMachineSetup': {
        settingsToggle: undefined,
    },
    'setup.machine.allowRemoteSshMachineSetup': {
        settingsToggle: undefined,
    },
    'setup.ssh.nativeTransport': {
        settingsToggle: undefined,
    },
    'setup.providers.allowProviderSetup': {
        settingsToggle: undefined,
    },
} satisfies Readonly<Record<FeatureId, UiFeatureDefinition>>;

export function getUiFeatureDefinition(featureId: FeatureId): UiFeatureDefinition {
    return UI_FEATURE_REGISTRY[featureId];
}

export function shouldTrackUiFeaturePreference(featureId: FeatureId): boolean {
    const definition = getUiFeatureDefinition(featureId);
    if (typeof definition.analytics?.trackPreference === 'boolean') {
        return definition.analytics.trackPreference;
    }
    return Boolean(definition.settingsToggle);
}

export function shouldTrackUiFeatureEffective(featureId: FeatureId): boolean {
    const definition = getUiFeatureDefinition(featureId);
    if (typeof definition.analytics?.trackEffective === 'boolean') {
        return definition.analytics.trackEffective;
    }
    return true;
}
