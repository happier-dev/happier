import { describe, expect, it } from 'vitest';

import { en } from './translations/en';
import { ru } from './translations/ru';
import { pl } from './translations/pl';
import { es } from './translations/es';
import { fr } from './translations/fr';
import { it as itLocale } from './translations/it';
import { pt } from './translations/pt';
import { ca } from './translations/ca';
import { de } from './translations/de';
import { zhHans } from './translations/zh-Hans';
import { zhHant } from './translations/zh-Hant';
import { ja } from './translations/ja';

import { SUPPORTED_LANGUAGE_CODES } from './_all';
import { BUNDLED_PLUGIN_TRANSLATIONS } from './bundledPluginTranslations.generated';

import { auditTranslations, findMissingKeys, flattenTranslationLeaves } from '../../tools/i18n/translationAudit';

const IGNORED_UNTRANSLATED_KEYS = new Set([
    'promptLibrary.supportingFilePathPlaceholder',
    'files.sourceControlOperations.update.remotes.namePlaceholder',
    'settingsSession.handoff.includeIgnoredMode.globsPlaceholder',
    'connectedServices.detail.prompts.accessTokenPlaceholder',
    'connectedServices.serviceNames.github',
    'connectedServices.serviceNames.bitbucket',
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
]);
// French is the only locale that needs per-(locale, key) exemptions: it shares a large amount of
// vocabulary with English, so a literal match is frequently the correct French rather than a gap.
// Three groups, no accidents:
//   product, provider and preset nouns (Happier, React Native, tmux, GitHub CLI, model ids),
//   the English technical vocabulary French developers actually speak and which the ratified
//   glossary pins (prompt, worktree, workspace, token, provider, pool, backend, daemon, relay),
//   and true cognates that are simply the same word in French (Actions, Options, Description,
//   Sources, Machines, Notifications, Diagnostics, Archive, Session, Installation).
// A key listed here is a decision, not a gap: translating it would make the French UI read worse.
// Consulted by the whole-app untranslated budget AND by the zero-tolerance namespace assertions
// below, so there is a single owner for "identical to English on purpose".
const IGNORED_UNTRANSLATED_KEYS_BY_LOCALE: Readonly<Record<string, ReadonlySet<string>>> = {
    fr: new Set([
        'agentInput.acp.modeSectionTitle',
        'agentInput.acp.optionsSectionTitle',
        'agentInput.mode.build',
        'agentInput.mode.plan',
        'agentInput.mode.sectionTitle',
        'agentInput.suggestionGroups.plugins',
        'agentInput.suggestionGroups.sessions',
        'agentInput.suggestionGroups.skills',
        'approvals.fieldAction',
        'automations.detail.actionsGroupTitle',
        'automations.detail.runDetail.conversation',
        'automations.detail.runDetail.payload',
        'automations.detail.runMeta.occurrenceTitle',
        'automations.detail.runMeta.cause.conversation',
        'automations.detail.status.active',
        'automations.form.schedule.cronTitle',
        'browserDiagnostics.host.families.console',
        'browserDiagnostics.host.families.other',
        'browserDiagnostics.host.families.performance',
        'browserDiagnostics.host.fields.arguments',
        'browserDiagnostics.host.fields.domContentLoaded',
        'browserDiagnostics.host.fields.message',
        'browserDiagnostics.host.fields.messages',
        'browserDiagnostics.host.fields.readyState',
        'browserDiagnostics.host.fields.rect',
        'browserDiagnostics.host.fields.serviceWorker',
        'browserDiagnostics.host.fields.socket',
        'browserDiagnostics.host.fields.type',
        'browserDiagnostics.host.fields.webgl',
        'browserDiagnostics.host.fields.webrtc',
        'browserDiagnostics.host.interaction.eval.title',
        'browserShell.devtools.section.console',
        'browserShell.devtools.section.info',
        'browserShell.devtools.section.performance',
        'browserShell.devtools.title',
        'browserShell.profile.mode.plugin',
        'browserShell.profile.mode.session',
        'browserShell.profile.modeLabel',
        'browserShell.profile.permissions.prompt',
        'browserShell.profile.permissionsLabel',
        'browserShell.profile.storage.plugin',
        'browserShell.profile.storage.session',
        'bugReports.composer.diagnostics.title',
        'bugReports.composer.environment.deploymentType.cloud',
        'commandPalette.pets.category',
        'common.actions',
        'common.inactive',
        'common.info',
        'common.logs',
        'common.machine',
        'common.message',
        'common.version',
        'connectedServices.account.poolsLabel',
        'connectedServices.authChip.label',
        'connectedServices.authChip.nativeLabel',
        'connectedServices.detail.actionsGroupTitle',
        'connectedServices.detail.groupDetail.optionsTitle',
        'connectedServices.detail.prompts.apiKeyPlaceholder',
        'connectedServices.detail.prompts.apiTokenPlaceholder',
        'connectedServices.detail.prompts.personalAccessTokenPlaceholder',
        'connectedServices.detail.prompts.setupTokenPlaceholder',
        'connectedServices.detail.prompts.setupTokenTitle',
        'connectedServices.detail.segments.pools',
        'connectedServices.pools.autoBadge',
        'connectedServices.pools.title',
        'connectedServices.profile.poolsGroupTitle',
        'connectedServices.profile.quotaTitle',
        'connectedServices.serviceNames.gemini',
        'connectedServices.serviceNames.openaiCodex',
        'connectionStatus.labels.socket',
        'deps.installable.gh.title',
        'devVoiceQa.actionsTitle',
        'devVoiceQa.configurationTitle',
        'diagnosis.sections.actions',
        'directSessions.browseAgents',
        'directSessions.browseMachines',
        'directSessions.browseSources',
        'executionRuns.newRun.intents.plan',
        'executionRuns.newRun.sections.backends',
        'executionRuns.newRun.sections.instructions',
        'executionRuns.newRun.sections.permissions',
        'externalSessions.browseAgents',
        'externalSessions.browseMachines',
        'externalSessions.browseSources',
        'externalSessions.settingsMachineTitle',
        'externalSessions.settingsNotificationsTitle',
        'files.branchMenu.category.actions',
        'files.branchMenu.category.branches',
        'files.branchMenu.category.local',
        'files.branchMenu.category.options',
        'files.branchMenu.category.remote',
        'files.branchMenu.category.worktrees',
        'files.commitDetails.commitLabel',
        'files.diff',
        'files.sourceControlOperations.actions.fetch',
        'files.sourceControlOperations.actions.pull',
        'files.sourceControlOperations.actions.push',
        'files.sourceControlOperations.update.branchIntegration.merge',
        'files.sourceControlOperations.update.branchIntegration.rebase',
        'files.sourceControlOperations.update.publish.visibility.public',
        'files.sourceControlOperations.update.publishRepository.public',
        'files.sourceControlOperations.update.publishRepository.repositoryNamePlaceholder',
        'files.sourceControlOperations.update.pullRequest.title',
        'files.sourceControlOperations.update.pullRequests.title',
        'files.sourceControlOperations.update.remotes.title',
        'inbox.permissions',
        'localServices.band.suggestions',
        'localServices.launcher.title',
        'localServices.session.workspaceTitle',
        'machine.architecture',
        'machine.daemon',
        'machine.installables.autoUpdateModes.auto',
        'machine.installables.screenTitle',
        'machine.machineGroup',
        'machine.runtimeInventoryInstallations',
        'machine.runtimeInventoryServices',
        'machine.tools.installablesTitle',
        'markdown.codeLabel',
        'markdown.diffLabel',
        'memorySearchSettings.backfill.title',
        'memorySearchSettings.embeddings.groupTitle',
        'memorySearchSettings.embeddings.openAi.dimensionsTitle',
        'memorySearchSettings.embeddings.provider.title',
        'memorySearchSettings.indexMode.triggerTitle',
        'memorySearchSettings.machine.title',
        'newSession.checkout.actionsSectionTitle',
        'newSession.ghCliBanner.title',
        'newSession.sessionType.simple',
        'newSession.sessionType.worktree',
        'newSession.worktree.nameStep.backLabel',
        'notifications.activity.defaultSessionTitle',
        'pluginPermissions.identifiers.installation',
        'pluginPermissions.identifiers.machine',
        'pluginPermissions.identifiers.session',
        'pluginPermissions.requester.plugin',
        'pluginPermissions.scope.workspace',
        'profiles.aiBackend.claudeSubtitle',
        'profiles.aiBackend.codexSubtitle',
        'profiles.aiBackend.opencodeSubtitle',
        'profiles.environmentVariables.previewModal.detail.machine',
        'profiles.requirements.secretRequired',
        'projects.detail.fields.machine',
        'promptLibrary.actions',
        'promptLibrary.externalAssetsMachine',
        'promptLibrary.prompts',
        'promptLibrary.registriesSources',
        'promptLibrary.sections',
        'promptLibrary.skills',
        'promptLibrary.tagsLabel',
        'promptLibrary.templates',
        'promptLibrary.templateTargetPromptLabel',
        'runs.delivery.promptLabel',
        'runs.machinesSubtitle',
        'secrets.badgeReady',
        'server.retention.sessions',
        'server.serverGroupServersLabel',
        'session.inactiveNotResumable',
        'session.planOutput.title',
        'session.sharing.session',
        'session.subagents.intent.plan',
        'session.subagents.intent.review',
        'session.subagents.kind.execution_run',
        'session.subagents.kind.subagent_sidechain',
        'session.subagents.panel.teamIdPlaceholder',
        'session.subagents.panel.title',
        'session.workState.goal.pause',
        'session.workState.workflow.bare',
        'sessionGettingStarted.steps.authLogin.copyLabel',
        'sessionInfo.checkoutLabel',
        'sessionInfo.happyHome',
        'sessionInfo.workspaceLabel',
        'sessionInfo.workspaceTitle',
        'settings.accessEndpoints.recommendedUse.diagnostic',
        'settings.acpCatalogFieldDescription',
        'settings.machines',
        'settings.mcpServersBindingMachine',
        'settings.mcpServersBindingTargetMachineTitle',
        'settings.mcpServersBindingTargetWorkspaceTitle',
        'settings.mcpServersBindingTitle',
        'settings.mcpServersDetectedDirectoryPlaceholder',
        'settings.mcpServersDetectedMachineTitle',
        'settings.mcpServersEditorBindings',
        'settings.mcpServersEditorRemote',
        'settings.mcpServersEditorStdio',
        'settings.mcpServersFieldArgs',
        'settings.mcpServersFieldTransport',
        'settings.mcpServersPreviewAgentTitle',
        'settings.mcpServersPreviewDirectoryPlaceholder',
        'settings.mcpServersPreviewMachineTitle',
        'settings.mcpServersScopeMachine',
        'settings.mcpServersScopeWorkspace',
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
        'settingsActions.families.plugins.title',
        'settingsActions.families.session.title',
        'settingsActions.spawnPolicy.permissionCeiling.options.plan.title',
        'settingsActions.spawnPolicy.permissionCeiling.options.safe-yolo.title',
        'settingsActions.spawnPolicy.permissionCeiling.options.yolo.title',
        'settingsAgents.channelPlugin',
        'settingsAgents.channelStable',
        'settingsAgents.configuration',
        'settingsAgents.dynamicModelProbeAuto',
        'settingsAgents.plugins.antigravity.fields.antigravityRuntimeMode.options.auto.title',
        'settingsAgents.plugins.antigravity.sections.runtime.title',
        'settingsAgents.plugins.claude.fields.claudeRemoteSettingSourcesV2.options.local.title',
        'settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.options.auto.title',
        'settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.options.tmux.title',
        'settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.options.zellij.title',
        'settingsAgents.plugins.codex.fields.codexBackendMode.options.appServer.title',
        'settingsAgents.runtimeSwitchAcpSetSessionMode',
        'settingsAgents.title',
        'settingsAppearance.agentInputActionBarLayoutOptions.auto',
        'settingsAppearance.agentInputChipDensityOptions.auto',
        'settingsAppearance.contentWidthOptions.compact',
        'settingsAppearance.itemDensityOptions.compact',
        'settingsAppearance.tabBarAppearance.sizeCompact',
        'settingsFeatures.expExecutionRuns',
        'settingsFeatures.historyScopeGlobalOption',
        'settingsFeatures.sessionListGrouping.dateTitle',
        'settingsNotifications.activitySurfaces.liveActivities.attentionTitle',
        'settingsNotifications.activitySurfaces.widgets.attentionTitle',
        'settingsNotifications.badges.title',
        'settingsNotifications.pushTroubleshooting.actions.title',
        'settingsNotifications.pushTroubleshooting.permission.title',
        'settingsNotifications.types.title',
        'settingsPets.title',
        'settingsPlugins.accountDataErase.promptPlaceholder',
        'settingsPlugins.developmentCreateSurfaceReactNative',
        'settingsPlugins.diagnosticsSnapshotTitle',
        'settingsPlugins.invocationLogs.level.diagnostic',
        'settingsPlugins.invocationLogs.level.info',
        'settingsPlugins.registriesScopesPlaceholder',
        'settingsPlugins.sourceKind.archive',
        'settingsPlugins.sourceKind.marketplace',
        'settingsPlugins.views.diagnostics',
        'settingsProviders.authoring.providerTitle',
        'settingsProviders.authoring.publicHeadersPlaceholder',
        'settingsProviders.compatibility.incompatible',
        'settingsProviders.detail.actionsTitle',
        'settingsProviders.detail.machinesTitle',
        'settingsProviders.migration.actionsTitle',
        'settingsProviders.title',
        'settingsSession.mobileWorkspaceExperience.options.cockpitTitle',
        'settingsSession.permissions.title',
        'settingsSession.providerUsageGauge.windowSessionTitle',
        'settingsSession.replayResume.summaryRunner.backendTitle',
        'settingsSession.sessionList.headerIdentityDisplayAvatarTitle',
        'settingsSession.toolDetailLevel.compactTitle',
        'settingsSession.toolRendering.cardDensity.compactTitle',
        'settingsSession.transcript.advanced.performanceTitle',
        'settingsSession.transcript.messageActions.template.placeholder',
        'settingsSession.transcript.motionPickerTitle',
        'settingsSession.transcript.title',
        'settingsSession.usageLimitRecovery.resumePromptStandardTitle',
        'settingsVoice.local.googleGeminiStt.provider.detail',
        'settingsVoice.local.googleGeminiStt.provider.title',
        'settingsVoice.local.localNeuralStt.provider.detail',
        'setupOnboarding.handoffPlatformLinuxLabel',
        'setupOnboarding.handoffPlatformMacosLabel',
        'setupOnboarding.handoffPlatformPosixLabel',
        'setupOnboarding.relayAccessCloudflareTitle',
        'simulatorPreview.sidebands.fields.message',
        'simulatorPreview.sidebands.fields.route',
        'simulatorPreview.sidebands.logs',
        'simulatorPreview.sidebands.route',
        'simulatorPreview.sidebands.title',
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
        'terminalEmbedded.settings.rendererXtermWebView',
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
        'tools.workflowView.description',
        'tools.workspaceIndexingPermission.optionFallback',
        'usage.auto',
        'usage.source',
        'usage.summary.export.session',
        'usage.tokens',
        'voiceActivity.format.action',
        'welcome.welcomeFooterDocsAction',
        'windowsRemoteSessionLaunchMode.console',
        'windowsRemoteSessionLaunchMode.shortConsole',
    ]),
    // German keeps these identical to English on purpose, in the same three groups French does:
    //   product, provider and preset nouns (Happier, Codex, tmux, model ids, theme names),
    //   the English technical vocabulary German developers actually speak and which the ratified
    //   glossary pins (Prompt, Worktree, Workspace, Token, Provider, Backend, Session, Commit),
    //   and true cognates that are simply the same word in German — Status, Details, Info,
    //   Version, Dialog, Name, Minute, Plan, Test, Transport, Literal, Schema, System, Format,
    //   Navigation, Delegation, Team, Phase, Option, Linear, Layout, Cockpit, Avatar, Global.
    // German has more of that third group than any other locale here, which is why this list is
    // long: nouns are capitalised in German, so an English loanword is already spelled the way a
    // German noun is spelled. A key here is a decision, not a gap — translating one would make
    // the UI read worse, not better.
    de: new Set([
        'agentInput.mode.build',
        'agentInput.mode.plan',
        'agentInput.suggestionGroups.plugins',
        'agentInput.suggestionGroups.sessions',
        'agentInput.suggestionGroups.skills',
        'approvals.details',
        'approvals.fieldStatus',
        'automations.detail.overview.nameTitle',
        'automations.detail.overview.statusTitle',
        'automations.detail.runDetail.filter',
        'automations.detail.runDetail.payload',
        'automations.form.groupAutomationTitle',
        'automations.form.schedule.cronTitle',
        'automations.form.trigger.eventFilterPlaceholder',
        'browserDiagnostics.host.families.performance',
        'browserDiagnostics.host.fields.domContentLoaded',
        'browserDiagnostics.host.fields.socket',
        'browserDiagnostics.host.fields.status',
        'browserDiagnostics.host.fields.webgl',
        'browserDiagnostics.host.fields.webrtc',
        'browserShell.devtools.section.info',
        'browserShell.devtools.section.performance',
        'browserShell.origin.simulator',
        'browserShell.profile.mode.plugin',
        'browserShell.profile.mode.session',
        'browserShell.profile.permissions.prompt',
        'browserShell.profile.storage.plugin',
        'browserShell.profile.storage.session',
        'browserSurface.title',
        'bugReports.composer.environment.deploymentType.cloud',
        'bugReports.composer.environment.deploymentType.enterprise',
        'bugReports.composer.frequencySeverity.severity.blocker',
        'commandPalette.commands.navigationCategory',
        'commandPalette.commands.runsCategory',
        'commandPalette.commands.sessionsCategory',
        'commandPalette.commands.systemCategory',
        'commandPalette.commands.voiceCategory',
        'commandPalette.commands.voiceSubtitle',
        'common.commit',
        'common.details',
        'common.dialog',
        'common.info',
        'common.logs',
        'common.name',
        'common.optional',
        'common.start',
        'common.tabs',
        'common.version',
        'connectedServices.account.poolsLabel',
        'connectedServices.account.resetsCaption',
        'connectedServices.authChip.label',
        'connectedServices.detail.groupActions.groupIdPlaceholder',
        'connectedServices.detail.prompts.accessTokenPlaceholder',
        'connectedServices.detail.prompts.apiKeyPlaceholder',
        'connectedServices.detail.prompts.apiTokenPlaceholder',
        'connectedServices.detail.prompts.personalAccessTokenPlaceholder',
        'connectedServices.detail.prompts.profileIdPlaceholder',
        'connectedServices.detail.prompts.setupTokenPlaceholder',
        'connectedServices.detail.segments.pools',
        'connectedServices.pools.autoBadge',
        'connectedServices.pools.title',
        'connectedServices.profile.poolsGroupTitle',
        'connectedServices.profile.status',
        'connectedServices.serviceNames.gemini',
        'connectedServices.serviceNames.openaiCodex',
        'connectionStatus.labels.server',
        'connectionStatus.labels.socket',
        'delegation.output.title',
        'devVoiceQa.promptLabel',
        'devVoiceQa.recordedAudio.statusLabel',
        'directSessions.browseAgents',
        'executionRuns.details.labels.status',
        'executionRuns.details.titles.executionRun',
        'executionRuns.newRun.actions.start',
        'executionRuns.newRun.intents.plan',
        'executionRuns.newRun.intents.review',
        'executionRuns.newRun.sections.backends',
        'externalSessions.browseAgents',
        'externalSessions.settingsMachineOffline',
        'externalSessions.settingsMachineOnline',
        'files.branchMenu.category.branches',
        'files.branchMenu.category.remote',
        'files.branchMenu.category.worktrees',
        'files.commitDetails.commitLabel',
        'files.commitMessageEditor.commit',
        'files.diff',
        'files.markdown',
        'files.reviewComments.durable.engine',
        'files.sourceControlOperations.actions.fetch',
        'files.sourceControlOperations.actions.pull',
        'files.sourceControlOperations.actions.push',
        'files.sourceControlOperations.blockedHints.lock',
        'files.sourceControlOperations.update.branchIntegration.merge',
        'files.sourceControlOperations.update.branchIntegration.rebase',
        'files.sourceControlOperations.update.publishRepository.repositoryNamePlaceholder',
        'files.sourceControlOperations.update.pullRequests.unavailable.detachedHeadTitle',
        'files.sourceControlOperations.update.remotes.namePlaceholder',
        'files.sourceControlOperations.update.remotes.title',
        'files.toolbar.details',
        'files.toolbar.review',
        'journey.beats.a10.eyebrow',
        'journey.beats.a12.eyebrow',
        'journey.beats.a3.eyebrow',
        'journey.beats.a4.eyebrow',
        'journey.beats.a5.eyebrow',
        'journey.beats.a8.eyebrow',
        'journey.reel.features.crossPlatform.title',
        'localServices.session.workspaceTitle',
        'machine.daemon',
        'machine.host',
        'machine.installables.autoUpdateModes.auto',
        'machine.status',
        'machine.tools.title',
        'markdown.codeLabel',
        'markdown.diffLabel',
        'memorySearchSettings.contentPolicy.reasoningTitle',
        'memorySearchSettings.embeddings.groupTitle',
        'memorySearchSettings.embeddings.provider.title',
        'navigation.automation',
        'newSession.sessionType.worktree',
        'newSession.worktree.backToRoot',
        'newSession.worktree.nameStep.backLabel',
        'notifications.activity.defaultSessionTitle',
        'pluginPermissions.identifiers.installation',
        'pluginPermissions.identifiers.session',
        'pluginPermissions.requester.host',
        'pluginPermissions.requester.plugin',
        'pluginPermissions.scope.workspace',
        'profile.details',
        'profile.status',
        'profiles.aiBackend.claudeSubtitle',
        'profiles.aiBackend.codexSubtitle',
        'profiles.aiBackend.opencodeSubtitle',
        'profiles.requirements.secretRequired',
        'projects.detail.fields.name',
        'promptLibrary.prompts',
        'promptLibrary.schema',
        'promptLibrary.skills',
        'promptLibrary.tagsLabel',
        'promptLibrary.templateTargetPromptLabel',
        'promptLibrary.templates',
        'runs.delivery.promptLabel',
        'runs.title',
        'secrets.badgeReady',
        'secrets.fields.name',
        'server.retention.sessions',
        'server.serverGroupServersLabel',
        'session.participants.lead',
        'session.planOutput.title',
        'session.sharing.session',
        'session.subagents.intent.plan',
        'session.subagents.intent.review',
        'session.subagents.kind.execution_run',
        'session.subagents.kind.subagent_sidechain',
        'session.subagents.panel.teamIdPlaceholder',
        'session.subagents.panel.title',
        'session.workState.workflow.bare',
        'sessionInfo.checkoutLabel',
        'sessionInfo.host',
        'sessionInfo.workspaceLabel',
        'sessionInfo.workspaceTitle',
        'sessionsList.sessionFallbackLabel',
        'sessionsList.storageFilterCategory',
        'settings.acpCatalogFieldName',
        'settings.acpCatalogLauncher',
        'settings.features',
        'settings.featuresTitle',
        'settings.localRelayRuntime.statusTitle',
        'settings.localTailscale.statusTitle',
        'settings.mcpServersBindingOverridesTitle',
        'settings.mcpServersBindingTargetWorkspaceTitle',
        'settings.mcpServersBindingTitle',
        'settings.mcpServersDetectedDirectoryPlaceholder',
        'settings.mcpServersEditorBindings',
        'settings.mcpServersEditorRemote',
        'settings.mcpServersEditorStdio',
        'settings.mcpServersFieldArgs',
        'settings.mcpServersFieldName',
        'settings.mcpServersFieldTransport',
        'settings.mcpServersPreviewAgentTitle',
        'settings.mcpServersPreviewDirectoryPlaceholder',
        'settings.mcpServersScopeWorkspace',
        'settings.mcpServersTestTitle',
        'settings.mcpServersValueSourceLiteral',
        'settings.prompts',
        'settings.relayAccess.fields.hostnameLabel',
        'settings.relayAccess.statusTitle',
        'settings.remoteHostsHostGroupTitle',
        'settings.secrets',
        'settings.servers',
        'settings.session',
        'settings.sessions',
        'settings.social',
        'settings.system',
        'settings.terminal',
        'settings.workspaces',
        'settingsAccount.analytics',
        'settingsAccount.backup',
        'settingsAccount.name',
        'settingsAccount.server',
        'settingsAccount.status',
        'settingsActions.families.browser.title',
        'settingsActions.families.plugins.title',
        'settingsActions.families.session.title',
        'settingsActions.families.simulator.title',
        'settingsActions.sections.voice',
        'settingsActions.spawnPolicy.permissionCeiling.options.plan.title',
        'settingsActions.spawnPolicy.permissionCeiling.options.yolo.title',
        'settingsActions.targets.voice.title',
        'settingsAgents.authentication.statusTitle',
        'settingsAgents.channelPlugin',
        'settingsAgents.dynamicModelProbeAuto',
        'settingsAgents.plugins.antigravity.fields.antigravityRuntimeMode.options.auto.title',
        'settingsAgents.plugins.antigravity.sections.runtime.title',
        'settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.options.auto.title',
        'settingsAgents.plugins.claude.fields.claudeUnifiedTerminalHost.options.zellij.title',
        'settingsAgents.plugins.codex.fields.codexBackendMode.options.appServer.title',
        'settingsAgents.runtimeSwitchAcpSetSessionMode',
        'settingsAgents.title',
        'settingsAppearance.agentInputActionBarLayoutOptions.auto',
        'settingsAppearance.agentInputChipDensityOptions.auto',
        'settingsAppearance.text',
        'settingsAppearance.theme',
        'settingsAppearance.themeProfiles.detailsGroup',
        'settingsAppearance.themeProfiles.groups.chrome',
        'settingsAppearance.themeProfiles.groups.composer',
        'settingsAppearance.themeProfiles.groups.diff',
        'settingsAppearance.themeProfiles.groups.overlay',
        'settingsAppearance.themeProfiles.groups.syntax',
        'settingsAppearance.themeProfiles.groups.text',
        'settingsAppearance.themeProfiles.presetGroup',
        'settingsAppearance.themeProfiles.presetSource',
        'settingsAppearance.themeProfiles.title',
        'settingsAppearance.visualEffects.contextGaugeOptions.text',
        'settingsAppearance.visualEffects.levelOptions.minimal',
        'settingsAttachments.limits.title',
        'settingsFeatures.expExecutionRuns',
        'settingsFeatures.historyScopeGlobalOption',
        'settingsFeatures.localTogglesTitle',
        'settingsFeatures.voice',
        'settingsNotifications.badges.title',
        'settingsNotifications.pushTroubleshooting.status.title',
        'settingsPets.overlayStatusReview',
        'settingsPets.previewTitle',
        'settingsPlugins.invocationLogs.level.debug',
        'settingsPlugins.invocationLogs.level.info',
        'settingsPlugins.registriesAvailability.offline',
        'settingsPlugins.registriesScopesPlaceholder',
        'settingsPlugins.webhookAdministration.configureCredential',
        'settingsPlugins.webhookAdministration.copyUrl',
        'settingsPlugins.webhookAdministration.credentialSecretTitle',
        'settingsPlugins.webhookAdministration.deliveryStatus',
        'settingsPlugins.webhookAdministration.discardBody',
        'settingsPlugins.webhookAdministration.discardTitle',
        'settingsPlugins.webhookAdministration.emptySubtitle',
        'settingsPlugins.webhookAdministration.emptyTitle',
        'settingsPlugins.webhookAdministration.endpointsTitle',
        'settingsPlugins.webhookAdministration.finishRotation',
        'settingsPlugins.webhookAdministration.finishRotationSubtitle',
        'settingsPlugins.webhookAdministration.footer',
        'settingsPlugins.webhookAdministration.loadError',
        'settingsPlugins.webhookAdministration.movePendingBody',
        'settingsPlugins.webhookAdministration.movePendingTitle',
        'settingsPlugins.webhookAdministration.operationFailed',
        'settingsPlugins.webhookAdministration.originSelected',
        'settingsPlugins.webhookAdministration.originUnavailable',
        'settingsPlugins.webhookAdministration.replay',
        'settingsPlugins.webhookAdministration.resumePendingMove',
        'settingsPlugins.webhookAdministration.retarget',
        'settingsPlugins.webhookAdministration.retargetUnavailable',
        'settingsPlugins.webhookAdministration.revoke',
        'settingsPlugins.webhookAdministration.revokeBody',
        'settingsPlugins.webhookAdministration.revokeTitle',
        'settingsPlugins.webhookAdministration.rotateCredential',
        'settingsPlugins.webhookAdministration.selectTarget',
        'settingsPlugins.webhookAdministration.title',
        'settingsProviders.authoring.name',
        'settingsProviders.authoring.providerTitle',
        'settingsProviders.detail.machineOffline',
        'settingsProviders.detail.machineOnline',
        'settingsProviders.migration.actionsTitle',
        'settingsSession.mobileWorkspaceExperience.options.cockpitTitle',
        'settingsSession.providerUsageGauge.windowSessionTitle',
        'settingsSession.replayResume.summaryRunner.backendTitle',
        'settingsSession.sessionCreation.presentationAutoTitle',
        'settingsSession.sessionCreation.wizardPresentationAutoTitle',
        'settingsSession.sessionCreation.wizardPresentationDropdownTitle',
        'settingsSession.sessionList.headerIdentityDisplayAvatarTitle',
        'settingsSession.sessionList.identityDisplayAvatarTitle',
        'settingsSession.sessionList.narrowWorkingIndicatorSpinnerTitle',
        'settingsSession.sessionList.workingIndicatorSpinnerTitle',
        'settingsSession.transcript.advanced.performanceTitle',
        'settingsSession.transcript.codeDiffs',
        'settingsSession.transcript.layout.linearTitle',
        'settingsSession.transcript.layoutTitle',
        'settingsSession.usageLimitRecovery.resumePromptStandardTitle',
        'settingsSourceControl.editor',
        'settingsSourceControl.markdownEditMode.options.rich.title',
        'settingsVoice.byo.realtime.modelPicker.detailAuto',
        'settingsVoice.byo.realtime.modelPicker.options.autoTitle',
        'settingsVoice.byo.realtime.voicePicker.title',
        'settingsVoice.byo.voiceGroupTitle',
        'settingsVoice.local.apiKeyPlaceholder',
        'settingsVoice.local.conversation.resumability.replayTitle',
        'settingsVoice.local.conversation.streaming.title',
        'settingsVoice.local.daemonInference.execution.options.auto',
        'settingsVoice.local.daemonInference.execution.options.daemon',
        'settingsVoice.local.executionMachine.offlineLabel',
        'settingsVoice.local.executionMachine.onlineLabel',
        'settingsVoice.local.googleCloudTts.format.title',
        'settingsVoice.local.googleCloudTts.provider.detail',
        'settingsVoice.local.googleCloudTts.provider.title',
        'settingsVoice.local.googleCloudTts.voice.title',
        'settingsVoice.local.googleGeminiStt.language.autoTitle',
        'settingsVoice.local.googleGeminiStt.provider.detail',
        'settingsVoice.local.kokoro.voice.title',
        'settingsVoice.local.localNeuralStt.provider.detail',
        'settingsVoice.local.mediatorBackendDaemon',
        'settingsVoice.modeTitle',
        'settingsVoice.realtimeProviders.fields.reasoning.title',
        'settingsVoice.realtimeProviders.fields.voice.title',
        'settingsVoice.ui.scopeSession',
        'settingsVoice.ui.surfaceLocation.autoTitle',
        'settingsVoice.ui.surfaceLocation.sessionTitle',
        'settingsVoice.ui.updates.otherSessionsSnippetsMode.autoTitle',
        'setupOnboarding.relayAccessCloudflareTitle',
        'simulatorPreview.sidebands.fields.route',
        'simulatorPreview.sidebands.fields.status',
        'simulatorPreview.sidebands.logs',
        'simulatorPreview.sidebands.route',
        'status.offline',
        'status.online',
        'streamPlayer.status.playing',
        'subAgentGuidance.ruleEditor.exampleToolCalls.placeholder',
        'subAgentGuidance.ruleEditor.intent.options.plan.title',
        'subAgentGuidance.ruleEditor.intent.options.review.title',
        'subAgentGuidance.settings.groupTitle',
        'subAgentGuidance.settings.overview.happierStatusTitle',
        'systemStatus.machine.offline',
        'systemStatus.machine.online',
        'systemStatus.sections.updates',
        'systemStatus.ui.socket',
        'tabs.sessions',
        'terminalEmbedded.quickKeys.enter',
        'terminalEmbedded.quickKeys.esc',
        'terminalEmbedded.quickKeys.tab',
        'toolView.expand',
        'tools.agentTeamView.status',
        'tools.agentTeamView.team',
        'tools.common.unknownToolTitle',
        'tools.fullView.debug',
        'tools.names.reasoning',
        'tools.names.subAgent',
        'tools.names.terminal',
        'tools.names.viewDiff',
        'tools.structuredResult.diff',
        'tools.structuredResult.stderr',
        'tools.structuredResult.stdout',
        'tools.subAgentRunView.planTitle',
        'tools.workflowActivityView.phaseUntitled',
        'tools.workflowActivityView.untitled',
        'tools.workflowView.status',
        'tools.workspaceIndexingPermission.optionFallback',
        'usage.auto',
        'usage.summary.engine',
        'usage.summary.export.session',
        'usage.tokenMix.reasoning',
        'usage.tokens',
        'voiceActivity.format.status',
        'voiceActivity.partial',
        'voiceSurface.orbLabel',
        'voiceSurface.start',
        'workspaceCockpit.tabs',
    ]),
};

// Every remaining English-equal value must be an explicit product name, technical token,
// placeholder, or locale-specific cognate in the canonical audit allowlists.
const MAX_UNTRANSLATED_STRINGS = 0;

const SAMPLED_FUNCTION_TRANSLATIONS: Readonly<Record<string, readonly unknown[]>> = {
    'connectedServices.detail.groups.memberQuotaExhaustedUntil': [{ time: '10:30' }],
    'connectedServices.detail.groups.memberRateLimitedUntil': [{ time: '10:30' }],
    'connectedServices.detail.groups.memberCapacityLimitedUntil': [{ time: '10:30' }],
    'connectedServices.detail.groups.memberAuthInvalidUntil': [{ time: '10:30' }],
    'connectedServices.detail.groups.memberPlanUnavailableUntil': [{ time: '10:30' }],
    'connectedServices.detail.groups.memberValidationBlockedUntil': [{ time: '10:30' }],
    'settingsProviders.detail.modelCount': [{ count: 2 }],
    'settingsProviders.models.experimentalConfirmBody': [{ provider: 'Example Provider', model: 'example-model' }],
    'settingsProviders.local.detectedAtPort': [{ port: '11434' }],
    'settingsProviders.local.possibleAtPort': [{ provider: 'Example Provider', port: '11434' }],
    'settingsProviders.local.defaultConnectionName': [{ provider: 'Example Provider' }],
    'settingsProviders.local.startManaged': [{ provider: 'Example Provider' }],
    'settingsProviders.detail.copyName': [{ name: 'Work' }],
    'settingsProviders.models.invalidModelIds': [{ ids: 'bad-id' }],
    'session.providerBinding.launchDefaultLabel': [{ provider: 'Example Provider' }],
    'session.providerBinding.launchNamedLabel': [{ provider: 'Example Provider', connection: 'Work' }],
    'session.providerBinding.changedBody': [{ provider: 'Example Provider', connection: 'Work' }],
    'session.providerBinding.unavailableBody': [{ provider: 'Example Provider', connection: 'Work' }],
    'session.providerBinding.disabledBody': [{ provider: 'Example Provider', connection: 'Work' }],
    'session.providerBinding.incompatibleBody': [{ provider: 'Example Provider', connection: 'Work' }],
};

const SAMPLED_FUNCTION_SAME_VALUE_BY_LOCALE: Readonly<Record<string, ReadonlySet<string>>> = {
    // Catalan uses the same plural noun spelling as English.
    'settingsProviders.detail.modelCount': new Set(['ca']),
    // Italian and German both use “provider” as the standard product term; the
    // ratified German glossary pins it, so „Provider: X“ is the German label.
    'session.providerBinding.launchDefaultLabel': new Set(['it', 'de']),
    'session.providerBinding.launchNamedLabel': new Set(['it', 'de']),
    // “Local” has the same spelling in these locales.
    'settingsProviders.local.defaultConnectionName': new Set(['es', 'pt', 'ca', 'fr']),
};

const EXTERNAL_SESSION_FUNCTION_TRANSLATIONS: Readonly<Record<string, readonly unknown[]>> = {
    'externalSessions.operationImportCountUnknown': [{ imported: 12 }],
    'externalSessions.operationImportCountEstimated': [{ imported: 12, total: 20 }],
    'externalSessions.operationPublishedThrough': [{ sequence: 12 }],
    'externalSessions.externalAgentStatusOnMachine': [{
        agent: 'AGENT_MARKER',
        machine: 'MACHINE_MARKER',
        status: 'STATUS_MARKER',
    }],
    'externalSessions.sharingTranscriptOnMachine': [{ machine: 'MACHINE_MARKER' }],
    'externalSessions.sharingSharedUpTo': [{ time: 'TIME_MARKER' }],
    'externalSessions.sharingSnapshotFrom': [{ time: 'TIME_MARKER' }],
    'externalSessions.settingsIntegrationRemediationOpenSettings': [{ path: 'PATH_MARKER' }],
    'externalSessions.settingsIntegrationRemediationSelectAccount': [{ service: 'SERVICE_MARKER' }],
    'externalSessions.settingsIntegrationRemediationInstallDependency': [{ dependency: 'DEPENDENCY_MARKER' }],
    'externalSessions.settingsIntegrationRemediationOpenUrl': [{ url: 'URL_MARKER' }],
    'externalSessions.settingsIntegrationReviewTitle': [{ agent: 'AGENT_MARKER' }],
    'externalSessions.settingsIntegrationReviewBody': [{ entries: 'ENTRIES_MARKER' }],
    'externalSessions.settingsIntegrationUninstallTitle': [{ agent: 'AGENT_MARKER' }],
    'externalSessions.settingsAgentAutoLinkTitle': [{ agent: 'AGENT_MARKER' }],
    'externalSessions.settingsAgentBrowseTitle': [{ agent: 'AGENT_MARKER' }],
    'externalSessions.browseSearchIncomplete': [{ count: 12 }],
    'externalSessions.browseSourceCodexConnectedServices': [{ service: 'SERVICE_MARKER' }],
    'externalSessions.browseIndexingProgress': [{ scanned: 12, total: 20 }],
};

const EXTERNAL_SESSION_NEIGHBORING_STRING_KEYS = [
    'chatFooter.checkingExternalSessionTakeover',
    'chatFooter.externalSessionTakeoverAvailable',
    'chatFooter.externalSessionMachineOffline',
    'chatFooter.externalSessionStatusUnavailable',
    'chatFooter.externalSessionProcessRunning',
    'chatFooter.externalSessionRecheck',
    'chatFooter.externalSessionTakeoverBlocked',
    'chatFooter.switchingToPersistedTakeover',
    'chatFooter.switchingToDirectTakeover',
    'chatFooter.takeOverDirect',
    'chatFooter.directTakeoverDialogTitle',
    'chatFooter.directTakeoverDialogBody',
    'chatFooter.directTakeoverDialogDirectTitle',
    'chatFooter.directTakeoverDialogDirectBody',
    'chatFooter.directTakeoverDialogPersistTitle',
    'chatFooter.directTakeoverDialogPersistBody',
    'status.workingExternally',
    'status.needsInputExternally',
    'status.retryingExternally',
    'status.ready',
    'status.recentlyActive',
    'status.externalStatusUnknown',
    'sessionsList.storageExternalFilter',
] as const;

const EXTERNAL_SESSION_SAME_VALUE_BY_LOCALE: Readonly<Record<string, ReadonlySet<string>>> = {
    // These standard UI terms have the same spelling in the listed locales.
    'externalSessions.browseAgents': new Set(['ca']),
    'externalSessions.settingsPrivacyGroupTitle': new Set(['it']),
    'externalSessions.settingsMachineOnline': new Set(['it', 'pt']),
    'externalSessions.settingsMachineOffline': new Set(['it', 'pt', 'pl']),
};

function readTranslationLeaf(root: unknown, key: string): unknown {
    return key.split('.').reduce<unknown>((node, part) => {
        return node && typeof node === 'object'
            ? (node as Record<string, unknown>)[part]
            : undefined;
    }, root);
}

function callSampledTranslation(value: unknown, args: readonly unknown[]): string | null {
    if (typeof value !== 'function') return null;
    const result = value(...args);
    return typeof result === 'string' ? result : null;
}

describe('i18n integrity', () => {
    // The browser and local-services corridors (RU2 surfaces finalization, R-9). U-8 shipped the
    // whole `browserContext.editor` sub-block in English only: it existed in `en` and in `de`, and
    // in none of the other ten locales, so the annotation editor rendered untranslated for most of
    // the world. No namespace assertion covered these surfaces, which is why nothing caught it.
    // Shape parity is asserted rather than key presence alone so that a leaf which changes from a
    // string to a formatter in `en` — a real source of runtime `t(...)` breakage — also fails here.
    it('keeps the browser and local-services namespaces complete in every supported locale', () => {
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'fr', root: fr },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'de', root: de },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];
        // Every top-level namespace reached by `t(...)` from `components/browser/**` and
        // `components/sessions/localServices/**`.
        const corridorNamespaces = [
            'browserAutomation',
            'browserContext',
            'browserDiagnostics',
            'browserLaunchpad',
            'browserRecording',
            'browserShell',
            'browserSurface',
            'localServices',
        ] as const;

        const shapeMismatches = corridorNamespaces.flatMap((namespace) => {
            const expected = flattenTranslationLeaves(en[namespace])
                .map((leaf) => `${leaf.key}:${leaf.kind}`)
                .sort();
            return locales.flatMap(({ code, root }) => {
                const actual = flattenTranslationLeaves(root[namespace])
                    .map((leaf) => `${leaf.key}:${leaf.kind}`)
                    .sort();
                const missing = expected.filter((leaf) => !actual.includes(leaf));
                return missing.length === 0
                    ? []
                    : [`${code}: ${namespace} missing ${missing.join(', ')}`];
            });
        });

        expect(shapeMismatches).toEqual([]);
    });

    it('keeps the Voice namespace complete in every supported locale', () => {
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'fr', root: fr },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'de', root: de },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];
        // The whole Voice namespace, not just its settings screen. This assertion used to
        // read only `settingsVoice.*` while claiming Voice was complete, so 216 absent
        // leaves on the LIVE surface — `voiceAssistant` status and every Dictation error,
        // `voiceSurface.reconnect`, `voiceActivity` badges — stayed invisible to it and
        // rendered in English during a spoken conversation in ten of eleven locales.
        const voiceNamespaces = ['settingsVoice', 'voiceAssistant', 'voiceSurface', 'voiceActivity', 'devVoiceQa'];
        const missing = locales.flatMap((locale) => findMissingKeys(en, locale))
            .filter(({ key }) => voiceNamespaces.some((ns) => key === ns || key.startsWith(`${ns}.`)));

        // Voice used to carry a separately tracked backlog of 2,060 English-only leaves.
        // It is closed: every Voice leaf now exists in all eleven locales, and a missing
        // key here would silently render that Voice surface in English again.
        expect(missing).toEqual([]);
    });

    it('keeps plural Automation trigger and exact-turn copy localized with stable identities', () => {
        const locales = [
            { code: 'ru', root: ru }, { code: 'pl', root: pl }, { code: 'es', root: es },
            { code: 'fr', root: fr }, { code: 'it', root: itLocale }, { code: 'pt', root: pt },
            { code: 'ca', root: ca }, { code: 'de', root: de }, { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant }, { code: 'ja', root: ja },
        ];
        const requiredPrefixes = [
            'automations.pluralEditor.',
            'automations.exactTurn.',
        ];
        const missing = locales.flatMap((locale) => findMissingKeys(en, locale))
            .filter(({ key }) => requiredPrefixes.some((prefix) => key.startsWith(prefix)));
        expect(missing).toEqual([]);

        const interpolationCases = [
            { key: 'automations.pluralEditor.turnCompletedSource', args: [{ session: 'SESSION_MARKER', ordinal: 17 }], markers: ['SESSION_MARKER', '17'] },
            { key: 'automations.list.sessionLifecycleParentTurn', args: [{ sessionId: 'SESSION_ID_MARKER' }], markers: ['SESSION_ID_MARKER'] },
            { key: 'automations.detail.trigger.identity', args: [{ id: 'TRIGGER_ID_MARKER', revision: 23 }], markers: ['TRIGGER_ID_MARKER', '23'] },
            { key: 'automations.detail.runMeta.triggerIdentity', args: [{ id: 'TRIGGER_ID_MARKER', revision: 29 }], markers: ['TRIGGER_ID_MARKER', '29'] },
        ] as const;
        const droppedMarkers = locales.flatMap(({ code, root }) => interpolationCases.flatMap(({ key, args, markers }) => {
            const rendered = callSampledTranslation(readTranslationLeaf(root, key), args);
            return rendered && markers.every((marker) => rendered.includes(marker))
                ? []
                : [`${code}: ${key} dropped ${markers.join(', ')}`];
        }));
        expect(droppedMarkers).toEqual([]);
    });

    it('keeps the Voice diagnostic-recording consent complete in every supported locale', () => {
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'fr', root: fr },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'de', root: de },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];
        const requiredKeys = new Set([
            'settingsVoice.diagnostics.consentTitle',
            'settingsVoice.diagnostics.consentBody',
            'settingsVoice.diagnostics.consentAction',
        ]);
        const missing = locales.flatMap((locale) => findMissingKeys(en, locale))
            .filter(({ key }) => requiredKeys.has(key));

        expect(missing).toEqual([]);
    });

    // A settings-action alert is composed from a headline plus optional fact
    // lines, so a single missing leaf renders one alert in two languages.
    it('keeps voice provider settings-action failure copy complete in every supported locale', () => {
        const keys = [
            'operationFailed',
            'operationFailedUnsaved',
            'operationFailedVoiceNotFound',
            'operationFailedStage',
            'operationFailedStatus',
        ] as const;
        const sampleArgs = [{ stage: 'validate_voice', status: 500 }];
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'fr', root: fr },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'de', root: de },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];

        const failures = locales.flatMap(({ code, root }) => keys.flatMap((key) => {
            const englishValue = readTranslationLeaf(en, `settingsVoice.realtimeProviders.${key}`);
            const value = readTranslationLeaf(root, `settingsVoice.realtimeProviders.${key}`);
            const english = typeof englishValue === 'function'
                ? callSampledTranslation(englishValue, sampleArgs)
                : englishValue;
            const localized = typeof englishValue === 'function'
                ? callSampledTranslation(value, sampleArgs)
                : value;
            if (typeof localized !== 'string' || localized.trim().length === 0) {
                return [`${code}: ${key} is missing`];
            }
            return localized === english ? [`${code}: ${key} falls back to English`] : [];
        }));

        expect(failures).toEqual([]);
    });

    it('keeps the Codex Live account and privacy namespace complete in every supported locale', () => {
        const expected = flattenTranslationLeaves(en.settingsVoice.realtimeProviders.codex)
            .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
            .sort((left, right) => left.key.localeCompare(right.key));
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'fr', root: fr },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'de', root: de },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];

        const mismatches = locales.flatMap(({ code, root }) => {
            const actual = flattenTranslationLeaves(root.settingsVoice?.realtimeProviders?.codex)
                .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
                .sort((left, right) => left.key.localeCompare(right.key));
            return JSON.stringify(actual) === JSON.stringify(expected)
                ? []
                : [`${code}: ${actual.length}/${expected.length} Codex Live translation leaves`];
        });
        const untranslated = Object.values(auditTranslations({ en, locales }))
            .flatMap((report) => report.untranslatedStrings)
            .filter((entry) => entry.key.startsWith('settingsVoice.realtimeProviders.codex.'));

        expect(mismatches).toEqual([]);
        expect(untranslated).toEqual([]);
    });

    it('keeps selectable provider privacy and local-resumption semantics localized', () => {
        const locales = [
            { code: 'en', root: en, idToken: 'ID', negativeToken: 'does not' },
            { code: 'ru', root: ru, idToken: 'идентификатор', negativeToken: 'не' },
            { code: 'pl', root: pl, idToken: 'identyfikator', negativeToken: 'nie' },
            { code: 'es', root: es, idToken: 'identificador', negativeToken: 'no' },
            { code: 'fr', root: fr, idToken: 'identifiant', negativeToken: 'non' },
            { code: 'it', root: itLocale, idToken: 'identificatore', negativeToken: 'non' },
            { code: 'pt', root: pt, idToken: 'identificador', negativeToken: 'não' },
            { code: 'ca', root: ca, idToken: 'identificador', negativeToken: 'no' },
            { code: 'de', root: de, idToken: 'ID', negativeToken: 'nicht' },
            { code: 'zh-Hans', root: zhHans, idToken: '标识符', negativeToken: '不会' },
            { code: 'zh-Hant', root: zhHant, idToken: '識別碼', negativeToken: '不會' },
            { code: 'ja', root: ja, idToken: 'ID', negativeToken: '削除しません' },
        ];
        const englishResumption = en.settingsVoice?.realtimeProviders?.resumption;
        const englishResumptionField = en.settingsVoice?.realtimeProviders?.fields?.resumption;
        const englishOptInCopy = [
            englishResumptionField?.title,
            englishResumptionField?.subtitle,
            englishResumption?.confirmTitle,
            englishResumption?.confirmBody,
            englishResumption?.confirmAction,
        ];

        const failures = locales.flatMap(({ code, root, idToken, negativeToken }) => {
            const realtimeProviders = root.settingsVoice?.realtimeProviders;
            // Only host-owned conversation providers belong here. Google's speech
            // disclosures moved to the Google plugin contribution when they were split
            // into role-specific STT and TTS copy, and the plugin bundle — not the host
            // tree — is their single owner. They are asserted in the plugin-owned test
            // below; naming them here would demand a second host copy of the same fact.
            const disclosures = [
                realtimeProviders?.openai?.privacyDisclosure,
                realtimeProviders?.xai?.privacyDisclosure,
                realtimeProviders?.codex?.privacyDisclosure,
            ];
            const resumption = realtimeProviders?.resumption;
            const resumptionField = realtimeProviders?.fields?.resumption;
            const forgetCopy = [
                resumption?.forgetTitle,
                resumption?.forgetSubtitle,
                resumption?.forgotten,
                resumption?.unsupported,
                resumption?.failed,
            ];
            const optInCopy = [
                resumptionField?.title,
                resumptionField?.subtitle,
                resumption?.confirmTitle,
                resumption?.confirmBody,
                resumption?.confirmAction,
            ];
            const combinedForgetCopy = forgetCopy.filter((value) => typeof value === 'string').join(' ');
            const combinedOptInCopy = optInCopy.filter((value) => typeof value === 'string').join(' ');
            const subtitle = typeof resumption?.forgetSubtitle === 'string' ? resumption.forgetSubtitle : '';
            const confirmBody = typeof resumption?.confirmBody === 'string' ? resumption.confirmBody : '';
            return [
                ...(disclosures.every((value) => typeof value === 'string' && value.trim().length > 0)
                    ? [] : [`${code}: missing provider disclosure`]),
                ...(forgetCopy.every((value) => typeof value === 'string' && value.trim().length > 0)
                    ? [] : [`${code}: incomplete forget copy`]),
                ...(optInCopy.every((value) => typeof value === 'string' && value.trim().length > 0)
                    ? [] : [`${code}: incomplete resumption opt-in copy`]),
                ...(code === 'en' || optInCopy.every((value, index) => value !== englishOptInCopy[index])
                    ? [] : [`${code}: resumption opt-in copy falls back to English`]),
                ...(combinedForgetCopy.includes('Happier') && combinedForgetCopy.includes(idToken)
                    ? [] : [`${code}: forget copy does not identify Happier's saved id`]),
                ...(combinedOptInCopy.includes('Happier') && combinedOptInCopy.includes('xAI') && combinedOptInCopy.includes(idToken)
                    ? [] : [`${code}: resumption opt-in copy does not identify Happier's saved xAI id`]),
                ...(confirmBody.includes('{minutes}')
                    ? [] : [`${code}: resumption confirmation lost its retention placeholder`]),
                ...(subtitle.includes('xAI') && subtitle.toLocaleLowerCase().includes(negativeToken.toLocaleLowerCase())
                    ? [] : [`${code}: forget subtitle does not disclaim xAI deletion`]),
            ];
        });

        expect(failures).toEqual([]);
    });

    /**
     * Provider processing disclosures for plugin-contributed Voice providers are owned by the
     * plugin contribution, not by a host locale file. `resolveRawTranslationValue` consults the
     * host tree (active locale, then English) before the plugin bundle, so a host copy of one of
     * these keys would shadow every plugin translation and pin the disclosure to English. The
     * assertions below therefore read the shipped bundle a user actually resolves and also refuse
     * a competing host copy.
     *
     * Role accuracy is the point of the split: an STT-only selection sends microphone audio and
     * no reply text, a TTS-only selection sends reply text and no microphone audio. One combined
     * "audio and text" string told the user the wrong thing in both directions, and the shape that
     * made it possible was a single provider-level key shared by both roles. Requiring the two
     * values to differ in every locale is what a re-merged disclosure cannot satisfy.
     */
    it('keeps plugin-owned voice processing disclosures complete and role-distinct in every locale', () => {
        const rolePairs = [
            {
                stt: 'settingsVoice.realtimeProviders.google.sttPrivacyDisclosure',
                tts: 'settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure',
            },
            {
                stt: 'settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt',
                tts: 'settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts',
            },
        ];

        const failures = rolePairs.flatMap(({ stt, tts }) => [
            ...([stt, tts].flatMap((key) => (
                readTranslationLeaf(en, key) === undefined
                    ? []
                    : [`host tree keeps a competing copy of ${key}`]
            ))),
            ...SUPPORTED_LANGUAGE_CODES.flatMap((code) => {
                const bundle = BUNDLED_PLUGIN_TRANSLATIONS[code] as Readonly<Record<string, string>> | undefined;
                const sttValue = bundle?.[stt];
                const ttsValue = bundle?.[tts];
                if (typeof sttValue !== 'string' || sttValue.trim().length === 0) {
                    return [`${code}: ${stt} is missing from the shipped plugin bundle`];
                }
                if (typeof ttsValue !== 'string' || ttsValue.trim().length === 0) {
                    return [`${code}: ${tts} is missing from the shipped plugin bundle`];
                }
                return sttValue === ttsValue
                    ? [`${code}: ${stt} and ${tts} share one combined disclosure`]
                    : [];
            }),
        ]);

        expect(failures).toEqual([]);

        // English is the one locale whose wording can be asserted directly, and it is where a
        // re-merge would show first: transcription copy must not promise speech synthesis, and
        // speech copy must not promise that microphone audio is transmitted.
        const englishBundle = BUNDLED_PLUGIN_TRANSLATIONS.en as Readonly<Record<string, string>>;
        const googleStt = englishBundle['settingsVoice.realtimeProviders.google.sttPrivacyDisclosure'] ?? '';
        const googleTts = englishBundle['settingsVoice.realtimeProviders.google.ttsPrivacyDisclosure'] ?? '';
        expect(googleStt).toMatch(/transcription/iu);
        expect(googleStt).not.toMatch(/text-to-speech/iu);
        expect(googleTts).toMatch(/text-to-speech/iu);
        expect(googleTts).not.toMatch(/audio/iu);

        const compatStt = englishBundle['settingsVoice.realtimeProviders.speechProcessing.openAiCompatStt'] ?? '';
        const compatTts = englishBundle['settingsVoice.realtimeProviders.speechProcessing.openAiCompatTts'] ?? '';
        expect(compatStt).toMatch(/audio for transcription/iu);
        expect(compatStt).not.toMatch(/speech synthesis/iu);
        expect(compatTts).toMatch(/speech synthesis/iu);
        expect(compatTts).not.toMatch(/audio for transcription/iu);
    });

    it('keeps the provider settings namespace complete in every supported locale', () => {
        const expected = flattenTranslationLeaves(en.settingsProviders)
            .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
            .sort((left, right) => left.key.localeCompare(right.key));
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'fr', root: fr },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'de', root: de },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];

        const mismatches = locales.flatMap(({ code, root }) => {
            const actual = flattenTranslationLeaves(root.settingsProviders)
                .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
                .sort((left, right) => left.key.localeCompare(right.key));
            return JSON.stringify(actual) === JSON.stringify(expected)
                ? []
                : [`${code}: ${actual.length}/${expected.length} provider translation leaves`];
        });

        expect(mismatches).toEqual([]);
    });

    it('keeps the provider session namespace complete in every supported locale', () => {
        const expected = flattenTranslationLeaves(en.session.providerBinding)
            .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
            .sort((left, right) => left.key.localeCompare(right.key));
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'fr', root: fr },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'de', root: de },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];

        const mismatches = locales.flatMap(({ code, root }) => {
            const actual = flattenTranslationLeaves(root.session.providerBinding)
                .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
                .sort((left, right) => left.key.localeCompare(right.key));
            return JSON.stringify(actual) === JSON.stringify(expected)
                ? []
                : [`${code}: ${actual.length}/${expected.length} provider session translation leaves`];
        });

        expect(mismatches).toEqual([]);
    });

    it('keeps plugin-management translations complete without English fallback copy', () => {
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'fr', root: fr },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'de', root: de },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];
        const expected = flattenTranslationLeaves(en.settingsPlugins)
            .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
            .sort((left, right) => left.key.localeCompare(right.key));
        const mismatches = locales.flatMap(({ code, root }) => {
            const actual = flattenTranslationLeaves(root.settingsPlugins)
                .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
                .sort((left, right) => left.key.localeCompare(right.key));
            return JSON.stringify(actual) === JSON.stringify(expected)
                ? []
                : [`${code}: ${actual.length}/${expected.length} plugin-management translation leaves`];
        });
        const untranslated = Object.values(auditTranslations({ en, locales }))
            .flatMap((report) => report.untranslatedStrings)
            .filter((entry) => entry.key.startsWith('settingsPlugins.'))
            .filter((entry) => !IGNORED_UNTRANSLATED_KEYS_BY_LOCALE[entry.locale]?.has(entry.key));

        expect(mismatches).toEqual([]);
        expect(untranslated).toEqual([]);
    });

    it('keeps host-rendered plugin-surface translations complete without English fallback copy', () => {
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'fr', root: fr },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'de', root: de },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];
        const expected = flattenTranslationLeaves(en.pluginSurfaces)
            .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
            .sort((left, right) => left.key.localeCompare(right.key));
        const mismatches = locales.flatMap(({ code, root }) => {
            const actual = flattenTranslationLeaves(root.pluginSurfaces)
                .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
                .sort((left, right) => left.key.localeCompare(right.key));
            return JSON.stringify(actual) === JSON.stringify(expected)
                ? []
                : [`${code}: ${actual.length}/${expected.length} plugin-surface translation leaves`];
        });
        const untranslated = Object.values(auditTranslations({ en, locales }))
            .flatMap((report) => report.untranslatedStrings)
            .filter((entry) => entry.key.startsWith('pluginSurfaces.'));

        expect(mismatches).toEqual([]);
        expect(untranslated).toEqual([]);
    });

    it('keeps permission-review semantics localized in every supported locale', () => {
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'fr', root: fr },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'de', root: de },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];
        const expected = flattenTranslationLeaves(en.pluginPermissions)
            .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
            .sort((left, right) => left.key.localeCompare(right.key));
        const shapeMismatches = locales.flatMap(({ code, root }) => {
            const actual = flattenTranslationLeaves(root.pluginPermissions)
                .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
                .sort((left, right) => left.key.localeCompare(right.key));
            return JSON.stringify(actual) === JSON.stringify(expected)
                ? []
                : [`${code}: ${actual.length}/${expected.length} permission-review translation leaves`];
        });
        const untranslatedStrings = Object.values(auditTranslations({ en, locales }))
            .flatMap((report) => report.untranslatedStrings)
            .filter((entry) => entry.key.startsWith('pluginPermissions.'))
            .filter((entry) => !IGNORED_UNTRANSLATED_KEYS_BY_LOCALE[entry.locale]?.has(entry.key))
            .map((entry) => `${entry.locale}: ${entry.key} = ${JSON.stringify(entry.value)}`);
        const englishSummary = en.pluginPermissions.accessibilitySummary({ details: 'DETAILS_MARKER' });
        const untranslatedSummaries = locales.flatMap(({ code, root }) => {
            const localized = root.pluginPermissions.accessibilitySummary({ details: 'DETAILS_MARKER' });
            return localized === englishSummary
                ? [`${code}: pluginPermissions.accessibilitySummary = ${JSON.stringify(localized)}`]
                : [];
        });

        expect(shapeMismatches).toEqual([]);
        expect(untranslatedStrings).toEqual([]);
        expect(untranslatedSummaries).toEqual([]);
    });

    it('keeps External Sessions copy complete without English fallback values', () => {
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'fr', root: fr },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'de', root: de },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];
        const expected = flattenTranslationLeaves(en.externalSessions)
            .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
            .sort((left, right) => left.key.localeCompare(right.key));
        const shapeMismatches = locales.flatMap(({ code, root }) => {
            const actual = flattenTranslationLeaves(root.externalSessions)
                .map((leaf) => ({ key: leaf.key, kind: leaf.kind }))
                .sort((left, right) => left.key.localeCompare(right.key));
            return JSON.stringify(actual) === JSON.stringify(expected)
                ? []
                : [`${code}: ${actual.length}/${expected.length} External Sessions translation leaves`];
        });
        const inheritedFunctionKeys = flattenTranslationLeaves(en.externalSessions)
            .filter((leaf) => leaf.kind === 'function')
            .flatMap((leaf) => locales.flatMap(({ code, root }) => (
                readTranslationLeaf(root, `externalSessions.${leaf.key}`) === leaf.value
                    ? [`${code}: externalSessions.${leaf.key}`]
                    : []
            )));
        const untranslatedStrings = Object.values(auditTranslations({ en, locales }))
            .flatMap((report) => report.untranslatedStrings)
            .filter((entry) => (
                entry.key.startsWith('externalSessions.')
                || EXTERNAL_SESSION_NEIGHBORING_STRING_KEYS.includes(
                    entry.key as typeof EXTERNAL_SESSION_NEIGHBORING_STRING_KEYS[number]
                )
            ))
            .filter((entry) => !EXTERNAL_SESSION_SAME_VALUE_BY_LOCALE[entry.key]?.has(entry.locale))
            .filter((entry) => !IGNORED_UNTRANSLATED_KEYS_BY_LOCALE[entry.locale]?.has(entry.key))
            .map((entry) => `${entry.locale}: ${entry.key} = ${JSON.stringify(entry.value)}`);
        const untranslatedFunctions = Object.entries(EXTERNAL_SESSION_FUNCTION_TRANSLATIONS)
            .flatMap(([key, args]) => {
                const englishSample = callSampledTranslation(readTranslationLeaf(en, key), args);
                return locales.flatMap(({ code, root }) => {
                    const localeSample = callSampledTranslation(readTranslationLeaf(root, key), args);
                    return englishSample && localeSample === englishSample
                        ? [`${code}: ${key} = ${JSON.stringify(localeSample)}`]
                        : [];
                });
            });
        const placeholderMismatches = Object.entries(EXTERNAL_SESSION_FUNCTION_TRANSLATIONS)
            .flatMap(([key, args]) => {
                const markers = args.flatMap((arg) => (
                    arg && typeof arg === 'object'
                        ? Object.values(arg).map(String)
                        : [String(arg)]
                ));
                return locales.flatMap(({ code, root }) => {
                    const localeSample = callSampledTranslation(readTranslationLeaf(root, key), args);
                    const missing = markers.filter((marker) => !localeSample?.includes(marker));
                    return missing.length > 0
                        ? [`${code}: ${key} missing ${missing.join(', ')}`]
                        : [];
                });
            });

        expect(shapeMismatches).toEqual([]);
        expect(inheritedFunctionKeys).toEqual([]);
        expect(untranslatedStrings).toEqual([]);
        expect(untranslatedFunctions).toEqual([]);
        expect(placeholderMismatches).toEqual([]);
    });

    it('does not increase the number of untranslated English strings', () => {
        const report = auditTranslations({
            en,
            locales: [
                { code: 'ru', root: ru },
                { code: 'pl', root: pl },
                { code: 'es', root: es },
                { code: 'fr', root: fr },
                { code: 'it', root: itLocale },
                { code: 'pt', root: pt },
                { code: 'ca', root: ca },
            { code: 'de', root: de },
                { code: 'zh-Hans', root: zhHans },
                { code: 'zh-Hant', root: zhHant },
                { code: 'ja', root: ja },
            ],
        });

        const allUntranslated = Object.entries(report)
            .flatMap(([locale, r]) => r.untranslatedStrings.map((u) => ({ ...u, locale })));
        const untranslated = allUntranslated
            .filter((entry) => {
                if (IGNORED_UNTRANSLATED_KEYS.has(entry.key)) return false;
                if (IGNORED_UNTRANSLATED_KEYS_BY_LOCALE[entry.locale]?.has(entry.key)) return false;
                return true;
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
    });

    it('does not leave sampled function-valued translations as English fallbacks', () => {
        const locales = [
            { code: 'ru', root: ru },
            { code: 'pl', root: pl },
            { code: 'es', root: es },
            { code: 'fr', root: fr },
            { code: 'it', root: itLocale },
            { code: 'pt', root: pt },
            { code: 'ca', root: ca },
            { code: 'de', root: de },
            { code: 'zh-Hans', root: zhHans },
            { code: 'zh-Hant', root: zhHant },
            { code: 'ja', root: ja },
        ];
        const untranslated = Object.entries(SAMPLED_FUNCTION_TRANSLATIONS).flatMap(([key, args]) => {
            const englishSample = callSampledTranslation(readTranslationLeaf(en, key), args);
            return locales.flatMap(({ code, root }) => {
                const localeSample = callSampledTranslation(readTranslationLeaf(root, key), args);
                return englishSample
                    && localeSample === englishSample
                    && !SAMPLED_FUNCTION_SAME_VALUE_BY_LOCALE[key]?.has(code)
                    ? [`${code}: ${key} = ${JSON.stringify(localeSample)}`]
                    : [];
            });
        });

        expect(untranslated).toEqual([]);
    });

    it('preserves provider and connection placeholders in every locale', () => {
        const locales = [en, ru, pl, es, itLocale, pt, ca, zhHans, zhHant, ja];
        const samples = [
            { key: 'settingsProviders.models.experimentalConfirmBody', args: { provider: 'PROVIDER_MARKER', model: 'MODEL_MARKER' }, markers: ['PROVIDER_MARKER', 'MODEL_MARKER'] },
            { key: 'settingsProviders.local.startManaged', args: { provider: 'PROVIDER_MARKER' }, markers: ['PROVIDER_MARKER'] },
            { key: 'settingsProviders.models.invalidModelIds', args: { ids: 'MODEL_IDS_MARKER' }, markers: ['MODEL_IDS_MARKER'] },
            { key: 'session.providerBinding.launchDefaultLabel', args: { provider: 'PROVIDER_MARKER' }, markers: ['PROVIDER_MARKER'] },
            { key: 'session.providerBinding.launchNamedLabel', args: { provider: 'PROVIDER_MARKER', connection: 'CONNECTION_MARKER' }, markers: ['PROVIDER_MARKER', 'CONNECTION_MARKER'] },
            { key: 'session.providerBinding.changedBody', args: { provider: 'PROVIDER_MARKER', connection: 'CONNECTION_MARKER' }, markers: ['PROVIDER_MARKER', 'CONNECTION_MARKER'] },
            { key: 'session.providerBinding.unavailableBody', args: { provider: 'PROVIDER_MARKER', connection: 'CONNECTION_MARKER' }, markers: ['PROVIDER_MARKER', 'CONNECTION_MARKER'] },
            { key: 'session.providerBinding.disabledBody', args: { provider: 'PROVIDER_MARKER', connection: 'CONNECTION_MARKER' }, markers: ['PROVIDER_MARKER', 'CONNECTION_MARKER'] },
            { key: 'session.providerBinding.incompatibleBody', args: { provider: 'PROVIDER_MARKER', connection: 'CONNECTION_MARKER' }, markers: ['PROVIDER_MARKER', 'CONNECTION_MARKER'] },
        ] as const;

        const missing = locales.flatMap((root, localeIndex) => samples.flatMap(({ key, args, markers }) => {
            const rendered = callSampledTranslation(readTranslationLeaf(root, key), [args]);
            return rendered && markers.every((marker) => rendered.includes(marker))
                ? []
                : [`locale ${localeIndex}: ${key}`];
        }));

        expect(missing).toEqual([]);
    });
});
