import type { FeatureId } from '@happier-dev/protocol';
import type { TranslationKey } from '@/text';

export type UiFeatureToggleServerVisibilityScope = 'main_selection' | 'runtime';

export type UiFeatureDefinition = Readonly<{
    settingsToggle?: Readonly<{
        showInSettings: boolean;
        isExperimental: boolean;
        defaultEnabled: boolean;
        serverVisibilityScope?: UiFeatureToggleServerVisibilityScope;
        titleKey: TranslationKey;
        subtitleKey: TranslationKey;
        icon: Readonly<{
            ioniconName: string;
            color: string;
        }>;
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
            isExperimental: true,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expAutomations',
            subtitleKey: 'settingsFeatures.expAutomationsSubtitle',
            icon: { ioniconName: 'timer-outline', color: '#007AFF' },
        },
    },
    'execution.runs': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expExecutionRuns',
            subtitleKey: 'settingsFeatures.expExecutionRunsSubtitle',
            icon: { ioniconName: 'code-slash-outline', color: '#AF52DE' },
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
            icon: { ioniconName: 'paw-outline', color: '#34C759' },
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
    voice: {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.voice',
            subtitleKey: 'settingsFeatures.voiceSubtitle',
            icon: { ioniconName: 'mic-outline', color: '#34C759' },
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
            icon: { ioniconName: 'sparkles-outline', color: '#AF52DE' },
        },
    },
    'voice.daemonInference': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expVoiceDaemonInference',
            subtitleKey: 'settingsFeatures.expVoiceDaemonInferenceSubtitle',
            icon: { ioniconName: 'hardware-chip-outline', color: '#34C759' },
        },
    },
    'connectedServices.quotas': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expConnectedServicesQuotas',
            subtitleKey: 'settingsFeatures.expConnectedServicesQuotasSubtitle',
            icon: { ioniconName: 'analytics-outline', color: '#34C759' },
        },
    },
    'connectedServices.accountGroups': {
        settingsToggle: undefined,
    },
    'connectedServices.accountFallback': {
        settingsToggle: undefined,
    },
    channelBridges: {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            serverVisibilityScope: 'runtime',
            titleKey: 'settingsFeatures.expChannelBridges',
            subtitleKey: 'settingsFeatures.expChannelBridgesSubtitle',
            icon: { ioniconName: 'swap-horizontal-outline', color: '#FF9500' },
        },
    },
    'channelBridges.telegram': {
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
            icon: { ioniconName: 'folder-outline', color: '#5856D6' },
        },
    },
    'sessions.handoff': {
        settingsToggle: undefined,
    },
    'sessions.usageLimitRecovery': {
        settingsToggle: undefined,
    },
    machines: {
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
    'plugins.ui': {
        settingsToggle: undefined,
    },
    'plugins.ui.hostedWeb': {
        settingsToggle: undefined,
    },
    'plugins.ui.structuredMessages': {
        settingsToggle: undefined,
    },
    'plugins.ui.reactNativeBundles': {
        settingsToggle: undefined,
    },
    'plugins.ui.reactNativeBundles.devHotReload': {
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
            icon: { ioniconName: 'people-outline', color: '#007AFF' },
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
            icon: { ioniconName: 'albums-outline', color: '#34C759' },
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
            icon: { ioniconName: 'phone-portrait-outline', color: '#34C759' },
        },
    },
    'app.ui.homeScreenWidgets': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expHomeScreenWidgets',
            subtitleKey: 'settingsFeatures.expHomeScreenWidgetsSubtitle',
            icon: { ioniconName: 'grid-outline', color: '#007AFF' },
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
            icon: { ioniconName: 'attach-outline', color: '#007AFF' },
        },
    },
    'scm.writeOperations': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expScmOperations',
            subtitleKey: 'settingsFeatures.expScmOperationsSubtitle',
            icon: { ioniconName: 'git-branch-outline', color: '#FF9500' },
        },
    },
    'files.reviewComments': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: false,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expFilesReviewComments',
            subtitleKey: 'settingsFeatures.expFilesReviewCommentsSubtitle',
            icon: { ioniconName: 'chatbox-ellipses-outline', color: '#34C759' },
        },
    },
    'files.diffSyntaxHighlighting': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: false,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expFilesDiffSyntaxHighlighting',
            subtitleKey: 'settingsFeatures.expFilesDiffSyntaxHighlightingSubtitle',
            icon: { ioniconName: 'color-palette-outline', color: '#007AFF' },
        },
    },
    'files.syntaxHighlighting.advanced': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: false,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expFilesAdvancedSyntaxHighlighting',
            subtitleKey: 'settingsFeatures.expFilesAdvancedSyntaxHighlightingSubtitle',
            icon: { ioniconName: 'sparkles-outline', color: '#AF52DE' },
        },
    },
    'memory.search': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expMemorySearch',
            subtitleKey: 'settingsFeatures.expMemorySearchSubtitle',
            icon: { ioniconName: 'search-outline', color: '#34C759' },
        },
    },
    'terminal.embeddedPty': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expEmbeddedTerminal',
            subtitleKey: 'settingsFeatures.expEmbeddedTerminalSubtitle',
            icon: { ioniconName: 'terminal-outline', color: '#AF52DE' },
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
            icon: { ioniconName: 'create-outline', color: '#FF9500' },
        },
    },
    'files.markdownRichEditor': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: false,
            titleKey: 'settingsFeatures.expMarkdownRichEditor',
            subtitleKey: 'settingsFeatures.expMarkdownRichEditorSubtitle',
            icon: { ioniconName: 'document-text-outline', color: '#AF52DE' },
        },
    },
    'zen.navigation': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: true,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expZen',
            subtitleKey: 'settingsFeatures.expZenSubtitle',
            icon: { ioniconName: 'leaf-outline', color: '#34C759' },
        },
    },
    'usage.reporting': {
        settingsToggle: {
            showInSettings: true,
            isExperimental: false,
            defaultEnabled: true,
            titleKey: 'settingsFeatures.expUsageReporting',
            subtitleKey: 'settingsFeatures.expUsageReportingSubtitle',
            icon: { ioniconName: 'analytics-outline', color: '#007AFF' },
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
