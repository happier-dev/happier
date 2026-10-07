// Locale-owned feature copy; each domain retains its own initialization scope.
import * as EnglishFeatures from './en';
import * as Shared_accountDisplayTranslations from '../accountDisplayTranslations.shared';
import * as Shared_accountEncryptionRecoveryTranslations from '../accountEncryptionRecoveryTranslations.shared';
import * as Shared_accountPopoverTranslations from '../accountPopoverTranslations.shared';
import * as Shared_accountServiceOAuthTranslations from '../accountServiceOAuthTranslations.shared';
import * as Shared_actionConfirmationTranslations from '../actionConfirmationTranslations.shared';
import * as Shared_fileContentSearchTranslations from '../fileContentSearchTranslations.shared';
import * as Shared_promptPickerTranslations from '../promptPickerTranslations.shared';
import type { ActionIdFamilyV1 } from '@happier-dev/protocol';
import * as Shared_actionFamilyTranslations from '../actionFamilyTranslations.shared';
import * as Shared_addFlowsTranslations from '../addFlowsTranslations.shared';
import * as Shared_agentInstallJobTranslations from '../agentInstallJobTranslations.shared';
import * as Shared_agentStartTranslations from '../agentStartTranslations.shared';
import * as Shared_apiTokenSettingsTranslations from '../apiTokenSettingsTranslations.shared';
import * as Shared_artifactsBrowserTranslations from '../artifactsBrowserTranslations.shared';
import * as Shared_automationPageTranslations from '../automationPageTranslations.shared';
import * as Shared_boardsTranslations from '../boardsTranslations.shared';
import * as Shared_browserPresenceTranslations from '../browserPresenceTranslations.shared';
import * as Shared_browserToolTranslations from '../browserToolTranslations.shared';
import * as Shared_changedFileEvidenceTranslations from '../changedFileEvidenceTranslations.shared';
import * as Shared_cliPathExposureTranslations from '../cliPathExposureTranslations.shared';
import * as Shared_cliTrustPromptTranslations from '../cliTrustPromptTranslations.shared';
import * as Shared_commitProposalTranslations from '../commitProposalTranslations.shared';
import * as Shared_committedMessageActionTranslations from '../committedMessageActionTranslations.shared';
import * as Shared_computerUseTranslations from '../computerUseTranslations.shared';
import * as Shared_connectedServicesCollectionTranslations from '../connectedServicesCollectionTranslations.shared';
import * as Shared_connectedServicesPoolTranslations from '../connectedServicesPoolTranslations.shared';
import * as Shared_connectedServicesSettingsTranslations from '../connectedServicesSettingsTranslations.shared';
import * as Shared_connectedServicesSetupTranslations from '../connectedServicesSetupTranslations.shared';
import * as Shared_detailPageTranslations from '../detailPageTranslations.shared';
import * as Shared_detailsChromeTranslations from '../detailsChromeTranslations.shared';
import * as Shared_detailsFileTranslations from '../detailsFileTranslations.shared';
import * as Shared_detailsHistoryTranslations from '../detailsHistoryTranslations.shared';
import * as Shared_detailsReviewTranslations from '../detailsReviewTranslations.shared';
import * as Shared_embedSettingsTranslations from '../embedSettingsTranslations.shared';
import * as Shared_embedTranslations from '../embedTranslations.shared';
import * as Shared_entityDragDropTranslations from '../entityDragDropTranslations.shared';
import * as Shared_eventAutomationComposerTranslations from '../eventAutomationComposerTranslations.shared';
import * as Shared_externalSessionOperationTranslations from '../externalSessionOperationTranslations.shared';
import * as Shared_externalSessionSettingsTranslations from '../externalSessionSettingsTranslations.shared';
import * as Shared_filesPaneTranslations from '../filesPaneTranslations.shared';
import * as Shared_findTranslations from '../findTranslations.shared';
import * as Shared_folderlessSessionTranslations from '../folderlessSessionTranslations.shared';
import * as Shared_glassAppearanceTranslations from '../glassAppearanceTranslations.shared';
import * as Shared_goalControlTranslations from '../goalControlTranslations.shared';
import * as Shared_homeAddTranslations from '../homeAddTranslations.shared';
import * as Shared_homeComposerTranslations from '../homeComposerTranslations.shared';
import * as Shared_homeDeviceApprovalTranslations from '../homeDeviceApprovalTranslations.shared';
import * as Shared_homeFeatureTranslations from '../homeFeatureTranslations.shared';
import * as Shared_homeGovernanceTranslations from '../homeGovernanceTranslations.shared';
import * as Shared_homeIndexTranslations from '../homeIndexTranslations.shared';
import * as Shared_homeSettingsTranslations from '../homeSettingsTranslations.shared';
import * as Shared_homeSetupTranslations from '../homeSetupTranslations.shared';
import * as Shared_homeWidgetTranslations from '../homeWidgetTranslations.shared';
import * as Shared_homesHubTranslations from '../homesHubTranslations.shared';
import * as Shared_homesJourneysTranslations from '../homesJourneysTranslations.shared';
import type { SupportedLanguage } from '../../_all';
import * as Shared_identityAdministrationTranslations from '../identityAdministrationTranslations.shared';
import * as Shared_inboxWorkTranslations from '../inboxWorkTranslations.shared';
import * as Shared_inputPickerTranslations from '../inputPickerTranslations.shared';
import * as Shared_machineAddTranslations from '../machineAddTranslations.shared';
import * as Shared_machineAgentsTranslations from '../machineAgentsTranslations.shared';
import * as Shared_machineDetailPageTranslations from '../machineDetailPageTranslations.shared';
import * as Shared_machinePoolTranslations from '../machinePoolTranslations.shared';
import * as Shared_mcpSettingsTranslations from '../mcpSettingsTranslations.shared';
import * as Shared_menuBarModeTranslations from '../menuBarModeTranslations.shared';
import * as Shared_nativePasswordTranslations from '../nativePasswordTranslations.shared';
import * as Shared_navigationPlacementTranslations from '../navigationPlacementTranslations.shared';
import * as Shared_pendingNavigationTranslations from '../pendingNavigationTranslations.shared';
import * as Shared_personalHomeBootstrapBlockedTranslations from '../personalHomeBootstrapBlockedTranslations.shared';
import * as Shared_personalHomeDecisionTranslations from '../personalHomeDecisionTranslations.shared';
import * as Shared_personalHomeSettingsTranslations from '../personalHomeSettingsTranslations.shared';
import * as Shared_personalizeTranslations from '../personalizeTranslations.shared';
import * as Shared_phoneNavigationTranslations from '../phoneNavigationTranslations.shared';
import * as Shared_pluginAccountDataEraseTranslations from '../pluginAccountDataEraseTranslations.shared';
import * as Shared_pluginAccountReleaseSelectionTranslations from '../pluginAccountReleaseSelectionTranslations.shared';
import * as Shared_pluginInvocationLogTranslations from '../pluginInvocationLogTranslations.shared';
import * as Shared_pluginMachineMatrixTranslations from '../pluginMachineMatrixTranslations.shared';
import * as Shared_pluginMarketplaceDiscoverTranslations from '../pluginMarketplaceDiscoverTranslations.shared';
import * as Shared_pluginPermissionTranslations from '../pluginPermissionTranslations.shared';
import * as Shared_pluginSettingsPresentationTranslations from '../pluginSettingsPresentationTranslations.shared';
import * as Shared_pluginUpdateReviewTranslations from '../pluginUpdateReviewTranslations.shared';
import * as Shared_pluginWebhookAdministrationTranslations from '../pluginWebhookAdministrationTranslations.shared';
import * as Shared_profilesPageTranslations from '../profilesPageTranslations.shared';
import * as Shared_providerCollectionTranslations from '../providerCollectionTranslations.shared';
import * as Shared_reviewWalkthroughTranslations from '../reviewWalkthroughTranslations.shared';
import * as Shared_rolesTranslations from '../rolesTranslations.shared';
import * as Shared_runPageTranslations from '../runPageTranslations.shared';
import * as Shared_scmComparisonTranslations from '../scmComparisonTranslations.shared';
import * as Shared_secretsSettingsTranslations from '../secretsSettingsTranslations.shared';
import * as Shared_sessionAccessTranslations from '../sessionAccessTranslations.shared';
import * as Shared_sessionAgentActivityTranslations from '../sessionAgentActivityTranslations.shared';
import * as Shared_sessionBoardTranslations from '../sessionBoardTranslations.shared';
import * as Shared_sessionCollaborationPaneTranslations from '../sessionCollaborationPaneTranslations.shared';
import * as Shared_sessionCollaborationTranslations from '../sessionCollaborationTranslations.shared';
import * as Shared_sessionCompanionTranslations from '../sessionCompanionTranslations.shared';
import * as Shared_sessionConversationSurfaceTranslations from '../sessionConversationSurfaceTranslations.shared';
import * as Shared_sessionDirectoryRecoveryTranslations from '../sessionDirectoryRecoveryTranslations.shared';
import * as Shared_sessionDraftTranslations from '../sessionDraftTranslations.shared';
import * as Shared_sessionEmbeddedTranslations from '../sessionEmbeddedTranslations.shared';
import * as Shared_sessionFollowTranslations from '../sessionFollowTranslations.shared';
import * as Shared_sessionGitBranchesTranslations from '../sessionGitBranchesTranslations.shared';
import * as Shared_sessionGitDisplayTranslations from '../sessionGitDisplayTranslations.shared';
import * as Shared_sessionGitPaneTranslations from '../sessionGitPaneTranslations.shared';
import * as Shared_sessionGitPullRequestTranslations from '../sessionGitPullRequestTranslations.shared';
import * as Shared_sessionHomeFreshnessTranslations from '../sessionHomeFreshnessTranslations.shared';
import * as Shared_sessionListFilterTranslations from '../sessionListFilterTranslations.shared';
import * as Shared_sessionMessageAccountActorTranslations from '../sessionMessageAccountActorTranslations.shared';
import * as Shared_sessionPageTranslations from '../sessionPageTranslations.shared';
import * as Shared_sessionReminderTranslations from '../sessionReminderTranslations.shared';
import * as Shared_sessionRemotePermissionGrantTranslations from '../sessionRemotePermissionGrantTranslations.shared';
import * as Shared_sessionResponsibilityTranslations from '../sessionResponsibilityTranslations.shared';
import * as Shared_sessionWorkTranslations from '../sessionWorkTranslations.shared';
import * as Shared_settingsConnectionsTranslations from '../settingsConnectionsTranslations.shared';
import * as Shared_settingsMachinesTranslations from '../settingsMachinesTranslations.shared';
import * as Shared_settingsOverviewTranslations from '../settingsOverviewTranslations.shared';
import * as Shared_settingsProfilesRemoteHostsPageTranslations from '../settingsProfilesRemoteHostsPageTranslations.shared';
import * as Shared_settingsProvidersTranslations from '../settingsProvidersTranslations.shared';
import * as Shared_settingsSearchKeywordsTranslations from '../settingsSearchKeywordsTranslations.shared';
import * as Shared_settingsSessionPagesTranslations from '../settingsSessionPagesTranslations.shared';
import * as Shared_shareSheetTranslations from '../shareSheetTranslations.shared';
import * as Shared_sidebarFooterTranslations from '../sidebarFooterTranslations.shared';
import * as Shared_surfaceStateTranslations from '../surfaceStateTranslations.shared';
import * as Shared_teamsTranslations from '../teamsTranslations.shared';
import * as Shared_terminalWorkspaceTranslations from '../terminalWorkspaceTranslations.shared';
import * as Shared_thisComputerConnectionTranslations from '../thisComputerConnectionTranslations.shared';
import * as Shared_transcriptFindTranslations from '../transcriptFindTranslations.shared';
import * as Shared_turnChangesTranslations from '../turnChangesTranslations.shared';
import * as Shared_voiceDiagnosticsConsentTranslations from '../voiceDiagnosticsConsentTranslations.shared';
import * as Shared_voiceDiagnosticsTranslations from '../voiceDiagnosticsTranslations.shared';
import * as Shared_voiceExternalCredentialApprovalTranslations from '../voiceExternalCredentialApprovalTranslations.shared';
import * as Shared_voiceLocalCredentialTranslations from '../voiceLocalCredentialTranslations.shared';
import * as Shared_voiceMomentsTranslations from '../voiceMomentsTranslations.shared';
import * as Shared_voicePresenceTranslations from '../voicePresenceTranslations.shared';
import * as Shared_voiceProviderPrivacyTranslations from '../voiceProviderPrivacyTranslations.shared';
import * as Shared_voiceReadinessTranslations from '../voiceReadinessTranslations.shared';
import * as Shared_voiceRealtimeProviderSetupTranslations from '../voiceRealtimeProviderSetupTranslations.shared';
import * as Shared_voiceSettingsPagesTranslations from '../voiceSettingsPagesTranslations.shared';
import * as Shared_walkthroughProgressTranslations from '../walkthroughProgressTranslations.shared';
import * as Shared_walkthroughSavedTranslations from '../walkthroughSavedTranslations.shared';
import * as Shared_walkthroughSettingsTranslations from '../walkthroughSettingsTranslations.shared';
import * as Shared_walkthroughStartTranslations from '../walkthroughStartTranslations.shared';
import * as Shared_walkthroughTranslations from '../walkthroughTranslations.shared';
import * as Shared_widgetAddTranslations from '../widgetAddTranslations.shared';
import * as Shared_widgetDefinitionTranslations from '../widgetDefinitionTranslations.shared';
import * as Shared_widgetFrameTranslations from '../widgetFrameTranslations.shared';
import * as Shared_widgetGlanceTranslations from '../widgetGlanceTranslations.shared';
import * as Shared_workStatusTranslations from '../workStatusTranslations.shared';
import * as Shared_workflowActionTranslations from '../workflowActionTranslations.shared';
import * as Shared_workflowAgentAuthoringTranslations from '../workflowAgentAuthoringTranslations.shared';
import * as Shared_workflowBuiltinTranslations from '../workflowBuiltinTranslations.shared';
import * as Shared_workflowFieldTranslations from '../workflowFieldTranslations.shared';
import * as Shared_workflowEditorPageTranslations from '../workflowEditorPageTranslations.shared';
import * as Shared_workflowExamplesTranslations from '../workflowExamplesTranslations.shared';
import * as Shared_workflowPluginTranslations from '../workflowPluginTranslations.shared';
import * as Shared_workflowRunVisibilityTranslations from '../workflowRunVisibilityTranslations.shared';
import * as Shared_workflowRunCompositionTranslations from '../workflowRunCompositionTranslations.shared';
import * as Shared_workflowRunListTranslations from '../workflowRunListTranslations.shared';
import * as Shared_workflowRunRoleTranslations from '../workflowRunRoleTranslations.shared';
import * as Shared_workflowStartTranslations from '../workflowStartTranslations.shared';
import * as Shared_workflowsDestinationTranslations from '../workflowsDestinationTranslations.shared';
import * as Shared_workflowTriggersTranslations from '../workflowTriggersTranslations.shared';
import * as Shared_workflowValueReferenceTranslations from '../workflowValueReferenceTranslations.shared';
import * as Shared_workflowTranslations from '../workflowTranslations.shared';
import * as Shared_workspaceBarTranslations from '../workspaceBarTranslations.shared';
import type { TranslationStructure } from '../en';
import * as Shared_workspaceSyncDiagnosticTranslations from '../workspaceSyncDiagnosticTranslations.shared';
import * as Shared_workspaceTabTranslations from '../workspaceTabTranslations.shared';

const Domain_accountDisplayTranslations = (() => {
type AccountDisplayTranslation = Shared_accountDisplayTranslations.AccountDisplayTranslation;

const accountDisplayTranslations = { 'zh-Hans': { unnamed: '未命名的账户', yours: '你的账户', shortId: ({ id }) => `ID …${id}` } } as const satisfies Pick<Record<string, AccountDisplayTranslation>, "zh-Hans">;

return { accountDisplayTranslations };
})();

const Domain_accountEncryptionRecoveryTranslations = (() => {
type Copy = Shared_accountEncryptionRecoveryTranslations.Copy;

const en = Shared_accountEncryptionRecoveryTranslations.en;

const zhHans: Copy = {
    recoverAutomationTemplates: '恢复旧触发器',
    recoverAutomationTemplatesDescription: '使用此设备上的密钥恢复旧触发器。只要加密会话或锁定的触发器仍需要密钥，就会保留它们。',
    recoverAutomationTemplatesAction: '恢复',
    recoverAutomationTemplatesComplete: '已恢复触发器。旧密钥会保留在此设备上，直到你选择忘记它。',
    recoverAutomationTemplatesRetained: '已检查恢复。部分触发器仍处于加密、锁定或已更改状态。旧密钥保留在此设备上。',
    forgetEncryptionKey: '忘记旧加密密钥',
    forgetEncryptionKeyDescription: '此设备上的旧加密会话将被锁定。',
    forgetEncryptionKeyAction: '忘记',
    forgetEncryptionKeyConfirm: '忘记旧加密密钥？',
    forgetEncryptionKeyWarning: ({ items }) => `此设备上的旧加密会话将被锁定。以下加密历史可能无法访问：\n\n${items}\n\n此列表反映当前历史。在此检查后于其他设备上创建的加密会话也将被锁定。恢复旧密钥即可解锁。不会删除账户中的任何数据。`,
    forgetEncryptionKeySession: ({ name, id }) => `会话：${name} (${id})`,
    forgetEncryptionKeyTrigger: ({ id }) => `触发器：${id}`,
    forgetEncryptionKeyRun: ({ id }) => `运行历史：${id}`,
    forgetEncryptionKeyEmpty: '未发现加密历史。',
    forgetEncryptionKeyComplete: '已在此设备上忘记旧密钥。',
    forgetEncryptionKeyFailed: '无法忘记密钥。请重新连接后重试；必须先列出加密历史。',
};

const accountEncryptionRecoveryTranslations = { 'zh-Hans': zhHans } as const;

return { accountEncryptionRecoveryTranslations };
})();

const Domain_accountPopoverTranslations = (() => {
type AccountPopoverTranslation = Shared_accountPopoverTranslations.AccountPopoverTranslation;

const accountPopoverTranslations = { 'zh-Hans': {
        pageTitle: '账户与 Home',
        homesTitle: 'Home',
        notLinkedTo: ({ service }) => `未关联 ${service}`,
        serviceUnavailable: ({ service }) => `无法连接 ${service}`,
        signedInToThisHome: '已登录此 Home',
        checkingSignIn: '正在检查登录…',
        signInStatusUnavailable: '登录状态不可用',
        machinesOnline: ({ online, total }) => `${total} 台机器中 ${online} 台在线`,
        noMachines: '还没有机器',
        connectedNoMachinesOnline: '已连接 · 没有在线的机器',
        cantReach: '无法连接',
        signedOut: '已退出登录',
        signIn: '登录',
        link: '关联',
        linkSubtitle: '在每台设备上找到你的 Home',
        manageHomes: '管理 Home',
        connectionDetails: '连接详情',
        allHomes: '全部 Home',
        allHomesSubtitle: ({ count }) => `${count} 个 Home · 一个列表`,
        addHome: '添加 Home…',
        addDevice: '添加设备',
    } } as const satisfies Pick<Record<string, AccountPopoverTranslation>, "zh-Hans">;

return { accountPopoverTranslations };
})();

const Domain_accountServiceOAuthTranslations = (() => {
const en = Shared_accountServiceOAuthTranslations.en;

const zhHans = {
    title: '登录以查找你的 Home',
    cancelNote: '取消不会退出你现有的 Home。', focusedHomePreserved: '当前聚焦的 Home 不会改变。',
    stages: { signingIn: '正在登录', findingHomes: '正在查找你的 Homes', waitingApproval: '正在等待 Home 批准' },
    errors: { provider: { title: '提供方未完成登录', body: '请重新开始登录。' }, expired: { title: '此登录请求已过期', body: '请重新开始登录。' }, identityChanged: { title: '登录服务身份已更改', body: '重新连接前，请确认这是你想使用的登录服务。' }, unavailable: { title: '登录服务不可用', body: '检查服务后重试。现有 Homes 不会改变。' }, exchange: { title: '无法完成登录', body: '未保存登录服务凭据。请重新开始登录。' }, storage: { title: '无法保存登录', body: '现有 Home 凭据不会改变。请重新开始登录。' }, homeLink: { title: '已登录，但无法关联此 Home', body: '你的登录已保存。请再次尝试关联此 Home。' }, directoryRefresh: { title: '已登录，但无法刷新 Home 列表', body: '登录服务连接已就绪。请再次尝试刷新 Home 列表。' }, homeEnrollment: { title: '已登录，但未添加个人 Home', body: '你的登录已保存。请再次尝试添加 Home。' }, invalid: { title: '此登录请求已失效', body: '请重新开始登录。' }, accountDisabled: { title: '此账户已被停用', body: '请联系登录服务的管理员。你现有的 Home 不会改变。' } },
    actions: { startAgain: '重新开始', openHome: ({ homeName }: { homeName: string }) => `打开 ${homeName}` },
    success: { title: ({ homeName }: { homeName: string }) => `${homeName} 已连接`, body: '你的登录信息已保存，可以开始使用这个 Home。' },
    notLinked: { title: ({ homeName }: { homeName: string }) => `${homeName} 尚未关联到此账户`, signInAction: ({ homeName }: { homeName: string }) => `登录 ${homeName}`, body: ({ homeName }: { homeName: string }) => `直接登录 ${homeName}，或扫描它的二维码、粘贴它的 Home 链接。`, scanBody: ({ homeName }: { homeName: string }) => `扫描 ${homeName} 的二维码或粘贴它的 Home 链接以连接。` },
    noHomes: { body: '此账户还没有 Home。在其他地方添加后刷新，或扫描 Home 的二维码、粘贴其 Home 链接。' },
    approvalWait: { waitingBody: '在你另一台已登录的设备上批准这次登录。', cancelledTitle: '已停止等待批准', cancelledBody: '你的登录仍然保留，现有 Home 不会改变。' },
} as const;

const accountServiceOAuthTranslations = { zhHans } as const;

return { accountServiceOAuthTranslations };
})();

const Domain_actionConfirmationTranslations = (() => {
type ActionConfirmationTranslations = Shared_actionConfirmationTranslations.ActionConfirmationTranslations;

const actionConfirmationTranslations = { 'zh-Hans': {
        requestedByAgent: '会话代理请求的操作',
        homeTarget: ({ serverId }) => `Home：${serverId}`,
        sessionTarget: ({ sessionId }) => `目标会话：${sessionId}`,
        oneShotConsequence: '批准仅适用于此请求，不会授予未来的 Action 权限或原生权限。',
        homeUnavailable: '此批准属于本设备上不可用的 Home。请重新连接该 Home 后再作决定。',
    } } as const satisfies Pick<Record<string, ActionConfirmationTranslations>, "zh-Hans">;

return { actionConfirmationTranslations };
})();

const Domain_fileContentSearchTranslations = (() => {
const fileContentSearchTranslations = { "zh-Hans": {
        textInFiles: "文件中的文本",
        everything: "全部",
        refineSearch: "缩小搜索范围",
        partial: "部分文件无法搜索。显示的结果不完整。",
        updateRequired: "请更新这台机器上的 Happier，以搜索文件中的文本。",
        invalidPattern: "正则表达式无效。请修改模式后重试。",
        unavailable: "文本搜索不可用。请检查机器连接后重试。",
        placeholder: "搜索文件、消息、提交、会话、设置和操作",
        matchCase: "区分大小写",
        regex: "正则表达式",
    } };

return { fileContentSearchTranslations };
})();

const Domain_promptPickerTranslations = (() => {
const promptPickerTranslations = { "zh-Hans": {
        "partialHistory": "发送历史仅涵盖已知会话。",
        "loadedHistory": "发送历史仅显示已加载的消息。",
        "open": "打开提示词",
        "menu": "提示词…",
        "placeholder": "搜索提示词和已发送的消息",
        "favorites": "收藏",
        "library": "提示词库",
        "sentBefore": "发送历史",
        "builtIn": "内置",
        "readError": "无法读取此提示词，请重试。",
        "libraryError": "无法加载提示词库。",
        "partialLibrary": "部分提示词无法读取。",
        "loadOlder": "搜索更早的消息",
        "stop": "停止",
        "insert": "插入",
        "send": "立即发送",
        "addFavorite": "添加到收藏",
        "removeFavorite": "取消收藏",
        "empty": "将消息保存为提示词，即可在这里重复使用。",
        "applyError": "无法应用提示词，请重试。",
        "historyError": "无法加载更早的消息，请重试。",
        "title": "提示词",
        "clear": "清除",
        "favorite": "收藏",
        "favoritesInvite": "为提示词或已发送的消息加星标即可保留在这里。",
        "saveAsFavorite": "保存为收藏的提示词",
        "saveInPlaceStarred": ({ time }: { time: string }) => `来自你 ${time} 的消息 · 加星标存入资料库`,
        "saveInPlace": ({ time }: { time: string }) => `来自你 ${time} 的消息 · 存入资料库`,
        "noMatchesFor": ({ query }: { query: string }) => `没有与“${query}”匹配的提示词或已加载消息`,
        "previewInserts": "插入后由你发送",
        "previewSent": "之前发送",
        "previewEdited": ({ time }: { time: string }) => `编辑于 ${time}`,
        "searchingOlder": ({ searched, total }: { searched: number; total: number }) => `正在搜索更早的消息… 第 ${searched}/${total} 个会话`
    } } as const;

return { promptPickerTranslations };
})();

const Domain_actionFamilyTranslations = (() => {
const fileContentSearchTranslations = {...Domain_fileContentSearchTranslations.fileContentSearchTranslations, ...EnglishFeatures.fileContentSearchTranslations.fileContentSearchTranslations};

const promptPickerTranslations = {...Domain_promptPickerTranslations.promptPickerTranslations, ...EnglishFeatures.promptPickerTranslations.promptPickerTranslations};

const surfaceFamilyLabels = Shared_actionFamilyTranslations.surfaceFamilyLabels;

const english = Shared_actionFamilyTranslations.english;

const translated = Shared_actionFamilyTranslations.translated;

const actionFamilyTranslations = { 'zh-Hans': translated({
        actionFamilies: {
            ...surfaceFamilyLabels,
            workspace_file_search: fileContentSearchTranslations['zh-Hans'].textInFiles,
            find: '查找',
            app_shell: 'Workspace',
            roles: '角色',
            launch_profiles: '启动配置',
            discovery: '操作发现',
            computer: '计算机控制',
            artifact_access: '制品共享',
            workflows: '工作流',
            notifications: '通知',
            machine_agent_install: '代理安装',
            machine_agent_sign_in: '代理登录',
            session_access: '会话共享',
            session_lifecycle: '会话生命周期',
            inventory: '电脑清单',
            messaging: '消息',
            session_control: '会话控制',
            intent_start: '评审与委派',
            review_comments: '评审评论',
            subagent_registry: '子代理',
            execution_run_control: '后台运行',
            session_targeting: '会话定位',
            session_follow: '关注会话',
            session_transcripts: '会话记录',
            session_read_state: '已读状态',
            session_attention: '待关注',
            session_board: '会话看板',
            session_discussion: '讨论',
            session_permissions: '会话权限',
            external_sessions: '外部会话',
            voice_controls: '语音控制',
            current_ui_context: '当前屏幕',
            companion_controls: '伴侣',
            memory: '记忆',
            agent_acp_catalog: 'ACP 代理',
            prompt_library: '提示词库',
            daemon_admin: '守护进程管理',
            browser_control: '浏览器控制',
            browser_diagnostics: '浏览器诊断',
            browser_context: '浏览器上下文',
            browser_automation: '浏览器自动化',
            browser_recording: '浏览器录制',
            local_services_inventory: '本地服务',
            local_services_launcher: '服务启动器',
            local_services_preview: '服务预览',
            local_services_public_preview: '公开预览',
            local_services_actions: '服务操作',
            peer_mediation_observability: '连接诊断',
            devices_simulator: '模拟器',
            approvals: '审批',
            plugin_dev_loop: '插件开发',
            plugin_settings_administration: '插件设置',
            plugin_permission_grants: '插件权限',
            plugin_webhooks: '插件 Webhook',
            account_plugin_data: '插件数据',
            account_sessions: '已登录设备',
            account_security: '帐户安全',
            account_api_tokens: 'API 令牌',
            identity_github_apps: 'GitHub 应用',
            identity_providers: '登录提供方',
            machine_pools: '电脑池',
            ephemeral_runner: '运行器',
            automation_events: '自动化事件',
            automation_conversation: '自动化对话',
            scm_git: 'Git',
            scm_pull_request: '拉取请求',
            scm_repository: '仓库',
            scm_diff_summary: '差异摘要',
            home_governance: 'Home 管理',
            teams: '团队',
            saved_secret_sharing: '共享密钥',
        },
    }) } as const;

return { actionFamilyTranslations };
})();

const Domain_addFlowsTranslations = (() => {
type AddFlowsTranslation = Shared_addFlowsTranslations.AddFlowsTranslation;

const addFlowsTranslations = { 'zh-Hans': {
        addHome: '添加 Home',
        addHomeSubtitle: '登录、按地址连接或使用托管的 Home',
        addHomeDescription: '连接你已在使用的 Home，或使用为你托管的 Home。',
        newGroup: '新建组',
        newGroupSubtitle: '一起查看多个 Home 的会话',
        groupsTitle: '组',
        homesInUse: '此处正在使用',
        thisDeviceTitle: '此设备',
        thisDeviceSubtitle: '它如何连接到各个 Home',
        thisDeviceDescription: '此设备如何连接到各个 Home：等待加入的设备、使用的连接以及它运行的 Home。',
        newHomeDraft: '新 Home',
        homeMissingTitle: '此设备上没有这个 Home',
        homeMissingDescription: '它已被移除，或保存在另一台设备上。',
        homeManageTitle: '管理',
        homeAdministrationSubtitle: '此 Home 的成员、登录、访问与数据',
        groupMissingTitle: '此组已不存在',
        groupMissingDescription: '它已被移除。你的 Home 没有变化。',
        discard: '放弃',
        sshSignInAgent: '此电脑上的 SSH 代理',
        sshSignInKeyFile: '此电脑上的私钥文件',
        sshSignInPassword: '仅用于本次连接，从不保存',
        addMachineMenuSubtitle: '一台电脑或服务器',
        addMachineDescription: '添加一台电脑或服务器，让代理在上面运行你的会话。',
        machineJoinsHome: ({ home }) => `加入 ${home}`,
        pathThisComputerTitle: '这台电脑',
        pathThisComputerTask: '一步完成设置',
        pathThisComputerCommand: '在终端里运行一条命令',
        pathSshTitle: '通过 SSH 的服务器',
        pathSshChip: 'SSH 服务器',
        pathSshSubtitle: '开发机、虚拟机或云服务器',
        pathAnotherTitle: '另一台电脑',
        pathAnotherSubtitle: '在那台电脑上打开 Home 链接',
        machinePoolPrompt: '希望会话在机器之间自动切换？',
        thisComputerCommandLead: ({ home }) => `在这台电脑的终端里运行它。它会安装 Happier 并加入 ${home}；一旦就绪，此页面会立刻发现。`,
        thisComputerTaskLead: ({ machine, home }) => `${machine} 将为 ${home} 运行代理。Happier 会安装一个随电脑启动的小型后台服务。`,
        setUpThisComputer: '设置这台电脑',
        desktopAppHint: '更想点一下而不是敲命令？',
        desktopAppLink: '获取桌面应用——它会自动设置这台电脑。',
        thisComputerRunningLead: ({ machine }) => `正在设置 ${machine}。你可以继续使用 Happier。`,
        onAnotherHomeTitle: ({ machine }) => `${machine} 已连接到另一个 Home`,
        onAnotherHomeBody: ({ home }) => `它的 Happier 服务正在为另一个 Home 运行会话。移到 ${home} 会保留设置；已有会话留在原处。`,
        moveToHome: ({ home }) => `移到 ${home}`,
        keepOnOtherHome: '保持不变',
        sshLeadTask: ({ home }) => `你已能通过 SSH 访问的开发机、虚拟机或云服务器。这台电脑会连上它、安装 Happier 并加入 ${home}。`,
        sshLeadCommand: ({ home }) => `可通过 SSH 访问的开发机、虚拟机或云服务器。在能访问它的电脑上运行命令；它会安装 Happier 并加入 ${home}。`,
        setUpHost: ({ host }) => `设置 ${host}`,
        sshSavedNote: '主机会保存到“远程主机”；密码从不保存。',
        sshRunningTitle: ({ host }) => `正在设置 ${host}`,
        sshRunningLead: '正在从这台电脑通过 SSH 运行。你可以离开；机器列表会显示进度并在完成时告诉你。',
        anotherLead: ({ home }) => `在那台电脑的终端里运行它。它会安装 Happier 并加入 ${home}。`,
        anotherTerminalAction: '改用终端命令',
        machineWatching: ({ subject }) => `正在等待 ${subject} 加入 `,
        subjectThisComputer: '这台电脑',
        subjectAnotherComputer: '那台电脑',
        machineNotSeeingTitle: ({ subject }) => `还没看到 ${subject}？`,
        machineNotSeeingBody: ({ home }) => `Happier 仍在等待。通常是设置出错停止、机器无法访问 ${home}，或它被设置到了另一个 Home。`,
        machineArrived: ({ machine }) => `${machine} 已连接`,
        machineConnectedJustNow: '刚刚连接',
        machineStartSession: ({ machine }) => `在 ${machine} 上开始会话`,
        machineAddAnother: '再添加一台',
        cancelSetup: '取消',
        detectedOs: '已检测',
        sshSuggestionsTitle: '来自你的 SSH 配置和已保存的主机',
        connectingToHome: ({ address }) => `正在连接 ${address}…`,
        pathThisComputerConnected: '已连接 · 查看其代理',
    } } satisfies Pick<Readonly<Record<string, AddFlowsTranslation>>, "zh-Hans">;

return { addFlowsTranslations };
})();

const Domain_agentInstallJobTranslations = (() => {
const en = Shared_agentInstallJobTranslations.en;

const agentInstallJobTranslations = { zhHans: { ...en } };

return { agentInstallJobTranslations };
})();

const Domain_agentStartTranslations = (() => {
const en = Shared_agentStartTranslations.en;

const zhHans: typeof en = {
    titles: {
        conversation: '旁边的对话',
    },
    descriptions: {
        conversation: ({ machine }) => `随便问，不会打断这个会话。它在 ${machine} 上并行运行；除非你发送，否则不会传回任何内容。`,
    },
    chips: {
        engineTitle: '由谁回答',
        addReviewer: '添加审查者',
        removeReviewer: ({ name }) => `移除 ${name}`,
        scope: '审查范围',
        advanced: '高级',
    },
    reportToSession: '向此会话汇报',
    startsWhenYouSend: ({ count }) => count > 1 ? `发送后开始 ${count} 项审查` : '发送后开始',
    offline: ({ machine }) => `${machine} 离线。代理会在那里启动；草稿会保留在这里，直到它恢复。`,
    menu: {
        askSection: '让代理',
        secondOpinionTitle: '第二意见',
        secondOpinionSubtitle: '完成前的独立检查',
        keepGoingTitle: '持续到完成…',
        keepGoingSubtitle: '在目标控件中设置目标',
        runWorkflowTitle: '运行工作流',
        runWorkflowSubtitle: '来自你的资料库或内置',
        searchWorkflows: '搜索工作流…',
        yourLibrary: '你的资料库',
        noWorkflows: '还没有已保存的工作流',
        addTriggerTitle: '添加触发器…',
        addTriggerSubtitle: '每次发生某事时在这里运行',
        advancedTitle: '高级…',
        advancedSubtitle: '多个代理、权限、配置文件',
        builtIn: '内置',
        allWorkflows: '所有工作流…',
    },
    role: {
        replaces: ({ agent }) => `替代 ${agent}`,
    },
    startRow: {
        subtitle: '草稿 · 发送后开始',
        conversation: '新对话',
        review: '新审查',
        plan: '新计划',
        delegate: '新任务',
    },
    pane: {
        cancelRun: '取消运行',
        whenItFinishes: '完成后',
        sendToSession: ({ session }) => `发送到 ${session}`,
        replyTo: ({ agent }) => `回复 ${agent}…`,
        repliesGoTo: ({ session }) => `回复会发给这个代理，而不是 ${session}`,
    },
};

const agentStartTranslations = { zhHans };

return { agentStartTranslations };
})();

const Domain_apiTokenSettingsTranslations = (() => {
const english = Shared_apiTokenSettingsTranslations.english;

const translated = Shared_apiTokenSettingsTranslations.translated;

const apiTokenSettingsTranslations = { 'zh-Hans': translated({
        settingsApiTokens: {
            encryption: {
                choice: "加密访问",
                consequence: "授予整个帐户的加密访问权限。撤销将停止未来的 API 授权；已获取的密钥或数据无法收回。",
                enabled: "已启用加密访问",
                bearerOnly: "仅 API 访问",
                unknown: "加密访问未知",
                outcomeUnknown: "创建可能已完成。请刷新列表并撤销此令牌，然后再主动创建替代令牌。",
                unsupported: "此 Home 尚不支持加密 API 令牌。请更新它或创建普通令牌。",
                notReady: "创建加密令牌之前，请在此 Home 恢复加密访问。",
                stale: "帐户加密密钥已更改。请在此 Home 恢复访问。",
                idConflict: "此令牌 ID 已存在。请先撤销该确切令牌，再创建新令牌。",
            },
            unattended: {
                choice: "无人值守团队访问",
                consequence: "将此凭据当前已验证的身份验证方式复制到令牌，用于受限团队工作。加密访问权限单独设置。",
                authorized: "已授权无人值守团队访问",
                notAuthorized: "无无人值守团队访问",
                evidenceLimit: "此凭据包含过多已验证的身份验证方式，无法复制。未创建令牌。",
                evidenceUnavailable: "此已登录凭据没有可复制的当前身份验证凭证。请使用所需方式重新验证身份；未创建令牌。",
            },
            title: 'API 令牌',
            entrySubtitle: '让脚本、服务器和嵌入式应用代表你执行操作，且仅拥有你授予的访问权限。',
            tokens: 'API 令牌',
            refreshing: '正在刷新…',
            emptyTitle: '尚无 API 令牌',
            emptyBody: '令牌可让受信任的脚本和工具执行你允许的自动化操作。当集成需要访问当前帐户时，请创建令牌。',
            created: '创建时间',
            lastUsed: '上次使用',
            neverUsed: '从未使用',
            securityTitle: '安全',
            securityFooter: '这些操作会影响整个当前帐户。',
            status: {
                active: '有效',
                expiresInMinutes: ({ count }) => `${count} 分钟后过期`,
                expiresInHours: ({ count }) => `${count} 小时后过期`,
                expiresInDays: ({ count }) => `${count} 天后过期`,
                expired: '已过期',
            },
            rowAccessibilityLabel: ({ label, state }) => `${label}，${state}`,
            moreActionsAccessibilityLabel: ({ label }) => `${label}的更多操作`,
            create: {
                button: '创建令牌',
                title: '创建 API 令牌',
                subtitle: '为集成命名，并选择此令牌的过期时间。您的 Home 可以读取普通 API 请求和结果；加密访问可保护受支持的 SDK 调用。',
                submit: '创建令牌',
                label: '标签',
                labelPlaceholder: '发布自动化',
                expiry: '过期时间',
                expiryOptions: {
                    '30d': '30 天',
                    '90d': '90 天',
                    '1y': '1 年',
                    none: '永不过期',
                },
                access: '访问权限',
                accessFull: '完全访问',
                accessLimited: '受限',
                accessLimitedDescription: '接下来选择操作、会话、模型和网站。',
                accessTitle: '选择访问权限',
                continue: '继续',
                back: '返回',
                actionSettingsPrefix: '此令牌可执行当前帐户的',
                actionSettingsLink: '操作设置中为 External API 与 SDK 启用的任何操作。',
            },
            reveal: {
                title: '保存你的 API 令牌',
                accessibilityAnnouncement: '请立即复制令牌；它只会显示一次。',
                successTitle: '已创建令牌',
                shownOnce: '请立即复制此令牌。为保护你的安全，Happier 无法再次显示它。',
                copy: '复制令牌',
                copied: '已复制',
                dismissTitle: '不确认就离开吗？',
                dismissBody: '此令牌不会再次显示。请先复制它，或确认你已将它保存在安全的位置。',
                copyFirst: '保持令牌可见',
                savedIt: '我已保存',
            },
            revoke: {
                title: ({ label }) => `要撤销“${label}”吗？`,
                body: '服务器和 API 访问将在下次验证时停止。最近验证过此 API 令牌的本地守护进程，可能仍会继续接受它最多一分钟。此操作无法撤销。',
                confirm: '撤销令牌',
            },
            revokeAll: {
                title: '撤销所有 API 令牌',
                subtitle: '禁用此帐户的所有 API 令牌。',
                body: '服务器和 API 访问将在下次验证时停止。使用这些令牌的嵌入将停止工作，其嵌入凭据将被退出登录。最近验证过这些 API 令牌的本地守护进程，可能仍会继续接受它们最多一分钟。此操作无法撤销。',
                confirm: '全部撤销',
                railAction: '撤销所有 API 令牌…',
            },
            signOutEverywhere: {
                title: '在所有位置退出登录',
                subtitle: '结束此帐户的所有已登录会话。',
                body: '浏览器和设备上的所有已登录会话都将结束。API 令牌仍会保持有效；请在此屏幕中单独撤销它们。',
                confirm: '在所有位置退出登录',
            },
            errors: {
                labelRequired: '请先输入标签，再创建令牌。',
                accountChanged: '你的活动账户或 Home 已更改，因此未做任何更改。请重新打开以继续。',
                presentUserRequired: '请在登录提示中确认你的身份，然后重试。',
                offline: 'Happier 无法访问你的帐户。请检查连接后重试。',
                unavailable: '此操作暂时不可用。请稍后重试。',
                copyFailed: '无法复制令牌。请在关闭前选中它并手动复制。',
                listTitle: 'API 令牌不可用',
                grantIncomplete: '请先完成访问权限选择，再创建令牌。',
            },
            embedPill: '嵌入',
            embedRowHint: '在设置的“嵌入”中打开此嵌入。',
            summary: {
                full: '完全访问',
                allActions: '所有操作',
                namesAndMore: ({ names, count }) => `${names} +${count}`,
                sessions: ({ count }) => (count === 1 ? '1 个会话' : `${count} 个会话`),
                computers: ({ count }) => (count === 1 ? '1 台电脑' : `${count} 台电脑`),
                approve: '可批准',
                models: ({ count }) => (count === 1 ? '1 个模型' : `${count} 个模型`),
                websites: ({ count }) => (count === 1 ? '1 个网站' : `${count} 个网站`),
                content: '内容访问',
                noExpiry: '永不过期',
                expires: ({ date }) => `${date} 过期`,
                expired: ({ date }) => `已于 ${date} 过期`,
            },
            grant: {
                accessTitle: '访问权限',
                back: '访问权限',
                onlyThese: '仅限这些',
                selectedCount: ({ count }) => (count === 1 ? '已选 1 项' : `已选 ${count} 项`),
                reviewUnnamed: '此令牌',
                actions: {
                    title: '操作',
                    all: '所有操作',
                    none: '请至少选择一个操作',
                    search: '搜索操作',
                    noMatches: ({ query }) => `没有与“${query}”匹配的操作`,
                    groupDescription: '选择整个分组也会包含之后添加到该分组的操作。',
                    familyCount: ({ count }) => (count === 1 ? '分组 · 1 个操作' : `分组 · ${count} 个操作`),
                    includedByFamily: ({ family }) => `包含在 ${family} 中`,
                },
                targets: {
                    title: '会话和电脑',
                    all: '所有会话和电脑',
                    none: '请至少选择一个会话或一台电脑',
                    computers: '电脑',
                    computersDescription: '一台电脑涵盖其上现在及以后的所有会话。',
                    sessions: '会话',
                    searchSessions: '搜索会话',
                    noSessions: '暂无会话',
                    noSessionMatches: ({ query }) => `没有与“${query}”匹配的会话`,
                    noComputers: '暂无电脑',
                },
                models: {
                    title: '模型',
                    any: '任意模型',
                    onlyThese: '仅限这些模型',
                    none: '请至少选择一个模型',
                    pickerDescription: '其他模型会被拒绝，而不只是隐藏。选择模型后将不再提供“自动”。',
                    noModels: '暂无可选模型',
                },
                approve: {
                    title: '批准请求',
                    on: '它可以批准上述会话中的工具使用和请求——包括它自己发起的请求。它永远无法更改令牌、安全设置或插件。',
                    off: '请求会在 Happier 中等待你处理。',
                },
                websites: {
                    title: '网站',
                    description: '这些网站上的页面可以在浏览器中使用此令牌。脚本和服务器请留空。',
                    inputLabel: '添加网站',
                    placeholder: 'https://app.example.com',
                    add: '添加',
                    invalid: '请以 https:// 开头，localhost 可使用 http://。',
                    duplicate: '此网站已在列表中。',
                    remove: ({ origin }) => `移除 ${origin}`,
                },
            },
            detail: {
                whatItCanDo: '它能做什么',
                whatItCanDoDescription: '此令牌可以代表你执行的操作。其他一切都会被拒绝。',
                everyAction: '为 External API 与 SDK 启用的所有操作',
                wholeGroup: '整个分组',
                where: '范围',
                whereDescription: '它可以访问的会话和电脑。',
                computerCovers: '此电脑上的所有会话',
                unknownComputer: '已不在列表中的电脑',
                unknownSession: '已不在列表中的会话',
                modelsDescription: '其他模型会被拒绝，而不只是隐藏。',
                approvals: '批准',
                approvesOn: '会批准请求',
                approvesOff: '不会批准请求',
                websitesDescription: '这些网站的浏览器页面可以使用它。',
                noWebsites: '仅限脚本和服务器',
                content: '内容访问',
                contentOn: '它可以通过受支持的 SDK 调用读取端到端加密内容。',
                contentOff: '它无法读取端到端加密内容。',
                children: '嵌入凭据',
                childrenDescription: '你的应用从此令牌为其页面签发的短期密钥。',
                childrenCount: ({ count }) => (count === 1 ? '1 个有效' : `${count} 个有效`),
                childrenConsequence: '编辑访问权限或撤销此令牌时会被退出登录。',
                sessionLimits: '会话',
                sessionLimitsDescription: '它可以启动的会话，以及其消息可使用的权限模式。',
                createsSessions: '启动会话',
                createsSessionsOn: ({ computer }: { computer: string }) => `在 ${computer} 上，位于 Happier 管理的私有文件夹中。`,
                editAccess: '编辑访问权限',
                revokeFootnote: '使用它的脚本和嵌入将在下次请求时停止工作。',
                created: ({ date }) => `创建于 ${date}`,
                lastUsed: ({ date }) => `上次使用于 ${date}`,
                missingTitle: '此令牌已不存在',
                missingBody: '它已被撤销或已过期并被移除。你的其他令牌仍在列表中。',
                backToTokens: '显示 API 令牌',
            },
            edit: {
                title: '编辑访问权限',
                save: '保存',
                signsOut: '有效的嵌入凭据将被退出登录。',
            },
            cliPolicy: {
                sectionTitle: 'CLI 和守护进程',
                sectionDescription: '你电脑上的命令可以使用你的登录身份做什么。',
                title: '允许通过 CLI 和守护进程进行批准和帐户更改',
                description: '允许你电脑上的命令批准请求并更改帐户设置。如果代理以 shell 访问权限运行，请关闭此项。单台电脑也可以通过 HAPPIER_CLI_PRESENT_USER=disallowed 选择退出。更改此设置会让你的电脑短暂重新连接。',
                unavailable: '无法读取此设置。请稍后重试。',
                saveFailed: '无法更改此设置。请稍后重试。',
            },
            notices: {
                revoked: '已撤销 API 令牌。',
                revokedAll: '已撤销所有 API 令牌。',
                signedOutEverywhere: '已在所有位置退出登录。API 令牌仍保持有效。',
            },
        },
    }) } as const;

return { apiTokenSettingsTranslations };
})();

const Domain_artifactsBrowserTranslations = (() => {
type ArtifactsBrowserTranslations = Shared_artifactsBrowserTranslations.ArtifactsBrowserTranslations;

const artifactsBrowserTranslations = { 'zh-Hans': {
        description: '你和你的智能体保存的内容，随时可阅读、复用和分享。',
        newDocument: '新建文档',
        searchPlaceholder: '搜索工件',
        kindLabel: '类型',
        kinds: {
            all: '所有类型',
            document: '文档',
            prompt: '提示词',
            board: '看板',
            workflow: '工作流',
            role: '角色',
            launchProfile: '启动配置',
        },
        kindOne: {
            document: '文档',
            prompt: '提示词',
            board: '看板',
            workflow: '工作流',
            role: '角色',
            launchProfile: '启动配置',
        },
        sort: {
            label: '排序',
            updated_desc: '最近更新',
            created_desc: '最近创建',
            title_asc: '标题',
        },
        view: {
            label: '视图',
            grid: '网格',
            list: '列表',
        },
        provenance: {
            savedByYou: '由你保存',
            sharedWithYou: '与你共享',
            fromFile: ({ name }) => `来自 ${name}`,
            openSession: ({ session }) => `打开 ${session}`,
        },
        emptyTitle: '留住智能体的成果',
        emptyBody: '你或智能体保存的计划、笔记、代码和看板都会出现在这里——在任何设备上都能阅读，并可随时与团队分享。',
        emptyHint: '或者让智能体“把它保存为工件”。',
        loadFailedTitle: '无法加载你的工件',
        loadFailedBody: '请检查网络连接后重试。没有任何内容丢失。',
        quota: {
            accountTitle: '工件存储已满',
            documentTitle: '太大，无法保存',
            accountBody: ({ used, limit }) => `已用 ${used} / ${limit}（含版本）。删除或导出不再需要的工件即可保存新的工件。`,
            documentBody: ({ size, limit }) => `将达到 ${size}；每个工件最多 ${limit}。你的编辑仍然保留。`,
        },
        open: {
            document: '打开文档',
            prompt: '打开提示词',
            board: '打开看板',
            workflow: '打开工作流',
            role: '打开角色',
            launchProfile: '打开启动配置',
        },
        openAsPage: '作为页面打开',
        actions: {
            edit: '编辑',
            history: '历史',
            share: '分享',
            more: '更多操作',
            copyLink: '复制链接',
            linkCopied: '已复制链接',
        },
        history: {
            title: '历史',
            current: '当前',
            now: '现在',
            restoreNote: '恢复会将其添加为新版本，不会丢失任何内容。',
            loadFailed: '无法加载历史记录，请重试。',
            empty: '还没有更早的版本。每次保存都会保留一个。',
            versionsLabel: '版本',
            restoreFailed: '无法恢复此版本，请重试。',
            savedByUser: '由用户保存',
            savedByAgentSession: '由代理会话保存',
            restoredVersion: ({ n }) => `从版本 ${n} 恢复`,
            version: ({ n }) => `版本 ${n}`,
            keeps: ({ count }) => `保留最近 ${count} 个版本。`,
            restore: ({ n }) => `恢复版本 ${n}`,
        },
        savedToday: ({ count }) => `今天保存了 ${count} 个`,
        noMatch: ({ query }) => `没有与“${query}”匹配的工件`,
        storage: {
            meter: ({ used, limit }) => `${used} / ${limit}`,
            a11y: ({ used, limit }) => `工件存储：已用 ${used} / ${limit}`,
        },
        facts: {
            edited: ({ age }) => `${age}编辑`,
        },
    } } satisfies Pick<Record<'en' | 'fr' | 'de' | 'es' | 'it' | 'pt' | 'ca' | 'ru' | 'pl' | 'ja' | 'zh-Hans' | 'zh-Hant', ArtifactsBrowserTranslations>, "zh-Hans">;

return { artifactsBrowserTranslations };
})();

const Domain_automationPageTranslations = (() => {
const english = Shared_automationPageTranslations.english;

const translated = Shared_automationPageTranslations.translated;

const slavicPlural = Shared_automationPageTranslations.slavicPlural;

const automationPageTranslations = { 'zh-Hans': translated({
        automationPages: {
            index: {
                description: '自动开始的工作：按计划、由 Event 触发，或在会话的一轮结束时开始。',
            },
            settings: {
                description: '每台机器承接多少自动化工作，以及已完成的运行保留多久。',
                capacityTitle: '容量',
                capacityDescription: '适用于每台运行自动化的机器。',
                historyTitle: '运行历史',
                historyDescription: '仍可从自动化中打开的已完成运行。',
            },
            detail: {
                description: '只要任一触发器触发，就会自动开始工作。',
                triggerCount: ({ count }: { count: number }) => `${count} 个触发器`,
                overviewDescription: '它运行什么，以及如何启动或更改它。',
                runNowSubtitle: '立即开始一次运行，无需等待触发器。',
                editSubtitle: '更改名称、运行内容和触发器。',
                machineAssignmentsDescription: '可以承接此自动化运行的机器。',
            },
            run: {
                description: '是什么启动了这次运行、在哪里运行，以及产生了什么。',
                statusTitle: '状态',
                statusDescription: '这次运行现在的进展，以及你还能对它做什么。',
                causeTitle: '启动原因',
                causeDescription: '准许这次运行的触发器和事件。之后不会改变。',
            },
            gate: {
                serverTitle: '此 Home 已关闭自动化',
                serverBody: '此 Home 的管理员已关闭自动化。请联系其中一位管理员重新开启。',
                openFeatures: '打开功能设置',
                unknownTitle: '暂时无法检查自动化',
                unknownBody: 'Happier 无法连接到此 Home 以检查自动化是否已开启。请在它恢复在线后再次检查。',
                unsupportedTitle: '此 Home 尚不支持自动化',
                unsupportedBody: '它的服务器版本早于自动化功能。请更新 Home 的服务器以使用自动化。',
                unsupportedContextTitle: '此处无法使用自动化',
                unsupportedContextBody: '你正在查看的 Home 并非都支持自动化。',
            },
            editor: {
                description: '为它命名，选择它运行的内容，然后添加启动它的触发器。',
            },
        },
    }) };

return { automationPageTranslations };
})();

const Domain_automationTriggerSetTranslations = (() => {
const expandedLifecycleEnglish = {
    lifecycleTitle: 'When a Session event occurs',
    lifecycleSource: ({ session, ordinal }: { session: string; ordinal: number }) =>
        `${session} · Session event trigger ${ordinal}`,
    lifecycleSourceTitle: 'Source session',
    changeLifecycleSource: 'Choose a different Session',
    lifecycleEventsTitle: 'Events',
    lifecycleEvent: {
        parentTurnCompleted: 'Turn completed successfully',
        parentTurnFailed: 'Turn failed',
        parentTurnCancelled: 'Turn was cancelled or stopped',
        userActionRequired: 'Needs your attention',
        sessionStarted: 'When the session starts',
        sessionArchived: 'When the session is archived',
    },
    lifecycleAttentionPrivacy: 'Uses only the request identity and turn—not its private contents.',
    lifecyclePolicyTitle: 'Occurrence',
    lifecyclePolicy: {
        currentTurn: 'Current turn only',
        firstMatch: 'First matching event',
        nextMatches: 'Next matching events',
        everyMatch: 'Every matching event',
    },
    lifecyclePolicyDescription: {
        currentTurn: 'Runs at most once for the exact active parent turn.',
        firstMatch: 'Runs once for the first selected event after this trigger is saved.',
        nextMatches: 'Runs for a fixed number of future selected events.',
        everyMatch: 'Runs for every future selected event while enabled.',
    },
    lifecycleMatchCount: 'Number of matches',
    lifecycleMatchCountHelp: 'Each unique matching event uses one occurrence.',
} as const;

const automationTriggerSetTranslations = { 'zh-Hans': {
        pluralEditor: {
            ...expandedLifecycleEnglish,
            lifecycleEvent: {
                ...expandedLifecycleEnglish.lifecycleEvent,
                sessionStarted: '会话开始时',
                sessionArchived: '会话归档时',
            },
            triggersTitle: '触发器',
            emptyBody: '没有自动触发器。你仍可手动运行此自动化。', orSemantics: '可添加任意数量的触发器。它们彼此独立，任意一个匹配时都会运行自动化。',
            enabledSubtitle: '暂停整个自动化，而不更改任何触发器。', addTrigger: '添加触发器', addTriggerSubtitle: '设置计划、连接事件，或等待某个指定轮次结束。',
            scheduleTitle: '计划', eventTitle: '插件事件', turnCompletedTitle: '当此轮次结束时', turnCompletedSubtitle: '在所选的确切父轮次完成后运行一次。', selectedSession: '已选会话',
            turnCompletedSource: ({ session, ordinal }: { session: string; ordinal: number }) => `${session} · 一次性触发器 ${ordinal}`,
            scheduleInterval: ({ minutes, timezone }: { minutes: number; timezone: string | null }) => `每 ${minutes} 分钟${timezone ? ` · ${timezone}` : ''}`,
            scheduleCron: ({ expression, timezone }: { expression: string; timezone: string | null }) => `${expression}${timezone ? ` · ${timezone}` : ''}`,
            eventSubtitle: ({ pluginId, eventId }: { pluginId: string; eventId: string }) => `${pluginId} · ${eventId}`,
            triggerEnabledLabel: ({ title }: { title: string }) => `启用${title}`, editScheduleTitle: '编辑计划', scheduleType: '计划类型', chooseSession: '选择进行中的会话',
            eventEditorUnavailable: '当前机器无法设置事件。', removeTitle: '移除此触发器？', removeBody: '此触发器今后的事件将不再启动自动化。现有运行历史不会改变。',
        },
        exactTurn: {
            eventSearchPlaceholder: '搜索事件',
            refreshFailedTitle: '无法刷新自动化',
            refreshFailedBody: '当前无法读取自动化列表。请重试以加载当前列表。',
            actionTitle: '当此轮次结束时…', createNew: '创建新自动化', createNewSubtitle: '以已选中的这个确切轮次开始。',
            addToExistingSubtitle: '将这个确切轮次添加到现有自动化。', searchPlaceholder: '搜索自动化', eventListA11y: '选择会话生命周期事件', destinationA11y: '选择要将此轮次触发器添加到何处',
            staleTitle: '此轮次已更改', staleBody: '所选轮次已不再是当前活动的父轮次。请刷新并明确选择当前轮次。',
            useCurrentTurn: '使用当前轮次', unavailable: '当前没有可用的活动父轮次。',
            resolvingRowSubtitle: '正在检查你可以使用哪些自动化…',
            unavailableRowSubtitle: '详细信息不可用 — 无法针对此会话验证此自动化。',
            incompleteNoticeTitle: '部分自动化无法读取',
        },
    } } as const;

return { automationTriggerSetTranslations };
})();

const Domain_boardsTranslations = (() => {
type Count = Shared_boardsTranslations.Count;

type BoardsTranslations = Shared_boardsTranslations.BoardsTranslations;

const en = Shared_boardsTranslations.en;

const zhHans: BoardsTranslations = {
    title: '面板',
    newBoard: '新面板',
    defaultName: '未命名面板',
    index: {
        title: '你的面板',
        body: '面板把会话、运行、工作流和设备实时汇聚在一处，按你的方式排布。',
    },
    notFound: {
        title: '这个面板已不存在',
        body: '它已被删除，或属于此处未连接的 Home。',
    },
    meta: {
        needYou: ({ count }) => `${count} 项需要你`,
        items: ({ count }) => `${count} 项`,
        handPicked: '手动挑选',
        empty: '空',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: '需要你', description: '所有在等你处理的事项' },
        running: { title: '正在运行', description: '进行中的工作流运行' },
        my_machines: { title: '我的设备', description: '在线状态以及每台设备上运行的内容' },
        filter: { title: '会话', description: '所有活跃会话' },
    },
    header: {
        layoutA11y: '面板布局',
        canvas: '画布',
        byStatus: '按状态',
        add: '添加到面板',
        settings: '面板设置',
    },
    kinds: {
        session: '会话',
        workflow_run: '工作流运行',
        workflow: '工作流',
        machine: '设备',
    },
    card: {
        untitled: '不可用的项目',
        unavailable: '不可用',
        unavailableBody: '它的 Home 未在此设备上连接。它会保留在面板上。',
        notLoaded: '尚未加载',
        remove: '从面板移除',
        moveHint: '方向键可在网格上移动此卡片。',
        moved: ({ x, y }) => `已移动到 ${x}, ${y}`,
        moveActions: { up: '上移', down: '下移', left: '左移', right: '右移' },
        machine: {
            online: '在线',
            offline: '离线',
            running: ({ count }) => `${count} 个会话正在运行`,
            needYou: ({ count }) => `${count} 项需要你`,
            idle: '没有正在运行的会话',
            offlineBody: '它的会话会等它回来。',
        },
        workflow: {
            noRuns: '还没有运行',
            lastRun: ({ word, age }) => `上次运行 ${age} · ${word}`,
            needYou: ({ count }) => `${count} 项需要你`,
        },
        run: {
            waitingForYou: '等待你的审阅',
            started: ({ age }) => `${age}开始`,
        },
    },
    canvas: {
        snapsHere: '会吸附到这里',
        snapOnceHint: '按住 ⇧ 可单次对齐网格',
    },
    settings: {
        title: '面板设置',
        name: '名称',
        whatsOn: '此面板上有什么',
        whichSessions: '哪些会话',
        addedByHand: '手动添加',
        addedByHandNone: '暂无',
        add: '添加',
        layout: '布局',
        layoutDescription: '切换时，画布会保留你的排布。',
        snap: '吸附到网格',
        pin: '显示在会话列表中',
        pinDescription: '将此面板固定在你的会话上方。',
        delete: '删除面板',
        deleteConfirmTitle: '删除这个面板？',
        deleteConfirmBody: '只会删除面板。其中的会话、运行、工作流和设备都会保持原样。',
    },
    add: {
        title: '添加到面板',
        search: '搜索项目',
        groups: { sessions: '会话', workflows: '工作流', runs: '工作流运行', machines: '设备' },
        onBoard: '在此面板上',
        addHint: '添加',
        addAndPlaceHint: '添加并放置',
        empty: '没有匹配项。',
    },
    empty: {
        title: '选择此面板显示什么',
        body: '手动添加会话、工作流、运行或设备，或显示“需要你”这样的分区。排布由你决定，面板让它们保持实时。',
        action: '添加到面板',
    },
    widgets: {
        group: '小组件',
        kind: '小组件',
        gallery: '打开图库',
        galleryHint: '所有小组件，附实时预览',
        addHint: '面板仅你可见',
        widthOne: '一张卡片宽',
        widthTwo: '两张卡片宽',
        moveEarlier: '前移',
        moveLater: '后移',
        remove: '从面板移除',
        menuA11y: ({ widget }) => `${widget} 选项`,
        arrived: ({ count }) => `刚刚添加了 ${count} 个小组件`,
        undo: '撤销',
        dismiss: '忽略',
    },
    saveFailed: {
        tooLarge: '这个面板超出了面板存储空间的限制。请移除一些项目后重试。',
        notFound: '这个面板已在另一台设备上被删除。',
        generic: '你的更改没有同步到账户，面板保持原样。',
        retry: '重试',
        dismiss: '忽略',
        createTitle: '这个面板未创建',
    },
};

const boardsTranslations = { zhHans };

return { boardsTranslations };
})();

const Domain_browserPresenceTranslations = (() => {
type AgentParams = Shared_browserPresenceTranslations.AgentParams;

type BrowserPresenceTranslations = Shared_browserPresenceTranslations.BrowserPresenceTranslations;

const browserPresenceTranslations = { 'zh-Hans': {
        agentFallbackName: '代理',
        agentBrowsing: ({ agent }) => `${agent} 正在浏览`,
        clickTarget: ({ target }) => `正在点击“${target}”`,
        doing: {
            click: '正在点击页面',
            type: '正在输入',
            fill: '正在填写字段',
            scroll: '正在滚动',
            navigate: '正在打开页面',
            history: '正在浏览历史',
            reload: '正在重新加载页面',
            press: '正在按键',
            select: '正在选择选项',
            drag: '正在拖动',
            upload: '正在上传文件',
            look: '正在查看页面',
            other: '正在页面中操作',
        },
        takeControl: '接管控制',
        stopping: ({ agent }) => `正在停止 ${agent}…`,
        stoppingDetail: '正在完成最后一个操作',
        lastActionMayHaveLanded: ({ agent }) => `${agent}的最后一个操作可能已生效`,
        youHaveControl: '你正在控制',
        stopUnconfirmed: '无法确认已停止',
        checkAgain: '再次检查',
        pausedUntilHandBack: ({ agent }) => `在你交还控制之前，${agent} 会暂停`,
        handBack: '交还',
        stream: {
            connectingTitle: ({ agent }) => `正在连接 ${agent} 的浏览器`,
            connectingBody: ({ machine }) => `它运行在 ${machine} 上。收到第一帧后，页面会显示在这里。`,
            stalled: '显示最后一帧 · 正在重新连接',
            endedTitle: ({ agent }) => `${agent} 关闭了这个浏览器`,
            endedBody: '此页面不再在这里显示。',
            unavailableTitle: ({ agent }) => `无法在这里显示 ${agent} 的浏览器`,
            unavailableBody: ({ agent }) => `${agent} 仍在浏览；它的操作仍会显示在聊天中。`,
            tryAgain: '重试',
            inputA11y: '页面。点按、滚动或输入即可接管控制。',
        },
        recording: {
            elapsedA11y: ({ elapsed }) => `正在录制，${elapsed}`,
            discard: '丢弃录制',
        },
        openInYourBrowser: '在你的浏览器中打开',
        slowPage: '此页面加载时间较长',
    } } satisfies Pick<Record<string, BrowserPresenceTranslations>, "zh-Hans">;

return { browserPresenceTranslations };
})();

const Domain_browserToolTranslations = (() => {
type TargetParams = Shared_browserToolTranslations.TargetParams;

type BrowserToolTranslations = Shared_browserToolTranslations.BrowserToolTranslations;

const browserToolTranslations = { 'zh-Hans': {
        opened: ({ page }) => `打开了 ${page}`,
        openedPage: '打开了一个页面',
        reloaded: '重新加载了页面',
        wentBack: '返回了上一页',
        wentForward: '前进了一页',
        clicked: ({ target }) => `点击了“${target}”`,
        clickedPage: '点击了页面',
        typedInto: ({ target }) => `在“${target}”中输入`,
        typed: '在页面中输入',
        filledIn: ({ target }) => `填写了“${target}”`,
        filled: '填写了一个字段',
        pressed: ({ key }) => `按下了 ${key}`,
        pressedKey: '按下了一个键',
        scrolled: '滚动了页面',
        pointedAt: ({ target }) => `指向了“${target}”`,
        pointed: '指向了页面',
        choseIn: ({ target }) => `在“${target}”中选择了一个选项`,
        chose: '选择了一个选项',
        uploadedTo: ({ target }) => `向“${target}”上传了文件`,
        uploaded: '上传了文件',
        dragged: ({ target }) => `拖动了“${target}”`,
        draggedPage: '在页面上拖动',
        looked: '查看了页面',
        screenshot: '截取了屏幕',
        recordingStarted: '开始录制页面',
        recordingStopped: '停止了录制',
        other: '使用了浏览器',
        watch: '查看',
        watchA11y: '在浏览器中打开此页面',
    } } satisfies Pick<Record<string, BrowserToolTranslations>, "zh-Hans">;

return { browserToolTranslations };
})();

const Domain_changedFileEvidenceTranslations = (() => {
type ChangedFileEvidenceTranslations = Shared_changedFileEvidenceTranslations.ChangedFileEvidenceTranslations;

const en = Shared_changedFileEvidenceTranslations.en;

const translated = Shared_changedFileEvidenceTranslations.translated;

const changedFileEvidenceTranslations = { 'zh-Hans': {
        changedFileEvidence: translated({
            before: '变更前',
            after: '变更后',
            binary: '二进制文件',
            truncated: '证据内容已被限制；原始大小和变更统计在可用时会保留。',
            truncatedOldBytes: ({ count }) => `原始变更前内容：${count} 字节`,
            truncatedNewBytes: ({ count }) => `原始变更后内容：${count} 字节`,
            truncatedDiffBytes: ({ count }) => `原始差异：${count} 字节`,
            truncatedAddedLines: ({ count }) => `新增行数：${count}`,
            truncatedRemovedLines: ({ count }) => `删除行数：${count}`,
            kind: {
                added: '新增',
                modified: '修改',
                deleted: '删除',
                renamed: '重命名',
                copied: '复制',
                unknown: '变更类型不可用',
            },
            howDetermined: '如何判定',
            howDeterminedForFile: ({ path }) => `${path} 的判定方式`,
            content: {
                exact: '仓库的确切变更',
                strong: '有力的内容证据',
                best_effort: '尽力而为的内容证据',
            },
            attribution: {
                session_exact: '已关联到此会话',
                session_likely: '很可能由此会话更改',
                session_possible: '可能由此会话更改',
                unknown: '会话归因不可用',
            },
            reason: {
                provider_correlated: '代理报告了此轮次的该变更。',
                canonical_tool_correlated: '差异或补丁工具将该变更关联到了此轮次。',
                checkpoint_no_happier_overlap_observed: '检查点未在此进程中记录到重叠的 Happier 轮次。',
                checkpoint_overlap_observed: '另一个 Happier 轮次与检查点采集区间发生了重叠。',
                workspace_touched_path: '此路径在工作区中被改动过；这无法确定是哪个会话更改了它。',
                unavailable: '证据无法确定是哪个会话做出了此变更。',
            },
            overlap: {
                observed: '采集期间另一个 Happier 轮次与此检出发生了重叠。观测仅覆盖此进程；其他进程和外部写入方不会被跟踪。',
                not_observed: '在此进程中未观测到重叠的 Happier 轮次。其他进程和外部写入方不会被跟踪；这并不能证明独占的作者身份。',
                unknown: '检查点重叠情况未知。其他进程和外部写入方不会被跟踪。',
            },
            sources: {
                provider_native: '代理原生变更报告',
                provider_tool: '代理工具报告',
                canonical_diff_tool: '差异工具证据',
                canonical_patch_tool: '补丁工具证据',
                scm_checkpoint: '仓库检查点',
                scm_reconciled: '已核对的仓库快照',
                inferred: '工作区中被改动的路径',
            },
        }),
    } } as const;

return { changedFileEvidenceTranslations };
})();

const Domain_cliPathExposureTranslations = (() => {
const en = Shared_cliPathExposureTranslations.en;

const zhHans = {
    title: '命令行',
    footer: 'Happier Desktop 只会添加或移除它自己创建的 PATH 条目。Shell 安装脚本写入的条目不会被改动。',
    addTitle: '将 happier 添加到 PATH',
    addSubtitle: '让 happier 命令在新终端中可用。',
    removeTitle: '从 PATH 中移除 happier',
    removeSubtitle: '仅移除 Happier Desktop 添加的 PATH 条目。',
    working: '正在更新你的 shell 配置文件…',
    added: '已添加。打开新终端即可使用 happier。',
    alreadyPresent: 'happier 已经在你的 PATH 中。',
    removed: '已移除 Happier Desktop 添加的 PATH 条目。',
    nothingToRemove: 'Happier Desktop 没有添加任何 PATH 条目。',
};

const cliPathExposureTranslations = { zhHans: zhHans };

return { cliPathExposureTranslations };
})();

const Domain_cliTrustPromptTranslations = (() => {
const en = Shared_cliTrustPromptTranslations.en;

const zhHans = {
    title: '要批准此命令行吗？',
    body: ({ command }: { command: string }) => `${command} 处的命令行不是 Happier 安装的。批准后它可以读写此账户的会话。请仅批准你自己放在那里的程序。`,
    bodyUnknownCommand: '此命令行不是 Happier 安装的。批准后它可以读写此账户的会话。请仅批准你自己放在那里的程序。',
    approve: '批准',
};

const cliTrustPromptTranslations = { zhHans: zhHans };

return { cliTrustPromptTranslations };
})();

const Domain_commitProposalTranslations = (() => {
type Count = Shared_commitProposalTranslations.Count;

type CommitProposalCopy = Shared_commitProposalTranslations.CommitProposalCopy;

const en = Shared_commitProposalTranslations.en;

const commitProposalTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', { commitProposal: CommitProposalCopy }>>, "zh-Hans"> = { 'zh-Hans': { commitProposal: {
        title: ({ count }) => `为待提交更改准备的 ${count} 个提交`,
        titlePhone: ({ count }) => `${count} 个提交`,
        proposedBy: ({ who, committed, total }) => `由 ${who} 提议 · ${total} 个文件中的 ${committed} 个 · 按顺序排列，每个提交都基于上一个。`,
        proposedByPhone: ({ committed, total }) => `${total} 个待提交文件中的 ${committed} 个 · 轻点更改即可移动。`,
        moveHint: ({ max }) => `使用 ⌥1–${max} 或菜单移动任意更改。`,
        modelFallback: '模型',
        regenerate: '重新生成',
        conflict: '提议已在其他地方更改。这是最新版本；请再次进行更改。',
        approvalPending: '正在等待批准以创建这些提交。',
        discardBody: '将移除此提议。你的待提交更改保持不变。', askFix: ({ hook, number, message }) => `${hook} 钩子阻止了提交 ${number}“${message}”。请修复它报告的问题，让提交能够通过：`, askFixGeneric: ({ number, message }) => `一个钩子阻止了提交 ${number}“${message}”。请修复它报告的问题，让提交能够通过：`, discarded: '已放弃提议。', undo: '撤销',
        fileCount: ({ count }) => `${count} 个文件`,
        part: ({ count, of }) => `${of} 处更改中的 ${count} 处`,
        move: { a11y: ({ file }) => `将 ${file} 移到其他提交`, title: ({ file }) => `将 ${file} 移到`, newCommitAfter: ({ number }) => `在 ${number} 之后新建提交`, newCommitMessage: ({ file }) => `更新 ${file}`, leaveOut: '不放入这些提交', leaveOutHint: '保留在工作树中' },
        group: { a11y: ({ number, message }) => `提交 ${number}：${message}`, editMessage: '编辑消息', messageA11y: ({ number }) => `提交 ${number} 的消息`, more: '更多', moveUp: '上移', moveDown: '下移', mergeWithNext: '与下一个提交合并', empty: '还没有更改。把一处更改移到这里，或与下一个提交合并。' },
        leftOut: { title: '未放入 · 保留在工作树中', description: '这些更改仍待提交。如有需要，请单独提交。' },
        footer: { commits: ({ count }) => `${count} 个提交`, onBranch: ({ branch }) => `，位于 ${branch} · 钩子和签名与任何提交一样运行`, detached: '，位于分离的 HEAD · 钩子和签名与任何提交一样运行', phone: '钩子和签名照常运行', discard: '放弃提议', create: ({ count }) => `创建 ${count} 个提交`, createShort: ({ count }) => `创建 ${count} 个`, emptyGroupReason: '有一个提交没有更改。请把更改移入或将其合并。' },
        applying: { title: ({ count }) => `正在创建 ${count} 个提交`, body: '通过常规提交流程逐个创建，钩子和签名照常运行。完成前暂停编辑。', bodyPhone: '完成前暂停编辑。', created: ({ landed, total }) => `${total} 个中的 ${landed} 个`, createdRest: '已创建 · 后续提交停止时不会回滚任何内容', createdRestPhone: '已创建', stopAfterThis: '此提交后停止', stopAfterThisShort: '此后停止', stopping: '将在此提交后停止' },
        state: { waiting: '等待中', writing: '正在运行钩子并创建提交', landed: '已提交', landedAt: ({ time }) => `已于 ${time} 提交`, signed: '已签名', pausedBy: ({ hook, count }) => `${hook} 更改了 ${count} 个文件 · 尚未提交`, hookFailedBy: ({ hook }) => `${hook} 失败 · 未提交`, rewritten: '钩子改写了消息', notCreated: '未创建 · 仍可编辑', notCreatedShort: '未创建', unknown: '尚未确认', paused: ({ count }) => `钩子更改了 ${count} 个文件 · 尚未提交`, failed: '在此停止 · 未提交' },
        outcome: { signingTitle: '目前无法为你的提交签名。', signingBody: '此仓库会为每个提交签名。尚未提交任何内容。', signingHint: '请先解锁 GPG 或 SSH 代理', tryAgain: '重试', cancel: '取消', hookChanged: ({ files }) => `钩子更改了 ${files}。`, waitsAfterLanded: ({ count }) => `已完成 ${count} 个提交；这个在等你。`, waits: '这个在等你。', include: '包含钩子的更改', includePhone: '包含并提交', cancelCommit: '取消此提交', hookFailed: '钩子阻止了此提交。', hookChangedBy: ({ hook, files }) => `${hook} 更改了 ${files}。`, hookFailedBy: ({ hook }) => `${hook} 阻止了此提交。`, hookFailedBody: '之前的提交保留。其余仍可编辑。', headMoved: ({ branch }) => `提交期间 ${branch} 发生了移动。`, headMovedBody: '下一个提交被拒绝，没有回滚任何内容。', proposeAgain: '为剩余内容重新提议', keepEditing: '继续编辑', askSessionToFix: '让此会话修复', showInGit: '在 Git 中显示', unknownTitle: '无法确认此提交是否已完成。', unknownBody: '确认之前不会重试。请再次检查分支。', checkAgain: '再次检查', stoppedTitle: ({ landed, total }) => `已创建 ${total} 个中的 ${landed} 个提交`, stoppedBody: ({ count }) => `${count} 个未创建。它们的更改仍和之前一样在你的工作树中。`, createRest: ({ count }) => `创建剩余 ${count} 个`, completeTitle: ({ count }) => `已创建 ${count} 个提交`, completeBody: '没有推送任何内容。', onBranch: ({ branch }) => `位于 ${branch}`, failed: { staging_conflict: '其他操作更改了暂存内容。', selection_conflict: '这些更改无法这样拆分。', source_changed: '提议之后待提交更改发生了变化。', writer_failed: '无法创建提交。', publication_warning: '提交已完成，但暂存文件未更新。', cancelled: '此提交已取消。' }, failedBody: '之前的提交保留。没有回滚任何内容。' },
        none: { title: '还没有提交提议', reason: '提议会将你的待提交更改分组为可编辑的提交，然后通过常规提交流程逐个创建。', propose: '提议提交', writing: '正在分组你的待提交更改…' },
        gitPane: { title: '提议的提交', meta: ({ count, files }) => `${count} · ${files} 个文件`, inCommit: ({ count, number }) => `提交 ${number} 中 ${count} 个`, open: '打开', review: '查看', reviewInWalkthrough: '在导读中查看', more: '放弃或重新生成', selectedHint: '已选中。再次轻点可在提交中打开', tapHint: '轻点查看其更改' },
    } } };

return { commitProposalTranslations };
})();

const Domain_committedMessageActionTranslations = (() => {
const committedMessageActionTranslations = { "zh-Hans": {
        "committedMessageActions": {
            "copy": "复制",
            "fork": "分支",
            "rollback": "回滚",
            "pin": "置顶",
            "savePrompt": "保存为提示词",
            "plugins": "插件操作",
            "composerButton": "提示词库按钮",
            "composerHint": "在听写旁打开你保存的提示词和发送过的内容。关闭后，/ 菜单仍提供“提示词…”。",
            "name": "名称",
            "shortcut": "/ 快捷命令",
            "savedOpen": "已保存到提示词库 · 打开",
            "shortcutNotSaved": "提示词已保存，但快捷命令未能保存。请在提示词库中打开并添加快捷命令。",
            "wrongAccount": "保存提示词前，请切换到此会话的 Home。",
            "savedHintFavorite": "保存到你的库并加星标。",
            "savedHint": "保存到你的库。",
            "addShortcut": "添加 / 快捷方式",
            "shortcutPlaceholder": "/shortcut",
            "savedToLibrary": "已保存到库",
            "savePromptHint": "可从提示词库再次使用",
            "copyHint": "复制消息的文本。",
            "forkHint": "从某条消息开始新会话。",
            "rollbackHint": "将工作区恢复到某条消息之前的状态。",
            "pinHint": "固定消息以便回看。已固定的消息保持固定。",
            "savePromptSettingHint": "将你发送的消息保存为库中的提示词。",
            "pluginsHint": "插件在消息下方添加的操作。"
        }
    } };

return { committedMessageActionTranslations };
})();

const Domain_computerUseTranslations = (() => {
type MachineParams = Shared_computerUseTranslations.MachineParams;

type ComputerUseTranslations = Shared_computerUseTranslations.ComputerUseTranslations;

const computerUseTranslations = { 'zh-Hans': {
        approval: {
            sectionTitle: '在电脑上',
            act: {
                list: '查看打开了哪些窗口',
                see: '截图',
                read: '读取文字和控件',
                click: '点击',
                press: '按键',
                type: '输入',
                share: '共享一个窗口',
            },
            windowOn: ({ machine }) => `${machine} 上的一个窗口`,
            screenOf: ({ machine }) => `${machine} 的整个屏幕`,
            windowsOn: ({ machine }) => `${machine} 上打开的窗口`,
            window: '一个窗口',
            screen: '整个屏幕',
            windows: '打开的窗口',
            typedLabel: '文字',
            keyLabel: '按键',
            listConsequence: '只共享打开的窗口名称，不共享其中的内容。',
            seeConsequence: '截图会共享到此会话。不会点击或输入。',
            useConsequence: '已送达这台机器的输入无法撤销。你可以随时停止。',
            targetOn: ({ machine, target }) => `${machine} 上的 ${target}`,
            chooseFirst: '请先选择窗口',
            cropA11y: ({ target }) => `${target} 的最新画面`,
            suggestsWindow: ({ agent, target }) => `${agent} 建议“${target}”`,
        },
        request: {
            title: ({ agent, machine }) => `${agent} 想使用 ${machine} 上的一个窗口`,
            body: '窗口由你选择。在你选择之前不会共享任何内容。',
            choose: '选择窗口',
            change: '更换窗口',
            shared: ({ target }) => `已共享 ${target}`,
            watch: '查看',
        },
        picker: {
            title: ({ agent }) => `让 ${agent} 使用一个窗口`,
            description: ({ agent }) => `你选择与 ${agent} 共享的内容。`,
            windows: '窗口',
            screens: '整个屏幕',
            untitledWindow: '无标题窗口',
            screenLabel: ({ index }) => `屏幕 ${index}`,
            share: '共享窗口',
            shareScreen: '共享屏幕',
            shareApp: ({ app }) => `共享 ${app} 窗口`,
            stopSharing: '停止共享',
            loadingTitle: ({ machine }) => `正在查找 ${machine} 上的窗口`,
            noScreenTitle: ({ machine }) => `${machine} 没有可共享的屏幕`,
            noScreenBody: '它在没有 Happier 可见桌面的情况下运行。请使用有屏幕的机器。',
            unsupportedTitle: ({ machine }) => `Happier 暂时还不能使用 ${machine} 的屏幕`,
            unsupportedBody: '目前共享窗口适用于 Linux 桌面。',
            failedTitle: ({ machine }) => `无法列出 ${machine} 上的窗口`,
            failedBody: '请确认 Happier 正在那里运行，然后重试。',
            emptyTitle: ({ machine }) => `${machine} 上没有打开的窗口`,
            emptyBody: '打开你要共享的窗口，然后再检查一次。',
            tryAgain: '重试',
            inUse: '另一个会话正在使用这个窗口。请选择其他窗口。',
            closed: '该窗口已关闭。请选择其他窗口。',
            selectFailed: '无法共享该窗口。请重试。',
            otherMachineTitle: ({ machine }) => `${machine} 不是此会话所在的机器`,
            otherMachineBody: '只能共享此会话所在机器上的窗口。',
            purpose: ({ session }) => `用于“${session}”。`,
            purposeIn: ({ project, session }) => `用于 ${project} 中的“${session}”。`,
            access: ({ agent }) => `${agent} 可以`,
            accessValue: '查看并使用',
            accessSee: '仅查看',
            displayUnavailable: '此电脑无法共享整个显示屏。',
            policyBoth: ({ agent }) => `${agent} 每次截图、点按和按键前都会询问。`,
            policyInput: ({ agent }) => `${agent} 每次点按和按键前都会询问。`,
            policyCapture: ({ agent }) => `${agent} 每次截图前都会询问。`,
            policyNone: ({ agent }) => `${agent} 截图、点按和按键前不会询问。`,
            policyChange: '更改',
            suggests: ({ agent }) => `${agent} 建议`,
        },
        permission: {
            title: ({ machine }) => `${machine} 需要先获得你的许可`,
            body: '你在那台电脑的系统设置中允许后，Happier 才能查看和使用窗口。',
            capture: '屏幕录制',
            captureHint: '用于查看窗口',
            input: '辅助功能',
            inputHint: '用于点按和输入',
            allowed: '已允许',
            denied: '未允许',
            unknown: '未检查',
            open: ({ machine }) => `在 ${machine} 上打开系统设置`,
            opened: ({ machine }) => `已在 ${machine} 上打开。请在那里允许 Happier，然后再检查一次。`,
            openFailed: '无法在那里打开系统设置。请在那台电脑上打开。',
            checkAgain: '再次检查',
        },
        viewer: {
            agentUsing: ({ agent, target }) => `${agent} 正在使用 ${target}`,
            agentCanUse: ({ agent, target }) => `${agent} 可以使用 ${target}`,
            agentCanSee: ({ agent, target }) => `${agent} 可以查看 ${target}`,
            onMachine: ({ machine }) => `在 ${machine} 上`,
            connectingTitle: ({ target }) => `正在连接 ${target}`,
            connectingBody: ({ machine }) => `${machine} 的第一帧画面到达后，窗口会显示在这里。`,
            unavailableTitle: '现在无法显示这个窗口',
            unavailableBody: ({ agent }) => `你仍然可以在这里停止 ${agent}。`,
            endedTitle: ({ target }) => `${target} 已关闭`,
            endedBody: ({ agent }) => `${agent} 不能再查看或使用它。请选择其他窗口以继续。`,
            stalled: '正在显示最后一帧 · 正在重新连接',
            inputA11y: ({ target }) => `${target}，实时画面。点按或输入即可接管控制。`,
            notSharedTitle: '没有共享的窗口',
            notSharedBody: ({ agent }) => `选择一个窗口让 ${agent} 使用。`,
            moreA11y: '窗口选项',
            tabFallback: '电脑',
        },
        strip: {
            using: ({ target }) => `正在使用 ${target}`,
            on: ({ machine }) => `在 ${machine} 上`,
            stop: '停止',
            paused: ({ agent }) => `${agent} 已暂停`,
            pausedDetail: ({ target }) => `你正在控制 ${target}`,
        },
        tool: {
            capture: '已截图',
            captureRunning: '正在截图',
            query: '已读取窗口的文字和控件',
            queryRunning: '正在读取窗口',
            click: '已在窗口中点按',
            clickRunning: '正在窗口中点按',
            clickTarget: ({ target }) => `点按了“${target}”`,
            type: '已在窗口中输入',
            typeRunning: '正在窗口中输入',
            typeTarget: ({ target }) => `在“${target}”中输入`,
            pressKey: ({ key }) => `已按下 ${key}`,
            press: '已按下一个键',
            pressRunning: '正在按键',
            mayHaveLanded: '可能已生效',
            failed: '未完成',
        },
    } } satisfies Pick<Record<string, ComputerUseTranslations>, "zh-Hans">;

return { computerUseTranslations };
})();

const Domain_connectedServicesCollectionTranslations = (() => {
type ConnectedServicesCollectionCopy = Shared_connectedServicesCollectionTranslations.ConnectedServicesCollectionCopy;

const en = Shared_connectedServicesCollectionTranslations.en;

const zhHans: ConnectedServicesCollectionCopy = {
    accountLabel: ({ service }) => `${service} 账户`,
    meterResetsIn: ({ time }) => `${time}后`,
    meterNextResetIn: ({ time }) => `下次在${time}后`,
    meterResetsAt: ({ countdown, time }) => `${countdown} · ${time}`,
    meterNotReported: '未报告',
    meterEstimated: ({ value }) => `~${value}`,
    indexTitle: '所有服务',
    indexDescription: '你的代理用来登录的账户，以及每个账户还剩多少。',
    viewList: '列表',
    viewGrid: '网格',
    viewLabel: '账户显示方式',
    refreshAll: '全部刷新',
    refreshUsage: '刷新用量',
    signedOutConsequence: '重新登录前，会话无法使用它。',
    poolsGroup: '账户池',
    poolsDescription: '代理在其间切换的账户。会话开始时池选择一个，用完后换下一个。',
    newPool: '新建账户池',
    poolUsing: ({ account }) => `正在使用 ${account}`,
    poolPosition: ({ position, count }) => `第 ${position} 个，共 ${count} 个`,
    poolInUseNow: '正在使用',
    inUse: '使用中',
    connectService: '连接服务',
    searchAccounts: '搜索账户',
    servicesGroup: '服务',
    railEmpty: '还没有账户',
    railKey: '密钥',
    railAccountLabel: ({ service, account }) => `${service} · ${account}`,
    agentSignInTitle: '代理如何登录',
    subscriptionTitle: '订阅',
    subscriptionNone: '没有订阅',
    subscriptionRenewsIn: ({ days }) => days === 0 ? '今天续订' : `${days} 天后续订`,
    subscriptionEndsIn: ({ days }) => days === 0 ? '不再续订 · 今天结束' : `不再续订 · ${days} 天后结束`,
    subscriptionPeriodEndsIn: ({ days }) => days === 0 ? '本期今天结束' : `本期 ${days} 天后结束`,
    subscriptionRenewsOn: ({ date, days }) => `${date} 续订 · ${days} 天后`,
    subscriptionEndsOn: ({ date, days }) => `不再续订 · ${date}（${days} 天后）结束，之后会话将停止使用它。`,
    subscriptionPeriodEndsOn: ({ date, days }) => `本期 ${date} 结束 · ${days} 天后`,
    renewalOn: '开启',
    renewalOff: '关闭',
    renewalUnknown: '未知',
    checkedAt: ({ time }) => `${time} 检查`,
    checkedMayBeOutOfDate: ({ time }) => `${time} 检查 · 可能已过时`,
    usageCheckedMayBeOutOfDate: ({ time }) => `${time} 检查 · 可能已过时`,
    daysAgo: ({ count }) => `${count} 天前`,
    hoursAgo: ({ count }) => `${count} 小时前`,
    usageResetsCount: ({ count }) => `${count} 次用量重置`,
    usageResetsFirstExpires: ({ date }) => `最早 ${date} 过期`,
    usageResetExpires: ({ date }) => `${date} 过期`,
    useOne: '使用一次',
    useOneReset: '使用一次用量重置',
    usageResetsTitle: '用量重置',
    usageResetsDescription: '每次都会立即开启新的窗口。留到被限额挡住时再用；未使用的会过期。',
    usageResetTitle: '用量重置',
    usageResetExpiresOn: ({ date }) => `${date} 过期`,
    use: '使用',
    usedByDefault: '默认 · 新会话使用此账户',
    accountIdFact: ({ id }) => `ID ${id}`,
    hideIdentitiesTitle: '隐藏账户邮箱和 ID',
    hideIdentitiesDescription: '用于直播和演示。在此设备上处处遮盖邮箱和账户 ID；你为账户起的名字保持不变。',
    privacyTitle: '隐私',
    renameTitle: '为此账户命名',
    renameBody: ({ service }) => `只会更改 Happier 中的名称。${service} 仍保留该账户自己的名称。`,
    identityHidden: '邮箱或 ID 已隐藏',
};

const connectedServicesCollectionTranslations = { zhHans };

return { connectedServicesCollectionTranslations };
})();

const Domain_connectedServicesPoolTranslations = (() => {
type ConnectedServicesPoolCopy = Shared_connectedServicesPoolTranslations.ConnectedServicesPoolCopy;

const en = Shared_connectedServicesPoolTranslations.en;

const zhHans: ConnectedServicesPoolCopy = {
    strategyExpiryFirst: "即将到期优先",
    strategyExpiryFirstDescription: "优先选择额度充足且长期额度重置或不续订的订阅结束时间更近的账号。",
    leadExpiryFirst: "即将到期优先。",
    membersOn: ({ service, on, total }) => `${service} · ${total} 个成员中 ${on} 个已开启`,
    rename: '重命名',
    moreActions: '更多操作',
    defaultFor: ({ agent }) => `${agent} 的默认`,
    defaultForMore: ({ agent, count }) => `${agent} 的默认 +${count}`,
    makeDefault: '设为默认',
    makeDefaultA11y: '设为某个智能体的默认',
    usingSince: ({ name, time }) => `自 ${time} 起使用 ${name}`,
    using: ({ name }) => `正在使用 ${name}`,
    noActive: '还没有成员在使用',
    noActiveDetail: '会话开始时，池会选择一个。',
    leadLeastLimited: '剩余最多的优先。',
    leadInOrder: '按顺序。',
    fallbackOff: ({ name }) => `自动切换已关闭，${name} 用完后会话仍留在它上面。`,
    manualStays: ({ name }) => `手动：在你选择其他成员之前，池会一直使用 ${name}。`,
    switchTo: ({ name }) => `切换到 ${name}`,
    onlyOneOn: ({ name }) => `只有 ${name} 已开启，因此没有可切换的对象。`,
    turnOn: ({ name }) => `开启 ${name}`,
    allWaitingTitle: '所有成员都在等待重置',
    allWaitingFirst: ({ name, time, countdown }) => `${name} 最先重置，时间 ${time}（${countdown}）。`,
    sessionsWait: '会话会等待，然后自动继续。',
    sessionsStop: '在有成员有余量之前，会话会停止。',
    leftTitle: '池内剩余',
    leftDescription: '已开启成员的平均值；各自独立重置。',
    roomCount: ({ count, total }) => `${total} 个中有 ${count} 个现在有余量`,
    notReported: ({ count }) => `${count} 个未报告`,
    nothingReported: '已开启的成员还没有报告限额。',
    membersTitle: '成员',
    membersDescription: '拖动以设置顺序。选中的成员为当前成员；关闭的成员会被跳过。',
    membersCompactDescription: '长按并拖动以重新排序。',
    manage: '管理',
    connectAnotherAccount: ({ service }) => `连接另一个${service}账户`,
    membersSelectionSummary: ({ count, total, service }) => `${total}个${service}账户中的${count}个`,
    manageMembers: '管理成员',
    searchAccounts: ({ service }) => `搜索 ${service} 账户`,
    active: '当前',
    offNotUsed: '关闭期间池不会使用它',
    autoOffModel: '已自动关闭 · 此套餐无法使用所选模型',
    checkedAt: ({ time }) => `检查于 ${time}`,
    makeActiveA11y: ({ name }) => `将 ${name} 设为当前成员`,
    memberOnA11y: ({ name }) => `在此池中使用 ${name}`,
    openA11y: ({ name }) => `打开 ${name}`,
    dragA11y: '拖动以重新排序',
    behaviorTitle: '行为',
    strategyTitle: '选择策略',
    strategyLeastLimited: '限制最少',
    strategyInOrder: '按顺序',
    strategyManual: '手动',
    strategyLeastLimitedDescription: '优先使用可用额度最多的成员。',
    strategyInOrderDescription: '按上面的顺序尝试成员。',
    strategyManualDescription: '在你更改之前只使用当前成员。',
    fallbackTitle: '自动切换',
    fallbackDescription: '当前账户需要恢复时切换到其他成员。',
    switchEarlyTitle: '提前切换',
    switchEarlyDescription: '剩余低于此百分比时，池会切换到额度更新的成员。0 表示关闭。',
    autoResetsTitle: '自动使用额度重置',
    autoResetsDescription: '只在没有成员可用时使用储存的重置。',
    autoOffTitle: '关闭无法使用所选模型的账户',
    autoOffDescription: '你可以自行重新开启。',
    advancedTitle: '高级',
    advancedCount: ({ count }) => `${count} 项设置`,
    restoreFirstTitle: '重置后回到第一个成员',
    restoreFirstDescription: '切换后，在排在首位的成员限额重置时回到它。',
    switchWhenTitle: '切换时机',
    switchWhenDescription: '使池切换到下一个成员的事件。',
    staleAfterTitle: '在此之后检查过期用量',
    staleAfterDescription: '分钟。选择成员前，若用量早于此时间则重新询问提供方。',
    switchesPerTurnTitle: '每轮自动切换次数',
    switchesPerHourTitle: '每会话小时自动切换次数',
    switchLimitsDescription: '防止池在成员之间来回切换。',
    recoveryTitle: '当限额使会话停止时',
    recoveryDescription: '池如何处理等待中的会话。',
    recoveryPromptsTitle: '恢复消息',
    recoveryPromptsDescription: '切换或重置后恢复会话时，Happier 会发送其标准消息。',
    usedByTitle: '使用者',
    usedByDefault: '默认 · 新会话通过此池登录',
    usedByNone: '还没有智能体默认通过此池登录。',
    deleteNote: ({ agents }) => `成员保持连接。在你选择其他默认前，${agents} 会恢复使用自己的登录。`,
    deleteNoteNoAgent: '成员保持连接。',
    emptyTitle: '添加要切换的账户',
    emptyReason: ({ service }) => `池会在会话开始时选择一个账户，用完后切换。请至少添加两个 ${service} 账户。`,
    usageNotAnswering: ({ service }) => `${service} 没有响应`,
    newPoolTitle: '新建池',
    newPoolDescription: ({ service }) => `智能体在其间切换的 ${service} 账户。`,
    nameTitle: '名称',
    namePlaceholder: '工作池',
    draftMembersDescription: '选择要切换的账户。之后可以更改。',
    create: '创建池',
    discard: '放弃',
};

const connectedServicesPoolTranslations = { zhHans };

return { connectedServicesPoolTranslations };
})();

const Domain_connectedServicesSettingsTranslations = (() => {
type ConnectedServicesSettingsCopy = Shared_connectedServicesSettingsTranslations.ConnectedServicesSettingsCopy;

const setupFidelityCopy = Shared_connectedServicesSettingsTranslations.setupFidelityCopy;

const en = Shared_connectedServicesSettingsTranslations.en;

const zhHans: ConnectedServicesSettingsCopy = {
    ...setupFidelityCopy,
    accountCount: ({ count }) => `${count} 个账号`,
    defaultAccount: ({ name }) => `默认：${name}`,
    poolCount: ({ count }) => `${count} 个账号池`,
    noAccountsYet: '还没有账号',
    needsSignIn: '需要登录',
    signInAgain: '重新登录',
    addAccount: '添加账号',
    connectAnotherTitle: '连接其他服务',
    connectFirstTitle: '连接服务',
    connectNames: ({ names }) => `${names}。`,
    connectNamesMore: ({ names, count }) => `${names} 等另外 ${count} 个。`,
    connect: '连接',
    emptyTitle: '还没有可连接的服务',
    servicesTitle: '服务',
    emptyNoServiceOnMachine: ({ machine }: { machine: string }) => `${machine} 上的代理还没有提供可用于登录的服务。使用订阅的代理会在这里添加自己的服务。`,
    emptyNoMachineOnline: '你的机器都不在线。有机器在线时，会显示它运行的代理提供的服务。',
    emptyOpenAgents: '打开代理',
    emptyAction: '打开机器',
    projectionErrorTitle: '无法从你的机器加载服务',
    projectionErrorDescription: '你的账号仍会列出。可添加的服务会在机器响应后出现。',
    loadingServices: '正在你的机器上查找服务…',
    usageTitle: '账号的使用方式',
    usageDescription: '每个代理在会话开始时使用哪个账号登录，以及会话之间共享什么。',
    sharingTitle: '状态共享',
    sharingSummary: ({ config, state }) => `${config} · ${state}`,
    configLinkedShort: '链接',
    configCopiedShort: '复制',
    configIsolatedShort: '隔离',
    stateSharedShort: '会话共享',
    stateIsolatedShort: '会话分开',
    perAgentTitle: '按代理共享',
    perAgentDescription: '为某个代理覆盖这些默认设置。',
    perAgentPurpose: '按代理选择已连接账号的会话与你自己的登录共享哪些内容。',
    servicePurpose: ({ service }) => `你用来登录 ${service} 的账号，以及共享它们的账号池。`,
    chooseMachineTitle: '选择一台机器',
    chooseMachineDescription: '添加、登录和移除账号都在你的某台机器上进行。你的账号仍会列在“已连接服务”中。',
    newAccountTitle: '新账号',
    newAccountDescription: '选择登录方式。',
    newAccountInProgress: '请在下方完成登录。',
    modeBrowser: '使用浏览器登录',
    modeDeviceCode: '使用代码登录',
    modeManual: '输入令牌',
    serviceSettingsTitle: '服务设置',
    serviceSettingsDescription: '此服务的每个账号登录时使用的设置。',
    noAccountsDescription: '添加一个账号，让你的代理可以用它登录。',
    accountDetailsTitle: '账号详情',
    poolEmptyTitle: '向此账号池添加账号',
    poolEmptyDescription: '当一个账号达到限额时，账号池会把会话转到下一个账号。请在下方选择它的账号。',
    agentDefaultsTitle: '每个代理的默认账号',
    agentDefaultsDescription: '每个代理在会话开始时用于登录的账号。',
    agentDefaultsKeywords: '默认账号',
    namesAnd: ({ names, last }) => `${names}和${last}`,
    usedBy: ({ names }) => `${names} 使用`,
    poolRuleMostLeft: '使用剩余最多的那个',
    poolRuleInOrder: '按顺序使用',
    poolRuleManual: '由你手动切换',
    poolInUse: ({ pool }) => `${pool} · 使用中`,
    agentDefault: ({ agent }) => `${agent} 默认`,
    signedOutBy: ({ service }) => `已被 ${service} 退出登录`,
    usageReadFailed: '无法读取用量',
    usageWindowPin: ({ meter }: { meter: string }) => `在输入框旁显示 ${meter}`,
    noLimitsBilledPerUse: '未报告限额 · 按用量计费',
    needsYouCount: ({ count }) => `${count} 个需要你处理`,
    connectToolsTitle: '连接代码托管或工具',
    inviteTitle: ({ names }) => `你的代理还可以使用 ${names}`,
    inviteWhoOne: ({ agents }) => `${agents} 可以用它登录。`,
    inviteWhoMany: ({ agents }) => `${agents} 可以用它们登录。`,
    inviteTools: '或者连接代码托管和工具。',
    firstRunTitle: '用上你已付费的套餐',
    firstRunPromise: '只需连接一次 Claude 或 ChatGPT 账户。你的代理在每台机器上都能使用它，Happier 会在你达到限额前显示剩余用量。',
    connectAnAccount: '连接账户',
    firstRunMeanwhile: '在此之前，每个代理在每台机器上使用自己的登录。',
    agentAccountsTitle: '代理账户',
    agentAccountsDescription: '你的代理使用的订阅和密钥。保存在你的账户中，每台机器都能使用。',
    codeAndToolsTitle: '代码与工具',
    setupChooseMachine: '选择一台机器来登录。之后该账户可在你所有的机器上使用。',
    setupHowToSignIn: '登录方式',
    setupRecommendedMethod: ({ method }) => `${method} · 推荐`,
    setupCatalogTitle: '连接服务',
    setupCatalogPurpose: '登录在你选择的机器上进行。之后该账户可在你所有的机器上使用。',
    setupServiceTitle: ({ service }) => `连接 ${service}`,
    setupReconnectTitle: ({ service }) => `重新登录 ${service}`,
    setupServicePurpose: ({ agents, service }) => `${agents} 将在每台机器上使用你的 ${service} 账户。`,
    setupServicePurposeNoAgents: '该账户可在每台机器上使用。',
    setupForYourAgents: '适用于你的代理',
    setupOwnLoginTitle: '已在机器上登录？',
    setupOwnLoginBody: '继续使用代理自己的登录。在“账户的使用方式”中选择。',
    setupToolsTitle: '代码托管和工具',
    setupProvidersPointer: 'OpenRouter、Ollama 等模型提供方在“提供方”中设置。',
    setupOpenProviders: '打开提供方',
    setupTrust: '保存在你的账户中，仅供你的机器使用。Happier 会为你保持登录有效。',
    setupConnectedCount: ({ count }) => `已连接 ${count} 个`,
    settleConnectedAs: ({ identity }) => `刚刚以 ${identity} 连接。`,
    settleConnected: '刚刚已连接。',
    settleUseFor: ({ agent }) => `用于 ${agent}？`,
    settleUseForAction: ({ agent }) => `用于 ${agent}`,
    notNow: '暂不',
    homeInvitePromise: '只需连接一次 Claude 或 ChatGPT。每台机器都能使用，并且你可以在这里看到剩余用量。',
    homeInviteHide: '隐藏',
    homeNextWho: ({ agents }) => `${agents} 也可以使用`,
    oauthStepOpen: '在浏览器中打开登录页面',
    oauthStepApprove: '批准后，复制页面显示的代码（或跳转到的地址）',
    oauthStepPaste: '粘贴到这里',
    oauthPastePlaceholder: '粘贴代码或地址',
    oauthShapeOk: '看起来是登录代码',
    deviceEnterAt: ({ where }) => `在 ${where} 输入此代码`,
    deviceExpired: '代码已过期，未保存任何内容。',
    deviceExpiresIn: ({ time }) => `代码将在 ${time} 后过期`,
    deviceNewCode: '获取新代码',
    detailSignedOutTitle: ({ service }) => `${service} 已将此账户退出登录`,
    detailSignedOutBody: '登录已被撤销或更改（例如修改了密码）。在你重新登录之前，会话无法使用此账户。',
    detailSignInTitle: '登录',
    detailSignInNeeded: '需要重新登录',
    detailSignInKeptFresh: 'Happier 会保持其有效',
    detailLastUsed: ({ time }) => `上次使用 ${time}`,
    detailLeavePool: ({ pool }) => `从 ${pool} 移除…`,
    detailRemovePooledNote: ({ pool }) => `${pool} 正在使用此账户，请先将其从账户池中移除。移除会将其从你的账户和所有机器上删除。`,
    detailUsageSignedOut: '上次已知 · 退出登录时无法刷新',
    detailUsageSignedOutAt: ({ time }: { time: string }) => `上次已知时间 ${time} · 退出登录时无法刷新`,
    detailResetsIn: ({ countdown }) => `${countdown} 后`,
    detailUsedByTitle: '使用者',
    detailUsedByDefault: '其默认账户',
    detailUsedByPool: ({ pool }) => `通过 ${pool}`,
    detailUsedByPoolInUse: ({ pool }) => `通过 ${pool} · 正在使用`,
    detailUsedByCould: '可以使用 · 目前以其他方式登录',
    detailWorksOnTitle: '可用于',
    detailWorksOnDescription: '保存在你的账户中。机器会在其上启动会话时使用，不会预先复制。',
    detailSignedInWithCode: '已通过代码登录',
    detailSignedInWithBrowser: '已通过浏览器登录',
    detailAddedWithKey: '已通过密钥添加',
    nearLimitTitle: ({ account, percent, window }) => `${account} 的 ${window} 限额还剩 ${percent}%`,
    nearLimitTitleNoAccount: ({ percent, window }) => `${window} 限额还剩 ${percent}%`,
    nearLimitBodyWithReset: ({ time }) => `将在 ${time} 重置。应用一次用量重置即可立即继续。`,
    nearLimitBody: '应用一次用量重置即可立即继续。',
    nearLimitApplyReset: '应用用量重置',
    catalogSignInBrowserOrCode: '通过浏览器或代码登录',
    catalogSignInBrowserOrKey: '通过浏览器登录或粘贴令牌',
    catalogSignInBrowser: '通过浏览器登录',
    catalogSignInCode: '通过代码登录',
    catalogPasteKey: '粘贴密钥',
    deviceOpenService: ({ service }) => `打开 ${service}`,
    deviceWaitingFor: ({ service }) => `等待你在 ${service} 中批准…`,
};

const connectedServicesSettingsTranslations = { zhHans };

return { connectedServicesSettingsTranslations };
})();

const Domain_connectedServicesSetupTranslations = (() => {
type ConnectedServicesSetupTranslation = Shared_connectedServicesSetupTranslations.ConnectedServicesSetupTranslation;

const connectedServicesSetupTranslations = { 'zh-Hans': {
        connectMoreTitle: '连接更多',
        connectMoreDescription: '你的机器上的代理可以使用、但你尚未连接的服务。',
        connectMoreNothingNew: '添加另一个账号、代码托管平台或工具。',
        serviceSignInInstead: ({ agents }) => `${agents} 可以用它登录，而不必在每台机器上单独登录。`,
        serviceCanUse: ({ agents }) => `${agents} 可以使用它。`,
        moreServicesTitle: '更多服务',
        moreServicesTools: ({ names }) => `${names} 等，用于代码和工具。`,
        moreServicesAll: '你的代理和工具可以使用的一切。',
        browse: '浏览',
        notNow: ({ service }) => `暂不：${service}`,
        notNowTooltip: '暂不 · 仍可在浏览中找到',
        back: '所有服务',
        homeCatalogTitle: '连接账号',
        homeCatalogPurpose: '你的代理会在每台机器上使用它，Home 会显示剩余额度。',
        homeNextSubtitle: ({ agents }) => `${agents} 可以使用它，而不必在每台机器上单独登录。`,
        firstRunMore: 'API 密钥、代码托管和工具',
        settleAddToPoolWhy: ({ pool, agent, active }) => `将它加入 ${pool}，让 ${agent} 在 ${active} 用完时切换过去？`,
        settleAddToPoolShort: ({ pool }) => `将它加入 ${pool}？`,
        settleAddToPool: ({ pool }) => `加入 ${pool}`,
        deviceStepCopy: '复制此代码',
        deviceStepOpen: ({ service }) => `打开 ${service} 并输入代码`,
        deviceStepOpenWhere: ({ where }) => `${where}，并登录你要使用的账号`,
        deviceStepApprove: ({ service }) => `在 ${service} 中批准 Happier`,
        deviceCheckNow: '立即检查',
    } } satisfies Pick<Readonly<Record<string, ConnectedServicesSetupTranslation>>, "zh-Hans">;

return { connectedServicesSetupTranslations };
})();

const Domain_detailPageTranslations = (() => {
type DetailPageTranslations = Shared_detailPageTranslations.DetailPageTranslations;

const detailPageTranslations = { 'zh-Hans': {
        approval: {
            requestTitle: '请求',
            requestDescription: '请求的内容及当前状态。',
            failureTitle: '失败原因',
            homeUnavailableTitle: 'Home 不可用',
            contextTitle: '请求来源',
            contextDescription: '发起此请求的会话和代理。',
            proposalsDescription: '批准后将发布到评审中。',
        },
        runs: {
            description: '你的机器上的后台运行。',
            filterLabel: '显示的运行',
            filterRunning: '运行中',
            filterAll: '全部',
            onHome: ({ home }) => `位于 ${home}`,
        },
        person: {
            placeholderTitle: '用户',
            friendshipTitle: '好友关系',
            sharedSessionsDescription: '此好友与你共享的会话，仅可查看。',
            linkedAccountsTitle: '关联账户',
            linkedAccountsDescription: '对方在其他地方的登录方式。将在浏览器中打开。',
        },
        friendsManage: {
            description: '你在 Happier 上合作的人，以及你们之间的请求。',
            requestsTitle: '好友请求',
            requestsDescription: '打开请求以接受或拒绝。',
            sentTitle: '已发送的请求',
            sentDescription: '等待对方接受。',
            friendsTitle: '好友',
            friendsDescription: '打开好友以查看其与你共享的内容。',
        },
    } } as const satisfies Pick<Record<string, DetailPageTranslations>, "zh-Hans">;

return { detailPageTranslations };
})();

const Domain_detailsChromeTranslations = (() => {
type DetailsChromeTranslations = Shared_detailsChromeTranslations.DetailsChromeTranslations;

const detailsChromeTranslations = { 'zh-Hans': {
        closeUnsavedTabA11y: '关闭标签页，有未保存的更改',
        emptyTitle: '文件、更改和提交在这里打开',
        browseFiles: '浏览文件',
        previewHint: '单击打开预览标签页；再次打开即可保留。',
        emptyReason: '你打开的文件、更改和提交会显示在这里，就在你打开它们的位置旁边。',
        reviewChanges: ({ count }) => `查看 ${count} 处更改`,
        reviewChangesReason: ({ count }) => `此会话中有 ${count} 个文件被更改。无需离开对话即可在这里阅读。`,
        splitNeedsWiderPane: '并排显示需要更宽的面板。请加宽详情或使用专注模式。',
    } } satisfies Pick<Record<string, DetailsChromeTranslations>, "zh-Hans">;

return { detailsChromeTranslations };
})();

const Domain_detailsFileTranslations = (() => {
type DetailsFileTranslations = Shared_detailsFileTranslations.DetailsFileTranslations;

const detailsFileTranslations = { 'zh-Hans': {
        areaUnstaged: '未暂存',
        areaStaged: '已暂存',
        areaBoth: '全部',
        areaLabel: '更改',
        preview: '预览',
        viewLabel: '视图',
        compare: '对比',
        stage: '暂存',
        unstage: '取消暂存',
        addToCommit: '加入提交',
        removeFromCommit: '移出提交',
        editing: '编辑中',
        editingUnsaved: '编辑中 · 有未保存的更改',
        statusModified: '已修改',
        statusAdded: '已添加',
        statusDeleted: '已删除',
        statusRenamed: '已重命名',
        statusCopied: '已复制',
        statusUntracked: '新文件，尚未跟踪',
        statusConflicted: '有冲突',
        noChanges: '没有更改',
        lines: ({ count }) => `${count} 行`,
    } } satisfies Pick<Record<string, DetailsFileTranslations>, "zh-Hans">;

return { detailsFileTranslations };
})();

const Domain_detailsHistoryTranslations = (() => {
type Count = Shared_detailsHistoryTranslations.Count;

type Branch = Shared_detailsHistoryTranslations.Branch;

type Folder = Shared_detailsHistoryTranslations.Folder;

type DetailsHistoryTranslations = Shared_detailsHistoryTranslations.DetailsHistoryTranslations;

const detailsHistoryTranslations = { 'zh-Hans': {
        copyCommitSha: '复制提交 SHA',
        filesChanged: ({ count }) => `更改了 ${count} 个文件`,
        files: ({ count }) => `${count} 个文件`,
        revertEllipsis: '还原…',
        stashKeptOn: ({ branch }) => `保存在 ${branch}`,
        stashOriginBranch: ({ branch }) => `在你离开 ${branch} 时保存`,
        stashOriginBranchShort: '切换分支时',
        stashOriginTransient: '由 Happier 保存',
        stashOriginUnmanaged: '在 Happier 之外创建',
        stashRestoreExplains: ({ folder }) => `恢复会把这些更改放回 ${folder} 并移除这个储藏。文件夹中的其他内容不会改变。`,
        stashApply: '应用',
        stashApplyA11y: '应用这些更改并保留储藏',
        stashDiscardEllipsis: '丢弃…',
        stashSwitcherA11y: '选择储藏',
        stashCount: ({ count }) => `${count} 个储藏`,
    } } satisfies Pick<Record<string, DetailsHistoryTranslations>, "zh-Hans">;

return { detailsHistoryTranslations };
})();

const Domain_detailsReviewTranslations = (() => {
type Count = Shared_detailsReviewTranslations.Count;

type DetailsReviewTranslations = Shared_detailsReviewTranslations.DetailsReviewTranslations;

const detailsReviewTranslations = { 'zh-Hans': {
        title: '审查',
        files: ({ count }) => `${count} 个文件`,
        nextCommit: ({ count }) => `下次提交包含 ${count} 个`,
        changedFiles: '已更改的文件',
        commitColumn: '提交',
        jumpA11y: '跳转到文件',
        comments: ({ count }) => `${count} 条评论`,
        goesWithNext: ({ count }) => `随下一条消息发送`,
        askForChanges: '请求修改',
        detachCommentA11y: '不随下一条消息发送此评论',
        trayExpandedHint: '它们会随你的下一条消息发送给代理。',
        askPlaceholder: '告诉代理要修改什么…',
        send: '发送',
        draftAuthor: '你', draftStatus: '草稿', includeComment: '随下一条消息发送',
    } } satisfies Pick<Record<string, DetailsReviewTranslations>, "zh-Hans">;

return { detailsReviewTranslations };
})();

const Domain_embedSettingsTranslations = (() => {
const english = Shared_embedSettingsTranslations.english;

const translated = Shared_embedSettingsTranslations.translated;

const embedSettingsTranslations = { 'zh-Hans': translated({
        settingsEmbeds: {
            title: "嵌入",
            newTitle: "新建嵌入",
            purpose: "让其他应用显示 Happier 对话，只授予你选择的访问权限。",
            yourEmbeds: "你的嵌入",
            newEmbed: "新建嵌入",
            listError: "无法加载嵌入",
            emptyTitle: "把 Happier 对话放进你自己的应用",
            emptyBody: "你的应用会显示真实的对话，只授予你选择的权限：哪些网站、谁可以发送或批准，以及哪些模型。",
            createDescription: "选择其他应用可以对你的对话做什么，以及它们的外观。",
            name: "名称",
            nameDescription: "只在此列表中对你可见。",
            namePlaceholder: "例如：线索看板",
            create: "创建嵌入",
            summary: {
                sites: ({ count }: { count: number }) => `${count} 个网站`,
                send: "可发送",
                sendAndApprove: "可发送和批准",
                viewOnly: "仅查看",
                modelOnly: ({ name }: { name: string }) => `仅 ${name}`,
                models: ({ count }: { count: number }) => `${count} 个模型`,
            },
            sites: {
                title: "可显示的位置",
                description: "对话只会在这些网站上打开。",
            },
            capabilities: {
                title: "可以做什么",
                view: "查看对话",
                always: "始终",
                send: "发送消息",
                sendDescription: "包括停止智能体和附加文件。",
                changeModel: "更换模型",
                permissionModes: "权限模式",
                permissionModesDescription: "只有允许多个模式时，对话中才会显示模式选择。",
                anyMode: "任意模式",
                anyModeDescription: "用户可以更改代理无需询问即可执行的范围。",
                modeOnly: ({ name }: { name: string }) => `仅 ${name}`,
                modes: ({ count }: { count: number }) => `${count} 种模式`,
                approveOn: "这些网站上的用户可以批准这些对话中的工具使用和请求。",
            },
            models: {
                title: "模型",
                description: "其他模型会被拒绝，而不只是隐藏。对话从第一个允许的模型开始。",
                allowed: "允许的模型",
                any: "任意模型",
            },
            organization: {
                title: "整理",
                description: "你的应用从这里列出此嵌入的对话（任一标签）。新对话也会放在这里。",
                folder: "文件夹",
                tags: "标签",
                none: "无",
            },
            composer: {
                title: "输入框",
                attachments: "附件",
                attachmentsDescription: "隐藏附件按钮。可以发送的人仍可通过 API 附加文件。",
            },
            sessions: {
                title: "会话",
                description: "此密钥从你的服务器或对话中创建的会话，会在这台电脑上用这个智能体运行，并放入上面的文件夹和标签。",
                allow: "允许此密钥创建会话",
                offConsequence: "此密钥不能创建会话。你的应用只能显示已有的对话。",
                computer: "电脑",
                agent: "智能体",
                newChat: "在嵌入中开始新对话",
                appSetting: "应用设置",
                newChatDescription: "当你的应用在没有对话的情况下打开嵌入时，显示新对话输入框。这是应用的设置，而不是安全限制：你的服务器始终可以用此密钥创建对话。",
            },
            appearance: {
                title: "外观",
                description: "预览会随每次更改更新。已打开的对话无需重新加载即可更新样式。",
                mode: "模式",
                modeSystem: "跟随系统",
                modeLight: "浅色",
                modeDark: "深色",
                theme: "主题",
                presetHappier: "Happier",
                colors: "颜色",
                colorsDefault: "Happier 默认",
                colorsCustomized: ({ count }: { count: number }) => `已自定义 ${count} 项`,
                colorsFor: "颜色适用于",
                colorGroups: {
                    surface: "表面",
                    text: "文字",
                    accent: "强调色",
                    messages: "消息",
                    composer: "输入框",
                    approvals: "批准",
                },
                fontFamily: "字体",
                fontFamilyPlaceholder: "Happier 默认",
                fontFile: "字体文件",
                fontFileDescription: "指向 .woff2 或 .woff 文件的 https 链接。",
                fontFileRefused: "请使用指向 .woff2 或 .woff 文件的链接，而不是样式表。",
                textSize: "文字大小",
                textSizeCompact: "紧凑",
                textSizeDefault: "默认",
                textSizeLarge: "大",
                corners: "圆角",
                cornersSharp: "直角",
                cornersSoft: "柔和",
                cornersRound: "圆润",
                density: "密度",
                densityCompact: "紧凑",
                densityComfortable: "舒适",
                reset: "重置外观",
            },
            preview: {
                title: "实时预览",
                phone: "手机",
                desktop: "桌面",
                reduceMotion: "减少动态效果",
                note: "带示例消息的真实嵌入对话。不会发送任何内容。",
                rowDescription: "查看使用这些设置的对话。",
                unavailable: "预览不可用",
            },
            snippets: {
                title: "代码片段",
                description: "将它们粘贴到你的应用中。它们已使用此嵌入的设置。",
                steps: "1 将密钥保存为 HAPPIER_EMBED_KEY · 2 编写 canOpenSession：谁可以打开哪个对话 · 3 显示对话",
                backend: "后端",
                react: "React",
            },
            detail: {
                created: ({ date }: { date: string }) => `创建于 ${date}`,
                lastUsed: ({ date }: { date: string }) => `上次使用 ${date}`,
                expires: ({ date }: { date: string }) => `到期 ${date}`,
                reconnect: "已打开的对话会以新的权限重新连接。草稿会保留。",
                e2eeTrust: "此密钥可以读取此账户的加密对话。请为你的应用使用专用账户。",
                keyReach: "密钥保留在你的服务器上，可以访问此账户中的所有对话。浏览器永远看不到它：浏览器只会获得短期密钥，且仅限你的服务器允许的对话。",
                expiry: "密钥到期",
                expiryDescription: "密钥到期后，对话将无法打开。之后无法延长。",
                encryptionChecking: "正在检查此账户的加密…",
                encryptionUnavailable: "此设备暂时无法读取此账户的加密对话。请恢复你的密钥以创建嵌入。",
                encryptionStale: "此设备用于加密对话的密钥已过期。请恢复你的密钥以创建嵌入。",
                encryptionUnreadable: "无法检查此账户的加密。",
                missingTitle: "此嵌入已不存在",
                backToEmbeds: "返回嵌入",
            },
            delete: {
                button: "删除嵌入",
                title: ({ label }: { label: string }) => `删除“${label}”？`,
                body: "已打开的对话会断开。已用于读取加密对话的密钥无法追回。",
                confirm: "删除",
            },
            reveal: {
                copyEnv: "复制为 .env 行",
            },
        },
    }) };

return { embedSettingsTranslations };
})();

const Domain_embedTranslations = (() => {
const english = Shared_embedTranslations.english;

const translated = Shared_embedTranslations.translated;

const embedTranslations = { 'zh-Hans': translated({
        embed: {
            errors: {
                originNotAllowed: '此页面不能显示这段对话。',
                originNotAllowedReason: '请在 Happier 中将此网站加入嵌入的允许网站。',
                unavailable: '这段对话在此不可用。',
                encrypted: '这段对话已加密，无法在此打开。',
                createNotGranted: '此应用无法开始新对话。',
                unsupportedVersion: '此对话需要更新的嵌入版本。',
                unsupportedVersionReason: '请在此应用中更新 @happier-dev/embed。',
            },
            nothingToShow: '暂无内容',
            nothingToShowReason: '此应用尚未打开任何对话。',
            reconnecting: '正在重新连接…',
            previewUnavailable: '预览不可用',
            previewUser: "分析这个线索并记录结果：Acme Robotics，40 个席位，第四季度评估。",
            previewAgent: "非常匹配。预算已确认，推动者负责决策。我已记录分析：",
            previewFollowUp: "要把这个线索移到“已确认”吗？",
        },
    }) };

return { embedTranslations };
})();

const Domain_entityDragDropTranslations = (() => {
type EntityDragDropTranslations = Shared_entityDragDropTranslations.EntityDragDropTranslations;

const en = Shared_entityDragDropTranslations.en;

const zhHans: EntityDragDropTranslations = {
    files: { attach: "附加", uploadHere: "上传到这里" },
    composer: { addContext: "添加上下文", consequence: "随你的下一条消息发送 · 暂不发送任何内容", target: "输入框", readOnly: "此输入框为只读", otherWorkspace: "不属于此工作区", unavailable: "此引用不可用" },
    surface: {
        scopeMismatch: '它在另一个 Home 或账户中',
        widgetMoveUnavailable: '此组件无法移到这个界面区域',
        readOnly: '此看板为只读',
        copyDetail: '保留引用 · 看板保持不变',
    },
    preview: {
        putUnder: ({ target }) => `放到 ${target} 下`,
        putUnderDetail: '向它汇报 · 两者都继续运行',
        moveAbove: ({ target }) => `移到 ${target} 上方`,
        moveBelow: ({ target }) => `移到 ${target} 下方`,
        orderDetail: '仅调整顺序 · 不建立汇报关系',
        moveToFolder: ({ folder }) => `移到 ${folder}`,
        folderDetail: '仅调整文件夹 · 不向任何人汇报',
        moveToTopLevel: '移到顶层',
        topLevelDetail: '移出文件夹 · 其他不变',
        cantPutUnder: ({ target }) => `无法放到 ${target} 下`,
        cantMoveHere: '无法移到这里',
        pendingPutUnder: ({ target }) => `正在放到 ${target} 下…`,
        pendingDetail: '正在等待 Home 确认',
        unknownTitle: '不确定是否已移动',
        unknownDetail: '请稍后查看列表，再决定是否重试',
    },
    settled: {
        refusedPutUnder: ({ item, target }) => `无法将 ${item} 放到 ${target} 之下`,
        refused: ({ verb }) => `${verb}：未完成`,
        unknown: ({ verb }) => `不确定“${verb}”是否已完成`,
        dismiss: '关闭',
    },
    reasons: {
        read: '它以只读方式与你共享，因此无法接收汇报',
        input: '你无法向它发送内容，因此它无法接收汇报',
        pairwise: '这两个会话不能共享上下文',
        cycle: '该会话已经向这个会话汇报',
        alreadyUnder: '它已经向这个会话汇报',
        archived: '它已归档',
        differentHome: '它在另一个 Home 中。会话只能在同一个 Home 内汇报',
        unavailable: '暂时无法检查这个会话',
        dateOrder: '此列表按日期排序。切换到自定义顺序后才能放置',
        noChange: '它已经在这里',
        descendantCycle: '文件夹不能放进自身',
        maxDepth: '文件夹嵌套会过深',
        foldersOff: '此 Home 已关闭文件夹',
        gone: '那个位置刚刚消失了',
        generic: '这里无法放置',
    },
    chooser: { putUnderTitle: ({ item }) => `将 ${item} 放到…之下`, checking: '正在检查哪些会话可以接收汇报…', cantTakeReports: '无法接收汇报', unavailable: '不可用' },
    keyboard: {
        choose: '选择位置', putUnder: '放到下面', topLevel: '顶层', drop: '放下', cancel: '取消', escapeKey: 'Esc',
        hintsA11y: '方向键选择位置，Enter 放下，Escape 取消',
    },
    organize: { enter: '整理列表', title: '整理', done: '完成', grip: ({ item }) => `移动 ${item}` },
    pane: {
        openHere: '在此作为标签页打开',
        nextTo: ({ target }) => `在 ${target} 旁边 · 不会关闭任何内容`,
        nothingCloses: '作为标签页打开 · 不会关闭任何内容',
        tooNarrow: '此窗格太窄，无法拆分',
        moveHere: '作为标签页移到这里',
        openBefore: ({ target }) => `在 ${target} 前打开`,
        moveBefore: ({ target }) => `移到 ${target} 前`,
        placeOnly: '只改变位置',
        splitLeft: '向左拆分',
        splitRight: '向右拆分',
        splitUp: '向上拆分',
        splitDown: '向下拆分',
        opensBeside: ({ target }) => `在 ${target} 旁边打开`,
        movesBeside: ({ target }) => `移到 ${target} 旁边`,
        goTo: ({ target }) => `前往 ${target}`,
        openInThisPane: '已在此窗格中打开 · 不会打开新内容',
        openInAnotherPane: '已在另一个窗格中打开 · 不会打开新内容',
        alreadyHere: '已在这里',
        leaveIt: '松开即保持原位',
        cantOpenHere: '无法在这里打开',
        sessionsOnly: '此窗格只显示会话',
        otherWorkspace: '不属于此工作区',
    },
};

const entityDragDropTranslations = { zhHans };

return { entityDragDropTranslations };
})();

const Domain_eventAutomationComposerTranslations = (() => {
const english = Shared_eventAutomationComposerTranslations.english;

const zhHans = {
    eventAutomationComposer: {
        available: '可用',
        payloadFields: '有效负载字段',
        payloadSample: '示例有效负载',
        noFilterableFields: '此事件不声明可过滤的有效负载字段。',
        addFilterClause: '添加条件',
        filterField: '过滤字段',
        filterOperator: '过滤运算符',
        filterEquals: '等于',
        filterOneOf: '是其中之一',
        filterValue: '过滤值',
        filterValuePlaceholder: '“值”或[“值”]',
        storedContentUnavailableTitle: '存储的自动化内容不可用',
        storedContentUnavailableBody: '无法保存此事件自动化，因为其存储的内容不可用。',
        historyGapRecoveryTitle: '历史差距需引起重视',
        historyGapRecoverySubtitle: '重置源基线以继续观察新事件。',
        historyGapRecoveryUnavailable: '源恢复操作在当前观察程序上不可用。',
        historyGapRecoveryFailureTitle: '源恢复需要再次尝试',
        historyGapRecoveryFailureBody: '康复情况尚未得到证实。消息来源仍需关注。',
        sourceStatusTitle: '观察来源',
        sourceStatusState: {
            uninitialized: '尚未开始',
            baselined: '基线已就绪',
            observing: '正在观察',
            backingOff: '等待重试',
            attention: '需要注意',
        },
        sourceStatusCode: {
            credentialMissing: '需要凭证',
            credentialRevoked: '凭证已撤销',
            rateLimited: '已达到速率限制',
            historyGap: '历史记录存在缺口',
            capacityBlocked: '容量已满',
            definitionStale: '定义已更改',
            sourceContractIncompatible: '来源需要更新',
            admissionUnavailable: '无法接纳',
        },
        sourceStatusNextRetry: ({ time }: { time: string }) => `下次重试：${time}`,
        sourceStatusObservedCount: ({ count }: { count: number }) => `已观察事件：${count}`,
        sourceStatusAdmittedCount: ({ count }: { count: number }) => `已接纳事件：${count}`,
        sourceStatusSkippedCount: ({ count }: { count: number }) => `已跳过事件：${count}`,
        sourceStatusLastObserved: ({ time }: { time: string }) => `最近观察时间：${time}`,
        sourceCatalogStatusTitle: '目录协调',
        sourceCatalogStatusState: {
            current: '最新',
            reconciling: '正在协调',
            reconciliationLate: '协调延迟',
        },
        sourceCatalogStatusObservedRevision: ({ revision }: { revision: string }) => `已观察版本：${revision}`,
        sourceCatalogStatusAdoptedRevision: ({ revision }: { revision: string }) => `已采用版本：${revision}`,
        sourceCatalogStatusNoAdoptedRevision: '尚未采用任何版本',
        sourceCatalogStatusScanStarted: ({ time }: { time: string }) => `扫描开始时间：${time}`,
    },
};

const eventAutomationComposerTranslations = { 'zh-Hans': zhHans } as const;

return { eventAutomationComposerTranslations };
})();

const Domain_externalSessionOperationTranslations = (() => {
const en = Shared_externalSessionOperationTranslations.en;

const translated = Shared_externalSessionOperationTranslations.translated;

const externalSessionOperationTranslations = { zhHans: {
    browseLinked: '已关联',
    browseImported: '已导入',
    browseAgentUnavailable: 'Happier 无法在此机器上启动或连接所选 Agent。请确认其 CLI 已安装，然后重试。',
    browseAgentTimedOut: '此机器上所选的 Agent 未及时响应。它可能正忙或仍在建立索引，请重试。',
    browseAgentFailed: 'Happier 无法读取此机器上所选 Agent 的会话。请重试；如果仍然失败，请更新该机器上的 Happier。',
    operationTitleMaterialize: '导入 Happier',
    operationTitleTakeoverLinked: '接管并保持关联',
    operationTitleTakeoverPersisted: '导入并接管',
    operationMaterializeAvailable: '导入此关联会话，以便离线使用其记录或进行共享。',
    externalAgentStatusOnMachine: ({ agent, machine, status }: { agent: string; machine: string; status: string }) =>
        `${agent} 上的 ${machine}：${status}`,
    operationStatusRunning: '进行中',
    operationStatusCancelling: '正在取消…',
    operationStatusCancelled: '已取消',
    operationStatusCompleted: '已完成',
    operationStatusDiscarded: '已丢弃部分会话',
    operationStatusNeedsResume: '等待你继续',
    operationStatusNeedsReview: '继续前需要检查',
    operationStatusFailed: '无法继续',
    operationStatusImportIncomplete: '导入未完成 — 继续或丢弃部分会话',
    operationStatusUpdateIncomplete: '更新未完成 — 继续',
    operationStatusOriginOffline: '进度已保存 — 来源机器离线',
    operationStatusOriginUnknown: '进度已保存 — Happier 无法确认来源机器是否在线',
    operationStatusExternalWriter: '检测到外部写入者',
    operationStatusSpawnFailedAfterImport: '已导入，但 Agent 无法启动 — 重试启动',
    operationStatusSpawnFailedAfterTakeover: '已接管，但 Agent 无法启动 — 重试启动',
    operationErrorSourceUnavailable: '来源不可用。请重新连接源机器，然后继续。',
    operationErrorSourceChanged: '读取期间来源发生了变化。请检查后再继续。',
    operationErrorCapacity: '此机器没有足够的暂存空间继续操作。',
    operationErrorRequiredItems: '部分必需的会话项目无法导入。',
    operationErrorImport: '消息导入已中断。',
    operationErrorPublication: '无法发布已导入的快照。',
    operationErrorAdmission: 'Happier 无法安全接管此会话。',
    operationErrorExternalWriter: '请先停止外部 Agent 再重试。Happier 不会自动合并或停止它。',
    operationErrorInternal: '操作因内部错误而停止。',
    operationPhaseValidating: '正在验证',
    operationPhaseWaitingForAgent: '等待外部 Agent 停止',
    operationPhaseReadingSource: '正在读取来源',
    operationPhaseImporting: '正在导入消息',
    operationPhaseCatchingUp: '正在与来源同步',
    operationPhasePreparingRuntime: '正在准备运行时',
    operationPhaseStartingRuntime: '正在启动运行时',
    operationPhaseFinalizing: '正在完成',
    operationPhasePublishing: '正在发布已导入的会话',
    operationActionResume: '继续',
    operationActionRetryStart: '重试启动',
    operationActionCancel: '取消',
    operationActionDiscard: '丢弃部分会话',
    operationActionDismiss: '关闭',
    operationStatusOwnerReadFailed: 'Happier 无法读取此操作的最新进度。',
    operationActionCheckAgain: '重新检查',
    operationComposerImporting: '正在导入…',
    operationComposerTakingOver: '正在接管…',
    operationActionErrorUpgradeRequired: '请更新源机器上的 Happier 以使用此操作。',
    operationActionErrorNotFound: '此操作已不可用。',
    operationActionErrorConflict: '另一项操作已在控制此会话。',
    operationActionErrorStaleRevision: '操作已发生变化。请查看最新进度后重试。',
    operationActionErrorInvalidState: '当前操作状态下无法使用此操作。',
    operationActionErrorNotAllowed: '你没有控制此操作的权限。',
    operationActionErrorUnavailable: '无法完成此操作。请从最新进度重试。',
    operationImportProgress: '导入进度',
    operationImportCountUnknown: ({ imported }: { imported: number }) => `已导入 ${imported} 条消息`,
    operationImportCountEstimated: ({ imported, total }: { imported: number; total: number }) => `约 ${imported} 条消息中已导入 ${total} 条`,
    operationPublishedSnapshot: '已保留发布的快照',
    operationPublishedThrough: ({ sequence }: { sequence: number }) => `可用至消息 ${sequence}`,
    operationDiscardConfirmTitle: '丢弃部分会话？',
    operationDiscardConfirmBody: '这会删除整个部分会话，且无法撤销。',
    sharingTranscriptOnMachine: ({ machine }: { machine: string }) =>
        `此会话的记录位于 ${machine}。请将其导入 Happier 后再共享。`,
    sharingImportIncomplete: '导入正在进行或尚未完成。请先继续导入再共享。',
    sharingTranscriptUnavailableTitle: '会话记录不可用',
    transcriptRetainedRefreshFailedTitle: '正在显示最近一次获取的会话记录',
    transcriptLoadFailed: 'Happier 无法加载此会话记录。',
    sharingTranscriptUnavailable: '会话记录不可用。此旧版关联会话没有安全保存的记录。',
    sharingSharedUpTo: ({ time }: { time: string }) => `已共享至 ${time}`,
    sharingSnapshotFrom: ({ time }: { time: string }) => `${time} 的快照`,
    sharingUpdateSharedCopy: '更新共享副本',
    sharingUpdateSharedCopyDescription: '使用来源中的最新会话记录刷新共享快照。',
    sharingSourceMachineMissing: '来源机器不可用。请先将其重新连接到 Happier，然后再试。',
    sharingSourceMachineOffline: '来源机器已离线。请先使其上线，然后再试。',
    sharingActionAwaitingAvailability: '连接物化流程后即可使用此操作。',
} } as const;

return { externalSessionOperationTranslations };
})();

const Domain_externalSessionSettingsTranslations = (() => {
const en = Shared_externalSessionSettingsTranslations.en;

const translated = Shared_externalSessionSettingsTranslations.translated;

const externalSessionSettingsTranslations = { zhHans: {
    settingsIntegrationStatusNotInstalled: '未安装',
    settingsIntegrationStatusEnabled: '已安装并启用',
    settingsIntegrationStatusDisabled: '已安装但未启用',
    settingsIntegrationStatusNeedsAttention: '需要处理',
    settingsIntegrationStatusUnsupported: '此 Agent 版本不支持',
    settingsIntegrationStatusUnavailable: 'Agent 不可用',
    settingsIntegrationInventoryLoadingTitle: '正在检查集成状态',
    settingsIntegrationInventoryLoadingSubtitle: '正在从此机器读取完整的集成清单。',
    settingsIntegrationInventoryPartialTitle: '集成状态不完整',
    settingsIntegrationInventoryPartialSubtitle: '部分安装记录无法读取。请在更改前重新检查。',
    settingsIntegrationInventoryErrorTitle: '集成状态不可用',
    settingsIntegrationInventoryErrorSubtitle: '上次已知状态可能已过期。请在更改前重新检查。',
    settingsIntegrationTitle: '外部会话监控',
    settingsIntegrationNeedsAttentionTitle: '需要处理',
    settingsIntegrationDiagnosticMessageUnavailable: '此安装需要处理后才能继续监控。',
    settingsIntegrationRemediationRetry: '解决问题后请重新检查。',
    settingsIntegrationRemediationOpenSettings: ({ path }: { path: string }) => `请检查 ${path} 中的设置。`,
    settingsIntegrationRemediationSelectAccount: ({ service }: { service: string }) => `请为 ${service} 选择一个账户。`,
    settingsIntegrationRemediationInstallDependency: ({ dependency }: { dependency: string }) => `请安装所需依赖项：${dependency}。`,
    settingsIntegrationRemediationOpenUrl: ({ url }: { url: string }) => `请查看 ${url} 中的说明。`,
    settingsIntegrationActionReviewInstall: '检查并安装',
    settingsIntegrationActionDisable: '停用',
    settingsIntegrationActionEnable: '启用',
    settingsIntegrationActionUninstall: '卸载',
    settingsIntegrationActionCheckAgain: '重新检查',
    settingsIntegrationReviewTitle: ({ agent }: { agent: string }) => `检查 ${agent} 集成`,
    settingsIntegrationReviewBody: ({ entries }: { entries: string }) =>
        `Happier 只会管理以下项目：${entries}。`,
    settingsIntegrationReviewBodyUnavailable: '安装前请检查由 Agent 管理的更改。',
    settingsIntegrationPreviewNoMatcher: '所有匹配的会话',
    settingsIntegrationActionInstall: '安装',
    settingsIntegrationUninstallTitle: ({ agent }: { agent: string }) => `卸载 ${agent} 集成？`,
    settingsIntegrationUninstallBody: '这只会删除 Happier 管理的项目，其他 Agent 配置保持不变。',
    settingsIntegrationActionFailed: 'Happier 无法更新此集成。请检查机器后重试。',
    settingsAutoLinkUpdateFailed: 'Happier 无法更新自动关联。请重试。',
    settingsRestoreUpdateFailed: 'Happier 无法更新重启后的后台同步设置。请重试。',
    settingsIntegrationsGroupTitle: '外部会话监控',
    settingsIntegrationsFooter: 'Happier 只会在你明确操作后更改 Agent 配置。打开此页面不会进行更改。',
    settingsIntegrationsUnavailableTitle: '没有可用的集成',
    settingsIntegrationsUnavailableSubtitle: '连接受支持的 Agent 集成以检查其状态和可用操作。',
    settingsAgentAutoLinkTitle: ({ agent }: { agent: string }) => `自动添加新的 ${agent} 会话`,
    settingsAutoLinkTitle: '自动添加新的外部会话',
    browseAutoLinkTitle: '自动添加新会话',
    settingsAutoLinkGroupTitle: '自动关联',
    settingsAutoLinkGroupFooter: '自动关联默认关闭，并且与 Agent 集成设置和后台同步相互独立。',
    settingsAutoLinkUnavailableTitle: '没有可用于自动关联的来源',
    settingsAutoLinkUnavailableSubtitle: '此机器上没有受支持的来源范围。',
    settingsAutoLinkSubtitle: '启用后，Happier 会关联此来源中受支持的新会话，而不会打开或恢复 Agent。',
    settingsAutoLinkHint: '为此来源开启或关闭自动关联。',
    settingsPrivacyGroupTitle: '隐私',
    settingsPrivacyTitle: '有界且不含内容的观察',
    settingsPrivacySubtitle: '受信任的 Agent 集成可能会检查此机器上有界的原生 hook 数据。Happier 只接收和同步不含内容的观察；主机绝不会保存、同步或记录原始载荷、路径、凭据、提示、会话记录文本或工具参数。',
    settingsAgentActionsGroupTitle: '外部会话',
    settingsAgentBrowseTitle: ({ agent }: { agent: string }) => `浏览 ${agent} 外部会话`,
    settingsManageAllTitle: '管理所有外部会话设置',
    settingsManageAllSubtitle: '检查已连接机器上的集成和后台同步。',
    settingsMachineOnline: '在线',
    settingsMachineOffline: '离线',
    settingsMachineTitle: '机器',
    settingsMachineUnavailable: '没有已连接的机器',
    browseSearchIncomplete: ({ count }: { count: number }) =>
        `显示前 ${count} 个结果 — 请缩小搜索范围`,
    browseAnnotationsIncomplete: '部分状态无法确认。打开会话时会进行检查。',
    browseRouteUnavailableTitle: '此处无法使用外部会话',
    browseRouteUnavailableSubtitle: '该服务器不提供外部会话浏览。请返回并选择其他服务器，或稍后再试。',
    browseRouteAvailabilityUnknownTitle: '无法确认是否支持外部会话',
    browseRouteAvailabilityUnknownSubtitle: 'Happier 无法确认该服务器是否提供外部会话浏览。请返回并稍后再试。',
    browseHeaderTitle: '外部会话',
    browseSettingsLink: '外部会话设置',
    browseChooseMachineTitle: '选择机器',
    browseChooseMachineBody: '外部会话保存在运行它们的机器上。选择一台机器以查看其会话。',
    browseMachineGoneBody: '它已被移除或替换。选择其他机器以查看其会话。',
    browseHomeUnreachableBody: '可以连接后，它的机器和会话会显示在这里。在此期间请选择其他机器。',
    browseMachineOfflineTitle: ({ machine }: { machine: string }) => `${machine} 已离线`,
    browseThisMachineOfflineTitle: '这台机器已离线',
    browseMachineOfflineBody: '重新连接后会显示其会话。',
    browseChooseAnotherMachine: '选择其他机器',
    browseCantReachTitle: ({ machine }: { machine: string }) => `无法连接 ${machine} 上的 Happier`,
    browseCantReachBody: '机器在线，但其 Happier 服务没有响应，可能仍在启动。',
    browseNothingToBrowseTitle: ({ machine }: { machine: string }) => `${machine} 上没有可浏览的内容`,
    browseNothingToBrowseBody: '这台机器上的代理暂时都无法共享会话。',
    browseEmptyTitle: ({ agent, machine }: { agent: string; machine: string }) => `${machine} 上没有 ${agent} 会话`,
    browseEmptyBody: '你在这台机器上启动的会话会显示在这里，可在 Happier 中打开。',
    browseTryAgent: ({ agent }: { agent: string }) => `试试 ${agent}`,
    browseNoMatches: ({ query }: { query: string }) => `没有与“${query}”匹配的会话`,
    browseErrorTitle: '无法加载会话',
    browseThisMachine: '这台机器',
    browseIndexingStop: '停止',
    browseThreadsFilter: '子代理线程',
    browseThreadsHidden: '仅顶层会话',
    browseThreadsShown: '包含子代理线程',
    browseThreadReviewer: '审查者',
    browseThreadSubagent: '子代理',
    browseThreadReviewerOf: ({ parent }: { parent: string }) => `${parent} 的审查者`,
    browseThreadSubagentOf: ({ parent }: { parent: string }) => `${parent} 的子代理`,
} };

return { externalSessionSettingsTranslations };
})();

const Domain_filesPaneTranslations = (() => {
type FilesPaneTranslations = Shared_filesPaneTranslations.FilesPaneTranslations;

const filesPaneTranslations = { 'zh-Hans': {
        changedOnly: '仅显示更改',
        showAllFiles: '显示所有文件',
        viewOptions: '视图选项',
        sizeAndDate: '大小和日期',
        newMenu: '新建文件、新建文件夹或上传',
        newFile: '新建文件',
        newFolder: '新建文件夹',
        noChangedFilesTitle: '没有任何更改',
        noChangedFilesReason: '工作副本与最近一次提交一致。',
        rootErrorTitle: ({ machine }) => `无法列出 ${machine} 上的文件`,
        rootErrorTitleUnnamed: '无法列出文件',
    } } as const satisfies Pick<Record<string, FilesPaneTranslations>, "zh-Hans">;

return { filesPaneTranslations };
})();

const Domain_findTranslations = (() => {
type FindTranslations = Shared_findTranslations.FindTranslations;

const slavicPlural = Shared_findTranslations.slavicPlural;

const russianPlural = Shared_findTranslations.russianPlural;

const en = Shared_findTranslations.en;

const zhHans: FindTranslations = {
    open: '查找…',
    openedForMatch: '已展开匹配位置', foldAgain: '重新折叠', showHiddenLines: ({ count }) => `显示 ${count} 个隐藏行`,
    surface: {
        chat: '在聊天中查找',
        changes: '在更改中查找',
        file: '在文件中查找',
        terminal: ({ name }) => `在 ${name} 中查找`,
    },
    previous: '上一个匹配',
    next: '下一个匹配',
    matchCase: '区分大小写',
    regex: '使用正则表达式',
    regexShort: '正则表达式',
    options: '搜索选项',
    close: '关闭查找',
    done: '完成',
    stop: '停止',
    noMatches: '无匹配',
    noneFound: '未找到',
    invalidPattern: '无效的模式',
    offline: '离线',
    unsupported: '此处无法查找',
    count: ({ current, total }) => (current === null ? `${total} 个匹配` : `${current}/${total}`),
    files: ({ count }) => `${count} 个文件`,
    soFar: '（进行中）',
    loaded: '（已加载）',
    note: {
        searchingOlder: '正在查找较早的消息，在此设备上解密',
        offlineOlder: '恢复联网后即可查找较早的消息。',
        terminalKept: ({ lines }) => `已查找此终端保留的最近 ${lines} 行。`,
    },
};

const findTranslations = { zhHans };

return { findTranslations };
})();

const Domain_folderlessSessionTranslations = (() => {
type FolderlessSessionTranslations = Shared_folderlessSessionTranslations.FolderlessSessionTranslations;

const en = Shared_folderlessSessionTranslations.en;

const zhHans: FolderlessSessionTranslations = {
    composer: {
        addFolder: '添加文件夹',
        noFolder: '不使用文件夹',
        noFolderDescription: 'Happier 会为此对话保留一个私有文件夹',
        removeFolder: '移除文件夹',
        a11y: {
            folder: ({ path }) => `文件夹：${path}。打开文件夹选项。`,
            none: '不使用文件夹。Happier 会为此对话保留一个私有文件夹。添加文件夹。',
            loading: '正在加载文件夹',
            noFolderRow: '不使用文件夹，此对话的私有文件夹',
            removed: '已移除文件夹',
            set: ({ path }) => `文件夹已设为 ${path}`,
        },
    },
    display: {
        chats: '对话',
        untitledChat: '新对话',
        folder: '文件夹',
        privateToSession: '仅限此会话',
        sessionFiles: '会话文件',
        privateFolderOn: ({ machine }) => `${machine} 上的私有文件夹`,
    },
};

const folderlessSessionTranslations = { zhHans: zhHans };

return { folderlessSessionTranslations };
})();

const Domain_glassAppearanceTranslations = (() => {
const englishTranslations = Shared_glassAppearanceTranslations.englishTranslations;

const effectiveTranslations = { "zh-Hans": {
        "effectiveBrowserSolid": "菜单和浮动控件使用不透明材质。浏览器无法透出桌面。",
        "effectiveFloatingSolid": "此设备的浮动控件使用不透明材质。",
        "effectiveSolid": "此设备使用不透明界面。",
        "effectiveBrowser": "菜单和浮动控件使用玻璃。浏览器无法透出桌面。",
        "effectiveBrowserCustom": "菜单和浮动控件使用所选材质。浏览器无法透出桌面。",
        "effectivePhone": "浮动控件和面板使用玻璃。",
        "effectiveLayered": "此窗口全局使用分层玻璃。",
        "effectiveUniform": "此窗口全局使用统一玻璃。",
        "effectiveCustom": "此窗口使用你自定义的玻璃。",
        "effectiveUnavailable": "窗口玻璃不可用。浮动控件仍使用所选材质。",
        "effectiveInactive": "此窗口未激活时使用不透明材质。",
        "effectiveTint": "此设备的浮动控件带有色调，背景模糊不可用。",
        "description": "让桌面透过窗口，让页面透过浮动控件。",
        "descriptionBrowser": "让页面透过菜单和浮动控件。",
        "descriptionPhone": "让页面透过浮动控件和面板。",
        "chromeDescription": "标题栏、导航栏和窗口背景",
        "sidebarDescription": "会话栏",
        "contentDescription": "对话、输入框和工作面板",
        "floatingDescription": "菜单、弹出框、面板和浮动控件",
        "clear": "透明",
        "shortcutHint": ({ modifier }: { modifier: string }) => `${modifier}-点击 · ${modifier}⇧L 切换浅色和深色`
    } } as const;

const glassAppearanceTranslations = { 'zh-Hans': { iosReduceTransparencyPath: "设置 › 辅助功能 › 显示与文字大小 › 降低透明度", title: '玻璃', material: '材质', solid: '不透明', auto: '自动', everywhere: '全局', custom: '自定义', blur: '模糊', off: '关闭', opacity: '不透明度', customize: '自定义', chrome: '窗口边框', sidebar: '侧边栏', content: '内容', floating: '浮动界面', appearance: '外观', moreSettings: '更多外观设置…', customizeLink: '自定义…', toolbarTitle: '外观按钮', toolbarDescription: '在工具栏中显示外观。按住修饰键点击可切换浅色和深色。', reduceTransparency: '已开启降低透明度，因此显示不透明材质', osSettings: '打开辅助功能设置', themeCommand: '切换浅色和深色', autoDescription: "适应当前设备：支持的桌面窗口使用分层玻璃，手机仅在浮动界面使用玻璃。", osSettingsUnavailable: "无法打开辅助功能设置。请在设备设置中打开。", ...effectiveTranslations["zh-Hans"] } } satisfies Pick<Record<string, Record<keyof typeof englishTranslations, string | ((params: { modifier: string }) => string)>>, "zh-Hans">;

return { effectiveTranslations, glassAppearanceTranslations };
})();

const Domain_goalControlTranslations = (() => {
const en = Shared_goalControlTranslations.en;

const zhHans: typeof en = {
    row: {
        notSet: '未设置',
    },
    keepGoing: {
        title: '持续推进直到完成',
        nativeDescription: ({ agent }) => `${agent} 会自行朝目标继续工作。`,
        description: ({ rounds }) => `在你的每个回合结束后，一个代理会检查目标并继续推进，直到完成、预算用尽或不再有进展，最多 ${rounds} 轮。`,
        roundsPrefix: '在',
        roundsSuffix: '轮后停止',
        roundsLabel: '停止前的轮数',
        strikesPrefix: '在',
        strikesSuffix: '次无进展检查后停止',
        strikesLabel: '停止前的无进展检查次数',
        secondOpinionTitle: '完成前征求第二意见',
        secondOpinionDescription: '在目标标记为完成之前，会由另一个代理检查。如果它不同意，你会收到通知，目标保持未完成。',
        budgetUnreported: ({ agent }) => `${agent} 不报告 token 用量，因此只适用轮数和进展检查。`,
    },
};

const goalControlTranslations = { zhHans };

return { goalControlTranslations };
})();

const Domain_homeAddTranslations = (() => {
type HomeAddTranslation = Shared_homeAddTranslations.HomeAddTranslation;

const en = Shared_homeAddTranslations.en;

const homeAddTranslations = { 'zh-Hans': {
        addressIsSignInService: '此地址是登录服务。请通过该服务登录，以查找你的 Home。',
        mixedContent: '此浏览器无法从 HTTPS 页面连接到 HTTP Home。请通过 HTTP 打开 Happier，或使用 Home 的 HTTPS 地址。',
        connectedToHome: ({ home }) => `${home} 已连接到此设备。`,
        openHome: ({ home }) => `打开 ${home}`,
        showAllHomes: '显示所有 Home',
        otherSignInService: '其他登录服务',
        otherSignInServiceSubtitle: '自托管或公司服务',
        signInServiceAddress: '服务地址',
    } } satisfies Pick<Record<string, HomeAddTranslation>, "zh-Hans">;

return { homeAddTranslations };
})();

const Domain_homeComposerTranslations = (() => {
type HomeComposerTranslation = Shared_homeComposerTranslations.HomeComposerTranslation;

const starterPrompts = Shared_homeComposerTranslations.starterPrompts;

const homeComposerTranslations = { 'zh-Hans': {
        ...starterPrompts,
        suggestionsLabel: '建议',
        summarizeProjectSince: ({ project, day }) => `总结 ${project} 自${day}以来的变更`,
        summarizeProjectToday: ({ project }) => `总结 ${project} 今天的变更`,
        sessionsSince: ({ count, day }) => `自${day}以来 ${count} 个会话`,
        sessionsToday: ({ count }) => `今天 ${count} 个会话`,
    } } satisfies Pick<Readonly<Record<string, HomeComposerTranslation>>, "zh-Hans">;

return { homeComposerTranslations };
})();

const Domain_homeDeviceApprovalTranslations = (() => {
type HomeDeviceApprovalTranslation = Shared_homeDeviceApprovalTranslations.HomeDeviceApprovalTranslation;

const homeDeviceApprovalTranslations = { 'zh-Hans': {
        title: '设备批准', deviceFallback: '新设备',
        homeLabel: ({ home }) => `Home：${home}`, expiresLabel: ({ expiry }) => `到期时间：${expiry}`,
        requestDetails: '请求详情', requestDetailsHint: '显示请求密钥标识符',
        fingerprintLabel: '请求密钥指纹', requestDetailsHelp: '这是请求密钥的标识符，不是需要对比的代码。',
        approve: '批准', reject: '拒绝', loadError: '无法加载设备批准请求。',
        loadErrorUnreachable: ({ homes }) => `${homes} 没有响应。`, loadErrorFailed: ({ homes }) => `${homes} 返回了错误。`,
        decisionError: '无法更新此请求。', decisionRecovery: '请选择“批准”或“拒绝”后重试。',
        approved: '设备已批准', rejected: '设备已拒绝', expired: '已过期', stopWaiting: '停止等待',
    } } as const satisfies Pick<Record<string, HomeDeviceApprovalTranslation>, "zh-Hans">;

return { homeDeviceApprovalTranslations };
})();

const Domain_homeFeatureTranslations = (() => {
const en = Shared_homeFeatureTranslations.en;

const zhHans: typeof en = {
    teams: {
        title: '团队',
        description: '共享会话、机器和访问权限的群组。',
        credentialResources: {
            title: '团队凭据',
            description: '团队与其会话共享的凭据。',
            externalApi: {
                title: '团队凭据 API',
                description: '外部工具通过 API 使用团队的凭据。',
            },
        },
    },
    automations: {
        title: '自动化',
        description: '按计划或触发执行的代理任务。',
    },
    workflows: {
        title: '工作流',
        description: '多步骤的代理流水线。',
    },
    pets: {
        sync: {
            title: '宠物同步',
            description: '让每个人的宠物在其所有设备上保持一致。',
        },
    },
    voice: {
        title: '语音',
        description: '与你的代理对话。',
        happierVoice: {
            title: 'Happier 语音',
            description: '通过这个 Home 提供的语音服务使用语音。',
        },
    },
    connectedServices: {
        group: '已连接服务',
        quotas: {
            title: '配额计量',
            description: '显示每个已连接账户剩余的配额。',
        },
        subscription: {
            title: '订阅状态',
            description: '显示每个已连接账户的套餐和状态。',
        },
        accountGroups: {
            title: '账户组',
            description: '将已连接账户组成账户池。',
        },
        accountFallback: {
            title: '账户切换',
            description: '一个账户用完时切换到池中的下一个账户。',
        },
        autoQuotaReset: {
            title: '自动重置配额',
            description: '池中所有账户用完后，使用积攒的配额重置次数。',
        },
        autoDisablePlanInvalid: {
            title: '跳过不可用账户',
            description: '停用池中无法使用所选模型的账户。',
        },
        poolQuotaLimitSelection: {
            title: '账户池配额限制',
            description: '选择每个账户池遵循的提供商配额。',
        },
    },
    updates: {
        ota: {
            title: 'OTA 更新',
            description: '应用无需通过应用商店即可安装更新。',
        },
    },
    attachments: {
        uploads: {
            title: '附件',
            description: '向会话中的代理发送文件和图片。',
        },
    },
    sharing: {
        group: '共享',
        session: {
            title: '会话共享',
            description: '与这个 Home 上的某人共享会话。',
        },
        public: {
            title: '公开链接',
            description: '通过公开链接共享会话内容。',
        },
        contentKeys: {
            title: '加密共享',
            description: '交换密钥，让共享的会话保持端到端加密。',
        },
        pendingQueueV2: {
            title: '共享消息队列',
            description: '代理忙碌时，将共享会话的消息排入队列。',
        },
        pendingDeliveryState: {
            title: '队列送达跟踪',
            description: '记录哪些排队消息已送达代理。',
        },
    },
    sessions: {
        title: '会话',
        description: '会话及其控制。',
        group: '会话',
        handoff: {
            title: '会话移交',
            description: '将正在运行的会话移到另一台机器。',
        },
        ephemeralRunner: {
            title: '临时运行器',
            description: '在一次性机器上启动会话。',
        },
        agentSwitching: {
            title: '切换代理',
            description: '用另一个编码代理继续会话。',
        },
        folders: {
            title: '会话文件夹',
            description: '用文件夹整理会话。',
        },
        drafts: {
            title: '同步草稿',
            description: '在每台设备上保留未发送的消息和新会话草稿。',
        },
        following: {
            title: '关注',
            description: '关注会话以接收其更新和通知。',
        },
        conversations: {
            title: '对话',
            description: '成员在共享会话中交谈并互相提及。',
        },
        board: {
            title: '会话看板',
            description: '在共享看板上排列会话及其条目。',
        },
        filteredListing: {
            title: '筛选列表',
            description: '在分页之前筛选这个 Home 上的会话列表。',
        },
        usageLimitRecovery: {
            title: '用量限制恢复',
            description: '代理达到用量限制时，等待后继续或重试。',
        },
    },
    machines: {
        title: '机器',
        description: '与你的机器的连接。',
        group: '机器',
        pools: {
            title: '机器池',
            description: '一台机器离线时切换到下一台。',
        },
        transfer: {
            title: '机器间传输',
            description: '在机器之间传输数据。',
            directPeer: {
                title: '直接传输',
                description: '在机器之间直接传输数据。',
            },
            serverRouted: {
                title: '经由这个 Home 传输',
                description: '机器无法直接连接时，经由这个 Home 传输数据。',
            },
        },
        peerMediation: {
            title: '机器间连接',
            description: '机器之间的隧道、流和访问。',
            observability: {
                title: '连接诊断',
                description: '显示机器之间的隧道、流和预览是如何连接的。',
            },
        },
        tunnel: {
            title: '机器隧道',
            description: '在机器之间开放端口。',
            directPeer: {
                title: '直接隧道',
                description: '在机器之间直接开放端口。',
            },
            serverRouted: {
                title: '经由这个 Home 的隧道',
                description: '机器无法直接连接时，经由这个 Home 开放端口。',
            },
        },
        liveStream: {
            title: '直播',
            description: '串流机器的屏幕。',
            directPeer: {
                title: '直接直播',
                description: '将机器的屏幕直接串流到你的设备。',
            },
            serverRouted: {
                title: '经由这个 Home 的直播',
                description: '直接串流失败时，经由这个 Home 串流机器的屏幕。',
            },
        },
        rpc: {
            title: '机器调用',
            description: '直接连接机器。',
            directPeer: {
                title: '直接调用机器',
                description: '直接连接机器，而不经由这个 Home。',
            },
        },
    },
    localServices: {
        title: '本地服务',
        description: '查看并打开机器上运行的服务。',
        group: '本地服务',
        inventory: {
            title: '服务清单',
            description: '列出每台机器上运行的端口和服务。',
        },
        managed: {
            title: '托管服务',
            description: '在 Happier 中启动、命名和监控服务。',
        },
        launcher: {
            title: '服务启动器',
            description: '推荐可打开和预览的服务。',
        },
        actions: {
            title: '服务操作',
            description: '复制、预览和移除服务。',
            terminate: {
                title: '停止服务',
                description: '停止检测到的服务进程。',
            },
        },
        preview: {
            title: '服务预览',
            description: '在会话中私密预览本地服务。',
        },
        publicPreview: {
            title: '公开预览',
            description: '通过公开地址共享服务预览。',
        },
    },
    browser: {
        title: '浏览器',
        description: '在 Happier 中打开页面、预览和托管视图。',
        group: '浏览器',
        viewTargets: {
            title: '浏览器视图',
            description: '在合适的视图中打开预览、插件页面和链接。',
        },
        internal: {
            title: '内置浏览器',
            description: '在 Happier 中使用独立的会话和配置文件浏览。',
        },
        sidecar: {
            title: '辅助浏览器',
            description: '用于繁重自动化的独立托管浏览器。',
        },
        diagnostics: {
            title: '浏览器开发者工具',
            description: '内置浏览器的控制台、网络和 devtools 事件。',
        },
        context: {
            title: '浏览器上下文',
            description: '将页面内容附加到消息或代理。',
        },
        automation: {
            title: '浏览器自动化',
            description: '代理在内置浏览器中点击、输入和导航。',
        },
        recording: {
            title: '浏览器录制',
            description: '将浏览器会话录制为证据。',
        },
    },
    plugins: {
        title: 'Happier 之外的插件',
        description: '从 npm 和你自己的来源安装插件。',
        group: '插件',
        webhooks: {
            title: '插件 Webhook',
            description: '插件接收外部服务的 Webhook。',
        },
        ui: {
            title: '插件界面',
            description: '显示插件提供的界面和面板。',
            hostedWeb: {
                title: 'Web 插件界面',
                description: '显示为 Web 构建的插件界面。',
            },
            reactNativeBundles: {
                title: '原生插件界面',
                description: '运行用 React Native 构建的受信任插件界面。',
            },
        },
    },
    devices: {
        title: '设备',
        description: '模拟器和已连接的设备。',
        simulatorPreview: {
            title: '模拟器预览',
            description: '显示你机器上的模拟器。',
        },
    },
    social: {
        friends: {
            title: '好友',
            description: '添加好友并查看他们共享的内容。',
        },
    },
    auth: {
        group: '登录',
        recovery: {
            providerReset: {
                title: '通过提供商重置',
                description: '通过账户的身份提供商登录来恢复账户。',
            },
        },
        login: {
            keyChallenge: {
                title: '密钥登录',
                description: '通过证明设备的密钥登录。',
            },
        },
        mtls: {
            title: '客户端证书',
            description: '使用客户端证书 (mTLS) 登录。',
        },
        ui: {
            recoveryKeyReminder: {
                title: '恢复密钥提醒',
                description: '提醒成员保存恢复密钥。',
            },
        },
        pairing: {
            desktopQrMobileScan: {
                title: '扫码登录',
                description: '在手机上扫描电脑上的代码来登录。',
            },
            boundQrV2: {
                title: '更安全的配对码',
                description: '只对这个 Home 和这个方向有效的配对码。',
            },
        },
    },
    encryption: {
        group: '加密',
        plaintextStorage: {
            title: '不加密存储',
            description: '不使用端到端加密存储会话。',
        },
        accountOptOut: {
            title: '关闭加密',
            description: '每个人都可以关闭端到端加密。',
        },
    },
    remoteHosts: {
        group: '远程主机',
        management: {
            title: '远程主机',
            description: '保存用于运行会话的 SSH 主机。',
        },
        secretMaterial: {
            title: '已保存的主机密钥',
            description: '保存 SSH 主机的密码和密钥。',
        },
    },
    e2ee: {
        keylessAccounts: {
            title: '无密钥账户',
            description: '没有端到端加密密钥的账户。',
        },
    },
    bugReports: {
        title: '错误报告',
        description: '发送附带诊断信息的错误报告。',
    },
    terminal: {
        group: '终端',
        embeddedPty: {
            title: '终端',
            description: '在 Happier 中打开机器上的终端。',
        },
        transport: {
            byteStream: {
                title: '流式终端',
                description: '为内置终端提供更快的连接。',
            },
        },
    },
    search: {
        title: '搜索',
        description: '搜索会话和转录内容。',
    },
    providers: {
        title: '模型提供商',
        description: '连接模型提供商并为代理选择模型。',
        group: '模型提供商',
        localDiscovery: {
            title: '发现本地提供商',
            description: '查找机器上运行的模型服务器。',
        },
        localModelManagement: {
            title: '本地模型管理',
            description: '下载并管理本地模型。',
        },
    },
    keys: {
        HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: {
            title: '报告服务地址',
            description: '错误报告的发送位置。留空则不提供报告服务。',
        },
        HAPPIER_FEATURE_BUG_REPORTS__DEFAULT_INCLUDE_DIAGNOSTICS: {
            title: '默认包含诊断信息',
            description: '除非报告者选择不包含，报告表单会附带诊断信息。',
        },
        HAPPIER_FEATURE_BUG_REPORTS__MAX_ARTIFACT_BYTES: {
            title: '附件大小上限',
            description: '错误报告可附加的最大文件，以字节为单位。',
        },
        HAPPIER_FEATURE_BUG_REPORTS__UPLOAD_TIMEOUT_MS: {
            title: '上传时限',
            description: '错误报告上传可用的时长，以毫秒为单位。',
        },
        HAPPIER_FEATURE_BUG_REPORTS__ACCEPTED_ARTIFACT_KINDS: {
            title: '接受的附件类型',
            description: '错误报告接受的附件类型。留空则接受常用类型。',
        },
        HAPPIER_FEATURE_BUG_REPORTS__CONTEXT_WINDOW_MS: {
            title: '上下文时间窗口',
            description: '错误报告回溯收集上下文的时长，以毫秒为单位。',
        },
        HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: {
            title: '语音需要订阅',
            description: '只有订阅者可以使用语音。未设置时，生产环境要求订阅，其他环境不要求。',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_MANIFEST_BYTES: {
            title: '宠物清单大小上限',
            description: '接受的宠物清单最大大小，以字节为单位。',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_SPRITESHEET_BYTES: {
            title: '宠物精灵图大小上限',
            description: '接受的宠物精灵图最大大小，以字节为单位。',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_PACKAGE_BYTES: {
            title: '宠物包大小上限',
            description: '接受的宠物包最大大小，以字节为单位。',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PETS_PER_ACCOUNT: {
            title: '每人导入的宠物数',
            description: '每人最多可保留的导入宠物数量。',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PET_BYTES_PER_ACCOUNT: {
            title: '每人导入宠物的存储空间',
            description: '每人最多可保留的导入宠物字节数。',
        },
        HAPPIER_FEATURE_PETS_SYNC__ENCRYPTED_CUSTOM_PET_SYNC_POLICY: {
            title: '加密的自定义宠物',
            description: '预留供日后使用。加密的自定义宠物尚不同步，因此保持关闭。',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES: {
            title: '经由这个 Home 的传输上限',
            description: '经由这个 Home 的传输可携带的最大文件，以字节为单位。',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_ACTIVE_TRANSFERS_PER_SOCKET: {
            title: '每个连接的同时传输数',
            description: '一个连接经由这个 Home 同时进行的传输数上限。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES: {
            title: '每条隧道的数据量',
            description: '经由这个 Home 的一条隧道最多可携带的字节数。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_ACTIVE_TUNNELS_PER_SOCKET: {
            title: '每个连接的隧道数',
            description: '一个连接经由这个 Home 同时保持打开的隧道数上限。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: '隧道帧大小上限',
            description: '经由这个 Home 的隧道可携带的最大帧，以字节为单位。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__SUPPORTED_ENCODINGS: {
            title: '隧道编码',
            description: '经由这个 Home 的隧道接受的帧编码。留空则使用标准编码。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__PREFERRED_ENCODING: {
            title: '首选隧道编码',
            description: '优先使用的帧编码。必须是接受的编码之一。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BINARY_HEADER_BYTES: {
            title: '帧头大小上限',
            description: '二进制帧头的最大大小，以字节为单位。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_RAW_PAYLOAD_BYTES: {
            title: '帧负载大小上限',
            description: '单个帧中原始负载的最大大小，以字节为单位。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAMED_MESSAGE_BYTES: {
            title: '分帧消息大小上限',
            description: '分帧消息的最大大小，以字节为单位。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_CONCURRENT_SUBSTREAMS: {
            title: '每条隧道的同时流数',
            description: '一条隧道同时运行的流数上限。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_TOTAL_SUBSTREAMS: {
            title: '每条隧道的流数',
            description: '一条隧道在其生命周期内可打开的流数上限。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES_PER_SUBSTREAM: {
            title: '每个流的数据量',
            description: '一个流最多可携带的字节数。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_AGGREGATE_BYTES: {
            title: '每条隧道所有流的数据量',
            description: '一条隧道的所有流合计最多可携带的字节数。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SUBSTREAM_IDLE_MS: {
            title: '空闲流时限',
            description: '流在关闭前可保持空闲的时长，以毫秒为单位。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SESSION_IDLE_MS: {
            title: '空闲隧道时限',
            description: '经由这个 Home 的隧道在关闭前可保持空闲的时长，以毫秒为单位。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_IDLE_MS: {
            title: '隧道空闲时限',
            description: '隧道在关闭前可保持空闲的时长，以毫秒为单位。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_DURATION_MS: {
            title: '隧道最长时长',
            description: '隧道保持打开的最长时间，以毫秒为单位。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: {
            title: '隧道可访问的端口',
            description: '隧道可开放的端口。留空则仅允许默认端口。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__TOKEN_TTL_MS: {
            title: '预览链接有效期',
            description: '私密预览链接的有效时长，以毫秒为单位。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: {
            title: '预览域名',
            description: '为每个预览提供独立地址的域名。留空则在这个 Home 的地址下提供预览。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: {
            title: '公开预览模式',
            description: '预览可以公开的方式。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: {
            title: '公开预览最长时长',
            description: '预览保持公开的最长时间，以毫秒为单位。留空则使用标准上限。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_CONCURRENT_EXPOSURES: {
            title: '同时公开的预览数',
            description: '同时公开的预览数上限。留空则使用标准上限。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: {
            title: '要求 DNS 和 TLS',
            description: '公开预览需要 DNS 和 TLS。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_SINK: {
            title: '公开预览审计日志',
            description: '公开预览的记录位置。公开预览必须配置此项。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_LOG_PATH: {
            title: '审计日志文件',
            description: '公开预览审计日志写入的文件。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: {
            title: '允许测试审计日志',
            description: '仅用于开发：接受内存中的测试审计日志。生产环境中会被忽略。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: {
            title: '公开预览速率限制',
            description: '公开预览可使用的速率限制配置。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER: {
            title: '速率限制检查器',
            description: '公开预览请求的速率限制方式。公开预览必须配置此项。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS: {
            title: '每个窗口的请求数',
            description: '公开预览在每个窗口内允许的请求数。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS: {
            title: '速率限制窗口',
            description: '每个速率限制窗口的时长，以毫秒为单位。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: {
            title: '允许测试速率限制器',
            description: '仅用于开发：接受内存中的测试速率限制器。生产环境中会被忽略。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_REQUESTS: {
            title: '处理中的 Webhook',
            description: '此服务器同时处理的 Webhook 请求数上限。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_WORKING_BYTES: {
            title: 'Webhook 内存',
            description: '处理中的 Webhook 请求最多可使用的内存，以字节为单位。留空则按请求数上限所允许的量。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_RATE_PER_MINUTE: {
            title: '每个路由每分钟的 Webhook 数',
            description: '一个路由上每分钟的 Webhook 请求数。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_CONCURRENCY: {
            title: '每个路由的同时 Webhook 数',
            description: '一个路由上处理中的 Webhook 请求数。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_RATE_PER_MINUTE: {
            title: '每个端点每分钟的 Webhook 数',
            description: '一个端点上每分钟的 Webhook 请求数。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_CONCURRENCY: {
            title: '每个端点的同时 Webhook 数',
            description: '一个端点上处理中的 Webhook 请求数。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_RATE_PER_MINUTE: {
            title: '每人每分钟的 Webhook 数',
            description: '每人每分钟的 Webhook 请求数。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_CONCURRENCY: {
            title: '每人的同时 Webhook 数',
            description: '每人处理中的 Webhook 请求数。',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES: {
            title: '插件界面包大小上限',
            description: '这个 Home 托管的插件界面包最大大小，以字节为单位。',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES: {
            title: '每人的插件界面存储空间',
            description: '每人最多可存储的插件界面包字节数。',
        },
        HAPPIER_COLLECTION_MAX_ROW_ENCODED_BYTES: {
            title: '插件数据行大小上限',
            description: '插件存储的单行最大大小，以字节为单位。',
        },
        HAPPIER_COLLECTION_MAX_BATCH_BYTES: {
            title: '插件数据批次大小上限',
            description: '一批插件数据更改的最大大小，以字节为单位。',
        },
        HAPPIER_COLLECTION_MAX_BATCH_ROWS: {
            title: '每批插件数据的行数',
            description: '一批插件数据更改中的行数上限。',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: {
            title: '每人的插件数据行数',
            description: '每人最多可存储的插件数据行数。',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_BYTES: {
            title: '每人的插件数据存储空间',
            description: '每人最多可存储的插件数据字节数。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_BITRATE_BPS: {
            title: '直播最高码率',
            description: '经由这个 Home 的直播的最高码率，以比特/秒为单位。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAMES_PER_SECOND: {
            title: '直播最高帧率',
            description: '经由这个 Home 的直播的最高帧率。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: '直播帧大小上限',
            description: '经由这个 Home 的直播的最大帧，以字节为单位。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_DURATION_MS: {
            title: '直播最长时长',
            description: '经由这个 Home 的直播可持续的最长时间，以毫秒为单位。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_TOTAL_BYTES: {
            title: '每场直播的数据量',
            description: '经由这个 Home 的一场直播最多可携带的字节数。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_ACCOUNT: {
            title: '每人的同时直播数',
            description: '每人经由这个 Home 同时进行的直播数上限。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_SOCKET: {
            title: '每个连接的同时直播数',
            description: '一个连接经由这个 Home 同时进行的直播数上限。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_MACHINE: {
            title: '每台机器的同时直播数',
            description: '一台机器经由这个 Home 同时进行的直播数上限。',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: {
            title: '连接签名密钥 ID',
            description: '指定为机器之间的连接签名的密钥。没有签名密钥时，这些连接会关闭。',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: {
            title: '连接签名私钥',
            description: '为机器之间的连接签名的私钥。',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: {
            title: '连接签名公钥',
            description: '与签名密钥匹配的公钥。留空时从私钥推导。',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: {
            title: '签名密钥到期时间',
            description: '签名密钥的到期时间，以毫秒时间戳表示。',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: {
            title: '按用户名查找好友',
            description: '除了通过关联账户，也可以按用户名查找好友。',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__IDENTITY_PROVIDER: {
            title: '好友匹配提供商',
            description: '用于匹配好友的登录提供商。',
        },
    },
};

const homeFeatureTranslations = { zhHans } as const;

return { homeFeatureTranslations };
})();

const Domain_homeGovernanceTranslations = (() => {
const en = Shared_homeGovernanceTranslations.en;

const zhHans: typeof en = {
    title: 'Home 管理',
    pages: {
        features: '这个 Home 提供的功能。更改会在下次刷新时在所有地方生效。',
        data: '这个 Home 保留哪些数据，以及保留多久。',
        homes: '你管理的每个 Home 的账户、角色、团队和登录规则。',
        overview: '谁在管理此 Home，以及你可以在此更改什么。',
        people: '此 Home 上的账户、其角色以及能否登录。',
        policies: '谁可以登录、谁可以创建账户和团队，以及数据如何受到保护。',
        teams: '此 Home 上的所有团队。管理团队并不会让你访问其会话。',
        identityProvider: '可用于登录此 Home 的身份服务。',
        identityProviderEditor: '此身份服务的连接方式以及它接纳哪些人。',
        githubApp: '此 Home 用于访问仓库的 GitHub App。',
        githubAppEditor: '为此 Home 注册或更改 GitHub App。',
        email: '这个 Home 如何发送邮件。',
        reach: '设备、邀请链接和邮件如何找到这个 Home。',
        runtime: '运行这个 Home 的服务器。',
        activity: '谁在这个 Home 上更改了什么，以及何时更改。',
    },
    overview: '概览',
    people: '成员',
    teams: '团队',
    policies: '策略',
    console: {
        serverSettings: '服务器设置',
        serverSettingsDescription: '服务器读取的每项设置，以及更改何时生效。',
        allHomes: '所有 Home',
        backToHomes: '返回 Home 列表',
        viewerOwner: '你是所有者',
        viewerAdmin: '你是管理员',
        noOwnerYet: '尚无所有者',
        administer: '管理',
        navigation: 'Home 管理页面',
    },
    /** The console Overview (lab `hcOverview-A`): what needs the owner, who owns the Home, and its facts. */
    overviewPage: {
        description: '谁在运行这个 Home，以及需要你处理的事项。',
        attention: '需要你处理',
        emailNotSetUpTitle: '尚未设置邮件',
        emailNotSetUpBody: '大家无法验证地址、重置密码，也收不到邮件邀请。',
        emailNoLinkTitle: '邮件暂时无法包含链接',
        emailNoLinkBody: '邮件发送已设置，但这个 Home 没有用于链接的网页应用地址。',
        emailPasswordTitle: '无法读取邮件密码',
        emailPasswordBody: '请重新输入 SMTP 密码，以便这个 Home 能发送邮件。',
        setUpEmail: '设置邮件',
        openEmail: '打开邮件',
        noAddressTitle: '没有公开地址',
        noAddressBody: '其他网络上的设备和邀请链接无法访问这个 Home。',
        setUpReach: '设置',
        pendingBody: '已保存，等待服务器重启。',
        fixedBody: '在服务器环境中设置；请在那里修改。',
        review: '查看',
        settingsFailed: '无法检查这个 Home 的设置',
        emailFailed: '无法读取这个 Home 的邮件状态',
        reachFailed: '无法读取这个 Home 的访问方式',
        ownership: '所有者',
        ownerYou: '所有者 · 你',
        peopleFailed: '无法读取这个 Home 的成员',
        thisHome: '这个 Home',
        version: '版本',
        signIn: '登录',
        signInOpen: '任何人都可以创建账户',
        signInInvited: '仅限邀请',
        signInNone: '没有启用任何登录方式',
        fixedTitle: ({ count }: { count: number }) => `${count} 项设置由部署固定`,
        /** People · owners · admins; `more` while the Home has further pages, `admins` null when unknown. */
        peopleSummary: ({ people, more, owners, admins }: { people: number; more: boolean; owners: number; admins: number | null }) => [`${people}${more ? '+' : ''} 人`, `${owners} 位所有者`, admins === null ? null : `${admins} 位管理员`].filter((part) => part !== null).join(' · '),
    },
    /** "Invite people" on Overview, People and Teams: one dialog over the Team invitation form. */
    invite: {
        action: '邀请成员',
        description: '加入某个团队即可加入这个 Home。',
        team: '团队',
        noTeams: '还没有你可以邀请加入的团队',
        noTeamsBody: '成员通过团队加入 Home。请先创建一个团队。',
        notAdministered: '你无法邀请成员加入这个 Home 的团队',
        notAdministeredBody: '每个团队由其所有者和管理员邀请成员。请联系他们，或创建你自己的团队。',
        createTeam: '创建团队',
        notAdministeredAskBody: '每个团队由其所有者和管理员邀请成员，请联系他们。',
        joinByTeam: '成员通过团队加入 Home。',
        teamsFailed: '无法读取这个 Home 的团队',
    },

    yourRole: '你的角色',
    roleOwner: '所有者',
    roleAdmin: '管理员',
    roleMember: '成员',
    activeOwners: '活跃所有者',
    accountSection: '账户',
    accountAccessSection: '访问',
    homeAddress: 'Home 地址',

    setupRequiredTitle: '需要设置 Home 管理',
    setupRequiredBody: '此 Home 还没有活跃的所有者。有服务器访问权限的人会在运行它的机器上指定第一位所有者。',

    manageTeams: '管理团队',
    manageTeamsSubtitle: '管理此 Home 上的团队。这不会让你访问它们的会话。',
    teamsDisabled: '此 Home 未启用团队。',
    teamsEmpty: '此 Home 还没有团队。',

    loading: '正在加载此 Home…',
    refreshing: '正在刷新…',
    updating: '正在更新…',
    staleNotice: '正在显示此 Home 最后已知的状态。在它再次响应前无法进行更改。',
    offlineNotice: '此 Home 没有响应。你可以继续查看，但无法更改。',
    unavailableTitle: '此 Home 不可用',
    unavailableBody: 'Happier 无法读取此 Home 的管理状态。',
    forbiddenTitle: '你无法管理此 Home',
    forbiddenBody: '你的账户在此没有 Home 管理权限。',
    retry: '重试',
    loadMore: '加载更多',
    unsupportedBody: '此 Home 不提供管理功能。它可能运行着较旧的版本。',
    notObservedTitle: '尚未加载',
    notObservedBody: '此 Home 尚未向此设备报告其管理状态。',
    lastUpdated: ({ time }: { time: string }) => `最后更新于 ${time}`,

    chooseHome: '选择一个 Home',
    chooseHomeFooter: '每个 Home 都有各自的账户、角色和策略。',
    homesEmpty: '还没有 Home',
    homesEmptyBody: '将 Home 添加到此设备后即可在这里管理。',
    homesNoneAdministrable: '没有可管理的 Home',
    homesNoneAdministrableBody: '当前显示的 Home 都没有授予此账户管理权限。',
    homeNotAnswering: ({ home }: { home: string }) => `${home} 没有响应`,
    signedOutTitle: '已退出此 Home',
    signedOutBody: '重新登录此 Home 即可进行管理。',
    credentialUnreadableTitle: '无法读取此设备上保存的登录信息',
    credentialUnreadableBody: '问题出在此设备上，而不是 Home，你并未退出登录。请重试。',
    credentialUnreadableInviteBody: '问题出在此设备上，而不是 Home。你的邀请链接仍然有效，可以现在重试，也可以稍后再回来。',

    peopleEmpty: '此 Home 上还没有账户。',
    rosterUnavailableTitle: '成员列表尚不可用',
    rosterUnavailableBody: '此 Home 尚未向 Happier 提供账户列表。提供后，角色和状态会显示在这里。',
    accountUnavailableBody: '此账户尚无法从该 Home 获取。',
    searchPlaceholder: '搜索账户',
    searchResults: '搜索结果',
    searchResultsFooter: '打开账户可查看其角色和状态。',
    searchEmpty: '没有与该搜索匹配的账户。',
    searchUnsupported: '此 Home 不支持搜索',
    searchUnsupportedBody: '此 Home 未提供账户搜索，可能运行着较旧的版本。',
    searchFailed: '搜索未能完成',
    searchFailedBody: '此 Home 未响应搜索。修改文字后可再试一次。',

    statusActive: '活跃',
    statusDisabled: '已停用',
    statusRetired: '已注销',
    statusDisabledDetail: '已在所有设备退出登录。可重新启用。',
    statusRetiredDetail: '访问权限已永久撤销。',

    changeRole: '更改角色',
    disable: '停用账户',
    enable: '重新启用账户',
    deleteAccount: '删除账户和数据…',
    retryDeletion: '重试删除',

    reasonLastActiveOwner: '此 Home 至少需要一位活跃的所有者。请先让另一个账户成为所有者。',
    reasonTargetInactive: '只有活跃账户才能拥有 Home 角色。',
    reasonHomeUnreachable: '此 Home 没有响应。重新连接后才能更改。',

    roleSheetTitle: 'Home 角色',
    roleOwnerDescription: '可以管理此 Home 的一切，包括删除账户。',
    roleAdminDescription: '可以管理账户和团队，但不能更改所有者。',
    roleMemberDescription: '没有 Home 管理权限。',

    disableTitle: ({ account }: { account: string }) => `要停用 ${account} 吗？`,
    disableBody: '该成员将在所有设备上退出登录，其机器也会断开连接。个人访问令牌将被永久吊销，会话负责人身份将被清除；在其失去访问权限的每个会话中，未发送的草稿会被丢弃，关注也会被移除。重新启用会恢复访问权限，但不会恢复这些草稿、关注或负责人身份。团队成员身份和加密密钥会保留。',
    disableConfirm: '停用',
    enableTitle: ({ account }: { account: string }) => `要重新启用 ${account} 吗？`,
    enableBody: '该成员可以在自己的设备上重新登录。此前撤销的访问令牌仍然无效。',
    enableConfirm: '重新启用',
    deleteTitle: ({ account }: { account: string }) => `要删除 ${account} 及其全部数据吗？`,
    deleteBody: ({ home }: { home: string }) => `这会永久删除 ${home} 上的该账户及其数据，且无法撤销。Home 或团队的所有权必须先行转移。`,
    deleteConfirm: '删除',

    deleteIncompleteTitle: '删除未完成',
    deleteIncompleteBody: '访问权限已撤销，此账户现已注销，但清理未完成。请重试删除以完成。',
    deleteIncompleteMemberBody: '访问权限已撤销，但清理未完成。Home 所有者或服务器运维人员可以完成它。',

    errorForbidden: '你在此 Home 上已不再拥有进行此更改的权限。',
    errorOwnerTransferRequired: '此 Home 至少需要一位活跃的所有者。请先让另一个账户成为所有者。',
    errorTeamOwnerTransferRequired: '某个团队仍需要此账户作为所有者。请先为该团队指定另一位所有者。',
    errorAccountNotFound: '此账户已不在该 Home 中。',
    errorAccountInactive: '此账户未处于活跃状态，无法获得该权限。',
    errorErasureTransitionCleanupPending: '账户删除正在等待加密数据清理完成。请再次尝试删除账户。',
    errorGeneric: '此 Home 无法完成更改。未做任何更改。',
    errorConflict: '此处已先被其他更改修改。请刷新此 Home 后重试。',
    changeFailedTitle: '更改未完成',
    errorOutcomeUnknownTitle: '此更改未确认',
    errorOutcomeUnknown: '请求已送达此 Home，但响应丢失。更改可能已生效。请先刷新此 Home 确认后再重试。',

    teamCreation: '团队创建',
    teamCreationSelfService: '任何人都可以创建团队',
    teamCreationSelfServiceDescription: '此 Home 的活跃成员可以创建团队并成为其所有者。',
    teamCreationManagedOnly: '由管理员创建团队',
    teamCreationManagedOnlyDescription: '所有者和管理员创建团队并选择初始所有者。',
    teamCreationDisabled: '停用团队创建',
    teamCreationDisabledDescription: '不再创建新团队。现有团队保持不变。',
    teamsVisibility: '谁能看到团队',
    teamsVisibleToMembers: '向成员显示团队',
    teamsVisibleToMembersDescription: '关闭后，只有团队成员和管理员能看到团队。',
    teamJit: '登录时自动加入团队',
    teamJitDescription: '通过团队关联的身份提供方登录后，将自动加入该团队，无需邀请或审批。',
    githubEnterpriseOrigins: '已批准的 GitHub Enterprise 主机',
    githubEnterpriseOriginsDescription: '每行输入一个规范 HTTPS 源。团队只能将 GitHub App 连接到这些主机。',
    githubEnterpriseOriginsInvalid: '请输入不含路径、查询、凭据或片段的唯一 HTTPS 源。',

    signInTitle: '登录与加入',
    authActionLogin: '登录',
    authActionProvision: '新账户',
    authActionConnect: '账户关联',
    authReasonMethodNotEnabled: '登录方式已停用',
    authReasonProvisioningNotEnabled: '账户创建已停用',
    authReasonAccountModeUnavailable: '账户类型不可用',
    authReasonEmailDeliveryUnavailable: '邮件发送不可用',
    authInherited: '使用服务器默认设置',
    authInheritedDescription: '此 Home 未限制登录方式或账户类型。',
    authNarrowed: '由此 Home 限制',
    authUnreadable: '配置需要处理',
    authUnreadableDescription: '此 Home 保存了该服务器版本无法读取的登录配置。在运维人员修复之前，登录不可用。',
    signInMethods: '登录方式',
    accountModes: '账户类型',
    accountModePlain: '普通',
    accountModeE2ee: '端到端加密',
    recommendedMode: '新账户推荐',
    recommendedModeDescription: '设置新账户的默认值。现有账户不会更改。',
    admissionSelfService: '任何人',
    admissionInvitationOnly: '仅限邀请',
    admissionClosed: '无人',

    deploymentServices: '部署服务',
    deploymentServicesDescription: '由运维者为该服务器配置的身份服务。无法在 Home 管理中更改。',
    deploymentWorkosConfigured: '已配置',
    deploymentWorkosPartial: '配置不完整',
    deploymentWorkosNotConfigured: '未配置',
    privateEndpoints: '私有身份端点',
    privateEndpointsDescription: '允许托管登录访问私有网络中的身份提供方。只有这里列出的主机、网段和端口可达。',
    privateEndpointsPublicOnly: '仅公共端点',
    privateEndpointsAllowlist: '私有允许列表',
    privateEndpointsHostnames: '允许的主机名',
    privateEndpointsCidrs: '允许的网段 (CIDR)',
    privateEndpointsPorts: '允许的端口',
    privateEndpointsSave: '保存网络策略',
    privateEndpointsInvalid: '请至少填写一个主机名或网段，以及 1 到 65535 之间的端口。',
    privateEndpointsUnreadable: '该 Home 保存了此服务器版本无法读取的网络策略。托管登录仍仅使用公共端点。',

    policyReadOnly: '只有 Home 所有者可以更改。',
    policyEditingUnavailable: '尚无法从此设备更改策略。',
    revisionConflictTitle: '此策略已在别处更改',
    revisionConflictBody: '你编辑时有其他人保存了更改。你的选择已保留——请重新加载此 Home 后再次应用。',
    reload: '重新加载',
    person: {
        you: '你',
        roleDescription: '成员使用 Home;管理员还可以管理人员和 Team。',
        roleChangeTitle: ({ account, role }: { account: string; role: string }) => `将 ${account} 设为${role}?`,
        roleChangeBody: '其对此 Home 的访问权限会立即变更。此操作会以你的名义记录在活动中。',
        roleChangeConfirm: '更改角色',
        signIn: '登录',
        signInDescription: '此人可以用来登录的方式。由其在自己的账户中管理。',
        methods: '方式',
        linkedProviders: '已关联的提供方',
        none: '无',
        teams: 'Team',
        noTeams: '不在任何 Team 中',
        teamArchived: '已归档的 Team',
        teamSuspended: '已暂停',
        access: '访问',
        accessDescription: '已在其设备上登录 — 不单独跟踪会话。',
        machines: '机器',
        apiTokens: 'API 令牌',
        apiTokensLastUsed: ({ time }: { time: string }) => `上次使用:${time}`,
        apiTokensNeverUsed: '从未使用',
        signOutEverywhere: '在所有设备上退出登录',
        signOutEverywhereDescription: '结束其所有设备上的登录会话。在账户被停用之前,API 令牌仍可使用。',
        signOutEverywhereTitle: ({ account }: { account: string }) => `要让 ${account} 在所有设备上退出登录吗?`,
        signOutEverywhereBody: '其已登录的每台设备都需要重新登录。在你停用该账户之前,其 API 令牌仍可使用。此操作会以你的名义记录在活动中。',
        signOutEverywhereDone: '已在所有设备上退出登录',
        recentActivity: '最近活动',
        noRecentActivity: '暂无与此人相关的管理变更。',
        showAllActivity: '查看全部',
        disableOrDelete: '停用或删除',
        dangerFootnote: '停用会让其退出登录并停止其 API 令牌,可以撤销。删除会从此 Home 永久移除其账户和数据。',
    },
    email: {
        title: '邮件',
        status: '状态',
        sendingMail: '发送邮件',
        sendingReady: ({ host }: { host: string }) => `就绪 · 通过 ${host} 发送`,
        sendingNotSetUp: '未设置',
        links: '邮件中的链接',
        linksReady: '在这个 Home 的网页应用中打开',
        linksOpenAt: ({ host }: { host: string }) => `在 ${host} 打开`,
        setInReach: '在访问方式中设置',
        linksMissing: '没有网页应用地址，因此无法生成链接',
        mailServer: '邮件服务器',
        mailServerDescription: '发送验证、密码重置和邀请邮件的 SMTP 服务器。',
        server: '服务器',
        port: '端口',
        portAndSecurity: '端口和安全',
        security: '连接安全',
        tls: 'TLS',
        starttls: 'STARTTLS',
        username: '用户名',
        password: '密码',
        passwordDescription: '加密存储在服务器上，之后不会再显示。',
        saved: '已保存',
        replace: '替换',
        clear: '清除',
        keep: '保留',
        clearPending: '保存后将移除已保存的密码。',
        valueSet: '已设置',
        valueNotSet: '未设置',
        sender: '发件人',
        fromAddress: '发件地址',
        fromName: '发件人名称',
        test: '发送测试邮件',
        testDescription: '发送一条不含链接的简短消息。',
        testTo: '收件人',
        testToPlaceholder: '任意一个你能查看的邮箱',
        testSend: '发送',
        testSaveFirst: '发送测试前请先保存更改。',
        testSent: ({ to }: { to: string }) => `已发送到 ${to}`,
        testSentDetail: '请查看收件箱；如果没有，也请查看垃圾邮件文件夹。',
        testFailed: '无法发送',
        testNotConfigured: '邮件尚未设置。',
        testPasswordUnreadable: '无法读取已保存的密码，请重新输入。',
        testRenderFailed: '无法准备测试消息。',
        testTransportFailed: '无法连接邮件服务器，或服务器拒绝了该消息。',
        adminTitle: '只有所有者可以更改邮件设置',
        adminBody: '你能看到这些设置，是因为你是这个 Home 的管理员。',
        notSetUpTitle: '邮件未设置',
        notSetUpBody: '在设置完成前，密码重置、邮件验证和邮件邀请均处于关闭状态。',
        unreadableTitle: '无法读取已保存的密码',
        unreadableBody: '保存后服务器的主密钥已更改，请重新输入密码。',
        invalidValue: '请输入有效的值。',
        invalidPort: '请使用 1 到 65535 之间的端口。',
        invalidEmail: '请输入邮箱地址。',
        conflictTitle: '邮件设置已在别处更改',
        conflictBody: '你编辑期间有人保存了更改。你的修改已保留：请检查后再次保存。',
        loadFailed: '这个 Home 没有返回邮件设置。',
    },
    signInProviders: {
        title: '登录提供方',
        description: '企业登录、GitHub App 以及 Team 使用的规则。在“策略”中为登录启用提供方。',
        ownersOnlyTitle: '只有所有者可以更改登录提供方',
        ownersOnlyBody: '请让此 Home 的所有者添加或更改身份提供方和 GitHub App。',
        fromDeployment: ({ key }: { key: string }) => `来自你的部署 · ${key} · 只读`,
        workosSetByDeployment: ({ keys }: { keys: string }) => `由你的部署设置 (${keys})`,
        workosSetInServerSettings: ({ keys }: { keys: string }) => `在服务器设置中设置 (${keys})`,
        privateEndpointsFixed: ({ key }: { key: string }) => `由你的部署固定 · ${key}`,
        privateEndpointsOff: ({ key }: { key: string }) => `此 Home 已关闭 · ${key}`,
        teamRules: 'Team 登录规则',
        teamRulesDescription: 'Team 可以在 Home 的提供方之上添加的内容。',
        activity: {
            addedProvider: ({ name }: { name: string }) => `添加了身份提供方 ${name}`,
            changedProvider: ({ name }: { name: string }) => `更改了身份提供方 ${name}`,
            replacedProviderSecret: ({ name }: { name: string }) => `替换了 ${name} 的客户端密钥`,
            enabledProvider: ({ name }: { name: string }) => `开启了 ${name}`,
            disabledProvider: ({ name }: { name: string }) => `关闭了 ${name}`,
            removedProvider: ({ name }: { name: string }) => `移除了身份提供方 ${name}`,
            addedGitHubApp: ({ name }: { name: string }) => `添加了 GitHub App ${name}`,
            changedGitHubApp: ({ name }: { name: string }) => `更改了 GitHub App ${name}`,
            replacedGitHubAppSecrets: ({ name }: { name: string }) => `替换了 GitHub App ${name} 的密钥`,
            verifiedGitHubApp: ({ organization, name }: { organization: string; name: string }) => `在 ${organization} 验证了 ${name}`,
            removedGitHubAppInstallation: ({ organization, name }: { organization: string; name: string }) => `从 ${organization} 移除了 ${name}`,
        },
    },
    reach: {
        title: '访问方式',
        diagramTitle: ({ home }: { home: string }) => `新设备如何到达 ${home}`,
        yourDevices: '你的设备',
        noAddress: '没有公开地址',
        plusDirect: '+ 可行时直连 (Iroh)',
        noDirect: '无直连',
        thisComputer: '这台电脑',
        homeServer: '这个 Home 的服务器',
        diagramDeployment: '由你的部署设置',
        diagramHere: '在此设置',
        diagramInferred: ({ method }: { method: string }) => `${method} · 推断`,
        addresses: '地址',
        addressesDescription: '更改地址不会让任何人退出登录。',
        publicAddress: '公开地址',
        webAppAddress: '网页应用地址',
        accessMethod: '访问方式',
        publicAddressHome: '在此设置',
        publicAddressNone: '未设置。其他网络中的设备无法访问这个 Home。',
        inferredFrom: ({ method }: { method: string }) => `根据托管此 Home 的电脑上的 ${method} 推断`,
        inferredFromHost: '在托管此 Home 的电脑上推断',
        webAppDescription: '邮件和邀请中的链接在这里打开。',
        webAppServed: '链接会在这个 Home 提供的网页应用中打开。',
        webAppDefault: '链接会在 Happier 网页应用中打开。默认',
        change: '更改',
        setAddress: '设置地址',
        httpsRequired: '请使用 https:// 地址。',
        invalidAddress: '请输入完整地址，例如 https://home.example.com。',
        conflict: '这个 Home 的设置已更改，请重试。',
        methodLocalOnly: '仅这台电脑',
        methodLan: '局域网',
        methodTailscaleServe: 'Tailscale Serve',
        methodTailscaleFunnel: 'Tailscale Funnel',
        methodCloudflare: 'Cloudflare Tunnel',
        accessMethodHere: '这台电脑如何对外提供这个 Home。',
        accessMethodRemoteHost: ({ host }: { host: string }) => `在 ${host} 上设置。请在远程主机中打开它。`,
        accessMethodElsewhereNamed: ({ host }: { host: string }) => `在托管此 Home 的电脑（${host}）上设置。请在那里打开 Happier，或把它添加为远程主机。`,
        accessMethodElsewhere: '在托管此 Home 的电脑上设置。请在那里打开 Happier，或把它添加为远程主机。',
        accessMethodDeployment: '由你的部署管理。',
        directConnections: '直连',
        directConnectionsDescription: '设备能直连时直接连接这个 Home，否则使用公开地址。',
        directConnectionsRow: '直连（Iroh）',
        irohActive: '已启用 · 设备在可行时点对点连接',
        irohStarting: '正在启动…',
        irohOff: '已关闭 · 设备通过公开地址连接',
        irohFailed: '未在这台电脑上运行。设备通过公开地址连接。',
        irohNotAvailable: '此部署不可用。设备通过公开地址连接。',
        irohNeedsAddressHint: '关闭前请先设置公开地址',
        irohOffTitle: '关闭直连？',
        irohOffBody: '设备将只通过公开地址连接。这个 Home 当前的直连身份会被永久停用；重新开启会创建一个新身份，设备在下次连接时获取。公开地址和所有人的登录保持不变。',
        irohOffConfirm: '关闭',
        irohNeedsAddressTitle: '请先设置公开地址',
        irohNeedsAddressBody: '没有公开地址时，关闭直连后设备将无法访问这个 Home。',
        relay: '直连中继',
        relayAutomatic: '自动',
        relayOff: '关闭',
        relayCustom: ({ count }: { count: number }) => `你的中继（${count}）· 重启后生效`,
        appliesAfterRestart: '重启后生效',
        appliesAfterRestartPending: '重启后生效 · 待处理',
        exposureInternetTitle: ({ method }: { method: string }) => `可通过 ${method} 从互联网访问`,
        exposureAddressTitle: '你的公开地址开放注册',
        exposureOpenSignup: '任何访问到这个 Home 的人都能创建账号。请在策略中检查谁可以注册。',
        exposureInvitationOnly: '新账号需要邀请，陌生人无法注册。',
        loadFailed: '无法加载这个 Home 的访问方式。',
    },
    runtime: {
        title: '运行时',
        version: '版本',
        versionValue: ({ version }: { version: string }) => `Happier ${version}`,
        versionUnknown: '这个 Home 没有报告版本',
        flavorLight: '轻量服务器',
        flavorFull: '完整服务器',
        server: '服务器',
        restart: '重启',
        restartNow: '立即重启',
        restartFailed: '无法重启服务器',
        restartToApply: '重启服务器以应用这些更改。',
        restartFromDeployment: '请从你的部署重启以应用这些更改。',
        restartFromHost: ({ host }: { host: string }) => `请在托管此 Home 的电脑 ${host} 上重启。`,
        restartFromHostingComputer: '请在托管此 Home 的电脑上重启。',
        managedFrom: ({ host }: { host: string }) => `由 ${host} 管理`,
        managedFromBody: '在托管此 Home 的电脑上打开 Happier 来更新、重启或停止它。',
        managedElsewhere: '由托管此 Home 的电脑管理',
        deploymentTitle: '由你的部署管理',
        deploymentBody: '这台服务器的更新、重启和备份由部署它的人负责。',
        backups: '备份',
        backupsHere: '在运行时页面备份、恢复或迁移这个 Home。',
        backupsFromHost: ({ host }: { host: string }) => `请在托管此 Home 的电脑 ${host} 上备份。`,
        backupsFromHostingComputer: '请在托管此 Home 的电脑上备份。',
        backupsDeployment: '备份由你的部署管理。',
        hostedHere: ({ home }: { home: string }) => `这台电脑托管着 ${home}`,
        hostedHereSubtitle: '在它的 Home 控制台中更新、重启、备份和迁移。',
        pendingRestart: ({ count }: { count: number }) => (count === 1 ? '1 项更改将在重启后生效' : `${count} 项更改将在重启后生效`),
    },
    activity: {
        title: '活动',
        emptyTitle: '暂无活动',
        emptyBody: '登录、邮件、成员、策略和所有权的更改发生后会显示在这里。',
        showOlder: '显示更早的记录',
        footnote: '直接在主机电脑上通过 Happier 执行的操作（例如备份和重启）不会列出。',
        loadFailed: '这个 Home 没有返回活动。',
        deploymentCommand: '部署命令',
        personalHomeSetup: 'Personal Home 设置',
        someone: '某人',
        removedAccount: '已删除的账号',
        claimed: '获得了这个 Home 的所有权',
        madeOwner: ({ target }: { target: string }) => `将 ${target} 设为所有者`,
        assignedOwner: '指定了第一位所有者',
        changedPolicies: '更改了策略',
        changedEmailSetting: '更新了邮件设置',
        changedServerSetting: '更改了服务器设置',
        changedRole: ({ target }: { target: string }) => `更改了 ${target} 的角色`,
        disabled: ({ target }: { target: string }) => `停用了 ${target}`,
        reenabled: ({ target }: { target: string }) => `重新启用了 ${target}`,
        changedStatus: ({ target }: { target: string }) => `更改了 ${target} 的状态`,
        deleted: ({ target }: { target: string }) => `删除了 ${target}`,
        deletionStarted: ({ target }: { target: string }) => `开始删除 ${target}`,
        signedOutEverywhere: ({ target }: { target: string }) => `让 ${target} 在所有设备上退出登录`,
        areaOwnership: '所有权',
        areaPolicies: '策略',
        areaEmail: '邮件',
        areaServerSettings: '服务器设置',
        areaPeople: '成员',
        fieldRole: '角色',
        fieldStatus: '状态',
        fieldTeamProviders: 'Team 登录提供方',
        valueEmpty: '—',
        valueChanged: '已更改',
        valueOn: '开',
        valueOff: '关',
        secretSet: '已设置',
        secretUnset: '未设置',
    },
    signInPolicy: {
        methodsDescription: ({ home }: { home: string }) => `人们如何登录 ${home}。至少保留一种方式开启，任何人都不会失去最后的登录途径。`,
        methodUnavailable: '不可用 — 你的部署无法提供',
        signInService: 'Home 登录服务',
        signInServiceDescription: '通过此 Home 自己的登录服务登录。',
        admissionTitle: '谁可以创建账户',
        newAccounts: '新账户',
        admissionAnyoneDescription: '任何能访问此 Home 的人',
        admissionInvitationDescription: '仅限持有团队邀请的人',
        admissionNobodyDescription: '任何人都无法创建账户',
        anonymousSignup: '匿名注册',
        anonymousSignupDescription: '仅用恢复密钥创建账户，无需电子邮件。',
        encryptionTitle: '加密',
        encryptionDescription: '适用于从现在起创建的账户和会话。现有的永不改变。',
        storagePolicy: '存储策略',
        storageRequired: '必须 E2EE',
        storageOptional: '可选',
        storagePlaintext: '仅明文',
        storageRequiredDescription: '每个账户都保持端到端加密',
        storageOptionalDescription: '每个账户自行选择是否加密',
        storagePlaintextDescription: '账户在没有端到端加密的情况下存储数据',
        storageAppliesAfterRestart: ({ running }: { running: string }) => `重启后生效 · 在此之前为 ${running}`,
        allowE2ee: '端到端加密账户',
        allowPlain: '无端到端加密的账户',
        recommendedInherited: '服务器默认',
        recommendedE2ee: 'E2EE',
        errorWideningUnconfirmed: '此更改会让更多人进入，需要你确认。未做任何更改。',
        widening: {
            titleAnyone: '允许任何人创建账户？',
            titleInvited: '允许受邀者创建账户？',
            titleMethod: ({ method }: { method: string }) => `开启 ${method}？`,
            titleAnonymous: '允许匿名注册？',
            titleUnencrypted: '允许未加密存储？',
            titleOther: '让更多人进入？',
            exposureAnyone: ({ host }: { host: string }) => `任何能通过 ${host} 访问此 Home 的人都将无需邀请即可注册。`,
            exposureInvited: ({ host }: { host: string }) => `任何持有邀请并能通过 ${host} 访问此 Home 的人都将可以创建账户。`,
            exposureMethod: ({ host, method }: { host: string; method: string }) => `任何能通过 ${host} 访问此 Home 的人都将可以用 ${method} 登录。`,
            exposureAnonymous: ({ host }: { host: string }) => `任何能通过 ${host} 访问此 Home 的人都将可以仅用恢复密钥创建账户。`,
            exposureUnencrypted: ({ host }: { host: string }) => `任何能通过 ${host} 访问此 Home 的人都将可以在这里不经端到端加密地保存数据。`,
            exposureOther: ({ host }: { host: string }) => `任何能通过 ${host} 访问此 Home 的人都将可以按放宽后的规则登录或加入。`,
            unchanged: '现有账户和邀请不会改变。',
            recorded: '此更改会以你的名字记录在“活动”中。',
            confirmAnyone: '允许任何人注册',
            confirmInvited: '允许邀请',
            confirmMethod: ({ method }: { method: string }) => `开启 ${method}`,
            confirmAnonymous: '允许匿名注册',
            confirmUnencrypted: '允许未加密存储',
            confirmOther: '应用更改',
        },
    },
    claim: {
        pageDescription: '认领此 Home 的所有权。',
        emptyTitle: '此 Home 还没有所有者',
        emptyBody: '所有者管理登录、邮件、访问方式和人员。在有人认领之前，没有人能管理此 Home。',
        codeTitle: '用一次性代码认领',
        codeDescription: '有服务器访问权限的人打印一个代码。它只能使用一次，15 分钟后过期。',
        printStep: '1 · 在服务器上打印代码',
        pasteStep: '2 · 粘贴到这里',
        codeLabel: '认领代码',
        codePlaceholder: 'XXXX-XXXX-XXXX-XXXX-…',
        claim: '认领',
        refused: '此代码无效。可能输错、已使用或已过期 — 请打印一个新的。',
        hostTitle: ({ home }: { home: string }) => `这台电脑托管着 ${home}`,
        hostBody: '你可以在这里将你的账户设为所有者。只有这台电脑能这样做。',
        makeOwner: '让我成为所有者',
        hostFailed: '这台电脑无法将你设为所有者。请重试。',
    },
    fixedByDeployment: ({ key }: { key: string }) => `由你的部署固定 · ${key}`,
    fixedByDeploymentLead: '由你的部署固定',
    deploymentNotSetLead: '不可用 — 需要你的部署设置',
    features: {
        title: '功能',
        common: '常用',
        advanced: '高级',
        advancedDescription: ({ count }: { count: number }) => `另有 ${count} 项，按领域分组。`,
        other: '其他',
        familyCount_one: '1 项功能',
        familyCount_other: ({ count }: { count: number }) => `${count} 项功能`,
        offHome: '已为这个 Home 关闭。',
        notInBuild: '未包含在此版本中。',
        needs: ({ feature }: { feature: string }) => `需要 ${feature}。`,
        unavailable: '在这个 Home 上不可用。',
        noHomeSwitchOn: '在这个 Home 上始终开启 · 只有 Happier 版本可以关闭它',
        noHomeSwitchOff: '在这个 Home 上已关闭 · 只有 Happier 版本可以开启它',
        unavailableByDeployment: '在这个 Home 上不可用 · 由你的部署配置决定',
        dependentsTitle_one: ({ feature }: { feature: string }) => `关闭 ${feature} 也会关闭 1 项功能`,
        dependentsTitle_other: ({ feature, count }: { feature: string; count: number }) => `关闭 ${feature} 也会关闭 ${count} 项功能`,
        dependentNeeds: ({ feature, parent }: { feature: string; parent: string }) => `${feature} 需要 ${parent}。`,
        turnOff: '关闭',
        deviceTitle: '此设备上的功能',
        deviceBody: '只影响此设备的功能位于设置中。',
        adminTitle: '只有所有者可以更改功能',
        adminBody: '你是管理员，因此可以查看这个 Home 提供的功能。',
        loadFailed: '这个 Home 没有返回功能。',
        conflictTitle: '功能已在别处更改',
        conflictBody: '你查看时有人更改了这个 Home 的设置。页面现在显示的是 Home 中保存的内容。',
        rangeBetween: ({ min, max }: { min: number; max: number }) => `${min}–${max}`,
        rangeAtLeast: ({ min }: { min: number }) => `${min} 或以上`,
        rangeAtMost: ({ max }: { max: number }) => `最多 ${max}`,
        limitInvalid: '请输入范围内的数字。',
        appliesAfterRestart: '重启后生效',
        onAfterRestart: '重启后开启',
        offAfterRestart: '重启后关闭',
        ignoredAtLastStart: ({ reason }: { reason: string }) => `上次启动时已忽略：${reason}`,
        ignoredInvalidType: '保存的值类型错误',
        ignoredOutOfBounds: '保存的值超出范围',
        ignoredSecretUnreadable: '无法读取保存的密钥',
        dependentsAfterRestartTitle_one: ({ feature }: { feature: string }) => `下次重启后，关闭 ${feature} 也会关闭 1 项功能`,
        dependentsAfterRestartTitle_other: ({ feature, count }: { feature: string; count: number }) => `下次重启后，关闭 ${feature} 也会关闭 ${count} 项功能`,
    },
    data: {
        title: '数据',
        deletion: '自动删除',
        deletionDescription: '更改从下次清理开始生效。',
        dryRunMode: '试运行模式',
        dryRunModeDescription: '关闭之前，清理只计数而不删除。',
        tryRules: '试用当前规则',
        tryRulesDescription: '立即运行一次清理，不删除任何内容。',
        runDryRun: '开始试运行',
        runAgain: '再次运行',
        ranAt: ({ time }: { time: string }) => `${time} 运行 · 未删除任何内容`,
        sweepInProgress: '正在进行清理，请在完成后重试。',
        wouldDelete: ({ count, examined }: { count: string; examined: string }) => `将删除 ${count} 条 · 已检查 ${examined} 条`,
        nothingToDelete: '没有要删除的内容',
        stopTimeBudget: '已停止：时间上限',
        stopRowBudget: '已停止：删除上限',
        stopCandidateBudget: '已停止：检查上限',
        stopStalled: '已停止：没有进展',
        keep: '保留',
        deleteAfter: '到期删除',
        days: '天',
        daysFor: ({ domain }: { domain: string }) => `${domain}的保留天数`,
        daysRequired: '请输入天数。',
        daysInvalid: '请输入不小于 1 的整数天数。',
        defaultEffect: ({ effect }: { effect: string }) => `默认 · ${effect}`,
        alwaysRuns: '即使自动删除已关闭也会运行。',
        expiresAutomatically: '自动过期',
        systemRecords: '系统记录',
        systemRecordsSummary_one: '这个 Home 为自身保留的 1 类记录',
        systemRecordsSummary_other: ({ count }: { count: number }) => `这个 Home 为自身保留的 ${count} 类记录`,
        adminTitle: '只有所有者可以更改这个 Home 保留的内容',
        adminBody: '你是管理员，因此可以查看这些规则。',
        loadFailed: '这个 Home 没有返回数据设置。',
        conflictTitle: '数据设置已在别处更改',
        conflictBody: '你查看时有人更改了这个 Home 的设置。页面现在显示的是 Home 中保存的内容。',
    },
};

const homeGovernanceTranslations = { zhHans } as const;

return { homeGovernanceTranslations };
})();

const Domain_homeIndexTranslations = (() => {
type HomeIndexTranslation = Shared_homeIndexTranslations.HomeIndexTranslation;

const homeIndexTranslations = { 'zh-Hans': {
        greetingMorning: ({ name }) => `早上好，${name}`,
        greetingAfternoon: ({ name }) => `下午好，${name}`,
        greetingEvening: ({ name }) => `晚上好，${name}`,
        greetingMorningAnonymous: '早上好',
        greetingAfternoonAnonymous: '下午好',
        greetingEveningAnonymous: '晚上好',
        sessionsWorking: ({ count }) => `${count} 个会话正在工作`,
        sessionsNeedYou: ({ count }) => `${count} 个需要你`,
        nothingRunning: '暂无运行中的会话',
        customize: '自定义',
        customizeTitle: '自定义主页',
        customizeDescription: '拖动以重新排序。保存在你的账户中，所有设备显示同样的主页。',
        reset: '重置',
        alwaysShown: '始终显示',
        builtIn: '内置',
        startDescription: '输入框和建议',
        attentionDescription: '有事需要你时显示',
        machinesDescription: '内置 · 你的机器网格',
        hiddenSetupSteps: '已隐藏的设置步骤',
        showAgain: ({ count }) => `${count} · 重新显示`,
        reorderHandle: ({ section }) => `重新排序：${section}`,
    } } satisfies Pick<Readonly<Record<string, HomeIndexTranslation>>, "zh-Hans">;

return { homeIndexTranslations };
})();

const Domain_homeSettingsTranslations = (() => {
const en = Shared_homeSettingsTranslations.en;

const zhHans: typeof en = {
    page: {
        title: '服务器设置',
        description: '服务器读取的、没有独立页面的所有设置。',
        searchPlaceholder: '搜索设置或环境变量键',
        changed: '已更改',
        changedA11y: ({ count }: { count: number }) => (count === 1 ? '仅显示 1 项已更改的设置' : `仅显示 ${count} 项已更改的设置`),
        noMatches: '没有与此搜索匹配的设置。',
        noChanges: '此 Home 上没有设置偏离默认值。',
        filterLabel: '显示',
        filterAll: '全部设置',
        filterChanged: ({ count }: { count: number }) => `已更改 · ${count}`,
        more: '更多',
        readOnlyTitle: '启动时只读',
        readOnlyDescription: '服务器在读取任何已保存设置之前就需要这些值，因此它们在服务器运行的位置设置。',
        note: '除非标记为“重启后生效”，否则设置在更改后立即生效。“待处理”表示已保存的值与服务器启动时使用的值不同。每次更改都会记录在活动中；密钥值永远不会被记录。',
        adminTitle: '只有所有者可以更改服务器设置',
        adminBody: '你可以查看每项设置及其值的来源。',
        loadFailed: '无法加载服务器设置。',
        saveFailed: '设置未保存。',
        conflictTitle: '设置已在别处更改',
        conflictBody: '在你编辑时，有人更改了此 Home 的设置。页面现在显示他们的值；你的修改仍保留在输入框中。',
    },
    row: {
        appliesAfterRestart: '重启后生效',
        pending: '待处理',
        defaultValue: ({ value }: { value: string }) => `默认：${value}`,
        runningWith: ({ value }: { value: string }) => `自上次启动以来使用 ${value} 运行`,
        runningWithout: '自上次启动以来未使用此项运行',
        ignored: ({ reason }: { reason: string }) => `上次启动时被忽略：${reason}`,
        runningOn: ({ value }: { value: string }) => `运行于 ${value}`,
        notSet: '未设置',
        outOfBounds: ({ bounds }: { bounds: string }) => `必须为 ${bounds}`,
        invalid: '此值在这里无效',
        storedEncrypted: '已加密存储，永不显示',
    },
    banner: {
        pendingNames: ({ names }: { names: string }) => `${names}。`,
        andMore: ({ count }: { count: number }) => (count === 1 ? '另外 1 项' : `另外 ${count} 项`),
        discard: '放弃',
        discardA11y: '放弃重启后生效的更改',
        discarded: '已放弃待处理的更改',
        ignoredTitle: '上次启动时有一项设置被忽略',
        ignoredTitleMany: ({ count }: { count: number }) => `上次启动时有 ${count} 项设置被忽略`,
        ignoredBody: ({ setting, reason }: { setting: string; reason: string }) => `${setting}：${reason}。服务器在没有它的情况下启动。`,
        fix: '修复',
    },
    readOnly: {
        before_database: '在数据库打开之前读取',
        per_process_identity: '每个服务器进程各不相同',
        invariant: '用于保护登录和构建限制，因此无法在此更改',
        other: '在服务器运行的位置设置',
        set: '已设置',
    },
    secret: {
        saved: '已保存',
        replace: '替换',
        clear: '清除',
        keep: '保留',
        clearPending: '保存后将移除已保存的值。',
        valueSet: '已设置',
        valueNotSet: '未设置',
        setAction: '设置',
    },
    groupSummary: ({ count }: { count: number }) => (count === 1 ? '1 项设置 · 默认' : `${count} 项设置 · 默认`),
    groupSummaryChanged: ({ count, changed }: { count: number; changed: number }) => `${count} 项设置 · ${changed} 项已更改`,
    units: {
        ms: '毫秒',
        seconds: '秒',
        minutes: '分钟',
        bytes: '字节',
        megabytes: 'MB',
    },
    activity: {
        discarded: '放弃了一项待处理的服务器设置',
    },
    choices: {
        hosted_happier_relay: 'Happier 中继',
        direct_apns: 'Apple 推送',
        background_wake_best_effort: '后台唤醒',
        local_only: '仅此设备',
        disabled: '关闭',
        enabled: '开启',
        automatic: '自动',
        sandbox: '沙盒',
        production: '生产',
        owner: '服务器所有者',
        authenticated: '任何已登录用户',
        self: '此服务器',
        external: '外部服务',
        '0': '关闭',
        '1': '开启',
        any: '任一',
        all: '全部',
        github_app: 'GitHub App',
        oauth_user_token: '用户令牌',
        light: '轻量',
        full: '完整',
        api: '仅 API',
        worker: '仅 worker',
        fatal: '致命',
        error: '错误',
        warn: '警告',
        info: '信息',
        debug: '调试',
        trace: '跟踪',
        silent: '静默',
        manual: '手动',
        default: '服务器默认',
    },
    rateLimit: {
        max: ({ route }: { route: string }) => `${route}：每个窗口的请求数`,
        window: ({ route }: { route: string }) => `${route}：窗口`,
    },
    groups: {
        api: 'API 与网络',
        storage: '存储与文件',
        monitoring: '监控',
        process: '进程',
        ui: 'Web 应用托管',
        realtime: '在线状态与套接字',
        retentionCaps: '保留任务资源上限',
        rpc: '机器调用',
        liveActivity: 'Live Activities',
        voice: '语音',
        connectedServices: '已连接的服务',
        localServices: '本地服务',
        plugins: '插件',
        reviews: '评审',
        bugReports: '错误报告',
        releases: '发布',
        authCaches: '登录缓存',
        limits: '限制',
        rateLimits: '按路由的速率限制',
        github: 'GitHub 登录',
        oauth: 'OAuth 登录',
        oidc: '配置中的 OIDC 提供方',
        workos: 'WorkOS',
        signInRequests: '登录请求',
        offboarding: '离职处理',
        friends: '好友',
        accountService: '账户服务',
        devices: '设备',
        diagnostics: '诊断',
        reachInference: '地址检测',
        addresses: '地址',
        other: '其他',
    },
    keys: {
        HAPPIER_HOME_DISPLAY_NAME: 'Home 名称',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: '后台更新',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: '推送模式',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_ALLOW_FALLBACK: '回退到其他模式',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_DEDUPE_WINDOW_MS: '重复更新窗口',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_ENABLED: '后台唤醒推送',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_MIN_INTERVAL_MS: '唤醒推送最短间隔',
        HAPPIER_LIVE_ACTIVITY_EXPO_WIDGETS_PUSH_NOTIFICATIONS_ENABLED: '小组件版本接收推送',
        HAPPIER_LIVE_ACTIVITY_TARGET_TRANSIENT_FAILURE_BUDGET: '设备被移除前的失败次数',
        HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT: 'Apple 推送环境',
        HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID: 'Apple 团队 ID',
        HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID: 'Apple 推送密钥 ID',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY: 'Apple 推送签名密钥',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY_FILE: 'Apple 推送签名密钥文件',
        HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS: '允许的应用 Bundle ID',
        HAPPIER_LIVE_ACTIVITY_APNS_ACTIVITY_NAMES: '允许的 Live Activities 名称',
        HAPPIER_LIVE_ACTIVITY_APNS_REQUEST_TIMEOUT_MS: 'Apple 推送请求超时',
        HAPPIER_LIVE_ACTIVITY_APNS_RECONNECT_BACKOFF_MS: 'Apple 推送重连延迟',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED: '使用托管中继',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL: '托管中继地址',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEY: '托管中继访问密钥',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_SERVICE_ENABLED: '作为托管中继运行',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEYS: '供其他服务器使用的中继访问密钥',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_MAX_SKEW_MS: '中继时钟容差',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_TTL_MS: '中继去重记忆时长',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_CACHE_MAX_ENTRIES: '中继去重缓存大小',
        ELEVENLABS_API_KEY: 'ElevenLabs API 密钥',
        ELEVENLABS_AGENT_ID: 'ElevenLabs 智能体',
        ELEVENLABS_AGENT_ID_PROD: 'ElevenLabs 生产智能体',
        ELEVENLABS_API_BASE_URL: 'ElevenLabs API 地址',
        REVENUECAT_SECRET_KEY: 'RevenueCat 私密密钥',
        VOICE_FREE_SESSIONS_PER_MONTH: '每月免费语音会话数',
        VOICE_FREE_MINUTES_PER_MONTH: '每月免费语音分钟数',
        VOICE_MAX_CONCURRENT_SESSIONS: '同时进行的语音会话数',
        VOICE_MAX_SESSION_SECONDS: '最长语音会话',
        VOICE_MAX_MINUTES_PER_DAY: '每日语音分钟数',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_ENABLED: '语音身份回填',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE: '回填批次大小',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS: '回填时间预算',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_DELAY_MS: '回填批次间隔',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_INTERVAL_MS: '回填运行间隔',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID: 'OpenAI Codex OAuth 客户端 ID',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL: 'OpenAI Codex 令牌端点',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID: 'Claude 订阅 OAuth 客户端 ID',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL: 'Claude 订阅令牌端点',
        HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS: '令牌交换超时',
        CONNECTED_SERVICE_CREDENTIAL_MAX_LEN: '存储凭据的最大长度',
        CONNECTED_SERVICE_REFRESH_LEASE_MAX_MS: '最长刷新租约',
        VENDOR_TOKEN_MAX_LEN: '供应商令牌最大长度',
        HAPPIER_LOCAL_SERVICES_TOKEN_SECRET: '预览令牌密钥',
        HAPPIER_LOCAL_SERVICES_PREVIEW_TOKEN_SECRET: '私有预览令牌密钥',
        HAPPIER_LOCAL_SERVICES_PUBLIC_PREVIEW_TOKEN_SECRET: '公开预览令牌密钥',
        HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN: '插件 UI 源',
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_MAX_AGE_MS: '发布者证明有效期',
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_CLOCK_SKEW_MS: '发布者证明时钟容差',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_MAX_AGE_MS: '评审证明有效期',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_CLOCK_SKEW_MS: '评审证明时钟容差',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: '包含服务器日志',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: '谁可以读取服务器日志',
        HAPPIER_BUG_REPORTS_SERVER_LOG_PATH: '服务器日志文件',
        HAPPIER_BUG_REPORTS_SERVER_LOG_MAX_BYTES: '包含的日志大小',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: '发布渠道',
        HAPPIER_GITHUB_REPO: '发布仓库',
        AUTH_OFFBOARDING_ENABLED: '重新检查登录资格',
        AUTH_OFFBOARDING_STRICT: '重新检查失败时拒绝',
        AUTH_OFFBOARDING_INTERVAL_SECONDS: '重新检查间隔',
        AUTH_PROVIDERS_CONFIG_PATH: '提供方文件',
        AUTH_PROVIDERS_CONFIG_JSON: '提供方 JSON',
        HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: '登录服务',
        HAPPIER_AUTH_SIGN_IN_SERVICE_URL: '账户服务地址',
        HAPPIER_AUTH_SIGN_IN_SERVICE_SERVER_IDENTITY_ID: '账户服务身份',
        HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME: '账户服务名称',
        HAPPIER_SERVER_OWNER_USER_IDS: '服务器所有者账户',
        HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED: '新设备需要批准',
        GITHUB_CLIENT_ID: 'GitHub OAuth 客户端 ID',
        GITHUB_CLIENT_SECRET: 'GitHub OAuth 客户端密钥',
        GITHUB_REDIRECT_URL: 'GitHub 回调地址',
        GITHUB_HTTP_TIMEOUT_SECONDS: 'GitHub 请求超时',
        GITHUB_STORE_ACCESS_TOKEN: '保留 GitHub 访问令牌',
        OAUTH_PENDING_TTL_SECONDS: '待处理登录有效期',
        OAUTH_STATE_TTL_SECONDS: 'OAuth state 有效期',
        HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES: '允许的应用返回协议',
        AUTH_GITHUB_ALLOWED_USERS: '允许的 GitHub 用户',
        AUTH_GITHUB_ALLOWED_ORGS: '允许的 GitHub 组织',
        AUTH_GITHUB_ORG_MATCH: '所需组织',
        AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: '成员资格检查',
        AUTH_GITHUB_APP_ID: '成员资格 GitHub App ID',
        AUTH_GITHUB_APP_PRIVATE_KEY: '成员资格 GitHub App 密钥',
        AUTH_GITHUB_APP_INSTALLATION_ID_BY_ORG: '按组织的应用安装',
        WORKOS_API_KEY: 'WorkOS API 密钥',
        WORKOS_CLIENT_ID: 'WorkOS 客户端 ID',
        ACCOUNT_AUTH_REQUEST_TTL_SECONDS: '账户登录请求有效期',
        TERMINAL_AUTH_REQUEST_TTL_SECONDS: '终端登录请求有效期',
        AUTH_PAIRING_TTL_SECONDS: '配对码有效期',
        AUTH_TOKEN_CACHE_TTL_SECONDS: '会话令牌缓存有效期',
        AUTH_TOKEN_CACHE_MAX_ENTRIES: '会话令牌缓存大小',
        AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '资格缓存有效期',
        AUTH_LOGIN_ELIGIBILITY_CACHE_MAX_ENTRIES: '资格缓存大小',
        FRIENDS_USERNAME_MIN_LEN: '用户名最短长度',
        FRIENDS_USERNAME_MAX_LEN: '用户名最长长度',
        FRIENDS_USERNAME_REGEX: '用户名格式',
        HAPPIER_CANONICAL_SERVER_URL: '登录身份地址',
        HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE: 'Web 应用 OAuth 返回地址',
        PUBLIC_URL: '公布地址 (light)',
        HAPPIER_PUBLIC_SERVER_URL_INFER_TTL_MS: '检测到的地址有效期',
        HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL: '根据访问方式检测',
        HAPPIER_TAILSCALE_INFER_PUBLIC_URL: '通过 Tailscale 检测',
        HAPPIER_TAILSCALE_SERVE_STATUS_TIMEOUT_MS: 'Tailscale Serve 检查超时',
        HAPPIER_TAILSCALE_FUNNEL_STATUS_TIMEOUT_MS: 'Tailscale Funnel 检查超时',
        PORT: '监听端口',
        HAPPIER_SERVER_HOST: '监听地址',
        HAPPIER_SERVER_FLAVOR: '服务器类型',
        NODE_ENV: 'Node 环境',
        SERVER_ROLE: '进程角色',
        UV_THREADPOOL_SIZE: '工作线程',
        HAPPIER_INSTANCE_ID: '副本 ID',
        HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: '关闭期限',
        HAPPY_EXIT_ON_FATAL: '发生致命错误后退出',
        HAPPIER_API_CORS_MAX_AGE_SECONDS: '浏览器预检缓存',
        HAPPIER_SERVER_IDENTITY_ID: '服务器身份',
        HAPPIER_MANAGED_RELAY_PURPOSE: '托管中继用途',
        HAPPIER_PERSONAL_HOME_RELOCATION_OPERATION_ID: '迁移操作',
        HAPPIER_SERVER_STARTUP_RECEIPT_PATH: '启动回执文件',
        HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: '启动回执 nonce',
        HAPPIER_UPDATER_FORWARD_RECOVERY_CAPABILITY: '更新程序前向恢复',
        HAPPIER_RELEASE_SOURCE_SHA: '构建提交',
        HAPPIER_FEATURE_POLICY_ENV: '发布环策略',
        HAPPIER_BUILD_FEATURES_ALLOW: '允许的功能',
        HAPPIER_BUILD_FEATURES_DENY: '禁用的功能',
        HAPPIER_SERVER_LOG_LEVEL: '日志级别',
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: '合并调试日志',
        HAPPIER_SELF_HOST_LOG_DIR: '日志目录',
        HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS: '身份验证诊断',
        HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS: '套接字消息诊断',
        METRICS_ENABLED: '指标',
        METRICS_PORT: '指标端口',
        SENTRY_DSN: '错误报告 DSN',
        HAPPIER_SENTRY_USE_CENTRAL_DSN: '报告给 Happier',
        HAPPIER_SENTRY_CENTRAL_DSN: '中央错误报告 DSN',
        SENTRY_ENVIRONMENT: '错误报告环境',
        SENTRY_RELEASE: '错误报告版本',
        SENTRY_PROFILE_LIFECYCLE: '性能剖析',
        SENTRY_SEND_DEFAULT_PII: '发送个人数据',
        SENTRY_TRACES_SAMPLE_RATE: '追踪的请求',
        SENTRY_PROFILE_SESSION_SAMPLE_RATE: '剖析的会话',
        SENTRY_ENABLE_LOGS: '发送日志',
        SENTRY_LOG_LEVELS: '发送的日志级别',
        SENTRY_MONITORS_ENABLED: '任务监控',
        HAPPIER_SERVER_UI_DIR: 'Web 应用文件夹',
        HAPPIER_SERVER_UI_PREFIX: 'Web 应用路径',
        HAPPIER_SERVER_UI_REQUIRED: '要求提供 Web 应用',
        HAPPIER_SERVER_UI_DEPLOYMENT_ID: 'Web 应用部署 ID',
        HAPPIER_SERVER_UI_DEBUG_PATH: '缺失时显示 Web 应用路径',
        HAPPIER_SOCKET_ADAPTER: '套接字适配器',
        HAPPIER_SOCKET_REDIS_ADAPTER: 'Redis 套接字适配器（旧版）',
        HAPPIER_SOCKET_ADAPTER_MAXLEN: '套接字流长度',
        HAPPIER_SOCKET_ADAPTER_READ_COUNT: '套接字流读取量',
        HAPPIER_SOCKET_MAX_HTTP_BUFFER_SIZE: '最大套接字消息',
        HAPPIER_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS: '快速断开阈值',
        HAPPIER_SOCKET_PLANNED_RESTART_RETRY_AFTER_MS: '重启期间的重连延迟',
        HAPPIER_SOCKET_RECONNECT_WINDOW_MS: '重连窗口',
        HAPPY_SOCKET_ROOMS_ONLY: '严格套接字分发',
        HAPPIER_MACHINE_SOCKET_OWNER_TTL_SECONDS: '机器套接字归属',
        HAPPIER_PRESENCE_STREAM_MAXLEN: '在线状态流长度',
        HAPPIER_PRESENCE_WORKER_DB_WRITE_CONCURRENCY: '在线状态写入并发数',
        HAPPIER_PRESENCE_WORKER_FLUSH_INTERVAL_MS: '在线状态刷新间隔',
        HAPPIER_PRESENCE_WORKER_READ_BLOCK_MS: '在线状态读取等待',
        HAPPIER_PRESENCE_WORKER_READ_COUNT: '在线状态读取量',
        HAPPIER_PRESENCE_WORKER_RECLAIM_IDLE_MS: '在线状态回收前等待',
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '会话判定为不活跃前等待',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '机器判定为离线前等待',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '在线状态检查间隔',
        HAPPIER_PRESENCE_SHUTDOWN_FLUSH_TIMEOUT_MS: '关闭时的在线状态刷新',
        HAPPIER_RPC_FORWARD_TIMEOUT_MS: '机器调用超时',
        HAPPIER_RPC_FORWARD_CAPABILITIES_TIMEOUT_MS: '能力调用超时',
        HAPPIER_RPC_FORWARD_MAX_TIMEOUT_MS: '最长调用超时',
        HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS: '等待方法可用',
        HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS: '方法检查间隔',
        HAPPIER_RPC_CLUSTER_FETCH_TIMEOUT_MS: '跨副本查询超时',
        HAPPIER_STOP_SESSION_RPC_METHOD_AVAILABILITY_GRACE_MS: '等待停止会话',
        HAPPIER_DIRECT_SESSIONS_RPC_METHOD_AVAILABILITY_GRACE_MS: '等待直连会话',
        HAPPIER_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT: '首次加载时需要关注的会话',
        HAPPIER_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT: '检查可回滚的轮次',
        HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT: '保留的设置历史',
        HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK: '要求签名的机器密钥',
        DATABASE_URL: '数据库',
        HAPPIER_DB_PROVIDER: '数据库引擎',
        HAPPIER_DB_CONNECTION_LIMIT: '连接池大小',
        HAPPIER_DB_READINESS_TIMEOUT_MS: '数据库就绪超时',
        HAPPIER_DB_TX_MAX_RETRIES: '事务重试次数',
        HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: '首次重试延迟',
        HAPPIER_DB_TX_RETRY_MAX_DELAY_MS: '最长重试延迟',
        HAPPIER_DB_TX_RETRY_JITTER_FACTOR: '重试抖动',
        HAPPIER_DB_TX_TIMEOUT_MS: '事务超时',
        HAPPIER_DB_TX_MAX_WAIT_MS: '连接等待',
        HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS: '重试总时长',
        HAPPIER_SERVER_DB_SIZE_WARN_BYTES: '数据库大小警告',
        HAPPIER_SQLITE_AUTO_MIGRATE: '启动时迁移',
        HAPPIER_SQLITE_MIGRATIONS_DIR: '迁移文件夹',
        HAPPIER_SQLITE_JOURNAL_MODE: 'SQLite 日志模式',
        HAPPIER_SQLITE_SYNCHRONOUS: 'SQLite 同步模式',
        HAPPIER_SQLITE_JOURNAL_SIZE_LIMIT_BYTES: 'SQLite 日志大小上限',
        HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: 'SQLite 检查点间隔',
        HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: 'SQLite 检查点等待',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_INTERVAL_MS: 'SQLite 清理间隔',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES: 'SQLite 清理页数',
        HAPPIER_FILES_BACKEND: '文件后端',
        S3_HOST: 'S3 主机',
        S3_PORT: 'S3 端口',
        S3_USE_SSL: 'S3 使用 TLS',
        S3_REGION: 'S3 区域',
        S3_BUCKET: 'S3 存储桶',
        S3_PUBLIC_URL: 'S3 公开地址',
        S3_ACCESS_KEY: 'S3 访问密钥',
        S3_SECRET_KEY: 'S3 私密密钥',
        REDIS_URL: 'Redis 连接',
        HANDY_MASTER_SECRET: '主密钥',
        HAPPIER_SERVER_LIGHT_DATA_DIR: '数据目录',
        HAPPIER_SERVER_LIGHT_DB_DIR: '数据库目录',
        HAPPIER_SERVER_LIGHT_FILES_DIR: '文件目录',
        HAPPIER_API_RATE_LIMITS_ENABLED: '速率限制',
        HAPPIER_API_RATE_LIMITS_GLOBAL_MAX: '每个客户端的请求数',
        HAPPIER_API_RATE_LIMITS_GLOBAL_WINDOW: '速率限制窗口',
        HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY: '请求计数依据',
        HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: '路由请求计数依据',
        HAPPIER_SERVER_TRUST_PROXY: '信任代理标头',
        HAPPIER_SERVER_RETENTION__INTERVAL_MS: '清理间隔',
        HAPPIER_SERVER_RETENTION__BATCH_SIZE: '每批行数',
        HAPPIER_SERVER_RETENTION__MAX_DELETES_PER_RULE_PER_RUN: '每条规则最多删除数',
        HAPPIER_SERVER_RETENTION__SWEEP_TIME_BUDGET_MS: '清理时间预算',
        HAPPIER_SERVER_RETENTION__MAX_CANDIDATES_PER_RULE_PER_RUN: '每条规则最多检查行数',
    },
};

const homeSettingsTranslations = { zhHans } as const;

return { homeSettingsTranslations };
})();

const Domain_homeSetupTranslations = (() => {
type HomeSetupTranslation = Shared_homeSetupTranslations.HomeSetupTranslation;

const homeSetupTranslations = { 'zh-Hans': {
        dismiss: ({ title }) => `隐藏“${title}”`,
        dismissTooltip: '隐藏 · 可在“自定义”中恢复',
        close: '关闭',
        addPhoneSubtitle: '随时随地查看会话并处理审批。',
        addPhoneAction: '显示二维码',
        addMachineSubtitle: '运行智能体的服务器或开发机，通过 SSH 或一条命令完成设置。',
        installComputerTitle: '在另一台电脑上安装',
        installComputerSubtitle: '在那台电脑上安装桌面应用，并通过链接加入此 Home。',
        installComputerAction: '获取链接',
        connectComputerTitle: '连接电脑',
        connectComputerSubtitle: '扫描 Happier 在电脑终端中显示的二维码。',
        connectComputerHint: '将相机对准 Happier 在电脑终端中显示的二维码。',
        phoneAddMachineSubtitle: '设置一台服务器或开发机来运行你的智能体。',
        phoneAddMachineAction: '添加',
        thisHome: '此 Home',
        pairingPhoneTitle: '用手机扫描',
        pairingPhoneBody: ({ home }) => `用手机相机对准二维码。Happier 会打开并加入 ${home}。`,
        pairingPhoneStepInstall: '在手机上安装 Happier。',
        pairingPhoneStepScan: '打开相机并扫描二维码。',
        pairingPhoneStepJoin: '请保持此处打开：手机扫描后会立即加入。',
        pairingComputerTitle: '从另一台电脑加入',
        pairingComputerBody: ({ home }) => `把此链接发送到另一台电脑。在 Happier 中打开即可加入 ${home}。`,
        pairingComputerStepInstall: '在另一台电脑上安装桌面应用。',
        pairingComputerStepOpen: '在那台电脑上打开链接，或在 Happier 询问连接方式时粘贴它。',
        pairingComputerStepJoin: '请保持此处打开：电脑打开链接后会立即加入。',
        appStore: 'App Store',
        googlePlay: 'Google Play',
        getDesktopApp: '获取桌面应用',
        copyLink: '复制链接',
        waitingForPhone: '正在等待你的手机…',
        waitingForComputer: '正在等待你的电脑…',
        newCodeIn: ({ time }) => `${time} 后生成新二维码`,
        makingCode: '正在生成二维码…',
        addingDevice: ({ device }) => `正在添加 ${device}…`,
        deviceJoined: ({ device, home }) => `${device} 已加入 ${home}`,
        codeFailed: '无法为此 Home 生成二维码。',
        codeFailedUnreachable: ({ home }) => `${home} 没有响应此设备。`,
        codeFailedIdentity: ({ home }) => `此设备记录的 ${home} 与其回应不一致；请在 Homes 中重新连接。`,
        codeFailedSignedOut: ({ home }) => `此设备未登录 ${home}。`,
        codeFailedTooLarge: '地址太多，无法放入二维码。',
        codeFailedRefused: ({ home }) => `${home} 拒绝了请求。`,
        codeFailedUnexpected: '出了点问题，请重试。',
        cancelCode: '取消二维码',
        newCode: '新二维码',
        qrLabel: ({ home }) => `将设备添加到 ${home} 的二维码`,
        storeQrLabel: ({ store }) => `${store} 上 Happier 的二维码`,
        getTheApp: '获取应用',
        connectServicesTitle: ({ first, second }) => (second ? `连接 ${first} 或 ${second}` : `连接 ${first}`),
        connectServicesSubtitle: '在每台机器上使用你已付费的套餐，并查看剩余额度。',
    } } satisfies Pick<Readonly<Record<string, HomeSetupTranslation>>, "zh-Hans">;

return { homeSetupTranslations };
})();

const Domain_homeWidgetTranslations = (() => {
type HomeWidgetTranslation = Shared_homeWidgetTranslations.HomeWidgetTranslation;

const homeWidgetTranslations = { 'zh-Hans': {
        open: ({ destination }) => `打开${destination}`,
        refreshFailed: '无法刷新',
        latestRunsTitle: '最近运行',
        latestRunsLoading: '正在加载最近运行',
        latestRunsEmptyTitle: '还没有运行记录',
        latestRunsEmptyReason: '你的自动化运行后，每次运行的结果都会显示在这里。',
        latestRunsErrorTitle: '无法加载最近运行',
        latestRunsErrorReason: '你的 Home 没有响应。请检查连接后重试。',
    } } satisfies Pick<Readonly<Record<string, HomeWidgetTranslation>>, "zh-Hans">;

return { homeWidgetTranslations };
})();

const Domain_homesHubTranslations = (() => {
type HomesHubTranslation = Shared_homesHubTranslations.HomesHubTranslation;

const homesHubTranslations = { 'zh-Hans': {
        addHomeOrSignIn: '添加 Home / 登录',
        sheetDescription: '将此设备连接到另一个 Home，或找到你的 Home。',
        continueWithService: ({ service }) => `使用 ${service} 继续`,
        continueWithThisHome: '使用此 Home 继续',
        continueWithServiceSubtitle: '找到你的 Home，并让此 Home 在你的其他设备上可用。',
        serviceUnavailable: ({ service }) => `${service} 暂时不可用。`,
        serviceUnsupported: ({ service }) => `${service} 不支持账户登录。`,
        serviceUnavailableUnnamed: '你的登录服务暂时不可用。',
        serviceUnsupportedUnnamed: '你的登录服务不支持账户登录。',
        scanOrPaste: '扫描或粘贴 Home 链接',
        scanOrPasteSubtitle: '通过二维码或链接加入 Home。',
        createPersonalHome: '在这台电脑上创建个人 Home',
        createPersonalHomeSubtitle: '在这里为你自己的机器和设备运行一个 Home。',
        opensFirst: '优先打开',
    } } as const satisfies Pick<Record<string, HomesHubTranslation>, "zh-Hans">;

return { homesHubTranslations };
})();

const Domain_homesJourneysTranslations = (() => {
type Service = Shared_homesJourneysTranslations.Service;

type Home = Shared_homesJourneysTranslations.Home;

type HomesJourneysTranslation = Shared_homesJourneysTranslations.HomesJourneysTranslation;

const en = Shared_homesJourneysTranslations.en;

const ruTimes = Shared_homesJourneysTranslations.ruTimes;

const zhHans: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "你的 Home 都在这里",
        reconcileLead: "这部手机现在可以一起查看你的所有 Home。",
        showMySessions: "显示我的会话",
        scanComputerCode: "扫描电脑上的二维码",
        serviceLead: "登录后即可找到你的 Home。这部手机随后可以查看它们全部。",
        serviceAsHomeLead: ({ service }) => `你的会话保存在 ${service}，随时可访问。准备好后，添加一台电脑来运行智能体。`,
        factAlwaysOnDetail: "随时访问你的会话。",
        factAgents: "你的电脑运行智能体",
        factAgentsDetail: "稍后通过二维码添加电脑。",
        fromDeviceHelp: "在已连接的设备上打开「设置 → 添加手机」，用这部手机的相机扫描二维码，或粘贴 Home 链接。",
        scan: "扫描",
    },
    happierAccount: 'Happier 账户',
    serviceAccount: ({ service }) => `${service} 账户`,

    alreadyUseTitle: '已经在用 Happier？',
    alreadyUseDescription: '用你的账户找到你的 Home，或直接连接到你自己运行的 Home。在你做出选择之前，这台电脑上不会有任何改变。',
    signIn: '登录',
    withService: ({ service }) => `使用 ${service}`,
    changeServiceLabel: ({ service }) => `登录服务：${service}。更改`,
    connectToHome: '连接到 Home…',
    hostedPrompt: '更想要托管的？',
    useServiceAsAHome: ({ service }) => `将 ${service} 用作 Home`,
    dismiss: '隐藏',

    pathServiceTitle: ({ service }) => `使用 ${service} 登录`,
    pathServiceSubtitle: '找到与你的账户关联的 Home',
    pathOtherServiceTitle: '使用其他服务登录',
    pathOtherServiceSubtitle: '你自己或公司的登录服务',
    pathDirectTitle: '直接连接到 Home',
    pathDirectSubtitle: '链接或地址 · 无需账户',

    serviceLead: '登录后会找到你的 Home 并一起显示。在你决定之前，这台电脑的个人 Home 会一直保留。',
    defaultServiceFact: '默认登录服务',
    serviceMethodsHelp: ({ service }) => `只显示 ${service} 提供的方式。第一次使用？同样的按钮会为你创建账户。`,

    otherServiceLead: '如果你或你的团队运行自己的登录服务，请输入它的地址。Happier 会先检查它提供什么。',
    serviceAddressLabel: '登录服务地址',
    serviceFound: '已找到',
    useThisService: ({ service }) => `使用 ${service} 登录`,
    addressIsNotAService: '此地址不提供账户登录。如果它是一个 Home，请直接连接。',
    connectAsHome: '作为 Home 连接',
    backToService: ({ service }) => `返回 ${service}`,

    directLead: '适用于你自己运行的 Home，有没有账户服务都可以。无需 Happier 账户。',
    fromDeviceLabel: '从已连接的设备',
    fromDeviceHelp: '在该设备上打开“设置 → 添加你的手机”，然后用这台电脑的摄像头扫描代码，或粘贴它的 Home 链接。',
    homeLinkLabel: 'Home 链接',
    homeLinkPlaceholder: '粘贴 Home 链接',
    useCamera: '使用摄像头',
    openLink: '打开',
    byAddressLabel: '通过地址',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: '连接',
    byAddressHelp: 'Happier 会检查 Home 是否响应，然后你使用该 Home 自己的方式登录。',
    notAHomeLink: '这不是 Home 链接。请从另一台设备重新复制。',
    homeUnreachable: 'Happier 无法在该地址连接到 Home。请检查地址以及 Home 是否正在运行。',

    anotherWay: '其他方式',
    homeReachable: '可访问',
    connected: '已连接',
    signInToHomeTitle: '登录此 Home',
    signInToHomeLead: '以下是此 Home 提供的方式。',

    reconcileTitle: '你的 Home 已连接',
    reconcileLead: ({ count }) => `这台电脑现在有 ${count + 1} 个 Home，它们会一起显示在“全部 Home”中。`,
    reconcileFound: '已找到',
    reconcileThisComputer: '这台电脑',
    runSessionsIn: '这台电脑的会话运行在',
    runSessionsInDescription: '在这里开始的新会话会保存到此 Home。',
    removeEmptyPersonalHome: '移除空的个人 Home',
    removeEmptyPersonalHomeDescription: '它在你安装 Happier 时创建，目前还没有任何内容——没有会话、成员、团队或邀请。',
    changeLater: '稍后可在“设置 → Home”中更改。',
    keepBoth: '两个都保留',
    useHome: ({ home }) => `使用 ${home}`,
    reconcileSetupTitle: '选择这台电脑的会话去向',
    reconcileSetupSubtitle: ({ home }) => `你已连接 ${home}。保留两个 Home，或在那里运行这台电脑的会话。`,
    reconcileSetupAction: '选择…',

    serviceAsHomeTitle: ({ service }) => `将 ${service} 用作你的 Home`,
    serviceAsHomeLead: ({ service }) => `你的会话和设置保存在 ${service}，而不是这台电脑上。`,
    factAlwaysOn: '始终在线',
    factAlwaysOnDetail: '这台电脑休眠时，你的手机也能访问会话。',
    factAgents: '这台电脑继续运行你的智能体',
    factAgentsDetail: '代码运行的位置不会改变。',
    storageE2ee: '端到端加密',
    storageE2eeDetail: ({ service }) => `${service} 保存你的会话，但无法读取。`,
    storagePlain: ({ service }) => `由 ${service} 保存`,
    storagePlainDetail: '未端到端加密：服务可以读取它保存的内容。',
    storageE2eeByDefault: '默认端到端加密',
    storagePlainByDefault: ({ service }) => `由 ${service} 保存，默认可读`,
    storageChoiceDetail: '创建账户时由你选择。',
    removeEmptyOfferedDetail: '它目前没有任何内容。仅因为它是空的才提供此选项。',
    signInOrCreate: ({ account }) => `登录或创建你的 ${account}`,
    alreadyUseServiceAsHome: ({ service }) => `已经把 ${service} 用作 Home？登录后会直接连接。`,

    addHomeTitle: '添加 Home',
    addHomeDescription: 'Home 保存你的会话和设置。连接一个你已在用的 Home，或在新的地方创建一个。',
    addSignIn: ({ account }) => `使用你的 ${account} 登录`,
    addSignInSubtitle: '找到你已在用的 Home 并连接它们。',
    addServiceAsHomeSubtitle: '为你托管，始终在线。',
    addLinkOrQr: '通过链接或二维码连接',
    addLinkOrQrSubtitle: '无需账户。从已连接的设备获取。',
    addServerHome: '在服务器上设置 Home',
    addServerHomeSubtitle: '你掌控的开发机或 VPS，通过 SSH 设置。',
    haveHomeAddress: '有 Home 地址？',
    enterIt: '输入地址',

    livesOnThisComputer: '位于这台电脑上',
    availableWhileAwake: '唤醒时可用',
    gettingReady: '正在准备',
    noComputerYet: '还没有电脑？',
    aboutYourHome: '关于你的 Home',

    nudgeTitle: ({ count }) => `本周有 ${count} 次无法连接 Home — 移动 Home？`,
    nudgeBody: '如果此 Home 运行在会休眠的电脑上，将其移到始终开机的主机可能会有帮助。',
    nudgeDismiss: '在此设备上不再显示',
    moveHome: '移动 Home…',
    useService: ({ service }) => `使用 ${service}`,
};

const homesJourneysTranslations = { 'zh-Hans': zhHans } satisfies Pick<Readonly<Record<string, HomesJourneysTranslation>>, "zh-Hans">;

return { homesJourneysTranslations };
})();

const Domain_identityAdministrationTranslations = (() => {
type IdentityAdministrationLanguage = Shared_identityAdministrationTranslations.IdentityAdministrationLanguage;

type Words = Shared_identityAdministrationTranslations.Words;

type GitHubAccessWords = Shared_identityAdministrationTranslations.GitHubAccessWords;

type OidcEditorWords = Shared_identityAdministrationTranslations.OidcEditorWords;

const build = Shared_identityAdministrationTranslations.build;

const en = Shared_identityAdministrationTranslations.en;

const githubAccessWords: Pick<Readonly<Record<IdentityAdministrationLanguage, GitHubAccessWords>>, "zhHans"> = { zhHans: {
        githubCurrentAccess: '当前访问权限',
        githubCurrentAccessSubtitle: '使用此安装的已启用连接和目录源所需的权限。',
        githubCurrentAccessEmpty: '已启用的服务不需要访问权限。',
        githubSetupAccess: '设置和修复所需的权限',
        githubSetupAccessSubtitle: '已配置连接所需的权限，包括已停用的连接和已暂停的目录源。在启用或恢复它们之前，请在 GitHub 授予缺少的权限，然后重新验证安装。',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `移除 ${name} 的安装`,
    } };

const oidcEditorWords: Pick<Readonly<Record<IdentityAdministrationLanguage, OidcEditorWords>>, "zhHans"> = { zhHans: {
        clientAuthenticationMethod: '客户端身份验证', clientSecretPost: 'POST 正文', clientSecretBasic: 'HTTP Basic', storeRefreshToken: '保存刷新令牌', buttonColor: '登录按钮颜色', iconHint: '登录图标',
        allowRulesHint: '每行输入一个值。留空表示不限制。', brandingHint: '留空以使用默认登录外观。', invalidScopes: '请求的范围必须包含 openid。', refreshFailed: '无法刷新此连接', refreshFailedHint: '你的编辑已保留。重试以检查 Home 上的更改。',
    } };

const identityAdministrationTranslations = { zhHans: build({ ...en, title: '身份提供商', subtitle: '可供 Team 使用的 Home 登录连接。', homeConnections: 'Home 登录连接', add: '添加连接', empty: '没有 Home 登录连接', active: '已启用', disabled: '已停用', configuration: '配置', issuer: '签发者 URL', clientSecret: '客户端密钥', secretSet: '已设置', secretNotSet: '未设置', secretRetain: '留空以保留当前密钥。', advanced: '显示高级设置', hideAdvanced: '隐藏高级设置', actions: '操作', test: '测试登录', testing: '正在打开测试…', edit: '编辑连接', save: '保存连接', saving: '正在保存…', enable: '启用连接', disable: '停用连接', remove: '移除连接', createTitle: '添加身份提供商', editTitle: '编辑身份提供商', displayName: '名称', required: '请填写必填字段。', invalidIssuer: '请输入有效的 HTTPS URL。', secretRequired: '请输入客户端密钥。', error: '未能应用更改。', accounts: '受影响的 Account', connections: 'Team 连接', errorForbidden: '你已不再拥有此操作的权限。未更改任何内容。', errorConflict: '其他人先做了更改。你的编辑已保留：请重新加载后再试。', errorMissing: '该项已不存在，可能已被移除。', errorInUse: '仍有内容依赖它，请先移除这些内容。', errorProviderUnavailable: '身份服务未响应。未更改任何内容。', errorRateLimited: '提供商要求稍后再试。', errorInvalid: 'Home 拒绝了这些值。请检查配置后再试。', errorImmutable: '记录启用后此值即固定，请改为新建一条。', errorAuthenticationRequired: '请重新登录此 Team 后再试。未更改任何内容。', errorPolicyUnavailable: '目前无法评估 Team 的身份验证策略。未更改任何内容。', errorPolicyInUse: 'Team 的身份验证策略仍依赖此连接。', errorNotAllowed: '此 Home 不允许 Team 配置此项。未更改任何内容。', errorNeedsAttention: '目录同步需要处理。请运行一次完整同步。', errorSyncPaused: '该来源已暂停。“继续同步”会开始一次新的完整同步。', alternateLogins: '需要其他登录方式的 Account', recoveryAuthenticationPolicy: '打开 Team 身份验证', recoveryAlternateLogin: '请先为这些 Account 提供其他登录方式', recoveryDirectory: '打开目录', recoveryGroupMappings: '打开群组映射', recoveryTeamAuthentication: '重新登录', callbackUrl: '回调 URL', callbackUrlHint: '请在你的身份提供商处注册此 URL。' }, githubAccessWords.zhHans, oidcEditorWords.zhHans) };

return { githubAccessWords, oidcEditorWords, identityAdministrationTranslations };
})();

const Domain_inboxWorkTranslations = (() => {
const en = Shared_inboxWorkTranslations.en;

const zhHans: typeof en = {
    pageDescription: '所有等你处理的事项，按所属工作分组。',
    tabs: { a11y: '收件箱视图', needsYou: '需要你', updates: '动态' },
    groups: {
        unknownLead: '会话',
        leadMeta: ({ count }) => `${count} 个子会话`,
        runMeta: '工作流运行',
        otherTitle: '其他会话',
        otherMeta: '不属于任何编排者或运行',
        openSession: '打开会话',
        openRun: '打开运行',
    },
    rows: {
        step: '步骤',
        workflowRun: '工作流运行',
        review: '审阅',
        stalled: '已停滞',
        stalledReason: '它的机器在轮次中途离线',
        landing: '待合并',
        settle: '结束',
        snoozedUntil: ({ time }) => `已推迟到 ${time}`,
        more: '更多操作',
    },
    popover: {
        moreInOther: ({ count }) => `其他会话中还有 ${count} 项`,
        updates: ({ count }) => `${count} 条动态`,
    },
    empty: {
        title: '没有需要你处理的事项',
        description: '权限请求、审阅，以及编排者或工作流在等你的事项都会出现在这里。',
    },
    updatesEmpty: {
        title: '暂无动态',
        description: '已完成的会话和好友请求会出现在这里。',
    },
    stale: { reason: '无法刷新工作流运行', retry: '重试' },
    settleFailed: '无法结束此会话',
};

const inboxWorkTranslations = { zhHans };

return { inboxWorkTranslations };
})();

const Domain_inputPickerTranslations = (() => {
type InputPickerTranslation = Shared_inputPickerTranslations.InputPickerTranslation;

const inputPickerTranslations = { 'zh-Hans': {
        browse: '浏览…',
        browseField: ({ field }) => `浏览${field}`,
        unavailable: '提供此选项的插件不可用。当前值保持不变。',
        retired: '选择期间插件已更新。请重试。',
        invalid: '此选项不能在这里使用。当前值保持不变。',
        failed: '无法打开选择器。请重试。',
    } } satisfies Pick<Readonly<Record<string, InputPickerTranslation>>, "zh-Hans">;

return { inputPickerTranslations };
})();

const Domain_machineAddTranslations = (() => {
type MachineAddTranslation = Shared_machineAddTranslations.MachineAddTranslation;

const machineAddTranslations = { 'zh-Hans': { newMachine: '新机器', waiting: '等待连接', connected: '已连接', failed: '无法添加这台机器', cancelled: '已取消', cannotReachHost: '无法连接主机。请检查地址和 SSH 访问权限。', choosePath: '选择添加机器的方式', switchHome: '返回此 Home 以继续' } } satisfies Pick<Record<'en' | 'ru' | 'pl' | 'es' | 'fr' | 'it' | 'pt' | 'ca' | 'de' | 'zh-Hans' | 'zh-Hant' | 'ja', MachineAddTranslation>, "zh-Hans">;

return { machineAddTranslations };
})();

const Domain_machineAgentsTranslations = (() => {
type MachineAgentsTranslation = Shared_machineAgentsTranslations.MachineAgentsTranslation;

const en = Shared_machineAgentsTranslations.en;

const zhHans: MachineAgentsTranslation = {
    signedInWith: ({ label }) => `已通过 ${label} 登录`,
    signedInAs: ({ label }) => `已登录为 ${label}`,
    signedInHere: '已在此机器上登录',
    updateTo: ({ version }) => `更新到 ${version}`,
    needsSignIn: '需要登录',
    waitingForSignIn: '正在等待终端中的登录…',
    notInstalled: '未安装',
    downloadSize: ({ size }) => `下载 ${size}`,
    installYourself: '需自行安装',
    unsupportedOs: '无法在此系统上运行',
    unsupportedArch: '没有适用于此处理器的版本',
    installing: '正在安装…',
    progress: ({ done, total }) => `${done} / ${total}`,
    checking: '正在检查…',
    offlineSignedIn: '上次已登录 · 机器离线',
    offlineSignedOut: '上次未登录 · 机器离线',
    offlineNotInstalled: '上次未安装 · 机器离线',
    offlineUnknown: '机器离线',
    unknown: '无法检查此机器',
    actionInstall: '安装',
    actionUpdate: '更新',
    actionSignIn: '登录',
    actionRetry: '重试',
    actionCancel: '取消',
    actionShowTerminal: '显示终端',
    actionGuide: '安装指南',
    installLeadManaged: ({ agent, machine }) => `Happier 会在 ${machine} 上为 Happier 单独安装 ${agent}，不会改动你自己的终端配置。`,
    installLeadVendor: ({ agent, machine }) => `Happier 会在 ${machine} 上运行 ${agent} 自己的安装程序。`,
    installAlsoDownloads: ({ what }) => `还会下载会话所需的 ${what}。`,
    installThenSignIn: '然后登录。',
    installAgent: ({ agent }) => `安装 ${agent}`,
    installMyself: '我自己安装',
    manualLead: ({ agent, machine }) => `Happier 无法替你安装 ${agent}。请按指南在 ${machine} 上安装，然后再检查一次。`,
    checkAgain: '再次检查',
    closeNote: ({ machine }) => `可以关闭，${machine} 上会继续进行。`,
    stepCheck: '检查能否运行',
    stepSignIn: '登录',
    failedKept: '没有保留任何安装一半的内容。',
    installedLine: ({ agent, version }) => `已安装 ${agent} ${version}`,
    nowSignIn: '现在登录',
    signInHow: ({ agent }) => `${agent} 的登录方式`,
    useService: ({ service }) => `使用你的 ${service}`,
    recommended: '推荐',
    serviceConnected: ({ profile }) => `${profile} · 已连接 · 所有机器可用`,
    serviceNotConnected: '连接一次，所有机器都能使用。',
    connect: '连接',
    signInOn: ({ machine }) => `在 ${machine} 上登录`,
    signInOnDetail: ({ agent }) => `在那台机器的终端中运行 ${agent} 自己的登录，仅该机器使用。`,
    noNativeLogin: ({ agent }) => `${agent} 没有自己的登录方式：它使用 API 密钥或已连接的账户。连接一次，所有机器都能使用。`,
    openSignInTerminal: '在终端中打开登录',
    useThisAccount: '使用此账户',
    waitingLead: ({ agent, machine }) => `${agent} 自己的登录已在 ${machine} 的终端中打开。一旦报告已登录就会变为就绪。`,
    readyLine: ({ agent, machine }) => `${agent} 已在 ${machine} 上就绪`,
    startSessionWith: ({ agent }) => `用 ${agent} 开始会话`,
    setUpAnother: '设置另一个智能体',
    unsupportedLead: ({ agent, machine }) => `${agent} 没有适用于 ${machine} 的版本，因此无法在那里运行。`,
    setupTitle: ({ agent }) => `设置 ${agent}`,
    signInTitle: ({ agent }) => `登录 ${agent}`,
    readyTitle: ({ agent }) => `${agent} 已就绪`,
    notOnMachineYet: ({ machine }) => `尚未在 ${machine} 上`,
    onMachine: ({ machine }) => `在 ${machine} 上`,
    installingOn: ({ machine }) => `正在 ${machine} 上安装`,
    cantRunOn: ({ machine }) => `无法在 ${machine} 上运行`,
    terminalTab: ({ agent }) => `登录 · ${agent}`,
    panelLead: '在打开的浏览器中完成。在其他设备上？请在那里打开链接。',
    open: '打开',
    openSignInPage: '打开登录页面',
    waitingEllipsis: '正在等待登录…',
    signedInAlready: '已经登录了？',
    closeTerminal: '关闭终端',
    showTheTerminal: '显示终端',
    phoneLead: ({ agent, machine }) => `${agent} 需要你登录。在这里打开页面并完成，${machine} 会自动获取。`,
    panelSignedInAs: ({ account }) => `已登录为 ${account}。`,
    panelChecked: 'Happier 刚刚检查过。',
    sectionTitle: '智能体',
    sectionDescription: '此机器上的编程智能体，以及各自的登录方式。',
    addTitle: '添加智能体',
    addMore: ({ count }) => (count === 1 ? `还有 1 个可在此运行` : `还有 ${count} 个可在此运行`),
    showAll: '显示全部',
    showFewer: '收起',
    emptyInstalled: '此机器上还没有编程智能体。在下方选择一个，Happier 会为你安装并登录。',
    offlineNote: ({ machine }) => `${machine} 已离线。以下是它最后报告的内容。`,
    firstTitle: '设置你的第一个智能体',
    firstLead: ({ machine }) => `${machine} 已连接，但还没有编程智能体。选一个，Happier 会为你安装并登录。`,
    firstMore: ({ count }) => (count === 1 ? `或从另外 1 个智能体中选择。` : `或从另外 ${count} 个智能体中选择。`),
    allAgents: '所有智能体',
    setUp: '设置',
    choiceUsesService: ({ service, profile }) => `使用你的 ${service}。已连接：${profile}。`,
    choiceSignsInOn: '在机器上登录。',
    dismissFirst: '隐藏“设置你的第一个智能体”',
    dismissTooltip: '隐藏 · 可在“自定义”中恢复',
    chooseAgent: '选择智能体',
    blockNotInstalled: ({ agent, machine }) => `${agent} 尚未在 ${machine} 上。`,
    blockSetUpToStart: '设置后即可开始。',
    blockSignedOut: ({ agent, machine }) => `${agent} 需要在 ${machine} 上登录。`,
    spawnCliMissing: ({ agent, machine }) => `${agent} 未安装在 ${machine} 上。`,
    spawnSignedOut: ({ agent, machine }) => `${agent} 在 ${machine} 上已退出登录。`,
    draftKept: '你的消息已保留。',
    alreadySetUp: ({ machine, home }) => `${machine} 已连接到 ${home}`,
    startSession: '开始会话',
    openMachine: ({ machine }) => `打开 ${machine}`,
};

const machineAgentsTranslations = { 'zh-Hans': zhHans } satisfies Pick<Readonly<Record<string, MachineAgentsTranslation>>, "zh-Hans">;

return { machineAgentsTranslations };
})();

const Domain_machineDetailPageTranslations = (() => {
type MachineDetailPageTranslations = Shared_machineDetailPageTranslations.MachineDetailPageTranslations;

const english = Shared_machineDetailPageTranslations.english;

const translated = Shared_machineDetailPageTranslations.translated;

const machineDetailPageTranslations = { 'zh-Hans': translated({
        machineDetailPage: {
            description: '在这里启动会话，并查看这台机器上正在运行的内容。',
            placeholderTitle: '机器',
            online: '在线',
            offline: '离线',
            cliVersionFact: ({ version }) => `CLI ${version}`,
            replacedByFact: ({ machine }) => `已被 ${machine} 替换`,
            unavailableTitle: '这台机器目前无法启动会话',
            startAction: '启动会话',
            tmuxSectionDescription: '这台机器上的新会话如何使用 tmux。',
            windowsSectionDescription: '远程会话在这台机器上如何打开。',
            clisSectionDescription: 'Happier 在这台机器上找到的智能体 CLI，以及它可以安装的工具。',
            runsSectionDescription: '会话在这台机器上启动的进程。',
            recentSessionsTitle: '最近的会话',
            recentSessionsDescription: '这台机器上最近的五个会话。',
            daemonSectionDescription: '将这台机器连接到 Happier 的后台服务。',
            stopDaemonDescription: '正在运行的会话会继续。在这台机器上重新启动它之前，无法启动新会话。',
            stopDaemonAction: '停止',
            detailsTitle: '机器详情',
        },
    }) };

return { machineDetailPageTranslations };
})();

const Domain_machinePoolTranslations = (() => {
const en = Shared_machinePoolTranslations.en;

const zhHans = {
    machinesSection: "机器",
    tierPrimaryDescription: "优先尝试。",
    tierFallbackDescription: "在前面的机器都不在线时尝试。",
    pauseMember: "暂停用于新会话",
    resumeMember: "用于新会话",
    pausedState: "已暂停",
    memberMenu: "机器选项",
    newPoolTitle: "新机器池",
    title: "机器池",
    myTitle: "我的机器池",
    add: "添加机器池",
    benefit: "选择一台首选机器，其他机器可作为备用机器。",
    placementChangeNotice: "更改适用于保存后开始的会话。已打开的会话会留在当前机器上。",
    connectionSemantics: "打开连接时会选择一台计算机，并在该连接期间保持选中。以后的连接可能会选择另一台计算机。",
    noMembers: "此机器池中还没有机器",
    unavailable: "不可用",
    memberRevoked: "已撤销",
    memberReplaced: "已更换",
    memberTemporary: "暂时的",
    availabilityUnknown: "连接可用性未知",
    notVerified: "未验证",
    brokerUnavailable: "没有可用的代理",
    brokerAvailable: ({ count }: { count: number }) => `${count} 个可用`,
    basics: "细节",
    name: "名称",
    description: "说明（可选）",
    descriptionTitle: "说明",
    addMachines: "添加机器",
    noMachines: "此 Home 没有可用的持久机器。",
    allMachinesAdded: "此 Home 上的每台机器都已在该机器池中。",
    primary: "基本的",
    addFallback: "添加后备",
    moveTo: "移动到",
    moveTierEarlier: "提前移动此层",
    moveTierLater: "稍后移动此层",
    removeMember: "从池中删除",
    enableMember: "用于将来的选择",
    save: "保存更改",
    create: "创建池",
    delete: "删除机器池",
    deleteTitle: "删除这个机器池？",
    deleteBody: "使用此池的凭据资源（如果有）将失去代理位置，需要修复。这会影响以后的选择，但不会删除计算机或停止正在运行的会话。",
    saveFailed: "无法保存此机器池。您的更改仍然在这里。",
    deleteFailed: "无法删除该机器池。再试一次。",
    conflictTitle: "这个池在其他地方发生了变化",
    conflictBody: "您未保存的更改将被保留。重新加载保存的版本以查看最新更改。",
    conflictNoReload: "池标识不再可用。您未保存的更改将被保留。",
    homeOffline: "此 Home 已离线。重新连接前无法更改机器池。",
    refreshFailed: "无法刷新机器池。正在显示最近一次获取的列表。",
    featureUnavailable: "此 Home 不提供机器池。请在 Home 上更新或启用机器池后继续。",
    openSettings: "机器池设置",
    pickSpecificMachine: "选择特定机器",
    poolNotFound: "该机器池不再可用。",
    reload: "重新加载保存的版本",
    reloadTitle: "放弃未保存的更改吗？",
    reloadBody: "重新加载会将此表单替换为最新保存的版本。",
    privacy: "此 Home 的服务器可以读取机器池名称、描述和成员信息，即使账户启用了端到端加密。",
    nameRequired: "保存前输入名称。",
    memberNotEligible: "有些机器不能再属于这个池。",
    memberNotEligibleDetail: "删除此机器或选择另一台永久机器。",
    resolvingTarget: "从这个池中选择一台机器......",
    resolveEmpty: "该池没有启用的计算机。",
    resolveNoAvailable: "该池中当前没有可用的机器。",
    resolvePresenceUnavailable: "机器可用性暂时未知。",
    resolveFailed: "Happier 无法从这个池中选择一台机器。再试一次。",
    executionMachine: "运行于",
    chosenFrom: "选自",
    aMachinePool: "机器池",
    availabilityKnown: ({ connected, enabled }: { connected: number; enabled: number }) => `${enabled} 台已启用机器中有 ${connected} 台已连接`,
    fallback: ({ number }: { number: number }) => `后备 ${number}`,
};

const machinePoolTranslations = { zhHans };

return { machinePoolTranslations };
})();

const Domain_mcpSettingsTranslations = (() => {
type McpSettingsCopy = Shared_mcpSettingsTranslations.McpSettingsCopy;

const en = Shared_mcpSettingsTranslations.en;

const zhHans: McpSettingsCopy = {
    purpose: '你的代理在会话中可以调用的工具服务器。添加一次服务器，然后选择它的适用范围。',
    add: '添加 MCP 服务器',
    addConfigure: '配置服务器',
    addConfigureDescription: '输入它的命令或地址',
    addImportJson: '粘贴 JSON 配置',
    addImportJsonDescription: '来自 README 或其他应用',
    addOwnCategory: '自行添加',
    addPresetCategory: '快速安装',
    addFromMachine: '从此机器导入',
    addFromMachineDescription: '其他代理已在使用的服务器',
    searchPlaceholder: '搜索服务器',
    toolsGroup: '工具',
    unbound: '尚未在任何地方使用',
    newServer: '新的 MCP 服务器',
    serverPurpose: '你的代理可以调用的工具服务器。在下方选择它的适用范围。',
    addByTitle: '添加方式',
    serverSection: '服务器',
    serverSectionDescription: '服务器在会话和此列表中的名称。',
    connectionSection: '连接',
    connectionSectionDescription: 'Happier 如何启动或连接服务器。',
    envDescription: '传给服务器的值。密钥请使用已保存的密钥。',
    headersDescription: '随每个请求发送。令牌请使用已保存的密钥。',
    addRule: '添加规则',
    discardDraft: '放弃',
    landingTitle: '为你的代理添加更多工具',
    landingDescription: 'MCP 服务器可添加浏览器、文档查询或 GitHub 等工具。你可以自行配置、粘贴配置，或从预设开始。',
    onMachineTitle: '在此机器上找到',
    onMachinePurpose: '其他代理已在此机器上配置的 MCP 服务器。导入后即可在 Happier 中使用。',
    onMachineSearchSection: '查找位置',
    onMachineSearchDescription: '你主文件夹中的代理配置，以及你选择的项目文件夹。',
    onMachineFoundSection: '服务器',
    onMachineFoundDescription: '导入会将服务器复制到 Happier；原始配置不会改变。',
    previewTitle: '会话会获得什么',
    previewPurpose: '查看某个代理和文件夹的会话会获得哪些 MCP 服务器，以及服务器无法启动时会发生什么。',
    previewContextSection: '会话',
    previewContextDescription: '新会话启动时使用的代理和文件夹。',
    failurePolicyTitle: '服务器无法启动时',
    failurePolicyDescription: '例如，缺少它需要的已保存密钥。',
    failurePolicySkip: '跳过它',
    failurePolicyStop: '停止会话',
    failureSection: '可靠性',
    failureSectionDescription: '适用于所有会话中的所有 MCP 服务器。',
    previewNothingTitle: '不会提供任何服务器',
    previewNothingDescription: '没有适用于此代理和文件夹的 MCP 服务器。请添加覆盖它们的服务器或规则。',
    check: '检查',
    scan: '查找',
};

const mcpSettingsTranslations = { zhHans } as const;

return { mcpSettingsTranslations };
})();

const Domain_menuBarModeTranslations = (() => {
type RelayParams = Shared_menuBarModeTranslations.RelayParams;

type DetailParams = Shared_menuBarModeTranslations.DetailParams;

type CountParams = Shared_menuBarModeTranslations.CountParams;

type DesktopTrayTranslation = Shared_menuBarModeTranslations.DesktopTrayTranslation;

type DesktopLoginStartTranslation = Shared_menuBarModeTranslations.DesktopLoginStartTranslation;

const en = Shared_menuBarModeTranslations.en;

const enLoginStart = Shared_menuBarModeTranslations.enLoginStart;

const zhHans: DesktopTrayTranslation = {
    open: '打开 Happier',
    openInHappier: '在 Happier 中打开',
    settings: '设置…',
    startAtLogin: '登录时启动',
    quit: '退出 Happier',
    stopServicesAndQuit: '停止后台服务并退出…',
    sessions: ({ count }: CountParams) => `${count} 个运行中`,
    start: '启动',
    restart: '重新启动',
    stop: '停止…',
    userOwned: '在 Happier 之外管理',
    checking: '正在检查后台服务…',
    readFailed: '无法检查后台服务',
    incomplete: '部分后台服务无法检查',
    noServices: '这台电脑尚未设置',
    working: '正在处理…',
    stopConfirmTitle: ({ relay }: RelayParams) => `停止用于 ${relay} 的 Happier 后台服务？`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `这台电脑上为 ${relay} 运行的智能体会话将结束，在服务再次启动之前，你的手机和浏览器无法在那里访问这台电脑。`,
    stopAllConfirmTitle: '停止 Happier 后台服务并退出？',
    stopAllConfirmBody: '这台电脑上的智能体会话将结束，在其后台服务再次启动之前，你的手机和浏览器无法访问这台电脑。',
    stopConfirmAction: '停止',
    actionFailedTitle: '操作未完成',
    loginItemFailed: '无法更新 Happier 的登录项',
    quitStopTitle: '智能体会话仍在运行',
    quitStopBody: '退出会停止这台电脑的后台服务，并结束在这里运行的会话。',
    quitStopUnknownTitle: '停止后台服务？',
    quitStopUnknownBody: 'Happier 无法看到这台电脑上正在运行哪些会话。退出会停止其后台服务，并结束正在运行的会话。',
    quitStopConfirm: '仍然停止',
    quitStopKeep: '保持运行',
    quitStopFailedTitle: '部分后台服务未能停止',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier 会保持运行，方便你检查后台服务并重试。`,
};

const zhHansLoginStart: DesktopLoginStartTranslation = {
    title: '登录时启动',
    subtitle: '让你的手机和浏览器可以访问这台电脑：后台服务会在登录时启动，并在退出 Happier 后继续运行。关闭后，退出 Happier 会停止这些服务。',
    unknown: 'Happier 暂时无法确定这台电脑的后台服务是否会在登录时启动。',
    notSetUp: '设置好这台电脑后即可使用。',
};

const menuBarModeTranslations = { zhHans: { tray: zhHans, loginStart: zhHansLoginStart } };

return { menuBarModeTranslations };
})();

const Domain_nativePasswordTranslations = (() => {
const nativePasswordTranslations = { 'zh-Hans': {
        email: '电子邮箱',
        password: '密码',
        signIn: '登录',
        title: '邮箱和密码',
        forgotPassword: '忘记密码？',
        capsLock: '大写锁定已开启',
        emailRequired: '请输入电子邮箱地址。',
        passwordRequirements: '至少使用15个字符，最多1,024个UTF-8字节。允许空格。',
        unavailable: '此Home暂不支持邮箱和密码登录。',
        rateLimited: '尝试次数过多。请稍候再试。',
        emailInvalid: '请输入有效的电子邮箱地址。',
        passwordMalformed: '该密码包含无法安全存储的字符。请重新输入。',
        passwordMismatch: '两次输入的密码不一致。',
        currentPasswordRequired: '请输入当前密码。',
        currentPassword: '当前密码',
        newPassword: '新密码',
        confirmPassword: '确认密码',
        signInFailed: '该邮箱与密码的组合无法登录。',
        accountDisabledHere: '此账户已在该Home中被停用。请联系Home管理员重新启用。',
        notEligible: '此账户当前无法登录该Home。',
        linkExpired: '该链接已过期或已被使用。请重新获取。',
        revisionConflict: '你的密码已在别处更改。请重新加载后再试。',
        serverUnavailable: '该Home无法完成此请求。请稍后再试。',
        offline: '无法连接到该Home。请检查网络后重试。',
        homeUnreachable: '无法连接到该Home。请重试。',
        securityFactUnavailable: '无法从你的Home读取。',
        cancelled: '该操作已取消。',
        approvalPending: '正在等待你的批准。请在批准收件箱中处理，然后返回此处。',
        outcomeUnconfirmed: '我们无法确认该更改是否已生效。我们已刷新此账户，请先查看当前状态再重试。',
        recoveryKeyRequired: '请输入恢复密钥以更改此端到端加密账户的密码。密钥仅保留在此设备上。',
        working: '处理中…',
        showPassword: '显示密码',
        hidePassword: '隐藏密码',
        createTitle: '创建你的账户',
        createAccount: '创建账户',
        accountProtection: '账户保护',
        protectionPlain: 'Home 可读',
        protectionPlainDetail: '你的Home可以读取你的数据。忘记密码时可通过邮件重置。',
        protectionE2ee: '端到端加密',
        protectionE2eeDetail: '只有你的设备可以读取你的数据。请保存恢复密钥：仅重置密码无法恢复数据。',
        checkYourEmail: '请查收邮件',
        resend: '重新发送',
        resent: '已重新发送。请查收邮件。',
        useDifferentEmail: '换一个邮箱',
        connectTitle: '添加邮箱和密码',
        connectFromSecurity: '先用你已有的方式登录，然后在“账户安全”中添加邮箱和密码。',
        signInFirst: '先登录',
        forgotTitle: '忘记密码？',
        forgotExplanation: '我们可以通过邮件发送重置说明，或者你可以使用创建账户时保存的恢复密钥。',
        emailResetInstructions: '把重置说明发到我的邮箱',
        useRecoveryKey: '使用恢复密钥',
        recoveryKeyDownload: '下载恢复密钥',
        recoveryKeyLater: '稍后再做',
        securitySectionTitle: '邮箱和密码',
        signInEmail: '登录邮箱',
        signInEmailNotSet: '未设置',
        passwordEnrolled: '已设置',
        passwordNotEnrolled: '未设置',
        passwordSetUp: '已为此 Home 设置密码。',
        passwordChanged: '密码已更改。',
        passwordRemoved: '密码已移除。',
        changePassword: '修改密码',
        removePassword: '移除密码',
        removePasswordSubtitle: '仅使用其他方式登录',
        removePasswordConsequence: '你将无法再用邮箱和密码登录该Home。其他登录方式和你的数据不受影响。',
        changeEmailExplanation: '我们会向新地址发送确认邮件。在确认之前，当前登录邮箱仍然有效。',
        sendVerification: '发送确认邮件',
        verifyTitle: '确认你的邮箱',
        verifyGeneric: '此链接用于确认对某个邮箱的控制权。',
        verifyReturnToCreate: '请返回该Home，使用此地址完成账户创建。',
        addressVerified: '该地址已确认。',
        confirmEmailChange: '设为我的登录邮箱',
        signInToConfirm: '请在此设备上登录以确认更改。',
        returnToSignIn: '返回登录',
        continue: '继续',
        resetTitle: '设置新密码',
        resetChooseNew: '为该Home选择一个新密码。',
        resetComplete: '密码已更改。请使用新密码重新登录。',
        resetSignsOutOtherDevices: '设置新密码会使该账户在其他所有位置退出登录。',
        setNewPassword: '保存新密码',
        emailPlaceholder: 'you@example.com',
        accountDisabled: ({ home }: { home: string }) => `此账户已在 ${home} 中被停用。请联系Home管理员重新启用。`,
        verificationSent: ({ email }: { email: string }) => `我们已向 ${email} 发送确认链接。请打开链接以完成账户创建。`,
        resetInstructionsSent: ({ email }: { email: string }) => `如果 ${email} 可以在此登录，重置说明已在发送途中。`,
        verificationPending: ({ email }: { email: string }) => `确认邮件已发送至 ${email}`,
        verifyDestination: ({ email }: { email: string }) => `此链接用于确认 ${email}。`,
        passwordNeedsEmail: '请先添加登录邮箱',
        passwordNeedsEmailHint: '从登录邮箱开始',
        setupStepConfirm: '确认',
        setupProgress: ({ step, total, label }: { step: number; total: number; label: string }) => `第 ${step} 步，共 ${total} 步：${label}`,
        setupEmailHint: '登录邮箱和密码会一起添加。我们会先发送一个链接来确认该地址。',
        setupConfirmHint: '打开该邮件中的链接来设置密码。',
        setupPasswordHint: '输入你已确认的邮箱，然后设置密码。',
    } } as const;

return { nativePasswordTranslations };
})();

const Domain_navigationPlacementTranslations = (() => {
type NavigationPlacementTranslation = Shared_navigationPlacementTranslations.NavigationPlacementTranslation;

const navigationPlacementTranslations = { 'zh-Hans': { customize: '自定义…', title: '导航', description: '选择保持显示、放入“更多”或隐藏的项目。拖动以排序。保存在此设备上。', pinned: '固定', overflow: '更多', hidden: '隐藏', reset: '重置', appRail: '左侧栏', sessionRail: '会话侧栏', workspaceRail: '工作区侧栏', sessionTabBar: '手机标签栏' } } satisfies Pick<Record<string, NavigationPlacementTranslation>, "zh-Hans">;

return { navigationPlacementTranslations };
})();

const Domain_pendingNavigationTranslations = (() => {
type Count = Shared_pendingNavigationTranslations.Count;

const en = Shared_pendingNavigationTranslations.en;

const zhHans: typeof en = {
    nextWithCount: ({ count }) => `${count} 个会话需要你回应`,
    next: '下一个', answeredElsewhere: '已回应',
    unavailableTitle: '无法打开下一个请求',
    unavailableBody: '部分等待中的会话不可用。请重新连接后再试。',
    skippedUnavailable: ({ count }) => `已跳过 ${count} 个不可用的会话。`,
    waitsForPermission: '请求你的许可', waitsForInput: '在等你回答',
    sessionsWaiting: ({ count }) => `${count} 个会话在等待`, go: '前往', dismiss: '稍后',
};

const pendingNavigationTranslations = { zhHans };

return { pendingNavigationTranslations };
})();

const Domain_personalHomeBootstrapBlockedTranslations = (() => {
type PersonalHomeBootstrapBlockedTranslation = Shared_personalHomeBootstrapBlockedTranslations.PersonalHomeBootstrapBlockedTranslation;

const personalHomeBootstrapBlockedTranslations = { 'zh-Hans': {
        blocked: {
            runtime_unhealthy: '本地 Home 需要处理后才能启动。',
            home_auth_invalid: '你的 Home 认证需要处理。',
            existing_runtime: '继续设置前，请选择如何处理现有的本地 Home。',
            existing_runtime_credentials: '此本地 Home 属于这台电脑上的另一个 Happier 应用。',
            personal_home_erased: '你的个人 Home 已被删除。请重试以创建新的个人 Home。',
        },
        blockedBody: { personal_home_erased: '你的 Home 数据已被删除。这里没有可恢复的内容；请创建新的个人 Home 或使用其他 Home。' },
    } } as const satisfies Pick<Record<string, PersonalHomeBootstrapBlockedTranslation>, "zh-Hans">;

return { personalHomeBootstrapBlockedTranslations };
})();

const Domain_personalHomeDecisionTranslations = (() => {
type HomeParams = Shared_personalHomeDecisionTranslations.HomeParams;

type PersonalHomeDecisionTranslation = Shared_personalHomeDecisionTranslations.PersonalHomeDecisionTranslation;

const en = Shared_personalHomeDecisionTranslations.en;

const zhHans: PersonalHomeDecisionTranslation = {
    homeIdentityAmbiguous: '此个人 Home 地址对应多个已保存的 Home。',
    signedInHome: {
        status: '你已经登录了另一个 Home。',
        body: ({ home }: HomeParams) => `这台电脑已登录 ${home}。你可以继续使用它，也可以在这里设置个人 Home。`,
        keep: ({ home }: HomeParams) => `继续使用 ${home}`,
        keepDetail: '你的会话和机器都会保持原样。',
        create: '设置个人 Home',
        createDetail: '在这台电脑上创建一个私人 Home 并切换过去。',
    },
    existingRuntimeCredentials: {
        body: '没有该 Home 的恢复密钥，此应用无法打开它。请使用密钥登录，或使用其他 Home。',
        signIn: '使用恢复密钥登录',
        signInDetail: '使用为此本地 Home 保存的恢复密钥。',
    },
};

const personalHomeDecisionTranslations = { zhHans };

return { personalHomeDecisionTranslations };
})();

const Domain_personalHomeSettingsTranslations = (() => {
type PersonalHomeRuntimeActionKey = Shared_personalHomeSettingsTranslations.PersonalHomeRuntimeActionKey;

type PersonalHomeSettingsCopy = Shared_personalHomeSettingsTranslations.PersonalHomeSettingsCopy;

type EraseOutcomeCounts = Shared_personalHomeSettingsTranslations.EraseOutcomeCounts;

type OperationOutcomeCopy = Shared_personalHomeSettingsTranslations.OperationOutcomeCopy;

const en = Shared_personalHomeSettingsTranslations.en;

const pluralPl = Shared_personalHomeSettingsTranslations.pluralPl;

const pluralRu = Shared_personalHomeSettingsTranslations.pluralRu;

const zhHans = {
    standardOnlyTitle: '仅使用标准连接',
    standardOnlySubtitle: '此设备上的新连接使用标准路径。正在进行的传输沿当前路径完成。',
    installOrUpdateAction: '安装或更新个人 Home', startAction: '启动个人 Home', stopAction: '停止个人 Home',
    defaultHomeLabel: '个人 Home', homeTitle: 'Home', canonicalAddress: 'Home 地址', identityComparison: '当前 Home', identityComparisonMatch: '一致', identityComparisonMismatch: '不一致', identityComparisonUnknown: '无法确认',
    unknownSize: '大小未知', unknownTimestamp: '时间戳未知', restoreBackupTitle: '备份', identityTitle: 'Home 身份', identityUnavailable: '身份不可用', restoreBackupDate: '创建时间', restoreCompatibility: '兼容性', restoreCompatible: '兼容', restoreCompatibilityVerified: '已由此版本验证', restoreBackupSize: '大小', restoreReplacementNotice: '当前 Home 数据将被替换。经过验证的恢复备份将予以保留。', restoreConfirmTitle: '替换并恢复此个人 Home？', restoreConfirmAction: '替换并恢复', relocateConfirmTitle: '移动此个人 Home？', relocateConfirmBody: '经过验证的副本在目标位置启用前，当前 Home 将停止运行。', relocateDestination: '目标位置', relocateConfirmAction: '移动 Home', recoverRestoreTitle: '恢复中断的恢复操作？', recoverRestoreBody: '使用保留的恢复材料回滚中断的恢复操作。', recoverRestoreAction: '恢复操作', eraseDataTitle: '删除个人 Home 数据？', eraseHomeTarget: 'Home', eraseDataBody: '这与卸载不同，只会永久删除以下已解析的 Home 路径：', estimatedSize: '估计大小', summaryTitle: '个人 Home', footer: '你的 Home 会保留在此电脑上。这些操作不会改变其他 Home。', statusTitle: '状态', notAvailable: '不可用', storageTitle: '存储', masterSecretTitle: 'Home 访问密钥', masterSecretPresent: '存在', masterSecretUnavailable: '不可用', inspectAction: '刷新 Home 详情', actionsTitle: '备份与恢复', protectionTitle: '保护', backupsSectionFooter: '备份包含可读取的对话、Home 数据、受信任设备状态和 Home 访问密钥。请只将其存储在你信任的位置。', lastBackupTitle: '上次备份', lastBackupUnknown: '上次备份未知', backupsTitle: '备份归档', backupAction: '立即备份', backupSubtitle: '创建并验证纯文本 Home 归档。', exportBackupAction: '导出备份…', exportBackupSubtitle: '在你选择的位置创建经过验证的备份。', verifyAction: '验证备份…', verifySubtitle: '检查归档但不进行恢复。', restoreAction: '恢复…', restoreSubtitle: '在替换 Home 数据前验证备份。', relocateAction: '移动 Home…', relocateSubtitle: '将此 Home 移动到受管理的电脑。', relocationFinishAction: '完成移动', relocationReturnAction: '返回原始 Home', relocationFinishSubtitle: '验证目标位置后完成移动此 Home。', relocationReturnSubtitle: '保留原始 Home 作为活动位置。', recoverRestoreSubtitle: '可以明确回滚中断的恢复操作。', restoreRecoveryWarningTitle: '恢复需要修复', restoreRecoveryWarningBody: '恢复状态不明确。不会执行自动更改。请在修复此 Home 前查看诊断信息。', restoreCleanupWarningTitle: '恢复清理需要注意', restoreCleanupWarningBody: 'Home 已恢复，但自动清理未完成。请查看诊断信息并重试 Home 操作。', backupVerified: '备份已验证', backupNeedsAttention: '备份已验证；Home 重启需要注意', backupHomeReady: 'Home 已重启', backupRevealAction: '显示备份', restoreResultTitle: '恢复结果', restoreOutcomeRecoveryRequired: '需要恢复', restoreOutcomeRolledBack: '恢复已回滚', restoreOutcomeRestored: 'Home 已恢复', advancedTitle: '高级', advancedFooter: '此电脑的运行时控制和诊断。', restartAction: '重启个人 Home', openDataLocationAction: '打开 Home 数据位置', openLogsAction: '打开运行时日志', removeProfileAction: '从 Happier 移除 Home', removeProfileSubtitle: '移除此配置文件；运行时数据保留在此电脑上。', removeProfileTitle: '移除个人 Home 配置文件？', removeProfileBody: '这会移除配置文件，但保留运行时和数据。', uninstallRuntimeAction: '卸载运行时，保留数据', uninstallRuntimeSubtitle: '移除服务和二进制文件；Home 数据会保留。', deleteHomeDataTitle: '删除 Home 数据', removeSectionFooter: '卸载会保留 Home 数据。永久删除是单独确认的操作。', eraseDataAction: '永久删除个人 Home 数据', eraseDataSubtitle: '与卸载分开。永久删除已解析的 Home 数据。', eraseResultTitle: 'Home 数据已删除', eraseStoppedHome: '运行中的 Home 已停止', eraseHomeAlreadyStopped: 'Home 已经停止', eraseRemainingPaths: '无法删除', progressTitle: '个人 Home 操作', dismissResult: '关闭',
    repairSearchAction: '重建 Home 搜索',
    repairSearchSubtitle: '根据此 Home 的对话重新创建搜索索引。',
    repairSearchCompleteTitle: 'Home 搜索已重建',
    repairSearchCompleteBody: '搜索索引已根据此 Home 的对话重新创建。',
    backupCleanupRequired: '备份安全；请删除详情中显示的受保护暂存路径',
    backupCleanupPath: '待删除的受保护暂存路径',
    backupCleanupError: '清理错误',
    backupDestinationMismatch: '备份未在所选目标位置创建。未删除任何内容。',
    backupDestinationUnsafe: '所选备份目标位于将被删除的个人 Home 数据内部。未删除任何内容。',
    eraseInspectionAttention: 'Home 数据已删除；验证需要处理',
    searchTitle: '搜索',
    searchReady: '就绪',
    searchIndexing: '正在建立索引…',
    searchUnavailable: '不可用',
    localOnlyIngressTitle: '仅可从这台电脑访问',
    localOnlyIngressBody: '公开共享、提供方回调、插件 Webhook，以及这台电脑休眠期间的通知，在此 Home 可从外部访问之前都不可用。',
} satisfies PersonalHomeSettingsCopy;

const backupDisclosureBody = { zhHans: '此备份包含可读取的对话、Home 数据、Home 访问密钥和受信任设备状态。任何能恢复完整归档的人都可以运行此 Home 的克隆。请将其保存在你信任的位置。' } as const;

const eraseBackupOffer = { zhHans: { title: '先备份此 Home？', body: '删除 Home 数据后无法撤销。请先创建经过验证的备份，或在没有备份的情况下继续。', continueWithoutBackup: '不备份并继续' } } as const;

const operationOutcome = { zhHans: {
        erasePartialTitle: '部分 Home 数据无法删除',
        eraseOutcomeSummary: ({ removed, remaining }) => `已删除 ${removed} 项`
            + (remaining > 0 ? `；${remaining} 项无法删除` : ''),
        eraseNotPerformed: '未删除任何内容',
        eraseBlockedBackupMismatch: '此备份来自另一个 Home。',
        eraseBlockedIdentityUnknown: 'Happier 无法确认此备份属于此 Home。',
        eraseVerificationDetail: '验证',
        operationFailed: '此 Home 操作未完成。打开详情查看发生了什么。',
        restorePreviousDataTitle: '已保存先前的数据',
    } } as const satisfies Pick<Record<string, OperationOutcomeCopy>, "zhHans">;

const personalHomeSettingsTranslations = { zhHans: { ...zhHans, ...operationOutcome.zhHans, backupDisclosureBody: backupDisclosureBody.zhHans, eraseBackupOfferTitle: eraseBackupOffer.zhHans.title, eraseBackupOfferBody: eraseBackupOffer.zhHans.body, eraseContinueWithoutBackup: eraseBackupOffer.zhHans.continueWithoutBackup } } as const;

return { backupDisclosureBody, eraseBackupOffer, operationOutcome, personalHomeSettingsTranslations };
})();

const Domain_personalizeTranslations = (() => {
type PersonalizeTranslation = Shared_personalizeTranslations.PersonalizeTranslation;

const en = Shared_personalizeTranslations.en;

const pluralPl = Shared_personalizeTranslations.pluralPl;

const pluralRu = Shared_personalizeTranslations.pluralRu;

const zhHans: PersonalizeTranslation = {
    cardTitle: '个性化 Happier',
    cardSubtitle: '六个快速选择，每项都能实时预览。',
    cardAction: '个性化',
    cardContinue: '继续',
    cardProgress: ({ saved, total, step }) => `已保存 ${saved}/${total} 项选择。从“${step}”继续。`,
    cardProgressReview: ({ saved, total }) => `已保存 ${saved}/${total} 项选择。检查一下你的设置。`,
    inPlaceTitle: '打造你的 Happier',
    inPlaceBody: '六个快速选择，每项都能实时预览。先从观感开始——你选择时主页会随之变化。',
    inPlaceContinue: ({ count }) => `继续 · 还剩 ${count} 项`,
    notNow: '暂不',
    flowTitle: '个性化 Happier',
    finishLater: '稍后完成',
    later: '稍后',
    stepEyebrow: ({ n, total, name }) => `第 ${n} 步，共 ${total} 步 · ${name}`,
    stepCounter: ({ n, total }) => `${n}/${total}`,
    styleEyebrow: '可选',
    summaryEyebrow: '全部就绪',
    previewNote: '预览。按下“下一步”之前不会保存任何内容。',
    previewNoteSummary: '你当前的工作区。',
    next: '下一步',
    review: '检查',
    useThisSetup: '使用此设置',
    saveFailed: '此步骤未保存。你的选择仍保持选中。',
    tryAgain: '重试',
    skipThisStep: '跳过此步骤',
    scopeThisDevice: '此设备',
    scopeAllDevices: '你的所有设备',
    stepsLabel: '步骤',
    savedStepsNote: ({ count }) => `已保存 ${count} 个步骤。`,
    lookName: '观感',
    lookTitle: '看着舒服',
    lookDescription: '浅色、深色或跟随系统，以及应用显示多少玻璃效果。',
    themeLabel: '主题',
    glassLabel: '玻璃',
    glassAutoDescription: '整个应用使用分层玻璃',
    glassEverywhereDescription: '各处统一的玻璃',
    glassSolidDescription: '所有界面均不透明',
    glassCustomNote: '你已在“外观”中调整过玻璃。选择预设即可替换，也可以保留你的设置。',
    customizeInAppearance: '在“外观”中自定义…',
    styleName: '风格',
    styleTitle: '从一种风格开始',
    styleDescription: '每种风格决定会话的阅读方式和列表的外观。它只会预填后续步骤：在每一步按下“下一步”之前不会保存任何内容。',
    styleKeep: '保留当前设置',
    styleActivity: '活动',
    styleConversation: '对话',
    styleDetail: '详细',
    styleCustomTag: '自定义',
    styleDefaultTag: 'Happier 默认',
    styleChanges: ({ style, count }) => `“${style}”会更改 ${count} 项设置`,
    styleNoChanges: '这已经是你的设置。',
    styleNever: '主题、通知、隐私和代理权限永远不属于风格的一部分。',
    was: ({ value }) => `原为 ${value}`,
    conversationName: '对话',
    conversationTitle: '跟上对话',
    conversationDescription: '会话中的回合和代理的思考如何呈现。',
    layoutLabel: '布局',
    thinkingLabel: '思考',
    toolsName: '工具调用',
    toolsTitle: '查看代理做了什么',
    toolsDescription: '命令、编辑和读取在会话中如何显示。',
    toolsLabel: '工具调用',
    toolTapLabel: '点击工具时',
    toolDetailLabel: '工具详情',
    toolDetailDefault: '默认',
    toolDetailFull: '完整',
    workName: '你的工作',
    workTitle: '找到你的工作',
    workDescription: '会话列表的组织方式，以及每行显示多少信息。',
    listLayoutLabel: '会话列表',
    rowsLabel: '行',
    attentionName: '待处理',
    attentionTitle: '留意需要你的事项',
    attentionDescription: '等待你处理或可供检查的会话在列表中的位置。',
    attentionLabel: '需要你的会话',
    attentionHomeNote: '主页始终显示需要你处理的内容。这里只更改会话列表。',
    notificationsName: '通知',
    notificationsTitle: '随时掌握动态',
    notificationsDescription: '你在看别的内容时，此设备会通知你什么。',
    notificationsAllowed: '此设备已允许通知。',
    notificationsNotAllowed: 'Happier 暂时无法在此设备上显示通知。',
    notificationsUnsupported: '此设备不支持通知。请在桌面应用或手机上设置。',
    scopeLook: '主题仅用于此设备 · 玻璃效果用于所有设备',
    notificationsNeedsYouSummary: '需要你',
    notificationsFinishedSummary: '已完成',
    notificationsAllow: '允许通知',
    notificationsTellMe: '在以下情况通知我',
    notificationsNeedsYou: '会话需要批准或回答',
    notificationsFinished: '会话完成本回合',
    notificationsShowLabel: '通知显示',
    notificationsShowDescription: '命令、问题和回复可能会出现在锁屏上。',
    notificationsMessage: '消息内容',
    notificationsStatus: '仅状态',
    notificationsPhoneNote: 'Happier 关闭时手机上的提醒需要在手机上设置。',
    notificationsOff: '不通知',
    sampleNeedsYouTitle: '审查 #2481 需要你处理',
    sampleNeedsYouBody: '代理想在 ~/happier 中运行 yarn test:e2e。允许吗？',
    sampleReadyTitle: '“修复不稳定的重连测试”可以检查了',
    sampleReadyBody: '找到了：重试计时器从未被清除。已修复，测试通过。',
    sampleStatusBody: '打开 Happier 查看。',
    sampleSessionReconnect: '修复不稳定的重连测试',
    sampleSessionCraft: '打磨实验室',
    sampleSessionReview: '审查 #2481',
    sampleSessionPricing: '定价页面文案',
    sampleSessionDocs: '文档搜索索引',
    sampleWorking: '工作中',
    sampleNeedsYou: '需要你',
    sampleReady: '可供检查',
    summaryTitle: '这是你的设置',
    summaryDescription: ({ changed }) => changed === 0
        ? '以下内容均已保存。没有任何更改。'
        : `以下内容均已保存。更改了 ${changed} 项选择，其余保持不变。`,
    summaryChange: '更改',
    summaryFooter: '你可以稍后在设置中更改这些内容，或从“设置 → 外观”重新走一遍。',
    replayTitle: '个性化 Happier',
    replaySubtitle: '六个快速选择，每项都能实时预览。',
    replayAction: '开始',
    journeyHandoff: '打造专属于你',
};

const personalizeTranslations = { 'zh-Hans': zhHans } satisfies Pick<Readonly<Record<string, PersonalizeTranslation>>, "zh-Hans">;

return { personalizeTranslations };
})();

const Domain_phoneNavigationTranslations = (() => {
const en = Shared_phoneNavigationTranslations.en;

const zhHans: typeof en = {
    phoneNav: {
        settings: {
            sectionDescription: '会话内的手机布局，以及栏上的手势。每个手势都可以单独关闭。',
            swipeSidewaysTitle: '左右滑动切换会话',
            swipeSidewaysScrollsDescription: '在栏上切换到上一个或下一个。当工具放不下时，滑动会改为滚动工具。',
            swipeSidewaysAlwaysDescription: '在栏上切换到上一个或下一个。始终是滑动；放不下的工具会收进“更多”。',
            alwaysSwipeTitle: '始终在会话间滑动',
            alwaysSwipeOnDescription: '栏会保留放得下的工具，其余收进“更多”。',
            alwaysSwipeOffDescription: '关闭：多出的工具会让栏滚动。',
            dragUpTitle: '向上拖动切换',
            dragUpDescription: '向上拖动栏，查看已打开的标签页和最近的会话，然后滑到想去的一个。',
            dragUpSourceTitle: '向上拖动显示',
            dragUpSourceRecentDescription: '已打开的标签页，然后是你最近在此设备上打开的内容。',
            dragUpSourceListDescription: '按列表顺序排列的会话。',
            swipeSourceTitle: '左右滑动显示',
            swipeSourceListDescription: '列表中的下一个或上一个会话。',
            swipeSourceRecentDescription: '按上次打开时间排列的下一个或上一个。',
            sourceRecent: '最近',
            sourceList: '会话列表',
            flickTitle: '上下快速滑动切换',
            flickDescription: '快速一滑即可打开下一个或上一个。',
            holdToDockTitle: '按住以保持切换器打开',
            holdToDockDescription: '按住栏，松手后轻点选择。',
            pullAllTabsTitle: '下拉标题查看所有标签页',
            pullAllTabsDescription: '向下拖动会话标题，查看所有已打开的标签页和最近的会话。',
        },
        bar: {
            onTheBar: '栏上',
            more: '更多',
            heldInMore: '“始终滑动”开启时收在“更多”中',
            keepOnBar: '保留在栏上',
            removeFromBar: '从栏中移除',
            openFiles: '打开文件',
        },
        allTabs: {
            title: '所有标签页',
            pullHint: '下拉查看所有标签页',
            releaseHint: '松开查看所有标签页',
            openTabs: '已打开的标签页',
            openTabsSynced: '已打开的标签页 · 已同步',
            recent: '最近',
            recentOnThisDevice: '此手机上的最近',
            here: '此处',
            panes: ({ count }: { count: number }) => `${count} 个窗格`,
            emptyTitle: '没有其他已打开的内容',
            emptyDescription: '你打开的会话和保留的标签页会显示在这里，最近的在前。',
            openTab: ({ title }: { title: string }) => `打开 ${title}`,
        },
        rail: {
            label: '已打开的标签页',
            synced: '已同步',
            syncedA11y: '已打开的标签页会在你的设备间同步',
            notAvailableTitle: '在此手机上不可用',
            notAvailableUnknown: '此标签页是在另一台设备上打开的，这部手机无法显示。它在那里仍保持打开。',
            closeTab: '关闭标签页',
            paneOf: ({ position, total }: { position: number; total: number }) => `第 ${position} 个，共 ${total} 个`,
            nextPane: '下一个窗格',
            chatPane: 'Chat',
        },
        switcher: {
            title: '切换到',
            allSessions: '所有会话',
            openTabs: '已打开的标签页',
            synced: '已同步',
            recent: '最近',
            recentOnThisDevice: '此手机上的最近',
            sessions: '会话',
            nextInSessions: '会话中的下一个',
            previousInSessions: '会话中的上一个',
            furtherBack: '更早',
            moreRecent: '更近',
            here: '此处',
            stayOn: '留在',
            noOlderSessions: '没有更早的会话',
            noNewerSessions: '没有更新的会话',
            lastInSessions: '这是会话中的最后一个。',
            firstInSessions: '这是会话中的第一个。',
            nothingFurtherBack: '再往前没有了。',
            mostRecent: '这是最近的一个。',
            nothingToSwitch: '没有其他已打开的内容',
            nothingToSwitchDescription: '你打开的会话会显示在这里，最近的在前。',
            draft: ({ text }: { text: string }) => `你的草稿：“${text}”`,
            switchSessionAction: '切换会话',
            switchedTo: ({ name }: { name: string }) => `已切换到 ${name}`,
            close: '关闭',
            positionOf: ({ position, total }: { position: number; total: number }) => `第 ${position} 个，共 ${total} 个`,
        },
    },
};

const phoneNavigationTranslations = { 'zh-Hans': zhHans };

return { phoneNavigationTranslations };
})();

const Domain_pluginAccountDataEraseTranslations = (() => {
const english = Shared_pluginAccountDataEraseTranslations.english;

const pluginAccountDataEraseTranslations = { 'zh-Hans': {
    accountDataErase: {
        installedGroupTitle: '账户数据',
        installedGroupFooter: '这仅影响当前帐户的保留数据。它不会从任何计算机上卸载此插件。',
        installedEntryTitle: '删除帐户数据',
        installedEntrySubtitle: '从当前帐户中永久删除此插件的保留数据。',
        orphanedGroupTitle: '保留的插件数据',
        orphanedGroupFooter: '删除插件后，使用插件 ID 删除保留的帐户数据。',
        orphanedEntryTitle: '删除保留的插件数据',
        orphanedEntrySubtitle: '输入已安装或已删除的插件 ID 以永久删除其当前帐户数据。',
        promptTitle: '插件ID',
        promptBody: '输入您想要从当前帐户中删除其保留数据的插件的 ID。',
        promptPlaceholder: 'com.example.plugin',
        invalidTitle: '输入插件 ID',
        invalidBody: '在继续之前请使用准确的插件 ID。',
        confirmTitle: '删除帐户插件数据？',
        confirmBody: ({ pluginId }: { pluginId: string }) => `这将永久删除保留的数据 ${pluginId} 从当前帐户。它不会从您的计算机上卸载插件。`,
        confirm: '删除数据',
        completedTitle: '帐户插件数据已删除',
        completedChanged: '保留的插件数据已从当前帐户中删除。',
        completedEmpty: '在当前帐户中找不到此插件的保留插件数据。',
        partialTitle: '一些插件数据仍然存在',
        partialBody: '一些保留的数据无法删除。没有什么会自动重试；重试删除剩余数据。',
        failedTitle: '插件数据未删除',
        failedBody: '保留的数据无法删除。检查当前帐户连接后重试。',
        unavailableTitle: '插件数据不可用',
        unavailableBody: '当前帐户已更改或不可用。帐户准备就绪后重新打开此操作。',
    },
} } as const;

return { pluginAccountDataEraseTranslations };
})();

const Domain_pluginAccountReleaseSelectionTranslations = (() => {
const english = Shared_pluginAccountReleaseSelectionTranslations.english;

const completeReleaseSelection = Shared_pluginAccountReleaseSelectionTranslations.completeReleaseSelection;

const localizedPluginAccountReleaseSelectionTranslations = { 'zh-Hans': {
    accountReleaseSelection: {
        groupTitle: '账户释放',
        groupFooter: '为此帐户选择确切的版本。这不会在任何计算机上安装、更新或信任该插件。',
        entryTitle: '用于此帐户',
        entrySubtitle: ({ version }: { version: string }) => `选择版本 ${version} 对于当前帐户，无需更改任何计算机安装。`,
        selectedTitle: '已选择帐户释放',
        selectedBody: '所选的插件版本现在将用于此帐户。',
        conflictTitle: '帐户发布已更改',
        conflictBody: '在此操作开放期间，帐户发布发生了变化。重新打开它并重试。',
        unavailableTitle: '帐户无法释放',
        unavailableBody: '当前帐户无法获得确切的版本或其所需的迁移源。帐户准备就绪后重试。',
        rejectedTitle: '未选择账户释放',
        rejectedBody: '该帐户不接受此版本选择。检查帐户状态并重试。',
        hostedGroupFooter: '管理此帐户为该插件托管的插件产物。当前没有计算机提供此版本，因此无法在这里选择。',
        hostedEnableTitle: '为此帐户托管插件产物',
        hostedEnableBody: "将此插件的界面和软件包资源存储在帐户服务器上。对于明文帐户，服务器可以读取这些数据；对于 E2EE 帐户，服务器存储加密数据。版本元数据仍然可见。这不会安装或信任插件，也不会使离线计算机能够执行插件。",
        hostedDisableTitle: '停止托管插件产物',
        hostedStatusDisabled: "已停用。启用托管后，即使源计算机离线，也可下载此版本的插件产物。",
        hostedStatusPending: '已启用。此版本正在等待主机发布其确切的插件产物。',
        hostedStatusReady: '此确切版本的托管插件产物已可使用。',
        hostedRemoveTitle: '停用托管并移除产物',
        hostedRemoveBody: '停止帐户托管并移除此版本确切的托管插件产物。清理本地缓存是单独的操作。',
        hostedClearCacheTitle: '清除本地产物缓存',
        hostedClearCacheBody: '移除此确切版本在本地缓存的界面产物字节，不会更改帐户托管。',
    },
} } as const;

const pluginAccountReleaseSelectionTranslations = { 'zh-Hans': completeReleaseSelection(localizedPluginAccountReleaseSelectionTranslations['zh-Hans']) };

return { localizedPluginAccountReleaseSelectionTranslations, pluginAccountReleaseSelectionTranslations };
})();

const Domain_pluginInvocationLogTranslations = (() => {
const en = Shared_pluginInvocationLogTranslations.en;

const zhHans = {
    invocationLogs: {
        title: '调用日志',
        footer: '来自所选插件机器的有限且已脱敏记录。',
        correlationFilter: '关联 ID 筛选器',
        correlationFilterAll: '此插件的所有调用',
        correlationPromptTitle: '按关联 ID 筛选',
        correlationPromptBody: '仅显示一次精确插件调用的记录。留空可显示所有记录。',
        correlationPromptPlaceholder: '关联 ID',
        refresh: '刷新日志',
        follow: '跟踪日志',
        stopFollowing: '停止跟踪',
        loadMore: '加载后续记录',
        loadingTitle: '正在加载调用日志',
        loadingSubtitle: '正在读取所选机器中有限且已脱敏的记录。',
        idleTitle: '调用日志已可读取',
        idleSubtitle: '刷新以读取所选机器中有限且已脱敏的记录。',
        emptyTitle: '没有调用日志',
        emptySubtitle: '此所选机器上没有匹配的已脱敏记录。',
        unavailableTitle: '调用日志不可用',
        unavailableSubtitle: '所选插件机器不可用或已不再是当前机器。',
        readerUnavailableSubtitle: '所选插件机器目前无法提供调用日志。',
        selectionRequiredTitle: '选择插件机器',
        selectionRequiredSubtitle: '请先在上方选择一个兼容的插件实体化版本，再读取其日志。',
        conflictTitle: '解决所选插件机器的问题',
        conflictSubtitle: '请先在上方选择一个兼容的插件实体化版本，再读取其日志。',
        errorTitle: '无法加载调用日志',
        errorSubtitle: '日志读取未完成。所选机器可用后请重试。',
        noMessage: '插件日志事件',
        level: {
            debug: '调试',
            info: '信息',
            warn: '警告',
            error: '错误',
            diagnostic: '诊断',
        },
    },
};

const pluginInvocationLogTranslations = { 'zh-Hans': zhHans } as const;

return { pluginInvocationLogTranslations };
})();

const Domain_pluginMachineMatrixTranslations = (() => {
const english = Shared_pluginMachineMatrixTranslations.english;

const pluginMachineMatrixTranslations = { 'zh-Hans': {
        machineMatrix: {
            title: '在你的机器上',
            footer: '只读。安装、更新以及其他所有插件操作都在上面选中的机器上执行。',
            empty: '还没有任何机器为此账户报告过插件安装。',
            unavailable: '账户插件可用性尚未加载，因此机器状态未知。',
            incomplete: ({ count }: { count: number }) => `此列表可能不完整：还有 ${count} 台服务器尚未报告其机器。`,
            summary: ({ installed, total }: { installed: number; total: number }) => `在 ${total} 台机器中的 ${installed} 台上已安装且为最新`,
            lastObserved: ({ ago }: { ago: string }) => `最后一次出现：${ago}`,
            state: {
                installedCurrent: '已安装且为最新',
                disabled: '已停用',
                untrusted: '不受信任',
                incompatible: '版本不同',
                localOnly: '仅限本机',
                staleOffline: '最后已知状态，机器离线',
                absent: '未安装',
                unknown: '未知',
            },
        },
    } } as const;

return { pluginMachineMatrixTranslations };
})();

const Domain_pluginMarketplaceDiscoverTranslations = (() => {
const updatePolicy = Shared_pluginMarketplaceDiscoverTranslations.updatePolicy;

const installReviewSections = Shared_pluginMarketplaceDiscoverTranslations.installReviewSections;

const sourceAdministration = Shared_pluginMarketplaceDiscoverTranslations.sourceAdministration;

const pluginChangeOutcomeUnknown = Shared_pluginMarketplaceDiscoverTranslations.pluginChangeOutcomeUnknown;

const secretFieldActions = Shared_pluginMarketplaceDiscoverTranslations.secretFieldActions;

const english = Shared_pluginMarketplaceDiscoverTranslations.english;

const marketplacePresentation = { 'zh-Hans': {
        diagnosticsIssueTitle: '插件问题', diagnosticsRecovery: '查看上方详情，修正后重新加载插件或刷新此页面。', diagnosticsTechnicalCode: ({ code }: { code: string }) => `技术代码：${code}`,
        discover: { publisherLabel: ({ displayName, id }: { displayName: string; id: string }) => `发布者标签：${displayName}（${id}）`, categories: ({ values }: { values: string }) => `类别：${values}`, runtimeSummary: ({ realms, platforms }: { realms: string; platforms: string }) => `运行位置：${realms} · 平台：${platforms}`, reviewStatus: { curated: '精选推荐', unreviewed: '未经审核', withdrawn: '已撤回' }, executableRealm: { daemon: '后台服务', client: '应用', hostedWeb: '托管网页' }, platform: { darwin: 'macOS', linux: 'Linux', windows: 'Windows', web: '网页', ios: 'iOS', android: 'Android' }, diagnostic: { title: '市场来源问题', recovery: '刷新“发现”。如果问题仍然存在，请检查“来源和注册表”。', unreachableTitle: ({ source }: { source: string }) => `无法连接 ${source}`, behindTitle: ({ source }: { source: string }) => `${source} 返回的数据较旧或不完整`, indexTitle: '插件索引不完整', otherSourcesShown: '其他来源的结果仍会显示。' } },
    } } as const;

const localizedTechnicalReviewVocabulary = { 'zh-Hans': { source: ({ kind, locator }: { kind: string; locator: string }) => `${kind}：${locator}`, sourceKind: { path: '本地路径', archive: '归档文件', npm: 'npm 软件包' }, marketplaceSource: ({ kind, source }: { kind: string; source: string }) => `${kind}：${source}`, marketplaceSourceKind: { curated: '精选目录', 'community-npm': '公共 npm 目录', user: '用户目录' }, executableRealm: { daemon: '后台服务代码', reactNative: '应用界面代码', hostedWeb: '隔离的托管网页代码' }, uiArtifacts: ({ status, ids }: { status: string; ids: string }) => `${status}：${ids}`, uiArtifactStatus: { verified: '已验证界面资源', none: '没有界面资源', unavailable: '界面资源不可用' }, authorizationClass: { cooperativeDisclosure: '协作式披露', hostResourceSelection: '选定的主机资源', presentIntentOrOs: '当前意图或系统权限' }, priority: ({ priority }: { priority: number }) => `优先级 ${priority}` } } as const;

const localizedReviewVocabulary = { 'zh-Hans': {
        installReviewSections: {
            ...localizedTechnicalReviewVocabulary['zh-Hans'],
            archiveUrlRetention: 'Happier 会将完整的归档 URL（包括其中的凭据）保存在所选机器上，用于今后的更新。URL 过期或被撤销可能导致更新失败。',
            trustedCodeTitle: '受信任的代码', trustedCodeDisclosure: '插件以受信任代码的形式在 Happier 内运行，并不在沙箱中。除了下方列出的由 Happier 中转的服务外，插件还可以直接使用本应用自身的权限——文件、网络、环境和进程。下方的列表是插件声明的内容，也是你之后可以关闭的内容，而不是限制其代码可触及范围的边界。', identity: '身份与软件包', evidence: '技术证据', executableCode: '可执行代码与扩展项', requiredAccess: '必需的主机访问权限', optionalAccess: '可选的主机访问权限', requestInterceptors: '请求拦截器', rawCredentials: '原始凭据访问声明', compatibility: '兼容性与更新', none: '未声明任何内容', scope: ({ scope }: { scope: string }) => `范围：${scope}`, developmentPath: ({ locator }: { locator: string }) => `${locator} · 开发版本`, publisherUnverified: ({ displayName, id }: { displayName: string; id: string }) => `${displayName} · ${id} · 未验证`, integrityBasis: { expected: ({ integrity }: { integrity: string }) => `${integrity}（预期值）`, observed: ({ integrity }: { integrity: string }) => `${integrity}（观测值）` }, signatureStatus: { verified: ({ keyId }: { keyId: string }) => `已验证注册表签名：${keyId}`, unsupported: ({ keyId }: { keyId: string }) => `不支持的注册表签名：${keyId}` }, provenanceDeclaredUnverified: ({ predicateType }: { predicateType: string }) => `已声明但未验证：${predicateType}`, provenanceRetrievedUnverified: ({ predicateTypes }: { predicateTypes: string }) => `已获取但未验证：${predicateTypes}`, provenanceUnavailable: ({ code }: { code: string }) => `来源证明不可用：${code}`, curationUnreviewed: ({ sourceId }: { sourceId: string }) => `未经审阅的目录来源：${sourceId}`, curationApproved: ({ sourceId, reviewedAt, reason }: { sourceId: string; reviewedAt: string; reason: string }) => `由 ${sourceId} 于 ${reviewedAt} 审阅${reason}`, savedSecret: '已保存的密钥', connectedAccount: '已连接的账户', secretKinds: ({ kinds }: { kinds: string }) => `密钥类型：${kinds}`, connectedAccountService: ({ service }: { service: string }) => `服务：${service}`, credentialPurpose: ({ purpose }: { purpose: string }) => `用途：${purpose}`, credentialUse: ({ realm, phase }: { realm: string; phase: string }) => `在${realm}的${phase}阶段使用`, credentialAccess: ({ access }: { access: string }) => `访问内容：${access}`, credentialRequestHeaders: ({ origin, headers }: { origin: string; headers: string }) => `发送到 ${origin} 的请求头：${headers}`, credentialRequestEnvironment: ({ keys }: { keys: string }) => `环境变量：${keys}`, credentialRequestFiles: ({ files }: { files: string }) => `文件：${files}`, realm: { web: '网页端', ios: 'iOS 客户端', android: 'Android 客户端', daemon: '后台服务' }, phase: { settings: '设置', prepare: '准备', connection: '连接', speech: '语音' }, runtimeApi: ({ version }: { version: number }) => `运行时接口 ${version}`,
        },
        sourceAdministration: { title: '来源与注册表', subtitle: '选择这台机器从何处发现准确的 npm 软件包，以及如何访问相应注册表。', communityTitle: '公共 npm 目录', communitySubtitle: '内置 · 在公共 npm 中发现符合条件的 Happier 插件，而非任意 npm 软件包；结果未经审阅。', configuredTitle: '市场来源', configuredEmpty: '未配置其他市场来源。', add: '添加来源', edit: '编辑来源', remove: '移除来源', removeTitle: '要移除市场来源吗？', removeBody: ({ name }: { name: string }) => `${name} 将不再用于这台机器上的发现。已安装的插件不会改变。`, sourceUrl: '来源地址', displayName: '显示名称', description: '可选说明', enabled: '已启用', disabled: '已停用', curated: '精选来源', user: '你的来源', loadError: '无法加载市场来源。', retry: '重试', operationFailed: '无法应用此更改。请检查机器连接后重试。', operationOutcomeUnknownTitle: '更改需要审阅', operationOutcomeUnknownBody: '所选机器可能已应用此更改，但 Happier 无法确认结果。请先查看刷新后的设置，再重新更改。' },
        updatePolicy: { title: '更新规则', target: ({ machine, server }: { machine: string; server: string }) => `通过 ${server} 应用于 ${machine}。`, pinned: '固定版本', pinnedSubtitle: '在选择其他规则前不更新。', allowed: '允许更新', allowedSubtitle: '明确更新无需再次确认，除非声明的权限扩大。' },
    } } as const;

const pluginMarketplaceDiscoverTranslations = { 'zh-Hans': {
        ...localizedReviewVocabulary['zh-Hans'],
        ...marketplacePresentation['zh-Hans'],
        secretFieldActions: { delete: '删除已保存的密钥', deleteHint: '彻底清除已保存的值，无法撤销。', unbind: '从此插件移除', unbindHint: '解除该设置与已保存密钥的关联，密钥本身会保留。' },
        pluginChangeOutcomeUnknownTitle: '结果未确认',
        pluginChangeOutcomeUnknownBody: ({ action, name, machine, server }: { action: string; name: string; machine: string; server: string }) => `Happier 无法确认 ${name} 的${action}是否已在 ${machine}（${server}）上完成。请先在该机器上查看已安装列表及其当前版本，然后再重试。`,
        updateFromInstalledRecordSubtitle: '通过该安装记录自己的受信任更新通道进行升级。',
        discover: {
            ...marketplacePresentation['zh-Hans'].discover,
            status: {
                loading: '正在搜索所有市场来源…',
                loadingSource: ({ source }: { source: string }) => `正在搜索 ${source}…`,
                results: ({ count, sources }: { count: number; sources: number }) =>
                    `来自 ${sources} 个来源的 ${count} 个插件`,
                empty: '没有插件符合此搜索。',
                error: ({ message }: { message: string }) => `无法刷新发现结果：${message}`,
                errorTitle: '无法刷新发现结果',
                stale: '这些结果对应之前的搜索。请重新搜索以应用上方的设置。',
                partial: ({ count }: { count: number }) =>
                    `有 ${count} 个来源返回了较旧或缺失的数据，结果可能不完整。`,
                nonInstallable: ({ count }: { count: number }) =>
                    `找到 ${count} 个条目，但当前无法安装到这台机器上。`,
            },
            sourceFreshness: {
                stale: '比该来源更旧',
                'stale-offline': '最后已知结果，来源离线',
                unavailable: '来源不可用',
                'auth-unavailable': '该来源需要登录',
                corrupt: '无法读取来源索引',
            },
            nonInstallableReason: {
                sourceStale: '它的市场来源不是最新的。',
                artifactUnavailable: '以这台机器的注册表访问权限无法获取它的软件包。',
                notApproved: '尚未批准从该来源安装。',
                unsupportedSourceKind: '此版本的 Happier 不支持该来源类型。',
            },
            installSubtitle: ({ source }: { source: string }) =>
                `在信任来自 ${source} 的任何内容之前，请先审阅该插件声明的全部内容。`,
            registrySelectionRequired: ({ origin }: { origin: string }) => `需要 ${origin} 的注册表配置`,
            registrySelection: {
                title: ({ name }: { name: string }) => `为 ${name} 选择注册表`,
                body: ({ name, origin, source }: { name: string; origin: string; source: string }) =>
                    `${name} 发布在 ${origin}。请选择 ${source} 在此机器上使用的注册表配置，或添加一个并登录。在“安装并信任”审核之前不会下载任何内容。`,
                continue: '继续',
            },
        },
    } } as const;

return { marketplacePresentation, localizedTechnicalReviewVocabulary, localizedReviewVocabulary, pluginMarketplaceDiscoverTranslations };
})();

const Domain_pluginPermissionTranslations = (() => {
type PermissionDetailsTranslation = Shared_pluginPermissionTranslations.PermissionDetailsTranslation;

const pluginPermissionTranslations = { 'zh-Hans': {
        fields: {
            pluginId: '插件 ID',
            capability: '能力',
            scope: '范围',
            requester: '请求方',
            authority: '授权来源',
            requestedAt: '请求时间',
            reason: '原因',
        },
        scope: { account: '账户', project: '项目', workspace: '工作区' },
        requester: { user: '用户', host: '主机', plugin: '插件' },
        authority: { bundled: '内置', machineInstallation: '机器安装' },
        identifiers: {
            session: '会话',
            request: '请求',
            machine: '机器',
            installation: '安装',
        },
        accessibilitySummary: ({ details }) => `权限请求详情。${details}`,
    } } as const satisfies Pick<Readonly<Record<string, PermissionDetailsTranslation>>, "zh-Hans">;

return { pluginPermissionTranslations };
})();

const Domain_pluginSettingsPresentationTranslations = (() => {
const english = Shared_pluginSettingsPresentationTranslations.english;

const pluginSettingsPresentationTranslations = { 'zh-Hans': {
        rowStatus: { enabled: '已启用', disabled: '已停用', incompatible: '不兼容', trustRemoved: '已撤销信任', needsAttention: '需要处理' },
        developmentPhase: { observing: '正在监视', preparingDependencies: '正在准备依赖项', compiling: '正在编译', validating: '正在验证', active: '活跃', retainedIncumbent: '上一版本仍在运行', unavailable: '不可用' },
        rowSource: { bundled: 'Happier 内置', npm: 'npm 软件包', archive: '归档文件', localPath: '本地文件夹', other: '已配置来源' },
        rowAttention: { trustRemoved: '此插件已不再运行。重新安装即可再次信任其代码。', incompatible: '此版本无法在所选计算机上运行。' },
        developerGroupTitle: '开发',
        developerGroupFooter: '在所选计算机上构建插件，并查看其后台服务的报告。',
        developerDevelopmentSubtitle: '从你自己的文件夹创建、编辑、测试和打包插件。',
        developerDiagnosticsSubtitle: '所选计算机的后台服务与目录诊断。',
        detailMissingTitle: '所选计算机上没有这个插件',
        detailMissingBody: ({ pluginId }: { pluginId: string }) => `${pluginId} 未安装在这里。它可能已被卸载，或者位于另一台计算机上。`,
        detailMissingRetry: '重新检查',
        surfaces: {
            purpose: '为 Happier 添加界面、命令和集成。插件在你的电脑上作为受信任的代码运行。',
            navigationTitle: '插件',
            updatesTitle: '更新',
            moreDescriptionInSettings: '插件从哪里来、构建你自己的插件，以及这台电脑报告的内容。这些页面会在设置中打开。',
            fix: '修复',
            allSources: '所有来源',
            shelfCurated: '精选',
            shelfCuratedDescription: '经 Happier 审核并推荐。每次安装仍会显示完整审核。',
            shelfCommunity: '社区',
            shelfCommunityDescription: '未经审核的 npm 包。“安装并信任”会准确显示每个包可以访问的内容。',
            shelfUser: '你的来源',
            shelfUserDescription: '来自这台电脑上添加的市场来源的条目。',
            manage: '管理',
            installed: '已安装',
            notShownTitle: '部分内容无法显示',
            listingInstallsOn: ({ machine }: { machine: string }) => `将安装在 ${machine} 上。运行任何内容之前，你会先审核它的访问权限。`,
            listingChooseMachine: '在页眉中选择一台电脑来安装此插件。',
            listingRunsIn: '运行于',
            listingPlatforms: '平台',
            listingSource: '来源',
            listingCategories: '类别',
            listingNotFoundTitle: '此条目不可用',
            listingNotFoundBody: '它可能已从来源中移除，或者这台电脑暂时无法连接到该来源。',
            developmentSourcesTitle: '开发中的插件',
            chooseMachineInstalled: '在页眉中选择一台电脑以查看它的插件。',
            chooseMachineBrowse: '在页眉中选择一台电脑以浏览它可以安装的插件。',
            openAsPage: '以页面打开',
            detailInstalledLabel: '已安装的插件',
            detailListingLabel: '插件详情',
            viewLabel: '显示方式',
            viewGrid: '网格',
            viewList: '列表',
            installedSearchPlaceholder: '搜索已安装的插件',
            statusFilterLabel: '显示插件',
            statusAll: '全部插件',
            statusEnabled: '已启用',
            statusDisabled: '已停用',
            statusAttention: '需要处理',
            noMatch: ({ query }: { query: string }) => `没有与“${query}”匹配的插件`,
            clearSearch: '清除',
            emptyTitle: '尚未安装插件',
            emptyBody: '插件为你的智能体添加面板、命令和工具。先从 Happier 出品的插件开始吧。',
            browsePlugins: '浏览插件',
            browseEmpty: '你的来源中暂时没有可用插件。',
            forDevelopers: '开发者',
            readFailedTitle: '无法读取这台电脑的插件',
            readFailedBody: '没有任何更改。重试以再次询问这台电脑。',
            lastKnown: ({ status }: { status: string }) => `上次已知 · ${status}`,
            machinesTitle: '电脑',
            machinesDescription: '此插件的安装位置。',
            machinesCurrent: ({ current, total }: { current: number; total: number }) => `在 ${total} 台电脑中的 ${current} 台上为最新`,
            onMachines: ({ count }: { count: number }) => `在 ${count} 台机器上`,
            onMachine: ({ machine }: { machine: string }) => `在 ${machine} 上`,
            addedGroup: '已添加',
            machinesRetained: '已不在此账户中的电脑',
            open: '打开',
            review: '查看',
            seeAll: '查看全部',
            allResults: '全部结果',
            categoriesLabel: '类别',
            runOnNoneChosen: '未选择机器',
            runOnNoneAvailable: '暂无可运行它的机器',
            runsEverywhere: '在每台运行 Happier 的机器上',
            kinds: {
                agent: '智能体',
                providers: '模型提供方',
                scmHostingProviders: '代码托管',
                scmBackends: '版本控制',
                voice: '语音',
                connectedAccounts: '已连接服务',
                inputTypes: '输入类型',
                mcp: 'MCP 工具',
                pluginUi: '应用面板',
                pluginBrowser: '浏览器视图',
                composer: '编辑器工具',
            },
        },
    } } as const;

return { pluginSettingsPresentationTranslations };
})();

const Domain_pluginUpdateReviewTranslations = (() => {
const en = Shared_pluginUpdateReviewTranslations.en;

const zhHans = {
    title: '更新审核',
    confirmSubtitle: '会扩大你所授予访问权限的更新会先询问你。',
    autoApplySubtitle: '即使访问权限扩大，更新也会直接应用，不再询问。',
    confirmOption: '先询问',
    autoApplyOption: '自动',
};

const pluginUpdateReviewTranslations = { zhHans: zhHans };

return { pluginUpdateReviewTranslations };
})();

const Domain_pluginWebhookAdministrationTranslations = (() => {
const english = Shared_pluginWebhookAdministrationTranslations.english;

const pluginWebhookAdministrationTranslations = { 'zh-Hans': {
    webhookAdministration: {
        title: '插件网络钩子',
        footer: '帐户端点、确切的计算机目标、传送队列和死信恢复。此处从未显示交付尸体。',
        unavailableTitle: '插件 Webhook 不可用',
        unavailableSubtitle: '此服务器尚未启用插件 Webhook 接收。',
        endpointsTitle: 'Webhook 端点',
        emptyTitle: '没有插件 webhook 端点',
        emptySubtitle: '由已安装插件创建的端点将在此处保持可见，包括目标不可用的端点。',
        loadError: '无法加载 Webhook 状态。',
        endpointSubtitle: ({ readiness, routing, sourceInstanceId }: { readiness: string; routing: string; sourceInstanceId: string }) => `${readiness} · ${routing} · ${sourceInstanceId}`,
        targetSubtitle: ({ machineId, materializationId, status }: { machineId: string; materializationId: string; status: string }) => `${machineId} / ${materializationId} · ${status}`,
        queueSubtitle: ({ queued, retrying, claimed, deadLetter }: { queued: number; retrying: number; claimed: number; deadLetter: number }) => `排队 ${queued} ·重试 ${retrying} · 声称 ${claimed} · 死信 ${deadLetter}`,
        copyUrl: '复制网络钩子 URL',
        selectTarget: '选择配送目标',
        retarget: '重定向端点',
        retargetUnavailable: '在重定向此端点之前选择一个可用的精确插件实现。',
        originSelected: '当您继续时，将重新检查所选的确切插件实现。',
        originUnavailable: '没有选择确切的可用插件实现。',
        movePendingTitle: '移动待交付的货物？',
        movePendingBody: '将排队的死信传递移至新的确切目标？积极声称的交付量仍保持在当前目标。',
        resumePendingMove: '恢复待交付移动',
        resumePendingMoveSubtitle: ({ count }: { count: number }) => `${count} 排队或死信传递仍然使用先前的确切目标。`,
        configureCredential: '配置签名凭证',
        rotateCredential: '轮换签名凭证',
        finishRotation: '完成凭证轮换',
        finishRotationSubtitle: '立即停止接受以前的凭据。',
        credentialSecretTitle: '保存新的签名秘密',
        credentialSecretBody: ({ secret }: { secret: string }) => `这个秘密只显示一次。在关闭此消息之前保存它。\n\n${secret}`,
        revoke: '撤销端点',
        revokeTitle: '撤销 webhook 端点？',
        revokeBody: '到此端点的新交付将被拒绝。根据保留策略，现有的交付元数据仍然可用。',
        operationFailed: 'Webhook 操作未完成。重试之前刷新当前状态。',
        deliveryTitle: ({ digest }: { digest: string }) => `死信 ${digest}`,
        deliveryStatus: '交货状态',
        deliverySubtitle: ({ errorCode, attempts, replays, machineId, materializationId }: { errorCode: string; attempts: number; replays: number; machineId: string; materializationId: string }) => `${errorCode} · ${attempts} 尝试· ${replays} 重播· ${machineId} / ${materializationId}`,
        unresolvedAutomationAdmissionTitle: ({ totalCount }: { totalCount: number }) => `${totalCount} 未解决的自动化招生`,
        unresolvedAutomationAdmissionSubtitle: ({ sample, omittedCount }: { sample: string; omittedCount: number }) => `样品： ${sample} · ${omittedCount} 未显示`,
        replay: '重播传送',
        discardTitle: '放弃送货？',
        discardBody: '加密或明文存储的传递正文将被删除且无法恢复。',
    },
} } as const;

return { pluginWebhookAdministrationTranslations };
})();

const Domain_profilesPageTranslations = (() => {
const english = Shared_profilesPageTranslations.english;

const translated = Shared_profilesPageTranslations.translated;

const profilesPageTranslations = { 'zh-Hans': translated({
        profilesPage: {
            searchPlaceholder: '搜索配置文件',
            emptyTitle: '还没有配置文件',
            newProfileTitle: '新配置文件',
            notFoundTitle: '此配置文件已不存在',
            notFoundDescription: '它可能已在另一台设备上被删除。',
            backToProfiles: '返回配置文件',
            discardDraft: '放弃',
            detailDescription: '新会话使用此配置文件启动时生效。',
            builtInDetailDescription: '预设配置文件。保存更改会创建你自己的副本。',
            enabledHint: '为新会话选择配置文件时提供。',
            pickerSection: '配置文件选择',
            pickerSectionDescription: '启动会话时此选项出现的位置。',
            showFirst: '优先显示',
            showFirstDescription: '在收藏中显示机器环境。',
            environmentDescription: '使用此配置文件启动会话时设置的环境变量。值可以引用机器上的变量。',
            descriptionTitle: '描述',
            descriptionHint: '可选。选择此配置文件时显示。',
        },
    }) };

return { profilesPageTranslations };
})();

const Domain_providerCollectionTranslations = (() => {
type ProviderCollectionCopy = Shared_providerCollectionTranslations.ProviderCollectionCopy;

const en = Shared_providerCollectionTranslations.en;

const zhHans: ProviderCollectionCopy = {
    settingsProvidersCollection: {
        description: '连接一次模型来源，即可在所有兼容的代理中使用其模型。',
        foundOn: ({ machine }: { machine: string }) => `在 ${machine} 上发现`,
        foundOnThisMachine: '在此机器上发现',
        connect: '连接',
        start: '启动',
        test: '测试',
        addProvider: '添加提供商',
        customEndpoint: '自定义端点',
        menuOwnCategory: '自己的',
        menuCatalogCategory: '来自目录',
        newTitle: '新提供商',
        emptyDescription: '从目录添加提供商，或添加你自己的兼容端点。',
        machineScopeLabel: '设置于',
        invitationTitle: '使用你自己的模型',
        invitationDescription: '连接一次提供商，其模型就会出现在所有兼容代理的模型选择器中。Ollama 等本地服务器在你的机器上运行。',
        invitationNeedsMachine: '提供商在你的某台机器上连接和检查。请先添加一台机器。',
        setUpMachine: '设置机器',
        duplicateAsCustom: '复制为自定义提供商',
        discard: '放弃',
        enabled: '已启用',
        enabledDescription: '在代理的模型选择器中提供其模型',
        saved: '已保存',
        replace: '替换',
        addKey: '选择密钥',
        apiKeyDefaultDescription: '除非某台机器有自己的密钥，否则在所有机器上使用。',
        apiKeyMachineDescription: '在此机器上代替默认密钥使用。',
        availabilityTitle: '可用范围',
        availabilityDescription: '代理可以在哪里使用此提供商。',
        modelsDescription: '选择代理在模型选择器中提供哪些模型。',
        modelsShown: ({ shown, total }: { shown: number; total: number }) => `${total} 个中的 ${shown} 个显示在模型选择器中`,
        modelsFilter: ({ count }: { count: number }) => `筛选 ${count} 个模型`,
        connectionTitle: '连接',
        nameDescription: '显示在提供方列表和模型选择器中。',
        nameRequired: '请添加名称。',
        nameTooLong: ({ max }: { max: number }) => `请使用不超过 ${max} 个字符。`,
        managedTitle: '托管的本地服务',
        endpointsTitle: '端点',
        endpointsDescription: '留空则使用提供商提供的地址。',
        overridesDescription: '请求的去向。可以为所有机器或仅为此机器更改地址。',
        afterSavingTitle: '保存后',
        destinationDescription: 'Happier 发送此提供商请求的位置。',
        destinationPending: '填写所有端点后显示。',
    },
};

const providerCollectionTranslations = { 'zh-Hans': zhHans } as const;

return { providerCollectionTranslations };
})();

const Domain_providerSessionTranslations = (() => {
const providerSessionTranslations = { zhHans: {
        launchDefaultLabel: ({ provider }: { provider: string }) => `提供商：${provider}`,
        launchNamedLabel: ({ provider, connection }: { provider: string; connection: string }) => `提供商：${provider} · ${connection}`,
        changedTitle: '提供商设置已更改', changedBody: ({ provider, connection }: { provider: string; connection: string }) => `此会话仍在使用启动时的 ${provider} · ${connection} 配置。`,
        unavailableTitle: '提供商已不可用', unavailableBody: ({ provider, connection }: { provider: string; connection: string }) => `${provider} · ${connection} 已不可用于恢复此会话。`,
        disabledTitle: '提供商已关闭', disabledBody: ({ provider, connection }: { provider: string; connection: string }) => `请先启用 ${provider} · ${connection}，再恢复此会话。`,
        incompatibleTitle: '提供商已不再兼容', incompatibleBody: ({ provider, connection }: { provider: string; connection: string }) => `${provider} · ${connection} 已不再兼容此会话的智能体。`,
        restartAction: '重启会话', chooseModelAction: '选择模型',
    } } as const;

return { providerSessionTranslations };
})();

const Domain_reviewWalkthroughTranslations = (() => {
type Count = Shared_reviewWalkthroughTranslations.Count;

type ReviewWalkthroughTranslations = Shared_reviewWalkthroughTranslations.ReviewWalkthroughTranslations;

const en = Shared_reviewWalkthroughTranslations.en;

const zhHans: ReviewWalkthroughTranslations = {
    severityCount: ({ count, severity }) => `${count} ${severity}`,
    findingRefA11y: ({ label, title }) => `${label}：${title}。转到该发现`,
    tag: { noFile: '无文件', outdated: '已过时', unplaced: '无法定位', notInStory: '不在任何步骤中' },
    outdatedSummary: '审查之后代码已更改。',
    askAboutFindingA11y: ({ title }) => `询问该发现：${title}`,
    tailTitle: '未关联到步骤的发现',
    tailDescription: '保留在这里，以免在无法定位其代码行时丢失。',
    inContext: '已在上下文中',
    fromReviewAt: ({ time }) => `来自 ${time} 的审查`,
    reviewLabel: '审查：',
    enginesOf: ({ count, total }) => `${total} 个中的 ${count} 个`,
    enginesFinished: '引擎已完成',
    enginesRunning: ({ count }) => `${count} 个引擎仍在审查`,
    fromEngines: ({ engines, inStory }) => `来自 ${engines} · ${inStory} 条在导读中`,
    and: '和',
    inStoryElsewhere: ({ inStory, elsewhere }) => `${inStory} 条在导读中，${elsewhere} 条在其他位置`,
    allInStory: '全部在导读中',
    seeded: {
        title: '在审查之后由新的运行写成。',
        body: ({ reviewers, time }) => `讲述者没有审查代码；这里引用的每条发现都来自 ${time} 的 ${reviewers}。`,
        changed: ({ count }) => `此后有 ${count} 个文件发生了更改。`,
    },
    findingsFrom: ({ count, engine }) => `来自 ${engine} 的 ${count} 条发现`,
    publishedBefore: ({ time }) => `于 ${time} 发布，早于导读`,
    steps: {
        reviewing: '正在审查',
        engineProgress: ({ done, running }) => `${done} 已完成 · ${running} 正在审查`,
        reviewed: ({ count }) => `已审查 · ${count} 条发现`,
        reviewedShort: ({ count }) => `已审查 · ${count}`,
        engineReviewed: ({ engine, count }) => `${engine} · ${count} 条发现`,
        reviewedAt: ({ time }) => `${time} 已审查`,
        reviewAt: ({ time }) => `${time} 的审查`,
        partial: ({ count }) => `部分审查 · ${count} 条发现`,
        ready: '导读已就绪',
        readyShort: '导读',
        failed: '导读失败',
        narrating: '正在讲述',
        narratorWriting: ({ narrator }) => `${narrator} 正在撰写`,
        writing: '正在撰写导读',
        writingShort: '正在撰写',
    },
    writingWithFindings: '正在结合发现撰写导读…',
    dialog: {
        engines: '审查引擎',
        selected: ({ count }) => `已选择 ${count} 个`,
        loadingEngines: '正在查找审查引擎…',
        noEngines: '此会话的机器上没有可运行的审查引擎。',
        findingsOnly: '仅发现',
        changes: '更改',
        instructions: '说明',
        instructionsPlaceholder: '审查应关注什么？',
        defaultInstructions: '请从正确性、风险和缺失的测试几方面审查这些更改。',
        alsoWalkthrough: '同时撰写导读',
        alsoWalkthroughBody: '发现生成后，同一次运行会结合这些发现撰写导读。不会重复读取更改。',
        narrator: '讲述者',
        chooseNarrator: '选择讲述者',
        narratorSeveral: ({ count }) => `${count} 个引擎进行审查；由一个模型根据它们的全部发现撰写导读。`,
        narratorFindingsOnly: ({ engine }) => `${engine} 只返回发现，不返回文字。由模型据此撰写导读。`,
        noNarrator: '这些引擎都不能撰写导读。请添加一个模型引擎，或关闭导读。',
        footerReviewThenWalkthrough: '先审查，再撰写导读',
        footerHandover: ({ reviewer, narrator }) => `${reviewer} 审查 · ${narrator} 撰写`,
    },
    generated: {
        continues: ({ model }) => `${model} · 延续审查`,
        seeded: ({ model }) => `${model} · 根据审查的发现`,
        handover: ({ narrator, engine }) => `${narrator}，根据 ${engine} 的发现`,
    },
    partial: {
        failed: ({ engines }) => `${engines} 的审查未完成。`,
        notClean: '这是部分审查，并不代表没有问题。',
        finishedWith: ({ engines, count }) => `${engines} 已完成，共 ${count} 条发现。`,
        retry: ({ engine }) => `重试 ${engine}`,
    },
    explain: { action: '解释这些发现', running: '正在解释发现', a11y: '在导读中请求解释这些发现', unknownModel: '未知模型', requester: { user: '用户', agent: '代理', plugin: '插件', automation: '自动化', workflow: '工作流', unknown: '未知请求者' }, header: ({ model, time, requester = '你' }) => `审查说明 · ${model} · 由${requester}在 ${time} 请求 · 不是结论` },
    finished: {
        title: '审查完成',
        openFindings: '打开发现',
        walkMeThrough: '带我看一遍',
        andMore: ({ count }) => `还有 ${count} 条`,
        continues: '延续这次审查运行：审查者根据已读内容撰写，不会重新分析。',
        narrates: ({ count }) => `审查运行已结束。新的运行将根据这 ${count} 条发现和更改撰写导读，不会再次审查。`,
    },
    started: {
        transcript: ({ engineCount, fileCount }) => `已开始审查 · ${engineCount} 个引擎 · ${fileCount} 个文件`,
        notStarted: ({ engines }) => `${engines} 未启动。其他引擎正在审查。`,
        narrationFailed: '审查已启动，但无法请求导读。发现仍会送达。',
    },
};

const reviewWalkthroughTranslations = { 'zh-Hans': { reviewWalkthrough: zhHans } };

return { reviewWalkthroughTranslations };
})();

const Domain_rolesTranslations = (() => {
type RolesTranslations = Shared_rolesTranslations.RolesTranslations;

const rolesTranslations = { 'zh-Hans': {
        rail: {
            label: '角色',
            title: '角色',
            searchPlaceholder: '搜索角色…',
            empty: '没有匹配的角色。',
            footer: '角色自带指令、引擎和运行方式，因此工作流可以随处使用。',
            manage: '管理角色',
            engineAppliesOnStart: '启动此角色时才会使用其引擎',
            defaultEngine: '默认智能体',
            activeAccessibilityLabel: '角色，正在使用某个角色',
        },
        settings: {
            description: '谁来做每一类工作。工作流和编排者请求一个角色；角色决定如何运行。',
            count: ({ count }) => `${count} 个角色`,
            newRole: '新角色',
            groupBuiltIn: '内置',
            groupYours: '你的',
            groupShared: '与你共享',
            groupPlugins: '来自插件',
            edited: '已修改',
            sourceBuiltIn: '内置',
            sourceYours: '你的',
            sourceShared: '与你共享',
            sourcePlugin: ({ plugin }) => `来自 ${plugin}`,
            migrated: '来自 0.2 子智能体',
            migratedNote: '标记为“来自 0.2 子智能体”的角色来自你的子智能体指引：其描述成为指令，其智能体和模型成为引擎。',
            nameTitle: '名称',
            newRoleName: '未命名角色',
            instructionsTitle: '指令',
            instructionsDescription: '它做什么、何时使用以及如何汇报。智能体分派工作时会读取这些内容。',
            resetToDefault: '恢复默认',
            readOnlyNote: '以查看权限与你共享。你对引擎和配置的选择只属于你。',
            howItRunsTitle: '运行方式',
            engineTitle: '引擎',
            engineDescription: '智能体、模型和推理强度。',
            engineFollowsDefault: '跟随你的默认智能体。',
            engineUnavailable: '此处不可用。请选择引擎。',
            runsAsTitle: '运行于',
            runsAsSession: '会话',
            runsAsBackgroundRun: '后台运行',
            runsAsSessionDescription: '一个你可以打开并引导的会话。',
            runsAsBackgroundDescription: '在后台运行并回报；没有可引导的会话。',
            handsOffTitle: '只委派',
            handsOffDescription: '负责规划和委派；自己不编辑文件。',
            secondOpinionTitle: '第二意见',
            secondOpinionDescription: '“建议”会让它在提交拉取请求或宣布完成前考虑征求第二意见。',
            secondOpinionOff: '关闭',
            secondOpinionEncouraged: '建议',
            enabledTitle: '可用',
            enabledDescription: '在角色栏中和向编排者提供。',
            advancedTitle: '高级',
            launchProfileTitle: '启动配置',
            launchProfileDescription: '环境、权限、机器',
            launchProfileNone: '无',
            profileUnavailable: '配置不可用',
            previewTitle: '智能体读到的内容',
            previewDescription: '每轮发送的内容块，原样呈现。',
            deleteRole: '删除角色',
            deleteConfirmTitle: '删除此角色？',
            deleteConfirmBody: ({ name }) => `${name} 将对你和所有共享对象删除。正在使用它的会话会保留副本。`,
            share: '共享…',
            sendCopyFailed: '无法发送副本。',
            saveFailed: '无法保存角色。',
            loadFailed: '无法加载你的角色。',
            emptyDetailTitle: '选择一个角色',
            emptyDetailBody: '选择角色以查看其指令和运行方式。',
        },
        delegation: {
            title: '委派',
            description: '智能体如何把工作交给其他智能体。',
            depthTitle: '工作深度',
            approvalReviewer: '权限审核员',
            approvalReviewerDescription: '自动审核低风险请求，仅批准一次。敏感操作仍需你批准。仅适用于默认和接受编辑模式。',
            approvedByReviewer: '权限审核员已批准一次',
            depthDescription: '智能体启动的会话、后台运行和工作流还能再启动更多。此上限可阻止失控的链条。你自己启动的内容永不受限。',
            depthSetting: '智能体可以委派多远',
            depthSettingDescription: ({ count }) => `${count} 层。超过后，智能体会被要求自己完成工作。`,
            ladderRoot: '你启动的工作',
            ladderRootDetail: '由你启动 · 永不受限',
            ladderLevel: ({ level }) => `第 ${level} 层`,
            ladderLevelDetail: '由智能体启动',
            ladderRefused: '再委派一次',
            ladderRefusedDetail: ({ level }) => `第 ${level} 层 · 被拒绝；智能体自己完成`,
        },
        session: {
            useDefaults: '使用默认值',
            crossOwnerNote: '角色在启动时已复制。',
            addRole: '为此会话添加角色',
            addRoleConfirm: '添加角色',
            namePlaceholder: '角色名称',
            instructionsPlaceholder: '此角色做什么、何时使用',
            notesTitle: '备注',
            notesPlaceholder: '其下每个会话都应知道的内容',
            applyToReports: '应用到其下的会话',
            handsOffTitle: '只委派',
            handsOffDescription: '负责规划和委派；不编辑文件。',
            saveFailed: '无法保存此更改。',
            sectionTitle: '角色',
            allRoles: '所有角色',
            inUse: ({ count }) => `${count} 个在用`,
            changed: '已更改',
            thisSession: '此会话',
            reset: '重置',
            newRoleForSession: '为此会话新建角色',
            changeForSession: '仅为此会话更改',
            editNotes: '编辑备注',
            more: '更多',
            info: '角色适用于此会话及其下的会话。',
            countChanged: ({ count }) => `已更改 ${count} 个`,
            countAdded: ({ count }) => `已添加 ${count} 个`,
            addNotes: '添加备注，说明此会话应如何编排',
        },
        profiles: {
            sharedWithYouTitle: '与你共享',
            sharedWithYouDescription: '他人和团队与你共享的配置。机密值仍由其所有者保管。',
            share: '共享…',
            shareFailedTitle: '无法共享此配置档',
            shareNeedsSavedSecrets: '机密值永不传输。请将此配置档中的每个值移到已保存的机密并关联，然后再次共享。',
            shareAwaitingApproval: '此配置档的发布正在等待批准。批准后，请再次选择“共享…”。',
        },
    } } as const satisfies Pick<Record<string, RolesTranslations>, "zh-Hans">;

return { rolesTranslations };
})();

const Domain_runPageTranslations = (() => {
type Count = Shared_runPageTranslations.Count;

type Machine = Shared_runPageTranslations.Machine;

type Reviewer = Shared_runPageTranslations.Reviewer;

type RunPageTranslations = Shared_runPageTranslations.RunPageTranslations;

const runPageTranslations = { 'zh-Hans': {
        untitledRun: '智能体运行',
        intentTitles: { review: '审查', plan: '计划', delegate: '委派任务' },
        thisMachine: '这台机器',
        menu: {
            cancelResponse: '取消本次回复',
            copyResult: '复制结果',
            showInTranscript: '在对话记录中显示',
            runDetails: '运行详情',
            agent: '智能体',
            permissions: '权限',
            kind: '类型',
            finishesOnItsOwn: '会自行结束',
            staysOpen: '保持打开',
            started: '开始',
            run: '运行',
            process: '进程',
        },
        opening: { reading: ({ machine }) => `正在从 ${machine} 读取。` },
        gone: {
            title: ({ machine }) => `此运行已不在 ${machine} 上`,
            reason: '那里不再保留它，已加载的对话记录中也没有它。',
            closeTab: '关闭标签页',
        },
        stopFailed: {
            title: {
                review: '无法停止此审查',
                plan: '无法停止此计划',
                delegate: '无法停止此任务',
                run: '无法停止此运行',
            },
            reasonWithOthers: ({ machine, count }) => `${machine} 未确认停止。你可以改为停止整个会话——这也会停止其中正在运行的其他 ${count} 个智能体。`,
            reasonAlone: ({ machine }) => `${machine} 未确认停止。你可以改为停止整个会话。`,
            stopSession: '停止会话…',
        },
        steps: {
            title: '过程',
            count: ({ count }) => `${count} 步`,
        },
        review: {
            findings: '发现',
            findingsCount: ({ count }) => `${count}`,
            highCount: ({ count }) => `${count} 个高`,
            severity: { blocker: '阻断', high: '高', medium: '中', low: '低', nit: '细节' },
            triageLabel: '如何处理这条发现',
            reviewerAsks: '审查者提问',
            answer: '回答',
            askAboutThis: '就此提问',
            fixesSelected: ({ count }) => `已选 ${count} 个修复`,
            noFixesSelected: '选择要实施的修复',
            implementFixes: ({ count }) => (count > 0 ? `实施 ${count} 个修复` : '实施修复'),
            couldNotSaveChoice: '无法保存你的选择。',
            reviewers: '审查者',
            findingTotal: ({ count }) => (count === 1 ? '1 条发现' : `${count}条发现`),
            moreFindings: ({ count }) => (count === 1 ? '还有 1 条发现' : `${count}条更多发现`),
            fixesToImplement: ({ count }) => (count === 1 ? '1 项待实施的修复' : `${count}项待实施的修复`),
            verifiedFirst: '每项都先验证，再修复',
            replies: ({ count }) => (count === 1 ? '1 条回复' : `${count}条回复`),
            updatedAfterQuestion: '已根据你的问题更新',
            reviewerUpdated: ({ reviewer }) => `${reviewer} 更新了这条发现`,
            askPlaceholder: '就这条发现提问…',
            askReviewerPlaceholder: '向审查者提问…',
            toReviewer: ({ reviewer }) => `发给 ${reviewer}`,
            followUpsGoTo: ({ reviewer }) => `问题会发给 ${reviewer}`,
            waitingForAnswer: ({ reviewer }) => `正在等待 ${reviewer}…`,
            waitingForAnswers: '正在等待审查者…',
            both: '两者',
            reviewerCount: ({ count }) => `${count} 位审查者`,
            askReviewersPlaceholder: '向审查者追问…',
            followUpsGoToAll: ({ count }) => (count === 2 ? '问题会发给两位审查者' : `问题会发给全部 ${count} 位审查者`),
            stillReviewing: '仍在审查',
            reviewerDidNotFinish: '未完成',
            reviewersNotStarted: ({ count }) => (count === 1 ? '有 1 位审查者未能开始' : `有 ${count} 位审查者未能开始`),
            reviewerNotStarted: ({ reviewer }) => `${reviewer} 无法开始。`,
            notSaved: '这条发现未保存，暂时无法记录决定。',
            decisionsUnavailable: '无法加载你的决定。',
            followUpUnavailable: {
                notResumable: '此审查已结束；提问需要保持开启的审查。',
                ended: '此审查未完成，因此无法接受提问。',
                resumeUnavailable: '在这台机器上已无法联系到审查者。',
                busy: '审查者仍在忙碌，请稍后再试。',
                failed: '无法发送你的问题。',
            },
        },
        launcher: {
            titles: { review: '请求审查', plan: '请求计划', delegate: '委派任务' },
            descriptions: {
                review: ({ machine }) => `每个智能体各自审查 ${machine} 上的改动；每个都会在这里给出一个结果。`,
                plan: ({ machine }) => `智能体阅读 ${machine} 上的代码，并在这里提出计划。它不会更改任何内容。`,
                delegate: ({ machine }) => `智能体按下面的权限在 ${machine} 上工作，并在这里汇报。`,
            },
            whatFor: '用途',
            who: { review: '谁来审查', plan: '谁来规划', delegate: '谁来做' },
            selectedCount: ({ count }) => `已选 ${count} 个`,
            focus: {
                review: '他们应该关注什么？',
                plan: '计划应涵盖什么？',
                delegate: '它应该做什么？',
            },
            optional: '可选',
            start: {
                review: ({ count }) => (count > 1 ? `开始 ${count} 个审查` : '开始审查'),
                plan: '开始计划',
                delegate: '开始任务',
            },
            runsOn: ({ machine }) => `在 ${machine} 上运行`,
            checking: '正在检查这里可以运行哪些智能体',
            unavailableTitle: '此会话中无法启动智能体',
            unavailableReason: '它的机器目前不提供审查、计划或委派任务。',
        },
    } } as const satisfies Pick<Record<string, RunPageTranslations>, "zh-Hans">;

return { runPageTranslations };
})();

const Domain_scmComparisonTranslations = (() => {
type ScmComparisonTranslations = Shared_scmComparisonTranslations.ScmComparisonTranslations;

const en = Shared_scmComparisonTranslations.en;

const translated = Shared_scmComparisonTranslations.translated;

const scmComparisonTranslations = { 'zh-Hans': {
        scmComparison: translated({
            view: { files: '文件', walkthrough: '导读', commits: '提交' },
            scope: {
                workingTree: '待处理的更改',
                session: '本会话',
                turn: '轮次',
                latestTurn: '最新一轮',
                branch: ({ head, base }) => `${head} 对比 ${base}`,
                commit: ({ commit }) => `提交 ${commit}`,
            },
            tabTitle: ({ view, scope }) => `${view} · ${scope}`,
            since: ({ time }) => `自 ${time} 起`,
            turnsWithChanges: ({ count }) => `${count} 轮有更改`,
            scopePicker: {
                a11y: '要显示的更改',
                branchChoice: '分支与基准比较',
                commitChoice: '提交',
                pullRequestChoice: '拉取请求',
                headRef: '目标分支或引用',
                baseRef: '基准分支或引用',
                parentRef: '父提交引用（可选）',
                explainAndCommit: '说明并提交',
                explainOnly: '仅说明',
                unavailable: '此会话不可用',
                pendingDescription: '尚未提交 · 可以建议提交',
                sessionDescription: '所有更改，开始 → 现在',
                turnDescription: '按代理修改的顺序',
                branchDescription: '从共同基准开始的更改',
                commitDescription: '此提交引入的更改',
                pullRequestDescription: '此拉取请求提出的更改',
            },
            fileCount: ({ count }) => `${count} 个文件`,
            changeCount: ({ count }) => `${count} 处更改`,
            changedFiles: '已更改的文件',
            startReview: '开始审查',
            proposeCommits: '建议提交',
            explain: '说明',
            explainA11y: '说明：在更改旁显示导读的注释',
            viewA11y: '视图',
            lockfileTag: '锁文件',
            generatedTag: '已生成',
            lockfileCollapsed: '锁文件，已折叠。',
            generatedCollapsed: '生成的文件，已折叠。',
            showDiff: '显示差异',
            unsupportedReason: '文件暂时无法显示此对比。更改仍保留在 Git 中。',
            showPendingChanges: '显示待处理的更改',
            capturedStale: '来源已更改。这些文件保留捕获时的比较。',
            capturedFreshnessUnknown: '正在显示已捕获的文件。无法检查来源的当前状态。',
            keys: { nextFile: '下一个文件', nextChange: '下一处更改' },
        }),
    } } as const;

return { scmComparisonTranslations };
})();

const Domain_secretsSettingsTranslations = (() => {
type SecretsSettingsCopy = Shared_secretsSettingsTranslations.SecretsSettingsCopy;

const en = Shared_secretsSettingsTranslations.en;

const zhHans: SecretsSettingsCopy = {
    purpose: '你的代理和 MCP 服务器使用的 API 密钥和令牌。保存后，值不会再次显示。',
    yoursTitle: '你的密钥',
    yoursDescription: '你保存或拥有的密钥。在 Happier 需要密钥的地方选择它们。',
    sharedWithYouTitle: '与你共享',
    sharedWithYouDescription: '其他人允许你使用这些密钥。你可以选择它们，但不能查看或修改。',
    add: '添加密钥',
    newSecret: '新密钥',
    emptyTitle: '还没有密钥',
    emptyDescription: '添加一次 API 密钥或令牌，之后在 Happier 需要时直接选择。',
    staleTitle: '无法刷新共享密钥',
    staleDescription: '正在显示上次已知的列表。',
    valueTitle: '值',
    valueSaved: '已保存。不会再次显示。',
    keepTitle: '保存为',
    keepPersonal: '个人',
    keepShared: '共享',
    keepPersonalDescription: '保存在你的账户中。只有你可以使用。',
    keepSharedDescription: '保存在此 Home 上，以便与他人、Team 或群组共享。',
    accessTitle: '谁可以使用',
    accessOnlyYou: '仅你自己',
    accessRecipients: ({ count }: { count: number }) => `你和 ${count} 位接收者`,
    sharePersonalDescription: '共享后会移到此 Home，无法再变回个人密钥。',
    share: '共享',
    manage: '管理',
    storageTitle: '存储',
    storageE2ee: '端到端加密',
    storageE2eeDescription: '只有你共享的人可以读取。',
    storagePlain: '由 Home 管理',
    storagePlainDescription: '此 Home 存储它，并可以读取以便传递。',
    save: '保存密钥',
};

const secretsSettingsTranslations = { zhHans } as const;

return { secretsSettingsTranslations };
})();

const Domain_sessionAccessTranslations = (() => {
const sessionAccessTranslations = { "zh-Hans": {
        withContext: ({ context, label }: { context: string; label: string }) => `${context} · ${label}`,
        withCount: ({ label, count }: { label: string; count: number }) => `${label} +${count}`,
        accessibleSummary: ({ title, label }: { title: string; label: string }) => `${title}: ${label}`,
        accessibleControl: ({ name, control, value }: { name: string; control: string; value: string }) => `${name}, ${control}, ${value}`,
        title: "会话访问权限",
        search: "搜索人员、群组或团队",
        hasAccess: "拥有访问权限",
        yourAccess: "你的访问权限",
        readOnly: "你可以查看获得访问权限的方式。只有会话管理员可以更改。",
        sourceDirect: "直接访问权限",
        sourceTeam: "通过团队获得访问权限",
        sourceGroup: "通过群组获得访问权限",
        people: "人员",
        groups: "群组",
        teams: "团队",
        account: "人员",
        group: "群组",
        team: "团队",
        view: "可查看",
        edit: "可指挥",
        admin: "管理",
        owner: "所有者",
        private: "私密",
        custom: "自定义访问",
        required: "团队策略要求",
        subjectNotFound: "此人员、群组或团队已不可用。",
        subjectIneligible: "无法再向此人员、群组或团队授予访问权限。",
        teamPolicyRequired: "团队策略要求保留此访问权限。",
        selfGrantManaged: "你的访问权限需由其他访问管理员更改。",
        homeUnsupported: "此 Home 尚不支持会话访问。请更新后再管理谁可以打开此会话。",
        openCollaboration: "打开协作",
        authenticationRequired: "请使用此团队接受的方式登录，然后重试。",
        authenticationUnavailable: "此团队要求的登录方式在此 Home 上不可用。",
        delegation: "可批准运行时权限请求",
        remove: "移除访问权限",
        confirmRemove: "确认移除",
        credentialsLost: ({ names }: { names: string }) => `以下团队凭据将在此处停止工作：${names}`,
        ready: "加密访问已就绪",
        prepared: "加密访问已准备",
        recipientRepairRequired: "此人需要修复其账户的加密设置。",
        pending: "加密访问待处理",
        setup: "需要设置加密",
        repair: "加密访问需要修复",
        unavailable: "加密内容不可用",
        notRequired: "此会话未加密，无需准备。",
        preparing: "正在准备加密访问…",
        preparingProgress: ({ count }: { count: number }) => `正在准备加密访问… 已完成 ${count} 项`,
        preparationPending: ({ count }: { count: number }) => `${count} 人的加密访问待准备`,
        preparationSetup: ({ count }: { count: number }) => `${count} 人需要完成加密设置`,
        preparationRepair: ({ count }: { count: number }) => `${count} 人的加密访问需要修复`,
        preparationKeyUnavailable: "此设备无法为该会话准备加密访问。",
        preparationFailed: "访问已保存，但准备加密访问失败。",
        preparationPassFailed: "准备加密访问失败。",
        preparationAnnouncedComplete: "加密访问准备已完成。",
        preparationAnnouncedNeedsAttention: "加密访问仍需设置或修复。",
        preparationCheckFailed: "无法检查加密访问。",
        outcomeUnknown: "结果尚不确定。再次尝试前，Happier 正在检查当前访问状态。",
        historicalLayoutNotice: "与你共享此会话的人在它针对此版本 Happier 更新之前无法打开。",
        historicalLayoutUpdate: "更新以便共享",
        homeReconciled: "已为新的 Home 重置会话访问权限。",
        lockedTitleFallback: "加密会话",
        encryptedAccess: "加密访问",
        aggregatePrepared: ({ count }: { count: number }) => `已完成 ${count} 项`,
        aggregatePending: ({ count }: { count: number }) => `待处理 ${count} 项`,
        aggregateNeedsAttention: ({ count }: { count: number }) => `${count} 项需要设置或修复`,
        prepareNow: "立即准备",
        prepareAgain: "重新准备",
        preparingProgressOf: ({ count, total }: { count: number; total: number }) => `正在准备加密访问… ${count}/${total}`,
        showAllRecipients: "显示所有人",
        hideAllRecipients: "隐藏列表",
        moreRecipients: "显示更多",
        recipientPlainAccount: "未启用加密的账户",
        pendingBody: "该会话已加密。管理员还需要为你准备加密访问，之后才能在这里打开。",
        setupBody: "先在此账户完成加密设置，管理员随后即可为你准备该会话的访问权限。",
        setupAction: "设置加密",
        repairBody: "本设备无法打开为该会话下发的密钥。请重试，或请会话管理员重新准备访问权限。",
        retryAction: "重试",
        unavailableBody: "密钥已打开，但无法解密该会话的内容。会话管理员可以重新准备访问权限。",
        openAccessAction: "打开会话访问权限",
        removedTitle: "访问权限已移除",
        removedBody: "以你当前的访问权限无法打开该会话。会话管理员可以重新共享。",
        removedAnnouncement: ({ name }: { name: string }) => `已将 ${name} 从会话访问权限中移除`,
        browseMore: "浏览全部",
        allLoaded: "已加载全部结果",
        help: "可查看允许阅读。可指挥允许在工具权限范围内指示智能体。管理还允许管理会话访问。这不是隔离的聊天：工作目录和署名不会限制 shell、文件系统或网络访问。"
    } } as const;

return { sessionAccessTranslations };
})();

const Domain_sessionAgentActivityTranslations = (() => {
const en = Shared_sessionAgentActivityTranslations.en;

const zhHans: typeof en = {
    status: {
        queued: '排队中',
        starting: '正在启动',
        running: '运行中',
        waiting: '等待中',
        blocked: '已阻塞',
        succeeded: '已完成',
        failed: '失败',
        timedOut: '已超时',
        cancelled: '已停止',
        unknown: '未知',
    },
    attention: {
        permission: '需要批准',
        userAction: '需要你的回答',
        both: '需要处理',
        bothDescription: '需要批准，也需要你的回答',
    },
    runKind: {
        conversation: '对话',
        review: '审查',
        plan: '计划',
    },
    /** The Agents pane: its "+", its states, its team groups and its live line (agents lab). */
    roster: {
        teamLabel: ({ team, count }) => `团队 ${team} · ${count} 个代理`,
        teamActionsA11y: '团队操作',
        openWork: '打开',
        needsYouCount: ({ count }) => `${count} 个需要你处理`,
        runningCount: ({ count }) => `${count} 个运行中`,
        nothingRunning: '没有正在运行的内容。',
        startAgent: '启动代理',
        machineOffline: ({ machine }) => `${machine} 没有响应`,
        machineOfflineUnnamed: '机器没有响应',
        launch: {
            menuA11y: '启动代理',
            conversationDescription: '在此会话旁与代理对话',
            reviewDescription: '检查目前为止的更改',
            planDescription: '规划接下来的步骤',
            delegateDescription: '交出任务并取回完成结果',
            advancedDescription: '选择代理、权限和配置文件',
        },
        empty: {
            title: '为此会话添加更多代理',
            reason: ({ machine }) => `在你继续工作时，开始一段旁路对话，或请代理审查或规划。它们在 ${machine} 上运行，并在这里汇报。`,
            reasonUnnamed: '在你继续工作时，开始一段旁路对话，或请代理审查或规划。它们会在这里汇报。',
            moreWays: '请求审查、规划或委派',
        },
        unavailable: {
            notEnabled: '此 Home 无法启动代理。',
            machineOffline: ({ machine }) => `启动代理需要 ${machine} 在线。`,
            machineOfflineUnnamed: '启动代理需要这台机器在线。',
            sessionInactive: '此会话已停止。恢复它即可在这里启动代理。',
            externalRunnerInactive: '此会话是在 Happier 之外启动的。Happier 连接期间可以从这里启动代理。',
        },
    },
    summaryA11y: ({ title, status }) => `${title}，${status}`,
    summaryAttentionA11y: ({ title, status, attention }) => `${title}，${status}，${attention}`,
};

const sessionAgentActivityTranslations = { zhHans };

return { sessionAgentActivityTranslations };
})();

const Domain_sessionBoardTranslations = (() => {
type SessionBoardStateTranslation = Shared_sessionBoardTranslations.SessionBoardStateTranslation;

type SessionBoardTranslation = Shared_sessionBoardTranslations.SessionBoardTranslation;

const sessionBoardTranslations = { 'zh-Hans': {
        title: '面板',
        views: {
            label: '面板视图',
            overview: '总览',
            createTitle: '新建面板视图',
            renameTitle: '重命名面板视图',
            reconciled: ({ title }) => `该面板视图已被删除，正在显示${title}。`,
            empty: {
                title: '此视图中暂无内容',
                reason: '在这里添加一个组件，或切换到其他面板视图。',
            },
            actions: {
                create: '新建视图',
                rename: '重命名视图',
                moveBefore: '将视图前移',
                moveAfter: '将视图后移',
                remove: '删除视图',
            },
            remove: {
                title: ({ title }) => `删除“${title}”？`,
                moveMessage: ({ title }) => `其中的组件会移到${title}。会话中不会删除任何内容。`,
                unpinMessage: '其中的组件仍留在会话中，但不再固定到任何视图。',
            },
        },
        add: { note: '笔记', interactiveView: '交互视图' },
        width: { compact: '窄', medium: '中等', wide: '宽', full: '整行宽度' },
        height: { auto: '适应内容', compact: '较矮', regular: '中等', tall: '较高' },
        board: {
            loading: { title: '正在打开面板', reason: '正在加载这个会话固定的内容。' },
            locked: {
                title: '面板仍处于加密状态',
                reason: '这台设备还无法打开该会话。没有任何内容丢失。',
            },
            unopenable: {
                title: '无法读取面板的排列方式',
                reason: '已保存的排列方式无法打开。各个组件本身不受影响。',
            },
            unsupported: {
                title: '此面板需要更新版本的 Happier',
                reason: '内容都已保留。请在受支持的设备上打开，或更新 Happier。',
            },
            unavailable: {
                title: '这里还不能使用面板',
                reason: '没有内容丢失。等这个 Home 启用面板后就会出现。',
            },
            offline: '离线 — 显示的是你上次加载的版本。',
            offlineEmpty: '离线 — 重新连接后即可加载此面板。',
            stale: '显示的是你上次加载的版本。',
        },
        empty: {
            editor: {
                title: '把计划放在聊天旁边',
                description: '固定在这里的笔记和实时视图会留在这个会话中，所有能阅读它的人都能看到。',
                askAgent: '让智能体来做',
                askAgentPrompt: '在这个面板上放一个可以显示以下内容的组件：',
                addNote: '添加笔记',
            },
            viewer: {
                title: '面板上还没有内容',
                description: '人或智能体固定到这个会话的内容会出现在这里。',
            },
        },
        item: {
            untitled: '未命名组件',
            renameA11y: '组件标题',
            reorderA11y: ({ title }) => `重新排序 ${title}`,
            a11yLabelWithWidth: ({ title, width }) => `${title}，${width}`,
            menuGroups: { content: '阅读和编辑', movement: '移动', geometry: '大小', destructive: '移除' },
            loading: { title: '正在加载此组件', reason: '正在从这个 Home 获取内容。' },
            locked: {
                title: '加密内容暂不可用',
                reason: '在这台设备能打开该会话之前，此组件将保持加密。',
            },
            unopenable: {
                title: '无法显示此组件',
                reason: '已保存的内容无法读取。面板的其余部分不受影响。',
            },
            unsupported: {
                title: '此组件需要更新版本的 Happier',
                reason: '内容已保留。请在受支持的设备上打开，或更新 Happier。',
            },
            missing: {
                title: '找不到此组件',
                reason: '面板仍然指向它，但内容不在这个 Home 上。',
            },
            removed: {
                title: '此组件已从面板移除',
                reason: '拥有编辑权限的人为所有人删除了它。',
            },
            pluginUnavailable: {
                title: '此设备上没有该插件',
                reason: '组件已保留。插件在这里可用后会再次显示。',
            },
            rendererUnavailable: {
                title: '此设备无法显示该组件',
                reason: '内容已保留。请在支持交互视图的设备上打开。',
            },
            provenance: {
                note: '笔记',
                interactiveView: '交互视图',
                pluginMissing: ({ pluginId }) => `来自 ${pluginId} · 未安装`,
                pluginSurface: ({ plugin, surface }) => `${surface} · ${plugin}`,
                pluginQualified: ({ label, pluginId }) => `${label} (${pluginId})`,
            },
            actions: {
                remove: '从面板移除',
                openHere: '在这里打开',
                managePlugin: '管理插件',
                prepareEncryption: '设置加密',
                readFull: '阅读完整笔记',
                rename: '重命名组件',
                unpin: '从此视图取消固定',
                moveToView: ({ title }) => `移动到${title}`,
            },
            moved: {
                before: ({ title }) => `${title}已前移。`,
                after: ({ title }) => `${title}已后移。`,
                reordered: ({ title }) => `${title}已移动。`,
                toView: ({ title, view }) => `${title}已移动到${view}。`,
            },
            movePosition: ({ position, total }) => `第 ${position} 项，共 ${total} 项`,
            moveTargetView: ({ title }) => `看板视图${title}`,
            remove: {
                title: '移除此组件？',
                message: '所有能阅读此会话的人都会失去它。已安装的插件仍保持安装。',
            },
        },
        note: {
            titlePlaceholder: '标题',
            titleA11y: '笔记标题',
            untitled: '未命名笔记',
            offline: '保存需要连接到这个 Home。',
            unavailable: '这个 Home 还不支持修改面板。',
            failed: 'Happier 未能保存这条笔记。你的文字还在。',
            outcomeUnknown: 'Happier 无法确认笔记是否已保存。请刷新后再保存。',
            saved: '笔记已保存',
            conflict: {
                message: '这条笔记在另一台设备上发生了改动。',
                reviewLatest: '查看最新版本',
                applyMine: '应用我的修改',
                latestHeading: '最新版本',
            },
        },
        recovered: {
            title: '已恢复的项目',
            description: '这些组件属于该会话，但没有出现在任何面板视图中。',
            pin: '添加到此视图',
        },
        mutation: {
            conflict: '此面板已在其他设备上更改。请刷新以查看最新内容。',
            outcomeUnknown: 'Happier 无法确认该更改是否已保存。',
            denied: '你已不再有权更改此面板。',
            offline: '更改面板需要连接到此 Home。',
            unavailable: '此 Home 尚无法更改面板。',
            updateRequired: '请更新 Happier 以进行此面板更改。',
            hostedHtmlSourceTooLarge: '此交互式视图太大，无法保存。你的草稿仍在这里。',
            noteTooLarge: '此笔记太大，无法保存。你的文本仍在这里。',
            invalid: '此面板更改无效。请检查后重试。',
            notFound: '此面板项目已不可用。请刷新面板。',
            storageFailed: 'Happier 无法安全保存此更改。你的内容仍在这里。',
            serverFailed: '此 Home 无法完成面板更改。请重试。',
            failed: 'Happier 无法应用该面板更改。',
        },
        hostedHtmlApproval: {
            title: '允许此交互式视图？',
            body: '此授权仅适用于此会话中的此视图。发送消息仍需要你在视图内点击。',
            resources: ({ count }) => `可读取 ${count} 个会话资源`,
            actions: ({ count }) => `可运行 ${count} 个操作`,
            sendMessages: '可请求 Happier 发送消息',
            loadsFrom: ({ origin }) => `从 ${origin} 加载`,
            allow: '允许',
            notNow: '暂不',
            declined: {
                title: '交互式视图尚未允许',
                reason: '随时可以查看它请求的权限。',
                review: '查看',
            },
        },
        sidebar: {
            openInDetails: '在详情中打开',
            openBoard: '打开面板',
            sharedWithEveryone: '与这里的所有人共享',
            widgetCount: ({ count }) => `${count} 个组件`,
        },
        mobile: { searchPlaceholder: '搜索此面板' },
        inline: {
            openBoard: '打开面板',
            openBoardA11y: ({ title }) => `在面板中打开“${title}”`,
        },
        companion: {
            title: '随行面板',
            inCompanionA11y: '在你的随行面板中',
            empty: {
                title: '让会话一直在视线内',
                reason: '把会话摘要或看板小组件放在聊天旁边：正在运行什么、什么在等你、改了什么。',
                note: '只有你能看到你的随行面板。',
            },
            pane: {
                besideChat: '在聊天旁边',
                itemCount: ({ count }: { count: number }) => `${count} 项`,
                justForYou: '只属于你，在聊天旁边',
            },
            actions: {
                addSummary: '添加会话摘要',
                addItem: ({ title }) => `添加${title}`,
                moveToLeading: '移到左侧',
                moveToTrailing: '移到右侧',
                moveToFirst: '移到最前',
                moveToLast: '移到最后',
                compact: '紧凑尺寸',
                comfortable: '宽松尺寸',
                openFull: '打开完整随行面板',
                openOnBoard: '在看板中打开',
                collapse: '收起随行面板',
                expand: '展开随行面板',
                hide: '隐藏随行面板',
                addToCompanion: '添加到随行面板',
                removeFromCompanion: '从随行面板移除',
                undo: '撤销',
                menuA11y: '随行面板选项',
                itemMenuA11y: ({ title }) => `${title}的选项`,
            },
            a11y: {
                headerAction: ({ count }) => `随行面板，${count} 个项目`,
                show: ({ count }) => `显示随行面板，${count} 个项目`,
                expand: ({ count }) => `展开随行面板，${count} 个项目`,
            },
            summary: {
                review: '查看',
                title: '会话摘要',
                untitled: '会话',
                approvals: ({ count }) => `${count} 项等待你处理`,
                workflows: ({ count }) => `${count} 个工作流正在运行`,
                changedFiles: ({ count }) => `已更改 ${count} 个`,
                tokens: ({ count }) => `${count} 个令牌`,
                contextPercent: ({ percent }) => `上下文 ${percent}%`,
                contextOnly: '已用上下文',
                moreDetails: '更多详情',
                moreDetailsA11y: ({ count }) => `更多详情，另有 ${count} 行`,
                partial: '部分详情在此处无法查看。',
            },
            notices: {
                shown: '已显示随行面板',
                hidden: '已隐藏随行面板',
                added: '已添加到随行面板',
                removed: '已从随行面板移除',
                reordered: '已重新排序随行面板',
                moved: '已移动随行面板',
                boardOpened: '智能体已打开看板',
                returnedToChat: '智能体已返回聊天',
                boardViewSelected: '智能体已选择看板视图',
                boardItemRevealed: '智能体已打开看板项目',
                fullOpened: '智能体已打开随行面板',
            },
        },
    } } as const satisfies Pick<Readonly<Record<string, SessionBoardTranslation>>, "zh-Hans">;

return { sessionBoardTranslations };
})();

const Domain_sessionCollaborationPaneTranslations = (() => {
type PaneCopy = Shared_sessionCollaborationPaneTranslations.PaneCopy;

const en = Shared_sessionCollaborationPaneTranslations.en;

const sessionCollaborationPaneTranslations: Pick<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', PaneCopy>, "zh-Hans"> = { 'zh-Hans': {
        hereOne: ({ name }) => `${name} 在这里`,
        hereTwo: ({ first, second }) => `${first} 和 ${second} 在这里`,
        hereMany: ({ first, count }) => `${first} 和其他 ${count.toLocaleString()} 人在这里`,
        typingOne: ({ name }) => `${name} 正在输入…`,
        typingMany: ({ count }) => `${count.toLocaleString()} 人正在输入…`,
        justYouHere: '只有你在这里',
        justYouHint: '你共享给的人会显示在这里',
        you: '你',
        presenceConnecting: '正在查看谁在这里…',
        presenceUnavailable: '实时在线状态暂时没有响应',
        presenceUnsupported: '此 Home 不提供实时在线状态',
        responsibleUnsupported: '此 Home 不记录负责人',
        inviteTitle: '在会话旁边讨论',
        inviteBody: '开始对话、提及他人,准备好后把答案交给 Agent。',
        readOnly: '你可以阅读。能编辑此会话的人可以发言。',
        offline: '你已离线 · 显示最近的对话',
        lockedTitle: '暂时无法在此设备上打开这些对话',
        lockedBody: '它们经过端到端加密,而此设备的加密设置与此会话不一致。',
        revokedTitle: '你已无法访问这些对话',
        revokedBody: '此会话的管理者更改了可查看的人。你写的消息仍保留在会话中。',
        namesTwo: ({ first, second }) => `${first}和${second}`,
        namesThree: ({ first, second, third }) => `${first}、${second}和${third}`,
        namesMore: ({ first, second, count }) => `${first}、${second}等 ${count.toLocaleString()} 个`,
        haveAccess: '有访问权限',
        hasAccess: '有访问权限',
        onlyYou: '仅你自己',
        notShared: '尚未与任何人共享',
        publicLinkOn: '公开链接已开启',
        accessLoading: '正在查看谁有访问权限…',
        accessError: '无法加载访问权限',
        shareTitle: '共享此会话',
        shareBody: ({ home }) => `你在 ${home} 添加的人可以关注此会话并参与对话。`,
        collapse: '收起',
        linkOn: '开启',
        linkOff: '关闭',
        linkGrants: '任何拥有链接的人都可以查看记录,无需账号。',
        linkExpires: ({ date }) => `${date} 到期`,
        linkNeverExpires: '永不过期',
        linkAsksConsent: '需要同意',
        linkNoConsent: '无需同意',
        linkHidden: '此链接是之前创建的,无法再次显示。请创建新链接后复制。',
        qrCode: '二维码',
        hideQrCode: '隐藏二维码',
        newLink: '新链接…',
        turnOff: '关闭',
        turnOffTitle: '关闭公开链接?',
        turnOffBody: '拥有链接的人将立即失去访问权限。你之后可以再创建新链接。',
        newLinkReplaces: '新链接创建后,当前链接将失效。',
        linkDenied: '只有管理此会话的人才能创建公开链接。',
        linkLoadFailed: '无法检查公开链接。',
        justYouTitle: '一起处理这个会话',
        justYouBody: ({ home }) => `与 ${home} 上的人共享。他们可以关注进展、在这里讨论,并在你离开时接手。`,
        share: '共享',
        justYouNote: '或创建任何人都能查看的公开链接。',
        sharingOffTitle: ({ home }) => `${home} 不与他人共享会话`,
        sharingOffBody: '你仍可以创建任何人都能查看的公开链接。',
        sharingOffPrivateBody: '此 Home 上的会话仅属于你。',
        accessDenied: '只有管理此会话的人才能更改访问权限。你仍可以参与对话。',
    } };

return { sessionCollaborationPaneTranslations };
})();

const Domain_sessionCollaborationTranslations = (() => {
const sessionCollaborationPaneTranslations = {...Domain_sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations, ...EnglishFeatures.sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations};

const en = Shared_sessionCollaborationTranslations.en;

const sessionCollaborationTranslations: Pick<Record<'en'|'ca'|'de'|'es'|'fr'|'it'|'ja'|'pl'|'pt'|'ru'|'zh-Hans'|'zh-Hant', typeof en>, "zh-Hans"> = { 'zh-Hans': { pane: sessionCollaborationPaneTranslations['zh-Hans'], title: '协作', viewingNow: '正在查看', justYou: '只有你', typing: '正在输入…', stale: '可能不是最新', unavailable: '实时在线状态不可用', connecting: '连接中…', unnamed: 'Happier 成员', open: '打开协作', conversations: '对话', accessUnavailable: '会话访问权限不可用', accessUnavailableReason: '此 Home 不支持将会话共享给其他人。', discussion: { featureUnavailable: "此 Home 未启用对话。", bindingUnavailable: "请重新登录此 Home 以查看对话。", scopeMismatch: "这些对话属于此 Home 上的其他账户。", modeMismatch: "内容与会话的加密模式不匹配。请重试，或请会话管理员检查访问权限。",  title: '对话', newDiscussion: '新建对话', create: '创建对话', titlePlaceholder: '对话标题', messagePlaceholder: '写下消息…', active: '进行中', activeDisclosure: '显示进行中的对话', archived: '已归档', archivedDisclosure: '显示已归档的对话', emptyActive: '还没有进行中的对话。', emptyArchived: '没有已归档的对话。', loading: '正在加载对话…', loadError: '无法加载对话。', retry: '重试', checking: '正在检查更新…', deliveryUnknown: '发送结果未知 — 重试前请先检查。', locked: '你可以阅读此对话，但不能发布消息。', offline: '你当前离线。重新连接后即可继续。', unavailable: '此对话不可用。', unreadCount: ({ count }) => `${count.toLocaleString()} 条未读`, unreadMentionCount: ({ count }) => `${count.toLocaleString()} 条未读提及`,
        mentioned: '有人提到了你', unreadConversations: '未读对话', messageCount: ({ count }) => `${count.toLocaleString()} 条消息`, viaAgent: '由 Agent 发送', collaborator: '协作者', contentUnavailable: '消息不可用', rename: '重命名对话', archive: '归档对话', restore: '恢复对话', selection: { copy: '复制', askAgent: '询问 Agent', sendToSession: '发送到会话', handoffError: '无法将所选消息添加到会话编辑器。' }, titleRequired: '添加标题以开始此对话。', encryptedTitle: '加密对话', archivedNotice: '此对话已归档。', sessionArchived: '此会话已归档。', postDenied: '你已无法在此会话中发布消息。', invalidMention: '你提及的人已无法读取此会话。', invalidContent: '此消息无法按当前内容发送。它可能为空或过长。', idempotencyConflict: '此标识已用于发送另一条不同的消息。', sendFailed: '此消息无法发送。', dismiss: '关闭', loadOlder: '加载更早的消息', loadMore: '加载更多对话' } } };

return { sessionCollaborationTranslations };
})();

const Domain_sessionCompanionTranslations = (() => {
type SessionCompanionTranslations = Shared_sessionCompanionTranslations.SessionCompanionTranslations;

const sessionCompanionTranslations = { 'zh-Hans': {
        status: {
            waitingForYou: '等你处理',
            pausedBeforeStep: ({ agent, step, total }) => `${agent} 在第 ${step}/${total} 步之前暂停`,
            stepOfPlan: ({ step, total }) => `计划的第 ${step}/${total} 步`,
            agentFallback: '代理',
        },
        ask: {
            question: ({ summary }) => `${summary}?`,
            allow: '允许',
            deny: '拒绝',
            showInChat: '在聊天中显示',
            moreWaiting: ({ count }) => `还有 ${count} 个在等待`,
            allowed: ({ summary }) => `已允许:${summary}`,
            denied: ({ summary }) => `已拒绝:${summary}`,
            justNow: '刚刚',
            failed: '你的回答没有送达会话。请重试。',
            answerWhenBack: ({ machine }) => `${machine} 恢复后即可回答。`,
            answerWhenSessionBack: '会话恢复后即可回答。',
            notAllowed: '只有可以运行此会话的人才能回答。',
            groupA11y: '等你处理',
        },
        facts: {
            subagents: '子代理',
            changed: '已更改',
            context: '上下文',
            subagentsValue: ({ live, total }) => (live > 0 ? `${live}/${total}` : `${total}`),
            contextValue: ({ percent }) => `${percent}%`,
            opensAgents: '打开代理',
            opensGit: '打开 Git',
            opensUsage: '打开用量',
        },
        plan: {
            title: '计划',
            description: ({ agent }) => `${agent} 在此会话中的待办清单`,
            progress: ({ done, total }) => `${done}/${total}`,
            progressA11y: ({ done, total }) => `已完成 ${done}/${total}`,
            emptyTitle: '还没有计划',
            emptyReason: '代理写下待办清单后,会在这里逐步显示。',
            stepDone: '已完成',
            stepCurrent: '当前步骤',
        },
        picker: {
            open: '添加到随行面板',
            chooseWidget: '选择小组件…',
            onTheBoard: ({ source }) => `${source} · 在看板上`,
        },
        drop: { keepBesideChat: '放在聊天旁边' },
        freshness: { machineOffline: ({ machine }) => `${machine} 已离线` },
        needsYouA11y: ({ count }) => `随行面板,${count} 个等你处理`,
    } } as const satisfies Pick<Readonly<Record<string, SessionCompanionTranslations>>, "zh-Hans">;

return { sessionCompanionTranslations };
})();

const Domain_sessionConversationSurfaceTranslations = (() => {
const en = Shared_sessionConversationSurfaceTranslations.en;

const zhHans: typeof en = {
    discussion: {
        loadingTitle: '正在打开此对话…',
        offlineTitle: '此对话无法离线查看',
        offlineReason: '重新连接后，会从你离开的地方打开。',
        errorTitle: '无法打开此对话',
        lockedTitle: '暂时无法在此设备上打开此对话',
        lockedReason: '它经过端到端加密，而此设备的加密设置与该会话不一致。',
        revokedTitle: '你已无法访问此对话',
        revokedReason: '此会话已不再与你共享。你写的消息会保留在会话中。',
        unavailableTitle: '此处无法使用对话',
        closeTab: '关闭标签页',
    },
    draft: {
        leadTitle: '询问智能体',
        leadBody: '它会作为独立的对话在会话旁运行，并以这些消息为上下文。发送之前不会开始。',
    },
    context: {
        fromConversation: ({ title, count }) => `来自 ${title} · ${count} 条消息`,
        fromUntitled: ({ count }) => `来自一个对话 · ${count} 条消息`,
    },
    origin: {
        fromConversation: ({ title }) => `来自 ${title}`,
        fromUntitled: '来自一个对话',
    },
    run: {
        details: '运行详情',
        loadingTitle: '正在打开与智能体的对话…',
        errorTitle: '无法打开与智能体的对话',
    },
};

const sessionConversationSurfaceTranslations = { zhHans };

return { sessionConversationSurfaceTranslations };
})();

const Domain_sessionDirectoryRecoveryTranslations = (() => {
const en = Shared_sessionDirectoryRecoveryTranslations.en;

const sessionDirectoryRecoveryTranslations = { 'zh-Hans': {
        title: ({ machine }) => `此聊天的专用文件夹已不在 ${machine} 上。`,
        body: '你可以在一个新的空文件夹中继续。聊天记录会保留在这里，但旧文件夹中的本地文件不会恢复。',
        continue: '在新文件夹中继续', notNow: '暂时不',
        offlineDelete: ({ machine }) => `${machine} 上的专用文件夹将在该电脑下次上线时删除。`,
    } } satisfies Pick<Record<import('../../_all').SupportedLanguage, typeof en>, "zh-Hans">;

return { sessionDirectoryRecoveryTranslations };
})();

const Domain_sessionDraftTranslations = (() => {
const en = Shared_sessionDraftTranslations.en;

const zhHans: typeof en = {
    sectionTitle: '草稿',
    sectionTitleForHome: ({ home }) => `${home} 上的草稿`,
    waitingSectionTitleForHome: ({ home }) => `正在 ${home} 上等待计算机`,
    badge: '草稿',
    untitled: '未命名草稿',
    continueEditing: '继续编辑',
    startAnother: '再开一个',
    executionRunStart: {
        starting: '正在启动与代理的对话…',
        reconciling: '正在检查这次代理对话是否已启动…',
        unresolved: '无法确认这次代理对话是否已启动。再次启动可能会创建第二次对话。',
        targetChanged: '在对话启动之前，此会话的计算机发生了变化。未启动任何内容。',
        secretReferenceOverlayUpdateRequired: '在代理对话中使用共享密钥需要已更新的计算机。未启动任何内容。',
    },
    status: {
        offline: '离线 — 已保存在此设备上',
        syncing: '正在同步…',
        conflict: '需要检查',
        unsupported: '未同步 — 此 Home 无法同步该草稿',
        startInterrupted: '启动已中断',
    },
    availability: {
        machineUnavailable: '机器不可用',
        pluginUnavailable: '插件不可用',
        attachmentNeedsAttention: '附件需要处理',
    },
    new: { action: '新建会话' },
    delete: {
        action: '删除草稿',
        confirmTitle: '删除此草稿？',
        confirmDescription: '这会从你所有已同步的设备上移除该草稿。',
    },
    conflict: {
        title: '检查冲突的更改',
        description: '为每个字段选择要保留的版本。替换前可以先复制本设备的版本。',
        mine: '此设备',
        synced: '已同步版本',
        useSynced: '使用已同步版本',
        keepDevice: '保留此设备的版本',
        copyMine: '复制我的',
        copied: '已复制',
        copyFailed: '无法复制此值。',
        field: {
            text: '消息',
            mentions: '提及',
            attachments: '附件',
            recipient: '接收者',
            agentContinuation: '代理续接',
            executionRunRequestedAction: '运行投递',
        },
    },
};

const sessionDraftTranslations = { zhHans };

return { sessionDraftTranslations };
})();

const Domain_sessionEmbeddedTranslations = (() => {
const en = Shared_sessionEmbeddedTranslations.en;

const translated = Shared_sessionEmbeddedTranslations.translated;

const sessionEmbeddedTranslations = { 'zh-Hans': translated({
        unavailable: '此会话不可用',
        respondInSession: '打开会话以回复。',
        regionLabel: ({ title }) => `会话：${title}`,
        newChatWelcome: '我们要做什么？',
    }) } as const;

return { sessionEmbeddedTranslations };
})();

const Domain_sessionFollowTranslations = (() => {
type SessionFollowTranslations = Shared_sessionFollowTranslations.SessionFollowTranslations;

const en = Shared_sessionFollowTranslations.en;

const sessionFollowTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionFollowTranslations
>, "zh-Hans"> = { 'zh-Hans': {
        "notificationBody": {"message":"此会话中有新消息。","failed":"本轮运行失败。","cancelled":"本轮运行已取消。","sourceUnavailable":"此会话的来源不可用。"},
        "follow": "关注",
        "unfollow": "取消关注",
        "following": "已关注",
        "notifications": "通知",
        "unavailableTitle": "无法关注",
        "unavailableDescription": "此 Home 不支持关注会话。",
        "unreachableTitle": "无法连接此 Home",
        "unreachableDescription": "Happier 无法确认此 Home 是否支持关注会话。请在其可访问时重试。",
        "editor": {
            "title": "关注此会话",
            "subtitle": "接收对你重要的更新。",
            "ownerSubtitle": "这个会话属于你，因此它的更新始终会送达。",
            "externalAttachedOnly": "后台同步已关闭，因此只有在此会话处于连接状态时才可能收到更新。"
        },
        "level": {
            "none": "不通知",
            "important": "重要更新",
            "all_messages": "每条新消息"
        },
        "voice": {
            "title": "纳入 Voice",
            "subtitle": "Voice 可以保留此会话的上下文。",
            "waitingRuntime": "正在等待 Voice 连接。",
            "unsupported": "此运行环境不支持将已关注的会话纳入 Voice。",
            "providerWithheld": "此 Voice 模式无法包含已存储的会话更新。",
            "waitingEncrypted": "解锁此会话以将其纳入 Voice。",
            "initialSnapshotPending": "在下一轮 Voice 对话中，提供简短的当前状态摘要。"
        },
        "footer": "关注不会改变谁可以访问此会话。",
        "settingsLink": "通知设置…",
        "assignedExplanation": "因分配给你而关注",
        "assignedNotice": "有一个会话分配给了你。",
        "sharedNotice": "有人与你共享了一个会话。",
        "wakeEventExplanation": "关注的上下文发生变化，因此 Happier 用该更新唤醒了此智能体。",
        "accessLost": "你已无权访问此会话。",
        "offline": "你已离线。请重新连接以更改关注设置。",
        "archived": "此会话归档期间，关注将暂停。",
        "sources": {
            "title": "会话更新",
            "waitingRuntime": "正在等待目标会话重新连接。",
            "unsupported": "请更新或重新连接目标机器上的 CLI 以接收更新。",
            "pausedArchived": "源会话或目标会话归档期间，更新会暂停。",
            "add": "在其他会话中关注…",
            "addSource": "从另一个会话发送更新…",
            "chooseDestinationTitle": "在其他会话中关注",
            "chooseSourceTitle": "从另一个会话发送更新",
            "row": ({ title }) => `来自“${title}”的更新`,
            "nextTurn": "下一轮",
            "wakeOnHumanChange": "有人添加消息时唤醒",
            "stop": "停止更新",
            "stopForSource": ({ title }) => `停止来自“${title}”的更新`,
            "includeNextTurn": "在目标会话的下一轮中包含更新。",
            "sourceKeyPreparing": "正在准备加密访问…",
            "sourceKeyWaiting": "正在等待加密访问。",
            "sourceKeyUnavailable": "此计算机无法提供加密访问。",
            "sourceSessionKeyUnavailable": "此会话的加密访问在此处不可用。",
            "catchUpPending": "待补充更新"
        },
        "preferences": {
            "title": "自动关注",
            "assigned": "分配给我的会话",
            "direct": "直接共享的会话",
            "team": "通过团队共享的会话",
            "group": "通过群组共享的会话",
            "help": "适用于新的分配和新获得访问权限的会话。现有选择保持不变。"
        }
    } };

return { sessionFollowTranslations };
})();

const Domain_sessionGitBranchesTranslations = (() => {
type SessionGitBranchesTranslations = Shared_sessionGitBranchesTranslations.SessionGitBranchesTranslations;

const en = Shared_sessionGitBranchesTranslations.en;

const zhHans: SessionGitBranchesTranslations = {
    openA11y: ({ branch }) => `分支 ${branch}：切换分支或查看暂存的更改`,
    searchPlaceholder: '切换或创建分支',
    category: { current: '当前', branches: '分支', remote: '远程分支', keptAside: '已暂存', worktrees: '工作树', start: '开始新的工作' },
    tracks: ({ upstream }) => `跟踪 ${upstream}`,
    onlyHere: '仅在此机器上',
    changed: ({ count }) => `${count} 项更改`,
    ahead: ({ count }) => `${count} 个待推送`,
    keptAsideWhen: ({ origin, when }) => `${origin} · ${when}`,
    newBranch: ({ branch }) => `从 ${branch} 新建分支…`,
    newBranchDetached: '新建分支…',
    newBranchSubtitle: '在搜索框中输入名称',
    newWorktree: '新建工作树…',
    newWorktreeSubtitle: '在新会话中处理另一个分支',
    keepAside: '暂存更改',
    keepAsideSubtitle: ({ count }) => `暂存 ${count} 项更改，从干净的状态开始`,
    keepAsideNothing: '没有可暂存的更改',
    keepAsideFailed: '无法暂存更改。',
    loadFailed: '无法加载分支',
    notice: {
        title: ({ branch }) => `你在 ${branch} 上暂存了更改`,
        reason: ({ when }) => `暂存于 ${when}。恢复它们以继续工作。`,
        reasonUndated: '恢复它们以继续工作。',
        restore: '恢复更改',
        lookFirst: '先看看',
        dismiss: '暂不',
        restoreFailed: '无法恢复更改。',
    },
};

const sessionGitBranchesTranslations = { zhHans };

return { sessionGitBranchesTranslations };
})();

const Domain_sessionGitDisplayTranslations = (() => {
const en = Shared_sessionGitDisplayTranslations.en;

const zhHans: typeof en = {
    settingsLayout: 'Git 面板布局',
    settingsShowAs: '已更改文件显示为',
    trigger: '显示选项',
    paneGroup: '面板',
    changesGroup: '更改',
    layout: '布局',
    layoutUnified: '统一',
    layoutTabs: '标签页',
    layoutDescription: '从更改到历史一次滚动浏览，或将更改和历史分为两个视图。',
    showAs: '显示为',
    showAsList: '列表',
    showAsTree: '树',
    showAsDescription: '以列表显示已更改的文件，或按文件夹分组以便整个文件夹一起选择。',
    density: '密度',
    densityDefault: '默认',
    densityCompact: '紧凑',
    note: '树中的行始终为紧凑。会为你的账户记住。',
    selectFolder: ({ folder }) => `选择 ${folder} 中的所有更改`,
    selectFile: ({ file }) => `选择 ${file} 用于下次提交`,
};

const sessionGitDisplayTranslations = { zhHans };

return { sessionGitDisplayTranslations };
})();

const Domain_sessionGitPaneTranslations = (() => {
const en = Shared_sessionGitPaneTranslations.en;

const fidelity = Shared_sessionGitPaneTranslations.fidelity;

const withFidelity = Shared_sessionGitPaneTranslations.withFidelity;

const zhHans: typeof en = {
    scope: { allChanges: '所有更改' },
    subTabs: { changes: '更改', sync: '同步', history: '历史' },
    header: {
        changed: ({ count }) => `${count} 项更改`,
        toPush: ({ count }) => `${count} 个待推送`,
        toPull: ({ count }) => `${count} 个待拉取`,
        push: ({ count }) => `推送 ${count}`,
        pull: ({ count }) => `拉取 ${count}`,
        publish: '发布',
        folderOnMachine: ({ folder, machine }) => `${machine} 上的 ${folder}`,
    },
    groups: {
        session: '本会话中的更改',
        elsewhere: ({ repo }) => `${repo} 中的其他更改`,
        elsewhereUnnamed: '此仓库中的其他更改',
        selectGroup: ({ group }) => `选择“${group}”中的所有文件`,
    },
    row: { renamedFrom: ({ path }) => `原 ${path}` },
    commit: {
        toBranch: ({ branch }) => `提交到 ${branch}`,
        selection: ({ count }) => `${count} 个文件`,
    },
    flow: {
        undo: {
            action: 'Undo last commit',
            description: 'Keep its changes staged for the next commit',
            running: 'Undoing the last commit…',
            done: 'Undid the last commit',
            staged: 'Your changes are still staged',
            failed: 'The commit could not be undone',
        },
        lease: {
            push: 'Force push with lease…',
            description: 'Replace the observed remote history',
            fetchFirst: 'Fetch first to observe the remote branch',
            confirmTitle: 'Replace the remote branch?',
            confirmBody: ({ target, oid }: { target: string; oid: string }) => `Replace ${target} with your local history only if it still points to ${oid}. Other people’s commits may be removed from that branch. If it has changed, Git refuses the push.`,
        },
        choices: {
            dirtyTitle: ({ count, formatted }) => (count === 1 ? `你有 1 项未提交的更改` : `你有 ${formatted} 项未提交的更改`),
            dirtyBody: '拉取可能会影响它们。拉取时先暂存（之后马上恢复），或仅在没有重叠时让 Git 拉取。',
            keepAsideAndPull: '暂存后拉取',
            pullIfNoOverlap: '无重叠时拉取',
            divergedPullBody: '你的分支和 origin 都有新提交。把你的提交放到 origin 之上，或将两者合并。',
            divergedPushBody: '先取回 origin 的提交（你的放在上面或合并），然后再次推送。你的提交会留在这台机器上。',
            rebase: '变基到 origin',
            merge: '合并 origin',
        },
        writesOff: {
            title: '已关闭从 Happier 提交',
            body: '你可以阅读和审阅每项更改。开启版本控制操作即可在这里提交、推送和拉取。',
            turnOn: '开启',
        },
        header: {
            noChanges: '无更改',
        },
        action: {
            fetch: '获取',
            publish: '发布分支',
            createPr: '创建 PR',
            openPr: ({ number }) => `#${number}`,
            resolve: ({ count }) => `解决 ${count} 个`,
            upToDate: '已是最新',
            pushing: ({ count }) => `正在推送 ${count} 个…`,
            pulling: ({ count }) => `正在拉取 ${count} 个…`,
            fetching: '正在获取…',
            publishing: '正在发布…',
            creatingPr: '正在创建…',
        },
        menu: {
            open: '更多同步操作',
            push: '推送',
            pull: '拉取',
            pushTo: ({ target }) => `到 ${target}`,
            pullFrom: ({ target }) => `从 ${target}`,
            nothingToPush: '没有可推送的内容',
            upToDate: '已是最新',
            fetchHint: '检查 origin 上的新提交',
            publishHint: '将此分支放到 origin',
            createPr: '创建拉取请求…',
            createPrInto: ({ base }) => `合并到 ${base}`,
            unavailable: '此处不可用',
            more: '更多',
        },
        running: {
            branchSwitch: '正在切换分支…',
            branchCreate: '正在创建分支…',
            stashCreate: '正在暂存你的更改…',
            discard: '正在放弃更改…',
            revert: '正在还原提交…',
            generic: '处理中…',
        },
        done: {
            untouched: ({ count, formatted }) => (count === 1 ? `你未提交的 1 项更改保持不变` : `你未提交的 ${formatted} 项更改保持不变`),
            commit: '已提交',
            commitFiles: ({ count, formatted }) => (count === 1 ? `已提交 1 个文件` : `已提交 ${formatted} 个文件`),
            push: '已推送',
            pushCommits: ({ count, formatted }) => (count === 1 ? `已推送 1 个提交` : `已推送 ${formatted} 个提交`),
            upToDate: ({ target }) => `${target} 已是最新`,
            pull: '已拉取',
            pullCommits: ({ count, formatted }) => (count === 1 ? `已拉取 1 个提交` : `已拉取 ${formatted} 个提交`),
            fetch: ({ target }) => `已检查 ${target}`,
            branchSwitch: '已切换分支',
            branchCreate: '已创建分支',
            stashCreate: '已暂存你的更改',
            discard: '已放弃更改',
            revert: '已还原提交',
            pullRequest: '拉取请求已就绪',
            generic: '完成',
        },
        failed: {
            unknownTitle: '无法确认结果',
            unknownBody: '机器在 Git 返回结果前停止了响应。再次检查以查看发生了什么。',
            origin: 'origin',
            thisMachine: '这台机器',
            refreshTitle: '已提交，但列表未刷新',
            refreshBody: '你的提交是安全的。重试即可查看当前更改。',
            rejectedTitle: ({ target }) => `${target} 有你没有的提交`,
            rejectedBody: '获取它们以查看变化。你的提交会留在这台机器上，直到你再次推送。',
            authTitle: ({ machine, provider }) => `${provider} 未接受来自 ${machine} 的登录`,
            authBody: ({ machine }) => `${machine} 上的 Git 没有此远程仓库的有效凭据。请在那里登录后重试。`,
            offlineTitle: ({ machine }) => `${machine} 已离线`,
            offlineBody: '那里现在无法运行任何操作。你的工作在那台机器上是安全的。',
            conflictTitle: '因更改冲突而停止',
            conflictBody: '部分文件在两侧都有更改。解决后再继续。',
            networkTitle: ({ target }) => `无法连接到 ${target}`,
            networkBody: '机器无法连接到远程仓库。请检查网络后重试。',
            commitTitle: '提交未完成',
            pushTitle: '推送未完成',
            pullTitle: '拉取未完成',
            fetchTitle: '无法检查新提交',
            pullRequestTitle: '未创建拉取请求',
            genericTitle: '操作未完成',
        },
        recover: {
            open: '打开',
            tryAgain: '重试',
            fetch: '获取',
            checkAgain: '再次检查',
            showConflicts: '显示冲突',
        },
        timeline: {
            title: '时间线',
            now: '现在',
            loading: '正在读取历史…',
            uncommitted: ({ count, formatted }) => (count === 1 ? `1 项更改未提交` : `${formatted} 项更改未提交`),
            selected: ({ count, formatted }) => (count === 1 ? `已为下次提交选择 1 项` : `已为下次提交选择 ${formatted} 项`),
            nothingSelected: '未选择',
            earlierToday: '今天早些时候',
            yesterday: '昨天',
            older: '更早',
            justNow: '刚刚',
            toPull: '待拉取',
            originFurther: ({ name }) => `${name} 在更早的位置`,
            originA11y: ({ name }) => `${name} 在这里`,
        },
        clean: {
            titleUpToDate: '全部已提交并推送',
            titleCommitted: '全部已提交',
            bodyUpToDate: ({ branch, upstream }) => `${branch} 与 ${upstream} 一致。此会话的新更改会显示在这里。`,
            body: '此会话的新更改会显示在这里。',
            createPullRequest: '创建拉取请求',
            openPullRequest: ({ number }) => `打开拉取请求 #${number}`,
            lastCommit: ({ when }) => `最近提交 ${when}`,
        },
        conflicts: {
            skip: '跳过此提交',
            askAgentTask: ({ files, operation }) => `解决 ${files} 中的${operation}冲突。保留双方的意图，编辑并暂存已解决的文件，然后停下来等我审阅。不要继续、中止、提交或推送，也不要整体选择某一方。`,
            revert: '还原',
            cherryPick: '拣选',
            merge: '合并',
            rebase: '变基',
            stopped: ({ count, formatted, operation }) => (count === 1 ? `${operation}已停止：1 个文件在两侧都有更改` : `${operation}已停止：${formatted} 个文件在两侧都有更改`),
            readyToContinue: ({ operation }) => `所有冲突已解决。继续${operation}。`,
            filesInConflict: ({ count, formatted }) => (count === 1 ? `1 个文件存在冲突` : `${formatted} 个文件存在冲突`),
            body: '打开“需要你处理”中的每个文件，或让代理来解决。',
            continueBody: '在你继续之前不会提交任何内容。',
            askAgent: '让代理解决',
            continue: ({ operation }) => `继续${operation}`,
            abort: ({ operation }) => `中止${operation}`,
            abortTitle: ({ operation }) => `要中止${operation}吗？`,
            abortBody: '分支会回到开始之前的状态。目前的解决结果将丢失。',
            needsYou: '需要你处理',
            mergedCleanly: '已顺利合并',
        },
        commit: {
            selectFirst: '选择要提交的文件',
        },
        tools: {
            title: '远程仓库与合并',
            subtitle: '添加远程仓库，合并或变基分支',
        },
    },
    paused: { reason: '会话已暂停', resume: '继续' },
    notRepository: {
        title: '在这里跟踪代理的更改',
        body: ({ folder }) => `${folder} 还不是仓库。创建一个即可审阅、提交和撤销每项更改。`,
        bodyUnnamed: '此文件夹还不是仓库。创建一个即可审阅、提交和撤销每项更改。',
    },
};

const sessionGitPaneTranslations = { zhHans: withFidelity(zhHans) };

return { sessionGitPaneTranslations };
})();

const Domain_sessionGitPullRequestTranslations = (() => {
type ProviderArgs = Shared_sessionGitPullRequestTranslations.ProviderArgs;

type GitPullRequestCopy = Shared_sessionGitPullRequestTranslations.GitPullRequestCopy;

const en = Shared_sessionGitPullRequestTranslations.en;

const zhHans: GitPullRequestCopy = {
    form: {
        title: '新建拉取请求', expand: '在详情面板中打开', moveBack: '移回侧边栏',
        close: '关闭表单（草稿会保留）', base: '合并到', titlePlaceholder: '标题',
        bodyPlaceholder: '改了什么，为什么改', draft: '草稿', create: '创建拉取请求', creating: '正在创建…',
        continueOn: ({ provider }) => `在 ${provider} 上继续`, pointer: '新的拉取请求已在详情中打开', pointerShow: '显示',
        openedProviderPage: ({ provider }) => `已打开 ${provider} 以完成它；你的文字保留在这里。`,
    },
    failure: {
        authFailed: ({ provider }) => `${provider} 未接受这台机器的登录`,
        network: ({ provider }) => `无法连接 ${provider}`,
        machineOffline: '机器已离线；草稿会保留',
        blocked: '另一个 Git 操作正在进行；完成后再试',
        other: '拉取请求未创建',
    },
    card: {
        number: ({ number }) => `#${number}`, intoBase: ({ base }) => `合并到 ${base}`,
        state: { open: '打开', draft: '草稿', merged: '已合并', closed: '已关闭', unknown: '拉取请求' },
        checks: { pending: '检查进行中', success: '检查通过', failure: '检查失败', unknown: '检查' },
        openOn: ({ provider }) => `在 ${provider} 上打开`, copyLink: '复制链接', copied: '链接已复制',
    },
    settings: {
        placementTitle: '新拉取请求打开位置', placementDescription: '在手机上，表单总是以独立页面打开。',
        sidebar: '侧边栏', details: '详情面板',
    },
};

const sessionGitPullRequestTranslations = { zhHans };

return { sessionGitPullRequestTranslations };
})();

const Domain_sessionHomeFreshnessTranslations = (() => {
const en = Shared_sessionHomeFreshnessTranslations.en;

const translated = Shared_sessionHomeFreshnessTranslations.translated;

const sessionHomeFreshnessTranslations = { 'zh-Hans': translated({
        offline: '离线',
        stale: '无法刷新',
        lastUpdated: ({ ago }) => `${ago}前更新`,
    }) };

return { sessionHomeFreshnessTranslations };
})();

const Domain_sessionListFilterTranslations = (() => {
const en = Shared_sessionListFilterTranslations.en;

const translated = Shared_sessionListFilterTranslations.translated;

const sessionListFilterTranslations = { zhHans: translated({
        filtersTitle: '会话筛选', filtersSearch: '搜索筛选条件…', filtersShow: '显示',
        filtersScope: '范围', filtersShowSessions: '会话', filtersShowRuns: '运行', filtersShowBoth: '两者',
        filtersShowBothSummary: '会话和运行', filtersStartedByNone: '未选择发起者',
        filtersStartedBy: '发起者', filtersStartedByYou: '你', filtersStartedByTriggers: '触发器', filtersStartedByAgents: '代理',
        filtersRunsNeedingYouAlwaysShow: '需要你处理的运行始终显示',
        filtersMyWork: '我的工作', filtersLegacyOwnerDirect: '我拥有和直接共享的', filtersAssignedToMe: '分配给我', filtersFollowing: '正在关注',
        filtersInvolvingMe: '与我有关', filtersAllAccessible: '所有可访问', filtersAttention: '待处理',
        filtersAttentionAny: '不限', filtersAttentionNeedsMe: '仅显示需要我处理的会话', filtersScopeNeedsMe: '需要我处理',
        filtersInactive: '非活跃会话', filtersInactiveShow: '显示', filtersInactiveHide: '隐藏',
        filtersHomes: 'Home', filtersSharedWith: '共享对象', filtersOutsideTeams: '个人和直接共享',
        filtersTags: '标签', filtersSource: '来源', filtersSourceAll: '全部',
        filtersSourceDirect: '外部',
        filtersNoOptions: '没有可用的筛选条件', filtersClear: '清除筛选条件', filtersDone: '完成', filtersArchived: '已归档',
        filtersNeedsMeOnly: '仅需要我处理的', filtersNeedsMeOnlyDescription: '等待你处理的会话', filtersSourceHappier: 'Happier',
        filtersMoreTags: ({ count }: { count: number }) => `+ ${count} 更多`,
        filtersResultCount: ({ count }: { count: number }) => `${count} 项`,
        queryInitialLoadingTitle: '正在加载会话…', queryUpdatingTitle: '正在更新会话…',
        querySomeHomesUnavailableTitle: '部分 Home 不可用', querySomeHomesUnavailableDescription: 'Happier 正在显示可访问的内容。请在这些 Home 恢复在线后重试。',
        queryRefreshFailedTitle: '无法刷新', queryRefreshFailedRetainedDescription: '已加载的会话仍会保留。请重试以检查更新。', queryRefreshFailedEmptyDescription: 'Happier 无法从所选 Home 加载会话。请在它们恢复可访问后重试。',
        queryNoMatchesLoadedTitle: '已加载的会话中没有匹配项', queryNoMatchesLoadedDescription: '较早的页面中可能还有匹配的会话。', querySearchOlder: '搜索更早的会话',
        queryMoreAvailableTitle: '可能还有更多会话', queryMoreAvailableDescription: '此视图包含已加载的会话。搜索更早的会话以继续。',
        queryNoMatchesTitle: '没有匹配的会话', queryNoMatchesDescription: '请尝试更改当前筛选条件。',
        queryTeamEmptyTitle: '此团队还没有会话', queryTeamEmptyDescription: '与此团队共享的会话将显示在这里。',
        queryMyWorkEmptyTitle: '“我的工作”中没有内容', queryScopeEmptyDescription: '请尝试扩大范围或稍后再来查看。', queryBrowseAllAccessible: '显示所有会话',
        queryAssignedEmptyTitle: '没有分配给你的会话', queryFollowingEmptyTitle: '没有关注的会话', queryInvolvingEmptyTitle: '没有与你相关的会话',
        queryAttentionEmptyTitle: '没有会话需要你处理', queryReachableEmptyTitle: '没有可用会话', queryReachableEmptyDescription: '可访问的 Home 中没有会话与此视图匹配。',
        queryHistoricalSharesWithheldTitle: '部分共享会话已隐藏', queryHistoricalSharesWithheldDescription: '通过早期版本 Happier 与你共享的会话会保持隐藏，直到其所有者在 Happier 中更新它们。',
        partialHomeNotMountedTitle: ({ home }) => `${home} 不在此会话视图中`,
        partialHomeNotMountedDescription: '将此 Home 添加到可见的 Home 组，以在不更改焦点的情况下显示团队会话。',
        partialShowFromHome: ({ home }) => `显示 ${home} 中的会话`,
        teamListingUnavailableTitle: '此 Home 无法使用团队会话列表',
        teamListingUnavailableDescription: '此 Home 尚无法列出团队会话。请更新或重新配置该 Home，然后重试。',
        teamListingLoadingTitle: ({ team }) => `正在加载 ${team} 的会话…`,
        teamListingLoadingDescription: 'Happier 正在检查此 Home 可以列出的内容。',
        teamListingProbeFailedTitle: '无法连接此 Home',
        teamListingProbeFailedDescription: 'Happier 无法向此 Home 查询团队会话。请在其可访问时重试。',
    }) };

return { sessionListFilterTranslations };
})();

const Domain_sessionMessageAccountActorTranslations = (() => {
type AccountActorTranslations = Shared_sessionMessageAccountActorTranslations.AccountActorTranslations;

const sessionMessageAccountActorTranslations: Pick<Record<SupportedLanguage, AccountActorTranslations>, "zh-Hans"> = { 'zh-Hans': { accountActorYou: '你', accountActorFormerMember: '前成员', accountActorUnnamedMember: 'Happier 成员', accountActorSentBy: ({ name }) => `发送者：${name}` } };

return { sessionMessageAccountActorTranslations };
})();

const Domain_sessionPageTranslations = (() => {
const english = Shared_sessionPageTranslations.english;

const translated = Shared_sessionPageTranslations.translated;

const sessionPageTranslations = { 'zh-Hans': translated({
        sessionPages: {
            info: {
                continueTitle: '继续',
                continueDescription: '从此会话的当前进度开始新的工作。',
                organizeTitle: '整理',
                organizeDescription: '此会话在你的列表中出现的位置。',
                activityDescription: '代理正在做什么，以及你是否会收到通知。',
                detailsTitle: '详情',
                detailsDescription: '用于支持和脚本的标识符与历史。',
                environmentTitle: '环境',
                environmentDescription: '此会话运行所用的机器、文件夹和代理。',
                agentStateDescription: '谁在操控代理，以及它在等待什么。',
                relatedTitle: '相关',
                relatedDescription: '此会话的其他页面。',
                developerTitle: '开发者',
                developerDescription: '用于调试的原始数据，在开发者模式下显示。',
                leaveLabel: '停止、归档或删除',
                leaveFootnote: '停止会结束正在运行的进程。归档的会话可以恢复。删除会永久移除会话及其消息。',
            },
            follow: {
                description: '选择此会话是否通知你以及是否通过语音播报。',
            },
            permissions: {
                description: '你从其他设备为此会话允许的工具。撤销不再需要的授权。',
            },
            automations: {
                description: '按计划、事件或在回合结束时在此会话中运行的工作。',
            },
            newRun: {
                description: '从此会话启动一个子代理运行。',
                transcriptReadOnly: '这是已保存的历史记录。重新连接到此 Home 以继续对话。',
                daemonReadOnly: '此历史记录来自 Agent 进程。重新连接到此 Home 以继续对话。',
            },
        },
    }) };

return { sessionPageTranslations };
})();

const Domain_sessionReminderTranslations = (() => {
type SessionReminderTranslations = Shared_sessionReminderTranslations.SessionReminderTranslations;

const en = Shared_sessionReminderTranslations.en;

const sessionReminderTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionReminderTranslations
>, "zh-Hans"> = { 'zh-Hans': {
        due: '提醒时间已到',
        title: '提醒我', inOneHour: '1 小时后', inThreeHours: '3 小时后',
        tomorrowMorning: '明天早上', nextWeek: '下周', custom: '选择日期和时间…',
        customTitle: '选择日期和时间',
        customPlaceholder: '2026-09-08 09:00', futureTimeRequired: '请选择未来的时间。',
        setReminder: '设置提醒',
        reminderSaved: '提醒已保存',
        presetSaveFailedAfterReminder: '提醒已保存，但预设保存结果未能确认。请重试或关闭。',
        presetsSaveFailed: '未能确认预设保存结果。更改仍保留在此处，请重试。',
        presetsChanged: '已保存的预设与打开时的列表不同。请关闭并重新打开以查看最新列表。',
        remove: '移除提醒',
        dateLabel: '日期', timeLabel: '时间', addToPresets: '添加到预设', presetPreviewUnavailable: '请选择有效的未来时间以预览预设。', managePresets: '管理预设', managePresetsMessage: '重命名、排序或移除已保存的提醒选项。', presetName: '预设名称', movePresetUp: '上移预设', movePresetDown: '下移预设', renamePresetLabel: ({ preset }) => `重命名“${preset}”`, movePresetUpLabel: ({ preset }) => `将“${preset}”上移`, movePresetDownLabel: ({ preset }) => `将“${preset}”下移`, deletePresetLabel: ({ preset }) => `删除“${preset}”`, noPresets: '没有已保存的预设', noPresetsMessage: '下次选择自定义提醒时即可保存。',
    } };

return { sessionReminderTranslations };
})();

const Domain_sessionRemotePermissionGrantTranslations = (() => {
type SessionRemotePermissionGrantTranslations = Shared_sessionRemotePermissionGrantTranslations.SessionRemotePermissionGrantTranslations;

const sessionRemotePermissionGrantTranslations = { 'zh-Hans': {
        title: '远程权限授予',
        entryTitle: '远程权限授予',
        entrySubtitle: '查看和撤销会话范围的远程授予',
        loadingTitle: '正在加载远程权限授予',
        loadingReason: '正在检查当前会话所有者的授予。',
        emptyTitle: '没有远程权限授予',
        emptyReason: '此会话没有可查看的远程授予。',
        unavailableTitle: '远程权限授予不可用',
        unavailableReason: '请确认这是当前会话所有者且其设备可用，然后重试。',
        ownerOnlyTitle: '只有会话所有者可以管理远程授予',
        ownerOnlyReason: '共享参与者可以响应符合条件的提示，但不能查看或撤销会话所有者的授予。',
        retry: '重试',
        listTitle: '会话授予',
        grantActive: ({ actor }) => `来自 ${actor} 的有效授予`,
        grantRevoked: ({ actor }) => `来自 ${actor} 的已撤销授予`,
        grantDetail: ({ grantId, sourceRef, sourceRevisionOrEpoch }) => `授予 ${grantId} · 来源 ${sourceRef} （${sourceRevisionOrEpoch}）`,
        revoke: '撤销授予',
        revoking: '正在撤销…',
        revokeConfirmTitle: '要撤销远程权限授予吗？',
        revokeConfirmBody: ({ identifier }) => `这会立即撤销 ${identifier} 的远程授予。`,
        revokeFailedTitle: '无法更新远程权限授予',
        revokeFailedReason: '授予可能已更改，或所有者设备不可用。请重试。',
        loadMore: '加载更多授予',
        loadingMore: '正在加载更多授予…',
        loadMoreFailedReason: '无法加载更多授予。请重试。',
    } } as const satisfies Pick<Readonly<Record<string, SessionRemotePermissionGrantTranslations>>, "zh-Hans">;

return { sessionRemotePermissionGrantTranslations };
})();

const Domain_sessionResponsibilityTranslations = (() => {
type SessionResponsibilityTranslations = Shared_sessionResponsibilityTranslations.SessionResponsibilityTranslations;

const en = Shared_sessionResponsibilityTranslations.en;

const sessionResponsibilityTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionResponsibilityTranslations
>, "zh-Hans"> = { 'zh-Hans': {
        responsibilitySectionTitle: '负责人',
        responsibilityRowTitle: '负责人',
        responsibilityNoOne: '无人',
        responsibilityUnnamedPerson: '未命名用户',
        responsibilityPickerTitle: '选择负责人',
        responsibilitySearchPlaceholder: '搜索有访问权限的人',
        responsibilityAssignToMe: '指派给我',
        responsibilityPeopleWithAccess: '有访问权限的人',
        responsibilityAccessHintOwner: '所有者',
        responsibilityNoCandidates: '目前还没有其他人可以访问此会话。',
        responsibilityAccessChanged: '访问权限已更改。此人不能再被设为负责人。',
        responsibilityUpdateFailed: 'Happier 无法更新负责人。请重试。',
        responsibilityApprovalPending: '正在等待批准。目前尚未更改，批准后将更新负责人。',
        responsibilityA11yEditable: ({ name }: { name: string }) =>
            `负责人：${name}。更改负责人。`,
        responsibilityA11yReadOnly: ({ name }: { name: string }) => `负责人：${name}。`,
        responsibilityA11yEmpty: '负责人：无人。更改负责人。',
        responsibilityAssignedToYou: '已指派给你',
        responsibilitySharedWithYou: '已与你共享',
    } };

return { sessionResponsibilityTranslations };
})();

const Domain_sessionWorkTranslations = (() => {
const en = Shared_sessionWorkTranslations.en;

const zhHans: typeof en = {
    workerUpdate: {
        settled: "已完成",
        stalled: "已停滞",
        published: "已发布",
        truncated: "结果已缩短。",
        wokenBy: ({ count }) => (count === 1 ? '由一条更新唤醒' : `由 ${count} 条更新唤醒`),
        notFromYou: '不是你发送的消息',
    },
    title: '工作',
    subtitle: {
        sessions: ({ count }) => `${count} 个会话`,
        runs: ({ count }) => `${count} 次运行`,
        nothingStarted: '尚未开始任何工作',
    },
    states: {
        recent: '最近',
    },
    view: {
        a11y: '工作视图',
        list: '列表',
        map: '地图',
        expandMap: '在会话旁打开地图',
    },
    map: {
        positionUnder: ({ position, total, parent }) => `${parent} 下的第 ${position}/${total} 项`,
    },
    actions: {
        makeOrchestrator: '设为编排者',
        makeOrchestratorSubtitle: '此会话负责规划、委派并汇报',
        makeOrchestratorFailed: "无法将此会话设为编排者",
    },
    putUnder: {
        title: "置于…之下",
        subtitle: "向另一个会话汇报",
        search: "查找会话",
        topLevel: "顶层 — 不向任何会话汇报",
        errors: {
            cycle: "该会话已向此会话汇报",
            changed: "该会话刚被移动，请重试",
            forbidden: "不能将其置于该会话之下",
            failed: "无法移动此会话",
        },
    },
    kinds: {
        session: '会话',
        workflowRun: '工作流运行',
        backgroundRun: '后台运行',
    },
    showMore: ({ count }) => `再显示 ${count} 项`,
    role: {
        none: '无',
        handsOff: '只委派',
        a11y: ({ role }) => `角色：${role}。更改角色`,
    },
    empty: {
        title: '尚未开始工作',
        reason: '此会话启动的会话、工作流和后台运行会显示在这里，需要你处理的事项也会一并显示。',
    },
    row: {
        a11y: ({ title, status }) => `${title}，${status}`,
    },
    progress: ({ completed, total }) => `${completed} / ${total}`,
    strip: {
        openInSidebar: '在侧边栏中打开',
        stillWorking: ({ count }) => `${count} 项仍在进行`,
        needsYou: ({ count }) => `${count} 项需要你`,
        a11y: ({ summary }) => `工作：${summary}`,
    },
    leadArchived: ({ count }) => `此会话已归档 · ${count} 项仍在进行`,
    runsStale: '工作流运行可能不是最新的',
    list: {
        level: ({ level }) => `第 ${level} 级`,
        subSessions: ({ count }) => `${count} 个子会话`,
        reportsWorking: ({ count }) => `${count} 个进行中`,
        reportsNeedYou: ({ count }) => `${count} 个子会话需要你`,
    },
    archive: {
        alsoArchiveReports: ({ count }) => `同时归档 ${count} 个子会话`,
        someNotArchivedTitle: ({ count }) => `有 ${count} 个子会话未归档`,
    },
    peek: {
        reportsTo: ({ lead }) => `向 ${lead} 汇报`,
        repliesGoHere: '回复会发送到此会话',
    },
};

const notify = { zhHans: { turn: '此轮结束时通知我', attention: '需要我处理时通知我', armed: '届时会通知你', cancel: '取消通知', failed: '无法更新通知，请重试。', turnFinished: '此会话的本轮已结束。', needsYou: '此会话需要你处理。', settings: '通知设置' } };

const runNotify = { zhHans: { run: '结束时通知我', runFinished: '此运行已结束。', runNeedsYou: '此运行需要你处理。', setup: '设置通知' } };

const sessionWorkTranslations = { zhHans: { ...zhHans, notify: { ...notify.zhHans, ...runNotify.zhHans } } };

return { notify, runNotify, sessionWorkTranslations };
})();

const Domain_settingsConnectionsTranslations = (() => {
type MachineParams = Shared_settingsConnectionsTranslations.MachineParams;

const en = Shared_settingsConnectionsTranslations.en;

const zhHans = {
    sectionTitle: '连接',
    sectionDescription: '你的设备如何连接到你的机器。',
    directTitle: '尽可能直接连接',
    directOnDescription: '当设备之间可以互相访问时，预览、实时画面和文件传输会直接在设备之间传输，否则通过 Happier。',
    directOffDescription: '所有内容都通过 Happier。不会直接连接到你的机器；在同一网络中会稍慢一些。',
    serverDenied: '你的 Home 服务器让所有内容都通过 Happier，因此这里无需选择。',
    machineSectionTitle: '连接',
    machineTitle: ({ machine }: MachineParams) => `连接到 ${machine}`,
    machineOptionDefault: '默认',
    machineOptionDirect: '直接',
    machineOptionRelay: '通过 Happier',
    machineDefaultDescription: ({ machine }: MachineParams) => `跟随你的账户：可以访问 ${machine} 时直接连接，否则通过 Happier。`,
    machineDefaultOffDescription: '跟随你的账户：始终通过 Happier。',
    machineDirectDescription: ({ machine }: MachineParams) => `可以访问 ${machine} 时直接连接，即使你的账户设置不同。`,
    machineRelayDescription: '始终通过 Happier，即使在同一网络中。',
};

const settingsConnectionsTranslations = { zhHans };

return { settingsConnectionsTranslations };
})();

const Domain_settingsMachinesTranslations = (() => {
const en = Shared_settingsMachinesTranslations.en;

const zhHans: typeof en = {
    pageDescription: '运行会话的计算机，以及在它们之间进行选择的机器池。',
    thisComputerTitle: '这台计算机',
    thisComputerRowSubtitle: '后台服务和命令行',
    thisComputerPageDescription: '此设备上的 Happier 后台服务和命令行。',
    setupSectionTitle: '设置',
    setupRowSubtitle: '在此安装 Happier 并将其连接到你的 Home。',
    addPageDescription: '连接一台计算机，让智能体在其上运行你的会话。',
    addFromComputerTitle: '从计算机添加机器',
    addFromComputerDescription: '在要添加的计算机上打开 Happier，或在桌面版或浏览器中的 Happier 通过 SSH 连接一台。',
    searchPlaceholder: '搜索机器',
    count: ({ count }: { count: number }) => `${count} 台机器`,
    daemonTitle: '后台服务',
    daemonDescription: '在这台计算机上运行你的会话，并保持它与 Home 的连接。',
    unreadableTitle: ({ home }: { home: string }) => `无法读取 ${home} 上的机器`,
};

const settingsMachinesTranslations = { zhHans };

return { settingsMachinesTranslations };
})();

const Domain_settingsOverviewTranslations = (() => {
type SettingsOverviewTranslation = Shared_settingsOverviewTranslations.SettingsOverviewTranslation;

const slavicPlural = Shared_settingsOverviewTranslations.slavicPlural;

const settingsOverviewTranslations = { 'zh-Hans': {
        attentionTitle: '需要你处理',
        agentNeedsSignIn: ({ agent, machine }) => `${agent} 需要在 ${machine} 上登录`,
        agentNeedsSignInNoMachine: ({ agent }) => `${agent} 需要登录`,
        serviceSignInExpired: ({ service }) => `${service} 登录已过期`,
        signIn: '登录',
        signInAgain: '重新登录',
        setupTitle: '开始设置',
        setupProgress: ({ done, total }) => `${done}/${total}`,
        setupActionSaveKey: '保存密钥',
        setupActionAddMachine: '添加机器',
        setupActionShowQr: '显示二维码',
        setupActionScan: '扫描',
        setupActionPasteLink: '粘贴链接',
        setupActionBrowse: '浏览',
        machineUpdateVersions: ({ current, latest }) => `此机器上为 Happier ${current} · 可更新至 ${latest}`,
        connectTerminalTitle: '连接终端',
        connectTerminalSubtitle: '扫描终端显示的代码，或粘贴它的链接。',
        quickSettingsTitle: '快捷设置',
        notificationsPushOn: '推送已开启',
        notificationsPushOff: '推送已关闭',
        notificationsQuietHours: '勿扰时段已开启',
        pluginChangesAwaitingReview: ({ count }) => `${count} 个插件变更等待你审核`,
        review: '审核',
        browsePluginsTitle: '浏览插件',
        browsePluginsSubtitle: '为 Happier 添加工具、面板和集成。',
        accountServiceSignedIn: ({ service }) => `已登录 ${service}`,
        aboutDescription: '版本、源代码和法律条款（Happier 与 Anthropic 无关联）。',
        machinesTitle: '设备',
        machineOnline: '在线',
        machineOffline: ({ lastSeen }) => `离线 · 最后在线 ${lastSeen}`,
        machineUpdateAvailable: '有可用更新',
        machinesOnlineCount: ({ count }) => `${count} 在线`,
        machinesOfflineCount: ({ count }) => `${count} 离线`,
        machineLastSeen: ({ lastSeen }) => `上次在线 ${lastSeen}`,
        update: '更新',
        asOf: ({ time }) => `截至 ${time}`,
        usageTitle: '用量',
        usageLeft: ({ percent }) => `剩余 ${percent}%`,
        usageResets: ({ time }) => `${time} 重置`,
        securityTitle: '安全',
        startSessionLabel: '开始会话',
        saveRecoveryKeyTitle: '保存恢复密钥',
        saveRecoveryKeySubtitle: '丢失所有设备时找回加密数据的唯一方式。',
        addMachineTitle: '添加设备',
        addMachineSubtitle: '连接一台运行你的代理的电脑。',
        homeGreetingNamed: ({ name }) => `欢迎回来，${name}。`,
        homeStartSection: '开始会话',
        homeCustomize: '自定义主页',
        homeCustomizeDescription: '选择主页显示哪些分区以及它们的顺序。',
        homeAlwaysShown: '始终显示',
        homeShowSection: '显示',
        homeHideSection: '隐藏分区',
        homeSectionOptions: '分区选项',
        homeResetLayout: '恢复默认',
        homeLayoutSectionTitle: '主页',
        homeAddWidgetsTitle: '添加小组件',
        homeAddWidgetsDescription: '插件提供的小组件。添加后会显示在主页上。',
        homeWidgetFromPlugin: ({ plugin }) => `来自 ${plugin}`,
        homeRemoveWidget: '从主页移除',
    } } satisfies Pick<Readonly<Record<string, SettingsOverviewTranslation>>, "zh-Hans">;

return { settingsOverviewTranslations };
})();

const Domain_settingsProfilesRemoteHostsPageTranslations = (() => {
const english = Shared_settingsProfilesRemoteHostsPageTranslations.english;

const translated = Shared_settingsProfilesRemoteHostsPageTranslations.translated;

const settingsProfilesRemoteHostsPageTranslations = { 'zh-Hans': translated({
        settingsProfilesPage: {
            pageDescription: '新会话可以使用的启动设置：智能体、模型、环境变量以及运行位置。',
            useProfilesSection: '配置文件选择',
            useProfilesSectionDescription: '开始会话时选择一个配置文件，或让每个会话都使用机器的环境。',
            useProfiles: '使用配置文件',
            useProfilesOffDescription: '已关闭。新会话使用机器的环境。',
            favoritesDescription: '选择配置文件时最先显示。',
            customDescription: '你创建的配置文件。编辑内置配置文件时，会在这里保存你自己的副本。',
            builtInDescription: '为每个智能体准备的现成配置文件。',
        },
        settingsRemoteHostsPage: {
            pageDescription: '这台电脑可以设置为机器、连接或在其上运行中继的 SSH 主机。',
            savedHostsSection: '已保存的主机',
            savedHostsDescription: "最近使用的排在前面。打开主机即可使用或修改。",
            hostPageDescription: "这台计算机可以设置为机器、连接或在其上运行中继的 SSH 主机。",
            newHostTitle: "新的远程主机",
            newHostDescription: "为主机命名，并说明如何通过 SSH 访问它。",
            useSection: "使用此主机",
            useSectionDescription: "此设备可以用它做什么。",
            maintenanceSection: "此主机上的 Happier",
            maintenanceSectionDescription: "在那里安装、更新并运行 Happier 的命令行、后台服务和中继。",
            discard: "丢弃",
            accessTitle: "密钥与连接",
            accessRowSubtitle: "受信任的主机密钥和已打开的隧道",
            accessPageDescription: "此设备信任的主机密钥，以及通往你的主机的隧道和访问途径。",
            hostNotFound: "此主机已不再保存。",
            unavailableDescription: '已保存的 SSH 主机可以设置为机器或用作中继。',
            trustedHostKeysDescription: '此设备在连接时接受的密钥。移除某个密钥后，下次连接时会再次询问。',
            trustedHostKeysEmpty: '还没有受信任的主机密钥。连接时接受密钥后，它会显示在这里。',
            sshTunnelsDescription: '从此设备到已保存主机的已打开隧道。',
        },
    }) };

return { settingsProfilesRemoteHostsPageTranslations };
})();

const Domain_settingsProvidersTranslations = (() => {


const withProviderSharedFields = Shared_settingsProvidersTranslations.withProviderSharedFields;

const zhHans = {
    title: '提供商', entrySubtitle: '连接云端和本地模型来源', detailTitle: '提供商连接', configuredTitle: '你的提供商', configuredFooter: '已启用提供商的模型会显示在兼容智能体的模型选择器中。', availableTitle: '可用', availableFooter: '只需添加一次提供商，即可在所有兼容智能体中使用其模型。', customTitle: '自定义提供商', customFooter: '连接公司网关或其他兼容的模型端点。', addCustom: '添加自定义提供商', addCustomDescription: '使用兼容 OpenAI 或 Anthropic 的端点', emptyTitle: '尚未连接提供商', emptyDescription: '从下方选择可用提供商，或添加你自己的端点。', unavailable: '提供商不可用', unavailableDescription: '此服务器尚未启用提供商连接。', noMachine: '没有可用机器', noMachineDescription: '请连接一台机器以配置和测试提供商。', problemTitle: '提供商需要处理', searchPlaceholder: '搜索提供商',
    status: { available: '已连接', notChecked: '未检查', needsAttention: '需要处理', unreachable: '无法访问', disabled: '已关闭', sourceUnavailable: '插件不可用' }, kind: { frontier: '模型提供商', aggregator: '模型目录', cloud: '云端提供商', local: '在此机器上运行' },
    detail: { pickSecretTitle: '选择 API 密钥', notFoundTitle: '未找到提供商', notFoundDescription: '此提供商连接已不存在。', deletedDescription: '此提供商已被移除。恢复使用它的会话前，请选择其他模型。', sourceAvailable: '提供商插件可用', connectionTitle: '连接', connectionFooter: '控制可使用此提供商的位置并检查其当前状态。', accountAccess: '在所有机器上使用', accountAccessDescription: '此提供商解析到公共端点时均可使用', testConnection: '测试连接', testDescription: '检查端点并刷新模型目录', testSucceeded: '连接成功', testNotSupported: '此提供商不支持自动连接测试', machinesTitle: '机器', machinesFooter: '本地和私有端点必须在每台机器上分别启用。', currentMachine: '当前机器', selectMachineToManage: '选择此机器以查看和更改其访问权限', targetMachine: '目标机器', machineOnline: '在线', machineOffline: '离线', apiKeyTitle: 'API 密钥', apiKeyFooter: '密钥保存在“已存密钥”中，绝不会在此处显示。', accountApiKey: '默认 API 密钥', machineApiKey: '此机器上的 API 密钥', apiKeyConfigured: '已配置', apiKeyMissing: '添加密钥以连接', apiKeySelected: '已选择保存的密钥', useAccountApiKey: '未设置机器密钥时使用默认密钥', modelsTitle: '模型', manageModels: '管理模型', modelsUnknown: '连接后将显示模型', modelCount: ({ count }: { count: number }) => `${count} 个模型`, actionsTitle: '操作', duplicateTitle: '添加另一个连接', duplicateDescription: '为同一提供商创建一个单独命名的连接', deleteTitle: '移除提供商', deleteDescription: '现有会话会保留历史记录，但无法使用此提供商恢复。', advancedTitle: '高级', endpointDefault: '默认端点', endpointMachine: '此机器上的端点', endpointMachineDescription: '仅在此机器运行提供商时覆盖默认值', endpointPrompt: '输入完整的提供商基础 URL。', resetEndpoint: '重置端点', resetMachineEndpoint: '在此机器上使用默认端点', resetDefaultEndpoint: '使用提供商插件给出的端点' },
    authoring: { providerTitle: '提供商', builtInDescription: '选择一个“已存密钥”，然后连接此提供商。', compatibilityTitle: '兼容性', compatibilityFooter: '选择提供商文档中说明的 API 类型。', protocolTitle: 'API 兼容性', protocol: { 'openai-responses': { title: '兼容 OpenAI Responses', description: '适用于实现 Responses API 的网关' }, 'openai-chat': { title: '兼容 OpenAI Chat', description: '适用于实现 Chat Completions 的网关' }, anthropic: { title: '兼容 Anthropic', description: '适用于实现 Messages API 的网关' } }, detailsTitle: '提供商详情', name: '名称', namePlaceholder: '公司网关', baseUrl: '基础 URL', baseUrlPlaceholder: 'https://gateway.example.com/v1', modelsPath: '模型路径', credentialsTitle: '凭据', credentialsFooter: '请选择“已存密钥”。切勿将 API 密钥粘贴到 URL 或请求头中。', requiresApiKey: '需要 API 密钥', requiresApiKeyYes: '请求使用“已存密钥”', requiresApiKeyNo: '无需凭据即可连接', apiKey: 'API 密钥', apiKeyDescription: '选择或创建“已存密钥”', credentialStyleTitle: 'API 密钥格式', credentialHeader: '请求头名称', credentialStyle: { bearer: 'Authorization Bearer 令牌', xApiKey: 'x-api-key 请求头', apiKey: 'api-key 请求头', customHeader: '自定义请求头' }, catalogTitle: '模型目录', catalogFooter: '端点支持时自动获取模型，也可以稍后手动添加。', fetchModels: '自动获取模型', fetchModelsYes: '使用提供商的模型列表端点', fetchModelsNo: '手动添加模型 ID', verifyTitle: '连接', verifyFooter: '可以测试时请先测试，然后保存提供商。', save: '保存提供商', connect: '连接提供商' },
    errors: { secretMissingTitle: '需要 API 密钥', secretMissingDescription: '启用此提供商前，请选择一个“已存密钥”。', notEnabledOnMachineTitle: '未在此机器上启用', notEnabledOnMachineDescription: '请在将运行会话的机器上启用此提供商。', disabledTitle: '提供商已关闭', disabledDescription: '使用其模型前请先启用此提供商。', unreachableTitle: '无法访问提供商', unreachableDescription: '请检查服务是否正在运行、端点是否正确，然后重试。', notFoundTitle: '未找到提供商', notFoundDescription: '此提供商已被移除。请选择其他提供商或模型。', sourceUnavailableTitle: '提供商插件不可用', sourceUnavailableDescription: '请重新启用或安装提供此连接的插件。', featureDisabledTitle: '提供商不可用', featureDisabledDescription: '此服务器尚未启用提供商连接。', unauthorizedTitle: 'API 密钥被拒绝', unauthorizedDescription: '请用有效密钥替换“已存密钥”，然后再次测试连接。', rateLimitedTitle: '提供商限制了请求频率', rateLimitedDescription: '请稍候片刻，再次测试连接。', probeCapacityTitle: '同时进行的提供商检查过多', probeCapacityDescription: 'Happier 暂时无法在所选机器上启动此检查。请稍候片刻，然后重试。', genericTitle: '提供商需要处理', genericDescription: '请检查提供商设置，然后重试。' },
    models: { builtIn: '内置', experimental: '实验性', experimentalConfirmTitle: '使用实验性模型？', experimentalConfirmBody: ({ provider, model }: { provider: string; model: string }) => `${provider} 的 ${model} 尚未与此智能体完成全面验证。如果结果不符合预期，你可能需要重启或选择其他模型。`, experimentalConfirmAction: '使用模型', stale: '可能不可用', hidden: '已隐藏', manage: '管理模型', empty: '此提供商目前没有可用模型。', add: '添加模型', addPlaceholder: '每行输入一个模型 ID', resetVisibility: '重置可见性', showHidden: '显示隐藏模型', hideHidden: '隐藏已隐藏模型', remove: '移除模型', removeConfirmation: '要移除这个手动添加的模型吗？', enable: '显示模型', disable: '隐藏模型', load: '加载模型', retry: '重试', connectionUnavailable: '此提供商在所选机器上不可用。' },
};

const localTranslations = { zhHans: { title: '在此机器上', footer: '在此机器上发现的本地模型服务器。模型会在你的硬件上私密运行。', detected: '已检测到', possible: '可能的服务', detectedAtPort: ({ port }: { port: string }) => `已检测到 · 端口 ${port}`, possibleAtPort: ({ provider, port }: { provider: string; port: string }) => `可能是 ${provider} 服务 · 端口 ${port}`, addConnectionTitle: '添加另一个本地连接', addConnectionDescription: '请为此连接命名，以便与其他本地端点区分。', defaultConnectionName: ({ provider }: { provider: string }) => `${provider} 本地` } } as const;

const providerManagedDeploymentTranslations = { zhHans: {
        configureManaged: '使用托管本地服务运行会话',
        configureManagedDescription: '为未来会话选择已连接的账户或群组。需要时，Happier 会启动此服务。',
        subscriptionPolicyTitle: '订阅路由仍处于实验阶段',
        subscriptionPolicyDescription: '上游政策或执行方式可能会变化，并导致订阅路由停止工作。Happier 会如实显示拒绝，不会静默改用其他凭据。',
        accountScopeMismatchTitle: '已连接账户属于当前服务器',
        accountScopeMismatchDescription: '该提供方由另一台服务器上的机器管理。请切换到该服务器以选择其已连接账户或群组。',
        editManagedDefaults: '编辑托管会话默认值',
        editManagedDefaultsDescription: '更改未来会话使用的已连接账户或群组。现有会话保留已保存的选择。',
        purposeTargetTitle: '已连接账户目标',
        purposeTargetDescription: '请选择此用途可用的已连接账户或群组。',
        invalidPurposeTargetTitle: '已连接账户目标无效',
        invalidPurposeTargetDescription: '请在保存前选择可用的已连接账户或群组。',
        useExternal: '使用外部服务',
        useExternalDescription: '停止为未来会话托管此供应商，并使用其外部端点配置。',
        useExternalConfirmTitle: '使用外部服务？',
        useExternalConfirmDescription: '托管的账户默认值将被移除。现有会话保留已保存的选择。',
    } } as const;

const copyNameTranslations = { zhHans: ({ name }: { name: string }) => `${name} 副本` } as const;

const providerSharedFieldTranslations = { zhHans: {
        local: { installedNotRunning: '已安装，但未运行', appRunningServerOff: '应用已打开，但本地服务器已关闭', startManaged: ({ provider }: { provider: string }) => `启动 ${provider}`, startedByHappier: '由 Happier 启动', runningOutsideHappier: '在 Happier 外部运行' },
        apiKeyOptionalDescription: '可选 — 如果此供应商需要密钥，请选择一个已保存的密钥',
        models: { addDescription: '添加此供应商不会自动列出的模型 ID', addHelp: '每行输入一个准确的模型 ID。已有模型会被跳过。', addFieldLabel: '模型 ID', invalidModelIds: ({ ids }: { ids: string }) => `这些模型 ID 无效：${ids}`, noNewModels: '没有可添加的新模型 ID。', providerManagedTitle: '模型由此供应商管理', providerManagedDescription: '刷新供应商目录以更新此列表。不支持手动模型 ID。', showAll: '显示所有模型', hideAll: '隐藏所有模型', hideAllConfirmation: '隐藏此列表中的所有模型？你可以随时重新显示它们。', showOnly: '仅显示此模型', showOnlyConfirmation: '隐藏此列表中的其他所有模型？你可以随时恢复它们。' },
    } } as const;

const providerFirstSessionValidationTranslations = { zhHans: 'Happier 会在首次启动使用此提供商的会话时安全地验证连接。' } as const;

const providerMigrationTranslations = { zhHans: { reviewTitle: '检查供应商迁移', reviewFooter: '应用更改前，请检查端点、API 格式、凭据和模型。', legacyProfileDescription: '确认前，此配置文件会继续使用旧路由。', credentialTitle: '凭据', credentialFooter: '仅移动已保存密钥的引用；密钥值不会显示或复制。', noCredential: '无 API 密钥', credentialMoveDescription: '将此凭据移到新连接', noCredentialDescription: '创建无凭据连接', actionsTitle: '迁移', preview: '检查更改', previewDescription: '验证配置而不更改设置', confirm: '创建供应商连接', confirmDescription: '以原子方式应用更改并保留启动偏好', reviewAction: '检查供应商迁移', reviewActionDescription: '将旧端点和模型移到供应商连接', retainedTitle: '已保留旧配置', retainedDescription: '在能够无损迁移之前，此配置会保持可用。' } } as const;

const providerMigrationPreviewTranslations = { zhHans: { willMoveTitle: '将移至供应商', willMoveFooter: '只会移动这些路由和凭据名称。密钥值绝不会显示。', willKeepTitle: '将保留在启动配置文件中', willKeepFooter: '这些仅用于启动的设置会在迁移后保留在配置文件中。', permissionDefaults: '默认权限', persistenceDefaults: '默认会话存储' } } as const;

const providerMigrationConflictTranslations = { zhHans: { conflictReviewTitle: '解决供应商迁移冲突', conflictReviewFooter: '选择保留现有连接，或将此配置文件保存为单独的连接。不会显示任何密钥值。', conflictCredential: '保存的凭据不同', conflictModels: '模型设置不同', conflictEditedConnection: '现有连接已被修改', keepExisting: '保留现有连接', keepExistingDescription: '保留其当前凭据和模型，并在不替换它们的情况下完成迁移。', modelOutcomeTitle: '选择要保留的模型', modelOutcomeFooter: '完成迁移前请确认具体模型。做出选择前不会更改任何内容。', useExistingModel: '使用连接当前的模型', useExistingModelDescription: '保留此供应商连接已选择的模型。', preserveLegacyModel: '使用配置文件的模型', preserveLegacyModelDescription: '将此配置文件的具体模型选择移到现有连接。', discardLegacyModel: '移除配置文件的模型选择', discardLegacyModelDescription: '完成迁移，但不保留此配置文件的模型选择或收藏意图。', createNamed: '创建单独连接', createNamedDescription: '在新的命名连接中保留此配置文件的供应商设置。', separateConnectionName: '连接名称', conflictReviewAction: '解决供应商冲突', conflictReviewActionDescription: '选择如何保留冲突的凭据或模型' } } as const;

const providerCredentialSelectionRequiredTranslations = { zhHans: '选择此供应商连接应使用的已保存凭据' } as const;

const providerLinkTranslations = { zhHans: { providerWebsite: '供应商网站', getApiKey: '获取 API 密钥', failedToOpen: 'Happier 无法打开此链接。' } } as const;

const providerCredentialFormatSelectionRequiredTranslations = { zhHans: '选择此凭据的发送方式' } as const;

const providerReservedEnvironmentValidationUnavailableTranslations = { zhHans: '更改环境变量前，请将此配置文件编辑器连接到可用机器。' } as const;

const providerAdvancedAuthoringTranslations = { zhHans: { advancedSetup: '高级设置', advancedSetupEnabled: '配置多种 API 样式、请求标头和安全的模型列表探测', advancedSetupDisabled: '使用一个常见的兼容端点', endpointEnabled: '使用此 API 样式', endpointEnabledDescription: '向兼容的代理提供此端点', endpointDisabledDescription: '不会使用此 API 样式', publicHeaders: '公共请求标头', publicHeadersPlaceholder: 'X-Tenant: engineering', optionalProbePath: '模型列表路径（可选）', probeParserTitle: '响应格式', probeParser: { openaiModels: 'OpenAI 兼容模型列表', ollamaTags: 'Ollama 标签', lmStudioNative: 'LM Studio 原生模型列表' } } } as const;

const providerCustomBearerHeaderTranslations = { zhHans: '自定义标头（Bearer 令牌）' } as const;

const providerNonSecretHeaderTranslations = { zhHans: '非机密请求标头' } as const;

const providerProbePathsTranslations = { zhHans: '模型列表路径（可选，每行一个）' } as const;

const providerLocalAuthoringTranslations = { zhHans: { enableAfterSaving: '启用此提供商', enableOnCurrentMachine: '保存后仅在此机器上启用', enableAccountWide: '保存后启用', localAddressTitle: '本地地址', localAddressDescription: ({ machine, endpoint }: { machine: string; endpoint: string }) => `请在每台机器上分别启用。${machine} 将使用 ${endpoint}。` } } as const;

const providerAuthoringReviewTranslations = { zhHans: { destinationReview: '连接目标', destinationLoading: '守护进程正在解析确切目标…', destinationSelection: '选择目标', destinationSelectionDescription: '连接前请核对确切地址。', destinationScope: '目标范围', destinationMachine: '此机器', destinationAccount: '账户' } } as const;

const providerCompatibilityTranslations = { zhHans: { title: '适用于', footer: '兼容性由各代理集成验证，并可能因模型而异。', verified: '已验证', experimental: '实验性', incompatible: '不兼容', verifiedDescription: '已通过此代理集成测试', experimentalDescription: '可能可用，但首次使用前需要确认', incompatibleDescription: '此代理无法安全使用该连接' } } as const;

const providerModelNotLoadedTranslations = { zhHans: '未加载 · 首次使用时可能会加载' } as const;

const providerModelLoadCancellationTranslations = { zhHans: { cancelLoad: '取消加载', loadCancelled: '已停止等待模型', loadCancelledProviderMayContinue: '供应商可能仍会继续加载。请稍后刷新目录以核对延迟完成的结果；Happier 不会重放加载请求。' } } as const;

const providerPartialStatusTranslations = { zhHans: '部分可用' } as const;

const providerConnectedServiceSuppressedTranslations = { zhHans: '此供应商不会使用代理的原生登录。你保存的选择不会更改。' } as const;

const providerMachineCleanupPendingTranslations = { zhHans: '设备已移除，但无法保存供应商访问清理。请检查连接，然后再次移除该设备以重试清理。' } as const;

const providerConnectionChangedTranslations = { zhHans: { title: '供应商连接已更改', description: '请重新加载当前供应商设置，然后重试。' } } as const;

const providerModelSectionTranslations = { zhHans: { available: '可用', manual: '手动' } } as const;

const providerCompletenessTranslations = { zhHans: {
        searchEmptyTitle: '没有与此搜索匹配的提供商',
        searchEmptyDescription: '请尝试其他提供商或连接名称。',
        compatibilityReasons: {
            noCompatibleProtocol: '此智能体与提供商没有共同支持的 API 协议。',
            noAuthUnsupported: '此智能体需要通过 API 密钥访问此提供商。',
            credentialTransportUnavailable: '此智能体不支持当前配置的 API 密钥传递方式。',
            optionalCredentialNoAuthUnsupported: '即使 API 密钥为可选，此智能体也无法在未提供密钥时使用该提供商。',
            capabilityUnsupported: '不支持所需的提供商能力。',
            capabilityUnknown: '所需的提供商能力尚未验证。',
            modelEvidenceRequired: '请选择一个模型以验证其所需能力。',
            modelCapabilityUnsupported: '该模型不支持某项所需能力。',
            modelCapabilityUnknown: '所需的模型能力尚未验证。',
            overrideIncompatible: '提供商验证将此集成标记为不兼容。',
            overrideExperimental: '提供商验证将此集成标记为实验性。',
            evidenceMissing: '尚未记录兼容性证据。',
            agentUnsupported: '此智能体不支持外部模型提供商。',
            adapterInvalid: '无法验证此智能体的提供商适配器。',
            unknown: '有一项较新的兼容性条件需要检查。',
        },
        unsavedDescription: '要丢弃此提供商草稿吗？“已存密钥”是账户共享对象，仍会保留。',
        recoveryActions: {
            reviewFeatures: '查看提供商可用性',
            chooseConnection: '选择提供商',
            restorePlugin: '查看插件',
            enableConnection: '启用提供商',
            reviewAccountGrant: '查看账户访问权限',
            enableOnMachine: '在机器上启用',
            reviewMachineGrant: '查看机器访问权限',
            reviewCompatibility: '查看兼容性',
            addSecret: '添加 API 密钥',
            reviewCredentialTransport: '查看凭据支持',
            reviewConnection: '查看连接',
            retry: '重试',
            replaceSecret: '替换 API 密钥',
            chooseModel: '选择模型',
            loadModel: '加载模型',
            reviewAndRestart: '查看并重启',
            restartProbe: '再次测试',
            reduceProviderSettings: '管理提供商设置',
            reviewProfileMigration: '查看配置文件迁移',
            reviewCurrentState: '查看当前设置',
        },
        hiddenForAllAgents: '对所有智能体隐藏 · 在提供商设置中管理',
    } } as const;

const providerAvailabilityTranslations = { zhHans: {
        availabilityChecking: '正在检查提供商可用性', availabilityCheckingDescription: 'Happier 正在确认此服务器是否支持提供商连接。',
        availabilityProblem: '无法检查提供商可用性', availabilityProblemDescription: 'Happier 将自动重试。如果问题持续，请检查服务器连接。',
        availabilityUnsupported: '提供商功能需要更新服务器', availabilityUnsupportedDescription: '此服务器版本不支持提供商连接。',
        availabilityContextUnsupported: '当前环境不支持提供商', availabilityContextUnsupportedDescription: '当前服务器配置或选择无法支持提供商连接。',
        availabilityPolicyDisabled: '提供商已被策略停用', availabilityPolicyDisabledDescription: '本地策略或构建策略已停用提供商连接。',
    } } as const;

const settingsProvidersTranslations = { zhHans: withProviderSharedFields(zhHans, {
        providerAvailabilityTranslations: providerAvailabilityTranslations.zhHans,
        providerLinkTranslations: providerLinkTranslations.zhHans,
        providerCompletenessTranslations: providerCompletenessTranslations.zhHans,
        providerPartialStatusTranslations: providerPartialStatusTranslations.zhHans,
        providerMachineCleanupPendingTranslations: providerMachineCleanupPendingTranslations.zhHans,
        providerConnectionChangedTranslations: providerConnectionChangedTranslations.zhHans,
        providerCompatibilityTranslations: providerCompatibilityTranslations.zhHans,
        providerMigrationTranslations: providerMigrationTranslations.zhHans,
        providerMigrationPreviewTranslations: providerMigrationPreviewTranslations.zhHans,
        providerMigrationConflictTranslations: providerMigrationConflictTranslations.zhHans,
        providerCredentialSelectionRequiredTranslations: providerCredentialSelectionRequiredTranslations.zhHans,
        providerCredentialFormatSelectionRequiredTranslations: providerCredentialFormatSelectionRequiredTranslations.zhHans,
        providerReservedEnvironmentValidationUnavailableTranslations: providerReservedEnvironmentValidationUnavailableTranslations.zhHans,
        localTranslations: localTranslations.zhHans,
        providerSharedFieldTranslations: providerSharedFieldTranslations.zhHans,
        providerManagedDeploymentTranslations: providerManagedDeploymentTranslations.zhHans,
        copyNameTranslations: copyNameTranslations.zhHans,
        providerFirstSessionValidationTranslations: providerFirstSessionValidationTranslations.zhHans,
        providerAdvancedAuthoringTranslations: providerAdvancedAuthoringTranslations.zhHans,
        providerLocalAuthoringTranslations: providerLocalAuthoringTranslations.zhHans,
        providerAuthoringReviewTranslations: providerAuthoringReviewTranslations.zhHans,
        providerNonSecretHeaderTranslations: providerNonSecretHeaderTranslations.zhHans,
        providerProbePathsTranslations: providerProbePathsTranslations.zhHans,
        providerCustomBearerHeaderTranslations: providerCustomBearerHeaderTranslations.zhHans,
        providerModelSectionTranslations: providerModelSectionTranslations.zhHans,
        providerModelLoadCancellationTranslations: providerModelLoadCancellationTranslations.zhHans,
        providerModelNotLoadedTranslations: providerModelNotLoadedTranslations.zhHans,
        providerConnectedServiceSuppressedTranslations: providerConnectedServiceSuppressedTranslations.zhHans,
    }) } as const;

return { localTranslations, providerManagedDeploymentTranslations, copyNameTranslations, providerSharedFieldTranslations, providerFirstSessionValidationTranslations, providerMigrationTranslations, providerMigrationPreviewTranslations, providerMigrationConflictTranslations, providerCredentialSelectionRequiredTranslations, providerLinkTranslations, providerCredentialFormatSelectionRequiredTranslations, providerReservedEnvironmentValidationUnavailableTranslations, providerAdvancedAuthoringTranslations, providerCustomBearerHeaderTranslations, providerNonSecretHeaderTranslations, providerProbePathsTranslations, providerLocalAuthoringTranslations, providerAuthoringReviewTranslations, providerCompatibilityTranslations, providerModelNotLoadedTranslations, providerModelLoadCancellationTranslations, providerPartialStatusTranslations, providerConnectedServiceSuppressedTranslations, providerMachineCleanupPendingTranslations, providerConnectionChangedTranslations, providerModelSectionTranslations, providerCompletenessTranslations, providerAvailabilityTranslations, settingsProvidersTranslations };
})();

const Domain_settingsSearchKeywordsTranslations = (() => {
const english = Shared_settingsSearchKeywordsTranslations.english;

const translated = Shared_settingsSearchKeywordsTranslations.translated;

const settingsSearchKeywordsTranslations = { 'zh-Hans': translated({
        settingsSearchKeywords: {
            settings: '设置, 主页, 概览',
            groupProfileAndAccount: '账户, 个人资料, 账单, 套餐, 用量',
            account: '账户, 个人资料, 账单',
            accountSecurity: '安全, 密码, 恢复, 加密, 退出登录',
            apiTokens: 'api 令牌, 个人访问令牌, pat, 自动化, cli, sdk',
            teams: '团队, 成员, 群组, 邀请',
            homeAdministration: 'home, 管理, 治理, 人员, 策略',
            secrets: '密钥, 秘密, env, 令牌',
            usage: '用量, 账单, 限制, 配额',
            machines: '机器, 设备, 电脑',
            machinePoolsNew: '机器池, 池, 备用, 运行于',
            machinesAdd: '添加, 机器, ssh',
            machinesThisComputer: '这台电脑, 本地, 设备',
            remoteHosts: '远程, 主机, ssh, 服务器, 机器',
            groupGeneral: '通用, 外观, 语言, 实验',
            appearance: '外观, 主题, 字体, 界面, 侧边栏',
            keyboard: '键盘, 快捷键, 热键, 命令',
            pets: '宠物, blink, 伙伴, codex',
            language: '语言, 区域, 翻译',
            features: '功能, 实验, 测试版',
            groupAiAndAgents: '智能体, 提供商, mcp, 提示词, 语音',
            agents: '提供商, 智能体, 模型, llm',
            providers: '提供商, 模型, openrouter, ollama, lm studio',
            subAgent: '子智能体, 智能体, 委派, 规则',
            roles: '角色, 编排者, 构建者, 审阅者, 指令',
            delegation: '委派, 工作深度, 交接, 编排者',
            profiles: '配置文件, 角色',
            connectedServices: '已连接服务, oauth, 账户',
            mcp: 'mcp, 工具, 服务器, 插件',
            plugins: '插件, 市场, 目录, 描述符, 发现',
            prompts: '提示词, 模板, 库',
            promptsTemplates: '模板',
            promptsFolders: '文件夹',
            promptsStacks: '堆栈',
            promptsRegistries: '注册表',
            promptsLibrary: '库',
            promptsAssets: '资源, 外部',
            voice: '语音, 助手, 麦克风',
            voiceConversations: '语音, 对话, 实时, 提供商',
            voiceDictation: '语音, 听写, 说话, 转写',
            voicePrivacy: '语音, 隐私, 历史, 保留',
            voiceAdvanced: '语音, 高级, 机器, 诊断',
            memory: '记忆, 搜索, 索引',
            groupSessionsBehavior: '会话, 记录, 权限, 操作',
            session: '会话, 终端, tmux',
            externalSessions: '外部会话, 后台跟随, 钩子',
            actions: '操作, 审批, 快捷方式',
            embeds: '嵌入, iframe, 小组件, 网站, 对话',
            transcript: '记录, 聊天, 布局',
            permissions: '权限, 审批, 安全',
            toolRendering: '工具, 显示',
            handoff: '交接, 转移',
            runs: '运行, 执行',
            groupFilesAndSourceControl: '文件, 源代码管理, 附件',
            sourceControl: 'git, scm, 源代码管理',
            attachments: '附件, 上传, 文件',
            groupSystem: '系统, 服务器, 状态, 通知',
            servers: '服务器, 中继',
            systemStatus: '系统状态, 健康, 诊断',
            updates: '更新, 升级, 版本, cli, 重启',
            notifications: 'notif, 通知, 推送, push',
            notificationsPush: 'push, 推送',
            desktop: '桌面, tauri, 悬浮层, 窗口',
            diagnosis: '诊断, 调试',
            reportIssue: '报告问题, 错误, bug',
        },
    }) };

return { settingsSearchKeywordsTranslations };
})();

const Domain_settingsSessionPagesTranslations = (() => {
type SettingsSessionPagesTranslations = Shared_settingsSessionPagesTranslations.SettingsSessionPagesTranslations;

const en = Shared_settingsSessionPagesTranslations.en;

const settingsSessionPagesTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SettingsSessionPagesTranslations
>, "zh-Hans"> = { 'zh-Hans': {
        settingsSessionPages: {
            preview: {
                userMessage: '修复不稳定的重连测试',
                agentReply: '找到了：重试计时器从未被清除。已修复，测试通过。',
                thinking: '测试只在超时后失败，所以重试计时器可能还在运行。',
            },
            runtime: {
                pageDescription: '会话在你的机器上如何运行。',
                terminalSection: '终端',
                terminalHostTitle: '新会话的终端宿主',
                terminalHostNone: '无',
                tmuxTitle: '在 tmux 中启动会话',
                tmuxOn: '新会话在独立的 tmux 窗口中打开，方便你从终端连接。',
                tmuxOff: '新会话在普通 shell 中运行。',
            },
            wizard: {
                pageDescription: '新建会话向导如何排列各个步骤。',
                wideScreensSection: '宽屏',
                stepsSection: '每个步骤如何展示选项',
                steps: {
                    profiles: '配置文件',
                    backends: '代理',
                    models: '模型',
                    machines: '机器',
                    paths: '文件夹',
                    permissions: '权限',
                },
            },
            providerLimits: {
                pageDescription: '达到提供商使用上限时会发生什么，以及你还剩多少配额。',
                recoveryDescription: '代理达到提供商的使用上限时，会话可以等待重置后继续。',
                resumePromptCustom: '自定义',
                unavailableTitle: '此 Home 不可用',
                unavailableDescription: '此 Home 未启用使用上限恢复和提供商用量指示。',
            },
            resume: {
                pageDescription: '当代理无法自行恢复时，不活跃的会话如何继续。',
                strategyRecent: '最近消息',
                strategySummary: '摘要 + 最近',
                maxSeedCharsTitle: '重放大小上限',
                summaryModelSection: '摘要模型',
                summaryModelDescription: '为新会话撰写重放摘要的代理和模型。',
                handoffSection: '移动会话',
                handoffLinkDescription: '把会话交给另一台机器时，会随之移动哪些内容。',
            },
            permissions: {
                duringSessionSection: '会话进行中',
                duringSessionDescription: '审批请求显示在哪里，以及正在运行的会话更改权限后何时生效。',
                promptSurfaceComposer: '输入框附近',
                applyImmediately: '立即',
                applyNextMessage: '下一条消息',
                storageUseDefault: '默认',
            },
            handoff: {
                pageDescription: '把会话交给另一台机器时，会随之移动哪些内容。',
                workspaceSection: '工作区文件',
                workspaceDescription: '会话移到另一台机器时，项目文件夹如何处理。',
                keepUpdated: '保持更新',
                advancedModeDescription: '会替代上面的选择。请谨慎：文件可能被删除或覆盖。',
                ignoredExclude: '排除',
                ignoredIncludeSelected: '包含所选',
            },
            toolRendering: {
                pageDescription: '让个别工具显示比会话记录默认值更多或更少的细节。',
                collapsedDescription: '打开之前，每个工具在会话记录中显示多少内容。',
            },
            transcript: {
                advancedTitle: '性能与时序',
                advancedPageDescription: '流式传输、动画时序和滚动阈值。大多数人保持默认即可。',
                advancedMotionOff: '会话记录动效已关闭，因此这些设置不起作用。请在 会话记录 › 动效 中开启。',
                toolsSection: '工具',
                toolOverridesDescription: '让个别工具显示更多或更少的细节。',
                thinkingSummary: '摘要',
                thinkingFull: '完整',
                strategyConsecutive: '连续的',
                strategyWholeTurn: '整轮',
                copyMarkdown: 'Markdown',
                copyMarkdownDescription: '复制的消息保留格式，并标明作者。',
                copyPlainDescription: '复制的消息为纯文本，不带标签。',
                motionSubtle: '轻微',
                advancedLinkDescription: '流式传输、动画时序和滚动阈值。',
                pageDescription: '对话变长时如何阅读：布局、思考、工具、动效和滚动。',
            },
            composer: {
                pageDescription: '你如何编写和发送消息，以及代理忙碌时会发生什么。',
                newSessionsSection: '新会话',
                newSessionsDescription: '选择“新会话”时你会看到什么。',
                draftEntryTitle: '打开新会话时',
                draftResume: '继续草稿',
                draftFresh: '重新开始',
                typingSection: '输入',
                typingDescription: '输入框中回车键和消息历史的行为。',
                enterToSendTitle: '回车发送',
                sendModeTitle: '代理工作时',
                sendQueue: '排队',
                sendInterrupt: '打断',
                sendPending: '待处理',
                busySteerTitle: '如果代理支持引导',
                busySteerInactive: '仅在代理工作期间消息进入队列或待处理时适用。',
                nonSteerableTitle: '消息无法引导时询问',
                resumeWhenPossible: '尽快',
                resumeIfOnline: '在线时',
                resumeNever: '从不',
                pendingSection: '待处理消息',
                pendingDescription: '待处理的消息如何送达代理。',
                pendingInactive: '按当前选择，不会有消息进入待处理。一旦有消息进入，这些设置才会生效。',
                drainOne: '逐条',
                drainAll: '全部一起',
                timingAfterReply: '回复之后',
                timingWhenIdle: '全部空闲时',
                layoutSection: '输入框布局',
                actionBarTitle: '操作栏',
                actionBarAutoDescription: '宽屏上标签会换到第二行，手机上可横向滚动。',
                actionBarWrapDescription: '放不下时标签会换到第二行。',
                actionBarScrollDescription: '标签保持一行，横向滚动查看其余部分。',
                actionBarCollapsedDescription: '标签收进菜单，留出最多的输入空间。',
                chipDensityTitle: '操作标签',
                chipsAutoDescription: '需要文字的标签保留文字，一目了然的只显示图标。',
                chipsLabelsDescription: '每个标签都显示文字。',
                chipsIconsDescription: '标签只显示图标，以节省空间。',
            },
        },
    } };

return { settingsSessionPagesTranslations };
})();

const Domain_shareSheetTranslations = (() => {
type ShareSheetTranslations = Shared_shareSheetTranslations.ShareSheetTranslations;

const shareSheetTranslations = { 'zh-Hans': {
        publicLink: { description: "任何持有链接的人都可以阅读此文档，无需账户。", grants: "只读文档。", audit: "访问记录", auditEmpty: "尚无访问记录。", ownerUpdateRequired: "所有者正在更新此链接", ownerUpdateRequiredDescription: "请让所有者打开 Happier，然后重试此链接。" },
        whoHasAccess: '谁有访问权限',
        whoHasAccessStale: '谁有访问权限 · 可能不是最新',
        owner: '所有者',
        you: '你',
        addPlaceholder: '添加人员或团队',
        person: '人员',
        group: '团队群组',
        team: '团队',
        accessLevel: '访问级别',
        accessibleControl: ({ name, control, value }) => `${name}，${control}，${value}`,
        remove: '移除访问权限',
        confirmRemove: '确认移除',
        removedAnnouncement: ({ name }) => `${name} 不再有访问权限`,
        browseAll: '浏览全部',
        allLoaded: '已加载全部结果',
        copyLink: '复制链接',
        linkCopied: '链接已复制',
        copyLinkFailed: '无法复制链接。',
        sendCopy: '改为发送副本',
        secrets: {
            levels: { canUse: '可使用' },
            help: { use: '在运行中使用；其值从不显示' },
            oneLevel: '已保存的密钥只供运行使用，其值永不外泄，因此只有一个级别。',
        },
        documents: {
            title: '共享',
            shareTitle: ({ name }) => `共享 ${name}`,
            levels: { canUse: '可使用', canRead: '可查看', canEdit: '可编辑', admin: '管理' },
            help: {
                workflowUse: '查看并运行',
                roleUse: '使用；各自的更改保留在各自的设置中',
                profileUse: '用它启动会话',
                documentUse: '在其任意设备上打开和复制',
                promptUse: '在其会话中使用',
                boardUse: '查看看板；每张卡片只打开其已有权限的内容',
                editForEveryone: '为所有共享对象更改',
                adminOwnerShares: '更改并管理共享；只有所有者可以指定管理员',
            },
            notes: {
                personalRuns: '运行和触发器归启动它们的人所有。',
                teamRuns: '团队能看到每次运行。',
                roleLive: '你的更改会同步给所有共享对象。',
                profileSecrets: '机密值永不传输 · 关联已保存的机密',
            },
            errors: {
                unavailable: '此处暂不支持共享。',
                ownerOnly: '只有所有者或管理员可以更改谁有访问权限。',
                noAccess: '你已不再有访问权限。',
                notFound: '此项已不可用。',
                subjectUnavailable: '此人员、群组或团队无法获得访问权限。',
                failed: '无法更新共享，请重试。',
            },
        },
    } } satisfies Pick<Record<string, ShareSheetTranslations>, "zh-Hans">;

return { shareSheetTranslations };
})();

const Domain_sidebarFooterTranslations = (() => {
type SidebarFooterTranslation = Shared_sidebarFooterTranslations.SidebarFooterTranslation;

const sidebarFooterTranslations = { 'zh-Hans': {
        linkToService: ({ service }) => `关联到 ${service}`,
        addHomeOrSignIn: '添加 Home 或登录',
        usageNoAccounts: '连接一个账户即可查看其剩余额度。',
        usageHealthy: '所有额度都还很充裕',
        homeUnreachableTitle: ({ home }) => `无法连接 ${home}`,
        homeUnreachableBody: '它响应后，你的机器和会话会重新显示在这里。',
        homeUnreachableLine: ({ home }) => `无法连接 ${home}。`,
        availableWhenHomeAnswers: "此 Home 响应后可用。",
        usageKeysWithoutLimits: ({ count }) => `${count} 个无限额的密钥`,
        usageSignedOut: '已退出登录',
        hideAccountIdentities: '隐藏账户邮箱和 ID',
        accountIdentitiesHidden: '邮箱和 ID 已隐藏 · 适合直播和演示',
        usageThisSession: '此会话',
        usageAllAccounts: '所有账户',
        usageMoreAccounts: ({ count }) => `另外 ${count} 个`,
        usageSessionThroughPool: ({ agent, pool }) => `${agent} 通过 ${pool} 登录`,
        usageSessionWithAccount: ({ agent }) => `${agent} 使用此账户登录`,
        usageSessionOwnSignIn: ({ agent }) => `${agent} 使用自己的登录`,
        usagePoolFallback: '其账户池',
        usageNextInOrder: ({ account }) => `${account} 用完后，下一轮将按顺序切换到下一个账户`,
        usageNextMostLeft: ({ account }) => `${account} 用完后，下一轮将切换到剩余最多的账户`,
        usageNextStays: ({ pool, account }) => `在你切换之前，${pool} 会一直使用 ${account}`,
    } } as const satisfies Pick<Record<string, SidebarFooterTranslation>, "zh-Hans">;

return { sidebarFooterTranslations };
})();

const Domain_surfaceStateTranslations = (() => {
type SurfaceStateTranslations = Shared_surfaceStateTranslations.SurfaceStateTranslations;

const surfaceStateTranslations = { 'zh-Hans': {
        stillWaiting: ({ seconds }) => `仍在等待 · ${seconds} 秒`,
        asOf: ({ time }) => `截至 ${time}`,
        howItWorks: '了解原理',
        tryAgain: '重试',
        checkAgain: '再次检查',
        paneFailedTitle: '无法显示此面板',
        paneFailedReason: '绘制时出了问题。你的会话不受影响。',
        opening: ({ name }) => `正在打开 ${name}`,
        couldNotOpen: ({ name }) => `无法打开 ${name}`,
    } } as const satisfies Pick<Record<string, SurfaceStateTranslations>, "zh-Hans">;

return { surfaceStateTranslations };
})();

const Domain_teamsTranslations = (() => {
type TeamsTranslationRoot = Shared_teamsTranslations.TeamsTranslationRoot;

const english = Shared_teamsTranslations.english;

const simplifiedChinese: TeamsTranslationRoot = {
    teams: {
        overview: {
            sessionsSubtitle: '与此团队共享的会话。',
        },
        pages: {
            credentialCreate: '选择要共享的内容、可使用的人以及限额。',
            credentialDetail: '谁可以使用此凭据、如何使用以及用量。',
            credentialEdit: '更改谁可以使用此凭据、如何使用以及用量。',
            credentialActivity: '对此凭据的更改以及更改者。',
            credentialUsage: '此凭据的使用量以及使用者。',
            credentialExternalApi: '从 Happier 之外的工具使用此凭据。',
            identityProviderNew: '连接成员可用于登录的身份提供方。',
            identityProviderEdit: '更改此身份提供方的连接方式。',
            githubApp: '此团队用于访问仓库的 GitHub App。',
            githubAppEdit: '更改此 GitHub App 的注册信息。',
            authentication: '成员如何登录此团队以及它接纳哪些人。',
            credentials: '此团队与成员共享的提供方凭据。',
            directory: '在 Home 上共享会话、访问权限和凭据的一组成员。',
            members: '此团队的成员以及每个人可以做什么。',
            addMember: '添加已在此 Home 上拥有账户的人。',
            groups: '有名称的成员集合，用于共享会话和凭据。',
            newGroup: '为群组命名并选择其中的成员。',
            invitations: '可加入此团队的邀请及其对象。',
            newInvitation: '邀请他人加入此团队。',
            settings: '名称、徽标、会话默认值，以及此团队是否处于活动状态。',
        },
        loading: '正在加载团队…',
        title: '团队',
        entrySubtitle: '创建团队、管理成员和群组，并邀请他人加入。',
        entry: {
            heading: ({ team }: { team: string }) => `继续前往 ${team}`,
            onHome: ({ home }: { home: string }) => `位于 ${home}`,
            signInServiceOrigin: ({ service }: { service: string }) => `通过${service}登录`,
            signInServiceUnavailableOrigin: ({ service }: { service: string }) => `目前无法通过${service}登录`,
            signedInTo: ({ home, account }: { home: string; account: string }) => `已作为 ${account} 登录 ${home}`,
            unnamedAccount: 'Happier 账号',
            continueWith: ({ method }: { method: string }) => `使用 ${method} 继续`,
            providerUnavailableTitle: ({ method }: { method: string }) => `${method} 当前不可用`,
            providerUnavailableDisabled: '你的 Team 管理员已关闭此登录方式。请稍后再检查。',
            providerUnavailableSetupIncomplete: '你的 Team 管理员尚未完成此登录方式的设置。请稍后再检查。',
            providerUnavailableUnavailable: '此 Home 目前无法使用此登录方式。请稍后再检查。',
            unknownTargetTitle: '此链接未标明它的 Home',
            unknownTargetBody: '本设备无法判断这个 Team 登录链接属于哪个 Home，因此没有向任何 Home 发送内容。请向 Team 管理者重新索取链接。',
            ssoRequiredTitle: '此 Team 需要另一种登录方式',
            ssoRequiredBody: '你已登录此 Home，但此 Team 只接受它要求的登录方式。请使用该方式重新登录，或返回你自己的工作。',
            invitationUnavailableTitle: '此邀请无法使用',
            invitationUnavailableBody: '它可能已过期、已被撤销或已被使用。仅登录并不会让你加入 Team。',
            wrongAccountTitle: '此账户无法使用此登录',
            wrongAccountBody: '你用来登录的账户或身份不是此 Team 期望的。请使用其他账户或提供方登录，或返回你自己的工作。',
            notProvisionedTitle: '此 Team 尚未接纳你',
            notProvisionedBody: '仅登录并不会让你加入此 Team。由其管理员决定谁可以加入；请向管理员申请访问权限或邀请，然后重试。',
            directoryDelayedTitle: '你的访问权限仍在路上',
            directoryDelayedBody: '此 Team 的成员来自目录，而目录尚未交付你的访问权限。请稍后重试，或联系 Team 管理者。',
            accessRemovedTitle: '此 Team 对你不可用',
            accessRemovedBody: '你的访问权限可能已被移除，或此 Team 目前在此 Home 上不可用。你已登录的其他内容不受影响。',
            providerChangedTitle: '此登录方式在使用过程中已更改',
            providerChangedBody: '管理员在你登录期间更新了此登录方式。你的账户未做任何更改。请从 Team 页面重新开始，以查看当前的登录方式。',
            returnToTeamSignIn: '返回 Team 登录',
            returnToHappier: '返回 Happier',
            signInToTeam: '登录此团队',
            readyStatus: '选择登录方式以继续。',
        },
        homeLabel: 'Home',
        role: {
            owner: '所有者',
            admin: '管理员',
            member: '成员',
            guest: '访客',
        },
        roleHelp: {
            owner: '拥有该团队，可以管理团队并更改所有者。',
            admin: '拥有成员权限，并可以管理该团队。',
            member: '默认获得授予该团队的访问权限。',
            guest: '只能看到明确共享给此账户或其所属群组的会话和资源。',
        },
        status: {
            active: '活跃',
            suspended: '已暂停',
        },
        history: {
            label: '会话历史',
            allExisting: '包含已共享给团队的会话',
            fromMembership: '仅包含加入之后共享的会话',
            allExistingNamed: ({ name }) => `包含已共享给${name}的会话`,
            fromMembershipNamed: ({ name }) => `仅包含加入${name}之后共享的会话`,
            scopeNote: '这以整个会话为单位。它不会只显示加入之后创建的消息。',
        },
        unavailable: {
            title: '此 Home 无法使用团队',
            disabled: '此 Home 已关闭团队功能。',
            updateRequired: '此 Home 需要更新才能使用团队。',
            offline: '当前无法连接此 Home。',
            retry: '重试',
        },
        stale: {
            label: '正在显示此 Home 最后已知的数据。',
        },
        errors: {
            generic: '操作未完成，没有任何内容被更改。',
            outcomeUnknown: 'Home 可能已经完成此更改。请先刷新团队，再重试。',
            forbidden: '你没有进行此更改的权限。',
            notFound: '此团队已不可用。',
            archived: '此团队已归档。恢复后才能更改。',
            conflict: '有人先一步做了更改。请查看当前值后重试。',
            offline: '此 Home 无法连接，更改未发送。',
            invalidName: '请输入 1 到 80 个字符的名称。',
            invalidDescription: '请输入不超过 500 个字符的描述。',
        },
        directory: {
            loading: '正在加载团队…',
            chooseTeamToShare: '选择要与之共享的团队。',
            noMatches: '没有匹配的团队',
            noLoadedMatches: '已加载的团队中没有匹配项',
            searchLoadedPlaceholder: '筛选已加载的团队',
            unreachableHomes: '无响应',
            searchPlaceholder: '搜索团队',
            newTeam: '新建团队',
            createDenied: ({ homes }: { homes: string }) => `只有 ${homes} 的管理员可以创建团队。请管理员创建团队或将你加入团队。`,
            createAdministered: ({ names }: { names: string }) => `此 Home 的团队由其管理员创建。请让 ${names} 为你创建团队，或允许所有人创建团队。`,
            createAdministeredUnnamed: '此 Home 的团队由其管理员创建。请让管理员为你创建团队，或允许所有人创建团队。',
            createOff: '此 Home 已关闭团队创建。',
            letEveryoneCreate: '允许所有人创建团队',
            namesAnd: ({ names, last }: { names: string; last: string }) => `${names}和${last}`,
            namesAndOthers: ({ names, count }: { names: string; count: number }) => `${names}和另外 ${count} 人`,
            emptyTitle: '还没有团队',
            emptyBody: '团队为一群人提供一个共享的地方，用于会话、成员和访问权限。',
            archivedSection: '已归档的团队',
            archivedEmpty: '没有已归档的团队',
            archivedEmptyBody: '在团队自己的设置中归档，团队就会移到这里。成员、群组和历史记录都会保留。',
            showArchived: '显示已归档',
            hideArchived: '隐藏已归档',
            archivedBadge: '已归档',
            rowAccessibilityLabel: ({ name, role, home }: { name: string; role: string; home: string }) => `${name}，${role}，位于 ${home}`,
            partialHomes: '部分 Home 无法连接，因此列表中缺少它们的团队。',
        },
        create: {
            loading: '正在检查可在哪里创建团队…',
            discard: '放弃',
            detailsSection: '团队',
            logoFailedBody: '团队已创建，但其徽标未发布。请重试，或在没有徽标的情况下继续。',
            title: '新建团队',
            nameLabel: '名称',
            namePlaceholder: 'Acme',
            descriptionLabel: '描述',
            descriptionPlaceholder: '这个团队负责什么',
            homeHelp: '团队将在此 Home 中创建并一直留在这里。',
            duplicateNameNote: '两个团队可以同名。链接和访问权限始终指向团队本身。',
            managedOnlyTitle: '此 Home 的团队创建由管理员负责',
            managedOnlyBody: '这里由管理员创建团队并指定第一位所有者。',
            initialOwnerLabel: '第一位所有者',
            initialOwnerPlaceholder: '在此 Home 中搜索成员',
            initialOwnerHelp: '为他人创建团队不会把你加入其中。',
            initialOwnerRequired: '请选择团队的第一位所有者。在此 Home 上，由管理员指定新团队的所有者。',
            initialOwnerIneligible: '此人已无法拥有团队。请选择其他人。',
            submit: '创建团队',
            submitting: '正在创建…',
            outcomeUnknown: '无法确认团队是否已创建。请重试以恢复同一请求。',
        },
        tabs: {
            overview: '概览',
            sessions: '会话',
            members: '成员',
            groups: '群组',
            invitations: '邀请',
            authentication: '身份验证',
            settings: '设置',
        },
        authentication: {
            policy: {
                admissionSection: '加入方式',
                admissionHelp: '成员如何加入这个团队。',
                admissionInviteOnly: '仅限邀请',
                admissionProvisioned: '由目录预配',
                admissionJit: '首次登录时自动加入',
                admissionUnavailable: '此 Home 尚无法执行该加入方式，因此未做任何更改。',
                admissionUnavailableReason: {
                    homePolicyUnavailable: '此 Home 尚未向团队提供该登录提供方。Home 管理员可以更改。',
                    homePolicyProhibited: '此 Home 的管理员不允许使用该加入方式。',
                    directorySourceRequired: '请先为此团队添加目录。该方式接纳目录提供的人员。',
                    directoryProjectionRequired: '此团队的目录尚未完成首次同步。完成后即可使用该方式。',
                    teamConnectionRequired: '请先为此团队添加登录连接。首次登录时加入需要它。',
                    teamConnectionUnavailable: '此团队目前没有可用的登录连接，因此登录时无人能够加入。',
                },
                acceptedSection: '接受的登录方式',
                acceptedHelp: '在允许团队操作之前，这个团队接受哪种登录方式。',
                acceptedInherit: '使用 Home 策略',
                acceptedRestricted: '仅限下面选择的登录方式',
                connectionsSection: '接受的连接',
                connectionsEmpty: '至少选择一个登录连接，或使用 Home 策略。',
                homeMethodRetained: '沿用已保存的策略',
                repairRequired: '无法读取已保存的登录限制',
                repairRequiredHelp: '它未按写入内容生效。请在下面选择一个策略来替换它。',
                conflictBody: '此 Home 的登录策略已更改。请先查看，然后重新应用你的更改。',
                providerTestRequired: '在团队要求使用此连接之前，请先测试它。',
                unavailable: '此 Home 无法接受该登录策略。',
                approvalPending: '等待批准',
                connectionOwnerTeam: "团队连接",
                connectionOwnerHome: "Home 登录方式",
            },
            subtitle: '团队成员用于证明身份的方式。',
            memberSignIn: {
                section: '成员登录页面',
                open: '打开成员登录页面',
                copyLink: '复制链接',
                shareLink: '分享链接',
                qrLabel: '成员登录链接的二维码',
                footer: '任何拥有此链接的人都能打开该团队的登录页面。链接本身不授予任何权限：加入仍需遵循团队的准入策略。',
                unavailable: '没有可分享的链接',
                unavailableBody: '此 Home 未发布网址，因此没有可在其他设备上使用的链接。Home 管理员可以配置一个。',
            },
            connectionsSection: '登录连接',
            empty: '没有登录连接',
            status: {
                unavailable: '不可用',
                prohibited: '已被 Home 策略阻止',
                notConfigured: '未配置',
                settingUp: '正在设置',
                connected: '有效',
                needsAttention: '需要处理',
                disabled: '已停用',
            },
            mode: {
                signInOnly: '仅用于登录',
                signInTimeGroups: '登录时刷新群组',
            },
            detail: {
                status: '状态',
                mode: '模式',
                provider: '提供商',
                restrictions: '登录限制',
                allowedUsers: '允许的用户',
                allowedDomains: '允许的电子邮件域名',
                none: '无',
                configuration: '配置',
                organization: '组织',
                connection: '连接',
            },
            directory: {
                actions: {
                    section: '操作', sync: '立即同步', pause: '暂停同步', resume: '继续同步', remove: '移除目录…',
                    pauseTitle: ({ source }: { source: string }) => `暂停 ${source}？`, pauseBody: '新的目录变更将停止。已知的 Team 访问权限和群组贡献会保留到恢复同步。',
                    removeTitle: ({ source }: { source: string }) => `移除 ${source}？`, removeBody: ({ teamMembershipsRemoved, groupMembershipsRemoved, groupContributionsRemoved, directoryCreatedGroupsRetained, nativeMembershipsPreserved, nativeGroupContributionsPreserved }: { teamMembershipsRemoved: number; groupMembershipsRemoved: number; groupContributionsRemoved: number; directoryCreatedGroupsRetained: number; nativeMembershipsPreserved: number; nativeGroupContributionsPreserved: number }) => `将移除 ${teamMembershipsRemoved} 个托管成员资格、${groupMembershipsRemoved} 个有效群组成员资格和 ${groupContributionsRemoved} 个来源贡献。会保留 ${directoryCreatedGroupsRetained} 个目录创建的群组、${nativeMembershipsPreserved} 个原生成员资格和 ${nativeGroupContributionsPreserved} 个原生群组贡献。不会删除 Account。`,
                },
                section: "托管成员资格",
                overviewSubtitle: "目录源让团队成员和群组与外部组织保持同步。",
                manageSubtitle: "查看已连接的目录源及其最新同步状态。",
                title: "目录同步",
                sourcesSection: "目录源",
                sourcesLoadMore: "加载更多来源",
                subtitle: "仅从完整的服务器投影应用成员资格变更。",
                empty: "没有目录源",
                setup: {
                    section: "添加来源",
                    add: "选择目录来源",
                    options: "来源设置",
                    optionsFooter: "选择准确且已验证的提供商目录或组织。",
                    loadMore: "加载更多",
                    empty: "暂无已验证的来源",
                    workos: "设置 WorkOS 目录同步",
                    workosSubtitle: "打开 WorkOS 管理门户，然后返回选择已验证的目录。",
                    confirmTitle: ({ source }: { source: string }) => `Add ${source}?`,
                    confirmBody: "添加后，Happier 将开始导入此目录。",
                },
                people: {
                    section: "人员",
                    empty: "没有已配置的人员",
                    provisioned: "已配置 · 尚无帐户",
                    boundAccountCount: ({ count }: { count: number | string }) => `已绑定帐户：${count}`,
                    unboundPeopleCount: ({ count }: { count: number | string }) => `尚无帐户的已配置人员：${count}`,
                    member: "团队成员",
                    unknown: "未命名人员",
                    loadMore: "加载更多人员",
                    state: {
                        suspended: "已暂停",
                        deleted: "已删除",
                    },
                },
                kind: {
                    workos: "WorkOS 目录同步",
                    github: "GitHub 组织",
                },
                state: {
                    setup: "需要设置",
                    syncing: "同步中",
                    active: "有效",
                    paused: "已暂停",
                    needsAttention: "需要处理",
                    initializing: "正在设置",
                    failed: "上次同步失败",
                },
                mode: {
                    eventsAndFull: "事件和完整对账",
                    fullOnly: "仅完整对账",
                },
                freshness: {
                    never_synced: "从未同步",
                    fresh: "最新",
                    stale: "已过期",
                    unknown: "未知",
                },
                detail: {
                    status: "状态",
                    sourceType: "源类型",
                    syncSection: "同步状态",
                    mode: "同步模式",
                    freshness: "新鲜度",
                    lastSuccess: "上次成功同步",
                    nextScheduled: "下次计划同步",
                    attentionSection: "需要处理",
                    attentionTitle: "此目录源需要处理",
                    attentionRetryable: "修复连接后，此目录源可以恢复。刷新以检查最新状态。",
                    attentionAdmin: "在依赖新的目录变更之前，请检查源配置。",
                },
                never: "从未",
                unknown: "未知",
            },
        },
        settings: {
            archiveDescription: '归档会将团队移出活动视图，并停止基于团队的访问。其成员、群组和历史记录会保留，且可以恢复。',
            logoSection: '标识',
            sessionDefaultsSection: '会话默认设置',
            externalSharingSection: '对外共享',
            historyDefaultSection: '历史默认设置',
            lifecycleSection: '团队生命周期',
            saved: '已保存',
        },
        policy: {
            sessionCreationPrivate: '默认私有',
            sessionCreationTeam: '默认共享给团队',
            sessionCreationRequired: '始终共享给团队',
            sessionCreationHelp: '这适用于新会话。已有的私有会话不会被公开。',
            externalSharingAllowed: '任何有共享权限的人',
            externalSharingAdmins: '仅团队管理员',
            externalSharingDisabled: '不允许',
            externalSharingHelp: '这可以阻止今后的共享，但不会收回已经共享出去的副本。',
            historyDefaultHelp: '这会为新成员预选该选项，不会改写现有成员的历史范围。',
        },
        logo: {
            add: '添加标识',
            replace: '更换标识',
            remove: '移除标识',
            removeConfirmTitle: '要移除此标识吗？',
            removeConfirmBody: '团队将重新显示其字母图案。你随时可以上传新的标识。',
            previewLabel: '标识预览',
            useAsLogo: '用作标识',
            monogramLabel: '团队字母图案',
            tooLarge: '该图片过大，请选择更小的图片。',
            invalidFormat: ({ formats }: { formats: string }) => `该文件不是受支持的图片格式。支持的格式：${formats}。`,
            failed: '标识未上传，当前标识保持不变。',
            retry: '重试',
        },
        archive: {
            openSettings: '打开设置',
            action: ({ name }: { name: string }) => `归档 ${name}`,
            confirmTitle: ({ name }: { name: string }) => `要归档 ${name} 吗？`,
            confirmBody: ({ name }: { name: string }) => `${name} 将从活跃视图中移除。基于团队和群组的访问会停止，未使用的邀请链接会被撤销。成员关系、群组、策略和已有授权都会保留。恢复 ${name} 后，这些保留的授权可能会重新生效。`,
            restoreAction: ({ name }: { name: string }) => `恢复 ${name}`,
            restoreTitle: ({ name }: { name: string }) => `要恢复 ${name} 吗？`,
            restoreBody: () => '在账户和资源仍然允许的范围内，当前的成员关系、群组和保留的授权会重新生效。已撤销的邀请链接不会恢复。',
            readOnly: '此团队已归档。恢复后才能更改。',
        },
        members: {
            membershipSection: '成员资格',
            filterLabel: '显示',
            searchPlaceholder: '搜索成员',
            filterAll: '全部',
            filterOwnersAndAdmins: '所有者和管理员',
            filterMembers: '成员',
            filterGuests: '访客',
            filterSuspended: '已暂停',
            emptyTitle: '没有匹配的成员',
            emptyBody: '请调整筛选条件，或邀请他人加入此团队。',
            add: '添加成员',
            addTitle: ({ team }: { team: string }) => `添加到 ${team}`,
            personLabel: '成员',
            roleLabel: '角色',
            personPlaceholder: '在此 Home 中搜索成员',
            ineligible: '已在此团队中，或不是此 Home 的活跃账户。',
            addSubmit: '添加成员',
            you: '你',
            joined: ({ when }: { when: string }) => `加入于 ${when}`,
            managedBy: ({ source }: { source: string }) => `通过 ${source} 管理`,
            managedReadOnly: '此成员关系由其来源管理，请在那里更改。',
            detailManagedBy: '管理方',
            managementTitle: '管理来源',
            managementHelp: '更换管理来源会保留此成员关系及其角色、状态和会话历史，只有谁能更改会随之改变。',
            managementNative: '在 Happier 中管理',
            managementConflict: '该来源尚无可关联到此人的身份。请先同步该来源，然后重试。',
            detailOpenSource: '打开来源设置',
            encryption: {
                title: '加密访问',
                checking: '正在检查加密访问…',
                ready: '已准备',
                scopeBody: '这里仅包括你管理的会话。其他会话管理者可能仍需准备访问权限。',
                pending: '待准备',
                prepare: '准备加密访问',
                preparing: ({ prepared }: { prepared: number }) => `正在准备加密访问 · 已准备 ${prepared} 个`,
                setupRequired: '需要设置',
                setupRequiredBody: '此人尚未完成加密访问的设置。完成后你可以为其准备会话历史。',
                notEncrypted: '未加密',
                plainAccount: '此人的账户未使用端到端加密，因此无需准备。',
                repairRequired: '加密访问需要修复',
                repairBody: '你管理的部分会话无法在此设备上准备。请打开它们以修复你自己的访问权。',
                nonTransferableBody: '部分会话使用较早的加密格式，无法共享给新成员。已有访问权限的人仍可阅读。',
                recipientChanged: '此人的账户已更改。正在重新加载后再准备。',
                retry: '重试',
                failed: '准备在完成前停止。已准备的内容已保留。',
            },
            detailGroups: '群组',
            detailGroupsEmpty: '没有群组',
            suspend: '暂停成员',
            suspendTitle: ({ name }: { name: string }) => `要暂停 ${name} 吗？`,
            suspendBody: '团队和群组访问会立即停止。群组成员关系和资源分配会保留，恢复后只会重新启用仍然有效的访问。Home 账户和其他团队不受影响。',
            reactivate: '恢复成员',
            reactivateTitle: ({ name }: { name: string }) => `要恢复 ${name} 吗？`,
            reactivateBody: '在成员关系、群组和账户状态仍然允许的范围内，访问会恢复。',
            remove: '移出团队',
            removeTitle: ({ name }: { name: string }) => `要移除 ${name} 吗？`,
            removeBody: '当前的团队和群组访问会结束。群组成员关系以及与成员期限绑定的资源授权会被移除。此前的署名和已看到的内容不会被清除。日后重新加入会开始一段新的成员关系。',
            lastOwnerBlocked: '团队至少要保留一位活跃的所有者。请先指定另一位所有者。',
            accountInactive: '此人的账户未处于活跃状态，无法添加或设为所有者。',
            ownerOnlyAction: '只有团队所有者才能更改所有者。',
            ownerRequiredTitle: '需要所有者',
            ownerRequiredBody: ({ team }: { team: string }) => `${team} 需要一位活跃的所有者才能进行仅限所有者的更改。`,
            chooseOwner: '选择所有者',
            ownerRequiredNoCandidate: '没有符合条件的成员。需要先添加一位现有成员，或安排一次所有权交接。',
        },
        groups: {
            detailsSection: '群组',
            title: '群组',
            emptyTitle: '还没有群组',
            emptyBody: '群组是团队成员的一个扁平集合，可以一次性共享给他们。',
            emptyRosterTitle: '此群组还没有成员',
            noEligibleCandidatesTitle: '没有可添加的人',
            noEligibleCandidatesBody: '尚未加入此群组的团队成员会显示在这里。',
            create: '新建群组',
            nameLabel: '名称',
            namePlaceholder: '开发',
            descriptionPlaceholder: '此群组的用途',
            submit: '创建群组',
            nameTaken: '此团队中已有同名的群组。',
            memberCount: ({ count }: { count: number }) => `${count} 位成员`,
            managedBy: ({ source }: { source: string }) => `由 ${source} 管理`,
            membersSection: '群组成员',
            addMember: '添加到群组',
            removeNative: '移出群组',
            removeMemberTitle: ({ name, group }: { name: string; group: string }) => `将 ${name} 从 ${group} 中移除？`,
            removeMemberBody: ({ name, group }: { name: string; group: string }) => `${name} 将立即失去来自 ${group} 的访问权限。该成员仍留在 Team 中，你可以再次将其加入该群组。`,
            externalOnlyTitle: '由其来源管理',
            externalOnlyBody: ({ source }: { source: string }) => `${source} 仍在提供此人，因此他们会留在群组中。请在该来源的设置中更改。`,
            archiveAction: ({ name }: { name: string }) => `归档 ${name}`,
            archiveTitle: ({ name }: { name: string }) => `要归档 ${name} 吗？`,
            archiveBody: '基于群组的访问会立即停止。成员关系和历史会保留，恢复该群组后这些授权可能会重新生效。',
            restoreAction: ({ name }: { name: string }) => `恢复 ${name}`,
            archivedSection: '已归档的群组',
            archivedReadOnly: '此群组已归档。恢复后才能更改。',
            managedReadOnly: '该群组的名称和生命周期由其来源管理，但仍可在此添加成员。',
        },
        invitations: {
            emptyTitle: '没有邀请',
            emptyBody: '用链接邀请他人，或添加已在此 Home 拥有账户的人。',
            invite: '邀请',
            inviteTitle: ({ team }: { team: string }) => `邀请加入 ${team}`,
            byLink: '链接',
            byEmail: '电子邮件',
            emailLabel: '电子邮件地址',
            emailPlaceholder: 'name@example.cn',
            create: '创建邀请',
            linkNotice: ({ team, role }: { team: string; role: string }) => `任何已登录此 Home 并持有该链接的人，都可以以${role}身份加入 ${team}。`,
            copyLink: '复制链接',
            copied: '链接已复制',
            qrLabel: '此邀请链接的二维码',
            qrTooLargeFallback: '此链接太长，无法生成二维码。请改为复制。',
            linkRow: '邀请链接',
            maskedRecipient: ({ email }: { email: string }) => `发给 ${email}`,
            expires: ({ when }: { when: string }) => `${when} 过期`,
            stateActive: '有效',
            stateAccepted: '已接受',
            stateRevoked: '已撤销',
            stateExpired: '已过期',
            deliverySent: '邮件已提交',
            deliveryFailed: '邮件投递失败',
            deliveryUnknown: '投递结果未知',
            deliveryRetry: '重试',
            deliveryChangeEmail: '更改邮箱',
            emailUnavailable: '此 Home 无法发送邮件，请改为共享链接。',
            reissue: '创建新链接',
            reissueNotice: '重新签发会创建新链接，之前的链接将停止工作。',
            revoke: '撤销邀请',
            revokeTitle: '要撤销此邀请吗？',
            revokeBody: '该链接会立即停止工作。你随时可以创建新的链接。',
            shareLink: '分享链接',
            shareUnavailable: '此设备不支持分享。请改为复制链接。',
            bearerUnavailable: '此链接只显示过一次，并未保存。请创建新链接以再次共享访问权限。',
            linkUnavailableRow: '没有可分享的链接',
            linkUnavailableBody: '此 Home 尚未发布可供邀请链接指向的地址，因此没有可分享的链接。请 Home 管理员发布一个地址，或从 Team 的成员列表中直接添加人员。',
        },
        join: {
            previewLoading: '正在检查此邀请…',
            joinAction: ({ team }: { team: string }) => `加入 ${team}`,
            joinWithCurrentAccount: '使用此账号加入',
            addInvitedAddressNotice: ({ email }: { email: string }) => `${email} 将作为已验证地址添加到此账号。`,
            useAnotherAccount: '使用其他账号',
            useCurrentAccount: '使用当前账号',
            useAnotherAccountHint: '在不退出此账号的情况下登录此 Home。',
            hostedOn: ({ home }: { home: string }) => `托管于 ${home}`,
            personalHomeNotice: '此 Home 运行在个人电脑上，离线时可能无法访问。',
            plainStorageNotice: '此 Home 上的会话未使用端到端加密存储。',
            invitedBy: ({ name }: { name: string }) => `由 ${name} 邀请。`,
            roleOffered: ({ role }: { role: string }) => `你被邀请为${role}。`,
            guestNotice: ({ team }: { team: string }) => `以访客身份加入不会获得 ${team} 团队会话的访问权限。相关内容必须单独共享给你或你所属的某个群组。`,
            joinedTitle: '你已加入',
            alreadyMemberTitle: '你已经是成员',
            openTeam: ({ team }: { team: string }) => `打开 ${team}`,
            expiredTitle: '此邀请已过期',
            revokedTitle: '此邀请已被撤销',
            usedTitle: '此邀请已被使用',
            archivedTitle: '此团队已归档',
            inactiveTitle: '此账户目前无法加入',
            invalidTitle: '此邀请链接无效',
            unresolvedHomeTitle: '此链接未标明所属 Home',
            unresolvedHomeBody: '此设备无法判断哪个 Home 签发了该邀请，因此没有向任何 Home 发送内容。请向团队管理者索取新的链接。',
            unknownHomeTitle: '此设备尚未添加该 Home',
            askForNew: '请向团队管理者索取新的邀请。',
            mismatchTitle: '此邀请面向另一个地址',
            signInWithInvited: '使用受邀地址登录',
            verifyAddress: '验证此地址',
            updateRequiredTitle: '此 Home 需要更新才能使用团队邀请',
            offlineTitle: '无法连接此 Home',
            offlineBody: '邀请已保留。请在 Home 恢复后重试。',
            acceptanceOutcomeUnknown: '无法确认你是否已加入。请重试以检查同一邀请。',
            retry: '重试',
        },
        credentials: {
            recovery: {
                openSettings: '\u6253\u5f00\u51ed\u636e\u8bbe\u7f6e',
                selectBroker: '\u9009\u62e9\u4ee3\u7406\u4f4d\u7f6e',
                ownerHandoff: '\u8bf7\u6e90\u7684\u6240\u6709\u8005\u4fee\u590d\u6b64\u51ed\u636e',
                updateApp: '\u66f4\u65b0 Happier',
                chooseAnother: '\u9009\u62e9\u5176\u4ed6\u51ed\u636e',
            },
            requestPolicy: {
                title: '请求策略',
                subtitle: '限制可以用这份凭据做什么。',
                summaryNone: '没有限制',
                summaryActive: ({ count }: { count: number }) => `${count} 项限制`,
                protocolsLabel: '请求格式',
                protocolsAny: '来源支持的全部格式',
                modelsLabel: '模型',
                modelsAny: '来源提供的全部模型',
                modelsAllowed: ({ count }: { count: number }) => `允许 ${count} 个`,
                effortLabel: '推理强度',
                effortAny: '来源支持的全部强度',
                catalogUnavailable: '目前还无法从这个 Home 选择允许哪些模型。现有选择在被移除之前仍然有效。',
                clear: '移除所有限制',
                activeNote: '已经在运行的会话不会被改写。它的下一次请求需要符合新策略。',
                protocol: {
                    openaiResponses: 'OpenAI Responses',
                    openaiChatCompletions: 'OpenAI Chat Completions',
                    anthropicMessages: 'Anthropic Messages',
                },
            },
            directReadiness: {
                title: '直接访问准备情况',
                check: '检查准备情况',
                summary: ({ ready, pending }: { ready: number; pending: number }) => `${ready} 项就绪 · ${pending} 项准备中`,
                allReady: '拥有直接访问权限的人都已就绪。',
                automatic: '材料会在持有该来源的电脑上准备，只要它在线就会进行。',
                state: {
                    ready: '就绪',
                    preparing: '正在准备访问',
                    notDelivered: '尚未送达',
                    recipientBindingChanged: '等待加密账户设置',
                    sourceChanged: '来源已更改 — 正在更新',
                },
            },
            externalApi: {
                title: '外部 API 访问',
                subtitle: '在 Happier 之外的兼容工具中使用这个供应商。',
                privateTitle: 'Happier 会话',
                privateDetail: '通过 Happier 私密进行',
                unavailable: '这个 Home 不提供外部 API 访问。',
                publicHttpsRequired: '外部工具需要此 Home 的公共 HTTPS 地址。',
                homeDisclosure: '发送给供应商的原始请求正文会经过此 Home 的公共 HTTPS 端点，其运营者可以读取这些内容。',
                bearerDisclosure: '此密钥是持有者凭证。任何持有它的人都可以使用所分配的访问权限，直到密钥过期或被撤销。',
                usageDisclosure: 'Happier 会记录请求次数。如果协议无法上报，令牌和费用总计可能不完整。',
                keysTitle: 'API 密钥',
                authorize: '授权密钥',
                authenticationRequired: '指定成员需要通过团队登录授权此密钥。',
                authenticationUnavailable: '团队身份验证不可用。请团队管理员检查登录策略。',
                keysLoadFailed: '无法加载 API 密钥。',
                keysRetry: '重新加载密钥',
                keysEmpty: '还没有密钥',
                keysEmptyBody: '创建第一个密钥会开启外部访问；撤销最后一个会关闭它。',
                labelPlaceholder: '这个密钥的用途',
                assignLabel: '归属于',
                revealTitle: '现在就保存这个密钥',
                revealBody: '它不会再次显示。',
                revealDismiss: {
                    title: '尚未复制密钥，仍要关闭吗？',
                    body: '此密钥无法再次显示。请保持显示，直到你将它保存好。',
                    confirm: '我已保存密钥',
                    keepVisible: '继续显示密钥',
                },
                neverUsed: '从未使用',
                lastUsed: ({ when }: { when: string }) => `上次使用 ${when}`,
                expiresOn: ({ when }: { when: string }) => `到期 ${when}`,
                expired: '已过期',
                revokeTitle: ({ name }: { name: string }) => `撤销 ${name}？`,
                revokeBody: '使用这个密钥的工具会立刻停止工作。Happier 会话不受影响。',
                revokeAll: '撤销全部密钥',
                revokeAllBody: '在创建新密钥之前，外部 API 访问会被关闭。Happier 会话不受影响。',
            },
            title: '\u5171\u4eab\u51ed\u636e',
            subtitle: '\u8ba9\u56e2\u961f\u4f7f\u7528\u5df2\u8fde\u63a5\u8d26\u53f7\u3001\u8d44\u6e90\u6c60\u6216\u63d0\u4f9b\u5546\uff0c\u800c\u65e0\u9700\u5c06\u5176\u590d\u5236\u5230\u6bcf\u4e2a\u6210\u5458\u7684\u914d\u7f6e\u4e2d\u3002',
            emptyTitle: '\u8fd8\u6ca1\u6709\u5171\u4eab\u51ed\u636e',
            emptyBody: '\u5c1a\u672a\u5411\u6b64\u56e2\u961f\u5171\u4eab\u4efb\u4f55\u5185\u5bb9\u3002',
            forbidden: '\u5171\u4eab\u51ed\u636e\u7531\u8be5\u56e2\u961f\u7684\u6240\u6709\u8005\u548c\u7ba1\u7406\u5458\u7ba1\u7406\u3002',
            unavailable: '\u6b64 Home \u4e0d\u63d0\u4f9b\u5171\u4eab\u51ed\u636e\u3002',
            approvalPending: '正在等待审批。在作出决定前会保留更改。',
            approvalDeclined: '该请求未获批准，因此没有任何更改。',
            sessionDeniedTitle: '共享凭据拒绝了此请求',
            sharedByYou: '\u7531\u4f60\u5171\u4eab',
            providedByTeams: '\u7531\u56e2\u961f\u63d0\u4f9b',
            sharedWithYou: '\u4e0e\u4f60\u5171\u4eab',
            sourceAdministration: { title: '\u4e0e\u56e2\u961f\u5171\u4eab', empty: '\u6b64\u6765\u6e90\u672a\u4e0e\u4efb\u4f55\u56e2\u961f\u5171\u4eab\u3002' },
            source: {
                connectedAccount: '\u5df2\u8fde\u63a5\u8d26\u53f7',
                pool: '\u5df2\u8fde\u63a5\u670d\u52a1\u6c60',
                providerConnection: '\u63d0\u4f9b\u5546\u8fde\u63a5',
            },
            delivery: {
                brokered: '\u7ecf\u4ee3\u7406',
                direct: '\u76f4\u63a5\u8bbf\u95ee',
                both: '\u4ee3\u7406 + \u76f4\u63a5',
                mixed: '\u6df7\u5408\u4ea4\u4ed8',
            },
            state: {
                available: '\u53ef\u7528',
                needsAttention: '\u9700\u8981\u5904\u7406',
                disabled: '\u5df2\u505c\u7528',
            },
            usePolicy: {
                title: '与团队共享此会话？',
                label: '\u6210\u5458\u53ef\u5728\u54ea\u91cc\u4f7f\u7528',
                personalAllowed: '\u4efb\u4f55\u5141\u8bb8\u7684\u4f1a\u8bdd',
                teamContextRequired: '\u5f52\u5c5e\u4e8e\u6b64\u56e2\u961f\u7684\u4f1a\u8bdd',
                teamVisibilityRequired: '\u6b64\u56e2\u961f\u53ef\u89c1\u7684\u4f1a\u8bdd',
                visibilityNote: '\u9009\u62e9\u6b64\u51ed\u636e\u53ef\u80fd\u5728\u672c\u4eba\u786e\u8ba4\u540e\u5c06\u79c1\u5bc6\u4f1a\u8bdd\u5171\u4eab\u7ed9\u56e2\u961f\u3002',
            },
            selection: {
                activeTransitionUnsupported: '这个会话在更改保存前就开始运行了，因此模型没有更改。请重试。',
            },
            detail: {
                sourceLabel: '\u6765\u6e90',
                brokerLabel: '\u4ee3\u7406\u4f4d\u7f6e',
                brokerNone: '\u9009\u62e9\u4ee3\u7406\u4f4d\u7f6e',
                access: '\u8bbf\u95ee\u4e0e\u4ea4\u4ed8',
                activity: '\u6d3b\u52a8',
                edit: '\u7f16\u8f91',
                notFound: '\u6b64\u5171\u4eab\u51ed\u636e\u5df2\u4e0d\u53ef\u7528\u3002',
                brokerUnnamedMachine: '未命名的电脑',
                brokerUnnamedPool: '未命名的池',
                brokerChosen: '由来源所有者选择',
                limits: '用量上限',
                usage: '用量',
            },
            create: {
                title: '共享凭据',
                action: '共享凭据',
                submit: '创建共享凭据',
                sourceChoose: '选择来源',
                sourceEmpty: '暂时没有可共享的内容。',
                sourceUnsupported: '此 Home 暂时还不能共享已连接账号和提供方连接。',
                alreadyShared: '已与该团队共享',
                poolAccounts: ({ count }: { count: number }) => `${count} 个账号`,
                notAllowed: '该团队不允许你提供自己的凭据。',
                reviewLabel: '确认',
            },
            edit: {
                title: '\u7f16\u8f91\u5171\u4eab\u51ed\u636e',
                nameLabel: '\u540d\u79f0',
                namePlaceholder: '\u4e3a\u6b64\u51ed\u636e\u547d\u540d',
                ceilingLabel: '\u76f4\u63a5\u62ab\u9732',
                ceilingBrokeredOnly: '\u4ec5\u7ecf\u4ee3\u7406',
                ceilingDirectAllowed: '\u5141\u8bb8\u76f4\u63a5\u8bbf\u95ee',
                ceilingNote: '\u76f4\u63a5\u8bbf\u95ee\u4f1a\u8ba9\u63a5\u6536\u65b9\u7684\u672c\u5730\u5de5\u5177\u83b7\u5f97\u51ed\u636e\u6750\u6599\u3002\u79fb\u9664\u8bbf\u95ee\u4f1a\u505c\u6b62\u540e\u7eed\u4ea4\u4ed8\uff0c\u4f46\u65e0\u6cd5\u62b9\u9664\u5916\u90e8\u8fdb\u7a0b\u5df2\u4f7f\u7528\u7684\u5185\u5bb9\u3002',
                conflict: '\u8fd9\u4e9b\u8bbe\u7f6e\u5df2\u5728\u5176\u4ed6\u5730\u65b9\u53d8\u66f4\u3002\u4fdd\u5b58\u524d\u8bf7\u91cd\u65b0\u52a0\u8f7d\u4ee5\u67e5\u770b\u5f53\u524d\u503c\u3002',
            },
            audience: {
                title: '\u8bbf\u95ee\u4e0e\u4ea4\u4ed8',
                none: '\u8fd8\u6ca1\u6709\u4eba',
                everyone: '\u56e2\u961f\u6240\u6709\u4eba',
                everyoneOff: '\u65e0\u5168\u56e2\u961f\u8bbf\u95ee',
                groupCount: ({ count }: { count: number }) => `${count} \u4e2a\u7fa4\u7ec4`,
                memberCount: ({ count }: { count: number }) => `${count} \u4eba`,
                add: '添加群组或成员',
                groupsSection: '\u7fa4\u7ec4',
                membersSection: '\u6210\u5458',
                remove: '\u79fb\u9664\u8bbf\u95ee',
                ceilingBlocked: '\u6b64\u51ed\u636e\u4e0d\u5141\u8bb8\u76f4\u63a5\u8bbf\u95ee\u3002\u8bf7\u5148\u5728\u7f16\u8f91\u4e2d\u5141\u8bb8\u3002',
                directTitle: '\u76f4\u63a5\u5171\u4eab\u6b64\u51ed\u636e\uff1f',
                directBody: '\u4f60\u9009\u62e9\u7684\u4eba\u5458\u7684\u672c\u5730\u5de5\u5177\u53ef\u80fd\u83b7\u5f97\u6b64\u6765\u6e90\u7684\u51ed\u636e\u6750\u6599\u3002\u79fb\u9664\u8bbf\u95ee\u4f1a\u505c\u6b62\u540e\u7eed\u4ea4\u4ed8\uff0c\u4f46\u65e0\u6cd5\u62b9\u9664\u5916\u90e8\u8fdb\u7a0b\u5df2\u4f7f\u7528\u7684\u5185\u5bb9\u3002',
                directConfirm: '\u76f4\u63a5\u5171\u4eab',
                keepBrokered: '\u4fdd\u6301\u7ecf\u4ee3\u7406',
                limitsNote: '\u76f4\u63a5\u4f7f\u7528\u53d1\u751f\u5728 Happier \u4e4b\u5916\uff0c\u4e0d\u4f1a\u88ab\u8bb0\u5f55\u3002',
            },
            directUse: {
                title: '\u76f4\u63a5\u4f7f\u7528\u6b64\u5171\u4eab\u51ed\u636e\uff1f',
                body: 'Happier \u53ef\u80fd\u4f1a\u5411\u6b64\u4f1a\u8bdd\u4f7f\u7528\u7684\u672c\u5730\u5de5\u5177\u63d0\u4f9b\u51ed\u636e\u6750\u6599\u3002\u4ec5\u5f53\u4f60\u4fe1\u4efb\u8fd9\u4e9b\u5de5\u5177\u5904\u7406\u6b64\u51ed\u636e\u65f6\u624d\u7ee7\u7eed\u3002',
            },
            delete: {
                action: '\u5220\u9664\u5171\u4eab\u51ed\u636e',
                title: ({ name }: { name: string }) => `\u5220\u9664 ${name}\uff1f`,
                body: '\u6210\u5458\u4f1a\u7acb\u5373\u5931\u53bb\u8bbf\u95ee\uff0c\u4e0b\u4e00\u6b21\u8bf7\u6c42\u5c06\u5931\u8d25\u3002\u5df2\u76f4\u63a5\u4ea4\u4ed8\u7684\u6750\u6599\u65e0\u6cd5\u62b9\u9664\u3002',
            },
            errors: {
                featureDisabled: '\u6b64 Home \u4e0d\u63d0\u4f9b\u5171\u4eab\u51ed\u636e\u3002',
                teamAuthenticationRequired: '\u8bf7\u5148\u767b\u5f55\u6b64\u56e2\u961f\uff0c\u7136\u540e\u7ee7\u7eed\u3002',
                teamAuthenticationPolicyUnavailable: '\u65e0\u6cd5\u8bfb\u53d6\u6b64\u56e2\u961f\u7684\u767b\u5f55\u7b56\u7565\uff0c\u56e0\u6b64\u6ca1\u6709\u505a\u4efb\u4f55\u66f4\u6539\u3002',
                memberNotEligible: '\u6b64\u4eba\u65e0\u6cd5\u4f7f\u7528\u8be5\u51ed\u636e\u3002',
                sessionPolicyIncompatible: '\u6309\u7167\u5171\u4eab\u7b56\u7565\uff0c\u8be5\u51ed\u636e\u4e0d\u80fd\u5728\u6b64\u4f1a\u8bdd\u4e2d\u4f7f\u7528\u3002',
                brokerUnavailable: '此凭据的中转机器当前无法连接。等它恢复后重试，或者换一个中转位置。',
                sourceOwnerRequired: '只有拥有该来源的人才能做这项更改。',
                sourceMissing: '此凭据指向的来源已不存在。需要由其所有者重新选择来源。',
                invalidAudience: '这些成员或群组无法获得此凭据。',
                subjectNotInTeam: '该成员或群组已不在此团队中。',
                costUnavailable: '费用上限需要每个允许模型都有价格，但有些缺少价格。请改为限制请求数或令牌数。',
                invalidLimit: '请检查计量方式、周期和上限值。',
                limitIdentityImmutable: '上限的适用对象、计量方式和周期无法更改。请删除后新增一条。',
            },
            limits: {
                groupShared: '\u8be5\u989d\u5ea6\u7531\u7fa4\u7ec4\u4e2d\u7684\u6240\u6709\u4eba\u5171\u4eab\u3002',
                title: '用量上限',
                empty: '尚未设置上限',
                emptyBody: '在你添加之前，所有请求都会被允许。',
                overshoot: '已记录用量达到上限后，新请求会停止。正在进行的请求可能会跑完。',
                directNote: '上限涵盖经中转的用量和外部 API 用量。直接使用发生在接收者自己的机器上，不会被记录。',
                directOnly: '所有有权限的人都在自己的机器上直接使用此凭据，因此 Happier 无法记录任何用量，也无法执行上限。',
                requestLimitsOnlyForPersonalUse: '当此凭据要求团队上下文时，才会出现令牌上限。个人使用还允许后台运行和外部 API 使用它，而它们只报告请求数，因此只有请求上限能覆盖全部使用。',
                add: '添加上限',
                subjectLabel: '适用于',
                subject: {
                    resource: '整个共享凭据',
                    eachMember: '每位成员单独计算',
                    group: '群组',
                    member: '成员',
                },
                metricLabel: '计量方式',
                metric: {
                    requests: '请求数',
                    tokens: '令牌数',
                    cost: '费用',
                },
                costNote: '只有当此凭据允许的每个模型都有已知价格时，费用上限才会生效。',
                periodLabel: '周期',
                period: {
                    day: '每天',
                    week: '每周',
                    month: '每月',
                },
                maximumLabel: '上限值',
                maximumPlaceholder: '每个周期的上限值',
                maximumInvalid: '请输入大于零的整数。',
                maximumInvalidCost: '请输入大于零的金额。',
                recorded: ({ recorded, maximum }: { recorded: string; maximum: string }) => `已记录 ${recorded} / ${maximum}`,
                resetsUtc: ({ when }: { when: string }) => `${when} UTC 重置`,
                reached: '已达上限',
                disabled: '已关闭',
                remove: '删除上限',
                removeTitle: '要删除这条上限吗？',
                removeBody: '请求会立即不再与它比对。已记录的用量会保留。',
                unknownSubject: '本页之外的某人',
            },
            usage: {
                title: '用量',
                empty: '此期间没有任何记录。',
                rangeLabel: '周期',
                brokeredRequests: '经代理的请求',
                directOnlyRequests: '仅统计经代理使用的请求。',
                recordedRequests: '已记录的请求',
                requestIncomplete: '仅包含 Happier 观察到的请求。',
                externalObservationsIncomplete: ({ count }: { count: number }) => `${count} 个外部请求尚无已记录的结果。`,
                breakdownRestricted: '部分维度仅对凭据管理者显示。',
                export: '导出 CSV',
                exportFailed: '此设备无法保存导出文件。',
                recordedByHappier: '由 Happier 记录。',
                directIncomplete: '直接使用发生在 Happier 之外，可能未计入。',
                costIncomplete: '此期间部分模型的费用无法获取。',
                tokenIncomplete: '此期间的令牌总数不完整。',
                tokenUnavailable: '此期间未观察到令牌使用。',
                costUnavailable: '此期间未观察到有定价的使用。',
                costUnknown: '无法获取',
                breakdownLabel: '拆分维度',
                breakdownNone: '仅显示合计',
                breakdown: {
                    member: '成员',
                    externalApiKey: '外部 API 密钥',
                    model: '模型',
                    session: '会话',
                    sourceMember: '来源账户',
                    workerMachine: '工作机器',
                    brokerMachine: '中转机器',
                    deliveryMode: '交付方式',
                },
                limitsTitle: '此期间的上限',
                sliceSummary: ({ requests, tokens }: { requests: string; tokens: string }) => `${requests} 次请求 · ${tokens} 个令牌`,
            },
            activity: {
                title: '\u6d3b\u52a8',
                empty: '\u5c1a\u672a\u8bb0\u5f55\u4efb\u4f55\u7ba1\u7406\u53d8\u66f4\u3002',
                unknownActor: '\u67d0\u4eba',
                kind: {
                    resourceCreated: '\u5171\u4eab\u4e86\u6b64\u51ed\u636e',
                    resourceUpdated: '\u66f4\u6539\u4e86\u8bbe\u7f6e',
                    audienceChanged: '\u66f4\u6539\u4e86\u53ef\u4f7f\u7528\u8005',
                    resourceDeleted: '\u5220\u9664\u4e86\u6b64\u51ed\u636e',
                    directDelivered: '\u4ea4\u4ed8\u4e86\u76f4\u63a5\u8bbf\u95ee',
                    externalKeyCreated: '\u521b\u5efa\u4e86\u5916\u90e8 API \u5bc6\u94a5',
                    externalKeyRevoked: '\u540a\u9500\u4e86\u5916\u90e8 API \u5bc6\u94a5',
                    limitsChanged: '\u66f4\u6539\u4e86\u9650\u989d',
                },
            },
        },
    },
};

const teamsTranslations = { zhHans: simplifiedChinese };

return { teamsTranslations };
})();

const Domain_terminalWorkspaceTranslations = (() => {
const en = Shared_terminalWorkspaceTranslations.en;

const terminalWorkspaceKeyboardTranslations = Shared_terminalWorkspaceTranslations.terminalWorkspaceKeyboardTranslations;

const terminalWorkspaceTranslations = { 'zh-Hans': en };

return { terminalWorkspaceTranslations };
})();

const Domain_thisComputerConnectionTranslations = (() => {
type HomeParams = Shared_thisComputerConnectionTranslations.HomeParams;

type OtherHomeParams = Shared_thisComputerConnectionTranslations.OtherHomeParams;

type AccountParams = Shared_thisComputerConnectionTranslations.AccountParams;

type RemovalServiceParams = Shared_thisComputerConnectionTranslations.RemovalServiceParams;

type MoveParams = Shared_thisComputerConnectionTranslations.MoveParams;

type ThisComputerConnectionTranslation = Shared_thisComputerConnectionTranslations.ThisComputerConnectionTranslation;

const en = Shared_thisComputerConnectionTranslations.en;

const zhHans: ThisComputerConnectionTranslation = {
    connectHome: {
        title: ({ home }: HomeParams) => `将此计算机连接到${home}？`,
        body: ({ home }: HomeParams) => `${home}将能够在此计算机上启动会话。终端的Home和其他Home连接将保持不变。`,
        connect: '连接',
        keep: '保留当前连接',
    },
    setupAlreadyRunning: '设置正在进行。请等待完成。',
    title: {
        daemon_url_mismatch: '后台服务正在使用其他 Home',
        daemon_account_mismatch: '后台服务正在使用其他账户',
        daemon_needs_auth: '后台服务需要登录',
        daemon_not_configured: '后台服务尚未连接',
        daemon_not_installed: '后台服务未安装',
        daemon_not_running: '后台服务已停止',
    },
    description: {
        daemon_url_mismatch: ({ home, daemonHome }: OtherHomeParams) => `它连接的是 ${daemonHome}，而不是 ${home}。`,
        daemon_account_mismatch: ({ home, daemonAccount, appAccount }: AccountParams) =>
            `它以 ${daemonAccount} 而不是 ${appAccount} 的身份登录了 ${home}。`,
        daemon_needs_auth: ({ home }: HomeParams) => `它已连接到 ${home}，但尚未获得批准。`,
        daemon_not_configured: ({ home }: HomeParams) => `它尚未完成与 ${home} 的连接。`,
        daemon_not_installed: ({ home }: HomeParams) => `安装后即可将这台电脑连接到 ${home}。`,
        daemon_not_running: ({ home }: HomeParams) => `启动它即可重新连接到 ${home}。`,
    },
    action: {
        daemon_url_mismatch: '连接到此 Home',
        daemon_account_mismatch: ({ appAccount }: { appAccount: string }) => `切换到 ${appAccount}`,
        daemon_needs_auth: '登录',
        daemon_not_configured: '连接到此 Home',
        daemon_not_installed: '安装后台服务',
        daemon_not_running: '启动后台服务',
    },
    connected: ({ home, appAccount }: { home: string; appAccount: string }) => `已以 ${appAccount} 的身份连接到 ${home}。`,
    noComputers: ({ home, appAccount }: { home: string; appAccount: string }) => `${appAccount} 在 ${home} 上还没有电脑。`,
    openThisComputer: '查看这台电脑',
    moveConfirm: {
        title: ({ appAccount }: { appAccount: string }) => `要将这台电脑切换到 ${appAccount} 吗？`,
        body: ({ home, daemonHome, daemonAccount, appAccount }: MoveParams) =>
            `它的后台服务以 ${daemonAccount} 的身份登录了 ${daemonHome}。切换后，它将在 ${home} 上为 ${appAccount} 工作，${daemonAccount} 将不再看到这台电脑。`,
        confirm: '切换',
    },
    cli: {
        title: 'Happier CLI',
        version: ({ version }: { version: string }) => `版本 ${version}`,
        updateAvailable: ({ version, latestVersion }: { version: string; latestVersion: string }) =>
            `版本 ${version} · 可更新到 ${latestVersion}`,
        update: '更新',
        progressTitle: '正在更新 Happier CLI',
        notManaged: ({ origin }: { origin: string }) => `在 Happier 之外安装：${origin}`,
    },
    cliChoice: {
        title: ({ version }: { version: string }) => `已安装 Happier CLI ${version}`,
        titleUnknownVersion: '已安装 Happier CLI',
        titleMissing: '你的 Happier CLI 已不再安装',
        body: ({ path }: { path: string }) => `它位于 ${path}。Happier 可以安装自己的副本、保持更新并放在 PATH 最前面，你也可以继续使用这个。`,
        bodyOutdated: ({ path }: { path: string }) => `它位于 ${path}，但版本太旧，无法完成设置。Happier 可以安装最新的副本并放在 PATH 最前面，你也可以保留自己的并自行更新。`,
        bodyMissing: ({ path }: { path: string }) => `你选择保留位于 ${path} 的 CLI，但它已经不在那里了。Happier 可以安装自己的副本并保持更新，你也可以重新安装你自己的并继续使用。`,
        bodyKeepBlocked: ({ path, link }: { path: string; link: string }) => `它位于 ${path}，但新终端会先通过 ${link} 运行 Happier 自己的 CLI，而这个不是 Happier 添加的。可以交给 Happier 管理命令行，或者删除 ${link} 后重新运行设置以保留你自己的。`,
        notNow: '暂不',
        manage: '交给 Happier 管理',
        keep: '保留我自己的',
        unanswered: '设置已在做出任何更改前停止。请选择由谁管理命令行以继续。',
        ownMissing: '你保留的命令行已不再安装。请重新安装，或交给 Happier 管理命令行。',
        managed: '由 Happier 管理',
        own: ({ path }: { path: string }) => `你自己的 — ${path}`,
        change: '更改命令行的管理方式',
        keptUpdateTitle: '更新你的命令行',
        keptUpdate: ({ command }: { command: string }) => `有更新的版本可用。请用 ${command} 更新`,
        oldCopyTitle: '旧的命令行',
        oldCopyRemove: ({ path, command }: { path: string; command: string }) => `仍安装在 ${path}。运行 ${command} 即可移除`,
        oldCopyPath: ({ path }: { path: string }) => `仍安装在 ${path}。`,
    },
    servers: {
        title: '这台电脑服务的 Home',
        connected: '已连接',
        offline: '已设置 · 离线',
        attention: '需要处理',
        currentHome: ({ home }: HomeParams) => `${home} · 当前 Home`,
    },
    removal: {
        uninstallFailedTitle: '无法断开这台电脑',
        uninstallFailedBody: ({ home }: HomeParams) => `无法移除这台电脑用于 ${home} 的后台服务，因此保留了 ${home}。请重试，或在“设置 › 这台电脑”中移除该服务。`,
        inventoryUnavailableTitle: '无法检查这台电脑',
        inventoryUnavailableBody: ({ home }: HomeParams) => `Happier 无法读取这台电脑的后台服务，因此无法判断这台电脑是否仍在为 ${home} 提供服务。仍要从 Happier 中移除吗？`,
        removeAnyway: '仍要移除',
        userOwnedTitle: '这台电脑会继续为其提供服务',
        userOwnedBody: ({ home, service }: RemovalServiceParams) => `${service} 是在 Happier 之外安装的，因此会继续为 ${home} 运行。如果不再需要，请在终端中移除它。`,
    },
};

const thisComputerConnectionTranslations = { zhHans };

return { thisComputerConnectionTranslations };
})();

const Domain_transcriptFindTranslations = (() => {
const transcriptFindTranslations = { 'zh-Hans': { searchOlder: '搜索较早的消息', partialErrors: '部分内容无法搜索。结果不完整。', olderRemaining: '还有较早的消息尚未搜索。', findOpen: '打开查找', findNext: '下一个匹配', findPrevious: '上一个匹配' } } as const;

return { transcriptFindTranslations };
})();

const Domain_turnChangesTranslations = (() => {
type TurnChangesTranslations = Shared_turnChangesTranslations.TurnChangesTranslations;

const en = Shared_turnChangesTranslations.en;

const translated = Shared_turnChangesTranslations.translated;

const turnChangesTranslations = { 'zh-Hans': {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `编辑了 ${count} 个文件`,
                walkThrough: '带我看一遍',
                openInFiles: '在文件中打开',
                fileCount: ({ count }) => `${count} 个文件`,
                fileCountInFolders: ({ count, folders }) => `${folders} 个文件夹中的 ${count} 个文件`,
                showMore: ({ count }) => `再显示 ${count} 个`,
                groupA11y: '本轮的更改',
            }),
        },
    } } as const;

return { turnChangesTranslations };
})();

const Domain_voiceDiagnosticsConsentTranslations = (() => {
type VoiceDiagnosticsConsentCopy = Shared_voiceDiagnosticsConsentTranslations.VoiceDiagnosticsConsentCopy;

const defineVoiceDiagnosticsConsentTranslation = Shared_voiceDiagnosticsConsentTranslations.defineVoiceDiagnosticsConsentTranslation;

const voiceDiagnosticsConsentTranslations = { 'zh-Hans': defineVoiceDiagnosticsConsentTranslation({
    consentTitle: '在此设备上录制语音？',
    consentBody: '语音音频可能包含私人对话和背景声音。文件仅保存在本设备，使用私有权限并自动过期，绝不会同步，也不会附加到分析数据或崩溃报告中。',
    consentAction: '启用录制',
  }) } as const;

return { voiceDiagnosticsConsentTranslations };
})();

const Domain_voiceDiagnosticsTranslations = (() => {

type VoiceDiagnosticsCopy = Shared_voiceDiagnosticsTranslations.VoiceDiagnosticsCopy;

const voiceDiagnosticsConsentTranslations = {...Domain_voiceDiagnosticsConsentTranslations.voiceDiagnosticsConsentTranslations};

const defineVoiceDiagnostics = Shared_voiceDiagnosticsTranslations.defineVoiceDiagnostics;

const voiceDiagnosticsTranslations = { 'zh-Hans': defineVoiceDiagnostics(voiceDiagnosticsConsentTranslations["zh-Hans"].diagnostics, {
    title: '本地语音诊断',
    footer: '默认关闭。音频会保留在所选机器上，直到你明确导出为止。',
    enabled: '录制本地诊断音频',
    enabledSubtitle: '在本地保留有限的 STT 输入和 TTS 输出，用于排查问题',
    sttInput: '录制语音识别输入',
    ttsOutput: '录制合成语音输出',
    location: '存储位置',
    unavailable: '所选机器不可用',
    retention: '保留上限',
    retentionDetail: ({ hours, files, megabytes }) => `${hours} 小时 · ${files} 个文件 · ${megabytes} MB`,
    deleteAll: '删除全部诊断音频',
    deleteAllSubtitle: '立即从所选机器移除音频和元数据',
    deleteConfirmTitle: '要删除全部本地语音诊断吗？',
    deleteConfirmBody: '这会永久移除所选机器上的所有语音诊断文件。',
    deleteAction: '全部删除',
    deleteFailed: '无法删除本地诊断录音。它们可能仍留在所选机器上。',
    cleanupRequired: '本地诊断清理需要处理',
    cleanupRequiredSubtitle: '可能还有私密诊断文件残留，或者无法读取本地目录。请重试清理，或删除全部诊断音频。',
    captureFailed: '诊断录制需要处理',
    captureFailedSubtitle: '无法读取或保存上一次诊断音频录制。未检测到残留的诊断文件；下一次符合条件的语音录制会再次检查状态。',
    retryCleanup: '重试诊断清理',
    retryCleanupSubtitle: '重新检查私密存储并再次应用其保留上限',
    cleanupRetryFailed: '清理未能完成。诊断文件可能仍留在所选机器上；等它重新连接后请重试或全部删除。',
    exportTitle: '导出所选诊断',
    noArtifacts: '所选机器上没有保留的诊断录音。',
    exportSttArtifact: '导出语音识别输入',
    exportTtsArtifact: '导出合成语音输出',
    exportArtifactAccessibility: '导出这段本地语音诊断录音',
    exportConfirmTitle: '要导出这段私密录音吗？',
    exportConfirmBody: '这会通过一次性加密传输，将所选录音从所选机器复制到本设备。它绝不会被自动上传。',
    exportAction: '导出录音',
    exportFailed: '无法导出这段私密录音。没有上传任何内容。',
    backupPolicy: '备份排除',
    backupPolicyBestEffort: '存放在所选机器的私有缓存中，并已为遵循缓存目录标准的备份工具做好标记。系统未实现任何自动上传或同步；无法保证操作系统会将其排除在备份之外。',
    activeIndicator: '语音诊断已开启',
    checkingIndicator: '正在检查语音诊断状态',
    statusUnknownIndicator: '语音诊断状态未知',
    shutdownPendingIndicator: '正在停止语音诊断',
    shutdownFailedIndicator: '无法确认语音诊断已关闭',
    retryShutdown: '重试停止诊断',
    sessionOptOut: '不要录制此会话',
    sessionOptOutConfirmTitle: '要停止录制此会话吗？',
    sessionOptOutConfirmBody: '语音诊断对其他会话仍保持启用，但在应用重启前，不会再录制此会话的新音频。',
    sessionOptOutFailed: '无法在活动机器上停止录制。此会话可能仍在录制中；等机器重新连接后请重试。',
    sessionOptOutRetry: '重试停止录制',
  }) } as const;

return { voiceDiagnosticsTranslations };
})();

const Domain_voiceExternalCredentialApprovalTranslations = (() => {
type VoiceExternalCredentialApprovalCopy = Shared_voiceExternalCredentialApprovalTranslations.VoiceExternalCredentialApprovalCopy;

const defineVoiceExternalCredentialApproval = Shared_voiceExternalCredentialApprovalTranslations.defineVoiceExternalCredentialApproval;

const voiceExternalCredentialApprovalTranslations = { 'zh-Hans': defineVoiceExternalCredentialApproval({
    reviewRequired: '检查凭据访问权限',
    recipientApprovalTitle: '允许此提供商使用你的凭据？',
    recipientApprovalBody: '请检查并批准声明的提供商端点和操作。如果该接收方约定发生变化，Happier 会保留你的选择，但会阻止使用凭据，直到你再次批准。',
    recipientApprovalPackage: ({ title, pluginId, sourceKind, sourceLocator }) =>
      `包：${title}（${pluginId}）；来源：${sourceKind} ${sourceLocator}`,
    recipientApprovalPublisher: ({ trust, identity }) => `发布者：${identity}（${trust}）`,
    recipientApprovalPackageSignature: ({ status, keyId }) => `包签名：${keyId}（${status}）`,
    recipientApprovalContribution: ({ pluginId, localId }) => `贡献：${pluginId}/${localId}`,
    recipientApprovalOperations: '已声明的操作：',
    recipientApprovalOperation: ({ id, purpose, effect }) =>
      `操作 ${id}：用途 ${purpose}；影响 ${effect}`,
    recipientApprovalRequest: ({ method, origin, pathTemplate }) => `请求：${method} ${origin}${pathTemplate}`,
    recipientApprovalCredential: ({ headerName, format }) => `凭据请求头：${headerName}；格式：${format}`,
    recipientApprovalBounds: ({ requestMaxBytes, responseMaxBytes }) =>
      `字节上限：请求 ${requestMaxBytes}；响应 ${responseMaxBytes}`,
    recipientApprovalTrust: { bundled: '内置', verified: '已验证' },
    recipientApprovalEffect: { read: '读取', mutation: '变更' },
    recipientApprovalCredentialFormat: { raw: '原始', bearer: 'bearer' },
    recipientApprovalConfirm: '批准并保存',
  }) } as const;

return { voiceExternalCredentialApprovalTranslations };
})();

const Domain_voiceLocalCredentialTranslations = (() => {
type VoiceLocalCredentialCopy = Shared_voiceLocalCredentialTranslations.VoiceLocalCredentialCopy;

const defineVoiceLocalCredential = Shared_voiceLocalCredentialTranslations.defineVoiceLocalCredential;

const voiceLocalCredentialTranslations = { 'zh-Hans': defineVoiceLocalCredential({
    voiceCredential: {
      setOnAccount: '已保存到你的账户',
      notSetOnAccount: '未保存到你的账户',
      setOnMachineOverride: ({ machine }) => `正在为 ${machine} 使用账户凭据覆盖`,
      notSetWithFallback: ({ machine }) => `未为 ${machine} 设置；可用时将使用账户凭据`,
      plainStorageTitle: '在没有端到端加密的情况下保存 API 密钥？',
      plainStorageBody: '此账户在保存设置时不使用端到端加密。保存此 API 密钥会让其明文对服务器可见。',
      plainStorageConfirm: '保存 API 密钥',
      deleteAccountBody: '要移除这个已保存的 API 密钥吗？引用同一个已保存密钥的其他绑定仍会保留它。',
      machineUnavailable: '请选择一台在线的语音执行机器',
      machineUnavailableTitle: '语音机器不可用',
      machineUnavailableBody: '在保存或使用此凭据之前，请选择一台在线的语音执行机器。',
      statusUnavailable: ({ machine }) => `无法获取 ${machine} 上的凭据状态。点按可重试。`,
      importAvailable: ({ machine }) => `有旧密钥可导入到 ${machine}`,
      notSetOnMachine: ({ machine }) => `未在 ${machine} 上设置`,
      setOnMachine: ({ machine, protection }) => `已在 ${machine} 上设置 · ${protection}`,
      protection: { osProtected: '受操作系统保护', filePermissions: '受文件权限保护' },
      importTitle: '要导入现有的 API 密钥吗？',
      importBody: ({ machine }) => `将现有的加密账户设置复制到 ${machine}。原件仍可供你的其他设备使用。`,
      importAction: '导入',
      enterNewAction: '输入新密钥',
      useSavedSecretTitle: '使用已保存的密钥',
      useSavedSecretSubtitle: '选择此账户中已保存的密钥。',
      replaceOrRemoveBody: '输入替换用的 API 密钥，或留空以从这台机器移除该密钥。',
      deleteTitle: '要移除 API 密钥吗？',
      deleteBody: ({ machine }) => `要从 ${machine} 移除此 API 密钥吗？旧的跨设备值（如有）不会被更改。`,
      operationFailed: '所选机器无法更新此凭据。请确认它处于在线状态后重试。',
      newCredentialRequired: ({ machine }) => `${machine} 上需要新的机器凭据`,
    },
    openAiCompatEndpoint: {
      executionMachine: ({ machine }) => `请求在 ${machine} 上运行。Localhost 指的是那台机器。`,
      insecureTitle: '允许不安全的本地 HTTP？',
      insecureBody: ({ origin, machine }) => `允许从 ${machine} 通过 HTTP 向 ${origin} 发送凭据吗？Localhost 指的是 ${machine}。仅接受回环地址和私有网络地址；公网 HTTP 会被拒绝。`,
      allowAction: '允许 HTTP',
      invalidBody: '请输入 HTTPS URL，或不含用户名、密码和查询字符串的 HTTP 回环／私有网络 URL。',
    },
  }) } as const;

return { voiceLocalCredentialTranslations };
})();

const Domain_voiceMomentsTranslations = (() => {
type VoiceMomentsTranslation = Shared_voiceMomentsTranslations.VoiceMomentsTranslation;

const voiceMomentsTranslations = { 'zh-Hans': {
        setupTitle: '设置语音',
        setupTileSubtitle: '大声和你的会话交谈。四个简短步骤。',
        setupTileProgress: ({ done, total, next }) => `已完成 ${done}/${total} · ${next}`,
        setupNextService: '下一步：选择谁来聆听',
        setupNextReadiness: '下一步：完成服务设置',
        setupNextMicrophone: '下一步：允许麦克风',
        setupNextTry: '下一步：试一试',
        setupNextInstalling: '正在安装',
        setupStart: '设置',
        setupContinue: '继续',
        setupDescription: '大声和你的会话交谈：询问进展、开始工作、随时随地做决定。四个步骤，可以中途离开再回来。',
        setupLightCaption: ({ done, total }) => `已就绪 ${done}/${total}`,
        setupServiceTitle: '选择谁来聆听',
        setupServiceDetail: '聆听并回应你的服务。之后可以更改。',
        setupChange: '更改',
        setupReadinessTitle: ({ service }) => `完成 ${service} 的设置`,
        setupReadinessDone: ({ service }) => `${service} 已就绪`,
        setupReadinessGeneric: '服务',
        setupReadinessTitleGeneric: '准备好服务',
        setupReadinessUnknown: '打开设置，查看还缺少什么。',
        setupReadinessCheck: '检查设置',
        setupMicrophoneTitle: '允许麦克风',
        setupMicrophoneDetail: '设备只会询问一次。Happier 仅在语音开启时聆听，你随时都能看到。',
        setupMicrophoneAction: '允许麦克风',
        setupMicrophoneDone: '已允许麦克风',
        setupMicrophoneDeniedTitle: 'Happier 的麦克风已关闭',
        setupMicrophoneDeniedDetail: '在系统设置中开启后回到这里。',
        setupOpenSystemSettings: '打开设置',
        setupTryTitle: '试一试',
        setupTryDetail: '问一句“我的会话在做什么？”你的话会像普通消息一样出现在对话里。',
        setupTryAction: '试一试',
        setupTryDone: '已试过',
        setupTryNeedsService: '服务就绪后即可使用。',
        setupDoneTitle: '语音已就绪',
        setupDoneBody: '在任意聊天中轻点语音按钮开始说话，再点一次结束。说话时，静音就在结束旁边。',
        setupGestureTap: '轻点',
        setupGestureStartEnd: '开始 · 结束',
        setupGestureAnywhere: '随处开始 · 结束',
        setupDoneAction: '完成',
        setupSettingsAction: '语音设置',
        setupClose: '关闭',
        needsYouEnded: '语音已结束。收件箱中仍有待批准的请求。',
        needsYouReview: '查看请求',
        needsYouTapToDecide: '已朗读 · 请在此处决定，而不是用语音',
        briefMe: '给我简报',
        briefMeA11y: '给我简报：语音会读出需要你处理、失败和已就绪的内容',
        briefNeedsYou: '需要你',
        briefFailed: '失败',
        briefReady: '已就绪',
        briefIncomplete: '部分工作尚未加载，这里可能不完整。',
        briefCaughtUp: '目前没有需要你处理的事。',
        briefNotSpoken: '语音暂时无法朗读。完整列表都在这里。',
        briefStop: '停止',
        continueTitle: '在这里继续交谈',
        continueDetail: ({ device }) => `你之前在 ${device} 上交谈`,
        continueAction: '继续',
        continuedOn: ({ device }) => `已在 ${device} 上继续`,
        continuedElsewhere: '已在另一台设备上继续',
        continuedHere: '已在此设备上继续',
        dismiss: '忽略',
    } } satisfies Pick<Readonly<Record<string, VoiceMomentsTranslation>>, "zh-Hans">;

return { voiceMomentsTranslations };
})();

const Domain_voicePresenceTranslations = (() => {
type VoicePresenceTranslation = Shared_voicePresenceTranslations.VoicePresenceTranslation;

const voicePresenceTranslations = { 'zh-Hans': {
        welcomeText: "你好，我在听。你想做什么？",
        greetingLiteralUnavailable: "使用此回复语言时，服务会等待你先开口。",
        title: '语音',
        howYouTalk: "说话方式",
        holdToTalkTitle: "按住说话",
        holdToTalkDescription: "按住 Voice 标记说一句话，松开发送。点按仍可开始和结束 Voice。",
        holdToTalkHint: "按住说一轮，松开发送。拖动可取消。",
        holdToTalkUnavailable: ({ service }) => `${service} 不支持按住说话。请改用点按说话。`,
        talkWithVoice: '用语音交谈',
        dictate: '听写',
        globalVoice: '全局语音',
        interrupt: '打断',
        options: '语音选项',
        you: '你',
        showConversation: '显示对话',
        dragToMove: '拖动以移动',
        openConversation: '打开对话',
        settings: '语音设置',
        ended: '语音已结束',
        muted: '已静音',
        setUp: '设置语音',
        setUpHint: '打开语音设置，选择语音的说话方式',
        startAgain: '重新开始',
        endedCaption: ({ elapsed }) => `${elapsed} · 对话已保存`,
        dismiss: '关闭',
        mute: "静音",
        unmute: "取消静音",
        end: "结束",
        captions: { connecting: "正在打开音频通道", listening: "请说", transcribing: "正在转成文字", thinking: "正在思考回答", speaking: "你可以随时打断", interrupted: "请说", muted: "取消静音即可说话 · 语音仍可说话", reconnecting: "连接中断 · 正在重试", blocked: "允许访问麦克风即可说话", failed: "请重试，或检查语音设置" },
        recovery: { allow: "允许", setUp: "设置" },
        containerA11y: ({ status }) => `语音，${status}`,
    } } satisfies Pick<Readonly<Record<string, VoicePresenceTranslation>>, "zh-Hans">;

return { voicePresenceTranslations };
})();

const Domain_voiceProviderPrivacyTranslations = (() => {
const voiceProviderPrivacyTranslations = { 'zh-Hans': {
    openai: {
      privacyDisclosure: '音频和对话内容会通过 WebRTC 从此设备发送到 OpenAI。启用或使用相应功能时，OpenAI 还可能从此设备接收有限的 Voice 上下文更新、客户端工具调用及其结果。Happier 使用所选的已保存 Voice API 密钥、OpenAI 已连接服务或实验性 Codex OAuth 账户来获取短期客户端身份验证；已连接账户通过所选机器使用。OpenAI 会在所选账户下处理实时对话，并可能根据该账户设置和 OpenAI 条款保留收到的数据。Happier 的服务器和中继不承载实时音频。Voice 上下文共享控制与此提供商处理相互独立。',
    },
    xai: {
      privacyDisclosure: '音频和对话内容会通过 xAI Realtime 连接从此设备发送到 xAI。启用或使用相应功能时，xAI 还可能从此设备接收有限的 Voice 上下文更新、客户端工具调用及其结果。Happier 仅将保存在 Happier 账户密钥中的 xAI API 密钥用于有限的客户端身份验证和语音目录操作。xAI 会在该账户下处理实时对话，并可能根据账户设置和 xAI 条款保留收到的数据。启用续接后，Happier 会保存提供商对话标识符；忘记操作只会移除 Happier 保存的标识符，不会删除 xAI 持有的数据。Happier 的服务器和中继不承载实时音频。Voice 上下文共享控制与此提供商处理相互独立。',
    },
    speechProcessing: {
      deviceStt: '音频由浏览器或操作系统的语音识别服务处理。根据平台和已配置的服务，处理可能在设备外进行。',
      deviceTts: '回复文本由浏览器或操作系统的语音合成服务处理。根据平台和已配置的服务，处理可能在设备外进行。',
    },
    fields: {
      resumption: {
        title: '保存 xAI 续接标识符',
        subtitle: '允许 Happier 保存 xAI 的短期提供商对话标识符，以便重新连接。',
      },
    },
    resumption: {
      confirmTitle: '保存 xAI 续接标识符？',
      confirmBody: 'Happier 会将 xAI 的提供商对话标识符保存最多 {minutes} 分钟，以便重新连接中断的对话。这不会更改或删除 xAI 持有的数据。',
      confirmAction: '保存标识符',
      forgetTitle: '忘记 Happier 续接标识符',
      forgetSubtitle: '移除 Happier 保存的提供商对话标识符。这不会删除对话或 xAI 持有的数据。',
      forgotten: 'Happier 已移除保存的提供商对话标识符。',
      unsupported: 'Happier 无法从此会话中移除保存的提供商对话标识符。',
      failed: 'Happier 无法移除保存的提供商对话标识符。请重试。',
    },
  } } as const;

return { voiceProviderPrivacyTranslations };
})();

const Domain_voiceReadinessTranslations = (() => {
type VoiceReadinessCopy = Shared_voiceReadinessTranslations.VoiceReadinessCopy;

const defineVoiceReadinessTranslation = Shared_voiceReadinessTranslations.defineVoiceReadinessTranslation;

const voiceReadinessTranslations = { 'zh-Hans': defineVoiceReadinessTranslation({
    ready: '语音功能已就绪。',
    permissionAnnouncement: ({ summary }) => `编码会话需要获得以下权限：${summary}。请在会话界面中审核并批准或拒绝。`,
    userActionAnnouncement: ({ question }) => `编码会话需要你的回答。${question}`,
    userActionFallback: '编码会话需要你的回答。请回答问题，以便我继续。',
    requestedTool: '请求的工具',
    provider_unselected: '请选择语音提供商。',
    contribution_unavailable: '此语音提供商已不可用。',
    role_unsupported: '此提供商不支持所选语音模式。',
    platform_unsupported: '此平台无法使用该语音提供商。',
    settings_unsupported_version: '请先更新此提供商，再将其用于语音功能。',
    settings_unknown: '无法检查提供商设置。',
    settings_needs_migration: '请检查此提供商更新后的设置。',
    settings_invalid: '请检查无效的提供商设置。',
    settings_missing_required_setting: ({ service }) => `完成 ${service} 的设置即可开始。`,
    provider_mode_unknown: '请为此提供商选择受支持的模式。',
    server_feature_disabled: '服务器已禁用此语音提供商。',
    server_feature_installing: '服务器正在准备语音支持。',
    server_feature_incompatible: '服务器与此语音提供商不兼容。',
    server_feature_unknown: '无法检查服务器是否支持此语音提供商。',
    execution_machine_missing: '请选择一台可以运行此语音提供商的机器。',
    execution_machine_installing: '所选语音执行机器仍在准备中。',
    execution_machine_incompatible: '所选机器与此语音提供商不兼容。',
    execution_machine_unknown: '无法检查语音执行机器。',
    daemon_unreachable: '所选机器没有可用的语音音频路由。',
    daemon_relay_disabled: '所选机器需要语音音频中继，但中继已被禁用。',
    daemon_relay_capped: '所选机器当前无法使用语音音频中继容量。',
    credential_missing: '请添加此语音提供商所需的凭据。',
    credential_approval_required: '请先检查凭据访问权限，再使用此语音提供商。',
    credential_installing: '提供商凭据仍在准备中。',
    credential_incompatible: '所选凭据与此语音提供商不兼容。',
    credential_unknown: '无法检查提供商凭据。',
    endpoint_missing: '请配置此语音提供商所需的端点。',
    endpoint_installing: '语音提供商端点仍在准备中。',
    endpoint_incompatible: '配置的端点与此语音提供商不兼容。',
    endpoint_unknown: '无法检查语音提供商端点。',
    runtime_missing: '请安装此语音提供商所需的运行时。',
    runtime_installing: '语音提供商运行时仍在安装中。',
    runtime_incompatible: '已安装的运行时与此语音提供商不兼容。',
    runtime_unknown: '无法检查语音提供商运行时。',
    model_missing: '请为此语音提供商安装或选择模型。',
    model_installing: '所选语音模型仍在安装中。',
    model_incompatible: '所选模型与此语音提供商不兼容。',
    model_unknown: '无法检查语音提供商模型。',
    device_stt_unavailable: '此设备无法使用语音识别。',
    device_stt_availability_unknown: '仍在检查语音识别是否可用。',
    short: {
      needsSetup: '需要设置',
      needsKey: '需要密钥',
      needsApproval: '需要你的批准',
      offOnServer: '此服务器已关闭',
      needsComputer: '需要电脑',
      needsAddress: '需要地址',
      needsModel: '需要模型',
      installing: '正在安装',
      notInstalled: '未安装',
      unavailableHere: '此处不可用',
      needsUpdate: '需要更新',
      cantCheck: '尚未检查',
    },
    actions: {
      select_provider: '选择提供商',
      open_provider_settings: "完成设置",
      select_execution_machine: '选择机器',
      configure_credential: '添加凭据',
      review_credential_access: '检查凭据访问权限',
      configure_endpoint: '配置端点',
      install_model: '安装模型',
      switch_provider: '选择其他提供商',
    },
  }) } as const;

return { voiceReadinessTranslations };
})();

const Domain_voiceRealtimeProviderSetupTranslations = (() => {

type TitleSubtitle = Shared_voiceRealtimeProviderSetupTranslations.TitleSubtitle;

type PromptField = Shared_voiceRealtimeProviderSetupTranslations.PromptField;

type VoiceRealtimeProviderSetupCopy = Shared_voiceRealtimeProviderSetupTranslations.VoiceRealtimeProviderSetupCopy;

const voiceProviderPrivacyTranslations = {...Domain_voiceProviderPrivacyTranslations.voiceProviderPrivacyTranslations, ...EnglishFeatures.voiceProviderPrivacyTranslations.voiceProviderPrivacyTranslations};

const defineVoiceRealtimeProviderSetup = Shared_voiceRealtimeProviderSetupTranslations.defineVoiceRealtimeProviderSetup;

const voiceRealtimeProviderSetupTranslations = { 'zh-Hans': defineVoiceRealtimeProviderSetup(voiceProviderPrivacyTranslations["zh-Hans"], {
    xai: {
      setup: { footer: '你的 xAI API 密钥以同步的已保存密钥形式存放在 Happier 账户密钥中，只在受限的 xAI Realtime 操作中才会被取出使用。' },
      credential: { promptBody: '粘贴 xAI API 密钥。Happier 会把它作为同步的已保存密钥加以保护，只在受限的 xAI Realtime 操作中才会取出使用。' },
    },
    setup: {
      title: '实时语音设置',
      footer: '你的 API 密钥保存在所选执行机器上，绝不会写入同步的语音设置。',
    },
    credential: {
      title: '已保存的 API 密钥',
      promptTitle: '连接实时语音',
      promptBody: '粘贴 OpenAI Platform API 密钥。它会受同步账户密钥保护，只在签发短期 Realtime 客户端凭据时才会取出使用。',
    },
    authentication: {
      sectionTitle: 'OpenAI Realtime 身份验证',
      title: '身份验证来源',
      subtitle: '请只选择一个来源。Happier 绝不会退回到其他密钥或账户。',
      footer: 'OpenAI Realtime API 的用量由 OpenAI Platform 计费。ChatGPT 或 Codex 订阅并不代表拥有 Realtime API 的计费或访问权限。传递给 WebRTC 对话的只有短期客户端凭据。',
      savedSecret: {
        title: '已保存的语音 API 密钥',
        subtitle: '使用保存在 Happier Voice 账户密钥中的 API 密钥。无需守护进程。',
      },
      openAiApiKey: {
        title: 'OpenAI 已连接服务',
        subtitle: '通过所选机器及其已连接的守护进程，使用选定的标准 OpenAI API 密钥配置或账户组。',
      },
      openAiCodex: {
        title: 'OpenAI Codex OAuth（实验性）',
        subtitle: '通过所选机器及其已连接的守护进程，使用选定的 Codex OAuth 配置或账户组。Happier 绝不会退回到其他密钥或账户。',
      },
      account: {
        title: '已连接账户',
        subtitle: '选择下一次对话所使用的具体配置或账户组。',
      },
      chooseAccount: '选择账户',
      referenceRequired: '请选择一个已连接的配置或账户组。',
      connected: '已连接账户就绪',
      unavailable: '所选账户不可用或需要重新连接',
    },
    invalidValue: '此提供商不支持该值。',
    advanced: { show: '显示高级设置', hide: '隐藏高级设置' },
    fields: {
      model: { title: '模型', subtitle: '选择实时语音模型。' },
      voice: { title: '语音', subtitle: '选择用于回复的语音。' },
      instructions: {
        title: '语音指令',
        subtitle: '可选的行为与个性指令。',
        promptTitle: '语音指令',
        promptBody: '为这次语音会话输入可选指令。',
      },
      turnDetection: {
        title: '话轮检测',
        subtitle: '选择提供商如何判断你说完了。',
        threshold: {
          title: 'VAD 阈值',
          subtitle: '语音活动灵敏度；留空则使用提供商默认值。',
          promptTitle: 'VAD 阈值',
          promptBody: '请输入 0.1 到 0.9 之间的值，或留空。',
        },
        silenceDurationMs: {
          title: '静音时长',
          subtitle: '结束一轮发言前需要的静音毫秒数。',
          promptTitle: '静音时长',
          promptBody: '请输入 0–10000 毫秒，或留空。',
        },
        prefixPaddingMs: {
          title: '语音前置留白',
          subtitle: '在检测到语音之前保留的毫秒数。',
          promptTitle: '语音前置留白',
          promptBody: '请输入 0–10000 毫秒，或留空。',
        },
        idleTimeoutMs: {
          title: '空闲回复超时',
          subtitle: '可选：静音达到此时长后，请 xAI 主动开始回复。',
          promptTitle: '空闲回复超时',
          promptBody: '请输入 1–600000 毫秒，或留空以关闭自动空闲回复。',
          confirmTitle: '要启用自动空闲回复吗？',
          confirmBody: '在设定的静音之后，xAI 可能会主动生成回复并消耗 API 用量。',
          confirmAction: '启用',
        },
      },
      transcriptionModel: {
        title: '转写模型',
        subtitle: '可选的输入转写模型。',
        promptTitle: '转写模型',
        promptBody: '请输入模型 id，或留空以使用提供商默认值。',
      },
      reasoning: { title: '推理', subtitle: '为支持的模型选择推理强度。' },
      outputSpeed: {
        title: '语速',
        subtitle: '调整提供商的说话速度。',
        promptTitle: '语速',
        promptBody: '请输入 0.7 到 1.5 之间的值。',
      },
      languageHint: {
        title: '语言提示',
        subtitle: '可选：帮助转写识别你使用的语言。',
        promptTitle: '语言提示',
        promptBody: '请选择一种受支持的语言。',
      },
      keyterms: {
        title: '关键术语',
        subtitle: '希望转写能够识别的人名和领域术语。',
        promptTitle: '关键术语',
        promptBody: '最多输入 100 个术语，用逗号或换行分隔。',
      },
    },
    options: {
      pinned: '固定版本',
      movingAlias: '自动跟随提供商更新',
      automatic: '自动',
      custom: '自定义…',
      server_vad: '服务端语音活动检测',
      semantic_vad: '语义话轮检测',
      manual: '手动',
      high: '高',
      none: '无',
    },
    catalog: {
      credentialRequired: '添加 API 密钥以加载语音',
      retry: '无法加载语音 — 重试',
      empty: '此账户没有可用的语音',
      preview: ({ voice }) => `试听 ${voice}`,
    },
    movingAlias: {
      confirmTitle: '要跟随最新模型吗？',
      confirmBody: '浮动模型别名会在提供商更新时改变行为。你随时可以切回固定版本。',
      confirmAction: '使用最新版',
    },
    links: {
      title: '提供商资源',
      account: { title: '打开提供商账户', subtitle: '管理你在提供商处的账户。' },
      apiKeys: { title: '打开 API 密钥', subtitle: '创建、轮换或吊销提供商的 API 密钥。' },
      privacy: { title: '提供商隐私政策', subtitle: '了解提供商如何处理语音数据。' },
    },
    disconnect: {
      title: '断开实时语音',
      subtitle: '从所选机器移除此提供商的 API 密钥。',
      confirmTitle: '要断开此提供商吗？',
      confirmBody: '这会从所选执行机器移除已保存的 API 密钥。',
    },
    unavailable: {
      title: '实时语音不可用',
      rowTitle: '无法加载设置',
      provider: '提供商的插件不可用或不兼容。',
      invalid: '已保存的提供商设置无效。',
      needs_migration: '这些设置需要先完成受支持的迁移才能编辑。',
      unsupported_version: '这些设置由更新版本的 Happier 写入。',
    },
  }) } as const;

return { voiceRealtimeProviderSetupTranslations };
})();

const Domain_voiceSettingsPagesTranslations = (() => {
type VoiceSettingsPagesCopy = Shared_voiceSettingsPagesTranslations.VoiceSettingsPagesCopy;

const en = Shared_voiceSettingsPagesTranslations.en;

const zhHans: VoiceSettingsPagesCopy = {
  pages: {
    search: {
      chooseService: '选择一项服务以更改此设置。',
      select: ({ choice, control }) => `在“${control}”中选择“${choice}”以更改此设置。`,
    },
    hub: {
      description: '大声和你的代理交谈，并在任何消息中听写。',
      modesTitle: '两种使用语音的方式',
      moreTitle: '更多',
      dictationPurpose: '输入框中的麦克风会把你的话变成可编辑的文字',
      summarySessionSummaries: '会话摘要',
      summaryRecentMessages: ({ count }) => `最近 ${count} 条消息`,
      summaryNothingShared: '对话开始时不共享任何内容',
      summaryRemembers: 'Voice 代理会记住过去的对话',
      summaryForgets: 'Voice 代理在每次对话后遗忘',
      summaryVoiceComputer: ({ machine }) => `Voice 电脑：${machine}`,
      summaryTranscript: '对话时显示转写',
    },
    pipeline: {
      hear: '听',
      think: '想',
      speak: '说',
      write: '写',
      ready: '已就绪',
      oneStepNeedsYou: '有一个步骤需要你处理',
      stepsNeedYou: ({ count }) => `有 ${count} 个步骤需要你处理`,
      waiting: '等待中',
      working: '进行中',
      notChecked: '尚未检查',
      off: '已关闭 · 听写仍可使用',
      onMachine: ({ machine }) => `在 ${machine} 上`,
      onVoiceComputer: '在你的 Voice 电脑上',
      inTheCloud: '在服务的云端，从此设备发起',
      inTheSession: '会话自己的代理在转写中回答',
      intoYourMessage: '发送前由你检查',
      messageLanguage: ({ language }) => `语言：${language}`,
      languageAutomatic: '自动',
      onThisDevice: '在此设备上',
      needsYou: '需要你处理',
      voiceAgentFollowsSession: 'Voice 代理 · 跟随会话',
      theSessionYoureIn: '你所在的会话',
      intoYourMessageTitle: '写入你的消息',
    },
    privacy: {
      localAudio: "你的设备或 Voice 电脑",
      localProcessor: "你选择的语音模型",
      localRetention: "由设备或运行环境管理。诊断录音遵循你的录音设置。",
      localDisclosure: "所选语音模型在你的设备或 Voice 电脑上运行。Voice 历史和诊断录音在本页分别设置。",
      audioTitle: "音频发送至",
      processorTitle: "处理方",
      retentionTitle: "保留方式",
      messagesUnit: "条消息",
      secondsUnit: "秒",
      servicePolicy: "遵循服务账户的设置和条款。",
      noMicrophoneAudio: "不发送麦克风音频；仅发送回复文本。",
      yourEndpoint: "你配置的端点",
      endpointOperator: "你的端点运营方",
      endpointPolicy: "遵循端点的数据保留政策。",
      deviceAudio: "设备的语音服务",
      deviceProcessor: "设备或其语音服务",
      devicePolicy: "遵循设备的语音设置和条款。",
      description: '你的语音服务能听到和读取什么，以及 Happier 保留什么。',
      whereTitle: '你的声音现在去往何处',
      whereDescription: '随所选服务而变化。',
      startTitle: '对话开始时',
      startDescription: '语音服务能读取你工作中的哪些内容。',
      screenTitle: '屏幕上的内容',
      screenDescription: '你正在查看的会话或页面。',
      screenNever: '从不',
      screenWhenAsked: '被要求时',
      screenAlways: '始终',
      summariesTitle: '会话摘要',
      recentTitle: '你最近的消息',
      recentDescription: '它请求上下文时，会话中最近的消息。',
      recentCountTitle: '共享的消息数',
      recentCountDescription: "",
      recentCountUnavailable: '打开“你最近的消息”后可更改。',
      toolsTitle: '工具名称',
      toolsDescription: '例如“已编辑文件”。参数和文件路径从不共享。',
      permissionsTitle: '权限请求',
      permissionsDescription: '让它告诉你什么需要你处理。批准仍需你点按。',
      devicesTitle: '你的机器和设备',
      devicesDescription: '名称和在线状态，用于在你指定的位置启动会话。',
      liveTitle: '你说话时',
      liveDescription: '对话期间会话发生变化时发送的更新。',
      liveActiveTitle: '来自你所在的会话',
      liveOtherTitle: '来自你的其他会话',
      liveNothing: '不发送',
      liveActivity: '活动',
      liveSummaries: '摘要',
      liveMessages: '消息',
      livePerUpdateTitle: '每次更新的消息数',
      liveIncludeMineTitle: '包含你写的内容',
      liveIncludeMineDescription: '关闭：只发送代理一方的内容。',
      liveMessagesUnavailable: '在上方为某个会话选择“消息”后可更改。',
      liveOtherModeTitle: '其他会话的消息',
      liveOtherModeNever: '从不',
      liveOtherModeWhenAsked: '被要求时',
      liveOtherModeAutomatically: '自动',
      liveOtherModeUnavailable: '为其他会话选择“消息”后可更改。',
      memoryTitle: 'Voice 代理的记忆',
      memoryDescription: '仅适用于使用 Voice 代理的本地语音。',
      rememberTitle: '记住过去的对话',
      rememberOnDescription: '从你上次离开的地方继续。',
      rememberOffDescription: '关闭：挂断后全部遗忘。',
      restoreTitle: '恢复记忆的方式',
      restoreRecent: '最近的消息',
      restoreSummary: '摘要 + 最近',
      restoreResume: '恢复代理',
      restoreUnavailable: '打开“记住”后可选择。',
      restoreResumeFeatureOff: '恢复需要此服务器开启 Voice 代理。',
      restoreResumeAgentCannot: '此代理无法恢复过去的对话。',
      fallbackTitle: '恢复失败时重放消息',
      fallbackDescription: '从你最近的消息开始，而不是从零开始。',
      restoreCountTitle: '要恢复的消息数',
      restoreCountDescription: "",
      forgetTitle: '立即全部遗忘',
      forgetDescription: '重新开始 Voice 代理。你的会话不受影响。',
      forgetAction: '遗忘',
      moreTitle: '更多',
    },
    dictation: {
      description: '输入框中的麦克风会把你的话变成发送前可编辑的文字。',
      engineTitle: '语音引擎',
      engineDescription: '每个引擎都会说明你的音频去往何处。',
      sameAsConversations: '与语音对话相同',
      sameAsConversationsUses: ({ engine }) => `使用 ${engine}，与你的语音对话相同。`,
      languageTitle: '语言',
      dictateInTitle: '我听写使用的语言',
      dictateInDescription: '自动会使用引擎的默认语言。它不跟随你的对话语言。',
      pipelinePurpose: '即使关闭语音对话也能使用',
    },
    conversations: {
      description: '大声和你的代理交谈，手放在键盘上也可以。',
      serviceTitle: '服务',
      serviceDescription: '谁来听、思考和说话。你可以随时切换，每个服务都保留自己的设置。',
      offDescription: '不使用语音对话。听写仍可使用。',
      serviceReady: '已就绪',
      accountTitle: '账户',
      accountDescription: '两种情况都是同一个服务，只是付费方不同。',
      payWithTitle: '付费方式',
      happierBillingUnavailable: "此服务器不支持 Happier 计费。",
      turnOnVoiceAgent: "启用语音代理",
      payWithHappierDescription: '由你的 Happier 套餐支付，无需自己的账户。',
      payWithOwnDescription: '你使用自己在该服务的账户和 API 密钥。',
      runsOn: '运行于',
      hearTitle: '听',
      hearDescription: '在回答之前，你的话如何变成文字。',
      speechRecognitionTitle: '语音识别',
      handsFreeUnsupported: '免提需要此设备上的语音识别或 Happier 语音模型。',
      handsFreeTimingUnavailable: '打开免提后可更改。',
      interruptTitle: '说话即可打断',
      interruptDescription: '在回复时说话会使其停止。',
      talkToTitle: '交谈对象',
      talkToSession: '会话',
      talkToSessionDescription: '你直接对所在的会话说话，由它自己的代理回答。',
      talkToAgent: 'Voice 代理',
      talkToAgentDescription: 'Voice 代理会读取你的会话并替你操作。',
      agentFeatureRequired: ({ feature }) => `在设置 → 功能中启用${feature}。实验性功能还需要开启实验。`,
      itMayTitle: '它可以',
      itMayReadOnly: '只读',
      itMayReadOnlyDescription: '它读取你的会话和文件，不做任何更改。',
      itMayAsk: '先询问',
      itMayAskDescription: '每次更改都会先询问你。口头说“是”从不算批准，需要你点按。',
      itMaySafe: '安全更改',
      itMaySafeDescription: '它会自行进行安全的工作区更改，其余会先询问。',
      itMayAnything: '任何操作',
      itMayAnythingDescription: '它可以不经询问进行任何更改。',
      repliesTitle: '回复',
      repliesShort: '简短',
      repliesBalanced: '均衡',
      thinkTitle: '想',
      thinkDescription: '你说的话会被如何处理。',
      advancedAgentTitle: '高级代理行为',
      advancedAgentDescription: 'Voice 代理如何启动、等待和回答。默认设置适合大多数人。',
      memoryLinkTitle: '记忆与恢复',
      memoryLinkDescription: '是否记住过去的对话在“隐私与数据”中设置。',
      speakTitle: '说',
      speakDescription: '回复如何被朗读。',
      voiceEngineTitle: '语音合成引擎',
      languageTitle: '语言',
      languageDescription: '每种语言对所选服务的影响。',
      iSpeakTitle: '我说的语言',
      iSpeakDescription: '帮助它听懂你。自动会每次检测。',
      replyInTitle: '回复语言',
      replyInDescription: '即使你切换语言，回答也使用这种语言。',
      replySame: '与我说的相同',
      iSpeakAutomatic: '自动',
      iSpeakEngineDescription: ({ engine }) => `帮助 ${engine} 听懂你。在“听”中的语音识别里设置。`,
      voiceTitle: '声音',
      voiceDescription: ({ engine }) => `来自 ${engine}，“说”中的引擎。`,
      voiceDefault: '默认',
      voiceDevice: '此设备的声音',
      voiceInEngine: '在“说”中设置',
      languageServiceDescription: '你的语音服务回答所用的语言。',
      languageAutomaticDescription: '语音服务会检测你所说的语言。',
      languageEngineDefault: '引擎默认值',
      languageCoupledDescription: '语音服务使用同一种语言进行识别和回复。',
      greetingTitle: '问候',
      greetingOff: '关闭',
      greetingRightAway: '立即',
      greetingAfterISpeak: '在我说话后',
      greetingOffDescription: '等你先开口。',
      greetingRightAwayDescription: '对话一开始就打招呼。',
      greetingAfterISpeakDescription: '在第一次回复中打招呼。',
      languageManagedDescription: '语言由你的语音服务决定。',
      languageServiceDefault: '服务默认值',
    },
    advanced: {
      description: '语音在哪里运行、如何在屏幕上显示，以及使用哪些语音模型。',
      onScreenTitle: '屏幕显示',
      onScreenDescription: '进行中的对话如何显示。',
      showLiveAsTitle: '实时 Voice 显示为',
      showLiveAsDescription: '仅此设备。Companion 中的 Voice 部分在所有模式下都保留。',
      scopeTitle: '对话开始于',
      scopeGlobal: '我的所有会话',
      scopeGlobalDescription: '一个助手处理所有事情。',
      scopeSession: '打开的会话',
      scopeSessionDescription: '在你打开的会话中开始。',
      transcriptTitle: '对话时显示转写',
      transcriptDescription: '你和代理说的话会随对话出现。',
      autoOpenTitle: '对话开始时打开',
      autoOpenDescription: '关闭：自己从对话中打开。',
      autoOpenUnavailable: '打开“显示转写”后可选择。',
      computerTitle: 'Voice 电脑',
      speechModelsTitle: '语音模型',
      speechModelsNeedComputerTitle: '需要 Voice 电脑',
      speechModelsNeedComputer: '请先在上方选择一台 Voice 电脑，以安装和管理它的语音模型。',
      computerDescription: '运行语音模型并为语音登录关联账户的电脑。在你的所有设备间共享。',
      connectionTitle: '连接',
      timeoutTitle: '语音请求超时放弃',
      timeoutDescription: "用于端点和语音模型。",
    },
  },
};

const voiceSettingsPagesTranslations = { 'zh-Hans': zhHans } as const satisfies Pick<Record<string, VoiceSettingsPagesCopy>, "zh-Hans">;

return { voiceSettingsPagesTranslations };
})();

const Domain_walkthroughProgressTranslations = (() => {
type Parts = Shared_walkthroughProgressTranslations.Parts;

const walkthroughProgressTranslations = { 'zh-Hans': { parts: ({ completed, total, admitted }: Parts) => `${completed}/${total} 部分已完成 · ${admitted} 已接收`, merge: '正在整合导览…', titleEdited: '标题已编辑', changed: '已更改', moved: '已移动', filesReadUnavailable: '文件读取进度不可用' } };

return { walkthroughProgressTranslations };
})();

const Domain_walkthroughSavedTranslations = (() => {
type SavedCopy = Shared_walkthroughSavedTranslations.SavedCopy;

const en = Shared_walkthroughSavedTranslations.en;

const walkthroughSavedTranslations = { 'zh-Hans': { edit: '编辑导览', title: '导览标题', stopTitle: '步骤标题', prose: '说明', refine: '优化', instructions: '需要更改什么？', moveUp: '上移', moveDown: '下移', mergeNext: '与下一步骤合并', addSummary: '添加摘要', addCommitPlan: '提议提交', updated: '已更新保存的结果', conflict: '此导览已在其他地方更改。草稿已保留。请加载最新版本并检查，然后再次保存。', reload: '加载最新版本', missingStop: "最新导览中已没有此步骤。草稿已保留，请选择其他步骤以继续。", applicationLocked: '正在应用提交。编辑已暂停。' } } satisfies Pick<Record<string, SavedCopy>, "zh-Hans">;

return { walkthroughSavedTranslations };
})();

const Domain_walkthroughSettingsTranslations = (() => {
type Copy = Shared_walkthroughSettingsTranslations.Copy;

const en = Shared_walkthroughSettingsTranslations.en;

const copy = Shared_walkthroughSettingsTranslations.copy;

const walkthroughSettingsTranslations = { 'zh-Hans': copy({
        title: '变更导览',
        description: '由 AI 编写的阅读顺序，在具体变更旁提供解释，并可选择生成提交建议。在存有代码的机器上运行。',
        enabled: '解释变更',
        enabledDescription: '为比较添加阅读顺序和解释。没有模型时仍可查看文件。',
        model: '摘要模型',
        modelDescription: '用于生成解释、变更导览和提交建议。',
        chooseModel: '选择模型',
        unsupported: '无法编写变更导览',
        unavailable: '模型不可用。请选择其他模型。',
        prefetch: '每轮结束后准备',
        prefetchDescription: '代理完成一轮工作后准备变更导览。',
        saved: '已保存的导览',
        savedDescription: '保存在此机器上，包含你的编辑。',
        clear: '清除',
        unavailableData: '请重新连接机器，以加载已保存的导览和费用。',
        costUnavailable: '过去7天 · 费用不可用',
        clearTitle: '清除已保存的导览？',
        clearDescription: ({ machine }) => `删除 ${machine} 上已保存的导览和你的手动编辑，以及你对这些比较所做的审阅标记。其他机器不受影响。`,
        savedCount: ({ count, bytes }) => `已保存 ${count} 个 · ${bytes}`,
        cost: ({ amount, partial }) => `过去7天 · ${amount}${partial ? ' · 部分费用不可用' : ''}`,
        clearFailed: '部分导览无法清除。请重新加载后重试。',
    }) };

return { walkthroughSettingsTranslations };
})();

const Domain_walkthroughStartTranslations = (() => {
const walkthroughStartTranslations = { 'zh-Hans': { walkthroughStart: { start: '开始导读', ended: '目前无法在此使用该对话。导读仍然保留。', newConversation: '开始新对话', askSession: '询问会话代理', unavailable: '连接所属机器并选择支持结构化输出的模型。', updated: '导读已更新' } } };

return { walkthroughStartTranslations };
})();

const Domain_walkthroughTranslations = (() => {
type WalkthroughTranslations = Shared_walkthroughTranslations.WalkthroughTranslations;

const walkthroughSavedTranslations = {...Domain_walkthroughSavedTranslations.walkthroughSavedTranslations, ...EnglishFeatures.walkthroughSavedTranslations.walkthroughSavedTranslations};

const walkthroughProgressTranslations = {...Domain_walkthroughProgressTranslations.walkthroughProgressTranslations, ...EnglishFeatures.walkthroughProgressTranslations.walkthroughProgressTranslations};

const en = Shared_walkthroughTranslations.en;

const translated = Shared_walkthroughTranslations.translated;

const walkthroughTranslations = { 'zh-Hans': {
        walkthrough: translated({
            saved: walkthroughSavedTranslations['zh-Hans'],
            progress: walkthroughProgressTranslations['zh-Hans'],
            eyebrow: '导读',
            generated: '已生成',
            generatedBy: ({ model }) => `已生成 · ${model}`,
            generatedA11y: '由模型撰写',
            readingChanges: '正在读取更改…',
            modelFallback: '模型',
            analysisAll: ({ who, count }) => `${who} 已读完全部 ${count} 处`,
            analysisSome: ({ who, analysed, total }) => `${who} 已读 ${analysed}/${total} 处`,
            analysisStopped: ({ who, analysed, total }) => `${who} 读了 ${analysed}/${total} 处后停止`,
            unavailableCount: ({ count }) => `${count} 处不可用`,
            youReviewed: ({ count, total }) => `你已审阅 ${count}/${total}`,
            contents: '目录',
            reviewedOfTotal: ({ count, total }) => `已审阅 ${count}/${total}`,
            boardReadProgress: ({ count, total }) => `已读 ${count}/${total}`,
            stopOf: ({ number, total }) => `${number}/${total}`,
            stopA11y: ({ number, title }) => `第 ${number} 站：${title}`,
            stopReviewedA11y: ({ number }) => `第 ${number} 站，已审阅`,
            importance: { start: '从这里开始', high: '仔细阅读', low: '略读' },
            markReviewed: '标记为已审阅',
            reviewed: '已审阅',
            markReviewedA11y: '将此站标记为已审阅',
            unmarkReviewedA11y: '已审阅。按下可取消标记',
            askAboutThis: '就此提问',
            askAboutStopA11y: '就此站提问',
            openConversation: '打开导读对话',
            andIn: ({ file }) => `以及 ${file}`,
            newFile: '新文件',
            deletedFile: '已删除',
            openInFiles: ({ file }) => `在文件中打开 ${file}`,
            otherChanges: '其他更改',
            otherChangesDescription: '不在故事中，但仍在这里。可像普通差异一样打开。',
            otherChangesCue: '机械性更改，以差异显示',
            keys: { move: '移动', reviewed: '已审阅', ask: '提问' },
            overview: '概览',
            codeMapOf: ({ count }) => `${count} 个文件的代码地图`,
            codeMapHint: '指向某一站以勾勒其文件',
            touchesOutlined: '涉及勾勒出的文件',
            showOverviewA11y: ({ count }) => `显示概览：${count} 个文件的代码地图`,
            inventory: { title: '此比较中的全部内容 · 现已在文件中可用', read: '已读', reading: '读取中', unavailable: '不可用' },
            arriving: '后续各站写好后会显示在这里。',
            previousStop: '上一站',
            nextStop: '下一站',
            done: '完成',
            evidence: { displayFailed: '无法显示已保存的代码。该文件仍保留在“文件”中。', binary: '二进制文件，根据元数据描述。仅显示，未分析。', unavailable: ({ reason }) => `无法读取（${reason}）。它仍在列表中；这里不声称已审阅。` },
            notice: {
                stale: '写完后有文件发生了更改',
                refresh: '刷新导读',
                failed: ({ reason }) => `撰写已停止 · ${reason}`,
                failedGeneric: '撰写已停止',
                tryAgain: '重试',
                chooseModel: '选择模型',
                cancelled: '撰写已停止。已写内容保留。',
                rest: '其余部分未写。所有文件都在文件中；没有静默跳过任何内容。',
                offline: ({ machine, time }) => `${machine} 已离线 · 显示 ${time} 时的导读和代码。重新连接后可提问和刷新。`,
                offlineA11y: '需要已离线的机器',
                incomplete: '部分更改无法列出。此处内容准确，但不声称完整。',
                undo: '撤销',
            },
            none: { title: '尚无导读', reason: '导读会按顺序阅读这些更改，并在确切代码旁逐一解释。所有文件已在文件中。', showFiles: '显示文件' },
            explain: { notInStory: '不在故事中', readInWalkthrough: '在导读中阅读' },
        }),
    } };

return { walkthroughTranslations };
})();

const Domain_widgetAddTranslations = (() => {
type WidgetAddTranslation = Shared_widgetAddTranslations.WidgetAddTranslation;

const inSentence = Shared_widgetAddTranslations.inSentence;

const widgetAddTranslations = { 'zh-Hans': {
        viewGallery: '图库',
        viewList: '列表',
        viewLabel: '视图',
        added: '已添加',
        boardTitle: '添加到看板',
        boardHint: '这里的每个人都能看到你添加的内容',
        companionTitle: '添加到伴随栏',
        companionHint: '只有你能看到你的伴随栏',
        searchWidgets: '搜索小组件',
        searchCompanion: '搜索速览和面板',
        fromPlugins: '来自插件',
        fromPluginsHint: '实时，使用此会话的数据',
        makeOne: '新建一个',
        noteSubtitle: 'Markdown',
        interactiveViewSubtitle: 'HTML',
        findMore: '查找更多小组件',
        findMoreSubtitle: '插件',
        askTitle: '让智能体做一个小组件',
        askNote: '在输入框中起草；在你发送之前不会发送任何内容。',
        glances: '速览',
        glancesHint: '实时，内置或来自插件',
        onBoard: '在此看板上',
        onBoardHint: '与这里的每个人共享',
        panes: '面板',
        panesHint: '以链接形式添加，在详情中打开',
        builtIn: '内置',
        nativeDescriptions: {
            session_summary: '查看所选会话的活动和后续步骤。',
            agent_plan: '跟进所选会话中智能体的计划。',
            changes: '查看所选会话中的文件更改。',
            local_services: '打开所选会话运行的本地服务。',
        },
        noMatch: ({ query }) => `没有与“${query}”匹配的小组件`,
        setupTitle: ({ widget }) => `设置 ${widget}`,
        editTitle: ({ widget }) => `${widget} · 输入`,
        editHint: '只有这个副本会改变。其他副本保留各自的输入。',
        preview: '预览',
        previewLive: '预览 · 实时',
        previewWaiting: ({ field }) => `选择${field}后会在这里显示`,
        previewAfterAdd: '添加后会在这里显示',
        backToGallery: '返回图库',
        needed: '必填',
        stillNeeded: ({ field }) => `仍需要 ${field}`,
        followGroup: '跟随',
        pinGroup: '或固定一个',
        another: '其他…',
        anotherSubtitle: '搜索你能访问的所有内容',
        searchChoices: ({ field }) => `搜索 ${field}`,
        noChoices: '暂时没有可选项',
        optionsLoading: '正在加载选项…',
        optionsFailed: '无法加载选项',
        invalidValue: '未找到',
        inputsInvalid: '请检查此小组件的输入',
        inputsUnavailable: '所选输入不可用',
        connectionNeeded: ({ field }) => `连接你自己的${field}`,
        sessionDenied: ({ session }) => `你已失去对${session}的访问权限`,
        sessionUnavailable: ({ session }) => `${session}不可用或已被删除`,
        typeUnavailable: ({ field }) => `${field}的类型已不可用`,
        inputUnavailable: ({ field }) => `${field}不可用`,
        selectedInputUnavailable: ({ field, value }) => `${field}：${value}已不可用`,
        invalidReason: '你已无权访问，或已被删除。',
        viewerOnly: '这里每个人都通过自己的连接查看。',
        justAdded: ({ widget }) => `已添加 ${widget}`,
        saved: ({ widget }) => `已保存 ${widget}`,
        addFailed: '无法添加。请重试。',
        saveFailed: '无法保存。请重试。',
        homeTitle: '添加到首页',
        homeHint: '只有你能看到你的首页 · 在所有设备上',
        homeFromPluginsHint: '实时，使用你的数据',
        addWidgets: '添加小组件',
        addToHome: '添加到首页',
        addToBoard: '添加到看板',
        addToCompanion: '添加到伴侣',
        editInputs: '编辑输入…',
        width: '宽度',
        size: '尺寸',
        sizes: { small: '小', medium: '中', wide: '宽', full: '全宽', tall: '高', large: '大' },
        widthHalf: '半宽',
        widthFull: '全宽',
        thisSession: '此会话',
        choicesCount: ({ count }) => `${count} 个选项`,
        countOnHome: ({ count }) => `首页上有 ${count} 个`,
        countOnBoard: ({ count }) => `看板上有 ${count} 个`,
        countInCompanion: ({ count }) => `伴侣中有 ${count} 个`,
        thisPage: '此页面',
        thisProject: '此项目',
        thisCheckout: '此检出',
        areaPinned: '已固定',
        areaPinnedMeta: '你在此页面上的小组件',
        areaProjectTitle: '小组件',
        areaProjectMeta: '你的',
        areaAdd: ({ surface }) => `将小组件添加到 ${surface}`,
        areaAddTo: ({ surface }) => `添加到 ${surface}`,
        areaHint: '只有你能看到这些小组件',
        countHere: ({ count }) => `此处 ${count} 个`,
        areaEmptyTitle: '尚未固定任何内容',
        areaEmptyReason: '固定一个小组件，它会只为你保留在这里。',
        areaEmptyAction: '添加小组件',
        areaUnavailableTitle: '无法在此加载小组件',
        projectSourceUnavailableTitle: '知道此项目的仓库后，小组件会显示在这里',
        areaWriteFailed: '无法保存此更改',
        areaApprovalPending: '等待批准',
        valueNotFound: ({ value }) => `找不到 ${value}`,
        chooseAnother: ({ field }) => `选择其他${field}`,
        chooseField: ({ field }) => `选择${field}`,
        widgetOptions: '小组件选项',
        moveTo: '移动…',
    } } satisfies Pick<Readonly<Record<string, WidgetAddTranslation>>, "zh-Hans">;

return { widgetAddTranslations };
})();

const Domain_widgetDefinitionTranslations = (() => {
type WidgetDefinitionTranslation = Shared_widgetDefinitionTranslations.WidgetDefinitionTranslation;

const widgetDefinitionTranslations = { 'zh-Hans': {
        yourWidgets: "你的小组件",
        yourWidgetsHint: "由你或你的智能体创建",
        yourWidget: "你的小组件",
        moreInSource: "来源中的内容比这里显示的更多。",
        notCurrent: "不是最新",
        aboutMenu: "关于此小组件",
        aboutTitle: "关于此小组件",
        aboutUnavailable: "现在无法打开此小组件。",
        aboutData: "数据",
        aboutReads: "读取",
        aboutInputs: "输入",
        aboutRefresh: "刷新",
        aboutUsedIn: "用于",
        savedFromSession: ({ session }) => `保存自 ${session}`,
        aSession: "某个会话",
        madeInYourAccount: "在你的账户中创建",
        edited: ({ time }) => `${time} 编辑`,
        readsOnly: "只读",
        runsOn: ({ machine }) => `在 ${machine} 上运行`,
        withYourConnection: "使用你自己的连接",
        readsResource: ({ read, plugin }) => `来自 ${plugin} 的 ${read}`,
        cannotRunAnythingElse: "此小组件不能运行其他任何内容。",
        inputsThisCopy: "仅限此副本",
        refreshWhenOpen: "打开时",
        refreshNow: "立即刷新",
        refreshing: "正在刷新…",
        refreshed: "已刷新",
        refreshFailed: "无法刷新。保留上次的数字。",
        placedOnHome: "主页",
        placedOnBoard: ({ board }) => `${board} 看板`,
        placedOnABoard: "某个看板",
        placedInASession: "某个会话",
        placedInAProject: "某个项目",
        placedOnAPluginPage: "某个插件页面",
        notPlacedYet: "尚未放置在任何位置",
        otherPlacesNotListed: "其他设备或共享界面上的位置不会在此列出。",
        editsChangeAll: ({ count }) => `编辑此小组件会更改全部 ${count} 处`,
        editsChangeEverywhere: "编辑此小组件会在所有使用它的地方生效",
        changeWithAgent: "让智能体修改",
        changeDraft: ({ widget }) => `修改“${widget}”小组件，使其`,
        duplicate: "复制",
        duplicated: ({ name }) => `已将副本“${name}”保存到你的小组件`,
        duplicateFailed: "无法创建副本，请重试。",
        saveMenu: "另存为你的小组件…",
        saveMenuSubtitle: "用于主页和你的看板的副本",
        saveTitle: "另存为你的小组件",
        saveHint: "可放到主页、你的看板和项目中的副本。此会话保留自己的那一份。",
        saveNote: "保存到你的账户 · 仅你可见",
        saveWidget: "保存小组件",
        saveFailed: "无法保存小组件，请重试。",
        savedButNotPlaced: "已保存到你的小组件，但未能添加到你选择的所有位置。",
        savedAsYours: ({ name }) => `已将“${name}”保存到你的小组件`,
        name: "名称",
        nameNeeded: "请为它命名",
        becomesViewerInput: "变为输入：每个位置使用你的连接",
        becomesContextInput: "变为输入：每个位置各自选择",
        alsoAddTo: "同时添加到",
        alsoAddToNamed: ({ place }) => `同时添加到 ${place}`,
        snapshotMenu: "在此看板发布快照…",
        snapshotMenuSubtitle: "这里的每个人都能看到你此刻的数字",
        snapshotTitle: "为这里的每个人发布快照？",
        snapshotHint: ({ widget, time }) => `任何能打开此会话的人都会看到 ${widget} 截至 ${time} 的数据。它不会更新，你的连接仍然只属于你。`,
        postSnapshot: "发布快照",
        snapshotNotCurrent: "小组件仍在获取最新数字。获取后再试。",
        snapshotFailed: "无法发布快照。没有共享任何内容。",
        snapshotAwaitingApproval: "正在收件箱中等待批准。批准前不会共享任何内容。",
        snapshotPosted: "快照已发布",
        snapshotNote: "这些数字的副本，不会更新。",
        asOf: ({ time }) => `截至 ${time}`,
    } } satisfies Pick<Readonly<Record<string, WidgetDefinitionTranslation>>, "zh-Hans">;

return { widgetDefinitionTranslations };
})();

const Domain_widgetFrameTranslations = (() => {
type WidgetFrameTranslation = Shared_widgetFrameTranslations.WidgetFrameTranslation;

const widgetFrameTranslations = { 'zh-Hans': {
        styleCard: '卡片',
        stylePlain: '简洁',
        surfaceHome: '首页',
        surfaceBoard: '看板',
        surfaceCompanion: '伴随栏',
        showFrame: '显示边框',
        hideFrame: '隐藏边框',
        thisWidgetOnly: '仅此小组件',
        surfaceUses: ({ surface, style }) => `${surface}使用${style}`,
        useSurfaceDefault: ({ surface }) => `使用${surface}默认样式`,
        likeTheOthers: ({ style }) => `${style}，与其他一致`,
        appearanceTitle: '小组件',
        appearanceDescription: '此设备上小组件的边框样式。要单独更改某个小组件，请使用它的 ⋯ 菜单。',
        previewLabel: ({ surface, style }) => `${surface} · ${style}`,
        noticeChanged: '边框已更改',
        addViewTitle: '添加小组件',
        addViewDescription: '“添加”弹窗的显示方式。在弹窗中切换也会更改此处。',
        newChip: '新',
    } } satisfies Pick<Readonly<Record<string, WidgetFrameTranslation>>, "zh-Hans">;

return { widgetFrameTranslations };
})();

const Domain_widgetGlanceTranslations = (() => {
type WidgetGlanceTranslation = Shared_widgetGlanceTranslations.WidgetGlanceTranslation;

const widgetGlanceTranslations = { 'zh-Hans': {
        changesTitle: '更改',
        localServicesTitle: '本地服务',
        changesSource: 'Git',
        reviewChanges: '查看更改',
        notARepo: '此会话的文件夹不是 Git 仓库。',
        noChanges: '暂无更改。智能体编辑的文件会显示在这里。',
        changesLoading: '正在加载更改',
        running: '运行中',
        notRunning: '未运行',
        nothingRunning: '没有正在运行的服务。此会话启动的服务会显示在这里。',
        servicesLoading: '正在加载本地服务',
        servicesReadFailed: '无法读取本地服务。请重试。',
        noMachine: '此会话没有可查询的机器。',
        changedCount: ({ count }) => `${count} 个已更改`,
        moreFiles: ({ count }) => `还有 ${count} 个文件`,
        runningCount: ({ count }) => `${count} 个运行中`,
        openInBrowser: ({ name }) => `在浏览器中打开 ${name}`,
        paneLinkA11y: ({ pane }) => `${pane}。在聊天旁打开`,
    } } satisfies Pick<Readonly<Record<string, WidgetGlanceTranslation>>, "zh-Hans">;

return { widgetGlanceTranslations };
})();

const Domain_workStatusTranslations = (() => {
type WorkStatusTranslations = Shared_workStatusTranslations.WorkStatusTranslations;

const en = Shared_workStatusTranslations.en;

const zhHans: WorkStatusTranslations = {
    buckets: {
        needs_you: '需要你',
        working: '进行中',
        finished: '已完成',
        idle: '空闲',
        offline: '离线',
    },
};

const workStatusTranslations = { zhHans: { ...zhHans, task: { stopped: '已停止', linkFailed: '会话已创建，但未保存与任务的关联。重试将关联同一个会话。' } } };

return { workStatusTranslations };
})();

const Domain_workflowActionTranslations = (() => {
type Copy = Shared_workflowActionTranslations.Copy;

const en = Shared_workflowActionTranslations.en;

const workflowActionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "zhHans"> = { zhHans: {
        host: "Happier",
        structure: "结构",
        artifactCreate: "创建文档",
        artifactGet: "读取文档",
        artifactList: "列出文档",
        artifactUpdate: "更新文档",
        artifactDelete: "删除文档",
        artifactPublish: "发布文件",
        artifactRevisions: "列出文档版本",
        artifactRestore: "恢复文档版本",
        artifactUsage: "查看文档存储用量",
        artifactShare: "通过链接共享文档",
        artifactLinks: "列出文档链接",
        artifactRevoke: "撤销文档链接",
        artifactAudit: "查看文档链接活动",
        sessionRole: "设置会话角色",
        sessionRoleOverride: "更改会话角色设置",
        sessionRoleClear: "重置会话角色设置",
        sessionRoleAdd: "添加会话角色",
        sessionRoleRemove: "移除会话角色",
        sessionNotes: "设置会话备注",
        sessionRolesApply: "将角色应用到下属会话",
        roleList: "列出角色",
        roleGet: "读取角色",
        roleCreate: "创建角色",
        roleUpdate: "更新角色",
        roleDelete: "删除角色",
        roleOverride: "更改角色设置",
        roleReset: "重置角色设置",
        widgetCatalog: "列出可用小组件",
        widgetInstances: "列出已放置的小组件",
        widgetAdd: "添加小组件",
        widgetRemove: "移除小组件",
        widgetMove: "移动小组件",
        widgetRename: "重命名小组件",
        widgetSize: "设置小组件大小",
        widgetFrame: "设置小组件边框",
        widgetInputs: "读取小组件输入",
        widgetValidate: "检查小组件输入",
        widgetSetInputs: "设置小组件输入",
        widgetResetInputs: "重置小组件输入",
        widgetLayout: "读取小组件布局",
        widgetUpdateLayout: "更改小组件布局",
        widgetDefinitions: "列出已保存的小组件",
        widgetDefinition: "读取已保存的小组件",
        widgetCreate: "创建小组件",
        widgetUpdate: "更新已保存的小组件",
        widgetDuplicate: "复制已保存的小组件",
        widgetDelete: "删除已保存的小组件",
        widgetSave: "保存会话小组件",
    } };

return { workflowActionTranslations };
})();

const Domain_workflowAgentAuthoringTranslations = (() => {
type Edit = Shared_workflowAgentAuthoringTranslations.Edit;

type RepeatableMessage = Shared_workflowAgentAuthoringTranslations.RepeatableMessage;

type Copy = Shared_workflowAgentAuthoringTranslations.Copy;

const en = Shared_workflowAgentAuthoringTranslations.en;

const repeatable = { zhHans: { repeatable: '转为可重复使用', repeatableDescription: '请智能体把这里成功的做法变成可再次运行的工作流。', repeatablePrompt: '把我们在这里做的事情变成我可以再次运行的工作流。起草它，用 workflow.validate 检查并保存，但不要运行。', repeatableMessagePrompt: '把我们在这条消息中做的事情变成我可以再次运行的工作流。起草它，用 workflow.validate 检查并保存，但不要运行。', repeatableMessageSource: ({ text }: RepeatableMessage) => `“${text}”` } };

const workflowAgentAuthoringTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "zhHans"> = { zhHans: { ...repeatable.zhHans, create: '与智能体一起创建', edit: '与智能体一起编辑', agent: '智能体', description: '新会话会与你一起起草工作流，检查并保存。选择立即运行之前不会执行任何内容。', changedByAgent: '由智能体更改', saved: '智能体刚刚保存', savedAge: ({ age }) => `由智能体保存 · ${age}`, savedWorkflow: ({ name }) => `工作流已保存 · ${name}`, updated: '已更新工作流', changed: ({ count }) => `已更新工作流 · 更改了 ${count} 个步骤`, openEditor: '在编辑器中打开', openSession: '在会话中打开', createPrompt: '和我一起起草一个工作流，用 workflow.validate 检查，然后保存。不要运行它。', createLead: '帮我创建一个工作流，它会', editPrompt: ({ name, definitionId, headerVersion, bodyVersion }) => `已保存的工作流“${name}”的 id 为 ${definitionId}，版本：头部 ${headerVersion}，正文 ${bodyVersion}。用 workflow.definition.edit 修改它，只有整体替换时才使用 workflow.definition.update。保存前用 workflow.validate 检查。不要运行它。`, editLead: ({ name }) => `帮我修改 ${name}：` } };

return { repeatable, workflowAgentAuthoringTranslations };
})();

const Domain_workflowBuiltinTranslations = (() => {
type WorkflowBuiltinTranslations = Shared_workflowBuiltinTranslations.WorkflowBuiltinTranslations;

const en = Shared_workflowBuiltinTranslations.en;

const zhHans: WorkflowBuiltinTranslations = {
    runsInsideSession: '在会话中运行',
    keepGoing: { title: '持续直到完成' },
    reviewAndConverge: { title: '审查并收敛', apply: '应用', verifyAndFix: '验证并修复', verifyOnly: '仅验证', rounds: '停止前的轮数' },
    planWithAPanel: { title: '由小组规划', description: '多个代理并行规划，然后计划等待你的审查。', inputs: { request: '请求', requestPlaceholder: '小组应规划什么？', engines: '规划者' } },
    openAPullRequest: { title: '打开拉取请求', description: '先征求第二意见，再打开拉取请求。如果第二意见不同意，它会等待你。', inputs: { base: '基础分支', title: '拉取请求标题', body: '描述', question: '给第二意见的问题' } },
};

const workflowBuiltinTranslations = { zhHans } as const;

return { workflowBuiltinTranslations };
})();

const Domain_workflowFieldTranslations = (() => {
const workflowFieldTranslations = { zhHans: {
        sessionId: "会话",
        triggerId: "触发器",
        engineIds: "审查者",
        backendTargetKeys: "规划者",
        reviewCommentAuthorIntent: "发现",
        commentId: "发现",
        expectedServerRevision: "发现版本",
        clientMutationId: "更新",
        projectId: "项目",
        workspace: "工作区",
        toState: "状态",
        expectedState: "当前状态",
        disposition: "重要性",
        allPages: "所有发现",
        permissionMode: "权限",
        target: "运行位置",
        cwd: "工作文件夹",
        maxRounds: "最大轮数",
        strikes: "无进展的检查次数",
        secondOpinion: "第二意见",
        useJudge: "评判者",
        diffFingerprint: "已审查的更改",
    } };

return { workflowFieldTranslations };
})();

const Domain_workflowEditorPageTranslations = (() => {
type WorkflowEditorPageTranslations = Shared_workflowEditorPageTranslations.WorkflowEditorPageTranslations;

const workflowFieldTranslations = {...Domain_workflowFieldTranslations.workflowFieldTranslations, ...EnglishFeatures.workflowFieldTranslations.workflowFieldTranslations};

const en = Shared_workflowEditorPageTranslations.en;

const pluralPl = Shared_workflowEditorPageTranslations.pluralPl;

const pluralRu = Shared_workflowEditorPageTranslations.pluralRu;

const zhHans: WorkflowEditorPageTranslations = {
    fields: workflowFieldTranslations.zhHans,
    blocks: {
        actionSub: '操作 · 无代理回合',
        notSet: '未设置',
        set: '设置',
        clear: '清除',
        required: '必填',
        noFields: '此操作没有需要设置的内容。',
        workflowSub: '运行另一个工作流 · 其步骤显示在此次运行中',
        builtin: '内置',
        waitTitle: '等待你',
        waitSub: '此通道会等待你继续。',
        waitPlaceholder: '你需要在这里检查或决定什么？',
        returnsText: '返回文本',
        returnsFields: ({ fields }) => `返回 ${fields}`,
        workflowDefaults: '工作流默认设置',
        addNamedResults: '添加命名结果',
        menuRun: '运行工作流',
        menuAction: '操作',
        menuWait: '等待你',
        actionSearch: '搜索操作',
        workflowSearch: '搜索工作流',
        libraryGroup: '你的工作流',
        noAgentTurn: '无代理回合。',
        useNumber: '使用数字',
        actionUnavailable: ({ action }: { action: string }) => `${action} 在此不可用。`,
        childInputs: ({ workflow }: { workflow: string }) => `输入来自 ${workflow}。`,
        retryLoading: "重试加载",
        selfRef: ({ workflow }: { workflow: string }) => `${workflow} 会运行此工作流，因此不能在其中运行。`,
        maxFromInput: ({ name }: { name: string }) => `来自输入 · ${name}`,
        useInput: ({ name }: { name: string }) => `使用输入 ${name}`,
    },
    backToRun: '返回运行',
    reviewedCopyTitle: '保存前检查',
    reviewedCopyBody: '这是来自一次运行的副本。保存的是步骤和设置，不包含运行历史或结果。运行位置、运行方式和输入值仅用于运行。复用前请检查对已有会话、文件夹、配置、模型、服务和 MCP 服务器的引用。',
    chromeTitle: '工作流',
    untitled: '未命名工作流',
    nameLabel: '工作流名称',
    descriptionPlaceholder: '添加描述',
    descriptionLabel: '描述',
    save: '保存',
    flow: '流程',
    flowSubtitle: '以地图显示此草稿',
    settings: '工作流设置',
    settingsSubtitle: '除非步骤自行更改，否则都使用这些设置。',
    deleteWorkflow: '删除工作流',
    deleteBody: '过去的运行仍保留在历史记录中。',
    deleteFailedTitle: '无法删除工作流',
    changedForStep: '已为此步骤更改',
    issuesToFix: ({ count }: { count: number }) => (count === 1 ? '运行前还有 1 处需要修正' : `运行前还有 ${count} 处需要修正`),
    saveStatus: {
        notSaved: '尚未保存',
        unsaved: '有未保存的更改',
        saving: '正在保存…',
        saved: '已保存',
        savedJustNow: '刚刚已保存',
        savedAge: ({ age }: { age: string }) => `已保存 · ${age}`,
        failed: '无法保存',
        yourEdits: '你的修改',
        newerVersion: '较新的版本',
        newerVersionRevision: ({ revision }: { revision: string }) => `较新的版本 · ${revision}`,
    },
    where: {
        label: '运行位置',
        choose: '选择运行位置',
    },
    sections: {
        whereTitle: '运行位置',
        machineAndProject: '机器和项目',
        eachStepRunsIn: '每个步骤运行于',
        eachStepSession: '每个步骤都会显示在你的会话列表中，位于此次运行之下。',
        eachStepBackground: '每个步骤都在后台运行，位于此次运行之下。',
        aSession: '会话',
        aBackgroundRun: '后台运行',
        agentTitle: '代理和模型',
        agentDescription: '除非步骤自行选择，否则都使用这些。',
        rolesTitle: '此工作流的角色',
        conversationTitle: '对话和工作区',
        inputsTitle: '输入和输出',
    },
    unavailable: {
        machine_not_selected: '请先选择一台机器。',
        capability_unknown: '正在检查这台机器支持的功能。',
        machine_does_not_support_detached_runs: '这台机器暂不支持后台运行。',
    },
    /** Workflow settings and Step options (U-9): group summaries and the block subject. */
    inspector: {
        stepOptions: '步骤选项',
        whereMissing: '未选择机器',
        none: '无',
        inputCount: ({ count }) => `${count} 个输入`,
        finalOutput: ({ output }) => `最终输出：${output}`,
        originSession: '启动它的会话',
        differsFromWorkflow: '与工作流不同',
        followsWorkflow: '使用工作流设置',
        advancedTitle: '高级',
        deadline: ({ ms }) => `等待结果 ${ms} 毫秒`,
        workflowDefault: ({ value }) => `工作流默认 · ${value}`,
        aSession: '一个会话…',
        continues: ({ session }) => `继续 ${session}`,
        runsIn: '运行于',
        runsInBoundBySession: '继续某个会话，因此在该会话中运行。',
        reviewTitle: '继续前审核',
        reviewDescription: '此通道中的后续步骤会等待你使用、编辑或重新生成结果。其他工作继续进行。',
        reviewEvaluator: '每次迭代都会等待你的审核。',
        reviewsBeforeContinuing: '继续前审核',
        resultTitle: '结果',
        resultFromAction: ({ action }) => `由 ${action} 定义`,
        resultFromWorkflow: ({ workflow }) => `返回 ${workflow} 的返回值`,
        back: '返回',
        options: '选项',
        itemConversation: '每个项目单独一个会话；内部步骤共享它。',
        dropContinue: ({ session }) => `在此步骤中继续 ${session}`,
        dropRefused: ({ session, machine, where }) => `${session} 在 ${machine} 上；此工作流在 ${where} 上运行。`,
        lanes: ({ count }) => `并排 · ${count} 条通道`,
        lane: ({ position }) => `通道 ${position}`,
        forEachIn: ({ source }) => `对 ${source} 中的每个项目`,
        atATime: ({ count }) => `每次 ${count} 个`,
        repeatTimes: ({ count }) => `重复 ${count} 次`,
        repeatUntil: ({ condition }) => `重复直到 ${condition}`,
        repeatUntilDecided: '重复直到某个步骤要求停止',
        ifSentence: ({ condition }) => `如果 ${condition}`,
        onlyWhenSentence: ({ condition }) => `仅当 ${condition}`,
        conditionAll: '全部成立',
        conditionAny: '任一成立',
        conditionNot: ({ condition }) => `非（${condition}）`,
        returnsStructured: '返回结构化数据',
        returnsDecision: '返回一个决定',
    },
};

const workflowEditorPageTranslations = { zhHans } as const;

return { workflowEditorPageTranslations };
})();

const Domain_workflowExamplesTranslations = (() => {
type ExampleCopy = Shared_workflowExamplesTranslations.ExampleCopy;

type Copy = Shared_workflowExamplesTranslations.Copy;

const workflowExamplesTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "zhHans"> = { zhHans: {
        nodes: { ask: '提问', 'review-correctness': '审查正确性', 'review-tests': '审查测试', summarize: '汇总发现', analyze: '分析', review: '审查', fix: '修复', check: '检查', classify: '分类', reply: '起草回复', digest: '汇总变更' },
        title: '从示例开始', fromExample: '使用示例', description: '每个示例都以草稿打开。选择“立即运行”之前不会运行。', use: '使用此示例', chooseSession: '选择会话…', builtInDescription: 'Happier 内置。复制后即可修改。', stepCount: ({ count }) => `${count} 个步骤`,
        askOnce: { title: '问一次', description: '一个步骤：向代理提问并获取回答。' },
        reviewPullRequest: { title: '审查拉取请求', description: '两位审查者并行工作，然后汇总所有发现。' },
        workThroughEachFile: { title: '逐个处理文件', description: '逐个分析列表中的文件，然后审查修改。' },
        repairUntilItPasses: { title: '修复直到通过', description: '反复修复和检查，直到通过或用完允许的次数。然后由你审查最后的修复。' },
        triageAnIssue: { title: '分类问题', description: '对问题分类。如果是错误则修复，否则起草回复。' },
        morningDigest: { title: '晨间摘要', description: '汇总项目变更并发送给你。添加触发器即可每天早上收到。' },
    } };

return { workflowExamplesTranslations };
})();

const Domain_workflowPluginTranslations = (() => {
type Copy = Shared_workflowPluginTranslations.Copy;

const en = Shared_workflowPluginTranslations.en;

const workflowPluginTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "zhHans"> = { zhHans: { fromPlugins: '来自插件', readOnly: '只读 · 复制到你的库中以编辑', duplicateToLibrary: '复制到你的库' } };

return { workflowPluginTranslations };
})();

const Domain_workflowRunVisibilityTranslations = (() => {
type VisibilityCopy = Shared_workflowRunVisibilityTranslations.VisibilityCopy;

const workflowRunVisibilityTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', VisibilityCopy>, "zhHans"> = { zhHans: { title: "可见范围", chooseTeam: "选择团队", loadFailed: "无法检查谁能查看此运行", machines: "在你的机器上运行", transcripts: "团队成员可以查看步骤对话。", requiredSessionsEditable: "此团队的成员可以编辑团队会话", visibleTo: ({ team }) => "可见团队：" + team } };

return { workflowRunVisibilityTranslations };
})();

const Domain_workflowRunCompositionTranslations = (() => {
const workflowRunVisibilityTranslations = {...Domain_workflowRunVisibilityTranslations.workflowRunVisibilityTranslations, ...EnglishFeatures.workflowRunVisibilityTranslations.workflowRunVisibilityTranslations};

const en = Shared_workflowRunCompositionTranslations.en;

const workflowRunCompositionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "zhHans"> = { zhHans: { visibility: workflowRunVisibilityTranslations.zhHans, runWithAnotherAgent: '用另一个代理再次运行', agentForStep: ({ step }) => `${step}的代理`, chooseAgent: '选择代理或角色' } };

return { workflowRunCompositionTranslations };
})();

const Domain_workflowRunListTranslations = (() => {
type Progress = Shared_workflowRunListTranslations.Progress;

const en = Shared_workflowRunListTranslations.en;

const workflowRunListTranslations = { zhHans: {
        definitions: '定义',
        stepsProgress: ({ completed, total }: Progress) => `${total} 个步骤中已完成 ${completed} 个`,
        loopProgress: ({ completed, total }: Progress) => `${total} 项中已完成 ${completed} 项`,
        startedByAgent: '由代理启动',
        startedByTrigger: '由触发器启动',
    } } satisfies Pick<Record<string, typeof en>, "zhHans">;

return { workflowRunListTranslations };
})();

const Domain_workflowRunRoleTranslations = (() => {
const en = Shared_workflowRunRoleTranslations.en;

const workflowRunRoleTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "zhHans"> = { zhHans: { rolesTitle: '本次运行的角色', rolesYour: '你的角色', rolesChanged: ({ count }) => `本次运行更改了 ${count} 个`, rolesUnchanged: '其他内容保持不变。', useYourRole: '使用你的角色', targetsTitle: '每个步骤运行于', rolesPrefillFailed: '无法读取你上次运行的角色。请重试。' } };

return { workflowRunRoleTranslations };
})();

const Domain_workflowStartTranslations = (() => {
type Copy = Shared_workflowStartTranslations.Copy;

const workflowRunRoleTranslations = {...Domain_workflowRunRoleTranslations.workflowRunRoleTranslations, ...EnglishFeatures.workflowRunRoleTranslations.workflowRunRoleTranslations};

const workflowRunCompositionTranslations = {...Domain_workflowRunCompositionTranslations.workflowRunCompositionTranslations, ...EnglishFeatures.workflowRunCompositionTranslations.workflowRunCompositionTranslations};

const en = Shared_workflowStartTranslations.en;

const workflowStartTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "zhHans"> = { zhHans: { ...workflowRunRoleTranslations.zhHans, ...workflowRunCompositionTranslations.zhHans, neededNamed: ({ name }) => `输入 · 需要${name}`, addToStart: ({ name }) => `添加${name}后即可开始`, workflow: '工作流', inputs: '输入', start: '开始', starting: '正在开始…', stillStarting: '仍在开始…', needed: ({ count }) => `输入 · 还需 ${count} 项`, required: '开始前必填', preview: '将执行的内容', unsaved: '包含未保存的更改', remove: '返回普通会话', search: '查找工作流', builtin: '内置', library: '你的库', noInputs: '无需输入', asksFor: ({ names }) => `需要：${names}`, optional: '可选 — 留空', defaultValue: ({ value }) => `默认值：${value}` } };

return { workflowStartTranslations };
})();

const Domain_workflowsDestinationTranslations = (() => {
type WorkflowsDestinationTranslations = Shared_workflowsDestinationTranslations.WorkflowsDestinationTranslations;

const en = Shared_workflowsDestinationTranslations.en;

const zhHans: WorkflowsDestinationTranslations = {
    description: '你的智能体在你的机器上运行的流程——在你需要时、按计划或在某件事发生时。',
    import: '导入',
    addAccessibility: '添加工作流',
    moreAccessibility: '更多工作流选项',
    addMenu: {
        newWorkflowSubtitle: '从空白草稿开始',
        importSubtitle: '工作流 JSON 文件',
    },
    sections: {
        needsYou: '需要你处理',
        running: '运行中',
        library: '资料库',
        sharedWithYou: '与你共享',
        triggers: '触发器',
        history: '历史',
    },
    allRuns: '全部运行',
    lastRun: ({ age }) => `上次运行 ${age}`,
    strip: {
        label: ({ count, parts }) => `最近 ${count} 次运行：${parts}`,
        labelPlain: ({ count }) => `最近 ${count} 次运行`,
        completed: ({ count }) => `${count} 次完成`,
        failed: ({ count }) => `${count} 次失败`,
        needsYou: ({ count }) => `${count} 次需要你处理`,
        separator: '，',
    },
    runSettings: '运行设置',
    libraryEmpty: '你保存的工作流会显示在这里。',
    waitingForYou: ({ age }) => `等你处理 · ${age}`,
    stateAge: ({ state, age }) => `${state} · ${age}`,
    triggerRow: ({ when, then }) => `${when} · ${then}`,
    thenSendPrompt: '发送提示词',
    thenRunWorkflow: '运行工作流',
    offline: '离线',
    off: '已关闭',
    columnLoadFailed: '无法加载工作流。你保存的内容都不会丢失。',
    firstVisitTitle: '保存好用的提示词，然后再次运行',
    firstVisitBody: '工作流是一组步骤，由你的智能体按顺序、并行或对每个项目各运行一次——在你需要时、按计划或在某件事发生时。',
    importPrompt: '有工作流文件？',
    loadMoreWorkflows: '加载更多工作流',
    searchPlaceholder: '搜索工作流',
    noMatch: ({ query }) => `没有与“${query}”匹配的工作流`,
    views: {
        all: '全部',
        triggered: '有触发器',
        active: '进行中',
        needsYou: '需要你处理',
        libraryAccessibility: '要显示的工作流',
        historyAccessibility: '要显示的运行',
    },
    history: {
        title: '历史',
        description: '你启动的每一次运行，无论以何种方式开始。',
        loadMore: '加载更多运行',
        loadFailedTitle: '无法加载运行',
        loadFailedBody: '你的工作不受影响。',
        review: '查看',
        rowMeta: ({ origin, machine, age }) => `${origin} · ${machine} · ${age}`,
    },
    rowMenu: {
        accessibility: '工作流选项',
        runNow: '立即运行',
        share: '共享…',
    },
    deleteTitle: '删除此工作流？',
    deleteBody: '过去的运行会保留在历史中。',
    deleteFailedTitle: '无法删除工作流',
    exportFailedTitle: '无法导出工作流',
    gate: {
        localTitle: '此设备上的自动化已关闭',
        localBody: '开启后即可运行工作流及其触发器。',
        dependencyTitle: '工作流需要自动化',
        dependencyBody: '开启自动化以创建和运行工作流。',
        openSettings: '打开设置',
    },
    runSettingsPage: {
        title: '运行设置',
        description: '每台机器同时接受多少次运行，以及运行历史保留多久。',
        saveFailed: '无法保存运行设置。你的更改仍在这里。',
    },
};

const workflowsDestinationTranslations = { zhHans } as const;

return { workflowsDestinationTranslations };
})();

const Domain_workflowTriggersTranslations = (() => {
type Count = Shared_workflowTriggersTranslations.Count;

type WorkflowTriggersCopy = Shared_workflowTriggersTranslations.WorkflowTriggersCopy;

const en = Shared_workflowTriggersTranslations.en;

const zhHans: WorkflowTriggersCopy = {
    pullRequest: {
        label: "拉取请求",
        description: "添加此触发器会将拉取请求链接到此会话。",
        empty: "没有开放的拉取请求",
        loadFailed: "无法加载拉取请求",
    },
    summary: {
        everyDayAt: ({ time }) => `每天 ${time}`,
        weekdaysAt: ({ time }) => `工作日 ${time}`,
        weeklyAt: ({ day, time }) => `每${day} ${time}`,
        everyMinutes: ({ count }) => (count === 1 ? '每分钟' : `每 ${count} 分钟`),
        everyHours: ({ count }) => (count === 1 ? '每小时' : `每 ${count} 小时`),
        cron: ({ expression }) => `按计划 · ${expression}`,
        schedule: '按计划',
        event: ({ event }) => `当 ${event} 发生时`,
        manual: '手动',
        more: ({ first, count }) => `${first} · 另有 ${count} 个`,
    },
    kind: {
        sessionStarts: '当会话开始时',
        sessionArchived: '当会话被归档时',
        schedule: '按计划',
        prComment: '当有人评论拉取请求时',
        ciFailed: '当拉取请求的 CI 失败时',
        turnEnds: '当一轮结束时',
        needsYou: '当会话需要你时',
        runEnds: '当运行结束时',
        runNeedsYou: '当运行需要你时',
    },
    row: {
        workflowDeleted: '工作流已删除',
        legacyCreated: '在 Happier 0.2 中创建',
        legacyUnavailable: '旧触发器不可用',
        sessionKeyRequired: '需要会话密钥',
        templateRecoveryRequired: '请在账号安全设置中恢复此触发器',
        templateDecryptionFailed: '无法解密触发器',
        machines: ({ count }: Count) => `${count} 台机器`,
        nextRun: ({ time }: { time: string }) => `下次运行：${time}`,
        steps: ({ count }) => (count === 1 ? `${count} 个步骤` : `${count} 个步骤`),
        off: '已关闭',
        running: '运行中',
        ran: ({ age }) => `${age}运行`,
        turnOn: ({ name }) => `开启 ${name}`,
        turnOff: ({ name }) => `关闭 ${name}`,
    },
    section: {
        add: '添加触发器',
        emptyTitle: '没有触发器',
        emptyBody: '添加一个，用于审查每一轮、持续推进目标或响应拉取请求。',
        loadFailed: '无法加载此会话的触发器。',
        title: '触发器',
        countOn: ({ count }) => `${count} 个已开启`,
        info: '发生某事时在此会话中运行的内容。它们留在此会话中，不会出现在你的库中。',
        saveFailed: '无法保存此触发器。你的更改仍在这里。',
    },    kindDescription: {
        turnEnds: '在你或与你协作的代理完成一轮之后。',
        needsYou: '每当此会话等待你时，包括由工作流或“持续到完成”驱动时。',
        sessionArchived: '在你归档此会话时运行一次。',
        sessionStarts: '仅在创建会话时。',
        schedule: '按计划继续此会话。',
        prComment: '仅限有写入权限的人。评论会作为引用文本传入。',
        pullRequestUnavailable: '暂时还不能在这里添加拉取请求触发器。',
    },
    then: {
        runsIn: '运行于',
        runsInChoice: {
            newSession: '新会话',
            session: '某个会话…',
            backgroundRun: '后台运行',
        },
        noSessionOnMachine: '此机器上还没有会话',
        session: '会话',
        action: '操作',
        label: '然后',
        sendPrompt: '发送提示',
        doAction: '执行操作',
        notifyMe: '通知我',
        runWorkflow: '运行工作流',
        sendPromptDescription: '此会话的代理会在此会话中收到这条提示。它不会打断你的回合。',
        promptLabel: '提示',
        promptPlaceholder: '代理应该做什么？',
        message: '消息',
        title: '标题',
        sendTo: '发送到',
        sendToDefault: '你的通知设置',
        workflow: '工作流',
        choose: '选择…',
    },
    popover: {
        saveAsWorkflow: '另存为工作流',
        saveAsWorkflowDescription: '将这些步骤作为新工作流打开以供审查。此触发器保留自己的步骤。',
        when: '何时',
        newTrigger: '新触发器',
        addTrigger: '添加触发器',
        cancel: '取消',
        done: '完成',
        turnOff: '关闭',
        turnOn: '开启',
        deleteTrigger: '删除触发器',
        repeat: '重复',
        everyDay: '每天',
        weekdays: '工作日',
        weekly: '每周',
        day: '星期',
        at: '时间',
        expression: '计划',
        tryAgain: '重试',
    },    editor: {
        runsOn: '运行机器',
        runsOnDescription: '此工作流的所有触发器都在这里运行。',
        runsOnAccountDescription: '此触发器的运行位置。',
        runsOnDiffers: ({ where }) => `“立即运行”改用 ${where}。`,
        sameForAllTriggers: '所有触发器相同',
        roles: '角色',
        retargetFailed: '工作流已保存 · 触发器未更新',
        editInWorkflows: '请在工作流中更改此触发器。它会保持原样继续运行。',
        title: '自动运行',
        runsBy: '当发生以下任一情况时自动运行。',
        runsByOn: ({ where }) => `当发生以下任一情况时，在 ${where} 上自动运行。`,
        savedWorkflow: '触发器运行已保存的工作流。',
        saveToInclude: '触发器运行已保存的工作流。保存以包含你的更改。',
        newRow: '新建 · 尚未添加',
        partialSave: '工作流已保存 · 触发器未更新',
    },    column: {
        newTrigger: '新触发器',
        newTriggerSubtitle: '按计划运行自己的步骤',
    },
};

const legacyTranslations = { zhHans: {
        editNotice: '创建于 Happier 0.2。打开不会更改任何内容。',
        conversionBoundary: '此更改后仅在运行 Happier 0.3 或更新版本的机器上执行。',
        channelReplyRefusal: '此自动化有无法转移的频道回复绑定。尚未转换，原设置和你的编辑均保留。',
        notAvailable: '此自动化已不可用。',
    } };

const creationTranslations = { zhHans: { savedWorkflowsUnavailable: '切换到此会话的服务器以选择已保存的工作流。内置工作流和内联步骤仍然可用。' } };

const workflowTriggersTranslations = { zhHans: { ...zhHans, legacy: legacyTranslations.zhHans, creation: creationTranslations.zhHans } } as const;

return { legacyTranslations, creationTranslations, workflowTriggersTranslations };
})();

const Domain_workflowValueReferenceTranslations = (() => {
const workflowValueReferenceTranslations = { zh: {
        checkoutRoot: '检出根文件夹',
        unavailableValue: '值不可用', sessionContext: ({ turns }: { turns: number }) => turns === 0 ? '会话上下文' : `最近${turns}轮会话`,
        tokensUsed: '已用令牌', goalTokenBudget: '目标令牌预算',
        trailingCount: ({ source, value }: { source: string; value: string }) => `连续匹配${value}的${source}`,
        stopCondition: '已满足停止条件', stopConditionArm: ({ arm }: { arm: number }) => `已满足停止条件${arm}`,
        roundLimit: ({ rounds }: { rounds: number }) => `已达轮数上限 · ${rounds}轮`, decision: '决定',
    } };

return { workflowValueReferenceTranslations };
})();

const Domain_workflowTranslations = (() => {
type WorkflowTranslatedLocale = Shared_workflowTranslations.WorkflowTranslatedLocale;

type WorkflowTranslations = Shared_workflowTranslations.WorkflowTranslations;

const workflowBuiltinTranslations = {...Domain_workflowBuiltinTranslations.workflowBuiltinTranslations, ...EnglishFeatures.workflowBuiltinTranslations.workflowBuiltinTranslations};

const workflowExamplesTranslations = {...Domain_workflowExamplesTranslations.workflowExamplesTranslations, ...EnglishFeatures.workflowExamplesTranslations.workflowExamplesTranslations};

const workflowEditorPageTranslations = {...Domain_workflowEditorPageTranslations.workflowEditorPageTranslations, ...EnglishFeatures.workflowEditorPageTranslations.workflowEditorPageTranslations};

const workflowsDestinationTranslations = {...Domain_workflowsDestinationTranslations.workflowsDestinationTranslations, ...EnglishFeatures.workflowsDestinationTranslations.workflowsDestinationTranslations};

const workflowTriggersTranslations = {...Domain_workflowTriggersTranslations.workflowTriggersTranslations, ...EnglishFeatures.workflowTriggersTranslations.workflowTriggersTranslations};

const workflowStartTranslations = {...Domain_workflowStartTranslations.workflowStartTranslations, ...EnglishFeatures.workflowStartTranslations.workflowStartTranslations};

const workflowRunListTranslations = {...Domain_workflowRunListTranslations.workflowRunListTranslations, ...EnglishFeatures.workflowRunListTranslations.workflowRunListTranslations};

const workflowPluginTranslations = {...Domain_workflowPluginTranslations.workflowPluginTranslations, ...EnglishFeatures.workflowPluginTranslations.workflowPluginTranslations};

const workflowAgentAuthoringTranslations = {...Domain_workflowAgentAuthoringTranslations.workflowAgentAuthoringTranslations, ...EnglishFeatures.workflowAgentAuthoringTranslations.workflowAgentAuthoringTranslations};

const workflowValueReferenceTranslations = {...Domain_workflowValueReferenceTranslations.workflowValueReferenceTranslations, ...EnglishFeatures.workflowValueReferenceTranslations.workflowValueReferenceTranslations};

const workflowActionTranslations = {...Domain_workflowActionTranslations.workflowActionTranslations, ...EnglishFeatures.workflowActionTranslations.workflowActionTranslations};

const workflowReferenceScopeTranslations = Shared_workflowTranslations.workflowReferenceScopeTranslations;

const en = Shared_workflowTranslations.en;

const translated = Shared_workflowTranslations.translated;

const pluralPl = Shared_workflowTranslations.pluralPl;

const pluralRu = Shared_workflowTranslations.pluralRu;

const zhHans = translated(workflowValueReferenceTranslations.zh, {
    title: '工作流',
    newWorkflow: '新建工作流',
    copyName: ({ name }: { name: string }) => `${name} 副本`,
    importJson: '导入 JSON',
    exportJson: '导出 JSON',
    openCollection: '打开工作流',
    destination: workflowsDestinationTranslations.zhHans,
    plugins: workflowPluginTranslations.zhHans,
    authoring: workflowAgentAuthoringTranslations.zhHans,
    page: workflowEditorPageTranslations.zhHans,
    actionTitles: workflowActionTranslations.zhHans,
    builtins: workflowBuiltinTranslations.zhHans,
    examples: workflowExamplesTranslations.zhHans,
    triggers: workflowTriggersTranslations.zhHans,
    start: workflowStartTranslations.zhHans,
    list: workflowRunListTranslations.zhHans,
    review: {
        publishedByAgent: '由代理发布',
        publishedByYou: '由你发布',
        editedByYou: '由你编辑',
        editedByPerson: '由其他人编辑',
        previousAttempt: '上一次尝试',
        useBody: "后续步骤会收到你看到的确切内容。不启动智能体回合。",
        usePlanBody: "接受此计划的确切内容。不启动智能体回合。",
        reportBackTitle: ({ session }) => "报告给 " + session,
        reportBackBody: ({ session }) => session + " 会在此运行结束后收到结果。",
        planRunNotice: "按所显示的内容运行建议的工作流，并接受计划。不会保存工作流。",
        editedPlanBody: '此草稿与提案不同。是否先接受已审核的计划以进行编辑？你的更改会保留在这里，只有再次运行草稿时才会开始执行。',
        title: "待审核的结果",
        planTitle: "待审核的计划",
        waitTitle: "等待你的操作",
        waitBody: "此分支会等待，直到你继续。",
        editsTitle: "你未保存的修改",
        editsBody: "使用结果前，已保存的结果保持不变。",
        heldBody: "等待你的审核 · 尚未传给后续步骤",
        noValue: "尚无有效结果",
        useResult: "使用此结果",
        usePlan: "使用此计划",
        useValues: "使用这些值",
        continue: "继续",
        invalid: "请先修正标出的字段。",
        newer: "有更新的结果。",
        showNewer: "显示新结果",
        keepMyEdits: '保留我的编辑',
        useNewer: '使用新结果',
        showFullResult: '显示完整结果',
        showFullPlan: '显示完整计划',
        generationRequested: "已请求生成",
        startsResume: "恢复运行后开始。",
        generateBody: "智能体会在此对话中生成新结果。如果有效，运行将继续，不再询问。",
        acceptedPaused: "使用此结果后，工作流仍保持暂停。",
        editResult: "编辑结果",
        generate: "生成结果并继续",
        discuss: "讨论",
        discussBody: "在此步骤的对话中回复。智能体可以在这里发布更新的结果。",
        proposal: "建议的工作流",
        planStarted: "此计划的运行已开始",
        earlierPlanStarted: "先前提案的运行已开始",
        openEarlierPlanRun: "打开该运行",
        runNewProposal: "运行新提案",
        runPlan: "作为工作流运行",
        runPlanBody: "打开建议工作流的运行审核。启动时也会接受此计划。",
        editPlan: "先编辑工作流",
        editPlanBody: "接受此计划，然后将建议的工作流作为未保存的草稿打开。",
        editPlanFallback: "接受此计划，然后打开以计划为提示词的单步骤工作流。",
        waitingMachine: ({ machine }) => "等待 " + machine,
    },

    tabs: {
        saved: '已保存',
        runs: '运行记录',
        steps: '步骤',
        flow: '流程图',
        map: '地图',
        activity: '活动',
    },
    tabsAccessibility: {
        savedRuns: '已保存的工作流或运行记录',
        stepsFlow: '步骤或流程图',
        activityFlow: '活动或流程图',
        runViews: "运行视图",
    },

    filters: {
        all: '全部',
        active: '进行中',
        needsYou: '需要你处理',
        clear: '清除筛选',
    },

    empty: {
        savedTitle: '还没有保存任何工作流',
        savedBody: '保存工作流会留下一份可重复使用的定义，随时可以运行或安排时间。',
        runsTitle: '还没有运行过任何内容',
        runsBody: '无论你是否保存工作流，运行记录都会显示在这里。',
        filteredTitle: '没有运行记录符合这个筛选条件',
        filteredBody: '清除筛选即可看到其余的运行记录。',
        missingTitle: '此工作流不可用',
        missingBody: 'Happier 无法打开此链接指向的工作流。你的其他工作流、自动化和运行不受影响。',
    },

    loadFailedTitle: '无法加载工作流',
    loadFailedBody: '你的工作不受影响。准备好后再试一次。',
    retry: '重试',
    contentUnavailable: '此设备上无法显示私密内容。',
    contentReasons: {
        invalidHeader: '此工作流保存的信息无效。',
        revisionMismatch: '此工作流与保存的修订版本不一致。',
        missingBody: '此工作流保存的定义缺失。',
        invalidBody: '此工作流保存的定义无效。',
        notFound: '此工作流已不可用。',
    },

    sessionEntry: {
        missingTitle: '该会话已不可用',
        missingBody: '它可能已被删除，或位于另一个 Home。打开会话列表来查找它。',
        inaccessibleTitle: '你无法打开该会话',
        inaccessibleBody: 'Happier 无法确认访问权限。请重新登录或联系其所有者，然后重新打开此页面。',
        failedTitle: '无法打开该会话',
        failedBody: 'Happier 会继续重试。你也可以现在再试一次。',
        unsupportedTitle: '该会话无法启动工作流',
        unsupportedBody: 'Happier 无法读取它运行所用的智能体和机器。请改从工作流页面创建。',
    },

    editor: {
        namePlaceholder: '工作流名称',
        agentRuntime: '智能体运行时',
        firstPromptTitle: '第一步要做什么？',
        firstPromptBody: '一个提示词就是一个工作流。需要时再添加步骤。',
        promptPlaceholder: '描述这个步骤要做什么',
        useWorkflowDefault: '使用工作流的默认值',
        defaultsTitle: '默认值',
        produces: '产出',
        whereTitle: '位置',
        add: '添加',
        addAccessibility: '向这个工作流添加一个块',
        addStep: '代理步骤',
        addParallel: '并排',
        addLoop: '重复',
        addIf: '条件',
        targetRequired: '请为该工作流选择机器和项目文件夹。',
        loadingTitle: '正在打开工作流…',
        accountChangedTitle: '你已切换账户',
        accountChangedBody: '此工作流由上一个账户打开，无法沿用。请在“工作流”中重新打开。',
        loadFailedTitle: '无法打开此工作流',
        loadFailedBody: '暂时无法读取已保存的工作流。',
        timeoutTitle: '结果等待时间（毫秒）',
        noDeadline: '无期限',
        timeoutExplain: '等待此步骤结果的毫秒数，超过后将需要关注。留空表示没有期限。',
        wholeNumberRequired: '请输入不小于 1 的整数。',
        runNow: '立即运行',
        save: '保存工作流',
        saveAutomation: '保存自动化',
        schedule: '安排时间',
        savedRevision: ({ revision }) => `已保存 · ${revision}`,
        moveUp: '上移',
        moveDown: '下移',
        moveIn: '移入上方的分组',
        moveOut: '移出这个分组',
        remove: '移除',
        undo: '撤销',
        redo: '重做',
        historyRestoreRequiresSetup: '此事件需要重新设置。删除后无法恢复其已保存的私有配置。',
        history: { edited: '编辑工作流', agent: '智能体修改', description: '编辑描述', where: '更改运行位置', target: '更改步骤运行方式', triggers: '编辑触发器', example: '插入示例', document: '编辑提示词' },
        undoAction: ({ change }: { change: string }) => `撤销：${change}`,
        redoAction: ({ change }: { change: string }) => `重做：${change}`,
        removedBlock: ({ block }) => `已移除 ${block}`,
        rename: '重命名',
        stepOrdinal: ({ position }) => `${position}`,
        unnamedStep: ({ position }) => `步骤 ${position}`,
        unnamedParallel: '并行分组',
        unnamedLoop: '循环',
        unnamedIf: '条件判断',
        branch: '分支',
        addBranch: '添加分支',
        ifTrue: '条件成立时',
        otherwise: '否则',
        addOtherwise: '添加“否则”分支',
        evaluator: '判断是否继续',
        loopBody: '重复这些步骤',
        continuation: '每一轮之后',
    },

    input: {
        label: '输入',
        result: '结果',
        change: '更改',
        none: '没有输入',
        previousResult: ({ block }) => `${block} 的结果`,
        workflowInput: ({ name }) => `工作流输入 ${name}`,
        currentItem: '当前项',
        iteration: '本轮',
        unavailable: '这个来源已不再可用',
        itemField: {
            value: '项目值',
            index: '项目索引（从 0 开始）',
            position: '项目位置（从 1 开始）',
            count: '项目数量',
        },
        iterationField: {
            index: '轮次索引（从 0 开始）',
            position: '轮次编号（从 1 开始）',
            count: '轮次数量',
            stopReason: '停止原因',
        },
        valueKindGroup: '值来源',
        inputNameGroup: '工作流输入',
        producerGroup: '来源步骤',
        workspaceFieldGroup: '工作区字段',
        itemFieldGroup: '项目字段',
        iterationFieldGroup: '轮次字段',
    },

    inputs: {
        title: '工作流输入',
        addInput: '添加输入',
        namePlaceholder: '名称',
        descriptionPlaceholder: '这是用来做什么的？',
        required: '必填',
        optional: '可选',
        defaultValue: '默认值',
        typeString: '文本',
        typeNumber: '数字',
        typeBoolean: '是或否',
        typeJson: '结构化数据',
        runSheetTitle: '运行这个工作流',
        runSheetBody: '填写这个工作流声明的值，然后运行它。',
        missingRequired: '这个值是必填的。',
        wrongType: ({ type }) => `这个值必须是 ${type}。`,
    },

    finalOutput: {
        title: '最终输出',
        none: '尚未选择最终输出',
        change: '更改',
        clear: '清除选择',
        fieldPath: '字段路径',
        explain: '最终输出是这个工作流结束时返回的内容。完成的先后顺序不会改变它。',
    },

    conversation: {
        title: '对话',
        sharedRun: '同一个对话',
        branchesShareAndTakeTurns: '分支共享同一个对话，并依次执行。',
        fresh: '各自独立的对话',
        fromStep: ({ block }) => `继续 ${block}`,
        existingSession: '一个已有的会话',
        existingSessionById: ({ sessionId }) => `会话 ${sessionId}`,
        noExistingSessions: '此设备上没有可在此继续的会话。',
        chooseExistingSession: '选择要继续的会话',
        continuingKeepsAgentAndFolder: '继续时会沿用该对话的代理和文件夹。要使用其他代理或文件夹，需要独立的对话。',
        waitingForConversation: ({ block }) => `正在等待 ${block} 在这个对话中完成。`,
        branchesUseSeparate: '并行分组中的分支各自使用独立的对话。',
    },

    workspace: {
        title: '工作区',
        inherit: '工作流的工作区',
        projectCheckout: '项目文件夹',
        fromStep: ({ block }) => `继续使用 ${block} 的工作区`,
        newWorktreeOriginal: '从原始文件夹新建工作树',
        newWorktreeWorkflow: '从工作流的工作区新建工作树',
        newWorktreeStep: ({ block }) => `从 ${block} 新建工作树`,
        committedOnlyNote: '新的工作树包含源文件夹已提交的状态。已暂存、未提交和未跟踪的更改仍留在源文件夹中。',
        reuseNote: '继续使用一个工作区时，它会原样看到其中未提交的文件。',
        sharedParallelNote: '共用同一个工作区的分支可能会同时写入。',
        unavailable: ({ block }) => `${block} 的工作区不可用。`,
        unavailableBody: '恢复它以继续这次运行，或者查看一次可能重复已完成工作的新运行。',
        unavailableRestoreBody: '恢复它即可继续本次运行，已完成的工作保持不变。',
        unavailableNewRunBody: '它无法恢复。确认后开始新的运行会从头来过，已完成的工作可能会重复。',
        restore: '恢复',
        inspect: '查看',
    },

    condition: {
        onlyWhen: '仅在以下情况运行',
        always: '始终',
        stopWhen: '在以下情况停止',
        ifWhen: '在以下情况运行第一个分支',
        addCondition: '添加条件',
        removeCondition: '删除条件',
        allOf: '同时满足以下全部',
        anyOf: '满足以下任意一项',
        not: '非',
        exists: '有值',
        operatorEq: '等于',
        operatorNeq: '不等于',
        operatorLt: '小于',
        operatorLte: '不大于',
        operatorGt: '大于',
        operatorGte: '不小于',
        valuePlaceholder: '值',
        skippedReason: ({ block }) => `因为 ${block} 的条件不成立，已跳过。`,
    },

    loop: {
        modeTitle: '重复',
        modeCount: '固定的次数',
        modeItems: '每个项目各一次',
        modeUntil: '直到某个结果表示停止',
        modeEvaluate: '直到代理判断应当停止',
        count: '次数',
        items: '列表',
        sequential: '按顺序处理项目',
        parallel: '并行处理项目',
        maxConcurrentItems: '同时处理项目的上限',
        maxConcurrentBranches: '同时运行分支的上限',
        noWorkflowLimit: '工作流未设置上限',
        maxIterations: '轮数上限',
        limitReached: '已达上限',
        historyTitle: '之前的判断',
        historyNone: '不使用',
        historyLatest: '仅最近一次',
        historyAll: '全部',
        historyExplain: '这里选择的是已保存的判断和反馈，而不是完整的记录。',
        continuingConversation: '这个评估者会保留之前的对话，并把每一轮新内容追加进去。',
        emptyListCompletes: '列表为空时，一轮都不会执行就直接结束。',
    },

    failurePolicy: {
        title: '当某个步骤失败时',
        failStop: '失败时停止这个分组',
        failStopExplain: '这个分组会停止开始新的工作，并请求正在运行的分支停止，包括彼此独立的分支。已完成的结果和更改会保留。这不是回滚。',
        collectOutcomes: '让独立的工作跑完',
        collectOutcomesExplain: '正常的分支会跑完自己的整条链路，并收集每一个结果。分支内失败之后的步骤不会运行。',
    },

    runState: {
        pending: '等待开始',
        queued: '等待开始',
        claimed: '正在开始',
        running: '运行中',
        waiting_for_review: '等待你审核',
        succeeded: '已完成',
        failed: '已失败',
        cancel_requested: '正在停止',
        cancelled: '已停止',
        pause_requested: '正在暂停',
        paused: '已暂停',
        interrupted: '已中断',
        expired: '开始前已过期',
        dispatch_failed: '无法开始',
        skipped: '已跳过',
        missed: '已错过',
        outcome_uncertain: '结果不确定',
        completed: '已完成',
        completed_with_failures: '已完成，但有失败',
    },

    invocationState: {
        pending: '等待中',
        waiting_for_capacity: '等待可用资源',
        admitting: '正在启动',
        running: '运行中',
        waiting_for_approval: '等待批准',
        waiting_for_review: '等待你审核',
        needs_attention: '需要你处理',
        completed: '已完成',
        failed: '已失败',
        skipped: '已跳过',
        cancel_requested: '正在停止',
        cancelled: '已停止',
        outcome_uncertain: '结果不确定',
        superseded: '已被后一次尝试取代',
    },

    run: {
        title: '运行',
        frozenVersion: "此运行使用开始时的版本。编辑仅影响未来的运行。",
        selectOccurrence: '选择步骤',
        openReview: '审核结果',
        open: '打开运行',
        openExact: ({ title }) => `打开 ${title} 运行`,
        openExecution: '打开后台运行',
        loadMore: '加载更早的步骤',
        origin: {
            direct: '直接启动',
            automation: '按计划启动',
            fromSession: '来自某个会话',
        },
        needsYou: '需要你处理',
        needsYouLoadedCount: '个已加载',
        review: '查看',
        stop: '停止',
        stopAgain: '再次停止',
        stopping: '正在停止…',
        stopRequested: ({ machine }) => `已请求停止。正在等待 ${machine} 确认。`,
        evidenceStale: '显示的是最后一次已知的详情。Happier 无法确认它们是否是最新的。',
        pauseAtBoundary: '在下一个边界暂停',
        pausePending: '完成当前工作后暂停。',
        paused: '已在最后一个完成的边界处暂停。',
        resume: '继续',
        runAgain: '再次运行这个工作流',
        retryStep: '重试这个步骤',
        attempt: ({ attempt }) => `第 ${attempt} 次尝试`,
        untitled: '工作流运行',
        openResult: '打开结果',
        inspectSteps: '查看步骤',
        seeFailures: '查看失败',
        saveAsWorkflow: '保存为工作流',
        saveAsNewWorkflow: '另存为新工作流',
        showCurrentWork: '显示当前工作',
        editWorkflow: '编辑工作流',
        openWorkflow: '打开工作流',
        deleteHistory: '删除运行历史',
        deleteHistoryConfirm: '输入和结果会被删除。工作区、对话、已保存的工作流和自动化都会保留。',
        technicalDetails: '技术细节',
        technical: {
            runId: '运行 ID',
            invocationId: '步骤 ID',
            machine: '机器',
            machineId: '机器 ID',
            revision: '版本',
        },
        usageUnavailable: '用量不可用',
        startedAt: ({ time }: { time: string }) => `开始于 ${time}`,
        timeRange: ({ start, end }) => `${start} – ${end}`,
        openConversation: '打开对话',
        openChildRun: '打开其运行',
        openStepDetails: '打开详情',
        outcomeLine: ({ word, sentence }: { word: string; sentence: string }) => `${word} — ${sentence}`,
        attentionReviewRow: ({ step }: { step: string }) => `${step} 正在等待你审阅`,
        attentionWaitRow: ({ step }: { step: string }) => `${step} 正在等你`,
        attentionReviewSentence: ({ step }: { step: string }) => `${step} 正在等待你审阅。`,
        attentionWaitSentence: ({ step }: { step: string }) => `${step} 正在等你。`,
        reviewing: '正在审阅',
        notStarted: '未开始',
        machineUnavailable: ({ machine }) => `这次运行与 ${machine} 失去了联系。`,
        machineUnavailableBody: '弄清当前状态后，会显示可选的恢复方式。',
        completedCount: ({ count }) => `共完成 ${count} 个步骤。`,
        completedWithFailures: ({ completed, failed }) =>
            `已完成，但有失败。${completed} 个已完成，${failed} 个未能完成。`,
        approvalWanted: ({ block }) => `${block} 想要执行一条命令。`,
        approvalWantedBody: '查看之后即可继续。',
        capacityOccupied: '工作流中设定的名额已全部占用。',
        openSourceSession: '打开它来自的会话',
        observedActivity: '观察到的活动',
        observedActivityBody: 'Happier 能看到这个代理的阶段和各个代理，但它不是作为受管理的工作流启动的，因此无法编辑、保存或重新运行。',
    },

    recovery: {
        title: '查看恢复方式',
        reattach: '重新连接',
        reattachExplain: '观察已经在运行的工作。不会启动任何新内容。',
        resumeSameConversation: '继续',
        resumeSameConversationExplain: ({ block }) => `${block} 可以在同一个对话中继续。`,
        freshAgent: '换一个新的代理继续',
        freshAgentExplain: '这个对话无法继续。工作区可以交给一个新的代理使用。',
        uncertainEffects: ({ block }) => `${block} 在汇报之前就停止了。它可能已经改动过工作区。`,
        acknowledgeEffects: '我知道之前的更改可能已经发生',
        waitingForStop: '正在等待停止或确认',
        remainingNotStarted: ({ count }) => `还有 ${count} 个相关步骤尚未开始`,
        startReviewedRun: '确认后开始一次新的运行',
        editContinuation: '查看或编辑后续内容',
        continuationPlaceholder: '补充这一步应该有什么不同',
        useReplacementInput: '替换这一步的输入',
        repeatedEffectWarning: '已完成的工作可能会重复。原来那次运行会保留自己的历史。',
    },

    unavailable: {
        title: '工作流不可用',
        body: '此服务器上的工作流不可用，因此无法在这里创建或运行工作流。',
        conversion: '这些更改需要工作流格式，而此服务器上的工作流不可用。请将此自动化保持为单条提示，或在工作流可用后重试。',
        savedAutomation: '此自动化以工作流方式运行。已保存的步骤保持不变；你仍可以编辑它的名称、描述和触发器。',
    },
    conversion: {
        title: '这些更改需要工作流格式',
        automationTarget: '工作流',
        body: '该自动化目前仍在已保存的目标上运行单个提示。转换会保留你的编辑，并让后续运行以工作流形式在某一台确定的机器上执行。已经发生的运行不受影响。',
        action: '转换为工作流',
        machineRequired: '请选择后续运行使用的机器和项目文件夹。',
    },
    save: {
        conflictTitle: '已经保存了一个更新的版本',
        conflictBody: '你的编辑仍然还在。',
        compare: '对比',
        saveAsCopy: '另存为副本',
        failedTitle: '无法保存',
        failedBody: '你在本地的工作仍然还在。',
        deleteTitle: '要删除这个工作流吗？',
        deleteBody: '现有的自动化和运行记录不受影响，会继续正常工作。',
        unsupportedAttachment: '保存这个工作流之前，请通过持久引用来附加媒体文件。',
        nameRequired: '保存之前，请先为这个工作流命名。',
        runsCurrentDraft: '这次运行使用屏幕上当前的工作流，并不会保存它。',
    },

    interchange: {
        importTitle: '导入一个工作流',
        importBody: '导入会打开一份未保存的草稿供你查看，不会运行也不会安排任何内容。',
        importIssuesTitle: '检查此工作流',
        importIssuesBody: '使用此工作流之前，有些设置需要你处理。',
        openRepairDraft: '打开修复草稿',
        importFailedTitle: '无法读取该文件',
        importFailedInvalidJson: '该文件不是有效的 JSON。',
        importFailedUnsupportedVersion: '该文件使用了本应用不支持的工作流版本。',
        importFailedInvalidDocument: '该文件不是 Happier 工作流。',
        exportPrivacyNote: '导出的文件包含提示词和设置，绝不会包含凭据或运行结果。',
    },

    issue: {
        invalid_version: '这个工作流使用了不受支持的版本。',
        unknown_field: '这个块有一项设置是这个工作流不支持的。',
        invalid_id: '这个块需要一个有效的标识符。',
        duplicate_id: '有两个块使用了相同的标识符。',
        missing_reference: '这个输入指向了一个已经不存在的块。',
        invalid_reference_scope: '这个输入指向了一个不会先完成的块。',
        invalid_input: '这个值无效。',
        missing_required_input: '缺少一个必填的值。',
        invalid_result_contract: '这个步骤的结果设置无效。',
        invalid_condition: '这个条件无法比较。',
        invalid_repetition: '按当前配置，这个循环无法重复。',
        invalid_max_concurrent: '最大并发数需要不小于 1 的整数，并且只适用于并行工作。',
        unsupported_persisted_attachment: '附加的媒体文件在保存前必须有持久引用。',
        conversation_workspace_mismatch: '此对话和工作区无法一起继续。',
        target_unavailable: '运行之前，请先为这个工作流选择一个代理。',
    },

    problem: {
        title: '操作没有成功',
        waitingTitle: '暂时还不行',
        subtreeDenied: '代理只能在自己的会话或由其领导的会话中启动工作。',
        roleTargetUnavailable: '此角色无法在这里使用。',
        roleRunsAsMismatch: '此角色的运行方式不适用于这一步。请选择其他角色或更改这一步的运行方式。',
        policyDeniedField: '你的代理设置不允许代理启动的工作使用所请求的设置。',
        permissionExceedsCeiling: '这需要的权限超过了启动它的代理所拥有的权限。',
        workDepthExceeded: '这会超过你的委派深度上限。请在此会话中完成，或前往设置 › 委派提高上限。',
        definitionExceedsAuthority: '代理无法保存能力超出其自身可启动范围的工作流。',
        sourceUnavailable: '此工作流不可用，因此其触发器无法运行。',
        legacyConversionUnsupported: '暂时无法在这里更改此自动化。它会继续按原样运行。',
        nativeGoalOwner: '此会话中的代理已经在自主推进目标。',
        sessionAlreadyStarted: '此会话已经开始。会话开始触发器只能在创建会话时添加。',
        generic: 'Happier 无法完成该工作流请求。你的工作没有受到影响。',
        needsRepair: '这个工作流有一些设置需要先修复才能运行。',
        targetUnavailable: '这个工作流需要的机器或智能体目前不可用。',
        notFound: '该运行已不存在。',
        accessDenied: '你没有访问该运行的权限。',
        conflict: '它在别处被改动过。刷新以查看当前版本；你的本地修改会保留。',
        inputTooLarge: '该输入太大，无法发送。没有做任何更改。',
        unresolvedOutcome: 'Happier 还无法确认之前的工作已经停止，因此不能替换它。',
        interactionCapacity: '该对话等待处理的内容太多，现在无法再接受更多。',
        conversationUnavailable: '该对话无法继续。',
        workspaceRestore: '无法恢复工作区。没有做任何更改。',
        waitSelfDependency: '这会让工作流等待启动它的那个对话。',
        updateRequired: '运行它的机器需要更新的 Happier 才能接受这一步。',
        ineligible: '该运行已经继续往下走了，所以这一步不再可行。',
        custodyPending: 'Happier 仍在等待该机器确认。',
        runFinished: '该运行已结束。',
        checkpointUnavailable: '没有可供恢复的保存点。',
        recoveryEvidenceRequired: '打开该运行即可查看恢复选项。',
        executionNotStarted: '还没有任何步骤开始。',
        custodySettled: '该运行已经结清。',
        unavailableHere: '目前无法使用。',
    },

    a11y: {
        blockList: '工作流的块',
        stepContext: ({ block, position, total }) => `${block}，第 ${position} 步，共 ${total} 步`,
        groupContext: ({ group, block }) => `${block}，位于 ${group} 内`,
        inherited: '使用工作流的设置',
        overridden: '为这个步骤单独设置',
        inserted: ({ block, position, total }) =>
            `已添加 ${block}，位置为第 ${position} 个，共 ${total} 个`,
        removed: ({ block, total }) => `已移除 ${block}。还剩 ${total} 个块`,
        reordered: ({ block, position, total }) =>
            `已把 ${block} 移到第 ${position} 个，共 ${total} 个`,
        validation: ({ reason }) => reason,
        validationInBlock: ({ block, reason }) => `${block}：${reason}`,
        needsYou: ({ count }) => `有 ${count} 个步骤需要你处理`,
        needsYouLoaded: '个已加载',
        terminal: ({ state }) => state,
        terminalWithAttention: ({ state, count }) => `${state}。有 ${count} 个步骤需要你处理`,
        selectedRowUpdated: ({ block }) => `${block} 已更新`,
        progress: ({ count }) => `已更新 ${count} 个步骤`,
        progressLoaded: ({ count }) => `截至目前已更新 ${count} 个步骤`,
        progressWithAttention: ({ count, attention }) =>
            `已更新 ${count} 个步骤，其中 ${attention} 个需要你处理`,
        flowNode: ({ node, state }) => `${node}，${state}`,
        editStep: '编辑步骤',
        editBlock: '编辑区块',
        commandRefused: ({ reason }) => `暂时无法执行。${reason}`,
    },
});

const workflowTranslations = { zhHans } as const;

return { workflowTranslations };
})();

const Domain_workspaceBarTranslations = (() => {
type WorkspaceBarTranslation = Shared_workspaceBarTranslations.WorkspaceBarTranslation;

const en = Shared_workspaceBarTranslations.en;

const workspaceBarTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', WorkspaceBarTranslation>>, "zh-Hans"> = { 'zh-Hans': { workspaceBar: { tabsLabel: '打开的标签页', tabMenuLabel: '标签页选项', pinTab: '固定标签页', unpinTab: '取消固定标签页', splitRight: '向右拆分', splitDown: '向下拆分', maximizePane: '最大化窗格', restorePane: '还原窗格', closeTab: '关闭标签页', closeOtherTabs: '关闭其他标签页', closeTabsToRight: '关闭右侧标签页', moreTabs: ({ count }) => `另外 ${count} 个标签页`, searchTabs: '搜索标签页', splitPane: '拆分当前窗格', openInNewTab: '在新标签页中打开', openToRight: '在右侧打开', openBelow: '在下方打开', newTab: '新标签页' } } };

return { workspaceBarTranslations };
})();

const Domain_workspaceSyncDiagnosticTranslations = (() => {
type WorkspaceSyncDiagnosticTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncDiagnosticTranslation;

type WorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslation;

type WorkspaceSyncLocale = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncLocale;

type WorkspaceSyncTranslationCore = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslationCore;

type WorkspaceSyncReviewBase = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncReviewBase;

const completeWorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.completeWorkspaceSyncTranslation;

const workspaceSyncDiagnosticTranslations = { 'zh-Hans': {
        diagnostics: { title: '诊断', relationshipId: '关系 ID', controllerMachineId: '控制计算机 ID', alphaMachineId: '源计算机 ID', betaMachineId: '目标计算机 ID', alphaRoot: '当前源文件夹', betaRoot: '当前目标文件夹', engineMode: '引擎模式', engineState: '引擎状态', errorCode: '错误代码' },
        error: { updateRequired: '请先更新源计算机上的 Happier，再重试此工作区移交。其他会话和计算机操作仍可使用。' },
        resolve: { title: '解决工作区冲突？', body: ({ path, side }) => `保留文件夹 ${path} 的“${side}”版本？验证当前状态后，另一个文件夹及其中独有的所有内容都将被删除。`, unverifiedFile: '无法安全移除没有当前文件指纹的版本。请刷新冲突后重试。' },
    } } as const satisfies Pick<Record<string, WorkspaceSyncDiagnosticTranslation>, "zh-Hans">;

const workspaceSyncSetAttentionTranslations = { 'zh-Hans': { attention: { conflictedLinks: ({ count }) => `${count} 条连接存在冲突`, unavailableLinks: ({ count }) => `${count} 条连接需要检查状态` } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'attention'>>, "zh-Hans">;

const workspaceSyncAddMachineTranslations = { 'zh-Hans': { availableOn: '可用于', addMachine: { replica: '副本', exactReplica: '精确副本', editableCopy: '可编辑副本', editableCopyHint: '关联计算机上的更改可能会被其他计算机上的智能体看到。冲突版本需要审查。如果需要隔离，请使用单独的工作树。' } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'availableOn' | 'addMachine'>>, "zh-Hans">;

const workspaceSyncReviewOutcomeTranslations = { 'zh-Hans': { keepBoth: '保留两个版本', preserveAt: ({ path }) => `在 ${path} 保留另一版本`, notReviewed: '未检查；此处不会更改', confirmScope: '只会更改列出的已检查工作区。不可用的工作区保持不变。', preserved: '已保留', alreadyPresent: '已存在', notStarted: '未开始', askAgent: '询问智能体', askAgentPrompt: ({ path, versions }) => `请帮我检查这些关联工作区中 ${path} 的冲突版本：\n${versions}\n请检查当前文件并提出安全的解决建议。未经我批准，不要更改或解决冲突。` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'keepBoth' | 'preserveAt' | 'notReviewed' | 'confirmScope' | 'preserved' | 'alreadyPresent' | 'notStarted' | 'askAgent' | 'askAgentPrompt'>>, "zh-Hans">;

const workspaceSyncCoverageIncompleteTranslations = { 'zh-Hans': '部分连接或端点尚未检查。已加载的冲突仍可查看；只能解决明确检查过且可用的版本。' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['coverageIncomplete']>, "zh-Hans">;

const workspaceSyncReviewLifecycleTranslations = { 'zh-Hans': { requestingApproval: '正在请求批准…', applying: '正在应用已检查的更改…', propagationExpected: ({ names }) => `预计传播至 ${names}`, propagationUnverified: ({ names }) => `尚无法验证是否传播至 ${names}` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'requestingApproval' | 'applying' | 'propagationExpected' | 'propagationUnverified'>>, "zh-Hans">;

const workspaceSyncLocalOnlyTranslations = { 'zh-Hans': '此备用位置仅保留在其工作区中' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['localOnly']>, "zh-Hans">;

const workspaceSyncKeepAlternativesTranslations = { 'zh-Hans': '保留其他版本' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['keepAlternatives']>, "zh-Hans">;

const workspaceSyncReviewDecisionTranslations = { 'zh-Hans': { chooseTargets: '选择要替换的工作区', notSelected: '未选入本次冲突解决', inspectCurrentVersions: '检查当前版本' } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'chooseTargets' | 'notSelected' | 'inspectCurrentVersions'>>, "zh-Hans">;

const workspaceSyncReviewTranslations: Pick<Record<WorkspaceSyncLocale, WorkspaceSyncReviewBase>, "zh-Hans"> = { 'zh-Hans': {
        executable: '可执行', regular: '不可执行', applied: '已应用', appliedPaused: '已应用；同步已暂停', changed: '应用前已更改', offline: '离线；未应用', cancelled: '已取消', unknown: '结果未知；请检查此端点', failed: '失败；未应用', recoveryNeeded: '此位置需要恢复', inspectionUnavailable: '无法检查当前版本。控制计算机可用后请刷新。', coverageIncomplete: '部分连接或端点尚未检查。已加载的冲突仍可查看，但暂不能解决。', versions: '版本', comparison: '比较所选版本', linkDecisions: '连接选择结果', result: '处理结果', confirmTitle: '使用此版本？', confirmBody: ({ path, source, count }) => `在其他 ${count} 个工作区使用 ${source} 的 ${path} 版本？Happier 会在更改前验证所有版本。`, useVersion: '使用此版本', useNamedVersion: ({ name }) => `使用 ${name}`, compareNamedVersion: ({ name }) => `比较 ${name}`, linkCount: ({ count }) => `${count} 条连接报告了此路径`, moreOnLink: ({ name }) => `加载 ${name} 的更多项目`,
    } };

const workspaceSyncReviewSelectionTranslations = { 'zh-Hans': { selectionIncluded: '此连接包含', selectionExcluded: '此连接排除', selectionUnknown: '选择结果未知', reasonRepositoryMetadata: '仓库元数据', reasonSubmodule: 'Git 子模块', reasonConfiguredRule: '已配置规则', reasonGitIgnore: 'Git 忽略规则', reasonEndpointUnavailable: '端点不可用', reasonSelectionUnavailable: '选择评估器不可用', configuredInclude: ({ pattern }) => `包含模式：${pattern}`, configuredExclude: ({ pattern }) => `排除模式：${pattern}`, completedLinks: ({ count }) => `阻塞前已完成 ${count} 条连接` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'selectionIncluded' | 'selectionExcluded' | 'selectionUnknown' | 'reasonRepositoryMetadata' | 'reasonSubmodule' | 'reasonConfiguredRule' | 'reasonGitIgnore' | 'reasonEndpointUnavailable' | 'reasonSelectionUnavailable' | 'configuredInclude' | 'configuredExclude' | 'completedLinks'>>, "zh-Hans">;

const zhHans = completeWorkspaceSyncTranslation({
    diagnostic: workspaceSyncDiagnosticTranslations["zh-Hans"],
    review: workspaceSyncReviewTranslations["zh-Hans"],
    selection: workspaceSyncReviewSelectionTranslations["zh-Hans"],
    outcome: workspaceSyncReviewOutcomeTranslations["zh-Hans"],
    lifecycle: workspaceSyncReviewLifecycleTranslations["zh-Hans"],
    decision: workspaceSyncReviewDecisionTranslations["zh-Hans"],
    coverage: workspaceSyncCoverageIncompleteTranslations["zh-Hans"],
    localOnly: workspaceSyncLocalOnlyTranslations["zh-Hans"],
    alternatives: workspaceSyncKeepAlternativesTranslations["zh-Hans"],
    addMachine: workspaceSyncAddMachineTranslations["zh-Hans"],
    attention: workspaceSyncSetAttentionTranslations["zh-Hans"],
}, {
    title: '工作区同步', footer: '状态来自管理此关系的计算机。只有该计算机确认后，才会显示更改。',
    legacyRecovery: {
        title: '已停用的工作区同步数据', footer: 'Happier 只会检查并隔离这些已停用的数据，绝不会在应用中删除它们。', checking: '正在检查计算机…',
        inspectFailed: '无法检查部分计算机。之前发现的隔离文件夹仍会显示；请在这些计算机可访问时重试。',
        outdatedTitle: ({ machine }) => `${machine} 正在运行旧版 Happier`, outdatedBody: '该版本无法检查已停用的工作区同步数据。请更新该计算机上的 Happier，然后在此重新检查。',
        explanation: '此计算机包含已停用的工作区复制引擎数据。Happier 已将识别到的数据移入私有隔离区，并禁用工作区同步，以防止旧引擎运行。',
        quarantinePath: '隔离文件夹', openFolder: '打开文件夹', offlineTitle: '在 Happier 离线时移除',
        offlineSteps: ({ path }) => `1. 停止所有可能使用这些数据的 Happier 后台服务。\n2. 使用操作系统仅移除这个文件夹：${path}\n3. 重启服务，然后在此重新检查。`,
        unknown: ({ path, reason }) => `Happier 无法安全识别 ${path} 中的旧状态（${reason}）。工作区同步仍处于禁用状态。请手动检查此路径，不要在应用中删除它。`, reinspect: '重新检查',
    },
    none: '没有工作区同步关系', conflictsTitle: '工作区冲突', openConflicts: ({ count }) => `检查 ${count} 条连接的工作区同步`, noConflicts: '没有冲突',
    previewUnavailable: '控制计算机无法提供安全预览。请先刷新冲突，然后重试。', truncated: ({ count }) => `还有 ${count} 个冲突未显示`, unknownMode: '不支持的同步模式', conflictCount: ({ count }) => `${count} 个冲突`,
    conflictKind: { file: '文件', directory: '文件夹', symlink: '符号链接', missing: '缺失', unsupported: '不支持的条目' },
    mode: { copyOnce: '复制一次', keepSynced: '保持最新 — 推荐', mirrorExactly: '精确镜像', keepBothInSync: '保持两端同步' },
    state: { loading: '正在检查状态…', starting: '正在准备', watching: '正在监视', flushing: '正在同步', paused: '已暂停', peerOffline: '离线', conflicted: '存在冲突', controllerUnavailable: '需要处理', engineUnavailable: '组件不可用', error: '需要处理', stopped: '已停止', working: '正在处理…' },
    lastChecked: ({ at }) => `上次检查：${at}`, endpoint: { source: ({ label }) => `来源 · ${label}`, destination: ({ label }) => `目标 · ${label}`, synced: ({ label }) => `同步端点 · ${label}` },
    error: { componentUnavailable: '此版本无法使用工作区同步。请安装所需组件后重试。', machineOffline: '目标计算机不可用。请重新连接后重试。', destinationNeedsPreparation: '开始同步前需要准备目标文件夹。', gitPreparationFailed: 'Happier 无法准备此 Git 工作区。请检查目标位置后重试。', authorizationExpired: '工作区授权已过期。请重新开始操作。', rootNoLongerAuthorized: '工作区文件夹已更改，不再获得授权。请先检查同步关系，然后重试。', conflictNeedsAttention: '此冲突已更改。请先刷新，再选择版本。', needsAttention: '工作区同步需要处理。请刷新状态后重试。' },
    start: { blocked: { targetMachine: '请选择目标计算机以继续。', targetMachineOffline: '该计算机目前不可用。请重新连接后重试。', relationshipUnavailable: '此同步关系已不再涵盖这两个文件夹。请选择其他工作区选项。', sourceFolder: '无法安全同步此会话的文件夹。请选择“不移动文件”以仅移交会话。', destinationFolder: '请选择可以安全同步的目标文件夹。', workspaceOptions: '开始前请检查工作区选项。' } },
    engine: { checking: '正在检查此计算机上的工作区同步…' },
    actions: { refresh: '刷新状态', syncNow: '立即同步', more: '工作区同步操作', pause: '暂停', resume: '继续', terminate: '停止同步', openOnMachine: ({ machine }) => `在 ${machine} 上打开`, openFolder: ({ label }) => `打开 ${label} 文件夹`, keepLocal: '保留本地版本', keepRemote: '保留远程版本', keepNamed: ({ side }) => `保留 ${side} 的版本` },
    terminate: { title: '移除工作区同步？', body: '同步将停止，相关关系也会被移除。两个工作区中的文件都会保留。' },
    resolve: { changedTitle: '冲突已更改', changedBody: '此冲突自打开后已发生更改。列表已刷新。请先检查最新版本，再次选择。', consequence: '只有 Happier 确认文件未更改后，才会移除另一个版本。', unsupported: '此冲突包含不受支持的文件系统条目，无法在 Happier 中解决。请在受影响的计算机上移除或替换它，然后刷新。', keepHint: ({ side }) => `保留 ${side} 的版本，并移除另一个已验证的版本。` },
    fileState: { text: '文本预览', binary: '二进制文件 — 无法预览', tooLarge: '文件太大，无法预览', missing: '文件缺失', changed: '列出此冲突后文件已更改' },
});

const workspaceSyncTranslations = { 'zh-Hans': zhHans } as const satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation>, "zh-Hans">;

return { workspaceSyncDiagnosticTranslations, workspaceSyncSetAttentionTranslations, workspaceSyncAddMachineTranslations, workspaceSyncReviewOutcomeTranslations, workspaceSyncCoverageIncompleteTranslations, workspaceSyncReviewLifecycleTranslations, workspaceSyncLocalOnlyTranslations, workspaceSyncKeepAlternativesTranslations, workspaceSyncReviewDecisionTranslations, workspaceSyncReviewTranslations, workspaceSyncReviewSelectionTranslations, workspaceSyncTranslations };
})();

const Domain_workspaceTabTranslations = (() => {
const en = Shared_workspaceTabTranslations.en;

const workspaceTabKeyboardTranslations = Shared_workspaceTabTranslations.workspaceTabKeyboardTranslations;

const workspaceTabTranslations = { 'zh-Hans': en };

return { workspaceTabTranslations };
})();

export {
    Domain_accountDisplayTranslations as accountDisplayTranslations,
    Domain_accountEncryptionRecoveryTranslations as accountEncryptionRecoveryTranslations,
    Domain_accountPopoverTranslations as accountPopoverTranslations,
    Domain_accountServiceOAuthTranslations as accountServiceOAuthTranslations,
    Domain_actionConfirmationTranslations as actionConfirmationTranslations,
    Domain_fileContentSearchTranslations as fileContentSearchTranslations,
    Domain_promptPickerTranslations as promptPickerTranslations,
    Domain_actionFamilyTranslations as actionFamilyTranslations,
    Domain_addFlowsTranslations as addFlowsTranslations,
    Domain_agentInstallJobTranslations as agentInstallJobTranslations,
    Domain_agentStartTranslations as agentStartTranslations,
    Domain_apiTokenSettingsTranslations as apiTokenSettingsTranslations,
    Domain_artifactsBrowserTranslations as artifactsBrowserTranslations,
    Domain_automationPageTranslations as automationPageTranslations,
    Domain_automationTriggerSetTranslations as automationTriggerSetTranslations,
    Domain_boardsTranslations as boardsTranslations,
    Domain_browserPresenceTranslations as browserPresenceTranslations,
    Domain_browserToolTranslations as browserToolTranslations,
    Domain_changedFileEvidenceTranslations as changedFileEvidenceTranslations,
    Domain_cliPathExposureTranslations as cliPathExposureTranslations,
    Domain_cliTrustPromptTranslations as cliTrustPromptTranslations,
    Domain_commitProposalTranslations as commitProposalTranslations,
    Domain_committedMessageActionTranslations as committedMessageActionTranslations,
    Domain_computerUseTranslations as computerUseTranslations,
    Domain_connectedServicesCollectionTranslations as connectedServicesCollectionTranslations,
    Domain_connectedServicesPoolTranslations as connectedServicesPoolTranslations,
    Domain_connectedServicesSettingsTranslations as connectedServicesSettingsTranslations,
    Domain_connectedServicesSetupTranslations as connectedServicesSetupTranslations,
    Domain_detailPageTranslations as detailPageTranslations,
    Domain_detailsChromeTranslations as detailsChromeTranslations,
    Domain_detailsFileTranslations as detailsFileTranslations,
    Domain_detailsHistoryTranslations as detailsHistoryTranslations,
    Domain_detailsReviewTranslations as detailsReviewTranslations,
    Domain_embedSettingsTranslations as embedSettingsTranslations,
    Domain_embedTranslations as embedTranslations,
    Domain_entityDragDropTranslations as entityDragDropTranslations,
    Domain_eventAutomationComposerTranslations as eventAutomationComposerTranslations,
    Domain_externalSessionOperationTranslations as externalSessionOperationTranslations,
    Domain_externalSessionSettingsTranslations as externalSessionSettingsTranslations,
    Domain_filesPaneTranslations as filesPaneTranslations,
    Domain_findTranslations as findTranslations,
    Domain_folderlessSessionTranslations as folderlessSessionTranslations,
    Domain_glassAppearanceTranslations as glassAppearanceTranslations,
    Domain_goalControlTranslations as goalControlTranslations,
    Domain_homeAddTranslations as homeAddTranslations,
    Domain_homeComposerTranslations as homeComposerTranslations,
    Domain_homeDeviceApprovalTranslations as homeDeviceApprovalTranslations,
    Domain_homeFeatureTranslations as homeFeatureTranslations,
    Domain_homeGovernanceTranslations as homeGovernanceTranslations,
    Domain_homeIndexTranslations as homeIndexTranslations,
    Domain_homeSettingsTranslations as homeSettingsTranslations,
    Domain_homeSetupTranslations as homeSetupTranslations,
    Domain_homeWidgetTranslations as homeWidgetTranslations,
    Domain_homesHubTranslations as homesHubTranslations,
    Domain_homesJourneysTranslations as homesJourneysTranslations,
    Domain_identityAdministrationTranslations as identityAdministrationTranslations,
    Domain_inboxWorkTranslations as inboxWorkTranslations,
    Domain_inputPickerTranslations as inputPickerTranslations,
    Domain_machineAddTranslations as machineAddTranslations,
    Domain_machineAgentsTranslations as machineAgentsTranslations,
    Domain_machineDetailPageTranslations as machineDetailPageTranslations,
    Domain_machinePoolTranslations as machinePoolTranslations,
    Domain_mcpSettingsTranslations as mcpSettingsTranslations,
    Domain_menuBarModeTranslations as menuBarModeTranslations,
    Domain_nativePasswordTranslations as nativePasswordTranslations,
    Domain_navigationPlacementTranslations as navigationPlacementTranslations,
    Domain_pendingNavigationTranslations as pendingNavigationTranslations,
    Domain_personalHomeBootstrapBlockedTranslations as personalHomeBootstrapBlockedTranslations,
    Domain_personalHomeDecisionTranslations as personalHomeDecisionTranslations,
    Domain_personalHomeSettingsTranslations as personalHomeSettingsTranslations,
    Domain_personalizeTranslations as personalizeTranslations,
    Domain_phoneNavigationTranslations as phoneNavigationTranslations,
    Domain_pluginAccountDataEraseTranslations as pluginAccountDataEraseTranslations,
    Domain_pluginAccountReleaseSelectionTranslations as pluginAccountReleaseSelectionTranslations,
    Domain_pluginInvocationLogTranslations as pluginInvocationLogTranslations,
    Domain_pluginMachineMatrixTranslations as pluginMachineMatrixTranslations,
    Domain_pluginMarketplaceDiscoverTranslations as pluginMarketplaceDiscoverTranslations,
    Domain_pluginPermissionTranslations as pluginPermissionTranslations,
    Domain_pluginSettingsPresentationTranslations as pluginSettingsPresentationTranslations,
    Domain_pluginUpdateReviewTranslations as pluginUpdateReviewTranslations,
    Domain_pluginWebhookAdministrationTranslations as pluginWebhookAdministrationTranslations,
    Domain_profilesPageTranslations as profilesPageTranslations,
    Domain_providerCollectionTranslations as providerCollectionTranslations,
    Domain_providerSessionTranslations as providerSessionTranslations,
    Domain_reviewWalkthroughTranslations as reviewWalkthroughTranslations,
    Domain_rolesTranslations as rolesTranslations,
    Domain_runPageTranslations as runPageTranslations,
    Domain_scmComparisonTranslations as scmComparisonTranslations,
    Domain_secretsSettingsTranslations as secretsSettingsTranslations,
    Domain_sessionAccessTranslations as sessionAccessTranslations,
    Domain_sessionAgentActivityTranslations as sessionAgentActivityTranslations,
    Domain_sessionBoardTranslations as sessionBoardTranslations,
    Domain_sessionCollaborationPaneTranslations as sessionCollaborationPaneTranslations,
    Domain_sessionCollaborationTranslations as sessionCollaborationTranslations,
    Domain_sessionCompanionTranslations as sessionCompanionTranslations,
    Domain_sessionConversationSurfaceTranslations as sessionConversationSurfaceTranslations,
    Domain_sessionDirectoryRecoveryTranslations as sessionDirectoryRecoveryTranslations,
    Domain_sessionDraftTranslations as sessionDraftTranslations,
    Domain_sessionEmbeddedTranslations as sessionEmbeddedTranslations,
    Domain_sessionFollowTranslations as sessionFollowTranslations,
    Domain_sessionGitBranchesTranslations as sessionGitBranchesTranslations,
    Domain_sessionGitDisplayTranslations as sessionGitDisplayTranslations,
    Domain_sessionGitPaneTranslations as sessionGitPaneTranslations,
    Domain_sessionGitPullRequestTranslations as sessionGitPullRequestTranslations,
    Domain_sessionHomeFreshnessTranslations as sessionHomeFreshnessTranslations,
    Domain_sessionListFilterTranslations as sessionListFilterTranslations,
    Domain_sessionMessageAccountActorTranslations as sessionMessageAccountActorTranslations,
    Domain_sessionPageTranslations as sessionPageTranslations,
    Domain_sessionReminderTranslations as sessionReminderTranslations,
    Domain_sessionRemotePermissionGrantTranslations as sessionRemotePermissionGrantTranslations,
    Domain_sessionResponsibilityTranslations as sessionResponsibilityTranslations,
    Domain_sessionWorkTranslations as sessionWorkTranslations,
    Domain_settingsConnectionsTranslations as settingsConnectionsTranslations,
    Domain_settingsMachinesTranslations as settingsMachinesTranslations,
    Domain_settingsOverviewTranslations as settingsOverviewTranslations,
    Domain_settingsProfilesRemoteHostsPageTranslations as settingsProfilesRemoteHostsPageTranslations,
    Domain_settingsProvidersTranslations as settingsProvidersTranslations,
    Domain_settingsSearchKeywordsTranslations as settingsSearchKeywordsTranslations,
    Domain_settingsSessionPagesTranslations as settingsSessionPagesTranslations,
    Domain_shareSheetTranslations as shareSheetTranslations,
    Domain_sidebarFooterTranslations as sidebarFooterTranslations,
    Domain_surfaceStateTranslations as surfaceStateTranslations,
    Domain_teamsTranslations as teamsTranslations,
    Domain_terminalWorkspaceTranslations as terminalWorkspaceTranslations,
    Domain_thisComputerConnectionTranslations as thisComputerConnectionTranslations,
    Domain_transcriptFindTranslations as transcriptFindTranslations,
    Domain_turnChangesTranslations as turnChangesTranslations,
    Domain_voiceDiagnosticsConsentTranslations as voiceDiagnosticsConsentTranslations,
    Domain_voiceDiagnosticsTranslations as voiceDiagnosticsTranslations,
    Domain_voiceExternalCredentialApprovalTranslations as voiceExternalCredentialApprovalTranslations,
    Domain_voiceLocalCredentialTranslations as voiceLocalCredentialTranslations,
    Domain_voiceMomentsTranslations as voiceMomentsTranslations,
    Domain_voicePresenceTranslations as voicePresenceTranslations,
    Domain_voiceProviderPrivacyTranslations as voiceProviderPrivacyTranslations,
    Domain_voiceReadinessTranslations as voiceReadinessTranslations,
    Domain_voiceRealtimeProviderSetupTranslations as voiceRealtimeProviderSetupTranslations,
    Domain_voiceSettingsPagesTranslations as voiceSettingsPagesTranslations,
    Domain_walkthroughProgressTranslations as walkthroughProgressTranslations,
    Domain_walkthroughSavedTranslations as walkthroughSavedTranslations,
    Domain_walkthroughSettingsTranslations as walkthroughSettingsTranslations,
    Domain_walkthroughStartTranslations as walkthroughStartTranslations,
    Domain_walkthroughTranslations as walkthroughTranslations,
    Domain_widgetAddTranslations as widgetAddTranslations,
    Domain_widgetDefinitionTranslations as widgetDefinitionTranslations,
    Domain_widgetFrameTranslations as widgetFrameTranslations,
    Domain_widgetGlanceTranslations as widgetGlanceTranslations,
    Domain_workStatusTranslations as workStatusTranslations,
    Domain_workflowActionTranslations as workflowActionTranslations,
    Domain_workflowAgentAuthoringTranslations as workflowAgentAuthoringTranslations,
    Domain_workflowBuiltinTranslations as workflowBuiltinTranslations,
    Domain_workflowFieldTranslations as workflowFieldTranslations,
    Domain_workflowEditorPageTranslations as workflowEditorPageTranslations,
    Domain_workflowExamplesTranslations as workflowExamplesTranslations,
    Domain_workflowPluginTranslations as workflowPluginTranslations,
    Domain_workflowRunVisibilityTranslations as workflowRunVisibilityTranslations,
    Domain_workflowRunCompositionTranslations as workflowRunCompositionTranslations,
    Domain_workflowRunListTranslations as workflowRunListTranslations,
    Domain_workflowRunRoleTranslations as workflowRunRoleTranslations,
    Domain_workflowStartTranslations as workflowStartTranslations,
    Domain_workflowsDestinationTranslations as workflowsDestinationTranslations,
    Domain_workflowTriggersTranslations as workflowTriggersTranslations,
    Domain_workflowValueReferenceTranslations as workflowValueReferenceTranslations,
    Domain_workflowTranslations as workflowTranslations,
    Domain_workspaceBarTranslations as workspaceBarTranslations,
    Domain_workspaceSyncDiagnosticTranslations as workspaceSyncDiagnosticTranslations,
    Domain_workspaceTabTranslations as workspaceTabTranslations,
};
