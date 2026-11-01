// Locale-owned feature copy; each domain retains its own initialization scope.
import { discussionQuoteCopy } from '../discussionQuoteTranslations.shared';
import { discussionControlsCopy } from '../discussionControlsTranslations.shared';
import { discussionAttributionCopy, sessionReadinessCopy } from '../sessionReadinessTranslations.shared';
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
import * as Shared_fileViewerTranslations from '../fileViewerTranslations.shared';
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

const accountDisplayTranslations = { ja: { unnamed: '名前のないアカウント', yours: 'あなたのアカウント', shortId: ({ id }) => `ID …${id}` } } as const satisfies Pick<Record<string, AccountDisplayTranslation>, "ja">;

return { accountDisplayTranslations };
})();

const Domain_accountEncryptionRecoveryTranslations = (() => {
type Copy = Shared_accountEncryptionRecoveryTranslations.Copy;

const en = Shared_accountEncryptionRecoveryTranslations.en;

const ja: Copy = {
    recoverAutomationTemplates: '以前のトリガーを復元',
    recoverAutomationTemplatesDescription: 'この端末の鍵で以前のトリガーを復元します。暗号化されたセッションやロックされたトリガーに必要な鍵は保持します。',
    recoverAutomationTemplatesAction: '復元',
    recoverAutomationTemplatesComplete: 'トリガーを復元しました。古い鍵は、削除を選ぶまでこの端末に保持されます。',
    recoverAutomationTemplatesRetained: '復元を確認しました。一部のトリガーは暗号化・ロック・変更されたままです。古い鍵はこの端末に保持されます。',
    forgetEncryptionKey: '古い暗号化キーを削除',
    forgetEncryptionKeyDescription: 'この端末では古い暗号化セッションがロックされます。',
    forgetEncryptionKeyAction: '削除',
    forgetEncryptionKeyConfirm: '古い暗号化キーを削除しますか？',
    forgetEncryptionKeyWarning: ({ items }) => `この端末では古い暗号化セッションがロックされます。次の暗号化された履歴にアクセスできなくなる可能性があります：\n\n${items}\n\nこの一覧は現在の履歴です。この確認後に別の端末で作成された暗号化セッションもロックされます。古い鍵を復元すると解除できます。アカウントからデータは削除されません。`,
    forgetEncryptionKeySession: ({ name, id }) => `セッション：${name} (${id})`,
    forgetEncryptionKeyTrigger: ({ id }) => `トリガー：${id}`,
    forgetEncryptionKeyRun: ({ id }) => `実行履歴：${id}`,
    forgetEncryptionKeyEmpty: '暗号化された履歴は見つかりませんでした。',
    forgetEncryptionKeyComplete: 'この端末から古い鍵を削除しました。',
    forgetEncryptionKeyFailed: '鍵を削除できませんでした。再接続してやり直してください。先に暗号化された履歴の一覧を取得する必要があります。',
};

const accountEncryptionRecoveryTranslations = { ja } as const;

return { accountEncryptionRecoveryTranslations };
})();

const Domain_accountPopoverTranslations = (() => {
type AccountPopoverTranslation = Shared_accountPopoverTranslations.AccountPopoverTranslation;

const accountPopoverTranslations = { ja: {
        pageTitle: 'アカウントと Home',
        homesTitle: 'Home',
        notLinkedTo: ({ service }) => `${service} にリンクされていません`,
        serviceUnavailable: ({ service }) => `${service} に接続できません`,
        signedInToThisHome: 'この Home にサインイン済み',
        checkingSignIn: 'サインインを確認中…',
        signInStatusUnavailable: 'サインイン状態を取得できません',
        machinesOnline: ({ online, total }) => `${total} 台中 ${online} 台のマシンがオンライン`,
        noMachines: 'まだマシンがありません',
        connectedNoMachinesOnline: '接続済み · オンラインのマシンなし',
        cantReach: '接続できません',
        signedOut: 'サインアウト済み',
        signIn: 'サインイン',
        link: 'リンク',
        linkSubtitle: 'どのデバイスからでも Home を見つけられます',
        manageHomes: 'Home を管理',
        connectionDetails: '接続の詳細',
        allHomes: 'すべての Home',
        allHomesSubtitle: ({ count }) => `${count} 件の Home · 1 つのリスト`,
        addHome: 'Home を追加…',
        addDevice: 'デバイスを追加',
    } } as const satisfies Pick<Record<string, AccountPopoverTranslation>, "ja">;

return { accountPopoverTranslations };
})();

const Domain_accountServiceOAuthTranslations = (() => {
const en = Shared_accountServiceOAuthTranslations.en;

const ja = {
    title: 'サインインして Home を見つける',
    cancelNote: 'キャンセルしても既存の Home からはサインアウトされません。', focusedHomePreserved: '現在の Home は変更されません。',
    stages: { signingIn: 'サインイン中', findingHomes: 'Home を検索中', waitingApproval: 'Home の承認を待っています' },
    errors: { provider: { title: 'プロバイダーがサインインを完了しませんでした', body: 'もう一度サインインしてください。' }, expired: { title: 'このサインイン要求は期限切れです', body: 'もう一度サインインしてください。' }, identityChanged: { title: 'サインインサービスの識別情報が変更されました', body: '再接続する前に、使うつもりのサインインサービスであることを確認してください。' }, unavailable: { title: 'サインインサービスを利用できません', body: 'サービスを確認して再試行してください。既存の Home は変更されません。' }, exchange: { title: 'サインインを完了できませんでした', body: 'サインインサービスの認証情報は保存されていません。もう一度サインインしてください。' }, storage: { title: 'サインインを保存できませんでした', body: '既存の Home の認証情報は変更されません。もう一度サインインしてください。' }, homeLink: { title: 'サインインしましたが、この Home をリンクできませんでした', body: 'サインインは保存されています。この Home のリンクをもう一度お試しください。' }, directoryRefresh: { title: 'サインインしましたが、Home 一覧を更新できませんでした', body: 'サインインサービスへの接続は完了しています。Home 一覧の更新をもう一度お試しください。' }, homeEnrollment: { title: 'サインインしましたが、パーソナル Home は追加されませんでした', body: 'サインインは保存されています。Home の追加をもう一度お試しください。' }, invalid: { title: 'このサインイン要求は無効です', body: 'もう一度サインインしてください。' }, accountDisabled: { title: 'このアカウントは無効化されています', body: 'サインインサービスの管理者に連絡してください。既存の Home は変更されません。' } },
    actions: { startAgain: 'やり直す', openHome: ({ homeName }: { homeName: string }) => `${homeName} を開く` },
    success: { title: ({ homeName }: { homeName: string }) => `${homeName} に接続しました`, body: 'サインイン情報が保存され、この Home を使用できるようになりました。' },
    notLinked: { title: ({ homeName }: { homeName: string }) => `${homeName} はまだこのアカウントにリンクされていません`, signInAction: ({ homeName }: { homeName: string }) => `${homeName} にサインイン`, body: ({ homeName }: { homeName: string }) => `${homeName} に直接サインインするか、その QR コードをスキャンするか Home リンクを貼り付けてください。`, scanBody: ({ homeName }: { homeName: string }) => `${homeName} の QR コードをスキャンするか Home リンクを貼り付けて接続してください。` },
    noHomes: { body: 'このアカウントにはまだ Home がありません。別の場所で追加してから更新するか、Home の QR コードをスキャンするか Home リンクを貼り付けてください。' },
    approvalWait: { waitingBody: 'サインイン済みの別のデバイスでこのサインインを承認してください。', cancelledTitle: '承認の待機を終了しました', cancelledBody: 'サインインは保存されたままで、既存の Home は変更されません。' },
} as const;

const accountServiceOAuthTranslations = { ja } as const;

return { accountServiceOAuthTranslations };
})();

const Domain_actionConfirmationTranslations = (() => {
type ActionConfirmationTranslations = Shared_actionConfirmationTranslations.ActionConfirmationTranslations;

const actionConfirmationTranslations = { ja: {
        requestedByAgent: 'セッションのエージェントが要求したアクション',
        homeTarget: ({ serverId }) => `Home: ${serverId}`,
        sessionTarget: ({ sessionId }) => `対象セッション: ${sessionId}`,
        oneShotConsequence: '承認はこのリクエストにのみ適用されます。今後の Action 権限やネイティブ権限は付与されません。',
        homeUnavailable: 'この承認は、このデバイスでは利用できない Home に属しています。判断するには、その Home を再接続してください。',
        turnedOffTitle: 'アクションはオフです',
        turnedOffMessage: 'このアクションはオフになっているため、何も変更されませんでした。設定 → アクションで再びオンにできます。',
        turnedOffReadMessage: 'このアクションはオフになっているため、何も読み込まれませんでした。設定 → アクションで再びオンにできます。',
        openActionSettings: 'アクションの設定を開く',
    } } as const satisfies Pick<Record<string, ActionConfirmationTranslations>, "ja">;

return { actionConfirmationTranslations };
})();

const Domain_fileContentSearchTranslations = (() => {
const fileContentSearchTranslations = { "ja": {
        allMatches: ({ matches, files }: { matches: number; files: number }) => `${files} 個のファイル内の全 ${matches} 件の一致`,
        moreMatches: "すべての一致",
        searchInFolder: ({ name }: { name: string }) => `${name} 内を検索`,
        matchesInFiles: ({ matches, files }: { matches: number; files: number }) => `${files} 個のファイル内の ${matches} 件の一致`,
        textInFiles: "ファイル内のテキスト",
        textInScope: ({ scope }: { scope: string }) => `${scope} 内のテキスト`,
        atLine: ({ line }: { line: number }) => `${line} 行目`,
        everything: "すべてを検索",
        refineSearch: "検索を絞り込んでください",
        partial: "一部のファイルを検索できませんでした。結果は不完全です。",
        updateRequired: "ファイル内のテキストを検索するには、このマシンの Happier を更新してください。",
        invalidPattern: "正規表現が無効です。パターンを編集して再試行してください。",
        unavailable: "テキスト検索を利用できません。マシンの接続を確認してください。",
        placeholder: "ファイル、メッセージ、コミット、セッション、設定、アクションを検索",
        matchCase: "大文字と小文字を区別",
        regex: "正規表現",
    } };

return { fileContentSearchTranslations };
})();

const Domain_promptPickerTranslations = (() => {
const promptPickerTranslations = { "ja": {
        "partialHistory": "送信履歴の対象は既知のセッションのみです。",
        "loadedHistory": "送信履歴には読み込み済みのメッセージのみ表示されます。",
        "open": "プロンプトを開く",
        "menu": "プロンプト…",
        "placeholder": "プロンプトと送信済みメッセージを検索",
        "favorites": "お気に入り",
        "library": "ライブラリ",
        "sentBefore": "送信履歴",
        "builtIn": "組み込み",
        "readError": "このプロンプトを読み込めませんでした。再試行してください。",
        "libraryError": "ライブラリを読み込めませんでした。",
        "partialLibrary": "一部のプロンプトを読み込めませんでした。",
        "loadOlder": "古いメッセージを検索",
        "stop": "停止",
        "insert": "挿入",
        "send": "今すぐ送信",
        "addFavorite": "お気に入りに追加",
        "removeFavorite": "お気に入りから削除",
        "empty": "メッセージをプロンプトとして保存して、ここで再利用できます。",
        "applyError": "プロンプトを適用できませんでした。再試行してください。",
        "historyError": "古いメッセージを読み込めませんでした。再試行してください。",
        "title": "プロンプト",
        "clear": "クリア",
        "favorite": "お気に入り",
        "favoritesInvite": "プロンプトや送信したメッセージにスターを付けるとここに表示されます。",
        "loadingLibrary": "プロンプトを読み込んでいます…",
        "saveAsFavorite": "お気に入りのプロンプトとして保存",
        "saveInPlaceStarred": ({ time }: { time: string }) => `${time}のメッセージから · スター付きでライブラリへ`,
        "saveInPlace": ({ time }: { time: string }) => `${time}のメッセージから · ライブラリへ`,
        "noMatchesFor": ({ query }: { query: string }) => `「${query}」に一致するプロンプトや読み込み済みメッセージはありません`,
        "previewInserts": "挿入してから送信",
        "previewSent": "以前に送信",
        "previewEdited": ({ time }: { time: string }) => `${time}に編集`,
        "searchingOlder": ({ searched, total }: { searched: number; total: number }) => `以前のメッセージを検索中… ${total} 件中 ${searched} 件のセッション`
    } } as const;

return { promptPickerTranslations };
})();

const Domain_actionFamilyTranslations = (() => {
const fileContentSearchTranslations = {...Domain_fileContentSearchTranslations.fileContentSearchTranslations, ...EnglishFeatures.fileContentSearchTranslations.fileContentSearchTranslations};

const promptPickerTranslations = {...Domain_promptPickerTranslations.promptPickerTranslations, ...EnglishFeatures.promptPickerTranslations.promptPickerTranslations};

const surfaceFamilyLabels = Shared_actionFamilyTranslations.surfaceFamilyLabels;

const english = Shared_actionFamilyTranslations.english;

const translated = Shared_actionFamilyTranslations.translated;

const actionFamilyTranslations = { ja: translated({
        actionFamilies: {
            plugin_execution_origin: "プラグインの実行",
            usage: "使用状況",
            project_sources: "プロジェクトのソース",
            project_execution: "プロジェクトのスクリプト",
            project_definitions: "プロジェクト設定",
            account_profile: "アカウントプロフィール",
            project_workers: "プロジェクトワーカー",
            operation_output: "操作の出力",
            workflow_event_catalog: "ワークフローイベント",
            filesystem: "ファイル",
            diagnostics: "診断",
            usage_sources: "使用状況の取得元",
            mcp_servers: "MCPサーバー",
            providers: "モデルプロバイダー",
            model_preferences: "モデル設定",
            remote_hosts: "リモートホスト",
            home_runtime: "Homeのサービス",
            account_lifecycle: "アカウント管理",
            artifact_folders: "アーティファクトフォルダー",
            workflow_diagnostics: "ワークフロー診断",
            session_authoring: "セッションの下書き",
            updates: "更新",
            clipboard: "クリップボード",
            machine_access: "マシンへのアクセス",
            machine_work_summary: "マシン上の作業",
            machine_vitals: "マシンの状態",
            machine_processes: "マシンのプロセス",
            machine_storage: "マシンのストレージ",
            machine_resources: "マシンのリソース",
            machine_guard: "マシンの保護",
            account_home_continuation: "アカウントアクセスの復旧",
            bug_report_submission: "不具合報告",
            managed_machines: "管理対象マシン",
            machine_presets: "マシン環境",
            home_identity: "Homeの識別情報",
            ...surfaceFamilyLabels,
            workspace_file_search: fileContentSearchTranslations.ja.textInFiles,
            find: '検索',
            app_shell: 'Workspace',
            roles: 'ロール',
            launch_profiles: '起動プロファイル',
            discovery: 'アクションの検出',
            computer: 'コンピューター操作',
            artifact_access: 'アーティファクト共有',
            workflows: 'ワークフロー',
            workflow_effects: 'Webhook とコマンド',
            notifications: '通知',
            machine_agent_install: 'エージェントのインストール',
            machine_agent_sign_in: 'エージェントのサインイン',
            session_access: 'セッションの共有',
            session_lifecycle: 'セッションのライフサイクル',
            inventory: 'マシンのインベントリ',
            messaging: 'メッセージ',
            session_control: 'セッションの操作',
            session_capabilities: 'セッションの機能',
            intent_start: 'レビューと委任',
            review_comments: 'レビューコメント',
            subagent_registry: 'サブエージェント',
            execution_run_control: 'バックグラウンド実行',
            session_targeting: 'セッションの指定',
            session_follow: 'セッションのフォロー',
            session_transcripts: 'セッションのトランスクリプト',
            session_read_state: '既読状態',
            session_attention: '要対応',
            session_board: 'セッションボード',
            discussion: 'ディスカッション',
            session_permissions: 'セッションの権限',
            external_sessions: '外部セッション',
            voice_controls: '音声操作',
            current_ui_context: '現在の画面',
            companion_controls: 'コンパニオン',
            memory: 'メモリ',
            agent_acp_catalog: 'ACP エージェント',
            prompt_library: 'プロンプトライブラリ',
            skills: 'スキル',
            registries: 'レジストリ',
            daemon_admin: 'デーモンの管理',
            browser_control: 'ブラウザーの操作',
            browser_diagnostics: 'ブラウザーの診断',
            browser_context: 'ブラウザーのコンテキスト',
            browser_automation: 'ブラウザーの自動化',
            browser_recording: 'ブラウザーの録画',
            local_services_inventory: 'ローカルサービス',
            local_services_launcher: 'サービスランチャー',
            local_services_preview: 'サービスのプレビュー',
            local_services_public_preview: '公開プレビュー',
            local_services_actions: 'サービスのアクション',
            peer_mediation_observability: '接続の診断',
            devices_simulator: 'シミュレーター',
            approvals: '承認',
            plugin_dev_loop: 'プラグインの開発',
            plugin_settings_administration: 'プラグインの設定',
            plugin_account_administration: 'アカウントのプラグイン',
            npm_registry_profiles: 'npmレジストリのプロファイル',
            plugin_permission_grants: 'プラグインの権限',
            plugin_webhooks: 'プラグインの Webhook',
            account_plugin_data: 'プラグインのデータ',
            account_sessions: 'サインイン中のデバイス',
            account_security: 'アカウントのセキュリティ',
            account_api_tokens: 'API トークン',
            identity_github_apps: 'GitHub アプリ',
            identity_providers: 'サインインプロバイダー',
            machine_pools: 'マシンのプール',
            ephemeral_runner: 'ランナー',
            automation_events: '自動化イベント',
            automation_conversation: '自動化の会話',
            scm_git: 'Git',
            scm_pull_request: 'プルリクエスト',
            scm_repository: 'リポジトリ',
            scm_diff_summary: '差分の概要',
            home_governance: 'Home の管理',
            teams: 'チーム',
            saved_secret_sharing: '共有シークレット',
            personal_saved_secrets: '保存済みシークレット',
        },
    }) } as const;

return { actionFamilyTranslations };
})();

const Domain_addFlowsTranslations = (() => {
type AddFlowsTranslation = Shared_addFlowsTranslations.AddFlowsTranslation;

const addFlowsTranslations = { ja: {
        addHome: 'Home を追加',
        addHomeSubtitle: 'サインイン、アドレスで接続、またはホスト型を利用',
        addHomeDescription: 'すでに使っている Home に接続するか、ホストされた Home を利用します。',
        newGroup: '新しいグループ',
        newGroupSubtitle: '複数の Home のセッションをまとめて表示',
        groupsTitle: 'グループ',
        homesInUse: 'ここで使用中',
        thisDeviceTitle: 'このデバイス',
        thisDeviceSubtitle: 'Home への接続方法',
        thisDeviceDescription: 'このデバイスが Home に接続する方法：参加待ちのデバイス、使用中の接続、実行している Home。',
        newHomeDraft: '新しい Home',
        homeMissingTitle: 'この Home はこのデバイスにありません',
        homeMissingDescription: '削除されたか、別のデバイスに保存されています。',
        homeManageTitle: '管理',
        homeAdministrationSubtitle: 'この Home のメンバー、サインイン、到達性、データ',
        groupMissingTitle: 'このグループはもうありません',
        groupMissingDescription: '削除されました。Home は変わりません。',
        discard: '破棄',
        sshSignInAgent: 'このコンピューターの SSH エージェント',
        sshSignInKeyFile: 'このコンピューターの秘密鍵ファイル',
        sshSignInPassword: '接続に一度だけ使い、保存しません',
        addMachineMenuSubtitle: 'コンピューターまたはサーバー',
        addMachineDescription: 'エージェントがセッションを実行するコンピューターまたはサーバーを追加します。',
        machineJoinsHome: ({ home }) => `${home} に参加`,
        pathThisComputerTitle: 'このコンピューター',
        pathThisComputerTask: 'ワンステップで設定',
        pathThisComputerCommand: 'ターミナルでコマンドを 1 つ',
        pathSshTitle: 'SSH 経由のサーバー',
        pathSshChip: 'SSH 経由',
        pathSshSubtitle: '開発マシン、VM、クラウドサーバー',
        pathAnotherTitle: '別のコンピューター',
        pathAnotherSubtitle: 'そのコンピューターでHomeのリンクを開く',
        machinePoolPrompt: 'セッションをマシン間でフォールバックさせますか？',
        thisComputerCommandLead: ({ home }) => `このコンピューターのターミナルで実行してください。Happier をインストールして ${home} に参加します。準備ができるとこのページがすぐに検知します。`,
        thisComputerTaskLead: ({ machine, home }) => `${machine} が ${home} のエージェントを実行します。Happier はコンピューターと一緒に起動する小さなバックグラウンドサービスをインストールします。`,
        setUpThisComputer: 'このコンピューターを設定',
        desktopAppHint: '入力よりクリックがいいですか？',
        desktopAppLink: 'デスクトップアプリなら、このコンピューターを自動で設定します。',
        thisComputerRunningLead: ({ machine }) => `${machine} を設定しています。Happier はそのまま使えます。`,
        onAnotherHomeTitle: ({ machine }) => `${machine} は別の Home に接続されています`,
        onAnotherHomeBody: ({ home }) => `この Happier サービスは別の Home のセッションを実行中です。${home} へ移しても設定は残り、既存のセッションはそのままです。`,
        moveToHome: ({ home }) => `${home} に移動`,
        keepOnOtherHome: 'そのままにする',
        sshLeadTask: ({ home }) => `SSH で接続できる開発マシン、VM、クラウドサーバー。このコンピューターが接続し、Happier をインストールして ${home} に参加します。`,
        sshLeadCommand: ({ home }) => `SSH で接続できる開発マシン、VM、クラウドサーバー。接続できるコンピューターでコマンドを実行すると、Happier をインストールして ${home} に参加します。`,
        setUpHost: ({ host }) => `${host} を設定`,
        sshSavedNote: 'ホストはリモートホストに保存されます。パスワードは保存されません。',
        sshRunningTitle: ({ host }) => `${host} を設定中`,
        sshRunningLead: 'このコンピューターから SSH で実行中です。離れても大丈夫です。マシン一覧に進行状況が表示され、完了すると知らせます。',
        anotherLead: ({ home }) => `そのコンピューターのターミナルで実行してください。Happier をインストールして ${home} に参加します。`,
        anotherTerminalAction: '代わりにターミナルコマンドを使う',
        machineWatching: ({ subject }) => `${subject} を待っています：`,
        subjectThisComputer: 'このコンピューター',
        subjectAnotherComputer: 'そのコンピューター',
        machineNotSeeingTitle: ({ subject }) => `${subject} がまだ見えませんか？`,
        machineNotSeeingBody: ({ home }) => `Happier は待機を続けています。多くの場合、セットアップがエラーで止まったか、マシンが ${home} に届かないか、別の Home 用に設定されています。`,
        machineArrived: ({ machine }) => `${machine} が接続されました`,
        machineConnectedJustNow: 'たった今接続',
        machineStartSession: ({ machine }) => `${machine} でセッションを開始`,
        machineAddAnother: '別のマシンを追加',
        cancelSetup: 'キャンセル',
        detectedOs: '検出済み',
        sshSuggestionsTitle: 'SSH 設定と保存済みホストから',
        connectingToHome: ({ address }) => `${address} に接続しています…`,
        pathThisComputerConnected: '接続済み · エージェントを表示',
    } } satisfies Pick<Readonly<Record<string, AddFlowsTranslation>>, "ja">;

return { addFlowsTranslations };
})();

const Domain_agentInstallJobTranslations = (() => {
const en = Shared_agentInstallJobTranslations.en;

const agentInstallJobTranslations = { 'ja': { ...en, archiveExpandedByteLimitBody: "ダウンロードしたランタイムは展開サイズの上限を超えています。Happierを更新してから再試行してください。" } };

return { agentInstallJobTranslations };
})();

const Domain_agentStartTranslations = (() => {
const en = Shared_agentStartTranslations.en;

const ja: typeof en = {
    titles: {
        conversation: '横での会話',
    },
    descriptions: {
        conversation: ({ machine }) => `このセッションを止めずに何でも聞けます。${machine} で横に並んで動き、あなたが送らない限り何も戻りません。`,
    },
    placeholders: {
        review: 'レビュアーに重点的に見てほしい点は？',
    },
    chips: {
        engineTitle: '応答するエージェント',
        addReviewer: 'レビュアーを追加',
        reviewer: 'レビュアー',
        reviewerNeeded: '開始するにはレビュアーを追加',
        removeReviewer: ({ name }) => `${name} を外す`,
        scope: 'レビュー対象',
        advanced: '詳細',
    },
    reportToSession: 'このセッションに報告',
    startsWhenYouSend: ({ count }) => count > 1 ? `送信すると ${count} 件のレビューが始まります` : '送信すると始まります',
    thisFolder: 'このフォルダ',
    offline: ({ machine }) => `${machine} はオフラインです。エージェントはそこで始まります。戻るまで下書きはここに残ります。`,
    menu: {
        askSection: 'エージェントに依頼',
        secondOpinionTitle: 'セカンドオピニオン',
        secondOpinionSubtitle: '完了前の独立したチェック',
        keepGoingTitle: '完了まで続ける…',
        keepGoingSubtitle: '目標コントロールで目標を設定',
        runWorkflowTitle: 'ワークフローを実行',
        runWorkflowSubtitle: 'ライブラリまたは組み込みから',
        searchWorkflows: 'ワークフローを検索…',
        yourLibrary: 'ライブラリ',
        noWorkflows: '保存済みのワークフローはまだありません',
        addTriggerTitle: 'トリガーを追加…',
        addTriggerSubtitle: '何かが起きるたびにここで実行',
        advancedTitle: '詳細…',
        advancedSubtitle: '複数のエージェント、権限、プロファイル',
        builtIn: '組み込み',
        allWorkflows: 'すべてのワークフロー…',
    },
    role: {
        replaces: ({ agent }) => `${agent} の代わりに使います`,
    },
    startRow: {
        subtitle: '下書き · 送信すると開始',
        conversation: '新しい会話',
        review: '新しいレビュー',
        plan: '新しい計画',
        delegate: '新しいタスク',
    },
    pane: {
        cancelRun: '実行をキャンセル',
        whenItFinishes: '完了したら',
        sendToSession: ({ session }) => `${session} に送信`,
        replyTo: ({ agent }) => `${agent} に返信…`,
        repliesGoTo: ({ session }) => `返信は ${session} ではなくこのエージェントに届きます`,
    },
};

const agentStartTranslations = { ja };

return { agentStartTranslations };
})();

const Domain_apiTokenSettingsTranslations = (() => {
const english = Shared_apiTokenSettingsTranslations.english;

const translated = Shared_apiTokenSettingsTranslations.translated;

const apiTokenSettingsTranslations = { ja: translated({
        settingsApiTokens: {
            encryption: {
                choice: "暗号化へのアクセス",
                consequence: "アカウント全体の暗号化へのアクセスを許可します。失効すると今後のAPI認可は停止しますが、取得済みの鍵やデータは回収できません。",
                enabled: "暗号化アクセス有効",
                bearerOnly: "APIアクセスのみ",
                unknown: "暗号化アクセス不明",
                outcomeUnknown: "作成が完了している可能性があります。一覧を更新し、このトークンを失効させてから新しいトークンを作成してください。",
                unsupported: "このHomeは暗号化APIトークンにまだ対応していません。更新するか、通常のトークンを作成してください。",
                notReady: "暗号化トークンを作成する前に、このHomeで暗号化へのアクセスを復元してください。",
                stale: "アカウントの暗号鍵が変更されました。このHomeで暗号化へのアクセスを復元してください。",
                idConflict: "このトークンIDは既に存在します。該当トークンを失効させてから新しく作成してください。",
            },
            unattended: {
                choice: "無人のチームアクセス",
                consequence: "制限されたチーム作業のため、この認証情報で現在検証済みの認証方法をトークンへコピーします。暗号化アクセスとは別です。",
                authorized: "無人のチームアクセスを許可済み",
                notAuthorized: "無人のチームアクセスなし",
                evidenceLimit: "コピーできる検証済み認証方法の上限を超えています。トークンは作成されませんでした。",
                evidenceUnavailable: "このサインイン中の資格情報にはコピーできる現在の認証証跡がありません。必要な方法で再認証してください。トークンは作成されませんでした。",
            },
            title: 'API トークン',
            entrySubtitle: 'スクリプト、サーバー、埋め込みアプリが、あなたが与えたアクセス権の範囲内であなたの代わりに操作できるようにします。',
            tokens: 'API トークン',
            refreshing: '更新中…',
            emptyTitle: 'API トークンはまだありません',
            embedOnlyTitle: "ほかの API トークンはまだありません",
            embedKeysElsewhere: "埋め込みキーは「埋め込み」で管理します。",
            openEmbeds: "埋め込みを開く",
            emptyBody: 'トークンを使うと、信頼できるスクリプトやツールが、許可された自動化アクションを実行できます。連携が現在のアカウントへのアクセスを必要とするときにトークンを作成してください。',
            created: '作成日',
            lastUsed: '最終使用',
            neverUsed: '未使用',
            securityTitle: 'セキュリティ',
            securityFooter: 'これらの操作は現在のアカウント全体に適用されます。',
            status: {
                active: '有効',
                expiresInMinutes: ({ count }) => `あと${count}分で期限切れ`,
                expiresInHours: ({ count }) => `あと${count}時間で期限切れ`,
                expiresInDays: ({ count }) => `あと${count}日で期限切れ`,
                expired: '期限切れ',
            },
            rowAccessibilityLabel: ({ label, state }) => `${label}、${state}`,
            moreActionsAccessibilityLabel: ({ label }) => `${label}のその他の操作`,
            create: {
                button: 'トークンを作成',
                title: 'API トークンを作成',
                subtitle: '連携に名前を付け、このトークンの有効期限を選択してください。通常の API リクエストと結果は Home から読み取れます。暗号化アクセスを使うと、対応する SDK 呼び出しを保護できます。',
                submit: 'トークンを作成',
                label: 'ラベル',
                labelPlaceholder: 'リリースの自動化',
                expiry: '有効期限',
                expiryOptions: {
                    '30d': '30 日',
                    '90d': '90 日',
                    '1y': '1 年',
                    none: '有効期限なし',
                },
                access: 'アクセス',
                accessFull: 'フルアクセス',
                accessLimited: '制限付き',
                accessLimitedDescription: '次に、アクション、セッション、モデル、ウェブサイトを選択します。',
                accessTitle: 'アクセスを選択',
                continue: '続行',
                back: '戻る',
                actionSettingsPrefix: 'このトークンは、現在のアカウントの',
                actionSettingsLink: 'アクション設定で有効な外部 API と SDK の操作を実行できます。',
            },
            reveal: {
                title: 'API トークンを保存',
                accessibilityAnnouncement: '今すぐトークンをコピーしてください。表示されるのは一度だけです。',
                successTitle: 'トークンを作成しました',
                shownOnce: '今すぐこのトークンをコピーしてください。安全のため、Happier では再表示できません。',
                copy: 'トークンをコピー',
                copied: 'コピーしました',
                dismissTitle: '確認せずに閉じますか？',
                dismissBody: 'このトークンは再表示されません。先にコピーするか、安全な場所に保存したことを確認してください。',
                copyFirst: 'トークンを表示したままにする',
                savedIt: '保存しました',
            },
            revoke: {
                title: ({ label }) => `「${label}」を取り消しますか？`,
                body: 'サーバーと API へのアクセスは次回の検証時に停止します。この API トークンを最近検証したローカルデーモンは、最大 1 分間は受け入れ続ける場合があります。この操作は元に戻せません。',
                confirm: 'トークンを取り消す',
            },
            revokeAll: {
                title: 'すべての API トークンを取り消す',
                subtitle: 'このアカウントのすべての API トークンを無効にします。',
                body: 'サーバーと API へのアクセスは次回の検証時に停止します。これらのトークンを使う埋め込みは動作しなくなり、その埋め込み資格情報はサインアウトされます。これらの API トークンを最近検証したローカルデーモンは、最大 1 分間は受け入れ続ける場合があります。この操作は元に戻せません。',
                confirm: 'すべて取り消す',
                railAction: 'すべての API トークンを取り消す…',
            },
            signOutEverywhere: {
                title: 'すべての場所でサインアウト',
                subtitle: 'このアカウントでサインインしているすべてのセッションを終了します。',
                body: 'ブラウザとデバイスでサインインしているすべてのセッションが終了します。API トークンは有効なままです。この画面から別途取り消してください。',
                confirm: 'すべての場所でサインアウト',
            },
            errors: {
                labelRequired: 'トークンを作成する前にラベルを入力してください。',
                accountChanged: 'アクティブなアカウントまたは Home が変わったため、何も変更されていません。続けるにはもう一度開いてください。',
                presentUserRequired: 'サインインの確認画面で本人確認をしてから、もう一度お試しください。',
                offline: 'Happier はアカウントに接続できませんでした。接続を確認してから、もう一度お試しください。',
                unavailable: 'この操作は現在利用できません。しばらくしてからもう一度お試しください。',
                copyFailed: 'トークンをコピーできませんでした。閉じる前に選択して手動でコピーしてください。',
                listTitle: 'API トークンを利用できません',
                grantIncomplete: 'トークンを作成する前に、アクセスの選択を完了してください。',
            },
            embedPill: '埋め込み',
            embedRowHint: 'この埋め込みを「設定」の「埋め込み」で開きます。',
            summary: {
                full: 'フルアクセス',
                allActions: 'すべてのアクション',
                namesAndMore: ({ names, count }) => `${names} +${count}`,
                sessions: ({ count }) => (count === 1 ? '1 件のセッション' : `${count} 件のセッション`),
                computers: ({ count }) => (count === 1 ? '1 台のコンピューター' : `${count} 台のマシン`),
                approve: '承認可能',
                automations: ({ count }) => (count === 1 ? '1 件のオートメーション' : `${count} 件のオートメーション`),
                models: ({ count }) => (count === 1 ? '1 個のモデル' : `${count} 個のモデル`),
                websites: ({ count }) => (count === 1 ? '1 件のウェブサイト' : `${count} 件のウェブサイト`),
                content: 'コンテンツへのアクセス',
                noExpiry: '有効期限なし',
                expires: ({ date }) => `有効期限: ${date}`,
                expired: ({ date }) => `${date} に期限切れ`,
            },
            grant: {
                accessTitle: 'アクセス',
                back: 'アクセス',
                onlyThese: 'これらのみ',
                selectedCount: ({ count }) => (count === 1 ? '1 件選択中' : `${count} 件選択中`),
                reviewUnnamed: 'このトークン',
                actions: {
                    title: 'アクション',
                    all: 'すべてのアクション',
                    none: 'アクションを 1 つ以上選択してください',
                    search: 'アクションを検索',
                    noMatches: ({ query }) => `「${query}」に一致するアクションはありません`,
                    groupDescription: 'グループ全体を選ぶと、後から追加されるアクションも含まれます。',
                    familyCount: ({ count }) => (count === 1 ? 'グループ · 1 件のアクション' : `グループ · ${count} 件のアクション`),
                    includedByFamily: ({ family }) => `${family} に含まれます`,
                },
                targets: {
                    title: 'セッションとマシン',
                    all: 'すべてのセッションとマシン',
                    none: 'セッションまたはマシンを 1 つ以上選択してください',
                    computers: 'マシン',
                    computersDescription: 'マシンを選ぶと、そのマシン上の現在と今後のすべてのセッションが含まれます。',
                    sessions: 'セッション',
                    searchSessions: 'セッションを検索',
                    noSessions: 'セッションはまだありません',
                    noSessionMatches: ({ query }) => `「${query}」に一致するセッションはありません`,
                    noComputers: 'マシンはまだありません',
                },
                models: {
                    title: 'モデル',
                    any: '任意のモデル',
                    onlyThese: 'これらのモデルのみ',
                    none: 'モデルを 1 つ以上選択してください',
                    pickerDescription: 'その他のモデルは非表示になるだけでなく拒否されます。モデルを選ぶと「自動」は選択できなくなります。',
                    noModels: '選択できるモデルはまだありません',
                },
                automations: {
                    title: 'オートメーション',
                    any: 'すべてのオートメーション',
                    onlyThese: 'これらのオートメーションのみ',
                    none: 'オートメーションを 1 つ以上選んでください',
                    pickerDescription: 'それ以外のオートメーションでは「今すぐ実行」が拒否されます。',
                    noAutomations: 'オートメーションはまだありません',
                    unknown: '一覧にないオートメーション',
                    unnamed: '無題のオートメーション',
                    off: 'オフ',
                    loadMore: 'オートメーションをさらに表示',
                    loadMoreFailed: 'これ以上読み込めませんでした。もう一度お試しください',
                },
                approve: {
                    title: 'リクエストの承認',
                    on: '上記のセッションでのツール使用とリクエストを承認できます。自分で開始したリクエストも含まれます。トークン、セキュリティ、プラグインは変更できません。',
                    off: 'リクエストは Happier であなたの対応を待ちます。',
                },
                websites: {
                    title: 'ウェブサイト',
                    description: 'これらのサイトのページは、ブラウザーからトークンを使用できます。スクリプトやサーバーの場合は空のままにしてください。',
                    inputLabel: 'ウェブサイトを追加',
                    placeholder: 'https://app.example.com',
                    add: '追加',
                    invalid: 'https:// で始めてください（localhost の場合は http:// も使用できます）。',
                    duplicate: 'このウェブサイトはすでに追加されています。',
                    remove: ({ origin }) => `${origin} を削除`,
                },
            },
            detail: {
                whatItCanDo: 'できること',
                whatItCanDoDescription: 'このトークンがあなたの代わりに実行できるアクションです。それ以外はすべて拒否されます。',
                everyAction: '外部 API と SDK で有効なすべてのアクション',
                wholeGroup: 'グループ全体',
                where: '対象',
                whereDescription: 'アクセスできるセッションとマシンです。',
                computerCovers: 'このマシン上のすべてのセッション',
                unknownComputer: '一覧に表示されなくなったマシン',
                unknownSession: '一覧に表示されなくなったセッション',
                modelsDescription: 'その他のモデルは非表示になるだけでなく拒否されます。',
                approvals: '承認',
                approvesOn: 'リクエストを承認します',
                approvesOff: 'リクエストを承認しません',
                websitesDescription: 'これらのサイトのブラウザーページから使用できます。',
                noWebsites: 'スクリプトとサーバーのみ',
                content: 'コンテンツへのアクセス',
                contentOn: '対応する SDK 呼び出しを通じて、エンドツーエンド暗号化されたコンテンツを読み取れます。',
                contentOff: 'エンドツーエンド暗号化されたコンテンツは読み取れません。',
                children: '埋め込み資格情報',
                childrenDescription: 'アプリがこのトークンからページ用に発行した、有効期間の短いキーです。',
                childrenCount: ({ count }) => (count === 1 ? '1 件有効' : `${count} 件有効`),
                childrenConsequence: 'アクセスを編集するか、このトークンを取り消すとサインアウトされます。',
                sessionLimits: 'セッション',
                sessionLimitsDescription: '開始できるセッションと、メッセージが使える権限モード。',
                createsSessions: 'セッションを開始',
                createsSessionsOn: ({ computer }: { computer: string }) => `${computer} 上の、Happier が管理する非公開フォルダーで。`,
                editAccess: 'アクセスを編集',
                revokeFootnote: 'これを使うスクリプトと埋め込みは、次のリクエストから動作しなくなります。',
                created: ({ date }) => `作成日: ${date}`,
                lastUsed: ({ date }) => `最終使用: ${date}`,
                missingTitle: 'このトークンはもうありません',
                missingBody: '取り消されたか期限切れになり、削除されました。その他のトークンは引き続き一覧に表示されます。',
                backToTokens: 'API トークンを表示',
            },
            edit: {
                title: 'アクセスを編集',
                save: '保存',
                signsOut: '有効な埋め込み資格情報はサインアウトされます。',
            },
            cliPolicy: {
                sectionTitle: 'CLI とデーモン',
                sectionDescription: 'マシン上のコマンドが、あなたのサインインで行えることを設定します。',
                title: 'CLI とデーモンからの承認とアカウント変更を許可',
                description: 'マシン上のコマンドがリクエストを承認し、アカウント設定を変更できるようにします。エージェントがシェルアクセス付きで実行される場合はオフにしてください。マシンごとに HAPPIER_CLI_PRESENT_USER=disallowed で除外することもできます。変更するとマシンが一時的に再接続されます。',
                unavailable: 'この設定を読み込めませんでした。しばらくしてからもう一度お試しください。',
                saveFailed: 'この設定を変更できませんでした。しばらくしてからもう一度お試しください。',
            },
            notices: {
                revoked: 'API トークンを取り消しました。',
                revokedAll: 'すべての API トークンを取り消しました。',
                signedOutEverywhere: 'すべての場所でサインアウトしました。API トークンは有効なままです。',
            },
        },
    }) } as const;

return { apiTokenSettingsTranslations };
})();

const Domain_artifactsBrowserTranslations = (() => {
type ArtifactsBrowserTranslations = Shared_artifactsBrowserTranslations.ArtifactsBrowserTranslations;

const artifactsBrowserTranslations = { ja: {
        description: 'あなたとエージェントが保存したもの。読む、再利用する、共有する準備ができています。',
        newDocument: '新規ドキュメント',
        searchPlaceholder: 'アーティファクトを検索',
        kindLabel: '種類',
        sourceLabel: '出所',
        kinds: {
            all: 'すべての種類',
            document: 'ドキュメント',
            prompt: 'プロンプト',
            memory: 'メモリ',
            board: 'ボード',
            widget: 'ウィジェット',
            workflow: 'ワークフロー',
            role: 'ロール',
            launchProfile: '起動プロファイル',
        },
        kindOne: {
            document: 'ドキュメント',
            prompt: 'プロンプト',
            memory: 'メモリ',
            board: 'ボード',
            widget: 'ウィジェット',
            workflow: 'ワークフロー',
            role: 'ロール',
            launchProfile: '起動プロファイル',
        },
        sort: {
            label: '並べ替え',
            updated_desc: '最近更新',
            created_desc: '最近作成',
            title_asc: 'タイトル',
        },
        view: {
            label: '表示',
            grid: 'グリッド',
            list: 'リスト',
            folders: 'フォルダ',
        },
        folders: {
            newFolder: '新規フォルダ',
            newFolderInside: 'この中に新規フォルダ',
            rename: '名前を変更',
            moveTo: 'フォルダへ移動…',
            moveItemTo: ({ name }) => `「${name}」の移動先`,
            newFolderEllipsis: '新規フォルダ…',
            moveVerb: ({ name }) => `${name} に移動`,
            topLevel: '最上位',
            moveToTopLevel: '最上位へ移動',
            deleteFolder: 'フォルダを削除',
            deleteTitle: ({ name }) => `「${name}」を削除しますか？`,
            deleteBody: '中の項目とフォルダは1つ上の階層に移動します。削除されるものはありません。',
            nameHelp: 'フォルダはあなただけのものです。整理しても、共有相手の表示は変わりません。',
            emptyFolder: '空',
            namePlaceholder: 'フォルダ名',
            create: '作成',
            options: ({ name }) => `${name} のオプション`,
            expand: ({ name }) => `${name} を展開`,
            collapse: ({ name }) => `${name} を折りたたむ`,
            columnName: '名前',
            columnEdited: '編集',
            emptyInvite: 'フォルダはまだありません。関連するものをまとめましょう。整理の仕方はあなたにしか見えません。',
            unavailable: 'この Home からフォルダを読み込めませんでした。すべてフォルダなしで表示しています。',
            saveFailed: '変更を保存できませんでした。もう一度お試しください。',
            refusedCycle: 'フォルダを自身の中へは移動できません',
            refusedUnavailable: '現在フォルダを利用できません',
            lastKnown: '最後に確認できたフォルダを表示しています',
            refusedOther: 'そこへは移動できません',
            showAllKinds: 'アーティファクトですべての種類を表示',
            promptSearch: 'プロンプトとスキルを検索',
        },
        provenance: {
            savedByYou: 'あなたが保存',
            sharedWithYou: 'あなたと共有',
            fromFile: ({ name }) => `${name} から`,
            openSession: ({ session }) => `${session} を開く`,
        },
        emptyTitle: 'エージェントが作ったものを残そう',
        emptyBody: 'あなたやエージェントが保存した計画、メモ、コード、ボードがここに集まります。どのデバイスでも読め、チームとすぐ共有できます。',
        emptyHint: 'またはエージェントに「それをアーティファクトとして保存して」と頼んでください。',
        loadFailedTitle: 'アーティファクトを読み込めませんでした',
        loadFailedBody: '接続を確認してもう一度お試しください。何も失われていません。',
        retainedBody: "更新できませんでした。最後に読み込んだアーティファクトを表示しています。",
        quota: {
            accountTitle: 'アーティファクトの保存容量がいっぱいです',
            documentTitle: '大きすぎて保存できません',
            accountBody: ({ used, limit }) => `バージョンを含めて ${limit} 中 ${used} を使用しています。新しく保存するには、不要なアーティファクトを削除またはエクスポートしてください。`,
            documentBody: ({ size, limit }) => `${size} になります。1 つのアーティファクトは最大 ${limit} までです。編集内容はそのまま残っています。`,
        },
        conflict: {
            title: '編集中に変更されました',
            body: '新しいバージョンが保存されました。編集内容はそのまま残っています。保存する前に最新のバージョンを確認してください。',
        },
        open: {
            document: 'ドキュメントを開く',
            prompt: 'プロンプトを開く',
            memory: 'メモリを開く',
            board: 'ボードを開く',
            widget: 'ウィジェットを開く',
            workflow: 'ワークフローを開く',
            role: 'ロールを開く',
            launchProfile: '起動プロファイルを開く',
        },
        openAsPage: 'ページとして開く',
        actions: {
            edit: '編集',
            history: '履歴',
            share: '共有',
            more: 'その他の操作',
            copyLink: 'リンクをコピー',
            linkCopied: 'リンクをコピーしました',
        },
        history: {
            title: '履歴',
            current: '現在',
            now: '現在',
            restoreNote: '復元すると新しいバージョンとして追加されます。何も失われません。',
            loadFailed: '履歴を読み込めませんでした。もう一度お試しください。',
            empty: '以前のバージョンはまだありません。保存するたびに 1 つ残ります。',
            versionsLabel: 'バージョン',
            restoreFailed: 'このバージョンを復元できませんでした。もう一度お試しください。',
            savedByUser: 'ユーザーが保存',
            savedByAgentSession: 'エージェントセッションが保存',
            restoredVersion: ({ n }) => `バージョン${n}から復元`,
            version: ({ n }) => `バージョン ${n}`,
            keeps: ({ count }) => `直近 ${count} 件のバージョンを保持します。`,
            restore: ({ n }) => `バージョン ${n} を復元`,
        },
        savedToday: ({ count }) => `今日 ${count} 件保存`,
        noMatch: ({ query }) => `「${query}」に一致するアーティファクトはありません`,
        storage: {
            meter: ({ used, limit }) => `${limit} 中 ${used}`,
            a11y: ({ used, limit }) => `アーティファクトの保存容量：${limit} 中 ${used} 使用`,
        },
        facts: {
            edited: ({ age }) => `${age} に編集`,
            version: ({ n }) => `バージョン ${n}`,
            sharedWithTeam: ({ team }) => `${team} と共有`,
            shared: '共有中',
            onlyYou: '自分のみ',
            acceptedEdit: ({ who, age }) => `${who} · ${age}`,
        },
        passage: {
            comment: 'コメント',
            you: 'あなた',
            changed: '変更あり',
            openConversation: '会話を開く',
            replied: ({ name, time }) => `${name}が返信 · ${time}`,
            changedReason: ({ n }) => `この箇所はコメント後に変更されました。引用はバージョン ${n} のものです。`,
            openRevision: ({ n }) => `バージョン ${n} を開く`,
            reattach: '新しい文章に付け替える',
            reattaching: '今の対象の文章を選択してください。',
            attachHere: 'ここに付ける',
            earlier: ({ n, quote }) => `以前はバージョン ${n}：「${quote}」`,
            count: ({ count }) => `${count}件の会話`,
            countUnavailable: 'コメント数を取得できません',
            refineHint: 'コメントする語句を選択してください',
            threadsTitle: '会話',
            refineFailed: '選択範囲を特定できませんでした。もう一度語句を選択してください。',
            threadDetail: ({ who, n }) => n === 0 ? who : `${who} · 返信 ${n} 件`,
            acceptedToast: ({ n }) => `承認済み · バージョン ${n}`,
            youAccepted: ({ name }) => `${name} の編集を承認しました`,
            accepted: ({ name }) => `${name} の編集が承認されました`,
        },
        proposal: {
            title: '編集の提案',
            titleBy: ({ who }) => `${who} が編集を提案しています`,
            basedOn: ({ n }) => `バージョン ${n} に基づく`,
            current: ({ n }) => `バージョン ${n} · 最新`,
            before: '変更前',
            after: '変更後',
            accept: '承認',
            decline: '却下',
            accepting: '承認中… ドキュメントが変わっていないか確認しています',
            declining: '却下中…',
            movedOn: 'この提案の後にドキュメントが変更されました。何も適用されていません。',
            compare: '比較',
            cantEdit: 'このドキュメントを編集できる人だけが承認できます。',
            failed: '決定を保存できませんでした。もう一度お試しください。',
            acceptedByYou: ({ n }) => `編集を承認しました · 現在バージョン ${n}`,
            acceptedBy: ({ who, n }) => `${who} が編集を承認しました · 現在バージョン ${n}`,
            declinedByYou: '提案を却下しました · ドキュメントは変わっていません',
            declinedBy: ({ who }) => `${who} が提案を却下しました · ドキュメントは変わっていません`,
            undo: '元に戻す',
            undone: ({ n }) => `元に戻しました · 現在バージョン ${n}`,
            undoConflict: 'この編集の後にドキュメントが変更されたため、元に戻せません。履歴を開いてバージョンを選んでください。',
            openDocument: 'ドキュメントを開く',
            someone: '誰か',
            askRedo: 'やり直しを依頼',
            redoRequest: '提案のあとでドキュメントが変更されました。現在のバージョンでもう一度提案してもらえますか？',
        },
    } } satisfies Pick<Record<'en' | 'fr' | 'de' | 'es' | 'it' | 'pt' | 'ca' | 'ru' | 'pl' | 'ja' | 'zh-Hans' | 'zh-Hant', ArtifactsBrowserTranslations>, "ja">;

return { artifactsBrowserTranslations };
})();

const Domain_automationPageTranslations = (() => {
const english = Shared_automationPageTranslations.english;

const translated = Shared_automationPageTranslations.translated;

const slavicPlural = Shared_automationPageTranslations.slavicPlural;

const automationPageTranslations = { ja: translated({
        automationPages: {
            index: {
                description: 'スケジュール、Event、またはセッションのターン終了で自動的に始まる作業です。',
            },
            settings: {
                description: '各マシンが引き受ける自動化の作業量と、完了した実行を保持する期間です。',
                capacityTitle: '処理能力',
                capacityDescription: '自動化を実行するすべてのマシンに適用されます。',
                historyTitle: '実行履歴',
                historyDescription: '自動化からまだ開ける完了済みの実行です。',
            },
            detail: {
                description: 'トリガーのいずれかが発生すると、自動的に作業を始めます。',
                triggerCount: ({ count }: { count: number }) => `${count} 件のトリガー`,
                overviewDescription: '実行する内容と、開始・変更の方法です。',
                runNowSubtitle: 'トリガーを待たずに今すぐ実行を開始します。',
                editSubtitle: '名前、実行する内容、トリガーを変更します。',
                machineAssignmentsDescription: 'この自動化の実行を引き受けられるマシンです。',
            },
            run: {
                description: 'この実行を開始したもの、実行場所、生成したものです。',
                statusTitle: '状態',
                statusDescription: 'この実行の現在の状況と、まだできる操作です。',
                causeTitle: '開始のきっかけ',
                causeDescription: 'この実行を受け付けたトリガーとイベントです。後から変わることはありません。',
            },
            gate: {
                serverTitle: 'このHomeでは自動化がオフになっています',
                serverBody: 'このHomeの管理者が自動化をオフにしました。管理者に再びオンにするよう依頼してください。',
                openFeatures: '機能の設定を開く',
                unknownTitle: '現在オートメーションを確認できません',
                unknownBody: 'オートメーションが有効か確認するためにこの Home に接続できませんでした。オンラインに戻ったらもう一度確認してください。',
                unsupportedTitle: 'この Home はまだオートメーションに対応していません',
                unsupportedBody: 'サーバーがオートメーションより古いバージョンです。利用するには Home のサーバーを更新してください。',
                unsupportedContextTitle: 'ここではオートメーションを利用できません',
                unsupportedContextBody: '表示中の Home の一部がオートメーションに対応していません。',
            },
            editor: {
                description: '名前を付け、実行する内容を選び、開始するトリガーを追加します。',
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
} as const;

const automationTriggerSetTranslations = { ja: {
        pluralEditor: {
            ...expandedLifecycleEnglish,
            lifecycleEvent: {
                ...expandedLifecycleEnglish.lifecycleEvent,
                sessionStarted: 'セッションの開始時',
                sessionArchived: 'セッションのアーカイブ時',
            },
            triggersTitle: 'トリガー',
            emptyBody: '自動トリガーはありません。このオートメーションは引き続き手動で実行できます。',
            orSemantics: 'トリガーはいくつでも追加できます。それぞれが独立して動作し、どれか一つが一致するとオートメーションが実行されます。',
            enabledSubtitle: 'トリガーを変更せずに、オートメーション全体を一時停止します。', addTrigger: 'トリガーを追加',
            addTriggerSubtitle: 'スケジュール、イベント、または特定のターンの完了を設定します。', scheduleTitle: 'スケジュール', eventTitle: 'プラグインイベント',
            turnCompletedTitle: 'このターンが終了したとき', turnCompletedSubtitle: '選択した親ターンが完了した後に一度だけ実行します。', selectedSession: '選択中のセッション',
            turnCompletedSource: ({ session, ordinal }: { session: string; ordinal: number }) => `${session} · 1 回限りのトリガー ${ordinal}`,
            scheduleInterval: ({ minutes, timezone }: { minutes: number; timezone: string | null }) => `${minutes} 分ごと${timezone ? ` · ${timezone}` : ''}`,
            scheduleCron: ({ expression, timezone }: { expression: string; timezone: string | null }) => `${expression}${timezone ? ` · ${timezone}` : ''}`,
            eventSubtitle: ({ pluginId, eventId }: { pluginId: string; eventId: string }) => `${pluginId} · ${eventId}`,
            triggerEnabledLabel: ({ title }: { title: string }) => `${title}を有効にする`, editScheduleTitle: 'スケジュールを編集', scheduleType: 'スケジュールの種類',
            chooseSession: '実行中のセッションを選択', eventEditorUnavailable: '現在のマシンではイベントを設定できません。',
            removeTitle: 'このトリガーを削除しますか？', removeBody: '今後、このトリガーのイベントではオートメーションが開始されません。既存の実行履歴は変わりません。',
        },
        exactTurn: {
            eventSearchPlaceholder: 'イベントを検索',
            refreshFailedTitle: 'オートメーションを更新できませんでした',
            refreshFailedBody: '現在オートメーションの一覧を読み取れませんでした。もう一度試して最新の一覧を読み込んでください。',
            actionTitle: 'このターンが終了したとき…', createNew: '新しいオートメーションを作成', createNewSubtitle: 'このターンを選択した状態で始めます。',
            addToExistingSubtitle: 'このターンを既存のオートメーションに追加します。', searchPlaceholder: 'オートメーションを検索',
            eventListA11y: 'セッションのライフサイクルイベントを選択',
            destinationA11y: 'このターンのトリガーを追加する場所を選択', staleTitle: 'ターンが変更されました',
            staleBody: '選択したターンは現在の親ターンではありません。更新して、現在のターンを明示的に選択してください。',
            useCurrentTurn: '現在のターンを使用', unavailable: '現在、使用できる親ターンはありません。',
            resolvingRowSubtitle: '使用できるオートメーションを確認しています…',
            unavailableRowSubtitle: '詳細を利用できないため、このセッションに対してこのオートメーションを検証できません。',
            incompleteNoticeTitle: '一部のオートメーションを読み込めませんでした',
        },
    } } as const;

return { automationTriggerSetTranslations };
})();

const Domain_boardsTranslations = (() => {
type Count = Shared_boardsTranslations.Count;

type BoardsTranslations = Shared_boardsTranslations.BoardsTranslations;

const en = Shared_boardsTranslations.en;

const ja: BoardsTranslations = {
    title: 'ボード',
    newBoard: '新しいボード',
    defaultName: '名称未設定のボード',
    index: {
        title: 'あなたのボード',
        body: 'ボードは、セッション、実行、ワークフロー、マシンをひとつの場所でライブに保ち、好きなように並べられます。',
    },
    notFound: {
        title: 'このボードはありません',
        body: '削除されたか、ここに接続されていない Home のボードです。',
    },
    meta: {
        needYou: ({ count }) => `${count} 件が対応待ち`,
        items: ({ count }) => `${count} 件`,
        itemsAtLeast: ({ count }) => `${count}+ 件`,
        needYouAtLeast: ({ count }) => `${count}+ 件が対応待ち`,
        handPicked: '手動で選択',
        empty: '空',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: '対応待ち', description: 'あなたを待っているものすべて' },
        running: { title: '実行中', description: '進行中のワークフロー実行' },
        my_machines: { title: '自分のマシン', description: '接続状況と各マシンで動いているもの' },
        filter: { title: 'セッション', description: 'アクティブなセッションすべて' },
    },
    header: {
        layoutA11y: 'ボードのレイアウト',
        canvas: 'キャンバス',
        byStatus: '状態別',
        add: 'ボードに追加',
        settings: 'ボードの設定',
    },
    kinds: {
        session: 'セッション',
        workflow_run: 'ワークフロー実行',
        task: 'タスク',
        workflow: 'ワークフロー',
        machine: 'マシン',
    },
    card: {
        missing: '削除されたか、共有されていません',
        unavailable: '利用できません',
        unavailableBody: 'この項目の Home はこのデバイスに接続されていません。ボードには残ります。',
        notLoaded: 'まだ読み込まれていません',
        readFailed: 'このセッションを読み込めませんでした。ボードには残ります。',
        remove: 'ボードから外す',
        moveHint: '矢印キーでこのカードをグリッド上で動かせます。',
        moved: ({ x, y }) => `${x}, ${y} に移動しました`,
        moveActions: { up: '上へ移動', down: '下へ移動', left: '左へ移動', right: '右へ移動' },
        machine: {
            online: 'オンライン',
            offline: 'オフライン',
            running: ({ count }) => `${count} 件のセッションが実行中`,
            needYou: ({ count }) => `${count} 件が対応待ち`,
            idle: '実行中のセッションはありません',
            offlineBody: 'セッションは戻ってくるまで待機します。',
        },
        workflow: {
            noRuns: 'まだ実行がありません',
            lastRun: ({ word, age }) => `前回の実行 ${age} · ${word}`,
            lastRunAt: ({ age }) => `前回の実行 ${age}`,
            needYou: ({ count }) => `${count} 件が対応待ち`,
        },
        run: {
            waitingForYou: 'レビュー待ち',
            started: ({ age }) => `${age}に開始`,
        },
    },
    canvas: {
        snapsHere: 'ここに吸着します',
        snapOnceHint: '⇧ を押すと一度だけグリッドに合わせます',
    },
    settings: {
        title: 'ボードの設定',
        name: '名前',
        whatsOn: 'このボードの内容',
        whichSessions: '対象のセッション',
        addedByHand: '手動で追加',
        addedByHandNone: 'まだありません',
        add: '追加',
        layout: 'レイアウト',
        layoutDescription: '切り替えても、キャンバスの配置は保たれます。',
        snap: 'グリッドに吸着',
        pin: 'セッション一覧に表示',
        pinDescription: 'このボードをセッションの上に固定します。',
        delete: 'ボードを削除',
        deleteConfirmTitle: 'このボードを削除しますか？',
        deleteConfirmBody: '削除されるのはボードだけです。セッション、実行、ワークフロー、マシンはそのまま残ります。',
    },
    add: {
        title: 'ボードに追加',
        search: '項目を検索',
        groups: { sessions: 'セッション', workflows: 'ワークフロー', runs: 'ワークフロー実行', machines: 'マシン' },
        onBoard: 'このボード上',
        addHint: '追加',
        addAndPlaceHint: '追加して配置',
        empty: '一致するものはありません。',
        noMatch: ({ query }) => `「${query}」に一致するものはありません`,
    },
    /** Candidates an answered filter could not classify: said once under the header, qualifying every count. */
    undetermined: {
        sessions: ({ count }) => `${count} 件のセッションを確認できませんでした`,
        runs: ({ count }) => `${count} 件の実行を確認できませんでした`,
        items: ({ count }) => `${count} 件の項目を確認できませんでした`,
        projectAssociation: 'プロジェクトとの関連付けが公開されていないか、あなたには表示されません。',
        filterFacts: 'このフィルターに必要な情報を取得できません。',
    },
    empty: {
        title: 'このボードに表示するものを選びましょう',
        body: 'セッション、ワークフロー、実行、マシンを手動で追加するか、「対応待ち」のようなセクションを表示します。配置はあなた次第。ボードがライブに保ちます。',
        action: 'ボードに追加',
        sourcedTitle: 'いまは何もありません',
        sourcedBody: 'このボードのソースに一致する項目は、届き次第ここに表示されます。手動で追加することもできます。',
        uncheckedTitle: '一致はまだ確認されていません',
        pendingTitle: '一致する項目を確認しています…',
    },
    widgets: {
        group: 'ウィジェット',
        kind: 'ウィジェット',
        gallery: 'ギャラリーを開く',
        galleryHint: 'すべてのウィジェットをライブプレビューで',
        addHint: 'ボードはあなただけに表示されます',
        widthOne: 'カード1枚分',
        widthTwo: 'カード2枚分',
        moveEarlier: '前へ移動',
        moveLater: '後ろへ移動',
        remove: 'ボードから削除',
        menuA11y: ({ widget }) => `${widget} のオプション`,
        arrived: ({ count }) => `ウィジェットが${count}件届きました`,
        undo: '元に戻す',
        dismiss: '閉じる',
    },
    saveFailed: {
        tooLarge: 'このボードはボードの保存容量の上限を超えています。いくつか項目を外してから、もう一度お試しください。',
        notFound: 'このボードは別のデバイスで削除されました。',
        generic: '変更がアカウントに届かなかったため、ボードは元のままです。',
        retry: 'もう一度試す',
        dismiss: '閉じる',
        createTitle: 'このボードは作成されませんでした',
    },
};

const boardsTranslations = { ja };

return { boardsTranslations };
})();

const Domain_browserPresenceTranslations = (() => {
type AgentParams = Shared_browserPresenceTranslations.AgentParams;

type BrowserPresenceTranslations = Shared_browserPresenceTranslations.BrowserPresenceTranslations;

const browserPresenceTranslations = { ja: {
        agentFallbackName: 'エージェント',
        agentBrowsing: ({ agent }) => `${agent} がブラウズ中`,
        clickTarget: ({ target }) => `「${target}」をクリックしています`,
        doing: {
            click: 'ページをクリックしています',
            type: '入力しています',
            fill: 'フィールドに入力しています',
            scroll: 'スクロールしています',
            navigate: 'ページを開いています',
            history: '履歴を移動しています',
            reload: 'ページを再読み込みしています',
            press: 'キーを押しています',
            select: 'オプションを選んでいます',
            drag: 'ドラッグしています',
            upload: 'ファイルをアップロードしています',
            look: 'ページを確認しています',
            other: 'ページで作業しています',
        },
        takeControl: '操作を代わる',
        stopping: ({ agent }) => `${agent} を停止しています…`,
        stoppingDetail: '最後の操作を終えています',
        lastActionMayHaveLanded: ({ agent }) => `${agent}の最後の操作は実行された可能性があります`,
        youHaveControl: 'あなたが操作中',
        stopUnconfirmed: '停止を確認できませんでした',
        checkAgain: 'もう一度確認',
        pausedUntilHandBack: ({ agent }) => `操作を戻すまで ${agent} は一時停止します`,
        handBack: '操作を戻す',
        stream: {
            connectingTitle: ({ agent }) => `${agent} のブラウザに接続しています`,
            connectingBody: ({ machine }) => `${machine} で動作しています。最初のフレームが届くとここにページが表示されます。`,
            preparingTitle: 'ブラウザーを準備しています…',
            preparingBody: 'このマシンに Chromium をダウンロードしています。これは一度だけです。準備ができるとページが開きます。',
            openingPage: 'ページを開いています…',
            pageOpened: 'ページを開きました。',
            installFailedTitle: 'ブラウザーを準備できませんでした',
            sandboxAllow: 'ブラウザーのサンドボックスを許可',
            sandboxAllowedTitle: 'ブラウザーのサンドボックスは許可されています',
            sandboxAllowedBody: ({ agent }) => `${agent} のブラウザーを起動できるようになりました。${agent} にもう一度ページを開くよう伝えてください。`,
            sandboxPermissionTitle: 'システム権限を待っています',
            sandboxPermissionBody: 'そのマシンでシステム権限を承認する必要があります。そのあと、もう一度サンドボックスを許可してください。',
            sandboxFailedBody: 'このマシンでサンドボックスを許可できませんでした。しばらくしてからもう一度お試しください。',
            stalled: '最後のフレームを表示中 · 再接続しています',
            endedTitle: ({ agent }) => `${agent} がこのブラウザを閉じました`,
            endedBody: 'このページはここには表示されなくなりました。',
            openPageHere: "ここでページを開く",
            unavailableTitle: ({ agent }) => `${agent} のブラウザをここに表示できません`,
            setupTitle: ({ agent }) => `${agent} のブラウザーはまだセットアップされていません`,
            unavailableBody: ({ agent }) => `${agent} はブラウズを続けています。操作は引き続きチャットに表示されます。`,
            tryAgain: '再試行',
            inputA11y: 'ページ。タップ、スクロール、入力で操作を代われます。',
        },
        recording: {
            elapsedA11y: ({ elapsed }) => `録画中、${elapsed}`,
            discard: '録画を破棄',
        },
        openInYourBrowser: 'ブラウザで開く',
        slowPage: 'このページの読み込みに時間がかかっています',
        confidentialHeld: ({ agent }) => `ここに非公開の入力があります · ページを閉じるまで${agent}には見えません`,
        closePage: 'ページを閉じる',
    } } satisfies Pick<Record<string, BrowserPresenceTranslations>, "ja">;

return { browserPresenceTranslations };
})();

const Domain_browserToolTranslations = (() => {
type TargetParams = Shared_browserToolTranslations.TargetParams;

type BrowserToolTranslations = Shared_browserToolTranslations.BrowserToolTranslations;

const browserToolTranslations = { ja: {
        opened: ({ page }) => `${page} を開きました`,
        openedPage: 'ページを開きました',
        reloaded: 'ページを再読み込みしました',
        wentBack: '前に戻りました',
        wentForward: '次に進みました',
        clicked: ({ target }) => `${target} をクリックしました`,
        clickedPage: 'ページをクリックしました',
        typedInto: ({ target }) => `${target} に入力しました`,
        typed: 'ページに入力しました',
        filledIn: ({ target }) => `${target} を入力しました`,
        filled: 'フィールドを入力しました',
        pressed: ({ key }) => `${key} を押しました`,
        pressedKey: 'キーを押しました',
        scrolled: 'ページをスクロールしました',
        pointedAt: ({ target }) => `${target} を指しました`,
        pointed: 'ページを指しました',
        choseIn: ({ target }) => `${target} でオプションを選びました`,
        chose: 'オプションを選びました',
        uploadedTo: ({ target }) => `${target} にファイルをアップロードしました`,
        uploaded: 'ファイルをアップロードしました',
        dragged: ({ target }) => `${target} をドラッグしました`,
        draggedPage: 'ページ上でドラッグしました',
        looked: 'ページを確認しました',
        screenshot: 'スクリーンショットを撮りました',
        recordingStarted: 'ページの録画を開始しました',
        recordingStopped: '録画を停止しました',
        other: 'ブラウザを使いました',
        watch: '見る',
        watchA11y: 'このページをブラウザで開く',
    } } satisfies Pick<Record<string, BrowserToolTranslations>, "ja">;

return { browserToolTranslations };
})();

const Domain_changedFileEvidenceTranslations = (() => {
type ChangedFileEvidenceTranslations = Shared_changedFileEvidenceTranslations.ChangedFileEvidenceTranslations;

const en = Shared_changedFileEvidenceTranslations.en;

const translated = Shared_changedFileEvidenceTranslations.translated;

const changedFileEvidenceTranslations = { ja: {
        changedFileEvidence: translated({
            before: '変更前',
            after: '変更後',
            binary: 'バイナリファイル',
            truncated: '証跡の内容は上限で打ち切られました。元のサイズと変更統計は利用できる場合に保持されます。',
            truncatedOldBytes: ({ count }) => `元の変更前の内容: ${count} バイト`,
            truncatedNewBytes: ({ count }) => `元の変更後の内容: ${count} バイト`,
            truncatedDiffBytes: ({ count }) => `元の差分: ${count} バイト`,
            truncatedAddedLines: ({ count }) => `追加された行: ${count}`,
            truncatedRemovedLines: ({ count }) => `削除された行: ${count}`,
            kind: {
                added: '追加',
                modified: '変更',
                deleted: '削除',
                renamed: '名前変更',
                copied: 'コピー',
                unknown: '変更種別は利用できません',
            },
            howDetermined: '判定方法',
            howDeterminedForFile: ({ path }) => `${path} の判定方法`,
            content: {
                exact: 'リポジトリの正確な変更',
                strong: '強い内容証跡',
                best_effort: 'ベストエフォートの内容証跡',
            },
            attribution: {
                session_exact: 'このセッションに紐付け済み',
                session_likely: 'このセッションが変更した可能性が高い',
                session_possible: 'このセッションが変更した可能性がある',
                unknown: 'セッションの帰属は判定できません',
            },
            reason: {
                provider_correlated: 'エージェントがこのターンの変更として報告しました。',
                canonical_tool_correlated: '差分またはパッチツールがこの変更をこのターンに紐付けました。',
                checkpoint_no_happier_overlap_observed: 'チェックポイントはこのプロセス内で重複する Happier のターンを記録していません。',
                checkpoint_overlap_observed: '別の Happier のターンがチェックポイントの取得区間と重複しました。',
                workspace_touched_path: 'このパスはワークスペースで変更されましたが、変更したセッションは特定できません。',
                unavailable: 'どのセッションがこの変更を行ったかは証跡から判定できません。',
            },
            overlap: {
                observed: '取得中に別の Happier のターンがこのチェックアウトと重複しました。観測対象はこのプロセスのみで、他のプロセスや外部の書き込みは追跡されません。',
                not_observed: 'このプロセス内では重複する Happier のターンは観測されませんでした。他のプロセスや外部の書き込みは追跡されないため、単独の作成者であることを示すものではありません。',
                unknown: 'チェックポイントの重複は不明です。他のプロセスや外部の書き込みは追跡されません。',
            },
            sources: {
                provider_native: 'エージェント固有の変更レポート',
                provider_tool: 'エージェントツールのレポート',
                canonical_diff_tool: '差分ツールの証跡',
                canonical_patch_tool: 'パッチツールの証跡',
                scm_checkpoint: 'リポジトリのチェックポイント',
                scm_reconciled: '照合済みのリポジトリスナップショット',
                inferred: 'ワークスペースで変更されたパス',
            },
        }),
    } } as const;

return { changedFileEvidenceTranslations };
})();

const Domain_cliPathExposureTranslations = (() => {
const en = Shared_cliPathExposureTranslations.en;

const ja = {
    title: 'コマンドライン',
    footer: 'Happier Desktop は自分が作成した PATH エントリだけを追加・削除します。シェルのインストーラーが書き込んだエントリはそのままです。',
    addTitle: 'happier を PATH に追加',
    addSubtitle: '新しいターミナルで happier コマンドを使えるようにします。',
    removeTitle: 'happier を PATH から削除',
    removeSubtitle: 'Happier Desktop が追加した PATH エントリだけを削除します。',
    working: 'シェルプロファイルを更新しています…',
    added: '追加しました。新しいターミナルを開くと happier を使えます。',
    alreadyPresent: 'happier はすでに PATH にあります。',
    removed: 'Happier Desktop が追加した PATH エントリを削除しました。',
    nothingToRemove: 'Happier Desktop は PATH エントリを追加していません。',
};

const cliPathExposureTranslations = { ja: ja };

return { cliPathExposureTranslations };
})();

const Domain_cliTrustPromptTranslations = (() => {
const en = Shared_cliTrustPromptTranslations.en;

const ja = {
    title: 'このコマンドラインを承認しますか？',
    body: ({ command }: { command: string }) => `${command} のコマンドラインは Happier がインストールしたものではありません。承認すると、このアカウントのセッションを読み書きできるようになります。自分で配置したものだけを承認してください。`,
    bodyUnknownCommand: 'このコマンドラインは Happier がインストールしたものではありません。承認すると、このアカウントのセッションを読み書きできるようになります。自分で配置したものだけを承認してください。',
    approve: '承認',
};

const cliTrustPromptTranslations = { ja: ja };

return { cliTrustPromptTranslations };
})();

const Domain_commitProposalTranslations = (() => {
type Count = Shared_commitProposalTranslations.Count;

type CommitProposalCopy = Shared_commitProposalTranslations.CommitProposalCopy;

const en = Shared_commitProposalTranslations.en;

const commitProposalTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', { commitProposal: CommitProposalCopy }>>, "ja"> = { ja: { commitProposal: {
        title: ({ count }) => `保留中の変更に ${count} 件のコミット`,
        titlePhone: ({ count }) => `${count} 件のコミット`,
        proposedBy: ({ who, committed, total }) => `${who} の提案 · ${total} ファイル中 ${committed} · 各コミットが前のコミットに積み上がる順序。`,
        filesInCommits: ({ committed, total }) => `${total} ファイル中 ${committed} がこれらのコミットに含まれます`,
        proposedByPhone: ({ committed, total }) => `保留中 ${total} ファイル中 ${committed} · 変更をタップして移動。`,
        moveHint: ({ max }) => `変更は ⌥1–${max} またはメニューで移動できます。`,
        modelFallback: 'モデル',
        regenerate: '再生成',
        conflict: '提案が別の場所で変更されました。最新の内容を表示しています。もう一度変更してください。',
        approvalPending: 'これらのコミットを作成する承認を待っています。',
        discardBody: '提案を削除します。保留中の変更はそのまま残ります。', askFix: ({ hook, number, message }) => `${hook} フックがコミット ${number}「${message}」を止めました。コミットが通るように、報告された内容を修正してください:`, askFixGeneric: ({ number, message }) => `フックがコミット ${number}「${message}」を止めました。コミットが通るように、報告された内容を修正してください:`, discarded: '提案を破棄しました。', undo: '元に戻す',
        fileCount: ({ count }) => `${count} ファイル`,
        part: ({ count, of }) => `${of} 件中 ${count} 件の変更`,
        move: { a11y: ({ file }) => `${file} を別のコミットへ移動`, title: ({ file }) => `${file} の移動先`, newCommitAfter: ({ number }) => `${number} の後に新しいコミット`, newCommitMessage: ({ file }) => `${file} を更新`, leaveOut: 'これらのコミットから外す', leaveOutHint: '作業ツリーに残ります' },
        group: { a11y: ({ number, message }) => `コミット ${number}: ${message}`, editMessage: 'メッセージを編集', messageA11y: ({ number }) => `コミット ${number} のメッセージ`, more: 'その他', moveUp: '上へ', moveDown: '下へ', mergeWithNext: '次のコミットと統合', empty: 'まだ変更がありません。ここへ移動するか、次のコミットと統合してください。' },
        leftOut: { title: '除外 · 作業ツリーに残ります', description: 'これらの変更は保留のままです。必要なら別途コミットしてください。' },
        footer: { commits: ({ count }) => `${count} 件のコミット`, onBranch: ({ branch }) => `（${branch}）· フックと署名は通常のコミットと同じく実行されます`, detached: '（切り離された HEAD）· フックと署名は通常のコミットと同じく実行されます', phone: 'フックと署名はいつも通り', discard: '提案を破棄', create: ({ count }) => `${count} 件のコミットを作成`, createShort: ({ count }) => `${count} 件を作成`, emptyGroupReason: '変更のないコミットがあります。変更を移動するか統合してください。' },
        applying: { title: ({ count }) => `${count} 件のコミットを作成中`, body: '通常のコミット経路で 1 件ずつ作成するため、フックと署名はいつも通り実行されます。完了まで編集は一時停止します。', bodyPhone: '完了まで編集は一時停止します。', created: ({ landed, total }) => `${total} 件中 ${landed} 件`, createdRest: '作成済み · 後のコミットが止まっても何も取り消されません', createdRestPhone: '作成済み', stopAfterThis: 'このコミットの後で停止', stopAfterThisShort: 'この後で停止', stopping: 'このコミットの後で停止します' },
        state: { waiting: '待機中', writing: 'フックを実行してコミットを作成中', landed: 'コミット済み', landedAt: ({ time }) => `${time} にコミット`, signed: '署名済み', pausedBy: ({ hook, count }) => `${hook} が ${count} ファイルを変更 · まだコミットされていません`, hookFailedBy: ({ hook }) => `${hook} が失敗 · 未コミット`, rewritten: 'フックがメッセージを書き換えました', notCreated: '未作成 · まだ編集できます', notCreatedShort: '未作成', unknown: '未確認', paused: ({ count }) => `フックが ${count} ファイルを変更 · まだコミットされていません`, failed: 'ここで停止 · 未コミット' },
        outcome: { signingTitle: '現在コミットに署名できません。', signingBody: 'このリポジトリはすべてのコミットに署名します。何もコミットされていません。', signingHint: '先に GPG または SSH エージェントのロックを解除してください', tryAgain: '再試行', cancel: 'キャンセル', hookChanged: ({ files }) => `フックが ${files} を変更しました。`, waitsAfterLanded: ({ count }) => `${count} 件のコミットが完了しました。このコミットはあなたを待っています。`, waits: 'このコミットはあなたを待っています。', include: 'フックの変更を含める', includePhone: '含めてコミット', cancelCommit: 'このコミットをキャンセル', hookFailed: 'フックがこのコミットを止めました。', hookChangedBy: ({ hook, files }) => `${hook} が ${files} を変更しました。`, hookFailedBy: ({ hook }) => `${hook} がこのコミットを止めました。`, hookFailedBody: '先のコミットは残ります。残りはまだ編集できます。', headMoved: ({ branch }) => `コミット中に ${branch} が移動しました。`, headMovedBody: '次のコミットは拒否され、何も取り消されていません。', proposeAgain: '残りを再提案', keepEditing: '編集を続ける', askSessionToFix: 'このセッションに修正を依頼', showInGit: 'Git で表示', unknownTitle: 'このコミットが完了したか確認できませんでした。', unknownBody: '確認できるまで再試行しません。ブランチを再確認してください。', checkAgain: '再確認', stoppedTitle: ({ landed, total }) => `${total} 件中 ${landed} 件のコミットを作成`, stoppedBody: ({ count }) => `${count} 件は作成されていません。その変更は以前のまま作業ツリーにあります。`, createRest: ({ count }) => `残り ${count} 件を作成`, completeTitle: ({ count }) => `${count} 件のコミットを作成しました`, completeBody: '何もプッシュされていません。', onBranch: ({ branch }) => `${branch} 上`, failed: { staging_conflict: '別の操作がステージ内容を変更しました。', selection_conflict: 'これらの変更はこのように分割できません。', source_changed: '提案後に保留中の変更が変わりました。', writer_failed: 'コミットを作成できませんでした。', publication_warning: 'コミットは完了しましたが、ステージ済みファイルは更新されませんでした。', cancelled: 'このコミットはキャンセルされました。' }, failedBody: '先のコミットは残ります。何も取り消されていません。' },
        none: { title: 'コミットの提案はまだありません', workingTreeOnly: 'コミット計画は現在のローカルの変更にのみ適用できます。', reason: '提案は保留中の変更を編集可能なコミットにまとめ、通常のコミット経路で 1 件ずつ作成します。', propose: 'コミットを提案', writing: '保留中の変更をまとめています…' },
        gitPane: { title: '提案されたコミット', meta: ({ count, files }) => `${count} · ${files} ファイル`, inCommit: ({ count, number }) => `コミット ${number} に ${count}`, open: '開く', review: '確認', reviewInWalkthrough: 'ウォークスルーで確認', more: '破棄または再生成', selectedHint: '選択中。もう一度タップするとコミットで開きます', tapHint: 'タップして変更を表示' },
    } } };

return { commitProposalTranslations };
})();

const Domain_committedMessageActionTranslations = (() => {
const committedMessageActionTranslations = { "ja": {
        "committedMessageActions": {
            "copy": "コピー",
            "fork": "分岐",
            "rollback": "ロールバック",
            "pin": "ピン留め",
            "savePrompt": "プロンプトとして保存",
            "plugins": "プラグインのアクション",
            "composerButton": "プロンプトライブラリボタン",
            "composerHint": "保存したプロンプトと送信履歴を音声入力の横に表示します。オフでも / メニューからプロンプト… を開けます。",
            "name": "名前",
            "shortcut": "/ ショートカット",
            "savedOpen": "ライブラリに保存済み · 開く",
            "shortcutNotSaved": "プロンプトは保存されましたが、ショートカットは保存できませんでした。ライブラリで開いて追加してください。",
            "wrongAccount": "プロンプトを保存する前に、このセッションの Home に切り替えてください。",
            "savedHintFavorite": "スター付きでライブラリに保存されます。",
            "savedHint": "ライブラリに保存されます。",
            "addShortcut": "/ ショートカットを追加",
            "shortcutPlaceholder": "/shortcut",
            "savedToLibrary": "ライブラリに保存済み",
            "savePromptHint": "プロンプトライブラリから再利用できます",
            "copyHint": "メッセージのテキストをコピーします。",
            "forkHint": "メッセージから新しいセッションを始めます。",
            "rollbackHint": "ワークスペースをメッセージ前の状態に戻します。",
            "pinHint": "メッセージをピン留めして後で戻れます。ピン留めは維持されます。",
            "savePromptSettingHint": "送信したメッセージをライブラリのプロンプトとして保存します。",
            "pluginsHint": "プラグインがメッセージの下に追加するアクションです。"
        }
    } };

return { committedMessageActionTranslations };
})();

const Domain_computerUseTranslations = (() => {
type MachineParams = Shared_computerUseTranslations.MachineParams;

type ComputerUseTranslations = Shared_computerUseTranslations.ComputerUseTranslations;

const computerUseTranslations = { ja: {
        approval: {
            sectionTitle: 'コンピュータ上で',
            act: {
                list: '開いているウィンドウを確認',
                see: 'スクリーンショットを撮る',
                read: 'テキストと操作項目を読む',
                click: 'クリック',
                press: 'キーを押す',
                type: '入力',
                share: 'ウインドウを共有',
            },
            windowOn: ({ machine }) => `${machine} のウィンドウ`,
            screenOf: ({ machine }) => `${machine} の画面全体`,
            windowsOn: ({ machine }) => `${machine} で開いているウィンドウ`,
            window: 'ウィンドウ',
            screen: '画面全体',
            windows: '開いているウィンドウ',
            typedLabel: 'テキスト',
            keyLabel: 'キー',
            listConsequence: '共有されるのは開いているウィンドウの名前だけで、内容は共有されません。',
            seeConsequence: 'スクリーンショットはこのセッションと共有されます。クリックや入力はしません。',
            useConsequence: '端末に届いた入力は取り消せません。いつでも停止できます。',
            targetOn: ({ machine, target }) => `${machine} の ${target}`,
            chooseFirst: '先にウインドウを選んでください',
            cropA11y: ({ target }) => `${target} の最新の画像`,
            suggestsWindow: ({ agent, target }) => `${agent} のおすすめ: 「${target}」`,
        },
        request: {
            title: ({ agent, machine }) => `${agent} が ${machine} のウインドウを使いたがっています`,
            body: 'ウインドウはあなたが選びます。選ぶまで何も共有されません。',
            choose: 'ウインドウを選ぶ',
            change: 'ウインドウを変更',
            shared: ({ target }) => `${target} を共有しました`,
            watch: '見る',
        },
        picker: {
            title: ({ agent }) => `${agent} にウインドウを使わせる`,
            description: ({ agent }) => `${agent} と共有するものをあなたが選びます。`,
            windows: 'ウインドウ',
            screens: '画面全体',
            untitledWindow: '名称未設定のウインドウ',
            screenLabel: ({ index }) => `画面 ${index}`,
            share: 'ウインドウを共有',
            shareScreen: '画面を共有',
            shareApp: ({ app }) => `${app} のウインドウを共有`,
            stopSharing: '共有を停止',
            loadingTitle: ({ machine }) => `${machine} のウインドウを探しています`,
            noScreenTitle: ({ machine }) => `${machine} には共有できる画面がありません`,
            noScreenBody: 'Happier から見えるデスクトップなしで動いています。画面のあるマシンを使ってください。',
            unsupportedTitle: ({ machine }) => `Happier はまだ ${machine} の画面を使えません`,
            unsupportedBody: 'ウインドウの共有は現在 Linux デスクトップで使えます。',
            failedTitle: ({ machine }) => `${machine} のウインドウを一覧にできませんでした`,
            failedBody: 'そこで Happier が動いているか確認して、もう一度お試しください。',
            emptyTitle: ({ machine }) => `${machine} に開いているウインドウはありません`,
            emptyBody: '共有したいウインドウを開いてから、もう一度確認してください。',
            tryAgain: 'もう一度試す',
            inUse: 'ほかのセッションがこのウインドウを使っています。別のものを選んでください。',
            closed: 'そのウインドウは閉じられました。別のものを選んでください。',
            selectFailed: 'そのウインドウを共有できませんでした。もう一度お試しください。',
            otherMachineTitle: ({ machine }) => `${machine} はこのセッションのマシンではありません`,
            otherMachineBody: 'ウインドウを共有できるのは、このセッションが動いているマシンだけです。',
            purpose: ({ session }) => `「${session}」用。`,
            purposeIn: ({ project, session }) => `${project} の「${session}」用。`,
            access: ({ agent }) => `${agent} にできること`,
            accessValue: '見て使う',
            accessSee: '見るだけ',
            accessSeeHint: ({ agent }) => `スクリーンショットは ${agent} に送られます。クリックや入力はできません。`,
            accessUseHint: ({ agent }) => `${agent} は共有したものの中でクリックや入力もできます。`,
            displayUnavailable: 'このコンピュータでは画面全体を共有できません。',
            wholeDisplayBody: ({ display }) => `${display} に表示されているものはすべて見えます。ほかのアプリや通知も含まれます。`,
            policyBoth: ({ agent }) => `${agent} はスクリーンショット、クリック、キー入力のたびに確認します。`,
            policyInput: ({ agent }) => `${agent} はクリックとキー入力のたびに確認します。`,
            policyCapture: ({ agent }) => `${agent} はスクリーンショットのたびに確認します。`,
            policyNone: ({ agent }) => `${agent} はスクリーンショット、クリック、キー入力の前に確認しません。`,
            policyChange: '変更',
            suggests: ({ agent }) => `${agent} のおすすめ`,
            usingIt: 'エージェントが使用中',
            displayShared: '画面上のすべてが共有されます',
            refresh: 'ソースを更新',
            footnote: 'ウィンドウの一覧表示は事前に確認します。ディスプレイ全体の共有はもう一度確認します。',
            wholeDisplayTitle: 'ディスプレイ全体を共有しますか？',
            allowSee: '表示を許可',
            allowUse: 'マウスとキーボードを許可',
            allowUseHint: ({ agent }) => `${agent}はこのディスプレイを操作できます。いつでも操作を取り戻せます。`,
            shareDisplay: 'ディスプレイを共有',
        },
        permission: {
            input: 'アクセシビリティ',
            denied: '未許可',
            opened: ({ machine }) => `${machine} で開きました。そこで Happier を許可してから、もう一度確認してください。`,
            openFailed: 'そこでシステム設定を開けませんでした。そのコンピュータで開いてください。',
            capture: '画面収録',
            captureFor: 'ウインドウを見るため',
            inputFor: 'クリックと入力のため',
            granted: '許可済み',
            unknown: '未確認',
            checkAgain: 'もう一度確認',
            captureTitle: ({ machine }) => `${machine}のウィンドウやディスプレイを表示するには、そこで画面収録を許可してください。`,
            inputTitle: ({ machine }) => `${machine}のマウスとキーボードを使うには、そこでアクセシビリティを許可してください。`,
            unknownTitle: ({ machine }) => `${machine}の画面の権限を確認できませんでした。共有する前にもう一度確認してください。`,
            separateBody: ({ machine }) => `アクセシビリティは別の権限で、そこでマウスとキーボードを使えるようにします。どちらもこのデバイスではなく${machine}で許可します。`,
            onMachineBody: ({ machine }) => `このデバイスではなく${machine}で許可します。`,
            openPrivacy: ({ machine }) => `${machine}でプライバシー設定を開く`,
        },
        presentation: {
            agentUsing: ({ agent, target }) => `${agent} が ${target} を使用中`,
            agentCanUse: ({ agent, target }) => `${agent} は ${target} を使えます`,
            agentCanSee: ({ agent, target }) => `${agent} は ${target} を見ることができます`,
            connectingTitle: ({ target }) => `${target} に接続中`,
            unavailableTitle: '今はこのウインドウを表示できません',
            stopFailed: '共有を停止できませんでした',
            stopping: '共有を停止しています…',
            unavailableBody: ({ agent }) => `ここから ${agent} を止めることはできます。`,
            endedTitle: ({ target }) => `${target} が閉じられました`,
            endedBody: ({ agent }) => `${agent} はもう見ることも使うこともできません。続けるには別のウインドウを選んでください。`,
            stalled: '最後の画像を表示中 · 再接続しています',
            inputA11y: ({ target }) => `${target}、ライブ。クリックまたは入力で操作を引き継ぎます。`,
            notSharedTitle: '共有中のウインドウはありません',
            notSharedBody: ({ agent }) => `${agent} に使わせるウインドウを選んでください。`,
            moreA11y: 'ウインドウのオプション',
            tabFallback: 'コンピュータ',
            sourceComputer: 'コンピュータ',
            sourceBrowser: 'ブラウザ',
            sourceA11y: 'ソース',
            watchingA11y: ({ source, machine }) => `${machine} の ${source} を表示中`,
            expandView: 'ビューを拡大',
            restoreView: 'ビューを元に戻す',
            dockView: 'ビューをドック',
            floatView: 'ビューをフロート表示',
            closeView: 'ビューを閉じる',
            moveView: 'ビューを移動',
            resizeView: 'ビューのサイズを変更',
            moveTopLeft: '左上に移動',
            moveTopRight: '右上に移動',
            moveBottomLeft: '左下に移動',
            moveBottomRight: '右下に移動',
            larger: '大きく',
            smaller: '小さく',
            viewOptions: 'ビューのオプション',
            presentedElsewhereTitle: 'フローティングビューに表示中',
            presentedElsewhereBody: 'ここにドックすると作業の横に置けます。',
            closeHint: 'このビューを閉じます。セッションは続きます。',
            agentWorkingOn: ({ agent, machine }) => `${agent}が${machine}で作業中`,
            watchingSourceA11y: ({ source }) => `${source}を表示中`,
            controlNotAllowed: 'マウスとキーボードの操作は許可されていません',
            seeOnly: 'クリックや入力はできません',
            unconfirmedWarning: ({ agent, target, machine }) => `${machine} が ${agent} のマウスとキーの解放を確認するまで、Happier から ${target} を使うことはできません。`,
            unconfirmedWarningCompact: ({ agent, machine }) => `${machine} が ${agent} のマウスとキーの解放を確認するまでロック中です。`,
            unconfirmedStuckHint: ({ machine }) => `止まっているように見える場合は、${machine} 本体でウインドウを一度クリックしてください。`,
            driverMissing: 'コンピューターのドライバーを利用できません',
            driverInvalid: 'コンピューターのドライバーの修復が必要です',
            driverRepairBody: 'このマシンのネイティブドライバーを再インストールし、現在の権限とソースを確認してください。',
            repairDriver: 'ドライバーを修復',
            geometryChanged: 'ウィンドウが変わりました。使用する前に再度キャプチャしてください。',
            inputUnknown: '最後の入力を確認できませんでした。再確認してください。入力は繰り返しません。',
            paused: ({ time }) => `ストリームは一時停止中 · 最後のフレーム ${time}`,
            offlineTitle: ({ machine }) => `${machine}が応答していません`,
            offlineBody: '表示するには再接続してください。表示してもマシンは起動しません。',
            screenUnavailableTitle: ({ machine }) => `${machine} の画面を表示できません`,
            screenUnavailableBody: 'オンラインですが、デスクトップが応答しませんでした。表示するにはサインイン済みのデスクトップセッションが必要です。',
            openingTitle: ({ target, machine }) => `${machine}で${target}を開いています…`,
            openingBody: '最初の画像が届くとすぐにここに表示されます。',
        },
        strip: {
            using: ({ target }) => `${target} を使用中`,
            on: ({ machine }) => `${machine} 上`,
            stop: '停止',
            paused: ({ agent }) => `${agent} は一時停止中`,
            pausedDetail: ({ target }) => `${target} はあなたが操作中`,
        },
        tool: {
            capture: 'スクリーンショットを撮りました',
            captureRunning: 'スクリーンショットを撮影中',
            query: 'ウインドウのテキストとコントロールを読み取りました',
            queryRunning: 'ウインドウを読み取り中',
            click: 'ウインドウ内をクリックしました',
            clickRunning: 'ウインドウ内をクリック中',
            clickTarget: ({ target }) => `「${target}」をクリック`,
            type: 'ウインドウに入力しました',
            typeRunning: 'ウインドウに入力中',
            typeTarget: ({ target }) => `「${target}」に入力`,
            pressKey: ({ key }) => `${key} を押しました`,
            press: 'キーを押しました',
            pressRunning: 'キーを押しています',
            mayHaveLanded: '反映された可能性があります',
            failed: '完了しませんでした',
        },
    } } satisfies Pick<Record<string, ComputerUseTranslations>, "ja">;

return { computerUseTranslations };
})();

const Domain_connectedServicesCollectionTranslations = (() => {
type ConnectedServicesCollectionCopy = Shared_connectedServicesCollectionTranslations.ConnectedServicesCollectionCopy;

const en = Shared_connectedServicesCollectionTranslations.en;

const ja: ConnectedServicesCollectionCopy = {
    accountLabel: ({ service }) => `${service} アカウント`,
    accountLabelNumbered: ({ service, number }) => `${service} アカウント ${number}`,
    meterResetsIn: ({ time }) => `${time}後`,
    meterNextResetIn: ({ time }) => `次は${time}後`,
    meterResetsAt: ({ countdown, time }) => `${countdown} · ${time}`,
    meterNotReported: '報告なし',
    meterEstimated: ({ value }) => `~${value}`,
    indexTitle: 'すべてのサービス',
    indexDescription: 'エージェントがサインインするアカウントと、それぞれの残量。',
    viewList: 'リスト',
    viewGrid: 'グリッド',
    viewLabel: 'アカウントの表示',
    refreshAll: 'すべて更新',
    refreshUsage: '使用量を更新',
    signedOutConsequence: '再度サインインするまで、セッションはこのアカウントを使えません。',
    poolsGroup: 'プール',
    poolsDescription: 'エージェントが切り替えて使うアカウント。セッション開始時に1つを選び、使い切ると次へ移ります。',
    newPool: '新しいプール',
    poolUsing: ({ account }) => `${account}を使用中`,
    poolPosition: ({ position, count }) => `${count}件中${position}番目`,
    poolInUseNow: '現在使用中',
    inUse: '使用中',
    connectService: 'サービスを接続',
    searchAccounts: 'アカウントを検索',
    servicesGroup: 'サービス',
    railEmpty: 'まだアカウントがありません',
    railKey: 'キー',
    railAccountLabel: ({ service, account }) => `${service} · ${account}`,
    agentSignInTitle: 'エージェントのサインイン方法',
    subscriptionTitle: 'サブスクリプション',
    subscriptionNone: 'サブスクリプションなし',
    subscriptionRenewsIn: ({ days }) => days === 0 ? '本日更新' : `${days}日後に更新`,
    subscriptionEndsIn: ({ days }) => days === 0 ? '更新なし · 本日終了' : `更新なし · ${days}日後に終了`,
    subscriptionPeriodEndsIn: ({ days }) => days === 0 ? '期間は本日終了' : `期間は${days}日後に終了`,
    subscriptionRenewsOn: ({ date, days }) => `${date}に更新 · ${days}日後`,
    subscriptionEndsOn: ({ date, days }) => `更新なし · ${date}（${days}日後）に終了。その後セッションは使用しません。`,
    subscriptionPeriodEndsOn: ({ date, days }) => `期間は${date}に終了 · ${days}日後`,
    renewalOn: 'オン',
    renewalOff: 'オフ',
    renewalUnknown: '不明',
    checkedAt: ({ time }) => `${time}に確認`,
    checkedMayBeOutOfDate: ({ time }) => `${time}に確認 · 古い可能性があります`,
    usageCheckedMayBeOutOfDate: ({ time }) => `${time}に確認 · 古い可能性があります`,
    daysAgo: ({ count }) => `${count}日前`,
    hoursAgo: ({ count }) => `${count}時間前`,
    usageResetsCount: ({ count }) => `使用量リセット ${count}回`,
    usageResetsFirstExpires: ({ date }) => `最初の期限 ${date}`,
    usageResetExpires: ({ date }) => `期限 ${date}`,
    useOne: '1回使う',
    useOneReset: '使用量リセットを使う',
    usageResetsTitle: '使用量リセット',
    usageResetsDescription: 'それぞれすぐに新しい期間を開始します。制限で止まったときのために取っておきましょう。未使用分は期限切れになります。',
    usageResetTitle: '使用量リセット',
    usageResetExpiresOn: ({ date }) => `${date}に期限切れ`,
    use: '使う',
    usedByDefault: 'デフォルト · 新しいセッションはこのアカウントを使用',
    accountIdFact: ({ id }) => `ID ${id}`,
    hideIdentitiesTitle: 'アカウントのメールとIDを隠す',
    hideIdentitiesDescription: '配信やデモ向け。このデバイス上のすべての場所でメールとアカウントIDを隠します。アカウントに付けた名前はそのままです。',
    privacyTitle: 'プライバシー',
    renameTitle: 'このアカウントに名前を付ける',
    renameBody: ({ service }) => `変わるのは Happier での名前だけです。${service} 側の名前はそのままです。`,
    identityHidden: 'メールまたはIDは非表示',
};

const connectedServicesCollectionTranslations = { ja };

return { connectedServicesCollectionTranslations };
})();

const Domain_connectedServicesPoolTranslations = (() => {
type ConnectedServicesPoolCopy = Shared_connectedServicesPoolTranslations.ConnectedServicesPoolCopy;

const en = Shared_connectedServicesPoolTranslations.en;

const ja: ConnectedServicesPoolCopy = {
    strategyExpiryFirst: "期限優先",
    strategyExpiryFirstDescription: "リセットまたは終了が最も早いアカウントを先に使います。",
    leadExpiryFirst: "期限の近いものを優先。",
    membersOn: ({ service, on, total }) => `${service} · ${total} 人中 ${on} 人がオン`,
    rename: '名前を変更',
    moreActions: 'その他の操作',
    defaultFor: ({ agent }) => `${agent} のデフォルト`,
    defaultForMore: ({ agent, count }) => `${agent} のデフォルト +${count}`,
    makeDefault: 'デフォルトにする',
    makeDefaultA11y: 'エージェントのデフォルトにする',
    usingSince: ({ name, time }) => `${time} から ${name} を使用中`,
    using: ({ name }) => `${name} を使用中`,
    noActive: 'まだ使用中のメンバーはありません',
    noActiveDetail: 'セッション開始時にプールが 1 つを選びます。',
    leadLeastLimited: '残量の多い順。',
    leadInOrder: '順番どおり。',
    fallbackOff: ({ name }) => `自動切り替えはオフのため、${name} が上限に達してもセッションはそのままです。`,
    manualStays: ({ name }) => `手動：別のメンバーを選ぶまで ${name} のままです。`,
    switchTo: ({ name }) => `${name} に切り替え`,
    onlyOneOn: ({ name }) => `${name} だけがオンのため、切り替え先がありません。`,
    turnOn: ({ name }) => `${name} をオンにする`,
    allWaitingTitle: 'すべてのメンバーがリセット待ちです',
    allWaitingFirst: ({ name, time, countdown }) => `最初にリセットされるのは ${name}（${time}、${countdown}）。`,
    sessionsWait: 'セッションは待機し、その後自動で再開します。',
    sessionsStop: 'メンバーに余裕ができるまでセッションは停止します。',
    leftTitle: 'プール全体の残り',
    leftDescription: 'オンのメンバーの平均。それぞれ個別にリセットされます。',
    roomCount: ({ count, total }) => `${total} 人中 ${count} 人に余裕があります`,
    notReported: ({ count }) => `${count} 人は未報告`,
    nothingReported: 'オンのメンバーはまだ上限を報告していません。',
    membersTitle: 'メンバー',
    membersDescription: 'ドラッグして順番を決めます。選択したメンバーがアクティブになり、オフのメンバーはスキップされます。',
    membersCompactDescription: '長押ししてドラッグすると並べ替えられます。',
    manage: '管理',
    connectAnotherAccount: ({ service }) => `別の${service}アカウントを接続`,
    membersSelectionSummary: ({ count, total, service }) => `${total}件中${count}件の${service}アカウント`,
    manageMembers: 'メンバーを管理',
    searchAccounts: ({ service }) => `${service} のアカウントを検索`,
    active: 'アクティブ',
    offNotUsed: 'オフの間はプールで使われません',
    autoOffModel: '自動的にオフ · このプランでは選択したモデルを使えません',
    checkedAt: ({ time }) => `${time} に確認`,
    makeActiveA11y: ({ name }) => `${name} をアクティブなメンバーにする`,
    memberOnA11y: ({ name }) => `このプールで ${name} を使う`,
    openA11y: ({ name }) => `${name} を開く`,
    dragA11y: 'ドラッグして並べ替え',
    behaviorTitle: '動作',
    strategyTitle: '選択方法',
    strategyLeastLimited: '残量優先',
    strategyInOrder: '順番どおり',
    strategyManual: '手動',
    strategyLeastLimitedDescription: '使える残量が最も多いメンバーを優先します。',
    strategyInOrderDescription: '上の順番でメンバーを試します。',
    strategyManualDescription: '変更するまでアクティブなメンバーだけを使います。',
    fallbackTitle: '自動切り替え',
    fallbackDescription: 'アクティブなアカウントの復旧が必要なとき、別のメンバーに切り替えます。',
    switchEarlyTitle: '早めに切り替え',
    switchEarlyDescription: '残りがこの割合を下回ると、より新しい残量のあるメンバーに移ります。0 でオフ。',
    autoResetsTitle: 'クォータリセットを自動で使う',
    autoResetsDescription: '準備できたメンバーがいないときだけ、保存済みのリセットを使います。',
    autoOffTitle: '選択したモデルを使えないアカウントをオフにする',
    autoOffDescription: '自分で再度オンにできます。',
    advancedTitle: '詳細',
    advancedCount: ({ count }) => `${count} 件の設定`,
    restoreFirstTitle: 'リセット後に最初のメンバーへ戻る',
    restoreFirstDescription: '切り替え後、最初に並べたメンバーの上限がリセットされたら戻ります。',
    switchWhenTitle: '切り替えるとき',
    switchWhenDescription: 'プールを次のメンバーに移すイベント。',
    staleAfterTitle: '古い使用状況を確認するまで',
    staleAfterDescription: '分。メンバーを選ぶ前に、使用状況がこれより古ければプロバイダーに再度問い合わせます。',
    switchesPerTurnTitle: 'ターンごとの自動切り替え',
    switchesPerHourTitle: 'セッション 1 時間あたりの自動切り替え',
    switchLimitsDescription: 'プールがメンバー間を行き来し続けるのを防ぎます。',
    recoveryTitle: '上限でセッションが止まったとき',
    recoveryDescription: '待機中のセッションに対するプールの動作。',
    recoveryPromptsTitle: '再開メッセージ',
    recoveryPromptsDescription: '切り替えやリセットの後にセッションを再開するとき、Happier は標準メッセージを送ります。',
    usedByTitle: '使用元',
    usedByDefault: 'デフォルト · 新しいセッションはこのプールでサインインします',
    usedByNone: 'まだこのプールをデフォルトにしているエージェントはありません。',
    deleteNote: ({ agents }) => `メンバーは接続されたままです。別のデフォルトを選ぶまで ${agents} は独自のログインに戻ります。`,
    deleteNoteNoAgent: 'メンバーは接続されたままです。',
    emptyTitle: '切り替えるアカウントを追加',
    emptyReason: ({ service }) => `プールはセッション開始時にアカウントを 1 つ選び、上限に達すると次に移ります。${service} のアカウントを 2 つ以上追加してください。`,
    usageNotAnswering: ({ service }) => `${service} が応答しませんでした`,
    newPoolTitle: '新しいプール',
    newPoolDescription: ({ service }) => `エージェントが切り替える ${service} のアカウント。`,
    nameTitle: '名前',
    namePlaceholder: '仕事用プール',
    draftMembersDescription: '切り替えるアカウントを選びます。後で変更できます。',
    create: 'プールを作成',
    discard: '破棄',
};

const connectedServicesPoolTranslations = { ja };

return { connectedServicesPoolTranslations };
})();

const Domain_connectedServicesSettingsTranslations = (() => {
type ConnectedServicesSettingsCopy = Shared_connectedServicesSettingsTranslations.ConnectedServicesSettingsCopy;

const setupFidelityCopy = Shared_connectedServicesSettingsTranslations.setupFidelityCopy;

const en = Shared_connectedServicesSettingsTranslations.en;

const ja: ConnectedServicesSettingsCopy = {
    runtimeNotLoaded: "このサービスはまだマシンに読み込まれていません。プラグインの設定を確認してから更新してください。",
    identityConflict: "マシン間でこのサービスの情報が一致していません。各マシンのプラグインを更新してからページを更新してください。",
    ...setupFidelityCopy,
    accountCount: ({ count }) => `${count} 件のアカウント`,
    defaultAccount: ({ name }) => `デフォルト: ${name}`,
    poolCount: ({ count }) => `${count} 件のプール`,
    noAccountsYet: 'アカウントはまだありません',
    needsSignIn: 'サインインが必要',
    signInAgain: '再度サインイン',
    addAccount: 'アカウントを追加',
    connectAnotherTitle: '別のサービスを接続',
    connectFirstTitle: 'サービスを接続',
    connectNames: ({ names }) => `${names}。`,
    connectNamesMore: ({ names, count }) => `${names} ほか ${count} 件。`,
    connect: '接続',
    emptyTitle: '接続できるサービスはまだありません',
    servicesTitle: 'サービス',
    emptyNoServiceOnMachine: ({ machine }: { machine: string }) => `${machine} のエージェントには、まだサインインに使えるサービスがありません。サブスクリプションを使うエージェントがここに追加します。`,
    emptyNoMachineOnline: 'オンラインのマシンがありません。マシンがオンラインになると、そこで動くエージェントのサービスが表示されます。',
    emptyOpenAgents: 'エージェントを開く',
    emptyAction: 'マシンを開く',
    projectionErrorTitle: 'マシンからサービスを読み込めませんでした',
    projectionErrorDescription: 'アカウントは引き続き表示されます。追加できるサービスは、マシンが応答すると表示されます。',
    loadingServices: 'マシン上のサービスを探しています…',
    usageTitle: 'アカウントの使われ方',
    usageDescription: 'セッション開始時に各エージェントがサインインするアカウントと、セッション間で共有される内容。',
    sharingTitle: '状態の共有',
    sharingSummary: ({ config, state }) => `${config} · ${state}`,
    configLinkedShort: 'リンク',
    configCopiedShort: 'コピー',
    configIsolatedShort: '分離',
    stateSharedShort: 'セッションを共有',
    stateIsolatedShort: 'セッションを分離',
    perAgentTitle: 'エージェントごとの共有',
    perAgentDescription: '特定のエージェントでこれらの既定値を上書きします。',
    perAgentPurpose: '接続アカウントのセッションが自分のサインインと何を共有するかを、エージェントごとに選びます。',
    servicePurpose: ({ service }) => `${service} へのサインインに使うアカウントと、それらを共有するプール。`,
    chooseMachineDescription: 'アカウントの追加、サインイン、削除はいずれかのマシン上で行われます。アカウントは「接続済みサービス」に引き続き表示されます。',
    accountMachineInvitation: '再サインインとこのアカウントの削除は、あなたのマシンのいずれかで実行されます。',
    newAccountTitle: '新しいアカウント',
    newAccountDescription: 'サインイン方法を選択してください。',
    newAccountInProgress: '下でサインインを完了してください。',
    modeBrowser: 'ブラウザでサインイン',
    modeDeviceCode: 'コードでサインイン',
    modeManual: 'トークンを入力',
    serviceSettingsTitle: 'サービス設定',
    serviceSettingsDescription: 'このサービスのすべてのアカウントがサインインに使う設定。',
    noAccountsDescription: 'エージェントがサインインできるようにアカウントを追加してください。',
    accountDetailsTitle: 'アカウントの詳細',
    poolEmptyTitle: 'このプールにアカウントを追加',
    poolEmptyDescription: 'プールは、あるアカウントが上限に達するとセッションを次のアカウントに移します。下でアカウントを選択してください。',
    agentDefaultsTitle: 'エージェントごとのデフォルトアカウント',
    agentDefaultsDescription: 'セッション開始時に各エージェントがサインインするアカウント。',
    agentDefaultsKeywords: 'デフォルトアカウント',
    namesAnd: ({ names, last }) => `${names}、${last}`,
    usedBy: ({ names }) => `${names} が使用`,
    poolRuleMostLeft: '残りが最も多いものを使用',
    poolRuleInOrder: '順番に使用',
    poolRuleManual: '手動で切り替え',
    poolInUse: ({ pool }) => `${pool} · 使用中`,
    agentDefault: ({ agent }) => `${agent} の既定`,
    signedOutBy: ({ service }) => `${service} によりサインアウトされました`,
    usageReadFailed: '使用量を読み取れませんでした',
    usageWindowPin: ({ meter }: { meter: string }) => `${meter} を入力欄の横に表示`,
    noLimitsBilledPerUse: '上限の報告なし · 従量課金',
    needsYouCount: ({ count }) => `${count} 件の対応が必要`,
    connectToolsTitle: 'コードホストやツールを接続',
    inviteTitle: ({ names }) => `エージェントは ${names} も使えます`,
    inviteWhoOne: ({ agents }) => `${agents} がこれでサインインできます。`,
    inviteWhoMany: ({ agents }) => `${agents} がこれらでサインインできます。`,
    inviteTools: 'またはコードホストやツールを接続できます。',
    firstRunTitle: 'すでに支払っているプランを使う',
    firstRunPromise: 'Claude または ChatGPT のアカウントを一度接続するだけ。エージェントはどのマシンでもそれを使い、Happier は上限に達する前に残りを表示します。',
    connectAnAccount: 'アカウントを接続',
    firstRunMeanwhile: 'それまでは、各エージェントが各マシンで自身のログインを使います。',
    agentAccountsTitle: 'エージェントのアカウント',
    agentAccountsDescription: 'エージェントが使うサブスクリプションとキー。アカウントに保存されるので、どのマシンでも使えます。',
    codeAndToolsTitle: 'コードとツール',
    setupChooseMachine: 'サインインするマシンを選んでください。その後、アカウントはすべてのマシンで使えます。',
    setupHowToSignIn: 'サインイン方法',
    setupRecommendedMethod: ({ method }) => `${method} · おすすめ`,
    setupCatalogTitle: 'サービスを接続',
    setupCatalogPurpose: 'サインインは選んだマシンで行われます。その後、アカウントはすべてのマシンで使えます。',
    setupServiceTitle: ({ service }) => `${service} を接続`,
    setupReconnectTitle: ({ service }) => `${service} に再サインイン`,
    setupServicePurpose: ({ agents, service }) => `${agents} がすべてのマシンで ${service} アカウントを使います。`,
    setupServicePurposeNoAgents: 'アカウントはすべてのマシンで使えます。',
    setupForYourAgents: 'エージェント向け',
    setupOwnLoginTitle: 'マシンでサインイン済みですか？',
    setupOwnLoginBody: 'エージェント自身のログインを使い続けられます。「アカウントの使われ方」で選んでください。',
    setupToolsTitle: 'コードホストとツール',
    setupProvidersPointer: 'OpenRouter や Ollama などのモデルプロバイダーは「プロバイダー」で設定します。',
    setupOpenProviders: 'プロバイダーを開く',
    setupTrust: 'アカウントに保存され、あなたのマシンだけが使います。Happier がサインインを最新に保ちます。',
    setupConnectedCount: ({ count }) => `${count} 件接続済み`,
    settleConnectedAs: ({ identity }) => `${identity} として接続しました。`,
    settleConnected: '接続しました。',
    settleUseFor: ({ agent }) => `${agent} で使いますか？`,
    settleUseForAction: ({ agent }) => `${agent} で使う`,
    notNow: '今はしない',
    homeInvitePromise: 'Claude または ChatGPT を一度接続するだけ。どのマシンでも使え、残りはここで確認できます。',
    homeInviteHide: '非表示',
    homeNextWho: ({ agents }) => `${agents} も使えます`,
    oauthStepOpen: 'ブラウザでサインインページを開く',
    oauthStepApprove: '承認し、表示されたコード（または移動先のアドレス）をコピー',
    oauthStepPaste: 'ここに貼り付け',
    oauthPastePlaceholder: 'コードまたはアドレスを貼り付け',
    oauthShapeOk: 'サインインコードのようです',
    deviceEnterAt: ({ where }) => `${where} でこのコードを入力`,
    deviceExpired: 'コードの有効期限が切れました。何も保存されていません。',
    deviceExpiresIn: ({ time }) => `コードの有効期限まで ${time}`,
    deviceNewCode: '新しいコードを取得',
    detailSignedOutTitle: ({ service }) => `${service} がこのアカウントをサインアウトしました`,
    detailSignedOutBody: 'パスワード変更などでサインインが取り消されたか変更されました。再度サインインするまで、セッションはこのアカウントを使えません。',
    detailSignInTitle: 'サインイン',
    detailSignInNeeded: '再サインインが必要',
    detailSignInKeptFresh: 'Happier が最新に保ちます',
    detailLastUsed: ({ time }) => `最終使用 ${time}`,
    detailLeavePool: ({ pool }) => `${pool} から外す…`,
    detailRemovePooledNote: ({ pool }) => `${pool} がこのアカウントを使っています。先にプールから外してください。削除するとアカウントとすべてのマシンから消えます。`,
    detailUsageSignedOut: '最終取得値 · サインアウト中は更新できません',
    detailUsageSignedOutAt: ({ time }: { time: string }) => `${time}の最終取得値 · サインアウト中は更新できません`,
    detailResetsIn: ({ countdown }) => `あと ${countdown}`,
    detailUsedByTitle: '使用中のエージェント',
    detailUsedByDefault: '既定のアカウント',
    detailUsedByPool: ({ pool }) => `${pool} 経由`,
    detailUsedByPoolInUse: ({ pool }) => `${pool} 経由 · 現在使用中`,
    detailUsedByCould: '使用可能 · 現在は別の方法でサインイン',
    detailWorksOnTitle: '使えるマシン',
    detailWorksOnDescription: 'アカウントに保存されています。マシンはそこでセッションが始まるときに使い、事前にコピーされることはありません。',
    detailSignedInWithCode: 'コードでサインイン済み',
    detailSignedInWithBrowser: 'ブラウザでサインイン済み',
    detailAddedWithKey: 'キーで追加済み',
    nearLimitTitle: ({ account, percent, window }) => `${account} の ${window} 上限の残りは ${percent}%`,
    nearLimitTitleNoAccount: ({ percent, window }) => `${window} 上限の残りは ${percent}%`,
    nearLimitBodyWithReset: ({ time }) => `${time} にリセットされます。今すぐ続けるには使用量リセットを適用してください。`,
    nearLimitBody: '今すぐ続けるには使用量リセットを適用してください。',
    nearLimitApplyReset: '使用量リセットを適用',
    catalogSignInBrowserOrCode: 'ブラウザまたはコードでサインイン',
    catalogSignInBrowserOrKey: 'ブラウザでサインイン、またはトークンを貼り付け',
    catalogSignInBrowser: 'ブラウザでサインイン',
    catalogSignInCode: 'コードでサインイン',
    catalogPasteKey: 'キーを貼り付け',
    deviceOpenService: ({ service }) => `${service} を開く`,
    deviceWaitingFor: ({ service }) => `${service} での承認を待っています…`,
};

const connectedServicesSettingsTranslations = { ja };

return { connectedServicesSettingsTranslations };
})();

const Domain_connectedServicesSetupTranslations = (() => {
type ConnectedServicesSetupTranslation = Shared_connectedServicesSetupTranslations.ConnectedServicesSetupTranslation;

const connectedServicesSetupTranslations = { ja: {
        connectMoreTitle: 'さらに接続',
        connectMoreDescription: 'マシン上のエージェントが使えるのに、まだ接続していないサービスです。',
        connectMoreNothingNew: '別のアカウント、コードホスト、ツールを追加できます。',
        serviceSignInInstead: ({ agents }) => `${agents} は各マシンでのログインの代わりにこれでサインインできます。`,
        serviceCanUse: ({ agents }) => `${agents} が使えます。`,
        moreServicesTitle: 'その他のサービス',
        moreServicesTools: ({ names }) => `${names} など、コードとツール用。`,
        moreServicesAll: 'エージェントとツールが使えるすべてのサービス。',
        browse: '一覧',
        notNow: ({ service }) => `今はしない: ${service}`,
        notNowTooltip: '今はしない · 一覧には残ります',
        back: 'すべてのサービス',
        homeCatalogTitle: 'アカウントを接続',
        homeCatalogPurpose: 'エージェントはすべてのマシンで使い、Home に残量が表示されます。',
        homeNextSubtitle: ({ agents }) => `${agents} は各マシンでのログインの代わりに使えます。`,
        firstRunMore: 'API キー、コードホスト、ツール',
        settleAddToPoolWhy: ({ pool, agent, active }) => `${pool} に追加して、${active} を使い切ったら ${agent} がこれに切り替わるようにしますか?`,
        settleAddToPoolShort: ({ pool }) => `${pool} に追加しますか?`,
        settleAddToPool: ({ pool }) => `${pool} に追加`,
        deviceStepCopy: 'このコードをコピー',
        deviceStepOpen: ({ service }) => `${service} を開いて入力`,
        deviceStepOpenWhere: ({ where }) => `${where}、使いたいアカウントでサインインした状態で`,
        deviceStepApprove: ({ service }) => `${service} で Happier を承認`,
        deviceCheckNow: '今すぐ確認',
    } } satisfies Pick<Readonly<Record<string, ConnectedServicesSetupTranslation>>, "ja">;

return { connectedServicesSetupTranslations };
})();

const Domain_detailPageTranslations = (() => {
type DetailPageTranslations = Shared_detailPageTranslations.DetailPageTranslations;

const detailPageTranslations = { ja: {
        approval: {
            requestTitle: 'リクエスト',
            requestDescription: '依頼された内容と現在の状況です。',
            failureTitle: '失敗した理由',
            homeUnavailableTitle: 'Home を利用できません',
            contextTitle: '依頼元',
            contextDescription: 'このリクエストを出したセッションとエージェントです。',
            sessionOnHome: ({ home }) => `${home} 上のセッション`,
            sessionElsewhere: 'このデバイスにないセッション',
            requesterYou: 'あなた',
            origin: {
                voice: '音声で依頼',
                agent: 'エージェントが依頼',
                mcp: '接続されたツール経由で依頼',
                cli: 'コマンドラインから依頼',
                ui: 'アプリ内で依頼',
                api: 'API 経由で依頼',
                plugin: 'プラグインが依頼',
                workflowRun: 'ワークフロー実行が依頼',
                system: 'Happier が依頼',
            },
            proposalsDescription: '承認するとレビューに投稿されます。',
            requester: {
                title: '確認する人',
                descriptionYou: 'あなたが依頼したので、あなたが確認します。',
                descriptionOther: ({ name }) => `${name}が依頼したため、確認できるのはその人だけです。`,
                askedBy: '依頼者',
                anotherPerson: '別のユーザー',
                waitingFor: ({ name }) => `${name}の確認を待っています`,
                confirmedBy: '確認した人',
                declinedBy: '拒否した人',
                thread: {
                    youConfirm: 'あなたが依頼したので、あなたが確認します',
                    review: '確認して承認…',
                    decline: '断る',
                    waiting: ({ name }) => `${name}の確認を待っています。依頼した人だけが確認できます。`,
                    using: ({ label }) => `${label}を使用`,
                    usingAccount: '接続済みアカウントを使用',
                    usingTeam: 'チームの設定を使用',
                    ownerAccount: ({ name }) => `所有者: ${name}`,
                    ownerTeam: ({ name }) => `所有者: チーム${name}`,
                    ownerTeamUnnamed: '所有者: チーム',
                    why: 'この種の書き込み用に設定済み',
                    confirmedPending: ({ name }) => `${name}が確認済み · 結果を待っています`,
                    done: ({ name }) => `完了 · ${name}が確認`,
                    declined: ({ name }) => `${name}が断りました · 何も書き込まれていません`,
                    canceled: 'キャンセル · 何も書き込まれていません',
                    uncertain: '実行されたかまだわかりません。もう一度確認しないでください。',
                    failed: '実行できませんでした',
                },
            },
        },
        runs: {
            description: 'マシン上のバックグラウンド実行です。',
            filterLabel: '表示する実行',
            filterRunning: '実行中',
            filterAll: 'すべて',
            onHome: ({ home }) => `${home} 上`,
        },
        person: {
            placeholderTitle: 'ユーザー',
            friendshipTitle: 'フレンド',
            sharedSessionsDescription: 'このフレンドが共有しているセッション（閲覧のみ）。',
            linkedAccountsTitle: 'リンクされたアカウント',
            linkedAccountsDescription: '他のサインイン先です。ブラウザで開きます。',
        },
        friendsManage: {
            description: 'Happier で一緒に作業する人と、お互いのリクエストです。',
            requestsTitle: 'フレンドリクエスト',
            requestsDescription: 'リクエストを開いて承認または拒否します。',
            sentTitle: '送信したリクエスト',
            sentDescription: '相手の承認待ちです。',
            friendsTitle: 'フレンド',
            friendsDescription: 'フレンドを開くと、共有されている内容を確認できます。',
        },
    } } as const satisfies Pick<Record<string, DetailPageTranslations>, "ja">;

return { detailPageTranslations };
})();

const Domain_detailsChromeTranslations = (() => {
type DetailsChromeTranslations = Shared_detailsChromeTranslations.DetailsChromeTranslations;

const detailsChromeTranslations = { ja: {
        closeUnsavedTabA11y: 'タブを閉じる（未保存の変更があります）',
        emptyTitle: 'ファイル、変更、コミットはここで開きます',
        browseFiles: 'ファイルを参照',
        previewHint: '1 回クリックするとプレビューが開きます。もう一度開くと保持されます。',
        emptyReason: '開いたファイル、変更、コミットは、開いた場所の隣のここに表示されます。',
        reviewChanges: ({ count }) => `${count} 件の変更を確認`,
        reviewChangesReason: ({ count }) => `このセッションで ${count} 個のファイルが変更されました。会話を離れずにここで確認できます。`,
        splitNeedsWiderPane: '左右に並べて表示するには、もっと広いパネルが必要です。詳細を広げるか、フォーカスを使ってください。',
    } } satisfies Pick<Record<string, DetailsChromeTranslations>, "ja">;

return { detailsChromeTranslations };
})();

const Domain_detailsFileTranslations = (() => {
type DetailsFileTranslations = Shared_detailsFileTranslations.DetailsFileTranslations;

const detailsFileTranslations = { ja: {
        areaUnstaged: '未ステージ',
        areaStaged: 'ステージ済み',
        areaBoth: '両方',
        areaLabel: '変更',
        preview: 'プレビュー',
        viewLabel: '表示',
        compare: '比較',
        stage: 'ステージ',
        unstage: 'ステージ解除',
        addToCommit: 'コミットに追加',
        removeFromCommit: 'コミットから外す',
        editing: '編集中',
        editingUnsaved: '編集中 · 未保存の変更',
        statusModified: '変更あり',
        statusAdded: '追加',
        statusDeleted: '削除',
        statusRenamed: '名前変更',
        statusCopied: 'コピー',
        statusUntracked: '新規（未追跡）',
        statusConflicted: '競合あり',
        noChanges: '変更なし',
        lines: ({ count }) => `${count} 行`,
    } } satisfies Pick<Record<string, DetailsFileTranslations>, "ja">;

return { detailsFileTranslations };
})();

const Domain_detailsHistoryTranslations = (() => {
type Count = Shared_detailsHistoryTranslations.Count;

type Branch = Shared_detailsHistoryTranslations.Branch;

type Folder = Shared_detailsHistoryTranslations.Folder;

type DetailsHistoryTranslations = Shared_detailsHistoryTranslations.DetailsHistoryTranslations;

const detailsHistoryTranslations = { ja: {
        copyCommitSha: 'コミット SHA をコピー',
        filesChanged: ({ count }) => `${count} 個のファイルを変更`,
        files: ({ count }) => `${count} 個のファイル`,
        revertEllipsis: '取り消す…',
        stashKeptOn: ({ branch }) => `${branch} で保管`,
        stashOriginBranch: ({ branch }) => `${branch} から切り替えたときに保存`,
        stashOriginBranchShort: 'ブランチ切り替え時',
        stashOriginTransient: 'Happier が保存',
        stashOriginUnmanaged: 'Happier の外で作成',
        stashRestoreExplains: ({ folder }) => `復元すると、これらの変更が ${folder} に戻り、スタッシュは削除されます。フォルダ内のほかのものは変わりません。`,
        stashApply: '適用',
        stashApplyA11y: 'これらの変更を適用してスタッシュを残す',
        stashDiscardEllipsis: '破棄…',
        stashSwitcherA11y: 'スタッシュを選択',
        stashCount: ({ count }) => `スタッシュ ${count} 件`,
    } } satisfies Pick<Record<string, DetailsHistoryTranslations>, "ja">;

return { detailsHistoryTranslations };
})();

const Domain_detailsReviewTranslations = (() => {
type Count = Shared_detailsReviewTranslations.Count;

type DetailsReviewTranslations = Shared_detailsReviewTranslations.DetailsReviewTranslations;

const detailsReviewTranslations = { ja: {
        title: 'レビュー',
        files: ({ count }) => `${count} 個のファイル`,
        nextCommit: ({ count }) => `次のコミットに ${count} 個`,
        changedFiles: '変更されたファイル',
        commitColumn: 'コミット',
        jumpA11y: 'ファイルへ移動',
        comments: ({ count }) => `${count} 件のコメント`,
        goesWithNext: ({ count }) => `次のメッセージに添付`,
        askForChanges: '変更を依頼',
        detachCommentA11y: 'このコメントを次のメッセージから外す',
        trayExpandedHint: '次のメッセージと一緒にエージェントへ送られます。',
        askPlaceholder: 'エージェントに変更内容を伝える…',
        send: '送信',
        draftAuthor: 'あなた', draftStatus: '下書き', includeComment: '次のメッセージに添付',
    } } satisfies Pick<Record<string, DetailsReviewTranslations>, "ja">;

return { detailsReviewTranslations };
})();

const Domain_embedSettingsTranslations = (() => {
const english = Shared_embedSettingsTranslations.english;

const translated = Shared_embedSettingsTranslations.translated;

const embedSettingsTranslations = { ja: translated({
        settingsEmbeds: {
            title: "埋め込み",
            newTitle: "新しい埋め込み",
            purpose: "選んだアクセス権だけで、ほかのアプリに Happier のチャットを表示できます。",
            yourEmbeds: "あなたの埋め込み",
            newEmbed: "新しい埋め込み",
            listError: "埋め込みを読み込めませんでした",
            emptyTitle: "あなたのアプリに Happier のチャットを入れる",
            emptyBody: "アプリは実際の会話を、選んだアクセス権だけで表示します。どのサイトか、誰が送信や承認をできるか、どのモデルか。",
            createDescription: "ほかのアプリがチャットで何をできるか、どう見えるかを選びます。",
            name: "名前",
            nameDescription: "この一覧で自分にだけ表示されます。",
            namePlaceholder: "例: リードダッシュボード",
            create: "埋め込みを作成",
            summary: {
                sites: ({ count }: { count: number }) => `${count} サイト`,
                send: "送信可",
                sendAndApprove: "送信・承認可",
                approve: "承認可",
                viewOnly: "閲覧のみ",
                modelOnly: ({ name }: { name: string }) => `${name} のみ`,
                models: ({ count }: { count: number }) => `${count} モデル`,
            },
            sites: {
                title: "表示できる場所",
                description: "チャットはこれらのサイトでのみ開きます。",
            },
            capabilities: {
                title: "できること",
                view: "会話を表示",
                always: "常に",
                send: "メッセージを送信",
                sendDescription: "エージェントの停止とファイルの添付を含みます。",
                changeModel: "モデルを変更",
                permissionModes: "権限モード",
                permissionModesDescription: "複数のモードが許可されているときだけ、チャットにモード選択が表示されます。",
                anyMode: "すべてのモード",
                anyModeDescription: "エージェントが確認なしで行える範囲を利用者が変更できます。",
                modeOnly: ({ name }: { name: string }) => `${name} のみ`,
                modes: ({ count }: { count: number }) => `${count} モード`,
                approveOn: "これらのサイトの利用者は、このチャットでのツールの使用とリクエストを承認できます。",
            },
            models: {
                title: "モデル",
                description: "ほかのモデルは非表示ではなく拒否されます。チャットは最初に許可されたモデルで始まります。",
                allowed: "許可するモデル",
                any: "すべてのモデル",
            },
            organization: {
                title: "整理",
                description: "アプリはここからこの埋め込みのチャットを一覧します(いずれかのタグ)。新しいチャットもここに入ります。",
                folder: "フォルダ",
                tags: "タグ",
                none: "なし",
            },
            composer: {
                title: "入力欄",
                attachments: "添付",
                attachmentsDescription: "チャットに添付ボタンを表示します。オフでも、送信できる人は API からファイルを添付できます。",
            },
            sessions: {
                title: "セッション",
                description: "このキーがサーバーやチャットから作成するセッションは、このマシンとこのエージェントで実行され、上のフォルダとタグに入ります。",
                allow: "このキーにセッションの作成を許可",
                offConsequence: "このキーはセッションを作成できません。アプリは既存のチャットだけを表示できます。",
                computer: "マシン",
                agent: "エージェント",
                newChat: "埋め込みで新しいチャットを開始",
                appSetting: "アプリの設定",
                newChatDescription: "アプリがチャットなしで埋め込みを開いたときに、新しいチャットの入力欄を表示します。これはアプリ向けの設定で、セキュリティの制限ではありません。サーバーはこのキーでいつでもチャットを作成できます。",
            },
            appearance: {
                title: "外観",
                description: "プレビューは変更ごとに更新されます。開いているチャットは再読み込みせずに見た目が変わります。",
                mode: "モード",
                modeSystem: "システム",
                modeLight: "ライト",
                modeDark: "ダーク",
                theme: "テーマ",
                presetHappier: "Happier",
                colors: "カラー",
                colorsDefault: "Happier の既定",
                colorsCustomized: ({ count }: { count: number }) => `${count} 件をカスタマイズ`,
                colorsFor: "色の対象",
                colorGroups: {
                    surface: "サーフェス",
                    text: "テキスト",
                    accent: "アクセント",
                    messages: "メッセージ",
                    composer: "入力欄",
                    approvals: "承認",
                },
                fontFamily: "フォント",
                fontFamilyPlaceholder: "Happier の既定",
                fontFile: "フォントファイル",
                fontFileDescription: ".woff2 または .woff ファイルへの https リンク。",
                fontFileRefused: "スタイルシートではなく、.woff2 または .woff ファイルへのリンクを使ってください。",
                textSize: "文字サイズ",
                textSizeCompact: "小さめ",
                textSizeDefault: "標準",
                textSizeLarge: "大きめ",
                corners: "角",
                cornersSharp: "シャープ",
                cornersSoft: "ソフト",
                cornersRound: "ラウンド",
                density: "密度",
                densityCompact: "コンパクト",
                densityComfortable: "ゆったり",
                reset: "外観をリセット",
            },
            preview: {
                title: "ライブプレビュー",
                phone: "スマートフォン",
                desktop: "デスクトップ",
                reduceMotion: "動きを減らす",
                note: "サンプルメッセージ入りの実際の埋め込みチャットです。何も送信されません。",
                rowDescription: "この設定でチャットを表示します。",
                unavailable: "プレビューを表示できません",
            },
            snippets: {
                title: "コードスニペット",
                description: "アプリに貼り付けてください。この埋め込みの設定がすでに使われています。",
                step1: "キーを HAPPIER_EMBED_KEY に保存",
                step2: "canOpenSession を書く: 誰がどのチャットを開けるか",
                step3: "チャットを表示",
                backend: "バックエンド",
                react: "React",
            },
            detail: {
                created: ({ date }: { date: string }) => `作成 ${date}`,
                lastUsed: ({ date }: { date: string }) => `最終使用 ${date}`,
                expires: ({ date }: { date: string }) => `有効期限 ${date}`,
                reconnect: "開いているチャットは新しいアクセス権で再接続します。下書きは保持されます。",
                e2eeTrust: "このキーはこのアカウントの暗号化されたチャットを読めます。アプリには専用のアカウントを使ってください。",
                keyReach: "キーはあなたのサーバーにとどまり、このアカウントのすべてのチャットにアクセスできます。ブラウザーには渡りません。ブラウザーはサーバーが許可したチャットに限定された短期間のキーを受け取ります。",
                expiry: "キーの有効期限",
                expiryDescription: "キーの有効期限が切れるとチャットは開かなくなります。後から延長することはできません。",
                encryptionChecking: "このアカウントの暗号化を確認しています…",
                encryptionUnavailable: "このデバイスはまだこのアカウントの暗号化されたチャットを読めません。埋め込みを作成するには秘密鍵を復元してください。",
                encryptionStale: "このデバイスの暗号化チャット用のキーが古くなっています。埋め込みを作成するには秘密鍵を復元してください。",
                encryptionUnreadable: "このアカウントの暗号化を確認できませんでした。",
                missingTitle: "この埋め込みはもうありません",
                backToEmbeds: "埋め込みに戻る",
            },
            delete: {
                button: "埋め込みを削除",
                title: ({ label }: { label: string }) => `「${label}」を削除しますか?`,
                body: "開いているチャットは切断されます。暗号化されたチャットの読み取りに使われたキーは取り消せません。",
                confirm: "削除",
            },
            reveal: {
                copyEnv: ".env 行としてコピー",
                title: ({ label }: { label: string }) => `${label} の準備ができました`,
                shownOnce: "このキーを今コピーしてください。安全のため、Happier は再表示できません。",
                copy: "キーをコピー",
            },
        },
    }) };

return { embedSettingsTranslations };
})();

const Domain_embedTranslations = (() => {
const english = Shared_embedTranslations.english;

const translated = Shared_embedTranslations.translated;

const embedTranslations = { ja: translated({
        embed: {
            errors: {
                originNotAllowed: 'このページではこの会話を表示できません。',
                originNotAllowedReason: 'Happier で、このサイトを埋め込みの許可サイトに追加してください。',
                unavailable: 'この会話はここでは利用できません。',
                encrypted: 'この会話は暗号化されているため、ここでは開けません。',
                createNotGranted: 'このアプリでは新しいチャットを開始できません。',
                unsupportedVersion: 'このチャットには新しい埋め込みが必要です。',
                unsupportedVersionReason: 'このアプリの @happier-dev/embed を更新してください。',
            },
            nothingToShow: 'まだ表示するものはありません',
            nothingToShowReason: 'このアプリはまだ会話を開いていません。',
            reconnecting: '再接続しています…',
            previewUnavailable: 'プレビューを表示できません',
            previewUser: "このリードを分析して結果を記録して: Acme Robotics、40 席、第 4 四半期に評価中。",
            previewAgent: "相性は良好です。予算は確定し、推進者が決裁者です。分析を記録しました:",
            previewFollowUp: "このリードを「見込みあり」に移しますか?",
        },
    }) };

return { embedTranslations };
})();

const Domain_entityDragDropTranslations = (() => {
type EntityDragDropTranslations = Shared_entityDragDropTranslations.EntityDragDropTranslations;

const en = Shared_entityDragDropTranslations.en;

const ja: EntityDragDropTranslations = {
    files: { attach: "添付", uploadHere: "ここにアップロード" },
    runner: { filesOnly: "この起動にはフォルダーを添付できません。代わりにファイルを添付してください。" },
    composer: { addContext: "コンテキストを追加", consequence: "次のメッセージと一緒に送信 · まだ何も送信されません", target: "入力欄", readOnly: "この入力欄は読み取り専用です", otherWorkspace: "このワークスペースに含まれていません", unavailable: "この参照は利用できません" , mentionHere: "ここで参照", cantMentionHere: "ここでは参照できません", attachAsImage: ({ number }: { number: number }) => `画像 #${number} として添付`, attachAndMention: "トレイに追加し、ここで参照します", noMentionInText: ({ name }: { name: string }) => `${name} · 本文での参照なし`, mentionFiles: ({ count }: { count: number }) => `ここで ${count} 個のファイルを参照`, mentionInComposer: "入力欄で参照", uploadFolderAndMention: "フォルダーをアップロードし、ここで参照します" },
    surface: {
        scopeMismatch: '別の Home またはアカウントにあります',
        widgetMoveUnavailable: 'このウィジェットはこの表示領域に移動できません',
        widgetChecking: '移動先をまだ確認しています',
        widgetReadOnly: 'このレイアウトは表示できますが変更できません。所有者に編集権限を依頼してください',
        widgetAlreadyHere: 'すでにこの表示領域にあります。そこで並べ替えてください',
        widgetCantLiveHere: 'このウィジェットはこの表示領域に置けません。「ウィジェットを追加」からここに追加してください',
        widgetNeedsInputs: 'ここでは入力を設定できません。「ウィジェットを追加」からここに追加して選んでください',
        widgetLayoutChanged: 'このレイアウトはたった今変更されました。もう一度ドロップしてください',
        readOnly: 'このボードは読み取り専用です',
        copyDetail: '参照を保持 · ボードは変更されません',
    },
    preview: {
        putUnder: ({ target }) => `${target} の下に置く`,
        putUnderDetail: 'このセッションに報告 · どちらも動き続けます',
        moveAbove: ({ target }) => `${target} の上に移動`,
        moveBelow: ({ target }) => `${target} の下に移動`,
        moveBefore: ({ target }) => `${target} の前に移動`,
        moveAfter: ({ target }) => `${target} の後に移動`,
        orderDetail: '並び順だけが変わります',
        moveToFolder: ({ folder }) => `${folder} に移動`,
        folderDetail: '実行場所は変わりません', leaveSectionDetail: 'セクションから外れます',
        moveToTopLevel: '最上位に移動',
        topLevelDetail: 'フォルダーから出すだけ · ほかは変わりません',
        cantPutUnder: ({ target }) => `${target} の下には置けません`,
        cantMoveHere: 'ここには移動できません',
        pendingPutUnder: ({ target }) => `${target} の下に置いています…`,
        pendingDetail: 'Home の確認を待っています',
        cantMoveTo: ({ target }) => `${target} へ移動できません`,
        cantMoveAbove: ({ target }) => `${target} の上には移動できません`,
        cantMoveBelow: ({ target }) => `${target} の下には移動できません`,
        cantCopyTo: ({ target }) => `${target} へコピーできません`,
        cantAddTo: ({ target }) => `${target} に追加できません`,
        cantAttachTo: ({ target }) => `${target} に添付できません`,
        cantUploadTo: ({ target }) => `${target} へアップロードできません`,
        cantOpen: ({ target }) => `${target} を開けません`,
        cantGoTo: ({ target }) => `${target} へ移れません`,
        cantSplitHere: 'ここでは分割できません',
        unknownTitle: '移動できたか確認できません',
        unknownDetail: '少し待ってから一覧を確認し、もう一度試してください',
    },
    settled: {
        refusedPutUnder: ({ item, target }) => `${item} を ${target} の下に置けませんでした`,
        refused: ({ verb }) => `${verb}：完了しませんでした`,
        unknown: ({ verb }) => `「${verb}」が完了したか不明です`,
        pendingTitle: '移動できませんでした',
        pendingDetail: 'Happier はまだその場所を確認していました。もう一度お試しください。',
        dismiss: '閉じる',
    },
    reasons: {
        noRowAbove: 'この位置の上には、その下に配置できる行がありません',
        read: '読み取り専用で共有されているため、報告を受けられません',
        input: 'このセッションには送信できないため、報告を受けられません',
        pairwise: 'この 2 つのセッションはコンテキストを共有できません',
        cycle: 'そのセッションはすでにこのセッションに報告しています',
        alreadyUnder: 'すでにこのセッションに報告しています',
        archived: 'アーカイブ済みです',
        differentHome: '別の Home にあります。報告は同じ Home の中でだけ行えます',
        unavailable: 'このセッションを今は確認できませんでした',
        dateOrder: 'この一覧は日付順です。置くにはカスタム順に切り替えてください',
        noChange: 'すでにここにあります',
        descendantCycle: 'フォルダーを自分自身の中には入れられません',
        maxDepth: 'フォルダーの入れ子が深くなりすぎます',
        foldersOff: 'この Home ではフォルダーがオフです',
        gone: 'その場所はなくなりました',
        generic: 'この場所には置けません',
        otherGroup: 'セッションは実行中のプロジェクトに残ります。代わりにセクションに入れてください',
        cantHold: 'この行には何も入れられません',
        fixedItem: 'このリストでは移動できません',
    },
    chooser: { putUnderTitle: ({ item }) => `${item} を次の下に置く…`, checking: '報告を受けられるセッションを確認しています…', cantTakeReports: '報告を受けられないセッション', unavailable: '利用できません' },
    keyboard: {
        choose: '場所を選ぶ', putUnder: '下に置く', topLevel: '最上位', drop: 'ドロップ', cancel: 'キャンセル', escapeKey: 'Esc',
        hintsA11y: '矢印キーで場所を選び、Enter でドロップ、Escape でキャンセル',
    },
    organize: { enter: '一覧を整理', title: '整理', done: '完了', grip: ({ item }) => `${item} を移動` },
    pane: {
        openHere: 'ここにタブとして開く',
        nextTo: ({ target }) => `${target} の隣 · 何も閉じません`,
        nothingCloses: 'タブとして開きます · 何も閉じません',
        tooNarrow: 'このペインは狭すぎて分割できません',
        moveHere: 'ここにタブとして移動',
        openBefore: ({ target }) => `${target} の前に開く`,
        moveBefore: ({ target }) => `${target} の前に移動`,
        placeOnly: '位置だけが変わります',
        splitLeft: '左に分割',
        splitRight: '右に分割',
        splitUp: '上に分割',
        splitDown: '下に分割',
        opensBeside: ({ target }) => `${target} の隣に開きます`,
        movesBeside: ({ target }) => `${target} の隣に移動します`,
        goTo: ({ target }) => `${target} に移動`,
        openInThisPane: 'このペインで開いています · 新しく開くものはありません',
        openInAnotherPane: '別のペインで開いています · 新しく開くものはありません',
        alreadyHere: 'すでにここにあります',
        leaveIt: '離すとそのままになります',
        cantOpenHere: 'ここでは開けません',
    },
};

const entityDragDropTranslations = { ja };

return { entityDragDropTranslations };
})();

const Domain_eventAutomationComposerTranslations = (() => {
const english = Shared_eventAutomationComposerTranslations.english;

const ja = {
    eventAutomationComposer: {
        available: '利用可能',
        payloadFields: 'ペイロードフィールド',
        payloadSample: 'サンプルペイロード',
        noFilterableFields: 'このイベントは、フィルター可能なペイロード フィールドを宣言しません。',
        addFilterClause: '条件の追加',
        filterField: 'フィルターフィールド',
        filterOperator: 'フィルタ演算子',
        filterEquals: '等しい',
        filterOneOf: 'のいずれかです',
        filterValue: 'フィルター値',
        filterValuePlaceholder: '"値" または ["値"]',
        storedContentUnavailableTitle: '保存されたオートメーション コンテンツが利用できない',
        storedContentUnavailableBody: 'このイベント オートメーションは、保存されているコンテンツが利用できないため保存できません。',
        historyGapRecoveryTitle: '歴史のギャップに注意が必要',
        historyGapRecoverySubtitle: '新しいイベントの監視を再開するには、ソース ベースラインをリセットします。',
        historyGapRecoveryUnavailable: 'ソース回復アクションは、現在のウォッチャーでは使用できません。',
        historyGapRecoveryFailureTitle: 'ソースの回復にはもう一度試す必要があります',
        historyGapRecoveryFailureBody: '回復は確認されなかった。ソースにはまだ注意が必要です。',
        sourceStatusTitle: '監視ソース',
        sourceStatusState: {
            uninitialized: '未開始',
            baselined: 'ベースライン準備完了',
            observing: '監視中',
            backingOff: '再試行待ち',
            attention: '確認が必要',
        },
        sourceStatusCode: {
            credentialMissing: '認証情報が必要',
            credentialRevoked: '認証情報は取り消されました',
            rateLimited: 'レート制限中',
            historyGap: '履歴の欠落',
            capacityBlocked: '容量上限に到達',
            definitionStale: '定義が変更されました',
            sourceContractIncompatible: 'ソースの更新が必要',
            admissionUnavailable: '受付できません',
        },
        sourceStatusNextRetry: ({ time }: { time: string }) => `次回の再試行: ${time}`,
        sourceStatusObservedCount: ({ count }: { count: number }) => `観測したイベント: ${count}`,
        sourceStatusAdmittedCount: ({ count }: { count: number }) => `受理したイベント: ${count}`,
        sourceStatusSkippedCount: ({ count }: { count: number }) => `スキップしたイベント: ${count}`,
        sourceStatusLastObserved: ({ time }: { time: string }) => `最終観測: ${time}`,
        sourceCatalogStatusTitle: 'カタログの同期',
        sourceCatalogStatusState: {
            current: '最新',
            reconciling: '同期中',
            reconciliationLate: '同期が遅れています',
        },
        sourceCatalogStatusObservedRevision: ({ revision }: { revision: string }) => `確認済みリビジョン: ${revision}`,
        sourceCatalogStatusAdoptedRevision: ({ revision }: { revision: string }) => `適用済みリビジョン: ${revision}`,
        sourceCatalogStatusNoAdoptedRevision: 'まだリビジョンは適用されていません',
        sourceCatalogStatusScanStarted: ({ time }: { time: string }) => `スキャン開始: ${time}`,
    },
};

const eventAutomationComposerTranslations = { ja } as const;

return { eventAutomationComposerTranslations };
})();

const Domain_externalSessionOperationTranslations = (() => {
const en = Shared_externalSessionOperationTranslations.en;

const translated = Shared_externalSessionOperationTranslations.translated;

const externalSessionOperationTranslations = { ja: {
    browseLinked: 'リンク済み',
    browseImported: 'インポート済み',
    browseAgentUnavailable: 'Happier はこのマシンの選択した Agent または履歴にアクセスできませんでした。CLI のインストールを確認し、選択したアカウントでセッションを開いてから再試行してください。',
    browseAgentTimedOut: 'このマシンで選択した Agent が時間内に応答しませんでした。処理中またはインデックス作成中の可能性があるため、再試行してください。',
    browseAgentFailed: 'Happier は選択した Agent のセッションを読み取れませんでした。再試行し、失敗が続く場合はマシン上の Agent と daemon のログを確認してください。',
    browseAgentFailedNoRetry: 'Happier はこのソースのセッションデータを読み取れませんでした。再検索する前にマシン上の Agent と daemon のログを確認してください。',
    browseSourceInvalid: 'この履歴ソースを読み取れませんでした。マシン上の選択したアカウントと Agent のホームを確認し、ソースを選び直してください。',
    operationTitleMaterialize: 'Happier にインポート',
    operationTitleTakeoverLinked: '引き継いでリンクを維持',
    operationTitleTakeoverPersisted: 'インポートして引き継ぐ',
    operationMaterializeAvailable: 'このリンク済みセッションをインポートすると、オフラインでトランスクリプトを使用したり共有したりできます。',
    externalAgentStatusOnMachine: ({ agent, machine, status }: { agent: string; machine: string; status: string }) =>
        `${agent} 上の ${machine}: ${status}`,
    operationStatusRunning: '処理中',
    operationStatusCancelling: 'キャンセル中…',
    operationStatusCancelled: 'キャンセル済み',
    operationStatusCompleted: '完了',
    operationStatusDiscarded: '部分セッションを破棄しました',
    operationStatusNeedsResume: '再開を待っています',
    operationStatusNeedsReview: '続行する前に確認が必要です',
    operationStatusFailed: '続行できませんでした',
    operationStatusImportIncomplete: 'インポートは未完了です — 再開するか部分セッションを破棄してください',
    operationStatusUpdateIncomplete: '更新は未完了です — 再開してください',
    operationStatusOriginOffline: '進行状況は保存済みです — 元のマシンはオフラインです',
    operationStatusOriginUnknown: '進行状況は保存済みです — 元のマシンがオンラインかどうかは確認できません',
    operationStatusExternalWriter: '外部ライターを検出しました',
    operationStatusSpawnFailedAfterImport: 'インポートしましたが Agent を起動できませんでした — 起動を再試行',
    operationStatusSpawnFailedAfterTakeover: '引き継ぎましたが Agent を起動できませんでした — 起動を再試行',
    operationErrorSourceUnavailable: 'ソースを利用できません。ソースマシンを再接続してから再開してください。',
    operationErrorSourceChanged: '読み取り中にソースが変更されました。確認してから再開してください。',
    operationErrorCapacity: 'このマシンには続行に必要な一時保存容量がありません。',
    operationErrorRequiredItems: '必須のセッション項目を一部インポートできませんでした。',
    operationErrorImport: 'メッセージのインポートが中断されました。',
    operationErrorPublication: 'インポートしたスナップショットを公開できませんでした。',
    operationErrorAdmission: 'Happier はこのセッションを安全に引き継げませんでした。',
    operationErrorExternalWriter: '再試行する前に外部 Agent を停止してください。Happier が自動的に統合または停止することはありません。',
    operationErrorInternal: '内部エラーのため処理が停止しました。',
    operationPhaseValidating: '検証',
    operationPhaseWaitingForAgent: '外部 Agent の停止を待機',
    operationPhaseReadingSource: 'ソースを読み取り',
    operationPhaseImporting: 'メッセージをインポート',
    operationPhaseCatchingUp: 'ソースに追いついています',
    operationPhasePreparingRuntime: 'ランタイムを準備',
    operationPhaseStartingRuntime: 'ランタイムを起動',
    operationPhaseFinalizing: '最終処理',
    operationPhasePublishing: 'インポートしたセッションを公開',
    operationActionResume: '再開',
    operationActionRetryStart: '起動を再試行',
    operationActionCancel: 'キャンセル',
    operationActionDiscard: '部分セッションを破棄',
    operationActionDismiss: '閉じる',
    operationStatusOwnerReadFailed: 'Happier はこの操作の最新の進捗を読み取れませんでした。',
    operationActionCheckAgain: '再確認',
    operationComposerImporting: 'インポート中…',
    operationComposerTakingOver: '引き継ぎ中…',
    operationActionErrorUpgradeRequired: 'この操作を使用するには、ソースマシンの Happier を更新してください。',
    operationActionErrorNotFound: 'この処理は利用できなくなりました。',
    operationActionErrorConflict: '別の処理がこのセッションを制御しています。',
    operationActionErrorStaleRevision: '処理内容が変更されました。最新の進行状況を確認してから再試行してください。',
    operationActionErrorInvalidState: '現在の処理状態ではこの操作を使用できません。',
    operationActionErrorNotAllowed: 'この処理を制御する権限がありません。',
    operationActionErrorUnavailable: '操作を完了できませんでした。最新の進行状況から再試行してください。',
    operationImportProgress: 'インポートの進行状況',
    operationImportCountUnknown: ({ imported }: { imported: number }) => `${imported} 件のメッセージをインポート済み`,
    operationImportCountEstimated: ({ imported, total }: { imported: number; total: number }) => `約 ${imported} 件中 ${total} 件`,
    operationPublishedSnapshot: '公開済みスナップショットを保持',
    operationPublishedThrough: ({ sequence }: { sequence: number }) => `メッセージ ${sequence} まで利用可能`,
    operationDiscardConfirmTitle: '部分セッションを破棄しますか？',
    operationDiscardConfirmBody: '部分セッション全体が削除されます。この操作は元に戻せません。',
    sharingTranscriptOnMachine: ({ machine }: { machine: string }) =>
        `このセッションのトランスクリプトは ${machine} にあります。共有するには Happier にインポートしてください。`,
    sharingImportIncomplete: 'インポート中または未完了です。共有する前にインポートを再開してください。',
    sharingTranscriptUnavailableTitle: 'トランスクリプトを利用できません',
    transcriptRetainedRefreshFailedTitle: '最後に取得したトランスクリプトを表示しています',
    transcriptLoadFailed: 'Happier はこのトランスクリプトを読み込めませんでした。',
    sharingTranscriptUnavailable: 'トランスクリプトを利用できません。この古いリンク済みセッションには安全に保存されたトランスクリプトがありません。',
    sharingSharedUpTo: ({ time }: { time: string }) => `${time} まで共有済み`,
    sharingSnapshotFrom: ({ time }: { time: string }) => `${time} 時点のスナップショット`,
    sharingUpdateSharedCopy: '共有コピーを更新',
    sharingUpdateSharedCopyDescription: '共有スナップショットをソースの最新のトランスクリプトで更新します。',
    sharingSourceMachineMissing: 'ソースマシンを利用できません。もう一度試す前に Happier に再接続してください。',
    sharingSourceMachineOffline: 'ソースマシンはオフラインです。もう一度試す前にオンラインにしてください。',
    sharingActionAwaitingAvailability: 'マテリアライズ処理が接続されると、この操作を利用できます。',
} } as const;

return { externalSessionOperationTranslations };
})();

const Domain_externalSessionSettingsTranslations = (() => {
const en = Shared_externalSessionSettingsTranslations.en;

const translated = Shared_externalSessionSettingsTranslations.translated;

const externalSessionSettingsTranslations = { ja: {
    settingsIntegrationStatusNotInstalled: '未インストール',
    settingsIntegrationStatusEnabled: 'インストール済み・有効',
    settingsIntegrationStatusDisabled: 'インストール済み・無効',
    settingsIntegrationStatusNeedsAttention: '対応が必要',
    settingsIntegrationStatusUnsupported: 'この Agent バージョンでは未対応',
    settingsIntegrationStatusUnavailable: 'Agent を利用できません',
    settingsIntegrationInventoryLoadingTitle: '連携状態を確認中',
    settingsIntegrationInventoryLoadingSubtitle: 'このマシンから連携の全一覧を読み取っています。',
    settingsIntegrationInventoryPartialTitle: '連携状態が不完全です',
    settingsIntegrationInventoryPartialSubtitle: '一部のインストール記録を読み取れませんでした。変更する前に再確認してください。',
    settingsIntegrationInventoryErrorTitle: '連携状態を利用できません',
    settingsIntegrationInventoryErrorSubtitle: '最後に確認した状態が古い可能性があります。変更する前に再確認してください。',
    settingsIntegrationTitle: '外部セッションの監視',
    settingsIntegrationNeedsAttentionTitle: '対応が必要',
    settingsIntegrationDiagnosticMessageUnavailable: '監視を続ける前に、このインストールへの対応が必要です。',
    settingsIntegrationRemediationRetry: '問題を解決してから再確認してください。',
    settingsIntegrationRemediationOpenSettings: ({ path }: { path: string }) => `${path} の設定を確認してください。`,
    settingsIntegrationRemediationSelectAccount: ({ service }: { service: string }) => `${service} のアカウントを選択してください。`,
    settingsIntegrationRemediationInstallDependency: ({ dependency }: { dependency: string }) => `必要な依存関係をインストールしてください: ${dependency}。`,
    settingsIntegrationRemediationOpenUrl: ({ url }: { url: string }) => `${url} の案内を確認してください。`,
    settingsIntegrationActionReviewInstall: '確認してインストール',
    settingsIntegrationActionDisable: '無効にする',
    settingsIntegrationActionEnable: '有効にする',
    settingsIntegrationActionUninstall: 'アンインストール',
    settingsIntegrationActionCheckAgain: '再確認',
    settingsIntegrationReviewTitle: ({ agent }: { agent: string }) => `${agent} の連携を確認`,
    settingsIntegrationReviewBody: ({ entries }: { entries: string }) =>
        `Happier が管理するのは次の項目だけです: ${entries}。`,
    settingsIntegrationReviewBodyUnavailable: 'インストールする前に、Agent が管理する変更を確認してください。',
    settingsIntegrationPreviewNoMatcher: '一致するすべてのセッション',
    settingsIntegrationActionInstall: 'インストール',
    settingsIntegrationUninstallTitle: ({ agent }: { agent: string }) => `${agent} の連携をアンインストールしますか？`,
    settingsIntegrationUninstallBody: 'Happier が管理する項目だけを削除します。それ以外の Agent 設定は変更されません。',
    settingsIntegrationActionFailed: 'この連携を更新できませんでした。マシンを確認して再試行してください。',
    settingsAutoLinkUpdateFailed: '自動リンクを更新できませんでした。再試行してください。',
    settingsRestoreUpdateFailed: '再起動後のバックグラウンド同期設定を更新できませんでした。再試行してください。',
    settingsIntegrationsGroupTitle: '外部セッションの監視',
    settingsIntegrationsFooter: 'Happier が Agent 設定を変更するのは、明示的な操作を行った場合だけです。このページを開くだけでは変更されません。',
    settingsIntegrationsUnavailableTitle: '利用できる連携がありません',
    settingsIntegrationsUnavailableSubtitle: '対応する Agent 連携を接続すると、状態と利用可能な操作を確認できます。',
    settingsAgentAutoLinkTitle: ({ agent }: { agent: string }) => `新しい ${agent} セッションを自動的に追加`,
    settingsAutoLinkTitle: '新しい外部セッションを自動的に追加',
    browseAutoLinkTitle: '新しいセッションを自動的に追加',
    settingsAutoLinkGroupTitle: '自動リンク',
    settingsAutoLinkGroupFooter: '自動リンクは既定で無効で、Agent 連携の設定やバックグラウンド同期とは別の機能です。',
    settingsAutoLinkUnavailableTitle: '自動リンクできるソースがありません',
    settingsAutoLinkUnavailableSubtitle: 'このマシンには対応するソース範囲がありません。',
    settingsAutoLinkSubtitle: '有効にすると、Happier は Agent を開いたり再開したりせず、このソースの対応する新しいセッションをリンクします。',
    settingsAutoLinkHint: 'このソースの自動リンクをオンまたはオフにします。',
    settingsPrivacyGroupTitle: 'プライバシー',
    settingsPrivacyTitle: '範囲を限定した、コンテンツを含まない観測',
    settingsPrivacySubtitle: '信頼された Agent 連携は、このマシン上の範囲を限定したネイティブフックデータを確認する場合があります。Happier が受け入れて同期するのはコンテンツを含まない観測だけです。生のペイロード、パス、認証情報、プロンプト、トランスクリプト本文、ツール引数をホストが保存、同期、記録することはありません。',
    settingsAgentActionsGroupTitle: '外部セッション',
    settingsAgentBrowseTitle: ({ agent }: { agent: string }) => `${agent} の外部セッションを参照`,
    settingsManageAllTitle: '外部セッションのすべての設定を管理',
    settingsManageAllSubtitle: '接続済みマシンの連携とバックグラウンド同期を確認します。',
    settingsMachineOnline: 'オンライン',
    settingsMachineOffline: 'オフライン',
    settingsMachineTitle: 'マシン',
    settingsMachineUnavailable: '接続済みのマシンがありません',
    browseSearchIncomplete: ({ count }: { count: number }) =>
        `最初の ${count} 件を表示中 — 検索条件を絞り込んでください`,
    browseAnnotationsIncomplete: '一部の状態を確認できませんでした。セッションを開くと確認されます。',
    browseRouteUnavailableTitle: '外部セッションはここでは利用できません',
    browseRouteUnavailableSubtitle: 'このサーバーは外部セッションの参照に対応していません。戻って別のサーバーを選ぶか、しばらくしてからもう一度お試しください。',
    browseRouteAvailabilityUnknownTitle: '外部セッションへの対応を確認できませんでした',
    browseRouteAvailabilityUnknownSubtitle: 'このサーバーが外部セッションの参照に対応しているかを確認できませんでした。戻って、しばらくしてからもう一度お試しください。',
    browseHeaderTitle: '外部セッション',
    browseSettingsLink: '外部セッションの設定',
    browseChooseMachineTitle: 'マシンを選択',
    browseChooseMachineBody: '外部セッションは、それを実行したマシン上にあります。マシンを選ぶとセッションが表示されます。',
    browseMachineGoneBody: '削除されたか置き換えられました。別のマシンを選ぶとセッションが表示されます。',
    browseHomeUnreachableBody: '接続できるようになると、マシンとセッションが表示されます。それまでは別のマシンを選んでください。',
    browseMachineOfflineTitle: ({ machine }: { machine: string }) => `${machine} はオフラインです`,
    browseThisMachineOfflineTitle: 'このマシンはオフラインです',
    browseMachineOfflineBody: '再接続されるとセッションが表示されます。',
    browseChooseAnotherMachine: '別のマシンを選ぶ',
    browseCantReachTitle: ({ machine }: { machine: string }) => `${machine} の Happier に接続できません`,
    browseUpdateNeededTitle: ({ machine }: { machine: string }) => `${machine} の Happier を更新`,
    browseUpdateNeededBody: 'このマシンのバージョンはまだこのデバイスにこの一覧を共有できません。更新してからもう一度お試しください。',
    browseAccessRefusedTitle: ({ machine }: { machine: string }) => `${machine} を開けません`,
    browseAccessRefusedBody: 'このデバイスには現在このマシンを読み取る権限がありません。サインインし直すかアクセス権を確認してから、もう一度お試しください。',
    browseUnreadableTitle: ({ machine }: { machine: string }) => `${machine} を読み取れませんでした`,
    browseUnreadableBody: 'このデバイスではマシンの応答を解釈できませんでした。もう一度お試しいただくか、両方の Happier を更新してください。',
    browseNothingToBrowseTitle: ({ machine }: { machine: string }) => `${machine} に表示できるものはありません`,
    browseNothingToBrowseBody: 'このマシンのエージェントはまだセッションを共有できません。',
    browseEmptyTitle: ({ agent, machine }: { agent: string; machine: string }) => `${machine} に ${agent} のセッションはありません`,
    browseEmptyBody: 'このマシンで開始したセッションがここに表示され、Happier で開けます。',
    browseTryAgent: ({ agent }: { agent: string }) => `${agent} を試す`,
    browseNoMatches: ({ query }: { query: string }) => `「${query}」に一致するセッションはありません`,
    browseErrorTitle: 'セッションを読み込めませんでした',
    browseContentErrorTitle: ({ machine }: { machine: string }) => `${machine} の会話を検索できませんでした`,
    browseContentInHappier: 'Happier 内',
    browseContentNotInHappier: 'Happier 外',
    browseContentMessageCount: ({ count }: { count: number }) => (count === 1 ? '1 件のメッセージ' : `${count.toLocaleString()} 件のメッセージ`),
    browseThisMachine: 'このマシン',
    browseIndexingStop: '停止',
    browseThreadsFilter: 'サブエージェントのスレッド',
    browseThreadsHidden: 'トップレベルのみ',
    browseThreadsShown: 'サブエージェントのスレッドを含む',
    browseThreadReviewer: 'レビュアー',
    browseThreadSubagent: 'サブエージェント',
    browseThreadReviewerOf: ({ parent }: { parent: string }) => `${parent} のレビュアー`,
    browseThreadSubagentOf: ({ parent }: { parent: string }) => `${parent} のサブエージェント`,
} };

return { externalSessionSettingsTranslations };
})();

const Domain_filesPaneTranslations = (() => {
type FilesPaneTranslations = Shared_filesPaneTranslations.FilesPaneTranslations;

const filesPaneTranslations = { ja: {
        menu: {
            openBeside: "横に開く",
            openWithBlame: "行の作成者を表示して開く",
            wrap: "行を折り返す",
            background: "背景",
            raw: "ソース",
            copyContents: "内容をコピー",
            revealInFiles: "ファイルで表示",
            showBlame: "行の作成者を表示",
            hideBlame: "行の作成者を非表示",
            copyPath: "パスをコピー",
            copyAbsolutePath: "絶対パスをコピー",
            copyHappierLink: "Happierリンクをコピー",
            attachToMessage: "メッセージに添付",
            saveAsArtifact: "Artifactとして保存…",
            openInDefaultApp: "既定のアプリで開く",
            restoreBeforeTurn: ({ turn }) => "このターンの前にファイルを復元:" + " " + turn,
            restoreBeforeTurnFallback: "ファイルを復元",
            discardAllChanges: "このファイルの変更をすべて破棄",
            goToDefinition: "カーソル位置の定義へ移動",
            showInfo: "カーソル位置の情報",
            restartLanguageServices: "言語サービスを再起動",
            renameSymbol: "シンボル名を変更",
            quickFix: "クイック修正",
        },
        changedOnly: '変更のみ',
        showAll: 'すべて',
        showChanged: '変更あり',
        showLabel: '表示',
        showAllFiles: 'すべてのファイルを表示',
        viewOptions: '表示オプション',
        sizeAndDate: 'サイズと日付',
        newMenu: '新規ファイル、新規フォルダ、アップロード',
        newFile: '新規ファイル',
        newFolder: '新規フォルダ',
        noChangedFilesTitle: '変更はありません',
        noChangedFilesReason: '作業コピーは最新のコミットと一致しています。',
        rootErrorTitle: ({ machine }) => `${machine} のファイルを一覧できませんでした`,
        rootErrorTitleUnnamed: 'ファイルを一覧できませんでした',
        workspaceUnavailableReason: 'Happier はこのセッションのマシンとフォルダーを特定できませんでした。',
        page: {
            view: "表示",
            preview: "プレビュー",
            source: "ソース",
            changes: "変更",
            unsaved: "未保存",
            folders: "フォルダー",
            discardEdits: "編集を破棄",
            updatedJustNow: "たった今更新",
            downloadWholeFile: "ファイル全体をダウンロード",
            artifactTitle: "Artifact として保存",
            artifactDescription: "Artifact は共有できるコピーです。後でファイルを変更しても Artifact は変わりません。",
            artifactTitleLabel: "タイトル",
            artifactAudience: "閲覧できる人",
            artifactOnlyYou: "自分のみ",
            artifactSave: "Artifact として保存",
            artifactSaved: "Artifact として保存しました",
            artifactOpen: "開く",
            artifactFailed: "Artifact を保存できませんでした。もう一度お試しください。",
            artifactApproval: "承認待ち",
            updatedByJustNow: ({ agent }) => agent + " がたった今更新",
            updatedByForJustNow: ({ agent, person }) => agent + " が " + person + " のためにたった今更新",
            byAgentAge: ({ agent, age }) => agent + " · " + age,
            byAgentForAge: ({ agent, person, age }) => agent + "（" + person + "）· " + age,
            deletedBy: ({ agent }) => agent + " が削除",
            deletedByAt: ({ agent, time }) => agent + " が " + time + " に削除",
            deletedAt: ({ time }) => time + " に削除",
            readingFrom: ({ machine, seconds }) => machine + " から読み込み中 · " + seconds + " 秒",
            tooLargeTitle: ({ size }) => "このファイルは " + size + " です",
            tooLargeBody: ({ slice }) => "プレビューには最初の " + slice + " が表示されます。",
            showFirst: ({ slice }) => "最初の " + slice + " を表示",
            showLast: ({ slice }) => "最後の " + slice + " を表示",
            showingFirst: ({ slice, size }) => size + " のうち最初の " + slice,
            showingLast: ({ slice, size }) => size + " のうち最後の " + slice,
            partialFact: ({ slice, size }) => slice + " / " + size,
            plainText: "プレーンテキスト",
            infoKind: "種類",
            infoLanguage: "言語",
            infoLines: "行数",
            infoSize: "サイズ",
            infoEncoding: "エンコーディング",
            infoLineEndings: "改行コード",
            encodingBom: "UTF-8（BOM 付き）",
            encodingNotUtf8: "UTF-8 ではありません",
            eolCrlf: "Windows (CRLF)",
            eolMixed: "混在",
            artifactAudienceUnavailable: "このファイルのチームを読み込めなかったため、あなただけに表示されます。",
            artifactShareFailed: ({ team }) => "あなた用に保存しましたが、" + team + " と共有できませんでした。",
            fromMachine: ({ machine }) => machine + " から",
        },
        intelligence: {
            cardLabel: "この名前について",
            languageServer: "言語サーバー",
            starting: ({ server, machine }) => machine + " で " + server + " を起動しています…",
            loadingProject: ({ server, machine }) => server + " が " + machine + " でプロジェクトを読み込んでいます…",
            startingDetail: "大きなプロジェクトでは最初の応答に数秒かかります。",
            serverStopped: ({ server, machine }) => machine + " の " + server + " が停止しました。",
            serverCouldNotStart: ({ server, machine }) => machine + " で " + server + " を起動できませんでした。",
            serverMissing: ({ server, machine }) => machine + " に " + server + " がインストールされていません。",
            machineOffline: ({ machine }) => "言語機能には " + machine + " が必要ですが、オフラインです。閲覧とレビューはいつもどおり使えます。",
            machineNeedsUpdate: ({ machine }) => "言語機能には " + machine + " の新しい Happier が必要です。",
            restart: "再起動",
            copy: "コピー",
            lookingUp: "調べています…",
            goToDefinition: "定義へ移動",
            findReferences: "参照を検索",
            definition: "定義",
            references: "参照",
            definedOutside: "ワークスペースの外で定義されています",
            namesOnLine: "この行の名前",
            noReferences: "参照が見つかりません",
            textMatches: "テキスト一致: このファイルに応答する言語サーバーがありません。",
            textMatchesPartial: "テキスト一致（最初の結果）: このファイルに応答する言語サーバーがありません。",
            problemsTitle: "問題",
            referencesTitle: "参照",
            problemsScope: "開いているファイル内",
            problemsIdle: "このファイルの型エラーなどの問題をチェックします。",
            checkProblems: "問題をチェック",
            checking: "チェックしています…",
            noProblems: "開いているファイルに問題はありません",
            addedToMessage: "メッセージに追加しました",
            showProblems: "問題を表示",
            problemsCount: ({ count }) => String(count) + " 件の問題",
            askAgent: ({ agent, count }) => agent + " に " + String(count) + " 件の問題の修正を依頼",
            saveAndAskAgent: ({ agent, count }) => "保存して " + agent + " に " + String(count) + " 件の問題の修正を依頼",
            ask: ({ count }) => String(count) + " 件の問題の修正を依頼",
            saveAndAsk: ({ count }) => "保存して " + String(count) + " 件の問題の修正を依頼",
            referencesEmpty: "ファイル内の名前の参照を検索すると、使われている場所が表示されます。",
            problemsEmpty: "ファイルを開くと問題をチェックできます。",
            fix: "修正",
            renameTitle: "名前を変更",
            fixesTitle: "クイック修正",
            preparingRename: "この名前を確認しています…",
            lookingForFixes: "修正を探しています…",
            saveFirst: "先にこのファイルを保存してください。名前の変更と修正は保存済みの内容に対して行われます。",
            newName: "新しい名前",
            renameHint: "Return で、書き込む前にすべての変更を確認できます。",
            findingUses: "すべての使用箇所を探しています…",
            previewRename: "プレビュー",
            renameTo: ({ from, to }) => from + " → " + to,
            changesInFiles: ({ changes, files }) => String(files) + " ファイルで " + String(changes) + " 件の変更",
            renameInFiles: ({ files }) => String(files) + " ファイルで名前を変更",
            renameOnly: "名前だけ変更",
            applyDeclined: "変更は承認されませんでした。何も書き込まれていません。",
            undoDeclined: "元に戻す操作は承認されませんでした。ファイルは変更されたままです。",
            renameAndUpdateImports: "名前を変更してインポートを更新",
            fileRenamed: ({ name }) => name + " に名前を変更しました",
            applyFix: "修正を適用",
            runsCommand: "言語サーバーが実行時にこの変更を行います。書き込んだファイルはその後に一覧表示されます。",
            alsoRunsCommand: "その後、言語サーバーがコマンドを実行し、さらに変更することがあります。",
            renamed: ({ files }) => String(files) + " ファイルで名前を変更しました",
            fixApplied: "修正を適用しました",
            nothingChanged: "何も変更されませんでした",
            undone: ({ files }) => String(files) + " ファイルで元に戻しました",
            resultChanged: "プレビュー後に変更されたため、そのままにしました",
            resultSkipped: "スキップ",
            resultFailed: ({ reason }) => reason ? "書き込めませんでした: " + reason : "書き込めませんでした",
            undoChanged: ({ files }) => String(files) + " ファイルはその後変更されたため、そのままにしました",
            undoFailed: "元に戻す操作を完了できませんでした。再試行する前にファイルを確認してください。",
            readingFile: "読み込み中…",
            changesNotShown: ({ count }) => String(count) + " 件の変更。プレビューを表示できません",
            cannotRename: "この名前は変更できません。",
            noFixes: "ここには修正がありません。",
            noInfo: "ここに表示する情報はありません。",
            nothingToChange: "変更するものはありません。",
            renameUnavailable: "名前の変更にはこのファイルの言語サーバーが必要です。",
            fixesUnavailable: "修正にはこのファイルの言語サーバーが必要です。",
            editLoading: "言語サーバーはまだプロジェクトを読み込んでいます。少し待ってから再試行してください。",
            editFailed: "変更を取得できませんでした。再試行してください。",
            outcomeUnknown: "変更が書き込まれた可能性があります。再試行する前にファイルを確認してください。",
        },
    } } as const satisfies Pick<Record<string, FilesPaneTranslations>, "ja">;

return { filesPaneTranslations };
})();

const Domain_fileViewerTranslations = (() => {
type FileViewerTranslations = Shared_fileViewerTranslations.FileViewerTranslations;

const fileViewerTranslations = { ja: {
    viewer: {
        stageCounter: ({ current, total }) => `${current} / ${total}`,
        stageGallery: ({ count }) => `${count} 件`,
        stageItem: ({ name, width, height }) => `${name}、${width} × ${height}`,
        openFile: "ファイルを開く",
        viewFullScreen: "全画面で表示",
        hideControls: "コントロールを隠す",
        showControls: "コントロールを表示",
        zoomIn: "拡大",
        zoomOut: "縮小",
        fit: "全体を表示",
        actualSize: "実際のサイズ",
        zoomPercent: ({ percent }) => `${percent}%`,
        download: "ダウンロード",
        share: "共有",
        loadFailed: ({ name }) => `${name} を読み込めませんでした`,
        shownAt: ({ scale }) => `${scale}× で表示`,
        background: "背景",
        backgroundCheckerboard: "チェック柄",
        backgroundLight: "ライト",
        backgroundDark: "ダーク",
        pdfLoading: "PDF を読み込み中",
        megabytesOf: ({ loaded, total }) => `${loaded} / ${total} MB`,
        pdfProtectedTitle: "この PDF はパスワードで保護されています",
        pdfProtectedBody: "Happier はまだ保護された PDF を開けません。パスワードを入力できるアプリで開いてください。",
        pdfDamagedTitle: "この PDF を開けません",
        pdfDamagedBody: "有効な PDF ではないか、破損しています。既定のアプリで開いて確認してください。",
        pdfFailed: "この PDF を読み込めませんでした",
        pdfPage: ({ page, total }) => `${page} / ${total}`,
        pdfPageCount: ({ count }) => (`${count} ページ`),
        pdfFitWidth: "幅に合わせる",
        pdfFitPage: "ページに合わせる",
        pdfZoom: "ズーム",
        downloading: ({ loaded, total }) => `ダウンロード中 ${loaded} / ${total} MB`,
        loadStopped: ({ name }) => `${name} の読み込みを停止しました`,
        loadAgain: 'もう一度読み込む',
        videoCantPlayTitle: "この動画はここでは再生できません",
        audioCantPlayTitle: "この音声はここでは再生できません",
        mediaCantPlayBody: "このデバイスはこのエンコード形式に対応していません。ダウンロードするか、既定のアプリで開いてください。",
        openInDefaultApp: "既定のアプリで開く",
        play: "再生",
        pause: "一時停止",
        playbackPosition: "再生位置",
        openAsText: "テキストとして開く",
        remoteImages: ({ count }) => `リモート画像 ${count} 件は読み込まれていません`,
        loadRemoteImages: "読み込む",
        imageOutsideWorkspace: "このワークスペース外の画像",
        before: "変更前",
        after: "変更後",
        beforeSide: "HEAD",
        afterSide: "作業ツリー",
        added: "追加",
        deleted: "削除",
    },
    kind: {
        code: "テキストファイル",
        markdown: "Markdown",
        image: "画像",
        svg: "SVG 画像",
        pdf: "PDF 書類",
        video: "動画",
        audio: "音声",
        binary: "バイナリファイル",
        png: "PNG 画像",
        jpeg: "JPEG 画像",
        gif: "GIF 画像",
        webp: "WebP 画像",
        bmp: "BMP 画像",
        ico: "アイコン",
        avif: "AVIF 画像",
        zip: "ZIP アーカイブ",
        tar: "Tar アーカイブ",
        gzip: "Gzip アーカイブ",
        rar: "RAR アーカイブ",
        sevenZip: "7-Zip アーカイブ",
        sqlite: "SQLite データベース",
        pe: "Windows 実行ファイル",
        elf: "Linux 実行ファイル",
        machO: "Mach-O 実行ファイル",
        office: "Office 書類",
        font: "フォント",
        mp4: "MPEG-4 動画",
        mov: "QuickTime 動画",
        webm: "WebM 動画",
        mp3: "MP3 音声",
        wav: "WAV 音声",
        flac: "FLAC 音声",
        aac: "AAC 音声",
        ogg: "Ogg 音声",
    },
} } satisfies Pick<Record<string, FileViewerTranslations>, "ja">;

return { fileViewerTranslations };
})();

const Domain_findTranslations = (() => {
type FindTranslations = Shared_findTranslations.FindTranslations;

const slavicPlural = Shared_findTranslations.slavicPlural;

const russianPlural = Shared_findTranslations.russianPlural;

const en = Shared_findTranslations.en;

const ja: FindTranslations = {
    open: '検索…',
    openedForMatch: '一致箇所を表示しています', foldAgain: '再び折りたたむ', showHiddenLines: ({ count }) => `非表示の${count}行を表示`,
    surface: {
        chat: 'チャット内を検索',
        changes: '変更内を検索',
        file: 'ファイル内を検索',
        terminal: ({ name }) => `${name} 内を検索`,
    },
    previous: '前の一致',
    next: '次の一致',
    matchCase: '大文字と小文字を区別',
    regex: '正規表現を使用',
    regexShort: '正規表現',
    options: '検索オプション',
    close: '検索を閉じる',
    done: '完了',
    stop: '停止',
    noMatches: '一致なし',
    noneFound: '見つかりません',
    invalidPattern: '無効なパターン',
    offline: 'オフライン',
    unsupported: 'ここでは検索できません',
    count: ({ current, total }) => (current === null ? `${total} 件` : `${current} / ${total}`),
    files: ({ count }) => `${count} ファイル`,
    soFar: '（検索中）',
    loaded: '（読み込み済み）',
    note: {
        searchingOlder: '過去のメッセージを検索中（このデバイス上で復号）',
        searchingChanges: '変更されたファイルを検索中',
        offlineOlder: 'オンラインに戻ると過去のメッセージを検索できます。',
        terminalKept: ({ lines }) => `このターミナルが保持している直近 ${lines} 行を検索しました。`,
    },
};

const findTranslations = { ja };

return { findTranslations };
})();

const Domain_folderlessSessionTranslations = (() => {
type FolderlessSessionTranslations = Shared_folderlessSessionTranslations.FolderlessSessionTranslations;

const en = Shared_folderlessSessionTranslations.en;

const ja: FolderlessSessionTranslations = {
    composer: {
        addFolder: 'フォルダを追加',
        noFolder: 'フォルダなし',
        noFolderDescription: 'Happier がこのチャット専用のフォルダを用意します',
        removeFolder: 'フォルダを外す',
        a11y: {
            folder: ({ path }) => `フォルダ: ${path}。フォルダの選択を開きます。`,
            none: 'フォルダなし。Happier がこのチャット専用のフォルダを用意します。フォルダを追加。',
            loading: 'フォルダを読み込み中',
            noFolderRow: 'フォルダなし、このチャット専用のフォルダ',
            removed: 'フォルダを外しました',
            set: ({ path }) => `フォルダを ${path} に設定しました`,
        },
    },
    display: {
        chats: 'チャット',
        untitledChat: '新しいチャット',
        folder: 'フォルダ',
        privateToSession: 'このセッション専用',
        sessionFiles: 'セッションのファイル',
        privateFolderOn: ({ machine }) => `${machine} の専用フォルダ`,
    },
};

const folderlessSessionTranslations = { ja: ja };

return { folderlessSessionTranslations };
})();

const Domain_glassAppearanceTranslations = (() => {
const englishTranslations = Shared_glassAppearanceTranslations.englishTranslations;

const effectiveTranslations = { "ja": {
        "glass": "ガラス",
        "window": "ウィンドウ",
        "windowDescription": "デスクトップの上に表示するアプリ",
        "chrome": "タイトルバーとナビゲーション",
        "card": "要素",
        "cardDescription": "カード、ウィジェット、入力欄、設定グループ",
        "floating": "メニューとダイアログ",
        "effectiveBrowserSolid": "メニューとフローティング操作部は不透明です。ブラウザではデスクトップを透かせません。",
        "effectiveFloatingSolid": "このデバイスのフローティング操作部は不透明です。",
        "effectiveSolid": "このデバイスでは不透明な画面です。",
        "effectiveBrowser": "メニューとダイアログ、背景の上の要素にガラスを使います。ブラウザではデスクトップを透かせません。",
        "effectiveBrowserCustom": "メニューとフローティング操作部に選んだ素材を使います。ブラウザではデスクトップを透かせません。",
        "effectivePhone": "フローティング操作部とシート、背景の上の要素にガラスを使います。",
        "effectiveLayered": "このウィンドウ全体に層状のガラスを使います。",
        "effectiveUniform": "このウィンドウ全体に均一なガラスを使います。",
        "effectiveCustom": "このウィンドウにカスタマイズしたガラスを使います。",
        "effectiveUnavailable": "ウィンドウのガラスは利用できません。フローティング操作部は選んだ素材を使います。",
        "effectiveInactive": "ウィンドウが非アクティブな間は不透明です。",
        "effectiveTint": "フローティング操作部は色付きです。背景のぼかしは利用できません。",
        "description": "ウィンドウからデスクトップ、フローティング操作部からページを透かします。",
        "descriptionBrowser": "メニューとダイアログからページを、要素から背景を透かします。",
        "descriptionPhone": "フローティング操作部とシートからページを、要素から背景を透かします。",
        "chromeDescription": "タイトルバーとナビゲーション",
        "sidebarDescription": "セッションの列",
        "contentDescription": "会話、入力欄、作業ペイン",
        "floatingDescription": "メニュー、ポップオーバー、シート、操作部",
        "clear": "透明",
        "shortcutHint": ({ modifier }: { modifier: string }) => `${modifier}-クリック・${modifier}⇧Lでライトとダークを切り替え`
    } } as const;

const glassAppearanceTranslations = { ja: { sameAsHome: "ホームと同じ", ...Shared_glassAppearanceTranslations.atmosphereTranslations['ja'], iosReduceTransparencyPath: "設定 › アクセシビリティ › 画面表示とテキストサイズ › 透明度を下げる", title: 'ガラス', material: '素材', solid: '不透明', auto: '自動', everywhere: '全体', custom: 'カスタム', blur: 'ぼかし', tint: '色味', off: 'オフ', opacity: '不透明度', customize: 'カスタマイズ', sidebar: 'サイドバー', content: 'コンテンツ', appearance: '外観', moreSettings: '外観の詳細設定…', customizeLink: 'カスタマイズ…', toolbarTitle: '外観ボタン', toolbarDescription: 'ツールバーに外観を表示します。修飾キーを押しながらクリックするとライトとダークを切り替えます。', reduceTransparency: '「透明度を下げる」が有効なため不透明です', osSettings: 'アクセシビリティ設定を開く', themeCommand: 'ライトとダークを切り替える', autoDescription: "このデバイスに合わせます。対応デスクトップでは各面に層状のガラス、スマートフォンではフローティング画面にガラスを使います。", osSettingsUnavailable: "アクセシビリティ設定を開けませんでした。デバイスの設定から開いてください。", ...effectiveTranslations["ja"] } } satisfies Pick<Record<string, Record<keyof typeof englishTranslations, string | ((params: { modifier: string }) => string)>>, "ja">;

return { effectiveTranslations, glassAppearanceTranslations };
})();

const Domain_goalControlTranslations = (() => {
const en = Shared_goalControlTranslations.en;

const ja: typeof en = {
    row: {
        notSet: '未設定',
    },
    keepGoing: {
        title: '完了まで続ける',
        nativeDescription: ({ agent }) => `${agent} は自分で目標に向けて作業を続けます。`,
        description: ({ rounds }) => `あなたのターンが終わるたびにエージェントが目標を確認し、達成、予算切れ、進捗なしのいずれかになるまで、最大 ${rounds} ラウンド続けます。`,
        roundsPrefix: '停止するまで',
        roundsSuffix: 'ラウンド',
        roundsLabel: '停止までのラウンド数',
        strikesPrefix: '停止するまで',
        strikesSuffix: '回の進捗なしの確認',
        strikesLabel: '停止までの進捗なしの確認回数',
        secondOpinionTitle: '完了前にセカンドオピニオンを求める',
        secondOpinionDescription: '目標を完了にする前に、別のエージェントが確認します。同意しない場合は通知が届き、目標は未完了のままです。',
        budgetUnreported: ({ agent }) => `${agent} はトークン使用量を報告しないため、ラウンド数と進捗確認だけが適用されます。`,
    },
};

const goalControlTranslations = { ja };

return { goalControlTranslations };
})();

const Domain_homeAddTranslations = (() => {
type HomeAddTranslation = Shared_homeAddTranslations.HomeAddTranslation;

const en = Shared_homeAddTranslations.en;

const homeAddTranslations = { ja: {
        addressIsSignInService: 'このアドレスはサインインサービスです。このサービスにサインインして、あなたのHomeを見つけてください。',
        mixedContent: 'このブラウザーでは、HTTPSページからHTTPのHomeに接続できません。HappierをHTTPで開くか、HomeのHTTPSアドレスを使用してください。',
        connectedToHome: ({ home }) => `${home}がこのデバイスに接続されました。`,
        openHome: ({ home }) => `${home}を開く`,
        showAllHomes: 'すべてのHomeを表示',
        otherSignInService: '別のサインインサービス',
        otherSignInServiceSubtitle: 'セルフホストまたは会社のサービス',
        signInServiceAddress: 'サービスのアドレス',
    } } satisfies Pick<Record<string, HomeAddTranslation>, "ja">;

return { homeAddTranslations };
})();

const Domain_homeComposerTranslations = (() => {
type HomeComposerTranslation = Shared_homeComposerTranslations.HomeComposerTranslation;

const starterPrompts = Shared_homeComposerTranslations.starterPrompts;

const homeComposerTranslations = { ja: {
        ...starterPrompts,
        suggestionsLabel: '提案',
        summarizeProjectSince: ({ project, day }) => `${day}以降の ${project} の変更をまとめて`,
        summarizeProjectToday: ({ project }) => `今日の ${project} の変更をまとめて`,
        sessionsSince: ({ count, day }) => `${day}以降 ${count} 件のセッション`,
        sessionsToday: ({ count }) => `今日 ${count} 件のセッション`,
    } } satisfies Pick<Readonly<Record<string, HomeComposerTranslation>>, "ja">;

return { homeComposerTranslations };
})();

const Domain_homeDeviceApprovalTranslations = (() => {
type HomeDeviceApprovalTranslation = Shared_homeDeviceApprovalTranslations.HomeDeviceApprovalTranslation;

const homeDeviceApprovalTranslations = { ja: {
        title: 'デバイスの承認', deviceFallback: '新しいデバイス',
        homeLabel: ({ home }) => `Home：${home}`, expiresLabel: ({ expiry }) => `有効期限：${expiry}`,
        requestDetails: 'リクエストの詳細', requestDetailsHint: 'リクエストキーの識別子を表示',
        fingerprintLabel: 'リクエストキーのフィンガープリント', requestDetailsHelp: 'これはリクエストキーの識別子です。照合する必要のあるコードではありません。',
        approve: '承認', reject: '拒否', loadError: 'デバイスの承認リクエストを読み込めませんでした。',
        loadErrorUnreachable: ({ homes }) => `${homes} から応答がありません。`, loadErrorFailed: ({ homes }) => `${homes} がエラーを返しました。`,
        decisionError: 'このリクエストを更新できませんでした。', decisionRecovery: 'もう一度［承認］または［拒否］を選んでください。',
        approved: 'デバイスを承認しました', rejected: 'デバイスを拒否しました', expired: '期限切れ', stopWaiting: '待機を停止',
    } } as const satisfies Pick<Record<string, HomeDeviceApprovalTranslation>, "ja">;

return { homeDeviceApprovalTranslations };
})();

const Domain_homeFeatureTranslations = (() => {
const en = Shared_homeFeatureTranslations.en;

const ja: typeof en = {
    teams: {
        title: 'チーム',
        description: 'セッション、マシン、アクセスを共有するグループ。',
        credentialResources: {
            title: 'チームの認証情報',
            description: 'チームがセッションと共有する認証情報。',
            externalApi: {
                title: 'チーム認証情報 API',
                description: '外部ツールが API 経由でチームの認証情報を使います。',
            },
        },
    },
    automations: {
        title: 'オートメーション',
        description: 'スケジュールやトリガーで動くエージェントの作業。',
    },
    workflows: {
        title: 'ワークフロー',
        description: '複数ステップのエージェントパイプライン。',
    },
    pets: {
        sync: {
            title: 'ペットの同期',
            description: '各メンバーのペットをすべてのデバイスに保ちます。',
        },
    },
    voice: {
        title: '音声',
        description: 'エージェントと話せます。',
        happierVoice: {
            title: 'Happier 音声',
            description: 'この Home が提供する音声サービスでの音声。',
        },
    },
    connectedServices: {
        group: '接続サービス',
        quotas: {
            title: 'クォータメーター',
            description: '接続中の各アカウントの残りクォータを表示します。',
        },
        subscription: {
            title: 'サブスクリプションの状態',
            description: '接続中の各アカウントのプランと状態を表示します。',
        },
        accountGroups: {
            title: 'アカウントグループ',
            description: '接続中のアカウントをプールにまとめます。',
        },
        accountFallback: {
            title: 'アカウントのフォールバック',
            description: '1 つを使い切ったらプール内の次のアカウントに切り替えます。',
        },
        autoQuotaReset: {
            title: 'クォータの自動リセット',
            description: 'プールの全アカウントを使い切ったら、蓄えたクォータリセットを使います。',
        },
        autoDisablePlanInvalid: {
            title: '使えないアカウントを除外',
            description: '選択したモデルを使えないプールのアカウントをオフにします。',
        },
        poolQuotaLimitSelection: {
            title: 'プールのクォータ上限',
            description: '各プールが従うプロバイダーのクォータを選びます。',
        },
    },
    updates: {
        ota: {
            title: 'OTA アップデート',
            description: 'ストアを通さずにアプリがアップデートをインストールします。',
        },
    },
    attachments: {
        uploads: {
            title: '添付ファイル',
            description: 'セッション内のエージェントにファイルや画像を送ります。',
        },
    },
    sharing: {
        group: '共有',
        session: {
            title: 'セッションの共有',
            description: 'この Home のメンバーとセッションを共有します。',
        },
        public: {
            title: '公開リンク',
            description: '公開リンクでセッションの内容を共有します。',
        },
        contentKeys: {
            title: '暗号化された共有',
            description: '鍵を交換し、共有セッションをエンドツーエンドで暗号化されたままにします。',
        },
        pendingQueueV2: {
            title: '共有メッセージキュー',
            description: 'エージェントが作業中の間、共有セッションのメッセージをキューに入れます。',
        },
        pendingDeliveryState: {
            title: 'キューの配信追跡',
            description: 'キューのどのメッセージがエージェントに届いたかを記録します。',
        },
    },
    sessions: {
        title: 'セッション',
        description: 'セッションとその操作。',
        group: 'セッション',
        handoff: {
            title: 'セッションの引き継ぎ',
            description: '実行中のセッションを別のマシンに移します。',
        },
        ephemeralRunner: {
            title: '使い捨てランナー',
            description: '使い捨てのマシンでセッションを開始します。',
        },
        agentSwitching: {
            title: 'エージェントの切り替え',
            description: '別のコーディングエージェントでセッションを続けます。',
        },
        folders: {
            title: 'セッションフォルダー',
            description: 'セッションをフォルダーで整理します。',
        },
        drafts: {
            title: '下書きの同期',
            description: '未送信のメッセージや新しいセッションの下書きをすべてのデバイスに保ちます。',
        },
        following: {
            title: 'フォロー',
            description: 'セッションをフォローして更新や通知を受け取ります。',
        },
        autonomousExchange: {
            title: '自律的なやり取り',
            description: 'エージェントが互いのためにセッションを開始した際の、受け付けられた開始要求とアカウントの状況確認を記録します。',
        },
        conversations: {
            title: '会話',
            description: '共有セッションの中でメンバーが話し、互いにメンションします。',
        },
        board: {
            title: 'セッションボード',
            description: 'セッションとその項目を共有ボードに並べます。',
        },
        filteredListing: {
            title: 'フィルター付き一覧',
            description: 'この Home でページ分割の前にセッション一覧を絞り込みます。',
        },
        usageLimitRecovery: {
            title: '使用量上限からの復帰',
            description: 'エージェントが使用量上限に達したら、待って再開するか再試行します。',
        },
    },
    machines: {
        title: 'マシン',
        description: 'マシンへの接続。',
        group: 'マシン',
        pools: {
            title: 'マシンプール',
            description: 'マシンがオフラインのときは次のマシンに切り替えます。',
        },
        transfer: {
            title: 'マシン間転送',
            description: 'マシン間のデータ転送。',
            directPeer: {
                title: '直接転送',
                description: 'マシン間で直接データを転送します。',
            },
            serverRouted: {
                title: 'この Home 経由の転送',
                description: 'マシン同士が直接つながらないとき、この Home 経由でデータを転送します。',
            },
        },
        peerMediation: {
            title: 'マシン間の接続',
            description: 'マシン間のトンネル、ストリーム、アクセス。',
            observability: {
                title: '接続の診断',
                description: 'マシン間のトンネル、ストリーム、プレビューのつながり方を表示します。',
            },
        },
        tunnel: {
            title: 'マシン間トンネル',
            description: 'マシン間でポートを開くこと。',
            directPeer: {
                title: '直接トンネル',
                description: 'マシン間で直接ポートを開きます。',
            },
            serverRouted: {
                title: 'この Home 経由のトンネル',
                description: 'マシン同士が直接つながらないとき、この Home 経由でポートを開きます。',
            },
        },
        liveStream: {
            title: 'ライブ配信',
            description: 'マシンの画面の配信。',
            directPeer: {
                title: '直接ライブ配信',
                description: 'マシンの画面をデバイスに直接配信します。',
            },
            serverRouted: {
                title: 'この Home 経由のライブ配信',
                description: '直接配信に失敗したとき、この Home 経由でマシンの画面を配信します。',
            },
        },
        rpc: {
            title: 'マシンの呼び出し',
            description: 'マシンへの直接接続。',
            directPeer: {
                title: 'マシンへの直接呼び出し',
                description: 'この Home を経由せず、マシンに直接接続します。',
            },
        },
    },
    localServices: {
        title: 'ローカルサービス',
        description: 'マシンで動いているサービスを表示して開きます。',
        group: 'ローカルサービス',
        inventory: {
            title: 'サービス一覧',
            description: '各マシンで動いているポートとサービスを一覧表示します。',
        },
        managed: {
            title: '管理対象サービス',
            description: 'Happier からサービスを起動、命名、監視します。',
        },
        launcher: {
            title: 'サービスランチャー',
            description: '開いたりプレビューしたりするサービスを提案します。',
        },
        actions: {
            title: 'サービス操作',
            description: 'サービスのコピー、プレビュー、削除。',
            terminate: {
                title: 'サービスの停止',
                description: '検出したサービスのプロセスを停止します。',
            },
        },
        preview: {
            title: 'サービスのプレビュー',
            description: 'セッション内でローカルサービスを非公開でプレビューします。',
        },
        publicPreview: {
            title: '公開プレビュー',
            description: 'サービスのプレビューを公開アドレスで共有します。',
        },
    },
    browser: {
        title: 'ブラウザー',
        description: 'Happier の中でページ、プレビュー、ホストされたビューを開きます。',
        group: 'ブラウザー',
        viewTargets: {
            title: 'ブラウザービュー',
            description: 'プレビュー、プラグインのページ、リンクを適切なビューで開きます。',
        },
        internal: {
            title: '内蔵ブラウザー',
            description: '独自のセッションとプロファイルで Happier の中を閲覧します。',
        },
        sidecar: {
            title: 'サイドカーブラウザー',
            description: '重い自動化のための別の管理ブラウザー。',
        },
        diagnostics: {
            title: 'ブラウザーの開発ツール',
            description: '内蔵ブラウザーのコンソール、ネットワーク、devtools イベント。',
        },
        context: {
            title: 'ブラウザーのコンテキスト',
            description: 'ページの内容をメッセージやエージェントに添付します。',
        },
        automation: {
            title: 'ブラウザーの自動化',
            description: 'エージェントが内蔵ブラウザーでクリック、入力、移動します。',
        },
        recording: {
            title: 'ブラウザーの録画',
            description: 'ブラウザーのセッションを証跡として録画します。',
        },
    },
    plugins: {
        title: 'Happier 外部のプラグイン',
        description: 'npm や独自のソースからプラグインをインストールします。',
        group: 'プラグイン',
        webhooks: {
            title: 'プラグインの Webhook',
            description: 'プラグインが外部サービスから Webhook を受け取ります。',
        },
        ui: {
            title: 'プラグインの画面',
            description: 'プラグインが提供する画面とパネルを表示します。',
            hostedWeb: {
                title: 'Web プラグインの画面',
                description: 'Web 向けに作られたプラグインの画面を表示します。',
            },
            reactNativeBundles: {
                title: 'ネイティブプラグインの画面',
                description: 'React Native で作られた信頼済みプラグインの画面を実行します。',
            },
        },
    },
    devices: {
        title: 'デバイス',
        description: 'シミュレーターと接続中のデバイス。',
        simulatorPreview: {
            title: 'シミュレーターのプレビュー',
            description: 'マシン上のシミュレーターやエミュレーターを表示します。',
        },
    },
    social: {
        friends: {
            title: '友達',
            description: '友達を追加して、共有しているものを見られます。',
        },
    },
    auth: {
        group: 'サインイン',
        recovery: {
            providerReset: {
                title: 'プロバイダーでのリセット',
                description: 'ID プロバイダーでサインインしてアカウントを復旧します。',
            },
        },
        login: {
            keyChallenge: {
                title: '鍵でのサインイン',
                description: 'デバイスの鍵を証明してサインインします。',
            },
        },
        mtls: {
            title: 'クライアント証明書',
            description: 'クライアント証明書 (mTLS) でサインインします。',
        },
        ui: {
            recoveryKeyReminder: {
                title: '復旧キーのリマインダー',
                description: '復旧キーを保存するよう促します。',
            },
        },
        pairing: {
            desktopQrMobileScan: {
                title: 'スキャンでサインイン',
                description: 'パソコンのコードをスキャンしてスマートフォンでサインインします。',
            },
            boundQrV2: {
                title: 'より安全なペアリングコード',
                description: 'この Home とこの方向でのみ有効なペアリングコード。',
            },
        },
    },
    encryption: {
        group: '暗号化',
        plaintextStorage: {
            title: '暗号化なしの保存',
            description: 'エンドツーエンド暗号化なしでセッションを保存します。',
        },
        accountOptOut: {
            title: '暗号化の無効化',
            description: '各メンバーがエンドツーエンド暗号化をオフにできます。',
        },
    },
    remoteHosts: {
        group: 'リモートホスト',
        management: {
            title: 'リモートホスト',
            description: 'セッションを実行する SSH ホストを保存します。',
        },
        secretMaterial: {
            title: '保存したホストのシークレット',
            description: 'SSH ホストのパスワードと鍵を保存します。',
        },
    },
    e2ee: {
        keylessAccounts: {
            title: '鍵のないアカウント',
            description: 'エンドツーエンド暗号化の鍵を持たないアカウント。',
        },
    },
    bugReports: {
        title: 'バグレポート',
        description: '診断情報付きでバグレポートを送ります。',
    },
    terminal: {
        group: 'ターミナル',
        embeddedPty: {
            title: 'ターミナル',
            description: 'Happier の中でマシンのターミナルを開きます。',
        },
        transport: {
            byteStream: {
                title: 'ストリーミングターミナル',
                description: '内蔵ターミナル向けのより高速な接続。',
            },
        },
    },
    search: {
        title: '検索',
        description: 'セッションとトランスクリプトを検索します。',
    },
    providers: {
        title: 'モデルプロバイダー',
        description: 'モデルプロバイダーを接続し、エージェントのモデルを選びます。',
        group: 'モデルプロバイダー',
        localDiscovery: {
            title: 'ローカルプロバイダーの検出',
            description: 'マシンで動いているモデルサーバーを見つけます。',
        },
        localModelManagement: {
            title: 'ローカルモデルの管理',
            description: 'ローカルモデルをダウンロードして管理します。',
        },
    },
    keys: {
        HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: {
            title: 'レポートサービスのアドレス',
            description: 'バグレポートの送信先。空欄の場合、レポートサービスは提供されません。',
        },
        HAPPIER_FEATURE_BUG_REPORTS__DEFAULT_INCLUDE_DIAGNOSTICS: {
            title: '既定で診断情報を含める',
            description: '報告者がオプトアウトしない限り、レポートフォームに診断情報を含めます。',
        },
        HAPPIER_FEATURE_BUG_REPORTS__MAX_ARTIFACT_BYTES: {
            title: '最大添付ファイルサイズ',
            description: 'バグレポートに添付できるファイルの最大サイズ（バイト単位）。',
        },
        HAPPIER_FEATURE_BUG_REPORTS__UPLOAD_TIMEOUT_MS: {
            title: 'アップロードの制限時間',
            description: 'バグレポートのアップロードにかけられる時間（ミリ秒単位）。',
        },
        HAPPIER_FEATURE_BUG_REPORTS__ACCEPTED_ARTIFACT_KINDS: {
            title: '受け付ける添付ファイルの種類',
            description: 'バグレポートが受け付ける添付ファイルの種類。空欄の場合は通常の種類を受け付けます。',
        },
        HAPPIER_FEATURE_BUG_REPORTS__CONTEXT_WINDOW_MS: {
            title: 'コンテキストの収集期間',
            description: 'バグレポートがコンテキストをさかのぼって収集する期間（ミリ秒単位）。',
        },
        HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: {
            title: '音声にはサブスクリプションが必要',
            description: 'サブスクライバーだけが音声を使えます。未設定の場合、本番環境では必須、それ以外の環境では不要です。',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_MANIFEST_BYTES: {
            title: 'ペットマニフェストの最大サイズ',
            description: '受け付けるペットマニフェストの最大サイズ（バイト単位）。',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_SPRITESHEET_BYTES: {
            title: 'ペットスプライトシートの最大サイズ',
            description: '受け付けるペットスプライトシートの最大サイズ（バイト単位）。',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_PACKAGE_BYTES: {
            title: 'ペットパッケージの最大サイズ',
            description: '受け付けるペットパッケージの最大サイズ（バイト単位）。',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PETS_PER_ACCOUNT: {
            title: '1 人あたりのインポートしたペット数',
            description: '1 人が保持できるインポートしたペットの最大数。',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PET_BYTES_PER_ACCOUNT: {
            title: '1 人あたりのインポートしたペットの容量',
            description: '1 人が保持できるインポートしたペットの最大バイト数。',
        },
        HAPPIER_FEATURE_PETS_SYNC__ENCRYPTED_CUSTOM_PET_SYNC_POLICY: {
            title: '暗号化されたカスタムペット',
            description: '将来のために予約されています。暗号化されたカスタムペットはまだ同期されないため、オフのままです。',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES: {
            title: 'この Home 経由の最大転送サイズ',
            description: 'この Home 経由の転送で運べるファイルの最大サイズ（バイト単位）。',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_ACTIVE_TRANSFERS_PER_SOCKET: {
            title: '接続ごとの同時転送数',
            description: '1 つの接続がこの Home 経由で同時に実行できる転送の最大数。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES: {
            title: 'トンネルあたりのデータ量',
            description: 'この Home 経由の 1 つのトンネルが運べる最大バイト数。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_ACTIVE_TUNNELS_PER_SOCKET: {
            title: '接続ごとのトンネル数',
            description: '1 つの接続がこの Home 経由で同時に開いておけるトンネルの最大数。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: 'トンネルフレームの最大サイズ',
            description: 'この Home 経由のトンネルが運べるフレームの最大サイズ（バイト単位）。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__SUPPORTED_ENCODINGS: {
            title: 'トンネルのエンコーディング',
            description: 'この Home 経由のトンネルが受け付けるフレームエンコーディング。空欄の場合は標準のものを使います。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__PREFERRED_ENCODING: {
            title: '優先するトンネルエンコーディング',
            description: '最初に使うフレームエンコーディング。受け付けるエンコーディングのいずれかである必要があります。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BINARY_HEADER_BYTES: {
            title: 'フレームヘッダーの最大サイズ',
            description: 'バイナリフレームヘッダーの最大サイズ（バイト単位）。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_RAW_PAYLOAD_BYTES: {
            title: 'フレームペイロードの最大サイズ',
            description: '1 フレーム内の生ペイロードの最大サイズ（バイト単位）。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAMED_MESSAGE_BYTES: {
            title: 'フレーム化メッセージの最大サイズ',
            description: 'フレーム化されたメッセージの最大サイズ（バイト単位）。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_CONCURRENT_SUBSTREAMS: {
            title: 'トンネルごとの同時ストリーム数',
            description: '1 つのトンネルが同時に実行できるストリームの最大数。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_TOTAL_SUBSTREAMS: {
            title: 'トンネルごとのストリーム数',
            description: '1 つのトンネルが存続期間中に開けるストリームの最大数。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES_PER_SUBSTREAM: {
            title: 'ストリームあたりのデータ量',
            description: '1 つのストリームが運べる最大バイト数。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_AGGREGATE_BYTES: {
            title: 'トンネルの全ストリームのデータ量',
            description: '1 つのトンネルの全ストリームが合計で運べる最大バイト数。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SUBSTREAM_IDLE_MS: {
            title: 'アイドルストリームの制限時間',
            description: 'ストリームが閉じるまでにアイドル状態でいられる時間（ミリ秒単位）。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SESSION_IDLE_MS: {
            title: 'アイドルトンネルの制限時間',
            description: 'この Home 経由のトンネルが閉じるまでにアイドル状態でいられる時間（ミリ秒単位）。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_IDLE_MS: {
            title: 'トンネルのアイドル制限時間',
            description: 'トンネルが閉じるまでにアイドル状態でいられる時間（ミリ秒単位）。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_DURATION_MS: {
            title: 'トンネルの最長時間',
            description: 'トンネルが開いていられる最長時間（ミリ秒単位）。',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: {
            title: 'トンネルで到達できるポート',
            description: 'トンネルが開けるポート。空欄の場合は既定のポートのみ許可します。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__TOKEN_TTL_MS: {
            title: 'プレビューリンクの有効期間',
            description: '非公開プレビューリンクが使える期間（ミリ秒単位）。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: {
            title: 'プレビューのドメイン',
            description: '各プレビューを個別のアドレスで提供するドメイン。空欄の場合は、この Home のアドレス配下でプレビューを提供します。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: {
            title: '公開プレビューのモード',
            description: 'プレビューを公開する方法。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: {
            title: '公開プレビューの最長時間',
            description: 'プレビューを公開しておける最長時間（ミリ秒単位）。空欄の場合は標準の上限を使います。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_CONCURRENT_EXPOSURES: {
            title: '同時公開プレビュー数',
            description: '同時に公開できるプレビューの最大数。空欄の場合は標準の上限を使います。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: {
            title: 'DNS と TLS を必須にする',
            description: '公開プレビューには DNS と TLS が必要です。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_SINK: {
            title: '公開プレビューの監査ログ',
            description: '公開プレビューの記録先。公開プレビューには必須です。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_LOG_PATH: {
            title: '監査ログファイル',
            description: '公開プレビューの監査ログを書き込むファイル。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: {
            title: 'テスト用監査ログを許可',
            description: '開発専用です。メモリ内のテスト用監査ログを受け付けます。本番環境では無視されます。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: {
            title: '公開プレビューのレート制限',
            description: '公開プレビューが使えるレート制限プロファイル。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER: {
            title: 'レート制限チェッカー',
            description: '公開プレビューへのリクエストをレート制限する方法。公開プレビューには必須です。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS: {
            title: 'ウィンドウあたりのリクエスト数',
            description: '公開プレビューが各ウィンドウで許可するリクエスト数。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS: {
            title: 'レート制限ウィンドウ',
            description: '各レート制限ウィンドウの長さ（ミリ秒単位）。',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: {
            title: 'テスト用レートリミッターを許可',
            description: '開発専用です。メモリ内のテスト用レートリミッターを受け付けます。本番環境では無視されます。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_REQUESTS: {
            title: '処理中の Webhook',
            description: 'このサーバーが同時に処理する Webhook リクエストの最大数。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_WORKING_BYTES: {
            title: 'Webhook のメモリ',
            description: '処理中の Webhook リクエストが使えるメモリの最大量（バイト単位）。空欄の場合は、リクエスト数の上限で許される分まで使えます。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_RATE_PER_MINUTE: {
            title: 'ルートごとの毎分の Webhook 数',
            description: '1 つのルートでの 1 分あたりの Webhook リクエスト数。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_CONCURRENCY: {
            title: 'ルートごとの同時 Webhook 数',
            description: '1 つのルートで処理中の Webhook リクエスト数。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_RATE_PER_MINUTE: {
            title: 'エンドポイントごとの毎分の Webhook 数',
            description: '1 つのエンドポイントでの 1 分あたりの Webhook リクエスト数。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_CONCURRENCY: {
            title: 'エンドポイントごとの同時 Webhook 数',
            description: '1 つのエンドポイントで処理中の Webhook リクエスト数。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_RATE_PER_MINUTE: {
            title: '1 人あたりの毎分の Webhook 数',
            description: '1 人あたりの 1 分間の Webhook リクエスト数。',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_CONCURRENCY: {
            title: '1 人あたりの同時 Webhook 数',
            description: '1 人あたりの処理中の Webhook リクエスト数。',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES: {
            title: 'プラグイン画面バンドルの最大サイズ',
            description: 'この Home がホストするプラグイン画面バンドルの最大サイズ（バイト単位）。',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES: {
            title: '1 人あたりのプラグイン画面の容量',
            description: '1 人が保存できるプラグイン画面バンドルの最大バイト数。',
        },
        HAPPIER_COLLECTION_MAX_ROW_ENCODED_BYTES: {
            title: 'プラグインデータ行の最大サイズ',
            description: 'プラグインが保存する行の最大サイズ（バイト単位）。',
        },
        HAPPIER_COLLECTION_MAX_BATCH_BYTES: {
            title: 'プラグインデータバッチの最大サイズ',
            description: 'プラグインデータの変更 1 バッチの最大サイズ（バイト単位）。',
        },
        HAPPIER_COLLECTION_MAX_BATCH_ROWS: {
            title: 'プラグインデータバッチあたりの行数',
            description: 'プラグインデータの変更 1 バッチに含まれる行の最大数。',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: {
            title: '1 人あたりのプラグインデータ行数',
            description: '1 人が保存できるプラグインデータの最大行数。',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_BYTES: {
            title: '1 人あたりのプラグインデータ容量',
            description: '1 人が保存できるプラグインデータの最大バイト数。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_BITRATE_BPS: {
            title: '配信の最大ビットレート',
            description: 'この Home 経由のライブ配信の最大ビットレート（ビット/秒）。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAMES_PER_SECOND: {
            title: '配信の最大フレームレート',
            description: 'この Home 経由のライブ配信の最大フレームレート。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: '配信フレームの最大サイズ',
            description: 'この Home 経由のライブ配信のフレームの最大サイズ（バイト単位）。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_DURATION_MS: {
            title: 'ライブ配信の最長時間',
            description: 'この Home 経由のライブ配信を続けられる最長時間（ミリ秒単位）。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_TOTAL_BYTES: {
            title: 'ライブ配信あたりのデータ量',
            description: 'この Home 経由の 1 つのライブ配信が運べる最大バイト数。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_ACCOUNT: {
            title: '1 人あたりの同時ライブ配信数',
            description: '1 人がこの Home 経由で同時に実行できるライブ配信の最大数。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_SOCKET: {
            title: '接続ごとの同時ライブ配信数',
            description: '1 つの接続がこの Home 経由で同時に実行できるライブ配信の最大数。',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_MACHINE: {
            title: 'マシンごとの同時ライブ配信数',
            description: '1 台のマシンがこの Home 経由で同時に実行できるライブ配信の最大数。',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: {
            title: '接続署名鍵の ID',
            description: 'マシン間の接続に署名する鍵を指定します。署名鍵がない場合、これらの接続はオフになります。',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: {
            title: '接続署名用の秘密鍵',
            description: 'マシン間の接続に署名する秘密鍵。',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: {
            title: '接続署名用の公開鍵',
            description: '署名鍵に対応する公開鍵。空欄の場合は秘密鍵から導出されます。',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: {
            title: '署名鍵の有効期限',
            description: '署名鍵の有効期限（ミリ秒単位のタイムスタンプ）。',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: {
            title: 'ユーザー名で友達を探す',
            description: 'リンクしたアカウントに加えて、ユーザー名でも友達を探せます。',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__IDENTITY_PROVIDER: {
            title: '友達照合のプロバイダー',
            description: '友達の照合に使うサインインプロバイダー。',
        },
    },
};

const homeFeatureTranslations = { ja } as const;

return { homeFeatureTranslations };
})();

const Domain_homeGovernanceTranslations = (() => {
const en = Shared_homeGovernanceTranslations.en;

const ja: typeof en = {
    title: 'Home の管理',
    pages: {
        features: 'この Home が提供するもの。変更は次回の更新ですべてに反映されます。',
        data: 'この Home が保持するものと、その期間。',
        homes: '管理している各 Home のアカウント、ロール、チーム、サインインのルール。',
        overview: 'この Home を管理している人と、ここで変更できること。',
        people: 'この Home のアカウント、そのロール、サインインできるかどうか。',
        policies: 'サインインできる人、アカウントの作成方法、データの保護方法。',
        teams: 'この Home のすべてのチーム。チームを管理しても、そのセッションにはアクセスできません。',
        identityProvider: 'この Home へのサインインに使える ID サービス。',
        identityProviderEditor: 'この ID サービスの接続方法と、許可する相手。',
        githubApp: 'この Home がリポジトリにアクセスするための GitHub App。',
        githubAppEditor: 'この Home の GitHub App を登録または変更します。',
        email: 'この Home がメールを送信する方法。',
        reach: 'デバイス、招待リンク、メールがこの Home にたどり着く方法。',
        runtime: 'この Home を動かしているサーバー。',
        activity: 'この Home で誰が何をいつ変更したか。',
    },
    overview: '概要',
    people: 'メンバー',
    teams: 'チーム',
    policies: 'ポリシー',
    console: {
        serverSettings: 'サーバー設定',
        serverSettingsDescription: 'サーバーが読み取るすべての設定と、変更が反映されるタイミング。',
        allHomes: 'すべての Home',
        backToHomes: 'Home 一覧に戻る',
        viewerOwner: 'あなたはオーナーです',
        viewerAdmin: 'あなたは管理者です',
        noOwnerYet: 'オーナーはまだいません',
        administer: '管理',
        navigation: 'Home 管理ページ',
    },
    /** The console Overview (lab `hcOverview-A`): what needs the owner, who owns the Home, and its facts. */
    overviewPage: {
        description: 'この Home を運営している人と、対応が必要なこと。',
        attention: '対応が必要',
        emailNotSetUpTitle: 'メールが設定されていません',
        emailNotSetUpBody: 'アドレスの確認、パスワードのリセット、メールでの招待の受け取りができません。',
        emailNoLinkTitle: 'メールにまだリンクを含められません',
        emailNoLinkBody: '送信は設定済みですが、この Home にはリンク用の Web アプリのアドレスがありません。',
        emailPasswordTitle: 'メールのパスワードを読み取れません',
        emailPasswordBody: 'この Home がメールを送れるよう、SMTP パスワードをもう一度入力してください。',
        setUpEmail: 'メールを設定',
        openEmail: 'メールを開く',
        noAddressTitle: '公開アドレスがありません',
        noAddressBody: 'ほかのネットワークのデバイスや招待リンクからこの Home に届きません。',
        setUpReach: '設定',
        githubPartlySetUp: 'GitHub サインインの設定が途中です',
        workosPartlySetUp: 'WorkOS の設定が途中です',
        workosNeedsClientIdBody: 'チームが会社サインインを接続するには、クライアント ID が必要です。',
        workosNeedsApiKeyBody: 'チームが会社サインインを接続するには、API キーが必要です。',
        githubNeedsClientIdBody: 'GitHub でサインインするには、クライアント ID が必要です。',
        githubNeedsClientSecretBody: 'GitHub でサインインするには、クライアントシークレットが必要です。',
        finish: '完了する',
        nameDescription: 'アプリと招待に表示されます。',
        review: '確認',
        settingsFailed: 'この Home の設定を確認できませんでした',
        emailFailed: 'この Home のメールの状態を読み取れませんでした',
        reachFailed: 'この Home への到達方法を読み取れませんでした',
        ownership: 'オーナー',
        ownerYou: 'オーナー · あなた',
        peopleFailed: 'この Home のメンバーを読み取れませんでした',
        thisHome: 'この Home',
        version: 'バージョン',
        signIn: 'サインイン',
        signInOpen: '誰でもアカウントを作成できます',
        signInInvited: '招待制',
        signInNone: '有効なサインイン方法がありません',
        /** People · owners · admins; `more` while the Home has further pages, `admins` null when unknown. */
        peopleSummary: ({ people, more, owners, admins }: { people: number; more: boolean; owners: number; admins: number | null }) => [`${people}${more ? '+' : ''} 人`, `オーナー ${owners} 人`, admins === null ? null : `管理者 ${admins} 人`].filter((part) => part !== null).join(' · '),
    },
    /** "Invite people" on Overview, People and Teams: one dialog over the Team invitation form. */
    invite: {
        action: 'メンバーを招待',
        description: 'この Home には、いずれかのチームに参加することで加わります。',
        team: 'チーム',
        noTeams: '招待できるチームがまだありません',
        noTeamsBody: 'Home にはチームを通じて参加します。まずチームを作成してください。',
        notAdministered: 'この Home のチームには招待できません',
        notAdministeredBody: '各チームへの招待は、そのチームのオーナーと管理者が行います。依頼するか、自分のチームを作成してください。',
        createTeam: 'チームを作成',
        notAdministeredAskBody: '各チームへの招待は、そのチームのオーナーと管理者が行います。依頼してください。',
        joinByTeam: 'Home にはチームを通じて参加します。',
        teamsFailed: 'この Home のチームを読み取れませんでした',
    },

    yourRole: 'あなたのロール',
    roleOwner: 'オーナー',
    roleAdmin: '管理者',
    roleMember: 'メンバー',
    activeOwners: '有効なオーナー',
    accountSection: 'アカウント',
    accountAccessSection: 'アクセス',
    homeAddress: 'Home のアドレス',

    setupRequiredTitle: 'Home の管理設定が必要です',
    setupRequiredBody: 'この Home にはまだ有効なオーナーがいません。サーバーにアクセスできる担当者が、実行中のマシンから最初のオーナーを割り当てます。',

    manageTeams: 'チームを管理',
    teamsDisabled: 'この Home ではチームが有効になっていません。',
    teamsDisabledAction: '機能でオンにする',
    teamsEmpty: 'この Home にはまだチームがありません。',

    loading: 'この Home を読み込んでいます…',
    refreshing: '更新中…',
    updating: '更新中…',
    staleNotice: 'この Home の最後に確認できた状態を表示しています。再び応答するまで変更はできません。',
    offlineNotice: 'この Home が応答していません。閲覧はできますが、変更はできません。',
    unavailableTitle: 'この Home は利用できません',
    unavailableBody: 'Happier はこの Home の管理状態を読み取れませんでした。',
    forbiddenTitle: 'この Home は管理できません',
    forbiddenBody: 'あなたのアカウントにはここでの管理権限がありません。',
    retry: 'もう一度試す',
    loadMore: 'さらに読み込む',
    unsupportedBody: 'この Home は管理機能を提供していません。古いバージョンの可能性があります。',
    notObservedTitle: 'まだ読み込まれていません',
    notObservedBody: 'この Home はまだこの端末に管理状態を伝えていません。',
    lastUpdated: ({ time }: { time: string }) => `最終更新 ${time}`,

    chooseHome: 'Home を選択',
    chooseHomeFooter: 'Home ごとにアカウント、ロール、ポリシーは別々です。',
    homesEmpty: 'まだ Home がありません',
    homesEmptyBody: 'この端末に Home を追加すると、ここで管理できます。',
    homesNoneAdministrable: '管理できる Home がありません',
    homesNoneAdministrableBody: '表示中のどの Home も、このアカウントに管理権限を与えていません。',
    homeNotAnswering: ({ home }: { home: string }) => `${home} が応答していません`,
    signedOutTitle: 'この Home からサインアウトしています',
    signedOutBody: 'この Home に再度サインインすると管理できます。',
    credentialUnreadableTitle: 'このデバイスに保存されたサインイン情報を読み取れませんでした',
    credentialUnreadableBody: '問題は Home ではなくこのデバイス側にあり、サインアウトはされていません。もう一度お試しください。',
    credentialUnreadableInviteBody: '問題は Home ではなくこのデバイス側にあります。招待リンクは引き続き有効なので、今すぐ再試行するか、後でもう一度開いてください。',

    peopleEmpty: 'この Home にはまだアカウントがありません。',
    rosterUnavailableTitle: 'メンバー一覧はまだ利用できません',
    rosterUnavailableBody: 'この Home はまだ Happier にアカウント一覧を提供していません。提供されるとロールと状態がここに表示されます。',
    accountUnavailableBody: 'このアカウントはこの Home からまだ取得できません。',
    searchPlaceholder: 'アカウントを検索',
    searchEmpty: 'この検索に一致するアカウントはありません。',
    searchUnsupported: 'この Home では検索を利用できません',
    searchUnsupportedBody: 'この Home はアカウント検索を提供していません。古いバージョンの可能性があります。',
    searchFailed: '検索を完了できませんでした',

    statusActive: '有効',
    statusDisabled: '無効',
    statusRetired: '廃止済み',
    statusDisabledDetail: 'すべての端末でサインアウト済み。再度有効にできます。',
    statusRetiredDetail: 'アクセスは恒久的に取り消されています。',

    changeRole: 'ロールを変更',
    disable: 'アカウントを無効にする',
    enable: 'アカウントを再度有効にする',
    deleteAccount: 'アカウントとデータを削除…',
    retryDeletion: '削除をやり直す',

    reasonLastActiveOwner: 'この Home には有効なオーナーが少なくとも 1 人必要です。先に別のアカウントをオーナーにしてください。',
    reasonTargetInactive: '有効なアカウントだけが Home のロールを持てます。',
    reasonHomeUnreachable: 'この Home が応答していません。再接続後に変更できます。',

    roleSheetTitle: 'Home のロール',
    roleOwnerDescription: 'アカウントの削除を含め、この Home のすべてを管理できます。',
    roleAdminDescription: 'アカウントとチームを管理できますが、オーナーは変更できません。',
    roleMemberDescription: 'Home の管理権限はありません。',

    disableTitle: ({ account }: { account: string }) => `${account} を無効にしますか？`,
    disableBody: 'すべての端末でサインアウトされ、マシンの接続も切断されます。個人用アクセストークンは完全に失効し、セッションの担当も解除され、アクセスを失う各セッションでは未送信の下書きが破棄されフォローも解除されます。再度有効にするとアクセスは戻りますが、下書き・フォロー・担当は戻りません。チームのメンバーシップと暗号鍵は保持されます。',
    disableConfirm: '無効にする',
    enableTitle: ({ account }: { account: string }) => `${account} を再度有効にしますか？`,
    enableBody: '本人は自分の端末で再びサインインできます。取り消し済みのアクセストークンは取り消されたままです。',
    enableConfirm: '再度有効にする',
    deleteTitle: ({ account }: { account: string }) => `${account} とそのすべてのデータを削除しますか？`,
    deleteBody: ({ home }: { home: string }) => `${home} 上のアカウントとそのデータを恒久的に削除します。元に戻せません。Home やチームのオーナー権限は事前に移譲してください。`,
    deleteConfirm: '削除',

    deleteIncompleteTitle: '削除が完了しませんでした',
    deleteIncompleteBody: 'アクセスは取り消され、このアカウントは廃止済みになりましたが、クリーンアップが完了しませんでした。削除をやり直して完了させてください。',
    deleteIncompleteMemberBody: 'アクセスは取り消されましたが、クリーンアップが完了しませんでした。Home のオーナーまたはサーバー運用者が完了できます。',

    errorForbidden: 'この Home でこの変更を行う権限がなくなりました。',
    errorOwnerTransferRequired: 'この Home には有効なオーナーが少なくとも 1 人必要です。先に別のアカウントをオーナーにしてください。',
    errorTeamOwnerTransferRequired: 'あるチームがまだこのアカウントをオーナーとして必要としています。先にそのチームに別のオーナーを設定してください。',
    errorAccountNotFound: 'このアカウントはこの Home に存在しません。',
    errorAccountInactive: 'このアカウントは有効ではないため、この権限を受け取れません。',
    errorErasureTransitionCleanupPending: '暗号化データのクリーンアップが完了するまで、アカウントの削除は保留されます。もう一度アカウントを削除してください。',
    errorGeneric: 'この Home は変更を完了できませんでした。何も変更されていません。',
    errorConflict: 'ここでは先に別の変更が行われました。この Home を再読み込みしてからやり直してください。',
    changeFailedTitle: '変更は実行されませんでした',
    errorOutcomeUnknownTitle: 'この変更は確認できませんでした',
    errorOutcomeUnknown: 'リクエストはこの Home に届きましたが、応答が失われました。適用されている可能性があります。もう一度試す前に、この Home を再読み込みして確認してください。',

    teamCreation: 'チームの作成',
    teamCreationSelfService: '誰でもチームを作成できる',
    teamCreationSelfServiceDescription: 'この Home の有効なメンバーはチームを作成し、そのオーナーになれます。',
    teamCreationManagedOnly: '管理者がチームを作成する',
    teamCreationManagedOnlyDescription: 'オーナーと管理者がチームを作成し、最初のオーナーを選びます。',
    teamCreationDisabled: 'チームの作成を無効にする',
    teamCreationDisabledDescription: '新しいチームは作成されません。既存のチームは変わりません。',
    teamCreationWho: 'チームを作成できる人',
    teamCreationAnyone: '全員',
    teamCreationAdmins: '管理者',
    teamCreationNobody: 'なし',
    teamsVisibility: 'チームを表示する相手',
    teamsVisibleToMembers: 'メンバーにチームを表示',
    teamsVisibleToMembersDescription: 'オフにすると、チームのメンバーと管理者だけがチームを表示できます。',
    teamJit: 'サインインによる自動チーム参加',
    teamJitDescription: 'チームに接続された ID プロバイダーでサインインすると、招待や承認なしにそのチームへ自動的に参加します。',
    githubEnterpriseOrigins: '承認済み GitHub Enterprise ホスト',
    githubEnterpriseOriginsDescription: '1 行に 1 つの正規 HTTPS オリジンを入力します。チームはこれらのホストにのみ GitHub App を接続できます。',
    githubEnterpriseOriginsInvalid: 'パス、クエリ、認証情報、フラグメントを含まない一意の HTTPS オリジンを入力してください。',

    signInTitle: 'サインインと参加',
    authActionLogin: 'サインイン',
    authActionProvision: '新規アカウント',
    authActionConnect: 'アカウントの連携',
    authReasonMethodNotEnabled: 'サインイン方法が無効です',
    authReasonProvisioningNotEnabled: 'アカウントの作成が無効です',
    authReasonAccountModeUnavailable: 'アカウントの種類を利用できません',
    authReasonEmailDeliveryUnavailable: 'メール配信を利用できません',
    authInherited: 'サーバーの既定値を使用',
    authInheritedDescription: 'この Home はサインイン方法やアカウント種別を制限していません。',
    authNarrowed: 'この Home で制限',
    authUnreadable: '設定の確認が必要です',
    authUnreadableDescription: 'この Home には、このサーバーのバージョンでは読み取れないサインイン設定が保存されています。運用者が修復するまでサインインは利用できません。',
    signInMethods: 'サインイン方法',
    accountModes: 'アカウント種別',
    accountModePlain: '通常',
    accountModeE2ee: 'エンドツーエンド暗号化',
    recommendedMode: '新しいアカウントの推奨',
    recommendedModeDescription: '新しいアカウントの既定値を設定します。既存のアカウントは変更されません。',
    admissionSelfService: '誰でも',
    admissionInvitationOnly: '招待のみ',
    admissionClosed: '誰も不可',

    deploymentServices: 'デプロイのサービス',
    deploymentServicesDescription: 'このサーバー向けに運用者が設定する ID サービスです。Home の管理からは変更できません。',
    privateEndpoints: 'プライベート ID エンドポイント',
    privateEndpointsDescription: '管理されたサインインがプライベートネットワーク上の ID プロバイダーに到達できるようにします。ここに挙げたホスト、ネットワーク、ポートだけが到達可能です。',
    privateEndpointsPublicOnly: '公開エンドポイントのみ',
    privateEndpointsAllowlist: 'プライベート許可リスト',
    privateEndpointsHostnames: '許可するホスト名',
    privateEndpointsCidrs: '許可するネットワーク (CIDR)',
    privateEndpointsPorts: '許可するポート',
    privateEndpointsSave: 'ネットワークポリシーを保存',
    privateEndpointsInvalid: 'ホスト名かネットワークを 1 つ以上と、1〜65535 のポートを指定してください。',
    privateEndpointsUnreadable: 'この Home には、このサーバーバージョンでは読めないネットワークポリシーが保存されています。管理されたサインインは公開エンドポイントのみを使います。',

    policyReadOnly: 'これを変更できるのは Home のオーナーだけです。',
    policyEditingUnavailable: 'この端末からはまだポリシーを変更できません。',
    revisionConflictTitle: 'このポリシーは別の場所で変更されました',
    revisionConflictBody: '編集中に他の人が保存しました。選択内容は保持されています。この Home を再読み込みして、もう一度適用してください。',
    reload: '再読み込み',
    person: {
        you: 'あなた',
        roleDescription: 'メンバーは Home を使います。管理者はさらにユーザーとチームを管理します。',
        roleChangeTitle: ({ account, role }: { account: string; role: string }) => `${account} を${role}にしますか?`,
        roleChangeBody: 'この Home へのアクセスはすぐに変わります。あなたの名前でアクティビティに記録されます。',
        roleChangeConfirm: 'ロールを変更',
        signIn: 'サインイン',
        signInDescription: 'この人がサインインに使えるもの。本人が自分のアカウントで管理します。',
        methods: '方法',
        linkedProviders: '連携プロバイダー',
        none: 'なし',
        teams: 'チーム',
        noTeams: 'どのチームにも所属していません',
        teamArchived: 'アーカイブ済みのチーム',
        teamSuspended: '停止中',
        access: 'アクセス',
        accessDescription: '各デバイスでサインイン中 — セッションは個別には記録されません。',
        machines: 'マシン',
        apiTokens: 'API トークン',
        apiTokensLastUsed: ({ time }: { time: string }) => `最終使用 ${time}`,
        apiTokensNeverUsed: '未使用',
        signOutEverywhere: 'すべてのデバイスからサインアウト',
        signOutEverywhereDescription: 'すべてのデバイスのサインイン中のセッションを終了します。API トークンはアカウントが無効になるまで使えます。',
        signOutEverywhereTitle: ({ account }: { account: string }) => `${account} をすべてのデバイスからサインアウトしますか?`,
        signOutEverywhereBody: 'サインイン中のすべてのデバイスで再度サインインが必要になります。API トークンはアカウントを無効にするまで使えます。あなたの名前でアクティビティに記録されます。',
        signOutEverywhereDone: 'すべてのデバイスからサインアウトしました',
        recentActivity: '最近のアクティビティ',
        noRecentActivity: 'この人に関する管理上の変更はまだありません。',
        showAllActivity: 'すべて表示',
        disableOrDelete: '無効化または削除',
        dangerFootnote: '無効化するとサインアウトされ、API トークンも止まります。元に戻せます。削除するとアカウントとデータがこの Home から完全に消えます。',
    },
    email: {
        title: 'メール',
        status: '状態',
        sendingMail: 'メール送信',
        sendingReady: ({ host }: { host: string }) => `準備完了 · ${host} 経由で送信`,
        sendingNotSetUp: '未設定',
        links: 'メール内のリンク',
        linksReady: 'この Home のウェブアプリで開きます',
        linksOpenAt: ({ host }: { host: string }) => `${host} で開きます`,
        setInReach: '到達経路で設定',
        linksMissing: 'ウェブアプリのアドレスがないため、リンクを作成できません',
        mailServer: 'メールサーバー',
        mailServerDescription: '確認、パスワード再設定、招待のメールを送信する SMTP サーバー。',
        server: 'サーバー',
        port: 'ポート',
        portAndSecurity: 'ポートとセキュリティ',
        security: '接続のセキュリティ',
        tls: 'TLS',
        starttls: 'STARTTLS',
        username: 'ユーザー名',
        password: 'パスワード',
        passwordDescription: 'サーバーに暗号化して保存されます。再び表示されることはありません。',
        saved: '保存済み',
        replace: '置き換え',
        clear: '削除',
        keep: '保持',
        clearPending: '保存すると、保存済みのパスワードは削除されます。',
        valueSet: '設定済み',
        valueNotSet: '未設定',
        sender: '送信者',
        fromAddress: '送信元アドレス',
        fromName: '送信者名',
        test: 'テストメールを送信',
        testDescription: 'リンクを含まない短いメッセージを送信します。',
        testTo: '宛先',
        testToPlaceholder: '確認できる任意のアドレス',
        testSend: '送信',
        testSaveFirst: 'テストを送信する前に変更を保存してください。',
        testSent: ({ to }: { to: string }) => `${to} に送信しました`,
        testSentDetail: '受信トレイを確認し、見当たらない場合は迷惑メールフォルダも確認してください。',
        testFailed: '送信できませんでした',
        testNotConfigured: 'メールはまだ設定されていません。',
        testPasswordUnreadable: '保存済みのパスワードを読み取れません。もう一度入力してください。',
        testRenderFailed: 'テストメッセージを準備できませんでした。',
        testTransportFailed: 'メールサーバーに接続できないか、メッセージが拒否されました。',
        adminTitle: 'メール設定を変更できるのはオーナーだけです',
        adminBody: 'この Home の管理者なので表示されています。',
        notSetUpTitle: 'メールが設定されていません',
        notSetUpBody: '設定されるまで、パスワードの再設定、メールの確認、メールでの招待は無効です。',
        unreadableTitle: '保存済みのパスワードを読み取れません',
        unreadableBody: '保存後にサーバーのマスターシークレットが変更されました。パスワードをもう一度入力してください。',
        invalidValue: '有効な値を入力してください。',
        invalidPort: '1〜65535 のポートを使用してください。',
        invalidEmail: 'メールアドレスを入力してください。',
        conflictTitle: 'メール設定が別の場所で変更されました',
        conflictBody: '編集中に他の人が変更を保存しました。あなたの編集は保持されています。確認してからもう一度保存してください。',
        loadFailed: 'この Home からメール設定が返されませんでした。',
    },
    signInProviders: {
        title: 'サインインプロバイダー',
        description: 'この Home へのサインイン方法と、チームが接続できるもの。',
        ownersOnlyTitle: 'サインインプロバイダーを変更できるのはオーナーだけです',
        ownersOnlyBody: 'ID プロバイダーや GitHub App の追加・変更は、この Home のオーナーに依頼してください。',
        fromDeploymentReadOnly: 'デプロイメントから · 読み取り専用',
        platformsDescriptionReadOnly: ({ home }: { home: string }) => `${home} のサインインに使うアプリ。変更できるのは ${home} のオーナーだけです。`,
        fieldClientId: 'クライアント ID',
        fieldClientSecret: 'クライアントシークレット',
        fieldApiKey: 'API キー',
        workosClientIdHint: 'WorkOS の「API キー」にあります。',
        githubClientIdHint: 'GitHub OAuth アプリの設定ページにあります。',
        secretHintUnset: '暗号化して保存され、再表示されません。',
        secretHintSet: '暗号化して保存済み。表示されません。',
        neededWorkos: 'チームが接続する前に必要です',
        neededGithub: 'GitHub サインインを有効にする前に必要です',
        secretPlaceholder: 'キーを貼り付け',
        lockedFootnote: 'デプロイメントで設定された値は、サーバーの実行環境でのみ変更できます。',
        ignoredBannerTitle: '前回の起動時にサインイン設定が無視されました',
        showMe: '表示',
        callbackAddress: 'コールバックアドレス',
        callbackAddressHint: 'GitHub OAuth アプリに登録してください。',
        whoCanSignInGithub: 'GitHub でサインインできる人',
        companySignIn: '会社サインイン',
        companySignInDescription: 'ユーザーとチームがサインインに使える OpenID Connect プロバイダー。',
        addProvider: 'プロバイダーを追加',
        privateEndpointsTitle: 'プライベートエンドポイント',
        privateEndpointsPublicOnlyShort: '公開のみ',
        privateEndpointsAllowlistShort: '許可リスト',
        privateEndpointsPublicOnlyHint: 'プロバイダーは公開アドレス上にある必要があります。',
        privateEndpointsAllowlistHint: '以下のホストだけが非公開にできます。',
        platforms: 'サインインプラットフォーム',
        platformsDescription: ({ home }: { home: string }) => `${home} のサインインに使うアプリ：全員向けの GitHub、各チームの会社サインイン向けの WorkOS。`,
        githubSignIn: 'GitHub サインイン',
        githubPurpose: ({ home }: { home: string }) => `${home} に GitHub でサインインするための GitHub OAuth アプリ。GitHub サインインのオン／オフはポリシーで切り替えます。`,
        workosPurpose: ({ home }: { home: string }) => `${home} の各チームが、チームの認証ページから WorkOS 経由で自社のサインインとディレクトリを接続できます。`,
        notSetGithub: '未設定 · 設定するまで GitHub サインインはオフのままです',
        notSetWorkos: '未設定 · チームはまだ WorkOS を使えません',
        needsClientId: 'クライアント ID が必要です',
        needsClientSecret: 'クライアントシークレットが必要です',
        needsApiKey: 'API キーが必要です',
        pendingSummaryWorkos: '保存済み · 次回の再起動後にチームが接続できます',
        pendingSummaryGithub: '保存済み · 次回の再起動後に使われます',
        lockedSummary: 'デプロイメントで設定済み',
        readyPartlyLocked: ({ setting }: { setting: string }) => `準備完了 · ${setting}はデプロイメントで設定済み`,
        readyWorkos: '準備完了 · チームはこれを通じて接続できます',
        readyGithubOn: '準備完了 · GitHub でサインインできます',
        readyGithubOff: '準備完了 · ポリシーで GitHub サインインをオンにします',
        advanced: '詳細',
        appliesAfterRestart: 'ここでの変更はサーバーの再起動後に適用されます。',
        privateEndpointsOffHere: 'この Home ではオフ',
        teamRules: 'チームのサインインルール',
        teamRulesDescription: 'Home のプロバイダーに加えてチームが追加できるもの。',
        activity: {
            addedProvider: ({ name }: { name: string }) => `ID プロバイダー ${name} を追加しました`,
            changedProvider: ({ name }: { name: string }) => `ID プロバイダー ${name} を変更しました`,
            replacedProviderSecret: ({ name }: { name: string }) => `${name} のクライアントシークレットを置き換えました`,
            enabledProvider: ({ name }: { name: string }) => `${name} をオンにしました`,
            disabledProvider: ({ name }: { name: string }) => `${name} をオフにしました`,
            removedProvider: ({ name }: { name: string }) => `ID プロバイダー ${name} を削除しました`,
            addedGitHubApp: ({ name }: { name: string }) => `GitHub App ${name} を追加しました`,
            changedGitHubApp: ({ name }: { name: string }) => `GitHub App ${name} を変更しました`,
            replacedGitHubAppSecrets: ({ name }: { name: string }) => `GitHub App ${name} のシークレットを置き換えました`,
            verifiedGitHubApp: ({ organization, name }: { organization: string; name: string }) => `${organization} で ${name} を確認しました`,
            removedGitHubAppInstallation: ({ organization, name }: { organization: string; name: string }) => `${organization} から ${name} を削除しました`,
        },
    },
    reach: {
        publicLinks: "公開リンク",
        allowPublicSubpath: "このホスト名で公開リンクを許可",
        allowPublicSubpathDescription: "別の共有ドメインがない場合、このHomeのHTTPSアドレスをセッションやArtifactの公開リンクに使います。HTMLは制限されたサンドボックス内に保たれます。ローカルサービスには別のドメインが必要です。",
        publicLinksHelp: "初期設定はオフです。独立した共有ドメインではPDFをプレビューでき、このホスト名のリンクではPDFをダウンロードできます。",
        title: '到達経路',
        diagramTitle: ({ home }: { home: string }) => `新しいデバイスが ${home} に届く経路`,
        yourDevices: 'あなたのデバイス',
        noAddress: '公開アドレスなし',
        plusDirect: '+ 可能なときは直接 (Iroh)',
        noDirect: '直接接続なし',
        thisComputer: 'このコンピューター',
        homeServer: 'この Home のサーバー',
        diagramDeployment: 'デプロイで設定',
        diagramHere: 'ここで設定',
        diagramInferred: ({ method }: { method: string }) => `${method} · 推定`,
        addresses: 'アドレス',
        addressesDescription: 'アドレスを変えても誰もサインアウトされません。',
        publicAddress: '公開アドレス',
        webAppAddress: 'Web アプリのアドレス',
        accessMethod: 'アクセス方法',
        publicAddressHome: 'ここで設定',
        publicAddressNone: '未設定です。ほかのネットワークのデバイスはこの Home に届きません。',
        inferredFrom: ({ method }: { method: string }) => `この Home をホストしているコンピューターの ${method} から推定`,
        inferredFromHost: 'この Home をホストしているコンピューターで推定',
        webAppDescription: 'メールと招待のリンクはここで開きます。',
        webAppServed: 'リンクはこの Home が配信する Web アプリで開きます。',
        webAppDefault: 'リンクは Happier の Web アプリで開きます。既定',
        change: '変更',
        setAddress: 'アドレスを設定',
        httpsRequired: 'https:// のアドレスを使ってください。',
        invalidAddress: 'https://home.example.com のような完全なアドレスを入力してください。',
        conflict: 'この Home の設定が変わりました。もう一度お試しください。',
        methodLocalOnly: 'このコンピューターのみ',
        methodLan: 'ローカルネットワーク',
        methodTailscaleServe: 'Tailscale Serve',
        methodTailscaleFunnel: 'Tailscale Funnel',
        methodCloudflare: 'Cloudflare Tunnel',
        accessMethodHere: 'このコンピューターが Home を公開する方法。',
        accessMethodRemoteHost: ({ host }: { host: string }) => `${host} で設定します。リモートホストで開いてください。`,
        accessMethodElsewhereNamed: ({ host }: { host: string }) => `この Home をホストしているコンピューター（${host}）で設定します。そこで Happier を開くか、リモートホストとして追加してください。`,
        accessMethodElsewhere: 'この Home をホストしているコンピューターで設定します。そこで Happier を開くか、リモートホストとして追加してください。',
        accessMethodDeployment: 'デプロイで管理されています。',
        directConnections: '直接接続',
        directConnectionsDescription: 'デバイスは可能なときはこの Home に直接つながり、そうでなければ公開アドレスを使います。',
        directConnectionsRow: '直接接続（Iroh）',
        irohActive: '有効 · デバイスは可能なときピアツーピアで接続',
        irohStarting: '起動中…',
        irohOff: 'オフ · デバイスは公開アドレス経由で接続',
        irohFailed: 'このコンピューターでは動作していません。デバイスは公開アドレス経由で接続します。',
        irohNotAvailable: 'このデプロイでは利用できません。デバイスは公開アドレス経由で接続します。',
        irohNeedsAddressHint: 'オフにする前に公開アドレスを設定してください',
        irohOffTitle: '直接接続をオフにしますか？',
        irohOffBody: 'デバイスは公開アドレス経由でのみ接続します。この Home の現在の直接接続 ID は完全に廃止され、再度オンにすると新しい ID が作られ、デバイスは次の接続時にそれを使います。公開アドレスと全員のサインインは変わりません。',
        irohOffConfirm: 'オフにする',
        irohNeedsAddressTitle: '先に公開アドレスを設定してください',
        irohNeedsAddressBody: '公開アドレスがないと、直接接続をオフにした後、デバイスはこの Home に届かなくなります。',
        relay: '直接接続のリレー',
        relayAutomatic: '自動',
        relayOff: 'オフ',
        relayCustom: ({ count }: { count: number }) => `独自のリレー（${count}）· 再起動後に適用`,
        relayServers: 'リレーサーバー',
        relayServersDescription: '組み込みのリレーの代わりに使う独自のリレー。空のままにすると組み込みのリレーを使います。',
        appliesAfterRestart: '再起動後に適用',
        appliesAfterRestartPending: '再起動後に適用 · 保留中',
        exposureInternetTitle: ({ method }: { method: string }) => `${method} 経由でインターネットから到達可能`,
        exposureAddressTitle: '公開アドレスは新規登録を受け付けています',
        exposureOpenSignup: 'この Home に届く人は誰でもアカウントを作成できます。ポリシーで登録できる人を確認してください。',
        exposureInvitationOnly: '新しいアカウントには招待が必要なので、知らない人は登録できません。',
        loadFailed: 'この Home への到達方法を読み込めませんでした。',
    },
    runtime: {
        title: 'ランタイム',
        version: 'バージョン',
        versionValue: ({ version }: { version: string }) => `Happier ${version}`,
        versionUnknown: 'この Home はバージョンを報告していません',
        flavorLight: 'ライトサーバー',
        flavorFull: 'フルサーバー',
        server: 'サーバー',
        restart: '再起動',
        restartNow: '今すぐ再起動',
        restartFailed: 'サーバーを再起動できませんでした',
        waitingForHome: '再起動中です。Home が再び接続可能になるのを待っています。',
        restartToApply: '適用するにはサーバーを再起動してください。',
        restartFromDeployment: '適用するにはデプロイから再起動してください。',
        restartFromHost: ({ host }: { host: string }) => `この Home をホストしている ${host} から再起動してください。`,
        restartFromHostingComputer: 'この Home をホストしているコンピューターから再起動してください。',
        managedFrom: ({ host }: { host: string }) => `${host} から管理`,
        managedFromBody: '更新・再起動・停止するには、この Home をホストしているコンピューターで Happier を開いてください。',
        managedElsewhere: 'この Home をホストしているコンピューターから管理',
        deploymentTitle: 'デプロイで管理',
        deploymentBody: 'このサーバーの更新、再起動、バックアップはデプロイした人が行います。',
        backups: 'バックアップ',
        backupsHere: 'この Home のバックアップ、復元、移動はランタイムページから行えます。',
        backupsFromHost: ({ host }: { host: string }) => `この Home をホストしている ${host} からバックアップしてください。`,
        backupsFromHostingComputer: 'この Home をホストしているコンピューターからバックアップしてください。',
        backupsDeployment: 'バックアップはデプロイで管理されています。',
        hostedHere: ({ home }: { home: string }) => `このコンピューターは ${home} をホストしています`,
        hostedHereSubtitle: 'Home コンソールから更新、再起動、バックアップ、移動ができます。',
        pendingRestart: ({ count }: { count: number }) => (count === 1 ? '1 件の変更は再起動後に適用されます' : `${count} 件の変更は再起動後に適用されます`),
    },
    activity: {
        title: 'アクティビティ',
        emptyTitle: 'まだアクティビティはありません',
        emptyBody: 'サインイン、メール、メンバー、ポリシー、所有権の変更は、発生するとここに表示されます。',
        showOlder: '以前の項目を表示',
        footnote: 'ホストのコンピューター上で Happier から直接行った操作（バックアップや再起動など）は表示されません。',
        loadFailed: 'この Home からアクティビティが返されませんでした。',
        deploymentCommand: 'デプロイコマンド',
        personalHomeSetup: 'Personal Home のセットアップ',
        someone: '誰か',
        removedAccount: '削除されたアカウント',
        claimed: 'がこの Home の所有権を取得しました',
        madeOwner: ({ target }: { target: string }) => `が ${target} をオーナーにしました`,
        assignedOwner: 'が最初のオーナーを割り当てました',
        changedPolicies: 'がポリシーを変更しました',
        changedSetting: ({ setting }: { setting: string }) => `が${setting}を変更しました`,
        discardedSetting: ({ setting }: { setting: string }) => `が${setting}の保留中の変更を破棄しました`,
        changedRole: ({ target }: { target: string }) => `が ${target} のロールを変更しました`,
        disabled: ({ target }: { target: string }) => `が ${target} を無効にしました`,
        reenabled: ({ target }: { target: string }) => `が ${target} を再び有効にしました`,
        changedStatus: ({ target }: { target: string }) => `が ${target} の状態を変更しました`,
        deleted: ({ target }: { target: string }) => `が ${target} を削除しました`,
        deletionStarted: ({ target }: { target: string }) => `が ${target} の削除を開始しました`,
        signedOutEverywhere: ({ target }: { target: string }) => `が ${target} をすべてのデバイスからサインアウトしました`,
        profileRestricted: ({ target }: { target: string }) => `が ${target} の公開プロフィールを制限しました`,
        profileRestored: ({ target }: { target: string }) => `が ${target} の公開プロフィールを復元しました`,
        handleReclaimed: ({ target }: { target: string }) => `が ${target} のユーザー名を回収しました`,
        areaPublicProfiles: '公開プロフィール',
        fieldReason: '理由',
        fieldNotice: 'アカウント所有者への通知',
        fieldUsername: 'ユーザー名',
        areaOwnership: '所有権',
        areaPolicies: 'ポリシー',
        areaEmail: 'メール',
        areaServerSettings: 'サーバー設定',
        areaPeople: 'メンバー',
        fieldRole: 'ロール',
        fieldStatus: '状態',
        fieldTeamProviders: 'チームのサインインプロバイダー',
        valueEmpty: '—',
        valueChanged: '変更済み',
        valueOn: 'オン',
        valueOff: 'オフ',
        secretSet: '設定済み',
        secretUnset: '未設定',
    },
    signInPolicy: {
        methodsDescription: ({ home }: { home: string }) => `${home} へのサインイン方法です。少なくとも 1 つの方法は常にオンのままで、誰も最後の手段を失いません。`,
        methodUnavailable: '利用不可 — このデプロイでは提供できません',
        needsGithubApp: '先に GitHub サインイン用アプリが必要です。',
        needsWorkos: '先に WorkOS の設定が必要です。',
        setUp: '設定する',
        signInService: 'Home のサインインサービス',
        signInServiceDescription: 'この Home 独自のサインインサービスでサインインします。',
        admissionTitle: 'アカウントを作成できる人',
        newAccounts: '新規アカウント',
        admissionAnyoneDescription: 'この Home に到達できる人なら誰でも',
        admissionInvitationDescription: 'チームの招待を受けた人のみ',
        admissionNobodyDescription: '誰もアカウントを作成できません',
        anonymousSignup: '匿名サインアップ',
        anonymousSignupDescription: 'メールなしで、復旧キーだけでアカウントを作成します。',
        encryptionTitle: '暗号化',
        encryptionDescription: '今後作成されるアカウントとセッションに適用されます。既存のものは変わりません。',
        storagePolicy: '保存ポリシー',
        storageRequired: 'E2EE 必須',
        storageOptional: '任意',
        storagePlaintext: '平文のみ',
        storageRequiredDescription: 'サーバーにはエンドツーエンド暗号化されたデータだけが保存されます',
        storageOptionalDescription: 'サーバーには暗号化または読み取り可能なデータが、アカウントごとに保存されます',
        storagePlaintextDescription: 'サーバーにはすべてのアカウントのデータが読み取り可能な形で保存されます',
        storageAppliesAfterRestart: ({ running }: { running: string }) => `再起動後に適用 · それまでは ${running}`,
        accountTypes: 'アカウントの種類',
        accountTypesE2ee: 'E2EE のみ',
        accountTypesBoth: '両方',
        accountTypesPlain: '平文のみ',
        accountTypesE2eeDescription: 'エンドツーエンド暗号化されたアカウントのみ作成できます',
        accountTypesBothDescription: 'アカウント作成時に各自が選びます',
        accountTypesPlainDescription: '暗号化されていないアカウントのみ作成できます',
        recommendedInherited: 'サーバーの既定',
        recommendedE2ee: 'E2EE',
        errorWideningUnconfirmed: 'この変更は利用できる人を広げるため、確認が必要です。何も変更されていません。',
        widening: {
            titleAnyone: '誰でもアカウントを作成できるようにしますか？',
            titleInvited: '招待された人がアカウントを作成できるようにしますか？',
            titleMethod: ({ method }: { method: string }) => `${method} をオンにしますか？`,
            titleAnonymous: '匿名サインアップを許可しますか？',
            titleUnencrypted: '暗号化なしの保存を許可しますか？',
            titleOther: '利用できる人を広げますか？',
            exposureAnyone: ({ host }: { host: string }) => `${host} でこの Home に到達できる人は誰でも、招待なしでサインアップできるようになります。`,
            exposureInvited: ({ host }: { host: string }) => `${host} でこの Home に到達でき、招待を持つ人はアカウントを作成できるようになります。`,
            exposureMethod: ({ host, method }: { host: string; method: string }) => `${host} でこの Home に到達できる人は誰でも、${method} でサインインできるようになります。`,
            exposureAnonymous: ({ host }: { host: string }) => `${host} でこの Home に到達できる人は誰でも、復旧キーだけでアカウントを作成できるようになります。`,
            exposureUnencrypted: ({ host }: { host: string }) => `${host} でこの Home に到達できる人は誰でも、エンドツーエンド暗号化なしでデータを保存できるようになります。`,
            exposureOther: ({ host }: { host: string }) => `${host} でこの Home に到達できる人は誰でも、広げたルールでサインインまたは参加できるようになります。`,
            unchanged: '既存のアカウントと招待は変わりません。',
            recorded: 'この変更はあなたの名前でアクティビティに記録されます。',
            confirmAnyone: '誰でもサインアップ可能にする',
            confirmInvited: '招待を許可',
            confirmMethod: ({ method }: { method: string }) => `${method} をオンにする`,
            confirmAnonymous: '匿名サインアップを許可',
            confirmUnencrypted: '暗号化なしの保存を許可',
            confirmOther: '変更を適用',
        },
    },
    claim: {
        pageDescription: 'この Home の所有者になります。',
        emptyTitle: 'この Home にはまだオーナーがいません',
        emptyBody: 'オーナーはサインイン、メール、到達性、メンバーを管理します。誰かが引き受けるまで、この Home は誰も管理できません。',
        codeTitle: 'ワンタイムコードで引き受ける',
        codeDescription: 'サーバーにアクセスできる人がコードを表示します。1 回だけ使え、15 分で期限切れになります。',
        printStep: '1 · サーバーでコードを表示',
        pasteStep: '2 · ここに貼り付け',
        codeLabel: '引き受けコード',
        codePlaceholder: 'XXXX-XXXX-XXXX-XXXX-…',
        claim: '引き受ける',
        refused: 'このコードは使えませんでした。入力ミス、使用済み、または期限切れの可能性があります — 新しいコードを表示してください。',
        hostTitle: ({ home }: { home: string }) => `このコンピューターが ${home} をホストしています`,
        hostBody: 'ここからあなたのアカウントをオーナーにできます。この方法はこのコンピューターでしか使えません。',
        makeOwner: '自分をオーナーにする',
        hostFailed: 'このコンピューターからオーナーにできませんでした。もう一度お試しください。',
    },
    fixedByDeployment: ({ key }: { key: string }) => `デプロイで固定 · ${key}`,
    fixedByDeploymentLead: 'デプロイで固定',
    deploymentNotSetLead: '利用不可 — デプロイで次の設定が必要',
    features: {
        title: '機能',
        common: 'よく使う機能',
        advanced: '詳細',
        advancedDescription: ({ count }: { count: number }) => `ほかに ${count} 件、分野別。`,
        other: 'その他',
        familyCount_one: '1 件の機能',
        familyCount_other: ({ count }: { count: number }) => `${count} 件の機能`,
        offHome: 'この Home ではオフです。',
        notInBuild: 'このビルドには含まれていません。',
        needs: ({ feature }: { feature: string }) => `${feature} が必要です。`,
        unavailable: 'この Home では利用できません。',
        noHomeSwitchOn: 'この Home では常にオン · オフにできるのは Happier のビルドだけです',
        noHomeSwitchOff: 'この Home ではオフ · オンにできるのは Happier のビルドだけです',
        unavailableByDeployment: 'この Home では利用できません · デプロイの設定で決まります',
        dependentsTitle_one: ({ feature }: { feature: string }) => `${feature} をオフにすると、1 件の機能もオフになります`,
        dependentsTitle_other: ({ feature, count }: { feature: string; count: number }) => `${feature} をオフにすると、${count} 件の機能もオフになります`,
        dependentNeeds: ({ feature, parent }: { feature: string; parent: string }) => `${feature} には ${parent} が必要です。`,
        turnOff: 'オフにする',
        deviceTitle: 'このデバイスの機能',
        deviceBody: 'このデバイスだけに関わる機能は設定にあります。',
        adminTitle: '機能を変更できるのはオーナーだけです',
        adminBody: '管理者なので、この Home が提供するものを確認できます。',
        loadFailed: 'この Home から機能が返されませんでした。',
        conflictTitle: '機能がほかの場所で変更されました',
        conflictBody: '表示中に誰かがこの Home の設定を変更しました。ページには Home に保存されている内容が表示されています。',
        rangeBetween: ({ min, max }: { min: number; max: number }) => `${min}–${max}`,
        rangeAtLeast: ({ min }: { min: number }) => `${min} 以上`,
        rangeAtMost: ({ max }: { max: number }) => `最大 ${max}`,
        limitInvalid: '範囲内の数値を入力してください。',
        appliesAfterRestart: '再起動後に適用',
        onAfterRestart: '再起動後にオン',
        offAfterRestart: '再起動後にオフ',
        ignoredAtLastStart: ({ reason }: { reason: string }) => `前回の起動時に無視: ${reason}`,
        ignoredInvalidType: '保存された値の型が正しくありません',
        ignoredOutOfBounds: '保存された値が範囲外です',
        ignoredSecretUnreadable: '保存されたシークレットを読み取れません',
        dependentsAfterRestartTitle_one: ({ feature }: { feature: string }) => `次回の再起動後、${feature} をオフにすると 1 件の機能もオフになります`,
        dependentsAfterRestartTitle_other: ({ feature, count }: { feature: string; count: number }) => `次回の再起動後、${feature} をオフにすると ${count} 件の機能もオフになります`,
    },
    data: {
        title: 'データ',
        deletion: '自動削除',
        deletionDescription: '変更は次回のクリーンアップから適用されます。',
        dryRunMode: 'ドライランモード',
        dryRunModeDescription: 'オフにするまで、クリーンアップは削除せずに件数だけを数えます。',
        tryRules: '現在のルールを試す',
        tryRulesDescription: '何も削除せずに、今すぐクリーンアップを 1 回実行します。',
        runDryRun: 'ドライランを実行',
        runAgain: 'もう一度実行',
        ranAt: ({ time }: { time: string }) => `${time} に実行 · 何も削除されていません`,
        sweepInProgress: 'クリーンアップの実行中です。終わってからもう一度お試しください。',
        wouldDelete: ({ count, examined }: { count: string; examined: string }) => `${count} 件を削除予定 · ${examined} 件を確認`,
        nothingToDelete: '削除するものはありません',
        stopTimeBudget: '停止: 時間の上限',
        stopRowBudget: '停止: 削除の上限',
        stopCandidateBudget: '停止: 確認の上限',
        stopStalled: '停止: 進行なし',
        keep: '保持',
        deleteAfter: '経過後に削除',
        days: '日',
        daysFor: ({ domain }: { domain: string }) => `${domain} を保持する日数`,
        daysRequired: '日数を入力してください。',
        daysInvalid: '1 以上の整数で日数を入力してください。',
        defaultEffect: ({ effect }: { effect: string }) => `デフォルト · ${effect}`,
        alwaysRuns: '自動削除がオフでも実行されます。',
        expiresAutomatically: '自動的に期限切れになります',
        systemRecords: 'システムレコード',
        systemRecordsSummary_one: 'この Home が自身のために保持する 1 種類のレコード',
        systemRecordsSummary_other: ({ count }: { count: number }) => `この Home が自身のために保持する ${count} 種類のレコード`,
        adminTitle: 'この Home が保持するものを変更できるのはオーナーだけです',
        adminBody: '管理者なので、ルールを確認できます。',
        loadFailed: 'この Home からデータ設定が返されませんでした。',
        conflictTitle: 'データ設定がほかの場所で変更されました',
        conflictBody: '表示中に誰かがこの Home の設定を変更しました。ページには Home に保存されている内容が表示されています。',
    },
};

const homeGovernanceTranslations = { ja } as const;

return { homeGovernanceTranslations };
})();

const Domain_homeIndexTranslations = (() => {
type HomeIndexTranslation = Shared_homeIndexTranslations.HomeIndexTranslation;

const homeIndexTranslations = { ja: {
        greetingMorning: ({ name }) => `おはようございます、${name}さん`,
        greetingAfternoon: ({ name }) => `こんにちは、${name}さん`,
        greetingEvening: ({ name }) => `こんばんは、${name}さん`,
        greetingMorningAnonymous: 'おはようございます',
        greetingAfternoonAnonymous: 'こんにちは',
        greetingEveningAnonymous: 'こんばんは',
        sessionsWorking: ({ count }) => `${count} 件のセッションが作業中`,
        sessionsNeedYou: ({ count }) => `${count} 件があなたを待っています`,
        sessionsAwaitingResponse: ({ count }) => `${count} 件のセッションがあなたの回答を待っています`,
        nothingRunning: 'まだ実行中のものはありません',
        customize: 'カスタマイズ',
        customizeTitle: 'ホームをカスタマイズ',
        customizeDescription: 'ドラッグで並べ替えます。アカウントに保存されるため、どのデバイスでも同じホームが表示されます。',
        customizing: "ホームをカスタマイズ中",
        customizingHint: "ウィジェットはグループ間でドラッグ、組み込みセクションは「セクション」から移動できます",
        sections: "セクション",
        newRow: "ここにドロップして新しい行を始める",
        newRowVerb: "新しい行に移動",
        addWidget: "ウィジェットを追加",
        reset: 'リセット',
        alwaysShown: '常に表示',
        builtIn: '組み込み',
        startDescription: '入力欄と提案',
        attentionDescription: 'あなたの対応が必要なときに表示',
        hiddenSetupSteps: '非表示のセットアップ手順',
        showAgain: ({ count }) => `${count} · 再表示`,
        reorderHandle: ({ section }) => `${section} を並べ替え`,
    } } satisfies Pick<Readonly<Record<string, HomeIndexTranslation>>, "ja">;

return { homeIndexTranslations };
})();

const Domain_homeSettingsTranslations = (() => {
const en = Shared_homeSettingsTranslations.en;

const ja: typeof en = {
    page: {
        title: 'サーバー設定',
        description: '専用ページを持たない、サーバーが読み取るすべての設定。',
        searchPlaceholder: '設定を検索',
        changed: '変更済み',
        changedA11y: ({ count }: { count: number }) => (count === 1 ? '変更された 1 件の設定のみ表示' : `変更された ${count} 件の設定のみ表示`),
        noMatches: 'この検索に一致する設定はありません。',
        noChanges: 'この Home ではデフォルトから変更された設定はありません。',
        filterLabel: '表示',
        filterAll: 'すべての設定',
        filterChanged: ({ count }: { count: number }) => `変更済み · ${count}`,
        more: 'その他',
        readOnlyTitle: '起動時に固定',
        readOnlyDescription: 'サーバーは保存済みの設定を読み取る前にこれらを必要とするため、実行環境で設定します。',
        readOnlyUnsetTitle: 'その他の起動時の設定',
        adminTitle: 'サーバー設定を変更できるのはオーナーのみです',
        adminBody: 'すべての設定と、その値の出どころを確認できます。',
        loadFailed: 'サーバー設定を読み込めませんでした。',
        saveFailed: '設定は保存されませんでした。',
        conflictTitle: '設定が別の場所で変更されました',
        conflictBody: '編集中に誰かがこの Home の設定を変更しました。ページには相手の値が表示されています。あなたの編集内容は入力欄に残っています。',
    },
    row: {
        appliesAfterRestart: '再起動後に適用',
        pending: '保留中',
        defaultValue: ({ value }: { value: string }) => `既定: ${value}`,
        runningWith: ({ value }: { value: string }) => `前回の起動以降 ${value} で実行中`,
        runningWithout: '前回の起動以降、未設定で実行中',
        ignored: ({ reason }: { reason: string }) => `前回の起動時に無視されました: ${reason}`,
        runningOn: ({ value }: { value: string }) => `${value} で実行中`,
        notSet: '未設定',
        outOfBounds: ({ bounds }: { bounds: string }) => `${bounds} で指定してください`,
        invalid: 'この値はここでは無効です',
        storedEncrypted: '暗号化して保存、表示されません',
        listItem: ({ title, position }: { title: string; position: number }) => `${title} ${position}`,
        listRemove: ({ position }: { position: number }) => `項目を削除 ${position}`,
        listAdd: '追加',
        listDuplicate: 'すでにリストにあります',
        httpsOnly: 'https:// のアドレスにしてください',
    },
    banner: {
        pendingNames: ({ names }: { names: string }) => `${names}。`,
        andMore: ({ count }: { count: number }) => (count === 1 ? 'ほか 1 件' : `ほか ${count} 件`),
        discard: '破棄',
        discarded: '保留中の変更を破棄しました',
        ignoredTitle: '前回の起動時に無視された設定があります',
        ignoredTitleMany: ({ count }: { count: number }) => `前回の起動時に ${count} 件の設定が無視されました`,
        ignoredBody: ({ setting, reason }: { setting: string; reason: string }) => `${setting}: ${reason}。サーバーはこの設定なしで起動しました。`,
        fix: '修正',
    },
    readOnly: {
        before_database: 'データベースを開く前に読み取られます',
        per_process_identity: 'サーバープロセスごとに異なります',
        invariant: 'サインインとビルドの制限を保護するため、ここでは変更できません',
        other: 'サーバーの実行環境で設定します',
        set: '設定済み',
    },
    secret: {
        saved: '保存済み',
        replace: '置き換え',
        clear: '削除',
        keep: '保持',
        clearPending: '保存すると、保存済みの値は削除されます。',
        valueSet: '設定済み',
        valueNotSet: '未設定',
        setAction: '設定',
    },
    groupSummary: ({ count }: { count: number }) => (count === 1 ? '1 件の設定 · デフォルト' : `${count} 件の設定 · デフォルト`),
    groupSummaryChanged: ({ count, changed }: { count: number; changed: number }) => `${count} 件の設定 · ${changed} 件変更`,
    units: {
        ms: 'ミリ秒',
        seconds: '秒',
        minutes: '分',
        bytes: 'バイト',
        megabytes: 'MB',
    },
    choices: {
        hosted_happier_relay: 'Happier リレー',
        direct_apns: 'Apple プッシュ',
        background_wake_best_effort: 'バックグラウンド起動',
        local_only: 'このデバイスのみ',
        disabled: 'オフ',
        enabled: 'オン',
        automatic: '自動',
        sandbox: 'サンドボックス',
        production: '本番',
        owner: 'サーバーのオーナー',
        authenticated: 'サインイン済みの全員',
        self: 'このサーバー',
        external: '外部サービス',
        '0': 'オフ',
        '1': 'オン',
        any: 'いずれか',
        all: 'すべて',
        github_app: 'GitHub App',
        oauth_user_token: 'ユーザーのトークン',
        light: 'ライト',
        full: 'フル',
        api: 'API のみ',
        worker: 'ワーカーのみ',
        fatal: '致命的',
        error: 'エラー',
        warn: '警告',
        info: '情報',
        debug: 'デバッグ',
        trace: 'トレース',
        silent: 'なし',
        'ip-only': 'IPのみ',
        'user-or-ip': 'ユーザーまたはIP',
        publicdev: 'Public dev',
        local: 'ローカルディスク',
        manual: '手動',
        default: 'サーバーの既定',
        "memory": "メモリ内",
        "redis-streams": "Redis Streams",
        stable: "安定版",
        preview: "プレビュー",
        "postgres": "PostgreSQL",
        "postgresql": "PostgreSQL",
        "pglite": "PGlite",
        "sqlite": "SQLite",
        "mysql": "MySQL",
        "s3": "S3 オブジェクトストレージ",
        "WAL": "先行書き込みログ (WAL)",
        "DELETE": "ジャーナルを削除",
        "OFF": "オフ",
        "NORMAL": "通常",
        "FULL": "完全",
        "EXTRA": "追加",
    },
    rateLimit: {
        max: ({ route }: { route: string }) => `${route}: ウィンドウあたりのリクエスト数`,
        window: ({ route }: { route: string }) => `${route}: ウィンドウ`,
    },
    groups: {
        api: 'API とネットワーク',
        storage: 'ストレージとファイル',
        monitoring: 'モニタリング',
        errorReporting: 'エラー報告',
        process: 'プロセス',
        ui: 'Web アプリの配信',
        realtime: 'プレゼンスとソケット',
        retentionCaps: '保持処理のリソース上限',
        rpc: 'マシン呼び出し',
        liveActivity: 'Live Activities',
        voice: '音声',
        connectedServices: '接続済みサービス',
        localServices: 'ローカルサービス',
        plugins: 'プラグイン',
        reviews: 'レビュー',
        bugReports: 'バグレポート',
        releases: 'リリース',
        authCaches: 'サインインのキャッシュ',
        limits: '制限',
        rateLimits: 'ルート別のレート制限',
        github: 'GitHub サインイン',
        oauth: 'OAuth サインイン',
        oidc: '構成ファイルの OIDC プロバイダー',
        workos: 'WorkOS',
        signInRequests: 'サインインリクエスト',
        offboarding: 'オフボーディング',
        friends: 'フレンド',
        accountService: 'アカウントサービス',
        devices: 'デバイス',
        diagnostics: '診断',
        reachInference: 'アドレスの検出',
        addresses: 'アドレス',
        other: 'その他',
        signup: "アカウント作成",
    },
    keys: {
        HAPPIER_AUTH_EMAIL_SMTP_HOST: "SMTP ホスト",
        HAPPIER_ARTIFACT_REVISION_RETENTION_COUNT: "保持する Artifact の改訂数",
        HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES: "改訂を含む Artifact の最大サイズ",
        HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES: "アカウントごとの Artifact ストレージ",
        HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_ENABLED: "サインインを自動リダイレクト",
        HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_PROVIDER_ID: "自動サインインのプロバイダー",
        HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "メールとパスワードでサインイン",
        HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__PROVISION_ENABLED: "メールとパスワードによるアカウント作成を許可",
        HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: "暗号化キーなしの OAuth サインインを許可",
        HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: "暗号化キーなしのアカウント用 OAuth プロバイダー",
        HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_AUTO_PROVISION: "初回 OAuth サインイン時に暗号化キーなしのアカウントを作成",
        HAPPIER_FEATURE_AUTH_MANAGED_IDENTITY__PRIVATE_NETWORK_ENABLED: "プライベートネットワークで管理対象のサインインを許可",
        HAPPIER_USAGE_MODEL_PRICE_FETCH_ENABLED: "公開カタログからモデル料金を更新",
        HAPPIER_AUTH_EMAIL_SMTP_PORT: "SMTP ポート",
        HAPPIER_AUTH_EMAIL_SMTP_SECURE: "SMTP に暗黙的 TLS を使用",
        HAPPIER_AUTH_EMAIL_SMTP_USERNAME: "SMTP ユーザー名",
        HAPPIER_AUTH_EMAIL_SMTP_PASSWORD: "SMTP パスワード",
        HAPPIER_AUTH_EMAIL_FROM_ADDRESS: "送信元メールアドレス",
        HAPPIER_AUTH_EMAIL_FROM_NAME: "送信者名",
        AUTH_ANONYMOUS_SIGNUP_ENABLED: "サインインプロバイダーなしのアカウントを許可",
        AUTH_SIGNUP_PROVIDERS: "アカウントを作成できるプロバイダー",
        AUTH_REQUIRED_LOGIN_PROVIDERS: "連携が必須のサインインプロバイダー",
        HAPPIER_AUTH_REQUIRE_KEY_CHALLENGE_V2: "鍵によるサインインでサーバー発行のチャレンジを必須にする",
        HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS: "インターネットからのアカウント作成を禁止するサインイン方法",
        HAPPIER_AUTH_PUBLIC_PROVISION_DENY_MODES: "インターネットからの作成を禁止するアカウントの種類",
        HAPPIER_AUTH_PUBLIC_PROVISION_DENY_IP_CLASSES: "インターネットからのアカウント作成を禁止するクライアントネットワーク",
        HAPPIER_PUBLIC_SERVER_URL: "Home の公開アドレス",
        HAPPIER_WEBAPP_URL: "Web アプリのアドレス",
        HAPPIER_PUBLIC_SHARES_ALLOW_SUBPATH: "Home のアドレスで公開リンクを許可",
        HAPPIER_HOME_IROH_MODE: "デバイスの直接接続",
        HAPPIER_IROH_RELAY_POLICY: "直接接続でリレーを許可",
        HAPPIER_IROH_RELAY_URLS: "直接接続のリレーアドレス",
        S3_PRIVATE_BUCKET: "非公開 S3 バケット",
        HAPPIER_HOME_DISPLAY_NAME: 'Home 名',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: 'バックグラウンド更新',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: '配信モード',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_ALLOW_FALLBACK: '別のモードにフォールバック',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_DEDUPE_WINDOW_MS: '重複更新の判定期間',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_ENABLED: 'バックグラウンド起動プッシュ',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_MIN_INTERVAL_MS: '起動プッシュの最短間隔',
        HAPPIER_LIVE_ACTIVITY_EXPO_WIDGETS_PUSH_NOTIFICATIONS_ENABLED: 'ウィジェットビルドでプッシュを受信',
        HAPPIER_LIVE_ACTIVITY_TARGET_TRANSIENT_FAILURE_BUDGET: 'デバイスを外すまでの失敗回数',
        HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT: 'Apple プッシュ環境',
        HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID: 'Apple チーム ID',
        HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID: 'Apple プッシュキー ID',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY: 'Apple プッシュ署名キー',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY_FILE: 'Apple プッシュ署名キーファイル',
        HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS: '許可するアプリのバンドル ID',
        HAPPIER_LIVE_ACTIVITY_APNS_ACTIVITY_NAMES: '許可する Live Activities 名',
        HAPPIER_LIVE_ACTIVITY_APNS_REQUEST_TIMEOUT_MS: 'Apple プッシュのリクエストタイムアウト',
        HAPPIER_LIVE_ACTIVITY_APNS_RECONNECT_BACKOFF_MS: 'Apple プッシュの再接続待機',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED: 'ホスト型リレーを使用',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL: 'ホスト型リレーのアドレス',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEY: 'ホスト型リレーのアクセスキー',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_SERVICE_ENABLED: 'ホスト型リレーとして動作',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEYS: '他のサーバー用のリレーアクセスキー',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_MAX_SKEW_MS: 'リレーの時刻ずれ許容値',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_TTL_MS: 'リレーの重複記憶期間',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_CACHE_MAX_ENTRIES: 'リレーの重複キャッシュサイズ',
        ELEVENLABS_API_KEY: 'ElevenLabs API キー',
        ELEVENLABS_AGENT_ID: 'ElevenLabs エージェント',
        ELEVENLABS_AGENT_ID_PROD: 'ElevenLabs 本番エージェント',
        ELEVENLABS_API_BASE_URL: 'ElevenLabs API アドレス',
        REVENUECAT_SECRET_KEY: 'RevenueCat シークレットキー',
        VOICE_FREE_SESSIONS_PER_MONTH: '月あたりの無料音声セッション数',
        VOICE_FREE_MINUTES_PER_MONTH: '月あたりの無料音声時間 (分)',
        VOICE_MAX_CONCURRENT_SESSIONS: '同時音声セッション数',
        VOICE_MAX_SESSION_SECONDS: '音声セッションの最長時間',
        VOICE_MAX_MINUTES_PER_DAY: '1 日あたりの音声時間 (分)',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_ENABLED: '音声 ID のバックフィル',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE: 'バックフィルのバッチサイズ',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS: 'バックフィルの時間枠',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_DELAY_MS: 'バックフィルのバッチ間隔',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_INTERVAL_MS: 'バックフィルの実行間隔',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID: 'OpenAI Codex OAuth クライアント ID',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL: 'OpenAI Codex トークンエンドポイント',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID: 'Claude サブスクリプション OAuth クライアント ID',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL: 'Claude サブスクリプショントークンエンドポイント',
        HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS: 'トークン交換のタイムアウト',
        CONNECTED_SERVICE_CREDENTIAL_MAX_LEN: '保存できる認証情報の最大サイズ',
        CONNECTED_SERVICE_REFRESH_LEASE_MAX_MS: '更新リースの最長期間',
        VENDOR_TOKEN_MAX_LEN: 'ベンダートークンの最大サイズ',
        HAPPIER_LOCAL_SERVICES_TOKEN_SECRET: 'プレビュートークンのシークレット',
        HAPPIER_LOCAL_SERVICES_PREVIEW_TOKEN_SECRET: '非公開プレビュートークンのシークレット',
        HAPPIER_LOCAL_SERVICES_PUBLIC_PREVIEW_TOKEN_SECRET: '公開プレビュートークンのシークレット',
        HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN: 'プラグイン UI のオリジン',
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_MAX_AGE_MS: '発行元証明の有効期間',
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_CLOCK_SKEW_MS: '発行元証明の時刻ずれ許容値',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_MAX_AGE_MS: 'レビュー証明の有効期間',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_CLOCK_SKEW_MS: 'レビュー証明の時刻ずれ許容値',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: 'サーバーログを含める',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: 'サーバーログを閲覧できるユーザー',
        HAPPIER_BUG_REPORTS_SERVER_LOG_PATH: 'サーバーログファイル',
        HAPPIER_BUG_REPORTS_SERVER_LOG_MAX_BYTES: '含めるログのサイズ',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'リリースチャネル',
        HAPPIER_GITHUB_REPO: 'リリースリポジトリ',
        AUTH_OFFBOARDING_ENABLED: 'サインイン資格を再確認',
        AUTH_OFFBOARDING_STRICT: '再確認に失敗したら拒否',
        AUTH_OFFBOARDING_INTERVAL_SECONDS: '再確認の間隔',
        AUTH_PROVIDERS_CONFIG_PATH: 'プロバイダーファイル',
        AUTH_PROVIDERS_CONFIG_JSON: 'プロバイダー JSON',
        HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: 'サインインサービス',
        HAPPIER_AUTH_SIGN_IN_SERVICE_URL: 'アカウントサービスのアドレス',
        HAPPIER_AUTH_SIGN_IN_SERVICE_SERVER_IDENTITY_ID: 'アカウントサービスの ID',
        HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME: 'アカウントサービスの名前',
        HAPPIER_SERVER_OWNER_USER_IDS: 'サーバーオーナーのアカウント',
        HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED: '新しいデバイスには承認が必要',
        GITHUB_CLIENT_ID: 'GitHub OAuth クライアント ID',
        GITHUB_CLIENT_SECRET: 'GitHub OAuth クライアントシークレット',
        GITHUB_REDIRECT_URL: 'GitHub コールバックアドレス',
        GITHUB_HTTP_TIMEOUT_SECONDS: 'GitHub リクエストのタイムアウト',
        GITHUB_STORE_ACCESS_TOKEN: 'GitHub アクセストークンを保持',
        OAUTH_PENDING_TTL_SECONDS: '保留中サインインの有効期間',
        OAUTH_STATE_TTL_SECONDS: 'OAuth state の有効期間',
        HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES: '許可するアプリの戻り先スキーム',
        AUTH_GITHUB_ALLOWED_USERS: '許可する GitHub ユーザー',
        AUTH_GITHUB_ALLOWED_ORGS: '許可する GitHub 組織',
        AUTH_GITHUB_ORG_MATCH: '必要な組織',
        AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: 'メンバーシップの確認方法',
        AUTH_GITHUB_APP_ID: 'メンバーシップ用 GitHub App ID',
        AUTH_GITHUB_APP_PRIVATE_KEY: 'メンバーシップ用 GitHub App キー',
        AUTH_GITHUB_APP_INSTALLATION_ID_BY_ORG: '組織ごとのアプリのインストール',
        WORKOS_API_KEY: 'WorkOS API キー',
        WORKOS_CLIENT_ID: 'WorkOS クライアント ID',
        ACCOUNT_AUTH_REQUEST_TTL_SECONDS: 'アカウントサインインリクエストの有効期間',
        TERMINAL_AUTH_REQUEST_TTL_SECONDS: 'ターミナルサインインリクエストの有効期間',
        AUTH_PAIRING_TTL_SECONDS: 'ペアリングコードの有効期間',
        AUTH_TOKEN_CACHE_TTL_SECONDS: 'セッショントークンキャッシュの有効期間',
        AUTH_TOKEN_CACHE_MAX_ENTRIES: 'セッショントークンキャッシュのサイズ',
        AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '資格キャッシュの有効期間',
        AUTH_LOGIN_ELIGIBILITY_CACHE_MAX_ENTRIES: '資格キャッシュのサイズ',
        FRIENDS_USERNAME_MIN_LEN: 'ユーザー名の最短文字数',
        FRIENDS_USERNAME_MAX_LEN: 'ユーザー名の最長文字数',
        FRIENDS_USERNAME_REGEX: 'ユーザー名のパターン',
        HAPPIER_CANONICAL_SERVER_URL: 'サインイン ID のアドレス',
        HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE: 'Web アプリの OAuth 戻り先アドレス',
        PUBLIC_URL: "通知するアドレス",
        HAPPIER_PUBLIC_SERVER_URL_INFER_TTL_MS: '検出したアドレスの有効期間',
        HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL: 'アクセス方法から検出',
        HAPPIER_TAILSCALE_INFER_PUBLIC_URL: 'Tailscale から検出',
        HAPPIER_TAILSCALE_SERVE_STATUS_TIMEOUT_MS: 'Tailscale Serve 確認のタイムアウト',
        HAPPIER_TAILSCALE_FUNNEL_STATUS_TIMEOUT_MS: 'Tailscale Funnel 確認のタイムアウト',
        PORT: '待ち受けポート',
        HAPPIER_SERVER_HOST: '待ち受けアドレス',
        HAPPIER_SERVER_FLAVOR: 'サーバーの種類',
        NODE_ENV: "Node.js 環境",
        SERVER_ROLE: 'プロセスのロール',
        UV_THREADPOOL_SIZE: 'ワーカースレッド',
        HAPPIER_INSTANCE_ID: 'レプリカ ID',
        HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: 'シャットダウン期限',
        HAPPY_EXIT_ON_FATAL: '致命的エラー後に終了',
        HAPPIER_API_CORS_MAX_AGE_SECONDS: 'ブラウザーのプリフライトキャッシュ',
        HAPPIER_SERVER_IDENTITY_ID: 'サーバー ID',
        HAPPIER_MANAGED_RELAY_PURPOSE: 'マネージドリレーの用途',
        HAPPIER_PERSONAL_HOME_RELOCATION_OPERATION_ID: '移行処理',
        HAPPIER_SERVER_STARTUP_RECEIPT_PATH: '起動レシートファイル',
        HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: '起動レシートの nonce',
        HAPPIER_UPDATER_FORWARD_RECOVERY_CAPABILITY: 'アップデーターの前方リカバリー',
        HAPPIER_RELEASE_SOURCE_SHA: 'ビルドのコミット',
        HAPPIER_FEATURE_POLICY_ENV: 'リリースリングのポリシー',
        HAPPIER_BUILD_FEATURES_ALLOW: '許可する機能',
        HAPPIER_BUILD_FEATURES_DENY: '拒否する機能',
        HAPPIER_SERVER_LOG_LEVEL: 'ログレベル',
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: '統合デバッグログ',
        HAPPIER_SELF_HOST_LOG_DIR: 'ログディレクトリ',
        HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS: '認証の診断',
        HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS: 'ソケットメッセージの診断',
        METRICS_ENABLED: 'メトリクス',
        METRICS_PORT: 'メトリクスのポート',
        SENTRY_DSN: 'エラーレポートの DSN',
        HAPPIER_SENTRY_USE_CENTRAL_DSN: 'Happier に報告',
        HAPPIER_SENTRY_CENTRAL_DSN: '中央エラーレポートの DSN',
        SENTRY_ENVIRONMENT: 'エラーレポートの環境',
        SENTRY_RELEASE: 'エラーレポートのリリース',
        SENTRY_PROFILE_LIFECYCLE: 'プロファイリング',
        SENTRY_SEND_DEFAULT_PII: '個人データを送信',
        SENTRY_TRACES_SAMPLE_RATE: 'トレースするリクエスト',
        SENTRY_PROFILE_SESSION_SAMPLE_RATE: 'プロファイルするセッション',
        SENTRY_ENABLE_LOGS: 'ログを送信',
        SENTRY_LOG_LEVELS: '送信するログレベル',
        SENTRY_MONITORS_ENABLED: 'ジョブモニター',
        HAPPIER_SERVER_UI_DIR: 'Web アプリのフォルダー',
        HAPPIER_SERVER_UI_PREFIX: 'Web アプリのパス',
        HAPPIER_SERVER_UI_REQUIRED: 'Web アプリを必須にする',
        HAPPIER_SERVER_UI_DEPLOYMENT_ID: 'Web アプリのデプロイ ID',
        HAPPIER_SERVER_UI_DEBUG_PATH: 'Web アプリがない場合にパスを表示',
        HAPPIER_SOCKET_ADAPTER: 'ソケットアダプター',
        HAPPIER_SOCKET_REDIS_ADAPTER: 'Redis ソケットアダプター (レガシー)',
        HAPPIER_SOCKET_ADAPTER_MAXLEN: 'ソケットストリームの長さ',
        HAPPIER_SOCKET_ADAPTER_READ_COUNT: 'ソケットストリームの読み取りサイズ',
        HAPPIER_SOCKET_MAX_HTTP_BUFFER_SIZE: 'ソケットメッセージの最大サイズ',
        HAPPIER_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS: '即時切断のしきい値',
        HAPPIER_SOCKET_PLANNED_RESTART_RETRY_AFTER_MS: '再起動中の再接続待機',
        HAPPIER_SOCKET_RECONNECT_WINDOW_MS: '再接続の猶予期間',
        HAPPY_SOCKET_ROOMS_ONLY: "ソケットが利用できない場合は失敗にする",
        HAPPIER_MACHINE_SOCKET_OWNER_TTL_SECONDS: 'マシンソケットの所有期間',
        HAPPIER_PRESENCE_STREAM_MAXLEN: 'プレゼンスストリームの長さ',
        HAPPIER_PRESENCE_WORKER_DB_WRITE_CONCURRENCY: 'プレゼンス書き込みの同時実行数',
        HAPPIER_PRESENCE_WORKER_FLUSH_INTERVAL_MS: 'プレゼンスのフラッシュ間隔',
        HAPPIER_PRESENCE_WORKER_READ_BLOCK_MS: 'プレゼンス読み取りの待機',
        HAPPIER_PRESENCE_WORKER_READ_COUNT: 'プレゼンスの読み取りサイズ',
        HAPPIER_PRESENCE_WORKER_RECLAIM_IDLE_MS: 'プレゼンスを回収するまで',
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: 'セッションを非アクティブとするまで',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: 'マシンをオフラインとするまで',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: 'プレゼンスの確認間隔',
        HAPPIER_PRESENCE_SHUTDOWN_FLUSH_TIMEOUT_MS: 'シャットダウン時のプレゼンスフラッシュ',
        HAPPIER_RPC_FORWARD_TIMEOUT_MS: 'マシン呼び出しのタイムアウト',
        HAPPIER_RPC_FORWARD_CAPABILITIES_TIMEOUT_MS: '機能呼び出しのタイムアウト',
        HAPPIER_RPC_FORWARD_MAX_TIMEOUT_MS: '呼び出しタイムアウトの上限',
        HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS: 'メソッドの待機',
        HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS: 'メソッドの確認間隔',
        HAPPIER_RPC_CLUSTER_FETCH_TIMEOUT_MS: 'レプリカ間検索のタイムアウト',
        HAPPIER_STOP_SESSION_RPC_METHOD_AVAILABILITY_GRACE_MS: 'セッション停止の待機',
        HAPPIER_DIRECT_SESSIONS_RPC_METHOD_AVAILABILITY_GRACE_MS: 'ダイレクトセッションの待機',
        HAPPIER_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT: '初回読み込み時の要対応セッション',
        HAPPIER_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT: 'ロールバック対象として確認するターン',
        HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT: '保持する設定履歴',
        HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK: '署名済みマシンキーを必須にする',
        DATABASE_URL: 'データベース',
        HAPPIER_DB_PROVIDER: 'データベースエンジン',
        HAPPIER_DB_CONNECTION_LIMIT: '接続プールのサイズ',
        HAPPIER_DB_READINESS_TIMEOUT_MS: 'データベース準備のタイムアウト',
        HAPPIER_DB_TX_MAX_RETRIES: 'トランザクションの再試行回数',
        HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: '最初の再試行までの待機',
        HAPPIER_DB_TX_RETRY_MAX_DELAY_MS: '再試行待機の上限',
        HAPPIER_DB_TX_RETRY_JITTER_FACTOR: '再試行のジッター',
        HAPPIER_DB_TX_TIMEOUT_MS: 'トランザクションのタイムアウト',
        HAPPIER_DB_TX_MAX_WAIT_MS: '接続の待機',
        HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS: '再試行の合計時間',
        HAPPIER_SERVER_DB_SIZE_WARN_BYTES: 'データベースサイズの警告',
        HAPPIER_SQLITE_AUTO_MIGRATE: '起動時にマイグレーション',
        HAPPIER_SQLITE_MIGRATIONS_DIR: 'マイグレーションフォルダー',
        HAPPIER_SQLITE_JOURNAL_MODE: 'SQLite ジャーナルモード',
        HAPPIER_SQLITE_SYNCHRONOUS: 'SQLite 同期モード',
        HAPPIER_SQLITE_JOURNAL_SIZE_LIMIT_BYTES: 'SQLite ジャーナルサイズの上限',
        HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: 'SQLite チェックポイント間隔',
        HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: 'SQLite チェックポイントの待機',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_INTERVAL_MS: 'SQLite バキューム間隔',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES: 'SQLite バキュームのページ数',
        HAPPIER_FILES_BACKEND: "ファイルストレージ",
        S3_HOST: 'S3 ホスト',
        S3_PORT: 'S3 ポート',
        S3_USE_SSL: 'S3 で TLS を使用',
        S3_REGION: 'S3 リージョン',
        S3_BUCKET: 'S3 バケット',
        S3_PUBLIC_URL: 'S3 公開アドレス',
        S3_ACCESS_KEY: 'S3 アクセスキー',
        S3_SECRET_KEY: 'S3 シークレットキー',
        REDIS_URL: 'Redis 接続',
        HANDY_MASTER_SECRET: 'マスターシークレット',
        HAPPIER_SERVER_LIGHT_DATA_DIR: 'データディレクトリ',
        HAPPIER_SERVER_LIGHT_DB_DIR: 'データベースディレクトリ',
        HAPPIER_SERVER_LIGHT_FILES_DIR: 'ファイルディレクトリ',
        HAPPIER_API_RATE_LIMITS_ENABLED: 'レート制限',
        HAPPIER_API_RATE_LIMITS_GLOBAL_MAX: 'クライアントあたりのリクエスト数',
        HAPPIER_API_RATE_LIMITS_GLOBAL_WINDOW: 'レート制限のウィンドウ',
        HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY: 'リクエストの集計単位',
        HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: 'ルート別リクエストの集計単位',
        HAPPIER_SERVER_TRUST_PROXY: 'プロキシヘッダーを信頼',
        HAPPIER_SERVER_RETENTION__INTERVAL_MS: 'スイープの間隔',
        HAPPIER_SERVER_RETENTION__BATCH_SIZE: 'バッチあたりの行数',
        HAPPIER_SERVER_RETENTION__MAX_DELETES_PER_RULE_PER_RUN: 'ルールごとの最大削除数',
        HAPPIER_SERVER_RETENTION__SWEEP_TIME_BUDGET_MS: 'スイープの時間枠',
        HAPPIER_SERVER_RETENTION__MAX_CANDIDATES_PER_RULE_PER_RUN: 'ルールごとの最大確認行数',
    },
};

const homeSettingsTranslations = { ja } as const;

return { homeSettingsTranslations };
})();

const Domain_homeSetupTranslations = (() => {
type HomeSetupTranslation = Shared_homeSetupTranslations.HomeSetupTranslation;

const homeSetupTranslations = { ja: {
        dismiss: ({ title }) => `「${title}」を非表示`,
        dismissTooltip: '非表示 · 「カスタマイズ」から戻せます',
        close: '閉じる',
        addPhoneSubtitle: 'どこからでもセッションを確認し、承認に応答できます。',
        addPhoneAction: 'QR コードを表示',
        addMachineSubtitle: 'エージェントを実行するサーバーや開発マシン。SSH またはコマンド 1 つで設定します。',
        installComputerTitle: '別のコンピュータにインストール',
        installComputerSubtitle: 'そこにデスクトップアプリを入れて、リンクでこの Home に参加します。',
        installComputerAction: 'リンクを取得',
        connectComputerTitle: 'コンピュータを接続',
        connectComputerSubtitle: 'コンピュータのターミナルに Happier が表示するコードをスキャンします。',
        connectComputerHint: 'コンピュータのターミナルに Happier が表示するコードにカメラを向けてください。',
        phoneAddMachineSubtitle: 'エージェントを実行するサーバーや開発マシンを設定します。',
        phoneAddMachineAction: '追加',
        thisHome: 'この Home',
        pairingPhoneTitle: 'スマートフォンでスキャン',
        pairingPhoneBody: ({ home }) => `スマートフォンのカメラをコードに向けてください。Happier が開き、${home} に参加します。`,
        pairingPhoneStepInstall: 'スマートフォンに Happier をインストールします。',
        pairingPhoneStepScan: 'カメラを開いてコードをスキャンします。',
        pairingPhoneStepJoin: 'このまま開いておいてください。スキャンするとすぐに参加します。',
        pairingComputerTitle: '別のコンピュータから参加',
        pairingComputerBody: ({ home }) => `このリンクを別のコンピュータに送ってください。Happier で開くと ${home} に参加します。`,
        pairingComputerStepInstall: '別のコンピュータにデスクトップアプリをインストールします。',
        pairingComputerStepOpen: 'そこでリンクを開くか、Happier が接続方法を尋ねたときに貼り付けます。',
        pairingComputerStepJoin: 'このまま開いておいてください。リンクを開くとすぐに参加します。',
        appStore: 'App Store',
        googlePlay: 'Google Play',
        getDesktopApp: 'デスクトップアプリを入手',
        copyLink: 'リンクをコピー',
        waitingForPhone: 'スマートフォンを待っています…',
        waitingForComputer: 'コンピュータを待っています…',
        newCodeIn: ({ time }) => `${time} 後に新しいコード`,
        makingCode: 'コードを作成しています…',
        addingDevice: ({ device }) => `${device} を追加しています…`,
        deviceJoined: ({ device, home }) => `${device} が ${home} に参加しました`,
        codeFailed: 'この Home のコードを作成できませんでした。',
        codeFailedUnreachable: ({ home }) => `${home} がこのデバイスに応答しませんでした。`,
        codeFailedIdentity: ({ home }) => `このデバイスの ${home} の記録が応答と一致しません。Homes で再接続してください。`,
        codeFailedSignedOut: ({ home }) => `このデバイスは ${home} にサインインしていません。`,
        codeFailedTooLarge: 'アドレスが多すぎてコードに収まりません。',
        codeFailedRefused: ({ home }) => `${home} がリクエストを拒否しました。`,
        codeFailedUnexpected: '問題が発生しました。もう一度お試しください。',
        cancelCode: 'コードを取り消す',
        newCode: '新しいコード',
        qrLabel: ({ home }) => `${home} にデバイスを追加する QR コード`,
        storeQrLabel: ({ store }) => `${store} の Happier の QR コード`,
        getTheApp: 'アプリを入手',
        connectServicesTitle: ({ first, second }) => (second ? `${first} または ${second} を接続` : `${first} を接続`),
        connectServicesSubtitle: 'すでに支払っているプランをすべてのマシンで使い、残量を確認できます。',
        addNameSubtitle: '一緒に作業する人にあなたの名前が表示されます。',
        addNameAction: '名前を追加',
        notNow: '後で',
    } } satisfies Pick<Readonly<Record<string, HomeSetupTranslation>>, "ja">;

return { homeSetupTranslations };
})();

const Domain_homeWidgetTranslations = (() => {
type HomeWidgetTranslation = Shared_homeWidgetTranslations.HomeWidgetTranslation;

const homeWidgetTranslations = { ja: {
        open: ({ destination }) => `${destination}を開く`,
        refreshFailed: '更新できませんでした',
        latestRunsTitle: '最近の実行',
        latestRunsLoading: '最近の実行を読み込んでいます',
        latestRunsEmptyTitle: 'まだ実行はありません',
        latestRunsEmptyReason: 'オートメーションが実行されると、各実行の結果がここに表示されます。',
        latestRunsErrorTitle: '最近の実行を読み込めませんでした',
        latestRunsErrorReason: 'Home から応答がありません。接続を確認して、もう一度お試しください。',
        yourHomeTitle: 'あなたの Home',
        yourHomeDescription: 'Home を回るマシンと、対応が必要なもの',
        yourHomeOnline: ({ online, total }) => `${total} 台中 ${online} 台オンライン`,
        yourHomeSessions: ({ count }) => `${count} セッション`,
        yourHomeWorking: ({ count }) => `${count} 件作業中`,
        yourHomeOffline: ({ lastSeen }) => `オフライン · 最終確認 ${lastSeen}`,
        yourHomeEmptyTitle: 'マシンはまだありません',
        yourHomeEmptyBody: 'マシンが参加すると Home の周りを回ります。',
        yourHomeMore: ({ count }) => `ほか ${count} 台`,
    } } satisfies Pick<Readonly<Record<string, HomeWidgetTranslation>>, "ja">;

return { homeWidgetTranslations };
})();

const Domain_homesHubTranslations = (() => {
type HomesHubTranslation = Shared_homesHubTranslations.HomesHubTranslation;

const homesHubTranslations = { ja: {
        addHomeOrSignIn: 'Home を追加 / サインイン',
        sheetDescription: 'このデバイスを別の Home に接続するか、自分の Home を見つけます。',
        continueWithService: ({ service }) => `${service} で続行`,
        continueWithThisHome: 'この Home で続行',
        continueWithServiceSubtitle: 'Home を見つけて、この Home をほかのデバイスでも使えるようにします。',
        serviceUnavailable: ({ service }) => `${service} は現在利用できません。`,
        serviceUnsupported: ({ service }) => `${service} はアカウントでのサインインに対応していません。`,
        serviceUnavailableUnnamed: 'サインインサービスは現在利用できません。',
        serviceUnsupportedUnnamed: 'サインインサービスはアカウントでのサインインに対応していません。',
        scanOrPaste: 'Home リンクをスキャンまたは貼り付け',
        scanOrPasteSubtitle: 'QR コードまたはリンクで Home に参加します。',
        createPersonalHome: 'このコンピューターにパーソナル Home を作成',
        createPersonalHomeSubtitle: '自分のマシンとデバイスのための Home をここで実行します。',
        opensFirst: '最初に開く',
    } } as const satisfies Pick<Record<string, HomesHubTranslation>, "ja">;

return { homesHubTranslations };
})();

const Domain_homesJourneysTranslations = (() => {
type Service = Shared_homesJourneysTranslations.Service;

type Home = Shared_homesJourneysTranslations.Home;

type HomesJourneysTranslation = Shared_homesJourneysTranslations.HomesJourneysTranslation;

const en = Shared_homesJourneysTranslations.en;

const ruTimes = Shared_homesJourneysTranslations.ruTimes;

const ja: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "Home が見つかりました",
        reconcileLead: "このスマートフォンですべての Home をまとめて確認できます。",
        showMySessions: "セッションを表示",
        scanComputerCode: "コンピューターのコードをスキャン",
        serviceLead: "サインインすると Home が見つかり、このスマートフォンですべてを確認できます。",
        serviceAsHomeLead: ({ service }) => `セッションは ${service} に保存され、いつでもアクセスできます。準備ができたらエージェントを実行するコンピューターを追加してください。`,
        factAlwaysOnDetail: "いつでもセッションにアクセスできます。",
        factAgents: "コンピューターがエージェントを実行します",
        factAgentsDetail: "後で QR コードを使って追加できます。",
        fromDeviceHelp: "接続済みの端末で「設定 → スマートフォンを追加」を開き、このスマートフォンのカメラでコードをスキャンするか、Home リンクを貼り付けてください。",
        scan: "スキャン",
    },
    happierAccount: 'Happier アカウント',
    serviceAccount: ({ service }) => `${service} アカウント`,

    alreadyUseTitle: 'すでに Happier を使っていますか？',
    alreadyUseDescription: 'アカウントで Home を見つけるか、自分で運用している Home に直接接続します。選ぶまで、このコンピューターでは何も変わりません。',
    signIn: 'サインイン',
    withService: ({ service }) => `${service} で`,
    changeServiceLabel: ({ service }) => `サインインサービス: ${service}。変更`,
    connectToHome: 'Home に接続…',
    hostedPrompt: 'ホスト型のほうがいいですか？',
    useServiceAsAHome: ({ service }) => `${service} を Home として使う`,
    dismiss: '非表示',

    pathServiceTitle: ({ service }) => `${service} でサインイン`,
    pathServiceSubtitle: 'アカウントにリンクされた Home を見つける',
    pathOtherServiceTitle: '別のサービスでサインイン',
    pathOtherServiceSubtitle: '自分または会社のサインイン',
    pathDirectTitle: 'Home に直接接続',
    pathDirectSubtitle: 'リンクまたはアドレス · アカウント不要',

    serviceLead: 'サインインすると Home が見つかり、まとめて表示されます。このコンピューターのパーソナル Home は、決めるまでそのまま残ります。',
    defaultServiceFact: '既定のサインインサービス',
    serviceMethodsHelp: ({ service }) => `${service} が提供する方法だけが表示されます。はじめてですか？同じボタンでアカウントを作成できます。`,

    otherServiceLead: '自分やチームで独自のサインインサービスを運用している場合は、そのアドレスを入力してください。Happier はまず何が提供されているかを確認します。',
    serviceAddressLabel: 'サインインサービスのアドレス',
    serviceFound: '見つかりました',
    useThisService: ({ service }) => `${service} でサインイン`,
    addressIsNotAService: 'このアドレスはアカウントのサインインを提供していません。Home であれば、直接接続してください。',
    connectAsHome: 'Home として接続',
    backToService: ({ service }) => `${service} に戻る`,

    directLead: '自分で運用している Home 向けです。アカウントサービスの有無は問いません。Happier アカウントは不要です。',
    fromDeviceLabel: 'すでに接続済みのデバイスから',
    fromDeviceHelp: 'そのデバイスで「設定 → スマートフォンを追加」を開き、このコンピューターのカメラでコードをスキャンするか、Home リンクを貼り付けます。',
    homeLinkLabel: 'Home リンク',
    homeLinkPlaceholder: 'Home リンクを貼り付け',
    useCamera: 'カメラを使う',
    openLink: '開く',
    byAddressLabel: 'アドレスで',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: '接続',
    byAddressHelp: 'Happier が Home の応答を確認したあと、その Home 独自の方法でサインインします。',
    notAHomeLink: 'これは Home リンクではありません。もう一方のデバイスからもう一度コピーしてください。',
    homeUnreachable: 'このアドレスで Home に接続できませんでした。アドレスと、Home が実行中かどうかを確認してください。',

    anotherWay: '別の方法',
    homeReachable: '接続可能',
    connected: '接続済み',
    signInToHomeTitle: 'この Home にサインイン',
    signInToHomeLead: 'この Home が提供する方法です。',

    reconcileTitle: 'Home が接続されました',
    reconcileLead: ({ count }) => `このコンピューターの Home は ${count + 1} 件になりました。「すべての Home」にまとめて表示されます。`,
    reconcileFound: '見つかった Home',
    reconcileThisComputer: 'このコンピューター',
    runSessionsIn: 'このコンピューターのセッションの実行先',
    runSessionsInDescription: 'ここで開始した新しいセッションはこの Home に保存されます。',
    removeEmptyPersonalHome: '空のパーソナル Home を削除',
    removeEmptyPersonalHomeDescription: 'Happier のインストール時に作成されたもので、まだ何も含まれていません（セッション、メンバー、チーム、招待のいずれもありません）。',
    changeLater: 'あとで「設定 → Home」で変更できます。',
    keepBoth: '両方残す',
    useHome: ({ home }) => `${home} を使う`,
    reconcileSetupTitle: 'このコンピューターのセッションの行き先を選ぶ',
    reconcileSetupSubtitle: ({ home }) => `${home} を接続しました。両方の Home を残すか、このコンピューターのセッションをそちらで実行します。`,
    reconcileSetupAction: '選択…',

    serviceAsHomeTitle: ({ service }) => `${service} を自分の Home として使う`,
    serviceAsHomeLead: ({ service }) => `セッションと設定は、このコンピューターではなく ${service} に保存されます。`,
    factAlwaysOn: '常時オン',
    factAlwaysOnDetail: 'このコンピューターがスリープ中でも、スマートフォンからセッションに届きます。',
    factAgents: 'エージェントは引き続きこのコンピューターで実行されます',
    factAgentsDetail: 'コードを実行する場所は変わりません。',
    storageE2ee: 'エンドツーエンド暗号化',
    storageE2eeDetail: ({ service }) => `${service} はセッションを保存しますが、読むことはできません。`,
    storagePlain: ({ service }) => `${service} が保存`,
    storagePlainDetail: 'エンドツーエンド暗号化されていません。サービスは保存内容を読めます。',
    storageE2eeByDefault: '既定でエンドツーエンド暗号化',
    storagePlainByDefault: ({ service }) => `${service} が保存（既定で読み取り可能）`,
    storageChoiceDetail: 'アカウント作成時に選べます。',
    removeEmptyOfferedDetail: 'まだ何も含まれていません。空のときだけ表示されます。',
    signInOrCreate: ({ account }) => `${account}にサインインまたは作成`,
    alreadyUseServiceAsHome: ({ service }) => `すでに ${service} を Home として使っていますか？サインインすると直接接続されます。`,

    addHomeTitle: 'Home を追加',
    addHomeDescription: 'Home にはセッションと設定が保存されます。使っている Home を接続するか、新しい場所で始めましょう。',
    addSignIn: ({ account }) => `${account}でサインイン`,
    addSignInSubtitle: '使っている Home を見つけて接続します。',
    addServiceAsHomeSubtitle: 'ホスト型で常時オン。',
    addLinkOrQr: 'リンクまたは QR コードで接続',
    addLinkOrQrSubtitle: 'アカウント不要。接続済みのデバイスから取得します。',
    addServerHome: 'サーバーに Home をセットアップ',
    addServerHomeSubtitle: '自分で管理する開発マシンや VPS に SSH でセットアップします。',
    haveHomeAddress: 'Home のアドレスをお持ちですか？',
    enterIt: '入力する',

    livesOnThisComputer: 'このコンピューター上にあります',
    availableWhileAwake: 'スリープしていない間は利用可能',
    gettingReady: '準備中',
    noComputerYet: 'まだコンピューターがありませんか？',
    aboutYourHome: 'Home について',

    nudgeTitle: ({ count }) => `今週 Home に ${count} 回接続できませんでした — Home を移動しますか？`,
    nudgeBody: 'この Home がスリープするコンピューターで動作している場合、常時稼働するホストへの移動が役立つことがあります。',
    nudgeDismiss: 'このデバイスでは今後表示しない',
    moveHome: 'Home を移動…',
    useService: ({ service }) => `${service} を使う`,
};

const homesJourneysTranslations = { ja } satisfies Pick<Readonly<Record<string, HomesJourneysTranslation>>, "ja">;

return { homesJourneysTranslations };
})();

const Domain_identityAdministrationTranslations = (() => {
type IdentityAdministrationLanguage = Shared_identityAdministrationTranslations.IdentityAdministrationLanguage;

type Words = Shared_identityAdministrationTranslations.Words;

type GitHubAccessWords = Shared_identityAdministrationTranslations.GitHubAccessWords;

type OidcEditorWords = Shared_identityAdministrationTranslations.OidcEditorWords;

const build = Shared_identityAdministrationTranslations.build;

const en = Shared_identityAdministrationTranslations.en;

const githubAccessWords: Pick<Readonly<Record<IdentityAdministrationLanguage, GitHubAccessWords>>, "ja"> = { ja: {
        githubCurrentAccess: '現在必要なアクセス',
        githubCurrentAccessSubtitle: 'このインストールを使用する有効な接続とディレクトリソースに必要です。',
        githubCurrentAccessEmpty: '有効なサービスに必要なアクセスはありません。',
        githubSetupAccess: '設定と修復のためのアクセス',
        githubSetupAccessSubtitle: '無効な接続や一時停止中のディレクトリソースを含む、設定済みの接続に必要なアクセスです。有効化または再開する前に GitHub で不足しているアクセスを許可し、インストールを再確認してください。',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `${name} のインストールを削除`,
    } };

const oidcEditorWords: Pick<Readonly<Record<IdentityAdministrationLanguage, OidcEditorWords>>, "ja"> = { ja: {
        clientAuthenticationMethod: 'クライアント認証', clientSecretPost: 'POST 本文', clientSecretBasic: 'HTTP Basic', storeRefreshToken: '更新トークンを保存', buttonColor: 'サインインボタンの色', iconHint: 'サインインアイコン',
        allowRulesHint: '1 行に 1 つの値を入力します。空欄の場合は制限しません。', brandingHint: '既定のサインイン表示を使う場合は空欄にします。', invalidScopes: '要求するスコープに openid を含めてください。', refreshFailed: 'この接続を更新できませんでした', refreshFailedHint: '編集内容は保持されています。Home の変更を確認するには再試行してください。',
    } };

const identityAdministrationTranslations = { ja: build({ ...en, homeTeamsUsingIt: "使用しているチーム", homeTeamsUsingItNone: "まだ受け入れているチームはありません", mappedGroupNotVisible: "表示できないグループ", homeWorkosChooseDetail: "この Home へのサインインに使う WorkOS 接続を選んでください。", workosRequiredForTeamWork: "チームでの作業に必要", workosTeamPolicyHint: "許可するサインイン方法は「メンバーのサインイン方法」で変更できます。", workosLifecycleFootnote: "オフにすると、再びオンにするまでこの接続でサインインできません。削除するとこのHomeから接続が削除されますが、WorkOSの組織は残ります。", homeWorkosAdd: "WorkOSによる会社のサインイン", homeWorkosCompanyName: "会社名", homeWorkosPurpose: "会社のメンバーは仕事用アカウントでこのHomeにサインインできます。", homeWorkosEnableDetail: "会社のアカウントでこのHomeにサインインできるようになります。", homeWorkosOffboarding: "SSOだけでは退職した人は削除されません。", homeWorkosPlatformRequired: "まずサインインプラットフォームでWorkOSを設定してください。",  title: 'ID プロバイダー', subtitle: 'Team で利用できる Home 所有のサインイン接続です。', homeConnections: 'Home のサインイン接続', add: '接続を追加', empty: "会社のサインインはまだありません", active: '有効', disabled: '無効', configuration: '設定', issuer: '発行者 URL', clientSecret: 'クライアントシークレット', secretSet: '設定済み', secretNotSet: '未設定', secretRetain: '現在のシークレットを保持するには空欄にします。', advanced: '詳細設定を表示', hideAdvanced: '詳細設定を隠す', actions: '操作', test: 'サインインをテスト', testing: 'テストを開いています…', edit: '接続を編集', save: '接続を保存', saving: '保存中…', enable: '接続を有効化', disable: '接続を無効化', remove: '接続を削除', createTitle: 'ID プロバイダーを追加', editTitle: 'ID プロバイダーを編集', displayName: '名前', required: '必須項目を入力してください。', invalidIssuer: '有効な HTTPS URL を入力してください。', secretRequired: 'クライアントシークレットを入力してください。', error: '変更できませんでした。', accounts: '影響する Account', connections: 'Team 接続', errorForbidden: 'この操作の権限がなくなりました。何も変更されていません。', errorConflict: '先に別のユーザーが変更しました。入力内容は保持されています。再読み込みしてからもう一度お試しください。', errorMissing: 'これはすでに存在しません。削除された可能性があります。', errorInUse: 'まだ依存しているものがあります。先にそれを削除してください。', errorProviderUnavailable: 'ID サービスが応答しませんでした。何も変更されていません。', errorRateLimited: 'プロバイダーから、再試行前に待つよう求められました。', errorInvalid: 'Home がこれらの値を拒否しました。設定を確認してもう一度お試しください。', errorImmutable: 'この値は使用開始後は変更できません。新しく作成してください。', errorAuthenticationRequired: 'この Team にもう一度サインインしてから再試行してください。変更はありません。', errorPolicyUnavailable: 'Team の認証ポリシーを現在評価できません。変更はありません。', errorPolicyInUse: 'Team の認証ポリシーはまだこの接続に依存しています。', errorNotAllowed: 'この Home では Team がこれを設定することを許可していません。変更はありません。', errorNeedsAttention: 'ディレクトリ同期に確認が必要です。完全同期を実行してください。', errorSyncPaused: 'このソースは一時停止中です。「同期を再開」で新しい完全同期を開始します。', alternateLogins: '別のサインイン方法が必要な Account', recoveryAuthenticationPolicy: 'Team の認証を開く', recoveryAlternateLogin: '先にこれらの Account に別のサインイン方法を用意してください', recoveryDirectory: 'ディレクトリを開く', recoveryGroupMappings: 'グループの対応付けを開く', recoveryTeamAuthentication: 'もう一度サインイン', callbackUrl: 'コールバック URL', callbackUrlHint: 'この URL を ID プロバイダーに登録してください。' , workosSetupSso: 'WorkOS 管理ポータルを開く', workosSetupDirectory: 'WorkOS Directory Sync を設定', workosCheckSetup: 'WorkOS の設定を確認', workosChooseConnection: '接続を選択', workosPortalConfirmBody: 'WorkOS で設定を完了してから、ここに戻って接続を選択します。', workosDirectoryPortalConfirmBody: 'WorkOS で設定を完了してから、ここに戻ってディレクトリを選択します。', workosSetupSection: '設定', workosSetupFooter: '途中で離れても大丈夫です。設定は到達したステップから再開されます。', workosStepPortalDetail: 'そこで ID プロバイダーを接続します。戻ると、ここで設定が続きます。', workosStepPortalDone: '管理ポータル', workosStepPortalDoneDetail: '組織がリンクされています。', workosOpenPortal: 'ポータルを開く', workosOpenPortalAgain: 'もう一度開く', workosNothingCreatedYet: "ポータルを開くまで何も作成されません。ここで離れても何も残りません。", workosStepChooseDetail: 'メンバーのサインインに使う WorkOS 接続を選択します。', workosStepChooseDone: '接続', workosFindConnections: '接続を探す', workosUseConnection: ({ name }: { name: string }) => `${name} を使用`, workosCandidateDraft: 'WorkOS の下書きです。先にそちらで完了してください。', workosStepTestDetail: 'ご自身で一度サインインします。誰のアカウントにも何も保存されません。', workosTestPassed: 'テストサインインは成功しました。', workosTestAgain: 'もう一度テスト', workosStepEnable: 'オンにする', workosStepEnableDetail: 'オンにするとメンバーがサインインに使えます。必須にするには「メンバーのサインイン方法」で選択します。', workosTurnOn: 'オンにする', workosConnectionSection: '接続', workosConnectionRow: 'WorkOS 接続', workosConnectionNotChosen: '未選択', workosChange: '変更', errorWorkosPlatformUnavailable: 'この Home ではまだ WorkOS が設定されていません。', errorSetupRequired: '使う前に設定が必要です。', removeTitle: ({ name }: { name: string }) => `${name} を削除しますか？`, removeBody: ({ name }: { name: string }) => `${name} はサインイン方法として提供されなくなります。使用していたアカウントは保持されます。`, removeBlocked: ({ accounts, connections }: { accounts: number; connections: number }) => `まだチーム接続 ${connections} 件とアカウント ${accounts} 件で使用されています。先にそれらを削除してください。`, disableTitle: ({ name }: { name: string }) => `${name} をオフにしますか？`, disableBody: ({ name }: { name: string }) => `再びオンにするまで ${name} でサインインできません。何も削除されません。`, githubRemoveInstallationTitle: ({ name }: { name: string }) => `${name} のインストールを削除しますか？`, githubRemoveInstallationBody: ({ name }: { name: string }) => `この Home は ${name} の App を使わなくなります。GitHub 側は変わりません。不要なら GitHub でアンインストールしてください。`, removeBlockedTitle: ({ name }: { name: string }) => `${name} はまだ削除できません`, removeImpactPeople: ({ count }: { count: number }) => `${count} 人がこれでこのチームにサインインしています。`, removeImpactNobody: 'まだ誰もこれでこのチームにサインインしていません。', removeImpactKept: 'アカウントとチームのメンバーシップは保持されます。', removeBlockedAlternateLogins: ({ count }: { count: number }) => `${count} 人には他のサインイン方法がありません。`, removeBlockedDirectories: ({ count }: { count: number }) => `${count} 件のディレクトリソースがまだ使用しています。`, removeBlockedGroups: ({ count }: { count: number }) => `${count} 件のグループ対応付けがまだ使用しています。`, removeBlockedMemberships: ({ count }: { count: number }) => `${count} 件のメンバーシップがまだこれで管理されています。` }, githubAccessWords.ja, oidcEditorWords.ja) };

return { githubAccessWords, oidcEditorWords, identityAdministrationTranslations };
})();

const Domain_inboxWorkTranslations = (() => {
const en = Shared_inboxWorkTranslations.en;

const ja: typeof en = {
    pageDescription: "あなたを待っていること、変わったこと、あなたをメンションした人。",
    needsYouSummary: ({ approvals, decisions, blocked }: { approvals: number; decisions: number; blocked: number }) => {
        const parts = [
            approvals > 0 ? `承認 ${approvals} 件` : null,
            decisions > 0 ? `判断 ${decisions} 件` : null,
            blocked > 0 ? `ブロック中のセッション ${blocked} 件` : null,
        ].filter((part): part is string => part !== null);
        return `${parts.join('、')}があなたを待っています。`;
    },
    quickDecision: { deny: '拒否', allowOnce: '今回のみ許可' },
    keyHints: { move: '移動', fullPage: 'ページ全体', close: '閉じる', answering: '回答すると次が開きます' },
    tabs: { a11y: '受信トレイの表示', needsYou: '対応が必要', updates: '更新', mentions: "メンション" },
    groups: {
        openSession: 'セッションを開く',
        openRun: '実行を開く',
    },
    rows: {
        step: 'ステップ',
        workflowRun: 'ワークフロー実行',
        review: 'レビュー',
        stalled: '停止中',
        stalledReason: 'ターンの途中でマシンがオフラインになりました',
        landing: 'マージ待ち',
        settle: '完了にする',
        snoozedUntil: ({ time }) => `${time} までスヌーズ`,
        more: 'その他の操作',
        approvalNeeded: '承認が必要です',
        approvalUntitled: 'アクションを承認',
        mentionedYou: "あなたをメンションしました",
        newMessage: "新しいメッセージ",
    },
    popover: {
        updates: ({ count }) => `更新 ${count} 件`,
    },
    types: { approval: "承認", decision: "判断", blocked: "ブロック中" },
    days: { today: "今日", earlier: "それ以前" },
    mentionsEmpty: {
        title: "メンションはありません",
        description: "ディスカッションであなたがメンションされると、ここに届きます。",
    },
    empty: {
        title: '対応が必要なものはありません',
        description: '権限リクエスト、レビュー、オーケストレーターやワークフローがあなたを待っているものがここに届きます。',
    },
    updatesEmpty: {
        title: '更新はありません',
        description: '完了したセッションとフレンドリクエストがここに届きます。',
    },
    stale: { reason: 'ワークフロー実行を更新できませんでした', retry: '再試行' },
    settleFailed: 'このセッションを完了にできませんでした',
    detail: {
        openApproval: 'リクエストを開く',
    },
};

const inboxWorkTranslations = { ja };

return { inboxWorkTranslations };
})();

const Domain_inputPickerTranslations = (() => {
type InputPickerTranslation = Shared_inputPickerTranslations.InputPickerTranslation;

const inputPickerTranslations = { ja: {
        browse: '参照…',
        browseField: ({ field }) => `${field}を参照`,
        unavailable: 'この選択肢を提供するプラグインを利用できません。現在の値はそのままです。',
        retired: '選択中にプラグインが更新されました。もう一度お試しください。',
        invalid: 'この選択肢はここでは使えません。現在の値はそのままです。',
        failed: 'ピッカーを開けませんでした。もう一度お試しください。',
    } } satisfies Pick<Readonly<Record<string, InputPickerTranslation>>, "ja">;

return { inputPickerTranslations };
})();

const Domain_machineAddTranslations = (() => {
type MachineAddTranslation = Shared_machineAddTranslations.MachineAddTranslation;

const machineAddTranslations = { ja: { newMachine: '新しいマシン', waiting: '接続を待っています', connected: '接続済み', failed: 'このマシンを追加できませんでした', cancelled: 'キャンセル済み', cannotReachHost: 'ホストに接続できません。アドレスと SSH アクセスを確認してください。', choosePath: 'マシンの追加方法を選んでください', switchHome: '続行するにはこの Home に戻ってください' } } satisfies Pick<Record<'en' | 'ru' | 'pl' | 'es' | 'fr' | 'it' | 'pt' | 'ca' | 'de' | 'zh-Hans' | 'zh-Hant' | 'ja', MachineAddTranslation>, "ja">;

return { machineAddTranslations };
})();

const Domain_machineAgentsTranslations = (() => {
type MachineAgentsTranslation = Shared_machineAgentsTranslations.MachineAgentsTranslation;

const en = Shared_machineAgentsTranslations.en;

const ja: MachineAgentsTranslation = {
    signedInWith: ({ label }) => `${label} でサインイン済み`,
    signedInAs: ({ label }) => `${label} としてサインイン済み`,
    signedInHere: 'このマシンでサインイン済み',
    updateTo: ({ version }) => `${version} に更新`,
    needsSignIn: 'サインインが必要',
    waitingForSignIn: 'ターミナルでのサインインを待っています…',
    notInstalled: '未インストール',
    downloadSize: ({ size }) => `${size} のダウンロード`,
    installYourself: '自分でインストール',
    unsupportedOs: 'このシステムでは動作しません',
    unsupportedArch: 'このプロセッサ向けのビルドがありません',
    unsupported: 'ここでは実行できません',
    installing: 'インストール中…',
    progress: ({ done, total }) => `${done} / ${total}`,
    checking: '確認中…',
    offlineSignedIn: '前回はサインイン済み · マシンはオフライン',
    offlineSignedOut: '前回はサインアウト · マシンはオフライン',
    offlineNotInstalled: '前回は未インストール · マシンはオフライン',
    offlineUnknown: 'マシンはオフライン',
    unknown: 'このマシンを確認できませんでした',
    actionInstall: 'インストール',
    actionUpdate: '更新',
    actionSignIn: 'サインイン',
    actionRetry: '再試行',
    actionCancel: 'キャンセル',
    actionShowTerminal: 'ターミナルを表示',
    actionGuide: 'セットアップガイド',
    actionRemove: '削除',
    setupSignInTitle: 'サインイン',
    setupChangeSignIn: '変更',
    setupCliTitle: 'コマンドライン',
    cliByHappier: 'Happier がインストール',
    installLeadManaged: ({ agent, machine }) => `Happier は ${machine} に Happier 専用の ${agent} をインストールします。ご自身のターミナル設定は変わりません。`,
    installLeadVendor: ({ agent, machine }) => `Happier は ${machine} で ${agent} 自身のインストーラーを実行します。`,
    installAlsoDownloads: ({ what }) => `セッションで使う ${what} もダウンロードします。`,
    installThenSignIn: 'その後サインインします。',
    installAgent: ({ agent }) => `${agent} をインストール`,
    installMyself: '自分でインストールする',
    manualLead: ({ agent, machine }) => `Happier は ${agent} をインストールできません。ガイドに従って ${machine} にインストールし、もう一度確認してください。`,
    checkAgain: 'もう一度確認',
    closeNote: ({ machine }) => `閉じても ${machine} で続行されます。`,
    stepCheck: '動作を確認',
    stepSignIn: 'サインイン',
    failedKept: '途中までのインストールは残していません。',
    installedLine: ({ agent, version }) => `${agent} ${version} をインストールしました`,
    nowSignIn: '次はサインイン',
    signInHow: ({ agent }) => `${agent} のサインイン方法`,
    useService: ({ service }) => `${service} を使う`,
    recommended: 'おすすめ',
    serviceConnected: ({ profile }) => `${profile} · 接続済み · すべてのマシンで使えます`,
    serviceNotConnected: '一度接続すれば、どのマシンでも使えます。',
    connect: '接続',
    signInOn: ({ machine }) => `${machine} でサインイン`,
    signInOnDetail: ({ agent }) => `そのマシンのターミナルで ${agent} 自身のサインインを実行します。そのマシンだけが使います。`,
    noNativeLogin: ({ agent }) => `${agent} には独自のサインインがありません。API キーまたは接続済みアカウントを使います。一度接続すればどのマシンでも使えます。`,
    openSignInTerminal: 'ターミナルでサインインを開く',
    useThisAccount: 'このアカウントを使う',
    waitingLead: ({ agent, machine }) => `${agent} 自身のサインインが ${machine} のターミナルで開いています。サインインが報告されるとすぐに準備完了になります。`,
    readyLine: ({ agent, machine }) => `${machine} で ${agent} の準備ができました`,
    startSessionWith: ({ agent }) => `${agent} でセッションを開始`,
    setUpAnother: '別のエージェントを設定',
    unsupportedLead: ({ agent, machine }) => `${agent} には ${machine} 向けのビルドがないため、そこでは動作しません。`,
    setupTitle: ({ agent }) => `${agent} を設定`,
    signInTitle: ({ agent }) => `${agent} にサインイン`,
    readyTitle: ({ agent }) => `${agent} の準備完了`,
    notOnMachineYet: ({ machine }) => `${machine} にはまだありません`,
    onMachine: ({ machine }) => `${machine} 上`,
    installingOn: ({ machine }) => `${machine} にインストール中`,
    cantRunOn: ({ machine }) => `${machine} では動作しません`,
    terminalTab: ({ agent }) => `サインイン · ${agent}`,
    panelLead: '開いたブラウザで完了してください。別のデバイスならそこでリンクを開いてください。',
    open: '開く',
    openSignInPage: 'サインインページを開く',
    waitingEllipsis: 'サインインを待っています…',
    signedInAlready: 'すでにサインイン済み？',
    closeTerminal: 'ターミナルを閉じる',
    showTheTerminal: 'ターミナルを表示',
    phoneLead: ({ agent, machine }) => `${agent} がサインインを求めています。ここでページを開いて完了すると、${machine} が反映します。`,
    panelSignedInAs: ({ account }) => `${account} としてサインインしました。`,
    panelChecked: 'Happier がたった今確認しました。',
    sectionTitle: 'エージェント',
    sectionDescription: 'このマシンのコーディングエージェントと、それぞれのサインイン方法。',
    addTitle: 'エージェントを追加',
    addMore: ({ count }) => (count === 1 ? `ここで動くものがあと 1 つ` : `ここで動くものがあと ${count} つ`),
    showAll: 'すべて表示',
    showFewer: '表示を減らす',
    emptyInstalled: 'このマシンにはまだエージェントがありません。下から選ぶと、Happier がインストールしてサインインします。',
    offlineNote: ({ machine }) => `${machine} はオフラインです。最後に報告された内容です。`,
    firstTitle: '最初のエージェントを設定',
    firstLead: ({ machine }) => `${machine} は接続済みですが、まだエージェントがありません。選ぶと Happier がインストールしてサインインします。`,
    firstMore: ({ count }) => (count === 1 ? `ほかに 1 つのエージェントから選べます。` : `ほかに ${count} のエージェントから選べます。`),
    allAgents: 'すべてのエージェント',
    setUp: '設定',
    choiceUsesService: ({ service, profile }) => `${service} を使います。接続済み：${profile}。`,
    choiceSignsInOn: 'マシン上でサインインします。',
    dismissFirst: '「最初のエージェントを設定」を非表示',
    dismissTooltip: '非表示 · カスタマイズから元に戻せます',
    chooseAgent: 'エージェントを選択',
    blockNotInstalled: ({ agent, machine }) => `${agent} はまだ ${machine} にありません。`,
    blockNotInstalledShort: ({ agent }) => `${agent} は未設定です。`,
    blockSetUpToStart: '設定すると開始できます。',
    blockSignedOut: ({ agent, machine }) => `${agent} は ${machine} でサインインが必要です。`,
    blockSignedOutShort: ({ agent }) => `${agent} はサインインが必要です。`,
    useConnectedAccount: ({ account }) => `${account} を使う`,
    spawnCliMissing: ({ agent, machine }) => `${agent} は ${machine} にインストールされていません。`,
    spawnSignedOut: ({ agent, machine }) => `${agent} は ${machine} でサインアウトしています。`,
    draftKept: 'メッセージは保持されています。',
    alreadySetUp: ({ machine, home }) => `${machine} は ${home} に接続済みです`,
    startSession: 'セッションを開始',
    openMachine: ({ machine }) => `${machine} を開く`,
};

const machineAgentsTranslations = { ja: ja } satisfies Pick<Readonly<Record<string, MachineAgentsTranslation>>, "ja">;

return { machineAgentsTranslations };
})();

const Domain_machineDetailPageTranslations = (() => {
type MachineDetailPageTranslations = Shared_machineDetailPageTranslations.MachineDetailPageTranslations;

const english = Shared_machineDetailPageTranslations.english;

const translated = Shared_machineDetailPageTranslations.translated;

const machineDetailPageTranslations = { ja: translated({
        machineDetailPage: {
            description: 'このマシンでセッションを開始し、実行中の内容を確認します。',
            placeholderTitle: 'マシン',
            online: 'オンライン',
            offline: 'オフライン',
            cliVersionFact: ({ version }) => `CLI ${version}`,
            replacedByFact: ({ machine }) => `${machine} に置き換え済み`,
            unavailableTitle: 'このマシンは現在セッションを開始できません',
            startAction: 'セッションを開始',
            openTerminalAction: "ターミナルを開く",
            terminalSheetTitle: ({ machine }) => `${machine} のターミナル`,
            terminalSheetWaitingTitle: ({ machine }) => `${machine} のロックを解除しています`,
            terminalSheetWaitingBody: 'Happier はこのデバイスでまだこのマシンの情報を読み取れません。読み取れ次第、ここでターミナルが開きます。',
            tmuxSectionDescription: 'このマシンの新しいセッションで tmux をどう使うか。',
            windowsSectionDescription: 'このマシンでリモートセッションをどう開くか。',
            clisSectionDescription: 'Happier がこのマシンで見つけたエージェント CLI と、インストールできるツール。',
            runsSectionDescription: 'このマシンでセッションが開始したプロセス。',
            runsLoadFailed: "このマシンの実行を読み取れませんでした",
            recentSessionsTitle: '最近のセッション',
            recentSessionsDescription: 'このマシンで最近使った 5 件のセッション。',
            daemonSectionDescription: 'このマシンを Happier に接続するバックグラウンドサービス。',
            stopDaemonDescription: '実行中のセッションは続きます。このマシンで再起動するまで新しいセッションは開始できません。',
            stopDaemonAction: '停止',
            detailsTitle: 'マシンの詳細',
            tabs: {
                overview: "概要",
            },
            thisMachineTitle: "このマシン",
            connectionFollowsAccount: "アカウントの設定に従う",
            subPages: {
                sharing: "共有",
                agents: "エージェント",
                terminal: "ターミナル",
                connection: "接続",
                tools: "ツール",
                doctor: "診断",
                details: "詳細",
            },
            summaries: {
                terminalDirect: "セッションは直接開きます",
                sharedByOwner: ({ owner }) => `${owner} が共有`,
                sharedWithYou: "共有されています",
                agentReady: ({ agent }) => `${agent} は使用可能です`,
                agentsReadyPair: ({ first, second }) => `${first} と ${second} は使用可能です`,
                agentsReadyCount: ({ count }) => `${count} 個のエージェントが使用可能です`,
                doctorChecked: ({ time }) => `${time} に確認`,
            },
            work: {
                none: "作業なし",
                working: ({ count }) => `${count} 件作業中`,
            },
            platformFact: ({ platform, arch }) => `${platform} · ${arch}`,
        },
        machineAttention: {
            listNeedLook: ({ count }) => `${count} 台を確認`,
            limits: {
                files: "開いているファイル",
                ptys: "ターミナル",
                processes: "プロセス",
                inotify: "ファイル監視",
            },
            words: {
                memoryCritical: "メモリ不足",
                memoryElevated: "メモリが逼迫",
                diskNearlyFull: ({ volume }) => `${volume} がほぼ満杯`,
                diskFull: ({ volume }) => `${volume} が満杯`,
                limitReached: ({ limit }) => `${limit} が上限`,
                guardOutOfSteps: "ガードの手順が尽きました",
            },
            fleet: {
                calm: "すべて安定",
                count: ({ count }) => `${count} 台のマシンを確認してください`,
                sentenceOne: ({ phrase }) => `${phrase}。`,
                sentenceTwo: ({ first, second }) => `${first}。${second}。`,
                sentenceMore: ({ first, second, count }) => `${first}。${second}。ほか ${count} 台。`,
                sameReason: ({ word, count }) => `${count} 台で${word}。`,
                otherOnlineCalm: ({ count }) => `オンラインの他の ${count} 台は安定しています。`,
                allOnlineCalm: ({ count }) => count === 1 ? "オンラインの1台は安定しています。" : `オンラインのマシンはすべて安定しています。`,
            },
            machine: {
                calmLead: "安定。",
                idle: "作業中のセッションはありません。",
                working: ({ count }) => `${count} 件のセッションが作業中。`,
                calmWithMemory: ({ work, memory }) => `${work}${memory}。`,
                lead: ({ word }) => `${word}。`,
            },
            actions: {
                reviewProcesses: "プロセスを確認",
                freeUpSpace: "空き容量を増やす",
                undo: "元に戻す",
                review: "確認",
            },
            groups: {
                needsYou: "対応が必要",
                sinceYouLastLooked: "前回の確認以降",
            },
            phrases: {
                memoryCritical: ({ machine }) => `${machine} のメモリが不足しています`,
                memoryElevated: ({ machine }) => `${machine} のメモリが逼迫しています`,
                diskNearlyFull: ({ machine, volume }) => `${machine} の ${volume} がほぼ満杯です`,
                diskFull: ({ machine, volume }) => `${machine} の ${volume} が満杯です`,
                limitReached: ({ machine, limit }) => `${machine} の${limit}が上限に達しました`,
                guardOutOfSteps: ({ machine }) => `${machine} のメモリガードには、安全に停止できるものが残っていません`,
            },
            duration: {
                minutes: ({ count }) => `${count} 分`,
                hours: ({ count }) => `${count} 時間`,
                days: ({ count }) => `${count} 日`,
            },
            details: {
                swapping: ({ duration }) => `${duration} 前からスワップ中です。`,
                pressure: ({ duration }) => `${duration} 前から逼迫しています。`,
                disk: ({ duration }) => `${duration} 前から。`,
                limit: ({ used, max, limit }) => `${limit}: ${max} 中 ${used} を使用中。`,
                guardOutOfSteps: "メモリはまだ不足していますが、安全に停止できるものが残っていません。",
            },
            rail: {
                needYouCount: ({ count }) => `${count} 台のマシンに対応が必要です`,
            },
            guard: {
                freed: ({ machine, amount }) => `ガードが ${machine} で ${amount} を解放しました`,
                stoppedSession: ({ machine }) => `ガードが ${machine} のセッションを停止しました`,
                closedBrowser: ({ machine }) => `ガードが ${machine} のアイドル状態のブラウザを閉じました`,
                stoppedService: ({ machine }) => `ガードが ${machine} のサービスを停止しました`,
                stoppedLeftBehind: ({ machine }) => `ガードが ${machine} の残留プロセスを片付けました`,
            },
            sentences: ({ first, second }) => `${first}${second}`,
        },
        allMachines: {
            rowTitle: "すべてのマシン",
            viewList: "リスト",
            viewGrid: "グリッド",
            viewLabel: "マシンの表示方法",
            columnMachine: "マシン",
            columnSystem: "システム",
            columnWork: "作業",
            columnStatus: "状態",
            allMachinesGroup: "すべてのマシン",
            offlineHidden: ({ count }) => `${count}台のマシンがオフラインです`,
            showOffline: "表示",
            hideOffline: "非表示",
            machinesCount: ({ count }) => count === 1 ? `${count} 台のマシン` : `${count} 台のマシン`,
            sessionsWorking: ({ count }) => count === 1 ? `${count} 件のセッションが作業中` : `${count} 件のセッションが作業中`,
        },
        machineSummary: {
            settingTitle: "マシンの概要",
            styleTitle: "スタイル",
            usedHere: "ここ、マシン一覧、すべてのマシンで使われます。このデバイスに保存されます。",
            appearanceDescription: "各マシンのリソースをマシンのポップオーバー、一覧、すべてのマシンでどう表示するか。このデバイスに保存されます。",
            showTitle: "表示",
            showDescription: "各マシンに表示する指標。なしにすると名前だけになります。",
            styles: {
                sparklines: "スパークライン",
                bars: "バー",
                numbers: "数値",
                rings: "リング",
            },
            metrics: {
                cpu: "CPU",
                memory: "メモリ",
                disk: "ディスク",
                network: "ネットワーク",
            },
            metricDescriptions: {
                cpu: "使用率（直近5分）",
                memory: "空き容量と、不足したときの表示",
                disk: "ホームボリューム、または埋まりつつあるボリュームの空き容量",
                network: "ダウンロード速度",
            },
            caption: {
                cpu: "CPU",
                memory: "メモリ空き",
                disk: "ディスク空き",
                network: "ダウンロード",
                window: "直近5分",
            },
            pressure: {
                critical: "危険",
                elevated: "メモリ不足",
            },
            unsupported: "このシステムではリソースを報告しません",
            olderHappier: "古い Happier のため、リソースを報告しません。",
            olderHappierShort: "リソースのデータはまだありません",
            customize: "概要をカスタマイズ",
            appearanceSettings: "外観の設定",
            done: "完了",
            slowReason: "応答が遅れています",
            update: "更新",
            previewCalmName: "ラップトップ",
            previewLookName: "サーバー",
            rate: ({ value }) => `${value}/s`,
            exact: {
                cpu: ({ percent }) => `CPU ${percent}% 使用中`,
                memory: ({ free, used }) => `メモリ 空き ${free}、使用中 ${used}`,
                memoryFree: ({ free }) => `メモリ 空き ${free}`,
                disk: ({ free, total }) => `ディスク ${total} 中 ${free} 空き`,
                diskFree: ({ free }) => `ディスク 空き ${free}`,
                network: ({ down, up }) => `ネットワーク 下り ${down}、上り ${up}`,
            },
            unmeasured: ({ metric }) => `${metric} は未計測`,
            memoryFreeFact: ({ free }) => `空き ${free}`,
            askOwnerToUpdate: ({ owner }) => `${owner} さんに更新を依頼してください`,
            updateToSee: ({ machine }) => `${machine} を更新するとリソースが表示されます`,
        },
        machineVitals: {
            history: { mean: '平均', maximum: '最大' },
            unmeasured: "–",
            notReported: "このマシンからは報告されていません",
            live: "ライブ",
            checking: "確認中…",
            loading: "リソースを読み込み中",
            asOf: ({ time }) => `${time} 時点`,
            rate: ({ value, unit }) => `${value} ${unit}/秒`,
            ofTotal: ({ total }) => `/ ${total}`,
            range: {
                label: "履歴",
                hour: "1 時間",
                day: "24 時間",
                week: "7 日",
                hourAgo: "1 時間前",
                dayAgo: "24 時間前",
                weekAgo: "7 日前",
                now: "現在",
            },
            header: {
                coresMemory: ({ cores, memory }) => `${cores} コア · ${memory}`,
                upMinutes: ({ minutes }) => `稼働 ${minutes} 分`,
                upHours: ({ hours }) => `稼働 ${hours} 時間`,
                upHoursMinutes: ({ hours, minutes }) => `稼働 ${hours} 時間 ${minutes} 分`,
                upDays: ({ days }) => `稼働 ${days} 日`,
                upDaysHours: ({ days, hours }) => `稼働 ${days} 日 ${hours} 時間`,
            },
            cpu: {
                title: "CPU",
                chartLabel: "CPU 使用率",
                load: ({ load }) => `負荷 ${load}`,
                cores: ({ count }) => `${count} コア`,
                coresLimited: ({ count }) => `${count} コア · CPU 制限あり`,
                perCore: "コア別",
                perCoreLabel: "コア別の負荷",
                perCoreContainer: "このコンテナ内ではコア別の負荷は利用できません。",
                perCoreUnavailable: "このマシンはコア別の負荷を報告しません。",
                performanceCores: ({ count }) => `パフォーマンス ${count}`,
                efficiencyCores: ({ count }) => `効率 ${count}`,
                sockets: ({ count }) => `${count} ソケット`,
                coreLabel: ({ index, percent }) => `コア ${index}、${percent}`,
                coreLabelPerformance: ({ index, percent }) => `コア ${index}、パフォーマンス、${percent}`,
                coreLabelEfficiency: ({ index, percent }) => `コア ${index}、効率、${percent}`,
                user: ({ percent }) => `ユーザー ${percent}%`,
                system: ({ percent }) => `システム ${percent}%`,
                iowait: ({ percent }) => `I/O 待ち ${percent}%`,
                steal: ({ percent }) => `スティール ${percent}%`,
                loadAverages: ({ one, five, fifteen }) => `負荷 ${one} · ${five} · ${fifteen}`,
            },
            memory: {
                title: "メモリ",
                chartLabel: "メモリ使用量",
                inUse: "使用中",
                freeWord: "空き",
                inUseWord: "使用中",
                inUseAmount: ({ used }) => `使用中 ${used}`,
                freeAndInUse: ({ free, used }) => `空き ${free} · 使用中 ${used}`,
                freeOfTotal: ({ free, total }) => `${total} 中 ${free} 空き`,
                pressureLabel: ({ level }) => `メモリプレッシャー: ${level}`,
                levels: {
                    calm: "安定",
                    elevated: "高め",
                    critical: "危険",
                },
                source: {
                    kernel: "macOS が報告したプレッシャー",
                    estimated: "メモリの停滞とスワップから推定",
                    none: "Windows はメモリプレッシャーを報告しません",
                },
                heldMinutes: ({ minutes }) => `${minutes} 分間`,
                heldHours: ({ hours }) => `${hours} 時間`,
                heldHoursMinutes: ({ hours, minutes }) => `${hours} 時間 ${minutes} 分`,
                compositionLabel: "メモリの内訳",
                composition: {
                    apps: "アプリ",
                    wired: "ワイヤード",
                    compressed: "圧縮",
                    kernel: "カーネル",
                    system: "システム",
                    cachedFiles: "キャッシュされたファイル",
                },
                swap: "スワップ",
                pageFile: "ページファイル",
                swapLabel: ({ name, used, total }) => `${name}、${total} 中 ${used} 使用`,
                swapSwappingLabel: ({ name, used, total }) => `${name}、${total} 中 ${used} 使用、スワップ中`,
                noPressureNote: "Windows はメモリプレッシャーを報告しないため、使用中のメモリを表示しています。",
            },
            disk: {
                title: "ディスク",
                freeWord: "空き",
                freeOn: ({ volume }) => `${volume} の空き`,
                volumes: ({ count }) => `${count} ボリューム`,
                noNewFiles: ({ volume }) => `${volume} には新しいファイルを保存できません`,
                noNewFilesShort: "新しいファイルを保存できません",
                happierUses: ({ amount }) => `Happier の使用量 ${amount}`,
                happierUsesOn: ({ amount, volume }) => `Happier の使用量 ${volume} 中 ${amount}`,
                volumeLabel: ({ volume, free, total }) => `${volume}、${total} 中 ${free} 空き`,
                purgeable: ({ amount }) => `システムが自動で解放できる分がさらに ${amount}`,
            },
            network: {
                title: "ネットワーク",
                chartLabel: "ネットワーク、上がダウンロード、下がアップロード",
                down: "ダウンロード",
                up: "アップロード",
                perSecondUnit: ({ unit }) => `${unit}/秒`,
                today: ({ down, up }) => `本日 ダウンロード ${down}、アップロード ${up}`,
                interfaceRate: ({ name, down, up }) => `${name}: ダウンロード ${down}、アップロード ${up}`,
            },
            more: {
                title: ({ machine }) => `${machine} のその他の情報`,
                reported: "このマシンから報告",
                minutes: ({ minutes }) => `${minutes} 分`,
                hours: ({ hours }) => `${hours} 時間`,
                hoursMinutes: ({ hours, minutes }) => `${hours} 時間 ${minutes} 分`,
                battery: {
                    title: "バッテリー",
                    full: "満充電",
                    charging: "充電中",
                    chargingUntil: ({ duration }) => `充電中 · 満充電まで ${duration}`,
                    left: ({ duration }) => `バッテリー駆動 · 残り ${duration}`,
                    onBattery: "バッテリー駆動",
                },
                gpu: {
                    title: "GPU",
                    cores: ({ count }) => `${count} コア`,
                    memory: ({ used, total }) => `${total} 中 ${used}`,
                    several: ({ count, name }) => `${count} × ${name}`,
                    andMore: ({ name, count }) => `${name} ほか ${count} 台`,
                },
                thermal: {
                    title: "温度状態",
                    nominal: "正常",
                    fair: "やや高め",
                    serious: "深刻",
                    critical: "危険",
                    throttled: "冷却のため低速化中",
                    notThrottled: "制限なし",
                },
                temperature: {
                    title: "温度",
                    value: ({ degrees }) => `${degrees} °C`,
                    fans: ({ percent }) => `ファン ${percent}%`,
                },
                sharedMemory: {
                    title: "共有メモリ",
                    detail: ({ total }) => `${total} 中の空き · /dev/shm`,
                },
                limits: {
                    title: "上限",
                    entry: ({ name, used, max }) => `${name} ${max} 中 ${used}`,
                    unlimitedEntry: ({ name, used }) => `${name} ${used} · 上限なし`,
                    files: "開いているファイル",
                    ptys: "ターミナル",
                    processes: "プロセス",
                    inotify: "ファイル監視",
                },
            },
            states: {
                offlineEmpty: ({ machine }) => `${machine} は、Happier を開いてからリソースを報告していません。`,
                offlineTitle: ({ machine }) => `${machine} はオフラインです`,
                offlineLastReported: ({ machine }) => `これは最後に報告された内容です。戻るとセッションは再開します。それまで ${machine} のアラートは一時停止します。`,
                offlineNeverReported: 'Happier を開いてからリソースの報告がありません。戻るとセッションは再開します。',
                olderTitle: ({ machine }) => `${machine} の状況を見る`,
                olderReason: ({ machine }) => `CPU、メモリプレッシャー、ディスク、セッションの使用状況をライブで表示します。報告には ${machine} で Happier 0.3 が必要です。`,
                askOwner: ({ machine }) => `${machine} の更新を依頼するメモをコピー`,
                askOwnerMessage: ({ machine }) => `${machine} の Happier を更新していただけますか? リソースを表示するには Happier 0.3 が必要です。`,
                stoppedAt: ({ machine, time }) => `${machine} は ${time} に報告を停止しました`,
                unreadableTitle: ({ machine }) => `${machine} のリソースを読み取れません`,
                unreadableReason: "オンラインでセッションも実行中ですが、CPU、メモリ、ディスクを計測する Happier の部分が応答していません。",
                unreachableTitle: ({ machine }) => `${machine} が応答しませんでした`,
                unreachableReason: "オンラインと表示されていますが、リソースの要求に応答しませんでした。そこでのセッションは実行され続けます。",
                helperMissingTitle: ({ machine }) => `Happier は ${machine} のリソースを読み取れません`,
                helperMissingReason: "このマシンを計測する Happier の部分がここにインストールされていません。足りないものは診断で確認できます。",
                tryAgain: "再試行",
                openDoctor: "診断を開く",
            },
            usingTheMost: {
                title: "使用量の多いもの",
                byWhatStartedIt: "起動元ごと",
                processes: "プロセス",
                inProcesses: ({ count }) => `プロセスに ${count} 件`,
                reading: "実行中の内容を読み込み中…",
                unavailable: "実行中の内容を読み取れませんでした。プロセスを開いて再試行してください。",
                empty: ({ machine }) => `${machine} では Happier が起動したものは実行されていません。`,
                tableLabel: ({ machine }) => `${machine} で Happier が起動し、メモリを最も使っているもの`,
            },
            inbox: {
                aMachine: "マシン",
                shortOnMemory: ({ machine }) => `${machine} のメモリが不足しています`,
                memoryFor: ({ level, duration }) => `${level}が ${duration} 続いています`,
                memoryForSwap: ({ level, duration, used, total }) => `${level}が ${duration} 続いています · スワップ ${total} 中 ${used}`,
                memoryWasElevated: ({ duration }) => `メモリが ${duration} 高めでした`,
                memoryWasCritical: ({ duration }) => `メモリが ${duration} 危険な状態でした`,
                cpuBusy: ({ machine }) => `${machine} は長時間忙しい状態です`,
                cpuAveraged: ({ percent, duration }) => `CPU ${percent}% が ${duration} 続いています`,
                cpuWas: ({ duration }) => `CPU が ${duration} 忙しい状態でした`,
                calmAgain: ({ machine }) => `${machine} は落ち着きました`,
                diskFull: ({ machine, volume, percent }) => `${machine} · ${volume} が ${percent}% 埋まっています`,
                diskRoomAgain: ({ machine, volume }) => `${machine} · ${volume} に空きができました`,
                diskLeft: ({ free, total }) => `${total} 中 ${free} 空き`,
            },
            alerts: {
                title: "アラート",
                intro: ({ machine }) => `Happier は、${machine} が一定の状態にとどまったときに通知し、一時的に触れただけでは通知しません。回復したときにもう一度通知します。`,
                onDescription: "通知が有効なデバイスすべてでお知らせします。",
                saveFailed: "保存できませんでした。マシン側の現在の設定を表示しています。",
                for: "継続",
                custom: "カスタム…",
                sustainLabel: "継続時間",
                percent: ({ percent }) => `${percent}%`,
                names: {
                    memory: "メモリ",
                    disk: "ディスク",
                    cpu: "CPU",
                },
                durations: {
                    minutes: ({ minutes }) => `${minutes} 分`,
                    hours: ({ hours }) => `${hours} 時間`,
                    hoursMinutes: ({ hours, minutes }) => `${hours} 時間 ${minutes} 分`,
                    days: ({ days }) => `${days} 日`,
                },
                memory: {
                    title: "メモリ不足",
                    ruleCritical: ({ sustain }) => `メモリプレッシャーが ${sustain} 続いて危険な状態のとき`,
                    ruleElevated: ({ sustain }) => `メモリプレッシャーが ${sustain} 続いて高め以上のとき`,
                    whenCritical: ({ sustain }) => `プレッシャーが ${sustain} 続いて危険な状態になった`,
                    whenElevated: ({ sustain }) => `プレッシャーが ${sustain} 続いて高め以上になった`,
                    sentenceLead: "プレッシャーが続くとき:",
                    levelLabel: "プレッシャーレベル",
                },
                disk: {
                    title: "ディスクの空き容量がわずか",
                    rule: ({ threshold }) => `ボリュームの空きが ${threshold} 未満のとき`,
                    when: ({ threshold }) => `空きが ${threshold} 未満のボリュームがある`,
                    onDescription: "すべてのボリュームを確認します。",
                    sentenceLead: "ボリュームの空きが次の値未満のとき:",
                    sentenceTail: "空き",
                    thresholdLabel: "空きがこの値未満で警告",
                },
                cpu: {
                    title: "CPU の高負荷が長時間続く",
                    rule: ({ threshold, sustain }) => `CPU が ${threshold} を ${sustain} 超え続けたとき`,
                    when: ({ threshold, sustain }) => `CPU が ${threshold} を ${sustain} 超え続けている`,
                    sentenceLead: "CPU が次の値を超え続けたとき:",
                    thresholdLabel: "CPU がこの値超",
                },
                customSustain: {
                    title: "継続時間",
                    body: "1 週間 (10080) までの整数の分数。 単位を付けてください: ms、s、min、h、d。",
                    invalid: "1 から 10080 までの整数の分数を入力してください。 単位を付けてください: ms、s、min、h、d。",
                },
                customCpu: {
                    title: "CPU がこの値超",
                    body: "1 から 100 までのパーセント。",
                    invalid: "1 から 100 までのパーセントを入力してください。",
                },
                customDisk: {
                    title: "空きがこの値未満で警告",
                    body: "ボリュームに対する割合 (15%) または空き容量 (30 GB)。",
                    invalid: "0 から 100 までのパーセント、またはボリュームに収まる 30 GB のような容量を入力してください。",
                },
                row: {
                    off: ({ machine }) => `オフです。オンにすると、${machine} のメモリ、ディスク、CPU が不足したときにお知らせします。`,
                    onOne: ({ name, rule }) => `${name} でオン。${rule}ときにお知らせします。`,
                    onTwo: ({ first, second }) => `${first}と${second}でオン。`,
                    onThree: ({ first, second, third }) => `${first}、${second}、${third}でオン。`,
                    setByOwner: ({ machine }) => `${machine} のアラートは所有者が設定します。`,
                    unreadable: "現在アラート設定を読み取れません。",
                },
                readOnly: {
                    offline: ({ machine }) => `${machine} はオフラインです。アラートはオンラインに戻ってから変更できます。それまでは通知されません。`,
                    notCustodian: ({ machine }) => `${machine} のアラートは所有者が設定します。`,
                    olderHappier: ({ machine }) => `リソースの報告とアラートの送信には ${machine} で Happier 0.3 が必要です。`,
                },
                offline: {
                    title: "マシンがオフライン",
                    rule: ({ machine }) => `${machine} がオフラインになったら通知する`,
                    ownerOnly: ({ machine }) => `${machine} のオフラインアラートは所有者に届きます。`,
                },
                where: {
                    title: "アラートの送信先",
                    subtitle: "通知で設定",
                },
            },
        },
        machineStorage: {
            tab: "ストレージ",
            sized: ({ time }) => `${time} に計測`,
            sizing: "計測中…",
            sizeAgain: "もう一度計測",
            sizeAgainFailed: "再計測できませんでした",
            offlineAsOf: ({ time }) => `オフライン · ${time} 時点`,
            tryAgain: "再試行",
            sentence: {
                free: ({ free }) => `空き ${free}。`,
                uses: ({ happier, volume }) => `Happier は ${volume} のうち ${happier} を使用しています。`,
                usesAcross: ({ happier, count }) => `Happier は ${count} 台のディスクで ${happier} を使用しています。`,
                usesNoVolume: ({ happier }) => `Happier は ${happier} を使用しています。`,
                canGo: ({ amount }) => `そのうち約 ${amount} は削除できます。`,
                nothingCanGo: "今のところ、片付ける必要のあるものはありません。",
                trashReturns: ({ amount, date }) => `${date} にゴミ箱が空になると、さらに ${amount} が戻ります。`,
                trashReturnsLater: ({ amount }) => `ゴミ箱が空になると、さらに ${amount} が戻ります。`,
            },
            volumes: {
                purgeable: "システムが解放可能",
                label: "ディスク",
                systemDisk: "システムディスク",
                freeOf: ({ whole }) => `空き / ${whole}`,
                everythingElse: "その他すべて",
                happier: "Happier",
                free: "空き",
                inPile: "削除候補",
                inTrash: "ゴミ箱内",
                nothingOfHappier: "このディスクには Happier のデータはありません",
                afterCleanup: "クリーンアップ後:",
                afterCleanupFree: ({ free }) => `空き ${free}`,
                afterCleanupGain: ({ amount }) => `(+${amount})`,
                afterTrashEmpties: "ゴミ箱を空にした後:",
                barLabel: ({ volume, free, total }) => `${volume}: ${total} 中 ${free} 空き`,
            },
            breakdown: {
                title: ({ amount }) => `Happier の使用量 ${amount}`,
                accessory: "動作中に計測、スキャン不要",
                accessoryShort: "スキャン不要",
                canGo: "削除可能",
                alwaysKept: "常に保持",
                notFullyCounted: "まだ完全には集計されていません",
                empties: ({ date }) => `${date} に空になります`,
                ringLabel: ({ amount }) => `Happier の ${amount} の内訳`,
                ringAfter: ({ amount }) => `後: ${amount}`,
                theRest: "その他",
                recipientTitle: "あなたのファイル",
                recipient: ({ machine }) => `${machine} で Happier が保持しているものは、管理している人に表示されます。`,
            },
            categories: {
                worktrees: { title: "ワークツリー", short: "ワークツリー" },
                caches: { title: "プラグインとツールのキャッシュ", short: "キャッシュ" },
                modelPacks: { title: "モデルパック", short: "モデルパック" },
                sessionFolders: { title: "セッションフォルダ", short: "セッション" },
                logs: { title: "ログとツールトレース", short: "ログ" },
                agentHomes: { title: "エージェントのホーム", short: "エージェントのホーム" },
                temporary: { title: "一時ファイル", short: "一時" },
                recordings: { title: "録画", short: "録画" },
                trash: { title: "Happier のゴミ箱", short: "ゴミ箱" },
                ownData: { title: "Happier 自身のデータ", short: "自身のデータ" },
            },
            facts: {
                worktrees: ({ count, canGo }) => `ワークツリー ${count} 件${canGo > 0 ? ` · ${canGo} 件は削除できます` : ''}`,
                caches: ({ count, canGo }) => count > 0 && canGo === count ? `キャッシュ ${count} 件 · すべて再構築できます` : `キャッシュ ${count} 件${canGo > 0 ? ` · ${canGo} 件は再構築できます` : ''}`,
                modelPacks: ({ count, keep }) => `パック ${count} 件${keep > 0 ? ` · ${keep} 件は使用中` : ''}`,
                sessionFolders: ({ count, canGo }) => `セッション ${count.toLocaleString()} 件${canGo > 0 ? ` · ${canGo.toLocaleString()} 件は削除できます` : ''}`,
                logsKeptDays: ({ days }) => `${days} 日間保持`,
                logsKeptForever: "消去するまで保持",
                agentHomes: "設定とサインイン",
                temporaryUnused: "使用中のものはありません",
                temporaryInUse: ({ count }) => `${count} 件は使用中`,
                nothing: "ここには何もありません",
                recordings: ({ count }) => `録画 ${count} 件`,
                trash: ({ count }) => `${count} 件 · 空にすると容量が戻ります`,
                trashEmpty: "空",
                ownData: "状態、データベース、インデックス、キー",
            },
            page: {
                back: "ストレージ",
                lead: {
                    worktrees: ({ size, count }) => `ワークツリー ${count} 件で ${size}。`,
                    caches: ({ size }) => `キャッシュ ${size}。`,
                    modelPacks: ({ size, count }) => `モデルパック ${count} 件で ${size}。`,
                    sessionFolders: ({ size, count }) => `セッションフォルダ ${count.toLocaleString()} 件で ${size}。`,
                    logs: ({ size }) => `ログとツールトレース ${size}。`,
                    agentHomes: ({ size }) => `エージェントのホーム ${size}。`,
                    temporary: ({ size }) => `一時ファイル ${size}。`,
                    recordings: ({ size, count }) => `録画 ${count} 件で ${size}。`,
                    trash: ({ size }) => `ゴミ箱に ${size}。`,
                    ownData: ({ size }) => `Happier 自身のデータ ${size}。`,
                },
                about: {
                    worktrees: "変更、未プッシュのコミット、実行中のセッションがあるワークツリーは残ります。",
                    caches: "ツールが必要になったときに、すべて再ダウンロードまたは再構築します。",
                    modelPacks: "使用中のパックは残ります。未使用のものは、機能が必要としたときに再ダウンロードされます。",
                    sessionFolders: "文字起こしは常に残ります。",
                    logsKeptDays: ({ days }) => `${days} 日間保持されます。`,
                    logsKeptForever: "消去するまで保持されます。",
                    agentHomes: "エージェントの設定とサインイン。削除しない限り残ります。",
                    temporary: "Happier は再起動時にもこれらを自動で消去します。",
                    recordings: "セッションで作成されたブラウザの録画。",
                    trashOn: ({ date }) => `${date} に空になり、そのとき容量が戻ります。それまでは、すべて元の場所に戻せます。`,
                    trashNever: "空にしたときに空になり、そのとき容量が戻ります。それまでは、すべて元の場所に戻せます。",
                    trashAfter: ({ days }) => `移動してから ${days} 日後にそれぞれ空になり、そのとき容量が戻ります。それまでは、すべて元の場所に戻せます。`,
                    ownData: "Happier の状態、データベース、インデックス、キー。常に保持されます。",
                },
                canGo: ({ amount }) => `${amount} を削除できます。`,
                empty: "今のところ何もありません。",
                loading: "内容を一覧表示中…",
                error: "内容を一覧表示できませんでした。",
                more: "さらに表示",
                used: ({ when }) => `${when} に使用`,
                changed: ({ when }) => `${when} に変更`,
                itemLabel: ({ title, size, verdict }) => `${title}、${size}、${verdict}`,
                frees: ({ amount }) => `${amount} を解放`,
                putBack: "元に戻す",
                groups: {
                    stopped: ({ days }) => `${days} 日以上前に停止`,
                    stoppedAny: '停止済み',
                    recent: '最近または実行中',
                    old: ({ days }) => `${days} 日より前`,
                    oldAny: '古いもの',
                    other: 'その他',
                },
            },
            verdicts: {
                safe: "安全",
                canDelete: "削除可能",
                caution: "注意",
                keep: "保持",
                forbidden: "禁止",
                check: "要確認",
                alwaysKept: "常に保持",
            },
            reasons: {
                main_checkout: "メインのチェックアウト",
                in_use: "使用中",
                changed_files: "変更されたファイルあり",
                unpushed_commits: "未プッシュのコミットあり",
                unsaved_edits: "未保存の編集あり",
                open_pr: "オープンなプルリクエストあり",
                recent: "最近のもの",
                always_kept: "常に保持",
                merged_clean: "マージ済み、変更なし",
                branch_gone: "ブランチなし",
                clean_pushed: "変更なし、プッシュ済み",
                rebuilds: "再構築される",
                reinstalls: "再インストールされる",
                downloads_again: "再ダウンロードされる",
                stopped: "停止中",
                old: "古い",
                attachments_go: "添付ファイルも消える",
                feature_waits: "機能が待っている",
                not_rebuildable: "再構築できない",
                personal_folder: "個人フォルダ",
                agent_home: "エージェントのホーム",
                credentials: "認証情報",
                user_protected: "保護を設定済み",
                contains: "保持されるものを含む",
                root: "ディスクのルート",
                system: "システムの場所",
                home_folder: "ホームフォルダ",
                happier_install: "Happier のインストール",
                happier_data: "Happier のデータ",
                contains_forbidden: "システムの場所を含む",
                facts_unavailable: "未確認",
                changed_since_review: "確認後に変更された",
                missing: "すでに存在しない",
                trash_unavailable: "このディスクにはゴミ箱がない",
                destination_occupied: "元の場所に別のものがある",
                parent_missing: "元のフォルダがない",
                unauthorized: "変更する権限がない",
                operation_failed: "失敗した",
                unsupported: "ここでは未対応",
                has_submodules: "サブモジュールあり",
            },
            evidence: {
                directory_permission_unavailable: "フォルダーにアクセスできません",
                managed_acp_install: "管理対象のエージェントのインストール",
                runner_snapshot_root: "セッション実行環境のスナップショット",
                managed_cache_root: "管理対象のキャッシュフォルダー",
                connected_service_home: "接続済みサービスのホーム",
                execution_run_isolation_owner: "分離された実行フォルダー",
                execution_run_isolation_facts_unavailable: "実行の詳細を取得できません",
                happier_temporary_directory: "Happier の一時フォルダー",
                temporary_lifecycle_owner: "一時フォルダーの所有元を確認済み",
                temporary_lifecycle_facts_unavailable: "一時フォルダーの詳細を取得できません",
                voice_model_pack_install_record: "インストール済みの音声モデルパック",
                model_pack_facts_unavailable: "モデルパックの詳細を取得できません",
                browser_recording_owner: "ブラウザー録画の所有元を確認済み",
                recording_expired: "録画の保存期限が切れています",
                happier_trash_root: "Happier のゴミ箱フォルダー",
                happier_data_remainder: "その他の Happier データ",
                managed_session_directory_record: "管理対象のセッションフォルダー",
                managed_session_directory_record_unavailable: "セッションフォルダーの詳細を取得できません",
                session_workspace_upload: "セッションのワークスペースへのアップロード",
                worktree_parent: "ワークツリーが含まれています",
                registration_unavailable: "ワークツリーの登録情報を取得できません",
                scm_orphan_back_reference: "ワークツリーの作業コピーが見つかりません",
                scm_registered_worktree: "登録済みのワークツリー",
                nested_worktree_kept: "保持するワークツリーが含まれています",
                nested_worktrees_children_first: "入れ子のワークツリーから先に削除してください",
                log_file_modified_time: "ログの更新日時を確認済み",
                trusted_disk_index: "ディスクスキャンによる測定",
                scm_ignored: "バージョン管理の対象外",
                browser_profile_cache: "ブラウザープロファイルのキャッシュ",
                unused_after_policy: "設定した期間を超えて未使用",
                repository_not_in_use: "リポジトリは使用されていません",
                verified_cache_location: "キャッシュの場所を確認済み",
                empty_folder_relisted: "空のフォルダーであることを確認済み",
                trash_entry: "Happier のゴミ箱に移動済み",
                unknown: "追加の詳細はありません",
                recognizer: "確認済みのクリーンアップ候補",
                manifest: "プロジェクトのマニフェストが見つかりました",
            },
            ownerLimitations: {
                mainCheckout: "メインのチェックアウトには共有の Git データが含まれています。代わりにそのワークツリーを選択してください。",
                wholeItem: ({ category }) => `${category}：項目全体を選択してください。管理するコンポーネントは一部だけを削除できません。`,
            },
            states: {
                loading: "Happier のフォルダを計測中",
                notReported: ({ machine }) => `${machine} のストレージを表示するには、より新しい Happier が必要です。`,
                error: ({ machine }) => `${machine} のストレージを読み取れませんでした。`,
                offlineTitle: ({ machine }) => `${machine} はオフラインです`,
                offlineReason: '復帰するとストレージがここに表示されます。',
            },
            tidy: {
                title: "整理を保つ",
                weeklyReview: { title: "毎週月曜日にストレージを確認", subtitle: "ゴミ箱への移動を提案する週次オートメーションの下書きを作成します。" },
                description: "オンにするまで、ここにあるものは自動でスキャンも消去もされません。",
                readOnlyOffline: ({ machine }) => `${machine} はオフラインです。最後に確認された設定を表示しています。復帰すると変更できます。`,
                readOnlyNotCustodian: ({ machine }) => `これらは ${machine} を管理している人が設定します。`,
                saveFailed: "保存できませんでした。マシン側の設定を表示しています。",
                scan: {
                    title: "ディスク全体を定期的にスキャン",
                    off: "オフ。Happier は動作中に自身のフォルダを計測します。ディスクのそれ以外の部分は、依頼したときだけ読み取ります。",
                    on: ({ machine }) => `変更されたフォルダだけを、${machine} が電源に接続されている間だけ読み取ります。スキャンで何かが消去されることはありません。`,
                    every: "毎",
                    at: "時刻",
                    weekdayLabel: "曜日",
                    timeLabel: "時刻",
                    customTime: { title: "スキャン時刻", body: "03:00 や 21:30 のような時刻。", invalid: "00:00 から 23:59 の間の時刻を入力してください。" },
                },
                disk: {
                    title: "ディスクの空きが少なくなったら知らせる",
                    off: "オフ。概要 → アラートと同じアラートです。",
                    on: "概要 → アラートと同じアラートです。",
                    lead: "ディスクの空きが",
                    tail: "未満のとき",
                },
                logs: {
                    title: "ログとツールトレースを保持",
                    subtitle: "古いものは Happier の起動時に消去されます。",
                    label: "ログの保持期間",
                    forever: "無期限",
                    customTitle: "ログの保持期間",
                },
                trash: {
                    title: "Happier のゴミ箱を空にする",
                    subtitle: "消去したものはそこで待機し、その後容量が戻ります。",
                    label: "ゴミ箱を空にする",
                    after: ({ days }) => `${days} 日後`,
                    never: "しない",
                    customTitle: "ゴミ箱を空にするまでの日数",
                },
                suggest: {
                    title: "未使用の項目を提案するまでの期間",
                    subtitle: "停止したセッションや未使用のパックは、これだけ長く触れられていないと提案されます。",
                    label: "未使用の項目を提案するまでの期間",
                    customTitle: "未使用の項目を提案するまでの期間",
                },
                days: ({ days }) => `${days} 日`,
                customDays: { body: "1 以上の整数の日数。 単位を付けてください: ms、s、min、h、d。", invalid: "1 以上の整数の日数を入力してください。 単位を付けてください: ms、s、min、h、d。" },
            },
            scope: {
                label: "表示する範囲",
                happier: "Happier のみ",
                disk: "ディスク全体",
            },
            pile: {
                items: ({ count }) => `${count} 件`,
                frees: ({ amount }) => `${amount} を解放`,
                checking: ({ count }) => `${count} 件を再確認中`,
                checkingNote: "追加してから何も変わっていないことを確認しています。",
                inTrash: ({ count }) => `ゴミ箱に ${count} 件`,
                freed: ({ amount }) => `${amount} を解放しました`,
                goneForGood: ({ count }) => `${count} 件を完全に削除しました`,
                readyNote: "まだ何も削除されません。",
                readyNoteDisk: "見て回っている間も削除候補はそのまま残ります。",
                heldNote: "ゴミ箱を空にすると容量が戻ります。",
                heldNoteOn: ({ date }) => `${date} にゴミ箱が空になると容量が戻ります。`,
                skippedNote: ({ count }) => `${count} 件は変更されたか残されたため、触れていません。ゴミ箱を空にすると容量が戻ります。`,
                skippedNoteOn: ({ count, date }) => `${count} 件は変更されたか残されたため、触れていません。${date} にゴミ箱が空になると容量が戻ります。`,
                dropped: ({ count }) => `${count} 件が削除候補から外れました: 新しいスキャンに含まれなくなりました。`,
                clear: "クリア",
                review: ({ count }) => `${count} 件を確認`,
                emptyNow: "今すぐ空にする",
                undo: "取り消す",
                undoLastMove: "最後の移動を元に戻す",
                done: "完了",
                collectLabel: ({ title }) => `${title} を削除候補に追加`,
                collectFailedTitle: "削除候補を変更できませんでした",
                collectFailed: "マシンがその変更を受け付けませんでした。削除候補にはマシン上の内容が表示されています。",
            },
            emptyConfirm: {
                title: ({ count }) => `ゴミ箱の ${count} 件を削除しますか？`,
                body: ({ amount }) => `${amount} がすぐに戻ります。この操作は取り消せません。`,
                confirm: "今すぐ空にする",
            },
            keep: {
                title: ({ name }) => `${name} を整理しますか？`,
                confirm: "それでも追加",
                confirmInUse: "使用中と承知のうえで追加",
                cancel: "残す",
            },
            loses: {
                main_checkout: (_params: { count: number }) => "これはリポジトリの元のフォルダです。",
                in_use: (_params: { count: number }) => "現在この中で作業が行われています。その作業はフォルダを失います。",
                changed_files: ({ count }) => count > 0 ? `変更のあるファイル ${count} 件が失われます。` : '変更のあるファイルが失われます。',
                unpushed_commits: ({ count }) => count > 0 ? `プッシュされていないコミット ${count} 件が失われます。` : 'プッシュされていないコミットが失われます。',
                unsaved_edits: (_params: { count: number }) => "ここにはセッションの未保存の編集があります。",
                open_pr: (_params: { count: number }) => "プルリクエストがまだ開いています。",
                attachments_go: (_params: { count: number }) => "セッションの添付ファイルは削除されます。トランスクリプトは残ります。",
                feature_waits: (_params: { count: number }) => "これを使う機能は、再ダウンロードされるまで待機します。",
                not_rebuildable: (_params: { count: number }) => "再構築できません。",
                personal_folder: (_params: { count: number }) => "あなたの個人フォルダの一つです。",
                agent_home: (_params: { count: number }) => "エージェントの設定とサインインも一緒に失われます。",
                credentials: (_params: { count: number }) => "鍵やパスワードが含まれています。",
                user_protected: (_params: { count: number }) => "あなたがこのフォルダを保護しました。",
                contains: (_params: { count: number }) => "Happier が保持するものが含まれています。",
                other: ({ reason }) => `保持する理由: ${reason}。`,
            },
            review: {
                title: ({ count }) => `${count} 件を確認`,
                titleGoing: ({ going, checked }) => `${checked} 件中 ${going} 件を確認`,
                subtitle: ({ machine }) => `${machine} 上 · すべての項目をたった今再確認しました`,
                checkFailed: "マシン上で削除候補を確認できませんでした。",
                going: ({ count }) => `削除 · ${count}`,
                goingAccessory: "サイズは各項目で解放される容量です",
                countedOnce: ({ count, amount }) => count > 0 ? `重複を除いて集計: ${count} 件はこの削除候補内の別の項目に含まれています。` : `重複を除いて集計: ${amount} はこの削除候補内の項目で共有されています。`,
                staying: ({ count }) => `そのまま残す · ${count}`,
                stayingAccessory: "たった今再確認しました",
                withoutTrash: ({ count }) => `${count} 件は Happier のゴミ箱がないディスク上にあるため、「今すぐ削除」でしか取り除けません。`,
                noTrashHere: "このディスクには Happier のゴミ箱がありません: 「今すぐ削除」でしか取り除けません。",
                whereLabel: "移動先",
                trash: "ゴミ箱",
                deleteNow: "今すぐ削除",
                whereTrash: "Happier のゴミ箱に移動",
                whereTrashOn: ({ volume }) => `${volume} の Happier のゴミ箱に移動`,
                whereTrashNote: ({ days }) => `${days} 日間保持されるので、いつでも元に戻せます。空にすると容量が戻ります。`,
                whereTrashNever: "空にするまで保持されるので、いつでも元に戻せます。空にすると容量が戻ります。",
                whereTrashFull: ({ volume, date }) => `${date} にゴミ箱が空になるか、あなたが空にするまで、${volume} はほぼ満杯のままです。`,
                whereTrashFullRebuild: ({ volume, date }) => `${date} にゴミ箱が空になるか、あなたが空にするまで、${volume} はほぼ満杯のままです。これらはすべて再構築できるので、今すぐ削除しても安全です。`,
                whenItEmpties: "空になったとき",
                whereDelete: "今すぐ削除",
                whereDeleteNote: "すぐに容量を解放します。取り消せません。",
                frees: "解放",
                moveToTrash: ({ count }) => `${count} 件をゴミ箱に移動`,
                deleteForGood: ({ count }) => `${count} 件を削除 · 取り消せません`,
                applying: ({ count }) => `${count} 件を確認中…`,
                applyFailed: "結果を確認できませんでした。再試行する前に、対象の項目とゴミ箱を確認してください。",
                approvalRequested: "承認を依頼しました: 承認されると実行されます。まだ何も削除されていません。",
                stopAndRemove: ({ count }) => count === 1 ? 'セッションを停止して削除' : `${count} 件のセッションを停止して削除`,
                stopFailed: ({ count }) => `${count === 1 ? 'セッション' : 'いずれかのセッション'}が停止しなかったため、何も削除されていません。`,
                rowLabel: ({ name, amount, verdict }) => `${name}、${amount} を解放、${verdict}`,
            },
            result: {
                title: "たった今",
                meta: ({ acted, skipped, mode }) => `${acted} 件を${mode === 'delete' ? '削除' : '移動'} · ${skipped} 件はそのまま`,
                skipped: ({ name }) => `${name} をスキップしました`,
                refused: ({ name }) => `${name} は拒否されました`,
                failed: ({ name }) => `${name} を整理できませんでした`,
            },
            worktrees: {
                lead: ({ size, count }) => `${count} 個のワークツリーに ${size}。`,
                about: ({ count }) => `${count} 個を削除できます。それぞれに残す理由や削除できる理由が表示されます。`,
                find: "ワークツリーまたはブランチを検索",
                filterLabel: "表示",
                filters: { all: "すべて", canDelete: "削除可能", keep: "保持" },
                sortLabel: "並べ替え",
                sort: { size: "大きい順", used: "使用が古い順", name: "名前" },
                groupMeta: ({ count, size }) => `${count} 個のワークツリー · ${size}`,
                collectGroup: ({ name }) => `${name} の削除できるものを削除候補に追加`,
                collectAll: ({ count }) => `削除できる ${count} 個をすべて追加`,
                checkNow: "今すぐ確認",
                more: ({ count, name }) => `${name} にあと ${count} 個`,
                showAll: "すべて表示",
                none: "一致するワークツリーはありません。",
            },
            suggestions: {
                title: "提案",
                lead: ({ amount }) => `${amount} を簡単に取り戻せます。`,
                about: ({ count }) => `Happier が確認した ${count} 件。どれも再構築できるか、数週間触れられていません。`,
                groups: { rebuilt: "再構築可能", unused: "古くて未使用", outside: "Happier 以外" },
                groupMeta: ({ count, size }) => `${count} · ${size}`,
                fromScan: "ディスク全体のスキャンから",
                collectAll: ({ count }) => `${count} 件をすべて追加`,
                hint: ({ machine }) => `提案は Happier が ${machine} 上で確認した後にのみ表示されます。確定時にもう一度確認されます。`,
                none: "現在提案はありません。",
                easy: "簡単に取り戻せる",
                easyMeta: ({ amount }) => `${amount} · すべて確認済み`,
                all: "すべての提案",
            },
            invite: {
                title: ({ machine }) => `${machine} のその他すべて`,
                body: ({ amount }) => `Happier 以外の ${amount}。ディスクをスキャンして、大きいもの、古いもの、忘れられたものを確認しましょう。Happier が読むのは名前とサイズだけで、ファイルの中身は読みません。`,
                scanWholeDisk: "ディスク全体をスキャン",
            },
            nothing: {
                lead: "すっきりしています。",
                sentence: ({ happier, machine }) => `Happier は ${machine} で ${happier} を使用しており、すべて使用中です。`,
                title: "整理するものはありません",
                body: "削除できるものがあれば、サイズと一緒にここに表示されます。",
            },
            lowDisk: {
                lead: ({ amount, volume }) => `Happier は ${volume} の ${amount} を空けられます。`,
                about: ({ from, to }) => `使用中のものには触れずに、使用率が ${from}% から ${to}% になります。`,
                title: ({ amount }) => `最も手早い ${amount}`,
                description: ({ count, machine }) => `Happier が ${machine} 上で確認し、削除候補に入れた ${count} 件。残したいものはチェックを外してください。`,
                none: ({ volume }) => `現在 ${volume} には安全に整理できるものはありません。`,
                pileNote: ({ volume }) => `これらは ${volume} の Happier のゴミ箱に移動するので、空にすると容量が戻ります。確認画面では「今すぐ削除」も選べます。`,
            },
            protectedFolders: {
                title: "保護されたフォルダ",
                row: ({ count }) => count > 0 ? `書類、デスクトップ、ピクチャ、すべてのメインチェックアウト、あなたが追加した ${count} 個。自動で提案や整理はされません。` : '書類、デスクトップ、ピクチャ、すべてのメインチェックアウト。自動で提案や整理はされません。',
                lead: ({ machine }) => `${machine} で自動的に削除候補に入ることのないフォルダです。手動で整理する場合は、まず何が失われるかが表示されます。`,
                builtInTitle: "常に保持",
                builtInDescription: "誰が依頼しても、Happier がこれらを提案したり自動で整理したりすることはありません。",
                builtIn: {
                    personal: { title: "書類、デスクトップ、ピクチャ", subtitle: "あなたの個人フォルダ" },
                    checkouts: { title: "メインチェックアウト", subtitle: "各リポジトリの元のフォルダ" },
                    inUse: { title: "使用中のもの", subtitle: "セッション、ターミナル、サービスが現在作業しているフォルダ" },
                    agentHomes: { title: "エージェントのホーム", subtitle: "エージェントの設定とサインイン" },
                },
                addedTitle: "あなたが追加",
                add: "フォルダを追加",
                addTitle: "フォルダを保護",
                added: ({ date }) => `${date} に追加`,
                remove: "削除",
                none: "まだありません。",
                forbiddenNote: "各ディスクの最上位、システムフォルダ、ホームフォルダ、Happier 自身のデータは、誰であっても整理されることはありません。",
            },
            disk: {
                customSize: { body: "ゼロより大きいサイズを指定できます。B、KB、MB、GB、TB、PBを使用してください。数字のみの場合はバイト数になります。", invalid: "250 MBや1 Bなど、ゼロより大きいサイズを入力してください。" },
                olderThanDaysValue: ({ days }: { days: number }) => `${days}日より古い`,
                neverTitle: ({ volume }) => `${volume} のすべてを見る`,
                neverBody: ({ happier, machine }) => `Happier は自分の ${happier} をすでに把握しています。ディスクをスキャンして、ほかに大きいもの、古いもの、忘れられたものを見つけましょう。${machine} 上の名前とサイズだけを読み、ファイルの中身は読みません。`,
                neverHint: "ほかのディスクは個別にスキャンされます。クラウドにのみあるファイルはここで容量を使わないため、スキップされます。",
                scanVolume: ({ volume }) => `${volume} をスキャン`,
                chooseFolder: "フォルダを選択…",
                shortcutsTitle: "または1つのフォルダをスキャン",
                shortcutsNote: "ホーム、ダウンロード、キャッシュ、既知のプロジェクトフォルダ。",
                shortcutDownloads: "ダウンロード",
                shortcutCache: "キャッシュ",
                apfsLocalSnapshots: ({ count }) => `ローカル APFS スナップショット ${count} 個 · macOS が管理`,
                shortcutHome: "ホーム",
                scanFolder: ({ folder }) => `${folder} をスキャン`,
                chooseFolderTitle: "フォルダをスキャン",
                starting: "スキャンを開始しています…",
                holds: ({ volume, used }) => `${volume} には ${used} あります。`,
                grewSince: ({ amount, date }) => `${date} の前回のスキャンから ${amount} 変化しました。`,
                scanningSentence: ({ volume, sized, used }) => `${volume} をスキャン中。${used} のうち ${sized} を計測しました。`,
                scanningSentenceOpen: ({ volume, sized }) => `${volume} をスキャン中。ここまでに ${sized} を計測しました。`,
                stoppedSentence: "ディスク全体のスキャンが完了しませんでした。",
                unreadableSentence: ({ count, volume }) => `${volume} の ${count} 個のフォルダを開けませんでした。`,
                stoppedTitle: ({ percent }) => `スキャンは ${percent}% で止まりました`,
                stoppedTitleOpen: "スキャンは止まりました",
                stoppedBody: ({ sized }) => `計測済みの ${sized} は保持されるので、再開すると止まったところから続きます。`,
                resume: "スキャンを再開",
                progressMeta: ({ sized, used, items }) => `${used} のうち ${sized} · ${items} 項目`,
                progressMetaOpen: ({ sized, items }) => `ここまで ${sized} · ${items} 項目`,
                progressLabel: "スキャンの進行状況",
                reading: "読み取り中",
                stuck: "停止中",
                skip: "このフォルダをスキップ",
                leavePage: ({ machine }) => `このページを離れても大丈夫です。スキャンは ${machine} 上で続きます。`,
                privateTitle: ({ count }) => `${count} 個のフォルダは非公開です`,
                privateBody: "ディスクの合計には含まれますが、Happier は中を見られません。これらを含むサイズには「以上」と表示されます。",
                fullDiskAccess: ({ machine, binary }) => `${machine} で: システム設定 → プライバシーとセキュリティ → フルディスクアクセス → ${binary} をオンにして、もう一度確認してください。`,
                recheck: "もう一度確認",
                scanned: ({ time }) => `${time} にスキャン`,
                scannedOffline: ({ time }) => `オフライン · ${time} にスキャン`,
                scanAgain: "もう一度スキャン",
                filesLabel: "表示",
                files: { folders: "フォルダ", large: "大きいファイル", old: "古いファイル" },
                shapeLabel: "表示形式",
                shape: { list: "リスト", map: "マップ", rings: "リング" },
                largerThan: "これより大きい",
                largerThanValue: ({ size }) => `${size} より大きい`,
                olderThan: "これより古い",
                olderThanValue: ({ months }) => `${months} か月より古い`,
                pathLabel: "フォルダ",
                levelMeta: ({ size, count }) => `${size} · ${count} 項目`,
                volumeMeta: ({ used, total }) => `${total} のうち ${used} 使用`,
                mapLabel: ({ folder }) => `${folder} のマップ: 各長方形はフォルダで、使用容量に応じた大きさです。下のリストにも同じ項目があります。`,
                ringsLabel: ({ folder }) => `${folder} のリング: 中心がこのフォルダで、外側のリングほど一段深い階層です。下のリストにも同じ項目があります。`,
                smaller: ({ count }) => `小さい項目 ${count} 件`,
                share: ({ percent, folder }) => `${folder} の ${percent}%`,
                chartKeys: "クリックで開く · スペースで削除候補に追加",
                keyArea: "面積はディスク上のサイズ",
                keyArc: "弧はディスク上のサイズ",
                keyHappier: "Happier のもの",
                keyPile: "削除候補",
                keySmaller: "小さい項目（まとめて表示）",
                columns: { name: "名前", size: "サイズ", since: ({ date }) => `${date} 以降` },
                noChange: "変化なし",
                ageGroups: { recent: "3か月未満",  year: "1 年以上前", months6: "6～12 か月", months3: "3～6 か月", unknown: "時期不明" },
                anotherDisk: "別のディスク",
                itemsCount: ({ count }) => `${count.toLocaleString()} 項目`,
                smallItems: ({ count }) => `${count.toLocaleString()} 個の小さな項目`,
                atLeast: "少なくともこの量",
                inUse: "使用中",
                marks: {
                    protected: "保護されたフォルダ · 中を見ることはできます",
                    mount: "ここにマウントされた別のディスク。その容量は専用のバーで数えられます。",
                    small: "このフォルダ内の小さいファイル（まとめて表示）",
                    hidden: "隠しファイルとシステムの容量",
                    reserved: "システム用に予約済み",
                    cloud: "クラウドにあり、ここではほとんど容量を使いません",
                    happier: "Happier 自身のデータ · Happier ビューで管理",
                },
                rowLabel: ({ name, size, detail }) => `${name}、${size}、${detail}`,
                listLabel: ({ machine }) => `${machine} のフォルダ`,
                emptyLevel: "ここには何もありません。",
            },
        },
        machineGuard: {
            tools: {
                title: "エージェントのツール",
                idleTitle: "アイドル状態のブラウザツールを閉じるまで",
                idleHelp: "新しいセッションに適用されます。環境やプロジェクトのツール設定が優先されます。",
                browserTitle: "エージェントブラウザの同時実行数",
                browserHelp: "自動ではマシンのメモリに応じて設定されます。カスタム上限は次のブラウザ起動から適用されます。",
                automatic: "自動",
                milliseconds: ({ milliseconds }) => `${milliseconds} ms`,
                customIdle: {
                    title: "アイドル状態のツールを閉じる",
                    body: "ミリ秒、秒、分、時間で入力してください。最短は1秒です。 単位を付けてください: ms、s、min、h、d。",
                    invalid: "1秒以上の時間を入力してください。 単位を付けてください: ms、s、min、h、d。",
                },
                customBrowsers: {
                    title: "ブラウザの同時実行数",
                    body: "ブラウザ数を正の整数で入力してください。",
                    invalid: "正の整数を入力してください。",
                },
            },
            tab: "ガード",
            intro: ({ machine }) => `${machine} で Happier が自動で停止してよいもの。停止するのは Happier 自身が開始した、使われていないものだけです。事前にお知らせし、すべての操作を元に戻す手段とともに一覧します。`,
            unavailable: "利用不可",
            on: "オン",
            off: "オフ",
            custom: "カスタム…",
            saveFailed: ({ machine }) => `保存できませんでした: ${machine} が応答しませんでした。何も変更されていません。`,
            tryAgain: "再試行",
            awaitingMachine: ({ machine }) => `保存しました。${machine} にはまだ反映されていません。`,
            neverTouched: "決して触れないもの: 作業中またはあなたの返答待ちのセッション、通常のターミナル、Happier のものではないすべて。",
            states: {
                loading: "ガードを読み込み中",
                offlineTitle: ({ machine }) => `${machine} はオフラインです`,
                offlineBody: ({ time }) => `これは ${time} 時点のガード設定です。復帰したら変更できます。オフラインの間は何も停止されません。`,
                offlineReason: '復帰するとここにガードが表示されます。',
                lastKnown: "最後に確認された",
                error: ({ machine }) => `${machine} のガードを読み取れませんでした。`,
                olderTitle: ({ machine }) => `${machine} に自分で管理させる`,
                olderBody: ({ machine }) => `使われていないセッションを停止し、メモリが足りないときに解放し、セッションが残したものを片付けます。これには ${machine} で Happier 0.3 が必要です。`,
                recipient: ({ machine }) => `${machine} をどう守るかは、管理している人が決めます。ルールは確認できます。あなたのセッションはそれに従います。`,
                othersWork: ({ count }) => `ほかの人のセッションがここにさらに ${count} 件あります。`,
            },
            memory: {
                title: "メモリガード",
                description: ({ machine }) => `${machine} のメモリ不足が続くと、Happier は一度に 1 ステップずつ解放し、効果を確認してから次に進みます。`,
                switchTitle: ({ machine }) => `${machine} のメモリが足りないときに解放する`,
                off: "オフ。メモリを理由に何も停止されません。",
                watching: ({ level, sustain }) => `監視中。プレッシャーが ${sustain} のあいだ${level}の状態が続くと動作します。`,
                onUnread: ({ level, sustain }) => `オン。圧迫が ${sustain} ${level} のままなら動作します。`,
                acting: ({ step }) => `メモリを解放中。ステップ ${step} / 3。`,
                sustaining: ({ sustain }) => `メモリが不足しています。${sustain} 続くと Happier が動作します。`,
                outOfSteps: "まだメモリが不足しています。安全に停止できるものは残っていません。",
                paused: ({ time }) => `${time} まで一時停止中。それまでメモリを理由に何も停止されません。`,
                pauseHour: "1 時間一時停止",
                resumeNow: "今すぐ再開",
                noPressure: ({ machine }) => `${machine} はメモリプレッシャーを報告しないため、Happier はキャッシュが満杯なだけなのか本当に不足しているのかを区別できません。使われていないセッション、残ったものの片付け、スリープ防止は通常どおり動作します。`,
                samplerUnavailable: ({ machine }) => `現在 ${machine} のメモリプレッシャーを読み取れません。使われていないセッション、残ったものの片付け、スリープ防止は通常どおり動作します。`,
                levelTitle: "メモリプレッシャーが次のとき動作する",
                levelElevated: "高め",
                levelCritical: "危険",
                levelElevatedHelp: "高め: メモリが逼迫し始め、システムが圧縮を始めています。",
                levelCriticalHelp: "危険: システムが圧縮とスワップを行い、すべてが遅くなります。",
                levelWordElevated: "高め",
                levelWordCritical: "危険",
                sustainTitle: "その状態が続く時間",
                sustainHelp: "ビルド中の一時的なスパイクでは動作しません。",
                cooldownTitle: "ステップ間の待機時間",
                cooldownHelp: "各ステップのあと、Happier はこの時間待ってメモリが減ったかを確認します。",
                customMinutes: { title: "時間", body: "1 以上の整数の分数。例: 3 min、1.5 h。 単位を付けてください: ms、s、min、h、d。", invalid: "1 以上の整数の分数を入力してください。 単位を付けてください: ms、s、min、h、d。" },
            },
            ladder: {
                label: "メモリガードの動作内容",
                previewOff: ({ machine }) => `オンで、今 ${machine} のメモリが不足した場合、Happier は次のようにします:`,
                preview: ({ machine }) => `今 ${machine} のメモリが不足した場合、Happier は次のようにします:`,
                acting: ({ machine, level, since }) => `${machine} のメモリプレッシャーは ${since} のあいだ${level}の状態です。Happier は一覧を順に進めています:`,
                outOfSteps: ({ machine }) => `${machine} のメモリ不足は解消しませんでした。Happier は安全にできることを行いました:`,
                browsers: { title: "使われていないブラウザを閉じる", help: "どのセッションも使っていないブラウザのサイドカー。エージェントが必要としたときに再び開きます。", empty: "開いていて使われていないブラウザはありません。" },
                devServers: { title: "誰も使っていない開発サーバーを停止する", help: "大きいものから順に 1 つずつ、そのたびにメモリを確認します。", empty: "使われていない開発サーバーはありません。" },
                idleSessions: { title: "再開できる使われていないセッションを停止する", help: "完了したセッションのみ。次のメッセージで再び起動します。", empty: "ここには使われていない完了済みセッションはありません。" },
                freesAbout: ({ amount }) => `約 ${amount} を解放`,
                nothingEligible: "対象なし",
                checking: "メモリが減ったか確認中",
                done: "完了",
                stepLabel: ({ step, title }) => `ステップ ${step}: ${title}`,
                summaryLead: "これは最大で",
                summaryOf: ({ inUse }) => `です（使用中の ${inUse} のうち）。`,
                summaryRest: ({ parts }) => `残りは${parts}です。`,
                restWorking: ({ count }) => `作業中のセッション ${count} 件（決して触れません）`,
                restLeftAlone: ({ count }) => `放置を選んだ未使用のセッション ${count} 件`,
                restNotHappier: ({ amount }) => `Happier のものではない ${amount}`,
            },
            reasons: {
                working: "作業中",
                waiting_for_you: "あなたの返答待ち",
                subagents_running: "サブエージェント実行中",
                unsent_draft: "未送信の下書き",
                draft_unknown: "下書きを読み取れません",
                not_resumable: "再開できません",
                kill_protected: "停止しない設定",
                activity_unknown: "アクティビティ不明",
                kept_running: "「実行を続ける」を選択済み",
                identity_changed: "確認後に変化",
                ownership_unknown: "所有者不明",
                not_happier: "Happier のものではない",
                footprint_unknown: "サイズ不明",
                browser_in_use: "使用中",
                connections_unknown: "接続不明",
                visitors: "誰かが使用中",
                unsupported_target: "ここでは非対応",
                stop_failed: "停止できませんでした",
            },
            idle: {
                title: "未使用のセッション",
                description: "完了したセッションもエージェントをメモリに保持し続けます。停止するとそのメモリが解放され、次のメッセージで続きから再び起動します。",
                switchTitle: "未使用のセッションを停止する",
                offNone: "オフ。ここには長く未使用のセッションはありません。",
                offUnread: "オフ。未使用のセッションは動き続けます。",
                offSome: ({ count, after }) => `オフ。ここの ${count} 件のセッションが ${after} 以上未使用です。`,
                onHelp: ({ lead }) => `オン。${lead}前に「実行を続ける」付きの警告が届きます。`,
                afterTitle: "停止するまでの時間",
                afterHelp: "最後のメッセージ、ツール呼び出し、キー入力から数えます。",
                leadTitle: "事前に警告",
                leadHelp: "警告は「実行を続ける」付きで、スマートフォン、コンピュータ、セッション内に届きます。",
                rightNow: ({ machine }) => `${machine} の現在の状況`,
                idleFor: ({ duration }) => `${duration} 未使用`,
                stopsIn: ({ duration }) => `あと ${duration} で停止`,
                kept: "保持",
                onlyFinished: "再開できる完了済みのセッションのみ。未送信の下書き、実行中のサブエージェント、返答待ちの質問があるセッションは対象外です。",
            },
            terminals: {
                title: "未使用のターミナル",
                description: "開いたままのターミナルは、シェルとそれが開始したものを保持し続けます。未使用のものを閉じるとそれが解放されます。スクロールバックは残ります。",
                switchTitle: "未使用のターミナルを閉じる",
                off: "オフ。ターミナルは閉じるまで開いたままです。",
                onHelp: ({ lead }) => `オン。コマンドを実行中のターミナルには、${lead}前に「実行を続ける」付きの警告が届きます。`,
                afterTitle: "閉じるまでの時間",
                afterHelp: "最後の出力またはキー入力から数えます。",
                leadTitle: "事前に警告",
                leadHelp: "警告が届くのは、コマンドを実行中のターミナルだけです。",
                closesIn: ({ duration }) => `あと ${duration} で閉じます`,
                canClose: "閉じられます",
                notReported: "このマシンはまだ未使用のターミナルを一覧しません。",
                reasons: {
                    foreground_unknown: "コマンド実行中か判別できません",
                    finite_work: "コマンド実行中",
                    stop_pending: "閉じています",
                    native_owner_unknown: "所有者不明",
                    not_yet: "未使用の時間が足りません",
                    warning_unavailable: "事前に警告できません",
                    wrong_target: "このマシンにはありません",
                },
            },
            leftBehind: {
                title: "残ったプロセス",
                description: "セッションやターミナルが開始し、終了後も実行され続けているもの: ウォッチャー、開発サーバー、テストランナーなど。",
                modeTitle: "セッション終了後に片付ける",
                off: "オフ",
                ask: "確認する",
                automatic: "自動",
                offNone: ({ machine }) => `オフ。${machine} ではセッションが残したものは実行されていません。`,
                offUnread: "オフ。セッションが残したものは動き続けます。",
                offSome: ({ count, machine }) => `オフ。現在 ${machine} で ${count} 件が実行中です。`,
                offSomeBytes: ({ count, machine, amount }) => `オフ。現在 ${machine} で ${count} 件が実行中で、${amount} を使用しています。`,
                askHelp: "確認する: プロセスが実行中のままセッションが終了すると、受信トレイに質問が 1 件届きます。",
                automaticHelp: ({ grace }) => `自動: セッション終了の ${grace} 後に停止します。アクティビティに「再度開始」付きで一覧されます。`,
                automaticAtOnceHelp: "自動: セッションが終了するとすぐ停止します。アクティビティに「再度開始」付きで一覧されます。",
                graceTitle: "セッション終了後の待機",
                graceHelp: "プロセスが自力で終了するための猶予を与えます。",
                atOnce: "すぐに",
                seconds: ({ seconds }) => `${seconds} 秒`,
                customGrace: { title: "待機時間", body: "秒または分。例: 45 秒や 3 分。 単位を付けてください: ms、s、min、h、d。", invalid: "0 以上の秒数または分数を入力してください。 単位を付けてください: ms、s、min、h、d。" },
            },
            limits: {
                title: "上限と電源",
                ceilingTitle: "セッションごとのメモリ上限",
                ceilingHelp: "上限に達したセッションは再開できる状態で停止され、理由がメモ付きで残ります。マシン上のほかのものには影響しません。",
                ceilingNone: "上限なし",
                ceilingLabel: "メモリ上限",
                ceilingNotLinux: ({ os }) => `Linux のみ。${os} では、セッションとそのプロセスが合計で使う量を制限できません。`,
                ceilingNotLinuxGeneric: "Linux のみ。このシステムでは、セッションとそのプロセスが合計で使う量を制限できません。",
                ceilingNoUserManager: "この Linux マシンには、上限に必要な systemd ユーザーマネージャーがありません。",
                ceilingNoMemoryController: "このマシンのカーネルは、上限に必要なメモリコントローラーを提供していません。",
                customCeiling: { title: "メモリ上限", body: "メモリ量。例: 12 GB や 1.5 TB。", invalid: "0 より大きいメモリ量を入力してください。例: 12 GB。" },
                warnTitle: "セッションが次に達したら警告",
                warnHelp: "上限に対する割合です。停止される前に警告が 1 回届きます。",
                percent: ({ percent }) => `${percent}%`,
                customPercent: { title: "警告する割合", body: "1 から 99 までのパーセント。", invalid: "1 から 99 までの整数のパーセントを入力してください。" },
                awakeTitle: ({ machine }) => `${machine} をスリープさせない`,
                awakeOff: "オフ。スリープすると、作業中のセッションも一緒に一時停止します。",
                awakeOn: "Happier の実行中はスリープせず、次のセッションに備えます。画面はスリープできます。",
                awakeOnPower: "Happier の実行中で電源に接続されている間はスリープしません。バッテリー駆動時は通常どおりスリープします。画面はスリープできます。",
                awakeOnLabel: "オン",
                awakeOnPowerLabel: "電源接続時",
                awakeHolding: ({ count }) => `現在スリープを防いでいます · ${count} 件のセッションが作業中。`,
                awakeHoldingIdle: "現在スリープを防いでいます。次のセッションに備えています。",
                awakeLidMac: "ふたを閉じると、この Mac は引き続きスリープします。",
                awakeLidSettings: "ふたを閉じたときの動作は、このデバイスの電源設定に従います。",
                awakeNoInhibitor: "このマシンにはスリープを防ぐ手段がありません。",
                awakeHelperMissing: "このマシンのスリープを防ぐヘルパーがインストールされていません。",
            },
            activity: {
                title: "アクティビティ",
                all: "すべてのアクティビティ",
                back: "ガード",
                pageAccessory: ({ machine }) => `${machine} で Happier が自動で行ったことすべて`,
                empty: ({ machine }) => `まだありません。${machine} で Happier が自動で停止したものは、理由と元に戻す手段とともにここに表示されます。`,
                noMatches: "このフィルターと期間に該当するものはありません。",
                loading: "アクティビティを読み込み中",
                error: "アクティビティを読み取れませんでした。",
                others: ({ count }) => `ここのほかの人による ${count} 件は表示されません。`,
                filters: { label: "表示", all: "すべて", stopped: "停止", cleaned_up: "片付け済み", needs_look: "要確認" },
                ranges: { label: "期間", today: "今日", '7d': "過去 7 日間", '30d': "過去 30 日間" },
                showEarlier: "さらに前を表示",
                keptFor: ({ machine }) => `${machine} に 30 日間保存されます`,
                tiles: {
                    memoryFreed: "解放したメモリ",
                    stops: ({ count }) => `停止 ${count} 件`,
                    inTrash: "ゴミ箱内",
                    needsLook: "要確認",
                    needsLookNone: "問題なし",
                },
                today: "今日",
                yesterday: "昨日",
                dayFreed: ({ amount }) => `メモリ ${amount} を解放`,
                dayInTrash: ({ amount }) => `ゴミ箱に ${amount}`,
                freed: ({ amount }) => `${amount} を解放`,
                inTrash: ({ amount }) => `ゴミ箱に ${amount}`,
                undoneAt: ({ time }) => `${time} に元に戻しました`,
                didNotHelp: "効果がありませんでした",
                stepN: ({ step }) => `ステップ ${step}`,
                trigger: ({ level, duration }) => `メモリプレッシャーが ${duration} のあいだ${level}`,
                wayBack: {
                    resume: "再開", start_again: "再度開始", reopen: "再度開く", undo: "元に戻す", empty_now: "今すぐ空にする",
                    raise_ceiling: "上限を上げる", review_processes: "プロセスを確認",
                },
                wayBackFailed: "うまくいきませんでした。何も変更されていません。",
                kinds: {
                    stoppedSession: ({ title }) => `「${title}」を停止しました`,
                    stoppedSessionIdle: ({ title, duration }) => `「${title}」を ${duration} の未使用後に停止しました`,
                    closedBrowser: "ブラウザのサイドカーを閉じました",
                    stoppedService: ({ label }) => `${label} を停止しました`,
                    stoppedLeftBehind: ({ count }) => `残っていたプロセス ${count} 件を停止しました`,
                    outOfSteps: "メモリ不足が続いたため、Happier は動作を止めました",
                    stopFailed: ({ label }) => `${label} を停止できませんでした`,
                    keptRunning: ({ title }) => `「${title}」の実行を続けました`,
                    ceilingNear: ({ title }) => `「${title}」がメモリ上限に近づいています`,
                    ceilingReached: ({ title }) => `「${title}」がメモリ上限に達しました`,
                    systemOomKill: "システムがメモリを解放するためプロセスを停止しました",
                    trashMoved: ({ count }) => `${count} 件をゴミ箱に移動しました`,
                    trashEmptied: "ゴミ箱を空にしました",
                    closedTerminal: ({ label, duration }) => `ターミナル ${label} を ${duration} の未使用後に閉じました`,
                    housekeeping: "古いログと録画を削除しました",
                    startFailed: ({ label }) => `${label} を再度開始できませんでした`,
                    undone: "以前の停止を元に戻しました",
                    something: "これ",
                },
                because: {
                    idle_sessions: "次のメッセージで再び起動します",
                    left_behind: "そのセッションは終了していました",
                    ceiling: "再開できる状態で停止しました",
                    approved_proposal: "あなたが承認しました",
                    idle_terminals: "スクロールバックは残ります",
                    kept_running: "警告で「実行を続ける」を選びました。",
                },
                startFailure: {
                    too_many_open_files: "マシンで開いているファイルが多すぎました",
                    no_ptys: "マシンに空いているターミナルがありませんでした",
                    process_limit: "マシンがこれ以上プロセスを実行できませんでした",
                    out_of_memory: "起動に必要なメモリが足りませんでした",
                    other: "今回は起動できませんでした",
                },
                nextStep: {
                    close_idle_terminals: "使っていないターミナルを閉じて、もう一度お試しください",
                    review_processes: "実行中のものを確認して、もう一度お試しください",
                },
            },
            session: {
                stopsIn: ({ duration }) => `あと ${duration} で停止`,
                stopped: "停止",
                stoppingIn: "停止まで",
                keepRunning: "実行を続ける",
                keepRunningFailed: "実行を続けられませんでした。何も変更されていません。",
                stoppedToFreeMemory: "メモリ解放のため停止 · 次のメッセージで再開します",
                stoppedAtCeiling: "メモリ上限で停止 · 次のメッセージで再開します",
                waking: "起動中 · 停止した箇所から続けます",
                wakePlaceholder: "メッセージを送ってこのセッションを再開…",
                bannerTitle: ({ title, minutes }) => `「${title}」はあと ${minutes} 分で停止します`,
                bannerBody: "作業は完了しています。次のメッセージで再開します。セッションから「実行を続ける」を選べます。",
                markerIdle: ({ duration, time }) => `${duration} の未使用後に停止 · ${time}`,
                markerMemory: ({ time }) => `メモリ解放のため停止 · ${time}`,
                markerCeiling: ({ time }) => `メモリ上限で停止 · ${time}`,
                markerFreed: ({ amount }) => `${amount} を解放`,
                markerRequested: ({ time }) => `停止を要求しました · ${time}`,
                markerCancelled: ({ time }) => `停止を取り消しました · ${time}`,
                markerFailed: ({ time }) => `停止できませんでした · ${time}`,
            },
        },
        machineProcesses: {
            ceiling: {
                usage: ({ used, limit }) => `${limit} 中 ${used}`,
                limit: ({ limit }) => `上限 ${limit}`,
                title: "セッションのメモリ上限",
                scopeHelp: "キャッシュを含め、このセッションのスコープに計上されるメモリが対象です。",
                throttles: ({ count }) => `過去5分間に ${count} 回の制限`,
                throttlesUnknown: "5分間全体の制限の観測データはまだありません。",
            },
            tab: "プロセス",
            scope: {
                label: "表示するプロセス",
                happier: "Happierが起動",
                all: "すべてのプロセス",
            },
            sampledWhileLooking: "表示している間だけ計測します",
            live: "ライブ",
            paused: "一時停止中",
            retry: "再試行",
            searchLabel: "プロセスを絞り込む",
            searchPlaceholder: "名前、ポート、コマンド",
            tableLabel: ({ machine }) => `${machine} のプロセス`,
            columns: {
                happier: "Happierが起動",
                everything: ({ machine }) => `${machine} のすべて`,
                cpu: "CPU",
                memory: "メモリ",
                trend: "推移",
            },
            tiles: {
                memory: "メモリ",
                cpu: "CPU",
                happier: "Happierが起動",
                free: "空き",
                inUse: "使用中",
                load: ({ load }) => `負荷 ${load}`,
                inProcesses: ({ count }) => `${count} 個のプロセス`,
                leftBehind: ({ count }) => `${count} 個が残っています`,
                ofMemoryInUse: "使用中メモリのうち",
                stopFrees: ({ amount }) => `停止すると約 ${amount} 空きます`,
                freed: ({ amount }) => `${amount} を解放`,
                stopped: ({ name }) => `${name} を停止しました`,
                startAgain: "もう一度起動",
                memoryLabel: ({ total, free }) => `メモリ：${total} のうち ${free} 空き`,
                cpuLabel: ({ percent }) => `CPU：マシンの ${percent}%`,
                happierLabel: ({ count, amount }) => `Happierが起動：${count} 個のプロセスで ${amount}`,
            },
            roles: {
                agent: "エージェント",
                tool_shell: "ツールシェル",
                test_runner: "テストランナー",
                type_checker: "型チェッカー",
                dev_server: "開発サーバー",
                language_server: "言語サーバー",
                mcp_server: "MCPサーバー",
                browser: "ブラウザー",
                database: "データベース",
            },
            owners: {
                browserSidecar: "ブラウザーサイドカー",
                workspaceSync: "ワークスペース同期",
                happier: "Happier",
                keepsConnected: ({ machine }) => `${machine} を接続中に保ちます`,
                components: {
                    voice_worker: "Happier 音声",
                    device_helper: "Happier デバイスヘルパー",
                    recording_encoder: "Happier 録画エンコーダー",
                    plugin_database_worker: "Happier プラグインデータベース",
                    workspace_sync: "Happier ワークスペース同期",
                },
                terminal: ({ name }) => `ターミナル · ${name}`,
                service: ({ name }) => `サービス · ${name}`,
                run: ({ name }) => `実行 · ${name}`,
                anotherAccount: "別のアカウントのセッション",
                session: "セッション",
                someonesSession: ({ name }) => `${name} のセッション`,
                processCount: ({ count }) => `${count} 個のプロセス`,
                statusWithCount: ({ status, count }) => `${status} · ${count} 個のプロセス`,
                stopping: "停止中…",
                matches: ({ total, count }) => `${total} 件中 ${count} 件が一致`,
            },
            ownership: {
                likely: "推定",
                leftBehind: "残留",
                notHappiers: "Happier以外",
                unknown: "未証明",
            },
            groups: {
                leftBehind: "残留",
                leftBehindDescription: "セッションは終了しましたが、動き続けています",
                notHappiers: "Happier以外",
                notHappiersDescription: "Happierが自分から停止することはありません",
                otherPeople: "他の人のもの",
                otherPeopleDescription: "このマシンの他の人のものなので、Happierは読み取りも停止もできません",
            },
            leftBehindRow: ({ owner, when }) => `${owner} · ${when}に終了`,
            endedOwner: "終了したセッション",
            cleanUp: ({ count, amount }) => `${count} 個を片付ける · ${amount}`,
            fold: {
                idle: ({ count }) => `ほか ${count} 個は 0%`,
                mcp: ({ count }) => `MCPサーバー ${count} 個（待機中）`,
            },
            totals: {
                happier: "Happier 合計",
                everythingElse: ({ machine }) => `${machine} のその他すべて`,
                showAll: "すべてのプロセスを表示",
                leftBehindOnly: ({ count }) => `終了したセッションが残したものだけ · ${count}`,
                showEverything: "すべて表示",
                machine: ({ machine }) => `${machine} 合計`,
                match: ({ total, count, query }) => `${total} 個中 ${count} 個のプロセスが「${query}」に一致`,
                clear: "クリア",
            },
            allRows: {
                happier: ({ owners, processes }) => `所有者 ${owners} · プロセス ${processes} 個`,
                otherPeopleFallback: "他の人",
            },
            noMatch: ({ machine, query }) => `${machine} でHappierが起動したもののうち「${query}」に一致するものはありません。`,
            noMatchAll: ({ machine, query }) => `${machine} には「${query}」に一致するものはありません。`,
            lookInAll: "すべてのプロセスで探す",
            allOff: {
                title: ({ machine }) => `${machine} で動いているすべてを表示`,
                body: ({ machine }) => `すべてのアプリとバックグラウンドプロセスを、アプリごとにまとめて使用量とともに表示します。表示している間だけ ${machine} で読み取り、ほかのマシンではそこで有効にするまでオフのままです。`,
                action: ({ machine }) => `${machine} のすべてのプロセスを表示`,
                custodianOnly: "これを有効にできるのは、このマシンを管理している人だけです。",
            },
            onFor: ({ machine }) => `${machine} のみオン`,
            turnOff: "オフにする",
            menu: {
                label: ({ name }) => `${name} の操作`,
                openSession: "セッションを開く",
                stopSession: "セッションを停止",
                stopSessionHint: "次のメッセージで再開します",
                stopService: "サービスを停止",
                stop: "停止",
                freesAbout: ({ amount }) => `約 ${amount} 空きます`,
                killTree: "ツリーを強制終了…",
                killProcess: "プロセスを強制終了…",
                asksFirst: "Happierが先に確認します",
                showDetails: "詳細を表示",
                copyCommand: "コマンドをコピー",
                copyName: "名前をコピー",
                unavailable: ({ machine }) => `${machine} が応答しないため、今は何も停止できません`,
            },
            portMenu: {
                label: ({ port }) => `ポート ${port} の操作`,
                openInBrowser: "ブラウザで開く",
                publicLink: "公開リンク…",
                stopServer: ({ port }) => `:${port} のサーバーを停止`,
                notListed: "ローカルサービスにはまだこのポートがありません",
                closeTerminalTitle: ({ port }) => `:${port} を解放しますか？`,
                closesTerminal: ({ name }) => `ターミナル ${name} が閉じます。`,
                closeTerminalBody: "このポートで待ち受けているシェルはターミナルそのものです。停止するとターミナルと、その中でまだ動いているものがすべて終了します。",
                confirmCloseTerminal: "ターミナルを閉じる",
            },
            stopGuest: {
                title: ({ name }) => `${name} を停止しますか？`,
                confirm: "停止",
            },
            kill: {
                processTitle: ({ name }) => `${name} を強制終了しますか？`,
                processBody: ({ owner }) => `${owner} が起動しました。作業を終えずにすぐ終了します。セッションは続き、もう一度起動できます。`,
                treeTitle: ({ name, count }) => `${name} と ${count} 個のプロセスを強制終了しますか？`,
                treeBody: "起動したものはすべてすぐ終了します。会話は残りますが、保存されていないものは失われます。",
                treeGentler: "「セッションを停止」ならエージェントは手順を終えてから止まり、次のメッセージで再開します。",
                stopInstead: "代わりにセッションを停止",
                likelyBody: ({ owner, platform }) => `Happierは ${owner} が起動したと考えていますが、${platform} では証明できません。対象が正しいか確認してください。`,
                leftBehindBody: ({ owner }) => `${owner} は終了しましたが、これは動き続けています。すぐ終了します。`,
                notHappierBody: ({ app }) => `これはHappierが起動したものではありません。${app} のもので、もう一度開くまで動かなくなることがあります。`,
                neverOnItsOwn: "Happierが自分からこれを行うことはありません。",
                guest: ({ name }) => `これはこのマシンでの ${name} の作業です。終了したことは本人に表示されます。`,
                rechecked: ({ time }) => `今もう一度確認しました：同じプロセスで、${time} に起動しています。`,
                recheckedGone: "今もう一度確認しました：すでに終了しています。",
                recheckedChanged: "今もう一度確認しました：別のプロセスになっているため、Happierは強制終了しません。",
                checking: "もう一度確認しています…",
                confirmProcess: "プロセスを強制終了",
                confirmTree: ({ count }) => `${count} 個のプロセスを強制終了`,
                facts: {
                    command: "コマンド",
                    using: "使用量",
                    running: "実行時間",
                    frees: "解放量",
                    gentler: "穏やかな方法",
                    app: "アプリ",
                    folder: "フォルダー",
                },
                usingValue: ({ memory, cpu }) => `${memory} · CPU ${cpu}%`,
                runningSince: ({ time, duration }) => `${time} から · ${duration}`,
            },
            results: {
                ended: ({ name }) => `${name} を終了しました`,
                endedTree: ({ name, count }) => `${name} と ${count} 個のプロセスを終了しました`,
                survived: ({ name }) => `${name} はまだ動いています：終了を確認できませんでした`,
                refused: ({ name }) => `${name} を停止できませんでした`,
                cleanedUp: ({ count }) => `${count} 個を片付けました`,
                skipped: ({ count, reason }) => `${count} 個をスキップ：${reason}`,
                skipReasons: {
                    restarted: "再起動していました",
                    gone: "すでに終了していました",
                    changed: "変わっていました",
                },
                approvalPending: "あなたの承認を待っています",
                failedReason: "停止しませんでした",
                startedAgain: ({ name }) => `${name} をもう一度起動しました`,
                resumesOnMessage: "次のメッセージで再開します",
                startAgainFailed: ({ name }) => `${name} をもう一度起動できませんでした`,
                copied: "コピーしました",
            },
            review: {
                title: ({ count }) => `残留しているプロセス ${count} 個を片付けますか？`,
                body: ({ machine }) => `セッションは終了しましたが、これらは ${machine} で動き続けています。Happierはそれぞれを1分の間隔で2回確認しており、確定するときにもう一度確認します。`,
                startedBy: ({ owner, when }) => `${owner} が起動（${when}に終了）`,
                selected: ({ total, count }) => `${total} 個中 ${count} 個を選択`,
                note: "それぞれに終了を求めてから終了させます。元に戻せません。",
                rowsLabel: "片付けるプロセス",
            },
            detail: {
                label: ({ name }) => `${name} の詳細`,
                startedBy: "起動元",
                quitAt: ({ time }) => `${time} に終了`,
                howHappierKnows: "Happierが判断した根拠",
                evidence: {
                    fence: "システムによる隔離",
                    parent_chain: "親プロセスのつながり",
                    marker: "Happierのマーカー",
                    group_and_port: "プロセスグループとポート",
                },
                reasons: {
                    linux_scope: "セッション専用のスコープ内で動いています",
                    windows_job: "所有者のジョブ内で動いています",
                    macos_no_fence: "macOSはセッションが起動したものを隔離できません",
                    no_systemd_user_manager: "ここでは隔離できません：systemdのユーザーマネージャーがありません",
                    job_join_failed: "Windowsがジョブへの追加を許可しませんでした",
                    outside_fence: "所有者の隔離の外で動いています",
                    live_root_chain: "親をたどるとHappierが起動したものにつながります",
                    chain_broken_at_exit: "親が終了したため、つながりはそこで途切れています",
                    no_live_root: "上位でHappierが起動したものは動いていません",
                    marker_matches: "この所有者のHappierマーカーを持っています",
                    marker_cleared: "起動元が空の環境で起動しました",
                    foreign_home_marker: "別のHappierのマーカーを持っています",
                    marker_owner_unknown: "マーカーにHappierの知らない所有者が記されています",
                    marker_predates_owner: "マーカーが所有者より古いものです",
                    same_group_port_opened_while_running: "セッションと同じグループで、実行中にポートが開きました",
                    no_group_or_port_match: "共通のグループもポートもありません",
                    principal_unreadable: "誰のプロセスかを読み取れません",
                    other_principal: "別のユーザーのものです",
                    required_fields_unreadable: "システムがこの情報の読み取りを許可しませんでした",
                },
                likelyWhy: "推定で、証明はされていません：強制終了の前にHappierが確認します。",
                leftBehindWhy: "所有者は終了しましたが動き続けています：終了の前にHappierが確認します。",
                memoryKinds: {
                    rss: "メモリ（常駐）",
                    footprint: "メモリ（フットプリント）",
                    private: "メモリ（プライベート）",
                    working_set: "メモリ（ワーキングセット）",
                },
                memoryShared: "他のプロセスと共有しているページは重複して数えられることがあります。",
                cpuOf: ({ machine }) => `${machine} 全体のうち`,
                facts: {
                    port: "ポート",
                    folder: "フォルダー",
                    running: "実行時間",
                    process: "プロセス",
                },
                processValue: ({ pid, user }) => `${pid} · ${user}`,
                cwdUnavailableWindows: "Windowsでは利用できません",
                noHistory: "開いている間、履歴が表示されます。",
                hourAgo: "1時間前",
                now: "現在",
            },
            platform: {
                linux: "Linuxではセッション、ターミナル、サービスがそれぞれ専用のスコープで動くため、起動したものはすべて証明されます。",
                win32: "WindowsではそれぞれがHappierの保持するジョブで動くため、起動したものはすべて証明されます。",
                darwin: "macOSはセッションが起動したものを隔離できません。Happierは親のつながりとマーカーをたどり、根拠が状況証拠のときは「推定」と表示します。",
            },
            states: {
                unverifiable: ({ count }) => `${count} 個のプロセスを帰属先に割り当てられませんでした。その他に含まれ、ここでは停止できません。`,
                loading: "プロセスを読み込んでいます",
                offlineTitle: ({ machine }) => `${machine} はオフラインです`,
                offlineBody: "最後に確認したときに動いていたものです。戻ってきたらまた停止できます。",
                offlineReason: '戻ってくるとプロセスがここに表示されます。',
                tryAgain: "再試行",
                errorTitle: ({ machine }) => `${machine} のプロセスを一覧できません`,
                errorBody: "オンラインで、セッションは動き続けています。プロセスを一覧するHappierの機能が応答していません。何も停止していません。",
                helperMissing: "このHappierはまだこのマシンのプロセスを読み取れません。Doctorで不足しているものを確認できます。",
                openDoctor: "Doctorを開く",
                olderHappier: ({ machine }) => `${machine} のHappierを更新すると、プロセスが表示されます。`,
                nothingTitle: ({ machine }) => `${machine} では何も動いていません`,
                nothingBody: "ここでセッション、ターミナル、開発サーバーが起動すると、起動したすべてのものと使用量とともに表示され、確認や停止ができます。",
                startSession: ({ machine }) => `${machine} でセッションを開始`,
                othersWork: ({ count }) => `ほかに ${count} 個のセッションが動いています`,
            },
            phone: {
                back: "プロセス",
                ownerProcesses: ({ count }) => `${count} 個のプロセス`,
                ownerFoot: "停止しても会話は残り、次のメッセージでセッションが再開します。プロセスをタップすると、それが何か、なぜここに属すると判断したか、履歴が表示されます。",
                cpuOfCores: ({ cores }) => `${cores} コア中`,
                memoryOfMachine: ({ percent }) => `このマシンの ${percent}%`,
            },
            a11y: {
                row: ({ name, detail, cpu, memory }) => `${name}${detail ? `, ${detail}` : ''}、CPU ${cpu}、メモリ ${memory}`,
                select: ({ name }) => `${name} を片付ける`,
            },
        },
    }) };

return { machineDetailPageTranslations };
})();

const Domain_machinePoolTranslations = (() => {
const en = Shared_machinePoolTranslations.en;

const ja = {
    machinesSection: "マシン",
    tierPrimaryDescription: "最初に試します。",
    tierFallbackDescription: "前のマシンがどれもオンラインでないときに試します。",
    pauseMember: "新しいセッションでは一時停止",
    resumeMember: "新しいセッションで使用",
    pausedState: "一時停止中",
    memberMenu: "マシンのオプション",
    newPoolTitle: "新しいマシンプール",
    title: "マシンプール",
    myTitle: "マイマシンプール",
    add: "マシンプールの追加",
    benefit: "優先マシンを選択し、他のマシンをフォールバックとして使用できます。",
    placementChangeNotice: "変更は保存後に開始するセッションに適用されます。開いているセッションは現在のマシンに残ります。",
    connectionSemantics: "接続を開くときにマシンが選択され、その接続中は同じマシンが選択されたままです。後の接続では別のマシンが選ばれることがあります。",
    noMembers: "このプールにはまだマシンがありません",
    unavailable: "利用不可",
    memberRevoked: "取り消されました",
    memberReplaced: "交換されました",
    memberTemporary: "一時的",
    availabilityUnknown: "接続の可用性が不明",
    notVerified: "未確認",
    brokerUnavailable: "利用可能なブローカーがありません",
    brokerAvailable: ({ count }: { count: number }) => `利用可能: ${count}`,
    basics: "詳細",
    name: "名前",
    description: "説明 (オプション)",
    descriptionTitle: "説明",
    addMachines: "マシンを追加する",
    noMachines: "この Home には利用可能な永続マシンがありません。",
    allMachinesAdded: "この Home のすべてのマシンは、すでにこのプールに含まれています。",
    primary: "主要な",
    addFallback: "フォールバックの追加",
    moveTo: "移動先",
    moveTierEarlier: "この層を先に移動します",
    moveTierLater: "この層を後で移動する",
    removeMember: "プールから削除する",
    enableMember: "今後の選択に使用します",
    save: "変更を保存する",
    create: "プールの作成",
    delete: "マシンプールの削除",
    deleteTitle: "このマシン プールを削除しますか?",
    deleteBody: "このプールを使用している認証情報リソースがあれば、ブローカーの場所を失い、修復が必要になります。今後の選択には影響しますが、マシンの削除や実行中のセッションの停止は行いません。",
    saveFailed: "このマシン プールを保存できませんでした。変更内容はまだ残っています。",
    deleteFailed: "このマシン プールを削除できませんでした。もう一度やり直してください。",
    conflictTitle: "このプールは別の場所に変更されました",
    conflictBody: "保存されていない変更は保存されます。保存したバージョンを再ロードして、最新の変更を確認します。",
    conflictNoReload: "プール ID は使用できなくなりました。保存されていない変更は保存されます。",
    homeOffline: "この Home はオフラインです。再接続するまでプールを変更できません。",
    refreshFailed: "マシンプールを更新できませんでした。最後に取得した一覧を表示しています。",
    featureUnavailable: "この Home ではマシンプールを利用できません。続行するには、Home で更新または有効化してください。",
    openSettings: "マシンプールの設定",
    pickSpecificMachine: "特定のマシンを選択",
    poolNotFound: "このマシン プールは使用できなくなりました。",
    reload: "保存したバージョンをリロードする",
    reloadTitle: "保存されていない変更を破棄しますか?",
    reloadBody: "再ロードすると、このフォームは保存された最新バージョンに置き換えられます。",
    privacy: "この Home のサーバーは、エンドツーエンド暗号化されたアカウントでも、プールの名前、説明、メンバー構成を読み取れます。",
    nameRequired: "保存する前に名前を入力します。",
    memberNotEligible: "一部のマシンはこのプールに所属できなくなります。",
    memberNotEligibleDetail: "このマシンを削除するか、別の永続マシンを選択してください。",
    resolvingTarget: "このプールからマシンを選択しています…",
    resolveEmpty: "このプールには有効なマシンがありません。",
    resolveNoAvailable: "現在、このプールには使用可能なマシンがありません。",
    resolvePresenceUnavailable: "マシンの可用性は一時的に不明です。",
    resolveFailed: "このプールからマシンを選ぶことはできませんでした。もう一度やり直してください。",
    executionMachine: "実行先",
    chosenFrom: "選択元",
    aMachinePool: "マシンプール",
    availabilityKnown: ({ connected, enabled }: { connected: number; enabled: number }) => `有効な${enabled}台のうち${connected}台が接続中`,
    fallback: ({ number }: { number: number }) => `フォールバック ${number}`,
};

const machinePoolTranslations = { ja };

return { machinePoolTranslations };
})();

const Domain_mcpSettingsTranslations = (() => {
type McpSettingsCopy = Shared_mcpSettingsTranslations.McpSettingsCopy;

const en = Shared_mcpSettingsTranslations.en;

const ja: McpSettingsCopy = {
    purpose: 'エージェントがセッションで呼び出せるツールサーバーです。サーバーを一度追加し、適用する場所を選びます。',
    add: 'MCP サーバーを追加',
    addConfigure: 'サーバーを設定',
    addConfigureDescription: 'コマンドまたはアドレスを入力',
    addImportJson: 'JSON 設定を貼り付け',
    addImportJsonDescription: 'README や他のアプリから',
    addOwnCategory: '自分で追加',
    addPresetCategory: 'クイックインストール',
    addFromMachine: 'このマシンからインポート',
    addFromMachineDescription: '他のエージェントが既に使っているサーバー',
    searchPlaceholder: 'サーバーを検索',
    toolsGroup: 'ツール',
    unbound: 'まだどこでも使われていません',
    newServer: '新しい MCP サーバー',
    serverPurpose: 'エージェントが呼び出せるツールサーバーです。適用する場所を下で選びます。',
    addByTitle: '追加方法',
    serverSection: 'サーバー',
    serverSectionDescription: 'セッションとこの一覧でのサーバー名です。',
    connectionSection: '接続',
    connectionSectionDescription: 'Happier がサーバーを起動または接続する方法です。',
    envDescription: 'サーバーに渡す値です。キーには保存済みシークレットを使います。',
    headersDescription: 'すべてのリクエストで送信されます。トークンには保存済みシークレットを使います。',
    addRule: 'ルールを追加',
    discardDraft: '破棄',
    landingTitle: 'エージェントにツールを追加',
    landingDescription: 'MCP サーバーはブラウザー、ドキュメント検索、GitHub などのツールを追加します。自分で設定するか、設定を貼り付けるか、プリセットから始めます。',
    onMachineTitle: 'このマシンで見つかったサーバー',
    onMachinePurpose: '他のエージェントがこのマシンで既に設定している MCP サーバーです。インポートすると Happier から使えます。',
    onMachineSearchSection: '検索する場所',
    onMachineSearchDescription: 'ホームフォルダー内のエージェント設定と、選択した場合はプロジェクトフォルダーです。',
    onMachineFoundSection: 'サーバー',
    onMachineFoundDescription: 'インポートするとサーバーが Happier にコピーされます。元の設定は変更されません。',
    previewTitle: 'セッションが受け取るもの',
    previewPurpose: 'エージェントとフォルダーごとにセッションが受け取る MCP サーバーと、起動できない場合の動作を確認します。',
    previewContextSection: 'セッション',
    previewContextDescription: '新しいセッションが開始されるエージェントとフォルダーです。',
    failurePolicyTitle: 'サーバーを起動できないとき',
    failurePolicyDescription: '例えば、必要な保存済みシークレットがない場合です。',
    failurePolicySkip: 'スキップ',
    failurePolicyStop: 'セッションを停止',
    failureSection: '信頼性',
    failureSectionDescription: 'すべてのセッションのすべての MCP サーバーに適用されます。',
    previewNothingTitle: '何も提供されません',
    previewNothingDescription: 'このエージェントとフォルダーに適用される MCP サーバーはありません。対象となるサーバーまたはルールを追加してください。',
    check: '確認',
    scan: '検索',
};

const mcpSettingsTranslations = { ja } as const;

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

const ja: DesktopTrayTranslation = {
    open: 'Happier を開く',
    openInHappier: 'Happier で開く',
    settings: '設定…',
    startAtLogin: 'ログイン時に起動',
    quit: 'Happier を終了',
    stopServicesAndQuit: 'バックグラウンドサービスを停止して終了…',
    sessions: ({ count }: CountParams) => `${count} 件実行中`,
    start: '起動',
    restart: '再起動',
    stop: '停止…',
    userOwned: 'Happier の外で管理されています',
    checking: 'バックグラウンドサービスを確認しています…',
    readFailed: 'バックグラウンドサービスを確認できませんでした',
    incomplete: '一部のバックグラウンドサービスを確認できませんでした',
    noServices: 'このコンピューターはまだセットアップされていません',
    working: '処理中…',
    stopConfirmTitle: ({ relay }: RelayParams) => `${relay} 用の Happier のバックグラウンドサービスを停止しますか？`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `このコンピューターで ${relay} 用に実行中のエージェントセッションは終了し、サービスが再び起動するまで、スマートフォンやブラウザからそこでこのコンピューターに接続できなくなります。`,
    stopAllConfirmTitle: 'Happier のバックグラウンドサービスを停止して終了しますか？',
    stopAllConfirmBody: 'このコンピューターのエージェントセッションは終了し、バックグラウンドサービスが再び起動するまで、スマートフォンやブラウザから接続できなくなります。',
    stopConfirmAction: '停止',
    actionFailedTitle: '完了できませんでした',
    loginItemFailed: 'Happier のログイン項目を更新できませんでした',
    quitStopTitle: 'エージェントセッションがまだ実行中です',
    quitStopBody: '終了すると、このコンピューターのバックグラウンドサービスが停止し、ここで実行中のセッションが終了します。',
    quitStopUnknownTitle: 'バックグラウンドサービスを停止しますか？',
    quitStopUnknownBody: 'Happier はこのコンピューターで実行中のセッションを確認できません。終了するとバックグラウンドサービスが停止し、実行中のセッションは終了します。',
    quitStopConfirm: '停止する',
    quitStopKeep: '実行したままにする',
    quitStopFailedTitle: '一部のバックグラウンドサービスが停止しませんでした',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier は開いたままなので、バックグラウンドサービスを確認して再試行できます。`,
};

const jaLoginStart: DesktopLoginStartTranslation = {
    title: 'ログイン時に起動',
    subtitle: 'スマートフォンやブラウザからこのコンピューターに接続できる状態を保ちます。ログイン時にバックグラウンドサービスが起動し、Happier の終了後も動作し続けます。オフにすると、Happier の終了時にサービスも停止します。',
    unknown: 'このコンピューターのバックグラウンドサービスがログイン時に起動するかどうか、まだ確認できません。',
    notSetUp: 'このコンピューターのセットアップ後に利用できます。',
};

const menuBarModeTranslations = { ja: { tray: ja, loginStart: jaLoginStart } };

return { menuBarModeTranslations };
})();

const Domain_nativePasswordTranslations = (() => {
const nativePasswordTranslations = { ja: {
        email: 'メールアドレス',
        password: 'パスワード',
        signIn: 'サインイン',
        title: 'メールとパスワード',
        forgotPassword: 'パスワードをお忘れですか？',
        capsLock: 'Caps Lock がオンです',
        emailRequired: 'メールアドレスを入力してください。',
        passwordRequirements: '15文字以上、UTF-8で1,024バイト以内にしてください。スペースも使えます。',
        unavailable: 'このHomeではメールとパスワードでのサインインを利用できません。',
        rateLimited: '試行回数が多すぎます。少し待ってからもう一度お試しください。',
        emailInvalid: '有効なメールアドレスを入力してください。',
        passwordMalformed: 'このパスワードには安全に保存できない文字が含まれています。入力し直してください。',
        passwordMismatch: 'パスワードが一致しません。',
        currentPasswordRequired: '現在のパスワードを入力してください。',
        currentPassword: '現在のパスワード',
        newPassword: '新しいパスワード',
        confirmPassword: 'パスワードの確認',
        signInFailed: 'このメールアドレスとパスワードの組み合わせでは認証できませんでした。',
        accountVerificationFailed: "パスワードを変更するためのアカウント確認ができませんでした。再度サインインするか復旧キーを使って、もう一度お試しください。",
        accountDisabledHere: 'このアカウントはこのHomeで無効になっています。Homeの管理者に再有効化を依頼してください。',
        notEligible: 'このアカウントは現在このHomeにサインインできません。',
        linkExpired: 'このリンクは期限切れか、すでに使用されています。新しいリンクをリクエストしてください。',
        revisionConflict: 'パスワードが別の場所で変更されました。再読み込みしてやり直してください。',
        serverUnavailable: 'このHomeはリクエストを完了できませんでした。しばらくしてからお試しください。',
        offline: 'このHomeに接続できません。ネットワークを確認してからお試しください。',
        homeUnreachable: 'このHomeに接続できませんでした。もう一度お試しください。',
        securityFactUnavailable: 'Homeから読み取れませんでした。',
        cancelled: 'この試行はキャンセルされました。',
        approvalPending: '承認待ちです。承認受信箱で確認してから、ここに戻ってください。',
        outcomeUnconfirmed: 'その変更が適用されたかどうかを確認できませんでした。このアカウントを再読み込みしたので、もう一度試す前に状態を確認してください。',
        recoveryKeyRequired: 'このエンドツーエンド暗号化アカウントのパスワードを変更するには、リカバリーキーを入力してください。キーはこの端末にだけ保存されます。',
        working: '処理中…',
        showPassword: 'パスワードを表示',
        hidePassword: 'パスワードを非表示',
        createTitle: 'アカウントを作成',
        createAccount: 'アカウントを作成',
        accountProtection: 'アカウントの保護',
        protectionPlain: 'Homeが読み取り可能',
        protectionPlainDetail: 'あなたのHomeがデータを読み取れます。パスワードを忘れた場合はメールで再設定できます。',
        protectionE2ee: 'エンドツーエンド暗号化',
        protectionE2eeDetail: 'データを読めるのはあなたのデバイスだけです。リカバリーキーを保管してください。パスワードの再設定だけでは復元できません。',
        checkYourEmail: 'メールをご確認ください',
        resend: 'もう一度送信',
        resent: 'もう一度送信しました。メールを確認してください。',
        useDifferentEmail: '別のメールアドレスを使う',
        connectTitle: 'メールとパスワードを追加',
        connectFromSecurity: 'すでに使っている方法でサインインし、アカウントのセキュリティからメールとパスワードを追加してください。',
        signInFirst: '先にサインイン',
        forgotTitle: 'パスワードをお忘れですか？',
        forgotExplanation: '再設定の手順をメールでお送りするか、アカウント作成時に保存したリカバリーキーを使用できます。',
        emailResetInstructions: '再設定の手順をメールで送る',
        useRecoveryKey: 'リカバリーキーを使う',
        recoveryKeyDownload: 'リカバリーキーをダウンロード',
        recoveryKeyLater: '後で行う',
        securitySectionTitle: 'メールとパスワード',
        signInEmail: 'サインイン用メールアドレス',
        signInEmailNotSet: '未設定',
        passwordEnrolled: '設定済み',
        passwordNotEnrolled: '未設定',
        passwordSetUp: 'この Home のパスワードを設定しました。',
        passwordChanged: 'パスワードを変更しました。',
        passwordRemoved: 'パスワードを削除しました。',
        changePassword: 'パスワードを変更',
        removePassword: 'パスワードを削除',
        removePasswordSubtitle: '他の方法でのみサインインする',
        removePasswordConsequence: 'メールとパスワードではこのHomeにサインインできなくなります。他のサインイン方法とデータはそのままです。',
        changeEmailExplanation: '新しいアドレスに確認メールを送信します。確認するまで現在のサインイン用アドレスは有効です。',
        sendVerification: '確認メールを送信',
        verifyTitle: 'メールアドレスの確認',
        verifyGeneric: 'このリンクはメールボックスの管理権を確認します。',
        verifyReturnToCreate: 'このHomeに戻り、このアドレスでアカウント作成を完了してください。',
        addressVerified: 'このアドレスは確認されました。',
        confirmEmailChange: 'サインイン用メールアドレスにする',
        signInToConfirm: 'この変更を確認するには、このデバイスでサインインしてください。',
        returnToSignIn: 'サインインに戻る',
        continue: '続ける',
        resetTitle: '新しいパスワードを設定',
        resetChooseNew: 'このHome用の新しいパスワードを選んでください。',
        resetComplete: 'パスワードを変更しました。新しいパスワードで再度サインインしてください。',
        resetSignsOutOtherDevices: '新しいパスワードを設定すると、このアカウントは他のすべての場所からサインアウトされます。',
        setNewPassword: '新しいパスワードを保存',
        emailPlaceholder: 'you@example.com',
        accountDisabled: ({ home }: { home: string }) => `このアカウントは ${home} で無効になっています。Homeの管理者に再有効化を依頼してください。`,
        verificationSent: ({ email }: { email: string }) => `${email} に確認リンクを送信しました。リンクを開いてアカウント作成を完了してください。`,
        resetInstructionsSent: ({ email }: { email: string }) => `${email} でここにサインインできる場合、再設定の手順を送信しました。`,
        verificationPending: ({ email }: { email: string }) => `${email} に確認メールを送信しました`,
        verifyDestination: ({ email }: { email: string }) => `このリンクは ${email} を確認します。`,
        passwordNeedsEmail: '先にサインイン用メールを追加してください',
        passwordNeedsEmailHint: 'サインイン用メールから始めます',
        setupStepConfirm: '確認',
        setupProgress: ({ step, total, label }: { step: number; total: number; label: string }) => `ステップ ${step}/${total}: ${label}`,
        setupEmailHint: 'サインイン用メールとパスワードは一緒に追加されます。まずアドレスを確認するリンクを送信します。',
        setupConfirmHint: 'メール内のリンクを開いてパスワードを設定してください。',
        setupPasswordHint: '確認したメールアドレスを入力し、パスワードを設定してください。',
    } } as const;

return { nativePasswordTranslations };
})();

const Domain_navigationPlacementTranslations = (() => {
type NavigationPlacementTranslation = Shared_navigationPlacementTranslations.NavigationPlacementTranslation;

const navigationPlacementTranslations = { ja: { customize: 'カスタマイズ…', title: 'ナビゲーション', description: '表示、「その他」、非表示を選択します。ドラッグして並べ替え。このデバイスに保存されます。', pinned: '固定', overflow: 'その他', hidden: '非表示', reset: 'リセット', appRail: '左レール', sessionRail: 'セッションレール', workspaceRail: 'ワークスペースレール', sessionTabBar: 'スマートフォンのタブバー', phoneLauncher: 'スマートフォンのショートカット', composer: '入力欄' } } satisfies Pick<Record<string, NavigationPlacementTranslation>, "ja">;

return { navigationPlacementTranslations };
})();

const Domain_pendingNavigationTranslations = (() => {
type Count = Shared_pendingNavigationTranslations.Count;

const en = Shared_pendingNavigationTranslations.en;

const ja: typeof en = {
    nextWithCount: ({ count }) => `${count}件が応答を待っています`,
    next: '次へ', answeredElsewhere: '回答済みです',
    unavailableTitle: '次のリクエストを開けませんでした',
    unavailableBody: '応答待ちのセッションの一部を利用できません。再接続してもう一度お試しください。',
    skippedUnavailable: ({ count }) => `利用できないセッション${count}件をスキップしました。`,
    waitsForPermission: 'が許可を求めています', waitsForInput: 'が回答を待っています',
    sessionsWaiting: ({ count }) => `${count}件のセッションが待っています`, go: '移動', dismiss: '後で',
    nothingWaiting: '今は対応が必要なものはありません',
};

const pendingNavigationTranslations = { ja };

return { pendingNavigationTranslations };
})();

const Domain_personalHomeBootstrapBlockedTranslations = (() => {
type PersonalHomeBootstrapBlockedTranslation = Shared_personalHomeBootstrapBlockedTranslations.PersonalHomeBootstrapBlockedTranslation;

const personalHomeBootstrapBlockedTranslations = { ja: {
        blocked: {
            runtime_unhealthy: 'ローカル Home を起動するには対応が必要です。',
            home_auth_invalid: 'Home の認証に対応が必要です。',
            existing_runtime: 'セットアップを続ける前に、既存のローカル Home をどうするか選択してください。',
            existing_runtime_credentials: 'このローカル Home は、このコンピューター上の別の Happier アプリのものです。',
            personal_home_erased: 'パーソナル Home は削除されました。もう一度試して新しく作成してください。',
        },
        blockedBody: { personal_home_erased: 'Home のデータは削除されました。ここに復元できるものはありません。新しいパーソナル Home を作成するか、別の Home を使ってください。' },
    } } as const satisfies Pick<Record<string, PersonalHomeBootstrapBlockedTranslation>, "ja">;

return { personalHomeBootstrapBlockedTranslations };
})();

const Domain_personalHomeDecisionTranslations = (() => {
type HomeParams = Shared_personalHomeDecisionTranslations.HomeParams;

type PersonalHomeDecisionTranslation = Shared_personalHomeDecisionTranslations.PersonalHomeDecisionTranslation;

const en = Shared_personalHomeDecisionTranslations.en;

const ja: PersonalHomeDecisionTranslation = {
    homeIdentityAmbiguous: 'このパーソナル Home のアドレスは、複数の保存済み Home に一致します。',
    signedInHome: {
        status: 'すでに別の Home にサインインしています。',
        body: ({ home }: HomeParams) => `このコンピューターは ${home} にサインインしています。そのまま使い続けるか、ここにパーソナル Home を設定できます。`,
        keep: ({ home }: HomeParams) => `${home} を使い続ける`,
        keepDetail: 'セッションとマシンはそのまま残ります。',
        create: 'パーソナル Home を設定',
        createDetail: 'このコンピューターにプライベートな Home を作成して切り替えます。',
    },
    existingRuntimeCredentials: {
        body: 'この Home の復元キーがないと、このアプリでは開けません。キーでサインインするか、別の Home を使用してください。',
        signIn: '復元キーでサインイン',
        signInDetail: 'このローカル Home 用に保存した復元キーを使います。',
    },
};

const personalHomeDecisionTranslations = { ja };

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

const ja = {
    standardOnlyTitle: 'Homeのアドレス経由で接続',
    standardOnlySubtitle: 'このデバイスでは、ピアツーピア接続の代わりに各Homeのアドレスを使用します。',
    installOrUpdateAction: 'パーソナル Home をインストールまたは更新', startAction: 'パーソナル Home を開始', stopAction: 'パーソナル Home を停止',
    defaultHomeLabel: 'パーソナル Home', homeTitle: 'Home', canonicalAddress: 'Home のアドレス', identityComparison: '現在の Home', identityComparisonMatch: '一致', identityComparisonMismatch: '不一致', identityComparisonUnknown: '確認できません',
    unknownSize: 'サイズ不明', unknownTimestamp: 'タイムスタンプ不明', restoreBackupTitle: 'バックアップ', identityTitle: 'Home の識別情報', identityUnavailable: '識別情報を利用できません', restoreBackupDate: '作成日時', restoreCompatibility: '互換性', restoreCompatible: '互換', restoreCompatibilityVerified: 'このバージョンで検証済み', restoreBackupSize: 'サイズ', restoreReplacementNotice: '現在の Home データは置き換えられます。検証済みの復旧バックアップは保持されます。', restoreConfirmTitle: 'このパーソナル Home を置き換えて復元しますか？', restoreConfirmAction: '置き換えて復元', relocateConfirmTitle: 'このパーソナル Home を移動しますか？', relocateConfirmBody: '検証済みのコピーが移動先で有効になる前に、現在の Home は停止します。', relocateDestination: '移動先', relocateConfirmAction: 'Home を移動', recoverRestoreTitle: '中断された復元を復旧しますか？', recoverRestoreBody: '保持されている復旧データを使って中断された復元をロールバックします。', recoverRestoreAction: '復元を復旧', eraseDataTitle: 'パーソナル Home のデータを削除しますか？', eraseHomeTarget: 'Home', eraseDataBody: 'これはアンインストールとは別の操作で、解決された次の Home パスだけを完全に削除します：', estimatedSize: '推定サイズ', summaryTitle: 'パーソナル Home', footer: 'Home はこのコンピューターに残ります。これらの操作で別の Home が変わることはありません。', statusTitle: 'ステータス', notAvailable: '利用できません', storageTitle: 'ストレージ', masterSecretTitle: 'Home アクセスシークレット', masterSecretPresent: 'あり', masterSecretUnavailable: '利用できません', inspectAction: 'Home の詳細を更新', actionsTitle: 'バックアップと復元', protectionTitle: '保護', backupsSectionFooter: 'バックアップには、読める状態の会話、Home データ、信頼済みデバイスの状態、Home アクセスシークレットが含まれます。信頼できる場所にだけ保存してください。', lastBackupTitle: '最新のバックアップ', lastBackupUnknown: '最新のバックアップは不明です', backupsTitle: 'バックアップアーカイブ', backupAction: '今すぐバックアップ', backupSubtitle: 'プレーンテキストの Home アーカイブを作成して検証します。', exportBackupAction: 'バックアップをエクスポート…', exportBackupSubtitle: '選択した場所に検証済みバックアップを作成します。', verifyAction: 'バックアップを検証…', verifySubtitle: '復元せずにアーカイブを確認します。', restoreAction: '復元…', restoreSubtitle: 'Home データを置き換える前にバックアップを検証します。', relocateAction: 'Home を移動…', relocateSubtitle: 'この Home を管理対象のコンピューターへ移動します。', relocationFinishAction: '移動を完了', relocationReturnAction: '元の Home に戻る', relocationFinishSubtitle: '移動先の検証後に Home の移動を完了します。', relocationReturnSubtitle: '元の Home をアクティブな場所として維持します。', recoverRestoreSubtitle: '中断された復元は明示的にロールバックできます。', restoreRecoveryWarningTitle: '復元の修復が必要です', restoreRecoveryWarningBody: '復旧状態が不明確です。自動変更は行いません。この Home を修復する前に診断を確認してください。', restoreCleanupWarningTitle: '復元後のクリーンアップを確認してください', restoreCleanupWarningBody: 'Home は復元されましたが、自動クリーンアップが完了しませんでした。診断を確認して Home の操作を再試行してください。', backupVerified: 'バックアップを検証済み', backupNeedsAttention: 'バックアップを検証済み；Home の再起動に注意が必要です', backupHomeReady: 'Home を再起動しました', backupRevealAction: 'バックアップを表示', restoreResultTitle: '復元結果', restoreOutcomeRecoveryRequired: '復旧が必要です', restoreOutcomeRolledBack: '復元をロールバックしました', restoreOutcomeRestored: 'Home を復元しました', advancedTitle: '詳細設定', advancedFooter: 'このコンピューターのランタイム操作と診断です。', restartAction: 'パーソナル Home を再起動', openDataLocationAction: 'Home データの場所を開く', openLogsAction: 'ランタイムログを開く', removeProfileAction: 'Happier から Home を削除', removeProfileSubtitle: 'このプロファイルを削除します。ランタイムデータはこのコンピューターに残ります。', removeProfileTitle: 'パーソナル Home プロファイルを削除しますか？', removeProfileBody: 'プロファイルは削除されますが、ランタイムとデータは保持されます。', uninstallRuntimeAction: 'ランタイムをアンインストール（データを保持）', uninstallRuntimeSubtitle: 'サービスとバイナリを削除します。Home データは保持されます。', deleteHomeDataTitle: 'Home データを削除', removeSectionFooter: 'アンインストールでは Home データが保持されます。完全な削除は別途確認が必要です。', eraseDataAction: 'パーソナル Home のデータを完全に削除', eraseDataSubtitle: 'アンインストールとは別です。解決された Home データを完全に削除します。', eraseResultTitle: 'Home データを削除しました', eraseStoppedHome: '実行中の Home を停止しました', eraseHomeAlreadyStopped: 'Home はすでに停止しています', eraseRemainingPaths: '削除できませんでした', progressTitle: 'パーソナル Home の操作', dismissResult: '閉じる',
    repairSearchAction: 'Home の検索を再構築',
    repairSearchSubtitle: 'この Home の会話から検索インデックスを作り直します。',
    repairSearchCompleteTitle: 'Home の検索を再構築しました',
    repairSearchCompleteBody: 'この Home の会話から検索インデックスを作り直しました。',
    backupCleanupRequired: 'バックアップは安全です。詳細に表示された保護済みステージングパスを削除してください',
    backupCleanupPath: '削除する保護済みステージングパス',
    backupCleanupError: 'クリーンアップエラー',
    backupDestinationMismatch: 'バックアップは選択した保存先に作成されませんでした。何も削除していません。',
    backupDestinationUnsafe: '選択したバックアップ先は、削除対象のパーソナル Home データの内部にあります。何も削除していません。',
    eraseInspectionAttention: 'Home のデータを削除しました。検証に確認が必要です',
    searchTitle: '検索',
    searchReady: '利用可能',
    searchIndexing: 'インデックス作成中…',
    searchUnavailable: '利用できません',
    localOnlyIngressTitle: 'このコンピューターからのみ到達可能',
    localOnlyIngressBody: '公開共有、プロバイダーのコールバック、プラグインの Webhook、このコンピューターのスリープ中の通知は、この Home が外部から到達可能になるまで利用できません。',
} satisfies PersonalHomeSettingsCopy;

const backupDisclosureBody = { ja: 'このバックアップには、読み取り可能な会話、Home データ、Home アクセスシークレット、信頼済みデバイスの状態が含まれます。完全なアーカイブを復元できる人は、この Home のクローンを運用できます。信頼できる場所に保存してください。' } as const;

const eraseBackupOffer = { ja: { title: '先にこの Home をバックアップしますか？', body: 'Home データの削除は元に戻せません。先に検証済みバックアップを作成するか、バックアップなしで続行してください。', continueWithoutBackup: 'バックアップせずに続行' } } as const;

const operationOutcome = { ja: {
        erasePartialTitle: '一部の Home データを削除できませんでした',
        eraseOutcomeSummary: ({ removed, remaining }) => `${removed} 件を削除しました`
            + (remaining > 0 ? `。${remaining} 件は削除できませんでした` : ''),
        eraseNotPerformed: '何も削除されていません',
        eraseBlockedBackupMismatch: 'このバックアップは別の Home のものです。',
        eraseBlockedIdentityUnknown: 'Happier はこのバックアップがこの Home のものか確認できませんでした。',
        eraseVerificationDetail: '検証',
        operationFailed: 'この Home の操作は完了しませんでした。詳細を開いて状況を確認してください。',
        restorePreviousDataTitle: '以前のデータを保存しました',
    } } as const satisfies Pick<Record<string, OperationOutcomeCopy>, "ja">;

const personalHomeSettingsTranslations = { ja: { ...ja, ...operationOutcome.ja, backupDisclosureBody: backupDisclosureBody.ja, eraseBackupOfferTitle: eraseBackupOffer.ja.title, eraseBackupOfferBody: eraseBackupOffer.ja.body, eraseContinueWithoutBackup: eraseBackupOffer.ja.continueWithoutBackup } } as const;

return { backupDisclosureBody, eraseBackupOffer, operationOutcome, personalHomeSettingsTranslations };
})();

const Domain_personalizeTranslations = (() => {
type PersonalizeTranslation = Shared_personalizeTranslations.PersonalizeTranslation;

const en = Shared_personalizeTranslations.en;

const pluralPl = Shared_personalizeTranslations.pluralPl;

const pluralRu = Shared_personalizeTranslations.pluralRu;

const ja: PersonalizeTranslation = {
    cardTitle: 'Happier をパーソナライズ',
    cardSubtitle: '6 つの簡単な選択。どれもその場でプレビューできます。',
    cardAction: 'パーソナライズ',
    cardContinue: '続ける',
    cardProgress: ({ saved, total, step }) => `${total} 件中 ${saved} 件を保存済み。「${step}」から再開します。`,
    cardProgressReview: ({ saved, total }) => `${total} 件中 ${saved} 件を保存済み。設定を確認しましょう。`,
    inPlaceTitle: 'Happier を自分好みに',
    inPlaceBody: '6 つの簡単な選択。どれもその場でプレビューできます。まずは見た目から。選ぶとホームがすぐに変わります。',
    inPlaceContinue: ({ count }) => `続ける · 残り ${count}`,
    notNow: '今はしない',
    flowTitle: 'Happier をパーソナライズ',
    finishLater: 'あとで終える',
    later: 'あとで',
    stepEyebrow: ({ n, total, name }) => `ステップ ${n}/${total} · ${name}`,
    stepCounter: ({ n, total }) => `${n}/${total}`,
    styleEyebrow: '任意',
    summaryEyebrow: '準備完了',
    previewNote: 'プレビューです。「次へ」を押すまで何も保存されません。',
    previewNoteSummary: '現在のワークスペースです。',
    next: '次へ',
    review: '確認',
    useThisSetup: 'この設定を使う',
    saveFailed: 'このステップは保存されませんでした。選択はそのまま残っています。',
    tryAgain: 'もう一度試す',
    skipThisStep: 'このステップをスキップ',
    scopeThisDevice: 'このデバイス',
    scopeAllDevices: 'すべてのデバイス',
    stepsLabel: 'ステップ',
    savedStepsNote: ({ count }) => `${count} 件のステップは保存済みです。`,
    lookName: '見た目',
    lookTitle: '見やすく、心地よく',
    lookDescription: 'ライト、ダーク、システムに合わせるかを選び、アプリにどれだけガラスを使うかも決めます。',
    themeLabel: 'テーマ',
    glassLabel: 'ガラス',
    glassAutoDescription: 'アプリ全体に重なりのあるガラス',
    glassEverywhereDescription: 'どこでも均一なガラス',
    glassSolidDescription: 'すべての面を不透明に',
    glassCustomNote: '外観でガラスを調整済みです。プリセットを選ぶと置き換わります。今の設定を残すこともできます。',
    customizeInAppearance: '外観でカスタマイズ…',
    styleName: 'スタイル',
    styleTitle: 'スタイルから始める',
    styleDescription: 'スタイルごとに、セッションの読み方と一覧の見た目が決まります。次のステップに値を入れるだけで、各ステップで「次へ」を押すまで何も保存されません。',
    styleKeep: '現在の設定を維持',
    styleActivity: 'アクティビティ',
    styleConversation: '会話',
    styleDetail: '詳細',
    styleCustomTag: 'カスタム',
    styleDefaultTag: 'Happier の標準',
    styleChanges: ({ style, count }) => `${style} で ${count} 件の項目が変わります`,
    styleNoChanges: 'すでにこの設定になっています。',
    styleNever: 'テーマ、通知、プライバシー、エージェントの権限はスタイルに含まれません。',
    was: ({ value }) => `変更前: ${value}`,
    conversationName: '会話',
    conversationTitle: '会話を追う',
    conversationDescription: 'セッションのターンとエージェントの思考の表示方法です。',
    layoutLabel: 'レイアウト',
    thinkingLabel: '思考',
    toolsName: 'ツール呼び出し',
    toolsTitle: 'エージェントの作業を確認',
    toolsDescription: 'コマンド、編集、読み取りをセッションでどう表示するかです。',
    toolsLabel: 'ツール呼び出し',
    toolTapLabel: 'ツールをクリックしたとき',
    toolDetailLabel: 'ツールの詳細',
    toolDetailDefault: '標準',
    toolDetailFull: 'すべて',
    workName: '作業',
    workTitle: '作業を見つける',
    workDescription: 'セッション一覧の整理方法と、各行に表示する情報量です。',
    listLayoutLabel: 'セッション一覧',
    rowsLabel: '行',
    attentionName: '要対応',
    attentionTitle: '対応が必要なものに気づく',
    attentionDescription: 'あなたを待っているセッションや確認できるセッションを、一覧のどこに表示するかです。',
    attentionLabel: '対応が必要なセッション',
    attentionHomeNote: 'ホームには対応が必要なものが常に表示されます。ここではセッション一覧だけが変わります。',
    notificationsName: '通知',
    notificationsTitle: '状況を把握する',
    notificationsDescription: 'ほかのものを見ているときに、このデバイスが知らせる内容です。',
    notificationsAllowed: 'このデバイスでは通知が許可されています。',
    notificationsNotAllowed: 'このデバイスではまだ Happier の通知を表示できません。',
    notificationsUnsupported: 'このデバイスでは通知を利用できません。デスクトップアプリまたはスマートフォンで設定してください。',
    scopeLook: 'テーマはこのデバイス · ガラスはすべてのデバイス',
    notificationsNeedsYouSummary: '確認が必要',
    notificationsFinishedSummary: '完了',
    notificationsAllow: '通知を許可',
    notificationsTellMe: '通知するタイミング',
    notificationsNeedsYou: 'セッションが承認や回答を求めたとき',
    notificationsFinished: 'セッションがターンを終えたとき',
    notificationsShowLabel: '通知に表示する内容',
    notificationsShowDescription: 'コマンド、質問、返信がロック画面に表示されることがあります。',
    notificationsMessage: 'メッセージ',
    notificationsStatus: 'ステータスのみ',
    notificationsPhoneNote: 'Happier を閉じているときのスマートフォンへの通知は、スマートフォン側で設定します。',
    notificationsOff: '通知なし',
    sampleNeedsYouTitle: 'レビュー #2481 が対応を待っています',
    sampleNeedsYouBody: 'エージェントが ~/happier で yarn test:e2e を実行しようとしています。許可しますか？',
    sampleReadyTitle: '「不安定な再接続テストを修正」を確認できます',
    sampleReadyBody: '原因が見つかりました。リトライタイマーがクリアされていませんでした。修正済みで、テストも通ります。',
    sampleStatusBody: 'Happier を開いて確認してください。',
    sampleSessionReconnect: '不安定な再接続テストを修正',
    sampleSessionCraft: '仕上げラボ',
    sampleSessionReview: 'レビュー #2481',
    sampleSessionPricing: '料金ページの文言',
    sampleSessionDocs: 'ドキュメント検索インデックス',
    sampleWorking: '作業中',
    sampleNeedsYou: '対応待ち',
    sampleReady: '確認待ち',
    summaryTitle: 'あなたの設定',
    summaryDescription: ({ changed }) => changed === 0
        ? '以下はすべて保存済みです。変更はありません。'
        : `以下はすべて保存済みです。${changed} 件の選択を変更し、ほかはそのままです。`,
    summaryChange: '変更',
    summaryFooter: 'これらはあとで設定から変更できます。設定 → 外観からもう一度たどることもできます。',
    replayTitle: 'Happier をパーソナライズ',
    replaySubtitle: '6 つの簡単な選択。どれもその場でプレビューできます。',
    replayAction: '始める',
    journeyHandoff: '自分好みに',
};

const personalizeTranslations = { ja } satisfies Pick<Readonly<Record<string, PersonalizeTranslation>>, "ja">;

return { personalizeTranslations };
})();

const Domain_phoneNavigationTranslations = (() => {
const en = Shared_phoneNavigationTranslations.en;

const ja: typeof en = {
    phoneNav: {
        settings: {
            sectionDescription: 'セッション内のスマホ向けレイアウトと、そのバーのジェスチャーです。ジェスチャーはそれぞれ個別にオフにできます。',
            swipeSidewaysTitle: '横にスワイプしてセッションを切り替え',
            swipeSidewaysScrollsDescription: 'バー上で前後のセッションへ。ツールが収まらないときは、スワイプでツールがスクロールします。',
            swipeSidewaysAlwaysDescription: 'バー上で前後のセッションへ。常にスワイプとして動作し、収まらないツールは「その他」に入ります。',
            alwaysSwipeTitle: '常にセッション間をスワイプ',
            alwaysSwipeOnDescription: '収まるツールはバーに残し、残りは「その他」に入ります。',
            alwaysSwipeOffDescription: 'オフ：ツールが多いとバーがスクロールします。',
            dragUpTitle: '上にドラッグして切り替え',
            dragUpDescription: 'バーを上にドラッグして開いているタブと最近のセッションを表示し、スライドして選びます。',
            dragUpSourceTitle: '上にドラッグで表示するもの',
            dragUpSourceRecentDescription: '開いているタブと、このデバイスで最近開いたもの。',
            dragUpSourceListDescription: 'リストの順のセッション。',
            swipeSourceTitle: '横スワイプで表示するもの',
            swipeSourceListDescription: 'リストの次または前のセッション。',
            swipeSourceRecentDescription: '最後に開いた順での次または前のセッション。',
            sourceRecent: '最近',
            sourceList: 'セッションリスト',
            flickTitle: '上下にフリックして切り替え',
            flickDescription: '素早くフリックすると次または前のセッションが開きます。',
            holdToDockTitle: '長押しで切り替えを開いたままにする',
            holdToDockDescription: 'バーを長押しして指を離し、タップで選びます。',
            pullAllTabsTitle: 'タイトルを下に引いてすべてのタブを表示',
            pullAllTabsDescription: 'セッションのタイトルを下にドラッグすると、開いているタブと最近のセッションがすべて表示されます。',
        },
        bar: {
            onTheBar: 'バーに表示',
            more: 'その他',
            heldInMore: '「常にスワイプ」がオンの間は「その他」に表示',
            keepOnBar: 'バーに残す',
            removeFromBar: 'バーから外す',
            openFiles: 'ファイルを開く',
        },
        allTabs: {
            title: 'すべてのタブ',
            pullHint: '引いてすべてのタブを表示',
            releaseHint: '離してすべてのタブを表示',
            openTabs: '開いているタブ',
            openTabsSynced: '開いているタブ · 同期済み',
            recent: '最近',
            recentOnThisDevice: 'このスマホの最近',
            here: 'ここ',
            panes: ({ count }: { count: number }) => `${count} ペイン`,
            emptyTitle: 'ほかに開いているものはありません',
            emptyDescription: '開いたセッションと残したタブがここに表示されます。新しい順です。',
            openTab: ({ title }: { title: string }) => `${title} を開く`,
        },
        rail: {
            label: '開いているタブ',
            synced: '同期済み',
            syncedA11y: '開いているタブはデバイス間で同期されます',
            notAvailableTitle: 'このスマホでは利用できません',
            notAvailableUnknown: 'このタブは別のデバイスで開かれたため、このスマホでは表示できません。そちらでは開いたままです。',
            closeTab: 'タブを閉じる',
            paneOf: ({ position, total }: { position: number; total: number }) => `${position} / ${total}`,
            nextPane: '次のペイン',
            chatPane: 'Chat',
        },
        switcher: {
            title: '切り替え先',
            allSessions: 'すべてのセッション',
            openTabs: '開いているタブ',
            synced: '同期済み',
            recent: '最近',
            recentOnThisDevice: 'このスマホの最近',
            sessions: 'セッション',
            nextInSessions: 'セッションの次へ',
            previousInSessions: 'セッションの前へ',
            furtherBack: 'さらに前',
            moreRecent: 'より新しい',
            here: 'ここ',
            stayOn: 'このまま',
            noOlderSessions: 'これより古いセッションはありません',
            noNewerSessions: 'これより新しいセッションはありません',
            lastInSessions: 'セッションの最後です。',
            firstInSessions: 'セッションの最初です。',
            nothingFurtherBack: 'これより前はありません。',
            mostRecent: 'いちばん新しいものです。',
            nothingToSwitch: 'ほかに開いているものはありません',
            nothingToSwitchDescription: '開いたセッションがここに表示されます。新しい順です。',
            draft: ({ text }: { text: string }) => `下書き：「${text}」`,
            switchSessionAction: 'セッションを切り替え',
            switchedTo: ({ name }: { name: string }) => `${name} に切り替えました`,
            close: '閉じる',
            positionOf: ({ position, total }: { position: number; total: number }) => `${position} / ${total}`,
        },
    },
};

const phoneNavigationTranslations = { ja };

return { phoneNavigationTranslations };
})();

const Domain_pluginAccountDataEraseTranslations = (() => {
const english = Shared_pluginAccountDataEraseTranslations.english;

const pluginAccountDataEraseTranslations = { ja: {
    accountDataErase: {
        installedGroupTitle: 'アカウントデータ',
        installedGroupFooter: 'これは、現在のアカウントの保持データのみに影響します。このプラグインはどのマシンからもアンインストールされません。',
        installedEntryTitle: 'アカウントデータの消去',
        installedEntrySubtitle: 'このプラグインの保持データを現在のアカウントから永久に削除します。',
        orphanedGroupTitle: 'プラグインデータの保持',
        orphanedGroupFooter: 'プラグインが削除された後に、プラグイン ID を使用して、保持されているアカウント データを削除します。',
        orphanedEntryTitle: '保持されているプラグインデータを消去する',
        orphanedEntrySubtitle: '現在のアカウント データを完全に消去するには、インストールまたは削除したプラグイン ID を入力します。',
        promptTitle: 'プラグインID',
        promptBody: '現在のアカウントから保持データを消去するプラグインの ID を入力します。',
        promptPlaceholder: 'com.example.プラグイン',
        invalidTitle: 'プラグインIDを入力してください',
        invalidBody: '続行する前に、正確なプラグイン ID を使用してください。',
        confirmTitle: 'アカウントプラグインデータを消去しますか?',
        confirmBody: ({ pluginId }: { pluginId: string }) => `これにより、保持されているデータが永久に削除されます。 ${pluginId} 現在のアカウントから。プラグインはマシンからアンインストールされません。`,
        confirm: 'データの消去',
        completedTitle: 'アカウントプラグインデータが消去されました',
        completedChanged: '保持されているプラグイン データは現在のアカウントから削除されました。',
        completedEmpty: '現在のアカウントでは、このプラグインに対して保持されているプラグイン データが見つかりませんでした。',
        partialTitle: 'プラグインデータが一部残っている',
        partialBody: '一部の保持データが消去できませんでした。自動的に再試行されるものはありません。残りのデータを消去してみてください。',
        failedTitle: 'プラグインデータは消去されませんでした',
        failedBody: '保持されているデータを消去できませんでした。現在のアカウント接続を確認してから再試行してください。',
        unavailableTitle: 'プラグインデータが利用できません',
        unavailableBody: '現在のアカウントが変更されているか、使用できません。アカウントの準備ができたら、このアクションを再度開いてください。',
    },
} } as const;

return { pluginAccountDataEraseTranslations };
})();

const Domain_pluginAccountReleaseSelectionTranslations = (() => {
const english = Shared_pluginAccountReleaseSelectionTranslations.english;

const completeReleaseSelection = Shared_pluginAccountReleaseSelectionTranslations.completeReleaseSelection;

const localizedPluginAccountReleaseSelectionTranslations = { ja: {
    accountReleaseSelection: {
        groupTitle: 'アカウントのリリース',
        groupFooter: 'このアカウントの正確なリリースを選択してください。これにより、プラグインはどのマシンにもインストール、更新、または信頼されません。',
        entryTitle: 'このアカウントに使用する',
        entrySubtitle: ({ version }: { version: string }) => `バージョンの選択 ${version} マシンのインストールを変更することなく、現在のアカウントに適用されます。`,
        selectedTitle: 'アカウントのリリースが選択されました',
        selectedBody: '選択したプラグイン リリースがこのアカウントに使用されるようになります。',
        conflictTitle: 'アカウントリリースが変更されました',
        conflictBody: 'このアクションが開いている間にアカウントのリリースが変更されました。再度開いて、もう一度試してください。',
        unavailableTitle: 'アカウントのリリースは利用できません',
        unavailableBody: '現在のアカウントでは、正確なリリースまたはその必要な移行ソースを利用できません。アカウントの準備ができたら、もう一度お試しください。',
        rejectedTitle: 'アカウントのリリースが選択されていませんでした',
        rejectedBody: 'アカウントはこのリリースの選択を受け入れませんでした。アカウントの状態を確認して、再試行してください。',
        hostedGroupFooter: 'このアカウントがプラグイン用にホストしているプラグインのアーティファクトを管理します。現在このリリースを提供しているマシンがないため、ここでは選択できません。',
        hostedEnableTitle: 'このアカウントでプラグインのアーティファクトをホストする',
        hostedEnableBody: "このプラグインの UI とパッケージリソースをアカウントのサーバーに保存します。平文アカウントではサーバーがデータを読み取れます。E2EE アカウントでは暗号化されたデータを保存します。リリースのメタデータは引き続き見えます。これはプラグインのインストールや信頼の承認ではなく、オフラインのマシンでの実行も可能にはしません。",
        hostedDisableTitle: 'プラグインのアーティファクトのホストを停止する',
        hostedStatusDisabled: "無効です。ホストを有効にすると、ソースマシンがオフラインでもこのリリースのアーティファクトをダウンロードできます。",
        hostedStatusPending: '有効です。このリリースは、ホストが正確なプラグインのアーティファクトを公開するのを待っています。',
        hostedStatusReady: 'この正確なリリースのホスト済みプラグインのアーティファクトを利用できます。',
        hostedStatusFailed: '他のデバイスではまだこのページを開けません。このデバイスでは引き続き使えます。',
        hostedStatusFailedChip: 'このデバイスのみ',
        hostedRemoveTitle: 'ホストを無効にしてアーティファクトを削除する',
        hostedRemoveBody: 'アカウントでのホストを停止し、このリリースの正確なホスト済みプラグインのアーティファクトを削除します。ローカルキャッシュの削除は別の操作です。',
        hostedClearCacheTitle: 'ローカルのアーティファクトキャッシュを消去する',
        hostedClearCacheBody: 'アカウントでのホスト設定を変更せずに、この正確なリリースのローカルにキャッシュされた UI アーティファクトのバイトを削除します。',
    },
} } as const;

const pluginAccountReleaseSelectionTranslations = { ja: completeReleaseSelection(localizedPluginAccountReleaseSelectionTranslations.ja) };

return { localizedPluginAccountReleaseSelectionTranslations, pluginAccountReleaseSelectionTranslations };
})();

const Domain_pluginInvocationLogTranslations = (() => {
const en = Shared_pluginInvocationLogTranslations.en;

const ja = {
    invocationLogs: {
        title: '呼び出しログ',
        footer: '選択したプラグインマシンから取得した、件数を制限し機密情報を伏せた記録です。',
        correlationFilter: '相関 ID フィルター',
        correlationFilterAll: 'このプラグインのすべての呼び出し',
        correlationPromptTitle: '相関 ID で絞り込む',
        correlationPromptBody: '1 回の厳密なプラグイン呼び出しの記録だけを表示します。空欄にするとすべての記録を表示します。',
        correlationPromptPlaceholder: '相関 ID',
        refresh: 'ログを更新',
        follow: 'ログを追跡',
        stopFollowing: '追跡を停止',
        loadMore: '次の記録を読み込む',
        loadingTitle: '呼び出しログを読み込み中',
        loadingSubtitle: '選択したマシンから、件数を制限し機密情報を伏せた記録を読み取っています。',
        idleTitle: '呼び出しログを読み取れます',
        idleSubtitle: '更新すると、選択したマシンから件数を制限し機密情報を伏せた記録を読み取ります。',
        emptyTitle: '呼び出しログはありません',
        emptySubtitle: 'この選択したマシンには、条件に一致する伏せ字済みの記録がありません。',
        unavailableTitle: '呼び出しログを利用できません',
        unavailableSubtitle: '選択したプラグインマシンは利用できないか、現在のマシンではありません。',
        readerUnavailableSubtitle: '選択したプラグインマシンは現在、呼び出しログを提供できません。',
        selectionRequiredTitle: 'プラグインマシンを選択',
        selectionRequiredSubtitle: 'ログを読む前に、上で互換性のあるプラグインの実体化を 1 つ選択してください。',
        conflictTitle: '選択したプラグインマシンを解決',
        conflictSubtitle: 'ログを読む前に、上で互換性のあるプラグインの実体化を 1 つ選択してください。',
        errorTitle: '呼び出しログを読み込めませんでした',
        errorSubtitle: 'ログの読み取りは完了しませんでした。選択したマシンが利用可能になってから再試行してください。',
        noMessage: 'プラグインログイベント',
        level: {
            debug: 'デバッグ',
            info: '情報',
            warn: '警告',
            error: 'エラー',
            diagnostic: '診断',
        },
    },
};

const pluginInvocationLogTranslations = { ja } as const;

return { pluginInvocationLogTranslations };
})();

const Domain_pluginMachineMatrixTranslations = (() => {
const english = Shared_pluginMachineMatrixTranslations.english;

const pluginMachineMatrixTranslations = { ja: {
        machineMatrix: {
            title: 'あなたのマシン全体',
            footer: '読み取り専用です。インストール、更新、その他すべてのプラグイン操作は、上で選択したマシンで実行されます。',
            empty: 'このアカウントのプラグインインストールを報告したマシンはまだありません。',
            unavailable: 'アカウントのプラグイン可用性がまだ読み込まれていないため、マシンの状態は不明です。',
            incomplete: ({ count }: { count: number }) => `このリストは不完全な可能性があります: ${count} 台のサーバーがまだマシンを報告していません。`,
            summary: ({ installed, total }: { installed: number; total: number }) => `${total} 台中 ${installed} 台にインストール済みかつ最新`,
            lastObserved: ({ ago }: { ago: string }) => `最終確認: ${ago}`,
            state: {
                installedCurrent: 'インストール済み・最新',
                disabled: '無効',
                untrusted: '未信頼',
                incompatible: '別のリリース',
                localOnly: 'このマシンのみ',
                staleOffline: '最後に確認された状態、マシンはオフライン',
                absent: '未インストール',
                unknown: '不明',
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

const marketplacePresentation = { ja: {
        diagnosticsIssueTitle: 'プラグインの問題', diagnosticsRecovery: '上の詳細を確認し、修正後にプラグインまたはこのページを再読み込みしてください。', diagnosticsTechnicalCode: ({ code }: { code: string }) => `技術コード：${code}`,
        discover: { publisherLabel: ({ displayName, id }: { displayName: string; id: string }) => `公開者ラベル：${displayName}（${id}）`, categories: ({ values }: { values: string }) => `カテゴリ：${values}`, runtimeSummary: ({ realms, platforms }: { realms: string; platforms: string }) => `実行場所：${realms} · プラットフォーム：${platforms}`, reviewStatus: { curated: '選定されたおすすめ', unreviewed: '未審査', withdrawn: '取り下げ済み' }, executableRealm: { daemon: 'バックグラウンドサービス', client: 'アプリ', hostedWeb: 'ホストウェブ' }, platform: { darwin: 'macOS', linux: 'Linux', windows: 'Windows', web: 'Web', ios: 'iOS', android: 'Android' }, diagnostic: { title: 'マーケットプレイスの提供元に問題があります', recovery: '「見つける」を更新してください。続く場合は「提供元とレジストリ」を確認してください。', unreachableTitle: ({ source }: { source: string }) => `${source} に接続できませんでした`, behindTitle: ({ source }: { source: string }) => `${source} から古いまたは不完全なデータが返されました`, indexTitle: 'プラグインのインデックスが不完全です', otherSourcesShown: 'ほかのソースの結果は引き続き表示されます。' } },
    } } as const;

const localizedTechnicalReviewVocabulary = { ja: { source: ({ kind, locator }: { kind: string; locator: string }) => `${kind}：${locator}`, sourceKind: { path: 'ローカルパス', archive: 'アーカイブファイル', npm: 'npm パッケージ' }, marketplaceSource: ({ kind, source }: { kind: string; source: string }) => `${kind}：${source}`, marketplaceSourceKind: { curated: '選定済みカタログ', 'community-npm': '公開 npm カタログ', user: 'ユーザーカタログ' }, executableRealm: { daemon: 'バックグラウンドサービスのコード', reactNative: 'アプリ画面のコード', hostedWeb: '分離されたホストウェブコード' }, uiArtifacts: ({ status, ids }: { status: string; ids: string }) => `${status}：${ids}`, uiArtifactStatus: { verified: '検証済み画面リソース', none: '画面リソースなし', unavailable: '画面リソースを利用できません' }, authorizationClass: { cooperativeDisclosure: '協調的な開示', hostResourceSelection: '選択したホストリソース', presentIntentOrOs: '現在の意図またはシステム権限' }, priority: ({ priority }: { priority: number }) => `優先度 ${priority}` } } as const;

const localizedReviewVocabulary = { ja: {
        installReviewSections: {
            ...localizedTechnicalReviewVocabulary.ja,
            archiveUrlRetention: 'Happier は今後の更新のため、認証情報が含まれている場合はそれも含めて、アーカイブの完全な URL を選択したマシンに保存します。URL の期限切れや失効により、更新に失敗することがあります。',
            trustedCodeTitle: '信頼するコード', trustedCodeDisclosure: 'プラグインは Happier 内で信頼済みコードとして実行され、サンドボックスでは隔離されません。プラグインは、下に示す Happier 経由のサービスにとどまらず、このアプリ自身の権限（ファイル、ネットワーク、環境、プロセス）を直接使用できます。下の一覧はプラグインが宣言した内容であり、後から無効にできる範囲でもありますが、そのコードが到達できる範囲を制限する境界ではありません。', identity: '識別情報とパッケージ', evidence: '技術的な証拠', executableCode: '実行コードと拡張項目', requiredAccess: '必須のホストアクセス', optionalAccess: '任意のホストアクセス', requestInterceptors: 'リクエストインターセプター', rawCredentials: '認証情報への直接アクセス宣言', compatibility: '互換性と更新', none: '宣言なし', scope: ({ scope }: { scope: string }) => `範囲：${scope}`, networkAccess: ({ methods, targets }: { methods: string; targets: string }) => `${targets} に ${methods} リクエストを送信できます`, networkAccessAnyMethod: ({ targets }: { targets: string }) => `${targets} にリクエストを送信できます`, networkTargetHostSuffix: ({ suffix }: { suffix: string }) => `${suffix} 配下の任意のホスト`, networkPrivate: ({ line }: { line: string }) => `${line}（プライベートネットワークを含む）`, developmentPath: ({ locator }: { locator: string }) => `${locator} · 開発版`, publisherUnverified: ({ displayName, id }: { displayName: string; id: string }) => `${displayName} · ${id} · 未検証`, integrityBasis: { expected: ({ integrity }: { integrity: string }) => `${integrity}（期待値）`, observed: ({ integrity }: { integrity: string }) => `${integrity}（観測値）` }, signatureStatus: { verified: ({ keyId }: { keyId: string }) => `レジストリ署名を検証済み：${keyId}`, unsupported: ({ keyId }: { keyId: string }) => `未対応のレジストリ署名：${keyId}` }, provenanceDeclaredUnverified: ({ predicateType }: { predicateType: string }) => `宣言済み・未検証：${predicateType}`, provenanceRetrievedUnverified: ({ predicateTypes }: { predicateTypes: string }) => `取得済み・未検証：${predicateTypes}`, provenanceUnavailable: ({ code }: { code: string }) => `来歴情報を利用できません：${code}`, curationUnreviewed: ({ sourceId }: { sourceId: string }) => `未審査のカタログソース：${sourceId}`, curationApproved: ({ sourceId, reviewedAt, reason }: { sourceId: string; reviewedAt: string; reason: string }) => `${sourceId} が ${reviewedAt} に審査${reason}`, savedSecret: '保存済みシークレット', connectedAccount: '接続済みアカウント', secretKinds: ({ kinds }: { kinds: string }) => `シークレットの種類：${kinds}`, connectedAccountService: ({ service }: { service: string }) => `サービス：${service}`, credentialPurpose: ({ purpose }: { purpose: string }) => `用途：${purpose}`, credentialUse: ({ realm, phase }: { realm: string; phase: string }) => `${realm} の「${phase}」段階で使用`, credentialAccess: ({ access }: { access: string }) => `アクセス内容：${access}`, credentialRequestHeaders: ({ origin, headers }: { origin: string; headers: string }) => `${origin} に送信されるヘッダー: ${headers}`, credentialRequestEnvironment: ({ keys }: { keys: string }) => `環境変数: ${keys}`, credentialRequestFiles: ({ files }: { files: string }) => `ファイル: ${files}`, realm: { web: 'ウェブクライアント', ios: 'iOS アプリ', android: 'Android アプリ', daemon: 'バックグラウンドサービス' }, phase: { settings: '設定', prepare: '準備', connection: '接続', speech: '音声利用' }, evidenceLabel: { integrity: '整合性', signature: '署名', provenance: '出所', curation: 'カタログ審査', happier: 'Happier のバージョン', publisher: '発行者' }, runtimeApi: ({ version }: { version: number }) => `ランタイム API ${version}`,
        },
        sourceAdministration: { title: 'ソースとレジストリ', subtitle: 'Happier が閲覧用のプラグインを探す場所です。組み込みのレジストリ、プラグインが追加したもの、あなたが追加したもの。', communityTitle: '公開 npm ディレクトリ', communitySubtitle: '組み込み · 公開 npm で対象の Happier プラグインを検索します。任意の npm パッケージが対象ではなく、結果は未審査です。', configuredTitle: 'マーケットプレイスソース', configuredEmpty: '追加のマーケットプレイスソースは設定されていません。', add: 'ソースを追加', edit: 'ソースを編集', remove: 'ソースを削除', removeTitle: 'マーケットプレイスソースを削除しますか？', removeBody: ({ name }: { name: string }) => `${name} はこのマシンの検索に使われなくなります。インストール済みプラグインは変更されません。`, sourceUrl: 'ソースのアドレス', displayName: '表示名', description: '説明（任意）', enabled: '有効', disabled: '無効', curated: '選定済みソース', user: '自分のソース', loadError: 'マーケットプレイスソースを読み込めませんでした。', retry: '再試行', operationFailed: '変更を適用できませんでした。マシンへの接続を確認して、もう一度お試しください。', operationOutcomeUnknownTitle: '変更の確認が必要です', operationOutcomeUnknownBody: '選択したマシンはこの変更を適用済みの可能性がありますが、Happier は結果を確認できませんでした。再度変更する前に、更新された設定を確認してください。' },
        updatePolicy: { title: '更新ルール', target: ({ machine, server }: { machine: string; server: string }) => `${server} 経由で ${machine} に適用されます。`, pinned: 'バージョンを固定', pinnedSubtitle: '別のルールを選ぶまで更新しません。', allowed: '更新を許可', allowedSubtitle: '明示的な更新は、宣言された権限が拡大しない限り再確認なしで続行します。' },
    } } as const;

const pluginMarketplaceDiscoverTranslations = { ja: {
        ...localizedReviewVocabulary.ja,
        ...marketplacePresentation.ja,
        secretFieldActions: { delete: '保存済みシークレットを削除', deleteHint: '保存された値を消去します。元に戻せません。', unbind: 'このプラグインから外す', unbindHint: 'この設定と保存済みシークレットの関連付けを解除します。シークレット自体は残ります。' },
        pluginChangeOutcomeUnknownTitle: '結果は未確認です',
        pluginChangeOutcomeUnknownBody: ({ action, name, machine, server }: { action: string; name: string; machine: string; server: string }) => `${name} の${action}が ${machine}（${server}）で完了したかどうかを Happier は確認できませんでした。再試行する前に、そのマシンのインストール済み一覧と現在のバージョンを確認してください。`,
        updateFromInstalledRecordSubtitle: 'このインストール自身の信頼された更新チャネルで更新します。',
        discover: {
            ...marketplacePresentation.ja.discover,
            status: {
                loading: 'すべてのマーケットプレイスソースを検索しています…',
                loadingSource: ({ source }: { source: string }) => `${source} を検索しています…`,
                results: ({ count, sources }: { count: number; sources: number }) =>
                    `${sources} 個のソースから ${count} 個のプラグイン`,
                empty: 'この検索に一致するプラグインはありません。',
                error: ({ message }: { message: string }) => `検索を更新できませんでした: ${message}`,
                errorTitle: '検索を更新できませんでした',
                stale: 'これらは以前の検索の結果です。上の設定を反映するにはもう一度検索してください。',
                partial: ({ count }: { count: number }) =>
                    `${count} 個のソースが古いデータまたは応答なしでした。結果は不完全な可能性があります。`,
                nonInstallable: ({ count }: { count: number }) =>
                    `${count} 件見つかりましたが、現在このマシンにはインストールできません。`,
            },
            sourceFreshness: {
                stale: 'このソースより古い状態',
                'stale-offline': '最後に判明した結果、ソースはオフライン',
                unavailable: 'ソースを利用できません',
                'auth-unavailable': 'このソースにはサインインが必要です',
                corrupt: 'ソースのインデックスを読み取れませんでした',
            },
            nonInstallableReason: {
                sourceStale: 'マーケットプレイスソースが最新ではありません。',
                artifactUnavailable: 'このマシンのレジストリアクセスではパッケージに到達できません。',
                notApproved: 'このソースからのインストールは承認されていません。',
                unsupportedSourceKind: 'このバージョンの Happier はこのソース種別に対応していません。',
            },
            installSubtitle: ({ source }: { source: string }) =>
                `${source} からのものを信頼する前に、このプラグインが宣言する内容をすべて確認してください。`,
            registrySelectionRequired: ({ origin }: { origin: string }) => `${origin} のレジストリプロファイルが必要です`,
            registrySelection: {
                title: ({ name }: { name: string }) => `${name} のレジストリを選択`,
                body: ({ name, origin, source }: { name: string; origin: string; source: string }) =>
                    `${name} は ${origin} で公開されています。このマシンで ${source} が使うレジストリプロファイルを選ぶか、追加してサインインしてください。「インストールして信頼」の確認までは何もダウンロードされません。`,
                continue: '続行',
            },
        },
    } } as const;

return { marketplacePresentation, localizedTechnicalReviewVocabulary, localizedReviewVocabulary, pluginMarketplaceDiscoverTranslations };
})();

const Domain_pluginPermissionTranslations = (() => {
type PermissionDetailsTranslation = Shared_pluginPermissionTranslations.PermissionDetailsTranslation;

const pluginPermissionTranslations = { ja: {
        fields: {
            pluginId: 'プラグイン ID',
            capability: '機能',
            scope: 'スコープ',
            requester: '要求元',
            authority: '権限元',
            requestedAt: '要求日時',
            reason: '理由',
        },
        scope: { account: 'アカウント', project: 'プロジェクト', workspace: 'ワークスペース' },
        requester: { user: 'ユーザー', host: 'ホスト', plugin: 'プラグイン' },
        authority: { bundled: '同梱', machineInstallation: 'マシンへのインストール' },
        identifiers: {
            session: 'セッション',
            request: '要求',
            machine: 'マシン',
            installation: 'インストール',
        },
        accessibilitySummary: ({ details }) => `権限要求の詳細。${details}`,
    } } as const satisfies Pick<Readonly<Record<string, PermissionDetailsTranslation>>, "ja">;

return { pluginPermissionTranslations };
})();

const Domain_pluginSettingsPresentationTranslations = (() => {
const english = Shared_pluginSettingsPresentationTranslations.english;

const pluginSettingsPresentationTranslations = { ja: {
        enablement: {"account": "アカウントで有効", "machine": "このマシンで有効", "description": "ここでプラグインを実行するには両方を有効にしてください。無効にしてもデータと接続は保持されます。"},
        rowStatus: { enabled: '有効', disabled: '無効', incompatible: '非対応', trustRemoved: '信頼を取り消し済み', needsAttention: '要確認' },
        developmentPhase: { observing: '監視中', preparingDependencies: '依存関係を準備中', compiling: 'コンパイル中', validating: '検証中', active: '有効', retainedIncumbent: '以前のバージョンが稼働中', unavailable: '利用不可' },
        developmentDiagnostic: { manifestMissing: 'このフォルダーにはプラグインのマニフェストがありません。.happier-plugin/plugin.json を追加するか、プラグインのフォルダーを選択してください。', projectMissing: 'このフォルダーはもうありません。開発から削除するか、プラグインの現在の場所を選択してください。' },
        rowSource: { bundled: 'Happier に同梱', npm: 'npm パッケージ', archive: 'アーカイブファイル', localPath: 'ローカルフォルダ', other: '設定済みのソース' },
        rowAttention: { trustRemoved: 'このプラグインはもう実行されません。コードを再び信頼するには再インストールしてください。', incompatible: 'このリリースは選択したマシンでは実行できません。' },
        developerGroupTitle: '開発',
        developerGroupFooter: '選択したマシンでプラグインを作り、そのサービスが報告する内容を確認します。',
        developerDevelopmentSubtitle: '自分のフォルダからプラグインを作成・編集・テスト・パックします。',
        developerDiagnosticsSubtitle: '選択したマシンのサービスとカタログの診断。',
        detailMissingTitle: 'このプラグインは選択したマシンにありません',
        detailMissingBody: ({ pluginId }: { pluginId: string }) => `${pluginId} はここにインストールされていません。アンインストールされたか、別のマシンにある可能性があります。`,
        detailMissingRetry: 'もう一度確認',
        surfaces: {
            purpose: 'Happier に画面、コマンド、連携を追加します。プラグインはあなたのマシンで信頼済みのコードとして実行されます。',
            navigationTitle: 'プラグイン',
            updatesTitle: 'アップデート',
            moreDescriptionInSettings: 'プラグインの入手元、自作プラグインの開発、このマシンからの報告。これらは設定で開きます。',
            fix: '修正',
            allSources: 'すべてのソース',
            shelfCurated: '厳選',
            shelfCuratedDescription: 'Happier が確認して推奨しています。どのインストールでも完全な確認が表示されます。',
            shelfCommunity: 'コミュニティ',
            shelfCommunityDescription: '未確認の npm パッケージです。「インストールして信頼」で、それぞれがアクセスできる内容を正確に確認できます。',
            shelfUser: 'あなたのソース',
            shelfUserDescription: 'このマシンで追加したマーケットプレイスソースの掲載。',
            manage: '管理',
            installed: 'インストール済み',
            notShownTitle: '一部を表示できませんでした',
            listingInstallsOn: ({ machine }: { machine: string }) => `${machine} にインストールします。実行前にアクセス内容を確認できます。`,
            listingChooseMachine: 'このプラグインをインストールするには、ヘッダーでマシンを選んでください。',
            listingRunsIn: '実行場所',
            listingPlatforms: 'プラットフォーム',
            listingSource: 'ソース',
            listingCategories: 'カテゴリ',
            listingNotFoundTitle: 'この掲載は利用できません',
            listingNotFoundBody: 'ソースから削除されたか、このマシンが現在ソースに接続できない可能性があります。',
            developmentSourcesTitle: '開発中のプラグイン',
            chooseMachineInstalled: 'ヘッダーでマシンを選ぶと、そのプラグインが表示されます。',
            chooseMachineBrowse: 'ヘッダーでマシンを選ぶと、インストールできるプラグインを探せます。',
            openAsPage: 'ページで開く',
            detailInstalledLabel: 'インストール済みのプラグイン',
            detailListingLabel: 'プラグインの掲載',
            viewLabel: '表示形式',
            viewGrid: 'グリッド',
            viewList: 'リスト',
            installedSearchPlaceholder: 'インストール済みのプラグインを検索',
            statusFilterLabel: '表示するプラグイン',
            statusAll: 'すべてのプラグイン',
            statusEnabled: '有効',
            statusDisabled: '無効',
            statusAttention: '要確認',
            noMatch: ({ query }: { query: string }) => `「${query}」に一致するプラグインはありません`,
            clearSearch: 'クリア',
            emptyTitle: 'まだプラグインはインストールされていません',
            emptyBody: 'プラグインはエージェント向けのパネル、コマンド、ツールを追加します。まずは Happier 製のものから始めましょう。',
            browsePlugins: 'プラグインを見る',
            browseEmpty: 'ソースにはまだ利用できるプラグインがありません。',
            noSavedDetails: 'このマシンには保存済みのプラグイン詳細がありません。',
            projectionFailedTitle: 'このマシンのプラグインレジストリを読み込めませんでした',
            projectionFailedBody: 'プラグインの詳細を読み込めませんでした。管理するには再試行してください。',
            machineOfflineTitle: 'このマシンはオフラインです',
            machineOfflineBody: '変更するには、このマシンをオンラインにする必要があります。ヘッダーで別のマシンを選択してください。',
            forDevelopers: '開発者向け',
            readFailedTitle: 'このマシンのプラグインを読み込めませんでした',
            readFailedBody: '何も変更されていません。再試行するとマシンにもう一度問い合わせます。',
            lastKnown: ({ status }: { status: string }) => `最後の既知の状態 · ${status}`,
            machinesTitle: 'マシン',
            machinesDescription: 'このプラグインがインストールされている場所。',
            machinesCurrent: ({ current, total }: { current: number; total: number }) => `${total} 台中 ${current} 台で最新`,
            onMachines: ({ count }: { count: number }) => `${count} 台のマシン`,
            onMachine: ({ machine }: { machine: string }) => `${machine} 上`,
            onMachineOffline: ({ machine }: { machine: string }) => `${machine} 上 · オフライン`,
            addedGroup: '追加済み',
            machinesRetained: 'このアカウントにはもう存在しないマシン',
            open: '開く',
            review: '確認',
            seeAll: 'すべて表示',
            allResults: 'すべての結果',
            categoriesLabel: 'カテゴリ',
            runOnNoneChosen: 'マシンが選択されていません',
            runOnAuto: '自動',
            runOnAutoHint: '自動で選択',
            machineCapabilityUnavailable: ({ machine }: { machine: string }) => `${machine} ではこの操作を利用できません。再接続するか、「実行先」で別のマシンを選んでください。`,
            noMachineRunsPlugin: ({ plugin }: { plugin: string }) => `${plugin} を実行しているマシンはまだありません。いずれかのマシンにインストールすると、ここで使えます。`,
            pluginCouldNotStart: ({ plugin, machine }: { plugin: string; machine: string }) => `${plugin} は ${machine} で起動できませんでした。そちらで Happier を再起動するか、「実行先」で別のマシンを選んでください。`,
            pluginMachineUnreachable: ({ plugin, machine }: { plugin: string; machine: string }) => `${machine} に接続できないため、いま ${plugin} を実行できません。再接続するか、「実行先」で別のマシンを選んでください。`,
            pluginNotReady: ({ plugin, machine }: { plugin: string; machine: string }) => `${plugin} は ${machine} にインストールされていますが、そこでは実行できる状態ではありません。`,
            pluginNotReadyAnywhere: ({ plugin }: { plugin: string }) => `${plugin} はインストールされていますが、どのマシンでも実行できる状態ではありません。`,
            runOnNoneAvailable: 'まだ実行できるマシンがありません',
            runsEverywhere: 'Happier を実行するすべてのマシン',
            nothingAddedTitle: 'まだプラグインを追加していません',
            includedShow: ({ count }: { count: number }) => `${count} 件すべて表示`,
            includedHide: '非表示',
            kinds: {
                agent: 'エージェント',
                providers: 'モデルプロバイダー',
                scmHostingProviders: 'コードホスティング',
                scmBackends: 'バージョン管理',
                languageServers: '言語サーバー',
                voice: '音声',
                connectedAccounts: '接続済みサービス',
                inputTypes: '入力タイプ',
                mcp: 'MCP ツール',
                pluginUi: 'アプリパネル',
                pluginBrowser: 'ブラウザービュー',
                composer: 'コンポーザーツール',
                other: 'その他',
            },
        },
    } } as const;

return { pluginSettingsPresentationTranslations };
})();

const Domain_pluginUpdateReviewTranslations = (() => {
const en = Shared_pluginUpdateReviewTranslations.en;

const ja = {
    title: '更新の確認',
    confirmSubtitle: '許可したアクセスを広げる更新は、先に確認します。',
    autoApplySubtitle: 'アクセスが広がる場合でも、更新を確認なしで適用します。',
    confirmOption: '先に確認',
    autoApplyOption: '自動',
};

const pluginUpdateReviewTranslations = { ja: ja };

return { pluginUpdateReviewTranslations };
})();

const Domain_pluginWebhookAdministrationTranslations = (() => {
const english = Shared_pluginWebhookAdministrationTranslations.english;

const pluginWebhookAdministrationTranslations = { ja: {
    webhookAdministration: {
        title: 'プラグイン Webhook',
        footer: 'アカウントのエンドポイント、正確なマシンターゲット、配信キュー、配信不能の回復。配信本体はここには表示されません。',
        unavailableTitle: 'プラグイン Webhook を利用できません',
        unavailableSubtitle: 'このサーバーではプラグイン Webhook の受信が有効になっていません。',
        endpointsTitle: 'Webhook エンドポイント',
        emptyTitle: 'プラグイン Webhook エンドポイントなし',
        emptySubtitle: 'インストールされたプラグインによって作成されたエンドポイントは、ターゲットが使用できないエンドポイントも含めて、ここに表示されたままになります。',
        loadError: 'Webhook ステータスを読み込むことができませんでした。',
        endpointSubtitle: ({ readiness, routing, sourceInstanceId }: { readiness: string; routing: string; sourceInstanceId: string }) => `${readiness} · ${routing} · ${sourceInstanceId}`,
        targetSubtitle: ({ machineId, materializationId, status }: { machineId: string; materializationId: string; status: string }) => `${machineId} / ${materializationId} · ${status}`,
        queueSubtitle: ({ queued, retrying, claimed, deadLetter }: { queued: number; retrying: number; claimed: number; deadLetter: number }) => `キューに入れられました ${queued} · 再試行中 ${retrying} · 主張した ${claimed} · デッドレター ${deadLetter}`,
        copyUrl: 'Webhook URL をコピーする',
        selectTarget: '配信対象を選択',
        retarget: 'エンドポイントを再ターゲットする',
        retargetUnavailable: 'このエンドポイントを再ターゲットする前に、利用可能な正確なプラグインの実体化を選択してください。',
        originSelected: '続行すると、選択した正確なプラグインの実体化が再チェックされます。',
        originUnavailable: '正確に利用可能なプラグインの実体化が選択されていません。',
        movePendingTitle: '保留中の配送を移動しますか?',
        movePendingBody: 'キューに入れられた配信や配信不能配信を新しい正確なターゲットに移動しますか?積極的に申請された配達は現在の目標のままです。',
        resumePendingMove: '保留中の配送の移動を再開する',
        resumePendingMoveSubtitle: ({ count }: { count: number }) => `${count} キューに入れられた配信または配信不能配信では、引き続き以前の正確なターゲットが使用されます。`,
        configureCredential: '署名資格情報を構成する',
        rotateCredential: '署名資格情報のローテーション',
        finishRotation: '資格情報のローテーションを終了する',
        finishRotationSubtitle: '以前の資格情報の受け入れを今すぐ中止してください。',
        credentialSecretTitle: '新しい署名シークレットを保存します',
        credentialSecretBody: ({ secret }: { secret: string }) => `この秘密は一度公開されます。このメッセージを閉じる前に保存してください。\n\n${secret}`,
        revoke: 'エンドポイントの取り消し',
        revokeTitle: 'Webhook エンドポイントを取り消しますか?',
        revokeBody: 'このエンドポイントへの新しい配信は拒否されます。既存の配信メタデータは、保持ポリシーに従って引き続き利用できます。',
        operationFailed: 'Webhook 操作は完了しませんでした。再試行する前に現在のステータスを更新してください。',
        deliveryTitle: ({ digest }: { digest: string }) => `デッドレター ${digest}`,
        deliveryStatus: '配送状況',
        deliverySubtitle: ({ errorCode, attempts, replays, machineId, materializationId }: { errorCode: string; attempts: number; replays: number; machineId: string; materializationId: string }) => `${errorCode} · ${attempts} 試み · ${replays} リプレイ · ${machineId} / ${materializationId}`,
        unresolvedAutomationAdmissionTitle: ({ totalCount }: { totalCount: number }) => `${totalCount} 未解決の自動化受付`,
        unresolvedAutomationAdmissionSubtitle: ({ sample, omittedCount }: { sample: string; omittedCount: number }) => `サンプル: ${sample} · ${omittedCount} 示されていない`,
        replay: 'リプレイ配信',
        discardTitle: '配送を破棄しますか?',
        discardBody: '暗号化またはプレーンに保存された配信本体は削除され、復元できなくなります。',
    },
} } as const;

return { pluginWebhookAdministrationTranslations };
})();

const Domain_profilesPageTranslations = (() => {
const english = Shared_profilesPageTranslations.english;

const translated = Shared_profilesPageTranslations.translated;

const profilesPageTranslations = { ja: translated({
        profilesPage: {
            searchPlaceholder: "起動プロファイルを検索",
            emptyTitle: "起動プロファイルはまだありません",
            newProfileTitle: "新しい起動プロファイル",
            notFoundTitle: 'このプロファイルはもう存在しません',
            notFoundDescription: '別のデバイスで削除された可能性があります。',
            backToProfiles: "起動プロファイルに戻る",
            discardDraft: '破棄',
            detailDescription: '新しいセッションをこのプロファイルで開始するときに使われます。',
            builtInDetailDescription: '用意済みのプロファイルです。変更を保存すると自分用のコピーが作成されます。',
            enabledHint: '新しいセッションのプロファイルを選ぶときに表示されます。',
            showInPickers: 'プロファイル選択に表示',
            hideFromPickers: 'プロファイル選択から隠す',
            pickerSection: 'プロファイルの選択',
            pickerSectionDescription: 'セッションを開始するときにこの選択肢が表示される場所です。',
            showFirst: '先頭に表示',
            showFirstDescription: 'マシンの環境をお気に入りに表示します。',
            environmentDescription: 'このプロファイルでセッションを開始するときに設定される環境変数です。値にはマシンの変数を参照できます。',
            descriptionTitle: '説明',
            descriptionHint: '任意。このプロファイルを選ぶときに表示されます。',
            modelRequiresAgent: 'モデルを選ぶには、先に優先エージェントを選んでください。',
            anyAgent: 'すべてのエージェント',
            variableCount: ({ count }: { count: number }) => `${count}個の変数`,
        },
    }) };

return { profilesPageTranslations };
})();

const Domain_providerCollectionTranslations = (() => {
type ProviderCollectionCopy = Shared_providerCollectionTranslations.ProviderCollectionCopy;

const en = Shared_providerCollectionTranslations.en;

const ja: ProviderCollectionCopy = {
    settingsProvidersCollection: {
        gateway: {
            statusRunningOn: ({ machine }: { machine: string }) => `${machine} で実行中`,
            statusOff: 'オフ',
            turnOff: 'ゲートウェイをオフにする',
            turnOn: 'ゲートウェイをオンにする',
            descriptionNamed: ({ services }: { services: string }) => `どのエージェントからでも ${services} のサブスクリプションを使えるようにします。`,
            railGroup: 'ゲートウェイ',
            unavailableTitle: '現在ゲートウェイを表示できません',
            managedFromConnectedServices: '接続済みサービスで管理',
            description: 'どのエージェントからでもサブスクリプションを使えるようにします。',
            statusUnavailable: ({ machine }: { machine: string }) => `利用不可 · ${machine} はオフラインです`,
            offlineTitle: ({ machine }: { machine: string }) => `${machine} はオフラインです`,
            offlineDescription: ({ gateway, machine }: { gateway: string; machine: string }) => `${machine} が復帰するか、下で別のマシンを選ぶまで、セッションは ${gateway} を使えません。代わりに他の経路を試すことはありません。`,
            modelsFromTitle: 'モデルの提供元',
            modelsFromDescription: 'このゲートウェイが利用するサブスクリプションです。それぞれアカウントまたはプールを選んでください。混ざることはありません。',
            slotUnused: ({ service }: { service: string }) => `${service} のモデルはこのゲートウェイでは提供されません。`,
            slotConnect: ({ service }: { service: string }) => `ここで使うには ${service} アカウントを接続してください。`,
            connect: '接続',
            runsOnTitle: '実行場所',
            runsOnDescription: 'セッションが必要としたときにゲートウェイを起動する場所です。リクエストは引き続き上のサブスクリプションに送られます。',
            runsOnSession: '各セッションのマシン',
            runsOnChosen: '選んだマシン',
            runsOnSessionDescription: 'マシンごとに 1 つのゲートウェイを、そこにあるすべてのセッションで共有します。',
            runsOnChosenDescription: '選んだマシンで 1 つのゲートウェイを動かします。他のマシンのセッションは Happier 経由で接続します。',
            computerTitle: 'マシン',
            computerChoose: 'マシンを選択',
            computerChooseDescription: 'ゲートウェイを実行する場所を選びます。',
            computerOnline: 'オンライン · 他のマシンからはまだ確認されていません',
            computerOnlineReachable: 'オンライン · 他のマシンから接続できます',
            computerOnlineUnreachable: 'オンライン · 他のマシンから接続できません',
            computerOffline: 'オフライン',
            computerGone: 'もうあなたのマシンではありません',
            modelPickerTitle: 'モデル選択',
            showInPickerGateway: 'ゲートウェイでは、同じモデルが重複して表示されないよう既定でオフです。「経由先」からいつでも使えます。',
            modelsAvailable: ({ count }: { count: number }) => `${count} 件利用可能`,
            helperTitle: 'Claude Code の補助モデル',
            helperDescription: 'Claude Code は補助タスクを、高速・既定・最上位の 3 つのモデルに任せます。このゲートウェイでそれぞれに使うモデルを選んでください。モデルを指定しているエージェント定義はそのモデルを使い続けます。',
            helperFast: '高速',
            helperDefault: '既定',
            helperStrongest: '最上位',
            helperSameAsSession: 'セッションと同じ',
            detailsTitle: '詳細',
            whatToKnow: '知っておくこと',
            whatToKnowTitle: '専用アプリの外でサブスクリプションを使う',
            whatToKnowDescription: 'これらのサブスクリプションの提供元サービスは、この使い方をサポートしていません。リクエストが拒否されたり、規約が変わったりする可能性があります。Happier は、上で選んだアカウントまたはプールにのみリクエストを送ります。',
            useExternalEndpoint: '代わりに外部エンドポイントを使う',
            poolSectionTitle: '他のエージェントで使う',
            poolSectionDescription: ({ agents }: { agents: string; count: number }) => `${agents} はこのプールに直接サインインします。他のエージェントはゲートウェイ経由で同じアカウントを使います。`,
            poolSectionDescriptionGeneric: 'このサービスでサインインするエージェントは、このプールを直接使います。他のエージェントはゲートウェイ経由で同じアカウントを使います。',
            poolSwitchVia: ({ gateway }: { gateway: string }) => `${gateway} 経由`,
            poolSwitchDescription: ({ service }: { service: string }) => `他のエージェントがこのプールの ${service} モデルを実行できます。`,
            poolSwitchHeldBy: ({ gateway, current, service }: { gateway: string; current: string; service: string }) => `現在、${gateway} は ${service} モデルに ${current} を使っています。`,
            addGateway: 'ゲートウェイを追加',
            mainGatewayName: 'メインゲートウェイ',
            poolSwitchCreates: ({ gateway }: { gateway: string }) => `${gateway}を作成します`,
            poolReplaceTitle: ({ gateway, pool }: { gateway: string; pool: string }) => `${gateway} を ${pool} に切り替えますか?`,
            poolReplaceDescription: ({ pool, service, current }: { pool: string; service: string; current: string }) => `他のエージェントの新しいセッションは、${service} モデルに ${pool} を使います。${current} のアカウントはそのまま残り、実行中のセッションは開始時の設定を保ちます。`,
            poolReplaceConfirm: '切り替える',
            compareNative: ({ agents }: { agents: string }) => `${agents} の場合`,
            compareNativeGeneric: '独自のサインインの場合',
            compareOther: '他のエージェントの場合',
            compareRunsThrough: '経由先',
            compareOwnSignIn: ({ service }: { service: string }) => `${service} 独自のサインイン`,
            compareSupported: ({ service }: { service: string }) => `${service} のサポート`,
            compareSupportedYes: 'あり',
            compareSupportedNo: 'なし。試験的な機能で、リクエストが拒否されることがあります',
            compareLimits: '上限',
            compareLimitsNative: 'このプールの上限',
            compareLimitsShared: '同じ上限を共有',
        },
        connectionDescription: 'アカウントに保存されます。すべてのマシンで使えます。',
        apiKeySavedDescription: '保存済みのシークレットとして保管され、再表示されません。',
        modelsShownCount: ({ count }: { count: number }) => `${count} 件を表示`,
        showInPickerTitle: 'モデル選択に表示',
        showInPickerDirect: ({ provider }: { provider: string }) => `直接接続のプロバイダーでは既定でオンです。${provider} のモデルは、実行できるすべてのエージェントに表示されます。`,
        showInPickerManyModels: '多数のモデルを提供するプロバイダーでは既定でオフです。「経由先」からいつでも使えます。',
        showInPickerLocal: 'お使いのマシンで動くモデルでは既定でオンです。',
        showInPickerAction: '選択に表示',
        onThisComputerTitle: 'このマシン',
        onThisComputerNoComputer: 'マシンが選択されていません。この接続をテストしたり接続方法を変更したりするには、1 台選んでください。',
        endpointAccessTitle: 'エンドポイントへのアクセス',
        endpointAccessDirect: ({ machine, host }: { machine: string; host: string }) => `${machine} は ${host} に直接接続します。`,
        endpointAccessDirectValue: '直接',
        localRuntimeTitle: 'ローカルランタイム',
        onMachine: ({ machine }: { machine: string }) => `${machine} 上`,
        onAComputerTitle: 'マシン上',
        localNoComputer: 'マシンを選ぶと、そこで動いているモデルサーバーが表示されます。',
        localOfflineDetail: 'モデルサーバーを確認できません。',
        localNoneFound: 'ここにモデルサーバーは見つかりませんでした。',
        invitationAccountDescription: 'プロバイダーを一度接続すると、そのモデルを実行できるすべてのエージェントに表示されます。始めるのにマシンは不要です。',
        subscriptionsPointerLead: 'Claude や ChatGPT などのサブスクリプションは',
        subscriptionsPointerLink: '接続済みサービス',
        subscriptionsPointerTail: 'にあります。',
        addTitle: ({ provider }: { provider: string }) => `${provider} を追加`,
        addDescription: ({ provider }: { provider: string }) => `キーを追加すると、${provider} のモデルが実行できるすべてのエージェントに表示されます。`,
        addKeyDescription: 'アカウントに保存済みのシークレットとして保管されます。',
        addKeyPlaceholder: ({ provider }: { provider: string }) => `${provider} のキーを貼り付け`,
        useSavedKey: '保存済みのキーを使う',
        addAccountScopeHint: 'すぐにアカウントに保存されます。マシンは不要です。あとでどのマシンからでもテストできます。',
        approvalPendingTitle: '承認待ち',
        approvalPendingDescription: ({ provider }: { provider: string }) => `リクエストを承認すると ${provider} の追加が完了します。承認されるとこのページが続行します。`,
        openApproval: '承認を開く',
        advancedSummary: '利用範囲、共有、エンドポイント',
        editConnection: '接続を編集',
        editDescription: '変更はこのあと開始するセッションに適用されます。キーとモデルはそのページで管理します。',
        connectedTitle: ({ provider }: { provider: string }) => `${provider} に接続しました`,
        connectedHiddenCountDescription: ({ provider, count }: { provider: string; count: number }) => `${count} 個のモデルを使えます。${provider} にはすでにお持ちのモデルも多く含まれるため、既定ではモデル選択に表示されません。「経由先」からいつでも選べます。すべて表示することもできます。`,
        connectedHiddenDescription: ({ provider }: { provider: string }) => `${provider} にはすでにお持ちのモデルも多く含まれるため、既定ではモデル選択に表示されません。「経由先」からいつでも選べます。すべて表示することもできます。`,
        description: 'モデルソースを一度接続すれば、そのモデルを対応するすべてのエージェントで使えます。',
        foundOn: ({ machine }: { machine: string }) => `${machine} で検出`,
        foundOnThisMachine: 'このマシンで検出',
        connect: '接続',
        start: '起動',
        test: 'テスト',
        addProvider: 'プロバイダーを追加',
        customEndpoint: 'カスタムエンドポイント',
        menuOwnCategory: '独自',
        menuCatalogCategory: 'カタログから',
        newTitle: '新しいプロバイダー',
        machineScopeLabel: '設定先',
        invitationTitle: '自分のモデルを使う',
        invitationDescription: 'プロバイダーを一度接続すると、そのモデルが対応するすべてのエージェントのモデル選択に表示されます。Ollama などのローカルサーバーはあなたのマシンで動作します。',
        invitationNeedsMachine: 'プロバイダーはあなたのマシンのいずれかで接続・確認されます。まずマシンを追加してください。',
        setUpMachine: 'マシンを設定',
        duplicateAsCustom: 'カスタムプロバイダーとしてコピー',
        discard: '破棄',
        enabled: '有効',
        enabledDescription: 'エージェントのモデル選択にこのモデルを表示します',
        saved: '保存済み',
        replace: '置き換え',
        addKey: 'キーを選択',
        apiKeyDefaultDescription: '独自のキーがないすべてのマシンで使用されます。',
        apiKeyMachineDescription: 'このマシンではデフォルトのキーの代わりに使用されます。',
        availabilityTitle: '利用範囲',
        availabilityDescription: 'エージェントがこのプロバイダーを使える場所です。',
        modelsDescription: 'エージェントのモデル選択に表示するモデルを選びます。',
        modelsShown: ({ shown, total }: { shown: number; total: number }) => total === shown ? `${total} 件のモデル` : `${total} 件中 ${shown} 件を表示`,
        modelsFilter: ({ count }: { count: number }) => `${count} 件のモデルを絞り込む`,
        connectionTitle: '接続',
        nameDescription: 'プロバイダー一覧とモデル選択に表示されます。',
        nameRequired: '名前を入力してください。',
        nameTooLong: ({ max }: { max: number }) => `${max} 文字以内で入力してください。`,
        managedTitle: '管理対象のローカルサービス',
        endpointsTitle: 'エンドポイント',
        endpointsDescription: '空欄にするとプロバイダーが提供するアドレスを使用します。',
        overridesDescription: 'リクエストの送信先です。すべてのマシン、またはこのマシンだけのアドレスを変更できます。',
        afterSavingTitle: '保存後',
        destinationDescription: 'Happier がこのプロバイダーのリクエストを送信する先です。',
        destinationPending: 'すべてのエンドポイントを入力すると表示されます。',
    },
};

const providerCollectionTranslations = { ja } as const;

return { providerCollectionTranslations };
})();

const Domain_providerSessionTranslations = (() => {
const providerSessionTranslations = { ja: {
        launchDefaultLabel: ({ provider }: { provider: string }) => `プロバイダー：${provider}`,
        launchNamedLabel: ({ provider, connection }: { provider: string; connection: string }) => `プロバイダー：${provider} · ${connection}`,
        changedTitle: 'プロバイダー設定が変更されました', changedBody: ({ provider, connection }: { provider: string; connection: string }) => `このセッションでは、開始時の ${provider} · ${connection} 設定が引き続き使用されています。`,
        unavailableTitle: 'プロバイダーを利用できなくなりました', unavailableBody: ({ provider, connection }: { provider: string; connection: string }) => `${provider} · ${connection} では、このセッションを再開できません。`,
        disabledTitle: 'プロバイダーはオフです', disabledBody: ({ provider, connection }: { provider: string; connection: string }) => `このセッションを再開する前に ${provider} · ${connection} を有効にしてください。`,
        incompatibleTitle: 'プロバイダーは対応しなくなりました', incompatibleBody: ({ provider, connection }: { provider: string; connection: string }) => `${provider} · ${connection} は、このセッションのエージェントに対応していません。`,
        restartAction: 'セッションを再起動', chooseModelAction: 'モデルを選択',
    } } as const;

return { providerSessionTranslations };
})();

const Domain_reviewWalkthroughTranslations = (() => {
type Count = Shared_reviewWalkthroughTranslations.Count;

type ReviewWalkthroughTranslations = Shared_reviewWalkthroughTranslations.ReviewWalkthroughTranslations;

const en = Shared_reviewWalkthroughTranslations.en;

const ja: ReviewWalkthroughTranslations = {
    severityCount: ({ count, severity }) => `${severity} ${count}`,
    findingRefA11y: ({ label, title }) => `${label}: ${title}。指摘へ移動`,
    tag: { noFile: 'ファイルなし', outdated: '古い', unplaced: '位置を特定できない', notInStory: 'どの項目にもない' },
    outdatedSummary: 'レビュー後にコードが変わりました。',
    askAboutFindingA11y: ({ title }) => `指摘について質問: ${title}`,
    tailTitle: '項目に結びつかない指摘',
    tailDescription: '行の位置を特定できなくても消えないよう、ここに残します。',
    inContext: '文脈に含む',
    fromReviewAt: ({ time }) => `${time}のレビューから`,
    reviewLabel: 'レビュー:',
    enginesOf: ({ count, total }) => `${total}件中${count}件`,
    enginesFinished: () => 'のエンジンが完了',
    enginesRunning: ({ count }) => `${count}件のエンジンがレビュー中`,
    fromEngines: ({ engines, inStory }) => `${engines}から · ${inStory}件がウォークスルー内`,
    and: '、',
    inStoryElsewhere: ({ inStory, elsewhere }) => `${inStory}件がウォークスルー内、${elsewhere}件がその他`,
    allInStory: 'すべてウォークスルー内',
    noFindings: '指摘なし',
    seeded: {
        title: 'レビュー後に新しい実行で書かれました。',
        body: ({ reviewers, time }) => `ナレーターはコードをレビューしていません。ここで引用する指摘はすべて${time}の${reviewers}によるものです。`,
        changed: ({ count }) => `それ以降に${count}件のファイルが変わりました。`,
    },
    findingsFrom: ({ count, engine }) => `${engine}からの指摘${count}件`,
    publishedBefore: ({ time }) => `${time}にウォークスルーより先に公開`,
    steps: {
        reviewing: 'レビュー中',
        engineProgress: ({ done, running }) => `${done} 完了 · ${running} レビュー中`,
        reviewed: ({ count }) => `レビュー済み · 指摘${count}件`,
        reviewedShort: ({ count }) => `レビュー済み · ${count}`,
        engineReviewed: ({ engine, count }) => `${engine} · 指摘${count}件`,
        reviewedAt: ({ time }) => `${time}にレビュー済み`,
        reviewAt: ({ time }) => `${time}のレビュー`,
        partial: ({ count }) => `部分的なレビュー · 指摘${count}件`,
        readyShort: 'ウォークスルー',
        failed: 'ウォークスルー失敗',
        narrating: 'ナレーション中',
        narratorWriting: ({ narrator }) => `${narrator}が執筆中`,
        writing: 'ウォークスルーを執筆中',
        writingShort: '執筆中',
    },
    writingWithFindings: '指摘を踏まえてウォークスルーを執筆中…',
    dialog: {
        engines: 'レビューエンジン',
        selected: ({ count }) => `${count}件選択`,
        loadingEngines: 'レビューエンジンを探しています…',
        noEngines: 'このセッションのマシンで実行できるレビューエンジンがありません。',
        findingsOnly: '指摘のみ',
        changes: '変更',
        instructions: '指示',
        instructionsPlaceholder: 'レビューで何を確認しますか?',
        defaultInstructions: 'これらの変更を正確さ、リスク、不足しているテストの観点でレビューしてください。',
        alsoWalkthrough: 'ウォークスルーも書く',
        alsoWalkthroughBody: '指摘がそろうと、同じ実行がそれを文脈にウォークスルーを書きます。変更を二度読むことはありません。',
        narrator: 'ナレーター',
        chooseNarrator: 'ナレーターを選択',
        narratorSeveral: ({ count }) => `${count}件のエンジンがレビューし、1つのモデルがすべての指摘からウォークスルーを書きます。`,
        narratorFindingsOnly: ({ engine }) => `${engine}は文章ではなく指摘を返します。モデルがそこからウォークスルーを書きます。`,
        noNarrator: 'どのエンジンもウォークスルーを書けません。モデルのエンジンを追加するか、ウォークスルーをオフにしてください。',
        footerReviewThenWalkthrough: 'レビューしてからウォークスルーを執筆',
        footerHandover: ({ reviewer, narrator }) => `${reviewer}がレビュー · ${narrator}が執筆`,
    },
    generated: {
        continues: ({ model }) => `${model} · レビューの続き`,
        seeded: ({ model }) => `${model} · レビューの指摘から`,
        handover: ({ narrator, engine }) => `${narrator}、${engine}の指摘から`,
    },
    partial: {
        failed: ({ engines }) => `${engines}のレビューは完了しませんでした。`,
        notClean: 'これは部分的なレビューで、問題なしという結果ではありません。',
        finishedWith: ({ engines, count }) => `${engines}は指摘${count}件で完了しました。`,
        retry: ({ engine }) => `${engine}を再試行`,
    },
    explain: { action: '指摘を説明', running: '指摘を説明中', a11y: 'ウォークスルーで指摘の説明を依頼', unknownModel: '不明なモデル', requester: { user: 'ユーザー', agent: 'エージェント', plugin: 'プラグイン', automation: '自動化', workflow: 'ワークフロー', unknown: '不明な依頼者' }, header: ({ model, time, requester = 'あなた' }) => `レビューの説明 · ${model} · ${time}に${requester}が依頼 · 判定ではありません` },
    finished: {
        title: 'レビュー完了',
        openFindings: '指摘を開く',
        walkMeThrough: '案内して',
        andMore: ({ count }) => `ほか${count}件`,
        continues: 'このレビュー実行を続けます。レビュアーは既に読んだ内容から書きます。再分析はしません。',
        narrates: ({ count }) => `レビュー実行は終了しています。新しい実行がこの${count}件の指摘と変更からウォークスルーを書きます。再レビューはしません。`,
    },
    started: {
        transcript: ({ engineCount, fileCount }) => `レビューを開始 · エンジン${engineCount}件 · ファイル${fileCount}件`,
        notStarted: ({ engines }) => `${engines}は開始しませんでした。ほかのエンジンはレビュー中です。`,
        narrationFailed: 'レビューは開始しましたが、ウォークスルーを依頼できませんでした。指摘は届きます。',
    },
};

const reviewWalkthroughTranslations = { ja: { reviewWalkthrough: ja } };

return { reviewWalkthroughTranslations };
})();

const Domain_rolesTranslations = (() => {
type RolesTranslations = Shared_rolesTranslations.RolesTranslations;

const rolesTranslations = { ja: {
        rail: {
            chooseEngine: 'エンジンを選択',
            unavailableRole: '利用できなくなりました',
            label: 'ロール',
            title: 'ロール',
            searchPlaceholder: 'ロールを検索…',
            empty: 'ロールはまだありません。',
            emptyWithManage: 'ロールはまだありません。「ロールを管理」で追加できます。',
            footer: 'ロールは独自の指示、エンジン、実行方法を持つため、ワークフローを持ち運べます。',
            manage: 'ロールを管理',
            engineAppliesOnStart: 'このロールの開始時にエンジンを適用',
            defaultEngine: 'デフォルトのエージェント',
            activeAccessibilityLabel: 'ロール、使用中のロールあり',
        },
        builtIn: {
            orchestrator: "作業を率いて、一部を他のエージェントに任せます",
            planner: "作る前に計画を立てます",
            builder: "変更を行い、動作を確認します",
            reviewer: "変更をレビューし、直すべき点を示します",
            judge: "争点となった指摘を判定し、目標の達成を判断します",
            second_opinion: "先に進む前の独立したチェック",
            scout: "コードを調べ、どこに何があるかを答えます",
            approval_reviewer: "低リスクの権限リクエストに答え、それ以外はあなたに確認します",
        },
        settings: {
            duplicate: '複製',
            duplicateName: ({ name }) => `${name} のコピー`,
            platformDefault: 'プラットフォームの既定 · 更新に追従',
            runsAsThisSession: 'このセッション',
            runsAsOrchestratorDescription: 'オーケストレーターは、オンにしたそのセッションです。',
            readOnly: '読み取り専用',
            engineChooseMigrated: '0.2 からエンジンは引き継がれていません。選択しない場合は既定のエージェントに従います。',
            description: '各種の作業を誰が行うか。ワークフローやオーケストレーターはロールを指定し、ロールが実行方法を決めます。',
            count: ({ count }) => `${count} 個のロール`,
            newRole: '新しいロール',
            groupBuiltIn: '組み込み',
            groupYours: 'あなたのロール',
            groupShared: '共有されたロール',
            groupPlugins: 'プラグインから',
            edited: '編集済み',
            sourceBuiltIn: '組み込み',
            sourceYours: 'あなたのロール',
            sourceShared: 'あなたと共有',
            sourcePlugin: ({ plugin }) => `${plugin} から`,
            usedBySessions: ({ count }) => `${count} 件のセッションで使用中`,
            migrated: '0.2 サブエージェントから',
            migratedNote: ({ names }) => (names.length === 1 ? `${names[0]} は 0.2 のサブエージェントのガイダンスから移行されました。説明が指示に、エージェントとモデルがエンジンになっています。` : `${names.join('、')} は 0.2 のサブエージェントのガイダンスから移行されました。それぞれの説明が指示に、エージェントとモデルがエンジンになっています。`),
            nameTitle: '名前',
            newRoleName: '無題のロール',
            instructionsTitle: '指示',
            instructionsDescription: '何をするか、いつ使うか、どう報告するか。エージェントが作業を割り当てるときに読みます。',
            resetToDefault: 'デフォルトに戻す',
            readOnlyNote: '元のロールは読み取り専用です。ここで自分用の指示を変更できます。リセットすると元に戻ります。',
            howItRunsTitle: '実行方法',
            engineTitle: 'エンジン',
            engineDescription: 'エージェント、モデル、推論量。',
            engineFollowsDefault: 'デフォルトのエージェントに従います。',
            engineUnavailable: 'ここでは使えません。エンジンを選んでください。',
            runsAsTitle: '実行場所',
            runsAsSession: 'セッション',
            runsAsBackgroundRun: 'バックグラウンド実行',
            runsAsSessionDescription: '開いて操作できるセッション。',
            runsAsBackgroundDescription: 'バックグラウンドで実行して報告します。操作するセッションはありません。',
            handsOffTitle: '委任のみ',
            handsOffDescription: '計画して委任し、自分ではファイルを編集しません。',
            secondOpinionTitle: 'セカンドオピニオン',
            secondOpinionDescription: '「推奨」にすると、プルリクエストや完了の前にセカンドオピニオンを検討するよう求めます。',
            secondOpinionOff: 'オフ',
            secondOpinionEncouraged: '推奨',
            canDelegateToOtherRolesTitle: '他のロールに委任できる',
            canDelegateToOtherRolesDescription: '利用可能なロールとその開始方法を指示に含めます。',
            enabledTitle: '利用可能',
            enabledDescription: 'ロール一覧と委任できるロールに表示されます。',
            advancedTitle: '詳細',
            launchProfileTitle: '起動プロファイル',
            launchProfileDescription: '環境、権限、マシン',
            launchProfileNone: 'なし',
            profileUnavailable: 'プロファイルを利用できません',
            previewTitle: 'エージェントが読む内容',
            previewDescription: '各ターンで送られるブロックそのものです。',
            deleteRole: 'ロールを削除',
            deleteConfirmTitle: 'このロールを削除しますか？',
            deleteConfirmBody: ({ name }) => `${name} はあなたと共有先の全員から削除されます。使用中のセッションはコピーを保持します。`,
            share: '共有…',
            sendCopyFailed: 'コピーを送信できませんでした。',
            saveFailed: 'ロールを保存できませんでした。',
            loadFailed: 'ロールを読み込めませんでした。',
            emptyDetailTitle: 'ロールを選択',
            emptyDetailBody: 'ロールを選ぶと、指示と実行方法が表示されます。',
        },
        delegation: {
            title: '委任',
            description: 'エージェントが他のエージェントに作業を渡す方法。',
            depthTitle: '作業の深さ',
            approvalReviewer: '承認レビュアー',
            approvalReviewerDescription: '低リスクのリクエストを自動で一度だけ審査します。機密性の高い操作には承認が必要です。デフォルトと編集を許可モードのみ。',
            approvedByReviewer: '承認レビュアーが一度だけ許可',
            depthDescription: 'エージェントが開始したセッション、バックグラウンド実行、ワークフローはさらに開始できます。この上限が暴走する連鎖を止めます。あなたが自分で開始したものは制限されません。',
            depthSetting: 'エージェントが作業を渡せる深さ',
            depthSettingDescription: ({ count }) => `${count} 段階。それを超えると、エージェントは自分で作業するよう指示されます。`,
            ladderRoot: 'あなたが開始した作業',
            ladderRootDetail: 'あなたが開始 · 制限なし',
            ladderLevel: ({ level }) => `レベル ${level}`,
            ladderLevelDetail: ({ level }) => (level === 1 ? "あなたが始めた作業のエージェントが開始" : `レベル ${level - 1} のエージェントが開始`),
            ladderRefused: 'さらにもう一段の委任',
            ladderRefusedDetail: ({ level }) => `レベル ${level} · 拒否。エージェントが自分で行います`,
        },
        session: {
            refusal: {
                runtimeUnavailableTitle: "ロールを変更するにはセッションを開始してください",
                runtimeUnavailableBody: "このセッションは現在ロールの変更を受け付けていません。開始または再開してから、もう一度ロールを選んでください。",
                unenforceableTitle: 'このエージェントは「委任のみ」で動作できません',
                unenforceableBody: 'このロールは「委任のみ」ですが、このセッションのエージェントには自身のファイル編集を止める手段がありません。ロールの「委任のみ」をオフにするか、対応するエージェントの新しいセッションで開始してください。',
                restartRequiredTitle: 'いま「委任のみ」は適用できません',
                restartRequiredBody: 'このエージェントは、ターンの合間かセッション開始時にのみ「委任のみ」を変更できます。現在のターンが終わるのを待つか、セッションを再起動してから、もう一度ロールを選んでください。',
                roleUnavailableTitle: 'そのロールは利用できなくなりました',
                roleUnavailableBody: '削除されたか、オフにされたか、共有が解除されました。別のロールを選んでください。',
            },
            useDefaults: 'デフォルトのロールを使う',
            crossOwnerNote: 'ロールは開始時にコピーされました。',
            addRole: 'このセッションにロールを追加',
            addRoleConfirm: 'ロールを追加',
            namePlaceholder: 'ロール名',
            instructionsPlaceholder: 'このロールが何をし、いつ使うか',
            notesTitle: 'メモ',
            notesPlaceholder: '下のすべてのセッションが知っておくべきこと',
            applyToReports: 'ロールを下のセッションに適用',
            handsOffTitle: '委任のみ',
            handsOffDescription: '計画して委任し、ファイルは編集しません。',
            saveFailed: 'この変更を保存できませんでした。',
            sectionTitle: 'ロール',
            allRoles: 'すべてのロール',
            inUse: ({ count }) => `${count} 件使用中`,
            changedHere: 'ここで変更',
            addedHere: 'ここで追加',
            reset: 'リセット',
            runsInBackground: 'バックグラウンドで実行',
            approvalReviewerFollowsDefault: ({ value }) => `デフォルト設定に従う · ${value}`,
            approvalReviewerOverride: ({ value }) => `ここで設定 · デフォルト: ${value}`,
            newRoleForSession: 'このセッション用の新しいロール',
            changeForSession: 'このセッションだけ変更',
            editNotes: 'メモを編集',
            more: 'もっと見る',
            info: 'ロールはこのセッションとその下のセッションに適用されます。',
            countChanged: ({ count }) => `変更 ${count} 件`,
            countAdded: ({ count }) => `追加 ${count} 件`,
            addNotes: 'このセッションの進め方についてメモを追加',
        },
        profiles: {
            sharedWithYouTitle: 'あなたと共有',
            sharedWithYouDescription: '人やチームがあなたと共有したプロファイル。シークレットの値は所有者のもとに残ります。',
            share: '共有…',
            shareFailedTitle: 'このプロファイルを共有できませんでした',
            shareNeedsSavedSecrets: 'シークレットの値は送られません。このプロファイルの各値を保存済みシークレットに移してリンクし、もう一度共有してください。',
            shareAwaitingApproval: 'このプロファイルの公開は承認待ちです。承認されたら、もう一度「共有…」を選んでください。',
        },
    } } as const satisfies Pick<Record<string, RolesTranslations>, "ja">;

return { rolesTranslations };
})();

const Domain_runPageTranslations = (() => {
type Count = Shared_runPageTranslations.Count;

type Machine = Shared_runPageTranslations.Machine;

type Reviewer = Shared_runPageTranslations.Reviewer;

type RunPageTranslations = Shared_runPageTranslations.RunPageTranslations;

const runPageTranslations = { ja: {
        untitledRun: 'エージェントの実行',
        intentTitles: { review: 'レビュー', plan: 'プラン', delegate: '委任したタスク', scmDiffSummary: '変更の概要' },
        thisMachine: 'このマシン',
        menu: {
            cancelResponse: 'この応答をキャンセル',
            copyResult: '結果をコピー',
            showInTranscript: 'トランスクリプトで表示',
            runDetails: '実行の詳細',
            agent: 'エージェント',
            permissions: '権限',
            kind: '種類',
            finishesOnItsOwn: '自動で終了',
            selectionInherited: 'セッションから継承',
            selectionExplicit: 'この実行用に選択',
            selectionIndependent: 'アカウントの既定',
            selectionRetained: '開始時の設定を維持',
            selectionChoose: 'この実行用に選ぶ',
            selectionChooseDetail: 'モデルと実行経路を選びます',
            staysOpen: '開いたまま',
            started: '開始',
            run: '実行',
            process: 'プロセス',
        },
        opening: { reading: ({ machine }) => `${machine} から読み込んでいます。` },
        gone: {
            title: ({ machine }) => `この実行は ${machine} にもうありません`,
            reason: 'もう保持されておらず、読み込み済みのトランスクリプトにも含まれていません。',
            closeTab: 'タブを閉じる',
        },
        stopFailed: {
            title: {
                review: 'このレビューを停止できませんでした',
                plan: 'このプランを停止できませんでした',
                delegate: 'このタスクを停止できませんでした',
                run: 'この実行を停止できませんでした',
            },
            reasonWithOthers: ({ machine, count }) => `${machine} が停止を確認しませんでした。代わりにセッション全体を停止できます。その場合、実行中のほかの ${count} 個のエージェントも停止します。`,
            reasonAlone: ({ machine }) => `${machine} が停止を確認しませんでした。代わりにセッション全体を停止できます。`,
            stopSession: 'セッションを停止…',
        },
        steps: {
            title: 'ここまでの経緯',
            count: ({ count }) => `${count} ステップ`,
        },
        review: {
            findings: '指摘',
            findingsCount: ({ count }) => `${count}`,
            highCount: ({ count }) => `高 ${count}`,
            severity: { blocker: 'ブロッカー', high: '高', medium: '中', low: '低', nit: '軽微' },
            triageLabel: 'この指摘の扱い',
            reviewerAsks: 'レビュアーからの質問',
            answer: '回答',
            askAboutThis: 'これについて質問',
            fixesSelected: ({ count }) => `${count} 件の修正を選択`,
            noFixesSelected: '実装する修正を選んでください',
            implementFixes: ({ count }) => (count > 0 ? `${count} 件の修正を実装` : '修正を実装'),
            couldNotSaveChoice: '選択を保存できませんでした。',
            reviewers: 'レビュアー',
            findingTotal: ({ count }) => (count === 1 ? '1件の指摘' : `${count}件の指摘`),
            moreFindings: ({ count }) => (count === 1 ? 'ほか1件の指摘' : `${count}件のその他の指摘`),
            fixesToImplement: ({ count }) => (count === 1 ? '1件の修正を実施' : `${count}件の修正を実施`),
            verifiedFirst: 'それぞれ確認してから修正します',
            replies: ({ count }) => (count === 1 ? '1件の返信' : `${count}件の返信`),
            updatedAfterQuestion: '質問後に更新されました',
            reviewerUpdated: ({ reviewer }) => `${reviewer}が指摘を更新しました`,
            askPlaceholder: 'この指摘について質問…',
            askReviewerPlaceholder: 'レビュアーに質問…',
            toReviewer: ({ reviewer }) => `${reviewer}へ`,
            followUpsGoTo: ({ reviewer }) => `質問は${reviewer}に届きます`,
            waitingForAnswer: ({ reviewer }) => `${reviewer}を待っています…`,
            waitingForAnswers: 'レビュアーを待っています…',
            both: '両方',
            reviewerCount: ({ count }) => `${count}人のレビュアー`,
            askReviewersPlaceholder: 'レビュアーに質問する…',
            followUpsGoToAll: ({ count }) => (count === 2 ? '質問は両方のレビュアーに届きます' : `質問は${count}人のレビュアー全員に届きます`),
            stillReviewing: 'レビュー中',
            reviewerDidNotFinish: '完了しませんでした',
            reviewersNotStarted: ({ count }) => (count === 1 ? '1人のレビュアーが開始できませんでした' : `${count}人のレビュアーが開始できませんでした`),
            reviewerNotStarted: ({ reviewer }) => `${reviewer}を開始できませんでした。`,
            notSaved: 'この指摘は保存されていないため、まだ判断を記録できません。',
            decisionsUnavailable: '判断を読み込めませんでした。',
            followUpUnavailable: {
                notResumable: 'このレビューは終了しています。質問するには開いたままのレビューが必要です。',
                ended: 'このレビューは完了しなかったため、質問を受け付けません。',
                resumeUnavailable: 'このマシンではレビュアーにもう接続できません。',
                busy: 'レビュアーはまだ作業中です。少し待ってから再試行してください。',
                failed: '質問を送信できませんでした。',
            },
        },
        launcher: {
            titles: { review: 'レビューを依頼', plan: 'プランを依頼', delegate: 'タスクを任せる' },
            descriptions: {
                review: ({ folder }) => `各エージェントが ${folder} の変更を個別にレビューし、それぞれの結果がここに届きます。`,
                plan: ({ machine }) => `エージェントが ${machine} のコードを読み、ここにプランを提案します。何も変更しません。`,
                delegate: ({ machine }) => `エージェントが下の権限で ${machine} 上で作業し、ここに報告します。`,
            },
            whatFor: '目的',
            who: { review: 'レビューする人', plan: 'プランを立てる人', delegate: '担当' },
            selectedCount: ({ count }) => `${count} 件選択`,
            focus: {
                review: '何に注目してほしいですか？',
                plan: 'プランで何を扱いますか？',
                delegate: '何をしてほしいですか？',
            },
            optional: '任意',
            start: {
                review: ({ count }) => (count > 1 ? `${count} 件のレビューを開始` : 'レビューを開始'),
                plan: 'プランを開始',
                delegate: 'タスクを開始',
            },
            runsOn: ({ machine }) => `${machine} で実行`,
            checking: 'ここで動かせるエージェントを確認しています',
            unavailableTitle: 'このセッションではエージェントを開始できません',
            unavailableReason: 'このマシンは現在、レビュー・プラン・委任タスクを提供していません。',
        },
    } } as const satisfies Pick<Record<string, RunPageTranslations>, "ja">;

return { runPageTranslations };
})();

const Domain_scmComparisonTranslations = (() => {
type ScmComparisonTranslations = Shared_scmComparisonTranslations.ScmComparisonTranslations;

const en = Shared_scmComparisonTranslations.en;

const translated = Shared_scmComparisonTranslations.translated;

const scmComparisonTranslations = { ja: {
        scmComparison: translated({
            view: { files: 'ファイル', walkthrough: 'ウォークスルー', commits: 'コミット' },
            scope: {
                workingTree: '保留中の変更',
                session: 'このセッション',
                turn: 'ターン',
                latestTurn: '最新のターン',
                branch: ({ head, base }) => `${head} と ${base} の比較`,
                commit: ({ commit }) => `コミット ${commit}`,
            },
            tabTitle: ({ view, scope }) => `${view} · ${scope}`,
            since: ({ time }) => `${time} から`,
            turnsWithChanges: ({ count }) => `変更のあるターン ${count} 件`,
            onBranch: ({ branch }) => `${branch} 上`,
            scopePicker: {
                a11y: '表示する変更',
                branchChoice: 'ブランチとベースの比較',
                commitChoice: 'コミット',
                pullRequestChoice: 'プルリクエスト',
                headRef: '比較するブランチまたは参照',
                baseRef: 'ベースのブランチまたは参照',
                parentRef: '親の参照（任意）',
                explainAndCommit: '説明してコミット',
                explainOnly: '説明のみ',
                unavailable: 'このセッションでは利用できません',
                pendingDescription: '未コミット · コミットを提案できます',
                sessionDescription: '変更したすべて、開始 → 現在',
                turnDescription: 'エージェントが変更した順序',
                branchDescription: '共通のベースからの変更',
                commitDescription: 'このコミットで導入された変更',
                pullRequestDescription: 'このプルリクエストで提案された変更',
            },
            fileCount: ({ count }) => `${count} 個のファイル`,
            changeCount: ({ count }) => `${count} 件の変更`,
            changedFiles: '変更されたファイル',
            startReview: 'レビューを開始',
            proposeCommits: 'コミットを提案',
            explain: '説明',
            explainA11y: '説明: 変更の横にウォークスルーのメモを表示',
            viewA11y: '表示',
            lockfileTag: 'ロックファイル',
            generatedTag: '生成ファイル',
            lockfileCollapsed: 'ロックファイル (折りたたみ)',
            generatedCollapsed: '生成ファイル (折りたたみ)',
            showDiff: '差分を表示',
            unsupportedReason: 'ファイルではまだこの比較を表示できません。変更は Git に残っています。',
            showPendingChanges: '保留中の変更を表示',
            capturedStale: 'ソースが変更されました。これらのファイルは取得時の比較を保持しています。',
            capturedFreshnessUnknown: '取得済みのファイルを表示しています。ソースの現在の状態を確認できませんでした。',
            keys: { nextFile: '次のファイル', nextChange: '次の変更' },
        }),
    } } as const;

return { scmComparisonTranslations };
})();

const Domain_secretsSettingsTranslations = (() => {
type SecretsSettingsCopy = Shared_secretsSettingsTranslations.SecretsSettingsCopy;

const en = Shared_secretsSettingsTranslations.en;

const ja: SecretsSettingsCopy = {
    purpose: "エージェントと MCP サーバー用の API キーとトークン。シークレットを管理する人が表示しない限り、値は非表示のままです。",
    yoursTitle: '自分のシークレット',
    yoursDescription: '保存した、または所有しているシークレットです。Happier がキーを求める場所で選べます。',
    sharedWithYouTitle: '共有されたシークレット',
    sharedWithYouDescription: '他のユーザーが使用を許可したものです。選ぶことはできますが、表示や変更はできません。',
    add: 'シークレットを追加',
    newSecret: '新しいシークレット',
    emptyTitle: 'シークレットはまだありません',
    emptyDescription: 'API キーやトークンを一度追加すれば、Happier が求める場所で選べます。',
    staleTitle: '共有シークレットを更新できませんでした',
    valueTitle: '値',
    valueSaved: '保存済み',
    keepTitle: '保存方法',
    keepPersonal: '個人',
    keepShared: '共有',
    keepPersonalDescription: 'アカウントに保存されます。使えるのはあなただけです。',
    keepSharedDescription: 'この Home に保存され、ユーザー、Team、グループと共有できます。',
    accessTitle: '使用できるユーザー',
    accessOnlyYou: 'あなたのみ',
    accessRecipients: ({ count }: { count: number }) => `あなたと受信者 ${count} 人`,
    sharePersonalDescription: '共有するとこの Home に移動し、個人用には戻せません。',
    share: '共有',
    manage: '管理',
    storageTitle: '保存先',
    storageE2ee: 'エンドツーエンド暗号化',
    storageE2eeDescription: '共有した相手だけが読み取れます。',
    storagePlain: 'Home で管理',
    storagePlainDescription: 'この Home が保存し、配信のために読み取れます。',
    save: 'シークレットを保存',
    revealValue: "値を表示",
    hideValue: "値を隠す",
    revealConfirmTitle: ({ name }: { name: string }) => `「${name}」を表示しますか？`,
    revealConfirmBody: "値は、隠すかページを離れるまでこのデバイスに表示されます。表示とコピーは履歴に記録されます。",
    revealConfirm: "表示",
    valueUnavailable: "保存済み。現在このデバイスでは表示できません。",
    valueRefused: "値を表示できなかったため、何も表示されていません。",
    copyRefused: "値をコピーできませんでした。もう一度表示してからお試しください。",
    copyUnrecorded: "値はクリップボードにある可能性がありますが、このコピーは記録できませんでした。",
    historyTitle: "表示履歴",
    historyEmpty: "この値を表示した人はいません。",
    historyUnavailable: "履歴を読み込めませんでした。",
    historyRevealed: "表示",
    historyRevealedCopied: "表示してコピー",
    historyCopyNotConfirmed: "表示 · コピー未確認",
    historyNotShown: "表示されず",
    historyUnconfirmed: "表示未確認",
    historyThisDevice: "このデバイス",
    historyOtherDevice: "別のデバイス",
    historyUnknownActor: "誰か",
    historyOlder: "以前の履歴を表示",
};

const secretsSettingsTranslations = { ja } as const;

return { secretsSettingsTranslations };
})();

const Domain_sessionAccessTranslations = (() => {
const sessionAccessTranslations = { "ja": {
        withContext: ({ context, label }: { context: string; label: string }) => `${context} · ${label}`,
        withCount: ({ label, count }: { label: string; count: number }) => `${label} +${count}`,
        accessibleSummary: ({ title, label }: { title: string; label: string }) => `${title}: ${label}`,
        accessibleControl: ({ name, control, value }: { name: string; control: string; value: string }) => `${name}, ${control}, ${value}`,
        title: "セッションへのアクセス",
        context: "セッションのコンテキスト",
        contextPolicyUnavailable: "このセッションの共有ポリシーを確認できませんでした。更新してもう一度お試しください。",
        contextTeamUnavailable: ({ team }: { team: string }) => `${team} はセッションのコンテキストとして利用できなくなりました。`,
        contextTeamArchived: ({ team }: { team: string }) => `${team} はアーカイブされています。`,
        search: "人、グループ、チームを検索",
        hasAccess: "アクセス権あり",
        yourAccess: "あなたのアクセス権",
        readOnly: "アクセス権を得た経路を確認できます。変更できるのはセッション管理者だけです。",
        sourceDirect: "直接アクセス",
        sourceTeam: "チーム経由のアクセス",
        sourceGroup: "グループ経由のアクセス",
        people: "人",
        groups: "グループ",
        teams: "チーム",
        account: "人",
        group: "グループ",
        team: "チーム",
        view: "閲覧可",
        edit: "指示可",
        admin: "管理",
        owner: "所有者",
        private: "非公開",
        custom: "カスタムアクセス",
        required: "チームのポリシーで必須",
        subjectNotFound: "このユーザー、グループ、またはチームは利用できなくなりました。",
        subjectIneligible: "このユーザー、グループ、またはチームにはアクセス権を付与できなくなりました。",
        teamPolicyRequired: "チームポリシーにより、このアクセス権が必要です。",
        selfGrantManaged: "自分のアクセス権は、別のアクセス管理者が変更する必要があります。",
        homeUnsupported: "この Home はまだセッションアクセスに対応していません。更新すると、このセッションを開けるユーザーを管理できます。",
        openCollaboration: "コラボレーションを開く",
        authenticationRequired: "このチームが承認する方法でサインインしてから、もう一度お試しください。",
        authenticationUnavailable: "このチームで必須のサインイン方法は、この Home では利用できません。",
        delegation: "実行時の権限リクエストを承認できる",
        remove: "アクセス権を削除",
        confirmRemove: "削除を確認",
        credentialsLost: ({ names }: { names: string }) => `次のチーム認証情報はここで使えなくなります: ${names}`,
        ready: "暗号化アクセスの準備完了",
        prepared: "暗号化アクセスを準備済み",
        preparedForEveryone: "アクセスできる全員の準備ができています",
        recipientRepairRequired: "この人はアカウントの暗号化設定を修復する必要があります。",
        pending: "暗号化アクセスは保留中",
        setup: "暗号化の設定が必要",
        repair: "暗号化アクセスの修復が必要",
        unavailable: "暗号化されたコンテンツを利用できません",
        notRequired: "このセッションは暗号化されていないため、準備は不要です。",
        preparing: "暗号化アクセスを準備しています…",
        preparingProgress: ({ count }: { count: number }) => `暗号化アクセスを準備しています… ${count} 件完了`,
        preparationPending: ({ count }: { count: number }) => `暗号化アクセスの準備待ち: ${count} 人`,
        preparationSetup: ({ count }: { count: number }) => `暗号化の設定が必要: ${count} 人`,
        preparationRepair: ({ count }: { count: number }) => `暗号化アクセスの修復が必要: ${count} 人`,
        preparationKeyUnavailable: "この端末ではこのセッションの暗号化アクセスを準備できません。",
        preparationFailed: "アクセスは保存されましたが、暗号化アクセスの準備に失敗しました。",
        preparationPassFailed: "暗号化アクセスの準備に失敗しました。",
        preparationAnnouncedComplete: "暗号化アクセスの準備が完了しました。",
        preparationAnnouncedNeedsAttention: "暗号化アクセスにはまだ設定または修復が必要です。",
        preparationCheckFailed: "暗号化アクセスを確認できませんでした。",
        outcomeUnknown: "結果はまだ確認できません。再試行する前に、Happier が現在のアクセス状態を確認しています。",
        historicalLayoutNotice: "このセッションを共有した相手は、このバージョンの Happier 向けに更新されるまで開けません。",
        historicalLayoutUpdate: "共有用に更新",
        homeReconciled: "新しい Home 用にセッションアクセスをリセットしました。",
        lockedTitleFallback: "暗号化されたセッション",
        encryptedAccess: "暗号化アクセス",
        aggregatePrepared: ({ count }: { count: number }) => `${count} 件完了`,
        aggregatePending: ({ count }: { count: number }) => `${count} 件保留`,
        aggregateNeedsAttention: ({ count }: { count: number }) => `${count} 件は設定または修復が必要`,
        prepareNow: "今すぐ準備",
        prepareAgain: "もう一度準備",
        preparingProgressOf: ({ count, total }: { count: number; total: number }) => `暗号化アクセスを準備しています… ${total} 件中 ${count} 件`,
        showAllRecipients: "ユーザーごとの暗号化を表示",
        hideAllRecipients: "ユーザーごとの暗号化を隠す",
        moreRecipients: "さらに表示",
        recipientPlainAccount: "暗号化なしのアカウント",
        pendingBody: "このセッションは暗号化されています。ここで開くには、管理者が暗号化アクセスを準備する必要があります。",
        setupBody: "このアカウントで暗号化の設定を完了すると、管理者がこのセッションへのアクセスを準備できます。",
        setupAction: "暗号化を設定",
        repairBody: "このセッションに配信された鍵をこの端末で開けませんでした。もう一度試すか、セッションの管理者にアクセスの再準備を依頼してください。",
        retryAction: "もう一度試す",
        unavailableBody: "鍵は開けましたが、このセッションの内容を復号できませんでした。セッションの管理者がアクセスを再準備できます。",
        openAccessAction: "セッションのアクセスを開く",
        removedTitle: "アクセスが削除されました",
        removedBody: "現在のアクセス権ではこのセッションを開けません。セッションの管理者が再度共有できます。",
        removedAnnouncement: ({ name }: { name: string }) => `${name} をセッションのアクセスから削除しました`,
        browseMore: "すべて参照",
        allLoaded: "すべての結果を読み込みました",
        levelHelp: { view: "セッションを閲覧できます", edit: "設定されたツールの権限内でエージェントにプロンプトを送れます", admin: "セッションへのアクセスを管理できます" },
        steeringScopeNotice: "指示は隔離されたチャットではありません。作業フォルダや投稿者名はシェル、ファイルシステム、ネットワークへのアクセスを制限しません。",
        help: "閲覧可は読み取りを許可します。指示可はツールの権限内でエージェントへの指示を許可します。管理はアクセス権の管理も許可します。隔離されたチャットではありません。作業フォルダや投稿者名はシェル、ファイル、ネットワークへのアクセスを制限しません。"
    } } as const;

return { sessionAccessTranslations };
})();

const Domain_sessionAgentActivityTranslations = (() => {
const en = Shared_sessionAgentActivityTranslations.en;

const ja: typeof en = {
    status: {
        queued: 'キュー待ち',
        starting: '開始中',
        running: '実行中',
        waiting: '待機中',
        blocked: 'ブロック中',
        succeeded: '完了',
        failed: '失敗',
        timedOut: 'タイムアウト',
        cancelled: '停止済み',
        unknown: '不明',
    },
    attention: {
        permission: '承認が必要',
        userAction: '回答が必要',
        both: '対応が必要',
        bothDescription: '承認と回答が必要です',
    },
    runKind: {
        conversation: '会話',
        review: 'レビュー',
        plan: '計画',
    },
    /** The Agents pane: its "+", its states, its team groups and its live line (agents lab). */
    roster: {
        teamLabel: ({ team, count }) => `チーム ${team} · エージェント ${count} 件`,
        teamActionsA11y: 'チームの操作',
        openWork: '開く',
        needsYouCount: ({ count }) => `${count} 件が対応待ち`,
        runningCount: ({ count }) => `${count} 件が実行中`,
        nothingRunning: '実行中のものはありません。',
        startAgent: 'エージェントを開始',
        machineOffline: ({ machine }) => `${machine} が応答していません`,
        machineOfflineUnnamed: 'マシンが応答していません',
        launch: {
            menuA11y: 'エージェントを開始',
            conversationDescription: 'このセッションの横でエージェントと話す',
            reviewDescription: 'ここまでの変更を確認する',
            planDescription: '次の手順を計画する',
            delegateDescription: 'タスクを任せて完了した状態で受け取る',
            advancedDescription: 'エージェント、権限、プロファイルを選ぶ',
        },
        empty: {
            title: 'このセッションにエージェントを追加',
            reason: ({ machine }) => `作業を続けながら、別の会話を始めたり、レビューや計画を頼んだりできます。${machine} で実行され、ここに報告します。`,
            reasonUnnamed: '作業を続けながら、別の会話を始めたり、レビューや計画を頼んだりできます。ここに報告します。',
            moreWays: 'レビュー、計画、委任を依頼する',
        },
        unavailable: {
            notEnabled: 'この Home ではエージェントを開始できません。',
            machineOffline: ({ machine }) => `エージェントを開始するには ${machine} がオンラインである必要があります。`,
            machineOfflineUnnamed: 'エージェントを開始するにはこのマシンがオンラインである必要があります。',
            sessionInactive: 'このセッションは停止しています。ここでエージェントを開始するには再開してください。',
            externalRunnerInactive: 'このセッションは Happier の外で開始されました。Happier が接続している間はここからエージェントを開始できます。',
        },
    },
    summaryA11y: ({ title, status }) => `${title}、${status}`,
    summaryAttentionA11y: ({ title, status, attention }) => `${title}、${status}、${attention}`,
};

const sessionAgentActivityTranslations = { ja };

return { sessionAgentActivityTranslations };
})();

const Domain_sessionBoardTranslations = (() => {
type SessionBoardStateTranslation = Shared_sessionBoardTranslations.SessionBoardStateTranslation;

type SessionBoardTranslation = Shared_sessionBoardTranslations.SessionBoardTranslation;

const sessionBoardTranslations = { ja: {
        title: 'ボード',
        views: {
            label: 'ボードのビュー',
            overview: '概要',
            createTitle: '新しいボードのビュー',
            renameTitle: 'ボードのビュー名を変更',
            reconciled: ({ title }) => `そのボードのビューは削除されました。${title}を表示しています。`,
            empty: {
                title: 'このビューには何もありません',
                reason: 'ここにウィジェットを追加するか、別のボードのビューに切り替えてください。',
            },
            actions: {
                create: '新しいビュー',
                rename: 'ビュー名を変更',
                moveBefore: 'ビューを前へ',
                moveAfter: 'ビューを後ろへ',
                remove: 'ビューを削除',
            },
            remove: {
                title: ({ title }) => `「${title}」を削除しますか？`,
                moveMessage: ({ title }) => `ウィジェットは${title}へ移動します。セッションからは何も削除されません。`,
                unpinMessage: 'ウィジェットはセッションに残りますが、どのビューにも固定されなくなります。',
            },
        },
        add: { note: 'メモ', interactiveView: 'インタラクティブビュー' },
        width: { compact: '狭い', medium: '中くらい', wide: '広い', full: '全幅' },
        height: { auto: '内容に合わせる', compact: '低め', regular: '標準', tall: '高め' },
        board: {
            loading: { title: 'ボードを開いています', reason: 'このセッションにピン留めされたものを読み込んでいます。' },
            locked: {
                title: 'ボードはまだ暗号化されています',
                reason: 'この端末ではまだセッションを開けません。失われたものはありません。',
            },
            unopenable: {
                title: 'ボードの並びを読み取れません',
                reason: '保存された並びを開けませんでした。ウィジェット自体には影響しません。',
            },
            unsupported: {
                title: 'このボードには新しい Happier が必要です',
                reason: '内容はそのまま残ります。対応した端末で開くか、Happier を更新してください。',
            },
            unavailable: {
                title: 'ここではまだボードを使えません',
                reason: '失われたものはありません。この Home がボードを有効にすると表示されます。',
            },
            offline: 'オフライン — 最後に読み込んだ状態を表示しています。',
            offlineEmpty: 'オフライン — 再接続するとこのボードを読み込めます。',
            stale: '最後に読み込んだ状態を表示しています。',
        },
        empty: {
            editor: {
                title: '計画をチャットのそばに',
                description: 'ここにピン留めしたメモやライブビューはこのセッションに残り、読める人全員が見られます。',
                askAgent: 'エージェントに頼む',
                askAgentPrompt: 'このボードに次の内容を表示するものを置いて：',
                addNote: 'メモを追加',
            },
            viewer: {
                title: 'ボードにはまだ何もありません',
                description: '人やエージェントがこのセッションにピン留めしたものがここに並びます。',
            },
        },
        item: {
            untitled: '無題のウィジェット',
            renameA11y: 'ウィジェットのタイトル',
            reorderA11y: ({ title }) => `${title} を並べ替え`,
            a11yLabelWithWidth: ({ title, width }) => `${title}、${width}`,
            menuGroups: { content: '閲覧と編集', movement: '移動', geometry: 'サイズ', destructive: '削除' },
            loading: { title: 'ウィジェットを読み込み中', reason: 'この Home から内容を取得しています。' },
            locked: {
                title: '暗号化された内容は表示できません',
                reason: 'この端末がセッションを開けるようになるまで、このウィジェットは暗号化されたままです。',
            },
            unopenable: {
                title: 'このウィジェットは表示できません',
                reason: '保存された内容を読み取れませんでした。ボードの他の部分はそのまま使えます。',
            },
            unsupported: {
                title: 'このウィジェットには新しい Happier が必要です',
                reason: '内容は残っています。対応した端末で開くか、Happier を更新してください。',
            },
            notCopied: { title: 'ビジュアルはコピーされませんでした', reason: 'このビジュアルをこの分岐にコピーできませんでした。' },
            runningElsewhere: { title: '別の場所で表示中', reason: 'このビジュアルは一度に1か所でのみライブ表示されます。' },
            missing: {
                title: 'このウィジェットが見つかりません',
                reason: 'ボードはまだ参照していますが、内容はこの Home にありません。',
            },
            removed: {
                title: 'このウィジェットはボードから削除されました',
                reason: '編集権限のある人が全員のために削除しました。',
            },
            pluginUnavailable: {
                title: 'この端末ではプラグインを利用できません',
                reason: 'ウィジェットは残っています。プラグインが使えるようになれば再び表示されます。',
            },
            rendererUnavailable: {
                title: 'この端末ではこのウィジェットを表示できません',
                reason: '内容は残っています。インタラクティブビューに対応した端末で開いてください。',
            },
            provenance: {
                note: 'メモ',
                chart: 'グラフ',
                table: '表',
                interactiveView: 'インタラクティブビュー',
                snapshot: 'スナップショット',
                snapshotByYou: 'あなたのスナップショット',
                snapshotBy: ({ name }) => `${name}のスナップショット`,
                pluginMissing: ({ pluginId }) => `${pluginId} · 未インストール`,
                pluginQualified: ({ label, pluginId }) => `${label} (${pluginId})`,
            },
            actions: {
                remove: 'ボードから削除',
                openHere: 'ここで開く',
                managePlugin: 'プラグインを管理',
                prepareEncryption: '暗号化を設定',
                readFull: 'メモ全文を読む',
                rename: 'ウィジェットの名前を変更',
                unpin: 'このビューから外す',
                pinToBoard: 'ボードにピン留め',
                moveToView: ({ title }) => `${title}に移動`,
                network: 'ネットワークアクセス…',
            },
            network: {
                title: 'ネットワークアクセス',
                hint: 'このビジュアルを表示するブラウザーから接続できるサイトです。',
                reach: '接続先',
                none: 'なし',
                sites: '指定したサイト',
                open: 'すべてのサイト',
                sitesLabel: 'サイト',
                sitesPlaceholder: 'https://api.example.com',
                sitesInvalid: ({ sites }) => `サイトのアドレスではありません: ${sites}。https://example.com の形式で入力してください。`,
                sitesNeeded: 'サイトを1つ以上追加してください。',
                noneConsequence: '単独で動作し、外部へのリクエストは行いません。',
                sitesConsequence: '一覧にあるサイトにのみ接続できます。リモートのコードやアセットは変更される場合があります。',
                openConsequence: 'あらゆるサイトに接続し、内容を送信し、閲覧者のIPアドレスを知らせる可能性があります。リモートのコードは変更される場合があります。',
                shareOffNote: '公開リンクは、ネットワークアクセスをオフにして共有することもできます。',
                failed: 'ネットワークアクセスを変更できませんでした。もう一度お試しください。',
            },
            moved: {
                before: ({ title }) => `${title}を前に移動しました。`,
                after: ({ title }) => `${title}を後ろに移動しました。`,
                reordered: ({ title }) => `${title}を移動しました。`,
                toView: ({ title, view }) => `${title}を${view}に移動しました。`,
            },
            movePosition: ({ position, total }) => `${total} 件中 ${position} 件目`,
            moveTargetView: ({ title }) => `ボードビュー${title}`,
            remove: {
                title: 'このウィジェットを削除しますか？',
                message: 'このセッションを読めるすべての人がこれを失います。インストール済みのプラグインはそのまま残ります。',
            },
        },
        note: {
            titlePlaceholder: 'タイトル',
            titleA11y: 'メモのタイトル',
            untitled: '無題のメモ',
            offline: '保存にはこの Home への接続が必要です。',
            unavailable: 'この Home ではまだボードを変更できません。',
            failed: 'Happier はこのメモを保存できませんでした。入力した内容は残っています。',
            outcomeUnknown: '保存できたかどうかを確認できませんでした。再保存の前に読み込み直してください。',
            saved: 'メモを保存しました',
            conflict: {
                message: 'このメモは別の端末で変更されました。',
                reviewLatest: '最新版を確認',
                applyMine: '自分の変更を適用',
                latestHeading: '最新版',
            },
        },
        recovered: {
            title: '復元された項目',
            description: 'これらのウィジェットはこのセッションにありますが、どのボードのビューにも配置されていません。',
            pin: 'このビューに追加',
        },
        mutation: {
            approvalRequired: 'キューに登録済み · 承認待ち',
            conflict: 'このボードは別の端末で変更されました。最新の内容は読み込み直してください。',
            outcomeUnknown: 'その変更が保存されたかどうかを確認できませんでした。',
            denied: 'このボードを変更する権限がなくなりました。',
            offline: 'ボードの変更にはこの Home への接続が必要です。',
            unavailable: 'この Home ではまだボードを変更できません。',
            updateRequired: 'このボードの変更を行うには Happier を更新してください。',
            noteTooLarge: 'このノートは大きすぎて保存できません。テキストはそのまま残っています。',
            invalid: 'このボードの変更は無効です。確認してからもう一度お試しください。',
            notFound: 'このボード項目は利用できなくなりました。ボードを再読み込みしてください。',
            storageFailed: 'この変更を安全に保存できませんでした。作業内容はそのまま残っています。',
            serverFailed: 'この Home ではボードの変更を完了できませんでした。もう一度お試しください。',
            failed: 'Happier はそのボードの変更を適用できませんでした。',
        },
        hostedHtmlApproval: {
            title: 'このインタラクティブビューを許可しますか？',
            body: 'この許可はこのセッションのこのビューにのみ適用されます。メッセージを送るには、引き続きビュー内をクリックする必要があります。',
            resources: ({ count }) => `セッションのリソースを${count}件読み取れます`,
            actions: ({ count }) => `アクションを${count}件実行できます`,
            sendMessages: 'Happier にメッセージの送信を依頼できます',
            loadsFrom: ({ origin }) => `${origin} から読み込みます`,
            allow: '許可',
            notNow: '今はしない',
            declined: {
                title: 'インタラクティブビューはまだ許可されていません',
                reason: '要求内容はいつでも確認できます。',
                review: '確認',
            },
        },
        sidebar: {
            openInDetails: '詳細で開く',
            openBoard: 'ボードを開く',
            sharedWithEveryone: 'ここにいる全員と共有',
            widgetCount: ({ count }) => `${count} 個のウィジェット`,
        },
        mobile: { searchPlaceholder: 'このボードを検索' },
        inline: {
            openPanel: 'パネルで開く',
            showHere: 'ここに表示',
            openPanelA11y: ({ title }) => `「${title}」をパネルで開く`,
        },
        companion: {
            title: 'コンパニオン',
            inCompanionA11y: 'コンパニオンに表示中',
            empty: {
                title: 'セッションを目の届くところに',
                reason: 'セッション概要やボードのウィジェットをチャットの横に置けます：実行中のもの、あなたを待っているもの、変更点。',
                note: 'コンパニオンはあなただけに表示されます。',
            },
            pane: {
                besideChat: 'チャットの横',
                itemCount: ({ count }: { count: number }) => `${count} 件`,
                justForYou: 'あなただけの、チャットの横',
            },
            actions: {
                addSummary: 'セッション概要を追加',
                addItem: ({ title }) => `${title}を追加`,
                moveToLeading: '左側に移動',
                moveToTrailing: '右側に移動',
                moveToFirst: '先頭に移動',
                moveToLast: '末尾に移動',
                compact: 'コンパクト表示',
                comfortable: 'ゆったり表示',
                openFull: 'コンパニオン全体を開く',
                openOnBoard: 'ボードで開く',
                collapse: 'コンパニオンを折りたたむ',
                expand: 'コンパニオンを展開',
                hide: 'コンパニオンを隠す',
                addToCompanion: 'コンパニオンに追加',
                removeFromCompanion: 'コンパニオンから削除',
                undo: '元に戻す',
                menuA11y: 'コンパニオンのオプション',
                itemMenuA11y: ({ title }) => `${title}のオプション`,
            },
            a11y: {
                headerAction: ({ count }) => `コンパニオン、${count} 件`,
                show: ({ count }) => `コンパニオンを表示、${count} 件`,
                expand: ({ count }) => `コンパニオンを展開、${count} 件`,
            },
            summary: {
                review: '確認',
                title: 'セッション概要',
                untitled: 'セッション',
                approvals: ({ count }) => `${count} 件があなたを待っています`,
                workflows: ({ count }) => `${count} 件のワークフローが実行中`,
                changedFiles: ({ count }) => `${count} 件変更`,
                tokens: ({ count }) => `${count} トークン`,
                contextPercent: ({ percent }) => `コンテキスト ${percent}%`,
                contextOnly: '使用中のコンテキスト',
                moreDetails: '詳細を表示',
                moreDetailsA11y: ({ count }) => `詳細を表示、他 ${count} 行`,
                partial: 'ここからは見えない情報があります。',
            },
            notices: {
                shown: 'コンパニオンを表示しました',
                hidden: 'コンパニオンを非表示にしました',
                added: 'コンパニオンに追加しました',
                removed: 'コンパニオンから削除しました',
                reordered: 'コンパニオンを並べ替えました',
                moved: 'コンパニオンを移動しました',
                boardOpened: 'エージェントがボードを開きました',
                returnedToChat: 'エージェントがチャットに戻りました',
                boardViewSelected: 'エージェントがボードビューを選択しました',
                boardItemRevealed: 'エージェントがボード項目を開きました',
                shownInChat: 'エージェントが会話に表示しました',
                fullOpened: 'エージェントがコンパニオンを開きました',
            },
        },
    } } as const satisfies Pick<Readonly<Record<string, SessionBoardTranslation>>, "ja">;

return { sessionBoardTranslations };
})();

const Domain_sessionCollaborationPaneTranslations = (() => {
type PaneCopy = Shared_sessionCollaborationPaneTranslations.PaneCopy;

const en = Shared_sessionCollaborationPaneTranslations.en;

const sessionCollaborationPaneTranslations: Pick<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', PaneCopy>, "ja"> = { ja: {
        hereOne: ({ name }) => `${name}さんがいます`,
        hereTwo: ({ first, second }) => `${first}さんと${second}さんがいます`,
        hereMany: ({ first, count }) => `${first}さんとほか${count.toLocaleString()}人がいます`,
        typingOne: ({ name }) => `${name}さんが入力中…`,
        typingMany: ({ count }) => `${count.toLocaleString()}人が入力中…`,
        justYouHere: 'いるのはあなただけです',
        you: 'あなた',
        presenceConnecting: '誰がいるか確認しています…',
        presenceUnavailable: 'リアルタイムの在席情報が現在応答していません',
        presenceUnsupported: 'このHomeではリアルタイムの在席情報を利用できません',
        responsibleUnsupported: 'このHomeでは担当者を記録していません',
        inviteTitle: 'セッションの横で話し合う',
        inviteBody: '会話を始めてメンションし、準備ができたら回答をエージェントに渡しましょう。',
        readOnly: '閲覧できます。このセッションを編集できる人が投稿できます。',
        offline: 'オフラインです · 最後に読み込んだ会話を表示しています',
        lockedTitle: 'このデバイスではまだこれらの会話を開けません',
        lockedBody: 'エンドツーエンドで暗号化されており、このデバイスの暗号化設定がセッションの設定と一致しません。',
        revokedTitle: 'これらの会話にアクセスできなくなりました',
        revokedBody: 'このセッションの管理者が閲覧できる人を変更しました。あなたが書いたメッセージはセッションに残ります。',
        namesTwo: ({ first, second }) => `${first}、${second}`,
        namesThree: ({ first, second, third }) => `${first}、${second}、${third}`,
        namesMore: ({ first, second, count }) => `${first}、${second}ほか${count.toLocaleString()}件`,
        haveAccess: 'アクセス権あり',
        hasAccess: 'アクセス権あり',
        onlyYou: 'あなただけ',
        notShared: 'まだ誰とも共有していません',
        publicLinkOn: '公開リンク オン',
        accessLoading: 'アクセスできる人を確認しています…',
        accessError: 'アクセスできる人を読み込めませんでした',
        shareTitle: 'このセッションを共有',
        shareBody: ({ home }) => `${home}で追加した人は、このセッションを見守り会話に参加できます。`,
        collapse: '折りたたむ',
        linkOn: 'オン',
        linkOff: 'オフ',
        linkGrants: 'リンクを知っている人は誰でもトランスクリプトを閲覧できます(アカウント不要)。',
        linkExpires: ({ date }) => `有効期限 ${date}`,
        linkNeverExpires: '無期限',
        linkAsksConsent: '同意を確認',
        linkNoConsent: '同意の確認なし',
        linkHidden: 'このリンクは以前に作成されたため再表示できません。コピーするには新しいリンクを作成してください。',
        qrCode: 'QRコード',
        hideQrCode: 'QRコードを隠す',
        newLink: '新しいリンク…',
        turnOff: 'オフにする',
        turnOffTitle: '公開リンクをオフにしますか?',
        turnOffBody: 'リンクを持っている人はすぐにアクセスできなくなります。あとで新しいリンクを作成できます。',
        newLinkReplaces: '新しいリンクを作成すると、現在のリンクは使えなくなります。',
        linkDenied: '公開リンクを作成できるのは、このセッションの管理者だけです。',
        linkLoadFailed: '公開リンクを確認できませんでした。',
        linkNetworkOff: 'ビジュアルのネットワークアクセスを無効にして共有',
        linkNetworkCount: ({ count, total }) => `含まれる ${total} 個のビジュアルのうち ${count} 個が外部サイトに接続できます`,
        linkNetworkOpen: 'すべてのサイト',
        linkNetworkUnknown: 'ネットワークアクセスを確認できませんでした。再試行するか、ネットワークアクセスを無効にして共有してください。',
        linkNetworkConsequence: 'ネットワークに接続できるビジュアルは、内容を外部サイトに送信し、閲覧者の IP アドレスを公開する場合があります。外部のコードや素材は変更される可能性があります。無効にしても、同梱されたコンテンツは外部通信なしで操作できます。',
        linkUnavailable: "このHomeでは公開リンクを利用できません。Homeの所有者に、独立した共有ドメインの設定か、このホスト名でのリンクの許可を依頼してください。公開リンクのリクエスト制限も設定する必要があります。",
        configurePublicLinks: "公開リンクを設定",
        followersTitle: 'フォロワー',
        followersDescription: 'このセッションの通知を受け取る人と、その受け取り方。ほかの人のレベルは非公開です。',
        followersYou: 'あなた',
        followersPeople: ({ count }: { count: number }) => `${count} 人`,
        followersPeopleNote: '各自のレベルは本人のもの',
        followersSessionMeaning: { everything: '更新のたびに起こす', important: '必要なときに起こす', quiet: '次のターンで' },
        followersManager: 'マネージャー',
        followersAlsoFollows: 'このセッションもフォロー中',
        followersEffectiveWake: '起こすことができます',
        followersEffectiveNextTurn: '次のターンで',
        followersEffectiveOff: 'イベント未選択',
        followersSessions: ({ count }: { count: number }) => `${count} セッション`,
        followedBy: ({ facts, count }: { facts: string; count: number }) => `${facts} ${count === 1 ? 'がフォロー中' : 'がフォロー中'}`,
        followingRules: ({ count }: { count: number }) => `${count} 件のルール`,
        follows: ({ facts }: { facts: string }) => `フォロー中: ${facts}`,
        sharingOffTitle: ({ home }) => `${home}ではセッションを他の人と共有しません`,
        sharingOffBody: '誰でも閲覧できる公開リンクは作成できます。',
        sharingOffPrivateBody: 'このHomeのセッションはあなただけのものです。',
        accessDenied: 'アクセスできる人を変更できるのは、このセッションの管理者だけです。会話には引き続き参加できます。',
    } };

return { sessionCollaborationPaneTranslations };
})();

const Domain_sessionCollaborationTranslations = (() => {
const sessionCollaborationPaneTranslations = {...Domain_sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations, ...EnglishFeatures.sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations};

const en = Shared_sessionCollaborationTranslations.en;

const sessionCollaborationTranslations: Pick<Record<'en'|'ca'|'de'|'es'|'fr'|'it'|'ja'|'pl'|'pt'|'ru'|'zh-Hans'|'zh-Hant', typeof en>, "ja"> = { ja: { pane: sessionCollaborationPaneTranslations['ja'], readiness: sessionReadinessCopy.ja, title: 'メンバー', viewingNow: '現在閲覧中', justYou: 'あなただけ', typing: '入力中…', stale: '最新ではない可能性があります', unavailable: 'リアルタイムの在席情報を取得できません', connecting: '接続中…', unnamed: 'Happierメンバー', open: 'コラボレーションを開く', conversations: "ディスカッション", accessUnavailable: 'セッションのアクセス権を利用できません', accessUnavailableReason: 'この Home はセッションを他の人と共有する機能に対応していません。', discussion: { openAnchor: ({ name }: { name: string }) => `${name} を開く`, reply: { readUpTo: "質問までのディスカッションを読みました", passed: "パスしました", failed: "回答できませんでした", cancelled: "回答前に停止しました", stopped: "完了前に停止しました" }, participants: { title: "参加者", loading: "参加中のメンバーを確認中…", moreSessionsFailed: "これ以上のセッションを読み込めませんでした。", peopleGroup: "メンバー", agentsGroup: "エージェント", agentsNote: "それぞれ自分のセッション、マシン、承認を保持します", owner: "オーナー", you: "あなた", hereNow: "参加中", canPost: "投稿可", canRead: "閲覧可", teamAccess: "チームのアクセス", noAgents: "まだエージェントはいません", model: "モデル", session: "セッション", modelStarting: "モデルを起動中", policyWhenAddressed: "メンションされたら回答", policyReadsOnly: "閲覧のみ", policyDrafts: "承認用の下書き", policyWatches: "見守って発言", privateNote: "招待されたメンバーだけが閲覧できます。メンションで権限が付与されることはありません。", mentionNote: "メンションで権限が付与されることはありません。", inheritedNote: "招待されたメンバーとそのチームが閲覧できます。メンションで権限が付与されることはありません。", leave: "退出", invitedOnly: "招待のみ", teamCanRead: "チームが閲覧可", people: ({ count }) => count === 1 ? 'あなただけ' : `${count.toLocaleString()} 人`, peopleAndAgents: ({ people, agents }) => `${people.toLocaleString()} 人、エージェント ${agents.toLocaleString()}` }, home: { search: "ディスカッションを検索", needsYou: "対応が必要", filter: "絞り込み", filterAll: "すべてのディスカッション", filterUnread: "未読", filterEmpty: "この条件に合うものはありません", today: "今日", thisWeek: "今週", earlier: "それ以前", columnEmpty: "招待されたディスカッションがここに表示されます", inviteTitle: "人やエージェントと話し合う", inviteBody: "チームメイト、セッション、ボット、モデルを 1 つの会話に集めましょう。エージェントにメンションすると、そのエージェント自身のセッションと承認で回答します。", idleTitle: "ディスカッションを開く", idleBody: "一覧から選ぶか、人やエージェントと新しく始めましょう。", audience: "招待した人だけ", draftWaiting: "下書きがあなたを待っています", approvalPending: "承認が必要です" }, manage: { startAgain: "もう一度開始", startAgainBody: "セッションが開始されていません。同じ設定でもう一度試します。", invitePlaceholder: "人、セッション、モデルを検索", policyWhenAddressedBody: "メンション、またはそれへの返信。既定。", policyReadsOnlyBody: "読むだけで、ここでは答えません。", policyDraftsBody: "回答はあなたが投稿するか破棄します。", policyWatchesBody: "すべてのメッセージを読み、答えることがあります。黙っていてもターンを使います。", answersGroup: "回答", operationsGroup: "セッション", openSession: "セッションを開く", removeModel: "削除してセッションをアーカイブ", removeModelBody: "このディスカッション用に開始されました。履歴は残ります。", removeSession: "このディスカッションから外す", removeSessionBody: "セッションはそのまま動き続けます。", rowHint: "回答方法を選ぶ、開く、または外す", working: "保存中…", checking: "完了したか確認中…", failed: "うまくいきませんでした。", leaveTitle: "このディスカッションを退出", leaveBody: "所有者が必要です。ここにいる人に渡すか、アーカイブしてください。何も削除されません。", transferGroup: "別の人を所有者にする", transferSubtitle: "所有者になり、その後あなたが退出します", noTransferCandidates: "渡すには、まず誰かを招待してください。", archiveInstead: "代わりにアーカイブ", archiveInsteadBody: "所有者のままです。復元するまで誰も投稿できません。", inviteSubtitle: "招待した人だけが読めます", sessionsGroup: "あなたのセッション", modelsGroup: "モデル", sessionCandidate: "それぞれメンションされると回答", modelOn: ({ machine }: { machine: string }) => `${machine} のモデル`, modelCandidate: "あなたの新しいセッション · エージェントとモデルを選択", startedGroup: "このディスカッション用に開始", modelSessionOn: ({ machine }: { machine: string }) => `${machine} 上のあなたのセッション`, modelStartingOn: ({ machine }: { machine: string }) => `${machine} で開始中…`, modelFailedOn: ({ machine }: { machine: string }) => `${machine} で開始できませんでした`, modelNotStartedOn: ({ machine }: { machine: string }) => `${machine} で未開始` }, invite: { button: "招待", title: ({ title }: { title: string }) => `${title} に招待`, canManage: "管理できる", ownerOnly: "招待する相手を変更できるのはオーナーだけです。", failed: "招待を保存できませんでした。" }, composer: { mention: "メンション", mentionHint: "エージェントをメンションすると回答します" }, newPage: { invitePlaceholder: "人またはセッションを検索", inviteTitle: "一緒に始める相手", invitedTitle: ({ names, count }: { names: string; count: number }) => count === 1 ? `${names}を招待しました` : `${names}を招待しました`, namePlaceholder: "このディスカッションに名前を付ける", emptyTitle: "回答してほしい相手をメンション", emptyBody: "エージェントはメンションされたときだけ回答します。誰もメンションしないメッセージは人だけに届きます。" }, secondOpinion: { title: "セカンドオピニオンを求める", discussTitle: "この回答について話し合う", discussionTitle: "セカンドオピニオン", discussDiscussionTitle: "この回答について", defaultQuestion: "これで合っていますか？どこを変えますか？", subtitle: ({ session }: { session: string }) => `${session} の回答について`, subtitleUntitled: "この回答について", answer: "この回答", open: "ディスカッションを開く", askQuoteOnly: "引用だけで質問", shareAndAsk: "共有して質問", ask: "質問する", askGroup: "質問先", freshOpinionsHint: "2つ以上選ぶと独立した意見を実行します", askFreshOpinions: ({ count }: { count: number }) => `${count}件に質問 · 独立した意見`, whereBody: "独立した意見はこのマシンとフォルダーから実行されます。", noReviewers: "このHomeにはまだ他のセッションがありません", yourSession: "セッション", moreSessions: "さらにセッションを表示", question: "質問", thisSession: "このセッション", cannotAskTitle: ({ name }: { name: string }) => `${name} にはここで質問できません`, quoteOnlyTitle: ({ name }: { name: string }) => `${name} には引用だけが見えます`, quoteOnlyBody: "このセッションの残りは開けません。", grantTitle: ({ name }: { name: string }) => `${name} にこのセッションの閲覧を許可`, grantBody: ({ name, session }: { name: string; session: string }) => `${name} は取り消すまで ${session} を閲覧できます。`, grantUnavailable: "このセッションは共有できないため、引用だけが送られます。", readsAsYouTitle: ({ name }: { name: string }) => `${name} はあなたとしてこのセッションを読みます`, readsTitle: ({ name }: { name: string }) => `${name} はすでにこのセッションを読めます`, readsAsYouBody: "新たに共有されるものはありません。", discussionTitleRow: "新しいディスカッション", discussionOnlyYou: "誰かを招待するまで、あなただけです。", discussionPeople: ({ count }: { count: number }) => `あなたと他 ${count} 人が読めます`, readsGroup: "閲覧できる範囲", disclosure: { sameSession: "この回答を書いたセッションです。", broader: "今この回答を読める人より多くの人に見えてしまいます。", public: "公開されてしまいます。", notAllowed: "このHomeの共有ルールでは許可されていません。", unavailable: "今はこの回答を読めません。" }, discussDone: "ディスカッションを開始しました", asked: ({ name }: { name: string }) => `${name} に質問しました`, askedBody: "回答はディスカッションに届きます。", freshStarted: ({ count }: { count: number }) => `${count}件で独立した意見を開始しました`, freshStartedBody: "それぞれが個別に回答し、回答はディスカッションに届きます。", openRun: "実行を開く", failed: "完了できませんでした。", pending: "まだ終わっていません。もう一度試すと続きから再開します。", previewChanged: "閲覧できる人が変わりました。確認してからもう一度質問してください。" }, draftReview: { post: "投稿", decline: "却下" }, replyDraft: { action: "返信", replyingTo: ({ name }: { name: string }) => `${name} に返信中`, removedTitle: ({ names }: { names: string }) => `送信先から外しました: ${names}`, removedBody: "このディスカッションにもういないため、何も送られません。" },
        quote: discussionQuoteCopy.ja, controls: discussionControlsCopy.ja, attribution: discussionAttributionCopy.ja,
        heldParticipant: "セッション参加者",
        participantHeld: ({ participant }: { participant: string }) => `${participant}は保留中です。別のアカウントからの依頼にはまだ対応していません。`,
        featureUnavailable: "この Home では会話が有効になっていません。", bindingUnavailable: "会話を表示するには、この Home に再度サインインしてください。", scopeMismatch: "これらの会話は、この Home の別のアカウントに属しています。", modeMismatch: "内容がセッションの暗号化モードと一致しません。再試行するか、セッション管理者にアクセスの確認を依頼してください。",  title: "ディスカッション", newDiscussion: "新しいディスカッション", create: '会話を作成', titlePlaceholder: '会話のタイトル', messagePlaceholder: 'メッセージを書く…', active: '進行中', activeDisclosure: '進行中の会話を表示', archived: 'アーカイブ済み', archivedDisclosure: 'アーカイブ済みの会話を表示', emptyActive: '進行中の会話はまだありません。', emptyArchived: 'アーカイブ済みの会話はありません。', loading: '会話を読み込み中…', loadError: '会話を読み込めませんでした。', retry: 'もう一度試す', checking: '更新を確認中…', deliveryUnknown: '配信結果が不明です — 再試行する前に確認してください。', locked: 'この会話は読めますが、投稿はできません。', offline: 'オフラインです。再接続して続けてください。', unavailable: 'この会話は利用できません。', unreadCount: ({ count }) => `未読${count.toLocaleString()}件`, unreadMentionCount: ({ count }) => `未読のメンション${count.toLocaleString()}件`,
        mentioned: 'あなたがメンションされました', unreadConversations: '未読の会話', messageCount: ({ count }) => `${count.toLocaleString()}件のメッセージ`, viaAgent: 'Agent経由', collaborator: '共同作業者', contentUnavailable: 'メッセージを利用できません', rename: '会話名を変更', archive: '会話をアーカイブ', restore: '会話を復元', selection: { copy: 'コピー', askAgent: 'Agentに質問', sendToSession: 'セッションに送信', handoffError: '選択したメッセージをセッションの入力欄に追加できませんでした。' }, titleRequired: 'この会話を始めるにはタイトルを追加してください。', encryptedTitle: '暗号化された会話', archivedNotice: 'この会話はアーカイブされています。', sessionArchived: 'このセッションはアーカイブされています。', postDenied: 'このセッションには投稿できなくなりました。', invalidMention: 'メンションした相手はこのセッションを読めなくなりました。', invalidContent: 'このメッセージはこのままでは送信できません。空か、長すぎる可能性があります。', idempotencyConflict: 'この識別子では別のメッセージがすでに送信されています。', sendFailed: 'このメッセージを送信できませんでした。', dismiss: '閉じる', loadOlder: '以前のメッセージを読み込む', loadMore: 'さらに会話を読み込む' } } };

return { sessionCollaborationTranslations };
})();

const Domain_sessionCompanionTranslations = (() => {
type SessionCompanionTranslations = Shared_sessionCompanionTranslations.SessionCompanionTranslations;

const sessionCompanionTranslations = { ja: {
        recap: { title: '振り返り' },
        status: {
            waitingForYou: 'あなたの対応待ち',
            pausedBeforeStep: ({ agent, step, total }) => `${agent} はステップ ${step}/${total} の前で一時停止しています`,
            stepOfPlan: ({ step, total }) => `計画のステップ ${step}/${total}`,
            agentFallback: 'エージェント',
        },
        ask: {
            question: ({ summary }) => `${summary}?`,
            allow: '許可',
            deny: '拒否',
            showInChat: 'チャットで表示',
            moreWaiting: ({ count }) => `ほかに ${count} 件が待機中`,
            allowed: ({ summary }) => `許可しました: ${summary}`,
            denied: ({ summary }) => `拒否しました: ${summary}`,
            justNow: 'たった今',
            failed: '回答がセッションに届きませんでした。もう一度お試しください。',
            answerWhenBack: ({ machine }) => `${machine} が戻ったら回答できます。`,
            answerWhenSessionBack: 'セッションが戻ったら回答できます。',
            notAllowed: 'このセッションを実行できる人だけが回答できます。',
            groupA11y: 'あなたの対応待ち',
        },
        facts: {
            subagents: 'サブエージェント',
            changed: '変更',
            context: 'コンテキスト',
            subagentsValue: ({ live, total }) => (live > 0 ? `${live}/${total}` : `${total}`),
            contextValue: ({ percent }) => `${percent}%`,
            opensAgents: 'エージェントを開く',
            opensGit: 'Git を開く',
            opensUsage: '使用量を開く',
        },
        plan: {
            title: '計画',
            description: ({ agent }) => `このセッションでの ${agent} の ToDo リスト`,
            progress: ({ done, total }) => `${done}/${total}`,
            progressA11y: ({ done, total }) => `${total} 件中 ${done} 件完了`,
            emptyTitle: 'まだ計画はありません',
            emptyReason: 'エージェントが ToDo リストを書くと、ここに一歩ずつ表示されます。',
            stepDone: '完了',
            stepCurrent: '現在のステップ',
        },
        picker: {
            open: 'コンパニオンに追加',
            chooseWidget: 'ウィジェットを選択…',
            onTheBoard: ({ source }) => `${source} · ボード上`,
        },
        drop: { keepBesideChat: 'チャットの横に置く' },
        freshness: { machineOffline: ({ machine }) => `${machine} はオフラインです` },
        needsYouA11y: ({ count }) => `コンパニオン、${count} 件があなたを待っています`,
    } } as const satisfies Pick<Readonly<Record<string, SessionCompanionTranslations>>, "ja">;

return { sessionCompanionTranslations };
})();

const Domain_sessionConversationSurfaceTranslations = (() => {
const en = Shared_sessionConversationSurfaceTranslations.en;

const ja: typeof en = {
    discussion: {
        loadingTitle: '会話を開いています…',
        offlineTitle: 'この会話はオフラインでは利用できません',
        offlineReason: '再接続すると、前回の続きから開きます。',
        errorTitle: '会話を開けませんでした',
        lockedTitle: 'このデバイスではまだこの会話を開けません',
        lockedReason: 'エンドツーエンドで暗号化されており、このデバイスの暗号化設定がセッションと一致しません。',
        revokedTitle: 'この会話へのアクセス権がなくなりました',
        revokedReason: 'このセッションはもう共有されていません。あなたが書いたメッセージはセッションに残ります。',
        unavailableTitle: 'ここでは会話を利用できません',
        closeTab: 'タブを閉じる',
    },
    draft: {
        leadTitle: 'エージェントに聞く',
        leadBody: 'セッションの横で独立した会話として実行され、これらのメッセージが文脈になります。送信するまで何も始まりません。',
    },
    context: {
        fromConversation: ({ title, count }) => `${title}から · ${count}件のメッセージ`,
        fromUntitled: ({ count }) => `会話から · ${count}件のメッセージ`,
    },
    origin: {
        fromConversation: ({ title }) => `${title}から`,
        fromUntitled: '会話から',
    },
    run: {
        details: '実行の詳細',
        loadingTitle: 'エージェントとの会話を開いています…',
        errorTitle: 'エージェントとの会話を開けませんでした',
    },
};

const sessionConversationSurfaceTranslations = { ja };

return { sessionConversationSurfaceTranslations };
})();

const Domain_sessionDirectoryRecoveryTranslations = (() => {
const en = Shared_sessionDirectoryRecoveryTranslations.en;

const sessionDirectoryRecoveryTranslations = { ja: {
        title: ({ machine }) => `このチャットの専用フォルダーは ${machine} にありません。`,
        body: '新しい空のフォルダーで続行できます。チャット履歴はここに残りますが、以前のフォルダーのローカルファイルは復元されません。',
        continue: '新しいフォルダーで続行', notNow: '今はしない',
        offlineDelete: ({ machine }) => `${machine} の専用フォルダーは、そのマシンが次にオンラインになったときに削除されます。`,
    } } satisfies Pick<Record<import('../../_all').SupportedLanguage, typeof en>, "ja">;

return { sessionDirectoryRecoveryTranslations };
})();

const Domain_sessionDraftTranslations = (() => {
const en = Shared_sessionDraftTranslations.en;

const ja: typeof en = {
    sectionTitle: '下書き',
    sectionTitleForHome: ({ home }) => `${home} の下書き`,
    showAll: ({ count }) => `すべて表示（${count}）`,
    waitingSectionTitleForHome: ({ home }) => `${home} でマシンを待機中`,
    badge: '下書き',
    untitled: '無題の下書き',
    continueEditing: '編集を続ける',
    startAnother: '別の下書きを開始',
    executionRunStart: {
        starting: 'エージェントとの会話を開始しています…',
        reconciling: 'このエージェントとの会話が開始されたか確認しています…',
        unresolved: 'このエージェントとの会話が開始されたか確認できませんでした。もう一度開始すると会話が二重になる可能性があります。',
        targetChanged: '会話を開始する前に、このセッションのマシンが変わりました。何も開始されていません。',
        submittedUnknown: '開始されたか確認できませんでした。実行一覧を確認してください。ランナーが動作していない場合は、セッションを再開してください。',
        secretReferenceOverlayUpdateRequired: 'エージェントとの会話で共有シークレットを使うには、更新されたマシンが必要です。何も開始されていません。',
    },
    status: {
        offline: 'オフライン — この端末に保存済み',
        syncing: '同期中…',
        conflict: '確認が必要',
        unsupported: '未同期 — この Home はこの下書きを同期できません',
        startInterrupted: '開始が中断されました',
    },
    availability: {
        machineUnavailable: 'マシンを利用できません',
        pluginUnavailable: 'プラグインを利用できません',
        attachmentNeedsAttention: '添付ファイルの確認が必要です',
    },
    new: { action: '新しいセッション' },
    delete: {
        action: '下書きを削除',
        confirmTitle: 'この下書きを削除しますか？',
        confirmDescription: '同期されているすべての端末からこの下書きが削除されます。',
    },
    conflict: {
        title: '競合する変更を確認',
        description: '各項目で残す版を選んでください。置き換える前に、この端末の値をコピーできます。',
        mine: 'この端末',
        synced: '同期された版',
        useSynced: '同期された版を使う',
        keepDevice: 'この端末の版を残す',
        copyMine: 'この端末の値をコピー',
        copied: 'コピーしました',
        copyFailed: 'この値をコピーできませんでした。',
        field: {
            text: 'メッセージ',
            mentions: 'メンション',
            attachments: '添付ファイル',
            recipient: '送信先',
            agentContinuation: 'エージェントの継続',
            executionRunRequestedAction: '実行の配信',
        },
    },
};

const sessionDraftTranslations = { ja };

return { sessionDraftTranslations };
})();

const Domain_sessionEmbeddedTranslations = (() => {
const en = Shared_sessionEmbeddedTranslations.en;

const translated = Shared_sessionEmbeddedTranslations.translated;

const sessionEmbeddedTranslations = { ja: translated({
        unavailable: 'このセッションは利用できません',
        respondInSession: '応答するにはセッションを開いてください。',
        regionLabel: ({ title }) => `セッション: ${title}`,
        newChatWelcome: '何に取り組みましょうか？',
    }) } as const;

return { sessionEmbeddedTranslations };
})();

const Domain_sessionFollowTranslations = (() => {
type SessionFollowTranslations = Shared_sessionFollowTranslations.SessionFollowTranslations;

const en = Shared_sessionFollowTranslations.en;

const sessionFollowTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionFollowTranslations
>, "ja"> = { 'ja': {
        "notificationBody": {"message":"このセッションに新しいメッセージがあります。","failed":"ターンが失敗しました。","cancelled":"ターンがキャンセルされました。","sourceUnavailable":"このセッションのソースは利用できません。"},
        "follow": "フォロー",
        "unfollow": "フォローを解除",
        "following": "フォロー中",
        "notifications": "通知",
        "unavailableTitle": "フォローは利用できません",
        "unavailableDescription": "この Home はセッションのフォローに対応していません。",
        "unreachableTitle": "この Home に接続できません",
        "unreachableDescription": "この Home がセッションのフォローに対応しているか確認できませんでした。接続できるようになってから再試行してください。",
        "editor": {
            "title": "このセッションをフォロー",
            "subtitle": "大切な更新を受け取ります。",
            "ownerSubtitle": "このセッションはあなたのものなので、更新は常に届きます。",
            "externalAttachedOnly": "バックグラウンド同期がオフのため、このセッションが接続されている間のみ更新が届く場合があります。",
            "sheetTitle": ({ name }) => `フォロー：${name}`,
            "sheetSubtitle": "どれだけ知らせるか",
            "suppressed": "更新はオフです。このセッションは引き続きあなたのものです。",
            "turnOff": "更新をオフにする",
            "alsoFollow": ({ facts, count }) => `${facts}もフォローしています`,
            "people": "メンバー",
            "quietHours": ({ range }) => `おやすみ時間 ${range} · プッシュはしません。すべて受信トレイに届きます`,
            "quietHoursOn": "おやすみ時間が有効です · プッシュはしません。すべて受信トレイに届きます",
            "notFollowing": "まだフォローしていません。フォローすると、あなたが必要なときに知らせます。"
        },
        "level": {
            "none": "通知なし",
            "important": "重要な更新",
            "all_messages": "新しいメッセージすべて"
        },
        "policyEditor": {
            "presetLabel": "受け取る量",
            "presetDescription": {
                "everything": "何かあるたびに通知します。メッセージは受信箱に静かに届きます。",
                "important": "対応が必要なとき、失敗や停滞のときだけ通知します。それ以外は受信箱で静かに待ちます。",
                "quiet": "通知はしません。更新は受信箱で静かに待ちます。",
                "custom": "通知するもの、静かに届くもの、含めないものを選びます。"
            },
            "customTitle": "イベントごと",
            "group": {
                "interrupt": "通知する",
                "quiet": "静かに届く",
                "off": "含めない"
            },
            "channel": {
                "interrupt": "プッシュ",
                "quiet": "受信箱"
            },
            "delivery": {
                "off": "オフ",
                "quiet": "受信箱",
                "interrupt": "プッシュ"
            },
            "session": {
                "presetLabel": "どこまで受け取るか",
                "presetDescription": {
                    "everything": "何かが起きるたびに起こします。メッセージは次のターンまで待ちます。",
                    "important": "用事があるとき、失敗したとき、止まったときだけ起こします。それ以外は次のターンまで待ちます。",
                    "quiet": "何も起こしません。更新は次のターンまで待ちます。",
                    "custom": "何で起こすか、次のターンまで待つか、対象外にするかを選びます。"
                },
                "group": { "interrupt": "起こす", "quiet": "次のターンまで待つ" },
                "channel": { "interrupt": "起こす", "quiet": "次のターン" },
                "delivery": { "interrupt": "起こす", "quiet": "次のターン" }
            },
            "events": {
                "needsYou": "対応が必要",
                "decision": "判断が必要",
                "approval": "承認が必要",
                "blocked": "ブロック中",
                "finished": "完了",
                "failedOrStopped": "失敗または停止",
                "stalled": "停滞",
                "updatePosted": "更新を投稿",
                "personWrote": "誰かが書き込み",
                "goalChanged": "目標を変更",
                "message": "すべてのメッセージ"
            },
            "eventDescriptions": {
                "needsYou": "判断、承認、またはブロック中",
                "failedOrStopped": "実行が何も言わずに終わったときも",
                "personWrote": "通知とリンクだけ。本文は含めません"
            }
        },
        "policy": {
            "everything": "すべて",
            "important": "重要",
            "quiet": "静かに",
            "custom": "カスタム"
        },
        "voice": {
            "title": "Voiceに含める",
            "subtitle": "Voiceでこのセッションの状況を把握できます。",
            "waitingRuntime": "Voiceの接続を待っています。",
            "unsupported": "このランタイムはフォロー中のセッションをVoiceに含める機能に対応していません。",
            "providerWithheld": "このVoiceモードでは保存されたセッションの更新を含めることはできません。",
            "waitingEncrypted": "このセッションのロックを解除してVoiceに含めてください。",
            "initialSnapshotPending": "次のVoiceのターンで、現在の状況の短い要約を含めます。"
        },
        "once": { "title": "一度だけ通知", "subtitle": "通知レベルに加えて一度だけ届き、その後は終了します。", "off": "オフ", "turn": "このターンが終わったとき", "attention": "次に対応が必要になったとき" },
        "footer": "フォローしても、このセッションにアクセスできる人は変わりません。",
        "settingsLink": "通知設定…",
        "assignedExplanation": "担当に割り当てられたためフォロー中",
        "assignedNotice": "セッションがあなたに割り当てられました。",
        "sharedNotice": "セッションがあなたと共有されました。",
        "wakeEventExplanation": "フォロー中のコンテキストが変わったため、Happier がこのエージェントを更新とともに起動しました。",
        "accessLost": "このセッションへのアクセス権がなくなりました。",
        "offline": "オフラインです。再接続してフォロー設定を変更してください。",
        "archived": "このセッションのアーカイブ中はフォローが一時停止します。",
        "sources": {
            "title": "フォロー中",
            "waitingRuntime": "宛先セッションの再接続を待っています。",
            "unsupported": "更新を受信するには、宛先マシンの CLI を更新するか再接続してください。",
            "pausedArchived": "送信元または宛先がアーカイブされている間、更新は一時停止されます。",
            "add": "別のセッションでフォロー…",
            "addSource": "別のセッションから更新を送信…",
            "chooseDestinationTitle": "別のセッションでフォロー",
            "chooseSourceTitle": "別のセッションから更新を送信",
            "row": ({ title }) => `「${title}」からの更新`,
            "nextTurn": "次のターン",
            "wakeOnHumanChange": "人がメッセージを追加したら起動",
            "stop": "更新を停止",
            "stopForSource": ({ title }) => `「${title}」からの更新を停止`,
            "panelSubtitle": "どれだけ届くか",
            "includeNextTurn": "宛先の次のターンに更新を含めます。",
            "empty": "フォロー中のセッションがここに表示されます",
            "sourceKeyPreparing": "暗号化アクセスを準備しています…",
            "sourceKeyWaiting": "暗号化アクセスを待っています。",
            "sourceKeyUnavailable": "このコンピューターでは暗号化アクセスを提供できません。",
            "sourceSessionKeyUnavailable": "このセッションの暗号化アクセスはここでは利用できません。",
            "catchUpPending": "追いつき処理を待機中",
            "kindDiscussion": "ディスカッション",
            "kindWorkflowRun": "ワークフロー実行",
            "executionRun": ({ title }) => `「${title}」での実行`,
            "sourceUnavailable": "利用できなくなりました",
            "followsThis": ({ title }) => `${title} がこのセッションをフォロー中`,
            "ruleMatching": ({ facts }: { facts: string }) => `一致するセッション:${facts}`,
            "ruleEvery": "見えるすべてのセッション",
            "managerOnly": "このセッションのマネージャーとして通知を受けます。コーディネーター設定で変更できます。",
            "ruleWhich": "対象のセッション",
            "ruleLeftOut": ({ name }: { name: string }) => `プロジェクト ${name} を除外中`,
            "ruleIncludeAgain": "再び含める",
            "ruleIncludedAgain": ({ name }: { name: string }) => `プロジェクト ${name} を再びフォロー`
        },
        "preferences": {
            "title": "自動でフォロー",
            "assigned": "自分に割り当てられたセッション",
            "direct": "直接共有されたセッション",
            "team": "チームを通じて共有されたセッション",
            "group": "グループを通じて共有されたセッション",
            "help": "新しい割り当てと新たにアクセス可能になったセッションに適用されます。既存の設定は変わりません。"
        }
    } };

return { sessionFollowTranslations };
})();

const Domain_sessionGitBranchesTranslations = (() => {
type SessionGitBranchesTranslations = Shared_sessionGitBranchesTranslations.SessionGitBranchesTranslations;

const en = Shared_sessionGitBranchesTranslations.en;

const ja: SessionGitBranchesTranslations = {
    openA11y: ({ branch }) => `ブランチ ${branch}: ブランチの切り替えや退避した変更の確認`,
    searchPlaceholder: 'ブランチを切り替えるか作成',
    category: { current: '現在', branches: 'ブランチ', remote: 'リモートブランチ', keptAside: '退避中', worktrees: 'ワークツリー', start: '新しく始める' },
    tracks: ({ upstream }) => `${upstream} を追跡`,
    onlyHere: 'このマシンのみ',
    changed: ({ count }) => `${count} 件変更`,
    ahead: ({ count }) => `${count} 件をプッシュ待ち`,
    keptAsideWhen: ({ origin, when }) => `${origin} · ${when}`,
    newBranch: ({ branch }) => `${branch} から新しいブランチ…`,
    newBranchDetached: '新しいブランチ…',
    newBranchSubtitle: '検索欄に名前を入力します',
    newWorktree: '新しいワークツリー…',
    newWorktreeSubtitle: '新しいセッションで別のブランチを作業',
    keepAside: '変更を退避',
    keepAsideSubtitle: ({ count }) => `${count} 件の変更を退避してきれいな状態から始める`,
    keepAsideNothing: '退避する変更はありません',
    keepAsideFailed: '変更を退避できませんでした。',
    loadFailed: 'ブランチを読み込めませんでした',
    notice: {
        title: ({ branch }) => `${branch} で変更を退避しています`,
        reason: ({ when }) => `${when} に退避。戻して作業を続けましょう。`,
        reasonUndated: '戻して作業を続けましょう。',
        restore: '変更を戻す',
        lookFirst: '先に確認',
        dismiss: '今はしない',
        restoreFailed: '変更を戻せませんでした。',
    },
};

const sessionGitBranchesTranslations = { ja };

return { sessionGitBranchesTranslations };
})();

const Domain_sessionGitDisplayTranslations = (() => {
const en = Shared_sessionGitDisplayTranslations.en;

const ja: typeof en = {
    settingsLayout: 'Git ペインのレイアウト',
    settingsShowAs: '変更されたファイルの表示形式',
    trigger: '表示オプション',
    paneGroup: 'ペイン',
    changesGroup: '変更',
    layout: 'レイアウト',
    layoutUnified: '一体表示',
    layoutTabs: 'タブ',
    layoutDescription: '変更から履歴まで 1 つのスクロールで表示するか、変更と履歴を 2 つのビューにします。',
    showAs: '表示形式',
    showAsList: 'リスト',
    showAsTree: 'ツリー',
    showAsDescription: '変更されたファイルをリストで、またはフォルダごとにまとめて表示し、フォルダ単位で選べます。',
    density: '密度',
    densityDefault: '標準',
    densityCompact: 'コンパクト',
    note: 'ツリーの行は常にコンパクトです。アカウントに保存されます。',
    selectFolder: ({ folder }) => `${folder} のすべての変更を選択`,
    selectFile: ({ file }) => `${file} を次のコミットに選択`,
};

const sessionGitDisplayTranslations = { ja };

return { sessionGitDisplayTranslations };
})();

const Domain_sessionGitPaneTranslations = (() => {
const en = Shared_sessionGitPaneTranslations.en;

const fidelity = Shared_sessionGitPaneTranslations.fidelity;

const withFidelity = Shared_sessionGitPaneTranslations.withFidelity;

const ja: typeof en = {
    scope: { allChanges: 'すべての変更' },
    subTabs: { changes: '変更', sync: '同期', history: '履歴' },
    header: {
        changed: ({ count }) => `${count} 件の変更`,
        toPush: ({ count }) => `${count} 件をプッシュ待ち`,
        toPull: ({ count }) => `${count} 件をプル待ち`,
        push: ({ count }) => `${count} 件をプッシュ`,
        pull: ({ count }) => `${count} 件をプル`,
        publish: '公開',
        folderOnMachine: ({ folder, machine }) => `${machine} の ${folder}`,
    },
    groups: {
        session: 'このセッションで変更',
        elsewhere: ({ repo }) => `${repo} のその他の変更`,
        elsewhereUnnamed: 'このリポジトリのその他の変更',
        selectGroup: ({ group }) => `「${group}」のファイルをすべて選択`,
    },
    row: { renamedFrom: ({ path }) => `旧 ${path}` },
    commit: {
        toBranch: ({ branch }) => `${branch} にコミット`,
        selection: ({ count }) => `${count} ファイル`,
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
        },
        choices: {
            dirtyTitle: ({ count, formatted }) => (count === 1 ? `未コミットの変更が 1 件あります` : `未コミットの変更が ${formatted} 件あります`),
            dirtyBody: 'プルで変更に影響する可能性があります。プルの間は退避し（直後に戻ります）、または重なりがない場合のみ Git にプルさせてください。',
            keepAsideAndPull: '退避してプル',
            pullIfNoOverlap: '重なりがなければプル',
            divergedPullBody: 'ブランチと origin の両方が進んでいます。自分のコミットを origin の上に載せるか、両方をマージしてください。',
            divergedPushBody: '先に origin のコミットを取り込み（上に載せるかマージ）、もう一度プッシュしてください。あなたのコミットはこのマシンに残ります。',
            rebase: 'origin にリベース',
            merge: 'origin をマージ',
        },
        writesOff: {
            title: 'Happier からのコミットはオフです',
            body: 'すべての変更を読んでレビューできます。ここからコミット、プッシュ、プルするにはバージョン管理操作をオンにしてください。',
            turnOn: 'オンにする',
        },
        header: {
            noChanges: '変更なし',
        },
        action: {
            fetch: 'フェッチ',
            publish: 'ブランチを公開',
            createPr: 'PRを作成',
            openPr: ({ number }) => `#${number}`,
            resolve: ({ count }) => `${count}件を解決`,
            upToDate: '最新',
            pushing: ({ count }) => `${count}件をプッシュ中…`,
            pulling: ({ count }) => `${count}件をプル中…`,
            fetching: 'フェッチ中…',
            publishing: '公開中…',
            creatingPr: '作成中…',
        },
        menu: {
            open: 'その他の同期操作',
            push: 'プッシュ',
            pull: 'プル',
            pushTo: ({ target }) => `${target} へ`,
            pullFrom: ({ target }) => `${target} から`,
            nothingToPush: 'プッシュするものはありません',
            upToDate: '最新',
            fetchHint: 'origin の新しいコミットを確認',
            publishHint: 'このブランチを origin に置く',
            createPr: 'プルリクエストを作成…',
            createPrInto: ({ base }) => `${base} へ`,
            unavailable: 'ここでは使用できません',
            more: 'その他',
        },
        running: {
            branchSwitch: 'ブランチを切り替え中…',
            branchCreate: 'ブランチを作成中…',
            stashCreate: '変更を退避中…',
            discard: '変更を破棄中…',
            revert: 'コミットを取り消し中…',
            generic: '処理中…',
        },
        done: {
            untouched: ({ count, formatted }) => (count === 1 ? `未コミットの変更 1 件はそのままです` : `未コミットの変更 ${formatted} 件はそのままです`),
            commit: 'コミットしました',
            commitFiles: ({ count, formatted }) => (count === 1 ? `1 ファイルをコミットしました` : `${formatted} ファイルをコミットしました`),
            push: 'プッシュしました',
            pushCommits: ({ count, formatted }) => (count === 1 ? `1 件のコミットをプッシュしました` : `${formatted} 件のコミットをプッシュしました`),
            upToDate: ({ target }) => `${target} は最新です`,
            pull: 'プルしました',
            pullCommits: ({ count, formatted }) => (count === 1 ? `1 件のコミットをプルしました` : `${formatted} 件のコミットをプルしました`),
            fetch: ({ target }) => `${target} を確認しました`,
            branchSwitch: 'ブランチを切り替えました',
            branchCreate: 'ブランチを作成しました',
            stashCreate: '変更を退避しました',
            discard: '変更を破棄しました',
            revert: 'コミットを取り消しました',
            pullRequest: 'プルリクエストの準備ができました',
            generic: '完了',
        },
        failed: {
            unknownTitle: '結果を確認できませんでした',
            unknownBody: 'Git の応答前にマシンが応答しなくなりました。もう一度確認して何が起きたかを見てください。',
            origin: 'origin',
            thisMachine: 'このマシン',
            refreshTitle: 'コミットしましたが、一覧を更新できませんでした',
            refreshBody: 'コミットは保存されています。もう一度試すと現在の変更が表示されます。',
            rejectedTitle: ({ target }) => `${target} に手元にないコミットがあります`,
            rejectedBody: 'フェッチして変更を確認してください。あなたのコミットは再度プッシュするまでこのマシンに残ります。',
            authTitle: ({ machine, provider }) => `${provider} が ${machine} からのサインインを受け付けませんでした`,
            authBody: ({ machine }) => `${machine} の Git にはこのリモートの有効な認証情報がありません。そこでサインインしてから再試行してください。`,
            offlineTitle: ({ machine }) => `${machine} はオフラインです`,
            offlineBody: '現在そこでは何も実行できません。作業はそのマシンに安全に残っています。',
            conflictTitle: '競合する変更で停止しました',
            conflictBody: '両側で変更されたファイルがあります。解決してから続行してください。',
            networkTitle: ({ target }) => `${target} に接続できませんでした`,
            networkBody: 'マシンがリモートに接続できませんでした。ネットワークを確認して再試行してください。',
            commitTitle: 'コミットできませんでした',
            pushTitle: 'プッシュできませんでした',
            pullTitle: 'プルできませんでした',
            fetchTitle: '新しいコミットを確認できませんでした',
            pullRequestTitle: 'プルリクエストを作成できませんでした',
            genericTitle: '完了できませんでした',
        },
        recover: {
            open: '開く',
            tryAgain: '再試行',
            fetch: 'フェッチ',
            checkAgain: '再確認',
            showConflicts: '競合を表示',
        },
        timeline: {
            title: 'タイムライン',
            now: '現在',
            loading: '履歴を読み込み中…',
            uncommitted: ({ count, formatted }) => (count === 1 ? `未コミットの変更 1 件` : `未コミットの変更 ${formatted} 件`),
            selected: ({ count, formatted }) => (count === 1 ? `次のコミットに 1 件選択` : `次のコミットに ${formatted} 件選択`),
            nothingSelected: '未選択',
            earlierToday: '今日の早い時間',
            yesterday: '昨日',
            older: 'それ以前',
            justNow: 'たった今',
            toPull: 'プル待ち',
            originFurther: ({ name }) => `${name} はさらに前です`,
            originA11y: ({ name }) => `${name} はここです`,
        },
        clean: {
            titleUpToDate: 'すべてコミット済みでプッシュ済みです',
            titleCommitted: 'すべてコミット済みです',
            bodyUpToDate: ({ branch, upstream }) => `${branch} は ${upstream} と一致しています。このセッションの新しい変更はここに表示されます。`,
            body: 'このセッションの新しい変更はここに表示されます。',
            createPullRequest: 'プルリクエストを作成',
            openPullRequest: ({ number }) => `プルリクエスト #${number} を開く`,
            lastCommit: ({ when }) => `最後のコミット ${when}`,
        },
        conflicts: {
            skip: 'このコミットをスキップ',
            askAgentTask: ({ files, operation }) => `${files} の${operation}の競合を解決してください。両側の意図を保ち、解決したファイルを編集してステージし、私のレビューのために止まってください。続行、中止、コミット、プッシュはせず、片側を丸ごと選ばないでください。`,
            revert: 'リバート',
            cherryPick: 'チェリーピック',
            merge: 'マージ',
            rebase: 'リベース',
            stopped: ({ count, formatted, operation }) => (count === 1 ? `${operation}が停止しました：1 ファイルが両側で変更されています` : `${operation}が停止しました：${formatted} ファイルが両側で変更されています`),
            readyToContinue: ({ operation }) => `すべての競合が解決しました。${operation}を続行してください。`,
            filesInConflict: ({ count, formatted }) => (count === 1 ? `1 ファイルが競合しています` : `${formatted} ファイルが競合しています`),
            body: '「対応が必要」の各ファイルを開くか、エージェントに解決を依頼してください。',
            continueBody: '続行するまで何もコミットされません。',
            askAgent: 'エージェントに解決を依頼',
            continue: ({ operation }) => `${operation}を続行`,
            abort: ({ operation }) => `${operation}を中止`,
            needsYou: '対応が必要',
            mergedCleanly: '問題なくマージ済み',
        },
        commit: {
            selectFirst: 'コミットするファイルを選択',
        },
        tools: {
            title: 'リモートとマージ',
            subtitle: 'リモートの追加、ブランチのマージやリベース',
        },
    },
    paused: { reason: 'セッションは一時停止中です', resume: '再開' },
    notRepository: {
        title: 'エージェントの変更をここで追跡',
        body: ({ folder }) => `${folder} はまだリポジトリではありません。作成すると、すべての変更を確認・コミット・取り消しできます。`,
        bodyUnnamed: 'このフォルダはまだリポジトリではありません。作成すると、すべての変更を確認・コミット・取り消しできます。',
    },
};

const sessionGitPaneTranslations = { ja: withFidelity(ja) };

return { sessionGitPaneTranslations };
})();

const Domain_sessionGitPullRequestTranslations = (() => {
type ProviderArgs = Shared_sessionGitPullRequestTranslations.ProviderArgs;

type GitPullRequestCopy = Shared_sessionGitPullRequestTranslations.GitPullRequestCopy;

const en = Shared_sessionGitPullRequestTranslations.en;

const ja: GitPullRequestCopy = {
    form: {
        title: '新しいプルリクエスト', expand: '詳細ペインで開く', moveBack: 'サイドバーに戻す',
        close: 'フォームを閉じる（下書きは保持されます）', base: 'マージ先', titlePlaceholder: 'タイトル',
        bodyPlaceholder: '何をなぜ変更したか', draft: '下書き', create: 'プルリクエストを作成', creating: '作成中…',
        continueOn: ({ provider }) => `${provider} で続ける`, pointer: '新しいプルリクエストは詳細で開いています', pointerShow: '表示',
        openedProviderPage: ({ provider }) => `${provider} で仕上げられるように開きました。テキストはここに残っています。`,
        writeBody: '説明を作成',
        writingBody: '作成中…',
        bodyReady: '説明案ができました。使うまで、あなたのテキストはそのままです',
        useBody: '説明案を使う',
        keepMine: '自分のを残す',
        bodyUnknown: '説明の作成が開始されていない可能性があります',
        bodyUnknownReason: 'マシンがリクエストを受け取ったことを確認できませんでした。',
        checkAgain: 'もう一度確認',
    },
    failure: {
        authFailed: ({ provider }) => `${provider} がこのマシンからのサインインを受け付けませんでした`,
        network: ({ provider }) => `${provider} に接続できませんでした`,
        machineOffline: 'マシンがオフラインです。下書きは保持されます',
        blocked: '別の Git 操作が実行中です。終わってから再試行してください',
        other: 'プルリクエストは作成されませんでした',
    },
    card: {
        number: ({ number }) => `#${number}`, intoBase: ({ base }) => `${base} へ`,
        state: { open: 'オープン', draft: '下書き', merged: 'マージ済み', closed: 'クローズ', unknown: 'プルリクエスト' },
        checks: { pending: 'チェック実行中', success: 'チェック成功', failure: 'チェック失敗', unknown: 'チェック' },
        openOn: ({ provider }) => `${provider} で開く`, copyLink: 'リンクをコピー', copied: 'リンクをコピーしました',
    },
    settings: {
        placementTitle: '新しいプルリクエストを開く場所', placementDescription: 'スマートフォンでは常に専用ページで開きます。',
        sidebar: 'サイドバー', details: '詳細ペイン',
    },
};

const sessionGitPullRequestTranslations = { ja };

return { sessionGitPullRequestTranslations };
})();

const Domain_sessionHomeFreshnessTranslations = (() => {
const en = Shared_sessionHomeFreshnessTranslations.en;

const translated = Shared_sessionHomeFreshnessTranslations.translated;

const sessionHomeFreshnessTranslations = { ja: translated({
        offline: 'オフライン',
        stale: '更新できませんでした',
        lastUpdated: ({ ago }) => `${ago}前に更新`,
    }) };

return { sessionHomeFreshnessTranslations };
})();

const Domain_sessionListFilterTranslations = (() => {
const en = Shared_sessionListFilterTranslations.en;

const translated = Shared_sessionListFilterTranslations.translated;

const sessionListFilterTranslations = { ja: translated({
        filtersTitle: 'セッションフィルター', filtersSearch: 'フィルターを検索…', filtersShow: '表示',
        filtersScope: '範囲', filtersShowSessions: 'セッション', filtersShowRuns: '実行', filtersShowBoth: '両方',
        filtersShowBothSummary: 'セッションと実行', filtersStartedByNone: '開始者が未選択',
        filtersStartedBy: '開始者', filtersStartedByYou: 'あなた', filtersStartedByTriggers: 'トリガー', filtersStartedByAgents: 'エージェント',
        filtersRunsNeedingYouAlwaysShow: 'あなたの対応が必要な実行は常に表示されます',
        filtersMyWork: '自分の作業', filtersLegacyOwnerDirect: '自分の作業', filtersAssignedToMe: '自分に割り当て済み', filtersFollowing: 'フォロー中',
        filtersInvolvingMe: '自分が関与', filtersAllAccessible: 'アクセス可能なすべて', filtersAttention: '要対応',
        filtersAttentionAny: 'すべて', filtersAttentionNeedsMe: '自分の対応が必要なセッションのみ', filtersScopeNeedsMe: '要対応',
        filtersInactive: '非アクティブなセッション', filtersInactiveShow: '表示', filtersInactiveHide: '非表示',
        filtersHomes: 'Home', filtersSharedWith: '共有先', filtersOutsideTeams: '個人・直接',
        filtersTags: 'タグ', filtersSource: 'ソース', filtersSourceAll: 'すべて',
        filtersSourceDirect: '外部',
        filtersOnlyCoordinators: 'コーディネーターのみ', filtersOnlyCoordinatorsDescription: '他のセッションを管理するか、ルールでフォローするセッション',
        filtersCoordinatorsChip: 'コーディネーター', filtersCoordinatorsChipClear: 'コーディネーターのみの表示を解除',
        filtersNoOptions: '利用できるフィルターはありません', filtersClear: 'フィルターをクリア', filtersDone: '完了', filtersArchived: 'アーカイブ済み',
        filtersNeedsMeOnly: '自分の対応が必要なもののみ', filtersNeedsMeOnlyDescription: 'あなたを待っているセッション', filtersSourceHappier: 'Happier',
        filtersMoreTags: ({ count }: { count: number }) => `他 ${count} 件`,
        filtersStatus: '状態', filtersStatusFailed: '失敗', filtersProject: 'プロジェクト', filtersProjectIs: '一致', filtersProjectIsNot: '除外',
        filtersProjectNot: ({ names }: { names: string }) => `除外するプロジェクト:${names}`,
        filtersResultCount: ({ count }: { count: number }) => `${count} 件`,
        queryInitialLoadingTitle: 'セッションを読み込み中…', queryUpdatingTitle: 'セッションを更新中…',
        querySomeHomesUnavailableTitle: '一部の Home を利用できません', querySomeHomesUnavailableDescription: 'Happier は到達できる範囲を表示しています。Home がオンラインに戻ったら再試行してください。',
        queryRefreshFailedTitle: '更新できませんでした', queryRefreshFailedRetainedDescription: '読み込み済みのセッションはそのまま表示されています。更新を確認するには再試行してください。', queryRefreshFailedEmptyDescription: '選択した Home からセッションを読み込めませんでした。到達可能になったら再試行してください。',
        queryNoMatchesLoadedTitle: '読み込み済みのセッションに一致なし', queryNoMatchesLoadedDescription: '古いページに一致するセッションがある可能性があります。', querySearchOlder: '古いセッションを検索',
        queryMoreAvailableTitle: 'ほかのセッションがある可能性があります', queryMoreAvailableDescription: 'この表示には読み込み済みのセッションが含まれます。古いセッションを検索して続けてください。',
        queryNoMatchesTitle: '一致するセッションはありません', queryNoMatchesDescription: '有効なフィルターを変更してみてください。',
        queryTeamEmptyTitle: 'このチームにはセッションがありません', queryTeamEmptyDescription: 'このチームと共有されたセッションがここに表示されます。',
        queryMyWorkEmptyTitle: '自分の作業には何もありません', queryScopeEmptyDescription: '範囲を広げるか、後でもう一度確認してください。', queryBrowseAllAccessible: 'すべてのセッションを表示',
        queryAssignedEmptyTitle: '自分に割り当てられたセッションはありません', queryFollowingEmptyTitle: 'フォロー中のセッションはありません', queryInvolvingEmptyTitle: '自分が関与するセッションはありません',
        queryAttentionEmptyTitle: '対応が必要なセッションはありません', queryReachableEmptyTitle: '利用できるセッションはありません', queryReachableEmptyDescription: '到達可能な Home にこの表示と一致するセッションはありません。',
        queryHistoricalSharesWithheldTitle: '一部の共有セッションは非表示です', queryHistoricalSharesWithheldDescription: '以前のバージョンの Happier から共有されたセッションは、所有者が Happier で更新するまで非表示のままです。',
        partialHomeNotMountedTitle: ({ home }) => `${home} はこのセッション表示に含まれていません`,
        partialHomeNotMountedDescription: 'この Home を表示中の Home グループに追加すると、フォーカスを変えずにチームのセッションを表示できます。',
        partialShowFromHome: ({ home }) => `${home} のセッションを表示`,
        teamListingUnavailableTitle: 'この Home ではチームセッションの一覧を利用できません',
        teamListingUnavailableDescription: 'この Home はまだチームセッションを一覧表示できません。Home を更新または再設定してから、もう一度お試しください。',
        teamListingLoadingTitle: ({ team }) => `${team} のセッションを読み込み中…`,
        teamListingLoadingDescription: 'この Home が一覧表示できる内容を確認しています。',
        teamListingProbeFailedTitle: 'この Home に接続できません',
        teamListingProbeFailedDescription: 'この Home にチームセッションを問い合わせできませんでした。接続できるようになってから再試行してください。',
    }) };

return { sessionListFilterTranslations };
})();

const Domain_sessionMessageAccountActorTranslations = (() => {
type AccountActorTranslations = Shared_sessionMessageAccountActorTranslations.AccountActorTranslations;

const sessionMessageAccountActorTranslations: Pick<Record<SupportedLanguage, AccountActorTranslations>, "ja"> = { ja: { accountActorYou: 'あなた', accountActorFormerMember: '元メンバー', accountActorUnnamedMember: 'Happierメンバー', accountActorSentBy: ({ name }) => `${name}からのメッセージ` } };

return { sessionMessageAccountActorTranslations };
})();

const Domain_sessionPageTranslations = (() => {
const english = Shared_sessionPageTranslations.english;

const translated = Shared_sessionPageTranslations.translated;

const sessionPageTranslations = { ja: translated({
        sessionPages: {
            info: {
                continueTitle: '続ける',
                continueDescription: 'このセッションの現在の状態から新しい作業を始めます。',
                organizeTitle: '整理',
                organizeDescription: 'このセッションがリストのどこに表示されるか。',
                activityDescription: 'エージェントがいま何をしているか。',
                detailsTitle: '詳細',
                detailsDescription: 'サポートやスクリプト用の識別子と履歴。',
                environmentTitle: '環境',
                environmentDescription: 'このセッションを実行するマシン、フォルダー、エージェント。',
                agentStateDescription: '誰がエージェントを操作しているか、何を待っているか。',
                relatedTitle: '関連',
                relatedDescription: 'このセッションの他のページ。',
                developerTitle: '開発者',
                developerDescription: 'デバッグ用の生データ。開発者モードで表示されます。',
                leaveLabel: '停止、アーカイブ、削除',
                leaveFootnote: '停止すると実行中のプロセスが終了します。アーカイブしたセッションは復元できます。削除するとセッションとそのメッセージは完全に消去されます。',
                setupTitle: "セットアップ",
                setupDescription: "このセッションでのエージェントの動き方。",
                aboutTitle: "概要",
                peopleTitle: "メンバーとアクセス",
                leaveTitle: "終了",
                tags: "タグ",
                addTag: "タグ",
                pinned: "ピン留め",
                follow: "フォロー",
                keepInNeedsYou: "「対応が必要」に残す",
                keepInNeedsYouSubtitle: "解除するまでそこに残ります。",
                fork: "分岐…",
                forkDetail: "ネイティブ、リプレイ、または設定",
                handOff: "引き継ぐ…",
                handOffDetail: "別のマシンまたはエージェント",
                people: "メンバー",
                sharing: "共有",
                folder: "フォルダ",
                agent: "エージェント",
                started: "開始",
                resumeCommand: "再開コマンド",
                connection: "接続",
                cli: "CLI",
                cliOutdatedValue: ({ version }: { version: string }) => `${version} · 更新`,
                controlledBy: "操作者",
                controlledByYou: "あなた",
                usage: "使用量",
                usageDetail: "トークンとコスト",
                copyAllDetails: "すべての詳細をコピー",
                copyAllDetailsNote: "パスと秘密情報は伏せ字",
                showMore: ({ count }: { count: number }) => `さらに${count}件を表示`,
                showFewer: "表示を減らす",
                view: "表示",
                allAutomations: "すべての自動化",
                resume: "再開",
                unarchive: "アーカイブを解除",
                openToResume: "開いて再開",
                cliNoticeTitle: ({ machine }: { machine: string }) => `${machine} の CLI を更新`,
                cliNoticeReason: ({ version, command }: { version: string; command: string }) => `一部のセッション機能には Happier CLI ${version} が必要です。そのマシンで ${command} を実行してください。`,
                addNote: "メモを追加",
            },
            follow: {
                description: 'このセッションから通知を受け取るか、音声で読み上げるかを選びます。',
            },
            permissions: {
                description: '別のデバイスからこのセッションに許可したツール。不要になったものは取り消せます。',
            },
            automations: {
                description: 'スケジュール、イベント、またはターン終了時にこのセッションで実行される作業。',
            },
            newRun: {
                description: 'このセッションからサブエージェントの実行を開始します。',
                transcriptReadOnly: 'これは保存された履歴です。この Home に再接続して会話を続けてください。',
                daemonReadOnly: 'この履歴は Agent プロセスから取得されました。この Home に再接続して会話を続けてください。',
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
>, "ja"> = { ja: {
        due: 'リマインダーの時間です',
        title: 'リマインド', inOneHour: '1時間後', inThreeHours: '3時間後',
        tomorrowMorning: '明日の朝', nextWeek: '来週', custom: '日時を選択…',
        customTitle: '日時を選択',
        customPlaceholder: '2026-09-08 09:00', futureTimeRequired: '未来の日時を選択してください。',
        setReminder: 'リマインダーを設定',
        reminderSaved: 'リマインダーを保存しました',
        presetSaveFailedAfterReminder: 'リマインダーは保存されましたが、プリセットの保存は確認できませんでした。再試行するか、閉じてください。',
        presetsSaveFailed: 'プリセットの保存を確認できませんでした。変更内容はここに保持されています。再試行してください。',
        presetsChanged: '保存済みのプリセットが開いた一覧と異なります。閉じてから再度開き、最新の一覧を確認してください。',
        remove: 'リマインダーを削除',
        dateLabel: '日付', timeLabel: '時刻', addToPresets: 'プリセットに追加', presetPreviewUnavailable: '有効な未来の時刻を選ぶとプレビューできます。', managePresets: 'プリセットを管理', managePresetsMessage: '保存したリマインダーの名前、順序、削除を編集します。', presetName: 'プリセット名', movePresetUp: '上へ移動', movePresetDown: '下へ移動', renamePresetLabel: ({ preset }) => `「${preset}」の名前を変更`, movePresetUpLabel: ({ preset }) => `「${preset}」を上に移動`, movePresetDownLabel: ({ preset }) => `「${preset}」を下に移動`, deletePresetLabel: ({ preset }) => `「${preset}」を削除`, noPresets: '保存済みプリセットはありません', noPresetsMessage: '次にカスタムリマインダーを選ぶ際に保存できます。',
    } };

return { sessionReminderTranslations };
})();

const Domain_sessionRemotePermissionGrantTranslations = (() => {
type SessionRemotePermissionGrantTranslations = Shared_sessionRemotePermissionGrantTranslations.SessionRemotePermissionGrantTranslations;

const sessionRemotePermissionGrantTranslations = { ja: {
        title: 'リモート権限付与',
        entryTitle: 'リモート権限付与',
        entrySubtitle: 'セッション範囲のリモート付与を確認・取り消し',
        loadingTitle: 'リモート権限付与を読み込み中',
        loadingReason: '現在のセッション所有者の付与を確認しています。',
        emptyTitle: 'リモート権限付与はありません',
        emptyReason: 'このセッションには確認するリモート付与がありません。',
        unavailableTitle: 'リモート権限付与を利用できません',
        unavailableReason: '現在のセッション所有者であり、そのマシンが利用可能であることを確認してから、もう一度試してください。',
        ownerOnlyTitle: 'リモート付与を管理できるのはセッション所有者のみです',
        ownerOnlyReason: '共有参加者は対象のプロンプトに応答できますが、セッション所有者の付与を確認または取り消すことはできません。',
        retry: '再試行',
        listTitle: 'セッションの付与',
        grantActive: ({ actor }) => `${actor} からの有効な付与`,
        grantRevoked: ({ actor }) => `${actor} からの取り消された付与`,
        grantDetail: ({ grantId, sourceRef, sourceRevisionOrEpoch }) => `付与 ${grantId} ・ ソース ${sourceRef} (${sourceRevisionOrEpoch})`,
        revoke: '付与を取り消す',
        revoking: '取り消し中…',
        revokeConfirmTitle: 'リモート権限付与を取り消しますか？',
        revokeConfirmBody: ({ identifier }) => `${identifier} のリモート付与を直ちに取り消します。`,
        revokeFailedTitle: 'リモート権限付与を更新できませんでした',
        revokeFailedReason: '付与が変更されたか、所有者のマシンが利用できない可能性があります。もう一度試してください。',
        loadMore: 'さらに付与を読み込む',
        loadingMore: 'さらに付与を読み込み中…',
        loadMoreFailedReason: '追加の付与を読み込めませんでした。もう一度試してください。',
    } } as const satisfies Pick<Readonly<Record<string, SessionRemotePermissionGrantTranslations>>, "ja">;

return { sessionRemotePermissionGrantTranslations };
})();

const Domain_sessionResponsibilityTranslations = (() => {
type SessionResponsibilityTranslations = Shared_sessionResponsibilityTranslations.SessionResponsibilityTranslations;

const en = Shared_sessionResponsibilityTranslations.en;

const sessionResponsibilityTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionResponsibilityTranslations
>, "ja"> = { ja: {
        responsibilitySectionTitle: '担当',
        responsibilityRowTitle: '担当者',
        responsibilityNoOne: 'なし',
        responsibilityUnnamedPerson: '名前未設定のユーザー',
        responsibilityPickerTitle: '担当者を選ぶ',
        responsibilitySearchPlaceholder: 'アクセスできる人を検索',
        responsibilityAssignToMe: '自分を担当にする',
        responsibilityPeopleWithAccess: 'アクセスできる人',
        responsibilityAccessHintOwner: 'オーナー',
        responsibilityNoCandidates: 'このセッションにアクセスできる人はまだ他にいません。',
        responsibilityAccessChanged: 'アクセス権が変わりました。この人は担当者にできません。',
        responsibilityUpdateFailed: '担当者を更新できませんでした。もう一度お試しください。',
        responsibilityApprovalPending: '承認待ちです。まだ変更されていません。承認されると担当者が更新されます。',
        responsibilityA11yEditable: ({ name }: { name: string }) => `担当者、${name}。担当者を変更。`,
        responsibilityA11yReadOnly: ({ name }: { name: string }) => `担当者、${name}。`,
        responsibilityA11yEmpty: '担当者、なし。担当者を変更。',
        responsibilityAssignedToYou: 'あなたの担当',
        responsibilitySharedWithYou: 'あなたに共有されました',
    } };

return { sessionResponsibilityTranslations };
})();

const Domain_sessionWorkTranslations = (() => {
const en = Shared_sessionWorkTranslations.en;

const ja: typeof en = {
    scheduled: {
        title: "予定",
        writesHere: "ここに書き込み",
        empty: "ここに書き込むワークフローの予定はありません。",
        step: ({ ordinal, title }) => `ステップ ${ordinal} · ${title}`,
        provenanceWorkflowStep: ({ source, step }) => `送信元 ${source} · ステップ ${step}`,
        notifyOnlyReported: "エージェントが何かを報告した場合のみ",
        notifyOnlyReportedDescription: "エージェントがテキストを返さない場合は通知をスキップします。",
        notifyOnlyReportedNeedsResult: "前のエージェントステップのテキスト結果をメッセージに使ってください。",
    },
    workerUpdate: {
        state: {
            settled: "ターンを終了",
            needsYou: "対応が必要",
            neededYou: "対応が必要だった",
            stalled: "停滞中",
            published: "公開済み",
            failed: "失敗",
            stopped: "停止",
            timedOut: "タイムアウト",
            finished: "完了",
        },
        peek: "プレビュー",
        mute: 'ミュート',
        muted: 'ここではミュート中',
        unmute: '元に戻す',
        muteFailed: 'ミュートできませんでした',
        truncated: "結果を短縮しました。",
        wokenBy: ({ count }) => (count === 1 ? '更新により再開' : `${count} 件の更新により再開`),
        updateCount: ({ count }) => (count === 1 ? '1 件の更新' : `${count} 件の更新`),
        notFromYou: 'あなたからのメッセージではありません',
    },
    workerFollow: {
        manager: 'あなたのワーカー',
        follower: 'フォロー中',
        rule: 'あなたのルール',
        queued: '待機中',
        nextTurn: '次のターン',
        woke: '起こしました',
        answered: '回答済み',
        held: 'あなたの確認待ち',
        offline: 'マシンがオフライン',
        archived: 'アーカイブ済み',
        locked: 'マシンがロック中',
        muted: 'ミュート中',
        unavailable: '配信できませんでした',
        checkIn: 'チェックイン待ち',
        exchangeStopped: 'やり取りを停止',
    },
    title: '作業',
    subtitle: {
        sessions: ({ count }) => `${count} 件のセッション`,
        runs: ({ count }) => `${count} 件の実行`,
        nothingStarted: 'まだ何も開始していません',
        archived: ({ count }) => `アーカイブ済み ${count} 件`,
    },
    states: {
        recent: '最近',
        archived: 'アーカイブ済み',
        stopped: '停止中',
    },
    view: {
        a11y: '作業の表示',
        list: 'リスト',
        map: 'マップ',
        expandMap: 'セッションの横にマップを開く',
    },
    map: {
        folded: ({ names }) => `完了した作業はリストに残ります: ${names}`,
        backgroundRuns: ({ count }) => (count === 1 ? "バックグラウンド実行 1 件" : `${count} 件のバックグラウンド実行`),
        positionUnder: ({ position, total, parent }) => `${parent} の下 ${position} / ${total}`,
        waitingOn: ({ count }) => `${count} 件を待機中`,
    },
    actions: {
        showInTranscript: '会話記録に表示',
        unarchive: 'アーカイブ解除',
    },
    putUnder: {
        title: "配下に移動…",
        subtitle: "別のセッションに報告する",
        search: "セッションを検索",
        topLevel: "最上位 — 報告先なし",
        errors: {
            cycle: "そのセッションはすでにこのセッションに報告しています",
            changed: "このセッションは移動されたばかりです。もう一度お試しください",
            forbidden: "そのセッションの配下には移動できません",
            failed: "セッションを移動できませんでした",
        },
    },
    kinds: {
        session: 'セッション',
        workflowRun: 'ワークフロー実行',
        backgroundRun: 'バックグラウンド実行',
    },
    showMore: ({ count }) => `さらに ${count} 件を表示`,
    role: {
        none: 'なし',
        handsOff: '委任のみ',
        a11y: ({ role }) => `ロール: ${role}。ロールを変更`,
    },
    empty: {
        title: 'まだ作業はありません',
        reason: 'このセッションが開始したセッション、ワークフロー、バックグラウンド実行が、あなたの対応が必要なものと一緒にここに表示されます。',
    },
    row: {
        a11y: ({ title, status }) => `${title}、${status}`,
    },
    progress: ({ completed, total }) => `${completed} / ${total}`,
    strip: {
        openInSidebar: 'サイドバーで開く',
        stillWorking: ({ count }) => `${count} 件が作業中`,
        needsYou: ({ count }) => `${count} 件が対応待ち`,
        a11y: ({ summary }) => `作業: ${summary}`,
    },
    leadArchived: ({ count }) => `このセッションはアーカイブ済み · ${count} 件が作業中`,
    managedBy: '管理元',
    plan: '計画',
    runsStale: 'ワークフローの実行が最新でない可能性があります',
    list: {
        level: ({ level }) => `レベル ${level}`,
        subSessions: ({ count }) => `${count} 件のサブセッション`,
        transcriptSessions: ({ count }) => `セッション · ${count}`,
        showReports: ({ name, count }) => (count > 0 ? `${name} の下の ${count} 件のセッションを表示` : `${name} の下のセッションを表示`),
        hideReports: ({ name }) => `${name} の下のセッションを隠す`,
        reportsWorking: ({ count }) => `${count} 件作業中`,
        reportsNeedYou: ({ count }) => `${count} 件のサブセッションが対応待ち`,
    },
    archive: {
        alsoArchiveReports: ({ count }) => `${count} 件のサブセッションもアーカイブ`,
        someNotArchivedTitle: ({ count }) => `${count} 件のサブセッションをアーカイブできませんでした`,
    },
    step: {
        drivenBy: "ワークフローで実行中",
        partOf: ({ run }) => `${run} の一部`,
        checkedByWorkflow: "このステップの結果はワークフローが確認するため、このセッションではトリガー、目標、セカンドオピニオンは実行されません。",
        nothingStarted: "このステップから開始されたものはありません。",
    },
    invite: {
        orAskFor: "または依頼:",
    },
    peek: {
        manager: ({ lead }) => `${lead} に報告`,
        repliesGoHere: '返信はこのセッションに送られます',
    },
};

const notify = { ja: { attention: '対応が必要になったら通知', armed: '通知が届きます', cancel: '通知をキャンセル', failed: '通知を更新できませんでした。もう一度お試しください。', turnFinished: 'このセッションのターンが終了しました。', needsYou: 'このセッションで対応が必要です。', settings: '通知設定' } };

const runNotify = { ja: { run: '終了したら通知', runFinished: 'この実行が終了しました。', runNeedsYou: 'この実行で対応が必要です。', setup: '通知を設定', walkthroughUpdate: "ウォークスルーに更新があります。", commitPlanUpdate: "コミット案に更新があります。" } };

const sessionWorkTranslations = { ja: { ...ja, notify: { ...notify.ja, ...runNotify.ja } } };

return { notify, runNotify, sessionWorkTranslations };
})();

const Domain_settingsConnectionsTranslations = (() => {
type MachineParams = Shared_settingsConnectionsTranslations.MachineParams;

const en = Shared_settingsConnectionsTranslations.en;

const ja = {
    sectionTitle: '接続',
    sectionDescription: 'デバイスからマシンへの接続方法です。',
    directTitle: '可能なときは直接接続',
    directOnDescription: 'デバイス同士が到達できるときは、プレビュー、ライブ表示、ファイル転送を直接やり取りし、できないときは Happier を経由します。',
    directOffDescription: 'すべて Happier を経由します。マシンへ直接接続することはありません。同じネットワークでは少し遅くなります。',
    serverDenied: 'この Home のサーバーはすべて Happier を経由させるため、ここで選べることはありません。',
    machineTitle: ({ machine }: MachineParams) => `${machine} への接続`,
    machineSettingTitle: 'このマシンの接続',
    machineOptionDefault: 'デフォルト',
    machineOptionDirect: '直接',
    machineOptionRelay: 'Happier 経由',
    machineDefaultDescription: ({ machine }: MachineParams) => `アカウントの設定に従います。${machine} に到達できるときは直接、それ以外は Happier 経由です。`,
    machineDefaultOffDescription: 'アカウントの設定に従います。常に Happier 経由です。',
    machineDirectDescription: ({ machine }: MachineParams) => `アカウントの設定にかかわらず、${machine} に到達できるときは直接接続します。`,
    machineRelayDescription: '同じネットワーク上でも、常に Happier を経由します。',
};

const settingsConnectionsTranslations = { ja };

return { settingsConnectionsTranslations };
})();

const Domain_settingsMachinesTranslations = (() => {
const en = Shared_settingsMachinesTranslations.en;

const ja: typeof en = {
    scopeSetUpComputer: 'マシンを設定',
    scopeOffline: ({ machine }: { machine: string }) => `${machine} はオフラインです。`,
    defaultsTitle: "マシンの既定値",
    localVirtualMachines: "ローカル仮想マシン",
    runningOnly: "稼働中のみ課金されるクラウド",
    stoppedBilled: "停止中も課金されるクラウド",
    billingUnknown: "課金方式が不明",
    pageDescription: 'セッションを実行するマシンと、その中から選ぶプール。',
    thisComputerTitle: 'このコンピューター',
    thisComputerRowSubtitle: 'バックグラウンドサービスとコマンドライン',
    thisComputerPageDescription: 'このデバイス上の Happier バックグラウンドサービスとコマンドライン。',
    setupSectionTitle: 'セットアップ',
    setupRowSubtitle: 'ここに Happier をインストールして Home に接続します。',
    addPageDescription: 'マシンを接続すると、エージェントがそこでセッションを実行できます。',
    addFromComputerTitle: 'コンピューターからマシンを追加',
    addFromComputerDescription: '追加したいコンピューターで Happier を開くか、デスクトップ版またはブラウザの Happier から SSH で接続してください。',
    searchPlaceholder: 'マシンを検索',
    count: ({ count }: { count: number }) => `${count} 台のマシン`,
    daemonTitle: 'バックグラウンドサービス',
    daemonDescription: 'このコンピューターでセッションを実行し、Home との接続を保ちます。',
    unreadableTitle: ({ home }: { home: string }) => `${home} のマシンを読み込めませんでした`,
    indexViewTitle: 'すべてのマシンの表示',
    indexViewDescription: 'すべてのマシンをリスト、またはマシンごとのカードで表示します。このデバイスに保存されます。',
};

const settingsMachinesTranslations = { ja };

return { settingsMachinesTranslations };
})();

const Domain_settingsOverviewTranslations = (() => {
type SettingsOverviewTranslation = Shared_settingsOverviewTranslations.SettingsOverviewTranslation;

const slavicPlural = Shared_settingsOverviewTranslations.slavicPlural;

const settingsOverviewTranslations = { ja: {
        attentionTitle: '対応が必要',
        agentNeedsSignIn: ({ agent, machine }) => `${machine} の ${agent} にサインインが必要です`,
        agentNeedsSignInNoMachine: ({ agent }) => `${agent} にサインインが必要です`,
        serviceSignInExpired: ({ service }) => `${service} のサインインが期限切れです`,
        signIn: 'サインイン',
        signInAgain: '再サインイン',
        setupTitle: 'セットアップ',
        setupProgress: ({ done, total }) => `${done}/${total}`,
        setupActionSaveKey: 'キーを保存',
        setupActionAddMachine: 'マシンを追加',
        setupActionShowQr: 'QR を表示',
        setupActionScan: 'スキャン',
        setupActionPasteLink: 'リンクを貼り付け',
        setupActionBrowse: '参照',
        machineUpdateVersions: ({ current, latest }) => `このマシンは Happier ${current} · ${latest} が利用可能`,
        connectTerminalTitle: 'ターミナルを接続',
        connectTerminalSubtitle: 'ターミナルに表示されたコードをスキャンするか、リンクを貼り付けます。',
        quickSettingsTitle: 'クイック設定',
        notificationsPushOn: 'プッシュ オン',
        notificationsPushOff: 'プッシュ オフ',
        notificationsQuietHours: 'おやすみ時間 オン',
        pluginChangesAwaitingReview: ({ count }) => `${count} 件のプラグイン変更が確認待ちです`,
        review: '確認',
        browsePluginsTitle: 'プラグインを探す',
        browsePluginsSubtitle: 'Happier にツール、パネル、連携を追加します。',
        accountServiceSignedIn: ({ service }) => `${service} にサインイン済み`,
        aboutDescription: 'バージョン、ソースコード、法的条件（Happier は Anthropic とは提携していません）。',
        machineOnline: 'オンライン',
        machineOffline: ({ lastSeen }) => `オフライン · 最終確認 ${lastSeen}`,
        machineUnreachableFromHome: ({ lastSeen }) => `この Home から接続できません · 確認 ${lastSeen}`,
        machineUpdateAvailable: 'アップデートあり',
        machinesOnlineCount: ({ count }) => `${count} 台オンライン`,
        machinesOfflineCount: ({ count }) => `${count} 台オフライン`,
        machineLastSeen: ({ lastSeen }) => `最終接続 ${lastSeen}`,
        update: 'アップデート',
        asOf: ({ time }) => `${time} 時点`,
        usageTitle: '使用量',
        usageLeft: ({ percent }) => `残り ${percent}%`,
        usageResets: ({ time }) => `${time} にリセット`,
        securityTitle: 'セキュリティ',
        startSessionLabel: 'セッションを開始',
        saveRecoveryKeyTitle: 'リカバリーキーを保存',
        saveRecoveryKeySubtitle: 'すべてのデバイスを失ったときに暗号化データへ戻る唯一の方法です。',
        addMachineTitle: 'マシンを追加',
        addMachineSubtitle: 'エージェントを実行するマシンを接続します。',
        homeGreetingNamed: ({ name }) => `おかえりなさい、${name}さん。`,
        homeStartSection: 'セッションを開始',
        homeCustomize: 'ホームをカスタマイズ',
        homeCustomizeDescription: 'ホームに表示するセクションとその順序を選びます。',
        homeAlwaysShown: '常に表示',
        homeShowSection: '表示',
        homeHideSection: 'セクションを非表示',
        homeSectionOptions: 'セクションのオプション',
        homeResetLayout: 'デフォルトに戻す',
        homeLayoutSectionTitle: 'ホーム',
        homeAddWidgetsTitle: 'ウィジェットを追加',
        homeAddWidgetsDescription: 'プラグインが提供するウィジェットです。追加するとホームに表示されます。',
        homeWidgetFromPlugin: ({ plugin }) => `${plugin} から`,
        homeRemoveWidget: 'ホームから削除',
    } } satisfies Pick<Readonly<Record<string, SettingsOverviewTranslation>>, "ja">;

return { settingsOverviewTranslations };
})();

const Domain_settingsProfilesRemoteHostsPageTranslations = (() => {
const english = Shared_settingsProfilesRemoteHostsPageTranslations.english;

const translated = Shared_settingsProfilesRemoteHostsPageTranslations.translated;

const settingsProfilesRemoteHostsPageTranslations = { ja: translated({
        settingsProfilesPage: {
            pageDescription: '新しいセッションの開始設定です：エージェント、モデル、環境変数、実行場所。',
            useProfilesSection: 'プロファイルの選択',
            useProfilesSectionDescription: 'セッション開始時にプロファイルを選ぶか、すべてのセッションをマシンの環境で開始します。',
            useProfiles: 'プロファイルを使用',
            useProfilesOffDescription: 'オフ。新しいセッションはマシンの環境を使います。',
            favoritesDescription: 'プロファイルを選ぶときに最初に表示されます。',
            customDescription: '作成したプロファイルです。組み込みプロファイルを編集すると、ここに自分用のコピーが保存されます。',
            builtInDescription: '各エージェント用の既製プロファイルです。',
        },
        settingsRemoteHostsPage: {
            pageDescription: 'このコンピューターがマシンとして設定したり、接続したり、リレーを実行したりできる SSH ホストです。',
            savedHostsSection: '保存済みホスト',
            savedHostsDescription: "最近使ったものから順に表示します。ホストを開いて使ったり変更したりできます。",
            hostPageDescription: "このコンピューターがマシンとしてセットアップしたり、接続したり、リレーを実行したりできる SSH ホストです。",
            newHostTitle: "新しいリモートホスト",
            newHostDescription: "ホストに名前を付け、SSH での接続方法を指定します。",
            useSection: "このホストを使う",
            useSectionDescription: "このデバイスでできること。",
            maintenanceSection: "このホスト上の Happier",
            maintenanceSectionDescription: "Happier のコマンドライン、バックグラウンドサービス、リレーをそこでインストール・更新・実行します。",
            discard: "破棄",
            accessTitle: "キーと接続",
            accessRowSubtitle: "信頼済みホストキーと開いているトンネル",
            accessPageDescription: "このデバイスが信頼するホストキーと、ホストへ開いているトンネルやアクセス経路。",
            hostNotFound: "このホストはもう保存されていません。",
            unavailableDescription: '保存済みの SSH ホストは、マシンとして設定したりリレーとして使ったりできます。',
            trustedHostKeysDescription: '接続時にこのデバイスが受け入れたキーです。削除すると次回また確認されます。',
            trustedHostKeysEmpty: '信頼済みのホストキーはまだありません。接続時にキーを受け入れると、ここに表示されます。',
            sshTunnelsDescription: 'このデバイスから保存済みホストへ開いているトンネルです。',
        },
    }) };

return { settingsProfilesRemoteHostsPageTranslations };
})();

const Domain_settingsProvidersTranslations = (() => {


const withProviderSharedFields = Shared_settingsProvidersTranslations.withProviderSharedFields;

const ja = {
    title: 'プロバイダー', entrySubtitle: 'クラウドとローカルのモデル提供元を接続', configuredTitle: '接続済みプロバイダー', configuredFooter: '有効なプロバイダーのモデルは、対応するエージェントのモデル選択画面に表示されます。', availableTitle: '利用可能', availableFooter: '一度プロバイダーを追加すると、対応するすべてのエージェントでモデルを利用できます。', customTitle: 'カスタムプロバイダー', customFooter: '社内ゲートウェイなど、互換性のあるモデルエンドポイントを接続します。', addCustom: 'カスタムプロバイダーを追加', addCustomDescription: 'OpenAI または Anthropic 互換のエンドポイントを使用', emptyTitle: 'プロバイダーはまだ接続されていません', emptyDescription: '利用可能なプロバイダーを選ぶか、独自のエンドポイントを追加してください。', unavailable: 'プロバイダーを利用できません', unavailableDescription: 'このサーバーではプロバイダー接続が有効になっていません。', noMachine: '利用可能なマシンがありません', noMachineDescription: 'プロバイダーを設定してテストするには、マシンを接続してください。', problemTitle: 'プロバイダーの確認が必要です', searchPlaceholder: 'プロバイダーを検索',
    status: { available: '接続済み', notChecked: '未確認', needsAttention: '確認が必要', unreachable: '到達不能', disabled: 'オフ', sourceUnavailable: 'プラグインを利用できません' }, kind: { frontier: 'モデルプロバイダー', aggregator: 'モデルカタログ', cloud: 'クラウドプロバイダー', local: 'このマシンで実行' },
    detail: { pickSecretTitle: 'API キーを選択', notFoundTitle: 'プロバイダーが見つかりません', notFoundDescription: 'このプロバイダー接続は存在しません。', deletedDescription: 'このプロバイダーは削除されました。使用していたセッションを再開する前に、別のモデルを選んでください。', sourceAvailable: 'プロバイダープラグインは利用可能です', connectionTitle: '接続', connectionFooter: 'このプロバイダーを使用できる場所と現在の状態を管理します。', accountAccess: 'すべてのマシンで使用', accountAccessDescription: 'このプロバイダーが公開エンドポイントとして解決される場所で利用できます', testConnection: '接続をテスト', testDescription: 'エンドポイントを確認してモデルカタログを更新します', testSucceeded: '接続しました', testNotSupported: 'このプロバイダーは自動接続テストに対応していません', machinesTitle: 'マシン', machinesFooter: 'ローカルおよびプライベートのエンドポイントは、マシンごとに有効にする必要があります。', currentMachine: '現在のマシン', selectMachineToManage: 'このマシンを選択してアクセスを確認・変更', targetMachine: '対象マシン', machineOnline: 'オンライン', machineOffline: 'オフライン', apiKeyTitle: 'API キー', apiKeyFooter: 'キーは「保存済みシークレット」に保管され、ここには表示されません。', accountApiKey: '既定の API キー', machineApiKey: 'このマシンの API キー', apiKeyConfigured: '設定済み', apiKeyMissing: '接続するにはキーを追加', apiKeySelected: '保存済みキーを選択済み', useAccountApiKey: 'マシン用キーがない場合は既定のキーを使用', modelsTitle: 'モデル', manageModels: 'モデルを管理', modelsUnknown: '接続するとモデルが表示されます', modelCount: ({ count }: { count: number }) => `${count} モデル`, actionsTitle: '操作', duplicateTitle: '別の接続を追加', duplicateDescription: '同じプロバイダーへの接続を別名で作成', deleteTitle: 'プロバイダーを削除', deleteDescription: '既存のセッション履歴は残りますが、このプロバイダーでは再開できません。', advancedTitle: '詳細設定', endpointDefault: '既定のエンドポイント', endpointMachine: 'このマシンのエンドポイント', endpointMachineDescription: 'このマシンでプロバイダーを実行するときだけ既定値を上書き', endpointPrompt: 'プロバイダーの完全なベース URL を入力してください。', resetEndpoint: 'エンドポイントをリセット', resetMachineEndpoint: 'このマシンで既定のエンドポイントを使用', resetDefaultEndpoint: 'プロバイダープラグインのエンドポイントを使用' },
    authoring: { providerTitle: 'プロバイダー', builtInDescription: '「保存済みシークレット」を選び、このプロバイダーを接続します。', compatibilityTitle: '互換性', compatibilityFooter: 'プロバイダーの文書に記載された API 形式を選んでください。', protocolTitle: 'API 互換性', protocol: { 'openai-responses': { title: 'OpenAI Responses 互換', description: 'Responses API を実装するゲートウェイ向け' }, 'openai-chat': { title: 'OpenAI Chat 互換', description: 'Chat Completions を実装するゲートウェイ向け' }, anthropic: { title: 'Anthropic 互換', description: 'Messages API を実装するゲートウェイ向け' } }, detailsTitle: 'プロバイダーの詳細', name: '名前', namePlaceholder: '社内ゲートウェイ', baseUrl: 'ベース URL', baseUrlPlaceholder: 'https://gateway.example.com/v1', modelsPath: 'モデルのパス', credentialsTitle: '認証情報', credentialsFooter: '下にキーを貼り付けると「保存済みシークレット」として保管されます。API キーを URL やヘッダーに貼り付けないでください。', requiresApiKey: 'API キーが必要', requiresApiKeyYes: 'リクエストに「保存済みシークレット」を使用', requiresApiKeyNo: '認証情報なしで接続', apiKey: 'API キー', apiKeyDescription: '「保存済みシークレット」を選択または作成', credentialStyleTitle: 'API キーの形式', credentialHeader: 'ヘッダー名', credentialStyle: { bearer: 'Authorization Bearer トークン', xApiKey: 'x-api-key ヘッダー', apiKey: 'api-key ヘッダー', customHeader: 'カスタムヘッダー' }, catalogTitle: 'モデルカタログ', catalogFooter: 'エンドポイントが対応していればモデルを自動取得し、後から手動で追加することもできます。', fetchModels: 'モデルを自動取得', fetchModelsYes: 'プロバイダーのモデル一覧エンドポイントを使用', fetchModelsNo: 'モデル ID を手動で追加', verifyTitle: '接続', verifyFooter: '可能なら先にテストしてからプロバイダーを保存してください。', save: 'プロバイダーを保存', connect: 'プロバイダーを接続' },
    errors: { machineOfflineTitle: "このマシンはオフラインです", machineOfflineDescription: "プロバイダーはマシン上で確認されます。別のマシンを選ぶか、このマシンを起動して、もう一度お試しください。", machineTimeoutTitle: "このマシンから応答がありませんでした", machineTimeoutDescription: "プロバイダーの確認中に、このマシンから応答がありませんでした。もう一度お試しください。", runCredentialRequiredTitle: "この Run の認証情報を選択", runCredentialRequiredDescription: "この Run はセッションの直接認証情報を引き継げません。Run 用の Team 認証情報を選択してください。", secretMissingTitle: 'API キーが必要です', secretMissingDescription: 'このプロバイダーを有効にする前に「保存済みシークレット」を選んでください。', notEnabledOnMachineTitle: 'このマシンでは有効になっていません', notEnabledOnMachineDescription: 'セッションを実行するマシンでこのプロバイダーを有効にしてください。', disabledTitle: 'プロバイダーはオフです', disabledDescription: 'モデルを使用する前にプロバイダーを有効にしてください。', unreachableTitle: 'プロバイダーに到達できません', unreachableDescription: 'サービスが実行中で、エンドポイントが正しいことを確認してから再試行してください。', notFoundTitle: 'プロバイダーが見つかりません', notFoundDescription: 'このプロバイダーは削除されました。別のプロバイダーまたはモデルを選んでください。', sourceUnavailableTitle: 'プロバイダープラグインを利用できません', sourceUnavailableDescription: 'この接続を提供するプラグインを再度有効にするか、再インストールしてください。', featureDisabledTitle: 'プロバイダーを利用できません', featureDisabledDescription: 'このサーバーではプロバイダー接続が有効になっていません。', unauthorizedTitle: 'API キーが拒否されました', unauthorizedDescription: '「保存済みシークレット」を有効なキーに置き換え、もう一度接続をテストしてください。', rateLimitedTitle: 'プロバイダーの利用制限に達しました', rateLimitedDescription: '少し待ってから、もう一度接続をテストしてください。', probeCapacityTitle: 'プロバイダーのチェックが同時に多すぎます', probeCapacityDescription: 'Happier は選択したマシンでこのチェックをまだ開始できませんでした。少し待ってから、もう一度お試しください。', genericTitle: 'プロバイダーの確認が必要です', genericDescription: 'プロバイダー設定を確認して再試行してください。' },
    models: { builtIn: '組み込み', experimental: '試験運用', experimentalConfirmTitle: '試験運用中のモデルを使用しますか？', experimentalConfirmBody: ({ provider, model }: { provider: string; model: string }) => `${provider} の ${model} は、このエージェントとの組み合わせがまだ十分に検証されていません。期待どおりに動作しない場合は、再起動するか別のモデルを選んでください。`, experimentalConfirmAction: 'モデルを使用', stale: '利用できない可能性があります', hidden: '非表示', manage: 'モデルを管理', empty: 'このプロバイダーで利用できるモデルはまだありません。', add: 'モデルを追加', addPlaceholder: '1 行に 1 つのモデル ID を入力', resetVisibility: '表示設定をリセット', showHidden: '非表示のモデルを表示', hideHidden: '非表示のモデルを隠す', remove: 'モデルを削除', removeConfirmation: '手動で追加したこのモデルを削除しますか？', enable: 'モデルを表示', disable: 'モデルを非表示', load: 'モデルを読み込む', retry: '再試行', connectionUnavailable: '選択したマシンではこのプロバイダーを利用できません。' },
};

const localTranslations = { ja: { title: 'このマシン上', footer: 'このマシンで見つかったサービスです。モデルがどこで実行されるかはサービスによって異なります。', detected: '検出済み', possible: 'サービスの可能性', detectedAtPort: ({ port }: { port: string }) => `ポート ${port}`, possibleAtPort: ({ provider, port }: { provider: string; port: string }) => `${provider} サービスの可能性 · ポート ${port}`, addConnectionTitle: '別のローカル接続を追加', addConnectionDescription: '他のローカルエンドポイントと区別できる名前を付けてください。', defaultConnectionName: ({ provider }: { provider: string }) => `${provider} ローカル` } } as const;

const providerManagedDeploymentTranslations = { ja: {
        configureManaged: '管理対象のローカルサービスでセッションを実行',
        configureManagedDescription: '今後のセッションで使う接続済みアカウントまたはグループを選びます。必要時に Happier がサービスを起動します。',
        subscriptionPolicyTitle: 'サブスクリプション経由のルーティングは試験運用中です',
        subscriptionPolicyDescription: '上流のポリシーや適用方法が変わり、動作しなくなる場合があります。Happier は拒否をそのまま表示し、別の認証情報へ無断で切り替えません。',
        accountScopeMismatchTitle: '接続済みアカウントはアクティブなサーバーにあります',
        accountScopeMismatchDescription: 'このプロバイダーは別のサーバーのマシンで管理されています。接続済みアカウントまたはグループを選ぶには、そのサーバーに切り替えてください。',
        editManagedDefaults: '管理対象セッションの既定値を編集',
        editManagedDefaultsDescription: '今後のセッションで使うアカウントまたはグループを変更します。既存のセッションは選択を保持します。',
        purposeTargetTitle: '接続済みアカウントの対象',
        purposeTargetDescription: 'この用途に使用できる接続済みアカウントまたはグループを選択してください。',
        invalidPurposeTargetTitle: 'アカウントの対象が無効です',
        invalidPurposeTargetDescription: '保存する前に、使用できる接続済みアカウントまたはグループを選択してください。',
        useExternal: '外部サービスを使用',
        useExternalDescription: '今後のセッションでこのプロバイダーを管理せず、外部エンドポイント設定を使用します。',
        useExternalConfirmTitle: '外部サービスを使用しますか？',
        useExternalConfirmDescription: '管理対象のアカウント既定値は削除されます。既存のセッションは選択を保持します。',
    } } as const;

const copyNameTranslations = { ja: ({ name }: { name: string }) => `${name} のコピー` } as const;

const providerSharedFieldTranslations = { ja: {
        local: { installedNotRunning: 'インストール済みですが、実行されていません', appRunningServerOff: 'アプリは開いていますが、ローカルサーバーはオフです', startManaged: ({ provider }: { provider: string }) => `${provider} を起動`, startedByHappier: 'Happier が起動', runningOutsideHappier: 'Happier の外部で実行中' },
        apiKeyOptionalDescription: '任意 — このプロバイダーで必要な場合は保存済みシークレットを選択してください',
        models: { addDescription: 'プロバイダーが自動表示しないモデル ID を追加します', addHelp: '1 行に 1 つ、正確なモデル ID を入力してください。既存のモデルはスキップされます。', addFieldLabel: 'モデル ID', invalidModelIds: ({ ids }: { ids: string }) => `次のモデル ID は無効です：${ids}`, noNewModels: '追加できる新しいモデル ID はありません。', providerManagedTitle: 'モデルはこのプロバイダーによって管理されています', providerManagedDescription: 'プロバイダーカタログを更新して一覧を最新にしてください。モデル ID の手動追加には対応していません。', showAll: 'すべてのモデルを表示', hideAll: 'すべてのモデルを非表示', hideAllConfirmation: 'この一覧のすべてのモデルを非表示にしますか？いつでも再表示できます。', showOnly: 'このモデルのみ表示', showOnlyConfirmation: 'この一覧の他のすべてのモデルを非表示にしますか？いつでも元に戻せます。' },
    } } as const;

const providerFirstSessionValidationTranslations = { ja: 'Happier は、このプロバイダーを使用する最初のセッションの開始時に接続を安全に検証します。' } as const;

const providerMigrationTranslations = { ja: { reviewTitle: 'プロバイダー移行を確認', reviewFooter: '変更前にエンドポイント、API 形式、認証情報、モデルを確認してください。', legacyProfileDescription: '確認するまで、このプロファイルは従来のルーティングで動作します。', credentialTitle: '認証情報', credentialFooter: '保存済みシークレットの参照だけを移動します。値は表示もコピーもされません。', noCredential: 'API キーなし', credentialMoveDescription: 'この認証情報を新しい接続へ移動', noCredentialDescription: '認証情報なしで接続を作成', actionsTitle: '移行', preview: '変更を確認', previewDescription: '設定を変更せずに内容を検証', confirm: 'プロバイダー接続を作成', confirmDescription: '変更を一括適用し、起動設定を保持', reviewAction: 'プロバイダー移行を確認', reviewActionDescription: '従来のエンドポイントとモデルを接続へ移動', retainedTitle: '従来設定を保持', retainedDescription: '動作を失わずに移行できるまで、この設定は利用できます。' } } as const;

const providerMigrationPreviewTranslations = { ja: { willMoveTitle: 'プロバイダーへ移動する項目', willMoveFooter: '移動するのは、ここに示すルーティング名と認証情報名だけです。シークレットの値は表示されません。', willKeepTitle: '起動プロファイルに残る項目', willKeepFooter: '起動時だけ使用するこれらの設定は、移行後もプロファイルに残ります。', permissionDefaults: '既定の権限', persistenceDefaults: '既定のセッション保存設定' } } as const;

const providerMigrationConflictTranslations = { ja: { conflictReviewTitle: 'プロバイダー移行の競合を解決', conflictReviewFooter: '既存の接続を維持するか、このプロファイルを別の接続として保存するか選択してください。シークレットの値は表示されません。', conflictCredential: '保存済み認証情報が異なります', conflictModels: 'モデル設定が異なります', conflictEditedConnection: '既存の接続が編集されています', keepExisting: '既存の接続を維持', keepExistingDescription: '現在の認証情報とモデルを維持し、置き換えずに移行を完了します。', modelOutcomeTitle: '保持するモデルを選択', modelOutcomeFooter: '移行を完了する前に正確なモデルを確認してください。選択するまで変更されません。', useExistingModel: '接続の現在のモデルを使用', useExistingModelDescription: 'このプロバイダー接続ですでに選択されているモデルを保持します。', preserveLegacyModel: 'プロファイルのモデルを使用', preserveLegacyModelDescription: 'このプロファイルの正確なモデル選択を既存の接続へ移します。', discardLegacyModel: 'プロファイルのモデル選択を削除', discardLegacyModelDescription: 'このプロファイルのモデル選択やお気に入り設定を保持せずに移行を完了します。', createNamed: '別の接続を作成', createNamedDescription: 'このプロファイルのプロバイダー設定を新しい接続に保持します。', separateConnectionName: '接続名', conflictReviewAction: 'プロバイダーの競合を解決', conflictReviewActionDescription: '競合する認証情報やモデルの保持方法を選択します' } } as const;

const providerCredentialSelectionRequiredTranslations = { ja: 'このプロバイダー接続で使用する保存済み認証情報を選択してください' } as const;

const providerLinkTranslations = { ja: { providerWebsite: 'プロバイダーのウェブサイト', getApiKey: 'API キーを取得', failedToOpen: 'Happier はこのリンクを開けませんでした。' } } as const;

const providerCredentialFormatSelectionRequiredTranslations = { ja: 'この認証情報の送信方法を選択してください' } as const;

const providerReservedEnvironmentValidationUnavailableTranslations = { ja: '環境変数を変更する前に、このプロファイルエディターを利用可能なマシンへ接続してください。' } as const;

const providerAdvancedAuthoringTranslations = { ja: { advancedSetup: '詳細設定', advancedSetupEnabled: '複数の API 形式、ヘッダー、安全なモデル一覧の確認を設定します', advancedSetupDisabled: '一般的な互換エンドポイントを 1 つ使用します', endpointEnabled: 'この API 形式を使用', endpointEnabledDescription: '対応するエージェントでこのエンドポイントを使用可能にします', endpointDisabledDescription: 'この API 形式は使用されません', publicHeaders: '公開リクエストヘッダー', publicHeadersPlaceholder: 'X-Tenant: engineering', optionalProbePath: 'モデル一覧のパス（任意）', probeParserTitle: 'レスポンス形式', probeParser: { openaiModels: 'OpenAI 互換モデル一覧', ollamaTags: 'Ollama タグ', lmStudioNative: 'LM Studio ネイティブモデル一覧' } } } as const;

const providerCustomBearerHeaderTranslations = { ja: 'カスタムヘッダー（Bearer トークン）' } as const;

const providerNonSecretHeaderTranslations = { ja: 'シークレットではないヘッダー' } as const;

const providerProbePathsTranslations = { ja: 'モデル一覧のパス（任意、1 行に 1 つ）' } as const;

const providerLocalAuthoringTranslations = { ja: { enableAfterSaving: 'このプロバイダーを有効化', enableOnCurrentMachine: '保存後、このマシンでのみ有効化', enableAccountWide: '保存後に有効化', localAddressTitle: 'ローカルアドレス', localAddressDescription: ({ machine, endpoint }: { machine: string; endpoint: string }) => `マシンごとに有効化してください。${machine} は ${endpoint} を使用します。` } } as const;

const providerAuthoringReviewTranslations = { ja: { destinationReview: '接続先', destinationLoading: 'デーモンで正確な接続先を解決しています…', destinationSelection: '接続先を選択', destinationSelectionDescription: '接続する前に正確なアドレスを確認してください。', destinationScope: '接続先の範囲', destinationMachine: 'このマシン', destinationAccount: 'アカウント' } } as const;

const providerCompatibilityTranslations = { ja: { title: '対応エージェント', footer: '互換性は各エージェント連携で検証され、モデルによって異なる場合があります。', verified: '検証済み', experimental: '試験運用', incompatible: '非対応', experimentalDescription: '動作する可能性がありますが、初回使用前に確認が必要です', incompatibleDescription: 'このエージェントでは接続を安全に使用できません' } } as const;

const providerModelNotLoadedTranslations = { ja: '未読み込み · 初回使用時に読み込まれる場合があります' } as const;

const providerModelLoadCancellationTranslations = { ja: { cancelLoad: '読み込みをキャンセル', loadCancelled: 'モデルの待機を停止しました', loadCancelledProviderMayContinue: 'プロバイダー側では読み込みが続く場合があります。遅れて完了した結果は後でカタログを更新して確認してください。Happier が読み込みを再実行することはありません。' } } as const;

const providerPartialStatusTranslations = { ja: '一部利用可能' } as const;

const providerConnectedServiceSuppressedTranslations = { ja: 'このプロバイダーではエージェントの標準サインインを使用しません。保存済みの選択は変更されません。' } as const;

const providerMachineCleanupPendingTranslations = { ja: 'マシンは削除されましたが、プロバイダーアクセス設定のクリーンアップを保存できませんでした。接続を確認し、もう一度マシンを削除して再試行してください。' } as const;

const providerConnectionChangedTranslations = { ja: { title: 'プロバイダー接続が変更されました', description: '現在のプロバイダー設定を再読み込みして、もう一度お試しください。' } } as const;

const providerModelSectionTranslations = { ja: { available: '利用可能', manual: '手動' } } as const;

const providerCompletenessTranslations = { ja: {
        searchEmptyTitle: 'この検索に一致するプロバイダーはありません',
        searchEmptyDescription: '別のプロバイダー名または接続名をお試しください。',
        compatibilityReasons: {
            noCompatibleProtocol: 'このエージェントとプロバイダーで共通して対応している API プロトコルがありません。',
            noAuthUnsupported: 'このプロバイダーを使用するには、エージェントで API キーを送信できる必要があります。',
            credentialTransportUnavailable: '設定されている API キーの送信方法に、このエージェントは対応していません。',
            optionalCredentialNoAuthUnsupported: 'このエージェントでは、API キーが設定されていない状態でこのプロバイダーを使用できません。',
            capabilityUnsupported: '必要なプロバイダー機能に対応していません。',
            capabilityUnknown: '必要なプロバイダー機能が検証されていません。',
            modelEvidenceRequired: 'モデルを選択して、必要な機能を検証してください。',
            modelCapabilityUnsupported: 'モデルが必要な機能に対応していません。',
            modelCapabilityUnknown: '必要なモデル機能が検証されていません。',
            overrideIncompatible: 'プロバイダーの検証で、この連携は非対応と判定されています。',
            overrideExperimental: 'プロバイダーの検証で、この連携は試験運用と判定されています。',
            evidenceMissing: '互換性の検証情報がまだ記録されていません。',
            agentUnsupported: 'このエージェントは外部モデルプロバイダーに対応していません。',
            adapterInvalid: 'エージェントのプロバイダーアダプターを検証できませんでした。',
            unknown: '新しい互換性条件を確認する必要があります。',
        },
        unsavedDescription: 'このプロバイダーの下書きを破棄しますか？保存済みシークレットはアカウントで共有されるため、引き続き利用できます。',
        recoveryActions: {
            reviewFeatures: 'プロバイダーの利用可否を確認',
            chooseConnection: 'プロバイダーを選択',
            restorePlugin: 'プラグインを確認',
            enableConnection: 'プロバイダーを有効化',
            reviewAccountGrant: 'アカウントアクセスを確認',
            enableOnMachine: 'マシンで有効化',
            reviewMachineGrant: 'マシンアクセスを確認',
            reviewCompatibility: '互換性を確認',
            addSecret: 'API キーを追加',
            reviewCredentialTransport: '認証情報の対応状況を確認',
            reviewConnection: '接続を確認',
            retry: '再試行',
            replaceSecret: 'API キーを置き換える',
            chooseModel: 'モデルを選択',
            loadModel: 'モデルを読み込む',
            reviewAndRestart: '確認して再起動',
            restartProbe: 'もう一度テスト',
            reduceProviderSettings: 'プロバイダー設定を管理',
            reviewProfileMigration: 'プロファイル移行を確認',
            reviewCurrentState: '現在の設定を確認',
        },
        hiddenForAllAgents: 'すべてのエージェントで非表示 · プロバイダー設定で管理',
    } } as const;

const providerAvailabilityTranslations = { ja: {
        availabilityChecking: 'プロバイダーの利用可否を確認中', availabilityCheckingDescription: 'このサーバーがプロバイダー接続に対応しているか Happier が確認しています。',
        availabilityProblem: 'プロバイダーの利用可否を確認できませんでした', availabilityProblemDescription: 'Happier が自動的に再試行します。問題が続く場合はサーバー接続を確認してください。',
        availabilityUnsupported: 'プロバイダーにはサーバーの更新が必要です', availabilityUnsupportedDescription: 'このサーバーバージョンはプロバイダー接続に対応していません。',
        availabilityContextUnsupported: 'このコンテキストではプロバイダーを利用できません', availabilityContextUnsupportedDescription: '現在のサーバー設定または選択ではプロバイダー接続を利用できません。',
        availabilityPolicyDisabled: 'ポリシーによりプロバイダーが無効です', availabilityPolicyDisabledDescription: 'ローカルまたはビルドポリシーによりプロバイダー接続が無効になっています。',
    } } as const;

const settingsProvidersTranslations = { ja: withProviderSharedFields(ja, {
        providerAvailabilityTranslations: providerAvailabilityTranslations.ja,
        providerLinkTranslations: providerLinkTranslations.ja,
        providerCompletenessTranslations: providerCompletenessTranslations.ja,
        providerPartialStatusTranslations: providerPartialStatusTranslations.ja,
        providerMachineCleanupPendingTranslations: providerMachineCleanupPendingTranslations.ja,
        providerConnectionChangedTranslations: providerConnectionChangedTranslations.ja,
        providerCompatibilityTranslations: providerCompatibilityTranslations.ja,
        providerMigrationTranslations: providerMigrationTranslations.ja,
        providerMigrationPreviewTranslations: providerMigrationPreviewTranslations.ja,
        providerMigrationConflictTranslations: providerMigrationConflictTranslations.ja,
        providerCredentialSelectionRequiredTranslations: providerCredentialSelectionRequiredTranslations.ja,
        providerCredentialFormatSelectionRequiredTranslations: providerCredentialFormatSelectionRequiredTranslations.ja,
        providerReservedEnvironmentValidationUnavailableTranslations: providerReservedEnvironmentValidationUnavailableTranslations.ja,
        localTranslations: localTranslations.ja,
        providerSharedFieldTranslations: providerSharedFieldTranslations.ja,
        providerManagedDeploymentTranslations: providerManagedDeploymentTranslations.ja,
        copyNameTranslations: copyNameTranslations.ja,
        providerFirstSessionValidationTranslations: providerFirstSessionValidationTranslations.ja,
        providerAdvancedAuthoringTranslations: providerAdvancedAuthoringTranslations.ja,
        providerLocalAuthoringTranslations: providerLocalAuthoringTranslations.ja,
        providerAuthoringReviewTranslations: providerAuthoringReviewTranslations.ja,
        providerNonSecretHeaderTranslations: providerNonSecretHeaderTranslations.ja,
        providerProbePathsTranslations: providerProbePathsTranslations.ja,
        providerCustomBearerHeaderTranslations: providerCustomBearerHeaderTranslations.ja,
        providerModelSectionTranslations: providerModelSectionTranslations.ja,
        providerModelLoadCancellationTranslations: providerModelLoadCancellationTranslations.ja,
        providerModelNotLoadedTranslations: providerModelNotLoadedTranslations.ja,
        providerConnectedServiceSuppressedTranslations: providerConnectedServiceSuppressedTranslations.ja,
    }) } as const;

return { localTranslations, providerManagedDeploymentTranslations, copyNameTranslations, providerSharedFieldTranslations, providerFirstSessionValidationTranslations, providerMigrationTranslations, providerMigrationPreviewTranslations, providerMigrationConflictTranslations, providerCredentialSelectionRequiredTranslations, providerLinkTranslations, providerCredentialFormatSelectionRequiredTranslations, providerReservedEnvironmentValidationUnavailableTranslations, providerAdvancedAuthoringTranslations, providerCustomBearerHeaderTranslations, providerNonSecretHeaderTranslations, providerProbePathsTranslations, providerLocalAuthoringTranslations, providerAuthoringReviewTranslations, providerCompatibilityTranslations, providerModelNotLoadedTranslations, providerModelLoadCancellationTranslations, providerPartialStatusTranslations, providerConnectedServiceSuppressedTranslations, providerMachineCleanupPendingTranslations, providerConnectionChangedTranslations, providerModelSectionTranslations, providerCompletenessTranslations, providerAvailabilityTranslations, settingsProvidersTranslations };
})();

const Domain_settingsSearchKeywordsTranslations = (() => {
const english = Shared_settingsSearchKeywordsTranslations.english;

const translated = Shared_settingsSearchKeywordsTranslations.translated;

const settingsSearchKeywordsTranslations = { ja: translated({
        settingsSearchKeywords: {
            settings: '設定, ホーム, 概要',
            groupProfileAndAccount: 'アカウント, プロフィール, 請求, プラン, 使用量',
            groupToolsAndModels: 'ツール, モデル, プロバイダー, 接続済みサービス, mcp, プラグイン, プロンプト, スキル, 検索, メモリ',
            account: 'アカウント, プロフィール, 請求',
            accountSecurity: 'セキュリティ, パスワード, 復元, 暗号化, サインアウト',
            apiTokens: 'api トークン, 個人アクセストークン, pat, 自動化, cli, sdk',
            teams: 'チーム, メンバー, グループ, 招待',
            homeAdministration: 'home, 管理, ガバナンス, ユーザー, ポリシー',
            secrets: 'シークレット, キー, env, トークン',
            usage: '使用量, 請求, 制限, クォータ',
            machines: 'マシン, デバイス, コンピューター',
            machinePoolsNew: 'マシンプール, プール, フォールバック, 実行先',
            machinesAdd: '追加, マシン, ssh',
            machinesThisComputer: 'このコンピューター, ローカル, デバイス',
            remoteHosts: 'リモート, ホスト, ssh, サーバー, マシン',
            groupGeneral: '一般, 外観, 言語, 実験',
            appearance: '外観, テーマ, フォント, ui, サイドバー',
            keyboard: 'キーボード, ショートカット, ホットキー, コマンド',
            pets: 'ペット, blink, コンパニオン, codex',
            language: '言語, ロケール, 翻訳',
            features: '機能, 実験, ベータ',
            groupAiAndAgents: 'エージェント, プロバイダー, mcp, プロンプト, 音声',
            agents: 'プロバイダー, エージェント, モデル, llm',
            providers: 'プロバイダー, モデル, openrouter, ollama, lm studio',
            subAgent: 'サブエージェント, エージェント, 委任, ルール',
            roles: 'ロール, オーケストレーター, ビルダー, レビュアー, 指示',
            delegation: '委任, 作業の深さ, 引き継ぎ, オーケストレーター',
            profiles: 'プロフィール, ペルソナ',
            connectedServices: '接続済みサービス, oauth, アカウント',
            mcp: 'mcp, ツール, サーバー, プラグイン',
            plugins: 'プラグイン, マーケットプレイス, カタログ, 記述子, 検出',
            prompts: 'プロンプト, テンプレート, ライブラリ',
            promptsTemplates: 'テンプレート',
            promptsFolders: 'フォルダー',
            promptsStacks: 'スタック',
            promptsRegistries: 'レジストリ',
            promptsLibrary: 'ライブラリ',
            promptsAssets: 'アセット, 外部',
            voice: '音声, アシスタント, マイク',
            voiceConversations: '音声, 会話, リアルタイム, プロバイダー',
            voiceDictation: '音声, 音声入力, 発話, 文字起こし',
            voicePrivacy: '音声, プライバシー, 履歴, 保持',
            voiceAdvanced: '音声, 詳細, マシン, 診断',
            memory: 'メモリ, 検索, インデックス',
            groupSessionsBehavior: 'セッション, トランスクリプト, 権限, アクション',
            session: 'セッション, ターミナル, tmux',
            externalSessions: '外部セッション, バックグラウンド追従, フック',
            actions: 'アクション, 承認, ショートカット',
            embeds: '埋め込み, iframe, ウィジェット, ウェブサイト, チャット',
            transcript: 'トランスクリプト, チャット, レイアウト',
            permissions: '権限, 承認, セキュリティ',
            toolRendering: 'ツール, 表示',
            handoff: '引き継ぎ, 転送',
            runs: '実行, 実行履歴',
            groupFilesAndSourceControl: 'ファイル, ソース管理, 添付ファイル',
            sourceControl: 'git, scm, ソース管理',
            attachments: '添付ファイル, アップロード, ファイル',
            groupSystem: 'システム, サーバー, ステータス, 通知',
            servers: 'サーバー, リレー',
            systemStatus: 'システムステータス, 正常性, 診断',
            updates: 'アップデート, 更新, バージョン, cli, 再起動',
            notifications: 'notif, 通知, プッシュ, push',
            notificationsPush: 'push, プッシュ',
            desktop: 'デスクトップ, tauri, オーバーレイ, ウィンドウ',
            diagnosis: '診断, デバッグ',
            reportIssue: '問題を報告, バグ, bug',
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
>, "ja"> = { ja: {
        settingsSessionPages: {
            preview: {
                userMessage: '不安定な再接続テストを直して',
                agentReply: '原因が分かりました。リトライタイマーが解除されていませんでした。修正してテストは通ります。',
                thinking: 'タイムアウト後にだけ失敗するので、リトライタイマーがまだ動いているはずです。',
            },
            runtime: {
                pageDescription: 'マシン上でセッションをどう実行するか。',
                terminalSection: 'ターミナル',
                terminalHostTitle: '新しいセッションのターミナルホスト',
                terminalHostNone: 'なし',
                tmuxTitle: 'セッションを tmux で開始',
                tmuxOn: '新しいセッションは専用の tmux ウィンドウで開くので、ターミナルから接続できます。',
                tmuxOff: '新しいセッションは通常のシェルで実行されます。',
            },
            wizard: {
                pageDescription: '新規セッションウィザードの各ステップの配置。',
                wideScreensSection: 'ワイド画面',
                stepsSection: '各ステップでの選択肢の表示',
                steps: {
                    profiles: 'プロファイル',
                    backends: 'エージェント',
                    models: 'モデル',
                    machines: 'マシン',
                    paths: 'フォルダー',
                    permissions: '権限',
                },
            },
            providerLimits: {
                pageDescription: '使用上限に達したときの動作と、残りのクォータ。',
                recoveryDescription: 'エージェントが使用上限に達したとき、セッションはリセットを待って続行できます。',
                resumePromptCustom: 'カスタム',
                unavailableTitle: 'このHomeでは利用できません',
                unavailableDescription: 'このHomeでは、使用上限からの復帰と使用量ゲージが有効になっていません。',
            },
            resume: {
                pageDescription: 'エージェントが自力で再開できないときに、非アクティブなセッションをどう続けるか。',
                strategyRecent: '最近のメッセージ',
                strategySummary: '要約 + 最近',
                maxSeedCharsTitle: 'リプレイのサイズ上限',
                summaryModelSection: '要約モデル',
                summaryModelDescription: '新しいセッションに渡す要約を書くエージェントとモデル。',
                handoffSection: 'セッションの移動',
                handoffLinkDescription: 'セッションを別のマシンに引き継ぐときに一緒に移るもの。',
            },
            permissions: {
                duringSessionSection: 'セッション中',
                duringSessionDescription: '承認リクエストの表示場所と、実行中セッションの権限変更が反映されるタイミング。',
                promptSurfaceComposer: '入力欄の近く',
                applyImmediately: 'すぐに',
                applyNextMessage: '次のメッセージから',
                storageUseDefault: 'デフォルト',
            },
            handoff: {
                pageDescription: 'セッションを別のマシンに引き継ぐときに一緒に移るもの。',
                workspaceSection: 'ワークスペースのファイル',
                workspaceDescription: 'セッションが別のマシンに移るとき、プロジェクトフォルダーをどう扱うか。',
                keepUpdated: '最新に保つ',
                advancedModeDescription: '上の選択を置き換えます。注意: ファイルが削除または上書きされることがあります。',
                ignoredExclude: '除外',
                ignoredIncludeSelected: '選択分を含める',
            },
            toolRendering: {
                pageDescription: '特定のツールの詳細度を、トランスクリプトのデフォルトより増やしたり減らしたりします。',
                collapsedDescription: '開く前に、各ツールがトランスクリプトにどこまで表示するか。',
            },
            transcript: {
                advancedTitle: 'パフォーマンスとタイミング',
                advancedPageDescription: 'ストリーミング、アニメーションのタイミング、スクロールのしきい値。ほとんどの人はデフォルトのままで問題ありません。',
                advancedMotionOff: 'トランスクリプトのアニメーションがオフのため、これらは効果がありません。トランスクリプト › モーションでオンにしてください。',
                toolsSection: "ツール呼び出し",
                toolOverridesDescription: '特定のツールの詳細度を増やしたり減らしたりします。',
                agentVisualsSection: 'エージェントのビジュアル',
                agentVisualsDescription: 'エージェントが返信で表示するグラフ、表、ページ。',
                thinkingSummary: '要約',
                thinkingFull: '全文',
                strategyConsecutive: '連続したもの',
                strategyWholeTurn: 'ターン全体',
                copyMarkdown: 'Markdown',
                copyMarkdownDescription: 'コピーしたメッセージは書式を保ち、誰が書いたかが分かります。',
                copyPlainDescription: 'コピーしたメッセージはラベルなしのプレーンテキストになります。',
                motionSubtle: '控えめ',
                advancedLinkDescription: 'ストリーミング、アニメーションのタイミング、スクロールのしきい値。',
                pageDescription: '会話が長くなってもどう読めるか: レイアウト、思考、ツール、モーション、スクロール。',
            },
            composer: {
                pageDescription: 'メッセージの書き方と送り方、エージェントが作業中のときの動作。',
                newSessionsSection: '新しいセッション',
                newSessionsDescription: '「新しいセッション」を選んだときに表示されるもの。',
                draftEntryTitle: '新しいセッションを開いたとき',
                draftResume: '下書きを再開',
                draftFresh: '新しく始める',
                typingSection: '入力',
                typingDescription: '入力欄での Enter とメッセージ履歴の動作。',
                enterToSendTitle: 'Enter で送信',
                sendModeTitle: 'エージェントの作業中',
                sendQueue: 'キュー',
                sendInterrupt: '中断',
                sendPending: '保留',
                busySteerTitle: 'エージェントが誘導に対応している場合',
                busySteerInactive: 'エージェントの作業中にメッセージがキューまたは保留に入るときだけ適用されます。',
                nonSteerableTitle: 'メッセージで誘導できないときに確認',
                resumeWhenPossible: '可能になったら',
                resumeIfOnline: 'オンラインなら',
                resumeNever: 'しない',
                pendingSection: '保留中のメッセージ',
                pendingDescription: '保留中のメッセージがエージェントに届く方法。',
                pendingInactive: '現在の設定では何も保留されません。メッセージが保留されると適用されます。',
                drainOne: '1 件ずつ',
                drainAll: 'まとめて',
                timingAfterReply: '返信の後',
                timingWhenIdle: 'すべてアイドル時',
                layoutSection: '入力欄のレイアウト',
                actionBarTitle: 'アクションバー',
                actionBarAutoDescription: 'コントロールは利用可能な幅に合わせて、必要に応じて折り返します。',
                actionBarWrapDescription: '収まらないときはチップが 2 行目に折り返します。',
                actionBarScrollDescription: 'チップは 1 行のまま。残りは横にスクロールします。',
                actionBarCollapsedDescription: 'チップはメニューにまとめられ、入力スペースが最大になります。',
                chipDensityTitle: 'アクションチップ',
                chipsAutoDescription: '必要なチップはラベルを残し、分かりやすいものはアイコンだけにします。',
                chipsLabelsDescription: 'すべてのチップにラベルを表示します。',
                chipsIconsDescription: 'スペースを節約するため、チップはアイコンだけを表示します。',
            },
        },
    } };

return { settingsSessionPagesTranslations };
})();

const Domain_shareSheetTranslations = (() => {
type ShareSheetTranslations = Shared_shareSheetTranslations.ShareSheetTranslations;

const shareSheetTranslations = { ja: {
        publicLink: { workflowDescription: "リンクを持つ人は、アカウントなしでこのワークフローを閲覧できます。", workflowGrants: "閲覧専用のワークフロー。", description: "リンクを持つ人は、アカウントなしでこの文書を閲覧できます。", grants: "閲覧専用の文書。", audit: "アクセス履歴", auditEmpty: "アクセスはまだ記録されていません。", ownerUpdateRequired: "所有者がこのリンクを更新しています", ownerUpdateRequiredDescription: "所有者にHappierを開くよう依頼してから、このリンクをもう一度お試しください。" },
        suggestions: ({ kind }: Readonly<{ kind: string }>) => `候補: ${kind}`,
        profileAgentsMore: ({ count }: Readonly<{ count: number }>) => `ほか${count}件`,
        whoHasAccess: 'アクセスできるユーザー',
        whoHasAccessStale: 'アクセスできるユーザー · 最新でない可能性があります',
        owner: 'オーナー',
        you: 'あなた',
        addPlaceholder: 'ユーザーまたはチームを追加',
        person: 'ユーザー',
        group: 'チームのグループ',
        team: 'チーム',
        accessLevel: 'アクセスレベル',
        accessibleControl: ({ name, control, value }) => `${name}、${control}、${value}`,
        remove: 'アクセスを削除',
        confirmRemove: '削除を確定',
        removedAnnouncement: ({ name }) => `${name} のアクセスを削除しました`,
        removeLosesPerson: ({ name }) => `${name} はすべてのデバイスでアクセスできなくなります。`,
        removeLosesMembers: ({ name }) => `${name} のメンバーはすべてのデバイスでアクセスできなくなります。`,
        removeKeepsOtherAccess: "別の方法で共有されたアクセスはそのまま残ります。",
        removeKeepsTheirWork: "本人のチェックアウト、セッション、ウィジェットはそのまま残ります。",
        browseAll: 'すべて表示',
        browsePeople: 'すべての人を表示',
        browseTeams: 'すべてのチームを表示',
        browseGroups: 'すべてのチームグループを表示',
        membersOnlyLink: 'リンクのコピーは、すでにアクセス権がある人向けです。',
        allLoaded: 'すべての結果を読み込みました',
        noConnectedPeople: 'ここには、つながっている人だけが表示されます。',
        copyLink: 'リンクをコピー',
        linkCopied: 'リンクをコピーしました',
        copyLinkFailed: 'リンクをコピーできませんでした。',
        sendCopy: '代わりにコピーを送る',
        cantAdd: '追加できません',
        secrets: {
            levels: { canUse: '使用可' },
            help: { use: '実行用に選択できます。値は表示されません' },
            oneLevel: '保存したシークレットは実行でのみ使われ、値が外に出ることはないため、レベルは1つだけです。',
        },
        documents: {
            title: '共有',
            shareTitle: ({ name }) => `${name} を共有`,
            shareMenu: "共有…",
            levels: { canUse: '使用可', canRead: '閲覧可', canEdit: '編集可', admin: '管理' },
            help: {
                workflowUse: '表示と実行',
                roleUse: "自分のセッションにロールを適用できます。個人の変更は自分の設定に残ります",
                profileUse: 'これでセッションを開始',
                documentUse: '自分のどのデバイスでも開いてコピーできます',
                promptUse: "自分のセッションにプロンプトを挿入できます",
                boardUse: 'ボードを表示できます。各カードはすでに開けるものだけを開きます',
                dashboardUse: 'このダッシュボードを表示できます。各ウィジェットには、すでに開けるものだけが表示されます。',
                editForEveryone: '共有先の全員に向けて変更',
                adminOwnerShares: '変更と共有を管理',
            },
            notes: {
                personalRuns: '実行とトリガーは開始した人に残ります。',
                teamRuns: 'チームはすべての実行を見られます。',
                roleLive: 'あなたの変更は共有先の全員に届きます。',
                profileSecrets: 'プロファイルは保存済みシークレットを参照します。値は送信されません。',
                dashboardAccess: '追加された人は自分のアカウントで開きます。ウィジェット、定義、接続、マシン、リポジトリにはそれぞれ個別のアクセス権が必要です。',
            },
            privateChoices: {
                title: '個人用の接続選択',
                account: ({ widget, service }) => `${widget} はあなたの ${service} アカウントを使用します`,
                letViewersPick: '閲覧者に選択させる',
                removeChoice: '選択を削除',
                authoredInput: ({ widget }) => `${widget} を編集し、共有前に個人用の入力を削除してください。`,
            },
            errors: {
                unavailable: 'ここではまだ共有を利用できません。',
                ownerOnly: 'アクセスできるユーザーを変更できるのはオーナーまたは管理者だけです。',
                noAccess: 'アクセス権がなくなりました。',
                notFound: 'これはもう利用できません。',
                subjectUnavailable: 'このユーザー、グループ、チームにはアクセスを付与できません。',
                failed: '共有を更新できませんでした。もう一度お試しください。',
            },
        },
    } } satisfies Pick<Record<string, ShareSheetTranslations>, "ja">;

return { shareSheetTranslations };
})();

const Domain_sidebarFooterTranslations = (() => {
type SidebarFooterTranslation = Shared_sidebarFooterTranslations.SidebarFooterTranslation;

const sidebarFooterTranslations = { ja: {
        linkToService: ({ service }) => `${service} にリンク`,
        addHomeOrSignIn: 'Home を追加またはサインイン',
        usageNoAccounts: 'アカウントを接続すると、上限の残りを確認できます。',
        usageHealthy: 'すべての上限に十分な余裕があります',
        homeUnreachableTitle: ({ home }) => `${home} に接続できません`,
        homeUnreachableBody: '応答があり次第、マシンとセッションがここに再び表示されます。',
        homeUnreachableLine: ({ home }) => `${home} に接続できません。`,
        availableWhenHomeAnswers: "この Home が応答すると利用できます。",
        usageKeysWithoutLimits: ({ count }) => `上限なしのキー ${count} 件`,
        usageSignedOut: 'サインアウト済み',
        hideAccountIdentities: 'アカウントのメールと ID を隠す',
        accountIdentitiesHidden: 'メールと ID を非表示 · 配信やデモ向け',
        usageThisSession: 'このセッション',
        usageAllAccounts: 'すべてのアカウント',
        usageMoreAccounts: ({ count }) => `ほか ${count} 件`,
        usageSessionThroughPool: ({ agent, pool }) => `${agent} は ${pool} 経由でサインインします`,
        usageSessionWithAccount: ({ agent }) => `${agent} はこのアカウントでサインインします`,
        usageSessionOwnSignIn: ({ agent }) => `${agent} は独自のサインインを使います`,
        usagePoolFallback: 'そのプール',
        usageNextInOrder: ({ account }) => `${account} を使い切ると、次のターンは順番で次のアカウントに移ります`,
        usageNextMostLeft: ({ account }) => `${account} を使い切ると、次のターンは残りが最も多いアカウントに移ります`,
        usageNextStays: ({ pool, account }) => `${pool} は切り替えるまで ${account} のままです`,
        machinesEmptyTitle: '自分のコンピューターでセッションを実行',
        machinesEmptyBody: 'このコンピューター、サーバー、クラウドマシンを追加しましょう。Happier はそれぞれが何をしているかを表示し、対応が必要なときに知らせます。',
        machinesAddThisComputer: 'このコンピューターを追加',
        machinesAddAnotherMachine: '別のマシンを追加',
        machinesHomeSignedOut: ({ home }) => `${home} からサインアウトしているため、そのマシンは表示されません。`,
    } } as const satisfies Pick<Record<string, SidebarFooterTranslation>, "ja">;

return { sidebarFooterTranslations };
})();

const Domain_surfaceStateTranslations = (() => {
type SurfaceStateTranslations = Shared_surfaceStateTranslations.SurfaceStateTranslations;

const surfaceStateTranslations = { ja: {
        stillWaiting: ({ seconds }) => `待機中 · ${seconds} 秒`,
        asOf: ({ time }) => `${time} 時点`,
        howItWorks: '仕組み',
        tryAgain: '再試行',
        checkAgain: 'もう一度確認',
        paneFailedTitle: 'このパネルを表示できませんでした',
        paneFailedReason: '描画中に問題が発生しました。セッションには影響ありません。',
        opening: ({ name }) => `${name} を開いています`,
        couldNotOpen: ({ name }) => `${name} を開けませんでした`,
        couldNotUpdate: '更新できませんでした。前回の内容を表示しています',
    } } as const satisfies Pick<Record<string, SurfaceStateTranslations>, "ja">;

return { surfaceStateTranslations };
})();

const Domain_teamsTranslations = (() => {
type TeamsTranslationRoot = Shared_teamsTranslations.TeamsTranslationRoot;

const english = Shared_teamsTranslations.english;

const japanese: TeamsTranslationRoot = {
    teams: {
        leave: {
            action: 'チームを退出',
            description: 'チームとグループへのアクセスが終了します。このHomeのアカウントは残ります。',
            confirmTitle: ({ name }: { name: string }) => `${name}を退出しますか？`,
            confirmBody: "チームとそのグループへのアクセスは今すぐ終了します。書いた内容は残り、後で再参加すると新しいメンバーシップになります。",
            auditLeft: ({ team }: { team: string }) => `${team}を退出しました`,
            auditRemoved: ({ team, target }: { team: string; target: string }) => `${target}を${team}から削除しました`,
        },
        overview: {
            sharedSessions: "共有セッション",
            allSharedSessions: "すべての共有セッション",
            managedBy: ({ team }: { team: string }) => `${team}のオーナーと管理者が、メンバー、サインイン、設定を管理します。`,
            suspendedTitle: 'アクセスは一時停止中です',
            suspendedBody: 'このチームの管理者があなたのアクセスを一時停止しました。チームを退出できます。',
            attention: {
                directoryFailedTitle: ({ name }: { name: string }) => `${name}を同期できませんでした`,
                directoryFailedBody: "メンバーとグループは、最後に成功した同期の状態のままです。",
                invitationUndeliveredTitle: "招待メールが届きませんでした",
                invitationUndeliveredBody: ({ recipient }: { recipient: string }) => `宛先: ${recipient}。別の方法で共有すれば、リンクは引き続き使えます。`,
            },
            sessionsSubtitle: 'このチームと共有されているセッション。',
            teamSection: 'チーム',
            summary: {
                historyFromJoining: "参加以降の履歴",
                historyEarlier: "以前の履歴も含む",
                groupsDirectory: ({ directory }: { directory: string }) => `${directory}と同期`,
                undelivered: ({ count }: { count: number }) => `未着のメール ${count} 件`,
                credentialsShared: ({ count, team }: { count: number; team: string }) => `${team}と ${count} 件を共有中`,
                credentialsNone: "まだ共有されていません",
                justYou: 'あなただけ',
                people: ({ count }: { count: number }) => count === 1 ? `1人` : `${count}人`,
                suspended: ({ count }: { count: number }) => `${count}人停止中`,
                groups: ({ count }: { count: number }) => count === 1 ? `1グループ` : `${count}グループ`,
                noGroups: 'まだグループはありません',
                waiting: ({ count }: { count: number }) => `${count}件が承諾待ち`,
                noneWaiting: '承諾待ちなし',
                homeSignIn: 'Home のサインイン',
                chosenSignIn: '選んだサインインのみ',
                signInNeedsRepair: 'サインインのルールを修復する必要があります',
                sessionsPrivate: 'セッションは既定で非公開',
                sessionsShared: 'セッションは既定で共有',
                sessionsAlwaysShared: 'セッションは常に共有',
            },
            setup: {
                title: ({ team }: { team: string }) => `${team}を準備する`,
                description: '完了したステップはこのリストから消えます。',
                inviteBody: ({ team, home }: { team: string; home: string }) => `招待した人は${team}の一員として${home}に参加します。`,
                signInTitle: 'メンバーのサインイン方法を選ぶ',
                signInBody: 'このHomeのサインインのままにするか、会社のサインインを必須にします。',
                signInAction: '選ぶ',
                shareTitle: 'セッションを共有する',
                shareBody: ({ team }: { team: string }) => `セッションのメニューから${team}と共有します。`,
            },
        },
        denied: {
            askUnnamed: "このチームのオーナーまたは管理者に依頼してください。",
            title: 'このチームでのあなたの役割には含まれていません',
            authentication: ({ team }: { team: string }) => `${team}のオーナーと管理者がメンバーのサインイン方法を決めます。`,
            settings: ({ team }: { team: string }) => `${team}のオーナーと管理者がこれらを変更します。`,
        },
        pages: {
            credentialCreate: '共有するもの、使える人、上限を選びます。',
            credentialDetail: 'この認証情報を使える人、使い方、使用量。',
            credentialEdit: 'この認証情報を使える人、使い方、使用量を変更します。',
            credentialActivity: 'この認証情報への変更と、変更した人。',
            credentialUsage: 'この認証情報の使用量と、使った人。',
            credentialExternalApi: 'Happier 以外のツールからこの認証情報を使います。',
            identityProviderNew: 'メンバーがサインインに使える ID プロバイダーを接続します。',
            identityProviderEdit: 'この ID プロバイダーの接続方法を変更します。',
            githubApp: 'このチームがリポジトリにアクセスするための GitHub App。',
            githubAppEdit: 'この GitHub App の登録を変更します。',
            authentication: 'メンバーがこのチームにサインインする方法と、参加を認める相手。',
            credentials: 'このチームがメンバーと共有するプロバイダーの認証情報。',
            directory: 'Home 上でセッション、アクセス、認証情報を共有するメンバーのグループです。',
            members: 'このチームのメンバーと、それぞれができること。',
            addMember: 'この Home にすでにアカウントがある人を追加します。',
            groups: 'セッションや認証情報を共有するための、名前付きのメンバーのまとまり。',
            newGroup: 'グループに名前を付けます。メンバーは作成後に追加します。',
            invitations: "このチームに招待された人と、参加したかどうか。",
            settings: '名前、ロゴ、セッションの既定値、このチームが有効かどうか。',
        },
        loading: 'チームを読み込んでいます…',
        title: 'チーム',
        entrySubtitle: 'チームを作成し、メンバーとグループを管理し、人を招待します。',
        entry: {
            heading: ({ team }: { team: string }) => `${team} に進む`,
            onHome: ({ home }: { home: string }) => `${home} 上`,
            signInServiceOrigin: ({ service }: { service: string }) => `${service} でサインイン`,
            signInServiceUnavailableOrigin: ({ service }: { service: string }) => `${service} でのサインインは利用できません`,
            signedInTo: ({ home, account }: { home: string; account: string }) => `${home} に ${account} としてサインイン中`,
            unnamedAccount: 'Happierアカウント',
            continueWith: ({ method }: { method: string }) => `${method} で続ける`,
            providerUnavailableTitle: ({ method }: { method: string }) => `${method} は利用できません`,
            providerUnavailableDisabled: 'チームの管理者がこのサインインをオフにしました。しばらくしてからもう一度確認してください。',
            providerUnavailableSetupIncomplete: 'チームの管理者がこのサインインの設定をまだ完了していません。しばらくしてからもう一度確認してください。',
            providerUnavailableUnavailable: 'この Home は現在このサインインを使用できません。しばらくしてからもう一度確認してください。',
            unknownTargetTitle: 'このリンクは Home を示していません',
            unknownTargetBody: 'このデバイスでは、このチームサインインリンクがどの Home のものか判別できないため、どの Home にも送信していません。チームの管理者にリンクを再発行してもらってください。',
            ssoRequiredTitle: 'このチームには別のサインイン方法が必要です',
            ssoRequiredBody: 'この Home にはサインインしていますが、このチームは指定されたサインイン方法しか受け付けません。その方法でもう一度サインインするか、ご自身の作業に戻ってください。',
            invitationUnavailableTitle: 'この招待は使用できません',
            invitationUnavailableBody: '期限切れ、取り消し済み、または使用済みの可能性があります。サインインするだけではチームには参加できません。',
            wrongAccountTitle: 'このアカウントではこのサインインを使用できません',
            wrongAccountBody: 'サインインに使用したアカウントまたは ID は、このチームが想定しているものではありません。別のアカウントやプロバイダーでサインインするか、ご自身の作業に戻ってください。',
            notProvisionedTitle: 'このチームはまだあなたを受け入れていません',
            notProvisionedBody: 'サインインするだけでは、このチームには参加できません。誰を受け入れるかは管理者が決めます。管理者にアクセスまたは招待を依頼してから、もう一度お試しください。',
            directoryDelayedTitle: 'アクセス権はまだ届いていません',
            directoryDelayedBody: 'このチームのメンバーはディレクトリから取り込まれますが、あなたのアクセス権はまだ届いていません。しばらくしてからもう一度お試しになるか、チームの管理者にお問い合わせください。',
            accessRemovedTitle: 'このチームは利用できません',
            accessRemovedBody: 'アクセス権が削除されたか、この Home ではこのチームが現在利用できない可能性があります。ほかにサインインしているものには影響ありません。',
            providerChangedTitle: '使用中にこのサインイン方法が変更されました',
            providerChangedBody: 'サインインの途中で、管理者がこのサインイン方法を更新しました。アカウントは何も変更されていません。チームのページからやり直して、現在の方法をご確認ください。',
            returnToTeamSignIn: 'チームのサインインに戻る',
            returnToHappier: 'Happier に戻る',
            signInToTeam: 'このチームにサインイン',
            readyStatus: '続行するにはサインイン方法を選択してください。',
        },
        homeLabel: 'Home',
        role: {
            owner: 'オーナー',
            admin: '管理者',
            member: 'メンバー',
            guest: 'ゲスト',
        },
        roleHelp: {
            owner: 'チームのオーナーで、チームを管理し、オーナーを変更できます。',
            admin: 'メンバーのアクセス権を持ち、チームを管理できます。',
            member: 'チームに付与されたアクセス権を既定で受け取ります。',
            guest: 'このアカウント、または所属するグループに明示的に共有されたセッションとリソースのみを見られます。',
        },
        status: {
            active: '有効',
            suspended: '停止中',
        },
        history: {
            label: 'セッション履歴',
            allExisting: 'すでにチームに共有済みのセッションを含める',
            fromMembership: '参加後に共有されたセッションのみ',
            allExistingNamed: ({ name }) => `すでに${name}に共有済みのセッションを含める`,
            fromMembershipNamed: ({ name }) => `${name}に参加した後に共有されたセッションのみ`,
            scopeNote: 'これはセッション全体に適用されます。参加後に作成されたメッセージだけが見えるわけではありません。',
        },
        unavailable: {
            title: 'この Home ではチームを利用できません',
            disabled: 'この Home ではチームが無効になっています。',
            updateRequired: 'チームを使うには、この Home の更新が必要です。',
            offline: 'この Home には現在接続できません。',
            retry: '再試行',
        },
        stale: {
            label: 'この Home の最後に取得したデータを表示しています。',
        },
        errors: {
            loadFailed: "この情報を読み込めませんでした。もう一度お試しください。",
            generic: '完了できませんでした。何も変更されていません。',
            outcomeUnknown: 'Home でこの変更が完了した可能性があります。再試行する前にチームを更新してください。',
            authenticationRequired: "このチームが必要とする方法でサインインし、もう一度お試しください。",
            forbidden: 'この変更を行う権限がありません。',
            notFound: 'このチームは利用できなくなりました。',
            archived: 'このチームはアーカイブ済みです。変更するには復元してください。',
            conflict: '他の人が先に変更しました。現在の値を確認してからやり直してください。',
            offline: 'この Home に接続できないため、変更は送信されませんでした。',
            invalidName: '1〜80 文字の名前を入力してください。',
            invalidDescription: '説明は 500 文字以内で入力してください。',
        },
        directory: {
            loading: 'チームを読み込んでいます…',
            chooseTeamToShare: '共有するチームを選んでください。',
            noMatches: '一致するチームはありません',
            noLoadedMatches: '読み込み済みのチームに一致するものはありません',
            searchLoadedPlaceholder: '読み込み済みのチームを絞り込む',
            unreachableHomes: "チームを利用できません",
            searchPlaceholder: 'チームを検索',
            newTeam: '新しいチーム',
            createDenied: ({ homes }: { homes: string }) => `${homes} でチームを作成できるのは管理者だけです。管理者にチームの作成か、チームへの追加を依頼してください。`,
            createAdministered: ({ names }: { names: string }) => `このHomeのチームは管理者が作成します。${names} にチームの作成を依頼するか、全員がチームを作成できるようにするよう依頼してください。`,
            createAdministeredUnnamed: 'このHomeのチームは管理者が作成します。管理者にチームの作成を依頼するか、全員がチームを作成できるようにするよう依頼してください。',
            createOff: 'このHomeではチームの作成がオフになっています。',
            letEveryoneCreate: '全員にチームの作成を許可',
            namesAnd: ({ names, last }: { names: string; last: string }) => `${names}、${last}`,
            namesAndOthers: ({ names, count }: { names: string; count: number }) => `${names} ほか${count}名`,
            emptyTitle: 'チームがまだありません',
            emptyBody: 'チームは、セッション・人・アクセスをまとめて扱える共有の場です。',
            emptyStart: '一緒に働く人のために作成して、招待しましょう。',
            archivedSection: 'アーカイブ済みのチーム',
            archivedEmpty: 'アーカイブ済みのチームはありません',
            archivedEmptyBody: 'チームの設定からアーカイブすると、ここに移動します。メンバー、グループ、履歴は保持されます。',
            showArchived: 'アーカイブを表示',
            hideArchived: 'アーカイブを非表示',
            archivedBadge: 'アーカイブ済み',
            rowAccessibilityLabel: ({ name, role, home }: { name: string; role: string; home: string }) => `${name}、${role}、${home} 上`,
            partialHomes: "一部のHomeでチームを読み込めませんでした。他のHomeは下に表示されます。",
        },
        create: {
            loading: 'チームを作成できる Home を確認しています…',
            discard: '破棄',
            detailsSection: 'チーム',
            logoFailedBody: 'チームは作成されましたが、ロゴは公開されませんでした。もう一度試すか、ロゴなしで続けてください。',
            title: '新しいチーム',
            nameLabel: '名前',
            namePlaceholder: 'Acme',
            descriptionLabel: '説明',
            descriptionPlaceholder: 'このチームが取り組む内容',
            homeHelp: 'チームはこの Home 上に作成され、そこに保持されます。',
            managedOnlyTitle: 'この Home ではチーム作成が管理されています',
            managedOnlyBody: '管理者がここでチームを作成し、最初のオーナーを選びます。',
            initialOwnerLabel: '最初のオーナー',
            initialOwnerPlaceholder: 'この Home の人を検索',
            initialOwnerHelp: '他の人のためにチームを作成しても、あなたは追加されません。',
            initialOwnerRequired: 'チームの最初のオーナーを選んでください。この Home では、新しいチームのオーナーを管理者が指定します。',
            initialOwnerIneligible: 'この人はもうチームを所有できません。別の人を選んでください。',
            submit: 'チームを作成',
            submitting: '作成中…',
            outcomeUnknown: 'チームが作成されたか確認できませんでした。再試行すると同じリクエストを復旧します。',
        },
        tabs: {
            overview: '概要',
            sessions: 'セッション',
            members: 'メンバー',
            groups: 'グループ',
            invitations: '招待',
            authentication: '認証',
            settings: '設定',
        },
        authentication: {
            policy: {
                admissionRow: "新しいメンバー",
                acceptedRow: "受け付けるサインイン",
                admissionSection: '参加できる人',
                admissionHelp: 'このチームのメンバーになる方法です。',
                admissionInviteOnly: "招待で参加",
                admissionProvisioned: "ディレクトリから",
                admissionJit: "初回サインイン時",
                admissionSegment: { inviteOnly: "招待", provisioned: "ディレクトリ", jit: "初回サインイン" },
                admissionInviteOnlyDescription: "誰かが招待したときだけ参加できます。",
                admissionProvisionedDescription: "ディレクトリに追加された人がメンバーになります。",
                admissionJitDescription: "チームの接続で初めてサインインしたときにメンバーになります。",
                admissionUnavailable: 'この Home はまだその参加方法を適用できないため、何も変更されていません。',
                admissionUnavailableReason: {
                    homePolicyUnavailable: "Home管理者がこのプロバイダーを有効にする必要があります。",
                    homePolicyProhibited: "このHomeではこの方式は許可されていません。",
                    directorySourceRequired: "先にディレクトリを追加してください。",
                    directoryProjectionRequired: "初回同期の完了後に利用できます。",
                    teamConnectionRequired: "先にチームのサインイン接続を追加してください。",
                    teamConnectionUnavailable: "利用可能なチームのサインイン接続がありません。",
                },
                acceptedSection: 'メンバーのサインイン方法',
                acceptedHelp: 'チームの操作を許可する前に、このチームが受け入れるサインインです。',
                acceptedInherit: 'Home のポリシーを使う',
                acceptedRestricted: "これらのみ",
                acceptedInheritConsequence: ({ home }: { home: string }) => `メンバーは ${home} が許可する任意の方法でサインインします。`,
                acceptedRestrictedConsequence: "メンバーは下でチェックしたサインイン方法のいずれかを使う必要があります。",
                connectionsSection: '許可する接続',
                connectionsEmpty: 'サインイン接続を 1 つ以上選ぶか、Home のポリシーを使ってください。',
                homeMethodRetained: '保存済みポリシーから引き継ぎ',
                repairRequired: '保存されたサインイン制限を読み取れません',
                repairRequiredHelp: '記載どおりには適用されていません。下でポリシーを選んで置き換えてください。',
                conflictBody: 'この Home のサインインポリシーが変更されました。内容を確認してから、もう一度適用してください。',
                providerTestRequired: 'チームがこの接続を必須にする前に、接続をテストしてください。',
                authenticationRequired: "このチームのサインイン条件を厳しくする前に、必須にする予定の方法でサインインしてください。",
                unavailable: 'この Home はそのサインインポリシーを受け入れられません。',
                approvalPending: '承認待ち',
                connectionOwnerTeam: "チームの接続",
                connectionOwnerHome: "Home のサインイン方法",
            },
            subtitle: 'チームメンバーが本人確認に使う方法です。',
            memberSignIn: {
                section: 'メンバー用サインインページ',
                open: "プレビュー",
                copyLink: 'リンクをコピー',
                shareLink: 'リンクを共有',
                qrLabel: 'メンバー用サインインリンクの QR コード',
                qrAction: "QR コード",
                footer: 'このリンクを持つ人は誰でもこのチームのサインインページに到達します。リンク自体は何も付与しません。参加は引き続きチームの参加ポリシーに従います。',
                unavailable: '共有できるリンクはありません',
                unavailableBody: 'この Home はウェブアドレスを公開していないため、他の端末で機能するリンクはありません。Home の管理者が設定できます。',
            },
            connectionsSection: 'サインイン接続',
            homeMethodsUnavailable: 'このHomeのサインイン方法を読み込めませんでした。',
            connectionsDescription: 'このチームが使える会社のサインイン。',
            add: {
                fixTurnOn: "オンにする",
                action: '接続を追加',
                askNamed: ({ names }: { names: string }) => `${names}に依頼してください。`,
                askUnnamed: 'Homeのオーナーに依頼してください。',
                fixInSignInProviders: '設定する',
                fixInReach: '到達性で設定する',
                reason: {
                    contactHomeAdmin: ({ home }: { home: string }) => `${home}がチーム向けに設定します。`,
                    workosPlatform: ({ home }: { home: string }) => `${home}ではWorkOSがまだ設定されていません。`,
                    providerDisabled: ({ home }: { home: string }) => `${home}から提供。そちらでオフになっています。`,
                    homeProhibited: ({ home, provider }: { home: string; provider: string }) => `${home}ではチームが${provider}を追加できません。`,
                    homeUnavailable: ({ home }: { home: string }) => `${home}はこれをチームに提供していません。`,
                    publicAddress: ({ home }: { home: string }) => `プロバイダーが人を戻すには${home}の公開アドレスが必要です。`,
                },
            },
            empty: 'サインイン接続はありません',
            status: {
                unavailable: '利用できません',
                prohibited: 'Home のポリシーによりブロックされています',
                notConfigured: '未設定',
                settingUp: '設定中',
                needsAttention: '対応が必要です',
            },
            mode: {
                signInOnly: 'サインインのみ',
                signInTimeGroups: 'サインイン時にグループを更新',
            },
            detail: {
                status: '状態',
                mode: 'モード',
                provider: 'プロバイダー',
                restrictions: 'サインイン制限',
                allowedUsers: '許可されたユーザー',
                allowedDomains: '許可されたメールドメイン',
                none: 'なし',
                configuration: '設定',
                organization: '組織',
                connection: '接続',
            },
            directory: {
                actions: {
                    section: 'Działania', sync: 'Synchronizuj teraz', pause: 'Wstrzymaj synchronizację', resume: 'Wznów synchronizację', remove: 'Usuń katalog…',
                    pauseTitle: ({ source }: { source: string }) => `Wstrzymać ${source}?`, pauseBody: 'Nowe zmiany katalogu zostaną zatrzymane. Znany dostęp Teamu i wkład Grup pozostaną do czasu wznowienia.',
                    removeTitle: ({ source }: { source: string }) => `Usunąć ${source}?`, removeMembers: ({ count }: { count: number }) => `このディレクトリ経由で参加した ${count} 人がチームから外れます。`, removeGroupMemberships: ({ count }: { count: number }) => `これが設定した ${count} 件のグループメンバーシップが削除されます。`, removeNothing: "これに依存するメンバーシップはありません。", removeKept: "アカウント、これが作成したグループ、別の方法で追加された人は保持されます。",
                },
                section: "ディレクトリ",
                overviewSubtitle: "ディレクトリソースは、チームのメンバーとグループを外部組織と同期します。",
                manageSubtitle: "接続済みのディレクトリソースと最新の同期状態を確認します。",
                title: "ディレクトリ同期",
                sourcesSection: "ディレクトリソース",
                sourcesLoadMore: "さらにソースを読み込む",
                subtitle: "ディレクトリの変更は同期のたびにここに表示されます。",
                purpose: "このチームのメンバーとグループを会社のディレクトリに合わせます。",
                sourcePurpose: "このディレクトリがチームに合わせて保つメンバーとグループです。",
                empty: "ディレクトリソースはありません",
                emptyBody: "会社のディレクトリを接続すると、チームがそれに従います。参加した人はチームに加わり、離れた人はアクセスを失います。",
                setup: {
                    add: "ソースを追加",
                    options: "ディレクトリソースを選択",
                    optionsFooter: "最初の同期が終わるまで何も変わりません。",
                    loadMore: "Wczytaj więcej",
                    empty: "確認済みのソースはまだありません",
                    workos: "WorkOS Directory Sync を設定",
                    workosSubtitle: "WorkOS 管理ポータルを開き、戻って確認済みのディレクトリを選択してください。",
                    confirmTitle: ({ source }: { source: string }) => `Add ${source}?`,
                    confirmBody: "追加後、Happier がこのディレクトリのインポートを開始します。",
                },
                people: {
                    section: "ユーザー",
                    empty: "プロビジョニングされたユーザーはいません",
                    provisioned: "アカウント未作成",
                    boundAccountCount: ({ count }: { count: number | string }) => `紐付け済みアカウント: ${count}`,
                    unboundPeopleCount: ({ count }: { count: number | string }) => `アカウント未作成のプロビジョニング済みユーザー: ${count}`,
                    member: "チームメンバー",
                    unknown: "名前なしのユーザー",
                    loadMore: "さらに読み込む",
                    state: {
                        suspended: "停止中",
                        deleted: "削除済み",
                    },
                },
                kind: {
                    workos: "WorkOS ディレクトリ同期",
                    github: "GitHub 組織",
                },
                state: {
                    setup: "設定が必要",
                    syncing: "同期中",
                    active: "有効",
                    paused: "一時停止",
                    needsAttention: "要確認",
                    initializing: "セットアップ中",
                    failed: "前回の同期に失敗",
                },
                mode: {
                    eventsAndFull: "イベントと完全な照合",
                    fullOnly: "完全な照合のみ",
                },
                freshness: {
                    never_synced: "未同期",
                    fresh: "最新",
                    stale: "古い",
                    unknown: "不明",
                },
                detail: {
                    status: "状態",
                    sourceType: "ソースの種類",
                    syncSection: "同期状態",
                    mode: "同期モード",
                    freshness: "鮮度",
                    lastSuccess: "最後に成功した同期",
                    nextScheduled: "次回の同期予定",
                    attentionSection: "確認が必要",
                    attentionTitle: "このディレクトリソースを確認してください",
                    attentionRetryable: "チームは現在のメンバーを維持します。次回の同期で再試行されます。今すぐ再試行することもできます。",
                    attentionAdmin: "新しいディレクトリ変更を利用する前に、ソース設定を確認してください。",
                },
                never: "なし",
                unknown: "不明",
            },
        },
        settings: {
            archiveDescription: 'アーカイブするとチームはアクティブな表示から外れ、チームベースのアクセスが停止します。メンバー、グループ、履歴は保持され、復元できます。',
            logoSection: 'ロゴ',
            sessionDefaultsSection: "新しいセッション",
            sharingSection: '共有',
            sharingDescription: '今後に適用されます。すでに共有したものは変わりません。',
            option: {
                private: '非公開',
                shared: '共有',
                alwaysShared: '常に共有',
                anyone: '全員',
                admins: '管理者',
                nobody: 'なし',
                fromJoining: '参加以降',
                earlierToo: '以前も',
            },
            consequence: {
                sessionsPrivate: ({ team }: { team: string }) => `非公開で始まり、各自が${team}と共有するものを選びます。`,
                sessionsShared: ({ team }: { team: string }) => `${team}と共有して始まり、各自が非公開にできます。`,
                sessionsAlwaysShared: ({ team }: { team: string }) => `新しいセッションはすべて${team}と共有されます。`,
                outsideAnyone: ({ team }: { team: string }) => `セッションを共有できる人は${team}の外にも共有できます。`,
                outsideAdmins: ({ team }: { team: string }) => `${team}の管理者だけが外部に共有できます。`,
                outsideNobody: ({ team }: { team: string }) => `セッションを${team}の外に共有することはできません。`,
                historyFromJoining: ({ team }: { team: string }) => `参加した時点から${team}と共有されたセッション。`,
                historyEarlier: ({ team }: { team: string }) => `参加前に${team}と共有されたセッションも。`,
            },
            externalSharingSection: "チーム外への共有",
            sharingOutsideTeam: ({ team }: { team: string }) => `${team}外への共有`,
            historyDefaultSection: "新しいメンバーに見せる範囲",
            saved: '保存しました',
        },
        policy: {
            sessionCreationPrivate: '既定でプライベート',
            sessionCreationTeam: '既定でチームと共有',
            sessionCreationRequired: '常にチームと共有',
            sessionCreationHelp: 'これは新しいセッションに適用されます。既存のプライベートセッションは公開されません。',
            externalSharingAllowed: '共有できる人すべて',
            externalSharingAdmins: 'チーム管理者のみ',
            externalSharingDisabled: '許可しない',
            externalSharingHelp: '今後の共有を制限できます。すでに共有された複製は取り消されません。',
            historyDefaultHelp: '新しいメンバーの選択肢を事前選択します。既存メンバーの履歴は書き換えません。',
        },
        logo: {
            add: 'ロゴを追加',
            replace: 'ロゴを差し替え',
            remove: 'ロゴを削除',
            removeConfirmTitle: 'このロゴを削除しますか？',
            removeConfirmBody: 'チームは再びモノグラムを表示します。新しいロゴはいつでもアップロードできます。',
            previewLabel: 'ロゴのプレビュー',
            useAsLogo: 'ロゴとして使用',
            monogramLabel: 'ロゴを追加するまではモノグラムを表示します。',
            tooLarge: 'この画像は大きすぎます。より小さいものを選んでください。',
            invalidFormat: ({ formats }: { formats: string }) => `このファイルは対応していない画像です。対応形式: ${formats}。`,
            failed: 'ロゴはアップロードされませんでした。現在のロゴは変わりません。',
            retry: '再試行',
        },
        archive: {
            confirmShort: 'アーカイブ',
            archivedTitle: ({ name }: { name: string }) => `${name}はアーカイブ済みです`,
            archivedBody: "チームへのアクセスは停止しており、ここでは何も変更できません。メンバー、グループ、履歴は保持されます。",
            confirm: {
                keptCounted: ({ members, groups }: { members: number; groups: number }) => `メンバー ${members} 人、グループ ${groups} 個とその履歴は保持されます。`,
                kept: "メンバー、グループとその履歴は保持されます。",
                invitationsStop: ({ count }: { count: number }) => `承認待ちの招待リンク ${count} 件は使えなくなり、復元後も戻りません。`,
                restore: "いつでも復元できます。保持されたアクセスは、まだ有効な範囲で戻ります。",
            },
            openSettings: '設定を開く',
            action: ({ name }: { name: string }) => `${name} をアーカイブ`,
            confirmTitle: ({ name }: { name: string }) => `${name} をアーカイブしますか？`,
            restoreTitle: ({ name }: { name: string }) => `${name} を復元しますか？`,
            restoreBody: () => '現在のメンバーシップ、グループ、保持された権限は、アカウントとリソースが引き続き許可する範囲で再び有効になります。失効した招待リンクは戻りません。',
            readOnly: 'このチームはアーカイブ済みです。変更するには復元してください。',
        },
        members: {
            roleReadOnly: ({ team }: { team: string }) => `ロールを変更できるのは、${team}のオーナーと管理者だけです。`,
            roleSetBy: ({ source }: { source: string }) => `${source}によって設定されています。`,
            accessSection: "アクセス",
            lifecycleFootnote: "一時停止すると、再開するまでアクセスが止まります。削除するとアクセスは終了します。書いた内容は残り、再参加すると新しいメンバーシップになります。",
            lifecycleFootnoteSuspended: "再開するとアクセスが戻ります。削除するとアクセスは終了します。書いた内容は残り、再参加すると新しいメンバーシップになります。",
            removal: {
                title: ({ name, team }: { name: string; team: string }) => `${name}を${team}から削除しますか？`,
                action: ({ team }: { team: string }) => `${team}から削除…`,
                ends: "チームとグループへのアクセスはすぐに終了します。",
                leavesGroups: ({ groups }: { groups: string }) => `${groups}から外れます。`,
                leavesGroupsAndMore: ({ groups }: { groups: string }) => `${groups}と、そのほかのグループから外れます。`,
                kept: "書いたセッションとメッセージはそのまま残ります。",
            },
            filterLabel: '表示',
            searchPlaceholder: 'メンバーを検索',
            filterAll: 'すべて',
            filterOwnersAndAdmins: 'オーナーと管理者',
            addMenu: {
                existing: 'このHomeの人を追加',
                existingBody: ({ home }: { home: string }) => `${home}にすでにアカウントがある人から選びます。`,
                invite: 'リンクまたはメールで招待',
                inviteBody: ({ team }: { team: string }) => `それ以外の人向け。承諾すると${team}に参加します。`,
            },
            filterMembers: 'メンバー',
            filterGuests: 'ゲスト',
            filterSuspended: '停止中',
            emptyTitle: '該当するメンバーがいません',
            emptyBody: 'フィルターを調整するか、このチームに誰かを招待してください。',
            add: 'メンバーを追加',
            addTitle: ({ team }: { team: string }) => `${team} に追加`,
            personLabel: '人',
            roleLabel: '役割',
            personPlaceholder: 'この Home の人を検索',
            ineligible: 'すでにこのチームのメンバーか、この Home の有効なアカウントではありません。',
            addSubmit: 'メンバーを追加',
            you: 'あなた',
            joined: ({ when }: { when: string }) => `${when} に参加`,
            managedBy: ({ source }: { source: string }) => `${source} 経由で管理`,
            managedReadOnly: 'このメンバーシップは連携元で管理されています。そちらで変更してください。',
            detailManagedBy: '管理元',
            managementTitle: '管理元',
            managementHelp: '管理元を変えても、このメンバーシップ、ロール、状態、セッション履歴はそのままです。変更できる相手だけが移ります。',
            managementNative: 'Happier で管理',
            managementConflict: 'この管理元には、この人に結び付けられる未使用の ID がまだありません。同期してからもう一度お試しください。',
            encryption: {
                title: '暗号化されたアクセス',
                checking: '暗号化されたアクセスを確認中…',
                ready: '準備済み',
                scopeBody: "セッションを管理している他のメンバーは、それぞれの準備がまだ必要な場合があります。",
                rowTitle: "あなたが管理するセッション",
                pending: '準備が必要',
                prepare: '暗号化されたアクセスを準備',
                preparing: ({ prepared }: { prepared: number }) => `暗号化されたアクセスを準備中 · ${prepared} 件完了`,
                setupRequired: 'セットアップが必要',
                setupRequiredBody: 'この人は暗号化アクセスのセットアップを完了していません。完了後にセッション履歴を準備できます。',
                notEncrypted: '暗号化なし',
                plainAccount: 'この人のアカウントはエンドツーエンド暗号化を使用していないため、準備するものはありません。',
                repairRequired: '暗号化アクセスの修復が必要です',
                repairBody: 'あなたが管理する一部のセッションはこのデバイスから準備できません。それらを開いてご自身のアクセスを修復してください。',
                nonTransferableBody: '一部のセッションは以前の暗号化形式を使用しており、新しいメンバーと共有できません。既にアクセスできる人は引き続き読めます。',
                recipientChanged: 'この人のアカウントが変わりました。もう一度準備する前に再読み込みします。',
                retry: '再試行',
                failed: '準備は完了前に停止しました。すでに準備された分は保持されています。',
            },
            detailGroups: 'グループ',
            detailGroupsEmpty: "まだどのグループにも属していません",
            suspend: 'メンバーを停止',
            suspendShort: '停止',
            suspendTitle: ({ name }: { name: string }) => `${name} を停止しますか？`,
            suspendBody: "再開するまで、チームとそのグループへのアクセスは停止します。グループはそのまま残り、Home アカウントと他のチームには影響しません。",
            reactivate: 'メンバーを再開',
            reactivateTitle: ({ name }: { name: string }) => `${name} を再開しますか？`,
            reactivateBody: 'メンバーシップ、グループ、アカウントの状態が引き続き許可する範囲でアクセスが再開されます。',
            remove: 'チームから削除',
            lastOwnerBlocked: 'チームには有効なオーナーが少なくとも 1 人必要です。先に別のオーナーを選んでください。',
            accountInactive: 'この人のアカウントは有効ではないため、追加することもオーナーにすることもできません。',
            ownerOnlyAction: 'オーナーを変更できるのはチームのオーナーだけです。',
            ownerRequiredTitle: 'オーナーが必要です',
            ownerRequiredBody: ({ team }: { team: string }) => `${team} には、オーナー専用の変更を行うために有効なオーナーが必要です。`,
            chooseOwner: 'オーナーを選ぶ',
            ownerRequiredNoCandidate: '対象となるメンバーがいません。既存メンバーを追加するか、オーナーの引き継ぎが必要です。',
        },
        groups: {
            detailsSection: 'グループ',
            title: 'グループ',
            emptyTitle: 'グループがまだありません',
            emptyBody: 'グループは、まとめて共有できるチームメンバーのフラットな集合です。',
            emptyRosterTitle: 'このグループにはまだメンバーがいません',
            noEligibleCandidatesTitle: '追加できる人がいません',
            noEligibleCandidatesBody: 'このグループにまだ参加していないチームメンバーがここに表示されます。',
            create: '新しいグループ',
            nameLabel: '名前',
            namePlaceholder: '開発',
            descriptionPlaceholder: 'このグループの用途',
            submit: 'グループを作成',
            nameTaken: 'このチームには、その名前のグループがすでにあります。',
            memberCount: ({ count }: { count: number }) => `${count}${count === 1 ? "人のメンバー" : "人のメンバー"}`,
            managedBy: ({ source }: { source: string }) => `${source} が管理`,
            membersSection: 'グループのメンバー',
            addMember: 'グループに追加',
            removeNative: 'グループから削除',
            removeMemberTitle: ({ name, group }: { name: string; group: string }) => `${name} を ${group} から削除しますか？`,
            removeMemberBody: ({ name, group }: { name: string; group: string }) => `${name} は ${group} による権限をただちに失います。チームには残るので、あとでこのグループに追加し直せます。`,
            externalOnlyTitle: '連携元で管理',
            externalOnlyBody: ({ source }: { source: string }) => `${source} がこの人を提供し続けているため、グループに残ります。その連携元の設定で変更してください。`,
            archiveAction: ({ name }: { name: string }) => `${name} をアーカイブ`,
            archiveTitle: ({ name }: { name: string }) => `${name} をアーカイブしますか？`,
            archiveBody: 'グループに基づくアクセスがただちに停止します。所属と履歴は保持され、グループを復元すると権限が再び有効になる場合があります。',
            restoreAction: ({ name }: { name: string }) => `${name} を復元`,
            archivedSection: 'アーカイブ済みのグループ',
            archivedReadOnly: 'このグループはアーカイブ済みです。変更するには復元してください。',
            managedReadOnly: 'このグループの名前とライフサイクルは連携元で管理されています。メンバーはここでも追加できます。',
        },
        invitations: {
            inviteAnother: "別の人を招待",
            waitingSection: "承認待ち",
            finishedSection: "完了",
            sendAgain: "再送信",
            emptyTitle: '招待はありません',
            emptyBody: 'リンクで誰かを招待するか、この Home にすでにアカウントがある人を追加してください。',
            invite: '招待',
            inviteTitle: ({ team }: { team: string }) => `${team} に招待`,
            byLink: 'リンク',
            linkTitle: ({ role }: { role: string }) => `リンク：${role}`,
            byEmail: 'メール',
            sendAs: '送信方法',
            readyTitle: '招待の準備ができました',
            waitingDescription: 'リンクは作成時に一度だけ表示されます。もう一度共有するには、新しいリンクを作成してください。',
            emailLabel: 'メールアドレス',
            emailPlaceholder: 'name@example.com',
            create: '招待を作成',
            linkNotice: ({ team, role }: { team: string; role: string }) => `この Home にサインインしていて、このリンクを持つ人は誰でも ${role} として ${team} に参加できます。`,
            copyLink: 'リンクをコピー',
            copied: 'リンクをコピーしました',
            qrLabel: 'この招待リンクの QR コード',
            qrTooLargeFallback: 'このリンクは QR コードには長すぎます。代わりにコピーしてください。',
            linkRow: '招待リンク',
            maskedRecipient: ({ email }: { email: string }) => `${email} 宛て`,
            expires: ({ when }: { when: string }) => `${when} に期限切れ`,
            stateActive: '有効',
            stateAccepted: '承諾済み',
            stateRevoked: '取り消し済み',
            stateExpired: '期限切れ',
            deliverySent: 'メールを送信しました',
            deliveryFailed: 'メールの送信に失敗しました',
            deliveryUnknown: '送信結果は不明です',
            deliveryRetry: '再試行',
            deliveryChangeEmail: 'メールを変更',
            emailUnavailable: 'この Home ではメール送信を利用できません。代わりにリンクを共有してください。',
            emailSetUpOwner: 'Home のメールページで設定できます。',
            reissue: '新しいリンクを作成',
            reissueNotice: '再発行すると新しいリンクが作られます。以前のリンクは使えなくなります。',
            revoke: '招待を取り消す',
            revokeTitle: 'この招待を取り消しますか？',
            revokeBody: 'リンクはただちに使えなくなります。新しいものはいつでも作成できます。',
            shareLink: 'リンクを共有',
            shareUnavailable: 'この端末では共有を利用できません。代わりにリンクをコピーしてください。',
            bearerUnavailable: 'このリンクは一度だけ表示され、保存されません。アクセスを再共有するには新しいリンクを作成してください。',
            linkUnavailableRow: '共有できるリンクはありません',
            linkUnavailableBody: 'この Home は招待リンクの宛先となるアドレスを公開していないため、共有できるリンクがありません。Home の管理者に公開を依頼するか、チームのメンバー一覧から直接追加してください。',
        },
        join: {
            previewLoading: 'この招待を確認しています…',
            joinAction: ({ team }: { team: string }) => `${team} に参加`,
            joinWithCurrentAccount: 'このアカウントで参加',
            addInvitedAddressNotice: ({ email }: { email: string }) => `${email} が確認済みアドレスとしてこのアカウントに追加されます。`,
            useAnotherAccount: '別のアカウントを使用',
            useCurrentAccount: '現在のアカウントを使用',
            useAnotherAccountHint: 'このアカウントからサインアウトせずに、この Home にサインインします。',
            hostedOn: ({ home }: { home: string }) => `${home} でホスト`,
            personalHomeNotice: 'この Home は個人のコンピューター上で動作しており、オフラインの間は利用できないことがあります。',
            plainStorageNotice: 'この Home のセッションはエンドツーエンド暗号化なしで保存されます。',
            invitedBy: ({ name }: { name: string }) => `${name} さんからの招待です。`,
            roleOffered: ({ role }: { role: string }) => `${role} として招待されています。`,
            historyFromJoining: '参加後に共有されたセッションのみ表示されます。',
            historyAllExisting: 'すでにチームに共有されているセッションも表示されます。',
            expiresOn: ({ when }: { when: string }) => `${when} に期限切れ。`,
            sentTo: ({ email }: { email: string }) => `${email} 宛てに送信されました。`,
            guestNotice: ({ team }: { team: string }) => `ゲストとして参加しても ${team} のチームセッションへのアクセス権は得られません。項目はあなた、またはあなたのグループに共有される必要があります。`,
            joinedTitle: '参加しました',
            joinedTeamTitle: ({ team }: { team: string }) => `${team} に参加しました`,
            nameStepReason: 'このチームのメンバーにどう表示されるか',
            nameAccountSwitched: ({ account }: { account: string }) => `別のアカウントに切り替わっています。この名前を保存するには、${account} に戻してください。`,
            nameAccountSwitchedUnnamed: '別のアカウントに切り替わっています。この名前を保存するには、参加したアカウントに戻してください。',
            alreadyMemberTitle: 'すでにメンバーです',
            openTeam: ({ team }: { team: string }) => `${team} を開く`,
            expiredTitle: 'この招待は期限切れです',
            revokedTitle: 'この招待は取り消されました',
            usedTitle: 'この招待はすでに使用されています',
            archivedTitle: 'このチームはアーカイブ済みです',
            inactiveTitle: 'このアカウントは現在参加できません',
            invalidTitle: 'この招待リンクは無効です',
            unresolvedHomeTitle: 'このリンクは Home を特定できません',
            unresolvedHomeBody: 'この端末では、どの Home がこの招待を発行したか判別できないため、どこにも送信していません。チーム管理者に新しいリンクを依頼してください。',
            unknownHomeTitle: 'この Home はまだこの端末に追加されていません',
            askForNew: 'チームの管理者に新しい招待を依頼してください。',
            mismatchTitle: 'この招待は別のアドレス宛てです',
            signInWithInvited: '招待されたアドレスでサインイン',
            verifyAddress: 'このアドレスを確認',
            updateRequiredTitle: 'チーム招待を使うには、この Home の更新が必要です',
            offlineTitle: 'この Home に接続できません',
            offlineBody: '招待は保持されています。Home が復帰したら再試行してください。',
            acceptanceOutcomeUnknown: '参加できたか確認できませんでした。同じ招待を確認するには、もう一度お試しください。',
            retry: '再試行',
        },
        credentials: {
            recovery: {
                openSettings: '\u8a8d\u8a3c\u60c5\u5831\u306e\u8a2d\u5b9a\u3092\u958b\u304f',
                selectBroker: '\u30d6\u30ed\u30fc\u30ab\u30fc\u306e\u5834\u6240\u3092\u9078\u3076',
                ownerHandoff: '\u30bd\u30fc\u30b9\u306e\u6240\u6709\u8005\u306b\u3053\u306e\u8a8d\u8a3c\u60c5\u5831\u306e\u4fee\u5fa9\u3092\u4f9d\u983c\u3057\u3066\u304f\u3060\u3055\u3044',
                updateApp: 'Happier \u3092\u66f4\u65b0',
                chooseAnother: '\u5225\u306e\u8a8d\u8a3c\u60c5\u5831\u3092\u9078\u3076',
            },
            requestPolicy: {
                title: 'リクエストポリシー',
                subtitle: 'この認証情報に何を依頼できるかを制限します。',
                summaryNone: '制限なし',
                summaryActive: ({ count }: { count: number }) => `${count}${count === 1 ? "件の制限" : "件の制限"}`,
                protocolsLabel: 'リクエスト形式',
                protocolsAny: 'ソースが対応するすべて',
                modelsLabel: 'モデル',
                modelsAny: 'ソースが提供するすべてのモデル',
                modelsAllowed: ({ count }: { count: number }) => `${count} 件を許可`,
                effortLabel: '推論の深さ',
                effortAny: 'ソースが対応するすべて',
                catalogUnavailable: 'どのモデルを許可するかの選択は、この Home からはまだできません。現在の選択は削除するまで有効です。',
                clear: 'すべての制限を解除',
                activeNote: 'すでに実行中のセッションは書き換えられません。次のリクエストから新しいポリシーを満たす必要があります。',
                protocol: {
                    openaiResponses: 'OpenAI Responses',
                    openaiChatCompletions: 'OpenAI Chat Completions',
                    anthropicMessages: 'Anthropic Messages',
                },
            },
            directReadiness: {
                title: '直接アクセスの準備状況',
                check: '準備状況を確認',
                summary: ({ ready, pending }: { ready: number; pending: number }) => `準備完了 ${ready} 件 · 準備中 ${pending} 件`,
                allReady: '直接アクセスを持つ全員の準備が整っています。',
                automatic: '資材はこのソースを保持するマシンがオンラインになり次第、そこで準備されます。',
                state: {
                    ready: '準備完了',
                    preparing: 'アクセスを準備中',
                    notDelivered: 'まだ配信されていません',
                    recipientBindingChanged: '暗号化アカウントの設定待ち',
                    sourceChanged: 'ソースが変更されました — 更新中',
                },
            },
            externalApi: {
                title: '外部 API アクセス',
                subtitle: 'Happier の外にある対応ツールからこのプロバイダーを使います。',
                privateTitle: 'Happier のセッション',
                privateDetail: 'Happier 経由でプライベート',
                unavailable: 'この Home では外部 API アクセスを利用できません。',
                publicHttpsRequired: '外部ツールには、この Home の公開 HTTPS アドレスが必要です。',
                homeDisclosure: 'プロバイダーへの未加工のリクエスト本文は、この Home の公開 HTTPS エンドポイントを通過し、Home の運用者が内容を読むことができます。',
                bearerDisclosure: 'このキーは Bearer シークレットです。キーを持つ人は、有効期限が切れるか取り消されるまで、割り当てられたアクセスを利用できます。',
                usageDisclosure: 'Happier はリクエスト数を記録します。プロトコルが報告できない場合、トークン数とコストの合計は不完全なことがあります。',
                keysTitle: 'API キー',
                authorize: 'キーを承認',
                authenticationRequired: '割り当てられたメンバーがチームへのサインインでこのキーを承認する必要があります。',
                authenticationUnavailable: 'チーム認証を利用できません。チーム管理者にサインインポリシーの確認を依頼してください。',
                keysLoadFailed: 'API キーを読み込めませんでした。',
                keysRetry: 'API キーをもう一度読み込む',
                keysEmpty: 'キーはまだありません',
                keysEmptyBody: '最初のキーを作成すると外部アクセスが有効になり、最後のキーを取り消すと無効になります。',
                labelPlaceholder: 'このキーの用途',
                assignLabel: '利用の帰属先',
                revealTitle: 'このキーを今すぐ保存してください',
                revealBody: '再表示はされません。',
                revealDismiss: {
                    title: 'キーをコピーせずに閉じますか？',
                    body: 'このキーは再表示できません。保存するまで表示したままにしてください。',
                    confirm: 'キーを保存しました',
                    keepVisible: 'キーを表示したままにする',
                },
                neverUsed: '未使用',
                lastUsed: ({ when }: { when: string }) => `最終使用 ${when}`,
                expiresOn: ({ when }: { when: string }) => `有効期限 ${when}`,
                expired: '期限切れ',
                revokeTitle: ({ name }: { name: string }) => `${name} を取り消しますか？`,
                revokeBody: 'このキーを使っているツールはすぐに動作しなくなります。Happier のセッションには影響しません。',
                revokeAll: 'すべてのキーを取り消す',
                revokeAllBody: '新しいキーを作成するまで外部 API アクセスは無効になります。Happier のセッションには影響しません。',
            },
            title: '\u5171\u6709\u8a8d\u8a3c\u60c5\u5831',
            subtitle: '\u63a5\u7d9a\u30a2\u30ab\u30a6\u30f3\u30c8\u3001\u30d7\u30fc\u30eb\u3001\u30d7\u30ed\u30d0\u30a4\u30c0\u30fc\u3092\u3001\u5404\u30e1\u30f3\u30d0\u30fc\u306e\u8a2d\u5b9a\u306b\u30b3\u30d4\u30fc\u305b\u305a\u306b\u30c1\u30fc\u30e0\u3067\u4f7f\u3048\u308b\u3088\u3046\u306b\u3057\u307e\u3059\u3002',
            emptyTitle: '\u5171\u6709\u8a8d\u8a3c\u60c5\u5831\u306f\u307e\u3060\u3042\u308a\u307e\u305b\u3093',
            filterTitle: "表示",
            forbidden: '\u5171\u6709\u8a8d\u8a3c\u60c5\u5831\u306f\u3053\u306e\u30c1\u30fc\u30e0\u306e\u30aa\u30fc\u30ca\u30fc\u3068\u7ba1\u7406\u8005\u304c\u7ba1\u7406\u3057\u307e\u3059\u3002',
            unavailable: '\u3053\u306e Home \u306f\u5171\u6709\u8a8d\u8a3c\u60c5\u5831\u3092\u63d0\u4f9b\u3057\u3066\u3044\u307e\u305b\u3093\u3002',
            approvalPending: '承認待ちです。決定されるまで変更は保持されます。',
            approvalDeclined: 'このリクエストは承認されなかったため、何も変更されていません。',
            sessionDeniedTitle: '共有認証情報がこのリクエストを拒否しました',
            sharedByYou: '\u3042\u306a\u305f\u304c\u5171\u6709',
            providedByTeams: '\u30c1\u30fc\u30e0\u304b\u3089\u63d0\u4f9b',
            sharedWithYou: '\u3042\u306a\u305f\u3068\u5171\u6709',
            sourceAdministration: { title: '\u30c1\u30fc\u30e0\u3068\u5171\u6709' },
            source: {
                connectedAccount: '\u63a5\u7d9a\u30a2\u30ab\u30a6\u30f3\u30c8',
                pool: '\u63a5\u7d9a\u30b5\u30fc\u30d3\u30b9\u30d7\u30fc\u30eb',
                providerConnection: '\u30d7\u30ed\u30d0\u30a4\u30c0\u30fc\u63a5\u7d9a',
            },
            delivery: {
                brokered: '\u30d6\u30ed\u30fc\u30ab\u30fc\u7d4c\u7531',
                direct: '\u76f4\u63a5\u30a2\u30af\u30bb\u30b9',
                both: '\u30d6\u30ed\u30fc\u30ab\u30fc\uff0b\u76f4\u63a5',
                mixed: '\u6df7\u5728\u3057\u305f\u914d\u4fe1',
            },
            state: {
                available: '\u5229\u7528\u53ef\u80fd',
                needsAttention: '\u8981\u5bfe\u5fdc',
                disabled: '\u7121\u52b9',
            },
            usePolicy: {
                title: 'このセッションをチームと共有しますか？',
                label: '\u30e1\u30f3\u30d0\u30fc\u304c\u4f7f\u3048\u308b\u5834\u6240',
                personalAllowed: '\u8a31\u53ef\u3055\u308c\u305f\u3059\u3079\u3066\u306e\u30bb\u30c3\u30b7\u30e7\u30f3',
                teamContextRequired: '\u3053\u306e\u30c1\u30fc\u30e0\u306b\u5c5e\u3059\u308b\u30bb\u30c3\u30b7\u30e7\u30f3',
                teamVisibilityRequired: '\u3053\u306e\u30c1\u30fc\u30e0\u304c\u898b\u3089\u308c\u308b\u30bb\u30c3\u30b7\u30e7\u30f3',
                visibilityNote: '\u3053\u306e\u8a8d\u8a3c\u60c5\u5831\u3092\u9078\u3076\u3068\u3001\u672c\u4eba\u306e\u78ba\u8a8d\u5f8c\u306b\u30d7\u30e9\u30a4\u30d9\u30fc\u30c8\u306a\u30bb\u30c3\u30b7\u30e7\u30f3\u304c\u30c1\u30fc\u30e0\u3068\u5171\u6709\u3055\u308c\u308b\u3053\u3068\u304c\u3042\u308a\u307e\u3059\u3002',
            },
            selection: {
                activeTransitionUnsupported: 'この変更が保存される前にセッションが実行を開始したため、モデルは変更されていません。もう一度お試しください。',
            },
            detail: {
                sourceLabel: '\u30bd\u30fc\u30b9',
                brokerLabel: '\u30d6\u30ed\u30fc\u30ab\u30fc\u306e\u5834\u6240',
                brokerNone: '\u30d6\u30ed\u30fc\u30ab\u30fc\u306e\u5834\u6240\u3092\u9078\u629e',
                access: '\u30a2\u30af\u30bb\u30b9\u3068\u914d\u4fe1',
                activity: '\u30a2\u30af\u30c6\u30a3\u30d3\u30c6\u30a3',
                edit: '\u7de8\u96c6',
                notFound: '\u3053\u306e\u5171\u6709\u8a8d\u8a3c\u60c5\u5831\u306f\u5229\u7528\u3067\u304d\u307e\u305b\u3093\u3002',
                brokerUnnamedMachine: '名称未設定のマシン',
                brokerUnnamedPool: '名称未設定のプール',
                brokerChosen: 'ソースの所有者が選択',
                limits: '上限',
                usage: '使用状況',
            },
            create: {
                title: '認証情報を共有',
                action: '認証情報を共有',
                submit: '共有する認証情報を作成',
                sourceChoose: 'ソースを選択',
                sourceEmpty: 'まだ共有できるものがありません。',
                sourceUnsupported: '接続済みアカウントとプロバイダー接続は、この Home からはまだ共有できません。',
                alreadyShared: 'このチームと共有済み',
                poolAccounts: ({ count }: { count: number }) => `${count}${count === 1 ? "アカウント" : "アカウント"}`,
                notAllowed: 'このチームでは自分の認証情報を提供できません。',
                reviewLabel: '確認',
            },
            edit: {
                title: '\u5171\u6709\u8a8d\u8a3c\u60c5\u5831\u3092\u7de8\u96c6',
                nameLabel: '\u540d\u524d',
                namePlaceholder: '\u3053\u306e\u8a8d\u8a3c\u60c5\u5831\u306e\u540d\u524d',
                ceilingLabel: '\u76f4\u63a5\u958b\u793a',
                ceilingBrokeredOnly: '\u30d6\u30ed\u30fc\u30ab\u30fc\u306e\u307f',
                ceilingDirectAllowed: '\u76f4\u63a5\u30a2\u30af\u30bb\u30b9\u3092\u8a31\u53ef',
                ceilingNote: '\u76f4\u63a5\u30a2\u30af\u30bb\u30b9\u3067\u306f\u53d7\u3051\u624b\u306e\u30ed\u30fc\u30ab\u30eb\u30c4\u30fc\u30eb\u304c\u8a8d\u8a3c\u8cc7\u6599\u3092\u53d7\u3051\u53d6\u308a\u307e\u3059\u3002\u30a2\u30af\u30bb\u30b9\u3092\u5916\u3059\u3068\u4eca\u5f8c\u306e\u914d\u4fe1\u306f\u6b62\u307e\u308a\u307e\u3059\u304c\u3001\u5916\u90e8\u30d7\u30ed\u30bb\u30b9\u304c\u3059\u3067\u306b\u4f7f\u3063\u305f\u3082\u306e\u306f\u6d88\u305b\u307e\u305b\u3093\u3002',
                conflict: '\u3053\u306e\u8a2d\u5b9a\u306f\u5225\u306e\u5834\u6240\u3067\u5909\u66f4\u3055\u308c\u307e\u3057\u305f\u3002\u4fdd\u5b58\u524d\u306b\u518d\u8aad\u307f\u8fbc\u307f\u3057\u3066\u73fe\u5728\u306e\u5024\u3092\u78ba\u8a8d\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
            },
            audience: {
                title: '\u30a2\u30af\u30bb\u30b9\u3068\u914d\u4fe1',
                none: '\u307e\u3060\u8ab0\u3082\u3044\u307e\u305b\u3093',
                everyone: '\u30c1\u30fc\u30e0\u5168\u54e1',
                everyoneOff: '\u30c1\u30fc\u30e0\u5168\u4f53\u3078\u306e\u30a2\u30af\u30bb\u30b9\u306a\u3057',
                groupCount: ({ count }: { count: number }) => `${count}${count === 1 ? "グループ" : "グループ"}`,
                memberCount: ({ count }: { count: number }) => `${count}${count === 1 ? "人" : "人"}`,
                add: 'グループまたは人を追加',
                groupsSection: '\u30b0\u30eb\u30fc\u30d7',
                membersSection: '\u30e1\u30f3\u30d0\u30fc',
                remove: '\u30a2\u30af\u30bb\u30b9\u3092\u524a\u9664',
                ceilingBlocked: '\u3053\u306e\u8a8d\u8a3c\u60c5\u5831\u3067\u306f\u76f4\u63a5\u30a2\u30af\u30bb\u30b9\u304c\u8a31\u53ef\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002\u5148\u306b\u7de8\u96c6\u3067\u8a31\u53ef\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
                directTitle: '\u3053\u306e\u8a8d\u8a3c\u60c5\u5831\u3092\u76f4\u63a5\u5171\u6709\u3057\u307e\u3059\u304b\uff1f',
                directBody: '\u9078\u3093\u3060\u4eba\u306e\u30ed\u30fc\u30ab\u30eb\u30c4\u30fc\u30eb\u304c\u3053\u306e\u30bd\u30fc\u30b9\u306e\u8a8d\u8a3c\u8cc7\u6599\u3092\u53d7\u3051\u53d6\u308b\u5834\u5408\u304c\u3042\u308a\u307e\u3059\u3002\u30a2\u30af\u30bb\u30b9\u3092\u5916\u3059\u3068\u4eca\u5f8c\u306e\u914d\u4fe1\u306f\u6b62\u307e\u308a\u307e\u3059\u304c\u3001\u5916\u90e8\u30d7\u30ed\u30bb\u30b9\u304c\u3059\u3067\u306b\u4f7f\u3063\u305f\u3082\u306e\u306f\u6d88\u305b\u307e\u305b\u3093\u3002',
                directConfirm: '\u76f4\u63a5\u5171\u6709',
                keepBrokered: '\u30d6\u30ed\u30fc\u30ab\u30fc\u7d4c\u7531\u306e\u307e\u307e',
                limitsNote: '\u76f4\u63a5\u5229\u7528\u306f Happier \u306e\u5916\u3067\u884c\u308f\u308c\u3001\u8a18\u9332\u3055\u308c\u307e\u305b\u3093\u3002',
            },
            directUse: {
                title: '\u3053\u306e\u5171\u6709\u8a8d\u8a3c\u60c5\u5831\u3092\u76f4\u63a5\u4f7f\u7528\u3057\u307e\u3059\u304b\uff1f',
                body: 'Happier \u306f\u3001\u3053\u306e\u30bb\u30c3\u30b7\u30e7\u30f3\u3067\u4f7f\u7528\u3059\u308b\u30ed\u30fc\u30ab\u30eb\u30c4\u30fc\u30eb\u306b\u8a8d\u8a3c\u60c5\u5831\u3092\u63d0\u4f9b\u3059\u308b\u5834\u5408\u304c\u3042\u308a\u307e\u3059\u3002\u305d\u308c\u3089\u306e\u30c4\u30fc\u30eb\u3092\u4fe1\u983c\u3067\u304d\u308b\u5834\u5408\u306e\u307f\u7d9a\u884c\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
            },
            delete: {
                action: '\u5171\u6709\u8a8d\u8a3c\u60c5\u5831\u3092\u524a\u9664',
                title: ({ name }: { name: string }) => `${name} \u3092\u524a\u9664\u3057\u307e\u3059\u304b\uff1f`,
                body: '\u30e1\u30f3\u30d0\u30fc\u306f\u3059\u3050\u306b\u30a2\u30af\u30bb\u30b9\u3092\u5931\u3044\u3001\u6b21\u306e\u30ea\u30af\u30a8\u30b9\u30c8\u306f\u5931\u6557\u3057\u307e\u3059\u3002\u3059\u3067\u306b\u76f4\u63a5\u914d\u4fe1\u3055\u308c\u305f\u8cc7\u6599\u306f\u6d88\u305b\u307e\u305b\u3093\u3002',
            },
            errors: {
                featureDisabled: '\u3053\u306e Home \u306f\u5171\u6709\u8a8d\u8a3c\u60c5\u5831\u306b\u5bfe\u5fdc\u3057\u3066\u3044\u307e\u305b\u3093\u3002',
                teamAuthenticationRequired: '\u7d9a\u3051\u308b\u524d\u306b\u3001\u3053\u306e\u30c1\u30fc\u30e0\u306b\u30b5\u30a4\u30f3\u30a4\u30f3\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
                teamAuthenticationPolicyUnavailable: '\u3053\u306e\u30c1\u30fc\u30e0\u306e\u30b5\u30a4\u30f3\u30a4\u30f3\u30dd\u30ea\u30b7\u30fc\u3092\u8aad\u307f\u53d6\u308c\u306a\u304b\u3063\u305f\u305f\u3081\u3001\u4f55\u3082\u5909\u66f4\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002',
                memberNotEligible: '\u3053\u306e\u4eba\u306f\u3053\u306e\u8a8d\u8a3c\u60c5\u5831\u3092\u4f7f\u7528\u3067\u304d\u307e\u305b\u3093\u3002',
                sessionPolicyIncompatible: '\u3053\u306e\u8a8d\u8a3c\u60c5\u5831\u306f\u3001\u5171\u6709\u30dd\u30ea\u30b7\u30fc\u4e0a\u3053\u306e\u30bb\u30c3\u30b7\u30e7\u30f3\u3067\u306f\u4f7f\u7528\u3067\u304d\u307e\u305b\u3093\u3002',
                brokerUnavailable: 'この資格情報の仲介マシンにいま接続できません。復帰してから再試行するか、別の場所を選んでください。',
                sourceOwnerRequired: 'この変更ができるのは、ソースを所有している人だけです。',
                sourceMissing: 'この資格情報が指すソースはもう存在しません。所有者がソースを選び直す必要があります。',
                invalidAudience: 'その人やグループはこの資格情報を受け取れません。',
                subjectNotInTeam: 'その人やグループはこのチームにもういません。',
                costUnavailable: 'コスト上限には許可されたすべてのモデルの価格が必要ですが、一部にありません。代わりにリクエストかトークンで制限してください。',
                invalidLimit: '測る対象・期間・最大値を確認してください。',
                limitIdentityImmutable: '上限の対象・測る内容・期間は変更できません。削除して新しく追加してください。',
            },
            limits: {
                groupShared: '\u3053\u306e\u4e0a\u9650\u306f\u30b0\u30eb\u30fc\u30d7\u5168\u54e1\u3067\u5171\u6709\u3055\u308c\u307e\u3059\u3002',
                title: '上限',
                empty: '上限はまだありません',
                emptyBody: '追加するまで、すべてのリクエストが許可されます。',
                overshoot: '記録された使用量が上限に達すると、新しいリクエストは止まります。実行中のリクエストは終わるまで続くことがあります。',
                directNote: '上限は仲介経由の利用と外部 API の利用が対象です。直接利用は受け取る人のマシン上で起こり、記録されません。',
                directOnly: 'アクセスできる全員がこの資格情報を自分のマシンで直接使うため、Happier は何も記録できず、上限も適用できません。',
                requestLimitsOnlyForPersonalUse: 'トークン上限は、この認証情報にチームのコンテキストが必要な場合に表示されます。個人利用ではバックグラウンド実行や外部 API も使えますが、それらはリクエスト数しか報告しないため、すべての利用を対象にできるのはリクエスト上限だけです。',
                add: '上限を追加',
                subjectLabel: '適用範囲',
                subject: {
                    resource: '共有資格情報の全体',
                    eachMember: 'メンバーごとに個別',
                    group: 'グループ',
                    member: '個人',
                },
                metricLabel: '測る対象',
                metric: {
                    requests: 'リクエスト',
                    tokens: 'トークン',
                    cost: 'コスト',
                },
                costNote: 'コスト上限は、許可されたすべてのモデルに既知の価格がある場合にのみ機能します。',
                periodLabel: '期間',
                period: {
                    day: '1 日ごと',
                    week: '1 週間ごと',
                    month: '1 か月ごと',
                },
                maximumLabel: '最大値',
                maximumPlaceholder: '期間ごとの最大値',
                maximumInvalid: '0 より大きい整数を入力してください。',
                maximumInvalidCost: '0 より大きい金額を入力してください。',
                recorded: ({ recorded, maximum }: { recorded: string; maximum: string }) => `${maximum} のうち ${recorded} を記録`,
                resetsUtc: ({ when }: { when: string }) => `${when} UTC にリセット`,
                reached: '上限に到達',
                disabled: 'オフ',
                remove: '上限を削除',
                removeTitle: 'この上限を削除しますか？',
                removeBody: 'リクエストはすぐにこの上限と照合されなくなります。記録された使用量は残ります。',
                unknownSubject: 'このページの外にいる誰か',
            },
            usage: {
                title: '使用状況',
                empty: 'この期間に記録はありません。',
                rangeLabel: '期間',
                brokeredRequests: '仲介経由のリクエスト',
                directOnlyRequests: 'リクエスト数は仲介経由の利用のみ集計されます。',
                recordedRequests: '記録されたリクエスト',
                requestIncomplete: 'Happier が観測したリクエストのみが含まれます。',
                externalObservationsIncomplete: ({ count }: { count: number }) => `${count} 件の外部リクエストには、まだ記録された結果がありません。`,
                breakdownRestricted: '一部の内訳は資格情報の管理者にのみ表示されます。',
                export: 'CSV を書き出す',
                exportFailed: 'この端末では書き出しを保存できませんでした。',
                recordedByHappier: 'Happier が記録しました。',
                directIncomplete: '直接利用は Happier の外で起こるため、含まれていない場合があります。',
                costIncomplete: 'この期間、一部のモデルのコストは取得できません。',
                tokenIncomplete: 'この期間のトークン合計は不完全です。',
                tokenUnavailable: 'この期間にはトークン使用量が観測されませんでした。',
                costUnavailable: 'この期間には価格が判明している利用が観測されませんでした。',
                costUnknown: '取得できません',
                breakdownLabel: '内訳の軸',
                breakdownNone: '合計のみ',
                breakdown: {
                    member: '個人',
                    externalApiKey: '外部 API キー',
                    model: 'モデル',
                    session: 'セッション',
                    sourceMember: 'ソースのアカウント',
                    workerMachine: '実行マシン',
                    brokerMachine: '仲介マシン',
                    deliveryMode: '受け渡し方法',
                },
                limitsTitle: 'この期間の上限',
                sliceSummary: ({ requests, tokens, requestCount, tokenCount }: { requests: string; tokens: string; requestCount: number; tokenCount: number }) => `${requests} ${requestCount === 1 ? "リクエスト" : "リクエスト"} · ${tokens} ${tokenCount === 1 ? "トークン" : "トークン"}`,
            },
            activity: {
                title: '\u30a2\u30af\u30c6\u30a3\u30d3\u30c6\u30a3',
                empty: '\u7ba1\u7406\u4e0a\u306e\u5909\u66f4\u306f\u307e\u3060\u8a18\u9332\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002',
                unknownActor: '\u4e0d\u660e\u306a\u30e6\u30fc\u30b6\u30fc',
                kind: {
                    resourceCreated: '\u3053\u306e\u8a8d\u8a3c\u60c5\u5831\u3092\u5171\u6709\u3057\u307e\u3057\u305f',
                    resourceUpdated: '\u8a2d\u5b9a\u3092\u5909\u66f4\u3057\u307e\u3057\u305f',
                    audienceChanged: '\u4f7f\u3048\u308b\u4eba\u3092\u5909\u66f4\u3057\u307e\u3057\u305f',
                    resourceDeleted: '\u3053\u306e\u8a8d\u8a3c\u60c5\u5831\u3092\u524a\u9664\u3057\u307e\u3057\u305f',
                    directDelivered: '\u76f4\u63a5\u30a2\u30af\u30bb\u30b9\u3092\u914d\u4fe1\u3057\u307e\u3057\u305f',
                    externalKeyCreated: '\u5916\u90e8 API \u30ad\u30fc\u3092\u4f5c\u6210\u3057\u307e\u3057\u305f',
                    externalKeyRevoked: '\u5916\u90e8 API \u30ad\u30fc\u3092\u5931\u52b9\u3055\u305b\u307e\u3057\u305f',
                    limitsChanged: '\u4e0a\u9650\u3092\u5909\u66f4\u3057\u307e\u3057\u305f',
                },
            },
        },
    },
};

const teamsTranslations = { ja: japanese };

return { teamsTranslations };
})();

const Domain_terminalWorkspaceTranslations = (() => {
const en = Shared_terminalWorkspaceTranslations.en;

const terminalWorkspaceKeyboardTranslations = Shared_terminalWorkspaceTranslations.terminalWorkspaceKeyboardTranslations;

const terminalWorkspaceTranslations = { ja: en };

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

const ja: ThisComputerConnectionTranslation = {
    connectHome: {
        title: ({ home }: HomeParams) => `このコンピュータを${home}に接続しますか？`,
        body: ({ home }: HomeParams) => `${home}からこのコンピュータでセッションを開始できるようになります。ターミナルのHomeと他のHomeへの接続は維持されます。`,
        connect: '接続',
        keep: '現在の接続を維持',
    },
    setupAlreadyRunning: 'セットアップが実行中です。完了するまでお待ちください。',
    title: {
        daemon_url_mismatch: 'バックグラウンドサービスが別の Home を使っています',
        daemon_account_mismatch: 'バックグラウンドサービスが別のアカウントを使っています',
        daemon_needs_auth: 'バックグラウンドサービスのサインインが必要です',
        daemon_not_configured: 'バックグラウンドサービスはまだ接続されていません',
        daemon_not_installed: 'バックグラウンドサービスがインストールされていません',
        daemon_not_running: 'バックグラウンドサービスが停止しています',
    },
    description: {
        daemon_url_mismatch: ({ home, daemonHome }: OtherHomeParams) => `${home} ではなく ${daemonHome} に接続されています。`,
        daemon_account_mismatch: ({ home, daemonAccount, appAccount }: AccountParams) =>
            `${home} に ${appAccount} ではなく ${daemonAccount} としてサインインしています。`,
        daemon_needs_auth: ({ home }: HomeParams) => `${home} に接続されていますが、まだ承認されていません。`,
        daemon_not_configured: ({ home }: HomeParams) => `${home} への接続がまだ完了していません。`,
        daemon_not_installed: ({ home }: HomeParams) => `インストールすると、このコンピューターを ${home} に接続できます。`,
        daemon_not_running: ({ home }: HomeParams) => `起動すると ${home} に再接続します。`,
    },
    action: {
        daemon_url_mismatch: 'この Home に接続',
        daemon_account_mismatch: ({ appAccount }: { appAccount: string }) => `${appAccount} に切り替える`,
        daemon_needs_auth: 'サインイン',
        daemon_not_configured: 'この Home に接続',
        daemon_not_installed: 'バックグラウンドサービスをインストール',
        daemon_not_running: 'バックグラウンドサービスを起動',
    },
    connected: ({ home, appAccount }: { home: string; appAccount: string }) => `${appAccount} として ${home} に接続済みです。`,
    noComputers: ({ home, appAccount }: { home: string; appAccount: string }) => `${appAccount} には ${home} 上のコンピューターがまだありません。`,
    openThisComputer: 'このコンピューターを確認',
    moveConfirm: {
        title: ({ appAccount }: { appAccount: string }) => `このコンピューターを ${appAccount} に切り替えますか？`,
        body: ({ home, daemonHome, daemonAccount, appAccount }: MoveParams) =>
            `このコンピューターのバックグラウンドサービスは ${daemonHome} に ${daemonAccount} としてサインインしています。切り替えると ${home} で ${appAccount} のために動作し、${daemonAccount} からはこのコンピューターが見えなくなります。`,
        confirm: '切り替える',
    },
    cli: {
        title: 'Happier CLI',
        version: ({ version }: { version: string }) => `バージョン ${version}`,
        updateAvailable: ({ version, latestVersion }: { version: string; latestVersion: string }) =>
            `バージョン ${version} · ${latestVersion} を利用できます`,
        update: 'アップデート',
        progressTitle: 'Happier CLI をアップデートしています',
        notManaged: ({ origin }: { origin: string }) => `Happier 以外でインストール: ${origin}`,
    },
    cliChoice: {
        title: ({ version }: { version: string }) => `Happier CLI ${version} はすでにインストールされています`,
        titleUnknownVersion: 'Happier CLI はすでにインストールされています',
        titleMissing: 'お使いの Happier CLI はインストールされていません',
        body: ({ path }: { path: string }) => `場所は ${path} です。Happier が独自のコピーをインストールして最新に保ち、PATH の先頭に置くこともできますし、このまま使い続けることもできます。`,
        bodyOutdated: ({ path }: { path: string }) => `場所は ${path} ですが、セットアップには古すぎます。Happier が最新のコピーをインストールして PATH の先頭に置くこともできますし、今のものを残してご自身で更新することもできます。`,
        bodyMissing: ({ path }: { path: string }) => `${path} にあるものを使い続けるよう選択していましたが、見つかりません。Happier が独自のコピーをインストールして最新に保つことも、ご自身で再インストールして使い続けることもできます。`,
        bodyKeepBlocked: ({ path, link }: { path: string; link: string }) => `場所は ${path} ですが、新しいターミナルでは Happier が追加していない ${link} を通じて Happier の CLI が先に実行されます。Happier に管理を任せるか、${link} を削除してからセットアップをやり直すと自分のものを使えます。`,
        notNow: '今はしない',
        manage: 'Happier に管理を任せる',
        keep: '自分のものを使う',
        unanswered: '何も変更せずにセットアップを停止しました。続けるには、コマンドラインを誰が管理するか選んでください。',
        ownMissing: '使い続けるよう選んだコマンドラインが見つかりません。再インストールするか、Happier に管理を任せてください。',
        managed: 'Happier が管理',
        own: ({ path }: { path: string }) => `自分のもの — ${path}`,
        change: 'コマンドラインの管理者を変更',
        keptUpdateTitle: 'コマンドラインを更新',
        keptUpdate: ({ command }: { command: string }) => `新しいバージョンがあります。${command} で更新してください`,
        oldCopyTitle: '古いコマンドライン',
        oldCopyRemove: ({ path, command }: { path: string; command: string }) => `${path} にまだインストールされています。${command} で削除できます`,
        oldCopyPath: ({ path }: { path: string }) => `${path} にまだインストールされています。`,
    },
    servers: {
        title: 'このコンピューターが接続している Home',
        connected: '接続済み',
        offline: '設定済み · オフライン',
        attention: '対応が必要',
        currentHome: ({ home }: HomeParams) => `${home} · この Home`,
    },
    removal: {
        uninstallFailedTitle: 'このコンピューターを切断できませんでした',
        uninstallFailedBody: ({ home }: HomeParams) => `${home} 用のこのコンピューターのバックグラウンドサービスを削除できなかったため、${home} は残しました。もう一度試すか、設定 › このコンピューターからサービスを削除してください。`,
        inventoryUnavailableTitle: 'このコンピューターを確認できませんでした',
        inventoryUnavailableBody: ({ home }: HomeParams) => `Happier がこのコンピューターのバックグラウンドサービスを読み取れなかったため、このコンピューターがまだ ${home} を提供しているか分かりません。それでも Happier から削除しますか？`,
        removeAnyway: 'それでも削除',
        userOwnedTitle: 'このコンピューターは引き続き提供します',
        userOwnedBody: ({ home, service }: RemovalServiceParams) => `${service} は Happier の外でインストールされたため、${home} 用に動作し続けます。不要になったらターミナルから削除してください。`,
    },
};

const thisComputerConnectionTranslations = { ja };

return { thisComputerConnectionTranslations };
})();

const Domain_transcriptFindTranslations = (() => {
const transcriptFindTranslations = { ja: { searchOlder: '以前のメッセージを検索', partialErrors: '一部のコンテンツを検索できませんでした。結果は不完全です。', olderRemaining: '未検索の以前のメッセージがあります。', findOpen: '検索を開く', findNext: '次の一致', findPrevious: '前の一致' } } as const;

return { transcriptFindTranslations };
})();

const Domain_turnChangesTranslations = (() => {
type TurnChangesTranslations = Shared_turnChangesTranslations.TurnChangesTranslations;

const en = Shared_turnChangesTranslations.en;

const translated = Shared_turnChangesTranslations.translated;

const turnChangesTranslations = { ja: {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `${count} 個のファイルを編集`,
                walkThrough: '順に説明して',
                openInFiles: 'ファイルで開く',
                fileCount: ({ count }) => `${count} 個のファイル`,
                fileCountInFolders: ({ count, folders }) => `${folders} 個のフォルダーに ${count} 個のファイル`,
                showMore: ({ count }) => `さらに ${count} 件を表示`,
                groupA11y: 'このターンの変更',
            }),
        },
    } } as const;

return { turnChangesTranslations };
})();

const Domain_voiceDiagnosticsConsentTranslations = (() => {
type VoiceDiagnosticsConsentCopy = Shared_voiceDiagnosticsConsentTranslations.VoiceDiagnosticsConsentCopy;

const defineVoiceDiagnosticsConsentTranslation = Shared_voiceDiagnosticsConsentTranslations.defineVoiceDiagnosticsConsentTranslation;

const voiceDiagnosticsConsentTranslations = { ja: defineVoiceDiagnosticsConsentTranslation({
    consentTitle: 'このデバイスで音声を録音しますか？',
    consentBody: '音声には個人的な会話や周囲の音が含まれる場合があります。ファイルはデバイス内にのみ保存され、非公開の権限で保護され、自動的に期限切れになります。同期されたり、分析やクラッシュレポートに添付されたりすることはありません。',
    consentAction: '録音を有効にする',
  }) } as const;

return { voiceDiagnosticsConsentTranslations };
})();

const Domain_voiceDiagnosticsTranslations = (() => {

type VoiceDiagnosticsCopy = Shared_voiceDiagnosticsTranslations.VoiceDiagnosticsCopy;

const voiceDiagnosticsConsentTranslations = {...Domain_voiceDiagnosticsConsentTranslations.voiceDiagnosticsConsentTranslations};

const defineVoiceDiagnostics = Shared_voiceDiagnosticsTranslations.defineVoiceDiagnostics;

const voiceDiagnosticsTranslations = { ja: defineVoiceDiagnostics(voiceDiagnosticsConsentTranslations["ja"].diagnostics, {
    title: '診断用の録音',
    footer: '既定ではオフです。録音は書き出すまで Voice マシンに残ります。',
    enabled: '診断用の音声を保存',
    enabledSubtitle: 'あなたと Voice の発話を、音声の問題を調べるために短期間保存します。',
    sttInput: '音声認識の入力を録音',
    ttsOutput: '合成音声の出力を録音',
    location: '保存場所',
    unavailable: '選択したマシンを利用できません',
    retention: '保持の上限',
    retentionDetail: ({ hours, files, megabytes }) => `${hours} 時間 · ${files} 件 · ${megabytes} MB`,
    deleteAll: 'すべての診断音声を削除',
    deleteAllSubtitle: '選択したマシンから音声とメタデータをただちに削除します',
    deleteConfirmTitle: 'ローカル音声診断をすべて削除しますか？',
    deleteConfirmBody: '選択したマシン上のすべての音声診断ファイルを完全に削除します。',
    deleteAction: 'すべて削除',
    deleteFailed: 'ローカルの診断録音を削除できませんでした。選択したマシンに残っている可能性があります。',
    cleanupRequired: 'ローカル診断のクリーンアップに対応が必要です',
    cleanupRequiredSubtitle: '非公開の診断ファイルが残っているか、ローカルのカタログを読み取れませんでした。クリーンアップを再試行するか、すべての診断音声を削除してください。',
    captureFailed: '診断の記録に対応が必要です',
    captureFailedSubtitle: '直近の診断音声を読み取りまたは保存できませんでした。残存する診断ファイルは検出されていません。次の対象となる音声記録時に状態を再確認します。',
    retryCleanup: '診断のクリーンアップを再試行',
    retryCleanupSubtitle: '非公開ストアを再確認し、その保持上限を適用し直します',
    cleanupRetryFailed: 'クリーンアップを完了できませんでした。診断ファイルが選択したマシンに残っている可能性があります。再接続後に再試行するか、すべて削除してください。',
    exportTitle: '選択した診断をエクスポート',
    noArtifacts: '選択したマシンに保持されている診断録音はありません。',
    exportSttArtifact: '音声認識の入力をエクスポート',
    exportTtsArtifact: '合成音声の出力をエクスポート',
    exportArtifactAccessibility: 'このローカル音声診断の録音をエクスポート',
    exportConfirmTitle: 'この非公開の録音をエクスポートしますか？',
    exportConfirmBody: '選択した録音を、暗号化された 1 回限りの転送で、選択したマシンからこのデバイスにコピーします。自動的にアップロードされることはありません。',
    exportAction: '録音をエクスポート',
    exportFailed: '非公開の録音をエクスポートできませんでした。アップロードは行われていません。',
    backupPolicy: 'バックアップからの除外',
    backupPolicyBestEffort: '選択したマシンの非公開キャッシュに保存され、キャッシュディレクトリ標準に従うバックアップツール向けにマークされます。自動のアップロードや同期は実装されていません。オペレーティングシステムのバックアップから除外されることは保証されません。',
    activeIndicator: '音声診断はオンです',
    checkingIndicator: '音声診断の状態を確認しています',
    statusUnknownIndicator: '音声診断の状態が不明です',
    shutdownPendingIndicator: '音声診断を停止しています',
    shutdownFailedIndicator: '音声診断がオフになったことを確認できませんでした',
    retryShutdown: '診断の停止を再試行',
    sessionOptOut: 'このセッションを録音しない',
    sessionOptOutConfirmTitle: 'このセッションの録音を停止しますか？',
    sessionOptOutConfirmBody: '他のセッションでは音声診断は有効なままですが、アプリを再起動するまで、このセッションの新しい音声は録音されません。',
    sessionOptOutFailed: '実行中のマシンで録音を停止できませんでした。このセッションはまだ録音されている可能性があります。マシンの再接続後に再試行してください。',
    sessionOptOutRetry: '録音の停止を再試行',
  }) } as const;

return { voiceDiagnosticsTranslations };
})();

const Domain_voiceExternalCredentialApprovalTranslations = (() => {
type VoiceExternalCredentialApprovalCopy = Shared_voiceExternalCredentialApprovalTranslations.VoiceExternalCredentialApprovalCopy;

const defineVoiceExternalCredentialApproval = Shared_voiceExternalCredentialApprovalTranslations.defineVoiceExternalCredentialApproval;

const voiceExternalCredentialApprovalTranslations = { ja: defineVoiceExternalCredentialApproval({
    reviewRequired: '認証情報へのアクセスを確認',
    recipientApprovalTitle: 'このプロバイダーに認証情報の使用を許可しますか？',
    recipientApprovalBody: '宣言されたプロバイダーのエンドポイントと操作を確認して承認してください。受信側の契約が変わった場合、Happier は選択を保持したまま、再度承認するまで認証情報の使用をブロックします。',
    recipientApprovalPackage: ({ title, pluginId, sourceKind, sourceLocator }) =>
      `パッケージ: ${title}（${pluginId}）; ソース: ${sourceKind} ${sourceLocator}`,
    recipientApprovalPublisher: ({ trust, identity }) => `発行者: ${identity}（${trust}）`,
    recipientApprovalPackageSignature: ({ status, keyId }) => `パッケージ署名: ${keyId}（${status}）`,
    recipientApprovalContribution: ({ pluginId, localId }) => `コントリビューション: ${pluginId}/${localId}`,
    recipientApprovalOperations: '宣言された操作:',
    recipientApprovalOperation: ({ id, purpose, effect }) =>
      `操作 ${id}: 目的 ${purpose}; 影響 ${effect}`,
    recipientApprovalRequest: ({ method, origin, pathTemplate }) => `リクエスト: ${method} ${origin}${pathTemplate}`,
    recipientApprovalCredential: ({ headerName, format }) => `認証情報ヘッダー: ${headerName}; 形式: ${format}`,
    recipientApprovalBounds: ({ requestMaxBytes, responseMaxBytes }) =>
      `バイト上限: リクエスト ${requestMaxBytes}; レスポンス ${responseMaxBytes}`,
    recipientApprovalTrust: { bundled: 'バンドル', verified: '検証済み' },
    recipientApprovalEffect: { read: '読み取り', mutation: '変更' },
    recipientApprovalCredentialFormat: { raw: '生', bearer: 'bearer' },
    recipientApprovalConfirm: '承認して保存',
  }) } as const;

return { voiceExternalCredentialApprovalTranslations };
})();

const Domain_voiceLocalCredentialTranslations = (() => {
type VoiceLocalCredentialCopy = Shared_voiceLocalCredentialTranslations.VoiceLocalCredentialCopy;

const defineVoiceLocalCredential = Shared_voiceLocalCredentialTranslations.defineVoiceLocalCredential;

const voiceLocalCredentialTranslations = { ja: defineVoiceLocalCredential({
    voiceCredential: {
      setOnAccount: 'アカウントに保存済み',
      notSetOnAccount: 'アカウントに未保存',
      setOnMachineOverride: ({ machine }) => `${machine} ではアカウントの認証情報による上書きを使用しています`,
      notSetWithFallback: ({ machine }) => `${machine} には未設定です。利用できる場合はアカウントの認証情報を使用します`,
      plainStorageTitle: 'エンドツーエンド暗号化なしで API キーを保存しますか？',
      plainStorageBody: 'このアカウントは設定をエンドツーエンド暗号化せずに保存します。この API キーを保存すると、平文がサーバーから見える状態になります。',
      plainStorageConfirm: 'API キーを保存',
      deleteAccountBody: '保存済みのこの API キーを削除しますか？同じ保存済みシークレットを参照する他のバインディングでは保持されます。',
      machineUnavailable: 'オンラインの音声実行マシンを選択してください',
      machineUnavailableTitle: '音声マシンを利用できません',
      machineUnavailableBody: 'この認証情報を保存または使用する前に、オンラインの音声実行マシンを選択してください。',
      statusUnavailable: ({ machine }) => `${machine} の認証情報の状態を取得できません。タップして再試行してください。`,
      importAvailable: ({ machine }) => `${machine} にインポートできる以前のキーがあります`,
      notSetOnMachine: ({ machine }) => `${machine} には未設定`,
      setOnMachine: ({ machine, protection }) => `${machine} に設定済み · ${protection}`,
      protection: { osProtected: 'OS で保護', filePermissions: 'ファイル権限で保護' },
      importTitle: '既存の API キーをインポートしますか？',
      importBody: ({ machine }) => `既存の暗号化されたアカウント設定を ${machine} にコピーします。元の設定は他のデバイスでも引き続き利用できます。`,
      importAction: 'インポート',
      enterNewAction: '新しく入力',
      useSavedSecretTitle: '保存済みのシークレットを使う',
      useSavedSecretSubtitle: 'このアカウントに保存済みのキーを選びます。',
      replaceOrRemoveBody: '置き換える API キーを入力するか、空欄のままにするとこのマシンからキーを削除します。',
      deleteTitle: 'API キーを削除しますか？',
      deleteBody: ({ machine }) => `${machine} からこの API キーを削除しますか？以前のデバイス間共有の値がある場合、その値は変更されません。`,
      operationFailed: '選択したマシンでこの認証情報を更新できませんでした。オンラインであることを確認して、もう一度お試しください。',
      newCredentialRequired: ({ machine }) => `${machine} には新しいマシン認証情報が必要です`,
    },
    openAiCompatEndpoint: {
      executionMachine: ({ machine }) => `リクエストは ${machine} 上で実行されます。Localhost はそのマシンを指します。`,
      insecureTitle: '安全でないローカル HTTP を許可しますか？',
      insecureBody: ({ origin, machine }) => `${machine} から ${origin} へ HTTP で認証情報を送信することを許可しますか？Localhost は ${machine} を指します。ループバックとプライベートネットワークのアドレスのみが許可され、公開 HTTP は拒否されます。`,
      allowAction: 'HTTP を許可',
      invalidBody: 'HTTPS の URL、またはユーザー名・パスワード・クエリ文字列を含まない HTTP のループバック／プライベートネットワーク URL を入力してください。',
    },
  }) } as const;

return { voiceLocalCredentialTranslations };
})();

const Domain_voiceMomentsTranslations = (() => {
type VoiceMomentsTranslation = Shared_voiceMomentsTranslations.VoiceMomentsTranslation;

const voiceMomentsTranslations = { ja: {
        setupTitle: '音声をセットアップ',
        setupTileSubtitle: '声でセッションと話せます。4つの短いステップです。',
        setupTileProgress: ({ done, total, next }) => `${total}件中${done}件完了 · ${next}`,
        setupNextService: '次は聞き手を選ぶ',
        setupNextReadiness: '次はサービスの準備',
        setupNextMicrophone: '次はマイクを許可',
        setupNextTry: '次は試す',
        setupNextInstalling: 'インストール中',
        setupStart: 'セットアップ',
        setupContinue: '続ける',
        setupDescription: '声でセッションと話せます。状況を尋ね、作業を始め、どこからでも判断できます。4つのステップで、途中でやめて戻れます。',
        setupLightCaption: ({ done, total }) => `${total}件中${done}件完了`,
        setupServiceTitle: '聞き手を選ぶ',
        setupServiceDetail: 'あなたの声を聞いて応答するもの。後で変更できます。',
        setupChange: '変更',
        setupReadinessTitle: ({ service }) => `${service}のセットアップを完了`,
        setupReadinessDone: ({ service }) => `${service}の準備ができました`,
        setupReadinessGeneric: 'サービス',
        setupReadinessTitleGeneric: 'サービスを準備',
        setupReadinessUnknown: '設定を開いて、まだ必要なものを確認してください。',
        setupReadinessCheck: 'セットアップを確認',
        setupMicrophoneTitle: 'マイクを許可',
        setupMicrophoneDetail: '確認は一度だけです。Happierは音声がオンの間だけ聞き取り、その状態はいつでも確認できます。',
        setupMicrophoneAction: 'マイクを許可',
        setupMicrophoneDone: 'マイクを許可済み',
        setupMicrophoneDeniedTitle: 'Happierのマイクがオフです',
        setupMicrophoneDeniedDetail: 'システム設定でオンにしてから、ここに戻ってください。',
        setupMicrophoneMissingTitle: 'マイクが見つかりません',
        setupMicrophoneMissingDetail: 'マイクまたはヘッドセットを接続してから、もう一度確認してください。',
        setupMicrophoneCheckAgain: 'もう一度確認',
        setupOpenSystemSettings: '設定を開く',
        setupTryTitle: '試してみる',
        setupTryDetail: '「セッションは何をしている？」と聞いてみましょう。言葉は普通のメッセージとして会話に残ります。',
        setupTryAction: '試す',
        setupTryDone: '試しました',
        setupTryNeedsService: 'サービスの準備ができると使えます。',
        setupDoneTitle: '音声の準備ができました',
        setupDoneBody: 'どのチャットでも音声ボタンをタップすると話し始め、もう一度タップで終了します。話している間、ミュートは終了の隣にあります。',
        setupGestureTap: 'タップ',
        setupGestureStartEnd: '開始 · 終了',
        setupGestureAnywhere: 'どこでも開始 · 終了',
        setupDoneAction: '完了',
        setupSettingsAction: '音声の設定',
        setupClose: '閉じる',
        needsYouEnded: '音声は終了しました。承認はまだ受信箱で待っています。',
        needsYouReview: 'リクエストを確認',
        needsYouTapToDecide: "読み上げ済み · ここでタップして決定",
        briefMe: '要点を教えて',
        briefMeA11y: '要点を教えて：対応が必要なもの、失敗したもの、準備できたものを音声が読み上げます',
        briefNeedsYou: '対応が必要',
        briefFailed: '失敗',
        briefReady: '準備完了',
        briefIncomplete: 'まだ読み込まれていない作業があるため、すべてではない可能性があります。',
        briefCaughtUp: '今は対応が必要なものはありません。',
        briefNotSpoken: "今は音声で読み上げられません。",
        briefStop: '停止',
        continueTitle: 'ここで話を続ける',
        continueDetail: ({ device }) => `${device}で話していました`,
        continueAction: '続ける',
        continuedOn: ({ device }) => `${device}で続行`,
        continuedElsewhere: '別のデバイスで続行',
        continuedHere: 'このデバイスで続行',
        dismiss: '閉じる',
    } } satisfies Pick<Readonly<Record<string, VoiceMomentsTranslation>>, "ja">;

return { voiceMomentsTranslations };
})();

const Domain_voicePresenceTranslations = (() => {
type VoicePresenceTranslation = Shared_voicePresenceTranslations.VoicePresenceTranslation;

const voicePresenceTranslations = { ja: {
        welcomeText: "こんにちは、お話を聞いています。何をしたいですか？",
        customVoice: 'カスタム音声',
        boundWelcomeText: ({ name }: Readonly<{ name: string }>) => `こんにちは、${name}と話しています。何をしたいですか？`,
        greetingLiteralUnavailable: "この応答言語では、話し始めるまでサービスは待機します。",
        title: '音声',
        howYouTalk: "話し方",
        holdToTalkTitle: "長押しで話す",
        holdToTalkDescription: "Voiceマークを長押しして一言話し、離すと送信します。タップでVoiceを開始・終了できます。",
        holdToTalkHint: "長押しで1ターン話し、離して送信。ドラッグでキャンセル。",
        holdToTalkUnavailable: ({ service }) => `${service}は長押しでの発話に対応していません。代わりにタップして話してください。`,
        talkWithVoice: '音声で話す',
        dictate: '音声入力',
        globalVoice: 'グローバル音声',
        interrupt: '割り込む',
        options: '音声のオプション',
        you: 'あなた',
        showConversation: '会話を表示',
        dragToMove: 'ドラッグして移動',
        openConversation: '会話を開く',
        settings: '音声の設定',
        ended: '音声を終了しました',
        muted: 'ミュート中',
        setUp: '音声を設定',
        setUpHint: '音声の設定を開いて話し方を選びます',
        startAgain: 'もう一度始める',
        endedCaption: ({ elapsed }) => `${elapsed} · 会話は保存されています`,
        dismiss: '閉じる',
        mute: "ミュート",
        unmute: "ミュート解除",
        end: "終了",
        captions: { connecting: "音声チャネルを開いています", listening: "どうぞ", transcribing: "テキストに変換しています", thinking: "回答を考えています", speaking: "いつでも割り込めます", interrupted: "どうぞ", muted: "話すにはミュートを解除 · 音声は引き続き話せます", reconnecting: "接続が切れました · 再試行中", blocked: "話すにはマイクへのアクセスを許可してください", failed: "もう一度試すか、音声の設定を確認してください" },
        recovery: { allow: "許可", setUp: "設定" },
        containerA11y: ({ status }) => `音声、${status}`,
    } } satisfies Pick<Readonly<Record<string, VoicePresenceTranslation>>, "ja">;

return { voicePresenceTranslations };
})();

const Domain_voiceProviderPrivacyTranslations = (() => {
const voiceProviderPrivacyTranslations = { ja: {
    openai: {
      privacyDisclosure: '音声と会話内容は WebRTC を使ってこのデバイスから OpenAI に送信されます。対応する機能が有効または使用されている場合、OpenAI はこのデバイスから限定的な Voice コンテキスト更新、クライアントツールの呼び出しとその結果も受信する場合があります。Happier は、選択された保存済み Voice API キー、OpenAI 接続サービス、または実験的な Codex OAuth アカウントを使って短期クライアント認証を取得します。接続アカウントは選択したマシン経由で使用されます。OpenAI は選択したアカウントで会話を処理し、そのアカウント設定と OpenAI の規約に従って受信データを保持する場合があります。Happier のサーバーとリレーはライブ音声を中継しません。Voice のコンテキスト共有設定は、このプロバイダーによる処理とは別です。',
    },
    xai: {
      privacyDisclosure: '音声と会話内容は xAI Realtime 接続を通じてこのデバイスから xAI に送信されます。対応する機能が有効または使用されている場合、xAI はこのデバイスから限定的な Voice コンテキスト更新、クライアントツールの呼び出しとその結果も受信する場合があります。Happier は Happier アカウントのシークレットに保存された xAI API キーを、限定されたクライアント認証と音声カタログ操作にだけ使用します。xAI はそのアカウントで会話を処理し、アカウント設定と xAI の規約に従って受信データを保持する場合があります。再開を有効にすると Happier はプロバイダー会話 ID を保存します。忘れる操作は Happier が保存した ID だけを削除し、xAI が保持するデータは削除しません。Happier のサーバーとリレーはライブ音声を中継しません。Voice のコンテキスト共有設定は、このプロバイダーによる処理とは別です。',
    },
    speechProcessing: {
      deviceStt: '音声はブラウザーまたはオペレーティングシステムの音声認識サービスで処理されます。プラットフォームと設定されたサービスによっては、デバイス外で処理される場合があります。',
      deviceTts: '応答テキストはブラウザーまたはオペレーティングシステムの音声合成サービスで処理されます。プラットフォームと設定されたサービスによっては、デバイス外で処理される場合があります。',
    },
    fields: {
      resumption: {
        title: 'xAI の再開 ID を保存',
        subtitle: '再接続のため、xAI の短期プロバイダー会話 ID を Happier に保存することを許可します。',
      },
    },
    resumption: {
      confirmTitle: 'xAI の再開 ID を保存しますか？',
      confirmBody: '中断した会話に再接続できるよう、Happier は xAI のプロバイダー会話 ID を最大 {minutes} 分間保存します。xAI が保持するデータを変更または削除することはありません。',
      confirmAction: 'ID を保存',
      forgetTitle: 'Happier の再開 ID を忘れる',
      forgetSubtitle: 'Happier が保存したプロバイダー会話 ID を削除します。会話や xAI が保持するデータは削除しません。',
      forgotten: 'Happier が保存したプロバイダー会話 ID を削除しました。',
      unsupported: 'このセッションから Happier が保存したプロバイダー会話 ID を削除できません。',
      failed: 'Happier が保存したプロバイダー会話 ID を削除できませんでした。もう一度お試しください。',
    },
  } } as const;

return { voiceProviderPrivacyTranslations };
})();

const Domain_voiceReadinessTranslations = (() => {
type VoiceReadinessCopy = Shared_voiceReadinessTranslations.VoiceReadinessCopy;

const defineVoiceReadinessTranslation = Shared_voiceReadinessTranslations.defineVoiceReadinessTranslation;

const voiceReadinessTranslations = { ja: defineVoiceReadinessTranslation({
    ready: '音声機能を利用できます。',
    permissionAnnouncement: ({ summary }) => `コーディングセッションには${summary}の許可が必要です。`,
    userActionAnnouncement: ({ question }) => `コーディングセッションにはあなたの回答が必要です。${question}`,
    userActionFallback: 'コーディングセッションにはあなたの回答が必要です。続行できるよう質問に回答してください。',
    requestedTool: '要求されたツール',
    provider_unselected: '音声プロバイダーを選択してください。',
    contribution_unavailable: 'この音声プロバイダーは利用できなくなりました。',
    role_unsupported: 'このプロバイダーは選択した音声モードに対応していません。',
    platform_unsupported: 'このプラットフォームでは、この音声プロバイダーを利用できません。',
    settings_unsupported_version: '音声機能で使用する前に、このプロバイダーを更新してください。',
    settings_unknown: 'プロバイダー設定を確認できませんでした。',
    settings_needs_migration: '更新されたプロバイダー設定を確認してください。',
    settings_invalid: '無効なプロバイダー設定を確認してください。',
    settings_missing_required_setting: ({ service }) => `${service}の設定を完了して開始してください。`,
    provider_mode_unknown: 'このプロバイダーが対応しているモードを選択してください。',
    server_feature_disabled: 'サーバーでこの音声プロバイダーが無効になっています。',
    server_feature_installing: 'サーバーで音声機能のサポートを準備しています。',
    server_feature_incompatible: 'サーバーはこの音声プロバイダーに対応していません。',
    server_feature_unknown: 'サーバーがこの音声プロバイダーに対応しているか確認できませんでした。',
    execution_machine_missing: 'この音声プロバイダーを実行できるマシンを選択してください。',
    execution_machine_installing: '選択した音声実行マシンはまだ準備中です。',
    execution_machine_incompatible: '選択したマシンに現在接続できません。',
    execution_machine_unknown: '音声実行マシンを確認できませんでした。',
    daemon_unreachable: '選択したマシンには音声オーディオに利用できる経路がありません。',
    daemon_relay_disabled: '選択したマシンには音声オーディオリレーが必要ですが、リレーの使用は無効です。',
    daemon_relay_capped: '選択したマシンでは現在、音声オーディオリレーの容量を利用できません。',
    credential_missing: 'この音声プロバイダーに必要な認証情報を追加してください。',
    credential_approval_required: 'この音声プロバイダーを使用する前に、認証情報へのアクセスを確認してください。',
    credential_installing: 'プロバイダーの認証情報はまだ準備中です。',
    credential_incompatible: '選択した認証情報はこの音声プロバイダーに対応していません。',
    credential_unknown: 'プロバイダーの認証情報を確認できませんでした。',
    endpoint_missing: 'この音声プロバイダーに必要なエンドポイントを設定してください。',
    endpoint_installing: '音声プロバイダーのエンドポイントはまだ準備中です。',
    endpoint_incompatible: '設定したエンドポイントはこの音声プロバイダーに対応していません。',
    endpoint_unknown: '音声プロバイダーのエンドポイントを確認できませんでした。',
    runtime_missing: 'この音声プロバイダーに必要なランタイムをインストールしてください。',
    runtime_installing: '音声プロバイダーのランタイムはまだインストール中です。',
    runtime_incompatible: 'インストール済みのランタイムはこの音声プロバイダーに対応していません。',
    runtime_unknown: '音声プロバイダーのランタイムを確認できませんでした。',
    model_missing: 'この音声プロバイダーのモデルをインストールまたは選択してください。',
    model_installing: '選択した音声モデルはまだインストール中です。',
    model_incompatible: '選択したモデルはこの音声プロバイダーに対応していません。',
    model_unknown: '音声プロバイダーのモデルを確認できませんでした。',
    device_stt_unavailable: 'このデバイスでは音声認識を利用できません。',
    device_stt_availability_unknown: '音声認識を利用できるか確認しています。',
    short: {
      needsSetup: '設定が必要',
      needsKey: 'キーが必要',
      needsApproval: '承認が必要',
      offOnServer: 'このサーバーではオフ',
      needsComputer: 'マシンが必要',
      needsAddress: 'アドレスが必要',
      needsModel: 'モデルが必要',
      installing: 'インストール中',
      notInstalled: '未インストール',
      unavailableHere: 'ここでは利用不可',
      needsUpdate: '更新が必要',
      cantCheck: 'まだ確認していません',
    },
    actions: {
      select_provider: 'プロバイダーを選択',
      open_provider_settings: "設定を完了",
      select_execution_machine: 'マシンを選択',
      configure_credential: '認証情報を追加',
      review_credential_access: '認証情報へのアクセスを確認',
      configure_endpoint: 'エンドポイントを設定',
      install_model: 'モデルをインストール',
      switch_provider: '別のプロバイダーを選択',
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

const voiceRealtimeProviderSetupTranslations = { ja: defineVoiceRealtimeProviderSetup(voiceProviderPrivacyTranslations["ja"], {
    xai: {
      setup: { footer: 'xAI の API キーは、同期される保存済みシークレットとして Happier アカウントのシークレットに保管され、限定された xAI Realtime の処理のときにだけ展開されます。' },
      credential: { promptBody: 'xAI の API キーを貼り付けてください。Happier は同期される保存済みシークレットとして保護し、限定された xAI Realtime の処理のときにだけ展開します。' },
    },
    setup: {
      title: 'リアルタイム音声の設定',
      footer: 'API キーは選択した実行マシンに保存され、同期される音声設定に含まれることはありません。',
    },
    credential: {
      title: '保存済みの API キー',
      promptTitle: 'リアルタイム音声を接続',
      promptBody: 'OpenAI Platform の API キーを貼り付けてください。同期されるアカウントのシークレット内で保護され、短時間だけ有効な Realtime クライアント認証を発行するときにのみ展開されます。',
    },
    authentication: {
      sectionTitle: 'OpenAI Realtime の認証',
      title: '認証のソース',
      subtitle: 'ソースはちょうど 1 つ選択してください。Happier が別のキーやアカウントにフォールバックすることはありません。',
      footer: 'OpenAI Realtime API の利用料は OpenAI Platform から請求されます。ChatGPT や Codex のサブスクリプションは、Realtime API の課金やアクセスを意味しません。WebRTC の会話に渡されるのは短時間だけ有効なクライアント認証のみです。',
      savedSecret: {
        title: '保存済みの音声 API キー',
        subtitle: 'Happier Voice アカウントのシークレットに保存された API キーを使用します。デーモンは不要です。',
      },
      openAiApiKey: {
        title: 'OpenAI 接続済みサービス',
        subtitle: '選択したマシンとその接続済みデーモンを介して、選択した標準の OpenAI API キープロファイルまたはアカウントグループを使用します。',
      },
      openAiCodex: {
        title: 'OpenAI Codex OAuth（実験的）',
        subtitle: '選択したマシンとその接続済みデーモンを介して、選択した Codex OAuth プロファイルまたはアカウントグループを使用します。Happier が別のキーやアカウントにフォールバックすることはありません。',
      },
      account: {
        title: '接続済みアカウント',
        subtitle: '次の会話で使用するプロファイルまたはアカウントグループを正確に選択します。',
      },
      chooseAccount: 'アカウントを選択',
      referenceRequired: '接続済みのプロファイルまたはアカウントグループを選択してください。',
      connected: '接続済みアカウントの準備ができました',
      unavailable: '選択したアカウントは利用できないか、再接続が必要です',
    },
    invalidValue: 'この値はこのプロバイダーではサポートされていません。',
    advanced: { show: '詳細設定を表示', hide: '詳細設定を非表示' },
    fields: {
      model: { title: 'モデル', subtitle: 'リアルタイム音声モデルを選択します。' },
      voice: { title: '音声', subtitle: '応答に使う音声を選択します。' },
      instructions: {
        title: '音声インストラクション',
        subtitle: '振る舞いや性格に関する任意のインストラクション。',
        promptTitle: '音声インストラクション',
        promptBody: 'この音声セッション向けの任意のインストラクションを入力します。',
      },
      turnDetection: {
        title: 'ターン検出',
        subtitle: 'あなたの発話の終わりをプロバイダーがどう判定するかを選択します。',
        threshold: {
          title: 'VAD しきい値',
          subtitle: '音声アクティビティの感度。空欄にするとプロバイダーの既定値になります。',
          promptTitle: 'VAD しきい値',
          promptBody: '0.1 から 0.9 の値を入力するか、空欄のままにしてください。',
        },
        silenceDurationMs: {
          title: '無音の長さ',
          subtitle: 'ターンを終了するまでの無音のミリ秒数。',
          promptTitle: '無音の長さ',
          promptBody: '0〜10000 ミリ秒を入力するか、空欄のままにしてください。',
        },
        prefixPaddingMs: {
          title: '発話前のパディング',
          subtitle: '検出された発話の前に保持するミリ秒数。',
          promptTitle: '発話前のパディング',
          promptBody: '0〜10000 ミリ秒を入力するか、空欄のままにしてください。',
        },
        idleTimeoutMs: {
          title: 'アイドル応答のタイムアウト',
          subtitle: '任意: この長さの無音のあとに xAI から応答を開始させます。',
          promptTitle: 'アイドル応答のタイムアウト',
          promptBody: '1〜600000 ミリ秒を入力するか、空欄にすると自動アイドル応答が無効になります。',
          confirmTitle: '自動アイドル応答を有効にしますか？',
          confirmBody: '設定した無音のあと、xAI が自発的に応答を作成し、API の利用量を消費する場合があります。',
          confirmAction: '有効にする',
        },
      },
      transcriptionModel: {
        title: '文字起こしモデル',
        subtitle: '任意の入力文字起こしモデル。',
        promptTitle: '文字起こしモデル',
        promptBody: 'モデル ID を入力するか、空欄にするとプロバイダーの既定値になります。',
      },
      reasoning: { title: '推論', subtitle: '対応モデルでの推論の強度を選択します。' },
      outputSpeed: {
        title: '話す速さ',
        subtitle: 'プロバイダーが話す速さを調整します。',
        promptTitle: '話す速さ',
        promptBody: '0.7 から 1.5 の値を入力してください。',
      },
      languageHint: {
        title: '言語ヒント',
        subtitle: '任意: 文字起こしがあなたの言語を判別しやすくします。',
        promptTitle: '言語ヒント',
        promptBody: '対応している言語を選択してください。',
      },
      keyterms: {
        title: 'キーワード',
        subtitle: '文字起こしに認識させたい固有名詞や専門用語。',
        promptTitle: 'キーワード',
        promptBody: 'カンマまたは改行で区切って、最大 100 個の用語を入力してください。',
      },
    },
    options: {
      pinned: '固定バージョン',
      movingAlias: 'プロバイダーの更新に自動で追従',
      automatic: '自動',
      custom: 'カスタム…',
      server_vad: 'サーバー側の音声アクティビティ検出',
      semantic_vad: '意味に基づくターン検出',
      manual: '手動',
      high: '高',
      none: 'なし',
    },
    catalog: {
      credentialRequired: 'API キーを追加すると音声を読み込めます',
      loadFailed: '音声を読み込めませんでした',
      retry: '音声を読み込めませんでした — 再試行',
      empty: 'このアカウントで利用できる音声はありません',
      preview: ({ voice }) => `${voice} を試聴`,
    },
    movingAlias: {
      confirmTitle: '最新モデルに追従しますか？',
      confirmBody: '可動のモデルエイリアスは、プロバイダーが更新すると挙動が変わることがあります。いつでも固定バージョンに戻せます。',
      confirmAction: '最新を使う',
    },
    links: {
      title: 'プロバイダーのリソース',
      account: { title: 'プロバイダーのアカウントを開く', subtitle: 'プロバイダー側のアカウントを管理します。' },
      apiKeys: { title: 'API キーを開く', subtitle: 'プロバイダーの API キーを作成・更新・失効させます。' },
      privacy: { title: 'プロバイダーのプライバシーポリシー', subtitle: 'プロバイダーが音声データをどう扱うかを確認します。' },
    },
    disconnect: {
      title: 'リアルタイム音声を切断',
      subtitle: 'このプロバイダーの API キーを選択したマシンから削除します。',
      confirmTitle: 'プロバイダーを切断しますか？',
      confirmBody: '選択した実行マシンから、保存済みの API キーを削除します。',
    },
    unavailable: {
      title: 'リアルタイム音声を利用できません',
      rowTitle: '設定を読み込めませんでした',
      provider: 'プロバイダーのコントリビューションが利用できないか、互換性がありません。',
      invalid: '保存されているプロバイダー設定が正しくありません。',
      needs_migration: 'この設定を編集するには、対応するマイグレーションが必要です。',
      unsupported_version: 'この設定はより新しいバージョンの Happier によって書き込まれました。',
    },
  }) } as const;

return { voiceRealtimeProviderSetupTranslations };
})();

const Domain_voiceSettingsPagesTranslations = (() => {
type VoiceSettingsPagesCopy = Shared_voiceSettingsPagesTranslations.VoiceSettingsPagesCopy;

const en = Shared_voiceSettingsPagesTranslations.en;

const ja: VoiceSettingsPagesCopy = {
  pages: {
    search: {
      providerChatConfigured: '設定済みのプロバイダーチャットがエージェントとモデルを管理します。',
      chooseService: 'この設定を変更するにはサービスを選択してください。',
      select: ({ choice, control }) => `この設定を変更するには「${control}」で「${choice}」を選択してください。`,
    },
    hub: {
      description: 'エージェントと声で話し、どのメッセージにも音声入力できます。',
      modesTitle: '声の 2 つの使い方',
      moreTitle: 'その他',
      dictationPurpose: '入力欄のマイクが話した内容を編集できるテキストに変えます',
      summarySessionSummaries: 'セッションの要約',
      summaryRecentMessages: ({ count }) => `直近 ${count} 件のメッセージ`,
      summaryNothingShared: '会話の開始時には何も共有しません',
      summaryRemembers: 'Voice エージェントは過去の会話を覚えています',
      summaryForgets: 'Voice エージェントは会話ごとに忘れます',
      summaryVoiceComputer: ({ machine }) => `Voice マシン: ${machine}`,
      summaryTranscript: '会話中の文字起こし',
    },
    pipeline: {
      hear: '聞く',
      think: '考える',
      speak: '話す',
      write: '書く',
      ready: '準備完了',
      oneStepNeedsYou: '対応が必要なステップが 1 つあります',
      stepsNeedYou: ({ count }) => `対応が必要なステップが ${count} 個あります`,
      waiting: '待機中',
      working: '処理中',
      notChecked: 'まだ確認していません',
      off: 'オフ · 音声入力は引き続き使えます',
      onMachine: ({ machine }) => `${machine} で`,
      onVoiceComputer: 'Voice マシンで',
      inTheCloud: 'サービスのクラウドで、このデバイスから',
      inTheSession: 'セッション自身のエージェントが文字起こしの中で答えます',
      intoYourMessage: '送信前に確認します',
      messageLanguage: ({ language }) => `言語：${language}`,
      languageAutomatic: '自動',
      onThisDevice: 'このデバイスで',
      needsYou: '対応が必要です',
      voiceAgentFollowsSession: 'Voice エージェント · セッションに従う',
      theSessionYoureIn: '今いるセッション',
      intoYourMessageTitle: 'メッセージへ',
    },
    privacy: {
      localAudio: "デバイスまたは Voice マシン",
      localProcessor: "選択した音声モデル",
      localRetention: "デバイスまたは実行環境が管理します。診断録音は録音設定に従います。",
      localDisclosure: "選択した音声モデルはデバイスまたは Voice マシンで実行されます。Voice 履歴と診断録音は、このページで個別に設定します。",
      audioTitle: "音声の送信先",
      processorTitle: "処理するサービス",
      retentionTitle: "保存方針",
      messagesUnit: "メッセージ",
      secondsUnit: "秒",
      servicePolicy: "サービスのアカウント設定と利用規約に従います。",
      noMicrophoneAudio: "マイク音声は送信せず、返信テキストのみ。",
      yourEndpoint: "設定したエンドポイント",
      endpointOperator: "エンドポイントの運営者",
      endpointPolicy: "エンドポイントの保存方針に従います。",
      deviceAudio: "デバイスの音声サービス",
      deviceProcessor: "デバイスまたはその音声サービス",
      devicePolicy: "デバイスの音声設定と利用規約に従います。",
      description: '音声サービスが聞き取り、読み取る内容と、Happier が保存する内容。',
      whereTitle: '今あなたの声が送られる場所',
      whereDescription: '選んだサービスによって変わります。',
      startTitle: '会話の開始時',
      startDescription: '音声サービスがあなたの作業について読み取れる内容。',
      screenTitle: '画面に表示されているもの',
      screenDescription: '見ているセッションやページ。',
      screenNever: 'しない',
      screenWhenAsked: '頼んだとき',
      screenAlways: '常に',
      summariesTitle: 'セッションの要約',
      recentTitle: '最近のメッセージ',
      recentDescription: 'コンテキストを求められたときの、セッションの最新メッセージ。',
      recentCountTitle: '共有するメッセージ数',
      recentCountDescription: "",
      recentCountUnavailable: '「最近のメッセージ」をオンにすると変更できます。',
      toolsTitle: 'ツール名',
      toolsDescription: '「ファイルを編集」など。引数やファイルパスは共有しません。',
      permissionsTitle: '許可のリクエスト',
      permissionsDescription: "リクエストを読み上げ、返答を手伝います。",
      devicesTitle: 'マシンとデバイス',
      devicesDescription: '頼んだ場所でセッションを開始するための名前とオンライン状態。',
      liveTitle: '話している間',
      liveDescription: '会話中にセッションが変化したときに送られる更新。',
      liveActiveTitle: '今いるセッションから',
      liveOtherTitle: 'ほかのセッションから',
      liveNothing: 'なし',
      liveActivity: 'アクティビティ',
      liveSummaries: '要約',
      liveMessages: 'メッセージ',
      livePerUpdateTitle: '更新ごとのメッセージ数',
      liveIncludeMineTitle: '自分が書いた内容を含める',
      liveIncludeMineDescription: 'オフ: エージェント側の内容だけを送ります。',
      liveMessagesUnavailable: '上でセッションに「メッセージ」を選ぶと変更できます。',
      liveOtherModeTitle: 'ほかのセッションのメッセージ',
      liveOtherModeNever: 'しない',
      liveOtherModeWhenAsked: '頼んだとき',
      liveOtherModeAutomatically: '自動',
      liveOtherModeUnavailable: 'ほかのセッションに「メッセージ」を選ぶと変更できます。',
      memoryTitle: 'Voice エージェントの記憶',
      memoryDescription: 'Voice エージェントを使うローカル音声のみ。',
      rememberTitle: '過去の会話を覚える',
      rememberOnDescription: '前回の続きから再開します。',
      rememberOffDescription: 'オフ: 通話を終えるとすべて忘れます。',
      restoreTitle: '記憶の復元方法',
      restoreRecent: '最近のメッセージ',
      restoreSummary: '要約 + 最近',
      restoreResume: 'エージェントを再開',
      restoreUnavailable: '「覚える」をオンにすると選べます。',
      restoreResumeFeatureOff: '再開するには、このサーバーで Voice エージェントがオンになっている必要があります。',
      restoreResumeAgentCannot: 'このエージェントは過去の会話を再開できません。',
      diagnosticsUnreachable: 'Voice マシンに接続できないため、現在その録音を表示できません。',
      fallbackTitle: '再開できない場合はメッセージを再生する',
      fallbackDescription: 'ゼロからではなく最近のメッセージから始めます。',
      restoreCountTitle: '復元するメッセージ数',
      restoreCountDescription: "",
      forgetTitle: '今すぐすべて忘れる',
      forgetDescription: 'Voice エージェントを最初からやり直します。セッションには影響しません。',
      forgetAction: '忘れる',
      moreTitle: 'その他',
    },
    dictation: {
      description: '入力欄のマイクが話した内容を、送信前に編集できるテキストに変えます。',
      engineTitle: '音声エンジン',
      engineDescription: '各エンジンに、音声の送り先が表示されます。',
      sameAsConversations: '音声会話と同じ',
      sameAsConversationsUses: ({ engine }) => `音声会話と同じ ${engine} を使います。`,
      languageTitle: '言語',
      dictateInTitle: '音声入力の言語',
      dictateInDescription: '自動ではエンジンの既定の言語を使います。会話の言語には従いません。',
      pipelinePurpose: '音声会話がオフでも使えます',
    },
    conversations: {
      description: 'キーボードに手を置いたままでも、エージェントと声で話せます。',
      serviceTitle: 'サービス',
      serviceDescription: '聞いて、考えて、話す担当です。いつでも切り替えられ、それぞれの設定は保たれます。',
      offDescription: '音声会話を使いません。音声入力は引き続き使えます。',
      serviceReady: '準備完了',
      accountTitle: 'アカウント',
      accountDescription: 'どちらでも同じサービスです。変わるのは支払う人だけです。',
      payWithTitle: '支払い',
      happierBillingUnavailable: "このサーバーではHappierの支払いを利用できません。",
      turnOnVoiceAgent: "音声エージェントを有効にする",
      payWithHappierDescription: 'Happier のプランに含まれます。ご自身のアカウントは不要です。',
      payWithOwnDescription: 'このサービスのご自身のアカウントと API キーを使います。',
      runsOn: '実行場所',
      hearTitle: '聞く',
      hearDescription: '返答の前に、話した内容をテキストにする方法。',
      speechRecognitionTitle: '音声認識',
      handsFreeDescription: '返信のあとも聞き続けます。オフ：話すたびにタップします。',
      handsFreeUnsupported: 'ハンズフリーには、このデバイスの音声認識か Happier の音声モデルが必要です。',
      handsFreeTimingUnavailable: 'ハンズフリーをオンにすると変更できます。',
      interruptTitle: '話しかけて中断',
      interruptDescription: '返答中に話すと返答が止まります。',
      talkToTitle: '話す相手',
      talkToSession: 'セッション',
      talkToSessionDescription: '今いるセッションに話しかけ、セッション自身のエージェントが答えます。',
      talkToAgent: 'Voice エージェント',
      talkToAgentDescription: 'Voice エージェントがセッションを読み、代わりに操作します。',
      agentFeatureRequired: ({ feature }) => `設定 → 機能で${feature}を有効にしてください。`,
      itMayTitle: '許可する操作',
      itMayReadOnly: '読み取りのみ',
      itMayReadOnlyDescription: 'セッションとファイルを読むだけで、何も変更しません。',
      itMayAsk: '先に確認',
      itMayAskDescription: "変更の前に確認します。",
      approvalsTitle: "承認",
      approvalsDescription: "話している間にセッションが許可を求めたとき。",
      canApproveRequestsTitle: "音声エージェントにリクエストの承認を任せる",
      canApproveRequestsDescription: "リクエストを読み上げ、あなたの指示どおりに応答します。オフにすると、毎回タップで決めます。",
      itMaySafe: '安全な変更',
      itMaySafeDescription: 'ワークスペースの安全な変更は自分で行い、それ以外は確認します。',
      itMayAnything: 'すべて',
      itMayAnythingDescription: '確認せずにどんな変更もできます。',
      repliesTitle: '返答',
      repliesShort: '短め',
      repliesBalanced: 'バランス',
      thinkTitle: '考える',
      thinkDescription: '話した内容をどう扱うか。',
      advancedAgentTitle: 'エージェントの詳細な動作',
      advancedAgentDescription: 'Voice エージェントの起動、待機、返答の仕方。ほとんどの人は既定値のままで大丈夫です。',
      memoryLinkTitle: '記憶と復元',
      memoryLinkDescription: '過去の会話を覚えるかどうかは「プライバシーとデータ」で設定します。',
      speakTitle: '話す',
      speakDescription: '返答を読み上げる方法。',
      voiceEngineTitle: '音声エンジン',
      languageTitle: '言語',
      languageDescription: '選んだサービスで各言語が何を変えるか。',
      iSpeakTitle: '話す言語',
      iSpeakDescription: '聞き取りに役立ちます。自動では毎回判別します。',
      replyInTitle: '返答の言語',
      replyInDescription: '途中で切り替えても、この言語で返答します。',
      replySame: '話す言語と同じ',
      iSpeakAutomatic: '自動',
      iSpeakEngineDescription: '音声認識が聞き取りに使います。「聞く」で設定します。',
      voiceTitle: '声',
      voiceDescription: '返信を読み上げる声です。「話す」で設定します。',
      voiceDefault: 'デフォルト',
      voiceDevice: 'システムの音声',
      voiceInEngine: '「話す」で設定',
      languageServiceDescription: '音声サービスが返答する言語。',
      languageAutomaticDescription: '音声サービスが話している言語を検出します。',
      languageEngineDefault: 'エンジンの既定値',
      languageCoupledDescription: '音声サービスは聞き取りと返答に同じ言語を使います。',
      greetingTitle: 'あいさつ',
      greetingOff: 'オフ',
      greetingRightAway: 'すぐに',
      greetingAfterISpeak: '話しかけたら',
      greetingOffDescription: 'あなたが先に話すのを待ちます。',
      greetingRightAwayDescription: '会話が始まるとすぐにあいさつします。',
      greetingAfterISpeakDescription: '最初の返答であいさつします。',
      languageManagedDescription: '言語は音声サービスが管理します。',
      languageServiceDefault: 'サービスの既定値',
    },
    advanced: {
      description: '音声が動く場所、画面での表示、使う音声モデル。',
      onScreenTitle: '画面表示',
      onScreenDescription: '進行中の会話の表示方法。',
      showLiveAsTitle: 'ライブ中の Voice の表示',
      showLiveAsDescription: 'このデバイスのみ。Companion の Voice セクションはどのモードでも表示されます。',
      scopeTitle: '会話の開始対象',
      scopeGlobal: 'すべてのセッション',
      scopeGlobalDescription: 'すべてを 1 つのアシスタントで。',
      scopeSession: '開いているセッション',
      scopeSessionDescription: '開いているセッションの中で始まります。',
      transcriptTitle: '会話中に文字起こしを表示',
      transcriptDescription: 'あなたとエージェントの発言が話しながら表示されます。',
      autoOpenTitle: '会話の開始時に開く',
      autoOpenDescription: 'オフ: 会話から自分で開きます。',
      autoOpenUnavailable: '「文字起こしを表示」をオンにすると選べます。',
      computerTitle: 'Voice マシン',
      speechModelsTitle: '音声モデル',
      speechModelsNeedComputerTitle: 'Voice マシンが必要です',
      speechModelsNeedComputer: '上で Voice マシンを選ぶと、その音声モデルをインストール・管理できます。',
      speechModelsChecking: 'Voice マシンの音声モデルを確認しています…',
      speechModelsOff: 'このサーバーでは音声モデルがオフになっています。',
      speechModelsUnreachable: '現在 Voice マシンに接続できません。',
      speechModelsUnsupported: 'この Voice マシンでは音声モデルを実行できません。',
      speechModelsTimeout: 'Voice マシンが時間内に応答しませんでした。',
      speechModelsFailed: '音声モデルを読み込めませんでした。',
      computerDescription: '音声モデルを実行し、音声用に連携アカウントへサインインするマシン。すべてのデバイスで共有されます。',
      connectionTitle: '接続',
      timeoutTitle: '音声リクエストを打ち切るまでの時間',
      timeoutDescription: "接続先と音声モデル向け。",
    },
  },
};

const voiceSettingsPagesTranslations = { ja } as const satisfies Pick<Record<string, VoiceSettingsPagesCopy>, "ja">;

return { voiceSettingsPagesTranslations };
})();

const Domain_walkthroughProgressTranslations = (() => {
type Parts = Shared_walkthroughProgressTranslations.Parts;

const walkthroughProgressTranslations = { 'ja': { parts: ({ completed, total, admitted }: Parts) => `${completed}/${total} パート完了 · ${admitted} 受付済み`, merge: 'ガイドをまとめています…', titleEdited: '編集済みのタイトル', changed: '変更済み', moved: '移動済み' } };

return { walkthroughProgressTranslations };
})();

const Domain_walkthroughSavedTranslations = (() => {
type SavedCopy = Shared_walkthroughSavedTranslations.SavedCopy;

const en = Shared_walkthroughSavedTranslations.en;

const walkthroughSavedTranslations = { ja: { discuss: '話し合う', message: 'メッセージ', edit: 'ウォークスルーを編集', title: 'ウォークスルーのタイトル', stopTitle: 'ステップのタイトル', prose: '説明', refine: '改善', instructions: '何を変更しますか？', moveUp: '上に移動', moveDown: '下に移動', mergeNext: '次のステップと結合', addSummary: '要約を追加', addCommitPlan: 'コミットを提案', updated: '保存済みの結果を更新しました', conflict: 'このウォークスルーは別の場所で変更されました。下書きは保持されています。最新のバージョンを読み込み、確認してから再度保存してください。', reload: '最新のバージョンを読み込む', missingStop: "このステップは最新のウォークスルーに含まれていません。下書きは保持されています。別のステップを選択して続けてください。", applicationLocked: 'コミットを適用中です。編集は一時停止しています。' } } satisfies Pick<Record<string, SavedCopy>, "ja">;

return { walkthroughSavedTranslations };
})();

const Domain_walkthroughSettingsTranslations = (() => {
type Copy = Shared_walkthroughSettingsTranslations.Copy;

const en = Shared_walkthroughSettingsTranslations.en;

const copy = Shared_walkthroughSettingsTranslations.copy;

const walkthroughSettingsTranslations = { ja: copy({
        title: 'ウォークスルー',
        description: 'AIが読む順序を提案し、該当する変更箇所に説明を添えます。必要に応じてコミット案も作成します。コードのあるマシンで実行されます。',
        enabled: '変更を説明',
        enabledDescription: '比較に読む順序と説明を追加します。モデルがなくてもファイルは確認できます。',
        model: '要約モデル',
        modelDescription: '説明、ウォークスルー、コミット案の作成に使います。',
        chooseModel: 'モデルを選択',
        sessionModel: 'セッションのモデル',
        searchModels: 'モデルを検索',
        loadModels: "他のモデルを探す",
        loadFailed: "保存したウォークスルーを読み込めませんでした。",
        chooseModelFirst: "先に要約モデルを選択してください。",
        outputLanguage: "出力言語",
        outputLanguageDescription: "別の言語を選ばない限り、説明はアプリの言語で表示されます。コードと参照は変更されません。",
        appLanguage: "アプリの言語",
        investigateSurroundingFiles: "周辺ファイルを読む",
        investigateSurroundingFilesDescription: "変更の前後の状態で、近くのファイルを参照できるようにします。読み取りのみで、変更はされません。",
        defaultModel: "デフォルト",
        costLow: "低コスト",
        costStandard: "標準コスト",
        costPremium: "高コスト",
        loadingModels: "モデルを読み込み中…",
        noModels: "モデルが見つかりません",
        chooseMachineForModels: "まずマシンを選ぶと、そのモデルが表示されます。",
        loadModelsFailed: "モデルを読み込めませんでした。もう一度お試しください。",
        startFailure: {
            notInstalled: { title: "このマシンにインストールされていません", next: "コマンドと作業ディレクトリを確認して、もう一度お試しください。" },
            cannotRun: { title: "このマシンでは実行できません", next: "実行権限を確認して、もう一度お試しください。" },
            other: { title: "このマシンで起動できませんでした", next: "しばらくしてからもう一度お試しください。" },
        },
        hiddenModels: ({ count }: { count: number }) => `${count} 件のモデルはウォークスルーを作成できません`,
        automaticUnavailable: {
            signIn: "このマシンでサインインするまで、自動では選ばれません。",
            authUnknown: "サインイン状態を確認できないため、自動では選ばれません。もう一度お試しください。",
            connected: "連携アカウントを利用できないため、自動では選ばれません。連携サービスを確認してください。",
        },
        moreAgents: "その他のエージェント",
        findModelsFor: ({ agent }: { agent: string }) => `${agent} のモデルを探す`,
        groupedUnavailable: {
            signIn: { title: ({ count }: { count: number }) => `${count} 件のエージェントはこのマシンでのサインインが必要です`, next: "それまでは自動では選ばれません。1 つ選ぶとそのモデルを探せます。" },
            authUnknown: { title: ({ count }: { count: number }) => `${count} 件のエージェントのサインイン状態を確認できません`, next: "自動では選ばれません。もう一度お試しいただくか、1 つ選んでそのモデルを探してください。" },
            connected: { title: ({ count }: { count: number }) => `${count} 件のエージェントの接続済みアカウントを利用できません`, next: "自動では選ばれません。接続済みサービスを確認してください。" },
        },
        catalogNotice: {
            refreshFailed: { title: "モデルを更新できませんでした", next: "前回の一覧を表示しています。もう一度お試しください。" },
            accountMetadata: { title: "一部のモデルが表示されていない可能性があります", next: "連携アカウントを読み取れませんでした。もう一度お試しください。" },
        },
        chooseMachine: "マシンを選ぶと、保存されたウォークスルーが表示されます。",
        waitingMachine: ({ machine }: { machine: string }) => `${machine} を待っています。応答すると保存されたウォークスルーが表示されます。`,
        unavailable: 'モデルを利用できません。別のモデルを選択してください。',
        prefetch: '各ターン終了後に準備',
        prefetchDescription: 'エージェントがターンを終えるとウォークスルーを準備します。',
        saved: '保存済みウォークスルー',
        savedDescription: '編集内容も含めて、このマシンに保存されます。',
        clear: '消去',
        unavailableData: '保存済みウォークスルーと費用を読み込むには、マシンを再接続してください。',
        costUnavailable: '過去7日間 · 費用を取得できません',
        clearTitle: '保存済みウォークスルーを消去しますか？',
        clearDescription: ({ machine }) => `${machine}に保存されたウォークスルーと手動での編集内容、および該当する比較につけたレビュー済みマークを削除します。他のマシンには影響しません。`,
        savedCount: ({ count, bytes }) => `${count}件保存済み · ${bytes}`,
        cost: ({ amount, partial }) => `過去7日間 · ${amount}${partial ? ' · 一部の費用を取得できません' : ''}`,
        clearFailed: '一部のウォークスルーを消去できませんでした。再読み込みして、もう一度お試しください。',
    }) };

return { walkthroughSettingsTranslations };
})();

const Domain_walkthroughStartTranslations = (() => {
const walkthroughStartTranslations = { ja: { walkthroughStart: { machineOffline: 'このコードがあるマシンはオフラインです。接続すると開始できます。', chooseModel: '構造化出力を返せる要約モデルを選んでください。', start: 'ウォークスルーを開始', ended: 'この会話はここでは利用できません。ウォークスルーは残ります。', newConversation: '新しい会話を開始', askSession: 'セッションのエージェントに質問', unavailable: '対象のマシンに接続し、構造化出力に対応したモデルを選んでください。', updated: 'ウォークスルーを更新しました' } } };

return { walkthroughStartTranslations };
})();

const Domain_walkthroughTranslations = (() => {
type WalkthroughTranslations = Shared_walkthroughTranslations.WalkthroughTranslations;

const walkthroughSavedTranslations = {...Domain_walkthroughSavedTranslations.walkthroughSavedTranslations, ...EnglishFeatures.walkthroughSavedTranslations.walkthroughSavedTranslations};

const walkthroughProgressTranslations = {...Domain_walkthroughProgressTranslations.walkthroughProgressTranslations, ...EnglishFeatures.walkthroughProgressTranslations.walkthroughProgressTranslations};

const en = Shared_walkthroughTranslations.en;

const translated = Shared_walkthroughTranslations.translated;

const walkthroughTranslations = { ja: {
        walkthrough: translated({
            saved: walkthroughSavedTranslations.ja,
            progress: walkthroughProgressTranslations.ja,
            eyebrow: 'ウォークスルー',
            conversationTitle: 'ウォークスルーの会話',
            generated: '生成',
            generatedBy: ({ model }) => `生成 · ${model}`,
            generatedA11y: 'モデルが作成',
            readingChanges: '変更を読み込み中…',
            modelFallback: 'モデル',
            analysisAll: ({ who, count }) => `${who} が ${count} 件すべてを読みました`,
            analysisSome: ({ who, analysed, total }) => `${who} が ${total} 件中 ${analysed} 件を読みました`,
            analysisStopped: ({ who, analysed, total }) => `${who} は ${total} 件中 ${analysed} 件を読んで停止しました`,
            unavailableCount: ({ count }) => `${count} 件は利用不可`,
            youReviewed: ({ count, total }) => `${total} 件中 ${count} 件をレビュー済み`,
            contents: '目次',
            reviewedOfTotal: ({ count, total }) => `${total} 件中 ${count} 件レビュー済み`,
            boardReviewedCount: ({ count, total }) => `${count}/${total}`,
            boardStopsReviewed: "件のストップを確認済み",
            boardAllReviewed: "すべてのストップを確認済み",
            continueReading: "続きを読む",
            stopOf: ({ number, total }) => `${number} / ${total}`,
            stopA11y: ({ number, title }) => `ストップ ${number}: ${title}`,
            stopReviewedA11y: ({ number }) => `ストップ ${number}、レビュー済み`,
            importance: { start: 'ここから', high: 'じっくり読む', low: '流し読み' },
            markReviewed: 'レビュー済みにする',
            reviewed: 'レビュー済み',
            markReviewedA11y: 'このストップをレビュー済みにする',
            unmarkReviewedA11y: 'レビュー済み。押すとマークを外します',
            askAboutThis: 'これについて質問',
            askAboutStopA11y: 'このストップについて質問',
            askQuestionA11y: ({ question }) => `質問する：${question}`,
            openConversation: 'ウォークスルーの会話を開く',
            andIn: ({ file }) => `${file} でも`,
            newFile: '新規ファイル',
            deletedFile: '削除',
            openInFiles: ({ file }) => `${file} をファイルで開く`,
            otherChanges: 'その他の変更',
            otherChangesDescription: 'ストーリーには含まれませんが、ここにあります。通常の差分として開けます。',
            otherChangesCue: '機械的な変更、差分として表示',
            keys: { move: '移動', reviewed: 'レビュー済み', ask: '質問' },
            overview: '概要',
            codeMapOf: ({ count }) => `${count} ファイルのコードマップ`,
            codeMapHint: 'ストップを指すとそのファイルが強調されます',
            touchesOutlined: 'が強調されたファイルに関係します',
            showOverviewA11y: ({ count }) => `概要を表示: ${count} ファイルのコードマップ`,
            inventory: { title: 'この比較のすべて · ファイルですぐに見られます', read: '読了', reading: '読み込み中', unavailable: '利用不可' },
            arriving: '次のストップは書かれ次第ここに表示されます。',
            previousStop: '前のストップ',
            nextStop: '次のストップ',
            done: '完了',
            evidence: { displayFailed: '保存されたコードを表示できませんでした。ファイルは「ファイル」に残ります。', binary: 'バイナリファイル。メタデータから説明しています。表示のみで分析はしていません。', unavailable: ({ reason }) => `読み込めませんでした（${reason}）。一覧には残ります。レビュー済みとは扱いません。` },
            stopNumber: ({ number }) => `ストップ ${number}`,
            receipt: {
                wrote: 'ウォークスルーを作成しました',
                updated: 'ウォークスルーを更新しました',
                savedAnalysis: '変更の分析を保存しました',
                updatedAnalysis: '変更の分析を更新しました',
                stopCount: ({ count }) => (count === 1 ? '1 ストップ' : `${count} ストップ`),
                open: 'ウォークスルーを開く',
                openChanges: '変更を開く',
                stopChanged: ({ number }) => `ストップ ${number} を変更`,
                stopsChanged: ({ numbers }) => `ストップ ${numbers} を変更`,
                stopsRemoved: ({ count }) => (count === 1 ? '1 ストップを削除' : `${count} ストップを削除`),
                stopsMergedInto: ({ count, number }) => `${count} ストップをストップ ${number} に統合`,
                titleEditKept: '編集したタイトルは保持',
                lastChangeUndone: '直前の変更を取り消し',
                undo: '元に戻す',
                undoing: '元に戻しています…',
                undone: '元に戻しました',
            },
            notice: {
                stale: '作成後にファイルが変更されました',
                refresh: 'ウォークスルーを更新',
                failedGeneric: '作成が止まりました',
                tryAgain: '再試行',
                chooseModel: 'モデルを選択',
                cancelled: '作成を停止しました。書かれた内容は残ります。',
                rest: '残りは書かれていません。すべてのファイルはファイルにあります。黙って省いたものはありません。',
                offline: ({ machine, time }) => `${machine} はオフラインです · ${time} 時点のウォークスルーとコードを表示中。再接続すると質問と更新が戻ります。`,
                offlineA11y: 'オフラインのマシンが必要です',
                unknownStart: "ウォークスルーが開始されていない可能性があります",
                unknownStartReason: "マシンがリクエストを受け取ったことを確認できませんでした。",
                checkAgain: "もう一度確認",
                incomplete: '一部の変更を一覧にできませんでした。表示中の内容は正確ですが、完全とは主張しません。',
                undo: '元に戻す',
            },
            generationFailure: { invalidRequest: 'このマシンはリクエストを読み取れませんでした。Happier が古い可能性があります。', reviewRequest: 'このマシンの Happier を更新して、もう一度お試しください。', modelUnavailable: '選択したモデルは現在利用できません。', machineUnavailable: 'Happier はこのマシンに接続できません。', reconnectMachine: '再接続してから、もう一度お試しください。', disabled: '「変更を説明」はオフです。', enableExplain: '設定でオンにする' },
            none: { title: 'ウォークスルーはまだありません', reason: 'ウォークスルーはこれらの変更を順に読み、それぞれを正確なコードの横で説明します。すべてのファイルはすでにファイルにあります。', showFiles: 'ファイルを表示' },
            explain: { notInStory: 'ストーリー外', readInWalkthrough: 'ウォークスルーで読む' },
        }),
    } };

return { walkthroughTranslations };
})();

const Domain_widgetAddTranslations = (() => {
type WidgetAddTranslation = Shared_widgetAddTranslations.WidgetAddTranslation;

const inSentence = Shared_widgetAddTranslations.inSentence;

const widgetAddTranslations = { ja: {
        added: '追加済み',
        boardTitle: 'ボードに追加',
        boardHint: 'ここにいる全員に表示されます',
        companionTitle: 'コンパニオンに追加',
        companionHint: 'コンパニオンはあなただけに表示されます',
        searchWidgets: 'ウィジェットを検索',
        searchCompanion: '概要とペインを検索',
        makeOne: '作成する',
        noteSubtitle: 'Markdown',
        interactiveViewSubtitle: 'HTML',
        findMore: 'ほかのウィジェットを探す',
        findMoreSubtitle: 'プラグイン',
        askTitle: 'エージェントにウィジェットを頼む',
        askNote: '入力欄に下書きします。送信するまで何も送られません。',
        glances: '概要',
        glancesHint: 'ライブ、組み込みまたはプラグインから',
        onBoard: 'このボード上',
        onBoardHint: 'ここにいる全員と共有',
        panes: 'ペイン',
        panesHint: '詳細で開くリンクとして追加',
        builtIn: '組み込み',
        sessionDetails: 'セッションの詳細',
        prompts: { project: 'どのプロジェクトですか？', projects: 'どのプロジェクトですか？', session: 'どのセッションですか？', workspace: 'どのワークスペースですか？', checkout: 'どのワークスペースですか？', machine: 'どのマシンですか？' },
        inputLabels: { session: 'セッション', metric: '指標', breakdown: '内訳', groupBy: 'グループ化', apiEquivalent: 'API換算', agent: 'エージェント', model: 'モデル', project: 'プロジェクト', workspace: 'ワークスペース', backendMode: 'バックエンドモード', source: 'ソース', machine: 'マシン' },
        nativeDescriptions: {
            session_summary: '選んだセッションの活動と次のステップを確認します。',
            agent_plan: '選んだセッションのエージェントの計画を確認します。',
            changes: '選んだセッションのファイル変更を確認します。',
            local_services: '選んだセッションのローカルサービスを開きます。',
        },
        noMatch: ({ query }) => `「${query}」に一致するウィジェットはありません`,
        pickTitle: 'ウィジェットを選ぶとここに表示されます',
        pickHint: '追加する前に、選んだサイズであなた自身のデータを表示します。',
        keysBrowse: '移動',
        keysAdd: '追加',
        keysClose: '閉じる',
        pickNote: '追加するウィジェットを選んでください',
        askAction: '依頼を下書き',
        pluginTag: 'プラグイン',
        pluginProvenance: ({ plugin }) => `${plugin} プラグイン`,
        readsChosenSession: '選んだセッションを実行場所で読み取ります',
        readsFrom: ({ source }) => `${source} を読み取ります`,
        savedQueryOn: ({ source }) => `${source} の保存済みクエリ`,
        madeByYou: ({ date }) => `${date} にあなたが作成`,
        madeByAgent: ({ date }) => `${date} にあなたのエージェントが作成`,
        madeByPlugin: ({ date }) => `${date} にプラグインが作成`,
        previewLiveData: 'ライブ、あなたのデータで',
        addsAtSize: ({ size }) => `${size} で追加します。サイズは後で変更できます。`,
        backToWidgets: 'ウィジェット',
        editTitle: ({ widget }) => `${widget} · 入力`,
        editHint: 'このコピーだけが変わります。ほかのコピーは入力を保ちます。',
        preview: 'プレビュー',
        previewLive: 'プレビュー · ライブ',
        previewWaiting: ({ field }) => `${field}を選ぶとここに表示されます`,
        listOnePerLine: "1 行に 1 つ",
        listCommaSeparated: "カンマ区切り",
        previewAfterAdd: '追加するとここに表示されます',
        adding: '追加中…',
        savingInputs: '保存中…',
        needed: '必須',
        stillNeeded: ({ field }) => `${field} がまだ必要です`,
        followGroup: 'フォロー',
        pinGroup: 'または固定',
        another: 'その他…',
        anotherSubtitle: 'アクセスできるものをすべて検索',
        searchChoices: ({ field }) => `${field} を検索`,
        noChoices: 'まだ選べるものがありません',
        optionsLoading: '候補を読み込み中…',
        optionsFailed: '候補を読み込めませんでした',
        yoursFailed: 'ウィジェットを読み込めませんでした',
        invalidValue: '見つかりません',
        inputsInvalid: 'このウィジェットの入力を確認してください',
        inputsUnavailable: '選択した入力を利用できません',
        connectionNeeded: ({ field }) => `自分の${field}を接続してください`,
        sessionDenied: ({ session }) => `${session}へのアクセス権がなくなりました`,
        sessionUnavailable: ({ session }) => `${session}は利用できないか、削除されました`,
        typeUnavailable: ({ field }) => `${field}の種類は利用できなくなりました`,
        inputUnavailable: ({ field }) => `${field}は利用できません`,
        selectedInputUnavailable: ({ field, value }) => `${field}：${value}は利用できなくなりました`,
        invalidReason: 'アクセスできなくなったか、削除されました。',
        viewerOnly: 'ここでは各自が自分の接続で表示します。',
        justAdded: ({ widget }) => `${widget} を追加しました`,
        addAnother: 'もう1つ追加',
        saved: ({ widget }) => `${widget} を保存しました`,
        addFailed: '追加できませんでした。もう一度お試しください。',
        saveFailed: '保存できませんでした。もう一度お試しください。',
        homeTitle: 'ホームに追加',
        homeHint: 'ホームはあなただけに表示されます · すべてのデバイスで',
        addWidgets: 'ウィジェットを追加',
        addToHome: 'ホームに追加',
        addToBoard: 'ボードに追加',
        addToCompanion: 'コンパニオンに追加',
        editInputs: '入力を編集…',
        width: '幅',
        size: 'サイズ',
        sizes: { small: '小', medium: '中', wide: '横長', full: '全幅', tall: '縦長', large: '大' },
        widthHalf: '半分',
        widthFull: '全幅',
        thisSession: 'このセッション',
        choicesCount: ({ count }) => `${count} 件の候補`,
        countOnHome: ({ count }) => `ホームに ${count} 件`,
        countOnBoard: ({ count }) => `ボードに ${count} 件`,
        countInCompanion: ({ count }) => `コンパニオンに ${count} 件`,
        thisPage: 'このページ',
        ownValue: '独自の値',
        ownValueHint: 'ここで設定します。追従しなくなります',
        thisProject: 'このプロジェクト',
        thisCheckout: 'このチェックアウト',
        areaPinned: 'ピン留め',
        areaPinnedMeta: 'このページのあなたのウィジェット',
        areaProjectTitle: 'ウィジェット',
        areaProjectMeta: 'あなた専用',
        areaAdd: ({ surface }) => `${surface} にウィジェットを追加`,
        areaAddTo: ({ surface }) => `${surface} に追加`,
        areaHint: 'これらのウィジェットはあなただけに表示されます',
        countHere: ({ count }) => `${count} 件`,
        areaEmptyTitle: 'まだピン留めはありません',
        areaEmptyReason: 'ウィジェットをピン留めすると、ここにあなた専用で残ります。',
        areaEmptyAction: 'ウィジェットを追加',
        areaUnavailableTitle: 'ここではウィジェットを読み込めません',
        areaScopeRecovery: 'このページを開き直して、現在のHomeとアカウントのウィジェットを読み込んでください。',
        projectSourceUnavailableTitle: 'このプロジェクトのリポジトリが判明すると、ここにウィジェットが表示されます',
        areaWriteFailed: 'この変更を保存できませんでした',
        areaApprovalPending: '承認待ち',
        refusals: {
            areaUnavailable: "ここでは現在ウィジェットを利用できません。しばらくしてからもう一度お試しください。",
            writeUnconfirmed: "Home から確認が返りませんでした。エリアを確認して、もう一度お試しください。",
            inputsAccessDenied: "このセッションは読み取れないため、ウィジェットに表示できません。",
            inputsChoiceGone: "この選択肢はもう利用できません。別のものを選んでください。",
            inputsChoicesUnavailable: "このウィジェットの選択肢を読み込めませんでした。しばらくしてからもう一度お試しください。",
            inputsInvalid: "無効な入力があります。内容を確認して、もう一度お試しください。",
            typeUnavailable: "このウィジェットは利用できなくなりました。別のものを選んでください。",
            sizeUnsupported: "このウィジェットではそのサイズを利用できません。別のサイズを選んでください。",
            editDenied: "ここではウィジェットを変更できません。",
        },
        valueNotFound: ({ value }) => `${value} が見つかりません`,
        chooseAnother: ({ field }) => `別の${field}を選択`,
        chooseField: ({ field }) => `${field}を選択`,
        widgetOptions: 'ウィジェットのオプション',
        moveTo: '移動…',
    } } satisfies Pick<Readonly<Record<string, WidgetAddTranslation>>, "ja">;

return { widgetAddTranslations };
})();

const Domain_widgetDefinitionTranslations = (() => {
type WidgetDefinitionTranslation = Shared_widgetDefinitionTranslations.WidgetDefinitionTranslation;

const widgetDefinitionTranslations = { ja: {
        yourWidgets: "あなたのウィジェット",
        yourWidgetsHint: "あなたやエージェントが作成",
        yourWidget: "あなたのウィジェット",
        moreInSource: "ソースには表示以上のデータがあります。",
        notCurrent: "最新ではありません",
        aboutMenu: "このウィジェットについて",
        aboutTitle: "このウィジェットについて",
        aboutUnavailable: "このウィジェットは現在開けません。",
        aboutData: "データ",
        aboutReads: "読み取り",
        aboutInputs: "入力",
        aboutRefresh: "更新",
        aboutUsedIn: "使用場所",
        savedFromSession: ({ session }) => `${session} から保存`,
        aSession: "セッション",
        madeInYourAccount: "あなたのアカウントで作成",
        edited: ({ time }) => `${time} に編集`,
        readsOnly: "読み取りのみ",
        runsOn: ({ machine }) => `${machine} で実行`,
        withYourConnection: "あなた自身の接続を使用",
        readsResource: ({ read, plugin }) => `${plugin} の ${read}`,
        cannotRunAnythingElse: "このウィジェットはこれ以外を実行できません。",
        inputsThisCopy: "このコピーのみ",
        refreshWhenOpen: "開いたとき",
        refreshNow: "今すぐ更新",
        refreshing: "更新中…",
        refreshed: "更新しました",
        refreshFailed: "更新できませんでした。前回の数値を表示しています。",
        placedOnHome: "ホーム",
        placedOnABoard: "ボード",
        placedInASession: "セッション",
        placedInAProject: "プロジェクト",
        placedOnAPluginPage: "プラグインのページ",
        placedOnACorePage: "アプリのページ",
        notPlacedYet: "まだどこにも配置されていません",
        otherPlacesNotListed: "他のデバイスや共有面での配置はここに表示されません。",
        editsChangeAll: ({ count }) => `ウィジェットを編集すると ${count} か所すべてが変わります`,
        editsChangeEverywhere: "ウィジェットを編集すると使用中のすべての場所で変わります",
        changeWithAgent: "エージェントで変更",
        changeDraft: ({ widget }) => `「${widget}」ウィジェットを次のように変更して: `,
        duplicate: "複製",
        duplicated: ({ name }) => `コピー「${name}」をあなたのウィジェットに保存しました`,
        duplicateFailed: "コピーを作成できませんでした。もう一度お試しください。",
        saveMenu: "自分のウィジェットとして保存…",
        visualSaveTitle: "アーティファクトとして保存",
        visualSaveHint: "共有前にコピーを保存します。このセッションには元のビジュアルが残ります。",
        visualShareTitle: "共有",
        visualSaveMenu: "アーティファクトとして保存…",
        visualShareMenu: "リンクを共有…",
        visualSavedCopy: "独立したコピーとしてアカウントに保存しました。公開リンクの作成は別途選択します。",
        visualSaveFailed: "コピーを保存できませんでした。セッションのビジュアルは残っています。",
        saveMenuSubtitle: "ホームやボード用のコピー",
        saveTitle: "自分のウィジェットとして保存",
        saveHint: "ホーム、ボード、プロジェクトに置けるコピーです。このセッションには元のものが残ります。",
        saveNote: "あなたのアカウントに保存 · あなただけ",
        saveWidget: "ウィジェットを保存",
        saveFailed: "ウィジェットを保存できませんでした。もう一度お試しください。",
        savedButNotPlaced: "あなたのウィジェットに保存しましたが、選んだすべての場所には追加できませんでした。",
        savedAsYours: ({ name }) => `「${name}」をあなたのウィジェットに保存しました`,
        name: "名前",
        nameNeeded: "名前を付けてください",
        becomesViewerInput: "入力になります: 各場所であなたの接続を使用",
        becomesContextInput: "入力になります: 各場所で個別に選択",
        alsoAddTo: "追加先",
        anotherPlace: "別の場所…",
        snapshotMenu: "このボードにスナップショットを投稿…",
        snapshotMenuSubtitle: "ここにいる全員に今の数値が見えます",
        snapshotTitle: "全員にスナップショットを投稿しますか?",
        snapshotHint: ({ widget, time }) => `このセッションを開ける人は誰でも ${time} 時点の ${widget} を見られます。更新されず、あなたの接続はあなたのままです。`,
        postSnapshot: "スナップショットを投稿",
        snapshotNotCurrent: "ウィジェットはまだ最新の数値を取得中です。取得できたらもう一度お試しください。",
        snapshotFailed: "スナップショットを投稿できませんでした。何も共有されていません。",
        snapshotAwaitingApproval: "受信トレイで承認待ちです。承認されるまで何も共有されません。",
        snapshotPosted: "スナップショットを投稿しました",
        snapshotNote: "これらの数値のコピーです。更新されません。",
        asOf: ({ time }) => `${time} 時点`,
    } } satisfies Pick<Readonly<Record<string, WidgetDefinitionTranslation>>, "ja">;

return { widgetDefinitionTranslations };
})();

const Domain_widgetFrameTranslations = (() => {
type WidgetFrameTranslation = Shared_widgetFrameTranslations.WidgetFrameTranslation;

const widgetFrameTranslations = { ja: {
        styleCard: 'カード',
        stylePlain: 'プレーン',
        surfaceHome: 'ホーム',
        surfaceBoard: 'ボード',
        surfaceCompanion: 'コンパニオン',
        showFrame: '枠を表示',
        hideFrame: '枠を隠す',
        thisWidgetOnly: 'このウィジェットのみ',
        surfaceUses: ({ surface, style }) => `${surface} は${style}`,
        useSurfaceDefault: ({ surface }) => `${surface} の既定に戻す`,
        likeTheOthers: ({ style }) => `${style}（ほかと同じ）`,
        appearanceTitle: 'ウィジェット',
        appearanceDescription: 'このデバイスでのウィジェットの枠の表示方法です。個別に変えるには、そのウィジェットの ⋯ メニューを使います。',
        previewLabel: ({ surface, style }) => `${surface} · ${style}`,
        noticeChanged: '枠を変更しました',
        newChip: '新着',
        groupInputs: "入力…",
        groupInputsValue: ({ field, value }) => `${field}：${value}`,
        groupWidth: "幅",
        widthHalf: "半分",
        widthFull: "全幅",
        groupFrame: "フレーム",
        groupDividers: "区切り線",
        dividersLines: "線",
        dividersNone: "なし",
        groupSave: "グループを保存…",
        groupSaveSubtitle: "「あなたのウィジェット」に保存して、どこにでも追加",
        ungroup: "グループ解除",
        ungroupSubtitle: ({ count }) => `${count} 個のウィジェットはここに残り、それぞれ自分のカードに戻ります`,
        groupRemove: "グループとウィジェットを削除",
        moveToGroup: "グループへ移動",
        removeFromGroup: "グループから外す",
        removeFromGroupSubtitle: "自分のカードに戻り、グループの隣に置かれます",
        groupWith: "グループにする…",
        groupWithNew: "2 つで新しいグループ",
        groupSlot: "ここにウィジェットをドロップ、または",
        groupSlotAdd: "追加",
        groupUntitled: "無題のグループ",
        groupName: "グループ名",
        groupMenu: "グループのオプション",
        followingGroup: "グループに従う",
        followingGroupValue: ({ value }) => `グループに従う · ${value}`,
        groupInputsTitle: ({ group }) => `${group} · 入力`,
        groupInputsHint: "一度設定すれば、グループに従うウィジェットが使います。",
        groupFollowCount: ({ following, count }) => `${count} 個中 ${following} 個がグループに従っています`,
        groupFollows: "従う",
        groupOwnValue: "独自の値",
        groupGrantsNothing: "グループは何も許可しません。各ウィジェットは引き続き自分のアクセスを確認します。",
        groupSaved: ({ name }) => `${name} を「あなたのウィジェット」に保存しました`,
        groupSaveFailed: "グループを保存できませんでした。もう一度お試しください。",
        moveIntoGroupNamed: ({ group }) => `${group} に移動`,
        intoGroupAbove: ({ target }) => `${target} の上 · グループ内では枠なしで表示`,
        intoGroupBelow: ({ target }) => `${target} の下 · グループ内では枠なしで表示`,
        intoGroupEnd: "グループ内では枠なしで表示",
        intoGroupKeepsSize: ({ size }) => `サイズは${size}のまま`,
        reorderInGroupDetail: "順序のみ",
        outOfGroupDetail: ({ group }) => `${group} の外へ · 自分のカードに戻ります`,
        wholeGroupDetail: ({ count }) => count === 1 ? `ウィジェットも一緒に移動します` : `${count} 個のウィジェットも一緒に移動します`,
        cantPutInGroup: ({ group }) => `${group} には入れられません`,
        groupRefusedWidth: "全幅が必要ですが、このグループは半分です。隣に置くか、グループを全幅にしてください。",
        groupRefusedNesting: "グループの中にグループは置けません。上か下にドロップするか、先にグループを解除してください。",
        groupRefusedNestingNamed: ({ group, target }) => `グループの中にグループは置けません。${group}を${target}の上か下にドロップするか、先にグループを解除してください。`,
        groupNeedsFullWidth: ({ widget }) => `${widget} は全幅が必要です`,
        groupFacts: ({ width, count }) => `${width} · ${count} 個`,
        groupCannotTake: ({ group }) => `全幅が必要です。${group} は半分です`,
        groupA11y: ({ name }) => `グループ: ${name}`,
        groupCount: ({ count }) => `グループ · ${count}`,
        groupCopyOf: ({ count, index, total }) => `グループ · ${count} · コピー ${index}/${total}`,
        groupNameCopyOf: ({ name, index, total }) => `${name} · コピー ${index}/${total}`,
        groupWidgetCount: ({ count }) => `グループ · ウィジェット ${count} 個`,
        addsAtWidth: ({ width }) => `幅「${width}」で追加します。`,
        presetEdited: "編集済み",
        presetEditedTail: ({ changes }) => changes ? ` はあなた用になりました（${changes}）。プリセットは残っています。` : ' はあなた用になりました。プリセットは残っています。',
        presetChangeList: ({ first, second, more }) => more > 0 ? `${first}、${second}、ほか ${more} 件` : second ? `${first}、${second}` : first,
        presetMovedUp: ({ item }) => `${item} を上へ移動`,
        presetMovedDown: ({ item }) => `${item} を下へ移動`,
        presetAdded: ({ item }) => `${item} を追加`,
        presetRemoved: ({ item }) => `${item} を削除`,
        presetChanged: ({ item }) => `${item} を変更`,
        presetRenamed: "名前を変更",
        groupProvenance: ({ origin, date, count }) => ['あなたのグループ', origin && date ? `${origin} から ${date} に保存` : date ? `${date} に保存` : origin ? `${origin} から保存` : null, `ウィジェット ${count} 個`].filter(Boolean).join(' · '),
        groupAddsFollowing: ({ name, count, value }) => `${name} とそのウィジェット ${count} 個を追加します${value ? `（${value} に従います）` : ''}`,
        groupInputAskedOnce: ({ count }) => `一度だけ尋ねます。${count} 個のウィジェットがそれに従います。`,
        presetReset: "プリセットに戻す",
        presetResetDone: ({ name }) => `${name} をプリセットに戻しました`,
        presetResetFailed: "プリセットに戻せませんでした。",
        undo: "元に戻す",
        groupAddTo: "追加先…",
        groupAddToSubtitle: "別のホームやプロジェクトにコピー",
        groupCopied: ({ name, place }) => `${name} を ${place} にコピーしました`,
        groupCopyFailed: "グループをコピーできませんでした。もう一度お試しください。",
        groupSaveTitle: "グループを保存",
        groupSaveHint: ({ count }) => `${count} 個のウィジェットごと「あなたのウィジェット」に保存し、どこにでも追加できます。`,
        groupSaveNote: "コピーです。このグループはそのまま残ります。",
    } } satisfies Pick<Readonly<Record<string, WidgetFrameTranslation>>, "ja">;

return { widgetFrameTranslations };
})();

const Domain_widgetGlanceTranslations = (() => {
type WidgetGlanceTranslation = Shared_widgetGlanceTranslations.WidgetGlanceTranslation;

const widgetGlanceTranslations = { ja: {
        changesTitle: '変更',
        localServicesTitle: 'ローカルサービス',
        changesSource: 'Git',
        reviewChanges: '変更を確認',
        notARepo: 'このセッションのフォルダーは Git リポジトリではありません。',
        noChanges: 'まだ変更はありません。エージェントが編集したファイルがここに表示されます。',
        changesLoading: '変更を読み込んでいます',
        running: '実行中',
        notRunning: '停止中',
        nothingRunning: '実行中のものはありません。このセッションが起動したサービスがここに表示されます。',
        servicesLoading: 'ローカルサービスを読み込んでいます',
        servicesReadFailed: 'ローカルサービスを読み込めませんでした。もう一度お試しください。',
        noMachine: 'このセッションには問い合わせるマシンがありません。',
        changedCount: ({ count }) => `${count} 件変更`,
        moreFiles: ({ count }) => `ほか ${count} ファイル`,
        runningCount: ({ count }) => `${count} 件実行中`,
        openInBrowser: ({ name }) => `${name} をブラウザーで開く`,
        paneLinkA11y: ({ pane }) => `${pane}。チャットの横に開きます`,
    } } satisfies Pick<Readonly<Record<string, WidgetGlanceTranslation>>, "ja">;

return { widgetGlanceTranslations };
})();

const Domain_workStatusTranslations = (() => {
type WorkStatusTranslations = Shared_workStatusTranslations.WorkStatusTranslations;

const en = Shared_workStatusTranslations.en;

const ja: WorkStatusTranslations = {
    buckets: {
        needs_you: '対応待ち',
        working: '作業中',
        finished: '完了',
        idle: 'アイドル',
        offline: 'オフライン',
    },
    words: {
        permission: '許可',
        question: '質問',
    },
};

const workStatusTranslations = { ja: { ...ja, task: { stopped: '停止', linkFailed: 'セッションは作成されましたが、タスクへのリンクは保存されませんでした。再試行すると同じセッションをリンクします。' } } };

return { workStatusTranslations };
})();

const Domain_workflowActionTranslations = (() => {
type Copy = Shared_workflowActionTranslations.Copy;

const en = Shared_workflowActionTranslations.en;

const workflowActionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "ja"> = { ja: {
        host: "Happier",
        structure: "構造",
        callWebhook: "Webhook を呼び出す",
        runCommand: "コマンドを実行",
        commandValuesInEnv: "ワークフローの値は環境変数で渡します。コマンドのテキストは記述したまま実行されます。",
        waitForWork: "作業を待つ",
        waitForWorkDescription: "選んだ作業が指定した状態になるまで待ちます",
        callWebhookDescription: "Web アドレスにリクエストを送信します。エージェントのターンはありません。",
        runCommandDescription: "マシンでシェルコマンドを実行します。エージェントのターンはありません。",
        artifactCreate: "ドキュメントを作成",
        artifactGet: "ドキュメントを読む",
        artifactList: "ドキュメント一覧",
        artifactUpdate: "ドキュメントを更新",
        artifactDelete: "ドキュメントを削除",
        artifactPublish: "ファイルを公開",
        artifactRevisions: "ドキュメントのバージョン一覧",
        artifactRestore: "ドキュメントのバージョンを復元",
        artifactUsage: "ドキュメントのストレージ使用量を確認",
        artifactShare: "リンクでドキュメントを共有",
        artifactLinks: "ドキュメントのリンク一覧",
        artifactRevoke: "ドキュメントのリンクを無効化",
        artifactAudit: "ドキュメントのリンクの利用状況を確認",
        sessionRole: "セッションのロールを設定",
        sessionRoleOverride: "セッションのロール設定を変更",
        sessionRoleClear: "セッションのロール設定をリセット",
        sessionRoleAdd: "セッションのロールを追加",
        sessionRoleRemove: "セッションのロールを削除",
        sessionNotes: "セッションのメモを設定",
        sessionRolesApply: "配下のセッションにロールを適用",
        roleList: "ロール一覧",
        roleGet: "ロールを読む",
        roleCreate: "ロールを作成",
        roleUpdate: "ロールを更新",
        roleDelete: "ロールを削除",
        roleOverride: "ロール設定を変更",
        roleReset: "ロール設定をリセット",
        widgetCatalog: "利用可能なウィジェット一覧",
        widgetInstances: "配置済みのウィジェット一覧",
        widgetAdd: "ウィジェットを追加",
        widgetRemove: "ウィジェットを取り外す",
        widgetMove: "ウィジェットを移動",
        widgetRename: "ウィジェットの名前を変更",
        widgetSize: "ウィジェットのサイズを設定",
        widgetFrame: "ウィジェットの枠を設定",
        widgetInputs: "ウィジェットの入力を読む",
        widgetValidate: "ウィジェットの入力を確認",
        widgetSetInputs: "ウィジェットの入力を設定",
        widgetResetInputs: "ウィジェットの入力をリセット",
        widgetLayout: "ウィジェットの配置を読む",
        widgetUpdateLayout: "ウィジェットの配置を変更",
        widgetDefinitions: "保存済みのウィジェット一覧",
        widgetDefinition: "保存済みのウィジェットを読む",
        widgetCreate: "ウィジェットを作成",
        widgetUpdate: "保存済みのウィジェットを更新",
        widgetDuplicate: "保存済みのウィジェットを複製",
        widgetDelete: "保存済みのウィジェットを削除",
        widgetSave: "セッションのウィジェットを保存",
    } };

return { workflowActionTranslations };
})();

const Domain_workflowAgentAuthoringTranslations = (() => {
type Edit = Shared_workflowAgentAuthoringTranslations.Edit;

type RepeatableMessage = Shared_workflowAgentAuthoringTranslations.RepeatableMessage;

type Copy = Shared_workflowAgentAuthoringTranslations.Copy;

const en = Shared_workflowAgentAuthoringTranslations.en;

const repeatable = { ja: { repeatable: '繰り返し使えるようにする', repeatableDescription: 'ここでうまくいった作業を再利用できるワークフローにするよう依頼します。', repeatablePrompt: 'ここでの作業を、もう一度実行できるワークフローにしてください。作成し、workflow.validate で検証して保存してください。実行はしないでください。', repeatableMessagePrompt: 'このメッセージでの作業を、もう一度実行できるワークフローにしてください。作成し、workflow.validate で検証して保存してください。実行はしないでください。', repeatableMessageSource: ({ text }: RepeatableMessage) => `“${text}”` } };

const workflowAgentAuthoringTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "ja"> = { ja: { ...repeatable.ja, create: 'エージェントと作成', edit: 'エージェントと編集', agent: 'エージェント', description: '新しいセッションがあなたと一緒にワークフローを作成し、検証して保存します。「今すぐ実行」を選ぶまで何も実行されません。', changedByAgent: 'エージェントが変更', saved: 'エージェントが今保存しました', savedAge: ({ age }) => `エージェントが保存 · ${age}`, savedWorkflow: ({ name }) => `ワークフローを保存 · ${name}`, updated: 'ワークフローを更新', changed: ({ count }) => `ワークフローを更新 · ${count} ステップ変更`, openEditor: 'エディターで開く', openSession: 'セッションで開く', createPrompt: '一緒にワークフローを作成し、workflow.validate で検証してから保存してください。実行はしないでください。', createLead: '次のようなワークフローの作成を手伝ってください：', editPrompt: ({ name, definitionId, headerVersion, bodyVersion }) => `保存済みワークフロー「${name}」の id は ${definitionId}、リビジョンはヘッダー ${headerVersion}、本文 ${bodyVersion} です。workflow.definition.edit で変更し、全体を置き換えるときだけ workflow.definition.update を使ってください。保存前に workflow.validate で検証してください。実行はしないでください。`, editLead: ({ name }) => `${name} の変更を手伝ってください：` } };

return { repeatable, workflowAgentAuthoringTranslations };
})();

const Domain_workflowBuiltinTranslations = (() => {
type WorkflowBuiltinTranslations = Shared_workflowBuiltinTranslations.WorkflowBuiltinTranslations;

const en = Shared_workflowBuiltinTranslations.en;

const ja: WorkflowBuiltinTranslations = {
    keepGoing: { title: '完了まで続ける', description: '目標を達成するまで続けます' },
    reviewAndConverge: { title: 'レビューして収束', description: 'レビュアーが合意するまでレビュー', apply: '適用', verifyAndFix: '検証して修正', verifyOnly: '検証のみ', rounds: '停止までのラウンド数', inputs: { engines: "レビュアー", reviewSession: "レビューするセッション" } },
    planWithAPanel: { title: "パネル", description: '複数のエージェントが並行して計画し、計画はあなたのレビューを待ちます。', inputs: { request: '依頼内容', requestPlaceholder: 'パネルに何を計画させますか？', engines: '計画するエージェント' } },
    freshOpinions: { title: '独立した意見', description: '同じ質問にそれぞれ独立して回答します。必要に応じて要約も作成します。' },
    answerAndReview: { title: '回答 + レビュー', description: '1人のエージェントが回答し、別のエージェントがその回答をレビューします。' },
    debate: { title: '討論', description: '選んだラウンド数で意見を比較し、各ラウンドの後に要約します。' },
    patternInputs: { question: '質問', participants: '参加者', synthesis: '回答を要約する', synthesizer: '要約するエージェント', answerer: '回答するエージェント', reviewer: 'レビューするエージェント', rounds: 'ラウンド数', digestAuthor: '各ラウンドを要約するエージェント', previousRoundContext: '前のラウンド' },
    openAPullRequest: { title: 'プルリクエストを開く', description: 'セカンドオピニオンを求めてからプルリクエストを開きます。意見が合わない場合はあなたを待ちます。', inputs: { base: 'ベースブランチ', title: 'プルリクエストのタイトル', body: '説明', question: 'セカンドオピニオンへの質問' } },
};

const workflowBuiltinTranslations = { ja } as const;

return { workflowBuiltinTranslations };
})();

const Domain_workflowFieldTranslations = (() => {
const workflowFieldTranslations = { ja: {
        sessionId: "セッション",
        triggerId: "トリガー",
        engineIds: "レビュー担当",
        backendTargetKeys: "計画担当",
        reviewCommentAuthorIntent: "指摘",
        commentId: "指摘",
        expectedServerRevision: "指摘の版",
        clientMutationId: "更新",
        projectId: "プロジェクト",
        workspace: "ワークスペース",
        toState: "状態",
        expectedState: "現在の状態",
        disposition: "重要度",
        allPages: "すべての指摘",
        permissionMode: "権限",
        target: "実行先",
        cwd: "作業フォルダー",
        maxRounds: "最大ラウンド数",
        strikes: "進展のないチェック数",
        secondOpinion: "セカンドオピニオン",
        useJudge: "判定役",
        diffFingerprint: "確認済みの変更",
        url: "URL",
        body: "JSON 本文",
        command: "コマンド",
        env: "環境変数",
    } };

return { workflowFieldTranslations };
})();

const Domain_workflowEditorPageTranslations = (() => {
type WorkflowEditorPageTranslations = Shared_workflowEditorPageTranslations.WorkflowEditorPageTranslations;

const workflowFieldTranslations = {...Domain_workflowFieldTranslations.workflowFieldTranslations, ...EnglishFeatures.workflowFieldTranslations.workflowFieldTranslations};

const en = Shared_workflowEditorPageTranslations.en;

const pluralPl = Shared_workflowEditorPageTranslations.pluralPl;

const pluralRu = Shared_workflowEditorPageTranslations.pluralRu;

const ja: WorkflowEditorPageTranslations = {
    fields: workflowFieldTranslations.ja,
    blocks: {
        actionSub: 'アクション · エージェントのターンなし',
        notSet: '未設定',
        set: '設定',
        clear: 'クリア',
        required: '必須',
        noFields: 'このアクションで設定する項目はありません。',
        workflowSub: '別のワークフローを実行 · そのステップはこの実行に表示されます',
        builtin: '組み込み',
        waitTitle: 'あなたを待つ',
        waitSub: 'このレーンはあなたが続けるまで待ちます',
        waitSubRoot: '続行するまでこのワークフローは待機します',
        waitPlaceholder: 'ここで何を確認または判断しますか？',
        returnsText: 'テキストを返す',
        returnsFields: ({ fields }) => `返す値: ${fields}`,
        workflowDefaults: 'ワークフローの既定',
        addNamedResults: '名前付きの結果を追加',
        editInputs: '入力を編集',
        menuRun: 'ワークフローを実行',
        menuAction: 'アクション',
        menuWait: 'あなたを待つ',
        actionSearch: 'アクションを検索',
        workflowSearch: 'ワークフローを検索',
        libraryGroup: 'あなたのワークフロー',
        noAgentTurn: '通知・レビュー・投稿 — エージェントのターンなし',
        agentSub: 'エージェントへの指示',
        parallelSub: '同時に実行する分岐',
        loopSub: '各項目、指定回数、または条件を満たすまで…',
        ifSub: '結果が条件を満たす場合のみ',
        actionSourcePhone: 'あなたのスマートフォン',
        actionSourceReview: 'レビューエンジン',
        useNumber: '数値を使う',
        actionUnavailable: ({ action }: { action: string }) => `${action} はここでは利用できません。`,
        childInputs: ({ workflow }: { workflow: string }) => `入力は ${workflow} から受け取ります。`,
        retryLoading: "読み込みを再試行",
        openWorkflow: ({ workflow }) => `${workflow} を開く`,
        selfRef: ({ workflow }: { workflow: string }) => `${workflow} はこのワークフローを実行するため、その中では実行できません。`,
        fromInput: ({ name }: { name: string }) => `入力から · ${name}`,
        useInput: ({ name }: { name: string }) => `入力 ${name} を使う`,
    },
    backToRun: '実行に戻る',
    reviewedCopyTitle: '保存前に確認',
    reviewedCopyBody: 'これは実行からのコピーです。保存対象はステップと設定で、実行履歴や結果は含みません。実行場所、実行方式、入力値は実行ごとの選択です。既存のセッション、フォルダ、プロファイル、モデル、サービス、MCPサーバーへの参照を再利用前に確認してください。',
    chromeTitle: 'ワークフロー',
    untitled: '無題のワークフロー',
    nameLabel: 'ワークフロー名',
    descriptionPlaceholder: '説明を追加',
    descriptionLabel: '説明',
    save: '保存',
    flow: 'フロー',
    flowSubtitle: 'この下書きをマップで表示',
    settings: 'ワークフローの設定',
    settingsSubtitle: '各ステップは変更しない限りこれを使います。',
    deleteWorkflow: 'ワークフローを削除',
    deleteBody: '過去の実行は保持されます。',
    discardChangesBody: '最後に保存したバージョンに戻ります。元に戻すで変更を復元できます。',
    deleteFailedTitle: 'ワークフローを削除できませんでした',
    changedForStep: 'このステップで変更',
    issuesToFix: ({ count }: { count: number }) => (count === 1 ? '実行の前に直す点が 1 件あります' : `実行の前に直す点が ${count} 件あります`),
    readyToRun: '準備完了',
    saveStatus: {
        notSaved: 'まだ保存されていません',
        unsaved: '未保存の変更',
        saving: '保存中…',
        saved: '保存済み',
        savedJustNow: 'たった今保存しました',
        savedAge: ({ age }: { age: string }) => `保存済み · ${age}`,
        failed: '保存できませんでした',
        yourEdits: 'あなたの編集',
        newerVersion: '新しいバージョン',
        newerVersionRevision: ({ revision }: { revision: string }) => `新しいバージョン · ${revision}`,
    },
    where: {
        label: '実行場所',
        choose: '実行場所を選択',
    },
    sections: {
        whereTitle: '実行場所',
        machineAndProject: 'マシンとプロジェクト',
        eachStepRunsIn: '各ステップの実行先',
        eachStepSession: '各ステップはこの実行の下で、セッション一覧に表示されます。',
        eachStepBackground: '各ステップはこの実行の下で、バックグラウンドで実行されます。',
        aSession: 'セッション',
        aBackgroundRun: 'バックグラウンド実行',
        agentTitle: 'エージェントとモデル',
        agentDescription: '各ステップは独自に選ばない限りこれを使います。',
        rolesTitle: 'このワークフローのロール',
        conversationTitle: '会話とワークスペース',
        inputsTitle: '入力と出力',
    },
    unavailable: {
        machine_not_selected: '先にマシンを選んでください。',
        capability_unknown: 'このマシンの対応状況を確認しています。',
        machine_does_not_support_detached_runs: 'このマシンはまだバックグラウンド実行に対応していません。',
    },
    /** Workflow settings and Step options (U-9): group summaries and the block subject. */
    inspector: {
        stepOptions: 'ステップのオプション',
        whereMissing: 'マシン未選択',
        none: 'なし',
        inputCount: ({ count }) => `入力 ${count} 件`,
        finalOutput: ({ output }) => `最終出力: ${output}`,
        originSession: '開始したセッション',
        differsFromWorkflow: 'ワークフローと異なる',
        followsWorkflow: 'ワークフローの設定を使用',
        advancedTitle: '詳細',
        deadline: ({ ms }) => `結果を ${ms} ミリ秒待つ`,
        workflowDefault: ({ value }) => `ワークフローの既定 · ${value}`,
        aSession: 'セッション…',
        continues: ({ session }) => `${session} を続ける`,
        runsIn: '実行先',
        runsInBoundBySession: 'セッションを続けるため、そのセッションで実行されます。',
        reviewTitle: '続行前に確認',
        reviewDescription: 'このレーンの後続ステップは、結果を使う・編集する・再生成するまで待機します。ほかの作業は続きます。',
        reviewEvaluator: '各反復はあなたの確認を待ちます。',
        reviewsBeforeContinuing: '続行前に確認',
        resultTitle: '結果',
        resultFromAction: ({ action }) => `${action} が定義`,
        resultFromWorkflow: ({ workflow }) => `${workflow} の戻り値を返す`,
        back: '戻る',
        options: 'オプション',
        itemConversation: '項目ごとに別の会話。内部のステップはそれを共有します。',
        dropContinue: ({ session }) => `このステップで ${session} を続ける`,
        dropRefused: ({ session, machine, where }) => `${session} は ${machine} 上にあります。このワークフローは ${where} で実行されます。`,
        lanes: ({ count }) => `並列 · ${count} レーン`,
        laneCount: ({ count }) => `${count} レーン`,
        lane: ({ position }) => `レーン ${position}`,
        forEachIn: ({ source }) => `${source} の各項目について`,
        atATime: ({ count }) => `同時に ${count}`,
        repeatTimes: ({ count }) => `${count} 回繰り返す`,
        repeatUntil: ({ condition }) => `${condition} まで繰り返す`,
        repeatUntilDecided: 'ステップが停止と言うまで繰り返す',
        ifSentence: ({ condition }) => `${condition} の場合`,
        onlyWhenSentence: ({ condition }) => `${condition} の場合のみ`,
        conditionAll: 'すべて満たす',
        conditionAny: 'いずれかを満たす',
        conditionMore: ({ count }: { count: number }) => `他 ${count} 件`,
        conditionNot: ({ condition }) => `(${condition}) ではない`,
        returnsStructured: '構造化データを返す',
        returnsDecision: '判断を返す',
        resultFields: {
            description: '後のステップで使えるもの。',
            named: '名前付きフィールド',
            returns: '返す内容',
            describeWhole: 'ひとつの返答をそのまま使います',
            add: 'フィールドを追加',
            name: '名前',
            type: '種類',
            required: '必須',
            optional: '任意',
            descriptionLabel: '説明',
            descriptionPlaceholder: 'このフィールドの内容',
            choices: '選択肢',
            addChoice: '選択肢を追加',
            noChoices: '選択肢を1つ以上追加してください。',
            items: '項目',
            typeBoolean: 'はい/いいえ',
            typeText: 'テキスト',
            typeNumber: '数値',
            typeChoice: '選択',
            typeList: 'リスト',
            describeBoolean: '後のステップの分岐に使える判断',
            describeText: '文章、要約、メモ',
            describeNumber: '件数やスコア',
            describeChoice: '指定した値のいずれか',
            describeList: '複数の項目。繰り返しで順に処理できます',
            itemsText: 'テキスト',
            itemsNumber: '数値',
            itemsBoolean: 'はい/いいえ',
            finalOutput: '最終出力',
            renameEverywhere: 'すべての場所で名前を変更',
            remove: 'フィールドを削除',
            useTextTitle: '代わりにテキストを返しますか？',
            useText: 'テキストを返す',
            nameInvalid: '英字で始め、英数字、- または _ を使ってください。',
            nameTaken: '同じ名前のフィールドがすでにあります。',
            advanced: 'この結果は高度な形式を使っています。JSON のインポートまたはエクスポートで編集してください。',
            wholeResult: '結果全体',
            otherPath: '別のパス…',
            field: 'フィールド',
            summary: ({ fields }: { fields: string }) => `名前付きフィールド · ${fields}`,
            listOf: ({ items }: { items: string }) => `${items} のリスト`,
            usedBy: ({ names }: { names: string }) => `${names} が使用`,
            removeTitle: ({ field }: { field: string }) => `${field} を削除しますか？`,
            renameTitle: ({ from, to }: { from: string; to: string }) => `${from} を ${to} に変更しますか？`,
            renameBody: ({ names, to }: { names: string; to: string }) => `${names} は ${to} を読むようになります。`,
            removeBody: ({ count }: { count: number }) => `使用箇所: ${count}。別のソースが必要になります。`,
            useTextBody: ({ count }: { count: number }) => `後のステップがこれらのフィールドを読んでいます（${count}）。別のソースが必要になります。`,
        },
    },
};

const workflowEditorPageTranslations = { ja } as const;

return { workflowEditorPageTranslations };
})();

const Domain_workflowExamplesTranslations = (() => {
type ExampleCopy = Shared_workflowExamplesTranslations.ExampleCopy;

type Copy = Shared_workflowExamplesTranslations.Copy;

const workflowExamplesTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "ja"> = { ja: {
        sessionNotifyDescription: "このセッションのエージェントがあなたの入力を必要とするたびに通知します。",
        sessionDailySummaryDescription: "毎日09:00にここで要約します。",
        sessionTestDescription: "ターンが完了・失敗・キャンセルされるたびに、編集可能なテストコマンドを実行します。",
        newTag: "新着",
        notifyWhenAgentWaits: { title: "エージェントが待機したら通知する", description: "セッションを選ぶと、エージェントがあなたの入力を必要とするたびに通知されます。" },
        dailySummaryInSession: { title: "このセッションで毎日の要約", description: "毎日09:00に要約を受け取るセッションを選びます。" },
        memoryUpkeepInSession: { title: 'メモリの整理', description: '毎週日曜日09:00にこのセッションのメモリを確認し、役立つ情報を最新に保ちます。' },
        installDepsInWorktree: { title: "新しいワークツリーに依存関係をインストール", description: "新しいワークツリーを作成し、そこで編集可能なインストールコマンドを実行します。" },
        testAfterEveryTurn: { title: "各ターンの後にテスト", description: "セッションを選び、ターンが完了・失敗・キャンセルされるたびに編集可能なテストコマンドを実行します。" },
        noSessions: "このテンプレートを使うには作業セッションを開始してください。",
        nodes: { ask: '質問', 'review-correctness': '正確性をレビュー', 'review-tests': 'テストをレビュー', summarize: '指摘をまとめる', analyze: '分析', review: 'レビュー', fix: '修正', check: '確認', classify: '分類', reply: '返信を作成', digest: '変更をまとめる' },
        title: '例から始める', fromExample: '例から', description: 'どれも下書きとして開きます。「今すぐ実行」を選ぶまで実行されません。', sessionDescription: 'どれもこのセッションの下書きとして開きます。オンにするまで実行されません。', use: 'これを使う', chooseSession: 'セッションを選択…', builtInDescription: 'Happierに組み込まれています。変更するには複製してください。', stepCount: ({ count }) => `${count} ステップ`,
        askOnce: { title: '一度だけ質問', description: '1ステップ：エージェントに質問して回答を受け取ります。' },
        reviewPullRequest: { title: 'プルリクエストをレビュー', description: '2人が並行でレビューし、すべての指摘をまとめます。' },
        workThroughEachFile: { title: '各ファイルを処理', description: 'リストの各ファイルを1つずつ分析し、変更をレビューします。' },
        repairUntilItPasses: { title: '合格するまで修正', description: 'チェックに合格するか指定回数に達するまで修正と確認を繰り返し、最後の修正をレビューします。' },
        triageAnIssue: { title: '課題を分類', description: '課題を分類します。バグなら修正し、それ以外は返信を作成します。' },
        morningDigest: { title: '朝のダイジェスト', description: 'プロジェクトの変更をまとめて送ります。毎朝受け取るにはトリガーを追加してください。' },
    } };

return { workflowExamplesTranslations };
})();

const Domain_workflowPluginTranslations = (() => {
type Copy = Shared_workflowPluginTranslations.Copy;

const en = Shared_workflowPluginTranslations.en;

const workflowPluginTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "ja"> = { ja: { fromPlugins: 'プラグインから', readOnly: '読み取り専用 · 編集するにはライブラリに複製', duplicateToLibrary: 'ライブラリに複製' } };

return { workflowPluginTranslations };
})();

const Domain_workflowRunVisibilityTranslations = (() => {
type VisibilityCopy = Shared_workflowRunVisibilityTranslations.VisibilityCopy;

const workflowRunVisibilityTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', VisibilityCopy>, "ja"> = { ja: { title: "公開範囲", chooseTeam: "チームを選択", loadFailed: "この実行を閲覧できる人を確認できませんでした", machines: "あなたのマシンで実行します", transcripts: "チームメンバーは各ステップの会話を閲覧できます。", requiredSessionsEditable: "このチームのセッションはメンバーが編集できます", visibleTo: ({ team }) => "閲覧可能なチーム：" + team } };

return { workflowRunVisibilityTranslations };
})();

const Domain_workflowRunCompositionTranslations = (() => {
const workflowRunVisibilityTranslations = {...Domain_workflowRunVisibilityTranslations.workflowRunVisibilityTranslations, ...EnglishFeatures.workflowRunVisibilityTranslations.workflowRunVisibilityTranslations};

const en = Shared_workflowRunCompositionTranslations.en;

const workflowRunCompositionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "ja"> = { ja: { visibility: workflowRunVisibilityTranslations.ja, runWithAnotherAgent: '別のエージェントで再実行', agentForStep: ({ step }) => `${step}のエージェント`, chooseAgent: 'エージェントまたはロールを選択' } };

return { workflowRunCompositionTranslations };
})();

const Domain_workflowRunListTranslations = (() => {
type Progress = Shared_workflowRunListTranslations.Progress;

const en = Shared_workflowRunListTranslations.en;

const workflowRunListTranslations = { ja: {
        definitions: '定義',
        stepsProgress: ({ completed, total }: Progress) => `${total} ステップ中 ${completed} 完了`,
        loopProgress: ({ completed, total }: Progress) => `${total} 項目中 ${completed} 完了`,
        startedByAgent: 'エージェントが開始',
        startedByTrigger: 'トリガーが開始',
    } } satisfies Pick<Record<string, typeof en>, "ja">;

return { workflowRunListTranslations };
})();

const Domain_workflowRunRoleTranslations = (() => {
const en = Shared_workflowRunRoleTranslations.en;

const workflowRunRoleTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "ja"> = { ja: { rolesTitle: 'この実行のロール', rolesYour: 'あなたのロール', rolesChanged: ({ count }) => `この実行で${count}件変更`, rolesUnchanged: 'その他は変わりません。', useYourRole: '自分のロールを使用', targetsTitle: '各ステップの実行先', targetsSessions: 'セッションで実行', targetsBackground: 'バックグラウンドで実行', rolesPrefillFailed: '前回の実行のロールを読み込めませんでした。再試行してください。' } };

return { workflowRunRoleTranslations };
})();

const Domain_workflowStartTranslations = (() => {
type Copy = Shared_workflowStartTranslations.Copy;

const workflowRunRoleTranslations = {...Domain_workflowRunRoleTranslations.workflowRunRoleTranslations, ...EnglishFeatures.workflowRunRoleTranslations.workflowRunRoleTranslations};

const workflowRunCompositionTranslations = {...Domain_workflowRunCompositionTranslations.workflowRunCompositionTranslations, ...EnglishFeatures.workflowRunCompositionTranslations.workflowRunCompositionTranslations};

const en = Shared_workflowStartTranslations.en;

const workflowStartTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "ja"> = { ja: { ...workflowRunRoleTranslations.ja, ...workflowRunCompositionTranslations.ja, capture: { title: "パターンとして保存", subtitle: ({ title }: { title: string }) => `${title} から`, chooseTitle: "作成に使うメッセージ", chooseDescription: "やり取りを構成する質問と回答を選んでください。", chosenCount: ({ count }: { count: number }) => count === 1 ? "1件選択" : `${count}件選択`, emptyTitle: "まだ保存できるものがありません", emptyBody: "ここで人やエージェントが話したら、パターンとして保存するメッセージを選べます。", reviewSteps: "ステップを確認", openInEditor: "エディタで開く", name: "名前", stepsTitle: "ここでの流れから作ったステップ", changeMessages: "メッセージを変更", building: "ステップを作成中…", failedTitle: "ステップを作成できませんでした", needsReview: ({ count }: { count: number }) => count === 1 ? "エディタで開く前に1件のメッセージで選択が必要です" : `エディタで開く前に${count}件のメッセージで選択が必要です`, question: "質問", context: ({ number }: { number: number }) => `コンテキスト ${number}`, answers: ({ name }: { name: string }) => `${name} が回答`, someoneAnswers: "誰かが回答", leftOut: "除外", uses: ({ steps }: { steps: string }) => `${steps} を使用`, usesLabel: "使用するもの", usedAs: "使い方", roleInput: "入力", roleStep: "ステップ", roleExclude: "除外", whoAnswers: "回答者", chooseParticipant: "選択…", askEachRun: "実行ごとに尋ねる", askEachRunOn: "実行…で尋ねます", askEachRunOff: "ここでの内容のまま", askedTitle: "実行するたびに尋ねる項目", askedNone: "なし。保存したとおりに実行します。", agentFor: ({ number }: { number: number }) => `回答者 ${number}`, privacy: ({ count }: { count: number }) => count === 1 ? "未保存のままエディタで開きます。保存すると自分だけに表示され、このメッセージにリンクします。" : `未保存のままエディタで開きます。保存すると自分だけに表示され、これら${count}件のメッセージにリンクします。`, reasons: { unlinked_message: "回答に結び付いていません。入力・ステップ・除外のどれにするか選んでください。", missing_dependency: "含まれていないメッセージを使っています。追加するか、使うものを変更してください。", participant_required: "このステップの回答者を選んでください。", no_steps: "回答がまだ選ばれていません。エージェントの回答を追加してステップにしてください。", unsupported_content: "この種類のメッセージはパターンで再利用できません。除外してください。", ambiguous_workflow: "これらのメッセージは複数の実行から来ています。1つの実行のメッセージを選んでください。" } }, runPattern: '実行…', runPatternTitle: 'パターンを実行', anotherRound: 'もう1ラウンド', participantTitle: '参加者を選択', participantSearch: 'セッションまたはモデルを検索', participantSession: 'それぞれ自身の設定で回答', participantModel: ({ agent, machine }: { agent: string; machine: string }) => `${machine} の新しい ${agent} セッション`, participantDone: '完了', choicesFailed: '選択肢を読み込めませんでした', shortcutStarts: '開始', neededNamed: ({ name }) => `入力 · ${name}が必要`, addToStart: ({ name }) => `開始するには${name}を追加してください`, workflow: 'ワークフロー', inputs: '入力', start: '開始', starting: '開始中…', stillStarting: '引き続き開始中…', retry: { action: 'もう一度試す', start: 'この実行が開始されたか確認できませんでした。もう一度試すと同じリクエストを再送します。二重に開始されることはありません。', runAgain: '「もう一度実行」が開始されたか確認できませんでした。もう一度試すと同じリクエストを再送します。二重に開始されることはありません。', anotherRound: '「もう1ラウンド」が開始されたか確認できませんでした。もう一度試すと同じリクエストを再送します。二重に開始されることはありません。' }, needed: ({ count }) => `入力 · あと${count}項目`, required: '開始に必要', preview: '実行する内容', unsaved: '未保存の変更を含む', remove: '通常のセッションに戻る', search: 'パターンを検索', builtin: '組み込み', library: 'あなたのライブラリ', noInputs: '入力は不要', needsSession: 'セッションが必要', asksFor: ({ names }) => `必要な入力：${names}`, optional: '任意 — 空欄', defaultValue: ({ value }) => `既定値：${value}` } };

return { workflowStartTranslations };
})();

const Domain_workflowsDestinationTranslations = (() => {
type WorkflowsDestinationTranslations = Shared_workflowsDestinationTranslations.WorkflowsDestinationTranslations;

const en = Shared_workflowsDestinationTranslations.en;

const ja: WorkflowsDestinationTranslations = {
    description: 'エージェントがあなたのマシンで実行するレシピ。好きなときに、スケジュールで、または何かが起きたときに。',
    import: 'インポート',
    addAccessibility: 'ワークフローを追加',
    moreAccessibility: 'ワークフローのその他のオプション',
    addMenu: {
        newWorkflowSubtitle: '空の下書きから始める',
        importSubtitle: 'ワークフローの JSON ファイル',
    },
    sections: {
        needsYou: 'あなたの対応待ち',
        running: '実行中',
        library: 'ライブラリ',
        sharedWithYou: 'あなたと共有',
        triggers: 'トリガー',
        history: '履歴',
    },
    allRuns: 'すべての実行',
    lastRun: ({ age }) => `最終実行 ${age}`,
    strip: {
        label: ({ count, parts }) => `直近 ${count} 件の実行: ${parts}`,
        labelPlain: ({ count }) => `直近 ${count} 件の実行`,
        completed: ({ count }) => `完了 ${count} 件`,
        failed: ({ count }) => `失敗 ${count} 件`,
        needsYou: ({ count }) => `対応待ち ${count} 件`,
        separator: '、',
    },
    runSettings: '実行の設定',
    libraryEmpty: '保存したワークフローがここに表示されます。',
    waitingForYou: ({ age }) => `あなたの対応待ち · ${age}`,
    stateAge: ({ state, age }) => `${state} · ${age}`,
    triggerRow: ({ when, then }) => `${when} · ${then}`,
    thenSendPrompt: 'プロンプトを送信',
    thenRunWorkflow: 'ワークフローを実行',
    offline: 'オフライン',
    off: 'オフ',
    columnLoadFailed: 'ワークフローを読み込めませんでした。保存したものは失われていません。',
    firstVisitTitle: 'うまくいったプロンプトを保存して、また実行しましょう',
    firstVisitBody: 'ワークフローは、エージェントが順番に、並行して、または項目ごとに 1 回実行する一連のステップです。好きなときに、スケジュールで、または何かが起きたときに実行します。',
    importPrompt: 'ワークフローのファイルをお持ちですか？',
    loadMoreWorkflows: 'ワークフローをさらに読み込む',
    searchPlaceholder: 'ワークフローを検索',
    noMatch: ({ query }) => `「${query}」に一致するワークフローはありません`,
    views: {
        all: 'すべて',
        triggered: 'トリガーあり',
        active: '実行中',
        needsYou: 'あなたの対応待ち',
        libraryAccessibility: '表示するワークフロー',
        historyAccessibility: '表示する実行',
    },
    history: {
        title: '履歴',
        description: 'どの方法で始まったかにかかわらず、あなたが開始したすべての実行。',
        loadMore: '実行をさらに読み込む',
        loadFailedTitle: '実行を読み込めませんでした',
        loadFailedBody: '作業には影響ありません。',
        review: '確認',
        rowMeta: ({ origin, machine, age }) => `${origin} · ${machine} · ${age}`,
    },
    rowMenu: {
        accessibility: 'ワークフローのオプション',
        runNow: '今すぐ実行',
        share: '共有…',
    },
    deleteTitle: 'このワークフローを削除しますか？',
    deleteFailedTitle: 'ワークフローを削除できませんでした',
    exportFailedTitle: 'ワークフローを書き出せませんでした',
    gate: {
        localTitle: 'このデバイスでは自動化がオフになっています',
        localBody: 'ワークフローとそのトリガーを実行するにはオンにしてください。',
        dependencyTitle: 'ワークフローには自動化が必要です',
        dependencyBody: 'ワークフローを作成・実行するには自動化をオンにしてください。',
        openSettings: '設定を開く',
    },
    runSettingsPage: {
        title: '実行の設定',
        description: '各マシンが同時に受け付ける実行の数と、実行履歴を保持する期間。',
        saveFailed: '実行の設定を保存できませんでした。変更内容はそのまま残っています。',
    },
};

const workflowsDestinationTranslations = { ja } as const;

return { workflowsDestinationTranslations };
})();

const Domain_workflowTriggersTranslations = (() => {
type Count = Shared_workflowTriggersTranslations.Count;

type WorkflowTriggersCopy = Shared_workflowTriggersTranslations.WorkflowTriggersCopy;

const en = Shared_workflowTriggersTranslations.en;

const ja: WorkflowTriggersCopy = {
    activity: {
        create: "このイベントからトリガーを作成",
        test: "このトリガーをテスト",
        matched: "このイベントは一致します",
        noMatch: "このイベントは一致しません",
        sourceMismatch: "このイベントは別のソースから発生しました",
        tooOld: "このイベントは観測対象の期間外です",
        invalid: "テストする前にイベントを設定してください",
    },
    pullRequest: {
        label: "プルリクエスト",
        description: "このトリガーを追加すると、プルリクエストがこのセッションにリンクされます。",
        empty: "開いているプルリクエストはありません",
        loadFailed: "プルリクエストを読み込めませんでした",
    },
    summary: {
        everyDayAt: ({ time }) => `毎日 ${time}`,
        weekdaysAt: ({ time }) => `平日 ${time}`,
        weeklyAt: ({ day, time }) => `毎週${day} ${time}`,
        everyMinutes: ({ count }) => (count === 1 ? '毎分' : `${count}分ごと`),
        everyHours: ({ count }) => (count === 1 ? '毎時' : `${count}時間ごと`),
        cron: ({ expression }) => `スケジュール · ${expression}`,
        schedule: 'スケジュール',
        event: ({ event }) => `${event} が発生したとき`,
        manual: '手動',
        more: ({ first, count }) => `${first} · ほか ${count} 件`,
    },
    kind: {
        pluginEvent: "プラグインイベント",
        sessionStarts: 'セッションが始まったとき',
        sessionArchived: 'セッションがアーカイブされたとき',
        schedule: 'スケジュール',
        prComment: 'プルリクエストにコメントがあったとき',
        ciFailed: 'プルリクエストで CI が失敗したとき',
        turnEnds: 'ターンが終わったとき',
        needsYou: 'セッションがあなたを必要とするとき',
        runEnds: '実行が終了したとき',
        runNeedsYou: '実行があなたを必要とするとき',
    },
    row: {
        workflowDeleted: 'ワークフローは削除されました',
        legacyCreated: 'Happier 0.2 で作成',
        legacyUnavailable: '以前のトリガーを利用できません',
        sessionKeyRequired: 'セッションの鍵が必要です',
        templateRecoveryRequired: 'アカウントのセキュリティ設定で復元してください',
        templateDecryptionFailed: 'トリガーを復号できませんでした',
        machines: ({ count }: Count) => `${count} 台のマシン`,
        nextRun: ({ time }: { time: string }) => `次の実行: ${time}`,
        nextMinutes: ({ count }: Count) => `${count}分後`,
        nextHours: ({ count }: Count) => `${count}時間後`,
        nextDays: ({ count }: Count) => count === 1 ? '明日' : `${count}日後`,
        nextPending: '保留中',
        steps: ({ count }) => (count === 1 ? `${count} ステップ` : `${count} ステップ`),
        off: 'オフ',
        running: '実行中',
        ran: ({ age }) => `${age}に実行`,
        lastOutcome: ({ state, age }) => `${age}に${state}`,
        turnOn: ({ name }) => `${name} をオンにする`,
        turnOff: ({ name }) => `${name} をオフにする`,
    },
    section: {
        add: 'トリガーを追加',
        emptyTitle: "まだ習慣はありません",
        emptyBody: '各ターンのレビューや、目標に向けた継続のために追加しましょう。',
        loadFailed: 'このセッションのトリガーを読み込めませんでした。',
        accountLoadFailed: 'あなたのトリガーを読み込めませんでした。',
        habitsHere: 'ここでの習慣',
        startsHere: "ここから開始",
        title: 'トリガー',
        countOn: ({ count }) => `${count} 件オン`,
        info: 'このセッションから始まるものと、ここに書き込むもの。これらはこのセッションに残り、ライブラリには表示されません。',
        saveFailed: 'このトリガーを保存できませんでした。変更はそのまま残っています。',
    },    kindDescription: {
        pluginEvent: "プラグインがイベントを観測したときに実行します。",
        turnEnds: 'あなた、または一緒に作業するエージェントのターンの後。',
        needsYou: 'このセッションがあなたを待つたび。ワークフローや「完了まで続ける」が動かしている間も含みます。',
        sessionArchived: 'このセッションをアーカイブしたときに一度だけ実行されます。',
        sessionStarts: 'セッション作成時のみ。',
        schedule: 'スケジュールに従ってこのセッションを続けます。',
        prComment: '書き込み権限のある人のみ。コメントは引用として渡されます。',
        pullRequestUnavailable: 'プルリクエストのトリガーはまだここで追加できません。',
    },
    then: {
        runsIn: '実行先',
        runsInChoice: {
            newSession: '新しいセッション',
            session: 'セッション…',
            backgroundRun: 'バックグラウンド実行',
        },
        noSessionOnMachine: 'このマシンにはまだセッションがありません',
        session: 'セッション',
        action: 'アクション',
        label: '次に',
        sendPrompt: 'プロンプトを送る',
        doAction: 'アクションを実行',
        notifyMe: '通知する',
        runWorkflow: 'ワークフローを実行',
        sendPromptDescription: 'このセッションのエージェントがこのセッションでプロンプトを受け取ります。あなたのターンを中断することはありません。',
        promptLabel: 'プロンプト',
        promptPlaceholder: 'エージェントに何をさせますか?',
        message: 'メッセージ',
        title: 'タイトル',
        sendTo: '送信先',
        sendToDefault: '通知設定',
        workflow: 'ワークフロー',
        choose: '選択…',
    },
    popover: {
        configureEvent: "イベントを設定",
        editEvent: "イベントを編集",
        saveAsWorkflow: 'ワークフローとして保存',
        saveAsWorkflowDescription: 'これらのステップを新しいワークフローとして開いて確認します。保存すると、このトリガーはそのワークフローを実行します。',
        when: 'いつ',
        newTrigger: '新しいトリガー',
        addTrigger: 'トリガーを追加',
        cancel: 'キャンセル',
        done: '完了',
        turnOff: 'オフにする',
        turnOn: 'オンにする',
        deleteTrigger: 'トリガーを削除',
        deleteTriggerSet: 'トリガーセットを削除',
        repeat: '繰り返し',
        everyDay: '毎日',
        weekdays: '平日',
        weekly: '毎週',
        day: '曜日',
        at: '時刻',
        expression: 'スケジュール',
        tryAgain: '再試行',
    },    editor: {
        runsOn: '実行マシン',
        runsOnDescription: 'このワークフローのすべてのトリガーがここで実行されます。',
        runsOnAccountDescription: 'このトリガーの実行場所。',
        runsOnDiffers: ({ where }) => `「今すぐ実行」は代わりに ${where} を使います。`,
        sameForAllTriggers: 'すべてのトリガーで共通',
        roles: 'ロール',
        retargetFailed: 'ワークフローは保存されました · トリガーは更新されていません',
        editInWorkflows: 'このトリガーはワークフローで変更してください。今のまま動作し続けます。',
        title: '自動で実行',
        runsBy: '次のいずれかが起きると自動で実行します。',
        runsByOn: ({ where }) => `次のいずれかが起きると ${where} で自動で実行します。`,
        savedWorkflow: 'トリガーは保存済みのワークフローを実行します。',
        saveToInclude: 'トリガーは保存済みのワークフローを実行します。変更を含めるには保存してください。',
        newRow: '新規 · まだ追加されていません',
        partialSave: 'ワークフローは保存されました · トリガーは更新されていません',
    },    column: {
        newTrigger: '新しいトリガー',
        newTriggerSubtitle: 'スケジュールで独自のステップを実行',
    },
};

const legacyTranslations = { ja: {
        editNotice: 'Happier 0.2 で作成されました。開くだけでは変更されません。',
        conversionBoundary: 'この変更後は Happier 0.3 以降のマシンでのみ実行されます。',
        reviewRequired: '確認が必要です',
        reviewConversionNotice: '保存するとワークフローはエンドツーエンド暗号化なしで保存され、有効なトリガーが再開されます。セッションのエンドツーエンド暗号化は維持されます。',
        channelReplyRefusal: '引き継げないチャンネル返信の紐付けがあります。変換されておらず、設定と編集中の内容は保持されています。',
        notAvailable: 'この自動化は利用できなくなりました。',
    } };

const creationTranslations = { ja: { savedWorkflowsUnavailable: '保存済みワークフローを選ぶには、このセッションのサーバーに切り替えてください。組み込みワークフローとインラインステップは引き続き利用できます。' } };

const workflowTriggersTranslations = { ja: { ...ja, legacy: legacyTranslations.ja, creation: creationTranslations.ja } } as const;

return { legacyTranslations, creationTranslations, workflowTriggersTranslations };
})();

const Domain_workflowValueReferenceTranslations = (() => {
const workflowValueReferenceTranslations = { ja: {
        checkoutRoot: 'チェックアウトのルートフォルダー',
        unavailableValue: '値を利用できません', sessionContext: ({ turns }: { turns: number }) => turns === 0 ? 'セッションのコンテキスト' : turns === 1 ? '直近1ターンのセッション' : `直近${turns}ターンのセッション`,
        tokensUsed: '使用トークン数', goalTokenBudget: '目標のトークン予算',
        trailingCount: ({ source, value }: { source: string; value: string }) => `${value}に一致する連続した${source}`,
        stopCondition: '停止条件を満たした', stopConditionArm: ({ arm }: { arm: number }) => `停止条件${arm}を満たした`,
        roundLimit: ({ rounds }: { rounds: number }) => `ラウンド上限に到達 · ${rounds}ラウンド`, decision: '判定',
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

const ja = translated(workflowValueReferenceTranslations.ja, {
    testRun: {
        title: "テスト実行",
        savedNotice: "保存済みのバージョンを実際に実行します。未保存の編集はここに残ります。",
        resultsNotice: "保存済みバージョンの結果 · 最新の実行。未保存の編集は実行されていません。",
        recordedDuration: ({ seconds }) => `記録された経過時間 · ${seconds} 秒`,
        loading: "テスト結果を読み込み中…",
    },
    runWhen: {
        title: "実行条件",
        success: "成功",
        failure: "失敗",
        always: "常に",
        ifSuccess: "成功した場合",
        ifFailure: "失敗した場合",
        regardless: "結果にかかわらず",
        previousStep: "前のステップを基準にします",
    },
    title: 'ワークフロー',
    newWorkflow: '新しいワークフロー',
    copyName: ({ name }: { name: string }) => `${name} コピー`,
    importJson: 'JSON をインポート',
    exportJson: 'JSON をエクスポート',
    openCollection: 'ワークフローを開く',
    destination: workflowsDestinationTranslations.ja,
    plugins: workflowPluginTranslations.ja,
    authoring: workflowAgentAuthoringTranslations.ja,
    page: workflowEditorPageTranslations.ja,
    actionTitles: workflowActionTranslations.ja,
    builtins: workflowBuiltinTranslations.ja,
    triggerRunFold: {
        keptGoing: '続行しました',
        reviewed: 'レビュー済み',
        turns: ({ count }: { count: number }) => `${count} ターン`,
        goalReached: '目標を達成',
        outOfBudget: '予算切れ',
        noProgress: ({ count }: { count: number }) => `${count} 回のチェックで進捗なし`,
        stoppedAfterRounds: ({ count }: { count: number }) => `${count} ラウンドで停止`,
        secondOpinionDisagreed: 'セカンドオピニオンが同意せず · 目標は未完了のまま',
        convergedInRounds: ({ count }: { count: number }) => `${count} ラウンドで収束`,
        findingsReported: '指摘を報告',
        reviewDidNotConverge: ({ count }: { count: number }) => `${count} ラウンド後もレビューが収束しませんでした`,
        meta: ({ workflow, trigger }: { workflow: string; trigger: string }) => `${workflow} · ${trigger}`,
        trigger: { turnEnds: 'ターン終了時', sessionStarts: 'セッション開始時', needsYou: 'セッションがあなたを必要とするとき', sessionArchived: 'アーカイブ時', schedule: 'スケジュールで' },
    },
    examples: workflowExamplesTranslations.ja,
    triggers: workflowTriggersTranslations.ja,
    start: workflowStartTranslations.ja,
    list: workflowRunListTranslations.ja,
    review: {
        publishedByAgent: 'エージェントが公開',
        publishedByYou: 'あなたが公開',
        editedByYou: 'あなたが編集',
        editedByPerson: '他のユーザーが編集',
        previousAttempt: '前の試行',
        useBody: "後続のステップは表示された内容をそのまま受け取ります。エージェントのターンはありません。",
        usePlanBody: "この計画をそのまま承認します。エージェントのターンはありません。",
        reportBackTitle: ({ session }) => "結果を報告: " + session,
        reportBackBody: ({ session }) => session + " に実行完了時の結果を送ります。",
        planRunNotice: "表示どおりに提案されたワークフローを実行し、計画を承認します。保存はしません。",
        editedPlanBody: 'この下書きは提案と異なります。まず確認済みの計画を編集用に承認しますか？変更はここに残り、下書きをもう一度実行するまで何も開始されません。',
        title: "確認する結果",
        planTitle: "確認する計画",
        waitTitle: "あなたの操作待ち",
        waitBody: "続行するまで、この分岐は待機します。",
        editsTitle: "未保存の編集",
        editsBody: "使用するまで保存済みの結果は変わりません。",
        heldBody: "確認待ち · 後続のステップには未送信",
        noValue: "有効な結果はまだありません",
        enterValues: '各項目を入力してください。',
        enterValue: '項目を入力してください。',
        useResult: "この結果を使用",
        usePlan: "この計画を使用",
        useValues: "これらの値を使用",
        useValue: 'この値を使う',
        continue: "続行",
        invalid: "まず表示されたフィールドを修正してください。",
        newer: "新しい結果があります。",
        showNewer: "新しい結果を表示",
        keepMyEdits: '自分の編集を保持',
        useNewer: '新しい結果を使用',
        showFullResult: '結果の全文を表示',
        showFullPlan: '計画の全文を表示',
        generationRequested: "生成をリクエスト済み",
        startsResume: "実行を再開すると開始します。",
        generateBody: "エージェントがこの会話で新しい結果を作成します。有効な結果なら、再確認せず実行を続けます。",
        acceptedPaused: "この結果を使用してもワークフローは一時停止したままです。",
        editResult: "結果を編集",
        generate: "結果を生成して続行",
        discuss: "相談",
        discussBody: "このステップの会話で返信してください。エージェントが更新した結果をここに公開できます。",
        proposal: "提案されたワークフロー",
        planStarted: "この計画の実行は開始済みです",
        earlierPlanStarted: "以前の提案からの実行がすでに開始されています",
        openEarlierPlanRun: "その実行を開く",
        runNewProposal: "新しい提案を実行",
        runPlan: "ワークフローとして実行",
        runPlanBody: "提案されたワークフローの実行確認を開きます。開始するとこの計画も承認されます。",
        editPlan: "先にワークフローを編集",
        editPlanBody: "この計画を承認し、提案されたワークフローを未保存の下書きとして開きます。",
        editPlanFallback: "この計画を承認し、計画を指示にした1ステップのワークフローを開きます。",
        waitingMachine: ({ machine }) => "待機中: " + machine,
    },

    tabs: {
        saved: '保存済み',
        runs: '実行',
        steps: 'ステップ',
        flow: 'フロー',
        map: 'マップ',
        activity: 'アクティビティ',
    },
    tabsAccessibility: {
        savedRuns: '保存済みワークフローまたは実行',
        stepsFlow: 'ステップまたはフロー',
        activityFlow: 'アクティビティまたはフロー',
        runViews: "実行の表示",
    },

    filters: {
        all: 'すべて',
        active: '実行中',
        needsYou: '要対応',
        clear: 'フィルターを解除',
    },

    empty: {
        savedTitle: '保存済みのワークフローはまだありません',
        savedBody: 'ワークフローを保存すると、実行やスケジュール設定に何度でも使える定義が残ります。',
        runsTitle: 'まだ何も実行されていません',
        runsBody: 'ワークフローを保存してもしなくても、実行はここに表示されます。',
        filteredTitle: 'このフィルターに一致する実行はありません',
        filteredBody: 'フィルターを解除すると、ほかの実行が表示されます。',
        missingTitle: 'このワークフローは利用できません',
        missingBody: 'このリンクが指すワークフローを Happier は開けませんでした。他のワークフロー、オートメーション、実行には影響ありません。',
        missingDraftTitle: "未保存のコピーが失われました",
        missingDraftBody: "再読み込みすると未保存のコピーは失われます。元のワークフローを開いて、もう一度複製してください。",
    },

    loadFailedTitle: 'ワークフローを読み込めませんでした',
    loadFailedBody: 'あなたの作業には影響しません。準備ができたら再試行してください。',
    retry: '再試行',
    contentUnavailable: 'このデバイスではプライベートな内容を表示できません。',
    readState: {
        historyTitle: '履歴を読み取れません',
        historyBody: 'この実行は以前の開発版のHappierで記録されたため、履歴を開くことができません。続けるには新しい実行を開始してください。',
        encryptionTitle: '暗号化の設定が必要です',
        encryptionBody: 'この内容はエンドツーエンドで暗号化されています。開くには、このアカウントで暗号化を設定してください。',
        keysTitle: '暗号鍵を待っています',
        keysBody: 'このデバイスには、まだこの実行の暗号鍵がありません。鍵が利用可能になったら、もう一度お試しください。',
        storageTitle: '実行ストレージを利用できません',
        storageBody: 'Happierは実行ストレージにアクセスできませんでした。接続を確認して、もう一度お試しください。',
        openSettings: '設定を開く',
    },
    contentReasons: {
        invalidHeader: 'このワークフローの保存された情報は無効です。',
        revisionMismatch: 'このワークフローは保存されたリビジョンと一致しません。',
        missingBody: 'このワークフローの保存された定義がありません。',
        invalidBody: 'このワークフローの保存された定義は無効です。',
        notFound: 'このワークフローは利用できなくなりました。',
    },

    sessionEntry: {
        missingTitle: 'このセッションは利用できなくなりました',
        missingBody: '削除されたか、別の Home にある可能性があります。セッション一覧から探してください。',
        inaccessibleTitle: 'このセッションは開けません',
        inaccessibleBody: 'Happier はアクセスを確認できませんでした。再度サインインするか所有者に依頼してから、このページを開き直してください。',
        failedTitle: 'このセッションを開けませんでした',
        failedBody: 'Happier は再試行を続けています。今すぐやり直すこともできます。',
        unsupportedTitle: 'このセッションからワークフローは開始できません',
        unsupportedBody: '実行中のエージェントとマシンを読み取れませんでした。ワークフロー画面から作成してください。',
    },

    editor: {
        namePlaceholder: 'ワークフロー名',
        agentRuntime: 'エージェントランタイム',
        firstPromptTitle: '最初に何をしますか？',
        firstPromptBody: 'プロンプト 1 つでもワークフローです。必要になったらステップを追加してください。',
        promptPlaceholder: 'このステップで行うことを説明してください',
        useWorkflowDefault: 'ワークフローの既定値を使う',
        defaultsTitle: '既定値',
        produces: '出力',
        whereTitle: '場所',
        add: '追加',
        addAccessibility: 'このワークフローにブロックを追加',
        addStep: 'エージェントのステップ',
        addParallel: '並べて実行',
        addLoop: '繰り返し',
        addIf: '条件分岐',
        targetRequired: 'このワークフローのマシンとプロジェクトフォルダを選択してください。',
        loadingTitle: 'ワークフローを開いています…',
        accountChangedTitle: 'アカウントが切り替わりました',
        accountChangedBody: 'このワークフローは前のアカウントで開かれたもので、引き継ぐことはできません。ワークフローから開き直してください。',
        loadFailedTitle: 'このワークフローを開けませんでした',
        loadFailedBody: '保存されたワークフローを今は読み取れませんでした。',
        timeoutTitle: '結果の待ち時間（ms）',
        noDeadline: '期限なし',
        timeoutExplain: 'このステップの結果を待つミリ秒数。超えると注意が必要になります。空欄なら期限はありません。',
        wholeNumberRequired: '1 以上の整数を入力してください。',
        runNow: 'いま実行',
        save: 'ワークフローを保存',
        saveAutomation: 'オートメーションを保存',
        schedule: 'スケジュール設定',
        savedRevision: ({ revision }) => `保存済み · ${revision}`,
        moveUp: '上へ移動',
        moveDown: '下へ移動',
        moveIn: '上のグループへ入れる',
        moveOut: 'このグループから出す',
        remove: '削除',
        undo: '元に戻す',
        redo: 'やり直す',
        historyRestoreRequiresSetup: 'このイベントは再設定が必要です。削除後は保存済みの非公開設定を復元できません。',
        history: { edited: 'ワークフローを編集', agent: 'エージェントの変更', description: '説明を編集', where: '実行場所を変更', target: 'ステップの実行方法を変更', triggers: 'トリガーを編集', example: '例を挿入', document: 'プロンプトを編集', renameWorkflow: 'ワークフローの名前を変更', renameStep: 'ステップの名前を変更', renameLane: 'レーンの名前を変更' },
        undoAction: ({ change }: { change: string }) => `元に戻す: ${change}`,
        redoAction: ({ change }: { change: string }) => `やり直す: ${change}`,
        removedBlock: ({ block }) => `${block} を削除しました`,
        rename: '名前を変更',
        stepOrdinal: ({ position }) => `${position}`,
        unnamedStep: ({ position }) => `ステップ ${position}`,
        unnamedParallel: '並列グループ',
        unnamedLoop: 'ループ',
        unnamedIf: '条件',
        branch: 'ブランチ',
        addBranch: 'レーンを追加',
        ifTrue: 'その場合',
        otherwise: 'それ以外',
        addOtherwise: '「それ以外」のブランチを追加',
        evaluator: '続けるかどうかを判断',
        loopBody: 'これらのステップを繰り返す',
        continuation: '各ラウンドのあとで',
    },

    input: {
        label: '入力',
        result: '結果',
        change: '変更',
        none: '入力なし',
        previousResult: ({ block }) => `${block} の結果`,
        workflowInput: ({ name }) => `ワークフロー入力 · ${name}`,
        currentItem: '現在の項目',
        iteration: 'このラウンド',
        unavailable: 'このソースは利用できなくなりました',
        itemField: {
            value: '項目の値',
            index: '項目のインデックス（0 から）',
            position: '項目の位置（1 から）',
            count: '項目数',
        },
        iterationField: {
            index: 'ラウンドのインデックス（0 から）',
            position: 'ラウンド番号（1 から）',
            count: 'ラウンド数',
            stopReason: '停止理由',
        },
        valueKindGroup: '値のソース',
        inputNameGroup: 'ワークフロー入力',
        producerGroup: 'ソースステップ',
        workspaceFieldGroup: 'ワークスペース項目',
        itemFieldGroup: 'アイテム項目',
        iterationFieldGroup: 'ラウンド項目',
    },

    inputs: {
        title: 'ワークフローの入力',
        addInput: '入力を追加',
        namePlaceholder: '名前',
        descriptionPlaceholder: '何に使いますか？',
        required: '必須',
        optional: '任意',
        defaultValue: '既定値',
        typeLabel: '種類',
        typeString: 'テキスト',
        typeNumber: '数値',
        typeBoolean: 'はい / いいえ',
        typeJson: '構造化データ', typeParticipant: '参加者', typeParticipants: '参加者（複数）',
        runSheetTitle: 'このワークフローを実行',
        runSheetBody: 'このワークフローが求める値を入力してから実行してください。',
        missingRequired: 'この値は必須です。',
        wrongType: ({ type }) => `この値は ${type} である必要があります。`,
    },

    finalOutput: {
        title: '最終出力',
        none: '最終出力が選択されていません',
        change: '変更',
        clear: '選択を解除',
        fieldPath: 'フィールドのパス',
        explain: 'このワークフローが終了したときに返すもの。',
    },

    conversation: {
        title: '会話',
        sharedRun: '同じ会話',
        branchesShareAndTakeTurns: 'ブランチは同じ会話を共有し、順番に実行されます。',
        fresh: '別々の会話',
        fromStep: ({ block }) => `${block} を続ける`,
        existingSession: '既存のセッション',
        existingSessionById: ({ sessionId }) => `セッション ${sessionId}`,
        noExistingSessions: 'このマシンで続行できるセッションはありません。',
        chooseExistingSession: '続行するセッションを選択',
        sessionsLoading: 'セッションを探しています…',
        sessionsFailed: 'セッションを読み込めませんでした。',
        sessionsFailedRetry: 'セッションを読み込めませんでした。選ぶと再試行します。',
        retryLoadingSessions: '再試行',
        noSessionsYet: '続行できるセッションはまだありません。',
        savedSession: '保存されたセッション',
        unavailableSession: 'セッションは利用できません',
        sessionGone: 'このセッションはもう続行できません。別のセッションを選んでください。',
        sessionNotHere: 'このセッションはここでは続行できません。別のセッションを選んでください。',
        continuingKeepsAgentAndFolder: '続行すると、その会話のエージェントとフォルダーがそのまま使われます。別のエージェントやフォルダーには別の会話が必要です。',
        waitingForConversation: ({ block }) => `この会話で ${block} が終わるのを待っています。`,
        branchesUseSeparate: '並列グループ内のブランチは、それぞれ別の会話を使います。',
    },

    workspace: {
        title: 'ワークスペース',
        inherit: 'ワークフローのワークスペース',
        projectCheckout: 'プロジェクトフォルダー',
        fromStep: ({ block }) => `${block} のワークスペースを続ける`,
        newWorktreeOriginal: '元のフォルダーから新しいワークツリー',
        newWorktreeWorkflow: 'ワークフローのワークスペースから新しいワークツリー',
        newWorktreeStep: ({ block }) => `${block} から新しいワークツリー`,
        committedOnlyNote: '新しいワークツリーには、元フォルダーのコミット済みの状態が入ります。ステージ済み・未コミット・未追跡の変更は元フォルダーに残ります。',
        reuseNote: 'ワークスペースを続ける場合、未コミットのファイルはそのままの状態で見えます。',
        sharedParallelNote: '1 つのワークスペースを共有するブランチは、同時に書き込むことがあります。',
        unavailable: ({ block }) => `${block} のワークスペースは利用できません。`,
        unavailableBody: '復元してこの実行を続けるか、完了済みの作業を繰り返す可能性がある新しい実行を確認してください。',
        unavailableRestoreBody: '復元すると、完了済みの作業をそのままにこの実行を続けられます。',
        unavailableNewRunBody: '復元できません。確認して新しい実行を始めると最初からになり、完了済みの作業が繰り返される可能性があります。',
        restore: '復元',
        inspect: '調べる',
    },

    condition: {
        onlyWhen: '次の場合だけ実行',
        always: '常に',
        stopWhen: '次の場合に停止',
        ifWhen: '次の場合に最初のブランチを実行',
        addCondition: '条件を追加',
        removeCondition: '条件を削除',
        allOf: 'すべてを満たす',
        anyOf: 'いずれかを満たす',
        not: '否定',
        exists: '値がある',
        operatorEq: 'が次と等しい',
        operatorNeq: 'が次と等しくない',
        operatorLt: 'が次より小さい',
        operatorLte: 'が次以下',
        operatorGt: 'が次より大きい',
        operatorGte: 'が次以上',
        notFirstRound: '最初のラウンドではない',
        trailingCountAtLeast: ({ source, value, count }) => `${source} が ${count} 回連続で ${value}`,
        loopRanOutOfRounds: ({ loop }) => `${loop} がラウンドを使い切った`,
        loopEnded: ({ loop, outcome }) => `${loop} が終了: ${outcome}`,
        loopStoppedBecause: ({ loop, condition }) => `${condition} のため ${loop} が停止`,
        valuePlaceholder: '値',
        literalPlaceholder: '値を入力',
        skippedReason: ({ block }) => `${block} の条件を満たさなかったためスキップしました。`,
    },

    loop: {
        modeTitle: '繰り返し',
        modeCount: '決まった回数',
        modeItems: '項目ごとに 1 回',
        modeUntil: '結果が停止を示すまで',
        modeEvaluate: 'エージェントが停止と判断するまで',
        count: '回数',
        items: 'リスト',
        sequential: '項目を順番に',
        parallel: '項目を並列に',
        maxConcurrentItems: '同時に実行する項目の上限',
        maxConcurrentBranches: '同時に実行するブランチの上限',
        noWorkflowLimit: 'ワークフローによる上限なし',
        maxIterations: 'ラウンド数の上限',
        limitReached: '上限に達しました',
        historyTitle: 'これまでの判断',
        historyNone: 'なし',
        historyLatest: '最新のみ',
        historyAll: 'すべて',
        historyExplain: '選ばれるのは保存された判断とフィードバックであり、記録全体ではありません。',
        continuingConversation: 'この評価役はこれまでの会話を保ち、新しいラウンドごとに書き足します。',
        emptyListCompletes: 'リストが空の場合、ラウンドは 1 回も実行されずに終了します。',
    },

    failurePolicy: {
        title: 'ステップが失敗したとき',
        failStop: '失敗したらこのグループを停止する',
        failStopExplain: 'このグループは新しい作業の開始をやめ、独立したものも含めて実行中のブランチに停止を求めます。完了した結果と変更はそのまま残ります。これはロールバックではありません。',
        collectOutcomes: '独立した作業は最後まで進める',
        collectOutcomesExplain: '問題のないブランチは一連の処理を最後まで進め、すべての結果が集められます。ブランチ内で失敗したあとのステップは実行されません。',
    },

    runState: {
        pending: '開始待ち',
        queued: '開始待ち',
        claimed: '開始中',
        running: '実行中',
        waiting_for_review: 'あなたのレビュー待ち',
        succeeded: '完了',
        failed: '失敗',
        cancel_requested: '停止中',
        cancelled: '停止しました',
        pause_requested: '一時停止の準備中',
        paused: '一時停止',
        interrupted: '中断',
        expired: '開始前に期限切れ',
        dispatch_failed: '開始できませんでした',
        skipped: 'スキップ',
        missed: '実行漏れ',
        outcome_uncertain: '結果が不明',
        completed: '完了',
        completed_with_failures: '完了（失敗あり）',
    },

    invocationState: {
        pending: '待機中',
        waiting_for_capacity: '空き待ち',
        admitting: '開始中',
        running: '実行中',
        waiting_for_approval: '承認待ち',
        waiting_for_review: 'あなたのレビュー待ち',
        needs_attention: '要対応',
        completed: '完了',
        failed: '失敗',
        skipped: 'スキップ',
        cancel_requested: '停止中',
        cancelled: '停止しました',
        outcome_uncertain: '結果が不明',
        superseded: 'あとの試行に置き換えられました',
    },

    run: {
        title: '実行',
        frozenVersion: "この実行は開始時のバージョンを使用します。編集は今後の実行にのみ適用されます。",
        selectOccurrence: 'ステップを選択',
        openReview: '結果を確認',
        open: '実行を開く',
        openExact: ({ title }) => `${title} の実行を開く`,
        openExecution: 'バックグラウンド実行を開く',
        loadMore: '以前のステップを読み込む',
        origin: {
            direct: '直接開始',
            automation: 'スケジュール実行',
            fromSession: 'セッションから',
        },
        needsYou: '要対応',
        needsYouLoadedCount: '件読み込み済み',
        review: '確認',
        stop: '停止',
        stopAgain: 'もう一度停止',
        stopping: '停止中…',
        stopWhenMachineReconnects: ({ machine }) => `${machine} が再接続すると停止します`,
        stopWhenMachineReconnectsUnknown: 'マシンが再接続すると停止します',
        stopRequested: ({ machine }) => `停止を要求しました。${machine} の確認を待っています。`,
        occurrenceItem: ({ number }) => `項目 ${number}`,
        occurrenceRound: ({ number }) => `ラウンド ${number}`,
        evidenceStale: '最後に確認できた詳細を表示しています。Happier は最新かどうかを確認できませんでした。',
        pauseAtBoundary: '区切りで一時停止',
        pause: '一時停止',
        pausePending: '現在の作業を終えてから一時停止します。',
        paused: '最後に完了した区切りで一時停止しました。',
        resume: '再開',
        runAgain: 'ワークフローをもう一度実行',
        retryStep: 'ステップを再実行',
        attempt: ({ attempt }) => `試行 ${attempt}`,
        untitled: 'ワークフローの実行',
        openResult: '結果を開く',
        inspectSteps: 'ステップを確認',
        seeFailures: '失敗を見る',
        saveAsWorkflow: 'ワークフローとして保存',
        saveAsNewWorkflow: '新しいワークフローとして保存',
        showCurrentWork: '現在の作業を表示',
        editWorkflow: 'ワークフローを編集',
        openWorkflow: 'ワークフローを開く',
        deleteHistory: '実行履歴を削除',
        deleteHistoryConfirm: '入力と結果が削除されます。ワークスペース、会話、保存済みワークフロー、オートメーションはそのまま残ります。',
        technicalDetails: '技術的な詳細',
        technical: {
            runId: '実行 ID',
            invocationId: 'ステップ ID',
            machine: 'マシン',
            machineId: 'マシン ID',
            revision: 'リビジョン',
            failureCode: '失敗コード',
            failureCause: '原因',
        },
        usageUnavailable: '使用量を取得できません',
        usageNotReported: '報告なし',
        startedAt: ({ time }: { time: string }) => `${time} に開始`,
        timeRange: ({ start, end }) => `${start} – ${end}`,
        openConversation: '会話を開く',
        openChildRun: 'その実行を開く',
        openStepDetails: '詳細を開く',
        outcomeLine: ({ word, sentence }: { word: string; sentence: string }) => `${word} — ${sentence}`,
        attentionReviewRow: ({ step }: { step: string }) => `${step} があなたの確認を待っています`,
        attentionWaitRow: ({ step }: { step: string }) => `${step} があなたを待っています`,
        attentionWaitRowMore: ({ step, count }: { step: string; count: number }) => `${step} ほか ${count} 件があなたを待っています`,
        attentionItemCount: ({ count }: { count: number }) => `${count} 件`,
        attentionReviewSentence: ({ step }: { step: string }) => `${step} があなたの確認を待っています。`,
        attentionWaitSentence: ({ step }: { step: string }) => `${step} があなたを待っています。`,
        attentionParkedSentence: ({ step }: { step: string }) => `${step}。`,
        failedStepSentence: ({ step }: { step: string }) => `${step} が失敗しました。完了した作業は保持されます。`,
        stepNumber: ({ ordinal }: { ordinal: string }) => `ステップ ${ordinal}`,
        failedSentence: '完了した作業は保持されます。',
        consequenceLanes: ({ lanes }: { lanes: readonly string[] }) => `${lanes.join('と')}は続行します。`,
        consequenceJoin: ({ step, count }: { step: string; count: number }) => `${count}個のレーンがすべて完了すると、${step}が始まります。`,
        reviewing: '確認中',
        notStarted: '未実行',
        machineUnavailable: ({ machine }) => `この実行は ${machine} との接続を失いました。`,
        machineUnavailableBody: '現在の状態がわかると、再開の選択肢が表示されます。',
        completedCount: ({ count }) => count === 1 ? '1つのステップを終えました。' : `すべての ${count} ステップを終えました。`,
        stoppedCount: ({ completed, total }: { completed: number; total: number }) => `${total} ステップ中 ${completed} 件が完了。`,
        notAnswered: '未回答',
        waitContinued: '続行しました',
        answeredBy: ({ name }) => `${name}が回答`,
        answeredByYou: 'あなたが回答',
        answeredByPerson: '他のユーザーが回答',
        completedWithFailures: ({ completed, failed }) =>
            `失敗ありで完了しました。${completed} 件が完了し、${failed} 件は終えられませんでした。`,
        approvalWanted: ({ block }) => `${block} がコマンドを実行しようとしています。`,
        approvalWantedBody: '内容を確認すると続行できます。',
        capacityOccupied: 'ワークフローで指定された枠はすべて使用中です。',
        openSourceSession: '元のセッションを開く',
        observedActivity: '観測されたアクティビティ',
        observedActivityBody: 'Happier はこのエージェントのフェーズとエージェントを見ることができますが、管理されたワークフローとして開始されていないため、編集・保存・再実行はできません。',
    },

    recovery: {
        title: '復旧方法を確認',
        reattach: '再接続',
        reattachExplain: 'すでに動いている作業を見守ります。新しく何かを始めることはありません。',
        resumeSameConversation: '再開',
        resumeSameConversationExplain: ({ block }) => `${block} は同じ会話で続けられます。`,
        freshAgent: '新しいエージェントで続ける',
        freshAgentExplain: 'この会話は続けられません。ワークスペースは新しいエージェントで使えます。',
        uncertainEffects: ({ block }) => `${block} は報告する前に停止しました。すでにワークスペースを変更している可能性があります。`,
        uncertainAction: ({ action }) => `${action} は実行された可能性があります。Happier は応答を受け取れませんでした。`,
        acknowledgeEffects: 'これまでの変更がすでに行われている可能性があることを理解しました',
        waitingForStop: '停止または確認を待っています',
        remainingNotStarted: ({ count }) => `関連する未開始のステップ: ${count}`,
        startReviewedRun: '確認したうえで新しく実行する',
        editContinuation: '続きを確認または編集',
        continuationPlaceholder: 'このステップで変えたいことを追加',
        useReplacementInput: 'ステップの入力を差し替える',
        repeatedEffectWarning: '完了した作業が繰り返される可能性があります。元の実行の履歴はそのまま残ります。',
        lostContact: ({ machine }: { machine: string }) => `${machine} との接続が切れました`,
        lostContactAt: ({ machine, time }: { machine: string; time: string }) => `${time} に ${machine} との接続が切れました`,
        didNotFinish: 'このステップは完了しませんでした',
        causeNotRecorded: '失敗の原因は記録されていません',
        agentTimedOut: '時間内にエージェントに接続できませんでした',
        agentUnreachable: 'エージェントに接続できませんでした',
        agentConnectionLost: 'エージェントとの接続が切れました',
        keptBody: '完了したステップはそのまま残り、終わった作業は繰り返されません。',
        choicesOnReconnect: ({ machine }: { machine: string }) => `${machine} が再接続すると、復旧の選択肢が表示されます。`,
        noChoices: 'このステップはここからは続行できません。',
        sameConversationTitle: '同じ会話で続ける',
        freshAgentBody: '新しい Agent はステップの入力とワークスペースを受け取りますが、この会話は引き継ぎません。',
        startFresh: '新しく始める',
        retry: '再実行',
        retryExplain: '元の入力でもう一度実行します。',
    },

    unavailable: {
        title: 'ワークフローを利用できません',
        body: 'このサーバーではワークフローを利用できないため、ここでワークフローを作成したり実行したりすることはできません。',
        conversion: 'これらの変更にはワークフロー形式が必要ですが、このサーバーではワークフローを利用できません。このオートメーションは 1 つのプロンプトのままにするか、ワークフローを利用できるようになってからやり直してください。',
        savedAutomation: 'このオートメーションはワークフローとして実行されます。保存済みのステップはそのまま保持され、名前・説明・トリガーは引き続き編集できます。',
    },
    conversion: {
        title: 'この変更にはワークフロー形式が必要です',
        automationTarget: 'ワークフロー',
        body: 'このオートメーションは保存済みのターゲットで 1 つのプロンプトを実行しています。変換すると編集内容はそのまま残り、今後の実行は 1 台の特定マシン上でワークフローとして動きます。過去の実行は変わりません。',
        action: 'ワークフローに変換',
        machineRequired: '今後の実行に使うマシンとプロジェクトフォルダーを選んでください。',
    },
    save: {
        conflictTitle: 'より新しいバージョンが保存されています',
        conflictBody: 'あなたの編集内容は残っています。',
        compare: '比較',
        saveAsCopy: 'コピーとして保存',
        failedTitle: '保存できませんでした',
        failedBody: 'ローカルの作業は残っています。',
        deleteTitle: 'このワークフローを削除しますか？',
        deleteBody: '既存のオートメーションと実行には影響せず、そのまま動き続けます。',
        unsupportedAttachment: 'このワークフローを保存する前に、メディアは永続的な参照で添付してください。',
        nameRequired: '保存する前に、このワークフローに名前を付けてください。',
        runsCurrentDraft: 'この実行は画面上のワークフローをそのまま使います。保存はしません。',
    },

    interchange: {
        importTitle: 'ワークフローをインポート',
        importBody: 'インポートすると、確認用に未保存の下書きが開きます。実行やスケジュール設定は行いません。',
        importIssuesTitle: 'このワークフローを確認',
        importIssuesBody: 'このワークフローを使用する前に確認が必要な設定があります。',
        openRepairDraft: '修正用の下書きを開く',
        importFailedTitle: 'そのファイルを読み取れませんでした',
        importFailedInvalidJson: 'そのファイルは有効な JSON ではありません。',
        importFailedUnsupportedVersion: 'そのファイルは、このアプリが対応していないワークフローのバージョンを使っています。',
        importFailedInvalidDocument: 'そのファイルは Happier のワークフローではありません。',
        exportPrivacyNote: 'エクスポートされたファイルにはプロンプトと設定が含まれます。認証情報や実行結果が含まれることはありません。',
    },

    issue: {
        invalid_version: 'このワークフローは対応していないバージョンを使っています。',
        unknown_field: 'このブロックには、このワークフローが対応していない設定があります。',
        invalid_id: 'このブロックには有効な識別子が必要です。',
        duplicate_id: '2 つのブロックが同じ識別子を使っています。',
        missing_reference: 'この入力は、すでに存在しないブロックを指しています。',
        invalid_reference_scope: 'この入力は、先に終わらないブロックを指しています。',
        invalid_input: 'この値は有効ではありません。',
        missing_required_input: '必須の値が足りません。',
        invalid_result_contract: 'このステップの結果設定は有効ではありません。',
        invalid_condition: 'この条件は比較できません。',
        invalid_repetition: 'このループは、この設定では繰り返せません。',
        invalid_max_concurrent: '同時実行数の上限には 1 以上の整数が必要で、並列の作業にだけ適用されます。',
        unsupported_persisted_attachment: '添付されたメディアには、保存前に永続的な参照が必要です。',
        conversation_workspace_mismatch: 'この会話とワークスペースを一緒に続けることはできません。',
        target_unavailable: '実行する前に、このワークフローのエージェントを選んでください。',
        emptyPrompt: 'このステップで行うことを書いてください。',
        emptyWaitPrompt: 'ここで確認または判断することを書いてください。',
        fieldMissing: ({ field }) => `${field} は必須です。`,
        fieldInvalid: ({ field }) => `${field} に有効な値が必要です。`,
    },

    problem: {
        title: 'うまくいきませんでした',
        waitingTitle: 'まだできません',
        subtreeDenied: 'エージェントが作業を開始できるのは、自分のセッションまたは自分が指揮するセッションだけです。',
        roleTargetUnavailable: 'このロールはここでは使用できません。',
        accountRolesUnavailableTitle: 'アカウントのロールを利用できません',
        accountRolesUnavailable: 'Happier はアカウントのロール設定を読み取れませんでした。',
        roleRunsAsMismatch: 'このロールの実行方法は、このステップでは使えません。別のロールを選ぶか、ステップの実行方法を変更してください。',
        policyDeniedField: 'エージェントが開始する作業では、要求された設定がエージェント設定で許可されていません。',
        permissionExceedsCeiling: 'これには、開始したエージェントが持つ以上の権限が必要です。',
        workDepthExceeded: '委任の上限を超えます。このセッションで行うか、設定 › 委任で上限を引き上げてください。',
        definitionExceedsAuthority: 'エージェント自身が開始できる範囲を超えるワークフローは保存できません。',
        sourceUnavailable: 'このワークフローは利用できないため、トリガーを実行できません。',
        legacyConversionUnsupported: 'この自動化はまだここでは変更できません。現在のまま動作し続けます。',
        nativeGoalOwner: 'このセッションのエージェントは、すでに自律的に目標に向けて作業を続けています。',
        sessionAlreadyStarted: 'このセッションはすでに開始しています。開始時のトリガーは、セッションの作成時にのみ追加できます。',
        generic: 'Happier はそのワークフローの操作を完了できませんでした。作業には影響ありません。',
        needsRepair: 'このワークフローには、実行する前に直す必要がある設定があります。',
        targetUnavailable: 'このワークフローに必要なマシンまたはエージェントが今は利用できません。',
        notFound: 'この実行はもうありません。',
        notFoundTitle: '実行が見つかりません',
        accessDenied: 'これにはアクセスできません。',
        conflict: 'これは別の場所で変更されました。更新して現在のバージョンを確認してください。ローカルの作業は残ります。',
        inputTooLarge: 'その入力は大きすぎて送信できません。何も変更されていません。',
        unresolvedOutcome: 'Happier は前の作業が止まったことをまだ確認できないため、置き換えられません。',
        interactionCapacity: 'この会話は待機中の処理が多すぎて、今はこれ以上受け付けられません。',
        conversationUnavailable: 'その会話は続けられません。',
        conversationChecks: {
            allowedTools: "指定したツールポリシーは、この会話と一致しません。",
            unlistedTools: "指定した未登録ツールのポリシーは、この会話と一致しません。",
            capabilitySelection: "指定した機能は、この会話と一致しません。",
            work_depth_unavailable: "この会話には保存された委任の深さがありません。",
            workspace_unavailable: "この会話には利用できる作業フォルダがありません。",
            agentTarget: "指定されたエージェントはこの会話と一致しません。",
            modelSelection: "指定されたモデルはこの会話と一致しません。",
            profileId: "指定されたプロファイルはこの会話と一致しません。",
            permissionMode: "指定された権限はこの会話と一致しません。",
            acpSessionModeId: "指定されたエージェントモードはこの会話と一致しません。",
            sessionConfigOptionOverrides: "指定されたエージェント設定はこの会話と一致しません。",
            mcpSelection: "指定されたMCP設定はこの会話と一致しません。",
            connectedServices: "指定された接続サービスはこの会話と一致しません。",
            transcriptStorage: "指定された会話記録の保存先はこの会話と一致しません。",
            terminal: "指定されたターミナルはこの会話と一致しません。",
            windowsRemoteSessionLaunchMode: "指定されたWindows起動モードはこの会話と一致しません。",
            windowsRemoteSessionConsole: "指定されたWindowsコンソールはこの会話と一致しません。",
            windowsTerminalWindowName: "指定されたWindowsターミナル名はこの会話と一致しません。",
            runtimeDescriptorV1: "指定されたランタイム設定はこの会話と一致しません。",
            recovery_execution_missing: "前の会話には再開できる実行記録がありません。",
            target_kind_mismatch: "前の実行はセッションの会話ではありません。",
            session_unavailable: "このセッションは存在しないか利用できません。",
            producer_conversation_missing: "選択したステップには利用できる会話がありません。",
            origin_session_missing: "開始元のセッションは利用できません。",
            session_identity_mismatch: "取得したセッションは選択したセッションと異なります。",
            machine_mismatch: "この会話は別のマシンに属しています。",
            workspace_mismatch: "この会話は別の作業フォルダを使用しています。",
            account_scope_unavailable: "現在のアカウントのアクセス権または暗号化状態ではこの会話を開けません。",
            owner_metadata_unavailable: "この会話には読み取れる所有者メタデータまたは作業フォルダがありません。",
        },
        workspaceRestore: 'ワークスペースを復元できませんでした。何も変更されていません。',
        waitSelfDependency: 'これではワークフローが、自分を開始した会話を待つことになります。',
        updateRequired: 'これを実行しているマシンがこのステップを受け付けるには、新しい Happier が必要です。',
        ineligible: 'この実行は先に進んだため、それはもうできません。',
        runMovedOn: '実行が進みました。更新してもう一度お試しください。',
        custodyPending: 'Happier はまだマシンからの確認を待っています。',
        runFinished: 'この実行は終了しました。',
        checkpointUnavailable: '再開できる保存地点がありません。',
        recoveryEvidenceRequired: 'この実行を開くと、復旧の選択肢が表示されます。',
        executionNotStarted: 'まだどのステップも始まっていません。',
        custodySettled: 'この実行はすでに完了しています。',
        unavailableHere: '今は利用できません。',
    },

    a11y: {
        blockList: 'ワークフローのブロック',
        stepContext: ({ block, position, total }) => `${block}、ステップ ${position}/${total}`,
        groupContext: ({ group, block }) => `${block}、${group} の中`,
        inherited: 'ワークフローの設定を使用',
        overridden: 'このステップ用に設定',
        inserted: ({ block, position, total }) =>
            `${block} を ${total} 個中 ${position} 番目に追加しました`,
        removed: ({ block, total }) =>
            `${block} を削除しました。残りは ${total} 個のブロックです`,
        reordered: ({ block, position, total }) =>
            `${block} を ${total} 個中 ${position} 番目に移動しました`,
        validation: ({ reason }) => reason,
        validationInBlock: ({ block, reason }) => `${block}: ${reason}`,
        needsYou: ({ count }) => `${count} 個のステップが対応を待っています`,
        needsYouLoaded: '読み込み済み',
        terminal: ({ state }) => state,
        terminalWithAttention: ({ state, count }) =>
            `${state}。${count} 個のステップが対応を待っています`,
        selectedRowUpdated: ({ block }) => `${block} を更新しました`,
        progress: ({ count }) => `${count} 個のステップを更新しました`,
        progressLoaded: ({ count }) => `ここまで ${count} 個のステップを更新しました`,
        progressWithAttention: ({ count, attention }) =>
            `${count} 個のステップを更新しました。うち ${attention} 個が対応を待っています`,
        flowNode: ({ node, state }) => `${node}、${state}`,
        editStep: 'ステップを編集',
        editBlock: 'ブロックを編集',
        commandRefused: ({ reason }) => `まだ実行できません。${reason}`,
    },
});

const workflowTranslations = { ja } as const;

return { workflowTranslations };
})();

const Domain_workspaceBarTranslations = (() => {
type WorkspaceBarTranslation = Shared_workspaceBarTranslations.WorkspaceBarTranslation;

const en = Shared_workspaceBarTranslations.en;

const workspaceBarTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', WorkspaceBarTranslation>>, "ja"> = { ja: { workspaceBar: { tabsLabel: '開いているタブ', tabMenuLabel: 'タブのオプション', pinTab: 'タブを固定', unpinTab: 'タブの固定を解除', splitRight: '右に分割', splitDown: '下に分割', maximizePane: 'ペインを最大化', restorePane: 'ペインを元に戻す', closeTab: 'タブを閉じる', closeOtherTabs: '他のタブを閉じる', closeTabsToLeft: '左側のタブを閉じる', closeAllTabs: 'すべてのタブを閉じる', closeTabsToRight: '右側のタブを閉じる', allTabs: 'すべてのタブ', searchTabs: 'タブを検索', splitPane: 'アクティブなペインを分割', openInNewTab: '新しいタブで開く', openToRight: '右に開く', openBelow: '下に開く', newTab: '新しいタブ' } } };

return { workspaceBarTranslations };
})();

const Domain_workspaceSyncDiagnosticTranslations = (() => {
type WorkspaceSyncDiagnosticTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncDiagnosticTranslation;

type WorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslation;

type WorkspaceSyncLocale = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncLocale;

type WorkspaceSyncTranslationCore = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslationCore;

type WorkspaceSyncReviewBase = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncReviewBase;

const completeWorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.completeWorkspaceSyncTranslation;

const workspaceSyncDiagnosticTranslations = { ja: {
        diagnostics: { title: '診断', relationshipId: '関係 ID', controllerMachineId: '制御マシン ID', alphaMachineId: 'ソースマシン ID', betaMachineId: '宛先マシン ID', alphaRoot: '現在のソースフォルダー', betaRoot: '現在の宛先フォルダー', engineMode: 'エンジンモード', engineState: 'エンジン状態', errorCode: 'エラーコード' },
        error: { updateRequired: 'このワークスペースの引き継ぎを再試行する前に、ソースマシンの Happier を更新してください。他のセッションやマシンの操作は引き続き利用できます。' },
        resolve: { title: 'ワークスペースの競合を解決しますか？', body: ({ path, side }) => `フォルダー ${path} の「${side}」バージョンを保持しますか？現在の状態を確認した後、もう一方のフォルダーとそこにしかない内容が削除されます。`, unverifiedFile: '現在のファイル指紋がないバージョンは安全に削除できません。競合を更新してから、もう一度お試しください。' },
    } } as const satisfies Pick<Record<string, WorkspaceSyncDiagnosticTranslation>, "ja">;

const workspaceSyncSetAttentionTranslations = { ja: { attention: { conflictedLinks: ({ count }) => `${count} 件のリンクで競合があります`, unavailableLinks: ({ count }) => `${count} 件のリンクの状態を確認してください` } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'attention'>>, "ja">;

const workspaceSyncAddMachineTranslations = { ja: { availableOn: '利用できるマシン', addMachine: { replica: 'レプリカ', exactReplica: '完全なレプリカ', editableCopy: '編集可能なコピー', thisMachine: 'このマシン', machineHint: 'このワークスペースを同期しておく場所です。', folderSetup: 'フォルダーの準備', awaitingApproval: '承認待ちです。', editableCopyHint: 'リンクしたマシン上の変更は、他のマシンのエージェントにも見える場合があります。競合するバージョンは確認が必要です。作業を分離したい場合は、別のワークツリーを使用してください。' } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'availableOn' | 'addMachine'>>, "ja">;

const workspaceSyncReviewOutcomeTranslations = { ja: { keepBoth: '両方のバージョンを保持', preserveAt: ({ path }) => `別のバージョンを ${path} に保持`, notReviewed: '未確認。この場所は変更しません', confirmScope: '一覧の確認済みワークスペースのみ変更します。利用できないワークスペースは変更しません。', preserved: '保持済み', alreadyPresent: '既に存在', notStarted: '未開始', askAgent: 'エージェントに相談', askAgentPrompt: ({ path, versions }) => `リンクされたワークスペースにある ${path} の競合バージョンを確認してください：\n${versions}\n現在のファイルを調べ、安全な解決策を提案してください。私の承認なしに変更や競合解決をしないでください。` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'keepBoth' | 'preserveAt' | 'notReviewed' | 'confirmScope' | 'preserved' | 'alreadyPresent' | 'notStarted' | 'askAgent' | 'askAgentPrompt'>>, "ja">;

const workspaceSyncCoverageIncompleteTranslations = { ja: '一部のリンクまたは端点は未確認です。読み込み済みの競合は表示します。解決できるのは明示的に確認した利用可能なバージョンだけです。' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['coverageIncomplete']>, "ja">;

const workspaceSyncReviewLifecycleTranslations = { ja: { requestingApproval: '承認を要求しています…', applying: '確認済みの変更を適用しています…', propagationExpected: ({ names }) => `${names} への反映を予定`, propagationUnverified: ({ names }) => `${names} への反映はまだ確認できません` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'requestingApproval' | 'applying' | 'propagationExpected' | 'propagationUnverified'>>, "ja">;

const workspaceSyncLocalOnlyTranslations = { ja: 'この代替場所はそのワークスペース内だけに残ります' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['localOnly']>, "ja">;

const workspaceSyncKeepAlternativesTranslations = { ja: '別のバージョンも保持' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['keepAlternatives']>, "ja">;

const workspaceSyncReviewDecisionTranslations = { ja: { chooseTargets: '置き換えるワークスペースを選択', notSelected: '今回の解決対象には未選択', inspectCurrentVersions: '現在のバージョンを確認' } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'chooseTargets' | 'notSelected' | 'inspectCurrentVersions'>>, "ja">;

const workspaceSyncReviewTranslations: Pick<Record<WorkspaceSyncLocale, WorkspaceSyncReviewBase>, "ja"> = { ja: {
        executable: '実行可能', regular: '実行不可', applied: '適用済み', appliedPaused: '適用済み・同期は一時停止中', changed: '適用前に変更', offline: 'オフライン・未適用', cancelled: 'キャンセル済み', unknown: '結果不明・この端点を確認', failed: '失敗・未適用', recoveryNeeded: 'この場所で復旧が必要', inspectionUnavailable: '現在のバージョンを確認できません。管理コンピューターに接続できたら更新してください。', coverageIncomplete: '一部のリンクまたは端点を確認できません。読み込み済みの競合は表示しますが、解決はまだできません。', versions: 'バージョン', comparison: '選択したバージョンを比較', linkDecisions: 'リンクごとの選択', result: '解決結果', confirmTitle: 'このバージョンを使用しますか？', confirmBody: ({ path, source, count }) => `${source} の ${path} のバージョンをほかの ${count} 個のワークスペースで使用しますか？変更前にすべてのバージョンを検証します。`, useVersion: 'バージョンを使用', useNamedVersion: ({ name }) => `${name} を使用`, compareNamedVersion: ({ name }) => `${name} と比較`, linkCount: ({ count }) => `${count} 個のリンクがこのパスを報告`, moreOnLink: ({ name }) => `${name} の続きを読み込む`,
    } };

const workspaceSyncReviewSelectionTranslations = { ja: { selectionIncluded: 'このリンクで対象', selectionExcluded: 'このリンクで除外', selectionUnknown: '選択結果不明', reasonRepositoryMetadata: 'リポジトリのメタデータ', reasonSubmodule: 'Git サブモジュール', reasonConfiguredRule: '設定済みルール', reasonGitIgnore: 'Git の無視ルール', reasonEndpointUnavailable: '端点を利用できません', reasonSelectionUnavailable: '選択判定を利用できません', configuredInclude: ({ pattern }) => `含めるパターン: ${pattern}`, configuredExclude: ({ pattern }) => `除外パターン: ${pattern}`, completedLinks: ({ count }) => `ブロック前に ${count} 件のリンクを完了` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'selectionIncluded' | 'selectionExcluded' | 'selectionUnknown' | 'reasonRepositoryMetadata' | 'reasonSubmodule' | 'reasonConfiguredRule' | 'reasonGitIgnore' | 'reasonEndpointUnavailable' | 'reasonSelectionUnavailable' | 'configuredInclude' | 'configuredExclude' | 'completedLinks'>>, "ja">;

const ja = completeWorkspaceSyncTranslation({
    diagnostic: workspaceSyncDiagnosticTranslations["ja"],
    review: workspaceSyncReviewTranslations["ja"],
    selection: workspaceSyncReviewSelectionTranslations["ja"],
    outcome: workspaceSyncReviewOutcomeTranslations["ja"],
    lifecycle: workspaceSyncReviewLifecycleTranslations["ja"],
    decision: workspaceSyncReviewDecisionTranslations["ja"],
    coverage: workspaceSyncCoverageIncompleteTranslations["ja"],
    localOnly: workspaceSyncLocalOnlyTranslations["ja"],
    alternatives: workspaceSyncKeepAlternativesTranslations["ja"],
    addMachine: workspaceSyncAddMachineTranslations["ja"],
    attention: workspaceSyncSetAttentionTranslations["ja"],
}, {
    title: 'ワークスペースの同期',
    footer: '状態は各リンクを管理するマシンから取得されます。変更は、そのマシンによる確認後に表示されます。',
    legacyRecovery: {
        title: '廃止された同期データ',
        footer: 'Happier は廃止されたデータを確認して隔離するだけです。アプリから削除することはありません。',
        checking: 'コンピューターを確認しています…',
        inspectFailed: '一部のコンピューターを確認できませんでした。すでに見つかった隔離フォルダーは表示されたままです。コンピューターに接続できるようになってから再試行してください。',
        outdatedTitle: ({ machine }) => `${machine} では古いバージョンの Happier が実行されています`,
        outdatedBody: 'このバージョンでは廃止された同期データを確認できません。そのコンピューターの Happier を更新してから、ここでもう一度確認してください。',
        explanation: 'このコンピューターには廃止された複製エンジンのデータがあります。Happier は認識したデータを非公開の隔離領域へ移し、古いエンジンが動作しないよう同期を無効にしました。',
        quarantinePath: '隔離フォルダー',
        openFolder: 'フォルダーを開く',
        offlineTitle: 'Happier がオフラインの間に削除',
        offlineSteps: ({ path }) => `1. このデータを使用する可能性がある Happier のバックグラウンドサービスをすべて停止します。\n2. オペレーティングシステムで次のフォルダーだけを削除します：${path}\n3. サービスを再起動して、ここでもう一度確認します。`,
        unknown: ({ path, reason }) => `${path} にある古い状態を安全に分類できませんでした（${reason}）。同期は無効のままです。このパスを手動で確認し、アプリからは削除しないでください。`,
        reinspect: 'もう一度確認',
    },
    none: 'まだ別のマシンと同期していません',
    emptyDescription: 'このフォルダーのファイルを別のマシンで最新に保ち、そこでエージェントが同じファイルで作業できるようにします。', conflictsTitle: 'ワークスペースの競合',
    openConflicts: ({ count }) => `${count} 個のリンクの同期を確認`, noConflicts: '競合はありません',
    previewUnavailable: '制御コンピューターから安全なプレビューを取得できませんでした。再試行する前に競合を更新してください。',
    truncated: ({ count }) => `さらに ${count} 件の競合が表示されていません`, unknownMode: '未対応の同期モード',
    conflictCount: ({ count }) => `${count} 件の競合`,
    conflictKind: { file: 'ファイル', directory: 'フォルダー', symlink: 'シンボリックリンク', missing: '見つかりません', unsupported: '未対応の項目' },
    mode: { copyOnce: '一度だけコピー', keepSynced: '最新に保つ — 推奨', mirrorExactly: '完全にミラーリング', keepBothInSync: '両方を同期' },
    state: { loading: '状態を確認しています…', starting: '準備中', watching: '監視中', flushing: '同期中', paused: '一時停止中', peerOffline: 'オフライン', conflicted: '競合あり', controllerUnavailable: '対応が必要', engineUnavailable: 'コンポーネントを利用できません', error: '対応が必要', stopped: '停止済み', working: '処理中…' },
    lastChecked: ({ at }) => `最終確認：${at}`,
    endpoint: { source: ({ label }) => `ソース · ${label}`, destination: ({ label }) => `宛先 · ${label}`, synced: ({ label }) => `同期先 · ${label}` },
    error: {
        componentUnavailable: 'このビルドではワークスペース同期を利用できません。必要なコンポーネントをインストールして、もう一度お試しください。',
        machineOffline: '宛先コンピューターを利用できません。再接続してから、もう一度お試しください。',
        destinationNeedsPreparation: '同期を開始する前に宛先フォルダーの準備が必要です。',
        gitPreparationFailed: 'この Git ワークスペースを準備できませんでした。宛先を確認して、もう一度お試しください。',
        authorizationExpired: 'ワークスペースの承認期限が切れました。操作をもう一度開始してください。',
        rootNoLongerAuthorized: 'ワークスペースフォルダーが変更され、承認対象ではなくなりました。再試行する前にリンクを確認してください。',
        conflictNeedsAttention: 'この競合は変更されています。バージョンを選ぶ前に更新してください。',
        needsAttention: 'ワークスペース同期に対応が必要です。状態を更新して、もう一度お試しください。',
    },
    start: { blocked: { targetMachine: '続行するには宛先マシンを選択してください。', targetMachineOffline: 'そのマシンは現在利用できません。再接続して、もう一度お試しください。', relationshipUnavailable: 'この同期関係は、この 2 つのフォルダーを対象としていません。別のワークスペースオプションを選択してください。', sourceFolder: 'このセッションのフォルダーは安全に同期できません。セッションだけを引き継ぐには「ファイルを移動しない」を選択してください。', destinationFolder: '有効な宛先フォルダーを選択してください。', workspaceOptions: '開始する前にワークスペースのオプションを確認してください。' } },
    engine: { checking: 'このコンピューターのワークスペース同期を確認しています…' },
    actions: { refresh: '状態を更新', syncNow: '今すぐ同期', more: '同期の操作', pause: '一時停止', resume: '再開', terminate: '同期を停止', openOnMachine: ({ machine }) => `${machine} で開く`, openFolder: ({ label }) => `${label} フォルダーを開く`, keepLocal: 'ローカル版を保持', keepRemote: 'リモート版を保持', keepNamed: ({ side }) => `${side} のバージョンを保持` },
    terminate: { title: 'ワークスペース同期を削除しますか？', body: '同期を停止し、これらのフォルダー間のリンクを削除します。両方のワークスペースのファイルはそのまま残ります。' },
    resolve: { changedTitle: '競合が変更されました', changedBody: 'この競合は開いてから変更されました。一覧を更新しました。もう一度選ぶ前に最新のバージョンを確認してください。', consequence: 'Happier がファイルに変更がないことを確認した後にのみ、もう一方のバージョンが削除されます。', unsupported: 'この競合には未対応のファイルシステム項目が含まれているため、Happier では解決できません。対象のコンピューターで削除または置換してから更新してください。', keepHint: ({ side }) => `${side} のバージョンを保持し、確認済みのもう一方を削除します。` },
    fileState: { text: 'テキストのプレビュー', binary: 'バイナリファイル — プレビューできません', tooLarge: 'ファイルが大きすぎてプレビューできません', missing: 'ファイルがありません', changed: 'この競合が表示されてからファイルが変更されました' },
});

const workspaceSyncTranslations = { ja } as const satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation>, "ja">;

return { workspaceSyncDiagnosticTranslations, workspaceSyncSetAttentionTranslations, workspaceSyncAddMachineTranslations, workspaceSyncReviewOutcomeTranslations, workspaceSyncCoverageIncompleteTranslations, workspaceSyncReviewLifecycleTranslations, workspaceSyncLocalOnlyTranslations, workspaceSyncKeepAlternativesTranslations, workspaceSyncReviewDecisionTranslations, workspaceSyncReviewTranslations, workspaceSyncReviewSelectionTranslations, workspaceSyncTranslations };
})();

const Domain_workspaceTabTranslations = (() => {
const en = Shared_workspaceTabTranslations.en;

const workspaceTabKeyboardTranslations = Shared_workspaceTabTranslations.workspaceTabKeyboardTranslations;

const workspaceTabTranslations = { ja: en };

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
    Domain_fileViewerTranslations as fileViewerTranslations,
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
