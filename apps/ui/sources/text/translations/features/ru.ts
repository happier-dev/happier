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

const accountDisplayTranslations = { ru: { unnamed: 'Аккаунт без имени', yours: 'Ваш аккаунт', shortId: ({ id }) => `ID …${id}` } } as const satisfies Pick<Record<string, AccountDisplayTranslation>, "ru">;

return { accountDisplayTranslations };
})();

const Domain_accountEncryptionRecoveryTranslations = (() => {
type Copy = Shared_accountEncryptionRecoveryTranslations.Copy;

const en = Shared_accountEncryptionRecoveryTranslations.en;

const ru: Copy = {
    recoverAutomationTemplates: 'Восстановить старые триггеры',
    recoverAutomationTemplatesDescription: 'Используйте ключи этого устройства для восстановления старых триггеров. Ключи сохраняются, пока нужны зашифрованным сессиям или заблокированным триггерам.',
    recoverAutomationTemplatesAction: 'Восстановить',
    recoverAutomationTemplatesComplete: 'Триггеры восстановлены. Старый ключ останется на этом устройстве, пока вы не решите его забыть.',
    recoverAutomationTemplatesRetained: 'Восстановление проверено. Некоторые триггеры остаются зашифрованными, заблокированными или изменёнными. Старый ключ остаётся на устройстве.',
    forgetEncryptionKey: 'Забыть старый ключ шифрования',
    forgetEncryptionKeyDescription: 'Старые зашифрованные сессии будут заблокированы на этом устройстве.',
    forgetEncryptionKeyAction: 'Забыть',
    forgetEncryptionKeyConfirm: 'Забыть старый ключ шифрования?',
    forgetEncryptionKeyWarning: ({ items }) => `Старые зашифрованные сессии будут заблокированы на этом устройстве. Эта зашифрованная история может стать недоступной:\n\n${items}\n\nСписок отражает текущую историю. Зашифрованные сессии, созданные позже на другом устройстве, тоже будут заблокированы. Восстановите старый ключ, чтобы разблокировать их. Из аккаунта ничего не удаляется.`,
    forgetEncryptionKeySession: ({ name, id }) => `Сессия: ${name} (${id})`,
    forgetEncryptionKeyTrigger: ({ id }) => `Триггер: ${id}`,
    forgetEncryptionKeyRun: ({ id }) => `История запуска: ${id}`,
    forgetEncryptionKeyEmpty: 'Зашифрованная история не найдена.',
    forgetEncryptionKeyComplete: 'Старый ключ забыт на этом устройстве.',
    forgetEncryptionKeyFailed: 'Не удалось забыть ключ. Подключитесь снова и повторите попытку; сначала нужно получить список зашифрованной истории.',
};

const accountEncryptionRecoveryTranslations = { ru } as const;

return { accountEncryptionRecoveryTranslations };
})();

const Domain_accountPopoverTranslations = (() => {
type AccountPopoverTranslation = Shared_accountPopoverTranslations.AccountPopoverTranslation;

const accountPopoverTranslations = { ru: {
        pageTitle: 'Аккаунт и Home',
        homesTitle: 'Home',
        notLinkedTo: ({ service }) => `Не связано с ${service}`,
        serviceUnavailable: ({ service }) => `Не удаётся подключиться к ${service}`,
        signedInToThisHome: 'Выполнен вход в этот Home',
        checkingSignIn: 'Проверка входа…',
        signInStatusUnavailable: 'Статус входа недоступен',
        machinesOnline: ({ online, total }) => `В сети: ${online} из ${total}`,
        noMachines: 'Пока нет машин',
        connectedNoMachinesOnline: 'Подключено · нет машин в сети',
        cantReach: 'Нет связи',
        signedOut: 'Выполнен выход',
        signIn: 'Войти',
        link: 'Связать',
        linkSubtitle: 'Находите свои Home на любом устройстве',
        manageHomes: 'Управление Home',
        connectionDetails: 'Сведения о подключении',
        allHomes: 'Все Home',
        allHomesSubtitle: ({ count }) => `${count} Home · один список`,
        addHome: 'Добавить Home…',
        addDevice: 'Добавить устройство',
    } } as const satisfies Pick<Record<string, AccountPopoverTranslation>, "ru">;

return { accountPopoverTranslations };
})();

const Domain_accountServiceOAuthTranslations = (() => {
const en = Shared_accountServiceOAuthTranslations.en;

const ru = {
    title: 'Войдите, чтобы найти свои Homes',
    cancelNote: 'Отмена не приведёт к выходу из существующих Homes.', focusedHomePreserved: 'Текущий Home не изменится.',
    stages: { signingIn: 'Выполняется вход', findingHomes: 'Поиск ваших Homes', waitingApproval: 'Ожидание одобрения Home' },
    errors: { provider: { title: 'Провайдер не завершил вход', body: 'Начните вход заново.' }, expired: { title: 'Срок действия запроса на вход истёк', body: 'Начните вход заново.' }, identityChanged: { title: 'Идентификатор службы входа изменился', body: 'Убедитесь, что это нужная служба входа, прежде чем подключаться снова.' }, unavailable: { title: 'Служба входа недоступна', body: 'Проверьте службу и повторите попытку. Существующие Homes не изменятся.' }, exchange: { title: 'Не удалось завершить вход', body: 'Учётные данные службы входа не сохранены. Начните вход заново.' }, storage: { title: 'Не удалось сохранить вход', body: 'Учётные данные существующих Homes не изменятся. Начните вход заново.' }, homeLink: { title: 'Вход выполнен, но этот Home не удалось связать', body: 'Вход сохранён. Попробуйте связать этот Home ещё раз.' }, directoryRefresh: { title: 'Вход выполнен, но список Homes не удалось обновить', body: 'Подключение службы входа готово. Попробуйте обновить список Homes ещё раз.' }, homeEnrollment: { title: 'Вход выполнен, но личный Home не добавлен', body: 'Вход сохранён. Попробуйте добавить Home ещё раз.' }, invalid: { title: 'Этот запрос на вход больше недействителен', body: 'Начните вход заново.' }, accountDisabled: { title: 'Этот аккаунт отключён', body: 'Обратитесь к администратору службы входа. Ваши существующие Homes не изменятся.' } },
    actions: { startAgain: 'Начать заново', openHome: ({ homeName }: { homeName: string }) => `Открыть ${homeName}` },
    success: { title: ({ homeName }: { homeName: string }) => `${homeName} подключён`, body: 'Вход сохранён, и этот Home готов к работе.' },
    notLinked: { title: ({ homeName }: { homeName: string }) => `${homeName} ещё не привязан к этому аккаунту`, signInAction: ({ homeName }: { homeName: string }) => `Войти в ${homeName}`, body: ({ homeName }: { homeName: string }) => `Войдите в ${homeName} напрямую или отсканируйте его QR-код либо вставьте его ссылку Home.`, scanBody: ({ homeName }: { homeName: string }) => `Отсканируйте QR-код ${homeName} или вставьте его ссылку Home, чтобы подключить его.` },
    noHomes: { body: 'У этого аккаунта пока нет Home. Обновите после добавления Home в другом месте или отсканируйте QR-код Home либо вставьте его ссылку Home.' },
    approvalWait: { waitingBody: 'Подтвердите этот вход на другом устройстве, где вы уже вошли.', cancelledTitle: 'Ожидание одобрения прекращено', cancelledBody: 'Вход сохранён, существующие Homes не изменились.' },
} as const;

const accountServiceOAuthTranslations = { ru } as const;

return { accountServiceOAuthTranslations };
})();

const Domain_actionConfirmationTranslations = (() => {
type ActionConfirmationTranslations = Shared_actionConfirmationTranslations.ActionConfirmationTranslations;

const actionConfirmationTranslations = { ru: {
        requestedByAgent: 'Действие запрошено агентом сеанса',
        homeTarget: ({ serverId }) => `Home: ${serverId}`,
        sessionTarget: ({ sessionId }) => `Целевой сеанс: ${sessionId}`,
        oneShotConsequence: 'Одобрение действует только для этого запроса и не даёт будущих разрешений Action или системных разрешений.',
        homeUnavailable: 'Это одобрение относится к Home, недоступному на этом устройстве. Подключите Home повторно, чтобы принять решение.',
    } } as const satisfies Pick<Record<string, ActionConfirmationTranslations>, "ru">;

return { actionConfirmationTranslations };
})();

const Domain_fileContentSearchTranslations = (() => {
const fileContentSearchTranslations = { "ru": {
        textInFiles: "Текст в файлах",
        everything: "Всё",
        refineSearch: "Уточните поиск",
        partial: "Не удалось выполнить поиск в некоторых файлах. Результаты неполные.",
        updateRequired: "Обновите Happier на этой машине для поиска текста в файлах.",
        invalidPattern: "Некорректное регулярное выражение. Измените шаблон и повторите попытку.",
        unavailable: "Поиск текста недоступен. Проверьте подключение машины и повторите попытку.",
        placeholder: "Поиск файлов, сообщений, коммитов, сессий, настроек и действий",
        matchCase: "Учитывать регистр",
        regex: "Регулярное выражение",
    } };

return { fileContentSearchTranslations };
})();

const Domain_promptPickerTranslations = (() => {
const promptPickerTranslations = { "ru": {
        "partialHistory": "История отправки охватывает только известные сессии.",
        "loadedHistory": "История отправки показывает только загруженные сообщения.",
        "open": "Открыть промпты",
        "menu": "Промпты…",
        "placeholder": "Поиск промптов и отправленных сообщений",
        "favorites": "Избранное",
        "library": "Библиотека",
        "sentBefore": "Отправлено ранее",
        "builtIn": "Встроенный",
        "readError": "Не удалось прочитать промпт. Повторите попытку.",
        "libraryError": "Не удалось загрузить библиотеку.",
        "partialLibrary": "Некоторые промпты не удалось прочитать.",
        "loadOlder": "Искать в старых сообщениях",
        "stop": "Остановить",
        "insert": "Вставить",
        "send": "Отправить сейчас",
        "addFavorite": "Добавить в избранное",
        "removeFavorite": "Удалить из избранного",
        "empty": "Сохраните сообщение как промпт, чтобы использовать его здесь снова.",
        "applyError": "Не удалось применить промпт. Повторите попытку.",
        "historyError": "Не удалось загрузить старые сообщения. Повторите попытку.",
        "title": "Промпты",
        "clear": "Очистить",
        "favorite": "Избранное",
        "favoritesInvite": "Отметьте звёздочкой промпт или отправленное сообщение, чтобы оно было здесь.",
        "saveAsFavorite": "Сохранить как избранный промпт",
        "saveInPlaceStarred": ({ time }: { time: string }) => `Из вашего сообщения ${time} · попадёт в библиотеку со звёздочкой`,
        "saveInPlace": ({ time }: { time: string }) => `Из вашего сообщения ${time} · попадёт в библиотеку`,
        "noMatchesFor": ({ query }: { query: string }) => `Нет промптов или загруженных сообщений по запросу «${query}»`,
        "previewInserts": "вставится, затем вы отправите",
        "previewSent": "отправлено ранее",
        "previewEdited": ({ time }: { time: string }) => `Изменено ${time}`,
        "searchingOlder": ({ searched, total }: { searched: number; total: number }) => `Поиск в более ранних сообщениях… ${searched} из ${total} сессий`
    } } as const;

return { promptPickerTranslations };
})();

const Domain_actionFamilyTranslations = (() => {
const fileContentSearchTranslations = {...Domain_fileContentSearchTranslations.fileContentSearchTranslations, ...EnglishFeatures.fileContentSearchTranslations.fileContentSearchTranslations};

const promptPickerTranslations = {...Domain_promptPickerTranslations.promptPickerTranslations, ...EnglishFeatures.promptPickerTranslations.promptPickerTranslations};

const surfaceFamilyLabels = Shared_actionFamilyTranslations.surfaceFamilyLabels;

const english = Shared_actionFamilyTranslations.english;

const translated = Shared_actionFamilyTranslations.translated;

const actionFamilyTranslations = { ru: translated({
        actionFamilies: {
            ...surfaceFamilyLabels,
            workspace_file_search: fileContentSearchTranslations.ru.textInFiles,
            find: 'Поиск',
            app_shell: 'Workspace',
            roles: 'Роли',
            launch_profiles: 'Профили запуска',
            discovery: 'Поиск действий',
            computer: 'Управление компьютером',
            artifact_access: 'Общий доступ к артефактам',
            workflows: 'Рабочие процессы',
            notifications: 'Уведомления',
            machine_agent_install: 'Установка агентов',
            machine_agent_sign_in: 'Вход агентов',
            session_access: 'Общий доступ к сессиям',
            session_lifecycle: 'Жизненный цикл сессий',
            inventory: 'Инвентарь компьютеров',
            messaging: 'Сообщения',
            session_control: 'Управление сессиями',
            intent_start: 'Ревью и делегирование',
            review_comments: 'Комментарии ревью',
            subagent_registry: 'Субагенты',
            execution_run_control: 'Фоновые запуски',
            session_targeting: 'Выбор сессий',
            session_follow: 'Отслеживание сессий',
            session_transcripts: 'Транскрипты сессий',
            session_read_state: 'Статус прочтения',
            session_attention: 'Внимание',
            session_board: 'Доска сессий',
            session_discussion: 'Обсуждения',
            session_permissions: 'Разрешения сессий',
            external_sessions: 'Внешние сессии',
            voice_controls: 'Голосовое управление',
            current_ui_context: 'Текущий экран',
            companion_controls: 'Компаньон',
            memory: 'Память',
            agent_acp_catalog: 'Агенты ACP',
            prompt_library: 'Библиотека промптов',
            daemon_admin: 'Администрирование демона',
            browser_control: 'Управление браузером',
            browser_diagnostics: 'Диагностика браузера',
            browser_context: 'Контекст браузера',
            browser_automation: 'Автоматизация браузера',
            browser_recording: 'Запись браузера',
            local_services_inventory: 'Локальные сервисы',
            local_services_launcher: 'Запуск сервисов',
            local_services_preview: 'Предпросмотр сервисов',
            local_services_public_preview: 'Публичный предпросмотр',
            local_services_actions: 'Действия сервисов',
            peer_mediation_observability: 'Диагностика подключений',
            devices_simulator: 'Симуляторы',
            approvals: 'Одобрения',
            plugin_dev_loop: 'Разработка плагинов',
            plugin_settings_administration: 'Настройки плагинов',
            plugin_permission_grants: 'Разрешения плагинов',
            plugin_webhooks: 'Вебхуки плагинов',
            account_plugin_data: 'Данные плагинов',
            account_sessions: 'Устройства со входом',
            account_security: 'Безопасность аккаунта',
            account_api_tokens: 'Токены API',
            identity_github_apps: 'Приложения GitHub',
            identity_providers: 'Провайдеры входа',
            machine_pools: 'Пулы компьютеров',
            ephemeral_runner: 'Раннеры',
            automation_events: 'События автоматизации',
            automation_conversation: 'Диалоги автоматизации',
            scm_git: 'Git',
            scm_pull_request: 'Запросы на слияние',
            scm_repository: 'Репозитории',
            scm_diff_summary: 'Сводки изменений',
            home_governance: 'Администрирование Home',
            teams: 'Команды',
            saved_secret_sharing: 'Общие секреты',
        },
    }) } as const;

return { actionFamilyTranslations };
})();

const Domain_addFlowsTranslations = (() => {
type AddFlowsTranslation = Shared_addFlowsTranslations.AddFlowsTranslation;

const addFlowsTranslations = { ru: {
        addHome: 'Добавить Home',
        addHomeSubtitle: 'Войти, подключиться по адресу или использовать размещённый',
        addHomeDescription: 'Подключите Home, которым вы уже пользуетесь, или используйте размещённый для вас.',
        newGroup: 'Новая группа',
        newGroupSubtitle: 'Сеансы нескольких Home вместе',
        groupsTitle: 'Группы',
        homesInUse: 'Используется здесь',
        thisDeviceTitle: 'Это устройство',
        thisDeviceSubtitle: 'Как оно подключается к своим Home',
        thisDeviceDescription: 'Как это устройство подключается к своим Home: ожидающие устройства, используемое соединение и Home, который оно запускает.',
        newHomeDraft: 'Новый Home',
        homeMissingTitle: 'Этого Home нет на устройстве',
        homeMissingDescription: 'Он был удалён или сохранён на другом устройстве.',
        homeManageTitle: 'Управление',
        homeAdministrationSubtitle: 'Люди, вход, доступ и данные этого Home',
        groupMissingTitle: 'Этой группы больше нет',
        groupMissingDescription: 'Она была удалена. Ваши Home не изменились.',
        discard: 'Отменить',
        sshSignInAgent: 'Ваш SSH-агент на этом компьютере',
        sshSignInKeyFile: 'Файл закрытого ключа на этом компьютере',
        sshSignInPassword: 'Используется один раз и не сохраняется',
        addMachineMenuSubtitle: 'Компьютер или сервер',
        addMachineDescription: 'Добавьте компьютер или сервер, чтобы агенты запускали на нём ваши сеансы.',
        machineJoinsHome: ({ home }) => `Присоединится к ${home}`,
        pathThisComputerTitle: 'Этот компьютер',
        pathThisComputerTask: 'Настройка в один шаг',
        pathThisComputerCommand: 'Одна команда в терминале',
        pathSshTitle: 'Сервер по SSH',
        pathSshChip: 'Сервер по SSH',
        pathSshSubtitle: 'Dev-машина, ВМ или облачный сервер',
        pathAnotherTitle: 'Другой компьютер',
        pathAnotherSubtitle: 'Откройте ссылку на Дом на том компьютере',
        machinePoolPrompt: 'Хотите, чтобы сеансы переключались между машинами?',
        thisComputerCommandLead: ({ home }) => `Выполните это в терминале этого компьютера. Команда установит Happier и присоединит его к ${home}; страница сразу заметит.`,
        thisComputerTaskLead: ({ machine, home }) => `${machine} будет запускать агентов для ${home}. Happier установит небольшую фоновую службу, которая стартует вместе с компьютером.`,
        setUpThisComputer: 'Настроить этот компьютер',
        desktopAppHint: 'Удобнее кликнуть, чем печатать?',
        desktopAppLink: 'Установите приложение для компьютера — оно всё настроит само.',
        thisComputerRunningLead: ({ machine }) => `Настраиваем ${machine}. Можете продолжать работать в Happier.`,
        onAnotherHomeTitle: ({ machine }) => `${machine} подключён к другому Home`,
        onAnotherHomeBody: ({ home }) => `Его служба Happier работает для другого Home. Перенос в ${home} сохранит настройки; уже созданные сеансы останутся там.`,
        moveToHome: ({ home }) => `Перенести в ${home}`,
        keepOnOtherHome: 'Оставить как есть',
        sshLeadTask: ({ home }) => `Dev-машина, ВМ или облачный сервер, к которому вы уже подключаетесь по SSH. Этот компьютер подключится, установит Happier и присоединит его к ${home}.`,
        sshLeadCommand: ({ home }) => `Dev-машина, ВМ или облачный сервер, доступный по SSH. Выполните команду на компьютере, который может к нему подключиться; она установит Happier и присоединит его к ${home}.`,
        setUpHost: ({ host }) => `Настроить ${host}`,
        sshSavedNote: 'Хост сохранится в «Удалённых хостах»; пароли — никогда.',
        sshRunningTitle: ({ host }) => `Настраиваем ${host}`,
        sshRunningLead: 'Работает по SSH с этого компьютера. Можно уйти: список машин покажет ход и сообщит о завершении.',
        anotherLead: ({ home }) => `Выполните это в терминале того компьютера. Команда установит Happier и присоединит его к ${home}.`,
        anotherTerminalAction: 'Использовать команду терминала',
        machineWatching: ({ subject }) => `Ждём ${subject} в `,
        subjectThisComputer: 'этот компьютер',
        subjectAnotherComputer: 'компьютер',
        machineNotSeeingTitle: ({ subject }) => `Пока не видно ${subject}?`,
        machineNotSeeingBody: ({ home }) => `Happier всё ещё ждёт. Обычно настройка завершилась с ошибкой, машина не видит ${home} или её настроили для другого Home.`,
        machineArrived: ({ machine }) => `${machine} подключён`,
        machineConnectedJustNow: 'подключён только что',
        machineStartSession: ({ machine }) => `Начать сеанс на ${machine}`,
        machineAddAnother: 'Добавить ещё',
        cancelSetup: 'Отмена',
        detectedOs: 'Определено',
        sshSuggestionsTitle: 'Из вашего SSH-конфига и сохранённых хостов',
        connectingToHome: ({ address }) => `Подключаемся к ${address}…`,
        pathThisComputerConnected: 'Подключён · его агенты',
    } } satisfies Pick<Readonly<Record<string, AddFlowsTranslation>>, "ru">;

return { addFlowsTranslations };
})();

const Domain_agentInstallJobTranslations = (() => {
const en = Shared_agentInstallJobTranslations.en;

const agentInstallJobTranslations = { ru: { ...en } };

return { agentInstallJobTranslations };
})();

const Domain_agentStartTranslations = (() => {
const en = Shared_agentStartTranslations.en;

const ru: typeof en = {
    titles: {
        conversation: 'Разговор в стороне',
    },
    descriptions: {
        conversation: ({ machine }) => `Спросите что угодно, не прерывая эту сессию. Разговор идёт на ${machine} рядом; ничего не вернётся, пока вы это не отправите.`,
    },
    chips: {
        engineTitle: 'Кто отвечает',
        addReviewer: 'Добавить рецензента',
        removeReviewer: ({ name }) => `Убрать ${name}`,
        scope: 'Что проверить',
        advanced: 'Дополнительно',
    },
    reportToSession: 'Сообщить этой сессии',
    startsWhenYouSend: ({ count }) => count > 1 ? `Проверок начнётся при отправке: ${count}` : 'Начнётся при отправке',
    offline: ({ machine }) => `${machine} не в сети. Агент запускается там; черновик останется здесь, пока машина не вернётся.`,
    menu: {
        askSection: 'Попросить агента',
        secondOpinionTitle: 'Второе мнение',
        secondOpinionSubtitle: 'Независимая проверка перед завершением',
        keepGoingTitle: 'Продолжать до готовности…',
        keepGoingSubtitle: 'Задать цель в элементе «Цель»',
        runWorkflowTitle: 'Запустить рабочий процесс',
        runWorkflowSubtitle: 'Из библиотеки или встроенный',
        searchWorkflows: 'Искать рабочие процессы…',
        yourLibrary: 'Ваша библиотека',
        noWorkflows: 'Сохранённых процессов пока нет',
        addTriggerTitle: 'Добавить триггер…',
        addTriggerSubtitle: 'Запускается здесь каждый раз, когда что-то происходит',
        advancedTitle: 'Дополнительно…',
        advancedSubtitle: 'Несколько агентов, права, профиль',
        builtIn: 'Встроенные',
        allWorkflows: 'Все рабочие процессы…',
    },
    role: {
        replaces: ({ agent }) => `Заменяет ${agent}`,
    },
    startRow: {
        subtitle: 'Черновик · начнётся при отправке',
        conversation: 'Новый разговор',
        review: 'Новая проверка',
        plan: 'Новый план',
        delegate: 'Новая задача',
    },
    pane: {
        cancelRun: 'Отменить запуск',
        whenItFinishes: 'Когда закончится',
        sendToSession: ({ session }) => `Отправить в ${session}`,
        replyTo: ({ agent }) => `Ответить ${agent}…`,
        repliesGoTo: ({ session }) => `Ответы уходят этому агенту, а не в ${session}`,
    },
};

const agentStartTranslations = { ru };

return { agentStartTranslations };
})();

const Domain_apiTokenSettingsTranslations = (() => {
const english = Shared_apiTokenSettingsTranslations.english;

const translated = Shared_apiTokenSettingsTranslations.translated;

const apiTokenSettingsTranslations = { ru: translated({
        settingsApiTokens: {
            encryption: {
                choice: "Доступ к шифрованию",
                consequence: "Предоставляет доступ к шифрованию всей учётной записи. Отзыв прекращает будущую авторизацию API; уже полученные ключи и данные отозвать нельзя.",
                enabled: "Доступ к шифрованию включён",
                bearerOnly: "Только доступ к API",
                unknown: "Доступ к шифрованию неизвестен",
                outcomeUnknown: "Создание могло завершиться. Обновите список и отзовите этот токен, прежде чем намеренно создавать замену.",
                unsupported: "Этот Home пока не поддерживает зашифрованные API-токены. Обновите его или создайте обычный токен.",
                notReady: "Восстановите доступ к шифрованию на этом Home перед созданием зашифрованного токена.",
                stale: "Ключ шифрования учётной записи изменился. Восстановите доступ на этом Home.",
                idConflict: "Этот идентификатор токена уже существует. Отзовите именно этот токен перед созданием нового.",
            },
            unattended: {
                choice: "Автономный доступ к команде",
                consequence: "Копирует в токен текущие подтверждённые способы аутентификации этих учётных данных для ограниченной командной работы. Доступ к шифрованию настраивается отдельно.",
                authorized: "Автономный доступ к команде разрешён",
                notAuthorized: "Без автономного доступа к команде",
                evidenceLimit: "У этих учётных данных слишком много подтверждённых способов аутентификации для копирования. Токен не создан.",
                evidenceUnavailable: "У этих учётных данных нет актуального подтверждения аутентификации для копирования. Пройдите аутентификацию требуемым способом; токен не создан.",
            },
            title: 'Токены API',
            entrySubtitle: 'Позвольте скриптам, серверам и встроенным приложениям действовать от вашего имени — только с тем доступом, который вы им дадите.',
            tokens: 'Токены API',
            refreshing: 'Обновление…',
            emptyTitle: 'Токенов API пока нет',
            emptyBody: 'Токены позволяют доверенным скриптам и инструментам выполнять разрешённые вами автоматизированные действия. Создайте токен, когда интеграции нужен доступ к текущему аккаунту.',
            created: 'Создан',
            lastUsed: 'Последнее использование',
            neverUsed: 'Не использовался',
            securityTitle: 'Безопасность',
            securityFooter: 'Эти действия применяются ко всему текущему аккаунту.',
            status: {
                active: 'Активен',
                expiresInMinutes: ({ count }) => `Истекает через ${count} мин`,
                expiresInHours: ({ count }) => `Истекает через ${count} ч`,
                expiresInDays: ({ count }) => `Истекает через ${count} дн.`,
                expired: 'Истёк',
            },
            rowAccessibilityLabel: ({ label, state }) => `${label}, статус: ${state}`,
            moreActionsAccessibilityLabel: ({ label }) => `Дополнительные действия для ${label}`,
            create: {
                button: 'Создать токен',
                title: 'Создать токен API',
                subtitle: 'Назовите интеграцию и выберите срок действия этого токена. Ваш Home может читать обычные запросы и результаты API; доступ к шифрованию может защищать поддерживаемые вызовы SDK.',
                submit: 'Создать токен',
                label: 'Метка',
                labelPlaceholder: 'Автоматизация релизов',
                expiry: 'Истекает',
                expiryOptions: {
                    '30d': '30 дней',
                    '90d': '90 дней',
                    '1y': '1 год',
                    none: 'Без срока действия',
                },
                access: 'Доступ',
                accessFull: 'Полный доступ',
                accessLimited: 'Ограниченный',
                accessLimitedDescription: 'Далее выберите действия, сессии, модели и сайты.',
                accessTitle: 'Выберите доступ',
                continue: 'Продолжить',
                back: 'Назад',
                actionSettingsPrefix: 'Этот токен может выполнять любые операции, включённые для External API & SDK в ваших',
                actionSettingsLink: 'настройках действий.',
            },
            reveal: {
                title: 'Сохраните токен API',
                accessibilityAnnouncement: 'Скопируйте токен сейчас — он показывается только один раз.',
                successTitle: 'Токен создан',
                shownOnce: 'Скопируйте этот токен сейчас. В целях безопасности Happier не сможет показать его снова.',
                copy: 'Скопировать токен',
                copied: 'Скопировано',
                dismissTitle: 'Выйти без подтверждения?',
                dismissBody: 'Этот токен больше не будет показан. Сначала скопируйте его или подтвердите, что сохранили в безопасном месте.',
                copyFirst: 'Оставить токен видимым',
                savedIt: 'Я сохранил его',
            },
            revoke: {
                title: ({ label }) => `Отозвать «${label}»?`,
                body: 'Доступ к серверу и API прекратится при следующей проверке. Локальный демон, недавно проверивший этот токен API, может принимать его ещё до одной минуты. Это действие нельзя отменить.',
                confirm: 'Отозвать токен',
            },
            revokeAll: {
                title: 'Отозвать все токены API',
                subtitle: 'Отключить все токены API для этого аккаунта.',
                body: 'Доступ к серверу и API прекратится при следующей проверке. Встраивания, использующие эти токены, перестанут работать, а их встроенные учётные данные будут выведены из системы. Локальные демоны, недавно проверившие эти токены API, могут принимать их ещё до одной минуты. Это действие нельзя отменить.',
                confirm: 'Отозвать все',
                railAction: 'Отозвать все токены API…',
            },
            signOutEverywhere: {
                title: 'Выйти везде',
                subtitle: 'Завершить все сеансы, вошедшие в этот аккаунт.',
                body: 'Все сеансы в браузерах и на устройствах будут завершены. Токены API останутся активными; отзовите их отдельно на этом экране.',
                confirm: 'Выйти везде',
            },
            errors: {
                labelRequired: 'Введите метку перед созданием токена.',
                accountChanged: 'Ваш активный аккаунт или Home изменился, поэтому ничего не изменено. Откройте снова, чтобы продолжить.',
                presentUserRequired: 'Подтвердите личность в запросе на вход, затем повторите попытку.',
                offline: 'Happier не удалось связаться с вашим аккаунтом. Проверьте подключение и повторите попытку.',
                unavailable: 'Это действие сейчас недоступно. Повторите попытку через некоторое время.',
                copyFailed: 'Не удалось скопировать токен. Выделите его и скопируйте вручную перед закрытием.',
                listTitle: 'Токены API недоступны',
                grantIncomplete: 'Завершите выбор доступа перед созданием токена.',
            },
            embedPill: 'Встраивание',
            embedRowHint: 'Открывает это встраивание в разделе «Настройки», «Встраивания».',
            summary: {
                full: 'Полный доступ',
                allActions: 'Все действия',
                namesAndMore: ({ names, count }) => `${names} +${count}`,
                sessions: ({ count }) => (count === 1 ? '1 сессия' : `${count} ${count % 10 === 1 && count % 100 !== 11 ? 'сессия' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'сессии' : 'сессий'}`),
                computers: ({ count }) => (count === 1 ? '1 компьютер' : `${count} ${count % 10 === 1 && count % 100 !== 11 ? 'компьютер' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'компьютера' : 'компьютеров'}`),
                approve: 'Может одобрять',
                models: ({ count }) => (count === 1 ? '1 модель' : `${count} ${count % 10 === 1 && count % 100 !== 11 ? 'модель' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'модели' : 'моделей'}`),
                websites: ({ count }) => (count === 1 ? '1 сайт' : `${count} ${count % 10 === 1 && count % 100 !== 11 ? 'сайт' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'сайта' : 'сайтов'}`),
                content: 'Доступ к содержимому',
                noExpiry: 'Бессрочно',
                expires: ({ date }) => `Истекает ${date}`,
                expired: ({ date }) => `Истёк ${date}`,
            },
            grant: {
                accessTitle: 'Доступ',
                back: 'Доступ',
                onlyThese: 'Только выбранные',
                selectedCount: ({ count }) => (count === 1 ? '1 выбран' : `Выбрано: ${count}`),
                reviewUnnamed: 'Этот токен',
                actions: {
                    title: 'Действия',
                    all: 'Все действия',
                    none: 'Выберите хотя бы одно действие',
                    search: 'Поиск действий',
                    noMatches: ({ query }) => `Нет действий, соответствующих «${query}»`,
                    groupDescription: 'Вся группа включает и действия, добавленные в неё позже.',
                    familyCount: ({ count }) => (count === 1 ? 'Группа · 1 действие' : `Группа · ${count} ${count % 10 === 1 && count % 100 !== 11 ? 'действие' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'действия' : 'действий'}`),
                    includedByFamily: ({ family }) => `Входит в ${family}`,
                },
                targets: {
                    title: 'Сессии и компьютеры',
                    all: 'Все сессии и компьютеры',
                    none: 'Выберите хотя бы одну сессию или компьютер',
                    computers: 'Компьютеры',
                    computersDescription: 'Компьютер охватывает все сессии на нём — текущие и будущие.',
                    sessions: 'Сессии',
                    searchSessions: 'Поиск сессий',
                    noSessions: 'Сессий пока нет',
                    noSessionMatches: ({ query }) => `Нет сессий, соответствующих «${query}»`,
                    noComputers: 'Компьютеров пока нет',
                },
                models: {
                    title: 'Модели',
                    any: 'Любая модель',
                    onlyThese: 'Только эти модели',
                    none: 'Выберите хотя бы одну модель',
                    pickerDescription: 'Другие модели отклоняются, а не просто скрываются. Вариант «Автоматически» недоступен, если вы выбрали модели.',
                    noModels: 'Пока нет моделей для выбора',
                },
                approve: {
                    title: 'Одобрение запросов',
                    on: 'Он может одобрять использование инструментов и запросы в сессиях выше — включая запросы, которые он запустил сам. Он никогда не может изменять токены, безопасность или плагины.',
                    off: 'Запросы ждут вас в Happier.',
                },
                websites: {
                    title: 'Сайты',
                    description: 'Страницы этих сайтов могут использовать токен из браузера. Оставьте пустым для скриптов и серверов.',
                    inputLabel: 'Добавить сайт',
                    placeholder: 'https://app.example.com',
                    add: 'Добавить',
                    invalid: 'Начните с https:// или с http:// для localhost.',
                    duplicate: 'Этот сайт уже есть в списке.',
                    remove: ({ origin }) => `Удалить ${origin}`,
                },
            },
            detail: {
                whatItCanDo: 'Что он может',
                whatItCanDoDescription: 'Действия, которые этот токен может выполнять за вас. Всё остальное отклоняется.',
                everyAction: 'Все действия, включённые для External API & SDK',
                wholeGroup: 'Вся группа',
                where: 'Где',
                whereDescription: 'Сессии и компьютеры, к которым у него есть доступ.',
                computerCovers: 'Все сессии на этом компьютере',
                unknownComputer: 'Компьютер, которого больше нет в списке',
                unknownSession: 'Сессия, которой больше нет в списке',
                modelsDescription: 'Другие модели отклоняются, а не просто скрываются.',
                approvals: 'Одобрения',
                approvesOn: 'Одобряет запросы',
                approvesOff: 'Не одобряет запросы',
                websitesDescription: 'Страницы этих сайтов в браузере могут его использовать.',
                noWebsites: 'Только скрипты и серверы',
                content: 'Доступ к содержимому',
                contentOn: 'Он может читать содержимое со сквозным шифрованием через поддерживаемые вызовы SDK.',
                contentOff: 'Он не может читать содержимое со сквозным шифрованием.',
                children: 'Встроенные учётные данные',
                childrenDescription: 'Краткосрочные ключи, которые ваше приложение выпустило из этого токена для своих страниц.',
                childrenCount: ({ count }) => (count === 1 ? '1 активный' : `Активных: ${count}`),
                childrenConsequence: 'Будут выведены из системы, когда вы измените доступ или отзовёте этот токен.',
                sessionLimits: 'Сессии',
                sessionLimitsDescription: 'Сессии, которые он может запускать, и режимы разрешений для его сообщений.',
                createsSessions: 'Запускает сессии',
                createsSessionsOn: ({ computer }: { computer: string }) => `На ${computer}, в частной папке под управлением Happier.`,
                editAccess: 'Изменить доступ',
                revokeFootnote: 'Скрипты и встраивания, использующие его, перестанут работать при следующем запросе.',
                created: ({ date }) => `Создан ${date}`,
                lastUsed: ({ date }) => `Последнее использование: ${date}`,
                missingTitle: 'Этого токена больше нет',
                missingBody: 'Он был отозван или истёк и удалён. Остальные токены по-прежнему в списке.',
                backToTokens: 'Показать токены API',
            },
            edit: {
                title: 'Изменить доступ',
                save: 'Сохранить',
                signsOut: 'Активные встроенные учётные данные будут выведены из системы.',
            },
            cliPolicy: {
                sectionTitle: 'CLI и демон',
                sectionDescription: 'Что команды на ваших компьютерах могут делать с вашим входом.',
                title: 'Разрешить одобрения и изменения аккаунта из CLI и демона',
                description: 'Позволяет командам на ваших компьютерах одобрять запросы и изменять настройки аккаунта. Отключите, если агенты работают с доступом к оболочке. Компьютер также может отказаться с помощью HAPPIER_CLI_PRESENT_USER=disallowed. Изменение ненадолго переподключает ваши компьютеры.',
                unavailable: 'Не удалось прочитать этот параметр. Попробуйте ещё раз чуть позже.',
                saveFailed: 'Не удалось изменить этот параметр. Попробуйте ещё раз чуть позже.',
            },
            notices: {
                revoked: 'Токен API отозван.',
                revokedAll: 'Все токены API отозваны.',
                signedOutEverywhere: 'Вы вышли везде. Токены API остаются активными.',
            },
        },
    }) } as const;

return { apiTokenSettingsTranslations };
})();

const Domain_artifactsBrowserTranslations = (() => {
type ArtifactsBrowserTranslations = Shared_artifactsBrowserTranslations.ArtifactsBrowserTranslations;

const artifactsBrowserTranslations = { ru: {
        description: 'То, что сохранили вы и ваши агенты, — готово к чтению, повторному использованию и отправке.',
        newDocument: 'Новый документ',
        searchPlaceholder: 'Поиск артефактов',
        kindLabel: 'Тип',
        kinds: {
            all: 'Все типы',
            document: 'Документы',
            prompt: 'Промпты',
            board: 'Доски',
            workflow: 'Рабочие процессы',
            role: 'Роли',
            launchProfile: 'Профили запуска',
        },
        kindOne: {
            document: 'Документ',
            prompt: 'Промпт',
            board: 'Доска',
            workflow: 'Рабочий процесс',
            role: 'Роль',
            launchProfile: 'Профиль запуска',
        },
        sort: {
            label: 'Сортировка',
            updated_desc: 'Недавно изменённые',
            created_desc: 'Недавно созданные',
            title_asc: 'Название',
        },
        view: {
            label: 'Вид',
            grid: 'Сетка',
            list: 'Список',
        },
        provenance: {
            savedByYou: 'Сохранено вами',
            sharedWithYou: 'Доступно вам',
            fromFile: ({ name }) => `Из ${name}`,
            openSession: ({ session }) => `Открыть ${session}`,
        },
        emptyTitle: 'Сохраняйте то, что создают агенты',
        emptyBody: 'Планы, заметки, код и доски, которые сохраняете вы или агенты, появляются здесь — их можно читать на любом устройстве и отправлять командам.',
        emptyHint: 'Или попросите агента «сохрани это как артефакт».',
        loadFailedTitle: 'Не удалось загрузить артефакты',
        loadFailedBody: 'Проверьте подключение и повторите попытку. Ничего не потеряно.',
        quota: {
            accountTitle: 'Хранилище артефактов заполнено',
            documentTitle: 'Слишком большой для сохранения',
            accountBody: ({ used, limit }) => `Использовано ${used} из ${limit} с учётом версий. Удалите или экспортируйте ненужные артефакты, чтобы сохранять новые.`,
            documentBody: ({ size, limit }) => `Получится ${size}; в одном артефакте помещается до ${limit}. Ваши правки сохранены.`,
        },
        open: {
            document: 'Открыть документ',
            prompt: 'Открыть промпт',
            board: 'Открыть доску',
            workflow: 'Открыть процесс',
            role: 'Открыть роль',
            launchProfile: 'Открыть профиль запуска',
        },
        openAsPage: 'Открыть как страницу',
        actions: {
            edit: 'Изменить',
            history: 'История',
            share: 'Поделиться',
            more: 'Другие действия',
            copyLink: 'Скопировать ссылку',
            linkCopied: 'Ссылка скопирована',
        },
        history: {
            title: 'История',
            current: 'Текущая',
            now: 'Сейчас',
            restoreNote: 'Восстановление добавит её как новую версию. Ничего не потеряется.',
            loadFailed: 'Не удалось загрузить историю. Повторите попытку.',
            empty: 'Предыдущих версий пока нет. Каждое сохранение создаёт новую.',
            versionsLabel: 'Версии',
            restoreFailed: 'Не удалось восстановить эту версию. Повторите попытку.',
            savedByUser: 'Сохранено пользователем',
            savedByAgentSession: 'Сохранено сессией агента',
            restoredVersion: ({ n }) => `Восстановлено из версии ${n}`,
            version: ({ n }) => `Версия ${n}`,
            keeps: ({ count }) => `Хранятся последние версии: ${count}.`,
            restore: ({ n }) => `Восстановить версию ${n}`,
        },
        savedToday: ({ count }) => `Сегодня сохранено: ${count}`,
        noMatch: ({ query }) => `Нет артефактов по запросу «${query}»`,
        storage: {
            meter: ({ used, limit }) => `${used} из ${limit}`,
            a11y: ({ used, limit }) => `Хранилище артефактов: использовано ${used} из ${limit}`,
        },
        facts: {
            edited: ({ age }) => `Изменено ${age}`,
        },
    } } satisfies Pick<Record<'en' | 'fr' | 'de' | 'es' | 'it' | 'pt' | 'ca' | 'ru' | 'pl' | 'ja' | 'zh-Hans' | 'zh-Hant', ArtifactsBrowserTranslations>, "ru">;

return { artifactsBrowserTranslations };
})();

const Domain_automationPageTranslations = (() => {
const english = Shared_automationPageTranslations.english;

const translated = Shared_automationPageTranslations.translated;

const slavicPlural = Shared_automationPageTranslations.slavicPlural;

const automationPageTranslations = { ru: translated({
        automationPages: {
            index: {
                description: 'Работа, которая запускается сама: по расписанию, из Event или когда завершается ход сессии.',
            },
            settings: {
                description: 'Сколько работы автоматизаций берёт каждая машина и как долго хранятся завершённые запуски.',
                capacityTitle: 'Нагрузка',
                capacityDescription: 'Действует для каждой машины, которая выполняет автоматизации.',
                historyTitle: 'История запусков',
                historyDescription: 'Завершённые запуски, которые ещё можно открыть из автоматизации.',
            },
            detail: {
                description: 'Сама запускает работу, когда срабатывает любой из её триггеров.',
                triggerCount: ({ count }: { count: number }) => `${count} ${slavicPlural(count, 'триггер', 'триггера', 'триггеров')}`,
                overviewDescription: 'Что она запускает и как её запустить или изменить.',
                runNowSubtitle: 'Запустить сейчас, не дожидаясь триггера.',
                editSubtitle: 'Изменить название, что она запускает, и триггеры.',
                machineAssignmentsDescription: 'Машины, которые могут брать запуски этой автоматизации.',
            },
            run: {
                description: 'Что начало этот запуск, где он выполнялся и что создал.',
                statusTitle: 'Состояние',
                statusDescription: 'На каком этапе этот запуск и что с ним ещё можно сделать.',
                causeTitle: 'Что его начало',
                causeDescription: 'Триггер и событие, которые допустили этот запуск. Позже они не меняются.',
            },
            gate: {
                serverTitle: 'Автоматизации отключены в этом Home',
                serverBody: 'Администраторы этого Home отключили автоматизации. Попросите одного из них включить их снова.',
                openFeatures: 'Открыть настройки функций',
                unknownTitle: 'Сейчас не удаётся проверить автоматизации',
                unknownBody: 'Happier не смог связаться с этим Home, чтобы проверить, включены ли автоматизации. Проверьте снова, когда он снова будет в сети.',
                unsupportedTitle: 'Этот Home пока не поддерживает автоматизации',
                unsupportedBody: 'Его сервер старше, чем автоматизации. Обновите сервер Home, чтобы пользоваться ими.',
                unsupportedContextTitle: 'Автоматизации здесь недоступны',
                unsupportedContextBody: 'Не все просматриваемые Home поддерживают автоматизации.',
            },
            editor: {
                description: 'Назовите её, выберите, что она запускает, и добавьте триггеры, которые её запускают.',
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

const automationTriggerSetTranslations = { ru: {
        pluralEditor: {
            ...expandedLifecycleEnglish,
            lifecycleEvent: {
                ...expandedLifecycleEnglish.lifecycleEvent,
                sessionStarted: 'Когда начинается сессия',
                sessionArchived: 'Когда сессия архивируется',
            },
            triggersTitle: 'Триггеры',
            emptyBody: 'Автоматических триггеров нет. Автоматизацию всё равно можно запустить вручную.',
            orSemantics: 'Добавьте любое количество триггеров. Они работают независимо: автоматизация запускается при совпадении любого из них.',
            enabledSubtitle: 'Приостановить всю автоматизацию, не меняя её триггеры.',
            addTrigger: 'Добавить триггер',
            addTriggerSubtitle: 'Настройте расписание, подключите событие или дождитесь завершения одного выбранного хода.',
            scheduleTitle: 'Расписание',
            eventTitle: 'Событие плагина',
            turnCompletedTitle: 'Когда завершится этот ход',
            turnCompletedSubtitle: 'Запускается один раз после завершения выбранного родительского хода.',
            selectedSession: 'Выбранная сессия',
            turnCompletedSource: ({ session, ordinal }: { session: string; ordinal: number }) => `${session} · одноразовый триггер ${ordinal}`,
            scheduleInterval: ({ minutes, timezone }: { minutes: number; timezone: string | null }) => `Каждые ${minutes} мин${timezone ? ` · ${timezone}` : ''}`,
            scheduleCron: ({ expression, timezone }: { expression: string; timezone: string | null }) => `${expression}${timezone ? ` · ${timezone}` : ''}`,
            eventSubtitle: ({ pluginId, eventId }: { pluginId: string; eventId: string }) => `${pluginId} · ${eventId}`,
            triggerEnabledLabel: ({ title }: { title: string }) => `Включить: ${title}`,
            editScheduleTitle: 'Изменить расписание',
            scheduleType: 'Тип расписания',
            chooseSession: 'Выберите активную сессию',
            eventEditorUnavailable: 'Настройка события недоступна на текущей машине.',
            removeTitle: 'Удалить этот триггер?',
            removeBody: 'Новые события этого триггера больше не будут запускать автоматизацию. История запусков не изменится.',
        },
        exactTurn: {
            eventSearchPlaceholder: 'Поиск событий',
            refreshFailedTitle: 'Не удалось обновить автоматизации',
            refreshFailedBody: 'Список автоматизаций сейчас не удалось прочитать. Повторите попытку, чтобы загрузить текущий список.',
            actionTitle: 'Когда завершится этот ход…',
            createNew: 'Создать новую автоматизацию',
            createNewSubtitle: 'Начните с уже выбранного текущего хода.',
            addToExistingSubtitle: 'Добавьте текущий ход в существующую автоматизацию.',
            searchPlaceholder: 'Поиск автоматизаций',
            eventListA11y: 'Выберите событие жизненного цикла сессии',
            destinationA11y: 'Выберите, куда добавить триггер этого хода',
            staleTitle: 'Ход изменился',
            staleBody: 'Выбранный ход больше не является активным родительским ходом. Обновите данные и явно выберите текущий ход.',
            useCurrentTurn: 'Использовать текущий ход',
            unavailable: 'Сейчас нет активного родительского хода.',
            resolvingRowSubtitle: 'Проверяем, какие автоматизации вам доступны…',
            unavailableRowSubtitle: 'Сведения недоступны — нельзя проверить эту автоматизацию для этой сессии.',
            incompleteNoticeTitle: 'Некоторые автоматизации не удалось прочитать',
        },
    } } as const;

return { automationTriggerSetTranslations };
})();

const Domain_boardsTranslations = (() => {
type Count = Shared_boardsTranslations.Count;

type BoardsTranslations = Shared_boardsTranslations.BoardsTranslations;

const en = Shared_boardsTranslations.en;

const slavicPlural = (count: number, one: string, few: string, many: string): string => {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
};

const ru: BoardsTranslations = {
    title: 'Доски',
    newBoard: 'Новая доска',
    defaultName: 'Доска без названия',
    index: {
        title: 'Ваши доски',
        body: 'Доска держит сессии, запуски, воркфлоу и машины в живом виде в одном месте, расположенные так, как удобно вам.',
    },
    notFound: {
        title: 'Этой доски больше нет',
        body: 'Её удалили, или она принадлежит Home, который здесь не подключён.',
    },
    meta: {
        needYou: ({ count }) => `Ждут вас: ${count}`,
        items: ({ count }) => `${count} ${slavicPlural(count, 'элемент', 'элемента', 'элементов')}`,
        handPicked: 'Выбрано вручную',
        empty: 'Пусто',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: 'Ждут вас', description: 'Всё, что ждёт вас' },
        running: { title: 'Выполняется сейчас', description: 'Запуски воркфлоу в процессе' },
        my_machines: { title: 'Мои машины', description: 'Доступность и что запущено на каждой' },
        filter: { title: 'Сессии', description: 'Все активные сессии' },
    },
    header: {
        layoutA11y: 'Вид доски',
        canvas: 'Холст',
        byStatus: 'По статусу',
        add: 'Добавить на доску',
        settings: 'Настройки доски',
    },
    kinds: {
        session: 'Сессия',
        workflow_run: 'Запуск воркфлоу',
        workflow: 'Воркфлоу',
        machine: 'Машина',
    },
    card: {
        untitled: 'Недоступный элемент',
        unavailable: 'Недоступно',
        unavailableBody: 'Его Home не подключён на этом устройстве. Элемент остаётся на доске.',
        notLoaded: 'Ещё не загружено',
        remove: 'Убрать с доски',
        moveHint: 'Стрелки перемещают эту карточку по сетке.',
        moved: ({ x, y }) => `Перемещено в ${x}, ${y}`,
        moveActions: { up: 'Переместить вверх', down: 'Переместить вниз', left: 'Переместить влево', right: 'Переместить вправо' },
        machine: {
            online: 'В сети',
            offline: 'Не в сети',
            running: ({ count }) => `${slavicPlural(count, 'Выполняется', 'Выполняются', 'Выполняется')} ${count} ${slavicPlural(count, 'сессия', 'сессии', 'сессий')}`,
            needYou: ({ count }) => `Ждут вас: ${count}`,
            idle: 'Нет запущенных сессий',
            offlineBody: 'Её сессии подождут, пока она вернётся.',
        },
        workflow: {
            noRuns: 'Запусков пока нет',
            lastRun: ({ word, age }) => `Последний запуск ${age} · ${word}`,
            needYou: ({ count }) => `Ждут вас: ${count}`,
        },
        run: {
            waitingForYou: 'Ждёт вашей проверки',
            started: ({ age }) => `Запущен ${age}`,
        },
    },
    canvas: {
        snapsHere: 'Привязывается сюда',
        snapOnceHint: 'Удерживайте ⇧, чтобы один раз привязать к сетке',
    },
    settings: {
        title: 'Настройки доски',
        name: 'Название',
        whatsOn: 'Что на этой доске',
        whichSessions: 'Какие сессии',
        addedByHand: 'Добавлено вручную',
        addedByHandNone: 'Пока ничего',
        add: 'Добавить',
        layout: 'Вид',
        layoutDescription: 'Холст сохраняет вашу расстановку при переключении.',
        snap: 'Привязка к сетке',
        pin: 'Показывать в списке сессий',
        pinDescription: 'Закрепляет эту доску над вашими сессиями.',
        delete: 'Удалить доску',
        deleteConfirmTitle: 'Удалить эту доску?',
        deleteConfirmBody: 'Исчезнет только доска. Её сессии, запуски, воркфлоу и машины останутся как есть.',
    },
    add: {
        title: 'Добавить на доску',
        search: 'Искать элементы',
        groups: { sessions: 'Сессии', workflows: 'Воркфлоу', runs: 'Запуски воркфлоу', machines: 'Машины' },
        onBoard: 'На этой доске',
        addHint: 'Добавить',
        addAndPlaceHint: 'Добавить и разместить',
        empty: 'Ничего не найдено.',
    },
    empty: {
        title: 'Выберите, что покажет эта доска',
        body: 'Добавьте сессии, воркфлоу, запуски или машины вручную либо покажите раздел, например «Ждут вас». Вы их расставляете, а доска держит их в живом виде.',
        action: 'Добавить на доску',
    },
    widgets: {
        group: 'Виджеты',
        kind: 'Виджет',
        gallery: 'Открыть галерею',
        galleryHint: 'Все виджеты с живым предпросмотром',
        addHint: 'Ваши доски видите только вы',
        widthOne: 'Одна карточка',
        widthTwo: 'Две карточки',
        moveEarlier: 'Переместить раньше',
        moveLater: 'Переместить позже',
        remove: 'Убрать с доски',
        menuA11y: ({ widget }) => `Параметры: ${widget}`,
        arrived: ({ count }) => `Только что добавлено: ${count} ${slavicPlural(count, 'виджет', 'виджета', 'виджетов')}`,
        undo: 'Отменить',
        dismiss: 'Скрыть',
    },
    saveFailed: {
        tooLarge: 'Эта доска превышает лимит хранилища досок. Уберите несколько элементов и попробуйте снова.',
        notFound: 'Эта доска была удалена на другом устройстве.',
        generic: 'Ваше изменение не дошло до аккаунта, поэтому доска осталась прежней.',
        retry: 'Повторить',
        dismiss: 'Закрыть',
        createTitle: 'Эта доска не создана',
    },
};

const boardsTranslations = { ru };

return { boardsTranslations };
})();

const Domain_browserPresenceTranslations = (() => {
type AgentParams = Shared_browserPresenceTranslations.AgentParams;

type BrowserPresenceTranslations = Shared_browserPresenceTranslations.BrowserPresenceTranslations;

const browserPresenceTranslations = { ru: {
        agentFallbackName: 'Агент',
        agentBrowsing: ({ agent }) => `${agent} работает в браузере`,
        clickTarget: ({ target }) => `Нажимает «${target}»`,
        doing: {
            click: 'Нажимает на странице',
            type: 'Вводит текст',
            fill: 'Заполняет поле',
            scroll: 'Прокручивает',
            navigate: 'Открывает страницу',
            history: 'Переходит по истории',
            reload: 'Перезагружает страницу',
            press: 'Нажимает клавишу',
            select: 'Выбирает вариант',
            drag: 'Перетаскивает',
            upload: 'Загружает файл',
            look: 'Смотрит на страницу',
            other: 'Работает на странице',
        },
        takeControl: 'Взять управление',
        stopping: ({ agent }) => `Останавливаем ${agent}…`,
        stoppingDetail: 'Завершает последнее действие',
        lastActionMayHaveLanded: ({ agent }) => `Последнее действие (${agent}), возможно, выполнено`,
        youHaveControl: 'Управление у вас',
        stopUnconfirmed: 'Не удалось подтвердить остановку',
        checkAgain: 'Проверить снова',
        pausedUntilHandBack: ({ agent }) => `${agent} ждёт, пока вы вернёте управление`,
        handBack: 'Вернуть',
        stream: {
            connectingTitle: ({ agent }) => `Подключение к браузеру ${agent}`,
            connectingBody: ({ machine }) => `Он работает на ${machine}. Страница появится здесь, как только придёт первый кадр.`,
            stalled: 'Последний кадр · переподключение',
            endedTitle: ({ agent }) => `${agent} закрыл этот браузер`,
            endedBody: 'Страница здесь больше не показывается.',
            unavailableTitle: ({ agent }) => `Браузер ${agent} нельзя показать здесь`,
            unavailableBody: ({ agent }) => `${agent} продолжает работу; его действия по-прежнему видны в чате.`,
            tryAgain: 'Повторить',
            inputA11y: 'Страница. Нажмите, прокрутите или печатайте, чтобы взять управление.',
        },
        recording: {
            elapsedA11y: ({ elapsed }) => `Запись, ${elapsed}`,
            discard: 'Удалить запись',
        },
        openInYourBrowser: 'Открыть в браузере',
        slowPage: 'Страница загружается дольше обычного',
    } } satisfies Pick<Record<string, BrowserPresenceTranslations>, "ru">;

return { browserPresenceTranslations };
})();

const Domain_browserToolTranslations = (() => {
type TargetParams = Shared_browserToolTranslations.TargetParams;

type BrowserToolTranslations = Shared_browserToolTranslations.BrowserToolTranslations;

const browserToolTranslations = { ru: {
        opened: ({ page }) => `Открыл ${page}`,
        openedPage: 'Открыл страницу',
        reloaded: 'Перезагрузил страницу',
        wentBack: 'Вернулся назад',
        wentForward: 'Перешёл вперёд',
        clicked: ({ target }) => `Нажал «${target}»`,
        clickedPage: 'Нажал на странице',
        typedInto: ({ target }) => `Ввёл текст в «${target}»`,
        typed: 'Ввёл текст на странице',
        filledIn: ({ target }) => `Заполнил «${target}»`,
        filled: 'Заполнил поле',
        pressed: ({ key }) => `Нажал ${key}`,
        pressedKey: 'Нажал клавишу',
        scrolled: 'Прокрутил страницу',
        pointedAt: ({ target }) => `Навёл на «${target}»`,
        pointed: 'Навёл курсор на страницу',
        choseIn: ({ target }) => `Выбрал вариант в «${target}»`,
        chose: 'Выбрал вариант',
        uploadedTo: ({ target }) => `Загрузил файл в «${target}»`,
        uploaded: 'Загрузил файл',
        dragged: ({ target }) => `Перетащил «${target}»`,
        draggedPage: 'Перетащил на странице',
        looked: 'Посмотрел на страницу',
        screenshot: 'Сделал снимок экрана',
        recordingStarted: 'Начал запись страницы',
        recordingStopped: 'Остановил запись',
        other: 'Использовал браузер',
        watch: 'Смотреть',
        watchA11y: 'Открыть эту страницу в браузере',
    } } satisfies Pick<Record<string, BrowserToolTranslations>, "ru">;

return { browserToolTranslations };
})();

const Domain_changedFileEvidenceTranslations = (() => {
type ChangedFileEvidenceTranslations = Shared_changedFileEvidenceTranslations.ChangedFileEvidenceTranslations;

const en = Shared_changedFileEvidenceTranslations.en;

const translated = Shared_changedFileEvidenceTranslations.translated;

const changedFileEvidenceTranslations = { ru: {
        changedFileEvidence: translated({
            before: 'До',
            after: 'После',
            binary: 'Двоичный файл',
            truncated: 'Содержимое подтверждения было ограничено; исходный размер и статистика изменений сохраняются, когда доступны.',
            truncatedOldBytes: ({ count }) => `Исходное содержимое до: ${count} байт`,
            truncatedNewBytes: ({ count }) => `Исходное содержимое после: ${count} байт`,
            truncatedDiffBytes: ({ count }) => `Исходное различие: ${count} байт`,
            truncatedAddedLines: ({ count }) => `Добавленные строки: ${count}`,
            truncatedRemovedLines: ({ count }) => `Удалённые строки: ${count}`,
            kind: {
                added: 'Добавлено',
                modified: 'Изменено',
                deleted: 'Удалено',
                renamed: 'Переименовано',
                copied: 'Скопировано',
                unknown: 'Тип изменения недоступен',
            },
            howDetermined: 'Как это определено',
            howDeterminedForFile: ({ path }) => `Как был определён ${path}`,
            content: {
                exact: 'Точное изменение в репозитории',
                strong: 'Надёжное подтверждение содержимого',
                best_effort: 'Приблизительное подтверждение содержимого',
            },
            attribution: {
                session_exact: 'Связано с этой сессией',
                session_likely: 'Вероятно, изменено этой сессией',
                session_possible: 'Возможно, изменено этой сессией',
                unknown: 'Атрибуция сессии недоступна',
            },
            reason: {
                provider_correlated: 'Агент сообщил об этом изменении для этого хода.',
                canonical_tool_correlated: 'Инструмент различий или патчей связал это изменение с этим ходом.',
                checkpoint_no_happier_overlap_observed: 'Контрольная точка не зафиксировала пересекающийся ход Happier в этом процессе.',
                checkpoint_overlap_observed: 'Другой ход Happier пересёкся с интервалом снятия контрольной точки.',
                workspace_touched_path: 'Этот путь был затронут в рабочем пространстве; это не указывает сессию, которая его изменила.',
                unavailable: 'Подтверждения не устанавливают, какая сессия сделала это изменение.',
            },
            overlap: {
                observed: 'Другой ход Happier пересёкся с этой рабочей копией во время снятия. Наблюдения охватывают только этот процесс; другие процессы и внешние записи не отслеживаются.',
                not_observed: 'В этом процессе пересекающийся ход Happier не наблюдался. Другие процессы и внешние записи не отслеживаются; это не подтверждает единоличное авторство.',
                unknown: 'Пересечение контрольной точки неизвестно. Другие процессы и внешние записи не отслеживаются.',
            },
            sources: {
                provider_native: 'Собственный отчёт агента об изменениях',
                provider_tool: 'Отчёт инструмента агента',
                canonical_diff_tool: 'Подтверждение от инструмента различий',
                canonical_patch_tool: 'Подтверждение от инструмента патчей',
                scm_checkpoint: 'Контрольная точка репозитория',
                scm_reconciled: 'Согласованный снимок репозитория',
                inferred: 'Затронутый путь в рабочем пространстве',
            },
        }),
    } } as const;

return { changedFileEvidenceTranslations };
})();

const Domain_cliPathExposureTranslations = (() => {
const en = Shared_cliPathExposureTranslations.en;

const ru = {
    title: 'Командная строка',
    footer: 'Happier Desktop добавляет и удаляет только те записи PATH, которые создал сам. Записи, добавленные установщиком оболочки, остаются нетронутыми.',
    addTitle: 'Добавить happier в PATH',
    addSubtitle: 'Сделайте команду happier доступной в новых терминалах.',
    removeTitle: 'Удалить happier из PATH',
    removeSubtitle: 'Удаляет только записи PATH, добавленные Happier Desktop.',
    working: 'Обновляем профиль оболочки…',
    added: 'Добавлено. Откройте новый терминал, чтобы использовать happier.',
    alreadyPresent: 'happier уже есть в вашем PATH.',
    removed: 'Записи PATH, добавленные Happier Desktop, удалены.',
    nothingToRemove: 'Happier Desktop не добавлял записей в PATH.',
};

const cliPathExposureTranslations = { ru: ru };

return { cliPathExposureTranslations };
})();

const Domain_cliTrustPromptTranslations = (() => {
const en = Shared_cliTrustPromptTranslations.en;

const ru = {
    title: 'Разрешить эту командную строку?',
    body: ({ command }: { command: string }) => `Happier не устанавливал командную строку в ${command}. Разрешение даст ей доступ на чтение и запись сессий этой учётной записи. Разрешайте только ту, что поместили туда сами.`,
    bodyUnknownCommand: 'Happier не устанавливал эту командную строку. Разрешение даст ей доступ на чтение и запись сессий этой учётной записи. Разрешайте только ту, что поместили туда сами.',
    approve: 'Разрешить',
};

const cliTrustPromptTranslations = { ru: ru };

return { cliTrustPromptTranslations };
})();

const Domain_commitProposalTranslations = (() => {
type Count = Shared_commitProposalTranslations.Count;

type CommitProposalCopy = Shared_commitProposalTranslations.CommitProposalCopy;

const en = Shared_commitProposalTranslations.en;

const commitProposalTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', { commitProposal: CommitProposalCopy }>>, "ru"> = { ru: { commitProposal: {
        title: ({ count }) => (count === 1 ? 'Один коммит для ожидающих изменений' : `Коммитов для ожидающих изменений: ${count}`),
        titlePhone: ({ count }) => (count === 1 ? 'Один коммит' : `Коммитов: ${count}`),
        proposedBy: ({ who, committed, total }) => `Предложил ${who} · ${committed} из ${total} файлов · по порядку, чтобы каждый коммит опирался на предыдущий.`,
        proposedByPhone: ({ committed, total }) => `${committed} из ${total} ожидающих файлов · нажмите на изменение, чтобы переместить его.`,
        moveHint: ({ max }) => `Перемещайте изменения сочетаниями ⌥1–${max} или через меню.`,
        modelFallback: 'модель',
        regenerate: 'Создать заново',
        conflict: 'Предложение изменилось в другом месте. Показана последняя версия; внесите изменение ещё раз.',
        approvalPending: 'Ожидается подтверждение на создание этих коммитов.',
        discardBody: 'Предложение будет удалено. Ожидающие изменения останутся как есть.', askFix: ({ hook, number, message }) => `Хук ${hook} остановил коммит ${number}, «${message}». Исправь то, о чём он сообщает, чтобы коммит прошёл:`, askFixGeneric: ({ number, message }) => `Хук остановил коммит ${number}, «${message}». Исправь то, о чём он сообщает, чтобы коммит прошёл:`, discarded: 'Предложение отменено.', undo: 'Отменить',
        fileCount: ({ count }) => `Файлов: ${count}`,
        part: ({ count, of }) => `${count} из ${of} изменений`,
        move: { a11y: ({ file }) => `Переместить ${file} в другой коммит`, title: ({ file }) => `Переместить ${file} в`, newCommitAfter: ({ number }) => `Новый коммит после ${number}`, newCommitMessage: ({ file }) => `Обновить ${file}`, leaveOut: 'Не включать в эти коммиты', leaveOutHint: 'Останется в рабочем дереве' },
        group: { a11y: ({ number, message }) => `Коммит ${number}: ${message}`, editMessage: 'Изменить сообщение', messageA11y: ({ number }) => `Сообщение коммита ${number}`, more: 'Ещё', moveUp: 'Выше', moveDown: 'Ниже', mergeWithNext: 'Объединить со следующим коммитом', empty: 'Пока нет изменений. Переместите сюда одно или объедините со следующим.' },
        leftOut: { title: 'Не включено · останется в рабочем дереве', description: 'Эти изменения останутся ожидающими. Закоммитьте их отдельно, если это было задумано.' },
        footer: { commits: ({ count }) => `Коммитов: ${count}`, onBranch: ({ branch }) => ` в ${branch} · хуки и подпись работают как для любого коммита`, detached: ' на отсоединённом HEAD · хуки и подпись работают как для любого коммита', phone: 'Хуки и подпись как обычно', discard: 'Отменить предложение', create: ({ count }) => (count === 1 ? 'Создать 1 коммит' : `Создать коммиты: ${count}`), createShort: ({ count }) => `Создать ${count}`, emptyGroupReason: 'В одном коммите нет изменений. Переместите туда изменение или объедините его.' },
        applying: { title: ({ count }) => `Создание коммитов: ${count}`, body: 'По одному обычным путём коммита, поэтому хуки и подпись работают как обычно. Редактирование приостановлено до завершения.', bodyPhone: 'Редактирование приостановлено до завершения.', created: ({ landed, total }) => `${landed} из ${total}`, createdRest: ' создано · ничего не откатывается, если следующий остановится', createdRestPhone: ' создано', stopAfterThis: 'Остановиться после этого коммита', stopAfterThisShort: 'Остановиться после', stopping: 'Остановится после этого коммита' },
        state: { waiting: 'Ожидает', writing: 'Выполняются хуки, создаётся коммит', landed: 'закоммичено', landedAt: ({ time }) => `закоммичено в ${time}`, signed: 'подписано', pausedBy: ({ hook, count }) => `${hook} изменил файлов: ${count} · ещё не закоммичено`, hookFailedBy: ({ hook }) => `${hook} не прошёл · без коммита`, rewritten: 'хук переписал сообщение', notCreated: 'Не создан · можно редактировать', notCreatedShort: 'Не создан', unknown: 'Ещё не подтверждено', paused: ({ count }) => `Хук изменил файлов: ${count} · ещё не закоммичено`, failed: 'Остановлено здесь · без коммита' },
        outcome: { signingTitle: 'Сейчас ваши коммиты нельзя подписать.', signingBody: 'Этот репозиторий подписывает каждый коммит. Ничего не закоммичено.', signingHint: 'Сначала разблокируйте агент GPG или SSH', tryAgain: 'Повторить', cancel: 'Отмена', hookChanged: ({ files }) => `Хук изменил ${files}.`, waitsAfterLanded: ({ count }) => (count === 1 ? 'Коммит 1 создан; этот ждёт вас.' : `Создано коммитов: ${count}; этот ждёт вас.`), waits: 'Этот ждёт вас.', include: 'Включить изменения хука', includePhone: 'Включить и закоммитить', cancelCommit: 'Отменить этот коммит', hookFailed: 'Хук остановил этот коммит.', hookChangedBy: ({ hook, files }) => `${hook} изменил ${files}.`, hookFailedBy: ({ hook }) => `${hook} остановил этот коммит.`, hookFailedBody: 'Предыдущие коммиты остаются. Остальное можно редактировать.', headMoved: ({ branch }) => `${branch} сдвинулась во время коммитов.`, headMovedBody: 'Следующий коммит отклонён, ничего не откатано.', proposeAgain: 'Предложить заново оставшееся', keepEditing: 'Продолжить редактирование', askSessionToFix: 'Попросить эту сессию исправить', showInGit: 'Показать в Git', unknownTitle: 'Не удалось подтвердить, создан ли этот коммит.', unknownBody: 'Ничего не повторяется, пока это неизвестно. Проверьте ветку ещё раз.', checkAgain: 'Проверить ещё раз', stoppedTitle: ({ landed, total }) => `Создано ${landed} из ${total} коммитов`, stoppedBody: ({ count }) => (count === 1 ? 'Последний не создан. Его изменения остаются в рабочем дереве, как и раньше.' : `Не создано: ${count}. Их изменения остаются в рабочем дереве, как и раньше.`), createRest: ({ count }) => (count === 1 ? 'Создать последний' : `Создать оставшиеся: ${count}`), completeTitle: ({ count }) => `Создано коммитов: ${count}`, completeBody: 'Ничего не отправлено.', onBranch: ({ branch }) => `в ${branch}`, failed: { staging_conflict: 'Что-то ещё изменило подготовленные изменения.', selection_conflict: 'Эти изменения нельзя так разделить.', source_changed: 'Ожидающие изменения поменялись после предложения.', writer_failed: 'Не удалось создать коммит.', publication_warning: 'Коммит создан, но подготовленные файлы не обновлены.', cancelled: 'Этот коммит отменён.' }, failedBody: 'Предыдущие коммиты остаются. Ничего не откатано.' },
        none: { title: 'Предложения коммитов пока нет', reason: 'Предложение группирует ожидающие изменения в коммиты, которые можно отредактировать, а затем создаёт их по одному обычным путём коммита.', propose: 'Предложить коммиты', writing: 'Группируем ожидающие изменения…' },
        gitPane: { title: 'Предложенные коммиты', meta: ({ count, files }) => `${count} · файлов: ${files}`, inCommit: ({ count, number }) => `${count} в коммите ${number}`, open: 'Открыть', review: 'Просмотреть', reviewInWalkthrough: 'Просмотреть в разборе', more: 'Отменить или создать заново', selectedHint: 'Выбрано. Нажмите ещё раз, чтобы открыть в Коммитах', tapHint: 'Нажмите, чтобы показать изменения' },
    } } };

return { commitProposalTranslations };
})();

const Domain_committedMessageActionTranslations = (() => {
const committedMessageActionTranslations = { "ru": {
        "committedMessageActions": {
            "copy": "Копировать",
            "fork": "Создать ветку",
            "rollback": "Откатить",
            "pin": "Закрепить",
            "savePrompt": "Сохранить как промпт",
            "plugins": "Действия плагинов",
            "composerButton": "Кнопка библиотеки промптов",
            "composerHint": "Ваши промпты и отправленное, рядом с диктовкой. Если выключено, меню / по-прежнему предлагает «Промпты…».",
            "name": "Название",
            "shortcut": "/ сокращение",
            "savedOpen": "Сохранено в библиотеке · Открыть",
            "shortcutNotSaved": "Промпт сохранён, но сокращение сохранить не удалось. Откройте его в библиотеке, чтобы добавить сокращение.",
            "wrongAccount": "Переключитесь на Home этой сессии перед сохранением её промпта.",
            "savedHintFavorite": "Попадёт в библиотеку, со звёздочкой.",
            "savedHint": "Попадёт в библиотеку.",
            "addShortcut": "Добавить ярлык /",
            "shortcutPlaceholder": "/yarlyk",
            "savedToLibrary": "Сохранено в библиотеке",
            "savePromptHint": "Используйте снова из библиотеки промптов",
            "copyHint": "Скопировать текст сообщения.",
            "forkHint": "Начать новую сессию с сообщения.",
            "rollbackHint": "Вернуть рабочее пространство к состоянию до сообщения.",
            "pinHint": "Закрепляйте сообщения, чтобы к ним вернуться. Закреплённые остаются закреплёнными.",
            "savePromptSettingHint": "Сохранить отправленное сообщение как промпт в библиотеке.",
            "pluginsHint": "Действия, которые плагины добавляют под сообщениями."
        }
    } };

return { committedMessageActionTranslations };
})();

const Domain_computerUseTranslations = (() => {
type MachineParams = Shared_computerUseTranslations.MachineParams;

type ComputerUseTranslations = Shared_computerUseTranslations.ComputerUseTranslations;

const computerUseTranslations = { ru: {
        approval: {
            sectionTitle: 'На компьютере',
            act: {
                list: 'Узнать, какие окна открыты',
                see: 'Сделать снимок экрана',
                read: 'Прочитать текст и элементы управления',
                click: 'Нажать',
                press: 'Нажать клавишу',
                type: 'Ввести текст',
                share: 'Открыть доступ к окну',
            },
            windowOn: ({ machine }) => `Окно на ${machine}`,
            screenOf: ({ machine }) => `Весь экран ${machine}`,
            windowsOn: ({ machine }) => `Открытые окна на ${machine}`,
            window: 'Окно',
            screen: 'Весь экран',
            windows: 'Открытые окна',
            typedLabel: 'Текст',
            keyLabel: 'Клавиша',
            listConsequence: 'Передаются только названия открытых окон, а не их содержимое.',
            seeConsequence: 'Снимки экрана передаются в этот сеанс. Без нажатий и ввода текста.',
            useConsequence: 'Ввод, дошедший до компьютера, нельзя отменить. Остановить можно в любой момент.',
            targetOn: ({ machine, target }) => `${target} на ${machine}`,
            chooseFirst: 'Сначала выберите окно',
            cropA11y: ({ target }) => `Последнее изображение: ${target}`,
            suggestsWindow: ({ agent, target }) => `${agent} предлагает «${target}»`,
        },
        request: {
            title: ({ agent, machine }) => `${agent} хочет использовать окно на ${machine}`,
            body: 'Окно выбираете вы. Пока вы не выберете, ничего не передаётся.',
            choose: 'Выбрать окно',
            change: 'Сменить окно',
            shared: ({ target }) => `Окно ${target} передано`,
            watch: 'Смотреть',
        },
        picker: {
            title: ({ agent }) => `Разрешить ${agent} использовать окно`,
            description: ({ agent }) => `Вы выбираете, чем поделиться с ${agent}.`,
            windows: 'Окна',
            screens: 'Весь экран',
            untitledWindow: 'Окно без названия',
            screenLabel: ({ index }) => `Экран ${index}`,
            share: 'Открыть доступ к окну',
            shareScreen: 'Открыть доступ к экрану',
            shareApp: ({ app }) => `Поделиться окном ${app}`,
            stopSharing: 'Закрыть доступ',
            loadingTitle: ({ machine }) => `Ищем окна на ${machine}`,
            noScreenTitle: ({ machine }) => `У ${machine} нет экрана для общего доступа`,
            noScreenBody: 'Он работает без рабочего стола, который видит Happier. Используйте машину с экраном.',
            unsupportedTitle: ({ machine }) => `Happier пока не может использовать экран ${machine}`,
            unsupportedBody: 'Пока доступ к окну работает на рабочих столах Linux.',
            failedTitle: ({ machine }) => `Не удалось получить список окон на ${machine}`,
            failedBody: 'Проверьте, что там запущен Happier, и попробуйте снова.',
            emptyTitle: ({ machine }) => `На ${machine} нет открытых окон`,
            emptyBody: 'Откройте нужное окно и проверьте снова.',
            tryAgain: 'Попробовать снова',
            inUse: 'Это окно использует другая сессия. Выберите другое.',
            closed: 'Это окно закрыто. Выберите другое.',
            selectFailed: 'Не удалось открыть доступ к окну. Попробуйте снова.',
            otherMachineTitle: ({ machine }) => `${machine} — не машина этой сессии`,
            otherMachineBody: 'Окна можно открыть только на машине, где работает эта сессия.',
            purpose: ({ session }) => `Для «${session}».`,
            purposeIn: ({ project, session }) => `Для «${session}» в ${project}.`,
            access: ({ agent }) => `${agent} может`,
            accessValue: 'Видеть и использовать',
            accessSee: 'Только смотреть',
            displayUnavailable: 'На этом компьютере нельзя предоставить доступ ко всему экрану.',
            policyBoth: ({ agent }) => `${agent} спрашивает перед каждым снимком, нажатием и вводом.`,
            policyInput: ({ agent }) => `${agent} спрашивает перед каждым нажатием и вводом.`,
            policyCapture: ({ agent }) => `${agent} спрашивает перед каждым снимком.`,
            policyNone: ({ agent }) => `${agent} не спрашивает перед снимками, нажатиями и вводом.`,
            policyChange: 'Изменить',
            suggests: ({ agent }) => `${agent} предлагает`,
        },
        permission: {
            title: ({ machine }) => `Сначала ${machine} нужно ваше разрешение`,
            body: 'Happier сможет видеть и использовать окна только после того, как вы разрешите это в Системных настройках на том компьютере.',
            capture: 'Запись экрана',
            captureHint: 'Чтобы видеть окна',
            input: 'Универсальный доступ',
            inputHint: 'Чтобы нажимать и печатать',
            allowed: 'Разрешено',
            denied: 'Не разрешено',
            unknown: 'Не проверено',
            open: ({ machine }) => `Открыть Системные настройки на ${machine}`,
            opened: ({ machine }) => `Открыто на ${machine}. Разрешите там Happier и проверьте снова.`,
            openFailed: 'Не удалось открыть Системные настройки там. Откройте их на том компьютере.',
            checkAgain: 'Проверить снова',
        },
        viewer: {
            agentUsing: ({ agent, target }) => `${agent} использует ${target}`,
            agentCanUse: ({ agent, target }) => `${agent} может использовать ${target}`,
            agentCanSee: ({ agent, target }) => `${agent} может видеть ${target}`,
            onMachine: ({ machine }) => `На ${machine}`,
            connectingTitle: ({ target }) => `Подключаемся к ${target}`,
            connectingBody: ({ machine }) => `Окно появится здесь, как только придёт первое изображение с ${machine}.`,
            unavailableTitle: 'Сейчас это окно не показать',
            unavailableBody: ({ agent }) => `Вы всё равно можете остановить ${agent} здесь.`,
            endedTitle: ({ target }) => `${target} закрыто`,
            endedBody: ({ agent }) => `${agent} больше не видит и не использует его. Выберите другое окно, чтобы продолжить.`,
            stalled: 'Последнее изображение · переподключение',
            inputA11y: ({ target }) => `${target}, в реальном времени. Нажмите или печатайте, чтобы взять управление.`,
            notSharedTitle: 'Нет общего окна',
            notSharedBody: ({ agent }) => `Выберите окно для ${agent}.`,
            moreA11y: 'Параметры окна',
            tabFallback: 'Компьютер',
        },
        strip: {
            using: ({ target }) => `Использует ${target}`,
            on: ({ machine }) => `на ${machine}`,
            stop: 'Остановить',
            paused: ({ agent }) => `${agent} на паузе`,
            pausedDetail: ({ target }) => `Вы управляете ${target}`,
        },
        tool: {
            capture: 'Сделал снимок экрана',
            captureRunning: 'Делает снимок экрана',
            query: 'Прочитал текст и элементы окна',
            queryRunning: 'Читает окно',
            click: 'Нажал в окне',
            clickRunning: 'Нажимает в окне',
            clickTarget: ({ target }) => `Нажал «${target}»`,
            type: 'Ввёл текст в окне',
            typeRunning: 'Вводит текст в окне',
            typeTarget: ({ target }) => `Ввёл текст в «${target}»`,
            pressKey: ({ key }) => `Нажал ${key}`,
            press: 'Нажал клавишу',
            pressRunning: 'Нажимает клавишу',
            mayHaveLanded: 'возможно, сработало',
            failed: 'Не выполнено',
        },
    } } satisfies Pick<Record<string, ComputerUseTranslations>, "ru">;

return { computerUseTranslations };
})();

const Domain_connectedServicesCollectionTranslations = (() => {
type ConnectedServicesCollectionCopy = Shared_connectedServicesCollectionTranslations.ConnectedServicesCollectionCopy;

const en = Shared_connectedServicesCollectionTranslations.en;

const ru: ConnectedServicesCollectionCopy = {
    accountLabel: ({ service }) => `Аккаунт ${service}`,
    meterResetsIn: ({ time }) => `через ${time}`,
    meterNextResetIn: ({ time }) => `следующий через ${time}`,
    meterResetsAt: ({ countdown, time }) => `${countdown} · ${time}`,
    meterNotReported: 'Нет данных',
    meterEstimated: ({ value }) => `~${value}`,
    indexTitle: 'Все сервисы',
    indexDescription: 'Аккаунты, через которые входят ваши агенты, и сколько у каждого осталось.',
    viewList: 'Список',
    viewGrid: 'Сетка',
    viewLabel: 'Показывать аккаунты',
    refreshAll: 'Обновить всё',
    refreshUsage: 'Обновить использование',
    signedOutConsequence: 'Сессии не смогут его использовать, пока вы не войдёте снова.',
    poolsGroup: 'Пулы',
    poolsDescription: 'Аккаунты, между которыми переключается агент. Пул выбирает один при старте сессии и переходит к следующему, когда тот исчерпан.',
    newPool: 'Новый пул',
    poolUsing: ({ account }) => `Использует ${account}`,
    poolPosition: ({ position, count }) => position === 1 ? `Первый из ${count}` : `${position} из ${count}`,
    poolInUseNow: 'используется сейчас',
    inUse: 'Используется',
    connectService: 'Подключить сервис',
    searchAccounts: 'Поиск аккаунтов',
    servicesGroup: 'Сервисы',
    railEmpty: 'Пока нет аккаунтов',
    railKey: 'ключ',
    railAccountLabel: ({ service, account }) => `${service} · ${account}`,
    agentSignInTitle: 'Как входят агенты',
    subscriptionTitle: 'Подписка',
    subscriptionNone: 'Нет подписки',
    subscriptionRenewsIn: ({ days }) => days === 0 ? 'Продлится сегодня' : `Продлится через ${days} дн.`,
    subscriptionEndsIn: ({ days }) => days === 0 ? 'Без продления · закончится сегодня' : `Без продления · закончится через ${days} дн.`,
    subscriptionPeriodEndsIn: ({ days }) => days === 0 ? 'Период закончится сегодня' : `Период закончится через ${days} дн.`,
    subscriptionRenewsOn: ({ date, days }) => `Продлится ${date} · через ${days} дн.`,
    subscriptionEndsOn: ({ date, days }) => `Без продления · закончится ${date}, через ${days} дн. После этого сессии перестанут его использовать.`,
    subscriptionPeriodEndsOn: ({ date, days }) => `Период закончится ${date} · через ${days} дн.`,
    renewalOn: 'Вкл.',
    renewalOff: 'Выкл.',
    renewalUnknown: 'Неизвестно',
    checkedAt: ({ time }) => `Проверено ${time}`,
    checkedMayBeOutOfDate: ({ time }) => `Проверено ${time} · может быть устаревшим`,
    usageCheckedMayBeOutOfDate: ({ time }) => `Проверено ${time} · может быть устаревшим`,
    daysAgo: ({ count }) => `${count} дн. назад`,
    hoursAgo: ({ count }) => `${count} ч назад`,
    usageResetsCount: ({ count }) => `Сбросов лимита: ${count}`,
    usageResetsFirstExpires: ({ date }) => `первый истекает ${date}`,
    usageResetExpires: ({ date }) => `истекает ${date}`,
    useOne: 'Использовать',
    useOneReset: 'Использовать сброс лимита',
    usageResetsTitle: 'Сбросы лимита',
    usageResetsDescription: 'Каждый сразу начинает новое окно. Приберегите их на случай, когда упрётесь в лимит; неиспользованные сгорают.',
    usageResetTitle: 'Сброс лимита',
    usageResetExpiresOn: ({ date }) => `Истекает ${date}`,
    use: 'Использовать',
    usedByDefault: 'По умолчанию · новые сессии используют этот аккаунт',
    accountIdFact: ({ id }) => `ID ${id}`,
    hideIdentitiesTitle: 'Скрывать почту и ID аккаунтов',
    hideIdentitiesDescription: 'Для трансляций и демонстраций. Скрывает почту и ID аккаунтов повсюду на этом устройстве; имена, которые вы дали аккаунтам, остаются.',
    privacyTitle: 'Конфиденциальность',
    renameTitle: 'Назовите этот аккаунт',
    renameBody: ({ service }) => `Меняется только имя в Happier. ${service} сохраняет собственное имя аккаунта.`,
    identityHidden: 'Почта или ID скрыты',
};

const connectedServicesCollectionTranslations = { ru };

return { connectedServicesCollectionTranslations };
})();

const Domain_connectedServicesPoolTranslations = (() => {
type ConnectedServicesPoolCopy = Shared_connectedServicesPoolTranslations.ConnectedServicesPoolCopy;

const en = Shared_connectedServicesPoolTranslations.en;

const ru: ConnectedServicesPoolCopy = {
    strategyExpiryFirst: "Скорее истекает",
    strategyExpiryFirstDescription: "Предпочитать достаточный запас с более ранним сбросом длительного лимита или окончанием подписки без продления.",
    leadExpiryFirst: "Сначала ближайший срок.",
    membersOn: ({ service, on, total }) => `${service} · включено ${on} из ${total}`,
    rename: 'Переименовать',
    moreActions: 'Другие действия',
    defaultFor: ({ agent }) => `По умолчанию для ${agent}`,
    defaultForMore: ({ agent, count }) => `По умолчанию для ${agent} +${count}`,
    makeDefault: 'Сделать по умолчанию',
    makeDefaultA11y: 'Сделать по умолчанию для агента',
    usingSince: ({ name, time }) => `Используется ${name} с ${time}`,
    using: ({ name }) => `Используется ${name}`,
    noActive: 'Пока ни один участник не используется',
    noActiveDetail: 'Пул выбирает одного при запуске сессии.',
    leadLeastLimited: 'Сначала наименее ограниченный.',
    leadInOrder: 'По порядку.',
    fallbackOff: ({ name }) => `Автопереключение выключено, поэтому сессии остаются на ${name}, когда он исчерпается.`,
    manualStays: ({ name }) => `Вручную: пул остаётся на ${name}, пока вы не выберете другого участника.`,
    switchTo: ({ name }) => `Переключить на ${name}`,
    onlyOneOn: ({ name }) => `Включён только ${name}, поэтому переключаться не на кого.`,
    turnOn: ({ name }) => `Включить ${name}`,
    allWaitingTitle: 'Все участники ждут сброса',
    allWaitingFirst: ({ name, time, countdown }) => `${name} сбросится первым, в ${time} (${countdown}).`,
    sessionsWait: 'Сессии ждут, а затем продолжаются сами.',
    sessionsStop: 'Сессии останавливаются, пока у участника не появится запас.',
    leftTitle: 'Осталось в пуле',
    leftDescription: 'Среднее по включённым участникам; каждый сбрасывается сам по себе.',
    roomCount: ({ count, total }) => `Запас сейчас есть у ${count} из ${total}`,
    notReported: ({ count }) => `Без данных: ${count}`,
    nothingReported: 'Ни один включённый участник пока не сообщает свои лимиты.',
    membersTitle: 'Участники',
    membersDescription: 'Перетащите, чтобы задать порядок. Выбранный участник — активный; выключенный пропускается.',
    membersCompactDescription: 'Удерживайте и перетаскивайте для изменения порядка.',
    manage: 'Управлять',
    connectAnotherAccount: ({ service }) => `Подключить другой аккаунт ${service}`,
    membersSelectionSummary: ({ count, total, service }) => `${count} из ${total} аккаунтов ${service}`,
    manageMembers: 'Управлять участниками',
    searchAccounts: ({ service }) => `Поиск аккаунтов ${service}`,
    active: 'Активен',
    offNotUsed: 'Пул не использует его, пока он выключен',
    autoOffModel: 'Выключен автоматически · этот тариф не может использовать выбранную модель',
    checkedAt: ({ time }) => `Проверено ${time}`,
    makeActiveA11y: ({ name }) => `Сделать ${name} активным участником`,
    memberOnA11y: ({ name }) => `Использовать ${name} в этом пуле`,
    openA11y: ({ name }) => `Открыть ${name}`,
    dragA11y: 'Перетащите, чтобы изменить порядок',
    behaviorTitle: 'Поведение',
    strategyTitle: 'Стратегия выбора',
    strategyLeastLimited: 'Наименее ограниченный',
    strategyInOrder: 'По порядку',
    strategyManual: 'Вручную',
    strategyLeastLimitedDescription: 'Предпочитать участника с наибольшим доступным лимитом.',
    strategyInOrderDescription: 'Пробовать участников в порядке выше.',
    strategyManualDescription: 'Использовать только активного участника, пока вы его не смените.',
    fallbackTitle: 'Автопереключение',
    fallbackDescription: 'Переключаться на другого участника, когда активному аккаунту нужно восстановление.',
    switchEarlyTitle: 'Переключать заранее',
    switchEarlyDescription: 'Процент остатка, ниже которого пул переходит к участнику с более свежим лимитом. 0 — выключено.',
    autoResetsTitle: 'Автоматически использовать сбросы лимита',
    autoResetsDescription: 'Тратить сохранённый сброс, только когда ни один участник не готов.',
    autoOffTitle: 'Выключать аккаунты, которые не могут использовать выбранную модель',
    autoOffDescription: 'Вы можете включить их снова сами.',
    advancedTitle: 'Дополнительно',
    advancedCount: ({ count }) => `Настроек: ${count}`,
    restoreFirstTitle: 'Возвращаться к первому участнику после сброса',
    restoreFirstDescription: 'После переключения вернуться к первому по порядку участнику, когда его лимит сбросится.',
    switchWhenTitle: 'Переключать, когда',
    switchWhenDescription: 'События, которые переводят пул к следующему участнику.',
    staleAfterTitle: 'Проверять устаревшее использование через',
    staleAfterDescription: 'Минуты. Снова спросить провайдера, если данные старше, перед выбором участника.',
    switchesPerTurnTitle: 'Автопереключений за ход',
    switchesPerHourTitle: 'Автопереключений за час сессии',
    switchLimitsDescription: 'Не даёт пулу метаться между участниками.',
    recoveryTitle: 'Когда лимит останавливает сессию',
    recoveryDescription: 'Что пул делает для ожидающей сессии.',
    recoveryPromptsTitle: 'Сообщения продолжения',
    recoveryPromptsDescription: 'Happier отправляет стандартное сообщение, когда продолжает сессию после переключения или сброса.',
    usedByTitle: 'Используется',
    usedByDefault: 'По умолчанию · новые сессии входят через этот пул',
    usedByNone: 'Пока ни один агент не входит через этот пул по умолчанию.',
    deleteNote: ({ agents }) => `Участники остаются подключёнными. ${agents} вернётся к собственному входу, пока вы не выберете другой вариант по умолчанию.`,
    deleteNoteNoAgent: 'Участники остаются подключёнными.',
    emptyTitle: 'Добавьте аккаунты для переключения',
    emptyReason: ({ service }) => `Пул выбирает аккаунт при запуске сессии и переключается, когда он исчерпан. Добавьте хотя бы два аккаунта ${service}.`,
    usageNotAnswering: ({ service }) => `${service} не ответил`,
    newPoolTitle: 'Новый пул',
    newPoolDescription: ({ service }) => `Аккаунты ${service}, между которыми переключается агент.`,
    nameTitle: 'Название',
    namePlaceholder: 'Рабочий пул',
    draftMembersDescription: 'Выберите аккаунты для переключения. Их можно изменить позже.',
    create: 'Создать пул',
    discard: 'Отменить',
};

const connectedServicesPoolTranslations = { ru };

return { connectedServicesPoolTranslations };
})();

const Domain_connectedServicesSettingsTranslations = (() => {
type ConnectedServicesSettingsCopy = Shared_connectedServicesSettingsTranslations.ConnectedServicesSettingsCopy;

const setupFidelityCopy = Shared_connectedServicesSettingsTranslations.setupFidelityCopy;

const en = Shared_connectedServicesSettingsTranslations.en;

const ru: ConnectedServicesSettingsCopy = {
    ...setupFidelityCopy,
    accountCount: ({ count }) => `Аккаунтов: ${count}`,
    defaultAccount: ({ name }) => `По умолчанию: ${name}`,
    poolCount: ({ count }) => `Пулов: ${count}`,
    noAccountsYet: 'Аккаунтов пока нет',
    needsSignIn: 'Нужен вход',
    signInAgain: 'Войти снова',
    addAccount: 'Добавить аккаунт',
    connectAnotherTitle: 'Подключить другой сервис',
    connectFirstTitle: 'Подключить сервис',
    connectNames: ({ names }) => `${names}.`,
    connectNamesMore: ({ names, count }) => `${names} и ещё ${count}.`,
    connect: 'Подключить',
    emptyTitle: 'Пока нет сервисов для подключения',
    servicesTitle: 'Сервисы',
    emptyNoServiceOnMachine: ({ machine }: { machine: string }) => `Ни один агент на ${machine} пока не предлагает сервис для входа. Агенты с подпиской добавляют свой сюда.`,
    emptyNoMachineOnline: 'Ни одна из ваших машин не в сети. Сервисы появятся, когда одна будет в сети, из запущенных на ней агентов.',
    emptyOpenAgents: 'Открыть агентов',
    emptyAction: 'Открыть машины',
    projectionErrorTitle: 'Не удалось загрузить сервисы с ваших машин',
    projectionErrorDescription: 'Ваши аккаунты по-прежнему в списке. Сервисы для добавления появятся, когда машина ответит.',
    loadingServices: 'Ищем сервисы на ваших машинах…',
    usageTitle: 'Как используются аккаунты',
    usageDescription: 'Каким аккаунтом входит каждый агент при запуске сессии и что общее у сессий.',
    sharingTitle: 'Общее состояние',
    sharingSummary: ({ config, state }) => `${config} · ${state}`,
    configLinkedShort: 'Связана',
    configCopiedShort: 'Копия',
    configIsolatedShort: 'Отдельно',
    stateSharedShort: 'Сессии общие',
    stateIsolatedShort: 'Сессии раздельно',
    perAgentTitle: 'Настройки для агентов',
    perAgentDescription: 'Переопределить эти значения для одного агента.',
    perAgentPurpose: 'Выберите для каждого агента, что сессии подключённых аккаунтов делят с вашим собственным входом.',
    servicePurpose: ({ service }) => `Аккаунты, которыми вы входите в ${service}, и пулы, в которых они используются.`,
    chooseMachineTitle: 'Выберите машину',
    chooseMachineDescription: 'Добавление, вход и удаление аккаунтов выполняются на одной из ваших машин. Ваши аккаунты остаются в списке подключённых сервисов.',
    newAccountTitle: 'Новый аккаунт',
    newAccountDescription: 'Выберите способ входа.',
    newAccountInProgress: 'Завершите вход ниже.',
    modeBrowser: 'Войти через браузер',
    modeDeviceCode: 'Войти по коду',
    modeManual: 'Ввести токен',
    serviceSettingsTitle: 'Настройки сервиса',
    serviceSettingsDescription: 'Настройки, с которыми входит каждый аккаунт этого сервиса.',
    noAccountsDescription: 'Добавьте аккаунт, чтобы ваши агенты могли входить с ним.',
    accountDetailsTitle: 'Сведения об аккаунте',
    poolEmptyTitle: 'Добавьте аккаунты в этот пул',
    poolEmptyDescription: 'Пул переводит сессии на следующий аккаунт, когда один достигает лимита. Выберите аккаунты ниже.',
    agentDefaultsTitle: 'Аккаунт по умолчанию для агента',
    agentDefaultsDescription: 'Аккаунт, которым каждый агент входит при запуске сессии.',
    agentDefaultsKeywords: 'аккаунт по умолчанию',
    namesAnd: ({ names, last }) => `${names} и ${last}`,
    usedBy: ({ names }) => `Используют: ${names}`,
    poolRuleMostLeft: 'использует тот, у которого больше всего осталось',
    poolRuleInOrder: 'использует по порядку',
    poolRuleManual: 'переключаете вручную',
    poolInUse: ({ pool }) => `${pool} · используется`,
    agentDefault: ({ agent }) => `По умолчанию для ${agent}`,
    signedOutBy: ({ service }) => `${service} завершил сеанс`,
    usageReadFailed: 'Не удалось получить расход',
    usageWindowPin: ({ meter }: { meter: string }) => `Показывать ${meter} рядом с полем ввода`,
    noLimitsBilledPerUse: 'Лимиты не сообщаются · оплата по факту',
    needsYouCount: ({ count }) => `Требуют внимания: ${count}`,
    connectToolsTitle: 'Подключите хостинг кода или инструмент',
    inviteTitle: ({ names }) => `Ваши агенты также могут использовать ${names}`,
    inviteWhoOne: ({ agents }) => `${agents} может входить с ним.`,
    inviteWhoMany: ({ agents }) => `${agents} могут входить с ними.`,
    inviteTools: 'Или подключите хостинг кода и инструменты.',
    firstRunTitle: 'Используйте тарифы, за которые уже платите',
    firstRunPromise: 'Подключите аккаунт Claude или ChatGPT один раз. Агенты используют его на каждой машине, а Happier показывает, сколько осталось до лимита.',
    connectAnAccount: 'Подключить аккаунт',
    firstRunMeanwhile: 'А пока каждый агент использует собственный вход на каждой машине.',
    agentAccountsTitle: 'Аккаунты агентов',
    agentAccountsDescription: 'Подписки и ключи, которые используют агенты. Хранятся в вашем аккаунте, поэтому доступны на любой машине.',
    codeAndToolsTitle: 'Код и инструменты',
    setupChooseMachine: 'Выберите машину для входа. Затем аккаунт работает на всех ваших машинах.',
    setupHowToSignIn: 'Способ входа',
    setupRecommendedMethod: ({ method }) => `${method} · Рекомендуется`,
    setupCatalogTitle: 'Подключить сервис',
    setupCatalogPurpose: 'Вход выполняется на выбранной машине. Затем аккаунт работает на всех ваших машинах.',
    setupServiceTitle: ({ service }) => `Подключить ${service}`,
    setupReconnectTitle: ({ service }) => `Снова войти в ${service}`,
    setupServicePurpose: ({ agents, service }) => `${agents} будут использовать ваш аккаунт ${service} на каждой машине.`,
    setupServicePurposeNoAgents: 'Аккаунт работает на каждой машине.',
    setupForYourAgents: 'Для ваших агентов',
    setupOwnLoginTitle: 'Уже вошли на машине?',
    setupOwnLoginBody: 'Продолжайте использовать собственный вход агента. Выберите его в разделе «Как используются аккаунты».',
    setupToolsTitle: 'Хостинг кода и инструменты',
    setupProvidersPointer: 'Поставщики моделей, такие как OpenRouter и Ollama, настраиваются в разделе «Поставщики».',
    setupOpenProviders: 'Открыть «Поставщики»',
    setupTrust: 'Хранится в вашем аккаунте и используется только вашими машинами. Happier сам обновляет вход.',
    setupConnectedCount: ({ count }) => `Подключено: ${count}`,
    settleConnectedAs: ({ identity }) => `Только что подключено: ${identity}.`,
    settleConnected: 'Только что подключено.',
    settleUseFor: ({ agent }) => `Использовать для ${agent}?`,
    settleUseForAction: ({ agent }) => `Использовать для ${agent}`,
    notNow: 'Не сейчас',
    homeInvitePromise: 'Подключите Claude или ChatGPT один раз. Любая машина сможет его использовать, а здесь вы увидите, сколько осталось.',
    homeInviteHide: 'Скрыть',
    homeNextWho: ({ agents }) => `${agents} тоже может его использовать`,
    oauthStepOpen: 'Откройте страницу входа в браузере',
    oauthStepApprove: 'Подтвердите и скопируйте показанный код (или адрес страницы, куда попадёте)',
    oauthStepPaste: 'Вставьте сюда',
    oauthPastePlaceholder: 'Вставьте код или адрес',
    oauthShapeOk: 'Похоже на код входа',
    deviceEnterAt: ({ where }) => `Введите этот код на ${where}`,
    deviceExpired: 'Срок действия кода истёк. Ничего не сохранено.',
    deviceExpiresIn: ({ time }) => `Код истечёт через ${time}`,
    deviceNewCode: 'Получить новый код',
    detailSignedOutTitle: ({ service }) => `${service} завершил сеанс этого аккаунта`,
    detailSignedOutBody: 'Вход был отозван или изменён, например после смены пароля. Сеансы не смогут использовать аккаунт, пока вы не войдёте снова.',
    detailSignInTitle: 'Вход',
    detailSignInNeeded: 'Нужно войти снова',
    detailSignInKeptFresh: 'Happier поддерживает его актуальным',
    detailLastUsed: ({ time }) => `последнее использование ${time}`,
    detailLeavePool: ({ pool }) => `Убрать из ${pool}…`,
    detailRemovePooledNote: ({ pool }) => `${pool} использует этот аккаунт; сначала уберите его из пула. Удаление стирает его из аккаунта и со всех машин.`,
    detailUsageSignedOut: 'Последние известные данные · без входа обновить нельзя',
    detailUsageSignedOutAt: ({ time }: { time: string }) => `Последние известные данные на ${time} · без входа обновить нельзя`,
    detailResetsIn: ({ countdown }) => `через ${countdown}`,
    detailUsedByTitle: 'Используют',
    detailUsedByDefault: 'Аккаунт по умолчанию',
    detailUsedByPool: ({ pool }) => `Через ${pool}`,
    detailUsedByPoolInUse: ({ pool }) => `Через ${pool} · используется сейчас`,
    detailUsedByCould: 'Могут использовать · сейчас входят по-своему',
    detailWorksOnTitle: 'Работает на',
    detailWorksOnDescription: 'Хранится в вашем аккаунте. Машина использует его при запуске сеанса; заранее ничего не копируется.',
    detailSignedInWithCode: 'Вход выполнен по коду',
    detailSignedInWithBrowser: 'Вход выполнен через браузер',
    detailAddedWithKey: 'Добавлен по ключу',
    nearLimitTitle: ({ account, percent, window }) => `У ${account} осталось ${percent}% лимита «${window}»`,
    nearLimitTitleNoAccount: ({ percent, window }) => `Осталось ${percent}% лимита «${window}»`,
    nearLimitBodyWithReset: ({ time }) => `Сброс в ${time}. Примените сброс лимита, чтобы продолжить сейчас.`,
    nearLimitBody: 'Примените сброс лимита, чтобы продолжить сейчас.',
    nearLimitApplyReset: 'Применить сброс',
    catalogSignInBrowserOrCode: 'Вход через браузер или по коду',
    catalogSignInBrowserOrKey: 'Вход через браузер или вставьте токен',
    catalogSignInBrowser: 'Вход через браузер',
    catalogSignInCode: 'Вход по коду',
    catalogPasteKey: 'Вставьте ключ',
    deviceOpenService: ({ service }) => `Открыть ${service}`,
    deviceWaitingFor: ({ service }) => `Ждём подтверждения в ${service}…`,
};

const connectedServicesSettingsTranslations = { ru };

return { connectedServicesSettingsTranslations };
})();

const Domain_connectedServicesSetupTranslations = (() => {
type ConnectedServicesSetupTranslation = Shared_connectedServicesSetupTranslations.ConnectedServicesSetupTranslation;

const connectedServicesSetupTranslations = { ru: {
        connectMoreTitle: 'Подключить ещё',
        connectMoreDescription: 'Сервисы, которые принимают агенты на ваших машинах, но которые вы ещё не подключили.',
        connectMoreNothingNew: 'Добавьте ещё один аккаунт, хостинг кода или инструмент.',
        serviceSignInInstead: ({ agents }) => `${agents} может входить через него вместо входа на каждой машине.`,
        serviceCanUse: ({ agents }) => `${agents} может его использовать.`,
        moreServicesTitle: 'Другие сервисы',
        moreServicesTools: ({ names }) => `${names} и другие — для кода и инструментов.`,
        moreServicesAll: 'Всё, что принимают ваши агенты и инструменты.',
        browse: 'Обзор',
        notNow: ({ service }) => `Не сейчас: ${service}`,
        notNowTooltip: 'Не сейчас · останется в обзоре',
        back: 'Все сервисы',
        homeCatalogTitle: 'Подключить аккаунт',
        homeCatalogPurpose: 'Агенты используют его на всех машинах, а Home показывает, сколько осталось.',
        homeNextSubtitle: ({ agents }) => `${agents} может использовать его вместо входа на каждой машине.`,
        firstRunMore: 'API-ключи, хостинги кода и инструменты',
        settleAddToPoolWhy: ({ pool, agent, active }) => `Добавить в ${pool}, чтобы ${agent} переходил на него, когда закончится ${active}?`,
        settleAddToPoolShort: ({ pool }) => `Добавить в ${pool}?`,
        settleAddToPool: ({ pool }) => `Добавить в ${pool}`,
        deviceStepCopy: 'Скопируйте этот код',
        deviceStepOpen: ({ service }) => `Откройте ${service} и введите его`,
        deviceStepOpenWhere: ({ where }) => `${where}, войдя в нужный аккаунт`,
        deviceStepApprove: ({ service }) => `Разрешите Happier в ${service}`,
        deviceCheckNow: 'Проверить сейчас',
    } } satisfies Pick<Readonly<Record<string, ConnectedServicesSetupTranslation>>, "ru">;

return { connectedServicesSetupTranslations };
})();

const Domain_detailPageTranslations = (() => {
type DetailPageTranslations = Shared_detailPageTranslations.DetailPageTranslations;

const detailPageTranslations = { ru: {
        approval: {
            requestTitle: 'Запрос',
            requestDescription: 'Что запрошено и каков статус.',
            failureTitle: 'Причина сбоя',
            homeUnavailableTitle: 'Home недоступен',
            contextTitle: 'Кто запросил',
            contextDescription: 'Сессия и агент, от которых пришёл запрос.',
            proposalsDescription: 'Будут опубликованы в ревью, если вы одобрите.',
        },
        runs: {
            description: 'Фоновые запуски на ваших машинах.',
            filterLabel: 'Показывать запуски',
            filterRunning: 'Активные',
            filterAll: 'Все',
            onHome: ({ home }) => `В ${home}`,
        },
        person: {
            placeholderTitle: 'Пользователь',
            friendshipTitle: 'Дружба',
            sharedSessionsDescription: 'Сессии, которыми этот друг делится с вами, только просмотр.',
            linkedAccountsTitle: 'Связанные аккаунты',
            linkedAccountsDescription: 'Где ещё этот человек входит в систему. Откроется в браузере.',
        },
        friendsManage: {
            description: 'Люди, с которыми вы работаете в Happier, и запросы между вами.',
            requestsTitle: 'Запросы в друзья',
            requestsDescription: 'Откройте запрос, чтобы принять или отклонить его.',
            sentTitle: 'Отправленные запросы',
            sentDescription: 'Ожидают подтверждения.',
            friendsTitle: 'Друзья',
            friendsDescription: 'Откройте друга, чтобы увидеть, чем он с вами делится.',
        },
    } } as const satisfies Pick<Record<string, DetailPageTranslations>, "ru">;

return { detailPageTranslations };
})();

const Domain_detailsChromeTranslations = (() => {
type DetailsChromeTranslations = Shared_detailsChromeTranslations.DetailsChromeTranslations;

const detailsChromeTranslations = { ru: {
        closeUnsavedTabA11y: 'Закрыть вкладку, есть несохранённые изменения',
        emptyTitle: 'Здесь открываются файлы, изменения и коммиты',
        browseFiles: 'Открыть файлы',
        previewHint: 'Один щелчок открывает предпросмотр; откройте снова, чтобы сохранить вкладку.',
        emptyReason: 'Файлы, изменения и коммиты, которые вы открываете, появляются здесь — рядом с местом, откуда вы их открыли.',
        reviewChanges: ({ count }) => `Просмотреть изменения (${count})`,
        reviewChangesReason: ({ count }) => `В этой сессии изменено файлов: ${count}. Прочитайте их здесь, не покидая разговор.`,
        splitNeedsWiderPane: 'Для сравнения рядом нужна более широкая панель. Расширьте «Подробности» или включите фокус.',
    } } satisfies Pick<Record<string, DetailsChromeTranslations>, "ru">;

return { detailsChromeTranslations };
})();

const Domain_detailsFileTranslations = (() => {
type DetailsFileTranslations = Shared_detailsFileTranslations.DetailsFileTranslations;

const detailsFileTranslations = { ru: {
        areaUnstaged: 'Не в индексе',
        areaStaged: 'В индексе',
        areaBoth: 'Оба',
        areaLabel: 'Изменения',
        preview: 'Просмотр',
        viewLabel: 'Вид',
        compare: 'Сравнить',
        stage: 'Добавить в индекс',
        unstage: 'Убрать из индекса',
        addToCommit: 'Добавить в коммит',
        removeFromCommit: 'Убрать из коммита',
        editing: 'Редактирование',
        editingUnsaved: 'Редактирование · есть несохранённые изменения',
        statusModified: 'Изменён',
        statusAdded: 'Добавлен',
        statusDeleted: 'Удалён',
        statusRenamed: 'Переименован',
        statusCopied: 'Скопирован',
        statusUntracked: 'Новый, ещё не отслеживается',
        statusConflicted: 'Есть конфликты',
        noChanges: 'Без изменений',
        lines: ({ count }) => `Строк: ${count}`,
    } } satisfies Pick<Record<string, DetailsFileTranslations>, "ru">;

return { detailsFileTranslations };
})();

const Domain_detailsHistoryTranslations = (() => {
type Count = Shared_detailsHistoryTranslations.Count;

type Branch = Shared_detailsHistoryTranslations.Branch;

type Folder = Shared_detailsHistoryTranslations.Folder;

type DetailsHistoryTranslations = Shared_detailsHistoryTranslations.DetailsHistoryTranslations;

const detailsHistoryTranslations = { ru: {
        copyCommitSha: 'Скопировать SHA коммита',
        filesChanged: ({ count }) => `Изменено файлов: ${count}`,
        files: ({ count }) => `Файлов: ${count}`,
        revertEllipsis: 'Отменить…',
        stashKeptOn: ({ branch }) => `Отложено в ${branch}`,
        stashOriginBranch: ({ branch }) => `Сохранено при уходе с ${branch}`,
        stashOriginBranchShort: 'При смене ветки',
        stashOriginTransient: 'Сохранено Happier',
        stashOriginUnmanaged: 'Создано вне Happier',
        stashRestoreExplains: ({ folder }) => `Восстановление вернёт эти изменения в ${folder} и удалит stash. Больше ничего в папке не изменится.`,
        stashApply: 'Применить',
        stashApplyA11y: 'Применить эти изменения и сохранить stash',
        stashDiscardEllipsis: 'Удалить…',
        stashSwitcherA11y: 'Выбрать stash',
        stashCount: ({ count }) => `Stash-и: ${count}`,
    } } satisfies Pick<Record<string, DetailsHistoryTranslations>, "ru">;

return { detailsHistoryTranslations };
})();

const Domain_detailsReviewTranslations = (() => {
type Count = Shared_detailsReviewTranslations.Count;

type DetailsReviewTranslations = Shared_detailsReviewTranslations.DetailsReviewTranslations;

const detailsReviewTranslations = { ru: {
        title: 'Проверка',
        files: ({ count }) => (count === 1 ? `1 файл` : `Файлов: ${count}`),
        nextCommit: ({ count }) => `В следующем коммите: ${count}`,
        changedFiles: 'Изменённые файлы',
        commitColumn: 'Коммит',
        jumpA11y: 'Перейти к файлу',
        comments: ({ count }) => (count === 1 ? `1 комментарий` : `Комментариев: ${count}`),
        goesWithNext: ({ count }) => (count === 1 ? `уйдёт со следующим сообщением` : `уйдут со следующим сообщением`),
        askForChanges: 'Попросить изменения',
        detachCommentA11y: 'Не прикладывать этот комментарий к следующему сообщению',
        trayExpandedHint: 'Они уйдут агенту вместе со следующим сообщением.',
        askPlaceholder: 'Скажите агенту, что изменить…',
        send: 'Отправить',
        draftAuthor: 'Вы', draftStatus: 'черновик', includeComment: 'Уйдёт со следующим сообщением',
    } } satisfies Pick<Record<string, DetailsReviewTranslations>, "ru">;

return { detailsReviewTranslations };
})();

const Domain_embedSettingsTranslations = (() => {
const english = Shared_embedSettingsTranslations.english;

const translated = Shared_embedSettingsTranslations.translated;

const embedSettingsTranslations = { ru: translated({
        settingsEmbeds: {
            title: "Встраивания",
            newTitle: "Новое встраивание",
            purpose: "Позвольте другим приложениям показывать чаты Happier только с тем доступом, который вы выберете.",
            yourEmbeds: "Ваши встраивания",
            newEmbed: "Новое встраивание",
            listError: "Не удалось загрузить встраивания",
            emptyTitle: "Добавьте чат Happier в своё приложение",
            emptyBody: "Ваше приложение показывает настоящие разговоры только с тем доступом, который вы выберете: какие сайты, кто может отправлять или одобрять и какие модели.",
            createDescription: "Выберите, что другие приложения могут делать с вашими чатами и как они выглядят.",
            name: "Название",
            nameDescription: "Видно только вам, в этом списке.",
            namePlaceholder: "Например, панель лидов",
            create: "Создать встраивание",
            summary: {
                sites: ({ count }: { count: number }) => `Сайтов: ${count}`,
                send: "Может отправлять",
                sendAndApprove: "Может отправлять и одобрять",
                viewOnly: "Только просмотр",
                modelOnly: ({ name }: { name: string }) => `только ${name}`,
                models: ({ count }: { count: number }) => `Моделей: ${count}`,
            },
            sites: {
                title: "Где может появляться",
                description: "Чаты открываются только на этих сайтах.",
            },
            capabilities: {
                title: "Что могут делать люди",
                view: "Просмотр разговора",
                always: "Всегда",
                send: "Отправка сообщений",
                sendDescription: "Включает остановку агента и прикрепление файлов.",
                changeModel: "Смена модели",
                permissionModes: "Режимы разрешений",
                permissionModesDescription: "Выбор режима показывается в чатах, только если разрешено больше одного режима.",
                anyMode: "Любой режим",
                anyModeDescription: "Люди могут менять, что агент делает без запроса.",
                modeOnly: ({ name }: { name: string }) => `только ${name}`,
                modes: ({ count }: { count: number }) => `Режимов: ${count}`,
                approveOn: "Люди на этих сайтах могут одобрять использование инструментов и запросы в этих чатах.",
            },
            models: {
                title: "Модели",
                description: "Другие модели отклоняются, а не просто скрываются. Чаты начинаются с первой разрешённой модели.",
                allowed: "Разрешённые модели",
                any: "Любая модель",
            },
            organization: {
                title: "Организация",
                description: "Ваше приложение получает отсюда список чатов этого встраивания (с любым из этих тегов). Новые чаты тоже попадают сюда.",
                folder: "Папка",
                tags: "Теги",
                none: "Нет",
            },
            composer: {
                title: "Поле ввода",
                attachments: "Вложения",
                attachmentsDescription: "Скрывает кнопку вложения. Тот, кто может отправлять, всё равно может прикреплять файлы через API.",
            },
            sessions: {
                title: "Сеансы",
                description: "Сеансы, которые создаёт этот ключ с вашего сервера или из чата, работают на этом компьютере с этим агентом и попадают в папку и теги выше.",
                allow: "Разрешить этому ключу создавать сеансы",
                offConsequence: "Этот ключ не может создавать сеансы. Ваше приложение может показывать только существующие чаты.",
                computer: "Компьютер",
                agent: "Агент",
                newChat: "Начинать новые чаты во встраивании",
                appSetting: "Для вашего приложения",
                newChatDescription: "Показывает поле нового чата, когда приложение открывает встраивание без чата. Это настройка для вашего приложения, а не ограничение безопасности: ваш сервер всегда может создавать чаты этим ключом.",
            },
            appearance: {
                title: "Оформление",
                description: "Предпросмотр следует каждому изменению. Открытые чаты меняют вид без перезагрузки.",
                mode: "Режим",
                modeSystem: "Системный",
                modeLight: "Светлый",
                modeDark: "Тёмный",
                theme: "Тема",
                presetHappier: "Happier",
                colors: "Цвета",
                colorsDefault: "Цвета Happier",
                colorsCustomized: ({ count }: { count: number }) => `Изменено: ${count}`,
                colorsFor: "Цвета для",
                colorGroups: {
                    surface: "Поверхности",
                    text: "Текст",
                    accent: "Акцент",
                    messages: "Сообщения",
                    composer: "Поле ввода",
                    approvals: "Одобрения",
                },
                fontFamily: "Шрифт",
                fontFamilyPlaceholder: "Шрифт Happier",
                fontFile: "Файл шрифта",
                fontFileDescription: "Ссылка https на файл .woff2 или .woff.",
                fontFileRefused: "Используйте ссылку на файл .woff2 или .woff, а не на таблицу стилей.",
                textSize: "Размер текста",
                textSizeCompact: "Компактный",
                textSizeDefault: "Обычный",
                textSizeLarge: "Крупный",
                corners: "Углы",
                cornersSharp: "Острые",
                cornersSoft: "Мягкие",
                cornersRound: "Круглые",
                density: "Плотность",
                densityCompact: "Плотная",
                densityComfortable: "Свободная",
                reset: "Сбросить оформление",
            },
            preview: {
                title: "Предпросмотр",
                phone: "Телефон",
                desktop: "Компьютер",
                reduceMotion: "Уменьшить движение",
                note: "Настоящий встроенный чат с примерами сообщений. Ничего не отправляется.",
                rowDescription: "Посмотрите чат с этими настройками.",
                unavailable: "Предпросмотр недоступен",
            },
            snippets: {
                title: "Фрагменты кода",
                description: "Вставьте их в своё приложение. Они уже используют настройки этого встраивания.",
                steps: "1 Сохраните ключ как HAPPIER_EMBED_KEY · 2 Напишите canOpenSession: кто может открыть какой чат · 3 Покажите чат",
                backend: "Сервер",
                react: "React",
            },
            detail: {
                created: ({ date }: { date: string }) => `Создано ${date}`,
                lastUsed: ({ date }: { date: string }) => `Использовано ${date}`,
                expires: ({ date }: { date: string }) => `Истекает ${date}`,
                reconnect: "Открытые чаты переподключатся с новым доступом. Черновики сохранятся.",
                e2eeTrust: "Этот ключ может читать зашифрованные чаты этой учётной записи. Используйте для приложения отдельную учётную запись.",
                keyReach: "Ключ остаётся на вашем сервере и имеет доступ ко всем чатам этой учётной записи. Браузеры его никогда не видят: они получают краткоживущие ключи только для чатов, которые разрешает ваш сервер.",
                expiry: "Срок действия ключа",
                expiryDescription: "Когда срок действия ключа истечёт, чаты перестанут открываться. Продлить его позже нельзя.",
                encryptionChecking: "Проверяем шифрование этой учётной записи…",
                encryptionUnavailable: "Это устройство пока не может читать зашифрованные чаты этой учётной записи. Восстановите секретный ключ, чтобы создать встраивание.",
                encryptionStale: "Ключи этого устройства для зашифрованных чатов устарели. Восстановите секретный ключ, чтобы создать встраивание.",
                encryptionUnreadable: "Не удалось проверить шифрование этой учётной записи.",
                missingTitle: "Этого встраивания больше нет",
                backToEmbeds: "К встраиваниям",
            },
            delete: {
                button: "Удалить встраивание",
                title: ({ label }: { label: string }) => `Удалить «${label}»?`,
                body: "Открытые чаты отключатся. Ключи, уже использованные для чтения зашифрованных чатов, отозвать задним числом нельзя.",
                confirm: "Удалить",
            },
            reveal: {
                copyEnv: "Скопировать как строку .env",
            },
        },
    }) };

return { embedSettingsTranslations };
})();

const Domain_embedTranslations = (() => {
const english = Shared_embedTranslations.english;

const translated = Shared_embedTranslations.translated;

const embedTranslations = { ru: translated({
        embed: {
            errors: {
                originNotAllowed: 'Эта страница не может показывать этот разговор.',
                originNotAllowedReason: 'Добавьте этот сайт в разрешённые сайты встраивания в Happier.',
                unavailable: 'Этот разговор здесь недоступен.',
                encrypted: 'Этот разговор зашифрован и не может быть открыт здесь.',
                createNotGranted: 'Это приложение не может начинать новые чаты.',
                unsupportedVersion: 'Этому чату нужна более новая версия встраивания.',
                unsupportedVersionReason: 'Обновите @happier-dev/embed в этом приложении.',
            },
            nothingToShow: 'Пока нечего показать',
            nothingToShowReason: 'Это приложение ещё не открыло разговор.',
            reconnecting: 'Переподключение…',
            previewUnavailable: 'Предпросмотр недоступен',
            previewUser: "Проанализируй этого лида и запиши результат: Acme Robotics, 40 мест, оценка в четвёртом квартале.",
            previewAgent: "Отличное совпадение. Бюджет подтверждён, решение принимает инициатор. Я записал анализ:",
            previewFollowUp: "Перевести этого лида в квалифицированные?",
        },
    }) };

return { embedTranslations };
})();

const Domain_entityDragDropTranslations = (() => {
type EntityDragDropTranslations = Shared_entityDragDropTranslations.EntityDragDropTranslations;

const en = Shared_entityDragDropTranslations.en;

const ru: EntityDragDropTranslations = {
    files: { attach: "Прикрепить", uploadHere: "Загрузить сюда" },
    composer: { addContext: "Добавить контекст", consequence: "Отправится с вашим следующим сообщением · пока ничего не отправляется", target: "Редактор", readOnly: "Этот редактор доступен только для чтения", otherWorkspace: "Не относится к этому рабочему пространству", unavailable: "Эта ссылка недоступна" },
    surface: {
        scopeMismatch: 'Находится в другом Home или другой учётной записи',
        widgetMoveUnavailable: 'Этот виджет нельзя переместить в эту область',
        readOnly: 'Эта доска доступна только для чтения',
        copyDetail: 'Сохраняет ссылку · доска остаётся без изменений',
    },
    preview: {
        putUnder: ({ target }) => `Подчинить: ${target}`,
        putUnderDetail: 'Отчитывается ей · обе продолжают работать',
        moveAbove: ({ target }) => `Переместить над: ${target}`,
        moveBelow: ({ target }) => `Переместить под: ${target}`,
        orderDetail: 'Только порядок · никто никому не отчитывается',
        moveToFolder: ({ folder }) => `Переместить в ${folder}`,
        folderDetail: 'Только папка · никому не отчитывается',
        moveToTopLevel: 'Переместить на верхний уровень',
        topLevelDetail: 'Из папки · больше ничего не меняется',
        cantPutUnder: ({ target }) => `Нельзя подчинить: ${target}`,
        cantMoveHere: 'Сюда переместить нельзя',
        pendingPutUnder: ({ target }) => `Подчиняем: ${target}…`,
        pendingDetail: 'Ждём подтверждения от Home',
        unknownTitle: 'Неясно, переместилось ли',
        unknownDetail: 'Проверьте список чуть позже, прежде чем повторять',
    },
    settled: {
        refusedPutUnder: ({ item, target }) => `Не удалось поместить ${item} под ${target}`,
        refused: ({ verb }) => `${verb}: не получилось`,
        unknown: ({ verb }) => `Неясно, получилось ли «${verb}»`,
        dismiss: 'Скрыть',
    },
    reasons: {
        read: 'Она доступна вам только для чтения, поэтому не может принимать отчёты',
        input: 'Вы не можете ей ничего отправить, поэтому она не может принимать отчёты',
        pairwise: 'Эти две сессии не могут делиться контекстом',
        cycle: 'Эта сессия уже отчитывается этой',
        alreadyUnder: 'Уже отчитывается этой',
        archived: 'Она в архиве',
        differentHome: 'Она в другом Home. Сессии отчитываются в пределах одного Home',
        unavailable: 'Сейчас не удалось проверить эту сессию',
        dateOrder: 'Этот список отсортирован по дате. Включите свой порядок, чтобы разместить её',
        noChange: 'Она уже здесь',
        descendantCycle: 'Папку нельзя поместить в саму себя',
        maxDepth: 'Папки окажутся вложены слишком глубоко',
        foldersOff: 'Папки отключены для этого Home',
        gone: 'Это место только что исчезло',
        generic: 'Сюда это поместить нельзя',
    },
    chooser: { putUnderTitle: ({ item }) => `Поместить ${item} под…`, checking: 'Проверяем, какие сессии могут принимать отчёты…', cantTakeReports: 'Не могут принимать отчёты', unavailable: 'Недоступно' },
    keyboard: {
        choose: 'Выбрать место', putUnder: 'Подчинить', topLevel: 'Верхний уровень', drop: 'Отпустить', cancel: 'Отмена', escapeKey: 'Esc',
        hintsA11y: 'Стрелки выбирают место, Enter отпускает, Escape отменяет',
    },
    organize: { enter: 'Упорядочить список', title: 'Упорядочить', done: 'Готово', grip: ({ item }) => `Переместить: ${item}` },
    pane: {
        openHere: 'Открыть здесь во вкладке',
        nextTo: ({ target }) => `Рядом с ${target} · ничего не закроется`,
        nothingCloses: 'Откроется во вкладке · ничего не закроется',
        tooNarrow: 'Эта панель слишком узкая для разделения',
        moveHere: 'Переместить сюда во вкладку',
        openBefore: ({ target }) => `Открыть перед: ${target}`,
        moveBefore: ({ target }) => `Переместить перед: ${target}`,
        placeOnly: 'Меняется только место',
        splitLeft: 'Разделить влево',
        splitRight: 'Разделить вправо',
        splitUp: 'Разделить вверх',
        splitDown: 'Разделить вниз',
        opensBeside: ({ target }) => `Откроется рядом с ${target}`,
        movesBeside: ({ target }) => `Переместится рядом с ${target}`,
        goTo: ({ target }) => `Перейти: ${target}`,
        openInThisPane: 'Уже открыта в этой панели · ничего нового не откроется',
        openInAnotherPane: 'Уже открыта в другой панели · ничего нового не откроется',
        alreadyHere: 'Уже здесь',
        leaveIt: 'Отпустите, чтобы оставить на месте',
        cantOpenHere: 'Здесь не открыть',
        sessionsOnly: 'Эта панель показывает только сессии',
        otherWorkspace: 'Не относится к этому рабочему пространству',
    },
};

const entityDragDropTranslations = { ru };

return { entityDragDropTranslations };
})();

const Domain_eventAutomationComposerTranslations = (() => {
const english = Shared_eventAutomationComposerTranslations.english;

const ru = {
    eventAutomationComposer: {
        available: 'Доступно',
        payloadFields: 'ПОЛЯ ПОЛЕЗНОЙ НАГРУЗКИ',
        payloadSample: 'Пример полезной нагрузки',
        noFilterableFields: 'Это событие не объявляет фильтруемые поля полезной нагрузки.',
        addFilterClause: 'Добавить условие',
        filterField: 'Поле фильтра',
        filterOperator: 'Оператор фильтра',
        filterEquals: 'Равно',
        filterOneOf: 'Является одним из',
        filterValue: 'Значение фильтра',
        filterValuePlaceholder: '«ценность» или [«ценность»]',
        storedContentUnavailableTitle: 'Сохраненный контент автоматизации недоступен.',
        storedContentUnavailableBody: 'Эту автоматизацию событий невозможно сохранить, поскольку ее сохраненное содержимое недоступно.',
        historyGapRecoveryTitle: 'Исторический пробел требует внимания',
        historyGapRecoverySubtitle: 'Сбросьте исходную базовую линию, чтобы возобновить наблюдение за новыми событиями.',
        historyGapRecoveryUnavailable: 'Действие по восстановлению источника недоступно в текущем наблюдателе.',
        historyGapRecoveryFailureTitle: 'Для восстановления исходного кода требуется еще одна попытка',
        historyGapRecoveryFailureBody: 'Восстановление не подтвердилось. Источник по-прежнему требует внимания.',
        sourceStatusTitle: 'Источник наблюдения',
        sourceStatusState: {
            uninitialized: 'Не запущено',
            baselined: 'Базовая точка готова',
            observing: 'Идёт наблюдение',
            backingOff: 'Ожидание повторной попытки',
            attention: 'Требует внимания',
        },
        sourceStatusCode: {
            credentialMissing: 'Требуются учётные данные',
            credentialRevoked: 'Учётные данные отозваны',
            rateLimited: 'Ограничение частоты запросов',
            historyGap: 'Пробел в истории',
            capacityBlocked: 'Достигнут предел ёмкости',
            definitionStale: 'Определение изменено',
            sourceContractIncompatible: 'Источник требует обновления',
            admissionUnavailable: 'Приём недоступен',
        },
        sourceStatusNextRetry: ({ time }: { time: string }) => `Следующая попытка: ${time}`,
        sourceStatusObservedCount: ({ count }: { count: number }) => `Замечено событий: ${count}`,
        sourceStatusAdmittedCount: ({ count }: { count: number }) => `Принято событий: ${count}`,
        sourceStatusSkippedCount: ({ count }: { count: number }) => `Пропущено событий: ${count}`,
        sourceStatusLastObserved: ({ time }: { time: string }) => `Последнее наблюдение: ${time}`,
        sourceCatalogStatusTitle: 'Сверка каталога',
        sourceCatalogStatusState: {
            current: 'Актуально',
            reconciling: 'Идёт сверка',
            reconciliationLate: 'Сверка задерживается',
        },
        sourceCatalogStatusObservedRevision: ({ revision }: { revision: string }) => `Наблюдаемая ревизия: ${revision}`,
        sourceCatalogStatusAdoptedRevision: ({ revision }: { revision: string }) => `Принятая ревизия: ${revision}`,
        sourceCatalogStatusNoAdoptedRevision: 'Ревизия ещё не принята',
        sourceCatalogStatusScanStarted: ({ time }: { time: string }) => `Сканирование началось: ${time}`,
    },
};

const eventAutomationComposerTranslations = { ru } as const;

return { eventAutomationComposerTranslations };
})();

const Domain_externalSessionOperationTranslations = (() => {
const en = Shared_externalSessionOperationTranslations.en;

const translated = Shared_externalSessionOperationTranslations.translated;

const externalSessionOperationTranslations = { ru: {
    browseLinked: 'Связан',
    browseImported: 'Импортирован',
    browseAgentUnavailable: 'Happier не смог запустить выбранный Agent или подключиться к нему на этой машине. Проверьте, установлен ли его CLI, и повторите попытку.',
    browseAgentTimedOut: 'Выбранный Agent на этой машине не ответил вовремя. Возможно, он занят или ещё индексирует, поэтому повторите попытку.',
    browseAgentFailed: 'Happier не смог прочитать сессии выбранного Agent на этой машине. Повторите попытку; если ошибка повторяется, обновите Happier на этой машине.',
    operationTitleMaterialize: 'Импортировать в Happier',
    operationTitleTakeoverLinked: 'Перехватить управление и сохранить связь',
    operationTitleTakeoverPersisted: 'Импортировать и перехватить управление',
    operationMaterializeAvailable: 'Импортируйте эту связанную сессию, чтобы использовать её историю офлайн или поделиться ею.',
    externalAgentStatusOnMachine: ({ agent, machine, status }: { agent: string; machine: string; status: string }) =>
        `${agent} на ${machine}: ${status}`,
    operationStatusRunning: 'Выполняется',
    operationStatusCancelling: 'Отмена…',
    operationStatusCancelled: 'Отменено',
    operationStatusCompleted: 'Завершено',
    operationStatusDiscarded: 'Частичная сессия удалена',
    operationStatusNeedsResume: 'Ожидание вашего продолжения',
    operationStatusNeedsReview: 'Перед продолжением требуется проверка',
    operationStatusFailed: 'Не удалось продолжить',
    operationStatusImportIncomplete: 'Импорт не завершён — Продолжить или удалить частичный сеанс',
    operationStatusUpdateIncomplete: 'Обновление не завершено — Продолжить',
    operationStatusOriginOffline: 'Прогресс сохранён — исходный компьютер не в сети',
    operationStatusOriginUnknown: 'Прогресс сохранён — Happier не может определить, в сети ли исходный компьютер',
    operationStatusExternalWriter: 'Обнаружена внешняя запись',
    operationStatusSpawnFailedAfterImport: 'Импорт завершён, но Agent не запустился — Повторить запуск',
    operationStatusSpawnFailedAfterTakeover: 'Управление перехвачено, но Agent не запустился — Повторить запуск',
    operationErrorSourceUnavailable: 'Источник недоступен. Подключите исходную машину и продолжите.',
    operationErrorSourceChanged: 'Источник изменился во время чтения. Проверьте его перед продолжением.',
    operationErrorCapacity: 'На этой машине недостаточно временного пространства для продолжения.',
    operationErrorRequiredItems: 'Некоторые обязательные элементы сессии не удалось импортировать.',
    operationErrorImport: 'Импорт сообщений был прерван.',
    operationErrorPublication: 'Не удалось опубликовать импортированный снимок.',
    operationErrorAdmission: 'Happier не смог безопасно взять эту сессию под управление.',
    operationErrorExternalWriter: 'Остановите внешний Agent перед повторной попыткой. Happier не будет автоматически объединять или останавливать его.',
    operationErrorInternal: 'Операция остановлена из-за внутренней ошибки.',
    operationPhaseValidating: 'Проверка',
    operationPhaseWaitingForAgent: 'Ожидание остановки внешнего Agent',
    operationPhaseReadingSource: 'Чтение источника',
    operationPhaseImporting: 'Импорт сообщений',
    operationPhaseCatchingUp: 'Синхронизация с источником',
    operationPhasePreparingRuntime: 'Подготовка среды выполнения',
    operationPhaseStartingRuntime: 'Запуск среды выполнения',
    operationPhaseFinalizing: 'Завершение',
    operationPhasePublishing: 'Публикация импортированной сессии',
    operationActionResume: 'Продолжить',
    operationActionRetryStart: 'Повторить запуск',
    operationActionCancel: 'Отменить',
    operationActionDiscard: 'Удалить частичный сеанс',
    operationActionDismiss: 'Закрыть',
    operationStatusOwnerReadFailed: 'Happier не смог прочитать текущий прогресс этой операции.',
    operationActionCheckAgain: 'Проверить снова',
    operationComposerImporting: 'Импорт…',
    operationComposerTakingOver: 'Перехват управления…',
    operationActionErrorUpgradeRequired: 'Обновите Happier на исходной машине, чтобы использовать это действие.',
    operationActionErrorNotFound: 'Эта операция больше недоступна.',
    operationActionErrorConflict: 'Другая операция уже управляет этой сессией.',
    operationActionErrorStaleRevision: 'Операция изменилась. Проверьте актуальный прогресс и повторите попытку.',
    operationActionErrorInvalidState: 'Это действие недоступно в текущем состоянии операции.',
    operationActionErrorNotAllowed: 'У вас нет разрешения управлять этой операцией.',
    operationActionErrorUnavailable: 'Не удалось выполнить действие. Повторите попытку с актуального состояния.',
    operationImportProgress: 'Ход импорта',
    operationImportCountUnknown: ({ imported }: { imported: number }) => `Импортировано сообщений: ${imported}`,
    operationImportCountEstimated: ({ imported, total }: { imported: number; total: number }) => `${imported} из примерно ${total} сообщений`,
    operationPublishedSnapshot: 'Опубликованный снимок сохранён',
    operationPublishedThrough: ({ sequence }: { sequence: number }) => `Доступно до сообщения ${sequence}`,
    operationDiscardConfirmTitle: 'Удалить частичную сессию?',
    operationDiscardConfirmBody: 'Будет удалена вся частичная сессия. Это действие нельзя отменить.',
    sharingTranscriptOnMachine: ({ machine }: { machine: string }) =>
        `История этой сессии находится на машине ${machine}. Импортируйте её в Happier, чтобы поделиться.`,
    sharingImportIncomplete: 'Импорт выполняется или не завершён. Продолжите импорт перед публикацией.',
    sharingTranscriptUnavailableTitle: 'История недоступна',
    transcriptRetainedRefreshFailedTitle: 'Показана последняя известная история',
    transcriptLoadFailed: 'Happier не смог загрузить эту историю.',
    sharingTranscriptUnavailable: 'История недоступна. У этой устаревшей связанной сессии нет безопасно сохранённой истории.',
    sharingSharedUpTo: ({ time }: { time: string }) => `Опубликовано до ${time}`,
    sharingSnapshotFrom: ({ time }: { time: string }) => `Снимок от ${time}`,
    sharingUpdateSharedCopy: 'Обновить опубликованную копию',
    sharingUpdateSharedCopyDescription: 'Обновите опубликованный снимок последней историей из источника.',
    sharingSourceMachineMissing: 'Исходная машина недоступна. Перед повторной попыткой подключите её к Happier.',
    sharingSourceMachineOffline: 'Исходная машина не в сети. Перед повторной попыткой подключите её к сети.',
    sharingActionAwaitingAvailability: 'Это действие станет доступно после подключения процесса материализации.',
} } as const;

return { externalSessionOperationTranslations };
})();

const Domain_externalSessionSettingsTranslations = (() => {
const en = Shared_externalSessionSettingsTranslations.en;

const translated = Shared_externalSessionSettingsTranslations.translated;

const externalSessionSettingsTranslations = { ru: {
    settingsIntegrationStatusNotInstalled: 'Не установлена',
    settingsIntegrationStatusEnabled: 'Установлена и включена',
    settingsIntegrationStatusDisabled: 'Установлена и выключена',
    settingsIntegrationStatusNeedsAttention: 'Требует внимания',
    settingsIntegrationStatusUnsupported: 'Не поддерживается этой версией Agent',
    settingsIntegrationStatusUnavailable: 'Agent недоступен',
    settingsIntegrationInventoryLoadingTitle: 'Проверка состояния интеграций',
    settingsIntegrationInventoryLoadingSubtitle: 'Чтение полного списка интеграций с этой машины.',
    settingsIntegrationInventoryPartialTitle: 'Неполное состояние интеграций',
    settingsIntegrationInventoryPartialSubtitle: 'Некоторые записи об установке не удалось прочитать. Проверьте снова перед внесением изменений.',
    settingsIntegrationInventoryErrorTitle: 'Состояние интеграций недоступно',
    settingsIntegrationInventoryErrorSubtitle: 'Последнее известное состояние может быть устаревшим. Проверьте снова перед внесением изменений.',
    settingsIntegrationTitle: 'Мониторинг внешних сессий',
    settingsIntegrationNeedsAttentionTitle: 'Требует внимания',
    settingsIntegrationDiagnosticMessageUnavailable: 'Эта установка требует внимания, прежде чем мониторинг сможет продолжиться.',
    settingsIntegrationRemediationRetry: 'После устранения проблемы проверьте снова.',
    settingsIntegrationRemediationOpenSettings: ({ path }: { path: string }) => `Проверьте настройку по адресу ${path}.`,
    settingsIntegrationRemediationSelectAccount: ({ service }: { service: string }) => `Выберите учётную запись для ${service}.`,
    settingsIntegrationRemediationInstallDependency: ({ dependency }: { dependency: string }) => `Установите необходимую зависимость: ${dependency}.`,
    settingsIntegrationRemediationOpenUrl: ({ url }: { url: string }) => `Ознакомьтесь с инструкцией по адресу ${url}.`,
    settingsIntegrationActionReviewInstall: 'Проверить и установить',
    settingsIntegrationActionDisable: 'Отключить',
    settingsIntegrationActionEnable: 'Включить',
    settingsIntegrationActionUninstall: 'Удалить',
    settingsIntegrationActionCheckAgain: 'Проверить снова',
    settingsIntegrationReviewTitle: ({ agent }: { agent: string }) => `Проверить интеграцию ${agent}`,
    settingsIntegrationReviewBody: ({ entries }: { entries: string }) =>
        `Happier будет управлять только следующими записями: ${entries}.`,
    settingsIntegrationReviewBodyUnavailable: 'Проверьте изменения, управляемые Agent, перед установкой.',
    settingsIntegrationPreviewNoMatcher: 'Все подходящие сессии',
    settingsIntegrationActionInstall: 'Установить',
    settingsIntegrationUninstallTitle: ({ agent }: { agent: string }) => `Удалить интеграцию ${agent}?`,
    settingsIntegrationUninstallBody: 'Будут удалены только записи, которыми управляет Happier. Остальная конфигурация Agent останется без изменений.',
    settingsIntegrationActionFailed: 'Happier не смог обновить эту интеграцию. Проверьте машину и повторите попытку.',
    settingsAutoLinkUpdateFailed: 'Happier не смог обновить автоматическое связывание. Повторите попытку.',
    settingsRestoreUpdateFailed: 'Happier не смог обновить настройку синхронизации после перезапуска. Повторите попытку.',
    settingsIntegrationsGroupTitle: 'Мониторинг внешних сессий',
    settingsIntegrationsFooter: 'Happier изменяет конфигурацию Agent только после явного действия. Открытие этой страницы ничего не изменяет.',
    settingsIntegrationsUnavailableTitle: 'Нет доступных интеграций',
    settingsIntegrationsUnavailableSubtitle: 'Подключите поддерживаемую интеграцию Agent, чтобы проверить её состояние и доступные действия.',
    settingsAgentAutoLinkTitle: ({ agent }: { agent: string }) => `Автоматически добавлять новые сессии ${agent}`,
    settingsAutoLinkTitle: 'Автоматически добавлять новые внешние сессии',
    browseAutoLinkTitle: 'Автоматически добавлять новые сессии',
    settingsAutoLinkGroupTitle: 'Автоматическое связывание',
    settingsAutoLinkGroupFooter: 'Автоматическое связывание по умолчанию отключено и не зависит от настройки интеграции Agent и фоновой синхронизации.',
    settingsAutoLinkUnavailableTitle: 'Нет источников для автоматического связывания',
    settingsAutoLinkUnavailableSubtitle: 'На этой машине нет поддерживаемых областей источников.',
    settingsAutoLinkSubtitle: 'Когда эта функция включена, Happier связывает новые поддерживаемые сессии из этого источника, не открывая и не возобновляя Agent.',
    settingsAutoLinkHint: 'Включает или отключает автоматическое связывание для этого источника.',
    settingsPrivacyGroupTitle: 'Конфиденциальность',
    settingsPrivacyTitle: 'Ограниченные наблюдения без содержимого',
    settingsPrivacySubtitle: 'Доверенные интеграции Agent могут проверять ограниченные нативные данные хуков на этой машине. Happier принимает и синхронизирует только наблюдения без содержимого; хост никогда не сохраняет, не синхронизирует и не записывает в журнал исходные данные, пути, учётные данные, запросы, текст истории или аргументы инструментов.',
    settingsAgentActionsGroupTitle: 'Внешние сессии',
    settingsAgentBrowseTitle: ({ agent }: { agent: string }) => `Просмотр внешних сессий ${agent}`,
    settingsManageAllTitle: 'Управлять всеми настройками внешних сессий',
    settingsManageAllSubtitle: 'Проверьте интеграции и фоновую синхронизацию на подключённых машинах.',
    settingsMachineOnline: 'В сети',
    settingsMachineOffline: 'Не в сети',
    settingsMachineTitle: 'Машина',
    settingsMachineUnavailable: 'Нет подключённой машины',
    browseSearchIncomplete: ({ count }: { count: number }) =>
        `Показаны первые ${count} — уточните поиск`,
    browseAnnotationsIncomplete: 'Не удалось подтвердить некоторые статусы. Открытие сессии проверит его.',
    browseRouteUnavailableTitle: 'Внешние сессии здесь недоступны',
    browseRouteUnavailableSubtitle: 'Этот сервер не поддерживает просмотр внешних сессий. Вернись назад и выбери другой сервер или попробуй позже.',
    browseRouteAvailabilityUnknownTitle: 'Не удалось подтвердить поддержку внешних сессий',
    browseRouteAvailabilityUnknownSubtitle: 'Happier не смог проверить, поддерживает ли этот сервер просмотр внешних сессий. Вернись назад и попробуй ещё раз через минуту.',
    browseHeaderTitle: 'Внешние сессии',
    browseSettingsLink: 'Настройки внешних сессий',
    browseChooseMachineTitle: 'Выберите машину',
    browseChooseMachineBody: 'Внешние сессии хранятся на машине, где они запускались. Выберите машину, чтобы увидеть её сессии.',
    browseMachineGoneBody: 'Она удалена или заменена. Выберите другую машину, чтобы увидеть её сессии.',
    browseHomeUnreachableBody: 'Его машины и сессии появятся, когда к нему можно будет подключиться. Пока выберите другую машину.',
    browseMachineOfflineTitle: ({ machine }: { machine: string }) => `${machine} не в сети`,
    browseThisMachineOfflineTitle: 'Эта машина не в сети',
    browseMachineOfflineBody: 'Её сессии появятся, когда она снова подключится.',
    browseChooseAnotherMachine: 'Выбрать другую машину',
    browseCantReachTitle: ({ machine }: { machine: string }) => `Не удаётся связаться с Happier на ${machine}`,
    browseCantReachBody: 'Машина в сети, но её служба Happier не отвечает. Возможно, она ещё запускается.',
    browseNothingToBrowseTitle: ({ machine }: { machine: string }) => `На ${machine} нечего просматривать`,
    browseNothingToBrowseBody: 'Ни один агент на этой машине пока не может делиться своими сессиями.',
    browseEmptyTitle: ({ agent, machine }: { agent: string; machine: string }) => `Нет сессий ${agent} на ${machine}`,
    browseEmptyBody: 'Сессии, запущенные на этой машине, появляются здесь и готовы к открытию в Happier.',
    browseTryAgent: ({ agent }: { agent: string }) => `Попробовать ${agent}`,
    browseNoMatches: ({ query }: { query: string }) => `Нет сессий, соответствующих «${query}»`,
    browseErrorTitle: 'Не удалось загрузить сессии',
    browseThisMachine: 'этой машине',
    browseIndexingStop: 'Остановить',
    browseThreadsFilter: 'Потоки субагентов',
    browseThreadsHidden: 'Только основные сессии',
    browseThreadsShown: 'С потоками субагентов',
    browseThreadReviewer: 'Проверяющий',
    browseThreadSubagent: 'Субагент',
    browseThreadReviewerOf: ({ parent }: { parent: string }) => `Проверяющий для «${parent}»`,
    browseThreadSubagentOf: ({ parent }: { parent: string }) => `Субагент для «${parent}»`,
} };

return { externalSessionSettingsTranslations };
})();

const Domain_filesPaneTranslations = (() => {
type FilesPaneTranslations = Shared_filesPaneTranslations.FilesPaneTranslations;

const filesPaneTranslations = { ru: {
        changedOnly: 'Только изменённые',
        showAllFiles: 'Показать все файлы',
        viewOptions: 'Параметры вида',
        sizeAndDate: 'Размер и дата',
        newMenu: 'Новый файл, новая папка или загрузка',
        newFile: 'Новый файл',
        newFolder: 'Новая папка',
        noChangedFilesTitle: 'Ничего не изменилось',
        noChangedFilesReason: 'Рабочая копия совпадает с последним коммитом.',
        rootErrorTitle: ({ machine }) => `Не удалось получить список файлов на ${machine}`,
        rootErrorTitleUnnamed: 'Не удалось получить список файлов',
    } } as const satisfies Pick<Record<string, FilesPaneTranslations>, "ru">;

return { filesPaneTranslations };
})();

const Domain_findTranslations = (() => {
type FindTranslations = Shared_findTranslations.FindTranslations;

const slavicPlural = Shared_findTranslations.slavicPlural;

const russianPlural = Shared_findTranslations.russianPlural;

const en = Shared_findTranslations.en;

const ru: FindTranslations = {
    open: 'Найти…',
    openedForMatch: 'Открыто для совпадения', foldAgain: 'Свернуть снова', showHiddenLines: ({ count }) => `Показать ${count} ${russianPlural(count, 'скрытую строку', 'скрытые строки', 'скрытых строк')}`,
    surface: {
        chat: 'Найти в чате',
        changes: 'Найти в изменениях',
        file: 'Найти в файле',
        terminal: ({ name }) => `Найти в ${name}`,
    },
    previous: 'Предыдущее совпадение',
    next: 'Следующее совпадение',
    matchCase: 'Учитывать регистр',
    regex: 'Регулярное выражение',
    regexShort: 'Регулярное выражение',
    options: 'Параметры поиска',
    close: 'Закрыть поиск',
    done: 'Готово',
    stop: 'Остановить',
    noMatches: 'Нет совпадений',
    noneFound: 'Ничего не найдено',
    invalidPattern: 'Неверный шаблон',
    offline: 'Офлайн',
    unsupported: 'Здесь поиск недоступен',
    count: ({ current, total }) => (current === null ? `${total} ${russianPlural(total, 'совпадение', 'совпадения', 'совпадений')}` : `${current} из ${total}`),
    files: ({ count }) => `${count} ${russianPlural(count, 'файл', 'файла', 'файлов')}`,
    soFar: 'пока',
    loaded: 'загружено',
    note: {
        searchingOlder: 'Поиск по более ранним сообщениям, расшифрованным на этом устройстве',
        offlineOlder: 'Более ранние сообщения можно будет найти, когда вы снова будете онлайн.',
        terminalKept: ({ lines }) => `Поиск выполнен по последним ${lines} строкам, которые хранит этот терминал.`,
    },
};

const findTranslations = { ru };

return { findTranslations };
})();

const Domain_folderlessSessionTranslations = (() => {
type FolderlessSessionTranslations = Shared_folderlessSessionTranslations.FolderlessSessionTranslations;

const en = Shared_folderlessSessionTranslations.en;

const ru: FolderlessSessionTranslations = {
    composer: {
        addFolder: 'Добавить папку',
        noFolder: 'Без папки',
        noFolderDescription: 'Happier ведёт для этого чата отдельную папку',
        removeFolder: 'Убрать папку',
        a11y: {
            folder: ({ path }) => `Папка: ${path}. Открывает выбор папки.`,
            none: 'Без папки. Happier ведёт для этого чата отдельную папку. Добавить папку.',
            loading: 'Папка загружается',
            noFolderRow: 'Без папки, отдельная папка для этого чата',
            removed: 'Папка убрана',
            set: ({ path }) => `Выбрана папка ${path}`,
        },
    },
    display: {
        chats: 'Чаты',
        untitledChat: 'Новый чат',
        folder: 'Папка',
        privateToSession: 'Только для этой сессии',
        sessionFiles: 'Файлы сессии',
        privateFolderOn: ({ machine }) => `Отдельная папка на ${machine}`,
    },
};

const folderlessSessionTranslations = { ru: ru };

return { folderlessSessionTranslations };
})();

const Domain_glassAppearanceTranslations = (() => {
const englishTranslations = Shared_glassAppearanceTranslations.englishTranslations;

const effectiveTranslations = { "ru": {
        "effectiveBrowserSolid": "Непрозрачные меню и плавающие элементы. Браузер не может показать рабочий стол.",
        "effectiveFloatingSolid": "Непрозрачные плавающие элементы на этом устройстве.",
        "effectiveSolid": "Непрозрачные поверхности на этом устройстве.",
        "effectiveBrowser": "Стекло в меню и плавающих элементах. Браузер не может показать рабочий стол.",
        "effectiveBrowserCustom": "Ваш материал в меню и плавающих элементах. Браузер не может показать рабочий стол.",
        "effectivePhone": "Стекло на плавающих элементах и панелях.",
        "effectiveLayered": "Слои стекла во всём окне.",
        "effectiveUniform": "Единый слой стекла во всём окне.",
        "effectiveCustom": "Стекло в этом окне по вашим настройкам.",
        "effectiveUnavailable": "Стекло окна недоступно. Плавающие элементы используют выбранный материал.",
        "effectiveInactive": "Непрозрачное, пока окно неактивно.",
        "effectiveTint": "Тонированные плавающие элементы; размытие фона недоступно.",
        "description": "Показывайте рабочий стол сквозь окно, а страницу — сквозь плавающие элементы.",
        "descriptionBrowser": "Показывайте страницу сквозь меню и плавающие элементы.",
        "descriptionPhone": "Показывайте страницу сквозь плавающие элементы и панели.",
        "chromeDescription": "Заголовок, навигация и фон окна",
        "sidebarDescription": "Колонка сеансов",
        "contentDescription": "Разговор, поле ввода и рабочие панели",
        "floatingDescription": "Меню, всплывающие окна, панели и плавающие элементы",
        "clear": "Прозрачно",
        "shortcutHint": ({ modifier }: { modifier: string }) => `${modifier}-щелчок · ${modifier}⇧L переключает светлую и тёмную темы`
    } } as const;

const glassAppearanceTranslations = { ru: { iosReduceTransparencyPath: "Настройки › Универсальный доступ › Дисплей и размер текста › Понижение прозрачности", title: 'Стекло', material: 'Материал', solid: 'Непрозрачный', auto: 'Авто', everywhere: 'Везде', custom: 'Свой', blur: 'Размытие', off: 'Выкл.', opacity: 'Непрозрачность', customize: 'Настроить', chrome: 'Рамка окна', sidebar: 'Боковая панель', content: 'Содержимое', floating: 'Плавающие поверхности', appearance: 'Оформление', moreSettings: 'Другие настройки оформления…', customizeLink: 'Настроить…', toolbarTitle: 'Кнопка оформления', toolbarDescription: 'Показывает Оформление на панели. Щелчок с модификатором переключает светлую и тёмную темы.', reduceTransparency: 'Непрозрачный: включено уменьшение прозрачности', osSettings: 'Открыть настройки универсального доступа', themeCommand: 'Переключить светлую и тёмную темы', autoDescription: "Подстраивается под устройство: слои стекла в совместимых окнах и плавающие поверхности на телефоне.", osSettingsUnavailable: "Не удалось открыть настройки универсального доступа. Откройте их в настройках устройства.", ...effectiveTranslations["ru"] } } satisfies Pick<Record<string, Record<keyof typeof englishTranslations, string | ((params: { modifier: string }) => string)>>, "ru">;

return { effectiveTranslations, glassAppearanceTranslations };
})();

const Domain_goalControlTranslations = (() => {
const en = Shared_goalControlTranslations.en;

const ru: typeof en = {
    row: {
        notSet: 'Не задана',
    },
    keepGoing: {
        title: 'Продолжать до готовности',
        nativeDescription: ({ agent }) => `${agent} сам продолжает работу над целью.`,
        description: ({ rounds }) => `После каждого вашего хода агент проверяет цель и продолжает, пока она не достигнута, не исчерпан бюджет или не прекратится прогресс, не больше ${rounds} ${rounds === 1 ? 'раунда' : 'раундов'}.`,
        roundsPrefix: 'Остановиться после',
        roundsSuffix: 'раундов',
        roundsLabel: 'Раундов до остановки',
        strikesPrefix: 'Остановиться после',
        strikesSuffix: 'проверок без прогресса',
        strikesLabel: 'Проверок без прогресса до остановки',
        secondOpinionTitle: 'Запросить второе мнение перед завершением',
        secondOpinionDescription: 'Прежде чем цель будет отмечена выполненной, её проверяет второй агент. Если он не согласен, вы получите уведомление, а цель останется открытой.',
        budgetUnreported: ({ agent }) => `${agent} не сообщает расход токенов, поэтому действуют только раунды и проверки прогресса.`,
    },
};

const goalControlTranslations = { ru };

return { goalControlTranslations };
})();

const Domain_homeAddTranslations = (() => {
type HomeAddTranslation = Shared_homeAddTranslations.HomeAddTranslation;

const en = Shared_homeAddTranslations.en;

const homeAddTranslations = { ru: {
        addressIsSignInService: 'Этот адрес принадлежит сервису входа. Войдите через него, чтобы найти свои Home.',
        mixedContent: 'Этот браузер не может подключиться к Home по HTTP со страницы HTTPS. Откройте Happier по HTTP или используйте HTTPS-адрес Home.',
        connectedToHome: ({ home }) => `${home} подключён к этому устройству.`,
        openHome: ({ home }) => `Открыть ${home}`,
        showAllHomes: 'Показать все Home',
        otherSignInService: 'Другая служба входа',
        otherSignInServiceSubtitle: 'Собственная или корпоративная служба',
        signInServiceAddress: 'Адрес службы',
    } } satisfies Pick<Record<string, HomeAddTranslation>, "ru">;

return { homeAddTranslations };
})();

const Domain_homeComposerTranslations = (() => {
type HomeComposerTranslation = Shared_homeComposerTranslations.HomeComposerTranslation;

const starterPrompts = Shared_homeComposerTranslations.starterPrompts;

const homeComposerTranslations = { ru: {
        ...starterPrompts,
        suggestionsLabel: 'Подсказки',
        summarizeProjectSince: ({ project, day }) => `Кратко опиши, что изменилось в ${project} с момента: ${day}`,
        summarizeProjectToday: ({ project }) => `Кратко опиши, что изменилось в ${project} сегодня`,
        sessionsSince: ({ count, day }) => `Сессий с момента «${day}»: ${count}`,
        sessionsToday: ({ count }) => `Сессий сегодня: ${count}`,
    } } satisfies Pick<Readonly<Record<string, HomeComposerTranslation>>, "ru">;

return { homeComposerTranslations };
})();

const Domain_homeDeviceApprovalTranslations = (() => {
type HomeDeviceApprovalTranslation = Shared_homeDeviceApprovalTranslations.HomeDeviceApprovalTranslation;

const homeDeviceApprovalTranslations = { ru: {
        title: 'Одобрение устройств', deviceFallback: 'Новое устройство',
        homeLabel: ({ home }) => `Home: ${home}`, expiresLabel: ({ expiry }) => `Истекает: ${expiry}`,
        requestDetails: 'Сведения о запросе', requestDetailsHint: 'Показать идентификатор ключа запроса',
        fingerprintLabel: 'Отпечаток ключа запроса', requestDetailsHelp: 'Это идентификатор ключа запроса, а не код, который нужно сверять.',
        approve: 'Одобрить', reject: 'Отклонить', loadError: 'Не удалось загрузить запросы на одобрение устройств.',
        loadErrorUnreachable: ({ homes }) => `${homes} не отвечает.`, loadErrorFailed: ({ homes }) => `${homes} ответил ошибкой.`,
        decisionError: 'Не удалось обновить этот запрос.', decisionRecovery: 'Выберите «Одобрить» или «Отклонить», чтобы повторить попытку.',
        approved: 'Устройство одобрено', rejected: 'Устройство отклонено', expired: 'Срок истёк', stopWaiting: 'Перестать ждать',
    } } as const satisfies Pick<Record<string, HomeDeviceApprovalTranslation>, "ru">;

return { homeDeviceApprovalTranslations };
})();

const Domain_homeFeatureTranslations = (() => {
const en = Shared_homeFeatureTranslations.en;

const ru: typeof en = {
    teams: {
        title: 'Команды',
        description: 'Группы с общими сессиями, машинами и доступом.',
        credentialResources: {
            title: 'Учётные данные команды',
            description: 'Учётные данные, которыми команда делится со своими сессиями.',
            externalApi: {
                title: 'API учётных данных команды',
                description: 'Внешние инструменты используют учётные данные команды через API.',
            },
        },
    },
    automations: {
        title: 'Автоматизации',
        description: 'Работа агентов по расписанию и по событиям.',
    },
    workflows: {
        title: 'Рабочие процессы',
        description: 'Многошаговые конвейеры агентов.',
    },
    pets: {
        sync: {
            title: 'Синхронизация питомцев',
            description: 'Питомцы каждого человека доступны на всех его устройствах.',
        },
    },
    voice: {
        title: 'Голос',
        description: 'Говорите со своими агентами.',
        happierVoice: {
            title: 'Голос Happier',
            description: 'Голос через голосовой сервис этого Home.',
        },
    },
    connectedServices: {
        group: 'Подключённые сервисы',
        quotas: {
            title: 'Индикаторы квот',
            description: 'Показывает, сколько квоты осталось у каждого подключённого аккаунта.',
        },
        subscription: {
            title: 'Статус подписки',
            description: 'Показывает тариф и статус каждого подключённого аккаунта.',
        },
        accountGroups: {
            title: 'Группы аккаунтов',
            description: 'Объединяйте подключённые аккаунты в пулы.',
        },
        accountFallback: {
            title: 'Резервный аккаунт',
            description: 'Переключается на следующий аккаунт пула, когда один исчерпан.',
        },
        autoQuotaReset: {
            title: 'Автосброс квоты',
            description: 'Использует накопленные сбросы квоты, когда все аккаунты пула исчерпаны.',
        },
        autoDisablePlanInvalid: {
            title: 'Пропуск непригодных аккаунтов',
            description: 'Отключает аккаунты пула, которые не могут использовать выбранную модель.',
        },
        poolQuotaLimitSelection: {
            title: 'Лимиты квот пула',
            description: 'Выберите, какой квоте провайдера следует каждый пул.',
        },
    },
    updates: {
        ota: {
            title: 'Обновления по воздуху',
            description: 'Приложения ставят обновления без выпуска в магазине.',
        },
    },
    attachments: {
        uploads: {
            title: 'Вложения',
            description: 'Отправляйте файлы и изображения агентам в сессии.',
        },
    },
    sharing: {
        group: 'Общий доступ',
        session: {
            title: 'Общий доступ к сессиям',
            description: 'Поделитесь сессией с кем-то на этом Home.',
        },
        public: {
            title: 'Публичные ссылки',
            description: 'Делитесь содержимым сессии по публичной ссылке.',
        },
        contentKeys: {
            title: 'Зашифрованный общий доступ',
            description: 'Обмен ключами, чтобы общие сессии оставались со сквозным шифрованием.',
        },
        pendingQueueV2: {
            title: 'Общая очередь сообщений',
            description: 'Ставит сообщения общей сессии в очередь, пока её агент занят.',
        },
        pendingDeliveryState: {
            title: 'Отслеживание доставки очереди',
            description: 'Запоминает, какие сообщения из очереди дошли до агента.',
        },
    },
    sessions: {
        title: 'Сессии',
        description: 'Сессии и управление ими.',
        group: 'Сессии',
        handoff: {
            title: 'Передача сессии',
            description: 'Перенесите идущую сессию на другую машину.',
        },
        ephemeralRunner: {
            title: 'Временные раннеры',
            description: 'Запустите сессию на одноразовой машине.',
        },
        agentSwitching: {
            title: 'Смена агента',
            description: 'Продолжите сессию с другим агентом-программистом.',
        },
        folders: {
            title: 'Папки сессий',
            description: 'Раскладывайте сессии по папкам.',
        },
        drafts: {
            title: 'Синхронизированные черновики',
            description: 'Неотправленные сообщения и черновики сессий на каждом устройстве.',
        },
        following: {
            title: 'Подписка',
            description: 'Подпишитесь на сессию, чтобы получать её обновления и уведомления.',
        },
        conversations: {
            title: 'Беседы',
            description: 'Люди общаются и упоминают друг друга в общей сессии.',
        },
        board: {
            title: 'Доска сессий',
            description: 'Располагайте сессии и их элементы на общих досках.',
        },
        filteredListing: {
            title: 'Фильтрованный список',
            description: 'Фильтрует список сессий на этом Home до постраничной загрузки.',
        },
        usageLimitRecovery: {
            title: 'Восстановление после лимита',
            description: 'Подождать и продолжить или повторить, когда агент упирается в лимит использования.',
        },
    },
    machines: {
        title: 'Машины',
        description: 'Подключение к вашим машинам.',
        group: 'Машины',
        pools: {
            title: 'Пулы машин',
            description: 'Переключается на следующую машину, когда одна не в сети.',
        },
        transfer: {
            title: 'Передачи между машинами',
            description: 'Передача данных между машинами.',
            directPeer: {
                title: 'Прямые передачи',
                description: 'Передаёт данные напрямую между машинами.',
            },
            serverRouted: {
                title: 'Передачи через этот Home',
                description: 'Передаёт данные через этот Home, когда машины не могут соединиться напрямую.',
            },
        },
        peerMediation: {
            title: 'Соединения между машинами',
            description: 'Туннели, потоки и доступ между машинами.',
            observability: {
                title: 'Диагностика соединений',
                description: 'Показывает, как соединены туннели, потоки и превью между машинами.',
            },
        },
        tunnel: {
            title: 'Туннели между машинами',
            description: 'Открытие портов между машинами.',
            directPeer: {
                title: 'Прямые туннели',
                description: 'Открывает порты напрямую между машинами.',
            },
            serverRouted: {
                title: 'Туннели через этот Home',
                description: 'Открывает порты через этот Home, когда машины не могут соединиться напрямую.',
            },
        },
        liveStream: {
            title: 'Трансляции',
            description: 'Трансляция экрана машины.',
            directPeer: {
                title: 'Прямые трансляции',
                description: 'Транслирует экран машины прямо на ваше устройство.',
            },
            serverRouted: {
                title: 'Трансляции через этот Home',
                description: 'Транслирует экран машины через этот Home, если прямая трансляция не удалась.',
            },
        },
        rpc: {
            title: 'Вызовы машин',
            description: 'Прямая связь с машинами.',
            directPeer: {
                title: 'Прямые вызовы машин',
                description: 'Связывается с машиной напрямую, а не через этот Home.',
            },
        },
    },
    localServices: {
        title: 'Локальные сервисы',
        description: 'Смотрите и открывайте сервисы, запущенные на ваших машинах.',
        group: 'Локальные сервисы',
        inventory: {
            title: 'Список сервисов',
            description: 'Показывает порты и сервисы, работающие на каждой машине.',
        },
        managed: {
            title: 'Управляемые сервисы',
            description: 'Запускайте, называйте и отслеживайте сервисы из Happier.',
        },
        launcher: {
            title: 'Запуск сервисов',
            description: 'Предлагает сервисы для открытия и превью.',
        },
        actions: {
            title: 'Действия с сервисами',
            description: 'Копировать, открыть превью и забыть сервисы.',
            terminate: {
                title: 'Остановка сервисов',
                description: 'Останавливает процесс обнаруженного сервиса.',
            },
        },
        preview: {
            title: 'Превью сервисов',
            description: 'Приватное превью локального сервиса внутри сессии.',
        },
        publicPreview: {
            title: 'Публичные превью',
            description: 'Поделитесь превью сервиса по публичному адресу.',
        },
    },
    browser: {
        title: 'Браузер',
        description: 'Открывайте страницы, превью и размещённые представления в Happier.',
        group: 'Браузер',
        viewTargets: {
            title: 'Представления браузера',
            description: 'Открывает превью, страницы плагинов и ссылки в нужном представлении.',
        },
        internal: {
            title: 'Встроенный браузер',
            description: 'Просмотр в Happier с собственными сессиями и профилями.',
        },
        sidecar: {
            title: 'Вспомогательный браузер',
            description: 'Отдельный управляемый браузер для тяжёлой автоматизации.',
        },
        diagnostics: {
            title: 'Инструменты разработчика',
            description: 'Консоль, сеть и события devtools встроенного браузера.',
        },
        context: {
            title: 'Контекст браузера',
            description: 'Прикрепите содержимое страницы к сообщению или агенту.',
        },
        automation: {
            title: 'Автоматизация браузера',
            description: 'Агенты кликают, печатают и переходят по страницам во встроенном браузере.',
        },
        recording: {
            title: 'Записи браузера',
            description: 'Записывает сессии браузера как доказательство.',
        },
    },
    plugins: {
        title: 'Плагины не из Happier',
        description: 'Устанавливайте плагины из npm и собственных источников.',
        group: 'Плагины',
        webhooks: {
            title: 'Вебхуки плагинов',
            description: 'Плагины получают вебхуки от внешних сервисов.',
        },
        ui: {
            title: 'Экраны плагинов',
            description: 'Показывает экраны и панели, которые дают плагины.',
            hostedWeb: {
                title: 'Веб-экраны плагинов',
                description: 'Показывает экраны плагинов, сделанные для веба.',
            },
            reactNativeBundles: {
                title: 'Нативные экраны плагинов',
                description: 'Запускает доверенные экраны плагинов на React Native.',
            },
        },
    },
    devices: {
        title: 'Устройства',
        description: 'Симуляторы и подключённые устройства.',
        simulatorPreview: {
            title: 'Превью симуляторов',
            description: 'Показывает симуляторы и эмуляторы с ваших машин.',
        },
    },
    social: {
        friends: {
            title: 'Друзья',
            description: 'Добавляйте друзей и смотрите, чем они делятся.',
        },
    },
    auth: {
        group: 'Вход',
        recovery: {
            providerReset: {
                title: 'Сброс через провайдера',
                description: 'Восстановите аккаунт, войдя через его провайдера удостоверений.',
            },
        },
        login: {
            keyChallenge: {
                title: 'Вход по ключу',
                description: 'Войдите, подтвердив ключ устройства.',
            },
        },
        mtls: {
            title: 'Клиентские сертификаты',
            description: 'Вход по клиентскому сертификату (mTLS).',
        },
        ui: {
            recoveryKeyReminder: {
                title: 'Напоминание о ключе восстановления',
                description: 'Напоминает сохранить ключ восстановления.',
            },
        },
        pairing: {
            desktopQrMobileScan: {
                title: 'Вход по сканированию',
                description: 'Войдите на телефоне, отсканировав код на компьютере.',
            },
            boundQrV2: {
                title: 'Более безопасные коды сопряжения',
                description: 'Коды сопряжения, которые работают только для этого Home и направления.',
            },
        },
    },
    encryption: {
        group: 'Шифрование',
        plaintextStorage: {
            title: 'Хранение без шифрования',
            description: 'Хранит сессии без сквозного шифрования.',
        },
        accountOptOut: {
            title: 'Отказ от шифрования',
            description: 'Каждый может отключить сквозное шифрование.',
        },
    },
    remoteHosts: {
        group: 'Удалённые хосты',
        management: {
            title: 'Удалённые хосты',
            description: 'Сохраняйте SSH-хосты для запуска сессий.',
        },
        secretMaterial: {
            title: 'Сохранённые секреты хостов',
            description: 'Сохраняйте пароли и ключи SSH-хостов.',
        },
    },
    e2ee: {
        keylessAccounts: {
            title: 'Аккаунты без ключей',
            description: 'Аккаунты без ключей сквозного шифрования.',
        },
    },
    bugReports: {
        title: 'Отчёты об ошибках',
        description: 'Отправляйте отчёты об ошибках с диагностикой.',
    },
    terminal: {
        group: 'Терминал',
        embeddedPty: {
            title: 'Терминал',
            description: 'Откройте терминал на машине прямо в Happier.',
        },
        transport: {
            byteStream: {
                title: 'Потоковый терминал',
                description: 'Более быстрое соединение для встроенного терминала.',
            },
        },
    },
    search: {
        title: 'Поиск',
        description: 'Поиск по сессиям и расшифровкам.',
    },
    providers: {
        title: 'Провайдеры моделей',
        description: 'Подключайте провайдеров моделей и выбирайте модели для агентов.',
        group: 'Провайдеры моделей',
        localDiscovery: {
            title: 'Поиск локальных провайдеров',
            description: 'Находит серверы моделей на ваших машинах.',
        },
        localModelManagement: {
            title: 'Управление локальными моделями',
            description: 'Скачивайте локальные модели и управляйте ими.',
        },
    },
    keys: {
        HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: {
            title: 'Адрес сервиса отчётов',
            description: 'Куда отправляются отчёты об ошибках. Если поле пустое, сервис отчётов не предлагается.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__DEFAULT_INCLUDE_DIAGNOSTICS: {
            title: 'Диагностика по умолчанию',
            description: 'Форма отчёта включает диагностику, если автор отчёта не откажется.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__MAX_ARTIFACT_BYTES: {
            title: 'Самое большое вложение',
            description: 'Самый большой файл, который можно приложить к отчёту об ошибке, в байтах.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__UPLOAD_TIMEOUT_MS: {
            title: 'Лимит времени загрузки',
            description: 'Сколько может длиться загрузка отчёта об ошибке, в миллисекундах.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__ACCEPTED_ARTIFACT_KINDS: {
            title: 'Допустимые типы вложений',
            description: 'Типы вложений, которые принимают отчёты об ошибках. Пустое значение принимает обычные типы.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__CONTEXT_WINDOW_MS: {
            title: 'Окно контекста',
            description: 'Насколько далеко в прошлое отчёт об ошибке собирает контекст, в миллисекундах.',
        },
        HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: {
            title: 'Голос по подписке',
            description: 'Голосом могут пользоваться только подписчики. Если не задано, в продакшене это требуется, а в других конфигурациях нет.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_MANIFEST_BYTES: {
            title: 'Самый большой манифест питомца',
            description: 'Самый большой принимаемый манифест питомца, в байтах.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_SPRITESHEET_BYTES: {
            title: 'Самый большой спрайт-лист питомца',
            description: 'Самый большой принимаемый спрайт-лист питомца, в байтах.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_PACKAGE_BYTES: {
            title: 'Самый большой пакет питомца',
            description: 'Самый большой принимаемый пакет питомца, в байтах.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PETS_PER_ACCOUNT: {
            title: 'Импортированные питомцы на человека',
            description: 'Максимум импортированных питомцев, которых может хранить один человек.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PET_BYTES_PER_ACCOUNT: {
            title: 'Хранилище импортированных питомцев на человека',
            description: 'Максимум байтов импортированных питомцев, которые может хранить один человек.',
        },
        HAPPIER_FEATURE_PETS_SYNC__ENCRYPTED_CUSTOM_PET_SYNC_POLICY: {
            title: 'Зашифрованные собственные питомцы',
            description: 'Зарезервировано на будущее. Зашифрованные собственные питомцы пока не синхронизируются, поэтому параметр остаётся выключенным.',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES: {
            title: 'Самая большая передача через этот Home',
            description: 'Самый большой файл, который передаётся через этот Home, в байтах.',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_ACTIVE_TRANSFERS_PER_SOCKET: {
            title: 'Одновременные передачи на соединение',
            description: 'Максимум передач через этот Home, которые одно соединение ведёт одновременно.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES: {
            title: 'Данные на туннель',
            description: 'Максимум байтов, которые передаёт один туннель через этот Home.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_ACTIVE_TUNNELS_PER_SOCKET: {
            title: 'Туннели на соединение',
            description: 'Максимум туннелей через этот Home, которые одно соединение держит открытыми.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: 'Самый большой кадр туннеля',
            description: 'Самый большой кадр, который передаёт туннель через этот Home, в байтах.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__SUPPORTED_ENCODINGS: {
            title: 'Кодировки туннелей',
            description: 'Кодировки кадров, которые принимают туннели через этот Home. Пустое значение использует стандартные.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__PREFERRED_ENCODING: {
            title: 'Предпочтительная кодировка туннеля',
            description: 'Кодировка кадров, используемая в первую очередь. Она должна быть одной из допустимых кодировок.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BINARY_HEADER_BYTES: {
            title: 'Самый большой заголовок кадра',
            description: 'Самый большой двоичный заголовок кадра, в байтах.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_RAW_PAYLOAD_BYTES: {
            title: 'Самая большая полезная нагрузка кадра',
            description: 'Самая большая необработанная полезная нагрузка в одном кадре, в байтах.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAMED_MESSAGE_BYTES: {
            title: 'Самое большое сообщение в кадрах',
            description: 'Самое большое сообщение, разбитое на кадры, в байтах.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_CONCURRENT_SUBSTREAMS: {
            title: 'Одновременные потоки на туннель',
            description: 'Максимум потоков, которые один туннель ведёт одновременно.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_TOTAL_SUBSTREAMS: {
            title: 'Потоки на туннель',
            description: 'Максимум потоков, которые один туннель открывает за всё время работы.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES_PER_SUBSTREAM: {
            title: 'Данные на поток',
            description: 'Максимум байтов, которые передаёт один поток.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_AGGREGATE_BYTES: {
            title: 'Данные на туннель по всем потокам',
            description: 'Максимум байтов, которые передают вместе все потоки одного туннеля.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SUBSTREAM_IDLE_MS: {
            title: 'Лимит простоя потока',
            description: 'Сколько поток может простаивать до закрытия, в миллисекундах.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SESSION_IDLE_MS: {
            title: 'Лимит простоя туннеля',
            description: 'Сколько туннель через этот Home может простаивать до закрытия, в миллисекундах.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_IDLE_MS: {
            title: 'Лимит бездействия туннеля',
            description: 'Сколько туннель может простаивать до закрытия, в миллисекундах.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_DURATION_MS: {
            title: 'Самый долгий туннель',
            description: 'Максимальное время, в течение которого туннель остаётся открытым, в миллисекундах.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: {
            title: 'Порты, доступные туннелям',
            description: 'Порты, которые могут открывать туннели. Пустое значение разрешает только порты по умолчанию.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__TOKEN_TTL_MS: {
            title: 'Срок действия ссылки на превью',
            description: 'Сколько работает приватная ссылка на превью, в миллисекундах.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: {
            title: 'Домен превью',
            description: 'Домен, который отдаёт каждое превью по собственному адресу. Пустое значение отдаёт превью по адресу этого Home.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: {
            title: 'Режимы публичного превью',
            description: 'Способы сделать превью публичным.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: {
            title: 'Самое долгое публичное превью',
            description: 'Максимальное время, в течение которого превью остаётся публичным, в миллисекундах. Пустое значение сохраняет стандартный лимит.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_CONCURRENT_EXPOSURES: {
            title: 'Одновременные публичные превью',
            description: 'Максимум публичных превью одновременно. Пустое значение сохраняет стандартный лимит.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: {
            title: 'Требовать DNS и TLS',
            description: 'Публичным превью нужны DNS и TLS.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_SINK: {
            title: 'Журнал аудита публичных превью',
            description: 'Куда записываются публичные превью. Публичным превью он обязателен.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_LOG_PATH: {
            title: 'Файл журнала аудита',
            description: 'Файл, в который пишется журнал аудита публичных превью.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: {
            title: 'Разрешить тестовый журнал аудита',
            description: 'Только для разработки: принимать тестовый журнал аудита в памяти. В продакшене игнорируется.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: {
            title: 'Лимиты запросов публичных превью',
            description: 'Профили лимитов запросов, которые могут использовать публичные превью.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER: {
            title: 'Проверка лимита запросов',
            description: 'Как ограничивается частота запросов к публичным превью. Публичным превью она обязательна.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS: {
            title: 'Запросы за окно',
            description: 'Сколько запросов публичное превью разрешает в каждом окне.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS: {
            title: 'Окно лимита запросов',
            description: 'Длительность каждого окна лимита запросов, в миллисекундах.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: {
            title: 'Разрешить тестовый ограничитель запросов',
            description: 'Только для разработки: принимать тестовый ограничитель запросов в памяти. В продакшене игнорируется.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_REQUESTS: {
            title: 'Вебхуки в обработке',
            description: 'Максимум запросов вебхуков, которые этот сервер обрабатывает одновременно.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_WORKING_BYTES: {
            title: 'Память для вебхуков',
            description: 'Максимум памяти для запросов вебхуков в обработке, в байтах. Пустое значение разрешает столько, сколько уже допускает лимит запросов.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_RATE_PER_MINUTE: {
            title: 'Вебхуки в минуту на маршрут',
            description: 'Запросы вебхуков в минуту на одном маршруте.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_CONCURRENCY: {
            title: 'Одновременные вебхуки на маршрут',
            description: 'Запросы вебхуков в обработке на одном маршруте.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_RATE_PER_MINUTE: {
            title: 'Вебхуки в минуту на эндпоинт',
            description: 'Запросы вебхуков в минуту на одном эндпоинте.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_CONCURRENCY: {
            title: 'Одновременные вебхуки на эндпоинт',
            description: 'Запросы вебхуков в обработке на одном эндпоинте.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_RATE_PER_MINUTE: {
            title: 'Вебхуки в минуту на человека',
            description: 'Запросы вебхуков в минуту для одного человека.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_CONCURRENCY: {
            title: 'Одновременные вебхуки на человека',
            description: 'Запросы вебхуков в обработке для одного человека.',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES: {
            title: 'Самый большой пакет экрана плагина',
            description: 'Самый большой пакет экрана плагина, который размещает этот Home, в байтах.',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES: {
            title: 'Хранилище экранов плагинов на человека',
            description: 'Максимум байтов пакетов экранов плагинов, которые может хранить один человек.',
        },
        HAPPIER_COLLECTION_MAX_ROW_ENCODED_BYTES: {
            title: 'Самая большая строка данных плагина',
            description: 'Самая большая строка, которую сохраняет плагин, в байтах.',
        },
        HAPPIER_COLLECTION_MAX_BATCH_BYTES: {
            title: 'Самая большая партия данных плагинов',
            description: 'Самая большая партия изменений данных плагинов, в байтах.',
        },
        HAPPIER_COLLECTION_MAX_BATCH_ROWS: {
            title: 'Строки в партии данных плагинов',
            description: 'Максимум строк в одной партии изменений данных плагинов.',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: {
            title: 'Строки данных плагинов на человека',
            description: 'Максимум строк данных плагинов, которые может хранить один человек.',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_BYTES: {
            title: 'Хранилище данных плагинов на человека',
            description: 'Максимум байтов данных плагинов, которые может хранить один человек.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_BITRATE_BPS: {
            title: 'Максимальный битрейт трансляции',
            description: 'Максимальный битрейт трансляции через этот Home, в битах в секунду.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAMES_PER_SECOND: {
            title: 'Максимальная частота кадров трансляции',
            description: 'Максимальная частота кадров трансляции через этот Home.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: 'Самый большой кадр трансляции',
            description: 'Самый большой кадр трансляции через этот Home, в байтах.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_DURATION_MS: {
            title: 'Самая долгая трансляция',
            description: 'Максимальная длительность трансляции через этот Home, в миллисекундах.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_TOTAL_BYTES: {
            title: 'Данные на трансляцию',
            description: 'Максимум байтов, которые передаёт одна трансляция через этот Home.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_ACCOUNT: {
            title: 'Одновременные трансляции на человека',
            description: 'Максимум трансляций через этот Home, которые один человек ведёт одновременно.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_SOCKET: {
            title: 'Одновременные трансляции на соединение',
            description: 'Максимум трансляций через этот Home, которые одно соединение ведёт одновременно.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_MACHINE: {
            title: 'Одновременные трансляции на машину',
            description: 'Максимум трансляций через этот Home, которые одна машина ведёт одновременно.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: {
            title: 'ID ключа подписи соединений',
            description: 'Указывает ключ, который подписывает соединения между машинами. Без ключа подписи эти соединения выключены.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: {
            title: 'Закрытый ключ подписи соединений',
            description: 'Закрытый ключ, который подписывает соединения между машинами.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: {
            title: 'Открытый ключ подписи соединений',
            description: 'Открытый ключ, соответствующий ключу подписи. Если поле пустое, он выводится из закрытого ключа.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: {
            title: 'Срок действия ключа подписи',
            description: 'Когда истекает ключ подписи, в виде метки времени в миллисекундах.',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: {
            title: 'Поиск друзей по имени пользователя',
            description: 'Друзей можно найти по имени пользователя, а не только по привязанному аккаунту.',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__IDENTITY_PROVIDER: {
            title: 'Провайдер сопоставления друзей',
            description: 'Провайдер входа, по которому сопоставляются друзья.',
        },
    },
};

const homeFeatureTranslations = { ru } as const;

return { homeFeatureTranslations };
})();

const Domain_homeGovernanceTranslations = (() => {
const en = Shared_homeGovernanceTranslations.en;

const ru: typeof en = {
    title: 'Администрирование Home',
    pages: {
        features: 'Что предлагает этот Home. Изменение действует везде после следующего обновления.',
        data: 'Что хранит этот Home и как долго.',
        homes: 'Аккаунты, роли, команды и правила входа для каждого Home, которым вы управляете.',
        overview: 'Кто управляет этим Home и что вы можете здесь изменить.',
        people: 'Аккаунты на этом Home, их роли и могут ли они входить.',
        policies: 'Кто может входить, кто может создавать аккаунты и команды и как защищены данные.',
        teams: 'Все команды на этом Home. Управление командой не даёт доступа к её сессиям.',
        identityProvider: 'Служба удостоверений для входа на этот Home.',
        identityProviderEditor: 'Как подключается эта служба удостоверений и кого она допускает.',
        githubApp: 'GitHub App, через которое этот Home получает доступ к репозиториям.',
        githubAppEditor: 'Зарегистрируйте или измените GitHub App для этого Home.',
        email: 'Как этот Home отправляет почту.',
        reach: 'Как устройства, ссылки-приглашения и письма находят этот Home.',
        runtime: 'Сервер, на котором работает этот Home.',
        activity: 'Кто что изменил в этом Home и когда.',
    },
    overview: 'Обзор',
    people: 'Люди',
    teams: 'Команды',
    policies: 'Политики',
    console: {
        serverSettings: 'Настройки сервера',
        serverSettingsDescription: 'Все настройки, которые читает сервер, и когда изменение вступает в силу.',
        allHomes: 'Все Home',
        backToHomes: 'Назад к Home',
        viewerOwner: 'Вы владелец',
        viewerAdmin: 'Вы администратор',
        noOwnerYet: 'Владельца пока нет',
        administer: 'Управление',
        navigation: 'Страницы администрирования Home',
    },
    /** The console Overview (lab `hcOverview-A`): what needs the owner, who owns the Home, and its facts. */
    overviewPage: {
        description: 'Кто управляет этим Home и что требует вашего внимания.',
        attention: 'Требует внимания',
        emailNotSetUpTitle: 'Почта не настроена',
        emailNotSetUpBody: 'Никто не может подтвердить адрес, сбросить пароль или получить приглашение по почте.',
        emailNoLinkTitle: 'Письма пока не могут содержать ссылки',
        emailNoLinkBody: 'Отправка настроена, но у этого Home нет адреса веб-приложения для ссылок.',
        emailPasswordTitle: 'Пароль почты не читается',
        emailPasswordBody: 'Введите пароль SMTP ещё раз, чтобы этот Home мог отправлять письма.',
        setUpEmail: 'Настроить почту',
        openEmail: 'Открыть «Почта»',
        noAddressTitle: 'Нет публичного адреса',
        noAddressBody: 'Устройства из других сетей и ссылки-приглашения не доходят до этого Home.',
        setUpReach: 'Настроить',
        pendingBody: 'Сохранено и ждёт перезапуска сервера.',
        fixedBody: 'Заданы в окружении сервера; меняйте их там.',
        review: 'Посмотреть',
        settingsFailed: 'Не удалось проверить настройки этого Home',
        emailFailed: 'Не удалось прочитать состояние почты этого Home',
        reachFailed: 'Не удалось прочитать, как доступен этот Home',
        ownership: 'Владельцы',
        ownerYou: 'Владелец · вы',
        peopleFailed: 'Не удалось прочитать людей этого Home',
        thisHome: 'Этот Home',
        version: 'Версия',
        signIn: 'Вход',
        signInOpen: 'любой может создать аккаунт',
        signInInvited: 'только по приглашению',
        signInNone: 'Ни один способ входа не включён',
        fixedTitle: ({ count }: { count: number }) => (count === 1 ? '1 настройка задана развёртыванием' : `Настройки, заданные развёртыванием: ${count}`),
        /** People · owners · admins; `more` while the Home has further pages, `admins` null when unknown. */
        peopleSummary: ({ people, more, owners, admins }: { people: number; more: boolean; owners: number; admins: number | null }) => [`Люди: ${people}${more ? '+' : ''}`, `Владельцы: ${owners}`, admins === null ? null : `Админы: ${admins}`].filter((part) => part !== null).join(' · '),
    },
    /** "Invite people" on Overview, People and Teams: one dialog over the Team invitation form. */
    invite: {
        action: 'Пригласить людей',
        description: 'В этот Home вступают, вступая в одну из его команд.',
        team: 'Команда',
        noTeams: 'Пока нет команды, в которую вы можете пригласить',
        noTeamsBody: 'В Home вступают через команду. Сначала создайте её.',
        notAdministered: 'Вы не можете приглашать в команды этого Home',
        notAdministeredBody: 'В команду приглашают её владельцы и админы. Попросите одного из них или создайте свою команду.',
        createTeam: 'Создать команду',
        notAdministeredAskBody: 'В команду приглашают её владельцы и админы; попросите одного из них.',
        joinByTeam: 'В Home вступают через команду.',
        teamsFailed: 'Не удалось прочитать команды этого Home',
    },

    yourRole: 'Ваша роль',
    roleOwner: 'Владелец',
    roleAdmin: 'Администратор',
    roleMember: 'Участник',
    activeOwners: 'Активные владельцы',
    accountSection: 'Аккаунт',
    accountAccessSection: 'Доступ',
    homeAddress: 'Адрес Home',

    setupRequiredTitle: 'Требуется настройка администрирования',
    setupRequiredBody: 'У этого Home пока нет активного владельца. Первого владельца назначает тот, у кого есть доступ к серверу, прямо на машине, где он работает.',

    manageTeams: 'Управление командами',
    manageTeamsSubtitle: 'Администрируйте команды этого Home. Это не даёт доступа к их сессиям.',
    teamsDisabled: 'Команды не включены в этом Home.',
    teamsEmpty: 'В этом Home пока нет команд.',

    loading: 'Загрузка этого Home…',
    refreshing: 'Обновление…',
    updating: 'Обновление…',
    staleNotice: 'Показано последнее известное состояние этого Home. Изменения недоступны, пока он снова не ответит.',
    offlineNotice: 'Этот Home не отвечает. Читать можно, вносить изменения — нет.',
    unavailableTitle: 'Этот Home недоступен',
    unavailableBody: 'Happier не смог прочитать состояние администрирования этого Home.',
    forbiddenTitle: 'Вы не можете администрировать этот Home',
    forbiddenBody: 'У вашей учётной записи нет прав администрирования здесь.',
    retry: 'Повторить',
    loadMore: 'Показать ещё',
    unsupportedBody: 'Этот Home не предоставляет администрирование. Возможно, на нём более старая версия.',
    notObservedTitle: 'Ещё не загружено',
    notObservedBody: 'Этот Home ещё не сообщил своё состояние администрирования этому устройству.',
    lastUpdated: ({ time }: { time: string }) => `Обновлено ${time}`,

    chooseHome: 'Выберите Home',
    chooseHomeFooter: 'У каждого Home свои аккаунты, роли и политики.',
    homesEmpty: 'Пока нет ни одного Home',
    homesEmptyBody: 'Добавьте Home на это устройство, чтобы управлять им здесь.',
    homesNoneAdministrable: 'Нет Home для администрирования',
    homesNoneAdministrableBody: 'Ни один из показанных Home не даёт этому аккаунту прав администрирования.',
    homeNotAnswering: ({ home }: { home: string }) => `${home} не отвечает`,
    signedOutTitle: 'Выполнен выход из этого Home',
    signedOutBody: 'Войдите в этот Home снова, чтобы управлять им.',
    credentialUnreadableTitle: 'Не удалось прочитать сохранённый вход на этом устройстве',
    credentialUnreadableBody: 'Проблема на этом устройстве, а не в Home, и вы не вышли из аккаунта. Попробуйте ещё раз.',
    credentialUnreadableInviteBody: 'Проблема на этом устройстве, а не в Home. Ваша ссылка-приглашение по-прежнему действует, поэтому можно повторить попытку сейчас или вернуться к ней позже.',

    peopleEmpty: 'В этом Home пока нет учётных записей.',
    rosterUnavailableTitle: 'Список людей пока недоступен',
    rosterUnavailableBody: 'Этот Home ещё не предоставляет Happier список учётных записей. Роли и состояние появятся здесь позже.',
    accountUnavailableBody: 'Эта учётная запись пока недоступна из этого Home.',
    searchPlaceholder: 'Поиск учётных записей',
    searchResults: 'Результаты поиска',
    searchResultsFooter: 'Откройте учётную запись, чтобы увидеть её роль и состояние.',
    searchEmpty: 'Нет учётных записей, подходящих под этот запрос.',
    searchUnsupported: 'Поиск недоступен в этом Home',
    searchUnsupportedBody: 'Этот Home не предоставляет поиск учётных записей. Возможно, на нём более старая версия.',
    searchFailed: 'Не удалось выполнить поиск',
    searchFailedBody: 'Этот Home не ответил на поиск. Измените текст, чтобы попробовать снова.',

    statusActive: 'Активна',
    statusDisabled: 'Отключена',
    statusRetired: 'Выведена из обращения',
    statusDisabledDetail: 'Выполнен выход везде. Можно включить снова.',
    statusRetiredDetail: 'Доступ отозван навсегда.',

    changeRole: 'Изменить роль',
    disable: 'Отключить учётную запись',
    enable: 'Включить учётную запись снова',
    deleteAccount: 'Удалить учётную запись и данные…',
    retryDeletion: 'Повторить удаление',

    reasonLastActiveOwner: 'Этому Home нужен хотя бы один активный владелец. Сначала назначьте владельцем другую учётную запись.',
    reasonTargetInactive: 'Только активная учётная запись может иметь роль в Home.',
    reasonHomeUnreachable: 'Этот Home не отвечает. Изменения станут доступны после переподключения.',

    roleSheetTitle: 'Роль в Home',
    roleOwnerDescription: 'Может администрировать всё в этом Home, включая удаление учётных записей.',
    roleAdminDescription: 'Может администрировать учётные записи и команды, но не менять владельцев.',
    roleMemberDescription: 'Нет прав администрирования Home.',

    disableTitle: ({ account }: { account: string }) => `Отключить ${account}?`,
    disableBody: 'Выход будет выполнен на всех устройствах, а машины отключатся. Персональные токены доступа отзываются навсегда, ответственность за сессии снимается, а в каждой сессии, доступ к которой теряется, неотправленные черновики удаляются и отслеживание отключается. Повторное включение вернёт доступ, но не эти черновики, отслеживание или ответственность. Членство в командах и ключи шифрования сохранятся.',
    disableConfirm: 'Отключить',
    enableTitle: ({ account }: { account: string }) => `Включить ${account} снова?`,
    enableBody: 'Человек снова сможет войти на своих устройствах. Ранее отозванные токены доступа остаются отозванными.',
    enableConfirm: 'Включить снова',
    deleteTitle: ({ account }: { account: string }) => `Удалить ${account} и все данные?`,
    deleteBody: ({ home }: { home: string }) => `Это навсегда удалит учётную запись и её данные на ${home}. Отменить нельзя. Владение Home или командой нужно передать заранее.`,
    deleteConfirm: 'Удалить',

    deleteIncompleteTitle: 'Удаление не завершено',
    deleteIncompleteBody: 'Доступ отозван, и эта учётная запись выведена из обращения, но очистка не завершилась. Повторите удаление, чтобы закончить.',
    deleteIncompleteMemberBody: 'Доступ отозван, но очистка не завершилась. Завершить её может владелец Home или оператор сервера.',

    errorForbidden: 'У вас больше нет прав на это изменение в этом Home.',
    errorOwnerTransferRequired: 'Этому Home нужен хотя бы один активный владелец. Сначала назначьте владельцем другую учётную запись.',
    errorTeamOwnerTransferRequired: 'Команде всё ещё нужна эта учётная запись как владелец. Сначала назначьте этой команде другого владельца.',
    errorAccountNotFound: 'Этой учётной записи больше нет в этом Home.',
    errorAccountInactive: 'Эта учётная запись неактивна и не может получить эти права.',
    errorErasureTransitionCleanupPending: 'Удаление учётной записи ожидает завершения очистки данных шифрования. Попробуйте удалить учётную запись ещё раз.',
    errorGeneric: 'Этот Home не смог применить изменение. Ничего не изменено.',
    errorConflict: 'Здесь раньше изменили что-то другое. Обновите этот Home и повторите попытку.',
    changeFailedTitle: 'Изменение не выполнено',
    errorOutcomeUnknownTitle: 'Это изменение не подтверждено',
    errorOutcomeUnknown: 'Запрос дошёл до этого Home, но ответ был потерян. Изменение могло примениться. Обновите этот Home и проверьте, прежде чем повторять.',

    teamCreation: 'Создание команд',
    teamCreationSelfService: 'Команды может создавать любой',
    teamCreationSelfServiceDescription: 'Активные участники этого Home могут создать команду и стать её владельцем.',
    teamCreationManagedOnly: 'Команды создают администраторы',
    teamCreationManagedOnlyDescription: 'Владельцы и администраторы создают команды и выбирают первого владельца.',
    teamCreationDisabled: 'Создание команд отключено',
    teamCreationDisabledDescription: 'Новые команды не создаются. Существующие не меняются.',
    teamsVisibility: 'Кто видит команды',
    teamsVisibleToMembers: 'Показывать команды участникам',
    teamsVisibleToMembersDescription: 'Если выключено, команды видят только участники команд и администраторы.',
    teamJit: 'Автоматическое членство в команде при входе',
    teamJitDescription: 'Вход через подключённого поставщика удостоверений команды автоматически добавляет в эту команду — без приглашения и одобрения.',
    githubEnterpriseOrigins: 'Разрешённые хосты GitHub Enterprise',
    githubEnterpriseOriginsDescription: 'Один канонический HTTPS-источник в строке. Команды могут подключать GitHub Apps только к этим хостам.',
    githubEnterpriseOriginsInvalid: 'Укажите уникальные HTTPS-источники без путей, запросов, учётных данных и фрагментов.',

    signInTitle: 'Вход и приём',
    authActionLogin: 'Вход',
    authActionProvision: 'Новые учётные записи',
    authActionConnect: 'Связывание учётных записей',
    authReasonMethodNotEnabled: 'Способ входа отключён',
    authReasonProvisioningNotEnabled: 'Создание учётных записей отключено',
    authReasonAccountModeUnavailable: 'Тип учётной записи недоступен',
    authReasonEmailDeliveryUnavailable: 'Отправка электронной почты недоступна',
    authInherited: 'Используются настройки сервера',
    authInheritedDescription: 'Этот Home не ограничивает способы входа и типы учётных записей.',
    authNarrowed: 'Ограничено этим Home',
    authUnreadable: 'Конфигурация требует внимания',
    authUnreadableDescription: 'В этом Home сохранена конфигурация входа, которую эта версия сервера не может прочитать. Вход недоступен, пока оператор не исправит конфигурацию.',
    signInMethods: 'Способы входа',
    accountModes: 'Типы учётных записей',
    accountModePlain: 'Обычная',
    accountModeE2ee: 'Со сквозным шифрованием',
    recommendedMode: 'Рекомендуется для новых записей',
    recommendedModeDescription: 'Задаёт режим по умолчанию для новых учётных записей. Существующие записи не изменяются.',
    admissionSelfService: 'Все',
    admissionInvitationOnly: 'Только по приглашению',
    admissionClosed: 'Никто',

    deploymentServices: 'Сервисы развёртывания',
    deploymentServicesDescription: 'Сервисы идентификации, которые оператор настраивает для этого сервера. Их нельзя изменить в администрировании Home.',
    deploymentWorkosConfigured: 'Настроено',
    deploymentWorkosPartial: 'Настройка не завершена',
    deploymentWorkosNotConfigured: 'Не настроено',
    privateEndpoints: 'Частные точки идентификации',
    privateEndpointsDescription: 'Разрешить управляемому входу обращаться к провайдерам идентификации в частных сетях. Доступны только перечисленные здесь хосты, сети и порты.',
    privateEndpointsPublicOnly: 'Только публичные точки',
    privateEndpointsAllowlist: 'Частный список разрешений',
    privateEndpointsHostnames: 'Разрешённые хосты',
    privateEndpointsCidrs: 'Разрешённые сети (CIDR)',
    privateEndpointsPorts: 'Разрешённые порты',
    privateEndpointsSave: 'Сохранить сетевую политику',
    privateEndpointsInvalid: 'Укажите хотя бы один хост или сеть и порт от 1 до 65535.',
    privateEndpointsUnreadable: 'Этот Home хранит сетевую политику, которую эта версия сервера не может прочитать. Управляемый вход остаётся на публичных точках.',

    policyReadOnly: 'Изменить это может только владелец Home.',
    policyEditingUnavailable: 'Менять политики с этого устройства пока нельзя.',
    revisionConflictTitle: 'Эта политика изменилась в другом месте',
    revisionConflictBody: 'Кто-то сохранил изменение, пока вы редактировали. Ваш выбор сохранён — перезагрузите этот Home и примените его снова.',
    reload: 'Перезагрузить',
    person: {
        you: 'вы',
        roleDescription: 'Участники пользуются Home; администраторы также управляют людьми и Teams.',
        roleChangeTitle: ({ account, role }: { account: string; role: string }) => `Назначить ${account} роль «${role}»?`,
        roleChangeBody: 'Доступ к этому Home изменится сразу. Это будет записано в журнале действий с вашим именем.',
        roleChangeConfirm: 'Изменить роль',
        signIn: 'Вход',
        signInDescription: 'С помощью чего человек может входить. Он управляет этим в своём аккаунте.',
        methods: 'Способы',
        linkedProviders: 'Связанные провайдеры',
        none: 'Нет',
        teams: 'Teams',
        noTeams: 'Не состоит ни в одном Team',
        teamArchived: 'архивный Team',
        teamSuspended: 'приостановлено',
        access: 'Доступ',
        accessDescription: 'Выполнен вход на его устройствах — сеансы не отслеживаются по отдельности.',
        machines: 'Машины',
        apiTokens: 'API-токены',
        apiTokensLastUsed: ({ time }: { time: string }) => `Последнее использование: ${time}`,
        apiTokensNeverUsed: 'Не использовались',
        signOutEverywhere: 'Выйти везде',
        signOutEverywhereDescription: 'Завершает все сеансы на всех его устройствах. API-токены продолжают работать, пока аккаунт не отключён.',
        signOutEverywhereTitle: ({ account }: { account: string }) => `Выполнить выход ${account} везде?`,
        signOutEverywhereBody: 'На каждом устройстве, где выполнен вход, потребуется войти снова. API-токены продолжают работать, пока вы не отключите аккаунт. Это будет записано в журнале действий с вашим именем.',
        signOutEverywhereDone: 'Выход выполнен везде',
        recentActivity: 'Недавние действия',
        noRecentActivity: 'Пока нет административных изменений по этому человеку.',
        showAllActivity: 'Показать все',
        disableOrDelete: 'Отключить или удалить',
        dangerFootnote: 'Отключение завершает его сеансы и останавливает API-токены; это можно отменить. Удаление навсегда убирает его аккаунт и данные с этого Home.',
    },
    email: {
        title: 'Почта',
        status: 'Состояние',
        sendingMail: 'Отправка почты',
        sendingReady: ({ host }: { host: string }) => `Готово · отправляет через ${host}`,
        sendingNotSetUp: 'Не настроено',
        links: 'Ссылки в письмах',
        linksReady: 'Открываются в веб-приложении этого Home',
        linksOpenAt: ({ host }: { host: string }) => `Открываются на ${host}`,
        setInReach: 'Задать в разделе «Доступ»',
        linksMissing: 'Нет адреса веб-приложения, поэтому ссылки создать нельзя',
        mailServer: 'Почтовый сервер',
        mailServerDescription: 'SMTP-сервер, который отправляет письма для подтверждения, сброса пароля и приглашений.',
        server: 'Сервер',
        port: 'Порт',
        portAndSecurity: 'Порт и защита',
        security: 'Защита соединения',
        tls: 'TLS',
        starttls: 'STARTTLS',
        username: 'Имя пользователя',
        password: 'Пароль',
        passwordDescription: 'Хранится на сервере в зашифрованном виде. Больше никогда не показывается.',
        saved: 'Сохранён',
        replace: 'Заменить',
        clear: 'Удалить',
        keep: 'Оставить',
        clearPending: 'Сохранённый пароль будет удалён при сохранении.',
        valueSet: 'Задан',
        valueNotSet: 'Не задан',
        sender: 'Отправитель',
        fromAddress: 'Адрес отправителя',
        fromName: 'Имя отправителя',
        test: 'Отправить тестовое письмо',
        testDescription: 'Отправляет короткое сообщение без ссылок.',
        testTo: 'Кому',
        testToPlaceholder: 'Любой адрес, который вы можете проверить',
        testSend: 'Отправить',
        testSaveFirst: 'Сохраните изменения перед отправкой теста.',
        testSent: ({ to }: { to: string }) => `Отправлено на ${to}`,
        testSentDetail: 'Проверьте входящие, а если письма там нет — папку «Спам».',
        testFailed: 'Не удалось отправить',
        testNotConfigured: 'Почта ещё не настроена.',
        testPasswordUnreadable: 'Сохранённый пароль не удаётся прочитать. Введите его снова.',
        testRenderFailed: 'Не удалось подготовить тестовое сообщение.',
        testTransportFailed: 'Почтовый сервер недоступен или отклонил сообщение.',
        adminTitle: 'Только владельцы могут менять настройки почты',
        adminBody: 'Вы видите их, потому что вы администратор этого Home.',
        notSetUpTitle: 'Почта не настроена',
        notSetUpBody: 'Сброс паролей, подтверждение почты и приглашения по почте отключены, пока она не настроена.',
        unreadableTitle: 'Сохранённый пароль не удаётся прочитать',
        unreadableBody: 'Главный секрет сервера изменился с момента сохранения. Введите пароль снова.',
        invalidValue: 'Введите допустимое значение.',
        invalidPort: 'Укажите порт от 1 до 65535.',
        invalidEmail: 'Введите адрес электронной почты.',
        conflictTitle: 'Настройки почты изменены в другом месте',
        conflictBody: 'Кто-то сохранил изменение, пока вы редактировали. Ваши правки сохранены: проверьте их и сохраните снова.',
        loadFailed: 'Этот Home не вернул настройки почты.',
    },
    signInProviders: {
        title: 'Провайдеры входа',
        description: 'Корпоративный вход, GitHub Apps и правила для Teams. Включить провайдер для входа можно в разделе «Политики».',
        ownersOnlyTitle: 'Только владельцы могут менять провайдеров входа',
        ownersOnlyBody: 'Попросите владельца этого Home добавить или изменить провайдеров удостоверений и GitHub Apps.',
        fromDeployment: ({ key }: { key: string }) => `Из вашего развёртывания · ${key} · только чтение`,
        workosSetByDeployment: ({ keys }: { keys: string }) => `Задано вашим развёртыванием (${keys})`,
        workosSetInServerSettings: ({ keys }: { keys: string }) => `Задано в настройках сервера (${keys})`,
        privateEndpointsFixed: ({ key }: { key: string }) => `Зафиксировано вашим развёртыванием · ${key}`,
        privateEndpointsOff: ({ key }: { key: string }) => `Выключено для этого Home · ${key}`,
        teamRules: 'Правила входа для Teams',
        teamRulesDescription: 'Что Teams могут добавить к провайдерам Home.',
        activity: {
            addedProvider: ({ name }: { name: string }) => `добавил(а) провайдера удостоверений ${name}`,
            changedProvider: ({ name }: { name: string }) => `изменил(а) провайдера удостоверений ${name}`,
            replacedProviderSecret: ({ name }: { name: string }) => `заменил(а) секрет клиента ${name}`,
            enabledProvider: ({ name }: { name: string }) => `включил(а) ${name}`,
            disabledProvider: ({ name }: { name: string }) => `выключил(а) ${name}`,
            removedProvider: ({ name }: { name: string }) => `удалил(а) провайдера удостоверений ${name}`,
            addedGitHubApp: ({ name }: { name: string }) => `добавил(а) GitHub App ${name}`,
            changedGitHubApp: ({ name }: { name: string }) => `изменил(а) GitHub App ${name}`,
            replacedGitHubAppSecrets: ({ name }: { name: string }) => `заменил(а) секреты GitHub App ${name}`,
            verifiedGitHubApp: ({ name, organization }: { name: string; organization: string }) => `подтвердил(а) ${name} в ${organization}`,
            removedGitHubAppInstallation: ({ name, organization }: { name: string; organization: string }) => `удалил(а) ${name} из ${organization}`,
        },
    },
    reach: {
        title: 'Доступ',
        diagramTitle: ({ home }: { home: string }) => `Как новое устройство попадает в ${home}`,
        yourDevices: 'Ваши устройства',
        noAddress: 'Нет публичного адреса',
        plusDirect: '+ напрямую (Iroh), когда возможно',
        noDirect: 'Без прямых подключений',
        thisComputer: 'Этот компьютер',
        homeServer: 'Сервер этого Home',
        diagramDeployment: 'Задано развёртыванием',
        diagramHere: 'Задан здесь',
        diagramInferred: ({ method }: { method: string }) => `${method} · определён`,
        addresses: 'Адреса',
        addressesDescription: 'Смена адреса никого не отключает.',
        publicAddress: 'Публичный адрес',
        webAppAddress: 'Адрес веб-приложения',
        accessMethod: 'Способ доступа',
        publicAddressHome: 'Задан здесь',
        publicAddressNone: 'Не задан. Устройства из других сетей не смогут добраться до этого Home.',
        inferredFrom: ({ method }: { method: string }) => `Определён по ${method} на компьютере, где размещён этот Home`,
        inferredFromHost: 'Определён на компьютере, где размещён этот Home',
        webAppDescription: 'Ссылки из писем и приглашений открываются здесь.',
        webAppServed: 'Ссылки открываются в веб-приложении этого Home.',
        webAppDefault: 'Ссылки открываются в веб-приложении Happier. По умолчанию',
        change: 'Изменить',
        setAddress: 'Задать адрес',
        httpsRequired: 'Используйте адрес https://.',
        invalidAddress: 'Введите полный адрес, например https://home.example.com.',
        conflict: 'Настройки этого Home изменились. Попробуйте ещё раз.',
        methodLocalOnly: 'Только этот компьютер',
        methodLan: 'Локальная сеть',
        methodTailscaleServe: 'Tailscale Serve',
        methodTailscaleFunnel: 'Tailscale Funnel',
        methodCloudflare: 'Cloudflare Tunnel',
        accessMethodHere: 'Как этот компьютер открывает доступ к Home.',
        accessMethodRemoteHost: ({ host }: { host: string }) => `Задаётся на ${host}. Откройте его в разделе «Удалённые хосты».`,
        accessMethodElsewhereNamed: ({ host }: { host: string }) => `Задаётся на компьютере, где размещён этот Home (${host}). Откройте там Happier или добавьте его как удалённый хост.`,
        accessMethodElsewhere: 'Задаётся на компьютере, где размещён этот Home. Откройте там Happier или добавьте его как удалённый хост.',
        accessMethodDeployment: 'Управляется вашим развёртыванием.',
        directConnections: 'Прямые подключения',
        directConnectionsDescription: 'Устройства подключаются к этому Home напрямую, когда могут, иначе через публичный адрес.',
        directConnectionsRow: 'Прямые подключения (Iroh)',
        irohActive: 'Активны · устройства подключаются напрямую, когда могут',
        irohStarting: 'Запуск…',
        irohOff: 'Выключены · устройства подключаются через публичный адрес',
        irohFailed: 'Не запущено на этом компьютере. Устройства подключаются через публичный адрес.',
        irohNotAvailable: 'Недоступно в этом развёртывании. Устройства подключаются через публичный адрес.',
        irohNeedsAddressHint: 'Задайте публичный адрес, прежде чем выключать',
        irohOffTitle: 'Выключить прямые подключения?',
        irohOffBody: 'Устройства будут подключаться только через публичный адрес. Текущая идентичность прямых подключений этого Home будет окончательно выведена из строя; при повторном включении создаётся новая, которую устройства получат при следующем подключении. Публичный адрес и входы не изменятся.',
        irohOffConfirm: 'Выключить',
        irohNeedsAddressTitle: 'Сначала задайте публичный адрес',
        irohNeedsAddressBody: 'Без публичного адреса устройства не смогут добраться до этого Home после выключения прямых подключений.',
        relay: 'Ретранслятор для прямых подключений',
        relayAutomatic: 'Автоматически',
        relayOff: 'Выключен',
        relayCustom: ({ count }: { count: number }) => `Ваши ретрансляторы (${count}) · Применится после перезапуска`,
        appliesAfterRestart: 'Применится после перезапуска',
        appliesAfterRestartPending: 'Применится после перезапуска · Ожидает',
        exposureInternetTitle: ({ method }: { method: string }) => `Доступен из интернета через ${method}`,
        exposureAddressTitle: 'Ваш публичный адрес открыт для регистрации',
        exposureOpenSignup: 'Любой, кто доберётся до этого Home, может создать аккаунт. Проверьте в политиках, кто может регистрироваться.',
        exposureInvitationOnly: 'Новым аккаунтам нужно приглашение, поэтому посторонние не смогут зарегистрироваться.',
        loadFailed: 'Не удалось загрузить, как доступен этот Home.',
    },
    runtime: {
        title: 'Среда выполнения',
        version: 'Версия',
        versionValue: ({ version }: { version: string }) => `Happier ${version}`,
        versionUnknown: 'Этот Home не сообщает свою версию',
        flavorLight: 'Лёгкий сервер',
        flavorFull: 'Полный сервер',
        server: 'Сервер',
        restart: 'Перезапустить',
        restartNow: 'Перезапустить сейчас',
        restartFailed: 'Не удалось перезапустить сервер',
        restartToApply: 'Перезапустите сервер, чтобы применить их.',
        restartFromDeployment: 'Перезапустите через ваше развёртывание, чтобы применить их.',
        restartFromHost: ({ host }: { host: string }) => `Перезапустите с ${host} — компьютера, где размещён этот Home.`,
        restartFromHostingComputer: 'Перезапустите с компьютера, где размещён этот Home.',
        managedFrom: ({ host }: { host: string }) => `Управляется с ${host}`,
        managedFromBody: 'Откройте Happier на компьютере, где размещён этот Home, чтобы обновить, перезапустить или остановить его.',
        managedElsewhere: 'Управляется с компьютера, где размещён этот Home',
        deploymentTitle: 'Управляется вашим развёртыванием',
        deploymentBody: 'Обновления, перезапуски и резервные копии этого сервера выполняет тот, кто его развёртывает.',
        backups: 'Резервные копии',
        backupsHere: 'Создавайте резервные копии, восстанавливайте или переносите этот Home на его странице среды выполнения.',
        backupsFromHost: ({ host }: { host: string }) => `Создайте резервную копию с ${host} — компьютера, где размещён этот Home.`,
        backupsFromHostingComputer: 'Создайте резервную копию с компьютера, где размещён этот Home.',
        backupsDeployment: 'Резервными копиями управляет ваше развёртывание.',
        hostedHere: ({ home }: { home: string }) => `Этот компьютер размещает ${home}`,
        hostedHereSubtitle: 'Обновляйте, перезапускайте, резервируйте и переносите его в консоли Home.',
        pendingRestart: ({ count }: { count: number }) => (count === 1 ? '1 изменение применится после перезапуска' : `Изменений: ${count} — применятся после перезапуска`),
    },
    activity: {
        title: 'Активность',
        emptyTitle: 'Пока нет активности',
        emptyBody: 'Изменения входа, почты, людей, политик и владения появляются здесь по мере того, как происходят.',
        showOlder: 'Показать более ранние',
        footnote: 'Действия, выполненные в Happier прямо на хост-компьютере, например резервные копии и перезапуски, не показываются.',
        loadFailed: 'Этот Home не вернул свою активность.',
        deploymentCommand: 'Команда развёртывания',
        personalHomeSetup: 'Настройка Personal Home',
        someone: 'Кто-то',
        removedAccount: 'удалённая учётная запись',
        claimed: 'стал владельцем этого Home',
        madeOwner: ({ target }: { target: string }) => `сделал владельцем: ${target}`,
        assignedOwner: 'назначил первого владельца',
        changedPolicies: 'изменил политики',
        changedEmailSetting: 'обновил настройки почты',
        changedServerSetting: 'изменил настройки сервера',
        changedRole: ({ target }: { target: string }) => `изменил роль: ${target}`,
        disabled: ({ target }: { target: string }) => `отключил: ${target}`,
        reenabled: ({ target }: { target: string }) => `снова включил: ${target}`,
        changedStatus: ({ target }: { target: string }) => `изменил статус: ${target}`,
        deleted: ({ target }: { target: string }) => `удалил: ${target}`,
        deletionStarted: ({ target }: { target: string }) => `начал удаление: ${target}`,
        signedOutEverywhere: ({ target }: { target: string }) => `выполнил выход ${target} везде`,
        areaOwnership: 'Владение',
        areaPolicies: 'Политики',
        areaEmail: 'Почта',
        areaServerSettings: 'Настройки сервера',
        areaPeople: 'Люди',
        fieldRole: 'Роль',
        fieldStatus: 'Статус',
        fieldTeamProviders: 'Поставщики входа для Teams',
        valueEmpty: '—',
        valueChanged: 'изменено',
        valueOn: 'Вкл.',
        valueOff: 'Выкл.',
        secretSet: 'задан',
        secretUnset: 'не задан',
    },
    signInPolicy: {
        methodsDescription: ({ home }: { home: string }) => `Как люди входят в ${home}. Хотя бы один способ остаётся включённым, и никто не теряет последний способ входа.`,
        methodUnavailable: 'Недоступно — ваше развёртывание не может это предложить',
        signInService: 'Служба входа Home',
        signInServiceDescription: 'Вход через собственную службу входа этого Home.',
        admissionTitle: 'Кто может создать аккаунт',
        newAccounts: 'Новые аккаунты',
        admissionAnyoneDescription: 'Любой, кто может связаться с этим Home',
        admissionInvitationDescription: 'Только люди с приглашением в команду',
        admissionNobodyDescription: 'Никто не может создать аккаунт',
        anonymousSignup: 'Анонимная регистрация',
        anonymousSignupDescription: 'Создать аккаунт только с ключом восстановления, без почты.',
        encryptionTitle: 'Шифрование',
        encryptionDescription: 'Применяется к аккаунтам и сессиям, создаваемым с этого момента. Существующие никогда не меняются.',
        storagePolicy: 'Политика хранения',
        storageRequired: 'E2EE обязательно',
        storageOptional: 'Необязательно',
        storagePlaintext: 'Только открытый текст',
        storageRequiredDescription: 'Каждый аккаунт сохраняет сквозное шифрование',
        storageOptionalDescription: 'Каждый аккаунт сам решает, шифровать ли',
        storagePlaintextDescription: 'Аккаунты хранят данные без сквозного шифрования',
        storageAppliesAfterRestart: ({ running }: { running: string }) => `Применится после перезапуска · до тех пор ${running}`,
        allowE2ee: 'Аккаунты со сквозным шифрованием',
        allowPlain: 'Аккаунты без сквозного шифрования',
        recommendedInherited: 'По умолчанию сервера',
        recommendedE2ee: 'E2EE',
        errorWideningUnconfirmed: 'Это изменение впускает больше людей и требует вашего подтверждения. Ничего не изменено.',
        widening: {
            titleAnyone: 'Разрешить всем создавать аккаунт?',
            titleInvited: 'Разрешить приглашённым создавать аккаунты?',
            titleMethod: ({ method }: { method: string }) => `Включить ${method}?`,
            titleAnonymous: 'Разрешить анонимную регистрацию?',
            titleUnencrypted: 'Разрешить хранение без шифрования?',
            titleOther: 'Впустить больше людей?',
            exposureAnyone: ({ host }: { host: string }) => `Любой, кто может связаться с этим Home по адресу ${host}, сможет зарегистрироваться без приглашения.`,
            exposureInvited: ({ host }: { host: string }) => `Любой с приглашением, кто может связаться с этим Home по адресу ${host}, сможет создать аккаунт.`,
            exposureMethod: ({ host, method }: { host: string; method: string }) => `Любой, кто может связаться с этим Home по адресу ${host}, сможет войти через ${method}.`,
            exposureAnonymous: ({ host }: { host: string }) => `Любой, кто может связаться с этим Home по адресу ${host}, сможет создать аккаунт только с ключом восстановления.`,
            exposureUnencrypted: ({ host }: { host: string }) => `Любой, кто может связаться с этим Home по адресу ${host}, сможет хранить здесь данные без сквозного шифрования.`,
            exposureOther: ({ host }: { host: string }) => `Любой, кто может связаться с этим Home по адресу ${host}, сможет войти или присоединиться по расширенным правилам.`,
            unchanged: 'Существующие аккаунты и приглашения не меняются.',
            recorded: 'Изменение записывается в Активность с вашим именем.',
            confirmAnyone: 'Разрешить регистрацию всем',
            confirmInvited: 'Разрешить приглашения',
            confirmMethod: ({ method }: { method: string }) => `Включить ${method}`,
            confirmAnonymous: 'Разрешить анонимную регистрацию',
            confirmUnencrypted: 'Разрешить хранение без шифрования',
            confirmOther: 'Применить изменение',
        },
    },
    claim: {
        pageDescription: 'Заявите права владельца на этот Home.',
        emptyTitle: 'У этого Home ещё нет владельца',
        emptyBody: 'Владелец управляет входом, почтой, доступностью и людьми. Пока кто-то не заявит права, никто не может администрировать этот Home.',
        codeTitle: 'Заявить права одноразовым кодом',
        codeDescription: 'Кто-то с доступом к серверу выводит код. Он работает один раз и истекает через 15 минут.',
        printStep: '1 · Выведите код на сервере',
        pasteStep: '2 · Вставьте его сюда',
        codeLabel: 'Код подтверждения',
        codePlaceholder: 'XXXX-XXXX-XXXX-XXXX-…',
        claim: 'Заявить права',
        refused: 'Этот код не сработал. Возможно, он введён с ошибкой, уже использован или истёк — выведите новый.',
        hostTitle: ({ home }: { home: string }) => `Этот компьютер размещает ${home}`,
        hostBody: 'Вы можете сделать свой аккаунт владельцем прямо отсюда. Так может только этот компьютер.',
        makeOwner: 'Сделать меня владельцем',
        hostFailed: 'Этому компьютеру не удалось сделать вас владельцем. Попробуйте ещё раз.',
    },
    fixedByDeployment: ({ key }: { key: string }) => `Задано вашим развёртыванием · ${key}`,
    fixedByDeploymentLead: 'Задано вашим развёртыванием',
    deploymentNotSetLead: 'Недоступно, пока в вашем развёртывании не задано',
    features: {
        title: 'Функции',
        common: 'Основные',
        advanced: 'Дополнительные',
        advancedDescription: ({ count }: { count: number }) => `Ещё: ${count}, по областям.`,
        other: 'Прочее',
        familyCount_one: '1 функция',
        familyCount_other: ({ count }: { count: number }) => `Функций: ${count}`,
        offHome: 'Выключено для этого Home.',
        notInBuild: 'Не входит в эту сборку.',
        needs: ({ feature }: { feature: string }) => `Нужно: ${feature}.`,
        unavailable: 'Недоступно на этом Home.',
        noHomeSwitchOn: 'Всегда включено на этом Home · выключить может только сборка Happier',
        noHomeSwitchOff: 'Выключено на этом Home · включить может только сборка Happier',
        unavailableByDeployment: 'Недоступно на этом Home · решает настройка вашего развёртывания',
        dependentsTitle_one: ({ feature }: { feature: string }) => `Выключение «${feature}» выключит ещё 1 функцию`,
        dependentsTitle_other: ({ feature, count }: { feature: string; count: number }) => `Выключение «${feature}» выключит и другие функции: ${count}`,
        dependentNeeds: ({ feature, parent }: { feature: string; parent: string }) => `«${feature}» требует «${parent}».`,
        turnOff: 'Выключить',
        deviceTitle: 'Функции этого устройства',
        deviceBody: 'Функции, которые влияют только на это устройство, находятся в Настройках.',
        adminTitle: 'Менять функции могут только владельцы',
        adminBody: 'Вы видите, что предлагает этот Home, потому что вы админ.',
        loadFailed: 'Этот Home не вернул свои функции.',
        conflictTitle: 'Функции изменили в другом месте',
        conflictBody: 'Кто-то изменил настройки этого Home, пока вы их смотрели. Теперь страница показывает то, что хранит Home.',
        rangeBetween: ({ min, max }: { min: number; max: number }) => `${min}–${max}`,
        rangeAtLeast: ({ min }: { min: number }) => `${min} или больше`,
        rangeAtMost: ({ max }: { max: number }) => `До ${max}`,
        limitInvalid: 'Введите число из допустимого диапазона.',
        appliesAfterRestart: 'Применится после перезапуска',
        onAfterRestart: 'Включится после перезапуска',
        offAfterRestart: 'Выключится после перезапуска',
        ignoredAtLastStart: ({ reason }: { reason: string }) => `Проигнорировано при последнем запуске: ${reason}`,
        ignoredInvalidType: 'у сохранённого значения неверный тип',
        ignoredOutOfBounds: 'сохранённое значение вне допустимого диапазона',
        ignoredSecretUnreadable: 'сохранённый секрет не удаётся прочитать',
        dependentsAfterRestartTitle_one: ({ feature }: { feature: string }) => `После следующего перезапуска выключение «${feature}» выключит ещё 1 функцию`,
        dependentsAfterRestartTitle_other: ({ feature, count }: { feature: string; count: number }) => `После следующего перезапуска выключение «${feature}» выключит и другие функции: ${count}`,
    },
    data: {
        title: 'Данные',
        deletion: 'Автоматическое удаление',
        deletionDescription: 'Изменения действуют со следующей очистки.',
        dryRunMode: 'Пробный режим',
        dryRunModeDescription: 'Очистка только считает, а не удаляет, пока вы это не выключите.',
        tryRules: 'Проверить текущие правила',
        tryRulesDescription: 'Запускает очистку сейчас, ничего не удаляя.',
        runDryRun: 'Запустить пробу',
        runAgain: 'Запустить снова',
        ranAt: ({ time }: { time: string }) => `Запущено в ${time} · ничего не удалено`,
        sweepInProgress: 'Идёт очистка — попробуйте снова, когда она закончится.',
        wouldDelete: ({ count, examined }: { count: string; examined: string }) => `Будет удалено: ${count} · проверено: ${examined}`,
        nothingToDelete: 'Нечего удалять',
        stopTimeBudget: 'остановлено: лимит времени',
        stopRowBudget: 'остановлено: лимит удаления',
        stopCandidateBudget: 'остановлено: лимит проверки',
        stopStalled: 'остановлено: нет прогресса',
        keep: 'Хранить',
        deleteAfter: 'Удалять через',
        days: 'дн.',
        daysFor: ({ domain }: { domain: string }) => `Сколько дней хранить: ${domain}`,
        daysRequired: 'Укажите число дней.',
        daysInvalid: 'Используйте целое число дней, не меньше 1.',
        defaultEffect: ({ effect }: { effect: string }) => `По умолчанию · ${effect}`,
        alwaysRuns: 'Работает, даже когда автоматическое удаление выключено.',
        expiresAutomatically: 'Истекает автоматически',
        systemRecords: 'Системные записи',
        systemRecordsSummary_one: '1 вид записей, которые этот Home хранит для себя',
        systemRecordsSummary_other: ({ count }: { count: number }) => `Видов записей, которые этот Home хранит для себя: ${count}`,
        adminTitle: 'Менять то, что хранит этот Home, могут только владельцы',
        adminBody: 'Вы видите правила, потому что вы админ.',
        loadFailed: 'Этот Home не вернул свои настройки данных.',
        conflictTitle: 'Настройки данных изменили в другом месте',
        conflictBody: 'Кто-то изменил настройки этого Home, пока вы их смотрели. Теперь страница показывает то, что хранит Home.',
    },
};

const homeGovernanceTranslations = { ru } as const;

return { homeGovernanceTranslations };
})();

const Domain_homeIndexTranslations = (() => {
type HomeIndexTranslation = Shared_homeIndexTranslations.HomeIndexTranslation;

const homeIndexTranslations = { ru: {
        greetingMorning: ({ name }) => `Доброе утро, ${name}`,
        greetingAfternoon: ({ name }) => `Добрый день, ${name}`,
        greetingEvening: ({ name }) => `Добрый вечер, ${name}`,
        greetingMorningAnonymous: 'Доброе утро',
        greetingAfternoonAnonymous: 'Добрый день',
        greetingEveningAnonymous: 'Добрый вечер',
        sessionsWorking: ({ count }) => `Работает сессий: ${count}`,
        sessionsNeedYou: ({ count }) => `Ждут вас: ${count}`,
        nothingRunning: 'Пока ничего не запущено',
        customize: 'Настроить',
        customizeTitle: 'Настроить главную',
        customizeDescription: 'Перетаскивайте, чтобы изменить порядок. Сохраняется в аккаунте, поэтому главная одинакова на всех устройствах.',
        reset: 'Сбросить',
        alwaysShown: 'Всегда видно',
        builtIn: 'Встроенный',
        startDescription: 'Поле ввода и подсказки',
        attentionDescription: 'Появляется, когда что-то ждёт вас',
        machinesDescription: 'Встроенный · сетка ваших машин',
        hiddenSetupSteps: 'Скрытые шаги настройки',
        showAgain: ({ count }) => `${count} · Показать снова`,
        reorderHandle: ({ section }) => `Переместить: ${section}`,
    } } satisfies Pick<Readonly<Record<string, HomeIndexTranslation>>, "ru">;

return { homeIndexTranslations };
})();

const Domain_homeSettingsTranslations = (() => {
const en = Shared_homeSettingsTranslations.en;

const ru: typeof en = {
    page: {
        title: 'Настройки сервера',
        description: 'Все настройки сервера, у которых нет отдельной страницы.',
        searchPlaceholder: 'Поиск по настройкам и ключам окружения',
        changed: 'Изменённые',
        changedA11y: ({ count }: { count: number }) => (count === 1 ? 'Показать только 1 изменённую настройку' : `Показать только изменённые настройки (${count})`),
        noMatches: 'Ни одна настройка не соответствует запросу.',
        noChanges: 'На этом Home ни одна настройка не отличается от значения по умолчанию.',
        filterLabel: 'Показать',
        filterAll: 'Все настройки',
        filterChanged: ({ count }: { count: number }) => `Изменённые · ${count}`,
        more: 'Ещё',
        readOnlyTitle: 'Только чтение при запуске',
        readOnlyDescription: 'Они нужны серверу ещё до чтения сохранённых настроек, поэтому задаются там, где он работает.',
        note: 'Настройки применяются сразу после изменения, если не отмечены как «Применится после перезапуска». «Ожидает» означает, что сохранённое значение отличается от того, с которым запущен сервер. Каждое изменение записывается в Активность; значения секретов — никогда.',
        adminTitle: 'Настройки сервера меняют только владельцы',
        adminBody: 'Вы видите все настройки и откуда берутся их значения.',
        loadFailed: 'Не удалось загрузить настройки сервера.',
        saveFailed: 'Настройка не сохранена.',
        conflictTitle: 'Настройки изменены в другом месте',
        conflictBody: 'Кто-то изменил настройки этого Home, пока вы редактировали. На странице теперь их значения; ваша правка осталась в поле.',
    },
    row: {
        appliesAfterRestart: 'Применится после перезапуска',
        pending: 'Ожидает',
        defaultValue: ({ value }: { value: string }) => `По умолчанию: ${value}`,
        runningWith: ({ value }: { value: string }) => `работает с ${value} с последнего запуска`,
        runningWithout: 'работает без неё с последнего запуска',
        ignored: ({ reason }: { reason: string }) => `Проигнорировано при последнем запуске: ${reason}`,
        runningOn: ({ value }: { value: string }) => `работает на ${value}`,
        notSet: 'Не задано',
        outOfBounds: ({ bounds }: { bounds: string }) => `Допустимо: ${bounds}`,
        invalid: 'Это значение здесь недопустимо',
        storedEncrypted: 'хранится зашифрованным, никогда не показывается',
    },
    banner: {
        pendingNames: ({ names }: { names: string }) => `${names}.`,
        andMore: ({ count }: { count: number }) => (count === 1 ? 'ещё 1' : `ещё ${count}`),
        discard: 'Отменить',
        discardA11y: 'Отменить изменения, которые применятся после перезапуска',
        discarded: 'Ожидающие изменения отменены',
        ignoredTitle: 'Настройка проигнорирована при последнем запуске',
        ignoredTitleMany: ({ count }: { count: number }) => `Настроек проигнорировано при последнем запуске: ${count}`,
        ignoredBody: ({ setting, reason }: { setting: string; reason: string }) => `${setting}: ${reason}. Сервер запустился без неё.`,
        fix: 'Исправить',
    },
    readOnly: {
        before_database: 'Читается до открытия базы данных',
        per_process_identity: 'Своё для каждого процесса сервера',
        invariant: 'Защищает вход и ограничения сборки, поэтому здесь не меняется',
        other: 'Задаётся там, где работает сервер',
        set: 'Задано',
    },
    secret: {
        saved: 'Сохранён',
        replace: 'Заменить',
        clear: 'Удалить',
        keep: 'Оставить',
        clearPending: 'Сохранённое значение будет удалено при сохранении.',
        valueSet: 'Задано',
        valueNotSet: 'Не задано',
        setAction: 'Задать',
    },
    groupSummary: ({ count }: { count: number }) => (count === 1 ? '1 настройка · по умолчанию' : `Настроек: ${count} · по умолчанию`),
    groupSummaryChanged: ({ count, changed }: { count: number; changed: number }) => `Настроек: ${count} · изменено: ${changed}`,
    units: {
        ms: 'мс',
        seconds: 'с',
        minutes: 'мин',
        bytes: 'байт',
        megabytes: 'МБ',
    },
    activity: {
        discarded: 'Отменил ожидающую настройку сервера',
    },
    choices: {
        hosted_happier_relay: 'Ретранслятор Happier',
        direct_apns: 'Push Apple',
        background_wake_best_effort: 'Фоновое пробуждение',
        local_only: 'Только это устройство',
        disabled: 'Выключено',
        enabled: 'Включено',
        automatic: 'Автоматически',
        sandbox: 'Песочница',
        production: 'Продакшен',
        owner: 'Владельцы сервера',
        authenticated: 'Любой вошедший',
        self: 'Этот сервер',
        external: 'Внешний сервис',
        '0': 'Выключено',
        '1': 'Включено',
        any: 'Любая',
        all: 'Все',
        github_app: 'GitHub App',
        oauth_user_token: 'Токен пользователя',
        light: 'Облегчённый',
        full: 'Полный',
        api: 'Только API',
        worker: 'Только worker',
        fatal: 'Критические',
        error: 'Ошибки',
        warn: 'Предупреждения',
        info: 'Инфо',
        debug: 'Отладка',
        trace: 'Трассировка',
        silent: 'Без логов',
        manual: 'Вручную',
        default: 'По умолчанию сервера',
    },
    rateLimit: {
        max: ({ route }: { route: string }) => `${route}: запросов за окно`,
        window: ({ route }: { route: string }) => `${route}: окно`,
    },
    groups: {
        api: 'API и сеть',
        storage: 'Хранилище и файлы',
        monitoring: 'Мониторинг',
        process: 'Процесс',
        ui: 'Раздача веб-приложения',
        realtime: 'Присутствие и сокеты',
        retentionCaps: 'Ресурсные лимиты хранения',
        rpc: 'Вызовы машин',
        liveActivity: 'Live Activities',
        voice: 'Голос',
        connectedServices: 'Подключённые сервисы',
        localServices: 'Локальные сервисы',
        plugins: 'Плагины',
        reviews: 'Ревью',
        bugReports: 'Отчёты об ошибках',
        releases: 'Релизы',
        authCaches: 'Кэши входа',
        limits: 'Ограничения',
        rateLimits: 'Лимиты запросов по маршрутам',
        github: 'Вход через GitHub',
        oauth: 'Вход через OAuth',
        oidc: 'OIDC-провайдеры из конфигурации',
        workos: 'WorkOS',
        signInRequests: 'Запросы на вход',
        offboarding: 'Отключение доступа',
        friends: 'Друзья',
        accountService: 'Служба аккаунтов',
        devices: 'Устройства',
        diagnostics: 'Диагностика',
        reachInference: 'Определение адреса',
        addresses: 'Адреса',
        other: 'Другое',
    },
    keys: {
        HAPPIER_HOME_DISPLAY_NAME: 'Название Home',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: 'Фоновые обновления',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: 'Режим доставки',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_ALLOW_FALLBACK: 'Переключаться на другой режим',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_DEDUPE_WINDOW_MS: 'Окно дубликатов обновлений',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_ENABLED: 'Пуши для фонового пробуждения',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_MIN_INTERVAL_MS: 'Минимальный интервал между пробуждениями',
        HAPPIER_LIVE_ACTIVITY_EXPO_WIDGETS_PUSH_NOTIFICATIONS_ENABLED: 'Сборка с виджетами получает пуши',
        HAPPIER_LIVE_ACTIVITY_TARGET_TRANSIENT_FAILURE_BUDGET: 'Сбоев до отключения устройства',
        HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT: 'Окружение пушей Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID: 'ID команды Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID: 'ID ключа пушей Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY: 'Ключ подписи пушей Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY_FILE: 'Файл ключа подписи пушей Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS: 'Разрешённые bundle ID приложений',
        HAPPIER_LIVE_ACTIVITY_APNS_ACTIVITY_NAMES: 'Разрешённые имена Live Activities',
        HAPPIER_LIVE_ACTIVITY_APNS_REQUEST_TIMEOUT_MS: 'Тайм-аут запроса пушей Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_RECONNECT_BACKOFF_MS: 'Задержка переподключения пушей Apple',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED: 'Использовать размещённый ретранслятор',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL: 'Адрес размещённого ретранслятора',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEY: 'Ключ доступа к ретранслятору',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_SERVICE_ENABLED: 'Работать как размещённый ретранслятор',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEYS: 'Ключи доступа для других серверов',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_MAX_SKEW_MS: 'Допуск часов ретранслятора',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_TTL_MS: 'Память дубликатов ретранслятора',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_CACHE_MAX_ENTRIES: 'Размер кэша дубликатов ретранслятора',
        ELEVENLABS_API_KEY: 'Ключ API ElevenLabs',
        ELEVENLABS_AGENT_ID: 'Агент ElevenLabs',
        ELEVENLABS_AGENT_ID_PROD: 'Рабочий агент ElevenLabs',
        ELEVENLABS_API_BASE_URL: 'Адрес API ElevenLabs',
        REVENUECAT_SECRET_KEY: 'Секретный ключ RevenueCat',
        VOICE_FREE_SESSIONS_PER_MONTH: 'Бесплатных голосовых сессий в месяц',
        VOICE_FREE_MINUTES_PER_MONTH: 'Бесплатных голосовых минут в месяц',
        VOICE_MAX_CONCURRENT_SESSIONS: 'Одновременных голосовых сессий',
        VOICE_MAX_SESSION_SECONDS: 'Самая длинная голосовая сессия',
        VOICE_MAX_MINUTES_PER_DAY: 'Голосовых минут в день',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_ENABLED: 'Заполнение голосовых идентификаторов',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE: 'Размер пакета заполнения',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS: 'Лимит времени заполнения',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_DELAY_MS: 'Пауза между пакетами',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_INTERVAL_MS: 'Интервал между запусками заполнения',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID: 'OAuth client ID для OpenAI Codex',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL: 'Адрес получения токена OpenAI Codex',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID: 'OAuth client ID для подписки Claude',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL: 'Адрес получения токена подписки Claude',
        HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS: 'Тайм-аут обмена токена',
        CONNECTED_SERVICE_CREDENTIAL_MAX_LEN: 'Максимальный размер учётных данных',
        CONNECTED_SERVICE_REFRESH_LEASE_MAX_MS: 'Максимальная аренда обновления',
        VENDOR_TOKEN_MAX_LEN: 'Максимальный размер токена поставщика',
        HAPPIER_LOCAL_SERVICES_TOKEN_SECRET: 'Секрет токенов предпросмотра',
        HAPPIER_LOCAL_SERVICES_PREVIEW_TOKEN_SECRET: 'Секрет токенов приватного предпросмотра',
        HAPPIER_LOCAL_SERVICES_PUBLIC_PREVIEW_TOKEN_SECRET: 'Секрет токенов публичного предпросмотра',
        HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN: 'Источник UI плагинов',
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_MAX_AGE_MS: 'Срок действия подтверждения издателя',
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_CLOCK_SKEW_MS: 'Допуск часов для подтверждения издателя',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_MAX_AGE_MS: 'Срок действия подтверждения ревью',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_CLOCK_SKEW_MS: 'Допуск часов для подтверждения ревью',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: 'Прикладывать журналы сервера',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: 'Кто может читать журналы сервера',
        HAPPIER_BUG_REPORTS_SERVER_LOG_PATH: 'Файл журнала сервера',
        HAPPIER_BUG_REPORTS_SERVER_LOG_MAX_BYTES: 'Объём прикладываемого журнала',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'Канал релизов',
        HAPPIER_GITHUB_REPO: 'Репозиторий релизов',
        AUTH_OFFBOARDING_ENABLED: 'Перепроверять право входа',
        AUTH_OFFBOARDING_STRICT: 'Отказывать при сбое перепроверки',
        AUTH_OFFBOARDING_INTERVAL_SECONDS: 'Интервал между перепроверками',
        AUTH_PROVIDERS_CONFIG_PATH: 'Файл провайдеров',
        AUTH_PROVIDERS_CONFIG_JSON: 'JSON провайдеров',
        HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: 'Служба входа',
        HAPPIER_AUTH_SIGN_IN_SERVICE_URL: 'Адрес службы аккаунтов',
        HAPPIER_AUTH_SIGN_IN_SERVICE_SERVER_IDENTITY_ID: 'Идентификатор службы аккаунтов',
        HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME: 'Название службы аккаунтов',
        HAPPIER_SERVER_OWNER_USER_IDS: 'Аккаунты владельцев сервера',
        HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED: 'Новым устройствам нужно одобрение',
        GITHUB_CLIENT_ID: 'OAuth client ID GitHub',
        GITHUB_CLIENT_SECRET: 'OAuth client secret GitHub',
        GITHUB_REDIRECT_URL: 'Адрес обратного вызова GitHub',
        GITHUB_HTTP_TIMEOUT_SECONDS: 'Тайм-аут запросов к GitHub',
        GITHUB_STORE_ACCESS_TOKEN: 'Хранить токен доступа GitHub',
        OAUTH_PENDING_TTL_SECONDS: 'Срок ожидающего входа',
        OAUTH_STATE_TTL_SECONDS: 'Срок состояния OAuth',
        HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES: 'Разрешённые схемы возврата в приложение',
        AUTH_GITHUB_ALLOWED_USERS: 'Разрешённые пользователи GitHub',
        AUTH_GITHUB_ALLOWED_ORGS: 'Разрешённые организации GitHub',
        AUTH_GITHUB_ORG_MATCH: 'Требуемые организации',
        AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: 'Проверка членства',
        AUTH_GITHUB_APP_ID: 'ID GitHub App для членства',
        AUTH_GITHUB_APP_PRIVATE_KEY: 'Ключ GitHub App для членства',
        AUTH_GITHUB_APP_INSTALLATION_ID_BY_ORG: 'Установки приложения по организациям',
        WORKOS_API_KEY: 'Ключ API WorkOS',
        WORKOS_CLIENT_ID: 'Client ID WorkOS',
        ACCOUNT_AUTH_REQUEST_TTL_SECONDS: 'Срок запроса на вход в аккаунт',
        TERMINAL_AUTH_REQUEST_TTL_SECONDS: 'Срок запроса на вход из терминала',
        AUTH_PAIRING_TTL_SECONDS: 'Срок кода сопряжения',
        AUTH_TOKEN_CACHE_TTL_SECONDS: 'Срок кэша токенов сессий',
        AUTH_TOKEN_CACHE_MAX_ENTRIES: 'Размер кэша токенов сессий',
        AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: 'Срок кэша права входа',
        AUTH_LOGIN_ELIGIBILITY_CACHE_MAX_ENTRIES: 'Размер кэша права входа',
        FRIENDS_USERNAME_MIN_LEN: 'Минимальная длина имени пользователя',
        FRIENDS_USERNAME_MAX_LEN: 'Максимальная длина имени пользователя',
        FRIENDS_USERNAME_REGEX: 'Шаблон имени пользователя',
        HAPPIER_CANONICAL_SERVER_URL: 'Адрес для идентификации входа',
        HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE: 'Адрес возврата OAuth в веб-приложение',
        PUBLIC_URL: 'Объявленный адрес (light)',
        HAPPIER_PUBLIC_SERVER_URL_INFER_TTL_MS: 'Срок определённого адреса',
        HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL: 'Определять по способу доступа',
        HAPPIER_TAILSCALE_INFER_PUBLIC_URL: 'Определять через Tailscale',
        HAPPIER_TAILSCALE_SERVE_STATUS_TIMEOUT_MS: 'Тайм-аут проверки Tailscale Serve',
        HAPPIER_TAILSCALE_FUNNEL_STATUS_TIMEOUT_MS: 'Тайм-аут проверки Tailscale Funnel',
        PORT: 'Порт прослушивания',
        HAPPIER_SERVER_HOST: 'Адрес прослушивания',
        HAPPIER_SERVER_FLAVOR: 'Вариант сервера',
        NODE_ENV: 'Окружение Node',
        SERVER_ROLE: 'Роль процесса',
        UV_THREADPOOL_SIZE: 'Рабочие потоки',
        HAPPIER_INSTANCE_ID: 'ID реплики',
        HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: 'Срок завершения работы',
        HAPPY_EXIT_ON_FATAL: 'Завершаться после критической ошибки',
        HAPPIER_API_CORS_MAX_AGE_SECONDS: 'Кэш предварительных запросов браузера',
        HAPPIER_SERVER_IDENTITY_ID: 'Идентификатор сервера',
        HAPPIER_MANAGED_RELAY_PURPOSE: 'Назначение управляемого ретранслятора',
        HAPPIER_PERSONAL_HOME_RELOCATION_OPERATION_ID: 'Операция переноса',
        HAPPIER_SERVER_STARTUP_RECEIPT_PATH: 'Файл квитанции запуска',
        HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: 'Nonce квитанции запуска',
        HAPPIER_UPDATER_FORWARD_RECOVERY_CAPABILITY: 'Прямое восстановление при обновлении',
        HAPPIER_RELEASE_SOURCE_SHA: 'Коммит сборки',
        HAPPIER_FEATURE_POLICY_ENV: 'Политика кольца релизов',
        HAPPIER_BUILD_FEATURES_ALLOW: 'Разрешённые функции',
        HAPPIER_BUILD_FEATURES_DENY: 'Запрещённые функции',
        HAPPIER_SERVER_LOG_LEVEL: 'Уровень журналирования',
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: 'Сводный журнал отладки',
        HAPPIER_SELF_HOST_LOG_DIR: 'Каталог журналов',
        HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS: 'Диагностика аутентификации',
        HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS: 'Диагностика сообщений сокетов',
        METRICS_ENABLED: 'Метрики',
        METRICS_PORT: 'Порт метрик',
        SENTRY_DSN: 'DSN отчётов об ошибках',
        HAPPIER_SENTRY_USE_CENTRAL_DSN: 'Отправлять отчёты в Happier',
        HAPPIER_SENTRY_CENTRAL_DSN: 'Центральный DSN отчётов об ошибках',
        SENTRY_ENVIRONMENT: 'Окружение отчётов об ошибках',
        SENTRY_RELEASE: 'Релиз для отчётов об ошибках',
        SENTRY_PROFILE_LIFECYCLE: 'Профилирование',
        SENTRY_SEND_DEFAULT_PII: 'Отправлять персональные данные',
        SENTRY_TRACES_SAMPLE_RATE: 'Трассируемые запросы',
        SENTRY_PROFILE_SESSION_SAMPLE_RATE: 'Профилируемые сессии',
        SENTRY_ENABLE_LOGS: 'Отправлять журналы',
        SENTRY_LOG_LEVELS: 'Отправляемые уровни журнала',
        SENTRY_MONITORS_ENABLED: 'Мониторы заданий',
        HAPPIER_SERVER_UI_DIR: 'Папка веб-приложения',
        HAPPIER_SERVER_UI_PREFIX: 'Путь веб-приложения',
        HAPPIER_SERVER_UI_REQUIRED: 'Требовать веб-приложение',
        HAPPIER_SERVER_UI_DEPLOYMENT_ID: 'ID развёртывания веб-приложения',
        HAPPIER_SERVER_UI_DEBUG_PATH: 'Показывать путь веб-приложения, если его нет',
        HAPPIER_SOCKET_ADAPTER: 'Адаптер сокетов',
        HAPPIER_SOCKET_REDIS_ADAPTER: 'Адаптер сокетов Redis (устаревший)',
        HAPPIER_SOCKET_ADAPTER_MAXLEN: 'Длина потока сокетов',
        HAPPIER_SOCKET_ADAPTER_READ_COUNT: 'Размер чтения потока сокетов',
        HAPPIER_SOCKET_MAX_HTTP_BUFFER_SIZE: 'Максимальное сообщение сокета',
        HAPPIER_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS: 'Порог быстрого отключения',
        HAPPIER_SOCKET_PLANNED_RESTART_RETRY_AFTER_MS: 'Задержка переподключения при перезапуске',
        HAPPIER_SOCKET_RECONNECT_WINDOW_MS: 'Окно переподключения',
        HAPPY_SOCKET_ROOMS_ONLY: 'Строгая рассылка по сокетам',
        HAPPIER_MACHINE_SOCKET_OWNER_TTL_SECONDS: 'Владение сокетом машины',
        HAPPIER_PRESENCE_STREAM_MAXLEN: 'Длина потока присутствия',
        HAPPIER_PRESENCE_WORKER_DB_WRITE_CONCURRENCY: 'Параллельность записи присутствия',
        HAPPIER_PRESENCE_WORKER_FLUSH_INTERVAL_MS: 'Интервал сброса присутствия',
        HAPPIER_PRESENCE_WORKER_READ_BLOCK_MS: 'Ожидание чтения присутствия',
        HAPPIER_PRESENCE_WORKER_READ_COUNT: 'Размер чтения присутствия',
        HAPPIER_PRESENCE_WORKER_RECLAIM_IDLE_MS: 'Возврат присутствия через',
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: 'Сессия неактивна через',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: 'Машина офлайн через',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: 'Интервал проверки присутствия',
        HAPPIER_PRESENCE_SHUTDOWN_FLUSH_TIMEOUT_MS: 'Сброс присутствия при остановке',
        HAPPIER_RPC_FORWARD_TIMEOUT_MS: 'Тайм-аут вызова машины',
        HAPPIER_RPC_FORWARD_CAPABILITIES_TIMEOUT_MS: 'Тайм-аут вызова возможностей',
        HAPPIER_RPC_FORWARD_MAX_TIMEOUT_MS: 'Максимальный тайм-аут вызова',
        HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Ожидание метода',
        HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS: 'Интервал проверки метода',
        HAPPIER_RPC_CLUSTER_FETCH_TIMEOUT_MS: 'Тайм-аут поиска между репликами',
        HAPPIER_STOP_SESSION_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Ожидание для остановки сессии',
        HAPPIER_DIRECT_SESSIONS_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Ожидание прямых сессий',
        HAPPIER_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT: 'Сессии, требующие внимания, при первой загрузке',
        HAPPIER_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT: 'Ходы, проверяемые для отката',
        HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT: 'Хранимая история настроек',
        HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK: 'Требовать подписанный ключ машины',
        DATABASE_URL: 'База данных',
        HAPPIER_DB_PROVIDER: 'Движок базы данных',
        HAPPIER_DB_CONNECTION_LIMIT: 'Размер пула соединений',
        HAPPIER_DB_READINESS_TIMEOUT_MS: 'Тайм-аут готовности базы данных',
        HAPPIER_DB_TX_MAX_RETRIES: 'Повторы транзакций',
        HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: 'Задержка первого повтора',
        HAPPIER_DB_TX_RETRY_MAX_DELAY_MS: 'Максимальная задержка повтора',
        HAPPIER_DB_TX_RETRY_JITTER_FACTOR: 'Разброс повторов',
        HAPPIER_DB_TX_TIMEOUT_MS: 'Тайм-аут транзакции',
        HAPPIER_DB_TX_MAX_WAIT_MS: 'Ожидание соединения',
        HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS: 'Общее время повторов',
        HAPPIER_SERVER_DB_SIZE_WARN_BYTES: 'Предупреждение о размере базы данных',
        HAPPIER_SQLITE_AUTO_MIGRATE: 'Миграции при запуске',
        HAPPIER_SQLITE_MIGRATIONS_DIR: 'Папка миграций',
        HAPPIER_SQLITE_JOURNAL_MODE: 'Режим журнала SQLite',
        HAPPIER_SQLITE_SYNCHRONOUS: 'Режим синхронизации SQLite',
        HAPPIER_SQLITE_JOURNAL_SIZE_LIMIT_BYTES: 'Лимит размера журнала SQLite',
        HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: 'Интервал контрольных точек SQLite',
        HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: 'Ожидание контрольной точки SQLite',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_INTERVAL_MS: 'Интервал очистки SQLite',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES: 'Страниц очистки SQLite',
        HAPPIER_FILES_BACKEND: 'Хранилище файлов',
        S3_HOST: 'Хост S3',
        S3_PORT: 'Порт S3',
        S3_USE_SSL: 'S3 через TLS',
        S3_REGION: 'Регион S3',
        S3_BUCKET: 'Бакет S3',
        S3_PUBLIC_URL: 'Публичный адрес S3',
        S3_ACCESS_KEY: 'Ключ доступа S3',
        S3_SECRET_KEY: 'Секретный ключ S3',
        REDIS_URL: 'Подключение Redis',
        HANDY_MASTER_SECRET: 'Главный секрет',
        HAPPIER_SERVER_LIGHT_DATA_DIR: 'Каталог данных',
        HAPPIER_SERVER_LIGHT_DB_DIR: 'Каталог базы данных',
        HAPPIER_SERVER_LIGHT_FILES_DIR: 'Каталог файлов',
        HAPPIER_API_RATE_LIMITS_ENABLED: 'Лимиты запросов',
        HAPPIER_API_RATE_LIMITS_GLOBAL_MAX: 'Запросов на клиента',
        HAPPIER_API_RATE_LIMITS_GLOBAL_WINDOW: 'Окно лимита запросов',
        HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY: 'Считать запросы по',
        HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: 'Считать запросы к маршрутам по',
        HAPPIER_SERVER_TRUST_PROXY: 'Доверять заголовкам прокси',
        HAPPIER_SERVER_RETENTION__INTERVAL_MS: 'Интервал между очистками',
        HAPPIER_SERVER_RETENTION__BATCH_SIZE: 'Строк в пакете',
        HAPPIER_SERVER_RETENTION__MAX_DELETES_PER_RULE_PER_RUN: 'Максимум удалений на правило',
        HAPPIER_SERVER_RETENTION__SWEEP_TIME_BUDGET_MS: 'Лимит времени очистки',
        HAPPIER_SERVER_RETENTION__MAX_CANDIDATES_PER_RULE_PER_RUN: 'Максимум проверяемых строк на правило',
    },
};

const homeSettingsTranslations = { ru } as const;

return { homeSettingsTranslations };
})();

const Domain_homeSetupTranslations = (() => {
type HomeSetupTranslation = Shared_homeSetupTranslations.HomeSetupTranslation;

const homeSetupTranslations = { ru: {
        dismiss: ({ title }) => `Скрыть «${title}»`,
        dismissTooltip: 'Скрыть · вернуть можно в «Настроить»',
        close: 'Закрыть',
        addPhoneSubtitle: 'Следите за сессиями и отвечайте на запросы откуда угодно.',
        addPhoneAction: 'Показать QR-код',
        addMachineSubtitle: 'Сервер или dev-машина для агентов — через SSH или одной командой.',
        installComputerTitle: 'Установить на другом компьютере',
        installComputerSubtitle: 'Установите там приложение и подключитесь к этому Home по ссылке.',
        installComputerAction: 'Получить ссылку',
        connectComputerTitle: 'Подключить компьютер',
        connectComputerSubtitle: 'Отсканируйте код, который Happier показывает в терминале компьютера.',
        connectComputerHint: 'Наведите камеру на код, который Happier показывает в терминале компьютера.',
        phoneAddMachineSubtitle: 'Настройте сервер или dev-машину для ваших агентов.',
        phoneAddMachineAction: 'Добавить',
        thisHome: 'этому Home',
        pairingPhoneTitle: 'Отсканируйте телефоном',
        pairingPhoneBody: ({ home }) => `Наведите камеру телефона на код. Happier откроется и подключится к ${home}.`,
        pairingPhoneStepInstall: 'Установите Happier на телефон.',
        pairingPhoneStepScan: 'Откройте камеру и отсканируйте код.',
        pairingPhoneStepJoin: 'Не закрывайте это окно: телефон подключится сразу после сканирования.',
        pairingComputerTitle: 'Подключить другой компьютер',
        pairingComputerBody: ({ home }) => `Отправьте эту ссылку на другой компьютер. Открыв её в Happier, он подключится к ${home}.`,
        pairingComputerStepInstall: 'Установите приложение на другой компьютер.',
        pairingComputerStepOpen: 'Откройте там ссылку или вставьте её в Happier, когда он спросит, как подключиться.',
        pairingComputerStepJoin: 'Не закрывайте это окно: компьютер подключится, как только откроет ссылку.',
        appStore: 'App Store',
        googlePlay: 'Google Play',
        getDesktopApp: 'Скачать приложение',
        copyLink: 'Копировать ссылку',
        waitingForPhone: 'Ждём ваш телефон…',
        waitingForComputer: 'Ждём ваш компьютер…',
        newCodeIn: ({ time }) => `Новый код через ${time}`,
        makingCode: 'Создаём код…',
        addingDevice: ({ device }) => `Добавляем ${device}…`,
        deviceJoined: ({ device, home }) => `${device} подключён к ${home}`,
        codeFailed: 'Не удалось создать код для этого Home.',
        codeFailedUnreachable: ({ home }) => `${home} не ответил этому устройству.`,
        codeFailedIdentity: ({ home }) => `Данные об ${home} на этом устройстве не совпадают с его ответом; переподключите его в «Homes».`,
        codeFailedSignedOut: ({ home }) => `Это устройство не вошло в ${home}.`,
        codeFailedTooLarge: 'Слишком много адресов, чтобы уместиться в код.',
        codeFailedRefused: ({ home }) => `${home} отклонил запрос.`,
        codeFailedUnexpected: 'Что-то пошло не так; попробуйте снова.',
        cancelCode: 'Отменить код',
        newCode: 'Новый код',
        qrLabel: ({ home }) => `QR-код для добавления устройства к ${home}`,
        storeQrLabel: ({ store }) => `QR-код Happier в ${store}`,
        getTheApp: 'Установите приложение',
        connectServicesTitle: ({ first, second }) => (second ? `Подключите ${first} или ${second}` : `Подключите ${first}`),
        connectServicesSubtitle: 'Пользуйтесь уже оплаченным тарифом на всех машинах и видьте, сколько осталось.',
    } } satisfies Pick<Readonly<Record<string, HomeSetupTranslation>>, "ru">;

return { homeSetupTranslations };
})();

const Domain_homeWidgetTranslations = (() => {
type HomeWidgetTranslation = Shared_homeWidgetTranslations.HomeWidgetTranslation;

const homeWidgetTranslations = { ru: {
        open: ({ destination }) => `Открыть: ${destination}`,
        refreshFailed: 'Не удалось обновить',
        latestRunsTitle: 'Последние запуски',
        latestRunsLoading: 'Загрузка последних запусков',
        latestRunsEmptyTitle: 'Запусков пока нет',
        latestRunsEmptyReason: 'Когда ваши автоматизации запустятся, здесь появится результат каждого запуска.',
        latestRunsErrorTitle: 'Не удалось загрузить последние запуски',
        latestRunsErrorReason: 'Ваш Home не ответил. Проверьте подключение и повторите попытку.',
    } } satisfies Pick<Readonly<Record<string, HomeWidgetTranslation>>, "ru">;

return { homeWidgetTranslations };
})();

const Domain_homesHubTranslations = (() => {
type HomesHubTranslation = Shared_homesHubTranslations.HomesHubTranslation;

const homesHubTranslations = { ru: {
        addHomeOrSignIn: 'Добавить Home / Войти',
        sheetDescription: 'Подключите это устройство к другому Home или найдите свои.',
        continueWithService: ({ service }) => `Продолжить с ${service}`,
        continueWithThisHome: 'Продолжить с этим Home',
        continueWithServiceSubtitle: 'Найдите свои Home и сделайте этот доступным на других устройствах.',
        serviceUnavailable: ({ service }) => `${service} сейчас недоступен.`,
        serviceUnsupported: ({ service }) => `${service} не поддерживает вход с аккаунтом.`,
        serviceUnavailableUnnamed: 'Ваш сервис входа сейчас недоступен.',
        serviceUnsupportedUnnamed: 'Ваш сервис входа не поддерживает вход с аккаунтом.',
        scanOrPaste: 'Отсканировать или вставить ссылку на Home',
        scanOrPasteSubtitle: 'Присоединитесь к Home по QR-коду или ссылке.',
        createPersonalHome: 'Создать личный Home на этом компьютере',
        createPersonalHomeSubtitle: 'Запустите здесь Home для своих машин и устройств.',
        opensFirst: 'Открывается первым',
    } } as const satisfies Pick<Record<string, HomesHubTranslation>, "ru">;

return { homesHubTranslations };
})();

const Domain_homesJourneysTranslations = (() => {
type Service = Shared_homesJourneysTranslations.Service;

type Home = Shared_homesJourneysTranslations.Home;

type HomesJourneysTranslation = Shared_homesJourneysTranslations.HomesJourneysTranslation;

const en = Shared_homesJourneysTranslations.en;

const ruTimes = Shared_homesJourneysTranslations.ruTimes;

const ru: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "Ваши Home найдены",
        reconcileLead: "Теперь этот телефон показывает все ваши Home вместе.",
        showMySessions: "Показать мои сессии",
        scanComputerCode: "Сканировать код на компьютере",
        serviceLead: "После входа будут найдены ваши Home. Этот телефон покажет их все.",
        serviceAsHomeLead: ({ service }) => `Ваши сессии хранятся в ${service} и всегда доступны. Добавьте компьютер для запуска агентов, когда будете готовы.`,
        factAlwaysOnDetail: "Доступ к сессиям в любое время.",
        factAgents: "Ваши компьютеры запускают агентов",
        factAgentsDetail: "Добавьте компьютер позже с помощью QR-кода.",
        fromDeviceHelp: "На подключённом устройстве откройте Настройки → Добавить телефон, затем сканируйте код камерой этого телефона или вставьте ссылку Home.",
        scan: "Сканировать",
    },
    happierAccount: 'аккаунт Happier',
    serviceAccount: ({ service }) => `аккаунт ${service}`,

    alreadyUseTitle: 'Уже пользуетесь Happier?',
    alreadyUseDescription: 'Найдите свои Home через аккаунт или подключитесь напрямую к Home, которым управляете сами. На этом компьютере ничего не изменится, пока вы не выберете.',
    signIn: 'Войти',
    withService: ({ service }) => `через ${service}`,
    changeServiceLabel: ({ service }) => `Сервис входа: ${service}. Изменить`,
    connectToHome: 'Подключиться к Home…',
    hostedPrompt: 'Предпочитаете хостинг?',
    useServiceAsAHome: ({ service }) => `Использовать ${service} как Home`,
    dismiss: 'Скрыть',

    pathServiceTitle: ({ service }) => `Войти через ${service}`,
    pathServiceSubtitle: 'Найти Home, связанные с вашим аккаунтом',
    pathOtherServiceTitle: 'Войти через другой сервис',
    pathOtherServiceSubtitle: 'Ваш собственный вход или вход вашей компании',
    pathDirectTitle: 'Подключиться к Home напрямую',
    pathDirectSubtitle: 'Ссылка или адрес · без аккаунта',

    serviceLead: 'После входа ваши Home будут найдены и показаны вместе. Личный Home этого компьютера останется, пока вы не решите.',
    defaultServiceFact: 'сервис входа по умолчанию',
    serviceMethodsHelp: ({ service }) => `Показаны только способы, которые предлагает ${service}. Вы здесь впервые? Те же кнопки создадут аккаунт.`,

    otherServiceLead: 'Если у вас или вашей команды есть собственный сервис входа, введите его адрес. Happier сначала проверит, что он предлагает.',
    serviceAddressLabel: 'Адрес сервиса входа',
    serviceFound: 'Найдено',
    useThisService: ({ service }) => `Войти через ${service}`,
    addressIsNotAService: 'Этот адрес не предлагает вход в аккаунт. Если это Home, подключитесь к нему напрямую.',
    connectAsHome: 'Подключиться как к Home',
    backToService: ({ service }) => `Назад к ${service}`,

    directLead: 'Для Home, которым вы управляете сами, с сервисом аккаунтов или без него. Аккаунт Happier не нужен.',
    fromDeviceLabel: 'С уже подключённого устройства',
    fromDeviceHelp: 'Откройте на нём Настройки → Добавить телефон, затем отсканируйте код камерой этого компьютера или вставьте ссылку на Home.',
    homeLinkLabel: 'Ссылка на Home',
    homeLinkPlaceholder: 'Вставьте ссылку на Home',
    useCamera: 'Использовать камеру',
    openLink: 'Открыть',
    byAddressLabel: 'По адресу',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: 'Подключить',
    byAddressHelp: 'Happier проверит, что Home отвечает, после чего вы войдёте способами этого Home.',
    notAHomeLink: 'Это не ссылка на Home. Скопируйте её ещё раз на другом устройстве.',
    homeUnreachable: 'Happier не смог связаться с Home по этому адресу. Проверьте адрес и что Home запущен.',

    anotherWay: 'Другой способ',
    homeReachable: 'Доступен',
    connected: 'Подключено',
    signInToHomeTitle: 'Вход в этот Home',
    signInToHomeLead: 'Способы входа, которые предлагает этот Home.',

    reconcileTitle: 'Ваши Home подключены',
    reconcileLead: ({ count }) => count === 1
        ? 'Теперь у этого компьютера два Home. Они показаны вместе в разделе «Все Home».'
        : `Теперь у этого компьютера ${count + 1} Home. Они показаны вместе в разделе «Все Home».`,
    reconcileFound: 'Найдены',
    reconcileThisComputer: 'Этот компьютер',
    runSessionsIn: 'Запускать сессии этого компьютера в',
    runSessionsInDescription: 'Новые сессии, начатые здесь, сохраняются в этом Home.',
    removeEmptyPersonalHome: 'Удалить пустой личный Home',
    removeEmptyPersonalHomeDescription: 'Он был создан при установке Happier и пока ничего не содержит — ни сессий, ни людей, ни команд, ни приглашений.',
    changeLater: 'Это можно изменить позже в Настройки → Home.',
    keepBoth: 'Оставить оба',
    useHome: ({ home }) => `Использовать ${home}`,
    reconcileSetupTitle: 'Выберите, куда идут сессии этого компьютера',
    reconcileSetupSubtitle: ({ home }) => `Вы подключили ${home}. Оставьте оба Home или запускайте там сессии этого компьютера.`,
    reconcileSetupAction: 'Выбрать…',

    serviceAsHomeTitle: ({ service }) => `Использовать ${service} как ваш Home`,
    serviceAsHomeLead: ({ service }) => `Ваши сессии и настройки хранятся в ${service}, а не на этом компьютере.`,
    factAlwaysOn: 'Всегда доступен',
    factAlwaysOnDetail: 'Телефон видит ваши сессии, пока этот компьютер спит.',
    factAgents: 'Этот компьютер продолжает запускать ваших агентов',
    factAgentsDetail: 'Место выполнения кода не меняется.',
    storageE2ee: 'Сквозное шифрование',
    storageE2eeDetail: ({ service }) => `${service} хранит ваши сессии, но не может их прочитать.`,
    storagePlain: ({ service }) => `Хранится в ${service}`,
    storagePlainDetail: 'Без сквозного шифрования: сервис может читать то, что хранит.',
    storageE2eeByDefault: 'Сквозное шифрование по умолчанию',
    storagePlainByDefault: ({ service }) => `Хранится в ${service}, по умолчанию доступно для чтения`,
    storageChoiceDetail: 'Вы выбираете при создании аккаунта.',
    removeEmptyOfferedDetail: 'Пока ничего не содержит. Предлагается только потому, что он пуст.',
    signInOrCreate: ({ account }) => `Войдите или создайте ${account}`,
    alreadyUseServiceAsHome: ({ service }) => `Уже используете ${service} как Home? После входа он подключится напрямую.`,

    addHomeTitle: 'Добавить Home',
    addHomeDescription: 'Home хранит ваши сессии и настройки. Подключите тот, которым уже пользуетесь, или создайте новый в другом месте.',
    addSignIn: ({ account }) => `Войти в ${account}`,
    addSignInSubtitle: 'Найдите Home, которыми уже пользуетесь, и подключите их.',
    addServiceAsHomeSubtitle: 'Размещается для вас и всегда доступен.',
    addLinkOrQr: 'Подключиться по ссылке или QR-коду',
    addLinkOrQrSubtitle: 'Аккаунт не нужен. Получите её на уже подключённом устройстве.',
    addServerHome: 'Настроить Home на сервере',
    addServerHomeSubtitle: 'Машина для разработки или VPS под вашим управлением, настроенные по SSH.',
    haveHomeAddress: 'Есть адрес Home?',
    enterIt: 'Ввести',

    livesOnThisComputer: 'Находится на этом компьютере',
    availableWhileAwake: 'доступен, пока он не спит',
    gettingReady: 'готовится',
    noComputerYet: 'Ещё нет компьютера?',
    aboutYourHome: 'О вашем Home',

    nudgeTitle: ({ count }) => `Home недоступен ${count} ${ruTimes(count)} на этой неделе — перенести Home?`,
    nudgeBody: 'Если этот Home работает на компьютере, который переходит в спящий режим, перенос на постоянно включённый сервер может помочь.',
    nudgeDismiss: 'Больше не показывать на этом устройстве',
    moveHome: 'Перенести Home…',
    useService: ({ service }) => `Использовать ${service}`,
};

const homesJourneysTranslations = { ru } satisfies Pick<Readonly<Record<string, HomesJourneysTranslation>>, "ru">;

return { homesJourneysTranslations };
})();

const Domain_identityAdministrationTranslations = (() => {
type IdentityAdministrationLanguage = Shared_identityAdministrationTranslations.IdentityAdministrationLanguage;

type Words = Shared_identityAdministrationTranslations.Words;

type GitHubAccessWords = Shared_identityAdministrationTranslations.GitHubAccessWords;

type OidcEditorWords = Shared_identityAdministrationTranslations.OidcEditorWords;

const build = Shared_identityAdministrationTranslations.build;

const en = Shared_identityAdministrationTranslations.en;

const githubAccessWords: Pick<Readonly<Record<IdentityAdministrationLanguage, GitHubAccessWords>>, "ru"> = { ru: {
        githubCurrentAccess: 'Текущий доступ',
        githubCurrentAccessSubtitle: 'Требуется включённым подключениям и источникам каталога, использующим эту установку.',
        githubCurrentAccessEmpty: 'Включённым сервисам доступ не требуется.',
        githubSetupAccess: 'Доступ для настройки и восстановления',
        githubSetupAccessSubtitle: 'Доступ для настроенных подключений, включая отключённые и приостановленные источники каталога. Предоставьте недостающий доступ в GitHub перед включением или возобновлением, затем повторно проверьте установку.',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `Удалить установку для ${name}`,
    } };

const oidcEditorWords: Pick<Readonly<Record<IdentityAdministrationLanguage, OidcEditorWords>>, "ru"> = { ru: {
        clientAuthenticationMethod: 'Аутентификация клиента', clientSecretPost: 'Тело POST', clientSecretBasic: 'HTTP Basic', storeRefreshToken: 'Хранить токен обновления', buttonColor: 'Цвет кнопки входа', iconHint: 'Значок входа',
        allowRulesHint: 'Введите по одному значению в строке. Пустое поле означает отсутствие ограничений.', brandingHint: 'Оставьте пустым для стандартного оформления входа.', invalidScopes: 'Включите openid в запрашиваемые области.', refreshFailed: 'Не удалось обновить это подключение', refreshFailedHint: 'Ваши изменения сохранены. Повторите попытку, чтобы проверить изменения в Home.',
    } };

const identityAdministrationTranslations = { ru: build({ ...en, title: 'Поставщики идентификации', subtitle: 'Подключения Home для входа в Teams.', homeConnections: 'Подключения Home', add: 'Добавить подключение', empty: 'Нет подключений Home', active: 'Активно', disabled: 'Отключено', configuration: 'Конфигурация', issuer: 'URL издателя', clientSecret: 'Секрет клиента', secretSet: 'Задан', secretNotSet: 'Не задан', secretRetain: 'Оставьте пустым, чтобы сохранить текущий секрет.', advanced: 'Показать дополнительные настройки', hideAdvanced: 'Скрыть дополнительные настройки', actions: 'Действия', test: 'Проверить вход', testing: 'Открывается проверка…', edit: 'Изменить подключение', save: 'Сохранить подключение', saving: 'Сохранение…', enable: 'Включить подключение', disable: 'Отключить подключение', remove: 'Удалить подключение', createTitle: 'Добавить поставщика идентификации', editTitle: 'Изменить поставщика идентификации', displayName: 'Название', required: 'Заполните обязательные поля.', invalidIssuer: 'Введите корректный URL HTTPS.', secretRequired: 'Введите секрет клиента.', error: 'Изменение не применено.', accounts: 'Затронутые Accounts', connections: 'Подключения Team', errorForbidden: 'У вас больше нет прав на это действие. Ничего не изменено.', errorConflict: 'Кто-то изменил это раньше. Ваши правки сохранены — обновите и повторите.', errorMissing: 'Этого больше нет. Возможно, объект удалили.', errorInUse: 'От этого что-то ещё зависит. Сначала удалите зависимости.', errorProviderUnavailable: 'Служба идентификации не ответила. Ничего не изменено.', errorRateLimited: 'Поставщик просит подождать перед повторной попыткой.', errorInvalid: 'Home отклонил эти значения. Проверьте конфигурацию и повторите.', errorImmutable: 'Это значение фиксируется после начала использования. Создайте новую запись.', errorAuthenticationRequired: 'Войдите в этот Team снова и повторите попытку. Ничего не изменено.', errorPolicyUnavailable: 'Политику аутентификации Team сейчас невозможно оценить. Ничего не изменено.', errorPolicyInUse: 'Политика аутентификации Team всё ещё зависит от этого подключения.', errorNotAllowed: 'Этот Home не разрешает Team настраивать это. Ничего не изменено.', errorNeedsAttention: 'Синхронизация каталога требует внимания. Запустите полную синхронизацию.', errorSyncPaused: 'Этот источник приостановлен. «Возобновить синхронизацию» запускает новую полную синхронизацию.', alternateLogins: 'Accounts, которым нужен другой способ входа', recoveryAuthenticationPolicy: 'Открыть аутентификацию Team', recoveryAlternateLogin: 'Сначала дайте этим Accounts другой способ входа', recoveryDirectory: 'Открыть каталог', recoveryGroupMappings: 'Открыть сопоставления Групп', recoveryTeamAuthentication: 'Войти снова', callbackUrl: 'URL обратного вызова', callbackUrlHint: 'Зарегистрируйте этот URL у поставщика идентификации.' }, githubAccessWords.ru, oidcEditorWords.ru) };

return { githubAccessWords, oidcEditorWords, identityAdministrationTranslations };
})();

const Domain_inboxWorkTranslations = (() => {
const en = Shared_inboxWorkTranslations.en;

const ru: typeof en = {
    pageDescription: 'Всё, что ждёт вас, сгруппировано по работе, к которой относится.',
    tabs: { a11y: 'Вид входящих', needsYou: 'Ждёт вас', updates: 'Новое' },
    groups: {
        unknownLead: 'Сессия',
        leadMeta: ({ count }) => `Подсессий: ${count}`,
        runMeta: 'Запуск рабочего процесса',
        otherTitle: 'Другие сессии',
        otherMeta: 'Не относятся к оркестратору или запуску',
        openSession: 'Открыть сессию',
        openRun: 'Открыть запуск',
    },
    rows: {
        step: 'Шаг',
        workflowRun: 'Запуск рабочего процесса',
        review: 'Просмотреть',
        stalled: 'Зависла',
        stalledReason: 'Её машина ушла в офлайн посреди хода',
        landing: 'Ожидает слияния',
        settle: 'Закрыть',
        snoozedUntil: ({ time }) => `Отложена до ${time}`,
        more: 'Другие действия',
    },
    popover: {
        moreInOther: ({ count }) => `Ещё ${count} в «Других сессиях»`,
        updates: ({ count }) => `Нового: ${count}`,
    },
    empty: {
        title: 'Вас ничего не ждёт',
        description: 'Сюда приходят запросы разрешений, проверки и всё, чего от вас ждёт оркестратор или рабочий процесс.',
    },
    updatesEmpty: {
        title: 'Нового нет',
        description: 'Сюда приходят завершённые сессии и запросы в друзья.',
    },
    stale: { reason: 'Не удалось обновить запуски рабочих процессов', retry: 'Повторить' },
    settleFailed: 'Не удалось закрыть эту сессию',
};

const inboxWorkTranslations = { ru };

return { inboxWorkTranslations };
})();

const Domain_inputPickerTranslations = (() => {
type InputPickerTranslation = Shared_inputPickerTranslations.InputPickerTranslation;

const inputPickerTranslations = { ru: {
        browse: 'Обзор…',
        browseField: ({ field }) => `Обзор: ${field}`,
        unavailable: 'Плагин, предоставляющий этот выбор, недоступен. Текущее значение сохранено.',
        retired: 'Плагин обновился, пока вы выбирали. Попробуйте ещё раз.',
        invalid: 'Этот вариант здесь использовать нельзя. Текущее значение сохранено.',
        failed: 'Не удалось открыть выбор. Попробуйте ещё раз.',
    } } satisfies Pick<Readonly<Record<string, InputPickerTranslation>>, "ru">;

return { inputPickerTranslations };
})();

const Domain_machineAddTranslations = (() => {
type MachineAddTranslation = Shared_machineAddTranslations.MachineAddTranslation;

const machineAddTranslations = { ru: { newMachine: 'Новая машина', waiting: 'Ожидание подключения', connected: 'Подключено', failed: 'Не удалось добавить машину', cancelled: 'Отменено', cannotReachHost: 'Не удалось связаться с хостом. Проверьте адрес и доступ по SSH.', choosePath: 'Выберите способ добавления машины', switchHome: 'Вернитесь в этот дом, чтобы продолжить' } } satisfies Pick<Record<'en' | 'ru' | 'pl' | 'es' | 'fr' | 'it' | 'pt' | 'ca' | 'de' | 'zh-Hans' | 'zh-Hant' | 'ja', MachineAddTranslation>, "ru">;

return { machineAddTranslations };
})();

const Domain_machineAgentsTranslations = (() => {
type MachineAgentsTranslation = Shared_machineAgentsTranslations.MachineAgentsTranslation;

const en = Shared_machineAgentsTranslations.en;

const ru: MachineAgentsTranslation = {
    signedInWith: ({ label }) => `Вход через ${label}`,
    signedInAs: ({ label }) => `Вход выполнен: ${label}`,
    signedInHere: 'Вход выполнен на этой машине',
    updateTo: ({ version }) => `Обновить до ${version}`,
    needsSignIn: 'Нужен вход',
    waitingForSignIn: 'Ожидание входа в терминале…',
    notInstalled: 'Не установлен',
    downloadSize: ({ size }) => `Загрузка ${size}`,
    installYourself: 'Установите вручную',
    unsupportedOs: 'Не работает на этой системе',
    unsupportedArch: 'Нет сборки для этого процессора',
    installing: 'Установка…',
    progress: ({ done, total }) => `${done} из ${total}`,
    checking: 'Проверка…',
    offlineSignedIn: 'Последний раз: вход выполнен · машина офлайн',
    offlineSignedOut: 'Последний раз: вход не выполнен · машина офлайн',
    offlineNotInstalled: 'Не был установлен · машина офлайн',
    offlineUnknown: 'Машина офлайн',
    unknown: 'Не удалось проверить эту машину',
    actionInstall: 'Установить',
    actionUpdate: 'Обновить',
    actionSignIn: 'Войти',
    actionRetry: 'Повторить',
    actionCancel: 'Отмена',
    actionShowTerminal: 'Показать терминал',
    actionGuide: 'Руководство',
    installLeadManaged: ({ agent, machine }) => `Happier устанавливает ${agent} на ${machine} только для Happier. Ваши настройки терминала не меняются.`,
    installLeadVendor: ({ agent, machine }) => `Happier запускает установщик ${agent} на ${machine}.`,
    installAlsoDownloads: ({ what }) => `Также загружается ${what} для сессий.`,
    installThenSignIn: 'Затем вы входите.',
    installAgent: ({ agent }) => `Установить ${agent}`,
    installMyself: 'Установлю сам',
    manualLead: ({ agent, machine }) => `Happier не может установить ${agent} за вас. Установите его на ${machine} по руководству и проверьте снова.`,
    checkAgain: 'Проверить снова',
    closeNote: ({ machine }) => `Можно закрыть — установка продолжится на ${machine}.`,
    stepCheck: 'Проверить запуск',
    stepSignIn: 'Вход',
    failedKept: 'Ничего недоустановленного не осталось.',
    installedLine: ({ agent, version }) => `${agent} ${version} установлен`,
    nowSignIn: 'теперь войдите',
    signInHow: ({ agent }) => `Как ${agent} выполняет вход`,
    useService: ({ service }) => `Использовать ${service}`,
    recommended: 'Рекомендуется',
    serviceConnected: ({ profile }) => `${profile} · уже подключено · работает на всех машинах`,
    serviceNotConnected: 'Подключите один раз — его сможет использовать любая машина.',
    connect: 'Подключить',
    signInOn: ({ machine }) => `Войти на ${machine}`,
    signInOnDetail: ({ agent }) => `Запускает собственный вход ${agent} в терминале там. Использует только эта машина.`,
    noNativeLogin: ({ agent }) => `У ${agent} нет собственного входа: он использует API-ключ или подключённую учётную запись. Подключите её один раз — и любая машина сможет её использовать.`,
    openSignInTerminal: 'Открыть вход в терминале',
    useThisAccount: 'Использовать эту учётную запись',
    waitingLead: ({ agent, machine }) => `Собственный вход ${agent} открыт в терминале на ${machine}. Статус станет «готов», как только он сообщит о входе.`,
    readyLine: ({ agent, machine }) => `${agent} готов на ${machine}`,
    startSessionWith: ({ agent }) => `Начать сессию с ${agent}`,
    setUpAnother: 'Настроить другого агента',
    unsupportedLead: ({ agent, machine }) => `Для ${machine} нет сборки ${agent}, поэтому он не может там работать.`,
    setupTitle: ({ agent }) => `Настройка ${agent}`,
    signInTitle: ({ agent }) => `Вход в ${agent}`,
    readyTitle: ({ agent }) => `${agent} готов`,
    notOnMachineYet: ({ machine }) => `Ещё нет на ${machine}`,
    onMachine: ({ machine }) => `На ${machine}`,
    installingOn: ({ machine }) => `Установка на ${machine}`,
    cantRunOn: ({ machine }) => `Не работает на ${machine}`,
    terminalTab: ({ agent }) => `Вход · ${agent}`,
    panelLead: 'Завершите вход в открывшемся браузере. На другом устройстве? Откройте ссылку там.',
    open: 'Открыть',
    openSignInPage: 'Открыть страницу входа',
    waitingEllipsis: 'Ожидание входа…',
    signedInAlready: 'Уже вошли?',
    closeTerminal: 'Закрыть терминал',
    showTheTerminal: 'Показать терминал',
    phoneLead: ({ agent, machine }) => `${agent} просит вас войти. Откройте страницу здесь, завершите вход — и ${machine} его подхватит.`,
    panelSignedInAs: ({ account }) => `Вход выполнен: ${account}.`,
    panelChecked: 'Happier только что это проверил.',
    sectionTitle: 'Агенты',
    sectionDescription: 'Агенты для программирования на этой машине и как каждый из них выполняет вход.',
    addTitle: 'Добавить агента',
    addMore: ({ count }) => (count === 1 ? `Ещё 1 работает здесь` : `Ещё ${count} работают здесь`),
    showAll: 'Показать все',
    showFewer: 'Показать меньше',
    emptyInstalled: 'На этой машине пока нет агента. Выберите ниже — Happier установит его и выполнит вход.',
    offlineNote: ({ machine }) => `${machine} офлайн. Вот что она сообщила в последний раз.`,
    firstTitle: 'Настройте первого агента',
    firstLead: ({ machine }) => `${machine} подключена, но на ней пока нет агента. Выберите — Happier установит его и выполнит вход.`,
    firstMore: ({ count }) => (count === 1 ? `Или выберите ещё из 1 агента.` : `Или выберите из ещё ${count} агентов.`),
    allAgents: 'Все агенты',
    setUp: 'Настроить',
    choiceUsesService: ({ service, profile }) => `Использует ваш ${service}. Подключено: ${profile}.`,
    choiceSignsInOn: 'Вход выполняется на машине.',
    dismissFirst: 'Скрыть «Настройте первого агента»',
    dismissTooltip: 'Скрыть · вернуть можно в «Настроить»',
    chooseAgent: 'Выберите агента',
    blockNotInstalled: ({ agent, machine }) => `${agent} ещё нет на ${machine}.`,
    blockSetUpToStart: 'Настройте его, чтобы начать.',
    blockSignedOut: ({ agent, machine }) => `${agent} на ${machine} требует входа.`,
    spawnCliMissing: ({ agent, machine }) => `${agent} не установлен на ${machine}.`,
    spawnSignedOut: ({ agent, machine }) => `${agent} на ${machine}: выполнен выход.`,
    draftKept: 'Ваше сообщение сохранено.',
    alreadySetUp: ({ machine, home }) => `${machine} уже подключена к ${home}`,
    startSession: 'Начать сессию',
    openMachine: ({ machine }) => `Открыть ${machine}`,
};

const machineAgentsTranslations = { ru: ru } satisfies Pick<Readonly<Record<string, MachineAgentsTranslation>>, "ru">;

return { machineAgentsTranslations };
})();

const Domain_machineDetailPageTranslations = (() => {
type MachineDetailPageTranslations = Shared_machineDetailPageTranslations.MachineDetailPageTranslations;

const english = Shared_machineDetailPageTranslations.english;

const translated = Shared_machineDetailPageTranslations.translated;

const machineDetailPageTranslations = { ru: translated({
        machineDetailPage: {
            description: 'Запускайте здесь сессии и смотрите, что работает на этой машине.',
            placeholderTitle: 'Машина',
            online: 'В сети',
            offline: 'Не в сети',
            cliVersionFact: ({ version }) => `CLI ${version}`,
            replacedByFact: ({ machine }) => `Заменена на ${machine}`,
            unavailableTitle: 'Эта машина сейчас не может запускать сессии',
            startAction: 'Запустить сессию',
            tmuxSectionDescription: 'Как новые сессии на этой машине используют tmux.',
            windowsSectionDescription: 'Как открываются удалённые сессии на этой машине.',
            clisSectionDescription: 'CLI агентов, найденные Happier на этой машине, и инструменты, которые он может установить.',
            runsSectionDescription: 'Процессы, запущенные сессиями на этой машине.',
            recentSessionsTitle: 'Недавние сессии',
            recentSessionsDescription: 'Пять последних сессий на этой машине.',
            daemonSectionDescription: 'Фоновая служба, которая связывает эту машину с Happier.',
            stopDaemonDescription: 'Текущие сессии продолжат работу. Новые не запустятся, пока вы не перезапустите её на этой машине.',
            stopDaemonAction: 'Остановить',
            detailsTitle: 'Сведения о машине',
        },
    }) };

return { machineDetailPageTranslations };
})();

const Domain_machinePoolTranslations = (() => {
const en = Shared_machinePoolTranslations.en;

const ru = {
    machinesSection: "Машины",
    tierPrimaryDescription: "Пробуется первым.",
    tierFallbackDescription: "Пробуется, когда ни одна предыдущая машина не в сети.",
    pauseMember: "Приостановить для новых сессий",
    resumeMember: "Использовать для новых сессий",
    pausedState: "Приостановлена",
    memberMenu: "Параметры машины",
    newPoolTitle: "Новый машинный пул",
    title: "Пулы машин",
    myTitle: "Мои пулы машин",
    add: "Добавить машинный пул",
    benefit: "Выберите предпочитаемую машину, другие доступны в качестве запасного варианта.",
    placementChangeNotice: "Изменения применяются к сеансам, которые начнутся после сохранения. Открытые сеансы остаются на своей машине.",
    connectionSemantics: "Машина выбирается при открытии подключения и остаётся выбранной для этого подключения. При следующем подключении может быть выбрана другая машина.",
    noMembers: "В этом пуле пока нет машин",
    unavailable: "Недоступно",
    memberRevoked: "Отозван",
    memberReplaced: "Заменено",
    memberTemporary: "Временный",
    availabilityUnknown: "Доступность соединения неизвестна",
    notVerified: "Не проверено",
    brokerUnavailable: "Нет доступного брокера",
    brokerAvailable: ({ count }: { count: number }) => `Доступно: ${count}`,
    basics: "Подробности",
    name: "Имя",
    description: "Описание (необязательно)",
    descriptionTitle: "Описание",
    addMachines: "Добавить машины",
    noMachines: "В этом Home нет доступных постоянных машин.",
    allMachinesAdded: "Все машины этого Home уже входят в этот пул.",
    primary: "Начальный",
    addFallback: "Добавить резервный вариант",
    moveTo: "Переместить в",
    moveTierEarlier: "Переместить этот уровень раньше",
    moveTierLater: "Переместить этот уровень позже",
    removeMember: "Удалить из пула",
    enableMember: "Использовать для будущих выборов",
    save: "Сохранить изменения",
    create: "Создать пул",
    delete: "Удалить пул машин",
    deleteTitle: "Удалить этот пул машин?",
    deleteBody: "Любые ресурсы учётных данных, использующие этот пул, потеряют расположение брокера и потребуют исправления. Это повлияет на будущий выбор, но не удалит машины и не остановит запущенные сеансы.",
    saveFailed: "Не удалось сохранить этот пул машин. Ваши изменения все еще здесь.",
    deleteFailed: "Не удалось удалить этот пул машин. Попробуйте еще раз.",
    conflictTitle: "Этот пул изменен в другом месте",
    conflictBody: "Ваши несохраненные изменения сохраняются. Перезагрузите сохраненную версию, чтобы просмотреть последние изменения.",
    conflictNoReload: "Идентификатор пула больше не доступен. Ваши несохраненные изменения сохраняются.",
    homeOffline: "Этот Home не в сети. Изменения пула будут доступны после повторного подключения.",
    refreshFailed: "Не удалось обновить пулы машин. Показан последний известный список.",
    featureUnavailable: "Пулы машин недоступны на этом Home. Обновите или включите их на Home, чтобы продолжить.",
    openSettings: "Настройки пула машин",
    pickSpecificMachine: "Выбрать конкретную машину",
    poolNotFound: "Этот пул машин больше недоступен.",
    reload: "Перезагрузить сохраненную версию",
    reloadTitle: "Отменить несохраненные изменения?",
    reloadBody: "При перезагрузке эта форма заменяется последней сохраненной версией.",
    privacy: "Сервер этого Home может читать названия, описания и состав пулов даже для учётных записей со сквозным шифрованием.",
    nameRequired: "Введите имя перед сохранением.",
    memberNotEligible: "Некоторые машины больше не могут принадлежать этому пулу.",
    memberNotEligibleDetail: "Удалите эту машину или выберите другую постоянную машину.",
    resolvingTarget: "Выбирая машину из этого пула…",
    resolveEmpty: "В этом пуле нет включенных компьютеров.",
    resolveNoAvailable: "Ни одна машина в этом пуле в настоящее время не доступна.",
    resolvePresenceUnavailable: "Наличие машины временно неизвестно.",
    resolveFailed: "Happier не смог выбрать машину из этого пула. Попробуйте еще раз.",
    executionMachine: "Запустить на",
    chosenFrom: "Выбрано из",
    aMachinePool: "Пул машин",
    availabilityKnown: ({ connected, enabled }: { connected: number; enabled: number }) => `Подключено ${connected} из ${enabled} включённых`,
    fallback: ({ number }: { number: number }) => `Резерв ${number}`,
};

const machinePoolTranslations = { ru };

return { machinePoolTranslations };
})();

const Domain_mcpSettingsTranslations = (() => {
type McpSettingsCopy = Shared_mcpSettingsTranslations.McpSettingsCopy;

const en = Shared_mcpSettingsTranslations.en;

const ru: McpSettingsCopy = {
    purpose: 'Серверы инструментов, которыми ваши агенты могут пользоваться в сессиях. Добавьте сервер один раз и выберите, где он применяется.',
    add: 'Добавить сервер MCP',
    addConfigure: 'Настроить сервер',
    addConfigureDescription: 'Укажите команду или адрес',
    addImportJson: 'Вставить конфигурацию JSON',
    addImportJsonDescription: 'Из README или другого приложения',
    addOwnCategory: 'Добавить свой',
    addPresetCategory: 'Быстрая установка',
    addFromMachine: 'Импортировать с этой машины',
    addFromMachineDescription: 'Серверы, которые уже используют другие агенты',
    searchPlaceholder: 'Поиск серверов',
    toolsGroup: 'Инструменты',
    unbound: 'Пока нигде не используется',
    newServer: 'Новый сервер MCP',
    serverPurpose: 'Сервер инструментов, которым могут пользоваться ваши агенты. Ниже выберите, где он применяется.',
    addByTitle: 'Способ добавления',
    serverSection: 'Сервер',
    serverSectionDescription: 'Как сервер называется в сессиях и в этом списке.',
    connectionSection: 'Подключение',
    connectionSectionDescription: 'Как Happier запускает сервер или подключается к нему.',
    envDescription: 'Значения, передаваемые серверу. Для ключей используйте сохранённый секрет.',
    headersDescription: 'Отправляются с каждым запросом. Для токенов используйте сохранённый секрет.',
    addRule: 'Добавить правило',
    discardDraft: 'Отменить',
    landingTitle: 'Дайте агентам больше инструментов',
    landingDescription: 'Серверы MCP добавляют инструменты: браузер, поиск по документации или GitHub. Настройте сервер, вставьте конфигурацию или начните с готового шаблона.',
    onMachineTitle: 'Найдено на этой машине',
    onMachinePurpose: 'Серверы MCP, которые другие агенты уже настроили на этой машине. Импортируйте сервер, чтобы использовать его в Happier.',
    onMachineSearchSection: 'Где искать',
    onMachineSearchDescription: 'Конфигурации агентов в домашней папке и, если выберете, в папке проекта.',
    onMachineFoundSection: 'Серверы',
    onMachineFoundDescription: 'При импорте сервер копируется в Happier; исходная конфигурация не меняется.',
    previewTitle: 'Что получают сессии',
    previewPurpose: 'Проверьте, какие серверы MCP получает сессия для агента и папки и что происходит, если сервер не запускается.',
    previewContextSection: 'Сессия',
    previewContextDescription: 'Агент и папка, с которыми начнётся новая сессия.',
    failurePolicyTitle: 'Если сервер не запускается',
    failurePolicyDescription: 'Например, если нет нужного ему сохранённого секрета.',
    failurePolicySkip: 'Пропустить его',
    failurePolicyStop: 'Остановить сессию',
    failureSection: 'Надёжность',
    failureSectionDescription: 'Применяется ко всем серверам MCP во всех сессиях.',
    previewNothingTitle: 'Ничего не будет передано',
    previewNothingDescription: 'К этому агенту и папке не применяется ни один сервер MCP. Добавьте сервер или правило, которое их охватывает.',
    check: 'Проверить',
    scan: 'Найти',
};

const mcpSettingsTranslations = { ru } as const;

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

const ru: DesktopTrayTranslation = {
    open: 'Открыть Happier',
    openInHappier: 'Открыть в Happier',
    settings: 'Настройки…',
    startAtLogin: 'Запускать при входе',
    quit: 'Завершить Happier',
    stopServicesAndQuit: 'Остановить фоновые службы и завершить…',
    sessions: ({ count }: CountParams) => `активно: ${count}`,
    start: 'Запустить',
    restart: 'Перезапустить',
    stop: 'Остановить…',
    userOwned: 'Управляется вне Happier',
    checking: 'Проверка фоновых служб…',
    readFailed: 'Не удалось проверить фоновые службы',
    incomplete: 'Некоторые фоновые службы не удалось проверить',
    noServices: 'Этот компьютер ещё не настроен',
    working: 'Выполняется…',
    stopConfirmTitle: ({ relay }: RelayParams) => `Остановить фоновую службу Happier для ${relay}?`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `Сеансы агентов на этом компьютере для ${relay} завершатся, и телефон и браузер не смогут подключиться к нему там, пока служба снова не запустится.`,
    stopAllConfirmTitle: 'Остановить фоновые службы Happier и завершить?',
    stopAllConfirmBody: 'Сеансы агентов на этом компьютере завершатся, и телефон и браузер не смогут подключиться к нему, пока его фоновые службы снова не запустятся.',
    stopConfirmAction: 'Остановить',
    actionFailedTitle: 'Не получилось',
    loginItemFailed: 'Не удалось обновить объект входа Happier',
    quitStopTitle: 'Сеансы агентов ещё выполняются',
    quitStopBody: 'При завершении фоновые службы этого компьютера остановятся, а сеансы на нём завершатся.',
    quitStopUnknownTitle: 'Остановить фоновые службы?',
    quitStopUnknownBody: 'Happier не видит, какие сеансы выполняются на этом компьютере. При завершении его фоновые службы остановятся, а выполняющиеся сеансы завершатся.',
    quitStopConfirm: 'Всё равно остановить',
    quitStopKeep: 'Оставить работать',
    quitStopFailedTitle: 'Некоторые фоновые службы не остановились',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier остаётся открытым, чтобы можно было проверить фоновые службы и повторить попытку.`,
};

const ruLoginStart: DesktopLoginStartTranslation = {
    title: 'Запускать при входе',
    subtitle: 'Этот компьютер остаётся доступным с телефона и в браузере: его фоновые службы запускаются при входе и продолжают работать после завершения Happier. Если выключено, завершение Happier останавливает эти службы.',
    unknown: 'Happier пока не знает, запускаются ли фоновые службы этого компьютера при входе.',
    notSetUp: 'Будет доступно после настройки этого компьютера.',
};

const menuBarModeTranslations = { ru: { tray: ru, loginStart: ruLoginStart } };

return { menuBarModeTranslations };
})();

const Domain_nativePasswordTranslations = (() => {
const nativePasswordTranslations = { ru: {
        email: 'Электронная почта',
        password: 'Пароль',
        signIn: 'Войти',
        title: 'Почта и пароль',
        forgotPassword: 'Забыли пароль?',
        capsLock: 'Caps Lock включён',
        emailRequired: 'Введите адрес электронной почты.',
        passwordRequirements: 'Используйте не менее 15 символов, до 1024 байт UTF-8. Пробелы разрешены.',
        unavailable: 'Вход по почте и паролю недоступен в этом Home.',
        rateLimited: 'Слишком много попыток. Подождите немного и повторите.',
        emailInvalid: 'Введите корректный адрес электронной почты.',
        passwordMalformed: 'Этот пароль содержит символы, которые мы не можем безопасно сохранить. Введите его заново.',
        passwordMismatch: 'Пароли не совпадают.',
        currentPasswordRequired: 'Введите текущий пароль.',
        currentPassword: 'Текущий пароль',
        newPassword: 'Новый пароль',
        confirmPassword: 'Подтвердите пароль',
        signInFailed: 'Эта пара «почта — пароль» не подошла.',
        accountDisabledHere: 'Эта учётная запись отключена в этом Home. Попросите администрацию Home включить её снова.',
        notEligible: 'Сейчас эта учётная запись не может войти в этот Home.',
        linkExpired: 'Ссылка истекла или уже использована. Запросите новую.',
        revisionConflict: 'Пароль был изменён в другом месте. Обновите страницу и повторите.',
        serverUnavailable: 'Этот Home не смог выполнить запрос. Повторите попытку чуть позже.',
        offline: 'Нет соединения с этим Home. Проверьте сеть и повторите попытку.',
        homeUnreachable: 'Не удалось связаться с этим Home. Повторите попытку.',
        securityFactUnavailable: 'Не удалось прочитать это с вашего Home.',
        cancelled: 'Попытка отменена.',
        approvalPending: 'Ожидается ваше подтверждение. Проверьте запрос во входящих подтверждениях и вернитесь сюда.',
        outcomeUnconfirmed: 'Не удалось подтвердить, применено ли изменение. Мы обновили эту учётную запись — проверьте её, прежде чем повторять попытку.',
        recoveryKeyRequired: 'Введите ключ восстановления, чтобы изменить пароль этой сквозно шифрованной учётной записи. Ключ остаётся на этом устройстве.',
        working: 'Выполняется…',
        showPassword: 'Показать пароль',
        hidePassword: 'Скрыть пароль',
        createTitle: 'Создайте учётную запись',
        createAccount: 'Создать учётную запись',
        accountProtection: 'Защита учётной записи',
        protectionPlain: 'Доступно Home',
        protectionPlainDetail: 'Ваш Home может читать ваши данные. Если забудете пароль, его можно сбросить по почте.',
        protectionE2ee: 'Сквозное шифрование',
        protectionE2eeDetail: 'Читать ваши данные могут только ваши устройства. Сохраните ключ восстановления: сброс пароля сам по себе их не вернёт.',
        checkYourEmail: 'Проверьте почту',
        resend: 'Отправить ещё раз',
        resent: 'Отправлено ещё раз. Проверьте почту.',
        useDifferentEmail: 'Использовать другой адрес',
        connectTitle: 'Добавить почту и пароль',
        connectFromSecurity: 'Войдите привычным способом, затем добавьте почту и пароль в разделе «Безопасность учётной записи».',
        signInFirst: 'Сначала войти',
        forgotTitle: 'Забыли пароль?',
        forgotExplanation: 'Мы можем отправить инструкции по почте, либо используйте ключ восстановления, сохранённый при создании учётной записи.',
        emailResetInstructions: 'Прислать инструкции на почту',
        useRecoveryKey: 'Использовать ключ восстановления',
        recoveryKeyDownload: 'Скачать ключ восстановления',
        recoveryKeyLater: 'Сделать позже',
        securitySectionTitle: 'Почта и пароль',
        signInEmail: 'Почта для входа',
        signInEmailNotSet: 'Не задана',
        passwordEnrolled: 'Настроен',
        passwordNotEnrolled: 'Не настроен',
        passwordSetUp: 'Пароль для этого Home настроен.',
        passwordChanged: 'Пароль изменён.',
        passwordRemoved: 'Пароль удалён.',
        changePassword: 'Сменить пароль',
        removePassword: 'Удалить пароль',
        removePasswordSubtitle: 'Входить только другими способами',
        removePasswordConsequence: 'Почта и пароль больше не будут входом в этот Home. Другие способы входа и ваши данные не изменятся.',
        changeEmailExplanation: 'Мы отправим письмо на новый адрес для подтверждения. Текущий адрес входа работает до подтверждения.',
        sendVerification: 'Отправить письмо с подтверждением',
        verifyTitle: 'Подтвердите почту',
        verifyGeneric: 'Эта ссылка подтверждает контроль над почтовым ящиком.',
        verifyReturnToCreate: 'Вернитесь в этот Home, чтобы завершить создание учётной записи с этим адресом.',
        addressVerified: 'Адрес подтверждён.',
        confirmEmailChange: 'Сделать почтой для входа',
        signInToConfirm: 'Войдите на этом устройстве, чтобы подтвердить изменение.',
        returnToSignIn: 'Назад ко входу',
        continue: 'Продолжить',
        resetTitle: 'Задайте новый пароль',
        resetChooseNew: 'Выберите новый пароль для этого Home.',
        resetComplete: 'Пароль изменён. Войдите снова с новым паролем.',
        resetSignsOutOtherDevices: 'Новый пароль завершит все остальные сеансы этой учётной записи.',
        setNewPassword: 'Сохранить новый пароль',
        emailPlaceholder: 'vy@primer.ru',
        accountDisabled: ({ home }: { home: string }) => `Эта учётная запись отключена в ${home}. Попросите администрацию Home включить её снова.`,
        verificationSent: ({ email }: { email: string }) => `Мы отправили ссылку для подтверждения на ${email}. Откройте её, чтобы завершить создание учётной записи.`,
        resetInstructionsSent: ({ email }: { email: string }) => `Если ${email} может здесь войти, инструкции по сбросу уже отправлены.`,
        verificationPending: ({ email }: { email: string }) => `Подтверждение отправлено на ${email}`,
        verifyDestination: ({ email }: { email: string }) => `Эта ссылка подтверждает ${email}.`,
        passwordNeedsEmail: 'Сначала добавьте email для входа',
        passwordNeedsEmailHint: 'Начинается с email для входа',
        setupStepConfirm: 'Подтверждение',
        setupProgress: ({ step, total, label }: { step: number; total: number; label: string }) => `Шаг ${step} из ${total}: ${label}`,
        setupEmailHint: 'Email для входа и пароль добавляются вместе. Сначала мы отправим ссылку для подтверждения адреса.',
        setupConfirmHint: 'Откройте ссылку из этого письма, чтобы задать пароль.',
        setupPasswordHint: 'Введите подтверждённый email, затем задайте пароль.',
    } } as const;

return { nativePasswordTranslations };
})();

const Domain_navigationPlacementTranslations = (() => {
type NavigationPlacementTranslation = Shared_navigationPlacementTranslations.NavigationPlacementTranslation;

const navigationPlacementTranslations = { ru: { customize: 'Настроить…', title: 'Навигация', description: 'Выберите видимые, скрытые пункты и пункты в «Ещё». Перетащите для изменения порядка. Сохраняется на этом устройстве.', pinned: 'Закреплено', overflow: 'Ещё', hidden: 'Скрыто', reset: 'Сбросить', appRail: 'Левая панель', sessionRail: 'Панель сессии', workspaceRail: 'Панель рабочего пространства', sessionTabBar: 'Вкладки телефона' } } satisfies Pick<Record<string, NavigationPlacementTranslation>, "ru">;

return { navigationPlacementTranslations };
})();

const Domain_pendingNavigationTranslations = (() => {
type Count = Shared_pendingNavigationTranslations.Count;

const en = Shared_pendingNavigationTranslations.en;

const ru: typeof en = {
    nextWithCount: ({ count }) => `Ждут вас: ${count}`,
    next: 'Далее', answeredElsewhere: 'Уже отвечено',
    unavailableTitle: 'Не удалось открыть следующий запрос',
    unavailableBody: 'Некоторые ожидающие сессии недоступны. Подключитесь снова и повторите попытку.',
    skippedUnavailable: ({ count }) => `Пропущено недоступных сессий: ${count}.`,
    waitsForPermission: 'просит разрешения', waitsForInput: 'ждёт вашего ответа',
    sessionsWaiting: ({ count }) => `Ожидающих сессий: ${count}`, go: 'Перейти', dismiss: 'Не сейчас',
};

const pendingNavigationTranslations = { ru };

return { pendingNavigationTranslations };
})();

const Domain_personalHomeBootstrapBlockedTranslations = (() => {
type PersonalHomeBootstrapBlockedTranslation = Shared_personalHomeBootstrapBlockedTranslations.PersonalHomeBootstrapBlockedTranslation;

const personalHomeBootstrapBlockedTranslations = { ru: {
        blocked: {
            runtime_unhealthy: 'Ваш локальный Home требует внимания, прежде чем сможет запуститься.',
            home_auth_invalid: 'Аутентификация вашего Home требует внимания.',
            existing_runtime: 'Прежде чем продолжить настройку, решите, что делать с существующим локальным Home.',
            existing_runtime_credentials: 'Этот локальный Home принадлежит другому приложению Happier на этом компьютере.',
            personal_home_erased: 'Ваш личный Home был стёрт. Попробуйте ещё раз, чтобы создать новый.',
        },
        blockedBody: { personal_home_erased: 'Данные вашего Home удалены. Здесь нечего восстанавливать — создайте новый личный Home или используйте другой Home.' },
    } } as const satisfies Pick<Record<string, PersonalHomeBootstrapBlockedTranslation>, "ru">;

return { personalHomeBootstrapBlockedTranslations };
})();

const Domain_personalHomeDecisionTranslations = (() => {
type HomeParams = Shared_personalHomeDecisionTranslations.HomeParams;

type PersonalHomeDecisionTranslation = Shared_personalHomeDecisionTranslations.PersonalHomeDecisionTranslation;

const en = Shared_personalHomeDecisionTranslations.en;

const ru: PersonalHomeDecisionTranslation = {
    homeIdentityAmbiguous: 'Этот адрес личного Home соответствует нескольким сохранённым Home.',
    signedInHome: {
        status: 'Вы уже вошли в другой Home.',
        body: ({ home }: HomeParams) => `Этот компьютер вошёл в ${home}. Продолжайте пользоваться им или настройте здесь личный Home.`,
        keep: ({ home }: HomeParams) => `Продолжить с ${home}`,
        keepDetail: 'Ваши сессии и машины останутся без изменений.',
        create: 'Настроить личный Home',
        createDetail: 'Создайте приватный Home на этом компьютере и переключитесь на него.',
    },
    existingRuntimeCredentials: {
        body: 'Это приложение не может открыть его без ключа восстановления этого Home. Войдите с ключом или используйте другой Home.',
        signIn: 'Войти с ключом восстановления',
        signInDetail: 'Используйте ключ восстановления, сохранённый для этого локального Home.',
    },
};

const personalHomeDecisionTranslations = { ru };

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

const ru = {
    standardOnlyTitle: 'Только стандартное подключение',
    standardOnlySubtitle: 'Новые подключения на этом устройстве используют стандартные маршруты. Текущие передачи завершаются по прежнему маршруту.',
    installOrUpdateAction: 'Установить или обновить личный Home', startAction: 'Запустить личный Home', stopAction: 'Остановить личный Home',
    defaultHomeLabel: 'Личный Home', homeTitle: 'Home', canonicalAddress: 'Адрес Home', identityComparison: 'Текущий Home', identityComparisonMatch: 'Совпадает', identityComparisonMismatch: 'Не совпадает', identityComparisonUnknown: 'Не удалось подтвердить',
    unknownSize: 'Размер неизвестен', unknownTimestamp: 'Время неизвестно', restoreBackupTitle: 'Резервная копия', identityTitle: 'Идентификатор Home', identityUnavailable: 'Идентификатор недоступен', restoreBackupDate: 'Создано', restoreCompatibility: 'Совместимость', restoreCompatible: 'Совместимо', restoreCompatibilityVerified: 'Проверено этой версией', restoreBackupSize: 'Размер', restoreReplacementNotice: 'Текущие данные Home будут заменены. Проверенная копия для восстановления будет сохранена.', restoreConfirmTitle: 'Заменить и восстановить этот личный Home?', restoreConfirmAction: 'Заменить и восстановить', relocateConfirmTitle: 'Переместить этот личный Home?', relocateConfirmBody: 'Текущий Home будет остановлен, прежде чем его проверенная копия станет активной в новом месте.', relocateDestination: 'Назначение', relocateConfirmAction: 'Переместить Home', recoverRestoreTitle: 'Восстановить прерванное восстановление?', recoverRestoreBody: 'Откатить прерванное восстановление с помощью сохранённых материалов восстановления.', recoverRestoreAction: 'Восстановить операцию', eraseDataTitle: 'Удалить данные личного Home?', eraseHomeTarget: 'Home', eraseDataBody: 'Это отдельная операция от удаления приложения и навсегда удаляет только следующие определённые пути Home:', estimatedSize: 'Оценочный размер', summaryTitle: 'Личный Home', footer: 'Ваш Home останется на этом компьютере. Эти действия не изменят другой Home.', statusTitle: 'Статус', notAvailable: 'Недоступно', storageTitle: 'Хранилище', masterSecretTitle: 'Секрет доступа Home', masterSecretPresent: 'Есть', masterSecretUnavailable: 'Недоступно', inspectAction: 'Обновить сведения о Home', actionsTitle: 'Резервная копия и восстановление', protectionTitle: 'Защита', backupsSectionFooter: 'Резервные копии содержат читаемые разговоры, данные Home, состояние доверенных устройств и секрет доступа Home. Храните их только в надёжном месте.', lastBackupTitle: 'Последняя копия', lastBackupUnknown: 'Последняя копия неизвестна', backupsTitle: 'Архивы копий', backupAction: 'Создать копию', backupSubtitle: 'Создаёт и проверяет открытый архив Home.', exportBackupAction: 'Экспортировать копию…', exportBackupSubtitle: 'Создаёт проверенную копию в выбранном вами месте.', verifyAction: 'Проверить копию…', verifySubtitle: 'Проверяет архив без его восстановления.', restoreAction: 'Восстановить…', restoreSubtitle: 'Проверяет копию перед заменой данных Home.', relocateAction: 'Переместить Home…', relocateSubtitle: 'Переместить этот Home на управляемый компьютер.', relocationFinishAction: 'Завершить перемещение', relocationReturnAction: 'Вернуться к исходному Home', relocationFinishSubtitle: 'Завершить перемещение после проверки назначения.', relocationReturnSubtitle: 'Оставить исходный Home активным местом.', recoverRestoreSubtitle: 'Прерванное восстановление можно явно откатить.', restoreRecoveryWarningTitle: 'Восстановление требует исправления', restoreRecoveryWarningBody: 'Состояние восстановления неоднозначно. Автоматические изменения выполнены не будут. Просмотрите диагностику перед исправлением этого Home.', restoreCleanupWarningTitle: 'Очистка после восстановления требует внимания', restoreCleanupWarningBody: 'Home восстановлен, но автоматическая очистка не завершилась. Просмотрите диагностику и повторите операцию Home.', backupVerified: 'Копия проверена', backupNeedsAttention: 'Копия проверена; перезапуск Home требует внимания', backupHomeReady: 'Home перезапущен', backupRevealAction: 'Показать копию', restoreResultTitle: 'Результат восстановления', restoreOutcomeRecoveryRequired: 'Требуется восстановление', restoreOutcomeRolledBack: 'Восстановление отменено', restoreOutcomeRestored: 'Home восстановлен', advancedTitle: 'Дополнительно', advancedFooter: 'Управление runtime и диагностика этого компьютера.', restartAction: 'Перезапустить личный Home', openDataLocationAction: 'Открыть расположение данных Home', openLogsAction: 'Открыть журналы runtime', removeProfileAction: 'Удалить Home из Happier', removeProfileSubtitle: 'Удаляет этот профиль; данные runtime остаются на этом компьютере.', removeProfileTitle: 'Удалить профиль личного Home?', removeProfileBody: 'Профиль будет удалён, но runtime и данные сохранятся.', uninstallRuntimeAction: 'Удалить runtime, сохранить данные', uninstallRuntimeSubtitle: 'Удаляет службу и бинарные файлы; данные Home сохраняются.', deleteHomeDataTitle: 'Удалить данные Home', removeSectionFooter: 'Удаление приложения сохраняет данные Home. Полное удаление — отдельное подтверждаемое действие.', eraseDataAction: 'Удалить данные личного Home навсегда', eraseDataSubtitle: 'Отдельно от удаления приложения. Навсегда удаляет определённые данные Home.', eraseResultTitle: 'Данные Home удалены', eraseStoppedHome: 'Работающий Home остановлен', eraseHomeAlreadyStopped: 'Home уже был остановлен', eraseRemainingPaths: 'Не удалось удалить', progressTitle: 'Операция с личным Home', dismissResult: 'Закрыть',
    repairSearchAction: 'Перестроить поиск Home',
    repairSearchSubtitle: 'Заново создаёт поисковый индекс из разговоров этого Home.',
    repairSearchCompleteTitle: 'Поиск Home перестроен',
    repairSearchCompleteBody: 'Поисковый индекс был заново создан из разговоров этого Home.',
    backupCleanupRequired: 'Резервная копия в порядке; удалите защищённый промежуточный путь, показанный в подробностях',
    backupCleanupPath: 'Защищённый промежуточный путь для удаления',
    backupCleanupError: 'Ошибка очистки',
    backupDestinationMismatch: 'Резервная копия не была создана в выбранном месте. Ничего не удалено.',
    backupDestinationUnsafe: 'Выбранное место для резервной копии находится внутри данных личного Home, которые были бы удалены. Ничего не удалено.',
    eraseInspectionAttention: 'Данные Home удалены; проверка требует внимания',
    searchTitle: 'Поиск',
    searchReady: 'Готов',
    searchIndexing: 'Индексация…',
    searchUnavailable: 'Недоступен',
    localOnlyIngressTitle: 'Доступен только с этого компьютера',
    localOnlyIngressBody: 'Публичные ссылки, обратные вызовы провайдеров, веб-хуки плагинов и уведомления во время сна этого компьютера останутся недоступными, пока этот Home не станет доступен извне.',
} satisfies PersonalHomeSettingsCopy;

const backupDisclosureBody = { ru: 'Эта резервная копия содержит читаемые разговоры, данные Home, секрет доступа Home и состояние доверенных устройств. Любой, кто сможет восстановить полный архив, сможет запустить клон этого Home. Сохраните её в надёжном месте.' } as const;

const eraseBackupOffer = { ru: { title: 'Сначала создать резервную копию этого Home?', body: 'Удаление данных Home нельзя отменить. Сначала создайте проверенную резервную копию или продолжите без неё.', continueWithoutBackup: 'Продолжить без копии' } } as const;

const operationOutcome = { ru: {
        erasePartialTitle: 'Не удалось удалить часть данных Home',
        eraseOutcomeSummary: ({ removed, remaining }) => `Удалено ${removed} ${pluralRu(removed, 'элемент', 'элемента', 'элементов')}`
            + (remaining > 0 ? `; не удалось удалить ${remaining} ${pluralRu(remaining, 'элемент', 'элемента', 'элементов')}` : ''),
        eraseNotPerformed: 'Ничего не удалено',
        eraseBlockedBackupMismatch: 'Эта резервная копия относится к другому Home.',
        eraseBlockedIdentityUnknown: 'Happier не удалось подтвердить, что эта резервная копия относится к этому Home.',
        eraseVerificationDetail: 'Проверка',
        operationFailed: 'Эта операция Home не завершилась. Откройте «Подробности», чтобы узнать, что произошло.',
        restorePreviousDataTitle: 'Предыдущие данные сохранены',
    } } as const satisfies Pick<Record<string, OperationOutcomeCopy>, "ru">;

const personalHomeSettingsTranslations = { ru: { ...ru, ...operationOutcome.ru, backupDisclosureBody: backupDisclosureBody.ru, eraseBackupOfferTitle: eraseBackupOffer.ru.title, eraseBackupOfferBody: eraseBackupOffer.ru.body, eraseContinueWithoutBackup: eraseBackupOffer.ru.continueWithoutBackup } } as const;

return { backupDisclosureBody, eraseBackupOffer, operationOutcome, personalHomeSettingsTranslations };
})();

const Domain_personalizeTranslations = (() => {
type PersonalizeTranslation = Shared_personalizeTranslations.PersonalizeTranslation;

const en = Shared_personalizeTranslations.en;

const pluralPl = Shared_personalizeTranslations.pluralPl;

const pluralRu = Shared_personalizeTranslations.pluralRu;

const ru: PersonalizeTranslation = {
    cardTitle: 'Настройте Happier под себя',
    cardSubtitle: 'Шесть быстрых решений, каждое с живым предпросмотром.',
    cardAction: 'Настроить',
    cardContinue: 'Продолжить',
    cardProgress: ({ saved, total, step }) => `Сохранено решений: ${saved} из ${total}. Продолжите с шага «${step}».`,
    cardProgressReview: ({ saved, total }) => `Сохранено решений: ${saved} из ${total}. Проверьте свою настройку.`,
    inPlaceTitle: 'Сделайте Happier своим',
    inPlaceBody: 'Шесть быстрых решений, каждое с живым предпросмотром. Начните с внешнего вида — Home меняется по мере выбора.',
    inPlaceContinue: ({ count }) => `Продолжить · ещё ${count}`,
    notNow: 'Не сейчас',
    flowTitle: 'Настройте Happier под себя',
    finishLater: 'Закончить позже',
    later: 'Позже',
    stepEyebrow: ({ n, total, name }) => `Шаг ${n} из ${total} · ${name}`,
    stepCounter: ({ n, total }) => `${n} из ${total}`,
    styleEyebrow: 'Необязательно',
    summaryEyebrow: 'Всё готово',
    previewNote: 'Предпросмотр. Ничего не сохранится, пока вы не нажмёте «Далее».',
    previewNoteSummary: 'Ваше рабочее пространство в текущем виде.',
    next: 'Далее',
    review: 'Проверить',
    useThisSetup: 'Использовать эту настройку',
    saveFailed: 'Этот шаг не сохранён. Ваш выбор по-прежнему отмечен.',
    tryAgain: 'Повторить',
    skipThisStep: 'Пропустить шаг',
    scopeThisDevice: 'Это устройство',
    scopeAllDevices: 'Все ваши устройства',
    stepsLabel: 'Шаги',
    savedStepsNote: ({ count }) => pluralRu(count, `${count} шаг уже сохранён.`, `${count} шага уже сохранены.`, `${count} шагов уже сохранено.`),
    lookName: 'Вид',
    lookTitle: 'Чтобы было комфортно',
    lookDescription: 'Светлая, тёмная или системная тема, и сколько стекла показывает приложение.',
    themeLabel: 'Тема',
    glassLabel: 'Стекло',
    glassAutoDescription: 'Стекло по всему приложению, слоями',
    glassEverywhereDescription: 'Одинаковое стекло везде',
    glassSolidDescription: 'Все поверхности непрозрачные',
    glassCustomNote: 'Вы настроили стекло в разделе «Оформление». Выберите пресет, чтобы заменить настройку, или оставьте свою.',
    customizeInAppearance: 'Настроить в разделе «Оформление»…',
    styleName: 'Стиль',
    styleTitle: 'Начните со стиля',
    styleDescription: 'Каждый стиль задаёт, как читаются сессии и как выглядит список. Он только заполняет следующие шаги: ничего не сохранится, пока вы не нажмёте «Далее» на каждом.',
    styleKeep: 'Оставить текущую настройку',
    styleActivity: 'Активность',
    styleConversation: 'Беседа',
    styleDetail: 'Подробности',
    styleCustomTag: 'Своя',
    styleDefaultTag: 'По умолчанию в Happier',
    styleChanges: ({ style, count }) => `«${style}» меняет ${pluralRu(count, `${count} параметр`, `${count} параметра`, `${count} параметров`)}`,
    styleNoChanges: 'Это уже ваша настройка.',
    styleNever: 'Тема, уведомления, конфиденциальность и разрешения агентов никогда не входят в стиль.',
    was: ({ value }) => `было: ${value}`,
    conversationName: 'Беседа',
    conversationTitle: 'Следите за беседой',
    conversationDescription: 'Как отображаются ходы сессии и размышления агента.',
    layoutLabel: 'Макет',
    thinkingLabel: 'Размышления',
    toolsName: 'Вызовы инструментов',
    toolsTitle: 'Смотрите, что сделал агент',
    toolsDescription: 'Как команды, правки и чтение файлов выглядят в сессии.',
    toolsLabel: 'Вызовы инструментов',
    toolTapLabel: 'Нажатие на инструмент',
    toolDetailLabel: 'Детали инструментов',
    toolDetailDefault: 'Стандартно',
    toolDetailFull: 'Полностью',
    workName: 'Ваша работа',
    workTitle: 'Найдите свою работу',
    workDescription: 'Как упорядочен список сессий и сколько показывает каждая строка.',
    listLayoutLabel: 'Список сессий',
    rowsLabel: 'Строки',
    attentionName: 'Внимание',
    attentionTitle: 'Замечайте, что ждёт вас',
    attentionDescription: 'Где в списке находятся сессии, которые ждут вас или готовы к проверке.',
    attentionLabel: 'Сессии, которые ждут вас',
    attentionHomeNote: 'Home всегда показывает, что ждёт вас. Это меняет только список сессий.',
    notificationsName: 'Уведомления',
    notificationsTitle: 'Будьте в курсе',
    notificationsDescription: 'О чём это устройство сообщает, пока вы заняты другим.',
    notificationsAllowed: 'Уведомления на этом устройстве разрешены.',
    notificationsNotAllowed: 'Happier пока не может показывать уведомления на этом устройстве.',
    notificationsUnsupported: 'Уведомления недоступны на этом устройстве. Настройте их в приложении для компьютера или на телефоне.',
    scopeLook: 'Тема на этом устройстве · стекло на всех устройствах',
    notificationsNeedsYouSummary: 'Нужны вы',
    notificationsFinishedSummary: 'Завершено',
    notificationsAllow: 'Разрешить уведомления',
    notificationsTellMe: 'Сообщать, когда',
    notificationsNeedsYou: 'Сессии нужно одобрение или ответ',
    notificationsFinished: 'Сессия завершает свой ход',
    notificationsShowLabel: 'Уведомления показывают',
    notificationsShowDescription: 'Команды, вопросы и ответы могут появляться на экране блокировки.',
    notificationsMessage: 'Сообщение',
    notificationsStatus: 'Только статус',
    notificationsPhoneNote: 'Оповещения на телефоне, когда Happier закрыт, настраиваются на самом телефоне.',
    notificationsOff: 'Без уведомлений',
    sampleNeedsYouTitle: 'Ревью #2481 ждёт вас',
    sampleNeedsYouBody: 'Агент хочет выполнить yarn test:e2e в ~/happier. Разрешить?',
    sampleReadyTitle: '«Починить нестабильный тест переподключения» — готово',
    sampleReadyBody: 'Нашёл: таймер повтора никогда не сбрасывался. Исправлено, тест проходит.',
    sampleStatusBody: 'Откройте Happier, чтобы посмотреть.',
    sampleSessionReconnect: 'Починить нестабильный тест переподключения',
    sampleSessionCraft: 'Лаборатория доводки',
    sampleSessionReview: 'Ревью #2481',
    sampleSessionPricing: 'Тексты страницы цен',
    sampleSessionDocs: 'Поисковый индекс документации',
    sampleWorking: 'Работает',
    sampleNeedsYou: 'Ждёт вас',
    sampleReady: 'Готово к проверке',
    summaryTitle: 'Ваша настройка',
    summaryDescription: ({ changed }) => changed === 0
        ? 'Всё ниже уже сохранено. Ничего не изменилось.'
        : changed === 1
            ? 'Всё ниже уже сохранено. Изменилось одно решение, остальное осталось как было.'
            : `Всё ниже уже сохранено. ${pluralRu(changed, `Изменилось ${changed} решение`, `Изменилось ${changed} решения`, `Изменилось ${changed} решений`)}, остальное осталось как было.`,
    summaryChange: 'Изменить',
    summaryFooter: 'Всё это можно изменить позже в настройках или пройти заново через «Настройки → Оформление».',
    replayTitle: 'Настройте Happier под себя',
    replaySubtitle: 'Шесть быстрых решений, каждое с живым предпросмотром.',
    replayAction: 'Начать',
    journeyHandoff: 'Сделайте своим',
};

const personalizeTranslations = { ru } satisfies Pick<Readonly<Record<string, PersonalizeTranslation>>, "ru">;

return { personalizeTranslations };
})();

const Domain_phoneNavigationTranslations = (() => {
const en = Shared_phoneNavigationTranslations.en;

const ru: typeof en = {
    phoneNav: {
        settings: {
            sectionDescription: 'Телефонный макет внутри сессий и жесты на его панели. Каждый жест можно отключить отдельно.',
            swipeSidewaysTitle: 'Смахивайте в сторону для смены сессии',
            swipeSidewaysScrollsDescription: 'Предыдущая или следующая, на панели. Если инструменты не помещаются, смахивание прокручивает их.',
            swipeSidewaysAlwaysDescription: 'Предыдущая или следующая, на панели. Остаётся смахиванием; инструменты, которые не помещаются, ждут в «Ещё».',
            alwaysSwipeTitle: 'Всегда смахивать между сессиями',
            alwaysSwipeOnDescription: 'Панель оставляет инструменты, которые помещаются; остальные ждут в «Ещё».',
            alwaysSwipeOffDescription: 'Выкл.: лишние инструменты прокручивают панель.',
            dragUpTitle: 'Потяните вверх для переключения',
            dragUpDescription: 'Потяните панель вверх, чтобы увидеть открытые вкладки и недавние сессии, затем скользите к нужной.',
            dragUpSourceTitle: 'Потягивание вверх показывает',
            dragUpSourceRecentDescription: 'Открытые вкладки, затем то, что вы недавно открывали на этом устройстве.',
            dragUpSourceListDescription: 'Сессии в порядке списка.',
            swipeSourceTitle: 'Смахивание в сторону показывает',
            swipeSourceListDescription: 'Следующую или предыдущую сессию из вашего списка.',
            swipeSourceRecentDescription: 'Следующую или предыдущую по времени последнего открытия.',
            sourceRecent: 'Недавние',
            sourceList: 'Список сессий',
            flickTitle: 'Быстро проведите вверх или вниз для переключения',
            flickDescription: 'Быстрый взмах открывает следующую или предыдущую.',
            holdToDockTitle: 'Удерживайте, чтобы переключатель остался открытым',
            holdToDockDescription: 'Удерживайте панель и отпустите, чтобы выбрать касанием.',
            pullAllTabsTitle: 'Потяните заголовок вниз для всех вкладок',
            pullAllTabsDescription: 'Потяните заголовок сессии вниз, чтобы увидеть все открытые вкладки и недавние сессии.',
        },
        bar: {
            onTheBar: 'На панели',
            more: 'Ещё',
            heldInMore: 'В «Ещё», пока включено «Всегда смахивать»',
            keepOnBar: 'Оставить на панели',
            removeFromBar: 'Убрать с панели',
            openFiles: 'Открыть файлы',
        },
        allTabs: {
            title: 'Все вкладки',
            pullHint: 'Потяните для всех вкладок',
            releaseHint: 'Отпустите для всех вкладок',
            openTabs: 'Открытые вкладки',
            openTabsSynced: 'Открытые вкладки · синхронизированы',
            recent: 'Недавние',
            recentOnThisDevice: 'Недавние на этом телефоне',
            here: 'Здесь',
            panes: ({ count }: { count: number }) => `Панелей: ${count}`,
            emptyTitle: 'Больше ничего не открыто',
            emptyDescription: 'Открытые вами сессии и сохранённые вкладки появятся здесь, самые свежие первыми.',
            openTab: ({ title }: { title: string }) => `Открыть ${title}`,
        },
        rail: {
            label: 'Открытые вкладки',
            synced: 'Синхронизировано',
            syncedA11y: 'Открытые вкладки синхронизируются между вашими устройствами',
            notAvailableTitle: 'Недоступно на этом телефоне',
            notAvailableUnknown: 'Эта вкладка открыта на другом устройстве, и этот телефон не может её показать. Там она остаётся открытой.',
            closeTab: 'Закрыть вкладку',
            paneOf: ({ position, total }: { position: number; total: number }) => `${position} из ${total}`,
            nextPane: 'Следующая панель',
            chatPane: 'Chat',
        },
        switcher: {
            title: 'Переключиться на',
            allSessions: 'Все сессии',
            openTabs: 'Открытые вкладки',
            synced: 'синхронизировано',
            recent: 'Недавние',
            recentOnThisDevice: 'Недавние на этом телефоне',
            sessions: 'Сессии',
            nextInSessions: 'Следующая в «Сессиях»',
            previousInSessions: 'Предыдущая в «Сессиях»',
            furtherBack: 'Раньше',
            moreRecent: 'Свежее',
            here: 'Здесь',
            stayOn: 'Остаться на',
            noOlderSessions: 'Нет более старых сессий',
            noNewerSessions: 'Нет более новых сессий',
            lastInSessions: 'Это последняя в «Сессиях».',
            firstInSessions: 'Это первая в «Сессиях».',
            nothingFurtherBack: 'Раньше ничего нет.',
            mostRecent: 'Это самая свежая.',
            nothingToSwitch: 'Больше ничего не открыто',
            nothingToSwitchDescription: 'Открытые вами сессии появятся здесь, самые свежие первыми.',
            draft: ({ text }: { text: string }) => `Ваш черновик: «${text}»`,
            switchSessionAction: 'Сменить сессию',
            switchedTo: ({ name }: { name: string }) => `Переключено на ${name}`,
            close: 'Закрыть',
            positionOf: ({ position, total }: { position: number; total: number }) => `${position} из ${total}`,
        },
    },
};

const phoneNavigationTranslations = { ru };

return { phoneNavigationTranslations };
})();

const Domain_pluginAccountDataEraseTranslations = (() => {
const english = Shared_pluginAccountDataEraseTranslations.english;

const pluginAccountDataEraseTranslations = { ru: {
    accountDataErase: {
        installedGroupTitle: 'Данные аккаунта',
        installedGroupFooter: 'Это затрагивает сохраненные данные только для текущей учетной записи. Он не удаляет этот плагин ни с одного компьютера.',
        installedEntryTitle: 'Удалить данные учетной записи',
        installedEntrySubtitle: 'Навсегда удалите сохраненные данные этого плагина из текущей учетной записи.',
        orphanedGroupTitle: 'Сохраненные данные плагина',
        orphanedGroupFooter: 'Используйте идентификатор плагина, чтобы удалить сохраненные данные учетной записи после удаления плагина.',
        orphanedEntryTitle: 'Удалить сохраненные данные плагина',
        orphanedEntrySubtitle: 'Введите установленный или удаленный идентификатор плагина, чтобы навсегда удалить данные текущей учетной записи.',
        promptTitle: 'Идентификатор плагина',
        promptBody: 'Введите идентификатор плагина, сохраненные данные которого вы хотите удалить из текущей учетной записи.',
        promptPlaceholder: 'com.example.plugin',
        invalidTitle: 'Введите идентификатор плагина',
        invalidBody: 'Прежде чем продолжить, используйте точный идентификатор плагина.',
        confirmTitle: 'Удалить данные плагина учетной записи?',
        confirmBody: ({ pluginId }: { pluginId: string }) => `Это навсегда удалит сохраненные данные для ${pluginId} с текущего счета. Он не удаляет плагин с ваших компьютеров.`,
        confirm: 'Стереть данные',
        completedTitle: 'Данные плагина учетной записи удалены.',
        completedChanged: 'Сохраненные данные плагина были удалены из текущей учетной записи.',
        completedEmpty: 'Для этого плагина в текущей учетной записи не обнаружено сохраненных данных плагина.',
        partialTitle: 'Некоторые данные плагина остаются',
        partialBody: 'Некоторые сохраненные данные невозможно удалить. Ничто не будет повторяться автоматически; повторите попытку стереть оставшиеся данные.',
        failedTitle: 'Данные плагина не были удалены',
        failedBody: 'Сохраненные данные невозможно удалить. Повторите попытку после проверки текущего подключения к учетной записи.',
        unavailableTitle: 'Данные плагина недоступны',
        unavailableBody: 'Текущая учетная запись изменена или недоступна. Повторно откройте это действие после того, как учетная запись будет готова.',
    },
} } as const;

return { pluginAccountDataEraseTranslations };
})();

const Domain_pluginAccountReleaseSelectionTranslations = (() => {
const english = Shared_pluginAccountReleaseSelectionTranslations.english;

const completeReleaseSelection = Shared_pluginAccountReleaseSelectionTranslations.completeReleaseSelection;

const localizedPluginAccountReleaseSelectionTranslations = { ru: {
    accountReleaseSelection: {
        groupTitle: 'Выпуск аккаунта',
        groupFooter: 'Выберите точную версию для этой учетной записи. При этом плагин не устанавливается, не обновляется и не доверяется ему ни на одном компьютере.',
        entryTitle: 'Использовать для этой учетной записи',
        entrySubtitle: ({ version }: { version: string }) => `Выберите версию ${version} для текущей учетной записи без изменения установки машины.`,
        selectedTitle: 'Выбран выпуск аккаунта',
        selectedBody: 'Выбранная версия плагина теперь будет использоваться для этой учетной записи.',
        conflictTitle: 'Версия аккаунта изменена',
        conflictBody: 'Релиз учетной записи изменился, пока это действие было открыто. Откройте его и повторите попытку.',
        unavailableTitle: 'Освобождение аккаунта недоступно',
        unavailableBody: 'Точная версия или необходимый источник миграции недоступен для текущей учетной записи. Повторите попытку, когда учетная запись будет готова.',
        rejectedTitle: 'Освобождение аккаунта не выбрано',
        rejectedBody: 'Учетная запись не приняла этот выбор выпуска. Проверьте состояние учетной записи и повторите попытку.',
        hostedGroupFooter: 'Управляйте артефактами, которые эта учетная запись размещает для плагина. Сейчас ни один компьютер не предлагает этот выпуск, поэтому выбрать его здесь нельзя.',
        hostedEnableTitle: 'Размещать артефакты для этой учетной записи',
        hostedEnableBody: "Сохраняет интерфейс и ресурсы пакета на сервере аккаунта. Для незашифрованных аккаунтов сервер может читать данные; при E2EE он хранит зашифрованные данные. Метаданные версии остаются видимыми. Это не устанавливает плагин, не подтверждает доверие и не позволяет выполнять его на отключённом компьютере.",
        hostedDisableTitle: 'Прекратить размещение артефактов',
        hostedStatusDisabled: "Отключено. Включите размещение, чтобы загружать артефакты этой версии, когда исходный компьютер офлайн.",
        hostedStatusPending: 'Включено. Этот выпуск ожидает, пока хост опубликует его точные артефакты.',
        hostedStatusReady: 'Размещенные артефакты доступны для этого точного выпуска.',
        hostedRemoveTitle: 'Отключить размещение и удалить артефакты',
        hostedRemoveBody: 'Останавливает размещение в учетной записи и удаляет точные размещенные артефакты этого выпуска. Очистка локального кэша выполняется отдельно.',
        hostedClearCacheTitle: 'Очистить локальный кэш артефактов',
        hostedClearCacheBody: 'Удаляет локально закэшированные байты UI-артефактов этого точного выпуска, не изменяя размещение в учетной записи.',
    },
} } as const;

const pluginAccountReleaseSelectionTranslations = { ru: completeReleaseSelection(localizedPluginAccountReleaseSelectionTranslations.ru) };

return { localizedPluginAccountReleaseSelectionTranslations, pluginAccountReleaseSelectionTranslations };
})();

const Domain_pluginInvocationLogTranslations = (() => {
const en = Shared_pluginInvocationLogTranslations.en;

const ru = {
    invocationLogs: {
        title: 'Журналы вызовов',
        footer: 'Ограниченная выборка записей с маскировкой данных с выбранной машины плагина.',
        correlationFilter: 'Фильтр по идентификатору корреляции',
        correlationFilterAll: 'Все вызовы этого плагина',
        correlationPromptTitle: 'Фильтровать по идентификатору корреляции',
        correlationPromptBody: 'Показывать только записи одного точного вызова плагина. Оставьте поле пустым, чтобы показать все записи.',
        correlationPromptPlaceholder: 'Идентификатор корреляции',
        refresh: 'Обновить журналы',
        follow: 'Отслеживать журналы',
        stopFollowing: 'Остановить отслеживание',
        loadMore: 'Загрузить следующие записи',
        loadingTitle: 'Загрузка журналов вызовов',
        loadingSubtitle: 'Чтение ограниченных записей с маскировкой данных с выбранной машины.',
        idleTitle: 'Журналы вызовов готовы к чтению',
        idleSubtitle: 'Обновите список, чтобы прочитать ограниченные записи с маскировкой данных с выбранной машины.',
        emptyTitle: 'Журналов вызовов нет',
        emptySubtitle: 'На выбранной машине нет подходящих записей с маскировкой данных.',
        unavailableTitle: 'Журналы вызовов недоступны',
        unavailableSubtitle: 'Выбранная машина плагина недоступна или больше не является текущей.',
        readerUnavailableSubtitle: 'Выбранная машина плагина сейчас не может предоставить журналы вызовов.',
        selectionRequiredTitle: 'Выберите машину плагина',
        selectionRequiredSubtitle: 'Перед чтением журналов выберите выше одну совместимую материализацию плагина.',
        conflictTitle: 'Устраните конфликт выбранной машины плагина',
        conflictSubtitle: 'Перед чтением журналов выберите выше одну совместимую материализацию плагина.',
        errorTitle: 'Не удалось загрузить журналы вызовов',
        errorSubtitle: 'Чтение журналов не завершилось. Повторите попытку, когда выбранная машина станет доступна.',
        noMessage: 'Событие журнала плагина',
        level: {
            debug: 'Отладка',
            info: 'Информация',
            warn: 'Предупреждение',
            error: 'Ошибка',
            diagnostic: 'Диагностика',
        },
    },
};

const pluginInvocationLogTranslations = { ru } as const;

return { pluginInvocationLogTranslations };
})();

const Domain_pluginMachineMatrixTranslations = (() => {
const english = Shared_pluginMachineMatrixTranslations.english;

const pluginMachineMatrixTranslations = { ru: {
        machineMatrix: {
            title: 'На ваших машинах',
            footer: 'Только для просмотра. Установка, обновление и любые другие действия с плагином выполняются на выбранной выше машине.',
            empty: 'Ни одна машина ещё не сообщила об установке плагинов для этого аккаунта.',
            unavailable: 'Доступность плагинов аккаунта ещё не загружена, поэтому состояния машин неизвестны.',
            incomplete: ({ count }: { count: number }) => `Список может быть неполным: ${count} сервер(ов) ещё не сообщили о своих машинах.`,
            summary: ({ installed, total }: { installed: number; total: number }) => `Установлен и актуален на ${installed} из ${total} машин`,
            lastObserved: ({ ago }: { ago: string }) => `последний раз: ${ago}`,
            state: {
                installedCurrent: 'Установлен и актуален',
                disabled: 'Отключён',
                untrusted: 'Без доверия',
                incompatible: 'Другой выпуск',
                localOnly: 'Только на этой машине',
                staleOffline: 'Последнее известное состояние, машина офлайн',
                absent: 'Не установлен',
                unknown: 'Неизвестно',
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

const marketplacePresentation = { ru: {
        diagnosticsIssueTitle: 'Проблема плагина', diagnosticsRecovery: 'Изучите сведения выше, затем после исправления перезагрузите плагин или эту страницу.', diagnosticsTechnicalCode: ({ code }: { code: string }) => `Технический код: ${code}`,
        discover: { publisherLabel: ({ displayName, id }: { displayName: string; id: string }) => `Метка издателя: ${displayName} (${id})`, categories: ({ values }: { values: string }) => `Категории: ${values}`, runtimeSummary: ({ realms, platforms }: { realms: string; platforms: string }) => `Запускается в: ${realms} · Платформы: ${platforms}`, reviewStatus: { curated: 'Отобранная рекомендация', unreviewed: 'Не проверено', withdrawn: 'Отозвано' }, executableRealm: { daemon: 'фоновая служба', client: 'приложение', hostedWeb: 'размещённый веб' }, platform: { darwin: 'macOS', linux: 'Linux', windows: 'Windows', web: 'Веб', ios: 'iOS', android: 'Android' }, diagnostic: { title: 'Проблема источника маркетплейса', recovery: 'Обновите раздел «Обзор». Если проблема останется, проверьте «Источники и реестры».', unreachableTitle: ({ source }: { source: string }) => `Не удалось связаться с ${source}`, behindTitle: ({ source }: { source: string }) => `${source} вернул устаревшие или неполные данные`, indexTitle: 'Индекс плагинов неполон', otherSourcesShown: 'Результаты других источников по-прежнему показаны.' } },
    } } as const;

const localizedTechnicalReviewVocabulary = { ru: { source: ({ kind, locator }: { kind: string; locator: string }) => `${kind}: ${locator}`, sourceKind: { path: 'Локальный путь', archive: 'Архивный файл', npm: 'Пакет npm' }, marketplaceSource: ({ kind, source }: { kind: string; source: string }) => `${kind}: ${source}`, marketplaceSourceKind: { curated: 'Отобранный каталог', 'community-npm': 'Открытый каталог npm', user: 'Пользовательский каталог' }, executableRealm: { daemon: 'Код фоновой службы', reactNative: 'Код интерфейса приложения', hostedWeb: 'Изолированный размещённый веб-код' }, uiArtifacts: ({ status, ids }: { status: string; ids: string }) => `${status}: ${ids}`, uiArtifactStatus: { verified: 'Проверенные ресурсы интерфейса', none: 'Нет ресурсов интерфейса', unavailable: 'Ресурсы интерфейса недоступны' }, authorizationClass: { cooperativeDisclosure: 'Совместное раскрытие', hostResourceSelection: 'Выбранные ресурсы хоста', presentIntentOrOs: 'Текущее намерение или разрешение системы' }, priority: ({ priority }: { priority: number }) => `Приоритет ${priority}` } } as const;

const localizedReviewVocabulary = { ru: {
        installReviewSections: {
            ...localizedTechnicalReviewVocabulary.ru,
            archiveUrlRetention: 'Happier сохраняет полный URL архива на выбранной машине, включая возможные учётные данные, для будущих обновлений. Истёкший или отозванный URL может привести к сбою обновления.',
            trustedCodeTitle: 'Доверенный код', trustedCodeDisclosure: 'Плагины выполняются как доверенный код внутри Happier, а не в песочнице. Плагин может напрямую использовать полномочия самого приложения — файлы, сеть, окружение и процессы — за пределами перечисленных ниже служб, посредником в которых выступает Happier. Этот список — то, что плагин заявил и что вы сможете отключить позже, а не граница того, куда может дотянуться его код.', identity: 'Идентификатор и пакет', evidence: 'Технические сведения', executableCode: 'Исполняемый код и расширения', requiredAccess: 'Обязательный доступ к хосту', optionalAccess: 'Необязательный доступ к хосту', requestInterceptors: 'Перехватчики запросов', rawCredentials: 'Декларации прямого доступа к учетным данным', compatibility: 'Совместимость и обновления', none: 'Ничего не заявлено', scope: ({ scope }: { scope: string }) => `Область: ${scope}`, developmentPath: ({ locator }: { locator: string }) => `${locator} · разработка`, publisherUnverified: ({ displayName, id }: { displayName: string; id: string }) => `${displayName} · ${id} · не проверено`, integrityBasis: { expected: ({ integrity }: { integrity: string }) => `${integrity} (ожидаемая)`, observed: ({ integrity }: { integrity: string }) => `${integrity} (наблюдаемая)` }, signatureStatus: { verified: ({ keyId }: { keyId: string }) => `Подпись реестра проверена: ${keyId}`, unsupported: ({ keyId }: { keyId: string }) => `Неподдерживаемая подпись реестра: ${keyId}` }, provenanceDeclaredUnverified: ({ predicateType }: { predicateType: string }) => `Заявлено без проверки: ${predicateType}`, provenanceRetrievedUnverified: ({ predicateTypes }: { predicateTypes: string }) => `Получено без проверки: ${predicateTypes}`, provenanceUnavailable: ({ code }: { code: string }) => `Сведения о происхождении недоступны: ${code}`, curationUnreviewed: ({ sourceId }: { sourceId: string }) => `Непроверенный источник каталога: ${sourceId}`, curationApproved: ({ sourceId, reviewedAt, reason }: { sourceId: string; reviewedAt: string; reason: string }) => `Проверено ${sourceId}, ${reviewedAt}${reason}`, savedSecret: 'Сохраненный секрет', connectedAccount: 'Подключенная учетная запись', secretKinds: ({ kinds }: { kinds: string }) => `Типы секретов: ${kinds}`, connectedAccountService: ({ service }: { service: string }) => `Служба: ${service}`, credentialPurpose: ({ purpose }: { purpose: string }) => `Назначение: ${purpose}`, credentialUse: ({ realm, phase }: { realm: string; phase: string }) => `Использование: ${realm}, этап «${phase}»`, credentialAccess: ({ access }: { access: string }) => `Доступ: ${access}`, credentialRequestHeaders: ({ origin, headers }: { origin: string; headers: string }) => `Заголовки, отправляемые на ${origin}: ${headers}`, credentialRequestEnvironment: ({ keys }: { keys: string }) => `Переменные среды: ${keys}`, credentialRequestFiles: ({ files }: { files: string }) => `Файлы: ${files}`, realm: { web: 'веб-клиент', ios: 'приложение iOS', android: 'приложение Android', daemon: 'фоновая служба' }, phase: { settings: 'настройка', prepare: 'подготовка', connection: 'подключение', speech: 'голосовой режим' }, runtimeApi: ({ version }: { version: number }) => `API среды выполнения ${version}`,
        },
        sourceAdministration: { title: 'Источники и реестры', subtitle: 'Выберите, где эта машина ищет точные пакеты npm и как подключается к их реестрам.', communityTitle: 'Открытый каталог npm', communitySubtitle: 'Встроенный поиск подходящих плагинов Happier в публичном npm, а не произвольных пакетов. Результаты не проверены.', configuredTitle: 'Источники маркетплейса', configuredEmpty: 'Дополнительные источники маркетплейса не настроены.', add: 'Добавить источник', edit: 'Изменить источник', remove: 'Удалить источник', removeTitle: 'Удалить источник маркетплейса?', removeBody: ({ name }: { name: string }) => `${name} больше не будет использоваться для поиска на этой машине. Установленные плагины не изменятся.`, sourceUrl: 'Адрес источника', displayName: 'Отображаемое имя', description: 'Описание (необязательно)', enabled: 'Включен', disabled: 'Отключен', curated: 'Отобранный источник', user: 'Ваш источник', loadError: 'Не удалось загрузить источники маркетплейса.', retry: 'Повторить', operationFailed: 'Не удалось применить изменение. Проверьте подключение к машине и повторите попытку.', operationOutcomeUnknownTitle: 'Изменение требует проверки', operationOutcomeUnknownBody: 'Выбранная машина могла уже применить это изменение, но Happier не удалось подтвердить результат. Проверьте обновленные настройки, прежде чем менять их снова.' },
        updatePolicy: { title: 'Правило обновлений', target: ({ machine, server }: { machine: string; server: string }) => `Действует на ${machine} через ${server}.`, pinned: 'Закрепленная версия', pinnedSubtitle: 'Не обновлять, пока не выбрано другое правило.', allowed: 'Обновления разрешены', allowedSubtitle: 'Явные обновления выполняются без нового запроса, пока заявленные полномочия не расширяются.' },
    } } as const;

const pluginMarketplaceDiscoverTranslations = { ru: {
        ...localizedReviewVocabulary.ru,
        ...marketplacePresentation.ru,
        secretFieldActions: { delete: 'Удалить сохраненный секрет', deleteHint: 'Стирает сохраненное значение. Отменить это нельзя.', unbind: 'Отвязать от этого плагина', unbindHint: 'Отсоединяет сохраненный секрет от этой настройки. Сам секрет остается.' },
        pluginChangeOutcomeUnknownTitle: 'Результат не подтвержден',
        pluginChangeOutcomeUnknownBody: ({ action, name, machine, server }: { action: string; name: string; machine: string; server: string }) => `Happier не смог подтвердить, завершилось ли действие «${action}» для ${name} на ${machine} (${server}). Откройте список установленных на этой машине и проверьте текущую версию, прежде чем повторять.`,
        updateFromInstalledRecordSubtitle: 'Обновить эту установку по её собственному доверенному каналу обновлений.',
        discover: {
            ...marketplacePresentation.ru.discover,
            status: {
                loading: 'Поиск по всем источникам маркетплейса…',
                loadingSource: ({ source }: { source: string }) => `Поиск в источнике ${source}…`,
                results: ({ count, sources }: { count: number; sources: number }) =>
                    `Плагинов: ${count}; источников: ${sources}`,
                empty: 'По этому запросу плагины не найдены.',
                error: ({ message }: { message: string }) => `Не удалось обновить поиск: ${message}`,
                errorTitle: 'Не удалось обновить поиск',
                stale: 'Эти результаты относятся к предыдущему запросу. Выполните поиск снова, чтобы применить настройки выше.',
                partial: ({ count }: { count: number }) =>
                    `Источников с устаревшими или отсутствующими данными: ${count}. Результаты могут быть неполными.`,
                nonInstallable: ({ count }: { count: number }) =>
                    `Найдено записей, которые сейчас нельзя установить на этой машине: ${count}.`,
            },
            sourceFreshness: {
                stale: 'Старее, чем этот источник',
                'stale-offline': 'Последние известные результаты, источник офлайн',
                unavailable: 'Источник недоступен',
                'auth-unavailable': 'Для этого источника нужен вход',
                corrupt: 'Индекс источника не удалось прочитать',
            },
            nonInstallableReason: {
                sourceStale: 'Его источник маркетплейса неактуален.',
                artifactUnavailable: 'Его пакет недоступен с текущим доступом к реестру на этой машине.',
                notApproved: 'Установка из этого источника не одобрена.',
                unsupportedSourceKind: 'Этот вид источника не поддерживается в этой версии Happier.',
            },
            installSubtitle: ({ source }: { source: string }) =>
                `Проверьте всё, что объявляет плагин, прежде чем доверять чему-либо из источника ${source}.`,
            registrySelectionRequired: ({ origin }: { origin: string }) => `Нужен профиль реестра для ${origin}`,
            registrySelection: {
                title: ({ name }: { name: string }) => `Выберите реестр для ${name}`,
                body: ({ name, origin, source }: { name: string; origin: string; source: string }) =>
                    `${name} опубликован в ${origin}. Выберите профиль реестра, который ${source} использует на этой машине, или добавьте его и войдите. Ничего не загружается до проверки установки и доверия.`,
                continue: 'Продолжить',
            },
        },
    } } as const;

return { marketplacePresentation, localizedTechnicalReviewVocabulary, localizedReviewVocabulary, pluginMarketplaceDiscoverTranslations };
})();

const Domain_pluginPermissionTranslations = (() => {
type PermissionDetailsTranslation = Shared_pluginPermissionTranslations.PermissionDetailsTranslation;

const pluginPermissionTranslations = { ru: {
        fields: {
            pluginId: 'Идентификатор плагина',
            capability: 'Возможность',
            scope: 'Область',
            requester: 'Инициатор',
            authority: 'Источник разрешения',
            requestedAt: 'Время запроса',
            reason: 'Причина',
        },
        scope: { account: 'Учётная запись', project: 'Проект', workspace: 'Рабочая область' },
        requester: { user: 'Пользователь', host: 'Хост', plugin: 'Плагин' },
        authority: { bundled: 'Встроенный', machineInstallation: 'Установка на машине' },
        identifiers: {
            session: 'Сеанс',
            request: 'Запрос',
            machine: 'Машина',
            installation: 'Установка',
        },
        accessibilitySummary: ({ details }) => `Сведения о запросе разрешения. ${details}`,
    } } as const satisfies Pick<Readonly<Record<string, PermissionDetailsTranslation>>, "ru">;

return { pluginPermissionTranslations };
})();

const Domain_pluginSettingsPresentationTranslations = (() => {
const english = Shared_pluginSettingsPresentationTranslations.english;

const pluginSettingsPresentationTranslations = { ru: {
        rowStatus: { enabled: 'Включено', disabled: 'Отключено', incompatible: 'Несовместимо', trustRemoved: 'Доверие отозвано', needsAttention: 'Требует внимания' },
        developmentPhase: { observing: 'Наблюдение', preparingDependencies: 'Подготовка зависимостей', compiling: 'Компиляция', validating: 'Проверка', active: 'Активно', retainedIncumbent: 'Предыдущая версия активна', unavailable: 'Недоступно' },
        rowSource: { bundled: 'Входит в Happier', npm: 'Пакет npm', archive: 'Архивный файл', localPath: 'Локальная папка', other: 'Настроенный источник' },
        rowAttention: { trustRemoved: 'Этот плагин больше не запускается. Установите его заново, чтобы снова доверять его коду.', incompatible: 'Этот выпуск не может работать на выбранной машине.' },
        developerGroupTitle: 'Разработка',
        developerGroupFooter: 'Создавайте плагины на выбранной машине и смотрите, что сообщает её служба.',
        developerDevelopmentSubtitle: 'Создавайте, редактируйте, тестируйте и упаковывайте плагины из своих папок.',
        developerDiagnosticsSubtitle: 'Диагностика службы и каталога для выбранной машины.',
        detailMissingTitle: 'Этого плагина нет на выбранной машине',
        detailMissingBody: ({ pluginId }: { pluginId: string }) => `${pluginId} здесь не установлен. Возможно, он был удалён или находится на другой машине.`,
        detailMissingRetry: 'Проверить снова',
        surfaces: {
            purpose: 'Добавляйте в Happier поверхности, команды и интеграции. Плагины работают как доверенный код на ваших компьютерах.',
            navigationTitle: 'Плагины',
            updatesTitle: 'Обновления',
            moreDescriptionInSettings: 'Откуда берутся плагины, создание своих и что сообщает этот компьютер. Эти страницы открываются в настройках.',
            fix: 'Исправить',
            allSources: 'Все источники',
            shelfCurated: 'Подборка',
            shelfCuratedDescription: 'Проверены и рекомендованы Happier. Каждая установка всё равно показывает полную проверку.',
            shelfCommunity: 'Сообщество',
            shelfCommunityDescription: 'Непроверенные пакеты npm. «Установить и доверять» показывает, к чему именно получает доступ каждый.',
            shelfUser: 'Ваши источники',
            shelfUserDescription: 'Записи из источников маркетплейса, добавленных на этом компьютере.',
            manage: 'Управлять',
            installed: 'Установлен',
            notShownTitle: 'Не всё удалось показать',
            listingInstallsOn: ({ machine }: { machine: string }) => `Устанавливается на ${machine}. Вы проверите доступ до любого запуска.`,
            listingChooseMachine: 'Выберите компьютер в заголовке, чтобы установить этот плагин.',
            listingRunsIn: 'Работает в',
            listingPlatforms: 'Платформы',
            listingSource: 'Источник',
            listingCategories: 'Категории',
            listingNotFoundTitle: 'Эта запись недоступна',
            listingNotFoundBody: 'Возможно, её удалили из источника, или этот компьютер сейчас не может связаться с источником.',
            developmentSourcesTitle: 'Плагины в разработке',
            chooseMachineInstalled: 'Выберите компьютер в заголовке, чтобы увидеть его плагины.',
            chooseMachineBrowse: 'Выберите компьютер в заголовке, чтобы просмотреть плагины, которые он может установить.',
            openAsPage: 'Открыть страницей',
            detailInstalledLabel: 'Установленный плагин',
            detailListingLabel: 'Карточка плагина',
            viewLabel: 'Показывать как',
            viewGrid: 'Сетка',
            viewList: 'Список',
            installedSearchPlaceholder: 'Искать среди установленных плагинов',
            statusFilterLabel: 'Показать плагины',
            statusAll: 'Все плагины',
            statusEnabled: 'Включённые',
            statusDisabled: 'Отключённые',
            statusAttention: 'Требуют внимания',
            noMatch: ({ query }: { query: string }) => `Нет плагинов по запросу «${query}»`,
            clearSearch: 'Сбросить',
            emptyTitle: 'Плагины ещё не установлены',
            emptyBody: 'Плагины добавляют панели, команды и инструменты для ваших агентов. Начните с плагинов от Happier.',
            browsePlugins: 'Обзор плагинов',
            browseEmpty: 'В ваших источниках пока нет плагинов.',
            forDevelopers: 'Для разработчиков',
            readFailedTitle: 'Не удалось прочитать плагины этого компьютера',
            readFailedBody: 'Ничего не изменилось. Повторите, чтобы снова запросить компьютер.',
            lastKnown: ({ status }: { status: string }) => `Последнее известное · ${status}`,
            machinesTitle: 'Компьютеры',
            machinesDescription: 'Где установлен этот плагин.',
            machinesCurrent: ({ current, total }: { current: number; total: number }) => `Актуален на ${current} из ${total} компьютеров`,
            onMachines: ({ count }: { count: number }) => `На ${count} машинах`,
            onMachine: ({ machine }: { machine: string }) => `На ${machine}`,
            addedGroup: 'Добавленные',
            machinesRetained: 'Компьютер, которого больше нет в этом аккаунте',
            open: 'Открыть',
            review: 'Проверить',
            seeAll: 'Показать все',
            allResults: 'Все результаты',
            categoriesLabel: 'Категории',
            runOnNoneChosen: 'Машина не выбрана',
            runOnNoneAvailable: 'Пока ни одна машина не может его запустить',
            runsEverywhere: 'На каждой машине с Happier',
            kinds: {
                agent: 'Агент',
                providers: 'Поставщик моделей',
                scmHostingProviders: 'Хостинг кода',
                scmBackends: 'Контроль версий',
                voice: 'Голос',
                connectedAccounts: 'Подключённый сервис',
                inputTypes: 'Типы ввода',
                mcp: 'Инструменты MCP',
                pluginUi: 'Панели приложения',
                pluginBrowser: 'Представления браузера',
                composer: 'Инструменты редактора',
            },
        },
    } } as const;

return { pluginSettingsPresentationTranslations };
})();

const Domain_pluginUpdateReviewTranslations = (() => {
const en = Shared_pluginUpdateReviewTranslations.en;

const ru = {
    title: 'Проверка обновлений',
    confirmSubtitle: 'Обновления, расширяющие выданный доступ, сначала спрашивают.',
    autoApplySubtitle: 'Обновления применяются без вопросов, даже если расширяют доступ.',
    confirmOption: 'Спрашивать',
    autoApplyOption: 'Автоматически',
};

const pluginUpdateReviewTranslations = { ru: ru };

return { pluginUpdateReviewTranslations };
})();

const Domain_pluginWebhookAdministrationTranslations = (() => {
const english = Shared_pluginWebhookAdministrationTranslations.english;

const pluginWebhookAdministrationTranslations = { ru: {
    webhookAdministration: {
        title: 'Плагин вебхуков',
        footer: 'Конечные точки учетной записи, точные целевые машины, очереди доставки и восстановление недоставленных сообщений. Органы доставки здесь никогда не отображаются.',
        unavailableTitle: 'Вебхуки плагинов недоступны',
        unavailableSubtitle: 'На этом сервере приём вебхуков плагинов не включён.',
        endpointsTitle: 'Конечные точки вебхука',
        emptyTitle: 'Нет конечных точек веб-перехватчика плагина',
        emptySubtitle: 'Конечные точки, созданные установленными плагинами, останутся здесь видимыми, включая конечные точки, цель которых недоступна.',
        loadError: 'Не удалось загрузить статус вебхука.',
        endpointSubtitle: ({ readiness, routing, sourceInstanceId }: { readiness: string; routing: string; sourceInstanceId: string }) => `${readiness} · ${routing} · ${sourceInstanceId}`,
        targetSubtitle: ({ machineId, materializationId, status }: { machineId: string; materializationId: string; status: string }) => `${machineId} / ${materializationId} · ${status}`,
        queueSubtitle: ({ queued, retrying, claimed, deadLetter }: { queued: number; retrying: number; claimed: number; deadLetter: number }) => `В очереди ${queued} · повторная попытка ${retrying} · заявленный ${claimed} · мертвое письмо ${deadLetter}`,
        copyUrl: 'Скопировать URL-адрес вебхука',
        selectTarget: 'Выберите цель доставки',
        retarget: 'Перенацелить конечную точку',
        retargetUnavailable: 'Прежде чем перенацелить эту конечную точку, выберите доступную точную материализацию плагина.',
        originSelected: 'Выбранная точная материализация плагина будет перепроверена, когда вы продолжите.',
        originUnavailable: 'Никакая точная доступная материализация плагина не выбрана.',
        movePendingTitle: 'Переместить ожидающие поставки?',
        movePendingBody: 'Переместить поставки в очереди и недоставленные письма в новую точную цель? Активно заявленные поставки остаются на текущем уровне.',
        resumePendingMove: 'Возобновить перемещение в ожидании доставки',
        resumePendingMoveSubtitle: ({ count }: { count: number }) => `${count} доставки в очереди или недоставленные письма по-прежнему используют предыдущую точную цель.`,
        configureCredential: 'Настройка учетных данных для подписи',
        rotateCredential: 'Поворот учетных данных для подписи',
        finishRotation: 'Завершить ротацию учетных данных',
        finishRotationSubtitle: 'Прекратите принимать предыдущие учетные данные сейчас.',
        credentialSecretTitle: 'Сохраните новый секрет подписи.',
        credentialSecretBody: ({ secret }: { secret: string }) => `Этот секрет раскрывается один раз. Сохраните его, прежде чем закрыть это сообщение.\n\n${secret}`,
        revoke: 'Отозвать конечную точку',
        revokeTitle: 'Отозвать конечную точку вебхука?',
        revokeBody: 'Новые поставки в эту конечную точку будут отклонены. Существующие метаданные доставки остаются доступными в соответствии с политикой хранения.',
        operationFailed: 'Операция веб-перехватчика не завершена. Обновите текущий статус, прежде чем повторить попытку.',
        deliveryTitle: ({ digest }: { digest: string }) => `Мертвое письмо ${digest}`,
        deliveryStatus: 'Статус доставки',
        deliverySubtitle: ({ errorCode, attempts, replays, machineId, materializationId }: { errorCode: string; attempts: number; replays: number; machineId: string; materializationId: string }) => `${errorCode} · ${attempts} попытки · ${replays} повторы · ${machineId} / ${materializationId}`,
        unresolvedAutomationAdmissionTitle: ({ totalCount }: { totalCount: number }) => `${totalCount} нерешенные поступления в автоматизацию`,
        unresolvedAutomationAdmissionSubtitle: ({ sample, omittedCount }: { sample: string; omittedCount: number }) => `Образец: ${sample} · ${omittedCount} не показано`,
        replay: 'Доставка повтора',
        discardTitle: 'Отказаться от доставки?',
        discardBody: 'Зашифрованное или простое сохраненное тело доставки будет удалено и не подлежит восстановлению.',
    },
} } as const;

return { pluginWebhookAdministrationTranslations };
})();

const Domain_profilesPageTranslations = (() => {
const english = Shared_profilesPageTranslations.english;

const translated = Shared_profilesPageTranslations.translated;

const profilesPageTranslations = { ru: translated({
        profilesPage: {
            searchPlaceholder: 'Поиск профилей',
            emptyTitle: 'Профилей пока нет',
            newProfileTitle: 'Новый профиль',
            notFoundTitle: 'Этого профиля больше нет',
            notFoundDescription: 'Возможно, его удалили на другом устройстве.',
            backToProfiles: 'К профилям',
            discardDraft: 'Отменить',
            detailDescription: 'Используется, когда новая сессия запускается с этим профилем.',
            builtInDetailDescription: 'Готовый профиль. При сохранении изменений создаётся ваша собственная копия.',
            enabledHint: 'Предлагается при выборе профиля для новой сессии.',
            pickerSection: 'Выбор профиля',
            pickerSectionDescription: 'Где этот вариант появляется при запуске сессии.',
            showFirst: 'Показывать первым',
            showFirstDescription: 'Показывает окружение машины среди избранного.',
            environmentDescription: 'Переменные окружения, которые задаются при запуске сессии с этим профилем. Значения могут ссылаться на переменные машины.',
            descriptionTitle: 'Описание',
            descriptionHint: 'Необязательно. Показывается при выборе этого профиля.',
        },
    }) };

return { profilesPageTranslations };
})();

const Domain_providerCollectionTranslations = (() => {
type ProviderCollectionCopy = Shared_providerCollectionTranslations.ProviderCollectionCopy;

const en = Shared_providerCollectionTranslations.en;

const ru: ProviderCollectionCopy = {
    settingsProvidersCollection: {
        description: 'Подключите источник моделей один раз и используйте его модели со всеми совместимыми агентами.',
        foundOn: ({ machine }: { machine: string }) => `Найдено на ${machine}`,
        foundOnThisMachine: 'Найдено на этой машине',
        connect: 'Подключить',
        start: 'Запустить',
        test: 'Проверить',
        addProvider: 'Добавить провайдера',
        customEndpoint: 'Свой эндпоинт',
        menuOwnCategory: 'Свои',
        menuCatalogCategory: 'Из каталога',
        newTitle: 'Новый провайдер',
        emptyDescription: 'Добавьте провайдера из каталога или свой совместимый эндпоинт.',
        machineScopeLabel: 'Настроено на',
        invitationTitle: 'Используйте свои модели',
        invitationDescription: 'Подключите провайдера один раз, и его модели появятся в выборе моделей каждого совместимого агента. Локальные серверы, такие как Ollama, работают на вашей машине.',
        invitationNeedsMachine: 'Провайдеры подключаются и проверяются на одной из ваших машин. Добавьте машину, чтобы начать.',
        setUpMachine: 'Настроить машину',
        duplicateAsCustom: 'Скопировать как свой провайдер',
        discard: 'Отменить',
        enabled: 'Включён',
        enabledDescription: 'Показывать его модели в выборе моделей агентов',
        saved: 'Сохранён',
        replace: 'Заменить',
        addKey: 'Выбрать ключ',
        apiKeyDefaultDescription: 'Используется на всех машинах, если у машины нет своего ключа.',
        apiKeyMachineDescription: 'Используется на этой машине вместо ключа по умолчанию.',
        availabilityTitle: 'Доступность',
        availabilityDescription: 'Где агенты могут использовать этого провайдера.',
        modelsDescription: 'Выберите, какие модели агенты показывают в выборе моделей.',
        modelsShown: ({ shown, total }: { shown: number; total: number }) => `${shown} из ${total} показаны в выборе моделей`,
        modelsFilter: ({ count }: { count: number }) => `Фильтр по ${count} моделям`,
        connectionTitle: 'Подключение',
        nameDescription: 'Показывается в списке провайдеров и в выборе моделей.',
        nameRequired: 'Добавьте название.',
        nameTooLong: ({ max }: { max: number }) => `Используйте не более ${max} символов.`,
        managedTitle: 'Управляемый локальный сервис',
        endpointsTitle: 'Эндпоинты',
        endpointsDescription: 'Оставьте пустым, чтобы использовать адреса провайдера.',
        overridesDescription: 'Куда уходят запросы. Измените адрес для всех машин или только для этой.',
        afterSavingTitle: 'После сохранения',
        destinationDescription: 'Куда Happier будет отправлять запросы этого провайдера.',
        destinationPending: 'Появится, когда все эндпоинты будут заполнены.',
    },
};

const providerCollectionTranslations = { ru } as const;

return { providerCollectionTranslations };
})();

const Domain_providerSessionTranslations = (() => {
const providerSessionTranslations = { ru: {
        launchDefaultLabel: ({ provider }: { provider: string }) => `Провайдер: ${provider}`,
        launchNamedLabel: ({ provider, connection }: { provider: string; connection: string }) => `Провайдер: ${provider} · ${connection}`,
        changedTitle: 'Настройки провайдера изменились', changedBody: ({ provider, connection }: { provider: string; connection: string }) => `Эта сессия по-прежнему использует исходную конфигурацию ${provider} · ${connection}.`,
        unavailableTitle: 'Провайдер больше недоступен', unavailableBody: ({ provider, connection }: { provider: string; connection: string }) => `${provider} · ${connection} больше недоступен для возобновления этой сессии.`,
        disabledTitle: 'Провайдер выключен', disabledBody: ({ provider, connection }: { provider: string; connection: string }) => `Включите ${provider} · ${connection} перед возобновлением этой сессии.`,
        incompatibleTitle: 'Провайдер больше не совместим', incompatibleBody: ({ provider, connection }: { provider: string; connection: string }) => `${provider} · ${connection} больше не совместим с агентом этой сессии.`,
        restartAction: 'Перезапустить сессию', chooseModelAction: 'Выбрать модель',
    } } as const;

return { providerSessionTranslations };
})();

const Domain_reviewWalkthroughTranslations = (() => {
type Count = Shared_reviewWalkthroughTranslations.Count;

type ReviewWalkthroughTranslations = Shared_reviewWalkthroughTranslations.ReviewWalkthroughTranslations;

const en = Shared_reviewWalkthroughTranslations.en;

const ru: ReviewWalkthroughTranslations = {
    severityCount: ({ count, severity }) => `${count} ${severity}`,
    findingRefA11y: ({ label, title }) => `${label}: ${title}. Перейти к замечанию`,
    tag: { noFile: 'Без файла', outdated: 'Устарело', unplaced: 'Не удаётся привязать', notInStory: 'Вне разделов' },
    outdatedSummary: 'Код изменился после ревью.',
    askAboutFindingA11y: ({ title }) => `Спросить о замечании: ${title}`,
    tailTitle: 'Замечания без раздела',
    tailDescription: 'Остаются здесь, чтобы ничего не пропало, когда их строки не удаётся привязать.',
    inContext: 'в контексте',
    fromReviewAt: ({ time }) => `из ревью в ${time}`,
    reviewLabel: 'Ревью:',
    enginesOf: ({ count, total }) => `${count} из ${total}`,
    enginesFinished: 'движков завершили',
    enginesRunning: ({ count }) => (count === 1 ? '1 движок ещё проверяет' : `Ещё проверяют движков: ${count}`),
    fromEngines: ({ engines, inStory }) => `от ${engines} · ${inStory} в разборе`,
    and: ' и ',
    inStoryElsewhere: ({ inStory, elsewhere }) => `${inStory} в разборе, ${elsewhere} в других местах`,
    allInStory: 'все в разборе',
    seeded: {
        title: 'Написано после ревью новым запуском.',
        body: ({ reviewers, time }) => `Рассказчик не проверял код; каждое замечание здесь получено от ${reviewers} в ${time}.`,
        changed: ({ count }) => (count === 1 ? 'С тех пор изменился 1 файл.' : `С тех пор изменилось файлов: ${count}.`),
    },
    findingsFrom: ({ count, engine }) => (count === 1 ? `1 замечание от ${engine}` : `${count} замечаний от ${engine}`),
    publishedBefore: ({ time }) => `опубликованы в ${time}, до разбора`,
    steps: {
        reviewing: 'Идёт ревью',
        engineProgress: ({ done, running }) => `${done} готово · ${running} проверяет`,
        reviewed: ({ count }) => (count === 1 ? 'Проверено · 1 замечание' : `Проверено · ${count} замечаний`),
        reviewedShort: ({ count }) => `Проверено · ${count}`,
        engineReviewed: ({ engine, count }) => (count === 1 ? `${engine} · 1 замечание` : `${engine} · ${count} замечаний`),
        reviewedAt: ({ time }) => `Проверено в ${time}`,
        reviewAt: ({ time }) => `Ревью в ${time}`,
        partial: ({ count }) => (count === 1 ? 'Частичное ревью · 1 замечание' : `Частичное ревью · ${count} замечаний`),
        ready: 'Разбор готов',
        readyShort: 'Разбор',
        failed: 'Разбор не удался',
        narrating: 'Пересказ',
        narratorWriting: ({ narrator }) => `${narrator} пишет`,
        writing: 'Пишется разбор',
        writingShort: 'Пишется',
    },
    writingWithFindings: 'Пишется разбор с учётом замечаний…',
    dialog: {
        engines: 'Движки ревью',
        selected: ({ count }) => `Выбрано: ${count}`,
        loadingEngines: 'Поиск движков ревью…',
        noEngines: 'На машине этой сессии не может работать ни один движок ревью.',
        findingsOnly: 'только замечания',
        changes: 'Изменения',
        instructions: 'Инструкции',
        instructionsPlaceholder: 'На что должно смотреть ревью?',
        defaultInstructions: 'Проверь эти изменения на корректность, риски и недостающие тесты.',
        alsoWalkthrough: 'Также написать разбор',
        alsoWalkthroughBody: 'Когда замечания готовы, тот же запуск пишет разбор с ними в контексте. Ничто не читает изменения дважды.',
        narrator: 'Рассказчик',
        chooseNarrator: 'Выберите рассказчика',
        narratorSeveral: ({ count }) => `Проверяют движков: ${count}; одна модель пишет разбор по всем их замечаниям.`,
        narratorFindingsOnly: ({ engine }) => `${engine} возвращает замечания, а не текст. Модель напишет по ним разбор.`,
        noNarrator: 'Ни один из этих движков не может написать разбор. Добавьте движок с моделью или выключите разбор.',
        footerReviewThenWalkthrough: 'Сначала ревью, затем разбор',
        footerHandover: ({ reviewer, narrator }) => `${reviewer} проверяет · ${narrator} пишет`,
    },
    generated: {
        continues: ({ model }) => `${model} · продолжает ревью`,
        seeded: ({ model }) => `${model} · по замечаниям ревью`,
        handover: ({ narrator, engine }) => `${narrator}, по замечаниям ${engine}`,
    },
    partial: {
        failed: ({ engines }) => `Ревью ${engines} не завершилось.`,
        notClean: 'Это частичное ревью, а не чистый результат.',
        finishedWith: ({ engines, count }) => (count === 1 ? `${engines} завершил с 1 замечанием.` : `${engines} завершил, замечаний: ${count}.`),
        retry: ({ engine }) => `Повторить ${engine}`,
    },
    explain: { action: 'Объяснить замечания', running: 'Объясняются замечания', a11y: 'Попросить объяснить замечания в разборе', unknownModel: 'Неизвестная модель', requester: { user: 'пользователем', agent: 'агентом', plugin: 'плагином', automation: 'автоматизацией', workflow: 'рабочим процессом', unknown: 'неизвестным инициатором' }, header: ({ model, time, requester = 'вами' }) => `Объяснение ревью · ${model} · запрошено ${requester} в ${time} · не вердикт` },
    finished: {
        title: 'Ревью завершено',
        openFindings: 'Открыть замечания',
        walkMeThrough: 'Проведи меня по изменениям',
        andMore: ({ count }) => `и ещё ${count}`,
        continues: 'Продолжает этот запуск ревью: проверяющий пишет по тому, что уже прочитал. Повторного анализа нет.',
        narrates: ({ count }) => (count === 1
            ? 'Запуск ревью завершён. Новый запуск напишет разбор по этому замечанию и изменениям; повторного ревью не будет.'
            : `Запуск ревью завершён. Новый запуск напишет разбор по этим замечаниям (${count}) и изменениям; повторного ревью не будет.`),
    },
    started: {
        transcript: ({ engineCount, fileCount }) => `Ревью запущено · Движков: ${engineCount} · Файлов: ${fileCount}`,
        notStarted: ({ engines }) => `${engines} не запустился. Остальные проверяют.`,
        narrationFailed: 'Ревью запущено, но разбор запросить не удалось. Замечания всё равно придут.',
    },
};

const reviewWalkthroughTranslations = { ru: { reviewWalkthrough: ru } };

return { reviewWalkthroughTranslations };
})();

const Domain_rolesTranslations = (() => {
type RolesTranslations = Shared_rolesTranslations.RolesTranslations;

const rolesTranslations = { ru: {
        rail: {
            label: 'Роли',
            title: 'Роль',
            searchPlaceholder: 'Поиск ролей…',
            empty: 'Подходящих ролей нет.',
            footer: 'Роль несёт свои инструкции, движок и способ запуска, поэтому рабочие процессы остаются переносимыми.',
            manage: 'Управлять ролями',
            engineAppliesOnStart: 'Движок применяется при запуске этой роли',
            defaultEngine: 'Агент по умолчанию',
            activeAccessibilityLabel: 'Роли, роль используется',
        },
        settings: {
            description: 'Кто выполняет каждый вид работы. Процессы и оркестраторы запрашивают роль; роль говорит, как её выполнять.',
            count: ({ count }) => `Ролей: ${count}`,
            newRole: 'Новая роль',
            groupBuiltIn: 'Встроенные',
            groupYours: 'Ваши',
            groupShared: 'Доступные вам',
            groupPlugins: 'Из плагинов',
            edited: 'Изменена',
            sourceBuiltIn: 'Встроенная',
            sourceYours: 'Ваша',
            sourceShared: 'Доступна вам',
            sourcePlugin: ({ plugin }) => `Из ${plugin}`,
            migrated: 'из субагентов 0.2',
            migratedNote: 'Роли с пометкой «из субагентов 0.2» пришли из ваших указаний для субагентов: описание стало инструкциями, агент и модель — движком.',
            nameTitle: 'Название',
            newRoleName: 'Роль без названия',
            instructionsTitle: 'Инструкции',
            instructionsDescription: 'Что она делает, когда её использовать и как отчитываться. Агенты читают это, раздавая работу.',
            resetToDefault: 'Сбросить по умолчанию',
            readOnlyNote: 'Доступна вам для просмотра. Выбор движка и профиля остаётся вашим.',
            howItRunsTitle: 'Как она работает',
            engineTitle: 'Движок',
            engineDescription: 'Агент, модель и усилие.',
            engineFollowsDefault: 'Следует вашему агенту по умолчанию.',
            engineUnavailable: 'Здесь недоступен. Выберите движок.',
            runsAsTitle: 'Где запускается',
            runsAsSession: 'Сессия',
            runsAsBackgroundRun: 'Фоновый запуск',
            runsAsSessionDescription: 'Сессия, которую можно открыть и направлять.',
            runsAsBackgroundDescription: 'Работает в фоне и отчитывается; сессии для управления нет.',
            handsOffTitle: 'Без правок',
            handsOffDescription: 'Планирует и делегирует; сам файлы не правит.',
            secondOpinionTitle: 'Второе мнение',
            secondOpinionDescription: '«Рекомендуется» просит обдумать второе мнение перед pull request или завершением работы.',
            secondOpinionOff: 'Выкл.',
            secondOpinionEncouraged: 'Рекомендуется',
            enabledTitle: 'Доступна',
            enabledDescription: 'Предлагается в панели ролей и оркестраторам.',
            advancedTitle: 'Дополнительно',
            launchProfileTitle: 'Профиль запуска',
            launchProfileDescription: 'Окружение, разрешения, машина',
            launchProfileNone: 'Нет',
            profileUnavailable: 'Профиль недоступен',
            previewTitle: 'Что читают агенты',
            previewDescription: 'Блок, отправляемый с каждым ходом, в точности.',
            deleteRole: 'Удалить роль',
            deleteConfirmTitle: 'Удалить эту роль?',
            deleteConfirmBody: ({ name }) => `${name} будет удалена для вас и всех, с кем ею поделились. Сессии, которые её используют, сохранят свою копию.`,
            share: 'Поделиться…',
            sendCopyFailed: 'Не удалось отправить копию.',
            saveFailed: 'Не удалось сохранить роль.',
            loadFailed: 'Не удалось загрузить роли.',
            emptyDetailTitle: 'Выберите роль',
            emptyDetailBody: 'Выберите роль, чтобы увидеть её инструкции и запуск.',
        },
        delegation: {
            title: 'Делегирование',
            description: 'Как агенты передают работу другим агентам.',
            depthTitle: 'Глубина работы',
            approvalReviewer: 'Проверка разрешений',
            approvalReviewerDescription: 'Автоматическая разовая проверка запросов с низким риском. Для чувствительных действий нужно ваше согласие. Только режимы По умолчанию и Принимать изменения.',
            approvedByReviewer: 'Разрешено однократно проверкой разрешений',
            depthDescription: 'Сессии, фоновые запуски и процессы, запущенные агентами, могут запускать новые. Этот предел останавливает бесконечные цепочки. То, что вы запускаете сами, не ограничено.',
            depthSetting: 'Как далеко агенты могут передавать работу',
            depthSettingDescription: ({ count }) => `Уровней: ${count}. Дальше агенту предлагается сделать работу самому.`,
            ladderRoot: 'Работа, которую запускаете вы',
            ladderRootDetail: 'Запущено вами · без ограничений',
            ladderLevel: ({ level }) => `Уровень ${level}`,
            ladderLevelDetail: 'Запущено агентом',
            ladderRefused: 'Ещё одна передача',
            ladderRefusedDetail: ({ level }) => `Уровень ${level} · отказ; агент делает сам`,
        },
        session: {
            useDefaults: 'По умолчанию',
            crossOwnerNote: 'Роли скопированы при запуске.',
            addRole: 'Добавить роль для этой сессии',
            addRoleConfirm: 'Добавить роль',
            namePlaceholder: 'Название роли',
            instructionsPlaceholder: 'Что делает роль и когда её использовать',
            notesTitle: 'Заметки',
            notesPlaceholder: 'Что должна знать каждая сессия ниже',
            applyToReports: 'Применить к сессиям ниже',
            handsOffTitle: 'Без правок',
            handsOffDescription: 'Планирует и делегирует; файлы не правит.',
            saveFailed: 'Не удалось сохранить изменение.',
            sectionTitle: 'Роли',
            allRoles: 'Все роли',
            inUse: ({ count }) => `Используется: ${count}`,
            changed: 'изменена',
            thisSession: 'эта сессия',
            reset: 'Сбросить',
            newRoleForSession: 'Новая роль для этой сессии',
            changeForSession: 'Изменить для этой сессии',
            editNotes: 'Изменить заметки',
            more: 'Ещё',
            info: 'Роли действуют в этой сессии и во всех сессиях под ней.',
            countChanged: ({ count }) => `${count} изменено`,
            countAdded: ({ count }) => `${count} добавлено`,
            addNotes: 'Добавить заметки о том, как этой сессии оркестрировать работу',
        },
        profiles: {
            sharedWithYouTitle: 'Доступные вам',
            sharedWithYouDescription: 'Профили, которыми с вами поделились люди и команды. Секретные значения остаются у владельцев.',
            share: 'Поделиться…',
            shareFailedTitle: 'Не удалось поделиться профилем',
            shareNeedsSavedSecrets: 'Секретные значения никогда не передаются. Перенесите каждое значение этого профиля в сохранённый секрет, привяжите его и поделитесь снова.',
            shareAwaitingApproval: 'Публикация профиля ждёт одобрения. После одобрения снова выберите «Поделиться…».',
        },
    } } as const satisfies Pick<Record<string, RolesTranslations>, "ru">;

return { rolesTranslations };
})();

const Domain_runPageTranslations = (() => {
type Count = Shared_runPageTranslations.Count;

type Machine = Shared_runPageTranslations.Machine;

type Reviewer = Shared_runPageTranslations.Reviewer;

type RunPageTranslations = Shared_runPageTranslations.RunPageTranslations;

const runPageTranslations = { ru: {
        untitledRun: 'Запуск агента',
        intentTitles: { review: 'Ревью', plan: 'План', delegate: 'Поручение' },
        thisMachine: 'этой машине',
        menu: {
            cancelResponse: 'Отменить этот ответ',
            copyResult: 'Скопировать результат',
            showInTranscript: 'Показать в переписке',
            runDetails: 'Сведения о запуске',
            agent: 'Агент',
            permissions: 'Разрешения',
            kind: 'Тип',
            finishesOnItsOwn: 'Завершится сам',
            staysOpen: 'Остаётся открытым',
            started: 'Начало',
            run: 'Запуск',
            process: 'Процесс',
        },
        opening: { reading: ({ machine }) => `Читаем с ${machine}.` },
        gone: {
            title: ({ machine }) => `Этого запуска больше нет на ${machine}`,
            reason: 'Он там больше не хранится, и в загруженной части переписки его нет.',
            closeTab: 'Закрыть вкладку',
        },
        stopFailed: {
            title: {
                review: 'Не удалось остановить это ревью',
                plan: 'Не удалось остановить этот план',
                delegate: 'Не удалось остановить это поручение',
                run: 'Не удалось остановить этот запуск',
            },
            reasonWithOthers: ({ machine, count }) => `${machine} не подтвердила остановку. Можно остановить всю сессию — это остановит и других агентов в ней (${count}).`,
            reasonAlone: ({ machine }) => `${machine} не подтвердила остановку. Можно остановить всю сессию.`,
            stopSession: 'Остановить сессию…',
        },
        steps: {
            title: 'Как он к этому пришёл',
            count: ({ count }) => `Шагов: ${count}`,
        },
        review: {
            findings: 'Замечания',
            findingsCount: ({ count }) => `${count}`,
            highCount: ({ count }) => `высоких: ${count}`,
            severity: { blocker: 'Блокер', high: 'Высокая', medium: 'Средняя', low: 'Низкая', nit: 'Мелочь' },
            triageLabel: 'Что сделать с этим замечанием',
            reviewerAsks: 'Ревьюер спрашивает',
            answer: 'Ответить',
            askAboutThis: 'Спросить об этом',
            fixesSelected: ({ count }) => `Выбрано исправлений: ${count}`,
            noFixesSelected: 'Выберите исправления',
            implementFixes: ({ count }) => (count > 0 ? `Внести исправления (${count})` : 'Внести исправления'),
            couldNotSaveChoice: 'Не удалось сохранить выбор.',
            reviewers: 'Ревьюеры',
            findingTotal: ({ count }) => (count === 1 ? '1 замечание' : `${count} замечаний`),
            moreFindings: ({ count }) => (count === 1 ? 'ещё 1 замечание' : `${count} замечаний ещё`),
            fixesToImplement: ({ count }) => (count === 1 ? '1 исправление к внедрению' : `${count} исправлений к внедрению`),
            verifiedFirst: 'Каждое сначала проверяется, затем исправляется',
            replies: ({ count }) => (count === 1 ? '1 ответ' : `${count} ответов`),
            updatedAfterQuestion: 'Обновлено после вашего вопроса',
            reviewerUpdated: ({ reviewer }) => `${reviewer} обновил замечание`,
            askPlaceholder: 'Задайте вопрос об этом замечании…',
            askReviewerPlaceholder: 'Задайте вопрос ревьюеру…',
            toReviewer: ({ reviewer }) => `Для ${reviewer}`,
            followUpsGoTo: ({ reviewer }) => `Вопросы уходят ${reviewer}`,
            waitingForAnswer: ({ reviewer }) => `Ждём ${reviewer}…`,
            waitingForAnswers: 'Ждём рецензентов…',
            both: 'Оба',
            reviewerCount: ({ count }) => `Рецензентов: ${count}`,
            askReviewersPlaceholder: 'Задайте рецензентам вопрос…',
            followUpsGoToAll: ({ count }) => (count === 2 ? 'Вопросы уходят обоим рецензентам' : `Вопросы уходят всем рецензентам (${count})`),
            stillReviewing: 'Ещё проверяет',
            reviewerDidNotFinish: 'Не завершил',
            reviewersNotStarted: ({ count }) => (count === 1 ? 'Один рецензент не запустился' : `Не запустились рецензенты: ${count}`),
            reviewerNotStarted: ({ reviewer }) => `${reviewer} не удалось запустить.`,
            notSaved: 'Это замечание не сохранено, поэтому решение пока нельзя записать.',
            decisionsUnavailable: 'Не удалось загрузить ваши решения.',
            followUpUnavailable: {
                notResumable: 'Это ревью завершено; для вопросов нужно ревью, которое остаётся открытым.',
                ended: 'Это ревью не завершилось, поэтому не принимает вопросы.',
                resumeUnavailable: 'Ревьюер больше недоступен на этой машине.',
                busy: 'Ревьюер ещё занят. Попробуйте чуть позже.',
                failed: 'Не удалось отправить вопрос.',
            },
        },
        launcher: {
            titles: { review: 'Запросить ревью', plan: 'Запросить план', delegate: 'Поручить задачу' },
            descriptions: {
                review: ({ machine }) => `Каждый агент отдельно проверяет изменения на ${machine}; здесь вы получите результат от каждого.`,
                plan: ({ machine }) => `Агент читает код на ${machine} и предлагает здесь план. Он ничего не меняет.`,
                delegate: ({ machine }) => `Агент работает на ${machine} с разрешениями ниже и отчитывается здесь.`,
            },
            whatFor: 'Для чего',
            who: { review: 'Кто проверяет', plan: 'Кто планирует', delegate: 'Кто выполняет' },
            selectedCount: ({ count }) => `Выбрано: ${count}`,
            focus: {
                review: 'На чём им сосредоточиться?',
                plan: 'Что должен охватить план?',
                delegate: 'Что нужно сделать?',
            },
            optional: 'необязательно',
            start: {
                review: ({ count }) => (count > 1 ? `Начать ревью (${count})` : 'Начать ревью'),
                plan: 'Начать план',
                delegate: 'Начать задачу',
            },
            runsOn: ({ machine }) => `Выполняется на ${machine}`,
            checking: 'Проверяем, какие агенты могут работать здесь',
            unavailableTitle: 'В этой сессии нельзя запустить агентов',
            unavailableReason: 'Её машина сейчас не предлагает ревью, планы или поручения.',
        },
    } } as const satisfies Pick<Record<string, RunPageTranslations>, "ru">;

return { runPageTranslations };
})();

const Domain_scmComparisonTranslations = (() => {
type ScmComparisonTranslations = Shared_scmComparisonTranslations.ScmComparisonTranslations;

const en = Shared_scmComparisonTranslations.en;

const translated = Shared_scmComparisonTranslations.translated;

const scmComparisonTranslations = { ru: {
        scmComparison: translated({
            view: { files: 'Файлы', walkthrough: 'Разбор', commits: 'Коммиты' },
            scope: {
                workingTree: 'Незафиксированные изменения',
                session: 'Эта сессия',
                turn: 'Ход',
                latestTurn: 'Последний ход',
                branch: ({ head, base }) => `${head} относительно ${base}`,
                commit: ({ commit }) => `Коммит ${commit}`,
            },
            tabTitle: ({ view, scope }) => `${view} · ${scope}`,
            since: ({ time }) => `с ${time}`,
            turnsWithChanges: ({ count }) => `Ходов с изменениями: ${count}`,
            scopePicker: {
                a11y: 'Какие изменения показать',
                branchChoice: 'Ветка относительно базы',
                commitChoice: 'Коммит',
                pullRequestChoice: 'Пул-реквест',
                headRef: 'Целевая ветка или ссылка',
                baseRef: 'Базовая ветка или ссылка',
                parentRef: 'Родительская ссылка (необязательно)',
                explainAndCommit: 'Объяснить и закоммитить',
                explainOnly: 'Только объяснить',
                unavailable: 'Недоступно для этой сессии',
                pendingDescription: 'Без коммита · можно предложить коммиты',
                sessionDescription: 'Все изменения, начало → сейчас',
                turnDescription: 'В порядке изменений агента',
                branchDescription: 'Изменения от общей базы',
                commitDescription: 'Изменения этого коммита',
                pullRequestDescription: 'Изменения этого pull request',
            },
            fileCount: ({ count }) => `Файлов: ${count}`,
            changeCount: ({ count }) => `Изменений: ${count}`,
            changedFiles: 'Изменённые файлы',
            startReview: 'Начать ревью',
            proposeCommits: 'Предложить коммиты',
            explain: 'Объяснить',
            explainA11y: 'Объяснить: показать заметки разбора рядом с изменениями',
            viewA11y: 'Вид',
            lockfileTag: 'Lock-файл',
            generatedTag: 'Сгенерирован',
            lockfileCollapsed: 'Lock-файл, свёрнут.',
            generatedCollapsed: 'Сгенерированный файл, свёрнут.',
            showDiff: 'Показать diff',
            unsupportedReason: 'Файлы пока не могут показать это сравнение. Изменения остаются в Git.',
            showPendingChanges: 'Показать незафиксированные изменения',
            capturedStale: 'Источник изменился. Эти файлы сохраняют зафиксированное сравнение.',
            capturedFreshnessUnknown: 'Показаны зафиксированные файлы. Не удалось проверить текущее состояние источника.',
            keys: { nextFile: 'следующий файл', nextChange: 'следующее изменение' },
        }),
    } } as const;

return { scmComparisonTranslations };
})();

const Domain_secretsSettingsTranslations = (() => {
type SecretsSettingsCopy = Shared_secretsSettingsTranslations.SecretsSettingsCopy;

const en = Shared_secretsSettingsTranslations.en;

const ru: SecretsSettingsCopy = {
    purpose: 'API-ключи и токены, которые используют ваши агенты и серверы MCP. После сохранения значение больше не показывается.',
    yoursTitle: 'Ваши секреты',
    yoursDescription: 'Секреты, которые вы сохранили или которыми владеете. Выбирайте их везде, где Happier просит ключ.',
    sharedWithYouTitle: 'Доступные вам',
    sharedWithYouDescription: 'Другие люди разрешили вам их использовать. Вы можете выбирать их, но не видеть и не изменять.',
    add: 'Добавить секрет',
    newSecret: 'Новый секрет',
    emptyTitle: 'Секретов пока нет',
    emptyDescription: 'Добавьте API-ключ или токен один раз и выбирайте его везде, где Happier его просит.',
    staleTitle: 'Не удалось обновить общие секреты',
    staleDescription: 'Показан последний известный список.',
    valueTitle: 'Значение',
    valueSaved: 'Сохранено. Больше никогда не показывается.',
    keepTitle: 'Хранить как',
    keepPersonal: 'Личный',
    keepShared: 'Общий',
    keepPersonalDescription: 'Хранится в вашем аккаунте. Использовать его можете только вы.',
    keepSharedDescription: 'Хранится на этом Home, чтобы им можно было поделиться с людьми, Teams или группами.',
    accessTitle: 'Кто может использовать',
    accessOnlyYou: 'Только вы',
    accessRecipients: ({ count }: { count: number }) => `Вы и получатели: ${count}`,
    sharePersonalDescription: 'При открытии доступа он переносится на этот Home. Снова сделать его личным нельзя.',
    share: 'Поделиться',
    manage: 'Управлять',
    storageTitle: 'Хранение',
    storageE2ee: 'Сквозное шифрование',
    storageE2eeDescription: 'Прочитать его могут только те, с кем вы им поделились.',
    storagePlain: 'Управляется Home',
    storagePlainDescription: 'Этот Home хранит его и может прочитать, чтобы доставить.',
    save: 'Сохранить секрет',
};

const secretsSettingsTranslations = { ru } as const;

return { secretsSettingsTranslations };
})();

const Domain_sessionAccessTranslations = (() => {
const sessionAccessTranslations = { "ru": {
        withContext: ({ context, label }: { context: string; label: string }) => `${context} · ${label}`,
        withCount: ({ label, count }: { label: string; count: number }) => `${label} +${count}`,
        accessibleSummary: ({ title, label }: { title: string; label: string }) => `${title}: ${label}`,
        accessibleControl: ({ name, control, value }: { name: string; control: string; value: string }) => `${name}, ${control}, ${value}`,
        title: "Доступ к сессии",
        search: "Поиск людей, групп или команд",
        hasAccess: "Есть доступ",
        yourAccess: "Ваш доступ",
        readOnly: "Вы можете посмотреть, как получен доступ. Изменения доступны только администраторам сессии.",
        sourceDirect: "Прямой доступ",
        sourceTeam: "Доступ через команду",
        sourceGroup: "Доступ через группу",
        people: "Люди",
        groups: "Группы",
        teams: "Команды",
        account: "Человек",
        group: "Группа",
        team: "Команда",
        view: "Может просматривать",
        edit: "Может направлять",
        admin: "Управление",
        owner: "Владелец",
        private: "Личная",
        custom: "Настроенный доступ",
        required: "Требуется политикой команды",
        subjectNotFound: "Этот человек, группа или команда больше недоступны.",
        subjectIneligible: "Этому человеку, группе или команде больше нельзя предоставить доступ.",
        teamPolicyRequired: "Политика команды требует сохранить этот доступ.",
        selfGrantManaged: "Изменить ваш доступ должен другой управляющий доступом.",
        homeUnsupported: "Этот Home пока не поддерживает доступ к сессиям. Обновите его, чтобы управлять тем, кто может открыть эту сессию.",
        openCollaboration: "Открыть совместную работу",
        authenticationRequired: "Войдите способом, который принимает эта команда, и повторите попытку.",
        authenticationUnavailable: "Требуемый этой командой способ входа недоступен на этом Home.",
        delegation: "Может одобрять запросы разрешений на выполнение",
        remove: "Удалить доступ",
        confirmRemove: "Подтвердить удаление",
        credentialsLost: ({ names }: { names: string }) => `Эти учётные данные команды перестанут работать здесь: ${names}`,
        ready: "Зашифрованный доступ готов",
        prepared: "Зашифрованный доступ подготовлен",
        recipientRepairRequired: "Этому человеку нужно восстановить настройки шифрования своего аккаунта.",
        pending: "Зашифрованный доступ ожидается",
        setup: "Требуется настройка шифрования",
        repair: "Зашифрованный доступ требует восстановления",
        unavailable: "Зашифрованное содержимое недоступно",
        notRequired: "Эта сессия не зашифрована, поэтому готовить нечего.",
        preparing: "Подготовка зашифрованного доступа…",
        preparingProgress: ({ count }: { count: number }) => `Подготовка зашифрованного доступа… подготовлено: ${count}`,
        preparationPending: ({ count }: { count: number }) => `Зашифрованный доступ ожидает подготовки: ${count}`,
        preparationSetup: ({ count }: { count: number }) => `Требуется настройка шифрования: ${count}`,
        preparationRepair: ({ count }: { count: number }) => `Требуется восстановление зашифрованного доступа: ${count}`,
        preparationKeyUnavailable: "Это устройство не может подготовить зашифрованный доступ к этой сессии.",
        preparationFailed: "Доступ сохранён, но подготовить зашифрованный доступ не удалось.",
        preparationPassFailed: "Не удалось подготовить зашифрованный доступ.",
        preparationAnnouncedComplete: "Подготовка зашифрованного доступа завершена.",
        preparationAnnouncedNeedsAttention: "Зашифрованному доступу всё ещё нужна настройка или восстановление.",
        preparationCheckFailed: "Не удалось проверить зашифрованный доступ.",
        outcomeUnknown: "Результат неизвестен. Happier проверяет текущий доступ перед повторной попыткой.",
        historicalLayoutNotice: "Люди, с которыми вы делитесь этой сессией, не смогут открыть её, пока она не будет обновлена для этой версии Happier.",
        historicalLayoutUpdate: "Обновить для общего доступа",
        homeReconciled: "Доступ к сессии сброшен для нового Home.",
        lockedTitleFallback: "Зашифрованная сессия",
        encryptedAccess: "Зашифрованный доступ",
        aggregatePrepared: ({ count }: { count: number }) => `подготовлено: ${count}`,
        aggregatePending: ({ count }: { count: number }) => `ожидают: ${count}`,
        aggregateNeedsAttention: ({ count }: { count: number }) => `требуют настройки или восстановления: ${count}`,
        prepareNow: "Подготовить",
        prepareAgain: "Подготовить заново",
        preparingProgressOf: ({ count, total }: { count: number; total: number }) => `Подготовка зашифрованного доступа… ${count} из ${total}`,
        showAllRecipients: "Показать всех",
        hideAllRecipients: "Скрыть список",
        moreRecipients: "Показать ещё",
        recipientPlainAccount: "Аккаунт без шифрования",
        pendingBody: "Эта сессия зашифрована. Управляющему участнику ещё нужно подготовить ваш зашифрованный доступ, прежде чем она откроется здесь.",
        setupBody: "Завершите настройку шифрования в этом аккаунте, после чего управляющий участник сможет подготовить ваш доступ к этой сессии.",
        setupAction: "Настроить шифрование",
        repairBody: "Ключ, доставленный для этой сессии, не удалось открыть на этом устройстве. Повторите попытку или попросите управляющего участника подготовить доступ заново.",
        retryAction: "Повторить",
        unavailableBody: "Ключ открылся, но содержимое этой сессии не удалось расшифровать. Управляющий участник может подготовить доступ заново.",
        openAccessAction: "Открыть доступ к сессии",
        removedTitle: "Доступ удалён",
        removedBody: "С текущим доступом эту сессию открыть нельзя. Управляющий участник может поделиться ею снова.",
        removedAnnouncement: ({ name }: { name: string }) => `${name} удалён из доступа к сессии`,
        browseMore: "Посмотреть все",
        allLoaded: "Все результаты загружены",
        help: "«Может просматривать» разрешает чтение. «Может направлять» позволяет направлять Агента в пределах разрешений его инструментов. «Управление» также позволяет менять доступ. Это не изолированный чат: рабочая папка и имя автора не ограничивают доступ к оболочке, файлам и сети."
    } } as const;

return { sessionAccessTranslations };
})();

const Domain_sessionAgentActivityTranslations = (() => {
const en = Shared_sessionAgentActivityTranslations.en;

const ru: typeof en = {
    status: {
        queued: 'В очереди',
        starting: 'Запускается',
        running: 'Выполняется',
        waiting: 'Ожидание',
        blocked: 'Заблокировано',
        succeeded: 'Завершено',
        failed: 'Ошибка',
        timedOut: 'Время истекло',
        cancelled: 'Остановлено',
        unknown: 'Неизвестно',
    },
    attention: {
        permission: 'Нужно подтверждение',
        userAction: 'Нужен ваш ответ',
        both: 'Требует внимания',
        bothDescription: 'Нужно подтверждение и ваш ответ',
    },
    runKind: {
        conversation: 'Беседа',
        review: 'Ревью',
        plan: 'План',
    },
    /** The Agents pane: its "+", its states, its team groups and its live line (agents lab). */
    roster: {
        teamLabel: ({ team, count }) => `Команда ${team} · агентов: ${count}`,
        teamActionsA11y: 'Действия команды',
        openWork: 'Открыть',
        needsYouCount: ({ count }) => `Ждут вас: ${count}`,
        runningCount: ({ count }) => `Работают: ${count}`,
        nothingRunning: 'Ничего не выполняется.',
        startAgent: 'Запустить агента',
        machineOffline: ({ machine }) => `${machine} не отвечает`,
        machineOfflineUnnamed: 'Машина не отвечает',
        launch: {
            menuA11y: 'Запустить агента',
            conversationDescription: 'Поговорить с агентом рядом с этой сессией',
            reviewDescription: 'Проверить изменения на данный момент',
            planDescription: 'Продумать следующие шаги',
            delegateDescription: 'Передать задачу и получить её готовой',
            advancedDescription: 'Выбрать агентов, разрешения и профиль',
        },
        empty: {
            title: 'Добавьте агентов в эту сессию',
            reason: ({ machine }) => `Начните параллельный разговор или попросите ревью или план, пока продолжаете работу. Они работают на ${machine} и отчитываются здесь.`,
            reasonUnnamed: 'Начните параллельный разговор или попросите ревью или план, пока продолжаете работу. Они отчитываются здесь.',
            moreWays: 'Попросить ревью, план или делегирование',
        },
        unavailable: {
            notEnabled: 'В этом Home агентов запускать нельзя.',
            machineOffline: ({ machine }) => `Чтобы запускать агентов, ${machine} должна быть в сети.`,
            machineOfflineUnnamed: 'Чтобы запускать агентов, эта машина должна быть в сети.',
            sessionInactive: 'Эта сессия остановлена. Возобновите её, чтобы запускать здесь агентов.',
            externalRunnerInactive: 'Эта сессия запущена вне Happier. Агентов можно запускать отсюда, пока Happier к ней подключён.',
        },
    },
    summaryA11y: ({ title, status }) => `${title}, ${status}`,
    summaryAttentionA11y: ({ title, status, attention }) => `${title}, ${status}, ${attention}`,
};

const sessionAgentActivityTranslations = { ru };

return { sessionAgentActivityTranslations };
})();

const Domain_sessionBoardTranslations = (() => {
type SessionBoardStateTranslation = Shared_sessionBoardTranslations.SessionBoardStateTranslation;

type SessionBoardTranslation = Shared_sessionBoardTranslations.SessionBoardTranslation;

const sessionBoardTranslations = { ru: {
        title: 'Доска',
        views: {
            label: 'Виды доски',
            overview: 'Обзор',
            createTitle: 'Новый вид доски',
            renameTitle: 'Переименовать вид доски',
            reconciled: ({ title }) => `Этот вид доски удалён. Показан ${title}.`,
            empty: {
                title: 'В этом виде пусто',
                reason: 'Добавьте сюда виджет или перейдите к другому виду доски.',
            },
            actions: {
                create: 'Новый вид',
                rename: 'Переименовать вид',
                moveBefore: 'Переместить вид раньше',
                moveAfter: 'Переместить вид позже',
                remove: 'Удалить вид',
            },
            remove: {
                title: ({ title }) => `Удалить «${title}»?`,
                moveMessage: ({ title }) => `Его виджеты перейдут в ${title}. Из сессии ничего не удаляется.`,
                unpinMessage: 'Его виджеты останутся в сессии, но перестанут быть закреплены за видом.',
            },
        },
        add: { note: 'Заметка', interactiveView: 'Интерактивный вид' },
        width: { compact: 'Узкий', medium: 'Средний', wide: 'Широкий', full: 'Во всю ширину' },
        height: { auto: 'По содержимому', compact: 'Низкая', regular: 'Средняя', tall: 'Высокая' },
        board: {
            loading: { title: 'Открываем доску', reason: 'Загружаем то, что закреплено в этой сессии.' },
            locked: {
                title: 'Доска пока зашифрована',
                reason: 'Это устройство ещё не может открыть сессию. Ничего не потеряно.',
            },
            unopenable: {
                title: 'Не удалось прочитать структуру доски',
                reason: 'Сохранённую структуру не удалось открыть. Сами виджеты не пострадали.',
            },
            unsupported: {
                title: 'Для этой доски нужна более новая версия Happier',
                reason: 'Всё сохранено. Откройте её на поддерживаемом устройстве или обновите Happier.',
            },
            unavailable: {
                title: 'Доска здесь пока недоступна',
                reason: 'Ничего не потеряно. Она появится, когда этот Home включит доски.',
            },
            offline: 'Нет сети — показана последняя загруженная версия.',
            offlineEmpty: 'Нет сети — подключитесь снова, чтобы загрузить эту доску.',
            stale: 'Показана последняя загруженная версия.',
        },
        empty: {
            editor: {
                title: 'Держите план рядом с чатом',
                description: 'Заметки и живые виды, закреплённые здесь, остаются в этой сессии — для всех, кто может её читать.',
                askAgent: 'Попросить агента',
                askAgentPrompt: 'Разместите на этой доске то, что показывает ',
                addNote: 'Добавить заметку',
            },
            viewer: {
                title: 'На доске пока пусто',
                description: 'Здесь появится всё, что люди или агенты закрепят в этой сессии.',
            },
        },
        item: {
            untitled: 'Виджет без названия',
            renameA11y: 'Название виджета',
            reorderA11y: ({ title }) => `Переместить ${title}`,
            a11yLabelWithWidth: ({ title, width }) => `${title}, ${width}`,
            menuGroups: { content: 'Чтение и правка', movement: 'Перемещение', geometry: 'Размер', destructive: 'Удаление' },
            loading: { title: 'Загружаем виджет', reason: 'Получаем содержимое с этого Home.' },
            locked: {
                title: 'Зашифрованное содержимое недоступно',
                reason: 'Виджет остаётся зашифрованным, пока это устройство не сможет открыть сессию.',
            },
            unopenable: {
                title: 'Этот виджет нельзя показать',
                reason: 'Сохранённое содержимое не удалось прочитать. Остальная доска работает.',
            },
            unsupported: {
                title: 'Для этого виджета нужна более новая версия Happier',
                reason: 'Содержимое сохранено. Откройте его на поддерживаемом устройстве или обновите Happier.',
            },
            missing: {
                title: 'Виджет не найден',
                reason: 'Доска всё ещё ссылается на него, но содержимого нет на этом Home.',
            },
            removed: {
                title: 'Этот виджет убрали с доски',
                reason: 'Кто-то с правами на редактирование удалил его для всех.',
            },
            pluginUnavailable: {
                title: 'Плагин недоступен на этом устройстве',
                reason: 'Виджет сохранён. Он снова появится, когда плагин станет доступен здесь.',
            },
            rendererUnavailable: {
                title: 'Этот виджет нельзя показать на этом устройстве',
                reason: 'Содержимое сохранено. Откройте его там, где поддерживаются интерактивные виды.',
            },
            provenance: {
                note: 'Заметка',
                interactiveView: 'Интерактивный вид',
                pluginMissing: ({ pluginId }) => `Из ${pluginId} · не установлен`,
                pluginSurface: ({ plugin, surface }) => `${surface} · ${plugin}`,
                pluginQualified: ({ label, pluginId }) => `${label} (${pluginId})`,
            },
            actions: {
                remove: 'Убрать с доски',
                openHere: 'Открыть здесь',
                managePlugin: 'Управлять плагином',
                prepareEncryption: 'Настроить шифрование',
                readFull: 'Читать заметку целиком',
                rename: 'Переименовать виджет',
                unpin: 'Открепить от этого вида',
                moveToView: ({ title }) => `Переместить в «${title}»`,
            },
            moved: {
                before: ({ title }) => `${title} перемещён раньше.`,
                after: ({ title }) => `${title} перемещён позже.`,
                reordered: ({ title }) => `${title} перемещён.`,
                toView: ({ title, view }) => `${title} перемещён в «${view}».`,
            },
            movePosition: ({ position, total }) => `Позиция ${position} из ${total}`,
            moveTargetView: ({ title }) => `Вид доски «${title}»`,
            remove: {
                title: 'Убрать этот виджет?',
                message: 'Его потеряют все, кто может читать эту сессию. Установленные плагины останутся установленными.',
            },
        },
        note: {
            titlePlaceholder: 'Заголовок',
            titleA11y: 'Заголовок заметки',
            untitled: 'Заметка без названия',
            offline: 'Для сохранения нужна связь с этим Home.',
            unavailable: 'Изменение доски на этом Home пока недоступно.',
            failed: 'Happier не смог сохранить заметку. Ваш текст на месте.',
            outcomeUnknown: 'Happier не смог подтвердить сохранение. Обновите, прежде чем сохранять снова.',
            saved: 'Заметка сохранена',
            conflict: {
                message: 'Эту заметку изменили на другом устройстве.',
                reviewLatest: 'Посмотреть последнюю версию',
                applyMine: 'Применить мои изменения',
                latestHeading: 'Последняя версия',
            },
        },
        recovered: {
            title: 'Восстановленные элементы',
            description: 'Эти виджеты есть в сессии, но не размещены ни в одном виде доски.',
            pin: 'Добавить в этот вид',
        },
        mutation: {
            conflict: 'Доска изменилась на другом устройстве. Обновите, чтобы увидеть актуальную версию.',
            outcomeUnknown: 'Happier не смог подтвердить, сохранилось ли изменение.',
            denied: 'У вас больше нет прав изменять эту доску.',
            offline: 'Для изменения доски нужно подключение к этому Home.',
            unavailable: 'Этот Home пока не может изменять доску.',
            updateRequired: 'Обновите Happier, чтобы применить это изменение доски.',
            hostedHtmlSourceTooLarge: 'Эта интерактивная панель слишком велика для сохранения. Ваш черновик остался на месте.',
            noteTooLarge: 'Эта заметка слишком велика для сохранения. Ваш текст остался на месте.',
            invalid: 'Это изменение доски недопустимо. Проверьте его и повторите попытку.',
            notFound: 'Этот элемент доски больше недоступен. Обновите доску.',
            storageFailed: 'Happier не смог безопасно сохранить изменение. Ваша работа не потеряна.',
            serverFailed: 'Этот Home не смог завершить изменение доски. Повторите попытку.',
            failed: 'Happier не смог применить это изменение доски.',
        },
        hostedHtmlApproval: {
            title: 'Разрешить эту интерактивную панель?',
            body: 'Разрешение действует для этой панели в этой сессии. Чтобы отправить сообщение, по-прежнему нужно нажать внутри панели.',
            resources: ({ count }) => `Может читать ресурсы сессии: ${count}`,
            actions: ({ count }) => `Может выполнять действия: ${count}`,
            sendMessages: 'Может просить Happier отправлять сообщения',
            loadsFrom: ({ origin }) => `Загружает с ${origin}`,
            allow: 'Разрешить',
            notNow: 'Не сейчас',
            declined: {
                title: 'Интерактивная панель пока не разрешена',
                reason: 'Просмотрите её запросы, когда будете готовы.',
                review: 'Просмотреть',
            },
        },
        sidebar: {
            openInDetails: 'Открыть в деталях',
            openBoard: 'Открыть доску',
            sharedWithEveryone: 'Видно всем здесь',
            widgetCount: ({ count }) => `${count} ${count % 10 === 1 && count % 100 !== 11 ? 'виджет' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'виджета' : 'виджетов'}`,
        },
        mobile: { searchPlaceholder: 'Поиск по этой доске' },
        inline: {
            openBoard: 'Открыть доску',
            openBoardA11y: ({ title }) => `Открыть «${title}» на доске`,
        },
        companion: {
            title: 'Спутник',
            inCompanionA11y: 'В вашем спутнике',
            empty: {
                title: 'Держите сессию на виду',
                reason: 'Поместите сводку сессии или виджет доски рядом с чатом: что запущено, что ждёт вас, что изменилось.',
                note: 'Ваш спутник видите только вы.',
            },
            pane: {
                besideChat: 'Рядом с чатом',
                itemCount: ({ count }: { count: number }) => `${count} эл.`,
                justForYou: 'Только для вас, рядом с чатом',
            },
            actions: {
                addSummary: 'Добавить сводку сессии',
                addItem: ({ title }) => `Добавить «${title}»`,
                moveToLeading: 'Переместить влево',
                moveToTrailing: 'Переместить вправо',
                moveToFirst: 'Переместить в начало',
                moveToLast: 'Переместить в конец',
                compact: 'Компактный размер',
                comfortable: 'Свободный размер',
                openFull: 'Открыть спутник полностью',
                openOnBoard: 'Открыть на доске',
                collapse: 'Свернуть спутник',
                expand: 'Развернуть спутник',
                hide: 'Скрыть спутник',
                addToCompanion: 'Добавить в спутник',
                removeFromCompanion: 'Убрать из спутника',
                undo: 'Отменить',
                menuA11y: 'Параметры спутника',
                itemMenuA11y: ({ title }) => `Параметры «${title}»`,
            },
            a11y: {
                headerAction: ({ count }) => `Спутник, элементов: ${count}`,
                show: ({ count }) => `Показать спутник, элементов: ${count}`,
                expand: ({ count }) => `Развернуть спутник, элементов: ${count}`,
            },
            summary: {
                review: 'Посмотреть',
                title: 'Сводка сессии',
                untitled: 'Сессия',
                approvals: ({ count }) => `Ожидают вас: ${count}`,
                workflows: ({ count }) => `Выполняется процессов: ${count}`,
                changedFiles: ({ count }) => `Изменено: ${count}`,
                tokens: ({ count }) => `Токенов: ${count}`,
                contextPercent: ({ percent }) => `${percent} % контекста`,
                contextOnly: 'Контекст использован',
                moreDetails: 'Подробнее',
                moreDetailsA11y: ({ count }) => `Подробнее, ещё строк: ${count}`,
                partial: 'Некоторые сведения отсюда не видны.',
            },
            notices: {
                shown: 'Спутник показан',
                hidden: 'Спутник скрыт',
                added: 'Добавлено в спутник',
                removed: 'Убрано из спутника',
                reordered: 'Порядок в спутнике изменён',
                moved: 'Спутник перемещён',
                boardOpened: 'Доска открыта агентом',
                returnedToChat: 'Агент вернулся в чат',
                boardViewSelected: 'Агент выбрал представление доски',
                boardItemRevealed: 'Агент открыл элемент доски',
                fullOpened: 'Агент открыл спутник',
            },
        },
    } } as const satisfies Pick<Readonly<Record<string, SessionBoardTranslation>>, "ru">;

return { sessionBoardTranslations };
})();

const Domain_sessionCollaborationPaneTranslations = (() => {
type PaneCopy = Shared_sessionCollaborationPaneTranslations.PaneCopy;

const en = Shared_sessionCollaborationPaneTranslations.en;

const sessionCollaborationPaneTranslations: Pick<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', PaneCopy>, "ru"> = { ru: {
        hereOne: ({ name }) => `${name} здесь`,
        hereTwo: ({ first, second }) => `${first} и ${second} здесь`,
        hereMany: ({ first, count }) => `${first} и ещё ${count.toLocaleString()} чел. здесь`,
        typingOne: ({ name }) => `${name} печатает…`,
        typingMany: ({ count }) => `Печатают ${count.toLocaleString()} чел.…`,
        justYouHere: 'Здесь только вы',
        justYouHint: 'Здесь появятся люди, с которыми вы поделитесь',
        you: 'Вы',
        presenceConnecting: 'Проверяем, кто здесь…',
        presenceUnavailable: 'Данные о присутствии сейчас не отвечают',
        presenceUnsupported: 'Присутствие в реальном времени недоступно в этом Home',
        responsibleUnsupported: 'Этот Home не отмечает ответственного',
        inviteTitle: 'Обсудите рядом с сессией',
        inviteBody: 'Начните разговор, упомяните людей и передайте ответ агенту, когда будете готовы.',
        readOnly: 'Вы можете их читать. Писать могут те, кто может редактировать эту сессию.',
        offline: 'Вы не в сети · показаны последние разговоры',
        lockedTitle: 'Эти разговоры пока нельзя открыть на этом устройстве',
        lockedBody: 'Они защищены сквозным шифрованием, а настройки шифрования этого устройства не совпадают с настройками сессии.',
        revokedTitle: 'У вас больше нет доступа к этим разговорам',
        revokedBody: 'Тот, кто управляет этой сессией, изменил, кто может её видеть. Ваши сообщения остаются в сессии.',
        namesTwo: ({ first, second }) => `${first} и ${second}`,
        namesThree: ({ first, second, third }) => `${first}, ${second} и ${third}`,
        namesMore: ({ first, second, count }) => `${first}, ${second} и ещё ${count.toLocaleString()}`,
        haveAccess: 'Есть доступ',
        hasAccess: 'Есть доступ',
        onlyYou: 'Только вы',
        notShared: 'Пока ни с кем не поделились',
        publicLinkOn: 'Публичная ссылка включена',
        accessLoading: 'Проверяем, у кого есть доступ…',
        accessError: 'Не удалось загрузить, у кого есть доступ',
        shareTitle: 'Поделиться сессией',
        shareBody: ({ home }) => `Люди, которых вы добавите в ${home}, смогут следить за сессией и участвовать в разговорах.`,
        collapse: 'Свернуть',
        linkOn: 'Вкл.',
        linkOff: 'Выкл.',
        linkGrants: 'Любой, у кого есть ссылка, может смотреть транскрипт — без аккаунта.',
        linkExpires: ({ date }) => `Истекает ${date}`,
        linkNeverExpires: 'Бессрочно',
        linkAsksConsent: 'запрашивает согласие',
        linkNoConsent: 'без запроса согласия',
        linkHidden: 'Эта ссылка создана раньше и не может быть показана снова. Создайте новую ссылку, чтобы скопировать её.',
        qrCode: 'QR-код',
        hideQrCode: 'Скрыть QR-код',
        newLink: 'Новая ссылка…',
        turnOff: 'Выключить',
        turnOffTitle: 'Выключить публичную ссылку?',
        turnOffBody: 'Все, у кого есть ссылка, сразу потеряют доступ. Новую ссылку можно создать позже.',
        newLinkReplaces: 'Текущая ссылка перестанет работать, когда будет создана новая.',
        linkDenied: 'Создавать публичную ссылку могут только те, кто управляет этой сессией.',
        linkLoadFailed: 'Не удалось проверить публичную ссылку.',
        justYouTitle: 'Работайте над сессией вместе',
        justYouBody: ({ home }) => `Поделитесь ею с людьми в ${home}. Они смогут следить за ней, обсуждать её здесь и продолжить, пока вас нет.`,
        share: 'Поделиться',
        justYouNote: 'Или создайте публичную ссылку, которую может открыть любой.',
        sharingOffTitle: ({ home }) => `${home} не делится сессиями с людьми`,
        sharingOffBody: 'Вы всё равно можете создать публичную ссылку, которую может открыть любой.',
        sharingOffPrivateBody: 'Сессии в этом Home остаются только у вас.',
        accessDenied: 'Изменить доступ могут только те, кто управляет этой сессией. Вы всё равно можете участвовать в разговорах.',
    } };

return { sessionCollaborationPaneTranslations };
})();

const Domain_sessionCollaborationTranslations = (() => {
const sessionCollaborationPaneTranslations = {...Domain_sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations, ...EnglishFeatures.sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations};

const en = Shared_sessionCollaborationTranslations.en;

const sessionCollaborationTranslations: Pick<Record<'en'|'ca'|'de'|'es'|'fr'|'it'|'ja'|'pl'|'pt'|'ru'|'zh-Hans'|'zh-Hant', typeof en>, "ru"> = { ru: { pane: sessionCollaborationPaneTranslations['ru'], title: 'Совместная работа', viewingNow: 'Сейчас просматривают', justYou: 'Только вы', typing: 'Печатает…', stale: 'Данные могут быть устаревшими', unavailable: 'Данные о присутствии недоступны', connecting: 'Подключение…', unnamed: 'Участник Happier', open: 'Открыть совместную работу', conversations: 'Разговоры', accessUnavailable: 'Доступ к сессии недоступен', accessUnavailableReason: 'Этот Home не поддерживает предоставление доступа к сессиям другим людям.', discussion: { featureUnavailable: "Разговоры не включены на этом Home.", bindingUnavailable: "Войдите в этот Home снова, чтобы увидеть разговоры.", scopeMismatch: "Эти разговоры принадлежат другой учётной записи на этом Home.", modeMismatch: "Содержимое не соответствует режиму шифрования сессии. Повторите попытку или попросите администратора сессии проверить доступ.",  title: 'Разговоры', newDiscussion: 'Новый разговор', create: 'Создать разговор', titlePlaceholder: 'Название разговора', messagePlaceholder: 'Напишите сообщение…', active: 'Активные', activeDisclosure: 'Показать активные разговоры', archived: 'В архиве', archivedDisclosure: 'Показать архивные разговоры', emptyActive: 'Активных разговоров пока нет.', emptyArchived: 'Архивных разговоров нет.', loading: 'Загрузка разговоров…', loadError: 'Не удалось загрузить разговоры.', retry: 'Повторить', checking: 'Проверка обновлений…', deliveryUnknown: 'Результат доставки неизвестен — проверьте перед повтором.', locked: 'Вы можете читать этот разговор, но не можете публиковать в нём.', offline: 'Вы не в сети. Подключитесь, чтобы продолжить.', unavailable: 'Этот разговор недоступен.', unreadCount: ({ count }) => `${count.toLocaleString()} непрочит.`, unreadMentionCount: ({ count }) => `${count.toLocaleString()} непрочит. упомин.`,
        mentioned: 'Вас упомянули', unreadConversations: 'Непрочитанные разговоры', messageCount: ({ count }) => count === 1 ? '1 сообщение' : `${count.toLocaleString()} сообщений`, viaAgent: 'Через агента', collaborator: 'Участник', contentUnavailable: 'Сообщение недоступно', rename: 'Переименовать разговор', archive: 'Архивировать разговор', restore: 'Восстановить разговор', selection: { copy: 'Копировать', askAgent: 'Спросить агента', sendToSession: 'Отправить в сессию', handoffError: 'Не удалось добавить выбранные сообщения в редактор сессии.' }, titleRequired: 'Добавьте название, чтобы начать этот разговор.', encryptedTitle: 'Зашифрованный разговор', archivedNotice: 'Этот разговор в архиве.', sessionArchived: 'Эта сессия в архиве.', postDenied: 'Вы больше не можете публиковать в этой сессии.', invalidMention: 'Упомянутый участник больше не может читать эту сессию.', invalidContent: 'Это сообщение нельзя отправить в таком виде. Возможно, оно пустое или слишком длинное.', idempotencyConflict: 'С этим идентификатором уже отправлено другое сообщение.', sendFailed: 'Не удалось отправить это сообщение.', dismiss: 'Закрыть', loadOlder: 'Загрузить более ранние сообщения', loadMore: 'Загрузить ещё разговоры' } } };

return { sessionCollaborationTranslations };
})();

const Domain_sessionCompanionTranslations = (() => {
type SessionCompanionTranslations = Shared_sessionCompanionTranslations.SessionCompanionTranslations;

const sessionCompanionTranslations = { ru: {
        status: {
            waitingForYou: 'Ждёт вас',
            pausedBeforeStep: ({ agent, step, total }) => `${agent} остановился перед шагом ${step} из ${total}`,
            stepOfPlan: ({ step, total }) => `Шаг ${step} из ${total} в плане`,
            agentFallback: 'Агент',
        },
        ask: {
            question: ({ summary }) => `${summary}?`,
            allow: 'Разрешить',
            deny: 'Отклонить',
            showInChat: 'Показать в чате',
            moreWaiting: ({ count }) => `Ещё ${count} ждут`,
            allowed: ({ summary }) => `Разрешено: ${summary}`,
            denied: ({ summary }) => `Отклонено: ${summary}`,
            justNow: 'только что',
            failed: 'Ваш ответ не дошёл до сессии. Попробуйте ещё раз.',
            answerWhenBack: ({ machine }) => `Ответить можно будет, когда ${machine} вернётся.`,
            answerWhenSessionBack: 'Ответить можно будет, когда сессия вернётся.',
            notAllowed: 'Отвечать могут только те, кто может запускать эту сессию.',
            groupA11y: 'Ждёт вас',
        },
        facts: {
            subagents: 'субагенты',
            changed: 'изменено',
            context: 'контекст',
            subagentsValue: ({ live, total }) => (live > 0 ? `${live} из ${total}` : `${total}`),
            contextValue: ({ percent }) => `${percent}%`,
            opensAgents: 'Открывает агентов',
            opensGit: 'Открывает Git',
            opensUsage: 'Открывает использование',
        },
        plan: {
            title: 'План',
            description: ({ agent }) => `Список задач ${agent} для этой сессии`,
            progress: ({ done, total }) => `${done} из ${total}`,
            progressA11y: ({ done, total }) => `Выполнено ${done} из ${total}`,
            emptyTitle: 'Плана пока нет',
            emptyReason: 'Когда агент напишет список задач, он появится здесь, шаг за шагом.',
            stepDone: 'Готово',
            stepCurrent: 'Текущий шаг',
        },
        picker: {
            open: 'Добавить в Спутник',
            chooseWidget: 'Выбрать виджет…',
            onTheBoard: ({ source }) => `${source} · на доске`,
        },
        drop: { keepBesideChat: 'Держать рядом с чатом' },
        freshness: { machineOffline: ({ machine }) => `${machine} не в сети` },
        needsYouA11y: ({ count }) => `Спутник, ${count} ждут вас`,
    } } as const satisfies Pick<Readonly<Record<string, SessionCompanionTranslations>>, "ru">;

return { sessionCompanionTranslations };
})();

const Domain_sessionConversationSurfaceTranslations = (() => {
const en = Shared_sessionConversationSurfaceTranslations.en;

const ru: typeof en = {
    discussion: {
        loadingTitle: 'Открываем беседу…',
        offlineTitle: 'Эта беседа недоступна офлайн',
        offlineReason: 'Подключитесь снова — она откроется там, где вы остановились.',
        errorTitle: 'Не удалось открыть беседу',
        lockedTitle: 'Эту беседу пока нельзя открыть на этом устройстве',
        lockedReason: 'Она защищена сквозным шифрованием, а настройки шифрования этого устройства не совпадают с настройками сеанса.',
        revokedTitle: 'У вас больше нет доступа к этой беседе',
        revokedReason: 'Этот сеанс вам больше не открыт. Ваши сообщения остаются в сеансе.',
        unavailableTitle: 'Беседы здесь недоступны',
        closeTab: 'Закрыть вкладку',
    },
    draft: {
        leadTitle: 'Спросить агента',
        leadBody: 'Он работает как отдельная беседа рядом с сеансом, а эти сообщения служат контекстом. Ничего не начнётся, пока вы не отправите.',
    },
    context: {
        fromConversation: ({ title, count }) => `Из «${title}» · сообщений: ${count}`,
        fromUntitled: ({ count }) => `Из беседы · сообщений: ${count}`,
    },
    origin: {
        fromConversation: ({ title }) => `из «${title}»`,
        fromUntitled: 'из беседы',
    },
    run: {
        details: 'Подробности запуска',
        loadingTitle: 'Открываем беседу с агентом…',
        errorTitle: 'Не удалось открыть беседу с агентом',
    },
};

const sessionConversationSurfaceTranslations = { ru };

return { sessionConversationSurfaceTranslations };
})();

const Domain_sessionDirectoryRecoveryTranslations = (() => {
const en = Shared_sessionDirectoryRecoveryTranslations.en;

const sessionDirectoryRecoveryTranslations = { ru: {
        title: ({ machine }) => `Личной папки этого чата больше нет на ${machine}.`,
        body: 'Можно продолжить в новой пустой папке. История чата останется здесь, но локальные файлы из прежней папки не будут восстановлены.',
        continue: 'Продолжить в новой папке', notNow: 'Не сейчас',
        offlineDelete: ({ machine }) => `Личная папка на ${machine} будет удалена, когда этот компьютер снова появится в сети.`,
    } } satisfies Pick<Record<import('../../_all').SupportedLanguage, typeof en>, "ru">;

return { sessionDirectoryRecoveryTranslations };
})();

const Domain_sessionDraftTranslations = (() => {
const en = Shared_sessionDraftTranslations.en;

const ru: typeof en = {
    sectionTitle: 'Черновики',
    sectionTitleForHome: ({ home }) => `Черновики в ${home}`,
    waitingSectionTitleForHome: ({ home }) => `Ожидание компьютера в ${home}`,
    badge: 'Черновик',
    untitled: 'Черновик без названия',
    continueEditing: 'Продолжить редактирование',
    startAnother: 'Начать ещё один',
    executionRunStart: {
        starting: 'Запуск разговора с агентом…',
        reconciling: 'Проверяем, начался ли этот разговор с агентом…',
        unresolved: 'Не удалось подтвердить, начался ли этот разговор с агентом. Повторный запуск может создать второй разговор.',
        targetChanged: 'Компьютер этой сессии сменился до того, как разговор успел начаться. Ничего не запущено.',
        secretReferenceOverlayUpdateRequired: 'Для общих секретов в разговоре с агентом нужен обновлённый компьютер. Ничего не запущено.',
    },
    status: {
        offline: 'Офлайн — сохранено на этом устройстве',
        syncing: 'Синхронизация…',
        conflict: 'Нужна проверка',
        unsupported: 'Не синхронизируется — этот Home не может синхронизировать этот черновик',
        startInterrupted: 'Запуск прерван',
    },
    availability: {
        machineUnavailable: 'Машина недоступна',
        pluginUnavailable: 'Плагин недоступен',
        attachmentNeedsAttention: 'Вложение требует внимания',
    },
    new: { action: 'Новая сессия' },
    delete: {
        action: 'Удалить черновик',
        confirmTitle: 'Удалить этот черновик?',
        confirmDescription: 'Черновик будет удалён со всех синхронизированных устройств.',
    },
    conflict: {
        title: 'Просмотрите конфликтующие изменения',
        description: 'Выберите, какую версию оставить для каждого поля. Перед заменой можно скопировать версию этого устройства.',
        mine: 'Это устройство',
        synced: 'Синхронизированная версия',
        useSynced: 'Взять синхронизированную',
        keepDevice: 'Оставить версию устройства',
        copyMine: 'Скопировать мою',
        copied: 'Скопировано',
        copyFailed: 'Не удалось скопировать это значение.',
        field: {
            text: 'Сообщение',
            mentions: 'Упоминания',
            attachments: 'Вложения',
            recipient: 'Получатель',
            agentContinuation: 'Продолжение агента',
            executionRunRequestedAction: 'Доставка запуска',
        },
    },
};

const sessionDraftTranslations = { ru };

return { sessionDraftTranslations };
})();

const Domain_sessionEmbeddedTranslations = (() => {
const en = Shared_sessionEmbeddedTranslations.en;

const translated = Shared_sessionEmbeddedTranslations.translated;

const sessionEmbeddedTranslations = { ru: translated({
        unavailable: 'Эта сессия недоступна',
        respondInSession: 'Откройте сессию, чтобы ответить.',
        regionLabel: ({ title }) => `Сессия: ${title}`,
        newChatWelcome: 'Над чем поработаем?',
    }) } as const;

return { sessionEmbeddedTranslations };
})();

const Domain_sessionFollowTranslations = (() => {
type SessionFollowTranslations = Shared_sessionFollowTranslations.SessionFollowTranslations;

const en = Shared_sessionFollowTranslations.en;

const sessionFollowTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionFollowTranslations
>, "ru"> = { 'ru': {
        "notificationBody": {"message":"Новое сообщение в этой сессии.","failed":"Ход завершился ошибкой.","cancelled":"Ход отменён.","sourceUnavailable":"Источник этой сессии недоступен."},
        "follow": "Подписаться",
        "unfollow": "Отписаться",
        "following": "Вы подписаны",
        "notifications": "Уведомления",
        "unavailableTitle": "Отслеживание недоступно",
        "unavailableDescription": "Этот Home не поддерживает отслеживание сессий.",
        "unreachableTitle": "Не удалось связаться с этим Home",
        "unreachableDescription": "Happier не смог проверить, поддерживает ли этот Home отслеживание сессий. Повторите попытку, когда он будет доступен.",
        "editor": {
            "title": "Подписаться на эту сессию",
            "subtitle": "Получайте важные для вас обновления.",
            "ownerSubtitle": "Эта сессия принадлежит вам, поэтому её обновления всегда доходят до вас.",
            "externalAttachedOnly": "Фоновая синхронизация выключена, поэтому обновления могут приходить только пока эта сессия подключена."
        },
        "level": {
            "none": "Без уведомлений",
            "important": "Важные обновления",
            "all_messages": "Каждое новое сообщение"
        },
        "voice": {
            "title": "Включить в Voice",
            "subtitle": "Voice сможет учитывать контекст этой сессии.",
            "waitingRuntime": "Ожидание подключения Voice.",
            "unsupported": "Эта среда не поддерживает включение отслеживаемых сессий в Voice.",
            "providerWithheld": "Этот режим Voice не может включать сохранённые обновления сессий.",
            "waitingEncrypted": "Разблокируйте сессию, чтобы включить её в Voice.",
            "initialSnapshotPending": "На следующем ходу Voice включить краткое описание текущего состояния."
        },
        "footer": "Подписка не меняет права доступа к этой сессии.",
        "settingsLink": "Настройки уведомлений…",
        "assignedExplanation": "Вы подписаны, потому что сессия назначена вам",
        "assignedNotice": "Вам назначена сессия.",
        "sharedNotice": "С вами поделились сессией.",
        "wakeEventExplanation": "Отслеживаемый контекст изменился, поэтому Happier разбудил этого агента с обновлением.",
        "accessLost": "У вас больше нет доступа к этой сессии.",
        "offline": "Вы не в сети. Подключитесь, чтобы изменить подписку.",
        "archived": "Подписка приостановлена, пока сессия в архиве.",
        "sources": {
            "title": "Обновления сессий",
            "waitingRuntime": "Ожидание повторного подключения целевой сессии.",
            "unsupported": "Обновите или переподключите CLI на целевой машине, чтобы получать обновления.",
            "pausedArchived": "Обновления приостановлены, пока исходная или целевая сессия находится в архиве.",
            "add": "Следить в другой сессии…",
            "addSource": "Отправлять обновления из другой сессии…",
            "chooseDestinationTitle": "Следить в другой сессии",
            "chooseSourceTitle": "Отправлять обновления из другой сессии",
            "row": ({ title }) => `Обновления из «${title}»`,
            "nextTurn": "Следующий ход",
            "wakeOnHumanChange": "Запускать, когда человек добавляет сообщение",
            "stop": "Остановить обновления",
            "stopForSource": ({ title }) => `Остановить обновления из «${title}»`,
            "includeNextTurn": "Добавить обновления в следующий ход целевой сессии.",
            "sourceKeyPreparing": "Подготовка зашифрованного доступа…",
            "sourceKeyWaiting": "Ожидание зашифрованного доступа.",
            "sourceKeyUnavailable": "Этот компьютер не может предоставить зашифрованный доступ.",
            "sourceSessionKeyUnavailable": "Зашифрованный доступ к этой сессии здесь недоступен.",
            "catchUpPending": "Ожидается синхронизация"
        },
        "preferences": {
            "title": "Подписываться автоматически",
            "assigned": "Назначенные мне сессии",
            "direct": "Сессии с прямым доступом",
            "team": "Сессии, доступные через команды",
            "group": "Сессии, доступные через группы",
            "help": "Применяется к новым назначениям и недавно доступным сессиям. Существующие настройки не меняются."
        }
    } };

return { sessionFollowTranslations };
})();

const Domain_sessionGitBranchesTranslations = (() => {
type SessionGitBranchesTranslations = Shared_sessionGitBranchesTranslations.SessionGitBranchesTranslations;

const en = Shared_sessionGitBranchesTranslations.en;

const ru: SessionGitBranchesTranslations = {
    openA11y: ({ branch }) => `Ветка ${branch}: переключить ветку или посмотреть отложенное`,
    searchPlaceholder: 'Переключиться или создать ветку',
    category: { current: 'Текущая', branches: 'Ветки', remote: 'Удалённые ветки', keptAside: 'Отложено', worktrees: 'Worktree', start: 'Начать новое' },
    tracks: ({ upstream }) => `следит за ${upstream}`,
    onlyHere: 'только на этом компьютере',
    changed: ({ count }) => `изменено: ${count}`,
    ahead: ({ count }) => `к отправке: ${count}`,
    keptAsideWhen: ({ origin, when }) => `${origin} · ${when}`,
    newBranch: ({ branch }) => `Новая ветка от ${branch}…`,
    newBranchDetached: 'Новая ветка…',
    newBranchSubtitle: 'Введите её имя в поле поиска',
    newWorktree: 'Новый worktree…',
    newWorktreeSubtitle: 'Работать в другой ветке в новой сессии',
    keepAside: 'Отложить изменения',
    keepAsideSubtitle: ({ count }) => `Отложить изменения (${count}) и начать с чистого листа`,
    keepAsideNothing: 'Нечего откладывать',
    keepAsideFailed: 'Не удалось отложить изменения.',
    loadFailed: 'Не удалось загрузить ветки',
    notice: {
        title: ({ branch }) => `Вы отложили изменения в ${branch}`,
        reason: ({ when }) => `Отложено ${when}. Верните их, чтобы продолжить.`,
        reasonUndated: 'Верните их, чтобы продолжить.',
        restore: 'Вернуть изменения',
        lookFirst: 'Сначала посмотреть',
        dismiss: 'Не сейчас',
        restoreFailed: 'Не удалось вернуть изменения.',
    },
};

const sessionGitBranchesTranslations = { ru };

return { sessionGitBranchesTranslations };
})();

const Domain_sessionGitDisplayTranslations = (() => {
const en = Shared_sessionGitDisplayTranslations.en;

const ru: typeof en = {
    settingsLayout: 'Макет панели Git',
    settingsShowAs: 'Показывать изменённые файлы как',
    trigger: 'Параметры отображения',
    paneGroup: 'Панель',
    changesGroup: 'Изменения',
    layout: 'Макет',
    layoutUnified: 'Единый',
    layoutTabs: 'Вкладки',
    layoutDescription: 'Одна прокрутка от изменений до истории или Изменения и История как два вида.',
    showAs: 'Показывать как',
    showAsList: 'Список',
    showAsTree: 'Дерево',
    showAsDescription: 'Изменённые файлы списком или по папкам, чтобы брать целые папки сразу.',
    density: 'Плотность',
    densityDefault: 'Обычная',
    densityCompact: 'Компактная',
    note: 'Строки дерева всегда компактные. Запоминается для вашего аккаунта.',
    selectFolder: ({ folder }) => `Выбрать все изменения в ${folder}`,
    selectFile: ({ file }) => `Выбрать ${file} для следующего коммита`,
};

const sessionGitDisplayTranslations = { ru };

return { sessionGitDisplayTranslations };
})();

const Domain_sessionGitPaneTranslations = (() => {
const en = Shared_sessionGitPaneTranslations.en;

const fidelity = Shared_sessionGitPaneTranslations.fidelity;

const withFidelity = Shared_sessionGitPaneTranslations.withFidelity;

const ru: typeof en = {
    scope: { allChanges: 'Все изменения' },
    subTabs: { changes: 'Изменения', sync: 'Синхронизация', history: 'История' },
    header: {
        changed: ({ count }) => `Изменено: ${count}`,
        toPush: ({ count }) => `К отправке: ${count}`,
        toPull: ({ count }) => `К получению: ${count}`,
        push: ({ count }) => `Отправить ${count}`,
        pull: ({ count }) => `Получить ${count}`,
        publish: 'Опубликовать',
        folderOnMachine: ({ folder, machine }) => `${folder} на ${machine}`,
    },
    groups: {
        session: 'Изменено в этой сессии',
        elsewhere: ({ repo }) => `В остальном ${repo}`,
        elsewhereUnnamed: 'В остальном репозитории',
        selectGroup: ({ group }) => `Выбрать все файлы в «${group}»`,
    },
    row: { renamedFrom: ({ path }) => `было ${path}` },
    commit: {
        toBranch: ({ branch }) => `Коммит в ${branch}`,
        selection: ({ count }) => `Файлов: ${count}`,
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
            dirtyTitle: ({ count, formatted }) => (count === 1 ? `У вас 1 изменение без коммита` : `Изменений без коммита: ${formatted}`),
            dirtyBody: 'Загрузка может их затронуть. Отложите их на время загрузки (они сразу вернутся) или позвольте Git загрузить, только если ничего не пересекается.',
            keepAsideAndPull: 'Отложить и загрузить',
            pullIfNoOverlap: 'Загрузить, если нет пересечений',
            divergedPullBody: 'И ваша ветка, и origin сдвинулись. Положите свои коммиты поверх коммитов origin или слейте их.',
            divergedPushBody: 'Сначала получите коммиты origin (свои поверх или слиянием), затем отправьте снова. Ваши коммиты остаются на этой машине.',
            rebase: 'Перебазировать на origin',
            merge: 'Слить origin',
        },
        writesOff: {
            title: 'Коммиты из Happier отключены',
            body: 'Вы можете читать и просматривать каждое изменение. Включите операции контроля версий, чтобы коммитить, отправлять и загружать отсюда.',
            turnOn: 'Включить',
        },
        header: {
            noChanges: 'нет изменений',
        },
        action: {
            fetch: 'Получить',
            publish: 'Опубликовать ветку',
            createPr: 'Создать PR',
            openPr: ({ number }) => `#${number}`,
            resolve: ({ count }) => `Разрешить: ${count}`,
            upToDate: 'Актуально',
            pushing: ({ count }) => `Отправка: ${count}…`,
            pulling: ({ count }) => `Загрузка: ${count}…`,
            fetching: 'Получение…',
            publishing: 'Публикация…',
            creatingPr: 'Создание…',
        },
        menu: {
            open: 'Другие действия синхронизации',
            push: 'Отправить',
            pull: 'Загрузить',
            pushTo: ({ target }) => `в ${target}`,
            pullFrom: ({ target }) => `из ${target}`,
            nothingToPush: 'Нечего отправлять',
            upToDate: 'Актуально',
            fetchHint: 'Проверить новые коммиты в origin',
            publishHint: 'Разместить эту ветку в origin',
            createPr: 'Создать pull request…',
            createPrInto: ({ base }) => `в ${base}`,
            unavailable: 'Здесь недоступно',
            more: 'Ещё',
        },
        running: {
            branchSwitch: 'Переключение ветки…',
            branchCreate: 'Создание ветки…',
            stashCreate: 'Изменения откладываются…',
            discard: 'Отмена изменений…',
            revert: 'Откат коммита…',
            generic: 'Выполняется…',
        },
        done: {
            untouched: ({ count, formatted }) => (count === 1 ? `ваше изменение без коммита не затронуто` : `ваши изменения без коммита (${formatted}) не затронуты`),
            commit: 'Закоммичено',
            commitFiles: ({ count, formatted }) => (count === 1 ? `Закоммичен 1 файл` : `Закоммичено файлов: ${formatted}`),
            push: 'Отправлено',
            pushCommits: ({ count, formatted }) => (count === 1 ? `Отправлен 1 коммит` : `Отправлено коммитов: ${formatted}`),
            upToDate: ({ target }) => `${target} актуален`,
            pull: 'Загружено',
            pullCommits: ({ count, formatted }) => (count === 1 ? `Загружен 1 коммит` : `Загружено коммитов: ${formatted}`),
            fetch: ({ target }) => `${target} проверен`,
            branchSwitch: 'Ветка переключена',
            branchCreate: 'Ветка создана',
            stashCreate: 'Изменения отложены',
            discard: 'Изменения отменены',
            revert: 'Коммит откачен',
            pullRequest: 'Pull request готов',
            generic: 'Готово',
        },
        failed: {
            unknownTitle: 'Не удалось подтвердить, чем это закончилось',
            unknownBody: 'Машина перестала отвечать до ответа Git. Проверьте снова, чтобы увидеть, что произошло.',
            origin: 'origin',
            thisMachine: 'эта машина',
            refreshTitle: 'Закоммичено, но список не обновился',
            refreshBody: 'Коммит в сохранности. Повторите, чтобы увидеть текущие изменения.',
            rejectedTitle: ({ target }) => `В ${target} есть коммиты, которых у вас нет`,
            rejectedBody: 'Получите их, чтобы увидеть изменения. Ваши коммиты останутся на этой машине до следующей отправки.',
            authTitle: ({ machine, provider }) => `${provider} не принял вход с ${machine}`,
            authBody: ({ machine }) => `У Git на ${machine} нет действующих учётных данных для этого удалённого репозитория. Войдите там и повторите.`,
            offlineTitle: ({ machine }) => `${machine} не в сети`,
            offlineBody: 'Сейчас там ничего нельзя запустить. Ваша работа в сохранности на той машине.',
            conflictTitle: 'Остановлено из-за конфликтующих изменений',
            conflictBody: 'Некоторые файлы изменены с обеих сторон. Разрешите их и продолжите.',
            networkTitle: ({ target }) => `Не удалось связаться с ${target}`,
            networkBody: 'Машина не смогла подключиться к удалённому репозиторию. Проверьте сеть и повторите.',
            commitTitle: 'Коммит не выполнен',
            pushTitle: 'Отправка не выполнена',
            pullTitle: 'Загрузка не выполнена',
            fetchTitle: 'Не удалось проверить новые коммиты',
            pullRequestTitle: 'Pull request не создан',
            genericTitle: 'Не удалось выполнить',
        },
        recover: {
            open: 'Открыть',
            tryAgain: 'Повторить',
            fetch: 'Получить',
            checkAgain: 'Проверить снова',
            showConflicts: 'Показать конфликты',
        },
        timeline: {
            title: 'Хронология',
            now: 'Сейчас',
            loading: 'Чтение истории…',
            uncommitted: ({ count, formatted }) => (count === 1 ? `1 изменение без коммита` : `Изменений без коммита: ${formatted}`),
            selected: ({ count, formatted }) => (count === 1 ? `1 выбрано для следующего коммита` : `Выбрано для следующего коммита: ${formatted}`),
            nothingSelected: 'Ничего не выбрано',
            earlierToday: 'Сегодня, раньше',
            yesterday: 'Вчера',
            older: 'Раньше',
            justNow: 'только что',
            toPull: 'к загрузке',
            originFurther: ({ name }) => `${name} дальше`,
            originA11y: ({ name }) => `${name} здесь`,
        },
        clean: {
            titleUpToDate: 'Всё закоммичено и отправлено',
            titleCommitted: 'Всё закоммичено',
            bodyUpToDate: ({ branch, upstream }) => `${branch} совпадает с ${upstream}. Новые изменения этой сессии появятся здесь.`,
            body: 'Новые изменения этой сессии появятся здесь.',
            createPullRequest: 'Создать pull request',
            openPullRequest: ({ number }) => `Открыть pull request #${number}`,
            lastCommit: ({ when }) => `Последний коммит ${when}`,
        },
        conflicts: {
            skip: 'Пропустить этот коммит',
            askAgentTask: ({ files, operation }) => `Разреши конфликты операции «${operation}» в ${files}. Сохрани замысел обеих сторон, отредактируй и проиндексируй разрешённые файлы, затем остановись для моей проверки. Не продолжай, не прерывай, не делай коммит и push и не бери одну сторону целиком.`,
            revert: 'отмена коммита',
            cherryPick: 'cherry-pick',
            merge: 'слияние',
            rebase: 'rebase',
            stopped: ({ count, formatted, operation }) => (count === 1 ? `Операция «${operation}» остановлена: 1 файл изменён с обеих сторон` : `Операция «${operation}» остановлена: файлов изменено с обеих сторон — ${formatted}`),
            readyToContinue: ({ operation }) => `Все конфликты разрешены. Продолжите операцию «${operation}».`,
            filesInConflict: ({ count, formatted }) => (count === 1 ? `1 файл в конфликте` : `Файлов в конфликте: ${formatted}`),
            body: 'Откройте каждый файл в разделе «Нужны вы» или попросите агента разрешить их.',
            continueBody: 'Ничего не будет закоммичено, пока вы не продолжите.',
            askAgent: 'Попросить агента разрешить',
            continue: ({ operation }) => `Продолжить: ${operation}`,
            abort: ({ operation }) => `Прервать: ${operation}`,
            abortTitle: ({ operation }) => `Прервать операцию «${operation}»?`,
            abortBody: 'Ветка вернётся в состояние до начала. Сделанные разрешения будут потеряны.',
            needsYou: 'Нужны вы',
            mergedCleanly: 'Слито без конфликтов',
        },
        commit: {
            selectFirst: 'Выберите файлы для коммита',
        },
        tools: {
            title: 'Удалённые репозитории и слияния',
            subtitle: 'Добавить удалённый репозиторий, слить или перебазировать ветку',
        },
    },
    paused: { reason: 'сессия приостановлена', resume: 'Продолжить' },
    notRepository: {
        title: 'Отслеживайте, что меняют агенты',
        body: ({ folder }) => `${folder} пока не репозиторий. Создайте его, чтобы проверять, коммитить и отменять каждое изменение.`,
        bodyUnnamed: 'Эта папка пока не репозиторий. Создайте его, чтобы проверять, коммитить и отменять каждое изменение.',
    },
};

const sessionGitPaneTranslations = { ru: withFidelity(ru) };

return { sessionGitPaneTranslations };
})();

const Domain_sessionGitPullRequestTranslations = (() => {
type ProviderArgs = Shared_sessionGitPullRequestTranslations.ProviderArgs;

type GitPullRequestCopy = Shared_sessionGitPullRequestTranslations.GitPullRequestCopy;

const en = Shared_sessionGitPullRequestTranslations.en;

const ru: GitPullRequestCopy = {
    form: {
        title: 'Новый pull request', expand: 'Открыть в панели деталей', moveBack: 'Вернуть в боковую панель',
        close: 'Закрыть форму (черновик сохранится)', base: 'Слияние в', titlePlaceholder: 'Заголовок',
        bodyPlaceholder: 'Что изменилось и почему', draft: 'Черновик', create: 'Создать pull request', creating: 'Создание…',
        continueOn: ({ provider }) => `Продолжить в ${provider}`, pointer: 'Новый pull request открыт в деталях', pointerShow: 'Показать',
        openedProviderPage: ({ provider }) => `${provider} открыт, чтобы закончить; ваш текст сохранён здесь.`,
    },
    failure: {
        authFailed: ({ provider }) => `${provider} не принял вход с этой машины`,
        network: ({ provider }) => `Не удалось связаться с ${provider}`,
        machineOffline: 'Машина не в сети; черновик сохранён',
        blocked: 'Выполняется другая операция Git; попробуйте, когда она завершится',
        other: 'Pull request не создан',
    },
    card: {
        number: ({ number }) => `#${number}`, intoBase: ({ base }) => `в ${base}`,
        state: { open: 'Открыт', draft: 'Черновик', merged: 'Слит', closed: 'Закрыт', unknown: 'Pull request' },
        checks: { pending: 'Проверки идут', success: 'Проверки пройдены', failure: 'Проверки не пройдены', unknown: 'Проверки' },
        openOn: ({ provider }) => `Открыть в ${provider}`, copyLink: 'Копировать ссылку', copied: 'Ссылка скопирована',
    },
    settings: {
        placementTitle: 'Открывать новые pull requests в', placementDescription: 'На телефоне форма всегда открывается отдельной страницей.',
        sidebar: 'Боковой панели', details: 'Панели деталей',
    },
};

const sessionGitPullRequestTranslations = { ru };

return { sessionGitPullRequestTranslations };
})();

const Domain_sessionHomeFreshnessTranslations = (() => {
const en = Shared_sessionHomeFreshnessTranslations.en;

const translated = Shared_sessionHomeFreshnessTranslations.translated;

const sessionHomeFreshnessTranslations = { ru: translated({
        offline: 'Не в сети',
        stale: 'Не удалось обновить',
        lastUpdated: ({ ago }) => `Обновлено ${ago} назад`,
    }) };

return { sessionHomeFreshnessTranslations };
})();

const Domain_sessionListFilterTranslations = (() => {
const en = Shared_sessionListFilterTranslations.en;

const translated = Shared_sessionListFilterTranslations.translated;

const sessionListFilterTranslations = { ru: translated({
        filtersTitle: 'Фильтры сессий', filtersSearch: 'Поиск фильтров…', filtersShow: 'Показывать',
        filtersScope: 'Охват', filtersShowSessions: 'Сессии', filtersShowRuns: 'Запуски', filtersShowBoth: 'Оба',
        filtersShowBothSummary: 'Сессии и запуски', filtersStartedByNone: 'Инициаторы не выбраны',
        filtersStartedBy: 'Кто запустил', filtersStartedByYou: 'Вы', filtersStartedByTriggers: 'Триггеры', filtersStartedByAgents: 'Агенты',
        filtersRunsNeedingYouAlwaysShow: 'Запуски, которым вы нужны, всегда отображаются',
        filtersMyWork: 'Моя работа', filtersLegacyOwnerDirect: 'Собственные и напрямую предоставленные', filtersAssignedToMe: 'Назначенные мне', filtersFollowing: 'Отслеживаемые',
        filtersInvolvingMe: 'С моим участием', filtersAllAccessible: 'Все доступные', filtersAttention: 'Внимание',
        filtersAttentionAny: 'Любые', filtersAttentionNeedsMe: 'Только сессии, которым я нужен', filtersScopeNeedsMe: 'Нужен я',
        filtersInactive: 'Неактивные сессии', filtersInactiveShow: 'Показывать', filtersInactiveHide: 'Скрывать',
        filtersHomes: 'Home', filtersSharedWith: 'Общий доступ', filtersOutsideTeams: 'Личные и прямые',
        filtersTags: 'Теги', filtersSource: 'Источник', filtersSourceAll: 'Все',
        filtersSourceDirect: 'Внешние',
        filtersNoOptions: 'Нет доступных фильтров', filtersClear: 'Сбросить фильтры', filtersDone: 'Готово', filtersArchived: 'Архив',
        filtersNeedsMeOnly: 'Только ждущие меня', filtersNeedsMeOnlyDescription: 'Сессии, которые ждут вас', filtersSourceHappier: 'Happier',
        filtersMoreTags: ({ count }: { count: number }) => `+ ${count} ещё`,
        filtersResultCount: ({ count }: { count: number }) => (count % 10 === 1 && count % 100 !== 11) ? `${count} элемент` : (count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14)) ? `${count} элемента` : `${count} элементов`,
        queryInitialLoadingTitle: 'Загрузка сессий…', queryUpdatingTitle: 'Обновление сессий…',
        querySomeHomesUnavailableTitle: 'Некоторые Home недоступны', querySomeHomesUnavailableDescription: 'Happier показывает доступные данные. Повторите попытку, когда эти Home снова будут в сети.',
        queryRefreshFailedTitle: 'Не удалось обновить', queryRefreshFailedRetainedDescription: 'Загруженные сессии остались на месте. Повторите попытку, чтобы проверить обновления.', queryRefreshFailedEmptyDescription: 'Happier не удалось загрузить сессии из выбранных Home. Повторите попытку, когда они станут доступны.',
        queryNoMatchesLoadedTitle: 'Нет совпадений в загруженных сессиях', queryNoMatchesLoadedDescription: 'Другие подходящие сессии могут находиться на более старой странице.', querySearchOlder: 'Искать в старых сессиях',
        queryMoreAvailableTitle: 'Могут быть доступны другие сессии', queryMoreAvailableDescription: 'Этот вид включает загруженные сессии. Продолжите поиск в старых сессиях.',
        queryNoMatchesTitle: 'Нет подходящих сессий', queryNoMatchesDescription: 'Попробуйте изменить активные фильтры.',
        queryTeamEmptyTitle: 'У этой команды нет сессий', queryTeamEmptyDescription: 'Сессии, доступные этой команде, появятся здесь.',
        queryMyWorkEmptyTitle: 'В разделе «Моя работа» ничего нет', queryScopeEmptyDescription: 'Попробуйте более широкий охват или вернитесь позже.', queryBrowseAllAccessible: 'Показать все сессии',
        queryAssignedEmptyTitle: 'Вам не назначено ни одной сессии', queryFollowingEmptyTitle: 'Нет отслеживаемых сессий', queryInvolvingEmptyTitle: 'Нет сессий с вашим участием',
        queryAttentionEmptyTitle: 'Ни одна сессия не требует вашего внимания', queryReachableEmptyTitle: 'Нет доступных сессий', queryReachableEmptyDescription: 'В доступных Home нет сессий, подходящих этому виду.',
        queryHistoricalSharesWithheldTitle: 'Некоторые общие сессии скрыты', queryHistoricalSharesWithheldDescription: 'Сессии, которыми с вами поделились в более ранней версии Happier, скрыты, пока владелец не обновит их в Happier.',
        partialHomeNotMountedTitle: ({ home }) => `${home} не входит в это представление сессий`,
        partialHomeNotMountedDescription: 'Добавьте этот Home в видимую группу Homes, чтобы показать сессии команды без смены фокуса.',
        partialShowFromHome: ({ home }) => `Показать сессии из ${home}`,
        teamListingUnavailableTitle: 'Список сессий команды недоступен на этом Home',
        teamListingUnavailableDescription: 'Этот Home пока не может отображать сессии команды. Обновите или перенастройте его и повторите попытку.',
        teamListingLoadingTitle: ({ team }) => `Загрузка сессий ${team}…`,
        teamListingLoadingDescription: 'Happier проверяет, что этот Home может показать.',
        teamListingProbeFailedTitle: 'Не удалось связаться с этим Home',
        teamListingProbeFailedDescription: 'Happier не смог запросить сессии команды у этого Home. Повторите попытку, когда он будет доступен.',
    }) };

return { sessionListFilterTranslations };
})();

const Domain_sessionMessageAccountActorTranslations = (() => {
type AccountActorTranslations = Shared_sessionMessageAccountActorTranslations.AccountActorTranslations;

const sessionMessageAccountActorTranslations: Pick<Record<SupportedLanguage, AccountActorTranslations>, "ru"> = { ru: { accountActorYou: 'Вы', accountActorFormerMember: 'Бывший участник', accountActorUnnamedMember: 'Участник Happier', accountActorSentBy: ({ name }) => `Отправитель: ${name}` } };

return { sessionMessageAccountActorTranslations };
})();

const Domain_sessionPageTranslations = (() => {
const english = Shared_sessionPageTranslations.english;

const translated = Shared_sessionPageTranslations.translated;

const sessionPageTranslations = { ru: translated({
        sessionPages: {
            info: {
                continueTitle: 'Продолжить',
                continueDescription: 'Начните новую работу с того места, где сейчас эта сессия.',
                organizeTitle: 'Упорядочить',
                organizeDescription: 'Где эта сессия показывается в ваших списках.',
                activityDescription: 'Что делает агент и узнаете ли вы об этом.',
                detailsTitle: 'Подробности',
                detailsDescription: 'Идентификаторы и история для поддержки и скриптов.',
                environmentTitle: 'Окружение',
                environmentDescription: 'Машина, папка и агент, с которыми работает эта сессия.',
                agentStateDescription: 'Кто управляет агентом и чего он ждёт.',
                relatedTitle: 'Связанное',
                relatedDescription: 'Другие страницы этой сессии.',
                developerTitle: 'Разработчик',
                developerDescription: 'Необработанные данные для отладки, видны в режиме разработчика.',
                leaveLabel: 'Остановить, архивировать или удалить',
                leaveFootnote: 'Остановка завершает запущенный процесс. Архивные сессии можно восстановить. Удаление навсегда стирает сессию и её сообщения.',
            },
            follow: {
                description: 'Выберите, будет ли эта сессия уведомлять вас и говорить голосом.',
            },
            permissions: {
                description: 'Инструменты, разрешённые для этой сессии с другого устройства. Отзовите ненужные.',
            },
            automations: {
                description: 'Работа, которая выполняется в этой сессии по расписанию, по событию или после хода.',
            },
            newRun: {
                description: 'Запустите суб-агента из этой сессии.',
                transcriptReadOnly: 'Это сохранённая история. Подключитесь к этому Home снова, чтобы продолжить разговор.',
                daemonReadOnly: 'Эта история получена из процесса агента. Подключитесь к этому Home снова, чтобы продолжить разговор.',
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
>, "ru"> = { ru: {
        due: 'Время напоминания',
        title: 'Напомнить', inOneHour: 'Через 1 час', inThreeHours: 'Через 3 часа',
        tomorrowMorning: 'Завтра утром', nextWeek: 'На следующей неделе', custom: 'Выбрать дату и время…',
        customTitle: 'Выбрать дату и время',
        customPlaceholder: '2026-09-08 09:00', futureTimeRequired: 'Выберите время в будущем.',
        setReminder: 'Установить напоминание',
        reminderSaved: 'Напоминание сохранено',
        presetSaveFailedAfterReminder: 'Напоминание сохранено, но сохранение шаблона не подтверждено. Повторите попытку или закройте окно.',
        presetsSaveFailed: 'Сохранение шаблонов не подтверждено. Изменения сохранены здесь; попробуйте ещё раз.',
        presetsChanged: 'Сохранённые шаблоны отличаются от открытого списка. Закройте и откройте его снова, чтобы проверить актуальный список.',
        remove: 'Удалить напоминание',
        dateLabel: 'Дата', timeLabel: 'Время', addToPresets: 'Добавить в шаблоны', presetPreviewUnavailable: 'Выберите корректное время в будущем для предпросмотра.', managePresets: 'Управление шаблонами', managePresetsMessage: 'Переименовывайте, меняйте порядок или удаляйте сохранённые напоминания.', presetName: 'Название шаблона', movePresetUp: 'Переместить вверх', movePresetDown: 'Переместить вниз', renamePresetLabel: ({ preset }) => `Переименовать «${preset}»`, movePresetUpLabel: ({ preset }) => `Переместить «${preset}» вверх`, movePresetDownLabel: ({ preset }) => `Переместить «${preset}» вниз`, deletePresetLabel: ({ preset }) => `Удалить «${preset}»`, noPresets: 'Нет сохранённых шаблонов', noPresetsMessage: 'Сохраните шаблон при следующем выборе своего времени.',
    } };

return { sessionReminderTranslations };
})();

const Domain_sessionRemotePermissionGrantTranslations = (() => {
type SessionRemotePermissionGrantTranslations = Shared_sessionRemotePermissionGrantTranslations.SessionRemotePermissionGrantTranslations;

const sessionRemotePermissionGrantTranslations = { ru: {
        title: 'Удалённые разрешения',
        entryTitle: 'Удалённые разрешения',
        entrySubtitle: 'Проверяйте и отзывайте удалённые разрешения сеанса',
        loadingTitle: 'Загрузка удалённых разрешений',
        loadingReason: 'Проверяем разрешения текущего владельца сеанса.',
        emptyTitle: 'Нет удалённых разрешений',
        emptyReason: 'В этом сеансе нет разрешений для проверки.',
        unavailableTitle: 'Удалённые разрешения недоступны',
        unavailableReason: 'Проверьте, что это текущий владелец сеанса и его машина доступна, затем повторите попытку.',
        ownerOnlyTitle: 'Только владелец сеанса может управлять удалёнными разрешениями',
        ownerOnlyReason: 'Общие участники могут отвечать на подходящие запросы, но не могут проверять или отзывать разрешения владельца сеанса.',
        retry: 'Повторить',
        listTitle: 'Разрешения сеанса',
        grantActive: ({ actor }) => `Активное разрешение от ${actor}`,
        grantRevoked: ({ actor }) => `Отозванное разрешение от ${actor}`,
        grantDetail: ({ grantId, sourceRef, sourceRevisionOrEpoch }) => `Разрешение ${grantId} · Источник ${sourceRef} (${sourceRevisionOrEpoch})`,
        revoke: 'Отозвать разрешение',
        revoking: 'Отзыв…',
        revokeConfirmTitle: 'Отозвать удалённое разрешение?',
        revokeConfirmBody: ({ identifier }) => `Это немедленно отзовёт удалённое разрешение для ${identifier}.`,
        revokeFailedTitle: 'Не удалось обновить удалённые разрешения',
        revokeFailedReason: 'Разрешение могло измениться или машина владельца недоступна. Повторите попытку.',
        loadMore: 'Загрузить ещё разрешения',
        loadingMore: 'Загружаем ещё разрешения…',
        loadMoreFailedReason: 'Не удалось загрузить дополнительные разрешения. Повторите попытку.',
    } } as const satisfies Pick<Readonly<Record<string, SessionRemotePermissionGrantTranslations>>, "ru">;

return { sessionRemotePermissionGrantTranslations };
})();

const Domain_sessionResponsibilityTranslations = (() => {
type SessionResponsibilityTranslations = Shared_sessionResponsibilityTranslations.SessionResponsibilityTranslations;

const en = Shared_sessionResponsibilityTranslations.en;

const sessionResponsibilityTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionResponsibilityTranslations
>, "ru"> = { ru: {
        responsibilitySectionTitle: 'Ответственность',
        responsibilityRowTitle: 'Ответственный',
        responsibilityNoOne: 'Никто',
        responsibilityUnnamedPerson: 'Без имени',
        responsibilityPickerTitle: 'Выберите ответственного',
        responsibilitySearchPlaceholder: 'Поиск среди людей с доступом',
        responsibilityAssignToMe: 'Назначить себя',
        responsibilityPeopleWithAccess: 'Люди с доступом',
        responsibilityAccessHintOwner: 'Владелец',
        responsibilityNoCandidates: 'Пока больше ни у кого нет доступа к этой сессии.',
        responsibilityAccessChanged: 'Доступ изменился. Этот человек больше не может быть ответственным.',
        responsibilityUpdateFailed: 'Happier не смог обновить ответственного. Попробуйте ещё раз.',
        responsibilityApprovalPending: 'Ожидается подтверждение. Пока ничего не изменилось — ответственный обновится после подтверждения.',
        responsibilityA11yEditable: ({ name }: { name: string }) =>
            `Ответственный, ${name}. Изменить ответственного.`,
        responsibilityA11yReadOnly: ({ name }: { name: string }) => `Ответственный, ${name}.`,
        responsibilityA11yEmpty: 'Ответственный, никто. Изменить ответственного.',
        responsibilityAssignedToYou: 'Назначено вам',
        responsibilitySharedWithYou: 'Доступ открыт вам',
    } };

return { sessionResponsibilityTranslations };
})();

const Domain_sessionWorkTranslations = (() => {
const en = Shared_sessionWorkTranslations.en;

const ru: typeof en = {
    workerUpdate: {
        settled: "Завершено",
        stalled: "Застопорилось",
        published: "Опубликовано",
        truncated: "Результат сокращён.",
        wokenBy: ({ count }) => (count === 1 ? 'Разбужено обновлением' : `Разбужено обновлениями: ${count}`),
        notFromYou: 'это не ваше сообщение',
    },
    title: 'Работа',
    subtitle: {
        sessions: ({ count }) => `Сессий: ${count}`,
        runs: ({ count }) => `Запусков: ${count}`,
        nothingStarted: 'Пока ничего не запущено',
    },
    states: {
        recent: 'Недавние',
    },
    view: {
        a11y: 'Вид работы',
        list: 'Список',
        map: 'Карта',
        expandMap: 'Открыть карту рядом с сессией',
    },
    map: {
        positionUnder: ({ position, total, parent }) => `${position} из ${total} под ${parent}`,
    },
    actions: {
        makeOrchestrator: 'Сделать оркестратором',
        makeOrchestratorSubtitle: 'Эта сессия планирует, делегирует и отчитывается',
        makeOrchestratorFailed: "Не удалось сделать сессию оркестратором",
    },
    putUnder: {
        title: "Подчинить…",
        subtitle: "Отчитываться перед другой сессией",
        search: "Найти сессию",
        topLevel: "Верхний уровень — ни перед кем не отчитывается",
        errors: {
            cycle: "Та сессия уже отчитывается перед этой",
            changed: "Сессию только что переместили. Попробуйте снова",
            forbidden: "Нельзя подчинить её этой сессии",
            failed: "Не удалось переместить сессию",
        },
    },
    kinds: {
        session: 'Сессия',
        workflowRun: 'Запуск процесса',
        backgroundRun: 'Фоновый запуск',
    },
    showMore: ({ count }) => `Показать ещё ${count}`,
    role: {
        none: 'Нет',
        handsOff: 'без правок',
        a11y: ({ role }) => `Роль: ${role}. Изменить роль`,
    },
    empty: {
        title: 'Работа ещё не начата',
        reason: 'Здесь появятся сессии, рабочие процессы и фоновые запуски, начатые этой сессией, вместе со всем, что требует вашего внимания.',
    },
    row: {
        a11y: ({ title, status }) => `${title}, ${status}`,
    },
    progress: ({ completed, total }) => `${completed} из ${total}`,
    strip: {
        openInSidebar: 'Открыть на боковой панели',
        stillWorking: ({ count }) => `В работе: ${count}`,
        needsYou: ({ count }) => `Ждут вас: ${count}`,
        a11y: ({ summary }) => `Работа: ${summary}`,
    },
    leadArchived: ({ count }) => `Эта сессия в архиве · в работе: ${count}`,
    runsStale: 'Запуски рабочих процессов могут быть неактуальны',
    list: {
        level: ({ level }) => `Уровень ${level}`,
        subSessions: ({ count }) => `Подсессий: ${count}`,
        reportsWorking: ({ count }) => `В работе: ${count}`,
        reportsNeedYou: ({ count }) => `Подсессий ждут вас: ${count}`,
    },
    archive: {
        alsoArchiveReports: ({ count }) => `Также архивировать подсессии (${count})`,
        someNotArchivedTitle: ({ count }) => `Не удалось архивировать подсессий: ${count}`,
    },
    peek: {
        reportsTo: ({ lead }) => `Отчитывается перед ${lead}`,
        repliesGoHere: 'Ответы уходят в эту сессию',
    },
};

const notify = { ru: { turn: 'Уведомить меня, когда этот ход завершится', attention: 'Уведомить меня, когда потребуется моё участие', armed: 'Вы получите уведомление', cancel: 'Отменить уведомление', failed: 'Не удалось обновить уведомление. Попробуйте ещё раз.', turnFinished: 'Ход этой сессии завершён.', needsYou: 'Эта сессия требует вашего участия.', settings: 'Настройки уведомлений' } };

const runNotify = { ru: { run: 'Уведомить меня, когда это завершится', runFinished: 'Это выполнение завершено.', runNeedsYou: 'Это выполнение требует вашего участия.', setup: 'Настроить уведомления' } };

const sessionWorkTranslations = { ru: { ...ru, notify: { ...notify.ru, ...runNotify.ru } } };

return { notify, runNotify, sessionWorkTranslations };
})();

const Domain_settingsConnectionsTranslations = (() => {
type MachineParams = Shared_settingsConnectionsTranslations.MachineParams;

const en = Shared_settingsConnectionsTranslations.en;

const ru = {
    sectionTitle: 'Подключения',
    sectionDescription: 'Как ваши устройства подключаются к вашим машинам.',
    directTitle: 'Подключаться напрямую, когда возможно',
    directOnDescription: 'Превью, трансляции и передача файлов идут напрямую между вашими устройствами, когда они доступны друг другу, а иначе через Happier.',
    directOffDescription: 'Всё идёт через Happier. Ничто не подключается к вашим машинам напрямую; в одной сети это немного медленнее.',
    serverDenied: 'Сервер вашего Home направляет всё через Happier, поэтому здесь нечего выбирать.',
    machineSectionTitle: 'Подключение',
    machineTitle: ({ machine }: MachineParams) => `Подключение к ${machine}`,
    machineOptionDefault: 'По умолчанию',
    machineOptionDirect: 'Напрямую',
    machineOptionRelay: 'Через Happier',
    machineDefaultDescription: ({ machine }: MachineParams) => `Как в аккаунте: напрямую, когда ${machine} доступен, иначе через Happier.`,
    machineDefaultOffDescription: 'Как в аккаунте: всегда через Happier.',
    machineDirectDescription: ({ machine }: MachineParams) => `Напрямую, когда ${machine} доступен, даже если в аккаунте указано иначе.`,
    machineRelayDescription: 'Всегда через Happier, даже в одной сети.',
};

const settingsConnectionsTranslations = { ru };

return { settingsConnectionsTranslations };
})();

const Domain_settingsMachinesTranslations = (() => {
const en = Shared_settingsMachinesTranslations.en;

const ru: typeof en = {
    pageDescription: 'Компьютеры, на которых выполняются ваши сессии, и пулы, которые выбирают между ними.',
    thisComputerTitle: 'Этот компьютер',
    thisComputerRowSubtitle: 'Фоновая служба и командная строка',
    thisComputerPageDescription: 'Фоновая служба и командная строка Happier на этом устройстве.',
    setupSectionTitle: 'Настройка',
    setupRowSubtitle: 'Установите Happier здесь и подключите его к своему Home.',
    addPageDescription: 'Подключите компьютер, чтобы агенты могли выполнять на нём ваши сессии.',
    addFromComputerTitle: 'Добавляйте машины с компьютера',
    addFromComputerDescription: 'Откройте Happier на компьютере, который хотите добавить, или подключите его по SSH из Happier на компьютере или в браузере.',
    searchPlaceholder: 'Поиск машин',
    count: ({ count }: { count: number }) => {
        const lastDigit = count % 10;
        const lastTwo = count % 100;
        if (lastDigit === 1 && lastTwo !== 11) return `${count} машина`;
        if (lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14)) return `${count} машины`;
        return `${count} машин`;
    },
    daemonTitle: 'Фоновая служба',
    daemonDescription: 'Выполняет ваши сессии на этом компьютере и поддерживает его связь с Home.',
    unreadableTitle: ({ home }: { home: string }) => `Не удалось прочитать машины в ${home}`,
};

const settingsMachinesTranslations = { ru };

return { settingsMachinesTranslations };
})();

const Domain_settingsOverviewTranslations = (() => {
type SettingsOverviewTranslation = Shared_settingsOverviewTranslations.SettingsOverviewTranslation;

const slavicPlural = Shared_settingsOverviewTranslations.slavicPlural;

const settingsOverviewTranslations = { ru: {
        attentionTitle: 'Требует внимания',
        agentNeedsSignIn: ({ agent, machine }) => `${agent}: нужен вход на ${machine}`,
        agentNeedsSignInNoMachine: ({ agent }) => `${agent}: нужен вход`,
        serviceSignInExpired: ({ service }) => `${service}: срок входа истёк`,
        signIn: 'Войти',
        signInAgain: 'Войти снова',
        setupTitle: 'Начало работы',
        setupProgress: ({ done, total }) => `${done} из ${total}`,
        setupActionSaveKey: 'Сохранить ключ',
        setupActionAddMachine: 'Добавить машину',
        setupActionShowQr: 'Показать QR',
        setupActionScan: 'Сканировать',
        setupActionPasteLink: 'Вставить ссылку',
        setupActionBrowse: 'Открыть',
        machineUpdateVersions: ({ current, latest }) => `Happier ${current} на этой машине · доступна ${latest}`,
        connectTerminalTitle: 'Подключить терминал',
        connectTerminalSubtitle: 'Отсканируйте код из терминала или вставьте его ссылку.',
        quickSettingsTitle: 'Быстрые настройки',
        notificationsPushOn: 'Push включены',
        notificationsPushOff: 'Push выключены',
        notificationsQuietHours: 'Тихие часы включены',
        pluginChangesAwaitingReview: ({ count }) => `Изменения плагинов ждут проверки: ${count}`,
        review: 'Проверить',
        browsePluginsTitle: 'Каталог плагинов',
        browsePluginsSubtitle: 'Добавьте в Happier инструменты, панели и интеграции.',
        accountServiceSignedIn: ({ service }) => `Вход в ${service} выполнен`,
        aboutDescription: 'Версия, исходный код и юридические условия (Happier не связан с Anthropic).',
        machinesTitle: 'Машины',
        machineOnline: 'В сети',
        machineOffline: ({ lastSeen }) => `Не в сети · был ${lastSeen}`,
        machineUpdateAvailable: 'Доступно обновление',
        machinesOnlineCount: ({ count }) => `${count} в сети`,
        machinesOfflineCount: ({ count }) => `${count} не в сети`,
        machineLastSeen: ({ lastSeen }) => `был ${lastSeen}`,
        update: 'Обновить',
        asOf: ({ time }) => `На ${time}`,
        usageTitle: 'Использование',
        usageLeft: ({ percent }) => `Осталось ${percent}%`,
        usageResets: ({ time }) => `сброс ${time}`,
        securityTitle: 'Безопасность',
        startSessionLabel: 'Начать сессию',
        saveRecoveryKeyTitle: 'Сохраните ключ восстановления',
        saveRecoveryKeySubtitle: 'Единственный способ вернуть зашифрованные данные, если вы потеряете все устройства.',
        addMachineTitle: 'Добавить машину',
        addMachineSubtitle: 'Подключите компьютер, на котором работают ваши агенты.',
        homeGreetingNamed: ({ name }) => `С возвращением, ${name}.`,
        homeStartSection: 'Начать сессию',
        homeCustomize: 'Настроить главную',
        homeCustomizeDescription: 'Выберите, какие разделы показывать на главной и в каком порядке.',
        homeAlwaysShown: 'Показывается всегда',
        homeShowSection: 'Показывать',
        homeHideSection: 'Скрыть раздел',
        homeSectionOptions: 'Параметры раздела',
        homeResetLayout: 'Сбросить по умолчанию',
        homeLayoutSectionTitle: 'Главная',
        homeAddWidgetsTitle: 'Добавить виджеты',
        homeAddWidgetsDescription: 'Виджеты ваших плагинов. Добавьте виджет, чтобы он появился на главной.',
        homeWidgetFromPlugin: ({ plugin }) => `Из ${plugin}`,
        homeRemoveWidget: 'Убрать с главной',
    } } satisfies Pick<Readonly<Record<string, SettingsOverviewTranslation>>, "ru">;

return { settingsOverviewTranslations };
})();

const Domain_settingsProfilesRemoteHostsPageTranslations = (() => {
const english = Shared_settingsProfilesRemoteHostsPageTranslations.english;

const translated = Shared_settingsProfilesRemoteHostsPageTranslations.translated;

const settingsProfilesRemoteHostsPageTranslations = { ru: translated({
        settingsProfilesPage: {
            pageDescription: 'Параметры запуска новой сессии: агент, модель, переменные окружения и место запуска.',
            useProfilesSection: 'Выбор профиля',
            useProfilesSectionDescription: 'Выбирайте профиль при запуске сессии или запускайте каждую сессию с окружением машины.',
            useProfiles: 'Использовать профили',
            useProfilesOffDescription: 'Выключено. Новые сессии используют окружение машины.',
            favoritesDescription: 'Показываются первыми при выборе профиля.',
            customDescription: 'Созданные вами профили. При изменении встроенного профиля здесь сохраняется ваша копия.',
            builtInDescription: 'Готовые профили для каждого агента.',
        },
        settingsRemoteHostsPage: {
            pageDescription: 'SSH-хосты, которые этот компьютер может настроить как машины, к которым может подключиться или на которых может запустить ретранслятор.',
            savedHostsSection: 'Сохранённые хосты',
            savedHostsDescription: "Сначала недавно использованные. Откройте хост, чтобы использовать или изменить его.",
            hostPageDescription: "SSH-хост, который этот компьютер может настроить как машину, к которому может подключиться или на котором может запустить relay.",
            newHostTitle: "Новый удалённый хост",
            newHostDescription: "Назовите хост и укажите, как подключиться к нему по SSH.",
            useSection: "Использовать этот хост",
            useSectionDescription: "Что это устройство может с ним сделать.",
            maintenanceSection: "Happier на этом хосте",
            maintenanceSectionDescription: "Установка, обновление и запуск командной строки, фоновой службы и relay Happier на нём.",
            discard: "Отменить",
            accessTitle: "Ключи и подключения",
            accessRowSubtitle: "Доверенные ключи хостов и открытые туннели",
            accessPageDescription: "Ключи хостов, которым доверяет это устройство, а также туннели и пути доступа, открытые к вашим хостам.",
            hostNotFound: "Этот хост больше не сохранён.",
            unavailableDescription: 'Сохранённые SSH-хосты можно настроить как машины или использовать как ретрансляторы.',
            trustedHostKeysDescription: 'Ключи, которые это устройство приняло при подключении. Удалите ключ, чтобы в следующий раз снова получить запрос.',
            trustedHostKeysEmpty: 'Доверенных ключей хостов пока нет. Они появятся здесь, когда вы примете ключ при подключении.',
            sshTunnelsDescription: 'Туннели, открытые с этого устройства к сохранённому хосту.',
        },
    }) };

return { settingsProfilesRemoteHostsPageTranslations };
})();

const Domain_settingsProvidersTranslations = (() => {


const withProviderSharedFields = Shared_settingsProvidersTranslations.withProviderSharedFields;

const ru = {
    title: 'Провайдеры', entrySubtitle: 'Подключайте облачные и локальные источники моделей', detailTitle: 'Подключение провайдера', configuredTitle: 'Ваши провайдеры', configuredFooter: 'Модели включённых провайдеров появляются в списках моделей совместимых агентов.', availableTitle: 'Доступные', availableFooter: 'Подключите провайдера один раз и используйте его модели со всеми совместимыми агентами.', customTitle: 'Свой провайдер', customFooter: 'Подключите корпоративный шлюз или другую совместимую конечную точку моделей.', addCustom: 'Добавить своего провайдера', addCustomDescription: 'Используйте конечную точку, совместимую с OpenAI или Anthropic', emptyTitle: 'Провайдеры ещё не подключены', emptyDescription: 'Выберите доступного провайдера ниже или добавьте собственную конечную точку.', unavailable: 'Провайдеры недоступны', unavailableDescription: 'На этом сервере подключения провайдеров не включены.', noMachine: 'Нет доступных машин', noMachineDescription: 'Подключите машину, чтобы настраивать и проверять провайдеров.', problemTitle: 'Провайдер требует внимания', searchPlaceholder: 'Поиск провайдеров',
    status: { available: 'Подключён', notChecked: 'Не проверен', needsAttention: 'Требует внимания', unreachable: 'Недоступен', disabled: 'Выключен', sourceUnavailable: 'Плагин недоступен' }, kind: { frontier: 'Провайдер моделей', aggregator: 'Каталог моделей', cloud: 'Облачный провайдер', local: 'Работает на этой машине' },
    detail: { pickSecretTitle: 'Выберите ключ API', notFoundTitle: 'Провайдер не найден', notFoundDescription: 'Это подключение провайдера больше не существует.', deletedDescription: 'Этот провайдер удалён. Выберите другую модель перед возобновлением использовавших его сессий.', sourceAvailable: 'Плагин провайдера доступен', connectionTitle: 'Подключение', connectionFooter: 'Укажите, где можно использовать этого провайдера, и проверьте его состояние.', accountAccess: 'Использовать на всех машинах', accountAccessDescription: 'Доступен везде, где провайдер разрешается в общедоступную конечную точку', testConnection: 'Проверить подключение', testDescription: 'Проверить конечную точку и обновить каталог моделей', testSucceeded: 'Подключение установлено', testNotSupported: 'Этот провайдер не поддерживает автоматическую проверку подключения', machinesTitle: 'Машины', machinesFooter: 'Локальные и частные конечные точки нужно включать отдельно на каждой машине.', currentMachine: 'Текущая машина', selectMachineToManage: 'Выберите эту машину, чтобы просмотреть и изменить её доступ', targetMachine: 'Целевая машина', machineOnline: 'В сети', machineOffline: 'Не в сети', apiKeyTitle: 'Ключ API', apiKeyFooter: 'Ключи хранятся в Сохранённых секретах и никогда не отображаются здесь.', accountApiKey: 'Ключ API по умолчанию', machineApiKey: 'Ключ API на этой машине', apiKeyConfigured: 'Настроен', apiKeyMissing: 'Добавьте ключ для подключения', apiKeySelected: 'Выбран сохранённый ключ', useAccountApiKey: 'Использует ключ по умолчанию, если для машины не задан другой', modelsTitle: 'Модели', manageModels: 'Управление моделями', modelsUnknown: 'Модели появятся после подключения', modelCount: ({ count }: { count: number }) => `${count} ${count % 10 === 1 && count % 100 !== 11 ? 'модель' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'модели' : 'моделей'}`, actionsTitle: 'Действия', duplicateTitle: 'Добавить ещё одно подключение', duplicateDescription: 'Создать отдельно названное подключение к тому же провайдеру', deleteTitle: 'Удалить провайдера', deleteDescription: 'Существующие сессии сохранят историю, но их нельзя будет возобновить с этим провайдером.', advancedTitle: 'Дополнительно', endpointDefault: 'Конечная точка по умолчанию', endpointMachine: 'Конечная точка на этой машине', endpointMachineDescription: 'Переопределить значение только там, где эта машина запускает провайдера', endpointPrompt: 'Введите полный базовый URL провайдера.', resetEndpoint: 'Сбросить конечную точку', resetMachineEndpoint: 'Использовать конечную точку по умолчанию на этой машине', resetDefaultEndpoint: 'Использовать конечную точку из плагина провайдера' },
    authoring: { providerTitle: 'Провайдер', builtInDescription: 'Выберите Сохранённый секрет, затем подключите провайдера.', compatibilityTitle: 'Совместимость', compatibilityFooter: 'Выберите стиль API, указанный в документации провайдера.', protocolTitle: 'Совместимость API', protocol: { 'openai-responses': { title: 'Совместимо с OpenAI Responses', description: 'Для шлюзов, реализующих Responses API' }, 'openai-chat': { title: 'Совместимо с OpenAI Chat', description: 'Для шлюзов, реализующих Chat Completions' }, anthropic: { title: 'Совместимо с Anthropic', description: 'Для шлюзов, реализующих Messages API' } }, detailsTitle: 'Сведения о провайдере', name: 'Название', namePlaceholder: 'Корпоративный шлюз', baseUrl: 'Базовый URL', baseUrlPlaceholder: 'https://gateway.example.com/v1', modelsPath: 'Путь к моделям', credentialsTitle: 'Учётные данные', credentialsFooter: 'Выберите Сохранённый секрет. Никогда не вставляйте ключ API в URL или заголовки.', requiresApiKey: 'Требуется ключ API', requiresApiKeyYes: 'Использовать Сохранённый секрет для запросов', requiresApiKeyNo: 'Подключить без учётных данных', apiKey: 'Ключ API', apiKeyDescription: 'Выберите или создайте Сохранённый секрет', credentialStyleTitle: 'Формат ключа API', credentialHeader: 'Имя заголовка', credentialStyle: { bearer: 'Bearer-токен Authorization', xApiKey: 'Заголовок x-api-key', apiKey: 'Заголовок api-key', customHeader: 'Свой заголовок' }, catalogTitle: 'Каталог моделей', catalogFooter: 'Получайте модели автоматически, если конечная точка это поддерживает, или добавьте их вручную позже.', fetchModels: 'Получать модели автоматически', fetchModelsYes: 'Использовать конечную точку списка моделей провайдера', fetchModelsNo: 'Добавить идентификаторы моделей вручную', verifyTitle: 'Подключение', verifyFooter: 'Если возможно, сначала проверьте подключение, а затем сохраните провайдера.', save: 'Сохранить провайдера', connect: 'Подключить провайдера' },
    errors: { secretMissingTitle: 'Требуется ключ API', secretMissingDescription: 'Выберите Сохранённый секрет перед включением этого провайдера.', notEnabledOnMachineTitle: 'Не включён на этой машине', notEnabledOnMachineDescription: 'Включите провайдера на машине, где будет запущена сессия.', disabledTitle: 'Провайдер выключен', disabledDescription: 'Включите провайдера перед использованием его моделей.', unreachableTitle: 'Провайдер недоступен', unreachableDescription: 'Проверьте, что служба работает и конечная точка указана правильно, затем повторите попытку.', notFoundTitle: 'Провайдер не найден', notFoundDescription: 'Этот провайдер удалён. Выберите другого провайдера или модель.', sourceUnavailableTitle: 'Плагин провайдера недоступен', sourceUnavailableDescription: 'Снова включите или установите плагин, предоставляющий это подключение.', featureDisabledTitle: 'Провайдеры недоступны', featureDisabledDescription: 'На этом сервере подключения провайдеров не включены.', unauthorizedTitle: 'Ключ API отклонён', unauthorizedDescription: 'Замените Сохранённый секрет действительным ключом и снова проверьте подключение.', rateLimitedTitle: 'Провайдер ограничил частоту запросов', rateLimitedDescription: 'Немного подождите и снова проверьте подключение.', probeCapacityTitle: 'Слишком много проверок провайдера одновременно', probeCapacityDescription: 'Happier пока не смог запустить эту проверку на выбранной машине. Немного подождите и повторите попытку.', genericTitle: 'Провайдер требует внимания', genericDescription: 'Проверьте настройки провайдера и повторите попытку.' },
    models: { builtIn: 'Встроенная', experimental: 'Экспериментальная', experimentalConfirmTitle: 'Использовать экспериментальную модель?', experimentalConfirmBody: ({ provider, model }: { provider: string; model: string }) => `Модель ${model} от ${provider} ещё не была полностью проверена с этим агентом. Если она работает не так, как ожидается, может потребоваться перезапуск или другая модель.`, experimentalConfirmAction: 'Использовать модель', stale: 'Может быть недоступна', hidden: 'Скрыта', manage: 'Управление моделями', empty: 'У этого провайдера пока нет доступных моделей.', add: 'Добавить модели', addPlaceholder: 'Введите по одному идентификатору модели в строке', resetVisibility: 'Сбросить видимость', showHidden: 'Показать скрытые модели', hideHidden: 'Скрыть скрытые модели', remove: 'Удалить модель', removeConfirmation: 'Удалить эту добавленную вручную модель?', enable: 'Показать модель', disable: 'Скрыть модель', load: 'Загрузить модель', retry: 'Повторить', connectionUnavailable: 'Этот провайдер недоступен на выбранной машине.' },
};

const localTranslations = { ru: { title: 'На этой машине', footer: 'На этой машине найдены локальные серверы моделей. Модели выполняются приватно на вашем оборудовании.', detected: 'Обнаружено', possible: 'Возможная служба', detectedAtPort: ({ port }: { port: string }) => `Обнаружено · Порт ${port}`, possibleAtPort: ({ provider, port }: { provider: string; port: string }) => `Возможная служба ${provider} · Порт ${port}`, addConnectionTitle: 'Добавить ещё одно локальное подключение', addConnectionDescription: 'Назовите подключение, чтобы отличать его от других локальных конечных точек.', defaultConnectionName: ({ provider }: { provider: string }) => `${provider} локально` } } as const;

const providerManagedDeploymentTranslations = { ru: {
        configureManaged: 'Запускать сеансы через управляемую локальную службу',
        configureManagedDescription: 'Выберите подключённую учётную запись или группу для будущих сеансов. Happier запустит службу при необходимости.',
        subscriptionPolicyTitle: 'Маршрутизация подписки экспериментальная',
        subscriptionPolicyDescription: 'Политика исходного провайдера или её применение могут измениться и остановить работу. Happier показывает отказ и не подменяет учётные данные незаметно.',
        accountScopeMismatchTitle: 'Подключённые учётные записи принадлежат активному серверу',
        accountScopeMismatchDescription: 'Этот провайдер управляется на машине другого сервера. Переключитесь на этот сервер, чтобы выбрать его подключённую учётную запись или группу.',
        editManagedDefaults: 'Изменить параметры управляемых сеансов',
        editManagedDefaultsDescription: 'Измените подключённую учётную запись или группу для будущих сеансов. Существующие сеансы сохранят выбор.',
        purposeTargetTitle: 'Цель подключённой учётной записи',
        purposeTargetDescription: 'Выберите доступную подключённую учётную запись или группу для этой цели.',
        invalidPurposeTargetTitle: 'Недопустимая цель учётной записи',
        invalidPurposeTargetDescription: 'Выберите доступную подключённую учётную запись или группу перед сохранением.',
        useExternal: 'Использовать внешнюю службу',
        useExternalDescription: 'Отключите управление провайдером для будущих сеансов и используйте внешний адрес.',
        useExternalConfirmTitle: 'Использовать внешнюю службу?',
        useExternalConfirmDescription: 'Управляемые параметры будут удалены. Существующие сеансы сохранят выбор.',
    } } as const;

const copyNameTranslations = { ru: ({ name }: { name: string }) => `Копия ${name}` } as const;

const providerSharedFieldTranslations = { ru: {
        local: { installedNotRunning: 'Установлено, но не запущено', appRunningServerOff: 'Приложение открыто, но локальный сервер выключен', startManaged: ({ provider }: { provider: string }) => `Запустить ${provider}`, startedByHappier: 'Запущено Happier', runningOutsideHappier: 'Запущено вне Happier' },
        apiKeyOptionalDescription: 'Необязательно — выберите сохранённый секрет, если он нужен этому провайдеру',
        models: { addDescription: 'Добавьте идентификаторы моделей, которые провайдер не перечисляет автоматически', addHelp: 'Введите по одному точному идентификатору модели в строке. Существующие модели будут пропущены.', addFieldLabel: 'Идентификаторы моделей', invalidModelIds: ({ ids }: { ids: string }) => `Недопустимые идентификаторы моделей: ${ids}`, noNewModels: 'Нет новых идентификаторов моделей для добавления.', providerManagedTitle: 'Моделями управляет этот провайдер', providerManagedDescription: 'Обновите каталог провайдера, чтобы обновить список. Ручные идентификаторы моделей не поддерживаются.', showAll: 'Показать все модели', hideAll: 'Скрыть все модели', hideAllConfirmation: 'Скрыть все модели в этом списке? Их можно снова показать в любое время.', showOnly: 'Показать только эту модель', showOnlyConfirmation: 'Скрыть все остальные модели в этом списке? Их можно восстановить в любое время.' },
    } } as const;

const providerFirstSessionValidationTranslations = { ru: 'Happier безопасно проверит подключение при запуске первого сеанса, который его использует.' } as const;

const providerMigrationTranslations = { ru: { reviewTitle: 'Проверить перенос провайдера', reviewFooter: 'Проверьте адрес, формат API, учётные данные и модели до применения изменений.', legacyProfileDescription: 'Старый маршрут профиля продолжит работать до подтверждения.', credentialTitle: 'Учётные данные', credentialFooter: 'Переносится только ссылка на сохранённый секрет; его значение не показывается и не копируется.', noCredential: 'Без ключа API', credentialMoveDescription: 'Перенести привязку в новое подключение', noCredentialDescription: 'Создать подключение без учётных данных', actionsTitle: 'Перенос', preview: 'Проверить изменения', previewDescription: 'Проверить конфигурацию без изменения настроек', confirm: 'Создать подключение провайдера', confirmDescription: 'Атомарно применить изменения и сохранить параметры запуска', reviewAction: 'Проверить перенос провайдера', reviewActionDescription: 'Перенести старый адрес и модели в подключение', retainedTitle: 'Старая конфигурация сохранена', retainedDescription: 'Она останется доступной, пока перенос без потери поведения невозможен.' } } as const;

const providerMigrationPreviewTranslations = { ru: { willMoveTitle: 'Будет перенесено в провайдер', willMoveFooter: 'Переносятся только эти имена маршрутизации и учётных данных. Значения секретов никогда не отображаются.', willKeepTitle: 'Останется в профиле запуска', willKeepFooter: 'Эти параметры запуска останутся в профиле после переноса.', permissionDefaults: 'Разрешения по умолчанию', persistenceDefaults: 'Хранение сеансов по умолчанию' } } as const;

const providerMigrationConflictTranslations = { ru: { conflictReviewTitle: 'Разрешить конфликт переноса', conflictReviewFooter: 'Выберите: сохранить существующее подключение или создать для этого профиля отдельное. Значения секретов не отображаются.', conflictCredential: 'Сохранённые учётные данные отличаются', conflictModels: 'Настройки моделей отличаются', conflictEditedConnection: 'Существующее подключение было изменено', keepExisting: 'Сохранить существующее подключение', keepExistingDescription: 'Сохранить текущие учётные данные и модели и завершить перенос без их замены.', modelOutcomeTitle: 'Выберите модель для сохранения', modelOutcomeFooter: 'Проверьте точную модель перед завершением переноса. До выбора ничего не изменится.', useExistingModel: 'Использовать текущую модель подключения', useExistingModelDescription: 'Сохранить модель, уже выбранную для этого подключения провайдера.', preserveLegacyModel: 'Использовать модель профиля', preserveLegacyModelDescription: 'Перенести точный выбор этого профиля в существующее подключение.', discardLegacyModel: 'Удалить выбор модели профиля', discardLegacyModelDescription: 'Завершить перенос без выбора модели и избранного значения этого профиля.', createNamed: 'Создать отдельное подключение', createNamedDescription: 'Сохранить настройки провайдера этого профиля в новом подключении.', separateConnectionName: 'Название подключения', conflictReviewAction: 'Разрешить конфликт провайдера', conflictReviewActionDescription: 'Выберите, как сохранить конфликтующие учётные данные или модели' } } as const;

const providerCredentialSelectionRequiredTranslations = { ru: 'Выберите сохранённые учётные данные для этого подключения провайдера' } as const;

const providerLinkTranslations = { ru: { providerWebsite: 'Сайт провайдера', getApiKey: 'Получить API-ключ', failedToOpen: 'Happier не удалось открыть эту ссылку.' } } as const;

const providerCredentialFormatSelectionRequiredTranslations = { ru: 'Выберите способ передачи этих учётных данных' } as const;

const providerReservedEnvironmentValidationUnavailableTranslations = { ru: 'Подключите редактор профиля к доступной машине перед изменением переменных окружения.' } as const;

const providerAdvancedAuthoringTranslations = { ru: { advancedSetup: 'Расширенная настройка', advancedSetupEnabled: 'Настройте несколько стилей API, заголовки и безопасные проверки списка моделей', advancedSetupDisabled: 'Использовать один обычный совместимый endpoint', endpointEnabled: 'Использовать этот стиль API', endpointEnabledDescription: 'Сделать endpoint доступным совместимым агентам', endpointDisabledDescription: 'Этот стиль API использоваться не будет', publicHeaders: 'Публичные заголовки запроса', publicHeadersPlaceholder: 'X-Tenant: engineering', optionalProbePath: 'Путь к списку моделей (необязательно)', probeParserTitle: 'Формат ответа', probeParser: { openaiModels: 'Список моделей в формате OpenAI', ollamaTags: 'Теги Ollama', lmStudioNative: 'Нативный список моделей LM Studio' } } } as const;

const providerCustomBearerHeaderTranslations = { ru: 'Пользовательский заголовок (Bearer-токен)' } as const;

const providerNonSecretHeaderTranslations = { ru: 'Несекретные заголовки' } as const;

const providerProbePathsTranslations = { ru: 'Пути к списку моделей (необязательно, по одному в строке)' } as const;

const providerLocalAuthoringTranslations = { ru: { enableAfterSaving: 'Включить этого провайдера', enableOnCurrentMachine: 'После сохранения включить только на этой машине', enableAccountWide: 'Включить после сохранения', localAddressTitle: 'Локальный адрес', localAddressDescription: ({ machine, endpoint }: { machine: string; endpoint: string }) => `Включайте отдельно на каждой машине. ${machine} будет использовать ${endpoint}.` } } as const;

const providerAuthoringReviewTranslations = { ru: { destinationReview: 'Назначение подключения', destinationLoading: 'Daemon определяет точное назначение…', destinationSelection: 'Выберите назначение', destinationSelectionDescription: 'Проверьте точный адрес перед подключением.', destinationScope: 'Область назначения', destinationMachine: 'Эта машина', destinationAccount: 'Учётная запись' } } as const;

const providerCompatibilityTranslations = { ru: { title: 'Работает с', footer: 'Совместимость проверяется каждой интеграцией агента и может зависеть от модели.', verified: 'Проверено', experimental: 'Экспериментально', incompatible: 'Несовместимо', verifiedDescription: 'Протестировано с этой интеграцией агента', experimentalDescription: 'Может работать, но требует проверки перед первым использованием', incompatibleDescription: 'Этот агент не может безопасно использовать подключение' } } as const;

const providerModelNotLoadedTranslations = { ru: 'Не загружено · может загрузиться при первом использовании' } as const;

const providerModelLoadCancellationTranslations = { ru: { cancelLoad: 'Отменить загрузку', loadCancelled: 'Ожидание модели прекращено', loadCancelledProviderMayContinue: 'Провайдер может продолжить загрузку. Позже обновите каталог, чтобы учесть позднее завершение; Happier не будет повторять загрузку.' } } as const;

const providerPartialStatusTranslations = { ru: 'Частично доступно' } as const;

const providerConnectedServiceSuppressedTranslations = { ru: 'Встроенная авторизация агента не используется с этим провайдером. Сохранённый выбор не изменяется.' } as const;

const providerMachineCleanupPendingTranslations = { ru: 'Машина удалена, но не удалось сохранить очистку доступа к провайдерам. Проверьте подключение и удалите машину снова, чтобы повторить очистку.' } as const;

const providerConnectionChangedTranslations = { ru: { title: 'Подключение к провайдеру изменилось', description: 'Обновите текущие настройки провайдера и повторите попытку.' } } as const;

const providerModelSectionTranslations = { ru: { available: 'Доступные', manual: 'Добавленные вручную' } } as const;

const providerCompletenessTranslations = { ru: {
        searchEmptyTitle: 'По этому запросу провайдеры не найдены',
        searchEmptyDescription: 'Попробуйте другое название провайдера или подключения.',
        compatibilityReasons: {
            noCompatibleProtocol: 'У этого агента и провайдера нет общего поддерживаемого протокола API.',
            noAuthUnsupported: 'Для этого провайдера агенту требуется передача ключа API.',
            credentialTransportUnavailable: 'Этот агент не поддерживает настроенный способ передачи ключа API.',
            optionalCredentialNoAuthUnsupported: 'Этот агент не может использовать провайдера без необязательного ключа API.',
            capabilityUnsupported: 'Требуемая возможность провайдера не поддерживается.',
            capabilityUnknown: 'Требуемая возможность провайдера ещё не проверена.',
            modelEvidenceRequired: 'Выберите модель, чтобы проверить требуемые возможности.',
            modelCapabilityUnsupported: 'Модель не поддерживает требуемую возможность.',
            modelCapabilityUnknown: 'Требуемая возможность модели ещё не проверена.',
            overrideIncompatible: 'Проверка провайдера пометила эту интеграцию как несовместимую.',
            overrideExperimental: 'Проверка провайдера пометила эту интеграцию как экспериментальную.',
            evidenceMissing: 'Данные о совместимости ещё не записаны.',
            agentUnsupported: 'Этот агент не поддерживает внешних провайдеров моделей.',
            adapterInvalid: 'Не удалось проверить адаптер провайдера для этого агента.',
            unknown: 'Новое условие совместимости требует проверки.',
        },
        unsavedDescription: 'Отменить этот черновик провайдера? Сохранённые секреты — общие объекты учётной записи и останутся доступны.',
        recoveryActions: {
            reviewFeatures: 'Проверить доступность провайдеров',
            chooseConnection: 'Выбрать провайдера',
            restorePlugin: 'Проверить плагин',
            enableConnection: 'Включить провайдера',
            reviewAccountGrant: 'Проверить доступ учётной записи',
            enableOnMachine: 'Включить на машине',
            reviewMachineGrant: 'Проверить доступ машины',
            reviewCompatibility: 'Проверить совместимость',
            addSecret: 'Добавить ключ API',
            reviewCredentialTransport: 'Проверить поддержку учётных данных',
            reviewConnection: 'Проверить подключение',
            retry: 'Повторить',
            replaceSecret: 'Заменить ключ API',
            chooseModel: 'Выбрать модель',
            loadModel: 'Загрузить модель',
            reviewAndRestart: 'Проверить и перезапустить',
            restartProbe: 'Проверить снова',
            reduceProviderSettings: 'Управление настройками провайдеров',
            reviewProfileMigration: 'Проверить миграцию профиля',
            reviewCurrentState: 'Проверить текущие настройки',
        },
        hiddenForAllAgents: 'Скрыто для всех агентов · Управление в настройках провайдеров',
    } } as const;

const providerAvailabilityTranslations = { ru: {
        availabilityChecking: 'Проверка доступности провайдеров', availabilityCheckingDescription: 'Happier проверяет, поддерживает ли этот сервер подключения провайдеров.',
        availabilityProblem: 'Не удалось проверить доступность провайдеров', availabilityProblemDescription: 'Happier повторит попытку автоматически. Если проблема не исчезнет, проверьте подключение к серверу.',
        availabilityUnsupported: 'Для провайдеров требуется обновление сервера', availabilityUnsupportedDescription: 'Эта версия сервера не поддерживает подключения провайдеров.',
        availabilityContextUnsupported: 'Провайдеры не поддерживаются в этом контексте', availabilityContextUnsupportedDescription: 'Текущая конфигурация или выбор сервера не поддерживает подключения провайдеров.',
        availabilityPolicyDisabled: 'Провайдеры отключены политикой', availabilityPolicyDisabledDescription: 'Локальная политика или политика сборки отключила подключения провайдеров.',
    } } as const;

const settingsProvidersTranslations = { ru: withProviderSharedFields(ru, {
        providerAvailabilityTranslations: providerAvailabilityTranslations.ru,
        providerLinkTranslations: providerLinkTranslations.ru,
        providerCompletenessTranslations: providerCompletenessTranslations.ru,
        providerPartialStatusTranslations: providerPartialStatusTranslations.ru,
        providerMachineCleanupPendingTranslations: providerMachineCleanupPendingTranslations.ru,
        providerConnectionChangedTranslations: providerConnectionChangedTranslations.ru,
        providerCompatibilityTranslations: providerCompatibilityTranslations.ru,
        providerMigrationTranslations: providerMigrationTranslations.ru,
        providerMigrationPreviewTranslations: providerMigrationPreviewTranslations.ru,
        providerMigrationConflictTranslations: providerMigrationConflictTranslations.ru,
        providerCredentialSelectionRequiredTranslations: providerCredentialSelectionRequiredTranslations.ru,
        providerCredentialFormatSelectionRequiredTranslations: providerCredentialFormatSelectionRequiredTranslations.ru,
        providerReservedEnvironmentValidationUnavailableTranslations: providerReservedEnvironmentValidationUnavailableTranslations.ru,
        localTranslations: localTranslations.ru,
        providerSharedFieldTranslations: providerSharedFieldTranslations.ru,
        providerManagedDeploymentTranslations: providerManagedDeploymentTranslations.ru,
        copyNameTranslations: copyNameTranslations.ru,
        providerFirstSessionValidationTranslations: providerFirstSessionValidationTranslations.ru,
        providerAdvancedAuthoringTranslations: providerAdvancedAuthoringTranslations.ru,
        providerLocalAuthoringTranslations: providerLocalAuthoringTranslations.ru,
        providerAuthoringReviewTranslations: providerAuthoringReviewTranslations.ru,
        providerNonSecretHeaderTranslations: providerNonSecretHeaderTranslations.ru,
        providerProbePathsTranslations: providerProbePathsTranslations.ru,
        providerCustomBearerHeaderTranslations: providerCustomBearerHeaderTranslations.ru,
        providerModelSectionTranslations: providerModelSectionTranslations.ru,
        providerModelLoadCancellationTranslations: providerModelLoadCancellationTranslations.ru,
        providerModelNotLoadedTranslations: providerModelNotLoadedTranslations.ru,
        providerConnectedServiceSuppressedTranslations: providerConnectedServiceSuppressedTranslations.ru,
    }) } as const;

return { localTranslations, providerManagedDeploymentTranslations, copyNameTranslations, providerSharedFieldTranslations, providerFirstSessionValidationTranslations, providerMigrationTranslations, providerMigrationPreviewTranslations, providerMigrationConflictTranslations, providerCredentialSelectionRequiredTranslations, providerLinkTranslations, providerCredentialFormatSelectionRequiredTranslations, providerReservedEnvironmentValidationUnavailableTranslations, providerAdvancedAuthoringTranslations, providerCustomBearerHeaderTranslations, providerNonSecretHeaderTranslations, providerProbePathsTranslations, providerLocalAuthoringTranslations, providerAuthoringReviewTranslations, providerCompatibilityTranslations, providerModelNotLoadedTranslations, providerModelLoadCancellationTranslations, providerPartialStatusTranslations, providerConnectedServiceSuppressedTranslations, providerMachineCleanupPendingTranslations, providerConnectionChangedTranslations, providerModelSectionTranslations, providerCompletenessTranslations, providerAvailabilityTranslations, settingsProvidersTranslations };
})();

const Domain_settingsSearchKeywordsTranslations = (() => {
const english = Shared_settingsSearchKeywordsTranslations.english;

const translated = Shared_settingsSearchKeywordsTranslations.translated;

const settingsSearchKeywordsTranslations = { ru: translated({
        settingsSearchKeywords: {
            settings: 'настройки, главная, обзор',
            groupProfileAndAccount: 'аккаунт, профиль, оплата, тариф, использование',
            account: 'аккаунт, профиль, оплата',
            accountSecurity: 'безопасность, пароль, восстановление, шифрование, выйти',
            apiTokens: 'api-токен, персональный токен доступа, pat, автоматизация, cli, sdk',
            teams: 'команды, участники, группы, приглашения',
            homeAdministration: 'home, администрирование, управление, люди, политики',
            secrets: 'секреты, ключи, env, токены',
            usage: 'использование, оплата, лимиты, квота',
            machines: 'машины, устройства, компьютер',
            machinePoolsNew: 'пулы машин, пулы, резерв, запуск на',
            machinesAdd: 'добавить, машина, ssh',
            machinesThisComputer: 'этот компьютер, локальный, устройство',
            remoteHosts: 'удалённый, хост, хосты, ssh, сервер, машины',
            groupGeneral: 'общие, оформление, язык, эксперименты',
            appearance: 'оформление, тема, шрифт, интерфейс, боковая панель',
            keyboard: 'клавиатура, сочетание клавиш, сочетания, горячие клавиши, команды',
            pets: 'питомцы, blink, компаньон, codex',
            language: 'язык, регион, перевод',
            features: 'функции, эксперименты, бета',
            groupAiAndAgents: 'агенты, провайдеры, mcp, промпты, голос',
            agents: 'провайдеры, агенты, модели, llm',
            providers: 'провайдеры, модели, openrouter, ollama, lm studio',
            subAgent: 'субагенты, агенты, делегирование, правила',
            roles: 'роли, оркестратор, исполнитель, ревьюер, инструкции',
            delegation: 'делегирование, глубина работы, передача, оркестратор',
            profiles: 'профили, персоны',
            connectedServices: 'подключённые сервисы, oauth, аккаунты',
            mcp: 'mcp, инструменты, серверы, плагины',
            plugins: 'плагины, маркетплейс, каталог, дескриптор, обзор',
            prompts: 'промпты, шаблоны, библиотека',
            promptsTemplates: 'шаблоны',
            promptsFolders: 'папки',
            promptsStacks: 'стеки',
            promptsRegistries: 'реестры',
            promptsLibrary: 'библиотека',
            promptsAssets: 'ресурсы, внешние',
            voice: 'голос, ассистент, микрофон',
            voiceConversations: 'голос, разговор, реальное время, провайдер',
            voiceDictation: 'голос, диктовка, речь, транскрипция',
            voicePrivacy: 'голос, конфиденциальность, история, хранение',
            voiceAdvanced: 'голос, расширенные, машина, диагностика',
            memory: 'память, поиск, индекс',
            groupSessionsBehavior: 'сессии, стенограмма, разрешения, действия',
            session: 'сессия, терминал, tmux',
            externalSessions: 'внешние сессии, фоновое отслеживание, хуки',
            actions: 'действия, подтверждения, сочетания клавиш',
            embeds: 'встраивания, встроить, iframe, виджет, сайт, чат',
            transcript: 'стенограмма, чат, макет',
            permissions: 'разрешения, подтверждение, безопасность',
            toolRendering: 'инструменты, отображение',
            handoff: 'передача, перенос',
            runs: 'запуски, выполнение',
            groupFilesAndSourceControl: 'файлы, контроль версий, вложения',
            sourceControl: 'git, scm, контроль версий',
            attachments: 'вложения, загрузки, файлы',
            groupSystem: 'система, серверы, состояние, уведомления',
            servers: 'серверы, ретранслятор',
            systemStatus: 'состояние системы, работоспособность, диагностика',
            updates: 'обновления, обновить, версия, cli, перезапуск',
            notifications: 'notif, уведомление, уведомления, push',
            notificationsPush: 'push, push-уведомления',
            desktop: 'рабочий стол, tauri, оверлей, окно',
            diagnosis: 'диагностика, отладка',
            reportIssue: 'сообщить о проблеме, ошибка, bug',
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
>, "ru"> = { ru: {
        settingsSessionPages: {
            preview: {
                userMessage: 'Исправь нестабильный тест переподключения',
                agentReply: 'Нашёл: таймер повторов не сбрасывался. Исправил, тест проходит.',
                thinking: 'Тест падает только после тайм-аута, значит, таймер повторов, скорее всего, ещё работает.',
            },
            runtime: {
                pageDescription: 'Как сессии работают на ваших машинах.',
                terminalSection: 'Терминал',
                terminalHostTitle: 'Терминальный хост для новых сеансов',
                terminalHostNone: 'Нет',
                tmuxTitle: 'Запускать сессии в tmux',
                tmuxOn: 'Новые сессии открываются в отдельном окне tmux, чтобы к ним можно было подключиться из терминала.',
                tmuxOff: 'Новые сессии работают в обычной оболочке.',
            },
            wizard: {
                pageDescription: 'Как мастер новой сессии располагает свои шаги.',
                wideScreensSection: 'Широкие экраны',
                stepsSection: 'Как каждый шаг показывает варианты',
                steps: {
                    profiles: 'Профиль',
                    backends: 'Агент',
                    models: 'Модель',
                    machines: 'Машина',
                    paths: 'Папка',
                    permissions: 'Разрешения',
                },
            },
            providerLimits: {
                pageDescription: 'Что происходит при достижении лимита использования провайдера и сколько квоты у вас осталось.',
                recoveryDescription: 'Когда агент достигает лимита использования провайдера, сессия может дождаться сброса и продолжить.',
                resumePromptCustom: 'Свой',
                unavailableTitle: 'Недоступно в этом Home',
                unavailableDescription: 'Восстановление после лимита использования и индикатор использования провайдера не включены в этом Home.',
            },
            resume: {
                pageDescription: 'Как неактивная сессия продолжается, если её агент не может возобновить её сам.',
                strategyRecent: 'Последние сообщения',
                strategySummary: 'Сводка + последние',
                maxSeedCharsTitle: 'Лимит размера повтора',
                summaryModelSection: 'Модель для сводки',
                summaryModelDescription: 'Агент и модель, которые пишут сводку, передаваемую в новую сессию.',
                handoffSection: 'Перенос сессий',
                handoffLinkDescription: 'Что переносится вместе с сессией, когда вы передаёте её на другую машину.',
            },
            permissions: {
                duringSessionSection: 'Во время сессии',
                duringSessionDescription: 'Где появляются запросы на одобрение и когда вступает в силу изменение разрешений работающей сессии.',
                promptSurfaceComposer: 'У поля ввода',
                applyImmediately: 'Сразу',
                applyNextMessage: 'Со следующего сообщения',
                storageUseDefault: 'По умолчанию',
            },
            handoff: {
                pageDescription: 'Что переносится вместе с сессией, когда вы передаёте её на другую машину.',
                workspaceSection: 'Файлы рабочей области',
                workspaceDescription: 'Что происходит с папкой проекта, когда сессия переходит на другую машину.',
                keepUpdated: 'Обновлять',
                advancedModeDescription: 'Заменяет выбор выше. Осторожно: файлы могут быть удалены или перезаписаны.',
                ignoredExclude: 'Исключить',
                ignoredIncludeSelected: 'Включить выбранные',
            },
            toolRendering: {
                pageDescription: 'Показывайте для отдельных инструментов больше или меньше деталей, чем по умолчанию в стенограмме.',
                collapsedDescription: 'Сколько каждый инструмент показывает в стенограмме, пока вы его не откроете.',
            },
            transcript: {
                advancedTitle: 'Производительность и тайминги',
                advancedPageDescription: 'Потоковая передача, тайминги анимаций и пороги прокрутки. Значения по умолчанию подходят большинству.',
                advancedMotionOff: 'Анимации стенограммы выключены, поэтому эти настройки ни на что не влияют. Включите их в разделе Стенограмма › Анимации.',
                toolsSection: 'Инструменты',
                toolOverridesDescription: 'Показывайте для отдельных инструментов больше или меньше деталей.',
                thinkingSummary: 'Кратко',
                thinkingFull: 'Полностью',
                strategyConsecutive: 'Подряд',
                strategyWholeTurn: 'Весь ход',
                copyMarkdown: 'Markdown',
                copyMarkdownDescription: 'Скопированные сообщения сохраняют форматирование и подписи авторов.',
                copyPlainDescription: 'Скопированные сообщения — простой текст без подписей.',
                motionSubtle: 'Мягкие',
                advancedLinkDescription: 'Потоковая передача, тайминги анимаций и пороги прокрутки.',
                pageDescription: 'Как читается разговор по мере роста: макет, размышления, инструменты, анимации и прокрутка.',
            },
            composer: {
                pageDescription: 'Как вы пишете и отправляете сообщения и что происходит, когда агент занят.',
                newSessionsSection: 'Новые сессии',
                newSessionsDescription: 'Что вы видите, выбирая «Новая сессия».',
                draftEntryTitle: 'При открытии новой сессии',
                draftResume: 'Продолжить черновик',
                draftFresh: 'Начать заново',
                typingSection: 'Ввод',
                typingDescription: 'Как Enter и история сообщений работают в поле ввода.',
                enterToSendTitle: 'Enter отправляет',
                sendModeTitle: 'Пока агент работает',
                sendQueue: 'В очередь',
                sendInterrupt: 'Прервать',
                sendPending: 'Ожидание',
                busySteerTitle: 'Если агент принимает указания',
                busySteerInactive: 'Действует, только когда сообщения ставятся в очередь или ждут, пока агент работает.',
                nonSteerableTitle: 'Спрашивать, если сообщение не может направить',
                resumeWhenPossible: 'Когда возможно',
                resumeIfOnline: 'Если в сети',
                resumeNever: 'Никогда',
                pendingSection: 'Ожидающие сообщения',
                pendingDescription: 'Как ожидающие сообщения попадают к агенту.',
                pendingInactive: 'При текущих настройках ничего не ждёт. Эти параметры сработают, как только сообщение попадёт в ожидание.',
                drainOne: 'По одному',
                drainAll: 'Все сразу',
                timingAfterReply: 'После ответа',
                timingWhenIdle: 'Когда всё простаивает',
                layoutSection: 'Вид поля ввода',
                actionBarTitle: 'Панель действий',
                actionBarAutoDescription: 'На широких экранах чипы переносятся на вторую строку, на телефоне прокручиваются вбок.',
                actionBarWrapDescription: 'Чипы переносятся на вторую строку, если не помещаются.',
                actionBarScrollDescription: 'Чипы остаются в одной строке; прокрутите, чтобы увидеть остальные.',
                actionBarCollapsedDescription: 'Чипы убираются в меню, оставляя больше места для текста.',
                chipDensityTitle: 'Чипы действий',
                chipsAutoDescription: 'Чипы, которым нужна подпись, её сохраняют; понятные без слов показывают только значок.',
                chipsLabelsDescription: 'Каждый чип показывает подпись.',
                chipsIconsDescription: 'Чипы показывают только значки, чтобы сэкономить место.',
            },
        },
    } };

return { settingsSessionPagesTranslations };
})();

const Domain_shareSheetTranslations = (() => {
type ShareSheetTranslations = Shared_shareSheetTranslations.ShareSheetTranslations;

const shareSheetTranslations = { ru: {
        publicLink: { description: "Любой, у кого есть ссылка, может читать этот документ без аккаунта.", grants: "Документ только для чтения.", audit: "Журнал доступа", auditEmpty: "Посещений пока нет.", ownerUpdateRequired: "Владелец обновляет эту ссылку", ownerUpdateRequiredDescription: "Попросите владельца открыть Happier, затем попробуйте эту ссылку снова." },
        whoHasAccess: 'У кого есть доступ',
        whoHasAccessStale: 'У кого есть доступ · может быть неактуально',
        owner: 'Владелец',
        you: 'Вы',
        addPlaceholder: 'Добавить людей или команды',
        person: 'Человек',
        group: 'Группа команды',
        team: 'Команда',
        accessLevel: 'Уровень доступа',
        accessibleControl: ({ name, control, value }) => `${name}, ${control}, ${value}`,
        remove: 'Удалить доступ',
        confirmRemove: 'Подтвердить удаление',
        removedAnnouncement: ({ name }) => `У ${name} больше нет доступа`,
        browseAll: 'Показать все',
        allLoaded: 'Все результаты загружены',
        copyLink: 'Копировать ссылку',
        linkCopied: 'Ссылка скопирована',
        copyLinkFailed: 'Не удалось скопировать ссылку.',
        sendCopy: 'Отправить копию',
        secrets: {
            levels: { canUse: 'Может использовать' },
            help: { use: 'в запусках; значение никогда не показывается' },
            oneLevel: 'Сохранённый секрет используют только запуски, а его значение никогда не покидает хранилище, поэтому уровень один.',
        },
        documents: {
            title: 'Общий доступ',
            shareTitle: ({ name }) => `Поделиться: ${name}`,
            levels: { canUse: 'Может использовать', canRead: 'Может читать', canEdit: 'Может редактировать', admin: 'Управление' },
            help: {
                workflowUse: 'просматривать и запускать',
                roleUse: 'использовать; собственные изменения остаются в своих Настройках',
                profileUse: 'запускать с ним сессии',
                documentUse: 'открывать и копировать на любом своём устройстве',
                promptUse: 'использовать в своих сессиях',
                boardUse: 'видеть доску; каждая карточка открывает только то, что уже доступно',
                editForEveryone: 'изменять для всех, с кем им поделились',
                adminOwnerShares: 'изменять и управлять доступом; только владелец может назначать администраторов',
            },
            notes: {
                personalRuns: 'Запуски и триггеры остаются у того, кто их запускает.',
                teamRuns: 'Команда видит каждый запуск.',
                roleLive: 'Ваши изменения доходят до всех, с кем им поделились.',
                profileSecrets: 'Секретные значения никогда не передаются · привяжите сохранённый секрет',
            },
            errors: {
                unavailable: 'Общий доступ здесь пока недоступен.',
                ownerOnly: 'Только владелец или администратор может менять, у кого есть доступ.',
                noAccess: 'У вас больше нет доступа.',
                notFound: 'Это больше недоступно.',
                subjectUnavailable: 'Этот человек, группа или команда не может получить доступ.',
                failed: 'Не удалось обновить общий доступ. Попробуйте ещё раз.',
            },
        },
    } } satisfies Pick<Record<string, ShareSheetTranslations>, "ru">;

return { shareSheetTranslations };
})();

const Domain_sidebarFooterTranslations = (() => {
type SidebarFooterTranslation = Shared_sidebarFooterTranslations.SidebarFooterTranslation;

const sidebarFooterTranslations = { ru: {
        linkToService: ({ service }) => `Связать с ${service}`,
        addHomeOrSignIn: 'Добавить Home или войти',
        usageNoAccounts: 'Подключите аккаунт, чтобы видеть, сколько осталось от его лимитов.',
        usageHealthy: 'Во всех лимитах ещё много запаса',
        homeUnreachableTitle: ({ home }) => `Не удаётся подключиться к ${home}`,
        homeUnreachableBody: 'Ваши машины и сессии снова появятся здесь, когда он ответит.',
        homeUnreachableLine: ({ home }) => `Не удаётся подключиться к ${home}.`,
        availableWhenHomeAnswers: "Будет доступно, когда этот Home ответит.",
        usageKeysWithoutLimits: ({ count }) => `Ключи без лимитов: ${count}`,
        usageSignedOut: 'Вход не выполнен',
        hideAccountIdentities: 'Скрыть почту и ID аккаунтов',
        accountIdentitiesHidden: 'Почта и ID скрыты · для стримов и демо',
        usageThisSession: 'Эта сессия',
        usageAllAccounts: 'Все аккаунты',
        usageMoreAccounts: ({ count }) => `ещё ${count}`,
        usageSessionThroughPool: ({ agent, pool }) => `${agent} входит через ${pool}`,
        usageSessionWithAccount: ({ agent }) => `${agent} входит с этим аккаунтом`,
        usageSessionOwnSignIn: ({ agent }) => `${agent} использует собственный вход`,
        usagePoolFallback: 'свой пул',
        usageNextInOrder: ({ account }) => `Когда ${account} закончится, следующий ход перейдёт к следующему аккаунту по порядку`,
        usageNextMostLeft: ({ account }) => `Когда ${account} закончится, следующий ход перейдёт к аккаунту с наибольшим остатком`,
        usageNextStays: ({ pool, account }) => `${pool} остаётся на ${account}, пока вы не переключите`,
    } } as const satisfies Pick<Record<string, SidebarFooterTranslation>, "ru">;

return { sidebarFooterTranslations };
})();

const Domain_surfaceStateTranslations = (() => {
type SurfaceStateTranslations = Shared_surfaceStateTranslations.SurfaceStateTranslations;

const surfaceStateTranslations = { ru: {
        stillWaiting: ({ seconds }) => `Всё ещё ждём · ${seconds} с`,
        asOf: ({ time }) => `На ${time}`,
        howItWorks: 'Как это работает',
        tryAgain: 'Повторить',
        checkAgain: 'Проверить снова',
        paneFailedTitle: 'Не удалось показать эту панель',
        paneFailedReason: 'При отрисовке что-то пошло не так. Ваша сессия не затронута.',
        opening: ({ name }) => `Открываем ${name}`,
        couldNotOpen: ({ name }) => `Не удалось открыть ${name}`,
    } } as const satisfies Pick<Record<string, SurfaceStateTranslations>, "ru">;

return { surfaceStateTranslations };
})();

const Domain_teamsTranslations = (() => {
type TeamsTranslationRoot = Shared_teamsTranslations.TeamsTranslationRoot;

const english = Shared_teamsTranslations.english;

const russian: TeamsTranslationRoot = {
    teams: {
        overview: {
            sessionsSubtitle: 'Сессии, которыми поделились с этой командой.',
        },
        pages: {
            credentialCreate: 'Выберите, чем поделиться, кто может этим пользоваться и какие действуют лимиты.',
            credentialDetail: 'Кто может пользоваться этими учётными данными, как и в каком объёме.',
            credentialEdit: 'Измените, кто может пользоваться этими учётными данными, как и в каком объёме.',
            credentialActivity: 'Изменения этих учётных данных и их авторы.',
            credentialUsage: 'Сколько использовались эти учётные данные и кем.',
            credentialExternalApi: 'Используйте эти учётные данные из инструментов вне Happier.',
            identityProviderNew: 'Подключите поставщика удостоверений для входа участников.',
            identityProviderEdit: 'Измените подключение этого поставщика удостоверений.',
            githubApp: 'GitHub App, через которое команда получает доступ к репозиториям.',
            githubAppEdit: 'Измените регистрацию этого GitHub App.',
            authentication: 'Как участники входят в эту команду и кого она принимает.',
            credentials: 'Учётные данные провайдеров, которыми команда делится с участниками.',
            directory: 'Группы людей, которые делят сессии, доступ и учётные данные на Home.',
            members: 'Кто входит в эту команду и что может каждый.',
            addMember: 'Добавьте человека, у которого уже есть аккаунт на этом Home.',
            groups: 'Именованные наборы участников для общего доступа к сессиям и учётным данным.',
            newGroup: 'Назовите группу и выберите её участников.',
            invitations: 'Приглашения в эту команду и для кого они предназначены.',
            newInvitation: 'Пригласите кого-нибудь в эту команду.',
            settings: 'Название, логотип, параметры сессий по умолчанию и активна ли команда.',
        },
        loading: 'Загрузка команды…',
        title: 'Команды',
        entrySubtitle: 'Создавайте команды, управляйте участниками и группами, приглашайте людей.',
        entry: {
            heading: ({ team }: { team: string }) => `Перейти к ${team}`,
            onHome: ({ home }: { home: string }) => `на ${home}`,
            signInServiceOrigin: ({ service }: { service: string }) => `Войдите через ${service}`,
            signInServiceUnavailableOrigin: ({ service }: { service: string }) => `Вход через ${service} недоступен`,
            signedInTo: ({ home, account }: { home: string; account: string }) => `Выполнен вход в ${home} как ${account}`,
            unnamedAccount: 'Аккаунт Happier',
            continueWith: ({ method }: { method: string }) => `Продолжить с ${method}`,
            providerUnavailableTitle: ({ method }: { method: string }) => `${method} недоступен`,
            providerUnavailableDisabled: 'Администратор вашей Team отключил этот способ входа. Проверьте позже.',
            providerUnavailableSetupIncomplete: 'Администратор вашей Team ещё не завершил настройку этого способа входа. Проверьте позже.',
            providerUnavailableUnavailable: 'Этот Home сейчас не может использовать этот способ входа. Проверьте позже.',
            unknownTargetTitle: 'Эта ссылка не указывает свой Home',
            unknownTargetBody: 'Это устройство не может определить, к какому Home относится эта ссылка входа в Team, поэтому ничего не было отправлено. Попросите у управляющего Team ссылку ещё раз.',
            ssoRequiredTitle: 'Этой Team нужен другой способ входа',
            ssoRequiredBody: 'Вы вошли в этот Home, но эта Team принимает только тот способ входа, который она требует. Войдите заново этим способом или вернитесь к своей работе.',
            invitationUnavailableTitle: 'Это приглашение нельзя использовать',
            invitationUnavailableBody: 'Возможно, оно истекло, было отозвано или уже использовано. Сам по себе вход не добавляет вас в Team.',
            wrongAccountTitle: 'Этот аккаунт не может использовать этот вход',
            wrongAccountBody: 'Аккаунт или личность, с которыми вы вошли, не те, что ожидает эта Team. Войдите с другим аккаунтом или через другого провайдера либо вернитесь к своей работе.',
            notProvisionedTitle: 'Эта Team пока не приняла вас',
            notProvisionedBody: 'Сам по себе вход не добавляет вас в эту Team. Кто будет принят, решает администратор; попросите у него доступ или приглашение, затем попробуйте снова.',
            directoryDelayedTitle: 'Ваш доступ ещё в пути',
            directoryDelayedBody: 'Эта Team получает участников из каталога, который ещё не передал ваш доступ. Попробуйте позже или обратитесь к управляющему Team.',
            accessRemovedTitle: 'Эта Team вам недоступна',
            accessRemovedBody: 'Возможно, ваш доступ был отозван, или Team сейчас недоступна на этом Home. Всё остальное, куда вы вошли, не затронуто.',
            providerChangedTitle: 'Этот способ входа изменился во время использования',
            providerChangedBody: 'Администратор обновил этот способ входа, пока вы входили. В вашем аккаунте ничего не изменилось. Начните заново со страницы Team, чтобы увидеть актуальные способы.',
            returnToTeamSignIn: 'Назад ко входу в Team',
            returnToHappier: 'Назад в Happier',
            signInToTeam: 'Войти в эту команду',
            readyStatus: 'Выберите способ входа, чтобы продолжить.',
        },
        homeLabel: 'Home',
        role: {
            owner: 'Владелец',
            admin: 'Администратор',
            member: 'Участник',
            guest: 'Гость',
        },
        roleHelp: {
            owner: 'Владеет командой, может управлять ею и менять владельцев.',
            admin: 'Имеет доступ участника и может управлять командой.',
            member: 'По умолчанию получает доступ, выданный команде.',
            guest: 'Видит только сессии и ресурсы, явно открытые этому аккаунту или одной из его групп.',
        },
        status: {
            active: 'Активен',
            suspended: 'Приостановлен',
        },
        history: {
            label: 'История сессий',
            allExisting: 'Включить сессии, уже открытые команде',
            fromMembership: 'Только сессии, открытые после вступления',
            allExistingNamed: ({ name }) => `Включить сессии, уже открытые ${name}`,
            fromMembershipNamed: ({ name }) => `Только сессии, открытые после вступления в ${name}`,
            scopeNote: 'Это относится к сессиям целиком. Речь не идёт о показе только тех сообщений, что созданы после вступления.',
        },
        unavailable: {
            title: 'Команды недоступны в этом Home',
            disabled: 'В этом Home команды отключены.',
            updateRequired: 'Этому Home нужно обновление, чтобы использовать команды.',
            offline: 'Этот Home сейчас недоступен.',
            retry: 'Повторить',
        },
        stale: {
            label: 'Показаны последние известные данные этого Home.',
        },
        errors: {
            generic: 'Не удалось выполнить. Ничего не изменилось.',
            outcomeUnknown: 'Home мог применить это изменение. Обновите данные команды перед повторной попыткой.',
            forbidden: 'У вас нет прав на это изменение.',
            notFound: 'Эта команда больше недоступна.',
            archived: 'Эта команда в архиве. Восстановите её, чтобы вносить изменения.',
            conflict: 'Кто-то изменил это раньше вас. Проверьте текущие значения и повторите.',
            offline: 'Этот Home недоступен, поэтому изменение не отправлено.',
            invalidName: 'Введите название длиной от 1 до 80 символов.',
            invalidDescription: 'Введите описание длиной не более 500 символов.',
        },
        directory: {
            loading: 'Загрузка команд…',
            chooseTeamToShare: 'Выберите команду, с которой поделиться.',
            noMatches: 'Нет подходящих команд',
            noLoadedMatches: 'Нет подходящих загруженных команд',
            searchLoadedPlaceholder: 'Фильтровать загруженные команды',
            unreachableHomes: 'Не отвечают',
            searchPlaceholder: 'Поиск команд',
            newTeam: 'Новая команда',
            createDenied: ({ homes }: { homes: string }) => `Создавать команды в ${homes} могут только администраторы. Попросите одного из них создать команду или добавить вас в неё.`,
            createAdministered: ({ names }: { names: string }) => `Команды в этом Home создают его администраторы: ${names}. Попросите создать для вас команду или разрешить всем создавать команды.`,
            createAdministeredUnnamed: 'Команды в этом Home создают его администраторы. Попросите одного из них создать для вас команду или разрешить всем создавать команды.',
            createOff: 'Создание команд в этом Home выключено.',
            letEveryoneCreate: 'Разрешить всем создавать команды',
            namesAnd: ({ names, last }: { names: string; last: string }) => `${names} и ${last}`,
            namesAndOthers: ({ names, count }: { names: string; count: number }) => `${names} и ещё ${count}`,
            emptyTitle: 'Команд пока нет',
            emptyBody: 'Команда даёт группе людей одно общее место для сессий, участников и доступа.',
            archivedSection: 'Архивные команды',
            archivedEmpty: 'Нет архивных команд',
            archivedEmptyBody: 'Команда, заархивированная в её настройках, появляется здесь. Участники, группы и история сохраняются.',
            showArchived: 'Показать архивные',
            hideArchived: 'Скрыть архивные',
            archivedBadge: 'В архиве',
            rowAccessibilityLabel: ({ name, role, home }: { name: string; role: string; home: string }) => `${name}, ${role}, в ${home}`,
            partialHomes: 'Некоторые Home недоступны, поэтому их команд нет в этом списке.',
        },
        create: {
            loading: 'Проверяем, где можно создать команду…',
            discard: 'Отменить',
            detailsSection: 'Команда',
            logoFailedBody: 'Команда создана, но её логотип не опубликован. Попробуйте ещё раз или продолжите без него.',
            title: 'Новая команда',
            nameLabel: 'Название',
            namePlaceholder: 'Acme',
            descriptionLabel: 'Описание',
            descriptionPlaceholder: 'Чем занимается эта команда',
            homeHelp: 'Команда создаётся в этом Home и остаётся в нём.',
            duplicateNameNote: 'Две команды могут носить одно название. Ссылки и доступ всегда указывают на саму команду.',
            managedOnlyTitle: 'Созданием команд в этом Home управляет администратор',
            managedOnlyBody: 'Здесь команды создаёт администратор, он же выбирает первого владельца.',
            initialOwnerLabel: 'Первый владелец',
            initialOwnerPlaceholder: 'Поиск людей в этом Home',
            initialOwnerHelp: 'Создание команды для другого человека не добавляет вас в неё.',
            initialOwnerRequired: 'Выберите первого владельца команды. В этом Home администратор назначает владельца новой команды.',
            initialOwnerIneligible: 'Этот человек больше не может владеть командой. Выберите кого-то другого.',
            submit: 'Создать команду',
            submitting: 'Создаём…',
            outcomeUnknown: 'Не удалось подтвердить, создана ли команда. Повторите попытку, чтобы восстановить тот же запрос.',
        },
        tabs: {
            overview: 'Обзор',
            sessions: 'Сессии',
            members: 'Участники',
            groups: 'Группы',
            invitations: 'Приглашения',
            authentication: 'Аутентификация',
            settings: 'Настройки',
        },
        authentication: {
            policy: {
                admissionSection: 'Приём',
                admissionHelp: 'Как люди становятся участниками этой команды.',
                admissionInviteOnly: 'Только по приглашению',
                admissionProvisioned: 'Предоставляется каталогом',
                admissionJit: 'Автоматически при первом входе',
                admissionUnavailable: 'Этот Home пока не может применить такой режим приёма, поэтому ничего не изменилось.',
                admissionUnavailableReason: {
                    homePolicyUnavailable: 'Этот Home не предоставил командам этого поставщика входа. Администратор Home может это изменить.',
                    homePolicyProhibited: 'Администратор Home не разрешает этот режим приёма в этом Home.',
                    directorySourceRequired: 'Сначала добавьте каталог в эту команду. Этот режим принимает людей, которых предоставляет каталог.',
                    directoryProjectionRequired: 'Каталог этой команды ещё не завершил первую синхронизацию. Режим станет доступен после её завершения.',
                    teamConnectionRequired: 'Сначала добавьте в эту команду подключение для входа. Приём при первом входе без него невозможен.',
                    teamConnectionUnavailable: 'Сейчас ни одно подключение для входа этой команды не работает, поэтому принять кого-либо при входе нельзя.',
                },
                acceptedSection: 'Допустимый вход',
                acceptedHelp: 'Какой вход принимает эта команда, прежде чем разрешить командную работу.',
                acceptedInherit: 'Использовать политику Home',
                acceptedRestricted: 'Только выбранный ниже вход',
                connectionsSection: 'Допустимые подключения',
                connectionsEmpty: 'Выберите хотя бы одно подключение для входа или используйте политику Home.',
                homeMethodRetained: 'Сохранено из записанной политики',
                repairRequired: 'Сохранённое ограничение входа не читается',
                repairRequiredHelp: 'Оно применяется не так, как записано. Выберите ниже политику, чтобы заменить его.',
                conflictBody: 'Политика входа изменилась в этом Home. Просмотрите её и примените своё изменение снова.',
                providerTestRequired: 'Проверьте это подключение, прежде чем команда сможет его требовать.',
                unavailable: 'Этот Home не может принять такую политику входа.',
                approvalPending: 'Ожидание подтверждения',
                connectionOwnerTeam: "Подключение команды",
                connectionOwnerHome: "Способ входа Home",
            },
            subtitle: 'Как участники команды подтверждают свою личность.',
            memberSignIn: {
                section: 'Страница входа для участников',
                open: 'Открыть страницу входа для участников',
                copyLink: 'Скопировать ссылку',
                shareLink: 'Поделиться ссылкой',
                qrLabel: 'QR-код ссылки для входа участников',
                footer: 'Любой, у кого есть эта ссылка, попадёт на страницу входа этой команды. Сама по себе ссылка ничего не даёт: присоединение по-прежнему подчиняется политике приёма команды.',
                unavailable: 'Нет ссылки для отправки',
                unavailableBody: 'Этот Home не публикует веб-адрес, поэтому нет ссылки, которая работала бы на другом устройстве. Администратор Home может её настроить.',
            },
            connectionsSection: 'Подключения для входа',
            empty: 'Нет подключений для входа',
            status: {
                unavailable: 'Недоступно',
                prohibited: 'Заблокировано политикой Home',
                notConfigured: 'Не настроено',
                settingUp: 'Настройка',
                connected: 'Активно',
                needsAttention: 'Требует внимания',
                disabled: 'Отключено',
            },
            mode: {
                signInOnly: 'Только вход',
                signInTimeGroups: 'Группы обновляются при входе',
            },
            detail: {
                status: 'Состояние',
                mode: 'Режим',
                provider: 'Провайдер',
                restrictions: 'Ограничения входа',
                allowedUsers: 'Разрешённые пользователи',
                allowedDomains: 'Разрешённые почтовые домены',
                none: 'Нет',
                configuration: 'Конфигурация',
                organization: 'Организация',
                connection: 'Подключение',
            },
            directory: {
                actions: {
                    section: '操作', sync: '今すぐ同期', pause: '同期を一時停止', resume: '同期を再開', remove: 'ディレクトリを削除…',
                    pauseTitle: ({ source }: { source: string }) => `${source} を一時停止しますか？`, pauseBody: '新しいディレクトリ変更を停止します。既知の Team アクセスとグループへの寄与は再開まで保持されます。',
                    removeTitle: ({ source }: { source: string }) => `${source} を削除しますか？`, removeBody: ({ teamMembershipsRemoved, groupMembershipsRemoved, groupContributionsRemoved, directoryCreatedGroupsRetained, nativeMembershipsPreserved, nativeGroupContributionsPreserved }: { teamMembershipsRemoved: number; groupMembershipsRemoved: number; groupContributionsRemoved: number; directoryCreatedGroupsRetained: number; nativeMembershipsPreserved: number; nativeGroupContributionsPreserved: number }) => `管理対象メンバーシップ ${teamMembershipsRemoved} 件、有効なグループメンバーシップ ${groupMembershipsRemoved} 件、ソース寄与 ${groupContributionsRemoved} 件を削除します。ディレクトリ作成グループ ${directoryCreatedGroupsRetained} 件、通常メンバーシップ ${nativeMembershipsPreserved} 件、通常グループ寄与 ${nativeGroupContributionsPreserved} 件は保持されます。Account は削除されません。`,
                },
                section: "Управляемое членство",
                overviewSubtitle: "Источники каталога синхронизируют участников и группы Команды с внешней организацией.",
                manageSubtitle: "Просмотрите подключённые источники каталога и их последнее состояние синхронизации.",
                title: "Синхронизация каталога",
                sourcesSection: "Источники каталога",
                sourcesLoadMore: "Загрузить ещё источники",
                subtitle: "Изменения участников применяются только из полных проекций сервера.",
                empty: "Нет источников каталога",
                setup: {
                    section: "Добавить источник",
                    add: "Выбрать источник каталога",
                    options: "Настройка источника",
                    optionsFooter: "Выберите точный проверенный каталог или организацию провайдера.",
                    loadMore: "さらに読み込む",
                    empty: "Проверенных источников пока нет",
                    workos: "Настроить синхронизацию каталога WorkOS",
                    workosSubtitle: "Откройте портал администратора WorkOS и вернитесь, чтобы выбрать проверенный каталог.",
                    confirmTitle: ({ source }: { source: string }) => `Add ${source}?`,
                    confirmBody: "Happier начнёт импортировать этот каталог после его добавления.",
                },
                people: {
                    section: "Люди",
                    empty: "Нет подготовленных пользователей",
                    provisioned: "Подготовлен · Аккаунта ещё нет",
                    boundAccountCount: ({ count }: { count: number | string }) => `Связанные аккаунты: ${count}`,
                    unboundPeopleCount: ({ count }: { count: number | string }) => `Подготовленные пользователи без аккаунта: ${count}`,
                    member: "Участник команды",
                    unknown: "Пользователь без имени",
                    loadMore: "Загрузить ещё пользователей",
                    state: {
                        suspended: "Приостановлен",
                        deleted: "Удалён",
                    },
                },
                kind: {
                    workos: "Синхронизация каталога WorkOS",
                    github: "Организация GitHub",
                },
                state: {
                    setup: "Требуется настройка",
                    syncing: "Синхронизация",
                    active: "Активен",
                    paused: "Приостановлен",
                    needsAttention: "Требует внимания",
                    initializing: "Настройка",
                    failed: "Последняя синхронизация не удалась",
                },
                mode: {
                    eventsAndFull: "События и полная сверка",
                    fullOnly: "Только полная сверка",
                },
                freshness: {
                    never_synced: "Не синхронизировался",
                    fresh: "Актуален",
                    stale: "Устарел",
                    unknown: "Неизвестно",
                },
                detail: {
                    status: "Состояние",
                    sourceType: "Тип источника",
                    syncSection: "Состояние синхронизации",
                    mode: "Режим синхронизации",
                    freshness: "Актуальность",
                    lastSuccess: "Последняя успешная синхронизация",
                    nextScheduled: "Следующая запланированная синхронизация",
                    attentionSection: "Требует внимания",
                    attentionTitle: "Этот источник каталога требует внимания",
                    attentionRetryable: "Источник может восстановиться после исправления подключения. Обновите, чтобы проверить его состояние.",
                    attentionAdmin: "Проверьте конфигурацию источника, прежде чем полагаться на новые изменения каталога.",
                },
                never: "Никогда",
                unknown: "Неизвестно",
            },
        },
        settings: {
            archiveDescription: 'Архивация убирает команду из активных списков и прекращает доступ через команду. Участники, группы и история сохраняются, команду можно восстановить.',
            logoSection: 'Логотип',
            sessionDefaultsSection: 'Настройки сессий по умолчанию',
            externalSharingSection: 'Внешний доступ',
            historyDefaultSection: 'История по умолчанию',
            lifecycleSection: 'Жизненный цикл команды',
            saved: 'Сохранено',
        },
        policy: {
            sessionCreationPrivate: 'По умолчанию приватные',
            sessionCreationTeam: 'По умолчанию открыты команде',
            sessionCreationRequired: 'Всегда открыты команде',
            sessionCreationHelp: 'Относится к новым сессиям. Существующие приватные сессии не раскрываются.',
            externalSharingAllowed: 'Все, кто может делиться',
            externalSharingAdmins: 'Только администраторы команды',
            externalSharingDisabled: 'Запрещено',
            externalSharingHelp: 'Это может заблокировать будущий обмен. Уже переданные копии не отзываются.',
            historyDefaultHelp: 'Это заранее выбирает вариант для новых участников. История нынешних участников не переписывается.',
        },
        logo: {
            add: 'Добавить логотип',
            replace: 'Заменить логотип',
            remove: 'Удалить логотип',
            removeConfirmTitle: 'Удалить этот логотип?',
            removeConfirmBody: 'Команда снова покажет свою монограмму. Новый логотип можно загрузить в любой момент.',
            previewLabel: 'Предпросмотр логотипа',
            useAsLogo: 'Использовать как логотип',
            monogramLabel: 'Монограмма команды',
            tooLarge: 'Это изображение слишком большое. Выберите поменьше.',
            invalidFormat: ({ formats }: { formats: string }) => `Этот файл не является поддерживаемым изображением. Поддерживаемые форматы: ${formats}.`,
            failed: 'Логотип не загружен. Текущий логотип не изменился.',
            retry: 'Повторить',
        },
        archive: {
            openSettings: 'Открыть настройки',
            action: ({ name }: { name: string }) => `Архивировать ${name}`,
            confirmTitle: ({ name }: { name: string }) => `Архивировать ${name}?`,
            confirmBody: ({ name }: { name: string }) => `${name} исчезнет из активных представлений. Доступ через команду и группы прекратится, а невыполненные ссылки-приглашения будут отозваны. Членства, группы, политики и уже выданные права сохраняются. Восстановление ${name} может снова сделать эти сохранённые права действующими.`,
            restoreAction: ({ name }: { name: string }) => `Восстановить ${name}`,
            restoreTitle: ({ name }: { name: string }) => `Восстановить ${name}?`,
            restoreBody: () => 'Текущие членства, группы и сохранённые права снова станут действующими там, где аккаунты и ресурсы это по-прежнему допускают. Отозванные ссылки-приглашения не вернутся.',
            readOnly: 'Эта команда в архиве. Восстановите её, чтобы вносить изменения.',
        },
        members: {
            membershipSection: 'Участие',
            filterLabel: 'Показать',
            searchPlaceholder: 'Поиск участников',
            filterAll: 'Все',
            filterOwnersAndAdmins: 'Владельцы и администраторы',
            filterMembers: 'Участники',
            filterGuests: 'Гости',
            filterSuspended: 'Приостановленные',
            emptyTitle: 'Подходящих участников нет',
            emptyBody: 'Измените фильтр или пригласите кого-нибудь в эту команду.',
            add: 'Добавить участника',
            addTitle: ({ team }: { team: string }) => `Добавить в ${team}`,
            personLabel: 'Человек',
            roleLabel: 'Роль',
            personPlaceholder: 'Поиск людей в этом Home',
            ineligible: 'Уже в этой команде или аккаунт не активен в этом Home.',
            addSubmit: 'Добавить участника',
            you: 'Вы',
            joined: ({ when }: { when: string }) => `Присоединился ${when}`,
            managedBy: ({ source }: { source: string }) => `Управляется через ${source}`,
            managedReadOnly: 'Это членство управляется в своём источнике. Измените его там.',
            detailManagedBy: 'Управляется',
            managementTitle: 'Источник управления',
            managementHelp: 'Смена источника сохраняет это членство, роль, статус и историю сессий. Меняется только то, кто может их изменять.',
            managementNative: 'Управляется в Happier',
            managementConflict: 'В этом источнике пока нет свободной учётной записи для этого человека. Синхронизируйте его и попробуйте снова.',
            detailOpenSource: 'Открыть настройки источника',
            encryption: {
                title: 'Зашифрованный доступ',
                checking: 'Проверка зашифрованного доступа…',
                ready: 'Подготовлено',
                scopeBody: 'Здесь учитываются только сеансы, которыми вы управляете. Другим менеджерам сеансов, возможно, ещё нужно подготовить доступ.',
                pending: 'Требует подготовки',
                prepare: 'Подготовить зашифрованный доступ',
                preparing: ({ prepared }: { prepared: number }) => `Подготовка зашифрованного доступа · подготовлено ${prepared}`,
                setupRequired: 'Требуется настройка',
                setupRequiredBody: 'Этот человек ещё не завершил настройку зашифрованного доступа. Историю сессий можно будет подготовить позже.',
                notEncrypted: 'Без шифрования',
                plainAccount: 'Аккаунт этого человека не использует сквозное шифрование, поэтому готовить нечего.',
                repairRequired: 'Зашифрованный доступ нужно восстановить',
                repairBody: 'Некоторые сессии, которыми вы управляете, нельзя подготовить с этого устройства. Откройте их, чтобы восстановить собственный доступ.',
                nonTransferableBody: 'Некоторые сессии используют прежний формат шифрования, который нельзя передать новым участникам. Для тех, у кого доступ уже есть, они остаются читаемыми.',
                recipientChanged: 'Аккаунт этого человека изменился. Обновляем данные перед новой подготовкой.',
                retry: 'Повторить',
                failed: 'Подготовка остановилась до завершения. Всё уже подготовленное сохранено.',
            },
            detailGroups: 'Группы',
            detailGroupsEmpty: 'Групп нет',
            suspend: 'Приостановить участника',
            suspendTitle: ({ name }: { name: string }) => `Приостановить ${name}?`,
            suspendBody: 'Доступ к команде и группам прекращается сразу. Членство в группах и назначения ресурсов сохраняются, а возобновление вернёт только тот доступ, который остаётся действительным. Аккаунт в Home и другие команды не затрагиваются.',
            reactivate: 'Возобновить участие',
            reactivateTitle: ({ name }: { name: string }) => `Возобновить участие ${name}?`,
            reactivateBody: 'Доступ возвращается там, где это по-прежнему допускают членства, группы и состояние аккаунта.',
            remove: 'Удалить из команды',
            removeTitle: ({ name }: { name: string }) => `Удалить ${name}?`,
            removeBody: 'Текущий доступ к команде и группам заканчивается. Членства в группах и права на время членства удаляются. Прежнее авторство и уже увиденное содержимое не стираются. Повторное вступление начинает новое членство.',
            lastOwnerBlocked: 'В команде остаётся хотя бы один активный владелец. Сначала назначьте другого владельца.',
            accountInactive: 'Аккаунт этого человека неактивен, поэтому его нельзя добавить или назначить владельцем.',
            ownerOnlyAction: 'Менять владельцев может только владелец команды.',
            ownerRequiredTitle: 'Нужен владелец',
            ownerRequiredBody: ({ team }: { team: string }) => `Команде ${team} нужен активный владелец для изменений, доступных только владельцу.`,
            chooseOwner: 'Выбрать владельца',
            ownerRequiredNoCandidate: 'Подходящих участников нет. Нужно добавить существующего участника или договориться о передаче владения.',
        },
        groups: {
            detailsSection: 'Группа',
            title: 'Группы',
            emptyTitle: 'Групп пока нет',
            emptyBody: 'Группа — это плоский набор участников команды, которым можно открывать доступ сразу.',
            emptyRosterTitle: 'В этой группе пока нет участников',
            noEligibleCandidatesTitle: 'Некого добавить',
            noEligibleCandidatesBody: 'Здесь появляются участники команды, которых ещё нет в этой группе.',
            create: 'Новая группа',
            nameLabel: 'Название',
            namePlaceholder: 'Разработчики',
            descriptionPlaceholder: 'Для чего эта группа',
            submit: 'Создать группу',
            nameTaken: 'Группа с таким названием уже есть в этой команде.',
            memberCount: ({ count }: { count: number }) => `Участников: ${count}`,
            managedBy: ({ source }: { source: string }) => `Управляется источником ${source}`,
            membersSection: 'Участники группы',
            addMember: 'Добавить в группу',
            removeNative: 'Убрать из группы',
            removeMemberTitle: ({ name, group }: { name: string; group: string }) => `Удалить ${name} из группы ${group}?`,
            removeMemberBody: ({ name, group }: { name: string; group: string }) => `${name} сразу теряет доступ, который даёт группа ${group}. Участник остаётся в команде, и его можно снова добавить в эту группу.`,
            externalOnlyTitle: 'Управляется в своём источнике',
            externalOnlyBody: ({ source }: { source: string }) => `${source} по-прежнему добавляет этого человека, поэтому он остаётся в группе. Измените это в настройках источника.`,
            archiveAction: ({ name }: { name: string }) => `Архивировать ${name}`,
            archiveTitle: ({ name }: { name: string }) => `Архивировать ${name}?`,
            archiveBody: 'Доступ через группу прекращается сразу. Членство и история сохраняются, а восстановление группы может снова сделать эти права действующими.',
            restoreAction: ({ name }: { name: string }) => `Восстановить ${name}`,
            archivedSection: 'Архивные группы',
            archivedReadOnly: 'Эта группа в архиве. Восстановите её, чтобы вносить изменения.',
            managedReadOnly: 'Название и жизненный цикл этой группы управляются в её источнике. Участников по-прежнему можно добавлять здесь.',
        },
        invitations: {
            emptyTitle: 'Приглашений нет',
            emptyBody: 'Пригласите кого-нибудь ссылкой или добавьте человека, у которого уже есть аккаунт в этом Home.',
            invite: 'Пригласить',
            inviteTitle: ({ team }: { team: string }) => `Пригласить в ${team}`,
            byLink: 'Ссылка',
            byEmail: 'Эл. почта',
            emailLabel: 'Адрес эл. почты',
            emailPlaceholder: 'imya@primer.ru',
            create: 'Создать приглашение',
            linkNotice: ({ team, role }: { team: string; role: string }) => `Любой, кто вошёл в этот Home и имеет эту ссылку, может вступить в ${team} как ${role}.`,
            copyLink: 'Копировать ссылку',
            copied: 'Ссылка скопирована',
            qrLabel: 'QR-код для этой ссылки-приглашения',
            qrTooLargeFallback: 'Эта ссылка слишком длинная для QR-кода. Скопируйте её.',
            linkRow: 'Ссылка-приглашение',
            maskedRecipient: ({ email }: { email: string }) => `Для ${email}`,
            expires: ({ when }: { when: string }) => `Истекает ${when}`,
            stateActive: 'Активно',
            stateAccepted: 'Принято',
            stateRevoked: 'Отозвано',
            stateExpired: 'Истекло',
            deliverySent: 'Письмо отправлено',
            deliveryFailed: 'Не удалось доставить письмо',
            deliveryUnknown: 'Результат доставки неизвестен',
            deliveryRetry: 'Повторить',
            deliveryChangeEmail: 'Изменить адрес',
            emailUnavailable: 'Отправка писем недоступна в этом Home. Поделитесь ссылкой.',
            reissue: 'Создать новую ссылку',
            reissueNotice: 'Повторный выпуск создаёт новую ссылку. Прежняя ссылка перестанет работать.',
            revoke: 'Отозвать приглашение',
            revokeTitle: 'Отозвать это приглашение?',
            revokeBody: 'Ссылка перестаёт работать сразу. Новую можно создать в любой момент.',
            shareLink: 'Поделиться ссылкой',
            shareUnavailable: 'Поделиться на этом устройстве нельзя. Скопируйте ссылку.',
            bearerUnavailable: 'Эта ссылка была показана один раз и не хранится. Создайте новую ссылку, чтобы снова открыть доступ.',
            linkUnavailableRow: 'Нет ссылки для отправки',
            linkUnavailableBody: 'Этот Home не опубликовал адрес, на который могли бы вести ссылки-приглашения, поэтому делиться нечем. Попросите администратора Home опубликовать его или добавьте людей из списка «Люди» в Team.',
        },
        join: {
            previewLoading: 'Проверяем это приглашение…',
            joinAction: ({ team }: { team: string }) => `Вступить в ${team}`,
            joinWithCurrentAccount: 'Вступить с этой учётной записью',
            addInvitedAddressNotice: ({ email }: { email: string }) => `${email} будет добавлен в эту учётную запись как подтверждённый адрес.`,
            useAnotherAccount: 'Использовать другую учётную запись',
            useCurrentAccount: 'Использовать текущую учётную запись',
            useAnotherAccountHint: 'Войдите в этот Home, не выходя из этой учётной записи.',
            hostedOn: ({ home }: { home: string }) => `Размещено в ${home}`,
            personalHomeNotice: 'Этот Home работает на личном компьютере и может быть недоступен, пока тот офлайн.',
            plainStorageNotice: 'Сессии в этом Home хранятся без сквозного шифрования.',
            invitedBy: ({ name }: { name: string }) => `Приглашение от ${name}.`,
            roleOffered: ({ role }: { role: string }) => `Вас приглашают как ${role}.`,
            guestNotice: ({ team }: { team: string }) => `Вступление гостем не даёт доступа к сессиям команды ${team}. Материалы должны быть открыты лично вам или одной из ваших групп.`,
            joinedTitle: 'Вы присоединились',
            alreadyMemberTitle: 'Вы уже участник',
            openTeam: ({ team }: { team: string }) => `Открыть ${team}`,
            expiredTitle: 'Это приглашение истекло',
            revokedTitle: 'Это приглашение отозвано',
            usedTitle: 'Это приглашение уже использовано',
            archivedTitle: 'Эта команда в архиве',
            inactiveTitle: 'Этот аккаунт сейчас не может вступить',
            invalidTitle: 'Эта ссылка-приглашение недействительна',
            unresolvedHomeTitle: 'Эта ссылка не указывает свой Home',
            unresolvedHomeBody: 'Это устройство не может определить, какой Home выдал приглашение, поэтому ничего никуда не отправлено. Попросите у менеджера команды новую ссылку.',
            unknownHomeTitle: 'Этот Home ещё не добавлен на это устройство',
            askForNew: 'Попросите у менеджера команды новое приглашение.',
            mismatchTitle: 'Это приглашение для другого адреса',
            signInWithInvited: 'Войти с приглашённым адресом',
            verifyAddress: 'Подтвердить этот адрес',
            updateRequiredTitle: 'Этому Home нужно обновление для приглашений в команду',
            offlineTitle: 'Этот Home недоступен',
            offlineBody: 'Приглашение сохранено. Повторите, когда Home вернётся.',
            acceptanceOutcomeUnknown: 'Не удалось подтвердить вступление. Повторите попытку, чтобы проверить то же приглашение.',
            retry: 'Повторить',
        },
        credentials: {
            recovery: {
                openSettings: '\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u043d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438 \u0443\u0447\u0451\u0442\u043d\u044b\u0445 \u0434\u0430\u043d\u043d\u044b\u0445',
                selectBroker: '\u0412\u044b\u0431\u0440\u0430\u0442\u044c \u0440\u0430\u0441\u043f\u043e\u043b\u043e\u0436\u0435\u043d\u0438\u0435 \u0431\u0440\u043e\u043a\u0435\u0440\u0430',
                ownerHandoff: '\u041f\u043e\u043f\u0440\u043e\u0441\u0438\u0442\u0435 \u0432\u043b\u0430\u0434\u0435\u043b\u044c\u0446\u0430 \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0430 \u0432\u043e\u0441\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442\u044c \u044d\u0442\u0438 \u0443\u0447\u0451\u0442\u043d\u044b\u0435 \u0434\u0430\u043d\u043d\u044b\u0435',
                updateApp: '\u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c Happier',
                chooseAnother: '\u0412\u044b\u0431\u0440\u0430\u0442\u044c \u0434\u0440\u0443\u0433\u0438\u0435 \u0443\u0447\u0451\u0442\u043d\u044b\u0435 \u0434\u0430\u043d\u043d\u044b\u0435',
            },
            requestPolicy: {
                title: 'Политика запросов',
                subtitle: 'Ограничьте, о чём можно просить эти учётные данные.',
                summaryNone: 'Без ограничений',
                summaryActive: ({ count }: { count: number }) => `Ограничений: ${count}`,
                protocolsLabel: 'Форматы запросов',
                protocolsAny: 'Все, которые поддерживает источник',
                modelsLabel: 'Модели',
                modelsAny: 'Все модели, которые предлагает источник',
                modelsAllowed: ({ count }: { count: number }) => `Разрешено: ${count}`,
                effortLabel: 'Глубина рассуждений',
                effortAny: 'Все, которые поддерживает источник',
                catalogUnavailable: 'Выбрать разрешённые модели с этого Home пока нельзя. Текущий выбор действует, пока его не удалят.',
                clear: 'Снять все ограничения',
                activeNote: 'Уже идущая сессия не переписывается. Её следующий запрос должен соответствовать новой политике.',
                protocol: {
                    openaiResponses: 'OpenAI Responses',
                    openaiChatCompletions: 'OpenAI Chat Completions',
                    anthropicMessages: 'Anthropic Messages',
                },
            },
            directReadiness: {
                title: 'Готовность прямого доступа',
                check: 'Проверить готовность',
                summary: ({ ready, pending }: { ready: number; pending: number }) => `Готово: ${ready} · Готовится: ${pending}`,
                allReady: 'Все, у кого есть прямой доступ, готовы.',
                automatic: 'Материал готовится на компьютере, где хранится этот источник, как только он выходит в сеть.',
                state: {
                    ready: 'Готово',
                    preparing: 'Подготовка доступа',
                    notDelivered: 'Ещё не доставлено',
                    recipientBindingChanged: 'Ожидает настройки зашифрованного аккаунта',
                    sourceChanged: 'Источник изменился — обновляется',
                },
            },
            externalApi: {
                title: 'Внешний доступ по API',
                subtitle: 'Используйте этого провайдера из совместимых инструментов вне Happier.',
                privateTitle: 'Сессии Happier',
                privateDetail: 'Приватно через Happier',
                unavailable: 'Внешний доступ по API недоступен на этом Home.',
                publicHttpsRequired: 'Внешним инструментам нужен публичный HTTPS-адрес этого Home.',
                homeDisclosure: 'Необработанные тела запросов к провайдеру проходят через публичную HTTPS-точку этого Home и доступны его оператору для чтения.',
                bearerDisclosure: 'Этот ключ — секрет на предъявителя. Любой, у кого он есть, может использовать назначенный доступ до истечения срока или отзыва ключа.',
                usageDisclosure: 'Happier учитывает количество запросов. Итоговые данные по токенам и стоимости могут быть неполными, если протокол их не сообщает.',
                keysTitle: 'Ключи API',
                authorize: 'Авторизовать ключ',
                authenticationRequired: 'Назначенный участник должен авторизовать этот ключ через вход в команду.',
                authenticationUnavailable: 'Аутентификация команды недоступна. Попросите администратора проверить политику входа.',
                keysLoadFailed: 'Не удалось загрузить ключи API.',
                keysRetry: 'Повторить загрузку ключей',
                keysEmpty: 'Ключей пока нет',
                keysEmptyBody: 'Первый ключ включает внешний доступ; отзыв последнего его выключает.',
                labelPlaceholder: 'Для чего нужен этот ключ',
                assignLabel: 'Отнесено к',
                revealTitle: 'Сохраните этот ключ сейчас',
                revealBody: 'Он больше не будет показан.',
                revealDismiss: {
                    title: 'Закрыть, не скопировав ключ?',
                    body: 'Этот ключ нельзя будет показать снова. Оставьте его видимым, пока не сохраните.',
                    confirm: 'Ключ сохранён',
                    keepVisible: 'Оставить ключ видимым',
                },
                neverUsed: 'Не использовался',
                lastUsed: ({ when }: { when: string }) => `Последнее использование ${when}`,
                expiresOn: ({ when }: { when: string }) => `Истекает ${when}`,
                expired: 'Истёк',
                revokeTitle: ({ name }: { name: string }) => `Отозвать ${name}?`,
                revokeBody: 'Инструменты с этим ключом перестанут работать сразу. Сессии Happier это не затронет.',
                revokeAll: 'Отозвать все ключи',
                revokeAllBody: 'Внешний доступ по API выключится, пока не будет создан новый ключ. Сессии Happier это не затронет.',
            },
            title: '\u041e\u0431\u0449\u0438\u0435 \u0443\u0447\u0451\u0442\u043d\u044b\u0435 \u0434\u0430\u043d\u043d\u044b\u0435',
            subtitle: '\u041f\u043e\u0437\u0432\u043e\u043b\u044c\u0442\u0435 \u043a\u043e\u043c\u0430\u043d\u0434\u0435 \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u044c \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0451\u043d\u043d\u044b\u0439 \u0430\u043a\u043a\u0430\u0443\u043d\u0442, \u043f\u0443\u043b \u0438\u043b\u0438 \u043f\u0440\u043e\u0432\u0430\u0439\u0434\u0435\u0440\u0430, \u043d\u0435 \u043a\u043e\u043f\u0438\u0440\u0443\u044f \u0438\u0445 \u0432 \u043d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438 \u043a\u0430\u0436\u0434\u043e\u0433\u043e \u0443\u0447\u0430\u0441\u0442\u043d\u0438\u043a\u0430.',
            emptyTitle: '\u041e\u0431\u0449\u0438\u0445 \u0443\u0447\u0451\u0442\u043d\u044b\u0445 \u0434\u0430\u043d\u043d\u044b\u0445 \u043f\u043e\u043a\u0430 \u043d\u0435\u0442',
            emptyBody: '\u042d\u0442\u043e\u0439 \u043a\u043e\u043c\u0430\u043d\u0434\u0435 \u0435\u0449\u0451 \u043d\u0438\u0447\u0435\u0433\u043e \u043d\u0435 \u043e\u0442\u043a\u0440\u044b\u0442\u043e.',
            forbidden: '\u041e\u0431\u0449\u0438\u043c\u0438 \u0443\u0447\u0451\u0442\u043d\u044b\u043c\u0438 \u0434\u0430\u043d\u043d\u044b\u043c\u0438 \u0443\u043f\u0440\u0430\u0432\u043b\u044f\u044e\u0442 \u0432\u043b\u0430\u0434\u0435\u043b\u044c\u0446\u044b \u0438 \u0430\u0434\u043c\u0438\u043d\u0438\u0441\u0442\u0440\u0430\u0442\u043e\u0440\u044b \u043a\u043e\u043c\u0430\u043d\u0434\u044b.',
            unavailable: '\u042d\u0442\u043e\u0442 Home \u043d\u0435 \u043f\u0440\u0435\u0434\u043b\u0430\u0433\u0430\u0435\u0442 \u043e\u0431\u0449\u0438\u0435 \u0443\u0447\u0451\u0442\u043d\u044b\u0435 \u0434\u0430\u043d\u043d\u044b\u0435.',
            approvalPending: 'Ожидаем подтверждения. Изменения сохранятся до решения.',
            approvalDeclined: 'Запрос не подтвердили, поэтому ничего не изменилось.',
            sessionDeniedTitle: 'Общие учётные данные отклонили этот запрос',
            sharedByYou: '\u041e\u0442\u043a\u0440\u044b\u0442\u043e \u0432\u0430\u043c\u0438',
            providedByTeams: '\u041f\u0440\u0435\u0434\u043e\u0441\u0442\u0430\u0432\u043b\u0435\u043d\u043e \u043a\u043e\u043c\u0430\u043d\u0434\u0430\u043c\u0438',
            sharedWithYou: '\u0414\u043e\u0441\u0442\u0443\u043f\u043d\u043e \u0432\u0430\u043c',
            sourceAdministration: { title: '\u0414\u043e\u0441\u0442\u0443\u043f \u0434\u043b\u044f \u043a\u043e\u043c\u0430\u043d\u0434', empty: '\u042d\u0442\u043e\u0442 \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a \u043d\u0435 \u0434\u043e\u0441\u0442\u0443\u043f\u0435\u043d \u043d\u0438 \u043e\u0434\u043d\u043e\u0439 \u043a\u043e\u043c\u0430\u043d\u0434\u0435.' },
            source: {
                connectedAccount: '\u041f\u043e\u0434\u043a\u043b\u044e\u0447\u0451\u043d\u043d\u044b\u0439 \u0430\u043a\u043a\u0430\u0443\u043d\u0442',
                pool: '\u041f\u0443\u043b \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u043d\u044b\u0445 \u0441\u0435\u0440\u0432\u0438\u0441\u043e\u0432',
                providerConnection: '\u041f\u043e\u0434\u043a\u043b\u044e\u0447\u0435\u043d\u0438\u0435 \u043f\u0440\u043e\u0432\u0430\u0439\u0434\u0435\u0440\u0430',
            },
            delivery: {
                brokered: '\u0427\u0435\u0440\u0435\u0437 \u0431\u0440\u043e\u043a\u0435\u0440',
                direct: '\u041f\u0440\u044f\u043c\u043e\u0439 \u0434\u043e\u0441\u0442\u0443\u043f',
                both: '\u0411\u0440\u043e\u043a\u0435\u0440 + \u043f\u0440\u044f\u043c\u043e\u0439',
                mixed: '\u0421\u043c\u0435\u0448\u0430\u043d\u043d\u0430\u044f \u0434\u043e\u0441\u0442\u0430\u0432\u043a\u0430',
            },
            state: {
                available: '\u0414\u043e\u0441\u0442\u0443\u043f\u043d\u043e',
                needsAttention: '\u0422\u0440\u0435\u0431\u0443\u0435\u0442 \u0432\u043d\u0438\u043c\u0430\u043d\u0438\u044f',
                disabled: '\u041e\u0442\u043a\u043b\u044e\u0447\u0435\u043d\u043e',
            },
            usePolicy: {
                title: 'Поделиться этой сессией с Командой?',
                label: '\u0413\u0434\u0435 \u0443\u0447\u0430\u0441\u0442\u043d\u0438\u043a\u0438 \u043c\u043e\u0433\u0443\u0442 \u044d\u0442\u043e \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u044c',
                personalAllowed: '\u041b\u044e\u0431\u0430\u044f \u0440\u0430\u0437\u0440\u0435\u0448\u0451\u043d\u043d\u0430\u044f \u0441\u0435\u0441\u0441\u0438\u044f',
                teamContextRequired: '\u0421\u0435\u0441\u0441\u0438\u0438 \u044d\u0442\u043e\u0439 \u043a\u043e\u043c\u0430\u043d\u0434\u044b',
                teamVisibilityRequired: '\u0421\u0435\u0441\u0441\u0438\u0438, \u0432\u0438\u0434\u043d\u044b\u0435 \u044d\u0442\u043e\u0439 \u043a\u043e\u043c\u0430\u043d\u0434\u0435',
                visibilityNote: '\u0412\u044b\u0431\u043e\u0440 \u044d\u0442\u0438\u0445 \u0443\u0447\u0451\u0442\u043d\u044b\u0445 \u0434\u0430\u043d\u043d\u044b\u0445 \u043c\u043e\u0436\u0435\u0442 \u043e\u0442\u043a\u0440\u044b\u0442\u044c \u043b\u0438\u0447\u043d\u0443\u044e \u0441\u0435\u0441\u0441\u0438\u044e \u043a\u043e\u043c\u0430\u043d\u0434\u0435 \u043f\u043e\u0441\u043b\u0435 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u0438\u044f.',
            },
            selection: {
                activeTransitionUnsupported: 'Эта сессия запустилась до сохранения изменения, поэтому модель не изменилась. Попробуйте ещё раз.',
            },
            detail: {
                sourceLabel: '\u0418\u0441\u0442\u043e\u0447\u043d\u0438\u043a',
                brokerLabel: '\u0420\u0430\u0437\u043c\u0435\u0449\u0435\u043d\u0438\u0435 \u0431\u0440\u043e\u043a\u0435\u0440\u0430',
                brokerNone: '\u0412\u044b\u0431\u0440\u0430\u0442\u044c \u0440\u0430\u0437\u043c\u0435\u0449\u0435\u043d\u0438\u0435 \u0431\u0440\u043e\u043a\u0435\u0440\u0430',
                access: '\u0414\u043e\u0441\u0442\u0443\u043f \u0438 \u0434\u043e\u0441\u0442\u0430\u0432\u043a\u0430',
                activity: '\u0410\u043a\u0442\u0438\u0432\u043d\u043e\u0441\u0442\u044c',
                edit: '\u0418\u0437\u043c\u0435\u043d\u0438\u0442\u044c',
                notFound: '\u042d\u0442\u0438 \u043e\u0431\u0449\u0438\u0435 \u0443\u0447\u0451\u0442\u043d\u044b\u0435 \u0434\u0430\u043d\u043d\u044b\u0435 \u0431\u043e\u043b\u044c\u0448\u0435 \u043d\u0435\u0434\u043e\u0441\u0442\u0443\u043f\u043d\u044b.',
                brokerUnnamedMachine: 'Компьютер без имени',
                brokerUnnamedPool: 'Пул без имени',
                brokerChosen: 'Выбрана владельцем источника',
                limits: 'Ограничения',
                usage: 'Расход',
            },
            create: {
                title: 'Поделиться учётными данными',
                action: 'Поделиться данными',
                submit: 'Создать общие учётные данные',
                sourceChoose: 'Выберите источник',
                sourceEmpty: 'Пока нечем поделиться.',
                sourceUnsupported: 'Подключённые аккаунты и подключения провайдера пока нельзя предоставить из этого Home.',
                alreadyShared: 'Уже доступно этой команде',
                poolAccounts: ({ count }: { count: number }) => `${count} аккаунтов`,
                notAllowed: 'Эта команда не позволяет предлагать собственные учётные данные.',
                reviewLabel: 'Проверка',
            },
            edit: {
                title: '\u0418\u0437\u043c\u0435\u043d\u0438\u0442\u044c \u043e\u0431\u0449\u0438\u0435 \u0443\u0447\u0451\u0442\u043d\u044b\u0435 \u0434\u0430\u043d\u043d\u044b\u0435',
                nameLabel: '\u041d\u0430\u0437\u0432\u0430\u043d\u0438\u0435',
                namePlaceholder: '\u041d\u0430\u0437\u043e\u0432\u0438\u0442\u0435 \u044d\u0442\u0438 \u0443\u0447\u0451\u0442\u043d\u044b\u0435 \u0434\u0430\u043d\u043d\u044b\u0435',
                ceilingLabel: '\u041f\u0440\u044f\u043c\u043e\u0435 \u0440\u0430\u0441\u043a\u0440\u044b\u0442\u0438\u0435',
                ceilingBrokeredOnly: '\u0422\u043e\u043b\u044c\u043a\u043e \u0447\u0435\u0440\u0435\u0437 \u0431\u0440\u043e\u043a\u0435\u0440',
                ceilingDirectAllowed: '\u0420\u0430\u0437\u0440\u0435\u0448\u0438\u0442\u044c \u043f\u0440\u044f\u043c\u043e\u0439 \u0434\u043e\u0441\u0442\u0443\u043f',
                ceilingNote: '\u041f\u0440\u0438 \u043f\u0440\u044f\u043c\u043e\u043c \u0434\u043e\u0441\u0442\u0443\u043f\u0435 \u043b\u043e\u043a\u0430\u043b\u044c\u043d\u044b\u0435 \u0438\u043d\u0441\u0442\u0440\u0443\u043c\u0435\u043d\u0442\u044b \u043f\u043e\u043b\u0443\u0447\u0430\u0442\u0435\u043b\u044f \u043c\u043e\u0433\u0443\u0442 \u043f\u043e\u043b\u0443\u0447\u0438\u0442\u044c \u0441\u0435\u043a\u0440\u0435\u0442\u043d\u044b\u0439 \u043c\u0430\u0442\u0435\u0440\u0438\u0430\u043b. \u0421\u043d\u044f\u0442\u0438\u0435 \u0434\u043e\u0441\u0442\u0443\u043f\u0430 \u043e\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442 \u0431\u0443\u0434\u0443\u0449\u0438\u0435 \u0432\u044b\u0434\u0430\u0447\u0438, \u043d\u043e \u043d\u0435 \u0441\u0442\u0438\u0440\u0430\u0435\u0442 \u0442\u043e, \u0447\u0442\u043e \u0432\u043d\u0435\u0448\u043d\u0438\u0439 \u043f\u0440\u043e\u0446\u0435\u0441\u0441 \u0443\u0436\u0435 \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u043b.',
                conflict: '\u042d\u0442\u0438 \u043d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438 \u0438\u0437\u043c\u0435\u043d\u0438\u043b\u0438\u0441\u044c \u0432 \u0434\u0440\u0443\u0433\u043e\u043c \u043c\u0435\u0441\u0442\u0435. \u041e\u0431\u043d\u043e\u0432\u0438\u0442\u0435, \u0447\u0442\u043e\u0431\u044b \u0443\u0432\u0438\u0434\u0435\u0442\u044c \u0442\u0435\u043a\u0443\u0449\u0438\u0435 \u0437\u043d\u0430\u0447\u0435\u043d\u0438\u044f \u043f\u0435\u0440\u0435\u0434 \u0441\u043e\u0445\u0440\u0430\u043d\u0435\u043d\u0438\u0435\u043c.',
            },
            audience: {
                title: '\u0414\u043e\u0441\u0442\u0443\u043f \u0438 \u0434\u043e\u0441\u0442\u0430\u0432\u043a\u0430',
                none: '\u041f\u043e\u043a\u0430 \u043d\u0438\u043a\u043e\u0433\u043e',
                everyone: '\u0412\u0441\u044f \u043a\u043e\u043c\u0430\u043d\u0434\u0430',
                everyoneOff: '\u041d\u0435\u0442 \u0434\u043e\u0441\u0442\u0443\u043f\u0430 \u0434\u043b\u044f \u0432\u0441\u0435\u0439 \u043a\u043e\u043c\u0430\u043d\u0434\u044b',
                groupCount: ({ count }: { count: number }) => `\u0413\u0440\u0443\u043f\u043f: ${count}`,
                memberCount: ({ count }: { count: number }) => `\u0423\u0447\u0430\u0441\u0442\u043d\u0438\u043a\u043e\u0432: ${count}`,
                add: 'Добавить группу или человека',
                groupsSection: '\u0413\u0440\u0443\u043f\u043f\u044b',
                membersSection: '\u041b\u044e\u0434\u0438',
                remove: '\u0423\u0431\u0440\u0430\u0442\u044c \u0434\u043e\u0441\u0442\u0443\u043f',
                ceilingBlocked: '\u041f\u0440\u044f\u043c\u043e\u0439 \u0434\u043e\u0441\u0442\u0443\u043f \u0434\u043b\u044f \u044d\u0442\u0438\u0445 \u0443\u0447\u0451\u0442\u043d\u044b\u0445 \u0434\u0430\u043d\u043d\u044b\u0445 \u043d\u0435 \u0440\u0430\u0437\u0440\u0435\u0448\u0451\u043d. \u0421\u043d\u0430\u0447\u0430\u043b\u0430 \u0440\u0430\u0437\u0440\u0435\u0448\u0438\u0442\u0435 \u0435\u0433\u043e \u0432 \u0440\u0435\u0434\u0430\u043a\u0442\u043e\u0440\u0435.',
                directTitle: '\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u044d\u0442\u0438 \u0443\u0447\u0451\u0442\u043d\u044b\u0435 \u0434\u0430\u043d\u043d\u044b\u0435 \u043d\u0430\u043f\u0440\u044f\u043c\u0443\u044e?',
                directBody: '\u041b\u043e\u043a\u0430\u043b\u044c\u043d\u044b\u0435 \u0438\u043d\u0441\u0442\u0440\u0443\u043c\u0435\u043d\u0442\u044b \u0432\u044b\u0431\u0440\u0430\u043d\u043d\u044b\u0445 \u043b\u044e\u0434\u0435\u0439 \u043c\u043e\u0433\u0443\u0442 \u043f\u043e\u043b\u0443\u0447\u0438\u0442\u044c \u0441\u0435\u043a\u0440\u0435\u0442\u043d\u044b\u0439 \u043c\u0430\u0442\u0435\u0440\u0438\u0430\u043b \u044d\u0442\u043e\u0433\u043e \u0438\u0441\u0442\u043e\u0447\u043d\u0438\u043a\u0430. \u0421\u043d\u044f\u0442\u0438\u0435 \u0434\u043e\u0441\u0442\u0443\u043f\u0430 \u043e\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442 \u0431\u0443\u0434\u0443\u0449\u0438\u0435 \u0432\u044b\u0434\u0430\u0447\u0438, \u043d\u043e \u043d\u0435 \u0441\u0442\u0438\u0440\u0430\u0435\u0442 \u0442\u043e, \u0447\u0442\u043e \u0432\u043d\u0435\u0448\u043d\u0438\u0439 \u043f\u0440\u043e\u0446\u0435\u0441\u0441 \u0443\u0436\u0435 \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u043b.',
                directConfirm: '\u041e\u0442\u043a\u0440\u044b\u0442\u044c \u043d\u0430\u043f\u0440\u044f\u043c\u0443\u044e',
                keepBrokered: '\u041e\u0441\u0442\u0430\u0432\u0438\u0442\u044c \u0447\u0435\u0440\u0435\u0437 \u0431\u0440\u043e\u043a\u0435\u0440',
                limitsNote: '\u041f\u0440\u044f\u043c\u043e\u0435 \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u043d\u0438\u0435 \u043f\u0440\u043e\u0438\u0441\u0445\u043e\u0434\u0438\u0442 \u0432\u043d\u0435 Happier \u0438 \u043d\u0435 \u0437\u0430\u043f\u0438\u0441\u044b\u0432\u0430\u0435\u0442\u0441\u044f.',
            },
            directUse: {
                title: '\u0418\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u044c \u044d\u0442\u0438 \u043e\u0431\u0449\u0438\u0435 \u0443\u0447\u0451\u0442\u043d\u044b\u0435 \u0434\u0430\u043d\u043d\u044b\u0435 \u043d\u0430\u043f\u0440\u044f\u043c\u0443\u044e?',
                body: 'Happier \u043c\u043e\u0436\u0435\u0442 \u043f\u0435\u0440\u0435\u0434\u0430\u0442\u044c \u0443\u0447\u0451\u0442\u043d\u044b\u0435 \u0434\u0430\u043d\u043d\u044b\u0435 \u043b\u043e\u043a\u0430\u043b\u044c\u043d\u044b\u043c \u0438\u043d\u0441\u0442\u0440\u0443\u043c\u0435\u043d\u0442\u0430\u043c \u044d\u0442\u043e\u0439 \u0441\u0435\u0441\u0441\u0438\u0438. \u041f\u0440\u043e\u0434\u043e\u043b\u0436\u0430\u0439\u0442\u0435, \u0442\u043e\u043b\u044c\u043a\u043e \u0435\u0441\u043b\u0438 \u0434\u043e\u0432\u0435\u0440\u044f\u0435\u0442\u0435 \u044d\u0442\u0438\u043c \u0438\u043d\u0441\u0442\u0440\u0443\u043c\u0435\u043d\u0442\u0430\u043c.',
            },
            delete: {
                action: '\u0423\u0434\u0430\u043b\u0438\u0442\u044c \u043e\u0431\u0449\u0438\u0435 \u0443\u0447\u0451\u0442\u043d\u044b\u0435 \u0434\u0430\u043d\u043d\u044b\u0435',
                title: ({ name }: { name: string }) => `\u0423\u0434\u0430\u043b\u0438\u0442\u044c ${name}?`,
                body: '\u0423\u0447\u0430\u0441\u0442\u043d\u0438\u043a\u0438 \u0441\u0440\u0430\u0437\u0443 \u0442\u0435\u0440\u044f\u044e\u0442 \u0434\u043e\u0441\u0442\u0443\u043f, \u0438 \u0441\u043b\u0435\u0434\u0443\u044e\u0449\u0438\u0439 \u0437\u0430\u043f\u0440\u043e\u0441 \u043d\u0435 \u0432\u044b\u043f\u043e\u043b\u043d\u0438\u0442\u0441\u044f. \u0423\u0436\u0435 \u0432\u044b\u0434\u0430\u043d\u043d\u044b\u0439 \u043d\u0430\u043f\u0440\u044f\u043c\u0443\u044e \u043c\u0430\u0442\u0435\u0440\u0438\u0430\u043b \u0441\u0442\u0435\u0440\u0435\u0442\u044c \u043d\u0435\u043b\u044c\u0437\u044f.',
            },
            errors: {
                featureDisabled: '\u042d\u0442\u043e\u0442 Home \u043d\u0435 \u043f\u0440\u0435\u0434\u043e\u0441\u0442\u0430\u0432\u043b\u044f\u0435\u0442 \u043e\u0431\u0449\u0438\u0435 \u0443\u0447\u0451\u0442\u043d\u044b\u0435 \u0434\u0430\u043d\u043d\u044b\u0435.',
                teamAuthenticationRequired: '\u0412\u043e\u0439\u0434\u0438\u0442\u0435 \u0432 \u044d\u0442\u0443 \u043a\u043e\u043c\u0430\u043d\u0434\u0443, \u043f\u0440\u0435\u0436\u0434\u0435 \u0447\u0435\u043c \u043f\u0440\u043e\u0434\u043e\u043b\u0436\u0438\u0442\u044c.',
                teamAuthenticationPolicyUnavailable: '\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u043f\u0440\u043e\u0447\u0438\u0442\u0430\u0442\u044c \u043f\u043e\u043b\u0438\u0442\u0438\u043a\u0443 \u0432\u0445\u043e\u0434\u0430 \u044d\u0442\u043e\u0439 \u043a\u043e\u043c\u0430\u043d\u0434\u044b, \u043f\u043e\u044d\u0442\u043e\u043c\u0443 \u043d\u0438\u0447\u0435\u0433\u043e \u043d\u0435 \u0438\u0437\u043c\u0435\u043d\u0438\u043b\u043e\u0441\u044c.',
                memberNotEligible: '\u042d\u0442\u043e\u0442 \u0447\u0435\u043b\u043e\u0432\u0435\u043a \u043d\u0435 \u043c\u043e\u0436\u0435\u0442 \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u044c \u044d\u0442\u0438 \u0443\u0447\u0451\u0442\u043d\u044b\u0435 \u0434\u0430\u043d\u043d\u044b\u0435.',
                sessionPolicyIncompatible: '\u042d\u0442\u0438 \u0443\u0447\u0451\u0442\u043d\u044b\u0435 \u0434\u0430\u043d\u043d\u044b\u0435 \u043d\u0435\u043b\u044c\u0437\u044f \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u044c \u0432 \u044d\u0442\u043e\u043c \u0441\u0435\u0430\u043d\u0441\u0435 \u043f\u043e \u0435\u0433\u043e \u043f\u043e\u043b\u0438\u0442\u0438\u043a\u0435 \u043e\u0431\u0449\u0435\u0433\u043e \u0434\u043e\u0441\u0442\u0443\u043f\u0430.',
                brokerUnavailable: 'Машина-посредник этих учётных данных сейчас недоступна. Повторите, когда она вернётся, или выберите другое размещение.',
                sourceOwnerRequired: 'Это изменение может сделать только владелец источника.',
                sourceMissing: 'Эти учётные данные больше не указывают на существующий источник. Владелец должен выбрать источник заново.',
                invalidAudience: 'Эти люди или группы не могут получить эти учётные данные.',
                subjectNotInTeam: 'Этого человека или группы больше нет в команде.',
                costUnavailable: 'Ограничению по стоимости нужна цена для каждой разрешённой модели, а у некоторых её нет. Ограничьте запросы или токены.',
                invalidLimit: 'Проверьте меру, период и максимум.',
                limitIdentityImmutable: 'К кому относится ограничение, что оно измеряет и его период изменить нельзя. Удалите его и создайте новое.',
            },
            limits: {
                groupShared: '\u042d\u0442\u043e\u0442 \u043e\u0431\u044a\u0451\u043c \u0434\u0435\u043b\u044f\u0442 \u0432\u0441\u0435 \u0443\u0447\u0430\u0441\u0442\u043d\u0438\u043a\u0438 \u0413\u0440\u0443\u043f\u043f\u044b.',
                title: 'Ограничения',
                empty: 'Ограничений пока нет',
                emptyBody: 'Пока вы не добавите ограничение, разрешён любой запрос.',
                overshoot: 'Новые запросы прекращаются, как только записанный расход достигает предела. Уже выполняющиеся запросы могут завершиться.',
                directNote: 'Ограничения охватывают работу через посредника и внешний API. Прямое использование происходит на машине получателя и не записывается.',
                directOnly: 'Все, у кого есть доступ, используют эти учётные данные напрямую, на своей машине, поэтому Happier ничего не записывает и ограничение применить нельзя.',
                requestLimitsOnlyForPersonalUse: 'Лимиты токенов появляются, когда эти учётные данные требуют контекста команды. Личное использование открывает их и для фоновых запусков и внешнего API, которые сообщают только о запросах, поэтому всё использование охватывают только лимиты запросов.',
                add: 'Добавить ограничение',
                subjectLabel: 'Относится к',
                subject: {
                    resource: 'Всем общим учётным данным',
                    eachMember: 'Каждому участнику отдельно',
                    group: 'Группе',
                    member: 'Человеку',
                },
                metricLabel: 'Мера',
                metric: {
                    requests: 'Запросы',
                    tokens: 'Токены',
                    cost: 'Стоимость',
                },
                costNote: 'Ограничение по стоимости работает, только если у каждой разрешённой модели известна цена.',
                periodLabel: 'Период',
                period: {
                    day: 'Ежедневно',
                    week: 'Еженедельно',
                    month: 'Ежемесячно',
                },
                maximumLabel: 'Максимум',
                maximumPlaceholder: 'Максимум за период',
                maximumInvalid: 'Введите целое число больше нуля.',
                maximumInvalidCost: 'Введите сумму больше нуля.',
                recorded: ({ recorded, maximum }: { recorded: string; maximum: string }) => `Записано ${recorded} из ${maximum}`,
                resetsUtc: ({ when }: { when: string }) => `Сброс ${when} UTC`,
                reached: 'Предел достигнут',
                disabled: 'Выключено',
                remove: 'Удалить ограничение',
                removeTitle: 'Удалить это ограничение?',
                removeBody: 'Запросы сразу перестают с ним сверяться. Записанный расход сохраняется.',
                unknownSubject: 'Кто-то за пределами этой страницы',
            },
            usage: {
                title: 'Расход',
                empty: 'За этот период ничего не записано.',
                rangeLabel: 'Период',
                brokeredRequests: 'Запросы через посредника',
                directOnlyRequests: 'Запросы учитываются только при использовании через посредника.',
                recordedRequests: 'Записанные запросы',
                requestIncomplete: 'Учитываются только запросы, наблюдаемые Happier.',
                externalObservationsIncomplete: ({ count }: { count: number }) => `Для ${count} внешних ${count === 1 ? 'запроса' : 'запросов'} результат ещё не записан.`,
                breakdownRestricted: 'Некоторые разрезы видны только управляющим учётными данными.',
                export: 'Экспорт в CSV',
                exportFailed: 'Это устройство не смогло сохранить экспорт.',
                recordedByHappier: 'Записано Happier.',
                directIncomplete: 'Прямое использование происходит вне Happier и может не учитываться.',
                costIncomplete: 'Для части моделей стоимость за этот период недоступна.',
                tokenIncomplete: 'Сумма токенов за этот период неполна.',
                tokenUnavailable: 'За этот период использование токенов не наблюдалось.',
                costUnavailable: 'За этот период не наблюдалось использования с известной ценой.',
                costUnknown: 'Недоступно',
                breakdownLabel: 'Разбить по',
                breakdownNone: 'Только итоги',
                breakdown: {
                    member: 'Человек',
                    externalApiKey: 'Внешний ключ API',
                    model: 'Модель',
                    session: 'Сессия',
                    sourceMember: 'Исходный аккаунт',
                    workerMachine: 'Рабочая машина',
                    brokerMachine: 'Машина-посредник',
                    deliveryMode: 'Доставка',
                },
                limitsTitle: 'Ограничения за этот период',
                sliceSummary: ({ requests, tokens }: { requests: string; tokens: string }) => `${requests} запросов · ${tokens} токенов`,
            },
            activity: {
                title: '\u0410\u043a\u0442\u0438\u0432\u043d\u043e\u0441\u0442\u044c',
                empty: '\u0410\u0434\u043c\u0438\u043d\u0438\u0441\u0442\u0440\u0430\u0442\u0438\u0432\u043d\u044b\u0435 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f \u043f\u043e\u043a\u0430 \u043d\u0435 \u0437\u0430\u043f\u0438\u0441\u0430\u043d\u044b.',
                unknownActor: '\u041a\u0442\u043e-\u0442\u043e',
                kind: {
                    resourceCreated: '\u041e\u0442\u043a\u0440\u044b\u043b(\u0430) \u044d\u0442\u0438 \u0443\u0447\u0451\u0442\u043d\u044b\u0435 \u0434\u0430\u043d\u043d\u044b\u0435',
                    resourceUpdated: '\u0418\u0437\u043c\u0435\u043d\u0438\u043b(\u0430) \u043d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438',
                    audienceChanged: '\u0418\u0437\u043c\u0435\u043d\u0438\u043b(\u0430), \u043a\u0442\u043e \u043c\u043e\u0436\u0435\u0442 \u0438\u0445 \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u044c',
                    resourceDeleted: '\u0423\u0434\u0430\u043b\u0438\u043b(\u0430) \u044d\u0442\u0438 \u0443\u0447\u0451\u0442\u043d\u044b\u0435 \u0434\u0430\u043d\u043d\u044b\u0435',
                    directDelivered: '\u0412\u044b\u0434\u0430\u043b(\u0430) \u043f\u0440\u044f\u043c\u043e\u0439 \u0434\u043e\u0441\u0442\u0443\u043f',
                    externalKeyCreated: '\u0421\u043e\u0437\u0434\u0430\u043b(\u0430) \u0432\u043d\u0435\u0448\u043d\u0438\u0439 \u043a\u043b\u044e\u0447 API',
                    externalKeyRevoked: '\u041e\u0442\u043e\u0437\u0432\u0430\u043b(\u0430) \u0432\u043d\u0435\u0448\u043d\u0438\u0439 \u043a\u043b\u044e\u0447 API',
                    limitsChanged: '\u0418\u0437\u043c\u0435\u043d\u0438\u043b(\u0430) \u043b\u0438\u043c\u0438\u0442\u044b',
                },
            },
        },
    },
};

const teamsTranslations = { ru: russian };

return { teamsTranslations };
})();

const Domain_terminalWorkspaceTranslations = (() => {
const en = Shared_terminalWorkspaceTranslations.en;

const terminalWorkspaceKeyboardTranslations = Shared_terminalWorkspaceTranslations.terminalWorkspaceKeyboardTranslations;

const terminalWorkspaceTranslations = { ru: en };

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

const ru: ThisComputerConnectionTranslation = {
    connectHome: {
        title: ({ home }: HomeParams) => `Подключить этот компьютер к ${home}?`,
        body: ({ home }: HomeParams) => `${home} сможет запускать сеансы на этом компьютере. Home терминала и другие подключения сохранятся.`,
        connect: 'Подключить',
        keep: 'Сохранить текущие подключения',
    },
    setupAlreadyRunning: 'Настройка уже выполняется. Дождитесь её завершения.',
    title: {
        daemon_url_mismatch: 'Фоновая служба работает с другим Home',
        daemon_account_mismatch: 'Фоновая служба использует другой аккаунт',
        daemon_needs_auth: 'Фоновой службе нужно войти',
        daemon_not_configured: 'Фоновая служба ещё не подключена',
        daemon_not_installed: 'Фоновая служба не установлена',
        daemon_not_running: 'Фоновая служба остановлена',
    },
    description: {
        daemon_url_mismatch: ({ home, daemonHome }: OtherHomeParams) => `Она подключена к ${daemonHome}, а не к ${home}.`,
        daemon_account_mismatch: ({ home, daemonAccount, appAccount }: AccountParams) =>
            `Она вошла в ${home} как ${daemonAccount}, а не как ${appAccount}.`,
        daemon_needs_auth: ({ home }: HomeParams) => `Она подключена к ${home}, но ещё не одобрена.`,
        daemon_not_configured: ({ home }: HomeParams) => `Она ещё не завершила подключение к ${home}.`,
        daemon_not_installed: ({ home }: HomeParams) => `Установите её, чтобы подключить этот компьютер к ${home}.`,
        daemon_not_running: ({ home }: HomeParams) => `Запустите её, чтобы снова подключиться к ${home}.`,
    },
    action: {
        daemon_url_mismatch: 'Подключить к этому Home',
        daemon_account_mismatch: ({ appAccount }: { appAccount: string }) => `Переключить на ${appAccount}`,
        daemon_needs_auth: 'Войти',
        daemon_not_configured: 'Подключить к этому Home',
        daemon_not_installed: 'Установить фоновую службу',
        daemon_not_running: 'Запустить фоновую службу',
    },
    connected: ({ home, appAccount }: { home: string; appAccount: string }) => `Подключено к ${home} как ${appAccount}.`,
    noComputers: ({ home, appAccount }: { home: string; appAccount: string }) => `У ${appAccount} пока нет компьютеров в ${home}.`,
    openThisComputer: 'Проверить этот компьютер',
    moveConfirm: {
        title: ({ appAccount }: { appAccount: string }) => `Переключить этот компьютер на ${appAccount}?`,
        body: ({ home, daemonHome, daemonAccount, appAccount }: MoveParams) =>
            `Его фоновая служба вошла в ${daemonHome} как ${daemonAccount}. После переключения она будет работать для ${appAccount} в ${home}, а ${daemonAccount} перестанет видеть этот компьютер.`,
        confirm: 'Переключить',
    },
    cli: {
        title: 'Happier CLI',
        version: ({ version }: { version: string }) => `Версия ${version}`,
        updateAvailable: ({ version, latestVersion }: { version: string; latestVersion: string }) =>
            `Версия ${version} · доступна ${latestVersion}`,
        update: 'Обновить',
        progressTitle: 'Обновление Happier CLI',
        notManaged: ({ origin }: { origin: string }) => `Установлен вне Happier: ${origin}`,
    },
    cliChoice: {
        title: ({ version }: { version: string }) => `Happier CLI ${version} уже установлен`,
        titleUnknownVersion: 'Happier CLI уже установлен',
        titleMissing: 'Ваш Happier CLI больше не установлен',
        body: ({ path }: { path: string }) => `Он находится в ${path}. Happier может установить свою копию, обновлять её и поставить первой в PATH — или вы можете продолжить пользоваться этой.`,
        bodyOutdated: ({ path }: { path: string }) => `Он находится в ${path} и слишком старый для настройки. Happier может установить свою актуальную копию и поставить её первой в PATH — или вы можете оставить свою и обновить её сами.`,
        bodyMissing: ({ path }: { path: string }) => `Вы решили оставить тот, что был в ${path}, но его там больше нет. Happier может установить свою копию и обновлять её — или вы можете переустановить свой и продолжить им пользоваться.`,
        bodyKeepBlocked: ({ path, link }: { path: string; link: string }) => `Он находится в ${path}, но новые терминалы сначала запускают CLI Happier через ${link}, который Happier не добавлял. Позвольте Happier управлять командной строкой или удалите ${link} и запустите настройку снова, чтобы оставить свой.`,
        notNow: 'Не сейчас',
        manage: 'Пусть Happier управляет',
        keep: 'Оставить мой',
        unanswered: 'Настройка остановилась, ничего не изменив. Чтобы продолжить, выберите, кто управляет командной строкой.',
        ownMissing: 'Командная строка, которую вы оставили, больше не установлена. Переустановите её или позвольте Happier управлять командной строкой.',
        managed: 'Управляется Happier',
        own: ({ path }: { path: string }) => `Ваша — ${path}`,
        change: 'Изменить, кто управляет командной строкой',
        keptUpdateTitle: 'Обновите свою командную строку',
        keptUpdate: ({ command }: { command: string }) => `Доступна более новая версия. Обновите её командой ${command}`,
        oldCopyTitle: 'Старая командная строка',
        oldCopyRemove: ({ path, command }: { path: string; command: string }) => `Всё ещё установлена в ${path}. Удалите её командой ${command}`,
        oldCopyPath: ({ path }: { path: string }) => `Всё ещё установлена в ${path}.`,
    },
    servers: {
        title: 'Home, которые обслуживает этот компьютер',
        connected: 'Подключено',
        offline: 'Настроено · Не работает',
        attention: 'Требует внимания',
        currentHome: ({ home }: HomeParams) => `${home} · этот Home`,
    },
    removal: {
        uninstallFailedTitle: 'Не удалось отключить этот компьютер',
        uninstallFailedBody: ({ home }: HomeParams) => `Не удалось удалить фоновую службу этого компьютера для ${home}, поэтому ${home} сохранён. Повторите попытку или удалите службу в разделе «Настройки › Этот компьютер».`,
        inventoryUnavailableTitle: 'Не удалось проверить этот компьютер',
        inventoryUnavailableBody: ({ home }: HomeParams) => `Happier не смог прочитать фоновые службы этого компьютера и не знает, обслуживает ли этот компьютер ${home}. Всё равно удалить из Happier?`,
        removeAnyway: 'Всё равно удалить',
        userOwnedTitle: 'Этот компьютер продолжает его обслуживать',
        userOwnedBody: ({ home, service }: RemovalServiceParams) => `${service} установлена не через Happier, поэтому продолжает работать для ${home}. Удалите её в терминале, если она больше не нужна.`,
    },
};

const thisComputerConnectionTranslations = { ru };

return { thisComputerConnectionTranslations };
})();

const Domain_transcriptFindTranslations = (() => {
const transcriptFindTranslations = { ru: { searchOlder: 'Искать в старых сообщениях', partialErrors: 'Поиск по части содержимого недоступен. Результаты неполные.', olderRemaining: 'Старые сообщения ещё не просмотрены.', findOpen: 'Открыть поиск', findNext: 'Следующее совпадение', findPrevious: 'Предыдущее совпадение' } } as const;

return { transcriptFindTranslations };
})();

const Domain_turnChangesTranslations = (() => {
type TurnChangesTranslations = Shared_turnChangesTranslations.TurnChangesTranslations;

const en = Shared_turnChangesTranslations.en;

const translated = Shared_turnChangesTranslations.translated;

const turnChangesTranslations = { ru: {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `Изменено файлов: ${count}`,
                walkThrough: 'Объясни по шагам',
                openInFiles: 'Открыть в Файлах',
                fileCount: ({ count }) => `Файлов: ${count}`,
                fileCountInFolders: ({ count, folders }) => `Файлов: ${count}, папок: ${folders}`,
                showMore: ({ count }) => `Показать ещё ${count}`,
                groupA11y: 'Изменения в этом ходе',
            }),
        },
    } } as const;

return { turnChangesTranslations };
})();

const Domain_voiceDiagnosticsConsentTranslations = (() => {
type VoiceDiagnosticsConsentCopy = Shared_voiceDiagnosticsConsentTranslations.VoiceDiagnosticsConsentCopy;

const defineVoiceDiagnosticsConsentTranslation = Shared_voiceDiagnosticsConsentTranslations.defineVoiceDiagnosticsConsentTranslation;

const voiceDiagnosticsConsentTranslations = { ru: defineVoiceDiagnosticsConsentTranslation({
    consentTitle: 'Записывать речь на этом устройстве?',
    consentBody: 'Аудио речи может содержать личные разговоры и фоновые звуки. Файлы остаются на устройстве, защищены закрытыми разрешениями, автоматически удаляются и никогда не синхронизируются и не прикрепляются к аналитике или отчётам о сбоях.',
    consentAction: 'Включить запись',
  }) } as const;

return { voiceDiagnosticsConsentTranslations };
})();

const Domain_voiceDiagnosticsTranslations = (() => {

type VoiceDiagnosticsCopy = Shared_voiceDiagnosticsTranslations.VoiceDiagnosticsCopy;

const voiceDiagnosticsConsentTranslations = {...Domain_voiceDiagnosticsConsentTranslations.voiceDiagnosticsConsentTranslations};

const defineVoiceDiagnostics = Shared_voiceDiagnosticsTranslations.defineVoiceDiagnostics;

const voiceDiagnosticsTranslations = { ru: defineVoiceDiagnostics(voiceDiagnosticsConsentTranslations["ru"].diagnostics, {
    title: 'Локальная диагностика речи',
    footer: 'По умолчанию выключено. Аудио остаётся на выбранной машине, пока вы явно не экспортируете его.',
    enabled: 'Записывать локальное диагностическое аудио',
    enabledSubtitle: 'Хранить ограниченные входные данные STT и выходные данные TTS локально для диагностики',
    sttInput: 'Записывать входные данные распознавания речи',
    ttsOutput: 'Записывать синтезированную речь',
    location: 'Место хранения',
    unavailable: 'Выбранная машина недоступна',
    retention: 'Ограничения хранения',
    retentionDetail: ({ hours, files, megabytes }) => `${hours} ч · ${files} файлов · ${megabytes} МБ`,
    deleteAll: 'Удалить всё диагностическое аудио',
    deleteAllSubtitle: 'Немедленно удаляет аудио и метаданные с выбранной машины',
    deleteConfirmTitle: 'Удалить всю локальную диагностику речи?',
    deleteConfirmBody: 'Это безвозвратно удалит все диагностические записи речи на выбранной машине.',
    deleteAction: 'Удалить всё',
    deleteFailed: 'Не удалось удалить локальные диагностические записи. Возможно, они всё ещё есть на выбранной машине.',
    cleanupRequired: 'Локальная очистка диагностики требует внимания',
    cleanupRequiredSubtitle: 'Некоторые приватные диагностические файлы могли остаться, либо не удалось прочитать локальный каталог. Повторите очистку или удалите всё диагностическое аудио.',
    captureFailed: 'Запись диагностики требует внимания',
    captureFailedSubtitle: 'Последнюю диагностическую запись не удалось прочитать или сохранить. Оставшихся диагностических файлов не обнаружено; готовность будет проверена при следующей подходящей записи голоса.',
    retryCleanup: 'Повторить очистку диагностики',
    retryCleanupSubtitle: 'Повторно проверяет приватное хранилище и применяет его ограничения хранения',
    cleanupRetryFailed: 'Не удалось завершить очистку. Диагностические файлы могут оставаться на выбранной машине; повторите попытку или удалите всё после её переподключения.',
    exportTitle: 'Экспорт выбранной диагностики',
    noArtifacts: 'На выбранной машине нет сохранённых диагностических записей.',
    exportSttArtifact: 'Экспортировать входные данные распознавания речи',
    exportTtsArtifact: 'Экспортировать синтезированную речь',
    exportArtifactAccessibility: 'Экспортировать эту локальную диагностическую запись речи',
    exportConfirmTitle: 'Экспортировать эту приватную запись?',
    exportConfirmBody: 'Выбранная запись будет скопирована с выбранной машины на это устройство по зашифрованной одноразовой передаче. Она никогда не выгружается автоматически.',
    exportAction: 'Экспортировать запись',
    exportFailed: 'Не удалось экспортировать приватную запись. Ничего не было выгружено.',
    backupPolicy: 'Исключение из резервных копий',
    backupPolicyBestEffort: 'Хранится в приватном кэше выбранной машины и помечено для средств резервного копирования, соблюдающих стандарт каталога кэша. Автоматическая выгрузка или синхронизация не выполняется; исключение из резервных копий операционной системы не гарантируется.',
    activeIndicator: 'Диагностика речи включена',
    checkingIndicator: 'Проверка статуса диагностики речи',
    statusUnknownIndicator: 'Статус диагностики речи неизвестен',
    shutdownPendingIndicator: 'Остановка диагностики речи',
    shutdownFailedIndicator: 'Не удалось подтвердить отключение диагностики речи',
    retryShutdown: 'Повторить остановку диагностики',
    sessionOptOut: 'Не записывать эту сессию',
    sessionOptOutConfirmTitle: 'Прекратить запись этой сессии?',
    sessionOptOutConfirmBody: 'Диагностика речи останется включённой для других сессий, но новое аудио из этой сессии не будет записываться до перезапуска приложения.',
    sessionOptOutFailed: 'Не удалось остановить запись на активной машине. Эта сессия всё ещё может записываться; повторите попытку после её переподключения.',
    sessionOptOutRetry: 'Повторить остановку записи',
  }) } as const;

return { voiceDiagnosticsTranslations };
})();

const Domain_voiceExternalCredentialApprovalTranslations = (() => {
type VoiceExternalCredentialApprovalCopy = Shared_voiceExternalCredentialApprovalTranslations.VoiceExternalCredentialApprovalCopy;

const defineVoiceExternalCredentialApproval = Shared_voiceExternalCredentialApprovalTranslations.defineVoiceExternalCredentialApproval;

const voiceExternalCredentialApprovalTranslations = { ru: defineVoiceExternalCredentialApproval({
    reviewRequired: 'Проверьте доступ к учётным данным',
    recipientApprovalTitle: 'Разрешить этому провайдеру использовать ваши учётные данные?',
    recipientApprovalBody: 'Проверьте и одобрите объявленные адреса и операции провайдера. Если этот контракт получателя изменится, Happier сохранит ваш выбор, но заблокирует использование учётных данных до повторного одобрения.',
    recipientApprovalPackage: ({ title, pluginId, sourceKind, sourceLocator }) =>
      `Пакет: ${title} (${pluginId}); источник: ${sourceKind} ${sourceLocator}`,
    recipientApprovalPublisher: ({ trust, identity }) => `Издатель: ${identity} (${trust})`,
    recipientApprovalPackageSignature: ({ status, keyId }) => `Подпись пакета: ${keyId} (${status})`,
    recipientApprovalContribution: ({ pluginId, localId }) => `Вклад: ${pluginId}/${localId}`,
    recipientApprovalOperations: 'Объявленные операции:',
    recipientApprovalOperation: ({ id, purpose, effect }) =>
      `Операция ${id}: назначение ${purpose}; эффект ${effect}`,
    recipientApprovalRequest: ({ method, origin, pathTemplate }) => `Запрос: ${method} ${origin}${pathTemplate}`,
    recipientApprovalCredential: ({ headerName, format }) =>
      `Заголовок с учётными данными: ${headerName}; формат: ${format}`,
    recipientApprovalBounds: ({ requestMaxBytes, responseMaxBytes }) =>
      `Ограничения в байтах: запрос ${requestMaxBytes}; ответ ${responseMaxBytes}`,
    recipientApprovalTrust: { bundled: 'встроенный', verified: 'проверенный' },
    recipientApprovalEffect: { read: 'чтение', mutation: 'изменение' },
    recipientApprovalCredentialFormat: { raw: 'необработанный', bearer: 'bearer' },
    recipientApprovalConfirm: 'Одобрить и сохранить',
  }) } as const;

return { voiceExternalCredentialApprovalTranslations };
})();

const Domain_voiceLocalCredentialTranslations = (() => {
type VoiceLocalCredentialCopy = Shared_voiceLocalCredentialTranslations.VoiceLocalCredentialCopy;

const defineVoiceLocalCredential = Shared_voiceLocalCredentialTranslations.defineVoiceLocalCredential;

const voiceLocalCredentialTranslations = { ru: defineVoiceLocalCredential({
    voiceCredential: {
      setOnAccount: 'Сохранено в вашем аккаунте',
      notSetOnAccount: 'Не сохранено в вашем аккаунте',
      setOnMachineOverride: ({ machine }) => `Используется переопределение учётных данных аккаунта для ${machine}`,
      notSetWithFallback: ({ machine }) => `Не задано для ${machine}; при наличии будут использованы учётные данные аккаунта`,
      plainStorageTitle: 'Сохранить ключ API без сквозного шифрования?',
      plainStorageBody: 'В этом аккаунте настройки хранятся без сквозного шифрования. Если сохранить этот ключ API, его открытый текст будет виден серверу.',
      plainStorageConfirm: 'Сохранить ключ API',
      deleteAccountBody: 'Удалить этот сохранённый ключ API? Другие привязки, ссылающиеся на тот же сохранённый секрет, сохранят его.',
      machineUnavailable: 'Выберите машину выполнения голоса в сети',
      machineUnavailableTitle: 'Голосовая машина недоступна',
      machineUnavailableBody: 'Прежде чем сохранять или использовать эти учётные данные, выберите машину выполнения голоса в сети.',
      statusUnavailable: ({ machine }) => `Статус учётных данных на ${machine} недоступен. Нажмите, чтобы повторить.`,
      importAvailable: ({ machine }) => `Доступен прежний ключ для импорта на ${machine}`,
      notSetOnMachine: ({ machine }) => `Не задано на ${machine}`,
      setOnMachine: ({ machine, protection }) => `Задано на ${machine} · ${protection}`,
      protection: { osProtected: 'Защищено ОС', filePermissions: 'Защищено правами доступа к файлам' },
      importTitle: 'Импортировать существующий ключ API?',
      importBody: ({ machine }) => `Скопировать существующую зашифрованную настройку аккаунта на ${machine}. Оригинал останется доступным для ваших других устройств.`,
      importAction: 'Импортировать',
      enterNewAction: 'Ввести новый',
      useSavedSecretTitle: 'Использовать сохранённый секрет',
      useSavedSecretSubtitle: 'Выберите ключ, уже сохранённый в этом аккаунте.',
      replaceOrRemoveBody: 'Введите новый ключ API или оставьте поле пустым, чтобы удалить ключ с этой машины.',
      deleteTitle: 'Удалить ключ API?',
      deleteBody: ({ machine }) => `Удалить этот ключ API с ${machine}? Прежнее общее для устройств значение, если оно есть, не изменится.`,
      operationFailed: 'Выбранная машина не смогла обновить эти учётные данные. Убедитесь, что она в сети, и повторите попытку.',
      newCredentialRequired: ({ machine }) => `На ${machine} требуются новые учётные данные машины`,
    },
    openAiCompatEndpoint: {
      executionMachine: ({ machine }) => `Запросы выполняются на ${machine}. Localhost относится к этой машине.`,
      insecureTitle: 'Разрешить небезопасный локальный HTTP?',
      insecureBody: ({ origin, machine }) => `Разрешить отправку учётных данных по HTTP на ${origin} с ${machine}? Localhost относится к ${machine}. Принимаются только адреса loopback и частных сетей; публичный HTTP отклоняется.`,
      allowAction: 'Разрешить HTTP',
      invalidBody: 'Введите URL с HTTPS или HTTP-адрес loopback либо частной сети без имени пользователя, пароля и строки запроса.',
    },
  }) } as const;

return { voiceLocalCredentialTranslations };
})();

const Domain_voiceMomentsTranslations = (() => {
type VoiceMomentsTranslation = Shared_voiceMomentsTranslations.VoiceMomentsTranslation;

const voiceMomentsTranslations = { ru: {
        setupTitle: 'Настроить голос',
        setupTileSubtitle: 'Говорите с сессиями вслух. Четыре коротких шага.',
        setupTileProgress: ({ done, total, next }) => `Готово ${done} из ${total} · ${next}`,
        setupNextService: 'дальше: кто слушает',
        setupNextReadiness: 'дальше: завершить сервис',
        setupNextMicrophone: 'дальше: разрешить микрофон',
        setupNextTry: 'дальше: попробовать',
        setupNextInstalling: 'установка',
        setupStart: 'Настроить',
        setupContinue: 'Продолжить',
        setupDescription: 'Говорите с сессиями вслух: спрашивайте, что происходит, запускайте работу, решайте откуда угодно. Четыре шага; можно уйти и вернуться.',
        setupLightCaption: ({ done, total }) => `Готово ${done} из ${total}`,
        setupServiceTitle: 'Выберите, кто слушает',
        setupServiceDetail: 'Что слышит вас и отвечает. Это можно изменить позже.',
        setupChange: 'Изменить',
        setupReadinessTitle: ({ service }) => `Завершите настройку ${service}`,
        setupReadinessDone: ({ service }) => `${service} готов`,
        setupReadinessGeneric: 'Сервис',
        setupReadinessTitleGeneric: 'Подготовьте сервис',
        setupReadinessUnknown: 'Откройте настройки, чтобы проверить, чего не хватает.',
        setupReadinessCheck: 'Проверить настройку',
        setupMicrophoneTitle: 'Разрешите микрофон',
        setupMicrophoneDetail: 'Устройство спросит один раз. Happier слушает только при включённом голосе, и это всегда видно.',
        setupMicrophoneAction: 'Разрешить микрофон',
        setupMicrophoneDone: 'Микрофон разрешён',
        setupMicrophoneDeniedTitle: 'Микрофон для Happier выключен',
        setupMicrophoneDeniedDetail: 'Включите его в настройках системы и вернитесь сюда.',
        setupOpenSystemSettings: 'Открыть настройки',
        setupTryTitle: 'Попробуйте',
        setupTryDetail: 'Спросите «Что делают мои сессии?». Ваши слова попадут в разговор, как любое сообщение.',
        setupTryAction: 'Попробовать',
        setupTryDone: 'Опробовано',
        setupTryNeedsService: 'Станет доступно, когда сервис будет готов.',
        setupDoneTitle: 'Голос готов',
        setupDoneBody: 'Нажмите кнопку голоса в любом чате, чтобы начать говорить, и ещё раз, чтобы закончить. Пока вы говорите, «Без звука» рядом с «Завершить».',
        setupGestureTap: 'Нажатие',
        setupGestureStartEnd: 'начать · закончить',
        setupGestureAnywhere: 'начать · закончить где угодно',
        setupDoneAction: 'Готово',
        setupSettingsAction: 'Настройки голоса',
        setupClose: 'Закрыть',
        needsYouEnded: 'Голос завершён. Подтверждение всё ещё ждёт во входящих.',
        needsYouReview: 'Просмотреть запрос',
        needsYouTapToDecide: 'Прочитано вслух · решайте здесь, не голосом',
        briefMe: 'Введи в курс',
        briefMeA11y: 'Введи в курс: голос зачитает, что ждёт вас, что не удалось и что готово',
        briefNeedsYou: 'Ждёт вас',
        briefFailed: 'Не удалось',
        briefReady: 'Готово',
        briefIncomplete: 'Ещё не всё загружено, так что это может быть не всё.',
        briefCaughtUp: 'Сейчас ничего не ждёт вас.',
        briefNotSpoken: 'Голос сейчас не может это зачитать. Весь список здесь.',
        briefStop: 'Стоп',
        continueTitle: 'Продолжить разговор здесь',
        continueDetail: ({ device }) => `Вы говорили на ${device}`,
        continueAction: 'Продолжить',
        continuedOn: ({ device }) => `Продолжено на ${device}`,
        continuedElsewhere: 'Продолжено на другом устройстве',
        continuedHere: 'Продолжено на этом устройстве',
        dismiss: 'Скрыть',
    } } satisfies Pick<Readonly<Record<string, VoiceMomentsTranslation>>, "ru">;

return { voiceMomentsTranslations };
})();

const Domain_voicePresenceTranslations = (() => {
type VoicePresenceTranslation = Shared_voicePresenceTranslations.VoicePresenceTranslation;

const voicePresenceTranslations = { ru: {
        welcomeText: "Привет, я слушаю — что вы хотите сделать?",
        greetingLiteralUnavailable: "При этом языке ответа сервис ждёт, пока вы заговорите.",
        title: 'Голос',
        howYouTalk: "Как вы говорите",
        holdToTalkTitle: "Удерживать для разговора",
        holdToTalkDescription: "Удерживайте значок Voice, чтобы сказать одну фразу; отпустите, чтобы отправить. Нажатие по-прежнему запускает и завершает Voice.",
        holdToTalkHint: "Удерживайте один ход; отпустите для отправки. Перетащите для отмены.",
        holdToTalkUnavailable: ({ service }) => `${service} не поддерживает речь с удержанием. Вместо этого нажмите, чтобы говорить.`,
        talkWithVoice: 'Говорить с Голосом',
        dictate: 'Диктовать',
        globalVoice: 'Глобальный Голос',
        interrupt: 'Прервать',
        options: 'Параметры Голоса',
        you: 'Вы',
        showConversation: 'Показать разговор',
        dragToMove: 'Перетащите, чтобы переместить',
        openConversation: 'Открыть разговор',
        settings: 'Настройки Голоса',
        ended: 'Голос завершён',
        muted: 'Звук выключен',
        setUp: 'Настроить Голос',
        setUpHint: 'Открывает настройки Голоса, чтобы выбрать, как он говорит',
        startAgain: 'Начать снова',
        endedCaption: ({ elapsed }) => `${elapsed} · разговор сохранён`,
        dismiss: 'Закрыть',
        mute: "Выкл. микрофон",
        unmute: "Вкл. микрофон",
        end: "Завершить",
        captions: { connecting: "Открываю аудиоканал", listening: "Говорите", transcribing: "Превращаю в текст", thinking: "Готовлю ответ", speaking: "Можно перебить в любой момент", interrupted: "Говорите", muted: "Включите микрофон, чтобы говорить · Голос всё ещё может говорить", reconnecting: "Соединение потеряно · пробую снова", blocked: "Разрешите доступ к микрофону, чтобы говорить", failed: "Попробуйте снова или проверьте настройки Голоса" },
        recovery: { allow: "Разрешить", setUp: "Настроить" },
        containerA11y: ({ status }) => `Голос, ${status}`,
    } } satisfies Pick<Readonly<Record<string, VoicePresenceTranslation>>, "ru">;

return { voicePresenceTranslations };
})();

const Domain_voiceProviderPrivacyTranslations = (() => {
const voiceProviderPrivacyTranslations = { ru: {
    openai: {
      privacyDisclosure: 'Аудио и содержимое разговора отправляются с этого устройства в OpenAI через WebRTC. Когда соответствующие функции включены или используются, OpenAI также может получать с этого устройства ограниченные обновления контекста Voice, вызовы клиентских инструментов и их результаты. Happier использует выбранный сохранённый ключ Voice API, подключённый сервис OpenAI или экспериментальную учётную запись Codex OAuth для получения краткосрочной клиентской авторизации; подключённые учётные записи используются через выбранную машину. OpenAI обрабатывает разговор в выбранной учётной записи и может хранить полученные данные согласно настройкам этой учётной записи и условиям OpenAI. Сервер и relay Happier не передают живое аудио. Настройки передачи контекста Voice отделены от этой обработки провайдером.',
    },
    xai: {
      privacyDisclosure: 'Аудио и содержимое разговора отправляются с этого устройства в xAI через соединение xAI Realtime. Когда соответствующие функции включены или используются, xAI также может получать с этого устройства ограниченные обновления контекста Voice, вызовы клиентских инструментов и их результаты. Happier использует ключ xAI API, сохранённый в секретах вашей учётной записи Happier, только для ограниченных операций клиентской авторизации и каталога голосов. xAI обрабатывает разговор в этой учётной записи и может хранить полученные данные согласно настройкам учётной записи и условиям xAI. Если возобновление включено, Happier сохраняет идентификатор разговора провайдера; забывание удаляет сохранённый в Happier идентификатор и не удаляет данные, хранящиеся в xAI. Сервер и relay Happier не передают живое аудио. Настройки передачи контекста Voice отделены от этой обработки провайдером.',
    },
    speechProcessing: {
      deviceStt: 'Аудио обрабатывается службой распознавания речи браузера или операционной системы. В зависимости от платформы и настроенной службы обработка может выполняться вне устройства.',
      deviceTts: 'Текст ответа обрабатывается службой синтеза речи браузера или операционной системы. В зависимости от платформы и настроенной службы обработка может выполняться вне устройства.',
    },
    fields: {
      resumption: {
        title: 'Сохранять идентификатор возобновления xAI',
        subtitle: 'Разрешить Happier сохранять краткосрочный идентификатор разговора xAI для переподключения.',
      },
    },
    resumption: {
      confirmTitle: 'Сохранить идентификатор возобновления xAI?',
      confirmBody: 'Happier будет хранить идентификатор разговора xAI до {minutes} минут, чтобы прерванный разговор можно было возобновить. Это не изменяет и не удаляет данные в xAI.',
      confirmAction: 'Сохранить идентификатор',
      forgetTitle: 'Забыть идентификатор возобновления в Happier',
      forgetSubtitle: 'Удалить сохранённый в Happier идентификатор разговора провайдера. Это не удаляет разговор или данные, хранящиеся в xAI.',
      forgotten: 'Happier удалил сохранённый идентификатор разговора провайдера.',
      unsupported: 'Happier не может удалить сохранённый идентификатор разговора провайдера из этой сессии.',
      failed: 'Happier не удалось удалить сохранённый идентификатор разговора провайдера. Повторите попытку.',
    },
  } } as const;

return { voiceProviderPrivacyTranslations };
})();

const Domain_voiceReadinessTranslations = (() => {
type VoiceReadinessCopy = Shared_voiceReadinessTranslations.VoiceReadinessCopy;

const defineVoiceReadinessTranslation = Shared_voiceReadinessTranslations.defineVoiceReadinessTranslation;

const voiceReadinessTranslations = { ru: defineVoiceReadinessTranslation({
    ready: 'Голосовой режим готов.',
    permissionAnnouncement: ({ summary }) => `Сеансу разработки требуется разрешение для ${summary}. Проверьте его в интерфейсе сеанса, чтобы разрешить или отклонить.`,
    userActionAnnouncement: ({ question }) => `Сеансу разработки нужен ваш ответ. ${question}`,
    userActionFallback: 'Сеансу разработки нужен ваш ответ. Ответьте на вопрос, чтобы я мог продолжить.',
    requestedTool: 'запрошенный инструмент',
    provider_unselected: 'Выберите голосового провайдера.',
    contribution_unavailable: 'Этот голосовой провайдер больше недоступен.',
    role_unsupported: 'Этот провайдер не поддерживает выбранный голосовой режим.',
    platform_unsupported: 'Этот голосовой провайдер недоступен на этой платформе.',
    settings_unsupported_version: 'Обновите провайдера, прежде чем использовать его в голосовом режиме.',
    settings_unknown: 'Не удалось проверить настройки провайдера.',
    settings_needs_migration: 'Проверьте обновлённые настройки провайдера.',
    settings_invalid: 'Проверьте недопустимые настройки провайдера.',
    settings_missing_required_setting: ({ service }) => `Завершите настройку ${service}, чтобы начать.`,
    provider_mode_unknown: 'Выберите поддерживаемый режим для этого провайдера.',
    server_feature_disabled: 'Сервер отключил этого голосового провайдера.',
    server_feature_installing: 'Сервер подготавливает поддержку голосового режима.',
    server_feature_incompatible: 'Сервер несовместим с этим голосовым провайдером.',
    server_feature_unknown: 'Не удалось проверить поддержку этого голосового провайдера сервером.',
    execution_machine_missing: 'Выберите машину, на которой может работать этот голосовой провайдер.',
    execution_machine_installing: 'Выбранная машина для голосового режима ещё подготавливается.',
    execution_machine_incompatible: 'Выбранная машина несовместима с этим голосовым провайдером.',
    execution_machine_unknown: 'Не удалось проверить машину для голосового режима.',
    daemon_unreachable: 'Для выбранной машины нет доступного маршрута голосового аудио.',
    daemon_relay_disabled: 'Выбранной машине требуется ретранслятор голосового аудио, но его использование отключено.',
    daemon_relay_capped: 'Ёмкость ретранслятора голосового аудио для выбранной машины сейчас недоступна.',
    credential_missing: 'Добавьте учётные данные, необходимые этому голосовому провайдеру.',
    credential_approval_required: 'Проверьте доступ к учётным данным перед использованием этого голосового провайдера.',
    credential_installing: 'Учётные данные провайдера ещё подготавливаются.',
    credential_incompatible: 'Выбранные учётные данные несовместимы с этим голосовым провайдером.',
    credential_unknown: 'Не удалось проверить учётные данные провайдера.',
    endpoint_missing: 'Настройте конечную точку, необходимую этому голосовому провайдеру.',
    endpoint_installing: 'Конечная точка голосового провайдера ещё подготавливается.',
    endpoint_incompatible: 'Настроенная конечная точка несовместима с этим голосовым провайдером.',
    endpoint_unknown: 'Не удалось проверить конечную точку голосового провайдера.',
    runtime_missing: 'Установите среду выполнения, необходимую этому голосовому провайдеру.',
    runtime_installing: 'Среда выполнения голосового провайдера ещё устанавливается.',
    runtime_incompatible: 'Установленная среда выполнения несовместима с этим голосовым провайдером.',
    runtime_unknown: 'Не удалось проверить среду выполнения голосового провайдера.',
    model_missing: 'Установите или выберите модель для этого голосового провайдера.',
    model_installing: 'Выбранная голосовая модель ещё устанавливается.',
    model_incompatible: 'Выбранная модель несовместима с этим голосовым провайдером.',
    model_unknown: 'Не удалось проверить модель голосового провайдера.',
    device_stt_unavailable: 'Распознавание речи недоступно на этом устройстве.',
    device_stt_availability_unknown: 'Доступность распознавания речи всё ещё проверяется.',
    short: {
      needsSetup: 'Нужна настройка',
      needsKey: 'Нужен ключ',
      needsApproval: 'Нужно ваше одобрение',
      offOnServer: 'Выключено на этом сервере',
      needsComputer: 'Нужен компьютер',
      needsAddress: 'Нужен адрес',
      needsModel: 'Нужна модель',
      installing: 'Устанавливается',
      notInstalled: 'Не установлено',
      unavailableHere: 'Здесь недоступно',
      needsUpdate: 'Нужно обновление',
      cantCheck: 'Ещё не проверено',
    },
    actions: {
      select_provider: 'Выбрать провайдера',
      open_provider_settings: "Завершить настройку",
      select_execution_machine: 'Выбрать машину',
      configure_credential: 'Добавить учётные данные',
      review_credential_access: 'Проверить доступ к учётным данным',
      configure_endpoint: 'Настроить конечную точку',
      install_model: 'Установить модель',
      switch_provider: 'Выбрать другого провайдера',
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

const voiceRealtimeProviderSetupTranslations = { ru: defineVoiceRealtimeProviderSetup(voiceProviderPrivacyTranslations["ru"], {
    xai: {
      setup: { footer: 'Ваш ключ API xAI хранится как синхронизированный сохранённый секрет в секретах вашего аккаунта Happier. Он используется только для ограниченной операции xAI Realtime.' },
      credential: { promptBody: 'Вставьте ключ API xAI. Happier защищает его как синхронизированный сохранённый секрет и использует только для ограниченной операции xAI Realtime.' },
    },
    setup: {
      title: 'Настройка голоса в реальном времени',
      footer: 'Ваш ключ API хранится на выбранной машине выполнения и никогда не попадает в синхронизируемые голосовые настройки.',
    },
    credential: {
      title: 'Сохранённый ключ API',
      promptTitle: 'Подключить голос в реальном времени',
      promptBody: 'Вставьте ключ API OpenAI Platform. Он защищён в синхронизируемых секретах вашего аккаунта и используется только при выпуске краткосрочных клиентских данных для Realtime.',
    },
    authentication: {
      sectionTitle: 'Аутентификация OpenAI Realtime',
      title: 'Источник аутентификации',
      subtitle: 'Выберите ровно один источник. Happier никогда не переключается на другой ключ или аккаунт.',
      footer: 'Использование OpenAI Realtime API оплачивается через OpenAI Platform. Подписка ChatGPT или Codex не даёт доступа к Realtime API и не оплачивает его. В разговор по WebRTC передаются только краткосрочные клиентские данные.',
      savedSecret: {
        title: 'Сохранённый голосовой ключ API',
        subtitle: 'Использовать ключ API, сохранённый в секретах аккаунта Happier Voice. Демон не требуется.',
      },
      openAiApiKey: {
        title: 'Подключённый сервис OpenAI',
        subtitle: 'Использовать выбранный стандартный профиль или группу аккаунтов с ключом API OpenAI через выбранную машину и её подключённый демон.',
      },
      openAiCodex: {
        title: 'OpenAI Codex OAuth (экспериментально)',
        subtitle: 'Использовать выбранный профиль или группу аккаунтов Codex OAuth через выбранную машину и её подключённый демон. Happier никогда не переключается на другой ключ или аккаунт.',
      },
      account: {
        title: 'Подключённый аккаунт',
        subtitle: 'Выберите точный профиль или группу аккаунтов для следующего разговора.',
      },
      chooseAccount: 'Выберите аккаунт',
      referenceRequired: 'Выберите подключённый профиль или группу аккаунтов.',
      connected: 'Подключённый аккаунт готов',
      unavailable: 'Выбранный аккаунт недоступен или требует повторного подключения',
    },
    invalidValue: 'Это значение не поддерживается данным провайдером.',
    advanced: { show: 'Показать дополнительные настройки', hide: 'Скрыть дополнительные настройки' },
    fields: {
      model: { title: 'Модель', subtitle: 'Выберите модель голоса в реальном времени.' },
      voice: { title: 'Голос', subtitle: 'Выберите голос для ответов.' },
      instructions: {
        title: 'Голосовые инструкции',
        subtitle: 'Необязательные инструкции по поведению и характеру.',
        promptTitle: 'Голосовые инструкции',
        promptBody: 'Введите необязательные инструкции для этой голосовой сессии.',
      },
      turnDetection: {
        title: 'Определение конца реплики',
        subtitle: 'Выберите, как провайдер определяет конец вашей реплики.',
        threshold: {
          title: 'Порог VAD',
          subtitle: 'Чувствительность к голосовой активности; оставьте пустым для значения провайдера.',
          promptTitle: 'Порог VAD',
          promptBody: 'Введите значение от 0.1 до 0.9 или оставьте пустым.',
        },
        silenceDurationMs: {
          title: 'Длительность тишины',
          subtitle: 'Миллисекунды тишины до завершения реплики.',
          promptTitle: 'Длительность тишины',
          promptBody: 'Введите от 0 до 10000 миллисекунд или оставьте пустым.',
        },
        prefixPaddingMs: {
          title: 'Запас перед речью',
          subtitle: 'Сколько миллисекунд сохраняется до обнаруженной речи.',
          promptTitle: 'Запас перед речью',
          promptBody: 'Введите от 0 до 10000 миллисекунд или оставьте пустым.',
        },
        idleTimeoutMs: {
          title: 'Тайм-аут ответа при простое',
          subtitle: 'При желании попросить xAI начать ответ после такой паузы.',
          promptTitle: 'Тайм-аут ответа при простое',
          promptBody: 'Введите от 1 до 600000 миллисекунд или оставьте пустым, чтобы отключить автоматические ответы при простое.',
          confirmTitle: 'Включить автоматические ответы при простое?',
          confirmBody: 'После заданной паузы xAI может по своей инициативе создать ответ и израсходовать лимиты API.',
          confirmAction: 'Включить',
        },
      },
      transcriptionModel: {
        title: 'Модель транскрипции',
        subtitle: 'Необязательная модель транскрипции входного аудио.',
        promptTitle: 'Модель транскрипции',
        promptBody: 'Введите идентификатор модели или оставьте пустым для значения провайдера.',
      },
      reasoning: { title: 'Рассуждение', subtitle: 'Выберите уровень рассуждения для поддерживаемых моделей.' },
      outputSpeed: {
        title: 'Скорость речи',
        subtitle: 'Настройте скорость речи провайдера.',
        promptTitle: 'Скорость речи',
        promptBody: 'Введите значение от 0.7 до 1.5.',
      },
      languageHint: {
        title: 'Подсказка языка',
        subtitle: 'При желании помогите транскрипции определить ваш язык.',
        promptTitle: 'Подсказка языка',
        promptBody: 'Выберите поддерживаемый язык.',
      },
      keyterms: {
        title: 'Ключевые термины',
        subtitle: 'Имена и предметные термины, которые должна распознавать транскрипция.',
        promptTitle: 'Ключевые термины',
        promptBody: 'Введите до 100 терминов через запятую или с новой строки.',
      },
    },
    options: {
      pinned: 'Закреплённая версия',
      movingAlias: 'Автоматически следует обновлениям провайдера',
      automatic: 'Автоматически',
      custom: 'Свой вариант…',
      server_vad: 'Серверное определение голосовой активности',
      semantic_vad: 'Семантическое определение реплики',
      manual: 'Вручную',
      high: 'Высокий',
      none: 'Нет',
    },
    catalog: {
      credentialRequired: 'Добавьте ключ API, чтобы загрузить голоса',
      retry: 'Не удалось загрузить голоса — повторить',
      empty: 'Для этого аккаунта нет доступных голосов',
      preview: ({ voice }) => `Прослушать ${voice}`,
    },
    movingAlias: {
      confirmTitle: 'Следовать за последней моделью?',
      confirmBody: 'Подвижный псевдоним модели может изменить поведение, когда провайдер её обновит. Вы в любой момент можете вернуться к закреплённой версии.',
      confirmAction: 'Использовать последнюю',
    },
    links: {
      title: 'Ресурсы провайдера',
      account: { title: 'Открыть аккаунт провайдера', subtitle: 'Управляйте своим аккаунтом провайдера.' },
      apiKeys: { title: 'Открыть ключи API', subtitle: 'Создавайте, меняйте или отзывайте ключи API провайдера.' },
      privacy: { title: 'Политика конфиденциальности провайдера', subtitle: 'Узнайте, как провайдер обрабатывает голосовые данные.' },
    },
    disconnect: {
      title: 'Отключить голос в реальном времени',
      subtitle: 'Удалить ключ API этого провайдера с выбранной машины.',
      confirmTitle: 'Отключить провайдера?',
      confirmBody: 'Это удалит сохранённый ключ API с выбранной машины выполнения.',
    },
    unavailable: {
      title: 'Голос в реальном времени недоступен',
      rowTitle: 'Не удалось загрузить настройки',
      provider: 'Компонент провайдера недоступен или несовместим.',
      invalid: 'Сохранённые настройки провайдера некорректны.',
      needs_migration: 'Прежде чем эти настройки можно будет изменить, требуется поддерживаемая миграция.',
      unsupported_version: 'Эти настройки были записаны более новой версией Happier.',
    },
  }) } as const;

return { voiceRealtimeProviderSetupTranslations };
})();

const Domain_voiceSettingsPagesTranslations = (() => {
type VoiceSettingsPagesCopy = Shared_voiceSettingsPagesTranslations.VoiceSettingsPagesCopy;

const en = Shared_voiceSettingsPagesTranslations.en;

const ru: VoiceSettingsPagesCopy = {
  pages: {
    search: {
      chooseService: 'Выберите сервис, чтобы изменить эту настройку.',
      select: ({ choice, control }) => `Выберите ${choice} в разделе «${control}», чтобы изменить эту настройку.`,
    },
    hub: {
      description: 'Говорите с агентами вслух и диктуйте в любое сообщение.',
      modesTitle: 'Два способа использовать голос',
      moreTitle: 'Ещё',
      dictationPurpose: 'микрофон в поле ввода превращает вашу речь в редактируемый текст',
      summarySessionSummaries: 'Сводки сессий',
      summaryRecentMessages: ({ count }) => `последние сообщения: ${count}`,
      summaryNothingShared: 'В начале разговора ничего не передаётся',
      summaryRemembers: 'Агент Voice помнит прошлые разговоры',
      summaryForgets: 'Агент Voice забывает после каждого разговора',
      summaryVoiceComputer: ({ machine }) => `Компьютер Voice: ${machine}`,
      summaryTranscript: 'расшифровка во время разговора',
    },
    pipeline: {
      hear: 'Слышит',
      think: 'Думает',
      speak: 'Говорит',
      write: 'Пишет',
      ready: 'Готово',
      oneStepNeedsYou: 'Один шаг требует вашего внимания',
      stepsNeedYou: ({ count }) => `Шагов требуют вашего внимания: ${count}`,
      waiting: 'Ожидание',
      working: 'Выполняется',
      notChecked: 'Ещё не проверено',
      off: 'Выключено · диктовка остаётся доступной',
      onMachine: ({ machine }) => `На ${machine}`,
      onVoiceComputer: 'На вашем компьютере Voice',
      inTheCloud: 'В облаке сервиса, с этого устройства',
      inTheSession: 'Отвечает её собственный агент, в расшифровке',
      intoYourMessage: 'Вы проверяете перед отправкой',
      messageLanguage: ({ language }) => `Язык: ${language}`,
      languageAutomatic: 'автоматически',
      onThisDevice: 'На этом устройстве',
      needsYou: 'Требует вашего внимания',
      voiceAgentFollowsSession: 'Агент Voice · следует за сессией',
      theSessionYoureIn: 'Сессия, в которой вы',
      intoYourMessageTitle: 'В ваше сообщение',
    },
    privacy: {
      localAudio: "Ваше устройство или компьютер Voice",
      localProcessor: "Выбранная речевая модель",
      localRetention: "Хранением управляет устройство или среда выполнения. Диагностика следует настройкам записи.",
      localDisclosure: "Выбранные речевые модели работают на вашем устройстве или компьютере Voice. История Voice и диагностические записи настраиваются отдельно на этой странице.",
      audioTitle: "Аудио отправляется",
      processorTitle: "Обрабатывает",
      retentionTitle: "Хранение",
      messagesUnit: "сообщений",
      secondsUnit: "секунд",
      servicePolicy: "По настройкам и условиям аккаунта сервиса.",
      noMicrophoneAudio: "Без аудио микрофона; только текст ответа.",
      yourEndpoint: "Настроенный вами адрес",
      endpointOperator: "Оператор вашего сервиса",
      endpointPolicy: "По политике хранения вашего сервиса.",
      deviceAudio: "Речевой сервис устройства",
      deviceProcessor: "Устройство или его речевой сервис",
      devicePolicy: "По настройкам и условиям речевого сервиса устройства.",
      description: 'Что ваш голосовой сервис слышит и читает и что хранит Happier.',
      whereTitle: 'Куда сейчас уходит ваш голос',
      whereDescription: 'Зависит от выбранного сервиса.',
      startTitle: 'Когда начинается разговор',
      startDescription: 'Что голосовой сервис может прочитать о вашей работе.',
      screenTitle: 'Что на вашем экране',
      screenDescription: 'Какую сессию или страницу вы смотрите.',
      screenNever: 'Никогда',
      screenWhenAsked: 'По запросу',
      screenAlways: 'Всегда',
      summariesTitle: 'Сводки сессий',
      recentTitle: 'Ваши последние сообщения',
      recentDescription: 'Последние сообщения сессии, когда он просит контекст.',
      recentCountTitle: 'Сколько сообщений передавать',
      recentCountDescription: "",
      recentCountUnavailable: 'Включите «Ваши последние сообщения», чтобы изменить это.',
      toolsTitle: 'Названия инструментов',
      toolsDescription: 'Например, «Изменён файл». Аргументы и пути к файлам никогда не передаются.',
      permissionsTitle: 'Запросы разрешений',
      permissionsDescription: 'Чтобы он мог сказать, что требует вашего внимания. Одобряете вы по-прежнему касанием.',
      devicesTitle: 'Ваши машины и устройства',
      devicesDescription: 'Названия и статус в сети, чтобы запускать сессии там, где вы попросите.',
      liveTitle: 'Пока вы говорите',
      liveDescription: 'Обновления, которые отправляются, когда ваши сессии меняются во время разговора.',
      liveActiveTitle: 'Из сессии, в которой вы',
      liveOtherTitle: 'Из других ваших сессий',
      liveNothing: 'Ничего',
      liveActivity: 'Активность',
      liveSummaries: 'Сводки',
      liveMessages: 'Сообщения',
      livePerUpdateTitle: 'Сообщений на обновление',
      liveIncludeMineTitle: 'Включать то, что вы написали',
      liveIncludeMineDescription: 'Выключено: отправляется только сторона агента.',
      liveMessagesUnavailable: 'Выберите «Сообщения» для сессии выше, чтобы изменить это.',
      liveOtherModeTitle: 'Сообщения из других сессий',
      liveOtherModeNever: 'Никогда',
      liveOtherModeWhenAsked: 'По запросу',
      liveOtherModeAutomatically: 'Автоматически',
      liveOtherModeUnavailable: 'Выберите «Сообщения» для других сессий, чтобы изменить это.',
      memoryTitle: 'Память агента Voice',
      memoryDescription: 'Только для локального голоса с агентом Voice.',
      rememberTitle: 'Помнить прошлые разговоры',
      rememberOnDescription: 'Продолжает с того места, где вы остановились.',
      rememberOffDescription: 'Выключено: забывает всё, когда вы кладёте трубку.',
      restoreTitle: 'Восстанавливать память через',
      restoreRecent: 'Последние сообщения',
      restoreSummary: 'Сводка + последние',
      restoreResume: 'Возобновление агента',
      restoreUnavailable: 'Включите «Помнить», чтобы выбрать.',
      restoreResumeFeatureOff: 'Для возобновления нужен включённый на этом сервере агент Voice.',
      restoreResumeAgentCannot: 'Этот агент не умеет возобновлять прошлый разговор.',
      fallbackTitle: 'Если возобновить не удалось, воспроизвести сообщения',
      fallbackDescription: 'Начинает с ваших последних сообщений, а не с нуля.',
      restoreCountTitle: 'Сколько сообщений восстанавливать',
      restoreCountDescription: "",
      forgetTitle: 'Забыть всё сейчас',
      forgetDescription: 'Запускает агента Voice заново. Ваши сессии не затрагиваются.',
      forgetAction: 'Забыть',
      moreTitle: 'Ещё',
    },
    dictation: {
      description: 'Микрофон в поле ввода превращает вашу речь в текст, который можно поправить перед отправкой.',
      engineTitle: 'Речевой движок',
      engineDescription: 'Каждый движок показывает, куда уходит ваш звук.',
      sameAsConversations: 'Как в голосовых разговорах',
      sameAsConversationsUses: ({ engine }) => `Использует ${engine}, как ваши голосовые разговоры.`,
      languageTitle: 'Язык',
      dictateInTitle: 'Я диктую на',
      dictateInDescription: 'Автоматически используется язык движка по умолчанию. Он не зависит от языка разговоров.',
      pipelinePurpose: 'работает, даже когда голосовые разговоры выключены',
    },
    conversations: {
      description: 'Говорите с агентами вслух — с руками на клавиатуре или без.',
      serviceTitle: 'Сервис',
      serviceDescription: 'Кто вас слышит, думает и говорит. Менять можно в любой момент; у каждого своя настройка.',
      offDescription: 'Без голосовых разговоров. Диктовка остаётся доступной.',
      serviceReady: 'Готово',
      accountTitle: 'Аккаунт',
      accountDescription: 'Это тот же сервис в обоих случаях; меняется только, кто платит.',
      payWithTitle: 'Оплата через',
      happierBillingUnavailable: "Оплата через Happier недоступна на этом сервере.",
      turnOnVoiceAgent: "Включить голосового агента",
      payWithHappierDescription: 'Покрывается вашим планом Happier. Своя учётная запись не нужна.',
      payWithOwnDescription: 'Вы используете свою учётную запись и API-ключ этого сервиса.',
      runsOn: 'Работает на',
      hearTitle: 'Слышит',
      hearDescription: 'Как ваша речь превращается в текст перед ответом.',
      speechRecognitionTitle: 'Распознавание речи',
      handsFreeUnsupported: 'Режиму без рук нужно распознавание речи на этом устройстве или речевая модель Happier.',
      handsFreeTimingUnavailable: 'Включите режим без рук, чтобы изменить это.',
      interruptTitle: 'Перебивать голосом',
      interruptDescription: 'Если заговорить во время ответа, он остановится.',
      talkToTitle: 'Говорить с',
      talkToSession: 'Сессией',
      talkToSessionDescription: 'Вы говорите в текущую сессию; отвечает её собственный агент.',
      talkToAgent: 'Агентом Voice',
      talkToAgentDescription: 'Агент Voice читает ваши сессии и действует за вас.',
      agentFeatureRequired: ({ feature }) => `Включите ${feature} в Настройки → Функции. Для экспериментальных функций также включите Эксперименты.`,
      itMayTitle: 'Ему можно',
      itMayReadOnly: 'Только читать',
      itMayReadOnlyDescription: 'Он читает сессии и файлы и ничего не меняет.',
      itMayAsk: 'Сначала спрашивать',
      itMayAskDescription: 'Каждое изменение сначала спрашивает вас. Сказанное вслух «да» никогда не одобряет — вы касаетесь.',
      itMaySafe: 'Безопасные изменения',
      itMaySafeDescription: 'Сам вносит безопасные изменения в рабочую область, об остальном спрашивает.',
      itMayAnything: 'Всё',
      itMayAnythingDescription: 'Может вносить любые изменения, не спрашивая вас.',
      repliesTitle: 'Ответы',
      repliesShort: 'Короткие',
      repliesBalanced: 'Сбалансированные',
      thinkTitle: 'Думает',
      thinkDescription: 'Что происходит с тем, что вы говорите.',
      advancedAgentTitle: 'Расширенное поведение агента',
      advancedAgentDescription: 'Как агент Voice запускается, ждёт и отвечает. Значения по умолчанию подходят большинству.',
      memoryLinkTitle: 'Память и восстановление',
      memoryLinkDescription: 'Помнит ли он прошлые разговоры, настраивается в разделе «Конфиденциальность и данные».',
      speakTitle: 'Говорит',
      speakDescription: 'Как ответы зачитываются вслух.',
      voiceEngineTitle: 'Голосовой движок',
      languageTitle: 'Язык',
      languageDescription: 'Что меняет каждый язык для выбранного сервиса.',
      iSpeakTitle: 'Я говорю на',
      iSpeakDescription: 'Помогает вас понимать. «Автоматически» определяет язык каждый раз.',
      replyInTitle: 'Отвечать на',
      replyInDescription: 'Ответ приходит на этом языке, даже если вы переключитесь.',
      replySame: 'Как я говорю',
      iSpeakAutomatic: 'Автоматически',
      iSpeakEngineDescription: ({ engine }) => `Помогает ${engine} понимать вас. Настраивается в распознавании речи в разделе «Слышит».`,
      voiceTitle: 'Голос',
      voiceDescription: ({ engine }) => `От ${engine}, движка в разделе «Говорит».`,
      voiceDefault: 'По умолчанию',
      voiceDevice: 'Голос этого устройства',
      voiceInEngine: 'Настраивается в разделе «Говорит»',
      languageServiceDescription: 'Язык, на котором отвечает ваш голосовой сервис.',
      languageAutomaticDescription: 'Голосовой сервис определяет язык вашей речи.',
      languageEngineDefault: 'По умолчанию движка',
      languageCoupledDescription: 'Голосовой сервис использует один язык для распознавания и ответов.',
      greetingTitle: 'Приветствие',
      greetingOff: 'Выкл.',
      greetingRightAway: 'Сразу',
      greetingAfterISpeak: 'После моей фразы',
      greetingOffDescription: 'Ждёт, пока вы заговорите первым.',
      greetingRightAwayDescription: 'Здоровается, как только начинается разговор.',
      greetingAfterISpeakDescription: 'Здоровается в первом ответе.',
      languageManagedDescription: 'Язык задаёт ваш голосовой сервис.',
      languageServiceDefault: 'По умолчанию сервиса',
    },
    advanced: {
      description: 'Где работает голос, как он выглядит на экране и какие речевые модели использует.',
      onScreenTitle: 'На экране',
      onScreenDescription: 'Как выглядит идущий разговор.',
      showLiveAsTitle: 'Показывать Voice в разговоре как',
      showLiveAsDescription: 'Только на этом устройстве. Раздел Voice в Companion остаётся в любом режиме.',
      scopeTitle: 'Начинать разговоры с',
      scopeGlobal: 'Всеми моими сессиями',
      scopeGlobalDescription: 'Один помощник для всего.',
      scopeSession: 'Открытой сессией',
      scopeSessionDescription: 'Начинается внутри открытой у вас сессии.',
      transcriptTitle: 'Показывать расшифровку во время разговора',
      transcriptDescription: 'То, что говорите вы и агент, появляется по ходу разговора.',
      autoOpenTitle: 'Открывать её в начале разговора',
      autoOpenDescription: 'Выключено: откройте её сами из разговора.',
      autoOpenUnavailable: 'Включите «Показывать расшифровку», чтобы выбрать.',
      computerTitle: 'Компьютер Voice',
      speechModelsTitle: 'Речевые модели',
      speechModelsNeedComputerTitle: 'Нужен компьютер Voice',
      speechModelsNeedComputer: 'Выберите компьютер Voice выше, чтобы устанавливать его речевые модели и управлять ими.',
      computerDescription: 'Компьютер, на котором работают речевые модели и который входит в подключённые аккаунты для голоса. Общий для ваших устройств.',
      connectionTitle: 'Соединение',
      timeoutTitle: 'Прекращать речевой запрос через',
      timeoutDescription: "Для адресов сервисов и речевых моделей.",
    },
  },
};

const voiceSettingsPagesTranslations = { ru } as const satisfies Pick<Record<string, VoiceSettingsPagesCopy>, "ru">;

return { voiceSettingsPagesTranslations };
})();

const Domain_walkthroughProgressTranslations = (() => {
type Parts = Shared_walkthroughProgressTranslations.Parts;

const walkthroughProgressTranslations = { 'ru': { parts: ({ completed, total, admitted }: Parts) => `${completed}/${total} частей завершено · ${admitted} принято`, merge: 'Обзор объединяется…', titleEdited: 'Название изменено', changed: 'Изменено', moved: 'Перемещено', filesReadUnavailable: 'Прогресс чтения файлов недоступен' } };

return { walkthroughProgressTranslations };
})();

const Domain_walkthroughSavedTranslations = (() => {
type SavedCopy = Shared_walkthroughSavedTranslations.SavedCopy;

const en = Shared_walkthroughSavedTranslations.en;

const walkthroughSavedTranslations = { ru: { edit: 'Редактировать обзор', title: 'Название обзора', stopTitle: 'Название этапа', prose: 'Объяснение', refine: 'Уточнить', instructions: 'Что нужно изменить?', moveUp: 'Переместить выше', moveDown: 'Переместить ниже', mergeNext: 'Объединить со следующим этапом', addSummary: 'Добавить сводку', addCommitPlan: 'Предложить коммиты', updated: 'Сохранённый результат обновлён', conflict: 'Этот обзор изменён в другом месте. Ваш черновик сохранён. Загрузите последнюю версию и проверьте её перед повторным сохранением.', reload: 'Загрузить последнюю версию', missingStop: "Этого этапа больше нет в последней версии обзора. Черновик сохранён; выберите другой этап, чтобы продолжить.", applicationLocked: 'Выполняются коммиты. Редактирование приостановлено.' } } satisfies Pick<Record<string, SavedCopy>, "ru">;

return { walkthroughSavedTranslations };
})();

const Domain_walkthroughSettingsTranslations = (() => {
type Copy = Shared_walkthroughSettingsTranslations.Copy;

const en = Shared_walkthroughSettingsTranslations.en;

const copy = Shared_walkthroughSettingsTranslations.copy;

const walkthroughSettingsTranslations = { ru: copy({
        title: 'Обзоры изменений',
        description: 'ИИ предлагает порядок чтения, добавляет объяснения рядом с конкретными изменениями и при необходимости предлагает коммиты. Выполняется на машине, где находится код.',
        enabled: 'Объяснять изменения',
        enabledDescription: 'Добавляет порядок чтения и объяснения к сравнению. Файлы доступны и без модели.',
        model: 'Модель сводки',
        modelDescription: 'Используется для объяснений, обзоров изменений и предложений коммитов.',
        chooseModel: 'Выбрать модель',
        unsupported: 'Не может писать обзоры изменений',
        unavailable: 'Модель недоступна. Выберите другую.',
        prefetch: 'Готовить после каждого хода',
        prefetchDescription: 'Готовит обзор изменений, когда агент завершает ход.',
        saved: 'Сохранённые обзоры',
        savedDescription: 'Сохранены на этой машине, включая ваши правки.',
        clear: 'Очистить',
        unavailableData: 'Подключите машину повторно, чтобы загрузить сохранённые обзоры и данные о расходах.',
        costUnavailable: 'За последние 7 дней · стоимость недоступна',
        clearTitle: 'Удалить сохранённые обзоры?',
        clearDescription: ({ machine }) => `Удаляет сохранённые обзоры и ваши ручные правки на ${machine}, а также ваши отметки проверки этих сравнений. Другие машины не затрагиваются.`,
        savedCount: ({ count, bytes }) => `${count} сохранено · ${bytes}`,
        cost: ({ amount, partial }) => `За последние 7 дней · ${amount}${partial ? ' · часть данных о расходах недоступна' : ''}`,
        clearFailed: 'Не удалось удалить некоторые обзоры. Обновите и попробуйте снова.',
    }) };

return { walkthroughSettingsTranslations };
})();

const Domain_walkthroughStartTranslations = (() => {
const walkthroughStartTranslations = { ru: { walkthroughStart: { start: 'Начать разбор', ended: 'Этот разговор здесь недоступен. Разбор сохранён.', newConversation: 'Начать новый разговор', askSession: 'Спросить агента сессии', unavailable: 'Подключите машину и выберите модель со структурированным выводом.', updated: 'Разбор обновлён' } } };

return { walkthroughStartTranslations };
})();

const Domain_walkthroughTranslations = (() => {
type WalkthroughTranslations = Shared_walkthroughTranslations.WalkthroughTranslations;

const walkthroughSavedTranslations = {...Domain_walkthroughSavedTranslations.walkthroughSavedTranslations, ...EnglishFeatures.walkthroughSavedTranslations.walkthroughSavedTranslations};

const walkthroughProgressTranslations = {...Domain_walkthroughProgressTranslations.walkthroughProgressTranslations, ...EnglishFeatures.walkthroughProgressTranslations.walkthroughProgressTranslations};

const en = Shared_walkthroughTranslations.en;

const translated = Shared_walkthroughTranslations.translated;

const walkthroughTranslations = { ru: {
        walkthrough: translated({
            saved: walkthroughSavedTranslations.ru,
            progress: walkthroughProgressTranslations.ru,
            eyebrow: 'Обзор',
            generated: 'Сгенерировано',
            generatedBy: ({ model }) => `Сгенерировано · ${model}`,
            generatedA11y: 'Написано моделью',
            readingChanges: 'Читаем изменения…',
            modelFallback: 'Модель',
            analysisAll: ({ who, count }) => `${who} прочитала все ${count}`,
            analysisSome: ({ who, analysed, total }) => `${who} прочитала ${analysed} из ${total}`,
            analysisStopped: ({ who, analysed, total }) => `${who} прочитала ${analysed} из ${total} и остановилась`,
            unavailableCount: ({ count }) => `${count} недоступно`,
            youReviewed: ({ count, total }) => `Вы просмотрели ${count} из ${total}`,
            contents: 'Содержание',
            reviewedOfTotal: ({ count, total }) => `${count} из ${total} просмотрено`,
            boardReadProgress: ({ count, total }) => `${count} из ${total} прочитано`,
            stopOf: ({ number, total }) => `${number} из ${total}`,
            stopA11y: ({ number, title }) => `Остановка ${number}: ${title}`,
            stopReviewedA11y: ({ number }) => `Остановка ${number}, просмотрена`,
            importance: { start: 'Начните здесь', high: 'Читайте внимательно', low: 'Бегло' },
            markReviewed: 'Отметить просмотренной',
            reviewed: 'Просмотрено',
            markReviewedA11y: 'Отметить эту остановку просмотренной',
            unmarkReviewedA11y: 'Просмотрено. Нажмите, чтобы снять отметку',
            askAboutThis: 'Спросить об этом',
            askAboutStopA11y: 'Спросить об этой остановке',
            openConversation: 'Открыть разговор об обзоре',
            andIn: ({ file }) => `и в ${file}`,
            newFile: 'Новый файл',
            deletedFile: 'Удалён',
            openInFiles: ({ file }) => `Открыть ${file} в Файлах`,
            otherChanges: 'Другие изменения',
            otherChangesDescription: 'Не часть истории, но они здесь. Откройте их как обычный diff.',
            otherChangesCue: 'Механические, показаны как diff',
            keys: { move: 'перейти', reviewed: 'просмотрено', ask: 'спросить' },
            overview: 'Обзор кода',
            codeMapOf: ({ count }) => `Карта кода: ${count} файлов`,
            codeMapHint: 'наведите на остановку, чтобы выделить её файлы',
            touchesOutlined: 'затрагивает выделенные файлы',
            showOverviewA11y: ({ count }) => `Показать обзор: карта кода ${count} файлов`,
            inventory: { title: 'Всё в этом сравнении · уже доступно в Файлах', read: 'Прочитано', reading: 'Читается', unavailable: 'Недоступно' },
            arriving: 'Следующие остановки появятся здесь по мере написания.',
            previousStop: 'Предыдущая остановка',
            nextStop: 'Следующая остановка',
            done: 'Готово',
            evidence: { displayFailed: 'Не удалось показать сохранённый код. Файл остаётся в разделе «Файлы».', binary: 'Двоичный файл, описан по метаданным. Показан, не проанализирован.', unavailable: ({ reason }) => `Не удалось прочитать (${reason}). Он остаётся в списке; здесь не утверждается, что он просмотрен.` },
            notice: {
                stale: 'Файлы изменились после написания',
                refresh: 'Обновить обзор',
                failed: ({ reason }) => `Написание остановлено · ${reason}`,
                failedGeneric: 'Написание остановлено',
                tryAgain: 'Повторить',
                chooseModel: 'Выбрать модель',
                cancelled: 'Написание остановлено. Написанное сохраняется.',
                rest: 'Остальное не было написано. Все файлы есть в Файлах; ничего не пропущено молча.',
                offline: ({ machine, time }) => `${machine} не в сети · показаны обзор и код на ${time}. Вопросы и обновление вернутся после подключения.`,
                offlineA11y: 'Нужна машина, которая не в сети',
                incomplete: 'Некоторые изменения не удалось перечислить. Показанное точно; полноты никто не утверждает.',
                undo: 'Отменить',
            },
            none: { title: 'Обзора пока нет', reason: 'Обзор читает эти изменения по порядку и объясняет каждое рядом с точным кодом. Все файлы уже есть в Файлах.', showFiles: 'Показать файлы' },
            explain: { notInStory: 'Не часть истории', readInWalkthrough: 'Читать в обзоре' },
        }),
    } };

return { walkthroughTranslations };
})();

const Domain_widgetAddTranslations = (() => {
type WidgetAddTranslation = Shared_widgetAddTranslations.WidgetAddTranslation;

const inSentence = Shared_widgetAddTranslations.inSentence;

const widgetAddTranslations = { ru: {
        viewGallery: 'Галерея',
        viewList: 'Список',
        viewLabel: 'Вид',
        added: 'Добавлено',
        boardTitle: 'Добавить на доску',
        boardHint: 'Все здесь увидят то, что вы добавите',
        companionTitle: 'Добавить в компаньон',
        companionHint: 'Ваш компаньон видите только вы',
        searchWidgets: 'Поиск виджетов',
        searchCompanion: 'Поиск сводок и панелей',
        fromPlugins: 'Из плагинов',
        fromPluginsHint: 'вживую, с данными этой сессии',
        makeOne: 'Создать',
        noteSubtitle: 'Markdown',
        interactiveViewSubtitle: 'HTML',
        findMore: 'Найти другие виджеты',
        findMoreSubtitle: 'Плагины',
        askTitle: 'Попросить агента сделать виджет',
        askNote: 'Черновик появится в поле ввода; ничего не отправится, пока вы не отправите.',
        glances: 'Сводки',
        glancesHint: 'вживую, встроенные или из плагинов',
        onBoard: 'На этой доске',
        onBoardHint: 'видно всем здесь',
        panes: 'Панели',
        panesHint: 'добавляется как ссылка, открывающаяся в «Подробностях»',
        builtIn: 'Встроенное',
        nativeDescriptions: {
            session_summary: 'Активность и следующие шаги выбранной сессии.',
            agent_plan: 'Следите за планом агента для выбранной сессии.',
            changes: 'Просматривайте изменения файлов в выбранной сессии.',
            local_services: 'Открывайте локальные сервисы выбранной сессии.',
        },
        noMatch: ({ query }) => `Нет виджетов по запросу «${query}»`,
        setupTitle: ({ widget }) => `Настроить: ${widget}`,
        editTitle: ({ widget }) => `${widget} · входные данные`,
        editHint: 'Изменится только эта копия. Остальные сохранят свои данные.',
        preview: 'Предпросмотр',
        previewLive: 'Предпросмотр · вживую',
        previewWaiting: ({ field }) => `Выберите «${field}», чтобы увидеть здесь`,
        previewAfterAdd: 'Появится здесь после добавления',
        backToGallery: 'Назад в галерею',
        needed: 'Нужно',
        stillNeeded: ({ field }) => `Ещё нужно: ${field}`,
        followGroup: 'Следовать',
        pinGroup: 'Или закрепить одно',
        another: 'Другое…',
        anotherSubtitle: 'Искать среди всего, к чему у вас есть доступ',
        searchChoices: ({ field }) => `Искать: ${field}`,
        noChoices: 'Пока не из чего выбрать',
        optionsLoading: 'Загрузка вариантов…',
        optionsFailed: 'Не удалось загрузить варианты',
        invalidValue: 'не найдено',
        inputsInvalid: 'Проверьте входные данные этого виджета',
        inputsUnavailable: 'Выбранные входные данные недоступны',
        connectionNeeded: ({ field }) => `Подключите свой ${field}`,
        sessionDenied: ({ session }) => `У вас больше нет доступа к ${session}`,
        sessionUnavailable: ({ session }) => `${session} недоступна или удалена`,
        typeUnavailable: ({ field }) => `Тип для ${field} больше недоступен`,
        inputUnavailable: ({ field }) => `${field} недоступно`,
        selectedInputUnavailable: ({ field, value }) => `${field}: ${value} больше недоступно`,
        invalidReason: 'У вас больше нет доступа, или это удалено.',
        viewerOnly: 'Здесь каждый видит это через своё подключение.',
        justAdded: ({ widget }) => `Добавлено: ${widget}`,
        saved: ({ widget }) => `Сохранено: ${widget}`,
        addFailed: 'Не удалось добавить. Попробуйте ещё раз.',
        saveFailed: 'Не удалось сохранить. Попробуйте ещё раз.',
        homeTitle: 'Добавить на главную',
        homeHint: 'Только вы видите свою главную · на всех устройствах',
        homeFromPluginsHint: 'вживую, с вашими данными',
        addWidgets: 'Добавить виджеты',
        addToHome: 'Добавить на главную',
        addToBoard: 'Добавить на доску',
        addToCompanion: 'Добавить в компаньон',
        editInputs: 'Изменить входные данные…',
        width: 'Ширина',
        size: 'Размер',
        sizes: { small: 'Малый', medium: 'Средний', wide: 'Широкий', full: 'Полный', tall: 'Высокий', large: 'Большой' },
        widthHalf: 'Половина',
        widthFull: 'Полная',
        thisSession: 'Этот сеанс',
        choicesCount: ({ count }) => `Вариантов: ${count}`,
        countOnHome: ({ count }) => `На главной: ${count}`,
        countOnBoard: ({ count }) => `На доске: ${count}`,
        countInCompanion: ({ count }) => `В компаньоне: ${count}`,
        thisPage: 'Эта страница',
        thisProject: 'Этот проект',
        thisCheckout: 'Эта рабочая копия',
        areaPinned: 'Закреплённые',
        areaPinnedMeta: 'ваши виджеты на этой странице',
        areaProjectTitle: 'Виджеты',
        areaProjectMeta: 'ваши',
        areaAdd: ({ surface }) => `Добавить виджет в ${surface}`,
        areaAddTo: ({ surface }) => `Добавить в ${surface}`,
        areaHint: 'Эти виджеты видите только вы',
        countHere: ({ count }) => `Здесь: ${count}`,
        areaEmptyTitle: 'Пока ничего не закреплено',
        areaEmptyReason: 'Закрепите виджет, чтобы он оставался здесь — только для вас.',
        areaEmptyAction: 'Добавить виджет',
        areaUnavailableTitle: 'Здесь не удаётся загрузить виджеты',
        projectSourceUnavailableTitle: 'Виджеты появятся здесь, когда станет известен репозиторий этого проекта',
        areaWriteFailed: 'Не удалось сохранить это изменение',
        areaApprovalPending: 'Ожидает одобрения',
        valueNotFound: ({ value }) => `Не удаётся найти: ${value}`,
        chooseAnother: ({ field }) => `Выбрать другое значение: ${field}`,
        chooseField: ({ field }) => `Выбрать: ${field}`,
        widgetOptions: 'Параметры виджета',
        moveTo: 'Переместить…',
    } } satisfies Pick<Readonly<Record<string, WidgetAddTranslation>>, "ru">;

return { widgetAddTranslations };
})();

const Domain_widgetDefinitionTranslations = (() => {
type WidgetDefinitionTranslation = Shared_widgetDefinitionTranslations.WidgetDefinitionTranslation;

const widgetDefinitionTranslations = { ru: {
        yourWidgets: "Ваши виджеты",
        yourWidgetsHint: "созданы вами или вашими агентами",
        yourWidget: "Ваш виджет",
        moreInSource: "В источнике больше данных, чем показано.",
        notCurrent: "Не актуально",
        aboutMenu: "Об этом виджете",
        aboutTitle: "Об этом виджете",
        aboutUnavailable: "Сейчас не удаётся открыть этот виджет.",
        aboutData: "Данные",
        aboutReads: "Читает",
        aboutInputs: "Входные данные",
        aboutRefresh: "Обновление",
        aboutUsedIn: "Используется",
        savedFromSession: ({ session }) => `Сохранено из ${session}`,
        aSession: "сессии",
        madeInYourAccount: "Создано в вашем аккаунте",
        edited: ({ time }) => `изменено ${time}`,
        readsOnly: "Только чтение",
        runsOn: ({ machine }) => `работает на ${machine}`,
        withYourConnection: "с вашим собственным подключением",
        readsResource: ({ read, plugin }) => `${read} из ${plugin}`,
        cannotRunAnythingElse: "Виджет не может запускать ничего другого.",
        inputsThisCopy: "Только для этой копии",
        refreshWhenOpen: "При открытии",
        refreshNow: "Обновить сейчас",
        refreshing: "Обновление…",
        refreshed: "Обновлено",
        refreshFailed: "Не удалось обновить. Остаются последние значения.",
        placedOnHome: "Главная",
        placedOnBoard: ({ board }) => `Доска ${board}`,
        placedOnABoard: "Доска",
        placedInASession: "Сессия",
        placedInAProject: "Проект",
        placedOnAPluginPage: "Страница плагина",
        notPlacedYet: "Пока нигде не размещён",
        otherPlacesNotListed: "Места на других устройствах или общих поверхностях здесь не показаны.",
        editsChangeAll: ({ count }) => `Изменения виджета затронут все (${count})`,
        editsChangeEverywhere: "Изменения виджета затронут все места, где он используется",
        changeWithAgent: "Изменить с агентом",
        changeDraft: ({ widget }) => `Измени виджет «${widget}» так, чтобы `,
        duplicate: "Дублировать",
        duplicated: ({ name }) => `Копия «${name}» сохранена в «Ваши виджеты»`,
        duplicateFailed: "Не удалось создать копию. Попробуйте ещё раз.",
        saveMenu: "Сохранить как свой виджет…",
        saveMenuSubtitle: "Копия для главной и ваших досок",
        saveTitle: "Сохранить как свой виджет",
        saveHint: "Копия для главной, ваших досок и проектов. В этой сессии останется свой.",
        saveNote: "Сохраняется в вашем аккаунте · только для вас",
        saveWidget: "Сохранить виджет",
        saveFailed: "Не удалось сохранить виджет. Попробуйте ещё раз.",
        savedButNotPlaced: "Сохранено в «Ваши виджеты», но добавить во все выбранные места не удалось.",
        savedAsYours: ({ name }) => `«${name}» сохранён в «Ваши виджеты»`,
        name: "Название",
        nameNeeded: "Дайте ему название",
        becomesViewerInput: "Станет входным параметром: каждое место использует ваше подключение",
        becomesContextInput: "Станет входным параметром: каждое место выбирает своё",
        alsoAddTo: "Также добавить в",
        alsoAddToNamed: ({ place }) => `Также добавить в ${place}`,
        snapshotMenu: "Опубликовать снимок на этой доске…",
        snapshotMenuSubtitle: "Все здесь увидят ваши текущие цифры",
        snapshotTitle: "Опубликовать снимок для всех?",
        snapshotHint: ({ widget, time }) => `Все, кто может открыть эту сессию, увидят ${widget} на ${time}. Снимок не обновляется, а ваше подключение остаётся вашим.`,
        postSnapshot: "Опубликовать снимок",
        snapshotNotCurrent: "Виджет ещё получает актуальные цифры. Попробуйте, когда они появятся.",
        snapshotFailed: "Не удалось опубликовать снимок. Ничего не передано.",
        snapshotAwaitingApproval: "Ожидает одобрения во входящих. До одобрения ничего не передаётся.",
        snapshotPosted: "Снимок опубликован",
        snapshotNote: "Копия этих цифр. Она не обновляется.",
        asOf: ({ time }) => `на ${time}`,
    } } satisfies Pick<Readonly<Record<string, WidgetDefinitionTranslation>>, "ru">;

return { widgetDefinitionTranslations };
})();

const Domain_widgetFrameTranslations = (() => {
type WidgetFrameTranslation = Shared_widgetFrameTranslations.WidgetFrameTranslation;

const widgetFrameTranslations = { ru: {
        styleCard: 'Карточка',
        stylePlain: 'Без рамки',
        surfaceHome: 'Главная',
        surfaceBoard: 'Доска',
        surfaceCompanion: 'Компаньон',
        showFrame: 'Показать рамку',
        hideFrame: 'Скрыть рамку',
        thisWidgetOnly: 'Только этот виджет',
        surfaceUses: ({ surface, style }) => `${surface}: ${style}`,
        useSurfaceDefault: ({ surface }) => `Как по умолчанию: ${surface}`,
        likeTheOthers: ({ style }) => `${style}, как у остальных`,
        appearanceTitle: 'Виджеты',
        appearanceDescription: 'Как виджеты оформлены на этом устройстве. Чтобы изменить один виджет, откройте его меню ⋯.',
        previewLabel: ({ surface, style }) => `${surface} · ${style}`,
        noticeChanged: 'Рамка изменена',
        addViewTitle: 'Добавление виджетов',
        addViewDescription: 'Как открывается меню «Добавить». Если переключить его там, изменится и здесь.',
        newChip: 'Новое',
    } } satisfies Pick<Readonly<Record<string, WidgetFrameTranslation>>, "ru">;

return { widgetFrameTranslations };
})();

const Domain_widgetGlanceTranslations = (() => {
type WidgetGlanceTranslation = Shared_widgetGlanceTranslations.WidgetGlanceTranslation;

const widgetGlanceTranslations = { ru: {
        changesTitle: 'Изменения',
        localServicesTitle: 'Локальные сервисы',
        changesSource: 'Git',
        reviewChanges: 'Просмотреть изменения',
        notARepo: 'Папка этой сессии не является репозиторием Git.',
        noChanges: 'Изменений пока нет. Здесь появятся файлы, которые изменит агент.',
        changesLoading: 'Загрузка изменений',
        running: 'Работает',
        notRunning: 'Не запущен',
        nothingRunning: 'Ничего не запущено. Здесь появятся сервисы, запущенные этой сессией.',
        servicesLoading: 'Загрузка локальных сервисов',
        servicesReadFailed: 'Не удалось прочитать локальные сервисы. Попробуйте ещё раз.',
        noMachine: 'У этой сессии нет машины для запроса.',
        changedCount: ({ count }) => `изменено: ${count}`,
        moreFiles: ({ count }) => `ещё файлов: ${count}`,
        runningCount: ({ count }) => `работает: ${count}`,
        openInBrowser: ({ name }) => `Открыть ${name} в браузере`,
        paneLinkA11y: ({ pane }) => `${pane}. Открывается рядом с чатом`,
    } } satisfies Pick<Readonly<Record<string, WidgetGlanceTranslation>>, "ru">;

return { widgetGlanceTranslations };
})();

const Domain_workStatusTranslations = (() => {
type WorkStatusTranslations = Shared_workStatusTranslations.WorkStatusTranslations;

const en = Shared_workStatusTranslations.en;

const ru: WorkStatusTranslations = {
    buckets: {
        needs_you: 'Ждут вас',
        working: 'В работе',
        finished: 'Завершено',
        idle: 'Простаивает',
        offline: 'Не в сети',
    },
};

const workStatusTranslations = { ru: { ...ru, task: { stopped: 'Остановлена', linkFailed: 'Сессия создана, но связь с задачей не сохранена. Повторите попытку, чтобы связать ту же сессию.' } } };

return { workStatusTranslations };
})();

const Domain_workflowActionTranslations = (() => {
type Copy = Shared_workflowActionTranslations.Copy;

const en = Shared_workflowActionTranslations.en;

const workflowActionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "ru"> = { ru: {
        host: "Happier",
        structure: "Структура",
        artifactCreate: "Создать документ",
        artifactGet: "Прочитать документ",
        artifactList: "Список документов",
        artifactUpdate: "Обновить документ",
        artifactDelete: "Удалить документ",
        artifactPublish: "Опубликовать файл",
        artifactRevisions: "Список версий документа",
        artifactRestore: "Восстановить версию документа",
        artifactUsage: "Посмотреть объём хранилища документов",
        artifactShare: "Поделиться документом по ссылке",
        artifactLinks: "Список ссылок документа",
        artifactRevoke: "Отозвать ссылку документа",
        artifactAudit: "Посмотреть активность ссылок документа",
        sessionRole: "Назначить роль сессии",
        sessionRoleOverride: "Изменить настройки роли сессии",
        sessionRoleClear: "Сбросить настройки роли сессии",
        sessionRoleAdd: "Добавить роль сессии",
        sessionRoleRemove: "Удалить роль сессии",
        sessionNotes: "Задать заметки сессии",
        sessionRolesApply: "Применить роли к подчинённым сессиям",
        roleList: "Список ролей",
        roleGet: "Прочитать роль",
        roleCreate: "Создать роль",
        roleUpdate: "Обновить роль",
        roleDelete: "Удалить роль",
        roleOverride: "Изменить настройки роли",
        roleReset: "Сбросить настройки роли",
        widgetCatalog: "Список доступных виджетов",
        widgetInstances: "Список размещённых виджетов",
        widgetAdd: "Добавить виджет",
        widgetRemove: "Убрать виджет",
        widgetMove: "Переместить виджет",
        widgetRename: "Переименовать виджет",
        widgetSize: "Задать размер виджета",
        widgetFrame: "Задать рамку виджета",
        widgetInputs: "Прочитать входные данные виджета",
        widgetValidate: "Проверить входные данные виджета",
        widgetSetInputs: "Задать входные данные виджета",
        widgetResetInputs: "Сбросить входные данные виджета",
        widgetLayout: "Прочитать расположение виджетов",
        widgetUpdateLayout: "Изменить расположение виджетов",
        widgetDefinitions: "Список сохранённых виджетов",
        widgetDefinition: "Прочитать сохранённый виджет",
        widgetCreate: "Создать виджет",
        widgetUpdate: "Обновить сохранённый виджет",
        widgetDuplicate: "Дублировать сохранённый виджет",
        widgetDelete: "Удалить сохранённый виджет",
        widgetSave: "Сохранить виджет сессии",
    } };

return { workflowActionTranslations };
})();

const Domain_workflowAgentAuthoringTranslations = (() => {
type Edit = Shared_workflowAgentAuthoringTranslations.Edit;

type RepeatableMessage = Shared_workflowAgentAuthoringTranslations.RepeatableMessage;

type Copy = Shared_workflowAgentAuthoringTranslations.Copy;

const en = Shared_workflowAgentAuthoringTranslations.en;

const repeatable = { ru: { repeatable: 'Сделать повторяемым', repeatableDescription: 'Попросите агента превратить то, что сработало, в переиспользуемый workflow.', repeatablePrompt: 'Преврати то, что мы сделали здесь, в workflow, который я смогу запускать снова. Создай его, проверь через workflow.validate и сохрани, но не запускай.', repeatableMessagePrompt: 'Преврати то, что мы сделали в этом сообщении, в workflow, который я смогу запускать снова. Создай его, проверь через workflow.validate и сохрани, но не запускай.', repeatableMessageSource: ({ text }: RepeatableMessage) => `“${text}”` } };

const workflowAgentAuthoringTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "ru"> = { ru: { ...repeatable.ru, create: 'Создать с агентом', edit: 'Изменить с агентом', agent: 'Агент', description: 'Новая сессия составит workflow вместе с вами, проверит и сохранит его. Ничего не запустится, пока вы не выберете «Запустить сейчас».', changedByAgent: 'Изменено агентом', saved: 'Только что сохранено агентом', savedAge: ({ age }) => `Сохранено агентом ${age}`, savedWorkflow: ({ name }) => `Workflow сохранён · ${name}`, updated: 'Workflow обновлён', changed: ({ count }) => `Workflow обновлён · изменено шагов: ${count}`, openEditor: 'Открыть в редакторе', openSession: 'Открыть в Сессиях', createPrompt: 'Составь со мной workflow, проверь его через workflow.validate, затем сохрани. Не запускай его.', createLead: 'Помоги мне создать workflow, который ', editPrompt: ({ name, definitionId, headerVersion, bodyVersion }) => `У сохранённого workflow «${name}» id ${definitionId} и ревизия: заголовок ${headerVersion}, тело ${bodyVersion}. Измени его через workflow.definition.edit, а workflow.definition.update используй только для полной замены. Перед сохранением проверь через workflow.validate. Не запускай его.`, editLead: ({ name }) => `Помоги мне изменить ${name}: ` } };

return { repeatable, workflowAgentAuthoringTranslations };
})();

const Domain_workflowBuiltinTranslations = (() => {
type WorkflowBuiltinTranslations = Shared_workflowBuiltinTranslations.WorkflowBuiltinTranslations;

const en = Shared_workflowBuiltinTranslations.en;

const ru: WorkflowBuiltinTranslations = {
    runsInsideSession: 'Выполняется в сессии',
    keepGoing: { title: 'Продолжать до готовности' },
    reviewAndConverge: { title: 'Проверить и свести', apply: 'Применить', verifyAndFix: 'Проверить и исправить', verifyOnly: 'Только проверить', rounds: 'Раунды до остановки' },
    planWithAPanel: { title: 'Спланировать с панелью', description: 'Несколько агентов планируют параллельно, затем план ждёт вашей проверки.', inputs: { request: 'Запрос', requestPlaceholder: 'Что должна спланировать панель?', engines: 'Планировщики' } },
    openAPullRequest: { title: 'Открыть pull request', description: 'Запрашивает второе мнение, затем открывает pull request. Если второе мнение не согласно, ждёт вас.', inputs: { base: 'Базовая ветка', title: 'Заголовок pull request', body: 'Описание', question: 'Вопрос для второго мнения' } },
};

const workflowBuiltinTranslations = { ru } as const;

return { workflowBuiltinTranslations };
})();

const Domain_workflowFieldTranslations = (() => {
const workflowFieldTranslations = { ru: {
        sessionId: "Сессия",
        triggerId: "Триггер",
        engineIds: "Рецензенты",
        backendTargetKeys: "Планировщики",
        reviewCommentAuthorIntent: "Замечания",
        commentId: "Замечание",
        expectedServerRevision: "Версия замечания",
        clientMutationId: "Обновление",
        projectId: "Проект",
        workspace: "Рабочая область",
        toState: "Статус",
        expectedState: "Текущий статус",
        disposition: "Важность",
        allPages: "Все замечания",
        permissionMode: "Разрешения",
        target: "Запускается в",
        cwd: "Рабочая папка",
        maxRounds: "Максимум раундов",
        strikes: "Проверки без прогресса",
        secondOpinion: "Второе мнение",
        useJudge: "Арбитр",
        diffFingerprint: "Проверенные изменения",
    } };

return { workflowFieldTranslations };
})();

const Domain_workflowEditorPageTranslations = (() => {
type WorkflowEditorPageTranslations = Shared_workflowEditorPageTranslations.WorkflowEditorPageTranslations;

const workflowFieldTranslations = {...Domain_workflowFieldTranslations.workflowFieldTranslations, ...EnglishFeatures.workflowFieldTranslations.workflowFieldTranslations};

const en = Shared_workflowEditorPageTranslations.en;

const pluralPl = Shared_workflowEditorPageTranslations.pluralPl;

const pluralRu = Shared_workflowEditorPageTranslations.pluralRu;

const ru: WorkflowEditorPageTranslations = {
    fields: workflowFieldTranslations.ru,
    blocks: {
        actionSub: 'Действие · без хода агента',
        notSet: 'Не задано',
        set: 'Задать',
        clear: 'Очистить',
        required: 'Обязательно',
        noFields: 'Для этого действия нечего задавать.',
        workflowSub: 'Запускает другой сценарий · его шаги видны в этом запуске',
        builtin: 'Встроенный',
        waitTitle: 'Ждать вас',
        waitSub: 'Эта ветка ждёт, пока вы не продолжите.',
        waitPlaceholder: 'Что здесь нужно проверить или решить?',
        returnsText: 'Возвращает текст',
        returnsFields: ({ fields }) => `Возвращает ${fields}`,
        workflowDefaults: 'Настройки процесса',
        addNamedResults: 'Добавить именованные результаты',
        menuRun: 'Запустить сценарий',
        menuAction: 'Действие',
        menuWait: 'Ждать вас',
        actionSearch: 'Искать действия',
        workflowSearch: 'Искать сценарии',
        libraryGroup: 'Ваши сценарии',
        noAgentTurn: 'Без хода агента.',
        useNumber: 'Указать число',
        actionUnavailable: ({ action }: { action: string }) => `${action} здесь недоступно.`,
        childInputs: ({ workflow }: { workflow: string }) => `Входные данные приходят из ${workflow}.`,
        retryLoading: "Повторить загрузку",
        selfRef: ({ workflow }: { workflow: string }) => `${workflow} запускает этот сценарий, поэтому не может выполняться внутри него.`,
        maxFromInput: ({ name }: { name: string }) => `Из входа · ${name}`,
        useInput: ({ name }: { name: string }) => `Взять вход ${name}`,
    },
    backToRun: 'Назад к запуску',
    reviewedCopyTitle: 'Проверьте перед сохранением',
    reviewedCopyBody: 'Это копия из запуска. Сохраняются шаги и настройки, но не история и результаты. Место, режим запуска и входные значения относятся только к запуску. Проверьте ссылки на существующие сессии, папки, профили, модели, сервисы и серверы MCP перед повторным использованием.',
    chromeTitle: 'Сценарий',
    untitled: 'Сценарий без названия',
    nameLabel: 'Название сценария',
    descriptionPlaceholder: 'Добавьте описание',
    descriptionLabel: 'Описание',
    save: 'Сохранить',
    flow: 'Схема',
    flowSubtitle: 'Этот черновик в виде схемы',
    settings: 'Настройки сценария',
    settingsSubtitle: 'Каждый шаг использует их, если не меняет.',
    deleteWorkflow: 'Удалить сценарий',
    deleteBody: 'Прошлые запуски останутся в истории.',
    deleteFailedTitle: 'Не удалось удалить сценарий',
    changedForStep: 'Изменено для этого шага',
    issuesToFix: ({ count }: { count: number }) => `${count} ${pluralRu(count, 'пункт', 'пункта', 'пунктов')} нужно исправить перед запуском`,
    saveStatus: {
        notSaved: 'Ещё не сохранено',
        unsaved: 'Несохранённые изменения',
        saving: 'Сохранение…',
        saved: 'Сохранено',
        savedJustNow: 'Только что сохранено',
        savedAge: ({ age }: { age: string }) => `Сохранено ${age}`,
        failed: 'Не удалось сохранить',
        yourEdits: 'Ваши изменения',
        newerVersion: 'Более новая версия',
        newerVersionRevision: ({ revision }: { revision: string }) => `Более новая версия · ${revision}`,
    },
    where: {
        label: 'Где выполняется',
        choose: 'Выберите, где выполнять',
    },
    sections: {
        whereTitle: 'Где выполняется',
        machineAndProject: 'Машина и проект',
        eachStepRunsIn: 'Каждый шаг выполняется в',
        eachStepSession: 'Каждый шаг виден в списке сессий, под этим запуском.',
        eachStepBackground: 'Каждый шаг выполняется в фоне, под этим запуском.',
        aSession: 'Сессии',
        aBackgroundRun: 'Фоновом запуске',
        agentTitle: 'Агент и модель',
        agentDescription: 'Шаги используют их, если не выбирают свои.',
        rolesTitle: 'Роли для этого рабочего процесса',
        conversationTitle: 'Разговор и рабочее пространство',
        inputsTitle: 'Входные данные и результат',
    },
    unavailable: {
        machine_not_selected: 'Сначала выберите машину.',
        capability_unknown: 'Проверяем, что поддерживает эта машина.',
        machine_does_not_support_detached_runs: 'Эта машина пока не умеет фоновые запуски.',
    },
    /** Workflow settings and Step options (U-9): group summaries and the block subject. */
    inspector: {
        stepOptions: 'Параметры шага',
        whereMissing: 'Машина не выбрана',
        none: 'Нет',
        inputCount: ({ count }) => `Входных данных: ${count}`,
        finalOutput: ({ output }) => `Итоговый результат: ${output}`,
        originSession: 'Сессия, которая его запустила',
        differsFromWorkflow: 'отличается от процесса',
        followsWorkflow: 'использует настройки процесса',
        advancedTitle: 'Дополнительно',
        deadline: ({ ms }) => `Ждёт результат ${ms} мс`,
        workflowDefault: ({ value }) => `По умолчанию процесса · ${value}`,
        aSession: 'Сессия…',
        continues: ({ session }) => `Продолжает ${session}`,
        runsIn: 'Выполняется в',
        runsInBoundBySession: 'Продолжает сессию, поэтому выполняется в ней.',
        reviewTitle: 'Проверить перед продолжением',
        reviewDescription: 'Следующие шаги этой дорожки ждут, пока вы используете, измените или пересоздадите результат. Остальная работа продолжается.',
        reviewEvaluator: 'Каждая итерация ждёт вашей проверки.',
        reviewsBeforeContinuing: 'Проверка перед продолжением',
        resultTitle: 'Результат',
        resultFromAction: ({ action }) => `Определяется ${action}`,
        resultFromWorkflow: ({ workflow }) => `Возвращает то, что возвращает ${workflow}`,
        back: 'Назад',
        options: 'Параметры',
        itemConversation: 'Отдельный разговор для каждого элемента; шаги внутри делят его.',
        dropContinue: ({ session }) => `Продолжить ${session} в этом шаге`,
        dropRefused: ({ session, machine, where }) => `${session} на ${machine}; этот процесс выполняется на ${where}.`,
        lanes: ({ count }) => `Параллельно · дорожек: ${count}`,
        lane: ({ position }) => `Дорожка ${position}`,
        forEachIn: ({ source }) => `Для каждого элемента из ${source}`,
        atATime: ({ count }) => `по ${count} одновременно`,
        repeatTimes: ({ count }) => `Повторить ${count} раз`,
        repeatUntil: ({ condition }) => `Повторять, пока ${condition}`,
        repeatUntilDecided: 'Повторять, пока шаг не скажет остановиться',
        ifSentence: ({ condition }) => `Если ${condition}`,
        onlyWhenSentence: ({ condition }) => `Только если ${condition}`,
        conditionAll: 'выполнены все',
        conditionAny: 'выполнено любое',
        conditionNot: ({ condition }) => `не (${condition})`,
        returnsStructured: 'Возвращает структурированные данные',
        returnsDecision: 'Возвращает решение',
    },
};

const workflowEditorPageTranslations = { ru } as const;

return { workflowEditorPageTranslations };
})();

const Domain_workflowExamplesTranslations = (() => {
type ExampleCopy = Shared_workflowExamplesTranslations.ExampleCopy;

type Copy = Shared_workflowExamplesTranslations.Copy;

const workflowExamplesTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "ru"> = { ru: {
        nodes: { ask: 'Спросить', 'review-correctness': 'Проверить корректность', 'review-tests': 'Проверить тесты', summarize: 'Подвести итоги', analyze: 'Проанализировать', review: 'Проверить', fix: 'Исправить', check: 'Проверить результат', classify: 'Классифицировать', reply: 'Подготовить ответ', digest: 'Собрать изменения' },
        title: 'Начать с примера', fromExample: 'Из примера', description: 'Каждый открывается как черновик. Ничего не запускается до выбора «Запустить сейчас».', use: 'Использовать', chooseSession: 'Выбрать сессию…', builtInDescription: 'Часть Happier. Создайте копию для изменений.', stepCount: ({ count }) => `Шагов: ${count}`,
        askOnce: { title: 'Спросить один раз', description: 'Один шаг: задать агенту вопрос и получить ответ.' },
        reviewPullRequest: { title: 'Проверить pull request', description: 'Два рецензента параллельно, затем сводка всех замечаний.' },
        workThroughEachFile: { title: 'Обработать каждый файл', description: 'Каждый файл списка по очереди: анализ, затем проверка изменения.' },
        repairUntilItPasses: { title: 'Исправлять до успеха', description: 'Исправлять и проверять до успеха или исчерпания разрешённых попыток. Затем вы проверяете последнее исправление.' },
        triageAnIssue: { title: 'Разобрать обращение', description: 'Классифицировать обращение. Исправить ошибку или подготовить ответ.' },
        morningDigest: { title: 'Утренняя сводка', description: 'Собрать изменения проекта и отправить вам. Добавьте триггер на каждое утро.' },
    } };

return { workflowExamplesTranslations };
})();

const Domain_workflowPluginTranslations = (() => {
type Copy = Shared_workflowPluginTranslations.Copy;

const en = Shared_workflowPluginTranslations.en;

const workflowPluginTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "ru"> = { ru: { fromPlugins: 'Из плагинов', readOnly: 'Только чтение · скопируйте в библиотеку для редактирования', duplicateToLibrary: 'Скопировать в вашу библиотеку' } };

return { workflowPluginTranslations };
})();

const Domain_workflowRunVisibilityTranslations = (() => {
type VisibilityCopy = Shared_workflowRunVisibilityTranslations.VisibilityCopy;

const workflowRunVisibilityTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', VisibilityCopy>, "ru"> = { ru: { title: "Видимость", chooseTeam: "Выберите команду", loadFailed: "Не удалось проверить, кто может видеть этот запуск", machines: "Выполняется на ваших машинах", transcripts: "Участники команды могут просматривать разговоры шагов.", requiredSessionsEditable: "Участники этой команды могут редактировать её сессии", visibleTo: ({ team }) => "Видно команде " + team } };

return { workflowRunVisibilityTranslations };
})();

const Domain_workflowRunCompositionTranslations = (() => {
const workflowRunVisibilityTranslations = {...Domain_workflowRunVisibilityTranslations.workflowRunVisibilityTranslations, ...EnglishFeatures.workflowRunVisibilityTranslations.workflowRunVisibilityTranslations};

const en = Shared_workflowRunCompositionTranslations.en;

const workflowRunCompositionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "ru"> = { ru: { visibility: workflowRunVisibilityTranslations.ru, runWithAnotherAgent: 'Запустить снова с другим агентом', agentForStep: ({ step }) => `Агент для ${step}`, chooseAgent: 'Выберите агента или роль' } };

return { workflowRunCompositionTranslations };
})();

const Domain_workflowRunListTranslations = (() => {
type Progress = Shared_workflowRunListTranslations.Progress;

const en = Shared_workflowRunListTranslations.en;

const workflowRunListTranslations = { ru: {
        definitions: 'Определения',
        stepsProgress: ({ completed, total }: Progress) => `${completed} из ${total} шагов`,
        loopProgress: ({ completed, total }: Progress) => `${completed} из ${total} элементов`,
        startedByAgent: 'Запущено агентом',
        startedByTrigger: 'Запущено триггером',
    } } satisfies Pick<Record<string, typeof en>, "ru">;

return { workflowRunListTranslations };
})();

const Domain_workflowRunRoleTranslations = (() => {
const en = Shared_workflowRunRoleTranslations.en;

const workflowRunRoleTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "ru"> = { ru: { rolesTitle: 'Роли для этого запуска', rolesYour: 'Ваши роли', rolesChanged: ({ count }) => `${count} изменено для этого запуска`, rolesUnchanged: 'Всё остальное остаётся прежним.', useYourRole: 'Использовать вашу роль', targetsTitle: 'Каждый шаг выполняется в', rolesPrefillFailed: 'Не удалось прочитать роли вашего последнего запуска. Попробуйте ещё раз.' } };

return { workflowRunRoleTranslations };
})();

const Domain_workflowStartTranslations = (() => {
type Copy = Shared_workflowStartTranslations.Copy;

const workflowRunRoleTranslations = {...Domain_workflowRunRoleTranslations.workflowRunRoleTranslations, ...EnglishFeatures.workflowRunRoleTranslations.workflowRunRoleTranslations};

const workflowRunCompositionTranslations = {...Domain_workflowRunCompositionTranslations.workflowRunCompositionTranslations, ...EnglishFeatures.workflowRunCompositionTranslations.workflowRunCompositionTranslations};

const en = Shared_workflowStartTranslations.en;

const workflowStartTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "ru"> = { ru: { ...workflowRunRoleTranslations.ru, ...workflowRunCompositionTranslations.ru, neededNamed: ({ name }) => `Входные данные · нужно: ${name}`, addToStart: ({ name }) => `Добавьте ${name}, чтобы запустить`, workflow: 'Рабочий процесс', inputs: 'Входные данные', start: 'Запустить', starting: 'Запуск…', stillStarting: 'Запуск ещё продолжается…', needed: ({ count }) => `Входные данные · не хватает ${count}`, required: 'Нужно для запуска', preview: 'Что будет сделано', unsaved: 'Включает несохранённые изменения', remove: 'Вернуться к обычной сессии', search: 'Найти рабочий процесс', builtin: 'Встроенные', library: 'Ваша библиотека', noInputs: 'Входные данные не нужны', asksFor: ({ names }) => `Запрашивает: ${names}`, optional: 'Необязательно — оставлено пустым', defaultValue: ({ value }) => `По умолчанию: ${value}` } };

return { workflowStartTranslations };
})();

const Domain_workflowsDestinationTranslations = (() => {
type WorkflowsDestinationTranslations = Shared_workflowsDestinationTranslations.WorkflowsDestinationTranslations;

const en = Shared_workflowsDestinationTranslations.en;

const ru: WorkflowsDestinationTranslations = {
    description: 'Рабочие процессы, которые ваши агенты выполняют на ваших машинах — когда вы решите, по расписанию или когда что-то происходит.',
    import: 'Импортировать',
    addAccessibility: 'Добавить рабочий процесс',
    moreAccessibility: 'Другие параметры рабочих процессов',
    addMenu: {
        newWorkflowSubtitle: 'Начать с пустого черновика',
        importSubtitle: 'JSON-файл рабочего процесса',
    },
    sections: {
        needsYou: 'Ждёт вас',
        running: 'Выполняются',
        library: 'Библиотека',
        sharedWithYou: 'Доступные вам',
        triggers: 'Триггеры',
        history: 'История',
    },
    allRuns: 'Все запуски',
    lastRun: ({ age }) => `последний запуск ${age}`,
    strip: {
        label: ({ count, parts }) => `Последние запуски (${count}): ${parts}`,
        labelPlain: ({ count }) => `Последние запуски (${count})`,
        completed: ({ count }) => `завершено: ${count}`,
        failed: ({ count }) => `с ошибкой: ${count}`,
        needsYou: ({ count }) => `ждут вас: ${count}`,
        separator: ', ',
    },
    runSettings: 'Настройки запусков',
    libraryEmpty: 'Сохранённые рабочие процессы появятся здесь.',
    waitingForYou: ({ age }) => `Ждёт вас · ${age}`,
    stateAge: ({ state, age }) => `${state} · ${age}`,
    triggerRow: ({ when, then }) => `${when} · ${then}`,
    thenSendPrompt: 'Отправить запрос',
    thenRunWorkflow: 'Запустить рабочий процесс',
    offline: 'Не в сети',
    off: 'Выключен',
    columnLoadFailed: 'Не удалось загрузить рабочие процессы. Ничего сохранённого не потеряно.',
    firstVisitTitle: 'Сохраняйте работающие запросы и запускайте их снова',
    firstVisitBody: 'Рабочий процесс — это набор шагов, которые ваши агенты выполняют по порядку, параллельно или по одному разу для каждого элемента — когда вы решите, по расписанию или когда что-то происходит.',
    importPrompt: 'Есть файл рабочего процесса?',
    loadMoreWorkflows: 'Загрузить ещё рабочие процессы',
    searchPlaceholder: 'Искать рабочие процессы',
    noMatch: ({ query }) => `Нет рабочих процессов по запросу «${query}»`,
    views: {
        all: 'Все',
        triggered: 'С триггером',
        active: 'Активные',
        needsYou: 'Ждёт вас',
        libraryAccessibility: 'Какие рабочие процессы показывать',
        historyAccessibility: 'Какие запуски показывать',
    },
    history: {
        title: 'История',
        description: 'Каждый запуск, который вы начали, как бы он ни начался.',
        loadMore: 'Загрузить ещё запуски',
        loadFailedTitle: 'Не удалось загрузить запуски',
        loadFailedBody: 'Ваша работа не затронута.',
        review: 'Просмотреть',
        rowMeta: ({ origin, machine, age }) => `${origin} · ${machine} · ${age}`,
    },
    rowMenu: {
        accessibility: 'Параметры рабочего процесса',
        runNow: 'Запустить сейчас',
        share: 'Поделиться…',
    },
    deleteTitle: 'Удалить этот рабочий процесс?',
    deleteBody: 'Прошлые запуски останутся в Истории.',
    deleteFailedTitle: 'Не удалось удалить рабочий процесс',
    exportFailedTitle: 'Не удалось экспортировать рабочий процесс',
    gate: {
        localTitle: 'Автоматизации выключены на этом устройстве',
        localBody: 'Включите их, чтобы запускать рабочие процессы и их триггеры.',
        dependencyTitle: 'Рабочим процессам нужны автоматизации',
        dependencyBody: 'Включите автоматизации, чтобы создавать и запускать рабочие процессы.',
        openSettings: 'Открыть настройки',
    },
    runSettingsPage: {
        title: 'Настройки запусков',
        description: 'Сколько запусков каждая машина принимает одновременно и как долго хранится история.',
        saveFailed: 'Не удалось сохранить настройки запусков. Ваши изменения на месте.',
    },
};

const workflowsDestinationTranslations = { ru } as const;

return { workflowsDestinationTranslations };
})();

const Domain_workflowTriggersTranslations = (() => {
type Count = Shared_workflowTriggersTranslations.Count;

type WorkflowTriggersCopy = Shared_workflowTriggersTranslations.WorkflowTriggersCopy;

const en = Shared_workflowTriggersTranslations.en;

const ru: WorkflowTriggersCopy = {
    pullRequest: {
        label: "Pull request",
        description: "Добавление триггера связывает pull request с этой сессией.",
        empty: "Нет открытых pull request",
        loadFailed: "Не удалось загрузить pull request",
    },
    summary: {
        everyDayAt: ({ time }) => `Каждый день в ${time}`,
        weekdaysAt: ({ time }) => `По будням в ${time}`,
        weeklyAt: ({ day, time }) => `Каждую неделю: ${day}, ${time}`,
        everyMinutes: ({ count }) => (count === 1 ? 'Каждую минуту' : `Каждые ${count} мин`),
        everyHours: ({ count }) => (count === 1 ? 'Каждый час' : `Каждые ${count} ч`),
        cron: ({ expression }) => `По расписанию · ${expression}`,
        schedule: 'По расписанию',
        event: ({ event }) => `Когда происходит ${event}`,
        manual: 'Вручную',
        more: ({ first, count }) => `${first} · ещё ${count}`,
    },
    kind: {
        sessionStarts: 'Когда сессия начинается',
        sessionArchived: 'Когда сессия архивируется',
        schedule: 'По расписанию',
        prComment: 'Когда кто-то комментирует pull request',
        ciFailed: 'Когда CI падает в pull request',
        turnEnds: 'Когда заканчивается ход',
        needsYou: 'Когда сессии нужны вы',
        runEnds: 'Когда запуск завершится',
        runNeedsYou: 'Когда запуску нужны вы',
    },
    row: {
        workflowDeleted: 'Процесс удалён',
        legacyCreated: 'Создано в Happier 0.2',
        legacyUnavailable: 'Старый триггер недоступен',
        sessionKeyRequired: 'Требуется ключ сессии',
        templateRecoveryRequired: 'Восстановите триггер в настройках безопасности аккаунта',
        templateDecryptionFailed: 'Не удалось расшифровать триггер',
        machines: ({ count }: Count) => `${count} машин`,
        nextRun: ({ time }: { time: string }) => `Следующий запуск: ${time}`,
        steps: ({ count }) => (count === 1 ? `Шагов: ${count}` : `Шагов: ${count}`),
        off: 'Выкл.',
        running: 'Выполняется',
        ran: ({ age }) => `Запуск ${age}`,
        turnOn: ({ name }) => `Включить ${name}`,
        turnOff: ({ name }) => `Выключить ${name}`,
    },
    section: {
        add: 'Добавить триггер',
        emptyTitle: 'Нет триггеров',
        emptyBody: 'Добавьте триггер, чтобы проверять каждый ход, двигаться к цели или реагировать на pull request.',
        loadFailed: 'Не удалось загрузить триггеры этой сессии.',
        title: 'Триггеры',
        countOn: ({ count }) => `вкл.: ${count}`,
        info: 'Что запускается в этой сессии, когда что-то происходит. Они остаются с этой сессией и не появляются в вашей библиотеке.',
        saveFailed: 'Не удалось сохранить этот триггер. Ваши изменения на месте.',
    },    kindDescription: {
        turnEnds: 'После хода — вашего или агента, с которым вы работаете.',
        needsYou: 'Каждый раз, когда сессия ждёт вас, в том числе пока её ведёт процесс или «Продолжать до конца».',
        sessionArchived: 'Запускается один раз, когда вы архивируете эту сессию.',
        sessionStarts: 'Только при создании сессии.',
        schedule: 'Продолжает эту сессию по расписанию.',
        prComment: 'Только люди с правом записи. Комментарий передаётся как цитата.',
        pullRequestUnavailable: 'Триггеры pull request пока нельзя добавить здесь.',
    },
    then: {
        runsIn: 'Где выполняется',
        runsInChoice: {
            newSession: 'В новой сессии',
            session: 'В сессии…',
            backgroundRun: 'В фоновом запуске',
        },
        noSessionOnMachine: 'На этой машине пока нет сессий',
        session: 'Сессия',
        action: 'Действие',
        label: 'Затем',
        sendPrompt: 'Отправить запрос',
        doAction: 'Выполнить действие',
        notifyMe: 'Уведомить меня',
        runWorkflow: 'Запустить процесс',
        sendPromptDescription: 'Агент этой сессии получит этот запрос в этой сессии. Он никогда не прерывает ваш ход.',
        promptLabel: 'Запрос',
        promptPlaceholder: 'Что должен сделать агент?',
        message: 'Сообщение',
        title: 'Заголовок',
        sendTo: 'Отправить в',
        sendToDefault: 'Ваши настройки уведомлений',
        workflow: 'Процесс',
        choose: 'Выбрать…',
    },
    popover: {
        saveAsWorkflow: 'Сохранить как процесс',
        saveAsWorkflowDescription: 'Открывает эти шаги как новый процесс для проверки. Этот триггер сохраняет свои шаги.',
        when: 'Когда',
        newTrigger: 'Новый триггер',
        addTrigger: 'Добавить триггер',
        cancel: 'Отмена',
        done: 'Готово',
        turnOff: 'Выключить',
        turnOn: 'Включить',
        deleteTrigger: 'Удалить триггер',
        repeat: 'Повтор',
        everyDay: 'Каждый день',
        weekdays: 'По будням',
        weekly: 'Каждую неделю',
        day: 'День',
        at: 'В',
        expression: 'Расписание',
        tryAgain: 'Повторить',
    },    editor: {
        runsOn: 'Выполняется на',
        runsOnDescription: 'Все триггеры этого процесса выполняются здесь.',
        runsOnAccountDescription: 'Где выполняется этот триггер.',
        runsOnDiffers: ({ where }) => `«Запустить сейчас» использует ${where}.`,
        sameForAllTriggers: 'Одинаково для всех триггеров',
        roles: 'Роли',
        retargetFailed: 'Процесс сохранён · Триггер не обновлён',
        editInWorkflows: 'Измените этот триггер в разделе «Процессы». Он продолжает работать как есть.',
        title: 'Запускается автоматически',
        runsBy: 'Запускается сам, когда происходит одно из этого.',
        runsByOn: ({ where }) => `Запускается сам, когда происходит одно из этого, на ${where}.`,
        savedWorkflow: 'Триггеры запускают сохранённый процесс.',
        saveToInclude: 'Триггеры запускают сохранённый процесс. Сохраните, чтобы включить изменения.',
        newRow: 'Новый · ещё не добавлен',
        partialSave: 'Процесс сохранён · Триггеры не обновлены',
    },    column: {
        newTrigger: 'Новый триггер',
        newTriggerSubtitle: 'Выполняет свои шаги по расписанию',
    },
};

const legacyTranslations = { ru: {
        editNotice: 'Создано в Happier 0.2. Открытие ничего не меняет.',
        conversionBoundary: 'После этого изменения она работает только на машинах с Happier 0.3 или новее.',
        channelReplyRefusal: 'У этой автоматизации есть привязка ответа к каналу, которую нельзя перенести. Преобразование не выполнено; настройки и ваши изменения сохранены.',
        notAvailable: 'Эта автоматизация больше недоступна.',
    } };

const creationTranslations = { ru: { savedWorkflowsUnavailable: 'Переключитесь на сервер этой сессии, чтобы выбрать сохранённый рабочий процесс. Встроенные процессы и собственные шаги по-прежнему доступны.' } };

const workflowTriggersTranslations = { ru: { ...ru, legacy: legacyTranslations.ru, creation: creationTranslations.ru } } as const;

return { legacyTranslations, creationTranslations, workflowTriggersTranslations };
})();

const Domain_workflowValueReferenceTranslations = (() => {
const workflowValueReferenceTranslations = { ru: {
        checkoutRoot: 'Корневая папка рабочей копии',
        unavailableValue: 'Значение недоступно', sessionContext: ({ turns }: { turns: number }) => turns === 0 ? 'Контекст сессии' : `Последние ходы сессии: ${turns}`,
        tokensUsed: 'Использовано токенов', goalTokenBudget: 'Бюджет токенов цели',
        trailingCount: ({ source, value }: { source: string; value: string }) => `Последовательные ${source}, совпадающие с ${value}`,
        stopCondition: 'Условие остановки выполнено', stopConditionArm: ({ arm }: { arm: number }) => `Условие остановки ${arm} выполнено`,
        roundLimit: ({ rounds }: { rounds: number }) => `Достигнут предел · раундов: ${rounds}`, decision: 'Решение',
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

const ru = translated(workflowValueReferenceTranslations.ru, {
    title: 'Рабочие процессы',
    newWorkflow: 'Новый рабочий процесс',
    copyName: ({ name }: { name: string }) => `${name} копия`,
    importJson: 'Импортировать JSON',
    exportJson: 'Экспортировать JSON',
    openCollection: 'Открыть рабочие процессы',
    destination: workflowsDestinationTranslations.ru,
    plugins: workflowPluginTranslations.ru,
    authoring: workflowAgentAuthoringTranslations.ru,
    page: workflowEditorPageTranslations.ru,
    actionTitles: workflowActionTranslations.ru,
    builtins: workflowBuiltinTranslations.ru,
    examples: workflowExamplesTranslations.ru,
    triggers: workflowTriggersTranslations.ru,
    start: workflowStartTranslations.ru,
    list: workflowRunListTranslations.ru,
    review: {
        publishedByAgent: 'Опубликовано агентом',
        publishedByYou: 'Опубликовано вами',
        editedByYou: 'Изменено вами',
        editedByPerson: 'Изменено другим человеком',
        previousAttempt: 'Предыдущая попытка',
        useBody: "Следующие шаги получат именно то, что вы видите. Без хода агента.",
        usePlanBody: "Принимает именно этот план. Без хода агента.",
        reportBackTitle: ({ session }) => "Сообщить результат: " + session,
        reportBackBody: ({ session }) => session + " получит результат этого запуска после завершения.",
        planRunNotice: "Запускает предложенный процесс точно как показано и принимает план. Процесс не сохраняется.",
        editedPlanBody: 'Этот черновик отличается от предложения. Сначала принять проверенный план для редактирования? Изменения останутся здесь, и ничего не запустится, пока вы снова не запустите черновик.',
        title: "Результат для проверки",
        planTitle: "План для проверки",
        waitTitle: "Ждёт вас",
        waitBody: "Эта ветка ждёт, пока вы продолжите.",
        editsTitle: "Ваши несохранённые изменения",
        editsBody: "Сохранённый результат не меняется, пока вы его не используете.",
        heldBody: "Ждёт вашей проверки · ещё не передан следующим шагам",
        noValue: "Пока нет допустимого результата",
        useResult: "Использовать этот результат",
        usePlan: "Использовать этот план",
        useValues: "Использовать эти значения",
        continue: "Продолжить",
        invalid: "Сначала исправьте выделенное поле.",
        newer: "Доступен более новый результат.",
        showNewer: "Показать новый",
        keepMyEdits: 'Сохранить мои правки',
        useNewer: 'Использовать новый',
        showFullResult: 'Показать результат целиком',
        showFullPlan: 'Показать план целиком',
        generationRequested: "Создание результата запрошено",
        startsResume: "Начнётся, когда вы возобновите запуск.",
        generateBody: "Агент создаст новый результат в этой беседе. Если он допустим, выполнение продолжится без повторного вопроса.",
        acceptedPaused: "Использование результата оставляет процесс на паузе.",
        editResult: "Изменить результат",
        generate: "Создать результат и продолжить",
        discuss: "Обсудить",
        discussBody: "Ответьте в беседе этого шага. Агент может опубликовать здесь обновлённый результат.",
        proposal: "Предложенный процесс",
        planStarted: "Запуск по этому плану уже начался",
        earlierPlanStarted: "Запуск по предыдущему предложению уже начался",
        openEarlierPlanRun: "Открыть тот запуск",
        runNewProposal: "Запустить новое предложение",
        runPlan: "Запустить как процесс",
        runPlanBody: "Открывает проверку предложенного процесса. Запуск также принимает этот план.",
        editPlan: "Сначала изменить процесс",
        editPlanBody: "Принимает план и открывает предложенный процесс как несохранённый черновик.",
        editPlanFallback: "Принимает план и открывает процесс из одного шага с этим планом в качестве инструкции.",
        waitingMachine: ({ machine }) => "Ожидает " + machine,
    },

    tabs: {
        saved: 'Сохранённые',
        runs: 'Запуски',
        steps: 'Шаги',
        flow: 'Схема',
        map: 'Карта',
        activity: 'Активность',
    },
    tabsAccessibility: {
        savedRuns: 'Сохранённые рабочие процессы или запуски',
        stepsFlow: 'Шаги или схема',
        activityFlow: 'Активность или схема',
        runViews: "Виды запуска",
    },

    filters: {
        all: 'Все',
        active: 'Активные',
        needsYou: 'Требуют внимания',
        clear: 'Сбросить фильтр',
    },

    empty: {
        savedTitle: 'Сохранённых рабочих процессов пока нет',
        savedBody: 'Сохранение рабочего процесса оставляет многократно используемое описание, которое можно запустить или запланировать.',
        runsTitle: 'Пока ничего не запускалось',
        runsBody: 'Запуски появляются здесь независимо от того, сохраняете вы рабочий процесс или нет.',
        filteredTitle: 'Нет запусков, подходящих под этот фильтр',
        filteredBody: 'Сбросьте фильтр, чтобы увидеть остальные запуски.',
        missingTitle: 'Этот рабочий процесс недоступен',
        missingBody: 'Happier не смог открыть рабочий процесс, на который ведёт эта ссылка. Другие рабочие процессы, Автоматизации и запуски не затронуты.',
    },

    loadFailedTitle: 'Не удалось загрузить рабочие процессы',
    loadFailedBody: 'Ваша работа не затронута. Повторите попытку, когда будете готовы.',
    retry: 'Повторить',
    contentUnavailable: 'Приватное содержимое недоступно на этом устройстве.',
    contentReasons: {
        invalidHeader: 'Сохранённые сведения об этом рабочем процессе недействительны.',
        revisionMismatch: 'Этот рабочий процесс не соответствует сохранённой редакции.',
        missingBody: 'Сохранённое определение этого рабочего процесса отсутствует.',
        invalidBody: 'Сохранённое определение этого рабочего процесса недействительно.',
        notFound: 'Этот рабочий процесс больше недоступен.',
    },

    sessionEntry: {
        missingTitle: 'Эта сессия больше недоступна',
        missingBody: 'Возможно, она удалена или находится в другом Home. Откройте «Сессии», чтобы найти её.',
        inaccessibleTitle: 'Эту сессию нельзя открыть',
        inaccessibleBody: 'Happier не смог подтвердить доступ. Войдите снова или попросите владельца, затем откройте страницу заново.',
        failedTitle: 'Не удалось открыть эту сессию',
        failedBody: 'Happier продолжает попытки. Вы можете повторить сейчас.',
        unsupportedTitle: 'Эта сессия не может запустить рабочий процесс',
        unsupportedBody: 'Happier не смог прочитать агента и машину, на которой она работает. Создайте рабочий процесс в разделе «Рабочие процессы».',
    },

    editor: {
        namePlaceholder: 'Название рабочего процесса',
        agentRuntime: 'Среда выполнения агента',
        firstPromptTitle: 'Что должно произойти первым?',
        firstPromptBody: 'Один промпт — уже рабочий процесс. Добавляйте шаги, когда они понадобятся.',
        promptPlaceholder: 'Опишите, что должен сделать этот шаг',
        useWorkflowDefault: 'Использовать значение рабочего процесса',
        defaultsTitle: 'Значения по умолчанию',
        produces: 'Выдаёт',
        whereTitle: 'Где',
        add: 'Добавить',
        addAccessibility: 'Добавить блок в этот рабочий процесс',
        addStep: 'Шаг агента',
        addParallel: 'Рядом',
        addLoop: 'Повторять',
        addIf: 'Если',
        targetRequired: 'Выберите компьютер и папку проекта для этого рабочего процесса.',
        loadingTitle: 'Открываем рабочий процесс…',
        accountChangedTitle: 'Вы сменили аккаунт',
        accountChangedBody: 'Этот рабочий процесс открыт предыдущим аккаунтом и не может быть перенесён. Откройте его снова в разделе «Рабочие процессы».',
        loadFailedTitle: 'Не удалось открыть этот рабочий процесс',
        loadFailedBody: 'Сохранённый рабочий процесс сейчас не удалось прочитать.',
        timeoutTitle: 'Ожидание результата (мс)',
        noDeadline: 'Без срока',
        timeoutExplain: 'Сколько миллисекунд ждать результат этого шага, прежде чем ему потребуется внимание. Оставьте пустым, чтобы не задавать срок.',
        wholeNumberRequired: 'Введите целое число не меньше 1.',
        runNow: 'Запустить сейчас',
        save: 'Сохранить рабочий процесс',
        saveAutomation: 'Сохранить автоматизацию',
        schedule: 'Запланировать',
        savedRevision: ({ revision }) => `Сохранено · ${revision}`,
        moveUp: 'Вверх',
        moveDown: 'Вниз',
        moveIn: 'Переместить в группу выше',
        moveOut: 'Вынести из этой группы',
        remove: 'Удалить',
        undo: 'Отменить',
        redo: 'Повторить',
        historyRestoreRequiresSetup: 'Это событие нужно настроить заново. Сохранённую приватную конфигурацию нельзя восстановить после удаления.',
        history: { edited: 'Изменить workflow', agent: 'Изменение агента', description: 'Изменить описание', where: 'Изменить место запуска', target: 'Изменить выполнение шагов', triggers: 'Изменить триггеры', example: 'Вставить пример', document: 'Изменить запрос' },
        undoAction: ({ change }: { change: string }) => `Отменить: ${change}`,
        redoAction: ({ change }: { change: string }) => `Повторить: ${change}`,
        removedBlock: ({ block }) => `${block} удалён`,
        rename: 'Переименовать',
        stepOrdinal: ({ position }) => `${position}`,
        unnamedStep: ({ position }) => `Шаг ${position}`,
        unnamedParallel: 'Параллельная группа',
        unnamedLoop: 'Цикл',
        unnamedIf: 'Условие',
        branch: 'Ветка',
        addBranch: 'Добавить ветку',
        ifTrue: 'Если истинно',
        otherwise: 'Иначе',
        addOtherwise: 'Добавить ветку «иначе»',
        evaluator: 'Решить, продолжать ли',
        loopBody: 'Повторять эти шаги',
        continuation: 'После каждого круга',
    },

    input: {
        label: 'Вход',
        result: 'Результат',
        change: 'Изменить',
        none: 'Без входных данных',
        previousResult: ({ block }) => `Результат: ${block}`,
        workflowInput: ({ name }) => `Входные данные рабочего процесса ${name}`,
        currentItem: 'Текущий элемент',
        iteration: 'Этот круг',
        unavailable: 'Этот источник больше недоступен',
        itemField: {
            value: 'Значение элемента',
            index: 'Индекс элемента, с 0',
            position: 'Позиция элемента, с 1',
            count: 'Количество элементов',
        },
        iterationField: {
            index: 'Индекс раунда, с 0',
            position: 'Номер раунда, с 1',
            count: 'Количество раундов',
            stopReason: 'Причина остановки',
        },
        valueKindGroup: 'Источник значения',
        inputNameGroup: 'Вход рабочего процесса',
        producerGroup: 'Шаг-источник',
        workspaceFieldGroup: 'Поле рабочего пространства',
        itemFieldGroup: 'Поле элемента',
        iterationFieldGroup: 'Поле раунда',
    },

    inputs: {
        title: 'Входные данные рабочего процесса',
        addInput: 'Добавить входные данные',
        namePlaceholder: 'Название',
        descriptionPlaceholder: 'Для чего это нужно?',
        required: 'Обязательно',
        optional: 'Необязательно',
        defaultValue: 'Значение по умолчанию',
        typeString: 'Текст',
        typeNumber: 'Число',
        typeBoolean: 'Да или нет',
        typeJson: 'Структурированные данные',
        runSheetTitle: 'Запустить этот рабочий процесс',
        runSheetBody: 'Укажите значения, которые объявляет этот рабочий процесс, и запустите его.',
        missingRequired: 'Это значение обязательно.',
        wrongType: ({ type }) => `Это значение должно быть типа ${type}.`,
    },

    finalOutput: {
        title: 'Итоговый результат',
        none: 'Итоговый результат не выбран',
        change: 'Изменить',
        clear: 'Очистить выбор',
        fieldPath: 'Путь к полю',
        explain: 'Итоговый результат — это то, что рабочий процесс возвращает по завершении. Порядок завершения его никогда не меняет.',
    },

    conversation: {
        title: 'Диалог',
        sharedRun: 'Тот же диалог',
        branchesShareAndTakeTurns: 'Ветки используют один диалог и выполняются по очереди.',
        fresh: 'Отдельные диалоги',
        fromStep: ({ block }) => `Продолжить ${block}`,
        existingSession: 'Существующая сессия',
        existingSessionById: ({ sessionId }) => `Сессия ${sessionId}`,
        noExistingSessions: 'Ни одну сессию на этой машине здесь продолжить нельзя.',
        chooseExistingSession: 'Выберите сессию для продолжения',
        continuingKeepsAgentAndFolder: 'При продолжении сохраняются Агент и папка этого диалога. Для другого Агента или папки нужен отдельный диалог.',
        waitingForConversation: ({ block }) => `Ожидание, пока ${block} завершится в этом диалоге.`,
        branchesUseSeparate: 'Ветки в параллельной группе используют отдельные диалоги.',
    },

    workspace: {
        title: 'Рабочее пространство',
        inherit: 'Рабочее пространство процесса',
        projectCheckout: 'Папка проекта',
        fromStep: ({ block }) => `Продолжить в рабочем пространстве: ${block}`,
        newWorktreeOriginal: 'Новое рабочее дерево из исходной папки',
        newWorktreeWorkflow: 'Новое рабочее дерево из рабочего пространства процесса',
        newWorktreeStep: ({ block }) => `Новое рабочее дерево из: ${block}`,
        committedOnlyNote: 'Новое рабочее дерево содержит зафиксированное состояние исходной папки. Проиндексированные, незафиксированные и неотслеживаемые изменения остаются в источнике.',
        reuseNote: 'При продолжении рабочего пространства оно видит свои незафиксированные файлы ровно такими, какие они есть.',
        sharedParallelNote: 'Ветки, использующие одно рабочее пространство, могут писать в него одновременно.',
        unavailable: ({ block }) => `Рабочее пространство для ${block} недоступно.`,
        unavailableBody: 'Восстановите его, чтобы продолжить этот запуск, или просмотрите новый запуск, который может повторить уже выполненную работу.',
        unavailableRestoreBody: 'Восстанови её, чтобы продолжить этот запуск с нетронутой уже выполненной работой.',
        unavailableNewRunBody: 'Её нельзя восстановить. Проверенный новый запуск начнётся заново, и уже выполненная работа может повториться.',
        restore: 'Восстановить',
        inspect: 'Просмотреть',
    },

    condition: {
        onlyWhen: 'Запускать только когда',
        always: 'Всегда',
        stopWhen: 'Остановить когда',
        ifWhen: 'Запустить первую ветку когда',
        addCondition: 'Добавить условие',
        removeCondition: 'Удалить условие',
        allOf: 'Все из них',
        anyOf: 'Любое из них',
        not: 'Не',
        exists: 'имеет значение',
        operatorEq: 'равно',
        operatorNeq: 'не равно',
        operatorLt: 'меньше чем',
        operatorLte: 'не больше чем',
        operatorGt: 'больше чем',
        operatorGte: 'не меньше чем',
        valuePlaceholder: 'Значение',
        skippedReason: ({ block }) => `Пропущено, потому что условие блока ${block} не выполнилось.`,
    },

    loop: {
        modeTitle: 'Повторять',
        modeCount: 'Заданное число раз',
        modeItems: 'По одному разу для каждого элемента',
        modeUntil: 'Пока результат не скажет остановиться',
        modeEvaluate: 'Пока Агент не скажет остановиться',
        count: 'Число повторов',
        items: 'Список',
        sequential: 'Элементы по очереди',
        parallel: 'Элементы параллельно',
        maxConcurrentItems: 'Максимум одновременных элементов',
        maxConcurrentBranches: 'Максимум одновременных веток',
        noWorkflowLimit: 'Рабочий процесс не задаёт ограничение',
        maxIterations: 'Максимум кругов',
        limitReached: 'Достигнут предел',
        historyTitle: 'Прошлые оценки',
        historyNone: 'Нет',
        historyLatest: 'Последняя',
        historyAll: 'Все',
        historyExplain: 'Так выбираются сохранённые решения и отзывы, а не целые расшифровки.',
        continuingConversation: 'Этот оценщик сохраняет прежний диалог и добавляет в него каждый новый круг.',
        emptyListCompletes: 'Пустой список завершается без единого круга.',
    },

    failurePolicy: {
        title: 'Если шаг завершится с ошибкой',
        failStop: 'Останавливать эту группу при ошибке',
        failStopExplain: 'Группа перестаёт начинать новую работу и просит активные ветки остановиться, включая независимые. Завершённые результаты и изменения сохраняются. Это не откат.',
        collectOutcomes: 'Довести независимую работу до конца',
        collectOutcomesExplain: 'Исправные ветки проходят всю свою цепочку, и каждый итог собирается. Шаги после ошибки внутри ветки не выполняются.',
    },

    runState: {
        pending: 'Ожидает старта',
        queued: 'Ожидает старта',
        claimed: 'Запускается',
        running: 'Выполняется',
        waiting_for_review: 'Ожидает вашей проверки',
        succeeded: 'Завершено',
        failed: 'Ошибка',
        cancel_requested: 'Останавливается',
        cancelled: 'Остановлено',
        pause_requested: 'Приостанавливается',
        paused: 'Приостановлено',
        interrupted: 'Прервано',
        expired: 'Истекло до старта',
        dispatch_failed: 'Не удалось запустить',
        skipped: 'Пропущено',
        missed: 'Пропущено по расписанию',
        outcome_uncertain: 'Итог неизвестен',
        completed: 'Завершено',
        completed_with_failures: 'Завершено с ошибками',
    },

    invocationState: {
        pending: 'Ожидает',
        waiting_for_capacity: 'Ожидает свободных ресурсов',
        admitting: 'Запускается',
        running: 'Выполняется',
        waiting_for_approval: 'Ожидает подтверждения',
        waiting_for_review: 'Ожидает вашей проверки',
        needs_attention: 'Требует вашего внимания',
        completed: 'Завершено',
        failed: 'Ошибка',
        skipped: 'Пропущено',
        cancel_requested: 'Останавливается',
        cancelled: 'Остановлено',
        outcome_uncertain: 'Итог неизвестен',
        superseded: 'Заменено более поздней попыткой',
    },

    run: {
        title: 'Запуск',
        frozenVersion: "Этот запуск использует версию, с которой начался. Изменения влияют только на будущие запуски.",
        selectOccurrence: 'Выберите шаг',
        openReview: 'Проверить результат',
        open: 'Открыть запуск',
        openExact: ({ title }) => `Открыть запуск ${title}`,
        openExecution: 'Открыть фоновый запуск',
        loadMore: 'Загрузить предыдущие шаги',
        origin: {
            direct: 'Запущен вручную',
            automation: 'По расписанию',
            fromSession: 'Из сессии',
        },
        needsYou: 'Требует вашего внимания',
        needsYouLoadedCount: 'загружено',
        review: 'Просмотреть',
        stop: 'Остановить',
        stopAgain: 'Остановить ещё раз',
        stopping: 'Останавливается…',
        stopRequested: ({ machine }) => `Запрошена остановка. Ожидаем подтверждения от ${machine}.`,
        evidenceStale: 'Показаны последние известные данные. Happier не смог подтвердить, что они актуальны.',
        pauseAtBoundary: 'Приостановить на ближайшей границе',
        pausePending: 'Завершает текущую работу, затем приостанавливается.',
        paused: 'Приостановлено после последней завершённой границы.',
        resume: 'Продолжить',
        runAgain: 'Запустить рабочий процесс снова',
        retryStep: 'Повторить шаг',
        attempt: ({ attempt }) => `Попытка ${attempt}`,
        untitled: 'Запуск рабочего процесса',
        openResult: 'Открыть результат',
        inspectSteps: 'Посмотреть шаги',
        seeFailures: 'Посмотреть ошибки',
        saveAsWorkflow: 'Сохранить как рабочий процесс',
        saveAsNewWorkflow: 'Сохранить как новый рабочий процесс',
        showCurrentWork: 'Показать текущую работу',
        editWorkflow: 'Изменить рабочий процесс',
        openWorkflow: 'Открыть рабочий процесс',
        deleteHistory: 'Удалить историю запусков',
        deleteHistoryConfirm: 'Входные данные и результаты будут удалены. Рабочие пространства, диалоги, сохранённые рабочие процессы и автоматизации останутся.',
        technicalDetails: 'Технические подробности',
        technical: {
            runId: 'ID запуска',
            invocationId: 'ID шага',
            machine: 'Компьютер',
            machineId: 'ID компьютера',
            revision: 'Версия',
        },
        usageUnavailable: 'Данные о расходе недоступны',
        startedAt: ({ time }: { time: string }) => `Запущен ${time}`,
        timeRange: ({ start, end }) => `${start} – ${end}`,
        openConversation: 'Открыть беседу',
        openChildRun: 'Открыть его запуск',
        openStepDetails: 'Открыть подробности',
        outcomeLine: ({ word, sentence }: { word: string; sentence: string }) => `${word} — ${sentence}`,
        attentionReviewRow: ({ step }: { step: string }) => `${step} ждёт вашей проверки`,
        attentionWaitRow: ({ step }: { step: string }) => `${step} ждёт вас`,
        attentionReviewSentence: ({ step }: { step: string }) => `${step} ждёт вашей проверки.`,
        attentionWaitSentence: ({ step }: { step: string }) => `${step} ждёт вас.`,
        reviewing: 'Проверяется',
        notStarted: 'Не запускалось',
        machineUnavailable: ({ machine }) => `Этот запуск потерял связь с ${machine}.`,
        machineUnavailableBody: 'Варианты продолжения появятся, когда станет известно текущее состояние.',
        completedCount: ({ count }) =>
            `Выполнено ${count} ${pluralRu(count, 'шаг', 'шага', 'шагов')}.`,
        completedWithFailures: ({ completed, failed }) =>
            `Завершено с ошибками. Выполнено: ${completed}. Не удалось завершить: ${failed}.`,
        approvalWanted: ({ block }) => `${block} хочет выполнить команду.`,
        approvalWantedBody: 'Просмотрите её, чтобы продолжить.',
        capacityOccupied: 'Все места, заданные рабочим процессом, заняты.',
        openSourceSession: 'Открыть сессию, из которой он пришёл',
        observedActivity: 'Наблюдаемая активность',
        observedActivityBody: 'Happier видит фазы и агентов этого агента, но он был запущен не как управляемый рабочий процесс, поэтому его нельзя изменить, сохранить или запустить снова.',
    },

    recovery: {
        title: 'Проверка восстановления',
        reattach: 'Подключиться снова',
        reattachExplain: 'Наблюдает за работой, которая уже идёт. Ничего нового не запускает.',
        resumeSameConversation: 'Продолжить',
        resumeSameConversationExplain: ({ block }) => `${block} может продолжить в том же диалоге.`,
        freshAgent: 'Продолжить с новым Агентом',
        freshAgentExplain: 'Этот диалог продолжить нельзя. Рабочее пространство доступно для нового Агента.',
        uncertainEffects: ({ block }) => `${block} остановился, не успев отчитаться. Возможно, он уже изменил рабочее пространство.`,
        acknowledgeEffects: 'Я понимаю, что прежние изменения могли уже произойти',
        waitingForStop: 'Ожидание остановки или подтверждения',
        remainingNotStarted: ({ count }) => `${count} ${count === 1 ? 'связанный шаг ещё не запущен' : 'связанных шагов ещё не запущено'}`,
        startReviewedRun: 'Начать новый проверенный запуск',
        editContinuation: 'Просмотреть или изменить продолжение',
        continuationPlaceholder: 'Добавьте, что этот шаг должен сделать иначе',
        useReplacementInput: 'Заменить ввод шага',
        repeatedEffectWarning: 'Уже выполненная работа может повториться. Исходный запуск сохраняет свою историю.',
    },

    unavailable: {
        title: 'Рабочие процессы недоступны',
        body: 'Рабочие процессы недоступны на этом сервере, поэтому здесь нельзя создать или запустить рабочий процесс.',
        conversion: 'Эти изменения требуют формата рабочего процесса, а рабочие процессы недоступны на этом сервере. Оставьте эту автоматизацию с одним запросом или попробуйте снова, когда рабочие процессы станут доступны.',
        savedAutomation: 'Эта автоматизация выполняется как рабочий процесс. Сохранённые шаги остаются без изменений; имя, описание и триггеры по-прежнему можно менять.',
    },
    conversion: {
        title: 'Для этих изменений нужен формат рабочего процесса',
        automationTarget: 'Рабочий процесс',
        body: 'Эта автоматизация пока выполняет один промпт на сохранённой цели. Преобразование сохранит ваши правки, а будущие запуски пойдут как рабочий процесс на одной конкретной машине. Прошлые запуски не изменятся.',
        action: 'Преобразовать в рабочий процесс',
        machineRequired: 'Выберите машину и папку проекта для будущих запусков.',
    },
    save: {
        conflictTitle: 'Сохранена более новая версия',
        conflictBody: 'Ваши правки на месте.',
        compare: 'Сравнить',
        saveAsCopy: 'Сохранить как копию',
        failedTitle: 'Не удалось сохранить',
        failedBody: 'Ваша локальная работа на месте.',
        deleteTitle: 'Удалить этот рабочий процесс?',
        deleteBody: 'Существующие автоматизации и запуски не затрагиваются и продолжают работать.',
        unsupportedAttachment: 'Прикрепите файлы через постоянную ссылку, прежде чем сохранять этот рабочий процесс.',
        nameRequired: 'Дайте этому рабочему процессу название перед сохранением.',
        runsCurrentDraft: 'Этот запуск использует рабочий процесс в том виде, в каком он на экране. Он его не сохраняет.',
    },

    interchange: {
        importTitle: 'Импортировать рабочий процесс',
        importBody: 'Импорт открывает несохранённый черновик для проверки. Он ничего не запускает и не планирует.',
        importIssuesTitle: 'Проверить этот рабочий процесс',
        importIssuesBody: 'Некоторые настройки требуют вашего внимания, прежде чем этот рабочий процесс можно будет использовать.',
        openRepairDraft: 'Открыть черновик для исправления',
        importFailedTitle: 'Не удалось прочитать этот файл',
        importFailedInvalidJson: 'Этот файл не является корректным JSON.',
        importFailedUnsupportedVersion: 'Этот файл использует версию рабочего процесса, которую приложение не поддерживает.',
        importFailedInvalidDocument: 'Этот файл не является рабочим процессом Happier.',
        exportPrivacyNote: 'Экспортированный файл содержит промпты и настройки. В нём никогда нет учётных данных и результатов запусков.',
    },

    issue: {
        invalid_version: 'Этот рабочий процесс использует неподдерживаемую версию.',
        unknown_field: 'У этого блока есть настройка, которую рабочий процесс не поддерживает.',
        invalid_id: 'Этому блоку нужен корректный идентификатор.',
        duplicate_id: 'У двух блоков одинаковый идентификатор.',
        missing_reference: 'Эти входные данные ссылаются на блок, которого больше нет.',
        invalid_reference_scope: 'Эти входные данные ссылаются на блок, который не завершается раньше.',
        invalid_input: 'Это значение некорректно.',
        missing_required_input: 'Отсутствует обязательное значение.',
        invalid_result_contract: 'Настройки результата этого шага некорректны.',
        invalid_condition: 'Это условие невозможно сравнить.',
        invalid_repetition: 'Этот цикл не может повторяться с такой настройкой.',
        invalid_max_concurrent: 'Максимальная параллельность требует целого числа не меньше 1 и применяется только к параллельной работе.',
        unsupported_persisted_attachment: 'У прикреплённых файлов должна быть постоянная ссылка до сохранения.',
        conversation_workspace_mismatch: 'Эту беседу и эту рабочую область нельзя продолжить вместе.',
        target_unavailable: 'Выберите Агента для этого рабочего процесса перед запуском.',
    },

    problem: {
        title: 'Не получилось',
        waitingTitle: 'Пока невозможно',
        subtreeDenied: 'Агент может начинать работу только в своей сессии или в сессиях, которыми он руководит.',
        roleTargetUnavailable: 'Эту роль нельзя использовать здесь.',
        roleRunsAsMismatch: 'Режим выполнения этой роли не подходит для этого шага. Выбери другую роль или измени режим выполнения шага.',
        policyDeniedField: 'Настройки агента не разрешают запрошенный параметр для работы, которую начинает агент.',
        permissionExceedsCeiling: 'Для этого нужно больше разрешений, чем есть у агента, который это начал.',
        workDepthExceeded: 'Это превысит твой предел делегирования. Сделай это в этой сессии или увеличь предел в Настройки › Делегирование.',
        definitionExceedsAuthority: 'Агент не может сохранить рабочий процесс, который мог бы делать больше, чем сам агент может начать.',
        sourceUnavailable: 'Этот рабочий процесс недоступен, поэтому его триггеры не могут выполняться.',
        legacyConversionUnsupported: 'Эту автоматизацию пока нельзя изменить здесь. Она продолжает работать без изменений.',
        nativeGoalOwner: 'Агент уже самостоятельно продолжает работу над целями в этой сессии.',
        sessionAlreadyStarted: 'Эта сессия уже началась. Триггеры начала сессии можно добавить только при её создании.',
        generic: 'Happier не смог завершить этот запрос рабочего процесса. Твоя работа не затронута.',
        needsRepair: 'В этом рабочем процессе есть настройки, которые нужно исправить перед запуском.',
        targetUnavailable: 'Машина или агент, которые нужны этому рабочему процессу, сейчас недоступны.',
        notFound: 'Этого запуска больше нет.',
        accessDenied: 'У тебя нет доступа к этому запуску.',
        conflict: 'Это изменилось в другом месте. Обнови, чтобы увидеть текущую версию; твоя локальная работа сохранена.',
        inputTooLarge: 'Эти входные данные слишком велики для отправки. Ничего не изменилось.',
        unresolvedOutcome: 'Happier пока не может подтвердить, что предыдущая работа остановилась, поэтому её нельзя заменить.',
        interactionCapacity: 'В этом разговоре сейчас слишком много ожидающего, чтобы принять ещё.',
        conversationUnavailable: 'Этот разговор нельзя продолжить.',
        workspaceRestore: 'Не удалось восстановить рабочую область. Ничего не изменилось.',
        waitSelfDependency: 'Тогда рабочий процесс ждал бы разговор, который его и запустил.',
        updateRequired: 'Машине, которая это выполняет, нужен более новый Happier, чтобы принять этот шаг.',
        ineligible: 'Этот запуск ушёл дальше, поэтому это уже невозможно.',
        custodyPending: 'Happier всё ещё ждёт подтверждения от машины.',
        runFinished: 'Этот запуск завершён.',
        checkpointUnavailable: 'Нет сохранённой точки, с которой можно продолжить.',
        recoveryEvidenceRequired: 'Открой этот запуск, чтобы увидеть варианты восстановления.',
        executionNotStarted: 'Ни один шаг ещё не начался.',
        custodySettled: 'Этот запуск уже закрыт.',
        unavailableHere: 'Сейчас это недоступно.',
    },

    a11y: {
        blockList: 'Блоки рабочего процесса',
        stepContext: ({ block, position, total }) => `${block}, шаг ${position} из ${total}`,
        groupContext: ({ group, block }) => `${block}, внутри ${group}`,
        inherited: 'использует настройку рабочего процесса',
        overridden: 'задано для этого шага',
        inserted: ({ block, position, total }) =>
            `${block} добавлен на позицию ${position} из ${total}`,
        removed: ({ block, total }) =>
            `${block} удалён. Осталось ${total} ${pluralRu(total, 'блок', 'блока', 'блоков')}`,
        reordered: ({ block, position, total }) =>
            `${block} перемещён на позицию ${position} из ${total}`,
        validation: ({ reason }) => reason,
        validationInBlock: ({ block, reason }) => `${block}: ${reason}`,
        needsYou: ({ count }) =>
            `${count} ${pluralRu(count, 'шаг требует', 'шага требуют', 'шагов требуют')} вашего внимания`,
        needsYouLoaded: 'загружено',
        terminal: ({ state }) => state,
        terminalWithAttention: ({ state, count }) =>
            `${state}. ${count} ${pluralRu(count, 'шаг требует', 'шага требуют', 'шагов требуют')} вашего внимания`,
        selectedRowUpdated: ({ block }) => `${block} обновлён`,
        progress: ({ count }) =>
            `Обновлено ${count} ${pluralRu(count, 'шаг', 'шага', 'шагов')}`,
        progressLoaded: ({ count }) =>
            `Пока обновлено ${count} ${pluralRu(count, 'шаг', 'шага', 'шагов')}`,
        progressWithAttention: ({ count, attention }) =>
            `Обновлено ${count} ${pluralRu(count, 'шаг', 'шага', 'шагов')}; ${attention} ${pluralRu(attention, 'требует', 'требуют', 'требуют')} вашего внимания`,
        flowNode: ({ node, state }) => `${node}, ${state}`,
        editStep: 'Редактировать шаг',
        editBlock: 'Редактировать блок',
        commandRefused: ({ reason }) => `Пока невозможно. ${reason}`,
    },
});

const workflowTranslations = { ru } as const;

return { workflowTranslations };
})();

const Domain_workspaceBarTranslations = (() => {
type WorkspaceBarTranslation = Shared_workspaceBarTranslations.WorkspaceBarTranslation;

const en = Shared_workspaceBarTranslations.en;

const workspaceBarTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', WorkspaceBarTranslation>>, "ru"> = { ru: { workspaceBar: { tabsLabel: 'Открытые вкладки', tabMenuLabel: 'Параметры вкладки', pinTab: 'Закрепить вкладку', unpinTab: 'Открепить вкладку', splitRight: 'Разделить вправо', splitDown: 'Разделить вниз', maximizePane: 'Развернуть панель', restorePane: 'Восстановить панель', closeTab: 'Закрыть вкладку', closeOtherTabs: 'Закрыть другие вкладки', closeTabsToRight: 'Закрыть вкладки справа', moreTabs: ({ count }) => `Ещё вкладок: ${count}`, searchTabs: 'Поиск вкладок', splitPane: 'Разделить активную панель', openInNewTab: 'Открыть в новой вкладке', openToRight: 'Открыть справа', openBelow: 'Открыть снизу', newTab: 'Новая вкладка' } } };

return { workspaceBarTranslations };
})();

const Domain_workspaceSyncDiagnosticTranslations = (() => {
type WorkspaceSyncDiagnosticTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncDiagnosticTranslation;

type WorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslation;

type WorkspaceSyncLocale = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncLocale;

type WorkspaceSyncTranslationCore = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslationCore;

type WorkspaceSyncReviewBase = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncReviewBase;

const completeWorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.completeWorkspaceSyncTranslation;

const workspaceSyncDiagnosticTranslations = { ru: {
        diagnostics: { title: 'Диагностика', relationshipId: 'Идентификатор связи', controllerMachineId: 'Идентификатор управляющего компьютера', alphaMachineId: 'Идентификатор исходного компьютера', betaMachineId: 'Идентификатор целевого компьютера', alphaRoot: 'Текущая исходная папка', betaRoot: 'Текущая целевая папка', engineMode: 'Режим движка', engineState: 'Состояние движка', errorCode: 'Код ошибки' },
        error: { updateRequired: 'Обновите Happier на исходном компьютере, прежде чем снова запускать эту передачу рабочего пространства. Другие действия с сеансами и компьютерами по-прежнему доступны.' },
        resolve: { title: 'Разрешить конфликт рабочего пространства?', body: ({ path, side }) => `Сохранить версию папки ${path} со стороны «${side}»? Другая папка и всё, что есть только в ней, будут удалены после проверки её текущего состояния.`, unverifiedFile: 'Версию без актуального отпечатка файла нельзя безопасно удалить. Обновите конфликт и повторите попытку.' },
    } } as const satisfies Pick<Record<string, WorkspaceSyncDiagnosticTranslation>, "ru">;

const workspaceSyncSetAttentionTranslations = { ru: { attention: { conflictedLinks: ({ count }) => `Конфликты в ${count} связях`, unavailableLinks: ({ count }) => `Проверьте состояние ${count} связей` } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'attention'>>, "ru">;

const workspaceSyncAddMachineTranslations = { ru: { availableOn: 'Доступно на', addMachine: { replica: 'Реплика', exactReplica: 'Точная реплика', editableCopy: 'Редактируемая копия', editableCopyHint: 'Изменения на связанных компьютерах могут стать видны агентам на других компьютерах. Конфликтующие версии требуют проверки. Для изолированной работы используйте отдельные рабочие деревья.' } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'availableOn' | 'addMachine'>>, "ru">;

const workspaceSyncReviewOutcomeTranslations = { ru: { keepBoth: 'Сохранить обе версии', preserveAt: ({ path }) => `Сохранить другую версию по пути ${path}`, notReviewed: 'Не проверено; здесь ничего не изменится', confirmScope: 'Изменятся только указанные проверенные рабочие области. Недоступные останутся без изменений.', preserved: 'Сохранено', alreadyPresent: 'Уже существует', notStarted: 'Не начато', askAgent: 'Спросить агента', askAgentPrompt: ({ path, versions }) => `Помоги проверить конфликтующие версии ${path} в связанных рабочих областях:\n${versions}\nПроверь текущие файлы и предложи безопасное решение. Не меняй и не разрешай конфликт без моего подтверждения.` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'keepBoth' | 'preserveAt' | 'notReviewed' | 'confirmScope' | 'preserved' | 'alreadyPresent' | 'notStarted' | 'askAgent' | 'askAgentPrompt'>>, "ru">;

const workspaceSyncCoverageIncompleteTranslations = { ru: 'Некоторые связи или точки не проверены. Загруженные конфликты видны; разрешить можно только явно проверенные доступные версии.' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['coverageIncomplete']>, "ru">;

const workspaceSyncReviewLifecycleTranslations = { ru: { requestingApproval: 'Запрос подтверждения…', applying: 'Применение проверенных изменений…', propagationExpected: ({ names }) => `Ожидается передача в ${names}`, propagationUnverified: ({ names }) => `Передачу в ${names} пока нельзя проверить` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'requestingApproval' | 'applying' | 'propagationExpected' | 'propagationUnverified'>>, "ru">;

const workspaceSyncLocalOnlyTranslations = { ru: 'Это альтернативное расположение остается локальным для своей рабочей области' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['localOnly']>, "ru">;

const workspaceSyncKeepAlternativesTranslations = { ru: 'Сохранить альтернативы' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['keepAlternatives']>, "ru">;

const workspaceSyncReviewDecisionTranslations = { ru: { chooseTargets: 'Выберите рабочие области для замены', notSelected: 'Не выбрано для этого разрешения', inspectCurrentVersions: 'Проверить текущие версии' } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'chooseTargets' | 'notSelected' | 'inspectCurrentVersions'>>, "ru">;

const workspaceSyncReviewTranslations: Pick<Record<WorkspaceSyncLocale, WorkspaceSyncReviewBase>, "ru"> = { ru: {
        executable: 'Исполняемый', regular: 'Неисполняемый', applied: 'Применено', appliedPaused: 'Применено; синхронизация приостановлена', changed: 'Изменено до применения', offline: 'Нет связи; не применено', cancelled: 'Отменено', unknown: 'Результат неизвестен; проверьте эту точку', failed: 'Ошибка; не применено', recoveryNeeded: 'Требуется восстановление по этому пути', inspectionUnavailable: 'Не удалось проверить текущие версии. Обновите данные, когда управляющий компьютер станет доступен.', coverageIncomplete: 'Не все связи или точки проверены. Загруженные конфликты видны, но разрешение пока недоступно.', versions: 'Версии', comparison: 'Сравнить выбранные версии', linkDecisions: 'Выбор по связям', result: 'Результат', confirmTitle: 'Использовать эту версию?', confirmBody: ({ path, source, count }) => `Использовать версию ${source} для ${path} в ${count} других рабочих областях? Happier проверит все версии до изменений.`, useVersion: 'Использовать версию', useNamedVersion: ({ name }) => `Использовать ${name}`, compareNamedVersion: ({ name }) => `Сравнить ${name}`, linkCount: ({ count }) => `${count} связей сообщили об этом пути`, moreOnLink: ({ name }) => `Загрузить ещё от ${name}`,
    } };

const workspaceSyncReviewSelectionTranslations = { ru: { selectionIncluded: 'Включено этой связью', selectionExcluded: 'Исключено этой связью', selectionUnknown: 'Выбор неизвестен', reasonRepositoryMetadata: 'Метаданные репозитория', reasonSubmodule: 'Подмодуль Git', reasonConfiguredRule: 'Настроенное правило', reasonGitIgnore: 'Правило Git ignore', reasonEndpointUnavailable: 'Точка недоступна', reasonSelectionUnavailable: 'Проверка выбора недоступна', configuredInclude: ({ pattern }) => `Шаблон включения: ${pattern}`, configuredExclude: ({ pattern }) => `Шаблон исключения: ${pattern}`, completedLinks: ({ count }) => `До блокировки завершено связей: ${count}` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'selectionIncluded' | 'selectionExcluded' | 'selectionUnknown' | 'reasonRepositoryMetadata' | 'reasonSubmodule' | 'reasonConfiguredRule' | 'reasonGitIgnore' | 'reasonEndpointUnavailable' | 'reasonSelectionUnavailable' | 'configuredInclude' | 'configuredExclude' | 'completedLinks'>>, "ru">;

const ru = completeWorkspaceSyncTranslation({
    diagnostic: workspaceSyncDiagnosticTranslations["ru"],
    review: workspaceSyncReviewTranslations["ru"],
    selection: workspaceSyncReviewSelectionTranslations["ru"],
    outcome: workspaceSyncReviewOutcomeTranslations["ru"],
    lifecycle: workspaceSyncReviewLifecycleTranslations["ru"],
    decision: workspaceSyncReviewDecisionTranslations["ru"],
    coverage: workspaceSyncCoverageIncompleteTranslations["ru"],
    localOnly: workspaceSyncLocalOnlyTranslations["ru"],
    alternatives: workspaceSyncKeepAlternativesTranslations["ru"],
    addMachine: workspaceSyncAddMachineTranslations["ru"],
    attention: workspaceSyncSetAttentionTranslations["ru"],
}, {
    title: 'Синхронизация рабочего пространства',
    footer: 'Состояние поступает с компьютера, управляющего этой связью. Изменения появляются только после подтверждения этим компьютером.',
    legacyRecovery: {
        title: 'Данные устаревшей синхронизации',
        footer: 'Happier только проверяет и помещает эти устаревшие данные в карантин. Приложение никогда их не удаляет.',
        checking: 'Проверка компьютеров…',
        inspectFailed: 'Некоторые компьютеры не удалось проверить. Ранее найденные папки карантина останутся видны; повторите попытку, когда компьютеры будут доступны.',
        outdatedTitle: ({ machine }) => `${machine} использует старую версию Happier`,
        outdatedBody: 'Эта версия не может проверить устаревшие данные синхронизации. Обновите Happier на этом компьютере и снова выполните проверку здесь.',
        explanation: 'Этот компьютер содержит данные устаревшего механизма репликации. Happier переместил распознанные данные в закрытый карантин и отключил синхронизацию, чтобы старый механизм не запускался.',
        quarantinePath: 'Папка карантина',
        openFolder: 'Открыть папку',
        offlineTitle: 'Удалить, когда Happier отключён',
        offlineSteps: ({ path }) => `1. Остановите все фоновые службы Happier, которые могут использовать эти данные.\n2. Удалите средствами операционной системы именно эту папку: ${path}\n3. Перезапустите службы и снова выполните проверку здесь.`,
        unknown: ({ path, reason }) => `Happier не смог безопасно классифицировать старое состояние в ${path} (${reason}). Синхронизация остаётся отключённой. Проверьте этот путь вручную; не удаляйте его из приложения.`,
        reinspect: 'Проверить снова',
    },
    none: 'Нет связи синхронизации',
    conflictsTitle: 'Конфликты рабочего пространства',
    openConflicts: ({ count }) => `Проверить синхронизацию в ${count} связях`,
    noConflicts: 'Нет конфликтов',
    previewUnavailable: 'Управляющий компьютер не смог предоставить безопасный просмотр. Обновите конфликт перед повторной попыткой.',
    truncated: ({ count }) => `${count} ${count === 1 ? 'дополнительный конфликт не показан' : 'дополнительных конфликтов не показано'}`,
    unknownMode: 'Неподдерживаемый режим синхронизации',
    conflictCount: ({ count }) => `${count} ${count === 1 ? 'конфликт' : 'конфликта'}`,
    conflictKind: { file: 'Файл', directory: 'Папка', symlink: 'Символическая ссылка', missing: 'Отсутствует', unsupported: 'Неподдерживаемый элемент' },
    mode: { copyOnce: 'Скопировать один раз', keepSynced: 'Поддерживать актуальность — рекомендуется', mirrorExactly: 'Зеркалировать точно', keepBothInSync: 'Синхронизировать обе стороны' },
    state: { loading: 'Проверка состояния…', starting: 'Подготовка', watching: 'Наблюдение', flushing: 'Синхронизация', paused: 'Приостановлено', peerOffline: 'Не в сети', conflicted: 'Конфликты', controllerUnavailable: 'Требует внимания', engineUnavailable: 'Компонент недоступен', error: 'Требует внимания', stopped: 'Остановлено', working: 'Выполняется…' },
    lastChecked: ({ at }) => `Последняя проверка: ${at}`,
    endpoint: { source: ({ label }) => `Источник · ${label}`, destination: ({ label }) => `Назначение · ${label}`, synced: ({ label }) => `Синхронизированная точка · ${label}` },
    error: {
        componentUnavailable: 'Синхронизация рабочего пространства недоступна в этой сборке. Установите нужный компонент и повторите попытку.',
        machineOffline: 'Компьютер назначения недоступен. Подключите его снова и повторите попытку.',
        destinationNeedsPreparation: 'Папку назначения нужно подготовить до начала синхронизации.',
        gitPreparationFailed: 'Happier не смог подготовить это рабочее пространство Git. Проверьте назначение и повторите попытку.',
        authorizationExpired: 'Срок авторизации рабочего пространства истёк. Запустите операцию снова.',
        rootNoLongerAuthorized: 'Папка рабочего пространства изменилась и больше не авторизована. Проверьте связь перед повторной попыткой.',
        conflictNeedsAttention: 'Этот конфликт изменился. Обновите его перед выбором версии.',
        needsAttention: 'Синхронизация рабочего пространства требует внимания. Обновите её состояние и повторите попытку.',
    },
    start: { blocked: {
        targetMachine: 'Выберите компьютер назначения, чтобы продолжить.',
        targetMachineOffline: 'Этот компьютер сейчас недоступен. Подключите его снова и повторите попытку.',
        relationshipUnavailable: 'Эта связь синхронизации больше не охватывает эти две папки. Выберите другой вариант рабочего пространства.',
        sourceFolder: 'Папку этой сессии нельзя безопасно синхронизировать. Выберите «Не перемещать файлы», чтобы передать только сессию.',
        destinationFolder: 'Выберите папку назначения, которую можно безопасно синхронизировать.',
        workspaceOptions: 'Проверьте параметры рабочего пространства перед запуском.',
    } },
    engine: { checking: 'Проверка синхронизации на этом компьютере…' },
    actions: { refresh: 'Обновить состояние', syncNow: 'Синхронизировать сейчас', more: 'Действия синхронизации', pause: 'Приостановить', resume: 'Продолжить', terminate: 'Остановить синхронизацию', openOnMachine: ({ machine }) => `Открыть на ${machine}`, openFolder: ({ label }) => `Открыть папку ${label}`, keepLocal: 'Оставить локальную версию', keepRemote: 'Оставить удалённую версию', keepNamed: ({ side }) => `Оставить версию от ${side}` },
    terminate: { title: 'Удалить синхронизацию рабочего пространства?', body: 'Синхронизация прекратится, а её связь будет удалена. Файлы останутся в обоих рабочих пространствах.' },
    resolve: {
        changedTitle: 'Конфликт изменился',
        changedBody: 'Этот конфликт изменился с момента открытия. Список обновлён. Проверьте последние версии перед повторным выбором.',
        consequence: 'Другая версия будет удалена только после того, как Happier убедится, что файл не изменился.',
        unsupported: 'Этот конфликт содержит неподдерживаемый элемент файловой системы и не может быть разрешён в Happier. Удалите или замените его на соответствующем компьютере, затем обновите.',
        keepHint: ({ side }) => `Оставить версию от ${side} и удалить другую проверенную версию.`,
    },
    fileState: { text: 'Предпросмотр текста', binary: 'Двоичный файл — просмотр недоступен', tooLarge: 'Файл слишком велик для предпросмотра', missing: 'Файл отсутствует', changed: 'Файл изменился после появления этого конфликта' },
});

const workspaceSyncTranslations = { ru } as const satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation>, "ru">;

return { workspaceSyncDiagnosticTranslations, workspaceSyncSetAttentionTranslations, workspaceSyncAddMachineTranslations, workspaceSyncReviewOutcomeTranslations, workspaceSyncCoverageIncompleteTranslations, workspaceSyncReviewLifecycleTranslations, workspaceSyncLocalOnlyTranslations, workspaceSyncKeepAlternativesTranslations, workspaceSyncReviewDecisionTranslations, workspaceSyncReviewTranslations, workspaceSyncReviewSelectionTranslations, workspaceSyncTranslations };
})();

const Domain_workspaceTabTranslations = (() => {
const en = Shared_workspaceTabTranslations.en;

const workspaceTabKeyboardTranslations = Shared_workspaceTabTranslations.workspaceTabKeyboardTranslations;

const workspaceTabTranslations = { ru: en };

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
