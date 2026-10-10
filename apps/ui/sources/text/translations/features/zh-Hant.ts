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

const accountDisplayTranslations = { 'zh-Hant': { unnamed: '未命名的帳戶', yours: '你的帳戶', shortId: ({ id }) => `ID …${id}` } } as const satisfies Pick<Record<string, AccountDisplayTranslation>, "zh-Hant">;

return { accountDisplayTranslations };
})();

const Domain_accountEncryptionRecoveryTranslations = (() => {
type Copy = Shared_accountEncryptionRecoveryTranslations.Copy;

const en = Shared_accountEncryptionRecoveryTranslations.en;

const zhHant: Copy = {
    recoverAutomationTemplates: '復原舊觸發器',
    recoverAutomationTemplatesDescription: '使用此裝置上的金鑰復原舊觸發器。只要加密工作階段或鎖定的觸發器仍需要金鑰，就會保留它們。',
    recoverAutomationTemplatesAction: '復原',
    recoverAutomationTemplatesComplete: '已復原觸發器。舊金鑰會保留在此裝置上，直到你選擇忘記它。',
    recoverAutomationTemplatesRetained: '已檢查復原。部分觸發器仍處於加密、鎖定或已變更狀態。舊金鑰保留在此裝置上。',
    forgetEncryptionKey: '忘記舊加密金鑰',
    forgetEncryptionKeyDescription: '此裝置上的舊加密工作階段將被鎖定。',
    forgetEncryptionKeyAction: '忘記',
    forgetEncryptionKeyConfirm: '忘記舊加密金鑰？',
    forgetEncryptionKeyWarning: ({ items }) => `此裝置上的舊加密工作階段將被鎖定。以下加密歷史可能無法存取：\n\n${items}\n\n此清單反映目前歷史。在此檢查後於其他裝置上建立的加密工作階段也將被鎖定。復原舊金鑰即可解鎖。不會刪除帳戶中的任何資料。`,
    forgetEncryptionKeySession: ({ name, id }) => `工作階段：${name} (${id})`,
    forgetEncryptionKeyTrigger: ({ id }) => `觸發器：${id}`,
    forgetEncryptionKeyRun: ({ id }) => `執行歷史：${id}`,
    forgetEncryptionKeyEmpty: '未發現加密歷史。',
    forgetEncryptionKeyComplete: '已在此裝置上忘記舊金鑰。',
    forgetEncryptionKeyFailed: '無法忘記金鑰。請重新連線後重試；必須先列出加密歷史。',
};

const accountEncryptionRecoveryTranslations = { 'zh-Hant': zhHant } as const;

return { accountEncryptionRecoveryTranslations };
})();

const Domain_accountPopoverTranslations = (() => {
type AccountPopoverTranslation = Shared_accountPopoverTranslations.AccountPopoverTranslation;

const accountPopoverTranslations = { 'zh-Hant': {
        pageTitle: '帳戶與 Home',
        homesTitle: 'Home',
        notLinkedTo: ({ service }) => `未連結 ${service}`,
        serviceUnavailable: ({ service }) => `無法連線到 ${service}`,
        signedInToThisHome: '已登入此 Home',
        checkingSignIn: '正在檢查登入…',
        signInStatusUnavailable: '登入狀態無法使用',
        machinesOnline: ({ online, total }) => `${total} 台機器中 ${online} 台在線上`,
        noMachines: '還沒有機器',
        connectedNoMachinesOnline: '已連線 · 沒有在線上的機器',
        cantReach: '無法連線',
        signedOut: '已登出',
        signIn: '登入',
        link: '連結',
        linkSubtitle: '在每部裝置上找到你的 Home',
        manageHomes: '管理 Home',
        connectionDetails: '連線詳細資料',
        allHomes: '全部 Home',
        allHomesSubtitle: ({ count }) => `${count} 個 Home · 一個清單`,
        addHome: '新增 Home…',
        addDevice: '新增裝置',
    } } as const satisfies Pick<Record<string, AccountPopoverTranslation>, "zh-Hant">;

return { accountPopoverTranslations };
})();

const Domain_accountServiceOAuthTranslations = (() => {
const en = Shared_accountServiceOAuthTranslations.en;

const zhHant = {
    title: '登入以尋找你的 Home',
    cancelNote: '取消不會登出你現有的 Home。', focusedHomePreserved: '目前聚焦的 Home 不會變更。',
    stages: { signingIn: '正在登入', findingHomes: '正在尋找你的 Homes', waitingApproval: '正在等待 Home 核准' },
    errors: { provider: { title: '提供者未完成登入', body: '請重新開始登入。' }, expired: { title: '此登入要求已過期', body: '請重新開始登入。' }, identityChanged: { title: '登入服務身分已變更', body: '重新連接前，請確認這是你想使用的登入服務。' }, unavailable: { title: '登入服務無法使用', body: '檢查服務後再試一次。現有 Homes 不會變更。' }, exchange: { title: '無法完成登入', body: '未儲存登入服務憑證。請重新開始登入。' }, storage: { title: '無法儲存登入', body: '現有 Home 憑證不會變更。請重新開始登入。' }, homeLink: { title: '已登入，但無法連結此 Home', body: '你的登入已儲存。請再次嘗試連結此 Home。' }, directoryRefresh: { title: '已登入，但無法重新整理 Home 清單', body: '登入服務連線已就緒。請再次嘗試重新整理 Home 清單。' }, homeEnrollment: { title: '已登入，但未新增個人 Home', body: '你的登入已儲存。請再次嘗試新增 Home。' }, invalid: { title: '此登入要求已失效', body: '請重新開始登入。' }, accountDisabled: { title: '此帳戶已停用', body: '請聯絡登入服務的管理員。你現有的 Home 不會改變。' } },
    actions: { startAgain: '重新開始', openHome: ({ homeName }: { homeName: string }) => `開啟 ${homeName}` },
    success: { title: ({ homeName }: { homeName: string }) => `${homeName} 已連線`, body: '你的登入資訊已儲存，可以開始使用這個 Home。' },
    notLinked: { title: ({ homeName }: { homeName: string }) => `${homeName} 尚未連結到此帳號`, signInAction: ({ homeName }: { homeName: string }) => `登入 ${homeName}`, body: ({ homeName }: { homeName: string }) => `直接登入 ${homeName}，或掃描它的 QR 碼、貼上它的 Home 連結。`, scanBody: ({ homeName }: { homeName: string }) => `掃描 ${homeName} 的 QR 碼或貼上它的 Home 連結以連接。` },
    noHomes: { body: '此帳號還沒有 Home。在其他地方新增後重新整理，或掃描 Home 的 QR 碼、貼上其 Home 連結。' },
    approvalWait: { waitingBody: '在你另一部已登入的裝置上核准這次登入。', cancelledTitle: '已停止等待核准', cancelledBody: '你的登入仍然保留，現有 Home 不會改變。' },
} as const;

const accountServiceOAuthTranslations = { zhHant } as const;

return { accountServiceOAuthTranslations };
})();

const Domain_actionConfirmationTranslations = (() => {
type ActionConfirmationTranslations = Shared_actionConfirmationTranslations.ActionConfirmationTranslations;

const actionConfirmationTranslations = { 'zh-Hant': {
        requestedByAgent: '工作階段代理程式要求的動作',
        homeTarget: ({ serverId }) => `Home：${serverId}`,
        sessionTarget: ({ sessionId }) => `目標工作階段：${sessionId}`,
        oneShotConsequence: '核准只適用於這項要求，不會授予未來的 Action 權限或原生權限。',
        homeUnavailable: '此核准屬於本裝置上無法使用的 Home。請重新連接該 Home 後再作決定。',
    } } as const satisfies Pick<Record<string, ActionConfirmationTranslations>, "zh-Hant">;

return { actionConfirmationTranslations };
})();

const Domain_fileContentSearchTranslations = (() => {
const fileContentSearchTranslations = { "zh-Hant": {
        allMatches: ({ matches, files }: { matches: number; files: number }) => `${files} 個檔案中的全部 ${matches} 個相符項目`,
        moreMatches: "全部相符項目",
        textInFiles: "檔案中的文字",
        everything: "全部",
        refineSearch: "縮小搜尋範圍",
        partial: "部分檔案無法搜尋。顯示的結果不完整。",
        updateRequired: "請更新這台機器上的 Happier，以搜尋檔案中的文字。",
        invalidPattern: "正規表示式無效。請修改模式後重試。",
        unavailable: "文字搜尋無法使用。請檢查機器連線後重試。",
        placeholder: "搜尋檔案、訊息、提交、工作階段、設定和操作",
        matchCase: "區分大小寫",
        regex: "正規表示式",
    } };

return { fileContentSearchTranslations };
})();

const Domain_promptPickerTranslations = (() => {
const promptPickerTranslations = { "zh-Hant": {
        "partialHistory": "傳送歷史僅涵蓋已知工作階段。",
        "loadedHistory": "傳送歷史僅顯示已載入的訊息。",
        "open": "開啟提示詞",
        "menu": "提示詞…",
        "placeholder": "搜尋提示詞和已傳送的訊息",
        "favorites": "收藏",
        "library": "提示詞庫",
        "sentBefore": "傳送歷史",
        "builtIn": "內建",
        "readError": "無法讀取此提示詞，請重試。",
        "libraryError": "無法載入提示詞庫。",
        "partialLibrary": "部分提示詞無法讀取。",
        "loadOlder": "搜尋更早的訊息",
        "stop": "停止",
        "insert": "插入",
        "send": "立即傳送",
        "addFavorite": "加入收藏",
        "removeFavorite": "取消收藏",
        "empty": "將訊息儲存為提示詞，即可在這裡重複使用。",
        "applyError": "無法套用提示詞，請重試。",
        "historyError": "無法載入更早的訊息，請重試。",
        "title": "提示詞",
        "clear": "清除",
        "favorite": "收藏",
        "favoritesInvite": "為提示詞或已傳送的訊息加星號即可保留在這裡。",
        "saveAsFavorite": "儲存為收藏的提示詞",
        "saveInPlaceStarred": ({ time }: { time: string }) => `來自你 ${time} 的訊息 · 加星號存入資料庫`,
        "saveInPlace": ({ time }: { time: string }) => `來自你 ${time} 的訊息 · 存入資料庫`,
        "noMatchesFor": ({ query }: { query: string }) => `沒有符合「${query}」的提示詞或已載入訊息`,
        "previewInserts": "插入後由你傳送",
        "previewSent": "先前傳送",
        "previewEdited": ({ time }: { time: string }) => `編輯於 ${time}`,
        "searchingOlder": ({ searched, total }: { searched: number; total: number }) => `正在搜尋更早的訊息… 第 ${searched}/${total} 個工作階段`
    } } as const;

return { promptPickerTranslations };
})();

const Domain_actionFamilyTranslations = (() => {
const fileContentSearchTranslations = {...Domain_fileContentSearchTranslations.fileContentSearchTranslations, ...EnglishFeatures.fileContentSearchTranslations.fileContentSearchTranslations};

const promptPickerTranslations = {...Domain_promptPickerTranslations.promptPickerTranslations, ...EnglishFeatures.promptPickerTranslations.promptPickerTranslations};

const surfaceFamilyLabels = Shared_actionFamilyTranslations.surfaceFamilyLabels;

const english = Shared_actionFamilyTranslations.english;

const translated = Shared_actionFamilyTranslations.translated;

const actionFamilyTranslations = { 'zh-Hant': translated({
        actionFamilies: {
            ...surfaceFamilyLabels,
            workspace_file_search: fileContentSearchTranslations['zh-Hant'].textInFiles,
            find: '尋找',
            app_shell: 'Workspace',
            roles: '角色',
            launch_profiles: '啟動設定檔',
            discovery: '動作探索',
            computer: '電腦控制',
            artifact_access: '產物分享',
            workflows: '工作流程',
            workflow_effects: 'Webhook 與命令',
            notifications: '通知',
            machine_agent_install: '代理安裝',
            machine_agent_sign_in: '代理登入',
            session_access: '工作階段共用',
            session_lifecycle: '工作階段生命週期',
            inventory: '電腦清單',
            messaging: '訊息',
            session_control: '工作階段控制',
            intent_start: '審查與委派',
            review_comments: '審查留言',
            subagent_registry: '子代理',
            execution_run_control: '背景執行',
            session_targeting: '工作階段指定',
            session_follow: '追蹤工作階段',
            session_transcripts: '工作階段記錄',
            session_read_state: '已讀狀態',
            session_attention: '待處理',
            session_board: '工作階段看板',
            session_discussion: '討論',
            session_permissions: '工作階段權限',
            external_sessions: '外部工作階段',
            voice_controls: '語音控制',
            current_ui_context: '目前畫面',
            companion_controls: '夥伴',
            memory: '記憶',
            agent_acp_catalog: 'ACP 代理',
            prompt_library: '提示詞庫',
            daemon_admin: '常駐程式管理',
            browser_control: '瀏覽器控制',
            browser_diagnostics: '瀏覽器診斷',
            browser_context: '瀏覽器內容',
            browser_automation: '瀏覽器自動化',
            browser_recording: '瀏覽器錄製',
            local_services_inventory: '本機服務',
            local_services_launcher: '服務啟動器',
            local_services_preview: '服務預覽',
            local_services_public_preview: '公開預覽',
            local_services_actions: '服務動作',
            peer_mediation_observability: '連線診斷',
            devices_simulator: '模擬器',
            approvals: '核准',
            plugin_dev_loop: '外掛程式開發',
            plugin_settings_administration: '外掛程式設定',
            plugin_permission_grants: '外掛程式權限',
            plugin_webhooks: '外掛程式 Webhook',
            account_plugin_data: '外掛程式資料',
            account_sessions: '已登入裝置',
            account_security: '帳戶安全性',
            account_api_tokens: 'API 權杖',
            identity_github_apps: 'GitHub 應用程式',
            identity_providers: '登入提供者',
            machine_pools: '電腦集區',
            ephemeral_runner: '執行器',
            automation_events: '自動化事件',
            automation_conversation: '自動化對話',
            scm_git: 'Git',
            scm_pull_request: '提取要求',
            scm_repository: '存放庫',
            scm_diff_summary: '差異摘要',
            home_governance: 'Home 管理',
            teams: '團隊',
            saved_secret_sharing: '共用密鑰',
        },
    }) } as const;

return { actionFamilyTranslations };
})();

const Domain_addFlowsTranslations = (() => {
type AddFlowsTranslation = Shared_addFlowsTranslations.AddFlowsTranslation;

const addFlowsTranslations = { 'zh-Hant': {
        addHome: '新增 Home',
        addHomeSubtitle: '登入、依位址連線或使用代管的 Home',
        addHomeDescription: '連線你已在使用的 Home，或使用為你代管的 Home。',
        newGroup: '新增群組',
        newGroupSubtitle: '一起檢視多個 Home 的工作階段',
        groupsTitle: '群組',
        homesInUse: '此處正在使用',
        thisDeviceTitle: '此裝置',
        thisDeviceSubtitle: '它如何連線到各個 Home',
        thisDeviceDescription: '此裝置如何連線到各個 Home：等待加入的裝置、使用的連線以及它執行的 Home。',
        newHomeDraft: '新 Home',
        homeMissingTitle: '此裝置上沒有這個 Home',
        homeMissingDescription: '它已被移除，或儲存在另一台裝置上。',
        homeManageTitle: '管理',
        homeAdministrationSubtitle: '此 Home 的成員、登入、存取與資料',
        groupMissingTitle: '此群組已不存在',
        groupMissingDescription: '它已被移除。你的 Home 沒有變化。',
        discard: '捨棄',
        sshSignInAgent: '此電腦上的 SSH 代理',
        sshSignInKeyFile: '此電腦上的私鑰檔案',
        sshSignInPassword: '僅用於本次連線，從不儲存',
        addMachineMenuSubtitle: '一台電腦或伺服器',
        addMachineDescription: '新增一台電腦或伺服器，讓代理在上面執行你的工作階段。',
        machineJoinsHome: ({ home }) => `加入 ${home}`,
        pathThisComputerTitle: '這台電腦',
        pathThisComputerTask: '一步完成設定',
        pathThisComputerCommand: '在終端機執行一條指令',
        pathSshTitle: '透過 SSH 的伺服器',
        pathSshChip: 'SSH 伺服器',
        pathSshSubtitle: '開發機、虛擬機或雲端伺服器',
        pathAnotherTitle: '另一台電腦',
        pathAnotherSubtitle: '在那台電腦上開啟 Home 連結',
        machinePoolPrompt: '希望工作階段在機器之間自動切換？',
        thisComputerCommandLead: ({ home }) => `在這台電腦的終端機中執行。它會安裝 Happier 並加入 ${home}；一旦就緒，此頁面會立刻偵測到。`,
        thisComputerTaskLead: ({ machine, home }) => `${machine} 將為 ${home} 執行代理。Happier 會安裝一個隨電腦啟動的小型背景服務。`,
        setUpThisComputer: '設定這台電腦',
        desktopAppHint: '更想點一下而不是打指令？',
        desktopAppLink: '取得桌面應用程式——它會自動設定這台電腦。',
        thisComputerRunningLead: ({ machine }) => `正在設定 ${machine}。你可以繼續使用 Happier。`,
        onAnotherHomeTitle: ({ machine }) => `${machine} 已連線到另一個 Home`,
        onAnotherHomeBody: ({ home }) => `它的 Happier 服務正在為另一個 Home 執行工作階段。移到 ${home} 會保留設定；既有工作階段留在原處。`,
        moveToHome: ({ home }) => `移到 ${home}`,
        keepOnOtherHome: '保持不變',
        sshLeadTask: ({ home }) => `你已能透過 SSH 存取的開發機、虛擬機或雲端伺服器。這台電腦會連上它、安裝 Happier 並加入 ${home}。`,
        sshLeadCommand: ({ home }) => `可透過 SSH 存取的開發機、虛擬機或雲端伺服器。在能存取它的電腦上執行指令；它會安裝 Happier 並加入 ${home}。`,
        setUpHost: ({ host }) => `設定 ${host}`,
        sshSavedNote: '主機會儲存到「遠端主機」；密碼從不儲存。',
        sshRunningTitle: ({ host }) => `正在設定 ${host}`,
        sshRunningLead: '正在從這台電腦透過 SSH 執行。你可以離開；機器清單會顯示進度並在完成時通知你。',
        anotherLead: ({ home }) => `在那台電腦的終端機中執行。它會安裝 Happier 並加入 ${home}。`,
        anotherTerminalAction: '改用終端機指令',
        machineWatching: ({ subject }) => `正在等待 ${subject} 加入 `,
        subjectThisComputer: '這台電腦',
        subjectAnotherComputer: '那台電腦',
        machineNotSeeingTitle: ({ subject }) => `還沒看到 ${subject}？`,
        machineNotSeeingBody: ({ home }) => `Happier 仍在等待。通常是設定出錯停止、機器無法連到 ${home}，或它被設定到了另一個 Home。`,
        machineArrived: ({ machine }) => `${machine} 已連線`,
        machineConnectedJustNow: '剛剛連線',
        machineStartSession: ({ machine }) => `在 ${machine} 上開始工作階段`,
        machineAddAnother: '再新增一台',
        cancelSetup: '取消',
        detectedOs: '已偵測',
        sshSuggestionsTitle: '來自你的 SSH 設定和已儲存的主機',
        connectingToHome: ({ address }) => `正在連線 ${address}…`,
        pathThisComputerConnected: '已連線 · 檢視其代理',
    } } satisfies Pick<Readonly<Record<string, AddFlowsTranslation>>, "zh-Hant">;

return { addFlowsTranslations };
})();

const Domain_agentInstallJobTranslations = (() => {
const en = Shared_agentInstallJobTranslations.en;

const agentInstallJobTranslations = { zhHant: { ...en } };

return { agentInstallJobTranslations };
})();

const Domain_agentStartTranslations = (() => {
const en = Shared_agentStartTranslations.en;

const zhHant: typeof en = {
    titles: {
        conversation: '旁邊的對話',
    },
    descriptions: {
        conversation: ({ machine }) => `隨便問，不會打斷這個工作階段。它在 ${machine} 上並行執行；除非你傳送，否則不會傳回任何內容。`,
    },
    chips: {
        engineTitle: '由誰回答',
        addReviewer: '新增審查者',
        removeReviewer: ({ name }) => `移除 ${name}`,
        scope: '審查範圍',
        advanced: '進階',
    },
    reportToSession: '向此工作階段回報',
    startsWhenYouSend: ({ count }) => count > 1 ? `傳送後開始 ${count} 項審查` : '傳送後開始',
    offline: ({ machine }) => `${machine} 離線。代理會在那裡啟動；草稿會保留在這裡，直到它恢復。`,
    menu: {
        askSection: '讓代理',
        secondOpinionTitle: '第二意見',
        secondOpinionSubtitle: '完成前的獨立檢查',
        keepGoingTitle: '持續到完成…',
        keepGoingSubtitle: '在目標控制項中設定目標',
        runWorkflowTitle: '執行工作流程',
        runWorkflowSubtitle: '來自你的資料庫或內建',
        searchWorkflows: '搜尋工作流程…',
        yourLibrary: '你的資料庫',
        noWorkflows: '還沒有已儲存的工作流程',
        addTriggerTitle: '新增觸發器…',
        addTriggerSubtitle: '每次發生某事時在這裡執行',
        advancedTitle: '進階…',
        advancedSubtitle: '多個代理、權限、設定檔',
        builtIn: '內建',
        allWorkflows: '所有工作流程…',
    },
    role: {
        replaces: ({ agent }) => `取代 ${agent}`,
    },
    startRow: {
        subtitle: '草稿 · 傳送後開始',
        conversation: '新對話',
        review: '新審查',
        plan: '新計畫',
        delegate: '新任務',
    },
    pane: {
        cancelRun: '取消執行',
        whenItFinishes: '完成後',
        sendToSession: ({ session }) => `傳送到 ${session}`,
        replyTo: ({ agent }) => `回覆 ${agent}…`,
        repliesGoTo: ({ session }) => `回覆會傳給這個代理，而不是 ${session}`,
    },
};

const agentStartTranslations = { zhHant };

return { agentStartTranslations };
})();

const Domain_apiTokenSettingsTranslations = (() => {
const english = Shared_apiTokenSettingsTranslations.english;

const translated = Shared_apiTokenSettingsTranslations.translated;

const apiTokenSettingsTranslations = { 'zh-Hant': translated({
        settingsApiTokens: {
            encryption: {
                choice: "加密存取",
                consequence: "授予整個帳戶的加密存取權限。撤銷將停止未來的 API 授權；已取得的金鑰或資料無法收回。",
                enabled: "已啟用加密存取",
                bearerOnly: "僅 API 存取",
                unknown: "加密存取未知",
                outcomeUnknown: "建立可能已完成。請重新整理清單並撤銷此權杖，然後再主動建立替代權杖。",
                unsupported: "此 Home 尚不支援加密 API 權杖。請更新它或建立一般權杖。",
                notReady: "建立加密權杖之前，請在此 Home 恢復加密存取。",
                stale: "帳戶加密金鑰已變更。請在此 Home 恢復存取。",
                idConflict: "此權杖 ID 已存在。請先撤銷該確切權杖，再建立新權杖。",
            },
            unattended: {
                choice: "無人值守團隊存取",
                consequence: "將此憑證目前已驗證的驗證方式複製到權杖，用於受限團隊工作。加密存取權限另行設定。",
                authorized: "已授權無人值守團隊存取",
                notAuthorized: "無無人值守團隊存取",
                evidenceLimit: "此憑證包含過多已驗證的驗證方式，無法複製。未建立權杖。",
                evidenceUnavailable: "此已登入憑證沒有可複製的目前驗證憑據。請使用所需方式重新驗證；未建立權杖。",
            },
            title: 'API 權杖',
            entrySubtitle: '讓指令碼、伺服器和內嵌應用程式代表你執行操作，且只擁有你授予的存取權。',
            tokens: 'API 權杖',
            refreshing: '正在重新整理…',
            emptyTitle: '尚無 API 權杖',
            emptyBody: '權杖可讓受信任的指令碼和工具執行你允許的自動化操作。當整合需要存取目前帳戶時，請建立權杖。',
            created: '建立時間',
            lastUsed: '上次使用',
            neverUsed: '從未使用',
            securityTitle: '安全性',
            securityFooter: '這些操作會影響整個目前帳戶。',
            status: {
                active: '有效',
                expiresInMinutes: ({ count }) => `${count} 分鐘後過期`,
                expiresInHours: ({ count }) => `${count} 小時後過期`,
                expiresInDays: ({ count }) => `${count} 天後過期`,
                expired: '已到期',
            },
            rowAccessibilityLabel: ({ label, state }) => `${label}，${state}`,
            moreActionsAccessibilityLabel: ({ label }) => `${label}的更多操作`,
            create: {
                button: '建立權杖',
                title: '建立 API 權杖',
                subtitle: '為整合命名，並選擇此權杖的到期時間。您的 Home 可以讀取一般 API 請求和結果；加密存取可保護支援的 SDK 呼叫。',
                submit: '建立權杖',
                label: '標籤',
                labelPlaceholder: '發佈自動化',
                expiry: '到期時間',
                expiryOptions: {
                    '30d': '30 天',
                    '90d': '90 天',
                    '1y': '1 年',
                    none: '永不到期',
                },
                access: '存取權',
                accessFull: '完整存取',
                accessLimited: '受限',
                accessLimitedDescription: '接著選擇動作、工作階段、模型和網站。',
                accessTitle: '選擇存取權',
                continue: '繼續',
                back: '返回',
                actionSettingsPrefix: '此權杖可執行目前帳戶的',
                actionSettingsLink: '動作設定中為 External API 與 SDK 啟用的任何操作。',
            },
            reveal: {
                title: '儲存你的 API 權杖',
                accessibilityAnnouncement: '請立即複製權杖；它只會顯示一次。',
                successTitle: '已建立權杖',
                shownOnce: '請立即複製此權杖。為了你的安全，Happier 無法再次顯示它。',
                copy: '複製權杖',
                copied: '已複製',
                dismissTitle: '不確認就離開嗎？',
                dismissBody: '此權杖不會再次顯示。請先複製它，或確認你已將它儲存在安全的位置。',
                copyFirst: '保持權杖可見',
                savedIt: '我已儲存',
            },
            revoke: {
                title: ({ label }) => `要撤銷「${label}」嗎？`,
                body: '伺服器和 API 存取會在下次驗證時停止。最近驗證過此 API 權杖的本機常駐程式，可能仍會繼續接受它最多一分鐘。此操作無法復原。',
                confirm: '撤銷權杖',
            },
            revokeAll: {
                title: '撤銷所有 API 權杖',
                subtitle: '停用此帳戶的所有 API 權杖。',
                body: '伺服器和 API 存取會在下次驗證時停止。使用這些權杖的內嵌將停止運作，其內嵌憑證也會被登出。最近驗證過這些 API 權杖的本機常駐程式，可能仍會繼續接受它們最多一分鐘。此操作無法復原。',
                confirm: '全部撤銷',
                railAction: '撤銷所有 API 權杖…',
            },
            signOutEverywhere: {
                title: '在所有位置登出',
                subtitle: '結束此帳戶的所有已登入工作階段。',
                body: '瀏覽器和裝置上的所有已登入工作階段都會結束。API 權杖仍會保持有效；請在此畫面中個別撤銷它們。',
                confirm: '在所有位置登出',
            },
            errors: {
                labelRequired: '請先輸入標籤，再建立權杖。',
                accountChanged: '你的使用中帳戶或 Home 已變更，因此未做任何變更。請重新開啟以繼續。',
                presentUserRequired: '請在登入提示中確認你的身分，然後再試一次。',
                offline: 'Happier 無法存取你的帳戶。請檢查連線後再試一次。',
                unavailable: '此操作目前無法使用。請稍後再試一次。',
                copyFailed: '無法複製權杖。請在關閉前選取它並手動複製。',
                listTitle: 'API 權杖無法使用',
                grantIncomplete: '請先完成存取權選擇，再建立權杖。',
            },
            embedPill: '內嵌',
            embedRowHint: '在設定的「內嵌」中開啟此內嵌。',
            summary: {
                full: '完整存取',
                allActions: '所有動作',
                namesAndMore: ({ names, count }) => `${names} +${count}`,
                sessions: ({ count }) => (count === 1 ? '1 個工作階段' : `${count} 個工作階段`),
                computers: ({ count }) => (count === 1 ? '1 台電腦' : `${count} 台電腦`),
                approve: '可核准',
                models: ({ count }) => (count === 1 ? '1 個模型' : `${count} 個模型`),
                websites: ({ count }) => (count === 1 ? '1 個網站' : `${count} 個網站`),
                content: '內容存取',
                noExpiry: '永不過期',
                expires: ({ date }) => `${date} 到期`,
                expired: ({ date }) => `已於 ${date} 到期`,
            },
            grant: {
                accessTitle: '存取權',
                back: '存取權',
                onlyThese: '僅限這些',
                selectedCount: ({ count }) => (count === 1 ? '已選 1 項' : `已選 ${count} 項`),
                reviewUnnamed: '此權杖',
                actions: {
                    title: '動作',
                    all: '所有動作',
                    none: '請至少選擇一個動作',
                    search: '搜尋動作',
                    noMatches: ({ query }) => `沒有符合「${query}」的動作`,
                    groupDescription: '選擇整個群組也會涵蓋之後新增到該群組的動作。',
                    familyCount: ({ count }) => (count === 1 ? '群組 · 1 個動作' : `群組 · ${count} 個動作`),
                    includedByFamily: ({ family }) => `包含在 ${family} 中`,
                },
                targets: {
                    title: '工作階段和電腦',
                    all: '所有工作階段和電腦',
                    none: '請至少選擇一個工作階段或一台電腦',
                    computers: '電腦',
                    computersDescription: '一台電腦涵蓋其上現在及以後的所有工作階段。',
                    sessions: '工作階段',
                    searchSessions: '搜尋工作階段',
                    noSessions: '尚無工作階段',
                    noSessionMatches: ({ query }) => `沒有符合「${query}」的工作階段`,
                    noComputers: '尚無電腦',
                },
                models: {
                    title: '模型',
                    any: '任何模型',
                    onlyThese: '僅限這些模型',
                    none: '請至少選擇一個模型',
                    pickerDescription: '其他模型會被拒絕，而不只是隱藏。選擇模型後將不再提供「自動」。',
                    noModels: '尚無可選擇的模型',
                },
                approve: {
                    title: '核准請求',
                    on: '它可以核准上述工作階段中的工具使用和請求——包括它自己發起的請求。它永遠無法變更權杖、安全性或外掛程式。',
                    off: '請求會在 Happier 中等候你處理。',
                },
                websites: {
                    title: '網站',
                    description: '這些網站上的頁面可以在瀏覽器中使用此權杖。指令碼和伺服器請留空。',
                    inputLabel: '新增網站',
                    placeholder: 'https://app.example.com',
                    add: '新增',
                    invalid: '請以 https:// 開頭，localhost 可使用 http://。',
                    duplicate: '此網站已在清單中。',
                    remove: ({ origin }) => `移除 ${origin}`,
                },
            },
            detail: {
                whatItCanDo: '它能做什麼',
                whatItCanDoDescription: '此權杖可以代表你執行的動作。其他一切都會被拒絕。',
                everyAction: '為 External API 與 SDK 啟用的所有動作',
                wholeGroup: '整個群組',
                where: '範圍',
                whereDescription: '它可以存取的工作階段和電腦。',
                computerCovers: '此電腦上的所有工作階段',
                unknownComputer: '已不在清單中的電腦',
                unknownSession: '已不在清單中的工作階段',
                modelsDescription: '其他模型會被拒絕，而不只是隱藏。',
                approvals: '核准',
                approvesOn: '會核准請求',
                approvesOff: '不會核准請求',
                websitesDescription: '這些網站的瀏覽器頁面可以使用它。',
                noWebsites: '僅限指令碼和伺服器',
                content: '內容存取',
                contentOn: '它可以透過支援的 SDK 呼叫讀取端對端加密內容。',
                contentOff: '它無法讀取端對端加密內容。',
                children: '內嵌憑證',
                childrenDescription: '你的應用程式從此權杖為其頁面簽發的短期金鑰。',
                childrenCount: ({ count }) => (count === 1 ? '1 個有效' : `${count} 個有效`),
                childrenConsequence: '編輯存取權或撤銷此權杖時會被登出。',
                sessionLimits: '工作階段',
                sessionLimitsDescription: '它可以啟動的工作階段，以及其訊息可使用的權限模式。',
                createsSessions: '啟動工作階段',
                createsSessionsOn: ({ computer }: { computer: string }) => `在 ${computer} 上，位於 Happier 管理的私人資料夾中。`,
                editAccess: '編輯存取權',
                revokeFootnote: '使用它的指令碼和內嵌將在下次請求時停止運作。',
                created: ({ date }) => `建立於 ${date}`,
                lastUsed: ({ date }) => `上次使用於 ${date}`,
                missingTitle: '此權杖已不存在',
                missingBody: '它已被撤銷或已到期並被移除。你的其他權杖仍在清單中。',
                backToTokens: '顯示 API 權杖',
            },
            edit: {
                title: '編輯存取權',
                save: '儲存',
                signsOut: '有效的內嵌憑證將被登出。',
            },
            cliPolicy: {
                sectionTitle: 'CLI 和常駐程式',
                sectionDescription: '你電腦上的指令可以使用你的登入身分做什麼。',
                title: '允許透過 CLI 和常駐程式進行核准和帳戶變更',
                description: '允許你電腦上的指令核准請求並變更帳戶設定。如果代理以 shell 存取權執行，請關閉此項。個別電腦也可以透過 HAPPIER_CLI_PRESENT_USER=disallowed 選擇退出。變更此設定會讓你的電腦短暫重新連線。',
                unavailable: '無法讀取此設定。請稍後再試一次。',
                saveFailed: '無法變更此設定。請稍後再試一次。',
            },
            notices: {
                revoked: '已撤銷 API 權杖。',
                revokedAll: '已撤銷所有 API 權杖。',
                signedOutEverywhere: '已在所有位置登出。API 權杖仍保持有效。',
            },
        },
    }) } as const;

return { apiTokenSettingsTranslations };
})();

const Domain_artifactsBrowserTranslations = (() => {
type ArtifactsBrowserTranslations = Shared_artifactsBrowserTranslations.ArtifactsBrowserTranslations;

const artifactsBrowserTranslations = { 'zh-Hant': {
        description: '你和你的代理儲存的內容，隨時可閱讀、重複使用和分享。',
        newDocument: '新增文件',
        searchPlaceholder: '搜尋成品',
        kindLabel: '類型',
        sourceLabel: '來源',
        kinds: {
            all: '所有類型',
            document: '文件',
            prompt: '提示詞',
            memory: '記憶',
            board: '看板',
            workflow: '工作流程',
            role: '角色',
            launchProfile: '啟動設定檔',
        },
        kindOne: {
            document: '文件',
            prompt: '提示詞',
            memory: '記憶',
            board: '看板',
            workflow: '工作流程',
            role: '角色',
            launchProfile: '啟動設定檔',
        },
        sort: {
            label: '排序',
            updated_desc: '最近更新',
            created_desc: '最近建立',
            title_asc: '標題',
        },
        view: {
            label: '檢視',
            grid: '網格',
            list: '清單',
            folders: '資料夾',
        },
        folders: {
            newFolder: '新增資料夾',
            newFolderInside: '在其中新增資料夾',
            rename: '重新命名',
            moveTo: '移至資料夾…',
            moveItemTo: ({ name }) => `將「${name}」移至`,
            newFolderEllipsis: '新增資料夾…',
            moveVerb: '移至',
            topLevel: '最上層',
            moveToTopLevel: '移至最上層',
            deleteFolder: '刪除資料夾',
            deleteTitle: ({ name }) => `刪除「${name}」？`,
            deleteBody: '其中的項目和資料夾會上移一層。不會刪除任何內容。',
            nameHelp: '資料夾只屬於你。歸檔不會改變共享對象看到的內容。',
            namePlaceholder: '資料夾名稱',
            create: '建立',
            options: ({ name }) => `${name} 選項`,
            expand: ({ name }) => `展開 ${name}`,
            collapse: ({ name }) => `收合 ${name}`,
            columnName: '名稱',
            columnEdited: '編輯時間',
            emptyInvite: '還沒有資料夾。把相關內容歸在一起；只有你看得到自己的歸檔方式。',
            unavailable: '無法從此 Home 載入資料夾。所有內容皆不依資料夾列出。',
            saveFailed: '變更未儲存。請再試一次。',
            refusedCycle: '資料夾無法移到自身之內',
            refusedUnavailable: '資料夾暫時無法使用',
            refusedOther: '無法移到那裡',
            showAllKinds: '在成品中顯示所有類型',
            promptSearch: '搜尋提示詞與技能',
        },
        provenance: {
            savedByYou: '由你儲存',
            sharedWithYou: '與你共用',
            fromFile: ({ name }) => `來自 ${name}`,
            openSession: ({ session }) => `開啟 ${session}`,
        },
        emptyTitle: '保留代理的成果',
        emptyBody: '你或代理儲存的計畫、筆記、程式碼和看板都會出現在這裡——在任何裝置上都能閱讀，並可隨時與團隊分享。',
        emptyHint: '或請代理「把它儲存為成品」。',
        loadFailedTitle: '無法載入你的成品',
        loadFailedBody: '請檢查網路連線後重試。沒有任何內容遺失。',
        quota: {
            accountTitle: '成品儲存空間已滿',
            documentTitle: '太大，無法儲存',
            accountBody: ({ used, limit }) => `已用 ${used} / ${limit}（含版本）。刪除或匯出不再需要的成品即可儲存新的成品。`,
            documentBody: ({ size, limit }) => `將達到 ${size}；每個成品最多 ${limit}。你的編輯仍然保留。`,
        },
        open: {
            document: '開啟文件',
            prompt: '開啟提示詞',
            memory: '開啟記憶',
            board: '開啟看板',
            workflow: '開啟工作流程',
            role: '開啟角色',
            launchProfile: '開啟啟動設定檔',
        },
        openAsPage: '以頁面開啟',
        actions: {
            edit: '編輯',
            history: '歷史',
            share: '分享',
            more: '更多動作',
            copyLink: '複製連結',
            linkCopied: '已複製連結',
        },
        history: {
            title: '歷史',
            current: '目前',
            now: '現在',
            restoreNote: '還原會將其新增為新版本，不會遺失任何內容。',
            loadFailed: '無法載入歷史記錄，請重試。',
            empty: '還沒有更早的版本。每次儲存都會保留一個。',
            versionsLabel: '版本',
            restoreFailed: '無法還原此版本，請重試。',
            savedByUser: '由使用者儲存',
            savedByAgentSession: '由代理工作階段儲存',
            restoredVersion: ({ n }) => `從版本 ${n} 還原`,
            version: ({ n }) => `版本 ${n}`,
            keeps: ({ count }) => `保留最近 ${count} 個版本。`,
            restore: ({ n }) => `還原版本 ${n}`,
        },
        savedToday: ({ count }) => `今天儲存了 ${count} 個`,
        noMatch: ({ query }) => `沒有符合「${query}」的成品`,
        storage: {
            meter: ({ used, limit }) => `${used} / ${limit}`,
            a11y: ({ used, limit }) => `成品儲存空間：已用 ${used} / ${limit}`,
        },
        facts: {
            edited: ({ age }) => `${age}編輯`,
        },
    } } satisfies Pick<Record<'en' | 'fr' | 'de' | 'es' | 'it' | 'pt' | 'ca' | 'ru' | 'pl' | 'ja' | 'zh-Hans' | 'zh-Hant', ArtifactsBrowserTranslations>, "zh-Hant">;

return { artifactsBrowserTranslations };
})();

const Domain_automationPageTranslations = (() => {
const english = Shared_automationPageTranslations.english;

const translated = Shared_automationPageTranslations.translated;

const slavicPlural = Shared_automationPageTranslations.slavicPlural;

const automationPageTranslations = { 'zh-Hant': translated({
        automationPages: {
            index: {
                description: '自動開始的工作：依排程、由 Event 觸發，或在工作階段的一輪結束時開始。',
            },
            settings: {
                description: '每台機器承接多少自動化工作，以及已完成的執行保留多久。',
                capacityTitle: '容量',
                capacityDescription: '適用於每台執行自動化的機器。',
                historyTitle: '執行歷史',
                historyDescription: '仍可從自動化中開啟的已完成執行。',
            },
            detail: {
                description: '只要任一觸發器觸發，就會自動開始工作。',
                triggerCount: ({ count }: { count: number }) => `${count} 個觸發器`,
                overviewDescription: '它執行什麼，以及如何啟動或變更它。',
                runNowSubtitle: '立即開始一次執行，無需等待觸發器。',
                editSubtitle: '變更名稱、執行內容和觸發器。',
                machineAssignmentsDescription: '可以承接此自動化執行的機器。',
            },
            run: {
                description: '是什麼啟動了這次執行、在哪裡執行，以及產生了什麼。',
                statusTitle: '狀態',
                statusDescription: '這次執行現在的進度，以及你還能對它做什麼。',
                causeTitle: '啟動原因',
                causeDescription: '准許這次執行的觸發器和事件。之後不會改變。',
            },
            gate: {
                serverTitle: '此 Home 已關閉自動化',
                serverBody: '此 Home 的管理員已關閉自動化。請聯絡其中一位管理員重新開啟。',
                openFeatures: '開啟功能設定',
                unknownTitle: '暫時無法檢查自動化',
                unknownBody: 'Happier 無法連線到此 Home 以檢查自動化是否已開啟。請在它恢復上線後再次檢查。',
                unsupportedTitle: '此 Home 尚不支援自動化',
                unsupportedBody: '它的伺服器版本早於自動化功能。請更新 Home 的伺服器以使用自動化。',
                unsupportedContextTitle: '此處無法使用自動化',
                unsupportedContextBody: '你正在檢視的 Home 並非都支援自動化。',
            },
            editor: {
                description: '為它命名，選擇它執行的內容，然後新增啟動它的觸發器。',
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

const automationTriggerSetTranslations = { 'zh-Hant': {
        pluralEditor: {
            ...expandedLifecycleEnglish,
            lifecycleEvent: {
                ...expandedLifecycleEnglish.lifecycleEvent,
                sessionStarted: '工作階段開始時',
                sessionArchived: '工作階段封存時',
            },
            triggersTitle: '觸發器',
            emptyBody: '沒有自動觸發器。你仍可手動執行此自動化。', orSemantics: '可新增任意數量的觸發器。它們彼此獨立，任意一個符合條件時都會執行自動化。',
            enabledSubtitle: '暫停整個自動化，而不變更任何觸發器。', addTrigger: '新增觸發器', addTriggerSubtitle: '設定排程、連接事件，或等待某個指定輪次結束。',
            scheduleTitle: '排程', eventTitle: '外掛事件', turnCompletedTitle: '當此輪次結束時', turnCompletedSubtitle: '在所選的確切父輪次完成後執行一次。', selectedSession: '已選工作階段',
            turnCompletedSource: ({ session, ordinal }: { session: string; ordinal: number }) => `${session} · 單次觸發器 ${ordinal}`,
            scheduleInterval: ({ minutes, timezone }: { minutes: number; timezone: string | null }) => `每 ${minutes} 分鐘${timezone ? ` · ${timezone}` : ''}`,
            scheduleCron: ({ expression, timezone }: { expression: string; timezone: string | null }) => `${expression}${timezone ? ` · ${timezone}` : ''}`,
            eventSubtitle: ({ pluginId, eventId }: { pluginId: string; eventId: string }) => `${pluginId} · ${eventId}`,
            triggerEnabledLabel: ({ title }: { title: string }) => `啟用${title}`, editScheduleTitle: '編輯排程', scheduleType: '排程類型', chooseSession: '選擇進行中的工作階段',
            eventEditorUnavailable: '目前機器無法設定事件。', removeTitle: '移除此觸發器？', removeBody: '此觸發器之後的事件將不再啟動自動化。現有執行記錄不會變更。',
        },
        exactTurn: {
            eventSearchPlaceholder: '搜尋事件',
            refreshFailedTitle: '無法重新整理自動化',
            refreshFailedBody: '目前無法讀取自動化清單。請重試以載入目前的清單。',
            actionTitle: '當此輪次結束時…', createNew: '建立新自動化', createNewSubtitle: '以已選取的這個確切輪次開始。',
            addToExistingSubtitle: '將這個確切輪次加入現有自動化。', searchPlaceholder: '搜尋自動化', eventListA11y: '選擇工作階段生命週期事件', destinationA11y: '選擇要將此輪次觸發器加入何處',
            staleTitle: '此輪次已變更', staleBody: '所選輪次已不再是目前作用中的父輪次。請重新整理並明確選取目前輪次。',
            useCurrentTurn: '使用目前輪次', unavailable: '目前沒有可用的作用中父輪次。',
            resolvingRowSubtitle: '正在檢查你可以使用哪些自動化…',
            unavailableRowSubtitle: '詳細資訊無法使用 — 無法針對此工作階段驗證此自動化。',
            incompleteNoticeTitle: '部分自動化無法讀取',
        },
    } } as const;

return { automationTriggerSetTranslations };
})();

const Domain_boardsTranslations = (() => {
type Count = Shared_boardsTranslations.Count;

type BoardsTranslations = Shared_boardsTranslations.BoardsTranslations;

const en = Shared_boardsTranslations.en;

const zhHant: BoardsTranslations = {
    title: '面板',
    newBoard: '新面板',
    defaultName: '未命名面板',
    index: {
        title: '你的面板',
        body: '面板把工作階段、執行、工作流程和裝置即時匯聚在同一處，依你的方式排列。',
    },
    notFound: {
        title: '這個面板已不存在',
        body: '它已被刪除，或屬於此處未連線的 Home。',
    },
    meta: {
        needYou: ({ count }) => `${count} 項需要你`,
        items: ({ count }) => `${count} 項`,
        handPicked: '手動挑選',
        empty: '空',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: '需要你', description: '所有在等你處理的事項' },
        running: { title: '正在執行', description: '進行中的工作流程執行' },
        my_machines: { title: '我的裝置', description: '連線狀態以及每台裝置上執行的內容' },
        filter: { title: '工作階段', description: '所有使用中的工作階段' },
    },
    header: {
        layoutA11y: '面板版面',
        canvas: '畫布',
        byStatus: '依狀態',
        add: '加入面板',
        settings: '面板設定',
    },
    kinds: {
        session: '工作階段',
        workflow_run: '工作流程執行',
        workflow: '工作流程',
        machine: '裝置',
    },
    card: {
        untitled: '無法使用的項目',
        unavailable: '無法使用',
        unavailableBody: '它的 Home 未在此裝置上連線。它會保留在面板上。',
        notLoaded: '尚未載入',
        remove: '從面板移除',
        moveHint: '方向鍵可在格線上移動此卡片。',
        moved: ({ x, y }) => `已移動到 ${x}, ${y}`,
        moveActions: { up: '上移', down: '下移', left: '左移', right: '右移' },
        machine: {
            online: '線上',
            offline: '離線',
            running: ({ count }) => `${count} 個工作階段正在執行`,
            needYou: ({ count }) => `${count} 項需要你`,
            idle: '沒有正在執行的工作階段',
            offlineBody: '它的工作階段會等它回來。',
        },
        workflow: {
            noRuns: '還沒有執行紀錄',
            lastRun: ({ word, age }) => `上次執行 ${age} · ${word}`,
            needYou: ({ count }) => `${count} 項需要你`,
        },
        run: {
            waitingForYou: '等待你的審閱',
            started: ({ age }) => `${age}開始`,
        },
    },
    canvas: {
        snapsHere: '會吸附到這裡',
        snapOnceHint: '按住 ⇧ 可單次對齊格線',
    },
    settings: {
        title: '面板設定',
        name: '名稱',
        whatsOn: '此面板上有什麼',
        whichSessions: '哪些工作階段',
        addedByHand: '手動加入',
        addedByHandNone: '尚無',
        add: '加入',
        layout: '版面',
        layoutDescription: '切換時，畫布會保留你的排列。',
        snap: '吸附到格線',
        pin: '顯示在工作階段清單中',
        pinDescription: '將此面板固定在你的工作階段上方。',
        delete: '刪除面板',
        deleteConfirmTitle: '刪除這個面板？',
        deleteConfirmBody: '只會刪除面板。其中的工作階段、執行、工作流程和裝置都會維持原樣。',
    },
    add: {
        title: '加入面板',
        search: '搜尋項目',
        groups: { sessions: '工作階段', workflows: '工作流程', runs: '工作流程執行', machines: '裝置' },
        onBoard: '在此面板上',
        addHint: '加入',
        addAndPlaceHint: '新增並放置',
        empty: '沒有符合的項目。',
    },
    empty: {
        title: '選擇此面板顯示什麼',
        body: '手動加入工作階段、工作流程、執行或裝置，或顯示「需要你」這樣的區段。排列由你決定，面板讓它們保持即時。',
        action: '加入面板',
    },
    widgets: {
        group: '小工具',
        kind: '小工具',
        gallery: '開啟圖庫',
        galleryHint: '所有小工具，附即時預覽',
        addHint: '面板只有你看得到',
        widthOne: '一張卡片寬',
        widthTwo: '兩張卡片寬',
        moveEarlier: '往前移',
        moveLater: '往後移',
        remove: '從面板移除',
        menuA11y: ({ widget }) => `${widget} 選項`,
        arrived: ({ count }) => `剛剛新增了 ${count} 個小工具`,
        undo: '復原',
        dismiss: '忽略',
    },
    saveFailed: {
        tooLarge: '這個面板超出了面板儲存空間的限制。請移除一些項目後重試。',
        notFound: '這個面板已在另一台裝置上被刪除。',
        generic: '你的變更沒有同步到帳號，面板維持原樣。',
        retry: '重試',
        dismiss: '忽略',
        createTitle: '這個面板未建立',
    },
};

const boardsTranslations = { zhHant };

return { boardsTranslations };
})();

const Domain_browserPresenceTranslations = (() => {
type AgentParams = Shared_browserPresenceTranslations.AgentParams;

type BrowserPresenceTranslations = Shared_browserPresenceTranslations.BrowserPresenceTranslations;

const browserPresenceTranslations = { 'zh-Hant': {
        agentFallbackName: '代理',
        agentBrowsing: ({ agent }) => `${agent} 正在瀏覽`,
        clickTarget: ({ target }) => `正在點擊「${target}」`,
        doing: {
            click: '正在點擊頁面',
            type: '正在輸入',
            fill: '正在填寫欄位',
            scroll: '正在捲動',
            navigate: '正在開啟頁面',
            history: '正在瀏覽歷史紀錄',
            reload: '正在重新載入頁面',
            press: '正在按鍵',
            select: '正在選擇選項',
            drag: '正在拖曳',
            upload: '正在上傳檔案',
            look: '正在查看頁面',
            other: '正在頁面中操作',
        },
        takeControl: '接手控制',
        stopping: ({ agent }) => `正在停止 ${agent}…`,
        stoppingDetail: '正在完成最後一個動作',
        lastActionMayHaveLanded: ({ agent }) => `${agent}的最後一個動作可能已生效`,
        youHaveControl: '由你控制',
        stopUnconfirmed: '無法確認已停止',
        checkAgain: '再次檢查',
        pausedUntilHandBack: ({ agent }) => `在你交還控制之前，${agent} 會暫停`,
        handBack: '交還',
        stream: {
            connectingTitle: ({ agent }) => `正在連線到 ${agent} 的瀏覽器`,
            connectingBody: ({ machine }) => `它在 ${machine} 上執行。收到第一個畫面後，頁面會顯示在這裡。`,
            stalled: '顯示最後一個畫面 · 正在重新連線',
            endedTitle: ({ agent }) => `${agent} 關閉了這個瀏覽器`,
            endedBody: '此頁面已不再顯示於此。',
            unavailableTitle: ({ agent }) => `無法在這裡顯示 ${agent} 的瀏覽器`,
            unavailableBody: ({ agent }) => `${agent} 仍在瀏覽；它的動作仍會顯示在聊天中。`,
            tryAgain: '重試',
            inputA11y: '頁面。點按、捲動或輸入即可接手控制。',
        },
        recording: {
            elapsedA11y: ({ elapsed }) => `錄製中，${elapsed}`,
            discard: '捨棄錄製',
        },
        openInYourBrowser: '在你的瀏覽器中開啟',
        slowPage: '此頁面載入時間較長',
        confidentialHeld: ({ agent }) => `此處有私密輸入 · 關閉頁面前 ${agent} 無法看到`,
        closePage: '關閉頁面',
    } } satisfies Pick<Record<string, BrowserPresenceTranslations>, "zh-Hant">;

return { browserPresenceTranslations };
})();

const Domain_browserToolTranslations = (() => {
type TargetParams = Shared_browserToolTranslations.TargetParams;

type BrowserToolTranslations = Shared_browserToolTranslations.BrowserToolTranslations;

const browserToolTranslations = { 'zh-Hant': {
        opened: ({ page }) => `開啟了 ${page}`,
        openedPage: '開啟了一個頁面',
        reloaded: '重新載入了頁面',
        wentBack: '返回了上一頁',
        wentForward: '前進了一頁',
        clicked: ({ target }) => `點擊了「${target}」`,
        clickedPage: '點擊了頁面',
        typedInto: ({ target }) => `在「${target}」中輸入`,
        typed: '在頁面中輸入',
        filledIn: ({ target }) => `填寫了「${target}」`,
        filled: '填寫了一個欄位',
        pressed: ({ key }) => `按下了 ${key}`,
        pressedKey: '按下了一個鍵',
        scrolled: '捲動了頁面',
        pointedAt: ({ target }) => `指向了「${target}」`,
        pointed: '指向了頁面',
        choseIn: ({ target }) => `在「${target}」中選擇了一個選項`,
        chose: '選擇了一個選項',
        uploadedTo: ({ target }) => `向「${target}」上傳了檔案`,
        uploaded: '上傳了檔案',
        dragged: ({ target }) => `拖曳了「${target}」`,
        draggedPage: '在頁面上拖曳',
        looked: '查看了頁面',
        screenshot: '擷取了螢幕畫面',
        recordingStarted: '開始錄製頁面',
        recordingStopped: '停止了錄製',
        other: '使用了瀏覽器',
        watch: '查看',
        watchA11y: '在瀏覽器中開啟此頁面',
    } } satisfies Pick<Record<string, BrowserToolTranslations>, "zh-Hant">;

return { browserToolTranslations };
})();

const Domain_changedFileEvidenceTranslations = (() => {
type ChangedFileEvidenceTranslations = Shared_changedFileEvidenceTranslations.ChangedFileEvidenceTranslations;

const en = Shared_changedFileEvidenceTranslations.en;

const translated = Shared_changedFileEvidenceTranslations.translated;

const changedFileEvidenceTranslations = { 'zh-Hant': {
        changedFileEvidence: translated({
            before: '變更前',
            after: '變更後',
            binary: '二進位檔案',
            truncated: '證據內容已受限；原始大小與變更統計在可用時會保留。',
            truncatedOldBytes: ({ count }) => `原始變更前內容：${count} 位元組`,
            truncatedNewBytes: ({ count }) => `原始變更後內容：${count} 位元組`,
            truncatedDiffBytes: ({ count }) => `原始差異：${count} 位元組`,
            truncatedAddedLines: ({ count }) => `新增行數：${count}`,
            truncatedRemovedLines: ({ count }) => `移除行數：${count}`,
            kind: {
                added: '新增',
                modified: '修改',
                deleted: '刪除',
                renamed: '重新命名',
                copied: '複製',
                unknown: '變更類型無法取得',
            },
            howDetermined: '如何判定',
            howDeterminedForFile: ({ path }) => `${path} 的判定方式`,
            content: {
                exact: '儲存庫的確切變更',
                strong: '強力的內容證據',
                best_effort: '盡力而為的內容證據',
            },
            attribution: {
                session_exact: '已連結至此工作階段',
                session_likely: '很可能由此工作階段變更',
                session_possible: '可能由此工作階段變更',
                unknown: '工作階段歸因無法取得',
            },
            reason: {
                provider_correlated: '代理已回報此回合的這項變更。',
                canonical_tool_correlated: '差異或修補工具已將這項變更連結到此回合。',
                checkpoint_no_happier_overlap_observed: '檢查點未在此程序中記錄到重疊的 Happier 回合。',
                checkpoint_overlap_observed: '另一個 Happier 回合與檢查點擷取區間重疊。',
                workspace_touched_path: '此路徑在工作區中被變動過；這無法判定是哪個工作階段變更了它。',
                unavailable: '證據無法判定是哪個工作階段做出這項變更。',
            },
            overlap: {
                observed: '擷取期間另一個 Happier 回合與此檢出重疊。觀測僅涵蓋此程序；其他程序與外部寫入者不會被追蹤。',
                not_observed: '在此程序中未觀測到重疊的 Happier 回合。其他程序與外部寫入者不會被追蹤；這並不能證明獨有的作者身分。',
                unknown: '檢查點重疊情況不明。其他程序與外部寫入者不會被追蹤。',
            },
            sources: {
                provider_native: '代理原生變更報告',
                provider_tool: '代理工具報告',
                canonical_diff_tool: '差異工具證據',
                canonical_patch_tool: '修補工具證據',
                scm_checkpoint: '儲存庫檢查點',
                scm_reconciled: '已核對的儲存庫快照',
                inferred: '工作區中被變動的路徑',
            },
        }),
    } } as const;

return { changedFileEvidenceTranslations };
})();

const Domain_cliPathExposureTranslations = (() => {
const en = Shared_cliPathExposureTranslations.en;

const zhHant = {
    title: '命令列',
    footer: 'Happier Desktop 只會新增或移除它自己建立的 PATH 項目。由 Shell 安裝程式寫入的項目不會更動。',
    addTitle: '將 happier 加入 PATH',
    addSubtitle: '讓 happier 指令可在新的終端機中使用。',
    removeTitle: '從 PATH 移除 happier',
    removeSubtitle: '僅移除 Happier Desktop 新增的 PATH 項目。',
    working: '正在更新你的 shell 設定檔…',
    added: '已新增。開啟新的終端機即可使用 happier。',
    alreadyPresent: 'happier 已在你的 PATH 中。',
    removed: '已移除 Happier Desktop 新增的 PATH 項目。',
    nothingToRemove: 'Happier Desktop 尚未新增任何 PATH 項目。',
};

const cliPathExposureTranslations = { zhHant: zhHant };

return { cliPathExposureTranslations };
})();

const Domain_cliTrustPromptTranslations = (() => {
const en = Shared_cliTrustPromptTranslations.en;

const zhHant = {
    title: '要核准此命令列嗎？',
    body: ({ command }: { command: string }) => `${command} 處的命令列不是 Happier 安裝的。核准後它可以讀寫此帳戶的對話。請僅核准你自己放在那裡的程式。`,
    bodyUnknownCommand: '此命令列不是 Happier 安裝的。核准後它可以讀寫此帳戶的對話。請僅核准你自己放在那裡的程式。',
    approve: '核准',
};

const cliTrustPromptTranslations = { zhHant: zhHant };

return { cliTrustPromptTranslations };
})();

const Domain_commitProposalTranslations = (() => {
type Count = Shared_commitProposalTranslations.Count;

type CommitProposalCopy = Shared_commitProposalTranslations.CommitProposalCopy;

const en = Shared_commitProposalTranslations.en;

const commitProposalTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', { commitProposal: CommitProposalCopy }>>, "zh-Hant"> = { 'zh-Hant': { commitProposal: {
        title: ({ count }) => `為待提交變更準備的 ${count} 個提交`,
        titlePhone: ({ count }) => `${count} 個提交`,
        proposedBy: ({ who, committed, total }) => `由 ${who} 提議 · ${total} 個檔案中的 ${committed} 個 · 依序排列，每個提交都建立在上一個之上。`,
        proposedByPhone: ({ committed, total }) => `${total} 個待提交檔案中的 ${committed} 個 · 點一下變更即可移動。`,
        moveHint: ({ max }) => `使用 ⌥1–${max} 或選單移動任何變更。`,
        modelFallback: '模型',
        regenerate: '重新產生',
        conflict: '提議已在其他地方變更。這是最新版本；請再次進行變更。',
        approvalPending: '正在等待核准以建立這些提交。',
        discardBody: '將移除此提議。你的待提交變更維持不變。', askFix: ({ hook, number, message }) => `${hook} 掛鉤阻止了提交 ${number}「${message}」。請修正它回報的問題，讓提交能夠通過：`, askFixGeneric: ({ number, message }) => `一個掛鉤阻止了提交 ${number}「${message}」。請修正它回報的問題，讓提交能夠通過：`, discarded: '已捨棄提議。', undo: '復原',
        fileCount: ({ count }) => `${count} 個檔案`,
        part: ({ count, of }) => `${of} 處變更中的 ${count} 處`,
        move: { a11y: ({ file }) => `將 ${file} 移到其他提交`, title: ({ file }) => `將 ${file} 移到`, newCommitAfter: ({ number }) => `在 ${number} 之後新增提交`, newCommitMessage: ({ file }) => `更新 ${file}`, leaveOut: '不放入這些提交', leaveOutHint: '保留在工作樹中' },
        group: { a11y: ({ number, message }) => `提交 ${number}：${message}`, editMessage: '編輯訊息', messageA11y: ({ number }) => `提交 ${number} 的訊息`, more: '更多', moveUp: '上移', moveDown: '下移', mergeWithNext: '與下一個提交合併', empty: '還沒有變更。把一處變更移到這裡，或與下一個提交合併。' },
        leftOut: { title: '未放入 · 保留在工作樹中', description: '這些變更仍待提交。如有需要，請另外提交。' },
        footer: { commits: ({ count }) => `${count} 個提交`, onBranch: ({ branch }) => `，位於 ${branch} · 掛鉤和簽署與任何提交一樣執行`, detached: '，位於分離的 HEAD · 掛鉤和簽署與任何提交一樣執行', phone: '掛鉤和簽署照常執行', discard: '捨棄提議', create: ({ count }) => `建立 ${count} 個提交`, createShort: ({ count }) => `建立 ${count} 個`, emptyGroupReason: '有一個提交沒有變更。請把變更移入或將其合併。' },
        applying: { title: ({ count }) => `正在建立 ${count} 個提交`, body: '透過一般提交流程逐一建立，掛鉤和簽署照常執行。完成前暫停編輯。', bodyPhone: '完成前暫停編輯。', created: ({ landed, total }) => `${total} 個中的 ${landed} 個`, createdRest: '已建立 · 後續提交停止時不會復原任何內容', createdRestPhone: '已建立', stopAfterThis: '此提交後停止', stopAfterThisShort: '此後停止', stopping: '將在此提交後停止' },
        state: { waiting: '等待中', writing: '正在執行掛鉤並建立提交', landed: '已提交', landedAt: ({ time }) => `已於 ${time} 提交`, signed: '已簽署', pausedBy: ({ hook, count }) => `${hook} 變更了 ${count} 個檔案 · 尚未提交`, hookFailedBy: ({ hook }) => `${hook} 失敗 · 未提交`, rewritten: '掛鉤改寫了訊息', notCreated: '未建立 · 仍可編輯', notCreatedShort: '未建立', unknown: '尚未確認', paused: ({ count }) => `掛鉤變更了 ${count} 個檔案 · 尚未提交`, failed: '在此停止 · 未提交' },
        outcome: { signingTitle: '目前無法為你的提交簽署。', signingBody: '此儲存庫會為每個提交簽署。尚未提交任何內容。', signingHint: '請先解鎖 GPG 或 SSH 代理程式', tryAgain: '重試', cancel: '取消', hookChanged: ({ files }) => `掛鉤變更了 ${files}。`, waitsAfterLanded: ({ count }) => `已完成 ${count} 個提交；這個在等你。`, waits: '這個在等你。', include: '包含掛鉤的變更', includePhone: '包含並提交', cancelCommit: '取消此提交', hookFailed: '掛鉤阻止了此提交。', hookChangedBy: ({ hook, files }) => `${hook} 變更了 ${files}。`, hookFailedBy: ({ hook }) => `${hook} 阻止了此提交。`, hookFailedBody: '先前的提交會保留。其餘仍可編輯。', headMoved: ({ branch }) => `提交期間 ${branch} 已移動。`, headMovedBody: '下一個提交遭拒，沒有復原任何內容。', proposeAgain: '為剩餘內容重新提議', keepEditing: '繼續編輯', askSessionToFix: '請此工作階段修正', showInGit: '在 Git 中顯示', unknownTitle: '無法確認此提交是否已完成。', unknownBody: '確認之前不會重試。請再次檢查分支。', checkAgain: '再次檢查', stoppedTitle: ({ landed, total }) => `已建立 ${total} 個中的 ${landed} 個提交`, stoppedBody: ({ count }) => `${count} 個未建立。它們的變更仍和之前一樣在你的工作樹中。`, createRest: ({ count }) => `建立剩餘 ${count} 個`, completeTitle: ({ count }) => `已建立 ${count} 個提交`, completeBody: '沒有推送任何內容。', onBranch: ({ branch }) => `位於 ${branch}`, failed: { staging_conflict: '其他操作變更了暫存內容。', selection_conflict: '這些變更無法這樣拆分。', source_changed: '提議之後待提交變更已改變。', writer_failed: '無法建立提交。', publication_warning: '提交已完成，但暫存檔案未更新。', cancelled: '此提交已取消。' }, failedBody: '先前的提交會保留。沒有復原任何內容。' },
        none: { title: '還沒有提交提議', reason: '提議會將你的待提交變更分組為可編輯的提交，然後透過一般提交流程逐一建立。', propose: '提議提交', writing: '正在分組你的待提交變更…' },
        gitPane: { title: '提議的提交', meta: ({ count, files }) => `${count} · ${files} 個檔案`, inCommit: ({ count, number }) => `提交 ${number} 中 ${count} 個`, open: '開啟', review: '檢視', reviewInWalkthrough: '在導讀中檢視', more: '捨棄或重新產生', selectedHint: '已選取。再點一下即可在提交中開啟', tapHint: '點一下查看其變更' },
    } } };

return { commitProposalTranslations };
})();

const Domain_committedMessageActionTranslations = (() => {
const committedMessageActionTranslations = { "zh-Hant": {
        "committedMessageActions": {
            "copy": "複製",
            "fork": "分支",
            "rollback": "回滾",
            "pin": "釘選",
            "savePrompt": "儲存為提示詞",
            "plugins": "外掛操作",
            "composerButton": "提示詞庫按鈕",
            "composerHint": "在聽寫旁開啟你儲存的提示詞和傳送過的內容。關閉後，/ 選單仍提供「提示詞…」。",
            "name": "名稱",
            "shortcut": "/ 快捷命令",
            "savedOpen": "已儲存至提示詞庫 · 開啟",
            "shortcutNotSaved": "提示詞已儲存，但快捷命令未能儲存。請在提示詞庫中開啟並新增快捷命令。",
            "wrongAccount": "儲存提示詞前，請切換至此工作階段的 Home。",
            "savedHintFavorite": "儲存到你的庫並加星號。",
            "savedHint": "儲存到你的庫。",
            "addShortcut": "新增 / 捷徑",
            "shortcutPlaceholder": "/shortcut",
            "savedToLibrary": "已儲存到庫",
            "savePromptHint": "可從提示詞庫再次使用",
            "copyHint": "複製訊息的文字。",
            "forkHint": "從某則訊息開始新的工作階段。",
            "rollbackHint": "將工作區還原到某則訊息之前的狀態。",
            "pinHint": "釘選訊息以便回看。已釘選的訊息會保持釘選。",
            "savePromptSettingHint": "將你傳送的訊息儲存為庫中的提示詞。",
            "pluginsHint": "外掛在訊息下方加入的操作。"
        }
    } };

return { committedMessageActionTranslations };
})();

const Domain_computerUseTranslations = (() => {
type MachineParams = Shared_computerUseTranslations.MachineParams;

type ComputerUseTranslations = Shared_computerUseTranslations.ComputerUseTranslations;

const computerUseTranslations = { 'zh-Hant': {
        approval: {
            sectionTitle: '在電腦上',
            act: {
                list: '查看開啟了哪些視窗',
                see: '擷取畫面',
                read: '讀取文字和控制項',
                click: '點按',
                press: '按鍵',
                type: '輸入',
                share: '分享一個視窗',
            },
            windowOn: ({ machine }) => `${machine} 上的一個視窗`,
            screenOf: ({ machine }) => `${machine} 的整個螢幕`,
            windowsOn: ({ machine }) => `${machine} 上開啟的視窗`,
            window: '一個視窗',
            screen: '整個螢幕',
            windows: '開啟的視窗',
            typedLabel: '文字',
            keyLabel: '按鍵',
            listConsequence: '只分享開啟的視窗名稱，不分享其中的內容。',
            seeConsequence: '截圖會分享到此工作階段。不會點按或輸入。',
            useConsequence: '已送達這台機器的輸入無法復原。你可以隨時停止。',
            targetOn: ({ machine, target }) => `${machine} 上的 ${target}`,
            chooseFirst: '請先選擇視窗',
            cropA11y: ({ target }) => `${target} 的最新畫面`,
            suggestsWindow: ({ agent, target }) => `${agent} 建議「${target}」`,
        },
        request: {
            title: ({ agent, machine }) => `${agent} 想使用 ${machine} 上的一個視窗`,
            body: '視窗由你選擇。在你選擇之前不會分享任何內容。',
            choose: '選擇視窗',
            change: '更換視窗',
            shared: ({ target }) => `已分享 ${target}`,
            watch: '查看',
        },
        picker: {
            title: ({ agent }) => `讓 ${agent} 使用一個視窗`,
            description: ({ agent }) => `你選擇與 ${agent} 分享的內容。`,
            windows: '視窗',
            screens: '整個螢幕',
            untitledWindow: '未命名視窗',
            screenLabel: ({ index }) => `螢幕 ${index}`,
            share: '分享視窗',
            shareScreen: '分享螢幕',
            shareApp: ({ app }) => `分享 ${app} 視窗`,
            stopSharing: '停止分享',
            loadingTitle: ({ machine }) => `正在尋找 ${machine} 上的視窗`,
            noScreenTitle: ({ machine }) => `${machine} 沒有可分享的螢幕`,
            noScreenBody: '它在沒有 Happier 可見桌面的情況下執行。請使用有螢幕的機器。',
            unsupportedTitle: ({ machine }) => `Happier 暫時還不能使用 ${machine} 的螢幕`,
            unsupportedBody: '目前分享視窗適用於 Linux 桌面。',
            failedTitle: ({ machine }) => `無法列出 ${machine} 上的視窗`,
            failedBody: '請確認 Happier 正在那裡執行，然後重試。',
            emptyTitle: ({ machine }) => `${machine} 上沒有開啟的視窗`,
            emptyBody: '開啟你要分享的視窗，然後再檢查一次。',
            tryAgain: '重試',
            inUse: '另一個工作階段正在使用這個視窗。請選擇其他視窗。',
            closed: '該視窗已關閉。請選擇其他視窗。',
            selectFailed: '無法分享該視窗。請重試。',
            otherMachineTitle: ({ machine }) => `${machine} 不是此工作階段所在的機器`,
            otherMachineBody: '只能分享此工作階段所在機器上的視窗。',
            purpose: ({ session }) => `用於「${session}」。`,
            purposeIn: ({ project, session }) => `用於 ${project} 中的「${session}」。`,
            access: ({ agent }) => `${agent} 可以`,
            accessValue: '查看並使用',
            accessSee: '僅查看',
            displayUnavailable: '此電腦無法分享整個顯示器。',
            wholeDisplayBody: ({ display }) => `${display} 上可見的一切都能被看到，包括其他 App 和通知。`,
            policyBoth: ({ agent }) => `${agent} 每次擷取畫面、點按和按鍵前都會詢問。`,
            policyInput: ({ agent }) => `${agent} 每次點按和按鍵前都會詢問。`,
            policyCapture: ({ agent }) => `${agent} 每次擷取畫面前都會詢問。`,
            policyNone: ({ agent }) => `${agent} 擷取畫面、點按和按鍵前不會詢問。`,
            policyChange: '變更',
            suggests: ({ agent }) => `${agent} 建議`,
            usingIt: '代理正在使用',
            displayShared: '其上的所有內容都會分享',
            refresh: '重新整理來源',
            footnote: '列出視窗前會先詢問你；分享整個顯示器時會再次詢問。',
            wholeDisplayTitle: '分享整個顯示器？',
            allowSee: '允許檢視',
            allowUse: '允許滑鼠和鍵盤',
            allowUseHint: ({ agent }) => `${agent} 可以使用此顯示器。你可以隨時收回控制權。`,
            shareDisplay: '分享顯示器',
        },
        permission: {
            input: '輔助使用',
            denied: '未允許',
            opened: ({ machine }) => `已在 ${machine} 上開啟。請在那裡允許 Happier，然後再檢查一次。`,
            openFailed: '無法在那裡開啟系統設定。請在那台電腦上開啟。',
            checkAgain: '再次檢查',
            captureTitle: ({ machine }) => `請在 ${machine} 上允許螢幕錄製，以觀看它的視窗或顯示器。`,
            inputTitle: ({ machine }) => `請在 ${machine} 上允許輔助使用，以使用它的滑鼠和鍵盤。`,
            unknownTitle: ({ machine }) => `無法檢查 ${machine} 上的螢幕權限。分享前請再次檢查。`,
            separateBody: ({ machine }) => `輔助使用是另一項權限：它讓你可以在那裡使用滑鼠和鍵盤。兩者都在 ${machine} 上授予，而不是在此裝置上。`,
            onMachineBody: ({ machine }) => `需在 ${machine} 上授予，而不是在此裝置上。`,
            openPrivacy: ({ machine }) => `在 ${machine} 上開啟隱私權設定`,
        },
        viewer: {
            agentUsing: ({ agent, target }) => `${agent} 正在使用 ${target}`,
            agentCanUse: ({ agent, target }) => `${agent} 可以使用 ${target}`,
            agentCanSee: ({ agent, target }) => `${agent} 可以查看 ${target}`,
            onMachine: ({ machine }) => `在 ${machine} 上`,
            connectingTitle: ({ target }) => `正在連線到 ${target}`,
            unavailableTitle: '現在無法顯示這個視窗',
            unavailableBody: ({ agent }) => `你仍然可以在這裡停止 ${agent}。`,
            endedTitle: ({ target }) => `${target} 已關閉`,
            endedBody: ({ agent }) => `${agent} 不能再查看或使用它。請選擇其他視窗以繼續。`,
            stalled: '正在顯示最後一個畫面 · 正在重新連線',
            inputA11y: ({ target }) => `${target}，即時畫面。點按或輸入即可接手控制。`,
            notSharedTitle: '沒有分享的視窗',
            notSharedBody: ({ agent }) => `選擇一個視窗讓 ${agent} 使用。`,
            moreA11y: '視窗選項',
            tabFallback: '電腦',
            sourceComputer: '電腦',
            sourceBrowser: '瀏覽器',
            sourceA11y: '來源',
            watchingA11y: ({ source, machine }) => `正在檢視 ${machine} 上的${source}`,
            expandView: '展開檢視',
            restoreView: '還原檢視',
            dockView: '停駐檢視',
            closeView: '關閉檢視',
            moveView: '移動檢視',
            resizeView: '調整檢視大小',
            moveTopLeft: '移到左上角',
            moveTopRight: '移到右上角',
            moveBottomLeft: '移到左下角',
            moveBottomRight: '移到右下角',
            larger: '放大',
            smaller: '縮小',
            viewOptions: '檢視選項',
            presentedElsewhereTitle: '正在浮動檢視中顯示',
            presentedElsewhereBody: '停駐到這裡，讓它待在你的工作旁邊。',
            closeHint: '關閉此檢視器。工作階段會繼續執行。',
            agentWorkingOn: ({ agent, machine }) => `${agent} 正在 ${machine} 上工作`,
            watchingSourceA11y: ({ source }) => `正在觀看${source}`,
            controlNotAllowed: '不允許控制滑鼠和鍵盤',
            paused: ({ time }) => `畫面已暫停 · 最後一格 ${time}`,
            offlineTitle: ({ machine }) => `${machine} 沒有回應`,
            offlineBody: '重新連線後即可觀看。觀看不會啟動它。',
            openingTitle: ({ target, machine }) => `正在 ${machine} 上開啟${target}…`,
        },
        strip: {
            using: ({ target }) => `正在使用 ${target}`,
            on: ({ machine }) => `在 ${machine} 上`,
            stop: '停止',
            paused: ({ agent }) => `${agent} 已暫停`,
            pausedDetail: ({ target }) => `你正在控制 ${target}`,
        },
        tool: {
            capture: '已擷取畫面',
            captureRunning: '正在擷取畫面',
            query: '已讀取視窗的文字和控制項',
            queryRunning: '正在讀取視窗',
            click: '已在視窗中點按',
            clickRunning: '正在視窗中點按',
            clickTarget: ({ target }) => `點按了「${target}」`,
            type: '已在視窗中輸入',
            typeRunning: '正在視窗中輸入',
            typeTarget: ({ target }) => `在「${target}」中輸入`,
            pressKey: ({ key }) => `已按下 ${key}`,
            press: '已按下一個鍵',
            pressRunning: '正在按鍵',
            mayHaveLanded: '可能已生效',
            failed: '未完成',
        },
    } } satisfies Pick<Record<string, ComputerUseTranslations>, "zh-Hant">;

return { computerUseTranslations };
})();

const Domain_connectedServicesCollectionTranslations = (() => {
type ConnectedServicesCollectionCopy = Shared_connectedServicesCollectionTranslations.ConnectedServicesCollectionCopy;

const en = Shared_connectedServicesCollectionTranslations.en;

const zhHant: ConnectedServicesCollectionCopy = {
    accountLabel: ({ service }) => `${service} 帳戶`,
    accountLabelNumbered: ({ service, number }) => `${service} 帳戶 ${number}`,
    meterResetsIn: ({ time }) => `${time}後`,
    meterNextResetIn: ({ time }) => `下次在${time}後`,
    meterResetsAt: ({ countdown, time }) => `${countdown} · ${time}`,
    meterNotReported: '未回報',
    meterEstimated: ({ value }) => `~${value}`,
    indexTitle: '所有服務',
    indexDescription: '你的代理用來登入的帳號，以及每個帳號還剩多少。',
    viewList: '清單',
    viewGrid: '網格',
    viewLabel: '帳號顯示方式',
    refreshAll: '全部重新整理',
    refreshUsage: '重新整理用量',
    signedOutConsequence: '重新登入前，工作階段無法使用它。',
    poolsGroup: '帳號池',
    poolsDescription: '代理在其間切換的帳號。工作階段開始時池選擇一個，用完後換下一個。',
    newPool: '新增帳號池',
    poolUsing: ({ account }) => `正在使用 ${account}`,
    poolPosition: ({ position, count }) => `第 ${position} 個，共 ${count} 個`,
    poolInUseNow: '正在使用',
    inUse: '使用中',
    connectService: '連結服務',
    searchAccounts: '搜尋帳號',
    servicesGroup: '服務',
    railEmpty: '還沒有帳號',
    railKey: '金鑰',
    railAccountLabel: ({ service, account }) => `${service} · ${account}`,
    agentSignInTitle: '代理如何登入',
    subscriptionTitle: '訂閱',
    subscriptionNone: '沒有訂閱',
    subscriptionRenewsIn: ({ days }) => days === 0 ? '今天續訂' : `${days} 天後續訂`,
    subscriptionEndsIn: ({ days }) => days === 0 ? '不再續訂 · 今天結束' : `不再續訂 · ${days} 天後結束`,
    subscriptionPeriodEndsIn: ({ days }) => days === 0 ? '本期今天結束' : `本期 ${days} 天後結束`,
    subscriptionRenewsOn: ({ date, days }) => `${date} 續訂 · ${days} 天後`,
    subscriptionEndsOn: ({ date, days }) => `不再續訂 · ${date}（${days} 天後）結束，之後工作階段將停止使用它。`,
    subscriptionPeriodEndsOn: ({ date, days }) => `本期 ${date} 結束 · ${days} 天後`,
    renewalOn: '開啟',
    renewalOff: '關閉',
    renewalUnknown: '未知',
    checkedAt: ({ time }) => `${time} 檢查`,
    checkedMayBeOutOfDate: ({ time }) => `${time} 檢查 · 可能已過時`,
    usageCheckedMayBeOutOfDate: ({ time }) => `${time} 檢查 · 可能已過時`,
    daysAgo: ({ count }) => `${count} 天前`,
    hoursAgo: ({ count }) => `${count} 小時前`,
    usageResetsCount: ({ count }) => `${count} 次用量重置`,
    usageResetsFirstExpires: ({ date }) => `最早 ${date} 到期`,
    usageResetExpires: ({ date }) => `${date} 到期`,
    useOne: '使用一次',
    useOneReset: '使用一次用量重置',
    usageResetsTitle: '用量重置',
    usageResetsDescription: '每次都會立即開啟新的時段。留到被限額擋住時再用；未使用的會到期。',
    usageResetTitle: '用量重置',
    usageResetExpiresOn: ({ date }) => `${date} 到期`,
    use: '使用',
    usedByDefault: '預設 · 新工作階段使用此帳號',
    accountIdFact: ({ id }) => `ID ${id}`,
    hideIdentitiesTitle: '隱藏帳號電子郵件與 ID',
    hideIdentitiesDescription: '用於直播與展示。在此裝置上處處遮蓋電子郵件與帳號 ID；你為帳號取的名稱保持不變。',
    privacyTitle: '隱私',
    renameTitle: '為此帳號命名',
    renameBody: ({ service }) => `只會變更 Happier 中的名稱。${service} 仍保留該帳號自己的名稱。`,
    identityHidden: '電子郵件或 ID 已隱藏',
};

const connectedServicesCollectionTranslations = { zhHant };

return { connectedServicesCollectionTranslations };
})();

const Domain_connectedServicesPoolTranslations = (() => {
type ConnectedServicesPoolCopy = Shared_connectedServicesPoolTranslations.ConnectedServicesPoolCopy;

const en = Shared_connectedServicesPoolTranslations.en;

const zhHant: ConnectedServicesPoolCopy = {
    strategyExpiryFirst: "即將到期優先",
    strategyExpiryFirstDescription: "優先選擇額度充足且長期額度重設或不續訂的訂閱結束時間更近的帳號。",
    leadExpiryFirst: "即將到期優先。",
    membersOn: ({ service, on, total }) => `${service} · ${total} 個成員中 ${on} 個已開啟`,
    rename: '重新命名',
    moreActions: '更多操作',
    defaultFor: ({ agent }) => `${agent} 的預設`,
    defaultForMore: ({ agent, count }) => `${agent} 的預設 +${count}`,
    makeDefault: '設為預設',
    makeDefaultA11y: '設為某個代理的預設',
    usingSince: ({ name, time }) => `自 ${time} 起使用 ${name}`,
    using: ({ name }) => `正在使用 ${name}`,
    noActive: '還沒有成員在使用',
    noActiveDetail: '工作階段開始時，池會選擇一個。',
    leadLeastLimited: '剩餘最多的優先。',
    leadInOrder: '依順序。',
    fallbackOff: ({ name }) => `自動切換已關閉，${name} 用完後工作階段仍留在它上面。`,
    manualStays: ({ name }) => `手動：在你選擇其他成員之前，池會一直使用 ${name}。`,
    switchTo: ({ name }) => `切換到 ${name}`,
    onlyOneOn: ({ name }) => `只有 ${name} 已開啟，因此沒有可切換的對象。`,
    turnOn: ({ name }) => `開啟 ${name}`,
    allWaitingTitle: '所有成員都在等待重設',
    allWaitingFirst: ({ name, time, countdown }) => `${name} 最先重設，時間 ${time}（${countdown}）。`,
    sessionsWait: '工作階段會等待，然後自動繼續。',
    sessionsStop: '在有成員有餘量之前，工作階段會停止。',
    leftTitle: '池內剩餘',
    leftDescription: '已開啟成員的平均值；各自獨立重設。',
    roomCount: ({ count, total }) => `${total} 個中有 ${count} 個現在有餘量`,
    notReported: ({ count }) => `${count} 個未回報`,
    nothingReported: '已開啟的成員還沒有回報限額。',
    membersTitle: '成員',
    membersDescription: '拖曳以設定順序。選取的成員為目前成員；關閉的成員會被略過。',
    membersCompactDescription: '長按並拖曳以重新排序。',
    manage: '管理',
    connectAnotherAccount: ({ service }) => `連接另一個${service}帳戶`,
    membersSelectionSummary: ({ count, total, service }) => `${total}個${service}帳戶中的${count}個`,
    manageMembers: '管理成員',
    searchAccounts: ({ service }) => `搜尋 ${service} 帳戶`,
    active: '目前',
    offNotUsed: '關閉期間池不會使用它',
    autoOffModel: '已自動關閉 · 此方案無法使用所選模型',
    checkedAt: ({ time }) => `檢查於 ${time}`,
    makeActiveA11y: ({ name }) => `將 ${name} 設為目前成員`,
    memberOnA11y: ({ name }) => `在此池中使用 ${name}`,
    openA11y: ({ name }) => `開啟 ${name}`,
    dragA11y: '拖曳以重新排序',
    behaviorTitle: '行為',
    strategyTitle: '選擇策略',
    strategyLeastLimited: '限制最少',
    strategyInOrder: '依順序',
    strategyManual: '手動',
    strategyLeastLimitedDescription: '優先使用可用額度最多的成員。',
    strategyInOrderDescription: '依上方順序嘗試成員。',
    strategyManualDescription: '在你變更之前只使用目前成員。',
    fallbackTitle: '自動切換',
    fallbackDescription: '目前帳戶需要復原時切換到其他成員。',
    switchEarlyTitle: '提前切換',
    switchEarlyDescription: '剩餘低於此百分比時，池會切換到額度較新的成員。0 表示關閉。',
    autoResetsTitle: '自動使用額度重設',
    autoResetsDescription: '只在沒有成員可用時使用儲存的重設。',
    autoOffTitle: '關閉無法使用所選模型的帳戶',
    autoOffDescription: '你可以自行重新開啟。',
    advancedTitle: '進階',
    advancedCount: ({ count }) => `${count} 項設定`,
    restoreFirstTitle: '重設後回到第一個成員',
    restoreFirstDescription: '切換後，在排在首位的成員限額重設時回到它。',
    switchWhenTitle: '切換時機',
    switchWhenDescription: '使池切換到下一個成員的事件。',
    staleAfterTitle: '在此之後檢查過期用量',
    staleAfterDescription: '分鐘。選擇成員前，若用量早於此時間則重新詢問提供者。',
    switchesPerTurnTitle: '每輪自動切換次數',
    switchesPerHourTitle: '每工作階段小時自動切換次數',
    switchLimitsDescription: '防止池在成員之間來回切換。',
    recoveryTitle: '當限額使工作階段停止時',
    recoveryDescription: '池如何處理等待中的工作階段。',
    recoveryPromptsTitle: '恢復訊息',
    recoveryPromptsDescription: '切換或重設後恢復工作階段時，Happier 會傳送其標準訊息。',
    usedByTitle: '使用者',
    usedByDefault: '預設 · 新工作階段透過此池登入',
    usedByNone: '還沒有代理預設透過此池登入。',
    deleteNote: ({ agents }) => `成員保持連線。在你選擇其他預設前，${agents} 會恢復使用自己的登入。`,
    deleteNoteNoAgent: '成員保持連線。',
    emptyTitle: '新增要切換的帳戶',
    emptyReason: ({ service }) => `池會在工作階段開始時選擇一個帳戶，用完後切換。請至少新增兩個 ${service} 帳戶。`,
    usageNotAnswering: ({ service }) => `${service} 沒有回應`,
    newPoolTitle: '新增池',
    newPoolDescription: ({ service }) => `代理在其間切換的 ${service} 帳戶。`,
    nameTitle: '名稱',
    namePlaceholder: '工作池',
    draftMembersDescription: '選擇要切換的帳戶。之後可以變更。',
    create: '建立池',
    discard: '捨棄',
};

const connectedServicesPoolTranslations = { zhHant };

return { connectedServicesPoolTranslations };
})();

const Domain_connectedServicesSettingsTranslations = (() => {
type ConnectedServicesSettingsCopy = Shared_connectedServicesSettingsTranslations.ConnectedServicesSettingsCopy;

const setupFidelityCopy = Shared_connectedServicesSettingsTranslations.setupFidelityCopy;

const en = Shared_connectedServicesSettingsTranslations.en;

const zhHant: ConnectedServicesSettingsCopy = {
    ...setupFidelityCopy,
    accountCount: ({ count }) => `${count} 個帳號`,
    defaultAccount: ({ name }) => `預設：${name}`,
    poolCount: ({ count }) => `${count} 個帳號池`,
    noAccountsYet: '還沒有帳號',
    needsSignIn: '需要登入',
    signInAgain: '重新登入',
    addAccount: '新增帳號',
    connectAnotherTitle: '連接其他服務',
    connectFirstTitle: '連接服務',
    connectNames: ({ names }) => `${names}。`,
    connectNamesMore: ({ names, count }) => `${names} 等另外 ${count} 個。`,
    connect: '連接',
    emptyTitle: '還沒有可連接的服務',
    servicesTitle: '服務',
    emptyNoServiceOnMachine: ({ machine }: { machine: string }) => `${machine} 上的代理還沒有提供可用於登入的服務。使用訂閱的代理會在這裡新增自己的服務。`,
    emptyNoMachineOnline: '你的機器都不在線上。有機器在線上時，會顯示它執行的代理提供的服務。',
    emptyOpenAgents: '開啟代理',
    emptyAction: '開啟機器',
    projectionErrorTitle: '無法從你的機器載入服務',
    projectionErrorDescription: '你的帳號仍會列出。可新增的服務會在機器回應後出現。',
    loadingServices: '正在你的機器上尋找服務…',
    usageTitle: '帳號的使用方式',
    usageDescription: '每個代理在工作階段開始時使用哪個帳號登入，以及工作階段之間共享什麼。',
    sharingTitle: '狀態共享',
    sharingSummary: ({ config, state }) => `${config} · ${state}`,
    configLinkedShort: '連結',
    configCopiedShort: '複製',
    configIsolatedShort: '隔離',
    stateSharedShort: '工作階段共享',
    stateIsolatedShort: '工作階段分開',
    perAgentTitle: '依代理共享',
    perAgentDescription: '為某個代理覆寫這些預設設定。',
    perAgentPurpose: '依代理選擇已連接帳號的工作階段與你自己的登入共享哪些內容。',
    servicePurpose: ({ service }) => `你用來登入 ${service} 的帳號，以及共享它們的帳號池。`,
    chooseMachineTitle: '選擇一台機器',
    chooseMachineDescription: '新增、登入和移除帳號都在你的某台機器上進行。你的帳號仍會列在「已連接服務」中。',
    newAccountTitle: '新帳號',
    newAccountDescription: '選擇登入方式。',
    newAccountInProgress: '請在下方完成登入。',
    modeBrowser: '使用瀏覽器登入',
    modeDeviceCode: '使用代碼登入',
    modeManual: '輸入權杖',
    serviceSettingsTitle: '服務設定',
    serviceSettingsDescription: '此服務的每個帳號登入時使用的設定。',
    noAccountsDescription: '新增一個帳號，讓你的代理可以用它登入。',
    accountDetailsTitle: '帳號詳情',
    poolEmptyTitle: '向此帳號池新增帳號',
    poolEmptyDescription: '當一個帳號達到限額時，帳號池會把工作階段轉到下一個帳號。請在下方選擇它的帳號。',
    agentDefaultsTitle: '每個代理的預設帳號',
    agentDefaultsDescription: '每個代理在工作階段開始時用於登入的帳號。',
    agentDefaultsKeywords: '預設帳號',
    namesAnd: ({ names, last }) => `${names}和${last}`,
    usedBy: ({ names }) => `${names} 使用`,
    poolRuleMostLeft: '使用剩餘最多的那個',
    poolRuleInOrder: '依序使用',
    poolRuleManual: '由你手動切換',
    poolInUse: ({ pool }) => `${pool} · 使用中`,
    agentDefault: ({ agent }) => `${agent} 預設`,
    signedOutBy: ({ service }) => `已被 ${service} 登出`,
    usageReadFailed: '無法讀取用量',
    usageWindowPin: ({ meter }: { meter: string }) => `在輸入框旁顯示 ${meter}`,
    noLimitsBilledPerUse: '未回報限額 · 按用量計費',
    needsYouCount: ({ count }) => `${count} 個需要你處理`,
    connectToolsTitle: '連接程式碼託管或工具',
    inviteTitle: ({ names }) => `你的代理還可以使用 ${names}`,
    inviteWhoOne: ({ agents }) => `${agents} 可以用它登入。`,
    inviteWhoMany: ({ agents }) => `${agents} 可以用它們登入。`,
    inviteTools: '或者連接程式碼託管和工具。',
    firstRunTitle: '用上你已付費的方案',
    firstRunPromise: '只需連接一次 Claude 或 ChatGPT 帳號。你的代理在每台機器上都能使用它，Happier 會在你達到限額前顯示剩餘用量。',
    connectAnAccount: '連接帳號',
    firstRunMeanwhile: '在此之前，每個代理在每台機器上使用自己的登入。',
    agentAccountsTitle: '代理帳號',
    agentAccountsDescription: '你的代理使用的訂閱和金鑰。儲存在你的帳號中，每台機器都能使用。',
    codeAndToolsTitle: '程式碼與工具',
    setupChooseMachine: '選擇一台機器來登入。之後該帳號可在你所有的機器上使用。',
    setupHowToSignIn: '登入方式',
    setupRecommendedMethod: ({ method }) => `${method} · 推薦`,
    setupCatalogTitle: '連接服務',
    setupCatalogPurpose: '登入在你選擇的機器上進行。之後該帳號可在你所有的機器上使用。',
    setupServiceTitle: ({ service }) => `連接 ${service}`,
    setupReconnectTitle: ({ service }) => `重新登入 ${service}`,
    setupServicePurpose: ({ agents, service }) => `${agents} 將在每台機器上使用你的 ${service} 帳號。`,
    setupServicePurposeNoAgents: '該帳號可在每台機器上使用。',
    setupForYourAgents: '適用於你的代理',
    setupOwnLoginTitle: '已在機器上登入？',
    setupOwnLoginBody: '繼續使用代理自己的登入。在「帳號的使用方式」中選擇。',
    setupToolsTitle: '程式碼託管和工具',
    setupProvidersPointer: 'OpenRouter、Ollama 等模型提供者在「提供者」中設定。',
    setupOpenProviders: '開啟提供者',
    setupTrust: '儲存在你的帳號中，僅供你的機器使用。Happier 會為你保持登入有效。',
    setupConnectedCount: ({ count }) => `已連接 ${count} 個`,
    settleConnectedAs: ({ identity }) => `剛剛以 ${identity} 連接。`,
    settleConnected: '剛剛已連接。',
    settleUseFor: ({ agent }) => `用於 ${agent}？`,
    settleUseForAction: ({ agent }) => `用於 ${agent}`,
    notNow: '暫不',
    homeInvitePromise: '只需連接一次 Claude 或 ChatGPT。每台機器都能使用，並且你可以在這裡看到剩餘用量。',
    homeInviteHide: '隱藏',
    homeNextWho: ({ agents }) => `${agents} 也可以使用`,
    oauthStepOpen: '在瀏覽器中開啟登入頁面',
    oauthStepApprove: '核准後，複製頁面顯示的代碼（或跳轉到的網址）',
    oauthStepPaste: '貼到這裡',
    oauthPastePlaceholder: '貼上代碼或網址',
    oauthShapeOk: '看起來是登入代碼',
    deviceEnterAt: ({ where }) => `在 ${where} 輸入此代碼`,
    deviceExpired: '代碼已過期，未儲存任何內容。',
    deviceExpiresIn: ({ time }) => `代碼將在 ${time} 後過期`,
    deviceNewCode: '取得新代碼',
    detailSignedOutTitle: ({ service }) => `${service} 已將此帳號登出`,
    detailSignedOutBody: '登入已被撤銷或變更（例如變更了密碼）。在你重新登入之前，工作階段無法使用此帳號。',
    detailSignInTitle: '登入',
    detailSignInNeeded: '需要重新登入',
    detailSignInKeptFresh: 'Happier 會保持其有效',
    detailLastUsed: ({ time }) => `上次使用 ${time}`,
    detailLeavePool: ({ pool }) => `從 ${pool} 移除…`,
    detailRemovePooledNote: ({ pool }) => `${pool} 正在使用此帳號，請先將其從帳號池中移除。移除會將其從你的帳號和所有機器上刪除。`,
    detailUsageSignedOut: '上次已知 · 登出時無法重新整理',
    detailUsageSignedOutAt: ({ time }: { time: string }) => `上次已知時間 ${time} · 登出時無法重新整理`,
    detailResetsIn: ({ countdown }) => `${countdown} 後`,
    detailUsedByTitle: '使用者',
    detailUsedByDefault: '其預設帳號',
    detailUsedByPool: ({ pool }) => `透過 ${pool}`,
    detailUsedByPoolInUse: ({ pool }) => `透過 ${pool} · 正在使用`,
    detailUsedByCould: '可以使用 · 目前以其他方式登入',
    detailWorksOnTitle: '可用於',
    detailWorksOnDescription: '儲存在你的帳號中。機器會在其上啟動工作階段時使用，不會預先複製。',
    detailSignedInWithCode: '已透過代碼登入',
    detailSignedInWithBrowser: '已透過瀏覽器登入',
    detailAddedWithKey: '已透過金鑰新增',
    nearLimitTitle: ({ account, percent, window }) => `${account} 的 ${window} 限額還剩 ${percent}%`,
    nearLimitTitleNoAccount: ({ percent, window }) => `${window} 限額還剩 ${percent}%`,
    nearLimitBodyWithReset: ({ time }) => `將在 ${time} 重置。套用一次用量重置即可立即繼續。`,
    nearLimitBody: '套用一次用量重置即可立即繼續。',
    nearLimitApplyReset: '套用用量重置',
    catalogSignInBrowserOrCode: '透過瀏覽器或代碼登入',
    catalogSignInBrowserOrKey: '透過瀏覽器登入或貼上權杖',
    catalogSignInBrowser: '透過瀏覽器登入',
    catalogSignInCode: '透過代碼登入',
    catalogPasteKey: '貼上金鑰',
    deviceOpenService: ({ service }) => `開啟 ${service}`,
    deviceWaitingFor: ({ service }) => `等待你在 ${service} 中核准…`,
};

const connectedServicesSettingsTranslations = { zhHant };

return { connectedServicesSettingsTranslations };
})();

const Domain_connectedServicesSetupTranslations = (() => {
type ConnectedServicesSetupTranslation = Shared_connectedServicesSetupTranslations.ConnectedServicesSetupTranslation;

const connectedServicesSetupTranslations = { 'zh-Hant': {
        connectMoreTitle: '連接更多',
        connectMoreDescription: '你的機器上的代理可以使用、但你尚未連接的服務。',
        connectMoreNothingNew: '新增另一個帳號、程式碼託管平台或工具。',
        serviceSignInInstead: ({ agents }) => `${agents} 可以用它登入，而不必在每台機器上分別登入。`,
        serviceCanUse: ({ agents }) => `${agents} 可以使用它。`,
        moreServicesTitle: '更多服務',
        moreServicesTools: ({ names }) => `${names} 等，用於程式碼和工具。`,
        moreServicesAll: '你的代理和工具可以使用的一切。',
        browse: '瀏覽',
        notNow: ({ service }) => `暫不：${service}`,
        notNowTooltip: '暫不 · 仍可在瀏覽中找到',
        back: '所有服務',
        homeCatalogTitle: '連接帳號',
        homeCatalogPurpose: '你的代理會在每台機器上使用它，Home 會顯示剩餘額度。',
        homeNextSubtitle: ({ agents }) => `${agents} 可以使用它，而不必在每台機器上分別登入。`,
        firstRunMore: 'API 金鑰、程式碼託管和工具',
        settleAddToPoolWhy: ({ pool, agent, active }) => `將它加入 ${pool}，讓 ${agent} 在 ${active} 用完時切換過去？`,
        settleAddToPoolShort: ({ pool }) => `將它加入 ${pool}？`,
        settleAddToPool: ({ pool }) => `加入 ${pool}`,
        deviceStepCopy: '複製此代碼',
        deviceStepOpen: ({ service }) => `開啟 ${service} 並輸入代碼`,
        deviceStepOpenWhere: ({ where }) => `${where}，並登入你要使用的帳號`,
        deviceStepApprove: ({ service }) => `在 ${service} 中核准 Happier`,
        deviceCheckNow: '立即檢查',
    } } satisfies Pick<Readonly<Record<string, ConnectedServicesSetupTranslation>>, "zh-Hant">;

return { connectedServicesSetupTranslations };
})();

const Domain_detailPageTranslations = (() => {
type DetailPageTranslations = Shared_detailPageTranslations.DetailPageTranslations;

const detailPageTranslations = { 'zh-Hant': {
        approval: {
            requestTitle: '請求',
            requestDescription: '請求的內容及目前狀態。',
            failureTitle: '失敗原因',
            homeUnavailableTitle: 'Home 無法使用',
            contextTitle: '請求來源',
            contextDescription: '發起此請求的工作階段和代理。',
            sessionOnHome: ({ home }) => `${home} 上的工作階段`,
            sessionElsewhere: '不在此裝置上的工作階段',
            origin: {
                voice: '透過語音請求',
                agent: '由代理請求',
                mcp: '透過已連接的工具請求',
                cli: '從命令列請求',
                ui: '在應用程式中請求',
                api: '透過 API 請求',
                plugin: '由外掛程式請求',
                system: '由 Happier 請求',
            },
            proposalsDescription: '核准後將發佈到審查中。',
        },
        runs: {
            description: '你的機器上的背景執行。',
            filterLabel: '顯示的執行',
            filterRunning: '執行中',
            filterAll: '全部',
            onHome: ({ home }) => `位於 ${home}`,
        },
        person: {
            placeholderTitle: '使用者',
            friendshipTitle: '好友關係',
            sharedSessionsDescription: '此好友與你分享的工作階段，僅可檢視。',
            linkedAccountsTitle: '連結的帳號',
            linkedAccountsDescription: '對方在其他地方的登入方式。將在瀏覽器中開啟。',
        },
        friendsManage: {
            description: '你在 Happier 上合作的人，以及你們之間的請求。',
            requestsTitle: '好友請求',
            requestsDescription: '開啟請求以接受或拒絕。',
            sentTitle: '已傳送的請求',
            sentDescription: '等待對方接受。',
            friendsTitle: '好友',
            friendsDescription: '開啟好友以查看其與你分享的內容。',
        },
    } } as const satisfies Pick<Record<string, DetailPageTranslations>, "zh-Hant">;

return { detailPageTranslations };
})();

const Domain_detailsChromeTranslations = (() => {
type DetailsChromeTranslations = Shared_detailsChromeTranslations.DetailsChromeTranslations;

const detailsChromeTranslations = { 'zh-Hant': {
        closeUnsavedTabA11y: '關閉分頁，有未儲存的變更',
        emptyTitle: '檔案、變更和提交在這裡開啟',
        browseFiles: '瀏覽檔案',
        previewHint: '按一下開啟預覽分頁；再次開啟即可保留。',
        emptyReason: '你開啟的檔案、變更和提交會顯示在這裡，就在你開啟它們的位置旁邊。',
        reviewChanges: ({ count }) => `檢視 ${count} 處變更`,
        reviewChangesReason: ({ count }) => `此工作階段中有 ${count} 個檔案被變更。無需離開對話即可在這裡閱讀。`,
        splitNeedsWiderPane: '並排顯示需要更寬的面板。請加寬詳細資料或使用專注模式。',
    } } satisfies Pick<Record<string, DetailsChromeTranslations>, "zh-Hant">;

return { detailsChromeTranslations };
})();

const Domain_detailsFileTranslations = (() => {
type DetailsFileTranslations = Shared_detailsFileTranslations.DetailsFileTranslations;

const detailsFileTranslations = { 'zh-Hant': {
        areaUnstaged: '未暫存',
        areaStaged: '已暫存',
        areaBoth: '全部',
        areaLabel: '變更',
        preview: '預覽',
        viewLabel: '檢視',
        compare: '比較',
        stage: '暫存',
        unstage: '取消暫存',
        addToCommit: '加入提交',
        removeFromCommit: '移出提交',
        editing: '編輯中',
        editingUnsaved: '編輯中 · 有未儲存的變更',
        statusModified: '已修改',
        statusAdded: '已新增',
        statusDeleted: '已刪除',
        statusRenamed: '已重新命名',
        statusCopied: '已複製',
        statusUntracked: '新檔案，尚未追蹤',
        statusConflicted: '有衝突',
        noChanges: '沒有變更',
        lines: ({ count }) => `${count} 行`,
    } } satisfies Pick<Record<string, DetailsFileTranslations>, "zh-Hant">;

return { detailsFileTranslations };
})();

const Domain_detailsHistoryTranslations = (() => {
type Count = Shared_detailsHistoryTranslations.Count;

type Branch = Shared_detailsHistoryTranslations.Branch;

type Folder = Shared_detailsHistoryTranslations.Folder;

type DetailsHistoryTranslations = Shared_detailsHistoryTranslations.DetailsHistoryTranslations;

const detailsHistoryTranslations = { 'zh-Hant': {
        copyCommitSha: '複製提交 SHA',
        filesChanged: ({ count }) => `變更了 ${count} 個檔案`,
        files: ({ count }) => `${count} 個檔案`,
        revertEllipsis: '還原…',
        stashKeptOn: ({ branch }) => `保存在 ${branch}`,
        stashOriginBranch: ({ branch }) => `在你離開 ${branch} 時儲存`,
        stashOriginBranchShort: '切換分支時',
        stashOriginTransient: '由 Happier 儲存',
        stashOriginUnmanaged: '在 Happier 之外建立',
        stashRestoreExplains: ({ folder }) => `還原會把這些變更放回 ${folder} 並移除這個暫存。資料夾中的其他內容不會改變。`,
        stashApply: '套用',
        stashApplyA11y: '套用這些變更並保留暫存',
        stashDiscardEllipsis: '捨棄…',
        stashSwitcherA11y: '選擇暫存',
        stashCount: ({ count }) => `${count} 個暫存`,
    } } satisfies Pick<Record<string, DetailsHistoryTranslations>, "zh-Hant">;

return { detailsHistoryTranslations };
})();

const Domain_detailsReviewTranslations = (() => {
type Count = Shared_detailsReviewTranslations.Count;

type DetailsReviewTranslations = Shared_detailsReviewTranslations.DetailsReviewTranslations;

const detailsReviewTranslations = { 'zh-Hant': {
        title: '審查',
        files: ({ count }) => `${count} 個檔案`,
        nextCommit: ({ count }) => `下次提交包含 ${count} 個`,
        changedFiles: '已變更的檔案',
        commitColumn: '提交',
        jumpA11y: '跳到檔案',
        comments: ({ count }) => `${count} 則評論`,
        goesWithNext: ({ count }) => `隨下一則訊息傳送`,
        askForChanges: '請求修改',
        detachCommentA11y: '不隨下一則訊息傳送此評論',
        trayExpandedHint: '它們會隨你的下一則訊息傳送給代理。',
        askPlaceholder: '告訴代理要修改什麼…',
        send: '傳送',
        draftAuthor: '你', draftStatus: '草稿', includeComment: '隨下一則訊息傳送',
    } } satisfies Pick<Record<string, DetailsReviewTranslations>, "zh-Hant">;

return { detailsReviewTranslations };
})();

const Domain_embedSettingsTranslations = (() => {
const english = Shared_embedSettingsTranslations.english;

const translated = Shared_embedSettingsTranslations.translated;

const embedSettingsTranslations = { 'zh-Hant': translated({
        settingsEmbeds: {
            title: "嵌入",
            newTitle: "新增嵌入",
            purpose: "讓其他應用程式顯示 Happier 對話，只授予你選擇的存取權限。",
            yourEmbeds: "你的嵌入",
            newEmbed: "新增嵌入",
            listError: "無法載入嵌入",
            emptyTitle: "把 Happier 對話放進你自己的應用程式",
            emptyBody: "你的應用程式會顯示真實的對話，只授予你選擇的權限：哪些網站、誰可以傳送或核准，以及哪些模型。",
            createDescription: "選擇其他應用程式可以對你的對話做什麼，以及它們的外觀。",
            name: "名稱",
            nameDescription: "只在此清單中對你顯示。",
            namePlaceholder: "例如：潛在客戶看板",
            create: "建立嵌入",
            summary: {
                sites: ({ count }: { count: number }) => `${count} 個網站`,
                send: "可傳送",
                sendAndApprove: "可傳送與核准",
                viewOnly: "僅檢視",
                modelOnly: ({ name }: { name: string }) => `僅 ${name}`,
                models: ({ count }: { count: number }) => `${count} 個模型`,
            },
            sites: {
                title: "可顯示的位置",
                description: "對話只會在這些網站上開啟。",
            },
            capabilities: {
                title: "可以做什麼",
                view: "檢視對話",
                always: "一律",
                send: "傳送訊息",
                sendDescription: "包括停止代理程式與附加檔案。",
                changeModel: "變更模型",
                permissionModes: "權限模式",
                permissionModesDescription: "只有允許多種模式時，對話中才會顯示模式選擇。",
                anyMode: "任何模式",
                anyModeDescription: "使用者可以變更代理無須詢問即可執行的範圍。",
                modeOnly: ({ name }: { name: string }) => `僅 ${name}`,
                modes: ({ count }: { count: number }) => `${count} 種模式`,
                approveOn: "這些網站上的使用者可以核准這些對話中的工具使用與請求。",
            },
            models: {
                title: "模型",
                description: "其他模型會被拒絕，而不只是隱藏。對話從第一個允許的模型開始。",
                allowed: "允許的模型",
                any: "任何模型",
            },
            organization: {
                title: "整理",
                description: "你的應用程式從這裡列出此嵌入的對話（任一標籤）。新對話也會放在這裡。",
                folder: "資料夾",
                tags: "標籤",
                none: "無",
            },
            composer: {
                title: "輸入框",
                attachments: "附件",
                attachmentsDescription: "隱藏附件按鈕。可以傳送的人仍可透過 API 附加檔案。",
            },
            sessions: {
                title: "工作階段",
                description: "此金鑰從你的伺服器或對話中建立的工作階段，會在這台電腦上以這個代理程式執行，並放入上方的資料夾與標籤。",
                allow: "允許此金鑰建立工作階段",
                offConsequence: "此金鑰無法建立工作階段。你的應用程式只能顯示既有的對話。",
                computer: "電腦",
                agent: "代理程式",
                newChat: "在嵌入中開始新對話",
                appSetting: "應用程式設定",
                newChatDescription: "當你的應用程式在沒有對話的情況下開啟嵌入時，顯示新對話輸入框。這是應用程式的設定，而非安全限制：你的伺服器一律可以用此金鑰建立對話。",
            },
            appearance: {
                title: "外觀",
                description: "預覽會隨每次變更更新。已開啟的對話不需重新載入即可更新樣式。",
                mode: "模式",
                modeSystem: "跟隨系統",
                modeLight: "淺色",
                modeDark: "深色",
                theme: "主題",
                presetHappier: "Happier",
                colors: "顏色",
                colorsDefault: "Happier 預設",
                colorsCustomized: ({ count }: { count: number }) => `已自訂 ${count} 項`,
                colorsFor: "顏色適用於",
                colorGroups: {
                    surface: "表面",
                    text: "文字",
                    accent: "強調色",
                    messages: "訊息",
                    composer: "輸入框",
                    approvals: "核准",
                },
                fontFamily: "字型",
                fontFamilyPlaceholder: "Happier 預設",
                fontFile: "字型檔案",
                fontFileDescription: "指向 .woff2 或 .woff 檔案的 https 連結。",
                fontFileRefused: "請使用指向 .woff2 或 .woff 檔案的連結，而不是樣式表。",
                textSize: "文字大小",
                textSizeCompact: "緊湊",
                textSizeDefault: "預設",
                textSizeLarge: "大",
                corners: "圓角",
                cornersSharp: "直角",
                cornersSoft: "柔和",
                cornersRound: "圓潤",
                density: "密度",
                densityCompact: "緊湊",
                densityComfortable: "舒適",
                reset: "重設外觀",
            },
            preview: {
                title: "即時預覽",
                phone: "手機",
                desktop: "桌面",
                reduceMotion: "減少動態效果",
                note: "附範例訊息的真實嵌入對話。不會傳送任何內容。",
                rowDescription: "查看使用這些設定的對話。",
                unavailable: "預覽無法使用",
            },
            snippets: {
                title: "程式碼片段",
                description: "將它們貼到你的應用程式中。它們已使用此嵌入的設定。",
                steps: "1 將金鑰儲存為 HAPPIER_EMBED_KEY · 2 撰寫 canOpenSession：誰可以開啟哪個對話 · 3 顯示對話",
                backend: "後端",
                react: "React",
            },
            detail: {
                created: ({ date }: { date: string }) => `建立於 ${date}`,
                lastUsed: ({ date }: { date: string }) => `上次使用 ${date}`,
                expires: ({ date }: { date: string }) => `到期 ${date}`,
                reconnect: "已開啟的對話會以新的權限重新連線。草稿會保留。",
                e2eeTrust: "此金鑰可以讀取此帳號的加密對話。請為你的應用程式使用專用帳號。",
                keyReach: "金鑰保留在你的伺服器上，可以存取此帳號中的所有對話。瀏覽器永遠看不到它：瀏覽器只會取得短期金鑰，且僅限你的伺服器允許的對話。",
                expiry: "金鑰到期",
                expiryDescription: "金鑰到期後，對話將無法開啟。之後無法延長。",
                encryptionChecking: "正在檢查此帳號的加密…",
                encryptionUnavailable: "此裝置暫時無法讀取此帳號的加密對話。請還原你的秘密金鑰以建立嵌入。",
                encryptionStale: "此裝置用於加密對話的金鑰已過期。請還原你的秘密金鑰以建立嵌入。",
                encryptionUnreadable: "無法檢查此帳號的加密。",
                missingTitle: "此嵌入已不存在",
                backToEmbeds: "返回嵌入",
            },
            delete: {
                button: "刪除嵌入",
                title: ({ label }: { label: string }) => `刪除「${label}」？`,
                body: "已開啟的對話會中斷連線。已用於讀取加密對話的金鑰無法追回。",
                confirm: "刪除",
            },
            reveal: {
                copyEnv: "複製為 .env 行",
            },
        },
    }) };

return { embedSettingsTranslations };
})();

const Domain_embedTranslations = (() => {
const english = Shared_embedTranslations.english;

const translated = Shared_embedTranslations.translated;

const embedTranslations = { 'zh-Hant': translated({
        embed: {
            errors: {
                originNotAllowed: '此頁面不能顯示這段對話。',
                originNotAllowedReason: '請在 Happier 中將此網站加入嵌入的允許網站。',
                unavailable: '這段對話在此無法使用。',
                encrypted: '這段對話已加密，無法在此開啟。',
                createNotGranted: '此應用程式無法開始新對話。',
                unsupportedVersion: '此對話需要更新的嵌入版本。',
                unsupportedVersionReason: '請在此應用程式中更新 @happier-dev/embed。',
            },
            nothingToShow: '目前沒有內容',
            nothingToShowReason: '此應用程式尚未開啟任何對話。',
            reconnecting: '正在重新連線…',
            previewUnavailable: '無法預覽',
            previewUser: "分析這個潛在客戶並記錄結果：Acme Robotics，40 個席位，第四季評估。",
            previewAgent: "非常契合。預算已確認，推動者負責決策。我已記錄分析：",
            previewFollowUp: "要把這個潛在客戶移到「已確認」嗎？",
        },
    }) };

return { embedTranslations };
})();

const Domain_entityDragDropTranslations = (() => {
type EntityDragDropTranslations = Shared_entityDragDropTranslations.EntityDragDropTranslations;

const en = Shared_entityDragDropTranslations.en;

const zhHant: EntityDragDropTranslations = {
    files: { attach: "附加", uploadHere: "上傳到這裡" },
    composer: { addContext: "新增上下文", consequence: "隨你的下一則訊息送出 · 暫不送出任何內容", target: "輸入框", readOnly: "此輸入框為唯讀", otherWorkspace: "不屬於此工作區", unavailable: "此參照無法使用" },
    surface: {
        scopeMismatch: '它在另一個 Home 或帳戶中',
        widgetMoveUnavailable: '此元件無法移到這個介面區域',
        widgetReadOnly: '你可以檢視此版面，但不能變更。請向擁有者申請編輯權限',
        widgetAlreadyHere: '它已在這個介面區域。請在那裡重新排序',
        widgetCantLiveHere: '此元件無法放在這個介面區域。請從「加入元件」在這裡加入',
        widgetNeedsInputs: '它的輸入無法在這裡填寫。請從「加入元件」在這裡加入並選擇',
        widgetLayoutChanged: '此版面剛剛變更。請再放一次',
        readOnly: '此看板為唯讀',
        copyDetail: '保留參照 · 看板維持不變',
    },
    preview: {
        putUnder: ({ target }) => `放到 ${target} 下`,
        putUnderDetail: '向它回報 · 兩者都繼續執行',
        moveAbove: ({ target }) => `移到 ${target} 上方`,
        moveBelow: ({ target }) => `移到 ${target} 下方`,
        orderDetail: '僅調整順序 · 不建立回報關係',
        moveToFolder: ({ folder }) => `移到 ${folder}`,
        folderDetail: '僅調整資料夾 · 不向任何人回報',
        moveToTopLevel: '移到最上層',
        topLevelDetail: '移出資料夾 · 其他不變',
        cantPutUnder: ({ target }) => `無法放到 ${target} 下`,
        cantMoveHere: '無法移到這裡',
        pendingPutUnder: ({ target }) => `正在放到 ${target} 下…`,
        pendingDetail: '正在等待 Home 確認',
        unknownTitle: '不確定是否已移動',
        unknownDetail: '請稍後查看清單，再決定是否重試',
    },
    settled: {
        refusedPutUnder: ({ item, target }) => `無法將 ${item} 放到 ${target} 之下`,
        refused: ({ verb }) => `${verb}：未完成`,
        unknown: ({ verb }) => `不確定「${verb}」是否已完成`,
        dismiss: '關閉',
    },
    reasons: {
        read: '它以唯讀方式與你共用，因此無法接收回報',
        input: '你無法傳送內容給它，因此它無法接收回報',
        pairwise: '這兩個工作階段不能共用上下文',
        cycle: '該工作階段已經向這個工作階段回報',
        alreadyUnder: '它已經向這個工作階段回報',
        archived: '它已封存',
        differentHome: '它在另一個 Home 中。工作階段只能在同一個 Home 內回報',
        unavailable: '暫時無法檢查這個工作階段',
        dateOrder: '此清單依日期排序。切換為自訂順序後才能放置',
        noChange: '它已經在這裡',
        descendantCycle: '資料夾不能放進自己',
        maxDepth: '資料夾巢狀層級會過深',
        foldersOff: '此 Home 已關閉資料夾',
        gone: '那個位置剛剛消失了',
        generic: '這裡無法放置',
    },
    chooser: { putUnderTitle: ({ item }) => `將 ${item} 放到…之下`, checking: '正在檢查哪些工作階段可以接收回報…', cantTakeReports: '無法接收回報', unavailable: '無法使用' },
    keyboard: {
        choose: '選擇位置', putUnder: '放到下面', topLevel: '最上層', drop: '放下', cancel: '取消', escapeKey: 'Esc',
        hintsA11y: '方向鍵選擇位置，Enter 放下，Escape 取消',
    },
    organize: { enter: '整理清單', title: '整理', done: '完成', grip: ({ item }) => `移動 ${item}` },
    pane: {
        openHere: '在此以分頁開啟',
        nextTo: ({ target }) => `在 ${target} 旁邊 · 不會關閉任何內容`,
        nothingCloses: '以分頁開啟 · 不會關閉任何內容',
        tooNarrow: '此窗格太窄，無法分割',
        moveHere: '以分頁移到這裡',
        openBefore: ({ target }) => `在 ${target} 前開啟`,
        moveBefore: ({ target }) => `移到 ${target} 前`,
        placeOnly: '只改變位置',
        splitLeft: '向左分割',
        splitRight: '向右分割',
        splitUp: '向上分割',
        splitDown: '向下分割',
        opensBeside: ({ target }) => `在 ${target} 旁邊開啟`,
        movesBeside: ({ target }) => `移到 ${target} 旁邊`,
        goTo: ({ target }) => `前往 ${target}`,
        openInThisPane: '已在此窗格開啟 · 不會開啟新內容',
        openInAnotherPane: '已在另一個窗格開啟 · 不會開啟新內容',
        alreadyHere: '已在這裡',
        leaveIt: '放開即維持原位',
        cantOpenHere: '無法在這裡開啟',
        sessionsOnly: '此窗格只顯示工作階段',
        otherWorkspace: '不屬於此工作區',
    },
};

const entityDragDropTranslations = { zhHant };

return { entityDragDropTranslations };
})();

const Domain_eventAutomationComposerTranslations = (() => {
const english = Shared_eventAutomationComposerTranslations.english;

const zhHant = {
    eventAutomationComposer: {
        available: '可用',
        payloadFields: '有效負載字段',
        payloadSample: '範例有效負載',
        noFilterableFields: '此事件不聲明可過濾的有效負載欄位。',
        addFilterClause: '新增條件',
        filterField: '過濾字段',
        filterOperator: '過濾運算符',
        filterEquals: '等於',
        filterOneOf: '是其中之一',
        filterValue: '過濾值',
        filterValuePlaceholder: '“值”或[“值”]',
        storedContentUnavailableTitle: '儲存的自動化內容不可用',
        storedContentUnavailableBody: '無法保存此事件自動化，因為其儲存的內容不可用。',
        historyGapRecoveryTitle: '歷史差距需重視',
        historyGapRecoverySubtitle: '重置來源基線以繼續觀察新事件。',
        historyGapRecoveryUnavailable: '來源恢復操作在目前觀察程序上不可用。',
        historyGapRecoveryFailureTitle: '來源恢復需要再次嘗試',
        historyGapRecoveryFailureBody: '康復情況尚未得到證實。消息來源仍需關注。',
        sourceStatusTitle: '觀察來源',
        sourceStatusState: {
            uninitialized: '尚未開始',
            baselined: '基準線已就緒',
            observing: '正在觀察',
            backingOff: '等待重試',
            attention: '需要注意',
        },
        sourceStatusCode: {
            credentialMissing: '需要憑證',
            credentialRevoked: '憑證已撤銷',
            rateLimited: '已達速率限制',
            historyGap: '歷史記錄有缺口',
            capacityBlocked: '容量已滿',
            definitionStale: '定義已變更',
            sourceContractIncompatible: '來源需要更新',
            admissionUnavailable: '無法接納',
        },
        sourceStatusNextRetry: ({ time }: { time: string }) => `下次重試：${time}`,
        sourceStatusObservedCount: ({ count }: { count: number }) => `已觀察事件：${count}`,
        sourceStatusAdmittedCount: ({ count }: { count: number }) => `已接納事件：${count}`,
        sourceStatusSkippedCount: ({ count }: { count: number }) => `已略過事件：${count}`,
        sourceStatusLastObserved: ({ time }: { time: string }) => `最近觀察時間：${time}`,
        sourceCatalogStatusTitle: '目錄協調',
        sourceCatalogStatusState: {
            current: '目前',
            reconciling: '正在協調',
            reconciliationLate: '協調延遲',
        },
        sourceCatalogStatusObservedRevision: ({ revision }: { revision: string }) => `觀察到的版本：${revision}`,
        sourceCatalogStatusAdoptedRevision: ({ revision }: { revision: string }) => `採用的版本：${revision}`,
        sourceCatalogStatusNoAdoptedRevision: '尚未採用任何版本',
        sourceCatalogStatusScanStarted: ({ time }: { time: string }) => `掃描開始時間：${time}`,
    },
};

const eventAutomationComposerTranslations = { 'zh-Hant': zhHant } as const;

return { eventAutomationComposerTranslations };
})();

const Domain_externalSessionOperationTranslations = (() => {
const en = Shared_externalSessionOperationTranslations.en;

const translated = Shared_externalSessionOperationTranslations.translated;

const externalSessionOperationTranslations = { zhHant: {
    browseLinked: '已連結',
    browseImported: '已匯入',
    browseAgentUnavailable: 'Happier 無法在此機器上啟動或連線至所選 Agent。請確認其 CLI 已安裝，然後重試。',
    browseAgentTimedOut: '此機器上所選的 Agent 未及時回應。它可能正忙或仍在建立索引，請重試。',
    browseAgentFailed: 'Happier 無法讀取此機器上所選 Agent 的工作階段。請重試；如果仍然失敗，請更新該機器上的 Happier。',
    operationTitleMaterialize: '匯入 Happier',
    operationTitleTakeoverLinked: '接管並保持連結',
    operationTitleTakeoverPersisted: '匯入並接管',
    operationMaterializeAvailable: '匯入此連結工作階段，以便離線使用其記錄或進行分享。',
    externalAgentStatusOnMachine: ({ agent, machine, status }: { agent: string; machine: string; status: string }) =>
        `${agent} 上的 ${machine}：${status}`,
    operationStatusRunning: '進行中',
    operationStatusCancelling: '正在取消…',
    operationStatusCancelled: '已取消',
    operationStatusCompleted: '已完成',
    operationStatusDiscarded: '已捨棄部分工作階段',
    operationStatusNeedsResume: '等待你繼續',
    operationStatusNeedsReview: '繼續前需要檢查',
    operationStatusFailed: '無法繼續',
    operationStatusImportIncomplete: '匯入未完成 — 繼續或丟棄部分工作階段',
    operationStatusUpdateIncomplete: '更新未完成 — 繼續',
    operationStatusOriginOffline: '進度已儲存 — 來源機器離線',
    operationStatusOriginUnknown: '進度已儲存 — Happier 無法確認來源機器是否在線',
    operationStatusExternalWriter: '偵測到外部寫入者',
    operationStatusSpawnFailedAfterImport: '已匯入，但 Agent 無法啟動 — 重試啟動',
    operationStatusSpawnFailedAfterTakeover: '已接管，但 Agent 無法啟動 — 重試啟動',
    operationErrorSourceUnavailable: '來源無法使用。請重新連線來源機器，然後繼續。',
    operationErrorSourceChanged: '讀取期間來源已變更。請檢查後再繼續。',
    operationErrorCapacity: '此機器沒有足夠的暫存空間繼續操作。',
    operationErrorRequiredItems: '部分必要的工作階段項目無法匯入。',
    operationErrorImport: '訊息匯入已中斷。',
    operationErrorPublication: '無法發布已匯入的快照。',
    operationErrorAdmission: 'Happier 無法安全接管此工作階段。',
    operationErrorExternalWriter: '請先停止外部 Agent 再重試。Happier 不會自動合併或停止它。',
    operationErrorInternal: '操作因內部錯誤而停止。',
    operationPhaseValidating: '正在驗證',
    operationPhaseWaitingForAgent: '等待外部 Agent 停止',
    operationPhaseReadingSource: '正在讀取來源',
    operationPhaseImporting: '正在匯入訊息',
    operationPhaseCatchingUp: '正在與來源同步',
    operationPhasePreparingRuntime: '正在準備執行環境',
    operationPhaseStartingRuntime: '正在啟動執行環境',
    operationPhaseFinalizing: '正在完成',
    operationPhasePublishing: '正在發布已匯入的工作階段',
    operationActionResume: '繼續',
    operationActionRetryStart: '重試啟動',
    operationActionCancel: '取消',
    operationActionDiscard: '丟棄部分工作階段',
    operationActionDismiss: '關閉',
    operationStatusOwnerReadFailed: 'Happier 無法讀取此操作的最新進度。',
    operationActionCheckAgain: '重新檢查',
    operationComposerImporting: '正在匯入…',
    operationComposerTakingOver: '正在接管…',
    operationActionErrorUpgradeRequired: '請更新來源機器上的 Happier 以使用此操作。',
    operationActionErrorNotFound: '此操作已無法使用。',
    operationActionErrorConflict: '另一項操作已在控制此工作階段。',
    operationActionErrorStaleRevision: '操作已變更。請查看最新進度後再試一次。',
    operationActionErrorInvalidState: '目前的操作狀態下無法使用此操作。',
    operationActionErrorNotAllowed: '你沒有控制此操作的權限。',
    operationActionErrorUnavailable: '無法完成此操作。請從最新進度再試一次。',
    operationImportProgress: '匯入進度',
    operationImportCountUnknown: ({ imported }: { imported: number }) => `已匯入 ${imported} 則訊息`,
    operationImportCountEstimated: ({ imported, total }: { imported: number; total: number }) => `約 ${imported} 則訊息中已匯入 ${total} 則`,
    operationPublishedSnapshot: '已保留發布的快照',
    operationPublishedThrough: ({ sequence }: { sequence: number }) => `可用至訊息 ${sequence}`,
    operationDiscardConfirmTitle: '捨棄部分工作階段？',
    operationDiscardConfirmBody: '這會刪除整個部分工作階段，且無法復原。',
    sharingTranscriptOnMachine: ({ machine }: { machine: string }) =>
        `此工作階段的記錄位於 ${machine}。請將它匯入 Happier 後再分享。`,
    sharingImportIncomplete: '匯入正在進行或尚未完成。請先繼續匯入再分享。',
    sharingTranscriptUnavailableTitle: '工作階段記錄無法使用',
    transcriptRetainedRefreshFailedTitle: '正在顯示最近一次取得的工作階段記錄',
    transcriptLoadFailed: 'Happier 無法載入此工作階段記錄。',
    sharingTranscriptUnavailable: '工作階段記錄無法使用。此舊版連結工作階段沒有安全保存的記錄。',
    sharingSharedUpTo: ({ time }: { time: string }) => `已分享至 ${time}`,
    sharingSnapshotFrom: ({ time }: { time: string }) => `${time} 的快照`,
    sharingUpdateSharedCopy: '更新分享副本',
    sharingUpdateSharedCopyDescription: '使用來源中的最新工作階段記錄重新整理分享快照。',
    sharingSourceMachineMissing: '來源機器無法使用。請先將它重新連線到 Happier，然後再試一次。',
    sharingSourceMachineOffline: '來源機器已離線。請先讓它上線，然後再試一次。',
    sharingActionAwaitingAvailability: '連接實體化流程後即可使用此操作。',
} } as const;

return { externalSessionOperationTranslations };
})();

const Domain_externalSessionSettingsTranslations = (() => {
const en = Shared_externalSessionSettingsTranslations.en;

const translated = Shared_externalSessionSettingsTranslations.translated;

const externalSessionSettingsTranslations = { zhHant: {
    settingsIntegrationStatusNotInstalled: '未安裝',
    settingsIntegrationStatusEnabled: '已安裝並啟用',
    settingsIntegrationStatusDisabled: '已安裝但未啟用',
    settingsIntegrationStatusNeedsAttention: '需要處理',
    settingsIntegrationStatusUnsupported: '此 Agent 版本不支援',
    settingsIntegrationStatusUnavailable: 'Agent 無法使用',
    settingsIntegrationInventoryLoadingTitle: '正在檢查整合狀態',
    settingsIntegrationInventoryLoadingSubtitle: '正在從此機器讀取完整的整合清單。',
    settingsIntegrationInventoryPartialTitle: '整合狀態不完整',
    settingsIntegrationInventoryPartialSubtitle: '部分安裝記錄無法讀取。請在變更前重新檢查。',
    settingsIntegrationInventoryErrorTitle: '整合狀態無法使用',
    settingsIntegrationInventoryErrorSubtitle: '上次已知狀態可能已過期。請在變更前重新檢查。',
    settingsIntegrationTitle: '外部工作階段監控',
    settingsIntegrationNeedsAttentionTitle: '需要處理',
    settingsIntegrationDiagnosticMessageUnavailable: '此安裝需要處理後才能繼續監控。',
    settingsIntegrationRemediationRetry: '解決問題後請重新檢查。',
    settingsIntegrationRemediationOpenSettings: ({ path }: { path: string }) => `請檢查 ${path} 中的設定。`,
    settingsIntegrationRemediationSelectAccount: ({ service }: { service: string }) => `請為 ${service} 選擇一個帳戶。`,
    settingsIntegrationRemediationInstallDependency: ({ dependency }: { dependency: string }) => `請安裝必要的相依項目：${dependency}。`,
    settingsIntegrationRemediationOpenUrl: ({ url }: { url: string }) => `請查看 ${url} 中的說明。`,
    settingsIntegrationActionReviewInstall: '檢查並安裝',
    settingsIntegrationActionDisable: '停用',
    settingsIntegrationActionEnable: '啟用',
    settingsIntegrationActionUninstall: '解除安裝',
    settingsIntegrationActionCheckAgain: '重新檢查',
    settingsIntegrationReviewTitle: ({ agent }: { agent: string }) => `檢查 ${agent} 整合`,
    settingsIntegrationReviewBody: ({ entries }: { entries: string }) =>
        `Happier 只會管理以下項目：${entries}。`,
    settingsIntegrationReviewBodyUnavailable: '安裝前請檢查由 Agent 管理的變更。',
    settingsIntegrationPreviewNoMatcher: '所有相符的工作階段',
    settingsIntegrationActionInstall: '安裝',
    settingsIntegrationUninstallTitle: ({ agent }: { agent: string }) => `解除安裝 ${agent} 整合？`,
    settingsIntegrationUninstallBody: '這只會刪除 Happier 管理的項目，其他 Agent 設定保持不變。',
    settingsIntegrationActionFailed: 'Happier 無法更新此整合。請檢查機器後再試一次。',
    settingsAutoLinkUpdateFailed: 'Happier 無法更新自動連結。請再試一次。',
    settingsRestoreUpdateFailed: 'Happier 無法更新重新啟動後的背景同步設定。請再試一次。',
    settingsIntegrationsGroupTitle: '外部工作階段監控',
    settingsIntegrationsFooter: 'Happier 只會在你明確操作後變更 Agent 設定。開啟此頁面不會進行變更。',
    settingsIntegrationsUnavailableTitle: '沒有可用的整合',
    settingsIntegrationsUnavailableSubtitle: '連接支援的 Agent 整合以檢查其狀態和可用操作。',
    settingsAgentAutoLinkTitle: ({ agent }: { agent: string }) => `自動加入新的 ${agent} 工作階段`,
    settingsAutoLinkTitle: '自動加入新的外部工作階段',
    browseAutoLinkTitle: '自動加入新工作階段',
    settingsAutoLinkGroupTitle: '自動連結',
    settingsAutoLinkGroupFooter: '自動連結預設關閉，並且與 Agent 整合設定和背景同步相互獨立。',
    settingsAutoLinkUnavailableTitle: '沒有可用於自動連結的來源',
    settingsAutoLinkUnavailableSubtitle: '此機器上沒有支援的來源範圍。',
    settingsAutoLinkSubtitle: '啟用後，Happier 會連結此來源中支援的新工作階段，而不會開啟或繼續 Agent。',
    settingsAutoLinkHint: '為此來源開啟或關閉自動連結。',
    settingsPrivacyGroupTitle: '隱私',
    settingsPrivacyTitle: '有界且不含內容的觀察',
    settingsPrivacySubtitle: '受信任的 Agent 整合可能會檢查此機器上有界的原生 hook 資料。Happier 只接收和同步不含內容的觀察；主機絕不會儲存、同步或記錄原始載荷、路徑、憑證、提示、工作階段記錄文字或工具參數。',
    settingsAgentActionsGroupTitle: '外部工作階段',
    settingsAgentBrowseTitle: ({ agent }: { agent: string }) => `瀏覽 ${agent} 外部工作階段`,
    settingsManageAllTitle: '管理所有外部工作階段設定',
    settingsManageAllSubtitle: '檢查已連接機器上的整合和背景同步。',
    settingsMachineOnline: '在線',
    settingsMachineOffline: '離線',
    settingsMachineTitle: '機器',
    settingsMachineUnavailable: '沒有已連接的機器',
    browseSearchIncomplete: ({ count }: { count: number }) =>
        `顯示前 ${count} 個結果 — 請縮小搜尋範圍`,
    browseAnnotationsIncomplete: '部分狀態無法確認。開啟工作階段時會進行檢查。',
    browseRouteUnavailableTitle: '此處無法使用外部工作階段',
    browseRouteUnavailableSubtitle: '此伺服器不提供外部工作階段瀏覽。請返回並選擇其他伺服器，或稍後再試。',
    browseRouteAvailabilityUnknownTitle: '無法確認是否支援外部工作階段',
    browseRouteAvailabilityUnknownSubtitle: 'Happier 無法確認此伺服器是否提供外部工作階段瀏覽。請返回並稍後再試。',
    browseHeaderTitle: '外部工作階段',
    browseSettingsLink: '外部工作階段設定',
    browseChooseMachineTitle: '選擇機器',
    browseChooseMachineBody: '外部工作階段保存在執行它們的機器上。選擇一台機器以查看其工作階段。',
    browseMachineGoneBody: '它已被移除或取代。選擇其他機器以查看其工作階段。',
    browseHomeUnreachableBody: '可以連線後，它的機器和工作階段會顯示在這裡。在此期間請選擇其他機器。',
    browseMachineOfflineTitle: ({ machine }: { machine: string }) => `${machine} 已離線`,
    browseThisMachineOfflineTitle: '這台機器已離線',
    browseMachineOfflineBody: '重新連線後會顯示其工作階段。',
    browseChooseAnotherMachine: '選擇其他機器',
    browseCantReachTitle: ({ machine }: { machine: string }) => `無法連線到 ${machine} 上的 Happier`,
    browseCantReachBody: '機器在線上，但其 Happier 服務沒有回應，可能仍在啟動。',
    browseNothingToBrowseTitle: ({ machine }: { machine: string }) => `${machine} 上沒有可瀏覽的內容`,
    browseNothingToBrowseBody: '這台機器上的代理目前都無法分享工作階段。',
    browseEmptyTitle: ({ agent, machine }: { agent: string; machine: string }) => `${machine} 上沒有 ${agent} 工作階段`,
    browseEmptyBody: '你在這台機器上啟動的工作階段會顯示在這裡，可在 Happier 中開啟。',
    browseTryAgent: ({ agent }: { agent: string }) => `試試 ${agent}`,
    browseNoMatches: ({ query }: { query: string }) => `沒有符合「${query}」的工作階段`,
    browseErrorTitle: '無法載入工作階段',
    browseThisMachine: '這台機器',
    browseIndexingStop: '停止',
    browseThreadsFilter: '子代理執行緒',
    browseThreadsHidden: '僅頂層工作階段',
    browseThreadsShown: '包含子代理執行緒',
    browseThreadReviewer: '審查者',
    browseThreadSubagent: '子代理',
    browseThreadReviewerOf: ({ parent }: { parent: string }) => `${parent} 的審查者`,
    browseThreadSubagentOf: ({ parent }: { parent: string }) => `${parent} 的子代理`,
} };

return { externalSessionSettingsTranslations };
})();

const Domain_filesPaneTranslations = (() => {
type FilesPaneTranslations = Shared_filesPaneTranslations.FilesPaneTranslations;

const filesPaneTranslations = { 'zh-Hant': {
        changedOnly: '僅顯示變更',
        showAllFiles: '顯示所有檔案',
        viewOptions: '檢視選項',
        sizeAndDate: '大小和日期',
        newMenu: '新增檔案、新增資料夾或上傳',
        newFile: '新增檔案',
        newFolder: '新增資料夾',
        noChangedFilesTitle: '沒有任何變更',
        noChangedFilesReason: '工作副本與最近一次提交一致。',
        rootErrorTitle: ({ machine }) => `無法列出 ${machine} 上的檔案`,
        rootErrorTitleUnnamed: '無法列出檔案',
        workspaceUnavailableReason: 'Happier 無法確定此工作階段的機器和資料夾。',
    } } as const satisfies Pick<Record<string, FilesPaneTranslations>, "zh-Hant">;

return { filesPaneTranslations };
})();

const Domain_findTranslations = (() => {
type FindTranslations = Shared_findTranslations.FindTranslations;

const slavicPlural = Shared_findTranslations.slavicPlural;

const russianPlural = Shared_findTranslations.russianPlural;

const en = Shared_findTranslations.en;

const zhHant: FindTranslations = {
    open: '尋找…',
    openedForMatch: '已展開相符位置', foldAgain: '重新摺疊', showHiddenLines: ({ count }) => `顯示 ${count} 個隱藏行`,
    surface: {
        chat: '在聊天中尋找',
        changes: '在變更中尋找',
        file: '在檔案中尋找',
        terminal: ({ name }) => `在 ${name} 中尋找`,
    },
    previous: '上一個相符項目',
    next: '下一個相符項目',
    matchCase: '區分大小寫',
    regex: '使用規則運算式',
    regexShort: '規則運算式',
    options: '搜尋選項',
    close: '關閉尋找',
    done: '完成',
    stop: '停止',
    noMatches: '沒有相符項目',
    noneFound: '未找到',
    invalidPattern: '無效的模式',
    offline: '離線',
    unsupported: '此處無法尋找',
    count: ({ current, total }) => (current === null ? `${total} 個相符項目` : `${current}/${total}`),
    files: ({ count }) => `${count} 個檔案`,
    soFar: '（進行中）',
    loaded: '（已載入）',
    note: {
        searchingOlder: '正在尋找較早的訊息，於此裝置上解密',
        offlineOlder: '恢復連線後即可尋找較早的訊息。',
        terminalKept: ({ lines }) => `已尋找此終端機保留的最近 ${lines} 行。`,
    },
};

const findTranslations = { zhHant };

return { findTranslations };
})();

const Domain_folderlessSessionTranslations = (() => {
type FolderlessSessionTranslations = Shared_folderlessSessionTranslations.FolderlessSessionTranslations;

const en = Shared_folderlessSessionTranslations.en;

const zhHant: FolderlessSessionTranslations = {
    composer: {
        addFolder: '新增資料夾',
        noFolder: '不使用資料夾',
        noFolderDescription: 'Happier 會為此對話保留一個私人資料夾',
        removeFolder: '移除資料夾',
        a11y: {
            folder: ({ path }) => `資料夾：${path}。開啟資料夾選項。`,
            none: '不使用資料夾。Happier 會為此對話保留一個私人資料夾。新增資料夾。',
            loading: '正在載入資料夾',
            noFolderRow: '不使用資料夾，此對話的私人資料夾',
            removed: '已移除資料夾',
            set: ({ path }) => `資料夾已設為 ${path}`,
        },
    },
    display: {
        chats: '對話',
        untitledChat: '新對話',
        folder: '資料夾',
        privateToSession: '僅限此工作階段',
        sessionFiles: '工作階段檔案',
        privateFolderOn: ({ machine }) => `${machine} 上的私人資料夾`,
    },
};

const folderlessSessionTranslations = { zhHant: zhHant };

return { folderlessSessionTranslations };
})();

const Domain_glassAppearanceTranslations = (() => {
const englishTranslations = Shared_glassAppearanceTranslations.englishTranslations;

const effectiveTranslations = { "zh-Hant": {
        "effectiveBrowserSolid": "選單和浮動控制項使用不透明材質。瀏覽器無法透出桌面。",
        "effectiveFloatingSolid": "此裝置的浮動控制項使用不透明材質。",
        "effectiveSolid": "此裝置使用不透明介面。",
        "effectiveBrowser": "選單和浮動控制項使用玻璃。瀏覽器無法透出桌面。",
        "effectiveBrowserCustom": "選單和浮動控制項使用所選材質。瀏覽器無法透出桌面。",
        "effectivePhone": "浮動控制項和面板使用玻璃。",
        "effectiveLayered": "此視窗全域使用分層玻璃。",
        "effectiveUniform": "此視窗全域使用統一玻璃。",
        "effectiveCustom": "此視窗使用你自訂的玻璃。",
        "effectiveUnavailable": "視窗玻璃無法使用。浮動控制項仍使用所選材質。",
        "effectiveInactive": "此視窗未啟用時使用不透明材質。",
        "effectiveTint": "此裝置的浮動控制項帶有色調，背景模糊無法使用。",
        "description": "讓桌面透過視窗，讓頁面透過浮動控制項。",
        "descriptionBrowser": "讓頁面透過選單和浮動控制項。",
        "descriptionPhone": "讓頁面透過浮動控制項和面板。",
        "chromeDescription": "標題列、導覽列和視窗背景",
        "sidebarDescription": "工作階段欄",
        "contentDescription": "對話、輸入框和工作面板",
        "floatingDescription": "選單、彈出框、面板和浮動控制項",
        "clear": "透明",
        "shortcutHint": ({ modifier }: { modifier: string }) => `${modifier}-點擊 · ${modifier}⇧L 切換淺色和深色`
    } } as const;

const glassAppearanceTranslations = { 'zh-Hant': { iosReduceTransparencyPath: "設定 › 輔助使用 › 顯示與文字大小 › 降低透明度", title: '玻璃', material: '材質', solid: '不透明', auto: '自動', everywhere: '全域', custom: '自訂', blur: '模糊', off: '關閉', opacity: '不透明度', customize: '自訂', chrome: '視窗邊框', sidebar: '側邊欄', content: '內容', floating: '浮動介面', appearance: '外觀', moreSettings: '更多外觀設定…', customizeLink: '自訂…', toolbarTitle: '外觀按鈕', toolbarDescription: '在工具列顯示外觀。按住修飾鍵點擊可切換淺色和深色。', reduceTransparency: '已開啟降低透明度，因此顯示不透明材質', osSettings: '開啟輔助使用設定', themeCommand: '切換淺色和深色', autoDescription: "適應目前裝置：支援的桌面視窗使用分層玻璃，手機僅在浮動介面使用玻璃。", osSettingsUnavailable: "無法開啟輔助使用設定。請在裝置設定中開啟。", ...effectiveTranslations["zh-Hant"] } } satisfies Pick<Record<string, Record<keyof typeof englishTranslations, string | ((params: { modifier: string }) => string)>>, "zh-Hant">;

return { effectiveTranslations, glassAppearanceTranslations };
})();

const Domain_goalControlTranslations = (() => {
const en = Shared_goalControlTranslations.en;

const zhHant: typeof en = {
    row: {
        notSet: '未設定',
    },
    keepGoing: {
        title: '持續推進直到完成',
        nativeDescription: ({ agent }) => `${agent} 會自行朝目標繼續工作。`,
        description: ({ rounds }) => `在你的每個回合結束後，一個代理會檢查目標並繼續推進，直到完成、預算用盡或不再有進展，最多 ${rounds} 輪。`,
        roundsPrefix: '在',
        roundsSuffix: '輪後停止',
        roundsLabel: '停止前的輪數',
        strikesPrefix: '在',
        strikesSuffix: '次無進展檢查後停止',
        strikesLabel: '停止前的無進展檢查次數',
        secondOpinionTitle: '完成前徵求第二意見',
        secondOpinionDescription: '在目標標記為完成之前，會由另一個代理檢查。如果它不同意，你會收到通知，目標保持未完成。',
        budgetUnreported: ({ agent }) => `${agent} 不回報 token 用量，因此只適用輪數和進展檢查。`,
    },
};

const goalControlTranslations = { zhHant };

return { goalControlTranslations };
})();

const Domain_homeAddTranslations = (() => {
type HomeAddTranslation = Shared_homeAddTranslations.HomeAddTranslation;

const en = Shared_homeAddTranslations.en;

const homeAddTranslations = { 'zh-Hant': {
        addressIsSignInService: '此位址是登入服務。請透過該服務登入，以尋找你的 Home。',
        mixedContent: '此瀏覽器無法從 HTTPS 頁面連線至 HTTP Home。請透過 HTTP 開啟 Happier，或使用 Home 的 HTTPS 位址。',
        connectedToHome: ({ home }) => `${home} 已連線至此裝置。`,
        openHome: ({ home }) => `開啟 ${home}`,
        showAllHomes: '顯示所有 Home',
        otherSignInService: '其他登入服務',
        otherSignInServiceSubtitle: '自行託管或公司服務',
        signInServiceAddress: '服務位址',
    } } satisfies Pick<Record<string, HomeAddTranslation>, "zh-Hant">;

return { homeAddTranslations };
})();

const Domain_homeComposerTranslations = (() => {
type HomeComposerTranslation = Shared_homeComposerTranslations.HomeComposerTranslation;

const starterPrompts = Shared_homeComposerTranslations.starterPrompts;

const homeComposerTranslations = { 'zh-Hant': {
        ...starterPrompts,
        suggestionsLabel: '建議',
        summarizeProjectSince: ({ project, day }) => `總結 ${project} 自${day}以來的變更`,
        summarizeProjectToday: ({ project }) => `總結 ${project} 今天的變更`,
        sessionsSince: ({ count, day }) => `自${day}以來 ${count} 個工作階段`,
        sessionsToday: ({ count }) => `今天 ${count} 個工作階段`,
    } } satisfies Pick<Readonly<Record<string, HomeComposerTranslation>>, "zh-Hant">;

return { homeComposerTranslations };
})();

const Domain_homeDeviceApprovalTranslations = (() => {
type HomeDeviceApprovalTranslation = Shared_homeDeviceApprovalTranslations.HomeDeviceApprovalTranslation;

const homeDeviceApprovalTranslations = { 'zh-Hant': {
        title: '裝置核准', deviceFallback: '新裝置',
        homeLabel: ({ home }) => `Home：${home}`, expiresLabel: ({ expiry }) => `到期時間：${expiry}`,
        requestDetails: '請求詳細資料', requestDetailsHint: '顯示請求金鑰識別碼',
        fingerprintLabel: '請求金鑰指紋', requestDetailsHelp: '這是請求金鑰的識別碼，不是需要比對的代碼。',
        approve: '核准', reject: '拒絕', loadError: '無法載入裝置核准請求。',
        loadErrorUnreachable: ({ homes }) => `${homes} 沒有回應。`, loadErrorFailed: ({ homes }) => `${homes} 傳回了錯誤。`,
        decisionError: '無法更新此請求。', decisionRecovery: '請選擇「核准」或「拒絕」後再試一次。',
        approved: '裝置已核准', rejected: '裝置已拒絕', expired: '已過期', stopWaiting: '停止等待',
    } } as const satisfies Pick<Record<string, HomeDeviceApprovalTranslation>, "zh-Hant">;

return { homeDeviceApprovalTranslations };
})();

const Domain_homeFeatureTranslations = (() => {
const en = Shared_homeFeatureTranslations.en;

const zhHant: typeof en = {
    teams: {
        title: '團隊',
        description: '共享工作階段、機器和存取權限的群組。',
        credentialResources: {
            title: '團隊憑證',
            description: '團隊與其工作階段共享的憑證。',
            externalApi: {
                title: '團隊憑證 API',
                description: '外部工具透過 API 使用團隊的憑證。',
            },
        },
    },
    automations: {
        title: '自動化',
        description: '依排程或觸發執行的代理工作。',
    },
    workflows: {
        title: '工作流程',
        description: '多步驟的代理管線。',
    },
    pets: {
        sync: {
            title: '寵物同步',
            description: '讓每個人的寵物在其所有裝置上保持一致。',
        },
    },
    voice: {
        title: '語音',
        description: '與你的代理對話。',
        happierVoice: {
            title: 'Happier 語音',
            description: '透過這個 Home 提供的語音服務使用語音。',
        },
    },
    connectedServices: {
        group: '已連結服務',
        quotas: {
            title: '配額計量',
            description: '顯示每個已連結帳號剩餘的配額。',
        },
        subscription: {
            title: '訂閱狀態',
            description: '顯示每個已連結帳號的方案和狀態。',
        },
        accountGroups: {
            title: '帳號群組',
            description: '將已連結的帳號組成帳號池。',
        },
        accountFallback: {
            title: '帳號備援',
            description: '一個帳號用完時切換到池中的下一個帳號。',
        },
        autoQuotaReset: {
            title: '自動重設配額',
            description: '池中所有帳號用完後，使用累積的配額重設次數。',
        },
        autoDisablePlanInvalid: {
            title: '略過無法使用的帳號',
            description: '停用池中無法使用所選模型的帳號。',
        },
        poolQuotaLimitSelection: {
            title: '帳號池配額限制',
            description: '選擇每個帳號池依循的供應商配額。',
        },
    },
    updates: {
        ota: {
            title: 'OTA 更新',
            description: 'App 不必透過商店即可安裝更新。',
        },
    },
    attachments: {
        uploads: {
            title: '附件',
            description: '傳送檔案和圖片給工作階段中的代理。',
        },
    },
    sharing: {
        group: '分享',
        session: {
            title: '工作階段分享',
            description: '與這個 Home 上的某人分享工作階段。',
        },
        public: {
            title: '公開連結',
            description: '透過公開連結分享工作階段內容。',
        },
        contentKeys: {
            title: '加密分享',
            description: '交換金鑰，讓分享的工作階段保持端對端加密。',
        },
        pendingQueueV2: {
            title: '共享訊息佇列',
            description: '代理忙碌時，將共享工作階段的訊息排入佇列。',
        },
        pendingDeliveryState: {
            title: '佇列送達追蹤',
            description: '記錄哪些排入佇列的訊息已送達代理。',
        },
    },
    sessions: {
        title: '工作階段',
        description: '工作階段及其控制項。',
        group: '工作階段',
        handoff: {
            title: '工作階段移交',
            description: '將執行中的工作階段移到另一台機器。',
        },
        ephemeralRunner: {
            title: '臨時執行器',
            description: '在一次性機器上啟動工作階段。',
        },
        agentSwitching: {
            title: '切換代理',
            description: '用另一個程式碼代理繼續工作階段。',
        },
        folders: {
            title: '工作階段資料夾',
            description: '用資料夾整理工作階段。',
        },
        drafts: {
            title: '同步草稿',
            description: '在每台裝置上保留未傳送的訊息和新工作階段草稿。',
        },
        following: {
            title: '追蹤',
            description: '追蹤工作階段以接收其更新和通知。',
        },
        conversations: {
            title: '對話',
            description: '成員在共享工作階段中交談並互相提及。',
        },
        board: {
            title: '工作階段看板',
            description: '在共享看板上排列工作階段及其項目。',
        },
        filteredListing: {
            title: '篩選清單',
            description: '在分頁之前篩選這個 Home 上的工作階段清單。',
        },
        usageLimitRecovery: {
            title: '用量上限復原',
            description: '代理達到用量上限時，等待後繼續或重試。',
        },
    },
    machines: {
        title: '機器',
        description: '與你的機器的連線。',
        group: '機器',
        pools: {
            title: '機器池',
            description: '一台機器離線時切換到下一台。',
        },
        transfer: {
            title: '機器間傳輸',
            description: '在機器之間傳輸資料。',
            directPeer: {
                title: '直接傳輸',
                description: '在機器之間直接傳輸資料。',
            },
            serverRouted: {
                title: '經由這個 Home 傳輸',
                description: '機器無法直接連線時，經由這個 Home 傳輸資料。',
            },
        },
        peerMediation: {
            title: '機器間連線',
            description: '機器之間的通道、串流和存取。',
            observability: {
                title: '連線診斷',
                description: '顯示機器之間的通道、串流和預覽如何連線。',
            },
        },
        tunnel: {
            title: '機器通道',
            description: '在機器之間開放連接埠。',
            directPeer: {
                title: '直接通道',
                description: '在機器之間直接開放連接埠。',
            },
            serverRouted: {
                title: '經由這個 Home 的通道',
                description: '機器無法直接連線時，經由這個 Home 開放連接埠。',
            },
        },
        liveStream: {
            title: '直播',
            description: '串流機器的畫面。',
            directPeer: {
                title: '直接直播',
                description: '將機器的畫面直接串流到你的裝置。',
            },
            serverRouted: {
                title: '經由這個 Home 的直播',
                description: '直接串流失敗時，經由這個 Home 串流機器的畫面。',
            },
        },
        rpc: {
            title: '機器呼叫',
            description: '直接連線到機器。',
            directPeer: {
                title: '直接呼叫機器',
                description: '直接連線到機器，而不經由這個 Home。',
            },
        },
    },
    localServices: {
        title: '本機服務',
        description: '查看並開啟機器上執行的服務。',
        group: '本機服務',
        inventory: {
            title: '服務清單',
            description: '列出每台機器上執行的連接埠和服務。',
        },
        managed: {
            title: '受管服務',
            description: '在 Happier 中啟動、命名和監控服務。',
        },
        launcher: {
            title: '服務啟動器',
            description: '推薦可開啟和預覽的服務。',
        },
        actions: {
            title: '服務操作',
            description: '複製、預覽和移除服務。',
            terminate: {
                title: '停止服務',
                description: '停止偵測到的服務程序。',
            },
        },
        preview: {
            title: '服務預覽',
            description: '在工作階段中私密預覽本機服務。',
        },
        publicPreview: {
            title: '公開預覽',
            description: '透過公開位址分享服務預覽。',
        },
    },
    browser: {
        title: '瀏覽器',
        description: '在 Happier 中開啟頁面、預覽和託管檢視。',
        group: '瀏覽器',
        viewTargets: {
            title: '瀏覽器檢視',
            description: '在合適的檢視中開啟預覽、外掛頁面和連結。',
        },
        internal: {
            title: '內建瀏覽器',
            description: '在 Happier 中以獨立的工作階段和設定檔瀏覽。',
        },
        sidecar: {
            title: '輔助瀏覽器',
            description: '用於大量自動化的獨立受管瀏覽器。',
        },
        diagnostics: {
            title: '瀏覽器開發人員工具',
            description: '內建瀏覽器的主控台、網路和 devtools 事件。',
        },
        context: {
            title: '瀏覽器內容',
            description: '將頁面內容附加到訊息或代理。',
        },
        automation: {
            title: '瀏覽器自動化',
            description: '代理在內建瀏覽器中點按、輸入和瀏覽。',
        },
        recording: {
            title: '瀏覽器錄製',
            description: '將瀏覽器工作階段錄製為證據。',
        },
    },
    plugins: {
        title: 'Happier 以外的外掛',
        description: '從 npm 和你自己的來源安裝外掛。',
        group: '外掛',
        webhooks: {
            title: '外掛 Webhook',
            description: '外掛接收外部服務的 Webhook。',
        },
        ui: {
            title: '外掛畫面',
            description: '顯示外掛提供的畫面和面板。',
            hostedWeb: {
                title: 'Web 外掛畫面',
                description: '顯示為 Web 打造的外掛畫面。',
            },
            reactNativeBundles: {
                title: '原生外掛畫面',
                description: '執行以 React Native 打造的受信任外掛畫面。',
            },
        },
    },
    devices: {
        title: '裝置',
        description: '模擬器和已連接的裝置。',
        simulatorPreview: {
            title: '模擬器預覽',
            description: '顯示你機器上的模擬器。',
        },
    },
    social: {
        friends: {
            title: '好友',
            description: '新增好友並查看他們分享的內容。',
        },
    },
    auth: {
        group: '登入',
        recovery: {
            providerReset: {
                title: '透過供應商重設',
                description: '透過帳號的身分識別供應商登入來復原帳號。',
            },
        },
        login: {
            keyChallenge: {
                title: '金鑰登入',
                description: '透過證明裝置的金鑰登入。',
            },
        },
        mtls: {
            title: '用戶端憑證',
            description: '使用用戶端憑證 (mTLS) 登入。',
        },
        ui: {
            recoveryKeyReminder: {
                title: '復原金鑰提醒',
                description: '提醒成員儲存復原金鑰。',
            },
        },
        pairing: {
            desktopQrMobileScan: {
                title: '掃描登入',
                description: '在手機上掃描電腦上的代碼來登入。',
            },
            boundQrV2: {
                title: '更安全的配對碼',
                description: '只對這個 Home 和這個方向有效的配對碼。',
            },
        },
    },
    encryption: {
        group: '加密',
        plaintextStorage: {
            title: '不加密儲存',
            description: '不使用端對端加密儲存工作階段。',
        },
        accountOptOut: {
            title: '關閉加密',
            description: '每個人都可以關閉端對端加密。',
        },
    },
    remoteHosts: {
        group: '遠端主機',
        management: {
            title: '遠端主機',
            description: '儲存用來執行工作階段的 SSH 主機。',
        },
        secretMaterial: {
            title: '已儲存的主機密鑰',
            description: '儲存 SSH 主機的密碼和金鑰。',
        },
    },
    e2ee: {
        keylessAccounts: {
            title: '無金鑰帳號',
            description: '沒有端對端加密金鑰的帳號。',
        },
    },
    bugReports: {
        title: '錯誤回報',
        description: '傳送附帶診斷資訊的錯誤回報。',
    },
    terminal: {
        group: '終端機',
        embeddedPty: {
            title: '終端機',
            description: '在 Happier 中開啟機器上的終端機。',
        },
        transport: {
            byteStream: {
                title: '串流終端機',
                description: '為內建終端機提供更快的連線。',
            },
        },
    },
    search: {
        title: '搜尋',
        description: '搜尋工作階段和逐字稿。',
    },
    providers: {
        title: '模型供應商',
        description: '連結模型供應商並為代理選擇模型。',
        group: '模型供應商',
        localDiscovery: {
            title: '尋找本機供應商',
            description: '尋找機器上執行的模型伺服器。',
        },
        localModelManagement: {
            title: '本機模型管理',
            description: '下載並管理本機模型。',
        },
    },
    keys: {
        HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: {
            title: '回報服務位址',
            description: '錯誤回報的傳送位置。留空則不提供回報服務。',
        },
        HAPPIER_FEATURE_BUG_REPORTS__DEFAULT_INCLUDE_DIAGNOSTICS: {
            title: '預設包含診斷資訊',
            description: '除非回報者選擇不包含，回報表單會附上診斷資訊。',
        },
        HAPPIER_FEATURE_BUG_REPORTS__MAX_ARTIFACT_BYTES: {
            title: '附件大小上限',
            description: '錯誤回報可附加的最大檔案，以位元組為單位。',
        },
        HAPPIER_FEATURE_BUG_REPORTS__UPLOAD_TIMEOUT_MS: {
            title: '上傳時限',
            description: '錯誤回報上傳可用的時間，以毫秒為單位。',
        },
        HAPPIER_FEATURE_BUG_REPORTS__ACCEPTED_ARTIFACT_KINDS: {
            title: '接受的附件類型',
            description: '錯誤回報接受的附件類型。留空則接受常用類型。',
        },
        HAPPIER_FEATURE_BUG_REPORTS__CONTEXT_WINDOW_MS: {
            title: '內容時間範圍',
            description: '錯誤回報往前收集內容的時間長度，以毫秒為單位。',
        },
        HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: {
            title: '語音需要訂閱',
            description: '只有訂閱者可以使用語音。未設定時，正式環境需要訂閱，其他環境則不需要。',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_MANIFEST_BYTES: {
            title: '寵物資訊清單大小上限',
            description: '接受的寵物資訊清單最大大小，以位元組為單位。',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_SPRITESHEET_BYTES: {
            title: '寵物圖像表大小上限',
            description: '接受的寵物圖像表最大大小，以位元組為單位。',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_PACKAGE_BYTES: {
            title: '寵物套件大小上限',
            description: '接受的寵物套件最大大小，以位元組為單位。',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PETS_PER_ACCOUNT: {
            title: '每人匯入的寵物數',
            description: '每人最多可保留的匯入寵物數量。',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PET_BYTES_PER_ACCOUNT: {
            title: '每人匯入寵物的儲存空間',
            description: '每人最多可保留的匯入寵物位元組數。',
        },
        HAPPIER_FEATURE_PETS_SYNC__ENCRYPTED_CUSTOM_PET_SYNC_POLICY: {
            title: '加密的自訂寵物',
            description: '保留供日後使用。加密的自訂寵物尚未同步，因此保持關閉。',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES: {
            title: '經由這個 Home 的傳輸上限',
            description: '經由這個 Home 的傳輸可攜帶的最大檔案，以位元組為單位。',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_ACTIVE_TRANSFERS_PER_SOCKET: {
            title: '每個連線的同時傳輸數',
            description: '一個連線經由這個 Home 同時進行的傳輸數上限。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES: {
            title: '每個通道的資料量',
            description: '經由這個 Home 的一個通道最多可攜帶的位元組數。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_ACTIVE_TUNNELS_PER_SOCKET: {
            title: '每個連線的通道數',
            description: '一個連線經由這個 Home 同時保持開啟的通道數上限。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: '通道訊框大小上限',
            description: '經由這個 Home 的通道可攜帶的最大訊框，以位元組為單位。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__SUPPORTED_ENCODINGS: {
            title: '通道編碼',
            description: '經由這個 Home 的通道接受的訊框編碼。留空則使用標準編碼。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__PREFERRED_ENCODING: {
            title: '偏好的通道編碼',
            description: '優先使用的訊框編碼。必須是接受的編碼之一。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BINARY_HEADER_BYTES: {
            title: '訊框標頭大小上限',
            description: '二進位訊框標頭的最大大小，以位元組為單位。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_RAW_PAYLOAD_BYTES: {
            title: '訊框酬載大小上限',
            description: '單一訊框中原始酬載的最大大小，以位元組為單位。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAMED_MESSAGE_BYTES: {
            title: '分框訊息大小上限',
            description: '分框訊息的最大大小，以位元組為單位。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_CONCURRENT_SUBSTREAMS: {
            title: '每個通道的同時串流數',
            description: '一個通道同時執行的串流數上限。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_TOTAL_SUBSTREAMS: {
            title: '每個通道的串流數',
            description: '一個通道在其存續期間可開啟的串流數上限。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES_PER_SUBSTREAM: {
            title: '每個串流的資料量',
            description: '一個串流最多可攜帶的位元組數。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_AGGREGATE_BYTES: {
            title: '每個通道所有串流的資料量',
            description: '一個通道的所有串流合計最多可攜帶的位元組數。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SUBSTREAM_IDLE_MS: {
            title: '閒置串流時限',
            description: '串流在關閉前可保持閒置的時間，以毫秒為單位。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SESSION_IDLE_MS: {
            title: '閒置通道時限',
            description: '經由這個 Home 的通道在關閉前可保持閒置的時間，以毫秒為單位。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_IDLE_MS: {
            title: '通道閒置時限',
            description: '通道在關閉前可保持閒置的時間，以毫秒為單位。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_DURATION_MS: {
            title: '通道最長時間',
            description: '通道保持開啟的最長時間，以毫秒為單位。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: {
            title: '通道可連線的連接埠',
            description: '通道可開放的連接埠。留空則只允許預設連接埠。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__TOKEN_TTL_MS: {
            title: '預覽連結有效期',
            description: '私密預覽連結的有效時間，以毫秒為單位。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: {
            title: '預覽網域',
            description: '為每個預覽提供獨立位址的網域。留空則在這個 Home 的位址下提供預覽。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: {
            title: '公開預覽模式',
            description: '預覽可以公開的方式。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: {
            title: '公開預覽最長時間',
            description: '預覽保持公開的最長時間，以毫秒為單位。留空則使用標準上限。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_CONCURRENT_EXPOSURES: {
            title: '同時公開的預覽數',
            description: '同時公開的預覽數上限。留空則使用標準上限。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: {
            title: '要求 DNS 和 TLS',
            description: '公開預覽需要 DNS 和 TLS。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_SINK: {
            title: '公開預覽稽核記錄',
            description: '公開預覽的記錄位置。公開預覽必須設定此項。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_LOG_PATH: {
            title: '稽核記錄檔',
            description: '公開預覽稽核記錄寫入的檔案。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: {
            title: '允許測試稽核記錄',
            description: '僅供開發使用：接受記憶體中的測試稽核記錄。正式環境中會忽略。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: {
            title: '公開預覽速率限制',
            description: '公開預覽可使用的速率限制設定檔。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER: {
            title: '速率限制檢查器',
            description: '公開預覽要求的速率限制方式。公開預覽必須設定此項。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS: {
            title: '每個時間窗的要求數',
            description: '公開預覽在每個時間窗內允許的要求數。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS: {
            title: '速率限制時間窗',
            description: '每個速率限制時間窗的長度，以毫秒為單位。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: {
            title: '允許測試速率限制器',
            description: '僅供開發使用：接受記憶體中的測試速率限制器。正式環境中會忽略。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_REQUESTS: {
            title: '處理中的 Webhook',
            description: '此伺服器同時處理的 Webhook 要求數上限。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_WORKING_BYTES: {
            title: 'Webhook 記憶體',
            description: '處理中的 Webhook 要求最多可使用的記憶體，以位元組為單位。留空則依要求數上限所允許的量。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_RATE_PER_MINUTE: {
            title: '每個路由每分鐘的 Webhook 數',
            description: '一個路由上每分鐘的 Webhook 要求數。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_CONCURRENCY: {
            title: '每個路由的同時 Webhook 數',
            description: '一個路由上處理中的 Webhook 要求數。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_RATE_PER_MINUTE: {
            title: '每個端點每分鐘的 Webhook 數',
            description: '一個端點上每分鐘的 Webhook 要求數。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_CONCURRENCY: {
            title: '每個端點的同時 Webhook 數',
            description: '一個端點上處理中的 Webhook 要求數。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_RATE_PER_MINUTE: {
            title: '每人每分鐘的 Webhook 數',
            description: '每人每分鐘的 Webhook 要求數。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_CONCURRENCY: {
            title: '每人的同時 Webhook 數',
            description: '每人處理中的 Webhook 要求數。',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES: {
            title: '外掛畫面套件大小上限',
            description: '這個 Home 託管的外掛畫面套件最大大小，以位元組為單位。',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES: {
            title: '每人的外掛畫面儲存空間',
            description: '每人最多可儲存的外掛畫面套件位元組數。',
        },
        HAPPIER_COLLECTION_MAX_ROW_ENCODED_BYTES: {
            title: '外掛資料列大小上限',
            description: '外掛儲存的單一資料列最大大小，以位元組為單位。',
        },
        HAPPIER_COLLECTION_MAX_BATCH_BYTES: {
            title: '外掛資料批次大小上限',
            description: '一批外掛資料變更的最大大小，以位元組為單位。',
        },
        HAPPIER_COLLECTION_MAX_BATCH_ROWS: {
            title: '每批外掛資料的列數',
            description: '一批外掛資料變更中的列數上限。',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: {
            title: '每人的外掛資料列數',
            description: '每人最多可儲存的外掛資料列數。',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_BYTES: {
            title: '每人的外掛資料儲存空間',
            description: '每人最多可儲存的外掛資料位元組數。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_BITRATE_BPS: {
            title: '直播最高位元率',
            description: '經由這個 Home 的直播最高位元率，以位元/秒為單位。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAMES_PER_SECOND: {
            title: '直播最高影格速率',
            description: '經由這個 Home 的直播最高影格速率。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: '直播影格大小上限',
            description: '經由這個 Home 的直播最大影格，以位元組為單位。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_DURATION_MS: {
            title: '直播最長時間',
            description: '經由這個 Home 的直播可持續的最長時間，以毫秒為單位。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_TOTAL_BYTES: {
            title: '每場直播的資料量',
            description: '經由這個 Home 的一場直播最多可攜帶的位元組數。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_ACCOUNT: {
            title: '每人的同時直播數',
            description: '每人經由這個 Home 同時進行的直播數上限。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_SOCKET: {
            title: '每個連線的同時直播數',
            description: '一個連線經由這個 Home 同時進行的直播數上限。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_MACHINE: {
            title: '每台機器的同時直播數',
            description: '一台機器經由這個 Home 同時進行的直播數上限。',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: {
            title: '連線簽署金鑰 ID',
            description: '指定為機器之間的連線簽署的金鑰。沒有簽署金鑰時，這些連線會關閉。',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: {
            title: '連線簽署私密金鑰',
            description: '為機器之間的連線簽署的私密金鑰。',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: {
            title: '連線簽署公開金鑰',
            description: '與簽署金鑰相符的公開金鑰。留空時從私密金鑰推導。',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: {
            title: '簽署金鑰到期時間',
            description: '簽署金鑰的到期時間，以毫秒時間戳記表示。',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: {
            title: '依使用者名稱尋找好友',
            description: '除了透過連結的帳號，也可以依使用者名稱尋找好友。',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__IDENTITY_PROVIDER: {
            title: '好友比對供應商',
            description: '用於比對好友的登入供應商。',
        },
    },
};

const homeFeatureTranslations = { zhHant } as const;

return { homeFeatureTranslations };
})();

const Domain_homeGovernanceTranslations = (() => {
const en = Shared_homeGovernanceTranslations.en;

const zhHant: typeof en = {
    title: 'Home 管理',
    pages: {
        features: '這個 Home 提供的功能。變更會在下次重新整理時在所有地方生效。',
        data: '這個 Home 保留哪些資料，以及保留多久。',
        homes: '你管理的每個 Home 的帳號、角色、團隊與登入規則。',
        overview: '誰在管理此 Home，以及你可以在此變更什麼。',
        people: '此 Home 上的帳號、其角色以及能否登入。',
        policies: '誰可以登入、帳號如何建立以及資料如何受保護。',
        teams: '此 Home 上的所有團隊。管理團隊並不會讓你存取其工作階段。',
        identityProvider: '可用於登入此 Home 的身分識別服務。',
        identityProviderEditor: '此身分識別服務的連線方式以及它接納哪些人。',
        githubApp: '此 Home 用於存取儲存庫的 GitHub App。',
        githubAppEditor: '為此 Home 註冊或變更 GitHub App。',
        email: '這個 Home 如何傳送郵件。',
        reach: '裝置、邀請連結與郵件如何找到這個 Home。',
        runtime: '執行這個 Home 的伺服器。',
        activity: '誰在這個 Home 上變更了什麼，以及何時變更。',
    },
    overview: '總覽',
    people: '成員',
    teams: '團隊',
    policies: '政策',
    console: {
        serverSettings: '伺服器設定',
        serverSettingsDescription: '伺服器讀取的每項設定，以及變更何時生效。',
        allHomes: '所有 Home',
        backToHomes: '返回 Home 列表',
        viewerOwner: '你是擁有者',
        viewerAdmin: '你是管理員',
        noOwnerYet: '尚無擁有者',
        administer: '管理',
        navigation: 'Home 管理頁面',
    },
    /** The console Overview (lab `hcOverview-A`): what needs the owner, who owns the Home, and its facts. */
    overviewPage: {
        description: '誰在運行這個 Home，以及需要你處理的事項。',
        attention: '需要你處理',
        emailNotSetUpTitle: '尚未設定郵件',
        emailNotSetUpBody: '大家無法驗證地址、重設密碼，也收不到郵件邀請。',
        emailNoLinkTitle: '郵件暫時無法包含連結',
        emailNoLinkBody: '郵件寄送已設定，但這個 Home 沒有用於連結的網頁應用程式地址。',
        emailPasswordTitle: '無法讀取郵件密碼',
        emailPasswordBody: '請重新輸入 SMTP 密碼，讓這個 Home 能寄送郵件。',
        setUpEmail: '設定郵件',
        openEmail: '開啟郵件',
        noAddressTitle: '沒有公開地址',
        noAddressBody: '其他網路上的裝置和邀請連結無法連到這個 Home。',
        setUpReach: '設定',
        githubPartlySetUp: 'GitHub 登入尚未設定完成',
        workosPartlySetUp: 'WorkOS 尚未設定完成',
        workosNeedsClientIdBody: '團隊連線公司登入前，需要先填寫用戶端 ID。',
        workosNeedsApiKeyBody: '團隊連線公司登入前，需要先填寫 API 金鑰。',
        githubNeedsClientIdBody: '使用 GitHub 登入前，需要先填寫用戶端 ID。',
        githubNeedsClientSecretBody: '使用 GitHub 登入前，需要先填寫用戶端密鑰。',
        finish: '完成設定',
        nameDescription: '顯示在應用程式與邀請中。',
        review: '查看',
        settingsFailed: '無法檢查這個 Home 的設定',
        emailFailed: '無法讀取這個 Home 的郵件狀態',
        reachFailed: '無法讀取這個 Home 的連線方式',
        ownership: '擁有者',
        ownerYou: '擁有者 · 你',
        peopleFailed: '無法讀取這個 Home 的成員',
        thisHome: '這個 Home',
        version: '版本',
        signIn: '登入',
        signInOpen: '任何人都可以建立帳戶',
        signInInvited: '僅限邀請',
        signInNone: '沒有啟用任何登入方式',
        /** People · owners · admins; `more` while the Home has further pages, `admins` null when unknown. */
        peopleSummary: ({ people, more, owners, admins }: { people: number; more: boolean; owners: number; admins: number | null }) => [`${people}${more ? '+' : ''} 人`, `${owners} 位擁有者`, admins === null ? null : `${admins} 位管理員`].filter((part) => part !== null).join(' · '),
    },
    /** "Invite people" on Overview, People and Teams: one dialog over the Team invitation form. */
    invite: {
        action: '邀請成員',
        description: '加入某個團隊即可加入這個 Home。',
        team: '團隊',
        noTeams: '還沒有你可以邀請加入的團隊',
        noTeamsBody: '成員透過團隊加入 Home。請先建立一個團隊。',
        notAdministered: '你無法邀請成員加入這個 Home 的團隊',
        notAdministeredBody: '每個團隊由其擁有者和管理員邀請成員。請聯絡他們，或建立你自己的團隊。',
        createTeam: '建立團隊',
        notAdministeredAskBody: '每個團隊由其擁有者和管理員邀請成員，請聯絡他們。',
        joinByTeam: '成員透過團隊加入 Home。',
        teamsFailed: '無法讀取這個 Home 的團隊',
    },

    yourRole: '你的角色',
    roleOwner: '擁有者',
    roleAdmin: '管理員',
    roleMember: '成員',
    activeOwners: '有效的擁有者',
    accountSection: '帳號',
    accountAccessSection: '存取',
    homeAddress: 'Home 位址',

    setupRequiredTitle: '需要設定 Home 管理',
    setupRequiredBody: '這個 Home 還沒有有效的擁有者。具備伺服器存取權的人會在執行它的機器上指派第一位擁有者。',

    manageTeams: '管理團隊',
    manageTeamsSubtitle: '管理這個 Home 的團隊。這不會讓你存取它們的工作階段。',
    teamsDisabled: '這個 Home 未啟用團隊。',
    teamsEmpty: '這個 Home 還沒有團隊。',

    loading: '正在載入這個 Home…',
    refreshing: '正在重新整理…',
    updating: '正在更新…',
    staleNotice: '顯示這個 Home 最後已知的狀態。在它再次回應前無法變更。',
    offlineNotice: '這個 Home 沒有回應。你可以繼續閱讀，但無法變更。',
    unavailableTitle: '這個 Home 無法使用',
    unavailableBody: 'Happier 無法讀取這個 Home 的管理狀態。',
    forbiddenTitle: '你無法管理這個 Home',
    forbiddenBody: '你的帳戶在此沒有 Home 管理權限。',
    retry: '重試',
    loadMore: '載入更多',
    unsupportedBody: '這個 Home 不提供管理功能。它可能執行較舊的版本。',
    notObservedTitle: '尚未載入',
    notObservedBody: '這個 Home 尚未向這台裝置回報其管理狀態。',
    lastUpdated: ({ time }: { time: string }) => `最後更新於 ${time}`,

    chooseHome: '選擇一個 Home',
    chooseHomeFooter: '每個 Home 都有各自的帳號、角色與政策。',
    homesEmpty: '還沒有 Home',
    homesEmptyBody: '將 Home 加入這台裝置後即可在這裡管理。',
    homesNoneAdministrable: '沒有可管理的 Home',
    homesNoneAdministrableBody: '目前顯示的 Home 都沒有授予這個帳號管理權限。',
    homeNotAnswering: ({ home }: { home: string }) => `${home} 沒有回應`,
    signedOutTitle: '已登出這個 Home',
    signedOutBody: '重新登入這個 Home 即可進行管理。',
    credentialUnreadableTitle: '無法讀取此裝置上儲存的登入資訊',
    credentialUnreadableBody: '問題出在此裝置上，而不是 Home，你並未登出。請再試一次。',
    credentialUnreadableInviteBody: '問題出在此裝置上，而不是 Home。你的邀請連結仍然有效，可以現在再試一次，也可以稍後再回來。',

    peopleEmpty: '這個 Home 還沒有帳戶。',
    rosterUnavailableTitle: '成員清單尚未提供',
    rosterUnavailableBody: '這個 Home 尚未向 Happier 提供帳戶清單。提供後，角色與狀態會顯示在這裡。',
    accountUnavailableBody: '這個帳戶尚無法從該 Home 取得。',
    searchPlaceholder: '搜尋帳戶',
    searchResults: '搜尋結果',
    searchResultsFooter: '開啟帳戶即可查看其角色與狀態。',
    searchEmpty: '沒有符合這個搜尋的帳戶。',
    searchUnsupported: '這個 Home 不支援搜尋',
    searchUnsupportedBody: '這個 Home 未提供帳戶搜尋，可能執行的是較舊的版本。',
    searchFailed: '搜尋未能完成',
    searchFailedBody: '這個 Home 未回應搜尋。修改文字後可再試一次。',

    statusActive: '有效',
    statusDisabled: '已停用',
    statusRetired: '已註銷',
    statusDisabledDetail: '已在所有裝置登出。可重新啟用。',
    statusRetiredDetail: '存取權已永久撤銷。',

    changeRole: '變更角色',
    disable: '停用帳戶',
    enable: '重新啟用帳戶',
    deleteAccount: '刪除帳戶與資料…',
    retryDeletion: '重試刪除',

    reasonLastActiveOwner: '這個 Home 至少需要一位有效的擁有者。請先讓另一個帳戶成為擁有者。',
    reasonTargetInactive: '只有有效的帳戶才能擁有 Home 角色。',
    reasonHomeUnreachable: '這個 Home 沒有回應。重新連線後才能變更。',

    roleSheetTitle: 'Home 角色',
    roleOwnerDescription: '可以管理這個 Home 的一切，包括刪除帳戶。',
    roleAdminDescription: '可以管理帳戶與團隊，但不能變更擁有者。',
    roleMemberDescription: '沒有 Home 管理權限。',

    disableTitle: ({ account }: { account: string }) => `要停用 ${account} 嗎？`,
    disableBody: '該成員會在所有裝置登出，其機器也會中斷連線。個人存取權杖將永久撤銷，工作階段負責人身分會被清除；在其失去存取權的每個工作階段中，未傳送的草稿會被捨棄，追蹤也會移除。重新啟用會恢復存取權，但不會恢復這些草稿、追蹤或負責人身分。團隊成員資格與加密金鑰會保留。',
    disableConfirm: '停用',
    enableTitle: ({ account }: { account: string }) => `要重新啟用 ${account} 嗎？`,
    enableBody: '該成員可以在自己的裝置重新登入。先前撤銷的存取權杖仍然無效。',
    enableConfirm: '重新啟用',
    deleteTitle: ({ account }: { account: string }) => `要刪除 ${account} 與其所有資料嗎？`,
    deleteBody: ({ home }: { home: string }) => `這會永久刪除 ${home} 上的該帳戶與其資料，且無法復原。Home 或團隊的擁有權必須先行轉移。`,
    deleteConfirm: '刪除',

    deleteIncompleteTitle: '刪除未完成',
    deleteIncompleteBody: '存取權已撤銷，這個帳戶現在已註銷，但清理未完成。請重試刪除以完成。',
    deleteIncompleteMemberBody: '存取權已撤銷，但清理未完成。Home 擁有者或伺服器維運人員可以完成它。',

    errorForbidden: '你在這個 Home 上已不再具備進行此變更的權限。',
    errorOwnerTransferRequired: '這個 Home 至少需要一位有效的擁有者。請先讓另一個帳戶成為擁有者。',
    errorTeamOwnerTransferRequired: '某個團隊仍需要這個帳戶作為擁有者。請先為該團隊指派另一位擁有者。',
    errorAccountNotFound: '這個帳戶已不在該 Home 中。',
    errorAccountInactive: '這個帳戶並非有效狀態，因此無法取得該權限。',
    errorErasureTransitionCleanupPending: '帳戶刪除正在等待加密資料清理完成。請再次嘗試刪除帳戶。',
    errorGeneric: '這個 Home 無法完成變更。未做任何變更。',
    errorConflict: '這裡已先被其他變更修改。請重新載入這個 Home 後再試一次。',
    changeFailedTitle: '變更未完成',
    errorOutcomeUnknownTitle: '這個變更未確認',
    errorOutcomeUnknown: '請求已送達這個 Home，但回應遺失。變更可能已生效。請先重新載入這個 Home 確認後再重試。',

    teamCreation: '團隊建立',
    teamCreationSelfService: '任何人都可以建立團隊',
    teamCreationSelfServiceDescription: '這個 Home 的有效成員可以建立團隊並成為其擁有者。',
    teamCreationManagedOnly: '由管理員建立團隊',
    teamCreationManagedOnlyDescription: '擁有者與管理員建立團隊並選擇初始擁有者。',
    teamCreationDisabled: '停用團隊建立',
    teamCreationDisabledDescription: '不再建立新團隊。現有團隊維持不變。',
    teamCreationWho: '誰可以建立團隊',
    teamCreationAnyone: '任何人',
    teamCreationAdmins: '管理員',
    teamCreationNobody: '無人',
    teamsVisibility: '誰能看到團隊',
    teamsVisibleToMembers: '向成員顯示團隊',
    teamsVisibleToMembersDescription: '關閉後，只有團隊成員和管理員能看到團隊。',
    teamJit: '登入時自動加入團隊',
    teamJitDescription: '透過團隊連結的身分提供者登入後，將自動加入該團隊，無需邀請或核准。',
    githubEnterpriseOrigins: '已核准的 GitHub Enterprise 主機',
    githubEnterpriseOriginsDescription: '每行輸入一個規範 HTTPS 來源。團隊只能將 GitHub App 連線到這些主機。',
    githubEnterpriseOriginsInvalid: '請輸入不含路徑、查詢、憑證或片段的唯一 HTTPS 來源。',

    signInTitle: '登入與加入',
    authActionLogin: '登入',
    authActionProvision: '新帳戶',
    authActionConnect: '帳戶連結',
    authReasonMethodNotEnabled: '登入方式已停用',
    authReasonProvisioningNotEnabled: '帳戶建立已停用',
    authReasonAccountModeUnavailable: '帳戶類型無法使用',
    authReasonEmailDeliveryUnavailable: '郵件傳送無法使用',
    authInherited: '使用伺服器預設值',
    authInheritedDescription: '這個 Home 未限制登入方式或帳戶類型。',
    authNarrowed: '由這個 Home 限制',
    authUnreadable: '設定需要處理',
    authUnreadableDescription: '這個 Home 儲存了此伺服器版本無法讀取的登入設定。在維運人員修復之前，登入無法使用。',
    signInMethods: '登入方式',
    accountModes: '帳戶類型',
    accountModePlain: '一般',
    accountModeE2ee: '端對端加密',
    recommendedMode: '新帳戶建議',
    recommendedModeDescription: '設定新帳戶的預設值。現有帳戶不會變更。',
    admissionSelfService: '任何人',
    admissionInvitationOnly: '僅限邀請',
    admissionClosed: '無人',

    deploymentServices: '部署服務',
    deploymentServicesDescription: '由維運者為此伺服器設定的身分服務。無法在 Home 管理中變更。',
    privateEndpoints: '私有身分端點',
    privateEndpointsDescription: '允許受管登入連到私有網路中的身分提供者。只有這裡列出的主機、網段與連接埠可連。',
    privateEndpointsPublicOnly: '僅公開端點',
    privateEndpointsAllowlist: '私有允許清單',
    privateEndpointsHostnames: '允許的主機名稱',
    privateEndpointsCidrs: '允許的網段 (CIDR)',
    privateEndpointsPorts: '允許的連接埠',
    privateEndpointsSave: '儲存網路政策',
    privateEndpointsInvalid: '請至少填寫一個主機名稱或網段，以及 1 到 65535 之間的連接埠。',
    privateEndpointsUnreadable: '此 Home 儲存了這個伺服器版本無法讀取的網路政策。受管登入仍只使用公開端點。',

    policyReadOnly: '只有 Home 擁有者可以變更。',
    policyEditingUnavailable: '尚無法從這台裝置變更政策。',
    revisionConflictTitle: '這個政策已在別處變更',
    revisionConflictBody: '你編輯時有其他人儲存了變更。你的選擇已保留——請重新載入這個 Home 後再次套用。',
    reload: '重新載入',
    person: {
        you: '你',
        roleDescription: '成員使用 Home;管理員還可以管理人員與 Team。',
        roleChangeTitle: ({ account, role }: { account: string; role: string }) => `要將 ${account} 設為${role}嗎?`,
        roleChangeBody: '其對此 Home 的存取權限會立即變更。此操作會以你的名義記錄在活動中。',
        roleChangeConfirm: '變更角色',
        signIn: '登入',
        signInDescription: '此人可用來登入的方式。由其在自己的帳戶中管理。',
        methods: '方式',
        linkedProviders: '已連結的提供者',
        none: '無',
        teams: 'Team',
        noTeams: '不在任何 Team 中',
        teamArchived: '已封存的 Team',
        teamSuspended: '已暫停',
        access: '存取',
        accessDescription: '已在其裝置上登入 — 不會個別追蹤工作階段。',
        machines: '機器',
        apiTokens: 'API 權杖',
        apiTokensLastUsed: ({ time }: { time: string }) => `上次使用:${time}`,
        apiTokensNeverUsed: '從未使用',
        signOutEverywhere: '在所有裝置上登出',
        signOutEverywhereDescription: '結束其所有裝置上的登入工作階段。在帳戶停用之前,API 權杖仍可使用。',
        signOutEverywhereTitle: ({ account }: { account: string }) => `要讓 ${account} 在所有裝置上登出嗎?`,
        signOutEverywhereBody: '其已登入的每台裝置都需要重新登入。在你停用該帳戶之前,其 API 權杖仍可使用。此操作會以你的名義記錄在活動中。',
        signOutEverywhereDone: '已在所有裝置上登出',
        recentActivity: '最近活動',
        noRecentActivity: '尚無與此人相關的管理變更。',
        showAllActivity: '查看全部',
        disableOrDelete: '停用或刪除',
        dangerFootnote: '停用會讓其登出並停止其 API 權杖,可以復原。刪除會從此 Home 永久移除其帳戶與資料。',
    },
    email: {
        title: '郵件',
        status: '狀態',
        sendingMail: '傳送郵件',
        sendingReady: ({ host }: { host: string }) => `就緒 · 透過 ${host} 傳送`,
        sendingNotSetUp: '未設定',
        links: '郵件中的連結',
        linksReady: '在這個 Home 的網頁應用程式中開啟',
        linksOpenAt: ({ host }: { host: string }) => `在 ${host} 開啟`,
        setInReach: '在存取方式中設定',
        linksMissing: '沒有網頁應用程式位址，因此無法產生連結',
        mailServer: '郵件伺服器',
        mailServerDescription: '傳送驗證、密碼重設和邀請郵件的 SMTP 伺服器。',
        server: '伺服器',
        port: '連接埠',
        portAndSecurity: '連接埠和安全性',
        security: '連線安全性',
        tls: 'TLS',
        starttls: 'STARTTLS',
        username: '使用者名稱',
        password: '密碼',
        passwordDescription: '加密儲存在伺服器上，之後不會再顯示。',
        saved: '已儲存',
        replace: '取代',
        clear: '清除',
        keep: '保留',
        clearPending: '儲存後將移除已儲存的密碼。',
        valueSet: '已設定',
        valueNotSet: '未設定',
        sender: '寄件者',
        fromAddress: '寄件地址',
        fromName: '寄件者名稱',
        test: '傳送測試郵件',
        testDescription: '傳送一則不含連結的簡短訊息。',
        testTo: '收件者',
        testToPlaceholder: '任何你能查看的信箱',
        testSend: '傳送',
        testSaveFirst: '傳送測試前請先儲存變更。',
        testSent: ({ to }: { to: string }) => `已傳送到 ${to}`,
        testSentDetail: '請查看收件匣；如果沒有，也請查看垃圾郵件資料夾。',
        testFailed: '無法傳送',
        testNotConfigured: '郵件尚未設定。',
        testPasswordUnreadable: '無法讀取已儲存的密碼，請重新輸入。',
        testRenderFailed: '無法準備測試訊息。',
        testTransportFailed: '無法連線到郵件伺服器，或伺服器拒絕了該訊息。',
        adminTitle: '只有擁有者可以變更郵件設定',
        adminBody: '你能看到這些設定，是因為你是這個 Home 的管理員。',
        notSetUpTitle: '郵件未設定',
        notSetUpBody: '在設定完成前，密碼重設、郵件驗證和郵件邀請均處於關閉狀態。',
        unreadableTitle: '無法讀取已儲存的密碼',
        unreadableBody: '儲存後伺服器的主密鑰已變更，請重新輸入密碼。',
        invalidValue: '請輸入有效的值。',
        invalidPort: '請使用 1 到 65535 之間的連接埠。',
        invalidEmail: '請輸入電子郵件地址。',
        conflictTitle: '郵件設定已在別處變更',
        conflictBody: '你編輯期間有人儲存了變更。你的修改已保留：請檢查後再次儲存。',
        loadFailed: '這個 Home 沒有傳回郵件設定。',
    },
    signInProviders: {
        title: '登入提供者',
        description: '使用者如何登入此 Home，以及其團隊可以連接什麼。',
        ownersOnlyTitle: '只有擁有者可以變更登入提供者',
        ownersOnlyBody: '請此 Home 的擁有者新增或變更身分提供者與 GitHub App。',
        fromDeploymentReadOnly: '來自你的部署 · 唯讀',
        platformsDescriptionReadOnly: ({ home }: { home: string }) => `${home} 用於登入的應用程式。只有 ${home} 的擁有者可以變更。`,
        fieldClientId: '用戶端 ID',
        fieldClientSecret: '用戶端密鑰',
        fieldApiKey: 'API 金鑰',
        workosClientIdHint: '在 WorkOS 的「API 金鑰」中。',
        githubClientIdHint: '在你的 GitHub OAuth 應用程式的設定頁面中。',
        secretHintUnset: '加密儲存，之後不再顯示。',
        secretHintSet: '已加密儲存，不會顯示。',
        neededWorkos: '團隊連線前需要它',
        neededGithub: '啟用 GitHub 登入前需要它',
        secretPlaceholder: '貼上金鑰',
        lockedFootnote: '由你的部署設定的值只能在伺服器執行的位置變更。',
        ignoredBannerTitle: '上次啟動時忽略了一項登入設定',
        showMe: '查看',
        callbackAddress: '回呼位址',
        callbackAddressHint: '請在 GitHub OAuth 應用程式中登記此位址。',
        whoCanSignInGithub: '誰可以用 GitHub 登入',
        companySignIn: '公司登入',
        companySignInDescription: '成員和團隊可用於登入的 OpenID Connect 提供者。',
        addProvider: '新增提供者',
        privateEndpointsTitle: '私有端點',
        privateEndpointsPublicOnlyShort: '僅公開',
        privateEndpointsAllowlistShort: '允許清單',
        privateEndpointsPublicOnlyHint: '提供者必須位於公開位址。',
        privateEndpointsAllowlistHint: '只有下列主機可以是私有的。',
        platforms: '登入平台',
        platformsDescription: ({ home }: { home: string }) => `${home} 用於登入的應用程式：GitHub 適用於所有人，WorkOS 用於各團隊的公司登入。`,
        githubSignIn: 'GitHub 登入',
        githubPurpose: ({ home }: { home: string }) => `使用者透過 GitHub 登入 ${home} 所用的 GitHub OAuth 應用程式。在「政策」中開啟或關閉 GitHub 登入。`,
        workosPurpose: ({ home }: { home: string }) => `讓 ${home} 上的每個團隊在團隊的「身分驗證」頁面，透過 WorkOS 連接自己的公司登入與目錄。`,
        notSetGithub: '未設定 · 在此之前 GitHub 登入保持關閉',
        notSetWorkos: '未設定 · 團隊暫時無法使用 WorkOS',
        needsClientId: '需要用戶端 ID',
        needsClientSecret: '需要用戶端密鑰',
        needsApiKey: '需要 API 金鑰',
        pendingSummaryWorkos: '已儲存 · 下次重新啟動後團隊即可連線',
        pendingSummaryGithub: '已儲存 · 下次重新啟動後生效',
        lockedSummary: '由你的部署設定',
        readyPartlyLocked: ({ setting }: { setting: string }) => `就緒 · ${setting}由你的部署設定`,
        readyWorkos: '就緒 · 團隊可以透過它連接',
        readyGithubOn: '就緒 · 可以使用 GitHub 登入',
        readyGithubOff: '就緒 · 在「政策」中開啟 GitHub 登入',
        advanced: '進階',
        appliesAfterRestart: '此處的變更在伺服器重新啟動後生效。',
        privateEndpointsOffHere: '此 Home 已關閉',
        teamRules: 'Team 登入規則',
        teamRulesDescription: 'Team 可以在 Home 的提供者之上新增的內容。',
        activity: {
            addedProvider: ({ name }: { name: string }) => `新增了身分提供者 ${name}`,
            changedProvider: ({ name }: { name: string }) => `變更了身分提供者 ${name}`,
            replacedProviderSecret: ({ name }: { name: string }) => `替換了 ${name} 的用戶端密鑰`,
            enabledProvider: ({ name }: { name: string }) => `開啟了 ${name}`,
            disabledProvider: ({ name }: { name: string }) => `關閉了 ${name}`,
            removedProvider: ({ name }: { name: string }) => `移除了身分提供者 ${name}`,
            addedGitHubApp: ({ name }: { name: string }) => `新增了 GitHub App ${name}`,
            changedGitHubApp: ({ name }: { name: string }) => `變更了 GitHub App ${name}`,
            replacedGitHubAppSecrets: ({ name }: { name: string }) => `替換了 GitHub App ${name} 的密鑰`,
            verifiedGitHubApp: ({ organization, name }: { organization: string; name: string }) => `在 ${organization} 驗證了 ${name}`,
            removedGitHubAppInstallation: ({ organization, name }: { organization: string; name: string }) => `從 ${organization} 移除了 ${name}`,
        },
    },
    reach: {
        title: '存取方式',
        diagramTitle: ({ home }: { home: string }) => `新裝置如何抵達 ${home}`,
        yourDevices: '你的裝置',
        noAddress: '沒有公開位址',
        plusDirect: '+ 可行時直連 (Iroh)',
        noDirect: '無直連',
        thisComputer: '這台電腦',
        homeServer: '這個 Home 的伺服器',
        diagramDeployment: '由你的部署設定',
        diagramHere: '在此設定',
        diagramInferred: ({ method }: { method: string }) => `${method} · 推斷`,
        addresses: '位址',
        addressesDescription: '變更位址不會讓任何人登出。',
        publicAddress: '公開位址',
        webAppAddress: '網頁應用程式位址',
        accessMethod: '存取方式',
        publicAddressHome: '在此設定',
        publicAddressNone: '未設定。其他網路中的裝置無法存取這個 Home。',
        inferredFrom: ({ method }: { method: string }) => `根據託管此 Home 的電腦上的 ${method} 推斷`,
        inferredFromHost: '在託管此 Home 的電腦上推斷',
        webAppDescription: '郵件和邀請中的連結會在這裡開啟。',
        webAppServed: '連結會在這個 Home 提供的網頁應用程式中開啟。',
        webAppDefault: '連結會在 Happier 網頁應用程式中開啟。預設',
        change: '變更',
        setAddress: '設定位址',
        httpsRequired: '請使用 https:// 位址。',
        invalidAddress: '請輸入完整位址，例如 https://home.example.com。',
        conflict: '這個 Home 的設定已變更，請再試一次。',
        methodLocalOnly: '僅這台電腦',
        methodLan: '區域網路',
        methodTailscaleServe: 'Tailscale Serve',
        methodTailscaleFunnel: 'Tailscale Funnel',
        methodCloudflare: 'Cloudflare Tunnel',
        accessMethodHere: '這台電腦如何對外提供這個 Home。',
        accessMethodRemoteHost: ({ host }: { host: string }) => `在 ${host} 上設定。請在遠端主機中開啟它。`,
        accessMethodElsewhereNamed: ({ host }: { host: string }) => `在託管此 Home 的電腦（${host}）上設定。請在那裡開啟 Happier，或把它加入為遠端主機。`,
        accessMethodElsewhere: '在託管此 Home 的電腦上設定。請在那裡開啟 Happier，或把它加入為遠端主機。',
        accessMethodDeployment: '由你的部署管理。',
        directConnections: '直連',
        directConnectionsDescription: '裝置能直連時會直接連線這個 Home，否則使用公開位址。',
        directConnectionsRow: '直連（Iroh）',
        irohActive: '已啟用 · 裝置在可行時點對點連線',
        irohStarting: '正在啟動…',
        irohOff: '已關閉 · 裝置透過公開位址連線',
        irohFailed: '未在這台電腦上執行。裝置透過公開位址連線。',
        irohNotAvailable: '此部署無法使用。裝置透過公開位址連線。',
        irohNeedsAddressHint: '關閉前請先設定公開位址',
        irohOffTitle: '關閉直連？',
        irohOffBody: '裝置將只透過公開位址連線。這個 Home 目前的直連身分會被永久停用；重新開啟會建立新身分，裝置會在下次連線時取得。公開位址和所有人的登入保持不變。',
        irohOffConfirm: '關閉',
        irohNeedsAddressTitle: '請先設定公開位址',
        irohNeedsAddressBody: '沒有公開位址時，關閉直連後裝置將無法存取這個 Home。',
        relay: '直連中繼',
        relayAutomatic: '自動',
        relayOff: '關閉',
        relayCustom: ({ count }: { count: number }) => `你的中繼（${count}）· 重新啟動後生效`,
        appliesAfterRestart: '重新啟動後生效',
        appliesAfterRestartPending: '重新啟動後生效 · 待處理',
        exposureInternetTitle: ({ method }: { method: string }) => `可透過 ${method} 從網際網路存取`,
        exposureAddressTitle: '你的公開位址開放註冊',
        exposureOpenSignup: '任何存取到這個 Home 的人都能建立帳號。請在政策中檢查誰可以註冊。',
        exposureInvitationOnly: '新帳號需要邀請，陌生人無法註冊。',
        loadFailed: '無法載入這個 Home 的存取方式。',
    },
    runtime: {
        title: '執行階段',
        version: '版本',
        versionValue: ({ version }: { version: string }) => `Happier ${version}`,
        versionUnknown: '這個 Home 沒有回報版本',
        flavorLight: '輕量伺服器',
        flavorFull: '完整伺服器',
        server: '伺服器',
        restart: '重新啟動',
        restartNow: '立即重新啟動',
        restartFailed: '無法重新啟動伺服器',
        waitingForHome: '正在重新啟動，等待 Home 恢復連線。',
        restartToApply: '重新啟動伺服器以套用這些變更。',
        restartFromDeployment: '請從你的部署重新啟動以套用這些變更。',
        restartFromHost: ({ host }: { host: string }) => `請在託管此 Home 的電腦 ${host} 上重新啟動。`,
        restartFromHostingComputer: '請在託管此 Home 的電腦上重新啟動。',
        managedFrom: ({ host }: { host: string }) => `由 ${host} 管理`,
        managedFromBody: '在託管此 Home 的電腦上開啟 Happier 來更新、重新啟動或停止它。',
        managedElsewhere: '由託管此 Home 的電腦管理',
        deploymentTitle: '由你的部署管理',
        deploymentBody: '這台伺服器的更新、重新啟動和備份由部署它的人負責。',
        backups: '備份',
        backupsHere: '在執行階段頁面備份、還原或搬移這個 Home。',
        backupsFromHost: ({ host }: { host: string }) => `請在託管此 Home 的電腦 ${host} 上備份。`,
        backupsFromHostingComputer: '請在託管此 Home 的電腦上備份。',
        backupsDeployment: '備份由你的部署管理。',
        hostedHere: ({ home }: { home: string }) => `這台電腦託管著 ${home}`,
        hostedHereSubtitle: '在它的 Home 主控台中更新、重新啟動、備份和搬移。',
        pendingRestart: ({ count }: { count: number }) => (count === 1 ? '1 項變更將在重新啟動後生效' : `${count} 項變更將在重新啟動後生效`),
    },
    activity: {
        title: '活動',
        emptyTitle: '尚無活動',
        emptyBody: '登入、郵件、成員、政策和擁有權的變更發生後會顯示在這裡。',
        showOlder: '顯示較早的紀錄',
        footnote: '直接在主機電腦上透過 Happier 執行的操作（例如備份和重新啟動）不會列出。',
        loadFailed: '這個 Home 沒有傳回活動。',
        deploymentCommand: '部署指令',
        personalHomeSetup: 'Personal Home 設定',
        someone: '某人',
        removedAccount: '已刪除的帳號',
        claimed: '取得了這個 Home 的擁有權',
        madeOwner: ({ target }: { target: string }) => `將 ${target} 設為擁有者`,
        assignedOwner: '指定了第一位擁有者',
        changedPolicies: '變更了政策',
        changedEmailSetting: '更新了郵件設定',
        changedServerSetting: '變更了伺服器設定',
        changedRole: ({ target }: { target: string }) => `變更了 ${target} 的角色`,
        disabled: ({ target }: { target: string }) => `停用了 ${target}`,
        reenabled: ({ target }: { target: string }) => `重新啟用了 ${target}`,
        changedStatus: ({ target }: { target: string }) => `變更了 ${target} 的狀態`,
        deleted: ({ target }: { target: string }) => `刪除了 ${target}`,
        deletionStarted: ({ target }: { target: string }) => `開始刪除 ${target}`,
        signedOutEverywhere: ({ target }: { target: string }) => `讓 ${target} 在所有裝置上登出`,
        areaOwnership: '擁有權',
        areaPolicies: '政策',
        areaEmail: '郵件',
        areaServerSettings: '伺服器設定',
        areaPeople: '成員',
        fieldRole: '角色',
        fieldStatus: '狀態',
        fieldTeamProviders: 'Team 登入提供者',
        valueEmpty: '—',
        valueChanged: '已變更',
        valueOn: '開',
        valueOff: '關',
        secretSet: '已設定',
        secretUnset: '未設定',
    },
    signInPolicy: {
        methodsDescription: ({ home }: { home: string }) => `大家如何登入 ${home}。至少保留一種方式開啟，任何人都不會失去最後的登入途徑。`,
        methodUnavailable: '無法使用 — 你的部署無法提供',
        needsGithubApp: '需要先設定 GitHub 登入應用程式。',
        needsWorkos: '需要先設定 WorkOS。',
        setUp: '設定',
        signInService: 'Home 登入服務',
        signInServiceDescription: '透過此 Home 自己的登入服務登入。',
        admissionTitle: '誰可以建立帳戶',
        newAccounts: '新帳戶',
        admissionAnyoneDescription: '任何能連到此 Home 的人',
        admissionInvitationDescription: '僅限持有團隊邀請的人',
        admissionNobodyDescription: '任何人都無法建立帳戶',
        anonymousSignup: '匿名註冊',
        anonymousSignupDescription: '僅用復原金鑰建立帳戶，不需電子郵件。',
        encryptionTitle: '加密',
        encryptionDescription: '適用於從現在起建立的帳戶和工作階段。現有的永遠不會改變。',
        storagePolicy: '儲存原則',
        storageRequired: '必須 E2EE',
        storageOptional: '選用',
        storagePlaintext: '僅明文',
        storageRequiredDescription: '每個帳戶都維持端對端加密',
        storageOptionalDescription: '每個帳戶自行選擇是否加密',
        storagePlaintextDescription: '帳戶在沒有端對端加密的情況下儲存資料',
        storageAppliesAfterRestart: ({ running }: { running: string }) => `重新啟動後生效 · 在此之前為 ${running}`,
        allowE2ee: '端對端加密帳戶',
        allowPlain: '無端對端加密的帳戶',
        recommendedInherited: '伺服器預設',
        recommendedE2ee: 'E2EE',
        errorWideningUnconfirmed: '此變更會讓更多人進入，需要你確認。未做任何變更。',
        widening: {
            titleAnyone: '允許任何人建立帳戶？',
            titleInvited: '允許受邀者建立帳戶？',
            titleMethod: ({ method }: { method: string }) => `開啟 ${method}？`,
            titleAnonymous: '允許匿名註冊？',
            titleUnencrypted: '允許未加密儲存？',
            titleOther: '讓更多人進入？',
            exposureAnyone: ({ host }: { host: string }) => `任何能透過 ${host} 連到此 Home 的人都將無需邀請即可註冊。`,
            exposureInvited: ({ host }: { host: string }) => `任何持有邀請並能透過 ${host} 連到此 Home 的人都將可以建立帳戶。`,
            exposureMethod: ({ host, method }: { host: string; method: string }) => `任何能透過 ${host} 連到此 Home 的人都將可以用 ${method} 登入。`,
            exposureAnonymous: ({ host }: { host: string }) => `任何能透過 ${host} 連到此 Home 的人都將可以僅用復原金鑰建立帳戶。`,
            exposureUnencrypted: ({ host }: { host: string }) => `任何能透過 ${host} 連到此 Home 的人都將可以在這裡不經端對端加密地儲存資料。`,
            exposureOther: ({ host }: { host: string }) => `任何能透過 ${host} 連到此 Home 的人都將可以依放寬後的規則登入或加入。`,
            unchanged: '現有帳戶和邀請不會改變。',
            recorded: '此變更會以你的名字記錄在「活動」中。',
            confirmAnyone: '允許任何人註冊',
            confirmInvited: '允許邀請',
            confirmMethod: ({ method }: { method: string }) => `開啟 ${method}`,
            confirmAnonymous: '允許匿名註冊',
            confirmUnencrypted: '允許未加密儲存',
            confirmOther: '套用變更',
        },
    },
    claim: {
        pageDescription: '認領此 Home 的所有權。',
        emptyTitle: '此 Home 還沒有擁有者',
        emptyBody: '擁有者管理登入、郵件、連線方式和人員。在有人認領之前，沒有人能管理此 Home。',
        codeTitle: '用一次性代碼認領',
        codeDescription: '有伺服器存取權的人會印出一個代碼。它只能使用一次，15 分鐘後到期。',
        printStep: '1 · 在伺服器上印出代碼',
        pasteStep: '2 · 貼到這裡',
        codeLabel: '認領代碼',
        codePlaceholder: 'XXXX-XXXX-XXXX-XXXX-…',
        claim: '認領',
        refused: '此代碼無效。可能輸入錯誤、已使用或已到期 — 請印出新的代碼。',
        hostTitle: ({ home }: { home: string }) => `這台電腦託管著 ${home}`,
        hostBody: '你可以在這裡將你的帳戶設為擁有者。只有這台電腦能這樣做。',
        makeOwner: '讓我成為擁有者',
        hostFailed: '這台電腦無法將你設為擁有者。請再試一次。',
    },
    fixedByDeployment: ({ key }: { key: string }) => `由你的部署固定 · ${key}`,
    fixedByDeploymentLead: '由你的部署固定',
    deploymentNotSetLead: '無法使用 — 需要你的部署設定',
    features: {
        title: '功能',
        common: '常用',
        advanced: '進階',
        advancedDescription: ({ count }: { count: number }) => `另有 ${count} 項，依領域分組。`,
        other: '其他',
        familyCount_one: '1 項功能',
        familyCount_other: ({ count }: { count: number }) => `${count} 項功能`,
        offHome: '已為這個 Home 關閉。',
        notInBuild: '未包含在此版本中。',
        needs: ({ feature }: { feature: string }) => `需要 ${feature}。`,
        unavailable: '在這個 Home 上無法使用。',
        noHomeSwitchOn: '在這個 Home 上一律開啟 · 只有 Happier 版本可以關閉它',
        noHomeSwitchOff: '在這個 Home 上已關閉 · 只有 Happier 版本可以開啟它',
        unavailableByDeployment: '在這個 Home 上無法使用 · 由你的部署設定決定',
        dependentsTitle_one: ({ feature }: { feature: string }) => `關閉 ${feature} 也會關閉 1 項功能`,
        dependentsTitle_other: ({ feature, count }: { feature: string; count: number }) => `關閉 ${feature} 也會關閉 ${count} 項功能`,
        dependentNeeds: ({ feature, parent }: { feature: string; parent: string }) => `${feature} 需要 ${parent}。`,
        turnOff: '關閉',
        deviceTitle: '此裝置上的功能',
        deviceBody: '只影響此裝置的功能位於設定中。',
        adminTitle: '只有擁有者可以變更功能',
        adminBody: '你是管理員，因此可以查看這個 Home 提供的功能。',
        loadFailed: '這個 Home 沒有傳回功能。',
        conflictTitle: '功能已在別處變更',
        conflictBody: '你查看時有人變更了這個 Home 的設定。頁面現在顯示的是 Home 中儲存的內容。',
        rangeBetween: ({ min, max }: { min: number; max: number }) => `${min}–${max}`,
        rangeAtLeast: ({ min }: { min: number }) => `${min} 或以上`,
        rangeAtMost: ({ max }: { max: number }) => `最多 ${max}`,
        limitInvalid: '請輸入範圍內的數字。',
        appliesAfterRestart: '重新啟動後生效',
        onAfterRestart: '重新啟動後開啟',
        offAfterRestart: '重新啟動後關閉',
        ignoredAtLastStart: ({ reason }: { reason: string }) => `上次啟動時已忽略：${reason}`,
        ignoredInvalidType: '儲存的值類型錯誤',
        ignoredOutOfBounds: '儲存的值超出範圍',
        ignoredSecretUnreadable: '無法讀取儲存的密鑰',
        dependentsAfterRestartTitle_one: ({ feature }: { feature: string }) => `下次重新啟動後，關閉 ${feature} 也會關閉 1 項功能`,
        dependentsAfterRestartTitle_other: ({ feature, count }: { feature: string; count: number }) => `下次重新啟動後，關閉 ${feature} 也會關閉 ${count} 項功能`,
    },
    data: {
        title: '資料',
        deletion: '自動刪除',
        deletionDescription: '變更從下次清理開始生效。',
        dryRunMode: '試執行模式',
        dryRunModeDescription: '關閉之前，清理只計數而不刪除。',
        tryRules: '試用目前規則',
        tryRulesDescription: '立即執行一次清理，不刪除任何內容。',
        runDryRun: '開始試執行',
        runAgain: '再次執行',
        ranAt: ({ time }: { time: string }) => `${time} 執行 · 未刪除任何內容`,
        sweepInProgress: '正在進行清理，請在完成後重試。',
        wouldDelete: ({ count, examined }: { count: string; examined: string }) => `將刪除 ${count} 筆 · 已檢查 ${examined} 筆`,
        nothingToDelete: '沒有要刪除的內容',
        stopTimeBudget: '已停止：時間上限',
        stopRowBudget: '已停止：刪除上限',
        stopCandidateBudget: '已停止：檢查上限',
        stopStalled: '已停止：沒有進展',
        keep: '保留',
        deleteAfter: '到期刪除',
        days: '天',
        daysFor: ({ domain }: { domain: string }) => `${domain}的保留天數`,
        daysRequired: '請輸入天數。',
        daysInvalid: '請輸入不小於 1 的整數天數。',
        defaultEffect: ({ effect }: { effect: string }) => `預設 · ${effect}`,
        alwaysRuns: '即使自動刪除已關閉也會執行。',
        expiresAutomatically: '自動過期',
        systemRecords: '系統記錄',
        systemRecordsSummary_one: '這個 Home 為自身保留的 1 類記錄',
        systemRecordsSummary_other: ({ count }: { count: number }) => `這個 Home 為自身保留的 ${count} 類記錄`,
        adminTitle: '只有擁有者可以變更這個 Home 保留的內容',
        adminBody: '你是管理員，因此可以查看這些規則。',
        loadFailed: '這個 Home 沒有傳回資料設定。',
        conflictTitle: '資料設定已在別處變更',
        conflictBody: '你查看時有人變更了這個 Home 的設定。頁面現在顯示的是 Home 中儲存的內容。',
    },
};

const homeGovernanceTranslations = { zhHant } as const;

return { homeGovernanceTranslations };
})();

const Domain_homeIndexTranslations = (() => {
type HomeIndexTranslation = Shared_homeIndexTranslations.HomeIndexTranslation;

const homeIndexTranslations = { 'zh-Hant': {
        greetingMorning: ({ name }) => `早安，${name}`,
        greetingAfternoon: ({ name }) => `午安，${name}`,
        greetingEvening: ({ name }) => `晚安，${name}`,
        greetingMorningAnonymous: '早安',
        greetingAfternoonAnonymous: '午安',
        greetingEveningAnonymous: '晚安',
        sessionsWorking: ({ count }) => `${count} 個工作階段正在工作`,
        sessionsNeedYou: ({ count }) => `${count} 個需要你`,
        sessionsAwaitingResponse: ({ count }) => `${count} 個工作階段正在等待你的回覆`,
        nothingRunning: '尚無執行中的工作階段',
        customize: '自訂',
        customizeTitle: '自訂首頁',
        customizeDescription: '拖曳以重新排序。儲存在你的帳號中，所有裝置顯示相同的首頁。',
        customizing: "正在自訂首頁",
        customizingHint: "將小工具拖入、拖出群組，或在群組之間拖曳",
        sections: "區塊",
        newRow: "拖到這裡以開始新的一列",
        newRowVerb: "移到新的一列",
        reset: '重設',
        alwaysShown: '一律顯示',
        builtIn: '內建',
        startDescription: '輸入框與建議',
        attentionDescription: '有事需要你時顯示',
        machinesDescription: '內建 · 你的機器網格',
        hiddenSetupSteps: '已隱藏的設定步驟',
        showAgain: ({ count }) => `${count} · 再次顯示`,
        reorderHandle: ({ section }) => `重新排序：${section}`,
    } } satisfies Pick<Readonly<Record<string, HomeIndexTranslation>>, "zh-Hant">;

return { homeIndexTranslations };
})();

const Domain_homeSettingsTranslations = (() => {
const en = Shared_homeSettingsTranslations.en;

const zhHant: typeof en = {
    page: {
        title: '伺服器設定',
        description: '伺服器讀取的、沒有獨立頁面的所有設定。',
        searchPlaceholder: '搜尋設定或環境變數鍵',
        changed: '已變更',
        changedA11y: ({ count }: { count: number }) => (count === 1 ? '僅顯示 1 項已變更的設定' : `僅顯示 ${count} 項已變更的設定`),
        noMatches: '沒有符合此搜尋的設定。',
        noChanges: '這個 Home 上沒有設定偏離預設值。',
        filterLabel: '顯示',
        filterAll: '所有設定',
        filterChanged: ({ count }: { count: number }) => `已變更 · ${count}`,
        more: '更多',
        readOnlyTitle: '啟動時唯讀',
        readOnlyDescription: '伺服器在讀取任何已儲存設定之前就需要這些值，因此它們在伺服器執行的位置設定。',
        note: '除非標示為「重新啟動後生效」，否則設定在變更後立即生效。「待處理」表示已儲存的值與伺服器啟動時使用的值不同。每次變更都會記錄在活動中；密鑰值永遠不會被記錄。',
        adminTitle: '只有擁有者可以變更伺服器設定',
        adminBody: '你可以查看每項設定及其值的來源。',
        loadFailed: '無法載入伺服器設定。',
        saveFailed: '設定未儲存。',
        conflictTitle: '設定已在其他地方變更',
        conflictBody: '在你編輯時，有人變更了這個 Home 的設定。頁面現在顯示他們的值；你的修改仍保留在輸入欄位中。',
    },
    row: {
        appliesAfterRestart: '重新啟動後生效',
        pending: '待處理',
        defaultValue: ({ value }: { value: string }) => `預設：${value}`,
        runningWith: ({ value }: { value: string }) => `自上次啟動以來使用 ${value} 執行`,
        runningWithout: '自上次啟動以來未使用此項執行',
        ignored: ({ reason }: { reason: string }) => `上次啟動時被忽略：${reason}`,
        runningOn: ({ value }: { value: string }) => `執行於 ${value}`,
        notSet: '未設定',
        outOfBounds: ({ bounds }: { bounds: string }) => `必須為 ${bounds}`,
        invalid: '此值在這裡無效',
        storedEncrypted: '已加密儲存，永不顯示',
    },
    banner: {
        pendingNames: ({ names }: { names: string }) => `${names}。`,
        andMore: ({ count }: { count: number }) => (count === 1 ? '另外 1 項' : `另外 ${count} 項`),
        discard: '捨棄',
        discarded: '已捨棄待處理的變更',
        ignoredTitle: '上次啟動時有一項設定被忽略',
        ignoredTitleMany: ({ count }: { count: number }) => `上次啟動時有 ${count} 項設定被忽略`,
        ignoredBody: ({ setting, reason }: { setting: string; reason: string }) => `${setting}：${reason}。伺服器在沒有它的情況下啟動。`,
        fix: '修正',
    },
    readOnly: {
        before_database: '在資料庫開啟之前讀取',
        per_process_identity: '每個伺服器處理程序各不相同',
        invariant: '用於保護登入和建置限制，因此無法在此變更',
        other: '在伺服器執行的位置設定',
        set: '已設定',
    },
    secret: {
        saved: '已儲存',
        replace: '取代',
        clear: '清除',
        keep: '保留',
        clearPending: '儲存後將移除已儲存的值。',
        valueSet: '已設定',
        valueNotSet: '未設定',
        setAction: '設定',
    },
    groupSummary: ({ count }: { count: number }) => (count === 1 ? '1 項設定 · 預設' : `${count} 項設定 · 預設`),
    groupSummaryChanged: ({ count, changed }: { count: number; changed: number }) => `${count} 項設定 · ${changed} 項已變更`,
    units: {
        ms: '毫秒',
        seconds: '秒',
        minutes: '分鐘',
        bytes: '位元組',
        megabytes: 'MB',
    },
    activity: {
        discarded: '捨棄了一項待處理的伺服器設定',
    },
    choices: {
        hosted_happier_relay: 'Happier 中繼',
        direct_apns: 'Apple 推播',
        background_wake_best_effort: '背景喚醒',
        local_only: '僅此裝置',
        disabled: '關閉',
        enabled: '開啟',
        automatic: '自動',
        sandbox: '沙盒',
        production: '正式環境',
        owner: '伺服器擁有者',
        authenticated: '任何已登入使用者',
        self: '此伺服器',
        external: '外部服務',
        '0': '關閉',
        '1': '開啟',
        any: '任一',
        all: '全部',
        github_app: 'GitHub App',
        oauth_user_token: '使用者權杖',
        light: '輕量',
        full: '完整',
        api: '僅 API',
        worker: '僅 worker',
        fatal: '嚴重',
        error: '錯誤',
        warn: '警告',
        info: '資訊',
        debug: '偵錯',
        trace: '追蹤',
        silent: '靜默',
        manual: '手動',
        default: '伺服器預設',
    },
    rateLimit: {
        max: ({ route }: { route: string }) => `${route}：每個時間窗的請求數`,
        window: ({ route }: { route: string }) => `${route}：時間窗`,
    },
    groups: {
        api: 'API 與網路',
        storage: '儲存空間與檔案',
        monitoring: '監控',
        process: '處理程序',
        ui: 'Web 應用程式託管',
        realtime: '線上狀態與通訊端',
        retentionCaps: '保留作業資源上限',
        rpc: '機器呼叫',
        liveActivity: 'Live Activities',
        voice: '語音',
        connectedServices: '已連線的服務',
        localServices: '本機服務',
        plugins: '外掛程式',
        reviews: '審查',
        bugReports: '錯誤回報',
        releases: '發行版本',
        authCaches: '登入快取',
        limits: '限制',
        rateLimits: '依路由的速率限制',
        github: 'GitHub 登入',
        oauth: 'OAuth 登入',
        oidc: '設定中的 OIDC 提供者',
        workos: 'WorkOS',
        signInRequests: '登入要求',
        offboarding: '離職處理',
        friends: '好友',
        accountService: '帳號服務',
        devices: '裝置',
        diagnostics: '診斷',
        reachInference: '位址偵測',
        addresses: '位址',
        other: '其他',
    },
    keys: {
        HAPPIER_HOME_DISPLAY_NAME: 'Home 名稱',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: '背景更新',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: '傳送模式',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_ALLOW_FALLBACK: '改用其他模式',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_DEDUPE_WINDOW_MS: '重複更新時間窗',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_ENABLED: '背景喚醒推播',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_MIN_INTERVAL_MS: '喚醒推播最短間隔',
        HAPPIER_LIVE_ACTIVITY_EXPO_WIDGETS_PUSH_NOTIFICATIONS_ENABLED: '小工具版本接收推播',
        HAPPIER_LIVE_ACTIVITY_TARGET_TRANSIENT_FAILURE_BUDGET: '裝置被移除前的失敗次數',
        HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT: 'Apple 推播環境',
        HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID: 'Apple 團隊 ID',
        HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID: 'Apple 推播金鑰 ID',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY: 'Apple 推播簽署金鑰',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY_FILE: 'Apple 推播簽署金鑰檔案',
        HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS: '允許的 App Bundle ID',
        HAPPIER_LIVE_ACTIVITY_APNS_ACTIVITY_NAMES: '允許的 Live Activities 名稱',
        HAPPIER_LIVE_ACTIVITY_APNS_REQUEST_TIMEOUT_MS: 'Apple 推播要求逾時',
        HAPPIER_LIVE_ACTIVITY_APNS_RECONNECT_BACKOFF_MS: 'Apple 推播重新連線延遲',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED: '使用託管中繼',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL: '託管中繼位址',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEY: '託管中繼存取金鑰',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_SERVICE_ENABLED: '作為託管中繼運作',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEYS: '供其他伺服器使用的中繼存取金鑰',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_MAX_SKEW_MS: '中繼時鐘容許誤差',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_TTL_MS: '中繼重複記錄保留時間',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_CACHE_MAX_ENTRIES: '中繼重複快取大小',
        ELEVENLABS_API_KEY: 'ElevenLabs API 金鑰',
        ELEVENLABS_AGENT_ID: 'ElevenLabs 代理',
        ELEVENLABS_AGENT_ID_PROD: 'ElevenLabs 正式環境代理',
        ELEVENLABS_API_BASE_URL: 'ElevenLabs API 位址',
        REVENUECAT_SECRET_KEY: 'RevenueCat 私密金鑰',
        VOICE_FREE_SESSIONS_PER_MONTH: '每月免費語音工作階段數',
        VOICE_FREE_MINUTES_PER_MONTH: '每月免費語音分鐘數',
        VOICE_MAX_CONCURRENT_SESSIONS: '同時進行的語音工作階段數',
        VOICE_MAX_SESSION_SECONDS: '最長語音工作階段',
        VOICE_MAX_MINUTES_PER_DAY: '每日語音分鐘數',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_ENABLED: '語音身分回填',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE: '回填批次大小',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS: '回填時間預算',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_DELAY_MS: '回填批次間隔',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_INTERVAL_MS: '回填執行間隔',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID: 'OpenAI Codex OAuth 用戶端 ID',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL: 'OpenAI Codex 權杖端點',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID: 'Claude 訂閱 OAuth 用戶端 ID',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL: 'Claude 訂閱權杖端點',
        HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS: '權杖交換逾時',
        CONNECTED_SERVICE_CREDENTIAL_MAX_LEN: '儲存憑證的最大長度',
        CONNECTED_SERVICE_REFRESH_LEASE_MAX_MS: '最長重新整理租約',
        VENDOR_TOKEN_MAX_LEN: '供應商權杖最大長度',
        HAPPIER_LOCAL_SERVICES_TOKEN_SECRET: '預覽權杖密鑰',
        HAPPIER_LOCAL_SERVICES_PREVIEW_TOKEN_SECRET: '私人預覽權杖密鑰',
        HAPPIER_LOCAL_SERVICES_PUBLIC_PREVIEW_TOKEN_SECRET: '公開預覽權杖密鑰',
        HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN: '外掛程式 UI 來源',
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_MAX_AGE_MS: '發行者證明有效期',
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_CLOCK_SKEW_MS: '發行者證明時鐘容許誤差',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_MAX_AGE_MS: '審查證明有效期',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_CLOCK_SKEW_MS: '審查證明時鐘容許誤差',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: '包含伺服器記錄',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: '誰可以讀取伺服器記錄',
        HAPPIER_BUG_REPORTS_SERVER_LOG_PATH: '伺服器記錄檔',
        HAPPIER_BUG_REPORTS_SERVER_LOG_MAX_BYTES: '包含的記錄大小',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: '發行管道',
        HAPPIER_GITHUB_REPO: '發行儲存庫',
        AUTH_OFFBOARDING_ENABLED: '重新檢查登入資格',
        AUTH_OFFBOARDING_STRICT: '重新檢查失敗時拒絕',
        AUTH_OFFBOARDING_INTERVAL_SECONDS: '重新檢查間隔',
        AUTH_PROVIDERS_CONFIG_PATH: '提供者檔案',
        AUTH_PROVIDERS_CONFIG_JSON: '提供者 JSON',
        HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: '登入服務',
        HAPPIER_AUTH_SIGN_IN_SERVICE_URL: '帳號服務位址',
        HAPPIER_AUTH_SIGN_IN_SERVICE_SERVER_IDENTITY_ID: '帳號服務身分',
        HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME: '帳號服務名稱',
        HAPPIER_SERVER_OWNER_USER_IDS: '伺服器擁有者帳號',
        HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED: '新裝置需要核准',
        GITHUB_CLIENT_ID: 'GitHub OAuth 用戶端 ID',
        GITHUB_CLIENT_SECRET: 'GitHub OAuth 用戶端密鑰',
        GITHUB_REDIRECT_URL: 'GitHub 回呼位址',
        GITHUB_HTTP_TIMEOUT_SECONDS: 'GitHub 要求逾時',
        GITHUB_STORE_ACCESS_TOKEN: '保留 GitHub 存取權杖',
        OAUTH_PENDING_TTL_SECONDS: '待處理登入有效期',
        OAUTH_STATE_TTL_SECONDS: 'OAuth state 有效期',
        HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES: '允許的 App 返回配置',
        AUTH_GITHUB_ALLOWED_USERS: '允許的 GitHub 使用者',
        AUTH_GITHUB_ALLOWED_ORGS: '允許的 GitHub 組織',
        AUTH_GITHUB_ORG_MATCH: '必要組織',
        AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: '成員資格檢查',
        AUTH_GITHUB_APP_ID: '成員資格 GitHub App ID',
        AUTH_GITHUB_APP_PRIVATE_KEY: '成員資格 GitHub App 金鑰',
        AUTH_GITHUB_APP_INSTALLATION_ID_BY_ORG: '依組織的 App 安裝',
        WORKOS_API_KEY: 'WorkOS API 金鑰',
        WORKOS_CLIENT_ID: 'WorkOS 用戶端 ID',
        ACCOUNT_AUTH_REQUEST_TTL_SECONDS: '帳號登入要求有效期',
        TERMINAL_AUTH_REQUEST_TTL_SECONDS: '終端機登入要求有效期',
        AUTH_PAIRING_TTL_SECONDS: '配對碼有效期',
        AUTH_TOKEN_CACHE_TTL_SECONDS: '工作階段權杖快取有效期',
        AUTH_TOKEN_CACHE_MAX_ENTRIES: '工作階段權杖快取大小',
        AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '資格快取有效期',
        AUTH_LOGIN_ELIGIBILITY_CACHE_MAX_ENTRIES: '資格快取大小',
        FRIENDS_USERNAME_MIN_LEN: '使用者名稱最短長度',
        FRIENDS_USERNAME_MAX_LEN: '使用者名稱最長長度',
        FRIENDS_USERNAME_REGEX: '使用者名稱格式',
        HAPPIER_CANONICAL_SERVER_URL: '登入身分位址',
        HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE: 'Web 應用程式 OAuth 返回位址',
        PUBLIC_URL: '公告位址 (light)',
        HAPPIER_PUBLIC_SERVER_URL_INFER_TTL_MS: '偵測到的位址有效期',
        HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL: '依存取方式偵測',
        HAPPIER_TAILSCALE_INFER_PUBLIC_URL: '透過 Tailscale 偵測',
        HAPPIER_TAILSCALE_SERVE_STATUS_TIMEOUT_MS: 'Tailscale Serve 檢查逾時',
        HAPPIER_TAILSCALE_FUNNEL_STATUS_TIMEOUT_MS: 'Tailscale Funnel 檢查逾時',
        PORT: '監聽連接埠',
        HAPPIER_SERVER_HOST: '監聽位址',
        HAPPIER_SERVER_FLAVOR: '伺服器類型',
        NODE_ENV: 'Node 環境',
        SERVER_ROLE: '處理程序角色',
        UV_THREADPOOL_SIZE: '工作執行緒',
        HAPPIER_INSTANCE_ID: '副本 ID',
        HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: '關閉期限',
        HAPPY_EXIT_ON_FATAL: '發生嚴重錯誤後結束',
        HAPPIER_API_CORS_MAX_AGE_SECONDS: '瀏覽器預檢快取',
        HAPPIER_SERVER_IDENTITY_ID: '伺服器身分',
        HAPPIER_MANAGED_RELAY_PURPOSE: '受管中繼用途',
        HAPPIER_PERSONAL_HOME_RELOCATION_OPERATION_ID: '遷移作業',
        HAPPIER_SERVER_STARTUP_RECEIPT_PATH: '啟動回條檔案',
        HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: '啟動回條 nonce',
        HAPPIER_UPDATER_FORWARD_RECOVERY_CAPABILITY: '更新程式前向復原',
        HAPPIER_RELEASE_SOURCE_SHA: '建置提交',
        HAPPIER_FEATURE_POLICY_ENV: '發行環原則',
        HAPPIER_BUILD_FEATURES_ALLOW: '允許的功能',
        HAPPIER_BUILD_FEATURES_DENY: '停用的功能',
        HAPPIER_SERVER_LOG_LEVEL: '記錄層級',
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: '合併偵錯記錄',
        HAPPIER_SELF_HOST_LOG_DIR: '記錄目錄',
        HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS: '驗證診斷',
        HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS: '通訊端訊息診斷',
        METRICS_ENABLED: '指標',
        METRICS_PORT: '指標連接埠',
        SENTRY_DSN: '錯誤回報 DSN',
        HAPPIER_SENTRY_USE_CENTRAL_DSN: '回報給 Happier',
        HAPPIER_SENTRY_CENTRAL_DSN: '中央錯誤回報 DSN',
        SENTRY_ENVIRONMENT: '錯誤回報環境',
        SENTRY_RELEASE: '錯誤回報版本',
        SENTRY_PROFILE_LIFECYCLE: '效能剖析',
        SENTRY_SEND_DEFAULT_PII: '傳送個人資料',
        SENTRY_TRACES_SAMPLE_RATE: '追蹤的要求',
        SENTRY_PROFILE_SESSION_SAMPLE_RATE: '剖析的工作階段',
        SENTRY_ENABLE_LOGS: '傳送記錄',
        SENTRY_LOG_LEVELS: '傳送的記錄層級',
        SENTRY_MONITORS_ENABLED: '工作監控',
        HAPPIER_SERVER_UI_DIR: 'Web 應用程式資料夾',
        HAPPIER_SERVER_UI_PREFIX: 'Web 應用程式路徑',
        HAPPIER_SERVER_UI_REQUIRED: '要求提供 Web 應用程式',
        HAPPIER_SERVER_UI_DEPLOYMENT_ID: 'Web 應用程式部署 ID',
        HAPPIER_SERVER_UI_DEBUG_PATH: '缺少時顯示 Web 應用程式路徑',
        HAPPIER_SOCKET_ADAPTER: '通訊端轉接器',
        HAPPIER_SOCKET_REDIS_ADAPTER: 'Redis 通訊端轉接器（舊版）',
        HAPPIER_SOCKET_ADAPTER_MAXLEN: '通訊端串流長度',
        HAPPIER_SOCKET_ADAPTER_READ_COUNT: '通訊端串流讀取量',
        HAPPIER_SOCKET_MAX_HTTP_BUFFER_SIZE: '最大通訊端訊息',
        HAPPIER_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS: '快速中斷連線門檻',
        HAPPIER_SOCKET_PLANNED_RESTART_RETRY_AFTER_MS: '重新啟動期間的重新連線延遲',
        HAPPIER_SOCKET_RECONNECT_WINDOW_MS: '重新連線時間窗',
        HAPPY_SOCKET_ROOMS_ONLY: '嚴格通訊端分送',
        HAPPIER_MACHINE_SOCKET_OWNER_TTL_SECONDS: '機器通訊端歸屬',
        HAPPIER_PRESENCE_STREAM_MAXLEN: '線上狀態串流長度',
        HAPPIER_PRESENCE_WORKER_DB_WRITE_CONCURRENCY: '線上狀態寫入並行數',
        HAPPIER_PRESENCE_WORKER_FLUSH_INTERVAL_MS: '線上狀態排清間隔',
        HAPPIER_PRESENCE_WORKER_READ_BLOCK_MS: '線上狀態讀取等待',
        HAPPIER_PRESENCE_WORKER_READ_COUNT: '線上狀態讀取量',
        HAPPIER_PRESENCE_WORKER_RECLAIM_IDLE_MS: '線上狀態回收前等待',
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '工作階段視為閒置前等待',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '機器視為離線前等待',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '線上狀態檢查間隔',
        HAPPIER_PRESENCE_SHUTDOWN_FLUSH_TIMEOUT_MS: '關閉時的線上狀態排清',
        HAPPIER_RPC_FORWARD_TIMEOUT_MS: '機器呼叫逾時',
        HAPPIER_RPC_FORWARD_CAPABILITIES_TIMEOUT_MS: '功能呼叫逾時',
        HAPPIER_RPC_FORWARD_MAX_TIMEOUT_MS: '最長呼叫逾時',
        HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS: '等待方法可用',
        HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS: '方法檢查間隔',
        HAPPIER_RPC_CLUSTER_FETCH_TIMEOUT_MS: '跨副本查詢逾時',
        HAPPIER_STOP_SESSION_RPC_METHOD_AVAILABILITY_GRACE_MS: '等待停止工作階段',
        HAPPIER_DIRECT_SESSIONS_RPC_METHOD_AVAILABILITY_GRACE_MS: '等待直接工作階段',
        HAPPIER_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT: '首次載入時需要注意的工作階段',
        HAPPIER_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT: '檢查可回溯的回合',
        HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT: '保留的設定歷程',
        HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK: '要求已簽署的機器金鑰',
        DATABASE_URL: '資料庫',
        HAPPIER_DB_PROVIDER: '資料庫引擎',
        HAPPIER_DB_CONNECTION_LIMIT: '連線集區大小',
        HAPPIER_DB_READINESS_TIMEOUT_MS: '資料庫就緒逾時',
        HAPPIER_DB_TX_MAX_RETRIES: '交易重試次數',
        HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: '首次重試延遲',
        HAPPIER_DB_TX_RETRY_MAX_DELAY_MS: '最長重試延遲',
        HAPPIER_DB_TX_RETRY_JITTER_FACTOR: '重試抖動',
        HAPPIER_DB_TX_TIMEOUT_MS: '交易逾時',
        HAPPIER_DB_TX_MAX_WAIT_MS: '連線等待',
        HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS: '重試總時間',
        HAPPIER_SERVER_DB_SIZE_WARN_BYTES: '資料庫大小警告',
        HAPPIER_SQLITE_AUTO_MIGRATE: '啟動時遷移',
        HAPPIER_SQLITE_MIGRATIONS_DIR: '遷移資料夾',
        HAPPIER_SQLITE_JOURNAL_MODE: 'SQLite 日誌模式',
        HAPPIER_SQLITE_SYNCHRONOUS: 'SQLite 同步模式',
        HAPPIER_SQLITE_JOURNAL_SIZE_LIMIT_BYTES: 'SQLite 日誌大小上限',
        HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: 'SQLite 檢查點間隔',
        HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: 'SQLite 檢查點等待',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_INTERVAL_MS: 'SQLite 清理間隔',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES: 'SQLite 清理頁數',
        HAPPIER_FILES_BACKEND: '檔案後端',
        S3_HOST: 'S3 主機',
        S3_PORT: 'S3 連接埠',
        S3_USE_SSL: 'S3 使用 TLS',
        S3_REGION: 'S3 區域',
        S3_BUCKET: 'S3 貯體',
        S3_PUBLIC_URL: 'S3 公開位址',
        S3_ACCESS_KEY: 'S3 存取金鑰',
        S3_SECRET_KEY: 'S3 私密金鑰',
        REDIS_URL: 'Redis 連線',
        HANDY_MASTER_SECRET: '主密鑰',
        HAPPIER_SERVER_LIGHT_DATA_DIR: '資料目錄',
        HAPPIER_SERVER_LIGHT_DB_DIR: '資料庫目錄',
        HAPPIER_SERVER_LIGHT_FILES_DIR: '檔案目錄',
        HAPPIER_API_RATE_LIMITS_ENABLED: '速率限制',
        HAPPIER_API_RATE_LIMITS_GLOBAL_MAX: '每個用戶端的要求數',
        HAPPIER_API_RATE_LIMITS_GLOBAL_WINDOW: '速率限制時間窗',
        HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY: '要求計數依據',
        HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: '路由要求計數依據',
        HAPPIER_SERVER_TRUST_PROXY: '信任 Proxy 標頭',
        HAPPIER_SERVER_RETENTION__INTERVAL_MS: '清理間隔',
        HAPPIER_SERVER_RETENTION__BATCH_SIZE: '每批列數',
        HAPPIER_SERVER_RETENTION__MAX_DELETES_PER_RULE_PER_RUN: '每條規則最多刪除數',
        HAPPIER_SERVER_RETENTION__SWEEP_TIME_BUDGET_MS: '清理時間預算',
        HAPPIER_SERVER_RETENTION__MAX_CANDIDATES_PER_RULE_PER_RUN: '每條規則最多檢查列數',
    },
};

const homeSettingsTranslations = { zhHant } as const;

return { homeSettingsTranslations };
})();

const Domain_homeSetupTranslations = (() => {
type HomeSetupTranslation = Shared_homeSetupTranslations.HomeSetupTranslation;

const homeSetupTranslations = { 'zh-Hant': {
        dismiss: ({ title }) => `隱藏「${title}」`,
        dismissTooltip: '隱藏 · 可在「自訂」中還原',
        close: '關閉',
        addPhoneSubtitle: '隨時隨地查看工作階段並處理審核。',
        addPhoneAction: '顯示 QR 碼',
        addMachineSubtitle: '執行代理的伺服器或開發機，透過 SSH 或一個指令完成設定。',
        installComputerTitle: '在另一台電腦上安裝',
        installComputerSubtitle: '在那台電腦上安裝桌面 App，並透過連結加入此 Home。',
        installComputerAction: '取得連結',
        connectComputerTitle: '連接電腦',
        connectComputerSubtitle: '掃描 Happier 在電腦終端機中顯示的 QR 碼。',
        connectComputerHint: '將相機對準 Happier 在電腦終端機中顯示的 QR 碼。',
        phoneAddMachineSubtitle: '設定一台伺服器或開發機來執行你的代理。',
        phoneAddMachineAction: '新增',
        thisHome: '此 Home',
        pairingPhoneTitle: '用手機掃描',
        pairingPhoneBody: ({ home }) => `用手機相機對準 QR 碼。Happier 會開啟並加入 ${home}。`,
        pairingPhoneStepInstall: '在手機上安裝 Happier。',
        pairingPhoneStepScan: '開啟相機並掃描 QR 碼。',
        pairingPhoneStepJoin: '請保持此處開啟：手機掃描後會立即加入。',
        pairingComputerTitle: '從另一台電腦加入',
        pairingComputerBody: ({ home }) => `把此連結傳到另一台電腦。在 Happier 中開啟即可加入 ${home}。`,
        pairingComputerStepInstall: '在另一台電腦上安裝桌面 App。',
        pairingComputerStepOpen: '在那台電腦上開啟連結，或在 Happier 詢問連線方式時貼上。',
        pairingComputerStepJoin: '請保持此處開啟：電腦開啟連結後會立即加入。',
        appStore: 'App Store',
        googlePlay: 'Google Play',
        getDesktopApp: '取得桌面 App',
        copyLink: '複製連結',
        waitingForPhone: '正在等待你的手機…',
        waitingForComputer: '正在等待你的電腦…',
        newCodeIn: ({ time }) => `${time} 後產生新 QR 碼`,
        makingCode: '正在產生 QR 碼…',
        addingDevice: ({ device }) => `正在新增 ${device}…`,
        deviceJoined: ({ device, home }) => `${device} 已加入 ${home}`,
        codeFailed: '無法為此 Home 產生 QR 碼。',
        codeFailedUnreachable: ({ home }) => `${home} 沒有回應此裝置。`,
        codeFailedIdentity: ({ home }) => `此裝置記錄的 ${home} 與其回應不一致；請在 Homes 中重新連線。`,
        codeFailedSignedOut: ({ home }) => `此裝置未登入 ${home}。`,
        codeFailedTooLarge: '位址太多，無法放入 QR 碼。',
        codeFailedRefused: ({ home }) => `${home} 拒絕了請求。`,
        codeFailedUnexpected: '發生問題，請再試一次。',
        cancelCode: '取消 QR 碼',
        newCode: '新 QR 碼',
        qrLabel: ({ home }) => `將裝置加入 ${home} 的 QR 碼`,
        storeQrLabel: ({ store }) => `${store} 上 Happier 的 QR 碼`,
        getTheApp: '取得 App',
        connectServicesTitle: ({ first, second }) => (second ? `連接 ${first} 或 ${second}` : `連接 ${first}`),
        connectServicesSubtitle: '在每台機器上使用你已付費的方案，並查看剩餘額度。',
    } } satisfies Pick<Readonly<Record<string, HomeSetupTranslation>>, "zh-Hant">;

return { homeSetupTranslations };
})();

const Domain_homeWidgetTranslations = (() => {
type HomeWidgetTranslation = Shared_homeWidgetTranslations.HomeWidgetTranslation;

const homeWidgetTranslations = { 'zh-Hant': {
        open: ({ destination }) => `開啟${destination}`,
        refreshFailed: '無法重新整理',
        latestRunsTitle: '最近執行',
        latestRunsLoading: '正在載入最近執行',
        latestRunsEmptyTitle: '尚無執行紀錄',
        latestRunsEmptyReason: '你的自動化執行後，每次執行的結果都會顯示在這裡。',
        latestRunsErrorTitle: '無法載入最近執行',
        latestRunsErrorReason: '你的 Home 沒有回應。請檢查連線後再試一次。',
    } } satisfies Pick<Readonly<Record<string, HomeWidgetTranslation>>, "zh-Hant">;

return { homeWidgetTranslations };
})();

const Domain_homesHubTranslations = (() => {
type HomesHubTranslation = Shared_homesHubTranslations.HomesHubTranslation;

const homesHubTranslations = { 'zh-Hant': {
        addHomeOrSignIn: '新增 Home / 登入',
        sheetDescription: '將此裝置連接到另一個 Home，或找到你的 Home。',
        continueWithService: ({ service }) => `使用 ${service} 繼續`,
        continueWithThisHome: '使用此 Home 繼續',
        continueWithServiceSubtitle: '找到你的 Home，並讓此 Home 在你的其他裝置上可用。',
        serviceUnavailable: ({ service }) => `${service} 暫時無法使用。`,
        serviceUnsupported: ({ service }) => `${service} 不支援帳戶登入。`,
        serviceUnavailableUnnamed: '你的登入服務暫時無法使用。',
        serviceUnsupportedUnnamed: '你的登入服務不支援帳戶登入。',
        scanOrPaste: '掃描或貼上 Home 連結',
        scanOrPasteSubtitle: '透過 QR 碼或連結加入 Home。',
        createPersonalHome: '在這台電腦上建立個人 Home',
        createPersonalHomeSubtitle: '在這裡為你自己的機器和裝置執行一個 Home。',
        opensFirst: '優先開啟',
    } } as const satisfies Pick<Record<string, HomesHubTranslation>, "zh-Hant">;

return { homesHubTranslations };
})();

const Domain_homesJourneysTranslations = (() => {
type Service = Shared_homesJourneysTranslations.Service;

type Home = Shared_homesJourneysTranslations.Home;

type HomesJourneysTranslation = Shared_homesJourneysTranslations.HomesJourneysTranslation;

const en = Shared_homesJourneysTranslations.en;

const ruTimes = Shared_homesJourneysTranslations.ruTimes;

const zhHant: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "你的 Home 都在這裡",
        reconcileLead: "這支手機現在可以一起查看你的所有 Home。",
        showMySessions: "顯示我的工作階段",
        scanComputerCode: "掃描電腦上的 QR 碼",
        serviceLead: "登入後即可找到你的 Home。這支手機隨後可以查看它們全部。",
        serviceAsHomeLead: ({ service }) => `你的工作階段儲存在 ${service}，隨時可存取。準備好後，新增一台電腦來執行代理。`,
        factAlwaysOnDetail: "隨時存取你的工作階段。",
        factAgents: "你的電腦執行代理",
        factAgentsDetail: "稍後透過 QR 碼新增電腦。",
        fromDeviceHelp: "在已連線的裝置上開啟「設定 → 新增手機」，用這支手機的相機掃描 QR 碼，或貼上 Home 連結。",
        scan: "掃描",
    },
    happierAccount: 'Happier 帳號',
    serviceAccount: ({ service }) => `${service} 帳號`,

    alreadyUseTitle: '已經在用 Happier？',
    alreadyUseDescription: '用你的帳號找到你的 Home，或直接連線到你自己執行的 Home。在你做出選擇之前，這台電腦上不會有任何變更。',
    signIn: '登入',
    withService: ({ service }) => `使用 ${service}`,
    changeServiceLabel: ({ service }) => `登入服務：${service}。變更`,
    connectToHome: '連線到 Home…',
    hostedPrompt: '比較想要代管的？',
    useServiceAsAHome: ({ service }) => `將 ${service} 用作 Home`,
    dismiss: '隱藏',

    pathServiceTitle: ({ service }) => `使用 ${service} 登入`,
    pathServiceSubtitle: '找到與你的帳號連結的 Home',
    pathOtherServiceTitle: '使用其他服務登入',
    pathOtherServiceSubtitle: '你自己或公司的登入服務',
    pathDirectTitle: '直接連線到 Home',
    pathDirectSubtitle: '連結或位址 · 不需要帳號',

    serviceLead: '登入後會找到你的 Home 並一起顯示。在你決定之前，這台電腦的個人 Home 會一直保留。',
    defaultServiceFact: '預設登入服務',
    serviceMethodsHelp: ({ service }) => `只會顯示 ${service} 提供的方式。第一次使用？同樣的按鈕會為你建立帳號。`,

    otherServiceLead: '如果你或你的團隊執行自己的登入服務，請輸入它的位址。Happier 會先檢查它提供哪些功能。',
    serviceAddressLabel: '登入服務位址',
    serviceFound: '已找到',
    useThisService: ({ service }) => `使用 ${service} 登入`,
    addressIsNotAService: '此位址不提供帳號登入。如果它是 Home，請直接連線。',
    connectAsHome: '以 Home 連線',
    backToService: ({ service }) => `返回 ${service}`,

    directLead: '適用於你自己執行的 Home，有沒有帳號服務都可以。不需要 Happier 帳號。',
    fromDeviceLabel: '從已連線的裝置',
    fromDeviceHelp: '在該裝置上開啟「設定 → 新增你的手機」，再用這台電腦的相機掃描代碼，或貼上它的 Home 連結。',
    homeLinkLabel: 'Home 連結',
    homeLinkPlaceholder: '貼上 Home 連結',
    useCamera: '使用相機',
    openLink: '開啟',
    byAddressLabel: '透過位址',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: '連線',
    byAddressHelp: 'Happier 會檢查 Home 是否回應，接著你用該 Home 自己的方式登入。',
    notAHomeLink: '這不是 Home 連結。請從另一台裝置重新複製。',
    homeUnreachable: 'Happier 無法在該位址連上 Home。請檢查位址以及 Home 是否正在執行。',

    anotherWay: '其他方式',
    homeReachable: '可連線',
    connected: '已連線',
    signInToHomeTitle: '登入此 Home',
    signInToHomeLead: '以下是此 Home 提供的方式。',

    reconcileTitle: '你的 Home 已連線',
    reconcileLead: ({ count }) => `這台電腦現在有 ${count + 1} 個 Home，它們會一起顯示在「全部 Home」中。`,
    reconcileFound: '已找到',
    reconcileThisComputer: '這台電腦',
    runSessionsIn: '這台電腦的工作階段執行於',
    runSessionsInDescription: '在這裡開始的新工作階段會儲存到此 Home。',
    removeEmptyPersonalHome: '移除空的個人 Home',
    removeEmptyPersonalHomeDescription: '它在你安裝 Happier 時建立，目前還沒有任何內容——沒有工作階段、成員、團隊或邀請。',
    changeLater: '稍後可在「設定 → Home」中變更。',
    keepBoth: '兩個都保留',
    useHome: ({ home }) => `使用 ${home}`,
    reconcileSetupTitle: '選擇這台電腦的工作階段去向',
    reconcileSetupSubtitle: ({ home }) => `你已連線 ${home}。保留兩個 Home，或在那裡執行這台電腦的工作階段。`,
    reconcileSetupAction: '選擇…',

    serviceAsHomeTitle: ({ service }) => `將 ${service} 用作你的 Home`,
    serviceAsHomeLead: ({ service }) => `你的工作階段和設定儲存在 ${service}，而不是這台電腦上。`,
    factAlwaysOn: '隨時在線',
    factAlwaysOnDetail: '這台電腦休眠時，你的手機也能存取工作階段。',
    factAgents: '這台電腦繼續執行你的代理',
    factAgentsDetail: '程式碼執行的位置不會改變。',
    storageE2ee: '端對端加密',
    storageE2eeDetail: ({ service }) => `${service} 儲存你的工作階段，但無法讀取。`,
    storagePlain: ({ service }) => `由 ${service} 儲存`,
    storagePlainDetail: '未端對端加密：服務可以讀取它儲存的內容。',
    storageE2eeByDefault: '預設端對端加密',
    storagePlainByDefault: ({ service }) => `由 ${service} 儲存，預設可讀取`,
    storageChoiceDetail: '建立帳號時由你選擇。',
    removeEmptyOfferedDetail: '它目前沒有任何內容。只因為它是空的才提供此選項。',
    signInOrCreate: ({ account }) => `登入或建立你的 ${account}`,
    alreadyUseServiceAsHome: ({ service }) => `已經把 ${service} 用作 Home？登入後會直接連線。`,

    addHomeTitle: '新增 Home',
    addHomeDescription: 'Home 會儲存你的工作階段和設定。連線一個你已在用的 Home，或在新的地方建立一個。',
    addSignIn: ({ account }) => `使用你的 ${account} 登入`,
    addSignInSubtitle: '找到你已在用的 Home 並連線。',
    addServiceAsHomeSubtitle: '為你代管，隨時在線。',
    addLinkOrQr: '透過連結或 QR 碼連線',
    addLinkOrQrSubtitle: '不需要帳號。從已連線的裝置取得。',
    addServerHome: '在伺服器上設定 Home',
    addServerHomeSubtitle: '你掌控的開發機或 VPS，透過 SSH 設定。',
    haveHomeAddress: '有 Home 位址？',
    enterIt: '輸入位址',

    livesOnThisComputer: '位於這台電腦上',
    availableWhileAwake: '喚醒時可用',
    gettingReady: '正在準備',
    noComputerYet: '還沒有電腦？',
    aboutYourHome: '關於你的 Home',

    nudgeTitle: ({ count }) => `本週有 ${count} 次無法連線到 Home — 移動 Home？`,
    nudgeBody: '如果此 Home 執行於會休眠的電腦，將它移到持續開機的主機可能有幫助。',
    nudgeDismiss: '在此裝置上不再顯示',
    moveHome: '移動 Home…',
    useService: ({ service }) => `使用 ${service}`,
};

const homesJourneysTranslations = { 'zh-Hant': zhHant } satisfies Pick<Readonly<Record<string, HomesJourneysTranslation>>, "zh-Hant">;

return { homesJourneysTranslations };
})();

const Domain_identityAdministrationTranslations = (() => {
type IdentityAdministrationLanguage = Shared_identityAdministrationTranslations.IdentityAdministrationLanguage;

type Words = Shared_identityAdministrationTranslations.Words;

type GitHubAccessWords = Shared_identityAdministrationTranslations.GitHubAccessWords;

type OidcEditorWords = Shared_identityAdministrationTranslations.OidcEditorWords;

const build = Shared_identityAdministrationTranslations.build;

const en = Shared_identityAdministrationTranslations.en;

const githubAccessWords: Pick<Readonly<Record<IdentityAdministrationLanguage, GitHubAccessWords>>, "zhHant"> = { zhHant: {
        githubCurrentAccess: '目前存取權限',
        githubCurrentAccessSubtitle: '使用此安裝的已啟用連線及目錄來源所需的權限。',
        githubCurrentAccessEmpty: '已啟用的服務不需要存取權限。',
        githubSetupAccess: '設定與修復所需的權限',
        githubSetupAccessSubtitle: '已設定連線所需的權限，包括已停用的連線與已暫停的目錄來源。啟用或繼續之前，請在 GitHub 授予缺少的權限，然後重新驗證安裝。',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `移除 ${name} 的安裝`,
    } };

const oidcEditorWords: Pick<Readonly<Record<IdentityAdministrationLanguage, OidcEditorWords>>, "zhHant"> = { zhHant: {
        clientAuthenticationMethod: '用戶端驗證', clientSecretPost: 'POST 本文', clientSecretBasic: 'HTTP Basic', storeRefreshToken: '儲存更新權杖', buttonColor: '登入按鈕顏色', iconHint: '登入圖示',
        allowRulesHint: '每行輸入一個值。留空表示不限制。', brandingHint: '留空以使用預設登入外觀。', invalidScopes: '要求的範圍必須包含 openid。', refreshFailed: '無法更新此連線', refreshFailedHint: '你的編輯已保留。重試以檢查 Home 上的變更。',
    } };

const identityAdministrationTranslations = { zhHant: build({ homeWorkosAdd: "透過 WorkOS 進行公司登入", homeWorkosCompanyName: "公司名稱", homeWorkosPurpose: "公司成員可以使用工作帳戶登入此 Home。", homeWorkosEnableDetail: "成員隨後即可使用公司帳戶登入此 Home。", homeWorkosOffboarding: "僅靠 SSO 不會移除離職人員。", homeWorkosPlatformRequired: "請先在登入平台中設定 WorkOS。",  ...en, title: '身分提供者', subtitle: '可供 Team 使用的 Home 登入連線。', homeConnections: 'Home 登入連線', add: '新增連線', empty: '沒有 Home 登入連線', active: '已啟用', disabled: '已停用', configuration: '設定', issuer: '簽發者 URL', clientSecret: '用戶端密鑰', secretSet: '已設定', secretNotSet: '未設定', secretRetain: '留空以保留目前的密鑰。', advanced: '顯示進階設定', hideAdvanced: '隱藏進階設定', actions: '操作', test: '測試登入', testing: '正在開啟測試…', edit: '編輯連線', save: '儲存連線', saving: '正在儲存…', enable: '啟用連線', disable: '停用連線', remove: '移除連線', createTitle: '新增身分提供者', editTitle: '編輯身分提供者', displayName: '名稱', required: '請填寫必填欄位。', invalidIssuer: '請輸入有效的 HTTPS URL。', secretRequired: '請輸入用戶端密鑰。', error: '未能套用變更。', accounts: '受影響的 Account', connections: 'Team 連線', errorForbidden: '你已不再擁有此操作的權限。未變更任何內容。', errorConflict: '其他人先做了變更。你的編輯已保留：請重新載入後再試。', errorMissing: '該項目已不存在，可能已被移除。', errorInUse: '仍有內容依賴它，請先移除那些內容。', errorProviderUnavailable: '身分服務未回應。未變更任何內容。', errorRateLimited: '供應商要求稍後再試。', errorInvalid: 'Home 拒絕了這些值。請檢查設定後再試。', errorImmutable: '記錄啟用後此值即固定，請改為新建一筆。', errorAuthenticationRequired: '請重新登入此 Team 後再試。未變更任何內容。', errorPolicyUnavailable: '目前無法評估 Team 的驗證政策。未變更任何內容。', errorPolicyInUse: 'Team 的驗證政策仍依賴此連線。', errorNotAllowed: '此 Home 不允許 Team 設定此項。未變更任何內容。', errorNeedsAttention: '目錄同步需要處理。請執行一次完整同步。', errorSyncPaused: '該來源已暫停。「繼續同步」會開始一次新的完整同步。', alternateLogins: '需要其他登入方式的 Account', recoveryAuthenticationPolicy: '開啟 Team 驗證', recoveryAlternateLogin: '請先為這些 Account 提供其他登入方式', recoveryDirectory: '開啟目錄', recoveryGroupMappings: '開啟群組對應', recoveryTeamAuthentication: '重新登入', callbackUrl: '回呼 URL', callbackUrlHint: '請在你的身分提供者處註冊此 URL。' , workosSetupSso: '開啟 WorkOS 管理入口', workosSetupDirectory: '設定 WorkOS Directory Sync', workosCheckSetup: '檢查 WorkOS 設定', workosChooseConnection: '選擇連線', workosPortalConfirmBody: '你將在 WorkOS 中完成設定，然後回到這裡選擇連線。', workosDirectoryPortalConfirmBody: '你將在 WorkOS 中完成設定，然後回到這裡選擇目錄。', workosSetupSection: '設定', workosSetupFooter: '可以先離開再回來：設定會從已到達的步驟繼續。', workosStepPortalDetail: '在那裡連接你的身分提供者。回來後，設定會在這裡繼續。', workosStepPortalDone: '管理入口', workosStepPortalDoneDetail: '你的組織已連結。', workosOpenPortal: '開啟入口', workosOpenPortalAgain: '再次開啟', workosStepChooseDetail: '選擇成員用於登入的 WorkOS 連線。', workosStepChooseDone: '連線', workosFindConnections: '尋找連線', workosUseConnection: ({ name }: { name: string }) => `使用 ${name}`, workosCandidateDraft: '這是 WorkOS 中的草稿，請先在那裡完成。', workosStepTestDetail: '你自己登入一次。不會在任何人的帳戶中儲存內容。', workosTestPassed: '你的測試登入成功了。', workosTestAgain: '再次測試', workosStepEnable: '開啟', workosStepEnableDetail: '開啟後成員即可用它登入。若要設為必要，請在「成員如何登入」中選擇它。', workosTurnOn: '開啟', workosConnectionSection: '連線', workosConnectionRow: 'WorkOS 連線', workosConnectionNotChosen: '尚未選擇', workosChange: '變更', errorWorkosPlatformUnavailable: '此 Home 尚未設定 WorkOS。', errorSetupRequired: '需要先完成設定才能使用。', removeTitle: ({ name }: { name: string }) => `移除 ${name}？`, removeBody: ({ name }: { name: string }) => `${name} 將不再作為登入方式提供。使用過它的帳戶會保留。`, removeBlocked: ({ accounts, connections }: { accounts: number; connections: number }) => `仍有 ${connections} 個 Team 連線和 ${accounts} 個帳戶在使用。請先移除它們。`, disableTitle: ({ name }: { name: string }) => `關閉 ${name}？`, disableBody: ({ name }: { name: string }) => `在重新開啟之前，沒有人能透過 ${name} 登入。不會刪除任何內容。`, githubRemoveInstallationTitle: ({ name }: { name: string }) => `移除 ${name} 上的安裝？`, githubRemoveInstallationBody: ({ name }: { name: string }) => `此 Home 將不再使用 ${name} 上的 App。GitHub 上不會有任何變化；如不再需要，請在那裡解除安裝。`, removeBlockedTitle: ({ name }: { name: string }) => `暫時無法移除 ${name}`, removeImpactPeople: ({ count }: { count: number }) => `有 ${count} 人透過它登入此 Team。`, removeImpactNobody: '還沒有人透過它登入此 Team。', removeImpactKept: '他們的帳戶和 Team 成員身分會保留。', removeBlockedAlternateLogins: ({ count }: { count: number }) => `有 ${count} 人沒有其他登入方式。`, removeBlockedDirectories: ({ count }: { count: number }) => `仍有 ${count} 個目錄來源在使用它。`, removeBlockedGroups: ({ count }: { count: number }) => `仍有 ${count} 個群組對應在使用它。`, removeBlockedMemberships: ({ count }: { count: number }) => `仍有 ${count} 個成員身分由它管理。` }, githubAccessWords.zhHant, oidcEditorWords.zhHant) };

return { githubAccessWords, oidcEditorWords, identityAdministrationTranslations };
})();

const Domain_inboxWorkTranslations = (() => {
const en = Shared_inboxWorkTranslations.en;

const zhHant: typeof en = {
    pageDescription: '所有等你處理的事項，依所屬工作分組。',
    tabs: { a11y: '收件匣檢視', needsYou: '需要你', updates: '動態' },
    groups: {
        unknownLead: '工作階段',
        leadMeta: ({ count }) => `${count} 個子工作階段`,
        runMeta: '工作流程執行',
        otherTitle: '其他工作階段',
        otherMeta: '不屬於任何協調者或執行',
        openSession: '開啟工作階段',
        openRun: '開啟執行',
    },
    rows: {
        step: '步驟',
        workflowRun: '工作流程執行',
        review: '審閱',
        stalled: '已停滯',
        stalledReason: '它的機器在回合中途離線',
        landing: '待合併',
        settle: '結束',
        snoozedUntil: ({ time }) => `已延後到 ${time}`,
        more: '更多動作',
        approvalNeeded: '需要你的核准',
        approvalUntitled: '核准一項操作',
    },
    popover: {
        moreInOther: ({ count }) => `其他工作階段中還有 ${count} 項`,
        updates: ({ count }) => `${count} 則動態`,
    },
    empty: {
        title: '沒有需要你處理的事項',
        description: '權限請求、審閱，以及協調者或工作流程在等你的事項都會出現在這裡。',
    },
    updatesEmpty: {
        title: '目前沒有動態',
        description: '已完成的工作階段和好友邀請會出現在這裡。',
    },
    stale: { reason: '無法重新整理工作流程執行', retry: '重試' },
    settleFailed: '無法結束此工作階段',
    detail: {
        openApproval: '開啟請求',
        idle: '選擇一項即可在此查看',
    },
};

const inboxWorkTranslations = { zhHant };

return { inboxWorkTranslations };
})();

const Domain_inputPickerTranslations = (() => {
type InputPickerTranslation = Shared_inputPickerTranslations.InputPickerTranslation;

const inputPickerTranslations = { 'zh-Hant': {
        browse: '瀏覽…',
        browseField: ({ field }) => `瀏覽${field}`,
        unavailable: '提供此選項的外掛程式無法使用。目前的值保持不變。',
        retired: '選擇期間外掛程式已更新。請再試一次。',
        invalid: '此選項無法在這裡使用。目前的值保持不變。',
        failed: '無法開啟選擇器。請再試一次。',
    } } satisfies Pick<Readonly<Record<string, InputPickerTranslation>>, "zh-Hant">;

return { inputPickerTranslations };
})();

const Domain_machineAddTranslations = (() => {
type MachineAddTranslation = Shared_machineAddTranslations.MachineAddTranslation;

const machineAddTranslations = { 'zh-Hant': { newMachine: '新機器', waiting: '等待連線', connected: '已連線', failed: '無法新增這台機器', cancelled: '已取消', cannotReachHost: '無法連線至主機。請檢查位址和 SSH 存取權限。', choosePath: '選擇新增機器的方式', switchHome: '返回此 Home 以繼續' } } satisfies Pick<Record<'en' | 'ru' | 'pl' | 'es' | 'fr' | 'it' | 'pt' | 'ca' | 'de' | 'zh-Hans' | 'zh-Hant' | 'ja', MachineAddTranslation>, "zh-Hant">;

return { machineAddTranslations };
})();

const Domain_machineAgentsTranslations = (() => {
type MachineAgentsTranslation = Shared_machineAgentsTranslations.MachineAgentsTranslation;

const en = Shared_machineAgentsTranslations.en;

const zhHant: MachineAgentsTranslation = {
    signedInWith: ({ label }) => `已透過 ${label} 登入`,
    signedInAs: ({ label }) => `已登入為 ${label}`,
    signedInHere: '已在此機器上登入',
    updateTo: ({ version }) => `更新至 ${version}`,
    needsSignIn: '需要登入',
    waitingForSignIn: '正在等待終端機中的登入…',
    notInstalled: '未安裝',
    downloadSize: ({ size }) => `下載 ${size}`,
    installYourself: '需自行安裝',
    unsupportedOs: '無法在此系統上執行',
    unsupportedArch: '沒有適用於此處理器的版本',
    installing: '正在安裝…',
    progress: ({ done, total }) => `${done} / ${total}`,
    checking: '正在檢查…',
    offlineSignedIn: '上次已登入 · 機器離線',
    offlineSignedOut: '上次未登入 · 機器離線',
    offlineNotInstalled: '上次未安裝 · 機器離線',
    offlineUnknown: '機器離線',
    unknown: '無法檢查此機器',
    actionInstall: '安裝',
    actionUpdate: '更新',
    actionSignIn: '登入',
    actionRetry: '重試',
    actionCancel: '取消',
    actionShowTerminal: '顯示終端機',
    actionGuide: '安裝指南',
    installLeadManaged: ({ agent, machine }) => `Happier 會在 ${machine} 上為 Happier 單獨安裝 ${agent}，不會更動你自己的終端機設定。`,
    installLeadVendor: ({ agent, machine }) => `Happier 會在 ${machine} 上執行 ${agent} 自己的安裝程式。`,
    installAlsoDownloads: ({ what }) => `還會下載工作階段所需的 ${what}。`,
    installThenSignIn: '接著登入。',
    installAgent: ({ agent }) => `安裝 ${agent}`,
    installMyself: '我自己安裝',
    manualLead: ({ agent, machine }) => `Happier 無法替你安裝 ${agent}。請依指南在 ${machine} 上安裝，然後再檢查一次。`,
    checkAgain: '再次檢查',
    closeNote: ({ machine }) => `可以關閉，${machine} 上會繼續進行。`,
    stepCheck: '檢查能否執行',
    stepSignIn: '登入',
    failedKept: '沒有保留任何安裝一半的內容。',
    installedLine: ({ agent, version }) => `已安裝 ${agent} ${version}`,
    nowSignIn: '現在登入',
    signInHow: ({ agent }) => `${agent} 的登入方式`,
    useService: ({ service }) => `使用你的 ${service}`,
    recommended: '推薦',
    serviceConnected: ({ profile }) => `${profile} · 已連線 · 所有機器可用`,
    serviceNotConnected: '連線一次，所有機器都能使用。',
    connect: '連線',
    signInOn: ({ machine }) => `在 ${machine} 上登入`,
    signInOnDetail: ({ agent }) => `在那台機器的終端機中執行 ${agent} 自己的登入，僅該機器使用。`,
    noNativeLogin: ({ agent }) => `${agent} 沒有自己的登入方式：它使用 API 金鑰或已連線的帳戶。連線一次，所有機器都能使用。`,
    openSignInTerminal: '在終端機中開啟登入',
    useThisAccount: '使用此帳戶',
    waitingLead: ({ agent, machine }) => `${agent} 自己的登入已在 ${machine} 的終端機中開啟。一旦回報已登入就會變為就緒。`,
    readyLine: ({ agent, machine }) => `${agent} 已在 ${machine} 上就緒`,
    startSessionWith: ({ agent }) => `用 ${agent} 開始工作階段`,
    setUpAnother: '設定另一個代理',
    unsupportedLead: ({ agent, machine }) => `${agent} 沒有適用於 ${machine} 的版本，因此無法在那裡執行。`,
    setupTitle: ({ agent }) => `設定 ${agent}`,
    signInTitle: ({ agent }) => `登入 ${agent}`,
    readyTitle: ({ agent }) => `${agent} 已就緒`,
    notOnMachineYet: ({ machine }) => `尚未在 ${machine} 上`,
    onMachine: ({ machine }) => `在 ${machine} 上`,
    installingOn: ({ machine }) => `正在 ${machine} 上安裝`,
    cantRunOn: ({ machine }) => `無法在 ${machine} 上執行`,
    terminalTab: ({ agent }) => `登入 · ${agent}`,
    panelLead: '在開啟的瀏覽器中完成。在其他裝置上？請在那裡開啟連結。',
    open: '開啟',
    openSignInPage: '開啟登入頁面',
    waitingEllipsis: '正在等待登入…',
    signedInAlready: '已經登入了？',
    closeTerminal: '關閉終端機',
    showTheTerminal: '顯示終端機',
    phoneLead: ({ agent, machine }) => `${agent} 需要你登入。在這裡開啟頁面並完成，${machine} 會自動取得。`,
    panelSignedInAs: ({ account }) => `已登入為 ${account}。`,
    panelChecked: 'Happier 剛剛檢查過。',
    sectionTitle: '代理',
    sectionDescription: '此機器上的程式設計代理，以及各自的登入方式。',
    addTitle: '新增代理',
    addMore: ({ count }) => (count === 1 ? `還有 1 個可在此執行` : `還有 ${count} 個可在此執行`),
    showAll: '顯示全部',
    showFewer: '收合',
    emptyInstalled: '此機器上還沒有程式設計代理。在下方選擇一個，Happier 會為你安裝並登入。',
    offlineNote: ({ machine }) => `${machine} 已離線。以下是它最後回報的內容。`,
    firstTitle: '設定你的第一個代理',
    firstLead: ({ machine }) => `${machine} 已連線，但還沒有程式設計代理。選一個，Happier 會為你安裝並登入。`,
    firstMore: ({ count }) => (count === 1 ? `或從另外 1 個代理中選擇。` : `或從另外 ${count} 個代理中選擇。`),
    allAgents: '所有代理',
    setUp: '設定',
    choiceUsesService: ({ service, profile }) => `使用你的 ${service}。已連線：${profile}。`,
    choiceSignsInOn: '在機器上登入。',
    dismissFirst: '隱藏「設定你的第一個代理」',
    dismissTooltip: '隱藏 · 可在「自訂」中還原',
    chooseAgent: '選擇代理',
    blockNotInstalled: ({ agent, machine }) => `${agent} 尚未在 ${machine} 上。`,
    blockSetUpToStart: '設定後即可開始。',
    blockSignedOut: ({ agent, machine }) => `${agent} 需要在 ${machine} 上登入。`,
    spawnCliMissing: ({ agent, machine }) => `${agent} 未安裝在 ${machine} 上。`,
    spawnSignedOut: ({ agent, machine }) => `${agent} 在 ${machine} 上已登出。`,
    draftKept: '你的訊息已保留。',
    alreadySetUp: ({ machine, home }) => `${machine} 已連線到 ${home}`,
    startSession: '開始工作階段',
    openMachine: ({ machine }) => `開啟 ${machine}`,
};

const machineAgentsTranslations = { 'zh-Hant': zhHant } satisfies Pick<Readonly<Record<string, MachineAgentsTranslation>>, "zh-Hant">;

return { machineAgentsTranslations };
})();

const Domain_machineDetailPageTranslations = (() => {
type MachineDetailPageTranslations = Shared_machineDetailPageTranslations.MachineDetailPageTranslations;

const english = Shared_machineDetailPageTranslations.english;

const translated = Shared_machineDetailPageTranslations.translated;

const machineDetailPageTranslations = { 'zh-Hant': translated({
        machineDetailPage: {
            description: '在這裡啟動工作階段，並查看這台機器上正在執行的內容。',
            placeholderTitle: '機器',
            online: '線上',
            offline: '離線',
            cliVersionFact: ({ version }) => `CLI ${version}`,
            replacedByFact: ({ machine }) => `已由 ${machine} 取代`,
            unavailableTitle: '這台機器目前無法啟動工作階段',
            startAction: '啟動工作階段',
            tmuxSectionDescription: '這台機器上的新工作階段如何使用 tmux。',
            windowsSectionDescription: '遠端工作階段在這台機器上如何開啟。',
            clisSectionDescription: 'Happier 在這台機器上找到的代理 CLI，以及它可以安裝的工具。',
            runsSectionDescription: '工作階段在這台機器上啟動的程序。',
            recentSessionsTitle: '最近的工作階段',
            recentSessionsDescription: '這台機器上最近的五個工作階段。',
            daemonSectionDescription: '將這台機器連線到 Happier 的背景服務。',
            stopDaemonDescription: '執行中的工作階段會繼續。在這台機器上重新啟動它之前，無法啟動新的工作階段。',
            stopDaemonAction: '停止',
            detailsTitle: '機器詳細資料',
        },
    }) };

return { machineDetailPageTranslations };
})();

const Domain_machinePoolTranslations = (() => {
const en = Shared_machinePoolTranslations.en;

const zhHant = {
    machinesSection: "機器",
    tierPrimaryDescription: "優先嘗試。",
    tierFallbackDescription: "在前面的機器都不在線時嘗試。",
    pauseMember: "暫停用於新工作階段",
    resumeMember: "用於新工作階段",
    pausedState: "已暫停",
    memberMenu: "機器選項",
    newPoolTitle: "新機器池",
    title: "機器池",
    myTitle: "我的機器池",
    add: "新增機器池",
    benefit: "選擇一台首選機器，其他機器可作為備用機器。",
    placementChangeNotice: "變更適用於儲存後開始的工作階段。已開啟的工作階段會留在目前的機器上。",
    connectionSemantics: "開啟連線時會選擇一台電腦，並在該連線期間保持選取。之後的連線可能會選擇另一台電腦。",
    noMembers: "此機器池中還沒有機器",
    unavailable: "不可用",
    memberRevoked: "已撤銷",
    memberReplaced: "已更換",
    memberTemporary: "暫時的",
    availabilityUnknown: "連線可用性未知",
    notVerified: "未驗證",
    brokerUnavailable: "沒有可用的代理",
    brokerAvailable: ({ count }: { count: number }) => `${count} 個可用`,
    basics: "細節",
    name: "名稱",
    description: "說明（可選）",
    descriptionTitle: "說明",
    addMachines: "新增機器",
    noMachines: "此 Home 沒有可用的持久機器。",
    allMachinesAdded: "此 Home 上的每台機器都已在該機器池中。",
    primary: "基本的",
    addFallback: "新增後備",
    moveTo: "移動到",
    moveTierEarlier: "提前移動此層",
    moveTierLater: "稍後再移動此層",
    removeMember: "從池中刪除",
    enableMember: "用於將來的選擇",
    save: "儲存變更",
    create: "建立池",
    delete: "刪除機器池",
    deleteTitle: "刪除這個機器池？",
    deleteBody: "使用此集區的憑證資源（如果有）將失去代理位置，需要修復。這會影響以後的選擇，但不會刪除電腦或停止正在執行的工作階段。",
    saveFailed: "無法儲存此機器池。您的更改仍然在這裡。",
    deleteFailed: "無法刪除該機器池。再試一次。",
    conflictTitle: "這個池子在其他地方發生了變化",
    conflictBody: "您未儲存的變更將被保留。重新載入已儲存的版本以查看最新變更。",
    conflictNoReload: "池標識不再可用。您未儲存的變更將被保留。",
    homeOffline: "此 Home 已離線。重新連線前無法變更機器集區。",
    refreshFailed: "無法重新整理機器池。正在顯示最近一次取得的清單。",
    featureUnavailable: "此 Home 不提供機器池。請在 Home 上更新或啟用機器池後繼續。",
    openSettings: "機器池設定",
    pickSpecificMachine: "選擇特定機器",
    poolNotFound: "此機器池不再可用。",
    reload: "重新載入已儲存的版本",
    reloadTitle: "放棄未儲存的變更嗎？",
    reloadBody: "重新載入會將此表單替換為最新儲存的版本。",
    privacy: "此 Home 的伺服器可以讀取機器集區名稱、描述與成員資訊，即使帳戶已啟用端對端加密。",
    nameRequired: "儲存前輸入名稱。",
    memberNotEligible: "有些機器不能再屬於​​這個池。",
    memberNotEligibleDetail: "刪除此機器或選擇另一台永久機器。",
    resolvingTarget: "從這個池中選擇一台機器...",
    resolveEmpty: "該池沒有啟用的計算機。",
    resolveNoAvailable: "該池中目前沒有可用的機器。",
    resolvePresenceUnavailable: "機器可用性暫時未知。",
    resolveFailed: "Happier 無法從這個池中選擇一台機器。再試一次。",
    executionMachine: "執行於",
    chosenFrom: "選自",
    aMachinePool: "機器集區",
    availabilityKnown: ({ connected, enabled }: { connected: number; enabled: number }) => `${enabled} 台已啟用機器中有 ${connected} 台已連線`,
    fallback: ({ number }: { number: number }) => `後備 ${number}`,
};

const machinePoolTranslations = { zhHant };

return { machinePoolTranslations };
})();

const Domain_mcpSettingsTranslations = (() => {
type McpSettingsCopy = Shared_mcpSettingsTranslations.McpSettingsCopy;

const en = Shared_mcpSettingsTranslations.en;

const zhHant: McpSettingsCopy = {
    purpose: '你的代理在工作階段中可以呼叫的工具伺服器。新增一次伺服器，然後選擇它的適用範圍。',
    add: '新增 MCP 伺服器',
    addConfigure: '設定伺服器',
    addConfigureDescription: '輸入它的指令或位址',
    addImportJson: '貼上 JSON 設定',
    addImportJsonDescription: '來自 README 或其他應用程式',
    addOwnCategory: '自行新增',
    addPresetCategory: '快速安裝',
    addFromMachine: '從此機器匯入',
    addFromMachineDescription: '其他代理已在使用的伺服器',
    searchPlaceholder: '搜尋伺服器',
    toolsGroup: '工具',
    unbound: '尚未在任何地方使用',
    newServer: '新的 MCP 伺服器',
    serverPurpose: '你的代理可以呼叫的工具伺服器。在下方選擇它的適用範圍。',
    addByTitle: '新增方式',
    serverSection: '伺服器',
    serverSectionDescription: '伺服器在工作階段和此清單中的名稱。',
    connectionSection: '連線',
    connectionSectionDescription: 'Happier 如何啟動或連線到伺服器。',
    envDescription: '傳給伺服器的值。金鑰請使用已儲存的密鑰。',
    headersDescription: '隨每個請求傳送。權杖請使用已儲存的密鑰。',
    addRule: '新增規則',
    discardDraft: '捨棄',
    landingTitle: '為你的代理新增更多工具',
    landingDescription: 'MCP 伺服器可新增瀏覽器、文件查詢或 GitHub 等工具。你可以自行設定、貼上設定，或從預設開始。',
    onMachineTitle: '在此機器上找到',
    onMachinePurpose: '其他代理已在此機器上設定的 MCP 伺服器。匯入後即可在 Happier 中使用。',
    onMachineSearchSection: '搜尋位置',
    onMachineSearchDescription: '你主資料夾中的代理設定，以及你選擇的專案資料夾。',
    onMachineFoundSection: '伺服器',
    onMachineFoundDescription: '匯入會將伺服器複製到 Happier；原始設定不會改變。',
    previewTitle: '工作階段會取得什麼',
    previewPurpose: '查看某個代理和資料夾的工作階段會取得哪些 MCP 伺服器，以及伺服器無法啟動時會發生什麼。',
    previewContextSection: '工作階段',
    previewContextDescription: '新工作階段啟動時使用的代理和資料夾。',
    failurePolicyTitle: '伺服器無法啟動時',
    failurePolicyDescription: '例如，缺少它需要的已儲存密鑰。',
    failurePolicySkip: '略過它',
    failurePolicyStop: '停止工作階段',
    failureSection: '可靠性',
    failureSectionDescription: '適用於所有工作階段中的所有 MCP 伺服器。',
    previewNothingTitle: '不會提供任何伺服器',
    previewNothingDescription: '沒有適用於此代理和資料夾的 MCP 伺服器。請新增涵蓋它們的伺服器或規則。',
    check: '檢查',
    scan: '搜尋',
};

const mcpSettingsTranslations = { zhHant } as const;

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

const zhHant: DesktopTrayTranslation = {
    open: '打開 Happier',
    openInHappier: '在 Happier 中打開',
    settings: '設定…',
    startAtLogin: '登入時啟動',
    quit: '結束 Happier',
    stopServicesAndQuit: '停止背景服務並結束…',
    sessions: ({ count }: CountParams) => `${count} 個執行中`,
    start: '啟動',
    restart: '重新啟動',
    stop: '停止…',
    userOwned: '在 Happier 之外管理',
    checking: '正在檢查背景服務…',
    readFailed: '無法檢查背景服務',
    incomplete: '部分背景服務無法檢查',
    noServices: '這台電腦尚未設定',
    working: '正在處理…',
    stopConfirmTitle: ({ relay }: RelayParams) => `停止用於 ${relay} 的 Happier 背景服務？`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `這台電腦上為 ${relay} 執行的代理工作階段將結束，在服務再次啟動之前，你的手機和瀏覽器無法在那裡連到這台電腦。`,
    stopAllConfirmTitle: '停止 Happier 背景服務並結束？',
    stopAllConfirmBody: '這台電腦上的代理工作階段將結束，在其背景服務再次啟動之前，你的手機和瀏覽器無法連到這台電腦。',
    stopConfirmAction: '停止',
    actionFailedTitle: '操作未完成',
    loginItemFailed: '無法更新 Happier 的登入項目',
    quitStopTitle: '代理工作階段仍在執行',
    quitStopBody: '結束會停止這台電腦的背景服務，並結束在這裡執行的工作階段。',
    quitStopUnknownTitle: '停止背景服務？',
    quitStopUnknownBody: 'Happier 無法看到這台電腦上正在執行哪些工作階段。結束會停止其背景服務，並結束正在執行的工作階段。',
    quitStopConfirm: '仍然停止',
    quitStopKeep: '保持執行',
    quitStopFailedTitle: '部分背景服務未能停止',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier 會保持執行，方便你檢查背景服務並重試。`,
};

const zhHantLoginStart: DesktopLoginStartTranslation = {
    title: '登入時啟動',
    subtitle: '讓你的手機和瀏覽器可以連到這台電腦：背景服務會在登入時啟動，並在結束 Happier 後繼續執行。關閉後，結束 Happier 會停止這些服務。',
    unknown: 'Happier 暫時無法確定這台電腦的背景服務是否會在登入時啟動。',
    notSetUp: '設定好這台電腦後即可使用。',
};

const menuBarModeTranslations = { zhHant: { tray: zhHant, loginStart: zhHantLoginStart } };

return { menuBarModeTranslations };
})();

const Domain_nativePasswordTranslations = (() => {
const nativePasswordTranslations = { 'zh-Hant': {
        email: '電子郵件',
        password: '密碼',
        signIn: '登入',
        title: '電子郵件和密碼',
        forgotPassword: '忘記密碼？',
        capsLock: '大寫鎖定已開啟',
        emailRequired: '請輸入電子郵件地址。',
        passwordRequirements: '請使用至少15個字元，最多1,024個UTF-8位元組。允許空格。',
        unavailable: '此Home目前不支援電子郵件和密碼登入。',
        rateLimited: '嘗試次數過多。請稍候再試。',
        emailInvalid: '請輸入有效的電子郵件地址。',
        passwordMalformed: '此密碼包含無法安全儲存的字元。請重新輸入。',
        passwordMismatch: '兩次輸入的密碼不一致。',
        currentPasswordRequired: '請輸入目前的密碼。',
        currentPassword: '目前的密碼',
        newPassword: '新密碼',
        confirmPassword: '確認密碼',
        signInFailed: '此電子郵件與密碼的組合無法登入。',
        accountDisabledHere: '此帳戶已在該Home中停用。請聯絡Home管理員重新啟用。',
        notEligible: '此帳戶目前無法登入該Home。',
        linkExpired: '此連結已過期或已被使用。請重新取得。',
        revisionConflict: '你的密碼已在其他地方變更。請重新載入後再試。',
        serverUnavailable: '該Home無法完成此請求。請稍後再試。',
        offline: '無法連線到該Home。請檢查網路後重試。',
        homeUnreachable: '無法連線到該Home。請重試。',
        securityFactUnavailable: '無法從你的Home讀取。',
        cancelled: '該操作已取消。',
        approvalPending: '正在等待你的核准。請在核准收件匣中處理，然後返回此處。',
        outcomeUnconfirmed: '我們無法確認該變更是否已生效。我們已重新整理此帳戶，請先查看目前狀態再重試。',
        recoveryKeyRequired: '請輸入恢復金鑰以變更此端對端加密帳戶的密碼。金鑰僅保留在此裝置上。',
        working: '處理中…',
        showPassword: '顯示密碼',
        hidePassword: '隱藏密碼',
        createTitle: '建立你的帳戶',
        createAccount: '建立帳戶',
        accountProtection: '帳戶保護',
        protectionPlain: 'Home 可讀',
        protectionPlainDetail: '你的Home可以讀取你的資料。忘記密碼時可透過電子郵件重設。',
        protectionE2ee: '端對端加密',
        protectionE2eeDetail: '只有你的裝置可以讀取你的資料。請保存復原金鑰：僅重設密碼無法復原資料。',
        checkYourEmail: '請查收電子郵件',
        resend: '重新傳送',
        resent: '已重新傳送。請查收郵件。',
        useDifferentEmail: '改用其他電子郵件',
        connectTitle: '新增電子郵件和密碼',
        connectFromSecurity: '先使用你既有的方式登入，然後在「帳戶安全」中新增電子郵件和密碼。',
        signInFirst: '先登入',
        forgotTitle: '忘記密碼？',
        forgotExplanation: '我們可以透過電子郵件寄送重設說明，或者你可以使用建立帳戶時保存的復原金鑰。',
        emailResetInstructions: '將重設說明寄到我的信箱',
        useRecoveryKey: '使用復原金鑰',
        recoveryKeyDownload: '下載復原金鑰',
        recoveryKeyLater: '稍後再做',
        securitySectionTitle: '電子郵件和密碼',
        signInEmail: '登入電子郵件',
        signInEmailNotSet: '未設定',
        passwordEnrolled: '已設定',
        passwordNotEnrolled: '未設定',
        passwordSetUp: '已為此 Home 設定密碼。',
        passwordChanged: '密碼已變更。',
        passwordRemoved: '密碼已移除。',
        changePassword: '變更密碼',
        removePassword: '移除密碼',
        removePasswordSubtitle: '僅使用其他方式登入',
        removePasswordConsequence: '你將無法再以電子郵件和密碼登入該Home。其他登入方式與你的資料不受影響。',
        changeEmailExplanation: '我們會向新地址寄送確認郵件。在確認之前，目前的登入電子郵件仍然有效。',
        sendVerification: '寄送確認郵件',
        verifyTitle: '確認你的電子郵件',
        verifyGeneric: '此連結用於確認對某個信箱的控制權。',
        verifyReturnToCreate: '請返回該Home，使用此地址完成帳戶建立。',
        addressVerified: '該地址已確認。',
        confirmEmailChange: '設為我的登入電子郵件',
        signInToConfirm: '請在此裝置上登入以確認變更。',
        returnToSignIn: '返回登入',
        continue: '繼續',
        resetTitle: '設定新密碼',
        resetChooseNew: '為該Home選擇一個新密碼。',
        resetComplete: '密碼已變更。請使用新密碼重新登入。',
        resetSignsOutOtherDevices: '設定新密碼會使該帳戶在其他所有位置登出。',
        setNewPassword: '儲存新密碼',
        emailPlaceholder: 'you@example.com',
        accountDisabled: ({ home }: { home: string }) => `此帳戶已在 ${home} 中停用。請聯絡Home管理員重新啟用。`,
        verificationSent: ({ email }: { email: string }) => `我們已向 ${email} 寄出確認連結。請開啟連結以完成帳戶建立。`,
        resetInstructionsSent: ({ email }: { email: string }) => `如果 ${email} 可以在此登入，重設說明已在寄送途中。`,
        verificationPending: ({ email }: { email: string }) => `確認郵件已寄至 ${email}`,
        verifyDestination: ({ email }: { email: string }) => `此連結用於確認 ${email}。`,
        passwordNeedsEmail: '請先新增登入電子郵件',
        passwordNeedsEmailHint: '從登入電子郵件開始',
        setupStepConfirm: '確認',
        setupProgress: ({ step, total, label }: { step: number; total: number; label: string }) => `第 ${step} 步，共 ${total} 步：${label}`,
        setupEmailHint: '登入電子郵件和密碼會一起新增。我們會先寄送一個連結來確認該地址。',
        setupConfirmHint: '開啟該郵件中的連結來設定密碼。',
        setupPasswordHint: '輸入你已確認的電子郵件，然後設定密碼。',
    } } as const;

return { nativePasswordTranslations };
})();

const Domain_navigationPlacementTranslations = (() => {
type NavigationPlacementTranslation = Shared_navigationPlacementTranslations.NavigationPlacementTranslation;

const navigationPlacementTranslations = { 'zh-Hant': { customize: '自訂…', title: '導覽', description: '選擇保持顯示、放入「更多」或隱藏的項目。拖曳以排序。儲存在此裝置上。', pinned: '固定', overflow: '更多', hidden: '隱藏', reset: '重設', appRail: '左側欄', sessionRail: '工作階段側欄', workspaceRail: '工作區側欄', sessionTabBar: '手機分頁列' } } satisfies Pick<Record<string, NavigationPlacementTranslation>, "zh-Hant">;

return { navigationPlacementTranslations };
})();

const Domain_pendingNavigationTranslations = (() => {
type Count = Shared_pendingNavigationTranslations.Count;

const en = Shared_pendingNavigationTranslations.en;

const zhHant: typeof en = {
    nextWithCount: ({ count }) => `${count} 個工作階段需要你回應`,
    next: '下一個', answeredElsewhere: '已回應',
    unavailableTitle: '無法開啟下一個請求',
    unavailableBody: '部分等待中的工作階段無法使用。請重新連線後再試。',
    skippedUnavailable: ({ count }) => `已略過 ${count} 個無法使用的工作階段。`,
    waitsForPermission: '請求你的許可', waitsForInput: '在等你回答',
    sessionsWaiting: ({ count }) => `${count} 個工作階段在等待`, go: '前往', dismiss: '稍後',
};

const pendingNavigationTranslations = { zhHant };

return { pendingNavigationTranslations };
})();

const Domain_personalHomeBootstrapBlockedTranslations = (() => {
type PersonalHomeBootstrapBlockedTranslation = Shared_personalHomeBootstrapBlockedTranslations.PersonalHomeBootstrapBlockedTranslation;

const personalHomeBootstrapBlockedTranslations = { 'zh-Hant': {
        blocked: {
            runtime_unhealthy: '本地 Home 需要處理後才能啟動。',
            home_auth_invalid: '你的 Home 驗證需要處理。',
            existing_runtime: '繼續設定前，請選擇如何處理現有的本地 Home。',
            existing_runtime_credentials: '此本機 Home 屬於這台電腦上的另一個 Happier 應用程式。',
            personal_home_erased: '你的個人 Home 已被刪除。請重試以建立新的個人 Home。',
        },
        blockedBody: { personal_home_erased: '你的 Home 資料已被刪除。這裡沒有可復原的內容；請建立新的個人 Home 或使用其他 Home。' },
    } } as const satisfies Pick<Record<string, PersonalHomeBootstrapBlockedTranslation>, "zh-Hant">;

return { personalHomeBootstrapBlockedTranslations };
})();

const Domain_personalHomeDecisionTranslations = (() => {
type HomeParams = Shared_personalHomeDecisionTranslations.HomeParams;

type PersonalHomeDecisionTranslation = Shared_personalHomeDecisionTranslations.PersonalHomeDecisionTranslation;

const en = Shared_personalHomeDecisionTranslations.en;

const zhHant: PersonalHomeDecisionTranslation = {
    homeIdentityAmbiguous: '此個人 Home 位址對應多個已儲存的 Home。',
    signedInHome: {
        status: '你已經登入了另一個 Home。',
        body: ({ home }: HomeParams) => `這台電腦已登入 ${home}。你可以繼續使用它，也可以在這裡設定個人 Home。`,
        keep: ({ home }: HomeParams) => `繼續使用 ${home}`,
        keepDetail: '你的工作階段和機器都會保持原樣。',
        create: '設定個人 Home',
        createDetail: '在這台電腦上建立一個私人 Home 並切換過去。',
    },
    existingRuntimeCredentials: {
        body: '沒有該 Home 的復原金鑰，此應用程式無法開啟它。請使用金鑰登入，或使用其他 Home。',
        signIn: '使用復原金鑰登入',
        signInDetail: '使用為此本機 Home 儲存的復原金鑰。',
    },
};

const personalHomeDecisionTranslations = { zhHant };

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

const zhHant = {
    standardOnlyTitle: '透過 Home 位址連線',
    standardOnlySubtitle: '在此裝置上使用各個 Home 的位址，而不是點對點連線。',
    installOrUpdateAction: '安裝或更新個人 Home', startAction: '啟動個人 Home', stopAction: '停止個人 Home',
    defaultHomeLabel: '個人 Home', homeTitle: 'Home', canonicalAddress: 'Home 地址', identityComparison: '目前的 Home', identityComparisonMatch: '一致', identityComparisonMismatch: '不一致', identityComparisonUnknown: '無法確認',
    unknownSize: '大小未知', unknownTimestamp: '時間戳未知', restoreBackupTitle: '備份', identityTitle: 'Home 身分', identityUnavailable: '身分無法使用', restoreBackupDate: '建立時間', restoreCompatibility: '相容性', restoreCompatible: '相容', restoreCompatibilityVerified: '已由此版本驗證', restoreBackupSize: '大小', restoreReplacementNotice: '目前的 Home 資料將被取代。經驗證的復原備份將予以保留。', restoreConfirmTitle: '取代並復原此個人 Home？', restoreConfirmAction: '取代並復原', relocateConfirmTitle: '移動此個人 Home？', relocateConfirmBody: '經驗證的副本在目的地啟用前，目前的 Home 將會停止。', relocateDestination: '目的地', relocateConfirmAction: '移動 Home', recoverRestoreTitle: '要復原中斷的復原嗎？', recoverRestoreBody: '使用保留的復原資料回復中斷的復原。', recoverRestoreAction: '復原操作', eraseDataTitle: '要刪除個人 Home 資料嗎？', eraseHomeTarget: 'Home', eraseDataBody: '這與解除安裝不同，只會永久刪除以下已解析的 Home 路徑：', estimatedSize: '估計大小', summaryTitle: '個人 Home', footer: '你的 Home 會保留在此電腦上。這些操作不會變更其他 Home。', statusTitle: '狀態', notAvailable: '無法使用', storageTitle: '儲存空間', masterSecretTitle: 'Home 存取密鑰', masterSecretPresent: '存在', masterSecretUnavailable: '無法使用', inspectAction: '重新整理 Home 詳細資料', actionsTitle: '備份與還原', protectionTitle: '保護', backupsSectionFooter: '備份包含可讀取的對話、Home 資料、受信任裝置狀態及 Home 存取密鑰。請只將其儲存在你信任的位置。', lastBackupTitle: '上次備份', lastBackupUnknown: '上次備份未知', backupsTitle: '備份封存', backupAction: '立即備份', backupSubtitle: '建立並驗證純文字 Home 封存。', exportBackupAction: '匯出備份…', exportBackupSubtitle: '在你選擇的位置建立經驗證的備份。', verifyAction: '驗證備份…', verifySubtitle: '檢查封存而不復原。', restoreAction: '復原…', restoreSubtitle: '在取代 Home 資料前驗證備份。', relocateAction: '移動 Home…', relocateSubtitle: '將此 Home 移動到受管理的電腦。', relocationFinishAction: '完成移動', relocationReturnAction: '返回原始 Home', relocationFinishSubtitle: '驗證目的地後完成移動此 Home。', relocationReturnSubtitle: '保留原始 Home 作為使用中的位置。', recoverRestoreSubtitle: '可以明確回復中斷的復原。', restoreRecoveryWarningTitle: '復原需要修復', restoreRecoveryWarningBody: '復原狀態不明確。不會執行自動變更。請先查看診斷，再修復此 Home。', restoreCleanupWarningTitle: '復原清理需要注意', restoreCleanupWarningBody: 'Home 已復原，但自動清理尚未完成。請查看診斷資訊並重試 Home 操作。', backupVerified: '備份已驗證', backupNeedsAttention: '備份已驗證；Home 重新啟動需要注意', backupHomeReady: 'Home 已重新啟動', backupRevealAction: '顯示備份', restoreResultTitle: '復原結果', restoreOutcomeRecoveryRequired: '需要復原', restoreOutcomeRolledBack: '復原已回復', restoreOutcomeRestored: 'Home 已復原', advancedTitle: '進階', advancedFooter: '此電腦的執行環境控制與診斷。', restartAction: '重新啟動個人 Home', openDataLocationAction: '開啟 Home 資料位置', openLogsAction: '開啟執行環境記錄', removeProfileAction: '從 Happier 移除 Home', removeProfileSubtitle: '移除此設定檔；執行環境資料會保留在此電腦上。', removeProfileTitle: '要移除個人 Home 設定檔嗎？', removeProfileBody: '這會移除設定檔，但保留執行環境與資料。', uninstallRuntimeAction: '解除安裝執行環境，保留資料', uninstallRuntimeSubtitle: '移除服務與二進位檔；Home 資料會保留。', deleteHomeDataTitle: '刪除 Home 資料', removeSectionFooter: '解除安裝會保留 Home 資料。永久刪除是單獨確認的操作。', eraseDataAction: '永久刪除個人 Home 資料', eraseDataSubtitle: '與解除安裝分開。永久刪除已解析的 Home 資料。', eraseResultTitle: 'Home 資料已刪除', eraseStoppedHome: '執行中的 Home 已停止', eraseHomeAlreadyStopped: 'Home 已經停止', eraseRemainingPaths: '無法移除', progressTitle: '個人 Home 操作', dismissResult: '關閉',
    repairSearchAction: '重建 Home 搜尋',
    repairSearchSubtitle: '依據此 Home 的對話重新建立搜尋索引。',
    repairSearchCompleteTitle: 'Home 搜尋已重建',
    repairSearchCompleteBody: '搜尋索引已依據此 Home 的對話重新建立。',
    backupCleanupRequired: '備份安全；請刪除詳細資料中顯示的受保護暫存路徑',
    backupCleanupPath: '待刪除的受保護暫存路徑',
    backupCleanupError: '清理錯誤',
    backupDestinationMismatch: '備份未在所選目的地建立。未刪除任何內容。',
    backupDestinationUnsafe: '所選備份目的地位於將被刪除的個人 Home 資料內部。未刪除任何內容。',
    eraseInspectionAttention: 'Home 資料已刪除；驗證需要處理',
    searchTitle: '搜尋',
    searchReady: '就緒',
    searchIndexing: '正在建立索引…',
    searchUnavailable: '無法使用',
    localOnlyIngressTitle: '僅能從這台電腦存取',
    localOnlyIngressBody: '公開分享、提供者回呼、外掛 Webhook，以及這台電腦睡眠期間的通知，在此 Home 可從外部存取之前都無法使用。',
} satisfies PersonalHomeSettingsCopy;

const backupDisclosureBody = { zhHant: '此備份包含可讀取的對話、Home 資料、Home 存取密鑰和受信任裝置狀態。任何能復原完整封存的人都可以執行此 Home 的複本。請將其儲存在你信任的位置。' } as const;

const eraseBackupOffer = { zhHant: { title: '要先備份此 Home 嗎？', body: '刪除 Home 資料後無法復原。請先建立經過驗證的備份，或在沒有備份的情況下繼續。', continueWithoutBackup: '不備份並繼續' } } as const;

const operationOutcome = { zhHant: {
        erasePartialTitle: '部分 Home 資料無法刪除',
        eraseOutcomeSummary: ({ removed, remaining }) => `已刪除 ${removed} 項`
            + (remaining > 0 ? `；${remaining} 項無法刪除` : ''),
        eraseNotPerformed: '未刪除任何內容',
        eraseBlockedBackupMismatch: '此備份來自另一個 Home。',
        eraseBlockedIdentityUnknown: 'Happier 無法確認此備份屬於此 Home。',
        eraseVerificationDetail: '驗證',
        operationFailed: '此 Home 操作未完成。開啟詳細資料查看發生了什麼事。',
        restorePreviousDataTitle: '已儲存先前的資料',
    } } as const satisfies Pick<Record<string, OperationOutcomeCopy>, "zhHant">;

const personalHomeSettingsTranslations = { zhHant: { ...zhHant, ...operationOutcome.zhHant, backupDisclosureBody: backupDisclosureBody.zhHant, eraseBackupOfferTitle: eraseBackupOffer.zhHant.title, eraseBackupOfferBody: eraseBackupOffer.zhHant.body, eraseContinueWithoutBackup: eraseBackupOffer.zhHant.continueWithoutBackup } } as const;

return { backupDisclosureBody, eraseBackupOffer, operationOutcome, personalHomeSettingsTranslations };
})();

const Domain_personalizeTranslations = (() => {
type PersonalizeTranslation = Shared_personalizeTranslations.PersonalizeTranslation;

const en = Shared_personalizeTranslations.en;

const pluralPl = Shared_personalizeTranslations.pluralPl;

const pluralRu = Shared_personalizeTranslations.pluralRu;

const zhHant: PersonalizeTranslation = {
    cardTitle: '個人化 Happier',
    cardSubtitle: '六個快速選擇，每項都能即時預覽。',
    cardAction: '個人化',
    cardContinue: '繼續',
    cardProgress: ({ saved, total, step }) => `已儲存 ${saved}/${total} 項選擇。從「${step}」繼續。`,
    cardProgressReview: ({ saved, total }) => `已儲存 ${saved}/${total} 項選擇。檢查一下你的設定。`,
    inPlaceTitle: '打造你的 Happier',
    inPlaceBody: '六個快速選擇，每項都能即時預覽。先從觀感開始——你選擇時首頁會隨之變化。',
    inPlaceContinue: ({ count }) => `繼續 · 還剩 ${count} 項`,
    notNow: '暫不',
    flowTitle: '個人化 Happier',
    finishLater: '稍後完成',
    later: '稍後',
    stepEyebrow: ({ n, total, name }) => `第 ${n} 步，共 ${total} 步 · ${name}`,
    stepCounter: ({ n, total }) => `${n}/${total}`,
    styleEyebrow: '選用',
    summaryEyebrow: '全部就緒',
    previewNote: '預覽。按下「下一步」之前不會儲存任何內容。',
    previewNoteSummary: '你目前的工作區。',
    next: '下一步',
    review: '檢查',
    useThisSetup: '使用此設定',
    saveFailed: '此步驟未儲存。你的選擇仍保持選取。',
    tryAgain: '重試',
    skipThisStep: '略過此步驟',
    scopeThisDevice: '此裝置',
    scopeAllDevices: '你的所有裝置',
    stepsLabel: '步驟',
    savedStepsNote: ({ count }) => `已儲存 ${count} 個步驟。`,
    lookName: '觀感',
    lookTitle: '看起來舒服',
    lookDescription: '淺色、深色或跟隨系統，以及應用程式顯示多少玻璃效果。',
    themeLabel: '主題',
    glassLabel: '玻璃',
    glassAutoDescription: '整個應用程式使用分層玻璃',
    glassEverywhereDescription: '各處一致的玻璃',
    glassSolidDescription: '所有介面皆不透明',
    glassCustomNote: '你已在「外觀」中調整過玻璃。選擇預設即可取代，也可以保留你的設定。',
    customizeInAppearance: '在「外觀」中自訂…',
    styleName: '風格',
    styleTitle: '從一種風格開始',
    styleDescription: '每種風格決定工作階段的閱讀方式和列表的外觀。它只會預先填入後續步驟：在每一步按下「下一步」之前不會儲存任何內容。',
    styleKeep: '保留目前設定',
    styleActivity: '活動',
    styleConversation: '對話',
    styleDetail: '詳細',
    styleCustomTag: '自訂',
    styleDefaultTag: 'Happier 預設',
    styleChanges: ({ style, count }) => `「${style}」會變更 ${count} 項設定`,
    styleNoChanges: '這已經是你的設定。',
    styleNever: '主題、通知、隱私權和代理權限永遠不屬於風格的一部分。',
    was: ({ value }) => `原為 ${value}`,
    conversationName: '對話',
    conversationTitle: '跟上對話',
    conversationDescription: '工作階段中的回合和代理的思考如何呈現。',
    layoutLabel: '版面配置',
    thinkingLabel: '思考',
    toolsName: '工具呼叫',
    toolsTitle: '查看代理做了什麼',
    toolsDescription: '指令、編輯和讀取在工作階段中如何顯示。',
    toolsLabel: '工具呼叫',
    toolTapLabel: '點擊工具時',
    toolDetailLabel: '工具詳細資料',
    toolDetailDefault: '預設',
    toolDetailFull: '完整',
    workName: '你的工作',
    workTitle: '找到你的工作',
    workDescription: '工作階段列表的整理方式，以及每列顯示多少資訊。',
    listLayoutLabel: '工作階段列表',
    rowsLabel: '列',
    attentionName: '待處理',
    attentionTitle: '留意需要你的事項',
    attentionDescription: '等待你處理或可供檢查的工作階段在列表中的位置。',
    attentionLabel: '需要你的工作階段',
    attentionHomeNote: '首頁一律顯示需要你處理的內容。這裡只會變更工作階段列表。',
    notificationsName: '通知',
    notificationsTitle: '隨時掌握動態',
    notificationsDescription: '你在看其他內容時，此裝置會通知你什麼。',
    notificationsAllowed: '此裝置已允許通知。',
    notificationsNotAllowed: 'Happier 暫時無法在此裝置上顯示通知。',
    notificationsUnsupported: '此裝置不支援通知。請在桌面應用程式或手機上設定。',
    scopeLook: '主題僅用於此裝置 · 玻璃效果用於所有裝置',
    notificationsNeedsYouSummary: '需要你',
    notificationsFinishedSummary: '已完成',
    notificationsAllow: '允許通知',
    notificationsTellMe: '在以下情況通知我',
    notificationsNeedsYou: '工作階段需要核准或回答',
    notificationsFinished: '工作階段完成本回合',
    notificationsShowLabel: '通知顯示',
    notificationsShowDescription: '指令、問題和回覆可能會出現在鎖定畫面上。',
    notificationsMessage: '訊息內容',
    notificationsStatus: '僅狀態',
    notificationsPhoneNote: 'Happier 關閉時手機上的提醒需要在手機上設定。',
    notificationsOff: '不通知',
    sampleNeedsYouTitle: '審查 #2481 需要你處理',
    sampleNeedsYouBody: '代理想在 ~/happier 中執行 yarn test:e2e。允許嗎？',
    sampleReadyTitle: '「修正不穩定的重新連線測試」可以檢查了',
    sampleReadyBody: '找到了：重試計時器從未被清除。已修正，測試通過。',
    sampleStatusBody: '開啟 Happier 查看。',
    sampleSessionReconnect: '修正不穩定的重新連線測試',
    sampleSessionCraft: '打磨實驗室',
    sampleSessionReview: '審查 #2481',
    sampleSessionPricing: '定價頁面文案',
    sampleSessionDocs: '文件搜尋索引',
    sampleWorking: '工作中',
    sampleNeedsYou: '需要你',
    sampleReady: '可供檢查',
    summaryTitle: '這是你的設定',
    summaryDescription: ({ changed }) => changed === 0
        ? '以下內容皆已儲存。沒有任何變更。'
        : `以下內容皆已儲存。變更了 ${changed} 項選擇，其餘維持不變。`,
    summaryChange: '變更',
    summaryFooter: '你可以稍後在設定中變更這些內容，或從「設定 → 外觀」重新走一遍。',
    replayTitle: '個人化 Happier',
    replaySubtitle: '六個快速選擇，每項都能即時預覽。',
    replayAction: '開始',
    journeyHandoff: '打造專屬於你',
};

const personalizeTranslations = { 'zh-Hant': zhHant } satisfies Pick<Readonly<Record<string, PersonalizeTranslation>>, "zh-Hant">;

return { personalizeTranslations };
})();

const Domain_phoneNavigationTranslations = (() => {
const en = Shared_phoneNavigationTranslations.en;

const zhHant: typeof en = {
    phoneNav: {
        settings: {
            sectionDescription: '工作階段內的手機版面，以及列上的手勢。每個手勢都可以單獨關閉。',
            swipeSidewaysTitle: '左右滑動切換工作階段',
            swipeSidewaysScrollsDescription: '在列上切換到上一個或下一個。當工具放不下時，滑動會改為捲動工具。',
            swipeSidewaysAlwaysDescription: '在列上切換到上一個或下一個。一律是滑動；放不下的工具會收進「更多」。',
            alwaysSwipeTitle: '一律在工作階段間滑動',
            alwaysSwipeOnDescription: '列會保留放得下的工具，其餘收進「更多」。',
            alwaysSwipeOffDescription: '關閉：多出的工具會讓列捲動。',
            dragUpTitle: '向上拖曳切換',
            dragUpDescription: '向上拖曳列，查看已開啟的分頁和最近的工作階段，然後滑到想去的一個。',
            dragUpSourceTitle: '向上拖曳顯示',
            dragUpSourceRecentDescription: '已開啟的分頁，然後是你最近在此裝置上開啟的內容。',
            dragUpSourceListDescription: '依清單順序排列的工作階段。',
            swipeSourceTitle: '左右滑動顯示',
            swipeSourceListDescription: '清單中的下一個或上一個工作階段。',
            swipeSourceRecentDescription: '依上次開啟時間排列的下一個或上一個。',
            sourceRecent: '最近',
            sourceList: '工作階段清單',
            flickTitle: '上下快速滑動切換',
            flickDescription: '快速一滑即可開啟下一個或上一個。',
            holdToDockTitle: '按住以保持切換器開啟',
            holdToDockDescription: '按住列，放開後輕點選擇。',
            pullAllTabsTitle: '下拉標題查看所有分頁',
            pullAllTabsDescription: '向下拖曳工作階段標題，查看所有已開啟的分頁和最近的工作階段。',
        },
        bar: {
            onTheBar: '列上',
            more: '更多',
            heldInMore: '「一律滑動」開啟時收在「更多」中',
            keepOnBar: '保留在列上',
            removeFromBar: '從列中移除',
            openFiles: '開啟檔案',
        },
        allTabs: {
            title: '所有分頁',
            pullHint: '下拉查看所有分頁',
            releaseHint: '放開查看所有分頁',
            openTabs: '已開啟的分頁',
            openTabsSynced: '已開啟的分頁 · 已同步',
            recent: '最近',
            recentOnThisDevice: '此手機上的最近',
            here: '此處',
            panes: ({ count }: { count: number }) => `${count} 個窗格`,
            emptyTitle: '沒有其他已開啟的內容',
            emptyDescription: '你開啟的工作階段和保留的分頁會顯示在這裡，最近的在前。',
            openTab: ({ title }: { title: string }) => `開啟 ${title}`,
        },
        rail: {
            label: '已開啟的分頁',
            synced: '已同步',
            syncedA11y: '已開啟的分頁會在你的裝置間同步',
            notAvailableTitle: '在此手機上無法使用',
            notAvailableUnknown: '此分頁是在另一台裝置上開啟的，這支手機無法顯示。它在那裡仍保持開啟。',
            closeTab: '關閉分頁',
            paneOf: ({ position, total }: { position: number; total: number }) => `第 ${position} 個，共 ${total} 個`,
            nextPane: '下一個窗格',
            chatPane: 'Chat',
        },
        switcher: {
            title: '切換到',
            allSessions: '所有工作階段',
            openTabs: '已開啟的分頁',
            synced: '已同步',
            recent: '最近',
            recentOnThisDevice: '此手機上的最近',
            sessions: '工作階段',
            nextInSessions: '工作階段中的下一個',
            previousInSessions: '工作階段中的上一個',
            furtherBack: '更早',
            moreRecent: '更近',
            here: '此處',
            stayOn: '留在',
            noOlderSessions: '沒有更早的工作階段',
            noNewerSessions: '沒有更新的工作階段',
            lastInSessions: '這是工作階段中的最後一個。',
            firstInSessions: '這是工作階段中的第一個。',
            nothingFurtherBack: '再往前沒有了。',
            mostRecent: '這是最近的一個。',
            nothingToSwitch: '沒有其他已開啟的內容',
            nothingToSwitchDescription: '你開啟的工作階段會顯示在這裡，最近的在前。',
            draft: ({ text }: { text: string }) => `你的草稿：「${text}」`,
            switchSessionAction: '切換工作階段',
            switchedTo: ({ name }: { name: string }) => `已切換到 ${name}`,
            close: '關閉',
            positionOf: ({ position, total }: { position: number; total: number }) => `第 ${position} 個，共 ${total} 個`,
        },
    },
};

const phoneNavigationTranslations = { 'zh-Hant': zhHant };

return { phoneNavigationTranslations };
})();

const Domain_pluginAccountDataEraseTranslations = (() => {
const english = Shared_pluginAccountDataEraseTranslations.english;

const pluginAccountDataEraseTranslations = { 'zh-Hant': {
    accountDataErase: {
        installedGroupTitle: '帳戶數據',
        installedGroupFooter: '這僅影響目前帳戶的保留資料。它不會從任何計算機上卸載此插件。',
        installedEntryTitle: '刪除帳戶數據',
        installedEntrySubtitle: '從目前帳戶中永久刪除此插件的保留資料。',
        orphanedGroupTitle: '保留的插件數據',
        orphanedGroupFooter: '刪除插件後，使用插件 ID 刪除保留的帳戶資料。',
        orphanedEntryTitle: '刪除保留的插件數據',
        orphanedEntrySubtitle: '輸入已安裝或已刪除的插件 ID 以永久刪除其目前帳戶資料。',
        promptTitle: '插件ID',
        promptBody: '輸入您想要從目前帳戶中刪除其保留資料的插件的 ID。',
        promptPlaceholder: 'com.example.plugin',
        invalidTitle: '輸入插件 ID',
        invalidBody: '在繼續之前請使用準確的插件 ID。',
        confirmTitle: '刪除帳戶插件資料？',
        confirmBody: ({ pluginId }: { pluginId: string }) => `這將永久刪除保留的數據 ${pluginId} 從目前帳戶。它不會從您的電腦上卸載插件。`,
        confirm: '刪除數據',
        completedTitle: '帳戶外掛程式資料已刪除',
        completedChanged: '保留的插件資料已從目前帳戶中刪除。',
        completedEmpty: '在目前帳戶中找不到此外掛程式的保留插件資料。',
        partialTitle: '一些插件數據仍然存在',
        partialBody: '有些保留的資料無法刪除。沒有什麼會自動重試；重試刪除剩餘資料。',
        failedTitle: '插件資料未刪除',
        failedBody: '保留的資料無法刪除。檢查目前帳戶連線後重試。',
        unavailableTitle: '插件資料不可用',
        unavailableBody: '目前帳戶已更改或不可用。帳戶準備就緒後重新開啟此操作。',
    },
} } as const;

return { pluginAccountDataEraseTranslations };
})();

const Domain_pluginAccountReleaseSelectionTranslations = (() => {
const english = Shared_pluginAccountReleaseSelectionTranslations.english;

const completeReleaseSelection = Shared_pluginAccountReleaseSelectionTranslations.completeReleaseSelection;

const localizedPluginAccountReleaseSelectionTranslations = { 'zh-Hant': {
    accountReleaseSelection: {
        groupTitle: '帳戶釋放',
        groupFooter: '為此帳戶選擇確切的版本。這不會在任何電腦上安裝、更新或信任該插件。',
        entryTitle: '用於此帳戶',
        entrySubtitle: ({ version }: { version: string }) => `選擇版本 ${version} 對於目前帳戶，無需更改任何電腦安裝。`,
        selectedTitle: '已選擇帳戶釋放',
        selectedBody: '所選的插件版本現在將用於此帳戶。',
        conflictTitle: '帳戶發布已更改',
        conflictBody: '在此操作開放期間，帳戶發布發生了變化。重新打開它並重試。',
        unavailableTitle: '帳戶無法釋放',
        unavailableBody: '目前帳戶無法取得確切的版本或其所需的遷移來源。帳戶準備就緒後重試。',
        rejectedTitle: '未選擇帳戶釋放',
        rejectedBody: '該帳戶不接受此版本選擇。檢查帳戶狀態並重試。',
        hostedGroupFooter: '管理此帳戶為該插件託管的插件產物。目前沒有電腦提供此版本，因此無法在這裡選擇。',
        hostedEnableTitle: '為此帳戶託管插件產物',
        hostedEnableBody: "將此插件的介面和套件資源儲存在帳戶伺服器上。對於明文帳戶，伺服器可以讀取這些資料；對於 E2EE 帳戶，伺服器儲存加密資料。版本中繼資料仍然可見。這不會安裝或信任插件，也不會讓離線電腦能夠執行插件。",
        hostedDisableTitle: '停止託管插件產物',
        hostedStatusDisabled: "已停用。啟用託管後，即使來源電腦離線，也可下載此版本的插件產物。",
        hostedStatusPending: '已啟用。此版本正在等待主機發布其確切的插件產物。',
        hostedStatusReady: '此確切版本的託管插件產物已可使用。',
        hostedRemoveTitle: '停用託管並移除產物',
        hostedRemoveBody: '停止帳戶託管並移除此版本確切的託管插件產物。清理本機快取是獨立的操作。',
        hostedClearCacheTitle: '清除本機產物快取',
        hostedClearCacheBody: '移除此確切版本在本機快取的介面產物位元組，不會變更帳戶託管。',
    },
} } as const;

const pluginAccountReleaseSelectionTranslations = { 'zh-Hant': completeReleaseSelection(localizedPluginAccountReleaseSelectionTranslations['zh-Hant']) };

return { localizedPluginAccountReleaseSelectionTranslations, pluginAccountReleaseSelectionTranslations };
})();

const Domain_pluginInvocationLogTranslations = (() => {
const en = Shared_pluginInvocationLogTranslations.en;

const zhHant = {
    invocationLogs: {
        title: '呼叫記錄',
        footer: '來自所選外掛程式機器的有限且已遮蔽記錄。',
        correlationFilter: '關聯 ID 篩選器',
        correlationFilterAll: '此外掛程式的所有呼叫',
        correlationPromptTitle: '依關聯 ID 篩選',
        correlationPromptBody: '只顯示一次精確外掛程式呼叫的記錄。留空可顯示所有記錄。',
        correlationPromptPlaceholder: '關聯 ID',
        refresh: '重新整理記錄',
        follow: '追蹤記錄',
        stopFollowing: '停止追蹤',
        loadMore: '載入後續記錄',
        loadingTitle: '正在載入呼叫記錄',
        loadingSubtitle: '正在讀取所選機器中有限且已遮蔽的記錄。',
        idleTitle: '呼叫記錄已可讀取',
        idleSubtitle: '重新整理以讀取所選機器中有限且已遮蔽的記錄。',
        emptyTitle: '沒有呼叫記錄',
        emptySubtitle: '此所選機器上沒有相符的已遮蔽記錄。',
        unavailableTitle: '呼叫記錄無法使用',
        unavailableSubtitle: '所選外掛程式機器無法使用或已不再是目前的機器。',
        readerUnavailableSubtitle: '所選外掛程式機器目前無法提供呼叫記錄。',
        selectionRequiredTitle: '選擇外掛程式機器',
        selectionRequiredSubtitle: '請先在上方選擇一個相容的外掛程式具現化版本，再讀取其記錄。',
        conflictTitle: '解決所選外掛程式機器的問題',
        conflictSubtitle: '請先在上方選擇一個相容的外掛程式具現化版本，再讀取其記錄。',
        errorTitle: '無法載入呼叫記錄',
        errorSubtitle: '記錄讀取未完成。所選機器可用後請再試一次。',
        noMessage: '外掛程式記錄事件',
        level: {
            debug: '偵錯',
            info: '資訊',
            warn: '警告',
            error: '錯誤',
            diagnostic: '診斷',
        },
    },
};

const pluginInvocationLogTranslations = { 'zh-Hant': zhHant } as const;

return { pluginInvocationLogTranslations };
})();

const Domain_pluginMachineMatrixTranslations = (() => {
const english = Shared_pluginMachineMatrixTranslations.english;

const pluginMachineMatrixTranslations = { 'zh-Hant': {
        machineMatrix: {
            title: '在你的機器上',
            footer: '唯讀。安裝、更新以及其他所有外掛操作都會在上面選取的機器上執行。',
            empty: '尚未有任何機器為此帳戶回報外掛安裝。',
            unavailable: '帳戶外掛可用性尚未載入，因此機器狀態未知。',
            incomplete: ({ count }: { count: number }) => `此清單可能不完整：還有 ${count} 台伺服器尚未回報其機器。`,
            summary: ({ installed, total }: { installed: number; total: number }) => `在 ${total} 台機器中的 ${installed} 台上已安裝且為最新`,
            lastObserved: ({ ago }: { ago: string }) => `最後一次出現：${ago}`,
            state: {
                installedCurrent: '已安裝且為最新',
                disabled: '已停用',
                untrusted: '不受信任',
                incompatible: '版本不同',
                localOnly: '僅限本機',
                staleOffline: '最後已知狀態，機器離線',
                absent: '未安裝',
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

const marketplacePresentation = { 'zh-Hant': {
        diagnosticsIssueTitle: '外掛問題', diagnosticsRecovery: '查看上方詳情，修正後重新載入外掛或重新整理此頁面。', diagnosticsTechnicalCode: ({ code }: { code: string }) => `技術代碼：${code}`,
        discover: { publisherLabel: ({ displayName, id }: { displayName: string; id: string }) => `發布者標籤：${displayName}（${id}）`, categories: ({ values }: { values: string }) => `類別：${values}`, runtimeSummary: ({ realms, platforms }: { realms: string; platforms: string }) => `執行位置：${realms} · 平台：${platforms}`, reviewStatus: { curated: '精選推薦', unreviewed: '未經審核', withdrawn: '已撤回' }, executableRealm: { daemon: '背景服務', client: '應用程式', hostedWeb: '託管網頁' }, platform: { darwin: 'macOS', linux: 'Linux', windows: 'Windows', web: '網頁', ios: 'iOS', android: 'Android' }, diagnostic: { title: '市集來源問題', recovery: '重新整理「探索」。如果問題持續，請檢查「來源與登錄檔」。', unreachableTitle: ({ source }: { source: string }) => `無法連線至 ${source}`, behindTitle: ({ source }: { source: string }) => `${source} 回傳的資料較舊或不完整`, indexTitle: '外掛索引不完整', otherSourcesShown: '其他來源的結果仍會顯示。' } },
    } } as const;

const localizedTechnicalReviewVocabulary = { 'zh-Hant': { source: ({ kind, locator }: { kind: string; locator: string }) => `${kind}：${locator}`, sourceKind: { path: '本機路徑', archive: '封存檔案', npm: 'npm 套件' }, marketplaceSource: ({ kind, source }: { kind: string; source: string }) => `${kind}：${source}`, marketplaceSourceKind: { curated: '精選目錄', 'community-npm': '公共 npm 目錄', user: '使用者目錄' }, executableRealm: { daemon: '背景服務程式碼', reactNative: '應用程式介面程式碼', hostedWeb: '隔離的託管網頁程式碼' }, uiArtifacts: ({ status, ids }: { status: string; ids: string }) => `${status}：${ids}`, uiArtifactStatus: { verified: '已驗證介面資源', none: '沒有介面資源', unavailable: '介面資源無法使用' }, authorizationClass: { cooperativeDisclosure: '協作式揭露', hostResourceSelection: '選定的主機資源', presentIntentOrOs: '目前意圖或系統權限' }, priority: ({ priority }: { priority: number }) => `優先順序 ${priority}` } } as const;

const localizedReviewVocabulary = { 'zh-Hant': {
        installReviewSections: {
            ...localizedTechnicalReviewVocabulary['zh-Hant'],
            archiveUrlRetention: 'Happier 會將完整的封存檔 URL（包括其中的憑證）儲存在所選機器上，用於日後更新。URL 過期或遭撤銷可能導致更新失敗。',
            trustedCodeTitle: '受信任的程式碼', trustedCodeDisclosure: '外掛會以受信任程式碼的形式在 Happier 內執行，並不在沙箱中。除了下方列出的由 Happier 中介的服務之外，外掛還可以直接使用本應用程式本身的權限——檔案、網路、環境與程序。下方的清單是外掛所宣告的內容，也是你之後可以關閉的內容，而不是限制其程式碼可觸及範圍的界線。', identity: '身分與套件', evidence: '技術證據', executableCode: '可執行程式碼與擴充項目', requiredAccess: '必要的主機存取權', optionalAccess: '選用的主機存取權', requestInterceptors: '要求攔截器', rawCredentials: '原始憑證存取聲明', compatibility: '相容性與更新', none: '未聲明任何內容', scope: ({ scope }: { scope: string }) => `範圍：${scope}`, developmentPath: ({ locator }: { locator: string }) => `${locator} · 開發版本`, publisherUnverified: ({ displayName, id }: { displayName: string; id: string }) => `${displayName} · ${id} · 未驗證`, integrityBasis: { expected: ({ integrity }: { integrity: string }) => `${integrity}（預期值）`, observed: ({ integrity }: { integrity: string }) => `${integrity}（觀測值）` }, signatureStatus: { verified: ({ keyId }: { keyId: string }) => `已驗證登錄檔簽章：${keyId}`, unsupported: ({ keyId }: { keyId: string }) => `不支援的登錄檔簽章：${keyId}` }, provenanceDeclaredUnverified: ({ predicateType }: { predicateType: string }) => `已聲明但未驗證：${predicateType}`, provenanceRetrievedUnverified: ({ predicateTypes }: { predicateTypes: string }) => `已取得但未驗證：${predicateTypes}`, provenanceUnavailable: ({ code }: { code: string }) => `來源證明無法使用：${code}`, curationUnreviewed: ({ sourceId }: { sourceId: string }) => `未經審閱的目錄來源：${sourceId}`, curationApproved: ({ sourceId, reviewedAt, reason }: { sourceId: string; reviewedAt: string; reason: string }) => `由 ${sourceId} 於 ${reviewedAt} 審閱${reason}`, savedSecret: '已儲存的密鑰', connectedAccount: '已連結的帳戶', secretKinds: ({ kinds }: { kinds: string }) => `密鑰類型：${kinds}`, connectedAccountService: ({ service }: { service: string }) => `服務：${service}`, credentialPurpose: ({ purpose }: { purpose: string }) => `用途：${purpose}`, credentialUse: ({ realm, phase }: { realm: string; phase: string }) => `在${realm}的${phase}階段使用`, credentialAccess: ({ access }: { access: string }) => `存取內容：${access}`, credentialRequestHeaders: ({ origin, headers }: { origin: string; headers: string }) => `傳送到 ${origin} 的請求標頭：${headers}`, credentialRequestEnvironment: ({ keys }: { keys: string }) => `環境變數：${keys}`, credentialRequestFiles: ({ files }: { files: string }) => `檔案：${files}`, realm: { web: '網頁端', ios: 'iOS 客戶端', android: 'Android 客戶端', daemon: '背景服務' }, phase: { settings: '設定', prepare: '準備', connection: '連線', speech: '語音' }, runtimeApi: ({ version }: { version: number }) => `執行階段介面 ${version}`,
        },
        sourceAdministration: { title: '來源與登錄檔', subtitle: '選擇這台機器從何處探索確切的 npm 套件，以及如何存取對應的登錄檔。', communityTitle: '公共 npm 目錄', communitySubtitle: '內建 · 在公共 npm 中探索符合條件的 Happier 外掛，而非任意 npm 套件；結果未經審閱。', configuredTitle: '市集來源', configuredEmpty: '未設定其他市集來源。', add: '新增來源', edit: '編輯來源', remove: '移除來源', removeTitle: '要移除市集來源嗎？', removeBody: ({ name }: { name: string }) => `${name} 將不再用於這台機器上的探索。已安裝的外掛不會變更。`, sourceUrl: '來源位址', displayName: '顯示名稱', description: '選填說明', enabled: '已啟用', disabled: '已停用', curated: '精選來源', user: '你的來源', loadError: '無法載入市集來源。', retry: '重試', operationFailed: '無法套用此變更。請檢查機器連線後再試一次。', operationOutcomeUnknownTitle: '變更需要審閱', operationOutcomeUnknownBody: '所選機器可能已套用此變更，但 Happier 無法確認結果。請先檢視重新整理後的設定，再重新變更。' },
        updatePolicy: { title: '更新規則', target: ({ machine, server }: { machine: string; server: string }) => `透過 ${server} 套用於 ${machine}。`, pinned: '固定版本', pinnedSubtitle: '在選擇其他規則前不要更新。', allowed: '允許更新', allowedSubtitle: '明確更新無需再次確認，除非聲明的權限擴大。' },
    } } as const;

const pluginMarketplaceDiscoverTranslations = { 'zh-Hant': {
        ...localizedReviewVocabulary['zh-Hant'],
        ...marketplacePresentation['zh-Hant'],
        secretFieldActions: { delete: '刪除已儲存的密鑰', deleteHint: '徹底清除已儲存的值，無法復原。', unbind: '從此外掛移除', unbindHint: '解除此設定與已儲存密鑰的關聯，密鑰本身會保留。' },
        pluginChangeOutcomeUnknownTitle: '結果未確認',
        pluginChangeOutcomeUnknownBody: ({ action, name, machine, server }: { action: string; name: string; machine: string; server: string }) => `Happier 無法確認 ${name} 的${action}是否已在 ${machine}（${server}）上完成。請先在該機器上查看已安裝清單及其目前版本，然後再重試。`,
        updateFromInstalledRecordSubtitle: '透過此安裝紀錄自己的受信任更新通道進行升級。',
        discover: {
            ...marketplacePresentation['zh-Hant'].discover,
            status: {
                loading: '正在搜尋所有市集來源…',
                loadingSource: ({ source }: { source: string }) => `正在搜尋 ${source}…`,
                results: ({ count, sources }: { count: number; sources: number }) =>
                    `來自 ${sources} 個來源的 ${count} 個外掛`,
                empty: '沒有外掛符合此搜尋。',
                error: ({ message }: { message: string }) => `無法重新整理探索結果：${message}`,
                errorTitle: '無法重新整理探索結果',
                stale: '這些結果對應先前的搜尋。請重新搜尋以套用上方的設定。',
                partial: ({ count }: { count: number }) =>
                    `有 ${count} 個來源回傳了較舊或缺少的資料，結果可能不完整。`,
                nonInstallable: ({ count }: { count: number }) =>
                    `找到 ${count} 個項目，但目前無法安裝到這台機器上。`,
            },
            sourceFreshness: {
                stale: '比這個來源更舊',
                'stale-offline': '最後已知結果，來源離線',
                unavailable: '來源無法使用',
                'auth-unavailable': '這個來源需要登入',
                corrupt: '無法讀取來源索引',
            },
            nonInstallableReason: {
                sourceStale: '它的市集來源不是最新的。',
                artifactUnavailable: '以這台機器的登錄檔存取權無法取得它的套件。',
                notApproved: '尚未核准從這個來源安裝。',
                unsupportedSourceKind: '此版本的 Happier 不支援這種來源類型。',
            },
            installSubtitle: ({ source }: { source: string }) =>
                `在信任任何來自 ${source} 的內容之前，請先審閱這個外掛宣告的全部內容。`,
            registrySelectionRequired: ({ origin }: { origin: string }) => `需要 ${origin} 的登錄檔設定`,
            registrySelection: {
                title: ({ name }: { name: string }) => `為 ${name} 選擇登錄檔`,
                body: ({ name, origin, source }: { name: string; origin: string; source: string }) =>
                    `${name} 發布在 ${origin}。請選擇 ${source} 在此機器上使用的登錄檔設定，或新增一個並登入。在「安裝並信任」審查之前不會下載任何內容。`,
                continue: '繼續',
            },
        },
    } } as const;

return { marketplacePresentation, localizedTechnicalReviewVocabulary, localizedReviewVocabulary, pluginMarketplaceDiscoverTranslations };
})();

const Domain_pluginPermissionTranslations = (() => {
type PermissionDetailsTranslation = Shared_pluginPermissionTranslations.PermissionDetailsTranslation;

const pluginPermissionTranslations = { 'zh-Hant': {
        fields: {
            pluginId: '外掛 ID',
            capability: '功能',
            scope: '範圍',
            requester: '請求者',
            authority: '授權來源',
            requestedAt: '請求時間',
            reason: '原因',
        },
        scope: { account: '帳戶', project: '專案', workspace: '工作區' },
        requester: { user: '使用者', host: '主機', plugin: '外掛' },
        authority: { bundled: '內建', machineInstallation: '機器安裝' },
        identifiers: {
            session: '工作階段',
            request: '請求',
            machine: '機器',
            installation: '安裝',
        },
        accessibilitySummary: ({ details }) => `權限請求詳細資料。${details}`,
    } } as const satisfies Pick<Readonly<Record<string, PermissionDetailsTranslation>>, "zh-Hant">;

return { pluginPermissionTranslations };
})();

const Domain_pluginSettingsPresentationTranslations = (() => {
const english = Shared_pluginSettingsPresentationTranslations.english;

const pluginSettingsPresentationTranslations = { 'zh-Hant': {
        rowStatus: { enabled: '已啟用', disabled: '已停用', incompatible: '不相容', trustRemoved: '已撤銷信任', needsAttention: '需要處理' },
        developmentPhase: { observing: '正在監看', preparingDependencies: '正在準備相依項目', compiling: '正在編譯', validating: '正在驗證', active: '作用中', retainedIncumbent: '上一版本仍在執行', unavailable: '無法使用' },
        rowSource: { bundled: 'Happier 內建', npm: 'npm 套件', archive: '封存檔案', localPath: '本機資料夾', other: '已設定來源' },
        rowAttention: { trustRemoved: '此外掛程式已不再執行。重新安裝即可再次信任其程式碼。', incompatible: '此版本無法在所選電腦上執行。' },
        developerGroupTitle: '開發',
        developerGroupFooter: '在所選電腦上建置外掛程式，並查看其背景服務的回報。',
        developerDevelopmentSubtitle: '從你自己的資料夾建立、編輯、測試與打包外掛程式。',
        developerDiagnosticsSubtitle: '所選電腦的背景服務與目錄診斷。',
        detailMissingTitle: '所選電腦上沒有這個外掛程式',
        detailMissingBody: ({ pluginId }: { pluginId: string }) => `${pluginId} 未安裝在這裡。它可能已被解除安裝，或位於另一台電腦上。`,
        detailMissingRetry: '重新檢查',
        surfaces: {
            purpose: '為 Happier 新增介面、命令和整合。外掛程式會在你的電腦上以受信任的程式碼執行。',
            navigationTitle: '外掛程式',
            updatesTitle: '更新',
            moreDescriptionInSettings: '外掛程式從哪裡來、建立你自己的外掛程式，以及這台電腦回報的內容。這些頁面會在設定中開啟。',
            fix: '修正',
            allSources: '所有來源',
            shelfCurated: '精選',
            shelfCuratedDescription: '經 Happier 審核並推薦。每次安裝仍會顯示完整審核。',
            shelfCommunity: '社群',
            shelfCommunityDescription: '未經審核的 npm 套件。「安裝並信任」會準確顯示每個套件可以存取的內容。',
            shelfUser: '你的來源',
            shelfUserDescription: '來自這台電腦上新增的市集來源的項目。',
            manage: '管理',
            installed: '已安裝',
            notShownTitle: '部分內容無法顯示',
            listingInstallsOn: ({ machine }: { machine: string }) => `將安裝在 ${machine} 上。執行任何內容之前，你會先審核它的存取權限。`,
            listingChooseMachine: '在頁首選擇一台電腦來安裝此外掛程式。',
            listingRunsIn: '執行於',
            listingPlatforms: '平台',
            listingSource: '來源',
            listingCategories: '類別',
            listingNotFoundTitle: '此項目無法使用',
            listingNotFoundBody: '它可能已從來源中移除，或這台電腦目前無法連線到該來源。',
            developmentSourcesTitle: '開發中的外掛程式',
            chooseMachineInstalled: '在頁首選擇一台電腦以查看它的外掛程式。',
            chooseMachineBrowse: '在頁首選擇一台電腦以瀏覽它可以安裝的外掛程式。',
            openAsPage: '以頁面開啟',
            detailInstalledLabel: '已安裝的外掛程式',
            detailListingLabel: '外掛程式詳情',
            viewLabel: '顯示方式',
            viewGrid: '網格',
            viewList: '列表',
            installedSearchPlaceholder: '搜尋已安裝的外掛程式',
            statusFilterLabel: '顯示外掛程式',
            statusAll: '全部外掛程式',
            statusEnabled: '已啟用',
            statusDisabled: '已停用',
            statusAttention: '需要處理',
            noMatch: ({ query }: { query: string }) => `沒有與「${query}」相符的外掛程式`,
            clearSearch: '清除',
            emptyTitle: '尚未安裝外掛程式',
            emptyBody: '外掛程式為你的代理程式新增面板、命令和工具。先從 Happier 推出的外掛程式開始吧。',
            browsePlugins: '瀏覽外掛程式',
            browseEmpty: '你的來源中暫時沒有可用的外掛程式。',
            forDevelopers: '開發人員',
            readFailedTitle: '無法讀取這台電腦的外掛程式',
            readFailedBody: '沒有任何變更。重試以再次詢問這台電腦。',
            lastKnown: ({ status }: { status: string }) => `上次已知 · ${status}`,
            machinesTitle: '電腦',
            machinesDescription: '此外掛程式的安裝位置。',
            machinesCurrent: ({ current, total }: { current: number; total: number }) => `在 ${total} 台電腦中的 ${current} 台上為最新`,
            onMachines: ({ count }: { count: number }) => `在 ${count} 台機器上`,
            onMachine: ({ machine }: { machine: string }) => `在 ${machine} 上`,
            addedGroup: '已新增',
            machinesRetained: '已不在此帳戶中的電腦',
            open: '開啟',
            review: '查看',
            seeAll: '查看全部',
            allResults: '全部結果',
            categoriesLabel: '類別',
            runOnNoneChosen: '未選擇機器',
            runOnNoneAvailable: '暫無可執行它的機器',
            runsEverywhere: '在每台執行 Happier 的機器上',
            kinds: {
                agent: '智慧體',
                providers: '模型供應方',
                scmHostingProviders: '程式碼託管',
                scmBackends: '版本控制',
                voice: '語音',
                connectedAccounts: '已連接服務',
                inputTypes: '輸入類型',
                mcp: 'MCP 工具',
                pluginUi: '應用程式面板',
                pluginBrowser: '瀏覽器檢視',
                composer: '編輯器工具',
            },
        },
    } } as const;

return { pluginSettingsPresentationTranslations };
})();

const Domain_pluginUpdateReviewTranslations = (() => {
const en = Shared_pluginUpdateReviewTranslations.en;

const zhHant = {
    title: '更新審核',
    confirmSubtitle: '會擴大你所授予存取權限的更新會先詢問你。',
    autoApplySubtitle: '即使存取權限擴大，更新也會直接套用，不再詢問。',
    confirmOption: '先詢問',
    autoApplyOption: '自動',
};

const pluginUpdateReviewTranslations = { zhHant: zhHant };

return { pluginUpdateReviewTranslations };
})();

const Domain_pluginWebhookAdministrationTranslations = (() => {
const english = Shared_pluginWebhookAdministrationTranslations.english;

const pluginWebhookAdministrationTranslations = { 'zh-Hant': {
    webhookAdministration: {
        title: '插件網路鉤子',
        footer: '帳戶端點、確切的電腦目標、傳送佇列和死信復原。此處從未顯示交付屍體。',
        unavailableTitle: '外掛程式 Webhook 無法使用',
        unavailableSubtitle: '此伺服器尚未啟用外掛程式 Webhook 接收。',
        endpointsTitle: 'Webhook 端點',
        emptyTitle: '沒有外掛 webhook 端點',
        emptySubtitle: '由已安裝插件建立的端點將在此處保持可見，包括目標不可用的端點。',
        loadError: '無法載入 Webhook 狀態。',
        endpointSubtitle: ({ readiness, routing, sourceInstanceId }: { readiness: string; routing: string; sourceInstanceId: string }) => `${readiness} · ${routing} · ${sourceInstanceId}`,
        targetSubtitle: ({ machineId, materializationId, status }: { machineId: string; materializationId: string; status: string }) => `${machineId} / ${materializationId} · ${status}`,
        queueSubtitle: ({ queued, retrying, claimed, deadLetter }: { queued: number; retrying: number; claimed: number; deadLetter: number }) => `排隊 ${queued} ·重試 ${retrying} · 聲稱 ${claimed} · 死信 ${deadLetter}`,
        copyUrl: '複製網路鉤子 URL',
        selectTarget: '選擇配送目標',
        retarget: '重定向端點',
        retargetUnavailable: '在重定向此端點之前選擇一個可用的精確插件實作。',
        originSelected: '當您繼續時，將重新檢查所選的確切插件實作。',
        originUnavailable: '沒有選擇確切的可用插件實作。',
        movePendingTitle: '移動待交付的貨物？',
        movePendingBody: '將排隊的死信傳遞移至新的確切目標？積極聲稱的交付量仍保持在當前目標。',
        resumePendingMove: '恢復待交付移動',
        resumePendingMoveSubtitle: ({ count }: { count: number }) => `${count} 排隊或死信傳遞仍然使用先前的確切目標。`,
        configureCredential: '配置簽名憑證',
        rotateCredential: '輪換簽名憑證',
        finishRotation: '完成憑證輪換',
        finishRotationSubtitle: '立即停止接受先前的憑證。',
        credentialSecretTitle: '儲存新的簽名秘密',
        credentialSecretBody: ({ secret }: { secret: string }) => `這個秘密只顯示一次。在關閉此訊息之前保存它。\n\n${secret}`,
        revoke: '撤銷端點',
        revokeTitle: '撤銷 webhook 端點？',
        revokeBody: '到此端點的新交付將被拒絕。根據保留策略，現有的交付元資料仍然可用。',
        operationFailed: 'Webhook 操作未完成。重試之前刷新目前狀態。',
        deliveryTitle: ({ digest }: { digest: string }) => `死信 ${digest}`,
        deliveryStatus: '交貨狀態',
        deliverySubtitle: ({ errorCode, attempts, replays, machineId, materializationId }: { errorCode: string; attempts: number; replays: number; machineId: string; materializationId: string }) => `${errorCode} · ${attempts} 嘗試· ${replays} 重播· ${machineId} / ${materializationId}`,
        unresolvedAutomationAdmissionTitle: ({ totalCount }: { totalCount: number }) => `${totalCount} 未解決的自動化招生`,
        unresolvedAutomationAdmissionSubtitle: ({ sample, omittedCount }: { sample: string; omittedCount: number }) => `樣品： ${sample} · ${omittedCount} 未顯示`,
        replay: '重播傳送',
        discardTitle: '放棄送貨？',
        discardBody: '加密或明文儲存的傳遞正文將被刪除且無法恢復。',
    },
} } as const;

return { pluginWebhookAdministrationTranslations };
})();

const Domain_profilesPageTranslations = (() => {
const english = Shared_profilesPageTranslations.english;

const translated = Shared_profilesPageTranslations.translated;

const profilesPageTranslations = { 'zh-Hant': translated({
        profilesPage: {
            searchPlaceholder: "搜尋啟動設定檔",
            emptyTitle: "尚無啟動設定檔",
            newProfileTitle: "新啟動設定檔",
            notFoundTitle: '此設定檔已不存在',
            notFoundDescription: '它可能已在另一台裝置上被刪除。',
            backToProfiles: "返回啟動設定檔",
            discardDraft: '捨棄',
            detailDescription: '新工作階段使用此設定檔啟動時生效。',
            builtInDetailDescription: '預設設定檔。儲存變更會建立你自己的副本。',
            enabledHint: '為新工作階段選擇設定檔時提供。',
            pickerSection: '設定檔選擇',
            pickerSectionDescription: '啟動工作階段時此選項出現的位置。',
            showFirst: '優先顯示',
            showFirstDescription: '在收藏中顯示機器環境。',
            environmentDescription: '使用此設定檔啟動工作階段時設定的環境變數。值可以參照機器上的變數。',
            descriptionTitle: '描述',
            descriptionHint: '選填。選擇此設定檔時顯示。',
            modelRequiresAgent: '請先選擇偏好的代理，再選擇其模型。',
        },
    }) };

return { profilesPageTranslations };
})();

const Domain_providerCollectionTranslations = (() => {
type ProviderCollectionCopy = Shared_providerCollectionTranslations.ProviderCollectionCopy;

const en = Shared_providerCollectionTranslations.en;

const zhHant: ProviderCollectionCopy = {
    settingsProvidersCollection: {
        gateway: {
            railGroup: '閘道',
            managedFromConnectedServices: '在「已連線的服務」中管理',
            description: '讓任何代理都能使用你的訂閱。',
            statusUnavailable: ({ machine }: { machine: string }) => `無法使用 · ${machine} 已離線`,
            offlineTitle: ({ machine }: { machine: string }) => `${machine} 已離線`,
            offlineDescription: ({ gateway, machine }: { gateway: string; machine: string }) => `在 ${machine} 恢復連線或你在下方選擇其他電腦之前，工作階段無法使用 ${gateway}。不會改用其他方式。`,
            modelsFromTitle: '模型來源',
            modelsFromDescription: '此閘道使用的訂閱。為每個訂閱選擇一個帳號或帳號池；它們不會混用。',
            slotUnused: ({ service }: { service: string }) => `此閘道不提供 ${service} 模型。`,
            slotConnect: ({ service }: { service: string }) => `連線 ${service} 帳號後即可在此使用。`,
            connect: '連線',
            runsOnTitle: '執行位置',
            runsOnDescription: '工作階段需要時閘道在哪裡啟動。請求仍會傳送到上方的訂閱。',
            runsOnSession: '每個工作階段所在的電腦',
            runsOnChosen: '指定的電腦',
            runsOnSessionDescription: '每台電腦一個閘道，由該電腦上的所有工作階段共用。',
            runsOnChosenDescription: '在你選擇的電腦上執行一個閘道。你其他電腦上的工作階段透過 Happier 連線到它。',
            computerTitle: '電腦',
            computerChoose: '選擇電腦',
            computerChooseDescription: '選擇閘道執行的位置。',
            computerOnline: '線上 · 尚未從你的其他電腦檢查',
            computerOnlineReachable: '線上 · 你的其他電腦可以連線',
            computerOnlineUnreachable: '線上 · 你的其他電腦無法連線',
            computerOffline: '離線',
            computerGone: '已不再是你的電腦',
            modelPickerTitle: '模型選擇器',
            showInPickerGateway: '閘道預設關閉，以免相同的模型出現兩次。仍可透過「執行通道」使用。',
            modelsAvailable: ({ count }: { count: number }) => `${count} 個可用`,
            helperTitle: 'Claude Code 輔助模型',
            helperDescription: 'Claude Code 會把次要任務交給快速、預設和最強三個模型。請選擇此閘道上各自使用的模型。指定了模型的代理定義會維持不變。',
            helperFast: '快速',
            helperDefault: '預設',
            helperStrongest: '最強',
            helperSameAsSession: '與工作階段相同',
            detailsTitle: '詳細資料',
            whatToKnow: '須知',
            whatToKnowTitle: '在內建應用程式之外使用你的訂閱',
            whatToKnowDescription: '這些訂閱背後的服務不支援這種用法。請求可能被拒絕，條款也可能變更。Happier 只會把請求傳送到上方選定的帳號或帳號池。',
            useExternalEndpoint: '改用外部端點',
            poolSectionTitle: '在其他代理中使用',
            poolSectionDescription: ({ agents }: { agents: string }) => `${agents} 直接登入此帳號池。其他代理透過閘道使用相同的帳號。`,
            poolSectionDescriptionGeneric: '使用此服務登入的代理直接使用此帳號池。其他代理透過閘道使用相同的帳號。',
            poolSwitchVia: ({ gateway }: { gateway: string }) => `透過 ${gateway}`,
            poolSwitchDescription: ({ service }: { service: string }) => `其他代理可以使用此帳號池中的 ${service} 模型。`,
            poolSwitchHeldBy: ({ gateway, current, service }: { gateway: string; current: string; service: string }) => `目前 ${gateway} 的 ${service} 模型使用 ${current}。`,
            poolSwitchNeedsComputer: '需要你的一台電腦在線上才能變更。',
            poolReplaceTitle: ({ gateway, pool }: { gateway: string; pool: string }) => `將 ${gateway} 切換到 ${pool}？`,
            poolReplaceDescription: ({ pool, service, current }: { pool: string; service: string; current: string }) => `其他代理中的新工作階段將使用 ${pool} 提供 ${service} 模型。${current} 會保留其帳號，執行中的工作階段繼續使用啟動時的設定。`,
            poolReplaceConfirm: '切換',
            compareNative: ({ agents }: { agents: string }) => `在 ${agents} 中`,
            compareNativeGeneric: '使用內建登入',
            compareOther: '在其他代理中',
            compareRunsThrough: '執行通道',
            compareOwnSignIn: ({ service }: { service: string }) => `${service} 內建的登入`,
            compareSupported: ({ service }: { service: string }) => `${service} 官方支援`,
            compareSupportedYes: '是',
            compareSupportedNo: '否。實驗性功能；請求可能被拒絕',
            compareLimits: '額度',
            compareLimitsNative: '此帳號池的額度',
            compareLimitsShared: '相同的額度，共用',
        },
        connectionDescription: '已儲存到你的帳戶，在每台電腦上都可使用。',
        apiKeySavedDescription: '以已儲存的密鑰保管，不會再次顯示。',
        modelsShownCount: ({ count }: { count: number }) => `顯示 ${count} 個`,
        showInPickerTitle: '在模型選擇器中顯示',
        showInPickerDirect: ({ provider }: { provider: string }) => `直連提供者預設開啟。${provider} 的模型會出現在每個能執行它們的代理中。`,
        showInPickerManyModels: '提供大量模型的提供者預設關閉。仍可透過「執行通道」使用。',
        showInPickerLocal: '在你電腦上執行的模型預設開啟。',
        showInPickerAction: '在選擇器中顯示',
        onThisComputerTitle: '在這台電腦上',
        onThisComputerNoComputer: '未選擇電腦。選擇一台以測試此連線或變更存取方式。',
        endpointAccessTitle: '端點存取',
        endpointAccessDirect: ({ machine, host }: { machine: string; host: string }) => `${machine} 直接存取 ${host}。`,
        endpointAccessDirectValue: '直連',
        localRuntimeTitle: '本機執行環境',
        onMachine: ({ machine }: { machine: string }) => `在 ${machine} 上`,
        onAComputerTitle: '在電腦上',
        localNoComputer: '選擇一台電腦，查看其上執行的模型伺服器。',
        localOfflineDetail: '無法檢查其模型伺服器。',
        localNoneFound: '這裡沒有找到模型伺服器。',
        invitationAccountDescription: '連接一次提供者，它的模型就會出現在每個能執行它們的代理中。開始時不需要電腦。',
        subscriptionsPointerLead: 'Claude 和 ChatGPT 等訂閱位於',
        subscriptionsPointerLink: '已連線服務',
        subscriptionsPointerTail: '中。',
        addTitle: ({ provider }: { provider: string }) => `新增 ${provider}`,
        addDescription: ({ provider }: { provider: string }) => `新增金鑰後，${provider} 的模型會出現在每個能執行它們的代理中。`,
        addKeyDescription: '以已儲存的密鑰保存在你的帳戶中。',
        connectedTitle: ({ provider }: { provider: string }) => `${provider} 已連接`,
        connectedHiddenCountDescription: ({ provider, count }: { provider: string; count: number }) => `${count} 個模型已就緒。由於 ${provider} 列出的許多模型你可能已經擁有，它們預設不在選擇器中顯示。可隨時透過「執行通道」選擇，或全部顯示。`,
        connectedHiddenDescription: ({ provider }: { provider: string }) => `由於 ${provider} 列出的許多模型你可能已經擁有，它的模型預設不在選擇器中顯示。可隨時透過「執行通道」選擇，或全部顯示。`,
        description: '連接一次模型來源，即可在所有相容的代理中使用其模型。',
        foundOn: ({ machine }: { machine: string }) => `在 ${machine} 上發現`,
        foundOnThisMachine: '在此機器上發現',
        connect: '連接',
        start: '啟動',
        test: '測試',
        addProvider: '新增供應商',
        customEndpoint: '自訂端點',
        menuOwnCategory: '自己的',
        menuCatalogCategory: '來自目錄',
        newTitle: '新供應商',
        emptyDescription: '從目錄新增供應商，或新增你自己的相容端點。',
        machineScopeLabel: '設定於',
        invitationTitle: '使用你自己的模型',
        invitationDescription: '連接一次供應商，其模型就會出現在所有相容代理的模型選擇器中。Ollama 等本機伺服器在你的機器上執行。',
        invitationNeedsMachine: '供應商在你的某台機器上連接和檢查。請先新增一台機器。',
        setUpMachine: '設定機器',
        duplicateAsCustom: '複製為自訂供應商',
        discard: '捨棄',
        enabled: '已啟用',
        enabledDescription: '在代理的模型選擇器中提供其模型',
        saved: '已儲存',
        replace: '取代',
        addKey: '選擇金鑰',
        apiKeyDefaultDescription: '除非某台機器有自己的金鑰，否則在所有機器上使用。',
        apiKeyMachineDescription: '在此機器上代替預設金鑰使用。',
        availabilityTitle: '可用範圍',
        availabilityDescription: '代理可以在哪裡使用此供應商。',
        modelsDescription: '選擇代理在模型選擇器中提供哪些模型。',
        modelsShown: ({ shown, total }: { shown: number; total: number }) => `${total} 個中的 ${shown} 個顯示在模型選擇器中`,
        modelsFilter: ({ count }: { count: number }) => `篩選 ${count} 個模型`,
        connectionTitle: '連線',
        nameDescription: '顯示在提供者清單與模型選擇器中。',
        nameRequired: '請新增名稱。',
        nameTooLong: ({ max }: { max: number }) => `請使用不超過 ${max} 個字元。`,
        managedTitle: '託管的本機服務',
        endpointsTitle: '端點',
        endpointsDescription: '留空則使用供應商提供的位址。',
        overridesDescription: '請求的去向。可以為所有機器或僅為此機器變更位址。',
        afterSavingTitle: '儲存後',
        destinationDescription: 'Happier 傳送此供應商請求的位置。',
        destinationPending: '填寫所有端點後顯示。',
    },
};

const providerCollectionTranslations = { 'zh-Hant': zhHant } as const;

return { providerCollectionTranslations };
})();

const Domain_providerSessionTranslations = (() => {
const providerSessionTranslations = { zhHant: {
        launchDefaultLabel: ({ provider }: { provider: string }) => `供應商：${provider}`,
        launchNamedLabel: ({ provider, connection }: { provider: string; connection: string }) => `供應商：${provider} · ${connection}`,
        changedTitle: '供應商設定已變更', changedBody: ({ provider, connection }: { provider: string; connection: string }) => `此工作階段仍在使用啟動時的 ${provider} · ${connection} 設定。`,
        unavailableTitle: '供應商已無法使用', unavailableBody: ({ provider, connection }: { provider: string; connection: string }) => `${provider} · ${connection} 已無法用於恢復此工作階段。`,
        disabledTitle: '供應商已關閉', disabledBody: ({ provider, connection }: { provider: string; connection: string }) => `請先啟用 ${provider} · ${connection}，再恢復此工作階段。`,
        incompatibleTitle: '供應商已不再相容', incompatibleBody: ({ provider, connection }: { provider: string; connection: string }) => `${provider} · ${connection} 已不再相容此工作階段的代理程式。`,
        restartAction: '重新啟動工作階段', chooseModelAction: '選擇模型',
    } } as const;

return { providerSessionTranslations };
})();

const Domain_reviewWalkthroughTranslations = (() => {
type Count = Shared_reviewWalkthroughTranslations.Count;

type ReviewWalkthroughTranslations = Shared_reviewWalkthroughTranslations.ReviewWalkthroughTranslations;

const en = Shared_reviewWalkthroughTranslations.en;

const zhHant: ReviewWalkthroughTranslations = {
    severityCount: ({ count, severity }) => `${count} ${severity}`,
    findingRefA11y: ({ label, title }) => `${label}：${title}。前往該發現`,
    tag: { noFile: '無檔案', outdated: '已過時', unplaced: '無法定位', notInStory: '不在任何步驟中' },
    outdatedSummary: '審查之後程式碼已變更。',
    askAboutFindingA11y: ({ title }) => `詢問該發現：${title}`,
    tailTitle: '未連結到步驟的發現',
    tailDescription: '保留在這裡，以免在無法定位其程式碼行時遺失。',
    inContext: '已在脈絡中',
    fromReviewAt: ({ time }) => `來自 ${time} 的審查`,
    reviewLabel: '審查：',
    enginesOf: ({ count, total }) => `${total} 個中的 ${count} 個`,
    enginesFinished: '引擎已完成',
    enginesRunning: ({ count }) => `${count} 個引擎仍在審查`,
    fromEngines: ({ engines, inStory }) => `來自 ${engines} · ${inStory} 條在導讀中`,
    and: '和',
    inStoryElsewhere: ({ inStory, elsewhere }) => `${inStory} 條在導讀中，${elsewhere} 條在其他位置`,
    allInStory: '全部在導讀中',
    seeded: {
        title: '在審查之後由新的執行寫成。',
        body: ({ reviewers, time }) => `講述者沒有審查程式碼；這裡引用的每條發現都來自 ${time} 的 ${reviewers}。`,
        changed: ({ count }) => `此後有 ${count} 個檔案變更。`,
    },
    findingsFrom: ({ count, engine }) => `來自 ${engine} 的 ${count} 條發現`,
    publishedBefore: ({ time }) => `於 ${time} 發布，早於導讀`,
    steps: {
        reviewing: '正在審查',
        engineProgress: ({ done, running }) => `${done} 已完成 · ${running} 正在審查`,
        reviewed: ({ count }) => `已審查 · ${count} 條發現`,
        reviewedShort: ({ count }) => `已審查 · ${count}`,
        engineReviewed: ({ engine, count }) => `${engine} · ${count} 條發現`,
        reviewedAt: ({ time }) => `${time} 已審查`,
        reviewAt: ({ time }) => `${time} 的審查`,
        partial: ({ count }) => `部分審查 · ${count} 條發現`,
        ready: '導讀已就緒',
        readyShort: '導讀',
        failed: '導讀失敗',
        narrating: '正在講述',
        narratorWriting: ({ narrator }) => `${narrator} 正在撰寫`,
        writing: '正在撰寫導讀',
        writingShort: '正在撰寫',
    },
    writingWithFindings: '正在結合發現撰寫導讀…',
    dialog: {
        engines: '審查引擎',
        selected: ({ count }) => `已選擇 ${count} 個`,
        loadingEngines: '正在尋找審查引擎…',
        noEngines: '此工作階段的機器上沒有可執行的審查引擎。',
        findingsOnly: '僅發現',
        changes: '變更',
        instructions: '說明',
        instructionsPlaceholder: '審查應關注什麼？',
        defaultInstructions: '請從正確性、風險與缺少的測試等方面審查這些變更。',
        alsoWalkthrough: '同時撰寫導讀',
        alsoWalkthroughBody: '發現產生後，同一次執行會結合這些發現撰寫導讀。不會重複讀取變更。',
        narrator: '講述者',
        chooseNarrator: '選擇講述者',
        narratorSeveral: ({ count }) => `${count} 個引擎進行審查；由一個模型根據它們的全部發現撰寫導讀。`,
        narratorFindingsOnly: ({ engine }) => `${engine} 只回傳發現，不回傳文字。由模型據此撰寫導讀。`,
        noNarrator: '這些引擎都無法撰寫導讀。請新增一個模型引擎，或關閉導讀。',
        footerReviewThenWalkthrough: '先審查，再撰寫導讀',
        footerHandover: ({ reviewer, narrator }) => `${reviewer} 審查 · ${narrator} 撰寫`,
    },
    generated: {
        continues: ({ model }) => `${model} · 延續審查`,
        seeded: ({ model }) => `${model} · 根據審查的發現`,
        handover: ({ narrator, engine }) => `${narrator}，根據 ${engine} 的發現`,
    },
    partial: {
        failed: ({ engines }) => `${engines} 的審查未完成。`,
        notClean: '這是部分審查，並不代表沒有問題。',
        finishedWith: ({ engines, count }) => `${engines} 已完成，共 ${count} 條發現。`,
        retry: ({ engine }) => `重試 ${engine}`,
    },
    explain: { action: '解釋這些發現', running: '正在解釋發現', a11y: '在導讀中請求解釋這些發現', unknownModel: '未知模型', requester: { user: '使用者', agent: '代理', plugin: '外掛', automation: '自動化', workflow: '工作流程', unknown: '未知請求者' }, header: ({ model, time, requester = '你' }) => `審查說明 · ${model} · 由${requester}在 ${time} 請求 · 不是結論` },
    finished: {
        title: '審查完成',
        openFindings: '開啟發現',
        walkMeThrough: '帶我看一遍',
        andMore: ({ count }) => `還有 ${count} 條`,
        continues: '延續這次審查執行：審查者根據已讀內容撰寫，不會重新分析。',
        narrates: ({ count }) => `審查執行已結束。新的執行將根據這 ${count} 條發現與變更撰寫導讀，不會再次審查。`,
    },
    started: {
        transcript: ({ engineCount, fileCount }) => `已開始審查 · ${engineCount} 個引擎 · ${fileCount} 個檔案`,
        notStarted: ({ engines }) => `${engines} 未啟動。其他引擎正在審查。`,
        narrationFailed: '審查已啟動，但無法請求導讀。發現仍會送達。',
    },
};

const reviewWalkthroughTranslations = { 'zh-Hant': { reviewWalkthrough: zhHant } };

return { reviewWalkthroughTranslations };
})();

const Domain_rolesTranslations = (() => {
type RolesTranslations = Shared_rolesTranslations.RolesTranslations;

const rolesTranslations = { 'zh-Hant': {
        rail: {
            chooseEngine: '選擇引擎',
            unavailableRole: '已無法使用',
            label: '角色',
            title: '角色',
            searchPlaceholder: '搜尋角色…',
            empty: '還沒有角色。',
            emptyWithManage: '還沒有角色。可在「管理角色」中新增。',
            footer: '角色自帶指令、引擎和執行方式，因此工作流程可以隨處使用。',
            manage: '管理角色',
            engineAppliesOnStart: '啟動此角色時才會使用其引擎',
            defaultEngine: '預設代理',
            activeAccessibilityLabel: '角色，正在使用某個角色',
        },
        builtIn: {
            orchestrator: "主導一項工作，並把部分交給其他代理",
            planner: "在動手之前先擬定計畫",
            builder: "完成修改並確認它能正常運作",
            reviewer: "審查修改並指出需要修正之處",
            judge: "裁定有爭議的發現，並判斷目標是否達成",
            second_opinion: "繼續之前的一次獨立檢查",
            scout: "瀏覽程式碼並回答東西在哪裡",
            approval_reviewer: "處理低風險的權限請求，其餘交給你決定",
        },
        settings: {
            duplicate: '建立副本',
            duplicateName: ({ name }) => `${name} 副本`,
            platformDefault: '平台預設 · 隨更新變動',
            runsAsThisSession: '此工作階段',
            runsAsOrchestratorDescription: '協調者就是你開啟它的那個工作階段。',
            readOnly: '唯讀',
            engineChooseMigrated: '0.2 沒有帶來引擎。請選擇一個，否則將使用你的預設代理。',
            description: '誰來做每一類工作。工作流程和編排者請求一個角色；角色決定如何執行。',
            count: ({ count }) => `${count} 個角色`,
            newRole: '新角色',
            groupBuiltIn: '內建',
            groupYours: '你的',
            groupShared: '與你共用',
            groupPlugins: '來自外掛',
            edited: '已修改',
            sourceBuiltIn: '內建',
            sourceYours: '你的',
            sourceShared: '與你共用',
            sourcePlugin: ({ plugin }) => `來自 ${plugin}`,
            migrated: '來自 0.2 子代理',
            migratedNote: ({ names }) => (names.length === 1 ? `${names[0]} 來自你的 0.2 子代理指引：其描述成為指令，其代理和模型成為引擎。` : `${names.join('、')} 來自你的 0.2 子代理指引：各自的描述成為指令，代理和模型成為引擎。`),
            nameTitle: '名稱',
            newRoleName: '未命名角色',
            instructionsTitle: '指令',
            instructionsDescription: '它做什麼、何時使用以及如何回報。代理分派工作時會讀取這些內容。',
            resetToDefault: '恢復預設',
            readOnlyNote: '原始角色是唯讀的。在此自訂你的指令；重設可還原原始內容。',
            howItRunsTitle: '執行方式',
            engineTitle: '引擎',
            engineDescription: '代理、模型和推理強度。',
            engineFollowsDefault: '跟隨你的預設代理。',
            engineUnavailable: '此處無法使用。請選擇引擎。',
            runsAsTitle: '執行於',
            runsAsSession: '工作階段',
            runsAsBackgroundRun: '背景執行',
            runsAsSessionDescription: '一個你可以開啟並引導的工作階段。',
            runsAsBackgroundDescription: '在背景執行並回報；沒有可引導的工作階段。',
            handsOffTitle: '只委派',
            handsOffDescription: '負責規劃和委派；自己不編輯檔案。',
            secondOpinionTitle: '第二意見',
            secondOpinionDescription: '「建議」會讓它在提出拉取請求或宣告完成前考慮徵求第二意見。',
            secondOpinionOff: '關閉',
            secondOpinionEncouraged: '建議',
            enabledTitle: '可用',
            enabledDescription: '在角色列中和向編排者提供。',
            advancedTitle: '進階',
            launchProfileTitle: '啟動設定檔',
            launchProfileDescription: '環境、權限、機器',
            launchProfileNone: '無',
            profileUnavailable: '設定檔無法使用',
            previewTitle: '代理讀到的內容',
            previewDescription: '每輪傳送的內容區塊，原樣呈現。',
            deleteRole: '刪除角色',
            deleteConfirmTitle: '刪除此角色？',
            deleteConfirmBody: ({ name }) => `${name} 將對你和所有共用對象刪除。正在使用它的工作階段會保留副本。`,
            share: '共用…',
            sendCopyFailed: '無法傳送副本。',
            saveFailed: '無法儲存角色。',
            loadFailed: '無法載入你的角色。',
            emptyDetailTitle: '選擇一個角色',
            emptyDetailBody: '選擇角色以檢視其指令和執行方式。',
        },
        delegation: {
            title: '委派',
            description: '代理如何把工作交給其他代理。',
            depthTitle: '工作深度',
            approvalReviewer: '權限審核員',
            approvalReviewerDescription: '自動審核低風險請求，僅批准一次。敏感操作仍需你批准。僅適用於預設和接受編輯模式。',
            approvedByReviewer: '權限審核員已批准一次',
            depthDescription: '代理啟動的工作階段、背景執行和工作流程還能再啟動更多。此上限可阻止失控的鏈結。你自己啟動的內容永不受限。',
            depthSetting: '代理可以委派多遠',
            depthSettingDescription: ({ count }) => `${count} 層。超過後，代理會被要求自己完成工作。`,
            ladderRoot: '你啟動的工作',
            ladderRootDetail: '由你啟動 · 永不受限',
            ladderLevel: ({ level }) => `第 ${level} 層`,
            ladderLevelDetail: ({ level }) => (level === 1 ? "由你發起的工作中的代理啟動" : `由第 ${level - 1} 層的代理啟動`),
            ladderRefused: '再委派一次',
            ladderRefusedDetail: ({ level }) => `第 ${level} 層 · 遭拒；代理自己完成`,
        },
        session: {
            refusal: {
                unenforceableTitle: '此代理無法只委派',
                unenforceableBody: '此角色為「只委派」，而此工作階段的代理無法阻止自己編輯檔案。請為此角色關閉「只委派」，或在支援它的代理的新工作階段中啟動此角色。',
                restartRequiredTitle: '重新啟動工作階段以切換到「只委派」',
                restartRequiredBody: '此代理只在工作階段開始時套用「只委派」。請重新啟動工作階段，然後再次選擇此角色。',
                roleUnavailableTitle: '此角色已無法使用',
                roleUnavailableBody: '它已被移除、關閉或不再與你共用。請選擇其他角色。',
            },
            useDefaults: '使用預設角色',
            crossOwnerNote: '角色在啟動時已複製。',
            addRole: '為此工作階段新增角色',
            addRoleConfirm: '新增角色',
            namePlaceholder: '角色名稱',
            instructionsPlaceholder: '此角色做什麼、何時使用',
            notesTitle: '備註',
            notesPlaceholder: '其下每個工作階段都應知道的內容',
            applyToReports: '將角色套用到其下的工作階段',
            handsOffTitle: '只委派',
            handsOffDescription: '負責規劃和委派；不編輯檔案。',
            saveFailed: '無法儲存此變更。',
            sectionTitle: '角色',
            allRoles: '所有角色',
            inUse: ({ count }) => `${count} 個使用中`,
            changed: '已變更',
            thisSession: '此工作階段',
            reset: '重設',
            newRoleForSession: '為此工作階段新增角色',
            changeForSession: '僅為此工作階段變更',
            editNotes: '編輯備註',
            more: '更多',
            info: '角色適用於此工作階段及其下的工作階段。',
            countChanged: ({ count }) => `已變更 ${count} 個`,
            countAdded: ({ count }) => `已新增 ${count} 個`,
            addNotes: '新增備註，說明此工作階段應如何編排',
        },
        profiles: {
            sharedWithYouTitle: '與你共用',
            sharedWithYouDescription: '他人和團隊與你共用的設定檔。機密值仍由其擁有者保管。',
            share: '共用…',
            shareFailedTitle: '無法共用此設定檔',
            shareNeedsSavedSecrets: '機密值永不傳輸。請將此設定檔中的每個值移到已儲存的機密並連結，然後再次共用。',
            shareAwaitingApproval: '此設定檔的發佈正在等待核准。核准後，請再次選擇「共用…」。',
        },
    } } as const satisfies Pick<Record<string, RolesTranslations>, "zh-Hant">;

return { rolesTranslations };
})();

const Domain_runPageTranslations = (() => {
type Count = Shared_runPageTranslations.Count;

type Machine = Shared_runPageTranslations.Machine;

type Reviewer = Shared_runPageTranslations.Reviewer;

type RunPageTranslations = Shared_runPageTranslations.RunPageTranslations;

const runPageTranslations = { 'zh-Hant': {
        untitledRun: '智慧代理執行',
        intentTitles: { review: '審查', plan: '計畫', delegate: '委派任務' },
        thisMachine: '這台機器',
        menu: {
            cancelResponse: '取消這次回覆',
            copyResult: '複製結果',
            showInTranscript: '在對話紀錄中顯示',
            runDetails: '執行詳細資訊',
            agent: '智慧代理',
            permissions: '權限',
            kind: '類型',
            finishesOnItsOwn: '會自行結束',
            selectionInherited: '繼承工作階段',
            selectionExplicit: '為本次執行選擇',
            selectionIndependent: '帳戶預設',
            selectionRetained: '沿用啟動時的設定',
            selectionChoose: '為本次執行選擇',
            selectionChooseDetail: '選擇模型及其執行途徑',
            staysOpen: '保持開啟',
            started: '開始',
            run: '執行',
            process: '程序',
        },
        opening: { reading: ({ machine }) => `正在從 ${machine} 讀取。` },
        gone: {
            title: ({ machine }) => `這次執行已不在 ${machine} 上`,
            reason: '那裡不再保留它，已載入的對話紀錄中也沒有它。',
            closeTab: '關閉分頁',
        },
        stopFailed: {
            title: {
                review: '無法停止這次審查',
                plan: '無法停止這個計畫',
                delegate: '無法停止這項任務',
                run: '無法停止這次執行',
            },
            reasonWithOthers: ({ machine, count }) => `${machine} 未確認停止。你可以改為停止整個工作階段——這也會停止其中正在執行的其他 ${count} 個智慧代理。`,
            reasonAlone: ({ machine }) => `${machine} 未確認停止。你可以改為停止整個工作階段。`,
            stopSession: '停止工作階段…',
        },
        steps: {
            title: '過程',
            count: ({ count }) => `${count} 步`,
        },
        review: {
            findings: '發現',
            findingsCount: ({ count }) => `${count}`,
            highCount: ({ count }) => `${count} 個高`,
            severity: { blocker: '阻斷', high: '高', medium: '中', low: '低', nit: '細節' },
            triageLabel: '如何處理這項發現',
            reviewerAsks: '審查者提問',
            answer: '回答',
            askAboutThis: '就此提問',
            fixesSelected: ({ count }) => `已選 ${count} 個修正`,
            noFixesSelected: '選擇要實作的修正',
            implementFixes: ({ count }) => (count > 0 ? `實作 ${count} 個修正` : '實作修正'),
            couldNotSaveChoice: '無法儲存你的選擇。',
            reviewers: '審查者',
            findingTotal: ({ count }) => (count === 1 ? '1 條發現' : `${count}條發現`),
            moreFindings: ({ count }) => (count === 1 ? '還有 1 條發現' : `${count}條更多發現`),
            fixesToImplement: ({ count }) => (count === 1 ? '1 項待實作的修正' : `${count}項待實作的修正`),
            verifiedFirst: '每項都先驗證，再修正',
            replies: ({ count }) => (count === 1 ? '1 則回覆' : `${count}則回覆`),
            updatedAfterQuestion: '已根據你的問題更新',
            reviewerUpdated: ({ reviewer }) => `${reviewer} 更新了這條發現`,
            askPlaceholder: '就這條發現提問…',
            askReviewerPlaceholder: '向審查者提問…',
            toReviewer: ({ reviewer }) => `給 ${reviewer}`,
            followUpsGoTo: ({ reviewer }) => `問題會送給 ${reviewer}`,
            waitingForAnswer: ({ reviewer }) => `正在等待 ${reviewer}…`,
            waitingForAnswers: '正在等待審查者…',
            both: '兩者',
            reviewerCount: ({ count }) => `${count} 位審查者`,
            askReviewersPlaceholder: '向審查者追問…',
            followUpsGoToAll: ({ count }) => (count === 2 ? '問題會送給兩位審查者' : `問題會送給全部 ${count} 位審查者`),
            stillReviewing: '仍在審查',
            reviewerDidNotFinish: '未完成',
            reviewersNotStarted: ({ count }) => (count === 1 ? '有 1 位審查者未能開始' : `有 ${count} 位審查者未能開始`),
            reviewerNotStarted: ({ reviewer }) => `${reviewer} 無法開始。`,
            notSaved: '這條發現未儲存，暫時無法記錄決定。',
            decisionsUnavailable: '無法載入你的決定。',
            followUpUnavailable: {
                notResumable: '此審查已結束；提問需要保持開啟的審查。',
                ended: '此審查未完成，因此無法接受提問。',
                resumeUnavailable: '在這台機器上已無法聯絡到審查者。',
                busy: '審查者仍在忙碌，請稍後再試。',
                failed: '無法傳送你的問題。',
            },
        },
        launcher: {
            titles: { review: '請求審查', plan: '請求計畫', delegate: '委派任務' },
            descriptions: {
                review: ({ machine }) => `每個智慧代理各自審查 ${machine} 上的變更；每個都會在這裡給出一個結果。`,
                plan: ({ machine }) => `智慧代理閱讀 ${machine} 上的程式碼，並在這裡提出計畫。它不會變更任何內容。`,
                delegate: ({ machine }) => `智慧代理依下方權限在 ${machine} 上工作，並在這裡回報。`,
            },
            whatFor: '用途',
            who: { review: '誰來審查', plan: '誰來規劃', delegate: '誰來做' },
            selectedCount: ({ count }) => `已選 ${count} 個`,
            focus: {
                review: '他們應該注意什麼？',
                plan: '計畫應涵蓋什麼？',
                delegate: '它應該做什麼？',
            },
            optional: '選填',
            start: {
                review: ({ count }) => (count > 1 ? `開始 ${count} 個審查` : '開始審查'),
                plan: '開始計畫',
                delegate: '開始任務',
            },
            runsOn: ({ machine }) => `在 ${machine} 上執行`,
            checking: '正在檢查這裡可以執行哪些智慧代理',
            unavailableTitle: '這個工作階段無法啟動智慧代理',
            unavailableReason: '它的機器目前不提供審查、計畫或委派任務。',
        },
    } } as const satisfies Pick<Record<string, RunPageTranslations>, "zh-Hant">;

return { runPageTranslations };
})();

const Domain_scmComparisonTranslations = (() => {
type ScmComparisonTranslations = Shared_scmComparisonTranslations.ScmComparisonTranslations;

const en = Shared_scmComparisonTranslations.en;

const translated = Shared_scmComparisonTranslations.translated;

const scmComparisonTranslations = { 'zh-Hant': {
        scmComparison: translated({
            view: { files: '檔案', walkthrough: '導讀', commits: '提交' },
            scope: {
                workingTree: '待處理的變更',
                session: '本工作階段',
                turn: '輪次',
                latestTurn: '最新一輪',
                branch: ({ head, base }) => `${head} 對比 ${base}`,
                commit: ({ commit }) => `提交 ${commit}`,
            },
            tabTitle: ({ view, scope }) => `${view} · ${scope}`,
            since: ({ time }) => `自 ${time} 起`,
            turnsWithChanges: ({ count }) => `${count} 輪有變更`,
            scopePicker: {
                a11y: '要顯示的變更',
                branchChoice: '分支與基準比較',
                commitChoice: '提交',
                pullRequestChoice: '拉取請求',
                headRef: '目標分支或參照',
                baseRef: '基準分支或參照',
                parentRef: '父提交參照（選填）',
                explainAndCommit: '說明並提交',
                explainOnly: '僅說明',
                unavailable: '此工作階段無法使用',
                pendingDescription: '尚未提交 · 可以建議提交',
                sessionDescription: '所有變更，開始 → 現在',
                turnDescription: '按代理修改的順序',
                branchDescription: '從共同基準開始的變更',
                commitDescription: '此提交引入的變更',
                pullRequestDescription: '此提取請求提出的變更',
            },
            fileCount: ({ count }) => `${count} 個檔案`,
            changeCount: ({ count }) => `${count} 處變更`,
            changedFiles: '已變更的檔案',
            startReview: '開始審查',
            proposeCommits: '建議提交',
            explain: '說明',
            explainA11y: '說明：在變更旁顯示導讀的註解',
            viewA11y: '檢視',
            lockfileTag: '鎖定檔',
            generatedTag: '已產生',
            lockfileCollapsed: '鎖定檔，已收合。',
            generatedCollapsed: '產生的檔案，已收合。',
            showDiff: '顯示差異',
            unsupportedReason: '檔案暫時無法顯示此比較。變更仍保留在 Git 中。',
            showPendingChanges: '顯示待處理的變更',
            capturedStale: '來源已變更。這些檔案保留擷取時的比較。',
            capturedFreshnessUnknown: '正在顯示已擷取的檔案。無法檢查來源的目前狀態。',
            keys: { nextFile: '下一個檔案', nextChange: '下一處變更' },
        }),
    } } as const;

return { scmComparisonTranslations };
})();

const Domain_secretsSettingsTranslations = (() => {
type SecretsSettingsCopy = Shared_secretsSettingsTranslations.SecretsSettingsCopy;

const en = Shared_secretsSettingsTranslations.en;

const zhHant: SecretsSettingsCopy = {
    purpose: "供代理程式和 MCP 伺服器使用的 API 金鑰與權杖。儲存後不再顯示其值。",
    yoursTitle: '你的密鑰',
    yoursDescription: '你儲存或擁有的密鑰。在 Happier 需要金鑰的地方選擇它們。',
    sharedWithYouTitle: '與你共用',
    sharedWithYouDescription: '其他人允許你使用這些密鑰。你可以選擇它們，但無法查看或修改。',
    add: '新增密鑰',
    newSecret: '新密鑰',
    emptyTitle: '還沒有密鑰',
    emptyDescription: '新增一次 API 金鑰或權杖，之後在 Happier 需要時直接選擇。',
    staleTitle: '無法重新整理共用密鑰',
    staleDescription: '正在顯示上次已知的清單。',
    valueTitle: '值',
    valueSaved: '已儲存。不會再次顯示。',
    keepTitle: '儲存為',
    keepPersonal: '個人',
    keepShared: '共用',
    keepPersonalDescription: '儲存在你的帳號中。只有你可以使用。',
    keepSharedDescription: '儲存在此 Home 上，以便與他人、Team 或群組共用。',
    accessTitle: '誰可以使用',
    accessOnlyYou: '只有你',
    accessRecipients: ({ count }: { count: number }) => `你和 ${count} 位接收者`,
    sharePersonalDescription: '共用後會移到此 Home，無法再變回個人密鑰。',
    share: '共用',
    manage: '管理',
    storageTitle: '儲存',
    storageE2ee: '端對端加密',
    storageE2eeDescription: '只有你共用的人可以讀取。',
    storagePlain: '由 Home 管理',
    storagePlainDescription: '此 Home 會儲存它，並可讀取以便傳遞。',
    save: '儲存密鑰',
};

const secretsSettingsTranslations = { zhHant } as const;

return { secretsSettingsTranslations };
})();

const Domain_sessionAccessTranslations = (() => {
const sessionAccessTranslations = { "zh-Hant": {
        withContext: ({ context, label }: { context: string; label: string }) => `${context} · ${label}`,
        withCount: ({ label, count }: { label: string; count: number }) => `${label} +${count}`,
        accessibleSummary: ({ title, label }: { title: string; label: string }) => `${title}: ${label}`,
        accessibleControl: ({ name, control, value }: { name: string; control: string; value: string }) => `${name}, ${control}, ${value}`,
        title: "工作階段存取權限",
        context: "工作階段情境",
        search: "搜尋人員、群組或團隊",
        hasAccess: "擁有存取權限",
        yourAccess: "你的存取權限",
        readOnly: "你可以查看取得存取權限的方式。只有工作階段管理員可以變更。",
        sourceDirect: "直接存取權限",
        sourceTeam: "透過團隊取得存取權限",
        sourceGroup: "透過群組取得存取權限",
        people: "人員",
        groups: "群組",
        teams: "團隊",
        account: "人員",
        group: "群組",
        team: "團隊",
        view: "可檢視",
        edit: "可指揮",
        admin: "管理",
        owner: "擁有者",
        private: "私人",
        custom: "自訂存取",
        required: "團隊政策要求",
        subjectNotFound: "此人員、群組或團隊已無法使用。",
        subjectIneligible: "無法再向此人員、群組或團隊授予存取權限。",
        teamPolicyRequired: "團隊政策要求保留此存取權限。",
        selfGrantManaged: "你的存取權限需由其他存取管理員變更。",
        homeUnsupported: "此 Home 尚未支援工作階段存取。請更新後再管理誰可以開啟此工作階段。",
        openCollaboration: "開啟協作",
        authenticationRequired: "請使用此團隊接受的方式登入，然後再試一次。",
        authenticationUnavailable: "此團隊要求的登入方式在此 Home 上無法使用。",
        delegation: "可核准執行階段權限請求",
        remove: "移除存取權限",
        confirmRemove: "確認移除",
        credentialsLost: ({ names }: { names: string }) => `以下團隊憑證將在此處停止運作：${names}`,
        ready: "加密存取已就緒",
        prepared: "加密存取已準備",
        recipientRepairRequired: "此人需要修復其帳戶的加密設定。",
        pending: "加密存取待處理",
        setup: "需要設定加密",
        repair: "加密存取需要修復",
        unavailable: "加密內容無法使用",
        notRequired: "此工作階段未加密，不需要準備。",
        preparing: "正在準備加密存取…",
        preparingProgress: ({ count }: { count: number }) => `正在準備加密存取… 已完成 ${count} 項`,
        preparationPending: ({ count }: { count: number }) => `${count} 人的加密存取待準備`,
        preparationSetup: ({ count }: { count: number }) => `${count} 人需要完成加密設定`,
        preparationRepair: ({ count }: { count: number }) => `${count} 人的加密存取需要修復`,
        preparationKeyUnavailable: "此裝置無法為此工作階段準備加密存取。",
        preparationFailed: "存取已儲存，但準備加密存取失敗。",
        preparationPassFailed: "準備加密存取失敗。",
        preparationAnnouncedComplete: "加密存取準備已完成。",
        preparationAnnouncedNeedsAttention: "加密存取仍需設定或修復。",
        preparationCheckFailed: "無法檢查加密存取。",
        outcomeUnknown: "結果尚未確定。再次嘗試前，Happier 正在檢查目前的存取狀態。",
        historicalLayoutNotice: "與你共享此工作階段的人在它針對此版本 Happier 更新之前無法開啟。",
        historicalLayoutUpdate: "更新以便共享",
        homeReconciled: "已為新的 Home 重設工作階段存取權限。",
        lockedTitleFallback: "加密工作階段",
        encryptedAccess: "加密存取",
        aggregatePrepared: ({ count }: { count: number }) => `已完成 ${count} 項`,
        aggregatePending: ({ count }: { count: number }) => `待處理 ${count} 項`,
        aggregateNeedsAttention: ({ count }: { count: number }) => `${count} 項需要設定或修復`,
        prepareNow: "立即準備",
        prepareAgain: "重新準備",
        preparingProgressOf: ({ count, total }: { count: number; total: number }) => `正在準備加密存取… ${count}/${total}`,
        showAllRecipients: "顯示所有人",
        hideAllRecipients: "隱藏列表",
        moreRecipients: "顯示更多",
        recipientPlainAccount: "未啟用加密的帳戶",
        pendingBody: "這個工作階段已加密。管理者仍須為你準備加密存取，之後才能在這裡開啟。",
        setupBody: "先在此帳戶完成加密設定，管理者隨後即可為你準備這個工作階段的存取權限。",
        setupAction: "設定加密",
        repairBody: "本裝置無法開啟為這個工作階段下發的金鑰。請重試，或請工作階段管理者重新準備存取權限。",
        retryAction: "重試",
        unavailableBody: "金鑰已開啟，但無法解密這個工作階段的內容。工作階段管理者可以重新準備存取權限。",
        openAccessAction: "開啟工作階段存取權限",
        removedTitle: "存取權限已移除",
        removedBody: "以你目前的存取權限無法開啟這個工作階段。工作階段管理者可以重新分享。",
        removedAnnouncement: ({ name }: { name: string }) => `已將 ${name} 從工作階段存取權限中移除`,
        browseMore: "瀏覽全部",
        allLoaded: "已載入全部結果",
        levelHelp: { view: "閱讀工作階段", edit: "在設定的工具權限範圍內指揮智慧體", admin: "管理工作階段存取" },
        steeringScopeNotice: "指揮智慧體不是隔離的聊天：工作目錄和署名不會限制 shell、檔案系統或網路存取。",
        help: "可檢視允許閱讀。可指揮允許在工具權限範圍內指示智慧體。管理也允許管理工作階段存取。這不是隔離的聊天：工作目錄和署名不會限制 shell、檔案系統或網路存取。"
    } } as const;

return { sessionAccessTranslations };
})();

const Domain_sessionAgentActivityTranslations = (() => {
const en = Shared_sessionAgentActivityTranslations.en;

const zhHant: typeof en = {
    status: {
        queued: '排隊中',
        starting: '正在啟動',
        running: '執行中',
        waiting: '等待中',
        blocked: '已封鎖',
        succeeded: '已完成',
        failed: '失敗',
        timedOut: '已逾時',
        cancelled: '已停止',
        unknown: '未知',
    },
    attention: {
        permission: '需要核准',
        userAction: '需要你的回覆',
        both: '需要處理',
        bothDescription: '需要核准，也需要你的回覆',
    },
    runKind: {
        conversation: '對話',
        review: '審查',
        plan: '計畫',
    },
    /** The Agents pane: its "+", its states, its team groups and its live line (agents lab). */
    roster: {
        teamLabel: ({ team, count }) => `團隊 ${team} · ${count} 個代理`,
        teamActionsA11y: '團隊操作',
        openWork: '開啟',
        needsYouCount: ({ count }) => `${count} 個需要你處理`,
        runningCount: ({ count }) => `${count} 個執行中`,
        nothingRunning: '沒有正在執行的項目。',
        startAgent: '啟動代理',
        machineOffline: ({ machine }) => `${machine} 沒有回應`,
        machineOfflineUnnamed: '機器沒有回應',
        launch: {
            menuA11y: '啟動代理',
            conversationDescription: '在此工作階段旁與代理對話',
            reviewDescription: '檢查目前為止的變更',
            planDescription: '規劃接下來的步驟',
            delegateDescription: '交出任務並取回完成結果',
            advancedDescription: '選擇代理、權限和設定檔',
        },
        empty: {
            title: '為此工作階段加入更多代理',
            reason: ({ machine }) => `在你繼續工作時，開始一段旁支對話，或請代理審查或規劃。它們在 ${machine} 上執行，並在這裡回報。`,
            reasonUnnamed: '在你繼續工作時，開始一段旁支對話，或請代理審查或規劃。它們會在這裡回報。',
            moreWays: '請求審查、規劃或委派',
        },
        unavailable: {
            notEnabled: '此 Home 無法啟動代理。',
            machineOffline: ({ machine }) => `啟動代理需要 ${machine} 在線。`,
            machineOfflineUnnamed: '啟動代理需要這台機器在線。',
            sessionInactive: '此工作階段已停止。恢復它即可在這裡啟動代理。',
            externalRunnerInactive: '此工作階段是在 Happier 之外啟動的。Happier 連線期間可以從這裡啟動代理。',
        },
    },
    summaryA11y: ({ title, status }) => `${title}，${status}`,
    summaryAttentionA11y: ({ title, status, attention }) => `${title}，${status}，${attention}`,
};

const sessionAgentActivityTranslations = { zhHant };

return { sessionAgentActivityTranslations };
})();

const Domain_sessionBoardTranslations = (() => {
type SessionBoardStateTranslation = Shared_sessionBoardTranslations.SessionBoardStateTranslation;

type SessionBoardTranslation = Shared_sessionBoardTranslations.SessionBoardTranslation;

const sessionBoardTranslations = { 'zh-Hant': {
        title: '面板',
        views: {
            label: '面板檢視',
            overview: '總覽',
            createTitle: '新增面板檢視',
            renameTitle: '重新命名面板檢視',
            reconciled: ({ title }) => `該面板檢視已被移除，正在顯示${title}。`,
            empty: {
                title: '此檢視中沒有內容',
                reason: '在這裡新增一個小工具，或切換到其他面板檢視。',
            },
            actions: {
                create: '新增檢視',
                rename: '重新命名檢視',
                moveBefore: '將檢視前移',
                moveAfter: '將檢視後移',
                remove: '刪除檢視',
            },
            remove: {
                title: ({ title }) => `刪除「${title}」？`,
                moveMessage: ({ title }) => `其中的小工具會移到${title}。工作階段中不會刪除任何內容。`,
                unpinMessage: '其中的小工具仍留在工作階段中，但不再釘選到任何檢視。',
            },
        },
        add: { note: '筆記', interactiveView: '互動檢視' },
        width: { compact: '窄', medium: '中等', wide: '寬', full: '整行寬度' },
        height: { auto: '符合內容', compact: '較矮', regular: '中等', tall: '較高' },
        board: {
            loading: { title: '正在開啟面板', reason: '正在載入這個工作階段釘選的內容。' },
            locked: {
                title: '面板仍處於加密狀態',
                reason: '這台裝置還無法開啟這個工作階段。沒有任何內容遺失。',
            },
            unopenable: {
                title: '無法讀取面板的排列方式',
                reason: '已儲存的排列方式無法開啟。各個小工具本身不受影響。',
            },
            unsupported: {
                title: '此面板需要較新版本的 Happier',
                reason: '內容都已保留。請在支援的裝置上開啟，或更新 Happier。',
            },
            unavailable: {
                title: '這裡還無法使用面板',
                reason: '沒有內容遺失。等這個 Home 啟用面板後就會出現。',
            },
            offline: '離線 — 顯示的是你上次載入的版本。',
            offlineEmpty: '離線 — 重新連線後即可載入此面板。',
            stale: '顯示的是你上次載入的版本。',
        },
        empty: {
            editor: {
                title: '把計畫放在聊天旁邊',
                description: '釘選在這裡的筆記和即時檢視會留在這個工作階段中，所有能閱讀它的人都看得到。',
                askAgent: '請代理人處理',
                askAgentPrompt: '在這個看板上放一個可以顯示以下內容的元件：',
                addNote: '新增筆記',
            },
            viewer: {
                title: '面板上還沒有內容',
                description: '人或代理人釘選到這個工作階段的內容會出現在這裡。',
            },
        },
        item: {
            untitled: '未命名小工具',
            renameA11y: '小工具標題',
            reorderA11y: ({ title }) => `重新排序 ${title}`,
            a11yLabelWithWidth: ({ title, width }) => `${title}，${width}`,
            menuGroups: { content: '閱讀和編輯', movement: '移動', geometry: '大小', destructive: '移除' },
            loading: { title: '正在載入這個小工具', reason: '正在從這個 Home 取得內容。' },
            locked: {
                title: '加密內容暫時無法使用',
                reason: '在這台裝置能開啟工作階段之前，這個小工具會維持加密。',
            },
            unopenable: {
                title: '無法顯示這個小工具',
                reason: '已儲存的內容無法讀取。面板的其他部分不受影響。',
            },
            unsupported: {
                title: '這個小工具需要較新版本的 Happier',
                reason: '內容已保留。請在支援的裝置上開啟，或更新 Happier。',
            },
            notCopied: { title: '未複製視覺內容', reason: '無法將此視覺內容複製到此分支。' },
            missing: {
                title: '找不到這個小工具',
                reason: '面板仍指向它，但內容不在這個 Home 上。',
            },
            removed: {
                title: '這個小工具已從面板移除',
                reason: '有編輯權限的人為所有人刪除了它。',
            },
            pluginUnavailable: {
                title: '這台裝置上沒有該外掛',
                reason: '小工具已保留。外掛在這裡可用後會再次顯示。',
            },
            rendererUnavailable: {
                title: '這台裝置無法顯示這個小工具',
                reason: '內容已保留。請在支援互動檢視的裝置上開啟。',
            },
            provenance: {
                note: '筆記',
                interactiveView: '互動檢視',
                pluginMissing: ({ pluginId }) => `來自 ${pluginId} · 未安裝`,
                pluginSurface: ({ plugin, surface }) => `${surface} · ${plugin}`,
                pluginQualified: ({ label, pluginId }) => `${label} (${pluginId})`,
            },
            actions: {
                remove: '從面板移除',
                openHere: '在這裡開啟',
                managePlugin: '管理外掛',
                prepareEncryption: '設定加密',
                readFull: '閱讀完整筆記',
                rename: '重新命名小工具',
                unpin: '從此檢視取消釘選',
                moveToView: ({ title }) => `移動到${title}`,
            },
            moved: {
                before: ({ title }) => `${title}已往前移動。`,
                after: ({ title }) => `${title}已往後移動。`,
                reordered: ({ title }) => `${title}已移動。`,
                toView: ({ title, view }) => `${title}已移動到${view}。`,
            },
            movePosition: ({ position, total }) => `第 ${position} 項，共 ${total} 項`,
            moveTargetView: ({ title }) => `看板檢視${title}`,
            remove: {
                title: '移除此小工具？',
                message: '所有能閱讀此工作階段的人都會失去它。已安裝的外掛仍保持安裝。',
            },
        },
        note: {
            titlePlaceholder: '標題',
            titleA11y: '筆記標題',
            untitled: '未命名筆記',
            offline: '儲存需要連線到這個 Home。',
            unavailable: '這個 Home 還不支援修改面板。',
            failed: 'Happier 無法儲存這則筆記。你的文字還在。',
            outcomeUnknown: 'Happier 無法確認筆記是否已儲存。請重新整理後再儲存。',
            saved: '筆記已儲存',
            conflict: {
                message: '這則筆記在另一台裝置上有變動。',
                reviewLatest: '查看最新版本',
                applyMine: '套用我的變更',
                latestHeading: '最新版本',
            },
        },
        recovered: {
            title: '已復原的項目',
            description: '這些小工具屬於此工作階段，但沒有出現在任何面板檢視中。',
            pin: '加入此檢視',
        },
        mutation: {
            conflict: '此面板已在其他裝置上變更。請重新整理以查看最新內容。',
            outcomeUnknown: 'Happier 無法確認該變更是否已儲存。',
            denied: '你已不再有權變更此面板。',
            offline: '變更面板需要連線到此 Home。',
            unavailable: '此 Home 尚無法變更面板。',
            updateRequired: '請更新 Happier 以進行此面板變更。',
            hostedHtmlSourceTooLarge: '此互動式檢視太大，無法儲存。你的草稿仍在這裡。',
            noteTooLarge: '此筆記太大，無法儲存。你的文字仍在這裡。',
            invalid: '此面板變更無效。請檢查後再試一次。',
            notFound: '此面板項目已無法使用。請重新整理面板。',
            storageFailed: 'Happier 無法安全儲存此變更。你的內容仍在這裡。',
            serverFailed: '此 Home 無法完成面板變更。請再試一次。',
            failed: 'Happier 無法套用該面板變更。',
        },
        hostedHtmlApproval: {
            title: '允許此互動式檢視？',
            body: '此授權僅適用於此工作階段中的此檢視。傳送訊息仍需要你在檢視內點選。',
            resources: ({ count }) => `可讀取 ${count} 個工作階段資源`,
            actions: ({ count }) => `可執行 ${count} 個動作`,
            sendMessages: '可請求 Happier 傳送訊息',
            loadsFrom: ({ origin }) => `從 ${origin} 載入`,
            allow: '允許',
            notNow: '暫不',
            declined: {
                title: '互動式檢視尚未允許',
                reason: '隨時可以查看它要求的權限。',
                review: '查看',
            },
        },
        sidebar: {
            openInDetails: '在詳細資料中開啟',
            openBoard: '開啟面板',
            sharedWithEveryone: '與這裡的所有人共享',
            widgetCount: ({ count }) => `${count} 個小工具`,
        },
        mobile: { searchPlaceholder: '搜尋此面板' },
        inline: {
            openBoard: '開啟面板',
            openBoardA11y: ({ title }) => `在面板中開啟「${title}」`,
        },
        companion: {
            title: '隨行面板',
            inCompanionA11y: '在你的隨行面板中',
            empty: {
                title: '讓工作階段一直在視線內',
                reason: '把工作階段摘要或看板小工具放在聊天旁邊：正在執行什麼、什麼在等你、改了什麼。',
                note: '只有你能看到你的隨行面板。',
            },
            pane: {
                besideChat: '在聊天旁邊',
                itemCount: ({ count }: { count: number }) => `${count} 項`,
                justForYou: '只屬於你，在聊天旁邊',
            },
            actions: {
                addSummary: '新增工作階段摘要',
                addItem: ({ title }) => `新增${title}`,
                moveToLeading: '移到左側',
                moveToTrailing: '移到右側',
                moveToFirst: '移到最前',
                moveToLast: '移到最後',
                compact: '精簡尺寸',
                comfortable: '寬鬆尺寸',
                openFull: '開啟完整隨行面板',
                openOnBoard: '在看板中開啟',
                collapse: '收合隨行面板',
                expand: '展開隨行面板',
                hide: '隱藏隨行面板',
                addToCompanion: '加入隨行面板',
                removeFromCompanion: '從隨行面板移除',
                undo: '復原',
                menuA11y: '隨行面板選項',
                itemMenuA11y: ({ title }) => `${title}的選項`,
            },
            a11y: {
                headerAction: ({ count }) => `隨行面板，${count} 個項目`,
                show: ({ count }) => `顯示隨行面板，${count} 個項目`,
                expand: ({ count }) => `展開隨行面板，${count} 個項目`,
            },
            summary: {
                review: '查看',
                title: '工作階段摘要',
                untitled: '工作階段',
                approvals: ({ count }) => `${count} 項等待你處理`,
                workflows: ({ count }) => `${count} 個工作流程執行中`,
                changedFiles: ({ count }) => `已變更 ${count} 個`,
                tokens: ({ count }) => `${count} 個權杖`,
                contextPercent: ({ percent }) => `脈絡 ${percent}%`,
                contextOnly: '已用脈絡',
                moreDetails: '更多詳細資料',
                moreDetailsA11y: ({ count }) => `更多詳細資料，另有 ${count} 列`,
                partial: '部分詳細資料在此處無法檢視。',
            },
            notices: {
                shown: '已顯示隨行面板',
                hidden: '已隱藏隨行面板',
                added: '已加入隨行面板',
                removed: '已從隨行面板移除',
                reordered: '已重新排序隨行面板',
                moved: '已移動隨行面板',
                boardOpened: '代理已開啟看板',
                returnedToChat: '代理已返回聊天',
                boardViewSelected: '代理已選擇看板檢視',
                boardItemRevealed: '代理已開啟看板項目',
                fullOpened: '代理已開啟隨行面板',
            },
        },
    } } as const satisfies Pick<Readonly<Record<string, SessionBoardTranslation>>, "zh-Hant">;

return { sessionBoardTranslations };
})();

const Domain_sessionCollaborationPaneTranslations = (() => {
type PaneCopy = Shared_sessionCollaborationPaneTranslations.PaneCopy;

const en = Shared_sessionCollaborationPaneTranslations.en;

const sessionCollaborationPaneTranslations: Pick<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', PaneCopy>, "zh-Hant"> = { 'zh-Hant': {
        hereOne: ({ name }) => `${name} 在這裡`,
        hereTwo: ({ first, second }) => `${first} 和 ${second} 在這裡`,
        hereMany: ({ first, count }) => `${first} 和其他 ${count.toLocaleString()} 人在這裡`,
        typingOne: ({ name }) => `${name} 正在輸入…`,
        typingMany: ({ count }) => `${count.toLocaleString()} 人正在輸入…`,
        justYouHere: '只有你在這裡',
        justYouHint: '你分享的對象會顯示在這裡',
        you: '你',
        presenceConnecting: '正在查看誰在這裡…',
        presenceUnavailable: '即時線上狀態暫時沒有回應',
        presenceUnsupported: '此 Home 不提供即時線上狀態',
        responsibleUnsupported: '此 Home 不記錄負責人',
        inviteTitle: '在工作階段旁邊討論',
        inviteBody: '開始對話、提及他人,準備好後把答案交給 Agent。',
        readOnly: '你可以閱讀。能編輯此工作階段的人可以發言。',
        offline: '你已離線 · 顯示最近的對話',
        lockedTitle: '暫時無法在此裝置上開啟這些對話',
        lockedBody: '它們經過端對端加密,而此裝置的加密設定與此工作階段不一致。',
        revokedTitle: '你已無法存取這些對話',
        revokedBody: '此工作階段的管理者變更了可檢視的人。你寫的訊息仍保留在工作階段中。',
        namesTwo: ({ first, second }) => `${first}和${second}`,
        namesThree: ({ first, second, third }) => `${first}、${second}和${third}`,
        namesMore: ({ first, second, count }) => `${first}、${second}等 ${count.toLocaleString()} 個`,
        haveAccess: '有存取權',
        hasAccess: '有存取權',
        onlyYou: '僅你自己',
        notShared: '尚未與任何人分享',
        publicLinkOn: '公開連結已開啟',
        accessLoading: '正在查看誰有存取權…',
        accessError: '無法載入存取權',
        shareTitle: '分享此工作階段',
        shareBody: ({ home }) => `你在 ${home} 加入的人可以關注此工作階段並參與對話。`,
        collapse: '收合',
        linkOn: '開啟',
        linkOff: '關閉',
        linkGrants: '任何擁有連結的人都可以檢視記錄,無需帳號。',
        linkExpires: ({ date }) => `${date} 到期`,
        linkNeverExpires: '永不過期',
        linkAsksConsent: '需要同意',
        linkNoConsent: '無需同意',
        linkHidden: '此連結是先前建立的,無法再次顯示。請建立新連結後複製。',
        qrCode: 'QR 碼',
        hideQrCode: '隱藏 QR 碼',
        newLink: '新連結…',
        turnOff: '關閉',
        turnOffTitle: '要關閉公開連結嗎?',
        turnOffBody: '擁有連結的人將立即失去存取權。你之後可以再建立新連結。',
        newLinkReplaces: '新連結建立後,目前的連結將失效。',
        linkDenied: '只有管理此工作階段的人才能建立公開連結。',
        linkLoadFailed: '無法檢查公開連結。',
        linkNetworkOff: '關閉視覺內容的網路存取後分享',
        linkNetworkConsequence: '具有網路存取權的視覺內容可以將內容傳送到其他網站，並透露檢視者的 IP 位址。遠端程式碼和資源可能變更。關閉網路存取後，內建內容仍可互動，不會發出外部請求。',
        linkUnavailable: '此 Home 不支援公開連結。請聯絡管理員設定公開連結託管。',
        justYouTitle: '一起處理這個工作階段',
        justYouBody: ({ home }) => `與 ${home} 上的人分享。他們可以關注進度、在這裡討論,並在你離開時接手。`,
        share: '分享',
        justYouNote: '或建立任何人都能檢視的公開連結。',
        sharingOffTitle: ({ home }) => `${home} 不與他人分享工作階段`,
        sharingOffBody: '你仍可以建立任何人都能檢視的公開連結。',
        sharingOffPrivateBody: '此 Home 上的工作階段僅屬於你。',
        accessDenied: '只有管理此工作階段的人才能變更存取權。你仍可以參與對話。',
    } };

return { sessionCollaborationPaneTranslations };
})();

const Domain_sessionCollaborationTranslations = (() => {
const sessionCollaborationPaneTranslations = {...Domain_sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations, ...EnglishFeatures.sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations};

const en = Shared_sessionCollaborationTranslations.en;

const sessionCollaborationTranslations: Pick<Record<'en'|'ca'|'de'|'es'|'fr'|'it'|'ja'|'pl'|'pt'|'ru'|'zh-Hans'|'zh-Hant', typeof en>, "zh-Hant"> = { 'zh-Hant': { pane: sessionCollaborationPaneTranslations['zh-Hant'], title: '協作', viewingNow: '正在檢視', justYou: '只有你', typing: '正在輸入…', stale: '可能不是最新', unavailable: '即時線上狀態無法使用', connecting: '連線中…', unnamed: 'Happier 成員', open: '開啟協作', conversations: '對話', accessUnavailable: '工作階段存取權無法使用', accessUnavailableReason: '此 Home 不支援將工作階段分享給其他人。', discussion: { featureUnavailable: "此 Home 尚未啟用對話。", bindingUnavailable: "請重新登入此 Home 以檢視對話。", scopeMismatch: "這些對話屬於此 Home 上的其他帳戶。", modeMismatch: "內容與工作階段的加密模式不符。請重試，或請工作階段管理員檢查存取權。",  title: '對話', newDiscussion: '新增對話', create: '建立對話', titlePlaceholder: '對話標題', messagePlaceholder: '撰寫訊息…', active: '進行中', activeDisclosure: '顯示進行中的對話', archived: '已封存', archivedDisclosure: '顯示已封存的對話', emptyActive: '還沒有進行中的對話。', emptyArchived: '沒有已封存的對話。', loading: '正在載入對話…', loadError: '無法載入對話。', retry: '再試一次', checking: '正在檢查更新…', deliveryUnknown: '傳送結果未知 — 重試前請先檢查。', locked: '你可以閱讀此對話，但不能發佈訊息。', offline: '你目前離線。重新連線後即可繼續。', unavailable: '此對話無法使用。', unreadCount: ({ count }) => `${count.toLocaleString()} 則未讀`, unreadMentionCount: ({ count }) => `${count.toLocaleString()} 則未讀提及`,
        mentioned: '有人提到你', unreadConversations: '未讀對話', messageCount: ({ count }) => `${count.toLocaleString()} 則訊息`, viaAgent: '由 Agent 傳送', collaborator: '協作者', contentUnavailable: '訊息無法使用', rename: '重新命名對話', archive: '封存對話', restore: '還原對話', selection: { copy: '複製', askAgent: '詢問 Agent', sendToSession: '傳送至工作階段', handoffError: '無法將所選訊息加入工作階段編輯器。' }, titleRequired: '新增標題以開始此對話。', encryptedTitle: '加密對話', archivedNotice: '此對話已封存。', sessionArchived: '此工作階段已封存。', postDenied: '你已無法在此工作階段中發佈訊息。', invalidMention: '你提及的人已無法讀取此工作階段。', invalidContent: '此訊息無法以目前內容傳送。它可能為空或過長。', idempotencyConflict: '此識別碼已用於傳送另一則不同的訊息。', sendFailed: '無法傳送此訊息。', dismiss: '關閉', loadOlder: '載入較早的訊息', loadMore: '載入更多對話' } } };

return { sessionCollaborationTranslations };
})();

const Domain_sessionCompanionTranslations = (() => {
type SessionCompanionTranslations = Shared_sessionCompanionTranslations.SessionCompanionTranslations;

const sessionCompanionTranslations = { 'zh-Hant': {
        status: {
            waitingForYou: '等你處理',
            pausedBeforeStep: ({ agent, step, total }) => `${agent} 在第 ${step}/${total} 步之前暫停`,
            stepOfPlan: ({ step, total }) => `計畫的第 ${step}/${total} 步`,
            agentFallback: '代理',
        },
        ask: {
            question: ({ summary }) => `${summary}?`,
            allow: '允許',
            deny: '拒絕',
            showInChat: '在聊天中顯示',
            moreWaiting: ({ count }) => `還有 ${count} 個在等待`,
            allowed: ({ summary }) => `已允許:${summary}`,
            denied: ({ summary }) => `已拒絕:${summary}`,
            justNow: '剛剛',
            failed: '你的回答沒有送達工作階段。請再試一次。',
            answerWhenBack: ({ machine }) => `${machine} 恢復後即可回答。`,
            answerWhenSessionBack: '工作階段恢復後即可回答。',
            notAllowed: '只有可以執行此工作階段的人才能回答。',
            groupA11y: '等你處理',
        },
        facts: {
            subagents: '子代理',
            changed: '已變更',
            context: '上下文',
            subagentsValue: ({ live, total }) => (live > 0 ? `${live}/${total}` : `${total}`),
            contextValue: ({ percent }) => `${percent}%`,
            opensAgents: '開啟代理',
            opensGit: '開啟 Git',
            opensUsage: '開啟用量',
        },
        plan: {
            title: '計畫',
            description: ({ agent }) => `${agent} 在此工作階段的待辦清單`,
            progress: ({ done, total }) => `${done}/${total}`,
            progressA11y: ({ done, total }) => `已完成 ${done}/${total}`,
            emptyTitle: '還沒有計畫',
            emptyReason: '代理寫下待辦清單後,會在這裡逐步顯示。',
            stepDone: '已完成',
            stepCurrent: '目前步驟',
        },
        picker: {
            open: '加入隨行面板',
            chooseWidget: '選擇小工具…',
            onTheBoard: ({ source }) => `${source} · 在看板上`,
        },
        drop: { keepBesideChat: '放在聊天旁邊' },
        freshness: { machineOffline: ({ machine }) => `${machine} 已離線` },
        needsYouA11y: ({ count }) => `隨行面板,${count} 個等你處理`,
    } } as const satisfies Pick<Readonly<Record<string, SessionCompanionTranslations>>, "zh-Hant">;

return { sessionCompanionTranslations };
})();

const Domain_sessionConversationSurfaceTranslations = (() => {
const en = Shared_sessionConversationSurfaceTranslations.en;

const zhHant: typeof en = {
    discussion: {
        loadingTitle: '正在開啟此對話…',
        offlineTitle: '此對話無法離線檢視',
        offlineReason: '重新連線後，會從你離開的地方開啟。',
        errorTitle: '無法開啟此對話',
        lockedTitle: '暫時無法在此裝置上開啟此對話',
        lockedReason: '它經過端對端加密，而此裝置的加密設定與該工作階段不一致。',
        revokedTitle: '你已無法存取此對話',
        revokedReason: '此工作階段已不再與你共用。你寫的訊息會保留在工作階段中。',
        unavailableTitle: '此處無法使用對話',
        closeTab: '關閉分頁',
    },
    draft: {
        leadTitle: '詢問代理程式',
        leadBody: '它會以獨立的對話在工作階段旁執行，並以這些訊息作為上下文。傳送之前不會開始。',
    },
    context: {
        fromConversation: ({ title, count }) => `來自 ${title} · ${count} 則訊息`,
        fromUntitled: ({ count }) => `來自一個對話 · ${count} 則訊息`,
    },
    origin: {
        fromConversation: ({ title }) => `來自 ${title}`,
        fromUntitled: '來自一個對話',
    },
    run: {
        details: '執行詳細資料',
        loadingTitle: '正在開啟與代理程式的對話…',
        errorTitle: '無法開啟與代理程式的對話',
    },
};

const sessionConversationSurfaceTranslations = { zhHant };

return { sessionConversationSurfaceTranslations };
})();

const Domain_sessionDirectoryRecoveryTranslations = (() => {
const en = Shared_sessionDirectoryRecoveryTranslations.en;

const sessionDirectoryRecoveryTranslations = { 'zh-Hant': {
        title: ({ machine }) => `此聊天的專用資料夾已不在 ${machine} 上。`,
        body: '你可以在一個新的空資料夾中繼續。聊天記錄會保留在這裡，但舊資料夾中的本機檔案不會復原。',
        continue: '在新資料夾中繼續', notNow: '暫時不要',
        offlineDelete: ({ machine }) => `${machine} 上的專用資料夾將在該電腦下次上線時刪除。`,
    } } satisfies Pick<Record<import('../../_all').SupportedLanguage, typeof en>, "zh-Hant">;

return { sessionDirectoryRecoveryTranslations };
})();

const Domain_sessionDraftTranslations = (() => {
const en = Shared_sessionDraftTranslations.en;

const zhHant: typeof en = {
    sectionTitle: '草稿',
    sectionTitleForHome: ({ home }) => `${home} 上的草稿`,
    waitingSectionTitleForHome: ({ home }) => `正在 ${home} 上等待電腦`,
    badge: '草稿',
    untitled: '未命名草稿',
    continueEditing: '繼續編輯',
    startAnother: '再開一個',
    executionRunStart: {
        starting: '正在啟動與代理的對話…',
        reconciling: '正在檢查這次代理對話是否已啟動…',
        unresolved: '無法確認這次代理對話是否已啟動。再次啟動可能會建立第二次對話。',
        targetChanged: '在對話啟動之前，此工作階段的電腦已變更。未啟動任何內容。',
        secretReferenceOverlayUpdateRequired: '在代理對話中使用共用密鑰需要已更新的電腦。未啟動任何內容。',
    },
    status: {
        offline: '離線 — 已儲存在此裝置上',
        syncing: '正在同步…',
        conflict: '需要檢查',
        unsupported: '未同步 — 此 Home 無法同步這個草稿',
        startInterrupted: '啟動已中斷',
    },
    availability: {
        machineUnavailable: '機器無法使用',
        pluginUnavailable: '外掛無法使用',
        attachmentNeedsAttention: '附件需要處理',
    },
    new: { action: '新增工作階段' },
    delete: {
        action: '刪除草稿',
        confirmTitle: '刪除這個草稿？',
        confirmDescription: '這會從你所有已同步的裝置上移除這個草稿。',
    },
    conflict: {
        title: '檢查衝突的變更',
        description: '為每個欄位選擇要保留的版本。取代前可以先複製本裝置的版本。',
        mine: '此裝置',
        synced: '已同步版本',
        useSynced: '使用已同步版本',
        keepDevice: '保留此裝置的版本',
        copyMine: '複製我的',
        copied: '已複製',
        copyFailed: '無法複製這個值。',
        field: {
            text: '訊息',
            mentions: '提及',
            attachments: '附件',
            recipient: '接收者',
            agentContinuation: '代理接續',
            executionRunRequestedAction: '執行投遞',
        },
    },
};

const sessionDraftTranslations = { zhHant };

return { sessionDraftTranslations };
})();

const Domain_sessionEmbeddedTranslations = (() => {
const en = Shared_sessionEmbeddedTranslations.en;

const translated = Shared_sessionEmbeddedTranslations.translated;

const sessionEmbeddedTranslations = { 'zh-Hant': translated({
        unavailable: '此工作階段無法使用',
        respondInSession: '開啟工作階段以回覆。',
        regionLabel: ({ title }) => `工作階段：${title}`,
        newChatWelcome: '我們要做什麼？',
    }) } as const;

return { sessionEmbeddedTranslations };
})();

const Domain_sessionFollowTranslations = (() => {
type SessionFollowTranslations = Shared_sessionFollowTranslations.SessionFollowTranslations;

const en = Shared_sessionFollowTranslations.en;

const sessionFollowTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionFollowTranslations
>, "zh-Hant"> = { 'zh-Hant': {
        "notificationBody": {"message":"此工作階段中有新訊息。","failed":"本輪執行失敗。","cancelled":"本輪執行已取消。","sourceUnavailable":"此工作階段的來源無法使用。"},
        "follow": "關注",
        "unfollow": "取消關注",
        "following": "已關注",
        "notifications": "通知",
        "unavailableTitle": "無法追蹤",
        "unavailableDescription": "此 Home 不支援追蹤工作階段。",
        "unreachableTitle": "無法連線至此 Home",
        "unreachableDescription": "Happier 無法確認此 Home 是否支援追蹤工作階段。請在可連線時再試一次。",
        "editor": {
            "title": "關注此工作階段",
            "subtitle": "接收對你重要的更新。",
            "ownerSubtitle": "這個工作階段屬於你，因此它的更新一定會送達。",
            "externalAttachedOnly": "背景同步已關閉，因此只有在此工作階段處於連線狀態時才可能收到更新。"
        },
        "level": {
            "none": "不通知",
            "important": "重要更新",
            "all_messages": "每則新訊息"
        },
        "voice": {
            "title": "納入 Voice",
            "subtitle": "Voice 可以保留此工作階段的脈絡。",
            "waitingRuntime": "正在等待 Voice 連線。",
            "unsupported": "此執行環境不支援將已關注的工作階段納入 Voice。",
            "providerWithheld": "此 Voice 模式無法包含已儲存的工作階段更新。",
            "waitingEncrypted": "解鎖此工作階段以將其納入 Voice。",
            "initialSnapshotPending": "在下一輪 Voice 對話中，提供簡短的目前狀態摘要。"
        },
        "footer": "關注不會改變誰可以存取此工作階段。",
        "settingsLink": "通知設定…",
        "assignedExplanation": "因指派給你而關注",
        "assignedNotice": "有一個工作階段指派給了你。",
        "sharedNotice": "有人與你分享了一個工作階段。",
        "wakeEventExplanation": "追蹤的內容有變動，因此 Happier 以該更新喚醒了此代理程式。",
        "accessLost": "你已無權存取此工作階段。",
        "offline": "你已離線。請重新連線以變更關注設定。",
        "archived": "此工作階段封存期間，關注將暫停。",
        "sources": {
            "title": "工作階段更新",
            "waitingRuntime": "正在等待目標工作階段重新連線。",
            "unsupported": "請更新或重新連線目標機器上的 CLI 以接收更新。",
            "pausedArchived": "來源或目標工作階段封存期間，更新會暫停。",
            "add": "在其他工作階段中關注…",
            "addSource": "從另一個工作階段傳送更新…",
            "chooseDestinationTitle": "在其他工作階段中關注",
            "chooseSourceTitle": "從另一個工作階段傳送更新",
            "row": ({ title }) => `來自「${title}」的更新`,
            "nextTurn": "下一輪",
            "wakeOnHumanChange": "有人新增訊息時喚醒",
            "stop": "停止更新",
            "stopForSource": ({ title }) => `停止來自「${title}」的更新`,
            "includeNextTurn": "在目標工作階段的下一輪中包含更新。",
            "sourceKeyPreparing": "正在準備加密存取…",
            "sourceKeyWaiting": "正在等待加密存取。",
            "sourceKeyUnavailable": "此電腦無法提供加密存取。",
            "sourceSessionKeyUnavailable": "此工作階段的加密存取在此無法使用。",
            "catchUpPending": "待補充更新"
        },
        "preferences": {
            "title": "自動關注",
            "assigned": "指派給我的工作階段",
            "direct": "直接共用的工作階段",
            "team": "透過團隊共用的工作階段",
            "group": "透過群組共用的工作階段",
            "help": "適用於新的指派及新取得存取權的工作階段。現有選擇保持不變。"
        }
    } };

return { sessionFollowTranslations };
})();

const Domain_sessionGitBranchesTranslations = (() => {
type SessionGitBranchesTranslations = Shared_sessionGitBranchesTranslations.SessionGitBranchesTranslations;

const en = Shared_sessionGitBranchesTranslations.en;

const zhHant: SessionGitBranchesTranslations = {
    openA11y: ({ branch }) => `分支 ${branch}：切換分支或查看暫存的變更`,
    searchPlaceholder: '切換或建立分支',
    category: { current: '目前', branches: '分支', remote: '遠端分支', keptAside: '已暫存', worktrees: '工作樹', start: '開始新的工作' },
    tracks: ({ upstream }) => `追蹤 ${upstream}`,
    onlyHere: '僅在此機器上',
    changed: ({ count }) => `${count} 項變更`,
    ahead: ({ count }) => `${count} 個待推送`,
    keptAsideWhen: ({ origin, when }) => `${origin} · ${when}`,
    newBranch: ({ branch }) => `從 ${branch} 建立分支…`,
    newBranchDetached: '建立分支…',
    newBranchSubtitle: '在搜尋欄輸入名稱',
    newWorktree: '新增工作樹…',
    newWorktreeSubtitle: '在新的工作階段處理另一個分支',
    keepAside: '暫存變更',
    keepAsideSubtitle: ({ count }) => `暫存 ${count} 項變更，從乾淨的狀態開始`,
    keepAsideNothing: '沒有可暫存的變更',
    keepAsideFailed: '無法暫存變更。',
    loadFailed: '無法載入分支',
    notice: {
        title: ({ branch }) => `你在 ${branch} 上暫存了變更`,
        reason: ({ when }) => `暫存於 ${when}。還原它們以繼續工作。`,
        reasonUndated: '還原它們以繼續工作。',
        restore: '還原變更',
        lookFirst: '先看看',
        dismiss: '暫不',
        restoreFailed: '無法還原變更。',
    },
};

const sessionGitBranchesTranslations = { zhHant };

return { sessionGitBranchesTranslations };
})();

const Domain_sessionGitDisplayTranslations = (() => {
const en = Shared_sessionGitDisplayTranslations.en;

const zhHant: typeof en = {
    settingsLayout: 'Git 面板版面',
    settingsShowAs: '已變更檔案顯示為',
    trigger: '顯示選項',
    paneGroup: '面板',
    changesGroup: '變更',
    layout: '版面',
    layoutUnified: '統一',
    layoutTabs: '分頁',
    layoutDescription: '從變更到歷史一次捲動瀏覽，或將變更和歷史分為兩個檢視。',
    showAs: '顯示為',
    showAsList: '清單',
    showAsTree: '樹狀',
    showAsDescription: '以清單顯示已變更的檔案，或依資料夾分組以便整個資料夾一起選取。',
    density: '密度',
    densityDefault: '預設',
    densityCompact: '緊湊',
    note: '樹狀列一律為緊湊。會為你的帳戶記住。',
    selectFolder: ({ folder }) => `選取 ${folder} 中的所有變更`,
    selectFile: ({ file }) => `選取 ${file} 用於下次提交`,
};

const sessionGitDisplayTranslations = { zhHant };

return { sessionGitDisplayTranslations };
})();

const Domain_sessionGitPaneTranslations = (() => {
const en = Shared_sessionGitPaneTranslations.en;

const fidelity = Shared_sessionGitPaneTranslations.fidelity;

const withFidelity = Shared_sessionGitPaneTranslations.withFidelity;

const zhHant: typeof en = {
    scope: { allChanges: '所有變更' },
    subTabs: { changes: '變更', sync: '同步', history: '歷史' },
    header: {
        changed: ({ count }) => `${count} 項變更`,
        toPush: ({ count }) => `${count} 個待推送`,
        toPull: ({ count }) => `${count} 個待拉取`,
        push: ({ count }) => `推送 ${count}`,
        pull: ({ count }) => `拉取 ${count}`,
        publish: '發布',
        folderOnMachine: ({ folder, machine }) => `${machine} 上的 ${folder}`,
    },
    groups: {
        session: '此工作階段中的變更',
        elsewhere: ({ repo }) => `${repo} 中的其他變更`,
        elsewhereUnnamed: '此儲存庫中的其他變更',
        selectGroup: ({ group }) => `選取「${group}」中的所有檔案`,
    },
    row: { renamedFrom: ({ path }) => `原 ${path}` },
    commit: {
        toBranch: ({ branch }) => `提交到 ${branch}`,
        selection: ({ count }) => `${count} 個檔案`,
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
            dirtyTitle: ({ count, formatted }) => (count === 1 ? `你有 1 項未提交的變更` : `你有 ${formatted} 項未提交的變更`),
            dirtyBody: '拉取可能會影響它們。拉取時先暫存（之後馬上恢復），或僅在沒有重疊時讓 Git 拉取。',
            keepAsideAndPull: '暫存後拉取',
            pullIfNoOverlap: '無重疊時拉取',
            divergedPullBody: '你的分支和 origin 都有新提交。把你的提交放到 origin 之上，或將兩者合併。',
            divergedPushBody: '先取回 origin 的提交（你的放在上面或合併），然後再次推送。你的提交會留在這台機器上。',
            rebase: '重訂基底到 origin',
            merge: '合併 origin',
        },
        writesOff: {
            title: '已關閉從 Happier 提交',
            body: '你可以閱讀和審閱每項變更。開啟版本控制操作即可在這裡提交、推送和拉取。',
            turnOn: '開啟',
        },
        header: {
            noChanges: '沒有變更',
        },
        action: {
            fetch: '擷取',
            publish: '發佈分支',
            createPr: '建立 PR',
            openPr: ({ number }) => `#${number}`,
            resolve: ({ count }) => `解決 ${count} 個`,
            upToDate: '已是最新',
            pushing: ({ count }) => `正在推送 ${count} 個…`,
            pulling: ({ count }) => `正在拉取 ${count} 個…`,
            fetching: '正在擷取…',
            publishing: '正在發佈…',
            creatingPr: '正在建立…',
        },
        menu: {
            open: '更多同步動作',
            push: '推送',
            pull: '拉取',
            pushTo: ({ target }) => `到 ${target}`,
            pullFrom: ({ target }) => `從 ${target}`,
            nothingToPush: '沒有可推送的內容',
            upToDate: '已是最新',
            fetchHint: '檢查 origin 上的新提交',
            publishHint: '將此分支放到 origin',
            createPr: '建立拉取請求…',
            createPrInto: ({ base }) => `合併到 ${base}`,
            unavailable: '此處無法使用',
            more: '更多',
        },
        running: {
            branchSwitch: '正在切換分支…',
            branchCreate: '正在建立分支…',
            stashCreate: '正在暫存你的變更…',
            discard: '正在捨棄變更…',
            revert: '正在還原提交…',
            generic: '處理中…',
        },
        done: {
            untouched: ({ count, formatted }) => (count === 1 ? `你未提交的 1 項變更保持不變` : `你未提交的 ${formatted} 項變更保持不變`),
            commit: '已提交',
            commitFiles: ({ count, formatted }) => (count === 1 ? `已提交 1 個檔案` : `已提交 ${formatted} 個檔案`),
            push: '已推送',
            pushCommits: ({ count, formatted }) => (count === 1 ? `已推送 1 個提交` : `已推送 ${formatted} 個提交`),
            upToDate: ({ target }) => `${target} 已是最新`,
            pull: '已拉取',
            pullCommits: ({ count, formatted }) => (count === 1 ? `已拉取 1 個提交` : `已拉取 ${formatted} 個提交`),
            fetch: ({ target }) => `已檢查 ${target}`,
            branchSwitch: '已切換分支',
            branchCreate: '已建立分支',
            stashCreate: '已暫存你的變更',
            discard: '已捨棄變更',
            revert: '已還原提交',
            pullRequest: '拉取請求已就緒',
            generic: '完成',
        },
        failed: {
            unknownTitle: '無法確認結果',
            unknownBody: '機器在 Git 回報前停止回應。再次檢查以查看發生了什麼。',
            origin: 'origin',
            thisMachine: '這台機器',
            refreshTitle: '已提交，但清單未重新整理',
            refreshBody: '你的提交很安全。重試即可看到目前的變更。',
            rejectedTitle: ({ target }) => `${target} 有你沒有的提交`,
            rejectedBody: '擷取它們以查看變化。你的提交會留在這台機器上，直到你再次推送。',
            authTitle: ({ machine, provider }) => `${provider} 未接受來自 ${machine} 的登入`,
            authBody: ({ machine }) => `${machine} 上的 Git 沒有此遠端的有效憑證。請在那裡登入後重試。`,
            offlineTitle: ({ machine }) => `${machine} 已離線`,
            offlineBody: '那裡目前無法執行任何動作。你的工作在那台機器上很安全。',
            conflictTitle: '因變更衝突而停止',
            conflictBody: '部分檔案在兩側都有變更。解決後再繼續。',
            networkTitle: ({ target }) => `無法連線到 ${target}`,
            networkBody: '機器無法連線到遠端。請檢查網路後重試。',
            commitTitle: '提交未完成',
            pushTitle: '推送未完成',
            pullTitle: '拉取未完成',
            fetchTitle: '無法檢查新提交',
            pullRequestTitle: '未建立拉取請求',
            genericTitle: '動作未完成',
        },
        recover: {
            open: '開啟',
            tryAgain: '重試',
            fetch: '擷取',
            checkAgain: '再次檢查',
            showConflicts: '顯示衝突',
        },
        timeline: {
            title: '時間軸',
            now: '現在',
            loading: '正在讀取歷史…',
            uncommitted: ({ count, formatted }) => (count === 1 ? `1 項變更未提交` : `${formatted} 項變更未提交`),
            selected: ({ count, formatted }) => (count === 1 ? `已為下次提交選取 1 項` : `已為下次提交選取 ${formatted} 項`),
            nothingSelected: '未選取',
            earlierToday: '今天稍早',
            yesterday: '昨天',
            older: '更早',
            justNow: '剛剛',
            toPull: '待拉取',
            originFurther: ({ name }) => `${name} 在更早的位置`,
            originA11y: ({ name }) => `${name} 在這裡`,
        },
        clean: {
            titleUpToDate: '全部已提交並推送',
            titleCommitted: '全部已提交',
            bodyUpToDate: ({ branch, upstream }) => `${branch} 與 ${upstream} 一致。此工作階段的新變更會顯示在這裡。`,
            body: '此工作階段的新變更會顯示在這裡。',
            createPullRequest: '建立拉取請求',
            openPullRequest: ({ number }) => `開啟拉取請求 #${number}`,
            lastCommit: ({ when }) => `最近提交 ${when}`,
        },
        conflicts: {
            skip: '略過此提交',
            askAgentTask: ({ files, operation }) => `解決 ${files} 中的${operation}衝突。保留雙方的意圖，編輯並暫存已解決的檔案，然後停下來等我審閱。不要繼續、中止、提交或推送，也不要整體選擇某一方。`,
            revert: '還原',
            cherryPick: '揀選',
            merge: '合併',
            rebase: '重訂基底',
            stopped: ({ count, formatted, operation }) => (count === 1 ? `${operation}已停止：1 個檔案在兩側都有變更` : `${operation}已停止：${formatted} 個檔案在兩側都有變更`),
            readyToContinue: ({ operation }) => `所有衝突已解決。繼續${operation}。`,
            filesInConflict: ({ count, formatted }) => (count === 1 ? `1 個檔案有衝突` : `${formatted} 個檔案有衝突`),
            body: '開啟「需要你處理」中的每個檔案，或請代理來解決。',
            continueBody: '在你繼續之前不會提交任何內容。',
            askAgent: '請代理解決',
            continue: ({ operation }) => `繼續${operation}`,
            abort: ({ operation }) => `中止${operation}`,
            abortTitle: ({ operation }) => `要中止${operation}嗎？`,
            abortBody: '分支會回到開始前的狀態。目前的解決結果將遺失。',
            needsYou: '需要你處理',
            mergedCleanly: '已順利合併',
        },
        commit: {
            selectFirst: '選取要提交的檔案',
        },
        tools: {
            title: '遠端與合併',
            subtitle: '新增遠端，合併或重訂分支基底',
        },
    },
    paused: { reason: '工作階段已暫停', resume: '繼續' },
    notRepository: {
        title: '在這裡追蹤代理的變更',
        body: ({ folder }) => `${folder} 還不是儲存庫。建立一個即可檢閱、提交和復原每項變更。`,
        bodyUnnamed: '此資料夾還不是儲存庫。建立一個即可檢閱、提交和復原每項變更。',
    },
};

const sessionGitPaneTranslations = { zhHant: withFidelity(zhHant) };

return { sessionGitPaneTranslations };
})();

const Domain_sessionGitPullRequestTranslations = (() => {
type ProviderArgs = Shared_sessionGitPullRequestTranslations.ProviderArgs;

type GitPullRequestCopy = Shared_sessionGitPullRequestTranslations.GitPullRequestCopy;

const en = Shared_sessionGitPullRequestTranslations.en;

const zhHant: GitPullRequestCopy = {
    form: {
        title: '新增拉取請求', expand: '在詳細資料面板中開啟', moveBack: '移回側邊欄',
        close: '關閉表單（草稿會保留）', base: '合併到', titlePlaceholder: '標題',
        bodyPlaceholder: '改了什麼，為什麼改', draft: '草稿', create: '建立拉取請求', creating: '正在建立…',
        continueOn: ({ provider }) => `在 ${provider} 上繼續`, pointer: '新的拉取請求已在詳細資料中開啟', pointerShow: '顯示',
        openedProviderPage: ({ provider }) => `已開啟 ${provider} 以完成它；你的文字保留在這裡。`,
    },
    failure: {
        authFailed: ({ provider }) => `${provider} 未接受這台機器的登入`,
        network: ({ provider }) => `無法連線到 ${provider}`,
        machineOffline: '機器已離線；草稿會保留',
        blocked: '另一個 Git 操作正在進行；完成後再試',
        other: '拉取請求未建立',
    },
    card: {
        number: ({ number }) => `#${number}`, intoBase: ({ base }) => `合併到 ${base}`,
        state: { open: '開啟', draft: '草稿', merged: '已合併', closed: '已關閉', unknown: '拉取請求' },
        checks: { pending: '檢查進行中', success: '檢查通過', failure: '檢查失敗', unknown: '檢查' },
        openOn: ({ provider }) => `在 ${provider} 上開啟`, copyLink: '複製連結', copied: '連結已複製',
    },
    settings: {
        placementTitle: '新拉取請求開啟位置', placementDescription: '在手機上，表單一律以獨立頁面開啟。',
        sidebar: '側邊欄', details: '詳細資料面板',
    },
};

const sessionGitPullRequestTranslations = { zhHant };

return { sessionGitPullRequestTranslations };
})();

const Domain_sessionHomeFreshnessTranslations = (() => {
const en = Shared_sessionHomeFreshnessTranslations.en;

const translated = Shared_sessionHomeFreshnessTranslations.translated;

const sessionHomeFreshnessTranslations = { 'zh-Hant': translated({
        offline: '離線',
        stale: '無法重新整理',
        lastUpdated: ({ ago }) => `${ago}前更新`,
    }) };

return { sessionHomeFreshnessTranslations };
})();

const Domain_sessionListFilterTranslations = (() => {
const en = Shared_sessionListFilterTranslations.en;

const translated = Shared_sessionListFilterTranslations.translated;

const sessionListFilterTranslations = { zhHant: translated({
        filtersTitle: '工作階段篩選', filtersSearch: '搜尋篩選條件…', filtersShow: '顯示',
        filtersScope: '範圍', filtersShowSessions: '工作階段', filtersShowRuns: '執行', filtersShowBoth: '兩者',
        filtersShowBothSummary: '工作階段和執行', filtersStartedByNone: '未選擇發起者',
        filtersStartedBy: '發起者', filtersStartedByYou: '你', filtersStartedByTriggers: '觸發器', filtersStartedByAgents: '代理',
        filtersRunsNeedingYouAlwaysShow: '需要你處理的執行一律顯示',
        filtersMyWork: '我的工作', filtersLegacyOwnerDirect: '我的工作', filtersAssignedToMe: '指派給我', filtersFollowing: '正在關注',
        filtersInvolvingMe: '與我相關', filtersAllAccessible: '所有可存取', filtersAttention: '待處理',
        filtersAttentionAny: '不限', filtersAttentionNeedsMe: '僅顯示需要我處理的工作階段', filtersScopeNeedsMe: '需要我處理',
        filtersInactive: '非活躍工作階段', filtersInactiveShow: '顯示', filtersInactiveHide: '隱藏',
        filtersHomes: 'Home', filtersSharedWith: '共享對象', filtersOutsideTeams: '個人和直接共享',
        filtersTags: '標籤', filtersSource: '來源', filtersSourceAll: '全部',
        filtersSourceDirect: '外部',
        filtersNoOptions: '沒有可用的篩選條件', filtersClear: '清除篩選條件', filtersDone: '完成', filtersArchived: '已封存',
        filtersNeedsMeOnly: '僅需要我處理的', filtersNeedsMeOnlyDescription: '等待你處理的工作階段', filtersSourceHappier: 'Happier',
        filtersMoreTags: ({ count }: { count: number }) => `+ ${count} 更多`,
        filtersResultCount: ({ count }: { count: number }) => `${count} 個項目`,
        queryInitialLoadingTitle: '正在載入工作階段…', queryUpdatingTitle: '正在更新工作階段…',
        querySomeHomesUnavailableTitle: '部分 Home 無法使用', querySomeHomesUnavailableDescription: 'Happier 正在顯示可存取的內容。請在這些 Home 恢復連線後再試一次。',
        queryRefreshFailedTitle: '無法重新整理', queryRefreshFailedRetainedDescription: '已載入的工作階段仍會保留。請重試以檢查更新。', queryRefreshFailedEmptyDescription: 'Happier 無法從所選 Home 載入工作階段。請在它們恢復可存取後再試一次。',
        queryNoMatchesLoadedTitle: '已載入的工作階段中沒有相符項目', queryNoMatchesLoadedDescription: '較早的頁面中可能還有相符的工作階段。', querySearchOlder: '搜尋較早的工作階段',
        queryMoreAvailableTitle: '可能還有更多工作階段', queryMoreAvailableDescription: '此檢視包含已載入的工作階段。搜尋較早的工作階段以繼續。',
        queryNoMatchesTitle: '沒有相符的工作階段', queryNoMatchesDescription: '請嘗試變更目前的篩選條件。',
        queryTeamEmptyTitle: '此團隊尚無工作階段', queryTeamEmptyDescription: '與此團隊共享的工作階段將顯示在這裡。',
        queryMyWorkEmptyTitle: '「我的工作」中沒有內容', queryScopeEmptyDescription: '請嘗試擴大範圍或稍後再回來查看。', queryBrowseAllAccessible: '顯示所有工作階段',
        queryAssignedEmptyTitle: '沒有指派給你的工作階段', queryFollowingEmptyTitle: '沒有關注中的工作階段', queryInvolvingEmptyTitle: '沒有與你相關的工作階段',
        queryAttentionEmptyTitle: '沒有工作階段需要你處理', queryReachableEmptyTitle: '沒有可用的工作階段', queryReachableEmptyDescription: '可存取的 Home 中沒有工作階段符合此檢視。',
        queryHistoricalSharesWithheldTitle: '部分共享的工作階段已隱藏', queryHistoricalSharesWithheldDescription: '透過較早版本 Happier 與你共享的工作階段會保持隱藏，直到其擁有者在 Happier 中更新它們。',
        partialHomeNotMountedTitle: ({ home }) => `${home} 不在此工作階段檢視中`,
        partialHomeNotMountedDescription: '將此 Home 加入可見的 Home 群組，以在不變更焦點的情況下顯示團隊工作階段。',
        partialShowFromHome: ({ home }) => `顯示 ${home} 中的工作階段`,
        teamListingUnavailableTitle: '此 Home 無法使用團隊工作階段清單',
        teamListingUnavailableDescription: '此 Home 尚無法列出團隊工作階段。請更新或重新設定該 Home，然後再試一次。',
        teamListingLoadingTitle: ({ team }) => `正在載入 ${team} 的工作階段…`,
        teamListingLoadingDescription: 'Happier 正在檢查此 Home 可以列出的內容。',
        teamListingProbeFailedTitle: '無法連線至此 Home',
        teamListingProbeFailedDescription: 'Happier 無法向此 Home 查詢團隊工作階段。請在可連線時再試一次。',
    }) };

return { sessionListFilterTranslations };
})();

const Domain_sessionMessageAccountActorTranslations = (() => {
type AccountActorTranslations = Shared_sessionMessageAccountActorTranslations.AccountActorTranslations;

const sessionMessageAccountActorTranslations: Pick<Record<SupportedLanguage, AccountActorTranslations>, "zh-Hant"> = { 'zh-Hant': { accountActorYou: '你', accountActorFormerMember: '前成員', accountActorUnnamedMember: 'Happier 成員', accountActorSentBy: ({ name }) => `傳送者：${name}` } };

return { sessionMessageAccountActorTranslations };
})();

const Domain_sessionPageTranslations = (() => {
const english = Shared_sessionPageTranslations.english;

const translated = Shared_sessionPageTranslations.translated;

const sessionPageTranslations = { 'zh-Hant': translated({
        sessionPages: {
            info: {
                continueTitle: '繼續',
                continueDescription: '從此工作階段目前的進度開始新的工作。',
                organizeTitle: '整理',
                organizeDescription: '此工作階段在你的清單中出現的位置。',
                activityDescription: '代理正在做什麼，以及你是否會收到通知。',
                detailsTitle: '詳細資料',
                detailsDescription: '供支援與腳本使用的識別碼與歷程。',
                environmentTitle: '環境',
                environmentDescription: '此工作階段執行所用的機器、資料夾與代理。',
                agentStateDescription: '誰在操控代理，以及它在等待什麼。',
                relatedTitle: '相關',
                relatedDescription: '此工作階段的其他頁面。',
                developerTitle: '開發者',
                developerDescription: '用於除錯的原始資料，在開發者模式下顯示。',
                leaveLabel: '停止、封存或刪除',
                leaveFootnote: '停止會結束正在執行的程序。封存的工作階段可以還原。刪除會永久移除工作階段及其訊息。',
            },
            follow: {
                description: '選擇此工作階段是否通知你，以及是否透過語音播報。',
            },
            permissions: {
                description: '你從其他裝置為此工作階段允許的工具。撤銷不再需要的授權。',
            },
            automations: {
                description: '依排程、事件或在回合結束時於此工作階段中執行的工作。',
            },
            newRun: {
                description: '從此工作階段啟動子代理執行。',
                transcriptReadOnly: '這是已儲存的歷程。重新連線到此 Home 以繼續對話。',
                daemonReadOnly: '此歷程來自 Agent 程序。重新連線到此 Home 以繼續對話。',
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
>, "zh-Hant"> = { 'zh-Hant': {
        due: '提醒時間已到',
        title: '提醒我', inOneHour: '1 小時後', inThreeHours: '3 小時後',
        tomorrowMorning: '明天早上', nextWeek: '下週', custom: '選擇日期和時間…',
        customTitle: '選擇日期和時間',
        customPlaceholder: '2026-09-08 09:00', futureTimeRequired: '請選擇未來的時間。',
        setReminder: '設定提醒',
        reminderSaved: '提醒已儲存',
        presetSaveFailedAfterReminder: '提醒已儲存，但預設儲存結果未能確認。請重試或關閉。',
        presetsSaveFailed: '未能確認預設儲存結果。變更仍保留在此處，請重試。',
        presetsChanged: '已儲存的預設與開啟時的清單不同。請關閉並重新開啟以查看最新清單。',
        remove: '移除提醒',
        dateLabel: '日期', timeLabel: '時間', addToPresets: '加入預設', presetPreviewUnavailable: '請選擇有效的未來時間以預覽預設。', managePresets: '管理預設', managePresetsMessage: '重新命名、排序或移除已儲存的提醒選項。', presetName: '預設名稱', movePresetUp: '上移預設', movePresetDown: '下移預設', renamePresetLabel: ({ preset }) => `重新命名「${preset}」`, movePresetUpLabel: ({ preset }) => `將「${preset}」上移`, movePresetDownLabel: ({ preset }) => `將「${preset}」下移`, deletePresetLabel: ({ preset }) => `刪除「${preset}」`, noPresets: '沒有已儲存的預設', noPresetsMessage: '下次選擇自訂提醒時即可儲存。',
    } };

return { sessionReminderTranslations };
})();

const Domain_sessionRemotePermissionGrantTranslations = (() => {
type SessionRemotePermissionGrantTranslations = Shared_sessionRemotePermissionGrantTranslations.SessionRemotePermissionGrantTranslations;

const sessionRemotePermissionGrantTranslations = { 'zh-Hant': {
        title: '遠端權限授予',
        entryTitle: '遠端權限授予',
        entrySubtitle: '檢視及撤銷工作階段範圍的遠端授予',
        loadingTitle: '正在載入遠端權限授予',
        loadingReason: '正在檢查目前工作階段擁有者的授予。',
        emptyTitle: '沒有遠端權限授予',
        emptyReason: '此工作階段沒有可檢視的遠端授予。',
        unavailableTitle: '遠端權限授予無法使用',
        unavailableReason: '請確認這是目前工作階段擁有者且其機器可用，然後再試一次。',
        ownerOnlyTitle: '只有工作階段擁有者可以管理遠端授予',
        ownerOnlyReason: '共用參與者可回應符合條件的提示，但無法檢視或撤銷工作階段擁有者的授予。',
        retry: '重試',
        listTitle: '工作階段授予',
        grantActive: ({ actor }) => `來自 ${actor} 的有效授予`,
        grantRevoked: ({ actor }) => `來自 ${actor} 的已撤銷授予`,
        grantDetail: ({ grantId, sourceRef, sourceRevisionOrEpoch }) => `授予 ${grantId} · 來源 ${sourceRef} （${sourceRevisionOrEpoch}）`,
        revoke: '撤銷授予',
        revoking: '正在撤銷…',
        revokeConfirmTitle: '要撤銷遠端權限授予嗎？',
        revokeConfirmBody: ({ identifier }) => `這會立即撤銷 ${identifier} 的遠端授予。`,
        revokeFailedTitle: '無法更新遠端權限授予',
        revokeFailedReason: '授予可能已變更，或擁有者機器無法使用。請重試。',
        loadMore: '載入更多授予',
        loadingMore: '正在載入更多授予…',
        loadMoreFailedReason: '無法載入更多授予。請重試。',
    } } as const satisfies Pick<Readonly<Record<string, SessionRemotePermissionGrantTranslations>>, "zh-Hant">;

return { sessionRemotePermissionGrantTranslations };
})();

const Domain_sessionResponsibilityTranslations = (() => {
type SessionResponsibilityTranslations = Shared_sessionResponsibilityTranslations.SessionResponsibilityTranslations;

const en = Shared_sessionResponsibilityTranslations.en;

const sessionResponsibilityTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionResponsibilityTranslations
>, "zh-Hant"> = { 'zh-Hant': {
        responsibilitySectionTitle: '負責人',
        responsibilityRowTitle: '負責人',
        responsibilityNoOne: '無人',
        responsibilityUnnamedPerson: '未命名使用者',
        responsibilityPickerTitle: '選擇負責人',
        responsibilitySearchPlaceholder: '搜尋有存取權的人',
        responsibilityAssignToMe: '指派給我',
        responsibilityPeopleWithAccess: '有存取權的人',
        responsibilityAccessHintOwner: '擁有者',
        responsibilityNoCandidates: '目前還沒有其他人可以存取此工作階段。',
        responsibilityAccessChanged: '存取權已變更。此人不能再被設為負責人。',
        responsibilityUpdateFailed: 'Happier 無法更新負責人。請重試。',
        responsibilityApprovalPending: '正在等待核准。目前尚未變更，核准後將更新負責人。',
        responsibilityA11yEditable: ({ name }: { name: string }) =>
            `負責人：${name}。變更負責人。`,
        responsibilityA11yReadOnly: ({ name }: { name: string }) => `負責人：${name}。`,
        responsibilityA11yEmpty: '負責人：無人。變更負責人。',
        responsibilityAssignedToYou: '已指派給你',
        responsibilitySharedWithYou: '已與你共用',
    } };

return { sessionResponsibilityTranslations };
})();

const Domain_sessionWorkTranslations = (() => {
const en = Shared_sessionWorkTranslations.en;

const zhHant: typeof en = {
    scheduled: {
        title: "已排程",
        writesHere: "寫入此處",
        empty: "沒有排程寫入此處的工作流程。",
        step: ({ ordinal, title }) => `步驟 ${ordinal} · ${title}`,
        provenanceWorkflowStep: ({ source, step }) => `來自 ${source} · 步驟 ${step}`,
        notifyOnlyReported: "僅在代理程式回報了內容時",
        notifyOnlyReportedDescription: "代理程式未傳回文字時略過通知。",
        notifyOnlyReportedNeedsResult: "使用先前代理程式步驟的文字結果作為訊息。",
    },
    workerUpdate: {
        state: {
            settled: "已完成本輪",
            needsYou: "需要你",
            stalled: "已停滯",
            published: "已發布",
            failed: "失敗",
            stopped: "已停止",
            timedOut: "已逾時",
            finished: "已完成",
        },
        peek: "速覽",
        truncated: "結果已縮短。",
        wokenBy: ({ count }) => (count === 1 ? '由一則更新喚醒' : `由 ${count} 則更新喚醒`),
        notFromYou: '不是你傳送的訊息',
    },
    title: '工作',
    subtitle: {
        sessions: ({ count }) => `${count} 個工作階段`,
        runs: ({ count }) => `${count} 次執行`,
        nothingStarted: '尚未開始任何工作',
    },
    states: {
        recent: '最近',
    },
    view: {
        a11y: '工作檢視',
        list: '清單',
        map: '地圖',
        expandMap: '在工作階段旁開啟地圖',
    },
    map: {
        positionUnder: ({ position, total, parent }) => `${parent} 下的第 ${position}/${total} 項`,
    },
    actions: {
        showInTranscript: '在對話記錄中顯示',
        makeOrchestrator: '設為編排者',
        makeOrchestratorSubtitle: '此工作階段負責規劃、委派並回報',
        makeOrchestratorFailed: "無法將此工作階段設為編排者",
    },
    putUnder: {
        title: "置於…之下",
        subtitle: "向另一個工作階段回報",
        search: "尋找工作階段",
        topLevel: "最上層 — 不向任何工作階段回報",
        errors: {
            cycle: "該工作階段已向此工作階段回報",
            changed: "此工作階段剛被移動，請再試一次",
            forbidden: "無法將其置於該工作階段之下",
            failed: "無法移動此工作階段",
        },
    },
    kinds: {
        session: '工作階段',
        workflowRun: '工作流程執行',
        backgroundRun: '背景執行',
    },
    showMore: ({ count }) => `再顯示 ${count} 項`,
    role: {
        none: '無',
        handsOff: '只委派',
        a11y: ({ role }) => `角色：${role}。變更角色`,
    },
    empty: {
        title: '尚未開始工作',
        reason: '此工作階段啟動的工作階段、工作流程和背景執行會顯示在這裡，需要你處理的事項也會一併顯示。',
    },
    row: {
        a11y: ({ title, status }) => `${title}，${status}`,
    },
    progress: ({ completed, total }) => `${completed} / ${total}`,
    strip: {
        openInSidebar: '在側邊欄中開啟',
        stillWorking: ({ count }) => `${count} 項仍在進行`,
        needsYou: ({ count }) => `${count} 項需要你`,
        a11y: ({ summary }) => `工作：${summary}`,
    },
    leadArchived: ({ count }) => `此工作階段已封存 · ${count} 項仍在進行`,
    runsStale: '工作流程執行可能不是最新的',
    list: {
        level: ({ level }) => `第 ${level} 層`,
        subSessions: ({ count }) => `${count} 個子工作階段`,
        showReports: ({ name, count }) => (count > 0 ? `顯示 ${name} 下的 ${count} 個工作階段` : `顯示 ${name} 下的工作階段`),
        hideReports: ({ name }) => `隱藏 ${name} 下的工作階段`,
        reportsWorking: ({ count }) => `${count} 個進行中`,
        reportsNeedYou: ({ count }) => `${count} 個子工作階段需要你`,
    },
    archive: {
        alsoArchiveReports: ({ count }) => `同時封存 ${count} 個子工作階段`,
        someNotArchivedTitle: ({ count }) => `有 ${count} 個子工作階段未封存`,
    },
    step: {
        drivenBy: "由工作流程驅動",
        partOf: ({ run }) => `屬於 ${run}`,
        checkedByWorkflow: "工作流程會檢查此步驟的結果，因此觸發器、目標和第二意見不會在此工作階段中執行。",
        nothingStarted: "此步驟未啟動任何內容。",
    },
    peek: {
        reportsTo: ({ lead }) => `向 ${lead} 回報`,
        repliesGoHere: '回覆會傳送到此工作階段',
    },
};

const notify = { zhHant: { turn: '此回合結束時通知我', attention: '需要我處理時通知我', armed: '屆時會通知你', cancel: '取消通知', failed: '無法更新通知，請重試。', turnFinished: '此工作階段的本回合已結束。', needsYou: '此工作階段需要你處理。', settings: '通知設定' } };

const runNotify = { zhHant: { run: '結束時通知我', runFinished: '此執行已結束。', runNeedsYou: '此執行需要你處理。', setup: '設定通知' } };

const sessionWorkTranslations = { zhHant: { ...zhHant, notify: { ...notify.zhHant, ...runNotify.zhHant } } };

return { notify, runNotify, sessionWorkTranslations };
})();

const Domain_settingsConnectionsTranslations = (() => {
type MachineParams = Shared_settingsConnectionsTranslations.MachineParams;

const en = Shared_settingsConnectionsTranslations.en;

const zhHant = {
    sectionTitle: '連線',
    sectionDescription: '你的裝置如何連線到你的機器。',
    directTitle: '盡可能直接連線',
    directOnDescription: '當裝置之間可以互相連線時，預覽、即時畫面和檔案傳輸會直接在裝置之間傳送，否則透過 Happier。',
    directOffDescription: '所有內容都透過 Happier。不會直接連線到你的機器；在同一網路中會稍慢一些。',
    serverDenied: '你的 Home 伺服器讓所有內容都透過 Happier，因此這裡無需選擇。',
    machineSectionTitle: '連線',
    machineTitle: ({ machine }: MachineParams) => `連線到 ${machine}`,
    machineOptionDefault: '預設',
    machineOptionDirect: '直接',
    machineOptionRelay: '透過 Happier',
    machineDefaultDescription: ({ machine }: MachineParams) => `跟隨你的帳戶：可以連線到 ${machine} 時直接連線，否則透過 Happier。`,
    machineDefaultOffDescription: '跟隨你的帳戶：一律透過 Happier。',
    machineDirectDescription: ({ machine }: MachineParams) => `可以連線到 ${machine} 時直接連線，即使你的帳戶設定不同。`,
    machineRelayDescription: '一律透過 Happier，即使在同一網路中。',
};

const settingsConnectionsTranslations = { zhHant };

return { settingsConnectionsTranslations };
})();

const Domain_settingsMachinesTranslations = (() => {
const en = Shared_settingsMachinesTranslations.en;

const zhHant: typeof en = {
    scopeChooseComputer: '選擇電腦',
    scopeSetUpComputer: '設定電腦',
    scopeOffline: ({ machine }: { machine: string }) => `${machine} 已離線。`,
    defaultsTitle: "機器預設設定",
    localVirtualMachines: "本機虛擬機器",
    runningOnly: "僅執行時計費的雲端機器",
    stoppedBilled: "停止時仍計費的雲端機器",
    billingUnknown: "計費方式未知",
    pageDescription: '執行工作階段的電腦，以及在它們之間進行選擇的機器池。',
    thisComputerTitle: '這台電腦',
    thisComputerRowSubtitle: '背景服務和命令列',
    thisComputerPageDescription: '此裝置上的 Happier 背景服務和命令列。',
    setupSectionTitle: '設定',
    setupRowSubtitle: '在此安裝 Happier 並將其連線到你的 Home。',
    addPageDescription: '連線一台電腦，讓代理程式在其上執行你的工作階段。',
    addFromComputerTitle: '從電腦新增機器',
    addFromComputerDescription: '在要新增的電腦上開啟 Happier，或在桌面版或瀏覽器中的 Happier 透過 SSH 連線一台。',
    searchPlaceholder: '搜尋機器',
    count: ({ count }: { count: number }) => `${count} 台機器`,
    daemonTitle: '背景服務',
    daemonDescription: '在這台電腦上執行你的工作階段，並保持它與 Home 的連線。',
    unreadableTitle: ({ home }: { home: string }) => `無法讀取 ${home} 上的機器`,
};

const settingsMachinesTranslations = { zhHant };

return { settingsMachinesTranslations };
})();

const Domain_settingsOverviewTranslations = (() => {
type SettingsOverviewTranslation = Shared_settingsOverviewTranslations.SettingsOverviewTranslation;

const slavicPlural = Shared_settingsOverviewTranslations.slavicPlural;

const settingsOverviewTranslations = { 'zh-Hant': {
        attentionTitle: '需要你處理',
        agentNeedsSignIn: ({ agent, machine }) => `${agent} 需要在 ${machine} 上登入`,
        agentNeedsSignInNoMachine: ({ agent }) => `${agent} 需要登入`,
        serviceSignInExpired: ({ service }) => `${service} 登入已過期`,
        signIn: '登入',
        signInAgain: '重新登入',
        setupTitle: '開始設定',
        setupProgress: ({ done, total }) => `${done}/${total}`,
        setupActionSaveKey: '儲存金鑰',
        setupActionAddMachine: '新增機器',
        setupActionShowQr: '顯示 QR 碼',
        setupActionScan: '掃描',
        setupActionPasteLink: '貼上連結',
        setupActionBrowse: '瀏覽',
        machineUpdateVersions: ({ current, latest }) => `此機器上為 Happier ${current} · 可更新至 ${latest}`,
        connectTerminalTitle: '連接終端機',
        connectTerminalSubtitle: '掃描終端機顯示的代碼，或貼上它的連結。',
        quickSettingsTitle: '快速設定',
        notificationsPushOn: '推播已開啟',
        notificationsPushOff: '推播已關閉',
        notificationsQuietHours: '勿擾時段已開啟',
        pluginChangesAwaitingReview: ({ count }) => `${count} 個外掛變更等待你審核`,
        review: '審核',
        browsePluginsTitle: '瀏覽外掛',
        browsePluginsSubtitle: '為 Happier 新增工具、面板和整合。',
        accountServiceSignedIn: ({ service }) => `已登入 ${service}`,
        aboutDescription: '版本、原始碼和法律條款（Happier 與 Anthropic 無關聯）。',
        machinesTitle: '裝置',
        machineOnline: '線上',
        machineOffline: ({ lastSeen }) => `離線 · 最後上線 ${lastSeen}`,
        machineUpdateAvailable: '有可用更新',
        machinesOnlineCount: ({ count }) => `${count} 在線`,
        machinesOfflineCount: ({ count }) => `${count} 離線`,
        machineLastSeen: ({ lastSeen }) => `上次上線 ${lastSeen}`,
        update: '更新',
        asOf: ({ time }) => `截至 ${time}`,
        usageTitle: '用量',
        usageLeft: ({ percent }) => `剩餘 ${percent}%`,
        usageResets: ({ time }) => `${time} 重設`,
        securityTitle: '安全',
        startSessionLabel: '開始工作階段',
        saveRecoveryKeyTitle: '儲存復原金鑰',
        saveRecoveryKeySubtitle: '遺失所有裝置時取回加密資料的唯一方式。',
        addMachineTitle: '新增裝置',
        addMachineSubtitle: '連接一台執行你的代理的電腦。',
        homeGreetingNamed: ({ name }) => `歡迎回來，${name}。`,
        homeStartSection: '開始工作階段',
        homeCustomize: '自訂首頁',
        homeCustomizeDescription: '選擇首頁顯示哪些區塊以及它們的順序。',
        homeAlwaysShown: '永遠顯示',
        homeShowSection: '顯示',
        homeHideSection: '隱藏區塊',
        homeSectionOptions: '區塊選項',
        homeResetLayout: '恢復預設',
        homeLayoutSectionTitle: '首頁',
        homeAddWidgetsTitle: '新增小工具',
        homeAddWidgetsDescription: '外掛提供的小工具。新增後會顯示在首頁上。',
        homeWidgetFromPlugin: ({ plugin }) => `來自 ${plugin}`,
        homeRemoveWidget: '從首頁移除',
    } } satisfies Pick<Readonly<Record<string, SettingsOverviewTranslation>>, "zh-Hant">;

return { settingsOverviewTranslations };
})();

const Domain_settingsProfilesRemoteHostsPageTranslations = (() => {
const english = Shared_settingsProfilesRemoteHostsPageTranslations.english;

const translated = Shared_settingsProfilesRemoteHostsPageTranslations.translated;

const settingsProfilesRemoteHostsPageTranslations = { 'zh-Hant': translated({
        settingsProfilesPage: {
            pageDescription: '新工作階段可以使用的啟動設定：代理、模型、環境變數以及執行位置。',
            useProfilesSection: '設定檔選擇',
            useProfilesSectionDescription: '開始工作階段時選擇一個設定檔，或讓每個工作階段都使用機器的環境。',
            useProfiles: '使用設定檔',
            useProfilesOffDescription: '已關閉。新工作階段使用機器的環境。',
            favoritesDescription: '選擇設定檔時最先顯示。',
            customDescription: '你建立的設定檔。編輯內建設定檔時，會在這裡儲存你自己的副本。',
            builtInDescription: '為每個代理準備的現成設定檔。',
        },
        settingsRemoteHostsPage: {
            pageDescription: '這台電腦可以設定為機器、連線或在其上執行中繼的 SSH 主機。',
            savedHostsSection: '已儲存的主機',
            savedHostsDescription: "最近使用的排在前面。開啟主機即可使用或修改。",
            hostPageDescription: "這台電腦可以設定為機器、連線或在其上執行中繼的 SSH 主機。",
            newHostTitle: "新的遠端主機",
            newHostDescription: "為主機命名，並說明如何透過 SSH 存取它。",
            useSection: "使用此主機",
            useSectionDescription: "此裝置可以用它做什麼。",
            maintenanceSection: "此主機上的 Happier",
            maintenanceSectionDescription: "在那裡安裝、更新並執行 Happier 的命令列、背景服務和中繼。",
            discard: "捨棄",
            accessTitle: "金鑰與連線",
            accessRowSubtitle: "受信任的主機金鑰和已開啟的通道",
            accessPageDescription: "此裝置信任的主機金鑰，以及通往你的主機的通道和存取途徑。",
            hostNotFound: "此主機已不再儲存。",
            unavailableDescription: '已儲存的 SSH 主機可以設定為機器或用作中繼。',
            trustedHostKeysDescription: '此裝置在連線時接受的金鑰。移除某個金鑰後，下次連線時會再次詢問。',
            trustedHostKeysEmpty: '還沒有受信任的主機金鑰。連線時接受金鑰後，它會顯示在這裡。',
            sshTunnelsDescription: '從此裝置到已儲存主機的已開啟通道。',
        },
    }) };

return { settingsProfilesRemoteHostsPageTranslations };
})();

const Domain_settingsProvidersTranslations = (() => {


const withProviderSharedFields = Shared_settingsProvidersTranslations.withProviderSharedFields;

const zhHant = {
    title: '供應商', entrySubtitle: '連接雲端和本機模型來源', detailTitle: '供應商連線', configuredTitle: '你的供應商', configuredFooter: '已啟用供應商的模型會顯示在相容代理程式的模型選擇器中。', availableTitle: '可用', availableFooter: '只需新增一次供應商，即可在所有相容代理程式中使用其模型。', customTitle: '自訂供應商', customFooter: '連接公司閘道或其他相容的模型端點。', addCustom: '新增自訂供應商', addCustomDescription: '使用與 OpenAI 或 Anthropic 相容的端點', emptyTitle: '尚未連接供應商', emptyDescription: '從下方選擇可用供應商，或新增你自己的端點。', unavailable: '供應商無法使用', unavailableDescription: '此伺服器尚未啟用供應商連線。', noMachine: '沒有可用的機器', noMachineDescription: '請連接一台機器以設定和測試供應商。', problemTitle: '供應商需要處理', searchPlaceholder: '搜尋供應商',
    status: { available: '已連接', notChecked: '未檢查', needsAttention: '需要處理', unreachable: '無法連線', disabled: '已關閉', sourceUnavailable: '外掛程式無法使用' }, kind: { frontier: '模型供應商', aggregator: '模型目錄', cloud: '雲端供應商', local: '在此機器上執行' },
    detail: { pickSecretTitle: '選擇 API 金鑰', notFoundTitle: '找不到供應商', notFoundDescription: '此供應商連線已不存在。', deletedDescription: '此供應商已移除。恢復使用它的工作階段前，請選擇其他模型。', sourceAvailable: '供應商外掛程式可用', connectionTitle: '連線', connectionFooter: '控制可以使用此供應商的位置並檢查目前狀態。', accountAccess: '在所有機器上使用', accountAccessDescription: '此供應商解析至公開端點時皆可使用', testConnection: '測試連線', testDescription: '檢查端點並重新整理模型目錄', testSucceeded: '連線成功', testNotSupported: '此供應商不支援自動連線測試', machinesTitle: '機器', machinesFooter: '本機和私人端點必須在每台機器上分別啟用。', currentMachine: '目前機器', selectMachineToManage: '選擇此機器以檢視和變更其存取權', targetMachine: '目標機器', machineOnline: '在線上', machineOffline: '離線', apiKeyTitle: 'API 金鑰', apiKeyFooter: '金鑰保存在「已儲存的祕密」中，絕不會顯示於此。', accountApiKey: '預設 API 金鑰', machineApiKey: '此機器上的 API 金鑰', apiKeyConfigured: '已設定', apiKeyMissing: '新增金鑰以連接', apiKeySelected: '已選擇儲存的金鑰', useAccountApiKey: '未設定機器金鑰時使用預設金鑰', modelsTitle: '模型', manageModels: '管理模型', modelsUnknown: '連接後將顯示模型', modelCount: ({ count }: { count: number }) => `${count} 個模型`, actionsTitle: '動作', duplicateTitle: '新增另一個連線', duplicateDescription: '為同一供應商建立個別命名的連線', deleteTitle: '移除供應商', deleteDescription: '現有工作階段會保留歷程記錄，但無法使用此供應商恢復。', advancedTitle: '進階', endpointDefault: '預設端點', endpointMachine: '此機器上的端點', endpointMachineDescription: '僅在此機器執行供應商時覆寫預設值', endpointPrompt: '輸入完整的供應商基礎 URL。', resetEndpoint: '重設端點', resetMachineEndpoint: '在此機器上使用預設端點', resetDefaultEndpoint: '使用供應商外掛程式提供的端點' },
    authoring: { providerTitle: '供應商', builtInDescription: '選擇一個「已儲存的祕密」，然後連接此供應商。', compatibilityTitle: '相容性', compatibilityFooter: '選擇供應商文件中說明的 API 類型。', protocolTitle: 'API 相容性', protocol: { 'openai-responses': { title: '與 OpenAI Responses 相容', description: '適用於實作 Responses API 的閘道' }, 'openai-chat': { title: '與 OpenAI Chat 相容', description: '適用於實作 Chat Completions 的閘道' }, anthropic: { title: '與 Anthropic 相容', description: '適用於實作 Messages API 的閘道' } }, detailsTitle: '供應商詳細資料', name: '名稱', namePlaceholder: '公司閘道', baseUrl: '基礎 URL', baseUrlPlaceholder: 'https://gateway.example.com/v1', modelsPath: '模型路徑', credentialsTitle: '認證資料', credentialsFooter: '請選擇「已儲存的祕密」。切勿將 API 金鑰貼到 URL 或標頭中。', requiresApiKey: '需要 API 金鑰', requiresApiKeyYes: '要求使用「已儲存的祕密」', requiresApiKeyNo: '不使用認證資料即可連接', apiKey: 'API 金鑰', apiKeyDescription: '選擇或建立「已儲存的祕密」', credentialStyleTitle: 'API 金鑰格式', credentialHeader: '標頭名稱', credentialStyle: { bearer: 'Authorization Bearer 權杖', xApiKey: 'x-api-key 標頭', apiKey: 'api-key 標頭', customHeader: '自訂標頭' }, catalogTitle: '模型目錄', catalogFooter: '端點支援時自動取得模型，也可以稍後手動新增。', fetchModels: '自動取得模型', fetchModelsYes: '使用供應商的模型清單端點', fetchModelsNo: '手動新增模型 ID', verifyTitle: '連接', verifyFooter: '可以測試時請先測試，然後儲存供應商。', save: '儲存供應商', connect: '連接供應商' },
    errors: { machineOfflineTitle: "此機器已離線", machineOfflineDescription: "供應商需要在機器上檢查。請選擇另一台機器或啟動此機器，然後重試。", machineTimeoutTitle: "此機器沒有回應", machineTimeoutDescription: "檢查供應商時，此機器沒有回應。請重試。", runCredentialRequiredTitle: "為此 Run 選擇憑證", runCredentialRequiredDescription: "此 Run 無法繼承工作階段的直接憑證。請為 Run 選擇 Team 憑證。", secretMissingTitle: '需要 API 金鑰', secretMissingDescription: '啟用此供應商前，請選擇一個「已儲存的祕密」。', notEnabledOnMachineTitle: '未在此機器上啟用', notEnabledOnMachineDescription: '請在將執行工作階段的機器上啟用此供應商。', disabledTitle: '供應商已關閉', disabledDescription: '使用其模型前請先啟用此供應商。', unreachableTitle: '無法連線至供應商', unreachableDescription: '請檢查服務是否正在執行、端點是否正確，然後再試一次。', notFoundTitle: '找不到供應商', notFoundDescription: '此供應商已移除。請選擇其他供應商或模型。', sourceUnavailableTitle: '供應商外掛程式無法使用', sourceUnavailableDescription: '請重新啟用或安裝提供此連線的外掛程式。', featureDisabledTitle: '供應商無法使用', featureDisabledDescription: '此伺服器尚未啟用供應商連線。', unauthorizedTitle: 'API 金鑰遭拒', unauthorizedDescription: '請以有效金鑰取代「已儲存的祕密」，然後再次測試連線。', rateLimitedTitle: '供應商限制了要求頻率', rateLimitedDescription: '請稍候片刻，再次測試連線。', probeCapacityTitle: '同時進行的供應商檢查過多', probeCapacityDescription: 'Happier 暫時無法在所選機器上啟動此檢查。請稍候片刻，然後再試一次。', genericTitle: '供應商需要處理', genericDescription: '請檢查供應商設定，然後再試一次。' },
    models: { builtIn: '內建', experimental: '實驗性', experimentalConfirmTitle: '使用實驗性模型？', experimentalConfirmBody: ({ provider, model }: { provider: string; model: string }) => `${provider} 的 ${model} 尚未與此代理程式完成全面驗證。如果結果不如預期，你可能需要重新啟動或選擇其他模型。`, experimentalConfirmAction: '使用模型', stale: '可能無法使用', hidden: '已隱藏', manage: '管理模型', empty: '此供應商目前沒有可用模型。', add: '新增模型', addPlaceholder: '每行輸入一個模型 ID', resetVisibility: '重設可見性', showHidden: '顯示隱藏模型', hideHidden: '隱藏已隱藏模型', remove: '移除模型', removeConfirmation: '要移除這個手動新增的模型嗎？', enable: '顯示模型', disable: '隱藏模型', load: '載入模型', retry: '再試一次', connectionUnavailable: '此供應商在所選機器上無法使用。' },
};

const localTranslations = { zhHant: { title: '在此機器上', footer: '在此機器上找到的服務。模型在哪裡執行取決於服務。', detected: '已偵測到', possible: '可能的服務', detectedAtPort: ({ port }: { port: string }) => `已偵測到 · 連接埠 ${port}`, possibleAtPort: ({ provider, port }: { provider: string; port: string }) => `可能是 ${provider} 服務 · 連接埠 ${port}`, addConnectionTitle: '新增另一個本機連線', addConnectionDescription: '請為此連線命名，以便與其他本機端點區分。', defaultConnectionName: ({ provider }: { provider: string }) => `${provider} 本機` } } as const;

const providerManagedDeploymentTranslations = { zhHant: {
        configureManaged: '使用受管理的本機服務執行工作階段',
        configureManagedDescription: '為未來工作階段選擇已連接的帳戶或群組。需要時，Happier 會啟動服務。',
        subscriptionPolicyTitle: '訂閱路由仍處於實驗階段',
        subscriptionPolicyDescription: '上游政策或執行方式可能會變更，並導致訂閱路由停止運作。Happier 會如實顯示拒絕，不會在未告知下改用其他憑證。',
        accountScopeMismatchTitle: '已連線帳戶屬於目前伺服器',
        accountScopeMismatchDescription: '此供應商由另一台伺服器上的機器管理。請切換到該伺服器以選擇其已連線帳戶或群組。',
        editManagedDefaults: '編輯受管理工作階段預設值',
        editManagedDefaultsDescription: '變更未來工作階段使用的已連接帳戶或群組。現有工作階段會保留選擇。',
        purposeTargetTitle: '已連接帳戶目標',
        purposeTargetDescription: '請為此用途選擇可用的已連線帳戶或群組。',
        invalidPurposeTargetTitle: '已連接帳戶目標無效',
        invalidPurposeTargetDescription: '請在儲存前選擇可用的已連線帳戶或群組。',
        useExternal: '使用外部服務',
        useExternalDescription: '停止為未來工作階段管理此供應商，並使用其外部端點設定。',
        useExternalConfirmTitle: '使用外部服務？',
        useExternalConfirmDescription: '受管理的帳戶預設值將被移除。現有工作階段會保留選擇。',
    } } as const;

const copyNameTranslations = { zhHant: ({ name }: { name: string }) => `${name} 副本` } as const;

const providerSharedFieldTranslations = { zhHant: {
        local: { installedNotRunning: '已安裝，但未執行', appRunningServerOff: '應用程式已開啟，但本機伺服器已關閉', startManaged: ({ provider }: { provider: string }) => `啟動 ${provider}`, startedByHappier: '由 Happier 啟動', runningOutsideHappier: '在 Happier 外部執行' },
        apiKeyOptionalDescription: '選用 — 如果此供應商需要金鑰，請選擇已儲存的密鑰',
        models: { addDescription: '新增此供應商不會自動列出的模型 ID', addHelp: '每行輸入一個正確的模型 ID。已有模型會被略過。', addFieldLabel: '模型 ID', invalidModelIds: ({ ids }: { ids: string }) => `這些模型 ID 無效：${ids}`, noNewModels: '沒有可新增的模型 ID。', providerManagedTitle: '模型由此供應商管理', providerManagedDescription: '重新整理供應商目錄以更新此清單。不支援手動模型 ID。', showAll: '顯示所有模型', hideAll: '隱藏所有模型', hideAllConfirmation: '隱藏此清單中的所有模型？你可以隨時重新顯示它們。', showOnly: '僅顯示此模型', showOnlyConfirmation: '隱藏此清單中的其他所有模型？你可以隨時復原它們。' },
    } } as const;

const providerFirstSessionValidationTranslations = { zhHant: 'Happier 會在首次啟動使用此供應商的工作階段時安全地驗證連線。' } as const;

const providerMigrationTranslations = { zhHant: { reviewTitle: '檢查供應商遷移', reviewFooter: '套用變更前，請檢查端點、API 格式、憑證和模型。', legacyProfileDescription: '確認前，此設定檔會繼續使用舊路由。', credentialTitle: '憑證', credentialFooter: '只會移動已儲存密鑰的參照；密鑰值不會顯示或複製。', noCredential: '無 API 密鑰', credentialMoveDescription: '將此憑證移至新連線', noCredentialDescription: '建立無憑證連線', actionsTitle: '遷移', preview: '檢查變更', previewDescription: '驗證設定而不變更偏好', confirm: '建立供應商連線', confirmDescription: '以不可分割方式套用變更並保留啟動偏好', reviewAction: '檢查供應商遷移', reviewActionDescription: '將舊端點與模型移至供應商連線', retainedTitle: '已保留舊設定', retainedDescription: '在能夠無損遷移前，此設定會保持可用。' } } as const;

const providerMigrationPreviewTranslations = { zhHant: { willMoveTitle: '將移至供應商', willMoveFooter: '只會移動這些路由和憑證名稱。密鑰值絕不會顯示。', willKeepTitle: '將保留在啟動設定檔中', willKeepFooter: '這些僅用於啟動的設定會在遷移後保留在設定檔中。', permissionDefaults: '預設權限', persistenceDefaults: '預設工作階段儲存空間' } } as const;

const providerMigrationConflictTranslations = { zhHant: { conflictReviewTitle: '解決供應商遷移衝突', conflictReviewFooter: '選擇保留現有連線，或將此設定檔儲存為獨立連線。不會顯示任何密鑰值。', conflictCredential: '已儲存的憑證不同', conflictModels: '模型設定不同', conflictEditedConnection: '現有連線已被修改', keepExisting: '保留現有連線', keepExistingDescription: '保留其目前憑證和模型，並在不取代它們的情況下完成遷移。', modelOutcomeTitle: '選擇要保留的模型', modelOutcomeFooter: '完成遷移前請確認確切模型。做出選擇前不會變更任何內容。', useExistingModel: '使用連線目前的模型', useExistingModelDescription: '保留此供應商連線已選擇的模型。', preserveLegacyModel: '使用設定檔的模型', preserveLegacyModelDescription: '將此設定檔的確切模型選擇移到現有連線。', discardLegacyModel: '移除設定檔的模型選擇', discardLegacyModelDescription: '完成遷移，但不保留此設定檔的模型選擇或收藏意圖。', createNamed: '建立獨立連線', createNamedDescription: '在新的命名連線中保留此設定檔的供應商設定。', separateConnectionName: '連線名稱', conflictReviewAction: '解決供應商衝突', conflictReviewActionDescription: '選擇如何保留衝突的憑證或模型' } } as const;

const providerCredentialSelectionRequiredTranslations = { zhHant: '選擇此供應商連線應使用的已儲存憑證' } as const;

const providerLinkTranslations = { zhHant: { providerWebsite: '供應商網站', getApiKey: '取得 API 金鑰', failedToOpen: 'Happier 無法開啟此連結。' } } as const;

const providerCredentialFormatSelectionRequiredTranslations = { zhHant: '選擇此憑證的傳送方式' } as const;

const providerReservedEnvironmentValidationUnavailableTranslations = { zhHant: '變更環境變數前，請將此設定檔編輯器連線到可用機器。' } as const;

const providerAdvancedAuthoringTranslations = { zhHant: { advancedSetup: '進階設定', advancedSetupEnabled: '設定多種 API 樣式、要求標頭和安全的模型清單探測', advancedSetupDisabled: '使用一個常見的相容端點', endpointEnabled: '使用此 API 樣式', endpointEnabledDescription: '向相容的代理程式提供此端點', endpointDisabledDescription: '不會使用此 API 樣式', publicHeaders: '公開要求標頭', publicHeadersPlaceholder: 'X-Tenant: engineering', optionalProbePath: '模型清單路徑（選用）', probeParserTitle: '回應格式', probeParser: { openaiModels: 'OpenAI 相容模型清單', ollamaTags: 'Ollama 標籤', lmStudioNative: 'LM Studio 原生模型清單' } } } as const;

const providerCustomBearerHeaderTranslations = { zhHant: '自訂標頭（Bearer 權杖）' } as const;

const providerNonSecretHeaderTranslations = { zhHant: '非機密要求標頭' } as const;

const providerProbePathsTranslations = { zhHant: '模型清單路徑（選用，每行一個）' } as const;

const providerLocalAuthoringTranslations = { zhHant: { enableAfterSaving: '啟用此供應商', enableOnCurrentMachine: '儲存後僅在此機器上啟用', enableAccountWide: '儲存後啟用', localAddressTitle: '本機位址', localAddressDescription: ({ machine, endpoint }: { machine: string; endpoint: string }) => `請在每台機器上分別啟用。${machine} 將使用 ${endpoint}。` } } as const;

const providerAuthoringReviewTranslations = { zhHant: { destinationReview: '連線目標', destinationLoading: '守護程式正在解析確切目標…', destinationSelection: '選擇目標', destinationSelectionDescription: '連線前請核對確切位址。', destinationScope: '目標範圍', destinationMachine: '此機器', destinationAccount: '帳戶' } } as const;

const providerCompatibilityTranslations = { zhHant: { title: '適用於', footer: '相容性由各代理程式整合驗證，並可能因模型而異。', verified: '已驗證', experimental: '實驗性', incompatible: '不相容', verifiedDescription: '已通過此代理程式整合測試', experimentalDescription: '可能可用，但首次使用前需要確認', incompatibleDescription: '此代理程式無法安全使用此連線' } } as const;

const providerModelNotLoadedTranslations = { zhHant: '未載入 · 首次使用時可能會載入' } as const;

const providerModelLoadCancellationTranslations = { zhHant: { cancelLoad: '取消載入', loadCancelled: '已停止等待模型', loadCancelledProviderMayContinue: '供應商可能仍會繼續載入。請稍後重新整理目錄以核對延遲完成的結果；Happier 不會重播載入要求。' } } as const;

const providerPartialStatusTranslations = { zhHant: '部分可用' } as const;

const providerConnectedServiceSuppressedTranslations = { zhHant: '此供應商不會使用代理程式的原生登入。你儲存的選擇不會變更。' } as const;

const providerMachineCleanupPendingTranslations = { zhHant: '裝置已移除，但無法儲存供應商存取清理。請檢查連線，然後再次移除該裝置以重試清理。' } as const;

const providerConnectionChangedTranslations = { zhHant: { title: '供應商連線已變更', description: '請重新載入目前的供應商設定，然後再試一次。' } } as const;

const providerModelSectionTranslations = { zhHant: { available: '可用', manual: '手動' } } as const;

const providerCompletenessTranslations = { zhHant: {
        searchEmptyTitle: '沒有符合此搜尋條件的供應商',
        searchEmptyDescription: '請嘗試其他供應商或連線名稱。',
        compatibilityReasons: {
            noCompatibleProtocol: '此代理程式與供應商沒有共同支援的 API 通訊協定。',
            noAuthUnsupported: '此代理程式需要透過 API 金鑰存取此供應商。',
            credentialTransportUnavailable: '此代理程式不支援目前設定的 API 金鑰傳送方式。',
            optionalCredentialNoAuthUnsupported: '即使 API 金鑰為選用，此代理程式仍無法在未提供金鑰時使用該供應商。',
            capabilityUnsupported: '不支援必要的供應商功能。',
            capabilityUnknown: '必要的供應商功能尚未驗證。',
            modelEvidenceRequired: '請選擇模型以驗證其必要功能。',
            modelCapabilityUnsupported: '此模型不支援某項必要功能。',
            modelCapabilityUnknown: '必要的模型功能尚未驗證。',
            overrideIncompatible: '供應商驗證將此整合標示為不相容。',
            overrideExperimental: '供應商驗證將此整合標示為實驗性。',
            evidenceMissing: '尚未記錄相容性依據。',
            agentUnsupported: '此代理程式不支援外部模型供應商。',
            adapterInvalid: '無法驗證此代理程式的供應商轉接器。',
            unknown: '較新的相容性條件需要檢視。',
        },
        unsavedDescription: '要捨棄此供應商草稿嗎？「已儲存的祕密」是帳戶共用物件，仍會保留。',
        recoveryActions: {
            reviewFeatures: '檢視供應商可用性',
            chooseConnection: '選擇供應商',
            restorePlugin: '檢視外掛程式',
            enableConnection: '啟用供應商',
            reviewAccountGrant: '檢視帳戶存取權',
            enableOnMachine: '在機器上啟用',
            reviewMachineGrant: '檢視機器存取權',
            reviewCompatibility: '檢視相容性',
            addSecret: '新增 API 金鑰',
            reviewCredentialTransport: '檢視認證資料支援',
            reviewConnection: '檢視連線',
            retry: '再試一次',
            replaceSecret: '取代 API 金鑰',
            chooseModel: '選擇模型',
            loadModel: '載入模型',
            reviewAndRestart: '檢視並重新啟動',
            restartProbe: '再次測試',
            reduceProviderSettings: '管理供應商設定',
            reviewProfileMigration: '檢視設定檔遷移',
            reviewCurrentState: '檢視目前設定',
        },
        hiddenForAllAgents: '對所有代理程式隱藏 · 在供應商設定中管理',
    } } as const;

const providerAvailabilityTranslations = { zhHant: {
        availabilityChecking: '正在檢查供應商可用性', availabilityCheckingDescription: 'Happier 正在確認此伺服器是否支援供應商連線。',
        availabilityProblem: '無法檢查供應商可用性', availabilityProblemDescription: 'Happier 將自動重試。如果問題持續，請檢查伺服器連線。',
        availabilityUnsupported: '供應商功能需要更新伺服器', availabilityUnsupportedDescription: '此伺服器版本不支援供應商連線。',
        availabilityContextUnsupported: '目前環境不支援供應商', availabilityContextUnsupportedDescription: '目前伺服器設定或選擇無法支援供應商連線。',
        availabilityPolicyDisabled: '供應商已被政策停用', availabilityPolicyDisabledDescription: '本機政策或建置政策已停用供應商連線。',
    } } as const;

const settingsProvidersTranslations = { zhHant: withProviderSharedFields(zhHant, {
        providerAvailabilityTranslations: providerAvailabilityTranslations.zhHant,
        providerLinkTranslations: providerLinkTranslations.zhHant,
        providerCompletenessTranslations: providerCompletenessTranslations.zhHant,
        providerPartialStatusTranslations: providerPartialStatusTranslations.zhHant,
        providerMachineCleanupPendingTranslations: providerMachineCleanupPendingTranslations.zhHant,
        providerConnectionChangedTranslations: providerConnectionChangedTranslations.zhHant,
        providerCompatibilityTranslations: providerCompatibilityTranslations.zhHant,
        providerMigrationTranslations: providerMigrationTranslations.zhHant,
        providerMigrationPreviewTranslations: providerMigrationPreviewTranslations.zhHant,
        providerMigrationConflictTranslations: providerMigrationConflictTranslations.zhHant,
        providerCredentialSelectionRequiredTranslations: providerCredentialSelectionRequiredTranslations.zhHant,
        providerCredentialFormatSelectionRequiredTranslations: providerCredentialFormatSelectionRequiredTranslations.zhHant,
        providerReservedEnvironmentValidationUnavailableTranslations: providerReservedEnvironmentValidationUnavailableTranslations.zhHant,
        localTranslations: localTranslations.zhHant,
        providerSharedFieldTranslations: providerSharedFieldTranslations.zhHant,
        providerManagedDeploymentTranslations: providerManagedDeploymentTranslations.zhHant,
        copyNameTranslations: copyNameTranslations.zhHant,
        providerFirstSessionValidationTranslations: providerFirstSessionValidationTranslations.zhHant,
        providerAdvancedAuthoringTranslations: providerAdvancedAuthoringTranslations.zhHant,
        providerLocalAuthoringTranslations: providerLocalAuthoringTranslations.zhHant,
        providerAuthoringReviewTranslations: providerAuthoringReviewTranslations.zhHant,
        providerNonSecretHeaderTranslations: providerNonSecretHeaderTranslations.zhHant,
        providerProbePathsTranslations: providerProbePathsTranslations.zhHant,
        providerCustomBearerHeaderTranslations: providerCustomBearerHeaderTranslations.zhHant,
        providerModelSectionTranslations: providerModelSectionTranslations.zhHant,
        providerModelLoadCancellationTranslations: providerModelLoadCancellationTranslations.zhHant,
        providerModelNotLoadedTranslations: providerModelNotLoadedTranslations.zhHant,
        providerConnectedServiceSuppressedTranslations: providerConnectedServiceSuppressedTranslations.zhHant,
    }) } as const;

return { localTranslations, providerManagedDeploymentTranslations, copyNameTranslations, providerSharedFieldTranslations, providerFirstSessionValidationTranslations, providerMigrationTranslations, providerMigrationPreviewTranslations, providerMigrationConflictTranslations, providerCredentialSelectionRequiredTranslations, providerLinkTranslations, providerCredentialFormatSelectionRequiredTranslations, providerReservedEnvironmentValidationUnavailableTranslations, providerAdvancedAuthoringTranslations, providerCustomBearerHeaderTranslations, providerNonSecretHeaderTranslations, providerProbePathsTranslations, providerLocalAuthoringTranslations, providerAuthoringReviewTranslations, providerCompatibilityTranslations, providerModelNotLoadedTranslations, providerModelLoadCancellationTranslations, providerPartialStatusTranslations, providerConnectedServiceSuppressedTranslations, providerMachineCleanupPendingTranslations, providerConnectionChangedTranslations, providerModelSectionTranslations, providerCompletenessTranslations, providerAvailabilityTranslations, settingsProvidersTranslations };
})();

const Domain_settingsSearchKeywordsTranslations = (() => {
const english = Shared_settingsSearchKeywordsTranslations.english;

const translated = Shared_settingsSearchKeywordsTranslations.translated;

const settingsSearchKeywordsTranslations = { 'zh-Hant': translated({
        settingsSearchKeywords: {
            settings: '設定, 首頁, 概覽',
            groupProfileAndAccount: '帳戶, 個人資料, 帳單, 方案, 用量',
            account: '帳戶, 個人資料, 帳單',
            accountSecurity: '安全性, 密碼, 復原, 加密, 登出',
            apiTokens: 'api 權杖, 個人存取權杖, pat, 自動化, cli, sdk',
            teams: '團隊, 成員, 群組, 邀請',
            homeAdministration: 'home, 管理, 治理, 人員, 政策',
            secrets: '密鑰, 秘密, env, 權杖',
            usage: '用量, 帳單, 限制, 配額',
            machines: '機器, 裝置, 電腦',
            machinePoolsNew: '機器池, 池, 備援, 執行於',
            machinesAdd: '新增, 機器, ssh',
            machinesThisComputer: '這台電腦, 本機, 裝置',
            remoteHosts: '遠端, 主機, ssh, 伺服器, 機器',
            groupGeneral: '一般, 外觀, 語言, 實驗',
            appearance: '外觀, 主題, 字型, 介面, 側邊欄',
            keyboard: '鍵盤, 快捷鍵, 熱鍵, 指令',
            pets: '寵物, blink, 夥伴, codex',
            language: '語言, 地區, 翻譯',
            features: '功能, 實驗, 測試版',
            groupAiAndAgents: '代理, 供應商, mcp, 提示詞, 語音',
            agents: '供應商, 代理, 模型, llm',
            providers: '供應商, 模型, openrouter, ollama, lm studio',
            subAgent: '子代理, 代理, 委派, 規則',
            roles: '角色, 編排者, 建構者, 審閱者, 指令',
            delegation: '委派, 工作深度, 交接, 編排者',
            profiles: '設定檔, 角色',
            connectedServices: '已連線服務, oauth, 帳戶',
            mcp: 'mcp, 工具, 伺服器, 外掛',
            plugins: '外掛, 市集, 目錄, 描述元, 探索',
            prompts: '提示詞, 範本, 資料庫',
            promptsTemplates: '範本',
            promptsFolders: '資料夾',
            promptsStacks: '堆疊',
            promptsRegistries: '登錄檔',
            promptsLibrary: '資料庫',
            promptsAssets: '資源, 外部',
            voice: '語音, 助理, 麥克風',
            voiceConversations: '語音, 對話, 即時, 供應商',
            voiceDictation: '語音, 聽寫, 說話, 轉錄',
            voicePrivacy: '語音, 隱私, 歷史記錄, 保留',
            voiceAdvanced: '語音, 進階, 機器, 診斷',
            memory: '記憶, 搜尋, 索引',
            groupSessionsBehavior: '工作階段, 記錄, 權限, 動作',
            session: '工作階段, 終端機, tmux',
            externalSessions: '外部工作階段, 背景追蹤, 掛鉤',
            actions: '動作, 核准, 快捷鍵',
            embeds: '嵌入, iframe, 小工具, 網站, 對話',
            transcript: '記錄, 聊天, 版面',
            permissions: '權限, 核准, 安全性',
            toolRendering: '工具, 顯示',
            handoff: '交接, 轉移',
            runs: '執行, 執行紀錄',
            groupFilesAndSourceControl: '檔案, 原始碼控制, 附件',
            sourceControl: 'git, scm, 原始碼控制',
            attachments: '附件, 上傳, 檔案',
            groupSystem: '系統, 伺服器, 狀態, 通知',
            servers: '伺服器, 中繼',
            systemStatus: '系統狀態, 健康, 診斷',
            updates: '更新, 升級, 版本, cli, 重新啟動',
            notifications: 'notif, 通知, 推播, push',
            notificationsPush: 'push, 推播',
            desktop: '桌面, tauri, 疊加層, 視窗',
            diagnosis: '診斷, 偵錯',
            reportIssue: '回報問題, 錯誤, bug',
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
>, "zh-Hant"> = { 'zh-Hant': {
        settingsSessionPages: {
            preview: {
                userMessage: '修正不穩定的重新連線測試',
                agentReply: '找到了：重試計時器從未被清除。已修正，測試通過。',
                thinking: '測試只在逾時後失敗，所以重試計時器可能還在執行。',
            },
            runtime: {
                pageDescription: '工作階段在你的機器上如何執行。',
                terminalSection: '終端機',
                terminalHostTitle: '新工作階段的終端機主機',
                terminalHostNone: '無',
                tmuxTitle: '在 tmux 中啟動工作階段',
                tmuxOn: '新工作階段會在專屬的 tmux 視窗中開啟，方便你從終端機連線。',
                tmuxOff: '新工作階段在一般 shell 中執行。',
            },
            wizard: {
                pageDescription: '新增工作階段精靈如何排列各個步驟。',
                wideScreensSection: '寬螢幕',
                stepsSection: '每個步驟如何呈現選項',
                steps: {
                    profiles: '設定檔',
                    backends: '代理',
                    models: '模型',
                    machines: '機器',
                    paths: '資料夾',
                    permissions: '權限',
                },
            },
            providerLimits: {
                pageDescription: '達到使用上限時會發生什麼，以及你還剩多少配額。',
                recoveryDescription: '代理達到使用上限時，工作階段可以等待重設後繼續。',
                resumePromptCustom: '自訂',
                unavailableTitle: '此 Home 無法使用',
                unavailableDescription: '此 Home 未啟用使用上限復原與用量指示。',
            },
            resume: {
                pageDescription: '當代理無法自行恢復時，非作用中的工作階段如何繼續。',
                strategyRecent: '最近訊息',
                strategySummary: '摘要 + 最近',
                maxSeedCharsTitle: '重播大小上限',
                summaryModelSection: '摘要模型',
                summaryModelDescription: '為新工作階段撰寫重播摘要的代理與模型。',
                handoffSection: '移動工作階段',
                handoffLinkDescription: '把工作階段交給另一台機器時，會隨之移動哪些內容。',
            },
            permissions: {
                duringSessionSection: '工作階段進行中',
                duringSessionDescription: '核准請求顯示在哪裡，以及執行中工作階段的權限變更何時生效。',
                promptSurfaceComposer: '輸入框附近',
                applyImmediately: '立即',
                applyNextMessage: '下一則訊息',
                storageUseDefault: '預設',
            },
            handoff: {
                pageDescription: '把工作階段交給另一台機器時，會隨之移動哪些內容。',
                workspaceSection: '工作區檔案',
                workspaceDescription: '工作階段移到另一台機器時，專案資料夾如何處理。',
                keepUpdated: '保持更新',
                advancedModeDescription: '會取代上方的選擇。請小心：檔案可能被刪除或覆寫。',
                ignoredExclude: '排除',
                ignoredIncludeSelected: '包含所選',
            },
            toolRendering: {
                pageDescription: '讓個別工具顯示比對話記錄預設更多或更少的細節。',
                collapsedDescription: '開啟之前，每個工具在對話記錄中顯示多少內容。',
            },
            transcript: {
                advancedTitle: '效能與時序',
                advancedPageDescription: '串流、動畫時序與捲動門檻。大多數人維持預設即可。',
                advancedMotionOff: '對話記錄動畫已關閉，因此這些設定沒有作用。請在 對話記錄 › 動畫 中開啟。',
                toolsSection: "工具呼叫",
                toolOverridesDescription: '讓個別工具顯示更多或更少的細節。',
                thinkingSummary: '摘要',
                thinkingFull: '完整',
                strategyConsecutive: '連續的',
                strategyWholeTurn: '整輪',
                copyMarkdown: 'Markdown',
                copyMarkdownDescription: '複製的訊息保留格式，並標明作者。',
                copyPlainDescription: '複製的訊息為純文字，不含標籤。',
                motionSubtle: '輕微',
                advancedLinkDescription: '串流、動畫時序與捲動門檻。',
                pageDescription: '對話變長時如何閱讀：版面、思考、工具、動畫與捲動。',
            },
            composer: {
                pageDescription: '你如何撰寫與傳送訊息，以及代理忙碌時會發生什麼。',
                newSessionsSection: '新工作階段',
                newSessionsDescription: '選擇「新工作階段」時你會看到什麼。',
                draftEntryTitle: '開啟新工作階段時',
                draftResume: '繼續草稿',
                draftFresh: '重新開始',
                typingSection: '輸入',
                typingDescription: '輸入框中 Enter 與訊息記錄的行為。',
                enterToSendTitle: 'Enter 傳送',
                sendModeTitle: '代理工作時',
                sendQueue: '排隊',
                sendInterrupt: '中斷',
                sendPending: '待處理',
                busySteerTitle: '如果代理支援引導',
                busySteerInactive: '僅在代理工作期間訊息進入佇列或待處理時適用。',
                nonSteerableTitle: '訊息無法引導時詢問',
                resumeWhenPossible: '盡快',
                resumeIfOnline: '在線時',
                resumeNever: '永不',
                pendingSection: '待處理訊息',
                pendingDescription: '待處理的訊息如何送達代理。',
                pendingInactive: '依目前的選擇，不會有訊息進入待處理。一旦有訊息進入，這些設定才會生效。',
                drainOne: '逐則',
                drainAll: '全部一起',
                timingAfterReply: '回覆之後',
                timingWhenIdle: '全部閒置時',
                layoutSection: '輸入框版面',
                actionBarTitle: '動作列',
                actionBarAutoDescription: '控制項依可用空間排列，必要時換行。',
                actionBarWrapDescription: '放不下時標籤會換到第二行。',
                actionBarScrollDescription: '標籤維持一行，橫向捲動查看其餘部分。',
                actionBarCollapsedDescription: '標籤收進選單，留出最多的輸入空間。',
                chipDensityTitle: '動作標籤',
                chipsAutoDescription: '需要文字的標籤保留文字，一目了然的只顯示圖示。',
                chipsLabelsDescription: '每個標籤都顯示文字。',
                chipsIconsDescription: '標籤只顯示圖示，以節省空間。',
            },
        },
    } };

return { settingsSessionPagesTranslations };
})();

const Domain_shareSheetTranslations = (() => {
type ShareSheetTranslations = Shared_shareSheetTranslations.ShareSheetTranslations;

const shareSheetTranslations = { 'zh-Hant': {
        publicLink: { workflowDescription: "任何持有連結的人都可以閱讀此工作流程，無需帳戶。", workflowGrants: "唯讀工作流程。", description: "任何持有連結的人都可以閱讀此文件，無需帳戶。", grants: "唯讀文件。", audit: "存取記錄", auditEmpty: "尚無存取記錄。", ownerUpdateRequired: "擁有者正在更新此連結", ownerUpdateRequiredDescription: "請讓擁有者開啟 Happier，然後重試此連結。" },
        suggestions: ({ kind }: Readonly<{ kind: string }>) => `建議：${kind}`,
        profileAgentsMore: ({ count }: Readonly<{ count: number }>) => `另有 ${count} 個`,
        roleRunsIn: ({ kind }: Readonly<{ kind: string }>) => `執行於 ${kind}`,
        whoHasAccess: '誰有存取權',
        whoHasAccessStale: '誰有存取權 · 可能不是最新',
        owner: '擁有者',
        you: '你',
        addPlaceholder: '新增人員或團隊',
        person: '人員',
        group: '團隊群組',
        team: '團隊',
        accessLevel: '存取層級',
        accessibleControl: ({ name, control, value }) => `${name}，${control}，${value}`,
        remove: '移除存取權',
        confirmRemove: '確認移除',
        removedAnnouncement: ({ name }) => `${name} 已不再有存取權`,
        browseAll: '瀏覽全部',
        browsePeople: '瀏覽所有人員',
        browseTeams: '瀏覽所有團隊',
        browseGroups: '瀏覽所有團隊群組',
        membersOnlyLink: '複製連結供已有存取權限的人使用。',
        allLoaded: '已載入全部結果',
        copyLink: '複製連結',
        linkCopied: '已複製連結',
        copyLinkFailed: '無法複製連結。',
        sendCopy: '改為傳送副本',
        secrets: {
            levels: { canUse: '可使用' },
            help: { use: '在執行中使用；其值從不顯示' },
            oneLevel: '已儲存的密鑰只供執行使用，其值永不外洩，因此只有一個層級。',
        },
        documents: {
            title: '共享',
            shareTitle: ({ name }) => `共享 ${name}`,
            levels: { canUse: '可使用', canRead: '可檢視', canEdit: '可編輯', admin: '管理' },
            help: {
                workflowUse: '檢視並執行',
                roleUse: "在自己的工作階段中使用；個人變更保留在自己的設定中",
                profileUse: '用它啟動工作階段',
                documentUse: '在其任何裝置上開啟和複製',
                promptUse: "在自己的工作階段中使用",
                boardUse: '檢視看板；每張卡片只開啟其已有權限的內容',
                dashboardUse: '檢視此儀表板；每個元件只顯示你已有權限開啟的內容。',
                editForEveryone: '為所有共享對象變更',
                adminOwnerShares: '變更並管理共享',
            },
            notes: {
                personalRuns: '執行與觸發器歸啟動它們的人所有。',
                teamRuns: '團隊能看到每次執行。',
                roleLive: '你的變更會同步給所有共享對象。',
                profileSecrets: '設定檔參照已儲存的機密；機密值不會傳輸。',
                dashboardAccess: '你新增的人會以自己的身分開啟它。元件、定義、連線、機器及儲存庫各自需要獨立的存取權限。',
            },
            privateChoices: {
                title: '私人連線選擇',
                account: ({ widget, service }) => `${widget} 使用你的 ${service} 帳戶`,
                letViewersPick: '讓檢視者選擇',
                removeChoice: '移除選擇',
                authoredInput: ({ widget }) => `編輯 ${widget}，在分享前移除私人輸入。`,
            },
            errors: {
                unavailable: '此處尚不支援共享。',
                ownerOnly: '只有擁有者或管理員可以變更誰有存取權。',
                noAccess: '你已不再有存取權。',
                notFound: '此項目已無法使用。',
                subjectUnavailable: '此人員、群組或團隊無法取得存取權。',
                failed: '無法更新共享，請再試一次。',
            },
        },
    } } satisfies Pick<Record<string, ShareSheetTranslations>, "zh-Hant">;

return { shareSheetTranslations };
})();

const Domain_sidebarFooterTranslations = (() => {
type SidebarFooterTranslation = Shared_sidebarFooterTranslations.SidebarFooterTranslation;

const sidebarFooterTranslations = { 'zh-Hant': {
        linkToService: ({ service }) => `連結到 ${service}`,
        addHomeOrSignIn: '新增 Home 或登入',
        usageNoAccounts: '連接一個帳戶即可查看其剩餘額度。',
        usageHealthy: '所有額度都還很充裕',
        homeUnreachableTitle: ({ home }) => `無法連線 ${home}`,
        homeUnreachableBody: '它回應後，你的機器和工作階段會重新顯示在這裡。',
        homeUnreachableLine: ({ home }) => `無法連線 ${home}。`,
        availableWhenHomeAnswers: "此 Home 回應後可用。",
        usageKeysWithoutLimits: ({ count }) => `${count} 個無限額的金鑰`,
        usageSignedOut: '已登出',
        hideAccountIdentities: '隱藏帳戶電子郵件和 ID',
        accountIdentitiesHidden: '電子郵件和 ID 已隱藏 · 適合直播和示範',
        usageThisSession: '此工作階段',
        usageAllAccounts: '所有帳戶',
        usageMoreAccounts: ({ count }) => `另外 ${count} 個`,
        usageSessionThroughPool: ({ agent, pool }) => `${agent} 透過 ${pool} 登入`,
        usageSessionWithAccount: ({ agent }) => `${agent} 使用此帳戶登入`,
        usageSessionOwnSignIn: ({ agent }) => `${agent} 使用自己的登入`,
        usagePoolFallback: '其帳戶池',
        usageNextInOrder: ({ account }) => `${account} 用完後，下一輪將依序切換到下一個帳戶`,
        usageNextMostLeft: ({ account }) => `${account} 用完後，下一輪將切換到剩餘最多的帳戶`,
        usageNextStays: ({ pool, account }) => `在你切換之前，${pool} 會一直使用 ${account}`,
    } } as const satisfies Pick<Record<string, SidebarFooterTranslation>, "zh-Hant">;

return { sidebarFooterTranslations };
})();

const Domain_surfaceStateTranslations = (() => {
type SurfaceStateTranslations = Shared_surfaceStateTranslations.SurfaceStateTranslations;

const surfaceStateTranslations = { 'zh-Hant': {
        stillWaiting: ({ seconds }) => `仍在等待 · ${seconds} 秒`,
        asOf: ({ time }) => `截至 ${time}`,
        howItWorks: '了解運作方式',
        tryAgain: '重試',
        checkAgain: '再次檢查',
        paneFailedTitle: '無法顯示此面板',
        paneFailedReason: '繪製時出了問題。你的工作階段不受影響。',
        opening: ({ name }) => `正在開啟 ${name}`,
        couldNotOpen: ({ name }) => `無法開啟 ${name}`,
    } } as const satisfies Pick<Record<string, SurfaceStateTranslations>, "zh-Hant">;

return { surfaceStateTranslations };
})();

const Domain_teamsTranslations = (() => {
type TeamsTranslationRoot = Shared_teamsTranslations.TeamsTranslationRoot;

const english = Shared_teamsTranslations.english;

const traditionalChinese: TeamsTranslationRoot = {
    teams: {
        overview: {
            sharedSessions: "共享的工作階段",
            allSharedSessions: "所有共享的工作階段",
            managedBy: ({ team }: { team: string }) => `${team} 的擁有者與管理員負責管理成員、登入與設定。`,
            attention: {
                directoryFailedTitle: ({ name }: { name: string }) => `${name} 無法同步`,
                directoryFailedBody: "成員與群組維持上次成功同步時的狀態。",
                invitationUndeliveredTitle: "有一封邀請郵件未送達",
                invitationUndeliveredBody: ({ recipient }: { recipient: string }) => `收件者：${recipient}。以其他方式分享，連結仍然有效。`,
            },
            sessionsSubtitle: '與此團隊共用的工作階段。',
            teamSection: '團隊',
            summary: {
                historyFromJoining: "加入後的紀錄",
                historyEarlier: "包含更早的紀錄",
                groupsDirectory: ({ directory }: { directory: string }) => `與 ${directory} 保持同步`,
                undelivered: ({ count }: { count: number }) => `${count} 封郵件未送達`,
                credentialsShared: ({ count, team }: { count: number; team: string }) => `已與 ${team} 共享 ${count} 個`,
                credentialsNone: "尚未共享",
                justYou: '只有你',
                people: ({ count }: { count: number }) => count === 1 ? `1 人` : `${count} 人`,
                suspended: ({ count }: { count: number }) => `${count} 人已停權`,
                groups: ({ count }: { count: number }) => count === 1 ? `1 個群組` : `${count} 個群組`,
                noGroups: '還沒有群組',
                waiting: ({ count }: { count: number }) => `${count} 個待接受`,
                noneWaiting: '沒有待接受的',
                homeSignIn: ({ home }: { home: string }) => `${home} 的登入`,
                chosenSignIn: '僅限所選登入',
                signInNeedsRepair: '登入規則需要修復',
                sessionsPrivate: '工作階段預設為私人',
                sessionsShared: '工作階段預設為共用',
                sessionsAlwaysShared: '工作階段一律共用',
            },
            setup: {
                title: ({ team }: { team: string }) => `準備好 ${team}`,
                description: '每完成一步，它就會離開此清單。',
                inviteBody: ({ team, home }: { team: string; home: string }) => `你邀請的每個人都會以 ${team} 成員身分加入 ${home}。`,
                signInTitle: '選擇成員的登入方式',
                signInBody: '保留此 Home 的登入，或要求使用你公司的登入。',
                signInAction: '選擇',
                shareTitle: '共用一個工作階段',
                shareBody: ({ team }: { team: string }) => `從任一工作階段的選單中，將它共用給 ${team}。`,
            },
        },
        denied: {
            askUnnamed: "請聯絡此團隊的擁有者或管理員。",
            title: '你在此團隊中的角色不包含此項',
            authentication: ({ team }: { team: string }) => `${team} 的擁有者與管理員決定成員如何登入。`,
            settings: ({ team }: { team: string }) => `${team} 的擁有者與管理員負責變更這些設定。`,
        },
        pages: {
            credentialCreate: '選擇要共用的內容、可使用的人以及上限。',
            credentialDetail: '誰可以使用此憑證、如何使用以及用量。',
            credentialEdit: '變更誰可以使用此憑證、如何使用以及用量。',
            credentialActivity: '對此憑證的變更以及變更者。',
            credentialUsage: '此憑證的使用量以及使用者。',
            credentialExternalApi: '從 Happier 之外的工具使用此憑證。',
            identityProviderNew: '連接成員可用於登入的身分識別提供者。',
            identityProviderEdit: '變更此身分識別提供者的連線方式。',
            githubApp: '此團隊用於存取儲存庫的 GitHub App。',
            githubAppEdit: '變更此 GitHub App 的註冊資訊。',
            authentication: '成員如何登入此團隊以及它接納哪些人。',
            credentials: '此團隊與成員共用的供應商憑證。',
            directory: '在 Home 上共用工作階段、存取權與憑證的一組成員。',
            members: '此團隊的成員以及每個人可以做什麼。',
            addMember: '新增已在此 Home 上擁有帳號的人。',
            groups: '有名稱的成員集合，用於共用工作階段與憑證。',
            newGroup: '為群組命名。群組建立後再新增成員。',
            invitations: '可加入此團隊的邀請及其對象。',
            settings: '名稱、標誌、工作階段預設值，以及此團隊是否啟用。',
        },
        loading: '正在載入團隊…',
        title: '團隊',
        entrySubtitle: '建立團隊、管理成員與群組，並邀請他人加入。',
        entry: {
            heading: ({ team }: { team: string }) => `繼續前往 ${team}`,
            onHome: ({ home }: { home: string }) => `位於 ${home}`,
            signInServiceOrigin: ({ service }: { service: string }) => `透過${service}登入`,
            signInServiceUnavailableOrigin: ({ service }: { service: string }) => `目前無法透過${service}登入`,
            signedInTo: ({ home, account }: { home: string; account: string }) => `已登入 ${home}，帳戶為 ${account}`,
            unnamedAccount: 'Happier 帳戶',
            continueWith: ({ method }: { method: string }) => `使用 ${method} 繼續`,
            providerUnavailableTitle: ({ method }: { method: string }) => `${method} 目前無法使用`,
            providerUnavailableDisabled: '你的 Team 管理員已關閉此登入方式。請稍後再檢查。',
            providerUnavailableSetupIncomplete: '你的 Team 管理員尚未完成此登入方式的設定。請稍後再檢查。',
            providerUnavailableUnavailable: '此 Home 目前無法使用此登入方式。請稍後再檢查。',
            unknownTargetTitle: '此連結未標明它的 Home',
            unknownTargetBody: '本裝置無法判斷這個 Team 登入連結屬於哪個 Home，因此沒有向任何 Home 傳送內容。請向 Team 管理者重新索取連結。',
            ssoRequiredTitle: '此 Team 需要另一種登入方式',
            ssoRequiredBody: '你已登入此 Home，但此 Team 只接受它要求的登入方式。請使用該方式重新登入，或返回你自己的工作。',
            invitationUnavailableTitle: '此邀請無法使用',
            invitationUnavailableBody: '它可能已過期、已被撤銷或已被使用。僅登入並不會讓你加入 Team。',
            wrongAccountTitle: '此帳戶無法使用此登入',
            wrongAccountBody: '你用來登入的帳戶或身分不是此 Team 期望的。請使用其他帳戶或提供者登入，或返回你自己的工作。',
            notProvisionedTitle: '此 Team 尚未接納你',
            notProvisionedBody: '僅登入並不會讓你加入此 Team。由其管理員決定誰可以加入；請向管理員申請存取權限或邀請，然後重試。',
            directoryDelayedTitle: '你的存取權限仍在路上',
            directoryDelayedBody: '此 Team 的成員來自目錄，而目錄尚未交付你的存取權限。請稍後重試，或聯絡 Team 管理者。',
            accessRemovedTitle: '此 Team 對你不可用',
            accessRemovedBody: '你的存取權限可能已被移除，或此 Team 目前在此 Home 上不可用。你已登入的其他內容不受影響。',
            providerChangedTitle: '此登入方式在使用過程中已變更',
            providerChangedBody: '管理員在你登入期間更新了此登入方式。你的帳戶未做任何變更。請從 Team 頁面重新開始，以查看目前的登入方式。',
            returnToTeamSignIn: '返回 Team 登入',
            returnToHappier: '返回 Happier',
            signInToTeam: '登入此團隊',
            readyStatus: '選擇登入方式以繼續。',
        },
        homeLabel: 'Home',
        role: {
            owner: '擁有者',
            admin: '管理員',
            member: '成員',
            guest: '訪客',
        },
        roleHelp: {
            owner: '擁有該團隊，可以管理團隊並變更擁有者。',
            admin: '擁有成員權限，並可管理該團隊。',
            member: '預設取得授予該團隊的存取權。',
            guest: '只會看到明確分享給此帳戶或其所屬群組的工作階段與資源。',
        },
        status: {
            active: '使用中',
            suspended: '已暫停',
        },
        history: {
            label: '工作階段歷程',
            allExisting: '包含已分享給團隊的工作階段',
            fromMembership: '僅包含加入之後分享的工作階段',
            allExistingNamed: ({ name }) => `包含已分享給${name}的工作階段`,
            fromMembershipNamed: ({ name }) => `僅包含加入${name}之後分享的工作階段`,
            scopeNote: '這是以整個工作階段為單位。並非只顯示加入之後建立的訊息。',
        },
        unavailable: {
            title: '此 Home 無法使用團隊',
            disabled: '此 Home 已關閉團隊功能。',
            updateRequired: '此 Home 需要更新才能使用團隊。',
            offline: '目前無法連線至此 Home。',
            retry: '再試一次',
        },
        stale: {
            label: '正在顯示此 Home 最後已知的資料。',
        },
        errors: {
            generic: '操作未完成，沒有任何內容被變更。',
            outcomeUnknown: 'Home 可能已完成此變更。請先重新整理團隊，再重試。',
            forbidden: '你沒有進行此變更的權限。',
            notFound: '此團隊已無法使用。',
            archived: '此團隊已封存。還原後才能變更。',
            conflict: '有人搶先做了變更。請檢視目前的值後再試一次。',
            offline: '此 Home 無法連線，變更並未送出。',
            invalidName: '請輸入 1 到 80 個字元的名稱。',
            invalidDescription: '請輸入不超過 500 個字元的描述。',
        },
        directory: {
            loading: '正在載入團隊…',
            chooseTeamToShare: '選擇要與之共用的團隊。',
            noMatches: '沒有符合的團隊',
            noLoadedMatches: '已載入的團隊中沒有符合項目',
            searchLoadedPlaceholder: '篩選已載入的團隊',
            unreachableHomes: '無回應',
            searchPlaceholder: '搜尋團隊',
            newTeam: '新增團隊',
            createDenied: ({ homes }: { homes: string }) => `只有 ${homes} 的管理員可以建立團隊。請管理員建立團隊或將你加入團隊。`,
            createAdministered: ({ names }: { names: string }) => `此 Home 的團隊由其管理員建立。請讓 ${names} 為你建立團隊，或允許所有人建立團隊。`,
            createAdministeredUnnamed: '此 Home 的團隊由其管理員建立。請讓管理員為你建立團隊，或允許所有人建立團隊。',
            createOff: '此 Home 已關閉團隊建立。',
            letEveryoneCreate: '允許所有人建立團隊',
            namesAnd: ({ names, last }: { names: string; last: string }) => `${names}和${last}`,
            namesAndOthers: ({ names, count }: { names: string; count: number }) => `${names}和另外 ${count} 人`,
            emptyTitle: '尚未有團隊',
            emptyBody: '團隊為一群人提供一個共用的地方，用於工作階段、成員與存取權。',
            archivedSection: '已封存的團隊',
            archivedEmpty: '沒有已封存的團隊',
            archivedEmptyBody: '在團隊自己的設定中封存，團隊就會移到這裡。成員、群組和歷史記錄都會保留。',
            showArchived: '顯示已封存',
            hideArchived: '隱藏已封存',
            archivedBadge: '已封存',
            rowAccessibilityLabel: ({ name, role, home }: { name: string; role: string; home: string }) => `${name}，${role}，位於 ${home}`,
            partialHomes: '部分 Home 無法連線，因此清單中缺少它們的團隊。',
        },
        create: {
            loading: '正在檢查可在哪裡建立團隊…',
            discard: '捨棄',
            detailsSection: '團隊',
            logoFailedBody: '團隊已建立，但其標誌未發布。請重試，或在沒有標誌的情況下繼續。',
            title: '新增團隊',
            nameLabel: '名稱',
            namePlaceholder: 'Acme',
            descriptionLabel: '描述',
            descriptionPlaceholder: '這個團隊負責什麼',
            homeHelp: '團隊會在此 Home 中建立並一直留在這裡。',
            duplicateNameNote: '兩個團隊可以同名。連結與存取權一律指向團隊本身。',
            managedOnlyTitle: '此 Home 的團隊建立由管理員負責',
            managedOnlyBody: '這裡由管理員建立團隊並指定第一位擁有者。',
            initialOwnerLabel: '第一位擁有者',
            initialOwnerPlaceholder: '在此 Home 中搜尋成員',
            initialOwnerHelp: '為他人建立團隊不會把你加入其中。',
            initialOwnerRequired: '請選擇團隊的第一位擁有者。在此 Home 上，由管理員指定新團隊的擁有者。',
            initialOwnerIneligible: '此人已無法擁有團隊。請選擇其他人。',
            submit: '建立團隊',
            submitting: '正在建立…',
            outcomeUnknown: '無法確認團隊是否已建立。請重試以恢復同一請求。',
        },
        tabs: {
            overview: '總覽',
            sessions: '工作階段',
            members: '成員',
            groups: '群組',
            invitations: '邀請',
            authentication: '身分驗證',
            settings: '設定',
        },
        authentication: {
            policy: {
                admissionRow: "新成員",
                acceptedRow: "接受的登入方式",
                admissionSection: '誰可以加入',
                admissionHelp: '成員如何加入這個團隊。',
                admissionInviteOnly: '僅限邀請',
                admissionProvisioned: '由目錄佈建',
                admissionJit: '首次登入時自動加入',
                admissionUnavailable: '此 Home 尚無法執行該加入方式，因此未做任何變更。',
                admissionUnavailableReason: {
                    homePolicyUnavailable: '此 Home 尚未向團隊提供該登入提供者。Home 管理員可以變更。',
                    homePolicyProhibited: '此 Home 的管理員不允許使用該加入方式。',
                    directorySourceRequired: '請先為此團隊新增目錄。此方式接納目錄提供的人員。',
                    directoryProjectionRequired: '此團隊的目錄尚未完成首次同步。完成後即可使用此方式。',
                    teamConnectionRequired: '請先為此團隊新增登入連線。首次登入時加入需要它。',
                    teamConnectionUnavailable: '此團隊目前沒有可用的登入連線，因此登入時無人能夠加入。',
                },
                acceptedSection: '成員如何登入',
                acceptedHelp: '在允許團隊操作之前，這個團隊接受哪種登入方式。',
                acceptedInherit: '使用 Home 政策',
                acceptedRestricted: '僅限下方選擇的登入方式',
                connectionsSection: '接受的連線',
                connectionsEmpty: '至少選擇一個登入連線，或使用 Home 政策。',
                homeMethodRetained: '沿用已儲存的政策',
                repairRequired: '無法讀取已儲存的登入限制',
                repairRequiredHelp: '它未依寫入內容生效。請在下方選擇一個政策來取代它。',
                conflictBody: '此 Home 的登入政策已變更。請先檢視，然後重新套用你的變更。',
                providerTestRequired: '在團隊要求使用此連線之前，請先測試它。',
                unavailable: '此 Home 無法接受該登入政策。',
                approvalPending: '等待核准',
                connectionOwnerTeam: "團隊連線",
                connectionOwnerHome: "Home 登入方式",
            },
            subtitle: '團隊成員用於證明身分的方式。',
            memberSignIn: {
                section: '成員登入頁面',
                open: '開啟成員登入頁面',
                copyLink: '複製連結',
                shareLink: '分享連結',
                qrLabel: '成員登入連結的 QR code',
                footer: '任何擁有此連結的人都能開啟該團隊的登入頁面。連結本身不授予任何權限：加入仍須遵循團隊的准入政策。',
                unavailable: '沒有可分享的連結',
                unavailableBody: '此 Home 未發布網址，因此沒有可在其他裝置上使用的連結。Home 管理員可以設定一個。',
            },
            connectionsSection: '登入連線',
            homeMethodsUnavailable: '無法讀取此 Home 的登入方式。',
            connectionsDescription: '此團隊可以使用的公司登入。',
            add: {
                fixTurnOn: "開啟",
                action: '新增連線',
                askNamed: ({ names }: { names: string }) => `請聯絡 ${names}。`,
                askUnnamed: '請聯絡 Home 的擁有者。',
                fixInSignInProviders: '前往設定',
                fixInReach: '在可連線性中設定',
                reason: {
                    contactHomeAdmin: ({ home }: { home: string }) => `${home} 會為其團隊設定此項。`,
                    workosPlatform: ({ home }: { home: string }) => `${home} 尚未設定 WorkOS。`,
                    providerDisabled: ({ home }: { home: string }) => `來自 ${home}，已在那裡關閉。`,
                    homeProhibited: ({ home, provider }: { home: string; provider: string }) => `${home} 不允許團隊新增 ${provider}。`,
                    homeUnavailable: ({ home }: { home: string }) => `${home} 尚未向團隊開放此項。`,
                    publicAddress: ({ home }: { home: string }) => `你的提供者需要 ${home} 的公開位址才能將使用者送回。`,
                },
            },
            empty: '沒有登入連線',
            status: {
                unavailable: '無法使用',
                prohibited: '已被 Home 政策封鎖',
                notConfigured: '未設定',
                settingUp: '正在設定',
                needsAttention: '需要處理',
            },
            mode: {
                signInOnly: '僅用於登入',
                signInTimeGroups: '登入時重新整理群組',
            },
            detail: {
                status: '狀態',
                mode: '模式',
                provider: '提供者',
                restrictions: '登入限制',
                allowedUsers: '允許的使用者',
                allowedDomains: '允許的電子郵件網域',
                none: '無',
                configuration: '設定',
                organization: '組織',
                connection: '連線',
            },
            directory: {
                connect: "連接",
                actions: {
                    section: '操作', sync: '立即同步', pause: '暫停同步', resume: '繼續同步', remove: '移除目錄…',
                    pauseTitle: ({ source }: { source: string }) => `暫停 ${source}？`, pauseBody: '新的目錄變更將停止。已知的 Team 存取權和群組貢獻會保留到恢復同步。',
                    removeTitle: ({ source }: { source: string }) => `移除 ${source}？`, removeMembers: ({ count }: { count: number }) => `透過此目錄加入的 ${count} 人將離開 Team。`, removeGroupMemberships: ({ count }: { count: number }) => `它設定的 ${count} 個群組成員身分將被移除。`, removeNothing: "沒有成員身分依賴它。", removeKept: "帳戶、它建立的群組以及以其他方式加入的人員會保留。",
                },
                section: "受管成員資格",
                overviewSubtitle: "目錄來源讓團隊成員和群組與外部組織保持同步。",
                manageSubtitle: "查看已連接的目錄來源及其最新同步狀態。",
                title: "目錄同步",
                sourcesSection: "目錄來源",
                sourcesLoadMore: "載入更多來源",
                subtitle: "每次同步後，目錄中的變更會顯示在這裡。",
                purpose: "讓此 Team 的成員和群組與公司目錄保持一致。",
                sourcePurpose: "此目錄與 Team 保持一致的人員和群組。",
                empty: "沒有目錄來源",
                emptyBody: "連接公司目錄後，Team 會跟隨它：加入目錄的人會加入 Team，離開的人會失去存取權。",
                setup: {
                    add: "新增來源",
                    options: "選擇目錄來源",
                    optionsFooter: "在第一次同步完成前不會有任何變化。",
                    loadMore: "載入更多",
                    empty: "尚無已驗證的來源",
                    workos: "設定 WorkOS 目錄同步",
                    workosSubtitle: "開啟 WorkOS 管理入口網站，然後返回選擇已驗證的目錄。",
                    confirmTitle: ({ source }: { source: string }) => `Add ${source}?`,
                    confirmBody: "新增後，Happier 將開始匯入此目錄。",
                },
                people: {
                    section: "人員",
                    empty: "沒有已佈建的人員",
                    provisioned: "已佈建 · 尚無帳戶",
                    boundAccountCount: ({ count }: { count: number | string }) => `已繫結帳戶：${count}`,
                    unboundPeopleCount: ({ count }: { count: number | string }) => `尚無帳戶的已佈建人員：${count}`,
                    member: "團隊成員",
                    unknown: "未命名人員",
                    loadMore: "載入更多人員",
                    state: {
                        suspended: "已暫停",
                        deleted: "已刪除",
                    },
                },
                kind: {
                    workos: "WorkOS 目錄同步",
                    github: "GitHub 組織",
                },
                state: {
                    setup: "需要設定",
                    syncing: "同步中",
                    active: "有效",
                    paused: "已暫停",
                    needsAttention: "需要處理",
                    initializing: "正在設定",
                    failed: "上次同步失敗",
                },
                mode: {
                    eventsAndFull: "事件和完整對帳",
                    fullOnly: "僅完整對帳",
                },
                freshness: {
                    never_synced: "從未同步",
                    fresh: "最新",
                    stale: "已過期",
                    unknown: "未知",
                },
                detail: {
                    status: "狀態",
                    sourceType: "來源類型",
                    syncSection: "同步狀態",
                    mode: "同步模式",
                    freshness: "新鮮度",
                    lastSuccess: "上次成功同步",
                    nextScheduled: "下次排定同步",
                    attentionSection: "需要處理",
                    attentionTitle: "此目錄來源需要處理",
                    attentionRetryable: "修復連線後，此目錄來源可以恢復。重新整理以檢查最新狀態。",
                    attentionAdmin: "在依賴新的目錄變更之前，請檢查來源設定。",
                },
                never: "從未",
                unknown: "未知",
            },
        },
        settings: {
            archiveDescription: '封存會將團隊移出使用中的檢視，並停止以團隊為基礎的存取。其成員、群組與歷史記錄會保留，且可以還原。',
            logoSection: '標誌',
            sessionDefaultsSection: '工作階段預設值',
            sharingSection: '共用',
            sharingDescription: '從現在起生效。已共用的內容不會改變。',
            option: {
                private: '私人',
                shared: '共用',
                alwaysShared: '一律共用',
                anyone: '任何人',
                admins: '管理員',
                nobody: '無人',
                fromJoining: '加入後',
                earlierToo: '包含之前',
            },
            consequence: {
                sessionsPrivate: ({ team }: { team: string }) => `以私人開始；每個人自行選擇與 ${team} 共用什麼。`,
                sessionsShared: ({ team }: { team: string }) => `以共用給 ${team} 開始；每個人都可以讓某個工作階段保持私人。`,
                sessionsAlwaysShared: ({ team }: { team: string }) => `每個新工作階段都會共用給 ${team}。`,
                outsideAnyone: ({ team }: { team: string }) => `能共用工作階段的人也可以在 ${team} 之外共用。`,
                outsideAdmins: ({ team }: { team: string }) => `只有 ${team} 的管理員可以在外部共用工作階段。`,
                outsideNobody: ({ team }: { team: string }) => `工作階段無法在 ${team} 之外共用。`,
                historyFromJoining: ({ team }: { team: string }) => `從加入時起共用給 ${team} 的工作階段。`,
                historyEarlier: ({ team }: { team: string }) => `也包含加入前共用給 ${team} 的工作階段。`,
            },
            externalSharingSection: '對外分享',
            historyDefaultSection: '歷程預設值',
            saved: '已儲存',
        },
        policy: {
            sessionCreationPrivate: '預設為私人',
            sessionCreationTeam: '預設分享給團隊',
            sessionCreationRequired: '一律分享給團隊',
            sessionCreationHelp: '這適用於新的工作階段。既有的私人工作階段不會被公開。',
            externalSharingAllowed: '任何有分享權限的人',
            externalSharingAdmins: '僅團隊管理員',
            externalSharingDisabled: '不允許',
            externalSharingHelp: '這可以阻擋日後的分享，但不會收回已經分享出去的副本。',
            historyDefaultHelp: '這會為新成員預先選取該選項，不會改寫既有成員的歷程範圍。',
        },
        logo: {
            add: '新增標誌',
            replace: '更換標誌',
            remove: '移除標誌',
            removeConfirmTitle: '要移除此標誌嗎？',
            removeConfirmBody: '團隊會重新顯示其字母圖案。你隨時可以上傳新的標誌。',
            previewLabel: '標誌預覽',
            useAsLogo: '用作標誌',
            monogramLabel: '團隊字母圖案',
            tooLarge: '該圖片過大，請選擇較小的圖片。',
            invalidFormat: ({ formats }: { formats: string }) => `該檔案不是支援的圖片格式。支援的格式：${formats}。`,
            failed: '標誌未上傳，目前的標誌維持不變。',
            retry: '再試一次',
        },
        archive: {
            archivedTitle: ({ name }: { name: string }) => `${name} 已封存`,
            archivedBody: "團隊存取已停止，這裡無法變更任何內容。成員、群組與紀錄皆已保留。",
            confirm: {
                keptCounted: ({ members, groups }: { members: number; groups: number }) => `${members} 位成員、${groups} 個群組及其紀錄將保留。`,
                kept: "成員、群組及其紀錄將保留。",
                invitationsStop: ({ count }: { count: number }) => `${count} 個待接受的邀請連結將失效，還原後也不會恢復。`,
                restore: "可隨時還原；保留的存取權會在仍然適用之處恢復。",
            },
            openSettings: '開啟設定',
            action: ({ name }: { name: string }) => `封存 ${name}`,
            confirmTitle: ({ name }: { name: string }) => `要封存 ${name} 嗎？`,
            restoreAction: ({ name }: { name: string }) => `還原 ${name}`,
            restoreTitle: ({ name }: { name: string }) => `要還原 ${name} 嗎？`,
            restoreBody: () => '在帳戶與資源仍然允許的範圍內，目前的成員資格、群組與保留的授權會重新生效。已撤銷的邀請連結不會回復。',
            readOnly: '此團隊已封存。還原後才能變更。',
        },
        members: {
            roleReadOnly: ({ team }: { team: string }) => `只有 ${team} 的擁有者與管理員可以變更角色。`,
            roleSetBy: ({ source }: { source: string }) => `由 ${source} 設定。`,
            accessSection: "存取權",
            lifecycleFootnote: "停權後，其存取會停止，直到你重新啟用。移除則終止存取；其寫下的內容會保留，重新加入將開始新的成員身分。",
            removal: {
                title: ({ name, team }: { name: string; team: string }) => `要將 ${name} 從 ${team} 移除嗎？`,
                action: ({ team }: { team: string }) => `從 ${team} 移除…`,
                ends: "其團隊與群組存取權立即終止。",
                leavesGroups: ({ groups }: { groups: string }) => `將離開 ${groups}。`,
                leavesGroupsAndMore: ({ groups }: { groups: string }) => `將離開 ${groups} 及其所在的其他群組。`,
                kept: "其寫下的工作階段與訊息保留在原處。",
            },
            filterLabel: '顯示',
            searchPlaceholder: '搜尋成員',
            filterAll: '全部',
            filterOwnersAndAdmins: '擁有者與管理員',
            addMenu: {
                existing: '新增此 Home 上的人',
                existingBody: ({ home }: { home: string }) => `從已在 ${home} 擁有帳號的人中選擇。`,
                invite: '透過連結或電子郵件邀請',
                inviteBody: ({ team }: { team: string }) => `適用於其他人。他們接受後加入 ${team}。`,
            },
            filterMembers: '成員',
            filterGuests: '訪客',
            filterSuspended: '已暫停',
            emptyTitle: '沒有符合的成員',
            emptyBody: '請調整篩選條件，或邀請他人加入此團隊。',
            add: '新增成員',
            addTitle: ({ team }: { team: string }) => `加入 ${team}`,
            personLabel: '成員',
            roleLabel: '角色',
            personPlaceholder: '在此 Home 中搜尋成員',
            ineligible: '已在此團隊中，或不是此 Home 的有效帳戶。',
            addSubmit: '新增成員',
            you: '你',
            joined: ({ when }: { when: string }) => `於 ${when} 加入`,
            managedBy: ({ source }: { source: string }) => `透過 ${source} 管理`,
            managedReadOnly: '此成員資格由其來源管理，請在該處變更。',
            detailManagedBy: '管理方',
            managementTitle: '管理來源',
            managementHelp: '變更管理來源會保留此成員資格及其角色、狀態與工作階段歷史，只有誰能變更會隨之改變。',
            managementNative: '在 Happier 中管理',
            managementConflict: '該來源尚無可關聯到此人的身分。請先同步該來源，然後再試一次。',
            encryption: {
                title: '加密存取',
                checking: '正在檢查加密存取…',
                ready: '已準備',
                scopeBody: '這裡只包括您管理的工作階段。其他工作階段管理者可能仍需準備存取權限。',
                pending: '待準備',
                prepare: '準備加密存取',
                preparing: ({ prepared }: { prepared: number }) => `正在準備加密存取 · 已準備 ${prepared} 個`,
                setupRequired: '需要設定',
                setupRequiredBody: '此人尚未完成加密存取的設定。完成後你可以為其準備對話歷程。',
                notEncrypted: '未加密',
                plainAccount: '此人的帳戶未使用端對端加密，因此無需準備。',
                repairRequired: '加密存取需要修復',
                repairBody: '你管理的部分對話無法在此裝置上準備。請打開它們以修復你自己的存取權。',
                nonTransferableBody: '部分對話使用較早的加密格式，無法分享給新成員。已有存取權限的人仍可閱讀。',
                recipientChanged: '此人的帳戶已變更。正在重新載入後再準備。',
                retry: '重試',
                failed: '準備在完成前停止。已準備的內容已保留。',
            },
            detailGroups: '群組',
            detailGroupsEmpty: '沒有群組',
            suspend: '暫停成員',
            suspendTitle: ({ name }: { name: string }) => `要暫停 ${name} 嗎？`,
            suspendBody: '團隊與群組存取會立即停止。群組成員資格與資源指派會保留，恢復後只會重新啟用仍然有效的存取。Home 帳戶與其他團隊不受影響。',
            reactivate: '恢復成員',
            reactivateTitle: ({ name }: { name: string }) => `要恢復 ${name} 嗎？`,
            reactivateBody: '在成員資格、群組與帳戶狀態仍然允許的範圍內，存取會恢復。',
            remove: '移出團隊',
            lastOwnerBlocked: '團隊至少要保留一位使用中的擁有者。請先指定另一位擁有者。',
            accountInactive: '此人的帳戶並非使用中，無法新增或設為擁有者。',
            ownerOnlyAction: '只有團隊擁有者才能變更擁有者。',
            ownerRequiredTitle: '需要擁有者',
            ownerRequiredBody: ({ team }: { team: string }) => `${team} 需要一位使用中的擁有者才能進行僅限擁有者的變更。`,
            chooseOwner: '選擇擁有者',
            ownerRequiredNoCandidate: '沒有符合資格的成員。需要先新增一位既有成員，或安排一次所有權交接。',
        },
        groups: {
            detailsSection: '群組',
            title: '群組',
            emptyTitle: '尚未有群組',
            emptyBody: '群組是團隊成員的一個扁平集合，可以一次分享給他們。',
            emptyRosterTitle: '此群組尚未有成員',
            noEligibleCandidatesTitle: '沒有可新增的人',
            noEligibleCandidatesBody: '尚未加入此群組的團隊成員會顯示在這裡。',
            create: '新增群組',
            nameLabel: '名稱',
            namePlaceholder: '開發',
            descriptionPlaceholder: '此群組的用途',
            submit: '建立群組',
            nameTaken: '此團隊中已有同名的群組。',
            memberCount: ({ count }: { count: number }) => `${count} 位成員`,
            managedBy: ({ source }: { source: string }) => `由 ${source} 管理`,
            membersSection: '群組成員',
            addMember: '加入群組',
            removeNative: '移出群組',
            removeMemberTitle: ({ name, group }: { name: string; group: string }) => `將 ${name} 從 ${group} 中移除？`,
            removeMemberBody: ({ name, group }: { name: string; group: string }) => `${name} 將立即失去來自 ${group} 的存取權限。該成員仍留在 Team 中，你可以再次將其加入該群組。`,
            externalOnlyTitle: '由其來源管理',
            externalOnlyBody: ({ source }: { source: string }) => `${source} 仍在提供此人，因此他們會留在群組中。請在該來源的設定中變更。`,
            archiveAction: ({ name }: { name: string }) => `封存 ${name}`,
            archiveTitle: ({ name }: { name: string }) => `要封存 ${name} 嗎？`,
            archiveBody: '以群組為基礎的存取會立即停止。成員資格與歷程會保留，還原該群組後這些授權可能會重新生效。',
            restoreAction: ({ name }: { name: string }) => `還原 ${name}`,
            archivedSection: '已封存的群組',
            archivedReadOnly: '此群組已封存。還原後才能變更。',
            managedReadOnly: '該群組的名稱與生命週期由其來源管理，但仍可在此新增成員。',
        },
        invitations: {
            waitingSection: "等待中",
            finishedSection: "已結束",
            sendAgain: "重新傳送",
            emptyTitle: '沒有邀請',
            emptyBody: '用連結邀請他人，或新增已在此 Home 擁有帳戶的人。',
            invite: '邀請',
            inviteTitle: ({ team }: { team: string }) => `邀請加入 ${team}`,
            byLink: '連結',
            byEmail: '電子郵件',
            emailLabel: '電子郵件地址',
            emailPlaceholder: 'name@example.tw',
            create: '建立邀請',
            linkNotice: ({ team, role }: { team: string; role: string }) => `任何已登入此 Home 並持有該連結的人，都可以用${role}身分加入 ${team}。`,
            copyLink: '複製連結',
            copied: '連結已複製',
            qrLabel: '此邀請連結的 QR 圖碼',
            qrTooLargeFallback: '此連結太長，無法產生 QR 圖碼。請改為複製。',
            linkRow: '邀請連結',
            maskedRecipient: ({ email }: { email: string }) => `寄給 ${email}`,
            expires: ({ when }: { when: string }) => `${when} 到期`,
            stateActive: '有效',
            stateAccepted: '已接受',
            stateRevoked: '已撤銷',
            stateExpired: '已到期',
            deliverySent: '郵件已送出',
            deliveryFailed: '郵件投遞失敗',
            deliveryUnknown: '投遞結果不明',
            deliveryRetry: '重試',
            deliveryChangeEmail: '變更信箱',
            emailUnavailable: '此 Home 無法寄送郵件，請改為分享連結。',
            reissue: '建立新連結',
            reissueNotice: '重新簽發會建立新連結，先前的連結將停止運作。',
            revoke: '撤銷邀請',
            revokeTitle: '要撤銷此邀請嗎？',
            revokeBody: '該連結會立即停止運作。你隨時可以建立新的連結。',
            shareLink: '分享連結',
            shareUnavailable: '此裝置不支援分享。請改為複製連結。',
            bearerUnavailable: '此連結只顯示過一次，並未儲存。請建立新連結以再次分享存取權。',
            linkUnavailableRow: '沒有可分享的連結',
            linkUnavailableBody: '此 Home 尚未發佈可供邀請連結指向的位址，因此沒有可分享的連結。請 Home 管理員發佈一個位址，或從 Team 的成員清單中直接新增人員。',
        },
        join: {
            previewLoading: '正在檢查此邀請…',
            joinAction: ({ team }: { team: string }) => `加入 ${team}`,
            joinWithCurrentAccount: '使用此帳號加入',
            addInvitedAddressNotice: ({ email }: { email: string }) => `${email} 將作為已驗證地址新增到此帳號。`,
            useAnotherAccount: '使用其他帳號',
            useCurrentAccount: '使用目前帳號',
            useAnotherAccountHint: '在不登出此帳號的情況下登入此 Home。',
            hostedOn: ({ home }: { home: string }) => `託管於 ${home}`,
            personalHomeNotice: '此 Home 執行於個人電腦上，離線時可能無法存取。',
            plainStorageNotice: '此 Home 上的工作階段並未使用端對端加密儲存。',
            invitedBy: ({ name }: { name: string }) => `由 ${name} 邀請。`,
            roleOffered: ({ role }: { role: string }) => `你被邀請成為${role}。`,
            guestNotice: ({ team }: { team: string }) => `以訪客身分加入不會取得 ${team} 團隊工作階段的存取權。相關內容必須單獨分享給你或你所屬的某個群組。`,
            joinedTitle: '你已加入',
            alreadyMemberTitle: '你已經是成員',
            openTeam: ({ team }: { team: string }) => `開啟 ${team}`,
            expiredTitle: '此邀請已到期',
            revokedTitle: '此邀請已被撤銷',
            usedTitle: '此邀請已被使用',
            archivedTitle: '此團隊已封存',
            inactiveTitle: '此帳戶目前無法加入',
            invalidTitle: '此邀請連結無效',
            unresolvedHomeTitle: '此連結未標明所屬 Home',
            unresolvedHomeBody: '此裝置無法判斷哪個 Home 簽發了該邀請，因此沒有向任何 Home 傳送內容。請向團隊管理者索取新的連結。',
            unknownHomeTitle: '此裝置尚未新增該 Home',
            askForNew: '請向團隊管理者索取新的邀請。',
            mismatchTitle: '此邀請是給另一個地址的',
            signInWithInvited: '使用受邀地址登入',
            verifyAddress: '驗證此地址',
            updateRequiredTitle: '此 Home 需要更新才能使用團隊邀請',
            offlineTitle: '無法連線至此 Home',
            offlineBody: '邀請已保留。請在 Home 恢復後再試一次。',
            acceptanceOutcomeUnknown: '無法確認你是否已加入。請再試一次以檢查同一邀請。',
            retry: '再試一次',
        },
        credentials: {
            recovery: {
                openSettings: '\u958b\u555f\u6191\u8b49\u8a2d\u5b9a',
                selectBroker: '\u9078\u64c7\u4ee3\u7406\u4f4d\u7f6e',
                ownerHandoff: '\u8acb\u4f86\u6e90\u64c1\u6709\u8005\u4fee\u5fa9\u6b64\u6191\u8b49',
                updateApp: '\u66f4\u65b0 Happier',
                chooseAnother: '\u9078\u64c7\u5176\u4ed6\u6191\u8b49',
            },
            requestPolicy: {
                title: '請求政策',
                subtitle: '限制可以用這份憑證做什麼。',
                summaryNone: '沒有限制',
                summaryActive: ({ count }: { count: number }) => `${count} 項限制`,
                protocolsLabel: '請求格式',
                protocolsAny: '來源支援的全部格式',
                modelsLabel: '模型',
                modelsAny: '來源提供的全部模型',
                modelsAllowed: ({ count }: { count: number }) => `允許 ${count} 個`,
                effortLabel: '推理強度',
                effortAny: '來源支援的全部強度',
                catalogUnavailable: '目前還無法從這個 Home 選擇允許哪些模型。現有選擇在被移除之前仍然有效。',
                clear: '移除所有限制',
                activeNote: '已經在執行的工作階段不會被改寫。它的下一次請求需要符合新政策。',
                protocol: {
                    openaiResponses: 'OpenAI Responses',
                    openaiChatCompletions: 'OpenAI Chat Completions',
                    anthropicMessages: 'Anthropic Messages',
                },
            },
            directReadiness: {
                title: '直接存取準備狀況',
                check: '檢查準備狀況',
                summary: ({ ready, pending }: { ready: number; pending: number }) => `${ready} 項就緒 · ${pending} 項準備中`,
                allReady: '擁有直接存取權限的人都已就緒。',
                automatic: '材料會在持有該來源的電腦上準備，只要它在線就會進行。',
                state: {
                    ready: '就緒',
                    preparing: '正在準備存取',
                    notDelivered: '尚未送達',
                    recipientBindingChanged: '等待加密帳號設定',
                    sourceChanged: '來源已變更 — 正在更新',
                },
            },
            externalApi: {
                title: '外部 API 存取',
                subtitle: '在 Happier 之外的相容工具中使用這個供應商。',
                privateTitle: 'Happier 工作階段',
                privateDetail: '透過 Happier 私密進行',
                unavailable: '這個 Home 不提供外部 API 存取。',
                publicHttpsRequired: '外部工具需要此 Home 的公開 HTTPS 位址。',
                homeDisclosure: '傳送給供應商的原始請求內容會經過此 Home 的公開 HTTPS 端點，其營運者可以讀取這些內容。',
                bearerDisclosure: '此金鑰是持有者憑證。任何持有者都能使用獲派的存取權，直到金鑰到期或遭撤銷。',
                usageDisclosure: 'Happier 會記錄請求次數。如果通訊協定無法回報，權杖與費用總計可能不完整。',
                keysTitle: 'API 金鑰',
                authorize: '授權金鑰',
                authenticationRequired: '指定成員需要透過團隊登入授權此金鑰。',
                authenticationUnavailable: '團隊驗證無法使用。請團隊管理員檢查登入政策。',
                keysLoadFailed: '無法載入 API 金鑰。',
                keysRetry: '重新載入金鑰',
                keysEmpty: '還沒有金鑰',
                keysEmptyBody: '建立第一個金鑰會開啟外部存取；撤銷最後一個會關閉它。',
                labelPlaceholder: '這個金鑰的用途',
                assignLabel: '歸屬於',
                revealTitle: '現在就儲存這個金鑰',
                revealBody: '它不會再次顯示。',
                revealDismiss: {
                    title: '尚未複製金鑰，仍要關閉嗎？',
                    body: '此金鑰無法再次顯示。請保持顯示，直到你將它儲存好。',
                    confirm: '我已儲存金鑰',
                    keepVisible: '繼續顯示金鑰',
                },
                neverUsed: '從未使用',
                lastUsed: ({ when }: { when: string }) => `上次使用 ${when}`,
                expiresOn: ({ when }: { when: string }) => `到期 ${when}`,
                expired: '已過期',
                revokeTitle: ({ name }: { name: string }) => `撤銷 ${name}？`,
                revokeBody: '使用這個金鑰的工具會立刻停止運作。Happier 工作階段不受影響。',
                revokeAll: '撤銷全部金鑰',
                revokeAllBody: '在建立新金鑰之前，外部 API 存取會被關閉。Happier 工作階段不受影響。',
            },
            title: '\u5171\u7528\u6191\u8b49',
            subtitle: '\u8b93\u5718\u968a\u4f7f\u7528\u5df2\u9023\u63a5\u5e33\u865f\u3001\u8cc7\u6e90\u6c60\u6216\u63d0\u4f9b\u8005\uff0c\u800c\u4e0d\u5fc5\u8907\u88fd\u5230\u6bcf\u4f4d\u6210\u54e1\u7684\u8a2d\u5b9a\u4e2d\u3002',
            emptyTitle: '\u5c1a\u7121\u5171\u7528\u6191\u8b49',
            emptyBody: '\u9084\u6c92\u6709\u4efb\u4f55\u5167\u5bb9\u5206\u4eab\u7d66\u9019\u500b\u5718\u968a\u3002',
            forbidden: '\u5171\u7528\u6191\u8b49\u7531\u8a72\u5718\u968a\u7684\u64c1\u6709\u8005\u8207\u7ba1\u7406\u54e1\u7ba1\u7406\u3002',
            unavailable: '\u6b64 Home \u4e0d\u63d0\u4f9b\u5171\u7528\u6191\u8b49\u3002',
            approvalPending: '正在等待核准。在決定之前會保留變更。',
            approvalDeclined: '這項請求未獲核准，因此沒有任何變更。',
            sessionDeniedTitle: '共用憑證拒絕了這項請求',
            sharedByYou: '\u7531\u4f60\u5206\u4eab',
            providedByTeams: '\u7531\u5718\u968a\u63d0\u4f9b',
            sharedWithYou: '\u8207\u4f60\u5206\u4eab',
            sourceAdministration: { title: '\u8207\u5718\u968a\u5171\u4eab', empty: '\u6b64\u4f86\u6e90\u672a\u8207\u4efb\u4f55\u5718\u968a\u5171\u4eab\u3002' },
            source: {
                connectedAccount: '\u5df2\u9023\u63a5\u5e33\u865f',
                pool: '\u5df2\u9023\u7dda\u670d\u52d9\u6c60',
                providerConnection: '\u63d0\u4f9b\u8005\u9023\u7dda',
            },
            delivery: {
                brokered: '\u7d93\u4ee3\u7406',
                direct: '\u76f4\u63a5\u5b58\u53d6',
                both: '\u4ee3\u7406 + \u76f4\u63a5',
                mixed: '\u6df7\u5408\u905e\u9001',
            },
            state: {
                available: '\u53ef\u7528',
                needsAttention: '\u9700\u8981\u8655\u7406',
                disabled: '\u5df2\u505c\u7528',
            },
            usePolicy: {
                title: '要與團隊共用這個工作階段嗎？',
                label: '\u6210\u54e1\u53ef\u5728\u54ea\u88e1\u4f7f\u7528',
                personalAllowed: '\u4efb\u4f55\u5141\u8a31\u7684\u5de5\u4f5c\u968e\u6bb5',
                teamContextRequired: '\u96b8\u5c6c\u65bc\u6b64\u5718\u968a\u7684\u5de5\u4f5c\u968e\u6bb5',
                teamVisibilityRequired: '\u6b64\u5718\u968a\u53ef\u898b\u7684\u5de5\u4f5c\u968e\u6bb5',
                visibilityNote: '\u9078\u64c7\u6b64\u6191\u8b49\u53ef\u80fd\u5728\u672c\u4eba\u78ba\u8a8d\u5f8c\u5c07\u79c1\u5bc6\u5de5\u4f5c\u968e\u6bb5\u5206\u4eab\u7d66\u5718\u968a\u3002',
            },
            selection: {
                activeTransitionUnsupported: '這個工作階段在變更儲存前就開始執行，因此模型沒有變更。請再試一次。',
            },
            detail: {
                sourceLabel: '\u4f86\u6e90',
                brokerLabel: '\u4ee3\u7406\u4f4d\u7f6e',
                brokerNone: '\u9078\u64c7\u4ee3\u7406\u4f4d\u7f6e',
                access: '\u5b58\u53d6\u8207\u905e\u9001',
                activity: '\u6d3b\u52d5',
                edit: '\u7de8\u8f2f',
                notFound: '\u6b64\u5171\u7528\u6191\u8b49\u5df2\u4e0d\u53ef\u7528\u3002',
                brokerUnnamedMachine: '未命名的電腦',
                brokerUnnamedPool: '未命名的集區',
                brokerChosen: '由來源擁有者選擇',
                limits: '用量上限',
                usage: '用量',
            },
            create: {
                title: '分享憑證',
                action: '分享憑證',
                submit: '建立共用憑證',
                sourceChoose: '選擇來源',
                sourceEmpty: '目前沒有可分享的項目。',
                sourceUnsupported: '此 Home 尚無法分享已連接帳號與供應商連線。',
                alreadyShared: '已與此團隊分享',
                poolAccounts: ({ count }: { count: number }) => `${count} 個帳號`,
                notAllowed: '此團隊不允許你提供自己的憑證。',
                reviewLabel: '確認',
            },
            edit: {
                title: '\u7de8\u8f2f\u5171\u7528\u6191\u8b49',
                nameLabel: '\u540d\u7a31',
                namePlaceholder: '\u70ba\u6b64\u6191\u8b49\u547d\u540d',
                ceilingLabel: '\u76f4\u63a5\u63ed\u9732',
                ceilingBrokeredOnly: '\u50c5\u7d93\u4ee3\u7406',
                ceilingDirectAllowed: '\u5141\u8a31\u76f4\u63a5\u5b58\u53d6',
                ceilingNote: '\u76f4\u63a5\u5b58\u53d6\u6703\u8b93\u63a5\u6536\u65b9\u7684\u672c\u6a5f\u5de5\u5177\u53d6\u5f97\u6191\u8b49\u8cc7\u6599\u3002\u79fb\u9664\u5b58\u53d6\u6703\u505c\u6b62\u5f8c\u7e8c\u905e\u9001\uff0c\u4f46\u7121\u6cd5\u62b9\u9664\u5916\u90e8\u7a0b\u5e8f\u5df2\u4f7f\u7528\u7684\u5167\u5bb9\u3002',
                conflict: '\u9019\u4e9b\u8a2d\u5b9a\u5df2\u5728\u5176\u4ed6\u5730\u65b9\u8b8a\u66f4\u3002\u5132\u5b58\u524d\u8acb\u91cd\u65b0\u8f09\u5165\u4ee5\u67e5\u770b\u76ee\u524d\u503c\u3002',
            },
            audience: {
                title: '\u5b58\u53d6\u8207\u905e\u9001',
                none: '\u9084\u6c92\u6709\u4eba',
                everyone: '\u5718\u968a\u6240\u6709\u4eba',
                everyoneOff: '\u7121\u5168\u5718\u968a\u5b58\u53d6',
                groupCount: ({ count }: { count: number }) => `${count} \u500b\u7fa4\u7d44`,
                memberCount: ({ count }: { count: number }) => `${count} \u4eba`,
                add: '新增群組或成員',
                groupsSection: '\u7fa4\u7d44',
                membersSection: '\u6210\u54e1',
                remove: '\u79fb\u9664\u5b58\u53d6',
                ceilingBlocked: '\u6b64\u6191\u8b49\u4e0d\u5141\u8a31\u76f4\u63a5\u5b58\u53d6\u3002\u8acb\u5148\u5728\u7de8\u8f2f\u4e2d\u5141\u8a31\u3002',
                directTitle: '\u76f4\u63a5\u5206\u4eab\u6b64\u6191\u8b49\uff1f',
                directBody: '\u4f60\u9078\u64c7\u7684\u4eba\u54e1\u7684\u672c\u6a5f\u5de5\u5177\u53ef\u80fd\u53d6\u5f97\u6b64\u4f86\u6e90\u7684\u6191\u8b49\u8cc7\u6599\u3002\u79fb\u9664\u5b58\u53d6\u6703\u505c\u6b62\u5f8c\u7e8c\u905e\u9001\uff0c\u4f46\u7121\u6cd5\u62b9\u9664\u5916\u90e8\u7a0b\u5e8f\u5df2\u4f7f\u7528\u7684\u5167\u5bb9\u3002',
                directConfirm: '\u76f4\u63a5\u5206\u4eab',
                keepBrokered: '\u4fdd\u6301\u7d93\u4ee3\u7406',
                limitsNote: '\u76f4\u63a5\u4f7f\u7528\u767c\u751f\u5728 Happier \u4e4b\u5916\uff0c\u4e0d\u6703\u88ab\u8a18\u9304\u3002',
            },
            directUse: {
                title: '\u76f4\u63a5\u4f7f\u7528\u6b64\u5171\u4eab\u6191\u8b49\uff1f',
                body: 'Happier \u53ef\u80fd\u6703\u5411\u6b64\u5de5\u4f5c\u968e\u6bb5\u4f7f\u7528\u7684\u672c\u6a5f\u5de5\u5177\u63d0\u4f9b\u6191\u8b49\u8cc7\u6599\u3002\u53ea\u6709\u5728\u4f60\u4fe1\u4efb\u9019\u4e9b\u5de5\u5177\u8655\u7406\u6b64\u6191\u8b49\u6642\u624d\u7e7c\u7e8c\u3002',
            },
            delete: {
                action: '\u522a\u9664\u5171\u7528\u6191\u8b49',
                title: ({ name }: { name: string }) => `\u522a\u9664 ${name}\uff1f`,
                body: '\u6210\u54e1\u6703\u7acb\u5373\u5931\u53bb\u5b58\u53d6\uff0c\u4e0b\u4e00\u6b21\u8acb\u6c42\u5c07\u5931\u6557\u3002\u5df2\u76f4\u63a5\u905e\u9001\u7684\u8cc7\u6599\u7121\u6cd5\u62b9\u9664\u3002',
            },
            errors: {
                featureDisabled: '\u6b64 Home \u4e0d\u63d0\u4f9b\u5171\u7528\u6191\u8b49\u3002',
                teamAuthenticationRequired: '\u8acb\u5148\u767b\u5165\u6b64\u5718\u968a\u518d\u7e7c\u7e8c\u3002',
                teamAuthenticationPolicyUnavailable: '\u7121\u6cd5\u8b80\u53d6\u6b64\u5718\u968a\u7684\u767b\u5165\u653f\u7b56\uff0c\u56e0\u6b64\u6c92\u6709\u8b8a\u66f4\u4efb\u4f55\u5167\u5bb9\u3002',
                memberNotEligible: '\u6b64\u4eba\u7121\u6cd5\u4f7f\u7528\u6b64\u6191\u8b49\u3002',
                sessionPolicyIncompatible: '\u4f9d\u5171\u7528\u653f\u7b56\uff0c\u6b64\u6191\u8b49\u7121\u6cd5\u5728\u6b64\u5de5\u4f5c\u968e\u6bb5\u4e2d\u4f7f\u7528\u3002',
                brokerUnavailable: '此憑證的中介機器目前無法連線。等它恢復後再試，或改選其他中介位置。',
                sourceOwnerRequired: '只有擁有該來源的人才能做這項變更。',
                sourceMissing: '此憑證指向的來源已不存在。需要由其擁有者重新選擇來源。',
                invalidAudience: '這些成員或群組無法取得此憑證。',
                subjectNotInTeam: '該成員或群組已不在此團隊中。',
                costUnavailable: '費用上限需要每個允許的模型都有價格，但有些缺少價格。請改以請求數或權杖數設限。',
                invalidLimit: '請檢查計量方式、週期與上限值。',
                limitIdentityImmutable: '上限的適用對象、計量方式與週期無法變更。請刪除後新增一筆。',
            },
            limits: {
                groupShared: '\u6b64\u984d\u5ea6\u7531\u7fa4\u7d44\u4e2d\u7684\u6240\u6709\u4eba\u5171\u7528\u3002',
                title: '用量上限',
                empty: '尚未設定上限',
                emptyBody: '在你新增之前，所有請求都會被允許。',
                overshoot: '已記錄用量達到上限後，新的請求會停止。正在進行的請求可能會跑完。',
                directNote: '上限涵蓋經中介的用量與外部 API 用量。直接使用發生在接收者自己的機器上，不會被記錄。',
                directOnly: '所有有權限的人都在自己的機器上直接使用此憑證，因此 Happier 無法記錄任何用量，也無法套用上限。',
                requestLimitsOnlyForPersonalUse: '當此憑證要求團隊情境時，才會出現權杖上限。個人使用還允許背景執行和外部 API 使用它，而它們只回報請求數，因此只有請求上限能涵蓋全部使用。',
                add: '新增上限',
                subjectLabel: '適用於',
                subject: {
                    resource: '整個共用憑證',
                    eachMember: '每位成員各自計算',
                    group: '群組',
                    member: '成員',
                },
                metricLabel: '計量方式',
                metric: {
                    requests: '請求數',
                    tokens: '權杖數',
                    cost: '費用',
                },
                costNote: '只有當此憑證允許的每個模型都有已知價格時，費用上限才會生效。',
                periodLabel: '週期',
                period: {
                    day: '每天',
                    week: '每週',
                    month: '每月',
                },
                maximumLabel: '上限值',
                maximumPlaceholder: '每個週期的上限值',
                maximumInvalid: '請輸入大於零的整數。',
                maximumInvalidCost: '請輸入大於零的金額。',
                recorded: ({ recorded, maximum }: { recorded: string; maximum: string }) => `已記錄 ${recorded} / ${maximum}`,
                resetsUtc: ({ when }: { when: string }) => `${when} UTC 重設`,
                reached: '已達上限',
                disabled: '已關閉',
                remove: '刪除上限',
                removeTitle: '要刪除這筆上限嗎？',
                removeBody: '請求會立即不再與它比對。已記錄的用量會保留。',
                unknownSubject: '本頁之外的某人',
            },
            usage: {
                title: '用量',
                empty: '這段期間沒有任何記錄。',
                rangeLabel: '週期',
                brokeredRequests: '經代理的請求',
                directOnlyRequests: '僅統計經代理使用的請求。',
                recordedRequests: '已記錄的請求',
                requestIncomplete: '僅包含 Happier 觀察到的請求。',
                externalObservationsIncomplete: ({ count }: { count: number }) => `${count} 個外部請求尚無已記錄的結果。`,
                breakdownRestricted: '部分維度僅向憑證管理者顯示。',
                export: '匯出 CSV',
                exportFailed: '此裝置無法儲存匯出檔案。',
                recordedByHappier: '由 Happier 記錄。',
                directIncomplete: '直接使用發生在 Happier 之外，可能未計入。',
                costIncomplete: '這段期間部分模型的費用無法取得。',
                tokenIncomplete: '此期間的權杖總數不完整。',
                tokenUnavailable: '此期間未觀察到權杖使用。',
                costUnavailable: '此期間未觀察到有定價的使用。',
                costUnknown: '無法取得',
                breakdownLabel: '拆分維度',
                breakdownNone: '僅顯示合計',
                breakdown: {
                    member: '成員',
                    externalApiKey: '外部 API 金鑰',
                    model: '模型',
                    session: '工作階段',
                    sourceMember: '來源帳戶',
                    workerMachine: '工作機器',
                    brokerMachine: '中介機器',
                    deliveryMode: '交付方式',
                },
                limitsTitle: '這段期間的上限',
                sliceSummary: ({ requests, tokens }: { requests: string; tokens: string }) => `${requests} 次請求 · ${tokens} 個權杖`,
            },
            activity: {
                title: '\u6d3b\u52d5',
                empty: '\u5c1a\u672a\u8a18\u9304\u4efb\u4f55\u7ba1\u7406\u8b8a\u66f4\u3002',
                unknownActor: '\u67d0\u4eba',
                kind: {
                    resourceCreated: '\u5206\u4eab\u4e86\u6b64\u6191\u8b49',
                    resourceUpdated: '\u8b8a\u66f4\u4e86\u8a2d\u5b9a',
                    audienceChanged: '\u8b8a\u66f4\u4e86\u53ef\u4f7f\u7528\u8005',
                    resourceDeleted: '\u522a\u9664\u4e86\u6b64\u6191\u8b49',
                    directDelivered: '\u905e\u9001\u4e86\u76f4\u63a5\u5b58\u53d6',
                    externalKeyCreated: '\u5efa\u7acb\u4e86\u5916\u90e8 API \u91d1\u9470',
                    externalKeyRevoked: '\u8b8a\u66f4\u4e86\u5916\u90e8 API \u91d1\u9470\u72c0\u614b',
                    limitsChanged: '\u8b8a\u66f4\u4e86\u4e0a\u9650',
                },
            },
        },
    },
};

const teamsTranslations = { zhHant: traditionalChinese };

return { teamsTranslations };
})();

const Domain_terminalWorkspaceTranslations = (() => {
const en = Shared_terminalWorkspaceTranslations.en;

const terminalWorkspaceKeyboardTranslations = Shared_terminalWorkspaceTranslations.terminalWorkspaceKeyboardTranslations;

const terminalWorkspaceTranslations = { 'zh-Hant': en };

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

const zhHant: ThisComputerConnectionTranslation = {
    connectHome: {
        title: ({ home }: HomeParams) => `將此電腦連線至${home}？`,
        body: ({ home }: HomeParams) => `${home}將能在此電腦上啟動工作階段。終端機的Home和其他Home連線將保持不變。`,
        connect: '連線',
        keep: '保留目前連線',
    },
    setupAlreadyRunning: '設定正在進行。請等待完成。',
    title: {
        daemon_url_mismatch: '背景服務正在使用其他 Home',
        daemon_account_mismatch: '背景服務正在使用其他帳號',
        daemon_needs_auth: '背景服務需要登入',
        daemon_not_configured: '背景服務尚未連線',
        daemon_not_installed: '背景服務未安裝',
        daemon_not_running: '背景服務已停止',
    },
    description: {
        daemon_url_mismatch: ({ home, daemonHome }: OtherHomeParams) => `它連線的是 ${daemonHome}，而不是 ${home}。`,
        daemon_account_mismatch: ({ home, daemonAccount, appAccount }: AccountParams) =>
            `它以 ${daemonAccount} 而不是 ${appAccount} 的身分登入了 ${home}。`,
        daemon_needs_auth: ({ home }: HomeParams) => `它已連線到 ${home}，但尚未獲得核准。`,
        daemon_not_configured: ({ home }: HomeParams) => `它尚未完成與 ${home} 的連線。`,
        daemon_not_installed: ({ home }: HomeParams) => `安裝後即可將這台電腦連線到 ${home}。`,
        daemon_not_running: ({ home }: HomeParams) => `啟動它即可重新連線到 ${home}。`,
    },
    action: {
        daemon_url_mismatch: '連線到此 Home',
        daemon_account_mismatch: ({ appAccount }: { appAccount: string }) => `切換到 ${appAccount}`,
        daemon_needs_auth: '登入',
        daemon_not_configured: '連線到此 Home',
        daemon_not_installed: '安裝背景服務',
        daemon_not_running: '啟動背景服務',
    },
    connected: ({ home, appAccount }: { home: string; appAccount: string }) => `已以 ${appAccount} 的身分連線到 ${home}。`,
    noComputers: ({ home, appAccount }: { home: string; appAccount: string }) => `${appAccount} 在 ${home} 上還沒有電腦。`,
    openThisComputer: '查看這台電腦',
    moveConfirm: {
        title: ({ appAccount }: { appAccount: string }) => `要將這台電腦切換到 ${appAccount} 嗎？`,
        body: ({ home, daemonHome, daemonAccount, appAccount }: MoveParams) =>
            `它的背景服務以 ${daemonAccount} 的身分登入了 ${daemonHome}。切換後，它會在 ${home} 上為 ${appAccount} 運作，${daemonAccount} 將不再看到這台電腦。`,
        confirm: '切換',
    },
    cli: {
        title: 'Happier CLI',
        version: ({ version }: { version: string }) => `版本 ${version}`,
        updateAvailable: ({ version, latestVersion }: { version: string; latestVersion: string }) =>
            `版本 ${version} · 可更新至 ${latestVersion}`,
        update: '更新',
        progressTitle: '正在更新 Happier CLI',
        notManaged: ({ origin }: { origin: string }) => `在 Happier 之外安裝：${origin}`,
    },
    cliChoice: {
        title: ({ version }: { version: string }) => `已安裝 Happier CLI ${version}`,
        titleUnknownVersion: '已安裝 Happier CLI',
        titleMissing: '你的 Happier CLI 已不再安裝',
        body: ({ path }: { path: string }) => `它位於 ${path}。Happier 可以安裝自己的副本、保持更新並放在 PATH 最前面，你也可以繼續使用這個。`,
        bodyOutdated: ({ path }: { path: string }) => `它位於 ${path}，但版本太舊，無法完成設定。Happier 可以安裝最新的副本並放在 PATH 最前面，你也可以保留自己的並自行更新。`,
        bodyMissing: ({ path }: { path: string }) => `你選擇保留位於 ${path} 的 CLI，但它已經不在那裡了。Happier 可以安裝自己的副本並保持更新，你也可以重新安裝你自己的並繼續使用。`,
        bodyKeepBlocked: ({ path, link }: { path: string; link: string }) => `它位於 ${path}，但新終端機會先透過 ${link} 執行 Happier 自己的 CLI，而這個不是 Happier 新增的。可以交給 Happier 管理命令列，或者刪除 ${link} 後重新執行設定以保留你自己的。`,
        notNow: '暫不',
        manage: '交給 Happier 管理',
        keep: '保留我自己的',
        unanswered: '設定已在做出任何變更前停止。請選擇由誰管理命令列以繼續。',
        ownMissing: '你保留的命令列已不再安裝。請重新安裝，或交給 Happier 管理命令列。',
        managed: '由 Happier 管理',
        own: ({ path }: { path: string }) => `你自己的 — ${path}`,
        change: '變更命令列的管理方式',
        keptUpdateTitle: '更新你的命令列',
        keptUpdate: ({ command }: { command: string }) => `有更新的版本可用。請用 ${command} 更新`,
        oldCopyTitle: '舊的命令列',
        oldCopyRemove: ({ path, command }: { path: string; command: string }) => `仍安裝在 ${path}。執行 ${command} 即可移除`,
        oldCopyPath: ({ path }: { path: string }) => `仍安裝在 ${path}。`,
    },
    servers: {
        title: '這台電腦服務的 Home',
        connected: '已連線',
        offline: '已設定 · 離線',
        attention: '需要處理',
        currentHome: ({ home }: HomeParams) => `${home} · 目前的 Home`,
    },
    removal: {
        uninstallFailedTitle: '無法中斷這台電腦的連線',
        uninstallFailedBody: ({ home }: HomeParams) => `無法移除這台電腦用於 ${home} 的背景服務，因此保留了 ${home}。請再試一次，或在「設定 › 這台電腦」中移除該服務。`,
        inventoryUnavailableTitle: '無法檢查這台電腦',
        inventoryUnavailableBody: ({ home }: HomeParams) => `Happier 無法讀取這台電腦的背景服務，因此無法判斷這台電腦是否仍為 ${home} 提供服務。仍要從 Happier 中移除嗎？`,
        removeAnyway: '仍要移除',
        userOwnedTitle: '這台電腦會繼續為其提供服務',
        userOwnedBody: ({ home, service }: RemovalServiceParams) => `${service} 是在 Happier 之外安裝的，因此會繼續為 ${home} 執行。如果不再需要，請在終端機中移除。`,
    },
};

const thisComputerConnectionTranslations = { zhHant };

return { thisComputerConnectionTranslations };
})();

const Domain_transcriptFindTranslations = (() => {
const transcriptFindTranslations = { 'zh-Hant': { searchOlder: '搜尋較早的訊息', partialErrors: '部分內容無法搜尋。結果不完整。', olderRemaining: '還有較早的訊息尚未搜尋。', findOpen: '開啟尋找', findNext: '下一個相符項目', findPrevious: '上一個相符項目' } } as const;

return { transcriptFindTranslations };
})();

const Domain_turnChangesTranslations = (() => {
type TurnChangesTranslations = Shared_turnChangesTranslations.TurnChangesTranslations;

const en = Shared_turnChangesTranslations.en;

const translated = Shared_turnChangesTranslations.translated;

const turnChangesTranslations = { 'zh-Hant': {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `編輯了 ${count} 個檔案`,
                walkThrough: '帶我看一遍',
                openInFiles: '在檔案中開啟',
                fileCount: ({ count }) => `${count} 個檔案`,
                fileCountInFolders: ({ count, folders }) => `${folders} 個資料夾中的 ${count} 個檔案`,
                showMore: ({ count }) => `再顯示 ${count} 個`,
                groupA11y: '本輪的變更',
            }),
        },
    } } as const;

return { turnChangesTranslations };
})();

const Domain_voiceDiagnosticsConsentTranslations = (() => {
type VoiceDiagnosticsConsentCopy = Shared_voiceDiagnosticsConsentTranslations.VoiceDiagnosticsConsentCopy;

const defineVoiceDiagnosticsConsentTranslation = Shared_voiceDiagnosticsConsentTranslations.defineVoiceDiagnosticsConsentTranslation;

const voiceDiagnosticsConsentTranslations = { 'zh-Hant': defineVoiceDiagnosticsConsentTranslation({
    consentTitle: '在此裝置上錄製語音？',
    consentBody: '語音音訊可能包含私人對話和背景聲音。檔案只保留在此裝置，使用私密權限並自動到期，絕不會同步，也不會附加到分析資料或當機報告。',
    consentAction: '啟用錄製',
  }) } as const;

return { voiceDiagnosticsConsentTranslations };
})();

const Domain_voiceDiagnosticsTranslations = (() => {

type VoiceDiagnosticsCopy = Shared_voiceDiagnosticsTranslations.VoiceDiagnosticsCopy;

const voiceDiagnosticsConsentTranslations = {...Domain_voiceDiagnosticsConsentTranslations.voiceDiagnosticsConsentTranslations};

const defineVoiceDiagnostics = Shared_voiceDiagnosticsTranslations.defineVoiceDiagnostics;

const voiceDiagnosticsTranslations = { 'zh-Hant': defineVoiceDiagnostics(voiceDiagnosticsConsentTranslations["zh-Hant"].diagnostics, {
    title: '本機語音診斷',
    footer: '預設關閉。音訊會保留在所選機器上，直到你明確匯出為止。',
    enabled: '錄製本機診斷音訊',
    enabledSubtitle: '在本機保留有限的 STT 輸入與 TTS 輸出，用於排查問題',
    sttInput: '錄製語音辨識輸入',
    ttsOutput: '錄製合成語音輸出',
    location: '儲存位置',
    unavailable: '所選機器無法使用',
    retention: '保留上限',
    retentionDetail: ({ hours, files, megabytes }) => `${hours} 小時 · ${files} 個檔案 · ${megabytes} MB`,
    deleteAll: '刪除所有診斷音訊',
    deleteAllSubtitle: '立即從所選機器移除音訊與中繼資料',
    deleteConfirmTitle: '要刪除所有本機語音診斷嗎？',
    deleteConfirmBody: '這會永久移除所選機器上的所有語音診斷檔案。',
    deleteAction: '全部刪除',
    deleteFailed: '無法刪除本機診斷錄音。它們可能仍留在所選機器上。',
    cleanupRequired: '本機診斷清理需要處理',
    cleanupRequiredSubtitle: '可能還有私密診斷檔案殘留，或者無法讀取本機目錄。請重試清理，或刪除所有診斷音訊。',
    captureFailed: '診斷錄製需要處理',
    captureFailedSubtitle: '無法讀取或儲存上一次診斷音訊錄製。未偵測到殘留的診斷檔案；下一次符合條件的語音錄製會再次檢查狀態。',
    retryCleanup: '重試診斷清理',
    retryCleanupSubtitle: '重新檢查私密儲存並再次套用其保留上限',
    cleanupRetryFailed: '清理未能完成。診斷檔案可能仍留在所選機器上；等它重新連線後請重試或全部刪除。',
    exportTitle: '匯出所選診斷',
    noArtifacts: '所選機器上沒有保留的診斷錄音。',
    exportSttArtifact: '匯出語音辨識輸入',
    exportTtsArtifact: '匯出合成語音輸出',
    exportArtifactAccessibility: '匯出這段本機語音診斷錄音',
    exportConfirmTitle: '要匯出這段私密錄音嗎？',
    exportConfirmBody: '這會透過一次性加密傳輸，將所選錄音從所選機器複製到本裝置。它絕不會被自動上傳。',
    exportAction: '匯出錄音',
    exportFailed: '無法匯出這段私密錄音。沒有上傳任何內容。',
    backupPolicy: '備份排除',
    backupPolicyBestEffort: '存放在所選機器的私有快取中，並已為遵循快取目錄標準的備份工具做好標記。系統未實作任何自動上傳或同步；無法保證作業系統會將其排除在備份之外。',
    activeIndicator: '語音診斷已開啟',
    checkingIndicator: '正在檢查語音診斷狀態',
    statusUnknownIndicator: '語音診斷狀態不明',
    shutdownPendingIndicator: '正在停止語音診斷',
    shutdownFailedIndicator: '無法確認語音診斷已關閉',
    retryShutdown: '重試停止診斷',
    sessionOptOut: '不要錄製此工作階段',
    sessionOptOutConfirmTitle: '要停止錄製此工作階段嗎？',
    sessionOptOutConfirmBody: '語音診斷對其他工作階段仍保持啟用，但在應用程式重新啟動前，不會再錄製此工作階段的新音訊。',
    sessionOptOutFailed: '無法在使用中的機器上停止錄製。此工作階段可能仍在錄製中；等機器重新連線後請重試。',
    sessionOptOutRetry: '重試停止錄製',
  }) } as const;

return { voiceDiagnosticsTranslations };
})();

const Domain_voiceExternalCredentialApprovalTranslations = (() => {
type VoiceExternalCredentialApprovalCopy = Shared_voiceExternalCredentialApprovalTranslations.VoiceExternalCredentialApprovalCopy;

const defineVoiceExternalCredentialApproval = Shared_voiceExternalCredentialApprovalTranslations.defineVoiceExternalCredentialApproval;

const voiceExternalCredentialApprovalTranslations = { 'zh-Hant': defineVoiceExternalCredentialApproval({
    reviewRequired: '檢查憑證存取權',
    recipientApprovalTitle: '允許此供應商使用你的憑證？',
    recipientApprovalBody: '請檢查並核准宣告的供應商端點與操作。如果該接收方約定變更，Happier 會保留你的選擇，但會阻擋憑證使用，直到你再次核准。',
    recipientApprovalPackage: ({ title, pluginId, sourceKind, sourceLocator }) =>
      `套件：${title}（${pluginId}）；來源：${sourceKind} ${sourceLocator}`,
    recipientApprovalPublisher: ({ trust, identity }) => `發布者：${identity}（${trust}）`,
    recipientApprovalPackageSignature: ({ status, keyId }) => `套件簽章：${keyId}（${status}）`,
    recipientApprovalContribution: ({ pluginId, localId }) => `貢獻：${pluginId}/${localId}`,
    recipientApprovalOperations: '已宣告的操作：',
    recipientApprovalOperation: ({ id, purpose, effect }) =>
      `操作 ${id}：用途 ${purpose}；影響 ${effect}`,
    recipientApprovalRequest: ({ method, origin, pathTemplate }) => `請求：${method} ${origin}${pathTemplate}`,
    recipientApprovalCredential: ({ headerName, format }) => `憑證標頭：${headerName}；格式：${format}`,
    recipientApprovalBounds: ({ requestMaxBytes, responseMaxBytes }) =>
      `位元組上限：請求 ${requestMaxBytes}；回應 ${responseMaxBytes}`,
    recipientApprovalTrust: { bundled: '內建', verified: '已驗證' },
    recipientApprovalEffect: { read: '讀取', mutation: '變更' },
    recipientApprovalCredentialFormat: { raw: '原始', bearer: 'bearer' },
    recipientApprovalConfirm: '核准並儲存',
  }) } as const;

return { voiceExternalCredentialApprovalTranslations };
})();

const Domain_voiceLocalCredentialTranslations = (() => {
type VoiceLocalCredentialCopy = Shared_voiceLocalCredentialTranslations.VoiceLocalCredentialCopy;

const defineVoiceLocalCredential = Shared_voiceLocalCredentialTranslations.defineVoiceLocalCredential;

const voiceLocalCredentialTranslations = { 'zh-Hant': defineVoiceLocalCredential({
    voiceCredential: {
      setOnAccount: '已儲存到你的帳戶',
      notSetOnAccount: '未儲存到你的帳戶',
      setOnMachineOverride: ({ machine }) => `正在為 ${machine} 使用帳戶憑證覆寫`,
      notSetWithFallback: ({ machine }) => `未為 ${machine} 設定；可用時將使用帳戶憑證`,
      plainStorageTitle: '在沒有端對端加密的情況下儲存 API 金鑰？',
      plainStorageBody: '此帳戶儲存設定時不使用端對端加密。儲存此 API 金鑰會讓其明文對伺服器可見。',
      plainStorageConfirm: '儲存 API 金鑰',
      deleteAccountBody: '要移除這個已儲存的 API 金鑰嗎？參照同一個已儲存密鑰的其他繫結仍會保留它。',
      machineUnavailable: '請選擇一台在線的語音執行機器',
      machineUnavailableTitle: '語音機器無法使用',
      machineUnavailableBody: '在儲存或使用此憑證之前，請選擇一台在線的語音執行機器。',
      statusUnavailable: ({ machine }) => `無法取得 ${machine} 上的憑證狀態。點一下可重試。`,
      importAvailable: ({ machine }) => `有舊金鑰可匯入到 ${machine}`,
      notSetOnMachine: ({ machine }) => `未在 ${machine} 上設定`,
      setOnMachine: ({ machine, protection }) => `已在 ${machine} 上設定 · ${protection}`,
      protection: { osProtected: '受作業系統保護', filePermissions: '受檔案權限保護' },
      importTitle: '要匯入現有的 API 金鑰嗎？',
      importBody: ({ machine }) => `將現有的加密帳戶設定複製到 ${machine}。原件仍可供你的其他裝置使用。`,
      importAction: '匯入',
      enterNewAction: '輸入新金鑰',
      useSavedSecretTitle: '使用已儲存的密鑰',
      useSavedSecretSubtitle: '選擇此帳戶中已儲存的密鑰。',
      replaceOrRemoveBody: '輸入替換用的 API 金鑰，或留空以從這台機器移除該金鑰。',
      deleteTitle: '要移除 API 金鑰嗎？',
      deleteBody: ({ machine }) => `要從 ${machine} 移除此 API 金鑰嗎？舊的跨裝置值（如有）不會被變更。`,
      operationFailed: '所選機器無法更新此憑證。請確認它處於在線狀態後重試。',
      newCredentialRequired: ({ machine }) => `${machine} 上需要新的機器憑證`,
    },
    openAiCompatEndpoint: {
      executionMachine: ({ machine }) => `請求在 ${machine} 上執行。Localhost 指的是那台機器。`,
      insecureTitle: '允許不安全的本機 HTTP？',
      insecureBody: ({ origin, machine }) => `允許從 ${machine} 透過 HTTP 向 ${origin} 傳送憑證嗎？Localhost 指的是 ${machine}。僅接受回送位址與私有網路位址；公用 HTTP 會被拒絕。`,
      allowAction: '允許 HTTP',
      invalidBody: '請輸入 HTTPS URL，或不含使用者名稱、密碼與查詢字串的 HTTP 回送／私有網路 URL。',
    },
  }) } as const;

return { voiceLocalCredentialTranslations };
})();

const Domain_voiceMomentsTranslations = (() => {
type VoiceMomentsTranslation = Shared_voiceMomentsTranslations.VoiceMomentsTranslation;

const voiceMomentsTranslations = { 'zh-Hant': {
        setupTitle: '設定語音',
        setupTileSubtitle: '大聲和你的工作階段交談。四個簡短步驟。',
        setupTileProgress: ({ done, total, next }) => `已完成 ${done}/${total} · ${next}`,
        setupNextService: '下一步：選擇誰來聆聽',
        setupNextReadiness: '下一步：完成服務設定',
        setupNextMicrophone: '下一步：允許麥克風',
        setupNextTry: '下一步：試一試',
        setupNextInstalling: '正在安裝',
        setupStart: '設定',
        setupContinue: '繼續',
        setupDescription: '大聲和你的工作階段交談：詢問進度、開始工作、隨時隨地做決定。四個步驟，可以中途離開再回來。',
        setupLightCaption: ({ done, total }) => `已就緒 ${done}/${total}`,
        setupServiceTitle: '選擇誰來聆聽',
        setupServiceDetail: '聆聽並回應你的服務。之後可以更改。',
        setupChange: '更改',
        setupReadinessTitle: ({ service }) => `完成 ${service} 的設定`,
        setupReadinessDone: ({ service }) => `${service} 已就緒`,
        setupReadinessGeneric: '服務',
        setupReadinessTitleGeneric: '準備好服務',
        setupReadinessUnknown: '開啟設定，查看還缺少什麼。',
        setupReadinessCheck: '檢查設定',
        setupMicrophoneTitle: '允許麥克風',
        setupMicrophoneDetail: '裝置只會詢問一次。Happier 僅在語音開啟時聆聽，你隨時都能看到。',
        setupMicrophoneAction: '允許麥克風',
        setupMicrophoneDone: '已允許麥克風',
        setupMicrophoneDeniedTitle: 'Happier 的麥克風已關閉',
        setupMicrophoneDeniedDetail: '在系統設定中開啟後回到這裡。',
        setupOpenSystemSettings: '開啟設定',
        setupTryTitle: '試一試',
        setupTryDetail: '問一句「我的工作階段在做什麼？」你的話會像一般訊息一樣出現在對話裡。',
        setupTryAction: '試一試',
        setupTryDone: '已試過',
        setupTryNeedsService: '服務就緒後即可使用。',
        setupDoneTitle: '語音已就緒',
        setupDoneBody: '在任何聊天中輕點語音按鈕開始說話，再點一次結束。說話時，靜音就在結束旁邊。',
        setupGestureTap: '輕點',
        setupGestureStartEnd: '開始 · 結束',
        setupGestureAnywhere: '隨處開始 · 結束',
        setupDoneAction: '完成',
        setupSettingsAction: '語音設定',
        setupClose: '關閉',
        needsYouEnded: '語音已結束。收件匣中仍有待核准的請求。',
        needsYouReview: '檢視請求',
        needsYouTapToDecide: '已朗讀 · 請在此處決定，而不是用語音',
        briefMe: '給我簡報',
        briefMeA11y: '給我簡報：語音會讀出需要你處理、失敗和已就緒的內容',
        briefNeedsYou: '需要你',
        briefFailed: '失敗',
        briefReady: '已就緒',
        briefIncomplete: '部分工作尚未載入，這裡可能不完整。',
        briefCaughtUp: '目前沒有需要你處理的事。',
        briefNotSpoken: '語音暫時無法朗讀。完整清單都在這裡。',
        briefStop: '停止',
        continueTitle: '在這裡繼續交談',
        continueDetail: ({ device }) => `你之前在 ${device} 上交談`,
        continueAction: '繼續',
        continuedOn: ({ device }) => `已在 ${device} 上繼續`,
        continuedElsewhere: '已在另一台裝置上繼續',
        continuedHere: '已在此裝置上繼續',
        dismiss: '忽略',
    } } satisfies Pick<Readonly<Record<string, VoiceMomentsTranslation>>, "zh-Hant">;

return { voiceMomentsTranslations };
})();

const Domain_voicePresenceTranslations = (() => {
type VoicePresenceTranslation = Shared_voicePresenceTranslations.VoicePresenceTranslation;

const voicePresenceTranslations = { 'zh-Hant': {
        welcomeText: "你好，我在聽。你想做什麼？",
        customVoice: '自訂聲音',
        boundWelcomeText: ({ name }: Readonly<{ name: string }>) => `你好，你正在與${name}交談。你想做什麼？`,
        greetingLiteralUnavailable: "使用此回覆語言時，服務會等待你先開口。",
        title: '語音',
        howYouTalk: "說話方式",
        holdToTalkTitle: "按住說話",
        holdToTalkDescription: "按住 Voice 標記說一句話，放開傳送。點按仍可開始和結束 Voice。",
        holdToTalkHint: "按住說一輪，放開傳送。拖曳可取消。",
        holdToTalkUnavailable: ({ service }) => `${service} 不支援按住說話。請改用點按說話。`,
        talkWithVoice: '用語音交談',
        dictate: '聽寫',
        globalVoice: '全域語音',
        interrupt: '打斷',
        options: '語音選項',
        you: '你',
        showConversation: '顯示對話',
        dragToMove: '拖曳以移動',
        openConversation: '開啟對話',
        settings: '語音設定',
        ended: '語音已結束',
        muted: '已靜音',
        setUp: '設定語音',
        setUpHint: '開啟語音設定，選擇語音的說話方式',
        startAgain: '重新開始',
        endedCaption: ({ elapsed }) => `${elapsed} · 對話已儲存`,
        dismiss: '關閉',
        mute: "靜音",
        unmute: "取消靜音",
        end: "結束",
        captions: { connecting: "正在開啟音訊通道", listening: "請說", transcribing: "正在轉成文字", thinking: "正在思考回答", speaking: "你可以隨時打斷", interrupted: "請說", muted: "取消靜音即可說話 · 語音仍可說話", reconnecting: "連線中斷 · 正在重試", blocked: "允許存取麥克風即可說話", failed: "請重試，或檢查語音設定" },
        recovery: { allow: "允許", setUp: "設定" },
        containerA11y: ({ status }) => `語音，${status}`,
    } } satisfies Pick<Readonly<Record<string, VoicePresenceTranslation>>, "zh-Hant">;

return { voicePresenceTranslations };
})();

const Domain_voiceProviderPrivacyTranslations = (() => {
const voiceProviderPrivacyTranslations = { 'zh-Hant': {
    openai: {
      privacyDisclosure: '音訊與對話內容會透過 WebRTC 從此裝置傳送至 OpenAI。啟用或使用相關功能時，OpenAI 也可能從此裝置接收有限的 Voice 脈絡更新、用戶端工具呼叫及其結果。Happier 使用所選的已儲存 Voice API 金鑰、OpenAI 已連線服務或實驗性 Codex OAuth 帳戶取得短期用戶端驗證；已連線帳戶會透過所選機器使用。OpenAI 會在所選帳戶下處理即時對話，並可能依該帳戶設定與 OpenAI 條款保留收到的資料。Happier 的伺服器與中繼不承載即時音訊。Voice 脈絡分享控制與此提供者處理彼此獨立。',
    },
    xai: {
      privacyDisclosure: '音訊與對話內容會透過 xAI Realtime 連線從此裝置傳送至 xAI。啟用或使用相關功能時，xAI 也可能從此裝置接收有限的 Voice 脈絡更新、用戶端工具呼叫及其結果。Happier 僅將儲存在 Happier 帳戶祕密中的 xAI API 金鑰用於有限的用戶端驗證與語音目錄操作。xAI 會在該帳戶下處理即時對話，並可能依帳戶設定與 xAI 條款保留收到的資料。啟用續接後，Happier 會儲存提供者對話識別碼；忘記操作只會移除 Happier 儲存的識別碼，不會刪除 xAI 持有的資料。Happier 的伺服器與中繼不承載即時音訊。Voice 脈絡分享控制與此提供者處理彼此獨立。',
    },
    speechProcessing: {
      deviceStt: '音訊由瀏覽器或作業系統的語音辨識服務處理。視平台與已設定的服務而定，處理可能在裝置外進行。',
      deviceTts: '回覆文字由瀏覽器或作業系統的語音合成服務處理。視平台與已設定的服務而定，處理可能在裝置外進行。',
    },
    fields: {
      resumption: {
        title: '儲存 xAI 續接識別碼',
        subtitle: '允許 Happier 儲存 xAI 的短期提供者對話識別碼，以便重新連線。',
      },
    },
    resumption: {
      confirmTitle: '儲存 xAI 續接識別碼？',
      confirmBody: 'Happier 會將 xAI 的提供者對話識別碼儲存最多 {minutes} 分鐘，以便重新連線中斷的對話。這不會變更或刪除 xAI 持有的資料。',
      confirmAction: '儲存識別碼',
      forgetTitle: '忘記 Happier 續接識別碼',
      forgetSubtitle: '移除 Happier 儲存的提供者對話識別碼。這不會刪除對話或 xAI 持有的資料。',
      forgotten: 'Happier 已移除儲存的提供者對話識別碼。',
      unsupported: 'Happier 無法從此工作階段移除儲存的提供者對話識別碼。',
      failed: 'Happier 無法移除儲存的提供者對話識別碼。請再試一次。',
    },
  } } as const;

return { voiceProviderPrivacyTranslations };
})();

const Domain_voiceReadinessTranslations = (() => {
type VoiceReadinessCopy = Shared_voiceReadinessTranslations.VoiceReadinessCopy;

const defineVoiceReadinessTranslation = Shared_voiceReadinessTranslations.defineVoiceReadinessTranslation;

const voiceReadinessTranslations = { 'zh-Hant': defineVoiceReadinessTranslation({
    ready: '語音功能已就緒。',
    permissionAnnouncement: ({ summary }) => `編碼工作階段需要以下權限：${summary}。請在工作階段介面中審核並核准或拒絕。`,
    userActionAnnouncement: ({ question }) => `編碼工作階段需要你的回答。${question}`,
    userActionFallback: '編碼工作階段需要你的回答。請回答問題，以便我繼續。',
    requestedTool: '要求的工具',
    provider_unselected: '請選擇語音提供者。',
    contribution_unavailable: '此語音提供者已無法使用。',
    role_unsupported: '此提供者不支援所選語音模式。',
    platform_unsupported: '此平台無法使用該語音提供者。',
    settings_unsupported_version: '請先更新此提供者，再將其用於語音功能。',
    settings_unknown: '無法檢查提供者設定。',
    settings_needs_migration: '請檢查此提供者更新後的設定。',
    settings_invalid: '請檢查無效的提供者設定。',
    settings_missing_required_setting: ({ service }) => `完成 ${service} 的設定即可開始。`,
    provider_mode_unknown: '請為此提供者選擇支援的模式。',
    server_feature_disabled: '伺服器已停用此語音提供者。',
    server_feature_installing: '伺服器正在準備語音支援。',
    server_feature_incompatible: '伺服器與此語音提供者不相容。',
    server_feature_unknown: '無法檢查伺服器是否支援此語音提供者。',
    execution_machine_missing: '請選擇一台可以執行此語音提供者的機器。',
    execution_machine_installing: '所選語音執行機器仍在準備中。',
    execution_machine_incompatible: '所選機器與此語音提供者不相容。',
    execution_machine_unknown: '無法檢查語音執行機器。',
    daemon_unreachable: '所選機器沒有可用的語音音訊路由。',
    daemon_relay_disabled: '所選機器需要語音音訊中繼，但中繼已停用。',
    daemon_relay_capped: '所選機器目前無法使用語音音訊中繼容量。',
    credential_missing: '請新增此語音提供者所需的憑證。',
    credential_approval_required: '請先檢查憑證存取權，再使用此語音提供者。',
    credential_installing: '提供者憑證仍在準備中。',
    credential_incompatible: '所選憑證與此語音提供者不相容。',
    credential_unknown: '無法檢查提供者憑證。',
    endpoint_missing: '請設定此語音提供者所需的端點。',
    endpoint_installing: '語音提供者端點仍在準備中。',
    endpoint_incompatible: '設定的端點與此語音提供者不相容。',
    endpoint_unknown: '無法檢查語音提供者端點。',
    runtime_missing: '請安裝此語音提供者所需的執行階段。',
    runtime_installing: '語音提供者執行階段仍在安裝中。',
    runtime_incompatible: '已安裝的執行階段與此語音提供者不相容。',
    runtime_unknown: '無法檢查語音提供者執行階段。',
    model_missing: '請為此語音提供者安裝或選擇模型。',
    model_installing: '所選語音模型仍在安裝中。',
    model_incompatible: '所選模型與此語音提供者不相容。',
    model_unknown: '無法檢查語音提供者模型。',
    device_stt_unavailable: '此裝置無法使用語音辨識。',
    device_stt_availability_unknown: '仍在檢查語音辨識是否可用。',
    short: {
      needsSetup: '需要設定',
      needsKey: '需要金鑰',
      needsApproval: '需要你的核准',
      offOnServer: '此伺服器已關閉',
      needsComputer: '需要電腦',
      needsAddress: '需要位址',
      needsModel: '需要模型',
      installing: '正在安裝',
      notInstalled: '未安裝',
      unavailableHere: '此處無法使用',
      needsUpdate: '需要更新',
      cantCheck: '尚未檢查',
    },
    actions: {
      select_provider: '選擇提供者',
      open_provider_settings: "完成設定",
      select_execution_machine: '選擇機器',
      configure_credential: '新增憑證',
      review_credential_access: '檢查憑證存取權',
      configure_endpoint: '設定端點',
      install_model: '安裝模型',
      switch_provider: '選擇其他提供者',
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

const voiceRealtimeProviderSetupTranslations = { 'zh-Hant': defineVoiceRealtimeProviderSetup(voiceProviderPrivacyTranslations["zh-Hant"], {
    xai: {
      setup: { footer: '你的 xAI API 金鑰以同步的已儲存密鑰形式存放在 Happier 帳戶密鑰中，只在受限的 xAI Realtime 操作中才會被取出使用。' },
      credential: { promptBody: '貼上 xAI API 金鑰。Happier 會把它作為同步的已儲存密鑰加以保護，只在受限的 xAI Realtime 操作中才會取出使用。' },
    },
    setup: {
      title: '即時語音設定',
      footer: '你的 API 金鑰儲存在所選執行機器上，絕不會寫入同步的語音設定。',
    },
    credential: {
      title: '已儲存的 API 金鑰',
      promptTitle: '連接即時語音',
      promptBody: '貼上 OpenAI Platform API 金鑰。它會受同步帳戶密鑰保護，只在簽發短期 Realtime 用戶端憑證時才會取出使用。',
    },
    authentication: {
      sectionTitle: 'OpenAI Realtime 驗證',
      title: '驗證來源',
      subtitle: '請只選擇一個來源。Happier 絕不會退回到其他金鑰或帳戶。',
      footer: 'OpenAI Realtime API 的用量由 OpenAI Platform 計費。ChatGPT 或 Codex 訂閱並不代表擁有 Realtime API 的計費或存取權。傳遞給 WebRTC 對話的只有短期用戶端憑證。',
      savedSecret: {
        title: '已儲存的語音 API 金鑰',
        subtitle: '使用儲存在 Happier Voice 帳戶密鑰中的 API 金鑰。不需要守護程序。',
      },
      openAiApiKey: {
        title: 'OpenAI 已連接服務',
        subtitle: '透過所選機器及其已連接的守護程序，使用選定的標準 OpenAI API 金鑰設定檔或帳戶群組。',
      },
      openAiCodex: {
        title: 'OpenAI Codex OAuth（實驗性）',
        subtitle: '透過所選機器及其已連接的守護程序，使用選定的 Codex OAuth 設定檔或帳戶群組。Happier 絕不會退回到其他金鑰或帳戶。',
      },
      account: {
        title: '已連接帳戶',
        subtitle: '選擇下一次對話所使用的確切設定檔或帳戶群組。',
      },
      chooseAccount: '選擇帳戶',
      referenceRequired: '請選擇一個已連接的設定檔或帳戶群組。',
      connected: '已連接帳戶就緒',
      unavailable: '所選帳戶無法使用或需要重新連接',
    },
    invalidValue: '此供應商不支援該值。',
    advanced: { show: '顯示進階設定', hide: '隱藏進階設定' },
    fields: {
      model: { title: '模型', subtitle: '選擇即時語音模型。' },
      voice: { title: '語音', subtitle: '選擇用於回覆的語音。' },
      instructions: {
        title: '語音指示',
        subtitle: '選填的行為與個性指示。',
        promptTitle: '語音指示',
        promptBody: '為這次語音工作階段輸入選填指示。',
      },
      turnDetection: {
        title: '輪次偵測',
        subtitle: '選擇供應商如何判斷你說完了。',
        threshold: {
          title: 'VAD 門檻',
          subtitle: '語音活動靈敏度；留空則使用供應商預設值。',
          promptTitle: 'VAD 門檻',
          promptBody: '請輸入 0.1 到 0.9 之間的值，或留空。',
        },
        silenceDurationMs: {
          title: '靜音長度',
          subtitle: '結束一輪發言前需要的靜音毫秒數。',
          promptTitle: '靜音長度',
          promptBody: '請輸入 0–10000 毫秒，或留空。',
        },
        prefixPaddingMs: {
          title: '語音前置留白',
          subtitle: '在偵測到語音之前保留的毫秒數。',
          promptTitle: '語音前置留白',
          promptBody: '請輸入 0–10000 毫秒，或留空。',
        },
        idleTimeoutMs: {
          title: '閒置回覆逾時',
          subtitle: '選填：靜音達到此長度後，請 xAI 主動開始回覆。',
          promptTitle: '閒置回覆逾時',
          promptBody: '請輸入 1–600000 毫秒，或留空以關閉自動閒置回覆。',
          confirmTitle: '要啟用自動閒置回覆嗎？',
          confirmBody: '在設定的靜音之後，xAI 可能會主動產生回覆並消耗 API 用量。',
          confirmAction: '啟用',
        },
      },
      transcriptionModel: {
        title: '轉錄模型',
        subtitle: '選填的輸入轉錄模型。',
        promptTitle: '轉錄模型',
        promptBody: '請輸入模型 id，或留空以使用供應商預設值。',
      },
      reasoning: { title: '推理', subtitle: '為支援的模型選擇推理強度。' },
      outputSpeed: {
        title: '語速',
        subtitle: '調整供應商的說話速度。',
        promptTitle: '語速',
        promptBody: '請輸入 0.7 到 1.5 之間的值。',
      },
      languageHint: {
        title: '語言提示',
        subtitle: '選填：協助轉錄辨識你使用的語言。',
        promptTitle: '語言提示',
        promptBody: '請選擇一種支援的語言。',
      },
      keyterms: {
        title: '關鍵術語',
        subtitle: '希望轉錄能夠辨識的人名與領域術語。',
        promptTitle: '關鍵術語',
        promptBody: '最多輸入 100 個術語，以逗號或換行分隔。',
      },
    },
    options: {
      pinned: '固定版本',
      movingAlias: '自動跟隨供應商更新',
      automatic: '自動',
      custom: '自訂…',
      server_vad: '伺服器端語音活動偵測',
      semantic_vad: '語意輪次偵測',
      manual: '手動',
      high: '高',
      none: '無',
    },
    catalog: {
      credentialRequired: '新增 API 金鑰以載入語音',
      retry: '無法載入語音 — 重試',
      empty: '此帳戶沒有可用的語音',
      preview: ({ voice }) => `試聽 ${voice}`,
    },
    movingAlias: {
      confirmTitle: '要跟隨最新模型嗎？',
      confirmBody: '浮動模型別名會在供應商更新時改變行為。你隨時可以切回固定版本。',
      confirmAction: '使用最新版',
    },
    links: {
      title: '供應商資源',
      account: { title: '開啟供應商帳戶', subtitle: '管理你在供應商處的帳戶。' },
      apiKeys: { title: '開啟 API 金鑰', subtitle: '建立、輪替或撤銷供應商的 API 金鑰。' },
      privacy: { title: '供應商隱私權政策', subtitle: '了解供應商如何處理語音資料。' },
    },
    disconnect: {
      title: '中斷即時語音',
      subtitle: '從所選機器移除此供應商的 API 金鑰。',
      confirmTitle: '要中斷此供應商嗎？',
      confirmBody: '這會從所選執行機器移除已儲存的 API 金鑰。',
    },
    unavailable: {
      title: '即時語音無法使用',
      rowTitle: '無法載入設定',
      provider: '供應商的外掛程式無法使用或不相容。',
      invalid: '已儲存的供應商設定無效。',
      needs_migration: '這些設定需要先完成支援的移轉才能編輯。',
      unsupported_version: '這些設定由較新版本的 Happier 寫入。',
    },
  }) } as const;

return { voiceRealtimeProviderSetupTranslations };
})();

const Domain_voiceSettingsPagesTranslations = (() => {
type VoiceSettingsPagesCopy = Shared_voiceSettingsPagesTranslations.VoiceSettingsPagesCopy;

const en = Shared_voiceSettingsPagesTranslations.en;

const zhHant: VoiceSettingsPagesCopy = {
  pages: {
    search: {
      chooseService: '選擇一項服務以變更此設定。',
      select: ({ choice, control }) => `在「${control}」中選擇「${choice}」以變更此設定。`,
    },
    hub: {
      description: '大聲和你的代理交談，並在任何訊息中聽寫。',
      modesTitle: '兩種使用語音的方式',
      moreTitle: '更多',
      dictationPurpose: '輸入框中的麥克風會把你的話變成可編輯的文字',
      summarySessionSummaries: '工作階段摘要',
      summaryRecentMessages: ({ count }) => `最近 ${count} 則訊息`,
      summaryNothingShared: '對話開始時不分享任何內容',
      summaryRemembers: 'Voice 代理會記住過去的對話',
      summaryForgets: 'Voice 代理在每次對話後遺忘',
      summaryVoiceComputer: ({ machine }) => `Voice 電腦：${machine}`,
      summaryTranscript: '對話時顯示逐字稿',
    },
    pipeline: {
      hear: '聽',
      think: '想',
      speak: '說',
      write: '寫',
      ready: '已就緒',
      oneStepNeedsYou: '有一個步驟需要你處理',
      stepsNeedYou: ({ count }) => `有 ${count} 個步驟需要你處理`,
      waiting: '等待中',
      working: '進行中',
      notChecked: '尚未檢查',
      off: '已關閉 · 聽寫仍可使用',
      onMachine: ({ machine }) => `在 ${machine} 上`,
      onVoiceComputer: '在你的 Voice 電腦上',
      inTheCloud: '在服務的雲端，從此裝置發起',
      inTheSession: '工作階段自己的代理在逐字稿中回答',
      intoYourMessage: '傳送前由你檢查',
      messageLanguage: ({ language }) => `語言：${language}`,
      languageAutomatic: '自動',
      onThisDevice: '在此裝置上',
      needsYou: '需要你處理',
      voiceAgentFollowsSession: 'Voice 代理 · 跟隨工作階段',
      theSessionYoureIn: '你所在的工作階段',
      intoYourMessageTitle: '寫入你的訊息',
    },
    privacy: {
      localAudio: "你的裝置或 Voice 電腦",
      localProcessor: "你選擇的語音模型",
      localRetention: "由裝置或執行環境管理。診斷錄音遵循你的錄音設定。",
      localDisclosure: "所選語音模型在你的裝置或 Voice 電腦上執行。Voice 歷史和診斷錄音在本頁分別設定。",
      audioTitle: "音訊傳送至",
      processorTitle: "處理方",
      retentionTitle: "保留方式",
      messagesUnit: "則訊息",
      secondsUnit: "秒",
      servicePolicy: "遵循服務帳戶的設定和條款。",
      noMicrophoneAudio: "不傳送麥克風音訊；僅傳送回覆文字。",
      yourEndpoint: "你設定的端點",
      endpointOperator: "你的端點營運方",
      endpointPolicy: "遵循端點的資料保留政策。",
      deviceAudio: "裝置的語音服務",
      deviceProcessor: "裝置或其語音服務",
      devicePolicy: "遵循裝置的語音設定和條款。",
      description: '你的語音服務能聽到和讀取什麼，以及 Happier 保留什麼。',
      whereTitle: '你的聲音現在送往何處',
      whereDescription: '隨所選服務而變化。',
      startTitle: '對話開始時',
      startDescription: '語音服務能讀取你工作中的哪些內容。',
      screenTitle: '螢幕上的內容',
      screenDescription: '你正在查看的工作階段或頁面。',
      screenNever: '從不',
      screenWhenAsked: '被要求時',
      screenAlways: '一律',
      summariesTitle: '工作階段摘要',
      recentTitle: '你最近的訊息',
      recentDescription: '它要求脈絡時，工作階段中最近的訊息。',
      recentCountTitle: '分享的訊息數',
      recentCountDescription: "",
      recentCountUnavailable: '開啟「你最近的訊息」後即可變更。',
      toolsTitle: '工具名稱',
      toolsDescription: '例如「已編輯檔案」。參數和檔案路徑從不分享。',
      permissionsTitle: '權限要求',
      permissionsDescription: '讓它告訴你什麼需要你處理。核准仍需你點按。',
      devicesTitle: '你的機器和裝置',
      devicesDescription: '名稱和線上狀態，用於在你指定的位置啟動工作階段。',
      liveTitle: '你說話時',
      liveDescription: '對話期間工作階段變更時傳送的更新。',
      liveActiveTitle: '來自你所在的工作階段',
      liveOtherTitle: '來自你的其他工作階段',
      liveNothing: '不傳送',
      liveActivity: '活動',
      liveSummaries: '摘要',
      liveMessages: '訊息',
      livePerUpdateTitle: '每次更新的訊息數',
      liveIncludeMineTitle: '包含你寫的內容',
      liveIncludeMineDescription: '關閉：只傳送代理一方的內容。',
      liveMessagesUnavailable: '在上方為某個工作階段選擇「訊息」後即可變更。',
      liveOtherModeTitle: '其他工作階段的訊息',
      liveOtherModeNever: '從不',
      liveOtherModeWhenAsked: '被要求時',
      liveOtherModeAutomatically: '自動',
      liveOtherModeUnavailable: '為其他工作階段選擇「訊息」後即可變更。',
      memoryTitle: 'Voice 代理的記憶',
      memoryDescription: '僅適用於使用 Voice 代理的本機語音。',
      rememberTitle: '記住過去的對話',
      rememberOnDescription: '從你上次離開的地方繼續。',
      rememberOffDescription: '關閉：掛斷後全部遺忘。',
      restoreTitle: '還原記憶的方式',
      restoreRecent: '最近的訊息',
      restoreSummary: '摘要 + 最近',
      restoreResume: '恢復代理',
      restoreUnavailable: '開啟「記住」後即可選擇。',
      restoreResumeFeatureOff: '恢復需要此伺服器開啟 Voice 代理。',
      restoreResumeAgentCannot: '此代理無法恢復過去的對話。',
      fallbackTitle: '恢復失敗時重播訊息',
      fallbackDescription: '從你最近的訊息開始，而不是從零開始。',
      restoreCountTitle: '要還原的訊息數',
      restoreCountDescription: "",
      forgetTitle: '立即全部遺忘',
      forgetDescription: '重新開始 Voice 代理。你的工作階段不受影響。',
      forgetAction: '遺忘',
      moreTitle: '更多',
    },
    dictation: {
      description: '輸入框中的麥克風會把你的話變成傳送前可編輯的文字。',
      engineTitle: '語音引擎',
      engineDescription: '每個引擎都會說明你的音訊送往何處。',
      sameAsConversations: '與語音對話相同',
      sameAsConversationsUses: ({ engine }) => `使用 ${engine}，與你的語音對話相同。`,
      languageTitle: '語言',
      dictateInTitle: '我聽寫使用的語言',
      dictateInDescription: '自動會使用引擎的預設語言。它不跟隨你的對話語言。',
      pipelinePurpose: '即使關閉語音對話也能使用',
    },
    conversations: {
      description: '大聲和你的代理交談，手放在鍵盤上也可以。',
      serviceTitle: '服務',
      serviceDescription: '誰來聽、思考和說話。你可以隨時切換，每個服務都保留自己的設定。',
      offDescription: '不使用語音對話。聽寫仍可使用。',
      serviceReady: '已就緒',
      accountTitle: '帳戶',
      accountDescription: '兩種情況都是同一個服務，只是付費方不同。',
      payWithTitle: '付費方式',
      happierBillingUnavailable: "此伺服器不支援 Happier 計費。",
      turnOnVoiceAgent: "啟用語音代理",
      payWithHappierDescription: '由你的 Happier 方案支付，無需自己的帳戶。',
      payWithOwnDescription: '你使用自己在該服務的帳戶與 API 金鑰。',
      runsOn: '執行於',
      hearTitle: '聽',
      hearDescription: '在回答之前，你的話如何變成文字。',
      speechRecognitionTitle: '語音辨識',
      handsFreeUnsupported: '免持需要此裝置上的語音辨識或 Happier 語音模型。',
      handsFreeTimingUnavailable: '開啟免持後即可變更。',
      interruptTitle: '說話即可打斷',
      interruptDescription: '在回覆時說話會使其停止。',
      talkToTitle: '交談對象',
      talkToSession: '工作階段',
      talkToSessionDescription: '你直接對所在的工作階段說話，由它自己的代理回答。',
      talkToAgent: 'Voice 代理',
      talkToAgentDescription: 'Voice 代理會讀取你的工作階段並替你操作。',
      agentFeatureRequired: ({ feature }) => `在設定 → 功能中啟用${feature}。實驗性功能還需要開啟實驗。`,
      itMayTitle: '它可以',
      itMayReadOnly: '唯讀',
      itMayReadOnlyDescription: '它讀取你的工作階段和檔案，不做任何變更。',
      itMayAsk: '先詢問',
      itMayAskDescription: '每次變更都會先詢問你。口頭說「是」從不算核准，需要你點按。',
      itMaySafe: '安全變更',
      itMaySafeDescription: '它會自行進行安全的工作區變更，其餘會先詢問。',
      itMayAnything: '任何操作',
      itMayAnythingDescription: '它可以不經詢問進行任何變更。',
      repliesTitle: '回覆',
      repliesShort: '簡短',
      repliesBalanced: '均衡',
      thinkTitle: '想',
      thinkDescription: '你說的話會被如何處理。',
      advancedAgentTitle: '進階代理行為',
      advancedAgentDescription: 'Voice 代理如何啟動、等待和回答。預設設定適合大多數人。',
      memoryLinkTitle: '記憶與還原',
      memoryLinkDescription: '是否記住過去的對話在「隱私與資料」中設定。',
      speakTitle: '說',
      speakDescription: '回覆如何被朗讀。',
      voiceEngineTitle: '語音合成引擎',
      languageTitle: '語言',
      languageDescription: '每種語言對所選服務的影響。',
      iSpeakTitle: '我說的語言',
      iSpeakDescription: '幫助它聽懂你。自動會每次偵測。',
      replyInTitle: '回覆語言',
      replyInDescription: '即使你切換語言，回答也使用這種語言。',
      replySame: '與我說的相同',
      iSpeakAutomatic: '自動',
      iSpeakEngineDescription: ({ engine }) => `幫助 ${engine} 聽懂你。在「聽」中的語音辨識裡設定。`,
      voiceTitle: '聲音',
      voiceDescription: ({ engine }) => `來自 ${engine}，「說」中的引擎。`,
      voiceDefault: '預設',
      voiceDevice: '此裝置的聲音',
      voiceInEngine: '在「說」中設定',
      languageServiceDescription: '你的語音服務回答所用的語言。',
      languageAutomaticDescription: '語音服務會偵測你所說的語言。',
      languageEngineDefault: '引擎預設值',
      languageCoupledDescription: '語音服務使用同一種語言進行辨識和回覆。',
      greetingTitle: '問候',
      greetingOff: '關閉',
      greetingRightAway: '立即',
      greetingAfterISpeak: '在我說話後',
      greetingOffDescription: '等你先開口。',
      greetingRightAwayDescription: '對話一開始就打招呼。',
      greetingAfterISpeakDescription: '在第一次回覆中打招呼。',
      languageManagedDescription: '語言由你的語音服務決定。',
      languageServiceDefault: '服務預設值',
    },
    advanced: {
      description: '語音在哪裡執行、如何在螢幕上顯示，以及使用哪些語音模型。',
      onScreenTitle: '螢幕顯示',
      onScreenDescription: '進行中的對話如何顯示。',
      showLiveAsTitle: '即時 Voice 顯示為',
      showLiveAsDescription: '僅此裝置。Companion 中的 Voice 區段在所有模式下都保留。',
      scopeTitle: '對話開始於',
      scopeGlobal: '我的所有工作階段',
      scopeGlobalDescription: '一個助理處理所有事情。',
      scopeSession: '開啟的工作階段',
      scopeSessionDescription: '在你開啟的工作階段中開始。',
      transcriptTitle: '對話時顯示逐字稿',
      transcriptDescription: '你和代理說的話會隨對話出現。',
      autoOpenTitle: '對話開始時開啟',
      autoOpenDescription: '關閉：自己從對話中開啟。',
      autoOpenUnavailable: '開啟「顯示逐字稿」後即可選擇。',
      computerTitle: 'Voice 電腦',
      speechModelsTitle: '語音模型',
      speechModelsNeedComputerTitle: '需要 Voice 電腦',
      speechModelsNeedComputer: '請先在上方選擇一台 Voice 電腦，以安裝和管理它的語音模型。',
      computerDescription: '執行語音模型並為語音登入已連結帳戶的電腦。在你的所有裝置間共用。',
      connectionTitle: '連線',
      timeoutTitle: '語音要求逾時放棄',
      timeoutDescription: "用於端點和語音模型。",
    },
  },
};

const voiceSettingsPagesTranslations = { 'zh-Hant': zhHant } as const satisfies Pick<Record<string, VoiceSettingsPagesCopy>, "zh-Hant">;

return { voiceSettingsPagesTranslations };
})();

const Domain_walkthroughProgressTranslations = (() => {
type Parts = Shared_walkthroughProgressTranslations.Parts;

const walkthroughProgressTranslations = { 'zh-Hant': { parts: ({ completed, total, admitted }: Parts) => `${completed}/${total} 部分已完成 · ${admitted} 已接收`, merge: '正在整合導覽…', titleEdited: '標題已編輯', changed: '已變更', moved: '已移動', filesReadUnavailable: '檔案讀取進度無法取得' } };

return { walkthroughProgressTranslations };
})();

const Domain_walkthroughSavedTranslations = (() => {
type SavedCopy = Shared_walkthroughSavedTranslations.SavedCopy;

const en = Shared_walkthroughSavedTranslations.en;

const walkthroughSavedTranslations = { 'zh-Hant': { discuss: '討論', message: '訊息', edit: '編輯導覽', title: '導覽標題', stopTitle: '步驟標題', prose: '說明', refine: '改善', instructions: '需要更改什麼？', moveUp: '上移', moveDown: '下移', mergeNext: '與下一步驟合併', addSummary: '新增摘要', addCommitPlan: '提議提交', updated: '已更新儲存的結果', conflict: '此導覽已在其他地方變更。草稿已保留。請載入最新版本並檢查，然後再次儲存。', reload: '載入最新版本', missingStop: "最新導覽中已沒有此步驟。草稿已保留，請選擇其他步驟以繼續。", applicationLocked: '正在套用提交。編輯已暫停。' } } satisfies Pick<Record<string, SavedCopy>, "zh-Hant">;

return { walkthroughSavedTranslations };
})();

const Domain_walkthroughSettingsTranslations = (() => {
type Copy = Shared_walkthroughSettingsTranslations.Copy;

const en = Shared_walkthroughSettingsTranslations.en;

const copy = Shared_walkthroughSettingsTranslations.copy;

const walkthroughSettingsTranslations = { 'zh-Hant': copy({
        title: '變更導覽',
        description: '由 AI 編寫的閱讀順序，在具體變更旁提供說明，並可選擇產生提交建議。在存有程式碼的機器上執行。',
        enabled: '解釋變更',
        enabledDescription: '為比較新增閱讀順序和說明。沒有模型時仍可檢視檔案。',
        model: '摘要模型',
        modelDescription: '用於產生說明、變更導覽和提交建議。',
        chooseModel: '選擇模型',
        searchModels: '搜尋模型',
        unsupported: '無法編寫變更導覽',
        unavailable: '模型無法使用。請選擇其他模型。',
        prefetch: '每輪結束後準備',
        prefetchDescription: '代理完成一輪工作後準備變更導覽。',
        saved: '已儲存的導覽',
        savedDescription: '儲存在此機器上，包含你的編輯。',
        clear: '清除',
        unavailableData: '請重新連接機器，以載入已儲存的導覽和費用。',
        costUnavailable: '過去7天 · 費用無法取得',
        clearTitle: '清除已儲存的導覽？',
        clearDescription: ({ machine }) => `刪除 ${machine} 上已儲存的導覽和你的手動編輯，以及你對這些比較所做的審閱標記。其他機器不受影響。`,
        savedCount: ({ count, bytes }) => `已儲存 ${count} 個 · ${bytes}`,
        cost: ({ amount, partial }) => `過去7天 · ${amount}${partial ? ' · 部分費用無法取得' : ''}`,
        clearFailed: '部分導覽無法清除。請重新載入後再試一次。',
    }) };

return { walkthroughSettingsTranslations };
})();

const Domain_walkthroughStartTranslations = (() => {
const walkthroughStartTranslations = { 'zh-Hant': { walkthroughStart: { start: '開始導讀', ended: '目前無法在此使用該對話。導讀仍然保留。', newConversation: '開始新對話', askSession: '詢問工作階段代理', unavailable: '連線至所屬機器並選擇支援結構化輸出的模型。', updated: '導讀已更新' } } };

return { walkthroughStartTranslations };
})();

const Domain_walkthroughTranslations = (() => {
type WalkthroughTranslations = Shared_walkthroughTranslations.WalkthroughTranslations;

const walkthroughSavedTranslations = {...Domain_walkthroughSavedTranslations.walkthroughSavedTranslations, ...EnglishFeatures.walkthroughSavedTranslations.walkthroughSavedTranslations};

const walkthroughProgressTranslations = {...Domain_walkthroughProgressTranslations.walkthroughProgressTranslations, ...EnglishFeatures.walkthroughProgressTranslations.walkthroughProgressTranslations};

const en = Shared_walkthroughTranslations.en;

const translated = Shared_walkthroughTranslations.translated;

const walkthroughTranslations = { 'zh-Hant': {
        walkthrough: translated({
            saved: walkthroughSavedTranslations['zh-Hant'],
            progress: walkthroughProgressTranslations['zh-Hant'],
            eyebrow: '導讀',
            generated: '已產生',
            generatedBy: ({ model }) => `已產生 · ${model}`,
            generatedA11y: '由模型撰寫',
            readingChanges: '正在讀取變更…',
            modelFallback: '模型',
            analysisAll: ({ who, count }) => `${who} 已讀完全部 ${count} 處`,
            analysisSome: ({ who, analysed, total }) => `${who} 已讀 ${analysed}/${total} 處`,
            analysisStopped: ({ who, analysed, total }) => `${who} 讀了 ${analysed}/${total} 處後停止`,
            unavailableCount: ({ count }) => `${count} 處無法使用`,
            youReviewed: ({ count, total }) => `你已審閱 ${count}/${total}`,
            contents: '目錄',
            reviewedOfTotal: ({ count, total }) => `已審閱 ${count}/${total}`,
            boardReadProgress: ({ count, total }) => `已讀 ${count}/${total}`,
            stopOf: ({ number, total }) => `${number}/${total}`,
            stopA11y: ({ number, title }) => `第 ${number} 站：${title}`,
            stopReviewedA11y: ({ number }) => `第 ${number} 站，已審閱`,
            importance: { start: '從這裡開始', high: '仔細閱讀', low: '略讀' },
            markReviewed: '標記為已審閱',
            reviewed: '已審閱',
            markReviewedA11y: '將此站標記為已審閱',
            unmarkReviewedA11y: '已審閱。按下可取消標記',
            askAboutThis: '就此提問',
            askAboutStopA11y: '就此站提問',
            openConversation: '開啟導讀對話',
            andIn: ({ file }) => `以及 ${file}`,
            newFile: '新檔案',
            deletedFile: '已刪除',
            openInFiles: ({ file }) => `在檔案中開啟 ${file}`,
            otherChanges: '其他變更',
            otherChangesDescription: '不在故事中，但仍在這裡。可像一般差異一樣開啟。',
            otherChangesCue: '機械性變更，以差異顯示',
            keys: { move: '移動', reviewed: '已審閱', ask: '提問' },
            overview: '概覽',
            codeMapOf: ({ count }) => `${count} 個檔案的程式碼地圖`,
            codeMapHint: '指向某一站以勾勒其檔案',
            touchesOutlined: '涉及勾勒出的檔案',
            showOverviewA11y: ({ count }) => `顯示概覽：${count} 個檔案的程式碼地圖`,
            inventory: { title: '此比較中的全部內容 · 現已在檔案中可用', read: '已讀', reading: '讀取中', unavailable: '無法使用' },
            arriving: '後續各站寫好後會顯示在這裡。',
            previousStop: '上一站',
            nextStop: '下一站',
            done: '完成',
            evidence: { displayFailed: '無法顯示已儲存的程式碼。檔案仍保留在「檔案」中。', binary: '二進位檔案，根據中繼資料描述。僅顯示，未分析。', unavailable: ({ reason }) => `無法讀取（${reason}）。它仍在清單中；這裡不聲稱已審閱。` },
            notice: {
                stale: '寫完後有檔案發生了變更',
                refresh: '重新整理導讀',
                failed: ({ reason }) => `撰寫已停止 · ${reason}`,
                failedGeneric: '撰寫已停止',
                tryAgain: '重試',
                chooseModel: '選擇模型',
                cancelled: '撰寫已停止。已寫內容保留。',
                rest: '其餘部分未寫。所有檔案都在檔案中；沒有靜默略過任何內容。',
                offline: ({ machine, time }) => `${machine} 已離線 · 顯示 ${time} 時的導讀和程式碼。重新連線後可提問和重新整理。`,
                offlineA11y: '需要已離線的機器',
                incomplete: '部分變更無法列出。此處內容準確，但不聲稱完整。',
                undo: '復原',
            },
            none: { title: '尚無導讀', reason: '導讀會依序閱讀這些變更，並在確切程式碼旁逐一說明。所有檔案已在檔案中。', showFiles: '顯示檔案' },
            explain: { notInStory: '不在故事中', readInWalkthrough: '在導讀中閱讀' },
        }),
    } };

return { walkthroughTranslations };
})();

const Domain_widgetAddTranslations = (() => {
type WidgetAddTranslation = Shared_widgetAddTranslations.WidgetAddTranslation;

const inSentence = Shared_widgetAddTranslations.inSentence;

const widgetAddTranslations = { 'zh-Hant': {
        added: '已新增',
        boardTitle: '新增到看板',
        boardHint: '這裡的每個人都能看到你新增的內容',
        companionTitle: '新增到伴隨欄',
        companionHint: '只有你能看到你的伴隨欄',
        searchWidgets: '搜尋小工具',
        searchCompanion: '搜尋速覽和面板',
        makeOne: '新建一個',
        noteSubtitle: 'Markdown',
        interactiveViewSubtitle: 'HTML',
        findMore: '尋找更多小工具',
        findMoreSubtitle: '外掛',
        askTitle: '請代理做一個小工具',
        askNote: '在輸入框中起草；在你傳送之前不會傳送任何內容。',
        glances: '速覽',
        glancesHint: '即時，內建或來自外掛',
        onBoard: '在此看板上',
        onBoardHint: '與這裡的每個人共享',
        panes: '面板',
        panesHint: '以連結形式新增，在詳細資訊中開啟',
        builtIn: '內建',
        nativeDescriptions: {
            session_summary: '查看所選工作階段的活動與後續步驟。',
            agent_plan: '追蹤所選工作階段中代理的計畫。',
            changes: '檢視所選工作階段中的檔案變更。',
            local_services: '開啟所選工作階段執行的本機服務。',
        },
        noMatch: ({ query }) => `沒有與「${query}」相符的小工具`,
        pickTitle: '選擇一個小工具，在這裡查看',
        pickHint: '在加入之前，按你選擇的尺寸顯示你自己的資料。',
        pickNote: '選擇一個小工具來加入',
        askAction: '起草請求',
        pluginTag: '外掛',
        pluginProvenance: ({ plugin }) => `${plugin} 外掛`,
        readsChosenSession: '在工作階段執行的位置讀取你選擇的工作階段',
        readsFrom: ({ source }) => `讀取 ${source}`,
        savedQueryOn: ({ source }) => `${source} 上的已儲存查詢`,
        madeByYou: ({ date }) => `由你於 ${date} 建立`,
        madeByAgent: ({ date }) => `由你的代理於 ${date} 建立`,
        madeByPlugin: ({ date }) => `由外掛於 ${date} 建立`,
        previewLiveData: '即時，使用你的資料',
        addsAtSize: ({ size }) => `以${size}尺寸加入。之後可以變更尺寸。`,
        backToWidgets: '小工具',
        editTitle: ({ widget }) => `${widget} · 輸入`,
        editHint: '只有這個副本會改變。其他副本保留各自的輸入。',
        preview: '預覽',
        previewLive: '預覽 · 即時',
        previewWaiting: ({ field }) => `選擇${field}後會在這裡顯示`,
        listOnePerLine: "每行一個",
        listCommaSeparated: "以逗號分隔",
        previewAfterAdd: '新增後會在這裡顯示',
        needed: '必填',
        stillNeeded: ({ field }) => `仍需要 ${field}`,
        followGroup: '跟隨',
        pinGroup: '或固定一個',
        another: '其他…',
        anotherSubtitle: '搜尋你能存取的所有內容',
        searchChoices: ({ field }) => `搜尋 ${field}`,
        noChoices: '目前沒有可選項',
        optionsLoading: '正在載入選項…',
        optionsFailed: '無法載入選項',
        invalidValue: '找不到',
        inputsInvalid: '請檢查此小工具的輸入',
        inputsUnavailable: '所選輸入無法使用',
        connectionNeeded: ({ field }) => `連接你自己的${field}`,
        sessionDenied: ({ session }) => `你已失去對${session}的存取權限`,
        sessionUnavailable: ({ session }) => `${session}無法使用或已被刪除`,
        typeUnavailable: ({ field }) => `${field}的類型已無法使用`,
        inputUnavailable: ({ field }) => `${field}無法使用`,
        selectedInputUnavailable: ({ field, value }) => `${field}：${value}已無法使用`,
        invalidReason: '你已無權存取，或已被刪除。',
        viewerOnly: '這裡每個人都透過自己的連線查看。',
        justAdded: ({ widget }) => `已新增 ${widget}`,
        saved: ({ widget }) => `已儲存 ${widget}`,
        addFailed: '無法新增。請重試。',
        saveFailed: '無法儲存。請重試。',
        homeTitle: '新增到首頁',
        homeHint: '只有你能看到你的首頁 · 在所有裝置上',
        addWidgets: '新增小工具',
        addToHome: '新增到首頁',
        addToBoard: '新增到看板',
        addToCompanion: '新增到夥伴',
        editInputs: '編輯輸入…',
        width: '寬度',
        size: '尺寸',
        sizes: { small: '小', medium: '中', wide: '寬', full: '全寬', tall: '高', large: '大' },
        widthHalf: '半寬',
        widthFull: '全寬',
        thisSession: '此工作階段',
        choicesCount: ({ count }) => `${count} 個選項`,
        countOnHome: ({ count }) => `首頁上有 ${count} 個`,
        countOnBoard: ({ count }) => `看板上有 ${count} 個`,
        countInCompanion: ({ count }) => `夥伴中有 ${count} 個`,
        thisPage: '此頁面',
        thisProject: '此專案',
        thisCheckout: '此檢出',
        areaPinned: '已釘選',
        areaPinnedMeta: '你在此頁面上的小工具',
        areaProjectTitle: '小工具',
        areaProjectMeta: '你的',
        areaAdd: ({ surface }) => `將小工具新增到 ${surface}`,
        areaAddTo: ({ surface }) => `新增到 ${surface}`,
        areaHint: '只有你能看到這些小工具',
        countHere: ({ count }) => `此處 ${count} 個`,
        areaEmptyTitle: '尚未釘選任何內容',
        areaEmptyReason: '釘選一個小工具，它會只為你保留在這裡。',
        areaEmptyAction: '新增小工具',
        areaUnavailableTitle: '無法在此載入小工具',
        projectSourceUnavailableTitle: '知道此專案的儲存庫後，小工具會顯示在這裡',
        areaWriteFailed: '無法儲存此變更',
        areaApprovalPending: '等待核准',
        valueNotFound: ({ value }) => `找不到 ${value}`,
        chooseAnother: ({ field }) => `選擇其他${field}`,
        chooseField: ({ field }) => `選擇${field}`,
        widgetOptions: '小工具選項',
        moveTo: '移動…',
    } } satisfies Pick<Readonly<Record<string, WidgetAddTranslation>>, "zh-Hant">;

return { widgetAddTranslations };
})();

const Domain_widgetDefinitionTranslations = (() => {
type WidgetDefinitionTranslation = Shared_widgetDefinitionTranslations.WidgetDefinitionTranslation;

const widgetDefinitionTranslations = { 'zh-Hant': {
        yourWidgets: "你的小工具",
        yourWidgetsHint: "由你或你的代理程式建立",
        yourWidget: "你的小工具",
        moreInSource: "來源中的內容比這裡顯示的更多。",
        notCurrent: "不是最新",
        aboutMenu: "關於此小工具",
        aboutTitle: "關於此小工具",
        aboutUnavailable: "現在無法開啟此小工具。",
        aboutData: "資料",
        aboutReads: "讀取",
        aboutInputs: "輸入",
        aboutRefresh: "重新整理",
        aboutUsedIn: "用於",
        savedFromSession: ({ session }) => `儲存自 ${session}`,
        aSession: "某個工作階段",
        madeInYourAccount: "在你的帳號中建立",
        edited: ({ time }) => `${time} 編輯`,
        readsOnly: "唯讀",
        runsOn: ({ machine }) => `在 ${machine} 上執行`,
        withYourConnection: "使用你自己的連線",
        readsResource: ({ read, plugin }) => `來自 ${plugin} 的 ${read}`,
        cannotRunAnythingElse: "此小工具無法執行其他任何內容。",
        inputsThisCopy: "僅限此副本",
        refreshWhenOpen: "開啟時",
        refreshNow: "立即重新整理",
        refreshing: "正在重新整理…",
        refreshed: "已重新整理",
        refreshFailed: "無法重新整理。保留上次的數字。",
        placedOnHome: "首頁",
        placedOnBoard: ({ board }) => `${board} 看板`,
        placedOnABoard: "某個看板",
        placedInASession: "某個工作階段",
        placedInAProject: "某個專案",
        placedOnAPluginPage: "某個外掛頁面",
        placedOnACorePage: "某個應用程式頁面",
        notPlacedYet: "尚未放置在任何位置",
        otherPlacesNotListed: "其他裝置或共用介面上的位置不會在此列出。",
        editsChangeAll: ({ count }) => `編輯此小工具會變更全部 ${count} 處`,
        editsChangeEverywhere: "編輯此小工具會在所有使用它的地方生效",
        changeWithAgent: "讓代理程式修改",
        changeDraft: ({ widget }) => `修改「${widget}」小工具，使其`,
        duplicate: "複製",
        duplicated: ({ name }) => `已將副本「${name}」儲存到你的小工具`,
        duplicateFailed: "無法建立副本，請再試一次。",
        saveMenu: "另存為你的小工具…",
        saveMenuSubtitle: "用於首頁和你的看板的副本",
        saveTitle: "另存為你的小工具",
        saveHint: "可放到首頁、你的看板和專案中的副本。此工作階段保留自己的那一份。",
        saveNote: "儲存到你的帳號 · 僅你可見",
        saveWidget: "儲存小工具",
        saveFailed: "無法儲存小工具，請再試一次。",
        savedButNotPlaced: "已儲存到你的小工具，但未能加入你選擇的所有位置。",
        savedAsYours: ({ name }) => `已將「${name}」儲存到你的小工具`,
        name: "名稱",
        nameNeeded: "請為它命名",
        becomesViewerInput: "變為輸入：每個位置使用你的連線",
        becomesContextInput: "變為輸入：每個位置各自選擇",
        alsoAddTo: "同時加入到",
        alsoAddToNamed: ({ place }) => `同時加入到 ${place}`,
        snapshotMenu: "在此看板發布快照…",
        snapshotMenuSubtitle: "這裡的每個人都能看到你此刻的數字",
        snapshotTitle: "為這裡的每個人發布快照？",
        snapshotHint: ({ widget, time }) => `任何能開啟此工作階段的人都會看到 ${widget} 截至 ${time} 的資料。它不會更新，你的連線仍然只屬於你。`,
        postSnapshot: "發布快照",
        snapshotNotCurrent: "小工具仍在取得最新數字。取得後再試。",
        snapshotFailed: "無法發布快照。沒有分享任何內容。",
        snapshotAwaitingApproval: "正在收件匣中等待核准。核准前不會分享任何內容。",
        snapshotPosted: "快照已發布",
        snapshotNote: "這些數字的副本，不會更新。",
        asOf: ({ time }) => `截至 ${time}`,
    } } satisfies Pick<Readonly<Record<string, WidgetDefinitionTranslation>>, "zh-Hant">;

return { widgetDefinitionTranslations };
})();

const Domain_widgetFrameTranslations = (() => {
type WidgetFrameTranslation = Shared_widgetFrameTranslations.WidgetFrameTranslation;

const widgetFrameTranslations = { 'zh-Hant': {
        styleCard: '卡片',
        stylePlain: '簡潔',
        surfaceHome: '首頁',
        surfaceBoard: '看板',
        surfaceCompanion: '伴隨欄',
        showFrame: '顯示邊框',
        hideFrame: '隱藏邊框',
        thisWidgetOnly: '僅此小工具',
        surfaceUses: ({ surface, style }) => `${surface}使用${style}`,
        useSurfaceDefault: ({ surface }) => `使用${surface}預設樣式`,
        likeTheOthers: ({ style }) => `${style}，與其他一致`,
        appearanceTitle: '小工具',
        appearanceDescription: '此裝置上小工具的邊框樣式。要單獨變更某個小工具，請使用它的 ⋯ 選單。',
        previewLabel: ({ surface, style }) => `${surface} · ${style}`,
        noticeChanged: '邊框已變更',
        newChip: '新',
        groupInputs: "輸入…",
        groupWidth: "寬度",
        widthHalf: "半寬",
        widthFull: "全寬",
        groupFrame: "邊框",
        groupDividers: "分隔線",
        dividersLines: "線條",
        dividersNone: "無",
        groupSave: "儲存群組…",
        groupSaveSubtitle: "儲存到「你的小工具」，可加入任何地方",
        ungroup: "取消群組",
        ungroupSubtitle: ({ count }) => `其中 ${count} 個小工具留在這裡，各自回到自己的卡片`,
        groupRemove: "移除群組及其小工具",
        moveToGroup: "移到群組",
        removeFromGroup: "移出群組",
        removeFromGroupSubtitle: "回到自己的卡片，放在群組旁邊",
        groupWith: "與…組成群組",
        groupWithNew: "用這兩個建立新群組",
        groupSlot: "將小工具拖到這裡，或",
        groupSlotAdd: "新增一個",
        groupUntitled: "未命名群組",
        groupName: "群組名稱",
        groupMenu: "群組選項",
        followingGroup: "跟隨群組",
        followingGroupValue: ({ value }) => `跟隨群組 · ${value}`,
        groupInputsTitle: ({ group }) => `${group} · 輸入`,
        groupInputsHint: "只需設定一次，跟隨群組的小工具都會使用。",
        groupFollowCount: ({ following, count }) => `${count} 個小工具中有 ${following} 個跟隨群組`,
        groupFollows: "跟隨",
        groupOwnValue: "自己的值",
        groupGrantsNothing: "群組不授予任何權限：每個小工具仍會檢查自己的存取權。",
        groupSaved: ({ name }) => `${name} 已在「你的小工具」中`,
        groupSaveFailed: "無法儲存群組，請再試一次。",
        moveIntoGroupNamed: ({ group }) => `移入 ${group}`,
        intoGroupAbove: ({ target }) => `在 ${target} 上方 · 在群組內不帶邊框顯示`,
        intoGroupBelow: ({ target }) => `在 ${target} 下方 · 在群組內不帶邊框顯示`,
        intoGroupEnd: "在群組內不帶邊框顯示",
        reorderInGroupDetail: "僅調整順序",
        outOfGroupDetail: ({ group }) => `移出 ${group} · 重新擁有自己的卡片`,
        wholeGroupDetail: ({ count }) => count === 1 ? `它的元件隨之移動` : `它的 ${count} 個元件隨之移動`,
        cantPutInGroup: ({ group }) => `無法放入 ${group}`,
        groupRefusedWidth: "它需要全寬，而此群組是半寬。請放在旁邊，或將群組改為全寬。",
        groupRefusedNesting: "群組不能放進群組。請放在它的上方或下方，或先取消群組。",
        groupNeedsFullWidth: ({ widget }) => `${widget} 需要全寬`,
        groupFacts: ({ width, count }) => `${width} · ${count} 個小工具`,
        groupCannotTake: ({ group }) => `需要全寬；${group} 是半寬`,
        groupA11y: ({ name }) => `群組：${name}`,
        groupCount: ({ count }) => `群組 · ${count}`,
        groupWidgetCount: ({ count }) => `群組 · ${count} 個小工具`,
        addsAtWidth: ({ width }) => `將以${width}加入。`,
        presetEdited: "已編輯",
        presetEditedTail: ({ changes }) => changes ? ` 現在歸你所有：你${changes}。預設仍會保留。` : ' 現在歸你所有，預設仍會保留。',
        presetChangeList: ({ first, second, more }) => more > 0 ? `${first}、${second}，還有 ${more} 處變更` : second ? `${first}並${second}` : first,
        presetMovedUp: ({ item }) => `上移了 ${item}`,
        presetMovedDown: ({ item }) => `下移了 ${item}`,
        presetAdded: ({ item }) => `新增了 ${item}`,
        presetRemoved: ({ item }) => `移除了 ${item}`,
        presetChanged: ({ item }) => `變更了 ${item}`,
        presetRenamed: "改了名稱",
        groupProvenance: ({ origin, date, count }) => ['你的群組', origin && date ? `${date} 儲存自${origin}` : date ? `${date} 儲存` : origin ? `儲存自${origin}` : null, `${count} 個小工具`].filter(Boolean).join(' · '),
        groupAddsFollowing: ({ name, count, value }) => `新增 ${name} 及其 ${count} 個小工具${value ? `，跟隨 ${value}` : ''}`,
        groupInputAskedOnce: ({ count }) => `只問一次，${count} 個小工具都會跟隨。`,
        presetReset: "還原為預設",
        presetResetDone: ({ name }) => `${name} 已還原為預設`,
        presetResetFailed: "無法還原為預設。",
        undo: "復原",
        groupAddTo: "加入到…",
        groupAddToSubtitle: "在另一個首頁或專案中加入副本",
        groupCopied: ({ name, place }) => `已將 ${name} 複製到 ${place}`,
        groupCopyFailed: "無法複製群組，請再試一次。",
        groupSaveTitle: "儲存群組",
        groupSaveHint: ({ count }) => `連同其 ${count} 個小工具儲存到「你的小工具」，可加入任何地方。`,
        groupSaveNote: "這是副本：此群組保持不變。",
    } } satisfies Pick<Readonly<Record<string, WidgetFrameTranslation>>, "zh-Hant">;

return { widgetFrameTranslations };
})();

const Domain_widgetGlanceTranslations = (() => {
type WidgetGlanceTranslation = Shared_widgetGlanceTranslations.WidgetGlanceTranslation;

const widgetGlanceTranslations = { 'zh-Hant': {
        changesTitle: '變更',
        localServicesTitle: '本機服務',
        changesSource: 'Git',
        reviewChanges: '檢視變更',
        notARepo: '此工作階段的資料夾不是 Git 儲存庫。',
        noChanges: '尚無變更。代理程式編輯的檔案會顯示在這裡。',
        changesLoading: '正在載入變更',
        running: '執行中',
        notRunning: '未執行',
        nothingRunning: '沒有正在執行的服務。此工作階段啟動的服務會顯示在這裡。',
        servicesLoading: '正在載入本機服務',
        servicesReadFailed: '無法讀取本機服務。請再試一次。',
        noMachine: '此工作階段沒有可查詢的機器。',
        changedCount: ({ count }) => `${count} 個已變更`,
        moreFiles: ({ count }) => `還有 ${count} 個檔案`,
        runningCount: ({ count }) => `${count} 個執行中`,
        openInBrowser: ({ name }) => `在瀏覽器中開啟 ${name}`,
        paneLinkA11y: ({ pane }) => `${pane}。在聊天旁開啟`,
    } } satisfies Pick<Readonly<Record<string, WidgetGlanceTranslation>>, "zh-Hant">;

return { widgetGlanceTranslations };
})();

const Domain_workStatusTranslations = (() => {
type WorkStatusTranslations = Shared_workStatusTranslations.WorkStatusTranslations;

const en = Shared_workStatusTranslations.en;

const zhHant: WorkStatusTranslations = {
    buckets: {
        needs_you: '需要你',
        working: '進行中',
        finished: '已完成',
        idle: '閒置',
        offline: '離線',
    },
};

const workStatusTranslations = { zhHant: { ...zhHant, task: { stopped: '已停止', linkFailed: '工作階段已建立，但未儲存與任務的關聯。重試將關聯同一個工作階段。' } } };

return { workStatusTranslations };
})();

const Domain_workflowActionTranslations = (() => {
type Copy = Shared_workflowActionTranslations.Copy;

const en = Shared_workflowActionTranslations.en;

const workflowActionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "zhHant"> = { zhHant: {
        host: "Happier",
        structure: "結構",
        callWebhook: "呼叫 Webhook",
        runCommand: "執行命令",
        commandValuesInEnv: "透過環境變數傳遞工作流程的值。命令文字按原樣執行。",
        waitForWork: "等待工作",
        waitForWorkDescription: "等待所選工作達到指定狀態",
        callWebhookDescription: "向網址傳送請求。不需代理回合。",
        runCommandDescription: "在你的機器上執行 shell 命令。不需代理回合。",
        artifactCreate: "建立文件",
        artifactGet: "讀取文件",
        artifactList: "列出文件",
        artifactUpdate: "更新文件",
        artifactDelete: "刪除文件",
        artifactPublish: "發布檔案",
        artifactRevisions: "列出文件版本",
        artifactRestore: "還原文件版本",
        artifactUsage: "查看文件儲存用量",
        artifactShare: "透過連結分享文件",
        artifactLinks: "列出文件連結",
        artifactRevoke: "撤銷文件連結",
        artifactAudit: "查看文件連結活動",
        sessionRole: "設定工作階段角色",
        sessionRoleOverride: "變更工作階段角色設定",
        sessionRoleClear: "重設工作階段角色設定",
        sessionRoleAdd: "新增工作階段角色",
        sessionRoleRemove: "移除工作階段角色",
        sessionNotes: "設定工作階段備註",
        sessionRolesApply: "將角色套用到下屬工作階段",
        roleList: "列出角色",
        roleGet: "讀取角色",
        roleCreate: "建立角色",
        roleUpdate: "更新角色",
        roleDelete: "刪除角色",
        roleOverride: "變更角色設定",
        roleReset: "重設角色設定",
        widgetCatalog: "列出可用小工具",
        widgetInstances: "列出已放置的小工具",
        widgetAdd: "新增小工具",
        widgetRemove: "移除小工具",
        widgetMove: "移動小工具",
        widgetRename: "重新命名小工具",
        widgetSize: "設定小工具大小",
        widgetFrame: "設定小工具邊框",
        widgetInputs: "讀取小工具輸入",
        widgetValidate: "檢查小工具輸入",
        widgetSetInputs: "設定小工具輸入",
        widgetResetInputs: "重設小工具輸入",
        widgetLayout: "讀取小工具配置",
        widgetUpdateLayout: "變更小工具配置",
        widgetDefinitions: "列出已儲存的小工具",
        widgetDefinition: "讀取已儲存的小工具",
        widgetCreate: "建立小工具",
        widgetUpdate: "更新已儲存的小工具",
        widgetDuplicate: "複製已儲存的小工具",
        widgetDelete: "刪除已儲存的小工具",
        widgetSave: "儲存工作階段小工具",
    } };

return { workflowActionTranslations };
})();

const Domain_workflowAgentAuthoringTranslations = (() => {
type Edit = Shared_workflowAgentAuthoringTranslations.Edit;

type RepeatableMessage = Shared_workflowAgentAuthoringTranslations.RepeatableMessage;

type Copy = Shared_workflowAgentAuthoringTranslations.Copy;

const en = Shared_workflowAgentAuthoringTranslations.en;

const repeatable = { zhHant: { repeatable: '轉為可重複使用', repeatableDescription: '請代理把這裡成功的做法變成可再次執行的工作流程。', repeatablePrompt: '把我們在這裡做的事情變成我可以再次執行的工作流程。起草它，用 workflow.validate 檢查並儲存，但不要執行。', repeatableMessagePrompt: '把我們在這則訊息中做的事情變成我可以再次執行的工作流程。起草它，用 workflow.validate 檢查並儲存，但不要執行。', repeatableMessageSource: ({ text }: RepeatableMessage) => `“${text}”` } };

const workflowAgentAuthoringTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "zhHant"> = { zhHant: { ...repeatable.zhHant, create: '與代理一起建立', edit: '與代理一起編輯', agent: '代理', description: '新的工作階段會與你一起起草工作流程，檢查並儲存。選擇立即執行之前不會執行任何內容。', changedByAgent: '由代理更改', saved: '代理剛剛儲存', savedAge: ({ age }) => `由代理儲存 · ${age}`, savedWorkflow: ({ name }) => `工作流程已儲存 · ${name}`, updated: '已更新工作流程', changed: ({ count }) => `已更新工作流程 · 更改了 ${count} 個步驟`, openEditor: '在編輯器中開啟', openSession: '在工作階段中開啟', createPrompt: '和我一起起草一個工作流程，用 workflow.validate 檢查，然後儲存。不要執行它。', createLead: '幫我建立一個工作流程，它會', editPrompt: ({ name, definitionId, headerVersion, bodyVersion }) => `已儲存的工作流程「${name}」的 id 為 ${definitionId}，版本：標頭 ${headerVersion}，內容 ${bodyVersion}。用 workflow.definition.edit 修改它，只有整體替換時才使用 workflow.definition.update。儲存前用 workflow.validate 檢查。不要執行它。`, editLead: ({ name }) => `幫我修改 ${name}：` } };

return { repeatable, workflowAgentAuthoringTranslations };
})();

const Domain_workflowBuiltinTranslations = (() => {
type WorkflowBuiltinTranslations = Shared_workflowBuiltinTranslations.WorkflowBuiltinTranslations;

const en = Shared_workflowBuiltinTranslations.en;

const zhHant: WorkflowBuiltinTranslations = {
    keepGoing: { title: '持續直到完成', description: '持續進行，直到達成目標' },
    reviewAndConverge: { title: '審查並收斂', description: '審查直到審閱者達成共識', apply: '套用', verifyAndFix: '驗證並修復', verifyOnly: '僅驗證', rounds: '停止前的輪數' },
    planWithAPanel: { title: '由小組規劃', description: '多個代理並行規劃，然後計畫等待你的審查。', inputs: { request: '請求', requestPlaceholder: '小組應規劃什麼？', engines: '規劃者' } },
    openAPullRequest: { title: '開啟提取請求', description: '先徵詢第二意見，再開啟提取請求。如果第二意見不同意，它會等待你。', inputs: { base: '基礎分支', title: '提取請求標題', body: '描述', question: '給第二意見的問題' } },
};

const workflowBuiltinTranslations = { zhHant } as const;

return { workflowBuiltinTranslations };
})();

const Domain_workflowFieldTranslations = (() => {
const workflowFieldTranslations = { zhHant: {
        sessionId: "工作階段",
        triggerId: "觸發器",
        engineIds: "審查者",
        backendTargetKeys: "規劃者",
        reviewCommentAuthorIntent: "發現",
        commentId: "發現",
        expectedServerRevision: "發現版本",
        clientMutationId: "更新",
        projectId: "專案",
        workspace: "工作區",
        toState: "狀態",
        expectedState: "目前狀態",
        disposition: "重要性",
        allPages: "所有發現",
        permissionMode: "權限",
        target: "執行位置",
        cwd: "工作資料夾",
        maxRounds: "最大輪數",
        strikes: "無進展的檢查次數",
        secondOpinion: "第二意見",
        useJudge: "評判者",
        diffFingerprint: "已審查的變更",
        url: "URL",
        body: "JSON 本文",
        command: "命令",
        env: "環境變數",
    } };

return { workflowFieldTranslations };
})();

const Domain_workflowEditorPageTranslations = (() => {
type WorkflowEditorPageTranslations = Shared_workflowEditorPageTranslations.WorkflowEditorPageTranslations;

const workflowFieldTranslations = {...Domain_workflowFieldTranslations.workflowFieldTranslations, ...EnglishFeatures.workflowFieldTranslations.workflowFieldTranslations};

const en = Shared_workflowEditorPageTranslations.en;

const pluralPl = Shared_workflowEditorPageTranslations.pluralPl;

const pluralRu = Shared_workflowEditorPageTranslations.pluralRu;

const zhHant: WorkflowEditorPageTranslations = {
    fields: workflowFieldTranslations.zhHant,
    blocks: {
        actionSub: '動作 · 無代理回合',
        notSet: '未設定',
        set: '設定',
        clear: '清除',
        required: '必填',
        noFields: '此動作沒有需要設定的內容。',
        workflowSub: '執行另一個工作流程 · 其步驟顯示在此次執行中',
        builtin: '內建',
        waitTitle: '等待你',
        waitSub: '此通道會等待你繼續',
        waitSubRoot: '此工作流程會等待你繼續。',
        waitPlaceholder: '你需要在這裡檢查或決定什麼？',
        returnsText: '傳回文字',
        returnsFields: ({ fields }) => `傳回 ${fields}`,
        workflowDefaults: '工作流程預設',
        addNamedResults: '新增具名結果',
        menuRun: '執行工作流程',
        menuAction: '動作',
        menuWait: '等待你',
        actionSearch: '搜尋動作',
        workflowSearch: '搜尋工作流程',
        libraryGroup: '你的工作流程',
        noAgentTurn: '通知、審查、發布 — 無代理回合',
        agentSub: '給代理的一條指示',
        parallelSub: '同時執行的分支',
        loopSub: '逐項、重複指定次數，或直到…',
        ifSub: '僅在結果滿足條件時',
        actionSourcePhone: '你的手機',
        actionSourceReview: '審查引擎',
        useNumber: '使用數字',
        actionUnavailable: ({ action }: { action: string }) => `${action} 在此無法使用。`,
        childInputs: ({ workflow }: { workflow: string }) => `輸入來自 ${workflow}。`,
        retryLoading: "重試載入",
        openWorkflow: ({ workflow }) => `開啟 ${workflow}`,
        selfRef: ({ workflow }: { workflow: string }) => `${workflow} 會執行此工作流程，因此無法在其中執行。`,
        maxFromInput: ({ name }: { name: string }) => `來自輸入 · ${name}`,
        useInput: ({ name }: { name: string }) => `使用輸入 ${name}`,
    },
    backToRun: '返回執行',
    reviewedCopyTitle: '儲存前檢查',
    reviewedCopyBody: '這是來自一次執行的副本。儲存的是步驟和設定，不包含執行歷史或結果。執行位置、執行方式和輸入值僅用於執行。重用前請檢查對既有工作階段、資料夾、設定檔、模型、服務和 MCP 伺服器的參照。',
    chromeTitle: '工作流程',
    untitled: '未命名工作流程',
    nameLabel: '工作流程名稱',
    descriptionPlaceholder: '新增描述',
    descriptionLabel: '描述',
    save: '儲存',
    flow: '流程',
    flowSubtitle: '以地圖顯示此草稿',
    settings: '工作流程設定',
    settingsSubtitle: '除非步驟自行變更，否則都使用這些設定。',
    deleteWorkflow: '刪除工作流程',
    deleteBody: '過去的執行會保留。',
    discardChangesBody: '回到上次儲存的版本。復原可找回你的變更。',
    deleteFailedTitle: '無法刪除工作流程',
    changedForStep: '已為此步驟變更',
    issuesToFix: ({ count }: { count: number }) => (count === 1 ? '執行前還有 1 處需要修正' : `執行前還有 ${count} 處需要修正`),
    readyToRun: '就緒',
    saveStatus: {
        notSaved: '尚未儲存',
        unsaved: '有未儲存的變更',
        saving: '正在儲存…',
        saved: '已儲存',
        savedJustNow: '剛剛已儲存',
        savedAge: ({ age }: { age: string }) => `已儲存 · ${age}`,
        failed: '無法儲存',
        yourEdits: '你的修改',
        newerVersion: '較新的版本',
        newerVersionRevision: ({ revision }: { revision: string }) => `較新的版本 · ${revision}`,
    },
    where: {
        label: '執行位置',
        choose: '選擇執行位置',
    },
    sections: {
        whereTitle: '執行位置',
        machineAndProject: '機器和專案',
        eachStepRunsIn: '每個步驟執行於',
        eachStepSession: '每個步驟都會顯示在你的工作階段清單中，位於此次執行之下。',
        eachStepBackground: '每個步驟都在背景執行，位於此次執行之下。',
        aSession: '工作階段',
        aBackgroundRun: '背景執行',
        agentTitle: '代理和模型',
        agentDescription: '除非步驟自行選擇，否則都使用這些。',
        rolesTitle: '此工作流程的角色',
        conversationTitle: '對話和工作區',
        inputsTitle: '輸入和輸出',
    },
    unavailable: {
        machine_not_selected: '請先選擇一台機器。',
        capability_unknown: '正在檢查這台機器支援的功能。',
        machine_does_not_support_detached_runs: '這台機器尚不支援背景執行。',
    },
    /** Workflow settings and Step options (U-9): group summaries and the block subject. */
    inspector: {
        stepOptions: '步驟選項',
        whereMissing: '未選擇機器',
        none: '無',
        inputCount: ({ count }) => `${count} 個輸入`,
        finalOutput: ({ output }) => `最終輸出：${output}`,
        originSession: '啟動它的工作階段',
        differsFromWorkflow: '與工作流程不同',
        followsWorkflow: '使用工作流程設定',
        advancedTitle: '進階',
        deadline: ({ ms }) => `等待結果 ${ms} 毫秒`,
        workflowDefault: ({ value }) => `工作流程預設 · ${value}`,
        aSession: '一個工作階段…',
        continues: ({ session }) => `繼續 ${session}`,
        runsIn: '執行於',
        runsInBoundBySession: '繼續某個工作階段，因此在該工作階段中執行。',
        reviewTitle: '繼續前審閱',
        reviewDescription: '此通道中的後續步驟會等待你使用、編輯或重新產生結果。其他工作持續進行。',
        reviewEvaluator: '每次反覆都會等待你的審閱。',
        reviewsBeforeContinuing: '繼續前審閱',
        resultTitle: '結果',
        resultFromAction: ({ action }) => `由 ${action} 定義`,
        resultFromWorkflow: ({ workflow }) => `傳回 ${workflow} 的傳回值`,
        back: '返回',
        options: '選項',
        itemConversation: '每個項目各自一個對話；內部步驟共用它。',
        dropContinue: ({ session }) => `在此步驟中繼續 ${session}`,
        dropRefused: ({ session, machine, where }) => `${session} 在 ${machine} 上；此工作流程在 ${where} 上執行。`,
        lanes: ({ count }) => `並排 · ${count} 條通道`,
        laneCount: ({ count }) => `${count} 條通道`,
        lane: ({ position }) => `通道 ${position}`,
        forEachIn: ({ source }) => `對 ${source} 中的每個項目`,
        atATime: ({ count }) => `每次 ${count} 個`,
        repeatTimes: ({ count }) => `重複 ${count} 次`,
        repeatUntil: ({ condition }) => `重複直到 ${condition}`,
        repeatUntilDecided: '重複直到某個步驟要求停止',
        ifSentence: ({ condition }) => `如果 ${condition}`,
        onlyWhenSentence: ({ condition }) => `僅當 ${condition}`,
        conditionAll: '全部成立',
        conditionAny: '任一成立',
        conditionNot: ({ condition }) => `非（${condition}）`,
        returnsStructured: '傳回結構化資料',
        returnsDecision: '傳回一個決定',
    },
};

const workflowEditorPageTranslations = { zhHant } as const;

return { workflowEditorPageTranslations };
})();

const Domain_workflowExamplesTranslations = (() => {
type ExampleCopy = Shared_workflowExamplesTranslations.ExampleCopy;

type Copy = Shared_workflowExamplesTranslations.Copy;

const workflowExamplesTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "zhHant"> = { zhHant: {
        sessionNotifyDescription: "每當此工作階段的代理需要你的輸入時傳送通知。",
        sessionDailySummaryDescription: "每天 09:00 在這裡產生摘要。",
        sessionTestDescription: "在每個完成、失敗或取消的回合後執行可編輯的測試命令。",
        notifyWhenAgentWaits: { title: "在代理等待時通知我", description: "選擇一個工作階段，每當其中的代理需要你的輸入時，就會收到通知。" },
        dailySummaryInSession: { title: "在此工作階段中每日摘要", description: "選擇一個工作階段，每天09:00產生摘要。" },
        memoryUpkeepInSession: { title: '記憶維護', description: '每天09:00檢查此工作階段的記憶，並更新有用的資訊。' },
        installDepsInWorktree: { title: "在新工作樹中安裝相依套件", description: "建立一個新工作樹，並在其中執行可編輯的安裝指令。" },
        testAfterEveryTurn: { title: "每回合結束後測試", description: "選擇一個工作階段，在每回合完成、失敗或取消後執行可編輯的測試指令。" },
        noSessions: "啟動一個工作階段以使用此範本。",
        nodes: { ask: '提問', 'review-correctness': '審查正確性', 'review-tests': '審查測試', summarize: '彙總發現', analyze: '分析', review: '審查', fix: '修復', check: '檢查', classify: '分類', reply: '起草回覆', digest: '彙總變更' },
        title: '從範例開始', fromExample: '使用範例', description: '每個範例都以草稿開啟。選擇「立即執行」之前不會執行。', sessionDescription: '每個都會在此工作階段以草稿開啟。開啟之前不會執行。', use: '使用此範例', chooseSession: '選擇工作階段…', builtInDescription: 'Happier 內建。複製後即可修改。', stepCount: ({ count }) => `${count} 個步驟`,
        askOnce: { title: '問一次', description: '一個步驟：向代理提問並取得回答。' },
        reviewPullRequest: { title: '審查提取請求', description: '兩位審查者並行工作，然後彙總所有發現。' },
        workThroughEachFile: { title: '逐個處理檔案', description: '逐個分析清單中的檔案，然後審查修改。' },
        repairUntilItPasses: { title: '修復直到通過', description: '反覆修復和檢查，直到通過或用完允許的次數。然後由你審查最後的修復。' },
        triageAnIssue: { title: '分類問題', description: '對問題分類。如果是錯誤則修復，否則起草回覆。' },
        morningDigest: { title: '晨間摘要', description: '彙總專案變更並傳送給你。新增觸發器即可每天早上收到。' },
    } };

return { workflowExamplesTranslations };
})();

const Domain_workflowPluginTranslations = (() => {
type Copy = Shared_workflowPluginTranslations.Copy;

const en = Shared_workflowPluginTranslations.en;

const workflowPluginTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "zhHant"> = { zhHant: { fromPlugins: '來自外掛', readOnly: '唯讀 · 複製到你的程式庫以編輯', duplicateToLibrary: '複製到你的程式庫' } };

return { workflowPluginTranslations };
})();

const Domain_workflowRunVisibilityTranslations = (() => {
type VisibilityCopy = Shared_workflowRunVisibilityTranslations.VisibilityCopy;

const workflowRunVisibilityTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', VisibilityCopy>, "zhHant"> = { zhHant: { title: "可見範圍", chooseTeam: "選擇團隊", loadFailed: "無法檢查誰能查看此執行", machines: "在你的機器上執行", transcripts: "團隊成員可以查看步驟對話。", requiredSessionsEditable: "此團隊的成員可以編輯團隊會話", visibleTo: ({ team }) => "可見團隊：" + team } };

return { workflowRunVisibilityTranslations };
})();

const Domain_workflowRunCompositionTranslations = (() => {
const workflowRunVisibilityTranslations = {...Domain_workflowRunVisibilityTranslations.workflowRunVisibilityTranslations, ...EnglishFeatures.workflowRunVisibilityTranslations.workflowRunVisibilityTranslations};

const en = Shared_workflowRunCompositionTranslations.en;

const workflowRunCompositionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "zhHant"> = { zhHant: { visibility: workflowRunVisibilityTranslations.zhHant, runWithAnotherAgent: '用另一個代理再次執行', agentForStep: ({ step }) => `${step}的代理`, chooseAgent: '選擇代理或角色' } };

return { workflowRunCompositionTranslations };
})();

const Domain_workflowRunListTranslations = (() => {
type Progress = Shared_workflowRunListTranslations.Progress;

const en = Shared_workflowRunListTranslations.en;

const workflowRunListTranslations = { zhHant: {
        definitions: '定義',
        stepsProgress: ({ completed, total }: Progress) => `${total} 個步驟中已完成 ${completed} 個`,
        loopProgress: ({ completed, total }: Progress) => `${total} 項中已完成 ${completed} 項`,
        startedByAgent: '由代理啟動',
        startedByTrigger: '由觸發器啟動',
    } } satisfies Pick<Record<string, typeof en>, "zhHant">;

return { workflowRunListTranslations };
})();

const Domain_workflowRunRoleTranslations = (() => {
const en = Shared_workflowRunRoleTranslations.en;

const workflowRunRoleTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "zhHant"> = { zhHant: { rolesTitle: '本次執行的角色', rolesYour: '你的角色', rolesChanged: ({ count }) => `本次執行更改了 ${count} 個`, rolesUnchanged: '其他內容保持不變。', useYourRole: '使用你的角色', targetsTitle: '每個步驟執行於', rolesPrefillFailed: '無法讀取你上次執行的角色。請重試。' } };

return { workflowRunRoleTranslations };
})();

const Domain_workflowStartTranslations = (() => {
type Copy = Shared_workflowStartTranslations.Copy;

const workflowRunRoleTranslations = {...Domain_workflowRunRoleTranslations.workflowRunRoleTranslations, ...EnglishFeatures.workflowRunRoleTranslations.workflowRunRoleTranslations};

const workflowRunCompositionTranslations = {...Domain_workflowRunCompositionTranslations.workflowRunCompositionTranslations, ...EnglishFeatures.workflowRunCompositionTranslations.workflowRunCompositionTranslations};

const en = Shared_workflowStartTranslations.en;

const workflowStartTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "zhHant"> = { zhHant: { ...workflowRunRoleTranslations.zhHant, ...workflowRunCompositionTranslations.zhHant, shortcutStarts: '開始', neededNamed: ({ name }) => `輸入 · 需要${name}`, addToStart: ({ name }) => `新增${name}後即可開始`, workflow: '工作流程', inputs: '輸入', start: '開始', starting: '正在開始…', stillStarting: '仍在開始…', needed: ({ count }) => `輸入 · 還需 ${count} 項`, required: '開始前必填', preview: '將執行的內容', unsaved: '包含未儲存的變更', remove: '返回一般工作階段', search: '尋找工作流程', builtin: '內建', library: '你的程式庫', noInputs: '無需輸入', asksFor: ({ names }) => `需要：${names}`, optional: '選填 — 留空', defaultValue: ({ value }) => `預設值：${value}` } };

return { workflowStartTranslations };
})();

const Domain_workflowsDestinationTranslations = (() => {
type WorkflowsDestinationTranslations = Shared_workflowsDestinationTranslations.WorkflowsDestinationTranslations;

const en = Shared_workflowsDestinationTranslations.en;

const zhHant: WorkflowsDestinationTranslations = {
    description: '你的代理在你的機器上執行的流程——在你需要時、依排程或在某件事發生時。',
    import: '匯入',
    addAccessibility: '新增工作流程',
    moreAccessibility: '更多工作流程選項',
    addMenu: {
        newWorkflowSubtitle: '從空白草稿開始',
        importSubtitle: '工作流程 JSON 檔案',
    },
    sections: {
        needsYou: '需要你處理',
        running: '執行中',
        library: '資料庫',
        sharedWithYou: '與你共用',
        triggers: '觸發條件',
        history: '歷史',
    },
    allRuns: '所有執行',
    lastRun: ({ age }) => `上次執行 ${age}`,
    strip: {
        label: ({ count, parts }) => `最近 ${count} 次執行：${parts}`,
        labelPlain: ({ count }) => `最近 ${count} 次執行`,
        completed: ({ count }) => `${count} 次完成`,
        failed: ({ count }) => `${count} 次失敗`,
        needsYou: ({ count }) => `${count} 次需要你處理`,
        separator: '，',
    },
    runSettings: '執行設定',
    libraryEmpty: '你儲存的工作流程會顯示在這裡。',
    waitingForYou: ({ age }) => `等你處理 · ${age}`,
    stateAge: ({ state, age }) => `${state} · ${age}`,
    triggerRow: ({ when, then }) => `${when} · ${then}`,
    thenSendPrompt: '傳送提示詞',
    thenRunWorkflow: '執行工作流程',
    offline: '離線',
    off: '已關閉',
    columnLoadFailed: '無法載入工作流程。你儲存的內容都不會遺失。',
    firstVisitTitle: '儲存好用的提示詞，然後再次執行',
    firstVisitBody: '工作流程是一組步驟，由你的代理依序、並行或對每個項目各執行一次——在你需要時、依排程或在某件事發生時。',
    importPrompt: '有工作流程檔案？',
    loadMoreWorkflows: '載入更多工作流程',
    searchPlaceholder: '搜尋工作流程',
    noMatch: ({ query }) => `沒有符合「${query}」的工作流程`,
    views: {
        all: '全部',
        triggered: '有觸發條件',
        active: '進行中',
        needsYou: '需要你處理',
        libraryAccessibility: '要顯示的工作流程',
        historyAccessibility: '要顯示的執行',
    },
    history: {
        title: '歷史',
        description: '你啟動的每一次執行，無論以何種方式開始。',
        loadMore: '載入更多執行',
        loadFailedTitle: '無法載入執行',
        loadFailedBody: '你的工作不受影響。',
        review: '查看',
        rowMeta: ({ origin, machine, age }) => `${origin} · ${machine} · ${age}`,
    },
    rowMenu: {
        accessibility: '工作流程選項',
        runNow: '立即執行',
        share: '共用…',
    },
    deleteTitle: '要刪除此工作流程嗎？',
    deleteFailedTitle: '無法刪除工作流程',
    exportFailedTitle: '無法匯出工作流程',
    gate: {
        localTitle: '此裝置上的自動化已關閉',
        localBody: '開啟後即可執行工作流程及其觸發條件。',
        dependencyTitle: '工作流程需要自動化',
        dependencyBody: '開啟自動化以建立和執行工作流程。',
        openSettings: '開啟設定',
    },
    runSettingsPage: {
        title: '執行設定',
        description: '每台機器同時接受多少次執行，以及執行歷史保留多久。',
        saveFailed: '無法儲存執行設定。你的變更仍在這裡。',
    },
};

const workflowsDestinationTranslations = { zhHant } as const;

return { workflowsDestinationTranslations };
})();

const Domain_workflowTriggersTranslations = (() => {
type Count = Shared_workflowTriggersTranslations.Count;

type WorkflowTriggersCopy = Shared_workflowTriggersTranslations.WorkflowTriggersCopy;

const en = Shared_workflowTriggersTranslations.en;

const zhHant: WorkflowTriggersCopy = {
    activity: {
        create: "根據此事件建立觸發條件",
        test: "測試此觸發條件",
        matched: "此事件相符",
        noMatch: "此事件不相符",
        sourceMismatch: "此事件來自其他來源",
        tooOld: "此事件已超出觀察時限",
        invalid: "請先設定事件再進行測試",
    },
    pullRequest: {
        label: "提取要求",
        description: "新增此觸發器會將提取要求連結至此工作階段。",
        empty: "沒有開啟的提取要求",
        loadFailed: "無法載入提取要求",
    },
    summary: {
        everyDayAt: ({ time }) => `每天 ${time}`,
        weekdaysAt: ({ time }) => `平日 ${time}`,
        weeklyAt: ({ day, time }) => `每${day} ${time}`,
        everyMinutes: ({ count }) => (count === 1 ? '每分鐘' : `每 ${count} 分鐘`),
        everyHours: ({ count }) => (count === 1 ? '每小時' : `每 ${count} 小時`),
        cron: ({ expression }) => `依排程 · ${expression}`,
        schedule: '依排程',
        event: ({ event }) => `當 ${event} 發生時`,
        manual: '手動',
        more: ({ first, count }) => `${first} · 另有 ${count} 個`,
    },
    kind: {
        pluginEvent: "外掛程式事件",
        sessionStarts: '當工作階段開始時',
        sessionArchived: '當工作階段被封存時',
        schedule: '依排程',
        prComment: '當有人評論拉取請求時',
        ciFailed: '當拉取請求的 CI 失敗時',
        turnEnds: '當一輪結束時',
        needsYou: '當工作階段需要你時',
        runEnds: '當執行結束時',
        runNeedsYou: '當執行需要你時',
    },
    row: {
        workflowDeleted: '工作流程已刪除',
        legacyCreated: '在 Happier 0.2 中建立',
        legacyUnavailable: '舊觸發器無法使用',
        sessionKeyRequired: '需要工作階段金鑰',
        templateRecoveryRequired: '請在帳號安全設定中復原此觸發器',
        templateDecryptionFailed: '無法解密觸發器',
        machines: ({ count }: Count) => `${count} 台機器`,
        nextRun: ({ time }: { time: string }) => `下次執行：${time}`,
        nextMinutes: ({ count }: Count) => `${count} 分鐘後`,
        nextHours: ({ count }: Count) => `${count} 小時後`,
        nextDays: ({ count }: Count) => count === 1 ? '明天' : `${count} 天後`,
        steps: ({ count }) => (count === 1 ? `${count} 個步驟` : `${count} 個步驟`),
        off: '已關閉',
        running: '執行中',
        ran: ({ age }) => `${age}執行`,
        lastOutcome: ({ state, age }) => `${age}${state}`,
        turnOn: ({ name }) => `開啟 ${name}`,
        turnOff: ({ name }) => `關閉 ${name}`,
    },
    section: {
        add: '新增觸發器',
        emptyTitle: '沒有觸發器',
        emptyBody: '新增一個，用於審查每一輪、持續推進目標或回應拉取請求。',
        loadFailed: '無法載入此工作階段的觸發器。',
        accountLoadFailed: '無法載入你的觸發器。',
        title: '觸發器',
        countOn: ({ count }) => `${count} 個已開啟`,
        info: '發生某事時在此工作階段中執行的內容。它們留在此工作階段中，不會出現在你的資料庫中。',
        saveFailed: '無法儲存此觸發器。你的變更仍在這裡。',
    },    kindDescription: {
        pluginEvent: "在外掛程式觀察到事件時執行。",
        turnEnds: '在你或與你協作的代理完成一輪之後。',
        needsYou: '每當此工作階段等待你時，包括由工作流程或「持續到完成」驅動時。',
        sessionArchived: '在你封存此工作階段時執行一次。',
        sessionStarts: '僅在建立工作階段時。',
        schedule: '依排程繼續此工作階段。',
        prComment: '僅限有寫入權限的人。評論會以引用文字傳入。',
        pullRequestUnavailable: '暫時還不能在這裡新增拉取請求觸發器。',
    },
    then: {
        runsIn: '執行於',
        runsInChoice: {
            newSession: '新工作階段',
            session: '某個工作階段…',
            backgroundRun: '背景執行',
        },
        noSessionOnMachine: '此機器上還沒有工作階段',
        session: '工作階段',
        action: '動作',
        label: '然後',
        sendPrompt: '傳送提示',
        doAction: '執行動作',
        notifyMe: '通知我',
        runWorkflow: '執行工作流程',
        sendPromptDescription: '此工作階段的代理會在此工作階段中收到這則提示。它不會打斷你的回合。',
        promptLabel: '提示',
        promptPlaceholder: '代理應該做什麼？',
        message: '訊息',
        title: '標題',
        sendTo: '傳送到',
        sendToDefault: '你的通知設定',
        workflow: '工作流程',
        choose: '選擇…',
    },
    popover: {
        configureEvent: "設定事件",
        editEvent: "編輯事件",
        saveAsWorkflow: '另存為工作流程',
        saveAsWorkflowDescription: '將這些步驟作為新工作流程開啟以供審查。此觸發器保留自己的步驟。',
        when: '何時',
        newTrigger: '新觸發器',
        addTrigger: '新增觸發器',
        cancel: '取消',
        done: '完成',
        turnOff: '關閉',
        turnOn: '開啟',
        deleteTrigger: '刪除觸發器',
        repeat: '重複',
        everyDay: '每天',
        weekdays: '平日',
        weekly: '每週',
        day: '星期',
        at: '時間',
        expression: '排程',
        tryAgain: '重試',
    },    editor: {
        runsOn: '執行機器',
        runsOnDescription: '此工作流程的所有觸發器都在這裡執行。',
        runsOnAccountDescription: '此觸發器的執行位置。',
        runsOnDiffers: ({ where }) => `「立即執行」改用 ${where}。`,
        sameForAllTriggers: '所有觸發器相同',
        roles: '角色',
        retargetFailed: '工作流程已儲存 · 觸發器未更新',
        editInWorkflows: '請在工作流程中變更此觸發器。它會維持原樣繼續執行。',
        title: '自動執行',
        runsBy: '當發生以下任一情況時自動執行。',
        runsByOn: ({ where }) => `當發生以下任一情況時，在 ${where} 上自動執行。`,
        savedWorkflow: '觸發器執行已儲存的工作流程。',
        saveToInclude: '觸發器執行已儲存的工作流程。儲存以包含你的變更。',
        newRow: '新增 · 尚未加入',
        partialSave: '工作流程已儲存 · 觸發器未更新',
    },    column: {
        newTrigger: '新觸發器',
        newTriggerSubtitle: '依排程執行自己的步驟',
    },
};

const legacyTranslations = { zhHant: {
        editNotice: '建立於 Happier 0.2。開啟不會變更任何內容。',
        conversionBoundary: '此變更後僅在執行 Happier 0.3 或更新版本的機器上執行。',
        reviewRequired: '需要你審核',
        reviewConversionNotice: '儲存後，工作流程將以非端對端加密方式儲存，並恢復其已啟用的觸發器。工作階段仍保持端對端加密。',
        channelReplyRefusal: '此自動化有無法轉移的頻道回覆綁定。尚未轉換，原設定和你的編輯均保留。',
        notAvailable: '此自動化已無法使用。',
    } };

const creationTranslations = { zhHant: { savedWorkflowsUnavailable: '切換到此工作階段的伺服器以選擇已儲存的工作流程。內建工作流程和內嵌步驟仍可使用。' } };

const workflowTriggersTranslations = { zhHant: { ...zhHant, legacy: legacyTranslations.zhHant, creation: creationTranslations.zhHant } } as const;

return { legacyTranslations, creationTranslations, workflowTriggersTranslations };
})();

const Domain_workflowValueReferenceTranslations = (() => {
const workflowValueReferenceTranslations = { 'zh-Hant': {
        checkoutRoot: '簽出根資料夾',
        unavailableValue: '值無法使用', sessionContext: ({ turns }: { turns: number }) => turns === 0 ? '工作階段上下文' : turns === 1 ? '最近一回合工作階段' : `最近${turns}回合工作階段`,
        tokensUsed: '已用權杖', goalTokenBudget: '目標權杖預算',
        trailingCount: ({ source, value }: { source: string; value: string }) => `連續符合${value}的${source}`,
        stopCondition: '已滿足停止條件', stopConditionArm: ({ arm }: { arm: number }) => `已滿足停止條件${arm}`,
        roundLimit: ({ rounds }: { rounds: number }) => `已達回合上限 · ${rounds}回合`, decision: '決定',
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

const zhHant = translated(workflowValueReferenceTranslations['zh-Hant'], {
    testRun: {
        title: "測試執行",
        savedNotice: "實際執行已儲存的版本。未儲存的編輯會留在這裡。",
        resultsNotice: "已儲存版本的結果 · 最近一次執行。未儲存的編輯未參與執行。",
        recordedDuration: ({ seconds }) => `記錄的耗時 · ${seconds} 秒`,
        loading: "正在載入測試結果…",
    },
    runWhen: {
        title: "執行條件",
        success: "成功",
        failure: "失敗",
        always: "一律",
        ifSuccess: "如果成功",
        ifFailure: "如果失敗",
        regardless: "無論結果如何",
        previousStep: "相對於上一個步驟",
    },
    title: '工作流程',
    newWorkflow: '新增工作流程',
    copyName: ({ name }: { name: string }) => `${name} 副本`,
    importJson: '匯入 JSON',
    exportJson: '匯出 JSON',
    openCollection: '開啟工作流程',
    destination: workflowsDestinationTranslations.zhHant,
    plugins: workflowPluginTranslations.zhHant,
    authoring: workflowAgentAuthoringTranslations.zhHant,
    page: workflowEditorPageTranslations.zhHant,
    actionTitles: workflowActionTranslations.zhHant,
    builtins: workflowBuiltinTranslations.zhHant,
    examples: workflowExamplesTranslations.zhHant,
    triggers: workflowTriggersTranslations.zhHant,
    start: workflowStartTranslations.zhHant,
    list: workflowRunListTranslations.zhHant,
    review: {
        publishedByAgent: '由代理發佈',
        publishedByYou: '由你發佈',
        editedByYou: '由你編輯',
        editedByPerson: '由其他人編輯',
        previousAttempt: '上一次嘗試',
        useBody: "後續步驟會收到你看到的確切內容。不啟動代理回合。",
        usePlanBody: "接受此計畫的確切內容。不啟動代理回合。",
        reportBackTitle: ({ session }) => "回報給 " + session,
        reportBackBody: ({ session }) => session + " 會在此執行結束後收到結果。",
        planRunNotice: "依顯示內容執行建議的工作流程，並接受計畫。不會儲存工作流程。",
        editedPlanBody: '此草稿與提案不同。是否先接受已審閱的計畫以進行編輯？你的變更會保留在這裡，只有再次執行草稿時才會開始執行。',
        title: "待審核的結果",
        planTitle: "待審核的計畫",
        waitTitle: "等待你的操作",
        waitBody: "此分支會等待，直到你繼續。",
        editsTitle: "你尚未儲存的修改",
        editsBody: "使用結果前，已儲存的結果保持不變。",
        heldBody: "等待你的審核 · 尚未傳給後續步驟",
        noValue: "尚無有效結果",
        enterValues: '請填寫各項。',
        useResult: "使用此結果",
        usePlan: "使用此計畫",
        useValues: "使用這些值",
        continue: "繼續",
        invalid: "請先修正標出的欄位。",
        newer: "有更新的結果。",
        showNewer: "顯示新結果",
        keepMyEdits: '保留我的編輯',
        useNewer: '使用新結果',
        showFullResult: '顯示完整結果',
        showFullPlan: '顯示完整計畫',
        generationRequested: "已要求產生",
        startsResume: "恢復執行後開始。",
        generateBody: "代理會在此對話中產生新結果。如果有效，執行會繼續，不再詢問。",
        acceptedPaused: "使用此結果後，工作流程仍保持暫停。",
        editResult: "編輯結果",
        generate: "產生結果並繼續",
        discuss: "討論",
        discussBody: "在此步驟的對話中回覆。代理可以在這裡發布更新的結果。",
        proposal: "建議的工作流程",
        planStarted: "此計畫的執行已開始",
        earlierPlanStarted: "先前提案的執行已開始",
        openEarlierPlanRun: "開啟該執行",
        runNewProposal: "執行新提案",
        runPlan: "作為工作流程執行",
        runPlanBody: "開啟建議工作流程的執行審核。啟動時也會接受此計畫。",
        editPlan: "先編輯工作流程",
        editPlanBody: "接受此計畫，然後將建議的工作流程作為未儲存的草稿開啟。",
        editPlanFallback: "接受此計畫，然後開啟以計畫為提示詞的單步驟工作流程。",
        waitingMachine: ({ machine }) => "等待 " + machine,
    },

    tabs: {
        saved: '已儲存',
        runs: '執行紀錄',
        steps: '步驟',
        flow: '流程圖',
        map: '地圖',
        activity: '活動',
    },
    tabsAccessibility: {
        savedRuns: '已儲存的工作流程或執行紀錄',
        stepsFlow: '步驟或流程圖',
        activityFlow: '活動或流程圖',
        runViews: "執行檢視",
    },

    filters: {
        all: '全部',
        active: '進行中',
        needsYou: '需要你處理',
        clear: '清除篩選',
    },

    empty: {
        savedTitle: '還沒有儲存任何工作流程',
        savedBody: '儲存工作流程會留下一份可重複使用的定義，隨時可以執行或排程。',
        runsTitle: '還沒有執行過任何內容',
        runsBody: '不論你是否儲存工作流程，執行紀錄都會顯示在這裡。',
        filteredTitle: '沒有執行紀錄符合這個篩選條件',
        filteredBody: '清除篩選就能看到其餘的執行紀錄。',
        missingTitle: '此工作流程無法使用',
        missingBody: 'Happier 無法開啟此連結指向的工作流程。你的其他工作流程、自動化和執行不受影響。',
        missingDraftTitle: "此未儲存的副本已遺失",
        missingDraftBody: "重新載入會遺失未儲存的副本。請開啟原始工作流程，再次建立副本。",
    },

    loadFailedTitle: '無法載入工作流程',
    loadFailedBody: '你的工作不受影響。準備好之後再試一次。',
    retry: '重試',
    contentUnavailable: '這台裝置無法顯示私密內容。',
    readState: {
        historyTitle: '無法讀取歷史記錄',
        historyBody: '此執行由較早的 Happier 開發版本記錄，因此無法開啟其歷史記錄。請開始新的執行以繼續。',
        encryptionTitle: '需要設定加密',
        encryptionBody: '此內容採用端對端加密。請為此帳戶設定加密後再開啟。',
        keysTitle: '正在等待金鑰',
        keysBody: '這台裝置尚未取得此執行的加密金鑰。金鑰可用後請重試。',
        storageTitle: '執行儲存空間無法使用',
        storageBody: 'Happier 無法存取執行儲存空間。請檢查連線後重試。',
        openSettings: '開啟設定',
    },
    contentReasons: {
        invalidHeader: '此工作流程儲存的資訊無效。',
        revisionMismatch: '此工作流程與儲存的修訂版本不一致。',
        missingBody: '此工作流程儲存的定義遺失。',
        invalidBody: '此工作流程儲存的定義無效。',
        notFound: '此工作流程已無法使用。',
    },

    sessionEntry: {
        missingTitle: '這個工作階段已無法使用',
        missingBody: '它可能已被刪除，或位於另一個 Home。開啟工作階段列表來尋找它。',
        inaccessibleTitle: '你無法開啟這個工作階段',
        inaccessibleBody: 'Happier 無法確認存取權。請重新登入或聯絡擁有者，然後重新開啟此頁面。',
        failedTitle: '無法開啟這個工作階段',
        failedBody: 'Happier 會繼續重試。你也可以現在再試一次。',
        unsupportedTitle: '這個工作階段無法啟動工作流程',
        unsupportedBody: 'Happier 無法讀取它執行所用的代理程式與機器。請改從工作流程頁面建立。',
    },

    editor: {
        namePlaceholder: '工作流程名稱',
        agentRuntime: '智慧代理執行環境',
        firstPromptTitle: '第一步要做什麼？',
        firstPromptBody: '一個提示詞就是一個工作流程。需要時再加入步驟。',
        promptPlaceholder: '描述這個步驟要做什麼',
        useWorkflowDefault: '使用工作流程的預設值',
        defaultsTitle: '預設值',
        produces: '產出',
        whereTitle: '位置',
        add: '新增',
        addAccessibility: '在這個工作流程中新增一個區塊',
        addStep: '代理步驟',
        addParallel: '並排',
        addLoop: '重複',
        addIf: '條件',
        targetRequired: '請為此工作流程選擇機器與專案資料夾。',
        loadingTitle: '正在開啟工作流程…',
        accountChangedTitle: '你已切換帳號',
        accountChangedBody: '此工作流程由上一個帳號開啟，無法沿用。請在「工作流程」中重新開啟。',
        loadFailedTitle: '無法開啟此工作流程',
        loadFailedBody: '目前無法讀取已儲存的工作流程。',
        timeoutTitle: '結果等待時間（毫秒）',
        noDeadline: '無期限',
        timeoutExplain: '等待此步驟結果的毫秒數，超過後將需要關注。留空表示沒有期限。',
        wholeNumberRequired: '請輸入不小於 1 的整數。',
        runNow: '立即執行',
        save: '儲存工作流程',
        saveAutomation: '儲存自動化',
        schedule: '排程',
        savedRevision: ({ revision }) => `已儲存 · ${revision}`,
        moveUp: '上移',
        moveDown: '下移',
        moveIn: '移入上方的群組',
        moveOut: '移出這個群組',
        remove: '移除',
        undo: '復原',
        redo: '重做',
        historyRestoreRequiresSetup: '此事件需要重新設定。刪除後無法還原已儲存的私人設定。',
        history: { edited: '編輯工作流程', agent: '代理修改', description: '編輯描述', where: '變更執行位置', target: '變更步驟執行方式', triggers: '編輯觸發器', example: '插入範例', document: '編輯提示詞', renameWorkflow: '重新命名工作流程', renameStep: '重新命名步驟', renameLane: '重新命名分支' },
        undoAction: ({ change }: { change: string }) => `復原：${change}`,
        redoAction: ({ change }: { change: string }) => `重做：${change}`,
        removedBlock: ({ block }) => `已移除 ${block}`,
        rename: '重新命名',
        stepOrdinal: ({ position }) => `${position}`,
        unnamedStep: ({ position }) => `步驟 ${position}`,
        unnamedParallel: '平行群組',
        unnamedLoop: '迴圈',
        unnamedIf: '條件判斷',
        branch: '分支',
        addBranch: '新增通道',
        ifTrue: '則',
        otherwise: '否則',
        addOtherwise: '新增「否則」分支',
        evaluator: '判斷是否繼續',
        loopBody: '重複這些步驟',
        continuation: '每一輪之後',
    },

    input: {
        label: '輸入',
        result: '結果',
        change: '變更',
        none: '沒有輸入',
        previousResult: ({ block }) => `${block} 的結果`,
        workflowInput: ({ name }) => `工作流程輸入 ${name}`,
        currentItem: '目前的項目',
        iteration: '這一輪',
        unavailable: '這個來源已經無法使用',
        itemField: {
            value: '項目值',
            index: '項目索引（從 0 開始）',
            position: '項目位置（從 1 開始）',
            count: '項目數量',
        },
        iterationField: {
            index: '回合索引（從 0 開始）',
            position: '回合編號（從 1 開始）',
            count: '回合數量',
            stopReason: '停止原因',
        },
        valueKindGroup: '值來源',
        inputNameGroup: '工作流程輸入',
        producerGroup: '來源步驟',
        workspaceFieldGroup: '工作區欄位',
        itemFieldGroup: '項目欄位',
        iterationFieldGroup: '回合欄位',
    },

    inputs: {
        title: '工作流程的輸入',
        addInput: '新增輸入',
        namePlaceholder: '名稱',
        descriptionPlaceholder: '這是用來做什麼的？',
        required: '必填',
        optional: '選填',
        defaultValue: '預設值',
        typeString: '文字',
        typeNumber: '數字',
        typeBoolean: '是或否',
        typeJson: '結構化資料',
        runSheetTitle: '執行這個工作流程',
        runSheetBody: '填入這個工作流程宣告的值，然後執行它。',
        missingRequired: '這個值是必填的。',
        wrongType: ({ type }) => `這個值必須是 ${type}。`,
    },

    finalOutput: {
        title: '最終輸出',
        none: '尚未選擇最終輸出',
        change: '變更',
        clear: '清除選擇',
        fieldPath: '欄位路徑',
        explain: '這個工作流程結束時回傳的內容。',
    },

    conversation: {
        title: '對話',
        sharedRun: '同一個對話',
        branchesShareAndTakeTurns: '分支共用同一個對話，並依序執行。',
        fresh: '各自獨立的對話',
        fromStep: ({ block }) => `繼續 ${block}`,
        existingSession: '一個既有的工作階段',
        existingSessionById: ({ sessionId }) => `工作階段 ${sessionId}`,
        noExistingSessions: '此裝置上沒有可在此繼續的工作階段。',
        chooseExistingSession: '選擇要繼續的工作階段',
        continuingKeepsAgentAndFolder: '繼續時會沿用該對話的代理和資料夾。要使用其他代理或資料夾，需要獨立的對話。',
        waitingForConversation: ({ block }) => `正在等待 ${block} 在這個對話中完成。`,
        branchesUseSeparate: '平行群組中的分支會各自使用獨立的對話。',
    },

    workspace: {
        title: '工作區',
        inherit: '工作流程的工作區',
        projectCheckout: '專案資料夾',
        fromStep: ({ block }) => `繼續使用 ${block} 的工作區`,
        newWorktreeOriginal: '從原始資料夾建立新的工作樹',
        newWorktreeWorkflow: '從工作流程的工作區建立新的工作樹',
        newWorktreeStep: ({ block }) => `從 ${block} 建立新的工作樹`,
        committedOnlyNote: '新的工作樹包含來源資料夾已提交的狀態。已暫存、未提交與未追蹤的變更仍留在來源資料夾。',
        reuseNote: '繼續使用某個工作區時，它會原樣看到其中未提交的檔案。',
        sharedParallelNote: '共用同一個工作區的分支可能會同時寫入。',
        unavailable: ({ block }) => `${block} 的工作區無法使用。`,
        unavailableBody: '把它還原以繼續這次執行，或檢視一次可能重複已完成工作的新執行。',
        unavailableRestoreBody: '還原它即可繼續本次執行，已完成的工作維持不變。',
        unavailableNewRunBody: '它無法還原。確認後開始新的執行會從頭來過，已完成的工作可能會重複。',
        restore: '還原',
        inspect: '檢視',
    },

    condition: {
        onlyWhen: '只在以下情況執行',
        always: '一律',
        stopWhen: '在以下情況停止',
        ifWhen: '在以下情況執行第一個分支',
        addCondition: '新增條件',
        removeCondition: '移除條件',
        allOf: '同時符合以下全部',
        anyOf: '符合以下任一項',
        not: '非',
        exists: '有值',
        operatorEq: '等於',
        operatorNeq: '不等於',
        operatorLt: '小於',
        operatorLte: '不大於',
        operatorGt: '大於',
        operatorGte: '不小於',
        notFirstRound: '不是第一輪',
        trailingCountAtLeast: ({ source, value, count }) => `${source} 連續 ${count} 次為 ${value}`,
        loopRanOutOfRounds: ({ loop }) => `${loop} 已用完回合`,
        loopEnded: ({ loop, outcome }) => `${loop} 已結束：${outcome}`,
        loopStoppedBecause: ({ loop, condition }) => `${loop} 已停止，因為 ${condition}`,
        valuePlaceholder: '值',
        literalPlaceholder: '輸入值',
        skippedReason: ({ block }) => `因為 ${block} 的條件不成立，已略過。`,
    },

    loop: {
        modeTitle: '重複',
        modeCount: '固定的次數',
        modeItems: '每個項目各一次',
        modeUntil: '直到某個結果表示停止',
        modeEvaluate: '直到代理判斷應該停止',
        count: '次數',
        items: '清單',
        sequential: '依序處理項目',
        parallel: '平行處理項目',
        maxConcurrentItems: '同時處理項目的上限',
        maxConcurrentBranches: '同時執行分支的上限',
        noWorkflowLimit: '工作流程未設定上限',
        maxIterations: '輪數上限',
        limitReached: '已達上限',
        historyTitle: '之前的判斷',
        historyNone: '不使用',
        historyLatest: '只用最近一次',
        historyAll: '全部',
        historyExplain: '這裡選的是已儲存的判斷與回饋，而不是完整的紀錄。',
        continuingConversation: '這個評估者會保留先前的對話，並把每一輪新內容接續寫入。',
        emptyListCompletes: '清單是空的時候，一輪都不會執行就直接結束。',
    },

    failurePolicy: {
        title: '當某個步驟失敗時',
        failStop: '失敗時停止這個群組',
        failStopExplain: '這個群組會停止開始新的工作，並請執行中的分支停止，包含彼此獨立的分支。已完成的結果與變更會保留。這不是回復變更。',
        collectOutcomes: '讓獨立的工作跑完',
        collectOutcomesExplain: '正常的分支會跑完自己的整條流程，並收集每一個結果。分支內失敗之後的步驟不會執行。',
    },

    runState: {
        pending: '等待開始',
        queued: '等待開始',
        claimed: '正在開始',
        running: '執行中',
        waiting_for_review: '等待你審查',
        succeeded: '已完成',
        failed: '已失敗',
        cancel_requested: '正在停止',
        cancelled: '已停止',
        pause_requested: '正在暫停',
        paused: '已暫停',
        interrupted: '已中斷',
        expired: '開始前已過期',
        dispatch_failed: '無法開始',
        skipped: '已略過',
        missed: '已錯過',
        outcome_uncertain: '結果不確定',
        completed: '已完成',
        completed_with_failures: '已完成，但有失敗',
    },

    invocationState: {
        pending: '等待中',
        waiting_for_capacity: '等待可用資源',
        admitting: '正在啟動',
        running: '執行中',
        waiting_for_approval: '等待核准',
        waiting_for_review: '等待你審查',
        needs_attention: '需要你處理',
        completed: '已完成',
        failed: '已失敗',
        skipped: '已略過',
        cancel_requested: '正在停止',
        cancelled: '已停止',
        outcome_uncertain: '結果不確定',
        superseded: '已被後一次嘗試取代',
    },

    run: {
        title: '執行',
        frozenVersion: "此執行使用開始時的版本。編輯僅影響未來的執行。",
        selectOccurrence: '選擇步驟',
        openReview: '審核結果',
        open: '開啟執行',
        openExact: ({ title }) => `開啟 ${title} 執行`,
        openExecution: '開啟背景執行',
        loadMore: '載入較早的步驟',
        origin: {
            direct: '直接啟動',
            automation: '依排程啟動',
            fromSession: '來自某個工作階段',
        },
        needsYou: '需要你處理',
        needsYouLoadedCount: '個已載入',
        review: '檢視',
        stop: '停止',
        stopAgain: '再次停止',
        stopping: '正在停止…',
        stopRequested: ({ machine }) => `已要求停止。正在等待 ${machine} 確認。`,
        evidenceStale: '顯示的是最後一次已知的詳情。Happier 無法確認它們是否是最新的。',
        pauseAtBoundary: '在下一個界線暫停',
        pausePending: '完成目前的工作後暫停。',
        paused: '已在最後一個完成的界線暫停。',
        resume: '繼續',
        runAgain: '再次執行這個工作流程',
        retryStep: '重試這個步驟',
        attempt: ({ attempt }) => `第 ${attempt} 次嘗試`,
        untitled: '工作流程執行',
        openResult: '開啟結果',
        inspectSteps: '查看步驟',
        seeFailures: '查看失敗',
        saveAsWorkflow: '儲存為工作流程',
        saveAsNewWorkflow: '儲存為新工作流程',
        showCurrentWork: '顯示目前工作',
        editWorkflow: '編輯工作流程',
        openWorkflow: '開啟工作流程',
        deleteHistory: '刪除執行紀錄',
        deleteHistoryConfirm: '輸入與結果會被刪除。工作區、對話、已儲存的工作流程與自動化都會保留。',
        technicalDetails: '技術細節',
        technical: {
            runId: '執行 ID',
            invocationId: '步驟 ID',
            machine: '機器',
            machineId: '機器 ID',
            revision: '版本',
        },
        usageUnavailable: '用量無法取得',
        startedAt: ({ time }: { time: string }) => `開始於 ${time}`,
        timeRange: ({ start, end }) => `${start} – ${end}`,
        openConversation: '開啟對話',
        openChildRun: '開啟其執行',
        openStepDetails: '開啟詳情',
        outcomeLine: ({ word, sentence }: { word: string; sentence: string }) => `${word} — ${sentence}`,
        attentionReviewRow: ({ step }: { step: string }) => `${step} 正在等待你審閱`,
        attentionWaitRow: ({ step }: { step: string }) => `${step} 正在等你`,
        attentionReviewSentence: ({ step }: { step: string }) => `${step} 正在等待你審閱。`,
        attentionWaitSentence: ({ step }: { step: string }) => `${step} 正在等你。`,
        reviewing: '正在審閱',
        notStarted: '未開始',
        machineUnavailable: ({ machine }) => `這次執行與 ${machine} 失去了聯繫。`,
        machineUnavailableBody: '確認目前狀態後，就會顯示可用的繼續方式。',
        completedCount: ({ count }) => `共完成 ${count} 個步驟。`,
        completedWithFailures: ({ completed, failed }) =>
            `已完成，但有失敗。${completed} 個已完成，${failed} 個未能完成。`,
        approvalWanted: ({ block }) => `${block} 想要執行一個指令。`,
        approvalWantedBody: '檢視之後就能繼續。',
        capacityOccupied: '工作流程中設定的名額已全部占用。',
        openSourceSession: '開啟它來自的工作階段',
        observedActivity: '觀察到的活動',
        observedActivityBody: 'Happier 看得到這個代理的階段與各個代理，但它不是以受管理的工作流程啟動的，因此無法編輯、儲存或重新執行。',
    },

    recovery: {
        title: '檢視復原方式',
        reattach: '重新連接',
        reattachExplain: '觀察已經在執行的工作，不會啟動任何新內容。',
        resumeSameConversation: '繼續',
        resumeSameConversationExplain: ({ block }) => `${block} 可以在同一個對話中繼續。`,
        freshAgent: '換一個全新的代理繼續',
        freshAgentExplain: '這個對話無法繼續。工作區可以交給一個全新的代理使用。',
        uncertainEffects: ({ block }) => `${block} 在回報之前就停止了。它可能已經改動過工作區。`,
        acknowledgeEffects: '我了解先前的變更可能已經發生',
        waitingForStop: '正在等待停止或確認',
        remainingNotStarted: ({ count }) => `還有 ${count} 個相關步驟尚未開始`,
        startReviewedRun: '確認後開始一次新的執行',
        editContinuation: '查看或編輯後續內容',
        continuationPlaceholder: '補充這一步應該有什麼不同',
        useReplacementInput: '替換這一步的輸入',
        repeatedEffectWarning: '已完成的工作可能會重複。原本那次執行會保留自己的紀錄。',
    },

    unavailable: {
        title: '工作流程無法使用',
        body: '此伺服器上的工作流程無法使用，因此無法在這裡建立或執行工作流程。',
        conversion: '這些變更需要工作流程格式，而此伺服器上的工作流程無法使用。請將這個自動化維持為單一提示，或在工作流程可用後再試一次。',
        savedAutomation: '這個自動化以工作流程方式執行。已儲存的步驟維持不變；你仍然可以編輯它的名稱、說明和觸發器。',
    },
    conversion: {
        title: '這些變更需要工作流程格式',
        automationTarget: '工作流程',
        body: '這個自動化目前仍在已儲存的目標上執行單一提示。轉換會保留你的編輯，並讓後續執行以工作流程形式在某一台確定的機器上執行。已經發生的執行不受影響。',
        action: '轉換為工作流程',
        machineRequired: '請選擇後續執行要使用的機器與專案資料夾。',
    },
    save: {
        conflictTitle: '已經儲存了一個較新的版本',
        conflictBody: '你的編輯仍然還在。',
        compare: '比較',
        saveAsCopy: '另存為副本',
        failedTitle: '無法儲存',
        failedBody: '你在本機的工作仍然還在。',
        deleteTitle: '要刪除這個工作流程嗎？',
        deleteBody: '現有的自動化與執行紀錄不受影響，會繼續正常運作。',
        unsupportedAttachment: '儲存這個工作流程之前，請透過持久參照來附加媒體檔案。',
        nameRequired: '儲存之前，請先為這個工作流程命名。',
        runsCurrentDraft: '這次執行使用畫面上目前的工作流程，並不會把它儲存起來。',
    },

    interchange: {
        importTitle: '匯入一個工作流程',
        importBody: '匯入會開啟一份未儲存的草稿供你檢視，不會執行也不會排程任何內容。',
        importIssuesTitle: '檢查這個工作流程',
        importIssuesBody: '使用這個工作流程之前，有些設定需要你處理。',
        openRepairDraft: '開啟修復草稿',
        importFailedTitle: '無法讀取該檔案',
        importFailedInvalidJson: '該檔案不是有效的 JSON。',
        importFailedUnsupportedVersion: '該檔案使用了這個應用程式不支援的工作流程版本。',
        importFailedInvalidDocument: '該檔案不是 Happier 工作流程。',
        exportPrivacyNote: '匯出的檔案包含提示詞與設定，絕不會包含憑證或執行結果。',
    },

    issue: {
        invalid_version: '這個工作流程使用了不支援的版本。',
        unknown_field: '這個區塊有一項設定是這個工作流程不支援的。',
        invalid_id: '這個區塊需要一個有效的識別碼。',
        duplicate_id: '有兩個區塊使用了相同的識別碼。',
        missing_reference: '這個輸入指向一個已經不存在的區塊。',
        invalid_reference_scope: '這個輸入指向一個不會先完成的區塊。',
        invalid_input: '這個值無效。',
        missing_required_input: '缺少一個必填的值。',
        invalid_result_contract: '這個步驟的結果設定無效。',
        invalid_condition: '這個條件無法比較。',
        invalid_repetition: '以目前的設定，這個迴圈無法重複。',
        invalid_max_concurrent: '最大並行數需要不小於 1 的整數，並且只適用於並行工作。',
        unsupported_persisted_attachment: '附加的媒體檔案在儲存前必須有持久參照。',
        conversation_workspace_mismatch: '這個對話和工作區無法一起繼續。',
        target_unavailable: '執行之前，請先為這個工作流程選擇一個代理。',
        emptyPrompt: '寫下這一步要做什麼。',
        emptyWaitPrompt: '寫下你需要在這裡檢查或決定什麼。',
        fieldMissing: ({ field }) => `${field} 為必填。`,
        fieldInvalid: ({ field }) => `${field} 需要有效的值。`,
    },

    problem: {
        title: '操作沒有成功',
        waitingTitle: '暫時還不行',
        subtreeDenied: '代理只能在自己的工作階段或由其領導的工作階段中啟動工作。',
        roleTargetUnavailable: '此角色無法在這裡使用。',
        roleRunsAsMismatch: '此角色的執行方式不適用於這一步。請選擇其他角色或變更這一步的執行方式。',
        policyDeniedField: '你的代理設定不允許代理啟動的工作使用所要求的設定。',
        permissionExceedsCeiling: '這需要的權限超過了啟動它的代理所擁有的權限。',
        workDepthExceeded: '這會超過你的委派深度上限。請在此工作階段中完成，或前往設定 › 委派提高上限。',
        definitionExceedsAuthority: '代理無法儲存能力超出其自身可啟動範圍的工作流程。',
        sourceUnavailable: '此工作流程無法使用，因此其觸發器無法執行。',
        legacyConversionUnsupported: '暫時無法在這裡變更此自動化。它會繼續按原樣執行。',
        nativeGoalOwner: '此工作階段中的代理已經在自主推進目標。',
        sessionAlreadyStarted: '此工作階段已經開始。工作階段開始觸發器只能在建立工作階段時新增。',
        generic: 'Happier 無法完成該工作流程請求。你的工作沒有受到影響。',
        needsRepair: '這個工作流程有一些設定需要先修正才能執行。',
        targetUnavailable: '這個工作流程需要的機器或代理目前無法使用。',
        notFound: '該執行已不存在。',
        accessDenied: '你沒有存取該執行的權限。',
        conflict: '它在別處被改動過。重新整理以查看目前版本；你的本機修改會保留。',
        inputTooLarge: '該輸入太大，無法送出。沒有做任何變更。',
        unresolvedOutcome: 'Happier 還無法確認先前的工作已經停止，因此不能取代它。',
        interactionCapacity: '該對話等待處理的內容太多，現在無法再接受更多。',
        conversationUnavailable: '該對話無法繼續。',
        workspaceRestore: '無法還原工作區。沒有做任何變更。',
        waitSelfDependency: '這會讓工作流程等待啟動它的那個對話。',
        updateRequired: '執行它的機器需要更新版的 Happier 才能接受這一步。',
        ineligible: '該執行已經往下走了，所以這一步不再可行。',
        custodyPending: 'Happier 仍在等待該機器確認。',
        runFinished: '該執行已結束。',
        checkpointUnavailable: '沒有可供繼續的儲存點。',
        recoveryEvidenceRequired: '開啟該執行即可查看復原選項。',
        executionNotStarted: '還沒有任何步驟開始。',
        custodySettled: '該執行已經結清。',
        unavailableHere: '目前無法使用。',
    },

    a11y: {
        blockList: '工作流程的區塊',
        stepContext: ({ block, position, total }) => `${block}，第 ${position} 個步驟，共 ${total} 個`,
        groupContext: ({ group, block }) => `${block}，位於 ${group} 內`,
        inherited: '使用工作流程的設定',
        overridden: '為這個步驟另外設定',
        inserted: ({ block, position, total }) =>
            `已新增 ${block}，位置為第 ${position} 個，共 ${total} 個`,
        removed: ({ block, total }) => `已移除 ${block}。還剩 ${total} 個區塊`,
        reordered: ({ block, position, total }) =>
            `已把 ${block} 移到第 ${position} 個，共 ${total} 個`,
        validation: ({ reason }) => reason,
        validationInBlock: ({ block, reason }) => `${block}：${reason}`,
        needsYou: ({ count }) => `有 ${count} 個步驟需要你處理`,
        needsYouLoaded: '個已載入',
        terminal: ({ state }) => state,
        terminalWithAttention: ({ state, count }) => `${state}。有 ${count} 個步驟需要你處理`,
        selectedRowUpdated: ({ block }) => `${block} 已更新`,
        progress: ({ count }) => `已更新 ${count} 個步驟`,
        progressLoaded: ({ count }) => `截至目前已更新 ${count} 個步驟`,
        progressWithAttention: ({ count, attention }) =>
            `已更新 ${count} 個步驟，其中 ${attention} 個需要你處理`,
        flowNode: ({ node, state }) => `${node}，${state}`,
        editStep: '編輯步驟',
        editBlock: '編輯區塊',
        commandRefused: ({ reason }) => `暫時無法執行。${reason}`,
    },
});

const workflowTranslations = { zhHant } as const;

return { workflowTranslations };
})();

const Domain_workspaceBarTranslations = (() => {
type WorkspaceBarTranslation = Shared_workspaceBarTranslations.WorkspaceBarTranslation;

const en = Shared_workspaceBarTranslations.en;

const workspaceBarTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', WorkspaceBarTranslation>>, "zh-Hant"> = { 'zh-Hant': { workspaceBar: { tabsLabel: '開啟的分頁', tabMenuLabel: '分頁選項', pinTab: '釘選分頁', unpinTab: '取消釘選分頁', splitRight: '向右分割', splitDown: '向下分割', maximizePane: '最大化窗格', restorePane: '還原窗格', closeTab: '關閉分頁', closeOtherTabs: '關閉其他分頁', closeTabsToRight: '關閉右側分頁', moreTabs: ({ count }) => `另外 ${count} 個分頁`, searchTabs: '搜尋分頁', splitPane: '分割目前的窗格', openInNewTab: '在新分頁中開啟', openToRight: '在右側開啟', openBelow: '在下方開啟', newTab: '新分頁' } } };

return { workspaceBarTranslations };
})();

const Domain_workspaceSyncDiagnosticTranslations = (() => {
type WorkspaceSyncDiagnosticTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncDiagnosticTranslation;

type WorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslation;

type WorkspaceSyncLocale = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncLocale;

type WorkspaceSyncTranslationCore = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslationCore;

type WorkspaceSyncReviewBase = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncReviewBase;

const completeWorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.completeWorkspaceSyncTranslation;

const workspaceSyncDiagnosticTranslations = { 'zh-Hant': {
        diagnostics: { title: '診斷', relationshipId: '關係 ID', controllerMachineId: '控制電腦 ID', alphaMachineId: '來源電腦 ID', betaMachineId: '目標電腦 ID', alphaRoot: '目前來源資料夾', betaRoot: '目前目標資料夾', engineMode: '引擎模式', engineState: '引擎狀態', errorCode: '錯誤代碼' },
        error: { updateRequired: '請先更新來源電腦上的 Happier，再重試此工作區移交。其他工作階段和電腦操作仍可使用。' },
        resolve: { title: '解決工作區衝突？', body: ({ path, side }) => `保留資料夾 ${path} 的「${side}」版本？驗證目前狀態後，另一個資料夾及其中獨有的所有內容都將被移除。`, unverifiedFile: '無法安全移除沒有目前檔案指紋的版本。請重新整理衝突後再試一次。' },
    } } as const satisfies Pick<Record<string, WorkspaceSyncDiagnosticTranslation>, "zh-Hant">;

const workspaceSyncSetAttentionTranslations = { 'zh-Hant': { attention: { conflictedLinks: ({ count }) => `${count} 條連結有衝突`, unavailableLinks: ({ count }) => `${count} 條連結需要檢查狀態` } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'attention'>>, "zh-Hant">;

const workspaceSyncAddMachineTranslations = { 'zh-Hant': { availableOn: '可用於', addMachine: { replica: '副本', exactReplica: '精確副本', editableCopy: '可編輯副本', editableCopyHint: '已連結電腦上的變更可能會被其他電腦上的代理程式看見。衝突版本需要審查。如果需要隔離，請使用個別工作樹。' } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'availableOn' | 'addMachine'>>, "zh-Hant">;

const workspaceSyncReviewOutcomeTranslations = { 'zh-Hant': { keepBoth: '保留兩個版本', preserveAt: ({ path }) => `在 ${path} 保留另一版本`, notReviewed: '未檢查；此處不會變更', confirmScope: '只會變更列出的已檢查工作區。無法使用的工作區保持不變。', preserved: '已保留', alreadyPresent: '已存在', notStarted: '未開始', askAgent: '詢問代理程式', askAgentPrompt: ({ path, versions }) => `請幫我檢查這些已連結工作區中 ${path} 的衝突版本：\n${versions}\n請檢查目前檔案並提出安全的解決建議。未經我核准，不要變更或解決衝突。` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'keepBoth' | 'preserveAt' | 'notReviewed' | 'confirmScope' | 'preserved' | 'alreadyPresent' | 'notStarted' | 'askAgent' | 'askAgentPrompt'>>, "zh-Hant">;

const workspaceSyncCoverageIncompleteTranslations = { 'zh-Hant': '部分連結或端點尚未檢查。已載入的衝突仍可檢視；只能解決明確檢查過且可用的版本。' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['coverageIncomplete']>, "zh-Hant">;

const workspaceSyncReviewLifecycleTranslations = { 'zh-Hant': { requestingApproval: '正在請求核准…', applying: '正在套用已檢查的變更…', propagationExpected: ({ names }) => `預計傳播至 ${names}`, propagationUnverified: ({ names }) => `尚無法驗證是否傳播至 ${names}` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'requestingApproval' | 'applying' | 'propagationExpected' | 'propagationUnverified'>>, "zh-Hant">;

const workspaceSyncLocalOnlyTranslations = { 'zh-Hant': '此替代位置僅保留在其工作區中' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['localOnly']>, "zh-Hant">;

const workspaceSyncKeepAlternativesTranslations = { 'zh-Hant': '保留其他版本' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['keepAlternatives']>, "zh-Hant">;

const workspaceSyncReviewDecisionTranslations = { 'zh-Hant': { chooseTargets: '選擇要替換的工作區', notSelected: '未選入本次衝突解決', inspectCurrentVersions: '檢查目前版本' } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'chooseTargets' | 'notSelected' | 'inspectCurrentVersions'>>, "zh-Hant">;

const workspaceSyncReviewTranslations: Pick<Record<WorkspaceSyncLocale, WorkspaceSyncReviewBase>, "zh-Hant"> = { 'zh-Hant': {
        executable: '可執行', regular: '不可執行', applied: '已套用', appliedPaused: '已套用；同步已暫停', changed: '套用前已變更', offline: '離線；未套用', cancelled: '已取消', unknown: '結果未知；請檢查此端點', failed: '失敗；未套用', recoveryNeeded: '此位置需要復原', inspectionUnavailable: '無法檢查目前版本。控制電腦可用後請重新整理。', coverageIncomplete: '部分連結或端點尚未檢查。已載入的衝突仍可檢視，但暫時無法解決。', versions: '版本', comparison: '比較所選版本', linkDecisions: '連結選取結果', result: '處理結果', confirmTitle: '使用此版本？', confirmBody: ({ path, source, count }) => `要在其他 ${count} 個工作區使用 ${source} 的 ${path} 版本嗎？Happier 會在變更前驗證所有版本。`, useVersion: '使用版本', useNamedVersion: ({ name }) => `使用 ${name}`, compareNamedVersion: ({ name }) => `比較 ${name}`, linkCount: ({ count }) => `${count} 條連結回報了此路徑`, moreOnLink: ({ name }) => `載入 ${name} 的更多項目`,
    } };

const workspaceSyncReviewSelectionTranslations = { 'zh-Hant': { selectionIncluded: '此連結包含', selectionExcluded: '此連結排除', selectionUnknown: '選取結果未知', reasonRepositoryMetadata: '儲存庫中繼資料', reasonSubmodule: 'Git 子模組', reasonConfiguredRule: '已設定規則', reasonGitIgnore: 'Git 忽略規則', reasonEndpointUnavailable: '端點無法使用', reasonSelectionUnavailable: '選取評估器無法使用', configuredInclude: ({ pattern }) => `包含樣式：${pattern}`, configuredExclude: ({ pattern }) => `排除樣式：${pattern}`, completedLinks: ({ count }) => `阻塞前已完成 ${count} 條連結` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'selectionIncluded' | 'selectionExcluded' | 'selectionUnknown' | 'reasonRepositoryMetadata' | 'reasonSubmodule' | 'reasonConfiguredRule' | 'reasonGitIgnore' | 'reasonEndpointUnavailable' | 'reasonSelectionUnavailable' | 'configuredInclude' | 'configuredExclude' | 'completedLinks'>>, "zh-Hant">;

const zhHant = completeWorkspaceSyncTranslation({
    diagnostic: workspaceSyncDiagnosticTranslations["zh-Hant"],
    review: workspaceSyncReviewTranslations["zh-Hant"],
    selection: workspaceSyncReviewSelectionTranslations["zh-Hant"],
    outcome: workspaceSyncReviewOutcomeTranslations["zh-Hant"],
    lifecycle: workspaceSyncReviewLifecycleTranslations["zh-Hant"],
    decision: workspaceSyncReviewDecisionTranslations["zh-Hant"],
    coverage: workspaceSyncCoverageIncompleteTranslations["zh-Hant"],
    localOnly: workspaceSyncLocalOnlyTranslations["zh-Hant"],
    alternatives: workspaceSyncKeepAlternativesTranslations["zh-Hant"],
    addMachine: workspaceSyncAddMachineTranslations["zh-Hant"],
    attention: workspaceSyncSetAttentionTranslations["zh-Hant"],
}, {
    title: '工作區同步', footer: '狀態來自管理此關係的電腦。只有該電腦確認後，才會顯示變更。',
    legacyRecovery: {
        title: '已停用的工作區同步資料', footer: 'Happier 只會檢查並隔離這些已停用的資料，絕不會在應用程式中刪除它們。', checking: '正在檢查電腦…',
        inspectFailed: '無法檢查部分電腦。之前找到的隔離資料夾仍會顯示；請在這些電腦可連線時重試。',
        outdatedTitle: ({ machine }) => `${machine} 正在執行舊版 Happier`, outdatedBody: '該版本無法檢查已停用的工作區同步資料。請更新該電腦上的 Happier，然後在此重新檢查。',
        explanation: '此電腦包含已停用的工作區複製引擎資料。Happier 已將辨識到的資料移入私人隔離區，並停用工作區同步，以防止舊引擎執行。',
        quarantinePath: '隔離資料夾', openFolder: '開啟資料夾', offlineTitle: '在 Happier 離線時移除',
        offlineSteps: ({ path }) => `1. 停止所有可能使用這些資料的 Happier 背景服務。\n2. 使用作業系統僅移除這個資料夾：${path}\n3. 重新啟動服務，然後在此重新檢查。`,
        unknown: ({ path, reason }) => `Happier 無法安全辨識 ${path} 中的舊狀態（${reason}）。工作區同步仍處於停用狀態。請手動檢查此路徑，不要在應用程式中刪除它。`, reinspect: '重新檢查',
    },
    none: '沒有工作區同步關係', conflictsTitle: '工作區衝突', openConflicts: ({ count }) => `檢查 ${count} 條連結的工作區同步`, noConflicts: '沒有衝突',
    previewUnavailable: '控制電腦無法提供安全預覽。請先重新整理衝突，再重試。', truncated: ({ count }) => `還有 ${count} 個衝突未顯示`, unknownMode: '不支援的同步模式', conflictCount: ({ count }) => `${count} 個衝突`,
    conflictKind: { file: '檔案', directory: '資料夾', symlink: '符號連結', missing: '缺少', unsupported: '不支援的項目' },
    mode: { copyOnce: '複製一次', keepSynced: '保持最新 — 建議', mirrorExactly: '精確鏡像', keepBothInSync: '保持兩端同步' },
    state: { loading: '正在檢查狀態…', starting: '正在準備', watching: '正在監視', flushing: '正在同步', paused: '已暫停', peerOffline: '離線', conflicted: '存在衝突', controllerUnavailable: '需要處理', engineUnavailable: '元件無法使用', error: '需要處理', stopped: '已停止', working: '正在處理…' },
    lastChecked: ({ at }) => `上次檢查：${at}`, endpoint: { source: ({ label }) => `來源 · ${label}`, destination: ({ label }) => `目標 · ${label}`, synced: ({ label }) => `同步端點 · ${label}` },
    error: { componentUnavailable: '此版本無法使用工作區同步。請安裝所需元件後重試。', machineOffline: '目標電腦無法使用。請重新連線後重試。', destinationNeedsPreparation: '開始同步前需要準備目標資料夾。', gitPreparationFailed: 'Happier 無法準備此 Git 工作區。請檢查目標位置後重試。', authorizationExpired: '工作區授權已過期。請重新開始操作。', rootNoLongerAuthorized: '工作區資料夾已變更，不再獲得授權。請先檢查同步關係，再重試。', conflictNeedsAttention: '此衝突已變更。請先重新整理，再選擇版本。', needsAttention: '工作區同步需要處理。請重新整理狀態後重試。' },
    start: { blocked: { targetMachine: '請選擇目標電腦以繼續。', targetMachineOffline: '該電腦目前無法使用。請重新連線後重試。', relationshipUnavailable: '此同步關係已不再涵蓋這兩個資料夾。請選擇其他工作區選項。', sourceFolder: '無法安全同步此工作階段的資料夾。請選擇「不要移動檔案」以僅移交工作階段。', destinationFolder: '請選擇有效的目標資料夾。', workspaceOptions: '開始前請檢查工作區選項。' } },
    engine: { checking: '正在檢查此電腦上的工作區同步…' },
    actions: { refresh: '重新整理狀態', syncNow: '立即同步', more: '工作區同步操作', pause: '暫停', resume: '繼續', terminate: '停止同步', openOnMachine: ({ machine }) => `在 ${machine} 上開啟`, openFolder: ({ label }) => `開啟 ${label} 資料夾`, keepLocal: '保留本機版本', keepRemote: '保留遠端版本', keepNamed: ({ side }) => `保留 ${side} 的版本` },
    terminate: { title: '移除工作區同步？', body: '同步將停止，相關關係也會被移除。兩個工作區中的檔案都會保留。' },
    resolve: { changedTitle: '衝突已變更', changedBody: '此衝突自開啟後已發生變更。清單已重新整理。請先檢查最新版本，再次選擇。', consequence: '只有 Happier 確認檔案未變更後，才會移除另一個版本。', unsupported: '此衝突包含不支援的檔案系統項目，無法在 Happier 中解決。請在受影響的電腦上移除或替換它，然後重新整理。', keepHint: ({ side }) => `保留 ${side} 的版本，並移除另一個已驗證的版本。` },
    fileState: { text: '文字預覽', binary: '二進位檔案 — 無法預覽', tooLarge: '檔案太大，無法預覽', missing: '缺少檔案', changed: '列出此衝突後檔案已變更' },
});

const workspaceSyncTranslations = { 'zh-Hant': zhHant } as const satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation>, "zh-Hant">;

return { workspaceSyncDiagnosticTranslations, workspaceSyncSetAttentionTranslations, workspaceSyncAddMachineTranslations, workspaceSyncReviewOutcomeTranslations, workspaceSyncCoverageIncompleteTranslations, workspaceSyncReviewLifecycleTranslations, workspaceSyncLocalOnlyTranslations, workspaceSyncKeepAlternativesTranslations, workspaceSyncReviewDecisionTranslations, workspaceSyncReviewTranslations, workspaceSyncReviewSelectionTranslations, workspaceSyncTranslations };
})();

const Domain_workspaceTabTranslations = (() => {
const en = Shared_workspaceTabTranslations.en;

const workspaceTabKeyboardTranslations = Shared_workspaceTabTranslations.workspaceTabKeyboardTranslations;

const workspaceTabTranslations = { 'zh-Hant': en };

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
