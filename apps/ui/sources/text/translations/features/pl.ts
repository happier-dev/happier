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

const accountDisplayTranslations = { pl: { unnamed: 'Konto bez nazwy', yours: 'Twoje konto', shortId: ({ id }) => `ID …${id}` } } as const satisfies Pick<Record<string, AccountDisplayTranslation>, "pl">;

return { accountDisplayTranslations };
})();

const Domain_accountEncryptionRecoveryTranslations = (() => {
type Copy = Shared_accountEncryptionRecoveryTranslations.Copy;

const en = Shared_accountEncryptionRecoveryTranslations.en;

const pl: Copy = {
    recoverAutomationTemplates: 'Odzyskaj starsze wyzwalacze',
    recoverAutomationTemplatesDescription: 'Użyj kluczy na tym urządzeniu, aby odzyskać starsze wyzwalacze. Klucze pozostają, dopóki potrzebują ich zaszyfrowane sesje lub zablokowane wyzwalacze.',
    recoverAutomationTemplatesAction: 'Odzyskaj',
    recoverAutomationTemplatesComplete: 'Wyzwalacze odzyskane. Stary klucz pozostaje na tym urządzeniu, dopóki nie wybierzesz jego usunięcia.',
    recoverAutomationTemplatesRetained: 'Sprawdzono odzyskiwanie. Niektóre wyzwalacze pozostają zaszyfrowane, zablokowane lub zmienione. Stary klucz pozostaje na urządzeniu.',
    forgetEncryptionKey: 'Zapomnij stary klucz szyfrowania',
    forgetEncryptionKeyDescription: 'Starsze zaszyfrowane sesje zostaną zablokowane na tym urządzeniu.',
    forgetEncryptionKeyAction: 'Zapomnij',
    forgetEncryptionKeyConfirm: 'Zapomnieć stary klucz szyfrowania?',
    forgetEncryptionKeyWarning: ({ items }) => `Starsze zaszyfrowane sesje zostaną zablokowane na tym urządzeniu. Ta zaszyfrowana historia może stać się niedostępna:\n\n${items}\n\nLista odzwierciedla bieżącą historię. Sesje zaszyfrowane utworzone później na innym urządzeniu również zostaną zablokowane. Przywróć stary klucz, aby je odblokować. Nic nie zostanie usunięte z konta.`,
    forgetEncryptionKeySession: ({ name, id }) => `Sesja: ${name} (${id})`,
    forgetEncryptionKeyTrigger: ({ id }) => `Wyzwalacz: ${id}`,
    forgetEncryptionKeyRun: ({ id }) => `Historia uruchomienia: ${id}`,
    forgetEncryptionKeyEmpty: 'Nie znaleziono zaszyfrowanej historii.',
    forgetEncryptionKeyComplete: 'Stary klucz został zapomniany na tym urządzeniu.',
    forgetEncryptionKeyFailed: 'Nie udało się zapomnieć klucza. Połącz się ponownie i spróbuj jeszcze raz; najpierw trzeba wyświetlić zaszyfrowaną historię.',
};

const accountEncryptionRecoveryTranslations = { pl } as const;

return { accountEncryptionRecoveryTranslations };
})();

const Domain_accountPopoverTranslations = (() => {
type AccountPopoverTranslation = Shared_accountPopoverTranslations.AccountPopoverTranslation;

const accountPopoverTranslations = { pl: {
        pageTitle: 'Konto i Home',
        homesTitle: 'Home',
        notLinkedTo: ({ service }) => `Niepołączone z ${service}`,
        serviceUnavailable: ({ service }) => `Nie można połączyć się z ${service}`,
        signedInToThisHome: 'Zalogowano do tego Home',
        checkingSignIn: 'Sprawdzanie logowania…',
        signInStatusUnavailable: 'Stan logowania niedostępny',
        machinesOnline: ({ online, total }) => `${online} z ${total} ${total === 1 ? 'maszyny' : 'maszyn'} online`,
        noMachines: 'Brak maszyn',
        connectedNoMachinesOnline: 'Połączono · brak maszyn online',
        cantReach: 'Brak połączenia',
        signedOut: 'Wylogowano',
        signIn: 'Zaloguj się',
        link: 'Połącz',
        linkSubtitle: 'Znajdź swoje Home na każdym urządzeniu',
        manageHomes: 'Zarządzaj Home',
        connectionDetails: 'Szczegóły połączenia',
        allHomes: 'Wszystkie Home',
        allHomesSubtitle: ({ count }) => `${count} Home · jedna lista`,
        addHome: 'Dodaj Home…',
        addDevice: 'Dodaj urządzenie',
    } } as const satisfies Pick<Record<string, AccountPopoverTranslation>, "pl">;

return { accountPopoverTranslations };
})();

const Domain_accountServiceOAuthTranslations = (() => {
const en = Shared_accountServiceOAuthTranslations.en;

const pl = {
    title: 'Zaloguj się, aby znaleźć swoje Homes',
    cancelNote: 'Anulowanie nie wyloguje Cię z istniejących Homes.', focusedHomePreserved: 'Wybrany Home nie zmieni się.',
    stages: { signingIn: 'Logowanie', findingHomes: 'Wyszukiwanie Twoich Homes', waitingApproval: 'Oczekiwanie na zatwierdzenie Home' },
    errors: { provider: { title: 'Dostawca nie ukończył logowania', body: 'Rozpocznij logowanie ponownie.' }, expired: { title: 'Ta prośba o logowanie wygasła', body: 'Rozpocznij logowanie ponownie.' }, identityChanged: { title: 'Tożsamość usługi logowania zmieniła się', body: 'Upewnij się, że to właściwa usługa logowania, zanim połączysz się ponownie.' }, unavailable: { title: 'Usługa logowania jest niedostępna', body: 'Sprawdź usługę i spróbuj ponownie. Istniejące Homes pozostaną bez zmian.' }, exchange: { title: 'Nie udało się ukończyć logowania', body: 'Nie zapisano danych logowania usługi logowania. Rozpocznij logowanie ponownie.' }, storage: { title: 'Nie udało się zapisać logowania', body: 'Dane logowania istniejących Homes pozostaną bez zmian. Rozpocznij logowanie ponownie.' }, homeLink: { title: 'Zalogowano, ale nie udało się połączyć tego Home', body: 'Logowanie zostało zapisane. Spróbuj ponownie połączyć ten Home.' }, directoryRefresh: { title: 'Zalogowano, ale nie udało się odświeżyć listy Homes', body: 'Połączenie z usługą logowania jest gotowe. Spróbuj ponownie odświeżyć listę Homes.' }, homeEnrollment: { title: 'Zalogowano, ale osobisty Home nie został dodany', body: 'Logowanie zostało zapisane. Spróbuj ponownie dodać Home.' }, invalid: { title: 'Ta prośba o logowanie nie jest już ważna', body: 'Rozpocznij logowanie ponownie.' }, accountDisabled: { title: 'To konto jest wyłączone', body: 'Skontaktuj się z administratorem usługi logowania. Twoje istniejące Homes pozostają bez zmian.' } },
    actions: { startAgain: 'Rozpocznij ponownie', openHome: ({ homeName }: { homeName: string }) => `Otwórz ${homeName}` },
    success: { title: ({ homeName }: { homeName: string }) => `${homeName} jest połączony`, body: 'Logowanie zostało zapisane, a ten Home jest gotowy do użycia.' },
    notLinked: { title: ({ homeName }: { homeName: string }) => `${homeName} nie jest jeszcze połączony z tym kontem`, signInAction: ({ homeName }: { homeName: string }) => `Zaloguj się do ${homeName}`, body: ({ homeName }: { homeName: string }) => `Zaloguj się bezpośrednio do ${homeName} albo zeskanuj jego kod QR lub wklej jego link Home.`, scanBody: ({ homeName }: { homeName: string }) => `Zeskanuj kod QR ${homeName} lub wklej jego link Home, aby go połączyć.` },
    noHomes: { body: 'To konto nie ma jeszcze żadnego Home. Odśwież po dodaniu Home w innym miejscu albo zeskanuj kod QR Home lub wklej jego link Home.' },
    approvalWait: { waitingBody: 'Zatwierdź to logowanie na innym zalogowanym urządzeniu.', cancelledTitle: 'Zakończono oczekiwanie na zatwierdzenie', cancelledBody: 'Logowanie pozostało zapisane, a istniejące Homes pozostały bez zmian.' },
} as const;

const accountServiceOAuthTranslations = { pl } as const;

return { accountServiceOAuthTranslations };
})();

const Domain_actionConfirmationTranslations = (() => {
type ActionConfirmationTranslations = Shared_actionConfirmationTranslations.ActionConfirmationTranslations;

const actionConfirmationTranslations = { pl: {
        requestedByAgent: 'Działanie żądane przez agenta sesji',
        homeTarget: ({ serverId }) => `Home: ${serverId}`,
        sessionTarget: ({ sessionId }) => `Sesja docelowa: ${sessionId}`,
        oneShotConsequence: 'Zatwierdzenie dotyczy tylko tego żądania. Nie przyznaje przyszłych uprawnień Action ani uprawnień natywnych.',
        homeUnavailable: 'To zatwierdzenie należy do Home niedostępnego na tym urządzeniu. Połącz ten Home ponownie, aby podjąć decyzję.',
    } } as const satisfies Pick<Record<string, ActionConfirmationTranslations>, "pl">;

return { actionConfirmationTranslations };
})();

const Domain_fileContentSearchTranslations = (() => {
const fileContentSearchTranslations = { "pl": {
        textInFiles: "Tekst w plikach",
        everything: "Wszystko",
        refineSearch: "Zawęź wyszukiwanie",
        partial: "Nie udało się przeszukać niektórych plików. Wyniki są niepełne.",
        updateRequired: "Zaktualizuj Happier na tej maszynie, aby szukać tekstu w plikach.",
        invalidPattern: "Wyrażenie regularne jest nieprawidłowe. Popraw wzorzec i spróbuj ponownie.",
        unavailable: "Wyszukiwanie tekstu jest niedostępne. Sprawdź połączenie z maszyną i spróbuj ponownie.",
        placeholder: "Szukaj plików, wiadomości, commitów, sesji, ustawień i działań",
        matchCase: "Uwzględniaj wielkość liter",
        regex: "Wyrażenie regularne",
    } };

return { fileContentSearchTranslations };
})();

const Domain_promptPickerTranslations = (() => {
const promptPickerTranslations = { "pl": {
        "partialHistory": "Wysłane wcześniej obejmuje tylko znane sesje.",
        "loadedHistory": "Wysłane wcześniej pokazuje tylko wczytane wiadomości.",
        "open": "Otwórz prompty",
        "menu": "Prompty…",
        "placeholder": "Szukaj promptów i wysłanych wiadomości",
        "favorites": "Ulubione",
        "library": "Biblioteka",
        "sentBefore": "Wysłane wcześniej",
        "builtIn": "Wbudowany",
        "readError": "Nie udało się odczytać promptu. Spróbuj ponownie.",
        "libraryError": "Nie udało się wczytać biblioteki.",
        "partialLibrary": "Nie udało się odczytać niektórych promptów.",
        "loadOlder": "Szukaj starszych wiadomości",
        "stop": "Zatrzymaj",
        "insert": "Wstaw",
        "send": "Wyślij teraz",
        "addFavorite": "Dodaj do ulubionych",
        "removeFavorite": "Usuń z ulubionych",
        "empty": "Zapisz wiadomość jako prompt, aby użyć jej tutaj ponownie.",
        "applyError": "Nie udało się zastosować promptu. Spróbuj ponownie.",
        "historyError": "Nie udało się wczytać starszych wiadomości. Spróbuj ponownie.",
        "title": "Prompty",
        "clear": "Wyczyść",
        "favorite": "Ulubiony",
        "favoritesInvite": "Oznacz gwiazdką prompt lub wysłaną wiadomość, aby trzymać ją tutaj.",
        "saveAsFavorite": "Zapisz jako ulubiony prompt",
        "saveInPlaceStarred": ({ time }: { time: string }) => `Z Twojej wiadomości sprzed ${time} · trafi do biblioteki z gwiazdką`,
        "saveInPlace": ({ time }: { time: string }) => `Z Twojej wiadomości sprzed ${time} · trafi do biblioteki`,
        "noMatchesFor": ({ query }: { query: string }) => `Żaden prompt ani wczytana wiadomość nie pasuje do „${query}”`,
        "previewInserts": "zostanie wstawiony, potem wysyłasz",
        "previewSent": "wysłane wcześniej",
        "previewEdited": ({ time }: { time: string }) => `Edytowano ${time}`,
        "searchingOlder": ({ searched, total }: { searched: number; total: number }) => `Przeszukiwanie starszych wiadomości… ${searched} z ${total} sesji`
    } } as const;

return { promptPickerTranslations };
})();

const Domain_actionFamilyTranslations = (() => {
const fileContentSearchTranslations = {...Domain_fileContentSearchTranslations.fileContentSearchTranslations, ...EnglishFeatures.fileContentSearchTranslations.fileContentSearchTranslations};

const promptPickerTranslations = {...Domain_promptPickerTranslations.promptPickerTranslations, ...EnglishFeatures.promptPickerTranslations.promptPickerTranslations};

const surfaceFamilyLabels = Shared_actionFamilyTranslations.surfaceFamilyLabels;

const english = Shared_actionFamilyTranslations.english;

const translated = Shared_actionFamilyTranslations.translated;

const actionFamilyTranslations = { pl: translated({
        actionFamilies: {
            ...surfaceFamilyLabels,
            workspace_file_search: fileContentSearchTranslations.pl.textInFiles,
            find: 'Znajdź',
            app_shell: 'Workspace',
            roles: 'Role',
            launch_profiles: 'Profile uruchamiania',
            discovery: 'Wyszukiwanie akcji',
            computer: 'Sterowanie komputerem',
            artifact_access: 'Udostępnianie artefaktów',
            workflows: 'Przepływy pracy',
            notifications: 'Powiadomienia',
            machine_agent_install: 'Instalacje agentów',
            machine_agent_sign_in: 'Logowanie agentów',
            session_access: 'Udostępnianie sesji',
            session_lifecycle: 'Cykl życia sesji',
            inventory: 'Spis komputerów',
            messaging: 'Wiadomości',
            session_control: 'Sterowanie sesją',
            intent_start: 'Recenzje i delegowanie',
            review_comments: 'Komentarze recenzji',
            subagent_registry: 'Podagenci',
            execution_run_control: 'Uruchomienia w tle',
            session_targeting: 'Wybór sesji',
            session_follow: 'Obserwowanie sesji',
            session_transcripts: 'Transkrypcje sesji',
            session_read_state: 'Stan przeczytania',
            session_attention: 'Uwaga',
            session_board: 'Tablica sesji',
            session_discussion: 'Dyskusje',
            session_permissions: 'Uprawnienia sesji',
            external_sessions: 'Sesje zewnętrzne',
            voice_controls: 'Sterowanie głosowe',
            current_ui_context: 'Bieżący ekran',
            companion_controls: 'Towarzysz',
            memory: 'Pamięć',
            agent_acp_catalog: 'Agenci ACP',
            prompt_library: 'Biblioteka promptów',
            daemon_admin: 'Administracja daemonem',
            browser_control: 'Sterowanie przeglądarką',
            browser_diagnostics: 'Diagnostyka przeglądarki',
            browser_context: 'Kontekst przeglądarki',
            browser_automation: 'Automatyzacja przeglądarki',
            browser_recording: 'Nagrywanie przeglądarki',
            local_services_inventory: 'Usługi lokalne',
            local_services_launcher: 'Uruchamianie usług',
            local_services_preview: 'Podglądy usług',
            local_services_public_preview: 'Podglądy publiczne',
            local_services_actions: 'Akcje usług',
            peer_mediation_observability: 'Diagnostyka połączeń',
            devices_simulator: 'Symulatory',
            approvals: 'Zatwierdzenia',
            plugin_dev_loop: 'Tworzenie wtyczek',
            plugin_settings_administration: 'Ustawienia wtyczek',
            plugin_permission_grants: 'Uprawnienia wtyczek',
            plugin_webhooks: 'Webhooki wtyczek',
            account_plugin_data: 'Dane wtyczek',
            account_sessions: 'Zalogowane urządzenia',
            account_security: 'Bezpieczeństwo konta',
            account_api_tokens: 'Tokeny API',
            identity_github_apps: 'Aplikacje GitHub',
            identity_providers: 'Dostawcy logowania',
            machine_pools: 'Pule komputerów',
            ephemeral_runner: 'Wykonawcy',
            automation_events: 'Zdarzenia automatyzacji',
            automation_conversation: 'Rozmowy automatyzacji',
            scm_git: 'Git',
            scm_pull_request: 'Pull requesty',
            scm_repository: 'Repozytoria',
            scm_diff_summary: 'Podsumowania zmian',
            home_governance: 'Administracja Home',
            teams: 'Zespoły',
            saved_secret_sharing: 'Udostępnione sekrety',
        },
    }) } as const;

return { actionFamilyTranslations };
})();

const Domain_addFlowsTranslations = (() => {
type AddFlowsTranslation = Shared_addFlowsTranslations.AddFlowsTranslation;

const addFlowsTranslations = { pl: {
        addHome: 'Dodaj Home',
        addHomeSubtitle: 'Zaloguj się, połącz przez adres lub użyj hostowanego',
        addHomeDescription: 'Połącz Home, którego już używasz, lub użyj hostowanego dla ciebie.',
        newGroup: 'Nowa grupa',
        newGroupSubtitle: 'Sesje kilku Home razem',
        groupsTitle: 'Grupy',
        homesInUse: 'Używany tutaj',
        thisDeviceTitle: 'To urządzenie',
        thisDeviceSubtitle: 'Jak łączy się ze swoimi Home',
        thisDeviceDescription: 'Jak to urządzenie łączy się ze swoimi Home: oczekujące urządzenia, używane połączenie i Home, który uruchamia.',
        newHomeDraft: 'Nowy Home',
        homeMissingTitle: 'Tego Home nie ma na tym urządzeniu',
        homeMissingDescription: 'Został usunięty lub zapisany na innym urządzeniu.',
        homeManageTitle: 'Zarządzaj',
        homeAdministrationSubtitle: 'Osoby, logowanie, dostęp i dane tego Home',
        groupMissingTitle: 'Ta grupa już nie istnieje',
        groupMissingDescription: 'Została usunięta. Twoje Home się nie zmieniły.',
        discard: 'Odrzuć',
        sshSignInAgent: 'Twój agent SSH na tym komputerze',
        sshSignInKeyFile: 'Plik klucza prywatnego na tym komputerze',
        sshSignInPassword: 'Użyte raz do połączenia; nigdy nie zapisywane',
        addMachineMenuSubtitle: 'Komputer lub serwer',
        addMachineDescription: 'Dodaj komputer lub serwer, aby agenci mogli uruchamiać na nim twoje sesje.',
        machineJoinsHome: ({ home }) => `Dołączy do ${home}`,
        pathThisComputerTitle: 'Ten komputer',
        pathThisComputerTask: 'Konfiguracja w jednym kroku',
        pathThisComputerCommand: 'Jedno polecenie w terminalu',
        pathSshTitle: 'Serwer przez SSH',
        pathSshChip: 'Serwer SSH',
        pathSshSubtitle: 'Maszyna dev, VM lub serwer w chmurze',
        pathAnotherTitle: 'Inny komputer',
        pathAnotherSubtitle: 'Otwórz link do Domu na tamtym komputerze',
        machinePoolPrompt: 'Chcesz, by sesje przechodziły między maszynami?',
        thisComputerCommandLead: ({ home }) => `Uruchom to w terminalu na tym komputerze. Zainstaluje Happier i dołączy do ${home}; ta strona od razu to zauważy.`,
        thisComputerTaskLead: ({ machine, home }) => `${machine} uruchomi agentów dla ${home}. Happier zainstaluje małą usługę w tle, która startuje z komputerem.`,
        setUpThisComputer: 'Skonfiguruj ten komputer',
        desktopAppHint: 'Wolisz kliknąć niż pisać?',
        desktopAppLink: 'Pobierz aplikację na komputer — skonfiguruje go sama.',
        thisComputerRunningLead: ({ machine }) => `Konfigurujemy ${machine}. Możesz dalej korzystać z Happier.`,
        onAnotherHomeTitle: ({ machine }) => `${machine} jest połączony z innym Home`,
        onAnotherHomeBody: ({ home }) => `Jego usługa Happier obsługuje inny Home. Przeniesienie do ${home} zachowa ustawienia; istniejące sesje tam zostaną.`,
        moveToHome: ({ home }) => `Przenieś do ${home}`,
        keepOnOtherHome: 'Zostaw, gdzie jest',
        sshLeadTask: ({ home }) => `Maszyna dev, VM lub serwer w chmurze osiągalny przez SSH. Ten komputer się połączy, zainstaluje Happier i dołączy do ${home}.`,
        sshLeadCommand: ({ home }) => `Maszyna dev, VM lub serwer w chmurze osiągalny przez SSH. Uruchom polecenie na komputerze, który go widzi; zainstaluje Happier i dołączy do ${home}.`,
        setUpHost: ({ host }) => `Skonfiguruj ${host}`,
        sshSavedNote: 'Host zostanie zapisany w Zdalnych hostach; hasła nigdy.',
        sshRunningTitle: ({ host }) => `Konfigurujemy ${host}`,
        sshRunningLead: 'Działa przez SSH z tego komputera. Możesz wyjść; lista maszyn pokaże postęp i powie, gdy skończy.',
        anotherLead: ({ home }) => `Uruchom to w terminalu na tamtym komputerze. Zainstaluje Happier i dołączy do ${home}.`,
        anotherTerminalAction: 'Użyj zamiast tego polecenia terminala',
        machineWatching: ({ subject }) => `Czekamy na ${subject} w `,
        subjectThisComputer: 'ten komputer',
        subjectAnotherComputer: 'komputer',
        machineNotSeeingTitle: ({ subject }) => `Wciąż nie widać: ${subject}?`,
        machineNotSeeingBody: ({ home }) => `Happier wciąż czeka. Zwykle konfiguracja zakończyła się błędem, maszyna nie widzi ${home} albo skonfigurowano ją dla innego Home.`,
        machineArrived: ({ machine }) => `${machine} jest połączony`,
        machineConnectedJustNow: 'połączono przed chwilą',
        machineStartSession: ({ machine }) => `Rozpocznij sesję na ${machine}`,
        machineAddAnother: 'Dodaj kolejną',
        cancelSetup: 'Anuluj',
        detectedOs: 'Wykryto',
        sshSuggestionsTitle: 'Z konfiguracji SSH i zapisanych hostów',
        connectingToHome: ({ address }) => `Łączenie z ${address}…`,
        pathThisComputerConnected: 'Połączony · jego agenci',
    } } satisfies Pick<Readonly<Record<string, AddFlowsTranslation>>, "pl">;

return { addFlowsTranslations };
})();

const Domain_agentInstallJobTranslations = (() => {
const en = Shared_agentInstallJobTranslations.en;

const agentInstallJobTranslations = { pl: { ...en } };

return { agentInstallJobTranslations };
})();

const Domain_agentStartTranslations = (() => {
const en = Shared_agentStartTranslations.en;

const pl: typeof en = {
    titles: {
        conversation: 'Rozmowa obok',
    },
    descriptions: {
        conversation: ({ machine }) => `Zapytaj o cokolwiek bez przerywania tej sesji. Działa na ${machine} obok; nic nie wraca, dopóki tego nie wyślesz.`,
    },
    chips: {
        engineTitle: 'Kto odpowiada',
        addReviewer: 'Dodaj recenzenta',
        removeReviewer: ({ name }) => `Usuń ${name}`,
        scope: 'Co sprawdzić',
        advanced: 'Zaawansowane',
    },
    reportToSession: 'Zgłoś do tej sesji',
    startsWhenYouSend: ({ count }) => count > 1 ? `${count} recenzji zacznie się po wysłaniu` : 'Zacznie się po wysłaniu',
    offline: ({ machine }) => `${machine} jest offline. Agent startuje tam; szkic zostaje tutaj, aż wróci.`,
    menu: {
        askSection: 'Poproś agenta',
        secondOpinionTitle: 'Druga opinia',
        secondOpinionSubtitle: 'Niezależne sprawdzenie przed zakończeniem',
        keepGoingTitle: 'Kontynuuj do końca…',
        keepGoingSubtitle: 'Ustaw cel w kontrolce celu',
        runWorkflowTitle: 'Uruchom przepływ pracy',
        runWorkflowSubtitle: 'Z biblioteki lub wbudowany',
        searchWorkflows: 'Szukaj przepływów…',
        yourLibrary: 'Twoja biblioteka',
        noWorkflows: 'Brak zapisanych przepływów',
        addTriggerTitle: 'Dodaj wyzwalacz…',
        addTriggerSubtitle: 'Uruchamia się tu, gdy coś się stanie',
        advancedTitle: 'Zaawansowane…',
        advancedSubtitle: 'Kilku agentów, uprawnienia, profil',
        builtIn: 'Wbudowane',
        allWorkflows: 'Wszystkie przepływy pracy…',
    },
    role: {
        replaces: ({ agent }) => `Zastępuje ${agent}`,
    },
    startRow: {
        subtitle: 'Szkic · zacznie się po wysłaniu',
        conversation: 'Nowa rozmowa',
        review: 'Nowa recenzja',
        plan: 'Nowy plan',
        delegate: 'Nowe zadanie',
    },
    pane: {
        cancelRun: 'Anuluj uruchomienie',
        whenItFinishes: 'Gdy skończy',
        sendToSession: ({ session }) => `Wyślij do ${session}`,
        replyTo: ({ agent }) => `Odpowiedz ${agent}…`,
        repliesGoTo: ({ session }) => `Odpowiedzi trafiają do tego agenta, nie do ${session}`,
    },
};

const agentStartTranslations = { pl };

return { agentStartTranslations };
})();

const Domain_apiTokenSettingsTranslations = (() => {
const english = Shared_apiTokenSettingsTranslations.english;

const translated = Shared_apiTokenSettingsTranslations.translated;

const apiTokenSettingsTranslations = { pl: translated({
        settingsApiTokens: {
            encryption: {
                choice: "Dostęp do szyfrowania",
                consequence: "Przyznaje dostęp do szyfrowania całego konta. Unieważnienie zatrzymuje przyszłą autoryzację API; uzyskanych kluczy ani danych nie można odebrać.",
                enabled: "Dostęp do szyfrowania włączony",
                bearerOnly: "Tylko dostęp do API",
                unknown: "Dostęp do szyfrowania nieznany",
                outcomeUnknown: "Tworzenie mogło się zakończyć. Odśwież listę i unieważnij ten token przed świadomym utworzeniem nowego.",
                unsupported: "Ten Home nie obsługuje jeszcze szyfrowanych tokenów API. Zaktualizuj go lub utwórz zwykły token.",
                notReady: "Przywróć dostęp do szyfrowania na tym Home przed utworzeniem szyfrowanego tokenu.",
                stale: "Klucz szyfrowania konta uległ zmianie. Przywróć dostęp na tym Home.",
                idConflict: "Ten identyfikator tokenu już istnieje. Unieważnij dokładnie ten token przed utworzeniem nowego.",
            },
            unattended: {
                choice: "Nienadzorowany dostęp do zespołu",
                consequence: "Kopiuje do tokenu aktualnie zweryfikowane metody uwierzytelniania tego poświadczenia na potrzeby ograniczonej pracy zespołowej. Dostęp do szyfrowania jest niezależny.",
                authorized: "Nienadzorowany dostęp do zespołu autoryzowany",
                notAuthorized: "Brak nienadzorowanego dostępu do zespołu",
                evidenceLimit: "To poświadczenie ma zbyt wiele zweryfikowanych metod uwierzytelniania do skopiowania. Token nie został utworzony.",
                evidenceUnavailable: "To zalogowane poświadczenie nie ma aktualnego dowodu uwierzytelnienia do skopiowania. Uwierzytelnij się ponownie wymaganą metodą; token nie został utworzony.",
            },
            title: 'Tokeny API',
            entrySubtitle: 'Pozwól skryptom, serwerom i osadzonym aplikacjom działać w Twoim imieniu, tylko z dostępem, który im dasz.',
            tokens: 'Tokeny API',
            refreshing: 'Odświeżanie…',
            emptyTitle: 'Nie masz jeszcze tokenów API',
            emptyBody: 'Tokeny pozwalają zaufanym skryptom i narzędziom wykonywać dozwolone przez Ciebie działania automatyczne. Utwórz token, gdy integracja potrzebuje dostępu do bieżącego konta.',
            created: 'Utworzono',
            lastUsed: 'Ostatnio użyty',
            neverUsed: 'Nigdy nieużyty',
            securityTitle: 'Bezpieczeństwo',
            securityFooter: 'Te działania obowiązują na całym bieżącym koncie.',
            status: {
                active: 'Aktywny',
                expiresInMinutes: ({ count }) => `Wygasa za ${count} min`,
                expiresInHours: ({ count }) => `Wygasa za ${count} godz.`,
                expiresInDays: ({ count }) => `Wygasa za ${count} dni`,
                expired: 'Wygasł',
            },
            rowAccessibilityLabel: ({ label, state }) => `${label}, stan: ${state}`,
            moreActionsAccessibilityLabel: ({ label }) => `Więcej działań dla: ${label}`,
            create: {
                button: 'Utwórz token',
                title: 'Utwórz token API',
                subtitle: 'Nadaj integracji nazwę i wybierz, kiedy token wygaśnie. Zwykłe żądania i wyniki API są czytelne dla Twojego Home; dostęp do szyfrowania może chronić obsługiwane wywołania SDK.',
                submit: 'Utwórz token',
                label: 'Etykieta',
                labelPlaceholder: 'Automatyzacja wydań',
                expiry: 'Wygasa',
                expiryOptions: {
                    '30d': '30 dni',
                    '90d': '90 dni',
                    '1y': '1 rok',
                    none: 'Bez daty wygaśnięcia',
                },
                access: 'Dostęp',
                accessFull: 'Pełny dostęp',
                accessLimited: 'Ograniczony',
                accessLimitedDescription: 'Następnie wybierz działania, sesje, modele i witryny.',
                accessTitle: 'Wybierz dostęp',
                continue: 'Dalej',
                back: 'Wstecz',
                actionSettingsPrefix: 'Ten token może wykonywać wszystkie działania włączone dla External API & SDK w Twoich',
                actionSettingsLink: 'Ustawieniach akcji.',
            },
            reveal: {
                title: 'Zapisz token API',
                accessibilityAnnouncement: 'Skopiuj token teraz — jest wyświetlany tylko raz.',
                successTitle: 'Utworzono token',
                shownOnce: 'Skopiuj ten token teraz. Ze względów bezpieczeństwa Happier nie może wyświetlić go ponownie.',
                copy: 'Kopiuj token',
                copied: 'Skopiowano',
                dismissTitle: 'Wyjść bez potwierdzenia?',
                dismissBody: 'Ten token nie będzie pokazany ponownie. Najpierw go skopiuj albo potwierdź, że zapisałeś go w bezpiecznym miejscu.',
                copyFirst: 'Pozostaw token widoczny',
                savedIt: 'Zapisałem go',
            },
            revoke: {
                title: ({ label }) => `Unieważnić „${label}”?`,
                body: 'Dostęp do serwera i API zostanie zatrzymany przy następnej weryfikacji. Lokalny daemon, który niedawno zweryfikował ten token API, może nadal akceptować go przez maksymalnie minutę. Tej czynności nie można cofnąć.',
                confirm: 'Unieważnij token',
            },
            revokeAll: {
                title: 'Unieważnij wszystkie tokeny API',
                subtitle: 'Wyłącz wszystkie tokeny API dla tego konta.',
                body: 'Dostęp do serwera i API zostanie zatrzymany przy następnej weryfikacji. Osadzenia korzystające z tych tokenów przestaną działać, a ich osadzone poświadczenia zostaną wylogowane. Lokalne daemony, które niedawno zweryfikowały te tokeny API, mogą nadal akceptować je przez maksymalnie minutę. Tej czynności nie można cofnąć.',
                confirm: 'Unieważnij wszystkie',
                railAction: 'Unieważnij wszystkie tokeny API…',
            },
            signOutEverywhere: {
                title: 'Wyloguj wszędzie',
                subtitle: 'Zakończ wszystkie zalogowane sesje tego konta.',
                body: 'Wszystkie zalogowane sesje w przeglądarkach i na urządzeniach zostaną zakończone. Tokeny API pozostaną aktywne; unieważnij je osobno z tego ekranu.',
                confirm: 'Wyloguj wszędzie',
            },
            errors: {
                labelRequired: 'Wprowadź etykietę przed utworzeniem tokenu.',
                accountChanged: 'Twoje aktywne konto lub Home się zmieniło, więc nic nie zostało zmienione. Otwórz to ponownie, aby kontynuować.',
                presentUserRequired: 'Potwierdź swoją tożsamość w monicie logowania, a potem spróbuj ponownie.',
                offline: 'Happier nie mógł połączyć się z Twoim kontem. Sprawdź połączenie i spróbuj ponownie.',
                unavailable: 'To działanie jest teraz niedostępne. Spróbuj ponownie za chwilę.',
                copyFailed: 'Nie udało się skopiować tokenu. Zaznacz go i skopiuj ręcznie przed zamknięciem.',
                listTitle: 'Tokeny API są niedostępne',
                grantIncomplete: 'Dokończ wybieranie dostępu przed utworzeniem tokenu.',
            },
            embedPill: 'Osadzenie',
            embedRowHint: 'Otwiera to osadzenie w Ustawieniach, w sekcji Osadzenia.',
            summary: {
                full: 'Pełny dostęp',
                allActions: 'Każde działanie',
                namesAndMore: ({ names, count }) => `${names} +${count}`,
                sessions: ({ count }) => (count === 1 ? '1 sesja' : `${count} ${count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'sesje' : 'sesji'}`),
                computers: ({ count }) => (count === 1 ? '1 komputer' : `${count} ${count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'komputery' : 'komputerów'}`),
                approve: 'Może zatwierdzać',
                models: ({ count }) => (count === 1 ? '1 model' : `${count} ${count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'modele' : 'modeli'}`),
                websites: ({ count }) => (count === 1 ? '1 witryna' : `${count} ${count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'witryny' : 'witryn'}`),
                content: 'Dostęp do treści',
                noExpiry: 'Bez wygaśnięcia',
                expires: ({ date }) => `Wygasa ${date}`,
                expired: ({ date }) => `Wygasł ${date}`,
            },
            grant: {
                accessTitle: 'Dostęp',
                back: 'Dostęp',
                onlyThese: 'Tylko wybrane',
                selectedCount: ({ count }) => (count === 1 ? '1 wybrany' : `Wybrano: ${count}`),
                reviewUnnamed: 'Ten token',
                actions: {
                    title: 'Działania',
                    all: 'Każde działanie',
                    none: 'Wybierz co najmniej jedno działanie',
                    search: 'Szukaj działań',
                    noMatches: ({ query }) => `Żadne działanie nie pasuje do „${query}”`,
                    groupDescription: 'Cała grupa obejmuje też działania dodane do niej później.',
                    familyCount: ({ count }) => (count === 1 ? 'Grupa · 1 działanie' : `Grupa · ${count} ${count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'działania' : 'działań'}`),
                    includedByFamily: ({ family }) => `Zawarte w ${family}`,
                },
                targets: {
                    title: 'Sesje i komputery',
                    all: 'Każda sesja i każdy komputer',
                    none: 'Wybierz co najmniej jedną sesję lub komputer',
                    computers: 'Komputery',
                    computersDescription: 'Komputer obejmuje każdą sesję na nim, teraz i w przyszłości.',
                    sessions: 'Sesje',
                    searchSessions: 'Szukaj sesji',
                    noSessions: 'Nie ma jeszcze sesji',
                    noSessionMatches: ({ query }) => `Żadna sesja nie pasuje do „${query}”`,
                    noComputers: 'Nie ma jeszcze komputerów',
                },
                models: {
                    title: 'Modele',
                    any: 'Dowolny model',
                    onlyThese: 'Tylko te modele',
                    none: 'Wybierz co najmniej jeden model',
                    pickerDescription: 'Inne modele są odrzucane, a nie tylko ukrywane. Opcja „Automatycznie” nie jest dostępna po wybraniu modeli.',
                    noModels: 'Nie ma jeszcze modeli do wyboru',
                },
                approve: {
                    title: 'Zatwierdzanie próśb',
                    on: 'Może zatwierdzać użycie narzędzi i prośby w powyższych sesjach — również te, które sam uruchomił. Nigdy nie może zmieniać tokenów, zabezpieczeń ani wtyczek.',
                    off: 'Prośby czekają na Ciebie w Happier.',
                },
                websites: {
                    title: 'Witryny',
                    description: 'Strony w tych witrynach mogą używać tokenu z przeglądarki. Zostaw puste dla skryptów i serwerów.',
                    inputLabel: 'Dodaj witrynę',
                    placeholder: 'https://app.example.com',
                    add: 'Dodaj',
                    invalid: 'Zacznij od https:// albo od http:// dla localhost.',
                    duplicate: 'Ta witryna jest już na liście.',
                    remove: ({ origin }) => `Usuń ${origin}`,
                },
            },
            detail: {
                whatItCanDo: 'Co może robić',
                whatItCanDoDescription: 'Działania, które ten token może wykonywać za Ciebie. Wszystko inne jest odrzucane.',
                everyAction: 'Każde działanie włączone dla External API & SDK',
                wholeGroup: 'Cała grupa',
                where: 'Gdzie',
                whereDescription: 'Sesje i komputery, do których ma dostęp.',
                computerCovers: 'Każda sesja na tym komputerze',
                unknownComputer: 'Komputer, którego nie ma już na liście',
                unknownSession: 'Sesja, której nie ma już na liście',
                modelsDescription: 'Inne modele są odrzucane, a nie tylko ukrywane.',
                approvals: 'Zatwierdzenia',
                approvesOn: 'Zatwierdza prośby',
                approvesOff: 'Nie zatwierdza próśb',
                websitesDescription: 'Strony z tych witryn mogą go używać w przeglądarce.',
                noWebsites: 'Tylko skrypty i serwery',
                content: 'Dostęp do treści',
                contentOn: 'Może odczytywać treści szyfrowane end-to-end przez obsługiwane wywołania SDK.',
                contentOff: 'Nie może odczytywać treści szyfrowanych end-to-end.',
                children: 'Osadzone poświadczenia',
                childrenDescription: 'Krótkotrwałe klucze, które Twoja aplikacja wygenerowała z tego tokenu dla swoich stron.',
                childrenCount: ({ count }) => (count === 1 ? '1 aktywne' : `Aktywne: ${count}`),
                childrenConsequence: 'Zostają wylogowane, gdy edytujesz dostęp lub unieważnisz ten token.',
                sessionLimits: 'Sesje',
                sessionLimitsDescription: 'Sesje, które może uruchamiać, i tryby uprawnień, których mogą używać jego wiadomości.',
                createsSessions: 'Uruchamia sesje',
                createsSessionsOn: ({ computer }: { computer: string }) => `Na ${computer}, w prywatnym folderze zarządzanym przez Happier.`,
                editAccess: 'Edytuj dostęp',
                revokeFootnote: 'Skrypty i osadzenia, które go używają, przestaną działać przy następnym żądaniu.',
                created: ({ date }) => `Utworzono ${date}`,
                lastUsed: ({ date }) => `Ostatnio użyto ${date}`,
                missingTitle: 'Tego tokenu już nie ma',
                missingBody: 'Został unieważniony lub wygasł i został usunięty. Pozostałe tokeny są nadal na liście.',
                backToTokens: 'Pokaż tokeny API',
            },
            edit: {
                title: 'Edytuj dostęp',
                save: 'Zapisz',
                signsOut: 'Aktywne osadzone poświadczenia zostaną wylogowane.',
            },
            cliPolicy: {
                sectionTitle: 'CLI i daemon',
                sectionDescription: 'Co polecenia na Twoich komputerach mogą robić z Twoim logowaniem.',
                title: 'Zezwalaj na zatwierdzenia i zmiany konta z CLI i daemona',
                description: 'Pozwala poleceniom na Twoich komputerach zatwierdzać prośby i zmieniać ustawienia konta. Wyłącz, jeśli agenci działają z dostępem do powłoki. Komputer może też zrezygnować za pomocą HAPPIER_CLI_PRESENT_USER=disallowed. Zmiana na chwilę ponownie łączy Twoje komputery.',
                unavailable: 'Nie udało się odczytać tego ustawienia. Spróbuj ponownie za chwilę.',
                saveFailed: 'Nie udało się zmienić tego ustawienia. Spróbuj ponownie za chwilę.',
            },
            notices: {
                revoked: 'Token API unieważniony.',
                revokedAll: 'Unieważniono wszystkie tokeny API.',
                signedOutEverywhere: 'Wylogowano wszędzie. Tokeny API pozostają aktywne.',
            },
        },
    }) } as const;

return { apiTokenSettingsTranslations };
})();

const Domain_artifactsBrowserTranslations = (() => {
type ArtifactsBrowserTranslations = Shared_artifactsBrowserTranslations.ArtifactsBrowserTranslations;

const artifactsBrowserTranslations = { pl: {
        description: 'To, co zapisałeś ty i twoi agenci — gotowe do czytania, ponownego użycia i udostępniania.',
        newDocument: 'Nowy dokument',
        searchPlaceholder: 'Szukaj artefaktów',
        kindLabel: 'Rodzaj',
        kinds: {
            all: 'Wszystkie rodzaje',
            document: 'Dokumenty',
            prompt: 'Prompty',
            board: 'Tablice',
            workflow: 'Przepływy pracy',
            role: 'Role',
            launchProfile: 'Profile uruchamiania',
        },
        kindOne: {
            document: 'Dokument',
            prompt: 'Prompt',
            board: 'Tablica',
            workflow: 'Przepływ pracy',
            role: 'Rola',
            launchProfile: 'Profil uruchamiania',
        },
        sort: {
            label: 'Sortuj',
            updated_desc: 'Ostatnio zmienione',
            created_desc: 'Ostatnio utworzone',
            title_asc: 'Tytuł',
        },
        view: {
            label: 'Widok',
            grid: 'Siatka',
            list: 'Lista',
        },
        provenance: {
            savedByYou: 'Zapisane przez ciebie',
            sharedWithYou: 'Udostępnione tobie',
            fromFile: ({ name }) => `Z ${name}`,
            openSession: ({ session }) => `Otwórz ${session}`,
        },
        emptyTitle: 'Zachowaj to, co tworzą twoi agenci',
        emptyBody: 'Plany, notatki, kod i tablice zapisane przez ciebie lub agentów trafiają tutaj — czytelne na każdym urządzeniu i gotowe do udostępnienia zespołom.',
        emptyHint: 'Albo poproś agenta: „zapisz to jako artefakt”.',
        loadFailedTitle: 'Nie udało się wczytać artefaktów',
        loadFailedBody: 'Sprawdź połączenie i spróbuj ponownie. Nic nie zostało utracone.',
        quota: {
            accountTitle: 'Miejsce na artefakty jest pełne',
            documentTitle: 'Za duży, aby zapisać',
            accountBody: ({ used, limit }) => `Użyto ${used} z ${limit}, wliczając wersje. Usuń lub wyeksportuj niepotrzebne artefakty, aby zapisywać nowe.`,
            documentBody: ({ size, limit }) => `Miałby ${size}; każdy artefakt mieści do ${limit}. Twoje zmiany wciąż tu są.`,
        },
        open: {
            document: 'Otwórz dokument',
            prompt: 'Otwórz prompt',
            board: 'Otwórz tablicę',
            workflow: 'Otwórz przepływ pracy',
            role: 'Otwórz rolę',
            launchProfile: 'Otwórz profil uruchamiania',
        },
        openAsPage: 'Otwórz jako stronę',
        actions: {
            edit: 'Edytuj',
            history: 'Historia',
            share: 'Udostępnij',
            more: 'Więcej działań',
            copyLink: 'Kopiuj link',
            linkCopied: 'Skopiowano link',
        },
        history: {
            title: 'Historia',
            current: 'Bieżąca',
            now: 'Teraz',
            restoreNote: 'Przywrócenie doda ją jako nową wersję. Nic nie zostanie utracone.',
            loadFailed: 'Nie udało się wczytać historii. Spróbuj ponownie.',
            empty: 'Brak wcześniejszych wersji. Każdy zapis zachowuje jedną.',
            versionsLabel: 'Wersje',
            restoreFailed: 'Nie udało się przywrócić tej wersji. Spróbuj ponownie.',
            savedByUser: 'Zapisane przez użytkownika',
            savedByAgentSession: 'Zapisane przez sesję agenta',
            restoredVersion: ({ n }) => `Przywrócone z wersji ${n}`,
            version: ({ n }) => `Wersja ${n}`,
            keeps: ({ count }) => `Przechowuje ostatnie wersje: ${count}.`,
            restore: ({ n }) => `Przywróć wersję ${n}`,
        },
        savedToday: ({ count }) => `Zapisane dziś: ${count}`,
        noMatch: ({ query }) => `Brak artefaktów pasujących do „${query}”`,
        storage: {
            meter: ({ used, limit }) => `${used} z ${limit}`,
            a11y: ({ used, limit }) => `Miejsce na artefakty: użyto ${used} z ${limit}`,
        },
        facts: {
            edited: ({ age }) => `Zmieniono ${age}`,
        },
    } } satisfies Pick<Record<'en' | 'fr' | 'de' | 'es' | 'it' | 'pt' | 'ca' | 'ru' | 'pl' | 'ja' | 'zh-Hans' | 'zh-Hant', ArtifactsBrowserTranslations>, "pl">;

return { artifactsBrowserTranslations };
})();

const Domain_automationPageTranslations = (() => {
const english = Shared_automationPageTranslations.english;

const translated = Shared_automationPageTranslations.translated;

const slavicPlural = Shared_automationPageTranslations.slavicPlural;

const automationPageTranslations = { pl: translated({
        automationPages: {
            index: {
                description: 'Praca, która startuje sama: według harmonogramu, z Eventu albo po zakończeniu tury sesji.',
            },
            settings: {
                description: 'Ile pracy automatyzacji przyjmuje każda maszyna i jak długo przechowywane są zakończone uruchomienia.',
                capacityTitle: 'Pojemność',
                capacityDescription: 'Dotyczy każdej maszyny, która uruchamia automatyzacje.',
                historyTitle: 'Historia uruchomień',
                historyDescription: 'Zakończone uruchomienia, które nadal możesz otworzyć z automatyzacji.',
            },
            detail: {
                description: 'Sama zaczyna pracę, gdy zadziała którykolwiek z jej wyzwalaczy.',
                triggerCount: ({ count }: { count: number }) => `${count} ${slavicPlural(count, 'wyzwalacz', 'wyzwalacze', 'wyzwalaczy')}`,
                overviewDescription: 'Co uruchamia oraz jak ją uruchomić lub zmienić.',
                runNowSubtitle: 'Uruchom teraz, bez czekania na wyzwalacz.',
                editSubtitle: 'Zmień nazwę, to, co uruchamia, i wyzwalacze.',
                machineAssignmentsDescription: 'Maszyny, które mogą przejmować uruchomienia tej automatyzacji.',
            },
            run: {
                description: 'Co rozpoczęło to uruchomienie, gdzie działało i co wytworzyło.',
                statusTitle: 'Stan',
                statusDescription: 'Na jakim etapie jest to uruchomienie i co jeszcze możesz z nim zrobić.',
                causeTitle: 'Co je rozpoczęło',
                causeDescription: 'Wyzwalacz i zdarzenie, które dopuściły to uruchomienie. Później się nie zmieniają.',
            },
            gate: {
                serverTitle: 'Automatyzacje są wyłączone w tym Home',
                serverBody: 'Administratorzy tego Home wyłączyli automatyzacje. Poproś jednego z nich o ich ponowne włączenie.',
                openFeatures: 'Otwórz ustawienia funkcji',
                unknownTitle: 'Nie można teraz sprawdzić automatyzacji',
                unknownBody: 'Happier nie mógł połączyć się z tym Home, aby sprawdzić, czy automatyzacje są włączone. Sprawdź ponownie, gdy wróci do sieci.',
                unsupportedTitle: 'Ten Home nie obsługuje jeszcze automatyzacji',
                unsupportedBody: 'Jego serwer jest starszy niż automatyzacje. Zaktualizuj serwer Home, aby z nich korzystać.',
                unsupportedContextTitle: 'Automatyzacje nie są tu dostępne',
                unsupportedContextBody: 'Nie wszystkie przeglądane Home obsługują automatyzacje.',
            },
            editor: {
                description: 'Nazwij ją, wybierz, co uruchamia, a potem dodaj wyzwalacze, które ją startują.',
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

const automationTriggerSetTranslations = { pl: {
        pluralEditor: {
            ...expandedLifecycleEnglish,
            lifecycleEvent: {
                ...expandedLifecycleEnglish.lifecycleEvent,
                sessionStarted: 'Gdy rozpoczyna się sesja',
                sessionArchived: 'Gdy sesja zostaje zarchiwizowana',
            },
            triggersTitle: 'Wyzwalacze',
            emptyBody: 'Brak automatycznych wyzwalaczy. Nadal możesz uruchomić tę automatyzację ręcznie.',
            orSemantics: 'Dodaj dowolną liczbę wyzwalaczy. Działają niezależnie — automatyzacja uruchomi się, gdy zadziała którykolwiek z nich.',
            enabledSubtitle: 'Wstrzymaj całą automatyzację bez zmieniania wyzwalaczy.',
            addTrigger: 'Dodaj wyzwalacz',
            addTriggerSubtitle: 'Ustaw harmonogram, połącz zdarzenie albo zaczekaj na zakończenie jednego konkretnego przebiegu.',
            scheduleTitle: 'Harmonogram', eventTitle: 'Zdarzenie wtyczki', turnCompletedTitle: 'Gdy zakończy się ten przebieg',
            turnCompletedSubtitle: 'Uruchamia się raz po zakończeniu dokładnie wybranego przebiegu nadrzędnego.', selectedSession: 'Wybrana sesja',
            turnCompletedSource: ({ session, ordinal }: { session: string; ordinal: number }) => `${session} · wyzwalacz jednorazowy ${ordinal}`,
            scheduleInterval: ({ minutes, timezone }: { minutes: number; timezone: string | null }) => `Co ${minutes} min${timezone ? ` · ${timezone}` : ''}`,
            scheduleCron: ({ expression, timezone }: { expression: string; timezone: string | null }) => `${expression}${timezone ? ` · ${timezone}` : ''}`,
            eventSubtitle: ({ pluginId, eventId }: { pluginId: string; eventId: string }) => `${pluginId} · ${eventId}`,
            triggerEnabledLabel: ({ title }: { title: string }) => `Włącz: ${title}`,
            editScheduleTitle: 'Edytuj harmonogram', scheduleType: 'Typ harmonogramu', chooseSession: 'Wybierz aktywną sesję',
            eventEditorUnavailable: 'Konfiguracja zdarzenia jest niedostępna na bieżącej maszynie.', removeTitle: 'Usunąć ten wyzwalacz?',
            removeBody: 'Przyszłe zdarzenia z tego wyzwalacza przestaną uruchamiać automatyzację. Historia uruchomień pozostanie bez zmian.',
        },
        exactTurn: {
            eventSearchPlaceholder: 'Szukaj zdarzeń',
            refreshFailedTitle: 'Nie udało się odświeżyć automatyzacji',
            refreshFailedBody: 'Nie udało się teraz odczytać listy automatyzacji. Spróbuj ponownie, aby wczytać bieżącą listę.',
            actionTitle: 'Gdy zakończy się ten przebieg…', createNew: 'Utwórz nową automatyzację',
            createNewSubtitle: 'Zacznij z już wybranym dokładnie tym przebiegiem.', addToExistingSubtitle: 'Dodaj ten przebieg do istniejącej automatyzacji.',
            searchPlaceholder: 'Szukaj automatyzacji', eventListA11y: 'Wybierz zdarzenie cyklu życia sesji', destinationA11y: 'Wybierz, gdzie dodać wyzwalacz tego przebiegu', staleTitle: 'Przebieg się zmienił',
            staleBody: 'Wybrany przebieg nie jest już aktywnym przebiegiem nadrzędnym. Odśwież i jawnie wybierz bieżący przebieg.',
            useCurrentTurn: 'Użyj bieżącego przebiegu', unavailable: 'Nie ma teraz aktywnego przebiegu nadrzędnego.',
            resolvingRowSubtitle: 'Sprawdzanie, których automatyzacji możesz użyć…',
            unavailableRowSubtitle: 'Szczegóły niedostępne — nie można zweryfikować tej automatyzacji dla tej sesji.',
            incompleteNoticeTitle: 'Nie udało się odczytać niektórych automatyzacji',
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

const pl: BoardsTranslations = {
    title: 'Tablice',
    newBoard: 'Nowa tablica',
    defaultName: 'Tablica bez nazwy',
    index: {
        title: 'Twoje tablice',
        body: 'Tablica trzyma sesje, uruchomienia, przepływy pracy i maszyny na żywo w jednym miejscu, ułożone po Twojemu.',
    },
    notFound: {
        title: 'Tej tablicy już nie ma',
        body: 'Została usunięta albo należy do Home, który nie jest tu połączony.',
    },
    meta: {
        needYou: ({ count }) => `${count} czeka na Ciebie`,
        items: ({ count }) => `${count} ${slavicPlural(count, 'element', 'elementy', 'elementów')}`,
        handPicked: 'Wybrane ręcznie',
        empty: 'Pusta',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: 'Czeka na Ciebie', description: 'Wszystko, co na Ciebie czeka' },
        running: { title: 'Działa teraz', description: 'Trwające uruchomienia przepływów pracy' },
        my_machines: { title: 'Moje maszyny', description: 'Obecność i to, co działa na każdej' },
        filter: { title: 'Sesje', description: 'Wszystkie aktywne sesje' },
    },
    header: {
        layoutA11y: 'Układ tablicy',
        canvas: 'Kanwa',
        byStatus: 'Wg statusu',
        add: 'Dodaj do tablicy',
        settings: 'Ustawienia tablicy',
    },
    kinds: {
        session: 'Sesja',
        workflow_run: 'Uruchomienie przepływu pracy',
        workflow: 'Przepływ pracy',
        machine: 'Maszyna',
    },
    card: {
        untitled: 'Niedostępny element',
        unavailable: 'Niedostępne',
        unavailableBody: 'Jego Home nie jest połączony na tym urządzeniu. Element zostaje na tablicy.',
        notLoaded: 'Jeszcze nie wczytano',
        remove: 'Usuń z tablicy',
        moveHint: 'Klawisze strzałek przesuwają tę kartę po siatce.',
        moved: ({ x, y }) => `Przesunięto do ${x}, ${y}`,
        moveActions: { up: 'Przesuń w górę', down: 'Przesuń w dół', left: 'Przesuń w lewo', right: 'Przesuń w prawo' },
        machine: {
            online: 'Online',
            offline: 'Offline',
            running: ({ count }) =>
                count === 1 ? '1 sesja działa' : `${count} ${slavicPlural(count, 'sesja działa', 'sesje działają', 'sesji działa')}`,
            needYou: ({ count }) => `${count} czeka na Ciebie`,
            idle: 'Żadna sesja nie działa',
            offlineBody: 'Jej sesje czekają, aż wróci.',
        },
        workflow: {
            noRuns: 'Brak uruchomień',
            lastRun: ({ word, age }) => `Ostatnie uruchomienie ${age} · ${word}`,
            needYou: ({ count }) => `${count} czeka na Ciebie`,
        },
        run: {
            waitingForYou: 'Czeka na Twoją recenzję',
            started: ({ age }) => `Uruchomiono ${age}`,
        },
    },
    canvas: {
        snapsHere: 'Przyciąga się tutaj',
        snapOnceHint: 'Przytrzymaj ⇧, by raz przyciągnąć do siatki',
    },
    settings: {
        title: 'Ustawienia tablicy',
        name: 'Nazwa',
        whatsOn: 'Co jest na tej tablicy',
        whichSessions: 'Które sesje',
        addedByHand: 'Dodane ręcznie',
        addedByHandNone: 'Jeszcze nic',
        add: 'Dodaj',
        layout: 'Układ',
        layoutDescription: 'Kanwa zachowuje Twój układ po przełączeniu.',
        snap: 'Przyciągaj do siatki',
        pin: 'Pokaż na liście sesji',
        pinDescription: 'Przypina tę tablicę nad Twoimi sesjami.',
        delete: 'Usuń tablicę',
        deleteConfirmTitle: 'Usunąć tę tablicę?',
        deleteConfirmBody: 'Znika tylko tablica. Jej sesje, uruchomienia, przepływy pracy i maszyny zostają bez zmian.',
    },
    add: {
        title: 'Dodaj do tablicy',
        search: 'Szukaj elementów',
        groups: { sessions: 'Sesje', workflows: 'Przepływy pracy', runs: 'Uruchomienia przepływów pracy', machines: 'Maszyny' },
        onBoard: 'Na tej tablicy',
        addHint: 'Dodaj',
        addAndPlaceHint: 'Dodaj i umieść',
        empty: 'Nic nie pasuje.',
    },
    empty: {
        title: 'Wybierz, co pokazuje ta tablica',
        body: 'Dodaj ręcznie sesje, przepływy pracy, uruchomienia lub maszyny albo pokaż sekcję, np. Czeka na Ciebie. Ty je układasz; tablica trzyma je na żywo.',
        action: 'Dodaj do tablicy',
    },
    widgets: {
        group: 'Widżety',
        kind: 'Widżet',
        gallery: 'Otwórz galerię',
        galleryHint: 'Wszystkie widżety z podglądem na żywo',
        addHint: 'Tylko ty widzisz swoje tablice',
        widthOne: 'Jedna karta',
        widthTwo: 'Dwie karty',
        moveEarlier: 'Przesuń wcześniej',
        moveLater: 'Przesuń później',
        remove: 'Usuń z tablicy',
        menuA11y: ({ widget }) => `Opcje: ${widget}`,
        arrived: ({ count }) => (count === 1 ? 'Właśnie dodano 1 widżet' : `Właśnie dodano ${count} ${slavicPlural(count, 'widżet', 'widżety', 'widżetów')}`),
        undo: 'Cofnij',
        dismiss: 'Odrzuć',
    },
    saveFailed: {
        tooLarge: 'Ta tablica przekracza limit przechowywania tablic. Usuń kilka elementów i spróbuj ponownie.',
        notFound: 'Ta tablica została usunięta na innym urządzeniu.',
        generic: 'Twoja zmiana nie dotarła do konta, więc tablica została bez zmian.',
        retry: 'Spróbuj ponownie',
        dismiss: 'Odrzuć',
        createTitle: 'Ta tablica nie została utworzona',
    },
};

const boardsTranslations = { pl };

return { boardsTranslations };
})();

const Domain_browserPresenceTranslations = (() => {
type AgentParams = Shared_browserPresenceTranslations.AgentParams;

type BrowserPresenceTranslations = Shared_browserPresenceTranslations.BrowserPresenceTranslations;

const browserPresenceTranslations = { pl: {
        agentFallbackName: 'Agent',
        agentBrowsing: ({ agent }) => `${agent} przegląda strony`,
        clickTarget: ({ target }) => `Klika „${target}”`,
        doing: {
            click: 'Klika na stronie',
            type: 'Pisze',
            fill: 'Wypełnia pole',
            scroll: 'Przewija',
            navigate: 'Otwiera stronę',
            history: 'Porusza się po historii',
            reload: 'Odświeża stronę',
            press: 'Naciska klawisz',
            select: 'Wybiera opcję',
            drag: 'Przeciąga',
            upload: 'Przesyła plik',
            look: 'Przegląda stronę',
            other: 'Pracuje na stronie',
        },
        takeControl: 'Przejmij sterowanie',
        stopping: ({ agent }) => `Zatrzymywanie: ${agent}…`,
        stoppingDetail: 'Kończy ostatnią czynność',
        lastActionMayHaveLanded: ({ agent }) => `Ostatnia czynność (${agent}) mogła zostać wykonana`,
        youHaveControl: 'Masz sterowanie',
        stopUnconfirmed: 'Nie udało się potwierdzić zatrzymania',
        checkAgain: 'Sprawdź ponownie',
        pausedUntilHandBack: ({ agent }) => `${agent} czeka, aż oddasz sterowanie`,
        handBack: 'Oddaj',
        stream: {
            connectingTitle: ({ agent }) => `Łączenie z przeglądarką: ${agent}`,
            connectingBody: ({ machine }) => `Działa na ${machine}. Strona pojawi się tu, gdy dotrze pierwsza klatka.`,
            stalled: 'Ostatnia klatka · ponowne łączenie',
            endedTitle: ({ agent }) => `${agent} zamknął tę przeglądarkę`,
            endedBody: 'Strona nie jest już tu pokazywana.',
            unavailableTitle: ({ agent }) => `Nie można tu pokazać przeglądarki: ${agent}`,
            unavailableBody: ({ agent }) => `${agent} nadal przegląda; jego działania wciąż pojawiają się w czacie.`,
            tryAgain: 'Spróbuj ponownie',
            inputA11y: 'Strona. Stuknij, przewiń lub pisz, aby przejąć sterowanie.',
        },
        recording: {
            elapsedA11y: ({ elapsed }) => `Nagrywanie, ${elapsed}`,
            discard: 'Odrzuć nagranie',
        },
        openInYourBrowser: 'Otwórz w przeglądarce',
        slowPage: 'Ta strona ładuje się dłużej',
    } } satisfies Pick<Record<string, BrowserPresenceTranslations>, "pl">;

return { browserPresenceTranslations };
})();

const Domain_browserToolTranslations = (() => {
type TargetParams = Shared_browserToolTranslations.TargetParams;

type BrowserToolTranslations = Shared_browserToolTranslations.BrowserToolTranslations;

const browserToolTranslations = { pl: {
        opened: ({ page }) => `Otworzono ${page}`,
        openedPage: 'Otworzono stronę',
        reloaded: 'Odświeżono stronę',
        wentBack: 'Cofnięto',
        wentForward: 'Przejście dalej',
        clicked: ({ target }) => `Kliknięto ${target}`,
        clickedPage: 'Kliknięto na stronie',
        typedInto: ({ target }) => `Wpisano w ${target}`,
        typed: 'Wpisano na stronie',
        filledIn: ({ target }) => `Wypełniono ${target}`,
        filled: 'Wypełniono pole',
        pressed: ({ key }) => `Naciśnięto ${key}`,
        pressedKey: 'Naciśnięto klawisz',
        scrolled: 'Przewinięto stronę',
        pointedAt: ({ target }) => `Wskazano ${target}`,
        pointed: 'Wskazano stronę',
        choseIn: ({ target }) => `Wybrano opcję w ${target}`,
        chose: 'Wybrano opcję',
        uploadedTo: ({ target }) => `Przesłano plik do ${target}`,
        uploaded: 'Przesłano plik',
        dragged: ({ target }) => `Przeciągnięto ${target}`,
        draggedPage: 'Przeciągnięto na stronie',
        looked: 'Przejrzano stronę',
        screenshot: 'Zrobiono zrzut ekranu',
        recordingStarted: 'Rozpoczęto nagrywanie strony',
        recordingStopped: 'Zatrzymano nagrywanie',
        other: 'Użyto przeglądarki',
        watch: 'Zobacz',
        watchA11y: 'Otwórz tę stronę w przeglądarce',
    } } satisfies Pick<Record<string, BrowserToolTranslations>, "pl">;

return { browserToolTranslations };
})();

const Domain_changedFileEvidenceTranslations = (() => {
type ChangedFileEvidenceTranslations = Shared_changedFileEvidenceTranslations.ChangedFileEvidenceTranslations;

const en = Shared_changedFileEvidenceTranslations.en;

const translated = Shared_changedFileEvidenceTranslations.translated;

const changedFileEvidenceTranslations = { pl: {
        changedFileEvidence: translated({
            before: 'Przed',
            after: 'Po',
            binary: 'Plik binarny',
            truncated: 'Treść dowodu została ograniczona; pierwotny rozmiar i statystyki zmian są zachowywane, gdy są dostępne.',
            truncatedOldBytes: ({ count }) => `Pierwotna treść przed: ${count} bajtów`,
            truncatedNewBytes: ({ count }) => `Pierwotna treść po: ${count} bajtów`,
            truncatedDiffBytes: ({ count }) => `Pierwotna różnica: ${count} bajtów`,
            truncatedAddedLines: ({ count }) => `Dodane wiersze: ${count}`,
            truncatedRemovedLines: ({ count }) => `Usunięte wiersze: ${count}`,
            kind: {
                added: 'Dodano',
                modified: 'Zmodyfikowano',
                deleted: 'Usunięto',
                renamed: 'Zmieniono nazwę',
                copied: 'Skopiowano',
                unknown: 'Rodzaj zmiany niedostępny',
            },
            howDetermined: 'Jak to ustalono',
            howDeterminedForFile: ({ path }) => `Jak ustalono ${path}`,
            content: {
                exact: 'Dokładna zmiana w repozytorium',
                strong: 'Mocny dowód treści',
                best_effort: 'Przybliżony dowód treści',
            },
            attribution: {
                session_exact: 'Powiązane z tą sesją',
                session_likely: 'Prawdopodobnie zmienione przez tę sesję',
                session_possible: 'Możliwe, że zmienione przez tę sesję',
                unknown: 'Atrybucja sesji niedostępna',
            },
            reason: {
                provider_correlated: 'Agent zgłosił tę zmianę dla tej tury.',
                canonical_tool_correlated: 'Narzędzie różnic lub łatek powiązało tę zmianę z tą turą.',
                checkpoint_no_happier_overlap_observed: 'Punkt kontrolny nie zarejestrował nakładającej się tury Happier w tym procesie.',
                checkpoint_overlap_observed: 'Inna tura Happier nałożyła się na przedział przechwytywania punktu kontrolnego.',
                workspace_touched_path: 'Ta ścieżka została zmieniona w obszarze roboczym; to nie wskazuje sesji, która ją zmieniła.',
                unavailable: 'Dowody nie wskazują, która sesja wprowadziła tę zmianę.',
            },
            overlap: {
                observed: 'Inna tura Happier nałożyła się na tę kopię roboczą podczas przechwytywania. Obserwacje obejmują tylko ten proces; inne procesy i zewnętrzne zapisy nie są śledzone.',
                not_observed: 'W tym procesie nie zaobserwowano nakładającej się tury Happier. Inne procesy i zewnętrzne zapisy nie są śledzone; to nie dowodzi wyłącznego autorstwa.',
                unknown: 'Nakładanie się punktu kontrolnego jest nieznane. Inne procesy i zewnętrzne zapisy nie są śledzone.',
            },
            sources: {
                provider_native: 'Natywny raport zmian agenta',
                provider_tool: 'Raport narzędzia agenta',
                canonical_diff_tool: 'Dowód z narzędzia różnic',
                canonical_patch_tool: 'Dowód z narzędzia łatek',
                scm_checkpoint: 'Punkt kontrolny repozytorium',
                scm_reconciled: 'Uzgodniona migawka repozytorium',
                inferred: 'Ścieżka zmieniona w obszarze roboczym',
            },
        }),
    } } as const;

return { changedFileEvidenceTranslations };
})();

const Domain_cliPathExposureTranslations = (() => {
const en = Shared_cliPathExposureTranslations.en;

const pl = {
    title: 'Wiersz poleceń',
    footer: 'Happier Desktop dodaje i usuwa tylko te wpisy PATH, które sam utworzył. Wpisy dodane przez instalator powłoki pozostają nietknięte.',
    addTitle: 'Dodaj happier do PATH',
    addSubtitle: 'Udostępnij polecenie happier w nowych terminalach.',
    removeTitle: 'Usuń happier z PATH',
    removeSubtitle: 'Usuwa tylko wpisy PATH dodane przez Happier Desktop.',
    working: 'Aktualizowanie profilu powłoki…',
    added: 'Dodano. Otwórz nowy terminal, aby używać happier.',
    alreadyPresent: 'happier jest już w twoim PATH.',
    removed: 'Usunięto wpisy PATH dodane przez Happier Desktop.',
    nothingToRemove: 'Happier Desktop nie dodał żadnych wpisów PATH.',
};

const cliPathExposureTranslations = { pl: pl };

return { cliPathExposureTranslations };
})();

const Domain_cliTrustPromptTranslations = (() => {
const en = Shared_cliTrustPromptTranslations.en;

const pl = {
    title: 'Zatwierdzić ten wiersz poleceń?',
    body: ({ command }: { command: string }) => `Happier nie zainstalował wiersza poleceń w ${command}. Zatwierdzenie pozwoli mu odczytywać i zapisywać sesje tego konta. Zatwierdź tylko ten, który sam tam umieściłeś.`,
    bodyUnknownCommand: 'Happier nie zainstalował tego wiersza poleceń. Zatwierdzenie pozwoli mu odczytywać i zapisywać sesje tego konta. Zatwierdź tylko ten, który sam tam umieściłeś.',
    approve: 'Zatwierdź',
};

const cliTrustPromptTranslations = { pl: pl };

return { cliTrustPromptTranslations };
})();

const Domain_commitProposalTranslations = (() => {
type Count = Shared_commitProposalTranslations.Count;

type CommitProposalCopy = Shared_commitProposalTranslations.CommitProposalCopy;

const en = Shared_commitProposalTranslations.en;

const commitProposalTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', { commitProposal: CommitProposalCopy }>>, "pl"> = { pl: { commitProposal: {
        title: ({ count }) => (count === 1 ? 'Jeden commit dla oczekujących zmian' : `Commity dla oczekujących zmian: ${count}`),
        titlePhone: ({ count }) => (count === 1 ? 'Jeden commit' : `Commity: ${count}`),
        proposedBy: ({ who, committed, total }) => `Zaproponował ${who} · ${committed} z ${total} plików · w kolejności, w której każdy commit opiera się na poprzednim.`,
        proposedByPhone: ({ committed, total }) => `${committed} z ${total} oczekujących plików · dotknij zmiany, aby ją przenieść.`,
        moveHint: ({ max }) => `Przenieś dowolną zmianę skrótem ⌥1–${max} lub z jej menu.`,
        modelFallback: 'model',
        regenerate: 'Wygeneruj ponownie',
        conflict: 'Propozycja zmieniła się gdzie indziej. To najnowsza wersja; wprowadź zmianę ponownie.',
        approvalPending: 'Oczekiwanie na zatwierdzenie utworzenia tych commitów.',
        discardBody: 'Propozycja zostanie usunięta. Oczekujące zmiany pozostaną bez zmian.', askFix: ({ hook, number, message }) => `Hook ${hook} zatrzymał commit ${number}, „${message}”. Popraw to, co zgłasza, aby commit przeszedł:`, askFixGeneric: ({ number, message }) => `Hook zatrzymał commit ${number}, „${message}”. Popraw to, co zgłasza, aby commit przeszedł:`, discarded: 'Odrzucono propozycję.', undo: 'Cofnij',
        fileCount: ({ count }) => (count === 1 ? '1 plik' : `Pliki: ${count}`),
        part: ({ count, of }) => `${count} z ${of} zmian`,
        move: { a11y: ({ file }) => `Przenieś ${file} do innego commita`, title: ({ file }) => `Przenieś ${file} do`, newCommitAfter: ({ number }) => `Nowy commit po ${number}`, newCommitMessage: ({ file }) => `Aktualizuj ${file}`, leaveOut: 'Pomiń w tych commitach', leaveOutHint: 'Zostaje w drzewie roboczym' },
        group: { a11y: ({ number, message }) => `Commit ${number}: ${message}`, editMessage: 'Edytuj wiadomość', messageA11y: ({ number }) => `Wiadomość commita ${number}`, more: 'Więcej', moveUp: 'W górę', moveDown: 'W dół', mergeWithNext: 'Połącz z następnym commitem', empty: 'Brak zmian. Przenieś tu jedną lub połącz z następnym.' },
        leftOut: { title: 'Pominięte · zostaje w drzewie roboczym', description: 'Te zmiany pozostają oczekujące. Zatwierdź je osobno, jeśli taki był zamiar.' },
        footer: { commits: ({ count }) => (count === 1 ? '1 commit' : `Commity: ${count}`), onBranch: ({ branch }) => ` na ${branch} · hooki i podpis działają jak przy każdym commicie`, detached: ' na odłączonym HEAD · hooki i podpis działają jak przy każdym commicie', phone: 'Hooki i podpis jak zwykle', discard: 'Odrzuć propozycję', create: ({ count }) => (count === 1 ? 'Utwórz 1 commit' : `Utwórz commity: ${count}`), createShort: ({ count }) => `Utwórz ${count}`, emptyGroupReason: 'Jeden commit nie ma zmian. Przenieś do niego zmianę lub go połącz.' },
        applying: { title: ({ count }) => (count === 1 ? 'Tworzenie 1 commita' : `Tworzenie commitów: ${count}`), body: 'Po kolei zwykłą ścieżką commitów, więc hooki i podpis działają jak zwykle. Edycja jest wstrzymana do końca.', bodyPhone: 'Edycja jest wstrzymana do końca.', created: ({ landed, total }) => `${landed} z ${total}`, createdRest: ' utworzono · nic nie jest cofane, jeśli kolejny się zatrzyma', createdRestPhone: ' utworzono', stopAfterThis: 'Zatrzymaj po tym commicie', stopAfterThisShort: 'Zatrzymaj po tym', stopping: 'Zatrzyma się po tym commicie' },
        state: { waiting: 'Oczekuje', writing: 'Uruchamianie hooków i tworzenie commita', landed: 'zatwierdzono', landedAt: ({ time }) => `zatwierdzono o ${time}`, signed: 'podpisano', pausedBy: ({ hook, count }) => `${hook} zmienił pliki: ${count} · jeszcze bez commita`, hookFailedBy: ({ hook }) => `${hook} nie powiódł się · bez commita`, rewritten: 'hook przepisał wiadomość', notCreated: 'Nie utworzono · nadal do edycji', notCreatedShort: 'Nie utworzono', unknown: 'Jeszcze niepotwierdzone', paused: ({ count }) => `Hook zmienił pliki: ${count} · jeszcze bez commita`, failed: 'Zatrzymano tutaj · bez commita' },
        outcome: { signingTitle: 'Twoich commitów nie można teraz podpisać.', signingBody: 'To repozytorium podpisuje każdy commit. Nic nie zostało zatwierdzone.', signingHint: 'Najpierw odblokuj agenta GPG lub SSH', tryAgain: 'Spróbuj ponownie', cancel: 'Anuluj', hookChanged: ({ files }) => `Hook zmienił ${files}.`, waitsAfterLanded: ({ count }) => (count === 1 ? 'Commit 1 jest gotowy; ten czeka na Ciebie.' : `Gotowe commity: ${count}; ten czeka na Ciebie.`), waits: 'Ten czeka na Ciebie.', include: 'Uwzględnij zmiany hooka', includePhone: 'Uwzględnij i zatwierdź', cancelCommit: 'Anuluj ten commit', hookFailed: 'Hook zatrzymał ten commit.', hookChangedBy: ({ hook, files }) => `${hook} zmienił ${files}.`, hookFailedBy: ({ hook }) => `${hook} zatrzymał ten commit.`, hookFailedBody: 'Wcześniejsze commity zostają. Resztę nadal możesz edytować.', headMoved: ({ branch }) => `${branch} przesunął się podczas commitów.`, headMovedBody: 'Następny commit odrzucono i nic nie zostało cofnięte.', proposeAgain: 'Zaproponuj ponownie resztę', keepEditing: 'Edytuj dalej', askSessionToFix: 'Poproś tę sesję o poprawkę', showInGit: 'Pokaż w Git', unknownTitle: 'Nie udało się potwierdzić, czy ten commit trafił.', unknownBody: 'Nic nie jest ponawiane, dopóki nie będzie wiadomo. Sprawdź gałąź ponownie.', checkAgain: 'Sprawdź ponownie', stoppedTitle: ({ landed, total }) => `Utworzono ${landed} z ${total} commitów`, stoppedBody: ({ count }) => (count === 1 ? 'Ostatni nie został utworzony. Jego zmiany są w drzewie roboczym, jak wcześniej.' : `Nie utworzono: ${count}. Ich zmiany są w drzewie roboczym, jak wcześniej.`), createRest: ({ count }) => (count === 1 ? 'Utwórz ostatni' : `Utwórz pozostałe: ${count}`), completeTitle: ({ count }) => (count === 1 ? 'Utworzono 1 commit' : `Utworzono commity: ${count}`), completeBody: 'Nic nie zostało wypchnięte.', onBranch: ({ branch }) => `na ${branch}`, failed: { staging_conflict: 'Coś innego zmieniło przygotowane zmiany.', selection_conflict: 'Tych zmian nie da się tak podzielić.', source_changed: 'Oczekujące zmiany zmieniły się od propozycji.', writer_failed: 'Nie udało się utworzyć commita.', publication_warning: 'Commit trafił, ale przygotowane pliki nie zostały zaktualizowane.', cancelled: 'Ten commit anulowano.' }, failedBody: 'Wcześniejsze commity zostają. Nic nie zostało cofnięte.' },
        none: { title: 'Brak propozycji commitów', reason: 'Propozycja grupuje oczekujące zmiany w commity, które możesz edytować, a potem tworzy je po kolei zwykłą ścieżką commitów.', propose: 'Zaproponuj commity', writing: 'Grupowanie oczekujących zmian…' },
        gitPane: { title: 'Proponowane commity', meta: ({ count, files }) => `${count} · pliki: ${files}`, inCommit: ({ count, number }) => `${count} w commicie ${number}`, open: 'Otwórz', review: 'Przejrzyj', reviewInWalkthrough: 'Przejrzyj w omówieniu', more: 'Odrzuć lub wygeneruj ponownie', selectedHint: 'Zaznaczono. Dotknij ponownie, aby otworzyć w Commitach', tapHint: 'Dotknij, aby zobaczyć jego zmiany' },
    } } };

return { commitProposalTranslations };
})();

const Domain_committedMessageActionTranslations = (() => {
const committedMessageActionTranslations = { "pl": {
        "committedMessageActions": {
            "copy": "Kopiuj",
            "fork": "Rozgałęź",
            "rollback": "Wycofaj",
            "pin": "Przypnij",
            "savePrompt": "Zapisz jako prompt",
            "plugins": "Akcje wtyczek",
            "composerButton": "Przycisk biblioteki promptów",
            "composerHint": "Twoje prompty i wysłane wiadomości, obok dyktowania. Po wyłączeniu menu / nadal oferuje Prompty….",
            "name": "Nazwa",
            "shortcut": "/ skrót",
            "savedOpen": "Zapisano w bibliotece · Otwórz",
            "shortcutNotSaved": "Prompt został zapisany, ale skrót nie. Otwórz go w bibliotece, aby dodać skrót.",
            "wrongAccount": "Przełącz się na Home tej sesji przed zapisaniem jej promptu.",
            "savedHintFavorite": "Trafi do biblioteki, z gwiazdką.",
            "savedHint": "Trafi do biblioteki.",
            "addShortcut": "Dodaj skrót /",
            "shortcutPlaceholder": "/skrot",
            "savedToLibrary": "Zapisano w bibliotece",
            "savePromptHint": "Użyj ponownie z biblioteki promptów",
            "copyHint": "Kopiuj tekst wiadomości.",
            "forkHint": "Rozpocznij nową sesję od wiadomości.",
            "rollbackHint": "Przywróć obszar roboczy do stanu sprzed wiadomości.",
            "pinHint": "Przypinaj wiadomości, by do nich wracać. Przypięte pozostają przypięte.",
            "savePromptSettingHint": "Zachowaj wysłaną wiadomość jako prompt w bibliotece.",
            "pluginsHint": "Akcje, które wtyczki dodają pod wiadomościami."
        }
    } };

return { committedMessageActionTranslations };
})();

const Domain_computerUseTranslations = (() => {
type MachineParams = Shared_computerUseTranslations.MachineParams;

type ComputerUseTranslations = Shared_computerUseTranslations.ComputerUseTranslations;

const computerUseTranslations = { pl: {
        approval: {
            sectionTitle: 'Na komputerze',
            act: {
                list: 'Zobaczyć, które okna są otwarte',
                see: 'Zrobić zrzut ekranu',
                read: 'Odczytać tekst i elementy sterujące',
                click: 'Kliknąć',
                press: 'Nacisnąć klawisz',
                type: 'Wpisać tekst',
                share: 'Udostępnić okno',
            },
            windowOn: ({ machine }) => `Okno na ${machine}`,
            screenOf: ({ machine }) => `Cały ekran ${machine}`,
            windowsOn: ({ machine }) => `Otwarte okna na ${machine}`,
            window: 'Okno',
            screen: 'Cały ekran',
            windows: 'Otwarte okna',
            typedLabel: 'Tekst',
            keyLabel: 'Klawisz',
            listConsequence: 'Udostępniane są tylko nazwy otwartych okien, a nie ich zawartość.',
            seeConsequence: 'Zrzuty ekranu trafiają do tej sesji. Bez klikania i pisania.',
            useConsequence: 'Danych wejściowych, które dotarły do komputera, nie da się cofnąć. Możesz to zatrzymać w każdej chwili.',
            targetOn: ({ machine, target }) => `${target} na ${machine}`,
            chooseFirst: 'Najpierw wybierz okno',
            cropA11y: ({ target }) => `Najnowszy obraz ${target}`,
            suggestsWindow: ({ agent, target }) => `${agent} sugeruje „${target}”`,
        },
        request: {
            title: ({ agent, machine }) => `${agent} chce użyć okna na ${machine}`,
            body: 'To ty wybierasz okno. Nic nie jest udostępniane, dopóki tego nie zrobisz.',
            choose: 'Wybierz okno',
            change: 'Zmień okno',
            shared: ({ target }) => `Udostępniono ${target}`,
            watch: 'Oglądaj',
        },
        picker: {
            title: ({ agent }) => `Pozwól ${agent} użyć okna`,
            description: ({ agent }) => `Wybierasz, co udostępnić ${agent}.`,
            windows: 'Okna',
            screens: 'Cały ekran',
            untitledWindow: 'Okno bez tytułu',
            screenLabel: ({ index }) => `Ekran ${index}`,
            share: 'Udostępnij okno',
            shareScreen: 'Udostępnij ekran',
            shareApp: ({ app }) => `Udostępnij okno ${app}`,
            stopSharing: 'Zatrzymaj udostępnianie',
            loadingTitle: ({ machine }) => `Szukam okien na ${machine}`,
            noScreenTitle: ({ machine }) => `${machine} nie ma ekranu do udostępnienia`,
            noScreenBody: 'Działa bez pulpitu, który Happier może zobaczyć. Użyj maszyny z ekranem.',
            unsupportedTitle: ({ machine }) => `Happier nie może jeszcze używać ekranu ${machine}`,
            unsupportedBody: 'Na razie udostępnianie okna działa na pulpitach Linux.',
            failedTitle: ({ machine }) => `Nie udało się wyświetlić okien na ${machine}`,
            failedBody: 'Sprawdź, czy Happier tam działa, i spróbuj ponownie.',
            emptyTitle: ({ machine }) => `Na ${machine} nie ma otwartych okien`,
            emptyBody: 'Otwórz okno, które chcesz udostępnić, i sprawdź ponownie.',
            tryAgain: 'Spróbuj ponownie',
            inUse: 'Inna sesja używa tego okna. Wybierz inne.',
            closed: 'To okno zostało zamknięte. Wybierz inne.',
            selectFailed: 'Nie udało się udostępnić tego okna. Spróbuj ponownie.',
            otherMachineTitle: ({ machine }) => `${machine} to nie maszyna tej sesji`,
            otherMachineBody: 'Okna można udostępniać tylko na maszynie, na której działa ta sesja.',
            purpose: ({ session }) => `Dla „${session}”.`,
            purposeIn: ({ project, session }) => `Dla „${session}” w ${project}.`,
            access: ({ agent }) => `${agent} może`,
            accessValue: 'Widzieć i używać',
            accessSee: 'Tylko oglądać',
            displayUnavailable: 'Udostępnianie całego ekranu tego komputera jest niedostępne.',
            policyBoth: ({ agent }) => `${agent} pyta przed każdym zrzutem, kliknięciem i naciśnięciem klawisza.`,
            policyInput: ({ agent }) => `${agent} pyta przed każdym kliknięciem i naciśnięciem klawisza.`,
            policyCapture: ({ agent }) => `${agent} pyta przed każdym zrzutem.`,
            policyNone: ({ agent }) => `${agent} nie pyta przed zrzutami, kliknięciami ani klawiszami.`,
            policyChange: 'Zmień',
            suggests: ({ agent }) => `${agent} sugeruje`,
        },
        permission: {
            title: ({ machine }) => `${machine} najpierw potrzebuje twojej zgody`,
            body: 'Happier może widzieć i używać okien dopiero, gdy zezwolisz na to w Ustawieniach systemowych na tym komputerze.',
            capture: 'Nagrywanie ekranu',
            captureHint: 'Aby widzieć okna',
            input: 'Dostępność',
            inputHint: 'Aby klikać i pisać',
            allowed: 'Dozwolone',
            denied: 'Niedozwolone',
            unknown: 'Niesprawdzone',
            open: ({ machine }) => `Otwórz Ustawienia systemowe na ${machine}`,
            opened: ({ machine }) => `Otwarto na ${machine}. Zezwól tam Happier i sprawdź ponownie.`,
            openFailed: 'Nie udało się tam otworzyć Ustawień systemowych. Otwórz je na tym komputerze.',
            checkAgain: 'Sprawdź ponownie',
        },
        viewer: {
            agentUsing: ({ agent, target }) => `${agent} używa ${target}`,
            agentCanUse: ({ agent, target }) => `${agent} może używać ${target}`,
            agentCanSee: ({ agent, target }) => `${agent} może oglądać ${target}`,
            onMachine: ({ machine }) => `Na ${machine}`,
            connectingTitle: ({ target }) => `Łączenie z ${target}`,
            connectingBody: ({ machine }) => `Okno pojawi się tutaj, gdy tylko nadejdzie pierwszy obraz z ${machine}.`,
            unavailableTitle: 'Nie można teraz pokazać tego okna',
            unavailableBody: ({ agent }) => `Nadal możesz tutaj zatrzymać ${agent}.`,
            endedTitle: ({ target }) => `${target} zostało zamknięte`,
            endedBody: ({ agent }) => `${agent} nie może go już widzieć ani używać. Wybierz inne okno, aby kontynuować.`,
            stalled: 'Ostatni obraz · ponowne łączenie',
            inputA11y: ({ target }) => `${target}, na żywo. Kliknij lub pisz, aby przejąć sterowanie.`,
            notSharedTitle: 'Żadne okno nie jest udostępnione',
            notSharedBody: ({ agent }) => `Wybierz okno, którego ${agent} ma używać.`,
            moreA11y: 'Opcje okna',
            tabFallback: 'Komputer',
        },
        strip: {
            using: ({ target }) => `Używa ${target}`,
            on: ({ machine }) => `na ${machine}`,
            stop: 'Zatrzymaj',
            paused: ({ agent }) => `${agent} wstrzymany`,
            pausedDetail: ({ target }) => `Sterujesz ${target}`,
        },
        tool: {
            capture: 'Zrobił zrzut ekranu',
            captureRunning: 'Robi zrzut ekranu',
            query: 'Odczytał tekst i kontrolki okna',
            queryRunning: 'Odczytuje okno',
            click: 'Kliknął w oknie',
            clickRunning: 'Klika w oknie',
            clickTarget: ({ target }) => `Kliknięto „${target}”`,
            type: 'Pisał w oknie',
            typeRunning: 'Pisze w oknie',
            typeTarget: ({ target }) => `Wpisano w „${target}”`,
            pressKey: ({ key }) => `Nacisnął ${key}`,
            press: 'Nacisnął klawisz',
            pressRunning: 'Naciska klawisz',
            mayHaveLanded: 'mogło zadziałać',
            failed: 'Nie powiodło się',
        },
    } } satisfies Pick<Record<string, ComputerUseTranslations>, "pl">;

return { computerUseTranslations };
})();

const Domain_connectedServicesCollectionTranslations = (() => {
type ConnectedServicesCollectionCopy = Shared_connectedServicesCollectionTranslations.ConnectedServicesCollectionCopy;

const en = Shared_connectedServicesCollectionTranslations.en;

const pl: ConnectedServicesCollectionCopy = {
    accountLabel: ({ service }) => `Konto ${service}`,
    accountLabelNumbered: ({ service, number }) => `Konto ${service} ${number}`,
    meterResetsIn: ({ time }) => `za ${time}`,
    meterNextResetIn: ({ time }) => `następny za ${time}`,
    meterResetsAt: ({ countdown, time }) => `${countdown} · ${time}`,
    meterNotReported: 'Brak danych',
    meterEstimated: ({ value }) => `~${value}`,
    indexTitle: 'Wszystkie usługi',
    indexDescription: 'Konta, którymi logują się twoi agenci, i ile każdemu zostało.',
    viewList: 'Lista',
    viewGrid: 'Siatka',
    viewLabel: 'Pokaż konta jako',
    refreshAll: 'Odśwież wszystko',
    refreshUsage: 'Odśwież użycie',
    signedOutConsequence: 'Sesje nie mogą go używać, dopóki nie zalogujesz się ponownie.',
    poolsGroup: 'Pule',
    poolsDescription: 'Konta, między którymi przełącza się agent. Pula wybiera jedno na start sesji i przechodzi dalej, gdy się wyczerpie.',
    newPool: 'Nowa pula',
    poolUsing: ({ account }) => `Używa: ${account}`,
    poolPosition: ({ position, count }) => position === 1 ? `Pierwsze z ${count}` : `${position} z ${count}`,
    poolInUseNow: 'teraz w użyciu',
    inUse: 'W użyciu',
    connectService: 'Połącz usługę',
    searchAccounts: 'Szukaj kont',
    servicesGroup: 'Usługi',
    railEmpty: 'Nie ma jeszcze kont',
    railKey: 'klucz',
    railAccountLabel: ({ service, account }) => `${service} · ${account}`,
    agentSignInTitle: 'Jak logują się agenci',
    subscriptionTitle: 'Subskrypcja',
    subscriptionNone: 'Brak subskrypcji',
    subscriptionRenewsIn: ({ days }) => days === 0 ? 'Odnawia się dziś' : days === 1 ? 'Odnawia się jutro' : `Odnawia się za ${days} dni`,
    subscriptionEndsIn: ({ days }) => days === 0 ? 'Bez odnowienia · kończy się dziś' : `Bez odnowienia · kończy się za ${days} dni`,
    subscriptionPeriodEndsIn: ({ days }) => days === 0 ? 'Okres kończy się dziś' : `Okres kończy się za ${days} dni`,
    subscriptionRenewsOn: ({ date, days }) => `Odnawia się ${date} · za ${days} dni`,
    subscriptionEndsOn: ({ date, days }) => `Bez odnowienia · kończy się ${date}, za ${days} dni. Potem sesje przestaną go używać.`,
    subscriptionPeriodEndsOn: ({ date, days }) => `Okres kończy się ${date} · za ${days} dni`,
    renewalOn: 'Wł.',
    renewalOff: 'Wył.',
    renewalUnknown: 'Nieznane',
    checkedAt: ({ time }) => `Sprawdzono ${time}`,
    checkedMayBeOutOfDate: ({ time }) => `Sprawdzono ${time} · może być nieaktualne`,
    usageCheckedMayBeOutOfDate: ({ time }) => `Sprawdzono ${time} · może być nieaktualne`,
    daysAgo: ({ count }) => count === 1 ? '1 dzień temu' : `${count} dni temu`,
    hoursAgo: ({ count }) => count === 1 ? '1 godzinę temu' : `${count} godz. temu`,
    usageResetsCount: ({ count }) => count === 1 ? '1 reset użycia' : `Resety użycia: ${count}`,
    usageResetsFirstExpires: ({ date }) => `pierwszy wygasa ${date}`,
    usageResetExpires: ({ date }) => `wygasa ${date}`,
    useOne: 'Użyj jednego',
    useOneReset: 'Użyj resetu użycia',
    usageResetsTitle: 'Resety użycia',
    usageResetsDescription: 'Każdy od razu zaczyna nowe okno. Zachowaj je na chwilę, gdy blokuje cię limit; niewykorzystane wygasają.',
    usageResetTitle: 'Reset użycia',
    usageResetExpiresOn: ({ date }) => `Wygasa ${date}`,
    use: 'Użyj',
    usedByDefault: 'Domyślne · nowe sesje używają tego konta',
    accountIdFact: ({ id }) => `ID ${id}`,
    hideIdentitiesTitle: 'Ukryj e-maile i identyfikatory kont',
    hideIdentitiesDescription: 'Do transmisji i pokazów. Maskuje e-maile i identyfikatory kont wszędzie na tym urządzeniu; nazwy nadane kontom zostają.',
    privacyTitle: 'Prywatność',
    renameTitle: 'Nazwij to konto',
    renameBody: ({ service }) => `Zmienia się tylko nazwa w Happier. ${service} zachowuje własną nazwę konta.`,
    identityHidden: 'E-mail lub identyfikator ukryty',
};

const connectedServicesCollectionTranslations = { pl };

return { connectedServicesCollectionTranslations };
})();

const Domain_connectedServicesPoolTranslations = (() => {
type ConnectedServicesPoolCopy = Shared_connectedServicesPoolTranslations.ConnectedServicesPoolCopy;

const en = Shared_connectedServicesPoolTranslations.en;

const pl: ConnectedServicesPoolCopy = {
    strategyExpiryFirst: "Wygasa wcześniej",
    strategyExpiryFirstDescription: "Preferuj wystarczający zapas z wcześniejszym resetem długiego okresu lub końcem subskrypcji bez odnowienia.",
    leadExpiryFirst: "Najpierw najbliższy termin.",
    membersOn: ({ service, on, total }) => `${service} · ${on} z ${total} członków włączonych`,
    rename: 'Zmień nazwę',
    moreActions: 'Więcej działań',
    defaultFor: ({ agent }) => `Domyślna dla ${agent}`,
    defaultForMore: ({ agent, count }) => `Domyślna dla ${agent} +${count}`,
    makeDefault: 'Ustaw jako domyślną',
    makeDefaultA11y: 'Ustaw jako domyślną dla agenta',
    usingSince: ({ name, time }) => `Używane ${name} od ${time}`,
    using: ({ name }) => `Używane ${name}`,
    noActive: 'Żaden członek nie jest jeszcze używany',
    noActiveDetail: 'Pula wybiera jednego, gdy zaczyna się sesja.',
    leadLeastLimited: 'Najpierw najmniej ograniczone.',
    leadInOrder: 'Po kolei.',
    fallbackOff: ({ name }) => `Automatyczne przełączanie jest wyłączone, więc sesje zostają na ${name}, gdy się wyczerpie.`,
    manualStays: ({ name }) => `Ręcznie: pula zostaje na ${name}, dopóki nie wybierzesz innego członka.`,
    switchTo: ({ name }) => `Przełącz na ${name}`,
    onlyOneOn: ({ name }) => `Tylko ${name} jest włączone, więc nie ma zastępstwa.`,
    turnOn: ({ name }) => `Włącz ${name}`,
    allWaitingTitle: 'Wszyscy członkowie czekają na reset',
    allWaitingFirst: ({ name, time, countdown }) => `${name} zresetuje się pierwsze, o ${time} (${countdown}).`,
    sessionsWait: 'Sesje czekają, a potem wznawiają się same.',
    sessionsStop: 'Sesje zatrzymują się, dopóki któryś członek nie będzie miał zapasu.',
    leftTitle: 'Pozostało w puli',
    leftDescription: 'Średnia włączonych członków; każdy resetuje się osobno.',
    roomCount: ({ count, total }) => `${count} z ${total} ma teraz zapas`,
    notReported: ({ count }) => `${count} bez danych`,
    nothingReported: 'Żaden włączony członek nie zgłasza jeszcze swoich limitów.',
    membersTitle: 'Członkowie',
    membersDescription: 'Przeciągnij, aby ustawić kolejność. Wybrany członek jest aktywny; wyłączony jest pomijany.',
    membersCompactDescription: 'Przytrzymaj i przeciągnij, aby zmienić kolejność.',
    manage: 'Zarządzaj',
    connectAnotherAccount: ({ service }) => `Połącz kolejne konto ${service}`,
    membersSelectionSummary: ({ count, total, service }) => `${count} z ${total} kont ${service}`,
    manageMembers: 'Zarządzaj członkami',
    searchAccounts: ({ service }) => `Szukaj kont ${service}`,
    active: 'Aktywne',
    offNotUsed: 'Nieużywane przez pulę, gdy wyłączone',
    autoOffModel: 'Wyłączone automatycznie · ten plan nie może używać wybranego modelu',
    checkedAt: ({ time }) => `Sprawdzono ${time}`,
    makeActiveA11y: ({ name }) => `Ustaw ${name} jako aktywnego członka`,
    memberOnA11y: ({ name }) => `Używaj ${name} w tej puli`,
    openA11y: ({ name }) => `Otwórz ${name}`,
    dragA11y: 'Przeciągnij, aby zmienić kolejność',
    behaviorTitle: 'Działanie',
    strategyTitle: 'Strategia wyboru',
    strategyLeastLimited: 'Najmniej ograniczone',
    strategyInOrder: 'Po kolei',
    strategyManual: 'Ręcznie',
    strategyLeastLimitedDescription: 'Preferuj członka z największym dostępnym limitem.',
    strategyInOrderDescription: 'Próbuj członków w kolejności powyżej.',
    strategyManualDescription: 'Używaj tylko aktywnego członka, dopóki go nie zmienisz.',
    fallbackTitle: 'Automatyczne przełączanie',
    fallbackDescription: 'Przełącz na innego członka, gdy aktywne konto wymaga odzyskania.',
    switchEarlyTitle: 'Przełącz wcześniej',
    switchEarlyDescription: 'Procent pozostały, poniżej którego pula przechodzi do członka ze świeższym limitem. 0 wyłącza.',
    autoResetsTitle: 'Automatycznie używaj resetów limitu',
    autoResetsDescription: 'Wykorzystaj zapisany reset tylko wtedy, gdy żaden członek nie jest gotowy.',
    autoOffTitle: 'Wyłączaj konta, które nie mogą używać wybranego modelu',
    autoOffDescription: 'Możesz je sam ponownie włączyć.',
    advancedTitle: 'Zaawansowane',
    advancedCount: ({ count }) => `Ustawienia: ${count}`,
    restoreFirstTitle: 'Wróć do pierwszego członka po resecie',
    restoreFirstDescription: 'Po przełączeniu wróć do członka ustawionego jako pierwszy, gdy jego limit się zresetuje.',
    switchWhenTitle: 'Przełączaj, gdy',
    switchWhenDescription: 'Zdarzenia przenoszące pulę do następnego członka.',
    staleAfterTitle: 'Sprawdź nieaktualne użycie po',
    staleAfterDescription: 'Minuty. Zapytaj dostawcę ponownie, gdy użycie jest starsze, zanim wybierzesz członka.',
    switchesPerTurnTitle: 'Automatyczne przełączenia na turę',
    switchesPerHourTitle: 'Automatyczne przełączenia na godzinę sesji',
    switchLimitsDescription: 'Zapobiega skakaniu puli między członkami.',
    recoveryTitle: 'Gdy limit zatrzyma sesję',
    recoveryDescription: 'Co pula robi dla czekającej sesji.',
    recoveryPromptsTitle: 'Wiadomości wznowienia',
    recoveryPromptsDescription: 'Happier wysyła standardową wiadomość, gdy wznawia sesję po przełączeniu lub resecie.',
    usedByTitle: 'Używane przez',
    usedByDefault: 'Domyślnie · nowe sesje logują się przez tę pulę',
    usedByNone: 'Żaden agent nie loguje się jeszcze domyślnie przez tę pulę.',
    deleteNote: ({ agents }) => `Członkowie pozostają połączeni. ${agents} wraca do własnego logowania, dopóki nie wybierzesz innej domyślnej.`,
    deleteNoteNoAgent: 'Członkowie pozostają połączeni.',
    emptyTitle: 'Dodaj konta, między którymi przełączać',
    emptyReason: ({ service }) => `Pula wybiera konto, gdy zaczyna się sesja, i przełącza, gdy się wyczerpie. Dodaj co najmniej dwa konta ${service}.`,
    usageNotAnswering: ({ service }) => `${service} nie odpowiedział`,
    newPoolTitle: 'Nowa pula',
    newPoolDescription: ({ service }) => `Konta ${service}, między którymi przełącza agent.`,
    nameTitle: 'Nazwa',
    namePlaceholder: 'Pula robocza',
    draftMembersDescription: 'Wybierz konta, między którymi przełączać. Możesz je zmienić później.',
    create: 'Utwórz pulę',
    discard: 'Odrzuć',
};

const connectedServicesPoolTranslations = { pl };

return { connectedServicesPoolTranslations };
})();

const Domain_connectedServicesSettingsTranslations = (() => {
type ConnectedServicesSettingsCopy = Shared_connectedServicesSettingsTranslations.ConnectedServicesSettingsCopy;

const setupFidelityCopy = Shared_connectedServicesSettingsTranslations.setupFidelityCopy;

const en = Shared_connectedServicesSettingsTranslations.en;

const pl: ConnectedServicesSettingsCopy = {
    ...setupFidelityCopy,
    accountCount: ({ count }) => count === 1 ? '1 konto' : `Konta: ${count}`,
    defaultAccount: ({ name }) => `Domyślne: ${name}`,
    poolCount: ({ count }) => count === 1 ? '1 pula' : `Pule: ${count}`,
    noAccountsYet: 'Brak kont',
    needsSignIn: 'Wymaga logowania',
    signInAgain: 'Zaloguj się ponownie',
    addAccount: 'Dodaj konto',
    connectAnotherTitle: 'Połącz inną usługę',
    connectFirstTitle: 'Połącz usługę',
    connectNames: ({ names }) => `${names}.`,
    connectNamesMore: ({ names, count }) => `${names} i ${count} więcej.`,
    connect: 'Połącz',
    emptyTitle: 'Brak usług do połączenia',
    servicesTitle: 'Usługi',
    emptyNoServiceOnMachine: ({ machine }: { machine: string }) => `Żaden agent na ${machine} nie oferuje jeszcze usługi do logowania. Agenci korzystający z subskrypcji dodają tu swoją.`,
    emptyNoMachineOnline: 'Żadna z twoich maszyn nie jest online. Usługi pojawią się, gdy któraś będzie, na podstawie uruchomionych na niej agentów.',
    emptyOpenAgents: 'Otwórz agentów',
    emptyAction: 'Otwórz maszyny',
    projectionErrorTitle: 'Nie udało się wczytać usług z Twoich maszyn',
    projectionErrorDescription: 'Twoje konta nadal są na liście. Usługi do dodania pojawią się, gdy maszyna odpowie.',
    loadingServices: 'Szukanie usług na Twoich maszynach…',
    usageTitle: 'Jak używane są konta',
    usageDescription: 'Którym kontem loguje się każdy agent przy starcie sesji i co współdzielą sesje.',
    sharingTitle: 'Współdzielenie stanu',
    sharingSummary: ({ config, state }) => `${config} · ${state}`,
    configLinkedShort: 'Połączona',
    configCopiedShort: 'Skopiowana',
    configIsolatedShort: 'Odizolowana',
    stateSharedShort: 'Sesje współdzielone',
    stateIsolatedShort: 'Sesje osobne',
    perAgentTitle: 'Współdzielenie dla agenta',
    perAgentDescription: 'Zastąp te ustawienia dla jednego agenta.',
    perAgentPurpose: 'Wybierz dla każdego agenta, co sesje połączonych kont współdzielą z Twoim własnym logowaniem.',
    servicePurpose: ({ service }) => `Konta, którymi logujesz się do ${service}, i pule, które je współdzielą.`,
    chooseMachineTitle: 'Wybierz maszynę',
    chooseMachineDescription: 'Dodawanie, logowanie i usuwanie kont odbywa się na jednej z Twoich maszyn. Twoje konta pozostają na liście Połączonych usług.',
    newAccountTitle: 'Nowe konto',
    newAccountDescription: 'Wybierz sposób logowania.',
    newAccountInProgress: 'Dokończ logowanie poniżej.',
    modeBrowser: 'Zaloguj się w przeglądarce',
    modeDeviceCode: 'Zaloguj się kodem',
    modeManual: 'Wpisz token',
    serviceSettingsTitle: 'Ustawienia usługi',
    serviceSettingsDescription: 'Ustawienia, z którymi loguje się każde konto tej usługi.',
    noAccountsDescription: 'Dodaj konto, aby Twoi agenci mogli się nim logować.',
    accountDetailsTitle: 'Szczegóły konta',
    poolEmptyTitle: 'Dodaj konta do tej puli',
    poolEmptyDescription: 'Pula przenosi sesje na kolejne konto, gdy jedno osiągnie limit. Wybierz jej konta poniżej.',
    agentDefaultsTitle: 'Domyślne konto agenta',
    agentDefaultsDescription: 'Konto, którym każdy agent loguje się przy starcie sesji.',
    agentDefaultsKeywords: 'domyślne konto',
    namesAnd: ({ names, last }) => `${names} i ${last}`,
    usedBy: ({ names }) => `Używają: ${names}`,
    poolRuleMostLeft: 'używa tego, któremu zostało najwięcej',
    poolRuleInOrder: 'używa ich po kolei',
    poolRuleManual: 'przełączasz ręcznie',
    poolInUse: ({ pool }) => `${pool} · w użyciu`,
    agentDefault: ({ agent }) => `Domyślne dla ${agent}`,
    signedOutBy: ({ service }) => `Wylogowano przez ${service}`,
    usageReadFailed: 'Nie udało się odczytać użycia',
    usageWindowPin: ({ meter }: { meter: string }) => `Pokaż ${meter} obok pola wpisywania`,
    noLimitsBilledPerUse: 'Brak zgłoszonych limitów · płatność za użycie',
    needsYouCount: ({ count }) => `${count} wymaga uwagi`,
    connectToolsTitle: 'Połącz hosting kodu lub narzędzie',
    inviteTitle: ({ names }) => `Twoi agenci mogą też używać: ${names}`,
    inviteWhoOne: ({ agents }) => `${agents} może się nim zalogować.`,
    inviteWhoMany: ({ agents }) => `${agents} mogą się nimi logować.`,
    inviteTools: 'Albo połącz hosting kodu i narzędzia.',
    firstRunTitle: 'Korzystaj z planów, za które już płacisz',
    firstRunPromise: 'Połącz konto Claude lub ChatGPT raz. Twoi agenci używają go na każdej maszynie, a Happier pokazuje, ile zostało przed limitem.',
    connectAnAccount: 'Połącz konto',
    firstRunMeanwhile: 'Do tego czasu każdy agent używa własnego logowania na każdej maszynie.',
    agentAccountsTitle: 'Konta agentów',
    agentAccountsDescription: 'Subskrypcje i klucze używane przez agentów. Zapisane na koncie, więc każda maszyna może z nich korzystać.',
    codeAndToolsTitle: 'Kod i narzędzia',
    setupChooseMachine: 'Wybierz maszynę do logowania. Potem konto działa na wszystkich twoich maszynach.',
    setupHowToSignIn: 'Sposób logowania',
    setupRecommendedMethod: ({ method }) => `${method} · Zalecane`,
    setupCatalogTitle: 'Połącz usługę',
    setupCatalogPurpose: 'Logowanie odbywa się na wybranej maszynie. Potem konto działa na wszystkich twoich maszynach.',
    setupServiceTitle: ({ service }) => `Połącz ${service}`,
    setupReconnectTitle: ({ service }) => `Zaloguj się ponownie do ${service}`,
    setupServicePurpose: ({ agents, service }) => `${agents} będą używać twojego konta ${service} na każdej maszynie.`,
    setupServicePurposeNoAgents: 'Konto działa na każdej maszynie.',
    setupForYourAgents: 'Dla twoich agentów',
    setupOwnLoginTitle: 'Zalogowano na maszynie?',
    setupOwnLoginBody: 'Używaj dalej własnego logowania agenta. Wybierz je w sekcji Jak używane są konta.',
    setupToolsTitle: 'Hosting kodu i narzędzia',
    setupProvidersPointer: 'Dostawców modeli, takich jak OpenRouter i Ollama, konfigurujesz w sekcji Dostawcy.',
    setupOpenProviders: 'Otwórz Dostawców',
    setupTrust: 'Zapisane na twoim koncie i używane tylko przez twoje maszyny. Happier dba o aktualność logowania.',
    setupConnectedCount: ({ count }) => `Połączone: ${count}`,
    settleConnectedAs: ({ identity }) => `Połączono właśnie jako ${identity}.`,
    settleConnected: 'Właśnie połączono.',
    settleUseFor: ({ agent }) => `Użyć dla ${agent}?`,
    settleUseForAction: ({ agent }) => `Użyj dla ${agent}`,
    notNow: 'Nie teraz',
    homeInvitePromise: 'Połącz Claude lub ChatGPT raz. Każda maszyna może z niego korzystać, a tutaj zobaczysz, ile zostało.',
    homeInviteHide: 'Ukryj',
    homeNextWho: ({ agents }) => `${agents} też może z niego korzystać`,
    oauthStepOpen: 'Otwórz stronę logowania w przeglądarce',
    oauthStepApprove: 'Zatwierdź i skopiuj kod ze strony (lub adres, na który trafisz)',
    oauthStepPaste: 'Wklej tutaj',
    oauthPastePlaceholder: 'Wklej kod lub adres',
    oauthShapeOk: 'Wygląda na kod logowania',
    deviceEnterAt: ({ where }) => `Wpisz ten kod na ${where}`,
    deviceExpired: 'Kod wygasł. Nic nie zapisano.',
    deviceExpiresIn: ({ time }) => `Kod wygaśnie za ${time}`,
    deviceNewCode: 'Pobierz nowy kod',
    detailSignedOutTitle: ({ service }) => `${service} wylogował to konto`,
    detailSignedOutBody: 'Logowanie zostało cofnięte lub zmienione, np. po zmianie hasła. Sesje nie mogą używać tego konta, dopóki nie zalogujesz się ponownie.',
    detailSignInTitle: 'Logowanie',
    detailSignInNeeded: 'Wymaga ponownego logowania',
    detailSignInKeptFresh: 'Happier dba o jej aktualność',
    detailLastUsed: ({ time }) => `ostatnio użyte ${time}`,
    detailLeavePool: ({ pool }) => `Usuń z ${pool}…`,
    detailRemovePooledNote: ({ pool }) => `${pool} używa tego konta; najpierw usuń je z puli. Usunięcie kasuje je z konta i ze wszystkich maszyn.`,
    detailUsageSignedOut: 'Ostatnio znane · bez logowania nie można odświeżyć',
    detailUsageSignedOutAt: ({ time }: { time: string }) => `Ostatnio znane o ${time} · bez logowania nie można odświeżyć`,
    detailResetsIn: ({ countdown }) => `za ${countdown}`,
    detailUsedByTitle: 'Używane przez',
    detailUsedByDefault: 'Jego domyślne konto',
    detailUsedByPool: ({ pool }) => `Przez ${pool}`,
    detailUsedByPoolInUse: ({ pool }) => `Przez ${pool} · teraz w użyciu`,
    detailUsedByCould: 'Mogą z niego korzystać · dziś logują się inaczej',
    detailWorksOnTitle: 'Działa na',
    detailWorksOnDescription: 'Zapisane na koncie. Maszyna używa go, gdy zaczyna się na niej sesja; nic nie jest kopiowane z góry.',
    detailSignedInWithCode: 'Zalogowano kodem',
    detailSignedInWithBrowser: 'Zalogowano przez przeglądarkę',
    detailAddedWithKey: 'Dodano kluczem',
    nearLimitTitle: ({ account, percent, window }) => `${account}: zostało ${percent}% limitu ${window}`,
    nearLimitTitleNoAccount: ({ percent, window }) => `Zostało ${percent}% limitu ${window}`,
    nearLimitBodyWithReset: ({ time }) => `Odnowi się o ${time}. Zastosuj reset użycia, aby kontynuować teraz.`,
    nearLimitBody: 'Zastosuj reset użycia, aby kontynuować teraz.',
    nearLimitApplyReset: 'Zastosuj reset',
    catalogSignInBrowserOrCode: 'Logowanie przez przeglądarkę lub kod',
    catalogSignInBrowserOrKey: 'Logowanie przez przeglądarkę lub wklej token',
    catalogSignInBrowser: 'Logowanie przez przeglądarkę',
    catalogSignInCode: 'Logowanie kodem',
    catalogPasteKey: 'Wklej klucz',
    deviceOpenService: ({ service }) => `Otwórz ${service}`,
    deviceWaitingFor: ({ service }) => `Czekam na zatwierdzenie w ${service}…`,
};

const connectedServicesSettingsTranslations = { pl };

return { connectedServicesSettingsTranslations };
})();

const Domain_connectedServicesSetupTranslations = (() => {
type ConnectedServicesSetupTranslation = Shared_connectedServicesSetupTranslations.ConnectedServicesSetupTranslation;

const connectedServicesSetupTranslations = { pl: {
        connectMoreTitle: 'Połącz więcej',
        connectMoreDescription: 'Usługi, które akceptują agenci na Twoich maszynach, a których jeszcze nie połączono.',
        connectMoreNothingNew: 'Dodaj kolejne konto, hosting kodu lub narzędzie.',
        serviceSignInInstead: ({ agents }) => `${agents} może się nim logować zamiast logowania na każdej maszynie.`,
        serviceCanUse: ({ agents }) => `${agents} może z niego korzystać.`,
        moreServicesTitle: 'Więcej usług',
        moreServicesTools: ({ names }) => `${names} i inne — do kodu i narzędzi.`,
        moreServicesAll: 'Wszystko, co akceptują Twoi agenci i narzędzia.',
        browse: 'Przeglądaj',
        notNow: ({ service }) => `Nie teraz: ${service}`,
        notNowTooltip: 'Nie teraz · nadal w przeglądaniu',
        back: 'Wszystkie usługi',
        homeCatalogTitle: 'Połącz konto',
        homeCatalogPurpose: 'Agenci używają go na każdej maszynie, a Home pokazuje, ile zostało.',
        homeNextSubtitle: ({ agents }) => `${agents} może go używać zamiast logowania na każdej maszynie.`,
        firstRunMore: 'Klucze API, hosting kodu i narzędzia',
        settleAddToPoolWhy: ({ pool, agent, active }) => `Dodać do ${pool}, aby ${agent} przełączył się na nie, gdy skończy się ${active}?`,
        settleAddToPoolShort: ({ pool }) => `Dodać do ${pool}?`,
        settleAddToPool: ({ pool }) => `Dodaj do ${pool}`,
        deviceStepCopy: 'Skopiuj ten kod',
        deviceStepOpen: ({ service }) => `Otwórz ${service} i wpisz go`,
        deviceStepOpenWhere: ({ where }) => `${where}, zalogowany na konto, którego chcesz użyć`,
        deviceStepApprove: ({ service }) => `Zatwierdź Happier w ${service}`,
        deviceCheckNow: 'Sprawdź teraz',
    } } satisfies Pick<Readonly<Record<string, ConnectedServicesSetupTranslation>>, "pl">;

return { connectedServicesSetupTranslations };
})();

const Domain_detailPageTranslations = (() => {
type DetailPageTranslations = Shared_detailPageTranslations.DetailPageTranslations;

const detailPageTranslations = { pl: {
        approval: {
            requestTitle: 'Prośba',
            requestDescription: 'O co poproszono i jaki jest status.',
            failureTitle: 'Przyczyna niepowodzenia',
            homeUnavailableTitle: 'Home niedostępny',
            contextTitle: 'Prośba od',
            contextDescription: 'Sesja i agent, którzy o to poprosili.',
            proposalsDescription: 'Zostaną opublikowane w przeglądzie, jeśli zatwierdzisz.',
        },
        runs: {
            description: 'Uruchomienia w tle na twoich maszynach.',
            filterLabel: 'Pokazywane uruchomienia',
            filterRunning: 'Aktywne',
            filterAll: 'Wszystkie',
            onHome: ({ home }) => `W ${home}`,
        },
        person: {
            placeholderTitle: 'Osoba',
            friendshipTitle: 'Znajomość',
            sharedSessionsDescription: 'Sesje, które ten znajomy ci udostępnia, tylko do podglądu.',
            linkedAccountsTitle: 'Połączone konta',
            linkedAccountsDescription: 'Gdzie jeszcze się loguje. Otwiera się w przeglądarce.',
        },
        friendsManage: {
            description: 'Osoby, z którymi pracujesz w Happier, i zaproszenia między wami.',
            requestsTitle: 'Zaproszenia do znajomych',
            requestsDescription: 'Otwórz zaproszenie, aby je przyjąć lub odrzucić.',
            sentTitle: 'Wysłane zaproszenia',
            sentDescription: 'Czekają na akceptację.',
            friendsTitle: 'Znajomi',
            friendsDescription: 'Otwórz znajomego, aby zobaczyć, co ci udostępnia.',
        },
    } } as const satisfies Pick<Record<string, DetailPageTranslations>, "pl">;

return { detailPageTranslations };
})();

const Domain_detailsChromeTranslations = (() => {
type DetailsChromeTranslations = Shared_detailsChromeTranslations.DetailsChromeTranslations;

const detailsChromeTranslations = { pl: {
        closeUnsavedTabA11y: 'Zamknij kartę, ma niezapisane zmiany',
        emptyTitle: 'Tutaj otwierają się pliki, zmiany i commity',
        browseFiles: 'Przeglądaj pliki',
        previewHint: 'Kliknięcie otwiera podgląd; otwórz go ponownie, aby zachować kartę.',
        emptyReason: 'Otwierane pliki, zmiany i commity pojawiają się tutaj, obok miejsca, z którego je otworzono.',
        reviewChanges: ({ count }) => (count === 1 ? 'Przejrzyj 1 zmianę' : `Przejrzyj zmiany (${count})`),
        reviewChangesReason: ({ count }) => (count === 1
            ? 'W tej sesji zmienił się 1 plik. Przeczytaj go tutaj, nie opuszczając rozmowy.'
            : `W tej sesji zmieniły się pliki (${count}). Przeczytaj je tutaj, nie opuszczając rozmowy.`),
        splitNeedsWiderPane: 'Widok obok siebie wymaga szerszego panelu. Poszerz Szczegóły lub użyj trybu skupienia.',
    } } satisfies Pick<Record<string, DetailsChromeTranslations>, "pl">;

return { detailsChromeTranslations };
})();

const Domain_detailsFileTranslations = (() => {
type DetailsFileTranslations = Shared_detailsFileTranslations.DetailsFileTranslations;

const detailsFileTranslations = { pl: {
        areaUnstaged: 'Niezatwierdzone',
        areaStaged: 'Przygotowane',
        areaBoth: 'Oba',
        areaLabel: 'Zmiany',
        preview: 'Podgląd',
        viewLabel: 'Widok',
        compare: 'Porównaj',
        stage: 'Przygotuj',
        unstage: 'Cofnij przygotowanie',
        addToCommit: 'Dodaj do commita',
        removeFromCommit: 'Usuń z commita',
        editing: 'Edycja',
        editingUnsaved: 'Edycja · niezapisane zmiany',
        statusModified: 'Zmieniony',
        statusAdded: 'Dodany',
        statusDeleted: 'Usunięty',
        statusRenamed: 'Zmieniona nazwa',
        statusCopied: 'Skopiowany',
        statusUntracked: 'Nowy, jeszcze nieśledzony',
        statusConflicted: 'Ma konflikty',
        noChanges: 'Brak zmian',
        lines: ({ count }) => (count === 1 ? '1 wiersz' : `Wiersze: ${count}`),
    } } satisfies Pick<Record<string, DetailsFileTranslations>, "pl">;

return { detailsFileTranslations };
})();

const Domain_detailsHistoryTranslations = (() => {
type Count = Shared_detailsHistoryTranslations.Count;

type Branch = Shared_detailsHistoryTranslations.Branch;

type Folder = Shared_detailsHistoryTranslations.Folder;

type DetailsHistoryTranslations = Shared_detailsHistoryTranslations.DetailsHistoryTranslations;

const detailsHistoryTranslations = { pl: {
        copyCommitSha: 'Kopiuj SHA commita',
        filesChanged: ({ count }) => (count === 1 ? 'Zmieniono 1 plik' : `Zmienione pliki: ${count}`),
        files: ({ count }) => (count === 1 ? '1 plik' : `Pliki: ${count}`),
        revertEllipsis: 'Cofnij…',
        stashKeptOn: ({ branch }) => `Odłożone na ${branch}`,
        stashOriginBranch: ({ branch }) => `Zapisane, gdy opuszczono ${branch}`,
        stashOriginBranchShort: 'Przy zmianie gałęzi',
        stashOriginTransient: 'Zapisane przez Happier',
        stashOriginUnmanaged: 'Utworzone poza Happier',
        stashRestoreExplains: ({ folder }) => `Przywrócenie przenosi te zmiany z powrotem do ${folder} i usuwa stash. Nic innego w folderze się nie zmienia.`,
        stashApply: 'Zastosuj',
        stashApplyA11y: 'Zastosuj te zmiany i zachowaj stash',
        stashDiscardEllipsis: 'Odrzuć…',
        stashSwitcherA11y: 'Wybierz stash',
        stashCount: ({ count }) => (count === 1 ? '1 stash' : `Stashe: ${count}`),
    } } satisfies Pick<Record<string, DetailsHistoryTranslations>, "pl">;

return { detailsHistoryTranslations };
})();

const Domain_detailsReviewTranslations = (() => {
type Count = Shared_detailsReviewTranslations.Count;

type DetailsReviewTranslations = Shared_detailsReviewTranslations.DetailsReviewTranslations;

const detailsReviewTranslations = { pl: {
        title: 'Przegląd',
        files: ({ count }) => (count === 1 ? `1 plik` : `Pliki: ${count}`),
        nextCommit: ({ count }) => `W następnym commicie: ${count}`,
        changedFiles: 'Zmienione pliki',
        commitColumn: 'Commit',
        jumpA11y: 'Przejdź do pliku',
        comments: ({ count }) => (count === 1 ? `1 komentarz` : `Komentarze: ${count}`),
        goesWithNext: ({ count }) => (count === 1 ? `trafi do następnej wiadomości` : `trafią do następnej wiadomości`),
        askForChanges: 'Poproś o zmiany',
        detachCommentA11y: 'Nie dołączaj tego komentarza do następnej wiadomości',
        trayExpandedHint: 'Trafią do agenta z twoją następną wiadomością.',
        askPlaceholder: 'Powiedz agentowi, co zmienić…',
        send: 'Wyślij',
        draftAuthor: 'Ty', draftStatus: 'szkic', includeComment: 'Trafi do następnej wiadomości',
    } } satisfies Pick<Record<string, DetailsReviewTranslations>, "pl">;

return { detailsReviewTranslations };
})();

const Domain_embedSettingsTranslations = (() => {
const english = Shared_embedSettingsTranslations.english;

const translated = Shared_embedSettingsTranslations.translated;

const embedSettingsTranslations = { pl: translated({
        settingsEmbeds: {
            title: "Osadzenia",
            newTitle: "Nowe osadzenie",
            purpose: "Pozwól innym aplikacjom wyświetlać czaty Happier, tylko z dostępem, który wybierzesz.",
            yourEmbeds: "Twoje osadzenia",
            newEmbed: "Nowe osadzenie",
            listError: "Nie udało się wczytać osadzeń",
            emptyTitle: "Umieść czat Happier we własnej aplikacji",
            emptyBody: "Twoja aplikacja pokazuje prawdziwe rozmowy, tylko z dostępem, który wybierzesz: które witryny, kto może wysyłać lub zatwierdzać i które modele.",
            createDescription: "Wybierz, co inne aplikacje mogą robić z twoimi czatami i jak one wyglądają.",
            name: "Nazwa",
            nameDescription: "Widoczna tylko dla ciebie, na tej liście.",
            namePlaceholder: "Na przykład panel leadów",
            create: "Utwórz osadzenie",
            summary: {
                sites: ({ count }: { count: number }) => count === 1 ? '1 witryna' : `Witryny: ${count}`,
                send: "Może wysyłać",
                sendAndApprove: "Może wysyłać i zatwierdzać",
                viewOnly: "Tylko podgląd",
                modelOnly: ({ name }: { name: string }) => `tylko ${name}`,
                models: ({ count }: { count: number }) => count === 1 ? '1 model' : `Modele: ${count}`,
            },
            sites: {
                title: "Gdzie może się pojawiać",
                description: "Czaty otwierają się tylko na tych witrynach.",
            },
            capabilities: {
                title: "Co mogą robić użytkownicy",
                view: "Podgląd rozmowy",
                always: "Zawsze",
                send: "Wysyłanie wiadomości",
                sendDescription: "Obejmuje zatrzymywanie agenta i dołączanie plików.",
                changeModel: "Zmiana modelu",
                permissionModes: "Tryby uprawnień",
                permissionModesDescription: "Czaty pokazują wybór trybu tylko wtedy, gdy dozwolony jest więcej niż jeden tryb.",
                anyMode: "Dowolny tryb",
                anyModeDescription: "Osoby mogą zmieniać, ile agent robi bez pytania.",
                modeOnly: ({ name }: { name: string }) => `tylko ${name}`,
                modes: ({ count }: { count: number }) => `Tryby: ${count}`,
                approveOn: "Osoby na tych stronach mogą zatwierdzać użycie narzędzi i prośby w tych czatach.",
            },
            models: {
                title: "Modele",
                description: "Inne modele są odrzucane, a nie tylko ukrywane. Czaty zaczynają od pierwszego dozwolonego modelu.",
                allowed: "Dozwolone modele",
                any: "Dowolny model",
            },
            organization: {
                title: "Organizacja",
                description: "Twoja aplikacja wyświetla stąd czaty tego osadzenia (z dowolnym z tych tagów). Nowe czaty też trafiają tutaj.",
                folder: "Folder",
                tags: "Tagi",
                none: "Brak",
            },
            composer: {
                title: "Pole wiadomości",
                attachments: "Załączniki",
                attachmentsDescription: "Ukrywa przycisk załączania. Kto może wysyłać, nadal może dołączać pliki przez API.",
            },
            sessions: {
                title: "Sesje",
                description: "Sesje tworzone tym kluczem, z twojego serwera lub z czatu, działają na tym komputerze z tym agentem i trafiają do folderu i tagów powyżej.",
                allow: "Pozwól temu kluczowi tworzyć sesje",
                offConsequence: "Ten klucz nie może tworzyć sesji. Twoja aplikacja może pokazywać tylko istniejące czaty.",
                computer: "Komputer",
                agent: "Agent",
                newChat: "Rozpoczynanie nowych czatów w osadzeniu",
                appSetting: "Dla Twojej aplikacji",
                newChatDescription: "Pokazuje pole nowego czatu, gdy aplikacja otwiera osadzenie bez czatu. To ustawienie dla twojej aplikacji, a nie ograniczenie bezpieczeństwa: twój serwer zawsze może tworzyć czaty tym kluczem.",
            },
            appearance: {
                title: "Wygląd",
                description: "Podgląd śledzi każdą zmianę. Otwarte czaty zmieniają wygląd bez przeładowania.",
                mode: "Tryb",
                modeSystem: "Systemowy",
                modeLight: "Jasny",
                modeDark: "Ciemny",
                theme: "Motyw",
                presetHappier: "Happier",
                colors: "Kolory",
                colorsDefault: "Kolory Happier",
                colorsCustomized: ({ count }: { count: number }) => `Zmienione: ${count}`,
                colorsFor: "Kolory dla",
                colorGroups: {
                    surface: "Powierzchnie",
                    text: "Tekst",
                    accent: "Akcent",
                    messages: "Wiadomości",
                    composer: "Pole wiadomości",
                    approvals: "Zatwierdzenia",
                },
                fontFamily: "Czcionka",
                fontFamilyPlaceholder: "Czcionka Happier",
                fontFile: "Plik czcionki",
                fontFileDescription: "Link https do pliku .woff2 lub .woff.",
                fontFileRefused: "Użyj linku do pliku .woff2 lub .woff, a nie arkusza stylów.",
                textSize: "Rozmiar tekstu",
                textSizeCompact: "Kompaktowy",
                textSizeDefault: "Domyślny",
                textSizeLarge: "Duży",
                corners: "Narożniki",
                cornersSharp: "Ostre",
                cornersSoft: "Łagodne",
                cornersRound: "Zaokrąglone",
                density: "Gęstość",
                densityCompact: "Zwarta",
                densityComfortable: "Wygodna",
                reset: "Przywróć wygląd",
            },
            preview: {
                title: "Podgląd na żywo",
                phone: "Telefon",
                desktop: "Komputer",
                reduceMotion: "Ogranicz ruch",
                note: "Prawdziwy osadzony czat z przykładowymi wiadomościami. Nic nie jest wysyłane.",
                rowDescription: "Zobacz czat z tymi ustawieniami.",
                unavailable: "Podgląd niedostępny",
            },
            snippets: {
                title: "Fragmenty kodu",
                description: "Wklej je do swojej aplikacji. Już używają ustawień tego osadzenia.",
                steps: "1 Zapisz klucz jako HAPPIER_EMBED_KEY · 2 Napisz canOpenSession: kto może otworzyć który czat · 3 Wyświetl czat",
                backend: "Serwer",
                react: "React",
            },
            detail: {
                created: ({ date }: { date: string }) => `Utworzono ${date}`,
                lastUsed: ({ date }: { date: string }) => `Ostatnio użyto ${date}`,
                expires: ({ date }: { date: string }) => `Wygasa ${date}`,
                reconnect: "Otwarte czaty połączą się ponownie z nowym dostępem. Szkice zostaną zachowane.",
                e2eeTrust: "Ten klucz może czytać zaszyfrowane czaty tego konta. Używaj osobnego konta dla swojej aplikacji.",
                keyReach: "Klucz zostaje na Twoim serwerze i ma dostęp do każdego czatu na tym koncie. Przeglądarki nigdy go nie widzą: dostają krótkotrwałe klucze ograniczone do czatów, na które pozwala Twój serwer.",
                expiry: "Klucz wygasa",
                expiryDescription: "Gdy klucz wygaśnie, czaty przestaną się otwierać. Nie można go później przedłużyć.",
                encryptionChecking: "Sprawdzanie szyfrowania tego konta…",
                encryptionUnavailable: "To urządzenie nie może jeszcze czytać zaszyfrowanych czatów tego konta. Przywróć klucz tajny, aby utworzyć osadzenie.",
                encryptionStale: "Klucze tego urządzenia do zaszyfrowanych czatów są nieaktualne. Przywróć klucz tajny, aby utworzyć osadzenie.",
                encryptionUnreadable: "Nie udało się sprawdzić szyfrowania tego konta.",
                missingTitle: "To osadzenie już nie istnieje",
                backToEmbeds: "Wróć do osadzeń",
            },
            delete: {
                button: "Usuń osadzenie",
                title: ({ label }: { label: string }) => `Usunąć „${label}”?`,
                body: "Otwarte czaty zostaną rozłączone. Kluczy już użytych do czytania zaszyfrowanych czatów nie da się cofnąć.",
                confirm: "Usuń",
            },
            reveal: {
                copyEnv: "Kopiuj jako wiersz .env",
            },
        },
    }) };

return { embedSettingsTranslations };
})();

const Domain_embedTranslations = (() => {
const english = Shared_embedTranslations.english;

const translated = Shared_embedTranslations.translated;

const embedTranslations = { pl: translated({
        embed: {
            errors: {
                originNotAllowed: 'Ta strona nie może wyświetlać tej rozmowy.',
                originNotAllowedReason: 'Dodaj tę witrynę do dozwolonych witryn osadzenia w Happier.',
                unavailable: 'Ta rozmowa nie jest tu dostępna.',
                encrypted: 'Ta rozmowa jest zaszyfrowana i nie można jej tu otworzyć.',
                createNotGranted: 'Ta aplikacja nie może rozpoczynać nowych czatów.',
                unsupportedVersion: 'Ten czat wymaga nowszego osadzenia.',
                unsupportedVersionReason: 'Zaktualizuj @happier-dev/embed w tej aplikacji.',
            },
            nothingToShow: 'Na razie nie ma nic do pokazania',
            nothingToShowReason: 'Ta aplikacja nie otworzyła żadnej rozmowy.',
            reconnecting: 'Ponowne łączenie…',
            previewUnavailable: 'Podgląd niedostępny',
            previewUser: "Przeanalizuj tego leada i zapisz wynik: Acme Robotics, 40 stanowisk, ocena w czwartym kwartale.",
            previewAgent: "Bardzo dobre dopasowanie. Budżet jest potwierdzony, a decyzję podejmuje ambasador. Zapisałem analizę:",
            previewFollowUp: "Przenieść tego leada do zakwalifikowanych?",
        },
    }) };

return { embedTranslations };
})();

const Domain_entityDragDropTranslations = (() => {
type EntityDragDropTranslations = Shared_entityDragDropTranslations.EntityDragDropTranslations;

const en = Shared_entityDragDropTranslations.en;

const pl: EntityDragDropTranslations = {
    files: { attach: "Dołącz", uploadHere: "Prześlij tutaj" },
    composer: { addContext: "Dodaj kontekst", consequence: "Wysyłane z następną wiadomością · nic jeszcze nie zostanie wysłane", target: "Edytor", readOnly: "Ten edytor jest tylko do odczytu", otherWorkspace: "Nie należy do tego obszaru roboczego", unavailable: "To odwołanie jest niedostępne" },
    surface: {
        scopeMismatch: 'Znajduje się w innym Home lub na innym koncie',
        widgetMoveUnavailable: 'Tego widżetu nie można przenieść do tego obszaru',
        readOnly: 'Ta tablica jest tylko do odczytu',
        copyDetail: 'Zachowuje odwołanie · tablica pozostaje bez zmian',
    },
    preview: {
        putUnder: ({ target }) => `Umieść pod ${target}`,
        putUnderDetail: 'Raportuje do niej · obie dalej działają',
        moveAbove: ({ target }) => `Przenieś nad ${target}`,
        moveBelow: ({ target }) => `Przenieś pod ${target}`,
        orderDetail: 'Tylko kolejność · nikt nikomu nie raportuje',
        moveToFolder: ({ folder }) => `Przenieś do ${folder}`,
        folderDetail: 'Tylko folder · nikomu nie raportuje',
        moveToTopLevel: 'Przenieś na najwyższy poziom',
        topLevelDetail: 'Poza folder · nic innego się nie zmienia',
        cantPutUnder: ({ target }) => `Nie można umieścić pod ${target}`,
        cantMoveHere: 'Nie można jej tu przenieść',
        pendingPutUnder: ({ target }) => `Umieszczanie pod ${target}…`,
        pendingDetail: 'Czekam na potwierdzenie Home',
        unknownTitle: 'Nie wiadomo, czy przeniesiono',
        unknownDetail: 'Sprawdź listę za chwilę, zanim spróbujesz ponownie',
    },
    settled: {
        refusedPutUnder: ({ item, target }) => `Nie udało się umieścić ${item} pod ${target}`,
        refused: ({ verb }) => `${verb}: nie udało się`,
        unknown: ({ verb }) => `Nie wiadomo, czy „${verb}” się udało`,
        dismiss: 'Zamknij',
    },
    reasons: {
        read: 'Udostępniono ci ją tylko do odczytu, więc nie może przyjmować raportów',
        input: 'Nie możesz nic do niej wysłać, więc nie może przyjmować raportów',
        pairwise: 'Te dwie sesje nie mogą dzielić kontekstu',
        cycle: 'Ta sesja już raportuje do tej',
        alreadyUnder: 'Już raportuje do tej',
        archived: 'Jest zarchiwizowana',
        differentHome: 'Jest w innym Home. Sesje raportują w obrębie jednego Home',
        unavailable: 'Nie udało się teraz sprawdzić tej sesji',
        dateOrder: 'Ta lista jest posortowana według daty. Przełącz na własną kolejność, aby ją umieścić',
        noChange: 'Już tu jest',
        descendantCycle: 'Folder nie może trafić do samego siebie',
        maxDepth: 'Foldery byłyby zagnieżdżone zbyt głęboko',
        foldersOff: 'Foldery są wyłączone w tym Home',
        gone: 'To miejsce właśnie zniknęło',
        generic: 'To miejsce nie może tego przyjąć',
    },
    chooser: { putUnderTitle: ({ item }) => `Umieść ${item} pod…`, checking: 'Sprawdzanie, które sesje mogą przyjmować raporty…', cantTakeReports: 'Nie mogą przyjmować raportów', unavailable: 'Niedostępne' },
    keyboard: {
        choose: 'Wybierz miejsce', putUnder: 'Umieść pod', topLevel: 'Najwyższy poziom', drop: 'Upuść', cancel: 'Anuluj', escapeKey: 'Esc',
        hintsA11y: 'Strzałki wybierają miejsce, Enter upuszcza, Escape anuluje',
    },
    organize: { enter: 'Porządkuj listę', title: 'Porządkuj', done: 'Gotowe', grip: ({ item }) => `Przenieś ${item}` },
    pane: {
        openHere: 'Otwórz tutaj jako kartę',
        nextTo: ({ target }) => `Obok ${target} · nic się nie zamyka`,
        nothingCloses: 'Otwiera się jako karta · nic się nie zamyka',
        tooNarrow: 'Ten panel jest za wąski, by go podzielić',
        moveHere: 'Przenieś tutaj jako kartę',
        openBefore: ({ target }) => `Otwórz przed ${target}`,
        moveBefore: ({ target }) => `Przenieś przed ${target}`,
        placeOnly: 'Zmienia się tylko miejsce',
        splitLeft: 'Podziel w lewo',
        splitRight: 'Podziel w prawo',
        splitUp: 'Podziel w górę',
        splitDown: 'Podziel w dół',
        opensBeside: ({ target }) => `Otworzy się obok ${target}`,
        movesBeside: ({ target }) => `Przeniesie się obok ${target}`,
        goTo: ({ target }) => `Przejdź do ${target}`,
        openInThisPane: 'Już otwarta w tym panelu · nic nowego się nie otworzy',
        openInAnotherPane: 'Już otwarta w innym panelu · nic nowego się nie otworzy',
        alreadyHere: 'Już tutaj jest',
        leaveIt: 'Puść, by zostawić ją na miejscu',
        cantOpenHere: 'Nie można jej tu otworzyć',
        sessionsOnly: 'Ten panel pokazuje tylko sesje',
        otherWorkspace: 'Nie należy do tego obszaru roboczego',
    },
};

const entityDragDropTranslations = { pl };

return { entityDragDropTranslations };
})();

const Domain_eventAutomationComposerTranslations = (() => {
const english = Shared_eventAutomationComposerTranslations.english;

const pl = {
    eventAutomationComposer: {
        available: 'Dostępne',
        payloadFields: 'POLA ŁADUNKU',
        payloadSample: 'Przykładowy ładunek',
        noFilterableFields: 'To zdarzenie nie deklaruje możliwych do filtrowania pól ładunku.',
        addFilterClause: 'Dodaj warunek',
        filterField: 'Pole filtra',
        filterOperator: 'Operator filtra',
        filterEquals: 'Równe',
        filterOneOf: 'Jest jednym z',
        filterValue: 'Wartość filtra',
        filterValuePlaceholder: '„wartość” lub [„wartość”]',
        storedContentUnavailableTitle: 'Przechowywane treści automatyzacji są niedostępne',
        storedContentUnavailableBody: 'Nie można zapisać tej automatyzacji wydarzenia, ponieważ przechowywana w niej zawartość jest niedostępna.',
        historyGapRecoveryTitle: 'Luka w historii wymaga uwagi',
        historyGapRecoverySubtitle: 'Zresetuj linię bazową źródła, aby wznowić obserwację nowych zdarzeń.',
        historyGapRecoveryUnavailable: 'Akcja odzyskiwania źródła nie jest dostępna w bieżącym obserwatorze.',
        historyGapRecoveryFailureTitle: 'Odzyskiwanie źródła wymaga kolejnej próby',
        historyGapRecoveryFailureBody: 'Powrót do zdrowia nie został potwierdzony. Źródło nadal wymaga uwagi.',
        sourceStatusTitle: 'Źródło obserwacji',
        sourceStatusState: {
            uninitialized: 'Nie uruchomiono',
            baselined: 'Punkt bazowy gotowy',
            observing: 'Trwa obserwacja',
            backingOff: 'Oczekiwanie na ponowienie',
            attention: 'Wymaga uwagi',
        },
        sourceStatusCode: {
            credentialMissing: 'Wymagane dane uwierzytelniające',
            credentialRevoked: 'Dane uwierzytelniające unieważnione',
            rateLimited: 'Ograniczenie liczby żądań',
            historyGap: 'Luka w historii',
            capacityBlocked: 'Brak dostępnej pojemności',
            definitionStale: 'Definicja uległa zmianie',
            sourceContractIncompatible: 'Źródło wymaga aktualizacji',
            admissionUnavailable: 'Przyjęcie niedostępne',
        },
        sourceStatusNextRetry: ({ time }: { time: string }) => `Następna próba: ${time}`,
        sourceStatusObservedCount: ({ count }: { count: number }) => `Zaobserwowane zdarzenia: ${count}`,
        sourceStatusAdmittedCount: ({ count }: { count: number }) => `Przyjęte zdarzenia: ${count}`,
        sourceStatusSkippedCount: ({ count }: { count: number }) => `Pominięte zdarzenia: ${count}`,
        sourceStatusLastObserved: ({ time }: { time: string }) => `Ostatnia obserwacja: ${time}`,
        sourceCatalogStatusTitle: 'Uzgadnianie katalogu',
        sourceCatalogStatusState: {
            current: 'Aktualny',
            reconciling: 'Trwa uzgadnianie',
            reconciliationLate: 'Uzgadnianie jest opóźnione',
        },
        sourceCatalogStatusObservedRevision: ({ revision }: { revision: string }) => `Zaobserwowana wersja: ${revision}`,
        sourceCatalogStatusAdoptedRevision: ({ revision }: { revision: string }) => `Przyjęta wersja: ${revision}`,
        sourceCatalogStatusNoAdoptedRevision: 'Żadna wersja nie została jeszcze przyjęta',
        sourceCatalogStatusScanStarted: ({ time }: { time: string }) => `Skanowanie rozpoczęto: ${time}`,
    },
};

const eventAutomationComposerTranslations = { pl } as const;

return { eventAutomationComposerTranslations };
})();

const Domain_externalSessionOperationTranslations = (() => {
const en = Shared_externalSessionOperationTranslations.en;

const translated = Shared_externalSessionOperationTranslations.translated;

const externalSessionOperationTranslations = { pl: {
    browseLinked: 'Połączona',
    browseImported: 'Zaimportowana',
    browseAgentUnavailable: 'Happier nie mógł uruchomić wybranego Agenta ani się z nim połączyć na tej maszynie. Sprawdź, czy jego CLI jest tam zainstalowane, i spróbuj ponownie.',
    browseAgentTimedOut: 'Wybrany Agent na tej maszynie nie odpowiedział na czas. Może być zajęty lub wciąż indeksować, więc spróbuj ponownie.',
    browseAgentFailed: 'Happier nie mógł odczytać sesji wybranego Agenta na tej maszynie. Spróbuj ponownie; jeśli błąd się powtarza, zaktualizuj Happier na tej maszynie.',
    operationTitleMaterialize: 'Importuj do Happier',
    operationTitleTakeoverLinked: 'Przejmij i zachowaj połączenie',
    operationTitleTakeoverPersisted: 'Importuj i przejmij',
    operationMaterializeAvailable: 'Zaimportuj tę połączoną sesję, aby korzystać z transkrypcji offline lub ją udostępnić.',
    externalAgentStatusOnMachine: ({ agent, machine, status }: { agent: string; machine: string; status: string }) =>
        `${agent} na ${machine}: ${status}`,
    operationStatusRunning: 'W toku',
    operationStatusCancelling: 'Anulowanie…',
    operationStatusCancelled: 'Anulowano',
    operationStatusCompleted: 'Ukończono',
    operationStatusDiscarded: 'Odrzucono częściową sesję',
    operationStatusNeedsResume: 'Oczekiwanie na wznowienie',
    operationStatusNeedsReview: 'Przed kontynuacją wymaga sprawdzenia',
    operationStatusFailed: 'Nie udało się kontynuować',
    operationStatusImportIncomplete: 'Import nieukończony — Wznów lub odrzuć częściową sesję',
    operationStatusUpdateIncomplete: 'Aktualizacja nieukończona — Wznów',
    operationStatusOriginOffline: 'Postęp zapisany — maszyna źródłowa jest offline',
    operationStatusOriginUnknown: 'Postęp zapisany — Happier nie może sprawdzić, czy maszyna źródłowa jest online',
    operationStatusExternalWriter: 'Wykryto zewnętrzny zapis',
    operationStatusSpawnFailedAfterImport: 'Zaimportowano, ale nie udało się uruchomić Agenta — Ponów uruchomienie',
    operationStatusSpawnFailedAfterTakeover: 'Przejęto, ale nie udało się uruchomić Agenta — Ponów uruchomienie',
    operationErrorSourceUnavailable: 'Źródło jest niedostępne. Połącz ponownie maszynę źródłową, a następnie wznów.',
    operationErrorSourceChanged: 'Źródło zmieniło się podczas odczytu. Sprawdź je przed wznowieniem.',
    operationErrorCapacity: 'Ta maszyna nie ma wystarczającej pojemności tymczasowej, aby kontynuować.',
    operationErrorRequiredItems: 'Nie udało się zaimportować niektórych wymaganych elementów sesji.',
    operationErrorImport: 'Import wiadomości został przerwany.',
    operationErrorPublication: 'Nie udało się opublikować zaimportowanej migawki.',
    operationErrorAdmission: 'Happier nie mógł bezpiecznie przejąć kontroli nad tą sesją.',
    operationErrorExternalWriter: 'Zatrzymaj zewnętrznego Agenta przed ponowną próbą. Happier nie połączy go ani nie zatrzyma automatycznie.',
    operationErrorInternal: 'Operacja została zatrzymana z powodu błędu wewnętrznego.',
    operationPhaseValidating: 'Sprawdzanie',
    operationPhaseWaitingForAgent: 'Oczekiwanie na zatrzymanie zewnętrznego Agenta',
    operationPhaseReadingSource: 'Odczytywanie źródła',
    operationPhaseImporting: 'Importowanie wiadomości',
    operationPhaseCatchingUp: 'Synchronizacja ze źródłem',
    operationPhasePreparingRuntime: 'Przygotowywanie środowiska uruchomieniowego',
    operationPhaseStartingRuntime: 'Uruchamianie środowiska',
    operationPhaseFinalizing: 'Finalizowanie',
    operationPhasePublishing: 'Publikowanie zaimportowanej sesji',
    operationActionResume: 'Wznów',
    operationActionRetryStart: 'Ponów uruchomienie',
    operationActionCancel: 'Anuluj',
    operationActionDiscard: 'Odrzuć częściową sesję',
    operationActionDismiss: 'Zamknij',
    operationStatusOwnerReadFailed: 'Happier nie mógł odczytać bieżącego postępu tej operacji.',
    operationActionCheckAgain: 'Sprawdź ponownie',
    operationComposerImporting: 'Importowanie…',
    operationComposerTakingOver: 'Przejmowanie…',
    operationActionErrorUpgradeRequired: 'Zaktualizuj Happier na maszynie źródłowej, aby użyć tej akcji.',
    operationActionErrorNotFound: 'Ta operacja nie jest już dostępna.',
    operationActionErrorConflict: 'Inna operacja już kontroluje tę sesję.',
    operationActionErrorStaleRevision: 'Operacja uległa zmianie. Sprawdź najnowszy postęp i spróbuj ponownie.',
    operationActionErrorInvalidState: 'Ta akcja nie jest dostępna w bieżącym stanie operacji.',
    operationActionErrorNotAllowed: 'Nie masz uprawnień do sterowania tą operacją.',
    operationActionErrorUnavailable: 'Nie udało się wykonać akcji. Spróbuj ponownie od najnowszego postępu.',
    operationImportProgress: 'Postęp importu',
    operationImportCountUnknown: ({ imported }: { imported: number }) => `Zaimportowano wiadomości: ${imported}`,
    operationImportCountEstimated: ({ imported, total }: { imported: number; total: number }) => `${imported} z ok. ${total} wiadomości`,
    operationPublishedSnapshot: 'Zachowano opublikowaną migawkę',
    operationPublishedThrough: ({ sequence }: { sequence: number }) => `Dostępne do wiadomości ${sequence}`,
    operationDiscardConfirmTitle: 'Odrzucić częściową sesję?',
    operationDiscardConfirmBody: 'Spowoduje to usunięcie całej częściowej sesji. Tej akcji nie można cofnąć.',
    sharingTranscriptOnMachine: ({ machine }: { machine: string }) =>
        `Transkrypcja tej sesji znajduje się na maszynie ${machine}. Zaimportuj ją do Happier, aby udostępnić.`,
    sharingImportIncomplete: 'Import jest w toku lub nie został ukończony. Wznów go przed udostępnieniem.',
    sharingTranscriptUnavailableTitle: 'Transkrypcja niedostępna',
    transcriptRetainedRefreshFailedTitle: 'Wyświetlana jest ostatnia znana transkrypcja',
    transcriptLoadFailed: 'Happier nie mógł wczytać tej transkrypcji.',
    sharingTranscriptUnavailable: 'Transkrypcja jest niedostępna. Ta starsza połączona sesja nie ma bezpiecznej, zapisanej transkrypcji.',
    sharingSharedUpTo: ({ time }: { time: string }) => `Udostępniono do ${time}`,
    sharingSnapshotFrom: ({ time }: { time: string }) => `Migawka z ${time}`,
    sharingUpdateSharedCopy: 'Zaktualizuj udostępnioną kopię',
    sharingUpdateSharedCopyDescription: 'Odśwież udostępnioną migawkę najnowszą transkrypcją ze źródła.',
    sharingSourceMachineMissing: 'Maszyna źródłowa jest niedostępna. Przed ponowną próbą połącz ją ponownie z Happier.',
    sharingSourceMachineOffline: 'Maszyna źródłowa jest offline. Przed ponowną próbą przełącz ją w tryb online.',
    sharingActionAwaitingAvailability: 'Ta akcja będzie dostępna po połączeniu przepływu materializacji.',
} } as const;

return { externalSessionOperationTranslations };
})();

const Domain_externalSessionSettingsTranslations = (() => {
const en = Shared_externalSessionSettingsTranslations.en;

const translated = Shared_externalSessionSettingsTranslations.translated;

const externalSessionSettingsTranslations = { pl: {
    settingsIntegrationStatusNotInstalled: 'Nie zainstalowano',
    settingsIntegrationStatusEnabled: 'Zainstalowano i włączono',
    settingsIntegrationStatusDisabled: 'Zainstalowano i wyłączono',
    settingsIntegrationStatusNeedsAttention: 'Wymaga uwagi',
    settingsIntegrationStatusUnsupported: 'Nieobsługiwane przez tę wersję Agenta',
    settingsIntegrationStatusUnavailable: 'Agent niedostępny',
    settingsIntegrationInventoryLoadingTitle: 'Sprawdzanie stanu integracji',
    settingsIntegrationInventoryLoadingSubtitle: 'Odczytywanie pełnego spisu integracji z tej maszyny.',
    settingsIntegrationInventoryPartialTitle: 'Stan integracji jest niepełny',
    settingsIntegrationInventoryPartialSubtitle: 'Nie udało się odczytać niektórych rekordów instalacji. Sprawdź ponownie przed wprowadzeniem zmian.',
    settingsIntegrationInventoryErrorTitle: 'Stan integracji jest niedostępny',
    settingsIntegrationInventoryErrorSubtitle: 'Ostatni znany stan może być nieaktualny. Sprawdź ponownie przed wprowadzeniem zmian.',
    settingsIntegrationTitle: 'Monitorowanie sesji zewnętrznych',
    settingsIntegrationNeedsAttentionTitle: 'Wymaga uwagi',
    settingsIntegrationDiagnosticMessageUnavailable: 'Ta instalacja wymaga uwagi, zanim będzie można kontynuować monitorowanie.',
    settingsIntegrationRemediationRetry: 'Sprawdź ponownie po rozwiązaniu problemu.',
    settingsIntegrationRemediationOpenSettings: ({ path }: { path: string }) => `Sprawdź ustawienie w ${path}.`,
    settingsIntegrationRemediationSelectAccount: ({ service }: { service: string }) => `Wybierz konto dla ${service}.`,
    settingsIntegrationRemediationInstallDependency: ({ dependency }: { dependency: string }) => `Zainstaluj wymaganą zależność: ${dependency}.`,
    settingsIntegrationRemediationOpenUrl: ({ url }: { url: string }) => `Zapoznaj się ze wskazówkami pod adresem ${url}.`,
    settingsIntegrationActionReviewInstall: 'Sprawdź i zainstaluj',
    settingsIntegrationActionDisable: 'Wyłącz',
    settingsIntegrationActionEnable: 'Włącz',
    settingsIntegrationActionUninstall: 'Odinstaluj',
    settingsIntegrationActionCheckAgain: 'Sprawdź ponownie',
    settingsIntegrationReviewTitle: ({ agent }: { agent: string }) => `Sprawdź integrację ${agent}`,
    settingsIntegrationReviewBody: ({ entries }: { entries: string }) =>
        `Happier będzie zarządzać tylko tymi wpisami: ${entries}.`,
    settingsIntegrationReviewBodyUnavailable: 'Sprawdź zmiany zarządzane przez Agenta przed instalacją.',
    settingsIntegrationPreviewNoMatcher: 'Wszystkie pasujące sesje',
    settingsIntegrationActionInstall: 'Zainstaluj',
    settingsIntegrationUninstallTitle: ({ agent }: { agent: string }) => `Odinstalować integrację ${agent}?`,
    settingsIntegrationUninstallBody: 'Usuwa tylko wpisy zarządzane przez Happier. Pozostała konfiguracja Agenta nie ulega zmianie.',
    settingsIntegrationActionFailed: 'Happier nie mógł zaktualizować tej integracji. Sprawdź maszynę i spróbuj ponownie.',
    settingsAutoLinkUpdateFailed: 'Happier nie mógł zaktualizować automatycznego łączenia. Spróbuj ponownie.',
    settingsRestoreUpdateFailed: 'Happier nie mógł zaktualizować ustawienia synchronizacji po ponownym uruchomieniu. Spróbuj ponownie.',
    settingsIntegrationsGroupTitle: 'Monitorowanie sesji zewnętrznych',
    settingsIntegrationsFooter: 'Happier zmienia konfigurację Agenta tylko po wyraźnej akcji. Otwarcie tej strony jest tylko do odczytu.',
    settingsIntegrationsUnavailableTitle: 'Brak dostępnych integracji',
    settingsIntegrationsUnavailableSubtitle: 'Połącz obsługiwaną integrację Agenta, aby sprawdzić jej stan i dostępne akcje.',
    settingsAgentAutoLinkTitle: ({ agent }: { agent: string }) => `Automatycznie dodawaj nowe sesje ${agent}`,
    settingsAutoLinkTitle: 'Automatycznie dodawaj nowe sesje zewnętrzne',
    browseAutoLinkTitle: 'Automatycznie dodawaj nowe sesje',
    settingsAutoLinkGroupTitle: 'Automatyczne łączenie',
    settingsAutoLinkGroupFooter: 'Automatyczne łączenie jest domyślnie wyłączone i niezależne od konfiguracji integracji Agenta oraz synchronizacji w tle.',
    settingsAutoLinkUnavailableTitle: 'Brak źródeł automatycznego łączenia',
    settingsAutoLinkUnavailableSubtitle: 'Na tej maszynie nie ma obsługiwanych zakresów źródła.',
    settingsAutoLinkSubtitle: 'Po włączeniu Happier łączy obsługiwane nowe sesje z tego źródła bez otwierania ani wznawiania Agenta.',
    settingsAutoLinkHint: 'Włącza lub wyłącza automatyczne łączenie dla tego źródła.',
    settingsPrivacyGroupTitle: 'Prywatność',
    settingsPrivacyTitle: 'Ograniczone obserwacje bez treści',
    settingsPrivacySubtitle: 'Zaufane integracje Agentów mogą odczytywać ograniczone natywne dane hooków na tej maszynie. Happier przyjmuje i synchronizuje wyłącznie obserwacje bez treści; host nigdy nie zapisuje, nie synchronizuje ani nie rejestruje surowych ładunków, ścieżek, danych logowania, poleceń, tekstu transkrypcji ani argumentów narzędzi.',
    settingsAgentActionsGroupTitle: 'Sesje zewnętrzne',
    settingsAgentBrowseTitle: ({ agent }: { agent: string }) => `Przeglądaj zewnętrzne sesje ${agent}`,
    settingsManageAllTitle: 'Zarządzaj wszystkimi ustawieniami Sesji zewnętrznych',
    settingsManageAllSubtitle: 'Sprawdź integracje i synchronizację w tle na połączonych maszynach.',
    settingsMachineOnline: 'Połączona',
    settingsMachineOffline: 'Nieaktywny',
    settingsMachineTitle: 'Maszyna',
    settingsMachineUnavailable: 'Brak połączonej maszyny',
    browseSearchIncomplete: ({ count }: { count: number }) =>
        `Wyświetlono pierwsze ${count} — zawęź wyszukiwanie`,
    browseAnnotationsIncomplete: 'Nie udało się potwierdzić niektórych stanów. Otwarcie sesji je sprawdzi.',
    browseRouteUnavailableTitle: 'Sesje zewnętrzne są tu niedostępne',
    browseRouteUnavailableSubtitle: 'Ten serwer nie udostępnia przeglądania sesji zewnętrznych. Wróć i wybierz inny serwer albo spróbuj później.',
    browseRouteAvailabilityUnknownTitle: 'Nie udało się potwierdzić obsługi sesji zewnętrznych',
    browseRouteAvailabilityUnknownSubtitle: 'Happier nie mógł sprawdzić, czy ten serwer udostępnia przeglądanie sesji zewnętrznych. Wróć i spróbuj ponownie za chwilę.',
    browseHeaderTitle: 'Sesje zewnętrzne',
    browseSettingsLink: 'Ustawienia sesji zewnętrznych',
    browseChooseMachineTitle: 'Wybierz maszynę',
    browseChooseMachineBody: 'Sesje zewnętrzne są na maszynie, która je uruchomiła. Wybierz ją, aby zobaczyć jej sesje.',
    browseMachineGoneBody: 'Została usunięta lub zastąpiona. Wybierz inną maszynę, aby zobaczyć jej sesje.',
    browseHomeUnreachableBody: 'Jego maszyny i sesje pojawią się, gdy będzie osiągalny. W międzyczasie wybierz inną maszynę.',
    browseMachineOfflineTitle: ({ machine }: { machine: string }) => `${machine} jest offline`,
    browseThisMachineOfflineTitle: 'Ta maszyna jest offline',
    browseMachineOfflineBody: 'Jej sesje pojawią się, gdy ponownie się połączy.',
    browseChooseAnotherMachine: 'Wybierz inną maszynę',
    browseCantReachTitle: ({ machine }: { machine: string }) => `Nie można połączyć się z Happier na ${machine}`,
    browseCantReachBody: 'Maszyna jest online, ale jej usługa Happier nie odpowiada. Może wciąż się uruchamiać.',
    browseNothingToBrowseTitle: ({ machine }: { machine: string }) => `Nic do przeglądania na ${machine}`,
    browseNothingToBrowseBody: 'Żaden z agentów na tej maszynie nie może jeszcze udostępniać swoich sesji.',
    browseEmptyTitle: ({ agent, machine }: { agent: string; machine: string }) => `Brak sesji ${agent} na ${machine}`,
    browseEmptyBody: 'Sesje uruchomione na tej maszynie pojawiają się tutaj, gotowe do otwarcia w Happier.',
    browseTryAgent: ({ agent }: { agent: string }) => `Wypróbuj ${agent}`,
    browseNoMatches: ({ query }: { query: string }) => `Żadna sesja nie pasuje do „${query}”`,
    browseErrorTitle: 'Nie udało się wczytać sesji',
    browseThisMachine: 'tej maszynie',
    browseIndexingStop: 'Zatrzymaj',
    browseThreadsFilter: 'Wątki podagentów',
    browseThreadsHidden: 'Tylko główne sesje',
    browseThreadsShown: 'Z wątkami subagentów',
    browseThreadReviewer: 'Recenzent',
    browseThreadSubagent: 'Podagent',
    browseThreadReviewerOf: ({ parent }: { parent: string }) => `Recenzent: ${parent}`,
    browseThreadSubagentOf: ({ parent }: { parent: string }) => `Podagent: ${parent}`,
} };

return { externalSessionSettingsTranslations };
})();

const Domain_filesPaneTranslations = (() => {
type FilesPaneTranslations = Shared_filesPaneTranslations.FilesPaneTranslations;

const filesPaneTranslations = { pl: {
        changedOnly: 'Tylko zmienione',
        showAllFiles: 'Pokaż wszystkie pliki',
        viewOptions: 'Opcje widoku',
        sizeAndDate: 'Rozmiar i data',
        newMenu: 'Nowy plik, nowy folder lub przesyłanie',
        newFile: 'Nowy plik',
        newFolder: 'Nowy folder',
        noChangedFilesTitle: 'Nic się nie zmieniło',
        noChangedFilesReason: 'Kopia robocza odpowiada ostatniemu commitowi.',
        rootErrorTitle: ({ machine }) => `Nie udało się wyświetlić plików na ${machine}`,
        rootErrorTitleUnnamed: 'Nie udało się wyświetlić plików',
    } } as const satisfies Pick<Record<string, FilesPaneTranslations>, "pl">;

return { filesPaneTranslations };
})();

const Domain_findTranslations = (() => {
type FindTranslations = Shared_findTranslations.FindTranslations;

const slavicPlural = Shared_findTranslations.slavicPlural;

const russianPlural = Shared_findTranslations.russianPlural;

const en = Shared_findTranslations.en;

const pl: FindTranslations = {
    open: 'Znajdź…',
    openedForMatch: 'Otwarto dla dopasowania', foldAgain: 'Zwiń ponownie', showHiddenLines: ({ count }) => `Pokaż ${count} ${slavicPlural(count, 'ukryty wiersz', 'ukryte wiersze', 'ukrytych wierszy')}`,
    surface: {
        chat: 'Znajdź w czacie',
        changes: 'Znajdź w zmianach',
        file: 'Znajdź w pliku',
        terminal: ({ name }) => `Znajdź w ${name}`,
    },
    previous: 'Poprzednie dopasowanie',
    next: 'Następne dopasowanie',
    matchCase: 'Uwzględniaj wielkość liter',
    regex: 'Użyj wyrażenia regularnego',
    regexShort: 'Wyrażenie regularne',
    options: 'Opcje wyszukiwania',
    close: 'Zamknij wyszukiwanie',
    done: 'Gotowe',
    stop: 'Zatrzymaj',
    noMatches: 'Brak dopasowań',
    noneFound: 'Nic nie znaleziono',
    invalidPattern: 'Nieprawidłowy wzorzec',
    offline: 'Brak połączenia',
    unsupported: 'Tu nie można wyszukiwać',
    count: ({ current, total }) => (current === null ? `${total} ${slavicPlural(total, 'dopasowanie', 'dopasowania', 'dopasowań')}` : `${current} z ${total}`),
    files: ({ count }) => `${count} ${slavicPlural(count, 'plik', 'pliki', 'plików')}`,
    soFar: 'na razie',
    loaded: 'wczytane',
    note: {
        searchingOlder: 'Przeszukiwanie starszych wiadomości, odszyfrowanych na tym urządzeniu',
        offlineOlder: 'Starsze wiadomości przeszukasz po powrocie do trybu online.',
        terminalKept: ({ lines }) => `Przeszukano ostatnie ${lines} wierszy przechowywanych przez ten terminal.`,
    },
};

const findTranslations = { pl };

return { findTranslations };
})();

const Domain_folderlessSessionTranslations = (() => {
type FolderlessSessionTranslations = Shared_folderlessSessionTranslations.FolderlessSessionTranslations;

const en = Shared_folderlessSessionTranslations.en;

const pl: FolderlessSessionTranslations = {
    composer: {
        addFolder: 'Dodaj folder',
        noFolder: 'Bez folderu',
        noFolderDescription: 'Happier prowadzi prywatny folder dla tego czatu',
        removeFolder: 'Usuń folder',
        a11y: {
            folder: ({ path }) => `Folder: ${path}. Otwiera wybór folderu.`,
            none: 'Bez folderu. Happier prowadzi prywatny folder dla tego czatu. Dodaj folder.',
            loading: 'Wczytywanie folderu',
            noFolderRow: 'Bez folderu, prywatny folder dla tego czatu',
            removed: 'Folder usunięty',
            set: ({ path }) => `Ustawiono folder ${path}`,
        },
    },
    display: {
        chats: 'Czaty',
        untitledChat: 'Nowy czat',
        folder: 'Folder',
        privateToSession: 'Tylko dla tej sesji',
        sessionFiles: 'Pliki sesji',
        privateFolderOn: ({ machine }) => `Prywatny folder na ${machine}`,
    },
};

const folderlessSessionTranslations = { pl: pl };

return { folderlessSessionTranslations };
})();

const Domain_glassAppearanceTranslations = (() => {
const englishTranslations = Shared_glassAppearanceTranslations.englishTranslations;

const effectiveTranslations = { "pl": {
        "effectiveBrowserSolid": "Nieprzezroczyste menu i pływające kontrolki. Przeglądarka nie pokaże pulpitu.",
        "effectiveFloatingSolid": "Nieprzezroczyste pływające kontrolki na tym urządzeniu.",
        "effectiveSolid": "Nieprzezroczyste powierzchnie na tym urządzeniu.",
        "effectiveBrowser": "Szkło w menu i pływających kontrolkach. Przeglądarka nie pokaże pulpitu.",
        "effectiveBrowserCustom": "Twój materiał w menu i pływających kontrolkach. Przeglądarka nie pokaże pulpitu.",
        "effectivePhone": "Szkło na pływających kontrolkach i arkuszach.",
        "effectiveLayered": "Warstwy szkła w całym oknie.",
        "effectiveUniform": "Jednolita warstwa szkła w całym oknie.",
        "effectiveCustom": "Szkło w tym oknie według twoich ustawień.",
        "effectiveUnavailable": "Szkło okna jest niedostępne. Pływające kontrolki używają wybranego materiału.",
        "effectiveInactive": "Nieprzezroczyste, gdy okno jest nieaktywne.",
        "effectiveTint": "Przyciemnione pływające kontrolki; rozmycie tła jest niedostępne.",
        "description": "Zobacz pulpit przez okno i stronę pod pływającymi kontrolkami.",
        "descriptionBrowser": "Zobacz stronę pod menu i pływającymi kontrolkami.",
        "descriptionPhone": "Zobacz stronę pod pływającymi kontrolkami i arkuszami.",
        "chromeDescription": "Pasek tytułu, nawigacja i tło okna",
        "sidebarDescription": "Kolumna sesji",
        "contentDescription": "Rozmowa, edytor wiadomości i panele robocze",
        "floatingDescription": "Menu, popovery, arkusze i pływające kontrolki",
        "clear": "Przezroczyste",
        "shortcutHint": ({ modifier }: { modifier: string }) => `${modifier}-klik · ${modifier}⇧L przełącza jasny i ciemny motyw`
    } } as const;

const glassAppearanceTranslations = { pl: { iosReduceTransparencyPath: "Ustawienia › Dostępność › Ekran i wielkość tekstu › Zmniejsz przezroczystość", title: 'Szkło', material: 'Materiał', solid: 'Nieprzezroczysty', auto: 'Automatycznie', everywhere: 'Wszędzie', custom: 'Własny', blur: 'Rozmycie', off: 'Wyłączone', opacity: 'Nieprzezroczystość', customize: 'Dostosuj', chrome: 'Rama okna', sidebar: 'Pasek boczny', content: 'Treść', floating: 'Powierzchnie pływające', appearance: 'Wygląd', moreSettings: 'Więcej ustawień wyglądu…', customizeLink: 'Dostosuj…', toolbarTitle: 'Przycisk wyglądu', toolbarDescription: 'Pokazuje Wygląd na pasku. Kliknięcie z modyfikatorem przełącza jasny i ciemny motyw.', reduceTransparency: 'Nieprzezroczysty, ponieważ ograniczanie przezroczystości jest włączone', osSettings: 'Otwórz ustawienia dostępności', themeCommand: 'Przełącz jasny i ciemny motyw', autoDescription: "Dostosowuje się do urządzenia: warstwy szkła w obsługiwanych oknach i pływające powierzchnie na telefonie.", osSettingsUnavailable: "Nie można otworzyć ustawień dostępności. Otwórz je w ustawieniach urządzenia.", ...effectiveTranslations["pl"] } } satisfies Pick<Record<string, Record<keyof typeof englishTranslations, string | ((params: { modifier: string }) => string)>>, "pl">;

return { effectiveTranslations, glassAppearanceTranslations };
})();

const Domain_goalControlTranslations = (() => {
const en = Shared_goalControlTranslations.en;

const pl: typeof en = {
    row: {
        notSet: 'Nie ustawiono',
    },
    keepGoing: {
        title: 'Kontynuuj do końca',
        nativeDescription: ({ agent }) => `${agent} sam kontynuuje pracę nad celem.`,
        description: ({ rounds }) => `Po każdej Twojej turze agent sprawdza cel i kontynuuje, aż cel zostanie osiągnięty, budżet się wyczerpie lub zabraknie postępów, maksymalnie przez ${rounds} ${rounds === 1 ? 'rundę' : 'rund'}.`,
        roundsPrefix: 'Zatrzymaj po',
        roundsSuffix: 'rundach',
        roundsLabel: 'Rundy przed zatrzymaniem',
        strikesPrefix: 'Zatrzymaj po',
        strikesSuffix: 'sprawdzeniach bez postępu',
        strikesLabel: 'Sprawdzenia bez postępu przed zatrzymaniem',
        secondOpinionTitle: 'Poproś o drugą opinię przed zakończeniem',
        secondOpinionDescription: 'Zanim cel zostanie oznaczony jako osiągnięty, sprawdza go drugi agent. Jeśli się nie zgadza, dostajesz powiadomienie, a cel pozostaje otwarty.',
        budgetUnreported: ({ agent }) => `${agent} nie zgłasza zużycia tokenów, więc obowiązują tylko rundy i sprawdzenia postępu.`,
    },
};

const goalControlTranslations = { pl };

return { goalControlTranslations };
})();

const Domain_homeAddTranslations = (() => {
type HomeAddTranslation = Shared_homeAddTranslations.HomeAddTranslation;

const en = Shared_homeAddTranslations.en;

const homeAddTranslations = { pl: {
        addressIsSignInService: 'Ten adres należy do usługi logowania. Zaloguj się przez nią, aby znaleźć swoje Home.',
        mixedContent: 'Ta przeglądarka nie może połączyć się z Home przez HTTP ze strony HTTPS. Otwórz Happier przez HTTP lub użyj adresu HTTPS dla Home.',
        connectedToHome: ({ home }) => `${home} jest połączony z tym urządzeniem.`,
        openHome: ({ home }) => `Otwórz ${home}`,
        showAllHomes: 'Pokaż wszystkie Home',
        otherSignInService: 'Inna usługa logowania',
        otherSignInServiceSubtitle: 'Usługa hostowana samodzielnie lub firmowa',
        signInServiceAddress: 'Adres usługi',
    } } satisfies Pick<Record<string, HomeAddTranslation>, "pl">;

return { homeAddTranslations };
})();

const Domain_homeComposerTranslations = (() => {
type HomeComposerTranslation = Shared_homeComposerTranslations.HomeComposerTranslation;

const starterPrompts = Shared_homeComposerTranslations.starterPrompts;

const homeComposerTranslations = { pl: {
        ...starterPrompts,
        suggestionsLabel: 'Sugestie',
        summarizeProjectSince: ({ project, day }) => `Podsumuj, co zmieniło się w ${project} od: ${day}`,
        summarizeProjectToday: ({ project }) => `Podsumuj, co zmieniło się dziś w ${project}`,
        sessionsSince: ({ count, day }) => `Sesje od: ${day} · ${count}`,
        sessionsToday: ({ count }) => `Sesje dzisiaj · ${count}`,
    } } satisfies Pick<Readonly<Record<string, HomeComposerTranslation>>, "pl">;

return { homeComposerTranslations };
})();

const Domain_homeDeviceApprovalTranslations = (() => {
type HomeDeviceApprovalTranslation = Shared_homeDeviceApprovalTranslations.HomeDeviceApprovalTranslation;

const homeDeviceApprovalTranslations = { pl: {
        title: 'Zatwierdzanie urządzeń', deviceFallback: 'Nowe urządzenie',
        homeLabel: ({ home }) => `Home: ${home}`, expiresLabel: ({ expiry }) => `Wygasa: ${expiry}`,
        requestDetails: 'Szczegóły żądania', requestDetailsHint: 'Pokaż identyfikator klucza żądania',
        fingerprintLabel: 'Odcisk klucza żądania', requestDetailsHelp: 'To identyfikator klucza żądania, a nie kod wymagający porównania.',
        approve: 'Zatwierdź', reject: 'Odrzuć', loadError: 'Nie udało się wczytać próśb o zatwierdzenie urządzeń.',
        loadErrorUnreachable: ({ homes }) => `${homes} nie odpowiada.`, loadErrorFailed: ({ homes }) => `${homes} odpowiedział błędem.`,
        decisionError: 'Nie udało się zaktualizować tego żądania.', decisionRecovery: 'Wybierz ponownie Zatwierdź lub Odrzuć.',
        approved: 'Urządzenie zatwierdzone', rejected: 'Urządzenie odrzucone', expired: 'Wygasło', stopWaiting: 'Przestań czekać',
    } } as const satisfies Pick<Record<string, HomeDeviceApprovalTranslation>, "pl">;

return { homeDeviceApprovalTranslations };
})();

const Domain_homeFeatureTranslations = (() => {
const en = Shared_homeFeatureTranslations.en;

const pl: typeof en = {
    teams: {
        title: 'Zespoły',
        description: 'Grupy ze wspólnymi sesjami, maszynami i dostępem.',
        credentialResources: {
            title: 'Dane uwierzytelniające zespołu',
            description: 'Dane uwierzytelniające, które zespół udostępnia swoim sesjom.',
            externalApi: {
                title: 'API danych uwierzytelniających zespołu',
                description: 'Zewnętrzne narzędzia korzystają z danych uwierzytelniających zespołu przez API.',
            },
        },
    },
    automations: {
        title: 'Automatyzacje',
        description: 'Zaplanowana i wyzwalana praca agentów.',
    },
    workflows: {
        title: 'Przepływy pracy',
        description: 'Wieloetapowe potoki agentów.',
    },
    pets: {
        sync: {
            title: 'Synchronizacja zwierzaków',
            description: 'Zwierzaki każdej osoby są dostępne na wszystkich jej urządzeniach.',
        },
    },
    voice: {
        title: 'Głos',
        description: 'Rozmawiaj ze swoimi agentami.',
        happierVoice: {
            title: 'Głos Happier',
            description: 'Głos przez usługę głosową udostępnianą przez ten Home.',
        },
    },
    connectedServices: {
        group: 'Połączone usługi',
        quotas: {
            title: 'Wskaźniki limitów',
            description: 'Pokazuje, ile limitu zostało na każdym połączonym koncie.',
        },
        subscription: {
            title: 'Stan subskrypcji',
            description: 'Pokazuje plan i stan każdego połączonego konta.',
        },
        accountGroups: {
            title: 'Grupy kont',
            description: 'Łącz połączone konta w pule.',
        },
        accountFallback: {
            title: 'Konto zapasowe',
            description: 'Przełącza na następne konto w puli, gdy jedno się wyczerpie.',
        },
        autoQuotaReset: {
            title: 'Automatyczne odnowienie limitu',
            description: 'Wykorzystuje zgromadzone odnowienia limitu, gdy wszystkie konta w puli się wyczerpią.',
        },
        autoDisablePlanInvalid: {
            title: 'Pomijanie bezużytecznych kont',
            description: 'Wyłącza konta w puli, które nie mogą używać wybranego modelu.',
        },
        poolQuotaLimitSelection: {
            title: 'Limity puli',
            description: 'Wybierz, za którym limitem dostawcy podąża każda pula.',
        },
    },
    updates: {
        ota: {
            title: 'Aktualizacje zdalne',
            description: 'Aplikacje instalują aktualizacje bez wydania w sklepie.',
        },
    },
    attachments: {
        uploads: {
            title: 'Załączniki',
            description: 'Wysyłaj pliki i obrazy agentom w sesji.',
        },
    },
    sharing: {
        group: 'Udostępnianie',
        session: {
            title: 'Udostępnianie sesji',
            description: 'Udostępnij sesję komuś w tym Home.',
        },
        public: {
            title: 'Linki publiczne',
            description: 'Udostępnij zawartość sesji przez publiczny link.',
        },
        contentKeys: {
            title: 'Szyfrowane udostępnianie',
            description: 'Wymienia klucze, aby udostępnione sesje pozostały szyfrowane end-to-end.',
        },
        pendingQueueV2: {
            title: 'Wspólna kolejka wiadomości',
            description: 'Kolejkuje wiadomości udostępnionej sesji, gdy jej agent jest zajęty.',
        },
        pendingDeliveryState: {
            title: 'Śledzenie dostarczania kolejki',
            description: 'Zapamiętuje, które wiadomości z kolejki dotarły do agenta.',
        },
    },
    sessions: {
        title: 'Sesje',
        description: 'Sesje i ich sterowanie.',
        group: 'Sesje',
        handoff: {
            title: 'Przekazanie sesji',
            description: 'Przenieś trwającą sesję na inną maszynę.',
        },
        ephemeralRunner: {
            title: 'Tymczasowe runnery',
            description: 'Uruchom sesję na jednorazowej maszynie.',
        },
        agentSwitching: {
            title: 'Zmiana agenta',
            description: 'Kontynuuj sesję z innym agentem programistycznym.',
        },
        folders: {
            title: 'Foldery sesji',
            description: 'Porządkuj sesje w folderach.',
        },
        drafts: {
            title: 'Synchronizowane szkice',
            description: 'Zachowuj niewysłane wiadomości i szkice nowych sesji na każdym urządzeniu.',
        },
        following: {
            title: 'Obserwowanie',
            description: 'Obserwuj sesję, aby dostawać jej aktualizacje i powiadomienia.',
        },
        conversations: {
            title: 'Rozmowy',
            description: 'Osoby rozmawiają i wspominają się nawzajem w udostępnionej sesji.',
        },
        board: {
            title: 'Tablica sesji',
            description: 'Układaj sesje i ich elementy na wspólnych tablicach.',
        },
        filteredListing: {
            title: 'Filtrowana lista',
            description: 'Filtruje listę sesji w tym Home przed stronicowaniem.',
        },
        usageLimitRecovery: {
            title: 'Wznawianie po limicie użycia',
            description: 'Czekaj i wznów albo ponów, gdy agent osiągnie limit użycia.',
        },
    },
    machines: {
        title: 'Maszyny',
        description: 'Połączenie z twoimi maszynami.',
        group: 'Maszyny',
        pools: {
            title: 'Pule maszyn',
            description: 'Przechodzi na następną maszynę, gdy jedna jest offline.',
        },
        transfer: {
            title: 'Transfery między maszynami',
            description: 'Przesyłanie danych między maszynami.',
            directPeer: {
                title: 'Bezpośrednie transfery',
                description: 'Przesyła dane bezpośrednio między maszynami.',
            },
            serverRouted: {
                title: 'Transfery przez ten Home',
                description: 'Przesyła dane przez ten Home, gdy maszyny nie mogą połączyć się bezpośrednio.',
            },
        },
        peerMediation: {
            title: 'Połączenia między maszynami',
            description: 'Tunele, strumienie i dostęp między maszynami.',
            observability: {
                title: 'Diagnostyka połączeń',
                description: 'Pokazuje, jak połączone są tunele, strumienie i podglądy między maszynami.',
            },
        },
        tunnel: {
            title: 'Tunele między maszynami',
            description: 'Otwieranie portów między maszynami.',
            directPeer: {
                title: 'Bezpośrednie tunele',
                description: 'Otwiera porty bezpośrednio między maszynami.',
            },
            serverRouted: {
                title: 'Tunele przez ten Home',
                description: 'Otwiera porty przez ten Home, gdy maszyny nie mogą połączyć się bezpośrednio.',
            },
        },
        liveStream: {
            title: 'Transmisje na żywo',
            description: 'Przesyłanie ekranu maszyny.',
            directPeer: {
                title: 'Bezpośrednie transmisje',
                description: 'Przesyła ekran maszyny bezpośrednio na twoje urządzenie.',
            },
            serverRouted: {
                title: 'Transmisje przez ten Home',
                description: 'Przesyła ekran maszyny przez ten Home, gdy transmisja bezpośrednia zawiedzie.',
            },
        },
        rpc: {
            title: 'Wywołania maszyn',
            description: 'Bezpośrednie łączenie z maszynami.',
            directPeer: {
                title: 'Bezpośrednie wywołania maszyn',
                description: 'Łączy się z maszyną bezpośrednio zamiast przez ten Home.',
            },
        },
    },
    localServices: {
        title: 'Usługi lokalne',
        description: 'Zobacz i otwórz usługi działające na twoich maszynach.',
        group: 'Usługi lokalne',
        inventory: {
            title: 'Spis usług',
            description: 'Wyświetla porty i usługi działające na każdej maszynie.',
        },
        managed: {
            title: 'Zarządzane usługi',
            description: 'Uruchamiaj, nazywaj i obserwuj usługi z Happier.',
        },
        launcher: {
            title: 'Uruchamiacz usług',
            description: 'Podpowiada usługi do otwarcia i podglądu.',
        },
        actions: {
            title: 'Akcje usług',
            description: 'Kopiuj, podglądaj i zapominaj usługi.',
            terminate: {
                title: 'Zatrzymywanie usług',
                description: 'Zatrzymuje proces wykrytej usługi.',
            },
        },
        preview: {
            title: 'Podgląd usług',
            description: 'Prywatny podgląd usługi lokalnej wewnątrz sesji.',
        },
        publicPreview: {
            title: 'Publiczne podglądy',
            description: 'Udostępnij podgląd usługi pod publicznym adresem.',
        },
    },
    browser: {
        title: 'Przeglądarka',
        description: 'Otwieraj strony, podglądy i hostowane widoki w Happier.',
        group: 'Przeglądarka',
        viewTargets: {
            title: 'Widoki przeglądarki',
            description: 'Otwiera podglądy, strony wtyczek i linki we właściwym widoku.',
        },
        internal: {
            title: 'Wbudowana przeglądarka',
            description: 'Przeglądaj w Happier z własnymi sesjami i profilami.',
        },
        sidecar: {
            title: 'Przeglądarka pomocnicza',
            description: 'Osobna zarządzana przeglądarka do intensywnej automatyzacji.',
        },
        diagnostics: {
            title: 'Narzędzia deweloperskie',
            description: 'Konsola, sieć i zdarzenia devtools wbudowanej przeglądarki.',
        },
        context: {
            title: 'Kontekst przeglądarki',
            description: 'Dołącz zawartość strony do wiadomości lub agenta.',
        },
        automation: {
            title: 'Automatyzacja przeglądarki',
            description: 'Agenci klikają, piszą i nawigują we wbudowanej przeglądarce.',
        },
        recording: {
            title: 'Nagrania przeglądarki',
            description: 'Nagrywa sesje przeglądarki jako dowód.',
        },
    },
    plugins: {
        title: 'Wtyczki spoza Happier',
        description: 'Instaluj wtyczki z npm i własnych źródeł.',
        group: 'Wtyczki',
        webhooks: {
            title: 'Webhooki wtyczek',
            description: 'Wtyczki odbierają webhooki z zewnętrznych usług.',
        },
        ui: {
            title: 'Ekrany wtyczek',
            description: 'Pokazuje ekrany i panele udostępniane przez wtyczki.',
            hostedWeb: {
                title: 'Webowe ekrany wtyczek',
                description: 'Pokazuje ekrany wtyczek zbudowane dla sieci.',
            },
            reactNativeBundles: {
                title: 'Natywne ekrany wtyczek',
                description: 'Uruchamia zaufane ekrany wtyczek zbudowane w React Native.',
            },
        },
    },
    devices: {
        title: 'Urządzenia',
        description: 'Symulatory i podłączone urządzenia.',
        simulatorPreview: {
            title: 'Podgląd symulatorów',
            description: 'Pokazuje symulatory i emulatory z twoich maszyn.',
        },
    },
    social: {
        friends: {
            title: 'Znajomi',
            description: 'Dodawaj znajomych i zobacz, co udostępniają.',
        },
    },
    auth: {
        group: 'Logowanie',
        recovery: {
            providerReset: {
                title: 'Reset przez dostawcę',
                description: 'Odzyskaj konto, logując się przez jego dostawcę tożsamości.',
            },
        },
        login: {
            keyChallenge: {
                title: 'Logowanie kluczem',
                description: 'Zaloguj się, potwierdzając klucz urządzenia.',
            },
        },
        mtls: {
            title: 'Certyfikaty klienta',
            description: 'Zaloguj się certyfikatem klienta (mTLS).',
        },
        ui: {
            recoveryKeyReminder: {
                title: 'Przypomnienie o kluczu odzyskiwania',
                description: 'Przypomina o zapisaniu klucza odzyskiwania.',
            },
        },
        pairing: {
            desktopQrMobileScan: {
                title: 'Logowanie przez skanowanie',
                description: 'Zaloguj się na telefonie, skanując kod na komputerze.',
            },
            boundQrV2: {
                title: 'Bezpieczniejsze kody parowania',
                description: 'Kody parowania działające tylko dla tego Home i tego kierunku.',
            },
        },
    },
    encryption: {
        group: 'Szyfrowanie',
        plaintextStorage: {
            title: 'Przechowywanie bez szyfrowania',
            description: 'Przechowuje sesje bez szyfrowania end-to-end.',
        },
        accountOptOut: {
            title: 'Rezygnacja z szyfrowania',
            description: 'Każda osoba może wyłączyć szyfrowanie end-to-end.',
        },
    },
    remoteHosts: {
        group: 'Hosty zdalne',
        management: {
            title: 'Hosty zdalne',
            description: 'Zapisuj hosty SSH, na których działają sesje.',
        },
        secretMaterial: {
            title: 'Zapisane sekrety hostów',
            description: 'Zapisuj hasła i klucze hostów SSH.',
        },
    },
    e2ee: {
        keylessAccounts: {
            title: 'Konta bez kluczy',
            description: 'Konta bez kluczy szyfrowania end-to-end.',
        },
    },
    bugReports: {
        title: 'Zgłoszenia błędów',
        description: 'Wysyłaj zgłoszenia błędów z danymi diagnostycznymi.',
    },
    terminal: {
        group: 'Terminal',
        embeddedPty: {
            title: 'Terminal',
            description: 'Otwórz terminal na maszynie w Happier.',
        },
        transport: {
            byteStream: {
                title: 'Terminal strumieniowy',
                description: 'Szybsze połączenie dla wbudowanego terminala.',
            },
        },
    },
    search: {
        title: 'Wyszukiwanie',
        description: 'Przeszukuj sesje i transkrypcje.',
    },
    providers: {
        title: 'Dostawcy modeli',
        description: 'Łącz dostawców modeli i wybieraj modele dla agentów.',
        group: 'Dostawcy modeli',
        localDiscovery: {
            title: 'Wyszukiwanie lokalnych dostawców',
            description: 'Znajduje serwery modeli działające na twoich maszynach.',
        },
        localModelManagement: {
            title: 'Zarządzanie modelami lokalnymi',
            description: 'Pobieraj modele lokalne i zarządzaj nimi.',
        },
    },
    keys: {
        HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: {
            title: 'Adres usługi zgłoszeń',
            description: 'Dokąd trafiają zgłoszenia błędów. Gdy pole jest puste, usługa zgłoszeń nie jest oferowana.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__DEFAULT_INCLUDE_DIAGNOSTICS: {
            title: 'Domyślnie dołączaj diagnostykę',
            description: 'Formularz zgłoszenia zawiera dane diagnostyczne, chyba że zgłaszający z nich zrezygnuje.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__MAX_ARTIFACT_BYTES: {
            title: 'Największy załącznik',
            description: 'Największy plik, jaki może dołączyć zgłoszenie błędu, w bajtach.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__UPLOAD_TIMEOUT_MS: {
            title: 'Limit czasu przesyłania',
            description: 'Jak długo może trwać przesyłanie zgłoszenia błędu, w milisekundach.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__ACCEPTED_ARTIFACT_KINDS: {
            title: 'Akceptowane rodzaje załączników',
            description: 'Rodzaje załączników akceptowane w zgłoszeniach błędów. Puste oznacza zwykłe rodzaje.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__CONTEXT_WINDOW_MS: {
            title: 'Okno kontekstu',
            description: 'Jak daleko wstecz zgłoszenie błędu zbiera kontekst, w milisekundach.',
        },
        HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: {
            title: 'Głos wymaga subskrypcji',
            description: 'Tylko subskrybenci mogą używać głosu. Gdy nie ustawiono, wymaga tego produkcja, a inne konfiguracje nie.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_MANIFEST_BYTES: {
            title: 'Największy manifest zwierzaka',
            description: 'Największy akceptowany manifest zwierzaka, w bajtach.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_SPRITESHEET_BYTES: {
            title: 'Największy spritesheet zwierzaka',
            description: 'Największy akceptowany spritesheet zwierzaka, w bajtach.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_PACKAGE_BYTES: {
            title: 'Największy pakiet zwierzaka',
            description: 'Największy akceptowany pakiet zwierzaka, w bajtach.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PETS_PER_ACCOUNT: {
            title: 'Zaimportowane zwierzaki na osobę',
            description: 'Maksymalna liczba zaimportowanych zwierzaków, jaką może mieć jedna osoba.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PET_BYTES_PER_ACCOUNT: {
            title: 'Miejsce na zaimportowane zwierzaki na osobę',
            description: 'Maksymalna liczba bajtów zaimportowanych zwierzaków, jaką może mieć jedna osoba.',
        },
        HAPPIER_FEATURE_PETS_SYNC__ENCRYPTED_CUSTOM_PET_SYNC_POLICY: {
            title: 'Szyfrowane własne zwierzaki',
            description: 'Zarezerwowane na później. Szyfrowane własne zwierzaki nie są jeszcze synchronizowane, więc ta opcja pozostaje wyłączona.',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES: {
            title: 'Największy transfer przez ten Home',
            description: 'Największy plik, jaki przenosi transfer przez ten Home, w bajtach.',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_ACTIVE_TRANSFERS_PER_SOCKET: {
            title: 'Równoczesne transfery na połączenie',
            description: 'Maksymalna liczba transferów przez ten Home, które jedno połączenie prowadzi jednocześnie.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES: {
            title: 'Dane na tunel',
            description: 'Maksymalna liczba bajtów, jaką przenosi jeden tunel przez ten Home.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_ACTIVE_TUNNELS_PER_SOCKET: {
            title: 'Tunele na połączenie',
            description: 'Maksymalna liczba tuneli przez ten Home, które jedno połączenie utrzymuje otwarte.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: 'Największa ramka tunelu',
            description: 'Największa ramka, jaką przenosi tunel przez ten Home, w bajtach.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__SUPPORTED_ENCODINGS: {
            title: 'Kodowania tunelu',
            description: 'Kodowania ramek akceptowane przez tunele przez ten Home. Puste oznacza standardowe.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__PREFERRED_ENCODING: {
            title: 'Preferowane kodowanie tunelu',
            description: 'Kodowanie ramek używane w pierwszej kolejności. Musi być jednym z akceptowanych kodowań.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BINARY_HEADER_BYTES: {
            title: 'Największy nagłówek ramki',
            description: 'Największy binarny nagłówek ramki, w bajtach.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_RAW_PAYLOAD_BYTES: {
            title: 'Największy ładunek ramki',
            description: 'Największy surowy ładunek w jednej ramce, w bajtach.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAMED_MESSAGE_BYTES: {
            title: 'Największa wiadomość w ramkach',
            description: 'Największa wiadomość podzielona na ramki, w bajtach.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_CONCURRENT_SUBSTREAMS: {
            title: 'Równoczesne strumienie na tunel',
            description: 'Maksymalna liczba strumieni, które jeden tunel prowadzi jednocześnie.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_TOTAL_SUBSTREAMS: {
            title: 'Strumienie na tunel',
            description: 'Maksymalna liczba strumieni, które jeden tunel otwiera przez cały czas działania.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES_PER_SUBSTREAM: {
            title: 'Dane na strumień',
            description: 'Maksymalna liczba bajtów, jaką przenosi jeden strumień.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_AGGREGATE_BYTES: {
            title: 'Dane na tunel, wszystkie strumienie',
            description: 'Maksymalna liczba bajtów, jaką przenoszą razem wszystkie strumienie jednego tunelu.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SUBSTREAM_IDLE_MS: {
            title: 'Limit bezczynności strumienia',
            description: 'Jak długo strumień może być bezczynny, zanim zostanie zamknięty, w milisekundach.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SESSION_IDLE_MS: {
            title: 'Limit bezczynności tunelu',
            description: 'Jak długo tunel przez ten Home może być bezczynny, zanim zostanie zamknięty, w milisekundach.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_IDLE_MS: {
            title: 'Limit czasu bezczynności tunelu',
            description: 'Jak długo tunel może być bezczynny, zanim zostanie zamknięty, w milisekundach.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_DURATION_MS: {
            title: 'Najdłuższy tunel',
            description: 'Najdłuższy czas, przez jaki tunel pozostaje otwarty, w milisekundach.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: {
            title: 'Porty dostępne dla tuneli',
            description: 'Porty, które mogą otwierać tunele. Puste pozwala tylko na domyślne.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__TOKEN_TTL_MS: {
            title: 'Ważność linku podglądu',
            description: 'Jak długo działa prywatny link podglądu, w milisekundach.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: {
            title: 'Domena podglądów',
            description: 'Domena, która serwuje każdy podgląd pod własnym adresem. Puste serwuje podglądy pod adresem tego Home.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: {
            title: 'Tryby publicznego podglądu',
            description: 'Sposoby upublicznienia podglądu.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: {
            title: 'Najdłuższy publiczny podgląd',
            description: 'Najdłuższy czas, przez jaki podgląd pozostaje publiczny, w milisekundach. Puste zachowuje standardowy limit.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_CONCURRENT_EXPOSURES: {
            title: 'Równoczesne publiczne podglądy',
            description: 'Maksymalna liczba publicznych podglądów jednocześnie. Puste zachowuje standardowy limit.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: {
            title: 'Wymagaj DNS i TLS',
            description: 'Publiczne podglądy wymagają DNS i TLS.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_SINK: {
            title: 'Dziennik audytu publicznych podglądów',
            description: 'Gdzie rejestrowane są publiczne podglądy. Publiczne podglądy go wymagają.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_LOG_PATH: {
            title: 'Plik dziennika audytu',
            description: 'Plik, do którego zapisywany jest dziennik audytu publicznych podglądów.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: {
            title: 'Zezwalaj na testowy dziennik audytu',
            description: 'Tylko do programowania: akceptuje testowy dziennik audytu w pamięci. Ignorowane w produkcji.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: {
            title: 'Limity żądań publicznych podglądów',
            description: 'Profile limitów żądań, których mogą używać publiczne podglądy.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER: {
            title: 'Kontroler limitu żądań',
            description: 'Jak ograniczane są żądania do publicznych podglądów. Publiczne podglądy go wymagają.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS: {
            title: 'Żądania na okno',
            description: 'Liczba żądań, na jaką publiczny podgląd pozwala w każdym oknie.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS: {
            title: 'Okno limitu żądań',
            description: 'Długość każdego okna limitu żądań, w milisekundach.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: {
            title: 'Zezwalaj na testowy limiter żądań',
            description: 'Tylko do programowania: akceptuje testowy limiter żądań w pamięci. Ignorowane w produkcji.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_REQUESTS: {
            title: 'Webhooki w toku',
            description: 'Maksymalna liczba żądań webhooków, które ten serwer obsługuje jednocześnie.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_WORKING_BYTES: {
            title: 'Pamięć webhooków',
            description: 'Maksymalna ilość pamięci, jakiej mogą używać żądania webhooków w toku, w bajtach. Puste pozwala na tyle, ile już dopuszcza limit żądań.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_RATE_PER_MINUTE: {
            title: 'Webhooki na minutę na trasę',
            description: 'Żądania webhooków na minutę na jednej trasie.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_CONCURRENCY: {
            title: 'Równoczesne webhooki na trasę',
            description: 'Żądania webhooków w toku na jednej trasie.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_RATE_PER_MINUTE: {
            title: 'Webhooki na minutę na endpoint',
            description: 'Żądania webhooków na minutę na jednym endpoincie.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_CONCURRENCY: {
            title: 'Równoczesne webhooki na endpoint',
            description: 'Żądania webhooków w toku na jednym endpoincie.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_RATE_PER_MINUTE: {
            title: 'Webhooki na minutę na osobę',
            description: 'Żądania webhooków na minutę dla jednej osoby.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_CONCURRENCY: {
            title: 'Równoczesne webhooki na osobę',
            description: 'Żądania webhooków w toku dla jednej osoby.',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES: {
            title: 'Największy pakiet ekranu wtyczki',
            description: 'Największy pakiet ekranu wtyczki, jaki hostuje ten Home, w bajtach.',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES: {
            title: 'Miejsce na ekrany wtyczek na osobę',
            description: 'Maksymalna liczba bajtów pakietów ekranów wtyczek, jaką może przechowywać jedna osoba.',
        },
        HAPPIER_COLLECTION_MAX_ROW_ENCODED_BYTES: {
            title: 'Największy wiersz danych wtyczki',
            description: 'Największy wiersz, jaki zapisuje wtyczka, w bajtach.',
        },
        HAPPIER_COLLECTION_MAX_BATCH_BYTES: {
            title: 'Największa partia danych wtyczek',
            description: 'Największa partia zmian danych wtyczek, w bajtach.',
        },
        HAPPIER_COLLECTION_MAX_BATCH_ROWS: {
            title: 'Wiersze na partię danych wtyczek',
            description: 'Maksymalna liczba wierszy w jednej partii zmian danych wtyczek.',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: {
            title: 'Wiersze danych wtyczek na osobę',
            description: 'Maksymalna liczba wierszy danych wtyczek, jaką może przechowywać jedna osoba.',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_BYTES: {
            title: 'Miejsce na dane wtyczek na osobę',
            description: 'Maksymalna liczba bajtów danych wtyczek, jaką może przechowywać jedna osoba.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_BITRATE_BPS: {
            title: 'Najwyższy bitrate transmisji',
            description: 'Najwyższy bitrate transmisji na żywo przez ten Home, w bitach na sekundę.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAMES_PER_SECOND: {
            title: 'Najwyższa liczba klatek transmisji',
            description: 'Najwyższa liczba klatek na sekundę transmisji na żywo przez ten Home.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: 'Największa klatka transmisji',
            description: 'Największa klatka transmisji na żywo przez ten Home, w bajtach.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_DURATION_MS: {
            title: 'Najdłuższa transmisja na żywo',
            description: 'Najdłuższy czas trwania transmisji na żywo przez ten Home, w milisekundach.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_TOTAL_BYTES: {
            title: 'Dane na transmisję na żywo',
            description: 'Maksymalna liczba bajtów, jaką przenosi jedna transmisja na żywo przez ten Home.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_ACCOUNT: {
            title: 'Równoczesne transmisje na osobę',
            description: 'Maksymalna liczba transmisji na żywo przez ten Home, które jedna osoba prowadzi jednocześnie.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_SOCKET: {
            title: 'Równoczesne transmisje na połączenie',
            description: 'Maksymalna liczba transmisji na żywo przez ten Home, które jedno połączenie prowadzi jednocześnie.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_MACHINE: {
            title: 'Równoczesne transmisje na maszynę',
            description: 'Maksymalna liczba transmisji na żywo przez ten Home, które jedna maszyna prowadzi jednocześnie.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: {
            title: 'ID klucza podpisującego połączenia',
            description: 'Wskazuje klucz, który podpisuje połączenia między maszynami. Bez klucza podpisującego te połączenia są wyłączone.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: {
            title: 'Prywatny klucz podpisujący połączenia',
            description: 'Klucz prywatny, który podpisuje połączenia między maszynami.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: {
            title: 'Publiczny klucz podpisujący połączenia',
            description: 'Klucz publiczny pasujący do klucza podpisującego. Gdy jest pusty, jest wyliczany z klucza prywatnego.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: {
            title: 'Wygaśnięcie klucza podpisującego',
            description: 'Kiedy wygasa klucz podpisujący, jako znacznik czasu w milisekundach.',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: {
            title: 'Wyszukiwanie znajomych po nazwie użytkownika',
            description: 'Można znajdować znajomych po nazwie użytkownika, a nie tylko po połączonym koncie.',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__IDENTITY_PROVIDER: {
            title: 'Dostawca dopasowywania znajomych',
            description: 'Dostawca logowania używany do dopasowywania znajomych.',
        },
    },
};

const homeFeatureTranslations = { pl } as const;

return { homeFeatureTranslations };
})();

const Domain_homeGovernanceTranslations = (() => {
const en = Shared_homeGovernanceTranslations.en;

const pl: typeof en = {
    title: 'Administracja Home',
    pages: {
        features: 'Co oferuje ten Home. Zmiana obowiązuje wszędzie po następnym odświeżeniu.',
        data: 'Co ten Home przechowuje i jak długo.',
        homes: 'Konta, role, zespoły i zasady logowania każdego Home, którym zarządzasz.',
        overview: 'Kto zarządza tym Home i co możesz tu zmienić.',
        people: 'Konta w tym Home, ich role i to, czy mogą się logować.',
        policies: 'Kto może się logować, kto może tworzyć konta i zespoły oraz jak chronione są dane.',
        teams: 'Wszystkie zespoły w tym Home. Zarządzanie zespołem nie daje dostępu do jego sesji.',
        identityProvider: 'Usługa tożsamości, przez którą można logować się do tego Home.',
        identityProviderEditor: 'Jak łączy się ta usługa tożsamości i kogo dopuszcza.',
        githubApp: 'GitHub App, której ten Home używa do dostępu do repozytoriów.',
        githubAppEditor: 'Zarejestruj lub zmień GitHub App dla tego Home.',
        email: 'Jak ten Home wysyła e-maile.',
        reach: 'Jak urządzenia, linki z zaproszeniami i e-maile znajdują ten Home.',
        runtime: 'Serwer, na którym działa ten Home.',
        activity: 'Kto co zmienił w tym Home i kiedy.',
    },
    overview: 'Przegląd',
    people: 'Osoby',
    teams: 'Zespoły',
    policies: 'Zasady',
    console: {
        serverSettings: 'Ustawienia serwera',
        serverSettingsDescription: 'Każde ustawienie odczytywane przez serwer i kiedy zmiana zaczyna obowiązywać.',
        allHomes: 'Wszystkie Home',
        backToHomes: 'Wróć do Home',
        viewerOwner: 'Jesteś właścicielem',
        viewerAdmin: 'Jesteś administratorem',
        noOwnerYet: 'Jeszcze bez właściciela',
        administer: 'Administruj',
        navigation: 'Strony administracji Home',
    },
    /** The console Overview (lab `hcOverview-A`): what needs the owner, who owns the Home, and its facts. */
    overviewPage: {
        description: 'Kto prowadzi ten Home i czego od ciebie potrzebuje.',
        attention: 'Wymaga twojej uwagi',
        emailNotSetUpTitle: 'E-mail nie jest skonfigurowany',
        emailNotSetUpBody: 'Nikt nie może potwierdzić adresu, zresetować hasła ani otrzymać zaproszenia e-mailem.',
        emailNoLinkTitle: 'E-maile nie mogą jeszcze zawierać linków',
        emailNoLinkBody: 'Wysyłka jest skonfigurowana, ale ten Home nie ma adresu aplikacji webowej dla linków.',
        emailPasswordTitle: 'Nie można odczytać hasła poczty',
        emailPasswordBody: 'Wpisz ponownie hasło SMTP, aby ten Home mógł wysyłać e-maile.',
        setUpEmail: 'Skonfiguruj e-mail',
        openEmail: 'Otwórz E-mail',
        noAddressTitle: 'Brak adresu publicznego',
        noAddressBody: 'Urządzenia w innych sieciach i linki z zaproszeniami nie dotrą do tego Home.',
        setUpReach: 'Skonfiguruj',
        pendingBody: 'Zapisano; czeka na ponowne uruchomienie serwera.',
        fixedBody: 'Ustawione w środowisku serwera; zmień je tam.',
        review: 'Przejrzyj',
        settingsFailed: 'Nie udało się sprawdzić ustawień tego Home',
        emailFailed: 'Nie udało się odczytać stanu poczty tego Home',
        reachFailed: 'Nie udało się odczytać, jak dociera się do tego Home',
        ownership: 'Własność',
        ownerYou: 'Właściciel · ty',
        peopleFailed: 'Nie udało się odczytać osób w tym Home',
        thisHome: 'Ten Home',
        version: 'Wersja',
        signIn: 'Logowanie',
        signInOpen: 'każdy może założyć konto',
        signInInvited: 'tylko z zaproszeniem',
        signInNone: 'Żadna metoda logowania nie jest włączona',
        fixedTitle: ({ count }: { count: number }) => (count === 1 ? '1 ustawienie jest ustalone przez wdrożenie' : `Ustawienia ustalone przez wdrożenie: ${count}`),
        /** People · owners · admins; `more` while the Home has further pages, `admins` null when unknown. */
        peopleSummary: ({ people, more, owners, admins }: { people: number; more: boolean; owners: number; admins: number | null }) => [`Osoby: ${people}${more ? '+' : ''}`, `Właściciele: ${owners}`, admins === null ? null : `Administratorzy: ${admins}`].filter((part) => part !== null).join(' · '),
    },
    /** "Invite people" on Overview, People and Teams: one dialog over the Team invitation form. */
    invite: {
        action: 'Zaproś osoby',
        description: 'Do tego Home dołącza się, dołączając do jednego z jego zespołów.',
        team: 'Zespół',
        noTeams: 'Nie ma jeszcze zespołu, do którego możesz zapraszać',
        noTeamsBody: 'Do Home dołącza się przez zespół. Najpierw utwórz zespół.',
        notAdministered: 'Nie możesz zapraszać do zespołów tego Home',
        notAdministeredBody: 'Do zespołu zapraszają jego właściciele i administratorzy. Poproś jednego z nich albo utwórz własny zespół.',
        createTeam: 'Utwórz zespół',
        notAdministeredAskBody: 'Do zespołu zapraszają jego właściciele i administratorzy; poproś jednego z nich.',
        joinByTeam: 'Do Home dołącza się przez zespół.',
        teamsFailed: 'Nie udało się odczytać zespołów tego Home',
    },

    yourRole: 'Twoja rola',
    roleOwner: 'Właściciel',
    roleAdmin: 'Administrator',
    roleMember: 'Członek',
    activeOwners: 'Aktywni właściciele',
    accountSection: 'Konto',
    accountAccessSection: 'Dostęp',
    homeAddress: 'Adres Home',

    setupRequiredTitle: 'Wymagana konfiguracja administracji Home',
    setupRequiredBody: 'Ten Home nie ma jeszcze aktywnego właściciela. Osoba z dostępem do serwera przypisuje pierwszego właściciela z maszyny, na której działa.',

    manageTeams: 'Zarządzaj zespołami',
    manageTeamsSubtitle: 'Administruj zespołami tego Home. To nie daje dostępu do ich sesji.',
    teamsDisabled: 'Zespoły nie są włączone w tym Home.',
    teamsEmpty: 'W tym Home nie ma jeszcze zespołów.',

    loading: 'Ładowanie tego Home…',
    refreshing: 'Odświeżanie…',
    updating: 'Aktualizowanie…',
    staleNotice: 'Pokazujemy ostatni znany stan tego Home. Zmiany są niedostępne, dopóki nie odpowie ponownie.',
    offlineNotice: 'Ten Home nie odpowiada. Możesz czytać, ale nie wprowadzać zmian.',
    unavailableTitle: 'Ten Home jest niedostępny',
    unavailableBody: 'Happier nie mógł odczytać stanu administracji tego Home.',
    forbiddenTitle: 'Nie możesz administrować tym Home',
    forbiddenBody: 'Twoje konto nie ma tu uprawnień administracyjnych.',
    retry: 'Spróbuj ponownie',
    loadMore: 'Wczytaj więcej',
    unsupportedBody: 'Ten Home nie udostępnia administracji. Może działać na starszej wersji.',
    notObservedTitle: 'Jeszcze nie wczytano',
    notObservedBody: 'Ten Home nie przekazał jeszcze stanu administracji na to urządzenie.',
    lastUpdated: ({ time }: { time: string }) => `Zaktualizowano ${time}`,

    chooseHome: 'Wybierz Home',
    chooseHomeFooter: 'Każdy Home ma własne konta, role i zasady.',
    homesEmpty: 'Nie ma jeszcze żadnego Home',
    homesEmptyBody: 'Dodaj Home do tego urządzenia, aby nim tu zarządzać.',
    homesNoneAdministrable: 'Brak Home do administrowania',
    homesNoneAdministrableBody: 'Żaden z wyświetlanych Home nie daje temu kontu uprawnień administracyjnych.',
    homeNotAnswering: ({ home }: { home: string }) => `${home} nie odpowiada`,
    signedOutTitle: 'Wylogowano z tego Home',
    signedOutBody: 'Zaloguj się ponownie do tego Home, aby nim zarządzać.',
    credentialUnreadableTitle: 'Nie udało się odczytać zapisanego logowania na tym urządzeniu',
    credentialUnreadableBody: 'Problem dotyczy tego urządzenia, a nie Home, i nie zostałeś wylogowany. Spróbuj ponownie.',
    credentialUnreadableInviteBody: 'Problem dotyczy tego urządzenia, a nie Home. Twój link z zaproszeniem nadal działa, więc możesz spróbować ponownie teraz lub wrócić do niego później.',

    peopleEmpty: 'Na tym Home nie ma jeszcze kont.',
    rosterUnavailableTitle: 'Lista osób nie jest jeszcze dostępna',
    rosterUnavailableBody: 'Ten Home nie udostępnia jeszcze listy kont aplikacji Happier. Role i stan pojawią się tutaj, gdy to zrobi.',
    accountUnavailableBody: 'To konto nie jest jeszcze dostępne z tego Home.',
    searchPlaceholder: 'Szukaj kont',
    searchResults: 'Wyniki wyszukiwania',
    searchResultsFooter: 'Otwórz konto, aby zobaczyć jego rolę i stan.',
    searchEmpty: 'Żadne konto nie pasuje do tego wyszukiwania.',
    searchUnsupported: 'Wyszukiwanie nie jest dostępne w tym Home',
    searchUnsupportedBody: 'Ten Home nie udostępnia wyszukiwania kont. Może działać na starszej wersji.',
    searchFailed: 'Nie udało się ukończyć wyszukiwania',
    searchFailedBody: 'Ten Home nie odpowiedział na wyszukiwanie. Zmień tekst, aby spróbować ponownie.',

    statusActive: 'Aktywne',
    statusDisabled: 'Wyłączone',
    statusRetired: 'Wycofane',
    statusDisabledDetail: 'Wylogowane wszędzie. Można je włączyć ponownie.',
    statusRetiredDetail: 'Dostęp trwale odebrany.',

    changeRole: 'Zmień rolę',
    disable: 'Wyłącz konto',
    enable: 'Włącz konto ponownie',
    deleteAccount: 'Usuń konto i dane…',
    retryDeletion: 'Ponów usuwanie',

    reasonLastActiveOwner: 'Ten Home potrzebuje co najmniej jednego aktywnego właściciela. Najpierw uczyń właścicielem inne konto.',
    reasonTargetInactive: 'Tylko aktywne konto może mieć rolę w Home.',
    reasonHomeUnreachable: 'Ten Home nie odpowiada. Zmiany będą możliwe po ponownym połączeniu.',

    roleSheetTitle: 'Rola w Home',
    roleOwnerDescription: 'Może administrować wszystkim w tym Home, łącznie z usuwaniem kont.',
    roleAdminDescription: 'Może administrować kontami i zespołami, ale nie zmieniać właścicieli.',
    roleMemberDescription: 'Brak uprawnień administracyjnych w Home.',

    disableTitle: ({ account }: { account: string }) => `Wyłączyć konto ${account}?`,
    disableBody: 'Ta osoba zostanie wylogowana na wszystkich urządzeniach, a jej maszyny się rozłączą. Osobiste tokeny dostępu są trwale unieważniane, odpowiedzialność za sesje zostaje wyczyszczona, a w każdej sesji, do której traci dostęp, jej niewysłane wersje robocze są usuwane, a obserwowanie wyłączane. Ponowne włączenie przywraca dostęp, ale nie te wersje robocze, obserwowanie ani odpowiedzialność. Członkostwo w zespołach i klucze szyfrowania zostaną zachowane.',
    disableConfirm: 'Wyłącz',
    enableTitle: ({ account }: { account: string }) => `Włączyć ponownie konto ${account}?`,
    enableBody: 'Ta osoba będzie mogła zalogować się ponownie na swoich urządzeniach. Wcześniej odebrane tokeny dostępu pozostają odebrane.',
    enableConfirm: 'Włącz ponownie',
    deleteTitle: ({ account }: { account: string }) => `Usunąć konto ${account} i wszystkie jego dane?`,
    deleteBody: ({ home }: { home: string }) => `To trwale usuwa konto i jego dane na ${home}. Nie można tego cofnąć. Własność Home lub zespołu trzeba wcześniej przekazać.`,
    deleteConfirm: 'Usuń',

    deleteIncompleteTitle: 'Usuwanie nie zostało ukończone',
    deleteIncompleteBody: 'Dostęp został odebrany i to konto jest teraz wycofane, ale czyszczenie się nie zakończyło. Ponów usuwanie, aby je dokończyć.',
    deleteIncompleteMemberBody: 'Dostęp został odebrany, ale czyszczenie się nie zakończyło. Właściciel Home lub operator serwera może je dokończyć.',

    errorForbidden: 'Nie masz już uprawnień do tej zmiany w tym Home.',
    errorOwnerTransferRequired: 'Ten Home potrzebuje co najmniej jednego aktywnego właściciela. Najpierw uczyń właścicielem inne konto.',
    errorTeamOwnerTransferRequired: 'Zespół nadal potrzebuje tego konta jako właściciela. Najpierw wskaż innego właściciela tego zespołu.',
    errorAccountNotFound: 'To konto już nie istnieje w tym Home.',
    errorAccountInactive: 'To konto nie jest aktywne, więc nie może otrzymać tych uprawnień.',
    errorErasureTransitionCleanupPending: 'Usunięcie konta czeka na zakończenie czyszczenia danych szyfrowania. Spróbuj ponownie usunąć konto.',
    errorGeneric: 'Ten Home nie mógł dokończyć zmiany. Nic nie zostało zmienione.',
    errorConflict: 'Coś innego zostało tu zmienione wcześniej. Odśwież ten Home i spróbuj ponownie.',
    changeFailedTitle: 'Zmiana nie została wykonana',
    errorOutcomeUnknownTitle: 'Ta zmiana nie została potwierdzona',
    errorOutcomeUnknown: 'Żądanie dotarło do tego Home, ale jego odpowiedź została utracona. Zmiana mogła zostać zastosowana. Odśwież ten Home i sprawdź, zanim spróbujesz ponownie.',

    teamCreation: 'Tworzenie zespołów',
    teamCreationSelfService: 'Każdy może tworzyć zespoły',
    teamCreationSelfServiceDescription: 'Aktywni członkowie tego Home mogą utworzyć zespół i zostać jego właścicielem.',
    teamCreationManagedOnly: 'Zespoły tworzą administratorzy',
    teamCreationManagedOnlyDescription: 'Właściciele i administratorzy tworzą zespoły i wybierają pierwszego właściciela.',
    teamCreationDisabled: 'Tworzenie zespołów wyłączone',
    teamCreationDisabledDescription: 'Bez nowych zespołów. Istniejące zespoły pozostają bez zmian.',
    teamsVisibility: 'Kto widzi zespoły',
    teamsVisibleToMembers: 'Pokazuj zespoły członkom',
    teamsVisibleToMembersDescription: 'Gdy wyłączone, zespoły widzą tylko członkowie zespołu i administratorzy.',
    teamJit: 'Automatyczne członkostwo w zespole przy logowaniu',
    teamJitDescription: 'Logowanie przez połączonego dostawcę tożsamości zespołu automatycznie dołącza do tego zespołu, bez zaproszenia ani zatwierdzenia.',
    githubEnterpriseOrigins: 'Zatwierdzone hosty GitHub Enterprise',
    githubEnterpriseOriginsDescription: 'Jeden kanoniczny origin HTTPS w każdym wierszu. Zespoły mogą łączyć GitHub Apps tylko z tymi hostami.',
    githubEnterpriseOriginsInvalid: 'Użyj unikalnych originów HTTPS bez ścieżek, zapytań, danych logowania ani fragmentów.',

    signInTitle: 'Logowanie i przyjmowanie',
    authActionLogin: 'Logowanie',
    authActionProvision: 'Nowe konta',
    authActionConnect: 'Łączenie kont',
    authReasonMethodNotEnabled: 'Metoda logowania jest wyłączona',
    authReasonProvisioningNotEnabled: 'Tworzenie kont jest wyłączone',
    authReasonAccountModeUnavailable: 'Typ konta jest niedostępny',
    authReasonEmailDeliveryUnavailable: 'Wysyłanie wiadomości e-mail jest niedostępne',
    authInherited: 'Używane są ustawienia serwera',
    authInheritedDescription: 'Ten Home nie ogranicza metod logowania ani typów kont.',
    authNarrowed: 'Ograniczone przez ten Home',
    authUnreadable: 'Konfiguracja wymaga uwagi',
    authUnreadableDescription: 'Ten Home przechowuje konfigurację logowania, której ta wersja serwera nie potrafi odczytać. Logowanie jest niedostępne, dopóki operator jej nie naprawi.',
    signInMethods: 'Metody logowania',
    accountModes: 'Typy kont',
    accountModePlain: 'Zwykłe',
    accountModeE2ee: 'Szyfrowane end-to-end',
    recommendedMode: 'Zalecane dla nowych kont',
    recommendedModeDescription: 'Ustawia wartość domyślną dla nowych kont. Istniejące konta nie są zmieniane.',
    admissionSelfService: 'Każdy',
    admissionInvitationOnly: 'Tylko z zaproszeniem',
    admissionClosed: 'Nikt',

    deploymentServices: 'Usługi wdrożenia',
    deploymentServicesDescription: 'Usługi tożsamości konfigurowane przez operatora tego serwera. Nie da się ich zmienić w administracji Home.',
    deploymentWorkosConfigured: 'Skonfigurowane',
    deploymentWorkosPartial: 'Niepełna konfiguracja',
    deploymentWorkosNotConfigured: 'Nieskonfigurowane',
    privateEndpoints: 'Prywatne punkty tożsamości',
    privateEndpointsDescription: 'Pozwól zarządzanemu logowaniu sięgać do dostawców tożsamości w sieciach prywatnych. Dostępne są tylko hosty, sieci i porty z tej listy.',
    privateEndpointsPublicOnly: 'Tylko punkty publiczne',
    privateEndpointsAllowlist: 'Prywatna lista dozwolonych',
    privateEndpointsHostnames: 'Dozwolone nazwy hostów',
    privateEndpointsCidrs: 'Dozwolone sieci (CIDR)',
    privateEndpointsPorts: 'Dozwolone porty',
    privateEndpointsSave: 'Zapisz zasady sieci',
    privateEndpointsInvalid: 'Podaj co najmniej jedną nazwę hosta lub sieć oraz port od 1 do 65535.',
    privateEndpointsUnreadable: 'Ten Home przechowuje zasady sieci, których ta wersja serwera nie potrafi odczytać. Zarządzane logowanie pozostaje na publicznych punktach.',

    policyReadOnly: 'Tylko właściciel Home może to zmienić.',
    policyEditingUnavailable: 'Zmiana zasad nie jest jeszcze możliwa z tego urządzenia.',
    revisionConflictTitle: 'Te zasady zmieniono w innym miejscu',
    revisionConflictBody: 'Ktoś inny zapisał zmianę, gdy edytowałeś. Twój wybór został zachowany — odśwież ten Home i zastosuj go ponownie.',
    reload: 'Odśwież',
    person: {
        you: 'ty',
        roleDescription: 'Członkowie korzystają z Home; administratorzy zarządzają też osobami i Teamami.',
        roleChangeTitle: ({ account, role }: { account: string; role: string }) => `Zmienić rolę ${account} na ${role}?`,
        roleChangeBody: 'Dostęp do tego Home zmienia się od razu. Zostanie to zapisane w Aktywności z Twoim imieniem.',
        roleChangeConfirm: 'Zmień rolę',
        signIn: 'Logowanie',
        signInDescription: 'Czym ta osoba może się logować. Zarządza tym na własnym koncie.',
        methods: 'Metody',
        linkedProviders: 'Połączeni dostawcy',
        none: 'Brak',
        teams: 'Teamy',
        noTeams: 'Nie należy do żadnego Teamu',
        teamArchived: 'zarchiwizowany Team',
        teamSuspended: 'zawieszone',
        access: 'Dostęp',
        accessDescription: 'Zalogowano na jej urządzeniach — sesje nie są śledzone pojedynczo.',
        machines: 'Maszyny',
        apiTokens: 'Tokeny API',
        apiTokensLastUsed: ({ time }: { time: string }) => `Ostatnio użyto ${time}`,
        apiTokensNeverUsed: 'Nigdy nie użyto',
        signOutEverywhere: 'Wyloguj wszędzie',
        signOutEverywhereDescription: 'Kończy każdą zalogowaną sesję na wszystkich jej urządzeniach. Tokeny API działają, dopóki konto nie zostanie wyłączone.',
        signOutEverywhereTitle: ({ account }: { account: string }) => `Wylogować ${account} wszędzie?`,
        signOutEverywhereBody: 'Każde urządzenie, na którym ta osoba jest zalogowana, będzie wymagać ponownego logowania. Jej tokeny API działają, dopóki nie wyłączysz konta. Zostanie to zapisane w Aktywności z Twoim imieniem.',
        signOutEverywhereDone: 'Wylogowano wszędzie',
        recentActivity: 'Ostatnia aktywność',
        noRecentActivity: 'Brak jeszcze zmian administracyjnych dotyczących tej osoby.',
        showAllActivity: 'Pokaż wszystko',
        disableOrDelete: 'Wyłącz lub usuń',
        dangerFootnote: 'Wyłączenie wylogowuje tę osobę i zatrzymuje jej tokeny API; można to cofnąć. Usunięcie trwale usuwa jej konto i dane z tego Home.',
    },
    email: {
        title: 'E-mail',
        status: 'Stan',
        sendingMail: 'Wysyłanie poczty',
        sendingReady: ({ host }: { host: string }) => `Gotowe · wysyła przez ${host}`,
        sendingNotSetUp: 'Nieskonfigurowane',
        links: 'Linki w e-mailach',
        linksReady: 'Otwierają się w aplikacji webowej tego Home',
        linksOpenAt: ({ host }: { host: string }) => `Otwierają się pod adresem ${host}`,
        setInReach: 'Ustaw w Dostępie',
        linksMissing: 'Brak adresu aplikacji webowej, więc nie można tworzyć linków',
        mailServer: 'Serwer poczty',
        mailServerDescription: 'Serwer SMTP, który wysyła e-maile weryfikacyjne, do resetowania hasła i z zaproszeniami.',
        server: 'Serwer',
        port: 'Port',
        portAndSecurity: 'Port i zabezpieczenia',
        security: 'Zabezpieczenie połączenia',
        tls: 'TLS',
        starttls: 'STARTTLS',
        username: 'Nazwa użytkownika',
        password: 'Hasło',
        passwordDescription: 'Przechowywane w postaci zaszyfrowanej na serwerze. Nigdy więcej nie jest pokazywane.',
        saved: 'Zapisane',
        replace: 'Zastąp',
        clear: 'Usuń',
        keep: 'Zachowaj',
        clearPending: 'Zapisane hasło zostanie usunięte po zapisaniu.',
        valueSet: 'Ustawione',
        valueNotSet: 'Nieustawione',
        sender: 'Nadawca',
        fromAddress: 'Adres nadawcy',
        fromName: 'Nazwa nadawcy',
        test: 'Wyślij testowy e-mail',
        testDescription: 'Wysyła krótką wiadomość bez linków.',
        testTo: 'Do',
        testToPlaceholder: 'Dowolny adres, który możesz sprawdzić',
        testSend: 'Wyślij',
        testSaveFirst: 'Zapisz zmiany przed wysłaniem testu.',
        testSent: ({ to }: { to: string }) => `Wysłano do ${to}`,
        testSentDetail: 'Sprawdź skrzynkę odbiorczą, a jeśli jej tam nie ma — folder spam.',
        testFailed: 'Nie udało się wysłać',
        testNotConfigured: 'Poczta nie jest jeszcze skonfigurowana.',
        testPasswordUnreadable: 'Nie można odczytać zapisanego hasła. Wpisz je ponownie.',
        testRenderFailed: 'Nie udało się przygotować wiadomości testowej.',
        testTransportFailed: 'Serwer poczty jest nieosiągalny lub odrzucił wiadomość.',
        adminTitle: 'Tylko właściciele mogą zmieniać ustawienia poczty',
        adminBody: 'Widzisz je, ponieważ jesteś adminem tego Home.',
        notSetUpTitle: 'Poczta nie jest skonfigurowana',
        notSetUpBody: 'Resetowanie haseł, weryfikacja e-mail i zaproszenia e-mailem są wyłączone, dopóki nie zostanie skonfigurowana.',
        unreadableTitle: 'Nie można odczytać zapisanego hasła',
        unreadableBody: 'Główny sekret serwera zmienił się od czasu zapisania. Wpisz hasło ponownie.',
        invalidValue: 'Wpisz poprawną wartość.',
        invalidPort: 'Użyj portu od 1 do 65535.',
        invalidEmail: 'Wpisz adres e-mail.',
        conflictTitle: 'Ustawienia poczty zmieniono gdzie indziej',
        conflictBody: 'Ktoś zapisał zmianę podczas twojej edycji. Twoje zmiany zostały zachowane: przejrzyj je i zapisz ponownie.',
        loadFailed: 'Ten Home nie zwrócił ustawień poczty.',
    },
    signInProviders: {
        title: 'Dostawcy logowania',
        description: 'Logowanie firmowe, aplikacje GitHub i zasady dla Teams. Dostawcę do logowania włączysz w Zasadach.',
        ownersOnlyTitle: 'Tylko właściciele mogą zmieniać dostawców logowania',
        ownersOnlyBody: 'Poproś właściciela tego Home o dodanie lub zmianę dostawców tożsamości i aplikacji GitHub.',
        fromDeployment: ({ key }: { key: string }) => `Z Twojego wdrożenia · ${key} · tylko do odczytu`,
        workosSetByDeployment: ({ keys }: { keys: string }) => `Ustawione przez Twoje wdrożenie (${keys})`,
        workosSetInServerSettings: ({ keys }: { keys: string }) => `Ustawione w Ustawieniach serwera (${keys})`,
        privateEndpointsFixed: ({ key }: { key: string }) => `Ustalone przez Twoje wdrożenie · ${key}`,
        privateEndpointsOff: ({ key }: { key: string }) => `Wyłączone dla tego Home · ${key}`,
        teamRules: 'Zasady logowania dla Teams',
        teamRulesDescription: 'Co Teams mogą dodać do dostawców Home.',
        activity: {
            addedProvider: ({ name }: { name: string }) => `dodał(a) dostawcę tożsamości ${name}`,
            changedProvider: ({ name }: { name: string }) => `zmienił(a) dostawcę tożsamości ${name}`,
            replacedProviderSecret: ({ name }: { name: string }) => `zastąpił(a) sekret klienta ${name}`,
            enabledProvider: ({ name }: { name: string }) => `włączył(a) ${name}`,
            disabledProvider: ({ name }: { name: string }) => `wyłączył(a) ${name}`,
            removedProvider: ({ name }: { name: string }) => `usunął(ęła) dostawcę tożsamości ${name}`,
            addedGitHubApp: ({ name }: { name: string }) => `dodał(a) aplikację GitHub ${name}`,
            changedGitHubApp: ({ name }: { name: string }) => `zmienił(a) aplikację GitHub ${name}`,
            replacedGitHubAppSecrets: ({ name }: { name: string }) => `zastąpił(a) sekrety aplikacji GitHub ${name}`,
            verifiedGitHubApp: ({ name, organization }: { name: string; organization: string }) => `zweryfikował(a) ${name} w ${organization}`,
            removedGitHubAppInstallation: ({ name, organization }: { name: string; organization: string }) => `usunął(ęła) ${name} z ${organization}`,
        },
    },
    reach: {
        title: 'Dostęp',
        diagramTitle: ({ home }: { home: string }) => `Jak nowe urządzenie dociera do ${home}`,
        yourDevices: 'Twoje urządzenia',
        noAddress: 'Brak adresu publicznego',
        plusDirect: '+ bezpośrednio (Iroh), gdy to możliwe',
        noDirect: 'Bez połączeń bezpośrednich',
        thisComputer: 'Ten komputer',
        homeServer: 'Serwer tego Home',
        diagramDeployment: 'Ustalone przez wdrożenie',
        diagramHere: 'Ustawiony tutaj',
        diagramInferred: ({ method }: { method: string }) => `${method} · wywnioskowany`,
        addresses: 'Adresy',
        addressesDescription: 'Zmiana adresu nikogo nie wylogowuje.',
        publicAddress: 'Adres publiczny',
        webAppAddress: 'Adres aplikacji webowej',
        accessMethod: 'Metoda dostępu',
        publicAddressHome: 'Ustawiony tutaj',
        publicAddressNone: 'Nie ustawiono. Urządzenia z innych sieci nie dotrą do tego Home.',
        inferredFrom: ({ method }: { method: string }) => `Wywnioskowany z ${method} na komputerze hostującym ten Home`,
        inferredFromHost: 'Wywnioskowany na komputerze hostującym ten Home',
        webAppDescription: 'Linki z e-maili i zaproszeń otwierają się tutaj.',
        webAppServed: 'Linki otwierają się w aplikacji webowej udostępnianej przez ten Home.',
        webAppDefault: 'Linki otwierają się w aplikacji webowej Happier. Domyślnie',
        change: 'Zmień',
        setAddress: 'Ustaw adres',
        httpsRequired: 'Użyj adresu https://.',
        invalidAddress: 'Wpisz pełny adres, np. https://home.example.com.',
        conflict: 'Ustawienia tego Home się zmieniły. Spróbuj ponownie.',
        methodLocalOnly: 'Tylko ten komputer',
        methodLan: 'Sieć lokalna',
        methodTailscaleServe: 'Tailscale Serve',
        methodTailscaleFunnel: 'Tailscale Funnel',
        methodCloudflare: 'Cloudflare Tunnel',
        accessMethodHere: 'Jak ten komputer udostępnia Home.',
        accessMethodRemoteHost: ({ host }: { host: string }) => `Ustawiane na ${host}. Otwórz go w Hostach zdalnych.`,
        accessMethodElsewhereNamed: ({ host }: { host: string }) => `Ustawiane na komputerze hostującym ten Home (${host}). Otwórz tam Happier lub dodaj go jako host zdalny.`,
        accessMethodElsewhere: 'Ustawiane na komputerze hostującym ten Home. Otwórz tam Happier lub dodaj go jako host zdalny.',
        accessMethodDeployment: 'Zarządzane przez wdrożenie.',
        directConnections: 'Połączenia bezpośrednie',
        directConnectionsDescription: 'Urządzenia łączą się z tym Home bezpośrednio, gdy mogą, a w przeciwnym razie przez adres publiczny.',
        directConnectionsRow: 'Połączenia bezpośrednie (Iroh)',
        irohActive: 'Aktywne · urządzenia łączą się peer-to-peer, gdy mogą',
        irohStarting: 'Uruchamianie…',
        irohOff: 'Wyłączone · urządzenia łączą się przez adres publiczny',
        irohFailed: 'Nie działa na tym komputerze. Urządzenia łączą się przez adres publiczny.',
        irohNotAvailable: 'Niedostępne w tym wdrożeniu. Urządzenia łączą się przez adres publiczny.',
        irohNeedsAddressHint: 'Ustaw adres publiczny, zanim je wyłączysz',
        irohOffTitle: 'Wyłączyć połączenia bezpośrednie?',
        irohOffBody: 'Urządzenia będą łączyć się tylko przez adres publiczny. Obecna tożsamość połączeń bezpośrednich tego Home zostanie trwale wycofana; ponowne włączenie tworzy nową, którą urządzenia przejmą przy następnym połączeniu. Adres publiczny i logowania pozostają bez zmian.',
        irohOffConfirm: 'Wyłącz',
        irohNeedsAddressTitle: 'Najpierw ustaw adres publiczny',
        irohNeedsAddressBody: 'Bez adresu publicznego urządzenia nie mogłyby dotrzeć do tego Home po wyłączeniu połączeń bezpośrednich.',
        relay: 'Przekaźnik połączeń bezpośrednich',
        relayAutomatic: 'Automatycznie',
        relayOff: 'Wyłączony',
        relayCustom: ({ count }: { count: number }) => `Twoje przekaźniki (${count}) · Działa po ponownym uruchomieniu`,
        appliesAfterRestart: 'Działa po ponownym uruchomieniu',
        appliesAfterRestartPending: 'Działa po ponownym uruchomieniu · Oczekuje',
        exposureInternetTitle: ({ method }: { method: string }) => `Dostępny z internetu przez ${method}`,
        exposureAddressTitle: 'Twój adres publiczny jest otwarty na rejestracje',
        exposureOpenSignup: 'Każdy, kto dotrze do tego Home, może utworzyć konto. Sprawdź w Zasadach, kto może się rejestrować.',
        exposureInvitationOnly: 'Nowe konta wymagają zaproszenia, więc obcy nie mogą się zarejestrować.',
        loadFailed: 'Nie udało się wczytać, jak dotrzeć do tego Home.',
    },
    runtime: {
        title: 'Środowisko uruchomieniowe',
        version: 'Wersja',
        versionValue: ({ version }: { version: string }) => `Happier ${version}`,
        versionUnknown: 'Ten Home nie podaje swojej wersji',
        flavorLight: 'Lekki serwer',
        flavorFull: 'Pełny serwer',
        server: 'Serwer',
        restart: 'Uruchom ponownie',
        restartNow: 'Uruchom ponownie teraz',
        restartFailed: 'Nie udało się ponownie uruchomić serwera',
        restartToApply: 'Uruchom ponownie serwer, aby je zastosować.',
        restartFromDeployment: 'Uruchom ponownie z poziomu wdrożenia, aby je zastosować.',
        restartFromHost: ({ host }: { host: string }) => `Uruchom ponownie z ${host}, komputera hostującego ten Home.`,
        restartFromHostingComputer: 'Uruchom ponownie z komputera hostującego ten Home.',
        managedFrom: ({ host }: { host: string }) => `Zarządzane z ${host}`,
        managedFromBody: 'Otwórz Happier na komputerze hostującym ten Home, aby go zaktualizować, uruchomić ponownie lub zatrzymać.',
        managedElsewhere: 'Zarządzane z komputera hostującego ten Home',
        deploymentTitle: 'Zarządzane przez wdrożenie',
        deploymentBody: 'Aktualizacje, ponowne uruchomienia i kopie zapasowe tego serwera wykonuje osoba, która go wdraża.',
        backups: 'Kopie zapasowe',
        backupsHere: 'Twórz kopie, przywracaj lub przenoś ten Home na jego stronie środowiska uruchomieniowego.',
        backupsFromHost: ({ host }: { host: string }) => `Utwórz kopię z ${host}, komputera hostującego ten Home.`,
        backupsFromHostingComputer: 'Utwórz kopię z komputera hostującego ten Home.',
        backupsDeployment: 'Kopiami zapasowymi zarządza wdrożenie.',
        hostedHere: ({ home }: { home: string }) => `Ten komputer hostuje ${home}`,
        hostedHereSubtitle: 'Aktualizuj, uruchamiaj ponownie, twórz kopie i przenoś go w konsoli Home.',
        pendingRestart: ({ count }: { count: number }) => (count === 1 ? '1 zmiana zadziała po ponownym uruchomieniu' : `Zmiany (${count}) zadziałają po ponownym uruchomieniu`),
    },
    activity: {
        title: 'Aktywność',
        emptyTitle: 'Brak aktywności',
        emptyBody: 'Zmiany logowania, poczty, osób, zasad i własności pojawiają się tutaj na bieżąco.',
        showOlder: 'Pokaż starsze',
        footnote: 'Działania wykonane za pomocą Happier bezpośrednio na komputerze hosta, takie jak kopie zapasowe i restarty, nie są wymienione.',
        loadFailed: 'Ten Home nie zwrócił swojej aktywności.',
        deploymentCommand: 'Polecenie wdrożenia',
        personalHomeSetup: 'Konfiguracja Personal Home',
        someone: 'Ktoś',
        removedAccount: 'usunięte konto',
        claimed: 'przejął własność tego Home',
        madeOwner: ({ target }: { target: string }) => `uczynił ${target} właścicielem`,
        assignedOwner: 'przypisał pierwszego właściciela',
        changedPolicies: 'zmienił zasady',
        changedEmailSetting: 'zaktualizował ustawienia poczty',
        changedServerSetting: 'zmienił ustawienia serwera',
        changedRole: ({ target }: { target: string }) => `zmienił rolę: ${target}`,
        disabled: ({ target }: { target: string }) => `wyłączył: ${target}`,
        reenabled: ({ target }: { target: string }) => `ponownie włączył: ${target}`,
        changedStatus: ({ target }: { target: string }) => `zmienił status: ${target}`,
        deleted: ({ target }: { target: string }) => `usunął: ${target}`,
        deletionStarted: ({ target }: { target: string }) => `rozpoczął usuwanie: ${target}`,
        signedOutEverywhere: ({ target }: { target: string }) => `wylogował(a) ${target} wszędzie`,
        areaOwnership: 'Własność',
        areaPolicies: 'Zasady',
        areaEmail: 'E-mail',
        areaServerSettings: 'Ustawienia serwera',
        areaPeople: 'Osoby',
        fieldRole: 'Rola',
        fieldStatus: 'Status',
        fieldTeamProviders: 'Dostawcy logowania Teams',
        valueEmpty: '—',
        valueChanged: 'zmienione',
        valueOn: 'Wł.',
        valueOff: 'Wył.',
        secretSet: 'ustawione',
        secretUnset: 'nieustawione',
    },
    signInPolicy: {
        methodsDescription: ({ home }: { home: string }) => `Jak ludzie logują się do ${home}. Co najmniej jedna metoda pozostaje włączona i nikt nie traci ostatniego dostępu.`,
        methodUnavailable: 'Niedostępne — twoje wdrożenie nie może tego oferować',
        signInService: 'Usługa logowania Home',
        signInServiceDescription: 'Logowanie przez własną usługę logowania tego Home.',
        admissionTitle: 'Kto może utworzyć konto',
        newAccounts: 'Nowe konta',
        admissionAnyoneDescription: 'Każdy, kto może dotrzeć do tego Home',
        admissionInvitationDescription: 'Tylko osoby z zaproszeniem do zespołu',
        admissionNobodyDescription: 'Nikt nie może utworzyć konta',
        anonymousSignup: 'Anonimowa rejestracja',
        anonymousSignupDescription: 'Utwórz konto tylko z kluczem odzyskiwania, bez e-maila.',
        encryptionTitle: 'Szyfrowanie',
        encryptionDescription: 'Dotyczy kont i sesji tworzonych od teraz. Istniejące nigdy się nie zmieniają.',
        storagePolicy: 'Zasady przechowywania',
        storageRequired: 'Wymagane E2EE',
        storageOptional: 'Opcjonalne',
        storagePlaintext: 'Tylko tekst jawny',
        storageRequiredDescription: 'Każde konto zachowuje szyfrowanie end-to-end',
        storageOptionalDescription: 'Każde konto decyduje, czy szyfrować',
        storagePlaintextDescription: 'Konta przechowują dane bez szyfrowania end-to-end',
        storageAppliesAfterRestart: ({ running }: { running: string }) => `Obowiązuje po restarcie · do tego czasu ${running}`,
        allowE2ee: 'Konta z szyfrowaniem end-to-end',
        allowPlain: 'Konta bez szyfrowania end-to-end',
        recommendedInherited: 'Domyślne serwera',
        recommendedE2ee: 'E2EE',
        errorWideningUnconfirmed: 'Ta zmiana wpuszcza więcej osób i wymaga twojego potwierdzenia. Nic nie zostało zmienione.',
        widening: {
            titleAnyone: 'Pozwolić każdemu utworzyć konto?',
            titleInvited: 'Pozwolić zaproszonym tworzyć konta?',
            titleMethod: ({ method }: { method: string }) => `Włączyć ${method}?`,
            titleAnonymous: 'Zezwolić na anonimową rejestrację?',
            titleUnencrypted: 'Zezwolić na przechowywanie bez szyfrowania?',
            titleOther: 'Wpuścić więcej osób?',
            exposureAnyone: ({ host }: { host: string }) => `Każdy, kto dotrze do tego Home pod adresem ${host}, będzie mógł zarejestrować się bez zaproszenia.`,
            exposureInvited: ({ host }: { host: string }) => `Każdy z zaproszeniem, kto dotrze do tego Home pod adresem ${host}, będzie mógł utworzyć konto.`,
            exposureMethod: ({ host, method }: { host: string; method: string }) => `Każdy, kto dotrze do tego Home pod adresem ${host}, będzie mógł zalogować się przez ${method}.`,
            exposureAnonymous: ({ host }: { host: string }) => `Każdy, kto dotrze do tego Home pod adresem ${host}, będzie mógł utworzyć konto tylko z kluczem odzyskiwania.`,
            exposureUnencrypted: ({ host }: { host: string }) => `Każdy, kto dotrze do tego Home pod adresem ${host}, będzie mógł trzymać tu dane bez szyfrowania end-to-end.`,
            exposureOther: ({ host }: { host: string }) => `Każdy, kto dotrze do tego Home pod adresem ${host}, będzie mógł się zalogować lub dołączyć na szerszych zasadach.`,
            unchanged: 'Istniejące konta i zaproszenia się nie zmieniają.',
            recorded: 'Zmiana zostanie zapisana w Aktywności z twoim nazwiskiem.',
            confirmAnyone: 'Pozwól każdemu się rejestrować',
            confirmInvited: 'Zezwól na zaproszenia',
            confirmMethod: ({ method }: { method: string }) => `Włącz ${method}`,
            confirmAnonymous: 'Zezwól na anonimową rejestrację',
            confirmUnencrypted: 'Zezwól na przechowywanie bez szyfrowania',
            confirmOther: 'Zastosuj zmianę',
        },
    },
    claim: {
        pageDescription: 'Przejmij własność tego Home.',
        emptyTitle: 'Ten Home nie ma jeszcze właściciela',
        emptyBody: 'Właściciel zarządza logowaniem, pocztą, dostępnością i ludźmi. Dopóki ktoś go nie przejmie, nikt nie może administrować tym Home.',
        codeTitle: 'Przejmij jednorazowym kodem',
        codeDescription: 'Ktoś z dostępem do serwera wyświetla kod. Działa raz i wygasa po 15 minutach.',
        printStep: '1 · Wyświetl kod na serwerze',
        pasteStep: '2 · Wklej go tutaj',
        codeLabel: 'Kod przejęcia',
        codePlaceholder: 'XXXX-XXXX-XXXX-XXXX-…',
        claim: 'Przejmij',
        refused: 'Ten kod nie zadziałał. Może być błędnie wpisany, użyty lub wygasły — wyświetl nowy.',
        hostTitle: ({ home }: { home: string }) => `Ten komputer hostuje ${home}`,
        hostBody: 'Możesz stąd uczynić swoje konto właścicielem. Tylko ten komputer może to zrobić w ten sposób.',
        makeOwner: 'Uczyń mnie właścicielem',
        hostFailed: 'Ten komputer nie mógł uczynić cię właścicielem. Spróbuj ponownie.',
    },
    fixedByDeployment: ({ key }: { key: string }) => `Ustalone przez twoje wdrożenie · ${key}`,
    fixedByDeploymentLead: 'Ustalone przez twoje wdrożenie',
    deploymentNotSetLead: 'Niedostępne, dopóki twoje wdrożenie nie ustawi',
    features: {
        title: 'Funkcje',
        common: 'Popularne',
        advanced: 'Zaawansowane',
        advancedDescription: ({ count }: { count: number }) => `Więcej: ${count}, pogrupowane według obszaru.`,
        other: 'Inne',
        familyCount_one: '1 funkcja',
        familyCount_other: ({ count }: { count: number }) => `Funkcje: ${count}`,
        offHome: 'Wyłączona dla tego Home.',
        notInBuild: 'Nieobecna w tej kompilacji.',
        needs: ({ feature }: { feature: string }) => `Wymaga: ${feature}.`,
        unavailable: 'Niedostępna w tym Home.',
        noHomeSwitchOn: 'Zawsze włączona w tym Home · wyłączyć ją może tylko kompilacja Happier',
        noHomeSwitchOff: 'Wyłączona w tym Home · włączyć ją może tylko kompilacja Happier',
        unavailableByDeployment: 'Niedostępna w tym Home · decyduje konfiguracja Twojego wdrożenia',
        dependentsTitle_one: ({ feature }: { feature: string }) => `Wyłączenie ${feature} wyłącza też 1 funkcję`,
        dependentsTitle_other: ({ feature, count }: { feature: string; count: number }) => `Wyłączenie ${feature} wyłącza też inne funkcje: ${count}`,
        dependentNeeds: ({ feature, parent }: { feature: string; parent: string }) => `${feature} wymaga: ${parent}.`,
        turnOff: 'Wyłącz',
        deviceTitle: 'Funkcje tego urządzenia',
        deviceBody: 'Funkcje dotyczące tylko tego urządzenia są w Ustawieniach.',
        adminTitle: 'Tylko właściciele mogą zmieniać funkcje',
        adminBody: 'Widzisz, co oferuje ten Home, bo jesteś adminem.',
        loadFailed: 'Ten Home nie zwrócił swoich funkcji.',
        conflictTitle: 'Funkcje zmieniono gdzie indziej',
        conflictBody: 'Ktoś zmienił ustawienia tego Home, gdy je przeglądałeś. Strona pokazuje teraz to, co zapisał Home.',
        rangeBetween: ({ min, max }: { min: number; max: number }) => `${min}–${max}`,
        rangeAtLeast: ({ min }: { min: number }) => `${min} lub więcej`,
        rangeAtMost: ({ max }: { max: number }) => `Do ${max}`,
        limitInvalid: 'Wpisz liczbę z zakresu.',
        appliesAfterRestart: 'Działa po ponownym uruchomieniu',
        onAfterRestart: 'Włączona po ponownym uruchomieniu',
        offAfterRestart: 'Wyłączona po ponownym uruchomieniu',
        ignoredAtLastStart: ({ reason }: { reason: string }) => `Zignorowane przy ostatnim uruchomieniu: ${reason}`,
        ignoredInvalidType: 'zapisana wartość ma zły typ',
        ignoredOutOfBounds: 'zapisana wartość jest poza zakresem',
        ignoredSecretUnreadable: 'nie można odczytać zapisanego sekretu',
        dependentsAfterRestartTitle_one: ({ feature }: { feature: string }) => `Po następnym uruchomieniu wyłączenie ${feature} wyłączy też 1 funkcję`,
        dependentsAfterRestartTitle_other: ({ feature, count }: { feature: string; count: number }) => `Po następnym uruchomieniu wyłączenie ${feature} wyłączy też inne funkcje: ${count}`,
    },
    data: {
        title: 'Dane',
        deletion: 'Automatyczne usuwanie',
        deletionDescription: 'Zmiany obowiązują od następnego czyszczenia.',
        dryRunMode: 'Tryb próbny',
        dryRunModeDescription: 'Czyszczenie tylko liczy zamiast usuwać, dopóki tego nie wyłączysz.',
        tryRules: 'Wypróbuj obecne reguły',
        tryRulesDescription: 'Uruchamia teraz czyszczenie bez usuwania czegokolwiek.',
        runDryRun: 'Uruchom próbę',
        runAgain: 'Uruchom ponownie',
        ranAt: ({ time }: { time: string }) => `Uruchomiono o ${time} · nic nie usunięto`,
        sweepInProgress: 'Trwa czyszczenie — spróbuj ponownie, gdy się skończy.',
        wouldDelete: ({ count, examined }: { count: string; examined: string }) => `Do usunięcia: ${count} · sprawdzono: ${examined}`,
        nothingToDelete: 'Nic do usunięcia',
        stopTimeBudget: 'zatrzymano: limit czasu',
        stopRowBudget: 'zatrzymano: limit usuwania',
        stopCandidateBudget: 'zatrzymano: limit sprawdzania',
        stopStalled: 'zatrzymano: brak postępu',
        keep: 'Zachowaj',
        deleteAfter: 'Usuń po',
        days: 'dniach',
        daysFor: ({ domain }: { domain: string }) => `Liczba dni przechowywania: ${domain}`,
        daysRequired: 'Podaj liczbę dni.',
        daysInvalid: 'Użyj całkowitej liczby dni, co najmniej 1.',
        defaultEffect: ({ effect }: { effect: string }) => `Domyślnie · ${effect}`,
        alwaysRuns: 'Działa nawet przy wyłączonym automatycznym usuwaniu.',
        expiresAutomatically: 'Wygasa automatycznie',
        systemRecords: 'Rekordy systemowe',
        systemRecordsSummary_one: '1 rodzaj rekordów, które ten Home przechowuje dla siebie',
        systemRecordsSummary_other: ({ count }: { count: number }) => `Rodzaje rekordów, które ten Home przechowuje dla siebie: ${count}`,
        adminTitle: 'Tylko właściciele mogą zmieniać, co przechowuje ten Home',
        adminBody: 'Widzisz reguły, bo jesteś adminem.',
        loadFailed: 'Ten Home nie zwrócił swoich ustawień danych.',
        conflictTitle: 'Ustawienia danych zmieniono gdzie indziej',
        conflictBody: 'Ktoś zmienił ustawienia tego Home, gdy je przeglądałeś. Strona pokazuje teraz to, co zapisał Home.',
    },
};

const homeGovernanceTranslations = { pl } as const;

return { homeGovernanceTranslations };
})();

const Domain_homeIndexTranslations = (() => {
type HomeIndexTranslation = Shared_homeIndexTranslations.HomeIndexTranslation;

const homeIndexTranslations = { pl: {
        greetingMorning: ({ name }) => `Dzień dobry, ${name}`,
        greetingAfternoon: ({ name }) => `Dzień dobry, ${name}`,
        greetingEvening: ({ name }) => `Dobry wieczór, ${name}`,
        greetingMorningAnonymous: 'Dzień dobry',
        greetingAfternoonAnonymous: 'Dzień dobry',
        greetingEveningAnonymous: 'Dobry wieczór',
        sessionsWorking: ({ count }) => `Pracujące sesje: ${count}`,
        sessionsNeedYou: ({ count }) => `Czeka na Ciebie: ${count}`,
        nothingRunning: 'Nic jeszcze nie działa',
        customize: 'Dostosuj',
        customizeTitle: 'Dostosuj stronę główną',
        customizeDescription: 'Przeciągnij, aby zmienić kolejność. Zapisywane na koncie, więc każde urządzenie pokazuje tę samą stronę.',
        reset: 'Resetuj',
        alwaysShown: 'Zawsze widoczne',
        builtIn: 'Wbudowane',
        startDescription: 'Pole wiadomości i sugestie',
        attentionDescription: 'Widoczne, gdy coś na Ciebie czeka',
        machinesDescription: 'Wbudowane · siatka Twoich maszyn',
        hiddenSetupSteps: 'Ukryte kroki konfiguracji',
        showAgain: ({ count }) => `${count} · Pokaż ponownie`,
        reorderHandle: ({ section }) => `Zmień kolejność: ${section}`,
    } } satisfies Pick<Readonly<Record<string, HomeIndexTranslation>>, "pl">;

return { homeIndexTranslations };
})();

const Domain_homeSettingsTranslations = (() => {
const en = Shared_homeSettingsTranslations.en;

const pl: typeof en = {
    page: {
        title: 'Ustawienia serwera',
        description: 'Każde ustawienie odczytywane przez serwer, które nie ma własnej strony.',
        searchPlaceholder: 'Szukaj ustawień lub zmiennych środowiskowych',
        changed: 'Zmienione',
        changedA11y: ({ count }: { count: number }) => (count === 1 ? 'Pokaż tylko 1 zmienione ustawienie' : `Pokaż tylko zmienione ustawienia (${count})`),
        noMatches: 'Żadne ustawienie nie pasuje do wyszukiwania.',
        noChanges: 'Żadne ustawienie w tym Home nie różni się od wartości domyślnej.',
        filterLabel: 'Pokaż',
        filterAll: 'Wszystkie ustawienia',
        filterChanged: ({ count }: { count: number }) => `Zmienione · ${count}`,
        more: 'Więcej',
        readOnlyTitle: 'Tylko do odczytu przy uruchomieniu',
        readOnlyDescription: 'Serwer potrzebuje ich, zanim odczyta jakiekolwiek zapisane ustawienie, dlatego ustawia się je tam, gdzie działa.',
        note: 'Ustawienia działają od razu po zmianie, chyba że są oznaczone jako „Działa po ponownym uruchomieniu”. Oczekuje oznacza, że zapisana wartość różni się od tej, z którą serwer został uruchomiony. Każda zmiana jest zapisywana w Aktywności; wartości tajne nigdy.',
        adminTitle: 'Tylko właściciele zmieniają ustawienia serwera',
        adminBody: 'Widzisz każde ustawienie i źródło jego wartości.',
        loadFailed: 'Nie udało się wczytać ustawień serwera.',
        saveFailed: 'Ustawienie nie zostało zapisane.',
        conflictTitle: 'Ustawienia zmieniono w innym miejscu',
        conflictBody: 'Ktoś zmienił ustawienia tego Home, gdy je edytowałeś. Strona pokazuje teraz jego wartości; Twoja zmiana nadal jest w polu.',
    },
    row: {
        appliesAfterRestart: 'Działa po ponownym uruchomieniu',
        pending: 'Oczekuje',
        defaultValue: ({ value }: { value: string }) => `Domyślnie: ${value}`,
        runningWith: ({ value }: { value: string }) => `działa z ${value} od ostatniego uruchomienia`,
        runningWithout: 'działa bez tego od ostatniego uruchomienia',
        ignored: ({ reason }: { reason: string }) => `Zignorowane przy ostatnim uruchomieniu: ${reason}`,
        runningOn: ({ value }: { value: string }) => `działa na ${value}`,
        notSet: 'Nieustawione',
        outOfBounds: ({ bounds }: { bounds: string }) => `Musi być ${bounds}`,
        invalid: 'Ta wartość jest tu nieprawidłowa',
        storedEncrypted: 'zapisane w postaci zaszyfrowanej, nigdy niepokazywane',
    },
    banner: {
        pendingNames: ({ names }: { names: string }) => `${names}.`,
        andMore: ({ count }: { count: number }) => (count === 1 ? 'i 1 więcej' : `i więcej: ${count}`),
        discard: 'Odrzuć',
        discardA11y: 'Odrzuć zmiany, które zadziałają po ponownym uruchomieniu',
        discarded: 'Oczekujące zmiany odrzucone',
        ignoredTitle: 'Przy ostatnim uruchomieniu zignorowano ustawienie',
        ignoredTitleMany: ({ count }: { count: number }) => `Ustawienia zignorowane przy ostatnim uruchomieniu: ${count}`,
        ignoredBody: ({ setting, reason }: { setting: string; reason: string }) => `${setting}: ${reason}. Serwer uruchomił się bez tego ustawienia.`,
        fix: 'Napraw',
    },
    readOnly: {
        before_database: 'Odczytywane przed otwarciem bazy danych',
        per_process_identity: 'Różne dla każdego procesu serwera',
        invariant: 'Chroni logowanie i limity builda, więc nie można go tu zmienić',
        other: 'Ustawiane tam, gdzie działa serwer',
        set: 'Ustawione',
    },
    secret: {
        saved: 'Zapisane',
        replace: 'Zastąp',
        clear: 'Usuń',
        keep: 'Zachowaj',
        clearPending: 'Zapisana wartość zostanie usunięta po zapisaniu.',
        valueSet: 'Ustawione',
        valueNotSet: 'Nieustawione',
        setAction: 'Ustaw',
    },
    groupSummary: ({ count }: { count: number }) => (count === 1 ? '1 ustawienie · domyślne' : `Ustawienia: ${count} · domyślne`),
    groupSummaryChanged: ({ count, changed }: { count: number; changed: number }) => `Ustawienia: ${count} · zmienione: ${changed}`,
    units: {
        ms: 'ms',
        seconds: 's',
        minutes: 'min',
        bytes: 'bajty',
        megabytes: 'MB',
    },
    activity: {
        discarded: 'Odrzucono oczekujące ustawienie serwera',
    },
    choices: {
        hosted_happier_relay: 'Przekaźnik Happier',
        direct_apns: 'Push Apple',
        background_wake_best_effort: 'Wybudzanie w tle',
        local_only: 'Tylko to urządzenie',
        disabled: 'Wyłączone',
        enabled: 'Włączone',
        automatic: 'Automatycznie',
        sandbox: 'Piaskownica',
        production: 'Produkcja',
        owner: 'Właściciele serwera',
        authenticated: 'Każdy zalogowany',
        self: 'Ten serwer',
        external: 'Usługa zewnętrzna',
        '0': 'Wyłączone',
        '1': 'Włączone',
        any: 'Dowolna',
        all: 'Wszystkie',
        github_app: 'GitHub App',
        oauth_user_token: 'Token osoby',
        light: 'Lekki',
        full: 'Pełny',
        api: 'Tylko API',
        worker: 'Tylko worker',
        fatal: 'Krytyczne',
        error: 'Błędy',
        warn: 'Ostrzeżenia',
        info: 'Informacje',
        debug: 'Debugowanie',
        trace: 'Śledzenie',
        silent: 'Cisza',
        manual: 'Ręcznie',
        default: 'Domyślne serwera',
    },
    rateLimit: {
        max: ({ route }: { route: string }) => `${route}: żądania na okno`,
        window: ({ route }: { route: string }) => `${route}: okno`,
    },
    groups: {
        api: 'API i sieć',
        storage: 'Przechowywanie i pliki',
        monitoring: 'Monitorowanie',
        process: 'Proces',
        ui: 'Serwowanie aplikacji webowej',
        realtime: 'Obecność i sockety',
        retentionCaps: 'Limity zasobów przechowywania',
        rpc: 'Wywołania maszyn',
        liveActivity: 'Live Activities',
        voice: 'Głos',
        connectedServices: 'Połączone usługi',
        localServices: 'Usługi lokalne',
        plugins: 'Wtyczki',
        reviews: 'Przeglądy',
        bugReports: 'Zgłoszenia błędów',
        releases: 'Wydania',
        authCaches: 'Pamięci podręczne logowania',
        limits: 'Limity',
        rateLimits: 'Limity żądań według trasy',
        github: 'Logowanie przez GitHub',
        oauth: 'Logowanie przez OAuth',
        oidc: 'Dostawcy OIDC z konfiguracji',
        workos: 'WorkOS',
        signInRequests: 'Żądania logowania',
        offboarding: 'Wycofywanie dostępu',
        friends: 'Znajomi',
        accountService: 'Usługa kont',
        devices: 'Urządzenia',
        diagnostics: 'Diagnostyka',
        reachInference: 'Wykrywanie adresu',
        addresses: 'Adresy',
        other: 'Inne',
    },
    keys: {
        HAPPIER_HOME_DISPLAY_NAME: 'Nazwa Home',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: 'Aktualizacje w tle',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: 'Tryb dostarczania',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_ALLOW_FALLBACK: 'Przełączaj na inny tryb',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_DEDUPE_WINDOW_MS: 'Okno duplikatów aktualizacji',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_ENABLED: 'Pushe wybudzające w tle',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_MIN_INTERVAL_MS: 'Najkrótszy odstęp między pushami wybudzającymi',
        HAPPIER_LIVE_ACTIVITY_EXPO_WIDGETS_PUSH_NOTIFICATIONS_ENABLED: 'Build z widżetami odbiera pushe',
        HAPPIER_LIVE_ACTIVITY_TARGET_TRANSIENT_FAILURE_BUDGET: 'Błędy przed pominięciem urządzenia',
        HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT: 'Środowisko pushy Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID: 'ID zespołu Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID: 'ID klucza pushy Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY: 'Klucz podpisu pushy Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY_FILE: 'Plik klucza podpisu pushy Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS: 'Dozwolone bundle ID aplikacji',
        HAPPIER_LIVE_ACTIVITY_APNS_ACTIVITY_NAMES: 'Dozwolone nazwy Live Activity',
        HAPPIER_LIVE_ACTIVITY_APNS_REQUEST_TIMEOUT_MS: 'Limit czasu żądań pushy Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_RECONNECT_BACKOFF_MS: 'Opóźnienie ponownego połączenia pushy Apple',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED: 'Używaj hostowanego przekaźnika',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL: 'Adres hostowanego przekaźnika',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEY: 'Klucz dostępu do hostowanego przekaźnika',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_SERVICE_ENABLED: 'Działaj jako hostowany przekaźnik',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEYS: 'Klucze dostępu do przekaźnika dla innych serwerów',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_MAX_SKEW_MS: 'Tolerancja zegara przekaźnika',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_TTL_MS: 'Pamięć duplikatów przekaźnika',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_CACHE_MAX_ENTRIES: 'Rozmiar pamięci duplikatów przekaźnika',
        ELEVENLABS_API_KEY: 'Klucz API ElevenLabs',
        ELEVENLABS_AGENT_ID: 'Agent ElevenLabs',
        ELEVENLABS_AGENT_ID_PROD: 'Produkcyjny agent ElevenLabs',
        ELEVENLABS_API_BASE_URL: 'Adres API ElevenLabs',
        REVENUECAT_SECRET_KEY: 'Tajny klucz RevenueCat',
        VOICE_FREE_SESSIONS_PER_MONTH: 'Darmowe sesje głosowe miesięcznie',
        VOICE_FREE_MINUTES_PER_MONTH: 'Darmowe minuty głosowe miesięcznie',
        VOICE_MAX_CONCURRENT_SESSIONS: 'Równoczesne sesje głosowe',
        VOICE_MAX_SESSION_SECONDS: 'Najdłuższa sesja głosowa',
        VOICE_MAX_MINUTES_PER_DAY: 'Minuty głosowe dziennie',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_ENABLED: 'Uzupełnianie tożsamości głosowej',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE: 'Rozmiar partii uzupełniania',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS: 'Limit czasu uzupełniania',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_DELAY_MS: 'Przerwa między partiami uzupełniania',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_INTERVAL_MS: 'Odstęp między przebiegami uzupełniania',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID: 'ID klienta OAuth OpenAI Codex',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL: 'Endpoint tokenów OpenAI Codex',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID: 'ID klienta OAuth subskrypcji Claude',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL: 'Endpoint tokenów subskrypcji Claude',
        HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS: 'Limit czasu wymiany tokenów',
        CONNECTED_SERVICE_CREDENTIAL_MAX_LEN: 'Największe zapisane poświadczenie',
        CONNECTED_SERVICE_REFRESH_LEASE_MAX_MS: 'Najdłuższa dzierżawa odświeżania',
        VENDOR_TOKEN_MAX_LEN: 'Największy token dostawcy',
        HAPPIER_LOCAL_SERVICES_TOKEN_SECRET: 'Sekret tokenów podglądu',
        HAPPIER_LOCAL_SERVICES_PREVIEW_TOKEN_SECRET: 'Sekret tokenów prywatnego podglądu',
        HAPPIER_LOCAL_SERVICES_PUBLIC_PREVIEW_TOKEN_SECRET: 'Sekret tokenów publicznego podglądu',
        HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN: 'Źródło interfejsu wtyczek',
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_MAX_AGE_MS: 'Ważność dowodu wydawcy',
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_CLOCK_SKEW_MS: 'Tolerancja zegara dowodu wydawcy',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_MAX_AGE_MS: 'Ważność dowodu przeglądu',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_CLOCK_SKEW_MS: 'Tolerancja zegara dowodu przeglądu',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: 'Dołączaj logi serwera',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: 'Kto może czytać logi serwera',
        HAPPIER_BUG_REPORTS_SERVER_LOG_PATH: 'Plik logu serwera',
        HAPPIER_BUG_REPORTS_SERVER_LOG_MAX_BYTES: 'Dołączany rozmiar logu',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'Kanał wydań',
        HAPPIER_GITHUB_REPO: 'Repozytorium wydań',
        AUTH_OFFBOARDING_ENABLED: 'Ponownie sprawdzaj prawo do logowania',
        AUTH_OFFBOARDING_STRICT: 'Odmawiaj, gdy sprawdzenie się nie powiedzie',
        AUTH_OFFBOARDING_INTERVAL_SECONDS: 'Odstęp między sprawdzeniami',
        AUTH_PROVIDERS_CONFIG_PATH: 'Plik dostawców',
        AUTH_PROVIDERS_CONFIG_JSON: 'JSON dostawców',
        HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: 'Usługa logowania',
        HAPPIER_AUTH_SIGN_IN_SERVICE_URL: 'Adres usługi kont',
        HAPPIER_AUTH_SIGN_IN_SERVICE_SERVER_IDENTITY_ID: 'Tożsamość usługi kont',
        HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME: 'Nazwa usługi kont',
        HAPPIER_SERVER_OWNER_USER_IDS: 'Konta właścicieli serwera',
        HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED: 'Nowe urządzenia wymagają zatwierdzenia',
        GITHUB_CLIENT_ID: 'ID klienta OAuth GitHub',
        GITHUB_CLIENT_SECRET: 'Sekret klienta OAuth GitHub',
        GITHUB_REDIRECT_URL: 'Adres zwrotny GitHub',
        GITHUB_HTTP_TIMEOUT_SECONDS: 'Limit czasu żądań do GitHub',
        GITHUB_STORE_ACCESS_TOKEN: 'Zachowuj token dostępu GitHub',
        OAUTH_PENDING_TTL_SECONDS: 'Ważność oczekujących logowań',
        OAUTH_STATE_TTL_SECONDS: 'Ważność stanu OAuth',
        HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES: 'Dozwolone schematy powrotu do aplikacji',
        AUTH_GITHUB_ALLOWED_USERS: 'Dozwoleni użytkownicy GitHub',
        AUTH_GITHUB_ALLOWED_ORGS: 'Dozwolone organizacje GitHub',
        AUTH_GITHUB_ORG_MATCH: 'Wymagane organizacje',
        AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: 'Sprawdzanie członkostwa',
        AUTH_GITHUB_APP_ID: 'ID GitHub App do członkostwa',
        AUTH_GITHUB_APP_PRIVATE_KEY: 'Klucz GitHub App do członkostwa',
        AUTH_GITHUB_APP_INSTALLATION_ID_BY_ORG: 'Instalacje aplikacji według organizacji',
        WORKOS_API_KEY: 'Klucz API WorkOS',
        WORKOS_CLIENT_ID: 'ID klienta WorkOS',
        ACCOUNT_AUTH_REQUEST_TTL_SECONDS: 'Ważność żądań logowania do konta',
        TERMINAL_AUTH_REQUEST_TTL_SECONDS: 'Ważność żądań logowania z terminala',
        AUTH_PAIRING_TTL_SECONDS: 'Ważność kodu parowania',
        AUTH_TOKEN_CACHE_TTL_SECONDS: 'Ważność pamięci tokenów sesji',
        AUTH_TOKEN_CACHE_MAX_ENTRIES: 'Rozmiar pamięci tokenów sesji',
        AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: 'Ważność pamięci uprawnień',
        AUTH_LOGIN_ELIGIBILITY_CACHE_MAX_ENTRIES: 'Rozmiar pamięci uprawnień',
        FRIENDS_USERNAME_MIN_LEN: 'Najkrótsza nazwa użytkownika',
        FRIENDS_USERNAME_MAX_LEN: 'Najdłuższa nazwa użytkownika',
        FRIENDS_USERNAME_REGEX: 'Wzorzec nazwy użytkownika',
        HAPPIER_CANONICAL_SERVER_URL: 'Adres tożsamości logowania',
        HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE: 'Adres powrotu OAuth aplikacji webowej',
        PUBLIC_URL: 'Ogłaszany adres (light)',
        HAPPIER_PUBLIC_SERVER_URL_INFER_TTL_MS: 'Ważność wykrytego adresu',
        HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL: 'Wykrywaj z metody dostępu',
        HAPPIER_TAILSCALE_INFER_PUBLIC_URL: 'Wykrywaj z Tailscale',
        HAPPIER_TAILSCALE_SERVE_STATUS_TIMEOUT_MS: 'Limit czasu sprawdzania Tailscale Serve',
        HAPPIER_TAILSCALE_FUNNEL_STATUS_TIMEOUT_MS: 'Limit czasu sprawdzania Tailscale Funnel',
        PORT: 'Port nasłuchu',
        HAPPIER_SERVER_HOST: 'Adres nasłuchu',
        HAPPIER_SERVER_FLAVOR: 'Wariant serwera',
        NODE_ENV: 'Środowisko Node',
        SERVER_ROLE: 'Rola procesu',
        UV_THREADPOOL_SIZE: 'Wątki robocze',
        HAPPIER_INSTANCE_ID: 'ID repliki',
        HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: 'Termin zamknięcia',
        HAPPY_EXIT_ON_FATAL: 'Zakończ po błędzie krytycznym',
        HAPPIER_API_CORS_MAX_AGE_SECONDS: 'Pamięć zapytań preflight przeglądarki',
        HAPPIER_SERVER_IDENTITY_ID: 'Tożsamość serwera',
        HAPPIER_MANAGED_RELAY_PURPOSE: 'Przeznaczenie zarządzanego przekaźnika',
        HAPPIER_PERSONAL_HOME_RELOCATION_OPERATION_ID: 'Operacja przeniesienia',
        HAPPIER_SERVER_STARTUP_RECEIPT_PATH: 'Plik potwierdzenia uruchomienia',
        HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: 'Nonce potwierdzenia uruchomienia',
        HAPPIER_UPDATER_FORWARD_RECOVERY_CAPABILITY: 'Odzyskiwanie naprzód w aktualizatorze',
        HAPPIER_RELEASE_SOURCE_SHA: 'Commit builda',
        HAPPIER_FEATURE_POLICY_ENV: 'Zasady kanału wydań',
        HAPPIER_BUILD_FEATURES_ALLOW: 'Dozwolone funkcje',
        HAPPIER_BUILD_FEATURES_DENY: 'Zablokowane funkcje',
        HAPPIER_SERVER_LOG_LEVEL: 'Poziom logowania',
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: 'Zbiorczy log debugowania',
        HAPPIER_SELF_HOST_LOG_DIR: 'Katalog logów',
        HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS: 'Diagnostyka uwierzytelniania',
        HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS: 'Diagnostyka wiadomości socketów',
        METRICS_ENABLED: 'Metryki',
        METRICS_PORT: 'Port metryk',
        SENTRY_DSN: 'DSN raportowania błędów',
        HAPPIER_SENTRY_USE_CENTRAL_DSN: 'Raportuj do Happier',
        HAPPIER_SENTRY_CENTRAL_DSN: 'Centralny DSN raportowania błędów',
        SENTRY_ENVIRONMENT: 'Środowisko raportowania błędów',
        SENTRY_RELEASE: 'Wydanie w raportach błędów',
        SENTRY_PROFILE_LIFECYCLE: 'Profilowanie',
        SENTRY_SEND_DEFAULT_PII: 'Wysyłaj dane osobowe',
        SENTRY_TRACES_SAMPLE_RATE: 'Śledzone żądania',
        SENTRY_PROFILE_SESSION_SAMPLE_RATE: 'Profilowane sesje',
        SENTRY_ENABLE_LOGS: 'Wysyłaj logi',
        SENTRY_LOG_LEVELS: 'Wysyłane poziomy logów',
        SENTRY_MONITORS_ENABLED: 'Monitory zadań',
        HAPPIER_SERVER_UI_DIR: 'Folder aplikacji webowej',
        HAPPIER_SERVER_UI_PREFIX: 'Ścieżka aplikacji webowej',
        HAPPIER_SERVER_UI_REQUIRED: 'Wymagaj aplikacji webowej',
        HAPPIER_SERVER_UI_DEPLOYMENT_ID: 'ID wdrożenia aplikacji webowej',
        HAPPIER_SERVER_UI_DEBUG_PATH: 'Pokazuj ścieżkę aplikacji webowej, gdy jej brak',
        HAPPIER_SOCKET_ADAPTER: 'Adapter socketów',
        HAPPIER_SOCKET_REDIS_ADAPTER: 'Adapter socketów Redis (starszy)',
        HAPPIER_SOCKET_ADAPTER_MAXLEN: 'Długość strumienia socketów',
        HAPPIER_SOCKET_ADAPTER_READ_COUNT: 'Rozmiar odczytu strumienia socketów',
        HAPPIER_SOCKET_MAX_HTTP_BUFFER_SIZE: 'Największa wiadomość socketu',
        HAPPIER_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS: 'Próg szybkiego rozłączenia',
        HAPPIER_SOCKET_PLANNED_RESTART_RETRY_AFTER_MS: 'Opóźnienie ponownego połączenia podczas restartu',
        HAPPIER_SOCKET_RECONNECT_WINDOW_MS: 'Okno ponownego połączenia',
        HAPPY_SOCKET_ROOMS_ONLY: 'Ścisła dystrybucja socketów',
        HAPPIER_MACHINE_SOCKET_OWNER_TTL_SECONDS: 'Własność socketu maszyny',
        HAPPIER_PRESENCE_STREAM_MAXLEN: 'Długość strumienia obecności',
        HAPPIER_PRESENCE_WORKER_DB_WRITE_CONCURRENCY: 'Równoczesne zapisy obecności',
        HAPPIER_PRESENCE_WORKER_FLUSH_INTERVAL_MS: 'Odstęp zapisu obecności',
        HAPPIER_PRESENCE_WORKER_READ_BLOCK_MS: 'Oczekiwanie na odczyt obecności',
        HAPPIER_PRESENCE_WORKER_READ_COUNT: 'Rozmiar odczytu obecności',
        HAPPIER_PRESENCE_WORKER_RECLAIM_IDLE_MS: 'Przejmij obecność po',
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: 'Sesja nieaktywna po',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: 'Maszyna offline po',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: 'Odstęp sprawdzania obecności',
        HAPPIER_PRESENCE_SHUTDOWN_FLUSH_TIMEOUT_MS: 'Zapis obecności przy zamykaniu',
        HAPPIER_RPC_FORWARD_TIMEOUT_MS: 'Limit czasu wywołań maszyn',
        HAPPIER_RPC_FORWARD_CAPABILITIES_TIMEOUT_MS: 'Limit czasu wywołania możliwości',
        HAPPIER_RPC_FORWARD_MAX_TIMEOUT_MS: 'Najdłuższy limit czasu wywołania',
        HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Czekaj na metodę',
        HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS: 'Odstęp sprawdzania metod',
        HAPPIER_RPC_CLUSTER_FETCH_TIMEOUT_MS: 'Limit czasu wyszukiwania między replikami',
        HAPPIER_STOP_SESSION_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Czekaj, aby zatrzymać sesję',
        HAPPIER_DIRECT_SESSIONS_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Czekaj na sesje bezpośrednie',
        HAPPIER_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT: 'Sesje wymagające uwagi przy pierwszym wczytaniu',
        HAPPIER_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT: 'Tury sprawdzane do wycofania',
        HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT: 'Zachowywana historia ustawień',
        HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK: 'Wymagaj podpisanego klucza maszyny',
        DATABASE_URL: 'Baza danych',
        HAPPIER_DB_PROVIDER: 'Silnik bazy danych',
        HAPPIER_DB_CONNECTION_LIMIT: 'Rozmiar puli połączeń',
        HAPPIER_DB_READINESS_TIMEOUT_MS: 'Limit czasu gotowości bazy danych',
        HAPPIER_DB_TX_MAX_RETRIES: 'Ponowienia transakcji',
        HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: 'Opóźnienie pierwszego ponowienia',
        HAPPIER_DB_TX_RETRY_MAX_DELAY_MS: 'Najdłuższe opóźnienie ponowienia',
        HAPPIER_DB_TX_RETRY_JITTER_FACTOR: 'Losowy rozrzut ponowień',
        HAPPIER_DB_TX_TIMEOUT_MS: 'Limit czasu transakcji',
        HAPPIER_DB_TX_MAX_WAIT_MS: 'Oczekiwanie na połączenie',
        HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS: 'Łączny czas ponowień',
        HAPPIER_SERVER_DB_SIZE_WARN_BYTES: 'Ostrzeżenie o rozmiarze bazy danych',
        HAPPIER_SQLITE_AUTO_MIGRATE: 'Migruj przy uruchomieniu',
        HAPPIER_SQLITE_MIGRATIONS_DIR: 'Folder migracji',
        HAPPIER_SQLITE_JOURNAL_MODE: 'Tryb dziennika SQLite',
        HAPPIER_SQLITE_SYNCHRONOUS: 'Tryb synchroniczny SQLite',
        HAPPIER_SQLITE_JOURNAL_SIZE_LIMIT_BYTES: 'Limit rozmiaru dziennika SQLite',
        HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: 'Odstęp checkpointów SQLite',
        HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: 'Oczekiwanie na checkpoint SQLite',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_INTERVAL_MS: 'Odstęp vacuum SQLite',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES: 'Strony vacuum SQLite',
        HAPPIER_FILES_BACKEND: 'Backend plików',
        S3_HOST: 'Host S3',
        S3_PORT: 'Port S3',
        S3_USE_SSL: 'S3 przez TLS',
        S3_REGION: 'Region S3',
        S3_BUCKET: 'Bucket S3',
        S3_PUBLIC_URL: 'Publiczny adres S3',
        S3_ACCESS_KEY: 'Klucz dostępu S3',
        S3_SECRET_KEY: 'Tajny klucz S3',
        REDIS_URL: 'Połączenie Redis',
        HANDY_MASTER_SECRET: 'Sekret główny',
        HAPPIER_SERVER_LIGHT_DATA_DIR: 'Katalog danych',
        HAPPIER_SERVER_LIGHT_DB_DIR: 'Katalog bazy danych',
        HAPPIER_SERVER_LIGHT_FILES_DIR: 'Katalog plików',
        HAPPIER_API_RATE_LIMITS_ENABLED: 'Limity żądań',
        HAPPIER_API_RATE_LIMITS_GLOBAL_MAX: 'Żądania na klienta',
        HAPPIER_API_RATE_LIMITS_GLOBAL_WINDOW: 'Okno limitu żądań',
        HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY: 'Licz żądania według',
        HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: 'Licz żądania tras według',
        HAPPIER_SERVER_TRUST_PROXY: 'Ufaj nagłówkom proxy',
        HAPPIER_SERVER_RETENTION__INTERVAL_MS: 'Odstęp między czyszczeniami',
        HAPPIER_SERVER_RETENTION__BATCH_SIZE: 'Wiersze na partię',
        HAPPIER_SERVER_RETENTION__MAX_DELETES_PER_RULE_PER_RUN: 'Najwięcej usunięć na regułę',
        HAPPIER_SERVER_RETENTION__SWEEP_TIME_BUDGET_MS: 'Limit czasu czyszczenia',
        HAPPIER_SERVER_RETENTION__MAX_CANDIDATES_PER_RULE_PER_RUN: 'Najwięcej sprawdzanych wierszy na regułę',
    },
};

const homeSettingsTranslations = { pl } as const;

return { homeSettingsTranslations };
})();

const Domain_homeSetupTranslations = (() => {
type HomeSetupTranslation = Shared_homeSetupTranslations.HomeSetupTranslation;

const homeSetupTranslations = { pl: {
        dismiss: ({ title }) => `Ukryj „${title}”`,
        dismissTooltip: 'Ukryj · przywrócisz w „Dostosuj”',
        close: 'Zamknij',
        addPhoneSubtitle: 'Śledź sesje i odpowiadaj na prośby o zgodę z dowolnego miejsca.',
        addPhoneAction: 'Pokaż kod QR',
        addMachineSubtitle: 'Serwer lub maszyna deweloperska dla agentów — przez SSH albo jednym poleceniem.',
        installComputerTitle: 'Zainstaluj na innym komputerze',
        installComputerSubtitle: 'Zainstaluj tam aplikację i dołącz do tego Home za pomocą linku.',
        installComputerAction: 'Pobierz link',
        connectComputerTitle: 'Połącz komputer',
        connectComputerSubtitle: 'Zeskanuj kod, który Happier pokazuje w terminalu komputera.',
        connectComputerHint: 'Skieruj aparat na kod, który Happier pokazuje w terminalu komputera.',
        phoneAddMachineSubtitle: 'Skonfiguruj serwer lub maszynę deweloperską dla agentów.',
        phoneAddMachineAction: 'Dodaj',
        thisHome: 'tego Home',
        pairingPhoneTitle: 'Zeskanuj telefonem',
        pairingPhoneBody: ({ home }) => `Skieruj aparat telefonu na kod. Happier otworzy się i dołączy do ${home}.`,
        pairingPhoneStepInstall: 'Zainstaluj Happier na telefonie.',
        pairingPhoneStepScan: 'Otwórz aparat i zeskanuj kod.',
        pairingPhoneStepJoin: 'Nie zamykaj tego: telefon dołączy zaraz po zeskanowaniu.',
        pairingComputerTitle: 'Dołącz z innego komputera',
        pairingComputerBody: ({ home }) => `Wyślij ten link na drugi komputer. Otwarcie go w Happier dołączy do ${home}.`,
        pairingComputerStepInstall: 'Zainstaluj aplikację na drugim komputerze.',
        pairingComputerStepOpen: 'Otwórz tam link albo wklej go w Happier, gdy zapyta o sposób połączenia.',
        pairingComputerStepJoin: 'Nie zamykaj tego: komputer dołączy, gdy tylko otworzy link.',
        appStore: 'App Store',
        googlePlay: 'Google Play',
        getDesktopApp: 'Pobierz aplikację',
        copyLink: 'Kopiuj link',
        waitingForPhone: 'Czekamy na telefon…',
        waitingForComputer: 'Czekamy na komputer…',
        newCodeIn: ({ time }) => `Nowy kod za ${time}`,
        makingCode: 'Tworzymy kod…',
        addingDevice: ({ device }) => `Dodajemy ${device}…`,
        deviceJoined: ({ device, home }) => `${device} dołączył do ${home}`,
        codeFailed: 'Nie udało się utworzyć kodu dla tego Home.',
        codeFailedUnreachable: ({ home }) => `${home} nie odpowiedział temu urządzeniu.`,
        codeFailedIdentity: ({ home }) => `Zapis ${home} na tym urządzeniu nie zgadza się z jego odpowiedzią; połącz go ponownie w Homes.`,
        codeFailedSignedOut: ({ home }) => `To urządzenie nie jest zalogowane do ${home}.`,
        codeFailedTooLarge: 'Ma zbyt wiele adresów, by zmieścić się w kodzie.',
        codeFailedRefused: ({ home }) => `${home} odrzucił prośbę.`,
        codeFailedUnexpected: 'Coś poszło nie tak; spróbuj ponownie.',
        cancelCode: 'Anuluj kod',
        newCode: 'Nowy kod',
        qrLabel: ({ home }) => `Kod QR dodający urządzenie do ${home}`,
        storeQrLabel: ({ store }) => `Kod QR do Happier w ${store}`,
        getTheApp: 'Pobierz aplikację',
        connectServicesTitle: ({ first, second }) => (second ? `Połącz ${first} lub ${second}` : `Połącz ${first}`),
        connectServicesSubtitle: 'Korzystaj z planu, za który już płacisz, na każdej maszynie i sprawdzaj, ile zostało.',
    } } satisfies Pick<Readonly<Record<string, HomeSetupTranslation>>, "pl">;

return { homeSetupTranslations };
})();

const Domain_homeWidgetTranslations = (() => {
type HomeWidgetTranslation = Shared_homeWidgetTranslations.HomeWidgetTranslation;

const homeWidgetTranslations = { pl: {
        open: ({ destination }) => `Otwórz: ${destination}`,
        refreshFailed: 'Nie udało się odświeżyć',
        latestRunsTitle: 'Ostatnie uruchomienia',
        latestRunsLoading: 'Wczytywanie ostatnich uruchomień',
        latestRunsEmptyTitle: 'Brak uruchomień',
        latestRunsEmptyReason: 'Gdy Twoje automatyzacje się uruchomią, tutaj zobaczysz wynik każdego uruchomienia.',
        latestRunsErrorTitle: 'Nie udało się wczytać ostatnich uruchomień',
        latestRunsErrorReason: 'Twój Home nie odpowiedział. Sprawdź połączenie i spróbuj ponownie.',
    } } satisfies Pick<Readonly<Record<string, HomeWidgetTranslation>>, "pl">;

return { homeWidgetTranslations };
})();

const Domain_homesHubTranslations = (() => {
type HomesHubTranslation = Shared_homesHubTranslations.HomesHubTranslation;

const homesHubTranslations = { pl: {
        addHomeOrSignIn: 'Dodaj Home / Zaloguj się',
        sheetDescription: 'Połącz to urządzenie z innym Home lub znajdź swoje.',
        continueWithService: ({ service }) => `Kontynuuj z ${service}`,
        continueWithThisHome: 'Kontynuuj z tym Home',
        continueWithServiceSubtitle: 'Znajdź swoje Home i udostępnij ten na innych urządzeniach.',
        serviceUnavailable: ({ service }) => `${service} jest teraz niedostępny.`,
        serviceUnsupported: ({ service }) => `${service} nie oferuje logowania na konto.`,
        serviceUnavailableUnnamed: 'Twoja usługa logowania jest teraz niedostępna.',
        serviceUnsupportedUnnamed: 'Twoja usługa logowania nie oferuje logowania na konto.',
        scanOrPaste: 'Zeskanuj lub wklej link do Home',
        scanOrPasteSubtitle: 'Dołącz do Home za pomocą kodu QR lub linku.',
        createPersonalHome: 'Utwórz osobisty Home na tym komputerze',
        createPersonalHomeSubtitle: 'Uruchom tutaj Home dla własnych maszyn i urządzeń.',
        opensFirst: 'Otwiera się pierwszy',
    } } as const satisfies Pick<Record<string, HomesHubTranslation>, "pl">;

return { homesHubTranslations };
})();

const Domain_homesJourneysTranslations = (() => {
type Service = Shared_homesJourneysTranslations.Service;

type Home = Shared_homesJourneysTranslations.Home;

type HomesJourneysTranslation = Shared_homesJourneysTranslations.HomesJourneysTranslation;

const en = Shared_homesJourneysTranslations.en;

const ruTimes = Shared_homesJourneysTranslations.ruTimes;

const pl: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "Twoje Homes są tutaj",
        reconcileLead: "Ten telefon śledzi teraz wszystkie Twoje Homes.",
        showMySessions: "Pokaż moje sesje",
        scanComputerCode: "Zeskanuj kod na swoim komputerze",
        serviceLead: "Twoje Homes zostaną znalezione po zalogowaniu. Ten telefon będzie je wszystkie śledzić.",
        serviceAsHomeLead: ({ service }) => `Twoje sesje są na ${service}, zawsze dostępne. Dodaj komputer do uruchamiania agentów, gdy będziesz gotowy.`,
        factAlwaysOnDetail: "Korzystaj z sesji w dowolnej chwili.",
        factAgents: "Twoje komputery uruchamiają agentów",
        factAgentsDetail: "Dodaj komputer później za pomocą kodu QR.",
        fromDeviceHelp: "Otwórz na nim Ustawienia → Dodaj telefon, a następnie zeskanuj kod aparatem tego telefonu lub wklej link Home.",
        scan: "Skanuj",
    },
    happierAccount: 'konto Happier',
    serviceAccount: ({ service }) => `konto ${service}`,

    alreadyUseTitle: 'Już używasz Happier?',
    alreadyUseDescription: 'Znajdź swoje Home za pomocą konta albo połącz się bezpośrednio z Home, który prowadzisz. Na tym komputerze nic się nie zmieni, dopóki nie wybierzesz.',
    signIn: 'Zaloguj się',
    withService: ({ service }) => `przez ${service}`,
    changeServiceLabel: ({ service }) => `Usługa logowania: ${service}. Zmień`,
    connectToHome: 'Połącz z Home…',
    hostedPrompt: 'Wolisz hostowane Home?',
    useServiceAsAHome: ({ service }) => `Użyj ${service} jako Home`,
    dismiss: 'Ukryj',

    pathServiceTitle: ({ service }) => `Zaloguj się przez ${service}`,
    pathServiceSubtitle: 'Znajdź Home powiązane z Twoim kontem',
    pathOtherServiceTitle: 'Zaloguj się przez inną usługę',
    pathOtherServiceSubtitle: 'Własne logowanie lub logowanie Twojej firmy',
    pathDirectTitle: 'Połącz się bezpośrednio z Home',
    pathDirectSubtitle: 'Link lub adres · bez konta',

    serviceLead: 'Po zalogowaniu Twoje Home zostaną odnalezione i pokazane razem. Osobisty Home tego komputera zostaje, dopóki nie zdecydujesz.',
    defaultServiceFact: 'domyślna usługa logowania',
    serviceMethodsHelp: ({ service }) => `Widoczne są tylko metody oferowane przez ${service}. Jesteś tu nowy? Te same przyciski utworzą Twoje konto.`,

    otherServiceLead: 'Jeśli Ty lub Twój zespół prowadzicie własną usługę logowania, wpisz jej adres. Happier najpierw sprawdzi, co oferuje.',
    serviceAddressLabel: 'Adres usługi logowania',
    serviceFound: 'Znaleziono',
    useThisService: ({ service }) => `Zaloguj się przez ${service}`,
    addressIsNotAService: 'Ten adres nie oferuje logowania na konto. Jeśli to Home, połącz się z nim bezpośrednio.',
    connectAsHome: 'Połącz jako Home',
    backToService: ({ service }) => `Wróć do ${service}`,

    directLead: 'Dla Home, który prowadzisz samodzielnie, z usługą kont lub bez niej. Konto Happier nie jest potrzebne.',
    fromDeviceLabel: 'Z urządzenia, które jest już połączone',
    fromDeviceHelp: 'Otwórz na nim Ustawienia → Dodaj telefon, a następnie zeskanuj kod kamerą tego komputera albo wklej link do Home.',
    homeLinkLabel: 'Link do Home',
    homeLinkPlaceholder: 'Wklej link do Home',
    useCamera: 'Użyj kamery',
    openLink: 'Otwórz',
    byAddressLabel: 'Według adresu',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: 'Połącz',
    byAddressHelp: 'Happier sprawdza, czy Home odpowiada, a potem logujesz się metodami tego Home.',
    notAHomeLink: 'To nie jest link do Home. Skopiuj go ponownie z drugiego urządzenia.',
    homeUnreachable: 'Happier nie połączył się z żadnym Home pod tym adresem. Sprawdź adres i czy Home działa.',

    anotherWay: 'Inny sposób',
    homeReachable: 'Osiągalny',
    connected: 'Połączono',
    signInToHomeTitle: 'Zaloguj się do tego Home',
    signInToHomeLead: 'Oto sposoby, które oferuje ten Home.',

    reconcileTitle: 'Twoje Home są połączone',
    reconcileLead: ({ count }) => count === 1
        ? 'Ten komputer ma teraz dwa Home. Są wyświetlane razem w widoku Wszystkie Home.'
        : `Ten komputer ma teraz ${count + 1} Home. Są wyświetlane razem w widoku Wszystkie Home.`,
    reconcileFound: 'Znalezione',
    reconcileThisComputer: 'Ten komputer',
    runSessionsIn: 'Uruchamiaj sesje tego komputera w',
    runSessionsInDescription: 'Nowe sesje rozpoczęte tutaj są zapisywane w tym Home.',
    removeEmptyPersonalHome: 'Usuń pusty osobisty Home',
    removeEmptyPersonalHomeDescription: 'Został utworzony podczas instalacji Happier i nie zawiera jeszcze niczego — żadnych sesji, osób, zespołów ani zaproszeń.',
    changeLater: 'Możesz to później zmienić w Ustawienia → Home.',
    keepBoth: 'Zachowaj oba',
    useHome: ({ home }) => `Użyj ${home}`,
    reconcileSetupTitle: 'Wybierz, dokąd trafiają sesje tego komputera',
    reconcileSetupSubtitle: ({ home }) => `Połączono ${home}. Zachowaj oba Home albo uruchamiaj tam sesje tego komputera.`,
    reconcileSetupAction: 'Wybierz…',

    serviceAsHomeTitle: ({ service }) => `Użyj ${service} jako swojego Home`,
    serviceAsHomeLead: ({ service }) => `Twoje sesje i ustawienia są przechowywane w ${service}, a nie na tym komputerze.`,
    factAlwaysOn: 'Zawsze dostępny',
    factAlwaysOnDetail: 'Telefon ma dostęp do sesji, gdy ten komputer śpi.',
    factAgents: 'Ten komputer nadal uruchamia Twoich agentów',
    factAgentsDetail: 'Miejsce uruchamiania kodu się nie zmienia.',
    storageE2ee: 'Szyfrowanie end-to-end',
    storageE2eeDetail: ({ service }) => `${service} przechowuje Twoje sesje, ale nie może ich odczytać.`,
    storagePlain: ({ service }) => `Przechowywane przez ${service}`,
    storagePlainDetail: 'Bez szyfrowania end-to-end: usługa może odczytać to, co przechowuje.',
    storageE2eeByDefault: 'Domyślnie szyfrowanie end-to-end',
    storagePlainByDefault: ({ service }) => `Przechowywane przez ${service}, domyślnie czytelne`,
    storageChoiceDetail: 'Wybierasz przy tworzeniu konta.',
    removeEmptyOfferedDetail: 'Nie zawiera jeszcze niczego. Proponowane tylko dlatego, że jest pusty.',
    signInOrCreate: ({ account }) => `Zaloguj się lub utwórz ${account}`,
    alreadyUseServiceAsHome: ({ service }) => `Już używasz ${service} jako Home? Zalogowanie połączy go bezpośrednio.`,

    addHomeTitle: 'Dodaj Home',
    addHomeDescription: 'Home przechowuje Twoje sesje i ustawienia. Połącz taki, którego już używasz, albo załóż nowy w innym miejscu.',
    addSignIn: ({ account }) => `Zaloguj się na ${account}`,
    addSignInSubtitle: 'Znajdź Home, których już używasz, i połącz je.',
    addServiceAsHomeSubtitle: 'Hostowany dla Ciebie i zawsze dostępny.',
    addLinkOrQr: 'Połącz linkiem lub kodem QR',
    addLinkOrQrSubtitle: 'Konto nie jest potrzebne. Pobierz go z urządzenia, które jest już połączone.',
    addServerHome: 'Skonfiguruj Home na serwerze',
    addServerHomeSubtitle: 'Maszyna deweloperska lub VPS pod Twoją kontrolą, skonfigurowane przez SSH.',
    haveHomeAddress: 'Masz adres Home?',
    enterIt: 'Wpisz go',

    livesOnThisComputer: 'Znajduje się na tym komputerze',
    availableWhileAwake: 'dostępny, gdy nie śpi',
    gettingReady: 'przygotowuje się',
    noComputerYet: 'Nie masz jeszcze komputera?',
    aboutYourHome: 'O Twoim Home',

    nudgeTitle: ({ count }) => `Home nieosiągalny ${count} ${count === 1 ? 'raz' : 'razy'} w tym tygodniu — przenieść Home?`,
    nudgeBody: 'Jeśli ten Home działa na komputerze, który przechodzi w stan uśpienia, przeniesienie go na stale włączony serwer może pomóc.',
    nudgeDismiss: 'Ukryj na zawsze na tym urządzeniu',
    moveHome: 'Przenieś Home…',
    useService: ({ service }) => `Użyj ${service}`,
};

const homesJourneysTranslations = { pl } satisfies Pick<Readonly<Record<string, HomesJourneysTranslation>>, "pl">;

return { homesJourneysTranslations };
})();

const Domain_identityAdministrationTranslations = (() => {
type IdentityAdministrationLanguage = Shared_identityAdministrationTranslations.IdentityAdministrationLanguage;

type Words = Shared_identityAdministrationTranslations.Words;

type GitHubAccessWords = Shared_identityAdministrationTranslations.GitHubAccessWords;

type OidcEditorWords = Shared_identityAdministrationTranslations.OidcEditorWords;

const build = Shared_identityAdministrationTranslations.build;

const en = Shared_identityAdministrationTranslations.en;

const githubAccessWords: Pick<Readonly<Record<IdentityAdministrationLanguage, GitHubAccessWords>>, "pl"> = { pl: {
        githubCurrentAccess: 'Obecny dostęp',
        githubCurrentAccessSubtitle: 'Wymagany przez włączone połączenia i źródła katalogu korzystające z tej instalacji.',
        githubCurrentAccessEmpty: 'Włączone usługi nie wymagają dostępu.',
        githubSetupAccess: 'Dostęp do konfiguracji i naprawy',
        githubSetupAccessSubtitle: 'Dostęp dla skonfigurowanych połączeń, również wyłączonych i wstrzymanych źródeł katalogu. Przyznaj brakujący dostęp w GitHub przed ich włączeniem lub wznowieniem, a następnie ponownie zweryfikuj instalację.',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `Usuń instalację dla ${name}`,
    } };

const oidcEditorWords: Pick<Readonly<Record<IdentityAdministrationLanguage, OidcEditorWords>>, "pl"> = { pl: {
        clientAuthenticationMethod: 'Uwierzytelnianie klienta', clientSecretPost: 'Treść POST', clientSecretBasic: 'HTTP Basic', storeRefreshToken: 'Przechowuj token odświeżania', buttonColor: 'Kolor przycisku logowania', iconHint: 'Ikona logowania',
        allowRulesHint: 'Wpisz jedną wartość w każdym wierszu. Puste pole oznacza brak ograniczeń.', brandingHint: 'Pozostaw puste, aby użyć domyślnego wyglądu logowania.', invalidScopes: 'Uwzględnij openid w żądanych zakresach.', refreshFailed: 'Nie udało się odświeżyć tego połączenia', refreshFailedHint: 'Twoje zmiany zostały zachowane. Ponów próbę, aby sprawdzić zmiany w Home.',
    } };

const identityAdministrationTranslations = { pl: build({ ...en, title: 'Dostawcy tożsamości', subtitle: 'Połączenia logowania Home dostępne dla Teamów.', homeConnections: 'Połączenia Home', add: 'Dodaj połączenie', empty: 'Brak połączeń Home', active: 'Aktywne', disabled: 'Wyłączone', configuration: 'Konfiguracja', issuer: 'URL wystawcy', clientSecret: 'Sekret klienta', secretSet: 'Ustawiony', secretNotSet: 'Nieustawiony', secretRetain: 'Pozostaw puste, aby zachować bieżący sekret.', advanced: 'Pokaż ustawienia zaawansowane', hideAdvanced: 'Ukryj ustawienia zaawansowane', actions: 'Działania', test: 'Testuj logowanie', testing: 'Otwieranie testu…', edit: 'Edytuj połączenie', save: 'Zapisz połączenie', saving: 'Zapisywanie…', enable: 'Włącz połączenie', disable: 'Wyłącz połączenie', remove: 'Usuń połączenie', createTitle: 'Dodaj dostawcę tożsamości', editTitle: 'Edytuj dostawcę tożsamości', displayName: 'Nazwa', required: 'Uzupełnij wymagane pola.', invalidIssuer: 'Wpisz prawidłowy URL HTTPS.', secretRequired: 'Wpisz sekret klienta.', error: 'Zmiana nie została zastosowana.', accounts: 'Dotknięte Accounty', connections: 'Połączenia Teamu', errorForbidden: 'Nie masz już do tego uprawnień. Nic nie zostało zmienione.', errorConflict: 'Ktoś zmienił to wcześniej. Twoje zmiany są zachowane – odśwież i spróbuj ponownie.', errorMissing: 'To już nie istnieje. Mogło zostać usunięte.', errorInUse: 'Coś nadal od tego zależy. Najpierw to usuń.', errorProviderUnavailable: 'Usługa tożsamości nie odpowiedziała. Nic nie zostało zmienione.', errorRateLimited: 'Dostawca poprosił o odczekanie przed kolejną próbą.', errorInvalid: 'Home odrzucił te wartości. Sprawdź konfigurację i spróbuj ponownie.', errorImmutable: 'Tej wartości nie można zmienić po użyciu rekordu. Utwórz nowy.', errorAuthenticationRequired: 'Zaloguj się ponownie do tego Teamu i spróbuj jeszcze raz. Nic nie zostało zmienione.', errorPolicyUnavailable: 'Nie można teraz ocenić zasad uwierzytelniania Teamu. Nic nie zostało zmienione.', errorPolicyInUse: 'Zasady uwierzytelniania Teamu nadal zależą od tego połączenia.', errorNotAllowed: 'Ten Home nie pozwala Teamom tego konfigurować. Nic nie zostało zmienione.', errorNeedsAttention: 'Synchronizacja katalogu wymaga uwagi. Uruchom pełną synchronizację.', errorSyncPaused: 'To źródło jest wstrzymane. „Wznów synchronizację” uruchamia nową pełną synchronizację.', alternateLogins: 'Accounts wymagające innej metody logowania', recoveryAuthenticationPolicy: 'Otwórz uwierzytelnianie Teamu', recoveryAlternateLogin: 'Najpierw nadaj tym Accounts inną metodę logowania', recoveryDirectory: 'Otwórz katalog', recoveryGroupMappings: 'Otwórz mapowania Grup', recoveryTeamAuthentication: 'Zaloguj się ponownie', callbackUrl: 'Adres URL wywołania zwrotnego', callbackUrlHint: 'Zarejestruj ten adres URL u dostawcy tożsamości.' }, githubAccessWords.pl, oidcEditorWords.pl) };

return { githubAccessWords, oidcEditorWords, identityAdministrationTranslations };
})();

const Domain_inboxWorkTranslations = (() => {
const en = Shared_inboxWorkTranslations.en;

const pl: typeof en = {
    pageDescription: 'Wszystko, co na ciebie czeka, pogrupowane według pracy, do której należy.',
    tabs: { a11y: 'Widok skrzynki', needsYou: 'Czeka na ciebie', updates: 'Nowości' },
    groups: {
        unknownLead: 'Sesja',
        leadMeta: ({ count }) => (count === 1 ? '1 podsesja' : `Podsesje: ${count}`),
        runMeta: 'Uruchomienie przepływu pracy',
        otherTitle: 'Inne sesje',
        otherMeta: 'Poza orkiestratorem i uruchomieniem',
        openSession: 'Otwórz sesję',
        openRun: 'Otwórz uruchomienie',
    },
    rows: {
        step: 'Krok',
        workflowRun: 'Uruchomienie przepływu pracy',
        review: 'Przejrzyj',
        stalled: 'Utknęła',
        stalledReason: 'Jej maszyna przeszła w tryb offline w trakcie tury',
        landing: 'Do scalenia',
        settle: 'Zamknij',
        snoozedUntil: ({ time }) => `Odłożona do ${time}`,
        more: 'Więcej działań',
    },
    popover: {
        moreInOther: ({ count }) => `Jeszcze ${count} w Innych sesjach`,
        updates: ({ count }) => `Nowości: ${count}`,
    },
    empty: {
        title: 'Nic na ciebie nie czeka',
        description: 'Tu trafiają prośby o uprawnienia, przeglądy i wszystko, na co czeka orkiestrator lub przepływ pracy.',
    },
    updatesEmpty: {
        title: 'Brak nowości',
        description: 'Tu trafiają zakończone sesje i zaproszenia do znajomych.',
    },
    stale: { reason: 'Nie udało się odświeżyć uruchomień przepływów pracy', retry: 'Spróbuj ponownie' },
    settleFailed: 'Nie udało się zamknąć tej sesji',
};

const inboxWorkTranslations = { pl };

return { inboxWorkTranslations };
})();

const Domain_inputPickerTranslations = (() => {
type InputPickerTranslation = Shared_inputPickerTranslations.InputPickerTranslation;

const inputPickerTranslations = { pl: {
        browse: 'Przeglądaj…',
        browseField: ({ field }) => `Przeglądaj: ${field}`,
        unavailable: 'Wtyczka, która udostępnia ten wybór, jest niedostępna. Bieżąca wartość zostaje zachowana.',
        retired: 'Wtyczka została zaktualizowana podczas wybierania. Spróbuj ponownie.',
        invalid: 'Tego wyboru nie można tu użyć. Bieżąca wartość zostaje zachowana.',
        failed: 'Nie udało się otworzyć wyboru. Spróbuj ponownie.',
    } } satisfies Pick<Readonly<Record<string, InputPickerTranslation>>, "pl">;

return { inputPickerTranslations };
})();

const Domain_machineAddTranslations = (() => {
type MachineAddTranslation = Shared_machineAddTranslations.MachineAddTranslation;

const machineAddTranslations = { pl: { newMachine: 'Nowa maszyna', waiting: 'Oczekiwanie na połączenie', connected: 'Połączono', failed: 'Nie udało się dodać maszyny', cancelled: 'Anulowano', cannotReachHost: 'Nie można połączyć się z hostem. Sprawdź adres i dostęp SSH.', choosePath: 'Wybierz sposób dodania maszyny', switchHome: 'Wróć do tego domu, aby kontynuować' } } satisfies Pick<Record<'en' | 'ru' | 'pl' | 'es' | 'fr' | 'it' | 'pt' | 'ca' | 'de' | 'zh-Hans' | 'zh-Hant' | 'ja', MachineAddTranslation>, "pl">;

return { machineAddTranslations };
})();

const Domain_machineAgentsTranslations = (() => {
type MachineAgentsTranslation = Shared_machineAgentsTranslations.MachineAgentsTranslation;

const en = Shared_machineAgentsTranslations.en;

const pl: MachineAgentsTranslation = {
    signedInWith: ({ label }) => `Zalogowano przez ${label}`,
    signedInAs: ({ label }) => `Zalogowano jako ${label}`,
    signedInHere: 'Zalogowano na tej maszynie',
    updateTo: ({ version }) => `Aktualizuj do ${version}`,
    needsSignIn: 'Wymaga logowania',
    waitingForSignIn: 'Czekam na logowanie w terminalu…',
    notInstalled: 'Nie zainstalowano',
    downloadSize: ({ size }) => `Pobranie ${size}`,
    installYourself: 'Zainstaluj samodzielnie',
    unsupportedOs: 'Nie działa w tym systemie',
    unsupportedArch: 'Brak wersji dla tego procesora',
    installing: 'Instalowanie…',
    progress: ({ done, total }) => `${done} z ${total}`,
    checking: 'Sprawdzanie…',
    offlineSignedIn: 'Ostatnio zalogowany · maszyna offline',
    offlineSignedOut: 'Ostatnio wylogowany · maszyna offline',
    offlineNotInstalled: 'Ostatnio niezainstalowany · maszyna offline',
    offlineUnknown: 'Maszyna offline',
    unknown: 'Nie udało się sprawdzić tej maszyny',
    actionInstall: 'Zainstaluj',
    actionUpdate: 'Aktualizuj',
    actionSignIn: 'Zaloguj',
    actionRetry: 'Spróbuj ponownie',
    actionCancel: 'Anuluj',
    actionShowTerminal: 'Pokaż terminal',
    actionGuide: 'Przewodnik',
    installLeadManaged: ({ agent, machine }) => `Happier instaluje ${agent} na ${machine} tylko dla Happier. Twoja konfiguracja terminala się nie zmienia.`,
    installLeadVendor: ({ agent, machine }) => `Happier uruchamia instalator ${agent} na ${machine}.`,
    installAlsoDownloads: ({ what }) => `Pobiera też ${what}, na którym działają sesje.`,
    installThenSignIn: 'Potem się logujesz.',
    installAgent: ({ agent }) => `Zainstaluj ${agent}`,
    installMyself: 'Zainstaluję sam',
    manualLead: ({ agent, machine }) => `Happier nie może zainstalować ${agent} za ciebie. Zainstaluj go na ${machine} według przewodnika i sprawdź ponownie.`,
    checkAgain: 'Sprawdź ponownie',
    closeNote: ({ machine }) => `Możesz zamknąć — instalacja trwa dalej na ${machine}.`,
    stepCheck: 'Sprawdź, czy działa',
    stepSignIn: 'Logowanie',
    failedKept: 'Nic niedokończonego nie zostało.',
    installedLine: ({ agent, version }) => `Zainstalowano ${agent} ${version}`,
    nowSignIn: 'teraz się zaloguj',
    signInHow: ({ agent }) => `Jak ${agent} się loguje`,
    useService: ({ service }) => `Użyj: ${service}`,
    recommended: 'Zalecane',
    serviceConnected: ({ profile }) => `${profile} · już połączone · działa na każdej maszynie`,
    serviceNotConnected: 'Połącz raz — każda maszyna może z niego korzystać.',
    connect: 'Połącz',
    signInOn: ({ machine }) => `Zaloguj na ${machine}`,
    signInOnDetail: ({ agent }) => `Uruchamia logowanie ${agent} w terminalu na tej maszynie. Korzysta z niego tylko ona.`,
    noNativeLogin: ({ agent }) => `${agent} nie ma własnego logowania: używa klucza API lub połączonego konta. Połącz je raz, a każda maszyna będzie mogła z niego korzystać.`,
    openSignInTerminal: 'Otwórz logowanie w terminalu',
    useThisAccount: 'Użyj tego konta',
    waitingLead: ({ agent, machine }) => `Logowanie ${agent} jest otwarte w terminalu na ${machine}. Stanie się gotowy, gdy tylko zgłosi zalogowanie.`,
    readyLine: ({ agent, machine }) => `${agent} gotowy na ${machine}`,
    startSessionWith: ({ agent }) => `Rozpocznij sesję z ${agent}`,
    setUpAnother: 'Skonfiguruj innego agenta',
    unsupportedLead: ({ agent, machine }) => `${agent} nie ma wersji dla ${machine}, więc nie może tam działać.`,
    setupTitle: ({ agent }) => `Konfiguracja ${agent}`,
    signInTitle: ({ agent }) => `Zaloguj się do ${agent}`,
    readyTitle: ({ agent }) => `${agent} jest gotowy`,
    notOnMachineYet: ({ machine }) => `Jeszcze nie na ${machine}`,
    onMachine: ({ machine }) => `Na ${machine}`,
    installingOn: ({ machine }) => `Instalowanie na ${machine}`,
    cantRunOn: ({ machine }) => `Nie działa na ${machine}`,
    terminalTab: ({ agent }) => `Logowanie · ${agent}`,
    panelLead: 'Dokończ w otwartej przeglądarce. Inne urządzenie? Otwórz tam link.',
    open: 'Otwórz',
    openSignInPage: 'Otwórz stronę logowania',
    waitingEllipsis: 'Czekam na logowanie…',
    signedInAlready: 'Już zalogowano?',
    closeTerminal: 'Zamknij terminal',
    showTheTerminal: 'Pokaż terminal',
    phoneLead: ({ agent, machine }) => `${agent} prosi o zalogowanie. Otwórz stronę tutaj, dokończ, a ${machine} to przejmie.`,
    panelSignedInAs: ({ account }) => `Zalogowano jako ${account}.`,
    panelChecked: 'Happier właśnie to sprawdził.',
    sectionTitle: 'Agenci',
    sectionDescription: 'Agenci programistyczni na tej maszynie i sposób logowania każdego z nich.',
    addTitle: 'Dodaj agenta',
    addMore: ({ count }) => (count === 1 ? `Jeszcze 1 działa tutaj` : `Jeszcze ${count} działa tutaj`),
    showAll: 'Pokaż wszystkie',
    showFewer: 'Pokaż mniej',
    emptyInstalled: 'Na tej maszynie nie ma jeszcze agenta. Wybierz poniżej — Happier go zainstaluje i zaloguje cię.',
    offlineNote: ({ machine }) => `${machine} jest offline. Tak wyglądał ostatni raport.`,
    firstTitle: 'Skonfiguruj pierwszego agenta',
    firstLead: ({ machine }) => `${machine} jest połączona, ale nie ma jeszcze agenta. Wybierz jednego — Happier go zainstaluje i zaloguje cię.`,
    firstMore: ({ count }) => (count === 1 ? `Albo wybierz z 1 innego agenta.` : `Albo wybierz spośród ${count} innych agentów.`),
    allAgents: 'Wszyscy agenci',
    setUp: 'Skonfiguruj',
    choiceUsesService: ({ service, profile }) => `Używa: ${service}. Połączono: ${profile}.`,
    choiceSignsInOn: 'Logowanie na maszynie.',
    dismissFirst: 'Ukryj „Skonfiguruj pierwszego agenta”',
    dismissTooltip: 'Ukryj · przywrócisz w Dostosuj',
    chooseAgent: 'Wybierz agenta',
    blockNotInstalled: ({ agent, machine }) => `${agent} nie ma jeszcze na ${machine}.`,
    blockSetUpToStart: 'Skonfiguruj go, aby zacząć.',
    blockSignedOut: ({ agent, machine }) => `${agent} na ${machine} wymaga logowania.`,
    spawnCliMissing: ({ agent, machine }) => `${agent} nie jest zainstalowany na ${machine}.`,
    spawnSignedOut: ({ agent, machine }) => `${agent} na ${machine} jest wylogowany.`,
    draftKept: 'Twoja wiadomość została zachowana.',
    alreadySetUp: ({ machine, home }) => `${machine} jest już połączona z ${home}`,
    startSession: 'Rozpocznij sesję',
    openMachine: ({ machine }) => `Otwórz ${machine}`,
};

const machineAgentsTranslations = { pl: pl } satisfies Pick<Readonly<Record<string, MachineAgentsTranslation>>, "pl">;

return { machineAgentsTranslations };
})();

const Domain_machineDetailPageTranslations = (() => {
type MachineDetailPageTranslations = Shared_machineDetailPageTranslations.MachineDetailPageTranslations;

const english = Shared_machineDetailPageTranslations.english;

const translated = Shared_machineDetailPageTranslations.translated;

const machineDetailPageTranslations = { pl: translated({
        machineDetailPage: {
            description: 'Uruchamiaj tu sesje i sprawdzaj, co działa na tej maszynie.',
            placeholderTitle: 'Maszyna',
            online: 'Online',
            offline: 'Offline',
            cliVersionFact: ({ version }) => `CLI ${version}`,
            replacedByFact: ({ machine }) => `Zastąpiona przez ${machine}`,
            unavailableTitle: 'Ta maszyna nie może teraz uruchamiać sesji',
            startAction: 'Uruchom sesję',
            tmuxSectionDescription: 'Jak nowe sesje na tej maszynie korzystają z tmux.',
            windowsSectionDescription: 'Jak otwierają się sesje zdalne na tej maszynie.',
            clisSectionDescription: 'CLI agentów znalezione przez Happier na tej maszynie oraz narzędzia, które może zainstalować.',
            runsSectionDescription: 'Procesy uruchomione przez sesje na tej maszynie.',
            recentSessionsTitle: 'Ostatnie sesje',
            recentSessionsDescription: 'Pięć ostatnich sesji na tej maszynie.',
            daemonSectionDescription: 'Usługa w tle, która łączy tę maszynę z Happier.',
            stopDaemonDescription: 'Trwające sesje działają dalej. Nowych nie da się uruchomić, dopóki nie uruchomisz go ponownie na tej maszynie.',
            stopDaemonAction: 'Zatrzymaj',
            detailsTitle: 'Szczegóły maszyny',
        },
    }) };

return { machineDetailPageTranslations };
})();

const Domain_machinePoolTranslations = (() => {
const en = Shared_machinePoolTranslations.en;

const pl = {
    machinesSection: "Maszyny",
    tierPrimaryDescription: "Próbowane jako pierwsze.",
    tierFallbackDescription: "Próbowane, gdy żadna wcześniejsza maszyna nie jest online.",
    pauseMember: "Wstrzymaj dla nowych sesji",
    resumeMember: "Używaj dla nowych sesji",
    pausedState: "Wstrzymana",
    memberMenu: "Opcje maszyny",
    newPoolTitle: "Nowa pula maszyn",
    title: "Pule maszyn",
    myTitle: "Moje pule maszyn",
    add: "Dodaj pulę maszyn",
    benefit: "Wybierz preferowaną maszynę, inne są dostępne jako rezerwowe.",
    placementChangeNotice: "Zmiany dotyczą sesji uruchomionych po zapisaniu. Otwarte sesje pozostają na swojej maszynie.",
    connectionSemantics: "Maszyna jest wybierana przy otwieraniu połączenia i pozostaje wybrana dla tego połączenia. Późniejsze połączenie może wybrać inną maszynę.",
    noMembers: "W tej puli nie ma jeszcze maszyn",
    unavailable: "Niedostępna",
    memberRevoked: "Odwołany",
    memberReplaced: "Wymieniony",
    memberTemporary: "Tymczasowy",
    availabilityUnknown: "Dostępność połączenia nieznana",
    notVerified: "Nie zweryfikowano",
    brokerUnavailable: "Brak dostępnego brokera",
    brokerAvailable: ({ count }: { count: number }) => `Dostępne: ${count}`,
    basics: "Bliższe dane",
    name: "Nazwa",
    description: "Opis (opcjonalnie)",
    descriptionTitle: "Opis",
    addMachines: "Dodaj maszyny",
    noMachines: "W tym Home nie ma dostępnych trwałych maszyn.",
    allMachinesAdded: "Wszystkie maszyny w tym Home są już w tej puli.",
    primary: "Podstawowy",
    addFallback: "Dodaj rezerwę",
    moveTo: "Przenieś do",
    moveTierEarlier: "Przenieś ten poziom wcześniej",
    moveTierLater: "Przenieś ten poziom później",
    removeMember: "Usuń z puli",
    enableMember: "Użyj do przyszłych wyborów",
    save: "Zapisz zmiany",
    create: "Utwórz pulę",
    delete: "Usuń pulę maszyn",
    deleteTitle: "Usunąć tę pulę maszyn?",
    deleteBody: "Wszelkie zasoby poświadczeń korzystające z tej puli utracą lokalizację brokera i będą wymagały naprawy. Wpłynie to na przyszłe wybory, ale nie usunie maszyn ani nie zatrzyma uruchomionych sesji.",
    saveFailed: "Nie udało się zapisać tej puli maszyn. Twoje zmiany nadal tu są.",
    deleteFailed: "Nie można usunąć tej puli maszyn. Spróbuj ponownie.",
    conflictTitle: "Pula ta uległa zmianie w innym miejscu",
    conflictBody: "Twoje niezapisane zmiany zostaną zachowane. Załaduj ponownie zapisaną wersję, aby przejrzeć najnowsze zmiany.",
    conflictNoReload: "Tożsamość puli nie jest już dostępna. Twoje niezapisane zmiany zostaną zachowane.",
    homeOffline: "Ten Home jest offline. Zmiany puli będą dostępne po ponownym połączeniu.",
    refreshFailed: "Nie można odświeżyć pul maszyn. Wyświetlana jest ostatnio znana lista.",
    featureUnavailable: "Pule maszyn są niedostępne na tym Home. Zaktualizuj lub włącz je na Home, aby kontynuować.",
    openSettings: "Ustawienia puli maszyn",
    pickSpecificMachine: "Wybierz konkretną maszynę",
    poolNotFound: "Ta pula maszyn nie jest już dostępna.",
    reload: "Załaduj ponownie zapisaną wersję",
    reloadTitle: "Odrzucić niezapisane zmiany?",
    reloadBody: "Ponowne załadowanie zastępuje ten formularz najnowszą zapisaną wersją.",
    privacy: "Serwer tego Home może odczytywać nazwy, opisy i skład pul, także na kontach z szyfrowaniem end-to-end.",
    nameRequired: "Wprowadź nazwę przed zapisaniem.",
    memberNotEligible: "Niektóre maszyny nie mogą już należeć do tej puli.",
    memberNotEligibleDetail: "Usuń tę maszynę lub wybierz inną stałą maszynę.",
    resolvingTarget: "Wybierając maszynę z tej puli…",
    resolveEmpty: "W tej puli nie ma włączonych maszyn.",
    resolveNoAvailable: "Żadna maszyna w tej puli nie jest obecnie dostępna.",
    resolvePresenceUnavailable: "Dostępność maszyny jest chwilowo nieznana.",
    resolveFailed: "Happier nie mógł wybrać maszyny z tej puli. Spróbuj ponownie.",
    executionMachine: "Uruchom na",
    chosenFrom: "Wybrany z",
    aMachinePool: "Pula maszyn",
    availabilityKnown: ({ connected, enabled }: { connected: number; enabled: number }) => `Połączono ${connected} z ${enabled} włączonych`,
    fallback: ({ number }: { number: number }) => `Zapasowa ${number}`,
};

const machinePoolTranslations = { pl };

return { machinePoolTranslations };
})();

const Domain_mcpSettingsTranslations = (() => {
type McpSettingsCopy = Shared_mcpSettingsTranslations.McpSettingsCopy;

const en = Shared_mcpSettingsTranslations.en;

const pl: McpSettingsCopy = {
    purpose: 'Serwery narzędzi, z których twoi agenci mogą korzystać w sesjach. Dodaj serwer raz, a potem wybierz, gdzie ma działać.',
    add: 'Dodaj serwer MCP',
    addConfigure: 'Skonfiguruj serwer',
    addConfigureDescription: 'Wpisz jego polecenie lub adres',
    addImportJson: 'Wklej konfigurację JSON',
    addImportJsonDescription: 'Z pliku README lub innej aplikacji',
    addOwnCategory: 'Dodaj własny',
    addPresetCategory: 'Szybka instalacja',
    addFromMachine: 'Importuj z tej maszyny',
    addFromMachineDescription: 'Serwery, których używają już inni agenci',
    searchPlaceholder: 'Szukaj serwerów',
    toolsGroup: 'Narzędzia',
    unbound: 'Jeszcze nigdzie nieużywany',
    newServer: 'Nowy serwer MCP',
    serverPurpose: 'Serwer narzędzi, z którego mogą korzystać twoi agenci. Poniżej wybierz, gdzie ma działać.',
    addByTitle: 'Dodaj przez',
    serverSection: 'Serwer',
    serverSectionDescription: 'Jak serwer nazywa się w sesjach i na tej liście.',
    connectionSection: 'Połączenie',
    connectionSectionDescription: 'Jak Happier uruchamia serwer lub łączy się z nim.',
    envDescription: 'Wartości przekazywane do serwera. Do kluczy używaj zapisanego sekretu.',
    headersDescription: 'Wysyłane z każdym żądaniem. Do tokenów używaj zapisanego sekretu.',
    addRule: 'Dodaj regułę',
    discardDraft: 'Odrzuć',
    landingTitle: 'Daj swoim agentom więcej narzędzi',
    landingDescription: 'Serwery MCP dodają narzędzia, takie jak przeglądarka, wyszukiwanie w dokumentacji czy GitHub. Skonfiguruj jeden, wklej konfigurację lub zacznij od gotowego ustawienia.',
    onMachineTitle: 'Znalezione na tej maszynie',
    onMachinePurpose: 'Serwery MCP, które inni agenci już konfigurują na tej maszynie. Zaimportuj jeden, aby używać go w Happier.',
    onMachineSearchSection: 'Gdzie szukać',
    onMachineSearchDescription: 'Konfiguracje agentów w folderze domowym oraz w folderze projektu, jeśli go wybierzesz.',
    onMachineFoundSection: 'Serwery',
    onMachineFoundDescription: 'Import kopiuje serwer do Happier; oryginalna konfiguracja się nie zmienia.',
    previewTitle: 'Co dostają sesje',
    previewPurpose: 'Sprawdź, które serwery MCP dostaje sesja dla danego agenta i folderu oraz co się dzieje, gdy któryś nie może się uruchomić.',
    previewContextSection: 'Sesja',
    previewContextDescription: 'Agent i folder, z którymi rozpoczęłaby się nowa sesja.',
    failurePolicyTitle: 'Gdy serwer nie może się uruchomić',
    failurePolicyDescription: 'Na przykład gdy brakuje potrzebnego zapisanego sekretu.',
    failurePolicySkip: 'Pomiń go',
    failurePolicyStop: 'Zatrzymaj sesję',
    failureSection: 'Niezawodność',
    failureSectionDescription: 'Dotyczy każdego serwera MCP w każdej sesji.',
    previewNothingTitle: 'Nic nie zostałoby dostarczone',
    previewNothingDescription: 'Żaden serwer MCP nie dotyczy tego agenta i folderu. Dodaj serwer lub regułę, która je obejmuje.',
    check: 'Sprawdź',
    scan: 'Szukaj',
};

const mcpSettingsTranslations = { pl } as const;

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

const pl: DesktopTrayTranslation = {
    open: 'Otwórz Happier',
    openInHappier: 'Otwórz w Happier',
    settings: 'Ustawienia…',
    startAtLogin: 'Uruchamiaj przy logowaniu',
    quit: 'Zakończ Happier',
    stopServicesAndQuit: 'Zatrzymaj usługi w tle i zakończ…',
    sessions: ({ count }: CountParams) => `aktywne: ${count}`,
    start: 'Uruchom',
    restart: 'Uruchom ponownie',
    stop: 'Zatrzymaj…',
    userOwned: 'Zarządzane poza Happier',
    checking: 'Sprawdzanie usług w tle…',
    readFailed: 'Nie udało się sprawdzić usług w tle',
    incomplete: 'Nie udało się sprawdzić niektórych usług w tle',
    noServices: 'Ten komputer nie jest jeszcze skonfigurowany',
    working: 'W toku…',
    stopConfirmTitle: ({ relay }: RelayParams) => `Zatrzymać usługę Happier w tle dla ${relay}?`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `Sesje agentów działające na tym komputerze dla ${relay} zostaną zakończone, a telefon i przeglądarka nie połączą się z nim tam, dopóki usługa nie uruchomi się ponownie.`,
    stopAllConfirmTitle: 'Zatrzymać usługi Happier w tle i zakończyć?',
    stopAllConfirmBody: 'Sesje agentów na tym komputerze zostaną zakończone, a telefon i przeglądarka nie połączą się z nim, dopóki jego usługi w tle nie uruchomią się ponownie.',
    stopConfirmAction: 'Zatrzymaj',
    actionFailedTitle: 'Nie udało się',
    loginItemFailed: 'Nie udało się zaktualizować elementu logowania Happier',
    quitStopTitle: 'Sesje agentów nadal działają',
    quitStopBody: 'Zakończenie zatrzymuje usługi w tle tego komputera i kończy działające tu sesje.',
    quitStopUnknownTitle: 'Zatrzymać usługi w tle?',
    quitStopUnknownBody: 'Happier nie widzi, które sesje działają na tym komputerze. Zakończenie zatrzymuje jego usługi w tle i kończy te, które działają.',
    quitStopConfirm: 'Zatrzymaj mimo to',
    quitStopKeep: 'Pozostaw uruchomione',
    quitStopFailedTitle: 'Niektóre usługi w tle nie zostały zatrzymane',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier pozostaje otwarty, aby można było sprawdzić usługi w tle i spróbować ponownie.`,
};

const plLoginStart: DesktopLoginStartTranslation = {
    title: 'Uruchamiaj przy logowaniu',
    subtitle: 'Utrzymuje ten komputer dostępny z telefonu i przeglądarki: jego usługi w tle uruchamiają się przy logowaniu i działają po zamknięciu Happier. Gdy ta opcja jest wyłączona, zamknięcie Happier je zatrzymuje.',
    unknown: 'Happier nie wie jeszcze, czy usługi w tle tego komputera uruchamiają się przy logowaniu.',
    notSetUp: 'Dostępne po skonfigurowaniu tego komputera.',
};

const menuBarModeTranslations = { pl: { tray: pl, loginStart: plLoginStart } };

return { menuBarModeTranslations };
})();

const Domain_nativePasswordTranslations = (() => {
const nativePasswordTranslations = { pl: {
        email: 'E-mail',
        password: 'Hasło',
        signIn: 'Zaloguj się',
        title: 'E-mail i hasło',
        forgotPassword: 'Nie pamiętasz hasła?',
        capsLock: 'Caps Lock jest włączony',
        emailRequired: 'Wpisz swój adres e-mail.',
        passwordRequirements: 'Użyj co najmniej 15 znaków, maksymalnie 1024 bajtów UTF-8. Spacje są dozwolone.',
        unavailable: 'Logowanie za pomocą e-maila i hasła jest niedostępne w tym Home.',
        rateLimited: 'Zbyt wiele prób. Poczekaj chwilę i spróbuj ponownie.',
        emailInvalid: 'Wpisz prawidłowy adres e-mail.',
        passwordMalformed: 'To hasło zawiera znaki, których nie możemy bezpiecznie zapisać. Wpisz je ponownie.',
        passwordMismatch: 'Hasła nie są takie same.',
        currentPasswordRequired: 'Wpisz swoje obecne hasło.',
        currentPassword: 'Obecne hasło',
        newPassword: 'Nowe hasło',
        confirmPassword: 'Potwierdź hasło',
        signInFailed: 'Ta kombinacja e-maila i hasła nie zadziałała.',
        accountDisabledHere: 'To konto jest wyłączone w tym Home. Poproś administrację Home o ponowne włączenie.',
        notEligible: 'To konto nie może teraz zalogować się do tego Home.',
        linkExpired: 'Ten link wygasł lub został już użyty. Poproś o nowy.',
        revisionConflict: 'Twoje hasło zmieniło się w innym miejscu. Odśwież i spróbuj ponownie.',
        serverUnavailable: 'Ten Home nie mógł zrealizować żądania. Spróbuj ponownie za chwilę.',
        offline: 'Brak połączenia z tym Home. Sprawdź sieć i spróbuj ponownie.',
        homeUnreachable: 'Nie udało się połączyć z tym Home. Spróbuj ponownie.',
        securityFactUnavailable: 'Nie udało się tego odczytać z Twojego Home.',
        cancelled: 'Ta próba została anulowana.',
        approvalPending: 'Oczekuje na Twoją zgodę. Sprawdź ją w skrzynce zatwierdzeń, a potem wróć tutaj.',
        outcomeUnconfirmed: 'Nie udało się potwierdzić, czy zmiana została zastosowana. Odświeżyliśmy to konto — sprawdź je przed ponowną próbą.',
        recoveryKeyRequired: 'Wpisz swÃ³j klucz odzyskiwania, aby zmienić hasło tego konta szyfrowanego end-to-end. Klucz pozostaje na tym urządzeniu.',
        working: 'Trwa przetwarzanie…',
        showPassword: 'Pokaż hasło',
        hidePassword: 'Ukryj hasło',
        createTitle: 'Utwórz konto',
        createAccount: 'Utwórz konto',
        accountProtection: 'Ochrona konta',
        protectionPlain: 'Czytelne dla Home',
        protectionPlainDetail: 'Twój Home może odczytywać Twoje dane. Jeśli zapomnisz hasła, zresetujesz je e-mailem.',
        protectionE2ee: 'Szyfrowanie end-to-end',
        protectionE2eeDetail: 'Tylko Twoje urządzenia mogą odczytać Twoje dane. Zapisz klucz odzyskiwania: samo zresetowanie hasła ich nie przywróci.',
        checkYourEmail: 'Sprawdź swoją skrzynkę',
        resend: 'Wyślij ponownie',
        resent: 'Wysłano ponownie. Sprawdź swoją pocztę.',
        useDifferentEmail: 'Użyj innego adresu',
        connectTitle: 'Dodaj e-mail i hasło',
        connectFromSecurity: 'Zaloguj się metodą, której już używasz, a następnie dodaj e-mail i hasło w Bezpieczeństwie konta.',
        signInFirst: 'Najpierw zaloguj się',
        forgotTitle: 'Nie pamiętasz hasła?',
        forgotExplanation: 'Możemy wysłać instrukcje e-mailem albo możesz użyć klucza odzyskiwania zapisanego przy tworzeniu konta.',
        emailResetInstructions: 'Wyślij mi instrukcje e-mailem',
        useRecoveryKey: 'Użyj klucza odzyskiwania',
        recoveryKeyDownload: 'Pobierz klucz odzyskiwania',
        recoveryKeyLater: 'Zrób to później',
        securitySectionTitle: 'E-mail i hasło',
        signInEmail: 'E-mail logowania',
        signInEmailNotSet: 'Nie ustawiono',
        passwordEnrolled: 'Skonfigurowane',
        passwordNotEnrolled: 'Nieskonfigurowane',
        passwordSetUp: 'Twoje hasło jest skonfigurowane dla tego Home.',
        passwordChanged: 'Twoje hasło zostało zmienione.',
        passwordRemoved: 'Twoje hasło zostało usunięte.',
        changePassword: 'Zmień hasło',
        removePassword: 'Usuń hasło',
        removePasswordSubtitle: 'Loguj się tylko innymi metodami',
        removePasswordConsequence: 'E-mail i hasło nie będą już logować Cię do tego Home. Pozostałe metody i Twoje dane pozostają bez zmian.',
        changeEmailExplanation: 'Wyślemy e-mail na nowy adres, aby go potwierdzić. Obecny adres działa do czasu potwierdzenia.',
        sendVerification: 'Wyślij e-mail potwierdzający',
        verifyTitle: 'Potwierdź swój e-mail',
        verifyGeneric: 'Ten link potwierdza kontrolę nad skrzynką pocztową.',
        verifyReturnToCreate: 'Wróć do tego Home, aby dokończyć tworzenie konta z tym adresem.',
        addressVerified: 'Ten adres został potwierdzony.',
        confirmEmailChange: 'Ustaw jako mój e-mail logowania',
        signInToConfirm: 'Zaloguj się na tym urządzeniu, aby potwierdzić zmianę.',
        returnToSignIn: 'Wróć do logowania',
        continue: 'Dalej',
        resetTitle: 'Ustaw nowe hasło',
        resetChooseNew: 'Wybierz nowe hasło do tego Home.',
        resetComplete: 'Twoje hasło zostało zmienione. Zaloguj się ponownie nowym hasłem.',
        resetSignsOutOtherDevices: 'Ustawienie nowego hasła wylogowuje to konto wszędzie indziej.',
        setNewPassword: 'Zapisz nowe hasło',
        emailPlaceholder: 'ty@przyklad.pl',
        accountDisabled: ({ home }: { home: string }) => `To konto jest wyłączone w ${home}. Poproś administrację Home o ponowne włączenie.`,
        verificationSent: ({ email }: { email: string }) => `Wysłaliśmy link potwierdzający na ${email}. Otwórz go, aby dokończyć tworzenie konta.`,
        resetInstructionsSent: ({ email }: { email: string }) => `Jeśli ${email} może się tu zalogować, instrukcje resetu są już w drodze.`,
        verificationPending: ({ email }: { email: string }) => `Potwierdzenie wysłane na ${email}`,
        verifyDestination: ({ email }: { email: string }) => `Ten link potwierdza ${email}.`,
        passwordNeedsEmail: 'Najpierw dodaj e-mail logowania',
        passwordNeedsEmailHint: 'Zaczyna się od e-maila logowania',
        setupStepConfirm: 'Potwierdź',
        setupProgress: ({ step, total, label }: { step: number; total: number; label: string }) => `Krok ${step} z ${total}: ${label}`,
        setupEmailHint: 'E-mail logowania i hasło dodaje się razem. Najpierw wyślemy link, aby potwierdzić adres.',
        setupConfirmHint: 'Otwórz link z tego e-maila, aby wybrać hasło.',
        setupPasswordHint: 'Wpisz potwierdzony e-mail, a następnie wybierz hasło.',
    } } as const;

return { nativePasswordTranslations };
})();

const Domain_navigationPlacementTranslations = (() => {
type NavigationPlacementTranslation = Shared_navigationPlacementTranslations.NavigationPlacementTranslation;

const navigationPlacementTranslations = { pl: { customize: 'Dostosuj…', title: 'Nawigacja', description: 'Wybierz, co jest widoczne, trafia do Więcej lub jest ukryte. Przeciągnij, aby zmienić kolejność. Zapisano na tym urządzeniu.', pinned: 'Przypięte', overflow: 'Więcej', hidden: 'Ukryte', reset: 'Resetuj', appRail: 'Lewy pasek', sessionRail: 'Pasek sesji', workspaceRail: 'Pasek obszaru roboczego', sessionTabBar: 'Karty telefonu' } } satisfies Pick<Record<string, NavigationPlacementTranslation>, "pl">;

return { navigationPlacementTranslations };
})();

const Domain_pendingNavigationTranslations = (() => {
type Count = Shared_pendingNavigationTranslations.Count;

const en = Shared_pendingNavigationTranslations.en;

const pl: typeof en = {
    nextWithCount: ({ count }) => `${count} ${count === 1 ? 'czeka' : 'czekają'} na Ciebie`,
    next: 'Dalej', answeredElsewhere: 'Już odpowiedziano',
    unavailableTitle: 'Nie udało się otworzyć następnej prośby',
    unavailableBody: 'Niektóre oczekujące sesje są niedostępne. Połącz się ponownie i spróbuj jeszcze raz.',
    skippedUnavailable: ({ count }) => `Pominięto niedostępne sesje: ${count}.`,
    waitsForPermission: 'prosi o Twoją zgodę', waitsForInput: 'czeka na Twoją odpowiedź',
    sessionsWaiting: ({ count }) => `Czekające sesje: ${count}`, go: 'Przejdź', dismiss: 'Nie teraz',
};

const pendingNavigationTranslations = { pl };

return { pendingNavigationTranslations };
})();

const Domain_personalHomeBootstrapBlockedTranslations = (() => {
type PersonalHomeBootstrapBlockedTranslation = Shared_personalHomeBootstrapBlockedTranslations.PersonalHomeBootstrapBlockedTranslation;

const personalHomeBootstrapBlockedTranslations = { pl: {
        blocked: {
            runtime_unhealthy: 'Twój lokalny Home wymaga uwagi, zanim będzie mógł się uruchomić.',
            home_auth_invalid: 'Uwierzytelnianie Twojego Home wymaga uwagi.',
            existing_runtime: 'Zanim konfiguracja będzie kontynuowana, musisz zdecydować, co zrobić z istniejącym lokalnym Home.',
            existing_runtime_credentials: 'Ten lokalny Home należy do innej aplikacji Happier na tym komputerze.',
            personal_home_erased: 'Twój osobisty Home został usunięty. Spróbuj ponownie, aby utworzyć nowy.',
        },
        blockedBody: { personal_home_erased: 'Dane Twojego Home zostały usunięte. Nie ma tu nic do odzyskania — utwórz nowy osobisty Home albo użyj innego Home.' },
    } } as const satisfies Pick<Record<string, PersonalHomeBootstrapBlockedTranslation>, "pl">;

return { personalHomeBootstrapBlockedTranslations };
})();

const Domain_personalHomeDecisionTranslations = (() => {
type HomeParams = Shared_personalHomeDecisionTranslations.HomeParams;

type PersonalHomeDecisionTranslation = Shared_personalHomeDecisionTranslations.PersonalHomeDecisionTranslation;

const en = Shared_personalHomeDecisionTranslations.en;

const pl: PersonalHomeDecisionTranslation = {
    homeIdentityAmbiguous: 'Ten adres osobistego Home odpowiada więcej niż jednemu zapisanemu Home.',
    signedInHome: {
        status: 'Jesteś już zalogowany w innym Home.',
        body: ({ home }: HomeParams) => `Ten komputer jest zalogowany w ${home}. Korzystaj z niego dalej albo skonfiguruj tutaj osobisty Home.`,
        keep: ({ home }: HomeParams) => `Dalej używaj ${home}`,
        keepDetail: 'Twoje sesje i maszyny pozostaną dokładnie takie, jakie są.',
        create: 'Skonfiguruj osobisty Home',
        createDetail: 'Utwórz prywatny Home na tym komputerze i przełącz się na niego.',
    },
    existingRuntimeCredentials: {
        body: 'Ta aplikacja nie może go otworzyć bez klucza odzyskiwania tego Home. Zaloguj się kluczem albo użyj innego Home.',
        signIn: 'Zaloguj się kluczem odzyskiwania',
        signInDetail: 'Użyj klucza odzyskiwania zapisanego dla tego lokalnego Home.',
    },
};

const personalHomeDecisionTranslations = { pl };

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

const pl = {
    standardOnlyTitle: 'Tylko standardowe połączenie',
    standardOnlySubtitle: 'Nowe połączenia na tym urządzeniu używają tras standardowych. Trwające transfery kończą się na bieżącej trasie.',
    installOrUpdateAction: 'Zainstaluj lub zaktualizuj osobisty Home', startAction: 'Uruchom osobisty Home', stopAction: 'Zatrzymaj osobisty Home',
    defaultHomeLabel: 'Osobisty Home', homeTitle: 'Home', canonicalAddress: 'Adres Home', identityComparison: 'Bieżący Home', identityComparisonMatch: 'Zgodny', identityComparisonMismatch: 'Niezgodny', identityComparisonUnknown: 'Nie udało się potwierdzić',
    unknownSize: 'Nieznany rozmiar', unknownTimestamp: 'Nieznacznik czasu', restoreBackupTitle: 'Kopia zapasowa', identityTitle: 'Tożsamość Home', identityUnavailable: 'Tożsamość niedostępna', restoreBackupDate: 'Utworzono', restoreCompatibility: 'Zgodność', restoreCompatible: 'Zgodna', restoreCompatibilityVerified: 'Zweryfikowano w tej wersji', restoreBackupSize: 'Rozmiar', restoreReplacementNotice: 'Bieżące dane Home zostaną zastąpione. Zweryfikowana kopia odzyskiwania zostanie zachowana.', restoreConfirmTitle: 'Zastąpić i przywrócić ten osobisty Home?', restoreConfirmAction: 'Zastąp i przywróć', relocateConfirmTitle: 'Przenieść ten osobisty Home?', relocateConfirmBody: 'Bieżący Home zostanie zatrzymany, zanim jego zweryfikowana kopia stanie się aktywna w miejscu docelowym.', relocateDestination: 'Miejsce docelowe', relocateConfirmAction: 'Przenieś Home', recoverRestoreTitle: 'Odzyskać przerwane przywracanie?', recoverRestoreBody: 'Cofnij przerwane przywracanie przy użyciu zachowanych danych odzyskiwania.', recoverRestoreAction: 'Odzyskaj przywracanie', eraseDataTitle: 'Usunąć dane osobistego Home?', eraseHomeTarget: 'Home', eraseDataBody: 'To działanie jest niezależne od odinstalowania i trwale usuwa tylko te rozpoznane ścieżki Home:', estimatedSize: 'Szacowany rozmiar', summaryTitle: 'Osobisty Home', footer: 'Twój Home pozostaje na tym komputerze. Te działania nie zmieniają innego Home.', statusTitle: 'Stan', notAvailable: 'Niedostępne', storageTitle: 'Pamięć', masterSecretTitle: 'Sekret dostępu Home', masterSecretPresent: 'Obecny', masterSecretUnavailable: 'Niedostępne', inspectAction: 'Odśwież szczegóły Home', actionsTitle: 'Kopia i przywracanie', protectionTitle: 'Ochrona', backupsSectionFooter: 'Kopie zawierają czytelne rozmowy, dane Home, stan zaufanych urządzeń i sekret dostępu Home. Przechowuj je tylko w zaufanej lokalizacji.', lastBackupTitle: 'Ostatnia kopia', lastBackupUnknown: 'Ostatnia kopia nieznana', backupsTitle: 'Archiwa kopii', backupAction: 'Utwórz kopię teraz', backupSubtitle: 'Tworzy i weryfikuje jawne archiwum Home.', exportBackupAction: 'Eksportuj kopię…', exportBackupSubtitle: 'Tworzy zweryfikowaną kopię w wybranej lokalizacji.', verifyAction: 'Zweryfikuj kopię…', verifySubtitle: 'Sprawdza archiwum bez przywracania go.', restoreAction: 'Przywróć…', restoreSubtitle: 'Weryfikuje kopię przed zastąpieniem danych Home.', relocateAction: 'Przenieś Home…', relocateSubtitle: 'Przenieś ten Home na zarządzany komputer.', relocationFinishAction: 'Zakończ przenoszenie', relocationReturnAction: 'Wróć do oryginalnego Home', relocationFinishSubtitle: 'Zakończ przenoszenie Home po zweryfikowaniu miejsca docelowego.', relocationReturnSubtitle: 'Zachowaj oryginalny Home jako aktywną lokalizację.', recoverRestoreSubtitle: 'Przerwane przywracanie można jawnie cofnąć.', restoreRecoveryWarningTitle: 'Przywracanie wymaga naprawy', restoreRecoveryWarningBody: 'Stan odzyskiwania jest niejednoznaczny. Nie zostanie wykonana automatyczna zmiana. Przejrzyj diagnostykę przed naprawą tego Home.', restoreCleanupWarningTitle: 'Czyszczenie po przywracaniu wymaga uwagi', restoreCleanupWarningBody: 'Home został przywrócony, ale automatyczne czyszczenie nie zostało ukończone. Sprawdź diagnostykę i ponów operację Home.', backupVerified: 'Kopia zweryfikowana', backupNeedsAttention: 'Kopia zweryfikowana; ponowne uruchomienie Home wymaga uwagi', backupHomeReady: 'Home uruchomiony ponownie', backupRevealAction: 'Pokaż kopię', restoreResultTitle: 'Wynik przywracania', restoreOutcomeRecoveryRequired: 'Wymagane odzyskanie', restoreOutcomeRolledBack: 'Przywracanie cofnięte', restoreOutcomeRestored: 'Home przywrócony', advancedTitle: 'Zaawansowane', advancedFooter: 'Sterowanie runtime i diagnostyka tego komputera.', restartAction: 'Uruchom ponownie osobisty Home', openDataLocationAction: 'Otwórz lokalizację danych Home', openLogsAction: 'Otwórz dzienniki runtime', removeProfileAction: 'Usuń Home z Happier', removeProfileSubtitle: 'Usuwa ten profil; dane runtime pozostają na tym komputerze.', removeProfileTitle: 'Usunąć profil osobistego Home?', removeProfileBody: 'Profil zostanie usunięty, ale runtime i dane pozostaną.', uninstallRuntimeAction: 'Odinstaluj runtime, zachowaj dane', uninstallRuntimeSubtitle: 'Usuwa usługę i pliki binarne; dane Home zostają zachowane.', deleteHomeDataTitle: 'Usuń dane Home', removeSectionFooter: 'Odinstalowanie zachowuje dane Home. Trwałe usunięcie to osobne potwierdzone działanie.', eraseDataAction: 'Trwale usuń dane osobistego Home', eraseDataSubtitle: 'Niezależne od odinstalowania. Trwale usuwa rozpoznane dane Home.', eraseResultTitle: 'Dane Home usunięte', eraseStoppedHome: 'Działający Home został zatrzymany', eraseHomeAlreadyStopped: 'Home był już zatrzymany', eraseRemainingPaths: 'Nie udało się usunąć', progressTitle: 'Operacja osobistego Home', dismissResult: 'Odrzuć',
    repairSearchAction: 'Odbuduj wyszukiwanie Home',
    repairSearchSubtitle: 'Odtwarza indeks wyszukiwania na podstawie rozmów w tym Home.',
    repairSearchCompleteTitle: 'Wyszukiwanie Home odbudowane',
    repairSearchCompleteBody: 'Indeks wyszukiwania został odtworzony na podstawie rozmów w tym Home.',
    backupCleanupRequired: 'Kopia zapasowa jest bezpieczna; usuń chronioną ścieżkę przejściową wskazaną w szczegółach',
    backupCleanupPath: 'Chroniona ścieżka przejściowa do usunięcia',
    backupCleanupError: 'Błąd czyszczenia',
    backupDestinationMismatch: 'Kopia zapasowa nie została utworzona w wybranym miejscu docelowym. Nic nie zostało usunięte.',
    backupDestinationUnsafe: 'Wybrane miejsce docelowe kopii zapasowej znajduje się wewnątrz danych osobistego Home, które zostałyby usunięte. Nic nie zostało usunięte.',
    eraseInspectionAttention: 'Dane Home usunięte; weryfikacja wymaga uwagi',
    searchTitle: 'Wyszukiwanie',
    searchReady: 'Gotowe',
    searchIndexing: 'Indeksowanie…',
    searchUnavailable: 'Niedostępne',
    localOnlyIngressTitle: 'Osiągalny tylko z tego komputera',
    localOnlyIngressBody: 'Udostępnienia publiczne, wywołania zwrotne dostawców, webhooki wtyczek i powiadomienia, gdy ten komputer śpi, pozostają niedostępne, dopóki ten Home nie będzie osiągalny z zewnątrz.',
} satisfies PersonalHomeSettingsCopy;

const backupDisclosureBody = { pl: 'Ta kopia zawiera czytelne rozmowy, dane Home, sekret dostępu do Home i stan zaufanych urządzeń. Każda osoba, która może odtworzyć pełne archiwum, może uruchomić klon tego Home. Zapisz ją w zaufanym miejscu.' } as const;

const eraseBackupOffer = { pl: { title: 'Najpierw utworzyć kopię tego Home?', body: 'Usunięcia danych Home nie można cofnąć. Najpierw utwórz zweryfikowaną kopię albo kontynuuj bez niej.', continueWithoutBackup: 'Kontynuuj bez kopii' } } as const;

const operationOutcome = { pl: {
        erasePartialTitle: 'Nie udało się usunąć części danych Home',
        eraseOutcomeSummary: ({ removed, remaining }) => `Usunięto ${removed} ${pluralPl(removed, 'element', 'elementy', 'elementów')}`
            + (remaining > 0 ? `; nie udało się usunąć ${remaining} ${pluralPl(remaining, 'elementu', 'elementów', 'elementów')}` : ''),
        eraseNotPerformed: 'Nic nie zostało usunięte',
        eraseBlockedBackupMismatch: 'Ta kopia pochodzi z innego Home.',
        eraseBlockedIdentityUnknown: 'Happier nie mógł potwierdzić, że ta kopia pochodzi z tego Home.',
        eraseVerificationDetail: 'Weryfikacja',
        operationFailed: 'Ta operacja Home nie została ukończona. Otwórz Szczegóły, aby zobaczyć, co się stało.',
        restorePreviousDataTitle: 'Poprzednie dane zapisane',
    } } as const satisfies Pick<Record<string, OperationOutcomeCopy>, "pl">;

const personalHomeSettingsTranslations = { pl: { ...pl, ...operationOutcome.pl, backupDisclosureBody: backupDisclosureBody.pl, eraseBackupOfferTitle: eraseBackupOffer.pl.title, eraseBackupOfferBody: eraseBackupOffer.pl.body, eraseContinueWithoutBackup: eraseBackupOffer.pl.continueWithoutBackup } } as const;

return { backupDisclosureBody, eraseBackupOffer, operationOutcome, personalHomeSettingsTranslations };
})();

const Domain_personalizeTranslations = (() => {
type PersonalizeTranslation = Shared_personalizeTranslations.PersonalizeTranslation;

const en = Shared_personalizeTranslations.en;

const pluralPl = Shared_personalizeTranslations.pluralPl;

const pluralRu = Shared_personalizeTranslations.pluralRu;

const pl: PersonalizeTranslation = {
    cardTitle: 'Personalizuj Happier',
    cardSubtitle: 'Sześć szybkich wyborów, każdy z podglądem na żywo.',
    cardAction: 'Personalizuj',
    cardContinue: 'Kontynuuj',
    cardProgress: ({ saved, total, step }) => `Zapisane wybory: ${saved} z ${total}. Wróć do kroku „${step}”.`,
    cardProgressReview: ({ saved, total }) => `Zapisane wybory: ${saved} z ${total}. Przejrzyj swoją konfigurację.`,
    inPlaceTitle: 'Dopasuj Happier do siebie',
    inPlaceBody: 'Sześć szybkich wyborów, każdy z podglądem na żywo. Zacznij od wyglądu — Home zmienia się w trakcie wybierania.',
    inPlaceContinue: ({ count }) => `Kontynuuj · jeszcze ${count}`,
    notNow: 'Nie teraz',
    flowTitle: 'Personalizuj Happier',
    finishLater: 'Dokończ później',
    later: 'Później',
    stepEyebrow: ({ n, total, name }) => `Krok ${n} z ${total} · ${name}`,
    stepCounter: ({ n, total }) => `${n} z ${total}`,
    styleEyebrow: 'Opcjonalnie',
    summaryEyebrow: 'Gotowe',
    previewNote: 'Podgląd. Nic nie zostanie zapisane, dopóki nie naciśniesz Dalej.',
    previewNoteSummary: 'Twoja przestrzeń robocza w obecnym stanie.',
    next: 'Dalej',
    review: 'Przejrzyj',
    useThisSetup: 'Użyj tej konfiguracji',
    saveFailed: 'Ten krok nie został zapisany. Twój wybór jest nadal zaznaczony.',
    tryAgain: 'Spróbuj ponownie',
    skipThisStep: 'Pomiń ten krok',
    scopeThisDevice: 'To urządzenie',
    scopeAllDevices: 'Wszystkie Twoje urządzenia',
    stepsLabel: 'Kroki',
    savedStepsNote: ({ count }) => pluralPl(count, '1 krok jest już zapisany.', `${count} kroki są już zapisane.`, `${count} kroków jest już zapisanych.`),
    lookName: 'Wygląd',
    lookTitle: 'Zadbaj o wygodę',
    lookDescription: 'Jasny, ciemny lub zgodny z systemem, a także ile szkła pokazuje aplikacja.',
    themeLabel: 'Motyw',
    glassLabel: 'Szkło',
    glassAutoDescription: 'Szkło w całej aplikacji, warstwowo',
    glassEverywhereDescription: 'Jednolite szkło wszędzie',
    glassSolidDescription: 'Wszystkie powierzchnie nieprzezroczyste',
    glassCustomNote: 'Szkło zostało dostosowane w ustawieniach Wygląd. Wybierz ustawienie wstępne, aby je zastąpić, lub zachowaj swoje.',
    customizeInAppearance: 'Dostosuj w ustawieniach Wygląd…',
    styleName: 'Styl',
    styleTitle: 'Zacznij od stylu',
    styleDescription: 'Każdy styl określa, jak czyta się sesje i jak wygląda lista. Wypełnia tylko kolejne kroki: nic nie zostanie zapisane, dopóki nie naciśniesz Dalej w każdym z nich.',
    styleKeep: 'Zachowaj moją obecną konfigurację',
    styleActivity: 'Aktywność',
    styleConversation: 'Rozmowa',
    styleDetail: 'Szczegóły',
    styleCustomTag: 'Własny',
    styleDefaultTag: 'Domyślny w Happier',
    styleChanges: ({ style, count }) => `${style} zmienia ${pluralPl(count, '1 ustawienie', `${count} ustawienia`, `${count} ustawień`)}`,
    styleNoChanges: 'To już jest Twoja konfiguracja.',
    styleNever: 'Motyw, powiadomienia, prywatność i uprawnienia agentów nigdy nie są częścią stylu.',
    was: ({ value }) => `wcześniej: ${value}`,
    conversationName: 'Rozmowa',
    conversationTitle: 'Śledź rozmowę',
    conversationDescription: 'Jak wyglądają tury sesji i myślenie agenta.',
    layoutLabel: 'Układ',
    thinkingLabel: 'Myślenie',
    toolsName: 'Wywołania narzędzi',
    toolsTitle: 'Zobacz, co zrobił agent',
    toolsDescription: 'Jak polecenia, edycje i odczyty pojawiają się w sesji.',
    toolsLabel: 'Wywołania narzędzi',
    toolTapLabel: 'Kliknięcie narzędzia',
    toolDetailLabel: 'Szczegóły narzędzi',
    toolDetailDefault: 'Domyślne',
    toolDetailFull: 'Pełne',
    workName: 'Twoja praca',
    workTitle: 'Znajdź swoją pracę',
    workDescription: 'Jak uporządkowana jest lista sesji i ile pokazuje każdy wiersz.',
    listLayoutLabel: 'Lista sesji',
    rowsLabel: 'Wiersze',
    attentionName: 'Uwaga',
    attentionTitle: 'Zauważ, co na Ciebie czeka',
    attentionDescription: 'Gdzie na liście są sesje, które na Ciebie czekają lub są gotowe do przejrzenia.',
    attentionLabel: 'Sesje, które na Ciebie czekają',
    attentionHomeNote: 'Home zawsze pokazuje, co na Ciebie czeka. To zmienia tylko listę sesji.',
    notificationsName: 'Powiadomienia',
    notificationsTitle: 'Bądź na bieżąco',
    notificationsDescription: 'O czym to urządzenie Cię informuje, gdy patrzysz na coś innego.',
    notificationsAllowed: 'Powiadomienia są dozwolone na tym urządzeniu.',
    notificationsNotAllowed: 'Happier nie może jeszcze wyświetlać powiadomień na tym urządzeniu.',
    notificationsUnsupported: 'Powiadomienia nie są dostępne na tym urządzeniu. Skonfiguruj je w aplikacji komputerowej lub na telefonie.',
    scopeLook: 'Motyw na tym urządzeniu · szkło na wszystkich urządzeniach',
    notificationsNeedsYouSummary: 'Potrzebuje Cię',
    notificationsFinishedSummary: 'Zakończono',
    notificationsAllow: 'Zezwól na powiadomienia',
    notificationsTellMe: 'Powiadamiaj mnie, gdy',
    notificationsNeedsYou: 'Sesja potrzebuje zatwierdzenia lub odpowiedzi',
    notificationsFinished: 'Sesja kończy swoją turę',
    notificationsShowLabel: 'Powiadomienia pokazują',
    notificationsShowDescription: 'Polecenia, pytania i odpowiedzi mogą pojawiać się na ekranie blokady.',
    notificationsMessage: 'Wiadomość',
    notificationsStatus: 'Tylko status',
    notificationsPhoneNote: 'Alerty na telefonie, gdy Happier jest zamknięty, ustawia się na telefonie.',
    notificationsOff: 'Bez powiadomień',
    sampleNeedsYouTitle: 'Przegląd #2481 czeka na Ciebie',
    sampleNeedsYouBody: 'Agent chce uruchomić yarn test:e2e w ~/happier. Zezwolić?',
    sampleReadyTitle: '„Napraw niestabilny test ponownego łączenia” jest gotowe',
    sampleReadyBody: 'Mam to: licznik ponowień nigdy nie był czyszczony. Naprawione, test przechodzi.',
    sampleStatusBody: 'Otwórz Happier, aby zobaczyć.',
    sampleSessionReconnect: 'Napraw niestabilny test ponownego łączenia',
    sampleSessionCraft: 'Laboratorium szlifów',
    sampleSessionReview: 'Przegląd #2481',
    sampleSessionPricing: 'Teksty strony z cennikiem',
    sampleSessionDocs: 'Indeks wyszukiwania dokumentacji',
    sampleWorking: 'Pracuje',
    sampleNeedsYou: 'Czeka na Ciebie',
    sampleReady: 'Gotowe do przejrzenia',
    summaryTitle: 'Oto Twoja konfiguracja',
    summaryDescription: ({ changed }) => changed === 0
        ? 'Wszystko poniżej jest już zapisane. Nic się nie zmieniło.'
        : `Wszystko poniżej jest już zapisane. ${pluralPl(changed, 'Zmienił się jeden wybór', `Zmieniły się ${changed} wybory`, `Zmieniło się ${changed} wyborów`)}; reszta pozostała bez zmian.`,
    summaryChange: 'Zmień',
    summaryFooter: 'Wszystko to możesz później zmienić w Ustawieniach lub przejść ponownie z Ustawienia → Wygląd.',
    replayTitle: 'Personalizuj Happier',
    replaySubtitle: 'Sześć szybkich wyborów, każdy z podglądem na żywo.',
    replayAction: 'Rozpocznij',
    journeyHandoff: 'Dopasuj do siebie',
};

const personalizeTranslations = { pl } satisfies Pick<Readonly<Record<string, PersonalizeTranslation>>, "pl">;

return { personalizeTranslations };
})();

const Domain_phoneNavigationTranslations = (() => {
const en = Shared_phoneNavigationTranslations.en;

const pl: typeof en = {
    phoneNav: {
        settings: {
            sectionDescription: 'Układ telefonu wewnątrz sesji i gesty na jego pasku. Każdy gest można wyłączyć osobno.',
            swipeSidewaysTitle: 'Przesuń w bok, aby zmienić sesję',
            swipeSidewaysScrollsDescription: 'Poprzednia lub następna, na pasku. Gdy narzędzia się nie mieszczą, przesuwanie przewija je.',
            swipeSidewaysAlwaysDescription: 'Poprzednia lub następna, na pasku. Zostaje przesunięciem; narzędzia, które się nie mieszczą, czekają w Więcej.',
            alwaysSwipeTitle: 'Zawsze przesuwaj między sesjami',
            alwaysSwipeOnDescription: 'Pasek zachowuje narzędzia, które się mieszczą; reszta czeka w Więcej.',
            alwaysSwipeOffDescription: 'Wyłączone: dodatkowe narzędzia sprawiają, że pasek się przewija.',
            dragUpTitle: 'Przeciągnij w górę, aby przełączyć',
            dragUpDescription: 'Przeciągnij pasek w górę, aby zobaczyć otwarte karty i ostatnie sesje, a potem zsuń się do jednej z nich.',
            dragUpSourceTitle: 'Przeciągnięcie w górę pokazuje',
            dragUpSourceRecentDescription: 'Otwarte karty, potem to, co ostatnio otwarto na tym urządzeniu.',
            dragUpSourceListDescription: 'Sesje w kolejności z listy.',
            swipeSourceTitle: 'Przesunięcie w bok pokazuje',
            swipeSourceListDescription: 'Następną lub poprzednią sesję z Twojej listy.',
            swipeSourceRecentDescription: 'Następną lub poprzednią według tego, kiedy ostatnio ją otwarto.',
            sourceRecent: 'Ostatnie',
            sourceList: 'Lista sesji',
            flickTitle: 'Machnij w górę lub w dół, aby przełączyć',
            flickDescription: 'Szybkie machnięcie otwiera następną lub poprzednią.',
            holdToDockTitle: 'Przytrzymaj, aby zostawić przełącznik otwarty',
            holdToDockDescription: 'Przytrzymaj pasek i puść, aby wybrać dotknięciem.',
            pullAllTabsTitle: 'Pociągnij tytuł w dół, aby zobaczyć wszystkie karty',
            pullAllTabsDescription: 'Przeciągnij tytuł sesji w dół, aby zobaczyć każdą otwartą kartę i ostatnią sesję.',
        },
        bar: {
            onTheBar: 'Na pasku',
            more: 'Więcej',
            heldInMore: 'W Więcej, gdy „Zawsze przesuwaj” jest włączone',
            keepOnBar: 'Zostaw na pasku',
            removeFromBar: 'Usuń z paska',
            openFiles: 'Otwórz pliki',
        },
        allTabs: {
            title: 'Wszystkie karty',
            pullHint: 'Pociągnij, aby zobaczyć wszystkie karty',
            releaseHint: 'Puść, aby zobaczyć wszystkie karty',
            openTabs: 'Otwarte karty',
            openTabsSynced: 'Otwarte karty · zsynchronizowane',
            recent: 'Ostatnie',
            recentOnThisDevice: 'Ostatnie na tym telefonie',
            here: 'Tutaj',
            panes: ({ count }: { count: number }) => `Panele: ${count}`,
            emptyTitle: 'Nic więcej nie jest otwarte',
            emptyDescription: 'Sesje, które otwierasz, i karty, które zachowujesz, pojawiają się tutaj, najnowsze na górze.',
            openTab: ({ title }: { title: string }) => `Otwórz ${title}`,
        },
        rail: {
            label: 'Otwarte karty',
            synced: 'Zsynchronizowane',
            syncedA11y: 'Otwarte karty synchronizują się między Twoimi urządzeniami',
            notAvailableTitle: 'Niedostępne na tym telefonie',
            notAvailableUnknown: 'Ta karta została otwarta na innym urządzeniu, a ten telefon nie może jej pokazać. Tam nadal jest otwarta.',
            closeTab: 'Zamknij kartę',
            paneOf: ({ position, total }: { position: number; total: number }) => `${position} z ${total}`,
            nextPane: 'Następny panel',
            chatPane: 'Chat',
        },
        switcher: {
            title: 'Przełącz na',
            allSessions: 'Wszystkie sesje',
            openTabs: 'Otwarte karty',
            synced: 'zsynchronizowane',
            recent: 'Ostatnie',
            recentOnThisDevice: 'Ostatnie na tym telefonie',
            sessions: 'Sesje',
            nextInSessions: 'Następna w Sesjach',
            previousInSessions: 'Poprzednia w Sesjach',
            furtherBack: 'Wcześniejsze',
            moreRecent: 'Nowsze',
            here: 'Tutaj',
            stayOn: 'Zostań w',
            noOlderSessions: 'Brak starszych sesji',
            noNewerSessions: 'Brak nowszych sesji',
            lastInSessions: 'To ostatnia w Sesjach.',
            firstInSessions: 'To pierwsza w Sesjach.',
            nothingFurtherBack: 'Nic wcześniejszego.',
            mostRecent: 'To najnowsza.',
            nothingToSwitch: 'Nic więcej nie jest otwarte',
            nothingToSwitchDescription: 'Sesje, które otwierasz, pojawiają się tutaj, najnowsze na górze.',
            draft: ({ text }: { text: string }) => `Twój szkic: „${text}”`,
            switchSessionAction: 'Przełącz sesję',
            switchedTo: ({ name }: { name: string }) => `Przełączono na ${name}`,
            close: 'Zamknij',
            positionOf: ({ position, total }: { position: number; total: number }) => `${position} z ${total}`,
        },
    },
};

const phoneNavigationTranslations = { pl };

return { phoneNavigationTranslations };
})();

const Domain_pluginAccountDataEraseTranslations = (() => {
const english = Shared_pluginAccountDataEraseTranslations.english;

const pluginAccountDataEraseTranslations = { pl: {
    accountDataErase: {
        installedGroupTitle: 'Dane konta',
        installedGroupFooter: 'Dotyczy to wyłącznie danych przechowywanych w ramach bieżącego Konta. Nie odinstalowuje tej wtyczki z żadnego komputera.',
        installedEntryTitle: 'Usuń dane konta',
        installedEntrySubtitle: 'Usuń trwale dane zatrzymane przez tę wtyczkę z bieżącego Konta.',
        orphanedGroupTitle: 'Zachowane dane wtyczki',
        orphanedGroupFooter: 'Użyj identyfikatora wtyczki, aby usunąć zachowane dane Konta po usunięciu wtyczki.',
        orphanedEntryTitle: 'Usuń zachowane dane wtyczki',
        orphanedEntrySubtitle: 'Wprowadź zainstalowany lub usunięty identyfikator wtyczki, aby trwale usunąć bieżące dane konta.',
        promptTitle: 'Identyfikator wtyczki',
        promptBody: 'Wpisz identyfikator wtyczki, której zachowane dane chcesz usunąć z bieżącego Konta.',
        promptPlaceholder: 'com.example.plugin',
        invalidTitle: 'Wprowadź identyfikator wtyczki',
        invalidBody: 'Zanim przejdziesz dalej, użyj dokładnego identyfikatora wtyczki.',
        confirmTitle: 'Usunąć dane wtyczki konta?',
        confirmBody: ({ pluginId }: { pluginId: string }) => `Spowoduje to trwałe usunięcie danych przechowywanych dla ${pluginId} z bieżącego konta. Nie powoduje odinstalowania wtyczki z twoich komputerów.`,
        confirm: 'Usuń dane',
        completedTitle: 'Dane wtyczki konta zostały usunięte',
        completedChanged: 'Zachowane dane wtyczki zostały usunięte z bieżącego Konta.',
        completedEmpty: 'Na bieżącym koncie nie znaleziono żadnych zachowanych danych wtyczki dla tej wtyczki.',
        partialTitle: 'Niektóre dane wtyczki pozostają',
        partialBody: 'Niektórych zachowanych danych nie udało się usunąć. Nic nie będzie automatycznie ponawiać prób; spróbuj ponownie usunąć pozostałe dane.',
        failedTitle: 'Dane wtyczki nie zostały usunięte',
        failedBody: 'Nie można usunąć zachowanych danych. Spróbuj ponownie po sprawdzeniu bieżącego połączenia konta.',
        unavailableTitle: 'Dane wtyczki są niedostępne',
        unavailableBody: 'Obecne Konto uległo zmianie lub jest niedostępne. Otwórz ponownie tę akcję, gdy konto będzie gotowe.',
    },
} } as const;

return { pluginAccountDataEraseTranslations };
})();

const Domain_pluginAccountReleaseSelectionTranslations = (() => {
const english = Shared_pluginAccountReleaseSelectionTranslations.english;

const completeReleaseSelection = Shared_pluginAccountReleaseSelectionTranslations.completeReleaseSelection;

const localizedPluginAccountReleaseSelectionTranslations = { pl: {
    accountReleaseSelection: {
        groupTitle: 'Zwolnienie konta',
        groupFooter: 'Wybierz dokładną wersję dla tego konta. Nie powoduje to instalacji, aktualizacji ani zaufania wtyczki na żadnym komputerze.',
        entryTitle: 'Użyj dla tego konta',
        entrySubtitle: ({ version }: { version: string }) => `Wybierz wersję ${version} dla bieżącego Konta bez zmiany instalacji maszyny.`,
        selectedTitle: 'Wybrano zwolnienie konta',
        selectedBody: 'Wybrana wersja wtyczki będzie teraz używana dla tego konta.',
        conflictTitle: 'Zmieniono zwolnienie konta',
        conflictBody: 'Wersja konta uległa zmianie, gdy ta akcja była otwarta. Otwórz go ponownie i spróbuj jeszcze raz.',
        unavailableTitle: 'Zwolnienie konta niedostępne',
        unavailableBody: 'Dokładna wersja lub wymagane źródło migracji jest niedostępne dla bieżącego Konta. Spróbuj ponownie, gdy konto będzie gotowe.',
        rejectedTitle: 'Nie wybrano zwolnienia konta',
        rejectedBody: 'Konto nie zaakceptowało wyboru tej wersji. Sprawdź stan konta i spróbuj ponownie.',
        hostedGroupFooter: 'Zarządzaj artefaktami wtyczki, które to konto hostuje dla wtyczki. Żaden komputer nie udostępnia obecnie tej wersji, więc nie można jej tu wybrać.',
        hostedEnableTitle: 'Hostuj artefakty wtyczki dla tego konta',
        hostedEnableBody: "Zapisuje interfejs i zasoby pakietu na serwerze konta. Przy koncie bez szyfrowania serwer może odczytać dane; przy E2EE przechowuje dane zaszyfrowane. Metadane wersji pozostają widoczne. Nie instaluje to wtyczki, nie nadaje jej zaufania ani nie umożliwia wykonywania na komputerze offline.",
        hostedDisableTitle: 'Zatrzymaj hostowanie artefaktów wtyczki',
        hostedStatusDisabled: "Wyłączone. Włącz hostowanie, aby pobierać artefakty tej wersji, gdy komputer źródłowy jest offline.",
        hostedStatusPending: 'Włączone. Ta wersja czeka, aż host opublikuje swoje dokładne artefakty wtyczki.',
        hostedStatusReady: 'Hostowane artefakty wtyczki są dostępne dla tej dokładnej wersji.',
        hostedRemoveTitle: 'Wyłącz hostowanie i usuń artefakty',
        hostedRemoveBody: 'Zatrzymuje hostowanie na koncie i usuwa dokładne hostowane artefakty wtyczki tej wersji. Czyszczenie lokalnej pamięci podręcznej jest osobne.',
        hostedClearCacheTitle: 'Wyczyść lokalną pamięć podręczną artefaktów',
        hostedClearCacheBody: 'Usuwa lokalnie zapisane bajty artefaktów interfejsu tej dokładnej wersji bez zmiany hostowania na koncie.',
    },
} } as const;

const pluginAccountReleaseSelectionTranslations = { pl: completeReleaseSelection(localizedPluginAccountReleaseSelectionTranslations.pl) };

return { localizedPluginAccountReleaseSelectionTranslations, pluginAccountReleaseSelectionTranslations };
})();

const Domain_pluginInvocationLogTranslations = (() => {
const en = Shared_pluginInvocationLogTranslations.en;

const pl = {
    invocationLogs: {
        title: 'Dzienniki wywołań',
        footer: 'Ograniczone, zredagowane wpisy z wybranej maszyny wtyczki.',
        correlationFilter: 'Filtr identyfikatora korelacji',
        correlationFilterAll: 'Wszystkie wywołania tej wtyczki',
        correlationPromptTitle: 'Filtruj według identyfikatora korelacji',
        correlationPromptBody: 'Pokaż tylko wpisy z jednego dokładnego wywołania wtyczki. Pozostaw puste, aby pokazać wszystkie wpisy.',
        correlationPromptPlaceholder: 'Identyfikator korelacji',
        refresh: 'Odśwież dzienniki',
        follow: 'Śledź dzienniki',
        stopFollowing: 'Zatrzymaj śledzenie',
        loadMore: 'Załaduj kolejne wpisy',
        loadingTitle: 'Ładowanie dzienników wywołań',
        loadingSubtitle: 'Odczytywanie ograniczonych, zredagowanych wpisów z wybranej maszyny.',
        idleTitle: 'Dzienniki wywołań są gotowe do odczytu',
        idleSubtitle: 'Odśwież, aby odczytać ograniczone, zredagowane wpisy z wybranej maszyny.',
        emptyTitle: 'Brak dzienników wywołań',
        emptySubtitle: 'Na tej wybranej maszynie nie ma pasujących zredagowanych wpisów.',
        unavailableTitle: 'Dzienniki wywołań są niedostępne',
        unavailableSubtitle: 'Wybrana maszyna wtyczki jest niedostępna lub nie jest już aktualna.',
        readerUnavailableSubtitle: 'Wybrana maszyna wtyczki nie może teraz udostępnić dzienników wywołań.',
        selectionRequiredTitle: 'Wybierz maszynę wtyczki',
        selectionRequiredSubtitle: 'Przed odczytem dzienników wybierz powyżej jedną zgodną materializację wtyczki.',
        conflictTitle: 'Rozwiąż problem wybranej maszyny wtyczki',
        conflictSubtitle: 'Przed odczytem dzienników wybierz powyżej jedną zgodną materializację wtyczki.',
        errorTitle: 'Nie można było załadować dzienników wywołań',
        errorSubtitle: 'Odczyt dzienników nie został ukończony. Spróbuj ponownie, gdy wybrana maszyna będzie dostępna.',
        noMessage: 'Zdarzenie dziennika wtyczki',
        level: {
            debug: 'Debugowanie',
            info: 'Informacja',
            warn: 'Ostrzeżenie',
            error: 'Błąd',
            diagnostic: 'Diagnostyka',
        },
    },
};

const pluginInvocationLogTranslations = { pl } as const;

return { pluginInvocationLogTranslations };
})();

const Domain_pluginMachineMatrixTranslations = (() => {
const english = Shared_pluginMachineMatrixTranslations.english;

const pluginMachineMatrixTranslations = { pl: {
        machineMatrix: {
            title: 'Na twoich maszynach',
            footer: 'Tylko do odczytu. Instalacja, aktualizacja i wszystkie inne działania wtyczki wykonują się na maszynie wybranej powyżej.',
            empty: 'Żadna maszyna nie zgłosiła jeszcze instalacji wtyczki dla tego konta.',
            unavailable: 'Dostępność wtyczek konta nie została jeszcze wczytana, więc stany maszyn są nieznane.',
            incomplete: ({ count }: { count: number }) => `Ta lista może być niepełna: ${count} serwer(ów) nie zgłosiło jeszcze swoich maszyn.`,
            summary: ({ installed, total }: { installed: number; total: number }) => `Zainstalowana i aktualna na ${installed} z ${total} maszyn`,
            lastObserved: ({ ago }: { ago: string }) => `ostatnio widziana: ${ago}`,
            state: {
                installedCurrent: 'Zainstalowana i aktualna',
                disabled: 'Wyłączona',
                untrusted: 'Niezaufana',
                incompatible: 'Inne wydanie',
                localOnly: 'Tylko na tej maszynie',
                staleOffline: 'Ostatni znany stan, maszyna offline',
                absent: 'Niezainstalowana',
                unknown: 'Nieznane',
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

const marketplacePresentation = { pl: {
        diagnosticsIssueTitle: 'Problem z wtyczką', diagnosticsRecovery: 'Sprawdź szczegóły powyżej, a po naprawie przeładuj wtyczkę lub tę stronę.', diagnosticsTechnicalCode: ({ code }: { code: string }) => `Kod techniczny: ${code}`,
        discover: { publisherLabel: ({ displayName, id }: { displayName: string; id: string }) => `Etykieta wydawcy: ${displayName} (${id})`, categories: ({ values }: { values: string }) => `Kategorie: ${values}`, runtimeSummary: ({ realms, platforms }: { realms: string; platforms: string }) => `Uruchamia się w: ${realms} · Platformy: ${platforms}`, reviewStatus: { curated: 'Wybrana rekomendacja', unreviewed: 'Bez przeglądu', withdrawn: 'Wycofano' }, executableRealm: { daemon: 'usługa w tle', client: 'aplikacja', hostedWeb: 'hostowana sieć' }, platform: { darwin: 'macOS', linux: 'Linux', windows: 'Windows', web: 'Web', ios: 'iOS', android: 'Android' }, diagnostic: { title: 'Problem ze źródłem marketplace', recovery: 'Odśwież Odkrywaj. Jeśli problem trwa, sprawdź Źródła i rejestry.', unreachableTitle: ({ source }: { source: string }) => `Nie udało się połączyć z ${source}`, behindTitle: ({ source }: { source: string }) => `${source} zwróciło nieaktualne lub niepełne dane`, indexTitle: 'Indeks wtyczek jest niepełny', otherSourcesShown: 'Wyniki z innych źródeł są nadal widoczne.' } },
    } } as const;

const localizedTechnicalReviewVocabulary = { pl: { source: ({ kind, locator }: { kind: string; locator: string }) => `${kind}: ${locator}`, sourceKind: { path: 'Ścieżka lokalna', archive: 'Plik archiwum', npm: 'Pakiet npm' }, marketplaceSource: ({ kind, source }: { kind: string; source: string }) => `${kind}: ${source}`, marketplaceSourceKind: { curated: 'Wybrany katalog', 'community-npm': 'Publiczny katalog npm', user: 'Katalog użytkownika' }, executableRealm: { daemon: 'Kod usługi w tle', reactNative: 'Kod interfejsu aplikacji', hostedWeb: 'Izolowany hostowany kod internetowy' }, uiArtifacts: ({ status, ids }: { status: string; ids: string }) => `${status}: ${ids}`, uiArtifactStatus: { verified: 'Zweryfikowane zasoby interfejsu', none: 'Brak zasobów interfejsu', unavailable: 'Zasoby interfejsu niedostępne' }, authorizationClass: { cooperativeDisclosure: 'Wspólne ujawnianie', hostResourceSelection: 'Wybrane zasoby hosta', presentIntentOrOs: 'Bieżący zamiar lub uprawnienie systemowe' }, priority: ({ priority }: { priority: number }) => `Priorytet ${priority}` } } as const;

const localizedReviewVocabulary = { pl: {
        installReviewSections: {
            ...localizedTechnicalReviewVocabulary.pl,
            archiveUrlRetention: 'Happier zapisuje pełny adres URL archiwum na wybranej maszynie, wraz z ewentualnymi danymi uwierzytelniającymi, na potrzeby przyszłych aktualizacji. Wygasły lub unieważniony adres URL może uniemożliwić aktualizację.',
            trustedCodeTitle: 'Zaufany kod', trustedCodeDisclosure: 'Wtyczki działają jako zaufany kod wewnątrz Happier, a nie w piaskownicy. Wtyczka może bezpośrednio korzystać z uprawnień samej aplikacji — plików, sieci, środowiska i procesów — poza wymienionymi poniżej usługami pośredniczonymi przez Happier. Ta lista to, co wtyczka zadeklarowała i co możesz później wyłączyć, a nie granica tego, co jej kod może osiągnąć.', identity: 'Tożsamość i pakiet', evidence: 'Dane techniczne', executableCode: 'Kod wykonywalny i rozszerzenia', requiredAccess: 'Wymagany dostęp do hosta', optionalAccess: 'Opcjonalny dostęp do hosta', requestInterceptors: 'Interceptory żądań', rawCredentials: 'Deklaracje bezpośredniego dostępu do danych logowania', compatibility: 'Zgodność i aktualizacje', none: 'Nic nie zadeklarowano', scope: ({ scope }: { scope: string }) => `Zakres: ${scope}`, developmentPath: ({ locator }: { locator: string }) => `${locator} · rozwój`, publisherUnverified: ({ displayName, id }: { displayName: string; id: string }) => `${displayName} · ${id} · niezweryfikowany`, integrityBasis: { expected: ({ integrity }: { integrity: string }) => `${integrity} (oczekiwana)`, observed: ({ integrity }: { integrity: string }) => `${integrity} (zaobserwowana)` }, signatureStatus: { verified: ({ keyId }: { keyId: string }) => `Zweryfikowany podpis rejestru: ${keyId}`, unsupported: ({ keyId }: { keyId: string }) => `Nieobsługiwany podpis rejestru: ${keyId}` }, provenanceDeclaredUnverified: ({ predicateType }: { predicateType: string }) => `Zadeklarowane bez weryfikacji: ${predicateType}`, provenanceRetrievedUnverified: ({ predicateTypes }: { predicateTypes: string }) => `Pobrane bez weryfikacji: ${predicateTypes}`, provenanceUnavailable: ({ code }: { code: string }) => `Pochodzenie niedostępne: ${code}`, curationUnreviewed: ({ sourceId }: { sourceId: string }) => `Niesprawdzone źródło katalogu: ${sourceId}`, curationApproved: ({ sourceId, reviewedAt, reason }: { sourceId: string; reviewedAt: string; reason: string }) => `Sprawdzone przez ${sourceId} dnia ${reviewedAt}${reason}`, savedSecret: 'Zapisany sekret', connectedAccount: 'Połączone konto', secretKinds: ({ kinds }: { kinds: string }) => `Rodzaje sekretów: ${kinds}`, connectedAccountService: ({ service }: { service: string }) => `Usługa: ${service}`, credentialPurpose: ({ purpose }: { purpose: string }) => `Cel: ${purpose}`, credentialUse: ({ realm, phase }: { realm: string; phase: string }) => `Używane w ${realm} podczas etapu „${phase}”`, credentialAccess: ({ access }: { access: string }) => `Dostęp: ${access}`, credentialRequestHeaders: ({ origin, headers }: { origin: string; headers: string }) => `Nagłówki wysyłane do ${origin}: ${headers}`, credentialRequestEnvironment: ({ keys }: { keys: string }) => `Zmienne środowiskowe: ${keys}`, credentialRequestFiles: ({ files }: { files: string }) => `Pliki: ${files}`, realm: { web: 'kliencie internetowym', ios: 'aplikacji iOS', android: 'aplikacji Android', daemon: 'usłudze w tle' }, phase: { settings: 'konfiguracja', prepare: 'przygotowanie', connection: 'połączenie', speech: 'obsługa głosu' }, runtimeApi: ({ version }: { version: number }) => `API środowiska wykonawczego ${version}`,
        },
        sourceAdministration: { title: 'Źródła i rejestry', subtitle: 'Wybierz, gdzie ta maszyna znajduje dokładne pakiety npm i jak dociera do ich rejestrów.', communityTitle: 'Publiczny katalog npm', communitySubtitle: 'Wbudowane · niesprawdzone wyszukiwanie odpowiednich wtyczek Happier w publicznym npm, a nie dowolnych pakietów npm.', configuredTitle: 'Źródła marketplace', configuredEmpty: 'Nie skonfigurowano dodatkowych źródeł.', add: 'Dodaj źródło', edit: 'Edytuj źródło', remove: 'Usuń źródło', removeTitle: 'Usunąć źródło marketplace?', removeBody: ({ name }: { name: string }) => `${name} nie będzie już używane do wyszukiwania na tej maszynie. Zainstalowane wtyczki pozostaną bez zmian.`, sourceUrl: 'Adres źródła', displayName: 'Nazwa wyświetlana', description: 'Opis opcjonalny', enabled: 'Włączone', disabled: 'Wyłączone', curated: 'Wybrane źródło', user: 'Twoje źródło', loadError: 'Nie udało się wczytać źródeł marketplace.', retry: 'Spróbuj ponownie', operationFailed: 'Nie udało się zastosować zmiany. Sprawdź połączenie z maszyną i spróbuj ponownie.', operationOutcomeUnknownTitle: 'Zmiana wymaga sprawdzenia', operationOutcomeUnknownBody: 'Wybrana maszyna mogła już zastosować tę zmianę, ale Happier nie mógł potwierdzić wyniku. Sprawdź odświeżone ustawienia, zanim zmienisz je ponownie.' },
        updatePolicy: { title: 'Reguła aktualizacji', target: ({ machine, server }: { machine: string; server: string }) => `Obowiązuje na ${machine} przez ${server}.`, pinned: 'Przypięta wersja', pinnedSubtitle: 'Nie aktualizuj, dopóki nie wybierzesz innej reguły.', allowed: 'Aktualizacje dozwolone', allowedSubtitle: 'Jawne aktualizacje są wykonywane bez kolejnego potwierdzenia, dopóki deklarowane uprawnienia się nie rozszerzą.' },
    } } as const;

const pluginMarketplaceDiscoverTranslations = { pl: {
        ...localizedReviewVocabulary.pl,
        ...marketplacePresentation.pl,
        secretFieldActions: { delete: 'Usuń zapisany sekret', deleteHint: 'Kasuje zapisaną wartość. Nie można tego cofnąć.', unbind: 'Odłącz od tej wtyczki', unbindHint: 'Odłącza zapisany sekret od tego ustawienia. Sam sekret zostaje zachowany.' },
        pluginChangeOutcomeUnknownTitle: 'Wynik niepotwierdzony',
        pluginChangeOutcomeUnknownBody: ({ action, name, machine, server }: { action: string; name: string; machine: string; server: string }) => `Happier nie mógł potwierdzić, czy działanie „${action}” dla ${name} zakończyło się na ${machine} (${server}). Sprawdź listę zainstalowanych na tej maszynie i bieżącą wersję, zanim spróbujesz ponownie.`,
        updateFromInstalledRecordSubtitle: 'Zaktualizuj tę instalację przez jej własny zaufany kanał aktualizacji.',
        discover: {
            ...marketplacePresentation.pl.discover,
            status: {
                loading: 'Przeszukiwanie wszystkich źródeł marketplace…',
                loadingSource: ({ source }: { source: string }) => `Przeszukiwanie źródła ${source}…`,
                results: ({ count, sources }: { count: number; sources: number }) =>
                    `Wtyczki: ${count}, źródła: ${sources}`,
                empty: 'Żadna wtyczka nie pasuje do tego wyszukiwania.',
                error: ({ message }: { message: string }) => `Nie udało się odświeżyć wyszukiwania: ${message}`,
                errorTitle: 'Nie udało się odświeżyć wyszukiwania',
                stale: 'Te wyniki dotyczą wcześniejszego wyszukiwania. Wyszukaj ponownie, aby zastosować ustawienia powyżej.',
                partial: ({ count }: { count: number }) =>
                    `Źródła ze starszymi lub brakującymi danymi: ${count}. Wyniki mogą być niepełne.`,
                nonInstallable: ({ count }: { count: number }) =>
                    `Znaleziono ${count} pozycji, których nie można teraz zainstalować na tej maszynie.`,
            },
            sourceFreshness: {
                stale: 'Starsze niż to źródło',
                'stale-offline': 'Ostatnie znane wyniki, źródło offline',
                unavailable: 'Źródło niedostępne',
                'auth-unavailable': 'To źródło wymaga zalogowania',
                corrupt: 'Nie udało się odczytać indeksu źródła',
            },
            nonInstallableReason: {
                sourceStale: 'Jej źródło marketplace nie jest aktualne.',
                artifactUnavailable: 'Jej pakiet jest nieosiągalny przy dostępie do rejestru tej maszyny.',
                notApproved: 'Instalacja z tego źródła nie jest zatwierdzona.',
                unsupportedSourceKind: 'Ta wersja Happier nie obsługuje tego rodzaju źródła.',
            },
            installSubtitle: ({ source }: { source: string }) =>
                `Sprawdź wszystko, co deklaruje ta wtyczka, zanim zaufasz czemukolwiek ze źródła ${source}.`,
            registrySelectionRequired: ({ origin }: { origin: string }) => `Wymaga profilu rejestru dla ${origin}`,
            registrySelection: {
                title: ({ name }: { name: string }) => `Wybierz rejestr dla ${name}`,
                body: ({ name, origin, source }: { name: string; origin: string; source: string }) =>
                    `${name} jest publikowany w ${origin}. Wybierz profil rejestru, którego ${source} używa na tym komputerze, albo dodaj go i zaloguj się. Nic nie jest pobierane przed przeglądem instalacji i zaufania.`,
                continue: 'Dalej',
            },
        },
    } } as const;

return { marketplacePresentation, localizedTechnicalReviewVocabulary, localizedReviewVocabulary, pluginMarketplaceDiscoverTranslations };
})();

const Domain_pluginPermissionTranslations = (() => {
type PermissionDetailsTranslation = Shared_pluginPermissionTranslations.PermissionDetailsTranslation;

const pluginPermissionTranslations = { pl: {
        fields: {
            pluginId: 'Identyfikator wtyczki',
            capability: 'Uprawnienie',
            scope: 'Zakres',
            requester: 'Wnioskodawca',
            authority: 'Źródło uprawnienia',
            requestedAt: 'Czas żądania',
            reason: 'Powód',
        },
        scope: { account: 'Konto', project: 'Projekt', workspace: 'Obszar roboczy' },
        requester: { user: 'Użytkownik', host: 'System hosta', plugin: 'Wtyczka' },
        authority: { bundled: 'Wbudowana', machineInstallation: 'Instalacja na maszynie' },
        identifiers: {
            session: 'Sesja',
            request: 'Żądanie',
            machine: 'Maszyna',
            installation: 'Instalacja',
        },
        accessibilitySummary: ({ details }) => `Szczegóły żądania uprawnienia. ${details}`,
    } } as const satisfies Pick<Readonly<Record<string, PermissionDetailsTranslation>>, "pl">;

return { pluginPermissionTranslations };
})();

const Domain_pluginSettingsPresentationTranslations = (() => {
const english = Shared_pluginSettingsPresentationTranslations.english;

const pluginSettingsPresentationTranslations = { pl: {
        rowStatus: { enabled: 'Włączone', disabled: 'Wyłączone', incompatible: 'Niezgodne', trustRemoved: 'Zaufanie cofnięte', needsAttention: 'Wymaga uwagi' },
        developmentPhase: { observing: 'Obserwowanie', preparingDependencies: 'Przygotowywanie zależności', compiling: 'Kompilowanie', validating: 'Sprawdzanie', active: 'Aktywne', retainedIncumbent: 'Poprzednia wersja aktywna', unavailable: 'Niedostępne' },
        rowSource: { bundled: 'Dołączone do Happier', npm: 'Pakiet npm', archive: 'Plik archiwum', localPath: 'Folder lokalny', other: 'Skonfigurowane źródło' },
        rowAttention: { trustRemoved: 'Ta wtyczka już się nie uruchamia. Zainstaluj ją ponownie, aby znów zaufać jej kodowi.', incompatible: 'Ta wersja nie może działać na wybranej maszynie.' },
        developerGroupTitle: 'Programowanie',
        developerGroupFooter: 'Twórz wtyczki na wybranej maszynie i sprawdzaj, co zgłasza jej usługa.',
        developerDevelopmentSubtitle: 'Twórz, edytuj, testuj i pakuj wtyczki z własnych folderów.',
        developerDiagnosticsSubtitle: 'Diagnostyka usługi i katalogu dla wybranej maszyny.',
        detailMissingTitle: 'Tej wtyczki nie ma na wybranej maszynie',
        detailMissingBody: ({ pluginId }: { pluginId: string }) => `${pluginId} nie jest tutaj zainstalowana. Mogła zostać odinstalowana lub znajduje się na innej maszynie.`,
        detailMissingRetry: 'Sprawdź ponownie',
        surfaces: {
            purpose: 'Dodawaj do Happier powierzchnie, polecenia i integracje. Wtyczki działają jako zaufany kod na Twoich komputerach.',
            navigationTitle: 'Wtyczki',
            updatesTitle: 'Aktualizacje',
            moreDescriptionInSettings: 'Skąd pochodzą wtyczki, tworzenie własnych i co zgłasza ten komputer. Otwierają się w Ustawieniach.',
            fix: 'Napraw',
            allSources: 'Wszystkie źródła',
            shelfCurated: 'Wybrane',
            shelfCuratedDescription: 'Sprawdzone i polecane przez Happier. Każda instalacja i tak pokazuje pełny przegląd.',
            shelfCommunity: 'Społeczność',
            shelfCommunityDescription: 'Niesprawdzone pakiety npm. „Zainstaluj i zaufaj” pokazuje dokładnie, do czego każdy ma dostęp.',
            shelfUser: 'Twoje źródła',
            shelfUserDescription: 'Pozycje ze źródeł marketplace dodanych na tym komputerze.',
            manage: 'Zarządzaj',
            installed: 'Zainstalowano',
            notShownTitle: 'Nie udało się pokazać wszystkiego',
            listingInstallsOn: ({ machine }: { machine: string }) => `Instaluje się na ${machine}. Sprawdzisz dostęp, zanim cokolwiek zostanie uruchomione.`,
            listingChooseMachine: 'Wybierz komputer w nagłówku, aby zainstalować tę wtyczkę.',
            listingRunsIn: 'Działa w',
            listingPlatforms: 'Platformy',
            listingSource: 'Źródło',
            listingCategories: 'Kategorie',
            listingNotFoundTitle: 'Ta pozycja jest niedostępna',
            listingNotFoundBody: 'Mogła zostać usunięta ze źródła albo ten komputer nie może teraz połączyć się ze źródłem.',
            developmentSourcesTitle: 'Wtyczki w trakcie tworzenia',
            chooseMachineInstalled: 'Wybierz komputer w nagłówku, aby zobaczyć jego wtyczki.',
            chooseMachineBrowse: 'Wybierz komputer w nagłówku, aby przeglądać wtyczki, które może zainstalować.',
            openAsPage: 'Otwórz jako stronę',
            detailInstalledLabel: 'Zainstalowana wtyczka',
            detailListingLabel: 'Karta wtyczki',
            viewLabel: 'Pokaż jako',
            viewGrid: 'Siatka',
            viewList: 'Lista',
            installedSearchPlaceholder: 'Szukaj w zainstalowanych wtyczkach',
            statusFilterLabel: 'Pokaż wtyczki',
            statusAll: 'Wszystkie wtyczki',
            statusEnabled: 'Włączone',
            statusDisabled: 'Wyłączone',
            statusAttention: 'Wymagają uwagi',
            noMatch: ({ query }: { query: string }) => `Brak wtyczek pasujących do „${query}”`,
            clearSearch: 'Wyczyść',
            emptyTitle: 'Nie zainstalowano jeszcze żadnych wtyczek',
            emptyBody: 'Wtyczki dodają panele, polecenia i narzędzia dla Twoich agentów. Zacznij od tych stworzonych przez Happier.',
            browsePlugins: 'Przeglądaj wtyczki',
            browseEmpty: 'Twoje źródła nie oferują jeszcze żadnych wtyczek.',
            forDevelopers: 'Dla deweloperów',
            readFailedTitle: 'Nie udało się odczytać wtyczek z tego komputera',
            readFailedBody: 'Nic nie zostało zmienione. Spróbuj ponownie, aby jeszcze raz zapytać komputer.',
            lastKnown: ({ status }: { status: string }) => `Ostatni znany stan · ${status}`,
            machinesTitle: 'Komputery',
            machinesDescription: 'Gdzie ta wtyczka jest zainstalowana.',
            machinesCurrent: ({ current, total }: { current: number; total: number }) => `Aktualna na ${current} z ${total} komputerów`,
            onMachines: ({ count }: { count: number }) => `Na ${count} maszynach`,
            onMachine: ({ machine }: { machine: string }) => `Na ${machine}`,
            addedGroup: 'Dodane',
            machinesRetained: 'Komputer, którego nie ma już na tym koncie',
            open: 'Otwórz',
            review: 'Przejrzyj',
            seeAll: 'Pokaż wszystko',
            allResults: 'Wszystkie wyniki',
            categoriesLabel: 'Kategorie',
            runOnNoneChosen: 'Nie wybrano maszyny',
            runOnNoneAvailable: 'Żadna maszyna nie może go jeszcze uruchomić',
            runsEverywhere: 'Na każdej maszynie z Happier',
            kinds: {
                agent: 'Agent',
                providers: 'Dostawca modeli',
                scmHostingProviders: 'Hosting kodu',
                scmBackends: 'Kontrola wersji',
                voice: 'Głos',
                connectedAccounts: 'Połączona usługa',
                inputTypes: 'Typy danych wejściowych',
                mcp: 'Narzędzia MCP',
                pluginUi: 'Panele aplikacji',
                pluginBrowser: 'Widoki przeglądarki',
                composer: 'Narzędzia edytora',
            },
        },
    } } as const;

return { pluginSettingsPresentationTranslations };
})();

const Domain_pluginUpdateReviewTranslations = (() => {
const en = Shared_pluginUpdateReviewTranslations.en;

const pl = {
    title: 'Przegląd aktualizacji',
    confirmSubtitle: 'Aktualizacje, które rozszerzają przyznany dostęp, najpierw pytają.',
    autoApplySubtitle: 'Aktualizacje są stosowane bez pytania, nawet gdy rozszerzają dostęp.',
    confirmOption: 'Pytaj',
    autoApplyOption: 'Automatycznie',
};

const pluginUpdateReviewTranslations = { pl: pl };

return { pluginUpdateReviewTranslations };
})();

const Domain_pluginWebhookAdministrationTranslations = (() => {
const english = Shared_pluginWebhookAdministrationTranslations.english;

const pluginWebhookAdministrationTranslations = { pl: {
    webhookAdministration: {
        title: 'Wtyczki webhooków',
        footer: 'Punkty końcowe konta, dokładne cele maszyn, kolejki dostaw i odzyskiwanie utraconych wiadomości. Organy dostawcze nigdy nie są tu pokazane.',
        unavailableTitle: 'Webhooki wtyczek są niedostępne',
        unavailableSubtitle: 'Ten serwer nie włączył przyjmowania webhooków wtyczek.',
        endpointsTitle: 'Punkty końcowe webhooka',
        emptyTitle: 'Brak punktów końcowych webhook wtyczek',
        emptySubtitle: 'Punkty końcowe utworzone przez zainstalowane wtyczki pozostaną tutaj widoczne, łącznie z punktami końcowymi, których cel jest niedostępny.',
        loadError: 'Nie udało się wczytać stanu webhooka.',
        endpointSubtitle: ({ readiness, routing, sourceInstanceId }: { readiness: string; routing: string; sourceInstanceId: string }) => `${readiness} · ${routing} · ${sourceInstanceId}`,
        targetSubtitle: ({ machineId, materializationId, status }: { machineId: string; materializationId: string; status: string }) => `${machineId} / ${materializationId} · ${status}`,
        queueSubtitle: ({ queued, retrying, claimed, deadLetter }: { queued: number; retrying: number; claimed: number; deadLetter: number }) => `W kolejce ${queued} · ponowna próba ${retrying} · twierdził ${claimed} · martwa litera ${deadLetter}`,
        copyUrl: 'Skopiuj adres URL webhooka',
        selectTarget: 'Wybierz cel dostawy',
        retarget: 'Przekieruj punkt końcowy',
        retargetUnavailable: 'Wybierz dostępną dokładną materializację wtyczki przed ponownym skierowaniem tego punktu końcowego.',
        originSelected: 'Wybrana dokładna materializacja wtyczki zostanie ponownie sprawdzona, gdy będziesz kontynuować.',
        originUnavailable: 'Nie wybrano dokładnej dostępnej materializacji wtyczki.',
        movePendingTitle: 'Przesunąć oczekujące dostawy?',
        movePendingBody: 'Przenieść dostawy oczekujące i niedostarczone do nowego dokładnego celu? Aktywnie odebrane dostawy pozostają na obecnym poziomie docelowym.',
        resumePendingMove: 'Wznów ruch oczekujący na dostawę',
        resumePendingMoveSubtitle: ({ count }: { count: number }) => `${count} dostawy oczekujące w kolejce lub niedostarczone wiadomości nadal korzystają z poprzedniego dokładnego celu.`,
        configureCredential: 'Skonfiguruj poświadczenia podpisywania',
        rotateCredential: 'Obróć dane logowania',
        finishRotation: 'Zakończ rotację danych logowania',
        finishRotationSubtitle: 'Przestań teraz akceptować poprzednie dane uwierzytelniające.',
        credentialSecretTitle: 'Zapisz nowy sekret podpisywania',
        credentialSecretBody: ({ secret }: { secret: string }) => `Sekret ten zostaje pokazany raz. Zapisz go przed zamknięciem tej wiadomości.\n\n${secret}`,
        revoke: 'Odwołaj punkt końcowy',
        revokeTitle: 'Unieważnić punkt końcowy webhooka?',
        revokeBody: 'Nowe dostawy do tego punktu końcowego zostaną odrzucone. Istniejące metadane dotyczące dostawy pozostają dostępne zgodnie z zasadami przechowywania.',
        operationFailed: 'Operacja elementu webhook nie została ukończona. Odśwież bieżący stan przed ponowną próbą.',
        deliveryTitle: ({ digest }: { digest: string }) => `Martwy list ${digest}`,
        deliveryStatus: 'Stan dostawy',
        deliverySubtitle: ({ errorCode, attempts, replays, machineId, materializationId }: { errorCode: string; attempts: number; replays: number; machineId: string; materializationId: string }) => `${errorCode} · ${attempts} próby · ${replays} powtórki · ${machineId} / ${materializationId}`,
        unresolvedAutomationAdmissionTitle: ({ totalCount }: { totalCount: number }) => `${totalCount} nierozwiązane przyjęcia do automatyzacji`,
        unresolvedAutomationAdmissionSubtitle: ({ sample, omittedCount }: { sample: string; omittedCount: number }) => `Próbka: ${sample} · ${omittedCount} nie pokazano`,
        replay: 'Powtórz dostawę',
        discardTitle: 'Odrzucić dostawę?',
        discardBody: 'Zaszyfrowana lub zwykła przechowywana treść dostawy zostanie usunięta i nie będzie można jej odzyskać.',
    },
} } as const;

return { pluginWebhookAdministrationTranslations };
})();

const Domain_profilesPageTranslations = (() => {
const english = Shared_profilesPageTranslations.english;

const translated = Shared_profilesPageTranslations.translated;

const profilesPageTranslations = { pl: translated({
        profilesPage: {
            searchPlaceholder: 'Szukaj profili',
            emptyTitle: 'Nie ma jeszcze profili',
            newProfileTitle: 'Nowy profil',
            notFoundTitle: 'Ten profil już nie istnieje',
            notFoundDescription: 'Mógł zostać usunięty na innym urządzeniu.',
            backToProfiles: 'Wróć do profili',
            discardDraft: 'Odrzuć',
            detailDescription: 'Używany, gdy nowa sesja zaczyna się z tym profilem.',
            builtInDetailDescription: 'Gotowy profil. Zapisanie zmian tworzy twoją własną kopię.',
            enabledHint: 'Proponowany, gdy wybierasz profil dla nowej sesji.',
            pickerSection: 'Wybór profilu',
            pickerSectionDescription: 'Gdzie ta opcja pojawia się przy rozpoczynaniu sesji.',
            showFirst: 'Pokazuj na początku',
            showFirstDescription: 'Pokazuje środowisko maszyny wśród ulubionych.',
            environmentDescription: 'Zmienne środowiskowe ustawiane, gdy sesja zaczyna się z tym profilem. Wartości mogą odwoływać się do zmiennych maszyny.',
            descriptionTitle: 'Opis',
            descriptionHint: 'Opcjonalny. Wyświetlany przy wyborze tego profilu.',
        },
    }) };

return { profilesPageTranslations };
})();

const Domain_providerCollectionTranslations = (() => {
type ProviderCollectionCopy = Shared_providerCollectionTranslations.ProviderCollectionCopy;

const en = Shared_providerCollectionTranslations.en;

const pl: ProviderCollectionCopy = {
    settingsProvidersCollection: {
        description: 'Połącz źródło modeli raz i używaj jego modeli z każdym zgodnym agentem.',
        foundOn: ({ machine }: { machine: string }) => `Znaleziono na ${machine}`,
        foundOnThisMachine: 'Znaleziono na tej maszynie',
        connect: 'Połącz',
        start: 'Uruchom',
        test: 'Testuj',
        addProvider: 'Dodaj dostawcę',
        customEndpoint: 'Własny punkt końcowy',
        menuOwnCategory: 'Własne',
        menuCatalogCategory: 'Z katalogu',
        newTitle: 'Nowy dostawca',
        emptyDescription: 'Dodaj dostawcę z katalogu lub własny zgodny punkt końcowy.',
        machineScopeLabel: 'Skonfigurowano na',
        invitationTitle: 'Używaj własnych modeli',
        invitationDescription: 'Połącz dostawcę raz, a jego modele pojawią się w wyborze modeli każdego zgodnego agenta. Serwery lokalne, takie jak Ollama, działają na twojej maszynie.',
        invitationNeedsMachine: 'Dostawcy są łączeni i sprawdzani na jednej z twoich maszyn. Dodaj maszynę, aby zacząć.',
        setUpMachine: 'Skonfiguruj maszynę',
        duplicateAsCustom: 'Skopiuj jako własnego dostawcę',
        discard: 'Odrzuć',
        enabled: 'Włączony',
        enabledDescription: 'Pokazuj jego modele w wyborze modeli agentów',
        saved: 'Zapisany',
        replace: 'Zastąp',
        addKey: 'Wybierz klucz',
        apiKeyDefaultDescription: 'Używany na każdej maszynie, chyba że ma ona własny klucz.',
        apiKeyMachineDescription: 'Używany na tej maszynie zamiast klucza domyślnego.',
        availabilityTitle: 'Dostępność',
        availabilityDescription: 'Gdzie agenci mogą używać tego dostawcy.',
        modelsDescription: 'Wybierz, które modele agenci pokazują w wyborze modeli.',
        modelsShown: ({ shown, total }: { shown: number; total: number }) => `${shown} z ${total} widocznych w wyborze modeli`,
        modelsFilter: ({ count }: { count: number }) => `Filtruj ${count} modeli`,
        connectionTitle: 'Połączenie',
        nameDescription: 'Widoczna na liście dostawców i w wyborze modeli.',
        nameRequired: 'Dodaj nazwę.',
        nameTooLong: ({ max }: { max: number }) => `Użyj najwyżej ${max} znaków.`,
        managedTitle: 'Zarządzana usługa lokalna',
        endpointsTitle: 'Punkty końcowe',
        endpointsDescription: 'Pozostaw puste, aby użyć adresów podanych przez dostawcę.',
        overridesDescription: 'Dokąd trafiają żądania. Zmień adres dla wszystkich maszyn lub tylko dla tej.',
        afterSavingTitle: 'Po zapisaniu',
        destinationDescription: 'Dokąd Happier będzie wysyłać żądania tego dostawcy.',
        destinationPending: 'Pojawi się po wypełnieniu wszystkich punktów końcowych.',
    },
};

const providerCollectionTranslations = { pl } as const;

return { providerCollectionTranslations };
})();

const Domain_providerSessionTranslations = (() => {
const providerSessionTranslations = { pl: {
        launchDefaultLabel: ({ provider }: { provider: string }) => `Dostawca: ${provider}`,
        launchNamedLabel: ({ provider, connection }: { provider: string; connection: string }) => `Dostawca: ${provider} · ${connection}`,
        changedTitle: 'Ustawienia dostawcy uległy zmianie', changedBody: ({ provider, connection }: { provider: string; connection: string }) => `Ta sesja nadal korzysta z konfiguracji ${provider} · ${connection}, z którą została uruchomiona.`,
        unavailableTitle: 'Dostawca nie jest już dostępny', unavailableBody: ({ provider, connection }: { provider: string; connection: string }) => `${provider} · ${connection} nie jest już dostępny do wznowienia tej sesji.`,
        disabledTitle: 'Dostawca jest wyłączony', disabledBody: ({ provider, connection }: { provider: string; connection: string }) => `Włącz ${provider} · ${connection} przed wznowieniem tej sesji.`,
        incompatibleTitle: 'Dostawca nie jest już zgodny', incompatibleBody: ({ provider, connection }: { provider: string; connection: string }) => `${provider} · ${connection} nie jest już zgodny z agentem tej sesji.`,
        restartAction: 'Uruchom sesję ponownie', chooseModelAction: 'Wybierz model',
    } } as const;

return { providerSessionTranslations };
})();

const Domain_reviewWalkthroughTranslations = (() => {
type Count = Shared_reviewWalkthroughTranslations.Count;

type ReviewWalkthroughTranslations = Shared_reviewWalkthroughTranslations.ReviewWalkthroughTranslations;

const en = Shared_reviewWalkthroughTranslations.en;

const pl: ReviewWalkthroughTranslations = {
    severityCount: ({ count, severity }) => `${count} ${severity}`,
    findingRefA11y: ({ label, title }) => `${label}: ${title}. Przejdź do uwagi`,
    tag: { noFile: 'Bez pliku', outdated: 'Nieaktualna', unplaced: 'Nie da się umiejscowić', notInStory: 'Poza etapami' },
    outdatedSummary: 'Kod zmienił się po przeglądzie.',
    askAboutFindingA11y: ({ title }) => `Zapytaj o uwagę: ${title}`,
    tailTitle: 'Uwagi bez etapu',
    tailDescription: 'Zostają tutaj, aby nic nie zniknęło, gdy ich wierszy nie da się umiejscowić.',
    inContext: 'w kontekście',
    fromReviewAt: ({ time }) => `z przeglądu o ${time}`,
    reviewLabel: 'Przegląd:',
    enginesOf: ({ count, total }) => `${count} z ${total}`,
    enginesFinished: 'silników skończyło',
    enginesRunning: ({ count }) => (count === 1 ? '1 silnik nadal sprawdza' : `${count} silniki nadal sprawdzają`),
    fromEngines: ({ engines, inStory }) => `od ${engines} · ${inStory} w omówieniu`,
    and: ' i ',
    inStoryElsewhere: ({ inStory, elsewhere }) => `${inStory} w omówieniu, ${elsewhere} gdzie indziej`,
    allInStory: 'wszystkie w omówieniu',
    seeded: {
        title: 'Napisane po przeglądzie przez nowe uruchomienie.',
        body: ({ reviewers, time }) => `Narrator nie przeglądał kodu; każda cytowana tu uwaga pochodzi od ${reviewers} z ${time}.`,
        changed: ({ count }) => (count === 1 ? 'Od tego czasu zmienił się 1 plik.' : `Od tego czasu zmieniło się ${count} plików.`),
    },
    findingsFrom: ({ count, engine }) => (count === 1 ? `1 uwaga od ${engine}` : `${count} uwag od ${engine}`),
    publishedBefore: ({ time }) => `opublikowane o ${time}, przed omówieniem`,
    steps: {
        reviewing: 'Przegląd trwa',
        engineProgress: ({ done, running }) => `${done} gotowe · ${running} sprawdza`,
        reviewed: ({ count }) => (count === 1 ? 'Sprawdzone · 1 uwaga' : `Sprawdzone · ${count} uwag`),
        reviewedShort: ({ count }) => `Sprawdzone · ${count}`,
        engineReviewed: ({ engine, count }) => (count === 1 ? `${engine} · 1 uwaga` : `${engine} · ${count} uwag`),
        reviewedAt: ({ time }) => `Sprawdzone o ${time}`,
        reviewAt: ({ time }) => `Przegląd z ${time}`,
        partial: ({ count }) => (count === 1 ? 'Przegląd częściowy · 1 uwaga' : `Przegląd częściowy · ${count} uwag`),
        ready: 'Omówienie gotowe',
        readyShort: 'Omówienie',
        failed: 'Omówienie nie powiodło się',
        narrating: 'Narracja',
        narratorWriting: ({ narrator }) => `${narrator} pisze`,
        writing: 'Pisanie omówienia',
        writingShort: 'Pisanie',
    },
    writingWithFindings: 'Pisanie omówienia z uwagami…',
    dialog: {
        engines: 'Silniki przeglądu',
        selected: ({ count }) => `wybrano ${count}`,
        loadingEngines: 'Szukanie silników przeglądu…',
        noEngines: 'Na maszynie tej sesji nie może działać żaden silnik przeglądu.',
        findingsOnly: 'tylko uwagi',
        changes: 'Zmiany',
        instructions: 'Instrukcje',
        instructionsPlaceholder: 'Na co ma zwrócić uwagę przegląd?',
        defaultInstructions: 'Przejrzyj te zmiany pod kątem poprawności, ryzyka i brakujących testów.',
        alsoWalkthrough: 'Napisz też omówienie',
        alsoWalkthroughBody: 'Gdy uwagi są gotowe, to samo uruchomienie pisze omówienie z nimi w kontekście. Nic nie czyta zmian dwa razy.',
        narrator: 'Narrator',
        chooseNarrator: 'Wybierz narratora',
        narratorSeveral: ({ count }) => `Przegląda ${count} silników; jeden model pisze omówienie ze wszystkich ich uwag.`,
        narratorFindingsOnly: ({ engine }) => `${engine} zwraca uwagi, nie tekst. Model pisze z nich omówienie.`,
        noNarrator: 'Żaden z tych silników nie napisze omówienia. Dodaj silnik z modelem albo wyłącz omówienie.',
        footerReviewThenWalkthrough: 'Przegląd, potem pisanie omówienia',
        footerHandover: ({ reviewer, narrator }) => `${reviewer} przegląda · ${narrator} pisze`,
    },
    generated: {
        continues: ({ model }) => `${model} · kontynuuje przegląd`,
        seeded: ({ model }) => `${model} · z uwag przeglądu`,
        handover: ({ narrator, engine }) => `${narrator}, z uwag ${engine}`,
    },
    partial: {
        failed: ({ engines }) => `Przegląd ${engines} nie został ukończony.`,
        notClean: 'To przegląd częściowy, a nie czysty wynik.',
        finishedWith: ({ engines, count }) => (count === 1 ? `${engines} skończył z 1 uwagą.` : `${engines} skończył z ${count} uwagami.`),
        retry: ({ engine }) => `Ponów ${engine}`,
    },
    explain: { action: 'Wyjaśnij uwagi', running: 'Wyjaśnianie uwag', a11y: 'Poproś o wyjaśnienie uwag w omówieniu', unknownModel: 'Nieznany model', requester: { user: 'użytkownika', agent: 'agenta', plugin: 'wtyczkę', automation: 'automatyzację', workflow: 'przepływ pracy', unknown: 'nieznanego zleceniodawcę' }, header: ({ model, time, requester = 'ciebie' }) => `Wyjaśnienie przeglądu · ${model} · zamówione przez ${requester} o ${time} · to nie werdykt` },
    finished: {
        title: 'Przegląd zakończony',
        openFindings: 'Otwórz uwagi',
        walkMeThrough: 'Oprowadź mnie',
        andMore: ({ count }) => `i ${count} więcej`,
        continues: 'Kontynuuje to uruchomienie przeglądu: recenzent pisze z tego, co już przeczytał. Nic nie jest analizowane ponownie.',
        narrates: ({ count }) => (count === 1
            ? 'Uruchomienie przeglądu zakończyło się. Nowe uruchomienie napisze omówienie z tej uwagi i zmian; nie będzie przeglądać ponownie.'
            : `Uruchomienie przeglądu zakończyło się. Nowe uruchomienie napisze omówienie z tych ${count} uwag i zmian; nie będzie przeglądać ponownie.`),
    },
    started: {
        transcript: ({ engineCount, fileCount }) => `Rozpoczęto przegląd · Silniki: ${engineCount} · Pliki: ${fileCount}`,
        notStarted: ({ engines }) => `${engines} nie wystartował. Pozostałe przeglądają.`,
        narrationFailed: 'Przegląd wystartował, ale nie udało się zamówić omówienia. Uwagi i tak dotrą.',
    },
};

const reviewWalkthroughTranslations = { pl: { reviewWalkthrough: pl } };

return { reviewWalkthroughTranslations };
})();

const Domain_rolesTranslations = (() => {
type RolesTranslations = Shared_rolesTranslations.RolesTranslations;

const rolesTranslations = { pl: {
        rail: {
            label: 'Role',
            title: 'Rola',
            searchPlaceholder: 'Szukaj ról…',
            empty: 'Brak pasujących ról.',
            footer: 'Rola ma własne instrukcje, silnik i sposób działania, więc przepływy pracy pozostają przenośne.',
            manage: 'Zarządzaj rolami',
            engineAppliesOnStart: 'Silnik jest stosowany przy uruchamianiu tej roli',
            defaultEngine: 'Domyślny agent',
            activeAccessibilityLabel: 'Role, rola jest używana',
        },
        settings: {
            description: 'Kto wykonuje każdy rodzaj pracy. Przepływy i orkiestratory proszą o rolę; rola mówi, jak ją wykonać.',
            count: ({ count }) => `Role: ${count}`,
            newRole: 'Nowa rola',
            groupBuiltIn: 'Wbudowane',
            groupYours: 'Twoje',
            groupShared: 'Udostępnione tobie',
            groupPlugins: 'Z wtyczek',
            edited: 'Zmieniona',
            sourceBuiltIn: 'Wbudowana',
            sourceYours: 'Twoja',
            sourceShared: 'Udostępniona tobie',
            sourcePlugin: ({ plugin }) => `Z ${plugin}`,
            migrated: 'z sub-agentów 0.2',
            migratedNote: 'Role oznaczone „z sub-agentów 0.2” pochodzą z twoich wskazówek dla sub-agentów: opis stał się instrukcjami, agent i model silnikiem.',
            nameTitle: 'Nazwa',
            newRoleName: 'Rola bez nazwy',
            instructionsTitle: 'Instrukcje',
            instructionsDescription: 'Co robi, kiedy jej używać i jak raportować. Agenci czytają to, gdy przydzielają pracę.',
            resetToDefault: 'Przywróć domyślne',
            readOnlyNote: 'Udostępniona tobie do wglądu. Twoje wybory silnika i profilu zostają twoje.',
            howItRunsTitle: 'Jak działa',
            engineTitle: 'Silnik',
            engineDescription: 'Agent, model i wysiłek.',
            engineFollowsDefault: 'Używa twojego domyślnego agenta.',
            engineUnavailable: 'Niedostępny tutaj. Wybierz silnik.',
            runsAsTitle: 'Działa w',
            runsAsSession: 'Sesja',
            runsAsBackgroundRun: 'Zadanie w tle',
            runsAsSessionDescription: 'Sesja, którą możesz otworzyć i prowadzić.',
            runsAsBackgroundDescription: 'Działa w tle i raportuje; nie ma sesji do prowadzenia.',
            handsOffTitle: 'Bez edycji',
            handsOffDescription: 'Planuje i deleguje; sam nie edytuje plików.',
            secondOpinionTitle: 'Druga opinia',
            secondOpinionDescription: 'Zalecana prosi o rozważenie drugiej opinii przed pull requestem lub zakończeniem pracy.',
            secondOpinionOff: 'Wył.',
            secondOpinionEncouraged: 'Zalecana',
            enabledTitle: 'Dostępna',
            enabledDescription: 'Oferowana w panelu ról i orkiestratorom.',
            advancedTitle: 'Zaawansowane',
            launchProfileTitle: 'Profil uruchamiania',
            launchProfileDescription: 'Środowisko, uprawnienia, maszyna',
            launchProfileNone: 'Brak',
            profileUnavailable: 'Profil niedostępny',
            previewTitle: 'Co czytają agenci',
            previewDescription: 'Blok wysyłany z każdą turą, dokładnie.',
            deleteRole: 'Usuń rolę',
            deleteConfirmTitle: 'Usunąć tę rolę?',
            deleteConfirmBody: ({ name }) => `${name} zostanie usunięta dla ciebie i wszystkich, którym ją udostępniono. Sesje, które jej używają, zachowają kopię.`,
            share: 'Udostępnij…',
            sendCopyFailed: 'Nie udało się wysłać kopii.',
            saveFailed: 'Nie udało się zapisać roli.',
            loadFailed: 'Nie udało się wczytać ról.',
            emptyDetailTitle: 'Wybierz rolę',
            emptyDetailBody: 'Wybierz rolę, aby zobaczyć jej instrukcje i działanie.',
        },
        delegation: {
            title: 'Delegowanie',
            description: 'Jak agenci przekazują pracę innym agentom.',
            depthTitle: 'Głębokość pracy',
            approvalReviewer: 'Recenzent uprawnień',
            approvalReviewerDescription: 'Automatycznie sprawdzaj żądania niskiego ryzyka, tylko jednorazowo. Wrażliwe działania nadal wymagają Twojej zgody. Tryby Domyślny i Akceptuj zmiany.',
            approvedByReviewer: 'Jednorazowo zatwierdzone przez recenzenta',
            depthDescription: 'Sesje, zadania w tle i przepływy uruchomione przez agentów mogą uruchamiać kolejne. Ten limit zatrzymuje niekontrolowane łańcuchy. To, co uruchamiasz sam, nigdy nie jest ograniczone.',
            depthSetting: 'Jak daleko agenci mogą przekazywać pracę',
            depthSettingDescription: ({ count }) => `Poziomy: ${count}. Dalej agent ma wykonać pracę sam.`,
            ladderRoot: 'Praca, którą uruchamiasz',
            ladderRootDetail: 'Uruchomione przez ciebie · bez limitu',
            ladderLevel: ({ level }) => `Poziom ${level}`,
            ladderLevelDetail: 'Uruchomione przez agenta',
            ladderRefused: 'Jeszcze jedno przekazanie',
            ladderRefusedDetail: ({ level }) => `Poziom ${level} · odmowa; agent robi to sam`,
        },
        session: {
            useDefaults: 'Użyj domyślnych',
            crossOwnerNote: 'Role skopiowano przy starcie.',
            addRole: 'Dodaj rolę do tej sesji',
            addRoleConfirm: 'Dodaj rolę',
            namePlaceholder: 'Nazwa roli',
            instructionsPlaceholder: 'Co robi ta rola i kiedy jej używać',
            notesTitle: 'Notatki',
            notesPlaceholder: 'Co każda sesja poniżej powinna wiedzieć',
            applyToReports: 'Zastosuj do sesji poniżej',
            handsOffTitle: 'Bez edycji',
            handsOffDescription: 'Planuje i deleguje; nie edytuje plików.',
            saveFailed: 'Nie udało się zapisać zmiany.',
            sectionTitle: 'Role',
            allRoles: 'Wszystkie role',
            inUse: ({ count }) => `W użyciu: ${count}`,
            changed: 'zmieniona',
            thisSession: 'ta sesja',
            reset: 'Resetuj',
            newRoleForSession: 'Nowa rola dla tej sesji',
            changeForSession: 'Zmień dla tej sesji',
            editNotes: 'Edytuj notatki',
            more: 'Więcej',
            info: 'Role obowiązują w tej sesji i w sesjach pod nią.',
            countChanged: ({ count }) => `${count} zmienione`,
            countAdded: ({ count }) => `${count} dodane`,
            addNotes: 'Dodaj notatki o tym, jak ta sesja ma orkiestrować pracę',
        },
        profiles: {
            sharedWithYouTitle: 'Udostępnione tobie',
            sharedWithYouDescription: 'Profile udostępnione ci przez osoby i zespoły. Tajne wartości zostają u właścicieli.',
            share: 'Udostępnij…',
            shareFailedTitle: 'Nie udało się udostępnić profilu',
            shareNeedsSavedSecrets: 'Wartości sekretów nigdy nie są przesyłane. Przenieś każdą wartość tego profilu do zapisanego sekretu, połącz go i udostępnij ponownie.',
            shareAwaitingApproval: 'Publikacja profilu czeka na zatwierdzenie. Po zatwierdzeniu ponownie wybierz „Udostępnij…”.',
        },
    } } as const satisfies Pick<Record<string, RolesTranslations>, "pl">;

return { rolesTranslations };
})();

const Domain_runPageTranslations = (() => {
type Count = Shared_runPageTranslations.Count;

type Machine = Shared_runPageTranslations.Machine;

type Reviewer = Shared_runPageTranslations.Reviewer;

type RunPageTranslations = Shared_runPageTranslations.RunPageTranslations;

const runPageTranslations = { pl: {
        untitledRun: 'Uruchomienie agenta',
        intentTitles: { review: 'Przegląd', plan: 'Plan', delegate: 'Zlecone zadanie' },
        thisMachine: 'tej maszynie',
        menu: {
            cancelResponse: 'Anuluj tę odpowiedź',
            copyResult: 'Kopiuj wynik',
            showInTranscript: 'Pokaż w zapisie',
            runDetails: 'Szczegóły uruchomienia',
            agent: 'Agent',
            permissions: 'Uprawnienia',
            kind: 'Rodzaj',
            finishesOnItsOwn: 'Kończy się samo',
            staysOpen: 'Pozostaje otwarte',
            started: 'Start',
            run: 'Uruchomienie',
            process: 'Proces',
        },
        opening: { reading: ({ machine }) => `Odczyt z ${machine}.` },
        gone: {
            title: ({ machine }) => `Tego uruchomienia nie ma już na ${machine}`,
            reason: 'Nie jest już tam przechowywane, a wczytana część zapisu go nie zawiera.',
            closeTab: 'Zamknij kartę',
        },
        stopFailed: {
            title: {
                review: 'Nie udało się zatrzymać tego przeglądu',
                plan: 'Nie udało się zatrzymać tego planu',
                delegate: 'Nie udało się zatrzymać tego zadania',
                run: 'Nie udało się zatrzymać tego uruchomienia',
            },
            reasonWithOthers: ({ machine, count }) => `${machine} nie potwierdziła zatrzymania. Możesz zatrzymać całą sesję — zatrzyma to też pozostałych agentów (${count}) działających w niej.`,
            reasonAlone: ({ machine }) => `${machine} nie potwierdziła zatrzymania. Możesz zatrzymać całą sesję.`,
            stopSession: 'Zatrzymaj sesję…',
        },
        steps: {
            title: 'Jak do tego doszło',
            count: ({ count }) => (count === 1 ? '1 krok' : `Kroki: ${count}`),
        },
        review: {
            findings: 'Uwagi',
            findingsCount: ({ count }) => `${count}`,
            highCount: ({ count }) => `wysokie: ${count}`,
            severity: { blocker: 'Blokujące', high: 'Wysokie', medium: 'Średnie', low: 'Niskie', nit: 'Drobne' },
            triageLabel: 'Co zrobić z tą uwagą',
            reviewerAsks: 'Recenzent pyta',
            answer: 'Odpowiedz',
            askAboutThis: 'Zapytaj o to',
            fixesSelected: ({ count }) => (count === 1 ? 'Wybrano 1 poprawkę' : `Wybrane poprawki: ${count}`),
            noFixesSelected: 'Wybierz poprawki do wdrożenia',
            implementFixes: ({ count }) => (count === 1 ? 'Wdróż 1 poprawkę' : count > 1 ? `Wdróż poprawki (${count})` : 'Wdróż poprawki'),
            couldNotSaveChoice: 'Nie udało się zapisać wyboru.',
            reviewers: 'Recenzenci',
            findingTotal: ({ count }) => (count === 1 ? '1 uwaga' : `${count} uwag`),
            moreFindings: ({ count }) => (count === 1 ? '1 uwaga więcej' : `${count} uwag więcej`),
            fixesToImplement: ({ count }) => (count === 1 ? '1 poprawka do wdrożenia' : `${count} poprawek do wdrożenia`),
            verifiedFirst: 'Każda jest najpierw sprawdzana, potem poprawiana',
            replies: ({ count }) => (count === 1 ? '1 odpowiedź' : `${count} odpowiedzi`),
            updatedAfterQuestion: 'Zaktualizowano po twoim pytaniu',
            reviewerUpdated: ({ reviewer }) => `${reviewer} zaktualizował uwagę`,
            askPlaceholder: 'Zadaj pytanie o tę uwagę…',
            askReviewerPlaceholder: 'Zadaj pytanie recenzentowi…',
            toReviewer: ({ reviewer }) => `Do: ${reviewer}`,
            followUpsGoTo: ({ reviewer }) => `Pytania trafiają do: ${reviewer}`,
            waitingForAnswer: ({ reviewer }) => `Czekam na: ${reviewer}…`,
            waitingForAnswers: 'Czekam na recenzentów…',
            both: 'Obaj',
            reviewerCount: ({ count }) => `Recenzenci: ${count}`,
            askReviewersPlaceholder: 'Zadaj recenzentom pytanie…',
            followUpsGoToAll: ({ count }) => (count === 2 ? 'Pytania trafiają do obu recenzentów' : `Pytania trafiają do wszystkich recenzentów (${count})`),
            stillReviewing: 'Wciąż sprawdza',
            reviewerDidNotFinish: 'Nie ukończył',
            reviewersNotStarted: ({ count }) => (count === 1 ? 'Jeden recenzent nie wystartował' : `Recenzenci, którzy nie wystartowali: ${count}`),
            reviewerNotStarted: ({ reviewer }) => `Nie udało się uruchomić: ${reviewer}.`,
            notSaved: 'Ta uwaga nie została zapisana, więc nie można jeszcze podjąć decyzji.',
            decisionsUnavailable: 'Nie udało się wczytać twoich decyzji.',
            followUpUnavailable: {
                notResumable: 'Ta recenzja się zakończyła; pytania wymagają recenzji, która pozostaje otwarta.',
                ended: 'Ta recenzja się nie zakończyła, więc nie przyjmuje pytań.',
                resumeUnavailable: 'Recenzent nie jest już dostępny na tej maszynie.',
                busy: 'Recenzent jest jeszcze zajęty. Spróbuj ponownie za chwilę.',
                failed: 'Nie udało się wysłać pytania.',
            },
        },
        launcher: {
            titles: { review: 'Poproś o przegląd', plan: 'Poproś o plan', delegate: 'Zleć zadanie' },
            descriptions: {
                review: ({ machine }) => `Każdy agent osobno przegląda zmiany na ${machine}; tutaj dostajesz wynik od każdego.`,
                plan: ({ machine }) => `Agent czyta kod na ${machine} i proponuje tutaj plan. Niczego nie zmienia.`,
                delegate: ({ machine }) => `Agent pracuje na ${machine} z poniższymi uprawnieniami i raportuje tutaj.`,
            },
            whatFor: 'Do czego',
            who: { review: 'Kto przegląda', plan: 'Kto planuje', delegate: 'Kto to zrobi' },
            selectedCount: ({ count }) => `Wybrano: ${count}`,
            focus: {
                review: 'Na czym mają się skupić?',
                plan: 'Co ma obejmować plan?',
                delegate: 'Co ma zrobić?',
            },
            optional: 'opcjonalnie',
            start: {
                review: ({ count }) => (count > 1 ? `Rozpocznij przeglądy (${count})` : 'Rozpocznij przegląd'),
                plan: 'Rozpocznij plan',
                delegate: 'Rozpocznij zadanie',
            },
            runsOn: ({ machine }) => `Działa na ${machine}`,
            checking: 'Sprawdzanie, którzy agenci mogą tu działać',
            unavailableTitle: 'W tej sesji nie można uruchomić agentów',
            unavailableReason: 'Jej maszyna nie oferuje teraz przeglądów, planów ani zleconych zadań.',
        },
    } } as const satisfies Pick<Record<string, RunPageTranslations>, "pl">;

return { runPageTranslations };
})();

const Domain_scmComparisonTranslations = (() => {
type ScmComparisonTranslations = Shared_scmComparisonTranslations.ScmComparisonTranslations;

const en = Shared_scmComparisonTranslations.en;

const translated = Shared_scmComparisonTranslations.translated;

const scmComparisonTranslations = { pl: {
        scmComparison: translated({
            view: { files: 'Pliki', walkthrough: 'Przewodnik', commits: 'Commity' },
            scope: {
                workingTree: 'Oczekujące zmiany',
                session: 'Ta sesja',
                turn: 'Tura',
                latestTurn: 'Ostatnia tura',
                branch: ({ head, base }) => `${head} względem ${base}`,
                commit: ({ commit }) => `Commit ${commit}`,
            },
            tabTitle: ({ view, scope }) => `${view} · ${scope}`,
            since: ({ time }) => `od ${time}`,
            turnsWithChanges: ({ count }) => `Tury ze zmianami: ${count}`,
            scopePicker: {
                a11y: 'Zmiany do pokazania',
                branchChoice: 'Gałąź względem bazy',
                commitChoice: 'Commit',
                pullRequestChoice: 'Pull request',
                headRef: 'Gałąź lub referencja docelowa',
                baseRef: 'Gałąź lub referencja bazowa',
                parentRef: 'Referencja rodzica (opcjonalna)',
                explainAndCommit: 'Wyjaśnij i zatwierdź',
                explainOnly: 'Tylko wyjaśnij',
                unavailable: 'Niedostępne w tej sesji',
                pendingDescription: 'Bez commita · można proponować commity',
                sessionDescription: 'Wszystkie zmiany, początek → teraz',
                turnDescription: 'W kolejności zmian agenta',
                branchDescription: 'Zmiany od wspólnej bazy',
                commitDescription: 'Zmiany wprowadzone przez ten commit',
                pullRequestDescription: 'Zmiany proponowane przez ten pull request',
            },
            fileCount: ({ count }) => `Pliki: ${count}`,
            changeCount: ({ count }) => `Zmiany: ${count}`,
            changedFiles: 'Zmienione pliki',
            startReview: 'Rozpocznij przegląd',
            proposeCommits: 'Zaproponuj commity',
            explain: 'Wyjaśnij',
            explainA11y: 'Wyjaśnij: pokaż notatki przewodnika obok zmian',
            viewA11y: 'Widok',
            lockfileTag: 'Lockfile',
            generatedTag: 'Wygenerowany',
            lockfileCollapsed: 'Lockfile, zwinięty.',
            generatedCollapsed: 'Wygenerowany plik, zwinięty.',
            showDiff: 'Pokaż różnice',
            unsupportedReason: 'Pliki nie mogą jeszcze pokazać tego porównania. Zmiany nadal są w Git.',
            showPendingChanges: 'Pokaż oczekujące zmiany',
            capturedStale: 'Źródło się zmieniło. Te pliki zachowują zapisane porównanie.',
            capturedFreshnessUnknown: 'Wyświetlane są zapisane pliki. Nie udało się sprawdzić aktualnego stanu źródła.',
            keys: { nextFile: 'następny plik', nextChange: 'następna zmiana' },
        }),
    } } as const;

return { scmComparisonTranslations };
})();

const Domain_secretsSettingsTranslations = (() => {
type SecretsSettingsCopy = Shared_secretsSettingsTranslations.SecretsSettingsCopy;

const en = Shared_secretsSettingsTranslations.en;

const pl: SecretsSettingsCopy = {
    purpose: 'Klucze API i tokeny używane przez twoich agentów i serwery MCP. Wartość nie jest już pokazywana po zapisaniu.',
    yoursTitle: 'Twoje sekrety',
    yoursDescription: 'Sekrety zapisane przez ciebie lub należące do ciebie. Wybieraj je wszędzie, gdzie Happier prosi o klucz.',
    sharedWithYouTitle: 'Udostępnione tobie',
    sharedWithYouDescription: 'Inne osoby pozwalają ci ich używać. Możesz je wybrać, ale nie możesz ich zobaczyć ani zmienić.',
    add: 'Dodaj sekret',
    newSecret: 'Nowy sekret',
    emptyTitle: 'Brak sekretów',
    emptyDescription: 'Dodaj klucz API lub token raz, a potem wybieraj go wszędzie, gdzie Happier o niego prosi.',
    staleTitle: 'Nie udało się odświeżyć udostępnionych sekretów',
    staleDescription: 'Pokazywana jest ostatnia znana lista.',
    valueTitle: 'Wartość',
    valueSaved: 'Zapisana. Nie jest już nigdy pokazywana.',
    keepTitle: 'Zapisz jako',
    keepPersonal: 'Osobisty',
    keepShared: 'Udostępniony',
    keepPersonalDescription: 'Zapisany na twoim koncie. Tylko ty możesz go używać.',
    keepSharedDescription: 'Zapisany w tym Home, aby można go było udostępnić osobom, Teamom lub Grupom.',
    accessTitle: 'Kto może go używać',
    accessOnlyYou: 'Tylko ty',
    accessRecipients: ({ count }: { count: number }) => (count === 1 ? 'Ty i 1 odbiorca' : `Ty i odbiorcy: ${count}`),
    sharePersonalDescription: 'Udostępnienie przenosi go do tego Home. Nie może z powrotem stać się osobisty.',
    share: 'Udostępnij',
    manage: 'Zarządzaj',
    storageTitle: 'Przechowywanie',
    storageE2ee: 'Szyfrowany end-to-end',
    storageE2eeDescription: 'Tylko osoby, którym go udostępnisz, mogą go odczytać.',
    storagePlain: 'Zarządzany przez Home',
    storagePlainDescription: 'Ten Home go przechowuje i może go odczytać, aby go dostarczyć.',
    save: 'Zapisz sekret',
};

const secretsSettingsTranslations = { pl } as const;

return { secretsSettingsTranslations };
})();

const Domain_sessionAccessTranslations = (() => {
const sessionAccessTranslations = { "pl": {
        withContext: ({ context, label }: { context: string; label: string }) => `${context} · ${label}`,
        withCount: ({ label, count }: { label: string; count: number }) => `${label} +${count}`,
        accessibleSummary: ({ title, label }: { title: string; label: string }) => `${title}: ${label}`,
        accessibleControl: ({ name, control, value }: { name: string; control: string; value: string }) => `${name}, ${control}, ${value}`,
        title: "Dostęp do sesji",
        search: "Szukaj osób, grup lub zespołów",
        hasAccess: "Ma dostęp",
        yourAccess: "Twój dostęp",
        readOnly: "Możesz sprawdzić, skąd masz dostęp. Zmiany mogą wprowadzać tylko administratorzy sesji.",
        sourceDirect: "Dostęp bezpośredni",
        sourceTeam: "Dostęp przez zespół",
        sourceGroup: "Dostęp przez grupę",
        people: "Osoby",
        groups: "Grupy",
        teams: "Zespoły",
        account: "Osoba",
        group: "Grupa",
        team: "Zespół",
        view: "Może wyświetlać",
        edit: "Może kierować",
        admin: "Zarządzanie",
        owner: "Właściciel",
        private: "Prywatna",
        custom: "Dostęp niestandardowy",
        required: "Wymagane przez zasady zespołu",
        subjectNotFound: "Ta osoba, grupa lub zespół nie są już dostępne.",
        subjectIneligible: "Ta osoba, grupa lub zespół nie mogą już otrzymać dostępu.",
        teamPolicyRequired: "Zasady zespołu wymagają tego dostępu.",
        selfGrantManaged: "Twój dostęp musi zmienić inny menedżer dostępu.",
        homeUnsupported: "Ten Home nie obsługuje jeszcze dostępu do sesji. Zaktualizuj go, aby zarządzać tym, kto może otworzyć tę sesję.",
        openCollaboration: "Otwórz współpracę",
        authenticationRequired: "Zaloguj się metodą akceptowaną przez ten zespół i spróbuj ponownie.",
        authenticationUnavailable: "Metoda logowania wymagana przez ten zespół nie jest dostępna na tym Home.",
        delegation: "Może zatwierdzać żądania uprawnień wykonania",
        remove: "Usuń dostęp",
        confirmRemove: "Potwierdź usunięcie",
        credentialsLost: ({ names }: { names: string }) => `Te poświadczenia zespołu przestaną tu działać: ${names}`,
        ready: "Dostęp szyfrowany gotowy",
        prepared: "Dostęp szyfrowany przygotowany",
        recipientRepairRequired: "Ta osoba musi naprawić konfigurację szyfrowania swojego konta.",
        pending: "Dostęp szyfrowany oczekuje",
        setup: "Wymagana konfiguracja szyfrowania",
        repair: "Dostęp szyfrowany wymaga naprawy",
        unavailable: "Zaszyfrowana treść niedostępna",
        notRequired: "Ta sesja nie jest zaszyfrowana, więc nie ma czego przygotowywać.",
        preparing: "Przygotowywanie zaszyfrowanego dostępu…",
        preparingProgress: ({ count }: { count: number }) => `Przygotowywanie zaszyfrowanego dostępu… przygotowano: ${count}`,
        preparationPending: ({ count }: { count: number }) => `Zaszyfrowany dostęp oczekuje: ${count}`,
        preparationSetup: ({ count }: { count: number }) => `Wymagana konfiguracja szyfrowania: ${count}`,
        preparationRepair: ({ count }: { count: number }) => `Zaszyfrowany dostęp wymaga naprawy: ${count}`,
        preparationKeyUnavailable: "To urządzenie nie może przygotować zaszyfrowanego dostępu do tej sesji.",
        preparationFailed: "Dostęp został zapisany, ale przygotowanie zaszyfrowanego dostępu nie powiodło się.",
        preparationPassFailed: "Przygotowanie zaszyfrowanego dostępu nie powiodło się.",
        preparationAnnouncedComplete: "Przygotowanie zaszyfrowanego dostępu zakończone.",
        preparationAnnouncedNeedsAttention: "Zaszyfrowany dostęp wciąż wymaga konfiguracji lub naprawy.",
        preparationCheckFailed: "Nie udało się sprawdzić zaszyfrowanego dostępu.",
        outcomeUnknown: "Wynik jest niepewny. Happier sprawdza bieżący dostęp przed ponowną próbą.",
        historicalLayoutNotice: "Osoby, którym udostępniasz tę sesję, nie mogą jej otworzyć, dopóki nie zostanie zaktualizowana do tej wersji Happier.",
        historicalLayoutUpdate: "Zaktualizuj do udostępniania",
        homeReconciled: "Dostęp do sesji został zresetowany dla nowego Home.",
        lockedTitleFallback: "Zaszyfrowana sesja",
        encryptedAccess: "Dostęp szyfrowany",
        aggregatePrepared: ({ count }: { count: number }) => `przygotowano: ${count}`,
        aggregatePending: ({ count }: { count: number }) => `oczekuje: ${count}`,
        aggregateNeedsAttention: ({ count }: { count: number }) => `wymaga konfiguracji lub naprawy: ${count}`,
        prepareNow: "Przygotuj teraz",
        prepareAgain: "Przygotuj ponownie",
        preparingProgressOf: ({ count, total }: { count: number; total: number }) => `Przygotowywanie zaszyfrowanego dostępu… ${count} z ${total}`,
        showAllRecipients: "Pokaż wszystkie osoby",
        hideAllRecipients: "Ukryj osoby",
        moreRecipients: "Pokaż więcej osób",
        recipientPlainAccount: "Konto bez szyfrowania",
        pendingBody: "Ta sesja jest zaszyfrowana. Osoba zarządzająca musi jeszcze przygotować Twój zaszyfrowany dostęp, zanim otworzy się tutaj.",
        setupBody: "Dokończ konfigurację szyfrowania na tym koncie, a potem osoba zarządzająca przygotuje Twój dostęp do tej sesji.",
        setupAction: "Skonfiguruj szyfrowanie",
        repairBody: "Klucza dostarczonego dla tej sesji nie udało się otworzyć na tym urządzeniu. Spróbuj ponownie albo poproś osobę zarządzającą sesją o ponowne przygotowanie dostępu.",
        retryAction: "Spróbuj ponownie",
        unavailableBody: "Klucz udało się otworzyć, ale treści tej sesji nie udało się odszyfrować. Osoba zarządzająca sesją może przygotować dostęp ponownie.",
        openAccessAction: "Otwórz dostęp do sesji",
        removedTitle: "Dostęp usunięty",
        removedBody: "Przy obecnym dostępie nie otworzysz tej sesji. Osoba zarządzająca sesją może udostępnić ją ponownie.",
        removedAnnouncement: ({ name }: { name: string }) => `${name} usunięty z dostępu do sesji`,
        browseMore: "Przeglądaj wszystko",
        allLoaded: "Wszystkie wyniki wczytane",
        help: "„Może wyświetlać” pozwala czytać. „Może kierować” pozwala kierować Agentem w ramach uprawnień jego narzędzi. Zarządzanie obejmuje też dostęp. To nie jest izolowany czat: folder roboczy i nazwa autora nie ograniczają dostępu do powłoki, plików ani sieci."
    } } as const;

return { sessionAccessTranslations };
})();

const Domain_sessionAgentActivityTranslations = (() => {
const en = Shared_sessionAgentActivityTranslations.en;

const pl: typeof en = {
    status: {
        queued: 'W kolejce',
        starting: 'Uruchamianie',
        running: 'W trakcie',
        waiting: 'Oczekiwanie',
        blocked: 'Zablokowane',
        succeeded: 'Ukończono',
        failed: 'Niepowodzenie',
        timedOut: 'Przekroczono czas',
        cancelled: 'Zatrzymane',
        unknown: 'Nieznany',
    },
    attention: {
        permission: 'Wymaga zatwierdzenia',
        userAction: 'Wymaga Twojej odpowiedzi',
        both: 'Wymaga uwagi',
        bothDescription: 'Wymaga zatwierdzenia i Twojej odpowiedzi',
    },
    runKind: {
        conversation: 'Rozmowa',
        review: 'Przegląd',
        plan: 'Plan',
    },
    /** The Agents pane: its "+", its states, its team groups and its live line (agents lab). */
    roster: {
        teamLabel: ({ team, count }) => `Zespół ${team} · agenci: ${count}`,
        teamActionsA11y: 'Działania zespołu',
        openWork: 'Otwórz',
        needsYouCount: ({ count }) => `Czekają na ciebie: ${count}`,
        runningCount: ({ count }) => `Działa: ${count}`,
        nothingRunning: 'Nic nie działa.',
        startAgent: 'Uruchom agenta',
        machineOffline: ({ machine }) => `${machine} nie odpowiada`,
        machineOfflineUnnamed: 'Maszyna nie odpowiada',
        launch: {
            menuA11y: 'Uruchom agenta',
            conversationDescription: 'Porozmawiaj z agentem obok tej sesji',
            reviewDescription: 'Sprawdź dotychczasowe zmiany',
            planDescription: 'Zaplanuj kolejne kroki',
            delegateDescription: 'Przekaż zadanie i odbierz je gotowe',
            advancedDescription: 'Wybierz agentów, uprawnienia i profil',
        },
        empty: {
            title: 'Dodaj więcej agentów do tej sesji',
            reason: ({ machine }) => `Rozpocznij rozmowę obok albo poproś o przegląd lub plan, a sam pracuj dalej. Działają na ${machine} i raportują tutaj.`,
            reasonUnnamed: 'Rozpocznij rozmowę obok albo poproś o przegląd lub plan, a sam pracuj dalej. Raportują tutaj.',
            moreWays: 'Poproś o przegląd, plan lub delegowanie',
        },
        unavailable: {
            notEnabled: 'Agenci nie mogą startować w tym Home.',
            machineOffline: ({ machine }) => `Uruchamianie agentów wymaga, by ${machine} był online.`,
            machineOfflineUnnamed: 'Uruchamianie agentów wymaga, by ta maszyna była online.',
            sessionInactive: 'Ta sesja została zatrzymana. Wznów ją, aby uruchamiać tu agentów.',
            externalRunnerInactive: 'Ta sesja została uruchomiona poza Happier. Agentów można uruchamiać stąd, gdy Happier jest do niej podłączony.',
        },
    },
    summaryA11y: ({ title, status }) => `${title}, ${status}`,
    summaryAttentionA11y: ({ title, status, attention }) => `${title}, ${status}, ${attention}`,
};

const sessionAgentActivityTranslations = { pl };

return { sessionAgentActivityTranslations };
})();

const Domain_sessionBoardTranslations = (() => {
type SessionBoardStateTranslation = Shared_sessionBoardTranslations.SessionBoardStateTranslation;

type SessionBoardTranslation = Shared_sessionBoardTranslations.SessionBoardTranslation;

const sessionBoardTranslations = { pl: {
        title: 'Tablica',
        views: {
            label: 'Widoki tablicy',
            overview: 'Przegląd',
            createTitle: 'Nowy widok tablicy',
            renameTitle: 'Zmień nazwę widoku tablicy',
            reconciled: ({ title }) => `Ten widok tablicy został usunięty. Pokazujemy ${title}.`,
            empty: {
                title: 'Nic w tym widoku',
                reason: 'Dodaj tu widżet albo przejdź do innego widoku tablicy.',
            },
            actions: {
                create: 'Nowy widok',
                rename: 'Zmień nazwę widoku',
                moveBefore: 'Przesuń widok wcześniej',
                moveAfter: 'Przesuń widok później',
                remove: 'Usuń widok',
            },
            remove: {
                title: ({ title }) => `Usunąć „${title}”?`,
                moveMessage: ({ title }) => `Jego widżety przejdą do ${title}. Nic nie znika z sesji.`,
                unpinMessage: 'Jego widżety zostają w sesji, ale nie są już przypięte do żadnego widoku.',
            },
        },
        add: { note: 'Notatka', interactiveView: 'Widok interaktywny' },
        width: { compact: 'Wąski', medium: 'Średni', wide: 'Szeroki', full: 'Pełna szerokość' },
        height: { auto: 'Dopasuj do treści', compact: 'Niska', regular: 'Średnia', tall: 'Wysoka' },
        board: {
            loading: { title: 'Otwieramy tablicę', reason: 'Wczytujemy to, co przypięto do tej sesji.' },
            locked: {
                title: 'Tablica jest wciąż zaszyfrowana',
                reason: 'To urządzenie nie może jeszcze otworzyć sesji. Nic nie zginęło.',
            },
            unopenable: {
                title: 'Nie można odczytać układu tablicy',
                reason: 'Zapisanego układu nie udało się otworzyć. Same widżety są nienaruszone.',
            },
            unsupported: {
                title: 'Ta tablica wymaga nowszego Happiera',
                reason: 'Wszystko jest zachowane. Otwórz ją na obsługiwanym urządzeniu lub zaktualizuj Happiera.',
            },
            unavailable: {
                title: 'Tablica nie jest tu jeszcze dostępna',
                reason: 'Nic nie zginęło. Pojawi się, gdy ten Home włączy tablice.',
            },
            offline: 'Offline — widzisz ostatnio wczytaną wersję.',
            offlineEmpty: 'Offline — połącz się ponownie, aby wczytać tę tablicę.',
            stale: 'Widzisz ostatnio wczytaną wersję.',
        },
        empty: {
            editor: {
                title: 'Miej plan obok czatu',
                description: 'Notatki i widoki na żywo przypięte tutaj zostają przy tej sesji — dla każdego, kto może ją czytać.',
                askAgent: 'Poproś agenta',
                askAgentPrompt: 'Umieść na tej tablicy coś, co pokazuje ',
                addNote: 'Dodaj notatkę',
            },
            viewer: {
                title: 'Na tablicy jeszcze pusto',
                description: 'Pojawi się tu wszystko, co ludzie lub agenci przypną do tej sesji.',
            },
        },
        item: {
            untitled: 'Widżet bez tytułu',
            renameA11y: 'Tytuł widżetu',
            reorderA11y: ({ title }) => `Zmień kolejność: ${title}`,
            a11yLabelWithWidth: ({ title, width }) => `${title}, ${width}`,
            menuGroups: { content: 'Odczyt i edycja', movement: 'Przenoszenie', geometry: 'Rozmiar', destructive: 'Usuwanie' },
            loading: { title: 'Wczytujemy widżet', reason: 'Pobieramy jego treść z tego Home.' },
            locked: {
                title: 'Zaszyfrowana treść niedostępna',
                reason: 'Widżet pozostaje zaszyfrowany, dopóki to urządzenie nie otworzy sesji.',
            },
            unopenable: {
                title: 'Nie można pokazać tego widżetu',
                reason: 'Zapisanej treści nie udało się odczytać. Reszta tablicy działa dalej.',
            },
            unsupported: {
                title: 'Ten widżet wymaga nowszego Happiera',
                reason: 'Treść jest zachowana. Otwórz go na obsługiwanym urządzeniu lub zaktualizuj Happiera.',
            },
            missing: {
                title: 'Nie znaleziono tego widżetu',
                reason: 'Tablica wciąż na niego wskazuje, ale treści nie ma na tym Home.',
            },
            removed: {
                title: 'Ten widżet usunięto z tablicy',
                reason: 'Ktoś z prawem edycji skasował go dla wszystkich.',
            },
            pluginUnavailable: {
                title: 'Wtyczka niedostępna na tym urządzeniu',
                reason: 'Widżet jest zachowany. Wyświetli się ponownie, gdy wtyczka będzie tu dostępna.',
            },
            rendererUnavailable: {
                title: 'Tego widżetu nie da się pokazać na tym urządzeniu',
                reason: 'Treść jest zachowana. Otwórz go tam, gdzie widoki interaktywne są obsługiwane.',
            },
            provenance: {
                note: 'Notatka',
                interactiveView: 'Widok interaktywny',
                pluginMissing: ({ pluginId }) => `Z ${pluginId} · niezainstalowana`,
                pluginSurface: ({ plugin, surface }) => `${surface} · ${plugin}`,
                pluginQualified: ({ label, pluginId }) => `${label} (${pluginId})`,
            },
            actions: {
                remove: 'Usuń z tablicy',
                openHere: 'Otwórz tutaj',
                managePlugin: 'Zarządzaj wtyczką',
                prepareEncryption: 'Skonfiguruj szyfrowanie',
                readFull: 'Przeczytaj całą notatkę',
                rename: 'Zmień nazwę widżetu',
                unpin: 'Odepnij z tego widoku',
                moveToView: ({ title }) => `Przenieś do ${title}`,
            },
            moved: {
                before: ({ title }) => `${title} przeniesiono wcześniej.`,
                after: ({ title }) => `${title} przeniesiono później.`,
                reordered: ({ title }) => `${title} przeniesiono.`,
                toView: ({ title, view }) => `${title} przeniesiono do ${view}.`,
            },
            movePosition: ({ position, total }) => `Pozycja ${position} z ${total}`,
            moveTargetView: ({ title }) => `Widok tablicy ${title}`,
            remove: {
                title: 'Usunąć ten widżet?',
                message: 'Stracą go wszyscy, którzy mogą czytać tę sesję. Zainstalowane wtyczki pozostaną zainstalowane.',
            },
        },
        note: {
            titlePlaceholder: 'Tytuł',
            titleA11y: 'Tytuł notatki',
            untitled: 'Notatka bez tytułu',
            offline: 'Zapis wymaga połączenia z tym Home.',
            unavailable: 'Zmiany tablicy nie są jeszcze dostępne na tym Home.',
            failed: 'Happier nie zapisał tej notatki. Twój tekst nadal tu jest.',
            outcomeUnknown: 'Happier nie potwierdził zapisu notatki. Odśwież, zanim zapiszesz ponownie.',
            saved: 'Notatka zapisana',
            conflict: {
                message: 'Ta notatka zmieniła się na innym urządzeniu.',
                reviewLatest: 'Zobacz najnowszą wersję',
                applyMine: 'Zastosuj moje zmiany',
                latestHeading: 'Najnowsza wersja',
            },
        },
        recovered: {
            title: 'Odzyskane elementy',
            description: 'Te widżety należą do sesji, ale nie ma ich w żadnym widoku tablicy.',
            pin: 'Dodaj do tego widoku',
        },
        mutation: {
            conflict: 'Ta tablica zmieniła się na innym urządzeniu. Odśwież, aby zobaczyć najnowszą wersję.',
            outcomeUnknown: 'Happier nie potwierdził, czy zmiana została zapisana.',
            denied: 'Nie masz już uprawnień do zmiany tej tablicy.',
            offline: 'Zmiana tablicy wymaga połączenia z tym Home.',
            unavailable: 'Ten Home nie może jeszcze zmieniać tablicy.',
            updateRequired: 'Zaktualizuj Happier, aby wprowadzić tę zmianę tablicy.',
            hostedHtmlSourceTooLarge: 'Ten widok interaktywny jest zbyt duży, aby go zapisać. Twój szkic nadal tu jest.',
            noteTooLarge: 'Ta notatka jest zbyt duża, aby ją zapisać. Twój tekst nadal tu jest.',
            invalid: 'Ta zmiana tablicy jest nieprawidłowa. Sprawdź ją i spróbuj ponownie.',
            notFound: 'Ten element tablicy nie jest już dostępny. Odśwież tablicę.',
            storageFailed: 'Happier nie mógł bezpiecznie zapisać tej zmiany. Twoja praca nadal tu jest.',
            serverFailed: 'Ten Home nie mógł ukończyć zmiany tablicy. Spróbuj ponownie.',
            failed: 'Happier nie mógł zastosować tej zmiany tablicy.',
        },
        hostedHtmlApproval: {
            title: 'Zezwolić na ten widok interaktywny?',
            body: 'Zgoda dotyczy tego widoku w tej sesji. Aby wysłać wiadomość, nadal trzeba kliknąć wewnątrz widoku.',
            resources: ({ count }) => (count === 1 ? 'Może odczytać 1 zasób sesji' : `Może odczytać zasoby sesji: ${count}`),
            actions: ({ count }) => (count === 1 ? 'Może uruchomić 1 akcję' : `Może uruchomić akcje: ${count}`),
            sendMessages: 'Może poprosić Happier o wysłanie wiadomości',
            loadsFrom: ({ origin }) => `Ładuje z ${origin}`,
            allow: 'Zezwól',
            notNow: 'Nie teraz',
            declined: {
                title: 'Widok interaktywny jeszcze niedozwolony',
                reason: 'Sprawdź, o co prosi, kiedy będziesz gotowy.',
                review: 'Sprawdź',
            },
        },
        sidebar: {
            openInDetails: 'Otwórz w szczegółach',
            openBoard: 'Otwórz tablicę',
            sharedWithEveryone: 'Widoczne dla wszystkich tutaj',
            widgetCount: ({ count }) => `${count} ${count === 1 ? 'widżet' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'widżety' : 'widżetów'}`,
        },
        mobile: { searchPlaceholder: 'Szukaj na tej tablicy' },
        inline: {
            openBoard: 'Otwórz tablicę',
            openBoardA11y: ({ title }) => `Otwórz „${title}” na tablicy`,
        },
        companion: {
            title: 'Towarzysz',
            inCompanionA11y: 'W twoim towarzyszu',
            empty: {
                title: 'Miej sesję na oku',
                reason: 'Umieść podsumowanie sesji lub widżet tablicy obok czatu: co działa, co na ciebie czeka, co się zmieniło.',
                note: 'Tylko ty widzisz swojego towarzysza.',
            },
            pane: {
                besideChat: 'Obok twojego czatu',
                itemCount: ({ count }: { count: number }) => count === 1 ? '1 element' : `${count} el.`,
                justForYou: 'Tylko dla ciebie, obok czatu',
            },
            actions: {
                addSummary: 'Dodaj podsumowanie sesji',
                addItem: ({ title }) => `Dodaj ${title}`,
                moveToLeading: 'Przenieś na lewą stronę',
                moveToTrailing: 'Przenieś na prawą stronę',
                moveToFirst: 'Przenieś na górę',
                moveToLast: 'Przenieś na dół',
                compact: 'Rozmiar kompaktowy',
                comfortable: 'Rozmiar wygodny',
                openFull: 'Otwórz pełnego towarzysza',
                openOnBoard: 'Otwórz na tablicy',
                collapse: 'Zwiń towarzysza',
                expand: 'Rozwiń towarzysza',
                hide: 'Ukryj towarzysza',
                addToCompanion: 'Dodaj do towarzysza',
                removeFromCompanion: 'Usuń z towarzysza',
                undo: 'Cofnij',
                menuA11y: 'Opcje towarzysza',
                itemMenuA11y: ({ title }) => `Opcje dla ${title}`,
            },
            a11y: {
                headerAction: ({ count }) => `Towarzysz, elementy: ${count}`,
                show: ({ count }) => `Pokaż towarzysza, elementy: ${count}`,
                expand: ({ count }) => `Rozwiń towarzysza, elementy: ${count}`,
            },
            summary: {
                review: 'Przejrzyj',
                title: 'Podsumowanie sesji',
                untitled: 'Sesja',
                approvals: ({ count }) => `Czeka na Ciebie: ${count}`,
                workflows: ({ count }) => `Trwających przepływów: ${count}`,
                changedFiles: ({ count }) => `Zmieniono: ${count}`,
                tokens: ({ count }) => `Tokeny: ${count}`,
                contextPercent: ({ percent }) => `${percent}% kontekstu`,
                contextOnly: 'Wykorzystany kontekst',
                moreDetails: 'Więcej szczegółów',
                moreDetailsA11y: ({ count }) => `Więcej szczegółów, kolejnych wierszy: ${count}`,
                partial: 'Niektóre szczegóły nie są tu widoczne.',
            },
            notices: {
                shown: 'Pokazano towarzysza',
                hidden: 'Ukryto towarzysza',
                added: 'Dodano do towarzysza',
                removed: 'Usunięto z towarzysza',
                reordered: 'Zmieniono kolejność towarzysza',
                moved: 'Przeniesiono towarzysza',
                boardOpened: 'Tablica otwarta przez agenta',
                returnedToChat: 'Agent wrócił do czatu',
                boardViewSelected: 'Agent wybrał widok tablicy',
                boardItemRevealed: 'Agent otworzył element tablicy',
                fullOpened: 'Agent otworzył towarzysza',
            },
        },
    } } as const satisfies Pick<Readonly<Record<string, SessionBoardTranslation>>, "pl">;

return { sessionBoardTranslations };
})();

const Domain_sessionCollaborationPaneTranslations = (() => {
type PaneCopy = Shared_sessionCollaborationPaneTranslations.PaneCopy;

const en = Shared_sessionCollaborationPaneTranslations.en;

const sessionCollaborationPaneTranslations: Pick<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', PaneCopy>, "pl"> = { pl: {
        hereOne: ({ name }) => `${name} jest tutaj`,
        hereTwo: ({ first, second }) => `${first} i ${second} są tutaj`,
        hereMany: ({ first, count }) => `${first} i jeszcze ${count.toLocaleString()} os. są tutaj`,
        typingOne: ({ name }) => `${name} pisze…`,
        typingMany: ({ count }) => `Pisze ${count.toLocaleString()} os.…`,
        justYouHere: 'Jesteś tu tylko Ty',
        justYouHint: 'Osoby, którym udostępnisz sesję, pojawią się tutaj',
        you: 'Ty',
        presenceConnecting: 'Sprawdzanie, kto jest…',
        presenceUnavailable: 'Obecność na żywo nie odpowiada w tej chwili',
        presenceUnsupported: 'Obecność na żywo jest niedostępna w tym Home',
        responsibleUnsupported: 'Ten Home nie śledzi, kto jest odpowiedzialny',
        inviteTitle: 'Omówcie to obok sesji',
        inviteBody: 'Rozpocznij rozmowę, oznacz osoby i przekaż odpowiedź agentowi, gdy będziesz gotowy.',
        readOnly: 'Możesz je czytać. Pisać mogą osoby, które mogą edytować tę sesję.',
        offline: 'Jesteś offline · wyświetlane są ostatnie rozmowy',
        lockedTitle: 'Nie można jeszcze otworzyć tych rozmów na tym urządzeniu',
        lockedBody: 'Są szyfrowane end-to-end, a konfiguracja szyfrowania tego urządzenia nie pasuje do konfiguracji sesji.',
        revokedTitle: 'Nie masz już dostępu do tych rozmów',
        revokedBody: 'Osoba zarządzająca tą sesją zmieniła, kto może ją widzieć. Twoje wiadomości zostają w sesji.',
        namesTwo: ({ first, second }) => `${first} i ${second}`,
        namesThree: ({ first, second, third }) => `${first}, ${second} i ${third}`,
        namesMore: ({ first, second, count }) => `${first}, ${second} i jeszcze ${count.toLocaleString()}`,
        haveAccess: 'Mają dostęp',
        hasAccess: 'Ma dostęp',
        onlyYou: 'Tylko Ty',
        notShared: 'Jeszcze nikomu nie udostępniono',
        publicLinkOn: 'Link publiczny włączony',
        accessLoading: 'Sprawdzanie, kto ma dostęp…',
        accessError: 'Nie udało się wczytać, kto ma dostęp',
        shareTitle: 'Udostępnij tę sesję',
        shareBody: ({ home }) => `Osoby dodane w ${home} mogą śledzić sesję i dołączać do rozmów.`,
        collapse: 'Zwiń',
        linkOn: 'Włączony',
        linkOff: 'Wyłączony',
        linkGrants: 'Każdy, kto ma link, może zobaczyć transkrypcję — bez konta.',
        linkExpires: ({ date }) => `Wygasa ${date}`,
        linkNeverExpires: 'Nie wygasa',
        linkAsksConsent: 'prosi o zgodę',
        linkNoConsent: 'bez kroku zgody',
        linkHidden: 'Ten link utworzono wcześniej i nie można go ponownie wyświetlić. Utwórz nowy link, aby go skopiować.',
        qrCode: 'Kod QR',
        hideQrCode: 'Ukryj kod QR',
        newLink: 'Nowy link…',
        turnOff: 'Wyłącz',
        turnOffTitle: 'Wyłączyć link publiczny?',
        turnOffBody: 'Osoby, które mają link, od razu stracą dostęp. Nowy link możesz utworzyć później.',
        newLinkReplaces: 'Obecny link przestanie działać po utworzeniu nowego.',
        linkDenied: 'Link publiczny mogą tworzyć tylko osoby zarządzające tą sesją.',
        linkLoadFailed: 'Nie udało się sprawdzić linku publicznego.',
        justYouTitle: 'Pracujcie razem nad tą sesją',
        justYouBody: ({ home }) => `Udostępnij ją osobom w ${home}. Mogą ją śledzić, rozmawiać o niej tutaj i przejąć pracę, gdy Cię nie ma.`,
        share: 'Udostępnij',
        justYouNote: 'Albo utwórz link publiczny, który każdy może zobaczyć.',
        sharingOffTitle: ({ home }) => `${home} nie udostępnia sesji innym osobom`,
        sharingOffBody: 'Nadal możesz utworzyć link publiczny, który każdy może zobaczyć.',
        sharingOffPrivateBody: 'Sesje w tym Home zostają przy Tobie.',
        accessDenied: 'Tylko osoby zarządzające tą sesją mogą zmienić, kto ma dostęp. Nadal możesz dołączać do rozmów.',
    } };

return { sessionCollaborationPaneTranslations };
})();

const Domain_sessionCollaborationTranslations = (() => {
const sessionCollaborationPaneTranslations = {...Domain_sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations, ...EnglishFeatures.sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations};

const en = Shared_sessionCollaborationTranslations.en;

const sessionCollaborationTranslations: Pick<Record<'en'|'ca'|'de'|'es'|'fr'|'it'|'ja'|'pl'|'pt'|'ru'|'zh-Hans'|'zh-Hant', typeof en>, "pl"> = { pl: { pane: sessionCollaborationPaneTranslations['pl'], title: 'Współpraca', viewingNow: 'Teraz oglądają', justYou: 'Tylko Ty', typing: 'Pisze…', stale: 'Dane mogą być nieaktualne', unavailable: 'Obecność na żywo jest niedostępna', connecting: 'Łączenie…', unnamed: 'Członek Happier', open: 'Otwórz współpracę', conversations: 'Rozmowy', accessUnavailable: 'Dostęp do sesji jest niedostępny', accessUnavailableReason: 'Ten Home nie obsługuje udostępniania sesji innym osobom.', discussion: { featureUnavailable: "Rozmowy nie są włączone na tym Home.", bindingUnavailable: "Zaloguj się ponownie na tym Home, aby zobaczyć rozmowy.", scopeMismatch: "Te rozmowy należą do innego konta na tym Home.", modeMismatch: "Treść nie pasuje do trybu szyfrowania sesji. Spróbuj ponownie lub poproś osobę zarządzającą sesją o sprawdzenie dostępu.",  title: 'Rozmowy', newDiscussion: 'Nowa rozmowa', create: 'Utwórz rozmowę', titlePlaceholder: 'Tytuł rozmowy', messagePlaceholder: 'Napisz wiadomość…', active: 'Aktywne', activeDisclosure: 'Pokaż aktywne rozmowy', archived: 'Zarchiwizowane', archivedDisclosure: 'Pokaż zarchiwizowane rozmowy', emptyActive: 'Nie ma jeszcze aktywnych rozmów.', emptyArchived: 'Nie ma zarchiwizowanych rozmów.', loading: 'Ładowanie rozmów…', loadError: 'Nie udało się załadować rozmów.', retry: 'Spróbuj ponownie', checking: 'Sprawdzanie aktualizacji…', deliveryUnknown: 'Wynik dostarczenia jest nieznany — sprawdź przed ponowieniem.', locked: 'Możesz czytać tę rozmowę, ale nie możesz w niej publikować.', offline: 'Jesteś offline. Połącz się ponownie, aby kontynuować.', unavailable: 'Ta rozmowa jest niedostępna.', unreadCount: ({ count }) => count === 1 ? '1 nieprzeczytana' : `${count.toLocaleString()} nieprzeczytanych`, unreadMentionCount: ({ count }) => count === 1 ? '1 nieprzeczytana wzmianka' : `${count.toLocaleString()} nieprzeczytanych wzmianek`,
        mentioned: 'Wspomniano o Tobie', unreadConversations: 'Nieprzeczytane rozmowy', messageCount: ({ count }) => count === 1 ? '1 wiadomość' : `${count.toLocaleString()} wiadomości`, viaAgent: 'Przez Agenta', collaborator: 'Współpracownik', contentUnavailable: 'Wiadomość niedostępna', rename: 'Zmień nazwę rozmowy', archive: 'Archiwizuj rozmowę', restore: 'Przywróć rozmowę', selection: { copy: 'Kopiuj', askAgent: 'Zapytaj Agenta', sendToSession: 'Wyślij do sesji', handoffError: 'Nie udało się dodać wybranych wiadomości do edytora sesji.' }, titleRequired: 'Dodaj tytuł, aby rozpocząć tę rozmowę.', encryptedTitle: 'Zaszyfrowana rozmowa', archivedNotice: 'Ta rozmowa jest zarchiwizowana.', sessionArchived: 'Ta sesja jest zarchiwizowana.', postDenied: 'Nie możesz już publikować w tej sesji.', invalidMention: 'Wspomniana osoba nie może już czytać tej sesji.', invalidContent: 'Tej wiadomości nie można wysłać w tej postaci. Może być pusta lub za długa.', idempotencyConflict: 'Inna wiadomość została już wysłana z tą tożsamością.', sendFailed: 'Nie udało się wysłać tej wiadomości.', dismiss: 'Odrzuć', loadOlder: 'Załaduj starsze wiadomości', loadMore: 'Załaduj więcej rozmów' } } };

return { sessionCollaborationTranslations };
})();

const Domain_sessionCompanionTranslations = (() => {
type SessionCompanionTranslations = Shared_sessionCompanionTranslations.SessionCompanionTranslations;

const sessionCompanionTranslations = { pl: {
        status: {
            waitingForYou: 'Czeka na ciebie',
            pausedBeforeStep: ({ agent, step, total }) => `${agent} zatrzymał się przed krokiem ${step} z ${total}`,
            stepOfPlan: ({ step, total }) => `Krok ${step} z ${total} w planie`,
            agentFallback: 'Agent',
        },
        ask: {
            question: ({ summary }) => `${summary}?`,
            allow: 'Zezwól',
            deny: 'Odmów',
            showInChat: 'Pokaż w czacie',
            moreWaiting: ({ count }) => `Jeszcze ${count} czeka`,
            allowed: ({ summary }) => `Zezwolono: ${summary}`,
            denied: ({ summary }) => `Odmówiono: ${summary}`,
            justNow: 'przed chwilą',
            failed: 'Twoja odpowiedź nie dotarła do sesji. Spróbuj ponownie.',
            answerWhenBack: ({ machine }) => `Odpowiesz, gdy ${machine} wróci.`,
            answerWhenSessionBack: 'Odpowiesz, gdy sesja wróci.',
            notAllowed: 'Odpowiadać mogą tylko osoby, które mogą uruchamiać tę sesję.',
            groupA11y: 'Czeka na ciebie',
        },
        facts: {
            subagents: 'subagenci',
            changed: 'zmienione',
            context: 'kontekst',
            subagentsValue: ({ live, total }) => (live > 0 ? `${live} z ${total}` : `${total}`),
            contextValue: ({ percent }) => `${percent}%`,
            opensAgents: 'Otwiera Agentów',
            opensGit: 'Otwiera Git',
            opensUsage: 'Otwiera użycie',
        },
        plan: {
            title: 'Plan',
            description: ({ agent }) => `Lista zadań ${agent} w tej sesji`,
            progress: ({ done, total }) => `${done} z ${total}`,
            progressA11y: ({ done, total }) => `Ukończono ${done} z ${total}`,
            emptyTitle: 'Nie ma jeszcze planu',
            emptyReason: 'Gdy agent napisze listę zadań, pojawi się tutaj, krok po kroku.',
            stepDone: 'Gotowe',
            stepCurrent: 'Bieżący krok',
        },
        picker: {
            open: 'Dodaj do Towarzysza',
            chooseWidget: 'Wybierz widżet…',
            onTheBoard: ({ source }) => `${source} · na tablicy`,
        },
        drop: { keepBesideChat: 'Trzymaj obok czatu' },
        freshness: { machineOffline: ({ machine }) => `${machine} jest offline` },
        needsYouA11y: ({ count }) => `Towarzysz, ${count} czeka na ciebie`,
    } } as const satisfies Pick<Readonly<Record<string, SessionCompanionTranslations>>, "pl">;

return { sessionCompanionTranslations };
})();

const Domain_sessionConversationSurfaceTranslations = (() => {
const en = Shared_sessionConversationSurfaceTranslations.en;

const pl: typeof en = {
    discussion: {
        loadingTitle: 'Otwieranie rozmowy…',
        offlineTitle: 'Ta rozmowa nie jest dostępna offline',
        offlineReason: 'Połącz się ponownie, a otworzy się tam, gdzie skończyłeś.',
        errorTitle: 'Nie udało się otworzyć tej rozmowy',
        lockedTitle: 'Tej rozmowy nie można jeszcze otworzyć na tym urządzeniu',
        lockedReason: 'Jest szyfrowana end-to-end, a ustawienia szyfrowania tego urządzenia nie pasują do ustawień sesji.',
        revokedTitle: 'Nie masz już dostępu do tej rozmowy',
        revokedReason: 'Ta sesja nie jest już Ci udostępniona. Napisane przez Ciebie wiadomości zostają w sesji.',
        unavailableTitle: 'Rozmowy nie są tu dostępne',
        closeTab: 'Zamknij kartę',
    },
    draft: {
        leadTitle: 'Zapytaj agenta',
        leadBody: 'Działa jako osobna rozmowa obok sesji, z tymi wiadomościami jako kontekstem. Nic się nie uruchomi, dopóki nie wyślesz.',
    },
    context: {
        fromConversation: ({ title, count }) => `Z ${title} · wiadomości: ${count}`,
        fromUntitled: ({ count }) => `Z rozmowy · wiadomości: ${count}`,
    },
    origin: {
        fromConversation: ({ title }) => `z ${title}`,
        fromUntitled: 'z rozmowy',
    },
    run: {
        details: 'Szczegóły uruchomienia',
        loadingTitle: 'Otwieranie rozmowy z agentem…',
        errorTitle: 'Nie udało się otworzyć rozmowy z agentem',
    },
};

const sessionConversationSurfaceTranslations = { pl };

return { sessionConversationSurfaceTranslations };
})();

const Domain_sessionDirectoryRecoveryTranslations = (() => {
const en = Shared_sessionDirectoryRecoveryTranslations.en;

const sessionDirectoryRecoveryTranslations = { pl: {
        title: ({ machine }) => `Prywatnego folderu tego czatu nie ma już na ${machine}.`,
        body: 'Możesz kontynuować w nowym, pustym folderze. Historia czatu pozostanie tutaj, ale lokalne pliki ze starego folderu nie zostaną przywrócone.',
        continue: 'Kontynuuj w nowym folderze', notNow: 'Nie teraz',
        offlineDelete: ({ machine }) => `Prywatny folder na ${machine} zostanie usunięty, gdy ten komputer ponownie będzie online.`,
    } } satisfies Pick<Record<import('../../_all').SupportedLanguage, typeof en>, "pl">;

return { sessionDirectoryRecoveryTranslations };
})();

const Domain_sessionDraftTranslations = (() => {
const en = Shared_sessionDraftTranslations.en;

const pl: typeof en = {
    sectionTitle: 'Szkice',
    sectionTitleForHome: ({ home }) => `Szkice w ${home}`,
    waitingSectionTitleForHome: ({ home }) => `Oczekiwanie na komputer w ${home}`,
    badge: 'Szkic',
    untitled: 'Szkic bez tytułu',
    continueEditing: 'Kontynuuj edycję',
    startAnother: 'Rozpocznij kolejny',
    executionRunStart: {
        starting: 'Uruchamianie rozmowy z agentem…',
        reconciling: 'Sprawdzanie, czy ta rozmowa z agentem się rozpoczęła…',
        unresolved: 'Nie udało się potwierdzić, czy ta rozmowa z agentem się rozpoczęła. Uruchomienie kolejnej może utworzyć drugą rozmowę.',
        targetChanged: 'Komputer tej sesji zmienił się, zanim rozmowa mogła się rozpocząć. Nic nie zostało uruchomione.',
        secretReferenceOverlayUpdateRequired: 'Użycie współdzielonych sekretów w rozmowie z agentem wymaga zaktualizowanego komputera. Nic nie zostało uruchomione.',
    },
    status: {
        offline: 'Offline — zapisany na tym urządzeniu',
        syncing: 'Synchronizowanie…',
        conflict: 'Wymaga przeglądu',
        unsupported: 'Niezsynchronizowany — ten Home nie może zsynchronizować tego szkicu',
        startInterrupted: 'Uruchomienie przerwane',
    },
    availability: {
        machineUnavailable: 'Maszyna niedostępna',
        pluginUnavailable: 'Wtyczka niedostępna',
        attachmentNeedsAttention: 'Załącznik wymaga uwagi',
    },
    new: { action: 'Nowa sesja' },
    delete: {
        action: 'Usuń szkic',
        confirmTitle: 'Usunąć ten szkic?',
        confirmDescription: 'Szkic zostanie usunięty ze wszystkich zsynchronizowanych urządzeń.',
    },
    conflict: {
        title: 'Przejrzyj sprzeczne zmiany',
        description: 'Wybierz, którą wersję zachować dla każdego pola. Przed zastąpieniem możesz skopiować wersję z tego urządzenia.',
        mine: 'To urządzenie',
        synced: 'Wersja zsynchronizowana',
        useSynced: 'Użyj zsynchronizowanej',
        keepDevice: 'Zachowaj z tego urządzenia',
        copyMine: 'Kopiuj moją',
        copied: 'Skopiowano',
        copyFailed: 'Nie udało się skopiować tej wartości.',
        field: {
            text: 'Wiadomość',
            mentions: 'Wzmianki',
            attachments: 'Załączniki',
            recipient: 'Odbiorca',
            agentContinuation: 'Kontynuacja agenta',
            executionRunRequestedAction: 'Dostarczenie uruchomienia',
        },
    },
};

const sessionDraftTranslations = { pl };

return { sessionDraftTranslations };
})();

const Domain_sessionEmbeddedTranslations = (() => {
const en = Shared_sessionEmbeddedTranslations.en;

const translated = Shared_sessionEmbeddedTranslations.translated;

const sessionEmbeddedTranslations = { pl: translated({
        unavailable: 'Ta sesja jest niedostępna',
        respondInSession: 'Otwórz sesję, aby odpowiedzieć.',
        regionLabel: ({ title }) => `Sesja: ${title}`,
        newChatWelcome: 'Nad czym pracujemy?',
    }) } as const;

return { sessionEmbeddedTranslations };
})();

const Domain_sessionFollowTranslations = (() => {
type SessionFollowTranslations = Shared_sessionFollowTranslations.SessionFollowTranslations;

const en = Shared_sessionFollowTranslations.en;

const sessionFollowTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionFollowTranslations
>, "pl"> = { 'pl': {
        "notificationBody": {"message":"Nowa wiadomość w tej sesji.","failed":"Tura zakończyła się niepowodzeniem.","cancelled":"Tura została anulowana.","sourceUnavailable":"Źródło tej sesji jest niedostępne."},
        "follow": "Obserwuj",
        "unfollow": "Przestań obserwować",
        "following": "Obserwowana",
        "notifications": "Powiadomienia",
        "unavailableTitle": "Obserwowanie jest niedostępne",
        "unavailableDescription": "Ten Home nie obsługuje obserwowania sesji.",
        "unreachableTitle": "Nie można połączyć się z tym Home",
        "unreachableDescription": "Happier nie mógł sprawdzić, czy ten Home obsługuje obserwowanie sesji. Spróbuj ponownie, gdy będzie dostępny.",
        "editor": {
            "title": "Obserwuj tę sesję",
            "subtitle": "Otrzymuj aktualizacje, które są dla Ciebie ważne.",
            "ownerSubtitle": "Ta sesja należy do Ciebie, więc jej aktualizacje zawsze do Ciebie docierają.",
            "externalAttachedOnly": "Synchronizacja w tle jest wyłączona, więc aktualizacje mogą docierać tylko wtedy, gdy ta sesja jest podłączona."
        },
        "level": {
            "none": "Bez powiadomień",
            "important": "Ważne aktualizacje",
            "all_messages": "Każda nowa wiadomość"
        },
        "voice": {
            "title": "Uwzględnij w Voice",
            "subtitle": "Voice może zachować kontekst tej sesji.",
            "waitingRuntime": "Oczekiwanie na połączenie Voice.",
            "unsupported": "To środowisko nie obsługuje uwzględniania obserwowanych sesji w Voice.",
            "providerWithheld": "Ten tryb Voice nie może uwzględniać zapisanych aktualizacji sesji.",
            "waitingEncrypted": "Odblokuj tę sesję, aby uwzględnić ją w Voice.",
            "initialSnapshotPending": "W następnej turze Voice uwzględnij krótkie podsumowanie bieżącego stanu."
        },
        "footer": "Obserwowanie nigdy nie zmienia dostępu do tej sesji.",
        "settingsLink": "Ustawienia powiadomień…",
        "assignedExplanation": "Obserwujesz, ponieważ przypisano Ci tę sesję",
        "assignedNotice": "Przypisano Ci sesję.",
        "sharedNotice": "Udostępniono Ci sesję.",
        "wakeEventExplanation": "Śledzony kontekst się zmienił, więc Happier wybudził tego agenta wraz z aktualizacją.",
        "accessLost": "Nie masz już dostępu do tej sesji.",
        "offline": "Jesteś offline. Połącz się ponownie, aby zmienić obserwowanie.",
        "archived": "Obserwowanie jest wstrzymane, gdy sesja jest zarchiwizowana.",
        "sources": {
            "title": "Aktualizacje sesji",
            "waitingRuntime": "Oczekiwanie na ponowne połączenie sesji docelowej.",
            "unsupported": "Zaktualizuj lub połącz ponownie CLI na maszynie docelowej, aby odbierać aktualizacje.",
            "pausedArchived": "Aktualizacje są wstrzymane, gdy źródło lub cel są zarchiwizowane.",
            "add": "Obserwuj w innej sesji…",
            "addSource": "Wysyłaj aktualizacje z innej sesji…",
            "chooseDestinationTitle": "Obserwuj w innej sesji",
            "chooseSourceTitle": "Wysyłaj aktualizacje z innej sesji",
            "row": ({ title }) => `Aktualizacje z „${title}”`,
            "nextTurn": "Następna tura",
            "wakeOnHumanChange": "Wybudź, gdy osoba doda wiadomość",
            "stop": "Zatrzymaj aktualizacje",
            "stopForSource": ({ title }) => `Zatrzymaj aktualizacje z „${title}”`,
            "includeNextTurn": "Uwzględnij aktualizacje w następnej turze sesji docelowej.",
            "sourceKeyPreparing": "Przygotowywanie szyfrowanego dostępu…",
            "sourceKeyWaiting": "Oczekiwanie na szyfrowany dostęp.",
            "sourceKeyUnavailable": "Ten komputer nie może zapewnić szyfrowanego dostępu.",
            "sourceSessionKeyUnavailable": "Szyfrowany dostęp do tej sesji jest tu niedostępny.",
            "catchUpPending": "Oczekuje na nadrobienie"
        },
        "preferences": {
            "title": "Obserwuj automatycznie",
            "assigned": "Sesje przypisane do mnie",
            "direct": "Sesje udostępnione bezpośrednio",
            "team": "Sesje udostępnione przez zespoły",
            "group": "Sesje udostępnione przez grupy",
            "help": "Dotyczy nowych przypisań i nowo dostępnych sesji. Istniejące wybory pozostają bez zmian."
        }
    } };

return { sessionFollowTranslations };
})();

const Domain_sessionGitBranchesTranslations = (() => {
type SessionGitBranchesTranslations = Shared_sessionGitBranchesTranslations.SessionGitBranchesTranslations;

const en = Shared_sessionGitBranchesTranslations.en;

const pl: SessionGitBranchesTranslations = {
    openA11y: ({ branch }) => `Gałąź ${branch}: przełącz gałąź lub zobacz odłożone zmiany`,
    searchPlaceholder: 'Przełącz lub utwórz gałąź',
    category: { current: 'Bieżąca', branches: 'Gałęzie', remote: 'Gałęzie zdalne', keptAside: 'Odłożone', worktrees: 'Worktree', start: 'Zacznij coś nowego' },
    tracks: ({ upstream }) => `śledzi ${upstream}`,
    onlyHere: 'tylko na tym komputerze',
    changed: ({ count }) => `${count} zmienionych`,
    ahead: ({ count }) => `${count} do wypchnięcia`,
    keptAsideWhen: ({ origin, when }) => `${origin} · ${when}`,
    newBranch: ({ branch }) => `Nowa gałąź z ${branch}…`,
    newBranchDetached: 'Nowa gałąź…',
    newBranchSubtitle: 'Wpisz jej nazwę w polu wyszukiwania',
    newWorktree: 'Nowy worktree…',
    newWorktreeSubtitle: 'Pracuj na innej gałęzi w nowej sesji',
    keepAside: 'Odłóż zmiany',
    keepAsideSubtitle: ({ count }) => `Odłóż ${count} zmian i zacznij od czystego stanu`,
    keepAsideNothing: 'Brak zmian do odłożenia',
    keepAsideFailed: 'Nie udało się odłożyć zmian.',
    loadFailed: 'Nie udało się wczytać gałęzi',
    notice: {
        title: ({ branch }) => `Odłożyłeś zmiany na ${branch}`,
        reason: ({ when }) => `Odłożone ${when}. Przywróć je, aby pracować dalej.`,
        reasonUndated: 'Przywróć je, aby pracować dalej.',
        restore: 'Przywróć zmiany',
        lookFirst: 'Najpierw zobacz',
        dismiss: 'Nie teraz',
        restoreFailed: 'Nie udało się przywrócić zmian.',
    },
};

const sessionGitBranchesTranslations = { pl };

return { sessionGitBranchesTranslations };
})();

const Domain_sessionGitDisplayTranslations = (() => {
const en = Shared_sessionGitDisplayTranslations.en;

const pl: typeof en = {
    settingsLayout: 'Układ panelu Git',
    settingsShowAs: 'Pokaż zmienione pliki jako',
    trigger: 'Opcje wyświetlania',
    paneGroup: 'Panel',
    changesGroup: 'Zmiany',
    layout: 'Układ',
    layoutUnified: 'Jednolity',
    layoutTabs: 'Karty',
    layoutDescription: 'Jedno przewijanie od zmian do historii albo Zmiany i Historia jako dwa widoki.',
    showAs: 'Pokaż jako',
    showAsList: 'Lista',
    showAsTree: 'Drzewo',
    showAsDescription: 'Zmienione pliki jako lista albo pogrupowane według folderów, by brać całe foldery naraz.',
    density: 'Gęstość',
    densityDefault: 'Domyślna',
    densityCompact: 'Zwarta',
    note: 'Wiersze drzewa są zawsze zwarte. Zapamiętywane dla Twojego konta.',
    selectFolder: ({ folder }) => `Zaznacz wszystkie zmiany w ${folder}`,
    selectFile: ({ file }) => `Zaznacz ${file} do następnego commita`,
};

const sessionGitDisplayTranslations = { pl };

return { sessionGitDisplayTranslations };
})();

const Domain_sessionGitPaneTranslations = (() => {
const en = Shared_sessionGitPaneTranslations.en;

const fidelity = Shared_sessionGitPaneTranslations.fidelity;

const withFidelity = Shared_sessionGitPaneTranslations.withFidelity;

const pl: typeof en = {
    scope: { allChanges: 'Wszystkie zmiany' },
    subTabs: { changes: 'Zmiany', sync: 'Synchronizacja', history: 'Historia' },
    header: {
        changed: ({ count }) => `Zmienione: ${count}`,
        toPush: ({ count }) => `Do wypchnięcia: ${count}`,
        toPull: ({ count }) => `Do pobrania: ${count}`,
        push: ({ count }) => `Wypchnij ${count}`,
        pull: ({ count }) => `Pobierz ${count}`,
        publish: 'Opublikuj',
        folderOnMachine: ({ folder, machine }) => `${folder} na ${machine}`,
    },
    groups: {
        session: 'Zmienione w tej sesji',
        elsewhere: ({ repo }) => `Gdzie indziej w ${repo}`,
        elsewhereUnnamed: 'Gdzie indziej w tym repozytorium',
        selectGroup: ({ group }) => `Zaznacz wszystkie pliki w „${group}”`,
    },
    row: { renamedFrom: ({ path }) => `wcześniej ${path}` },
    commit: {
        toBranch: ({ branch }) => `Zatwierdź w ${branch}`,
        selection: ({ count }) => `Pliki: ${count}`,
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
            dirtyTitle: ({ count, formatted }) => (count === 1 ? `Masz 1 niezatwierdzoną zmianę` : `Niezatwierdzone zmiany: ${formatted}`),
            dirtyBody: 'Ściąganie może je naruszyć. Odłóż je na czas ściągania (wrócą zaraz potem) albo pozwól Git ściągnąć tylko, jeśli nic się nie nakłada.',
            keepAsideAndPull: 'Odłóż i ściągnij',
            pullIfNoOverlap: 'Ściągnij, jeśli nic się nie nakłada',
            divergedPullBody: 'Twoja gałąź i origin się przesunęły. Połóż swoje commity na commitach origin albo scal obie.',
            divergedPushBody: 'Najpierw pobierz commity origin (swoje na wierzch albo scal), potem wypchnij ponownie. Twoje commity zostają na tej maszynie.',
            rebase: 'Rebase na origin',
            merge: 'Scal origin',
        },
        writesOff: {
            title: 'Zatwierdzanie z Happier jest wyłączone',
            body: 'Możesz czytać i przeglądać każdą zmianę. Włącz operacje kontroli wersji, aby zatwierdzać, wypychać i ściągać stąd.',
            turnOn: 'Włącz',
        },
        header: {
            noChanges: 'brak zmian',
        },
        action: {
            fetch: 'Pobierz',
            publish: 'Opublikuj gałąź',
            createPr: 'Utwórz PR',
            openPr: ({ number }) => `#${number}`,
            resolve: ({ count }) => `Rozwiąż: ${count}`,
            upToDate: 'Aktualne',
            pushing: ({ count }) => `Wypychanie: ${count}…`,
            pulling: ({ count }) => `Ściąganie: ${count}…`,
            fetching: 'Pobieranie…',
            publishing: 'Publikowanie…',
            creatingPr: 'Tworzenie…',
        },
        menu: {
            open: 'Więcej akcji synchronizacji',
            push: 'Wypchnij',
            pull: 'Ściągnij',
            pushTo: ({ target }) => `do ${target}`,
            pullFrom: ({ target }) => `z ${target}`,
            nothingToPush: 'Nic do wypchnięcia',
            upToDate: 'Aktualne',
            fetchHint: 'Sprawdź nowe commity na origin',
            publishHint: 'Umieść tę gałąź na origin',
            createPr: 'Utwórz pull request…',
            createPrInto: ({ base }) => `do ${base}`,
            unavailable: 'Niedostępne tutaj',
            more: 'Więcej',
        },
        running: {
            branchSwitch: 'Przełączanie gałęzi…',
            branchCreate: 'Tworzenie gałęzi…',
            stashCreate: 'Odkładanie zmian…',
            discard: 'Odrzucanie zmian…',
            revert: 'Cofanie commita…',
            generic: 'W toku…',
        },
        done: {
            untouched: ({ count, formatted }) => (count === 1 ? `twoja niezatwierdzona zmiana jest nienaruszona` : `niezatwierdzone zmiany (${formatted}) są nienaruszone`),
            commit: 'Zatwierdzono',
            commitFiles: ({ count, formatted }) => (count === 1 ? `Zatwierdzono 1 plik` : `Zatwierdzone pliki: ${formatted}`),
            push: 'Wypchnięto',
            pushCommits: ({ count, formatted }) => (count === 1 ? `Wypchnięto 1 commit` : `Wypchnięte commity: ${formatted}`),
            upToDate: ({ target }) => `${target} jest aktualne`,
            pull: 'Ściągnięto',
            pullCommits: ({ count, formatted }) => (count === 1 ? `Ściągnięto 1 commit` : `Ściągnięte commity: ${formatted}`),
            fetch: ({ target }) => `Sprawdzono ${target}`,
            branchSwitch: 'Przełączono gałąź',
            branchCreate: 'Utworzono gałąź',
            stashCreate: 'Odłożono zmiany',
            discard: 'Odrzucono zmiany',
            revert: 'Cofnięto commit',
            pullRequest: 'Pull request gotowy',
            generic: 'Gotowe',
        },
        failed: {
            unknownTitle: 'Nie udało się potwierdzić, jak to się zakończyło',
            unknownBody: 'Maszyna przestała odpowiadać, zanim Git zgłosił wynik. Sprawdź ponownie, co się stało.',
            origin: 'origin',
            thisMachine: 'ta maszyna',
            refreshTitle: 'Zatwierdzono, ale lista się nie odświeżyła',
            refreshBody: 'Commit jest bezpieczny. Spróbuj ponownie, aby zobaczyć bieżące zmiany.',
            rejectedTitle: ({ target }) => `${target} ma commity, których nie masz`,
            rejectedBody: 'Pobierz je, aby zobaczyć, co się zmieniło. Twoje commity zostają na tej maszynie do kolejnego wypchnięcia.',
            authTitle: ({ machine, provider }) => `${provider} nie zaakceptował logowania z ${machine}`,
            authBody: ({ machine }) => `Git na ${machine} nie ma prawidłowych danych logowania do tego zdalnego repozytorium. Zaloguj się tam i spróbuj ponownie.`,
            offlineTitle: ({ machine }) => `${machine} jest offline`,
            offlineBody: 'Nic nie może tam teraz działać. Twoja praca jest bezpieczna na tej maszynie.',
            conflictTitle: 'Zatrzymano z powodu sprzecznych zmian',
            conflictBody: 'Niektóre pliki zmieniły się po obu stronach. Rozwiąż je, a potem kontynuuj.',
            networkTitle: ({ target }) => `Nie można połączyć się z ${target}`,
            networkBody: 'Maszyna nie mogła połączyć się ze zdalnym repozytorium. Sprawdź sieć i spróbuj ponownie.',
            commitTitle: 'Commit się nie powiódł',
            pushTitle: 'Wypchnięcie się nie powiodło',
            pullTitle: 'Ściągnięcie się nie powiodło',
            fetchTitle: 'Nie można sprawdzić nowych commitów',
            pullRequestTitle: 'Nie utworzono pull requesta',
            genericTitle: 'To się nie powiodło',
        },
        recover: {
            open: 'Otwórz',
            tryAgain: 'Spróbuj ponownie',
            fetch: 'Pobierz',
            checkAgain: 'Sprawdź ponownie',
            showConflicts: 'Pokaż konflikty',
        },
        timeline: {
            title: 'Oś czasu',
            now: 'Teraz',
            loading: 'Wczytywanie historii…',
            uncommitted: ({ count, formatted }) => (count === 1 ? `1 niezatwierdzona zmiana` : `Niezatwierdzone zmiany: ${formatted}`),
            selected: ({ count, formatted }) => (count === 1 ? `1 wybrana do następnego commita` : `Wybrane do następnego commita: ${formatted}`),
            nothingSelected: 'Nic nie wybrano',
            earlierToday: 'Wcześniej dzisiaj',
            yesterday: 'Wczoraj',
            older: 'Starsze',
            justNow: 'przed chwilą',
            toPull: 'do ściągnięcia',
            originFurther: ({ name }) => `${name} jest dalej`,
            originA11y: ({ name }) => `${name} jest tutaj`,
        },
        clean: {
            titleUpToDate: 'Wszystko zatwierdzone i wypchnięte',
            titleCommitted: 'Wszystko zatwierdzone',
            bodyUpToDate: ({ branch, upstream }) => `${branch} odpowiada ${upstream}. Nowe zmiany z tej sesji pojawią się tutaj.`,
            body: 'Nowe zmiany z tej sesji pojawią się tutaj.',
            createPullRequest: 'Utwórz pull request',
            openPullRequest: ({ number }) => `Otwórz pull request #${number}`,
            lastCommit: ({ when }) => `Ostatni commit ${when}`,
        },
        conflicts: {
            skip: 'Pomiń ten commit',
            askAgentTask: ({ files, operation }) => `Rozwiąż konflikty operacji ${operation} w ${files}. Zachowaj intencję obu stron, edytuj i dodaj do indeksu rozwiązane pliki, a potem zatrzymaj się do mojego przeglądu. Nie kontynuuj, nie przerywaj, nie twórz commita ani nie wypychaj i nie wybieraj całej jednej strony.`,
            revert: 'cofanie',
            cherryPick: 'cherry-pick',
            merge: 'scalanie',
            rebase: 'rebase',
            stopped: ({ count, formatted, operation }) => (count === 1 ? `Zatrzymano ${operation}: 1 plik zmienił się po obu stronach` : `Zatrzymano ${operation}: pliki zmienione po obu stronach: ${formatted}`),
            readyToContinue: ({ operation }) => `Wszystkie konflikty rozwiązane. Kontynuuj ${operation}.`,
            filesInConflict: ({ count, formatted }) => (count === 1 ? `1 plik w konflikcie` : `Pliki w konflikcie: ${formatted}`),
            body: 'Otwórz każdy plik w sekcji „Potrzebuje ciebie” lub poproś agenta o rozwiązanie.',
            continueBody: 'Nic nie zostanie zatwierdzone, dopóki nie kontynuujesz.',
            askAgent: 'Poproś agenta o rozwiązanie',
            continue: ({ operation }) => `Kontynuuj ${operation}`,
            abort: ({ operation }) => `Przerwij ${operation}`,
            abortTitle: ({ operation }) => `Przerwać ${operation}?`,
            abortBody: 'Gałąź wróci do stanu sprzed rozpoczęcia. Dotychczasowe rozwiązania zostaną utracone.',
            needsYou: 'Potrzebuje ciebie',
            mergedCleanly: 'Scalono bez konfliktów',
        },
        commit: {
            selectFirst: 'Wybierz pliki do zatwierdzenia',
        },
        tools: {
            title: 'Repozytoria zdalne i scalanie',
            subtitle: 'Dodaj zdalne repozytorium, scal lub zrób rebase gałęzi',
        },
    },
    paused: { reason: 'sesja jest wstrzymana', resume: 'Wznów' },
    notRepository: {
        title: 'Śledź, co zmieniają tu agenci',
        body: ({ folder }) => `${folder} nie jest jeszcze repozytorium. Utwórz je, aby przeglądać, zatwierdzać i cofać każdą zmianę.`,
        bodyUnnamed: 'Ten folder nie jest jeszcze repozytorium. Utwórz je, aby przeglądać, zatwierdzać i cofać każdą zmianę.',
    },
};

const sessionGitPaneTranslations = { pl: withFidelity(pl) };

return { sessionGitPaneTranslations };
})();

const Domain_sessionGitPullRequestTranslations = (() => {
type ProviderArgs = Shared_sessionGitPullRequestTranslations.ProviderArgs;

type GitPullRequestCopy = Shared_sessionGitPullRequestTranslations.GitPullRequestCopy;

const en = Shared_sessionGitPullRequestTranslations.en;

const pl: GitPullRequestCopy = {
    form: {
        title: 'Nowy pull request', expand: 'Otwórz w panelu szczegółów', moveBack: 'Przenieś z powrotem na pasek boczny',
        close: 'Zamknij formularz (szkic zostaje)', base: 'Scalany do', titlePlaceholder: 'Tytuł',
        bodyPlaceholder: 'Co się zmieniło i dlaczego', draft: 'Szkic', create: 'Utwórz pull request', creating: 'Tworzenie…',
        continueOn: ({ provider }) => `Kontynuuj w ${provider}`, pointer: 'Nowy pull request jest otwarty w Szczegółach', pointerShow: 'Pokaż',
        openedProviderPage: ({ provider }) => `${provider} jest otwarty, by go dokończyć; twój tekst zostaje tutaj.`,
    },
    failure: {
        authFailed: ({ provider }) => `${provider} nie zaakceptował logowania z tej maszyny`,
        network: ({ provider }) => `Nie można połączyć się z ${provider}`,
        machineOffline: 'Maszyna jest offline; szkic zostaje',
        blocked: 'Trwa inna operacja Git; spróbuj ponownie, gdy się skończy',
        other: 'Pull request nie został utworzony',
    },
    card: {
        number: ({ number }) => `#${number}`, intoBase: ({ base }) => `do ${base}`,
        state: { open: 'Otwarty', draft: 'Szkic', merged: 'Scalony', closed: 'Zamknięty', unknown: 'Pull request' },
        checks: { pending: 'Sprawdzenia trwają', success: 'Sprawdzenia zaliczone', failure: 'Sprawdzenia nieudane', unknown: 'Sprawdzenia' },
        openOn: ({ provider }) => `Otwórz w ${provider}`, copyLink: 'Kopiuj link', copied: 'Skopiowano link',
    },
    settings: {
        placementTitle: 'Otwieraj nowe pull requesty w', placementDescription: 'Na telefonie formularz zawsze otwiera się jako osobna strona.',
        sidebar: 'Pasek boczny', details: 'Panel szczegółów',
    },
};

const sessionGitPullRequestTranslations = { pl };

return { sessionGitPullRequestTranslations };
})();

const Domain_sessionHomeFreshnessTranslations = (() => {
const en = Shared_sessionHomeFreshnessTranslations.en;

const translated = Shared_sessionHomeFreshnessTranslations.translated;

const sessionHomeFreshnessTranslations = { pl: translated({
        offline: 'Offline',
        stale: 'Nie udało się odświeżyć',
        lastUpdated: ({ ago }) => `Ostatnia aktualizacja ${ago} temu`,
    }) };

return { sessionHomeFreshnessTranslations };
})();

const Domain_sessionListFilterTranslations = (() => {
const en = Shared_sessionListFilterTranslations.en;

const translated = Shared_sessionListFilterTranslations.translated;

const sessionListFilterTranslations = { pl: translated({
        filtersTitle: 'Filtry sesji', filtersSearch: 'Szukaj filtrów…', filtersShow: 'Pokaż',
        filtersScope: 'Zakres', filtersShowSessions: 'Sesje', filtersShowRuns: 'Uruchomienia', filtersShowBoth: 'Oba',
        filtersShowBothSummary: 'Sesje i uruchomienia', filtersStartedByNone: 'Nie wybrano inicjatorów',
        filtersStartedBy: 'Uruchomione przez', filtersStartedByYou: 'Ciebie', filtersStartedByTriggers: 'Wyzwalacze', filtersStartedByAgents: 'Agentów',
        filtersRunsNeedingYouAlwaysShow: 'Uruchomienia wymagające twojej uwagi są zawsze widoczne',
        filtersMyWork: 'Moja praca', filtersLegacyOwnerDirect: 'Własne i udostępnione bezpośrednio', filtersAssignedToMe: 'Przypisane do mnie', filtersFollowing: 'Obserwowane',
        filtersInvolvingMe: 'Z moim udziałem', filtersAllAccessible: 'Wszystkie dostępne', filtersAttention: 'Uwaga',
        filtersAttentionAny: 'Dowolne', filtersAttentionNeedsMe: 'Tylko sesje, które mnie potrzebują', filtersScopeNeedsMe: 'Potrzebują mnie',
        filtersInactive: 'Nieaktywne sesje', filtersInactiveShow: 'Pokaż', filtersInactiveHide: 'Ukryj',
        filtersHomes: 'Home', filtersSharedWith: 'Udostępnione', filtersOutsideTeams: 'Osobiste i bezpośrednie',
        filtersTags: 'Tagi', filtersSource: 'Źródło', filtersSourceAll: 'Wszystkie',
        filtersSourceDirect: 'Zewnętrzne',
        filtersNoOptions: 'Brak dostępnych filtrów', filtersClear: 'Wyczyść filtry', filtersDone: 'Gotowe', filtersArchived: 'Zarchiwizowane',
        filtersNeedsMeOnly: 'Tylko wymagające mnie', filtersNeedsMeOnlyDescription: 'Sesje czekające na ciebie', filtersSourceHappier: 'Happier',
        filtersMoreTags: ({ count }: { count: number }) => `+ ${count} więcej`,
        filtersResultCount: ({ count }: { count: number }) => count === 1 ? '1 element' : (count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14)) ? `${count} elementy` : `${count} elementów`,
        queryInitialLoadingTitle: 'Ładowanie sesji…', queryUpdatingTitle: 'Aktualizowanie sesji…',
        querySomeHomesUnavailableTitle: 'Niektóre Home są niedostępne', querySomeHomesUnavailableDescription: 'Happier pokazuje dostępne dane. Spróbuj ponownie, gdy te Home wrócą online.',
        queryRefreshFailedTitle: 'Nie udało się odświeżyć', queryRefreshFailedRetainedDescription: 'Załadowane sesje nadal są widoczne. Spróbuj ponownie, aby sprawdzić aktualizacje.', queryRefreshFailedEmptyDescription: 'Happier nie mógł załadować sesji z wybranych Home. Spróbuj ponownie, gdy będą dostępne.',
        queryNoMatchesLoadedTitle: 'Brak wyników w załadowanych sesjach', queryNoMatchesLoadedDescription: 'Więcej pasujących sesji może znajdować się na starszej stronie.', querySearchOlder: 'Przeszukaj starsze sesje',
        queryMoreAvailableTitle: 'Więcej sesji może być dostępnych', queryMoreAvailableDescription: 'Ten widok obejmuje załadowane sesje. Przeszukaj starsze sesje, aby kontynuować.',
        queryNoMatchesTitle: 'Żadna sesja nie pasuje', queryNoMatchesDescription: 'Spróbuj zmienić aktywne filtry.',
        queryTeamEmptyTitle: 'Ten zespół nie ma sesji', queryTeamEmptyDescription: 'Sesje udostępnione temu zespołowi pojawią się tutaj.',
        queryMyWorkEmptyTitle: 'Nic w Mojej pracy', queryScopeEmptyDescription: 'Spróbuj szerszego zakresu lub wróć później.', queryBrowseAllAccessible: 'Pokaż wszystkie sesje',
        queryAssignedEmptyTitle: 'Nie masz przypisanych sesji', queryFollowingEmptyTitle: 'Brak obserwowanych sesji', queryInvolvingEmptyTitle: 'Brak sesji z Twoim udziałem',
        queryAttentionEmptyTitle: 'Żadna sesja nie wymaga Twojej uwagi', queryReachableEmptyTitle: 'Brak dostępnych sesji', queryReachableEmptyDescription: 'Żadna sesja w osiągalnych Home nie pasuje do tego widoku.',
        queryHistoricalSharesWithheldTitle: 'Niektóre udostępnione sesje są ukryte', queryHistoricalSharesWithheldDescription: 'Sesje udostępnione Ci z wcześniejszej wersji Happier pozostają ukryte, dopóki ich właściciel nie zaktualizuje ich w Happier.',
        partialHomeNotMountedTitle: ({ home }) => `${home} nie znajduje się w tym widoku sesji`,
        partialHomeNotMountedDescription: 'Dodaj ten Home do widocznej grupy Home, aby pokazać sesje zespołu bez zmiany aktywnego Home.',
        partialShowFromHome: ({ home }) => `Pokaż sesje z ${home}`,
        teamListingUnavailableTitle: 'Lista sesji zespołu jest niedostępna w tym Home',
        teamListingUnavailableDescription: 'Ten Home nie może jeszcze wyświetlać sesji zespołu. Zaktualizuj lub skonfiguruj go ponownie i spróbuj jeszcze raz.',
        teamListingLoadingTitle: ({ team }) => `Wczytywanie sesji ${team}…`,
        teamListingLoadingDescription: 'Happier sprawdza, co ten Home może wyświetlić.',
        teamListingProbeFailedTitle: 'Nie można połączyć się z tym Home',
        teamListingProbeFailedDescription: 'Happier nie mógł sprawdzić sesji zespołu w tym Home. Spróbuj ponownie, gdy będzie dostępny.',
    }) };

return { sessionListFilterTranslations };
})();

const Domain_sessionMessageAccountActorTranslations = (() => {
type AccountActorTranslations = Shared_sessionMessageAccountActorTranslations.AccountActorTranslations;

const sessionMessageAccountActorTranslations: Pick<Record<SupportedLanguage, AccountActorTranslations>, "pl"> = { pl: { accountActorYou: 'Ty', accountActorFormerMember: 'Były członek', accountActorUnnamedMember: 'Członek Happier', accountActorSentBy: ({ name }) => `Wysłane przez: ${name}` } };

return { sessionMessageAccountActorTranslations };
})();

const Domain_sessionPageTranslations = (() => {
const english = Shared_sessionPageTranslations.english;

const translated = Shared_sessionPageTranslations.translated;

const sessionPageTranslations = { pl: translated({
        sessionPages: {
            info: {
                continueTitle: 'Kontynuuj',
                continueDescription: 'Zacznij nową pracę od miejsca, w którym jest ta sesja.',
                organizeTitle: 'Porządkuj',
                organizeDescription: 'Gdzie ta sesja pojawia się na Twoich listach.',
                activityDescription: 'Co robi agent i czy się o tym dowiesz.',
                detailsTitle: 'Szczegóły',
                detailsDescription: 'Identyfikatory i historia, dla wsparcia i skryptów.',
                environmentTitle: 'Środowisko',
                environmentDescription: 'Maszyna, folder i agent, z którymi działa ta sesja.',
                agentStateDescription: 'Kto steruje agentem i na co on czeka.',
                relatedTitle: 'Powiązane',
                relatedDescription: 'Inne strony tej sesji.',
                developerTitle: 'Deweloper',
                developerDescription: 'Surowe dane do debugowania, widoczne w trybie dewelopera.',
                leaveLabel: 'Zatrzymaj, zarchiwizuj lub usuń',
                leaveFootnote: 'Zatrzymanie kończy działający proces. Zarchiwizowane sesje można przywrócić. Usunięcie trwale kasuje sesję i jej wiadomości.',
            },
            follow: {
                description: 'Wybierz, czy ta sesja ma Cię powiadamiać i mówić głosem.',
            },
            permissions: {
                description: 'Narzędzia dozwolone z innego urządzenia dla tej sesji. Odwołaj te, których już nie chcesz.',
            },
            automations: {
                description: 'Praca uruchamiana w tej sesji według harmonogramu, zdarzenia lub po zakończeniu tury.',
            },
            newRun: {
                description: 'Uruchom sub-agenta z tej sesji.',
                transcriptReadOnly: 'To jest zapisana historia. Połącz się ponownie z tym Home, aby kontynuować rozmowę.',
                daemonReadOnly: 'Ta historia pochodzi z procesu agenta. Połącz się ponownie z tym Home, aby kontynuować rozmowę.',
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
>, "pl"> = { pl: {
        due: 'Czas na przypomnienie',
        title: 'Przypomnij mi', inOneHour: 'Za 1 godzinę', inThreeHours: 'Za 3 godziny',
        tomorrowMorning: 'Jutro rano', nextWeek: 'W przyszłym tygodniu', custom: 'Wybierz datę i godzinę…',
        customTitle: 'Wybierz datę i godzinę',
        customPlaceholder: '2026-09-08 09:00', futureTimeRequired: 'Wybierz czas w przyszłości.',
        setReminder: 'Ustaw przypomnienie',
        reminderSaved: 'Przypomnienie zapisane',
        presetSaveFailedAfterReminder: 'Przypomnienie zapisano, ale zapis ustawienia nie został potwierdzony. Ponów zapis lub zamknij.',
        presetsSaveFailed: 'Zapis ustawień nie został potwierdzony. Zmiany są zachowane tutaj; spróbuj ponownie.',
        presetsChanged: 'Zapisane ustawienia różnią się od otwartej listy. Zamknij i otwórz ponownie, aby sprawdzić aktualną listę.',
        remove: 'Usuń przypomnienie',
        dateLabel: 'Data', timeLabel: 'Godzina', addToPresets: 'Dodaj do ustawień', presetPreviewUnavailable: 'Wybierz prawidłowy przyszły czas, aby zobaczyć podgląd.', managePresets: 'Zarządzaj ustawieniami', managePresetsMessage: 'Zmieniaj nazwy, kolejność lub usuwaj zapisane przypomnienia.', presetName: 'Nazwa ustawienia', movePresetUp: 'Przenieś wyżej', movePresetDown: 'Przenieś niżej', renamePresetLabel: ({ preset }) => `Zmień nazwę „${preset}”`, movePresetUpLabel: ({ preset }) => `Przenieś „${preset}” wyżej`, movePresetDownLabel: ({ preset }) => `Przenieś „${preset}” niżej`, deletePresetLabel: ({ preset }) => `Usuń „${preset}”`, noPresets: 'Brak zapisanych ustawień', noPresetsMessage: 'Zapisz je przy następnym niestandardowym przypomnieniu.',
    } };

return { sessionReminderTranslations };
})();

const Domain_sessionRemotePermissionGrantTranslations = (() => {
type SessionRemotePermissionGrantTranslations = Shared_sessionRemotePermissionGrantTranslations.SessionRemotePermissionGrantTranslations;

const sessionRemotePermissionGrantTranslations = { pl: {
        title: 'Zdalne uprawnienia',
        entryTitle: 'Zdalne uprawnienia',
        entrySubtitle: 'Przeglądaj i cofaj zdalne uprawnienia sesji',
        loadingTitle: 'Wczytywanie zdalnych uprawnień',
        loadingReason: 'Sprawdzamy uprawnienia bieżącego właściciela sesji.',
        emptyTitle: 'Brak zdalnych uprawnień',
        emptyReason: 'Ta sesja nie ma uprawnień do przejrzenia.',
        unavailableTitle: 'Zdalne uprawnienia są niedostępne',
        unavailableReason: 'Sprawdź, czy to bieżący właściciel sesji i czy jego maszyna jest dostępna, a następnie spróbuj ponownie.',
        ownerOnlyTitle: 'Tylko właściciel sesji może zarządzać zdalnymi uprawnieniami',
        ownerOnlyReason: 'Współdzieleni uczestnicy mogą odpowiadać na kwalifikujące się prośby, ale nie mogą przeglądać ani cofać uprawnień właściciela sesji.',
        retry: 'Spróbuj ponownie',
        listTitle: 'Uprawnienia sesji',
        grantActive: ({ actor }) => `Aktywne uprawnienie od ${actor}`,
        grantRevoked: ({ actor }) => `Cofnięte uprawnienie od ${actor}`,
        grantDetail: ({ grantId, sourceRef, sourceRevisionOrEpoch }) => `Uprawnienie ${grantId} · Źródło ${sourceRef} (${sourceRevisionOrEpoch})`,
        revoke: 'Cofnij uprawnienie',
        revoking: 'Cofanie…',
        revokeConfirmTitle: 'Cofnąć zdalne uprawnienie?',
        revokeConfirmBody: ({ identifier }) => `To natychmiast cofnie zdalne uprawnienie dla ${identifier}.`,
        revokeFailedTitle: 'Nie udało się zaktualizować zdalnych uprawnień',
        revokeFailedReason: 'Uprawnienie mogło się zmienić albo maszyna właściciela jest niedostępna. Spróbuj ponownie.',
        loadMore: 'Wczytaj więcej uprawnień',
        loadingMore: 'Wczytywanie kolejnych uprawnień…',
        loadMoreFailedReason: 'Nie udało się wczytać kolejnych uprawnień. Spróbuj ponownie.',
    } } as const satisfies Pick<Readonly<Record<string, SessionRemotePermissionGrantTranslations>>, "pl">;

return { sessionRemotePermissionGrantTranslations };
})();

const Domain_sessionResponsibilityTranslations = (() => {
type SessionResponsibilityTranslations = Shared_sessionResponsibilityTranslations.SessionResponsibilityTranslations;

const en = Shared_sessionResponsibilityTranslations.en;

const sessionResponsibilityTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionResponsibilityTranslations
>, "pl"> = { pl: {
        responsibilitySectionTitle: 'Odpowiedzialność',
        responsibilityRowTitle: 'Odpowiedzialna osoba',
        responsibilityNoOne: 'Nikt',
        responsibilityUnnamedPerson: 'Osoba bez nazwy',
        responsibilityPickerTitle: 'Wybierz osobę odpowiedzialną',
        responsibilitySearchPlaceholder: 'Szukaj osób z dostępem',
        responsibilityAssignToMe: 'Przypisz mnie',
        responsibilityPeopleWithAccess: 'Osoby z dostępem',
        responsibilityAccessHintOwner: 'Właściciel',
        responsibilityNoCandidates: 'Nikt inny nie ma jeszcze dostępu do tej sesji.',
        responsibilityAccessChanged: 'Dostęp się zmienił. Ta osoba nie może już być odpowiedzialna.',
        responsibilityUpdateFailed: 'Happier nie mógł zmienić osoby odpowiedzialnej. Spróbuj ponownie.',
        responsibilityApprovalPending: 'Oczekiwanie na zatwierdzenie. Nic się jeszcze nie zmieniło — osoba odpowiedzialna zostanie zaktualizowana po zatwierdzeniu.',
        responsibilityA11yEditable: ({ name }: { name: string }) =>
            `Osoba odpowiedzialna, ${name}. Zmień osobę odpowiedzialną.`,
        responsibilityA11yReadOnly: ({ name }: { name: string }) => `Osoba odpowiedzialna, ${name}.`,
        responsibilityA11yEmpty: 'Osoba odpowiedzialna, nikt. Zmień osobę odpowiedzialną.',
        responsibilityAssignedToYou: 'Przypisana Tobie',
        responsibilitySharedWithYou: 'Udostępniona Tobie',
    } };

return { sessionResponsibilityTranslations };
})();

const Domain_sessionWorkTranslations = (() => {
const en = Shared_sessionWorkTranslations.en;

const pl: typeof en = {
    workerUpdate: {
        settled: "Zakończono",
        stalled: "Wstrzymano",
        published: "Opublikowano",
        truncated: "Wynik skrócony.",
        wokenBy: ({ count }) => (count === 1 ? 'Wybudzono przez aktualizację' : `Wybudzono przez aktualizacje: ${count}`),
        notFromYou: 'to nie jest twoja wiadomość',
    },
    title: 'Praca',
    subtitle: {
        sessions: ({ count }) => (count === 1 ? '1 sesja' : `${count} sesje`),
        runs: ({ count }) => (count === 1 ? '1 uruchomienie' : `${count} uruchomienia`),
        nothingStarted: 'Nic jeszcze nie uruchomiono',
    },
    states: {
        recent: 'Ostatnie',
    },
    view: {
        a11y: 'Widok pracy',
        list: 'Lista',
        map: 'Mapa',
        expandMap: 'Otwórz mapę obok sesji',
    },
    map: {
        positionUnder: ({ position, total, parent }) => `${position} z ${total} pod ${parent}`,
    },
    actions: {
        makeOrchestrator: 'Ustaw jako orkiestratora',
        makeOrchestratorSubtitle: 'Ta sesja planuje, deleguje i raportuje',
        makeOrchestratorFailed: "Nie udało się ustawić sesji jako orkiestratora",
    },
    putUnder: {
        title: "Umieść pod…",
        subtitle: "Raportuj do innej sesji",
        search: "Znajdź sesję",
        topLevel: "Najwyższy poziom — nie raportuje do nikogo",
        errors: {
            cycle: "Ta sesja już raportuje do tej",
            changed: "Sesja została właśnie przeniesiona. Spróbuj ponownie",
            forbidden: "Nie możesz umieścić jej pod tą sesją",
            failed: "Nie udało się przenieść sesji",
        },
    },
    kinds: {
        session: 'Sesja',
        workflowRun: 'Uruchomienie przepływu',
        backgroundRun: 'Uruchomienie w tle',
    },
    showMore: ({ count }) => `Pokaż jeszcze ${count}`,
    role: {
        none: 'Brak',
        handsOff: 'bez edycji',
        a11y: ({ role }) => `Rola: ${role}. Zmień rolę`,
    },
    empty: {
        title: 'Nie rozpoczęto jeszcze pracy',
        reason: 'Sesje, przepływy pracy i uruchomienia w tle rozpoczęte przez tę sesję pojawią się tutaj, razem ze wszystkim, co wymaga Twojej uwagi.',
    },
    row: {
        a11y: ({ title, status }) => `${title}, ${status}`,
    },
    progress: ({ completed, total }) => `${completed} z ${total}`,
    strip: {
        openInSidebar: 'Otwórz na pasku bocznym',
        stillWorking: ({ count }) => `${count} nadal pracuje`,
        needsYou: ({ count }) => `${count} czeka na Ciebie`,
        a11y: ({ summary }) => `Praca: ${summary}`,
    },
    leadArchived: ({ count }) => `Ta sesja jest zarchiwizowana · ${count} nadal pracuje`,
    runsStale: 'Uruchomienia przepływów pracy mogą być nieaktualne',
    list: {
        level: ({ level }) => `Poziom ${level}`,
        subSessions: ({ count }) => (count === 1 ? '1 podsesja' : `Podsesje: ${count}`),
        reportsWorking: ({ count }) => `${count} pracuje`,
        reportsNeedYou: ({ count }) => `Podsesje czekające na Ciebie: ${count}`,
    },
    archive: {
        alsoArchiveReports: ({ count }) => `Zarchiwizuj też podsesje (${count})`,
        someNotArchivedTitle: ({ count }) => `Nie zarchiwizowano podsesji: ${count}`,
    },
    peek: {
        reportsTo: ({ lead }) => `Raportuje do ${lead}`,
        repliesGoHere: 'Odpowiedzi trafiają do tej sesji',
    },
};

const notify = { pl: { turn: 'Powiadom mnie, gdy ta tura się skończy', attention: 'Powiadom mnie, gdy będę potrzebny', armed: 'Otrzymasz powiadomienie', cancel: 'Anuluj powiadomienie', failed: 'Nie udało się zaktualizować powiadomienia. Spróbuj ponownie.', turnFinished: 'Tura tej sesji się zakończyła.', needsYou: 'Ta sesja potrzebuje Twojej uwagi.', settings: 'Ustawienia powiadomień' } };

const runNotify = { pl: { run: 'Powiadom mnie, gdy się zakończy', runFinished: 'To uruchomienie się zakończyło.', runNeedsYou: 'To uruchomienie wymaga Twojej uwagi.', setup: 'Skonfiguruj powiadomienia' } };

const sessionWorkTranslations = { pl: { ...pl, notify: { ...notify.pl, ...runNotify.pl } } };

return { notify, runNotify, sessionWorkTranslations };
})();

const Domain_settingsConnectionsTranslations = (() => {
type MachineParams = Shared_settingsConnectionsTranslations.MachineParams;

const en = Shared_settingsConnectionsTranslations.en;

const pl = {
    sectionTitle: 'Połączenia',
    sectionDescription: 'Jak twoje urządzenia docierają do twoich maszyn.',
    directTitle: 'Łącz bezpośrednio, gdy to możliwe',
    directOnDescription: 'Podglądy, widoki na żywo i przesyłanie plików idą bezpośrednio między twoimi urządzeniami, gdy mogą się połączyć, a w przeciwnym razie przez Happier.',
    directOffDescription: 'Wszystko idzie przez Happier. Nic nie łączy się bezpośrednio z twoimi maszynami; w tej samej sieci jest to nieco wolniejsze.',
    serverDenied: 'Serwer twojego Home kieruje wszystko przez Happier, więc nie ma tu nic do wyboru.',
    machineSectionTitle: 'Połączenie',
    machineTitle: ({ machine }: MachineParams) => `Połączenie z ${machine}`,
    machineOptionDefault: 'Domyślnie',
    machineOptionDirect: 'Bezpośrednio',
    machineOptionRelay: 'Przez Happier',
    machineDefaultDescription: ({ machine }: MachineParams) => `Zgodnie z kontem: bezpośrednio, gdy ${machine} jest osiągalny, w przeciwnym razie przez Happier.`,
    machineDefaultOffDescription: 'Zgodnie z kontem: zawsze przez Happier.',
    machineDirectDescription: ({ machine }: MachineParams) => `Bezpośrednio, gdy ${machine} jest osiągalny, nawet jeśli konto mówi inaczej.`,
    machineRelayDescription: 'Zawsze przez Happier, nawet w tej samej sieci.',
};

const settingsConnectionsTranslations = { pl };

return { settingsConnectionsTranslations };
})();

const Domain_settingsMachinesTranslations = (() => {
const en = Shared_settingsMachinesTranslations.en;

const pl: typeof en = {
    pageDescription: 'Komputery, na których działają Twoje sesje, i pule, które wybierają spośród nich.',
    thisComputerTitle: 'Ten komputer',
    thisComputerRowSubtitle: 'Usługa w tle i wiersz poleceń',
    thisComputerPageDescription: 'Usługa w tle i wiersz poleceń Happier na tym urządzeniu.',
    setupSectionTitle: 'Konfiguracja',
    setupRowSubtitle: 'Zainstaluj tu Happier i połącz go ze swoim Home.',
    addPageDescription: 'Połącz komputer, aby agenci mogli uruchamiać na nim Twoje sesje.',
    addFromComputerTitle: 'Dodawaj maszyny z komputera',
    addFromComputerDescription: 'Otwórz Happier na komputerze, który chcesz dodać, albo połącz go przez SSH z Happier na komputerze lub w przeglądarce.',
    searchPlaceholder: 'Szukaj maszyn',
    count: ({ count }: { count: number }) => {
        if (count === 1) return '1 maszyna';
        const lastDigit = count % 10;
        const lastTwo = count % 100;
        return lastDigit >= 2 && lastDigit <= 4 && (lastTwo < 12 || lastTwo > 14) ? `${count} maszyny` : `${count} maszyn`;
    },
    daemonTitle: 'Usługa w tle',
    daemonDescription: 'Uruchamia Twoje sesje na tym komputerze i utrzymuje jego połączenie z Home.',
    unreadableTitle: ({ home }: { home: string }) => `Nie udało się odczytać maszyn w ${home}`,
};

const settingsMachinesTranslations = { pl };

return { settingsMachinesTranslations };
})();

const Domain_settingsOverviewTranslations = (() => {
type SettingsOverviewTranslation = Shared_settingsOverviewTranslations.SettingsOverviewTranslation;

const slavicPlural = Shared_settingsOverviewTranslations.slavicPlural;

const settingsOverviewTranslations = { pl: {
        attentionTitle: 'Wymaga uwagi',
        agentNeedsSignIn: ({ agent, machine }) => `${agent} wymaga zalogowania na ${machine}`,
        agentNeedsSignInNoMachine: ({ agent }) => `${agent} wymaga zalogowania`,
        serviceSignInExpired: ({ service }) => `${service}: logowanie wygasło`,
        signIn: 'Zaloguj się',
        signInAgain: 'Zaloguj się ponownie',
        setupTitle: 'Pierwsze kroki',
        setupProgress: ({ done, total }) => `${done} z ${total}`,
        setupActionSaveKey: 'Zapisz klucz',
        setupActionAddMachine: 'Dodaj maszynę',
        setupActionShowQr: 'Pokaż QR',
        setupActionScan: 'Skanuj',
        setupActionPasteLink: 'Wklej link',
        setupActionBrowse: 'Przeglądaj',
        machineUpdateVersions: ({ current, latest }) => `Happier ${current} na tej maszynie · dostępna ${latest}`,
        connectTerminalTitle: 'Połącz terminal',
        connectTerminalSubtitle: 'Zeskanuj kod z terminala albo wklej jego link.',
        quickSettingsTitle: 'Szybkie ustawienia',
        notificationsPushOn: 'Push włączone',
        notificationsPushOff: 'Push wyłączone',
        notificationsQuietHours: 'Godziny ciszy włączone',
        pluginChangesAwaitingReview: ({ count }) => `Zmiany wtyczek czekają na przegląd: ${count}`,
        review: 'Przejrzyj',
        browsePluginsTitle: 'Przeglądaj wtyczki',
        browsePluginsSubtitle: 'Dodaj do Happier narzędzia, panele i integracje.',
        accountServiceSignedIn: ({ service }) => `Zalogowano do ${service}`,
        aboutDescription: 'Wersja, kod źródłowy i warunki prawne (Happier nie jest powiązany z Anthropic).',
        machinesTitle: 'Maszyny',
        machineOnline: 'Online',
        machineOffline: ({ lastSeen }) => `Offline · ostatnio ${lastSeen}`,
        machineUpdateAvailable: 'Dostępna aktualizacja',
        machinesOnlineCount: ({ count }) => `${count} online`,
        machinesOfflineCount: ({ count }) => `${count} offline`,
        machineLastSeen: ({ lastSeen }) => `ostatnio ${lastSeen}`,
        update: 'Aktualizuj',
        asOf: ({ time }) => `Stan na ${time}`,
        usageTitle: 'Użycie',
        usageLeft: ({ percent }) => `Zostało ${percent}%`,
        usageResets: ({ time }) => `reset ${time}`,
        securityTitle: 'Bezpieczeństwo',
        startSessionLabel: 'Rozpocznij sesję',
        saveRecoveryKeyTitle: 'Zapisz klucz odzyskiwania',
        saveRecoveryKeySubtitle: 'Jedyny sposób na odzyskanie zaszyfrowanych danych, gdy stracisz wszystkie urządzenia.',
        addMachineTitle: 'Dodaj maszynę',
        addMachineSubtitle: 'Połącz komputer, na którym działają Twoi agenci.',
        homeGreetingNamed: ({ name }) => `Witaj ponownie, ${name}.`,
        homeStartSection: 'Rozpocznij sesję',
        homeCustomize: 'Dostosuj stronę główną',
        homeCustomizeDescription: 'Wybierz, które sekcje pokazuje strona główna i w jakiej kolejności.',
        homeAlwaysShown: 'Zawsze widoczne',
        homeShowSection: 'Pokazuj',
        homeHideSection: 'Ukryj sekcję',
        homeSectionOptions: 'Opcje sekcji',
        homeResetLayout: 'Przywróć domyślne',
        homeLayoutSectionTitle: 'Strona główna',
        homeAddWidgetsTitle: 'Dodaj widżety',
        homeAddWidgetsDescription: 'Widżety z Twoich wtyczek. Dodaj widżet, aby pojawił się na stronie głównej.',
        homeWidgetFromPlugin: ({ plugin }) => `Z ${plugin}`,
        homeRemoveWidget: 'Usuń ze strony głównej',
    } } satisfies Pick<Readonly<Record<string, SettingsOverviewTranslation>>, "pl">;

return { settingsOverviewTranslations };
})();

const Domain_settingsProfilesRemoteHostsPageTranslations = (() => {
const english = Shared_settingsProfilesRemoteHostsPageTranslations.english;

const translated = Shared_settingsProfilesRemoteHostsPageTranslations.translated;

const settingsProfilesRemoteHostsPageTranslations = { pl: translated({
        settingsProfilesPage: {
            pageDescription: 'Ustawienia startowe nowej sesji: agent, model, zmienne środowiskowe i miejsce uruchomienia.',
            useProfilesSection: 'Wybór profilu',
            useProfilesSectionDescription: 'Wybierz profil przy rozpoczynaniu sesji albo uruchamiaj każdą sesję w środowisku maszyny.',
            useProfiles: 'Używaj profili',
            useProfilesOffDescription: 'Wyłączone. Nowe sesje używają środowiska maszyny.',
            favoritesDescription: 'Wyświetlane jako pierwsze przy wyborze profilu.',
            customDescription: 'Profile utworzone przez Ciebie. Edycja profilu wbudowanego zapisuje tu Twoją kopię.',
            builtInDescription: 'Gotowe profile dla każdego agenta.',
        },
        settingsRemoteHostsPage: {
            pageDescription: 'Hosty SSH, które ten komputer może skonfigurować jako maszyny, z którymi może się połączyć lub na których może uruchomić przekaźnik.',
            savedHostsSection: 'Zapisane hosty',
            savedHostsDescription: "Najpierw ostatnio używane. Otwórz host, aby go użyć lub zmienić.",
            hostPageDescription: "Host SSH, który ten komputer może skonfigurować jako maszynę, z którym może się łączyć lub na którym może uruchomić relay.",
            newHostTitle: "Nowy host zdalny",
            newHostDescription: "Nazwij host i określ, jak dotrzeć do niego przez SSH.",
            useSection: "Użyj tego hosta",
            useSectionDescription: "Co to urządzenie może z nim zrobić.",
            maintenanceSection: "Happier na tym hoście",
            maintenanceSectionDescription: "Instaluj, aktualizuj i uruchamiaj tam wiersz poleceń, usługę w tle i relay Happier.",
            discard: "Odrzuć",
            accessTitle: "Klucze i połączenia",
            accessRowSubtitle: "Zaufane klucze hostów i otwarte tunele",
            accessPageDescription: "Klucze hostów, którym ufa to urządzenie, oraz tunele i drogi dostępu otwarte do twoich hostów.",
            hostNotFound: "Ten host nie jest już zapisany.",
            unavailableDescription: 'Zapisane hosty SSH można skonfigurować jako maszyny lub użyć jako przekaźników.',
            trustedHostKeysDescription: 'Klucze zaakceptowane przez to urządzenie podczas łączenia. Usuń jeden, aby następnym razem znów zostać zapytanym.',
            trustedHostKeysEmpty: 'Brak zaufanych kluczy hosta. Pojawią się tutaj, gdy zaakceptujesz klucz podczas łączenia.',
            sshTunnelsDescription: 'Tunele otwarte z tego urządzenia do zapisanego hosta.',
        },
    }) };

return { settingsProfilesRemoteHostsPageTranslations };
})();

const Domain_settingsProvidersTranslations = (() => {


const withProviderSharedFields = Shared_settingsProvidersTranslations.withProviderSharedFields;

const pl = {
    title: 'Dostawcy', entrySubtitle: 'Połącz lokalne i chmurowe źródła modeli', detailTitle: 'Połączenie z dostawcą', configuredTitle: 'Twoi dostawcy', configuredFooter: 'Modele włączonych dostawców pojawiają się na listach modeli zgodnych agentów.', availableTitle: 'Dostępni', availableFooter: 'Dodaj dostawcę raz, a potem używaj jego modeli ze wszystkimi zgodnymi agentami.', customTitle: 'Własny dostawca', customFooter: 'Połącz bramę firmową lub inny zgodny punkt końcowy modeli.', addCustom: 'Dodaj własnego dostawcę', addCustomDescription: 'Użyj punktu końcowego zgodnego z OpenAI lub Anthropic', emptyTitle: 'Nie połączono jeszcze żadnego dostawcy', emptyDescription: 'Wybierz dostępnego dostawcę poniżej lub dodaj własny punkt końcowy.', unavailable: 'Dostawcy są niedostępni', unavailableDescription: 'Ten serwer nie włączył połączeń z dostawcami.', noMachine: 'Brak dostępnej maszyny', noMachineDescription: 'Połącz maszynę, aby konfigurować i testować dostawców.', problemTitle: 'Dostawca wymaga uwagi', searchPlaceholder: 'Szukaj dostawców',
    status: { available: 'Połączono', notChecked: 'Nie sprawdzono', needsAttention: 'Wymaga uwagi', unreachable: 'Nieosiągalny', disabled: 'Wyłączony', sourceUnavailable: 'Wtyczka niedostępna' }, kind: { frontier: 'Dostawca modeli', aggregator: 'Katalog modeli', cloud: 'Dostawca chmurowy', local: 'Działa na tej maszynie' },
    detail: { pickSecretTitle: 'Wybierz klucz API', notFoundTitle: 'Nie znaleziono dostawcy', notFoundDescription: 'To połączenie z dostawcą już nie istnieje.', deletedDescription: 'Ten dostawca został usunięty. Wybierz inny model przed wznowieniem sesji, które z niego korzystały.', sourceAvailable: 'Wtyczka dostawcy jest dostępna', connectionTitle: 'Połączenie', connectionFooter: 'Określ, gdzie można używać tego dostawcy, i sprawdź jego bieżący stan.', accountAccess: 'Używaj na wszystkich maszynach', accountAccessDescription: 'Dostępny wszędzie, gdzie dostawca wskazuje publiczny punkt końcowy', testConnection: 'Testuj połączenie', testDescription: 'Sprawdź punkt końcowy i odśwież katalog modeli', testSucceeded: 'Połączono pomyślnie', testNotSupported: 'Ten dostawca nie obsługuje automatycznego testu połączenia', machinesTitle: 'Maszyny', machinesFooter: 'Lokalne i prywatne punkty końcowe trzeba włączyć osobno na każdej maszynie.', currentMachine: 'Bieżąca maszyna', selectMachineToManage: 'Wybierz tę maszynę, aby sprawdzić i zmienić jej dostęp', targetMachine: 'Maszyna docelowa', machineOnline: 'Online', machineOffline: 'Offline', apiKeyTitle: 'Klucz API', apiKeyFooter: 'Klucze pozostają w Zapisanych sekretach i nigdy nie są tutaj wyświetlane.', accountApiKey: 'Domyślny klucz API', machineApiKey: 'Klucz API na tej maszynie', apiKeyConfigured: 'Skonfigurowano', apiKeyMissing: 'Dodaj klucz, aby się połączyć', apiKeySelected: 'Wybrano zapisany klucz', useAccountApiKey: 'Używa domyślnego klucza, gdy nie ustawiono klucza maszyny', modelsTitle: 'Modele', manageModels: 'Zarządzaj modelami', modelsUnknown: 'Modele pojawią się po połączeniu', modelCount: ({ count }: { count: number }) => `${count} ${count === 1 ? 'model' : count >= 2 && count <= 4 ? 'modele' : 'modeli'}`, actionsTitle: 'Działania', duplicateTitle: 'Dodaj kolejne połączenie', duplicateDescription: 'Utwórz osobno nazwane połączenie z tym samym dostawcą', deleteTitle: 'Usuń dostawcę', deleteDescription: 'Istniejące sesje zachowają historię, ale nie będzie można ich wznowić z tym dostawcą.', advancedTitle: 'Zaawansowane', endpointDefault: 'Domyślny punkt końcowy', endpointMachine: 'Punkt końcowy na tej maszynie', endpointMachineDescription: 'Zastąp wartość domyślną tylko tam, gdzie ta maszyna uruchamia dostawcę', endpointPrompt: 'Wprowadź pełny bazowy URL dostawcy.', resetEndpoint: 'Resetuj punkt końcowy', resetMachineEndpoint: 'Użyj domyślnego punktu końcowego na tej maszynie', resetDefaultEndpoint: 'Użyj punktu końcowego dostarczonego przez wtyczkę' },
    authoring: { providerTitle: 'Dostawca', builtInDescription: 'Wybierz Zapisany sekret, a następnie połącz dostawcę.', compatibilityTitle: 'Zgodność', compatibilityFooter: 'Wybierz styl API opisany przez dostawcę.', protocolTitle: 'Zgodność API', protocol: { 'openai-responses': { title: 'Zgodny z OpenAI Responses', description: 'Dla bram implementujących interfejs Responses API' }, 'openai-chat': { title: 'Zgodny z OpenAI Chat', description: 'Dla bram implementujących Chat Completions' }, anthropic: { title: 'Zgodny z Anthropic', description: 'Dla bram implementujących interfejs Messages API' } }, detailsTitle: 'Szczegóły dostawcy', name: 'Nazwa', namePlaceholder: 'Brama firmowa', baseUrl: 'Bazowy URL', baseUrlPlaceholder: 'https://gateway.example.com/v1', modelsPath: 'Ścieżka modeli', credentialsTitle: 'Dane uwierzytelniające', credentialsFooter: 'Wybierz Zapisany sekret. Nigdy nie wklejaj klucza API do adresu URL ani nagłówków.', requiresApiKey: 'Wymaga klucza API', requiresApiKeyYes: 'Używaj Zapisanego sekretu w żądaniach', requiresApiKeyNo: 'Połącz bez danych uwierzytelniających', apiKey: 'Klucz API', apiKeyDescription: 'Wybierz lub utwórz Zapisany sekret', credentialStyleTitle: 'Format klucza API', credentialHeader: 'Nazwa nagłówka', credentialStyle: { bearer: 'Token bearer Authorization', xApiKey: 'Nagłówek x-api-key', apiKey: 'Nagłówek api-key', customHeader: 'Własny nagłówek' }, catalogTitle: 'Katalog modeli', catalogFooter: 'Pobieraj modele automatycznie, jeśli punkt końcowy to obsługuje, albo dodaj je później ręcznie.', fetchModels: 'Pobieraj modele automatycznie', fetchModelsYes: 'Użyj punktu końcowego listy modeli dostawcy', fetchModelsNo: 'Dodaj identyfikatory modeli ręcznie', verifyTitle: 'Połącz', verifyFooter: 'Jeśli to możliwe, najpierw przetestuj połączenie, a potem zapisz dostawcę.', save: 'Zapisz dostawcę', connect: 'Połącz dostawcę' },
    errors: { secretMissingTitle: 'Wymagany klucz API', secretMissingDescription: 'Wybierz Zapisany sekret przed włączeniem tego dostawcy.', notEnabledOnMachineTitle: 'Nie włączono na tej maszynie', notEnabledOnMachineDescription: 'Włącz dostawcę na maszynie, na której zostanie uruchomiona sesja.', disabledTitle: 'Dostawca jest wyłączony', disabledDescription: 'Włącz dostawcę przed użyciem jego modeli.', unreachableTitle: 'Dostawca jest nieosiągalny', unreachableDescription: 'Sprawdź, czy usługa działa i czy punkt końcowy jest poprawny, a następnie spróbuj ponownie.', notFoundTitle: 'Nie znaleziono dostawcy', notFoundDescription: 'Ten dostawca został usunięty. Wybierz innego dostawcę lub model.', sourceUnavailableTitle: 'Wtyczka dostawcy jest niedostępna', sourceUnavailableDescription: 'Ponownie włącz lub zainstaluj wtyczkę udostępniającą to połączenie.', featureDisabledTitle: 'Dostawcy są niedostępni', featureDisabledDescription: 'Ten serwer nie włączył połączeń z dostawcami.', unauthorizedTitle: 'Klucz API został odrzucony', unauthorizedDescription: 'Zastąp Zapisany sekret prawidłowym kluczem, a następnie ponownie przetestuj połączenie.', rateLimitedTitle: 'Dostawca ograniczył liczbę żądań', rateLimitedDescription: 'Odczekaj chwilę, a następnie ponownie przetestuj połączenie.', probeCapacityTitle: 'Zbyt wiele sprawdzeń dostawcy naraz', probeCapacityDescription: 'Happier nie mógł jeszcze rozpocząć tego sprawdzenia na wybranej maszynie. Odczekaj chwilę i spróbuj ponownie.', genericTitle: 'Dostawca wymaga uwagi', genericDescription: 'Sprawdź ustawienia dostawcy i spróbuj ponownie.' },
    models: { builtIn: 'Wbudowany', experimental: 'Eksperymentalny', experimentalConfirmTitle: 'Użyć modelu eksperymentalnego?', experimentalConfirmBody: ({ provider, model }: { provider: string; model: string }) => `Model ${model} od ${provider} nie został jeszcze w pełni zweryfikowany z tym agentem. Jeśli nie zadziała prawidłowo, może być konieczny restart lub wybór innego modelu.`, experimentalConfirmAction: 'Użyj modelu', stale: 'Może być niedostępny', hidden: 'Ukryty', manage: 'Zarządzaj modelami', empty: 'Ten dostawca nie udostępnia jeszcze modeli.', add: 'Dodaj modele', addPlaceholder: 'Wprowadź jeden identyfikator modelu w każdym wierszu', resetVisibility: 'Resetuj widoczność', showHidden: 'Pokaż ukryte modele', hideHidden: 'Ukryj ukryte modele', remove: 'Usuń model', removeConfirmation: 'Usunąć ten ręcznie dodany model?', enable: 'Pokaż model', disable: 'Ukryj model', load: 'Załaduj model', retry: 'Spróbuj ponownie', connectionUnavailable: 'Ten dostawca jest niedostępny na wybranej maszynie.' },
};

const localTranslations = { pl: { title: 'Na tej maszynie', footer: 'Lokalne serwery modeli znalezione na tej maszynie. Modele działają prywatnie na Twoim sprzęcie.', detected: 'Wykryto', possible: 'Możliwa usługa', detectedAtPort: ({ port }: { port: string }) => `Wykryto · Port ${port}`, possibleAtPort: ({ provider, port }: { provider: string; port: string }) => `Możliwa usługa ${provider} · Port ${port}`, addConnectionTitle: 'Dodaj kolejne połączenie lokalne', addConnectionDescription: 'Nazwij połączenie, aby odróżnić je od innych lokalnych punktów końcowych.', defaultConnectionName: ({ provider }: { provider: string }) => `${provider} lokalnie` } } as const;

const providerManagedDeploymentTranslations = { pl: {
        configureManaged: 'Uruchamiaj sesje z zarządzaną usługą lokalną',
        configureManagedDescription: 'Wybierz połączone konto lub grupę dla przyszłych sesji. Happier uruchomi usługę, gdy będzie potrzebna.',
        subscriptionPolicyTitle: 'Routing subskrypcji jest eksperymentalny',
        subscriptionPolicyDescription: 'Zasady lub ich egzekwowanie przez dostawcę źródłowego mogą się zmienić i zatrzymać działanie. Happier pokazuje odrzucenie i nie używa po cichu innych danych logowania.',
        accountScopeMismatchTitle: 'Połączone konta należą do aktywnego serwera',
        accountScopeMismatchDescription: 'Ten dostawca jest zarządzany na maszynie innego serwera. Przełącz się na ten serwer, aby wybrać jego połączone konto lub grupę.',
        editManagedDefaults: 'Edytuj ustawienia sesji zarządzanych',
        editManagedDefaultsDescription: 'Zmień połączone konto lub grupę dla przyszłych sesji. Istniejące sesje zachowają wybór.',
        purposeTargetTitle: 'Cel połączonego konta',
        purposeTargetDescription: 'Wybierz dostępne połączone konto lub grupę dla tego celu.',
        invalidPurposeTargetTitle: 'Nieprawidłowy cel konta',
        invalidPurposeTargetDescription: 'Wybierz dostępne połączone konto lub grupę przed zapisaniem.',
        useExternal: 'Użyj usługi zewnętrznej',
        useExternalDescription: 'Wyłącz zarządzanie dostawcą dla przyszłych sesji i użyj konfiguracji zewnętrznego punktu końcowego.',
        useExternalConfirmTitle: 'Użyć usługi zewnętrznej?',
        useExternalConfirmDescription: 'Ustawienia zarządzane zostaną usunięte. Istniejące sesje zachowają wybór.',
    } } as const;

const copyNameTranslations = { pl: ({ name }: { name: string }) => `Kopia ${name}` } as const;

const providerSharedFieldTranslations = { pl: {
        local: { installedNotRunning: 'Zainstalowano, ale nie uruchomiono', appRunningServerOff: 'Aplikacja jest otwarta, ale serwer lokalny jest wyłączony', startManaged: ({ provider }: { provider: string }) => `Uruchom ${provider}`, startedByHappier: 'Uruchomiono przez Happier', runningOutsideHappier: 'Uruchomiono poza Happier' },
        apiKeyOptionalDescription: 'Opcjonalnie — wybierz zapisany sekret, jeśli ten dostawca go wymaga',
        models: { addDescription: 'Dodaj identyfikatory modeli, których dostawca nie wyświetla automatycznie', addHelp: 'Wprowadź jeden dokładny identyfikator modelu w każdym wierszu. Istniejące modele zostaną pominięte.', addFieldLabel: 'Identyfikatory modeli', invalidModelIds: ({ ids }: { ids: string }) => `Te identyfikatory modeli są nieprawidłowe: ${ids}`, noNewModels: 'Brak nowych identyfikatorów modeli do dodania.', providerManagedTitle: 'Modelami zarządza ten dostawca', providerManagedDescription: 'Odśwież katalog dostawcy, aby zaktualizować listę. Ręczne identyfikatory modeli nie są obsługiwane.', showAll: 'Pokaż wszystkie modele', hideAll: 'Ukryj wszystkie modele', hideAllConfirmation: 'Ukryć wszystkie modele na tej liście? Możesz je ponownie wyświetlić w dowolnym momencie.', showOnly: 'Pokaż tylko ten model', showOnlyConfirmation: 'Ukryć wszystkie pozostałe modele na tej liście? Możesz je przywrócić w dowolnym momencie.' },
    } } as const;

const providerFirstSessionValidationTranslations = { pl: 'Happier bezpiecznie sprawdzi połączenie przy uruchomieniu pierwszej sesji, która go używa.' } as const;

const providerMigrationTranslations = { pl: { reviewTitle: 'Sprawdź migrację dostawcy', reviewFooter: 'Sprawdź punkt końcowy, format API, dane logowania i modele przed zastosowaniem zmian.', legacyProfileDescription: 'Ten profil zachowuje starsze trasowanie do czasu potwierdzenia.', credentialTitle: 'Dane logowania', credentialFooter: 'Przenoszone jest tylko odwołanie do zapisanego sekretu; jego wartość nie jest wyświetlana ani kopiowana.', noCredential: 'Bez klucza API', credentialMoveDescription: 'Przenieś te dane do nowego połączenia', noCredentialDescription: 'Utwórz połączenie bez danych logowania', actionsTitle: 'Migracja', preview: 'Sprawdź zmiany', previewDescription: 'Zweryfikuj konfigurację bez zmiany ustawień', confirm: 'Utwórz połączenie dostawcy', confirmDescription: 'Zastosuj zmiany atomowo i zachowaj preferencje uruchamiania', reviewAction: 'Sprawdź migrację dostawcy', reviewActionDescription: 'Przenieś starszy punkt końcowy i modele do połączenia', retainedTitle: 'Zachowano starszą konfigurację', retainedDescription: 'Pozostanie dostępna, dopóki nie będzie można jej przenieść bez utraty funkcji.' } } as const;

const providerMigrationPreviewTranslations = { pl: { willMoveTitle: 'Zostanie przeniesione do dostawcy', willMoveFooter: 'Przeniesione zostaną tylko te nazwy trasowania i danych logowania. Wartości sekretów nigdy nie są wyświetlane.', willKeepTitle: 'Pozostanie w profilu uruchamiania', willKeepFooter: 'Te ustawienia dotyczące wyłącznie uruchamiania pozostaną w profilu po migracji.', permissionDefaults: 'Domyślne uprawnienia', persistenceDefaults: 'Domyślne przechowywanie sesji' } } as const;

const providerMigrationConflictTranslations = { pl: { conflictReviewTitle: 'Rozwiąż konflikt migracji', conflictReviewFooter: 'Wybierz, czy zachować istniejące połączenie, czy zapisać ten profil jako osobne połączenie. Wartości sekretów nie są wyświetlane.', conflictCredential: 'Zapisane dane logowania są inne', conflictModels: 'Ustawienia modeli są inne', conflictEditedConnection: 'Istniejące połączenie zostało zmienione', keepExisting: 'Zachowaj istniejące połączenie', keepExistingDescription: 'Zachowaj jego bieżące dane logowania i modele, a następnie dokończ migrację bez ich zastępowania.', modelOutcomeTitle: 'Wybierz model do zachowania', modelOutcomeFooter: 'Sprawdź dokładny model przed ukończeniem migracji. Nic się nie zmieni, dopóki nie wybierzesz.', useExistingModel: 'Użyj bieżącego modelu połączenia', useExistingModelDescription: 'Zachowaj model już wybrany dla tego połączenia dostawcy.', preserveLegacyModel: 'Użyj modelu profilu', preserveLegacyModelDescription: 'Przenieś dokładny wybór tego profilu do istniejącego połączenia.', discardLegacyModel: 'Usuń wybór modelu profilu', discardLegacyModelDescription: 'Ukończ migrację bez wyboru modelu ani ulubionego ustawienia tego profilu.', createNamed: 'Utwórz osobne połączenie', createNamedDescription: 'Zachowaj ustawienia dostawcy tego profilu w nowym połączeniu.', separateConnectionName: 'Nazwa połączenia', conflictReviewAction: 'Rozwiąż konflikt dostawcy', conflictReviewActionDescription: 'Wybierz sposób zachowania sprzecznych danych logowania lub modeli' } } as const;

const providerCredentialSelectionRequiredTranslations = { pl: 'Wybierz zapisane dane logowania dla tego połączenia dostawcy' } as const;

const providerLinkTranslations = { pl: { providerWebsite: 'Witryna dostawcy', getApiKey: 'Uzyskaj klucz API', failedToOpen: 'Happier nie mógł otworzyć tego linku.' } } as const;

const providerCredentialFormatSelectionRequiredTranslations = { pl: 'Wybierz sposób wysyłania tych danych logowania' } as const;

const providerReservedEnvironmentValidationUnavailableTranslations = { pl: 'Połącz edytor profilu z dostępną maszyną przed zmianą zmiennych środowiskowych.' } as const;

const providerAdvancedAuthoringTranslations = { pl: { advancedSetup: 'Konfiguracja zaawansowana', advancedSetupEnabled: 'Skonfiguruj wiele stylów API, nagłówki i bezpieczne sondy list modeli', advancedSetupDisabled: 'Użyj jednego typowego zgodnego punktu końcowego', endpointEnabled: 'Używaj tego stylu API', endpointEnabledDescription: 'Udostępnij ten punkt końcowy zgodnym agentom', endpointDisabledDescription: 'Ten styl API nie będzie używany', publicHeaders: 'Publiczne nagłówki żądania', publicHeadersPlaceholder: 'X-Tenant: engineering', optionalProbePath: 'Ścieżka listy modeli (opcjonalna)', probeParserTitle: 'Format odpowiedzi', probeParser: { openaiModels: 'Lista modeli zgodna z OpenAI', ollamaTags: 'Tagi Ollama', lmStudioNative: 'Natywna lista modeli LM Studio' } } } as const;

const providerCustomBearerHeaderTranslations = { pl: 'Niestandardowy nagłówek (token Bearer)' } as const;

const providerNonSecretHeaderTranslations = { pl: 'Nagłówki bez poufnych danych' } as const;

const providerProbePathsTranslations = { pl: 'Ścieżki listy modeli (opcjonalne, po jednej w wierszu)' } as const;

const providerLocalAuthoringTranslations = { pl: { enableAfterSaving: 'Włącz tego dostawcę', enableOnCurrentMachine: 'Po zapisaniu włącz tylko na tej maszynie', enableAccountWide: 'Włącz po zapisaniu', localAddressTitle: 'Adres lokalny', localAddressDescription: ({ machine, endpoint }: { machine: string; endpoint: string }) => `Włącz osobno na każdej maszynie. ${machine} użyje ${endpoint}.` } } as const;

const providerAuthoringReviewTranslations = { pl: { destinationReview: 'Miejsce docelowe połączenia', destinationLoading: 'Ustalanie dokładnego miejsca docelowego w daemonie…', destinationSelection: 'Wybierz miejsce docelowe', destinationSelectionDescription: 'Sprawdź dokładny adres przed połączeniem.', destinationScope: 'Zakres miejsca docelowego', destinationMachine: 'Ta maszyna', destinationAccount: 'Konto' } } as const;

const providerCompatibilityTranslations = { pl: { title: 'Działa z', footer: 'Zgodność jest weryfikowana przez każdą integrację agenta i może zależeć od modelu.', verified: 'Zweryfikowano', experimental: 'Eksperymentalne', incompatible: 'Niezgodne', verifiedDescription: 'Przetestowano z tą integracją agenta', experimentalDescription: 'Może działać, ale wymaga sprawdzenia przed pierwszym użyciem', incompatibleDescription: 'Ten agent nie może bezpiecznie użyć tego połączenia' } } as const;

const providerModelNotLoadedTranslations = { pl: 'Nie załadowano · może zostać załadowany przy pierwszym użyciu' } as const;

const providerModelLoadCancellationTranslations = { pl: { cancelLoad: 'Anuluj ładowanie', loadCancelled: 'Zatrzymano oczekiwanie na model', loadCancelledProviderMayContinue: 'Dostawca może nadal go ładować. Odśwież katalog później, aby sprawdzić opóźnione zakończenie; Happier nie powtórzy ładowania.' } } as const;

const providerPartialStatusTranslations = { pl: 'Częściowo dostępny' } as const;

const providerConnectedServiceSuppressedTranslations = { pl: 'Natywne logowanie agenta nie jest używane z tym dostawcą. Zapisany wybór pozostaje bez zmian.' } as const;

const providerMachineCleanupPendingTranslations = { pl: 'Maszyna została usunięta, ale nie udało się zapisać czyszczenia dostępu do dostawców. Sprawdź połączenie i usuń maszynę ponownie, aby ponowić próbę.' } as const;

const providerConnectionChangedTranslations = { pl: { title: 'Połączenie z dostawcą uległo zmianie', description: 'Wczytaj ponownie bieżące ustawienia dostawcy i spróbuj ponownie.' } } as const;

const providerModelSectionTranslations = { pl: { available: 'Dostępne', manual: 'Ręczne' } } as const;

const providerCompletenessTranslations = { pl: {
        searchEmptyTitle: 'Żaden dostawca nie pasuje do wyszukiwania',
        searchEmptyDescription: 'Spróbuj użyć innej nazwy dostawcy lub połączenia.',
        compatibilityReasons: {
            noCompatibleProtocol: 'Ten agent i dostawca nie mają wspólnego obsługiwanego protokołu API.',
            noAuthUnsupported: 'Ten agent wymaga przesyłania klucza API dla tego dostawcy.',
            credentialTransportUnavailable: 'Ten agent nie obsługuje skonfigurowanego sposobu przesyłania klucza API.',
            optionalCredentialNoAuthUnsupported: 'Ten agent nie może używać dostawcy bez opcjonalnego klucza API.',
            capabilityUnsupported: 'Wymagana funkcja dostawcy nie jest obsługiwana.',
            capabilityUnknown: 'Wymagana funkcja dostawcy nie została jeszcze zweryfikowana.',
            modelEvidenceRequired: 'Wybierz model, aby zweryfikować wymagane funkcje.',
            modelCapabilityUnsupported: 'Model nie obsługuje wymaganej funkcji.',
            modelCapabilityUnknown: 'Wymagana funkcja modelu nie została jeszcze zweryfikowana.',
            overrideIncompatible: 'Weryfikacja dostawcy oznacza tę integrację jako niezgodną.',
            overrideExperimental: 'Weryfikacja dostawcy oznacza tę integrację jako eksperymentalną.',
            evidenceMissing: 'Nie zapisano jeszcze danych potwierdzających zgodność.',
            agentUnsupported: 'Ten agent nie obsługuje zewnętrznych dostawców modeli.',
            adapterInvalid: 'Nie udało się zweryfikować adaptera dostawcy dla tego agenta.',
            unknown: 'Nowszy warunek zgodności wymaga sprawdzenia.',
        },
        unsavedDescription: 'Odrzucić ten szkic dostawcy? Zapisane sekrety są współdzielonymi obiektami konta i pozostaną dostępne.',
        recoveryActions: {
            reviewFeatures: 'Sprawdź dostępność dostawców',
            chooseConnection: 'Wybierz dostawcę',
            restorePlugin: 'Sprawdź wtyczkę',
            enableConnection: 'Włącz dostawcę',
            reviewAccountGrant: 'Sprawdź dostęp konta',
            enableOnMachine: 'Włącz na maszynie',
            reviewMachineGrant: 'Sprawdź dostęp maszyny',
            reviewCompatibility: 'Sprawdź zgodność',
            addSecret: 'Dodaj klucz API',
            reviewCredentialTransport: 'Sprawdź obsługę danych uwierzytelniających',
            reviewConnection: 'Sprawdź połączenie',
            retry: 'Spróbuj ponownie',
            replaceSecret: 'Zastąp klucz API',
            chooseModel: 'Wybierz model',
            loadModel: 'Załaduj model',
            reviewAndRestart: 'Sprawdź i uruchom ponownie',
            restartProbe: 'Przetestuj ponownie',
            reduceProviderSettings: 'Zarządzaj ustawieniami dostawców',
            reviewProfileMigration: 'Sprawdź migrację profilu',
            reviewCurrentState: 'Sprawdź bieżące ustawienia',
        },
        hiddenForAllAgents: 'Ukryty dla wszystkich agentów · Zarządzaj w ustawieniach Dostawców',
    } } as const;

const providerAvailabilityTranslations = { pl: {
        availabilityChecking: 'Sprawdzanie dostępności dostawców', availabilityCheckingDescription: 'Happier sprawdza, czy ten serwer obsługuje połączenia z dostawcami.',
        availabilityProblem: 'Nie udało się sprawdzić dostępności dostawców', availabilityProblemDescription: 'Happier spróbuje ponownie automatycznie. Jeśli problem nie ustąpi, sprawdź połączenie z serwerem.',
        availabilityUnsupported: 'Dostawcy wymagają aktualizacji serwera', availabilityUnsupportedDescription: 'Ta wersja serwera nie obsługuje połączeń z dostawcami.',
        availabilityContextUnsupported: 'Dostawcy nie są obsługiwani w tym kontekście', availabilityContextUnsupportedDescription: 'Bieżąca konfiguracja lub wybór serwera nie obsługuje połączeń z dostawcami.',
        availabilityPolicyDisabled: 'Dostawcy są wyłączeni przez zasady', availabilityPolicyDisabledDescription: 'Lokalne zasady lub zasady kompilacji wyłączyły połączenia z dostawcami.',
    } } as const;

const settingsProvidersTranslations = { pl: withProviderSharedFields(pl, {
        providerAvailabilityTranslations: providerAvailabilityTranslations.pl,
        providerLinkTranslations: providerLinkTranslations.pl,
        providerCompletenessTranslations: providerCompletenessTranslations.pl,
        providerPartialStatusTranslations: providerPartialStatusTranslations.pl,
        providerMachineCleanupPendingTranslations: providerMachineCleanupPendingTranslations.pl,
        providerConnectionChangedTranslations: providerConnectionChangedTranslations.pl,
        providerCompatibilityTranslations: providerCompatibilityTranslations.pl,
        providerMigrationTranslations: providerMigrationTranslations.pl,
        providerMigrationPreviewTranslations: providerMigrationPreviewTranslations.pl,
        providerMigrationConflictTranslations: providerMigrationConflictTranslations.pl,
        providerCredentialSelectionRequiredTranslations: providerCredentialSelectionRequiredTranslations.pl,
        providerCredentialFormatSelectionRequiredTranslations: providerCredentialFormatSelectionRequiredTranslations.pl,
        providerReservedEnvironmentValidationUnavailableTranslations: providerReservedEnvironmentValidationUnavailableTranslations.pl,
        localTranslations: localTranslations.pl,
        providerSharedFieldTranslations: providerSharedFieldTranslations.pl,
        providerManagedDeploymentTranslations: providerManagedDeploymentTranslations.pl,
        copyNameTranslations: copyNameTranslations.pl,
        providerFirstSessionValidationTranslations: providerFirstSessionValidationTranslations.pl,
        providerAdvancedAuthoringTranslations: providerAdvancedAuthoringTranslations.pl,
        providerLocalAuthoringTranslations: providerLocalAuthoringTranslations.pl,
        providerAuthoringReviewTranslations: providerAuthoringReviewTranslations.pl,
        providerNonSecretHeaderTranslations: providerNonSecretHeaderTranslations.pl,
        providerProbePathsTranslations: providerProbePathsTranslations.pl,
        providerCustomBearerHeaderTranslations: providerCustomBearerHeaderTranslations.pl,
        providerModelSectionTranslations: providerModelSectionTranslations.pl,
        providerModelLoadCancellationTranslations: providerModelLoadCancellationTranslations.pl,
        providerModelNotLoadedTranslations: providerModelNotLoadedTranslations.pl,
        providerConnectedServiceSuppressedTranslations: providerConnectedServiceSuppressedTranslations.pl,
    }) } as const;

return { localTranslations, providerManagedDeploymentTranslations, copyNameTranslations, providerSharedFieldTranslations, providerFirstSessionValidationTranslations, providerMigrationTranslations, providerMigrationPreviewTranslations, providerMigrationConflictTranslations, providerCredentialSelectionRequiredTranslations, providerLinkTranslations, providerCredentialFormatSelectionRequiredTranslations, providerReservedEnvironmentValidationUnavailableTranslations, providerAdvancedAuthoringTranslations, providerCustomBearerHeaderTranslations, providerNonSecretHeaderTranslations, providerProbePathsTranslations, providerLocalAuthoringTranslations, providerAuthoringReviewTranslations, providerCompatibilityTranslations, providerModelNotLoadedTranslations, providerModelLoadCancellationTranslations, providerPartialStatusTranslations, providerConnectedServiceSuppressedTranslations, providerMachineCleanupPendingTranslations, providerConnectionChangedTranslations, providerModelSectionTranslations, providerCompletenessTranslations, providerAvailabilityTranslations, settingsProvidersTranslations };
})();

const Domain_settingsSearchKeywordsTranslations = (() => {
const english = Shared_settingsSearchKeywordsTranslations.english;

const translated = Shared_settingsSearchKeywordsTranslations.translated;

const settingsSearchKeywordsTranslations = { pl: translated({
        settingsSearchKeywords: {
            settings: 'ustawienia, start, przegląd',
            groupProfileAndAccount: 'konto, profil, rozliczenia, plan, użycie',
            account: 'konto, profil, rozliczenia',
            accountSecurity: 'bezpieczeństwo, hasło, odzyskiwanie, szyfrowanie, wyloguj',
            apiTokens: 'token api, osobisty token dostępu, pat, automatyzacja, cli, sdk',
            teams: 'zespoły, członkowie, grupy, zaproszenia',
            homeAdministration: 'home, administracja, zarządzanie, osoby, zasady',
            secrets: 'sekrety, klucze, env, tokeny',
            usage: 'użycie, rozliczenia, limity, przydział',
            machines: 'maszyny, urządzenia, komputer',
            machinePoolsNew: 'pule maszyn, pule, zapasowe, uruchom na',
            machinesAdd: 'dodaj, maszyna, ssh',
            machinesThisComputer: 'ten komputer, lokalny, urządzenie',
            remoteHosts: 'zdalny, host, hosty, ssh, serwer, maszyny',
            groupGeneral: 'ogólne, wygląd, język, eksperymenty',
            appearance: 'wygląd, motyw, czcionka, interfejs, pasek boczny',
            keyboard: 'klawiatura, skrót, skróty, klawisze skrótu, polecenia',
            pets: 'zwierzaki, blink, towarzysz, codex',
            language: 'język, region, tłumaczenie',
            features: 'funkcje, eksperymenty, beta',
            groupAiAndAgents: 'agenci, dostawcy, mcp, prompty, głos',
            agents: 'dostawcy, agenci, modele, llm',
            providers: 'dostawcy, modele, openrouter, ollama, lm studio',
            subAgent: 'subagenci, agenci, delegowanie, reguły',
            roles: 'role, orkiestrator, wykonawca, recenzent, instrukcje',
            delegation: 'delegowanie, głębokość pracy, przekazanie, orkiestrator',
            profiles: 'profile, persony',
            connectedServices: 'połączone usługi, oauth, konta',
            mcp: 'mcp, narzędzia, serwery, wtyczki',
            plugins: 'wtyczki, plugins, katalog, deskryptor, odkrywanie',
            prompts: 'prompty, szablony, biblioteka',
            promptsTemplates: 'szablony',
            promptsFolders: 'foldery',
            promptsStacks: 'stosy',
            promptsRegistries: 'rejestry',
            promptsLibrary: 'biblioteka',
            promptsAssets: 'zasoby, zewnętrzne',
            voice: 'głos, asystent, mikrofon',
            voiceConversations: 'głos, rozmowa, czas rzeczywisty, dostawca',
            voiceDictation: 'głos, dyktowanie, mowa, transkrypcja',
            voicePrivacy: 'głos, prywatność, historia, przechowywanie',
            voiceAdvanced: 'głos, zaawansowane, maszyna, diagnostyka',
            memory: 'pamięć, wyszukiwanie, indeks',
            groupSessionsBehavior: 'sesje, transkrypcja, uprawnienia, akcje',
            session: 'sesja, terminal, tmux',
            externalSessions: 'sesje zewnętrzne, śledzenie w tle, hooki',
            actions: 'akcje, zatwierdzenia, skróty',
            embeds: 'osadzenia, osadzanie, iframe, widżet, witryna, czat',
            transcript: 'transkrypcja, czat, układ',
            permissions: 'uprawnienia, zatwierdzanie, bezpieczeństwo',
            toolRendering: 'narzędzia, wyświetlanie',
            handoff: 'przekazanie, transfer',
            runs: 'uruchomienia, wykonanie',
            groupFilesAndSourceControl: 'pliki, kontrola wersji, załączniki',
            sourceControl: 'git, scm, kontrola wersji',
            attachments: 'załączniki, przesyłanie, pliki',
            groupSystem: 'system, serwery, stan, powiadomienia',
            servers: 'serwery, przekaźnik',
            systemStatus: 'stan systemu, kondycja, diagnostyka',
            updates: 'aktualizacje, aktualizuj, wersja, cli, uruchom ponownie',
            notifications: 'notif, powiadomienie, powiadomienia, push',
            notificationsPush: 'push, powiadomienia push',
            desktop: 'pulpit, tauri, nakładka, okno',
            diagnosis: 'diagnostyka, debugowanie',
            reportIssue: 'zgłoś problem, błąd, bug',
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
>, "pl"> = { pl: {
        settingsSessionPages: {
            preview: {
                userMessage: 'Napraw niestabilny test ponownego łączenia',
                agentReply: 'Znalezione: licznik ponowień nigdy nie był czyszczony. Naprawione, test przechodzi.',
                thinking: 'Test pada tylko po przekroczeniu czasu, więc licznik ponowień pewnie nadal działa.',
            },
            runtime: {
                pageDescription: 'Jak sesje działają na Twoich maszynach.',
                terminalSection: 'Terminal',
                terminalHostTitle: 'Host terminala dla nowych sesji',
                terminalHostNone: 'Brak',
                tmuxTitle: 'Uruchamiaj sesje w tmux',
                tmuxOn: 'Nowe sesje otwierają się we własnym oknie tmux, więc możesz się do nich podłączyć z terminala.',
                tmuxOff: 'Nowe sesje działają w zwykłej powłoce.',
            },
            wizard: {
                pageDescription: 'Jak kreator nowej sesji układa swoje kroki.',
                wideScreensSection: 'Szerokie ekrany',
                stepsSection: 'Jak każdy krok pokazuje opcje',
                steps: {
                    profiles: 'Profil',
                    backends: 'Agent',
                    models: 'Model',
                    machines: 'Maszyna',
                    paths: 'Folder',
                    permissions: 'Uprawnienia',
                },
            },
            providerLimits: {
                pageDescription: 'Co się dzieje po osiągnięciu limitu użycia dostawcy i ile limitu Ci zostało.',
                recoveryDescription: 'Gdy agent osiągnie limit użycia dostawcy, sesja może poczekać na odnowienie i kontynuować.',
                resumePromptCustom: 'Własny',
                unavailableTitle: 'Niedostępne w tym Home',
                unavailableDescription: 'Wznawianie po limicie użycia i wskaźnik użycia dostawcy nie są włączone w tym Home.',
            },
            resume: {
                pageDescription: 'Jak nieaktywna sesja jest kontynuowana, gdy jej agent nie może jej sam wznowić.',
                strategyRecent: 'Ostatnie wiadomości',
                strategySummary: 'Podsumowanie + ostatnie',
                maxSeedCharsTitle: 'Limit rozmiaru powtórki',
                summaryModelSection: 'Model podsumowania',
                summaryModelDescription: 'Agent i model, które piszą podsumowanie odtwarzane w nowej sesji.',
                handoffSection: 'Przenoszenie sesji',
                handoffLinkDescription: 'Co przenosi się z sesją, gdy przekazujesz ją na inną maszynę.',
            },
            permissions: {
                duringSessionSection: 'W trakcie sesji',
                duringSessionDescription: 'Gdzie pojawiają się prośby o zgodę i kiedy zmiana uprawnień trwającej sesji zaczyna działać.',
                promptSurfaceComposer: 'Przy polu wiadomości',
                applyImmediately: 'Od razu',
                applyNextMessage: 'Przy następnej wiadomości',
                storageUseDefault: 'Domyślny',
            },
            handoff: {
                pageDescription: 'Co przenosi się z sesją, gdy przekazujesz ją na inną maszynę.',
                workspaceSection: 'Pliki obszaru roboczego',
                workspaceDescription: 'Co dzieje się z folderem projektu, gdy sesja przechodzi na inną maszynę.',
                keepUpdated: 'Aktualizuj',
                advancedModeDescription: 'Zastępuje wybór powyżej. Ostrożnie: pliki mogą zostać usunięte lub nadpisane.',
                ignoredExclude: 'Pomiń',
                ignoredIncludeSelected: 'Dołącz wybrane',
            },
            toolRendering: {
                pageDescription: 'Daj wybranym narzędziom więcej lub mniej szczegółów niż domyślnie w transkrypcie.',
                collapsedDescription: 'Ile każde narzędzie pokazuje w transkrypcie, zanim je otworzysz.',
            },
            transcript: {
                advancedTitle: 'Wydajność i czas',
                advancedPageDescription: 'Strumieniowanie, czas animacji i progi przewijania. Wartości domyślne pasują większości osób.',
                advancedMotionOff: 'Animacje transkryptu są wyłączone, więc te ustawienia nic nie zmieniają. Włącz je w Transkrypt › Animacje.',
                toolsSection: 'Narzędzia',
                toolOverridesDescription: 'Daj wybranym narzędziom więcej lub mniej szczegółów.',
                thinkingSummary: 'Podsumowanie',
                thinkingFull: 'Pełne',
                strategyConsecutive: 'Kolejne',
                strategyWholeTurn: 'Cała tura',
                copyMarkdown: 'Markdown',
                copyMarkdownDescription: 'Skopiowane wiadomości zachowują formatowanie i pokazują, kto je napisał.',
                copyPlainDescription: 'Skopiowane wiadomości to zwykły tekst, bez etykiet.',
                motionSubtle: 'Subtelne',
                advancedLinkDescription: 'Strumieniowanie, czas animacji i progi przewijania.',
                pageDescription: 'Jak czyta się rozmowę, gdy rośnie: układ, myślenie, narzędzia, animacje i przewijanie.',
            },
            composer: {
                pageDescription: 'Jak piszesz i wysyłasz wiadomości oraz co się dzieje, gdy agent jest zajęty.',
                newSessionsSection: 'Nowe sesje',
                newSessionsDescription: 'Co widzisz po wybraniu opcji Nowa sesja.',
                draftEntryTitle: 'Po otwarciu nowej sesji',
                draftResume: 'Wznów szkic',
                draftFresh: 'Zacznij od nowa',
                typingSection: 'Pisanie',
                typingDescription: 'Jak działają Enter i historia wiadomości w polu wiadomości.',
                enterToSendTitle: 'Enter wysyła',
                sendModeTitle: 'Gdy agent pracuje',
                sendQueue: 'Kolejka',
                sendInterrupt: 'Przerwij',
                sendPending: 'Oczekujące',
                busySteerTitle: 'Gdy agent przyjmuje wskazówki',
                busySteerInactive: 'Dotyczy tylko sytuacji, gdy wiadomości trafiają do kolejki lub oczekują, kiedy agent pracuje.',
                nonSteerableTitle: 'Pytaj, gdy wiadomość nie może pokierować',
                resumeWhenPossible: 'Gdy to możliwe',
                resumeIfOnline: 'Gdy online',
                resumeNever: 'Nigdy',
                pendingSection: 'Oczekujące wiadomości',
                pendingDescription: 'Jak oczekujące wiadomości docierają do agenta.',
                pendingInactive: 'Przy obecnych ustawieniach nic nie czeka. Te opcje zadziałają, gdy jakaś wiadomość będzie oczekiwać.',
                drainOne: 'Pojedynczo',
                drainAll: 'Wszystkie naraz',
                timingAfterReply: 'Po odpowiedzi',
                timingWhenIdle: 'Gdy wszystko bezczynne',
                layoutSection: 'Układ pola wiadomości',
                actionBarTitle: 'Pasek akcji',
                actionBarAutoDescription: 'Chipy przechodzą do drugiej linii na szerokich ekranach i przewijają się poziomo na telefonie.',
                actionBarWrapDescription: 'Chipy przechodzą do drugiej linii, gdy się nie mieszczą.',
                actionBarScrollDescription: 'Chipy zostają w jednej linii; przewiń, aby zobaczyć resztę.',
                actionBarCollapsedDescription: 'Chipy trafiają do menu, zostawiając najwięcej miejsca na pisanie.',
                chipDensityTitle: 'Chipy akcji',
                chipsAutoDescription: 'Chipy, które tego potrzebują, zachowują etykietę; oczywiste pokazują tylko ikonę.',
                chipsLabelsDescription: 'Każdy chip pokazuje swoją etykietę.',
                chipsIconsDescription: 'Chipy pokazują tylko ikony, aby oszczędzić miejsce.',
            },
        },
    } };

return { settingsSessionPagesTranslations };
})();

const Domain_shareSheetTranslations = (() => {
type ShareSheetTranslations = Shared_shareSheetTranslations.ShareSheetTranslations;

const shareSheetTranslations = { pl: {
        publicLink: { description: "Każdy, kto ma link, może czytać ten dokument bez konta.", grants: "Dokument tylko do odczytu.", audit: "Historia dostępu", auditEmpty: "Nie zarejestrowano jeszcze wizyt.", ownerUpdateRequired: "Właściciel aktualizuje ten link", ownerUpdateRequiredDescription: "Poproś właściciela o otwarcie Happier, a następnie spróbuj ponownie." },
        whoHasAccess: 'Kto ma dostęp',
        whoHasAccessStale: 'Kto ma dostęp · może być nieaktualne',
        owner: 'Właściciel',
        you: 'Ty',
        addPlaceholder: 'Dodaj osoby lub zespoły',
        person: 'Osoba',
        group: 'Grupa zespołu',
        team: 'Zespół',
        accessLevel: 'Poziom dostępu',
        accessibleControl: ({ name, control, value }) => `${name}, ${control}, ${value}`,
        remove: 'Usuń dostęp',
        confirmRemove: 'Potwierdź usunięcie',
        removedAnnouncement: ({ name }) => `${name} nie ma już dostępu`,
        browseAll: 'Przeglądaj wszystko',
        allLoaded: 'Wczytano wszystkie wyniki',
        copyLink: 'Kopiuj link',
        linkCopied: 'Skopiowano link',
        copyLinkFailed: 'Nie udało się skopiować linku.',
        sendCopy: 'Wyślij kopię zamiast tego',
        secrets: {
            levels: { canUse: 'Może używać' },
            help: { use: 'w uruchomieniach; wartość nigdy nie jest pokazywana' },
            oneLevel: 'Zapisany sekret jest używany tylko przez uruchomienia, a jego wartość nigdy nie wychodzi, więc ma jeden poziom.',
        },
        documents: {
            title: 'Udostępnianie',
            shareTitle: ({ name }) => `Udostępnij: ${name}`,
            levels: { canUse: 'Może używać', canRead: 'Może czytać', canEdit: 'Może edytować', admin: 'Zarządzanie' },
            help: {
                workflowUse: 'wyświetlać i uruchamiać',
                roleUse: 'używać; własne zmiany zostają we własnych Ustawieniach',
                profileUse: 'uruchamiać z nim sesje',
                documentUse: 'otwierać i kopiować na dowolnym swoim urządzeniu',
                promptUse: 'używać go w swoich sesjach',
                boardUse: 'widzieć tablicę; każda karta otwiera tylko to, do czego ma już dostęp',
                editForEveryone: 'zmieniać dla wszystkich, którym udostępniono',
                adminOwnerShares: 'zmieniać i zarządzać udostępnianiem; tylko właściciel może przyznać rolę administratora',
            },
            notes: {
                personalRuns: 'Uruchomienia i wyzwalacze zostają u osoby, która je uruchamia.',
                teamRuns: 'Zespół widzi każde uruchomienie.',
                roleLive: 'Twoje zmiany docierają do wszystkich, którym udostępniono.',
                profileSecrets: 'Wartości sekretów nigdy nie są przesyłane · połącz zapisany sekret',
            },
            errors: {
                unavailable: 'Udostępnianie nie jest tu jeszcze dostępne.',
                ownerOnly: 'Tylko właściciel lub administrator może zmienić, kto ma dostęp.',
                noAccess: 'Nie masz już dostępu.',
                notFound: 'To nie jest już dostępne.',
                subjectUnavailable: 'Ta osoba, grupa lub zespół nie może otrzymać dostępu.',
                failed: 'Nie udało się zaktualizować udostępniania. Spróbuj ponownie.',
            },
        },
    } } satisfies Pick<Record<string, ShareSheetTranslations>, "pl">;

return { shareSheetTranslations };
})();

const Domain_sidebarFooterTranslations = (() => {
type SidebarFooterTranslation = Shared_sidebarFooterTranslations.SidebarFooterTranslation;

const sidebarFooterTranslations = { pl: {
        linkToService: ({ service }) => `Połącz z ${service}`,
        addHomeOrSignIn: 'Dodaj Home lub zaloguj się',
        usageNoAccounts: 'Połącz konto, aby zobaczyć, ile zostało z jego limitów.',
        usageHealthy: 'We wszystkich limitach zostało sporo zapasu',
        homeUnreachableTitle: ({ home }) => `Nie można połączyć się z ${home}`,
        homeUnreachableBody: 'Twoje maszyny i sesje pojawią się tu ponownie, gdy odpowie.',
        homeUnreachableLine: ({ home }) => `Nie można połączyć się z ${home}.`,
        availableWhenHomeAnswers: "Dostępne, gdy ten Home odpowie.",
        usageKeysWithoutLimits: ({ count }) => `Klucze bez limitów: ${count}`,
        usageSignedOut: 'Wylogowano',
        hideAccountIdentities: 'Ukryj e-maile i identyfikatory kont',
        accountIdentitiesHidden: 'E-maile i identyfikatory ukryte · na transmisje i pokazy',
        usageThisSession: 'Ta sesja',
        usageAllAccounts: 'Wszystkie konta',
        usageMoreAccounts: ({ count }) => `jeszcze ${count}`,
        usageSessionThroughPool: ({ agent, pool }) => `${agent} loguje się przez ${pool}`,
        usageSessionWithAccount: ({ agent }) => `${agent} loguje się tym kontem`,
        usageSessionOwnSignIn: ({ agent }) => `${agent} używa własnego logowania`,
        usagePoolFallback: 'swoją pulę',
        usageNextInOrder: ({ account }) => `Gdy ${account} się wyczerpie, następna tura przejdzie na kolejne konto w kolejności`,
        usageNextMostLeft: ({ account }) => `Gdy ${account} się wyczerpie, następna tura przejdzie na konto z największym zapasem`,
        usageNextStays: ({ pool, account }) => `${pool} zostaje przy ${account}, dopóki nie przełączysz`,
    } } as const satisfies Pick<Record<string, SidebarFooterTranslation>, "pl">;

return { sidebarFooterTranslations };
})();

const Domain_surfaceStateTranslations = (() => {
type SurfaceStateTranslations = Shared_surfaceStateTranslations.SurfaceStateTranslations;

const surfaceStateTranslations = { pl: {
        stillWaiting: ({ seconds }) => `Wciąż czekamy · ${seconds} s`,
        asOf: ({ time }) => `Stan na ${time}`,
        howItWorks: 'Jak to działa',
        tryAgain: 'Spróbuj ponownie',
        checkAgain: 'Sprawdź ponownie',
        paneFailedTitle: 'Nie udało się wyświetlić tego panelu',
        paneFailedReason: 'Coś poszło nie tak podczas rysowania. Twoja sesja nie jest zagrożona.',
        opening: ({ name }) => `Otwieranie ${name}`,
        couldNotOpen: ({ name }) => `Nie udało się otworzyć ${name}`,
    } } as const satisfies Pick<Record<string, SurfaceStateTranslations>, "pl">;

return { surfaceStateTranslations };
})();

const Domain_teamsTranslations = (() => {
type TeamsTranslationRoot = Shared_teamsTranslations.TeamsTranslationRoot;

const english = Shared_teamsTranslations.english;

const polish: TeamsTranslationRoot = {
    teams: {
        overview: {
            sessionsSubtitle: 'Sesje udostępnione temu zespołowi.',
        },
        pages: {
            credentialCreate: 'Wybierz, co udostępnić, kto może z tego korzystać i jakie są limity.',
            credentialDetail: 'Kto może używać tych danych uwierzytelniających, jak i w jakim zakresie.',
            credentialEdit: 'Zmień, kto może używać tych danych uwierzytelniających, jak i w jakim zakresie.',
            credentialActivity: 'Zmiany tych danych uwierzytelniających i ich autorzy.',
            credentialUsage: 'Ile użyto tych danych uwierzytelniających i kto z nich korzystał.',
            credentialExternalApi: 'Używaj tych danych uwierzytelniających z narzędzi spoza Happier.',
            identityProviderNew: 'Połącz dostawcę tożsamości, przez którego członkowie mogą się logować.',
            identityProviderEdit: 'Zmień sposób połączenia tego dostawcy tożsamości.',
            githubApp: 'GitHub App, której ten zespół używa do dostępu do repozytoriów.',
            githubAppEdit: 'Zmień rejestrację tej GitHub App.',
            authentication: 'Jak członkowie logują się do tego zespołu i kogo przyjmuje.',
            credentials: 'Dane uwierzytelniające dostawców, które zespół udostępnia członkom.',
            directory: 'Grupy osób, które współdzielą sesje, dostęp i dane uwierzytelniające w Home.',
            members: 'Kto należy do tego zespołu i co może robić każda osoba.',
            addMember: 'Dodaj osobę, która ma już konto w tym Home.',
            groups: 'Nazwane grupy członków, z którymi udostępniasz sesje i dane uwierzytelniające.',
            newGroup: 'Nazwij grupę i wybierz, kto do niej należy.',
            invitations: 'Zaproszenia do tego zespołu i dla kogo są przeznaczone.',
            newInvitation: 'Zaproś kogoś do tego zespołu.',
            settings: 'Nazwa, logo, domyślne ustawienia sesji i to, czy zespół jest aktywny.',
        },
        loading: 'Wczytywanie zespołu…',
        title: 'Zespoły',
        entrySubtitle: 'Twórz zespoły, zarządzaj członkami i grupami oraz zapraszaj ludzi.',
        entry: {
            heading: ({ team }: { team: string }) => `Przejdź do ${team}`,
            onHome: ({ home }: { home: string }) => `na ${home}`,
            signInServiceOrigin: ({ service }: { service: string }) => `Zaloguj się przez ${service}`,
            signInServiceUnavailableOrigin: ({ service }: { service: string }) => `Logowanie przez ${service} jest niedostępne`,
            signedInTo: ({ home, account }: { home: string; account: string }) => `Zalogowano w ${home} jako ${account}`,
            unnamedAccount: 'Konto Happier',
            continueWith: ({ method }: { method: string }) => `Kontynuuj z ${method}`,
            providerUnavailableTitle: ({ method }: { method: string }) => `${method} jest niedostępne`,
            providerUnavailableDisabled: 'Administrator Twojego Teamu wyłączył to logowanie. Sprawdź ponownie później.',
            providerUnavailableSetupIncomplete: 'Administrator Twojego Teamu nie dokończył jeszcze konfiguracji tego logowania. Sprawdź ponownie później.',
            providerUnavailableUnavailable: 'Ten Home nie może teraz użyć tego logowania. Sprawdź ponownie później.',
            unknownTargetTitle: 'Ten link nie wskazuje swojego Home',
            unknownTargetBody: 'To urządzenie nie potrafi ustalić, do którego Home należy ten link logowania do Teamu, więc nic nie zostało wysłane. Poproś osobę zarządzającą Teamem o ponowny link.',
            ssoRequiredTitle: 'Ten Team wymaga innej metody logowania',
            ssoRequiredBody: 'Zalogowano Cię w tym Home, ale ten Team akceptuje wyłącznie wymaganą przez siebie metodę logowania. Zaloguj się ponownie tą metodą albo wróć do własnej pracy.',
            invitationUnavailableTitle: 'Tego zaproszenia nie można użyć',
            invitationUnavailableBody: 'Mogło wygasnąć, zostać cofnięte lub już zostać użyte. Samo zalogowanie nie dołącza Cię do Teamu.',
            wrongAccountTitle: 'To konto nie może użyć tego logowania',
            wrongAccountBody: 'Konto lub tożsamość, którymi się zalogowano, nie są tymi, których ten Team oczekuje. Zaloguj się innym kontem lub u innego dostawcy albo wróć do własnej pracy.',
            notProvisionedTitle: 'Ten Team jeszcze Cię nie przyjął',
            notProvisionedBody: 'Samo zalogowanie nie dołącza Cię do tego Teamu. O tym, kto zostaje przyjęty, decyduje administrator; poproś o dostęp lub zaproszenie, a potem spróbuj ponownie.',
            directoryDelayedTitle: 'Twój dostęp jest jeszcze w drodze',
            directoryDelayedBody: 'Ten Team pobiera członków z katalogu, który nie przekazał jeszcze Twojego dostępu. Spróbuj ponownie za jakiś czas albo zapytaj osobę zarządzającą Teamem.',
            accessRemovedTitle: 'Ten Team nie jest dla Ciebie dostępny',
            accessRemovedBody: 'Twój dostęp mógł zostać odebrany albo Team jest obecnie niedostępny w tym Home. Wszystko inne, gdzie jesteś zalogowany, pozostaje bez zmian.',
            providerChangedTitle: 'Ta metoda logowania zmieniła się w trakcie użycia',
            providerChangedBody: 'Administrator zaktualizował tę metodę logowania w trakcie Twojego logowania. Na Twoim koncie nic nie zmieniono. Zacznij od nowa na stronie Teamu, aby zobaczyć aktualne metody.',
            returnToTeamSignIn: 'Wróć do logowania do Teamu',
            returnToHappier: 'Wróć do Happier',
            signInToTeam: 'Zaloguj się do tego zespołu',
            readyStatus: 'Wybierz sposób logowania, aby kontynuować.',
        },
        homeLabel: 'Home',
        role: {
            owner: 'Właściciel',
            admin: 'Administrator',
            member: 'Członek',
            guest: 'Gość',
        },
        roleHelp: {
            owner: 'Jest właścicielem zespołu, może nim zarządzać i zmieniać właścicieli.',
            admin: 'Ma dostęp członka i może zarządzać zespołem.',
            member: 'Domyślnie otrzymuje dostęp przyznany zespołowi.',
            guest: 'Widzi wyłącznie sesje i zasoby udostępnione bezpośrednio temu kontu lub jednej z jego grup.',
        },
        status: {
            active: 'Aktywny',
            suspended: 'Zawieszony',
        },
        history: {
            label: 'Historia sesji',
            allExisting: 'Uwzględnij sesje już udostępnione zespołowi',
            fromMembership: 'Tylko sesje udostępnione po dołączeniu',
            allExistingNamed: ({ name }) => `Uwzględnij sesje już udostępnione ${name}`,
            fromMembershipNamed: ({ name }) => `Tylko sesje udostępnione po dołączeniu do ${name}`,
            scopeNote: 'Dotyczy to całych sesji. Nie ujawnia wyłącznie wiadomości utworzonych po dołączeniu.',
        },
        unavailable: {
            title: 'Zespoły nie są dostępne w tym Home',
            disabled: 'Ten Home ma wyłączone zespoły.',
            updateRequired: 'Ten Home wymaga aktualizacji, aby korzystać z zespołów.',
            offline: 'Ten Home jest w tej chwili nieosiągalny.',
            retry: 'Spróbuj ponownie',
        },
        stale: {
            label: 'Pokazujemy ostatnie znane dane tego Home.',
        },
        errors: {
            generic: 'Operacja nie doszła do skutku. Nic nie zostało zmienione.',
            outcomeUnknown: 'Home mógł wykonać tę zmianę. Odśwież zespół przed ponowną próbą.',
            forbidden: 'Nie masz uprawnień do tej zmiany.',
            notFound: 'Ten zespół nie jest już dostępny.',
            archived: 'Ten zespół jest zarchiwizowany. Przywróć go, aby wprowadzać zmiany.',
            conflict: 'Ktoś zmienił to wcześniej. Sprawdź bieżące wartości i spróbuj ponownie.',
            offline: 'Ten Home jest nieosiągalny, więc zmiana nie została wysłana.',
            invalidName: 'Podaj nazwę o długości od 1 do 80 znaków.',
            invalidDescription: 'Podaj opis o długości do 500 znaków.',
        },
        directory: {
            loading: 'Wczytywanie zespołów…',
            chooseTeamToShare: 'Wybierz zespół, któremu to udostępnisz.',
            noMatches: 'Brak pasujących zespołów',
            noLoadedMatches: 'Brak pasujących wczytanych zespołów',
            searchLoadedPlaceholder: 'Filtruj wczytane zespoły',
            unreachableHomes: 'Brak odpowiedzi',
            searchPlaceholder: 'Szukaj zespołów',
            newTeam: 'Nowy zespół',
            createDenied: ({ homes }: { homes: string }) => `Tylko administratorzy ${homes} mogą tworzyć zespoły. Poproś jednego z nich o utworzenie zespołu lub dodanie cię do zespołu.`,
            createAdministered: ({ names }: { names: string }) => `Zespoły na tym Home tworzą jego administratorzy: ${names}. Poproś o utworzenie zespołu dla ciebie lub o pozwolenie wszystkim na tworzenie zespołów.`,
            createAdministeredUnnamed: 'Zespoły na tym Home tworzą jego administratorzy. Poproś jednego z nich o utworzenie zespołu dla ciebie lub o pozwolenie wszystkim na tworzenie zespołów.',
            createOff: 'Tworzenie zespołów jest wyłączone na tym Home.',
            letEveryoneCreate: 'Pozwól wszystkim tworzyć zespoły',
            namesAnd: ({ names, last }: { names: string; last: string }) => `${names} i ${last}`,
            namesAndOthers: ({ names, count }: { names: string; count: number }) => `${names} i ${count} innych`,
            emptyTitle: 'Nie ma jeszcze zespołów',
            emptyBody: 'Zespół daje grupie osób jedno wspólne miejsce na sesje, ludzi i dostęp.',
            archivedSection: 'Zarchiwizowane zespoły',
            archivedEmpty: 'Brak zarchiwizowanych zespołów',
            archivedEmptyBody: 'Zarchiwizowanie zespołu w jego ustawieniach przenosi go tutaj. Członkowie, grupy i historia są zachowywane.',
            showArchived: 'Pokaż zarchiwizowane',
            hideArchived: 'Ukryj zarchiwizowane',
            archivedBadge: 'Zarchiwizowany',
            rowAccessibilityLabel: ({ name, role, home }: { name: string; role: string; home: string }) => `${name}, ${role}, w ${home}`,
            partialHomes: 'Niektóre Home były nieosiągalne, więc brakuje tu ich zespołów.',
        },
        create: {
            loading: 'Sprawdzanie, gdzie możesz utworzyć zespół…',
            discard: 'Odrzuć',
            detailsSection: 'Zespół',
            logoFailedBody: 'Zespół został utworzony, ale jego logo nie zostało opublikowane. Spróbuj ponownie lub kontynuuj bez niego.',
            title: 'Nowy zespół',
            nameLabel: 'Nazwa',
            namePlaceholder: 'Acme',
            descriptionLabel: 'Opis',
            descriptionPlaceholder: 'Czym zajmuje się ten zespół',
            homeHelp: 'Zespół powstaje w tym Home i tam pozostaje.',
            duplicateNameNote: 'Dwa zespoły mogą mieć tę samą nazwę. Linki i dostęp zawsze wskazują sam zespół.',
            managedOnlyTitle: 'Tworzeniem zespołów w tym Home zarządza administrator',
            managedOnlyBody: 'To administrator tworzy tu zespoły i wybiera pierwszego właściciela.',
            initialOwnerLabel: 'Pierwszy właściciel',
            initialOwnerPlaceholder: 'Szukaj osób w tym Home',
            initialOwnerHelp: 'Utworzenie zespołu dla kogoś innego nie dodaje Cię do niego.',
            initialOwnerRequired: 'Wybierz pierwszego właściciela zespołu. W tym Home administrator wskazuje, kto jest właścicielem nowego zespołu.',
            initialOwnerIneligible: 'Ta osoba nie może już być właścicielem zespołu. Wybierz kogoś innego.',
            submit: 'Utwórz zespół',
            submitting: 'Tworzenie…',
            outcomeUnknown: 'Nie udało się potwierdzić, czy zespół został utworzony. Spróbuj ponownie, aby odzyskać to samo żądanie.',
        },
        tabs: {
            overview: 'Przegląd',
            sessions: 'Sesje',
            members: 'Członkowie',
            groups: 'Grupy',
            invitations: 'Zaproszenia',
            authentication: 'Uwierzytelnianie',
            settings: 'Ustawienia',
        },
        authentication: {
            policy: {
                admissionSection: 'Przyjmowanie',
                admissionHelp: 'W jaki sposób osoby stają się członkami tego zespołu.',
                admissionInviteOnly: 'Tylko z zaproszeniem',
                admissionProvisioned: 'Udostępniane przez katalog',
                admissionJit: 'Automatycznie przy pierwszym logowaniu',
                admissionUnavailable: 'Ten Home nie może jeszcze wymusić tego trybu przyjmowania, więc nic się nie zmieniło.',
                admissionUnavailableReason: {
                    homePolicyUnavailable: 'Ten Home nie udostępnił zespołom tego dostawcy logowania. Administrator Home może to zmienić.',
                    homePolicyProhibited: 'Administrator Home nie zezwala na ten tryb przyjmowania w tym Home.',
                    directorySourceRequired: 'Najpierw dodaj katalog do tego zespołu. Ten tryb przyjmuje osoby, które katalog dostarcza.',
                    directoryProjectionRequired: 'Katalog tego zespołu nie ukończył jeszcze pierwszej synchronizacji. Ten tryb stanie się dostępny po jej zakończeniu.',
                    teamConnectionRequired: 'Najpierw dodaj do tego zespołu połączenie logowania. Przyjmowanie przy pierwszym logowaniu go wymaga.',
                    teamConnectionUnavailable: 'Żadne połączenie logowania tego zespołu nie działa w tej chwili, więc nikt nie mógłby zostać przyjęty podczas logowania.',
                },
                acceptedSection: 'Akceptowane logowanie',
                acceptedHelp: 'Jakie logowanie akceptuje ten zespół, zanim pozwoli na pracę zespołu.',
                acceptedInherit: 'Użyj zasad Home',
                acceptedRestricted: 'Tylko logowanie wybrane poniżej',
                connectionsSection: 'Akceptowane połączenia',
                connectionsEmpty: 'Wybierz co najmniej jedno połączenie logowania albo użyj zasad Home.',
                homeMethodRetained: 'Zachowane z zapisanych zasad',
                repairRequired: 'Nie można odczytać zapisanego ograniczenia logowania',
                repairRequiredHelp: 'Nie jest stosowane tak, jak zapisano. Wybierz poniżej zasadę, aby je zastąpić.',
                conflictBody: 'Zasady logowania zmieniły się w tym Home. Sprawdź je i zastosuj swoją zmianę ponownie.',
                providerTestRequired: 'Przetestuj to połączenie, zanim zespół będzie mógł go wymagać.',
                unavailable: 'Ten Home nie może zaakceptować tych zasad logowania.',
                approvalPending: 'Oczekiwanie na zatwierdzenie',
                connectionOwnerTeam: "Połączenie zespołu",
                connectionOwnerHome: "Metoda logowania Home",
            },
            subtitle: 'Jak członkowie zespołu potwierdzają swoją tożsamość.',
            memberSignIn: {
                section: 'Strona logowania dla członków',
                open: 'Otwórz stronę logowania dla członków',
                copyLink: 'Kopiuj link',
                shareLink: 'Udostępnij link',
                qrLabel: 'Kod QR linku logowania dla członków',
                footer: 'Każdy, kto ma ten link, trafi na stronę logowania tego zespołu. Sam link niczego nie przyznaje: dołączenie nadal podlega polityce przyjmowania do zespołu.',
                unavailable: 'Brak linku do udostępnienia',
                unavailableBody: 'Ten Home nie publikuje adresu internetowego, więc nie istnieje link, który zadziałałby na innym urządzeniu. Administrator Home może go skonfigurować.',
            },
            connectionsSection: 'Połączenia logowania',
            empty: 'Brak połączeń logowania',
            status: {
                unavailable: 'Niedostępne',
                prohibited: 'Zablokowane przez zasady Home',
                notConfigured: 'Nieskonfigurowane',
                settingUp: 'Konfigurowanie',
                connected: 'Aktywne',
                needsAttention: 'Wymaga uwagi',
                disabled: 'Wyłączone',
            },
            mode: {
                signInOnly: 'Tylko logowanie',
                signInTimeGroups: 'Grupy są odświeżane podczas logowania',
            },
            detail: {
                status: 'Stan',
                mode: 'Tryb',
                provider: 'Dostawca',
                restrictions: 'Ograniczenia logowania',
                allowedUsers: 'Dozwoleni użytkownicy',
                allowedDomains: 'Dozwolone domeny e-mail',
                none: 'Brak',
                configuration: 'Konfiguracja',
                organization: 'Organizacja',
                connection: 'Połączenie',
            },
            directory: {
                actions: {
                    section: 'Действия', sync: 'Синхронизировать', pause: 'Приостановить синхронизацию', resume: 'Возобновить синхронизацию', remove: 'Удалить каталог…',
                    pauseTitle: ({ source }: { source: string }) => `Приостановить ${source}?`, pauseBody: 'Новые изменения каталога остановятся. Известный доступ к Team и вклады в Группы сохранятся до возобновления.',
                    removeTitle: ({ source }: { source: string }) => `Удалить ${source}?`, removeBody: ({ teamMembershipsRemoved, groupMembershipsRemoved, groupContributionsRemoved, directoryCreatedGroupsRetained, nativeMembershipsPreserved, nativeGroupContributionsPreserved }: { teamMembershipsRemoved: number; groupMembershipsRemoved: number; groupContributionsRemoved: number; directoryCreatedGroupsRetained: number; nativeMembershipsPreserved: number; nativeGroupContributionsPreserved: number }) => `Будут удалены ${teamMembershipsRemoved} управляемых участий, ${groupMembershipsRemoved} действующих участий в Группах и ${groupContributionsRemoved} вкладов источника. Сохранятся ${directoryCreatedGroupsRetained} созданных каталогом Групп, ${nativeMembershipsPreserved} обычных участий и ${nativeGroupContributionsPreserved} обычных вкладов. Аккаунты не удаляются.`,
                },
                section: "Zarządzane członkostwo",
                overviewSubtitle: "Źródła katalogu synchronizują członkostwo i grupy Zespołu z organizacją zewnętrzną.",
                manageSubtitle: "Przejrzyj połączone źródła katalogu i ich ostatni stan synchronizacji.",
                title: "Synchronizacja katalogu",
                sourcesSection: "Źródła katalogu",
                sourcesLoadMore: "Wczytaj więcej źródeł",
                subtitle: "Zmiany członkostwa są stosowane tylko z kompletnych projekcji serwera.",
                empty: "Brak źródeł katalogu",
                setup: {
                    section: "Dodaj źródło",
                    add: "Wybierz źródło katalogu",
                    options: "Konfiguracja źródła",
                    optionsFooter: "Wybierz dokładny, zweryfikowany katalog lub organizację dostawcy.",
                    loadMore: "Загрузить ещё",
                    empty: "Brak zweryfikowanych źródeł",
                    workos: "Skonfiguruj synchronizację katalogu WorkOS",
                    workosSubtitle: "Otwórz portal administracyjny WorkOS, a następnie wróć, aby wybrać zweryfikowany katalog.",
                    confirmTitle: ({ source }: { source: string }) => `Add ${source}?`,
                    confirmBody: "Happier rozpocznie import tego katalogu po jego dodaniu.",
                },
                people: {
                    section: "Osoby",
                    empty: "Brak aprowizowanych osób",
                    provisioned: "Aprowizowana · Brak konta",
                    boundAccountCount: ({ count }: { count: number | string }) => `Powiązane konta: ${count}`,
                    unboundPeopleCount: ({ count }: { count: number | string }) => `Osoby aprowizowane bez konta: ${count}`,
                    member: "Członek zespołu",
                    unknown: "Osoba bez nazwy",
                    loadMore: "Wczytaj więcej osób",
                    state: {
                        suspended: "Zawieszona",
                        deleted: "Usunięta",
                    },
                },
                kind: {
                    workos: "Synchronizacja katalogu WorkOS",
                    github: "Organizacja GitHub",
                },
                state: {
                    setup: "Wymaga konfiguracji",
                    syncing: "Synchronizowanie",
                    active: "Aktywne",
                    paused: "Wstrzymane",
                    needsAttention: "Wymaga uwagi",
                    initializing: "Konfigurowanie",
                    failed: "Ostatnia synchronizacja nie powiodła się",
                },
                mode: {
                    eventsAndFull: "Zdarzenia i pełne uzgodnienie",
                    fullOnly: "Tylko pełne uzgodnienie",
                },
                freshness: {
                    never_synced: "Nigdy nie synchronizowano",
                    fresh: "Aktualne",
                    stale: "Nieaktualne",
                    unknown: "Nieznane",
                },
                detail: {
                    status: "Stan",
                    sourceType: "Typ źródła",
                    syncSection: "Stan synchronizacji",
                    mode: "Tryb synchronizacji",
                    freshness: "Aktualność",
                    lastSuccess: "Ostatnia udana synchronizacja",
                    nextScheduled: "Następna zaplanowana synchronizacja",
                    attentionSection: "Wymaga uwagi",
                    attentionTitle: "To źródło katalogu wymaga uwagi",
                    attentionRetryable: "Źródło może odzyskać sprawność po naprawieniu połączenia. Odśwież, aby sprawdzić jego stan.",
                    attentionAdmin: "Sprawdź konfigurację źródła, zanim zaczniesz polegać na nowych zmianach katalogu.",
                },
                never: "Nigdy",
                unknown: "Nieznane",
            },
        },
        settings: {
            archiveDescription: 'Archiwizacja usuwa zespół z aktywnych widoków i wstrzymuje dostęp oparty na zespole. Członkowie, grupy i historia zostają zachowane, a zespół można przywrócić.',
            logoSection: 'Logo',
            sessionDefaultsSection: 'Domyślne ustawienia sesji',
            externalSharingSection: 'Udostępnianie na zewnątrz',
            historyDefaultSection: 'Domyślna historia',
            lifecycleSection: 'Cykl życia zespołu',
            saved: 'Zapisano',
        },
        policy: {
            sessionCreationPrivate: 'Domyślnie prywatne',
            sessionCreationTeam: 'Domyślnie udostępniane zespołowi',
            sessionCreationRequired: 'Zawsze udostępniane zespołowi',
            sessionCreationHelp: 'Dotyczy nowych sesji. Istniejące sesje prywatne nie zostaną ujawnione.',
            externalSharingAllowed: 'Każdy, kto może udostępniać',
            externalSharingAdmins: 'Tylko administratorzy zespołu',
            externalSharingDisabled: 'Niedozwolone',
            externalSharingHelp: 'Może zablokować przyszłe udostępnianie. Nie wycofuje kopii już udostępnionych.',
            historyDefaultHelp: 'To wstępnie wybiera opcję dla nowych członków. Nie zmienia historii obecnych członków.',
        },
        logo: {
            add: 'Dodaj logo',
            replace: 'Zmień logo',
            remove: 'Usuń logo',
            removeConfirmTitle: 'Usunąć to logo?',
            removeConfirmBody: 'Zespół znów pokaże swój monogram. W każdej chwili możesz wgrać nowe logo.',
            previewLabel: 'Podgląd logo',
            useAsLogo: 'Użyj jako logo',
            monogramLabel: 'Monogram zespołu',
            tooLarge: 'Ten obraz jest za duży. Wybierz mniejszy.',
            invalidFormat: ({ formats }: { formats: string }) => `Ten plik nie jest obsługiwanym obrazem. Obsługiwane formaty: ${formats}.`,
            failed: 'Logo nie zostało wgrane. Obecne logo pozostaje bez zmian.',
            retry: 'Spróbuj ponownie',
        },
        archive: {
            openSettings: 'Otwórz ustawienia',
            action: ({ name }: { name: string }) => `Zarchiwizuj ${name}`,
            confirmTitle: ({ name }: { name: string }) => `Zarchiwizować ${name}?`,
            confirmBody: ({ name }: { name: string }) => `${name} zniknie z aktywnych widoków. Dostęp oparty na zespole i grupach zostanie zatrzymany, a niewykorzystane linki zapraszające unieważnione. Członkostwa, grupy, zasady i istniejące uprawnienia są zachowywane. Przywrócenie ${name} może ponownie uczynić te zachowane uprawnienia skutecznymi.`,
            restoreAction: ({ name }: { name: string }) => `Przywróć ${name}`,
            restoreTitle: ({ name }: { name: string }) => `Przywrócić ${name}?`,
            restoreBody: () => 'Obecne członkostwa, grupy i zachowane uprawnienia znów staną się aktywne tam, gdzie konta i zasoby nadal na to pozwalają. Unieważnione linki zapraszające nie wrócą.',
            readOnly: 'Ten zespół jest zarchiwizowany. Przywróć go, aby wprowadzać zmiany.',
        },
        members: {
            membershipSection: 'Członkostwo',
            filterLabel: 'Pokaż',
            searchPlaceholder: 'Szukaj członków',
            filterAll: 'Wszyscy',
            filterOwnersAndAdmins: 'Właściciele i administratorzy',
            filterMembers: 'Członkowie',
            filterGuests: 'Goście',
            filterSuspended: 'Zawieszeni',
            emptyTitle: 'Brak pasujących członków',
            emptyBody: 'Zmień filtr albo zaproś kogoś do tego zespołu.',
            add: 'Dodaj członka',
            addTitle: ({ team }: { team: string }) => `Dodaj do ${team}`,
            personLabel: 'Osoba',
            roleLabel: 'Rola',
            personPlaceholder: 'Szukaj osób w tym Home',
            ineligible: 'Już w tym zespole albo konto nie jest aktywne w tym Home.',
            addSubmit: 'Dodaj członka',
            you: 'Ty',
            joined: ({ when }: { when: string }) => `Dołączył(a) ${when}`,
            managedBy: ({ source }: { source: string }) => `Zarządzane przez ${source}`,
            managedReadOnly: 'To członkostwo jest zarządzane w swoim źródle. Zmień je tam.',
            detailManagedBy: 'Zarządzane przez',
            managementTitle: 'Źródło zarządzania',
            managementHelp: 'Zmiana źródła zachowuje to członkostwo, jego rolę, status i historię sesji. Zmienia się tylko to, kto może je zmieniać.',
            managementNative: 'Zarządzane w Happier',
            managementConflict: 'To źródło nie ma jeszcze wolnej tożsamości dla tej osoby. Zsynchronizuj je i spróbuj ponownie.',
            detailOpenSource: 'Otwórz ustawienia źródła',
            encryption: {
                title: 'Dostęp szyfrowany',
                checking: 'Sprawdzanie dostępu szyfrowanego…',
                ready: 'Przygotowane',
                scopeBody: 'Obejmuje to tylko sesje, którymi zarządzasz. Inni menedżerowie sesji mogą nadal musieć przygotować dostęp.',
                pending: 'Wymaga przygotowania',
                prepare: 'Przygotuj dostęp szyfrowany',
                preparing: ({ prepared }: { prepared: number }) => `Przygotowywanie dostępu szyfrowanego · przygotowano ${prepared}`,
                setupRequired: 'Wymagana konfiguracja',
                setupRequiredBody: 'Ta osoba nie dokończyła konfiguracji dostępu szyfrowanego. Historia sesji będzie mogła zostać przygotowana później.',
                notEncrypted: 'Bez szyfrowania',
                plainAccount: 'Konto tej osoby nie używa szyfrowania end-to-end, więc nie ma czego przygotowywać.',
                repairRequired: 'Zaszyfrowany dostęp wymaga naprawy',
                repairBody: 'Niektórych sesji, którymi zarządzasz, nie można przygotować z tego urządzenia. Otwórz je, aby naprawić własny dostęp.',
                nonTransferableBody: 'Niektóre sesje używają starszego formatu szyfrowania, którego nie można udostępnić nowym osobom. Pozostają czytelne dla osób, które już mają do nich dostęp.',
                recipientChanged: 'Konto tej osoby się zmieniło. Trwa ponowne wczytywanie przed kolejnym przygotowaniem.',
                retry: 'Spróbuj ponownie',
                failed: 'Przygotowanie zatrzymało się przed ukończeniem. To, co już przygotowano, zostało zachowane.',
            },
            detailGroups: 'Grupy',
            detailGroupsEmpty: 'Brak grup',
            suspend: 'Zawieś członka',
            suspendTitle: ({ name }: { name: string }) => `Zawiesić ${name}?`,
            suspendBody: 'Dostęp do zespołu i grup zostaje natychmiast wstrzymany. Członkostwo w grupach i przypisania zasobów są zachowywane, a reaktywacja przywraca tylko ten dostęp, który nadal jest ważny. Konto w Home i inne zespoły pozostają bez zmian.',
            reactivate: 'Reaktywuj członka',
            reactivateTitle: ({ name }: { name: string }) => `Reaktywować ${name}?`,
            reactivateBody: 'Dostęp wraca tam, gdzie nadal pozwalają na to członkostwa, grupy i stan konta.',
            remove: 'Usuń z zespołu',
            removeTitle: ({ name }: { name: string }) => `Usunąć ${name}?`,
            removeBody: 'Obecny dostęp do zespołu i grup wygasa. Członkostwa w grupach i uprawnienia związane z okresem członkostwa zostają usunięte. Wcześniejsze autorstwo i już zobaczone treści nie są kasowane. Ponowne dołączenie rozpoczyna nowe członkostwo.',
            lastOwnerBlocked: 'Zespół zachowuje co najmniej jednego aktywnego właściciela. Najpierw wskaż innego właściciela.',
            accountInactive: 'Konto tej osoby nie jest aktywne, więc nie można jej dodać ani uczynić właścicielem.',
            ownerOnlyAction: 'Tylko właściciel zespołu może zmieniać właścicieli.',
            ownerRequiredTitle: 'Potrzebny właściciel',
            ownerRequiredBody: ({ team }: { team: string }) => `${team} potrzebuje aktywnego właściciela do zmian zastrzeżonych dla właściciela.`,
            chooseOwner: 'Wybierz właściciela',
            ownerRequiredNoCandidate: 'Brak uprawnionego członka. Trzeba dodać istniejącego członka albo uzgodnić przekazanie własności.',
        },
        groups: {
            detailsSection: 'Grupa',
            title: 'Grupy',
            emptyTitle: 'Nie ma jeszcze grup',
            emptyBody: 'Grupa to płaski zbiór członków zespołu, którym można udostępniać razem.',
            emptyRosterTitle: 'W tej grupie nie ma jeszcze członków',
            noEligibleCandidatesTitle: 'Nie ma nikogo do dodania',
            noEligibleCandidatesBody: 'Tutaj pojawiają się członkowie zespołu, którzy nie należą jeszcze do tej grupy.',
            create: 'Nowa grupa',
            nameLabel: 'Nazwa',
            namePlaceholder: 'Programiści',
            descriptionPlaceholder: 'Do czego służy ta grupa',
            submit: 'Utwórz grupę',
            nameTaken: 'Grupa o tej nazwie już istnieje w tym zespole.',
            memberCount: ({ count }: { count: number }) => `Członkowie: ${count}`,
            managedBy: ({ source }: { source: string }) => `Zarządzane przez ${source}`,
            membersSection: 'Członkowie grupy',
            addMember: 'Dodaj do grupy',
            removeNative: 'Usuń z grupy',
            removeMemberTitle: ({ name, group }: { name: string; group: string }) => `Usunąć osobę ${name} z grupy ${group}?`,
            removeMemberBody: ({ name, group }: { name: string; group: string }) => `${name} natychmiast traci dostęp wynikający z grupy ${group}. Osoba pozostaje w zespole i możesz ją ponownie dodać do tej grupy.`,
            externalOnlyTitle: 'Zarządzane w swoim źródle',
            externalOnlyBody: ({ source }: { source: string }) => `${source} nadal wskazuje tę osobę, więc pozostaje ona w grupie. Zmień to w ustawieniach tego źródła.`,
            archiveAction: ({ name }: { name: string }) => `Zarchiwizuj ${name}`,
            archiveTitle: ({ name }: { name: string }) => `Zarchiwizować ${name}?`,
            archiveBody: 'Dostęp oparty na grupie zostaje natychmiast wstrzymany. Członkostwo i historia są zachowywane, a przywrócenie grupy może ponownie uczynić te uprawnienia skutecznymi.',
            restoreAction: ({ name }: { name: string }) => `Przywróć ${name}`,
            archivedSection: 'Zarchiwizowane grupy',
            archivedReadOnly: 'Ta grupa jest zarchiwizowana. Przywróć ją, aby wprowadzać zmiany.',
            managedReadOnly: 'Nazwa i cykl życia tej grupy są zarządzane w jej źródle. Członków nadal możesz dodawać tutaj.',
        },
        invitations: {
            emptyTitle: 'Brak zaproszeń',
            emptyBody: 'Zaproś kogoś linkiem albo dodaj osobę, która ma już konto w tym Home.',
            invite: 'Zaproś',
            inviteTitle: ({ team }: { team: string }) => `Zaproś do ${team}`,
            byLink: 'Link',
            byEmail: 'E-mail',
            emailLabel: 'Adres e-mail',
            emailPlaceholder: 'imie@przyklad.pl',
            create: 'Utwórz zaproszenie',
            linkNotice: ({ team, role }: { team: string; role: string }) => `Każdy zalogowany w tym Home, kto ma ten link, może dołączyć do ${team} jako ${role}.`,
            copyLink: 'Kopiuj link',
            copied: 'Link skopiowany',
            qrLabel: 'Kod QR tego linku zapraszającego',
            qrTooLargeFallback: 'Ten link jest za długi na kod QR. Skopiuj go zamiast tego.',
            linkRow: 'Link zapraszający',
            maskedRecipient: ({ email }: { email: string }) => `Dla ${email}`,
            expires: ({ when }: { when: string }) => `Wygasa ${when}`,
            stateActive: 'Aktywne',
            stateAccepted: 'Przyjęte',
            stateRevoked: 'Unieważnione',
            stateExpired: 'Wygasłe',
            deliverySent: 'E-mail wysłany',
            deliveryFailed: 'Nie udało się dostarczyć e-maila',
            deliveryUnknown: 'Nieznany wynik dostarczenia',
            deliveryRetry: 'Ponów',
            deliveryChangeEmail: 'Zmień e-mail',
            emailUnavailable: 'Wysyłka e-maili jest niedostępna w tym Home. Udostępnij link.',
            reissue: 'Utwórz nowy link',
            reissueNotice: 'Ponowne wydanie tworzy nowy link. Poprzedni link przestanie działać.',
            revoke: 'Unieważnij zaproszenie',
            revokeTitle: 'Unieważnić to zaproszenie?',
            revokeBody: 'Link przestaje działać natychmiast. W każdej chwili możesz utworzyć nowy.',
            shareLink: 'Udostępnij link',
            shareUnavailable: 'Udostępnianie nie jest dostępne na tym urządzeniu. Skopiuj zamiast tego link.',
            bearerUnavailable: 'Ten link pokazano raz i nie jest przechowywany. Utwórz nowy link, aby ponownie udostępnić dostęp.',
            linkUnavailableRow: 'Brak linku do udostępnienia',
            linkUnavailableBody: 'Ten Home nie opublikował adresu, na który mogłyby wskazywać linki zaproszenia, więc nie ma czego udostępnić. Poproś administratora Home o opublikowanie adresu albo dodaj osoby z listy Osoby w Team.',
        },
        join: {
            previewLoading: 'Sprawdzamy to zaproszenie…',
            joinAction: ({ team }: { team: string }) => `Dołącz do ${team}`,
            joinWithCurrentAccount: 'Dołącz przy użyciu tego konta',
            addInvitedAddressNotice: ({ email }: { email: string }) => `${email} zostanie dodany do tego konta jako zweryfikowany adres.`,
            useAnotherAccount: 'Użyj innego konta',
            useCurrentAccount: 'Użyj bieżącego konta',
            useAnotherAccountHint: 'Zaloguj się w tym Home bez wylogowywania tego konta.',
            hostedOn: ({ home }: { home: string }) => `Hostowane w ${home}`,
            personalHomeNotice: 'Ten Home działa na komputerze osobistym i może być niedostępny, gdy jest offline.',
            plainStorageNotice: 'Sesje w tym Home są przechowywane bez szyfrowania end-to-end.',
            invitedBy: ({ name }: { name: string }) => `Zaproszenie od ${name}.`,
            roleOffered: ({ role }: { role: string }) => `Zapraszamy Cię jako ${role}.`,
            guestNotice: ({ team }: { team: string }) => `Dołączenie jako gość nie daje dostępu do sesji zespołu ${team}. Elementy muszą zostać udostępnione Tobie albo jednej z Twoich grup.`,
            joinedTitle: 'Dołączono',
            alreadyMemberTitle: 'Jesteś już członkiem',
            openTeam: ({ team }: { team: string }) => `Otwórz ${team}`,
            expiredTitle: 'To zaproszenie wygasło',
            revokedTitle: 'To zaproszenie zostało unieważnione',
            usedTitle: 'To zaproszenie zostało już wykorzystane',
            archivedTitle: 'Ten zespół jest zarchiwizowany',
            inactiveTitle: 'To konto nie może teraz dołączyć',
            invalidTitle: 'Ten link zapraszający jest nieprawidłowy',
            unresolvedHomeTitle: 'Ten link nie wskazuje swojego Home',
            unresolvedHomeBody: 'To urządzenie nie potrafi ustalić, który Home wystawił to zaproszenie, więc nic nie zostało wysłane. Poproś osobę zarządzającą zespołem o nowy link.',
            unknownHomeTitle: 'Tego Home nie ma jeszcze na tym urządzeniu',
            askForNew: 'Poproś osobę zarządzającą zespołem o nowe zaproszenie.',
            mismatchTitle: 'To zaproszenie dotyczy innego adresu',
            signInWithInvited: 'Zaloguj się zaproszonym adresem',
            verifyAddress: 'Zweryfikuj ten adres',
            updateRequiredTitle: 'Ten Home wymaga aktualizacji, aby korzystać z zaproszeń do zespołu',
            offlineTitle: 'Ten Home jest nieosiągalny',
            offlineBody: 'Zaproszenie jest zachowane. Spróbuj ponownie, gdy Home wróci.',
            acceptanceOutcomeUnknown: 'Nie udało się potwierdzić dołączenia. Spróbuj ponownie, aby sprawdzić to samo zaproszenie.',
            retry: 'Spróbuj ponownie',
        },
        credentials: {
            recovery: {
                openSettings: 'Otw\u00f3rz ustawienia po\u015bwiadczenia',
                selectBroker: 'Wybierz lokalizacj\u0119 brokera',
                ownerHandoff: 'Popro\u015b w\u0142a\u015bciciela \u017ar\u00f3d\u0142a o napraw\u0119 tego po\u015bwiadczenia',
                updateApp: 'Zaktualizuj Happier',
                chooseAnother: 'Wybierz inne po\u015bwiadczenie',
            },
            requestPolicy: {
                title: 'Zasady żądań',
                subtitle: 'Ogranicz, o co można prosić te poświadczenia.',
                summaryNone: 'Bez ograniczeń',
                summaryActive: ({ count }: { count: number }) => `Ograniczenia: ${count}`,
                protocolsLabel: 'Formaty żądań',
                protocolsAny: 'Wszystkie, które obsługuje źródło',
                modelsLabel: 'Modele',
                modelsAny: 'Wszystkie modele oferowane przez źródło',
                modelsAllowed: ({ count }: { count: number }) => `Dozwolone: ${count}`,
                effortLabel: 'Wysiłek rozumowania',
                effortAny: 'Wszystkie, które obsługuje źródło',
                catalogUnavailable: 'Wybór dozwolonych modeli nie jest jeszcze możliwy z tego Home. Obecne ustawienia obowiązują, dopóki ich nie usuniesz.',
                clear: 'Usuń wszystkie ograniczenia',
                activeNote: 'Trwająca już sesja nie zostaje zmieniona. Jej następne żądanie musi spełniać nowe zasady.',
                protocol: {
                    openaiResponses: 'OpenAI Responses',
                    openaiChatCompletions: 'OpenAI Chat Completions',
                    anthropicMessages: 'Anthropic Messages',
                },
            },
            directReadiness: {
                title: 'Gotowość dostępu bezpośredniego',
                check: 'Sprawdź gotowość',
                summary: ({ ready, pending }: { ready: number; pending: number }) => `Gotowych: ${ready} · W przygotowaniu: ${pending}`,
                allReady: 'Wszyscy z dostępem bezpośrednim są gotowi.',
                automatic: 'Materiał jest przygotowywany na komputerze, który przechowuje to źródło, gdy tylko będzie online.',
                state: {
                    ready: 'Gotowe',
                    preparing: 'Przygotowywanie dostępu',
                    notDelivered: 'Jeszcze nie dostarczono',
                    recipientBindingChanged: 'Czeka na konfigurację konta szyfrowanego',
                    sourceChanged: 'Źródło się zmieniło — trwa aktualizacja',
                },
            },
            externalApi: {
                title: 'Zewnętrzny dostęp API',
                subtitle: 'Korzystaj z tego dostawcy w zgodnych narzędziach poza Happier.',
                privateTitle: 'Sesje Happier',
                privateDetail: 'Prywatnie przez Happier',
                unavailable: 'Zewnętrzny dostęp API nie jest dostępny w tym Home.',
                publicHttpsRequired: 'Narzędzia zewnętrzne wymagają publicznego adresu HTTPS tego Home.',
                homeDisclosure: 'Surowa treść żądań do dostawcy przechodzi przez publiczny punkt końcowy HTTPS tego Home i może być odczytana przez jego operatora.',
                bearerDisclosure: 'Ten klucz jest sekretem typu bearer. Każdy, kto go posiada, może korzystać z przypisanego dostępu do czasu wygaśnięcia lub unieważnienia klucza.',
                usageDisclosure: 'Happier rejestruje liczbę żądań. Łączne wartości tokenów i kosztów mogą być niepełne, jeśli protokół ich nie raportuje.',
                keysTitle: 'Klucze API',
                authorize: 'Autoryzuj klucz',
                authenticationRequired: 'Przypisany członek musi autoryzować ten klucz, logując się do zespołu.',
                authenticationUnavailable: 'Uwierzytelnianie zespołu jest niedostępne. Poproś administratora o sprawdzenie zasad logowania.',
                keysLoadFailed: 'Nie udało się wczytać kluczy API.',
                keysRetry: 'Spróbuj ponownie wczytać klucze',
                keysEmpty: 'Nie ma jeszcze kluczy',
                keysEmptyBody: 'Utworzenie pierwszego klucza włącza dostęp zewnętrzny; unieważnienie ostatniego go wyłącza.',
                labelPlaceholder: 'Do czego służy ten klucz',
                assignLabel: 'Przypisane do',
                revealTitle: 'Zapisz teraz ten klucz',
                revealBody: 'Nie zostanie pokazany ponownie.',
                revealDismiss: {
                    title: 'Zamknąć bez skopiowania klucza?',
                    body: 'Tego klucza nie będzie można ponownie wyświetlić. Pozostaw go widocznym, dopóki go nie zapiszesz.',
                    confirm: 'Klucz został zapisany',
                    keepVisible: 'Pozostaw klucz widoczny',
                },
                neverUsed: 'Nigdy nieużywany',
                lastUsed: ({ when }: { when: string }) => `Ostatnio użyty ${when}`,
                expiresOn: ({ when }: { when: string }) => `Wygasa ${when}`,
                expired: 'Wygasł',
                revokeTitle: ({ name }: { name: string }) => `Unieważnić ${name}?`,
                revokeBody: 'Narzędzia używające tego klucza natychmiast przestają działać. Sesje Happier pozostają bez zmian.',
                revokeAll: 'Unieważnij wszystkie klucze',
                revokeAllBody: 'Zewnętrzny dostęp API wyłącza się, dopóki nie utworzysz nowego klucza. Sesje Happier pozostają bez zmian.',
            },
            title: 'Wsp\u00f3\u0142dzielone po\u015bwiadczenia',
            subtitle: 'Pozw\u00f3l temu zespo\u0142owi korzysta\u0107 z konta, puli lub dostawcy bez kopiowania ich do konfiguracji ka\u017cdej osoby.',
            emptyTitle: 'Brak wsp\u00f3\u0142dzielonych po\u015bwiadcze\u0144',
            emptyBody: 'Nic nie zosta\u0142o jeszcze udost\u0119pnione temu zespo\u0142owi.',
            forbidden: 'Wsp\u00f3\u0142dzielonymi po\u015bwiadczeniami zarz\u0105dzaj\u0105 w\u0142a\u015bciciele i administratorzy zespo\u0142u.',
            unavailable: 'Ten Home nie oferuje wsp\u00f3\u0142dzielonych po\u015bwiadcze\u0144.',
            approvalPending: 'Czekamy na zatwierdzenie. Zmiany są zachowane do czasu decyzji.',
            approvalDeclined: 'Ta prośba nie została zatwierdzona, więc nic się nie zmieniło.',
            sessionDeniedTitle: 'Współdzielone poświadczenie odrzuciło to żądanie',
            sharedByYou: 'Udost\u0119pnione przez Ciebie',
            providedByTeams: 'Dostarczone przez zespo\u0142y',
            sharedWithYou: 'Udost\u0119pnione Tobie',
            sourceAdministration: { title: 'Udost\u0119pnione zespo\u0142om', empty: 'To \u017ar\u00f3d\u0142o nie jest udost\u0119pnione \u017cadnemu zespo\u0142owi.' },
            source: {
                connectedAccount: 'Po\u0142\u0105czone konto',
                pool: 'Pula połączonych usług',
                providerConnection: 'Po\u0142\u0105czenie dostawcy',
            },
            delivery: {
                brokered: 'Przez brokera',
                direct: 'Dost\u0119p bezpo\u015bredni',
                both: 'Broker + bezpo\u015bredni',
                mixed: 'Mieszane dostarczanie',
            },
            state: {
                available: 'Dost\u0119pne',
                needsAttention: 'Wymaga uwagi',
                disabled: 'Wy\u0142\u0105czone',
            },
            usePolicy: {
                title: 'Udostępnić tę sesję Zespołowi?',
                label: 'Gdzie cz\u0142onkowie mog\u0105 ich u\u017cywa\u0107',
                personalAllowed: 'Dowolna dozwolona sesja',
                teamContextRequired: 'Sesje nale\u017c\u0105ce do tego zespo\u0142u',
                teamVisibilityRequired: 'Sesje widoczne dla tego zespo\u0142u',
                visibilityNote: 'Wybranie tych po\u015bwiadcze\u0144 mo\u017ce udost\u0119pni\u0107 prywatn\u0105 sesj\u0119 zespo\u0142owi po potwierdzeniu przez u\u017cytkownika.',
            },
            selection: {
                activeTransitionUnsupported: 'Ta sesja zaczęła działać, zanim zmiana została zapisana, więc model się nie zmienił. Spróbuj ponownie.',
            },
            detail: {
                sourceLabel: '\u0179r\u00f3d\u0142o',
                brokerLabel: 'Lokalizacja brokera',
                brokerNone: 'Wybierz lokalizację brokera',
                access: 'Dost\u0119p i dostarczanie',
                activity: 'Aktywno\u015b\u0107',
                edit: 'Edytuj',
                notFound: 'Te wsp\u00f3\u0142dzielone po\u015bwiadczenia nie s\u0105 ju\u017c dost\u0119pne.',
                brokerUnnamedMachine: 'Komputer bez nazwy',
                brokerUnnamedPool: 'Pula bez nazwy',
                brokerChosen: 'Wybrana przez właściciela źródła',
                limits: 'Limity',
                usage: 'Zużycie',
            },
            create: {
                title: 'Udostępnij poświadczenie',
                action: 'Udostępnij poświadczenie',
                submit: 'Utwórz udostępnione poświadczenie',
                sourceChoose: 'Wybierz źródło',
                sourceEmpty: 'Nie ma jeszcze czego udostępnić.',
                sourceUnsupported: 'Połączonych kont i połączeń dostawcy nie można jeszcze udostępniać z tego Home.',
                alreadyShared: 'Już udostępnione temu zespołowi',
                poolAccounts: ({ count }: { count: number }) => `${count} kont`,
                notAllowed: 'Ten zespół nie pozwala Ci udostępnić własnego poświadczenia.',
                reviewLabel: 'Podsumowanie',
            },
            edit: {
                title: 'Edytuj wsp\u00f3\u0142dzielone po\u015bwiadczenia',
                nameLabel: 'Nazwa',
                namePlaceholder: 'Nazwij te po\u015bwiadczenia',
                ceilingLabel: 'Ujawnianie bezpo\u015brednie',
                ceilingBrokeredOnly: 'Tylko przez brokera',
                ceilingDirectAllowed: 'Zezw\u00f3l na dost\u0119p bezpo\u015bredni',
                ceilingNote: 'Dost\u0119p bezpo\u015bredni pozwala lokalnym narz\u0119dziom odbiorcy otrzyma\u0107 materia\u0142 po\u015bwiadcze\u0144. Odebranie dost\u0119pu zatrzymuje przysz\u0142e dostarczanie, ale nie usuwa tego, czego proces zewn\u0119trzny ju\u017c u\u017cy\u0142.',
                conflict: 'Te ustawienia zmieni\u0142y si\u0119 gdzie indziej. Prze\u0142aduj, aby zobaczy\u0107 aktualne warto\u015bci przed zapisem.',
            },
            audience: {
                title: 'Dost\u0119p i dostarczanie',
                none: 'Jeszcze nikt',
                everyone: 'Ca\u0142y zesp\u00f3\u0142',
                everyoneOff: 'Brak dost\u0119pu dla ca\u0142ego zespo\u0142u',
                groupCount: ({ count }: { count: number }) => `Grupy: ${count}`,
                memberCount: ({ count }: { count: number }) => `Osoby: ${count}`,
                add: 'Dodaj grupę lub osobę',
                groupsSection: 'Grupy',
                membersSection: 'Osoby',
                remove: 'Odbierz dost\u0119p',
                ceilingBlocked: 'Dost\u0119p bezpo\u015bredni nie jest dozwolony dla tych po\u015bwiadcze\u0144. Najpierw zezw\u00f3l na niego w Edytuj.',
                directTitle: 'Udost\u0119pni\u0107 te po\u015bwiadczenia bezpo\u015brednio?',
                directBody: 'Lokalne narz\u0119dzia wybranych os\u00f3b mog\u0105 otrzyma\u0107 materia\u0142 po\u015bwiadcze\u0144 z tego \u017ar\u00f3d\u0142a. Odebranie dost\u0119pu zatrzymuje przysz\u0142e dostarczanie, ale nie usuwa tego, czego proces zewn\u0119trzny ju\u017c u\u017cy\u0142.',
                directConfirm: 'Udost\u0119pnij bezpo\u015brednio',
                keepBrokered: 'Zostaw przez brokera',
                limitsNote: 'U\u017cycie bezpo\u015brednie odbywa si\u0119 poza Happier i nie jest rejestrowane.',
            },
            directUse: {
                title: 'U\u017cy\u0107 bezpo\u015brednio tych udost\u0119pnionych po\u015bwiadcze\u0144?',
                body: 'Happier mo\u017ce przekaza\u0107 po\u015bwiadczenia lokalnym narz\u0119dziom u\u017cywanym przez t\u0119 sesj\u0119. Kontynuuj tylko wtedy, gdy ufasz tym narz\u0119dziom w zakresie tych po\u015bwiadcze\u0144.',
            },
            delete: {
                action: 'Usu\u0144 wsp\u00f3\u0142dzielone po\u015bwiadczenia',
                title: ({ name }: { name: string }) => `Usun\u0105\u0107 ${name}?`,
                body: 'Cz\u0142onkowie natychmiast trac\u0105 dost\u0119p, a nast\u0119pne \u017c\u0105danie zawiedzie. Materia\u0142u dostarczonego ju\u017c bezpo\u015brednio nie da si\u0119 usun\u0105\u0107.',
            },
            errors: {
                featureDisabled: 'Ten Home nie udost\u0119pnia wsp\u00f3\u0142dzielonych po\u015bwiadcze\u0144.',
                teamAuthenticationRequired: 'Zaloguj si\u0119 do tego zespo\u0142u, zanim przejdziesz dalej.',
                teamAuthenticationPolicyUnavailable: 'Nie uda\u0142o si\u0119 odczyta\u0107 zasad logowania tego zespo\u0142u, wi\u0119c nic nie zosta\u0142o zmienione.',
                memberNotEligible: 'Ta osoba nie mo\u017ce korzysta\u0107 z tego po\u015bwiadczenia.',
                sessionPolicyIncompatible: 'Tego po\u015bwiadczenia nie mo\u017cna u\u017cy\u0107 w tej sesji zgodnie z jego zasadami udost\u0119pniania.',
                brokerUnavailable: 'Maszyna pośrednicząca tych poświadczeń jest teraz nieosiągalna. Spróbuj ponownie, gdy wróci, albo wybierz inne miejsce.',
                sourceOwnerRequired: 'Tylko osoba, która jest właścicielem tego źródła, może wprowadzić tę zmianę.',
                sourceMissing: 'Te poświadczenia nie wskazują już istniejącego źródła. Właściciel musi wybrać źródło ponownie.',
                invalidAudience: 'Te osoby lub grupy nie mogą otrzymać tych poświadczeń.',
                subjectNotInTeam: 'Ta osoba lub grupa nie należy już do tego zespołu.',
                costUnavailable: 'Limit kosztu wymaga ceny dla każdego dozwolonego modelu, a części brakuje. Ogranicz zamiast tego żądania albo tokeny.',
                invalidLimit: 'Sprawdź miarę, okres i wartość maksymalną.',
                limitIdentityImmutable: 'Nie można zmienić, kogo limit dotyczy, co mierzy ani jego okresu. Usuń go i dodaj nowy.',
            },
            limits: {
                groupShared: 'Ta pula jest wsp\u00f3\u0142dzielona przez wszystkich w Grupie.',
                title: 'Limity',
                empty: 'Nie ma jeszcze limitów',
                emptyBody: 'Do czasu dodania limitu każde żądanie jest dozwolone.',
                overshoot: 'Nowe żądania zatrzymują się, gdy zapisane zużycie osiągnie limit. Trwające żądania mogą się dokończyć.',
                directNote: 'Limity obejmują użycie przez pośrednika i zewnętrzne API. Użycie bezpośrednie odbywa się na maszynie odbiorcy i nie jest zapisywane.',
                directOnly: 'Wszyscy z dostępem korzystają z tych poświadczeń bezpośrednio, na własnej maszynie, więc Happier niczego nie zapisuje i żaden limit nie zadziała.',
                requestLimitsOnlyForPersonalUse: 'Limity tokenów pojawiają się, gdy to poświadczenie wymaga kontekstu zespołu. Użycie osobiste dopuszcza też uruchomienia w tle i zewnętrzne API, które raportują tylko żądania, więc tylko limity żądań obejmują każde użycie.',
                add: 'Dodaj limit',
                subjectLabel: 'Dotyczy',
                subject: {
                    resource: 'Całych udostępnionych poświadczeń',
                    eachMember: 'Każdej osoby osobno',
                    group: 'Grupy',
                    member: 'Osoby',
                },
                metricLabel: 'Miara',
                metric: {
                    requests: 'Żądania',
                    tokens: 'Tokeny',
                    cost: 'Koszt',
                },
                costNote: 'Limit kosztu działa tylko wtedy, gdy każdy dozwolony model ma znaną cenę.',
                periodLabel: 'Okres',
                period: {
                    day: 'Dziennie',
                    week: 'Tygodniowo',
                    month: 'Miesięcznie',
                },
                maximumLabel: 'Maksimum',
                maximumPlaceholder: 'Maksimum na okres',
                maximumInvalid: 'Wpisz liczbę całkowitą większą od zera.',
                maximumInvalidCost: 'Wpisz kwotę większą od zera.',
                recorded: ({ recorded, maximum }: { recorded: string; maximum: string }) => `Zapisano ${recorded} z ${maximum}`,
                resetsUtc: ({ when }: { when: string }) => `Zeruje się ${when} UTC`,
                reached: 'Limit osiągnięty',
                disabled: 'Wyłączony',
                remove: 'Usuń limit',
                removeTitle: 'Usunąć ten limit?',
                removeBody: 'Żądania od razu przestają być z nim porównywane. Zapisane zużycie zostaje zachowane.',
                unknownSubject: 'Ktoś spoza tej strony',
            },
            usage: {
                title: 'Zużycie',
                empty: 'W tym okresie nic nie zapisano.',
                rangeLabel: 'Okres',
                brokeredRequests: 'Żądania przez pośrednika',
                directOnlyRequests: 'Żądania liczone są tylko dla użycia przez pośrednika.',
                recordedRequests: 'Zarejestrowane żądania',
                requestIncomplete: 'Uwzględniono tylko żądania zaobserwowane przez Happier.',
                externalObservationsIncomplete: ({ count }: { count: number }) => `${count} ${count === 1 ? 'zewnętrzne żądanie nie ma' : 'zewnętrzne żądania nie mają'} jeszcze zarejestrowanego wyniku.`,
                breakdownRestricted: 'Część podziałów widzą tylko osoby zarządzające poświadczeniami.',
                export: 'Eksportuj CSV',
                exportFailed: 'To urządzenie nie mogło zapisać eksportu.',
                recordedByHappier: 'Zapisane przez Happier.',
                directIncomplete: 'Użycie bezpośrednie odbywa się poza Happier i może nie być uwzględnione.',
                costIncomplete: 'Dla części modeli koszt jest w tym okresie niedostępny.',
                tokenIncomplete: 'Suma tokenów jest niepełna dla tego okresu.',
                tokenUnavailable: 'W tym okresie nie zaobserwowano użycia tokenów.',
                costUnavailable: 'W tym okresie nie zaobserwowano wycenionego użycia.',
                costUnknown: 'Niedostępny',
                breakdownLabel: 'Podziel według',
                breakdownNone: 'Tylko sumy',
                breakdown: {
                    member: 'Osoba',
                    externalApiKey: 'Zewnętrzny klucz API',
                    model: 'Model',
                    session: 'Sesja',
                    sourceMember: 'Konto źródłowe',
                    workerMachine: 'Maszyna robocza',
                    brokerMachine: 'Maszyna pośrednicząca',
                    deliveryMode: 'Dostarczanie',
                },
                limitsTitle: 'Limity w tym okresie',
                sliceSummary: ({ requests, tokens }: { requests: string; tokens: string }) => `${requests} żądań · ${tokens} tokenów`,
            },
            activity: {
                title: 'Aktywno\u015b\u0107',
                empty: 'Brak zarejestrowanych zmian administracyjnych.',
                unknownActor: 'Kto\u015b',
                kind: {
                    resourceCreated: 'Udost\u0119pni\u0142(a) te po\u015bwiadczenia',
                    resourceUpdated: 'Zmieni\u0142(a) ustawienia',
                    audienceChanged: 'Zmieni\u0142(a), kto mo\u017ce ich u\u017cywa\u0107',
                    resourceDeleted: 'Usun\u0105\u0142(\u0119\u0142a) te po\u015bwiadczenia',
                    directDelivered: 'Dostarczy\u0142(a) dost\u0119p bezpo\u015bredni',
                    externalKeyCreated: 'Utworzy\u0142(a) zewn\u0119trzny klucz API',
                    externalKeyRevoked: 'Uniewa\u017cni\u0142(a) zewn\u0119trzny klucz API',
                    limitsChanged: 'Zmieni\u0142(a) limity',
                },
            },
        },
    },
};

const teamsTranslations = { pl: polish };

return { teamsTranslations };
})();

const Domain_terminalWorkspaceTranslations = (() => {
const en = Shared_terminalWorkspaceTranslations.en;

const terminalWorkspaceKeyboardTranslations = Shared_terminalWorkspaceTranslations.terminalWorkspaceKeyboardTranslations;

const terminalWorkspaceTranslations = { pl: en };

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

const pl: ThisComputerConnectionTranslation = {
    connectHome: {
        title: ({ home }: HomeParams) => `Połączyć ten komputer z ${home}?`,
        body: ({ home }: HomeParams) => `${home} będzie mógł uruchamiać sesje na tym komputerze. Home terminala i pozostałe połączenia pozostaną bez zmian.`,
        connect: 'Połącz',
        keep: 'Zachowaj obecne połączenia',
    },
    setupAlreadyRunning: 'Konfiguracja jest już uruchomiona. Poczekaj na jej zakończenie.',
    title: {
        daemon_url_mismatch: 'Usługa w tle działa w innym Home',
        daemon_account_mismatch: 'Usługa w tle używa innego konta',
        daemon_needs_auth: 'Usługa w tle musi się zalogować',
        daemon_not_configured: 'Usługa w tle nie jest jeszcze połączona',
        daemon_not_installed: 'Usługa w tle nie jest zainstalowana',
        daemon_not_running: 'Usługa w tle jest zatrzymana',
    },
    description: {
        daemon_url_mismatch: ({ home, daemonHome }: OtherHomeParams) => `Jest połączona z ${daemonHome}, a nie z ${home}.`,
        daemon_account_mismatch: ({ home, daemonAccount, appAccount }: AccountParams) =>
            `Jest zalogowana w ${home} jako ${daemonAccount}, a nie jako ${appAccount}.`,
        daemon_needs_auth: ({ home }: HomeParams) => `Jest połączona z ${home}, ale nie została jeszcze zatwierdzona.`,
        daemon_not_configured: ({ home }: HomeParams) => `Nie zakończyła jeszcze łączenia z ${home}.`,
        daemon_not_installed: ({ home }: HomeParams) => `Zainstaluj ją, aby połączyć ten komputer z ${home}.`,
        daemon_not_running: ({ home }: HomeParams) => `Uruchom ją, aby ponownie połączyć się z ${home}.`,
    },
    action: {
        daemon_url_mismatch: 'Połącz z tym Home',
        daemon_account_mismatch: ({ appAccount }: { appAccount: string }) => `Przełącz na ${appAccount}`,
        daemon_needs_auth: 'Zaloguj się',
        daemon_not_configured: 'Połącz z tym Home',
        daemon_not_installed: 'Zainstaluj usługę w tle',
        daemon_not_running: 'Uruchom usługę w tle',
    },
    connected: ({ home, appAccount }: { home: string; appAccount: string }) => `Połączono z ${home} jako ${appAccount}.`,
    noComputers: ({ home, appAccount }: { home: string; appAccount: string }) => `${appAccount} nie ma jeszcze komputerów w ${home}.`,
    openThisComputer: 'Sprawdź ten komputer',
    moveConfirm: {
        title: ({ appAccount }: { appAccount: string }) => `Przełączyć ten komputer na ${appAccount}?`,
        body: ({ home, daemonHome, daemonAccount, appAccount }: MoveParams) =>
            `Jego usługa w tle jest zalogowana w ${daemonHome} jako ${daemonAccount}. Po przełączeniu będzie działać dla ${appAccount} w ${home}, a ${daemonAccount} przestanie widzieć ten komputer.`,
        confirm: 'Przełącz',
    },
    cli: {
        title: 'Happier CLI',
        version: ({ version }: { version: string }) => `Wersja ${version}`,
        updateAvailable: ({ version, latestVersion }: { version: string; latestVersion: string }) =>
            `Wersja ${version} · dostępna jest ${latestVersion}`,
        update: 'Aktualizuj',
        progressTitle: 'Aktualizowanie Happier CLI',
        notManaged: ({ origin }: { origin: string }) => `Zainstalowano poza Happier: ${origin}`,
    },
    cliChoice: {
        title: ({ version }: { version: string }) => `Happier CLI ${version} jest już zainstalowany`,
        titleUnknownVersion: 'Happier CLI jest już zainstalowany',
        titleMissing: 'Twój Happier CLI nie jest już zainstalowany',
        body: ({ path }: { path: string }) => `Znajduje się w ${path}. Happier może zainstalować własną kopię, aktualizować ją i ustawić jako pierwszą w PATH albo możesz dalej używać tej.`,
        bodyOutdated: ({ path }: { path: string }) => `Znajduje się w ${path} i jest za stary dla konfiguracji. Happier może zainstalować własną, aktualną kopię i ustawić ją jako pierwszą w PATH albo możesz zachować swoją i zaktualizować ją samodzielnie.`,
        bodyMissing: ({ path }: { path: string }) => `Wybrano zachowanie tego w ${path}, ale już go tam nie ma. Happier może zainstalować własną kopię i ją aktualizować albo możesz zainstalować swój ponownie i dalej go używać.`,
        bodyKeepBlocked: ({ path, link }: { path: string; link: string }) => `Znajduje się w ${path}, ale nowe terminale najpierw uruchamiają CLI Happier przez ${link}, którego Happier nie dodał. Pozwól Happier zarządzać wierszem poleceń albo usuń ${link} i uruchom konfigurację ponownie, aby zachować swój.`,
        notNow: 'Nie teraz',
        manage: 'Niech Happier nim zarządza',
        keep: 'Zachowaj mój',
        unanswered: 'Konfiguracja zatrzymała się przed wprowadzeniem zmian. Wybierz, kto zarządza wierszem poleceń, aby kontynuować.',
        ownMissing: 'Zachowany wiersz poleceń nie jest już zainstalowany. Zainstaluj go ponownie albo pozwól Happier zarządzać wierszem poleceń.',
        managed: 'Zarządzany przez Happier',
        own: ({ path }: { path: string }) => `Twój własny — ${path}`,
        change: 'Zmień, kto zarządza wierszem poleceń',
        keptUpdateTitle: 'Zaktualizuj swój wiersz poleceń',
        keptUpdate: ({ command }: { command: string }) => `Dostępna jest nowsza wersja. Zaktualizuj ją poleceniem ${command}`,
        oldCopyTitle: 'Stary wiersz poleceń',
        oldCopyRemove: ({ path, command }: { path: string; command: string }) => `Nadal zainstalowany w ${path}. Usuń go poleceniem ${command}`,
        oldCopyPath: ({ path }: { path: string }) => `Nadal zainstalowany w ${path}.`,
    },
    servers: {
        title: 'Home obsługiwane przez ten komputer',
        connected: 'Połączono',
        offline: 'Skonfigurowano · Wyłączony',
        attention: 'Wymaga uwagi',
        currentHome: ({ home }: HomeParams) => `${home} · ten Home`,
    },
    removal: {
        uninstallFailedTitle: 'Nie udało się odłączyć tego komputera',
        uninstallFailedBody: ({ home }: HomeParams) => `Nie udało się usunąć usługi w tle tego komputera dla ${home}, więc ${home} zostało zachowane. Spróbuj ponownie albo usuń usługę w Ustawienia › Ten komputer.`,
        inventoryUnavailableTitle: 'Nie udało się sprawdzić tego komputera',
        inventoryUnavailableBody: ({ home }: HomeParams) => `Happier nie mógł odczytać usług w tle tego komputera, więc nie wie, czy ten komputer nadal obsługuje ${home}. Usunąć je z Happier mimo to?`,
        removeAnyway: 'Usuń mimo to',
        userOwnedTitle: 'Ten komputer nadal je obsługuje',
        userOwnedBody: ({ home, service }: RemovalServiceParams) => `${service} zainstalowano poza Happier, więc nadal działa dla ${home}. Usuń ją z terminala, jeśli nie jest już potrzebna.`,
    },
};

const thisComputerConnectionTranslations = { pl };

return { thisComputerConnectionTranslations };
})();

const Domain_transcriptFindTranslations = (() => {
const transcriptFindTranslations = { pl: { searchOlder: 'Szukaj w starszych wiadomościach', partialErrors: 'Nie udało się przeszukać części treści. Wyniki są niepełne.', olderRemaining: 'Starsze wiadomości pozostają nieprzeszukane.', findOpen: 'Otwórz wyszukiwanie', findNext: 'Następne dopasowanie', findPrevious: 'Poprzednie dopasowanie' } } as const;

return { transcriptFindTranslations };
})();

const Domain_turnChangesTranslations = (() => {
type TurnChangesTranslations = Shared_turnChangesTranslations.TurnChangesTranslations;

const en = Shared_turnChangesTranslations.en;

const translated = Shared_turnChangesTranslations.translated;

const turnChangesTranslations = { pl: {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `Edytowane pliki: ${count}`,
                walkThrough: 'Przeprowadź mnie',
                openInFiles: 'Otwórz w Plikach',
                fileCount: ({ count }) => `Pliki: ${count}`,
                fileCountInFolders: ({ count, folders }) => `Pliki: ${count} w folderach: ${folders}`,
                showMore: ({ count }) => `Pokaż jeszcze ${count}`,
                groupA11y: 'Zmiany w tej turze',
            }),
        },
    } } as const;

return { turnChangesTranslations };
})();

const Domain_voiceDiagnosticsConsentTranslations = (() => {
type VoiceDiagnosticsConsentCopy = Shared_voiceDiagnosticsConsentTranslations.VoiceDiagnosticsConsentCopy;

const defineVoiceDiagnosticsConsentTranslation = Shared_voiceDiagnosticsConsentTranslations.defineVoiceDiagnosticsConsentTranslation;

const voiceDiagnosticsConsentTranslations = { pl: defineVoiceDiagnosticsConsentTranslation({
    consentTitle: 'Nagrywać mowę na tym urządzeniu?',
    consentBody: 'Nagrania mowy mogą zawierać prywatne rozmowy i dźwięki tła. Pliki pozostają na urządzeniu, mają prywatne uprawnienia, wygasają automatycznie i nigdy nie są synchronizowane ani dołączane do analityki lub raportów o awariach.',
    consentAction: 'Włącz nagrywanie',
  }) } as const;

return { voiceDiagnosticsConsentTranslations };
})();

const Domain_voiceDiagnosticsTranslations = (() => {

type VoiceDiagnosticsCopy = Shared_voiceDiagnosticsTranslations.VoiceDiagnosticsCopy;

const voiceDiagnosticsConsentTranslations = {...Domain_voiceDiagnosticsConsentTranslations.voiceDiagnosticsConsentTranslations};

const defineVoiceDiagnostics = Shared_voiceDiagnosticsTranslations.defineVoiceDiagnostics;

const voiceDiagnosticsTranslations = { pl: defineVoiceDiagnostics(voiceDiagnosticsConsentTranslations["pl"].diagnostics, {
    title: 'Lokalna diagnostyka mowy',
    footer: 'Domyślnie wyłączone. Nagrania pozostają na wybranej maszynie, dopóki ich samodzielnie nie wyeksportujesz.',
    enabled: 'Nagrywaj lokalne nagrania diagnostyczne',
    enabledSubtitle: 'Przechowuj lokalnie ograniczone wejścia STT i wyjścia TTS na potrzeby diagnostyki',
    sttInput: 'Nagrywaj wejście rozpoznawania mowy',
    ttsOutput: 'Nagrywaj syntezowaną mowę',
    location: 'Lokalizacja przechowywania',
    unavailable: 'Wybrana maszyna niedostępna',
    retention: 'Limity przechowywania',
    retentionDetail: ({ hours, files, megabytes }) => `${hours} godz. · ${files} plików · ${megabytes} MB`,
    deleteAll: 'Usuń wszystkie nagrania diagnostyczne',
    deleteAllSubtitle: 'Natychmiast usuwa nagrania i metadane z wybranej maszyny',
    deleteConfirmTitle: 'Usunąć całą lokalną diagnostykę mowy?',
    deleteConfirmBody: 'Spowoduje to trwałe usunięcie wszystkich diagnostycznych nagrań mowy na wybranej maszynie.',
    deleteAction: 'Usuń wszystko',
    deleteFailed: 'Nie udało się usunąć lokalnych nagrań diagnostycznych. Mogą nadal znajdować się na wybranej maszynie.',
    cleanupRequired: 'Lokalne czyszczenie diagnostyki wymaga uwagi',
    cleanupRequiredSubtitle: 'Część prywatnych plików diagnostycznych mogła pozostać albo nie udało się odczytać lokalnego katalogu. Ponów czyszczenie lub usuń wszystkie nagrania diagnostyczne.',
    captureFailed: 'Rejestrowanie diagnostyki wymaga uwagi',
    captureFailedSubtitle: 'Ostatniego nagrania diagnostycznego nie udało się odczytać ani zapisać. Nie wykryto pozostawionych plików diagnostycznych; gotowość zostanie sprawdzona ponownie przy następnym kwalifikującym się nagraniu głosu.',
    retryCleanup: 'Ponów czyszczenie diagnostyki',
    retryCleanupSubtitle: 'Ponownie sprawdza prywatny magazyn i stosuje jego limity przechowywania',
    cleanupRetryFailed: 'Nie udało się dokończyć czyszczenia. Pliki diagnostyczne mogą nadal znajdować się na wybranej maszynie; ponów próbę lub usuń wszystko po jej ponownym połączeniu.',
    exportTitle: 'Eksport wybranej diagnostyki',
    noArtifacts: 'Na wybranej maszynie nie ma zachowanych nagrań diagnostycznych.',
    exportSttArtifact: 'Eksportuj wejście rozpoznawania mowy',
    exportTtsArtifact: 'Eksportuj syntezowaną mowę',
    exportArtifactAccessibility: 'Eksportuj to lokalne diagnostyczne nagranie mowy',
    exportConfirmTitle: 'Wyeksportować to prywatne nagranie?',
    exportConfirmBody: 'Wybrane nagranie zostanie skopiowane z wybranej maszyny na to urządzenie za pomocą szyfrowanego, jednorazowego transferu. Nigdy nie jest przesyłane automatycznie.',
    exportAction: 'Eksportuj nagranie',
    exportFailed: 'Nie udało się wyeksportować prywatnego nagrania. Nic nie zostało przesłane.',
    backupPolicy: 'Wykluczenie z kopii zapasowych',
    backupPolicyBestEffort: 'Przechowywane w prywatnej pamięci podręcznej wybranej maszyny i oznaczone dla narzędzi kopii zapasowych respektujących standard katalogu pamięci podręcznej. Automatyczne przesyłanie ani synchronizacja nie są realizowane; wykluczenie z kopii zapasowych systemu operacyjnego nie jest gwarantowane.',
    activeIndicator: 'Diagnostyka mowy włączona',
    checkingIndicator: 'Sprawdzanie stanu diagnostyki mowy',
    statusUnknownIndicator: 'Stan diagnostyki mowy jest nieznany',
    shutdownPendingIndicator: 'Zatrzymywanie diagnostyki mowy',
    shutdownFailedIndicator: 'Nie udało się potwierdzić wyłączenia diagnostyki mowy',
    retryShutdown: 'Ponów zatrzymywanie diagnostyki',
    sessionOptOut: 'Nie nagrywaj tej sesji',
    sessionOptOutConfirmTitle: 'Zatrzymać nagrywanie tej sesji?',
    sessionOptOutConfirmBody: 'Diagnostyka mowy pozostanie włączona dla innych sesji, ale nowe nagrania z tej sesji nie będą zapisywane do czasu ponownego uruchomienia aplikacji.',
    sessionOptOutFailed: 'Nie udało się zatrzymać nagrywania na aktywnej maszynie. Ta sesja może być nadal nagrywana; ponów próbę po ponownym połączeniu maszyny.',
    sessionOptOutRetry: 'Ponów zatrzymywanie nagrywania',
  }) } as const;

return { voiceDiagnosticsTranslations };
})();

const Domain_voiceExternalCredentialApprovalTranslations = (() => {
type VoiceExternalCredentialApprovalCopy = Shared_voiceExternalCredentialApprovalTranslations.VoiceExternalCredentialApprovalCopy;

const defineVoiceExternalCredentialApproval = Shared_voiceExternalCredentialApprovalTranslations.defineVoiceExternalCredentialApproval;

const voiceExternalCredentialApprovalTranslations = { pl: defineVoiceExternalCredentialApproval({
    reviewRequired: 'Sprawdź dostęp do poświadczeń',
    recipientApprovalTitle: 'Zezwolić temu dostawcy na użycie Twojego poświadczenia?',
    recipientApprovalBody: 'Sprawdź i zatwierdź zadeklarowane punkty końcowe oraz operacje dostawcy. Jeśli ten kontrakt odbiorcy się zmieni, Happier zachowa Twój wybór, ale zablokuje użycie poświadczenia do czasu ponownego zatwierdzenia.',
    recipientApprovalPackage: ({ title, pluginId, sourceKind, sourceLocator }) =>
      `Pakiet: ${title} (${pluginId}); źródło: ${sourceKind} ${sourceLocator}`,
    recipientApprovalPublisher: ({ trust, identity }) => `Wydawca: ${identity} (${trust})`,
    recipientApprovalPackageSignature: ({ status, keyId }) => `Podpis pakietu: ${keyId} (${status})`,
    recipientApprovalContribution: ({ pluginId, localId }) => `Wkład: ${pluginId}/${localId}`,
    recipientApprovalOperations: 'Zadeklarowane operacje:',
    recipientApprovalOperation: ({ id, purpose, effect }) =>
      `Operacja ${id}: cel ${purpose}; skutek ${effect}`,
    recipientApprovalRequest: ({ method, origin, pathTemplate }) => `Żądanie: ${method} ${origin}${pathTemplate}`,
    recipientApprovalCredential: ({ headerName, format }) =>
      `Nagłówek poświadczenia: ${headerName}; format: ${format}`,
    recipientApprovalBounds: ({ requestMaxBytes, responseMaxBytes }) =>
      `Limity bajtów: żądanie ${requestMaxBytes}; odpowiedź ${responseMaxBytes}`,
    recipientApprovalTrust: { bundled: 'wbudowany', verified: 'zweryfikowany' },
    recipientApprovalEffect: { read: 'odczyt', mutation: 'modyfikacja' },
    recipientApprovalCredentialFormat: { raw: 'surowy', bearer: 'bearer' },
    recipientApprovalConfirm: 'Zatwierdź i zapisz',
  }) } as const;

return { voiceExternalCredentialApprovalTranslations };
})();

const Domain_voiceLocalCredentialTranslations = (() => {
type VoiceLocalCredentialCopy = Shared_voiceLocalCredentialTranslations.VoiceLocalCredentialCopy;

const defineVoiceLocalCredential = Shared_voiceLocalCredentialTranslations.defineVoiceLocalCredential;

const voiceLocalCredentialTranslations = { pl: defineVoiceLocalCredential({
    voiceCredential: {
      setOnAccount: 'Zapisane na Twoim koncie',
      notSetOnAccount: 'Niezapisane na Twoim koncie',
      setOnMachineOverride: ({ machine }) => `Dla ${machine} używane jest nadpisanie poświadczenia konta`,
      notSetWithFallback: ({ machine }) => `Nieustawione dla ${machine}; gdy będzie dostępne, zostanie użyte poświadczenie konta`,
      plainStorageTitle: 'Zapisać klucz API bez szyfrowania end-to-end?',
      plainStorageBody: 'To konto przechowuje ustawienia bez szyfrowania end-to-end. Zapisanie tego klucza API sprawi, że jego jawna treść będzie widoczna dla serwera.',
      plainStorageConfirm: 'Zapisz klucz API',
      deleteAccountBody: 'Usunąć ten zapisany klucz API? Inne powiązania wskazujące ten sam zapisany sekret zachowają go.',
      machineUnavailable: 'Wybierz maszynę wykonawczą głosu, która jest online',
      machineUnavailableTitle: 'Maszyna głosowa niedostępna',
      machineUnavailableBody: 'Zanim zapiszesz lub użyjesz tego poświadczenia, wybierz maszynę wykonawczą głosu, która jest online.',
      statusUnavailable: ({ machine }) => `Status poświadczenia na ${machine} jest niedostępny. Dotknij, aby ponowić.`,
      importAvailable: ({ machine }) => `Wcześniejszy klucz można zaimportować na ${machine}`,
      notSetOnMachine: ({ machine }) => `Nieustawione na ${machine}`,
      setOnMachine: ({ machine, protection }) => `Ustawione na ${machine} · ${protection}`,
      protection: { osProtected: 'Chronione przez system', filePermissions: 'Chronione uprawnieniami plików' },
      importTitle: 'Zaimportować istniejący klucz API?',
      importBody: ({ machine }) => `Skopiuj istniejące zaszyfrowane ustawienie konta na ${machine}. Oryginał pozostanie dostępny na Twoich innych urządzeniach.`,
      importAction: 'Importuj',
      enterNewAction: 'Wprowadź nowy',
      useSavedSecretTitle: 'Użyj zapisanego sekretu',
      useSavedSecretSubtitle: 'Wybierz klucz już zapisany na tym koncie.',
      replaceOrRemoveBody: 'Wprowadź nowy klucz API albo pozostaw pole puste, aby usunąć klucz z tej maszyny.',
      deleteTitle: 'Usunąć klucz API?',
      deleteBody: ({ machine }) => `Usunąć ten klucz API z ${machine}? Dawna wartość współdzielona między urządzeniami, jeśli istnieje, nie zostanie zmieniona.`,
      operationFailed: 'Wybrana maszyna nie mogła zaktualizować tego poświadczenia. Sprawdź, czy jest online, i spróbuj ponownie.',
      newCredentialRequired: ({ machine }) => `Na ${machine} wymagane jest nowe poświadczenie maszyny`,
    },
    openAiCompatEndpoint: {
      executionMachine: ({ machine }) => `Żądania są wykonywane na ${machine}. Localhost odnosi się do tej maszyny.`,
      insecureTitle: 'Zezwolić na niezabezpieczony lokalny HTTP?',
      insecureBody: ({ origin, machine }) => `Zezwolić na wysyłanie poświadczeń przez HTTP do ${origin} z ${machine}? Localhost odnosi się do ${machine}. Akceptowane są tylko adresy pętli zwrotnej i sieci prywatnych; publiczny HTTP jest odrzucany.`,
      allowAction: 'Zezwól na HTTP',
      invalidBody: 'Wprowadź adres HTTPS albo adres HTTP w pętli zwrotnej lub sieci prywatnej, bez nazwy użytkownika, hasła i ciągu zapytania.',
    },
  }) } as const;

return { voiceLocalCredentialTranslations };
})();

const Domain_voiceMomentsTranslations = (() => {
type VoiceMomentsTranslation = Shared_voiceMomentsTranslations.VoiceMomentsTranslation;

const voiceMomentsTranslations = { pl: {
        setupTitle: 'Skonfiguruj głos',
        setupTileSubtitle: 'Rozmawiaj ze swoimi sesjami na głos. Cztery krótkie kroki.',
        setupTileProgress: ({ done, total, next }) => `${done} z ${total} gotowe · ${next}`,
        setupNextService: 'teraz wybierz, kto słucha',
        setupNextReadiness: 'teraz dokończ usługę',
        setupNextMicrophone: 'teraz zezwól na mikrofon',
        setupNextTry: 'teraz wypróbuj',
        setupNextInstalling: 'instalowanie',
        setupStart: 'Skonfiguruj',
        setupContinue: 'Kontynuuj',
        setupDescription: 'Rozmawiaj ze swoimi sesjami na głos: pytaj, co się dzieje, zaczynaj pracę, decyduj skądkolwiek. Cztery kroki; możesz przerwać i wrócić.',
        setupLightCaption: ({ done, total }) => `${done} z ${total} gotowe`,
        setupServiceTitle: 'Wybierz, kto słucha',
        setupServiceDetail: 'Co cię słyszy i odpowiada. Możesz to później zmienić.',
        setupChange: 'Zmień',
        setupReadinessTitle: ({ service }) => `Dokończ konfigurację ${service}`,
        setupReadinessDone: ({ service }) => `${service} jest gotowy`,
        setupReadinessGeneric: 'Usługa',
        setupReadinessTitleGeneric: 'Przygotuj usługę',
        setupReadinessUnknown: 'Otwórz ustawienia, aby sprawdzić, czego jeszcze brakuje.',
        setupReadinessCheck: 'Sprawdź konfigurację',
        setupMicrophoneTitle: 'Zezwól na mikrofon',
        setupMicrophoneDetail: 'Urządzenie zapyta raz. Happier słucha tylko, gdy głos jest włączony, i zawsze to widać.',
        setupMicrophoneAction: 'Zezwól na mikrofon',
        setupMicrophoneDone: 'Mikrofon dozwolony',
        setupMicrophoneDeniedTitle: 'Mikrofon jest wyłączony dla Happier',
        setupMicrophoneDeniedDetail: 'Włącz go w ustawieniach systemu i wróć tutaj.',
        setupOpenSystemSettings: 'Otwórz ustawienia',
        setupTryTitle: 'Wypróbuj',
        setupTryDetail: 'Zapytaj „Co robią moje sesje?”. Twoje słowa trafią do rozmowy jak każda wiadomość.',
        setupTryAction: 'Wypróbuj',
        setupTryDone: 'Wypróbowano',
        setupTryNeedsService: 'Dostępne, gdy usługa będzie gotowa.',
        setupDoneTitle: 'Głos jest gotowy',
        setupDoneBody: 'Stuknij przycisk głosu w dowolnym czacie, aby zacząć mówić, i ponownie, aby zakończyć. Wyciszenie jest obok Zakończ podczas rozmowy.',
        setupGestureTap: 'Stuknij',
        setupGestureStartEnd: 'start · koniec',
        setupGestureAnywhere: 'start · koniec z każdego miejsca',
        setupDoneAction: 'Gotowe',
        setupSettingsAction: 'Ustawienia głosu',
        setupClose: 'Zamknij',
        needsYouEnded: 'Głos zakończony. Zatwierdzenie nadal czeka w skrzynce.',
        needsYouReview: 'Sprawdź prośbę',
        needsYouTapToDecide: 'Przeczytane na głos · zdecyduj tutaj, nie głosem',
        briefMe: 'Wprowadź mnie',
        briefMeA11y: 'Wprowadź mnie: głos czyta, co cię potrzebuje, co się nie udało i co jest gotowe',
        briefNeedsYou: 'Czeka na ciebie',
        briefFailed: 'Nieudane',
        briefReady: 'Gotowe',
        briefIncomplete: 'Nie wszystko się jeszcze załadowało, więc może to nie być wszystko.',
        briefCaughtUp: 'Teraz nic na ciebie nie czeka.',
        briefNotSpoken: 'Głos nie może teraz tego odczytać. Cała lista jest tutaj.',
        briefStop: 'Zatrzymaj',
        continueTitle: 'Kontynuuj rozmowę tutaj',
        continueDetail: ({ device }) => `Rozmawiałeś na ${device}`,
        continueAction: 'Kontynuuj',
        continuedOn: ({ device }) => `Kontynuowano na ${device}`,
        continuedElsewhere: 'Kontynuowano na innym urządzeniu',
        continuedHere: 'Kontynuowano na tym urządzeniu',
        dismiss: 'Odrzuć',
    } } satisfies Pick<Readonly<Record<string, VoiceMomentsTranslation>>, "pl">;

return { voiceMomentsTranslations };
})();

const Domain_voicePresenceTranslations = (() => {
type VoicePresenceTranslation = Shared_voicePresenceTranslations.VoicePresenceTranslation;

const voicePresenceTranslations = { pl: {
        welcomeText: "Cześć, słucham — co chcesz zrobić?",
        greetingLiteralUnavailable: "W tym języku odpowiedzi usługa czeka, aż zaczniesz mówić.",
        title: 'Głos',
        howYouTalk: "Jak rozmawiasz",
        holdToTalkTitle: "Przytrzymaj, aby mówić",
        holdToTalkDescription: "Przytrzymaj znak Voice, aby powiedzieć jedną rzecz; puść, aby wysłać. Dotknięcie nadal rozpoczyna i kończy Voice.",
        holdToTalkHint: "Przytrzymaj na jedną turę; puść, aby wysłać. Przeciągnij, aby anulować.",
        holdToTalkUnavailable: ({ service }) => `${service} nie obsługuje przytrzymania do mówienia. Zamiast tego dotknij, aby mówić.`,
        talkWithVoice: 'Rozmawiaj z Głosem',
        dictate: 'Dyktuj',
        globalVoice: 'Głos globalny',
        interrupt: 'Przerwij',
        options: 'Opcje Głosu',
        you: 'Ty',
        showConversation: 'Pokaż rozmowę',
        dragToMove: 'Przeciągnij, aby przesunąć',
        openConversation: 'Otwórz rozmowę',
        settings: 'Ustawienia Głosu',
        ended: 'Głos zakończony',
        muted: 'Wyciszono',
        setUp: 'Skonfiguruj Głos',
        setUpHint: 'Otwiera ustawienia Głosu, aby wybrać sposób mówienia',
        startAgain: 'Zacznij ponownie',
        endedCaption: ({ elapsed }) => `${elapsed} · rozmowa została zapisana`,
        dismiss: 'Zamknij',
        mute: "Wycisz",
        unmute: "Wyłącz wyciszenie",
        end: "Zakończ",
        captions: { connecting: "Otwieranie kanału audio", listening: "Śmiało", transcribing: "Zamiana na tekst", thinking: "Przygotowuję odpowiedź", speaking: "Możesz przerwać w każdej chwili", interrupted: "Śmiało", muted: "Wyłącz wyciszenie, aby mówić · Głos nadal może mówić", reconnecting: "Utracono połączenie · ponawianie", blocked: "Zezwól na dostęp do mikrofonu, aby mówić", failed: "Spróbuj ponownie lub sprawdź ustawienia Głosu" },
        recovery: { allow: "Zezwól", setUp: "Skonfiguruj" },
        containerA11y: ({ status }) => `Głos, ${status}`,
    } } satisfies Pick<Readonly<Record<string, VoicePresenceTranslation>>, "pl">;

return { voicePresenceTranslations };
})();

const Domain_voiceProviderPrivacyTranslations = (() => {
const voiceProviderPrivacyTranslations = { pl: {
    openai: {
      privacyDisclosure: 'Dźwięk i treść rozmowy są wysyłane z tego urządzenia do OpenAI przez WebRTC. Gdy odpowiednie funkcje są włączone lub używane, OpenAI może również otrzymywać z tego urządzenia ograniczone aktualizacje kontekstu Voice, wywołania narzędzi klienta i ich wyniki. Happier używa wybranego zapisanego klucza Voice API, usługi połączonej OpenAI lub eksperymentalnego konta Codex OAuth, aby uzyskać krótkotrwałe uwierzytelnienie klienta; konta połączone są używane przez wybraną maszynę. OpenAI przetwarza rozmowę na wybranym koncie i może przechowywać otrzymane dane zgodnie z ustawieniami tego konta i warunkami OpenAI. Serwer i relay Happier nie przenoszą dźwięku na żywo. Ustawienia udostępniania kontekstu Voice są oddzielone od tego przetwarzania przez dostawcę.',
    },
    xai: {
      privacyDisclosure: 'Dźwięk i treść rozmowy są wysyłane z tego urządzenia do xAI przez połączenie xAI Realtime. Gdy odpowiednie funkcje są włączone lub używane, xAI może również otrzymywać z tego urządzenia ograniczone aktualizacje kontekstu Voice, wywołania narzędzi klienta i ich wyniki. Happier używa klucza xAI API zapisanego w sekretach konta Happier tylko do ograniczonych operacji uwierzytelnienia klienta i katalogu głosów. xAI przetwarza rozmowę na tym koncie i może przechowywać otrzymane dane zgodnie z ustawieniami konta i warunkami xAI. Gdy wznawianie jest włączone, Happier zapisuje identyfikator rozmowy dostawcy; zapomnienie usuwa identyfikator zapisany w Happier i nie usuwa danych przechowywanych przez xAI. Serwer i relay Happier nie przenoszą dźwięku na żywo. Ustawienia udostępniania kontekstu Voice są oddzielone od tego przetwarzania przez dostawcę.',
    },
    speechProcessing: {
      deviceStt: 'Dźwięk jest przetwarzany przez usługę rozpoznawania mowy przeglądarki lub systemu operacyjnego. Zależnie od platformy i skonfigurowanej usługi przetwarzanie może odbywać się poza urządzeniem.',
      deviceTts: 'Tekst odpowiedzi jest przetwarzany przez usługę syntezy mowy przeglądarki lub systemu operacyjnego. Zależnie od platformy i skonfigurowanej usługi przetwarzanie może odbywać się poza urządzeniem.',
    },
    fields: {
      resumption: {
        title: 'Zapisuj identyfikator wznowienia xAI',
        subtitle: 'Zezwól Happier na zapisywanie krótkotrwałego identyfikatora rozmowy xAI na potrzeby ponownego połączenia.',
      },
    },
    resumption: {
      confirmTitle: 'Zapisać identyfikator wznowienia xAI?',
      confirmBody: 'Happier zapisze identyfikator rozmowy xAI na maksymalnie {minutes} minut, aby można było wznowić przerwaną rozmowę. Nie zmienia to ani nie usuwa danych przechowywanych przez xAI.',
      confirmAction: 'Zapisz identyfikator',
      forgetTitle: 'Zapomnij identyfikator wznowienia Happier',
      forgetSubtitle: 'Usuń identyfikator rozmowy dostawcy zapisany w Happier. Nie usuwa to rozmowy ani danych przechowywanych przez xAI.',
      forgotten: 'Happier usunął zapisany identyfikator rozmowy dostawcy.',
      unsupported: 'Happier nie może usunąć zapisanego identyfikatora rozmowy dostawcy z tej sesji.',
      failed: 'Happier nie mógł usunąć zapisanego identyfikatora rozmowy dostawcy. Spróbuj ponownie.',
    },
  } } as const;

return { voiceProviderPrivacyTranslations };
})();

const Domain_voiceReadinessTranslations = (() => {
type VoiceReadinessCopy = Shared_voiceReadinessTranslations.VoiceReadinessCopy;

const defineVoiceReadinessTranslation = Shared_voiceReadinessTranslations.defineVoiceReadinessTranslation;

const voiceReadinessTranslations = { pl: defineVoiceReadinessTranslation({
    ready: 'Tryb głosowy jest gotowy.',
    permissionAnnouncement: ({ summary }) => `Sesja kodowania potrzebuje uprawnienia do ${summary}. Sprawdź je w interfejsie sesji, aby zatwierdzić lub odrzucić.`,
    userActionAnnouncement: ({ question }) => `Sesja kodowania potrzebuje Twojej odpowiedzi. ${question}`,
    userActionFallback: 'Sesja kodowania potrzebuje Twojej odpowiedzi. Odpowiedz na pytanie, abym mógł kontynuować.',
    requestedTool: 'żądane narzędzie',
    provider_unselected: 'Wybierz dostawcę obsługi głosowej.',
    contribution_unavailable: 'Ten dostawca obsługi głosowej nie jest już dostępny.',
    role_unsupported: 'Ten dostawca nie obsługuje wybranego trybu głosowego.',
    platform_unsupported: 'Ten dostawca obsługi głosowej nie jest dostępny na tej platformie.',
    settings_unsupported_version: 'Zaktualizuj tego dostawcę przed użyciem go w trybie głosowym.',
    settings_unknown: 'Nie udało się sprawdzić ustawień dostawcy.',
    settings_needs_migration: 'Sprawdź zaktualizowane ustawienia dostawcy.',
    settings_invalid: 'Sprawdź nieprawidłowe ustawienia dostawcy.',
    settings_missing_required_setting: ({ service }) => `Dokończ konfigurację ${service}, aby rozpocząć.`,
    provider_mode_unknown: 'Wybierz tryb obsługiwany przez tego dostawcę.',
    server_feature_disabled: 'Serwer wyłączył tego dostawcę obsługi głosowej.',
    server_feature_installing: 'Serwer przygotowuje obsługę trybu głosowego.',
    server_feature_incompatible: 'Serwer jest niezgodny z tym dostawcą obsługi głosowej.',
    server_feature_unknown: 'Nie udało się sprawdzić obsługi tego dostawcy przez serwer.',
    execution_machine_missing: 'Wybierz maszynę, na której może działać ten dostawca obsługi głosowej.',
    execution_machine_installing: 'Wybrana maszyna do obsługi głosowej jest nadal przygotowywana.',
    execution_machine_incompatible: 'Wybrana maszyna jest niezgodna z tym dostawcą obsługi głosowej.',
    execution_machine_unknown: 'Nie udało się sprawdzić maszyny do obsługi głosowej.',
    daemon_unreachable: 'Wybrana maszyna nie ma dostępnej trasy dla dźwięku głosowego.',
    daemon_relay_disabled: 'Wybrana maszyna wymaga przekaźnika dźwięku głosowego, ale jego użycie jest wyłączone.',
    daemon_relay_capped: 'Pojemność przekaźnika dźwięku głosowego jest obecnie niedostępna dla wybranej maszyny.',
    credential_missing: 'Dodaj dane uwierzytelniające wymagane przez tego dostawcę obsługi głosowej.',
    credential_approval_required: 'Sprawdź dostęp do danych uwierzytelniających przed użyciem tego dostawcy obsługi głosowej.',
    credential_installing: 'Dane uwierzytelniające dostawcy są nadal przygotowywane.',
    credential_incompatible: 'Wybrane dane uwierzytelniające są niezgodne z tym dostawcą obsługi głosowej.',
    credential_unknown: 'Nie udało się sprawdzić danych uwierzytelniających dostawcy.',
    endpoint_missing: 'Skonfiguruj punkt końcowy wymagany przez tego dostawcę obsługi głosowej.',
    endpoint_installing: 'Punkt końcowy dostawcy obsługi głosowej jest nadal przygotowywany.',
    endpoint_incompatible: 'Skonfigurowany punkt końcowy jest niezgodny z tym dostawcą obsługi głosowej.',
    endpoint_unknown: 'Nie udało się sprawdzić punktu końcowego dostawcy obsługi głosowej.',
    runtime_missing: 'Zainstaluj środowisko uruchomieniowe wymagane przez tego dostawcę obsługi głosowej.',
    runtime_installing: 'Środowisko uruchomieniowe dostawcy obsługi głosowej jest nadal instalowane.',
    runtime_incompatible: 'Zainstalowane środowisko uruchomieniowe jest niezgodne z tym dostawcą obsługi głosowej.',
    runtime_unknown: 'Nie udało się sprawdzić środowiska uruchomieniowego dostawcy obsługi głosowej.',
    model_missing: 'Zainstaluj lub wybierz model dla tego dostawcy obsługi głosowej.',
    model_installing: 'Wybrany model głosowy jest nadal instalowany.',
    model_incompatible: 'Wybrany model jest niezgodny z tym dostawcą obsługi głosowej.',
    model_unknown: 'Nie udało się sprawdzić modelu dostawcy obsługi głosowej.',
    device_stt_unavailable: 'Rozpoznawanie mowy nie jest dostępne na tym urządzeniu.',
    device_stt_availability_unknown: 'Dostępność rozpoznawania mowy jest nadal sprawdzana.',
    short: {
      needsSetup: 'Wymaga konfiguracji',
      needsKey: 'Wymaga klucza',
      needsApproval: 'Wymaga Twojej zgody',
      offOnServer: 'Wyłączone na tym serwerze',
      needsComputer: 'Wymaga komputera',
      needsAddress: 'Wymaga adresu',
      needsModel: 'Wymaga modelu',
      installing: 'Instalowanie',
      notInstalled: 'Nie zainstalowano',
      unavailableHere: 'Niedostępne tutaj',
      needsUpdate: 'Wymaga aktualizacji',
      cantCheck: 'Jeszcze nie sprawdzono',
    },
    actions: {
      select_provider: 'Wybierz dostawcę',
      open_provider_settings: "Dokończ konfigurację",
      select_execution_machine: 'Wybierz maszynę',
      configure_credential: 'Dodaj dane uwierzytelniające',
      review_credential_access: 'Sprawdź dostęp do danych uwierzytelniających',
      configure_endpoint: 'Skonfiguruj punkt końcowy',
      install_model: 'Zainstaluj model',
      switch_provider: 'Wybierz innego dostawcę',
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

const voiceRealtimeProviderSetupTranslations = { pl: defineVoiceRealtimeProviderSetup(voiceProviderPrivacyTranslations["pl"], {
    xai: {
      setup: { footer: 'Twój klucz API xAI jest przechowywany jako zsynchronizowany zapisany sekret w sekretach Twojego konta Happier. Jest używany wyłącznie do ograniczonej operacji xAI Realtime.' },
      credential: { promptBody: 'Wklej klucz API xAI. Happier chroni go jako zsynchronizowany zapisany sekret i używa wyłącznie do ograniczonej operacji xAI Realtime.' },
    },
    setup: {
      title: 'Konfiguracja głosu w czasie rzeczywistym',
      footer: 'Twój klucz API jest przechowywany na wybranej maszynie wykonawczej i nigdy nie trafia do synchronizowanych ustawień głosu.',
    },
    credential: {
      title: 'Zapisany klucz API',
      promptTitle: 'Połącz głos w czasie rzeczywistym',
      promptBody: 'Wklej klucz API OpenAI Platform. Jest chroniony w zsynchronizowanych sekretach Twojego konta i używany tylko podczas tworzenia krótkotrwałych danych uwierzytelniających klienta Realtime.',
    },
    authentication: {
      sectionTitle: 'Uwierzytelnianie OpenAI Realtime',
      title: 'Źródło uwierzytelniania',
      subtitle: 'Wybierz dokładnie jedno źródło. Happier nigdy nie przełącza się na inny klucz ani konto.',
      footer: 'Korzystanie z OpenAI Realtime API jest rozliczane przez OpenAI Platform. Subskrypcja ChatGPT ani Codex nie oznacza rozliczenia ani dostępu do Realtime API. Do rozmowy WebRTC przekazywane są wyłącznie krótkotrwałe dane uwierzytelniające klienta.',
      savedSecret: {
        title: 'Zapisany głosowy klucz API',
        subtitle: 'Użyj klucza API zapisanego w sekretach konta Happier Voice. Demon nie jest wymagany.',
      },
      openAiApiKey: {
        title: 'Połączona usługa OpenAI',
        subtitle: 'Użyj wybranego standardowego profilu lub grupy kont z kluczem API OpenAI za pośrednictwem wybranej maszyny i jej połączonego demona.',
      },
      openAiCodex: {
        title: 'OpenAI Codex OAuth (eksperymentalne)',
        subtitle: 'Użyj wybranego profilu lub grupy kont Codex OAuth za pośrednictwem wybranej maszyny i jej połączonego demona. Happier nigdy nie przełącza się na inny klucz ani konto.',
      },
      account: {
        title: 'Połączone konto',
        subtitle: 'Wybierz dokładny profil lub grupę kont używaną w następnej rozmowie.',
      },
      chooseAccount: 'Wybierz konto',
      referenceRequired: 'Wybierz połączony profil lub grupę kont.',
      connected: 'Połączone konto gotowe',
      unavailable: 'Wybrane konto niedostępne lub wymaga ponownego połączenia',
    },
    invalidValue: 'Ta wartość nie jest obsługiwana przez tego dostawcę.',
    advanced: { show: 'Pokaż ustawienia zaawansowane', hide: 'Ukryj ustawienia zaawansowane' },
    fields: {
      model: { title: 'Model głosu', subtitle: 'Wybierz model głosu czasu rzeczywistego.' },
      voice: { title: 'Głos', subtitle: 'Wybierz głos używany w odpowiedziach.' },
      instructions: {
        title: 'Instrukcje głosowe',
        subtitle: 'Opcjonalne instrukcje dotyczące zachowania i osobowości.',
        promptTitle: 'Instrukcje głosowe',
        promptBody: 'Wprowadź opcjonalne instrukcje dla tej sesji głosowej.',
      },
      turnDetection: {
        title: 'Wykrywanie końca wypowiedzi',
        subtitle: 'Wybierz, jak dostawca wykrywa koniec Twojej wypowiedzi.',
        threshold: {
          title: 'Próg VAD',
          subtitle: 'Czułość wykrywania mowy; pozostaw puste, aby użyć wartości dostawcy.',
          promptTitle: 'Próg VAD',
          promptBody: 'Wprowadź wartość od 0.1 do 0.9 albo pozostaw puste.',
        },
        silenceDurationMs: {
          title: 'Czas ciszy',
          subtitle: 'Milisekundy ciszy przed zakończeniem wypowiedzi.',
          promptTitle: 'Czas ciszy',
          promptBody: 'Wprowadź od 0 do 10000 milisekund albo pozostaw puste.',
        },
        prefixPaddingMs: {
          title: 'Zapas przed mową',
          subtitle: 'Liczba milisekund zachowywanych przed wykrytą mową.',
          promptTitle: 'Zapas przed mową',
          promptBody: 'Wprowadź od 0 do 10000 milisekund albo pozostaw puste.',
        },
        idleTimeoutMs: {
          title: 'Limit czasu odpowiedzi przy bezczynności',
          subtitle: 'Opcjonalnie poproś xAI o rozpoczęcie odpowiedzi po takiej ciszy.',
          promptTitle: 'Limit czasu odpowiedzi przy bezczynności',
          promptBody: 'Wprowadź od 1 do 600000 milisekund albo pozostaw puste, aby wyłączyć automatyczne odpowiedzi przy bezczynności.',
          confirmTitle: 'Włączyć automatyczne odpowiedzi przy bezczynności?',
          confirmBody: 'Po skonfigurowanej ciszy xAI może samodzielnie utworzyć odpowiedź i zużyć limit API.',
          confirmAction: 'Włącz',
        },
      },
      transcriptionModel: {
        title: 'Model transkrypcji',
        subtitle: 'Opcjonalny model transkrypcji wejścia.',
        promptTitle: 'Model transkrypcji',
        promptBody: 'Wprowadź identyfikator modelu albo pozostaw puste, aby użyć wartości dostawcy.',
      },
      reasoning: { title: 'Rozumowanie', subtitle: 'Wybierz poziom rozumowania dla obsługiwanych modeli.' },
      outputSpeed: {
        title: 'Tempo mówienia',
        subtitle: 'Dostosuj tempo mówienia dostawcy.',
        promptTitle: 'Tempo mówienia',
        promptBody: 'Wprowadź wartość od 0.7 do 1.5.',
      },
      languageHint: {
        title: 'Podpowiedź języka',
        subtitle: 'Opcjonalnie pomóż transkrypcji rozpoznać Twój język.',
        promptTitle: 'Podpowiedź języka',
        promptBody: 'Wybierz obsługiwany język.',
      },
      keyterms: {
        title: 'Kluczowe terminy',
        subtitle: 'Nazwy i terminy dziedzinowe, które transkrypcja powinna rozpoznawać.',
        promptTitle: 'Kluczowe terminy',
        promptBody: 'Wprowadź maksymalnie 100 terminów oddzielonych przecinkami lub nowymi wierszami.',
      },
    },
    options: {
      pinned: 'Przypięta wersja',
      movingAlias: 'Automatycznie podąża za aktualizacjami dostawcy',
      automatic: 'Automatycznie',
      custom: 'Własne…',
      server_vad: 'Serwerowe wykrywanie aktywności głosowej',
      semantic_vad: 'Semantyczne wykrywanie wypowiedzi',
      manual: 'Ręcznie',
      high: 'Wysoki',
      none: 'Brak',
    },
    catalog: {
      credentialRequired: 'Dodaj klucz API, aby wczytać głosy',
      retry: 'Nie udało się wczytać głosów — ponów',
      empty: 'Dla tego konta nie ma dostępnych głosów',
      preview: ({ voice }) => `Odsłuchaj ${voice}`,
    },
    movingAlias: {
      confirmTitle: 'Podążać za najnowszym modelem?',
      confirmBody: 'Ruchomy alias modelu może zmienić zachowanie, gdy dostawca go zaktualizuje. W każdej chwili możesz wrócić do przypiętej wersji.',
      confirmAction: 'Użyj najnowszego',
    },
    links: {
      title: 'Zasoby dostawcy',
      account: { title: 'Otwórz konto dostawcy', subtitle: 'Zarządzaj swoim kontem u dostawcy.' },
      apiKeys: { title: 'Otwórz klucze API', subtitle: 'Twórz, rotuj lub unieważniaj klucze API dostawcy.' },
      privacy: { title: 'Polityka prywatności dostawcy', subtitle: 'Sprawdź, jak dostawca przetwarza dane głosowe.' },
    },
    disconnect: {
      title: 'Odłącz głos w czasie rzeczywistym',
      subtitle: 'Usuń klucz API tego dostawcy z wybranej maszyny.',
      confirmTitle: 'Odłączyć dostawcę?',
      confirmBody: 'Spowoduje to usunięcie zapisanego klucza API z wybranej maszyny wykonawczej.',
    },
    unavailable: {
      title: 'Głos w czasie rzeczywistym niedostępny',
      rowTitle: 'Nie udało się wczytać ustawień',
      provider: 'Wtyczka dostawcy jest niedostępna lub niezgodna.',
      invalid: 'Zapisane ustawienia dostawcy są nieprawidłowe.',
      needs_migration: 'Te ustawienia wymagają obsługiwanej migracji, zanim będzie można je edytować.',
      unsupported_version: 'Te ustawienia zostały zapisane przez nowszą wersję Happier.',
    },
  }) } as const;

return { voiceRealtimeProviderSetupTranslations };
})();

const Domain_voiceSettingsPagesTranslations = (() => {
type VoiceSettingsPagesCopy = Shared_voiceSettingsPagesTranslations.VoiceSettingsPagesCopy;

const en = Shared_voiceSettingsPagesTranslations.en;

const pl: VoiceSettingsPagesCopy = {
  pages: {
    search: {
      chooseService: 'Wybierz usługę, aby zmienić to ustawienie.',
      select: ({ choice, control }) => `Wybierz ${choice} w sekcji „${control}”, aby zmienić to ustawienie.`,
    },
    hub: {
      description: 'Rozmawiaj na głos ze swoimi agentami i dyktuj do dowolnej wiadomości.',
      modesTitle: 'Dwa sposoby używania głosu',
      moreTitle: 'Więcej',
      dictationPurpose: 'mikrofon w polu wiadomości zamienia mowę na tekst do edycji',
      summarySessionSummaries: 'Podsumowania sesji',
      summaryRecentMessages: ({ count }) => `ostatnie wiadomości: ${count}`,
      summaryNothingShared: 'Na początku rozmowy nic nie jest udostępniane',
      summaryRemembers: 'Agent Voice pamięta wcześniejsze rozmowy',
      summaryForgets: 'Agent Voice zapomina po każdej rozmowie',
      summaryVoiceComputer: ({ machine }) => `Komputer Voice: ${machine}`,
      summaryTranscript: 'transkrypcja podczas rozmowy',
    },
    pipeline: {
      hear: 'Słyszy',
      think: 'Myśli',
      speak: 'Mówi',
      write: 'Pisze',
      ready: 'Gotowe',
      oneStepNeedsYou: 'Jeden krok wymaga twojej uwagi',
      stepsNeedYou: ({ count }) => `Kroki wymagające twojej uwagi: ${count}`,
      waiting: 'Oczekuje',
      working: 'W toku',
      notChecked: 'Jeszcze nie sprawdzono',
      off: 'Wyłączone · dyktowanie nadal działa',
      onMachine: ({ machine }) => `Na ${machine}`,
      onVoiceComputer: 'Na twoim komputerze Voice',
      inTheCloud: 'W chmurze usługi, z tego urządzenia',
      inTheSession: 'Odpowiada jej własny agent, w transkrypcji',
      intoYourMessage: 'Przeglądasz przed wysłaniem',
      messageLanguage: ({ language }) => `Język: ${language}`,
      languageAutomatic: 'automatyczny',
      onThisDevice: 'Na tym urządzeniu',
      needsYou: 'Wymaga twojej uwagi',
      voiceAgentFollowsSession: 'Agent Voice · podąża za sesją',
      theSessionYoureIn: 'Sesja, w której jesteś',
      intoYourMessageTitle: 'Do twojej wiadomości',
    },
    privacy: {
      localAudio: "Urządzenie lub komputer Voice",
      localProcessor: "Wybrany model mowy",
      localRetention: "Zarządza urządzenie lub środowisko wykonawcze. Diagnostyka stosuje ustawienia nagrywania.",
      localDisclosure: "Wybrane modele mowy działają na urządzeniu lub komputerze Voice. Historia Voice i nagrania diagnostyczne mają osobne ustawienia na tej stronie.",
      audioTitle: "Dźwięk trafia do",
      processorTitle: "Przetwarza",
      retentionTitle: "Przechowywanie",
      messagesUnit: "wiadomości",
      secondsUnit: "sekund",
      servicePolicy: "Zgodnie z ustawieniami i warunkami konta usługi.",
      noMicrophoneAudio: "Bez dźwięku z mikrofonu; tylko tekst odpowiedzi.",
      yourEndpoint: "Skonfigurowany endpoint",
      endpointOperator: "Operator endpointu",
      endpointPolicy: "Zgodnie z polityką przechowywania endpointu.",
      deviceAudio: "Usługa mowy urządzenia",
      deviceProcessor: "Urządzenie lub jego usługa mowy",
      devicePolicy: "Zgodnie z ustawieniami i warunkami mowy urządzenia.",
      description: 'Co twoja usługa głosowa słyszy i czyta oraz co przechowuje Happier.',
      whereTitle: 'Dokąd teraz trafia twój głos',
      whereDescription: 'Zmienia się wraz z wybraną usługą.',
      startTitle: 'Gdy zaczyna się rozmowa',
      startDescription: 'Co usługa głosowa może przeczytać o twojej pracy.',
      screenTitle: 'Co jest na ekranie',
      screenDescription: 'Którą sesję lub stronę oglądasz.',
      screenNever: 'Nigdy',
      screenWhenAsked: 'Na prośbę',
      screenAlways: 'Zawsze',
      summariesTitle: 'Podsumowania sesji',
      recentTitle: 'Twoje ostatnie wiadomości',
      recentDescription: 'Ostatnie wiadomości sesji, gdy prosi o kontekst.',
      recentCountTitle: 'Wiadomości do udostępnienia',
      recentCountDescription: "",
      recentCountUnavailable: 'Włącz „Twoje ostatnie wiadomości”, aby to zmienić.',
      toolsTitle: 'Nazwy narzędzi',
      toolsDescription: 'Np. „Edytowano plik”. Argumenty i ścieżki plików nigdy nie są udostępniane.',
      permissionsTitle: 'Prośby o uprawnienia',
      permissionsDescription: 'Aby mógł powiedzieć, co wymaga twojej uwagi. Nadal zatwierdzasz dotknięciem.',
      devicesTitle: 'Twoje maszyny i urządzenia',
      devicesDescription: 'Nazwy i stan online, by uruchamiać sesje tam, gdzie poprosisz.',
      liveTitle: 'Gdy mówisz',
      liveDescription: 'Aktualizacje wysyłane, gdy twoje sesje zmieniają się w trakcie rozmowy.',
      liveActiveTitle: 'Z sesji, w której jesteś',
      liveOtherTitle: 'Z twoich innych sesji',
      liveNothing: 'Nic',
      liveActivity: 'Aktywność',
      liveSummaries: 'Podsumowania',
      liveMessages: 'Wiadomości',
      livePerUpdateTitle: 'Wiadomości na aktualizację',
      liveIncludeMineTitle: 'Dołącz to, co napisałeś',
      liveIncludeMineDescription: 'Wyłączone: wysyłana jest tylko strona agenta.',
      liveMessagesUnavailable: 'Wybierz „Wiadomości” dla sesji powyżej, aby to zmienić.',
      liveOtherModeTitle: 'Wiadomości z innych sesji',
      liveOtherModeNever: 'Nigdy',
      liveOtherModeWhenAsked: 'Na prośbę',
      liveOtherModeAutomatically: 'Automatycznie',
      liveOtherModeUnavailable: 'Wybierz „Wiadomości” dla innych sesji, aby to zmienić.',
      memoryTitle: 'Pamięć agenta Voice',
      memoryDescription: 'Tylko dla lokalnego głosu z agentem Voice.',
      rememberTitle: 'Pamiętaj wcześniejsze rozmowy',
      rememberOnDescription: 'Wraca tam, gdzie skończyłeś.',
      rememberOffDescription: 'Wyłączone: zapomina wszystko po rozłączeniu.',
      restoreTitle: 'Przywracaj pamięć przez',
      restoreRecent: 'Ostatnie wiadomości',
      restoreSummary: 'Podsumowanie + ostatnie',
      restoreResume: 'Wznowienie agenta',
      restoreUnavailable: 'Włącz „Pamiętaj”, aby wybrać.',
      restoreResumeFeatureOff: 'Wznowienie wymaga włączonego agenta Voice na tym serwerze.',
      restoreResumeAgentCannot: 'Ten agent nie potrafi wznowić wcześniejszej rozmowy.',
      fallbackTitle: 'Gdy wznowienie się nie uda, odtwórz wiadomości',
      fallbackDescription: 'Zaczyna od twoich ostatnich wiadomości zamiast od zera.',
      restoreCountTitle: 'Wiadomości do przywrócenia',
      restoreCountDescription: "",
      forgetTitle: 'Zapomnij wszystko teraz',
      forgetDescription: 'Uruchamia agenta Voice od nowa. Twoje sesje pozostają nietknięte.',
      forgetAction: 'Zapomnij',
      moreTitle: 'Więcej',
    },
    dictation: {
      description: 'Mikrofon w polu wiadomości zamienia mowę na tekst, który możesz edytować przed wysłaniem.',
      engineTitle: 'Silnik mowy',
      engineDescription: 'Każdy silnik mówi, dokąd trafia twój dźwięk.',
      sameAsConversations: 'Jak w rozmowach głosowych',
      sameAsConversationsUses: ({ engine }) => `Używa ${engine}, tak jak twoje rozmowy głosowe.`,
      languageTitle: 'Język',
      dictateInTitle: 'Dyktuję po',
      dictateInDescription: 'Automatycznie używa domyślnego języka silnika. Nie podąża za językiem rozmów.',
      pipelinePurpose: 'działa nawet przy wyłączonych rozmowach głosowych',
    },
    conversations: {
      description: 'Rozmawiaj na głos ze swoimi agentami, z rękami na klawiaturze lub bez.',
      serviceTitle: 'Usługa',
      serviceDescription: 'Kto cię słucha, myśli i mówi. Możesz zmienić w każdej chwili; każda zachowuje swoją konfigurację.',
      offDescription: 'Brak rozmów głosowych. Dyktowanie nadal działa.',
      serviceReady: 'Gotowe',
      accountTitle: 'Konto',
      accountDescription: 'To ta sama usługa w obu przypadkach; zmienia się tylko, kto płaci.',
      payWithTitle: 'Płać przez',
      happierBillingUnavailable: "Rozliczenia Happier nie są dostępne na tym serwerze.",
      turnOnVoiceAgent: "Włącz agenta głosowego",
      payWithHappierDescription: 'Obejmuje to Twój plan Happier. Własne konto nie jest potrzebne.',
      payWithOwnDescription: 'Używasz własnego konta i klucza API tej usługi.',
      runsOn: 'Działa na',
      hearTitle: 'Słyszy',
      hearDescription: 'Jak twoja mowa staje się tekstem, zanim padnie odpowiedź.',
      speechRecognitionTitle: 'Rozpoznawanie mowy',
      handsFreeUnsupported: 'Tryb bez użycia rąk wymaga rozpoznawania mowy na tym urządzeniu lub modelu mowy Happier.',
      handsFreeTimingUnavailable: 'Włącz tryb bez użycia rąk, aby to zmienić.',
      interruptTitle: 'Przerywaj mówieniem',
      interruptDescription: 'Mówienie w trakcie odpowiedzi ją zatrzymuje.',
      talkToTitle: 'Rozmawiaj z',
      talkToSession: 'Sesją',
      talkToSessionDescription: 'Mówisz do sesji, w której jesteś; odpowiada jej własny agent.',
      talkToAgent: 'Agentem Voice',
      talkToAgentDescription: 'Agent Voice czyta twoje sesje i działa za ciebie.',
      agentFeatureRequired: ({ feature }) => `Włącz ${feature} w Ustawienia → Funkcje. Funkcje eksperymentalne wymagają też włączenia Eksperymentów.`,
      itMayTitle: 'Może',
      itMayReadOnly: 'Tylko czytać',
      itMayReadOnlyDescription: 'Czyta twoje sesje i pliki, niczego nie zmienia.',
      itMayAsk: 'Najpierw pytać',
      itMayAskDescription: 'Każda zmiana najpierw cię pyta. Wypowiedziane „tak” nigdy nie zatwierdza; zatwierdzasz dotknięciem.',
      itMaySafe: 'Bezpieczne zmiany',
      itMaySafeDescription: 'Sam wprowadza bezpieczne zmiany w obszarze roboczym, o resztę pyta.',
      itMayAnything: 'Wszystko',
      itMayAnythingDescription: 'Może wprowadzić dowolną zmianę bez pytania.',
      repliesTitle: 'Odpowiedzi',
      repliesShort: 'Krótkie',
      repliesBalanced: 'Wyważone',
      thinkTitle: 'Myśli',
      thinkDescription: 'Co dzieje się z tym, co mówisz.',
      advancedAgentTitle: 'Zaawansowane zachowanie agenta',
      advancedAgentDescription: 'Jak agent Voice startuje, czeka i odpowiada. Domyślne ustawienia pasują większości.',
      memoryLinkTitle: 'Pamięć i przywracanie',
      memoryLinkDescription: 'To, czy pamięta wcześniejsze rozmowy, ustawisz w Prywatność i dane.',
      speakTitle: 'Mówi',
      speakDescription: 'Jak odpowiedzi są czytane na głos.',
      voiceEngineTitle: 'Silnik głosu',
      languageTitle: 'Język',
      languageDescription: 'Co każdy język zmienia dla wybranej usługi.',
      iSpeakTitle: 'Mówię po',
      iSpeakDescription: 'Pomaga cię zrozumieć. Automatycznie wykrywa za każdym razem.',
      replyInTitle: 'Odpowiadaj po',
      replyInDescription: 'Odpowiedź przychodzi w tym języku, nawet gdy zmienisz.',
      replySame: 'Tak jak mówię',
      iSpeakAutomatic: 'Automatycznie',
      iSpeakEngineDescription: ({ engine }) => `Pomaga ${engine} cię zrozumieć. Ustawiasz to przy rozpoznawaniu mowy w sekcji Słyszy.`,
      voiceTitle: 'Głos',
      voiceDescription: ({ engine }) => `Z ${engine}, silnika w sekcji Mówi.`,
      voiceDefault: 'Domyślny',
      voiceDevice: 'Głos tego urządzenia',
      voiceInEngine: 'Ustawiany w sekcji Mówi',
      languageServiceDescription: 'Język, w którym odpowiada twoja usługa głosowa.',
      languageAutomaticDescription: 'Usługa głosowa wykrywa język, w którym mówisz.',
      languageEngineDefault: 'Domyślny język silnika',
      languageCoupledDescription: 'Usługa głosowa używa jednego języka do słuchania i odpowiedzi.',
      greetingTitle: 'Powitanie',
      greetingOff: 'Wył.',
      greetingRightAway: 'Od razu',
      greetingAfterISpeak: 'Gdy się odezwę',
      greetingOffDescription: 'Czeka, aż odezwiesz się pierwszy.',
      greetingRightAwayDescription: 'Wita się zaraz po rozpoczęciu rozmowy.',
      greetingAfterISpeakDescription: 'Wita się w pierwszej odpowiedzi.',
      languageManagedDescription: 'Usługa głosowa określa swój język.',
      languageServiceDefault: 'Domyślny język usługi',
    },
    advanced: {
      description: 'Gdzie działa głos, jak wygląda na ekranie i jakich modeli mowy używa.',
      onScreenTitle: 'Na ekranie',
      onScreenDescription: 'Jak wygląda trwająca rozmowa.',
      showLiveAsTitle: 'Pokazuj Voice na żywo jako',
      showLiveAsDescription: 'Tylko na tym urządzeniu. Sekcja Voice w Companion zostaje w każdym trybie.',
      scopeTitle: 'Zaczynaj rozmowy z',
      scopeGlobal: 'Wszystkimi moimi sesjami',
      scopeGlobalDescription: 'Jeden asystent do wszystkiego.',
      scopeSession: 'Otwartą sesją',
      scopeSessionDescription: 'Startuje w sesji, którą masz otwartą.',
      transcriptTitle: 'Pokazuj transkrypcję podczas rozmowy',
      transcriptDescription: 'To, co mówisz ty i agent, pojawia się na bieżąco.',
      autoOpenTitle: 'Otwieraj ją na początku rozmowy',
      autoOpenDescription: 'Wyłączone: otwórz ją sam z rozmowy.',
      autoOpenUnavailable: 'Włącz „Pokazuj transkrypcję”, aby wybrać.',
      computerTitle: 'Komputer Voice',
      speechModelsTitle: 'Modele mowy',
      speechModelsNeedComputerTitle: 'Potrzebny komputer Voice',
      speechModelsNeedComputer: 'Wybierz powyżej komputer Voice, aby instalować jego modele mowy i nimi zarządzać.',
      computerDescription: 'Komputer, który uruchamia modele mowy i loguje się do połączonych kont na potrzeby głosu. Wspólny dla twoich urządzeń.',
      connectionTitle: 'Połączenie',
      timeoutTitle: 'Porzuć żądanie mowy po',
      timeoutDescription: "Dla punktów końcowych i modeli mowy.",
    },
  },
};

const voiceSettingsPagesTranslations = { pl } as const satisfies Pick<Record<string, VoiceSettingsPagesCopy>, "pl">;

return { voiceSettingsPagesTranslations };
})();

const Domain_walkthroughProgressTranslations = (() => {
type Parts = Shared_walkthroughProgressTranslations.Parts;

const walkthroughProgressTranslations = { 'pl': { parts: ({ completed, total, admitted }: Parts) => `${completed}/${total} części ukończone · ${admitted} przyjęte`, merge: 'Łączenie przewodnika…', titleEdited: 'Edytowany tytuł', changed: 'Zmieniono', moved: 'Przeniesiono', filesReadUnavailable: 'Postęp odczytu plików niedostępny' } };

return { walkthroughProgressTranslations };
})();

const Domain_walkthroughSavedTranslations = (() => {
type SavedCopy = Shared_walkthroughSavedTranslations.SavedCopy;

const en = Shared_walkthroughSavedTranslations.en;

const walkthroughSavedTranslations = { pl: { edit: 'Edytuj przewodnik', title: 'Tytuł przewodnika', stopTitle: 'Tytuł kroku', prose: 'Wyjaśnienie', refine: 'Dopracuj', instructions: 'Co należy zmienić?', moveUp: 'Przesuń w górę', moveDown: 'Przesuń w dół', mergeNext: 'Połącz z następnym krokiem', addSummary: 'Dodaj podsumowanie', addCommitPlan: 'Zaproponuj commity', updated: 'Zapisany wynik zaktualizowany', conflict: 'Ten przewodnik zmienił się gdzie indziej. Twój szkic został zachowany. Wczytaj najnowszą wersję i sprawdź ją przed ponownym zapisaniem.', reload: 'Wczytaj najnowszą wersję', missingStop: "Tego kroku nie ma już w najnowszym przewodniku. Szkic został zachowany; wybierz inny krok, aby kontynuować.", applicationLocked: 'Trwa stosowanie commitów. Edycja jest wstrzymana.' } } satisfies Pick<Record<string, SavedCopy>, "pl">;

return { walkthroughSavedTranslations };
})();

const Domain_walkthroughSettingsTranslations = (() => {
type Copy = Shared_walkthroughSettingsTranslations.Copy;

const en = Shared_walkthroughSettingsTranslations.en;

const copy = Shared_walkthroughSettingsTranslations.copy;

const walkthroughSettingsTranslations = { pl: copy({
        title: 'Przewodniki',
        description: 'Kolejność czytania przygotowana przez AI, z wyjaśnieniami przy konkretnych zmianach i opcjonalnymi propozycjami commitów. Działa na maszynie z kodem.',
        enabled: 'Wyjaśniaj zmiany',
        enabledDescription: 'Dodaje kolejność czytania i wyjaśnienia do porównania. Pliki pozostają dostępne bez modelu.',
        model: 'Model podsumowania',
        modelDescription: 'Używany do wyjaśnień, przewodników i propozycji commitów.',
        chooseModel: 'Wybierz model',
        unsupported: 'Nie może pisać przewodników',
        unavailable: 'Model niedostępny. Wybierz inny.',
        prefetch: 'Przygotuj po każdej turze',
        prefetchDescription: 'Przygotowuje przewodnik, gdy agent zakończy turę.',
        saved: 'Zapisane przewodniki',
        savedDescription: 'Zapisane na tej maszynie, wraz z Twoimi zmianami.',
        clear: 'Wyczyść',
        unavailableData: 'Połącz maszynę ponownie, aby wczytać zapisane przewodniki i koszty.',
        costUnavailable: 'Ostatnie 7 dni · koszt niedostępny',
        clearTitle: 'Wyczyścić zapisane przewodniki?',
        clearDescription: ({ machine }) => `Usuwa zapisane przewodniki i Twoje ręczne zmiany na ${machine}, a także Twoje oznaczenia przeglądu tych porównań. Nie wpływa to na inne maszyny.`,
        savedCount: ({ count, bytes }) => `${count} zapisanych · ${bytes}`,
        cost: ({ amount, partial }) => `Ostatnie 7 dni · ${amount}${partial ? ' · niektóre koszty są niedostępne' : ''}`,
        clearFailed: 'Nie udało się wyczyścić niektórych przewodników. Odśwież i spróbuj ponownie.',
    }) };

return { walkthroughSettingsTranslations };
})();

const Domain_walkthroughStartTranslations = (() => {
const walkthroughStartTranslations = { pl: { walkthroughStart: { start: 'Rozpocznij omówienie', ended: 'Ta rozmowa nie jest tutaj dostępna. Omówienie pozostaje dostępne.', newConversation: 'Rozpocznij nową rozmowę', askSession: 'Zapytaj agenta sesji', unavailable: 'Połącz maszynę i wybierz model obsługujący dane strukturalne.', updated: 'Omówienie zaktualizowane' } } };

return { walkthroughStartTranslations };
})();

const Domain_walkthroughTranslations = (() => {
type WalkthroughTranslations = Shared_walkthroughTranslations.WalkthroughTranslations;

const walkthroughSavedTranslations = {...Domain_walkthroughSavedTranslations.walkthroughSavedTranslations, ...EnglishFeatures.walkthroughSavedTranslations.walkthroughSavedTranslations};

const walkthroughProgressTranslations = {...Domain_walkthroughProgressTranslations.walkthroughProgressTranslations, ...EnglishFeatures.walkthroughProgressTranslations.walkthroughProgressTranslations};

const en = Shared_walkthroughTranslations.en;

const translated = Shared_walkthroughTranslations.translated;

const walkthroughTranslations = { pl: {
        walkthrough: translated({
            saved: walkthroughSavedTranslations.pl,
            progress: walkthroughProgressTranslations.pl,
            eyebrow: 'Przewodnik',
            generated: 'Wygenerowane',
            generatedBy: ({ model }) => `Wygenerowane · ${model}`,
            generatedA11y: 'Napisane przez model',
            readingChanges: 'Czytanie zmian…',
            modelFallback: 'Model',
            analysisAll: ({ who, count }) => `${who} przeczytał wszystkie ${count}`,
            analysisSome: ({ who, analysed, total }) => `${who} przeczytał ${analysed} z ${total}`,
            analysisStopped: ({ who, analysed, total }) => `${who} przeczytał ${analysed} z ${total} i się zatrzymał`,
            unavailableCount: ({ count }) => `${count} niedostępne`,
            youReviewed: ({ count, total }) => `Przejrzano ${count} z ${total}`,
            contents: 'Spis',
            reviewedOfTotal: ({ count, total }) => `${count} z ${total} przejrzanych`,
            boardReadProgress: ({ count, total }) => `${count} z ${total} przeczytanych`,
            stopOf: ({ number, total }) => `${number} z ${total}`,
            stopA11y: ({ number, title }) => `Przystanek ${number}: ${title}`,
            stopReviewedA11y: ({ number }) => `Przystanek ${number}, przejrzany`,
            importance: { start: 'Zacznij tutaj', high: 'Czytaj uważnie', low: 'Przejrzyj' },
            markReviewed: 'Oznacz jako przejrzane',
            reviewed: 'Przejrzane',
            markReviewedA11y: 'Oznacz ten przystanek jako przejrzany',
            unmarkReviewedA11y: 'Przejrzane. Naciśnij, aby usunąć oznaczenie',
            askAboutThis: 'Zapytaj o to',
            askAboutStopA11y: 'Zapytaj o ten przystanek',
            openConversation: 'Otwórz rozmowę przewodnika',
            andIn: ({ file }) => `oraz w ${file}`,
            newFile: 'Nowy plik',
            deletedFile: 'Usunięty',
            openInFiles: ({ file }) => `Otwórz ${file} w Plikach`,
            otherChanges: 'Inne zmiany',
            otherChangesDescription: 'Poza historią, ale wciąż tutaj. Otwórz je jak zwykły diff.',
            otherChangesCue: 'Mechaniczne, pokazane jako diffy',
            keys: { move: 'przejdź', reviewed: 'przejrzane', ask: 'zapytaj' },
            overview: 'Przegląd',
            codeMapOf: ({ count }) => `Mapa kodu: ${count} ${count === 1 ? 'plik' : 'plików'}`,
            codeMapHint: 'wskaż przystanek, aby wyróżnić jego pliki',
            touchesOutlined: 'dotyczy wyróżnionych plików',
            showOverviewA11y: ({ count }) => `Pokaż przegląd: mapa kodu ${count} plików`,
            inventory: { title: 'Wszystko w tym porównaniu · już dostępne w Plikach', read: 'Przeczytane', reading: 'Czytanie', unavailable: 'Niedostępne' },
            arriving: 'Kolejne przystanki pojawią się tutaj, gdy zostaną napisane.',
            previousStop: 'Poprzedni przystanek',
            nextStop: 'Następny przystanek',
            done: 'Gotowe',
            evidence: { displayFailed: 'Nie udało się wyświetlić zapisanego kodu. Plik pozostaje w Plikach.', binary: 'Plik binarny, opisany na podstawie metadanych. Pokazany, nie analizowany.', unavailable: ({ reason }) => `Nie udało się odczytać (${reason}). Zostaje na liście; nic tu nie twierdzi, że został przejrzany.` },
            notice: {
                stale: 'Pliki zmieniły się po napisaniu tego',
                refresh: 'Odśwież przewodnik',
                failed: ({ reason }) => `Pisanie przerwane · ${reason}`,
                failedGeneric: 'Pisanie przerwane',
                tryAgain: 'Spróbuj ponownie',
                chooseModel: 'Wybierz model',
                cancelled: 'Pisanie zostało zatrzymane. To, co napisano, zostaje.',
                rest: 'Reszta nie została napisana. Wszystkie pliki są w Plikach; nic nie pominięto po cichu.',
                offline: ({ machine, time }) => `${machine} jest offline · pokazuję przewodnik i kod z ${time}. Pytania i odświeżanie wrócą po ponownym połączeniu.`,
                offlineA11y: 'Wymaga maszyny, która jest offline',
                incomplete: 'Niektórych zmian nie udało się wymienić. To, co tu jest, jest dokładne; nic nie twierdzi, że jest kompletne.',
                undo: 'Cofnij',
            },
            none: { title: 'Brak przewodnika', reason: 'Przewodnik czyta te zmiany po kolei i wyjaśnia każdą obok jej dokładnego kodu. Wszystkie pliki są już w Plikach.', showFiles: 'Pokaż pliki' },
            explain: { notInStory: 'Poza historią', readInWalkthrough: 'Czytaj w przewodniku' },
        }),
    } };

return { walkthroughTranslations };
})();

const Domain_widgetAddTranslations = (() => {
type WidgetAddTranslation = Shared_widgetAddTranslations.WidgetAddTranslation;

const inSentence = Shared_widgetAddTranslations.inSentence;

const widgetAddTranslations = { pl: {
        added: 'Dodano',
        boardTitle: 'Dodaj do tablicy',
        boardHint: 'Wszyscy tutaj zobaczą, co dodasz',
        companionTitle: 'Dodaj do towarzysza',
        companionHint: 'Tylko ty widzisz swojego towarzysza',
        searchWidgets: 'Szukaj widżetów',
        searchCompanion: 'Szukaj podglądów i paneli',
        makeOne: 'Utwórz własny',
        noteSubtitle: 'Markdown',
        interactiveViewSubtitle: 'HTML',
        findMore: 'Znajdź więcej widżetów',
        findMoreSubtitle: 'Wtyczki',
        askTitle: 'Poproś agenta o widżet',
        askNote: 'Szkic trafia do pola wiadomości; nic nie zostanie wysłane, dopóki tego nie zrobisz.',
        glances: 'Podglądy',
        glancesHint: 'na żywo, wbudowane lub z wtyczek',
        onBoard: 'Na tej tablicy',
        onBoardHint: 'udostępnione wszystkim tutaj',
        panes: 'Panele',
        panesHint: 'dodane jako link otwierany w Szczegółach',
        builtIn: 'Wbudowane',
        nativeDescriptions: {
            session_summary: 'Aktywność i kolejne kroki wybranej sesji.',
            agent_plan: 'Śledź plan agenta dla wybranej sesji.',
            changes: 'Przeglądaj zmiany plików w wybranej sesji.',
            local_services: 'Otwórz lokalne usługi wybranej sesji.',
        },
        noMatch: ({ query }) => `Brak widżetów pasujących do „${query}”`,
        pickTitle: 'Wybierz widżet, aby zobaczyć go tutaj',
        pickHint: 'Pokazuje twoje własne dane w wybranym rozmiarze, zanim cokolwiek zostanie dodane.',
        pickNote: 'Wybierz widżet, aby go dodać',
        askAction: 'Napisz prośbę',
        pluginTag: 'wtyczka',
        pluginProvenance: ({ plugin }) => `Wtyczka ${plugin}`,
        readsChosenSession: 'odczytuje wybraną sesję tam, gdzie działa',
        readsFrom: ({ source }) => `odczytuje ${source}`,
        savedQueryOn: ({ source }) => `zapisane zapytanie w ${source}`,
        madeByYou: ({ date }) => `utworzone przez ciebie ${date}`,
        madeByAgent: ({ date }) => `utworzone przez twojego agenta ${date}`,
        madeByPlugin: ({ date }) => `utworzone przez wtyczkę ${date}`,
        previewLiveData: 'Na żywo, z twoimi danymi',
        addsAtSize: ({ size }) => `Dodaje w rozmiarze ${size}. Rozmiar możesz później zmienić.`,
        backToWidgets: 'Widżety',
        editTitle: ({ widget }) => `${widget} · dane wejściowe`,
        editHint: 'Zmienia się tylko ta kopia. Pozostałe zachowują swoje dane.',
        preview: 'Podgląd',
        previewLive: 'Podgląd · na żywo',
        previewWaiting: ({ field }) => `Wybierz: ${field}, aby zobaczyć to tutaj`,
        previewAfterAdd: 'Pojawi się tutaj po dodaniu',
        needed: 'Wymagane',
        stillNeeded: ({ field }) => `Nadal brakuje: ${field}`,
        followGroup: 'Śledź',
        pinGroup: 'Lub przypnij jedno',
        another: 'Inne…',
        anotherSubtitle: 'Szukaj wśród wszystkiego, do czego masz dostęp',
        searchChoices: ({ field }) => `Szukaj: ${field}`,
        noChoices: 'Na razie nie ma czego wybrać',
        optionsLoading: 'Wczytywanie opcji…',
        optionsFailed: 'Nie udało się wczytać opcji',
        invalidValue: 'nie znaleziono',
        inputsInvalid: 'Sprawdź dane wejściowe tego widżetu',
        inputsUnavailable: 'Wybrane dane wejściowe są niedostępne',
        connectionNeeded: ({ field }) => `Połącz swoje ${field}`,
        sessionDenied: ({ session }) => `Nie masz już dostępu do ${session}`,
        sessionUnavailable: ({ session }) => `${session} jest niedostępna lub została usunięta`,
        typeUnavailable: ({ field }) => `Typ dla ${field} nie jest już dostępny`,
        inputUnavailable: ({ field }) => `${field} jest niedostępne`,
        selectedInputUnavailable: ({ field, value }) => `${field}: ${value} nie jest już dostępne`,
        invalidReason: 'Nie masz już dostępu lub zostało usunięte.',
        viewerOnly: 'Każdy tutaj widzi to przez własne połączenie.',
        justAdded: ({ widget }) => `Dodano: ${widget}`,
        saved: ({ widget }) => `Zapisano: ${widget}`,
        addFailed: 'Nie udało się dodać. Spróbuj ponownie.',
        saveFailed: 'Nie udało się zapisać. Spróbuj ponownie.',
        homeTitle: 'Dodaj do strony głównej',
        homeHint: 'Tylko ty widzisz swoją stronę główną · na każdym urządzeniu',
        addWidgets: 'Dodaj widżety',
        addToHome: 'Dodaj do strony głównej',
        addToBoard: 'Dodaj do tablicy',
        addToCompanion: 'Dodaj do towarzysza',
        editInputs: 'Edytuj dane wejściowe…',
        width: 'Szerokość',
        size: 'Rozmiar',
        sizes: { small: 'Mały', medium: 'Średni', wide: 'Szeroki', full: 'Pełny', tall: 'Wysoki', large: 'Duży' },
        widthHalf: 'Połowa',
        widthFull: 'Pełna',
        thisSession: 'Ta sesja',
        choicesCount: ({ count }) => count === 1 ? '1 opcja' : `Opcje: ${count}`,
        countOnHome: ({ count }) => `Na stronie głównej: ${count}`,
        countOnBoard: ({ count }) => `Na tablicy: ${count}`,
        countInCompanion: ({ count }) => `W towarzyszu: ${count}`,
        thisPage: 'Ta strona',
        thisProject: 'Ten projekt',
        thisCheckout: 'Ta kopia robocza',
        areaPinned: 'Przypięte',
        areaPinnedMeta: 'twoje widżety na tej stronie',
        areaProjectTitle: 'Widżety',
        areaProjectMeta: 'twoje',
        areaAdd: ({ surface }) => `Dodaj widżet do ${surface}`,
        areaAddTo: ({ surface }) => `Dodaj do ${surface}`,
        areaHint: 'Tylko ty widzisz te widżety',
        countHere: ({ count }) => `${count} tutaj`,
        areaEmptyTitle: 'Nic jeszcze nie przypięto',
        areaEmptyReason: 'Przypnij widżet, aby został tutaj, tylko dla ciebie.',
        areaEmptyAction: 'Dodaj widżet',
        areaUnavailableTitle: 'Nie można tu wczytać widżetów',
        projectSourceUnavailableTitle: 'Widżety pojawią się tutaj, gdy repozytorium tego projektu będzie znane',
        areaWriteFailed: 'Nie udało się zapisać tej zmiany',
        areaApprovalPending: 'Czeka na zatwierdzenie',
        valueNotFound: ({ value }) => `Nie znaleziono: ${value}`,
        chooseAnother: ({ field }) => `Wybierz inną wartość: ${field}`,
        chooseField: ({ field }) => `Wybierz: ${field}`,
        widgetOptions: 'Opcje widżetu',
        moveTo: 'Przenieś…',
    } } satisfies Pick<Readonly<Record<string, WidgetAddTranslation>>, "pl">;

return { widgetAddTranslations };
})();

const Domain_widgetDefinitionTranslations = (() => {
type WidgetDefinitionTranslation = Shared_widgetDefinitionTranslations.WidgetDefinitionTranslation;

const widgetDefinitionTranslations = { pl: {
        yourWidgets: "Twoje widżety",
        yourWidgetsHint: "utworzone przez ciebie lub twoich agentów",
        yourWidget: "Twój widżet",
        moreInSource: "Źródło zawiera więcej, niż tu widać.",
        notCurrent: "Nieaktualne",
        aboutMenu: "O tym widżecie",
        aboutTitle: "O tym widżecie",
        aboutUnavailable: "Nie można teraz otworzyć tego widżetu.",
        aboutData: "Dane",
        aboutReads: "Odczytuje",
        aboutInputs: "Dane wejściowe",
        aboutRefresh: "Odświeżanie",
        aboutUsedIn: "Używany w",
        savedFromSession: ({ session }) => `Zapisano z ${session}`,
        aSession: "sesji",
        madeInYourAccount: "Utworzono na twoim koncie",
        edited: ({ time }) => `edytowano ${time}`,
        readsOnly: "Tylko odczyt",
        runsOn: ({ machine }) => `działa na ${machine}`,
        withYourConnection: "z twoim własnym połączeniem",
        readsResource: ({ read, plugin }) => `${read} z ${plugin}`,
        cannotRunAnythingElse: "Widżet nie może uruchomić niczego innego.",
        inputsThisCopy: "Tylko dla tej kopii",
        refreshWhenOpen: "Po otwarciu",
        refreshNow: "Odśwież teraz",
        refreshing: "Odświeżanie…",
        refreshed: "Odświeżono",
        refreshFailed: "Nie udało się odświeżyć. Zostają ostatnie liczby.",
        placedOnHome: "Start",
        placedOnBoard: ({ board }) => `Tablica ${board}`,
        placedOnABoard: "Tablica",
        placedInASession: "Sesja",
        placedInAProject: "Projekt",
        placedOnAPluginPage: "Strona wtyczki",
        notPlacedYet: "Jeszcze nigdzie nie umieszczony",
        otherPlacesNotListed: "Miejsca na innych urządzeniach lub wspólnych powierzchniach nie są tu wymienione.",
        editsChangeAll: ({ count }) => `Zmiany w widżecie zmieniają wszystkie (${count})`,
        editsChangeEverywhere: "Zmiany w widżecie obowiązują wszędzie, gdzie jest używany",
        changeWithAgent: "Zmień z agentem",
        changeDraft: ({ widget }) => `Zmień widżet „${widget}” tak, aby `,
        duplicate: "Duplikuj",
        duplicated: ({ name }) => `Zapisano kopię „${name}” w Twoich widżetach`,
        duplicateFailed: "Nie udało się utworzyć kopii. Spróbuj ponownie.",
        saveMenu: "Zapisz jako twój widżet…",
        saveMenuSubtitle: "Kopia na Start i twoje tablice",
        saveTitle: "Zapisz jako twój widżet",
        saveHint: "Kopia, którą możesz umieścić na Starcie, tablicach i w projektach. Ta sesja zachowa swój.",
        saveNote: "Zapisano na twoim koncie · tylko ty",
        saveWidget: "Zapisz widżet",
        saveFailed: "Nie udało się zapisać widżetu. Spróbuj ponownie.",
        savedButNotPlaced: "Zapisano w Twoich widżetach, ale nie dodano wszędzie, gdzie wybrano.",
        savedAsYours: ({ name }) => `Zapisano „${name}” w Twoich widżetach`,
        name: "Nazwa",
        nameNeeded: "Nadaj mu nazwę",
        becomesViewerInput: "Staje się danymi wejściowymi: każde miejsce używa twojego połączenia",
        becomesContextInput: "Staje się danymi wejściowymi: każde miejsce wybiera własne",
        alsoAddTo: "Dodaj też do",
        alsoAddToNamed: ({ place }) => `Dodaj też do: ${place}`,
        snapshotMenu: "Opublikuj migawkę na tej tablicy…",
        snapshotMenuSubtitle: "Wszyscy tutaj zobaczą twoje obecne liczby",
        snapshotTitle: "Opublikować migawkę dla wszystkich?",
        snapshotHint: ({ widget, time }) => `Każdy, kto może otworzyć tę sesję, zobaczy ${widget} ze stanem na ${time}. Nie będzie się aktualizować, a twoje połączenie pozostaje twoje.`,
        postSnapshot: "Opublikuj migawkę",
        snapshotNotCurrent: "Widżet wciąż pobiera aktualne liczby. Spróbuj ponownie, gdy je będzie miał.",
        snapshotFailed: "Nie udało się opublikować migawki. Nic nie zostało udostępnione.",
        snapshotAwaitingApproval: "Czeka na zatwierdzenie w skrzynce. Nic nie jest udostępniane przed zatwierdzeniem.",
        snapshotPosted: "Opublikowano migawkę",
        snapshotNote: "Kopia tych liczb. Nie aktualizuje się.",
        asOf: ({ time }) => `stan na ${time}`,
    } } satisfies Pick<Readonly<Record<string, WidgetDefinitionTranslation>>, "pl">;

return { widgetDefinitionTranslations };
})();

const Domain_widgetFrameTranslations = (() => {
type WidgetFrameTranslation = Shared_widgetFrameTranslations.WidgetFrameTranslation;

const widgetFrameTranslations = { pl: {
        styleCard: 'Karta',
        stylePlain: 'Prosty',
        surfaceHome: 'Start',
        surfaceBoard: 'Tablica',
        surfaceCompanion: 'Towarzysz',
        showFrame: 'Pokaż ramkę',
        hideFrame: 'Ukryj ramkę',
        thisWidgetOnly: 'Tylko ten widżet',
        surfaceUses: ({ surface, style }) => `${surface}: ${style}`,
        useSurfaceDefault: ({ surface }) => `Użyj ustawienia domyślnego: ${surface}`,
        likeTheOthers: ({ style }) => `${style}, jak pozostałe`,
        appearanceTitle: 'Widżety',
        appearanceDescription: 'Jak widżety są obramowane na tym urządzeniu. Aby zmienić jeden widżet, użyj jego menu ⋯.',
        previewLabel: ({ surface, style }) => `${surface} · ${style}`,
        noticeChanged: 'Zmieniono ramkę',
        newChip: 'Nowy',
    } } satisfies Pick<Readonly<Record<string, WidgetFrameTranslation>>, "pl">;

return { widgetFrameTranslations };
})();

const Domain_widgetGlanceTranslations = (() => {
type WidgetGlanceTranslation = Shared_widgetGlanceTranslations.WidgetGlanceTranslation;

const widgetGlanceTranslations = { pl: {
        changesTitle: 'Zmiany',
        localServicesTitle: 'Usługi lokalne',
        changesSource: 'Git',
        reviewChanges: 'Przejrzyj zmiany',
        notARepo: 'Folder tej sesji nie jest repozytorium Git.',
        noChanges: 'Brak zmian. Tu pojawią się pliki edytowane przez agenta.',
        changesLoading: 'Wczytywanie zmian',
        running: 'Działa',
        notRunning: 'Nie działa',
        nothingRunning: 'Nic nie działa. Tu pojawią się usługi uruchomione w tej sesji.',
        servicesLoading: 'Wczytywanie usług lokalnych',
        servicesReadFailed: 'Nie udało się odczytać usług lokalnych. Spróbuj ponownie.',
        noMachine: 'Ta sesja nie ma maszyny, którą można zapytać.',
        changedCount: ({ count }) => `${count} zmienionych`,
        moreFiles: ({ count }) => `jeszcze ${count} plików`,
        runningCount: ({ count }) => `działa: ${count}`,
        openInBrowser: ({ name }) => `Otwórz ${name} w przeglądarce`,
        paneLinkA11y: ({ pane }) => `${pane}. Otwiera się obok czatu`,
    } } satisfies Pick<Readonly<Record<string, WidgetGlanceTranslation>>, "pl">;

return { widgetGlanceTranslations };
})();

const Domain_workStatusTranslations = (() => {
type WorkStatusTranslations = Shared_workStatusTranslations.WorkStatusTranslations;

const en = Shared_workStatusTranslations.en;

const pl: WorkStatusTranslations = {
    buckets: {
        needs_you: 'Czeka na Ciebie',
        working: 'W toku',
        finished: 'Zakończone',
        idle: 'Bezczynne',
        offline: 'Offline',
    },
};

const workStatusTranslations = { pl: { ...pl, task: { stopped: 'Zatrzymana', linkFailed: 'Sesja została utworzona, ale jej powiązanie z zadaniem nie zostało zapisane. Spróbuj ponownie powiązać tę samą sesję.' } } };

return { workStatusTranslations };
})();

const Domain_workflowActionTranslations = (() => {
type Copy = Shared_workflowActionTranslations.Copy;

const en = Shared_workflowActionTranslations.en;

const workflowActionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "pl"> = { pl: {
        host: "Happier",
        structure: "Struktura",
        callWebhook: "Wywołaj webhook",
        runCommand: "Uruchom polecenie",
        commandValuesInEnv: "Przekazuj wartości przepływu pracy przez zmienne środowiskowe. Tekst polecenia pozostaje zgodny z zapisem.",
        artifactCreate: "Utwórz dokument",
        artifactGet: "Odczytaj dokument",
        artifactList: "Wyświetl dokumenty",
        artifactUpdate: "Zaktualizuj dokument",
        artifactDelete: "Usuń dokument",
        artifactPublish: "Opublikuj plik",
        artifactRevisions: "Wyświetl wersje dokumentu",
        artifactRestore: "Przywróć wersję dokumentu",
        artifactUsage: "Sprawdź użycie miejsca przez dokumenty",
        artifactShare: "Udostępnij dokument przez link",
        artifactLinks: "Wyświetl linki dokumentu",
        artifactRevoke: "Unieważnij link dokumentu",
        artifactAudit: "Odczytaj aktywność linków dokumentu",
        sessionRole: "Ustaw rolę sesji",
        sessionRoleOverride: "Zmień ustawienia roli sesji",
        sessionRoleClear: "Zresetuj ustawienia roli sesji",
        sessionRoleAdd: "Dodaj rolę sesji",
        sessionRoleRemove: "Usuń rolę sesji",
        sessionNotes: "Ustaw notatki sesji",
        sessionRolesApply: "Zastosuj role do podległych sesji",
        roleList: "Wyświetl role",
        roleGet: "Odczytaj rolę",
        roleCreate: "Utwórz rolę",
        roleUpdate: "Zaktualizuj rolę",
        roleDelete: "Usuń rolę",
        roleOverride: "Zmień ustawienia roli",
        roleReset: "Zresetuj ustawienia roli",
        widgetCatalog: "Wyświetl dostępne widżety",
        widgetInstances: "Wyświetl umieszczone widżety",
        widgetAdd: "Dodaj widżet",
        widgetRemove: "Usuń widżet z widoku",
        widgetMove: "Przenieś widżet",
        widgetRename: "Zmień nazwę widżetu",
        widgetSize: "Ustaw rozmiar widżetu",
        widgetFrame: "Ustaw ramkę widżetu",
        widgetInputs: "Odczytaj dane wejściowe widżetu",
        widgetValidate: "Sprawdź dane wejściowe widżetu",
        widgetSetInputs: "Ustaw dane wejściowe widżetu",
        widgetResetInputs: "Zresetuj dane wejściowe widżetu",
        widgetLayout: "Odczytaj układ widżetów",
        widgetUpdateLayout: "Zmień układ widżetów",
        widgetDefinitions: "Wyświetl zapisane widżety",
        widgetDefinition: "Odczytaj zapisany widżet",
        widgetCreate: "Utwórz widżet",
        widgetUpdate: "Zaktualizuj zapisany widżet",
        widgetDuplicate: "Duplikuj zapisany widżet",
        widgetDelete: "Usuń zapisany widżet",
        widgetSave: "Zapisz widżet sesji",
    } };

return { workflowActionTranslations };
})();

const Domain_workflowAgentAuthoringTranslations = (() => {
type Edit = Shared_workflowAgentAuthoringTranslations.Edit;

type RepeatableMessage = Shared_workflowAgentAuthoringTranslations.RepeatableMessage;

type Copy = Shared_workflowAgentAuthoringTranslations.Copy;

const en = Shared_workflowAgentAuthoringTranslations.en;

const repeatable = { pl: { repeatable: 'Uczyń powtarzalnym', repeatableDescription: 'Poproś agenta o zamianę tego, co się sprawdziło, w workflow wielokrotnego użytku.', repeatablePrompt: 'Zamień to, co tu zrobiliśmy, w workflow, który mogę uruchomić ponownie. Zaprojektuj go, sprawdź przez workflow.validate i zapisz, ale nie uruchamiaj.', repeatableMessagePrompt: 'Zamień to, co zrobiliśmy w tej wiadomości, w workflow, który mogę uruchomić ponownie. Zaprojektuj go, sprawdź przez workflow.validate i zapisz, ale nie uruchamiaj.', repeatableMessageSource: ({ text }: RepeatableMessage) => `“${text}”` } };

const workflowAgentAuthoringTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "pl"> = { pl: { ...repeatable.pl, create: 'Utwórz z agentem', edit: 'Edytuj z agentem', agent: 'Agent', description: 'Nowa sesja projektuje z tobą workflow, sprawdza go i zapisuje. Nic nie ruszy, dopóki nie wybierzesz Uruchom teraz.', changedByAgent: 'Zmienione przez agenta', saved: 'Właśnie zapisane przez agenta', savedAge: ({ age }) => `Zapisane przez agenta ${age}`, savedWorkflow: ({ name }) => `Zapisany workflow · ${name}`, updated: 'Workflow zaktualizowany', changed: ({ count }) => `Workflow zaktualizowany · zmienione kroki: ${count}`, openEditor: 'Otwórz w edytorze', openSession: 'Otwórz w Sesjach', createPrompt: 'Zaprojektuj ze mną workflow, sprawdź go przez workflow.validate, a potem zapisz. Nie uruchamiaj go.', createLead: 'Pomóż mi utworzyć workflow, który ', editPrompt: ({ name, definitionId, headerVersion, bodyVersion }) => `Zapisany workflow „${name}” ma id ${definitionId} i rewizję: nagłówek ${headerVersion}, treść ${bodyVersion}. Zmień go przez workflow.definition.edit, a workflow.definition.update używaj tylko do zastąpienia całości. Sprawdź go przez workflow.validate przed zapisem. Nie uruchamiaj go.`, editLead: ({ name }) => `Pomóż mi zmienić ${name}: ` } };

return { repeatable, workflowAgentAuthoringTranslations };
})();

const Domain_workflowBuiltinTranslations = (() => {
type WorkflowBuiltinTranslations = Shared_workflowBuiltinTranslations.WorkflowBuiltinTranslations;

const en = Shared_workflowBuiltinTranslations.en;

const pl: WorkflowBuiltinTranslations = {
    runsInsideSession: 'Działa w sesji',
    keepGoing: { title: 'Kontynuuj do skutku' },
    reviewAndConverge: { title: 'Przejrzyj i uzgodnij', apply: 'Zastosuj', verifyAndFix: 'Sprawdź i napraw', verifyOnly: 'Tylko sprawdź', rounds: 'Rundy przed zatrzymaniem' },
    planWithAPanel: { title: 'Zaplanuj z panelem', description: 'Kilku agentów planuje obok siebie, a plan czeka na twój przegląd.', inputs: { request: 'Prośba', requestPlaceholder: 'Co ma zaplanować panel?', engines: 'Planujący' } },
    openAPullRequest: { title: 'Otwórz pull request', description: 'Prosi o drugą opinię, a potem otwiera pull request. Jeśli druga opinia się nie zgadza, czeka na ciebie.', inputs: { base: 'Gałąź bazowa', title: 'Tytuł pull requesta', body: 'Opis', question: 'Pytanie do drugiej opinii' } },
};

const workflowBuiltinTranslations = { pl } as const;

return { workflowBuiltinTranslations };
})();

const Domain_workflowFieldTranslations = (() => {
const workflowFieldTranslations = { pl: {
        sessionId: "Sesja",
        triggerId: "Wyzwalacz",
        engineIds: "Recenzenci",
        backendTargetKeys: "Planiści",
        reviewCommentAuthorIntent: "Ustalenia",
        commentId: "Ustalenie",
        expectedServerRevision: "Wersja ustalenia",
        clientMutationId: "Aktualizacja",
        projectId: "Projekt",
        workspace: "Obszar roboczy",
        toState: "Stan",
        expectedState: "Bieżący stan",
        disposition: "Ważność",
        allPages: "Wszystkie ustalenia",
        permissionMode: "Uprawnienia",
        target: "Uruchamia się w",
        cwd: "Folder roboczy",
        maxRounds: "Maksymalna liczba rund",
        strikes: "Kontrole bez postępu",
        secondOpinion: "Druga opinia",
        useJudge: "Sędzia",
        diffFingerprint: "Sprawdzone zmiany",
        url: "URL",
        body: "Treść JSON",
        command: "Polecenie",
        env: "Zmienne środowiskowe",
    } };

return { workflowFieldTranslations };
})();

const Domain_workflowEditorPageTranslations = (() => {
type WorkflowEditorPageTranslations = Shared_workflowEditorPageTranslations.WorkflowEditorPageTranslations;

const workflowFieldTranslations = {...Domain_workflowFieldTranslations.workflowFieldTranslations, ...EnglishFeatures.workflowFieldTranslations.workflowFieldTranslations};

const en = Shared_workflowEditorPageTranslations.en;

const pluralPl = Shared_workflowEditorPageTranslations.pluralPl;

const pluralRu = Shared_workflowEditorPageTranslations.pluralRu;

const pl: WorkflowEditorPageTranslations = {
    fields: workflowFieldTranslations.pl,
    blocks: {
        actionSub: 'Akcja · bez tury agenta',
        notSet: 'Nie ustawiono',
        set: 'Ustaw',
        clear: 'Wyczyść',
        required: 'Wymagane',
        noFields: 'Dla tej akcji nie ma nic do ustawienia.',
        workflowSub: 'Uruchamia inny przepływ · jego kroki pojawiają się w tym uruchomieniu',
        builtin: 'Wbudowane',
        waitTitle: 'Czekaj na ciebie',
        waitSub: 'Ten tor czeka, aż będziesz kontynuować.',
        waitPlaceholder: 'Co powinieneś tu sprawdzić lub zdecydować?',
        returnsText: 'Zwraca tekst',
        returnsFields: ({ fields }) => `Zwraca ${fields}`,
        workflowDefaults: 'Domyślne przepływu pracy',
        addNamedResults: 'Dodaj nazwane wyniki',
        menuRun: 'Uruchom przepływ',
        menuAction: 'Akcja',
        menuWait: 'Czekaj na ciebie',
        actionSearch: 'Szukaj akcji',
        workflowSearch: 'Szukaj przepływów',
        libraryGroup: 'Twoje przepływy',
        noAgentTurn: 'Bez tury agenta.',
        useNumber: 'Użyj liczby',
        actionUnavailable: ({ action }: { action: string }) => `${action} nie jest tu dostępna.`,
        childInputs: ({ workflow }: { workflow: string }) => `Dane wejściowe pochodzą z ${workflow}.`,
        retryLoading: "Spróbuj wczytać ponownie",
        selfRef: ({ workflow }: { workflow: string }) => `${workflow} uruchamia ten przepływ, więc nie może działać w jego wnętrzu.`,
        maxFromInput: ({ name }: { name: string }) => `Z wejścia · ${name}`,
        useInput: ({ name }: { name: string }) => `Użyj wejścia ${name}`,
    },
    backToRun: 'Wróć do uruchomienia',
    reviewedCopyTitle: 'Sprawdź przed zapisaniem',
    reviewedCopyBody: 'To kopia z uruchomienia. Zapis obejmuje kroki i ustawienia, nie historię ani wyniki. Miejsce, tryb uruchomienia i wartości wejściowe dotyczą tylko uruchomienia. Sprawdź odwołania do istniejących sesji, folderów, profili, modeli, usług i serwerów MCP przed ponownym użyciem.',
    chromeTitle: 'Przepływ pracy',
    untitled: 'Przepływ bez nazwy',
    nameLabel: 'Nazwa przepływu',
    descriptionPlaceholder: 'Dodaj opis',
    descriptionLabel: 'Opis',
    save: 'Zapisz',
    flow: 'Przebieg',
    flowSubtitle: 'Ten szkic jako mapa',
    settings: 'Ustawienia przepływu',
    settingsSubtitle: 'Każdy krok ich używa, chyba że je zmieni.',
    deleteWorkflow: 'Usuń przepływ',
    deleteBody: 'Wcześniejsze uruchomienia zostają w historii.',
    deleteFailedTitle: 'Nie udało się usunąć przepływu',
    changedForStep: 'Zmienione dla tego kroku',
    issuesToFix: ({ count }: { count: number }) => `${count} ${pluralPl(count, 'rzecz', 'rzeczy', 'rzeczy')} do poprawienia przed uruchomieniem`,
    saveStatus: {
        notSaved: 'Jeszcze nie zapisano',
        unsaved: 'Niezapisane zmiany',
        saving: 'Zapisywanie…',
        saved: 'Zapisano',
        savedJustNow: 'Zapisano przed chwilą',
        savedAge: ({ age }: { age: string }) => `Zapisano ${age}`,
        failed: 'Nie udało się zapisać',
        yourEdits: 'Twoje zmiany',
        newerVersion: 'Nowsza wersja',
        newerVersionRevision: ({ revision }: { revision: string }) => `Nowsza wersja · ${revision}`,
    },
    where: {
        label: 'Gdzie działa',
        choose: 'Wybierz, gdzie działa',
    },
    sections: {
        whereTitle: 'Gdzie działa',
        machineAndProject: 'Maszyna i projekt',
        eachStepRunsIn: 'Każdy krok działa w',
        eachStepSession: 'Każdy krok pojawia się na liście sesji, pod tym uruchomieniem.',
        eachStepBackground: 'Każdy krok działa w tle, pod tym uruchomieniem.',
        aSession: 'Sesji',
        aBackgroundRun: 'Uruchomieniu w tle',
        agentTitle: 'Agent i model',
        agentDescription: 'Kroki ich używają, chyba że wybiorą własne.',
        rolesTitle: 'Role dla tego workflow',
        conversationTitle: 'Rozmowa i obszar roboczy',
        inputsTitle: 'Dane wejściowe i wynik',
    },
    unavailable: {
        machine_not_selected: 'Najpierw wybierz maszynę.',
        capability_unknown: 'Sprawdzanie, co obsługuje ta maszyna.',
        machine_does_not_support_detached_runs: 'Ta maszyna nie obsługuje jeszcze uruchomień w tle.',
    },
    /** Workflow settings and Step options (U-9): group summaries and the block subject. */
    inspector: {
        stepOptions: 'Opcje kroku',
        whereMissing: 'Nie wybrano maszyny',
        none: 'Brak',
        inputCount: ({ count }) => `${count} ${pluralPl(count, 'dana wejściowa', 'dane wejściowe', 'danych wejściowych')}`,
        finalOutput: ({ output }) => `Wynik końcowy: ${output}`,
        originSession: 'Sesja, która go uruchomiła',
        differsFromWorkflow: 'różni się od przepływu',
        followsWorkflow: 'używa ustawień przepływu',
        advancedTitle: 'Zaawansowane',
        deadline: ({ ms }) => `Czeka ${ms} ms na wynik`,
        workflowDefault: ({ value }) => `Domyślne przepływu · ${value}`,
        aSession: 'Sesja…',
        continues: ({ session }) => `Kontynuuje ${session}`,
        runsIn: 'Działa w',
        runsInBoundBySession: 'Kontynuuje sesję, więc działa w tej sesji.',
        reviewTitle: 'Sprawdź przed kontynuacją',
        reviewDescription: 'Kolejne kroki na tym torze czekają, aż użyjesz, zmienisz lub wygenerujesz ponownie wynik. Pozostała praca trwa dalej.',
        reviewEvaluator: 'Każda runda czeka na Twoje sprawdzenie.',
        reviewsBeforeContinuing: 'Sprawdzenie przed kontynuacją',
        resultTitle: 'Wynik',
        resultFromAction: ({ action }) => `Określony przez ${action}`,
        resultFromWorkflow: ({ workflow }) => `Zwraca to, co zwraca ${workflow}`,
        back: 'Wstecz',
        options: 'Opcje',
        itemConversation: 'Osobna rozmowa dla każdego elementu; kroki w środku ją współdzielą.',
        dropContinue: ({ session }) => `Kontynuuj ${session} w tym kroku`,
        dropRefused: ({ session, machine, where }) => `${session} jest na ${machine}; ten przepływ działa na ${where}.`,
        lanes: ({ count }) => `Równolegle · torów: ${count}`,
        lane: ({ position }) => `Tor ${position}`,
        forEachIn: ({ source }) => `Dla każdego elementu w ${source}`,
        atATime: ({ count }) => `${count} naraz`,
        repeatTimes: ({ count }) => `Powtórz ${count} razy`,
        repeatUntil: ({ condition }) => `Powtarzaj, aż ${condition}`,
        repeatUntilDecided: 'Powtarzaj, aż krok każe przestać',
        ifSentence: ({ condition }) => `Jeśli ${condition}`,
        onlyWhenSentence: ({ condition }) => `Tylko gdy ${condition}`,
        conditionAll: 'wszystkie są spełnione',
        conditionAny: 'któryś jest spełniony',
        conditionNot: ({ condition }) => `nie (${condition})`,
        returnsStructured: 'Zwraca dane strukturalne',
        returnsDecision: 'Zwraca decyzję',
    },
};

const workflowEditorPageTranslations = { pl } as const;

return { workflowEditorPageTranslations };
})();

const Domain_workflowExamplesTranslations = (() => {
type ExampleCopy = Shared_workflowExamplesTranslations.ExampleCopy;

type Copy = Shared_workflowExamplesTranslations.Copy;

const workflowExamplesTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "pl"> = { pl: {
        nodes: { ask: 'Zapytaj', 'review-correctness': 'Sprawdź poprawność', 'review-tests': 'Sprawdź testy', summarize: 'Podsumuj ustalenia', analyze: 'Analizuj', review: 'Przejrzyj', fix: 'Napraw', check: 'Sprawdź', classify: 'Klasyfikuj', reply: 'Przygotuj odpowiedź', digest: 'Podsumuj zmiany' },
        title: 'Zacznij od przykładu', fromExample: 'Z przykładu', description: 'Każdy otwiera się jako szkic. Nic nie ruszy, dopóki nie wybierzesz Uruchom teraz.', use: 'Użyj tego', chooseSession: 'Wybierz sesję…', builtInDescription: 'Część Happier. Powiel, aby zmienić.', stepCount: ({ count }) => `Kroki: ${count}`,
        askOnce: { title: 'Zapytaj raz', description: 'Jeden krok: zapytaj agenta i otrzymaj odpowiedź.' },
        reviewPullRequest: { title: 'Sprawdź pull request', description: 'Dwóch recenzentów równolegle, potem podsumowanie wszystkich ustaleń.' },
        workThroughEachFile: { title: 'Pracuj nad każdym plikiem', description: 'Każdy plik z listy po kolei: przeanalizuj go, potem sprawdź zmianę.' },
        repairUntilItPasses: { title: 'Naprawiaj do powodzenia', description: 'Naprawiaj i sprawdzaj do powodzenia lub wyczerpania dozwolonych prób. Potem sprawdź ostatnią naprawę.' },
        triageAnIssue: { title: 'Sklasyfikuj zgłoszenie', description: 'Sklasyfikuj zgłoszenie. Napraw błąd lub przygotuj odpowiedź.' },
        morningDigest: { title: 'Poranne podsumowanie', description: 'Podsumuj zmiany projektu i wyślij je sobie. Dodaj wyzwalacz na każdy poranek.' },
    } };

return { workflowExamplesTranslations };
})();

const Domain_workflowPluginTranslations = (() => {
type Copy = Shared_workflowPluginTranslations.Copy;

const en = Shared_workflowPluginTranslations.en;

const workflowPluginTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "pl"> = { pl: { fromPlugins: 'Z wtyczek', readOnly: 'Tylko do odczytu · skopiuj do biblioteki, aby edytować', duplicateToLibrary: 'Skopiuj do swojej biblioteki' } };

return { workflowPluginTranslations };
})();

const Domain_workflowRunVisibilityTranslations = (() => {
type VisibilityCopy = Shared_workflowRunVisibilityTranslations.VisibilityCopy;

const workflowRunVisibilityTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', VisibilityCopy>, "pl"> = { pl: { title: "Widoczność", chooseTeam: "Wybierz zespół", loadFailed: "Nie udało się sprawdzić, kto może zobaczyć to uruchomienie", machines: "Działa na Twoich maszynach", transcripts: "Członkowie zespołu mogą przeglądać rozmowy kroków.", requiredSessionsEditable: "Członkowie tego zespołu mogą edytować jego sesje", visibleTo: ({ team }) => "Widoczne dla " + team } };

return { workflowRunVisibilityTranslations };
})();

const Domain_workflowRunCompositionTranslations = (() => {
const workflowRunVisibilityTranslations = {...Domain_workflowRunVisibilityTranslations.workflowRunVisibilityTranslations, ...EnglishFeatures.workflowRunVisibilityTranslations.workflowRunVisibilityTranslations};

const en = Shared_workflowRunCompositionTranslations.en;

const workflowRunCompositionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "pl"> = { pl: { visibility: workflowRunVisibilityTranslations.pl, runWithAnotherAgent: 'Uruchom ponownie z innym agentem', agentForStep: ({ step }) => `Agent dla ${step}`, chooseAgent: 'Wybierz agenta lub rolę' } };

return { workflowRunCompositionTranslations };
})();

const Domain_workflowRunListTranslations = (() => {
type Progress = Shared_workflowRunListTranslations.Progress;

const en = Shared_workflowRunListTranslations.en;

const workflowRunListTranslations = { pl: {
        definitions: 'Definicje',
        stepsProgress: ({ completed, total }: Progress) => `${completed} z ${total} kroków`,
        loopProgress: ({ completed, total }: Progress) => `${completed} z ${total} elementów`,
        startedByAgent: 'Uruchomiono przez agenta',
        startedByTrigger: 'Uruchomiono przez wyzwalacz',
    } } satisfies Pick<Record<string, typeof en>, "pl">;

return { workflowRunListTranslations };
})();

const Domain_workflowRunRoleTranslations = (() => {
const en = Shared_workflowRunRoleTranslations.en;

const workflowRunRoleTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "pl"> = { pl: { rolesTitle: 'Role dla tego uruchomienia', rolesYour: 'Twoje role', rolesChanged: ({ count }) => `${count} zmienionych dla tego uruchomienia`, rolesUnchanged: 'Wszystko inne pozostaje bez zmian.', useYourRole: 'Użyj swojej roli', targetsTitle: 'Każdy krok działa w', rolesPrefillFailed: 'Nie udało się odczytać ról z ostatniego uruchomienia. Spróbuj ponownie.' } };

return { workflowRunRoleTranslations };
})();

const Domain_workflowStartTranslations = (() => {
type Copy = Shared_workflowStartTranslations.Copy;

const workflowRunRoleTranslations = {...Domain_workflowRunRoleTranslations.workflowRunRoleTranslations, ...EnglishFeatures.workflowRunRoleTranslations.workflowRunRoleTranslations};

const workflowRunCompositionTranslations = {...Domain_workflowRunCompositionTranslations.workflowRunCompositionTranslations, ...EnglishFeatures.workflowRunCompositionTranslations.workflowRunCompositionTranslations};

const en = Shared_workflowStartTranslations.en;

const workflowStartTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "pl"> = { pl: { ...workflowRunRoleTranslations.pl, ...workflowRunCompositionTranslations.pl, neededNamed: ({ name }) => `Dane wejściowe · brakuje: ${name}`, addToStart: ({ name }) => `Dodaj ${name}, aby uruchomić`, workflow: 'Workflow', inputs: 'Dane wejściowe', start: 'Uruchom', starting: 'Uruchamianie…', stillStarting: 'Nadal trwa uruchamianie…', needed: ({ count }) => `Dane wejściowe · brakuje ${count}`, required: 'Wymagane do uruchomienia', preview: 'Co zrobi', unsaved: 'Zawiera niezapisane zmiany', remove: 'Wróć do zwykłej sesji', search: 'Znajdź workflow', builtin: 'Wbudowane', library: 'Twoja biblioteka', noInputs: 'Nie wymaga danych', asksFor: ({ names }) => `Wymaga: ${names}`, optional: 'Opcjonalne — pozostawione puste', defaultValue: ({ value }) => `Domyślnie: ${value}` } };

return { workflowStartTranslations };
})();

const Domain_workflowsDestinationTranslations = (() => {
type WorkflowsDestinationTranslations = Shared_workflowsDestinationTranslations.WorkflowsDestinationTranslations;

const en = Shared_workflowsDestinationTranslations.en;

const pl: WorkflowsDestinationTranslations = {
    description: 'Przepisy, które twoi agenci wykonują na twoich maszynach — kiedy zechcesz, według harmonogramu albo gdy coś się wydarzy.',
    import: 'Importuj',
    addAccessibility: 'Dodaj przepływ pracy',
    moreAccessibility: 'Więcej opcji przepływów pracy',
    addMenu: {
        newWorkflowSubtitle: 'Zacznij od pustego szkicu',
        importSubtitle: 'Plik JSON przepływu pracy',
    },
    sections: {
        needsYou: 'Czeka na ciebie',
        running: 'W toku',
        library: 'Biblioteka',
        sharedWithYou: 'Udostępnione tobie',
        triggers: 'Wyzwalacze',
        history: 'Historia',
    },
    allRuns: 'Wszystkie uruchomienia',
    lastRun: ({ age }) => `ostatnio ${age}`,
    strip: {
        label: ({ count, parts }) => `Ostatnie uruchomienia (${count}): ${parts}`,
        labelPlain: ({ count }) => `Ostatnie uruchomienia (${count})`,
        completed: ({ count }) => `ukończone: ${count}`,
        failed: ({ count }) => `nieudane: ${count}`,
        needsYou: ({ count }) => `czekają na ciebie: ${count}`,
        separator: ', ',
    },
    runSettings: 'Ustawienia uruchomień',
    libraryEmpty: 'Zapisane przepływy pracy pojawią się tutaj.',
    waitingForYou: ({ age }) => `Czeka na ciebie · ${age}`,
    stateAge: ({ state, age }) => `${state} · ${age}`,
    triggerRow: ({ when, then }) => `${when} · ${then}`,
    thenSendPrompt: 'Wyślij polecenie',
    thenRunWorkflow: 'Uruchom przepływ pracy',
    offline: 'Offline',
    off: 'Wyłączony',
    columnLoadFailed: 'Nie udało się wczytać przepływów pracy. Nic z tego, co zapisano, nie zginęło.',
    firstVisitTitle: 'Zapisuj polecenia, które działają, i uruchamiaj je ponownie',
    firstVisitBody: 'Przepływ pracy to zestaw kroków, które twoi agenci wykonują po kolei, równolegle albo raz dla każdego elementu — kiedy zechcesz, według harmonogramu albo gdy coś się wydarzy.',
    importPrompt: 'Masz plik przepływu pracy?',
    loadMoreWorkflows: 'Wczytaj więcej przepływów pracy',
    searchPlaceholder: 'Szukaj przepływów pracy',
    noMatch: ({ query }) => `Żaden przepływ pracy nie pasuje do „${query}”`,
    views: {
        all: 'Wszystkie',
        triggered: 'Z wyzwalaczem',
        active: 'Aktywne',
        needsYou: 'Czeka na ciebie',
        libraryAccessibility: 'Które przepływy pracy pokazać',
        historyAccessibility: 'Które uruchomienia pokazać',
    },
    history: {
        title: 'Historia',
        description: 'Każde uruchomienie, które rozpocząłeś, niezależnie od tego, jak się zaczęło.',
        loadMore: 'Wczytaj więcej uruchomień',
        loadFailedTitle: 'Nie udało się wczytać uruchomień',
        loadFailedBody: 'Twoja praca nie jest zagrożona.',
        review: 'Przejrzyj',
        rowMeta: ({ origin, machine, age }) => `${origin} · ${machine} · ${age}`,
    },
    rowMenu: {
        accessibility: 'Opcje przepływu pracy',
        runNow: 'Uruchom teraz',
        share: 'Udostępnij…',
    },
    deleteTitle: 'Usunąć ten przepływ pracy?',
    deleteBody: 'Wcześniejsze uruchomienia zostają w Historii.',
    deleteFailedTitle: 'Nie udało się usunąć przepływu pracy',
    exportFailedTitle: 'Nie udało się wyeksportować przepływu pracy',
    gate: {
        localTitle: 'Automatyzacje są wyłączone na tym urządzeniu',
        localBody: 'Włącz je, aby uruchamiać przepływy pracy i ich wyzwalacze.',
        dependencyTitle: 'Przepływy pracy wymagają automatyzacji',
        dependencyBody: 'Włącz automatyzacje, aby tworzyć i uruchamiać przepływy pracy.',
        openSettings: 'Otwórz ustawienia',
    },
    runSettingsPage: {
        title: 'Ustawienia uruchomień',
        description: 'Ile uruchomień każda maszyna przyjmuje naraz i jak długo przechowywana jest historia.',
        saveFailed: 'Nie udało się zapisać ustawień uruchomień. Twoje zmiany wciąż tu są.',
    },
};

const workflowsDestinationTranslations = { pl } as const;

return { workflowsDestinationTranslations };
})();

const Domain_workflowTriggersTranslations = (() => {
type Count = Shared_workflowTriggersTranslations.Count;

type WorkflowTriggersCopy = Shared_workflowTriggersTranslations.WorkflowTriggersCopy;

const en = Shared_workflowTriggersTranslations.en;

const pl: WorkflowTriggersCopy = {
    pullRequest: {
        label: "Pull request",
        description: "Dodanie tego wyzwalacza łączy pull request z tą sesją.",
        empty: "Brak otwartych pull requestów",
        loadFailed: "Nie udało się wczytać pull requestów",
    },
    summary: {
        everyDayAt: ({ time }) => `Codziennie o ${time}`,
        weekdaysAt: ({ time }) => `W dni robocze o ${time}`,
        weeklyAt: ({ day, time }) => `W każdy dzień: ${day}, o ${time}`,
        everyMinutes: ({ count }) => (count === 1 ? 'Co minutę' : `Co ${count} min`),
        everyHours: ({ count }) => (count === 1 ? 'Co godzinę' : `Co ${count} godz.`),
        cron: ({ expression }) => `Według harmonogramu · ${expression}`,
        schedule: 'Według harmonogramu',
        event: ({ event }) => `Gdy wystąpi ${event}`,
        manual: 'Ręcznie',
        more: ({ first, count }) => `${first} · jeszcze ${count}`,
    },
    kind: {
        sessionStarts: 'Gdy sesja się zaczyna',
        sessionArchived: 'Gdy sesja zostaje zarchiwizowana',
        schedule: 'Według harmonogramu',
        prComment: 'Gdy ktoś skomentuje pull request',
        ciFailed: 'Gdy CI zawiedzie w pull requeście',
        turnEnds: 'Gdy kończy się tura',
        needsYou: 'Gdy sesja cię potrzebuje',
        runEnds: 'Gdy przebieg się kończy',
        runNeedsYou: 'Gdy przebieg cię potrzebuje',
    },
    row: {
        workflowDeleted: 'Przepływ usunięty',
        legacyCreated: 'Utworzono w Happier 0.2',
        legacyUnavailable: 'Starszy wyzwalacz niedostępny',
        sessionKeyRequired: 'Wymagany klucz sesji',
        templateRecoveryRequired: 'Odzyskaj wyzwalacz w zabezpieczeniach konta',
        templateDecryptionFailed: 'Nie udało się odszyfrować wyzwalacza',
        machines: ({ count }: Count) => `${count} maszyn`,
        nextRun: ({ time }: { time: string }) => `Następne uruchomienie: ${time}`,
        steps: ({ count }) => (count === 1 ? `${count} krok` : `${count} kroki`),
        off: 'Wyłączony',
        running: 'Trwa',
        ran: ({ age }) => `Uruchomiono ${age}`,
        turnOn: ({ name }) => `Włącz ${name}`,
        turnOff: ({ name }) => `Wyłącz ${name}`,
    },
    section: {
        add: 'Dodaj wyzwalacz',
        emptyTitle: 'Brak wyzwalaczy',
        emptyBody: 'Dodaj jeden, aby przeglądać każdą turę, dążyć do celu lub reagować na pull request.',
        loadFailed: 'Nie udało się wczytać wyzwalaczy tej sesji.',
        title: 'Wyzwalacze',
        countOn: ({ count }) => `${count} włączone`,
        info: 'Co uruchamia się w tej sesji, gdy coś się wydarzy. Zostają z tą sesją i nie pojawiają się w twojej bibliotece.',
        saveFailed: 'Nie udało się zapisać tego wyzwalacza. Twoje zmiany nadal tu są.',
    },    kindDescription: {
        turnEnds: 'Po turze twojej lub agenta, z którym pracujesz.',
        needsYou: 'Zawsze gdy ta sesja na ciebie czeka, także gdy prowadzi ją przepływ lub Kontynuuj do końca.',
        sessionArchived: 'Uruchamia się raz, gdy archiwizujesz tę sesję.',
        sessionStarts: 'Tylko przy tworzeniu sesji.',
        schedule: 'Kontynuuje tę sesję według harmonogramu.',
        prComment: 'Tylko osoby z dostępem do zapisu. Komentarz jest przekazywany jako cytat.',
        pullRequestUnavailable: 'Wyzwalaczy pull requestów nie można jeszcze tu dodać.',
    },
    then: {
        runsIn: 'Działa w',
        runsInChoice: {
            newSession: 'Nowej sesji',
            session: 'Sesji…',
            backgroundRun: 'Uruchomieniu w tle',
        },
        noSessionOnMachine: 'Na tej maszynie nie ma jeszcze sesji',
        session: 'Sesja',
        action: 'Akcja',
        label: 'Wtedy',
        sendPrompt: 'Wyślij prompt',
        doAction: 'Wykonaj akcję',
        notifyMe: 'Powiadom mnie',
        runWorkflow: 'Uruchom przepływ',
        sendPromptDescription: 'Agent tej sesji dostaje ten prompt w tej sesji. Nigdy nie przerywa twojej tury.',
        promptLabel: 'Prompt',
        promptPlaceholder: 'Co ma zrobić agent?',
        message: 'Wiadomość',
        title: 'Tytuł',
        sendTo: 'Wyślij do',
        sendToDefault: 'Twoje ustawienia powiadomień',
        workflow: 'Przepływ',
        choose: 'Wybierz…',
    },
    popover: {
        saveAsWorkflow: 'Zapisz jako przepływ',
        saveAsWorkflowDescription: 'Otwiera te kroki jako nowy przepływ do przejrzenia. Ten wyzwalacz zachowuje własne kroki.',
        when: 'Kiedy',
        newTrigger: 'Nowy wyzwalacz',
        addTrigger: 'Dodaj wyzwalacz',
        cancel: 'Anuluj',
        done: 'Gotowe',
        turnOff: 'Wyłącz',
        turnOn: 'Włącz',
        deleteTrigger: 'Usuń wyzwalacz',
        repeat: 'Powtarzaj',
        everyDay: 'Codziennie',
        weekdays: 'Dni robocze',
        weekly: 'Co tydzień',
        day: 'Dzień',
        at: 'O',
        expression: 'Harmonogram',
        tryAgain: 'Spróbuj ponownie',
    },    editor: {
        runsOn: 'Działa na',
        runsOnDescription: 'Wszystkie wyzwalacze tego przepływu działają tutaj.',
        runsOnAccountDescription: 'Gdzie działa ten wyzwalacz.',
        runsOnDiffers: ({ where }) => `Uruchom teraz używa zamiast tego ${where}.`,
        sameForAllTriggers: 'Takie samo dla wszystkich wyzwalaczy',
        roles: 'Role',
        retargetFailed: 'Przepływ zapisany · Wyzwalacz niezaktualizowany',
        editInWorkflows: 'Zmień ten wyzwalacz w Przepływach. Działa dalej bez zmian.',
        title: 'Uruchamia się automatycznie',
        runsBy: 'Uruchamia się sam, gdy wydarzy się jedno z tych zdarzeń.',
        runsByOn: ({ where }) => `Uruchamia się sam, gdy wydarzy się jedno z tych zdarzeń, na ${where}.`,
        savedWorkflow: 'Wyzwalacze uruchamiają zapisany przepływ.',
        saveToInclude: 'Wyzwalacze uruchamiają zapisany przepływ. Zapisz, aby uwzględnić zmiany.',
        newRow: 'Nowy · jeszcze nie dodany',
        partialSave: 'Przepływ zapisany · Wyzwalacze niezaktualizowane',
    },    column: {
        newTrigger: 'Nowy wyzwalacz',
        newTriggerSubtitle: 'Uruchamia własne kroki według harmonogramu',
    },
};

const legacyTranslations = { pl: {
        editNotice: 'Utworzono w Happier 0.2. Otwarcie niczego nie zmienia.',
        conversionBoundary: 'Po tej zmianie działa tylko na maszynach z Happier 0.3 lub nowszym.',
        channelReplyRefusal: 'Ta automatyzacja ma powiązanie odpowiedzi z kanałem, którego nie można przenieść. Nie została przekształcona; ustawienia i twoje zmiany pozostają bez zmian.',
        notAvailable: 'Ta automatyzacja nie jest już dostępna.',
    } };

const creationTranslations = { pl: { savedWorkflowsUnavailable: 'Przełącz się na serwer tej sesji, aby wybrać zapisany przepływ. Wbudowane przepływy i własne kroki nadal są dostępne.' } };

const workflowTriggersTranslations = { pl: { ...pl, legacy: legacyTranslations.pl, creation: creationTranslations.pl } } as const;

return { legacyTranslations, creationTranslations, workflowTriggersTranslations };
})();

const Domain_workflowValueReferenceTranslations = (() => {
const workflowValueReferenceTranslations = { pl: {
        checkoutRoot: 'Folder główny kopii roboczej',
        unavailableValue: 'Wartość niedostępna', sessionContext: ({ turns }: { turns: number }) => turns === 0 ? 'Kontekst sesji' : `Ostatnie tury sesji: ${turns}`,
        tokensUsed: 'Użyte tokeny', goalTokenBudget: 'Budżet tokenów celu',
        trailingCount: ({ source, value }: { source: string; value: string }) => `Kolejne ${source} pasujące do ${value}`,
        stopCondition: 'Warunek zatrzymania spełniony', stopConditionArm: ({ arm }: { arm: number }) => `Warunek zatrzymania ${arm} spełniony`,
        roundLimit: ({ rounds }: { rounds: number }) => `Osiągnięto limit · liczba rund: ${rounds}`, decision: 'Decyzja',
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

const pl = translated(workflowValueReferenceTranslations.pl, {
    title: 'Przepływy pracy',
    newWorkflow: 'Nowy przepływ pracy',
    copyName: ({ name }: { name: string }) => `${name} kopia`,
    importJson: 'Importuj JSON',
    exportJson: 'Eksportuj JSON',
    openCollection: 'Otwórz przepływy pracy',
    destination: workflowsDestinationTranslations.pl,
    plugins: workflowPluginTranslations.pl,
    authoring: workflowAgentAuthoringTranslations.pl,
    page: workflowEditorPageTranslations.pl,
    actionTitles: workflowActionTranslations.pl,
    builtins: workflowBuiltinTranslations.pl,
    examples: workflowExamplesTranslations.pl,
    triggers: workflowTriggersTranslations.pl,
    start: workflowStartTranslations.pl,
    list: workflowRunListTranslations.pl,
    review: {
        publishedByAgent: 'Opublikowane przez agenta',
        publishedByYou: 'Opublikowane przez ciebie',
        editedByYou: 'Edytowane przez ciebie',
        editedByPerson: 'Edytowane przez inną osobę',
        previousAttempt: 'Poprzednia próba',
        useBody: "Kolejne kroki otrzymają dokładnie to, co widzisz. Bez tury agenta.",
        usePlanBody: "Akceptuje dokładnie ten plan. Bez tury agenta.",
        reportBackTitle: ({ session }) => "Przekaż wynik do " + session,
        reportBackBody: ({ session }) => session + " otrzyma wynik tego uruchomienia po zakończeniu.",
        planRunNotice: "Uruchamia proponowany workflow dokładnie tak, jak pokazano, i akceptuje plan. Nie zapisuje go.",
        editedPlanBody: 'Ten szkic różni się od propozycji. Najpierw zaakceptować sprawdzony plan do edycji? Twoje zmiany pozostaną tutaj i nic nie wystartuje, dopóki ponownie nie uruchomisz szkicu.',
        title: "Wynik do sprawdzenia",
        planTitle: "Plan do sprawdzenia",
        waitTitle: "Czeka na Ciebie",
        waitBody: "Ta gałąź czeka, aż przejdziesz dalej.",
        editsTitle: "Twoje niezapisane zmiany",
        editsBody: "Zapisany wynik pozostaje bez zmian, dopóki go nie użyjesz.",
        heldBody: "Czeka na sprawdzenie · jeszcze nie przekazano do kolejnych kroków",
        noValue: "Nie ma jeszcze poprawnego wyniku",
        useResult: "Użyj tego wyniku",
        usePlan: "Użyj tego planu",
        useValues: "Użyj tych wartości",
        continue: "Kontynuuj",
        invalid: "Najpierw popraw zaznaczone pole.",
        newer: "Dostępny jest nowszy wynik.",
        showNewer: "Pokaż nowszy",
        keepMyEdits: 'Zachowaj moje zmiany',
        useNewer: 'Użyj nowszego',
        showFullResult: 'Pokaż cały wynik',
        showFullPlan: 'Pokaż cały plan',
        generationRequested: "Zlecono generowanie",
        startsResume: "Zacznie się po wznowieniu uruchomienia.",
        generateBody: "Agent zapisze nowy wynik w tej rozmowie. Jeśli będzie poprawny, uruchomienie będzie kontynuowane bez ponownego pytania.",
        acceptedPaused: "Użycie wyniku pozostawia workflow wstrzymany.",
        editResult: "Edytuj wynik",
        generate: "Wygeneruj wynik i kontynuuj",
        discuss: "Porozmawiaj",
        discussBody: "Odpowiedz w rozmowie tego kroku. Agent może opublikować tu zaktualizowany wynik.",
        proposal: "Proponowany workflow",
        planStarted: "Uruchomienie z tego planu już się rozpoczęło",
        earlierPlanStarted: "Uruchomiono już wcześniejszą propozycję",
        openEarlierPlanRun: "Otwórz to uruchomienie",
        runNewProposal: "Uruchom nową propozycję",
        runPlan: "Uruchom jako workflow",
        runPlanBody: "Otwiera przegląd proponowanego workflow. Rozpoczęcie akceptuje też ten plan.",
        editPlan: "Najpierw edytuj workflow",
        editPlanBody: "Akceptuje plan i otwiera proponowany workflow jako niezapisany szkic.",
        editPlanFallback: "Akceptuje plan i otwiera workflow z jednym krokiem, używając planu jako instrukcji.",
        waitingMachine: ({ machine }) => "Czeka na " + machine,
    },

    tabs: {
        saved: 'Zapisane',
        runs: 'Uruchomienia',
        steps: 'Kroki',
        flow: 'Schemat',
        map: 'Mapa',
        activity: 'Aktywność',
    },
    tabsAccessibility: {
        savedRuns: 'Zapisane przepływy pracy lub uruchomienia',
        stepsFlow: 'Kroki lub schemat',
        activityFlow: 'Aktywność lub schemat',
        runViews: "Widoki uruchomienia",
    },

    filters: {
        all: 'Wszystko',
        active: 'Aktywne',
        needsYou: 'Wymaga Ciebie',
        clear: 'Wyczyść filtr',
    },

    empty: {
        savedTitle: 'Nie masz jeszcze zapisanych przepływów pracy',
        savedBody: 'Zapisanie przepływu pracy zachowuje definicję, której możesz użyć ponownie — uruchomić ją albo zaplanować.',
        runsTitle: 'Nic jeszcze nie zostało uruchomione',
        runsBody: 'Uruchomienia pojawiają się tutaj niezależnie od tego, czy zapiszesz przepływ pracy.',
        filteredTitle: 'Żadne uruchomienie nie pasuje do tego filtra',
        filteredBody: 'Wyczyść filtr, aby zobaczyć pozostałe uruchomienia.',
        missingTitle: 'Ten workflow jest niedostępny',
        missingBody: 'Happier nie mógł otworzyć workflow, do którego prowadzi ten link. Pozostałe workflow, Automatyzacje i uruchomienia są nienaruszone.',
    },

    loadFailedTitle: 'Nie udało się wczytać przepływów pracy',
    loadFailedBody: 'Twoja praca pozostaje nienaruszona. Spróbuj ponownie, kiedy zechcesz.',
    retry: 'Spróbuj ponownie',
    contentUnavailable: 'Prywatna zawartość jest niedostępna na tym urządzeniu.',
    contentReasons: {
        invalidHeader: 'Zapisane informacje tego przepływu pracy są nieprawidłowe.',
        revisionMismatch: 'Ten przepływ pracy nie odpowiada zapisanej rewizji.',
        missingBody: 'Brakuje zapisanej definicji tego przepływu pracy.',
        invalidBody: 'Zapisana definicja tego przepływu pracy jest nieprawidłowa.',
        notFound: 'Ten przepływ pracy nie jest już dostępny.',
    },

    sessionEntry: {
        missingTitle: 'Ta sesja nie jest już dostępna',
        missingBody: 'Mogła zostać usunięta albo znajduje się w innym Home. Otwórz Sesje, aby ją znaleźć.',
        inaccessibleTitle: 'Nie możesz otworzyć tej sesji',
        inaccessibleBody: 'Happier nie potwierdził dostępu. Zaloguj się ponownie lub poproś właściciela, a potem otwórz tę stronę jeszcze raz.',
        failedTitle: 'Nie udało się otworzyć tej sesji',
        failedBody: 'Happier próbuje dalej. Możesz spróbować teraz ponownie.',
        unsupportedTitle: 'Ta sesja nie może uruchomić przepływu pracy',
        unsupportedBody: 'Happier nie odczytał agenta ani maszyny, na której działa. Utwórz przepływ pracy w sekcji Przepływy pracy.',
    },

    editor: {
        namePlaceholder: 'Nazwa przepływu pracy',
        agentRuntime: 'Środowisko wykonawcze agenta',
        firstPromptTitle: 'Co ma się wydarzyć najpierw?',
        firstPromptBody: 'Jeden prompt to już przepływ pracy. Dodawaj kroki wtedy, gdy będą potrzebne.',
        promptPlaceholder: 'Opisz, co ma zrobić ten krok',
        useWorkflowDefault: 'Użyj wartości z przepływu pracy',
        defaultsTitle: 'Ustawienia domyślne',
        produces: 'Zwraca',
        whereTitle: 'Gdzie',
        add: 'Dodaj',
        addAccessibility: 'Dodaj blok do tego przepływu pracy',
        addStep: 'Krok agenta',
        addParallel: 'Obok siebie',
        addLoop: 'Powtarzaj',
        addIf: 'Jeśli',
        targetRequired: 'Wybierz komputer i folder projektu dla tego przepływu pracy.',
        loadingTitle: 'Otwieranie przepływu pracy…',
        accountChangedTitle: 'Konto zostało zmienione',
        accountChangedBody: 'Ten przepływ pracy otworzyło poprzednie konto i nie można go przenieść. Otwórz go ponownie w Przepływach pracy.',
        loadFailedTitle: 'Nie udało się otworzyć tego przepływu pracy',
        loadFailedBody: 'Zapisanego przepływu pracy nie udało się teraz odczytać.',
        timeoutTitle: 'Oczekiwanie na wynik (ms)',
        noDeadline: 'Bez terminu',
        timeoutExplain: 'Milisekundy oczekiwania na wynik tego kroku, zanim będzie wymagał uwagi. Zostaw puste, aby nie ustawiać terminu.',
        wholeNumberRequired: 'Wpisz liczbę całkowitą równą co najmniej 1.',
        runNow: 'Uruchom teraz',
        save: 'Zapisz przepływ pracy',
        saveAutomation: 'Zapisz automatyzację',
        schedule: 'Zaplanuj',
        savedRevision: ({ revision }) => `Zapisano · ${revision}`,
        moveUp: 'Przenieś w górę',
        moveDown: 'Przenieś w dół',
        moveIn: 'Przenieś do grupy powyżej',
        moveOut: 'Wyjmij z tej grupy',
        remove: 'Usuń',
        undo: 'Cofnij',
        redo: 'Ponów',
        historyRestoreRequiresSetup: 'To zdarzenie trzeba skonfigurować ponownie. Zapisanej prywatnej konfiguracji nie można przywrócić po usunięciu.',
        history: { edited: 'Edytuj workflow', agent: 'Zmiana agenta', description: 'Edytuj opis', where: 'Zmień miejsce uruchomienia', target: 'Zmień uruchamianie kroków', triggers: 'Edytuj wyzwalacze', example: 'Wstaw przykład', document: 'Edytuj polecenie' },
        undoAction: ({ change }: { change: string }) => `Cofnij: ${change}`,
        redoAction: ({ change }: { change: string }) => `Ponów: ${change}`,
        removedBlock: ({ block }) => `Usunięto ${block}`,
        rename: 'Zmień nazwę',
        stepOrdinal: ({ position }) => `${position}`,
        unnamedStep: ({ position }) => `Krok ${position}`,
        unnamedParallel: 'Grupa równoległa',
        unnamedLoop: 'Pętla',
        unnamedIf: 'Warunek',
        branch: 'Gałąź',
        addBranch: 'Dodaj gałąź',
        ifTrue: 'Jeśli prawda',
        otherwise: 'W przeciwnym razie',
        addOtherwise: 'Dodaj gałąź „w przeciwnym razie”',
        evaluator: 'Zdecyduj, czy kontynuować',
        loopBody: 'Powtarzaj te kroki',
        continuation: 'Po każdej rundzie',
    },

    input: {
        label: 'Wejście',
        result: 'Wynik',
        change: 'Zmień',
        none: 'Brak wejścia',
        previousResult: ({ block }) => `Wynik: ${block}`,
        workflowInput: ({ name }) => `Wejście przepływu pracy ${name}`,
        currentItem: 'Bieżący element',
        iteration: 'Ta runda',
        unavailable: 'To źródło nie jest już dostępne',
        itemField: {
            value: 'Wartość elementu',
            index: 'Indeks elementu, od 0',
            position: 'Pozycja elementu, od 1',
            count: 'Liczba elementów',
        },
        iterationField: {
            index: 'Indeks rundy, od 0',
            position: 'Numer rundy, od 1',
            count: 'Liczba rund',
            stopReason: 'Powód zatrzymania',
        },
        valueKindGroup: 'Źródło wartości',
        inputNameGroup: 'Wejście przepływu',
        producerGroup: 'Krok źródłowy',
        workspaceFieldGroup: 'Pole obszaru roboczego',
        itemFieldGroup: 'Pole elementu',
        iterationFieldGroup: 'Pole rundy',
    },

    inputs: {
        title: 'Wejścia przepływu pracy',
        addInput: 'Dodaj wejście',
        namePlaceholder: 'Nazwa',
        descriptionPlaceholder: 'Do czego to służy?',
        required: 'Wymagane',
        optional: 'Opcjonalne',
        defaultValue: 'Wartość domyślna',
        typeString: 'Tekst',
        typeNumber: 'Liczba',
        typeBoolean: 'Tak lub nie',
        typeJson: 'Dane strukturalne',
        runSheetTitle: 'Uruchom ten przepływ pracy',
        runSheetBody: 'Podaj wartości, których wymaga ten przepływ pracy, a potem go uruchom.',
        missingRequired: 'Ta wartość jest wymagana.',
        wrongType: ({ type }) => `Ta wartość musi być typu ${type}.`,
    },

    finalOutput: {
        title: 'Wynik końcowy',
        none: 'Nie wybrano wyniku końcowego',
        change: 'Zmień',
        clear: 'Wyczyść wybór',
        fieldPath: 'Ścieżka pola',
        explain: 'Wynik końcowy to to, co ten przepływ pracy zwraca po zakończeniu. Kolejność ukończenia nigdy tego nie zmienia.',
    },

    conversation: {
        title: 'Rozmowa',
        sharedRun: 'Ta sama rozmowa',
        branchesShareAndTakeTurns: 'Gałęzie współdzielą jedną rozmowę i działają po kolei.',
        fresh: 'Osobne rozmowy',
        fromStep: ({ block }) => `Kontynuuj ${block}`,
        existingSession: 'Istniejąca sesja',
        existingSessionById: ({ sessionId }) => `Sesja ${sessionId}`,
        noExistingSessions: 'Żadnej sesji na tej maszynie nie można tu kontynuować.',
        chooseExistingSession: 'Wybierz sesję do kontynuowania',
        continuingKeepsAgentAndFolder: 'Kontynuacja zachowuje Agenta i folder tej rozmowy. Inny Agent lub folder wymaga osobnej rozmowy.',
        waitingForConversation: ({ block }) => `Czekamy, aż ${block} zakończy pracę w tej rozmowie.`,
        branchesUseSeparate: 'Gałęzie w grupie równoległej używają osobnych rozmów.',
    },

    workspace: {
        title: 'Obszar roboczy',
        inherit: 'Obszar roboczy przepływu pracy',
        projectCheckout: 'Folder projektu',
        fromStep: ({ block }) => `Kontynuuj w obszarze roboczym: ${block}`,
        newWorktreeOriginal: 'Nowy worktree z pierwotnego folderu',
        newWorktreeWorkflow: 'Nowy worktree z obszaru roboczego przepływu pracy',
        newWorktreeStep: ({ block }) => `Nowy worktree z: ${block}`,
        committedOnlyNote: 'Nowy worktree zawiera zatwierdzony stan folderu źródłowego. Zmiany przygotowane, niezatwierdzone i nieśledzone zostają w źródle.',
        reuseNote: 'Gdy obszar roboczy jest kontynuowany, widzi swoje niezatwierdzone pliki dokładnie takimi, jakie są.',
        sharedParallelNote: 'Gałęzie dzielące jeden obszar roboczy mogą pisać do niego w tym samym czasie.',
        unavailable: ({ block }) => `Obszar roboczy dla ${block} jest niedostępny.`,
        unavailableBody: 'Przywróć go, aby kontynuować to uruchomienie, albo przejrzyj nowe uruchomienie, które może powtórzyć już wykonaną pracę.',
        unavailableRestoreBody: 'Przywróć go, aby kontynuować to uruchomienie z nietkniętą ukończoną pracą.',
        unavailableNewRunBody: 'Nie da się go przywrócić. Sprawdzone nowe uruchomienie zaczyna od nowa, a ukończona praca może się powtórzyć.',
        restore: 'Przywróć',
        inspect: 'Sprawdź',
    },

    condition: {
        onlyWhen: 'Uruchom tylko, gdy',
        always: 'Zawsze',
        stopWhen: 'Zatrzymaj, gdy',
        ifWhen: 'Uruchom pierwszą gałąź, gdy',
        addCondition: 'Dodaj warunek',
        removeCondition: 'Usuń warunek',
        allOf: 'Wszystkie z nich',
        anyOf: 'Dowolny z nich',
        not: 'Nie',
        exists: 'ma wartość',
        operatorEq: 'jest',
        operatorNeq: 'nie jest',
        operatorLt: 'jest mniejsze niż',
        operatorLte: 'jest najwyżej',
        operatorGt: 'jest większe niż',
        operatorGte: 'jest co najmniej',
        valuePlaceholder: 'Wartość',
        skippedReason: ({ block }) => `Pominięto, bo warunek bloku ${block} nie był spełniony.`,
    },

    loop: {
        modeTitle: 'Powtarzaj',
        modeCount: 'Określoną liczbę razy',
        modeItems: 'Raz dla każdego elementu',
        modeUntil: 'Dopóki wynik nie każe przerwać',
        modeEvaluate: 'Dopóki Agent nie każe przerwać',
        count: 'Liczba powtórzeń',
        items: 'Lista',
        sequential: 'Elementy po kolei',
        parallel: 'Elementy równolegle',
        maxConcurrentItems: 'Maksymalna liczba równoczesnych elementów',
        maxConcurrentBranches: 'Maksymalna liczba równoczesnych gałęzi',
        noWorkflowLimit: 'Przepływ pracy nie ustala limitu',
        maxIterations: 'Maksymalna liczba rund',
        limitReached: 'Osiągnięto limit',
        historyTitle: 'Poprzednie oceny',
        historyNone: 'Brak',
        historyLatest: 'Ostatnia',
        historyAll: 'Wszystkie',
        historyExplain: 'To wybiera zapisane decyzje i uwagi, a nie całe transkrypcje.',
        continuingConversation: 'Ten oceniający zachowuje poprzednią rozmowę i dopisuje do niej każdą nową rundę.',
        emptyListCompletes: 'Pusta lista kończy się bez żadnej rundy.',
    },

    failurePolicy: {
        title: 'Jeśli krok się nie powiedzie',
        failStop: 'Zatrzymaj tę grupę przy błędzie',
        failStopExplain: 'Ta grupa przestaje rozpoczynać pracę i prosi aktywne gałęzie o zatrzymanie, także te niezależne. Ukończone wyniki i zmiany pozostają. To nie jest wycofanie zmian.',
        collectOutcomes: 'Dokończ niezależną pracę',
        collectOutcomesExplain: 'Sprawne gałęzie przechodzą cały swój łańcuch, a każdy wynik zostaje zebrany. Kroki po błędzie wewnątrz gałęzi nie są wykonywane.',
    },

    runState: {
        pending: 'Czeka na start',
        queued: 'Czeka na start',
        claimed: 'Uruchamianie',
        running: 'W trakcie',
        waiting_for_review: 'Czeka na twój przegląd',
        succeeded: 'Ukończono',
        failed: 'Niepowodzenie',
        cancel_requested: 'Zatrzymywanie',
        cancelled: 'Zatrzymano',
        pause_requested: 'Wstrzymywanie',
        paused: 'Wstrzymano',
        interrupted: 'Przerwano',
        expired: 'Wygasło przed startem',
        dispatch_failed: 'Nie udało się uruchomić',
        skipped: 'Pominięto',
        missed: 'Nieodebrane',
        outcome_uncertain: 'Niepewny wynik',
        completed: 'Ukończono',
        completed_with_failures: 'Ukończono z błędami',
    },

    invocationState: {
        pending: 'Czeka',
        waiting_for_capacity: 'Czeka na wolne miejsce',
        admitting: 'Uruchamianie',
        running: 'W trakcie',
        waiting_for_approval: 'Czeka na zatwierdzenie',
        waiting_for_review: 'Czeka na twój przegląd',
        needs_attention: 'Wymaga Ciebie',
        completed: 'Ukończono',
        failed: 'Niepowodzenie',
        skipped: 'Pominięto',
        cancel_requested: 'Zatrzymywanie',
        cancelled: 'Zatrzymano',
        outcome_uncertain: 'Niepewny wynik',
        superseded: 'Zastąpione późniejszą próbą',
    },

    run: {
        title: 'Uruchomienie',
        frozenVersion: "To uruchomienie używa wersji, z którą się rozpoczęło. Zmiany dotyczą tylko przyszłych uruchomień.",
        selectOccurrence: 'Wybierz krok',
        openReview: 'Sprawdź wynik',
        open: 'Otwórz uruchomienie',
        openExact: ({ title }) => `Otwórz uruchomienie ${title}`,
        openExecution: 'Otwórz uruchomienie w tle',
        loadMore: 'Wczytaj wcześniejsze kroki',
        origin: {
            direct: 'Uruchomione bezpośrednio',
            automation: 'Zaplanowane',
            fromSession: 'Z sesji',
        },
        needsYou: 'Wymaga Ciebie',
        needsYouLoadedCount: 'wczytano',
        review: 'Przejrzyj',
        stop: 'Zatrzymaj',
        stopAgain: 'Zatrzymaj ponownie',
        stopping: 'Zatrzymywanie…',
        stopRequested: ({ machine }) => `Poproszono o zatrzymanie. Czekamy na potwierdzenie z ${machine}.`,
        evidenceStale: 'Pokazujemy ostatnie znane szczegóły. Happier nie mógł potwierdzić, że są aktualne.',
        pauseAtBoundary: 'Wstrzymaj na najbliższej granicy',
        pausePending: 'Kończy bieżącą pracę, a potem się wstrzymuje.',
        paused: 'Wstrzymano po ostatniej ukończonej granicy.',
        resume: 'Wznów',
        runAgain: 'Uruchom przepływ pracy ponownie',
        retryStep: 'Powtórz krok',
        attempt: ({ attempt }) => `Próba ${attempt}`,
        untitled: 'Uruchomienie workflow',
        openResult: 'Otwórz wynik',
        inspectSteps: 'Przejrzyj kroki',
        seeFailures: 'Zobacz błędy',
        saveAsWorkflow: 'Zapisz jako przepływ pracy',
        saveAsNewWorkflow: 'Zapisz jako nowy przepływ pracy',
        showCurrentWork: 'Pokaż bieżącą pracę',
        editWorkflow: 'Edytuj przepływ pracy',
        openWorkflow: 'Otwórz przepływ pracy',
        deleteHistory: 'Usuń historię uruchomień',
        deleteHistoryConfirm: 'Wejścia i wyniki zostaną usunięte. Obszary robocze, rozmowy, zapisane przepływy pracy i automatyzacje pozostaną.',
        technicalDetails: 'Szczegóły techniczne',
        technical: {
            runId: 'Identyfikator uruchomienia',
            invocationId: 'Identyfikator kroku',
            machine: 'Komputer',
            machineId: 'ID komputera',
            revision: 'Wersja',
        },
        usageUnavailable: 'Zużycie niedostępne',
        startedAt: ({ time }: { time: string }) => `Uruchomiono ${time}`,
        timeRange: ({ start, end }) => `${start} – ${end}`,
        openConversation: 'Otwórz rozmowę',
        openChildRun: 'Otwórz jego uruchomienie',
        openStepDetails: 'Otwórz szczegóły',
        outcomeLine: ({ word, sentence }: { word: string; sentence: string }) => `${word} — ${sentence}`,
        attentionReviewRow: ({ step }: { step: string }) => `${step} czeka na twoją weryfikację`,
        attentionWaitRow: ({ step }: { step: string }) => `${step} czeka na ciebie`,
        attentionReviewSentence: ({ step }: { step: string }) => `${step} czeka na twoją weryfikację.`,
        attentionWaitSentence: ({ step }: { step: string }) => `${step} czeka na ciebie.`,
        reviewing: 'Weryfikujesz',
        notStarted: 'Nie uruchomiono',
        machineUnavailable: ({ machine }) => `To uruchomienie straciło kontakt z ${machine}.`,
        machineUnavailableBody: 'Możliwości wznowienia pojawią się, gdy poznamy bieżący stan.',
        completedCount: ({ count }) =>
            `Zakończono ${count} ${pluralPl(count, 'krok', 'kroki', 'kroków')}.`,
        completedWithFailures: ({ completed, failed }) =>
            `Ukończono z błędami. Zakończono: ${completed}. Nie udało się zakończyć: ${failed}.`,
        approvalWanted: ({ block }) => `${block} chce wykonać polecenie.`,
        approvalWantedBody: 'Przejrzyj je, aby kontynuować.',
        capacityOccupied: 'Wszystkie miejsca przewidziane w przepływie pracy są zajęte.',
        openSourceSession: 'Otwórz sesję, z której pochodzi',
        observedActivity: 'Obserwowana aktywność',
        observedActivityBody: 'Happier widzi fazy i agentów tego agenta, ale nie został on uruchomiony jako zarządzany przepływ pracy, więc nie można go edytować, zapisać ani uruchomić ponownie.',
    },

    recovery: {
        title: 'Przejrzyj odzyskiwanie',
        reattach: 'Podłącz ponownie',
        reattachExplain: 'Obserwuje pracę, która już trwa. Nie uruchamia niczego nowego.',
        resumeSameConversation: 'Wznów',
        resumeSameConversationExplain: ({ block }) => `${block} może kontynuować w tej samej rozmowie.`,
        freshAgent: 'Kontynuuj z nowym Agentem',
        freshAgentExplain: 'Tej rozmowy nie da się kontynuować. Obszar roboczy jest dostępny dla nowego Agenta.',
        uncertainEffects: ({ block }) => `${block} zatrzymał się, zanim zdążył zdać relację. Mógł już zmienić obszar roboczy.`,
        acknowledgeEffects: 'Rozumiem, że wcześniejsze zmiany mogły już nastąpić',
        waitingForStop: 'Czekamy na zatrzymanie lub potwierdzenie',
        remainingNotStarted: ({ count }) => `${count} ${count === 1 ? 'powiązany krok jeszcze się nie rozpoczął' : 'powiązane kroki jeszcze się nie rozpoczęły'}`,
        startReviewedRun: 'Rozpocznij nowe, sprawdzone uruchomienie',
        editContinuation: 'Sprawdź lub edytuj kontynuację',
        continuationPlaceholder: 'Dodaj, co ten krok ma zrobić inaczej',
        useReplacementInput: 'Zastąp dane wejściowe kroku',
        repeatedEffectWarning: 'Ukończona praca może się powtórzyć. Pierwotne uruchomienie zachowuje swoją historię.',
    },

    unavailable: {
        title: 'Przepływy pracy są niedostępne',
        body: 'Przepływy pracy są niedostępne na tym serwerze, więc nie da się tu utworzyć ani uruchomić przepływu.',
        conversion: 'Te zmiany wymagają formatu przepływu pracy, a przepływy pracy są niedostępne na tym serwerze. Zostaw tę automatyzację przy jednym poleceniu albo spróbuj ponownie, gdy przepływy będą dostępne.',
        savedAutomation: 'Ta automatyzacja działa jako przepływ pracy. Zapisane kroki pozostają bez zmian; nadal możesz edytować jej nazwę, opis i wyzwalacze.',
    },
    conversion: {
        title: 'Te zmiany wymagają formatu przepływu pracy',
        automationTarget: 'Przepływ pracy',
        body: 'Ta automatyzacja nadal uruchamia jeden prompt na zapisanym celu. Konwersja zachowa Twoje zmiany, a kolejne uruchomienia będą działać jako przepływ pracy na dokładnie jednej maszynie. Wcześniejsze uruchomienia pozostają bez zmian.',
        action: 'Konwertuj na przepływ pracy',
        machineRequired: 'Wybierz maszynę i folder projektu dla przyszłych uruchomień.',
    },
    save: {
        conflictTitle: 'Zapisano nowszą wersję',
        conflictBody: 'Twoje zmiany nadal tu są.',
        compare: 'Porównaj',
        saveAsCopy: 'Zapisz jako kopię',
        failedTitle: 'Nie udało się zapisać',
        failedBody: 'Twoja lokalna praca nadal tu jest.',
        deleteTitle: 'Usunąć ten przepływ pracy?',
        deleteBody: 'Istniejące automatyzacje i uruchomienia pozostają nienaruszone i działają dalej.',
        unsupportedAttachment: 'Załącz multimedia przez trwałe odniesienie, zanim zapiszesz ten przepływ pracy.',
        nameRequired: 'Nadaj temu przepływowi pracy nazwę przed zapisaniem.',
        runsCurrentDraft: 'To uruchomienie używa przepływu pracy w takiej postaci, w jakiej jest na ekranie. Nie zapisuje go.',
    },

    interchange: {
        importTitle: 'Zaimportuj przepływ pracy',
        importBody: 'Import otwiera niezapisany szkic do przejrzenia. Niczego nie uruchamia ani nie planuje.',
        importIssuesTitle: 'Przejrzyj ten przepływ pracy',
        importIssuesBody: 'Niektóre ustawienia wymagają uwagi, zanim będzie można użyć tego przepływu pracy.',
        openRepairDraft: 'Otwórz szkic do poprawy',
        importFailedTitle: 'Nie udało się odczytać tego pliku',
        importFailedInvalidJson: 'Ten plik nie jest prawidłowym dokumentem JSON.',
        importFailedUnsupportedVersion: 'Ten plik używa wersji przepływu pracy, której ta aplikacja nie obsługuje.',
        importFailedInvalidDocument: 'Ten plik nie jest przepływem pracy Happier.',
        exportPrivacyNote: 'Wyeksportowany plik zawiera prompty i ustawienia. Nigdy nie zawiera danych logowania ani wyników uruchomień.',
    },

    issue: {
        invalid_version: 'Ten przepływ pracy używa nieobsługiwanej wersji.',
        unknown_field: 'Ten blok ma ustawienie, którego ten przepływ pracy nie obsługuje.',
        invalid_id: 'Ten blok potrzebuje prawidłowego identyfikatora.',
        duplicate_id: 'Dwa bloki mają ten sam identyfikator.',
        missing_reference: 'To wejście wskazuje na blok, który już nie istnieje.',
        invalid_reference_scope: 'To wejście wskazuje na blok, który nie kończy się wcześniej.',
        invalid_input: 'Ta wartość jest nieprawidłowa.',
        missing_required_input: 'Brakuje wymaganej wartości.',
        invalid_result_contract: 'Ustawienia wyniku tego kroku są nieprawidłowe.',
        invalid_condition: 'Tego warunku nie da się porównać.',
        invalid_repetition: 'Ta pętla nie może się powtarzać przy takiej konfiguracji.',
        invalid_max_concurrent: 'Maksymalna współbieżność wymaga liczby całkowitej równej co najmniej 1 i dotyczy tylko pracy równoległej.',
        unsupported_persisted_attachment: 'Załączone multimedia muszą mieć trwałe odniesienie przed zapisaniem.',
        conversation_workspace_mismatch: 'Tej rozmowy i tego obszaru roboczego nie można kontynuować razem.',
        target_unavailable: 'Wybierz Agenta dla tego przepływu pracy, zanim go uruchomisz.',
    },

    problem: {
        title: 'To się nie udało',
        waitingTitle: 'Jeszcze nie teraz',
        subtreeDenied: 'Agent może rozpoczynać pracę tylko we własnej sesji lub w sesjach, które prowadzi.',
        roleTargetUnavailable: 'Tej roli nie można tutaj użyć.',
        roleRunsAsMismatch: 'Sposób uruchamiania tej roli jest niezgodny z tym krokiem. Wybierz inną rolę lub zmień sposób uruchamiania kroku.',
        policyDeniedField: 'Ustawienia agenta nie zezwalają na żądane ustawienie dla pracy rozpoczynanej przez agenta.',
        permissionExceedsCeiling: 'To wymaga większych uprawnień, niż ma agent, który to rozpoczął.',
        workDepthExceeded: 'To przekroczyłoby Twój limit delegowania. Zrób to w tej sesji lub zwiększ limit w Ustawienia › Delegowanie.',
        definitionExceedsAuthority: 'Agent nie może zapisać przepływu pracy, który mógłby zrobić więcej, niż sam agent może rozpocząć.',
        sourceUnavailable: 'Ten przepływ pracy jest niedostępny, więc jego wyzwalacze nie mogą się uruchomić.',
        legacyConversionUnsupported: 'Tej automatyzacji nie można jeszcze tutaj zmienić. Nadal działa bez zmian.',
        nativeGoalOwner: 'Agent już samodzielnie kontynuuje pracę nad celami w tej sesji.',
        sessionAlreadyStarted: 'Ta sesja już się rozpoczęła. Wyzwalacze rozpoczęcia sesji można dodać tylko podczas jej tworzenia.',
        generic: 'Happier nie mógł dokończyć tego żądania przepływu pracy. Twoja praca jest nienaruszona.',
        needsRepair: 'Ten przepływ pracy ma ustawienia, które trzeba poprawić, zanim będzie mógł się uruchomić.',
        targetUnavailable: 'Maszyna lub agent, których potrzebuje ten przepływ pracy, są teraz niedostępne.',
        notFound: 'To uruchomienie już nie istnieje.',
        accessDenied: 'Nie masz dostępu do tego uruchomienia.',
        conflict: 'To zmieniło się gdzie indziej. Odśwież, aby zobaczyć aktualną wersję; Twoja lokalna praca zostaje.',
        inputTooLarge: 'To wejście jest za duże, aby je wysłać. Nic nie zostało zmienione.',
        unresolvedOutcome: 'Happier nie może jeszcze potwierdzić, że poprzednia praca się zatrzymała, więc nie da się jej zastąpić.',
        interactionCapacity: 'W tej rozmowie czeka teraz zbyt wiele, aby przyjąć więcej.',
        conversationUnavailable: 'Tej rozmowy nie można kontynuować.',
        workspaceRestore: 'Nie udało się przywrócić obszaru roboczego. Nic nie zostało zmienione.',
        waitSelfDependency: 'To zostawiłoby przepływ pracy czekający na rozmowę, która go uruchomiła.',
        updateRequired: 'Maszyna, która to wykonuje, potrzebuje nowszego Happiera, aby przyjąć ten krok.',
        ineligible: 'To uruchomienie poszło dalej, więc nie jest to już możliwe.',
        custodyPending: 'Happier wciąż czeka na potwierdzenie od maszyny.',
        runFinished: 'To uruchomienie się zakończyło.',
        checkpointUnavailable: 'Nie ma zapisanego punktu, od którego można wznowić.',
        recoveryEvidenceRequired: 'Otwórz to uruchomienie, aby zobaczyć opcje odzyskiwania.',
        executionNotStarted: 'Żaden krok jeszcze się nie zaczął.',
        custodySettled: 'To uruchomienie jest już zamknięte.',
        unavailableHere: 'To jest teraz niedostępne.',
    },

    a11y: {
        blockList: 'Bloki przepływu pracy',
        stepContext: ({ block, position, total }) => `${block}, krok ${position} z ${total}`,
        groupContext: ({ group, block }) => `${block}, wewnątrz ${group}`,
        inherited: 'używa ustawienia przepływu pracy',
        overridden: 'ustawione dla tego kroku',
        inserted: ({ block, position, total }) =>
            `Dodano ${block} na pozycji ${position} z ${total}`,
        removed: ({ block, total }) =>
            `Usunięto ${block}. ${pluralPl(total, 'Pozostaje', 'Pozostają', 'Pozostaje')} ${total} ${pluralPl(total, 'blok', 'bloki', 'bloków')}`,
        reordered: ({ block, position, total }) =>
            `Przeniesiono ${block} na pozycję ${position} z ${total}`,
        validation: ({ reason }) => reason,
        validationInBlock: ({ block, reason }) => `${block}: ${reason}`,
        needsYou: ({ count }) =>
            `${count} ${pluralPl(count, 'krok wymaga', 'kroki wymagają', 'kroków wymaga')} Twojej uwagi`,
        needsYouLoaded: 'wczytano',
        terminal: ({ state }) => state,
        terminalWithAttention: ({ state, count }) =>
            `${state}. ${count} ${pluralPl(count, 'krok wymaga', 'kroki wymagają', 'kroków wymaga')} Twojej uwagi`,
        selectedRowUpdated: ({ block }) => `Zaktualizowano ${block}`,
        progress: ({ count }) =>
            `Zaktualizowano ${count} ${pluralPl(count, 'krok', 'kroki', 'kroków')}`,
        progressLoaded: ({ count }) =>
            `Do tej pory zaktualizowano ${count} ${pluralPl(count, 'krok', 'kroki', 'kroków')}`,
        progressWithAttention: ({ count, attention }) =>
            `Zaktualizowano ${count} ${pluralPl(count, 'krok', 'kroki', 'kroków')}; ${attention} ${pluralPl(attention, 'wymaga', 'wymagają', 'wymaga')} Twojej uwagi`,
        flowNode: ({ node, state }) => `${node}, ${state}`,
        editStep: 'Edytuj krok',
        editBlock: 'Edytuj blok',
        commandRefused: ({ reason }) => `Jeszcze niemożliwe. ${reason}`,
    },
});

const workflowTranslations = { pl } as const;

return { workflowTranslations };
})();

const Domain_workspaceBarTranslations = (() => {
type WorkspaceBarTranslation = Shared_workspaceBarTranslations.WorkspaceBarTranslation;

const en = Shared_workspaceBarTranslations.en;

const workspaceBarTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', WorkspaceBarTranslation>>, "pl"> = { pl: { workspaceBar: { tabsLabel: 'Otwarte karty', tabMenuLabel: 'Opcje karty', pinTab: 'Przypnij kartę', unpinTab: 'Odepnij kartę', splitRight: 'Podziel w prawo', splitDown: 'Podziel w dół', maximizePane: 'Maksymalizuj panel', restorePane: 'Przywróć panel', closeTab: 'Zamknij kartę', closeOtherTabs: 'Zamknij pozostałe karty', closeTabsToRight: 'Zamknij karty po prawej', moreTabs: ({ count }) => (count === 1 ? 'Jeszcze 1 karta' : `Jeszcze ${count} kart`), searchTabs: 'Szukaj kart', splitPane: 'Podziel aktywny panel', openInNewTab: 'Otwórz w nowej karcie', openToRight: 'Otwórz po prawej', openBelow: 'Otwórz poniżej', newTab: 'Nowa karta' } } };

return { workspaceBarTranslations };
})();

const Domain_workspaceSyncDiagnosticTranslations = (() => {
type WorkspaceSyncDiagnosticTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncDiagnosticTranslation;

type WorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslation;

type WorkspaceSyncLocale = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncLocale;

type WorkspaceSyncTranslationCore = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslationCore;

type WorkspaceSyncReviewBase = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncReviewBase;

const completeWorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.completeWorkspaceSyncTranslation;

const workspaceSyncDiagnosticTranslations = { pl: {
        diagnostics: { title: 'Diagnostyka', relationshipId: 'Identyfikator relacji', controllerMachineId: 'Identyfikator komputera sterującego', alphaMachineId: 'Identyfikator komputera źródłowego', betaMachineId: 'Identyfikator komputera docelowego', alphaRoot: 'Bieżący katalog źródłowy', betaRoot: 'Bieżący katalog docelowy', engineMode: 'Tryb silnika', engineState: 'Stan silnika', errorCode: 'Kod błędu' },
        error: { updateRequired: 'Zaktualizuj Happier na komputerze źródłowym przed ponowną próbą przekazania obszaru roboczego. Inne działania dotyczące sesji i komputerów są nadal dostępne.' },
        resolve: { title: 'Rozwiązać konflikt obszaru roboczego?', body: ({ path, side }) => `Zachować wersję folderu ${path} ze strony „${side}”? Drugi folder i wszystko, co znajduje się tylko w nim, zostaną usunięte po sprawdzeniu jego aktualnego stanu.`, unverifiedFile: 'Nie można bezpiecznie usunąć wersji bez aktualnego odcisku pliku. Odśwież konflikt i spróbuj ponownie.' },
    } } as const satisfies Pick<Record<string, WorkspaceSyncDiagnosticTranslation>, "pl">;

const workspaceSyncSetAttentionTranslations = { pl: { attention: { conflictedLinks: ({ count }) => `Konflikty w ${count} połączeniach`, unavailableLinks: ({ count }) => `Sprawdź stan ${count} połączeń` } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'attention'>>, "pl">;

const workspaceSyncAddMachineTranslations = { pl: { availableOn: 'Dostępne na', addMachine: { replica: 'Replika', exactReplica: 'Dokładna replika', editableCopy: 'Kopia do edycji', editableCopyHint: 'Zmiany na połączonych komputerach mogą być widoczne dla agentów na pozostałych. Sprzeczne wersje wymagają sprawdzenia. Jeśli potrzebujesz izolacji, użyj osobnych drzew roboczych.' } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'availableOn' | 'addMachine'>>, "pl">;

const workspaceSyncReviewOutcomeTranslations = { pl: { keepBoth: 'Zachowaj obie wersje', preserveAt: ({ path }) => `Zachowaj drugą wersję pod ${path}`, notReviewed: 'Nie sprawdzono; tutaj nic się nie zmieni', confirmScope: 'Zmiany obejmą tylko wymienione sprawdzone obszary robocze. Niedostępne pozostaną bez zmian.', preserved: 'Zachowano', alreadyPresent: 'Już istnieje', notStarted: 'Nie rozpoczęto', askAgent: 'Zapytaj agenta', askAgentPrompt: ({ path, versions }) => `Pomóż mi sprawdzić sprzeczne wersje ${path} w połączonych obszarach roboczych:\n${versions}\nSprawdź bieżące pliki i zaproponuj bezpieczne rozwiązanie. Nie zmieniaj ani nie rozwiązuj konfliktu bez mojej zgody.` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'keepBoth' | 'preserveAt' | 'notReviewed' | 'confirmScope' | 'preserved' | 'alreadyPresent' | 'notStarted' | 'askAgent' | 'askAgentPrompt'>>, "pl">;

const workspaceSyncCoverageIncompleteTranslations = { pl: 'Nie sprawdzono części połączeń lub punktów. Wczytane konflikty są widoczne; można rozstrzygać tylko wyraźnie sprawdzone, dostępne wersje.' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['coverageIncomplete']>, "pl">;

const workspaceSyncReviewLifecycleTranslations = { pl: { requestingApproval: 'Żądanie zatwierdzenia…', applying: 'Stosowanie sprawdzonych zmian…', propagationExpected: ({ names }) => `Oczekiwana propagacja do ${names}`, propagationUnverified: ({ names }) => `Nie można jeszcze potwierdzić propagacji do ${names}` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'requestingApproval' | 'applying' | 'propagationExpected' | 'propagationUnverified'>>, "pl">;

const workspaceSyncLocalOnlyTranslations = { pl: 'Ta alternatywna lokalizacja pozostaje lokalna dla tego obszaru roboczego' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['localOnly']>, "pl">;

const workspaceSyncKeepAlternativesTranslations = { pl: 'Zachowaj alternatywy' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['keepAlternatives']>, "pl">;

const workspaceSyncReviewDecisionTranslations = { pl: { chooseTargets: 'Wybierz obszary robocze do zastąpienia', notSelected: 'Nie wybrano do tego rozstrzygnięcia', inspectCurrentVersions: 'Sprawdź bieżące wersje' } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'chooseTargets' | 'notSelected' | 'inspectCurrentVersions'>>, "pl">;

const workspaceSyncReviewTranslations: Pick<Record<WorkspaceSyncLocale, WorkspaceSyncReviewBase>, "pl"> = { pl: {
        executable: 'Wykonywalny', regular: 'Niewykonywalny', applied: 'Zastosowano', appliedPaused: 'Zastosowano; synchronizacja wstrzymana', changed: 'Zmieniono przed zastosowaniem', offline: 'Offline; nie zastosowano', cancelled: 'Anulowano', unknown: 'Wynik nieznany; sprawdź ten punkt', failed: 'Błąd; nie zastosowano', recoveryNeeded: 'Wymagane odzyskanie w tej lokalizacji', inspectionUnavailable: 'Nie można sprawdzić bieżących wersji. Odśwież, gdy komputer sterujący będzie dostępny.', coverageIncomplete: 'Nie sprawdzono części połączeń lub punktów. Wczytane konflikty są widoczne, ale rozstrzygnięcie nie jest jeszcze możliwe.', versions: 'Wersje', comparison: 'Porównaj wybrane wersje', linkDecisions: 'Wybór dla połączeń', result: 'Wynik', confirmTitle: 'Użyć tej wersji?', confirmBody: ({ path, source, count }) => `Użyć wersji ${source} pliku ${path} w ${count} innych obszarach roboczych? Happier sprawdzi wszystkie wersje przed zmianami.`, useVersion: 'Użyj wersji', useNamedVersion: ({ name }) => `Użyj ${name}`, compareNamedVersion: ({ name }) => `Porównaj ${name}`, linkCount: ({ count }) => `${count} połączeń zgłosiło tę ścieżkę`, moreOnLink: ({ name }) => `Wczytaj więcej z ${name}`,
    } };

const workspaceSyncReviewSelectionTranslations = { pl: { selectionIncluded: 'Uwzględnione przez to połączenie', selectionExcluded: 'Wykluczone przez to połączenie', selectionUnknown: 'Nieznany wybór', reasonRepositoryMetadata: 'Metadane repozytorium', reasonSubmodule: 'Podmoduł Git', reasonConfiguredRule: 'Skonfigurowana reguła', reasonGitIgnore: 'Reguła Git ignore', reasonEndpointUnavailable: 'Punkt niedostępny', reasonSelectionUnavailable: 'Ocena wyboru niedostępna', configuredInclude: ({ pattern }) => `Wzorzec uwzględniania: ${pattern}`, configuredExclude: ({ pattern }) => `Wzorzec wykluczania: ${pattern}`, completedLinks: ({ count }) => `Przed blokadą ukończono połączenia: ${count}` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'selectionIncluded' | 'selectionExcluded' | 'selectionUnknown' | 'reasonRepositoryMetadata' | 'reasonSubmodule' | 'reasonConfiguredRule' | 'reasonGitIgnore' | 'reasonEndpointUnavailable' | 'reasonSelectionUnavailable' | 'configuredInclude' | 'configuredExclude' | 'completedLinks'>>, "pl">;

const pl = completeWorkspaceSyncTranslation({
    diagnostic: workspaceSyncDiagnosticTranslations["pl"],
    review: workspaceSyncReviewTranslations["pl"],
    selection: workspaceSyncReviewSelectionTranslations["pl"],
    outcome: workspaceSyncReviewOutcomeTranslations["pl"],
    lifecycle: workspaceSyncReviewLifecycleTranslations["pl"],
    decision: workspaceSyncReviewDecisionTranslations["pl"],
    coverage: workspaceSyncCoverageIncompleteTranslations["pl"],
    localOnly: workspaceSyncLocalOnlyTranslations["pl"],
    alternatives: workspaceSyncKeepAlternativesTranslations["pl"],
    addMachine: workspaceSyncAddMachineTranslations["pl"],
    attention: workspaceSyncSetAttentionTranslations["pl"],
}, {
    title: 'Synchronizacja obszaru roboczego',
    footer: 'Stan pochodzi z komputera zarządzającego tą relacją. Zmiany pojawiają się dopiero po potwierdzeniu ich przez ten komputer.',
    legacyRecovery: {
        title: 'Dane wycofanej synchronizacji',
        footer: 'Happier jedynie sprawdza i przenosi te wycofane dane do kwarantanny. Nigdy nie usuwa ich w aplikacji.',
        checking: 'Sprawdzanie komputerów…',
        inspectFailed: 'Nie udało się sprawdzić niektórych komputerów. Wcześniej znalezione foldery kwarantanny pozostaną widoczne; spróbuj ponownie, gdy komputery będą osiągalne.',
        outdatedTitle: ({ machine }) => `${machine} korzysta ze starszej wersji Happier`,
        outdatedBody: 'Ta wersja nie potrafi sprawdzić wycofanych danych synchronizacji. Zaktualizuj Happier na tym komputerze i ponownie sprawdź tutaj.',
        explanation: 'Ten komputer zawiera dane wycofanego mechanizmu replikacji. Happier przeniósł rozpoznane dane do prywatnej kwarantanny i wyłączył synchronizację, aby stary mechanizm nie mógł się uruchomić.',
        quarantinePath: 'Folder kwarantanny',
        openFolder: 'Otwórz folder',
        offlineTitle: 'Usuń, gdy Happier jest offline',
        offlineSteps: ({ path }) => `1. Zatrzymaj wszystkie usługi Happier, które mogą korzystać z tych danych.\n2. Usuń dokładnie ten folder za pomocą systemu operacyjnego: ${path}\n3. Uruchom ponownie usługi i ponownie sprawdź tutaj.`,
        unknown: ({ path, reason }) => `Happier nie mógł bezpiecznie sklasyfikować starego stanu w ${path} (${reason}). Synchronizacja pozostaje wyłączona. Sprawdź tę ścieżkę ręcznie; nie usuwaj jej w aplikacji.`,
        reinspect: 'Sprawdź ponownie',
    },
    none: 'Brak relacji synchronizacji',
    conflictsTitle: 'Konflikty obszaru roboczego',
    openConflicts: ({ count }) => `Sprawdź synchronizację na ${count} połączeniach`,
    noConflicts: 'Brak konfliktów',
    previewUnavailable: 'Komputer sterujący nie mógł udostępnić bezpiecznego podglądu. Odśwież konflikt przed ponowną próbą.',
    truncated: ({ count }) => `${count} ${count === 1 ? 'dodatkowy konflikt nie jest pokazany' : 'dodatkowe konflikty nie są pokazane'}`,
    unknownMode: 'Nieobsługiwany tryb synchronizacji',
    conflictCount: ({ count }) => `${count} ${count === 1 ? 'konflikt' : 'konflikty'}`,
    conflictKind: { file: 'Plik', directory: 'Folder', symlink: 'Dowiązanie symboliczne', missing: 'Brak', unsupported: 'Nieobsługiwany element' },
    mode: { copyOnce: 'Skopiuj raz', keepSynced: 'Utrzymuj aktualność — zalecane', mirrorExactly: 'Odzwierciedlaj dokładnie', keepBothInSync: 'Synchronizuj obie strony' },
    state: { loading: 'Sprawdzanie stanu…', starting: 'Przygotowywanie', watching: 'Obserwowanie', flushing: 'Synchronizowanie', paused: 'Wstrzymano', peerOffline: 'Offline', conflicted: 'Konflikty', controllerUnavailable: 'Wymaga uwagi', engineUnavailable: 'Składnik niedostępny', error: 'Wymaga uwagi', stopped: 'Zatrzymano', working: 'Przetwarzanie…' },
    lastChecked: ({ at }) => `Ostatnie sprawdzenie: ${at}`,
    endpoint: { source: ({ label }) => `Źródło · ${label}`, destination: ({ label }) => `Cel · ${label}`, synced: ({ label }) => `Synchronizowany punkt · ${label}` },
    error: {
        componentUnavailable: 'Synchronizacja obszaru roboczego nie jest dostępna w tej kompilacji. Zainstaluj wymagany składnik i spróbuj ponownie.',
        machineOffline: 'Komputer docelowy jest niedostępny. Połącz go ponownie i spróbuj jeszcze raz.',
        destinationNeedsPreparation: 'Folder docelowy wymaga przygotowania przed rozpoczęciem synchronizacji.',
        gitPreparationFailed: 'Happier nie mógł przygotować tego obszaru roboczego Git. Sprawdź cel i spróbuj ponownie.',
        authorizationExpired: 'Autoryzacja obszaru roboczego wygasła. Uruchom operację ponownie.',
        rootNoLongerAuthorized: 'Folder obszaru roboczego zmienił się i nie jest już autoryzowany. Sprawdź relację przed ponowną próbą.',
        conflictNeedsAttention: 'Ten konflikt zmienił się. Odśwież go przed wybraniem wersji.',
        needsAttention: 'Synchronizacja obszaru roboczego wymaga uwagi. Odśwież jej stan i spróbuj ponownie.',
    },
    start: { blocked: {
        targetMachine: 'Wybierz komputer docelowy, aby kontynuować.',
        targetMachineOffline: 'Ten komputer jest teraz niedostępny. Połącz go ponownie i spróbuj jeszcze raz.',
        relationshipUnavailable: 'Ta relacja synchronizacji nie obejmuje już tych dwóch folderów. Wybierz inną opcję obszaru roboczego.',
        sourceFolder: 'Folder tej sesji nie może być bezpiecznie synchronizowany. Wybierz „Nie przenoś plików”, aby przekazać tylko sesję.',
        destinationFolder: 'Wybierz folder docelowy, który można bezpiecznie synchronizować.',
        workspaceOptions: 'Sprawdź opcje obszaru roboczego przed rozpoczęciem.',
    } },
    engine: { checking: 'Sprawdzanie synchronizacji na tym komputerze…' },
    actions: { refresh: 'Odśwież stan', syncNow: 'Synchronizuj teraz', more: 'Działania synchronizacji', pause: 'Wstrzymaj', resume: 'Wznów', terminate: 'Zatrzymaj synchronizację', openOnMachine: ({ machine }) => `Otwórz na ${machine}`, openFolder: ({ label }) => `Otwórz folder ${label}`, keepLocal: 'Zachowaj wersję lokalną', keepRemote: 'Zachowaj wersję zdalną', keepNamed: ({ side }) => `Zachowaj wersję od ${side}` },
    terminate: { title: 'Usunąć synchronizację obszaru roboczego?', body: 'Synchronizacja zostanie zatrzymana, a jej relacja usunięta. Pliki pozostaną w obu obszarach roboczych.' },
    resolve: {
        changedTitle: 'Konflikt uległ zmianie',
        changedBody: 'Ten konflikt zmienił się od czasu otwarcia. Lista została odświeżona. Sprawdź najnowsze wersje przed ponownym wyborem.',
        consequence: 'Druga wersja zostanie usunięta dopiero po sprawdzeniu przez Happier, że plik się nie zmienił.',
        unsupported: 'Ten konflikt zawiera nieobsługiwany element systemu plików i nie można go rozwiązać w Happier. Usuń lub zastąp element na odpowiednim komputerze, a następnie odśwież.',
        keepHint: ({ side }) => `Zachowaj wersję od ${side} i usuń drugą zweryfikowaną wersję.`,
    },
    fileState: { text: 'Podgląd tekstu', binary: 'Plik binarny — podgląd niedostępny', tooLarge: 'Plik jest za duży, aby wyświetlić podgląd', missing: 'Brak pliku', changed: 'Plik zmienił się od czasu wyświetlenia tego konfliktu' },
});

const workspaceSyncTranslations = { pl } as const satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation>, "pl">;

return { workspaceSyncDiagnosticTranslations, workspaceSyncSetAttentionTranslations, workspaceSyncAddMachineTranslations, workspaceSyncReviewOutcomeTranslations, workspaceSyncCoverageIncompleteTranslations, workspaceSyncReviewLifecycleTranslations, workspaceSyncLocalOnlyTranslations, workspaceSyncKeepAlternativesTranslations, workspaceSyncReviewDecisionTranslations, workspaceSyncReviewTranslations, workspaceSyncReviewSelectionTranslations, workspaceSyncTranslations };
})();

const Domain_workspaceTabTranslations = (() => {
const en = Shared_workspaceTabTranslations.en;

const workspaceTabKeyboardTranslations = Shared_workspaceTabTranslations.workspaceTabKeyboardTranslations;

const workspaceTabTranslations = { pl: en };

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
