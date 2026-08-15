import { describe, expect, it } from 'vitest';

import { en } from './translations/en';
import { ru } from './translations/ru';
import { pl } from './translations/pl';
import { es } from './translations/es';
import { fr } from './translations/fr';
import { it as itLocale } from './translations/it';
import { pt } from './translations/pt';
import { ca } from './translations/ca';
import { zhHans } from './translations/zh-Hans';
import { zhHant } from './translations/zh-Hant';
import { ja } from './translations/ja';

import {
    auditTranslations,
    flattenTranslationLeaves,
} from '../../tools/i18n/translationAudit';

const IGNORED_UNTRANSLATED_KEYS = new Set([
    'promptLibrary.supportingFilePathPlaceholder',
    'files.sourceControlOperations.update.remotes.namePlaceholder',
    'settingsSession.handoff.includeIgnoredMode.globsPlaceholder',
    'connectedServices.detail.prompts.accessTokenPlaceholder',
    'connectedServices.serviceNames.github',
    'deps.installable.githubCli.title',
    'newSession.githubCliBanner.title',
    'files.markdown',
    'settingsSession.sessionCreation.modalModeSimpleTitle',
    'settingsSession.sessionCreation.wizardPresentationAutoTitle',
    'settingsSession.promptPersonalization.title',
    'settingsSession.promptPersonalization.footer',
    'settingsSession.promptPersonalization.askAgentToRenameSessionsTitle',
    'settingsSession.promptPersonalization.askAgentToRenameSessionsNeverTitle',
    'settingsSession.promptPersonalization.askAgentToRenameSessionsNeverSubtitle',
    'settingsSession.promptPersonalization.askAgentToRenameSessionsInitialTitle',
    'settingsSession.promptPersonalization.askAgentToRenameSessionsInitialSubtitle',
    'settingsSession.promptPersonalization.askAgentToRenameSessionsOngoingTitle',
    'settingsSession.promptPersonalization.askAgentToRenameSessionsOngoingSubtitle',
    'settingsSession.promptPersonalization.askAgentToRenameSessionsInitialSelectedSubtitle',
    'settingsSession.promptPersonalization.askAgentToRenameSessionsOngoingSelectedSubtitle',
    'settingsSession.promptPersonalization.askAgentToRenameSessionsDisabledSubtitle',
    'settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsTitle',
    'settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsEnabledSubtitle',
    'settingsSession.promptPersonalization.askAgentToSuggestReplyOptionsDisabledSubtitle',
    'newSession.worktree.backToRoot',
    'welcome.welcomeFooterRelay',
    'settingsSession.sessionList.narrowWorkingIndicatorSpinnerTitle',
    'settingsSession.sessionList.workingIndicatorSpinnerTitle',
    'settingsSession.sessionList.identityDisplayAvatarTitle',
    'settingsSession.transcript.messageActions.template.placeholder',
    // Literal terminal multiplexer executable names.
    'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.options.tmux.title',
    'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.options.zellij.title',
]);
const IGNORED_UNTRANSLATED_KEYS_BY_LOCALE: Readonly<Record<string, ReadonlySet<string>>> = {
    es: new Set(['settingsSession.sessionList.headerIdentityDisplayAvatarTitle']),
    it: new Set(['settingsSession.sessionList.headerIdentityDisplayAvatarTitle']),
    pt: new Set([
        'agentInput.suggestionGroups.plugins',
        'settingsSession.sessionList.headerIdentityDisplayAvatarTitle',
    ]),
    // French keeps these identical to English on purpose. Three groups, no accidents:
    //   product and provider nouns (Happier, Codex, Kimi, tmux, theme preset names, model ids),
    //   the English technical vocabulary French developers actually speak and which the ratified
    //   glossary pins (prompt, worktree, workspace, token, provider, pool, commit, diff),
    //   and true cognates that are simply the same word (Actions, Options, Description, Sources).
    // A key here is a decision, not a gap; translating one of them would make the UI read worse.
    fr: new Set([
        'agentInput.acp.modeSectionTitle',
        'agentInput.acp.optionsSectionTitle',
        'agentInput.actionMenu.title',
        'agentInput.agent.auggie',
        'agentInput.agent.claude',
        'agentInput.agent.codex',
        'agentInput.agent.copilot',
        'agentInput.agent.cursor',
        'agentInput.agent.customAcp',
        'agentInput.agent.gemini',
        'agentInput.agent.grok',
        'agentInput.agent.kilo',
        'agentInput.agent.kimi',
        'agentInput.agent.kiro',
        'agentInput.agent.opencode',
        'agentInput.agent.pi',
        'agentInput.agent.qwen',
        'agentInput.codexModel.gpt5CodexHigh',
        'agentInput.codexModel.gpt5CodexLow',
        'agentInput.codexModel.gpt5CodexMedium',
        'agentInput.codexModel.gpt5High',
        'agentInput.codexModel.gpt5Low',
        'agentInput.codexModel.gpt5Medium',
        'agentInput.codexModel.gpt5Minimal',
        'agentInput.codexPermissionMode.badgePlan',
        'agentInput.codexPermissionMode.badgeSafeYolo',
        'agentInput.codexPermissionMode.badgeYolo',
        'agentInput.codexPermissionMode.safeYolo',
        'agentInput.codexPermissionMode.yolo',
        'agentInput.geminiModel.gemini25Flash.label',
        'agentInput.geminiModel.gemini25FlashLite.label',
        'agentInput.geminiModel.gemini25Pro.label',
        'agentInput.geminiPermissionMode.badgeSafeYolo',
        'agentInput.geminiPermissionMode.badgeYolo',
        'agentInput.geminiPermissionMode.safeYolo',
        'agentInput.geminiPermissionMode.yolo',
        'agentInput.mode.build',
        'agentInput.mode.plan',
        'agentInput.mode.sectionTitle',
        'agentInput.permissionMode.badgePlan',
        'agentInput.permissionMode.badgeSafeYolo',
        'agentInput.permissionMode.badgeYolo',
        'agentInput.permissionMode.safeYolo',
        'agentInput.permissionMode.yolo',
        'agentInput.suggestionGroups.plugins',
        'agentInput.suggestionGroups.sessions',
        'agentInput.suggestionGroups.skills',
        'approvals.fieldAction',
        'automations.detail.actionsGroupTitle',
        'automations.detail.status.active',
        'automations.edit.messageLabel',
        'automations.form.placeholders.cronExpression',
        'automations.form.placeholders.everyMinutes',
        'automations.form.schedule.cronTitle',
        'automations.form.sentence.cronFieldGuide.minute',
        'automations.form.sentence.intervalUnits.minutes',
        'automations.form.sentence.minutes',
        'automations.form.sentence.notes',
        'bugReports.composer.diagnostics.pasteDoctorJson.placeholder',
        'bugReports.composer.diagnostics.title',
        'bugReports.composer.environment.deploymentType.cloud',
        'commandPalette.pets.category',
        'common.actions',
        'common.info',
        'common.machine',
        'common.message',
        'common.none',
        'common.ok',
        'common.urlPlaceholder',
        'common.version',
        'components.emptyMainScreen.runCommand',
        'connect.accountUrlPlaceholder',
        'connect.secretKeyPlaceholder',
        'connect.terminalUrlPlaceholder',
        'connectedServices.account.poolsLabel',
        'connectedServices.authChip.label',
        'connectedServices.detail.actionsGroupTitle',
        'connectedServices.detail.groupActions.groupIdPlaceholder',
        'connectedServices.detail.groupDetail.optionsTitle',
        'connectedServices.detail.groupDetail.routeTitle',
        'connectedServices.detail.groups.title',
        'connectedServices.detail.prompts.accessTokenPlaceholder',
        'connectedServices.detail.prompts.accessTokenTitle',
        'connectedServices.detail.prompts.apiKeyPlaceholder',
        'connectedServices.detail.prompts.profileIdPlaceholder',
        'connectedServices.detail.prompts.setupTokenPlaceholder',
        'connectedServices.detail.prompts.setupTokenTitle',
        'connectedServices.detail.segments.pools',
        'connectedServices.pools.autoBadge',
        'connectedServices.pools.title',
        'connectedServices.profile.connectedViaOauth',
        'connectedServices.profile.connectedViaToken',
        'connectedServices.profile.poolsGroupTitle',
        'connectedServices.profile.quotaTitle',
        'connectedServices.serviceNames.gemini',
        'connectedServices.serviceNames.github',
        'connectedServices.serviceNames.openaiCodex',
        'connectionStatus.labels.socket',
        'deps.installable.githubCli.title',
        'devVoiceQa.actionsTitle',
        'devVoiceQa.configurationTitle',
        'devVoiceQa.promptLabel',
        'diagnosis.pasteDoctorJson.placeholder',
        'diagnosis.sections.actions',
        'directSessions.browseMachines',
        'directSessions.browseProviders',
        'directSessions.browseSources',
        'executionRuns.newRun.intents.plan',
        'executionRuns.newRun.sections.backends',
        'executionRuns.newRun.sections.instructions',
        'executionRuns.newRun.sections.permissions',
        'files.branchMenu.category.actions',
        'files.branchMenu.category.branches',
        'files.branchMenu.category.local',
        'files.branchMenu.category.options',
        'files.branchMenu.category.remote',
        'files.branchMenu.category.worktrees',
        'files.branchMenu.pullRequests.promptPlaceholder',
        'files.commitDetails.commitLabel',
        'files.diff',
        'files.markdown',
        'files.sourceControlOperations.actions.fetch',
        'files.sourceControlOperations.actions.pull',
        'files.sourceControlOperations.actions.push',
        'files.sourceControlOperations.update.branchIntegration.merge',
        'files.sourceControlOperations.update.branchIntegration.rebase',
        'files.sourceControlOperations.update.publishRepository.public',
        'files.sourceControlOperations.update.publishRepository.repositoryNamePlaceholder',
        'files.sourceControlOperations.update.pullRequests.title',
        'files.sourceControlOperations.update.remotes.namePlaceholder',
        'files.sourceControlOperations.update.remotes.title',
        'files.toolbar.scm',
        'inbox.permissions',
        'machine.architecture',
        'machine.daemon',
        'machine.installables.autoUpdateModes.auto',
        'machine.installables.screenTitle',
        'machine.machineGroup',
        'machine.tools.installablesTitle',
        'machine.windows.title',
        'markdown.codeLabel',
        'markdown.diffLabel',
        'memorySearchSettings.backfill.title',
        'memorySearchSettings.embeddings.groupTitle',
        'memorySearchSettings.embeddings.modelPlaceholder',
        'memorySearchSettings.embeddings.openAi.dimensionsTitle',
        'memorySearchSettings.embeddings.provider.title',
        'memorySearchSettings.indexMode.triggerTitle',
        'memorySearchSettings.machine.title',
        'newSession.checkout.actionsSectionTitle',
        'newSession.codexAcpBanner.title',
        'newSession.githubCliBanner.title',
        'newSession.mcpChipLabel',
        'newSession.sessionType.simple',
        'newSession.sessionType.worktree',
        'newSession.worktree.backToRoot',
        'newSession.worktree.nameStep.backLabel',
        'notifications.activity.defaultSessionTitle',
        'profiles.aiBackend.auggieSubtitle',
        'profiles.aiBackend.claudeSubtitle',
        'profiles.aiBackend.codexSubtitle',
        'profiles.aiBackend.opencodeSubtitle',
        'profiles.builtInNames.azureOpenai',
        'profiles.builtInNames.deepseek',
        'profiles.builtInNames.geminiVertex',
        'profiles.builtInNames.minimax',
        'profiles.builtInNames.minimaxCn',
        'profiles.builtInNames.openai',
        'profiles.builtInNames.zai',
        'profiles.environmentVariables.previewModal.descriptionSuffix',
        'profiles.environmentVariables.previewModal.detail.machine',
        'profiles.machineLogin.claudeCode.title',
        'profiles.machineLogin.codex.title',
        'profiles.machineLogin.geminiCli.title',
        'profiles.requirements.secretRequired',
        'profiles.tmux.title',
        'promptLibrary.actions',
        'promptLibrary.externalAssetsMachine',
        'promptLibrary.prompts',
        'promptLibrary.registriesSources',
        'promptLibrary.sections',
        'promptLibrary.skills',
        'promptLibrary.supportingFilePathPlaceholder',
        'promptLibrary.tagsLabel',
        'promptLibrary.templateTargetPromptLabel',
        'promptLibrary.templates',
        'runs.delivery.promptLabel',
        'runs.machinesSubtitle',
        'secrets.badgeReady',
        'secrets.placeholders.valueExample',
        'server.retention.sessions',
        'server.serverGroupServersLabel',
        'session.agentActivity.screenTitle',
        'session.inactiveNotResumable',
        'session.planOutput.title',
        'session.rightPanel.tabs.git',
        'session.sharing.session',
        'session.subagents.intent.plan',
        'session.subagents.intent.review',
        'session.subagents.kind.execution_run',
        'session.subagents.kind.subagent_sidechain',
        'session.subagents.panel.teamIdPlaceholder',
        'session.subagents.panel.title',
        'session.workState.goal.pause',
        'sessionGettingStarted.steps.authLogin.copyLabel',
        'sessionInfo.checkoutLabel',
        'sessionInfo.happyHome',
        'sessionInfo.workspaceLabel',
        'sessionInfo.workspaceTitle',
        'settings.acpCatalogFieldDescription',
        'settings.acpCatalogFieldId',
        'settings.eula',
        'settings.github',
        'settings.machines',
        'settings.mcpServersArgsPlaceholder',
        'settings.mcpServersBindingMachine',
        'settings.mcpServersBindingTargetMachineTitle',
        'settings.mcpServersBindingTargetWorkspaceTitle',
        'settings.mcpServersBindingTitle',
        'settings.mcpServersDetectedDirectoryPlaceholder',
        'settings.mcpServersDetectedMachineTitle',
        'settings.mcpServersEditorBindings',
        'settings.mcpServersEditorRemote',
        'settings.mcpServersEditorStdio',
        'settings.mcpServersEnvKeyPlaceholder',
        'settings.mcpServersFieldArgs',
        'settings.mcpServersFieldCommandLinePlaceholder',
        'settings.mcpServersFieldTransport',
        'settings.mcpServersFieldUrl',
        'settings.mcpServersHeaderKeyPlaceholder',
        'settings.mcpServersImportJsonPlaceholder',
        'settings.mcpServersImportMachineEnvPlaceholder',
        'settings.mcpServersPreviewAgentTitle',
        'settings.mcpServersPreviewDirectoryPlaceholder',
        'settings.mcpServersPreviewMachineTitle',
        'settings.mcpServersScopeMachine',
        'settings.mcpServersScopeWorkspace',
        'settings.mcpServersSourceHappier',
        'settings.mcpServersTestTitle',
        'settings.notifications',
        'settings.permissions',
        'settings.secrets',
        'settings.servers',
        'settings.session',
        'settings.sessions',
        'settings.social',
        'settings.terminal',
        'settings.transcript',
        'settings.workspaces',
        'settingsAccount.analytics',
        'settingsAccount.github',
        'settingsActions.spawnPolicy.permissionCeiling.options.plan.title',
        'settingsActions.spawnPolicy.permissionCeiling.options.safe-yolo.title',
        'settingsActions.spawnPolicy.permissionCeiling.options.yolo.title',
        'settingsActions.targets.mcp.title',
        'settingsAppearance.agentInputActionBarLayoutOptions.auto',
        'settingsAppearance.agentInputChipDensityOptions.auto',
        'settingsAppearance.contentWidthOptions.compact',
        'settingsAppearance.itemDensityOptions.compact',
        'settingsAppearance.tabBarAppearance.sizeCompact',
        'settingsChannelBridges.telegramTitle',
        'settingsFeatures.expExecutionRuns',
        'settingsFeatures.expZen',
        'settingsFeatures.historyScopeGlobalOption',
        'settingsFeatures.sessionListGrouping.dateTitle',
        'settingsNotifications.badges.title',
        'settingsNotifications.pushTroubleshooting.actions.title',
        'settingsNotifications.pushTroubleshooting.permission.title',
        'settingsNotifications.types.title',
        'settingsNotifications.webhooks.signingSecretPromptPlaceholder',
        'settingsNotifications.webhooks.urlPromptPlaceholder',
        'settingsPets.title',
        'settingsProviders.channelStable',
        'settingsProviders.configuration',
        'settingsProviders.dynamicModelProbeAuto',
        'settingsProviders.plugins.auggie.title',
        'settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.1p.title',
        'settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.api.title',
        'settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.hooks.title',
        'settingsProviders.plugins.claude.fields.claudeRemoteDebugCategories.options.mcp.title',
        'settingsProviders.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.local.title',
        'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.options.auto.title',
        'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.options.tmux.title',
        'settingsProviders.plugins.claude.fields.claudeUnifiedTerminalHost.options.zellij.title',
        'settingsProviders.plugins.claude.title',
        'settingsProviders.plugins.codex.fields.codexBackendMode.options.acp.title',
        'settingsProviders.plugins.codex.fields.codexBackendMode.options.appServer.title',
        'settingsProviders.plugins.codex.fields.codexBackendMode.options.mcp.title',
        'settingsProviders.plugins.codex.title',
        'settingsProviders.plugins.copilot.title',
        'settingsProviders.plugins.cursor.sections.cli.title',
        'settingsProviders.plugins.cursor.title',
        'settingsProviders.plugins.gemini.title',
        'settingsProviders.plugins.grok.title',
        'settingsProviders.plugins.kilo.title',
        'settingsProviders.plugins.kimi.title',
        'settingsProviders.plugins.kiro.title',
        'settingsProviders.plugins.opencode.title',
        'settingsProviders.plugins.pi.title',
        'settingsProviders.plugins.qwen.title',
        'settingsProviders.runtimeSwitchAcpSetSessionMode',
        'settingsSession.handoff.includeIgnoredMode.globsPlaceholder',
        'settingsSession.mobileWorkspaceExperience.options.cockpitTitle',
        'settingsSession.permissions.title',
        'settingsSession.providerUsageGauge.windowSessionTitle',
        'settingsSession.replayResume.maxSeedCharsPlaceholder',
        'settingsSession.replayResume.recentMessagesPlaceholder',
        'settingsSession.replayResume.summaryRunner.backendPlaceholder',
        'settingsSession.replayResume.summaryRunner.backendTitle',
        'settingsSession.replayResume.summaryRunner.modelPlaceholder',
        'settingsSession.sessionList.headerIdentityDisplayAvatarTitle',
        'settingsSession.sessionList.identityDisplayAvatarTitle',
        'settingsSession.sessionList.narrowWorkingIndicatorSpinnerTitle',
        'settingsSession.sessionList.workingIndicatorSpinnerTitle',
        'settingsSession.terminalConnect.title',
        'settingsSession.toolDetailLevel.compactTitle',
        'settingsSession.toolRendering.cardDensity.compactTitle',
        'settingsSession.transcript.advanced.performanceTitle',
        'settingsSession.transcript.messageActions.template.placeholder',
        'settingsSession.transcript.motionPickerTitle',
        'settingsSession.transcript.title',
        'settingsSession.windows.title',
        'settingsSession.windows.windowNamePlaceholder',
        'settingsVoice.byo.agentId',
        'settingsVoice.byo.agentIdPlaceholder',
        'settingsVoice.byo.apiKeyPlaceholder',
        'settingsVoice.byo.realtime.modelPicker.detailAuto',
        'settingsVoice.byo.realtime.modelPicker.options.autoTitle',
        'settingsVoice.byo.realtime.voiceSettings.similarityBoost.promptTitle',
        'settingsVoice.byo.realtime.voiceSettings.similarityBoost.title',
        'settingsVoice.byo.realtime.voiceSettings.style.promptTitle',
        'settingsVoice.byo.realtime.voiceSettings.style.title',
        'settingsVoice.byo.speakerBoostAuto',
        'settingsVoice.byo.speakerBoostTitle',
        'settingsVoice.local.baseUrlPlaceholder',
        'settingsVoice.local.conversation.streaming.title',
        'settingsVoice.local.googleCloudTts.format.title',
        'settingsVoice.local.googleCloudTts.provider.detail',
        'settingsVoice.local.googleCloudTts.provider.title',
        'settingsVoice.local.googleGeminiStt.language.autoTitle',
        'settingsVoice.local.googleGeminiStt.provider.detail',
        'settingsVoice.local.googleGeminiStt.provider.title',
        'settingsVoice.local.kokoro.common.none',
        'settingsVoice.local.mediatorBackendDaemon',
        'settingsVoice.mode.happier',
        'settingsVoice.ui.scopeSession',
        'settingsVoice.ui.surfaceLocation.autoTitle',
        'settingsVoice.ui.surfaceLocation.sessionTitle',
        'settingsVoice.ui.updates.otherSessionsSnippetsMode.autoTitle',
        'sidebar.sessionsTitle',
        'subAgentGuidance.ruleEditor.exampleToolCalls.placeholder',
        'subAgentGuidance.ruleEditor.intent.options.plan.title',
        'subAgentGuidance.settings.groupTitle',
        'subAgentGuidance.settings.overview.happierStatusTitle',
        'subAgentGuidance.settings.related.providersTitle',
        'systemStatus.sections.actions',
        'systemStatus.sections.application',
        'systemStatus.ui.socket',
        'tabs.sessions',
        'terminalEmbedded.quickKeys.ctrlC',
        'terminalEmbedded.quickKeys.ctrlD',
        'terminalEmbedded.quickKeys.esc',
        'terminalEmbedded.quickKeys.tab',
        'tools.agentTeamView.description',
        'tools.agentTeamView.type',
        'tools.fullView.description',
        'tools.names.question',
        'tools.names.subAgent',
        'tools.names.terminal',
        'tools.names.viewDiff',
        'tools.structuredResult.diff',
        'tools.structuredResult.stderr',
        'tools.structuredResult.stdout',
        'tools.subAgentRunView.planTitle',
        'tools.workflowActivityView.phaseUntitled',
        'tools.workflowActivityView.untitled',
        'tools.workspaceIndexingPermission.optionFallback',
        'usage.tokens',
        'voiceActivity.format.action',
        'voiceActivity.format.assistant',
        'voiceActivity.format.assistantStreaming',
        'welcome.welcomeFooterDocsAction',
        'windowsRemoteSessionLaunchMode.console',
        'windowsRemoteSessionLaunchMode.shortConsole',
        'windowsRemoteSessionLaunchMode.shortWindowsTerminal',
        'windowsRemoteSessionLaunchMode.windowsTerminal',
        'zen.title',
    ]),
    // These locales use the same spelling for this label.
    ca: new Set([
        'agentInput.suggestionGroups.sessions',
        'message.runtimeConfigOutcomeKeyModel',
        'session.agentActivity.screenTitle',
        'settingsSession.sessionList.headerIdentityDisplayAvatarTitle',
    ]),
    pl: new Set(['message.runtimeConfigOutcomeKeyModel']),
};
const IGNORED_UNTRANSLATED_KEY_PREFIXES = [
    'settingsAppearance.themeProfiles.',
    'settingsKeyboard.',
    'settingsSession.sessionCreation.',
    'settingsSession.promptPersonalization.',
    'commandPalette.commands.',
    'releaseNotes.onboardingShowcase.',
    'sessionsList.',
];
const UNTRANSLATED_PREFIX_BASELINE_COUNTS: Record<string, Record<string, number>> = {
    fr: {
        'settingsAppearance.themeProfiles.': 27,
        'settingsKeyboard.': 2,
        'settingsSession.sessionCreation.': 2,
        'settingsSession.promptPersonalization.': 0,
        'commandPalette.commands.': 3,
        'releaseNotes.onboardingShowcase.': 0,
        'sessionsList.': 6,
    },
    ru: {
        'settingsAppearance.themeProfiles.': 106,
        'settingsKeyboard.': 21,
        'settingsSession.sessionCreation.': 1,
        'settingsSession.promptPersonalization.': 15,
        'commandPalette.commands.': 35,
        'releaseNotes.onboardingShowcase.': 0,
        'sessionsList.': 22,
    },
    pl: {
        'settingsAppearance.themeProfiles.': 106,
        'settingsKeyboard.': 21,
        'settingsSession.sessionCreation.': 1,
        'settingsSession.promptPersonalization.': 15,
        'commandPalette.commands.': 35,
        'releaseNotes.onboardingShowcase.': 0,
        'sessionsList.': 22,
    },
    es: {
        'settingsAppearance.themeProfiles.': 106,
        'settingsKeyboard.': 21,
        'settingsSession.sessionCreation.': 2,
        'settingsSession.promptPersonalization.': 15,
        'commandPalette.commands.': 35,
        'releaseNotes.onboardingShowcase.': 14,
        'sessionsList.': 22,
    },
    it: {
        'settingsAppearance.themeProfiles.': 106,
        'settingsKeyboard.': 21,
        'settingsSession.sessionCreation.': 1,
        'settingsSession.promptPersonalization.': 15,
        'commandPalette.commands.': 35,
        'releaseNotes.onboardingShowcase.': 14,
        'sessionsList.': 22,
    },
    pt: {
        'settingsAppearance.themeProfiles.': 106,
        'settingsKeyboard.': 21,
        'settingsSession.sessionCreation.': 1,
        'settingsSession.promptPersonalization.': 15,
        'commandPalette.commands.': 35,
        'releaseNotes.onboardingShowcase.': 0,
        'sessionsList.': 22,
    },
    ca: {
        'settingsAppearance.themeProfiles.': 106,
        'settingsKeyboard.': 21,
        'settingsSession.sessionCreation.': 2,
        'settingsSession.promptPersonalization.': 15,
        'commandPalette.commands.': 35,
        'releaseNotes.onboardingShowcase.': 0,
        'sessionsList.': 22,
    },
    'zh-Hans': {
        'settingsAppearance.themeProfiles.': 106,
        'settingsKeyboard.': 21,
        'settingsSession.sessionCreation.': 1,
        'settingsSession.promptPersonalization.': 15,
        'commandPalette.commands.': 35,
        'releaseNotes.onboardingShowcase.': 0,
        'sessionsList.': 22,
    },
    'zh-Hant': {
        'settingsAppearance.themeProfiles.': 106,
        'settingsKeyboard.': 21,
        'settingsSession.sessionCreation.': 1,
        'settingsSession.promptPersonalization.': 15,
        'commandPalette.commands.': 35,
        'releaseNotes.onboardingShowcase.': 0,
        'sessionsList.': 22,
    },
    ja: {
        'settingsAppearance.themeProfiles.': 106,
        'settingsKeyboard.': 21,
        'settingsSession.sessionCreation.': 1,
        'settingsSession.promptPersonalization.': 15,
        'commandPalette.commands.': 35,
        'releaseNotes.onboardingShowcase.': 0,
        'sessionsList.': 22,
    },
};

// This test is a drift-stopper: it fails if we introduce any *new* untranslated English strings outside
// of explicitly allowlisted scopes in `apps/ui/tools/i18n/translationAudit.ts`.
const MAX_UNTRANSLATED_STRINGS = 0;

const FUNCTION_SAMPLE_ARGS_BY_KEY = new Map<string, unknown[]>([
    ['transcript.selection.selectedCount', [{ count: 1 }, { count: 2 }]],
    ['transcript.selection.copyA11y', [{ count: 1 }, { count: 2 }]],
    ['transcript.selection.sendA11y', [{ count: 1 }, { count: 2 }]],
    ['connectedServices.detail.groups.memberQuotaExhaustedUntil', [{ time: '12:00' }]],
    ['connectedServices.detail.groups.memberRateLimitedUntil', [{ time: '12:00' }]],
    ['connectedServices.detail.groups.memberCapacityLimitedUntil', [{ time: '12:00' }]],
    ['connectedServices.detail.groups.memberAuthInvalidUntil', [{ time: '12:00' }]],
    ['connectedServices.detail.groups.memberPlanUnavailableUntil', [{ time: '12:00' }]],
    ['connectedServices.detail.groups.memberValidationBlockedUntil', [{ time: '12:00' }]],
    ['memorySearchSettings.indexContents.subtitle', [{ sessions: 2, lightShards: 3, deepChunks: 4 }]],
    ['memorySearchSettings.queue.subtitle', [{ selected: 1, queued: 2, indexing: 3, indexed: 4, empty: 5, failed: 6, waiting: 7 }]],
    ['memorySearchSettings.queue.workerPhase', [{ phase: 'backfill' }]],
    ['memorySearchSettings.lastRun.subtitle', [{ considered: 2, processed: 3, semanticRows: 4, failures: 5 }]],
]);

const IGNORED_IDENTICAL_STRING_KEYS = new Set([
    'settingsSession.transcript.messageActions.template.placeholder',
]);
const STRING_KEYS_REQUIRING_LOCALIZATION = new Set([
    'transcript.selection.sendTo.searchPlaceholder',
    'transcript.selection.sendTo.addNotePlaceholder',
]);

const INHERITED_LOCALE_FALLBACKS = [
    { locale: 'zh-Hant', fallbackLocale: 'zh-Hans', fallbackRoot: zhHans },
];

type SampledTranslationFunction = (arg: unknown) => unknown;

function evaluateTranslationFunction(fn: SampledTranslationFunction, arg: unknown): string | null {
    const value = fn(arg);
    return typeof value === 'string' ? value : null;
}

describe('i18n integrity', () => {
    it('does not increase the number of untranslated English strings', () => {
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'fr', root: fr },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];
        const report = auditTranslations({
            en,
            locales,
        });

        const allUntranslated = Object.entries(report)
            .flatMap(([locale, r]) => r.untranslatedStrings.map((u) => ({ ...u, locale })));
        const baselineIncreases = Object.entries(UNTRANSLATED_PREFIX_BASELINE_COUNTS)
            .flatMap(([locale, counts]) => Object.entries(counts).map(([prefix, max]) => {
                const count = allUntranslated.filter((entry) => entry.locale === locale && entry.key.startsWith(prefix)).length;
                return { locale, prefix, count, max };
            }))
            .filter((entry) => entry.count > entry.max);
        if (baselineIncreases.length > 0) {
            throw new Error(
                [
                    'Found new untranslated strings inside prefix-scoped i18n baselines.',
                    'Translate the new keys or intentionally update the fixed baseline count.',
                    '',
                    ...baselineIncreases.map((entry) => `${entry.locale}: ${entry.prefix} ${entry.count}/${entry.max}`),
                ].join('\n')
            );
        }

        const untranslated = allUntranslated
            .filter((entry) => {
                if (IGNORED_UNTRANSLATED_KEYS.has(entry.key)) return false;
                if (IGNORED_UNTRANSLATED_KEYS_BY_LOCALE[entry.locale]?.has(entry.key)) return false;
                return !IGNORED_UNTRANSLATED_KEY_PREFIXES.some((prefix) => entry.key.startsWith(prefix));
            });

        if (untranslated.length > MAX_UNTRANSLATED_STRINGS) {
            const sample = untranslated
                .slice(0, 40)
                .map((u) => `${u.locale}: ${u.key} = ${JSON.stringify(u.value)}`)
                .join('\n');
            throw new Error(
                [
                    `Found ${untranslated.length} untranslated strings identical to English.`,
                    `Expected ${MAX_UNTRANSLATED_STRINGS}; translate strings or add explicit allowlist entries for intentional fallbacks.`,
                    'Translate these strings in the locale files under sources/text/translations/.',
                    '',
                    'Sample:',
                    sample,
                ].join('\n')
            );
        }

        expect(untranslated.length).toBeLessThanOrEqual(MAX_UNTRANSLATED_STRINGS);

        const enLeaves = new Map(flattenTranslationLeaves(en).map((leaf) => [leaf.key, leaf]));
        const missingFunctionOutputs = locales.flatMap((locale) => {
            const localeLeaves = new Map(flattenTranslationLeaves(locale.root).map((leaf) => [leaf.key, leaf]));
            return Array.from(FUNCTION_SAMPLE_ARGS_BY_KEY.keys()).flatMap((key) => {
                const enLeaf = enLeaves.get(key);
                if (enLeaf?.kind !== 'function') return [];
                const localeLeaf = localeLeaves.get(key);
                if (localeLeaf?.kind === 'function') return [];
                return [{
                    locale: locale.code,
                    key,
                    actualKind: localeLeaf?.kind ?? 'missing',
                }];
            });
        });

        if (missingFunctionOutputs.length > 0) {
            const sample = missingFunctionOutputs
                .slice(0, 40)
                .map((entry) => `${entry.locale}: ${entry.key} (${entry.actualKind})`)
                .join('\n');
            throw new Error(
                [
                    `Found ${missingFunctionOutputs.length} missing sampled translation function keys.`,
                    'Add locale functions for these guarded keys so runtime fallback does not return English.',
                    '',
                    'Sample:',
                    sample,
                ].join('\n')
            );
        }

        const untranslatedFunctionOutputs = locales.flatMap((locale) => {
            const localeLeaves = new Map(flattenTranslationLeaves(locale.root).map((leaf) => [leaf.key, leaf]));
            return Array.from(FUNCTION_SAMPLE_ARGS_BY_KEY.entries()).flatMap(([key, sampleArgs]) => {
                const enLeaf = enLeaves.get(key);
                const localeLeaf = localeLeaves.get(key);
                if (enLeaf?.kind !== 'function' || localeLeaf?.kind !== 'function') return [];

                return sampleArgs.flatMap((sampleArg, sampleIndex) => {
                    const enValue = evaluateTranslationFunction(enLeaf.value as SampledTranslationFunction, sampleArg);
                    const localeValue = evaluateTranslationFunction(localeLeaf.value as SampledTranslationFunction, sampleArg);
                    if (!enValue || !localeValue || localeValue !== enValue) return [];
                    return [{
                        locale: locale.code,
                        key,
                        sampleIndex,
                        value: localeValue,
                    }];
                });
            });
        });

        if (untranslatedFunctionOutputs.length > 0) {
            const sample = untranslatedFunctionOutputs
                .slice(0, 40)
                .map((entry) => `${entry.locale}: ${entry.key}[${entry.sampleIndex}] = ${JSON.stringify(entry.value)}`)
                .join('\n');
            throw new Error(
                [
                    `Found ${untranslatedFunctionOutputs.length} untranslated function outputs identical to English.`,
                    'Translate these function-returned strings in sources/text/translations/.',
                    '',
                    'Sample:',
                    sample,
                ].join('\n')
            );
        }

        const inheritedFallbackFunctionOutputs = INHERITED_LOCALE_FALLBACKS.flatMap((fallback) => {
            const locale = locales.find((candidate) => candidate.code === fallback.locale);
            if (!locale) return [];
            const localeLeaves = new Map(flattenTranslationLeaves(locale.root).map((leaf) => [leaf.key, leaf]));
            const fallbackLeaves = new Map(flattenTranslationLeaves(fallback.fallbackRoot).map((leaf) => [leaf.key, leaf]));
            return Array.from(FUNCTION_SAMPLE_ARGS_BY_KEY.entries()).flatMap(([key, sampleArgs]) => {
                const localeLeaf = localeLeaves.get(key);
                const fallbackLeaf = fallbackLeaves.get(key);
                if (localeLeaf?.kind !== 'function' || fallbackLeaf?.kind !== 'function') return [];

                return sampleArgs.flatMap((sampleArg, sampleIndex) => {
                    const localeValue = evaluateTranslationFunction(localeLeaf.value as SampledTranslationFunction, sampleArg);
                    const fallbackValue = evaluateTranslationFunction(fallbackLeaf.value as SampledTranslationFunction, sampleArg);
                    if (!localeValue || !fallbackValue || localeValue !== fallbackValue) return [];
                    return [{
                        locale: fallback.locale,
                        fallbackLocale: fallback.fallbackLocale,
                        key,
                        sampleIndex,
                        value: localeValue,
                    }];
                });
            });
        });

        if (inheritedFallbackFunctionOutputs.length > 0) {
            const sample = inheritedFallbackFunctionOutputs
                .slice(0, 40)
                .map((entry) => `${entry.locale}: ${entry.key}[${entry.sampleIndex}] inherited from ${entry.fallbackLocale} = ${JSON.stringify(entry.value)}`)
                .join('\n');
            throw new Error(
                [
                    `Found ${inheritedFallbackFunctionOutputs.length} sampled function outputs inherited from a fallback locale.`,
                    'Add locale-specific functions for these guarded keys so runtime fallback does not leak the fallback locale.',
                    '',
                    'Sample:',
                    sample,
                ].join('\n')
            );
        }

        const enStringLeaves = new Map(
            flattenTranslationLeaves(en)
                .filter((leaf) => leaf.kind === 'string')
                .map((leaf) => [leaf.key, leaf.value])
        );
        const identicalStringValues = locales.flatMap((locale) => {
            return flattenTranslationLeaves(locale.root).flatMap((leaf) => {
                if (leaf.kind !== 'string') return [];
                if (IGNORED_IDENTICAL_STRING_KEYS.has(leaf.key)) return [];
                if (!STRING_KEYS_REQUIRING_LOCALIZATION.has(leaf.key)) return [];
                const enValue = enStringLeaves.get(leaf.key);
                if (!enValue || leaf.value !== enValue) return [];
                return [{ locale: locale.code, key: leaf.key, value: leaf.value }];
            });
        });

        if (identicalStringValues.length > 0) {
            const sample = identicalStringValues
                .slice(0, 40)
                .map((entry) => `${entry.locale}: ${entry.key} = ${JSON.stringify(entry.value)}`)
                .join('\n');
            throw new Error(
                [
                    `Found ${identicalStringValues.length} string values identical to English.`,
                    'Translate the values or add a narrow intentional fallback allowlist entry.',
                    '',
                    'Sample:',
                    sample,
                ].join('\n')
            );
        }
    });
});
