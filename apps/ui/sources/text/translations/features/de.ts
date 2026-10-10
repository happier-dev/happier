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
import * as Shared_voiceMomentsTranslations from '../voiceMomentsTranslations.shared';
import * as Shared_voicePresenceTranslations from '../voicePresenceTranslations.shared';
import * as Shared_voiceProviderPrivacyTranslations from '../voiceProviderPrivacyTranslations.shared';
import * as Shared_voiceReadinessTranslations from '../voiceReadinessTranslations.shared';
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

const accountDisplayTranslations = { de: { unnamed: 'Unbenanntes Konto', yours: 'Dein Konto', shortId: ({ id }) => `ID …${id}` } } as const satisfies Pick<Record<string, AccountDisplayTranslation>, "de">;

return { accountDisplayTranslations };
})();

const Domain_accountEncryptionRecoveryTranslations = (() => {
type Copy = Shared_accountEncryptionRecoveryTranslations.Copy;

const en = Shared_accountEncryptionRecoveryTranslations.en;

const de: Copy = {
    recoverAutomationTemplates: 'Ältere Auslöser wiederherstellen',
    recoverAutomationTemplatesDescription: 'Ältere Auslöser mit den Schlüsseln auf diesem Gerät wiederherstellen. Verschlüsselte Sitzungen und gesperrte Auslöser behalten ihre Schlüssel.',
    recoverAutomationTemplatesAction: 'Wiederherstellen',
    recoverAutomationTemplatesComplete: 'Ältere Auslöser wiederhergestellt. Der alte Schlüssel bleibt auf diesem Gerät, bis du ihn vergisst.',
    recoverAutomationTemplatesRetained: 'Wiederherstellung geprüft. Einige Auslöser bleiben verschlüsselt, gesperrt oder geändert. Der alte Schlüssel bleibt auf diesem Gerät.',
    forgetEncryptionKey: 'Den alten Verschlüsselungsschlüssel vergessen',
    forgetEncryptionKeyDescription: 'Ältere verschlüsselte Sitzungen werden auf diesem Gerät gesperrt.',
    forgetEncryptionKeyAction: 'Vergessen',
    forgetEncryptionKeyConfirm: 'Den alten Verschlüsselungsschlüssel vergessen?',
    forgetEncryptionKeyWarning: ({ items }) => `Ältere verschlüsselte Sitzungen werden auf diesem Gerät gesperrt. Dieser verschlüsselte Verlauf kann unzugänglich werden:\n\n${items}\n\nDie Liste zeigt den aktuellen Verlauf. Später auf anderen Geräten erstellte verschlüsselte Sitzungen werden ebenfalls gesperrt. Stelle den alten Schlüssel wieder her, um sie zu entsperren. Im Konto wird nichts gelöscht.`,
    forgetEncryptionKeySession: ({ name, id }) => `Sitzung: ${name} (${id})`,
    forgetEncryptionKeyTrigger: ({ id }) => `Auslöser: ${id}`,
    forgetEncryptionKeyRun: ({ id }) => `Laufverlauf: ${id}`,
    forgetEncryptionKeyEmpty: 'Kein verschlüsselter Verlauf gefunden.',
    forgetEncryptionKeyComplete: 'Der alte Schlüssel wurde auf diesem Gerät vergessen.',
    forgetEncryptionKeyFailed: 'Der Schlüssel konnte nicht vergessen werden. Verbinde dich erneut und versuche es noch einmal. Der verschlüsselte Verlauf muss zuerst aufgelistet werden.',
};

const accountEncryptionRecoveryTranslations = { de } as const;

return { accountEncryptionRecoveryTranslations };
})();

const Domain_accountPopoverTranslations = (() => {
type AccountPopoverTranslation = Shared_accountPopoverTranslations.AccountPopoverTranslation;

const accountPopoverTranslations = { de: {
        pageTitle: 'Konto & Homes',
        homesTitle: 'Homes',
        notLinkedTo: ({ service }) => `Nicht mit ${service} verknüpft`,
        serviceUnavailable: ({ service }) => `${service} ist nicht erreichbar`,
        signedInToThisHome: 'Bei diesem Home angemeldet',
        checkingSignIn: 'Anmeldung wird geprüft…',
        signInStatusUnavailable: 'Anmeldestatus nicht verfügbar',
        machinesOnline: ({ online, total }) => `${online} von ${total} ${total === 1 ? 'Maschine' : 'Maschinen'} online`,
        noMachines: 'Noch keine Maschinen',
        connectedNoMachinesOnline: 'Verbunden · keine Maschine online',
        cantReach: 'Nicht erreichbar',
        signedOut: 'Abgemeldet',
        signIn: 'Anmelden',
        link: 'Verknüpfen',
        linkSubtitle: 'Finde deine Homes auf jedem Gerät',
        manageHomes: 'Homes verwalten',
        connectionDetails: 'Verbindungsdetails',
        allHomes: 'Alle Homes',
        allHomesSubtitle: ({ count }) => `${count} Homes · eine Liste`,
        addHome: 'Home hinzufügen…',
        addDevice: 'Gerät hinzufügen',
    } } as const satisfies Pick<Record<string, AccountPopoverTranslation>, "de">;

return { accountPopoverTranslations };
})();

const Domain_accountServiceOAuthTranslations = (() => {
const en = Shared_accountServiceOAuthTranslations.en;

const de = {
    title: 'Anmelden, um deine Homes zu finden',
    cancelNote: 'Beim Abbrechen bleibst du bei deinen bestehenden Homes angemeldet.', focusedHomePreserved: 'Dein fokussiertes Home ändert sich nicht.',
    stages: { signingIn: 'Anmeldung läuft', findingHomes: 'Deine Homes werden gesucht', waitingApproval: 'Auf Home-Genehmigung warten' },
    errors: { provider: { title: 'Der Anbieter hat die Anmeldung nicht abgeschlossen', body: 'Starte die Anmeldung erneut.' }, expired: { title: 'Diese Anmeldeanfrage ist abgelaufen', body: 'Starte die Anmeldung erneut.' }, identityChanged: { title: 'Die Identität des Anmeldedienstes hat sich geändert', body: 'Prüfe, ob das der Anmeldedienst ist, den du verwenden wolltest, bevor du dich erneut verbindest.' }, unavailable: { title: 'Der Anmeldedienst ist nicht verfügbar', body: 'Prüfe den Dienst und versuche es erneut. Deine bestehenden Homes bleiben unverändert.' }, exchange: { title: 'Die Anmeldung konnte nicht abgeschlossen werden', body: 'Es wurden keine Zugangsdaten für den Anmeldedienst gespeichert. Starte die Anmeldung erneut.' }, storage: { title: 'Die Anmeldung konnte nicht gespeichert werden', body: 'Deine bestehenden Home-Zugangsdaten bleiben unverändert. Starte die Anmeldung erneut.' }, homeLink: { title: 'Angemeldet, aber dieses Home konnte nicht verknüpft werden', body: 'Deine Anmeldung ist gespeichert. Versuche erneut, dieses Home zu verknüpfen.' }, directoryRefresh: { title: 'Angemeldet, aber deine Home-Liste konnte nicht aktualisiert werden', body: 'Die Verbindung zum Anmeldedienst ist bereit. Versuche erneut, deine Home-Liste zu aktualisieren.' }, homeEnrollment: { title: 'Angemeldet, aber dein persönliches Home wurde nicht hinzugefügt', body: 'Deine Anmeldung ist gespeichert. Versuche erneut, das Home hinzuzufügen.' }, invalid: { title: 'Diese Anmeldeanfrage ist nicht mehr gültig', body: 'Starte die Anmeldung erneut.' }, accountDisabled: { title: 'Dieses Konto ist deaktiviert', body: 'Wende dich an die Verwaltung deines Anmeldedienstes. Deine bestehenden Homes bleiben unverändert.' } },
    actions: { startAgain: 'Neu starten', openHome: ({ homeName }: { homeName: string }) => `${homeName} öffnen` },
    success: { title: ({ homeName }: { homeName: string }) => `${homeName} ist verbunden`, body: 'Deine Anmeldung ist gespeichert und dieses Home kann jetzt verwendet werden.' },
    notLinked: { title: ({ homeName }: { homeName: string }) => `${homeName} ist noch nicht mit diesem Konto verknüpft`, signInAction: ({ homeName }: { homeName: string }) => `Bei ${homeName} anmelden`, body: ({ homeName }: { homeName: string }) => `Melde dich direkt bei ${homeName} an oder scanne seinen QR-Code bzw. füge seinen Home-Link ein.`, scanBody: ({ homeName }: { homeName: string }) => `Scanne den QR-Code von ${homeName} oder füge seinen Home-Link ein, um es zu verbinden.` },
    noHomes: { body: 'Dieses Konto hat noch keine Homes. Aktualisiere, nachdem du anderswo eines hinzugefügt hast, oder scanne den QR-Code eines Homes bzw. füge seinen Home-Link ein.' },
    approvalWait: { waitingBody: 'Genehmige diese Anmeldung auf deinem anderen angemeldeten Gerät.', cancelledTitle: 'Warten auf Genehmigung beendet', cancelledBody: 'Deine Anmeldung bleibt gespeichert und deine bestehenden Homes bleiben unverändert.' },
} as const;

const accountServiceOAuthTranslations = { de } as const;

return { accountServiceOAuthTranslations };
})();

const Domain_actionConfirmationTranslations = (() => {
type ActionConfirmationTranslations = Shared_actionConfirmationTranslations.ActionConfirmationTranslations;

const actionConfirmationTranslations = { de: {
        requestedByAgent: 'Vom Session-Agent angeforderte Aktion',
        homeTarget: ({ serverId }) => `Home: ${serverId}`,
        sessionTarget: ({ sessionId }) => `Ziel-Session: ${sessionId}`,
        oneShotConsequence: 'Die Freigabe gilt nur für diese Anfrage. Sie erteilt keine zukünftigen Action- oder nativen Berechtigungen.',
        homeUnavailable: 'Diese Freigabe gehört zu einem Home, das auf diesem Gerät nicht verfügbar ist. Verbinde dieses Home erneut, um zu entscheiden.',
    } } as const satisfies Pick<Record<string, ActionConfirmationTranslations>, "de">;

return { actionConfirmationTranslations };
})();

const Domain_fileContentSearchTranslations = (() => {
const fileContentSearchTranslations = { "de": {
        allMatches: ({ matches, files }: { matches: number; files: number }) => `Alle ${matches} Treffer in ${files} Dateien`,
        moreMatches: "Alle Treffer",
        textInFiles: "Text in Dateien",
        everything: "Alles",
        refineSearch: "Verfeinere deine Suche",
        partial: "Einige Dateien konnten nicht durchsucht werden. Die Ergebnisse sind unvollständig.",
        updateRequired: "Aktualisiere Happier auf diesem Gerät, um Text in Dateien zu suchen.",
        invalidPattern: "Der reguläre Ausdruck ist ungültig. Bearbeite das Muster und versuche es erneut.",
        unavailable: "Die Textsuche ist nicht verfügbar. Prüfe die Verbindung zum Gerät und versuche es erneut.",
        placeholder: "Dateien, Nachrichten, Commits, Sessions, Einstellungen und Aktionen suchen",
        matchCase: "Groß-/Kleinschreibung beachten",
        regex: "Regulärer Ausdruck",
    } };

return { fileContentSearchTranslations };
})();

const Domain_promptPickerTranslations = (() => {
const promptPickerTranslations = { "de": {
        "partialHistory": "Früher gesendet umfasst nur bekannte Sitzungen.",
        "loadedHistory": "Früher gesendet zeigt nur geladene Nachrichten.",
        "open": "Prompts öffnen",
        "menu": "Prompts…",
        "placeholder": "Prompts und gesendete Nachrichten suchen",
        "favorites": "Favoriten",
        "library": "Bibliothek",
        "sentBefore": "Früher gesendet",
        "builtIn": "Integriert",
        "readError": "Dieser Prompt konnte nicht gelesen werden. Erneut versuchen.",
        "libraryError": "Die Bibliothek konnte nicht geladen werden.",
        "partialLibrary": "Einige Prompts konnten nicht gelesen werden.",
        "loadOlder": "Ältere Nachrichten durchsuchen",
        "stop": "Stopp",
        "insert": "Einfügen",
        "send": "Jetzt senden",
        "addFavorite": "Zu Favoriten hinzufügen",
        "removeFavorite": "Aus Favoriten entfernen",
        "empty": "Speichere eine Nachricht als Prompt, um sie hier wiederzuverwenden.",
        "applyError": "Der Prompt konnte nicht angewendet werden. Erneut versuchen.",
        "historyError": "Ältere Nachrichten konnten nicht geladen werden. Erneut versuchen.",
        "title": "Prompts",
        "clear": "Löschen",
        "favorite": "Favorit",
        "favoritesInvite": "Markiere einen Prompt oder eine gesendete Nachricht mit einem Stern, um sie hier zu behalten.",
        "saveAsFavorite": "Als Favoriten-Prompt speichern",
        "saveInPlaceStarred": ({ time }: { time: string }) => `Aus deiner Nachricht von ${time} · kommt mit Stern in deine Bibliothek`,
        "saveInPlace": ({ time }: { time: string }) => `Aus deiner Nachricht von ${time} · kommt in deine Bibliothek`,
        "noMatchesFor": ({ query }: { query: string }) => `Keine Prompts oder geladenen Nachrichten passen zu „${query}“`,
        "previewInserts": "wird eingefügt, dann sendest du",
        "previewSent": "früher gesendet",
        "previewEdited": ({ time }: { time: string }) => `Bearbeitet ${time}`,
        "searchingOlder": ({ searched, total }: { searched: number; total: number }) => `Ältere Nachrichten werden durchsucht… ${searched} von ${total} Sitzungen`
    } } as const;

return { promptPickerTranslations };
})();

const Domain_actionFamilyTranslations = (() => {
const fileContentSearchTranslations = {...Domain_fileContentSearchTranslations.fileContentSearchTranslations, ...EnglishFeatures.fileContentSearchTranslations.fileContentSearchTranslations};

const promptPickerTranslations = {...Domain_promptPickerTranslations.promptPickerTranslations, ...EnglishFeatures.promptPickerTranslations.promptPickerTranslations};

const surfaceFamilyLabels = Shared_actionFamilyTranslations.surfaceFamilyLabels;

const english = Shared_actionFamilyTranslations.english;

const translated = Shared_actionFamilyTranslations.translated;

const actionFamilyTranslations = { de: translated({
        actionFamilies: {
            ...surfaceFamilyLabels,
            workspace_file_search: fileContentSearchTranslations.de.textInFiles,
            find: 'Suche',
            app_shell: 'Workspace',
            roles: 'Rollen',
            launch_profiles: 'Startprofile',
            discovery: 'Aktionssuche',
            computer: 'Computersteuerung',
            artifact_access: 'Artefaktfreigabe',
            workflows: 'Arbeitsabläufe',
            workflow_effects: 'Webhooks und Befehle',
            notifications: 'Benachrichtigungen',
            machine_agent_install: 'Agent-Installationen',
            machine_agent_sign_in: 'Agent-Anmeldung',
            session_access: 'Session-Freigabe',
            session_lifecycle: 'Session-Lebenszyklus',
            inventory: 'Computerinventar',
            messaging: 'Nachrichten',
            session_control: 'Session-Steuerung',
            intent_start: 'Reviews und Delegation',
            review_comments: 'Review-Kommentare',
            subagent_registry: 'Subagenten',
            execution_run_control: 'Hintergrundläufe',
            session_targeting: 'Session-Auswahl',
            session_follow: 'Sessions folgen',
            session_transcripts: 'Session-Transkripte',
            session_read_state: 'Lesestatus',
            session_attention: 'Aufmerksamkeit',
            session_board: 'Session-Board',
            session_discussion: 'Diskussionen',
            session_permissions: 'Session-Berechtigungen',
            external_sessions: 'Externe Sessions',
            voice_controls: 'Sprachsteuerung',
            current_ui_context: 'Aktueller Bildschirm',
            companion_controls: 'Begleiter',
            memory: 'Gedächtnis',
            agent_acp_catalog: 'ACP-Agents',
            prompt_library: 'Prompt-Bibliothek',
            daemon_admin: 'Daemon-Verwaltung',
            browser_control: 'Browsersteuerung',
            browser_diagnostics: 'Browserdiagnose',
            browser_context: 'Browserkontext',
            browser_automation: 'Browserautomatisierung',
            browser_recording: 'Browseraufzeichnung',
            local_services_inventory: 'Lokale Dienste',
            local_services_launcher: 'Dienststarter',
            local_services_preview: 'Dienstvorschauen',
            local_services_public_preview: 'Öffentliche Vorschauen',
            local_services_actions: 'Dienstaktionen',
            peer_mediation_observability: 'Verbindungsdiagnose',
            devices_simulator: 'Simulatoren',
            approvals: 'Freigaben',
            plugin_dev_loop: 'Plugin-Entwicklung',
            plugin_settings_administration: 'Plugin-Einstellungen',
            plugin_permission_grants: 'Plugin-Berechtigungen',
            plugin_webhooks: 'Plugin-Webhooks',
            account_plugin_data: 'Plugin-Daten',
            account_sessions: 'Angemeldete Geräte',
            account_security: 'Kontosicherheit',
            account_api_tokens: 'API-Tokens',
            identity_github_apps: 'GitHub-Apps',
            identity_providers: 'Anmeldeanbieter',
            machine_pools: 'Computer-Pools',
            ephemeral_runner: 'Runner-Instanzen',
            automation_events: 'Automatisierungsereignisse',
            automation_conversation: 'Automatisierungsgespräche',
            scm_git: 'Git',
            scm_pull_request: 'Pull-Requests',
            scm_repository: 'Repositorys',
            scm_diff_summary: 'Diff-Zusammenfassungen',
            home_governance: 'Home-Verwaltung',
            teams: 'Teams-Verwaltung',
            saved_secret_sharing: 'Geteilte Secrets',
        },
    }) } as const;

return { actionFamilyTranslations };
})();

const Domain_addFlowsTranslations = (() => {
type AddFlowsTranslation = Shared_addFlowsTranslations.AddFlowsTranslation;

const addFlowsTranslations = { de: {
        addHome: 'Home hinzufügen',
        addHomeSubtitle: 'Anmelden, per Adresse verbinden oder gehostet nutzen',
        addHomeDescription: 'Verbinde ein Home, das du schon nutzt, oder nutze eines, das für dich gehostet wird.',
        newGroup: 'Neue Gruppe',
        newGroupSubtitle: 'Sitzungen mehrerer Homes zusammen sehen',
        groupsTitle: 'Gruppen',
        homesInUse: 'Hier in Verwendung',
        thisDeviceTitle: 'Dieses Gerät',
        thisDeviceSubtitle: 'Wie es seine Homes erreicht',
        thisDeviceDescription: 'Wie dieses Gerät seine Homes erreicht: wartende Geräte, die genutzte Verbindung und das Home, das es selbst betreibt.',
        newHomeDraft: 'Neues Home',
        homeMissingTitle: 'Dieses Home ist nicht auf diesem Gerät',
        homeMissingDescription: 'Es wurde entfernt oder auf einem anderen Gerät gespeichert.',
        homeManageTitle: 'Verwalten',
        homeAdministrationSubtitle: 'Personen, Anmeldung, Erreichbarkeit und Daten dieses Homes',
        groupMissingTitle: 'Diese Gruppe gibt es nicht mehr',
        groupMissingDescription: 'Sie wurde entfernt. Deine Homes sind unverändert.',
        discard: 'Verwerfen',
        sshSignInAgent: 'Dein SSH-Agent auf diesem Computer',
        sshSignInKeyFile: 'Eine private Schlüsseldatei auf diesem Computer',
        sshSignInPassword: 'Einmal zum Verbinden genutzt, nie gespeichert',
        addMachineMenuSubtitle: 'Ein Computer oder ein Server',
        addMachineDescription: 'Füge einen Computer oder Server hinzu, damit Agenten dort deine Sitzungen ausführen.',
        machineJoinsHome: ({ home }) => `Tritt ${home} bei`,
        pathThisComputerTitle: 'Dieser Computer',
        pathThisComputerTask: 'In einem Schritt einrichten',
        pathThisComputerCommand: 'Ein Befehl im Terminal',
        pathSshTitle: 'Ein Server über SSH',
        pathSshChip: 'Über SSH',
        pathSshSubtitle: 'Eine Dev-Box, VM oder ein Cloud-Server',
        pathAnotherTitle: 'Ein anderer Computer',
        pathAnotherSubtitle: 'Einen Home-Link auf dem anderen Computer öffnen',
        machinePoolPrompt: 'Sollen Sitzungen zwischen Maschinen ausweichen?',
        thisComputerCommandLead: ({ home }) => `Führe das in einem Terminal auf diesem Computer aus. Es installiert Happier und tritt ${home} bei; diese Seite merkt es, sobald es bereit ist.`,
        thisComputerTaskLead: ({ machine, home }) => `${machine} führt Agenten für ${home} aus. Happier installiert einen kleinen Hintergrunddienst, der mit dem Computer startet.`,
        setUpThisComputer: 'Diesen Computer einrichten',
        desktopAppHint: 'Lieber klicken als tippen?',
        desktopAppLink: 'Hol dir die Desktop-App – sie richtet diesen Computer selbst ein.',
        thisComputerRunningLead: ({ machine }) => `${machine} wird eingerichtet. Du kannst Happier weiter nutzen.`,
        onAnotherHomeTitle: ({ machine }) => `${machine} ist mit einem anderen Home verbunden`,
        onAnotherHomeBody: ({ home }) => `Sein Happier-Dienst führt Sitzungen für ein anderes Home aus. Beim Umzug zu ${home} bleiben die Einstellungen; vorhandene Sitzungen bleiben dort.`,
        moveToHome: ({ home }) => `Zu ${home} verschieben`,
        keepOnOtherHome: 'Dort lassen',
        sshLeadTask: ({ home }) => `Eine Dev-Box, VM oder ein Cloud-Server, den du schon per SSH erreichst. Dieser Computer verbindet sich, installiert Happier und tritt ${home} bei.`,
        sshLeadCommand: ({ home }) => `Eine Dev-Box, VM oder ein Cloud-Server, per SSH erreichbar. Führe den Befehl auf einem Computer aus, der ihn erreicht; er installiert Happier und tritt ${home} bei.`,
        setUpHost: ({ host }) => `${host} einrichten`,
        sshSavedNote: 'Der Host wird unter Entfernte Hosts gespeichert, Passwörter nie.',
        sshRunningTitle: ({ host }) => `${host} wird eingerichtet`,
        sshRunningLead: 'Läuft per SSH von diesem Computer. Du kannst gehen; die Maschinenliste zeigt den Fortschritt und meldet, wenn es fertig ist.',
        anotherLead: ({ home }) => `Führe das in einem Terminal auf dem anderen Computer aus. Es installiert Happier und tritt ${home} bei.`,
        anotherTerminalAction: 'Stattdessen einen Terminalbefehl verwenden',
        machineWatching: ({ subject }) => `Warte auf ${subject} in `,
        subjectThisComputer: 'diesen Computer',
        subjectAnotherComputer: 'den Computer',
        machineNotSeeingTitle: ({ subject }) => `${subject} noch nicht zu sehen?`,
        machineNotSeeingBody: ({ home }) => `Happier wartet weiter. Meist brach die Einrichtung mit einem Fehler ab, die Maschine erreicht ${home} nicht oder wurde für ein anderes Home eingerichtet.`,
        machineArrived: ({ machine }) => `${machine} ist verbunden`,
        machineConnectedJustNow: 'gerade verbunden',
        machineStartSession: ({ machine }) => `Sitzung auf ${machine} starten`,
        machineAddAnother: 'Weitere hinzufügen',
        cancelSetup: 'Abbrechen',
        detectedOs: 'Erkannt',
        sshSuggestionsTitle: 'Aus deiner SSH-Konfiguration und gespeicherten Hosts',
        connectingToHome: ({ address }) => `Verbindung mit ${address} …`,
        pathThisComputerConnected: 'Verbunden · seine Agenten',
    } } satisfies Pick<Readonly<Record<string, AddFlowsTranslation>>, "de">;

return { addFlowsTranslations };
})();

const Domain_agentInstallJobTranslations = (() => {
const en = Shared_agentInstallJobTranslations.en;

const agentInstallJobTranslations = { de: { ...en } };

return { agentInstallJobTranslations };
})();

const Domain_agentStartTranslations = (() => {
const en = Shared_agentStartTranslations.en;

const de: typeof en = {
    titles: {
        conversation: 'Ein Gespräch nebenbei',
    },
    descriptions: {
        conversation: ({ machine }) => `Frag alles, ohne diese Sitzung zu unterbrechen. Es läuft auf ${machine} daneben; nichts geht zurück, solange du es nicht sendest.`,
    },
    chips: {
        engineTitle: 'Wer antwortet',
        addReviewer: 'Reviewer hinzufügen',
        removeReviewer: ({ name }) => `${name} entfernen`,
        scope: 'Was geprüft wird',
        advanced: 'Erweitert',
    },
    reportToSession: 'An diese Sitzung berichten',
    startsWhenYouSend: ({ count }) => count > 1 ? `${count} Reviews starten beim Senden` : 'Startet beim Senden',
    offline: ({ machine }) => `${machine} ist offline. Der Agent startet dort; dein Entwurf bleibt hier, bis es wieder da ist.`,
    menu: {
        askSection: 'Einen Agenten bitten',
        secondOpinionTitle: 'Zweitmeinung',
        secondOpinionSubtitle: 'Eine unabhängige Prüfung vor dem Abschluss',
        keepGoingTitle: 'Weitermachen bis fertig…',
        keepGoingSubtitle: 'Ein Ziel in der Zielsteuerung setzen',
        runWorkflowTitle: 'Workflow ausführen',
        runWorkflowSubtitle: 'Aus deiner Bibliothek oder integriert',
        searchWorkflows: 'Workflows durchsuchen…',
        yourLibrary: 'Deine Bibliothek',
        noWorkflows: 'Noch keine gespeicherten Workflows',
        addTriggerTitle: 'Auslöser hinzufügen…',
        addTriggerSubtitle: 'Läuft hier jedes Mal, wenn etwas passiert',
        advancedTitle: 'Erweitert…',
        advancedSubtitle: 'Mehrere Agenten, Berechtigungen, Profil',
        builtIn: 'Integriert',
        allWorkflows: 'Alle Workflows…',
    },
    role: {
        replaces: ({ agent }) => `Ersetzt ${agent}`,
    },
    startRow: {
        subtitle: 'Entwurf · startet beim Senden',
        conversation: 'Neues Gespräch',
        review: 'Neues Review',
        plan: 'Neuer Plan',
        delegate: 'Neue Aufgabe',
    },
    pane: {
        cancelRun: 'Ausführung abbrechen',
        whenItFinishes: 'Wenn es fertig ist',
        sendToSession: ({ session }) => `An ${session} senden`,
        replyTo: ({ agent }) => `${agent} antworten…`,
        repliesGoTo: ({ session }) => `Antworten gehen an diesen Agenten, nicht an ${session}`,
    },
};

const agentStartTranslations = { de };

return { agentStartTranslations };
})();

const Domain_apiTokenSettingsTranslations = (() => {
const english = Shared_apiTokenSettingsTranslations.english;

const translated = Shared_apiTokenSettingsTranslations.translated;

const apiTokenSettingsTranslations = { de: translated({
        settingsApiTokens: {
            encryption: {
                choice: "Verschlüsselungszugriff",
                consequence: "Gewährt kontoweiten Verschlüsselungszugriff. Der Widerruf stoppt künftige API-Autorisierung; bereits erhaltene Schlüssel oder Daten können nicht zurückgerufen werden.",
                enabled: "Verschlüsselungszugriff aktiviert",
                bearerOnly: "Nur API-Zugriff",
                unknown: "Verschlüsselungszugriff unbekannt",
                outcomeUnknown: "Die Erstellung könnte abgeschlossen sein. Aktualisiere die Liste und widerrufe dieses Token, bevor du bewusst ein neues erstellst.",
                unsupported: "Dieses Home unterstützt noch keine verschlüsselten API-Tokens. Aktualisiere es oder erstelle ein gewöhnliches Token.",
                notReady: "Stelle den Verschlüsselungszugriff auf diesem Home wieder her, bevor du ein verschlüsseltes Token erstellst.",
                stale: "Der Kontoschlüssel hat sich geändert. Stelle den Verschlüsselungszugriff auf diesem Home wieder her.",
                idConflict: "Diese Token-ID existiert bereits. Widerrufe genau dieses Token, bevor du ein neues erstellst.",
            },
            unattended: {
                choice: "Unbeaufsichtigter Teamzugriff",
                consequence: "Kopiert die aktuell verifizierten Anmeldemethoden dieses Zugangsnachweises für eingeschränkte Teamarbeit in das Token. Verschlüsselungszugriff ist davon unabhängig.",
                authorized: "Unbeaufsichtigter Teamzugriff autorisiert",
                notAuthorized: "Kein unbeaufsichtigter Teamzugriff",
                evidenceLimit: "Dieser Zugangsnachweis hat zu viele verifizierte Anmeldemethoden zum Kopieren. Es wurde kein Token erstellt.",
                evidenceUnavailable: "Für diesen angemeldeten Zugangsnachweis gibt es keinen aktuellen Authentifizierungsnachweis zum Kopieren. Melde dich mit der erforderlichen Methode erneut an; es wurde kein Token erstellt.",
            },
            title: 'API-Tokens',
            entrySubtitle: 'Lass Skripte, Server und eingebettete Apps für dich handeln – nur mit dem Zugriff, den du ihnen gibst.',
            tokens: 'API-Tokens',
            refreshing: 'Wird aktualisiert…',
            emptyTitle: 'Noch keine API-Tokens',
            emptyBody: 'Tokens erlauben vertrauenswürdigen Skripten und Tools, die von dir erlaubten automatisierten Aktionen auszuführen. Erstelle einen Token, wenn eine Integration Zugriff auf dein aktuelles Konto braucht.',
            created: 'Erstellt',
            lastUsed: 'Zuletzt verwendet',
            neverUsed: 'Nie verwendet',
            securityTitle: 'Sicherheit',
            securityFooter: 'Diese Aktionen gelten für das gesamte aktuelle Konto.',
            status: {
                active: 'Aktiv',
                expiresInMinutes: ({ count }) => `Läuft in ${count} Min. ab`,
                expiresInHours: ({ count }) => `Läuft in ${count} Std. ab`,
                expiresInDays: ({ count }) => `Läuft in ${count} T. ab`,
                expired: 'Abgelaufen',
            },
            rowAccessibilityLabel: ({ label, state }) => `${label}, Status: ${state}`,
            moreActionsAccessibilityLabel: ({ label }) => `Weitere Aktionen für ${label}`,
            create: {
                button: 'Token erstellen',
                title: 'API-Token erstellen',
                subtitle: 'Benenne die Integration und wähle, wann dieser Token abläuft. Normale API-Anfragen und -Ergebnisse sind für dein Home lesbar; mit Verschlüsselungszugriff können unterstützte SDK-Aufrufe geschützt werden.',
                submit: 'Token erstellen',
                label: 'Bezeichnung',
                labelPlaceholder: 'Release-Automatisierung',
                expiry: 'Läuft ab',
                expiryOptions: {
                    '30d': '30 Tage',
                    '90d': '90 Tage',
                    '1y': '1 Jahr',
                    none: 'Kein Ablauf',
                },
                access: 'Zugriff',
                accessFull: 'Vollzugriff',
                accessLimited: 'Eingeschränkt',
                accessLimitedDescription: 'Wähle als Nächstes Aktionen, Sessions, Modelle und Webseiten.',
                accessTitle: 'Zugriff wählen',
                continue: 'Weiter',
                back: 'Zurück',
                actionSettingsPrefix: 'Dieser Token kann jede für External API & SDK aktivierte Aktion in deinen',
                actionSettingsLink: 'Aktionseinstellungen ausführen.',
            },
            reveal: {
                title: 'API-Token sichern',
                accessibilityAnnouncement: 'Kopiere deinen Token jetzt — er wird nur einmal angezeigt.',
                successTitle: 'Token erstellt',
                shownOnce: 'Kopiere diesen Token jetzt. Zu deiner Sicherheit kann Happier ihn nicht erneut anzeigen.',
                copy: 'Token kopieren',
                copied: 'Kopiert',
                dismissTitle: 'Ohne Bestätigung verlassen?',
                dismissBody: 'Dieser Token wird nicht erneut angezeigt. Kopiere ihn zuerst oder bestätige, dass du ihn sicher gespeichert hast.',
                copyFirst: 'Token sichtbar lassen',
                savedIt: 'Ich habe ihn gespeichert',
            },
            revoke: {
                title: ({ label }) => `„${label}“ widerrufen?`,
                body: 'Der Server- und API-Zugriff endet bei der nächsten Überprüfung. Ein lokaler Daemon, der diesen API-Token kürzlich geprüft hat, kann ihn noch bis zu einer Minute akzeptieren. Das kann nicht rückgängig gemacht werden.',
                confirm: 'Token widerrufen',
            },
            revokeAll: {
                title: 'Alle API-Tokens widerrufen',
                subtitle: 'Alle API-Tokens für dieses Konto deaktivieren.',
                body: 'Der Server- und API-Zugriff endet bei der nächsten Überprüfung. Einbettungen, die diese Tokens verwenden, funktionieren nicht mehr, und ihre eingebetteten Zugangsdaten werden abgemeldet. Lokale Daemons, die diese API-Tokens kürzlich geprüft haben, können sie noch bis zu einer Minute akzeptieren. Das kann nicht rückgängig gemacht werden.',
                confirm: 'Alle widerrufen',
                railAction: 'Alle API-Tokens widerrufen…',
            },
            signOutEverywhere: {
                title: 'Überall abmelden',
                subtitle: 'Alle angemeldeten Sitzungen für dieses Konto beenden.',
                body: 'Alle angemeldeten Browser- und Gerätesitzungen werden beendet. API-Tokens bleiben aktiv; widerrufe sie separat auf diesem Bildschirm.',
                confirm: 'Überall abmelden',
            },
            errors: {
                labelRequired: 'Gib vor dem Erstellen des Tokens eine Bezeichnung ein.',
                accountChanged: 'Dein aktives Konto oder Home hat sich geändert, daher wurde nichts geändert. Öffne es erneut, um fortzufahren.',
                presentUserRequired: 'Bestätige deine Identität im Anmeldedialog und versuch es dann erneut.',
                offline: 'Happier konnte dein Konto nicht erreichen. Prüf deine Verbindung und versuch es erneut.',
                unavailable: 'Diese Aktion ist gerade nicht verfügbar. Versuch es gleich noch einmal.',
                copyFailed: 'Der Token konnte nicht kopiert werden. Wähle ihn aus und kopiere ihn vor dem Schließen manuell.',
                listTitle: 'API-Tokens nicht verfügbar',
                grantIncomplete: 'Wähle den Zugriff vollständig aus, bevor du den Token erstellst.',
            },
            embedPill: 'Einbettung',
            embedRowHint: 'Öffnet diese Einbettung unter Einstellungen, Einbettungen.',
            summary: {
                full: 'Vollzugriff',
                allActions: 'Jede Aktion',
                namesAndMore: ({ names, count }) => `${names} +${count}`,
                sessions: ({ count }) => (count === 1 ? '1 Session' : `${count} Sessions`),
                computers: ({ count }) => (count === 1 ? '1 Computer' : `${count} Computer`),
                approve: 'Darf freigeben',
                models: ({ count }) => (count === 1 ? '1 Modell' : `${count} Modelle`),
                websites: ({ count }) => (count === 1 ? '1 Webseite' : `${count} Webseiten`),
                content: 'Inhaltszugriff',
                noExpiry: 'Kein Ablauf',
                expires: ({ date }) => `Läuft am ${date} ab`,
                expired: ({ date }) => `Am ${date} abgelaufen`,
            },
            grant: {
                accessTitle: 'Zugriff',
                back: 'Zugriff',
                onlyThese: 'Nur diese',
                selectedCount: ({ count }) => (count === 1 ? '1 ausgewählt' : `${count} ausgewählt`),
                reviewUnnamed: 'Dieser Token',
                actions: {
                    title: 'Aktionen',
                    all: 'Jede Aktion',
                    none: 'Wähle mindestens eine Aktion',
                    search: 'Aktionen suchen',
                    noMatches: ({ query }) => `Keine Aktionen passen zu „${query}“`,
                    groupDescription: 'Eine ganze Gruppe umfasst auch Aktionen, die später hinzukommen.',
                    familyCount: ({ count }) => (count === 1 ? 'Gruppe · 1 Aktion' : `Gruppe · ${count} Aktionen`),
                    includedByFamily: ({ family }) => `In ${family} enthalten`,
                },
                targets: {
                    title: 'Sessions und Computer',
                    all: 'Jede Session und jeder Computer',
                    none: 'Wähle mindestens eine Session oder einen Computer',
                    computers: 'Computer',
                    computersDescription: 'Ein Computer umfasst jede Session darauf, jetzt und künftig.',
                    sessions: 'Einzelne Sessions',
                    searchSessions: 'Sessions suchen',
                    noSessions: 'Noch keine Sessions',
                    noSessionMatches: ({ query }) => `Keine Sessions passen zu „${query}“`,
                    noComputers: 'Noch keine Computer',
                },
                models: {
                    title: 'Modelle',
                    any: 'Jedes Modell',
                    onlyThese: 'Nur diese Modelle',
                    none: 'Wähle mindestens ein Modell',
                    pickerDescription: 'Andere Modelle werden abgelehnt, nicht nur ausgeblendet. „Automatisch“ wird nicht angeboten, sobald du Modelle auswählst.',
                    noModels: 'Noch keine Modelle zur Auswahl',
                },
                approve: {
                    title: 'Anfragen freigeben',
                    on: 'Er kann Werkzeugnutzung und Anfragen in den oben genannten Sessions freigeben – auch Anfragen, die er selbst gestartet hat. Tokens, Sicherheit oder Plugins kann er nie ändern.',
                    off: 'Anfragen warten in Happier auf dich.',
                },
                websites: {
                    title: 'Webseiten',
                    description: 'Seiten dieser Websites können den Token im Browser verwenden. Für Skripte und Server leer lassen.',
                    inputLabel: 'Webseite hinzufügen',
                    placeholder: 'https://app.example.com',
                    add: 'Hinzufügen',
                    invalid: 'Beginne mit https:// oder für localhost mit http://.',
                    duplicate: 'Diese Webseite ist bereits aufgeführt.',
                    remove: ({ origin }) => `${origin} entfernen`,
                },
            },
            detail: {
                whatItCanDo: 'Was er kann',
                whatItCanDoDescription: 'Aktionen, die dieser Token für dich ausführen kann. Alles andere wird abgelehnt.',
                everyAction: 'Jede für External API & SDK aktivierte Aktion',
                wholeGroup: 'Ganze Gruppe',
                where: 'Wo',
                whereDescription: 'Sessions und Computer, die er erreichen kann.',
                computerCovers: 'Jede Session auf diesem Computer',
                unknownComputer: 'Ein Computer, der nicht mehr aufgeführt ist',
                unknownSession: 'Eine Session, die nicht mehr aufgeführt ist',
                modelsDescription: 'Andere Modelle werden abgelehnt, nicht nur ausgeblendet.',
                approvals: 'Freigaben',
                approvesOn: 'Gibt Anfragen frei',
                approvesOff: 'Gibt keine Anfragen frei',
                websitesDescription: 'Browserseiten dieser Websites können ihn verwenden.',
                noWebsites: 'Nur Skripte und Server',
                content: 'Inhaltszugriff',
                contentOn: 'Er kann Ende-zu-Ende-verschlüsselte Inhalte über unterstützte SDK-Aufrufe lesen.',
                contentOff: 'Er kann keine Ende-zu-Ende-verschlüsselten Inhalte lesen.',
                children: 'Eingebettete Zugangsdaten',
                childrenDescription: 'Kurzlebige Schlüssel, die deine App aus diesem Token für ihre Seiten erzeugt hat.',
                childrenCount: ({ count }) => (count === 1 ? '1 aktiv' : `${count} aktiv`),
                childrenConsequence: 'Werden abgemeldet, wenn du den Zugriff bearbeitest oder diesen Token widerrufst.',
                sessionLimits: 'Sitzungen',
                sessionLimitsDescription: 'Die Sitzungen, die er starten kann, und die Berechtigungsmodi, die seine Nachrichten nutzen dürfen.',
                createsSessions: 'Startet Sitzungen',
                createsSessionsOn: ({ computer }: { computer: string }) => `Auf ${computer}, in einem privaten Ordner, den Happier verwaltet.`,
                editAccess: 'Zugriff bearbeiten',
                revokeFootnote: 'Skripte und Einbettungen, die ihn verwenden, funktionieren ab ihrer nächsten Anfrage nicht mehr.',
                created: ({ date }) => `Erstellt am ${date}`,
                lastUsed: ({ date }) => `Zuletzt verwendet am ${date}`,
                missingTitle: 'Dieser Token existiert nicht mehr',
                missingBody: 'Er wurde widerrufen oder ist abgelaufen und wurde entfernt. Deine anderen Tokens sind weiterhin aufgeführt.',
                backToTokens: 'API-Tokens anzeigen',
            },
            edit: {
                title: 'Zugriff bearbeiten',
                save: 'Speichern',
                signsOut: 'Aktive eingebettete Zugangsdaten werden abgemeldet.',
            },
            cliPolicy: {
                sectionTitle: 'CLI und Daemon',
                sectionDescription: 'Was Befehle auf deinen Computern mit deiner Anmeldung tun dürfen.',
                title: 'Freigaben und Kontoänderungen über CLI und Daemon erlauben',
                description: 'Erlaubt Befehlen auf deinen Computern, Anfragen freizugeben und Kontoeinstellungen zu ändern. Schalte das aus, wenn Agents mit Shell-Zugriff laufen. Ein Computer kann dies auch mit HAPPIER_CLI_PRESENT_USER=disallowed ablehnen. Eine Änderung verbindet deine Computer kurz neu.',
                unavailable: 'Diese Einstellung konnte nicht gelesen werden. Versuch es gleich noch einmal.',
                saveFailed: 'Diese Einstellung konnte nicht geändert werden. Versuch es gleich noch einmal.',
            },
            notices: {
                revoked: 'API-Token widerrufen.',
                revokedAll: 'Alle API-Tokens widerrufen.',
                signedOutEverywhere: 'Überall abgemeldet. API-Tokens bleiben aktiv.',
            },
        },
    }) } as const;

return { apiTokenSettingsTranslations };
})();

const Domain_artifactsBrowserTranslations = (() => {
type ArtifactsBrowserTranslations = Shared_artifactsBrowserTranslations.ArtifactsBrowserTranslations;

const artifactsBrowserTranslations = { de: {
        description: 'Was du und deine Agenten gespeichert habt — bereit zum Lesen, Wiederverwenden und Teilen.',
        newDocument: 'Neues Dokument',
        searchPlaceholder: 'Artefakte durchsuchen',
        kindLabel: 'Art',
        sourceLabel: 'Quelle',
        kinds: {
            all: 'Alle Arten',
            document: 'Dokumente',
            prompt: 'Prompts',
            memory: 'Gedächtnisse',
            board: 'Boards',
            workflow: 'Workflows',
            role: 'Rollen',
            launchProfile: 'Startprofile',
        },
        kindOne: {
            document: 'Dokument',
            prompt: 'Prompt',
            memory: 'Gedächtnis',
            board: 'Board',
            workflow: 'Workflow',
            role: 'Rolle',
            launchProfile: 'Startprofil',
        },
        sort: {
            label: 'Sortieren',
            updated_desc: 'Zuletzt geändert',
            created_desc: 'Zuletzt erstellt',
            title_asc: 'Titel',
        },
        view: {
            label: 'Ansicht',
            grid: 'Raster',
            list: 'Liste',
            folders: 'Ordner',
        },
        folders: {
            newFolder: 'Neuer Ordner',
            newFolderInside: 'Neuer Ordner darin',
            rename: 'Umbenennen',
            moveTo: 'In Ordner verschieben…',
            moveItemTo: ({ name }) => `„${name}“ verschieben nach`,
            newFolderEllipsis: 'Neuer Ordner…',
            moveVerb: 'Verschieben nach',
            topLevel: 'Oberste Ebene',
            moveToTopLevel: 'Auf die oberste Ebene verschieben',
            deleteFolder: 'Ordner löschen',
            deleteTitle: ({ name }) => `„${name}“ löschen?`,
            deleteBody: 'Seine Elemente und Ordner rücken eine Ebene nach oben. Nichts wird gelöscht.',
            nameHelp: 'Ordner gehören nur dir. Etwas abzulegen ändert es nie für die Personen, mit denen es geteilt ist.',
            namePlaceholder: 'Ordnername',
            create: 'Erstellen',
            options: ({ name }) => `Optionen für ${name}`,
            expand: ({ name }) => `${name} ausklappen`,
            collapse: ({ name }) => `${name} einklappen`,
            columnName: 'Name',
            columnEdited: 'Bearbeitet',
            emptyInvite: 'Noch keine Ordner. Gruppiere, was zusammengehört; nur du siehst deine Ablage.',
            unavailable: 'Die Ordner konnten von diesem Home nicht geladen werden. Alles wird ohne sie aufgelistet.',
            saveFailed: 'Diese Änderung wurde nicht gespeichert. Versuche es erneut.',
            refusedCycle: 'Ein Ordner kann nicht in sich selbst verschoben werden',
            refusedUnavailable: 'Ordner sind gerade nicht verfügbar',
            refusedOther: 'Kann nicht dorthin verschoben werden',
            showAllKinds: 'Alle Arten in Artefakte anzeigen',
            promptSearch: 'Prompts und Skills suchen',
        },
        provenance: {
            savedByYou: 'Von dir gespeichert',
            sharedWithYou: 'Mit dir geteilt',
            fromFile: ({ name }) => `Aus ${name}`,
            openSession: ({ session }) => `${session} öffnen`,
        },
        emptyTitle: 'Behalte, was deine Agenten erstellen',
        emptyBody: 'Pläne, Notizen, Code und Boards, die du oder deine Agenten speichern, landen hier — auf jedem Gerät lesbar und bereit zum Teilen mit deinen Teams.',
        emptyHint: 'Oder bitte einen Agenten: „Speichere das als Artefakt“.',
        loadFailedTitle: 'Deine Artefakte konnten nicht geladen werden',
        loadFailedBody: 'Prüfe deine Verbindung und versuche es erneut. Nichts ist verloren.',
        retainedBody: "Aktualisierung fehlgeschlagen. Die zuletzt geladenen Artefakte werden angezeigt.",
        quota: {
            accountTitle: 'Der Artefaktspeicher ist voll',
            documentTitle: 'Zu groß zum Speichern',
            accountBody: ({ used, limit }) => `${used} von ${limit} belegt, Versionen eingeschlossen. Lösche oder exportiere Artefakte, die du nicht mehr brauchst, um neue zu speichern.`,
            documentBody: ({ size, limit }) => `Das wären ${size}; jedes Artefakt fasst bis zu ${limit}. Deine Änderungen sind noch da.`,
        },
        open: {
            document: 'Dokument öffnen',
            prompt: 'Prompt öffnen',
            memory: 'Gedächtnis öffnen',
            board: 'Board öffnen',
            workflow: 'Workflow öffnen',
            role: 'Rolle öffnen',
            launchProfile: 'Startprofil öffnen',
        },
        openAsPage: 'Als Seite öffnen',
        actions: {
            edit: 'Bearbeiten',
            history: 'Verlauf',
            share: 'Teilen',
            more: 'Weitere Aktionen',
            copyLink: 'Link kopieren',
            linkCopied: 'Link kopiert',
        },
        history: {
            title: 'Verlauf',
            current: 'Aktuell',
            now: 'Jetzt',
            restoreNote: 'Wiederherstellen fügt sie als neue Version hinzu. Nichts geht verloren.',
            loadFailed: 'Der Verlauf konnte nicht geladen werden. Versuche es erneut.',
            empty: 'Noch keine früheren Versionen. Jedes Speichern behält eine.',
            versionsLabel: 'Versionen',
            restoreFailed: 'Diese Version konnte nicht wiederhergestellt werden. Versuche es erneut.',
            savedByUser: 'Von einem Benutzer gespeichert',
            savedByAgentSession: 'Von einer Agentensitzung gespeichert',
            restoredVersion: ({ n }) => `Aus Version ${n} wiederhergestellt`,
            version: ({ n }) => `Version ${n}`,
            keeps: ({ count }) => `Behält die letzten ${count} Versionen.`,
            restore: ({ n }) => `Version ${n} wiederherstellen`,
        },
        savedToday: ({ count }) => `${count} heute gespeichert`,
        noMatch: ({ query }) => `Keine Artefakte passen zu „${query}“`,
        storage: {
            meter: ({ used, limit }) => `${used} von ${limit}`,
            a11y: ({ used, limit }) => `Artefaktspeicher, ${used} von ${limit} belegt`,
        },
        facts: {
            edited: ({ age }) => `Geändert ${age}`,
        },
    } } satisfies Pick<Record<'en' | 'fr' | 'de' | 'es' | 'it' | 'pt' | 'ca' | 'ru' | 'pl' | 'ja' | 'zh-Hans' | 'zh-Hant', ArtifactsBrowserTranslations>, "de">;

return { artifactsBrowserTranslations };
})();

const Domain_automationPageTranslations = (() => {
const english = Shared_automationPageTranslations.english;

const translated = Shared_automationPageTranslations.translated;

const slavicPlural = Shared_automationPageTranslations.slavicPlural;

const automationPageTranslations = { de: translated({
        automationPages: {
            index: {
                description: 'Arbeit, die von selbst startet: nach Zeitplan, durch ein Event oder wenn ein Sitzungsschritt endet.',
            },
            settings: {
                description: 'Wie viel Automationsarbeit jede Maschine übernimmt und wie lange abgeschlossene Ausführungen erhalten bleiben.',
                capacityTitle: 'Kapazität',
                capacityDescription: 'Gilt für jede Maschine, die Automationen ausführt.',
                historyTitle: 'Ausführungsverlauf',
                historyDescription: 'Abgeschlossene Ausführungen, die du noch über eine Automation öffnen kannst.',
            },
            detail: {
                description: 'Startet von selbst Arbeit, sobald einer ihrer Auslöser greift.',
                triggerCount: ({ count }: { count: number }) => (count === 1 ? '1 Auslöser' : `${count} Auslöser`),
                overviewDescription: 'Was sie ausführt und wie du sie startest oder änderst.',
                runNowSubtitle: 'Jetzt eine Ausführung starten, ohne auf einen Auslöser zu warten.',
                editSubtitle: 'Namen, Ausführung und Auslöser ändern.',
                machineAssignmentsDescription: 'Maschinen, die Ausführungen dieser Automation übernehmen können.',
            },
            run: {
                description: 'Was diese Ausführung gestartet hat, wo sie lief und was sie erzeugt hat.',
                statusTitle: 'Status',
                statusDescription: 'Wo diese Ausführung gerade steht und was du noch damit tun kannst.',
                causeTitle: 'Was sie gestartet hat',
                causeDescription: 'Der Auslöser und das Event, die diese Ausführung zugelassen haben. Sie ändern sich danach nie.',
            },
            gate: {
                serverTitle: 'Automationen sind in diesem Home ausgeschaltet',
                serverBody: 'Die Administratoren dieses Homes haben Automationen ausgeschaltet. Bitte eine dieser Personen, sie wieder einzuschalten.',
                openFeatures: 'Funktionseinstellungen öffnen',
                unknownTitle: 'Automationen können gerade nicht geprüft werden',
                unknownBody: 'Happier konnte dieses Home nicht erreichen, um zu prüfen, ob Automationen eingeschaltet sind. Prüfe es erneut, sobald es wieder online ist.',
                unsupportedTitle: 'Dieses Home unterstützt noch keine Automationen',
                unsupportedBody: 'Sein Server ist älter als Automationen. Aktualisiere den Server des Homes, um sie zu nutzen.',
                unsupportedContextTitle: 'Automationen sind hier nicht verfügbar',
                unsupportedContextBody: 'Nicht alle Homes, die du ansiehst, unterstützen Automationen.',
            },
            editor: {
                description: 'Gib ihr einen Namen, wähle, was sie ausführt, und füge die Auslöser hinzu, die sie starten.',
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

const automationTriggerSetTranslations = { de: {
        pluralEditor: {
            ...expandedLifecycleEnglish,
            lifecycleEvent: {
                ...expandedLifecycleEnglish.lifecycleEvent,
                sessionStarted: 'Wenn die Sitzung beginnt',
                sessionArchived: 'Wenn die Sitzung archiviert wird',
            },
            triggersTitle: 'Auslöser',
            emptyBody: 'Keine automatischen Auslöser. Du kannst diese Automation weiterhin manuell starten.',
            orSemantics: 'Füge beliebig viele Auslöser hinzu. Sie arbeiten unabhängig — sobald einer zutrifft, läuft die Automation.',
            enabledSubtitle: 'Die gesamte Automation pausieren, ohne ihre Auslöser zu verändern.', addTrigger: 'Auslöser hinzufügen',
            addTriggerSubtitle: 'Plane sie, verbinde ein Ereignis oder warte auf den Abschluss eines bestimmten Turns.', scheduleTitle: 'Zeitplan', eventTitle: 'Plugin-Ereignis',
            turnCompletedTitle: 'Wenn dieser Turn endet', turnCompletedSubtitle: 'Läuft einmal, nachdem genau der ausgewählte übergeordnete Turn abgeschlossen ist.', selectedSession: 'Ausgewählte Session',
            turnCompletedSource: ({ session, ordinal }: { session: string; ordinal: number }) => `${session} · einmaliger Auslöser ${ordinal}`,
            scheduleInterval: ({ minutes, timezone }: { minutes: number; timezone: string | null }) => `Alle ${minutes} Min.${timezone ? ` · ${timezone}` : ''}`,
            scheduleCron: ({ expression, timezone }: { expression: string; timezone: string | null }) => `${expression}${timezone ? ` · ${timezone}` : ''}`,
            eventSubtitle: ({ pluginId, eventId }: { pluginId: string; eventId: string }) => `${pluginId} · ${eventId}`,
            triggerEnabledLabel: ({ title }: { title: string }) => `${title} aktivieren`, editScheduleTitle: 'Zeitplan bearbeiten', scheduleType: 'Zeitplantyp',
            chooseSession: 'Aktive Session auswählen', eventEditorUnavailable: 'Die Ereigniseinrichtung ist auf dem aktuellen Rechner nicht verfügbar.',
            removeTitle: 'Diesen Auslöser entfernen?', removeBody: 'Künftige Treffer dieses Auslösers starten die Automation nicht mehr. Der Run-Verlauf bleibt unverändert.',
        },
        exactTurn: {
            eventSearchPlaceholder: 'Ereignisse suchen',
            refreshFailedTitle: 'Automations konnten nicht aktualisiert werden',
            refreshFailedBody: 'Die Liste der Automations konnte gerade nicht gelesen werden. Versuche es erneut, um die aktuelle Liste zu laden.',
            actionTitle: 'Wenn dieser Turn endet…', createNew: 'Neue Automation erstellen', createNewSubtitle: 'Beginne mit diesem bereits ausgewählten Turn.',
            addToExistingSubtitle: 'Füge diesen Turn einer vorhandenen Automation hinzu.', searchPlaceholder: 'Automationen durchsuchen',
            eventListA11y: 'Session-Lebenszyklusereignis auswählen',
            destinationA11y: 'Auswählen, wo der Auslöser für diesen Turn hinzugefügt wird', staleTitle: 'Dieser Turn hat sich geändert',
            staleBody: 'Der ausgewählte Turn ist nicht mehr der aktive übergeordnete Turn. Aktualisiere und wähle den aktuellen Turn ausdrücklich aus.',
            useCurrentTurn: 'Aktuellen Turn verwenden', unavailable: 'Im Moment gibt es keinen aktiven übergeordneten Turn.',
            resolvingRowSubtitle: 'Prüfe, welche Automations du verwenden kannst…',
            unavailableRowSubtitle: 'Details nicht verfügbar — diese Automation kann für diese Session nicht überprüft werden.',
            incompleteNoticeTitle: 'Einige Automations konnten nicht gelesen werden',
        },
    } } as const;

return { automationTriggerSetTranslations };
})();

const Domain_boardsTranslations = (() => {
type Count = Shared_boardsTranslations.Count;

type BoardsTranslations = Shared_boardsTranslations.BoardsTranslations;

const en = Shared_boardsTranslations.en;

const de: BoardsTranslations = {
    title: 'Boards',
    newBoard: 'Neues Board',
    defaultName: 'Unbenanntes Board',
    index: {
        title: 'Deine Boards',
        body: 'Ein Board hält Sitzungen, Läufe, Workflows und Rechner an einem Ort live, so angeordnet, wie du es willst.',
    },
    notFound: {
        title: 'Dieses Board gibt es nicht mehr',
        body: 'Es wurde gelöscht oder gehört zu einem Home, das hier nicht verbunden ist.',
    },
    meta: {
        needYou: ({ count }) => (count === 1 ? '1 braucht dich' : `${count} brauchen dich`),
        items: ({ count }) => (count === 1 ? '1 Element' : `${count} Elemente`),
        handPicked: 'Von Hand gewählt',
        empty: 'Leer',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: 'Braucht dich', description: 'Alles, was auf dich wartet' },
        running: { title: 'Läuft gerade', description: 'Laufende Workflow-Läufe' },
        my_machines: { title: 'Meine Rechner', description: 'Status und was auf jedem läuft' },
        filter: { title: 'Sitzungen', description: 'Alle aktiven Sitzungen' },
    },
    header: {
        layoutA11y: 'Board-Layout',
        canvas: 'Canvas',
        byStatus: 'Nach Status',
        add: 'Zum Board hinzufügen',
        settings: 'Board-Einstellungen',
    },
    kinds: {
        session: 'Sitzung',
        workflow_run: 'Workflow-Lauf',
        workflow: 'Workflow',
        machine: 'Rechner',
    },
    card: {
        untitled: 'Nicht verfügbares Element',
        unavailable: 'Nicht verfügbar',
        unavailableBody: 'Das zugehörige Home ist auf diesem Gerät nicht verbunden. Das Element bleibt auf dem Board.',
        notLoaded: 'Noch nicht geladen',
        remove: 'Vom Board entfernen',
        moveHint: 'Mit den Pfeiltasten verschiebst du diese Karte im Raster.',
        moved: ({ x, y }) => `Verschoben nach ${x}, ${y}`,
        moveActions: { up: 'Nach oben verschieben', down: 'Nach unten verschieben', left: 'Nach links verschieben', right: 'Nach rechts verschieben' },
        machine: {
            online: 'Online',
            offline: 'Offline',
            running: ({ count }) => (count === 1 ? '1 Sitzung läuft' : `${count} Sitzungen laufen`),
            needYou: ({ count }) => (count === 1 ? '1 braucht dich' : `${count} brauchen dich`),
            idle: 'Keine Sitzung läuft',
            offlineBody: 'Die Sitzungen warten, bis er wieder da ist.',
        },
        workflow: {
            noRuns: 'Noch keine Läufe',
            lastRun: ({ word, age }) => `Letzter Lauf ${age} · ${word}`,
            needYou: ({ count }) => (count === 1 ? '1 braucht dich' : `${count} brauchen dich`),
        },
        run: {
            waitingForYou: 'Wartet auf deine Prüfung',
            started: ({ age }) => `Gestartet ${age}`,
        },
    },
    canvas: {
        snapsHere: 'Rastet hier ein',
        snapOnceHint: '⇧ halten, um einmal einzurasten',
    },
    settings: {
        title: 'Board-Einstellungen',
        name: 'Name',
        whatsOn: 'Was auf diesem Board ist',
        whichSessions: 'Welche Sitzungen',
        addedByHand: 'Von Hand hinzugefügt',
        addedByHandNone: 'Noch nichts',
        add: 'Hinzufügen',
        layout: 'Layout',
        layoutDescription: 'Canvas behält deine Anordnung, wenn du wechselst.',
        snap: 'Am Raster ausrichten',
        pin: 'In der Sitzungsliste anzeigen',
        pinDescription: 'Heftet dieses Board über deine Sitzungen.',
        delete: 'Board löschen',
        deleteConfirmTitle: 'Dieses Board löschen?',
        deleteConfirmBody: 'Nur das Board verschwindet. Seine Sitzungen, Läufe, Workflows und Rechner bleiben, wie sie sind.',
    },
    add: {
        title: 'Zum Board hinzufügen',
        search: 'Elemente suchen',
        groups: { sessions: 'Sitzungen', workflows: 'Workflows', runs: 'Workflow-Läufe', machines: 'Rechner' },
        onBoard: 'Auf diesem Board',
        addHint: 'Hinzufügen',
        addAndPlaceHint: 'Hinzufügen und platzieren',
        empty: 'Nichts passt.',
    },
    empty: {
        title: 'Wähle, was dieses Board zeigt',
        body: 'Füge Sitzungen, Workflows, Läufe oder Rechner von Hand hinzu oder zeige einen Bereich wie „Braucht dich“. Du ordnest sie an; das Board hält sie live.',
        action: 'Zum Board hinzufügen',
    },
    widgets: {
        group: 'Widgets',
        kind: 'Widget',
        gallery: 'Galerie öffnen',
        galleryHint: 'Alle Widgets, mit Live-Vorschau',
        addHint: 'Nur du siehst deine Boards',
        widthOne: 'Eine Karte',
        widthTwo: 'Zwei Karten',
        moveEarlier: 'Nach vorn',
        moveLater: 'Nach hinten',
        remove: 'Vom Board entfernen',
        menuA11y: ({ widget }) => `Optionen für ${widget}`,
        arrived: ({ count }) => (count === 1 ? 'Gerade ist 1 Widget hinzugekommen' : `Gerade sind ${count} Widgets hinzugekommen`),
        undo: 'Rückgängig',
        dismiss: 'Schließen',
    },
    saveFailed: {
        tooLarge: 'Dieses Board überschreitet das Speicherlimit für Boards. Entferne einige Elemente und versuche es erneut.',
        notFound: 'Dieses Board wurde auf einem anderen Gerät gelöscht.',
        generic: 'Deine Änderung hat dein Konto nicht erreicht, das Board ist daher unverändert.',
        retry: 'Erneut versuchen',
        dismiss: 'Schließen',
        createTitle: 'Dieses Board wurde nicht erstellt',
    },
};

const boardsTranslations = { de };

return { boardsTranslations };
})();

const Domain_browserPresenceTranslations = (() => {
type AgentParams = Shared_browserPresenceTranslations.AgentParams;

type BrowserPresenceTranslations = Shared_browserPresenceTranslations.BrowserPresenceTranslations;

const browserPresenceTranslations = { de: {
        agentFallbackName: 'Der Agent',
        agentBrowsing: ({ agent }) => `${agent} surft`,
        clickTarget: ({ target }) => `Klickt auf „${target}“`,
        doing: {
            click: 'Klickt auf die Seite',
            type: 'Tippt',
            fill: 'Füllt ein Feld aus',
            scroll: 'Scrollt',
            navigate: 'Öffnet eine Seite',
            history: 'Bewegt sich im Verlauf',
            reload: 'Lädt die Seite neu',
            press: 'Drückt eine Taste',
            select: 'Wählt eine Option',
            drag: 'Zieht',
            upload: 'Lädt eine Datei hoch',
            look: 'Sieht sich die Seite an',
            other: 'Arbeitet auf der Seite',
        },
        takeControl: 'Steuerung übernehmen',
        stopping: ({ agent }) => `${agent} wird angehalten…`,
        stoppingDetail: 'Beendet die letzte Aktion',
        lastActionMayHaveLanded: ({ agent }) => `Die letzte Aktion von ${agent} wurde vielleicht ausgeführt`,
        youHaveControl: 'Du hast die Steuerung',
        stopUnconfirmed: 'Stopp nicht bestätigt',
        checkAgain: 'Erneut prüfen',
        pausedUntilHandBack: ({ agent }) => `${agent} pausiert, bis du zurückgibst`,
        handBack: 'Zurückgeben',
        stream: {
            connectingTitle: ({ agent }) => `Verbindung zum Browser von ${agent}`,
            connectingBody: ({ machine }) => `Er läuft auf ${machine}. Die Seite erscheint hier, sobald das erste Bild ankommt.`,
            stalled: 'Letztes Bild · verbindet neu',
            endedTitle: ({ agent }) => `${agent} hat diesen Browser geschlossen`,
            endedBody: 'Die Seite wird hier nicht mehr angezeigt.',
            openPageHere: "Seite hier öffnen",
            unavailableTitle: ({ agent }) => `Der Browser von ${agent} kann hier nicht angezeigt werden`,
            unavailableBody: ({ agent }) => `${agent} surft weiter; seine Aktionen erscheinen weiterhin im Chat.`,
            tryAgain: 'Erneut versuchen',
            inputA11y: 'Die Seite. Tippen, scrollen oder schreiben, um die Steuerung zu übernehmen.',
        },
        recording: {
            elapsedA11y: ({ elapsed }) => `Aufnahme, ${elapsed}`,
            discard: 'Aufnahme verwerfen',
        },
        openInYourBrowser: 'In deinem Browser öffnen',
        slowPage: 'Diese Seite braucht etwas länger',
        confidentialHeld: ({ agent }) => `Private Eingabe hier · für ${agent} verborgen, bis die Seite geschlossen wird`,
        closePage: 'Seite schließen',
    } } satisfies Pick<Record<string, BrowserPresenceTranslations>, "de">;

return { browserPresenceTranslations };
})();

const Domain_browserToolTranslations = (() => {
type TargetParams = Shared_browserToolTranslations.TargetParams;

type BrowserToolTranslations = Shared_browserToolTranslations.BrowserToolTranslations;

const browserToolTranslations = { de: {
        opened: ({ page }) => `${page} geöffnet`,
        openedPage: 'Eine Seite geöffnet',
        reloaded: 'Seite neu geladen',
        wentBack: 'Zurück gegangen',
        wentForward: 'Vorwärts gegangen',
        clicked: ({ target }) => `${target} geklickt`,
        clickedPage: 'Auf die Seite geklickt',
        typedInto: ({ target }) => `In ${target} getippt`,
        typed: 'Auf der Seite getippt',
        filledIn: ({ target }) => `${target} ausgefüllt`,
        filled: 'Ein Feld ausgefüllt',
        pressed: ({ key }) => `${key} gedrückt`,
        pressedKey: 'Eine Taste gedrückt',
        scrolled: 'Seite gescrollt',
        pointedAt: ({ target }) => `Auf ${target} gezeigt`,
        pointed: 'Auf die Seite gezeigt',
        choseIn: ({ target }) => `Option in ${target} gewählt`,
        chose: 'Eine Option gewählt',
        uploadedTo: ({ target }) => `Datei in ${target} hochgeladen`,
        uploaded: 'Eine Datei hochgeladen',
        dragged: ({ target }) => `${target} gezogen`,
        draggedPage: 'Auf der Seite gezogen',
        looked: 'Seite angesehen',
        screenshot: 'Bildschirmfoto aufgenommen',
        recordingStarted: 'Aufnahme der Seite gestartet',
        recordingStopped: 'Aufnahme beendet',
        other: 'Den Browser benutzt',
        watch: 'Ansehen',
        watchA11y: 'Diese Seite im Browser öffnen',
    } } satisfies Pick<Record<string, BrowserToolTranslations>, "de">;

return { browserToolTranslations };
})();

const Domain_changedFileEvidenceTranslations = (() => {
type ChangedFileEvidenceTranslations = Shared_changedFileEvidenceTranslations.ChangedFileEvidenceTranslations;

const en = Shared_changedFileEvidenceTranslations.en;

const translated = Shared_changedFileEvidenceTranslations.translated;

const changedFileEvidenceTranslations = { de: {
        changedFileEvidence: translated({
            before: 'Vorher',
            after: 'Nachher',
            binary: 'Binärdatei',
            truncated: 'Der Nachweisinhalt wurde begrenzt; Originalgröße und Änderungsstatistik bleiben erhalten, sofern verfügbar.',
            truncatedOldBytes: ({ count }) => `Ursprünglicher Inhalt davor: ${count} Bytes`,
            truncatedNewBytes: ({ count }) => `Ursprünglicher Inhalt danach: ${count} Bytes`,
            truncatedDiffBytes: ({ count }) => `Ursprüngliches Diff: ${count} Bytes`,
            truncatedAddedLines: ({ count }) => `Hinzugefügte Zeilen: ${count}`,
            truncatedRemovedLines: ({ count }) => `Entfernte Zeilen: ${count}`,
            kind: {
                added: 'Hinzugefügt',
                modified: 'Geändert',
                deleted: 'Gelöscht',
                renamed: 'Umbenannt',
                copied: 'Kopiert',
                unknown: 'Änderungsart nicht verfügbar',
            },
            howDetermined: 'Wie ermittelt',
            howDeterminedForFile: ({ path }) => `Wie ${path} ermittelt wurde`,
            content: {
                exact: 'Exakte Änderung im Repository',
                strong: 'Starker Inhaltsnachweis',
                best_effort: 'Bestmöglicher Inhaltsnachweis',
            },
            attribution: {
                session_exact: 'Mit dieser Session verknüpft',
                session_likely: 'Wahrscheinlich von dieser Session geändert',
                session_possible: 'Möglicherweise von dieser Session geändert',
                unknown: 'Session-Zuordnung nicht verfügbar',
            },
            reason: {
                provider_correlated: 'Der Agent hat diese Änderung für diesen Turn gemeldet.',
                canonical_tool_correlated: 'Ein Diff- oder Patch-Werkzeug hat diese Änderung mit diesem Turn verknüpft.',
                checkpoint_no_happier_overlap_observed: 'Der Sicherungspunkt hat in diesem Prozess keinen überlappenden Happier-Turn erfasst.',
                checkpoint_overlap_observed: 'Ein anderer Happier-Turn hat das Aufnahmeintervall des Sicherungspunkts überlappt.',
                workspace_touched_path: 'Dieser Pfad wurde im Workspace berührt; das benennt nicht die Session, die ihn geändert hat.',
                unavailable: 'Der Nachweis belegt nicht, welche Session diese Änderung vorgenommen hat.',
            },
            overlap: {
                observed: 'Ein anderer Happier-Turn hat dieses Checkout während der Aufnahme überlappt. Die Beobachtungen umfassen nur diesen Prozess; andere Prozesse und externe Schreiber werden nicht verfolgt.',
                not_observed: 'In diesem Prozess wurde kein überlappender Happier-Turn beobachtet. Andere Prozesse und externe Schreiber werden nicht verfolgt; das belegt keine alleinige Autorschaft.',
                unknown: 'Die Überlappung des Sicherungspunkts ist unbekannt. Andere Prozesse und externe Schreiber werden nicht verfolgt.',
            },
            sources: {
                provider_native: 'Agent-eigener Änderungsbericht',
                provider_tool: 'Bericht eines Agent-Werkzeugs',
                canonical_diff_tool: 'Nachweis eines Diff-Werkzeugs',
                canonical_patch_tool: 'Nachweis eines Patch-Werkzeugs',
                scm_checkpoint: 'Sicherungspunkt des Repositorys',
                scm_reconciled: 'Abgeglichener Repository-Snapshot',
                inferred: 'Im Workspace berührter Pfad',
            },
        }),
    } } as const;

return { changedFileEvidenceTranslations };
})();

const Domain_cliPathExposureTranslations = (() => {
const en = Shared_cliPathExposureTranslations.en;

const de = {
    title: 'Kommandozeile',
    footer: 'Happier Desktop fügt nur PATH-Einträge hinzu oder entfernt sie, die es selbst erstellt hat. Vom Shell-Installer geschriebene Einträge bleiben unberührt.',
    addTitle: 'happier zum PATH hinzufügen',
    addSubtitle: 'Macht den Befehl happier in neuen Terminals verfügbar.',
    removeTitle: 'happier aus dem PATH entfernen',
    removeSubtitle: 'Entfernt nur die PATH-Einträge, die Happier Desktop hinzugefügt hat.',
    working: 'Dein Shell-Profil wird aktualisiert…',
    added: 'Hinzugefügt. Öffne ein neues Terminal, um happier zu nutzen.',
    alreadyPresent: 'happier ist bereits in deinem PATH.',
    removed: 'Die von Happier Desktop hinzugefügten PATH-Einträge wurden entfernt.',
    nothingToRemove: 'Happier Desktop hat keine PATH-Einträge hinzugefügt.',
};

const cliPathExposureTranslations = { de: de };

return { cliPathExposureTranslations };
})();

const Domain_cliTrustPromptTranslations = (() => {
const en = Shared_cliTrustPromptTranslations.en;

const de = {
    title: 'Diese Befehlszeile freigeben?',
    body: ({ command }: { command: string }) => `Happier hat die Befehlszeile unter ${command} nicht installiert. Mit der Freigabe kann sie die Sitzungen dieses Kontos lesen und schreiben. Gib nur frei, was du selbst dort abgelegt hast.`,
    bodyUnknownCommand: 'Happier hat diese Befehlszeile nicht installiert. Mit der Freigabe kann sie die Sitzungen dieses Kontos lesen und schreiben. Gib nur frei, was du selbst dort abgelegt hast.',
    approve: 'Freigeben',
};

const cliTrustPromptTranslations = { de: de };

return { cliTrustPromptTranslations };
})();

const Domain_commitProposalTranslations = (() => {
type Count = Shared_commitProposalTranslations.Count;

type CommitProposalCopy = Shared_commitProposalTranslations.CommitProposalCopy;

const en = Shared_commitProposalTranslations.en;

const commitProposalTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', { commitProposal: CommitProposalCopy }>>, "de"> = { de: { commitProposal: {
        title: ({ count }) => (count === 1 ? 'Ein Commit für deine ausstehenden Änderungen' : `${count} Commits für deine ausstehenden Änderungen`),
        titlePhone: ({ count }) => (count === 1 ? 'Ein Commit' : `${count} Commits`),
        proposedBy: ({ who, committed, total }) => `Vorgeschlagen von ${who} · ${committed} von ${total} Dateien · so geordnet, dass jeder Commit auf dem vorigen aufbaut.`,
        proposedByPhone: ({ committed, total }) => `${committed} von ${total} ausstehenden Dateien · tippe auf eine Änderung, um sie zu verschieben.`,
        moveHint: ({ max }) => `Verschiebe jede Änderung mit ⌥1–${max} oder über ihr Menü.`,
        modelFallback: 'das Modell',
        regenerate: 'Neu erstellen',
        conflict: 'Der Vorschlag wurde anderswo geändert. Das ist der neueste Stand; nimm deine Änderung erneut vor.',
        approvalPending: 'Wartet auf Freigabe, um diese Commits zu erstellen.',
        discardBody: 'Der Vorschlag wird entfernt. Deine ausstehenden Änderungen bleiben unverändert.', askFix: ({ hook, number, message }) => `Der ${hook}-Hook hat Commit ${number} („${message}“) angehalten. Bitte behebe, was er meldet, damit der Commit durchgeht:`, askFixGeneric: ({ number, message }) => `Ein Hook hat Commit ${number} („${message}“) angehalten. Bitte behebe, was er meldet, damit der Commit durchgeht:`, discarded: 'Vorschlag verworfen.', undo: 'Rückgängig',
        fileCount: ({ count }) => (count === 1 ? '1 Datei' : `${count} Dateien`),
        part: ({ count, of }) => `${count} von ${of} Änderungen`,
        move: { a11y: ({ file }) => `${file} in einen anderen Commit verschieben`, title: ({ file }) => `${file} verschieben nach`, newCommitAfter: ({ number }) => `Neuer Commit nach ${number}`, newCommitMessage: ({ file }) => `${file} aktualisieren`, leaveOut: 'Aus diesen Commits herauslassen', leaveOutHint: 'Bleibt in deinem Arbeitsverzeichnis' },
        group: { a11y: ({ number, message }) => `Commit ${number}: ${message}`, editMessage: 'Nachricht bearbeiten', messageA11y: ({ number }) => `Nachricht von Commit ${number}`, more: 'Mehr', moveUp: 'Nach oben', moveDown: 'Nach unten', mergeWithNext: 'Mit dem nächsten Commit zusammenführen', empty: 'Noch keine Änderungen. Verschiebe eine hierher oder führe ihn mit dem nächsten zusammen.' },
        leftOut: { title: 'Herausgelassen · bleibt in deinem Arbeitsverzeichnis', description: 'Diese Änderungen bleiben ausstehend. Committe sie einzeln, wenn du das wolltest.' },
        footer: { commits: ({ count }) => (count === 1 ? '1 Commit' : `${count} Commits`), onBranch: ({ branch }) => ` auf ${branch} · Hooks und Signatur laufen wie bei jedem Commit`, detached: ' auf einem losgelösten HEAD · Hooks und Signatur laufen wie bei jedem Commit', phone: 'Hooks und Signatur wie gewohnt', discard: 'Vorschlag verwerfen', create: ({ count }) => (count === 1 ? '1 Commit erstellen' : `${count} Commits erstellen`), createShort: ({ count }) => `${count} erstellen`, emptyGroupReason: 'Ein Commit hat keine Änderungen. Verschiebe eine hinein oder führe ihn zusammen.' },
        applying: { title: ({ count }) => (count === 1 ? '1 Commit wird erstellt' : `${count} Commits werden erstellt`), body: 'Einer nach dem anderen über den normalen Commit-Weg, also laufen Hooks und Signatur wie gewohnt. Bearbeiten pausiert, bis das fertig ist.', bodyPhone: 'Bearbeiten pausiert, bis das fertig ist.', created: ({ landed, total }) => `${landed} von ${total}`, createdRest: ' erstellt · nichts wird zurückgenommen, wenn ein späterer anhält', createdRestPhone: ' erstellt', stopAfterThis: 'Nach diesem Commit anhalten', stopAfterThisShort: 'Danach anhalten', stopping: 'Hält nach diesem Commit an' },
        state: { waiting: 'Wartet', writing: 'Hooks laufen, Commit wird erstellt', landed: 'committet', landedAt: ({ time }) => `committet ${time}`, signed: 'signiert', pausedBy: ({ hook, count }) => `${hook} hat ${count} ${count === 1 ? 'Datei' : 'Dateien'} geändert · noch nicht committet`, hookFailedBy: ({ hook }) => `${hook} fehlgeschlagen · nicht committet`, rewritten: 'ein Hook hat die Nachricht umgeschrieben', notCreated: 'Nicht erstellt · weiter bearbeitbar', notCreatedShort: 'Nicht erstellt', unknown: 'Noch nicht bestätigt', paused: ({ count }) => (count === 1 ? 'Ein Hook hat 1 Datei geändert · noch nicht committet' : `Ein Hook hat ${count} Dateien geändert · noch nicht committet`), failed: 'Hier angehalten · nicht committet' },
        outcome: { signingTitle: 'Deine Commits können gerade nicht signiert werden.', signingBody: 'Dieses Repository signiert jeden Commit. Es wurde nichts committet.', signingHint: 'Entsperre zuerst deinen GPG- oder SSH-Agenten', tryAgain: 'Erneut versuchen', cancel: 'Abbrechen', hookChanged: ({ files }) => `Der Hook hat ${files} geändert.`, waitsAfterLanded: ({ count }) => (count === 1 ? 'Commit 1 ist da; dieser wartet auf dich.' : `${count} Commits sind da; dieser wartet auf dich.`), waits: 'Dieser wartet auf dich.', include: 'Änderungen des Hooks übernehmen', includePhone: 'Übernehmen und committen', cancelCommit: 'Diesen Commit abbrechen', hookFailed: 'Ein Hook hat diesen Commit angehalten.', hookChangedBy: ({ hook, files }) => `${hook} hat ${files} geändert.`, hookFailedBy: ({ hook }) => `${hook} hat diesen Commit angehalten.`, hookFailedBody: 'Frühere Commits bleiben. Den Rest kannst du weiter bearbeiten.', headMoved: ({ branch }) => `${branch} hat sich während der Commits bewegt.`, headMovedBody: 'Der nächste Commit wurde abgelehnt, nichts wurde zurückgenommen.', proposeAgain: 'Für den Rest neu vorschlagen', keepEditing: 'Weiter bearbeiten', askSessionToFix: 'Diese Sitzung um eine Korrektur bitten', showInGit: 'In Git zeigen', unknownTitle: 'Wir konnten nicht bestätigen, ob dieser Commit angekommen ist.', unknownBody: 'Nichts wird wiederholt, bis wir es wissen. Prüfe den Branch erneut.', checkAgain: 'Erneut prüfen', stoppedTitle: ({ landed, total }) => `${landed} von ${total} Commits erstellt`, stoppedBody: ({ count }) => (count === 1 ? 'Der letzte wurde nicht erstellt. Seine Änderungen sind wie zuvor in deinem Arbeitsverzeichnis.' : `${count} wurden nicht erstellt. Ihre Änderungen sind wie zuvor in deinem Arbeitsverzeichnis.`), createRest: ({ count }) => (count === 1 ? 'Den letzten erstellen' : `Die restlichen ${count} erstellen`), completeTitle: ({ count }) => (count === 1 ? '1 Commit erstellt' : `${count} Commits erstellt`), completeBody: 'Es wurde nichts gepusht.', onBranch: ({ branch }) => `auf ${branch}`, failed: { staging_conflict: 'Etwas anderes hat den gestagten Stand geändert.', selection_conflict: 'Diese Änderungen lassen sich so nicht aufteilen.', source_changed: 'Die ausstehenden Änderungen haben sich seit dem Vorschlag bewegt.', writer_failed: 'Der Commit konnte nicht erstellt werden.', publication_warning: 'Der Commit ist da, aber die gestagten Dateien wurden nicht aktualisiert.', cancelled: 'Dieser Commit wurde abgebrochen.' }, failedBody: 'Frühere Commits bleiben. Nichts wurde zurückgenommen.' },
        none: { title: 'Noch kein Commit-Vorschlag', workingTreeOnly: 'Commit-Pläne können nur auf die aktuellen lokalen Änderungen angewendet werden.', reason: 'Ein Vorschlag gruppiert deine ausstehenden Änderungen in Commits, die du bearbeiten kannst, und erstellt sie dann einzeln über den normalen Commit-Weg.', propose: 'Commits vorschlagen', writing: 'Deine ausstehenden Änderungen werden gruppiert…' },
        gitPane: { title: 'Vorgeschlagene Commits', meta: ({ count, files }) => `${count} · ${files} Dateien`, inCommit: ({ count, number }) => `${count} in Commit ${number}`, open: 'Öffnen', review: 'Prüfen', reviewInWalkthrough: 'Im Durchgang prüfen', more: 'Verwerfen oder neu erstellen', selectedHint: 'Ausgewählt. Erneut tippen, um ihn in Commits zu öffnen', tapHint: 'Tippen, um seine Änderungen zu zeigen' },
    } } };

return { commitProposalTranslations };
})();

const Domain_committedMessageActionTranslations = (() => {
const committedMessageActionTranslations = { "de": {
        "committedMessageActions": {
            "copy": "Kopieren",
            "fork": "Abzweigen",
            "rollback": "Zurücksetzen",
            "pin": "Anheften",
            "savePrompt": "Als Prompt speichern",
            "plugins": "Plugin-Aktionen",
            "composerButton": "Prompt-Bibliotheksschaltfläche",
            "composerHint": "Deine Prompts und Gesendetes, neben dem Diktat. Ist er aus, bietet das /-Menü weiterhin Prompts… an.",
            "name": "Name",
            "shortcut": "/ Kürzel",
            "savedOpen": "In Bibliothek gespeichert · Öffnen",
            "shortcutNotSaved": "Der Prompt wurde gespeichert, aber das Kürzel nicht. Öffne ihn in der Bibliothek, um ein Kürzel hinzuzufügen.",
            "wrongAccount": "Wechsle zum Home dieser Sitzung, bevor du ihren Prompt speicherst.",
            "savedHintFavorite": "Kommt in deine Bibliothek, mit Stern.",
            "savedHint": "Kommt in deine Bibliothek.",
            "addShortcut": "/ Kürzel hinzufügen",
            "shortcutPlaceholder": "/kuerzel",
            "savedToLibrary": "In Bibliothek gespeichert",
            "savePromptHint": "Aus der Prompt-Bibliothek wiederverwenden",
            "copyHint": "Den Text einer Nachricht kopieren.",
            "forkHint": "Aus einer Nachricht eine neue Sitzung starten.",
            "rollbackHint": "Den Workspace auf den Stand vor einer Nachricht zurücksetzen.",
            "pinHint": "Nachrichten anheften, um zu ihnen zurückzukehren. Angeheftete bleiben angeheftet.",
            "savePromptSettingHint": "Eine gesendete Nachricht als Prompt in der Bibliothek behalten.",
            "pluginsHint": "Aktionen, die deine Plugins unter Nachrichten hinzufügen."
        }
    } };

return { committedMessageActionTranslations };
})();

const Domain_computerUseTranslations = (() => {
type MachineParams = Shared_computerUseTranslations.MachineParams;

type ComputerUseTranslations = Shared_computerUseTranslations.ComputerUseTranslations;

const computerUseTranslations = { de: {
        approval: {
            sectionTitle: 'Auf dem Computer',
            act: {
                list: 'Sehen, welche Fenster offen sind',
                see: 'Bildschirmfoto aufnehmen',
                read: 'Text und Bedienelemente lesen',
                click: 'Klicken',
                press: 'Taste drücken',
                type: 'Tippen',
                share: 'Ein Fenster teilen',
            },
            windowOn: ({ machine }) => `Ein Fenster auf ${machine}`,
            screenOf: ({ machine }) => `Der ganze Bildschirm von ${machine}`,
            windowsOn: ({ machine }) => `Die offenen Fenster auf ${machine}`,
            window: 'Ein Fenster',
            screen: 'Der ganze Bildschirm',
            windows: 'Die offenen Fenster',
            typedLabel: 'Text',
            keyLabel: 'Taste',
            listConsequence: 'Nur die Namen der offenen Fenster werden geteilt, nicht ihr Inhalt.',
            seeConsequence: 'Bildschirmfotos gehen an diese Sitzung. Kein Klicken, kein Tippen.',
            useConsequence: 'Eingaben, die das Gerät erreichen, lassen sich nicht rückgängig machen. Du kannst jederzeit stoppen.',
            targetOn: ({ machine, target }) => `${target} auf ${machine}`,
            chooseFirst: 'Wähle zuerst das Fenster',
            cropA11y: ({ target }) => `Das letzte Bild von ${target}`,
            suggestsWindow: ({ agent, target }) => `${agent} schlägt „${target}“ vor`,
        },
        request: {
            title: ({ agent, machine }) => `${agent} möchte ein Fenster auf ${machine} verwenden`,
            body: 'Du wählst das Fenster. Bis dahin wird nichts geteilt.',
            choose: 'Fenster wählen',
            change: 'Fenster ändern',
            shared: ({ target }) => `${target} geteilt`,
            watch: 'Ansehen',
        },
        picker: {
            title: ({ agent }) => `${agent} ein Fenster verwenden lassen`,
            description: ({ agent }) => `Du wählst, was du mit ${agent} teilst.`,
            windows: 'Fenster',
            screens: 'Ganzer Bildschirm',
            untitledWindow: 'Fenster ohne Titel',
            screenLabel: ({ index }) => `Bildschirm ${index}`,
            share: 'Fenster teilen',
            shareScreen: 'Bildschirm teilen',
            shareApp: ({ app }) => `${app}-Fenster teilen`,
            stopSharing: 'Teilen beenden',
            loadingTitle: ({ machine }) => `Suche Fenster auf ${machine}`,
            noScreenTitle: ({ machine }) => `${machine} hat keinen Bildschirm zum Teilen`,
            noScreenBody: 'Es läuft ohne einen Desktop, den Happier sehen kann. Verwende ein Gerät mit Bildschirm.',
            unsupportedTitle: ({ machine }) => `Happier kann den Bildschirm von ${machine} noch nicht verwenden`,
            unsupportedBody: 'Fenster teilen funktioniert vorerst auf Linux-Desktops.',
            failedTitle: ({ machine }) => `Fenster auf ${machine} konnten nicht aufgelistet werden`,
            failedBody: 'Prüfe, ob Happier dort läuft, und versuche es erneut.',
            emptyTitle: ({ machine }) => `Auf ${machine} sind keine Fenster geöffnet`,
            emptyBody: 'Öffne das Fenster, das du teilen möchtest, und prüfe erneut.',
            tryAgain: 'Erneut versuchen',
            inUse: 'Eine andere Sitzung verwendet dieses Fenster. Wähle ein anderes.',
            closed: 'Dieses Fenster wurde geschlossen. Wähle ein anderes.',
            selectFailed: 'Dieses Fenster konnte nicht geteilt werden. Versuche es erneut.',
            otherMachineTitle: ({ machine }) => `${machine} ist nicht das Gerät dieser Sitzung`,
            otherMachineBody: 'Fenster lassen sich nur auf dem Gerät teilen, auf dem diese Sitzung läuft.',
            purpose: ({ session }) => `Für „${session}“.`,
            purposeIn: ({ project, session }) => `Für „${session}“ in ${project}.`,
            access: ({ agent }) => `${agent} darf`,
            accessValue: 'Sehen und verwenden',
            accessSee: 'Nur ansehen',
            displayUnavailable: 'Der gesamte Bildschirm dieses Computers kann nicht geteilt werden.',
            wholeDisplayBody: ({ display }) => `Alles, was auf ${display} sichtbar ist, kann gesehen werden, auch andere Apps und Mitteilungen.`,
            policyBoth: ({ agent }) => `${agent} fragt vor jedem Screenshot, Klick und Tastendruck.`,
            policyInput: ({ agent }) => `${agent} fragt vor jedem Klick und Tastendruck.`,
            policyCapture: ({ agent }) => `${agent} fragt vor jedem Screenshot.`,
            policyNone: ({ agent }) => `${agent} fragt nicht vor Screenshots, Klicks oder Tastendrücken.`,
            policyChange: 'Ändern',
            suggests: ({ agent }) => `${agent} schlägt vor`,
            usingIt: 'der Agent verwendet es',
            displayShared: 'alles darauf wird geteilt',
            refresh: 'Quellen aktualisieren',
            footnote: 'Vor dem Auflisten von Fenstern wirst du gefragt; beim Teilen eines ganzen Displays noch einmal.',
            wholeDisplayTitle: 'Ganzes Display teilen?',
            allowSee: 'Ansehen erlauben',
            allowUse: 'Maus und Tastatur erlauben',
            allowUseHint: ({ agent }) => `${agent} kann dieses Display verwenden. Du kannst die Kontrolle jederzeit zurücknehmen.`,
            shareDisplay: 'Display teilen',
        },
        permission: {
            input: 'Bedienungshilfen',
            denied: 'Nicht erlaubt',
            opened: ({ machine }) => `Auf ${machine} geöffnet. Erlaube Happier dort und prüfe dann erneut.`,
            openFailed: 'Die Systemeinstellungen konnten dort nicht geöffnet werden. Öffne sie auf diesem Computer.',
            checkAgain: 'Erneut prüfen',
            captureTitle: ({ machine }) => `Erlaube die Bildschirmaufnahme auf ${machine}, um seine Fenster oder sein Display anzusehen.`,
            inputTitle: ({ machine }) => `Erlaube Bedienungshilfen auf ${machine}, um Maus und Tastatur zu verwenden.`,
            unknownTitle: ({ machine }) => `Die Bildschirmberechtigungen auf ${machine} konnten nicht geprüft werden. Prüfe erneut, bevor du teilst.`,
            separateBody: ({ machine }) => `Bedienungshilfen sind getrennt: Damit verwendest du dort Maus und Tastatur. Beides wird auf ${machine} erlaubt, nicht auf diesem Gerät.`,
            onMachineBody: ({ machine }) => `Das wird auf ${machine} erlaubt, nicht auf diesem Gerät.`,
            openPrivacy: ({ machine }) => `Datenschutzeinstellungen auf ${machine} öffnen`,
        },
        viewer: {
            agentUsing: ({ agent, target }) => `${agent} verwendet ${target}`,
            agentCanUse: ({ agent, target }) => `${agent} darf ${target} verwenden`,
            agentCanSee: ({ agent, target }) => `${agent} kann ${target} ansehen`,
            onMachine: ({ machine }) => `Auf ${machine}`,
            connectingTitle: ({ target }) => `Verbinde mit ${target}`,
            unavailableTitle: 'Dieses Fenster kann gerade nicht angezeigt werden',
            unavailableBody: ({ agent }) => `Du kannst ${agent} hier trotzdem stoppen.`,
            endedTitle: ({ target }) => `${target} wurde geschlossen`,
            endedBody: ({ agent }) => `${agent} kann es nicht mehr sehen oder verwenden. Wähle ein anderes Fenster, um fortzufahren.`,
            stalled: 'Letztes Bild · verbinde neu',
            inputA11y: ({ target }) => `${target}, live. Klicke oder tippe, um die Steuerung zu übernehmen.`,
            notSharedTitle: 'Kein Fenster geteilt',
            notSharedBody: ({ agent }) => `Wähle ein Fenster, das ${agent} verwenden soll.`,
            moreA11y: 'Fensteroptionen',
            tabFallback: 'Computer',
            sourceComputer: 'Computer',
            sourceBrowser: 'Browser',
            sourceA11y: 'Quelle',
            watchingA11y: ({ source, machine }) => `${source} auf ${machine} ansehen`,
            expandView: 'Ansicht vergrößern',
            restoreView: 'Ansicht wiederherstellen',
            dockView: 'Ansicht andocken',
            closeView: 'Ansicht schließen',
            moveView: 'Ansicht verschieben',
            resizeView: 'Ansichtsgröße ändern',
            moveTopLeft: 'Nach oben links',
            moveTopRight: 'Nach oben rechts',
            moveBottomLeft: 'Nach unten links',
            moveBottomRight: 'Nach unten rechts',
            larger: 'Größer',
            smaller: 'Kleiner',
            viewOptions: 'Ansichtsoptionen',
            presentedElsewhereTitle: 'Wird in der schwebenden Ansicht gezeigt',
            presentedElsewhereBody: 'Docke sie hier an, um sie neben deiner Arbeit zu behalten.',
            closeHint: 'Schließt diese Ansicht. Die Sitzung läuft weiter.',
            agentWorkingOn: ({ agent, machine }) => `${agent} arbeitet auf ${machine}`,
            watchingSourceA11y: ({ source }) => `${source} wird angesehen`,
            controlNotAllowed: 'Maus- und Tastatursteuerung sind nicht erlaubt',
            paused: ({ time }) => `Stream pausiert · letztes Bild ${time}`,
            offlineTitle: ({ machine }) => `${machine} antwortet nicht`,
            offlineBody: 'Verbinde sie wieder, um zuzusehen. Zusehen startet sie nicht.',
            openingTitle: ({ target, machine }) => `${target} wird auf ${machine} geöffnet…`,
        },
        strip: {
            using: ({ target }) => `Verwendet ${target}`,
            on: ({ machine }) => `auf ${machine}`,
            stop: 'Stoppen',
            paused: ({ agent }) => `${agent} pausiert`,
            pausedDetail: ({ target }) => `Du steuerst ${target}`,
        },
        tool: {
            capture: 'Screenshot aufgenommen',
            captureRunning: 'Nimmt einen Screenshot auf',
            query: 'Text und Bedienelemente des Fensters gelesen',
            queryRunning: 'Liest das Fenster',
            click: 'Ins Fenster geklickt',
            clickRunning: 'Klickt ins Fenster',
            clickTarget: ({ target }) => `Auf „${target}“ geklickt`,
            type: 'Ins Fenster getippt',
            typeRunning: 'Tippt ins Fenster',
            typeTarget: ({ target }) => `In „${target}“ eingegeben`,
            pressKey: ({ key }) => `${key} gedrückt`,
            press: 'Eine Taste gedrückt',
            pressRunning: 'Drückt eine Taste',
            mayHaveLanded: 'wurde eventuell ausgeführt',
            failed: 'Nicht ausgeführt',
        },
    } } satisfies Pick<Record<string, ComputerUseTranslations>, "de">;

return { computerUseTranslations };
})();

const Domain_connectedServicesCollectionTranslations = (() => {
type ConnectedServicesCollectionCopy = Shared_connectedServicesCollectionTranslations.ConnectedServicesCollectionCopy;

const en = Shared_connectedServicesCollectionTranslations.en;

const de: ConnectedServicesCollectionCopy = {
    accountLabel: ({ service }) => `${service}-Konto`,
    accountLabelNumbered: ({ service, number }) => `${service}-Konto ${number}`,
    meterResetsIn: ({ time }) => `in ${time}`,
    meterNextResetIn: ({ time }) => `nächster in ${time}`,
    meterResetsAt: ({ countdown, time }) => `${countdown} · ${time}`,
    meterNotReported: 'Nicht gemeldet',
    meterEstimated: ({ value }) => `~${value}`,
    indexTitle: 'Alle Dienste',
    indexDescription: 'Die Konten, mit denen sich deine Agents anmelden, und wie viel jedem bleibt.',
    viewList: 'Liste',
    viewGrid: 'Raster',
    viewLabel: 'Konten anzeigen als',
    refreshAll: 'Alle aktualisieren',
    refreshUsage: 'Nutzung aktualisieren',
    signedOutConsequence: 'Sitzungen können es erst wieder nutzen, wenn du dich erneut anmeldest.',
    poolsGroup: 'Pools',
    poolsDescription: 'Konten, zwischen denen ein Agent wechselt. Der Pool wählt eines beim Start einer Sitzung und wechselt, wenn es aufgebraucht ist.',
    newPool: 'Neuer Pool',
    poolUsing: ({ account }) => `Nutzt ${account}`,
    poolPosition: ({ position, count }) => position === 1 ? `Erstes von ${count}` : `${position} von ${count}`,
    poolInUseNow: 'gerade in Verwendung',
    inUse: 'In Verwendung',
    connectService: 'Dienst verbinden',
    searchAccounts: 'Konten suchen',
    servicesGroup: 'Dienste',
    railEmpty: 'Noch keine Konten',
    railKey: 'Schlüssel',
    railAccountLabel: ({ service, account }) => `${service} · ${account}`,
    agentSignInTitle: 'Wie sich Agents anmelden',
    subscriptionTitle: 'Abo',
    subscriptionNone: 'Kein Abo',
    subscriptionRenewsIn: ({ days }) => days === 0 ? 'Verlängert sich heute' : days === 1 ? 'Verlängert sich morgen' : `Verlängert sich in ${days} Tagen`,
    subscriptionEndsIn: ({ days }) => days === 0 ? 'Keine Verlängerung · endet heute' : `Keine Verlängerung · endet in ${days} Tagen`,
    subscriptionPeriodEndsIn: ({ days }) => days === 0 ? 'Zeitraum endet heute' : `Zeitraum endet in ${days} Tagen`,
    subscriptionRenewsOn: ({ date, days }) => `Verlängert sich am ${date} · in ${days} Tagen`,
    subscriptionEndsOn: ({ date, days }) => `Keine Verlängerung · endet am ${date}, in ${days} Tagen. Danach nutzen Sitzungen es nicht mehr.`,
    subscriptionPeriodEndsOn: ({ date, days }) => `Zeitraum endet am ${date} · in ${days} Tagen`,
    renewalOn: 'An',
    renewalOff: 'Aus',
    renewalUnknown: 'Unbekannt',
    checkedAt: ({ time }) => `Geprüft ${time}`,
    checkedMayBeOutOfDate: ({ time }) => `Geprüft ${time} · evtl. veraltet`,
    usageCheckedMayBeOutOfDate: ({ time }) => `Geprüft ${time} · evtl. veraltet`,
    daysAgo: ({ count }) => count === 1 ? 'vor 1 Tag' : `vor ${count} Tagen`,
    hoursAgo: ({ count }) => count === 1 ? 'vor 1 Stunde' : `vor ${count} Stunden`,
    usageResetsCount: ({ count }) => count === 1 ? '1 Nutzungs-Reset' : `${count} Nutzungs-Resets`,
    usageResetsFirstExpires: ({ date }) => `erster läuft ${date} ab`,
    usageResetExpires: ({ date }) => `läuft ${date} ab`,
    useOne: 'Einen nutzen',
    useOneReset: 'Einen Nutzungs-Reset nutzen',
    usageResetsTitle: 'Nutzungs-Resets',
    usageResetsDescription: 'Jeder startet sofort ein neues Fenster. Heb sie für den Fall auf, dass dich ein Limit blockiert; ungenutzte verfallen.',
    usageResetTitle: 'Nutzungs-Reset',
    usageResetExpiresOn: ({ date }) => `Läuft am ${date} ab`,
    use: 'Nutzen',
    usedByDefault: 'Standard · neue Sitzungen nutzen dieses Konto',
    accountIdFact: ({ id }) => `ID ${id}`,
    hideIdentitiesTitle: 'E-Mails und IDs von Konten ausblenden',
    hideIdentitiesDescription: 'Für Streams und Demos. Verdeckt E-Mails und Konto-IDs überall auf diesem Gerät; Namen, die du Konten gegeben hast, bleiben.',
    privacyTitle: 'Datenschutz',
    renameTitle: 'Konto benennen',
    renameBody: ({ service }) => `Nur der Name in Happier ändert sich. ${service} behält seinen eigenen Namen für das Konto.`,
    identityHidden: 'E-Mail oder ID ausgeblendet',
};

const connectedServicesCollectionTranslations = { de };

return { connectedServicesCollectionTranslations };
})();

const Domain_connectedServicesPoolTranslations = (() => {
type ConnectedServicesPoolCopy = Shared_connectedServicesPoolTranslations.ConnectedServicesPoolCopy;

const en = Shared_connectedServicesPoolTranslations.en;

const de: ConnectedServicesPoolCopy = {
    strategyExpiryFirst: "Früher ablaufend",
    strategyExpiryFirstDescription: "Bevorzuge genügend Kontingent mit früherem Reset des langen Zeitfensters oder früherem Ende eines nicht verlängernden Abos.",
    leadExpiryFirst: "Früher ablaufend zuerst.",
    membersOn: ({ service, on, total }) => `${service} · ${on} von ${total} Mitgliedern aktiv`,
    rename: 'Umbenennen',
    moreActions: 'Weitere Aktionen',
    defaultFor: ({ agent }) => `Standard für ${agent}`,
    defaultForMore: ({ agent, count }) => `Standard für ${agent} +${count}`,
    makeDefault: 'Als Standard festlegen',
    makeDefaultA11y: 'Als Standard für einen Agenten festlegen',
    usingSince: ({ name, time }) => `${name} in Verwendung seit ${time}`,
    using: ({ name }) => `${name} in Verwendung`,
    noActive: 'Noch kein Mitglied in Verwendung',
    noActiveDetail: 'Der Pool wählt eines, wenn eine Sitzung startet.',
    leadLeastLimited: 'Am wenigsten begrenzt zuerst.',
    leadInOrder: 'Der Reihe nach.',
    fallbackOff: ({ name }) => `Automatischer Wechsel ist aus, Sitzungen bleiben bei ${name}, wenn es aufgebraucht ist.`,
    manualStays: ({ name }) => `Manuell: Der Pool bleibt bei ${name}, bis du ein anderes Mitglied wählst.`,
    switchTo: ({ name }) => `Zu ${name} wechseln`,
    onlyOneOn: ({ name }) => `Nur ${name} ist aktiv, es gibt also keinen Ausweich.`,
    turnOn: ({ name }) => `${name} aktivieren`,
    allWaitingTitle: 'Alle Mitglieder warten auf ein Zurücksetzen',
    allWaitingFirst: ({ name, time, countdown }) => `${name} wird zuerst zurückgesetzt, um ${time} (${countdown}).`,
    sessionsWait: 'Sitzungen warten und laufen dann von selbst weiter.',
    sessionsStop: 'Sitzungen halten an, bis ein Mitglied Spielraum hat.',
    leftTitle: 'Übrig im Pool',
    leftDescription: 'Der Durchschnitt der aktiven Mitglieder; jedes wird für sich zurückgesetzt.',
    roomCount: ({ count, total }) => `${count} von ${total} haben gerade Spielraum`,
    notReported: ({ count }) => count === 1 ? '1 ohne Angaben' : `${count} ohne Angaben`,
    nothingReported: 'Noch kein aktives Mitglied meldet seine Limits.',
    membersTitle: 'Mitglieder',
    membersDescription: 'Ziehen, um die Reihenfolge festzulegen. Das ausgewählte Mitglied ist das aktive; ein ausgeschaltetes wird übersprungen.',
    membersCompactDescription: 'Gedrückt halten und ziehen, um neu zu ordnen.',
    manage: 'Verwalten',
    connectAnotherAccount: ({ service }) => `Weiteres ${service}-Konto verbinden`,
    membersSelectionSummary: ({ count, total, service }) => `${count} von ${total} ${service}-Konten`,
    manageMembers: 'Mitglieder verwalten',
    searchAccounts: ({ service }) => `${service}-Konten suchen`,
    active: 'Aktiv',
    offNotUsed: 'Wird vom Pool nicht genutzt, solange es aus ist',
    autoOffModel: 'Automatisch ausgeschaltet · dieser Tarif kann das gewählte Modell nicht nutzen',
    checkedAt: ({ time }) => `Geprüft ${time}`,
    makeActiveA11y: ({ name }) => `${name} zum aktiven Mitglied machen`,
    memberOnA11y: ({ name }) => `${name} in diesem Pool verwenden`,
    openA11y: ({ name }) => `${name} öffnen`,
    dragA11y: 'Zum Umsortieren ziehen',
    behaviorTitle: 'Verhalten',
    strategyTitle: 'Auswahlstrategie',
    strategyLeastLimited: 'Am wenigsten begrenzt',
    strategyInOrder: 'Der Reihe nach',
    strategyManual: 'Manuell',
    strategyLeastLimitedDescription: 'Das Mitglied mit dem meisten nutzbaren Kontingent bevorzugen.',
    strategyInOrderDescription: 'Mitglieder in der obigen Reihenfolge versuchen.',
    strategyManualDescription: 'Nur das aktive Mitglied verwenden, bis du es änderst.',
    fallbackTitle: 'Automatischer Wechsel',
    fallbackDescription: 'Zu einem anderen Mitglied wechseln, wenn das aktive Konto wiederhergestellt werden muss.',
    switchEarlyTitle: 'Früher wechseln',
    switchEarlyDescription: 'Prozent übrig, unter dem der Pool zu einem Mitglied mit frischerem Kontingent wechselt. 0 schaltet es aus.',
    autoResetsTitle: 'Kontingent-Zurücksetzungen automatisch nutzen',
    autoResetsDescription: 'Ein gespeichertes Zurücksetzen nur nutzen, wenn kein Mitglied bereit ist.',
    autoOffTitle: 'Konten ausschalten, die das gewählte Modell nicht nutzen können',
    autoOffDescription: 'Du kannst sie selbst wieder einschalten.',
    advancedTitle: 'Erweitert',
    advancedCount: ({ count }) => `${count} Einstellungen`,
    restoreFirstTitle: 'Zum ersten Mitglied zurück, wenn es zurückgesetzt wird',
    restoreFirstDescription: 'Nach einem Wechsel zum zuerst eingeordneten Mitglied zurückkehren, sobald sein Limit zurückgesetzt ist.',
    switchWhenTitle: 'Wechseln bei',
    switchWhenDescription: 'Ereignisse, die den Pool zum nächsten Mitglied bewegen.',
    staleAfterTitle: 'Veraltete Nutzung prüfen nach',
    staleAfterDescription: 'Minuten. Den Anbieter erneut fragen, wenn die Nutzung älter ist, bevor ein Mitglied gewählt wird.',
    switchesPerTurnTitle: 'Automatische Wechsel pro Zug',
    switchesPerHourTitle: 'Automatische Wechsel pro Sitzungsstunde',
    switchLimitsDescription: 'Verhindert, dass ein Pool zwischen Mitgliedern hin und her springt.',
    recoveryTitle: 'Wenn ein Limit eine Sitzung stoppt',
    recoveryDescription: 'Was der Pool für die wartende Sitzung tut.',
    recoveryPromptsTitle: 'Fortsetzungsnachrichten',
    recoveryPromptsDescription: 'Happier sendet seine Standardnachricht, wenn es eine Sitzung nach einem Wechsel oder Zurücksetzen fortsetzt.',
    usedByTitle: 'Verwendet von',
    usedByDefault: 'Standard · neue Sitzungen melden sich über diesen Pool an',
    usedByNone: 'Noch kein Agent meldet sich standardmäßig über diesen Pool an.',
    deleteNote: ({ agents }) => `Mitglieder bleiben verbunden. ${agents} nutzt wieder die eigene Anmeldung, bis du einen anderen Standard wählst.`,
    deleteNoteNoAgent: 'Mitglieder bleiben verbunden.',
    emptyTitle: 'Füge die Konten hinzu, zwischen denen gewechselt wird',
    emptyReason: ({ service }) => `Ein Pool wählt ein Konto, wenn eine Sitzung startet, und wechselt, wenn es aufgebraucht ist. Füge mindestens zwei ${service}-Konten hinzu.`,
    usageNotAnswering: ({ service }) => `${service} hat nicht geantwortet`,
    newPoolTitle: 'Neuer Pool',
    newPoolDescription: ({ service }) => `${service}-Konten, zwischen denen ein Agent wechselt.`,
    nameTitle: 'Name',
    namePlaceholder: 'Arbeits-Pool',
    draftMembersDescription: 'Wähle die Konten, zwischen denen gewechselt wird. Du kannst sie später ändern.',
    create: 'Pool erstellen',
    discard: 'Verwerfen',
};

const connectedServicesPoolTranslations = { de };

return { connectedServicesPoolTranslations };
})();

const Domain_connectedServicesSettingsTranslations = (() => {
type ConnectedServicesSettingsCopy = Shared_connectedServicesSettingsTranslations.ConnectedServicesSettingsCopy;

const setupFidelityCopy = Shared_connectedServicesSettingsTranslations.setupFidelityCopy;

const en = Shared_connectedServicesSettingsTranslations.en;

const de: ConnectedServicesSettingsCopy = {
    ...setupFidelityCopy,
    accountCount: ({ count }) => count === 1 ? '1 Konto' : `${count} Konten`,
    defaultAccount: ({ name }) => `Standard: ${name}`,
    poolCount: ({ count }) => count === 1 ? '1 Pool' : `${count} Pools`,
    noAccountsYet: 'Noch keine Konten',
    needsSignIn: 'Anmeldung nötig',
    signInAgain: 'Erneut anmelden',
    addAccount: 'Konto hinzufügen',
    connectAnotherTitle: 'Weiteren Dienst verbinden',
    connectFirstTitle: 'Dienst verbinden',
    connectNames: ({ names }) => `${names}.`,
    connectNamesMore: ({ names, count }) => `${names} und ${count} weitere.`,
    connect: 'Verbinden',
    emptyTitle: 'Noch keine Dienste zum Verbinden',
    servicesTitle: 'Dienste',
    emptyNoServiceOnMachine: ({ machine }: { machine: string }) => `Noch kein Agent auf ${machine} bietet einen Dienst zur Anmeldung an. Agenten, die ein Abonnement nutzen, fügen ihren hier hinzu.`,
    emptyNoMachineOnline: 'Keines deiner Geräte ist online. Dienste erscheinen, sobald eines online ist, aus den Agenten, die darauf laufen.',
    emptyOpenAgents: 'Agenten öffnen',
    emptyAction: 'Maschinen öffnen',
    projectionErrorTitle: 'Dienste konnten nicht von deinen Maschinen geladen werden',
    projectionErrorDescription: 'Deine Konten bleiben aufgelistet. Dienste, die du hinzufügen kannst, erscheinen, sobald eine Maschine antwortet.',
    loadingServices: 'Suche nach Diensten auf deinen Maschinen…',
    usageTitle: 'Wie Konten verwendet werden',
    usageDescription: 'Mit welchem Konto sich jeder Agent beim Start einer Sitzung anmeldet und was Sitzungen teilen.',
    sharingTitle: 'Zustandsfreigabe',
    sharingSummary: ({ config, state }) => `${config} · ${state}`,
    configLinkedShort: 'Verknüpft',
    configCopiedShort: 'Kopiert',
    configIsolatedShort: 'Isoliert',
    stateSharedShort: 'Sitzungen geteilt',
    stateIsolatedShort: 'Sitzungen getrennt',
    perAgentTitle: 'Freigabe pro Agent',
    perAgentDescription: 'Diese Standards für einen Agenten überschreiben.',
    perAgentPurpose: 'Lege pro Agent fest, was Sitzungen mit verbundenen Konten mit deiner eigenen Anmeldung teilen.',
    servicePurpose: ({ service }) => `Die Konten, mit denen du dich bei ${service} anmeldest, und die Pools, die sie teilen.`,
    chooseMachineTitle: 'Maschine auswählen',
    chooseMachineDescription: 'Konten hinzufügen, anmelden und entfernen läuft auf einer deiner Maschinen. Deine Konten bleiben unter Verbundene Dienste aufgelistet.',
    newAccountTitle: 'Neues Konto',
    newAccountDescription: 'Wähle, wie du dich anmeldest.',
    newAccountInProgress: 'Schließe die Anmeldung unten ab.',
    modeBrowser: 'Mit einem Browser anmelden',
    modeDeviceCode: 'Mit einem Code anmelden',
    modeManual: 'Token eingeben',
    serviceSettingsTitle: 'Diensteinstellungen',
    serviceSettingsDescription: 'Einstellungen, mit denen sich jedes Konto dieses Dienstes anmeldet.',
    noAccountsDescription: 'Füge ein Konto hinzu, damit sich deine Agenten damit anmelden können.',
    accountDetailsTitle: 'Kontodetails',
    poolEmptyTitle: 'Konten zu diesem Pool hinzufügen',
    poolEmptyDescription: 'Ein Pool verschiebt Sitzungen zum nächsten Konto, wenn eines sein Limit erreicht. Wähle seine Konten unten aus.',
    agentDefaultsTitle: 'Standardkonto pro Agent',
    agentDefaultsDescription: 'Das Konto, mit dem sich jeder Agent beim Start einer Sitzung anmeldet.',
    agentDefaultsKeywords: 'Standardkonto',
    namesAnd: ({ names, last }) => `${names} und ${last}`,
    usedBy: ({ names }) => `Genutzt von ${names}`,
    poolRuleMostLeft: 'nutzt das mit dem meisten Rest',
    poolRuleInOrder: 'nutzt sie der Reihe nach',
    poolRuleManual: 'du wechselst selbst',
    poolInUse: ({ pool }) => `${pool} · aktiv`,
    agentDefault: ({ agent }) => `Standard für ${agent}`,
    signedOutBy: ({ service }) => `Von ${service} abgemeldet`,
    usageReadFailed: 'Nutzung nicht lesbar',
    usageWindowPin: ({ meter }: { meter: string }) => `${meter} neben dem Composer anzeigen`,
    noLimitsBilledPerUse: 'Keine Limits gemeldet · Abrechnung nach Nutzung',
    needsYouCount: ({ count }) => `${count} braucht dich`,
    connectToolsTitle: 'Code-Host oder Werkzeug verbinden',
    inviteTitle: ({ names }) => `Deine Agenten können auch ${names} nutzen`,
    inviteWhoOne: ({ agents }) => `${agents} kann sich damit anmelden.`,
    inviteWhoMany: ({ agents }) => `${agents} können sich damit anmelden.`,
    inviteTools: 'Oder verbinde einen Code-Host und Werkzeuge.',
    firstRunTitle: 'Nutze die Abos, die du schon bezahlst',
    firstRunPromise: 'Verbinde dein Claude- oder ChatGPT-Konto einmal. Deine Agenten nutzen es auf jeder Maschine, und Happier zeigt, wie viel übrig ist, bevor du ein Limit erreichst.',
    connectAnAccount: 'Konto verbinden',
    firstRunMeanwhile: 'Bis dahin nutzt jeder Agent auf jeder Maschine seine eigene Anmeldung.',
    agentAccountsTitle: 'Agenten-Konten',
    agentAccountsDescription: 'Abos und Schlüssel, die deine Agenten nutzen. In deinem Konto gespeichert, damit jede Maschine sie nutzen kann.',
    codeAndToolsTitle: 'Code und Werkzeuge',
    setupChooseMachine: 'Wähle eine Maschine für die Anmeldung. Danach funktioniert das Konto auf all deinen Maschinen.',
    setupHowToSignIn: 'Wie du dich anmeldest',
    setupRecommendedMethod: ({ method }) => `${method} · Empfohlen`,
    setupCatalogTitle: 'Dienst verbinden',
    setupCatalogPurpose: 'Die Anmeldung läuft auf der Maschine deiner Wahl. Danach funktioniert das Konto auf all deinen Maschinen.',
    setupServiceTitle: ({ service }) => `${service} verbinden`,
    setupReconnectTitle: ({ service }) => `Erneut bei ${service} anmelden`,
    setupServicePurpose: ({ agents, service }) => `${agents} nutzen dein ${service}-Konto auf jeder Maschine.`,
    setupServicePurposeNoAgents: 'Das Konto funktioniert auf jeder Maschine.',
    setupForYourAgents: 'Für deine Agenten',
    setupOwnLoginTitle: 'Auf einer Maschine angemeldet?',
    setupOwnLoginBody: 'Nutze weiter die eigene Anmeldung des Agenten. Wähle sie unter „Wie Konten genutzt werden“.',
    setupToolsTitle: 'Code-Hosts und Werkzeuge',
    setupProvidersPointer: 'Modellanbieter wie OpenRouter und Ollama richtest du unter Anbieter ein.',
    setupOpenProviders: 'Anbieter öffnen',
    setupTrust: 'In deinem Konto gespeichert und nur von deinen Maschinen genutzt. Happier hält die Anmeldung für dich frisch.',
    setupConnectedCount: ({ count }) => `${count} verbunden`,
    settleConnectedAs: ({ identity }) => `Gerade verbunden als ${identity}.`,
    settleConnected: 'Gerade verbunden.',
    settleUseFor: ({ agent }) => `Für ${agent} nutzen?`,
    settleUseForAction: ({ agent }) => `Für ${agent} nutzen`,
    notNow: 'Nicht jetzt',
    homeInvitePromise: 'Verbinde Claude oder ChatGPT einmal. Jede Maschine kann es nutzen, und hier siehst du, wie viel übrig ist.',
    homeInviteHide: 'Ausblenden',
    homeNextWho: ({ agents }) => `${agents} kann es auch nutzen`,
    oauthStepOpen: 'Öffne die Anmeldeseite im Browser',
    oauthStepApprove: 'Bestätige und kopiere den angezeigten Code (oder die Adresse, auf der du landest)',
    oauthStepPaste: 'Hier einfügen',
    oauthPastePlaceholder: 'Code oder Adresse einfügen',
    oauthShapeOk: 'Sieht nach einem Anmeldecode aus',
    deviceEnterAt: ({ where }) => `Gib diesen Code auf ${where} ein`,
    deviceExpired: 'Der Code ist abgelaufen. Nichts wurde gespeichert.',
    deviceExpiresIn: ({ time }) => `Code läuft in ${time} ab`,
    deviceNewCode: 'Neuen Code holen',
    detailSignedOutTitle: ({ service }) => `${service} hat dieses Konto abgemeldet`,
    detailSignedOutBody: 'Die Anmeldung wurde widerrufen oder geändert, etwa nach einer Passwortänderung. Sitzungen können das Konto erst wieder nutzen, wenn du dich erneut anmeldest.',
    detailSignInTitle: 'Anmeldung',
    detailSignInNeeded: 'Neue Anmeldung nötig',
    detailSignInKeptFresh: 'Happier hält sie aktuell',
    detailLastUsed: ({ time }) => `zuletzt genutzt ${time}`,
    detailLeavePool: ({ pool }) => `Aus ${pool} entfernen…`,
    detailRemovePooledNote: ({ pool }) => `${pool} nutzt dieses Konto; entferne es zuerst aus dem Pool. Entfernen löscht es aus deinem Konto und von jeder Maschine.`,
    detailUsageSignedOut: 'Zuletzt bekannt · ohne Anmeldung keine Aktualisierung',
    detailUsageSignedOutAt: ({ time }: { time: string }) => `Zuletzt bekannt um ${time} · ohne Anmeldung keine Aktualisierung`,
    detailResetsIn: ({ countdown }) => `in ${countdown}`,
    detailUsedByTitle: 'Genutzt von',
    detailUsedByDefault: 'Sein Standardkonto',
    detailUsedByPool: ({ pool }) => `Über ${pool}`,
    detailUsedByPoolInUse: ({ pool }) => `Über ${pool} · gerade aktiv`,
    detailUsedByCould: 'Können es nutzen · melden sich heute selbst an',
    detailWorksOnTitle: 'Funktioniert auf',
    detailWorksOnDescription: 'In deinem Konto gespeichert. Eine Maschine nutzt es, wenn dort eine Sitzung startet; vorab wird nichts kopiert.',
    detailSignedInWithCode: 'Mit einem Code angemeldet',
    detailSignedInWithBrowser: 'Mit dem Browser angemeldet',
    detailAddedWithKey: 'Mit einem Schlüssel hinzugefügt',
    nearLimitTitle: ({ account, percent, window }) => `${account} hat noch ${percent} % des ${window}-Limits`,
    nearLimitTitleNoAccount: ({ percent, window }) => `Noch ${percent} % des ${window}-Limits`,
    nearLimitBodyWithReset: ({ time }) => `Es wird um ${time} zurückgesetzt. Wende einen Nutzungs-Reset an, um jetzt weiterzumachen.`,
    nearLimitBody: 'Wende einen Nutzungs-Reset an, um jetzt weiterzumachen.',
    nearLimitApplyReset: 'Nutzungs-Reset anwenden',
    catalogSignInBrowserOrCode: 'Anmeldung per Browser oder Code',
    catalogSignInBrowserOrKey: 'Anmeldung per Browser oder Token einfügen',
    catalogSignInBrowser: 'Anmeldung per Browser',
    catalogSignInCode: 'Anmeldung per Code',
    catalogPasteKey: 'Schlüssel einfügen',
    deviceOpenService: ({ service }) => `${service} öffnen`,
    deviceWaitingFor: ({ service }) => `Warte auf deine Bestätigung in ${service}…`,
};

const connectedServicesSettingsTranslations = { de };

return { connectedServicesSettingsTranslations };
})();

const Domain_connectedServicesSetupTranslations = (() => {
type ConnectedServicesSetupTranslation = Shared_connectedServicesSetupTranslations.ConnectedServicesSetupTranslation;

const connectedServicesSetupTranslations = { de: {
        connectMoreTitle: 'Mehr verbinden',
        connectMoreDescription: 'Dienste, die die Agenten auf deinen Maschinen akzeptieren und die du noch nicht verbunden hast.',
        connectMoreNothingNew: 'Füge ein weiteres Konto, einen Code-Host oder ein Tool hinzu.',
        serviceSignInInstead: ({ agents }) => `${agents} kann sich damit anmelden statt mit der Anmeldung jeder Maschine.`,
        serviceCanUse: ({ agents }) => `${agents} kann ihn verwenden.`,
        moreServicesTitle: 'Weitere Dienste',
        moreServicesTools: ({ names }) => `${names} und mehr, für Code und Tools.`,
        moreServicesAll: 'Alles, was deine Agenten und Tools akzeptieren.',
        browse: 'Durchsuchen',
        notNow: ({ service }) => `Nicht jetzt: ${service}`,
        notNowTooltip: 'Nicht jetzt · bleibt unter Durchsuchen',
        back: 'Alle Dienste',
        homeCatalogTitle: 'Konto verbinden',
        homeCatalogPurpose: 'Deine Agenten nutzen es auf jeder Maschine, und Home zeigt, was übrig ist.',
        homeNextSubtitle: ({ agents }) => `${agents} kann es statt der Anmeldung jeder Maschine verwenden.`,
        firstRunMore: 'API-Schlüssel, Code-Hosts und Tools',
        settleAddToPoolWhy: ({ pool, agent, active }) => `Zu ${pool} hinzufügen, damit ${agent} dorthin wechselt, wenn ${active} aufgebraucht ist?`,
        settleAddToPoolShort: ({ pool }) => `Zu ${pool} hinzufügen?`,
        settleAddToPool: ({ pool }) => `Zu ${pool} hinzufügen`,
        deviceStepCopy: 'Diesen Code kopieren',
        deviceStepOpen: ({ service }) => `${service} öffnen und ihn eingeben`,
        deviceStepOpenWhere: ({ where }) => `${where}, angemeldet mit dem Konto, das du verwenden willst`,
        deviceStepApprove: ({ service }) => `Happier in ${service} freigeben`,
        deviceCheckNow: 'Jetzt prüfen',
    } } satisfies Pick<Readonly<Record<string, ConnectedServicesSetupTranslation>>, "de">;

return { connectedServicesSetupTranslations };
})();

const Domain_detailPageTranslations = (() => {
type DetailPageTranslations = Shared_detailPageTranslations.DetailPageTranslations;

const detailPageTranslations = { de: {
        approval: {
            requestTitle: 'Anfrage',
            requestDescription: 'Was angefragt wurde und wie der Stand ist.',
            failureTitle: 'Warum es fehlgeschlagen ist',
            homeUnavailableTitle: 'Home nicht verfügbar',
            contextTitle: 'Angefragt von',
            contextDescription: 'Die Sitzung und der Agent, die dies angefragt haben.',
            sessionOnHome: ({ home }) => `Eine Sitzung auf ${home}`,
            sessionElsewhere: 'Eine Sitzung, die nicht auf diesem Gerät ist',
            origin: {
                voice: 'Per Sprache angefragt',
                agent: 'Von einem Agenten angefragt',
                mcp: 'Über ein verbundenes Tool angefragt',
                cli: 'Über die Befehlszeile angefragt',
                ui: 'In der App angefragt',
                api: 'Über die API angefragt',
                plugin: 'Von einem Plugin angefragt',
                system: 'Von Happier angefragt',
            },
            proposalsDescription: 'Werden im Review veröffentlicht, wenn du zustimmst.',
        },
        runs: {
            description: 'Hintergrundläufe auf deinen Maschinen.',
            filterLabel: 'Angezeigte Läufe',
            filterRunning: 'Aktiv',
            filterAll: 'Alle',
            onHome: ({ home }) => `Auf ${home}`,
        },
        person: {
            placeholderTitle: 'Person',
            friendshipTitle: 'Freundschaft',
            sharedSessionsDescription: 'Sitzungen, die diese Person mit dir teilt, nur lesend.',
            linkedAccountsTitle: 'Verknüpfte Konten',
            linkedAccountsDescription: 'Wo sie sich sonst anmeldet. Öffnet sich im Browser.',
        },
        friendsManage: {
            description: 'Menschen, mit denen du auf Happier arbeitest, und Anfragen zwischen euch.',
            requestsTitle: 'Freundschaftsanfragen',
            requestsDescription: 'Öffne eine Anfrage, um sie anzunehmen oder abzulehnen.',
            sentTitle: 'Gesendete Anfragen',
            sentDescription: 'Warten auf ihre Zustimmung.',
            friendsTitle: 'Freunde',
            friendsDescription: 'Öffne einen Freund, um zu sehen, was er mit dir teilt.',
        },
    } } as const satisfies Pick<Record<string, DetailPageTranslations>, "de">;

return { detailPageTranslations };
})();

const Domain_detailsChromeTranslations = (() => {
type DetailsChromeTranslations = Shared_detailsChromeTranslations.DetailsChromeTranslations;

const detailsChromeTranslations = { de: {
        closeUnsavedTabA11y: 'Tab schließen, ungespeicherte Änderungen',
        emptyTitle: 'Dateien, Änderungen und Commits öffnen sich hier',
        browseFiles: 'Dateien durchsuchen',
        previewHint: 'Ein Klick öffnet eine Vorschau; öffne sie erneut, um sie zu behalten.',
        emptyReason: 'Dateien, Änderungen und Commits, die du öffnest, erscheinen hier – neben der Stelle, von der aus du sie geöffnet hast.',
        reviewChanges: ({ count }) => (count === 1 ? '1 Änderung prüfen' : `${count} Änderungen prüfen`),
        reviewChangesReason: ({ count }) => (count === 1
            ? 'In dieser Sitzung wurde 1 Datei geändert. Lies sie hier, ohne das Gespräch zu verlassen.'
            : `In dieser Sitzung wurden ${count} Dateien geändert. Lies sie hier, ohne das Gespräch zu verlassen.`),
        splitNeedsWiderPane: 'Nebeneinander braucht einen breiteren Bereich. Verbreitere Details oder nutze Fokus.',
    } } satisfies Pick<Record<string, DetailsChromeTranslations>, "de">;

return { detailsChromeTranslations };
})();

const Domain_detailsFileTranslations = (() => {
type DetailsFileTranslations = Shared_detailsFileTranslations.DetailsFileTranslations;

const detailsFileTranslations = { de: {
        areaUnstaged: 'Nicht vorgemerkt',
        areaStaged: 'Vorgemerkt',
        areaBoth: 'Beide',
        areaLabel: 'Änderungen',
        preview: 'Vorschau',
        viewLabel: 'Ansicht',
        compare: 'Vergleichen',
        stage: 'Vormerken',
        unstage: 'Nicht mehr vormerken',
        addToCommit: 'Zum Commit hinzufügen',
        removeFromCommit: 'Aus dem Commit entfernen',
        editing: 'Wird bearbeitet',
        editingUnsaved: 'Wird bearbeitet · ungespeicherte Änderungen',
        statusModified: 'Geändert',
        statusAdded: 'Hinzugefügt',
        statusDeleted: 'Gelöscht',
        statusRenamed: 'Umbenannt',
        statusCopied: 'Kopiert',
        statusUntracked: 'Neu, noch nicht verfolgt',
        statusConflicted: 'Hat Konflikte',
        noChanges: 'Keine Änderungen',
        lines: ({ count }) => (count === 1 ? '1 Zeile' : `${count} Zeilen`),
    } } satisfies Pick<Record<string, DetailsFileTranslations>, "de">;

return { detailsFileTranslations };
})();

const Domain_detailsHistoryTranslations = (() => {
type Count = Shared_detailsHistoryTranslations.Count;

type Branch = Shared_detailsHistoryTranslations.Branch;

type Folder = Shared_detailsHistoryTranslations.Folder;

type DetailsHistoryTranslations = Shared_detailsHistoryTranslations.DetailsHistoryTranslations;

const detailsHistoryTranslations = { de: {
        copyCommitSha: 'Commit-SHA kopieren',
        filesChanged: ({ count }) => (count === 1 ? '1 Datei geändert' : `${count} Dateien geändert`),
        files: ({ count }) => (count === 1 ? '1 Datei' : `${count} Dateien`),
        revertEllipsis: 'Zurücknehmen…',
        stashKeptOn: ({ branch }) => `Aufbewahrt auf ${branch}`,
        stashOriginBranch: ({ branch }) => `Gespeichert, als du ${branch} verlassen hast`,
        stashOriginBranchShort: 'Beim Wechsel des Branches',
        stashOriginTransient: 'Von Happier gespeichert',
        stashOriginUnmanaged: 'Außerhalb von Happier erstellt',
        stashRestoreExplains: ({ folder }) => `Wiederherstellen bringt diese Änderungen zurück nach ${folder} und entfernt den Stash. Sonst ändert sich nichts im Ordner.`,
        stashApply: 'Anwenden',
        stashApplyA11y: 'Diese Änderungen anwenden und den Stash behalten',
        stashDiscardEllipsis: 'Verwerfen…',
        stashSwitcherA11y: 'Stash auswählen',
        stashCount: ({ count }) => (count === 1 ? '1 Stash' : `${count} Stashes`),
    } } satisfies Pick<Record<string, DetailsHistoryTranslations>, "de">;

return { detailsHistoryTranslations };
})();

const Domain_detailsReviewTranslations = (() => {
type Count = Shared_detailsReviewTranslations.Count;

type DetailsReviewTranslations = Shared_detailsReviewTranslations.DetailsReviewTranslations;

const detailsReviewTranslations = { de: {
        title: 'Prüfen',
        files: ({ count }) => (count === 1 ? `1 Datei` : `${count} Dateien`),
        nextCommit: ({ count }) => `${count} im nächsten Commit`,
        changedFiles: 'Geänderte Dateien',
        commitColumn: 'Commit',
        jumpA11y: 'Zu einer Datei springen',
        comments: ({ count }) => (count === 1 ? `1 Kommentar` : `${count} Kommentare`),
        goesWithNext: ({ count }) => (count === 1 ? `geht mit deiner nächsten Nachricht mit` : `gehen mit deiner nächsten Nachricht mit`),
        askForChanges: 'Änderungen anfragen',
        detachCommentA11y: 'Diesen Kommentar aus der nächsten Nachricht herausnehmen',
        trayExpandedHint: 'Sie gehen mit deiner nächsten Nachricht an den Agenten.',
        askPlaceholder: 'Sag dem Agenten, was er ändern soll…',
        send: 'Senden',
        draftAuthor: 'Du', draftStatus: 'Entwurf', includeComment: 'Geht mit deiner nächsten Nachricht mit',
    } } satisfies Pick<Record<string, DetailsReviewTranslations>, "de">;

return { detailsReviewTranslations };
})();

const Domain_embedSettingsTranslations = (() => {
const english = Shared_embedSettingsTranslations.english;

const translated = Shared_embedSettingsTranslations.translated;

const embedSettingsTranslations = { de: translated({
        settingsEmbeds: {
            title: "Einbettungen",
            newTitle: "Neue Einbettung",
            purpose: "Lass andere Apps Happier-Chats anzeigen, nur mit dem Zugriff, den du wählst.",
            yourEmbeds: "Deine Einbettungen",
            newEmbed: "Neue Einbettung",
            listError: "Einbettungen konnten nicht geladen werden",
            emptyTitle: "Bring einen Happier-Chat in deine eigene App",
            emptyBody: "Deine App zeigt echte Unterhaltungen, nur mit dem Zugriff, den du wählst: welche Websites, wer senden oder freigeben darf und welche Modelle.",
            createDescription: "Lege fest, was andere Apps mit deinen Chats tun dürfen und wie sie aussehen.",
            name: "Name",
            nameDescription: "Nur für dich sichtbar, in dieser Liste.",
            namePlaceholder: "Zum Beispiel Lead-Dashboard",
            create: "Einbettung erstellen",
            summary: {
                sites: ({ count }: { count: number }) => count === 1 ? '1 Website' : `${count} Websites`,
                send: "Darf senden",
                sendAndApprove: "Darf senden und freigeben",
                approve: "Darf freigeben",
                viewOnly: "Nur ansehen",
                modelOnly: ({ name }: { name: string }) => `nur ${name}`,
                models: ({ count }: { count: number }) => count === 1 ? '1 Modell' : `${count} Modelle`,
            },
            sites: {
                title: "Wo sie erscheinen darf",
                description: "Chats öffnen sich nur auf diesen Websites.",
            },
            capabilities: {
                title: "Was Personen tun können",
                view: "Unterhaltung ansehen",
                always: "Immer",
                send: "Nachrichten senden",
                sendDescription: "Umfasst das Stoppen des Agenten und das Anhängen von Dateien.",
                changeModel: "Modell wechseln",
                permissionModes: "Berechtigungsmodi",
                permissionModesDescription: "Chats zeigen eine Modusauswahl nur, wenn mehr als ein Modus erlaubt ist.",
                anyMode: "Jeder Modus",
                anyModeDescription: "Personen können ändern, wie viel der Agent ohne Nachfrage tut.",
                modeOnly: ({ name }: { name: string }) => `nur ${name}`,
                modes: ({ count }: { count: number }) => `${count} Modi`,
                approveOn: "Personen auf diesen Websites können Werkzeugnutzung und Anfragen in diesen Chats freigeben.",
            },
            models: {
                title: "Modelle",
                description: "Andere Modelle werden abgelehnt, nicht nur ausgeblendet. Chats starten mit dem ersten erlaubten Modell.",
                allowed: "Erlaubte Modelle",
                any: "Jedes Modell",
            },
            organization: {
                title: "Organisation",
                description: "Deine App listet die Chats dieser Einbettung von hier (mit einem dieser Tags). Neue Chats landen ebenfalls hier.",
                folder: "Ordner",
                tags: "Tags",
                none: "Keine",
            },
            composer: {
                title: "Eingabe",
                attachments: "Anhänge",
                attachmentsDescription: "Blendet die Anhängen-Schaltfläche aus. Wer senden darf, kann Dateien weiterhin über die API anhängen.",
            },
            sessions: {
                title: "Sitzungen",
                description: "Sitzungen, die dieser Schlüssel von deinem Server oder im Chat erstellt, laufen auf diesem Computer mit diesem Agenten und landen im Ordner und in den Tags oben.",
                allow: "Diesem Schlüssel erlauben, Sitzungen zu erstellen",
                offConsequence: "Dieser Schlüssel kann keine Sitzungen erstellen. Deine App kann nur bestehende Chats anzeigen.",
                computer: "Computer",
                agent: "Agent",
                newChat: "Neue Chats in der Einbettung starten",
                appSetting: "Für deine App",
                newChatDescription: "Zeigt eine Eingabe für einen neuen Chat, wenn deine App die Einbettung ohne Chat öffnet. Das ist eine Einstellung für deine App, keine Sicherheitsgrenze: Dein Server kann mit diesem Schlüssel immer Chats erstellen.",
            },
            appearance: {
                title: "Darstellung",
                description: "Die Vorschau folgt jeder Änderung. Offene Chats passen sich ohne Neuladen an.",
                mode: "Modus",
                modeSystem: "System",
                modeLight: "Hell",
                modeDark: "Dunkel",
                theme: "Design",
                presetHappier: "Happier",
                colors: "Farben",
                colorsDefault: "Happier-Standard",
                colorsCustomized: ({ count }: { count: number }) => `${count} angepasst`,
                colorsFor: "Farben für",
                colorGroups: {
                    surface: "Flächen",
                    text: "Text",
                    accent: "Akzent",
                    messages: "Nachrichten",
                    composer: "Eingabe",
                    approvals: "Freigaben",
                },
                fontFamily: "Schriftfamilie",
                fontFamilyPlaceholder: "Happier-Standard",
                fontFile: "Schriftdatei",
                fontFileDescription: "Ein https-Link zu einer .woff2- oder .woff-Datei.",
                fontFileRefused: "Verwende einen Link zu einer .woff2- oder .woff-Datei, kein Stylesheet.",
                textSize: "Textgröße",
                textSizeCompact: "Kompakt",
                textSizeDefault: "Standard",
                textSizeLarge: "Groß",
                corners: "Ecken",
                cornersSharp: "Scharf",
                cornersSoft: "Weich",
                cornersRound: "Rund",
                density: "Dichte",
                densityCompact: "Kompakt",
                densityComfortable: "Bequem",
                reset: "Darstellung zurücksetzen",
            },
            preview: {
                title: "Live-Vorschau",
                phone: "Telefon",
                desktop: "Desktop",
                reduceMotion: "Bewegung reduzieren",
                note: "Der echte eingebettete Chat mit Beispielnachrichten. Hier wird nichts gesendet.",
                rowDescription: "Sieh dir den Chat mit diesen Einstellungen an.",
                unavailable: "Vorschau nicht verfügbar",
            },
            snippets: {
                title: "Code-Schnipsel",
                description: "Füge diese in deine App ein. Sie nutzen bereits die Einstellungen dieser Einbettung.",
                steps: "1 Schlüssel als HAPPIER_EMBED_KEY speichern · 2 canOpenSession schreiben: wer welchen Chat öffnen darf · 3 Chat anzeigen",
                backend: "Backend",
                react: "React",
            },
            detail: {
                created: ({ date }: { date: string }) => `Erstellt ${date}`,
                lastUsed: ({ date }: { date: string }) => `Zuletzt verwendet ${date}`,
                expires: ({ date }: { date: string }) => `Läuft ab ${date}`,
                reconnect: "Offene Chats verbinden sich mit dem neuen Zugriff neu. Entwürfe bleiben erhalten.",
                e2eeTrust: "Dieser Schlüssel kann die verschlüsselten Chats dieses Kontos lesen. Verwende ein eigenes Konto für deine App.",
                keyReach: "Der Schlüssel bleibt auf deinem Server und erreicht jeden Chat in diesem Konto. Browser sehen ihn nie: Sie erhalten kurzlebige Schlüssel, beschränkt auf die Chats, die dein Server erlaubt.",
                expiry: "Schlüssel läuft ab",
                expiryDescription: "Wenn der Schlüssel abläuft, öffnen sich keine Chats mehr. Er lässt sich später nicht verlängern.",
                encryptionChecking: "Verschlüsselung dieses Kontos wird geprüft …",
                encryptionUnavailable: "Dieses Gerät kann die verschlüsselten Chats dieses Kontos noch nicht lesen. Stelle deinen geheimen Schlüssel wieder her, um die Einbettung zu erstellen.",
                encryptionStale: "Die Schlüssel dieses Geräts für verschlüsselte Chats sind veraltet. Stelle deinen geheimen Schlüssel wieder her, um die Einbettung zu erstellen.",
                encryptionUnreadable: "Die Verschlüsselung dieses Kontos konnte nicht geprüft werden.",
                missingTitle: "Diese Einbettung gibt es nicht mehr",
                backToEmbeds: "Zurück zu Einbettungen",
            },
            delete: {
                button: "Einbettung löschen",
                title: ({ label }: { label: string }) => `„${label}“ löschen?`,
                body: "Offene Chats werden getrennt. Schlüssel, die bereits verschlüsselte Chats gelesen haben, lassen sich nicht zurückholen.",
                confirm: "Löschen",
            },
            reveal: {
                copyEnv: "Als .env-Zeile kopieren",
            },
        },
    }) };

return { embedSettingsTranslations };
})();

const Domain_embedTranslations = (() => {
const english = Shared_embedTranslations.english;

const translated = Shared_embedTranslations.translated;

const embedTranslations = { de: translated({
        embed: {
            errors: {
                originNotAllowed: 'Diese Seite darf diese Unterhaltung nicht anzeigen.',
                originNotAllowedReason: 'Füge diese Website in Happier zu den erlaubten Websites der Einbettung hinzu.',
                unavailable: 'Diese Unterhaltung ist hier nicht verfügbar.',
                encrypted: 'Diese Unterhaltung ist verschlüsselt und kann hier nicht geöffnet werden.',
                createNotGranted: 'Diese App kann keine neuen Chats starten.',
                unsupportedVersion: 'Dieser Chat braucht eine neuere Einbettung.',
                unsupportedVersionReason: 'Aktualisiere @happier-dev/embed in dieser App.',
            },
            nothingToShow: 'Noch nichts anzuzeigen',
            nothingToShowReason: 'Diese App hat noch keine Unterhaltung geöffnet.',
            reconnecting: 'Verbindung wird wiederhergestellt…',
            previewUnavailable: 'Vorschau nicht verfügbar',
            previewUser: "Analysiere diesen Lead und halte das Ergebnis fest: Acme Robotics, 40 Plätze, Evaluierung im 4. Quartal.",
            previewAgent: "Passt sehr gut. Das Budget ist bestätigt und der Champion entscheidet. Ich habe die Analyse festgehalten:",
            previewFollowUp: "Sollen wir diesen Lead auf qualifiziert setzen?",
        },
    }) };

return { embedTranslations };
})();

const Domain_entityDragDropTranslations = (() => {
type EntityDragDropTranslations = Shared_entityDragDropTranslations.EntityDragDropTranslations;

const en = Shared_entityDragDropTranslations.en;

const de: EntityDragDropTranslations = {
    files: { attach: "Anhängen", uploadHere: "Hier hochladen" },
    composer: { addContext: "Kontext hinzufügen", consequence: "Geht mit deiner nächsten Nachricht mit · noch wird nichts gesendet", target: "Eingabe", readOnly: "Diese Eingabe ist schreibgeschützt", otherWorkspace: "Gehört nicht zu diesem Arbeitsbereich", unavailable: "Diese Referenz ist nicht verfügbar" },
    surface: {
        scopeMismatch: 'Es ist in einem anderen Home oder Konto',
        widgetMoveUnavailable: 'Dieses Widget kann nicht auf diese Oberfläche verschoben werden',
        widgetReadOnly: 'Du kannst dieses Layout ansehen, aber nicht ändern. Bitte die Person, der es gehört, um Bearbeitungszugriff',
        widgetAlreadyHere: 'Es ist schon auf dieser Oberfläche. Ordne es dort neu an',
        widgetCantLiveHere: 'Dieses Widget kann auf dieser Oberfläche nicht liegen. Füge es hier über „Widget hinzufügen“ hinzu',
        widgetNeedsInputs: 'Seine Eingaben lassen sich hier nicht füllen. Füge es hier über „Widget hinzufügen“ hinzu und wähle sie',
        widgetLayoutChanged: 'Dieses Layout hat sich gerade geändert. Lege es noch einmal ab',
        readOnly: 'Dieses Board ist schreibgeschützt',
        copyDetail: 'Behält eine Referenz · das Board bleibt unverändert',
    },
    preview: {
        putUnder: ({ target }) => `Unter ${target} einordnen`,
        putUnderDetail: 'Berichtet an sie · beide laufen weiter',
        moveAbove: ({ target }) => `Über ${target} verschieben`,
        moveBelow: ({ target }) => `Unter ${target} verschieben`,
        orderDetail: 'Nur die Reihenfolge · niemand berichtet an jemanden',
        moveToFolder: ({ folder }) => `Nach ${folder} verschieben`,
        folderDetail: 'Nur der Ordner · berichtet an niemanden',
        moveToTopLevel: 'Auf die oberste Ebene verschieben',
        topLevelDetail: 'Aus dem Ordner · sonst ändert sich nichts',
        cantPutUnder: ({ target }) => `Kann nicht unter ${target} eingeordnet werden`,
        cantMoveHere: 'Kann nicht hierher verschoben werden',
        pendingPutUnder: ({ target }) => `Wird unter ${target} eingeordnet…`,
        pendingDetail: 'Warte auf die Bestätigung des Homes',
        unknownTitle: 'Nicht sicher, ob es verschoben wurde',
        unknownDetail: 'Prüfe die Liste gleich, bevor du es erneut versuchst',
    },
    settled: {
        refusedPutUnder: ({ item, target }) => `${item} konnte nicht unter ${target} eingeordnet werden`,
        refused: ({ verb }) => `${verb}: hat nicht geklappt`,
        unknown: ({ verb }) => `Unklar, ob „${verb}“ geklappt hat`,
        dismiss: 'Ausblenden',
    },
    reasons: {
        read: 'Sie ist nur lesend mit dir geteilt und kann keine Berichte annehmen',
        input: 'Du kannst ihr nichts senden, deshalb kann sie keine Berichte annehmen',
        pairwise: 'Diese beiden Sessions dürfen ihren Kontext nicht teilen',
        cycle: 'Diese Session berichtet bereits an diese hier',
        alreadyUnder: 'Sie berichtet bereits an diese',
        archived: 'Sie ist archiviert',
        differentHome: 'Sie ist in einem anderen Home. Sessions berichten innerhalb eines Homes',
        unavailable: 'Diese Session konnte gerade nicht geprüft werden',
        dateOrder: 'Diese Liste ist nach Datum sortiert. Wechsle zur eigenen Reihenfolge, um sie zu platzieren',
        noChange: 'Sie ist schon hier',
        descendantCycle: 'Ein Ordner kann nicht in sich selbst liegen',
        maxDepth: 'Die Ordner wären zu tief verschachtelt',
        foldersOff: 'Ordner sind für dieses Home ausgeschaltet',
        gone: 'Dieser Ort ist gerade verschwunden',
        generic: 'Dieser Ort kann das nicht aufnehmen',
    },
    chooser: { putUnderTitle: ({ item }) => `${item} einordnen unter…`, checking: 'Prüfe, welche Sitzungen Berichte annehmen können…', cantTakeReports: 'Können keine Berichte annehmen', unavailable: 'Nicht verfügbar' },
    keyboard: {
        choose: 'Ort wählen', putUnder: 'Einordnen', topLevel: 'Oberste Ebene', drop: 'Ablegen', cancel: 'Abbrechen', escapeKey: 'Esc',
        hintsA11y: 'Pfeiltasten wählen einen Ort, Eingabe legt ab, Escape bricht ab',
    },
    organize: { enter: 'Liste ordnen', title: 'Ordnen', done: 'Fertig', grip: ({ item }) => `${item} verschieben` },
    pane: {
        openHere: 'Hier als Tab öffnen',
        nextTo: ({ target }) => `Neben ${target} · nichts wird geschlossen`,
        nothingCloses: 'Öffnet als Tab · nichts wird geschlossen',
        tooNarrow: 'Dieser Bereich ist zu schmal zum Teilen',
        moveHere: 'Hierher als Tab verschieben',
        openBefore: ({ target }) => `Vor ${target} öffnen`,
        moveBefore: ({ target }) => `Vor ${target} verschieben`,
        placeOnly: 'Nur der Platz ändert sich',
        splitLeft: 'Links teilen',
        splitRight: 'Rechts teilen',
        splitUp: 'Oben teilen',
        splitDown: 'Unten teilen',
        opensBeside: ({ target }) => `Öffnet neben ${target}`,
        movesBeside: ({ target }) => `Wandert neben ${target}`,
        goTo: ({ target }) => `Zu ${target} wechseln`,
        openInThisPane: 'Schon in diesem Bereich offen · nichts Neues öffnet sich',
        openInAnotherPane: 'Schon in einem anderen Bereich offen · nichts Neues öffnet sich',
        alreadyHere: 'Schon hier',
        leaveIt: 'Loslassen, um es dort zu lassen',
        cantOpenHere: 'Kann hier nicht geöffnet werden',
        sessionsOnly: 'Dieser Bereich zeigt nur Sitzungen',
        otherWorkspace: 'Gehört nicht zu diesem Arbeitsbereich',
    },
};

const entityDragDropTranslations = { de };

return { entityDragDropTranslations };
})();

const Domain_eventAutomationComposerTranslations = (() => {
const english = Shared_eventAutomationComposerTranslations.english;

const eventAutomationComposerTranslations = { de: {
    eventAutomationComposer: {
        available: 'Verfügbar',
        payloadFields: 'PAYLOAD-FELDER',
        payloadSample: 'Beispiel-Payload',
        noFilterableFields: 'Dieses Ereignis gibt keine filterbaren Payload-Felder an.',
        addFilterClause: 'Bedingung hinzufügen',
        filterField: 'Filterfeld',
        filterOperator: 'Filteroperator',
        filterEquals: 'Ist gleich',
        filterOneOf: 'Ist eines von',
        filterValue: 'Filterwert',
        filterValuePlaceholder: '"value" oder ["value"]',
        storedContentUnavailableTitle: 'Gespeicherter Automations-Inhalt nicht verfügbar',
        storedContentUnavailableBody: 'Diese Ereignis-Automation lässt sich nicht speichern, weil ihr gespeicherter Inhalt nicht verfügbar ist.',
        historyGapRecoveryTitle: 'Eine Lücke im Verlauf braucht Aufmerksamkeit',
        historyGapRecoverySubtitle: 'Setz die Quell-Baseline zurück, um wieder neue Ereignisse zu beobachten.',
        historyGapRecoveryUnavailable: 'Die Wiederherstellungsaktion für die Quelle gibt es bei ihrem aktuellen Watcher nicht.',
        historyGapRecoveryFailureTitle: 'Die Quell-Wiederherstellung braucht einen weiteren Versuch',
        historyGapRecoveryFailureBody: 'Die Wiederherstellung wurde nicht bestätigt. Die Quelle braucht weiter Aufmerksamkeit.',
        sourceStatusTitle: 'Beobachtungsquelle',
        sourceStatusState: {
            uninitialized: 'Nicht gestartet',
            baselined: 'Baseline bereit',
            observing: 'Beobachtet',
            backingOff: 'Wartet auf den nächsten Versuch',
            attention: 'Braucht Aufmerksamkeit',
        },
        sourceStatusCode: {
            credentialMissing: 'Zugangsdaten erforderlich',
            credentialRevoked: 'Zugangsdaten widerrufen',
            rateLimited: 'Rate-limitiert',
            historyGap: 'Lücke im Verlauf',
            capacityBlocked: 'Durch Kapazität blockiert',
            definitionStale: 'Definition geändert',
            sourceContractIncompatible: 'Die Quelle muss aktualisiert werden',
            admissionUnavailable: 'Zulassung nicht verfügbar',
        },
        sourceStatusNextRetry: ({ time }: { time: string }) => `Nächster Versuch: ${time}`,
        sourceStatusObservedCount: ({ count }: { count: number }) => `Beobachtete Ereignisse: ${count}`,
        sourceStatusAdmittedCount: ({ count }: { count: number }) => `Zugelassene Ereignisse: ${count}`,
        sourceStatusSkippedCount: ({ count }: { count: number }) => `Übersprungene Ereignisse: ${count}`,
        sourceStatusLastObserved: ({ time }: { time: string }) => `Zuletzt beobachtet: ${time}`,
        sourceCatalogStatusTitle: 'Katalog-Abgleich',
        sourceCatalogStatusState: {
            current: 'Aktuell',
            reconciling: 'Wird abgeglichen',
            reconciliationLate: 'Abgleich verzögert',
        },
        sourceCatalogStatusObservedRevision: ({ revision }: { revision: string }) => `Beobachtete Revision: ${revision}`,
        sourceCatalogStatusAdoptedRevision: ({ revision }: { revision: string }) => `Übernommene Revision: ${revision}`,
        sourceCatalogStatusNoAdoptedRevision: 'Noch keine Revision übernommen',
        sourceCatalogStatusScanStarted: ({ time }: { time: string }) => `Scan gestartet: ${time}`,
    },
} } as const;

return { eventAutomationComposerTranslations };
})();

const Domain_externalSessionOperationTranslations = (() => {
const en = Shared_externalSessionOperationTranslations.en;

const translated = Shared_externalSessionOperationTranslations.translated;

const externalSessionOperationTranslations = { de: {
    browseLinked: 'Verknüpft',
    browseImported: 'Importiert',
    browseAgentUnavailable: 'Happier konnte den gewählten Agent auf diesem Rechner nicht starten oder erreichen. Prüf, ob seine CLI dort installiert ist, und versuch es dann noch einmal.',
    browseAgentTimedOut: 'Der gewählte Agent auf diesem Rechner hat nicht rechtzeitig geantwortet. Er ist vielleicht ausgelastet oder indiziert noch, versuch es also noch einmal.',
    browseAgentFailed: 'Happier konnte die Sitzungen des gewählten Agents auf diesem Rechner nicht lesen. Versuch es noch einmal; wenn es weiter fehlschlägt, aktualisiere Happier auf diesem Rechner.',
    operationTitleMaterialize: 'Nach Happier importieren',
    operationTitleTakeoverLinked: 'Übernehmen und verknüpft fortsetzen',
    operationTitleTakeoverPersisted: 'Importieren und übernehmen',
    operationMaterializeAvailable: 'Importier diese verknüpfte Session, um ihr Transkript offline zu nutzen oder zu teilen.',
    externalAgentStatusOnMachine: ({ agent, machine, status }: { agent: string; machine: string; status: string }) =>
        `${agent} auf ${machine}: ${status}`,
    operationStatusRunning: 'Läuft',
    operationStatusCancelling: 'Wird abgebrochen…',
    operationStatusCancelled: 'Abgebrochen',
    operationStatusCompleted: 'Erreicht',
    operationStatusDiscarded: 'Unvollständige Session verworfen',
    operationStatusNeedsResume: 'Wartet darauf, dass du fortsetzt',
    operationStatusNeedsReview: 'Muss geprüft werden, bevor es weitergeht',
    operationStatusFailed: 'Konnte nicht fortgesetzt werden',
    operationStatusImportIncomplete: 'Import unvollständig – setz die unvollständige Session fort oder verwirf sie',
    operationStatusUpdateIncomplete: 'Update unvollständig – fortsetzen',
    operationStatusOriginOffline: 'Fortschritt gesichert – der Quellrechner ist offline',
    operationStatusOriginUnknown: 'Fortschritt gesichert – Happier kann nicht feststellen, ob der Quellrechner online ist',
    operationStatusExternalWriter: 'Externer Schreibzugriff erkannt',
    operationStatusSpawnFailedAfterImport: 'Importiert, aber der Agent ließ sich nicht starten – Start wiederholen',
    operationStatusSpawnFailedAfterTakeover: 'Übernommen, aber der Agent ließ sich nicht starten – Start wiederholen',
    operationErrorSourceUnavailable: 'Die Quelle ist nicht verfügbar. Verbinde den Quellrechner neu und setz dann fort.',
    operationErrorSourceChanged: 'Die Quelle hat sich während des Lesens geändert. Prüf sie, bevor du fortsetzt.',
    operationErrorCapacity: 'Dieser Rechner hat nicht genug Zwischenspeicher, um weiterzumachen.',
    operationErrorRequiredItems: 'Einige nötige Session-Einträge ließen sich nicht importieren.',
    operationErrorImport: 'Der Import der Nachrichten wurde unterbrochen.',
    operationErrorPublication: 'Der importierte Snapshot ließ sich nicht veröffentlichen.',
    operationErrorAdmission: 'Happier konnte diese Session nicht sicher übernehmen.',
    operationErrorExternalWriter: 'Stopp den externen Agent, bevor du es erneut versuchst. Happier führt ihn weder zusammen noch stoppt es ihn automatisch.',
    operationErrorInternal: 'Die Operation wurde wegen eines internen Fehlers gestoppt.',
    operationPhaseValidating: 'Wird geprüft',
    operationPhaseWaitingForAgent: 'Wartet auf das Stoppen des externen Agents',
    operationPhaseReadingSource: 'Quelle wird gelesen',
    operationPhaseImporting: 'Nachrichten werden importiert',
    operationPhaseCatchingUp: 'Holt bei der Quelle auf',
    operationPhasePreparingRuntime: 'Runtime wird vorbereitet',
    operationPhaseStartingRuntime: 'Runtime wird gestartet',
    operationPhaseFinalizing: 'Wird abgeschlossen',
    operationPhasePublishing: 'Importierte Session wird veröffentlicht',
    operationActionResume: 'Fortsetzen',
    operationActionRetryStart: 'Start wiederholen',
    operationActionCancel: 'Abbrechen',
    operationActionDiscard: 'Unvollständige Session verwerfen',
    operationActionDismiss: 'Ausblenden',
    operationStatusOwnerReadFailed: 'Happier konnte den aktuellen Fortschritt dieses Vorgangs nicht lesen.',
    operationActionCheckAgain: 'Erneut prüfen',
    operationComposerImporting: 'Wird importiert…',
    operationComposerTakingOver: 'Wird übernommen…',
    operationActionErrorUpgradeRequired: 'Aktualisiere Happier auf dem Quellrechner, um diese Aktion zu nutzen.',
    operationActionErrorNotFound: 'Diese Operation ist nicht mehr verfügbar.',
    operationActionErrorConflict: 'Eine andere Operation steuert diese Session bereits.',
    operationActionErrorStaleRevision: 'Die Operation hat sich geändert. Prüf ihren aktuellen Fortschritt und versuch es dann noch einmal.',
    operationActionErrorInvalidState: 'Diese Aktion gibt es im aktuellen Zustand der Operation nicht.',
    operationActionErrorNotAllowed: 'Du darfst diese Operation nicht steuern.',
    operationActionErrorUnavailable: 'Die Aktion der Operation ließ sich nicht abschließen. Versuch es ab ihrem aktuellen Fortschritt noch einmal.',
    operationImportProgress: 'Import-Fortschritt',
    operationImportCountUnknown: ({ imported }: { imported: number }) => `${imported} Nachrichten importiert`,
    operationImportCountEstimated: ({ imported, total }: { imported: number; total: number }) => `${imported} von ca.${total} Nachrichten`,
    operationPublishedSnapshot: 'Veröffentlichter Snapshot bleibt erhalten',
    operationPublishedThrough: ({ sequence }: { sequence: number }) => `Verfügbar über Nachricht ${sequence}`,
    operationDiscardConfirmTitle: 'Unvollständige Session verwerfen?',
    operationDiscardConfirmBody: 'Damit wird die gesamte unvollständige Session entfernt. Das lässt sich nicht rückgängig machen.',
    sharingTranscriptOnMachine: ({ machine }: { machine: string }) =>
        `Das Transkript dieser Session liegt auf ${machine}. Importier es nach Happier, um es zu teilen.`,
    sharingImportIncomplete: 'Import läuft oder ist unvollständig. Setz den Import fort, bevor du teilst.',
    sharingTranscriptUnavailableTitle: 'Transkript nicht verfügbar',
    transcriptRetainedRefreshFailedTitle: 'Letztes bekanntes Transkript wird angezeigt',
    transcriptLoadFailed: 'Happier konnte dieses Transkript nicht laden.',
    sharingTranscriptUnavailable: 'Transkript nicht verfügbar. Diese alte verknüpfte Session hat kein sicher gespeichertes Transkript.',
    sharingSharedUpTo: ({ time }: { time: string }) => `Geteilt bis ${time}`,
    sharingSnapshotFrom: ({ time }: { time: string }) => `Snapshot von ${time}`,
    sharingUpdateSharedCopy: 'Geteilte Kopie aktualisieren',
    sharingUpdateSharedCopyDescription: 'Den geteilten Snapshot mit dem aktuellen Quell-Transkript aktualisieren.',
    sharingSourceMachineMissing: 'Der Quellrechner ist nicht verfügbar. Verbinde ihn wieder mit Happier, bevor du es erneut versuchst.',
    sharingSourceMachineOffline: 'Der Quellrechner ist offline. Bring ihn online, bevor du es erneut versuchst.',
    sharingActionAwaitingAvailability: 'Diese Aktion steht bereit, sobald der Materialisierungs-Ablauf angebunden ist.',
} } as const;

return { externalSessionOperationTranslations };
})();

const Domain_externalSessionSettingsTranslations = (() => {
const en = Shared_externalSessionSettingsTranslations.en;

const translated = Shared_externalSessionSettingsTranslations.translated;

const externalSessionSettingsTranslations = { de: {
    settingsIntegrationStatusNotInstalled: 'Nicht installiert',
    settingsIntegrationStatusEnabled: 'Installiert und aktiviert',
    settingsIntegrationStatusDisabled: 'Installiert und deaktiviert',
    settingsIntegrationStatusNeedsAttention: 'Braucht Aufmerksamkeit',
    settingsIntegrationStatusUnsupported: 'Von dieser Agent-Version nicht unterstützt',
    settingsIntegrationStatusUnavailable: 'Agent nicht verfügbar',
    settingsIntegrationInventoryLoadingTitle: 'Integrationsstatus wird geprüft',
    settingsIntegrationInventoryLoadingSubtitle: 'Das vollständige Integrations-Inventar wird von diesem Rechner gelesen.',
    settingsIntegrationInventoryPartialTitle: 'Integrationsstatus unvollständig',
    settingsIntegrationInventoryPartialSubtitle: 'Einige Installationseinträge ließen sich nicht lesen. Prüf noch einmal, bevor du etwas änderst.',
    settingsIntegrationInventoryErrorTitle: 'Integrationsstatus nicht verfügbar',
    settingsIntegrationInventoryErrorSubtitle: 'Der zuletzt bekannte Status ist womöglich veraltet. Prüf noch einmal, bevor du etwas änderst.',
    settingsIntegrationTitle: 'Beobachtung externer Sessions',
    settingsIntegrationNeedsAttentionTitle: 'Braucht Aufmerksamkeit',
    settingsIntegrationDiagnosticMessageUnavailable: 'Diese Installation braucht Aufmerksamkeit, bevor die Beobachtung weiterlaufen kann.',
    settingsIntegrationRemediationRetry: 'Prüf noch einmal, nachdem du das Problem gelöst hast.',
    settingsIntegrationRemediationOpenSettings: ({ path }: { path: string }) => `Prüf die Einstellung unter ${path}.`,
    settingsIntegrationRemediationSelectAccount: ({ service }: { service: string }) => `Wähl ein Konto für ${service}.`,
    settingsIntegrationRemediationInstallDependency: ({ dependency }: { dependency: string }) => `Installier die nötige Abhängigkeit: ${dependency}.`,
    settingsIntegrationRemediationOpenUrl: ({ url }: { url: string }) => `Lies die Hinweise unter ${url}.`,
    settingsIntegrationActionReviewInstall: 'Prüfen & installieren',
    settingsIntegrationActionDisable: 'Deaktivieren',
    settingsIntegrationActionEnable: 'Aktivieren',
    settingsIntegrationActionUninstall: 'Deinstallieren',
    settingsIntegrationActionCheckAgain: 'Erneut prüfen',
    settingsIntegrationReviewTitle: ({ agent }: { agent: string }) => `Prüfen: ${agent} Integration`,
    settingsIntegrationReviewBody: ({ entries }: { entries: string }) =>
        `Happier verwaltet nur diese Einträge: ${entries}.`,
    settingsIntegrationReviewBodyUnavailable: 'Prüf die vom Agent verwalteten Änderungen vor der Installation.',
    settingsIntegrationPreviewNoMatcher: 'Alle passenden Sessions',
    settingsIntegrationActionInstall: 'Installieren',
    settingsIntegrationUninstallTitle: ({ agent }: { agent: string }) => `Deinstallieren: ${agent} Integration?`,
    settingsIntegrationUninstallBody: 'Damit werden nur die von Happier verwalteten Einträge entfernt. Die übrige Agent-Konfiguration bleibt unverändert.',
    settingsIntegrationActionFailed: 'Happier konnte diese Integration nicht ändern. Prüf den Rechner und versuch es noch einmal.',
    settingsAutoLinkUpdateFailed: 'Happier konnte das automatische Verknüpfen nicht ändern. Versuch es noch einmal.',
    settingsRestoreUpdateFailed: 'Happier konnte die Einstellung zur Synchronisierung nach dem Neustart nicht ändern. Versuch es noch einmal.',
    settingsIntegrationsGroupTitle: 'Beobachtung externer Sessions',
    settingsIntegrationsFooter: 'Happier ändert die Agent-Konfiguration nur nach einer ausdrücklichen Aktion. Diese Seite zu öffnen ist rein lesend.',
    settingsIntegrationsUnavailableTitle: 'Keine Integrationen verfügbar',
    settingsIntegrationsUnavailableSubtitle: 'Verbinde eine unterstützte Agent-Integration, um ihren Status und die möglichen Aktionen zu sehen.',
    settingsAgentAutoLinkTitle: ({ agent }: { agent: string }) => `Neue automatisch hinzufügen: ${agent} Sessions`,
    settingsAutoLinkTitle: 'Neue externe Sessions automatisch hinzufügen',
    browseAutoLinkTitle: 'Neue Sessions automatisch hinzufügen',
    settingsAutoLinkGroupTitle: 'Automatisches Verknüpfen',
    settingsAutoLinkGroupFooter: 'Automatisches Verknüpfen ist standardmäßig aus und unabhängig von der Einrichtung der Agent-Integration und von der Hintergrundsynchronisierung.',
    settingsAutoLinkUnavailableTitle: 'Keine Quellen für automatisches Verknüpfen verfügbar',
    settingsAutoLinkUnavailableSubtitle: 'Auf diesem Rechner gibt es keine unterstützten Quellbereiche.',
    settingsAutoLinkSubtitle: 'Wenn aktiviert, verknüpft Happier unterstützte neue Sessions dieser Quelle, ohne den Agent zu öffnen oder fortzusetzen.',
    settingsAutoLinkHint: 'Schaltet das automatische Verknüpfen für diese Quelle ein oder aus.',
    settingsPrivacyGroupTitle: 'Datenschutz',
    settingsPrivacyTitle: 'Begrenzte, inhaltsfreie Beobachtungen',
    settingsPrivacySubtitle: 'Vertrauenswürdige Agent-Integrationen dürfen begrenzte native Hook-Daten auf diesem Rechner einsehen. Happier lässt nur inhaltsfreie Beobachtungen zu und synchronisiert nur diese; rohe Payloads, Pfade, Zugangsdaten, Prompts, Transkript-Text und Tool-Argumente werden vom Host nie gespeichert, synchronisiert oder geloggt.',
    settingsAgentActionsGroupTitle: 'Externe Sessions',
    settingsAgentBrowseTitle: ({ agent }: { agent: string }) => `Durchsuchen: ${agent} externe Sessions`,
    settingsManageAllTitle: 'Alle externen Sessions verwalten',
    settingsManageAllSubtitle: 'Integrationen und Hintergrundsynchronisierung über verbundene Rechner hinweg prüfen.',
    settingsMachineOnline: 'Online',
    settingsMachineOffline: 'Offline',
    settingsMachineTitle: 'Rechner',
    settingsMachineUnavailable: 'Kein verbundener Rechner',
    browseSearchIncomplete: ({ count }: { count: number }) =>
        `Zeigt die ersten ${count} – grenz deine Suche ein`,
    browseAnnotationsIncomplete: 'Einige Status ließen sich nicht bestätigen. Beim Öffnen einer Session wird er geprüft.',
    browseRouteUnavailableTitle: 'Externe Sessions sind hier nicht verfügbar',
    browseRouteUnavailableSubtitle: 'Dieser Server bietet kein Durchsuchen externer Sessions. Geh zurück und wähl einen anderen Server oder versuch es später noch einmal.',
    browseRouteAvailabilityUnknownTitle: 'Die Unterstützung für externe Sessions ließ sich nicht bestätigen',
    browseRouteAvailabilityUnknownSubtitle: 'Happier konnte nicht prüfen, ob dieser Server das Durchsuchen externer Sessions bietet. Geh zurück und versuch es gleich noch einmal.',
    browseHeaderTitle: 'Externe Sessions',
    browseSettingsLink: 'Einstellungen für externe Sessions',
    browseChooseMachineTitle: 'Rechner wählen',
    browseChooseMachineBody: 'Externe Sessions liegen auf dem Rechner, auf dem sie liefen. Wähl einen, um seine Sessions zu sehen.',
    browseMachineGoneBody: 'Er wurde entfernt oder ersetzt. Wähl einen anderen Rechner, um seine Sessions zu sehen.',
    browseHomeUnreachableBody: 'Seine Rechner und Sessions erscheinen, sobald es erreichbar ist. Wähl solange einen anderen Rechner.',
    browseMachineOfflineTitle: ({ machine }: { machine: string }) => `${machine} ist offline`,
    browseThisMachineOfflineTitle: 'Dieser Rechner ist offline',
    browseMachineOfflineBody: 'Seine Sessions erscheinen, sobald er wieder verbunden ist.',
    browseChooseAnotherMachine: 'Anderen Rechner wählen',
    browseCantReachTitle: ({ machine }: { machine: string }) => `Happier auf ${machine} nicht erreichbar`,
    browseCantReachBody: 'Der Rechner ist online, aber sein Happier-Dienst antwortet nicht. Vielleicht startet er noch.',
    browseNothingToBrowseTitle: ({ machine }: { machine: string }) => `Nichts zu durchsuchen auf ${machine}`,
    browseNothingToBrowseBody: 'Keiner der Agents auf diesem Rechner kann seine Sessions bisher teilen.',
    browseEmptyTitle: ({ agent, machine }: { agent: string; machine: string }) => `Keine ${agent}-Sessions auf ${machine}`,
    browseEmptyBody: 'Sessions, die du auf diesem Rechner startest, erscheinen hier, bereit zum Öffnen in Happier.',
    browseTryAgent: ({ agent }: { agent: string }) => `${agent} ausprobieren`,
    browseNoMatches: ({ query }: { query: string }) => `Keine Sessions passen zu „${query}“`,
    browseErrorTitle: 'Sessions konnten nicht geladen werden',
    browseThisMachine: 'diesem Rechner',
    browseIndexingStop: 'Stoppen',
    browseThreadsFilter: 'Sub-Agent-Threads',
    browseThreadsHidden: 'Nur Hauptsessions',
    browseThreadsShown: 'Mit Sub-Agent-Threads',
    browseThreadReviewer: 'Prüfer',
    browseThreadSubagent: 'Sub-Agent',
    browseThreadReviewerOf: ({ parent }: { parent: string }) => `Prüfer von ${parent}`,
    browseThreadSubagentOf: ({ parent }: { parent: string }) => `Sub-Agent von ${parent}`,
} };

return { externalSessionSettingsTranslations };
})();

const Domain_filesPaneTranslations = (() => {
type FilesPaneTranslations = Shared_filesPaneTranslations.FilesPaneTranslations;

const filesPaneTranslations = { de: {
        changedOnly: 'Nur geänderte',
        showAllFiles: 'Alle Dateien anzeigen',
        viewOptions: 'Ansichtsoptionen',
        sizeAndDate: 'Größe und Datum',
        newMenu: 'Neue Datei, neuer Ordner oder Hochladen',
        newFile: 'Neue Datei',
        newFolder: 'Neuer Ordner',
        noChangedFilesTitle: 'Nichts geändert',
        noChangedFilesReason: 'Die Arbeitskopie entspricht dem letzten Commit.',
        rootErrorTitle: ({ machine }) => `Dateien auf ${machine} konnten nicht aufgelistet werden`,
        rootErrorTitleUnnamed: 'Dateien konnten nicht aufgelistet werden',
        workspaceUnavailableReason: 'Happier konnte für diese Sitzung keinen Computer und keinen Ordner ermitteln.',
    } } as const satisfies Pick<Record<string, FilesPaneTranslations>, "de">;

return { filesPaneTranslations };
})();

const Domain_findTranslations = (() => {
type FindTranslations = Shared_findTranslations.FindTranslations;

const slavicPlural = Shared_findTranslations.slavicPlural;

const russianPlural = Shared_findTranslations.russianPlural;

const en = Shared_findTranslations.en;

const de: FindTranslations = {
    open: 'Suchen…',
    openedForMatch: 'Für einen Treffer geöffnet', foldAgain: 'Wieder einklappen', showHiddenLines: ({ count }) => `${count} ausgeblendete Zeilen anzeigen`,
    surface: {
        chat: 'Im Chat suchen',
        changes: 'In Änderungen suchen',
        file: 'In Datei suchen',
        terminal: ({ name }) => `In ${name} suchen`,
    },
    previous: 'Vorheriger Treffer',
    next: 'Nächster Treffer',
    matchCase: 'Groß-/Kleinschreibung beachten',
    regex: 'Regulären Ausdruck verwenden',
    regexShort: 'Regulärer Ausdruck',
    options: 'Suchoptionen',
    close: 'Suche schließen',
    done: 'Fertig',
    stop: 'Stopp',
    noMatches: 'Keine Treffer',
    noneFound: 'Nichts gefunden',
    invalidPattern: 'Ungültiges Muster',
    offline: 'Keine Verbindung',
    unsupported: 'Hier nicht durchsuchbar',
    count: ({ current, total }) => (current === null ? `${total} Treffer` : `${current} von ${total}`),
    files: ({ count }) => `${count} ${count === 1 ? 'Datei' : 'Dateien'}`,
    soFar: 'bisher',
    loaded: 'geladen',
    note: {
        searchingOlder: 'Ältere Nachrichten werden durchsucht und auf diesem Gerät entschlüsselt',
        offlineOlder: 'Ältere Nachrichten lassen sich durchsuchen, sobald du wieder online bist.',
        terminalKept: ({ lines }) => `Die letzten ${lines} Zeilen durchsucht, die dieses Terminal behält.`,
    },
};

const findTranslations = { de };

return { findTranslations };
})();

const Domain_folderlessSessionTranslations = (() => {
type FolderlessSessionTranslations = Shared_folderlessSessionTranslations.FolderlessSessionTranslations;

const en = Shared_folderlessSessionTranslations.en;

const de: FolderlessSessionTranslations = {
    composer: {
        addFolder: 'Ordner hinzufügen',
        noFolder: 'Kein Ordner',
        noFolderDescription: 'Happier legt für diesen Chat einen privaten Ordner an',
        removeFolder: 'Ordner entfernen',
        a11y: {
            folder: ({ path }) => `Ordner: ${path}. Öffnet die Ordnerauswahl.`,
            none: 'Kein Ordner. Happier legt für diesen Chat einen privaten Ordner an. Ordner hinzufügen.',
            loading: 'Ordner wird geladen',
            noFolderRow: 'Kein Ordner, privater Ordner für diesen Chat',
            removed: 'Ordner entfernt',
            set: ({ path }) => `Ordner auf ${path} gesetzt`,
        },
    },
    display: {
        chats: 'Chats',
        untitledChat: 'Neuer Chat',
        folder: 'Ordner',
        privateToSession: 'Nur für diese Sitzung',
        sessionFiles: 'Sitzungsdateien',
        privateFolderOn: ({ machine }) => `Privater Ordner auf ${machine}`,
    },
};

const folderlessSessionTranslations = { de: de };

return { folderlessSessionTranslations };
})();

const Domain_glassAppearanceTranslations = (() => {
const englishTranslations = Shared_glassAppearanceTranslations.englishTranslations;

const effectiveTranslations = { "de": {
        "effectiveBrowserSolid": "Deckende Menüs und schwebende Bedienelemente. Ein Browser kann deinen Desktop nicht zeigen.",
        "effectiveFloatingSolid": "Deckende schwebende Bedienelemente auf diesem Gerät.",
        "effectiveSolid": "Deckende Flächen auf diesem Gerät.",
        "effectiveBrowser": "Glas in Menüs und schwebenden Bedienelementen. Ein Browser kann deinen Desktop nicht zeigen.",
        "effectiveBrowserCustom": "Dein Material in Menüs und schwebenden Bedienelementen. Ein Browser kann deinen Desktop nicht zeigen.",
        "effectivePhone": "Glas auf schwebenden Bedienelementen und Blättern.",
        "effectiveLayered": "Abgestuftes Glas in diesem Fenster.",
        "effectiveUniform": "Einheitliches Glas in diesem Fenster.",
        "effectiveCustom": "Glas in diesem Fenster nach deinen Einstellungen.",
        "effectiveUnavailable": "Fensterglas ist hier nicht verfügbar. Schwebende Bedienelemente verwenden dein Material.",
        "effectiveInactive": "Deckend, solange dieses Fenster inaktiv ist.",
        "effectiveTint": "Getönte schwebende Bedienelemente; Hintergrundunschärfe ist nicht verfügbar.",
        "description": "Lass den Desktop durch das Fenster und die Seite durch schwebende Bedienelemente scheinen.",
        "descriptionBrowser": "Lass die Seite durch Menüs und schwebende Bedienelemente scheinen.",
        "descriptionPhone": "Lass die Seite durch schwebende Bedienelemente und Blätter scheinen.",
        "chromeDescription": "Titelleiste, Navigation und Fensterhintergrund",
        "sidebarDescription": "Deine Sitzungsspalte",
        "contentDescription": "Verlauf, Eingabe und Arbeitsbereiche",
        "floatingDescription": "Menüs, Popover, Blätter und schwebende Bedienelemente",
        "clear": "Transparent",
        "shortcutHint": ({ modifier }: { modifier: string }) => `${modifier}-Klick · ${modifier}⇧L wechselt Hell und Dunkel`
    } } as const;

const glassAppearanceTranslations = { de: { iosReduceTransparencyPath: "Einstellungen › Bedienungshilfen › Anzeige & Textgröße › Transparenz reduzieren", title: 'Glas', material: 'Material', solid: 'Deckend', auto: 'Automatisch', everywhere: 'Überall', custom: 'Eigene', blur: 'Unschärfe', off: 'Aus', opacity: 'Deckkraft', customize: 'Anpassen', chrome: 'Fensterrahmen', sidebar: 'Seitenleiste', content: 'Inhalt', floating: 'Schwebende Flächen', appearance: 'Darstellung', moreSettings: 'Weitere Darstellungseinstellungen…', customizeLink: 'Anpassen…', toolbarTitle: 'Darstellungsschaltfläche', toolbarDescription: 'Zeigt Darstellung in der Symbolleiste. Mit Zusatztaste klicken wechselt Hell und Dunkel.', reduceTransparency: 'Deckend, weil Transparenz reduzieren aktiviert ist', osSettings: 'Bedienungshilfen öffnen', themeCommand: 'Hell und Dunkel wechseln', autoDescription: "Passt sich diesem Gerät an: abgestufte Glasflächen in unterstützten Desktopfenstern, schwebende Glasflächen auf dem Telefon.", osSettingsUnavailable: "Die Bedienungshilfen konnten nicht geöffnet werden. Öffne sie in den Geräteeinstellungen.", ...effectiveTranslations["de"] } } satisfies Pick<Record<string, Record<keyof typeof englishTranslations, string | ((params: { modifier: string }) => string)>>, "de">;

return { effectiveTranslations, glassAppearanceTranslations };
})();

const Domain_goalControlTranslations = (() => {
const en = Shared_goalControlTranslations.en;

const de: typeof en = {
    row: {
        notSet: 'Nicht festgelegt',
    },
    keepGoing: {
        title: 'Weitermachen bis fertig',
        nativeDescription: ({ agent }) => `${agent} arbeitet selbstständig weiter am Ziel.`,
        description: ({ rounds }) => `Nach jedem deiner Züge prüft ein Agent das Ziel und macht weiter, bis es erreicht ist, das Budget aufgebraucht ist oder kein Fortschritt mehr kommt – höchstens ${rounds} ${rounds === 1 ? 'Runde' : 'Runden'}.`,
        roundsPrefix: 'Stoppen nach',
        roundsSuffix: 'Runden',
        roundsLabel: 'Runden bis zum Stopp',
        strikesPrefix: 'Stoppen nach',
        strikesSuffix: 'Prüfungen ohne Fortschritt',
        strikesLabel: 'Prüfungen ohne Fortschritt bis zum Stopp',
        secondOpinionTitle: 'Vor dem Abschluss eine zweite Meinung einholen',
        secondOpinionDescription: 'Bevor das Ziel als erledigt gilt, prüft es ein zweiter Agent. Ist er anderer Meinung, bekommst du eine Benachrichtigung und das Ziel bleibt offen.',
        budgetUnreported: ({ agent }) => `${agent} meldet keinen Token-Verbrauch, daher gelten nur die Runden und Fortschrittsprüfungen.`,
    },
};

const goalControlTranslations = { de };

return { goalControlTranslations };
})();

const Domain_homeAddTranslations = (() => {
type HomeAddTranslation = Shared_homeAddTranslations.HomeAddTranslation;

const en = Shared_homeAddTranslations.en;

const homeAddTranslations = { de: {
        addressIsSignInService: 'Diese Adresse gehört zu einem Anmeldedienst. Melde dich dort an, um deine Homes zu finden.',
        mixedContent: 'Dieser Browser kann von einer HTTPS-Seite aus keine Verbindung zu einem HTTP-Home herstellen. Öffne Happier über HTTP oder verwende eine HTTPS-Adresse für das Home.',
        connectedToHome: ({ home }) => `${home} ist mit diesem Gerät verbunden.`,
        openHome: ({ home }) => `${home} öffnen`,
        showAllHomes: 'Alle Homes anzeigen',
        otherSignInService: 'Anderer Anmeldedienst',
        otherSignInServiceSubtitle: 'Ein selbst gehosteter oder Firmendienst',
        signInServiceAddress: 'Adresse des Dienstes',
    } } satisfies Pick<Record<string, HomeAddTranslation>, "de">;

return { homeAddTranslations };
})();

const Domain_homeComposerTranslations = (() => {
type HomeComposerTranslation = Shared_homeComposerTranslations.HomeComposerTranslation;

const starterPrompts = Shared_homeComposerTranslations.starterPrompts;

const homeComposerTranslations = { de: {
        ...starterPrompts,
        suggestionsLabel: 'Vorschläge',
        summarizeProjectSince: ({ project, day }) => `Fasse zusammen, was sich in ${project} seit ${day} geändert hat`,
        summarizeProjectToday: ({ project }) => `Fasse zusammen, was sich heute in ${project} geändert hat`,
        sessionsSince: ({ count, day }) => (count === 1 ? `1 Sitzung seit ${day}` : `${count} Sitzungen seit ${day}`),
        sessionsToday: ({ count }) => (count === 1 ? '1 Sitzung heute' : `${count} Sitzungen heute`),
    } } satisfies Pick<Readonly<Record<string, HomeComposerTranslation>>, "de">;

return { homeComposerTranslations };
})();

const Domain_homeDeviceApprovalTranslations = (() => {
type HomeDeviceApprovalTranslation = Shared_homeDeviceApprovalTranslations.HomeDeviceApprovalTranslation;

const homeDeviceApprovalTranslations = { de: {
        title: 'Gerätefreigaben', deviceFallback: 'Neues Gerät',
        homeLabel: ({ home }) => `Home: ${home}`, expiresLabel: ({ expiry }) => `Läuft ab: ${expiry}`,
        requestDetails: 'Anfragedetails', requestDetailsHint: 'Kennung des Anfrageschlüssels anzeigen',
        fingerprintLabel: 'Fingerabdruck des Anfrageschlüssels', requestDetailsHelp: 'Dies kennzeichnet den Anfrageschlüssel. Es ist kein Code, den du vergleichen musst.',
        approve: 'Genehmigen', reject: 'Ablehnen', loadError: 'Gerätefreigaben konnten nicht geladen werden.',
        loadErrorUnreachable: ({ homes }) => `${homes} hat nicht geantwortet.`, loadErrorFailed: ({ homes }) => `${homes} hat mit einem Fehler geantwortet.`,
        decisionError: 'Diese Anfrage konnte nicht aktualisiert werden.', decisionRecovery: 'Wähle erneut Genehmigen oder Ablehnen.',
        approved: 'Gerät genehmigt', rejected: 'Gerät abgelehnt', expired: 'Abgelaufen', stopWaiting: 'Nicht mehr warten',
    } } as const satisfies Pick<Record<string, HomeDeviceApprovalTranslation>, "de">;

return { homeDeviceApprovalTranslations };
})();

const Domain_homeFeatureTranslations = (() => {
const en = Shared_homeFeatureTranslations.en;

const de: typeof en = {
    teams: {
        title: 'Teams',
        description: 'Gruppen mit geteilten Sessions, Maschinen und Zugriff.',
        credentialResources: {
            title: 'Team-Zugangsdaten',
            description: 'Zugangsdaten, die ein Team mit seinen Sessions teilt.',
            externalApi: {
                title: 'API für Team-Zugangsdaten',
                description: 'Externe Tools nutzen die Zugangsdaten eines Teams über die API.',
            },
        },
    },
    automations: {
        title: 'Automatisierungen',
        description: 'Geplante und ausgelöste Agentenarbeit.',
    },
    workflows: {
        title: 'Workflows',
        description: 'Mehrstufige Agenten-Pipelines.',
    },
    pets: {
        sync: {
            title: 'Pet-Synchronisierung',
            description: 'Hält die Pets jeder Person auf all ihren Geräten.',
        },
    },
    voice: {
        title: 'Sprache',
        description: 'Sprich mit deinen Agenten.',
        happierVoice: {
            title: 'Happier-Sprache',
            description: 'Sprache über den Sprachdienst, den dieses Home bereitstellt.',
        },
    },
    connectedServices: {
        group: 'Verbundene Dienste',
        quotas: {
            title: 'Kontingentanzeigen',
            description: 'Zeigt, wie viel Kontingent jedes verbundene Konto noch hat.',
        },
        subscription: {
            title: 'Abostatus',
            description: 'Zeigt Tarif und Status jedes verbundenen Kontos.',
        },
        accountGroups: {
            title: 'Kontogruppen',
            description: 'Fasse verbundene Konten zu Pools zusammen.',
        },
        accountFallback: {
            title: 'Konto-Ausweichlösung',
            description: 'Wechselt zum nächsten Konto im Pool, wenn eines erschöpft ist.',
        },
        autoQuotaReset: {
            title: 'Automatisches Kontingent-Reset',
            description: 'Nutzt angesparte Kontingent-Resets, sobald alle Konten eines Pools erschöpft sind.',
        },
        autoDisablePlanInvalid: {
            title: 'Unbrauchbare Konten überspringen',
            description: 'Deaktiviert Pool-Konten, die das gewählte Modell nicht nutzen können.',
        },
        poolQuotaLimitSelection: {
            title: 'Pool-Kontingentgrenzen',
            description: 'Wähle, welchem Anbieterkontingent jeder Pool folgt.',
        },
    },
    updates: {
        ota: {
            title: 'Over-the-Air-Updates',
            description: 'Apps installieren Updates ohne Store-Veröffentlichung.',
        },
    },
    attachments: {
        uploads: {
            title: 'Anhänge',
            description: 'Sende Dateien und Bilder an Agenten in einer Session.',
        },
    },
    sharing: {
        group: 'Freigabe',
        session: {
            title: 'Session-Freigabe',
            description: 'Teile eine Session mit jemandem auf diesem Home.',
        },
        public: {
            title: 'Öffentliche Links',
            description: 'Teile Session-Inhalte über einen öffentlichen Link.',
        },
        contentKeys: {
            title: 'Verschlüsselte Freigabe',
            description: 'Tauscht Schlüssel aus, damit geteilte Sessions Ende-zu-Ende-verschlüsselt bleiben.',
        },
        pendingQueueV2: {
            title: 'Geteilte Nachrichtenwarteschlange',
            description: 'Stellt Nachrichten für eine geteilte Session in die Warteschlange, während ihr Agent beschäftigt ist.',
        },
        pendingDeliveryState: {
            title: 'Zustellverfolgung der Warteschlange',
            description: 'Merkt sich, welche Nachrichten aus der Warteschlange beim Agenten angekommen sind.',
        },
    },
    sessions: {
        title: 'Sessions',
        description: 'Sessions und ihre Steuerung.',
        group: 'Sessions',
        handoff: {
            title: 'Session-Übergabe',
            description: 'Verschiebe eine laufende Session auf eine andere Maschine.',
        },
        ephemeralRunner: {
            title: 'Kurzlebige Runner',
            description: 'Starte eine Session auf einer Wegwerf-Maschine.',
        },
        agentSwitching: {
            title: 'Agentenwechsel',
            description: 'Setze eine Session mit einem anderen Coding-Agenten fort.',
        },
        folders: {
            title: 'Session-Ordner',
            description: 'Ordne Sessions in Ordnern.',
        },
        drafts: {
            title: 'Synchronisierte Entwürfe',
            description: 'Behalte ungesendete Nachrichten und Entwürfe neuer Sessions auf jedem Gerät.',
        },
        following: {
            title: 'Folgen',
            description: 'Folge einer Session, um ihre Updates und Benachrichtigungen zu erhalten.',
        },
        conversations: {
            title: 'Unterhaltungen',
            description: 'Personen sprechen und erwähnen sich gegenseitig in einer geteilten Session.',
        },
        board: {
            title: 'Session-Board',
            description: 'Ordne Sessions und ihre Elemente auf geteilten Boards an.',
        },
        filteredListing: {
            title: 'Gefilterte Liste',
            description: 'Filtert die Session-Liste auf diesem Home, bevor sie geblättert wird.',
        },
        usageLimitRecovery: {
            title: 'Wiederaufnahme nach Nutzungslimit',
            description: 'Warten und fortsetzen oder erneut versuchen, wenn ein Agent ein Nutzungslimit erreicht.',
        },
    },
    machines: {
        title: 'Maschinen',
        description: 'Verbindung zu deinen Maschinen.',
        group: 'Maschinen',
        pools: {
            title: 'Maschinen-Pools',
            description: 'Weiche auf die nächste Maschine aus, wenn eine offline ist.',
        },
        transfer: {
            title: 'Maschinenübertragungen',
            description: 'Daten zwischen Maschinen übertragen.',
            directPeer: {
                title: 'Direkte Übertragungen',
                description: 'Überträgt Daten direkt zwischen Maschinen.',
            },
            serverRouted: {
                title: 'Übertragungen über dieses Home',
                description: 'Überträgt Daten über dieses Home, wenn Maschinen sich nicht direkt verbinden können.',
            },
        },
        peerMediation: {
            title: 'Maschinenverbindungen',
            description: 'Tunnel, Streams und Zugriff zwischen Maschinen.',
            observability: {
                title: 'Verbindungsdiagnose',
                description: 'Zeigt, wie Tunnel, Streams und Vorschauen zwischen Maschinen verbunden sind.',
            },
        },
        tunnel: {
            title: 'Maschinentunnel',
            description: 'Ports zwischen Maschinen öffnen.',
            directPeer: {
                title: 'Direkte Tunnel',
                description: 'Öffnet Ports direkt zwischen Maschinen.',
            },
            serverRouted: {
                title: 'Tunnel über dieses Home',
                description: 'Öffnet Ports über dieses Home, wenn Maschinen sich nicht direkt verbinden können.',
            },
        },
        liveStream: {
            title: 'Livestreams',
            description: 'Den Bildschirm einer Maschine streamen.',
            directPeer: {
                title: 'Direkte Livestreams',
                description: 'Streamt den Bildschirm einer Maschine direkt auf dein Gerät.',
            },
            serverRouted: {
                title: 'Livestreams über dieses Home',
                description: 'Streamt den Bildschirm einer Maschine über dieses Home, wenn ein direkter Stream scheitert.',
            },
        },
        rpc: {
            title: 'Maschinenaufrufe',
            description: 'Maschinen direkt erreichen.',
            directPeer: {
                title: 'Direkte Maschinenaufrufe',
                description: 'Erreicht eine Maschine direkt statt über dieses Home.',
            },
        },
    },
    localServices: {
        title: 'Lokale Dienste',
        description: 'Sieh und öffne die Dienste, die auf deinen Maschinen laufen.',
        group: 'Lokale Dienste',
        inventory: {
            title: 'Dienstübersicht',
            description: 'Listet die Ports und Dienste auf, die auf jeder Maschine laufen.',
        },
        managed: {
            title: 'Verwaltete Dienste',
            description: 'Starte, benenne und überwache Dienste aus Happier.',
        },
        launcher: {
            title: 'Dienststarter',
            description: 'Schlägt Dienste zum Öffnen und für die Vorschau vor.',
        },
        actions: {
            title: 'Dienstaktionen',
            description: 'Dienste kopieren, in der Vorschau öffnen und vergessen.',
            terminate: {
                title: 'Dienste beenden',
                description: 'Beendet den Prozess eines erkannten Dienstes.',
            },
        },
        preview: {
            title: 'Dienstvorschauen',
            description: 'Zeigt einen lokalen Dienst privat in einer Session an.',
        },
        publicPreview: {
            title: 'Öffentliche Vorschauen',
            description: 'Teile eine Dienstvorschau unter einer öffentlichen Adresse.',
        },
    },
    browser: {
        title: 'Browser',
        description: 'Öffne Seiten, Vorschauen und gehostete Ansichten in Happier.',
        group: 'Browser',
        viewTargets: {
            title: 'Browseransichten',
            description: 'Öffnet Vorschauen, Plugin-Seiten und Links in der passenden Browseransicht.',
        },
        internal: {
            title: 'Integrierter Browser',
            description: 'Surfe in Happier mit eigenen Sitzungen und Profilen.',
        },
        sidecar: {
            title: 'Sidecar-Browser',
            description: 'Ein separater verwalteter Browser für aufwendige Automatisierung.',
        },
        diagnostics: {
            title: 'Browser-Devtools',
            description: 'Konsole, Netzwerk und Devtools-Ereignisse des integrierten Browsers.',
        },
        context: {
            title: 'Browserkontext',
            description: 'Hänge den Inhalt einer Seite an eine Nachricht oder einen Agenten an.',
        },
        automation: {
            title: 'Browserautomatisierung',
            description: 'Agenten klicken, tippen und navigieren im integrierten Browser.',
        },
        recording: {
            title: 'Browseraufzeichnungen',
            description: 'Zeichnet Browsersitzungen als Nachweis auf.',
        },
    },
    plugins: {
        title: 'Plugins von außerhalb Happier',
        description: 'Installiere Plugins aus npm und deinen eigenen Quellen.',
        group: 'Plugins',
        webhooks: {
            title: 'Plugin-Webhooks',
            description: 'Plugins empfangen Webhooks von externen Diensten.',
        },
        ui: {
            title: 'Plugin-Ansichten',
            description: 'Zeigt die Ansichten und Panels, die Plugins bereitstellen.',
            hostedWeb: {
                title: 'Web-Plugin-Ansichten',
                description: 'Zeigt Plugin-Ansichten, die für das Web gebaut sind.',
            },
            reactNativeBundles: {
                title: 'Native Plugin-Ansichten',
                description: 'Führt vertrauenswürdige Plugin-Ansichten aus, die mit React Native gebaut sind.',
            },
        },
    },
    devices: {
        title: 'Geräte',
        description: 'Simulatoren und verbundene Geräte.',
        simulatorPreview: {
            title: 'Simulator-Vorschauen',
            description: 'Zeigt Simulatoren und Emulatoren von deinen Maschinen.',
        },
    },
    social: {
        friends: {
            title: 'Freunde',
            description: 'Füge Freunde hinzu und sieh, was sie teilen.',
        },
    },
    auth: {
        group: 'Anmeldung',
        recovery: {
            providerReset: {
                title: 'Zurücksetzen über einen Anbieter',
                description: 'Stelle ein Konto wieder her, indem du dich mit seinem Identitätsanbieter anmeldest.',
            },
        },
        login: {
            keyChallenge: {
                title: 'Schlüssel-Anmeldung',
                description: 'Melde dich an, indem du den Schlüssel eines Geräts nachweist.',
            },
        },
        mtls: {
            title: 'Client-Zertifikate',
            description: 'Melde dich mit einem Client-Zertifikat (mTLS) an.',
        },
        ui: {
            recoveryKeyReminder: {
                title: 'Erinnerung an den Wiederherstellungsschlüssel',
                description: 'Erinnert Personen daran, ihren Wiederherstellungsschlüssel zu sichern.',
            },
        },
        pairing: {
            desktopQrMobileScan: {
                title: 'Anmelden per Scan',
                description: 'Melde dich auf einem Handy an, indem du einen Code auf einem Computer scannst.',
            },
            boundQrV2: {
                title: 'Sicherere Kopplungscodes',
                description: 'Kopplungscodes, die nur für dieses Home und diese Richtung gelten.',
            },
        },
    },
    encryption: {
        group: 'Verschlüsselung',
        plaintextStorage: {
            title: 'Unverschlüsselte Speicherung',
            description: 'Speichert Sessions ohne Ende-zu-Ende-Verschlüsselung.',
        },
        accountOptOut: {
            title: 'Verschlüsselung abwählen',
            description: 'Jede Person kann die Ende-zu-Ende-Verschlüsselung ausschalten.',
        },
    },
    remoteHosts: {
        group: 'Entfernte Hosts',
        management: {
            title: 'Entfernte Hosts',
            description: 'Speichere SSH-Hosts, auf denen Sessions laufen.',
        },
        secretMaterial: {
            title: 'Gespeicherte Host-Geheimnisse',
            description: 'Speichere Passwörter und Schlüssel für SSH-Hosts.',
        },
    },
    e2ee: {
        keylessAccounts: {
            title: 'Schlüssellose Konten',
            description: 'Konten ohne Schlüssel für Ende-zu-Ende-Verschlüsselung.',
        },
    },
    bugReports: {
        title: 'Fehlerberichte',
        description: 'Sende Fehlerberichte mit Diagnosedaten.',
    },
    terminal: {
        group: 'Terminal',
        embeddedPty: {
            title: 'Terminal',
            description: 'Öffne in Happier ein Terminal auf einer Maschine.',
        },
        transport: {
            byteStream: {
                title: 'Gestreamtes Terminal',
                description: 'Eine schnellere Verbindung für das integrierte Terminal.',
            },
        },
    },
    search: {
        title: 'Suche',
        description: 'Durchsuche Sessions und Transkripte.',
    },
    providers: {
        title: 'Modellanbieter',
        description: 'Verbinde Modellanbieter und wähle Modelle für Agenten.',
        group: 'Modellanbieter',
        localDiscovery: {
            title: 'Lokale Anbieter finden',
            description: 'Findet Modellserver, die auf deinen Maschinen laufen.',
        },
        localModelManagement: {
            title: 'Lokale Modellverwaltung',
            description: 'Lade lokale Modelle herunter und verwalte sie.',
        },
    },
    keys: {
        HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: {
            title: 'Adresse des Berichtsdiensts',
            description: 'Wohin Fehlerberichte gesendet werden. Bleibt das Feld leer, wird kein Berichtsdienst angeboten.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__DEFAULT_INCLUDE_DIAGNOSTICS: {
            title: 'Diagnosedaten standardmäßig anhängen',
            description: 'Das Berichtsformular enthält Diagnosedaten, sofern die meldende Person sie nicht abwählt.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__MAX_ARTIFACT_BYTES: {
            title: 'Größter Anhang',
            description: 'Größte Datei, die ein Fehlerbericht anhängen darf, in Bytes.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__UPLOAD_TIMEOUT_MS: {
            title: 'Zeitlimit für Uploads',
            description: 'Wie lange der Upload eines Fehlerberichts dauern darf, in Millisekunden.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__ACCEPTED_ARTIFACT_KINDS: {
            title: 'Erlaubte Anhangsarten',
            description: 'Arten von Anhängen, die Fehlerberichte annehmen. Leer erlaubt die üblichen Arten.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__CONTEXT_WINDOW_MS: {
            title: 'Kontextzeitraum',
            description: 'Wie weit ein Fehlerbericht Kontext zurück sammelt, in Millisekunden.',
        },
        HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: {
            title: 'Sprache erfordert ein Abo',
            description: 'Nur Abonnenten können Sprache nutzen. Ohne Einstellung gilt das in der Produktion, in anderen Setups nicht.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_MANIFEST_BYTES: {
            title: 'Größtes Pet-Manifest',
            description: 'Größtes angenommenes Pet-Manifest, in Bytes.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_SPRITESHEET_BYTES: {
            title: 'Größtes Pet-Spritesheet',
            description: 'Größtes angenommenes Pet-Spritesheet, in Bytes.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_PACKAGE_BYTES: {
            title: 'Größtes Pet-Paket',
            description: 'Größtes angenommenes Pet-Paket, in Bytes.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PETS_PER_ACCOUNT: {
            title: 'Importierte Pets pro Person',
            description: 'Höchstzahl importierter Pets, die eine Person behalten darf.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PET_BYTES_PER_ACCOUNT: {
            title: 'Speicher für importierte Pets pro Person',
            description: 'Höchstzahl an Bytes importierter Pets, die eine Person behalten darf.',
        },
        HAPPIER_FEATURE_PETS_SYNC__ENCRYPTED_CUSTOM_PET_SYNC_POLICY: {
            title: 'Verschlüsselte eigene Pets',
            description: 'Für später reserviert. Verschlüsselte eigene Pets werden noch nicht synchronisiert, daher bleibt dies aus.',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES: {
            title: 'Größte Übertragung über dieses Home',
            description: 'Größte Datei, die eine Übertragung über dieses Home transportiert, in Bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_ACTIVE_TRANSFERS_PER_SOCKET: {
            title: 'Gleichzeitige Übertragungen pro Verbindung',
            description: 'Höchstzahl an Übertragungen über dieses Home, die eine Verbindung gleichzeitig ausführt.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES: {
            title: 'Daten pro Tunnel',
            description: 'Höchstzahl an Bytes, die ein Tunnel über dieses Home transportiert.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_ACTIVE_TUNNELS_PER_SOCKET: {
            title: 'Tunnel pro Verbindung',
            description: 'Höchstzahl an Tunneln über dieses Home, die eine Verbindung offen hält.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: 'Größter Tunnel-Frame',
            description: 'Größter Frame, den ein Tunnel über dieses Home transportiert, in Bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__SUPPORTED_ENCODINGS: {
            title: 'Tunnel-Kodierungen',
            description: 'Frame-Kodierungen, die Tunnel über dieses Home annehmen. Leer nutzt die Standardkodierungen.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__PREFERRED_ENCODING: {
            title: 'Bevorzugte Tunnel-Kodierung',
            description: 'Die zuerst genutzte Frame-Kodierung. Sie muss zu den angenommenen Kodierungen gehören.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BINARY_HEADER_BYTES: {
            title: 'Größter Frame-Header',
            description: 'Größter binärer Frame-Header, in Bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_RAW_PAYLOAD_BYTES: {
            title: 'Größte Frame-Nutzlast',
            description: 'Größte Rohnutzlast in einem Frame, in Bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAMED_MESSAGE_BYTES: {
            title: 'Größte Frame-Nachricht',
            description: 'Größte in Frames verpackte Nachricht, in Bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_CONCURRENT_SUBSTREAMS: {
            title: 'Gleichzeitige Streams pro Tunnel',
            description: 'Höchstzahl an Streams, die ein Tunnel gleichzeitig ausführt.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_TOTAL_SUBSTREAMS: {
            title: 'Streams pro Tunnel',
            description: 'Höchstzahl an Streams, die ein Tunnel während seiner Lebensdauer öffnet.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES_PER_SUBSTREAM: {
            title: 'Daten pro Stream',
            description: 'Höchstzahl an Bytes, die ein Stream transportiert.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_AGGREGATE_BYTES: {
            title: 'Daten pro Tunnel, alle Streams',
            description: 'Höchstzahl an Bytes, die alle Streams eines Tunnels zusammen transportieren.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SUBSTREAM_IDLE_MS: {
            title: 'Zeitlimit für inaktive Streams',
            description: 'Wie lange ein Stream inaktiv sein darf, bevor er geschlossen wird, in Millisekunden.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SESSION_IDLE_MS: {
            title: 'Zeitlimit für inaktive Tunnel',
            description: 'Wie lange ein Tunnel über dieses Home inaktiv sein darf, bevor er geschlossen wird, in Millisekunden.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_IDLE_MS: {
            title: 'Inaktivitätslimit für Tunnel',
            description: 'Wie lange ein Tunnel inaktiv sein darf, bevor er geschlossen wird, in Millisekunden.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_DURATION_MS: {
            title: 'Längster Tunnel',
            description: 'Wie lange ein Tunnel höchstens offen bleibt, in Millisekunden.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: {
            title: 'Erreichbare Ports für Tunnel',
            description: 'Ports, die Tunnel öffnen dürfen. Leer erlaubt nur die Standardports.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__TOKEN_TTL_MS: {
            title: 'Gültigkeit von Vorschaulinks',
            description: 'Wie lange ein privater Vorschaulink funktioniert, in Millisekunden.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: {
            title: 'Vorschaudomain',
            description: 'Domain, die jede Vorschau unter einer eigenen Adresse bereitstellt. Leer stellt Vorschauen unter der Adresse dieses Home bereit.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: {
            title: 'Modi für öffentliche Vorschauen',
            description: 'Wege, auf denen eine Vorschau öffentlich gemacht werden darf.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: {
            title: 'Längste öffentliche Vorschau',
            description: 'Wie lange eine Vorschau höchstens öffentlich bleibt, in Millisekunden. Leer behält das Standardlimit.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_CONCURRENT_EXPOSURES: {
            title: 'Gleichzeitige öffentliche Vorschauen',
            description: 'Höchstzahl gleichzeitig öffentlicher Vorschauen. Leer behält das Standardlimit.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: {
            title: 'DNS und TLS erforderlich',
            description: 'Öffentliche Vorschauen benötigen DNS und TLS.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_SINK: {
            title: 'Audit-Log für öffentliche Vorschauen',
            description: 'Wo öffentliche Vorschauen protokolliert werden. Öffentliche Vorschauen benötigen eines.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_LOG_PATH: {
            title: 'Audit-Log-Datei',
            description: 'Datei, in die das Audit-Log öffentlicher Vorschauen geschrieben wird.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: {
            title: 'Test-Audit-Log erlauben',
            description: 'Nur für die Entwicklung: akzeptiert das In-Memory-Test-Audit-Log. Wird in der Produktion ignoriert.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: {
            title: 'Ratenlimits für öffentliche Vorschauen',
            description: 'Ratenlimit-Profile, die öffentliche Vorschauen nutzen dürfen.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER: {
            title: 'Ratenlimit-Prüfer',
            description: 'Wie Anfragen an öffentliche Vorschauen begrenzt werden. Öffentliche Vorschauen benötigen einen.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS: {
            title: 'Anfragen pro Zeitfenster',
            description: 'Anfragen, die eine öffentliche Vorschau in jedem Zeitfenster erlaubt.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS: {
            title: 'Ratenlimit-Zeitfenster',
            description: 'Länge jedes Ratenlimit-Zeitfensters, in Millisekunden.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: {
            title: 'Test-Ratenbegrenzer erlauben',
            description: 'Nur für die Entwicklung: akzeptiert den In-Memory-Test-Ratenbegrenzer. Wird in der Produktion ignoriert.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_REQUESTS: {
            title: 'Laufende Webhooks',
            description: 'Höchstzahl an Webhook-Anfragen, die dieser Server gleichzeitig bearbeitet.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_WORKING_BYTES: {
            title: 'Webhook-Speicher',
            description: 'Höchstmenge an Arbeitsspeicher für laufende Webhook-Anfragen, in Bytes. Leer erlaubt, was das Anfragelimit bereits zulässt.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_RATE_PER_MINUTE: {
            title: 'Webhooks pro Minute und Route',
            description: 'Webhook-Anfragen pro Minute auf einer Route.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_CONCURRENCY: {
            title: 'Gleichzeitige Webhooks pro Route',
            description: 'Laufende Webhook-Anfragen auf einer Route.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_RATE_PER_MINUTE: {
            title: 'Webhooks pro Minute und Endpunkt',
            description: 'Webhook-Anfragen pro Minute auf einem Endpunkt.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_CONCURRENCY: {
            title: 'Gleichzeitige Webhooks pro Endpunkt',
            description: 'Laufende Webhook-Anfragen auf einem Endpunkt.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_RATE_PER_MINUTE: {
            title: 'Webhooks pro Minute und Person',
            description: 'Webhook-Anfragen pro Minute für eine Person.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_CONCURRENCY: {
            title: 'Gleichzeitige Webhooks pro Person',
            description: 'Laufende Webhook-Anfragen für eine Person.',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES: {
            title: 'Größtes Plugin-Ansichtspaket',
            description: 'Größtes Plugin-Ansichtspaket, das dieses Home hostet, in Bytes.',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES: {
            title: 'Speicher für Plugin-Ansichten pro Person',
            description: 'Höchstzahl an Bytes an Plugin-Ansichtspaketen, die eine Person speichern darf.',
        },
        HAPPIER_COLLECTION_MAX_ROW_ENCODED_BYTES: {
            title: 'Größte Plugin-Datenzeile',
            description: 'Größte Zeile, die ein Plugin speichert, in Bytes.',
        },
        HAPPIER_COLLECTION_MAX_BATCH_BYTES: {
            title: 'Größter Plugin-Datenbatch',
            description: 'Größter Batch an Plugin-Datenänderungen, in Bytes.',
        },
        HAPPIER_COLLECTION_MAX_BATCH_ROWS: {
            title: 'Zeilen pro Plugin-Datenbatch',
            description: 'Höchstzahl an Zeilen in einem Batch von Plugin-Datenänderungen.',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: {
            title: 'Plugin-Datenzeilen pro Person',
            description: 'Höchstzahl an Plugin-Datenzeilen, die eine Person speichern darf.',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_BYTES: {
            title: 'Plugin-Datenspeicher pro Person',
            description: 'Höchstzahl an Bytes an Plugin-Daten, die eine Person speichern darf.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_BITRATE_BPS: {
            title: 'Höchste Stream-Bitrate',
            description: 'Höchste Bitrate eines Livestreams über dieses Home, in Bits pro Sekunde.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAMES_PER_SECOND: {
            title: 'Höchste Stream-Bildrate',
            description: 'Höchste Bildrate eines Livestreams über dieses Home.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: 'Größter Stream-Frame',
            description: 'Größter Frame eines Livestreams über dieses Home, in Bytes.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_DURATION_MS: {
            title: 'Längster Livestream',
            description: 'Wie lange ein Livestream über dieses Home höchstens läuft, in Millisekunden.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_TOTAL_BYTES: {
            title: 'Daten pro Livestream',
            description: 'Höchstzahl an Bytes, die ein Livestream über dieses Home transportiert.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_ACCOUNT: {
            title: 'Gleichzeitige Livestreams pro Person',
            description: 'Höchstzahl an Livestreams über dieses Home, die eine Person gleichzeitig betreibt.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_SOCKET: {
            title: 'Gleichzeitige Livestreams pro Verbindung',
            description: 'Höchstzahl an Livestreams über dieses Home, die eine Verbindung gleichzeitig betreibt.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_MACHINE: {
            title: 'Gleichzeitige Livestreams pro Maschine',
            description: 'Höchstzahl an Livestreams über dieses Home, die eine Maschine gleichzeitig betreibt.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: {
            title: 'ID des Verbindungssignaturschlüssels',
            description: 'Benennt den Schlüssel, der Verbindungen zwischen Maschinen signiert. Ohne Signaturschlüssel sind diese Verbindungen aus.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: {
            title: 'Privater Verbindungssignaturschlüssel',
            description: 'Privater Schlüssel, der Verbindungen zwischen Maschinen signiert.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: {
            title: 'Öffentlicher Verbindungssignaturschlüssel',
            description: 'Öffentlicher Schlüssel passend zum Signaturschlüssel. Wenn leer, wird er aus dem privaten Schlüssel abgeleitet.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: {
            title: 'Ablauf des Signaturschlüssels',
            description: 'Wann der Signaturschlüssel abläuft, als Zeitstempel in Millisekunden.',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: {
            title: 'Freunde per Benutzername finden',
            description: 'Personen können Freunde per Benutzername und über verknüpfte Konten finden.',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__IDENTITY_PROVIDER: {
            title: 'Anbieter für Freundesabgleich',
            description: 'Der Anmeldeanbieter, mit dem Freunde abgeglichen werden.',
        },
    },
};

const homeFeatureTranslations = { de } as const;

return { homeFeatureTranslations };
})();

const Domain_homeGovernanceTranslations = (() => {
const en = Shared_homeGovernanceTranslations.en;

const de: typeof en = {
    title: 'Home-Verwaltung',
    pages: {
        features: 'Was dieses Home anbietet. Eine Änderung gilt überall beim nächsten Aktualisieren.',
        data: 'Was dieses Home aufbewahrt und wie lange.',
        homes: 'Konten, Rollen, Teams und Anmelderegeln für jedes Home, das du verwaltest.',
        overview: 'Wer dieses Home verwaltet und was du hier ändern kannst.',
        people: 'Konten auf diesem Home, ihre Rollen und ob sie sich anmelden können.',
        policies: 'Wer sich anmelden kann, wie Konten erstellt werden und wie Daten geschützt sind.',
        teams: 'Alle Teams auf diesem Home. Die Verwaltung eines Teams gibt dir keinen Zugriff auf seine Sitzungen.',
        identityProvider: 'Ein Identitätsdienst, mit dem sich Personen auf diesem Home anmelden können.',
        identityProviderEditor: 'Wie sich dieser Identitätsdienst verbindet und wen er zulässt.',
        githubApp: 'Eine GitHub App, mit der dieses Home auf Repositorys zugreift.',
        githubAppEditor: 'Registriere oder ändere eine GitHub App für dieses Home.',
        email: 'Wie dieses Home E-Mails sendet.',
        reach: 'Wie Geräte, Einladungslinks und E-Mails dieses Home finden.',
        runtime: 'Der Server, auf dem dieses Home läuft.',
        activity: 'Wer was an diesem Home geändert hat und wann.',
    },
    overview: 'Übersicht',
    people: 'Personen',
    teams: 'Teams',
    policies: 'Richtlinien',
    console: {
        serverSettings: 'Servereinstellungen',
        serverSettingsDescription: 'Jede Einstellung, die der Server liest, und wann eine Änderung gilt.',
        allHomes: 'Alle Homes',
        backToHomes: 'Zurück zu den Homes',
        viewerOwner: 'Du bist Eigentümer',
        viewerAdmin: 'Du bist Admin',
        noOwnerYet: 'Noch kein Eigentümer',
        administer: 'Verwalten',
        navigation: 'Seiten der Home-Verwaltung',
    },
    /** The console Overview (lab `hcOverview-A`): what needs the owner, who owns the Home, and its facts. */
    overviewPage: {
        description: 'Wer dieses Home betreibt und was es von dir braucht.',
        attention: 'Braucht deine Aufmerksamkeit',
        emailNotSetUpTitle: 'E-Mail ist nicht eingerichtet',
        emailNotSetUpBody: 'Personen können ihre Adresse nicht bestätigen, kein Passwort zurücksetzen und keine Einladungen per E-Mail erhalten.',
        emailNoLinkTitle: 'E-Mails können noch keine Links enthalten',
        emailNoLinkBody: 'Der Versand ist eingerichtet, aber dieses Home hat keine Web-App-Adresse für Links.',
        emailPasswordTitle: 'Das Mail-Passwort kann nicht gelesen werden',
        emailPasswordBody: 'Gib das SMTP-Passwort erneut ein, damit dieses Home E-Mails senden kann.',
        setUpEmail: 'E-Mail einrichten',
        openEmail: 'E-Mail öffnen',
        noAddressTitle: 'Keine öffentliche Adresse',
        noAddressBody: 'Geräte in anderen Netzwerken und Einladungslinks erreichen dieses Home nicht.',
        setUpReach: 'Einrichten',
        githubPartlySetUp: 'GitHub-Anmeldung ist nur teilweise eingerichtet',
        workosPartlySetUp: 'WorkOS ist nur teilweise eingerichtet',
        workosNeedsClientIdBody: 'Es braucht eine Client-ID, bevor Teams die Firmenanmeldung verbinden können.',
        workosNeedsApiKeyBody: 'Es braucht einen API-Schlüssel, bevor Teams die Firmenanmeldung verbinden können.',
        githubNeedsClientIdBody: 'Es braucht eine Client-ID, bevor sich Personen mit GitHub anmelden können.',
        githubNeedsClientSecretBody: 'Es braucht ein Client-Secret, bevor sich Personen mit GitHub anmelden können.',
        finish: 'Abschließen',
        nameDescription: 'Wird in der App und in Einladungen angezeigt.',
        review: 'Prüfen',
        settingsFailed: 'Die Einstellungen dieses Homes konnten nicht geprüft werden',
        emailFailed: 'Der Mail-Status dieses Homes konnte nicht gelesen werden',
        reachFailed: 'Wie dieses Home erreicht wird, konnte nicht gelesen werden',
        ownership: 'Eigentümer',
        ownerYou: 'Eigentümer · du',
        peopleFailed: 'Die Personen dieses Homes konnten nicht gelesen werden',
        thisHome: 'Dieses Home',
        version: 'Version',
        signIn: 'Anmeldung',
        signInOpen: 'jeder kann ein Konto erstellen',
        signInInvited: 'nur mit Einladung',
        signInNone: 'Keine Anmeldemethode ist aktiv',
        /** People · owners · admins; `more` while the Home has further pages, `admins` null when unknown. */
        peopleSummary: ({ people, more, owners, admins }: { people: number; more: boolean; owners: number; admins: number | null }) => [`${people}${more ? '+' : ''} ${people === 1 && !more ? 'Person' : 'Personen'}`, `${owners} Eigentümer`, admins === null ? null : `${admins} ${admins === 1 ? 'Admin' : 'Admins'}`].filter((part) => part !== null).join(' · '),
    },
    /** "Invite people" on Overview, People and Teams: one dialog over the Team invitation form. */
    invite: {
        action: 'Personen einladen',
        description: 'Personen treten diesem Home bei, indem sie einem seiner Teams beitreten.',
        team: 'Team',
        noTeams: 'Es gibt noch kein Team, in das du einladen kannst',
        noTeamsBody: 'Personen treten einem Home über ein Team bei. Erstelle zuerst eines.',
        notAdministered: 'Du kannst nicht in die Teams dieses Homes einladen',
        notAdministeredBody: 'Die Eigentümer und Admins eines Teams laden Personen ein. Frag eine dieser Personen oder erstelle ein eigenes Team.',
        createTeam: 'Team erstellen',
        notAdministeredAskBody: 'Die Eigentümer und Admins eines Teams laden Personen ein; frag eine dieser Personen.',
        joinByTeam: 'Personen treten einem Home über ein Team bei.',
        teamsFailed: 'Die Teams dieses Homes konnten nicht gelesen werden',
    },

    yourRole: 'Deine Rolle',
    roleOwner: 'Eigentümer',
    roleAdmin: 'Administrator',
    roleMember: 'Mitglied',
    activeOwners: 'Aktive Eigentümer',
    accountSection: 'Konto',
    accountAccessSection: 'Zugang',
    homeAddress: 'Home-Adresse',

    setupRequiredTitle: 'Einrichtung der Home-Verwaltung erforderlich',
    setupRequiredBody: 'Dieses Home hat noch keinen aktiven Eigentümer. Eine Person mit Serverzugriff weist den ersten Eigentümer direkt auf dem Server zu.',

    manageTeams: 'Teams verwalten',
    manageTeamsSubtitle: 'Teams auf diesem Home verwalten. Das gibt dir keinen Zugriff auf deren Sessions.',
    teamsDisabled: 'Teams sind auf diesem Home nicht aktiviert.',
    teamsEmpty: 'Auf diesem Home gibt es noch keine Teams.',

    loading: 'Home wird geladen…',
    refreshing: 'Wird aktualisiert…',
    updating: 'Wird aktualisiert…',
    staleNotice: 'Zeigt den letzten bekannten Stand dieses Homes. Änderungen sind nicht möglich, bis es wieder antwortet.',
    offlineNotice: 'Dieses Home antwortet nicht. Du kannst weiterlesen, Änderungen sind aber nicht möglich.',
    unavailableTitle: 'Dieses Home ist nicht verfügbar',
    unavailableBody: 'Happier konnte den Verwaltungsstand dieses Homes nicht lesen.',
    forbiddenTitle: 'Du kannst dieses Home nicht verwalten',
    forbiddenBody: 'Dein Konto hat hier keine Berechtigung zur Home-Verwaltung.',
    retry: 'Erneut versuchen',
    loadMore: 'Mehr laden',
    unsupportedBody: 'Dieses Home bietet keine Home-Verwaltung. Möglicherweise läuft eine ältere Version.',
    notObservedTitle: 'Noch nicht geladen',
    notObservedBody: 'Dieses Home hat seinen Verwaltungsstand noch nicht an dieses Gerät gemeldet.',
    lastUpdated: ({ time }: { time: string }) => `Zuletzt aktualisiert ${time}`,

    chooseHome: 'Home auswählen',
    chooseHomeFooter: 'Jedes Home hat eigene Konten, Rollen und Richtlinien.',
    homesEmpty: 'Noch keine Homes',
    homesEmptyBody: 'Füge diesem Gerät ein Home hinzu, um es hier zu verwalten.',
    homesNoneAdministrable: 'Kein Home zum Verwalten',
    homesNoneAdministrableBody: 'Keines der angezeigten Homes gibt diesem Konto Home-Verwaltungsrechte.',
    homeNotAnswering: ({ home }: { home: string }) => `${home} antwortet nicht`,
    signedOutTitle: 'Von diesem Home abgemeldet',
    signedOutBody: 'Melde dich wieder bei diesem Home an, um es zu verwalten.',
    credentialUnreadableTitle: 'Die gespeicherte Anmeldung auf diesem Gerät konnte nicht gelesen werden',
    credentialUnreadableBody: 'Das Problem liegt auf diesem Gerät, nicht beim Home, und du wurdest nicht abgemeldet. Versuche es erneut.',
    credentialUnreadableInviteBody: 'Das Problem liegt auf diesem Gerät, nicht beim Home. Dein Einladungslink funktioniert weiterhin, du kannst es also jetzt erneut versuchen oder später darauf zurückkommen.',

    peopleEmpty: 'Noch keine Konten auf diesem Home.',
    rosterUnavailableTitle: 'Die Personenliste ist noch nicht verfügbar',
    rosterUnavailableBody: 'Dieses Home stellt Happier noch keine Kontenliste bereit. Rollen und Kontostatus erscheinen hier, sobald das der Fall ist.',
    accountUnavailableBody: 'Dieses Konto ist von diesem Home noch nicht verfügbar.',
    searchPlaceholder: 'Konten suchen',
    searchResults: 'Suchergebnisse',
    searchResultsFooter: 'Öffne ein Konto, um Rolle und Status zu sehen.',
    searchEmpty: 'Keine Konten passen zu dieser Suche.',
    searchUnsupported: 'Suche auf diesem Home nicht verfügbar',
    searchUnsupportedBody: 'Dieses Home bietet keine Kontosuche. Möglicherweise läuft dort eine ältere Version.',
    searchFailed: 'Die Suche konnte nicht abgeschlossen werden',
    searchFailedBody: 'Dieses Home hat auf die Suche nicht geantwortet. Ändere den Text, um es erneut zu versuchen.',

    statusActive: 'Aktiv',
    statusDisabled: 'Deaktiviert',
    statusRetired: 'Stillgelegt',
    statusDisabledDetail: 'Überall abgemeldet. Kann wieder aktiviert werden.',
    statusRetiredDetail: 'Zugriff dauerhaft entzogen.',

    changeRole: 'Rolle ändern',
    disable: 'Konto deaktivieren',
    enable: 'Konto wieder aktivieren',
    deleteAccount: 'Konto und Daten löschen…',
    retryDeletion: 'Löschen erneut versuchen',

    reasonLastActiveOwner: 'Dieses Home braucht mindestens einen aktiven Eigentümer. Mach zuerst ein anderes Konto zum Eigentümer.',
    reasonTargetInactive: 'Nur ein aktives Konto kann eine Home-Rolle haben.',
    reasonHomeUnreachable: 'Dieses Home antwortet nicht. Änderungen sind erst nach der Wiederverbindung möglich.',

    roleSheetTitle: 'Home-Rolle',
    roleOwnerDescription: 'Kann alles auf diesem Home verwalten, einschließlich Konten löschen.',
    roleAdminDescription: 'Kann Konten und Teams verwalten, aber keine Eigentümer ändern.',
    roleMemberDescription: 'Keine Berechtigung zur Home-Verwaltung.',

    disableTitle: ({ account }: { account: string }) => `${account} deaktivieren?`,
    disableBody: 'Die Person wird auf allen Geräten abgemeldet und ihre Maschinen trennen die Verbindung. Persönliche Zugriffstoken werden dauerhaft widerrufen, die Session-Verantwortung wird aufgehoben, und in jeder Session, auf die sie den Zugriff verliert, werden ihre ungesendeten Entwürfe verworfen und ihr Folgen entfernt. Beim Wiederaktivieren kehrt der Zugriff zurück, nicht aber diese Entwürfe, das Folgen oder die Verantwortung. Team-Mitgliedschaft und Schlüssel bleiben erhalten.',
    disableConfirm: 'Deaktivieren',
    enableTitle: ({ account }: { account: string }) => `${account} wieder aktivieren?`,
    enableBody: 'Die Person kann sich auf ihren Geräten wieder anmelden. Zuvor entzogene Zugriffstoken bleiben entzogen.',
    enableConfirm: 'Wieder aktivieren',
    deleteTitle: ({ account }: { account: string }) => `${account} und alle zugehörigen Daten löschen?`,
    deleteBody: ({ home }: { home: string }) => `Das löscht das Konto und seine Daten auf ${home} dauerhaft. Es kann nicht rückgängig gemacht werden. Home- oder Team-Eigentum muss vorher übertragen werden.`,
    deleteConfirm: 'Löschen',

    deleteIncompleteTitle: 'Löschen wurde nicht abgeschlossen',
    deleteIncompleteBody: 'Der Zugriff wurde entzogen und dieses Konto ist jetzt stillgelegt, aber die Bereinigung wurde nicht abgeschlossen. Versuche das Löschen erneut.',
    deleteIncompleteMemberBody: 'Der Zugriff wurde entzogen, aber die Bereinigung wurde nicht abgeschlossen. Ein Home-Eigentümer oder der Serverbetreiber kann sie abschließen.',

    errorForbidden: 'Du hast für diese Änderung auf diesem Home keine Berechtigung mehr.',
    errorOwnerTransferRequired: 'Dieses Home braucht mindestens einen aktiven Eigentümer. Mach zuerst ein anderes Konto zum Eigentümer.',
    errorTeamOwnerTransferRequired: 'Ein Team braucht dieses Konto noch als Eigentümer. Gib diesem Team zuerst einen anderen Eigentümer.',
    errorAccountNotFound: 'Dieses Konto existiert auf diesem Home nicht mehr.',
    errorAccountInactive: 'Dieses Konto ist nicht aktiv und kann diese Berechtigung nicht erhalten.',
    errorErasureTransitionCleanupPending: 'Das Löschen des Kontos wartet auf die Verschlüsselungsbereinigung. Versuche erneut, das Konto zu löschen.',
    errorGeneric: 'Dieses Home konnte die Änderung nicht abschließen. Es wurde nichts geändert.',
    errorConflict: 'Hier wurde zuerst etwas anderes geändert. Lade dieses Home neu und versuche es erneut.',
    changeFailedTitle: 'Die Änderung wurde nicht ausgeführt',
    errorOutcomeUnknownTitle: 'Diese Änderung wurde nicht bestätigt',
    errorOutcomeUnknown: 'Die Anfrage hat dieses Home erreicht, aber die Antwort ging verloren. Sie wurde möglicherweise ausgeführt. Lade dieses Home neu und prüfe es, bevor du es erneut versuchst.',

    teamCreation: 'Team-Erstellung',
    teamCreationSelfService: 'Alle können Teams erstellen',
    teamCreationSelfServiceDescription: 'Aktive Mitglieder dieses Homes können ein Team erstellen und werden dessen Eigentümer.',
    teamCreationManagedOnly: 'Administratoren erstellen Teams',
    teamCreationManagedOnlyDescription: 'Eigentümer und Administratoren erstellen Teams und wählen den ersten Eigentümer.',
    teamCreationDisabled: 'Team-Erstellung deaktiviert',
    teamCreationDisabledDescription: 'Keine neuen Teams. Bestehende Teams bleiben unverändert.',
    teamCreationWho: 'Wer Teams erstellen kann',
    teamCreationAnyone: 'Alle',
    teamCreationAdmins: 'Admins',
    teamCreationNobody: 'Niemand',
    teamsVisibility: 'Wer Teams sieht',
    teamsVisibleToMembers: 'Teams für Mitglieder anzeigen',
    teamsVisibleToMembersDescription: 'Wenn aus, sehen nur Mitglieder eines Teams und Administratoren die Teams.',
    teamJit: 'Automatische Team-Mitgliedschaft bei der Anmeldung',
    teamJitDescription: 'Wer sich über den verbundenen Identitätsanbieter eines Teams anmeldet, tritt diesem Team automatisch bei – ohne Einladung oder Freigabe.',
    githubEnterpriseOrigins: 'Genehmigte GitHub-Enterprise-Hosts',
    githubEnterpriseOriginsDescription: 'Eine kanonische HTTPS-Origin pro Zeile. Teams können GitHub Apps nur mit diesen Hosts verbinden.',
    githubEnterpriseOriginsInvalid: 'Verwende eindeutige HTTPS-Origins ohne Pfade, Abfragen, Zugangsdaten oder Fragmente.',

    signInTitle: 'Anmeldung und Zugang',
    authActionLogin: 'Anmeldung',
    authActionProvision: 'Neue Konten',
    authActionConnect: 'Kontoverknüpfung',
    authReasonMethodNotEnabled: 'Anmeldemethode ist deaktiviert',
    authReasonProvisioningNotEnabled: 'Kontoerstellung ist deaktiviert',
    authReasonAccountModeUnavailable: 'Kontotyp ist nicht verfügbar',
    authReasonEmailDeliveryUnavailable: 'E-Mail-Versand ist nicht verfügbar',
    authInherited: 'Servervorgaben werden verwendet',
    authInheritedDescription: 'Dieses Home schränkt Anmeldemethoden und Kontotypen nicht weiter ein.',
    authNarrowed: 'Durch dieses Home eingeschränkt',
    authUnreadable: 'Konfiguration braucht Aufmerksamkeit',
    authUnreadableDescription: 'Dieses Home speichert eine Anmeldekonfiguration, die diese Serverversion nicht lesen kann. Die Anmeldung ist nicht verfügbar, bis dein Betreiber sie repariert.',
    signInMethods: 'Anmeldemethoden',
    accountModes: 'Kontotypen',
    accountModePlain: 'Einfach',
    accountModeE2ee: 'Ende-zu-Ende-verschlüsselt',
    recommendedMode: 'Empfohlen für neue Konten',
    recommendedModeDescription: 'Legt den Standard für neue Konten fest. Bestehende Konten werden nicht geändert.',
    admissionSelfService: 'Alle',
    admissionInvitationOnly: 'Nur mit Einladung',
    admissionClosed: 'Niemand',

    deploymentServices: 'Deployment-Dienste',
    deploymentServicesDescription: 'Identitätsdienste, die der Betreiber für diesen Server konfiguriert. Sie lassen sich nicht in der Home-Verwaltung ändern.',
    privateEndpoints: 'Private Identitäts-Endpunkte',
    privateEndpointsDescription: 'Verwaltete Anmeldung darf Identitätsanbieter in privaten Netzwerken erreichen. Nur die hier aufgeführten Hosts, Netzwerke und Ports sind erreichbar.',
    privateEndpointsPublicOnly: 'Nur öffentliche Endpunkte',
    privateEndpointsAllowlist: 'Private Zulassungsliste',
    privateEndpointsHostnames: 'Erlaubte Hostnamen',
    privateEndpointsCidrs: 'Erlaubte Netzwerke (CIDR)',
    privateEndpointsPorts: 'Erlaubte Ports',
    privateEndpointsSave: 'Netzwerkrichtlinie speichern',
    privateEndpointsInvalid: 'Gib mindestens einen Hostnamen oder ein Netzwerk und einen Port zwischen 1 und 65535 an.',
    privateEndpointsUnreadable: 'Dieses Home speichert eine Netzwerkrichtlinie, die diese Serverversion nicht lesen kann. Die verwaltete Anmeldung bleibt auf öffentlichen Endpunkten.',

    policyReadOnly: 'Nur ein Home-Eigentümer kann das ändern.',
    policyEditingUnavailable: 'Richtlinien können von diesem Gerät noch nicht geändert werden.',
    revisionConflictTitle: 'Diese Richtlinie wurde anderswo geändert',
    revisionConflictBody: 'Jemand anderes hat gespeichert, während du bearbeitet hast. Deine Auswahl bleibt erhalten — lade dieses Home neu und wende sie erneut an.',
    reload: 'Neu laden',
    person: {
        you: 'du',
        roleDescription: 'Mitglieder nutzen das Home; Admins verwalten zusätzlich Personen und Teams.',
        roleChangeTitle: ({ account, role }: { account: string; role: string }) => `${account} zu ${role} machen?`,
        roleChangeBody: 'Der Zugriff auf dieses Home ändert sich sofort. Das wird mit deinem Namen in der Aktivität festgehalten.',
        roleChangeConfirm: 'Rolle ändern',
        signIn: 'Anmeldung',
        signInDescription: 'Womit sich die Person anmelden kann. Sie verwaltet das in ihrem eigenen Konto.',
        methods: 'Methoden',
        linkedProviders: 'Verknüpfte Anbieter',
        none: 'Keine',
        teams: 'Teams',
        noTeams: 'In keinem Team',
        teamArchived: 'archiviertes Team',
        teamSuspended: 'gesperrt',
        access: 'Zugriff',
        accessDescription: 'Auf ihren Geräten angemeldet — Sitzungen werden nicht einzeln erfasst.',
        machines: 'Maschinen',
        apiTokens: 'API-Tokens',
        apiTokensLastUsed: ({ time }: { time: string }) => `Zuletzt verwendet ${time}`,
        apiTokensNeverUsed: 'Nie verwendet',
        signOutEverywhere: 'Überall abmelden',
        signOutEverywhereDescription: 'Beendet jede angemeldete Sitzung auf allen Geräten. API-Tokens funktionieren weiter, bis das Konto deaktiviert wird.',
        signOutEverywhereTitle: ({ account }: { account: string }) => `${account} überall abmelden?`,
        signOutEverywhereBody: 'Jedes Gerät, auf dem die Person angemeldet ist, muss sich neu anmelden. Ihre API-Tokens funktionieren weiter, bis du das Konto deaktivierst. Das wird mit deinem Namen in der Aktivität festgehalten.',
        signOutEverywhereDone: 'Überall abgemeldet',
        recentActivity: 'Letzte Aktivität',
        noRecentActivity: 'Noch keine Verwaltungsänderungen zu dieser Person.',
        showAllActivity: 'Alle anzeigen',
        disableOrDelete: 'Deaktivieren oder löschen',
        dangerFootnote: 'Deaktivieren meldet die Person ab und stoppt ihre API-Tokens; das lässt sich rückgängig machen. Löschen entfernt ihr Konto und ihre Daten endgültig von diesem Home.',
    },
    email: {
        title: 'E-Mail',
        status: 'Status',
        sendingMail: 'E-Mail-Versand',
        sendingReady: ({ host }: { host: string }) => `Bereit · sendet über ${host}`,
        sendingNotSetUp: 'Nicht eingerichtet',
        links: 'Links in E-Mails',
        linksReady: 'Öffnen in der Web-App dieses Homes',
        linksOpenAt: ({ host }: { host: string }) => `Öffnen unter ${host}`,
        setInReach: 'In Erreichbarkeit festlegen',
        linksMissing: 'Keine Web-App-Adresse, daher können keine Links erstellt werden',
        mailServer: 'Mailserver',
        mailServerDescription: 'Der SMTP-Server, der Bestätigungs-, Passwort-Zurücksetzungs- und Einladungs-E-Mails sendet.',
        server: 'Server',
        port: 'Port',
        portAndSecurity: 'Port und Sicherheit',
        security: 'Verbindungssicherheit',
        tls: 'TLS',
        starttls: 'STARTTLS',
        username: 'Benutzername',
        password: 'Passwort',
        passwordDescription: 'Verschlüsselt auf dem Server gespeichert. Es wird nie wieder angezeigt.',
        saved: 'Gespeichert',
        replace: 'Ersetzen',
        clear: 'Entfernen',
        keep: 'Behalten',
        clearPending: 'Das gespeicherte Passwort wird beim Speichern entfernt.',
        valueSet: 'Gesetzt',
        valueNotSet: 'Nicht gesetzt',
        sender: 'Absender',
        fromAddress: 'Absenderadresse',
        fromName: 'Absendername',
        test: 'Test-E-Mail senden',
        testDescription: 'Sendet eine kurze Nachricht ohne Links.',
        testTo: 'An',
        testToPlaceholder: 'Eine Adresse, die du prüfen kannst',
        testSend: 'Senden',
        testSaveFirst: 'Speichere deine Änderungen, bevor du einen Test sendest.',
        testSent: ({ to }: { to: string }) => `Gesendet an ${to}`,
        testSentDetail: 'Sieh im Posteingang nach und im Spam-Ordner, falls sie dort nicht ist.',
        testFailed: 'Senden fehlgeschlagen',
        testNotConfigured: 'E-Mail ist noch nicht eingerichtet.',
        testPasswordUnreadable: 'Das gespeicherte Passwort kann nicht gelesen werden. Gib es erneut ein.',
        testRenderFailed: 'Die Testnachricht konnte nicht vorbereitet werden.',
        testTransportFailed: 'Der Mailserver war nicht erreichbar oder hat die Nachricht abgelehnt.',
        adminTitle: 'Nur Owner können E-Mail-Einstellungen ändern',
        adminBody: 'Du siehst sie, weil du Admin dieses Homes bist.',
        notSetUpTitle: 'E-Mail ist nicht eingerichtet',
        notSetUpBody: 'Passwort-Zurücksetzung, E-Mail-Bestätigung und Einladungen per E-Mail sind aus, bis sie eingerichtet ist.',
        unreadableTitle: 'Das gespeicherte Passwort kann nicht gelesen werden',
        unreadableBody: 'Das Master-Secret des Servers hat sich seit dem Speichern geändert. Gib das Passwort erneut ein.',
        invalidValue: 'Gib einen gültigen Wert ein.',
        invalidPort: 'Verwende einen Port von 1 bis 65535.',
        invalidEmail: 'Gib eine E-Mail-Adresse ein.',
        conflictTitle: 'E-Mail-Einstellungen wurden anderswo geändert',
        conflictBody: 'Jemand hat während deiner Bearbeitung eine Änderung gespeichert. Deine Änderungen bleiben erhalten: prüfe sie und speichere erneut.',
        loadFailed: 'Dieses Home hat seine E-Mail-Einstellungen nicht geliefert.',
    },
    signInProviders: {
        title: 'Anmeldeanbieter',
        description: 'Wie sich Personen bei diesem Home anmelden und was seine Teams verbinden können.',
        ownersOnlyTitle: 'Nur Eigentümer können Anmeldeanbieter ändern',
        ownersOnlyBody: 'Bitte eine Eigentümerin oder einen Eigentümer dieses Home, Identitätsanbieter und GitHub Apps hinzuzufügen oder zu ändern.',
        fromDeploymentReadOnly: 'Aus deiner Bereitstellung · schreibgeschützt',
        platformsDescriptionReadOnly: ({ home }: { home: string }) => `Apps, über die sich Personen bei ${home} anmelden. Nur Eigentümer von ${home} können sie ändern.`,
        fieldClientId: 'Client-ID',
        fieldClientSecret: 'Client-Secret',
        fieldApiKey: 'API-Schlüssel',
        workosClientIdHint: 'In WorkOS unter API-Schlüssel.',
        githubClientIdHint: 'Auf der Einstellungsseite deiner GitHub-OAuth-App.',
        secretHintUnset: 'Wird verschlüsselt gespeichert und nie wieder angezeigt.',
        secretHintSet: 'Verschlüsselt gespeichert, nie angezeigt.',
        neededWorkos: 'Nötig, bevor Teams sich verbinden können',
        neededGithub: 'Nötig, bevor die GitHub-Anmeldung eingeschaltet werden kann',
        secretPlaceholder: 'Schlüssel einfügen',
        lockedFootnote: 'Von deiner Bereitstellung gesetzte Werte lassen sich nur dort ändern, wo der Server läuft.',
        ignoredBannerTitle: 'Eine Anmeldeeinstellung wurde beim letzten Start ignoriert',
        showMe: 'Zeigen',
        callbackAddress: 'Callback-Adresse',
        callbackAddressHint: 'Trage sie in der GitHub-OAuth-App ein.',
        whoCanSignInGithub: 'Wer sich mit GitHub anmelden kann',
        companySignIn: 'Firmenanmeldung',
        companySignInDescription: 'OpenID-Connect-Anbieter, mit denen sich Personen und Teams anmelden können.',
        addProvider: 'Anbieter hinzufügen',
        privateEndpointsTitle: 'Private Endpunkte',
        privateEndpointsPublicOnlyShort: 'Nur öffentlich',
        privateEndpointsAllowlistShort: 'Zulassungsliste',
        privateEndpointsPublicOnlyHint: 'Anbieter müssen unter einer öffentlichen Adresse erreichbar sein.',
        privateEndpointsAllowlistHint: 'Nur die Hosts unten dürfen privat sein.',
        platforms: 'Anmeldeplattformen',
        platformsDescription: ({ home }: { home: string }) => `Apps, über die sich Personen bei ${home} anmelden: GitHub für alle, WorkOS für die Firmenanmeldung jedes Teams.`,
        githubSignIn: 'GitHub-Anmeldung',
        githubPurpose: ({ home }: { home: string }) => `Die GitHub-OAuth-App, mit der sich Personen bei ${home} über GitHub anmelden. Die GitHub-Anmeldung schaltest du unter Richtlinien ein oder aus.`,
        workosPurpose: ({ home }: { home: string }) => `Damit kann jedes Team auf ${home} seine eigene Firmenanmeldung und sein Verzeichnis über WorkOS verbinden – auf der Authentifizierungsseite des Teams.`,
        notSetGithub: 'Nicht eingerichtet · GitHub-Anmeldung bleibt bis dahin aus',
        notSetWorkos: 'Nicht eingerichtet · Teams können WorkOS noch nicht nutzen',
        needsClientId: 'Benötigt eine Client-ID',
        needsClientSecret: 'Benötigt ein Client-Secret',
        needsApiKey: 'Benötigt einen API-Schlüssel',
        pendingSummaryWorkos: 'Gespeichert · Teams können sich nach dem nächsten Neustart verbinden',
        pendingSummaryGithub: 'Gespeichert · wird nach dem nächsten Neustart verwendet',
        lockedSummary: 'Von deiner Bereitstellung gesetzt',
        readyPartlyLocked: ({ setting }: { setting: string }) => `Bereit · ${setting} von deiner Bereitstellung gesetzt`,
        readyWorkos: 'Bereit · Teams können sich darüber verbinden',
        readyGithubOn: 'Bereit · Personen können sich mit GitHub anmelden',
        readyGithubOff: 'Bereit · GitHub-Anmeldung unter Richtlinien einschalten',
        advanced: 'Erweitert',
        appliesAfterRestart: 'Änderungen hier gelten nach einem Neustart des Servers.',
        privateEndpointsOffHere: 'Für dieses Home aus',
        teamRules: 'Anmelderegeln für Teams',
        teamRulesDescription: 'Was Teams zusätzlich zu den Anbietern des Home hinzufügen dürfen.',
        activity: {
            addedProvider: ({ name }: { name: string }) => `hat den Identitätsanbieter ${name} hinzugefügt`,
            changedProvider: ({ name }: { name: string }) => `hat den Identitätsanbieter ${name} geändert`,
            replacedProviderSecret: ({ name }: { name: string }) => `hat das Client-Secret von ${name} ersetzt`,
            enabledProvider: ({ name }: { name: string }) => `hat ${name} eingeschaltet`,
            disabledProvider: ({ name }: { name: string }) => `hat ${name} ausgeschaltet`,
            removedProvider: ({ name }: { name: string }) => `hat den Identitätsanbieter ${name} entfernt`,
            addedGitHubApp: ({ name }: { name: string }) => `hat die GitHub App ${name} hinzugefügt`,
            changedGitHubApp: ({ name }: { name: string }) => `hat die GitHub App ${name} geändert`,
            replacedGitHubAppSecrets: ({ name }: { name: string }) => `hat die Secrets der GitHub App ${name} ersetzt`,
            verifiedGitHubApp: ({ name, organization }: { name: string; organization: string }) => `hat ${name} für ${organization} bestätigt`,
            removedGitHubAppInstallation: ({ name, organization }: { name: string; organization: string }) => `hat ${name} aus ${organization} entfernt`,
        },
    },
    reach: {
        title: 'Erreichbarkeit',
        diagramTitle: ({ home }: { home: string }) => `Wie ein neues Gerät ${home} erreicht`,
        yourDevices: 'Deine Geräte',
        noAddress: 'Keine öffentliche Adresse',
        plusDirect: '+ direkt (Iroh), wenn möglich',
        noDirect: 'Keine Direktverbindungen',
        thisComputer: 'Dieser Computer',
        homeServer: 'Server dieses Home',
        diagramDeployment: 'Von deiner Bereitstellung festgelegt',
        diagramHere: 'Hier festgelegt',
        diagramInferred: ({ method }: { method: string }) => `${method} · abgeleitet`,
        addresses: 'Adressen',
        addressesDescription: 'Eine Adresse zu ändern meldet niemanden ab.',
        publicAddress: 'Öffentliche Adresse',
        webAppAddress: 'Adresse der Web-App',
        accessMethod: 'Zugriffsmethode',
        publicAddressHome: 'Hier festgelegt',
        publicAddressNone: 'Nicht festgelegt. Geräte in anderen Netzwerken erreichen dieses Home nicht.',
        inferredFrom: ({ method }: { method: string }) => `Aus ${method} auf dem Computer abgeleitet, der dieses Home hostet`,
        inferredFromHost: 'Auf dem Computer abgeleitet, der dieses Home hostet',
        webAppDescription: 'Links in E-Mails und Einladungen öffnen sich hier.',
        webAppServed: 'Links öffnen sich in der Web-App, die dieses Home bereitstellt.',
        webAppDefault: 'Links öffnen sich in der Happier-Web-App. Standard',
        change: 'Ändern',
        setAddress: 'Adresse festlegen',
        httpsRequired: 'Verwende eine https://-Adresse.',
        invalidAddress: 'Gib eine vollständige Adresse ein, z. B. https://home.example.com.',
        conflict: 'Die Einstellungen dieses Home haben sich geändert. Versuche es erneut.',
        methodLocalOnly: 'Nur dieser Computer',
        methodLan: 'Lokales Netzwerk',
        methodTailscaleServe: 'Tailscale Serve',
        methodTailscaleFunnel: 'Tailscale Funnel',
        methodCloudflare: 'Cloudflare Tunnel',
        accessMethodHere: 'Wie dieser Computer das Home zugänglich macht.',
        accessMethodRemoteHost: ({ host }: { host: string }) => `Wird auf ${host} festgelegt. Öffne ihn unter Remote-Hosts.`,
        accessMethodElsewhereNamed: ({ host }: { host: string }) => `Wird auf dem Computer festgelegt, der dieses Home hostet (${host}). Öffne Happier dort oder füge ihn als Remote-Host hinzu.`,
        accessMethodElsewhere: 'Wird auf dem Computer festgelegt, der dieses Home hostet. Öffne Happier dort oder füge ihn als Remote-Host hinzu.',
        accessMethodDeployment: 'Wird von deiner Bereitstellung verwaltet.',
        directConnections: 'Direktverbindungen',
        directConnectionsDescription: 'Geräte verbinden sich direkt mit diesem Home, wenn möglich, sonst über die öffentliche Adresse.',
        directConnectionsRow: 'Direktverbindungen (Iroh)',
        irohActive: 'Aktiv · Geräte verbinden sich direkt, wenn möglich',
        irohStarting: 'Wird gestartet …',
        irohOff: 'Aus · Geräte verbinden sich über die öffentliche Adresse',
        irohFailed: 'Läuft auf diesem Computer nicht. Geräte verbinden sich über die öffentliche Adresse.',
        irohNotAvailable: 'Auf dieser Bereitstellung nicht verfügbar. Geräte verbinden sich über die öffentliche Adresse.',
        irohNeedsAddressHint: 'Lege zuerst eine öffentliche Adresse fest',
        irohOffTitle: 'Direktverbindungen ausschalten?',
        irohOffBody: 'Geräte verbinden sich dann nur noch über die öffentliche Adresse. Die aktuelle Direktverbindungs-Identität dieses Home wird endgültig stillgelegt; beim Wiedereinschalten entsteht eine neue, die Geräte bei ihrer nächsten Verbindung übernehmen. Die öffentliche Adresse und alle Anmeldungen bleiben gleich.',
        irohOffConfirm: 'Ausschalten',
        irohNeedsAddressTitle: 'Lege zuerst eine öffentliche Adresse fest',
        irohNeedsAddressBody: 'Ohne öffentliche Adresse könnten Geräte dieses Home nach dem Ausschalten der Direktverbindungen nicht mehr erreichen.',
        relay: 'Relay für Direktverbindungen',
        relayAutomatic: 'Automatisch',
        relayOff: 'Aus',
        relayCustom: ({ count }: { count: number }) => `Eigene Relays (${count}) · Gilt nach dem Neustart`,
        appliesAfterRestart: 'Gilt nach dem Neustart',
        appliesAfterRestartPending: 'Gilt nach dem Neustart · Ausstehend',
        exposureInternetTitle: ({ method }: { method: string }) => `Über ${method} aus dem Internet erreichbar`,
        exposureAddressTitle: 'Deine öffentliche Adresse ist für Registrierungen offen',
        exposureOpenSignup: 'Wer dieses Home erreicht, kann ein Konto erstellen. Prüfe in den Richtlinien, wer sich registrieren darf.',
        exposureInvitationOnly: 'Neue Konten brauchen eine Einladung, Fremde können sich also nicht registrieren.',
        loadFailed: 'Die Erreichbarkeit dieses Home konnte nicht geladen werden.',
    },
    runtime: {
        title: 'Laufzeit',
        version: 'Version',
        versionValue: ({ version }: { version: string }) => `Happier ${version}`,
        versionUnknown: 'Dieses Home meldet seine Version nicht',
        flavorLight: 'Light-Server',
        flavorFull: 'Vollständiger Server',
        server: 'Server',
        restart: 'Neu starten',
        restartNow: 'Jetzt neu starten',
        restartFailed: 'Der Server konnte nicht neu gestartet werden',
        waitingForHome: 'Neustart läuft, wir warten, bis das Home wieder erreichbar ist.',
        restartToApply: 'Starte den Server neu, um sie anzuwenden.',
        restartFromDeployment: 'Starte über deine Bereitstellung neu, um sie anzuwenden.',
        restartFromHost: ({ host }: { host: string }) => `Starte auf ${host} neu, dem Computer, der dieses Home hostet.`,
        restartFromHostingComputer: 'Starte auf dem Computer neu, der dieses Home hostet.',
        managedFrom: ({ host }: { host: string }) => `Wird von ${host} aus verwaltet`,
        managedFromBody: 'Öffne Happier auf dem Computer, der dieses Home hostet, um es zu aktualisieren, neu zu starten oder zu stoppen.',
        managedElsewhere: 'Wird vom Computer verwaltet, der dieses Home hostet',
        deploymentTitle: 'Wird von deiner Bereitstellung verwaltet',
        deploymentBody: 'Updates, Neustarts und Backups dieses Servers übernimmt, wer ihn bereitstellt.',
        backups: 'Backups',
        backupsHere: 'Sichere, stelle wieder her oder verschiebe dieses Home auf seiner Laufzeitseite.',
        backupsFromHost: ({ host }: { host: string }) => `Sichere auf ${host}, dem Computer, der dieses Home hostet.`,
        backupsFromHostingComputer: 'Sichere auf dem Computer, der dieses Home hostet.',
        backupsDeployment: 'Backups werden von deiner Bereitstellung verwaltet.',
        hostedHere: ({ home }: { home: string }) => `Dieser Computer hostet ${home}`,
        hostedHereSubtitle: 'Aktualisiere, starte neu, sichere und verschiebe es in seiner Home-Konsole.',
        pendingRestart: ({ count }: { count: number }) => (count === 1 ? '1 Änderung gilt nach dem Neustart' : `${count} Änderungen gelten nach dem Neustart`),
    },
    activity: {
        title: 'Aktivität',
        emptyTitle: 'Noch keine Aktivität',
        emptyBody: 'Änderungen an Anmeldung, E-Mail, Personen, Richtlinien und Eigentümerschaft erscheinen hier, sobald sie passieren.',
        showOlder: 'Ältere anzeigen',
        footnote: 'Aktionen, die mit Happier direkt auf dem Host-Computer ausgeführt werden, etwa Backups und Neustarts, werden nicht aufgeführt.',
        loadFailed: 'Dieses Home hat seine Aktivität nicht geliefert.',
        deploymentCommand: 'Bereitstellungsbefehl',
        personalHomeSetup: 'Einrichtung des Personal Home',
        someone: 'Jemand',
        removedAccount: 'ein entferntes Konto',
        claimed: 'hat die Eigentümerschaft dieses Homes übernommen',
        madeOwner: ({ target }: { target: string }) => `hat ${target} zum Owner gemacht`,
        assignedOwner: 'hat den ersten Owner festgelegt',
        changedPolicies: 'hat Richtlinien geändert',
        changedEmailSetting: 'hat E-Mail-Einstellungen aktualisiert',
        changedServerSetting: 'hat Servereinstellungen geändert',
        changedRole: ({ target }: { target: string }) => `hat die Rolle von ${target} geändert`,
        disabled: ({ target }: { target: string }) => `hat ${target} deaktiviert`,
        reenabled: ({ target }: { target: string }) => `hat ${target} wieder aktiviert`,
        changedStatus: ({ target }: { target: string }) => `hat den Status von ${target} geändert`,
        deleted: ({ target }: { target: string }) => `hat ${target} gelöscht`,
        deletionStarted: ({ target }: { target: string }) => `hat begonnen, ${target} zu löschen`,
        signedOutEverywhere: ({ target }: { target: string }) => `hat ${target} überall abgemeldet`,
        areaOwnership: 'Eigentümerschaft',
        areaPolicies: 'Richtlinien',
        areaEmail: 'E-Mail',
        areaServerSettings: 'Servereinstellungen',
        areaPeople: 'Personen',
        fieldRole: 'Rolle',
        fieldStatus: 'Status',
        fieldTeamProviders: 'Team-Anmeldeanbieter',
        valueEmpty: '—',
        valueChanged: 'geändert',
        valueOn: 'An',
        valueOff: 'Aus',
        secretSet: 'gesetzt',
        secretUnset: 'nicht gesetzt',
    },
    signInPolicy: {
        methodsDescription: ({ home }: { home: string }) => `Wie man sich bei ${home} anmeldet. Mindestens eine Methode bleibt aktiv, und niemand verliert seinen letzten Zugang.`,
        methodUnavailable: 'Nicht verfügbar — deine Bereitstellung kann sie nicht anbieten',
        needsGithubApp: 'Benötigt zuerst eine GitHub-Anmelde-App.',
        needsWorkos: 'Benötigt zuerst eingerichtetes WorkOS.',
        setUp: 'Einrichten',
        signInService: 'Anmeldedienst des Homes',
        signInServiceDescription: 'Über den eigenen Anmeldedienst dieses Homes anmelden.',
        admissionTitle: 'Wer ein Konto erstellen kann',
        newAccounts: 'Neue Konten',
        admissionAnyoneDescription: 'Alle, die dieses Home erreichen können',
        admissionInvitationDescription: 'Nur Personen mit einer Team-Einladung',
        admissionNobodyDescription: 'Niemand kann ein Konto erstellen',
        anonymousSignup: 'Anonyme Registrierung',
        anonymousSignupDescription: 'Ein Konto nur mit einem Wiederherstellungsschlüssel erstellen, ohne E-Mail.',
        encryptionTitle: 'Verschlüsselung',
        encryptionDescription: 'Gilt für Konten und Sitzungen, die ab jetzt erstellt werden. Bestehende ändern sich nie.',
        storagePolicy: 'Speicherrichtlinie',
        storageRequired: 'E2EE erforderlich',
        storageOptional: 'Optional',
        storagePlaintext: 'Nur Klartext',
        storageRequiredDescription: 'Jedes Konto bleibt Ende-zu-Ende-verschlüsselt',
        storageOptionalDescription: 'Jedes Konto entscheidet, ob es verschlüsselt',
        storagePlaintextDescription: 'Konten speichern Daten ohne Ende-zu-Ende-Verschlüsselung',
        storageAppliesAfterRestart: ({ running }: { running: string }) => `Gilt nach einem Neustart · bis dahin ${running}`,
        allowE2ee: 'Ende-zu-Ende-verschlüsselte Konten',
        allowPlain: 'Konten ohne Ende-zu-Ende-Verschlüsselung',
        recommendedInherited: 'Serverstandard',
        recommendedE2ee: 'E2EE',
        errorWideningUnconfirmed: 'Diese Änderung lässt mehr Personen herein und braucht deine Bestätigung. Es wurde nichts geändert.',
        widening: {
            titleAnyone: 'Allen erlauben, ein Konto zu erstellen?',
            titleInvited: 'Eingeladenen erlauben, Konten zu erstellen?',
            titleMethod: ({ method }: { method: string }) => `${method} aktivieren?`,
            titleAnonymous: 'Anonyme Registrierung erlauben?',
            titleUnencrypted: 'Unverschlüsselte Speicherung erlauben?',
            titleOther: 'Mehr Personen hereinlassen?',
            exposureAnyone: ({ host }: { host: string }) => `Alle, die dieses Home unter ${host} erreichen, können sich ohne Einladung registrieren.`,
            exposureInvited: ({ host }: { host: string }) => `Alle mit einer Einladung, die dieses Home unter ${host} erreichen, können ein Konto erstellen.`,
            exposureMethod: ({ host, method }: { host: string; method: string }) => `Alle, die dieses Home unter ${host} erreichen, können sich mit ${method} anmelden.`,
            exposureAnonymous: ({ host }: { host: string }) => `Alle, die dieses Home unter ${host} erreichen, können ein Konto nur mit einem Wiederherstellungsschlüssel erstellen.`,
            exposureUnencrypted: ({ host }: { host: string }) => `Alle, die dieses Home unter ${host} erreichen, können ihre Daten hier ohne Ende-zu-Ende-Verschlüsselung speichern.`,
            exposureOther: ({ host }: { host: string }) => `Alle, die dieses Home unter ${host} erreichen, können sich nach den erweiterten Regeln anmelden oder beitreten.`,
            unchanged: 'Bestehende Konten und Einladungen ändern sich nicht.',
            recorded: 'Die Änderung wird mit deinem Namen in der Aktivität festgehalten.',
            confirmAnyone: 'Allen die Registrierung erlauben',
            confirmInvited: 'Einladungen erlauben',
            confirmMethod: ({ method }: { method: string }) => `${method} aktivieren`,
            confirmAnonymous: 'Anonyme Registrierung erlauben',
            confirmUnencrypted: 'Unverschlüsselte Speicherung erlauben',
            confirmOther: 'Änderung anwenden',
        },
    },
    claim: {
        pageDescription: 'Übernimm die Verwaltung dieses Home.',
        emptyTitle: 'Dieses Home hat noch keinen Eigentümer',
        emptyBody: 'Ein Eigentümer verwaltet Anmeldung, E-Mail, Erreichbarkeit und Personen. Bis jemand es beansprucht, kann niemand dieses Home verwalten.',
        codeTitle: 'Mit einem Einmalcode beanspruchen',
        codeDescription: 'Jemand mit Zugriff auf den Server gibt einen Code aus. Er funktioniert einmal und läuft nach 15 Minuten ab.',
        printStep: '1 · Einen Code auf dem Server ausgeben',
        pasteStep: '2 · Hier einfügen',
        codeLabel: 'Anspruchscode',
        codePlaceholder: 'XXXX-XXXX-XXXX-XXXX-…',
        claim: 'Beanspruchen',
        refused: 'Dieser Code hat nicht funktioniert. Er ist vielleicht vertippt, benutzt oder abgelaufen — gib einen neuen aus.',
        hostTitle: ({ home }: { home: string }) => `Dieser Computer hostet ${home}`,
        hostBody: 'Du kannst dein Konto von hier aus zum Eigentümer machen. Nur dieser Computer kann das auf diese Weise.',
        makeOwner: 'Mich zum Eigentümer machen',
        hostFailed: 'Dieser Computer konnte dich nicht zum Eigentümer machen. Versuche es erneut.',
    },
    fixedByDeployment: ({ key }: { key: string }) => `Von deiner Bereitstellung festgelegt · ${key}`,
    fixedByDeploymentLead: 'Von deiner Bereitstellung festgelegt',
    deploymentNotSetLead: 'Nicht verfügbar, bis deine Bereitstellung Folgendes setzt',
    features: {
        title: 'Funktionen',
        common: 'Häufig',
        advanced: 'Erweitert',
        advancedDescription: ({ count }: { count: number }) => `${count} weitere, nach Bereich gruppiert.`,
        other: 'Sonstige',
        familyCount_one: '1 Funktion',
        familyCount_other: ({ count }: { count: number }) => `${count} Funktionen`,
        offHome: 'Für dieses Home ausgeschaltet.',
        notInBuild: 'In diesem Build nicht enthalten.',
        needs: ({ feature }: { feature: string }) => `Benötigt ${feature}.`,
        unavailable: 'Auf diesem Home nicht verfügbar.',
        noHomeSwitchOn: 'Auf diesem Home immer an · nur der Happier-Build kann sie ausschalten',
        noHomeSwitchOff: 'Auf diesem Home aus · nur der Happier-Build kann sie einschalten',
        unavailableByDeployment: 'Auf diesem Home nicht verfügbar · das Setup deines Deployments entscheidet',
        dependentsTitle_one: ({ feature }: { feature: string }) => `Wenn du ${feature} ausschaltest, wird auch 1 Funktion ausgeschaltet`,
        dependentsTitle_other: ({ feature, count }: { feature: string; count: number }) => `Wenn du ${feature} ausschaltest, werden auch ${count} Funktionen ausgeschaltet`,
        dependentNeeds: ({ feature, parent }: { feature: string; parent: string }) => `${feature} benötigt ${parent}.`,
        turnOff: 'Ausschalten',
        deviceTitle: 'Funktionen auf diesem Gerät',
        deviceBody: 'Funktionen, die nur dieses Gerät betreffen, findest du in den Einstellungen.',
        adminTitle: 'Nur Owner können Funktionen ändern',
        adminBody: 'Du siehst, was dieses Home anbietet, weil du Admin bist.',
        loadFailed: 'Dieses Home hat seine Funktionen nicht geliefert.',
        conflictTitle: 'Funktionen wurden anderswo geändert',
        conflictBody: 'Jemand hat die Einstellungen dieses Homes geändert, während du sie angesehen hast. Die Seite zeigt jetzt, was das Home gespeichert hat.',
        rangeBetween: ({ min, max }: { min: number; max: number }) => `${min}–${max}`,
        rangeAtLeast: ({ min }: { min: number }) => `${min} oder mehr`,
        rangeAtMost: ({ max }: { max: number }) => `Bis zu ${max}`,
        limitInvalid: 'Gib eine Zahl im gültigen Bereich ein.',
        appliesAfterRestart: 'Gilt nach einem Neustart',
        onAfterRestart: 'Nach dem Neustart an',
        offAfterRestart: 'Nach dem Neustart aus',
        ignoredAtLastStart: ({ reason }: { reason: string }) => `Beim letzten Start ignoriert: ${reason}`,
        ignoredInvalidType: 'der gespeicherte Wert hat den falschen Typ',
        ignoredOutOfBounds: 'der gespeicherte Wert liegt außerhalb des Bereichs',
        ignoredSecretUnreadable: 'das gespeicherte Geheimnis kann nicht gelesen werden',
        dependentsAfterRestartTitle_one: ({ feature }: { feature: string }) => `Nach dem nächsten Neustart schaltet das Ausschalten von ${feature} auch 1 Funktion aus`,
        dependentsAfterRestartTitle_other: ({ feature, count }: { feature: string; count: number }) => `Nach dem nächsten Neustart schaltet das Ausschalten von ${feature} auch ${count} Funktionen aus`,
    },
    data: {
        title: 'Daten',
        deletion: 'Automatisches Löschen',
        deletionDescription: 'Änderungen gelten ab der nächsten Bereinigung.',
        dryRunMode: 'Probelauf-Modus',
        dryRunModeDescription: 'Die Bereinigung zählt nur, statt zu löschen, bis du das ausschaltest.',
        tryRules: 'Aktuelle Regeln testen',
        tryRulesDescription: 'Führt jetzt eine Bereinigung aus, ohne etwas zu löschen.',
        runDryRun: 'Probelauf starten',
        runAgain: 'Erneut ausführen',
        ranAt: ({ time }: { time: string }) => `Ausgeführt um ${time} · nichts wurde gelöscht`,
        sweepInProgress: 'Eine Bereinigung läuft — versuch es erneut, wenn sie fertig ist.',
        wouldDelete: ({ count, examined }: { count: string; examined: string }) => `Würde ${count} löschen · ${examined} geprüft`,
        nothingToDelete: 'Nichts zu löschen',
        stopTimeBudget: 'gestoppt: Zeitbudget',
        stopRowBudget: 'gestoppt: Löschlimit',
        stopCandidateBudget: 'gestoppt: Prüflimit',
        stopStalled: 'gestoppt: kein Fortschritt',
        keep: 'Behalten',
        deleteAfter: 'Löschen nach',
        days: 'Tagen',
        daysFor: ({ domain }: { domain: string }) => `Tage, die ${domain} aufbewahrt werden`,
        daysRequired: 'Gib an, wie viele Tage.',
        daysInvalid: 'Verwende eine ganze Zahl von Tagen, mindestens 1.',
        defaultEffect: ({ effect }: { effect: string }) => `Standard · ${effect}`,
        alwaysRuns: 'Läuft auch, wenn automatisches Löschen ausgeschaltet ist.',
        expiresAutomatically: 'Läuft automatisch ab',
        systemRecords: 'Systemdatensätze',
        systemRecordsSummary_one: '1 Art von Datensatz, die dieses Home für sich selbst aufbewahrt',
        systemRecordsSummary_other: ({ count }: { count: number }) => `${count} Arten von Datensätzen, die dieses Home für sich selbst aufbewahrt`,
        adminTitle: 'Nur Owner können ändern, was dieses Home aufbewahrt',
        adminBody: 'Du siehst die Regeln, weil du Admin bist.',
        loadFailed: 'Dieses Home hat seine Dateneinstellungen nicht geliefert.',
        conflictTitle: 'Dateneinstellungen wurden anderswo geändert',
        conflictBody: 'Jemand hat die Einstellungen dieses Homes geändert, während du sie angesehen hast. Die Seite zeigt jetzt, was das Home gespeichert hat.',
    },
};

const homeGovernanceTranslations = { de } as const;

return { homeGovernanceTranslations };
})();

const Domain_homeIndexTranslations = (() => {
type HomeIndexTranslation = Shared_homeIndexTranslations.HomeIndexTranslation;

const homeIndexTranslations = { de: {
        greetingMorning: ({ name }) => `Guten Morgen, ${name}`,
        greetingAfternoon: ({ name }) => `Guten Tag, ${name}`,
        greetingEvening: ({ name }) => `Guten Abend, ${name}`,
        greetingMorningAnonymous: 'Guten Morgen',
        greetingAfternoonAnonymous: 'Guten Tag',
        greetingEveningAnonymous: 'Guten Abend',
        sessionsWorking: ({ count }) => (count === 1 ? '1 Sitzung arbeitet' : `${count} Sitzungen arbeiten`),
        sessionsNeedYou: ({ count }) => `${count} ${count === 1 ? 'braucht' : 'brauchen'} dich`,
        sessionsAwaitingResponse: ({ count }) => count === 1 ? '1 Sitzung wartet auf deine Antwort' : `${count} Sitzungen warten auf deine Antwort`,
        nothingRunning: 'Noch läuft nichts',
        customize: 'Anpassen',
        customizeTitle: 'Startseite anpassen',
        customizeDescription: 'Zum Umsortieren ziehen. Im Konto gespeichert, damit jedes Gerät dieselbe Startseite zeigt.',
        customizing: "Startseite wird angepasst",
        customizingHint: "Widgets in Gruppen, aus Gruppen und zwischen Gruppen ziehen",
        sections: "Bereiche",
        newRow: "Hier ablegen, um eine neue Zeile zu beginnen",
        newRowVerb: "In eine neue Zeile verschieben",
        addWidget: "Widget hinzufügen",
        reset: 'Zurücksetzen',
        alwaysShown: 'Immer sichtbar',
        builtIn: 'Integriert',
        startDescription: 'Eingabefeld und Vorschläge',
        attentionDescription: 'Erscheint, wenn etwas dich braucht',
        machinesDescription: 'Integriert · ein Raster deiner Maschinen',
        hiddenSetupSteps: 'Ausgeblendete Einrichtungsschritte',
        showAgain: ({ count }) => `${count} · Wieder anzeigen`,
        reorderHandle: ({ section }) => `${section} umsortieren`,
    } } satisfies Pick<Readonly<Record<string, HomeIndexTranslation>>, "de">;

return { homeIndexTranslations };
})();

const Domain_homeSettingsTranslations = (() => {
const en = Shared_homeSettingsTranslations.en;

const de: typeof en = {
    page: {
        title: 'Servereinstellungen',
        description: 'Jede Einstellung, die der Server liest und die keine eigene Seite hat.',
        searchPlaceholder: 'Einstellungen oder Umgebungsvariablen suchen',
        changed: 'Geändert',
        changedA11y: ({ count }: { count: number }) => (count === 1 ? 'Nur die 1 geänderte Einstellung anzeigen' : `Nur die ${count} geänderten Einstellungen anzeigen`),
        noMatches: 'Keine Einstellung entspricht dieser Suche.',
        noChanges: 'Auf diesem Home ist keine Einstellung gegenüber ihrem Standard geändert.',
        filterLabel: 'Anzeigen',
        filterAll: 'Alle Einstellungen',
        filterChanged: ({ count }: { count: number }) => `Geändert · ${count}`,
        more: 'Mehr',
        readOnlyTitle: 'Beim Start nur lesbar',
        readOnlyDescription: 'Der Server braucht diese, bevor er gespeicherte Einstellungen lesen kann, deshalb werden sie dort festgelegt, wo er läuft.',
        note: 'Einstellungen gelten sofort, wenn du sie änderst, außer sie sind mit "Gilt nach dem Neustart" markiert. Ausstehend bedeutet, dass der gespeicherte Wert von dem abweicht, mit dem der Server gestartet ist. Jede Änderung wird in der Aktivität aufgezeichnet; geheime Werte nie.',
        adminTitle: 'Nur Owner ändern Servereinstellungen',
        adminBody: 'Du siehst jede Einstellung und woher ihr Wert stammt.',
        loadFailed: 'Die Servereinstellungen konnten nicht geladen werden.',
        saveFailed: 'Die Einstellung wurde nicht gespeichert.',
        conflictTitle: 'Einstellungen wurden anderswo geändert',
        conflictBody: 'Jemand hat die Einstellungen dieses Homes geändert, während du sie bearbeitet hast. Die Seite zeigt jetzt deren Werte; deine Änderung steht noch in ihrem Feld.',
    },
    row: {
        appliesAfterRestart: 'Gilt nach dem Neustart',
        pending: 'Ausstehend',
        defaultValue: ({ value }: { value: string }) => `Standard: ${value}`,
        runningWith: ({ value }: { value: string }) => `läuft seit dem letzten Start mit ${value}`,
        runningWithout: 'läuft seit dem letzten Start ohne es',
        ignored: ({ reason }: { reason: string }) => `Beim letzten Start ignoriert: ${reason}`,
        runningOn: ({ value }: { value: string }) => `läuft auf ${value}`,
        notSet: 'Nicht gesetzt',
        outOfBounds: ({ bounds }: { bounds: string }) => `Muss ${bounds} sein`,
        invalid: 'Dieser Wert ist hier nicht gültig',
        storedEncrypted: 'verschlüsselt gespeichert, nie angezeigt',
    },
    banner: {
        pendingNames: ({ names }: { names: string }) => `${names}.`,
        andMore: ({ count }: { count: number }) => (count === 1 ? '1 weitere' : `${count} weitere`),
        discard: 'Verwerfen',
        discarded: 'Ausstehende Änderungen verworfen',
        ignoredTitle: 'Eine Einstellung wurde beim letzten Start ignoriert',
        ignoredTitleMany: ({ count }: { count: number }) => `${count} Einstellungen wurden beim letzten Start ignoriert`,
        ignoredBody: ({ setting, reason }: { setting: string; reason: string }) => `${setting}: ${reason}. Der Server ist ohne sie gestartet.`,
        fix: 'Beheben',
    },
    readOnly: {
        before_database: 'Vor dem Öffnen der Datenbank gelesen',
        per_process_identity: 'Unterscheidet sich für jeden Serverprozess',
        invariant: 'Schützt Anmeldung und Build-Limits und kann hier nicht geändert werden',
        other: 'Dort festgelegt, wo der Server läuft',
        set: 'Gesetzt',
    },
    secret: {
        saved: 'Gespeichert',
        replace: 'Ersetzen',
        clear: 'Entfernen',
        keep: 'Behalten',
        clearPending: 'Der gespeicherte Wert wird beim Speichern entfernt.',
        valueSet: 'Gesetzt',
        valueNotSet: 'Nicht gesetzt',
        setAction: 'Festlegen',
    },
    groupSummary: ({ count }: { count: number }) => (count === 1 ? '1 Einstellung · Standard' : `${count} Einstellungen · Standard`),
    groupSummaryChanged: ({ count, changed }: { count: number; changed: number }) => `${count} Einstellungen · ${changed} geändert`,
    units: {
        ms: 'ms',
        seconds: 's',
        minutes: 'Min.',
        bytes: 'Bytes',
        megabytes: 'MB',
    },
    activity: {
        discarded: 'Ausstehende Servereinstellung verworfen',
    },
    choices: {
        hosted_happier_relay: 'Happier-Relay',
        direct_apns: 'Apple Push',
        background_wake_best_effort: 'Hintergrund-Weckruf',
        local_only: 'Nur dieses Gerät',
        disabled: 'Aus',
        enabled: 'An',
        automatic: 'Automatisch',
        sandbox: 'Sandbox',
        production: 'Produktion',
        owner: 'Server-Eigentümer',
        authenticated: 'Alle Angemeldeten',
        self: 'Dieser Server',
        external: 'Externer Dienst',
        '0': 'Aus',
        '1': 'An',
        any: 'Beliebige',
        all: 'Alle',
        github_app: 'GitHub App',
        oauth_user_token: 'Token der Person',
        light: 'Leicht',
        full: 'Vollständig',
        api: 'Nur API',
        worker: 'Nur Worker',
        fatal: 'Fatal',
        error: 'Fehler',
        warn: 'Warnungen',
        info: 'Infos',
        debug: 'Debug',
        trace: 'Ablaufverfolgung',
        silent: 'Still',
        manual: 'Manuell',
        default: 'Serverstandard',
    },
    rateLimit: {
        max: ({ route }: { route: string }) => `${route}: Anfragen pro Zeitfenster`,
        window: ({ route }: { route: string }) => `${route}: Zeitfenster`,
    },
    groups: {
        api: 'API und Netzwerk',
        storage: 'Speicher und Dateien',
        monitoring: 'Überwachung',
        process: 'Prozess',
        ui: 'Web-App-Auslieferung',
        realtime: 'Präsenz und Sockets',
        retentionCaps: 'Ressourcengrenzen für Aufbewahrung',
        rpc: 'Maschinenaufrufe',
        liveActivity: 'Live Activities',
        voice: 'Sprache',
        connectedServices: 'Verbundene Dienste',
        localServices: 'Lokale Dienste',
        plugins: 'Plugins',
        reviews: 'Überprüfungen',
        bugReports: 'Fehlerberichte',
        releases: 'Veröffentlichungen',
        authCaches: 'Anmelde-Caches',
        limits: 'Grenzwerte',
        rateLimits: 'Ratenlimits nach Route',
        github: 'GitHub-Anmeldung',
        oauth: 'OAuth-Anmeldung',
        oidc: 'OIDC-Anbieter aus der Konfiguration',
        workos: 'WorkOS',
        signInRequests: 'Anmeldeanfragen',
        offboarding: 'Zugriffsentzug',
        friends: 'Freunde',
        accountService: 'Kontodienst',
        devices: 'Geräte',
        diagnostics: 'Diagnose',
        reachInference: 'Adresserkennung',
        addresses: 'Adressen',
        other: 'Sonstiges',
    },
    keys: {
        HAPPIER_HOME_DISPLAY_NAME: 'Home-Name',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: 'Hintergrundaktualisierungen',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: 'Übertragungsmodus',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_ALLOW_FALLBACK: 'Auf einen anderen Modus ausweichen',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_DEDUPE_WINDOW_MS: 'Fenster für doppelte Aktualisierungen',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_ENABLED: 'Wecken per Push im Hintergrund',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_MIN_INTERVAL_MS: 'Kürzeste Zeit zwischen Weck-Pushes',
        HAPPIER_LIVE_ACTIVITY_EXPO_WIDGETS_PUSH_NOTIFICATIONS_ENABLED: 'Widgets-Build erhält Pushes',
        HAPPIER_LIVE_ACTIVITY_TARGET_TRANSIENT_FAILURE_BUDGET: 'Fehler, bevor ein Gerät entfernt wird',
        HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT: 'Apple-Push-Umgebung',
        HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID: 'Apple-Team-ID',
        HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID: 'Apple-Push-Schlüssel-ID',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY: 'Apple-Push-Signaturschlüssel',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY_FILE: 'Apple-Push-Signaturschlüsseldatei',
        HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS: 'Erlaubte App-Bundle-IDs',
        HAPPIER_LIVE_ACTIVITY_APNS_ACTIVITY_NAMES: 'Erlaubte Live-Activity-Namen',
        HAPPIER_LIVE_ACTIVITY_APNS_REQUEST_TIMEOUT_MS: 'Apple-Push-Anfragetimeout',
        HAPPIER_LIVE_ACTIVITY_APNS_RECONNECT_BACKOFF_MS: 'Apple-Push-Wiederverbindungsverzögerung',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED: 'Gehosteten Relay verwenden',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL: 'Adresse des gehosteten Relays',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEY: 'Zugriffsschlüssel des gehosteten Relays',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_SERVICE_ENABLED: 'Als gehosteter Relay agieren',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEYS: 'Relay-Zugriffsschlüssel für andere Server',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_MAX_SKEW_MS: 'Uhrentoleranz des Relays',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_TTL_MS: 'Duplikatspeicher des Relays',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_CACHE_MAX_ENTRIES: 'Größe des Duplikat-Caches des Relays',
        ELEVENLABS_API_KEY: 'ElevenLabs-API-Schlüssel',
        ELEVENLABS_AGENT_ID: 'ElevenLabs-Agent',
        ELEVENLABS_AGENT_ID_PROD: 'ElevenLabs-Produktionsagent',
        ELEVENLABS_API_BASE_URL: 'ElevenLabs-API-Adresse',
        REVENUECAT_SECRET_KEY: 'RevenueCat-Geheimschlüssel',
        VOICE_FREE_SESSIONS_PER_MONTH: 'Kostenlose Sprachsitzungen pro Monat',
        VOICE_FREE_MINUTES_PER_MONTH: 'Kostenlose Sprachminuten pro Monat',
        VOICE_MAX_CONCURRENT_SESSIONS: 'Gleichzeitige Sprachsitzungen',
        VOICE_MAX_SESSION_SECONDS: 'Längste Sprachsitzung',
        VOICE_MAX_MINUTES_PER_DAY: 'Sprachminuten pro Tag',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_ENABLED: 'Rückwirkende Sprachidentität',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE: 'Batchgröße für die Rückfüllung',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS: 'Zeitbudget für die Rückfüllung',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_DELAY_MS: 'Pause zwischen Rückfüllungs-Batches',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_INTERVAL_MS: 'Zeit zwischen Rückfüllungsläufen',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID: 'OpenAI-Codex-OAuth-Client-ID',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL: 'OpenAI-Codex-Token-Endpunkt',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID: 'Claude-Abonnement-OAuth-Client-ID',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL: 'Claude-Abonnement-Token-Endpunkt',
        HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS: 'Timeout für Token-Austausch',
        CONNECTED_SERVICE_CREDENTIAL_MAX_LEN: 'Größte gespeicherte Anmeldeinformation',
        CONNECTED_SERVICE_REFRESH_LEASE_MAX_MS: 'Längste Aktualisierungs-Lease',
        VENDOR_TOKEN_MAX_LEN: 'Größtes Anbieter-Token',
        HAPPIER_LOCAL_SERVICES_TOKEN_SECRET: 'Vorschau-Token-Geheimnis',
        HAPPIER_LOCAL_SERVICES_PREVIEW_TOKEN_SECRET: 'Geheimnis für privaten Vorschau-Token',
        HAPPIER_LOCAL_SERVICES_PUBLIC_PREVIEW_TOKEN_SECRET: 'Geheimnis für öffentlichen Vorschau-Token',
        HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN: 'Plugin-UI-Ursprung',
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_MAX_AGE_MS: 'Gültigkeitsdauer des Herausgebernachweises',
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_CLOCK_SKEW_MS: 'Uhrentoleranz des Herausgebernachweises',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_MAX_AGE_MS: 'Gültigkeitsdauer des Review-Nachweises',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_CLOCK_SKEW_MS: 'Uhrentoleranz des Review-Nachweises',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: 'Serverprotokolle einschließen',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: 'Wer Serverprotokolle lesen darf',
        HAPPIER_BUG_REPORTS_SERVER_LOG_PATH: 'Serverprotokolldatei',
        HAPPIER_BUG_REPORTS_SERVER_LOG_MAX_BYTES: 'Enthaltene Protokollgröße',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'Release-Kanal',
        HAPPIER_GITHUB_REPO: 'Release-Repository',
        AUTH_OFFBOARDING_ENABLED: 'Anmeldeberechtigung erneut prüfen',
        AUTH_OFFBOARDING_STRICT: 'Bei fehlgeschlagener erneuter Prüfung ablehnen',
        AUTH_OFFBOARDING_INTERVAL_SECONDS: 'Zeit zwischen erneuten Prüfungen',
        AUTH_PROVIDERS_CONFIG_PATH: 'Anbieter-Datei',
        AUTH_PROVIDERS_CONFIG_JSON: 'Anbieter-JSON',
        HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: 'Anmeldedienst',
        HAPPIER_AUTH_SIGN_IN_SERVICE_URL: 'Adresse des Kontodienstes',
        HAPPIER_AUTH_SIGN_IN_SERVICE_SERVER_IDENTITY_ID: 'Identität des Kontodienstes',
        HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME: 'Name des Kontodienstes',
        HAPPIER_SERVER_OWNER_USER_IDS: 'Owner-Konten des Servers',
        HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED: 'Neue Geräte brauchen eine Genehmigung',
        GITHUB_CLIENT_ID: 'GitHub-OAuth-Client-ID',
        GITHUB_CLIENT_SECRET: 'GitHub-OAuth-Client-Geheimnis',
        GITHUB_REDIRECT_URL: 'GitHub-Rückrufadresse',
        GITHUB_HTTP_TIMEOUT_SECONDS: 'GitHub-Anfragetimeout',
        GITHUB_STORE_ACCESS_TOKEN: 'GitHub-Zugriffstoken behalten',
        OAUTH_PENDING_TTL_SECONDS: 'Gültigkeitsdauer ausstehender Anmeldungen',
        OAUTH_STATE_TTL_SECONDS: 'Gültigkeitsdauer des OAuth-States',
        HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES: 'Erlaubte App-Rückkehrschemata',
        AUTH_GITHUB_ALLOWED_USERS: 'Erlaubte GitHub-Benutzer',
        AUTH_GITHUB_ALLOWED_ORGS: 'Erlaubte GitHub-Organisationen',
        AUTH_GITHUB_ORG_MATCH: 'Erforderliche Organisationen',
        AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: 'Mitgliedschaftsprüfung',
        AUTH_GITHUB_APP_ID: 'GitHub-App-ID für Mitgliedschaft',
        AUTH_GITHUB_APP_PRIVATE_KEY: 'GitHub-App-Schlüssel für Mitgliedschaft',
        AUTH_GITHUB_APP_INSTALLATION_ID_BY_ORG: 'App-Installationen nach Organisation',
        WORKOS_API_KEY: 'WorkOS-API-Schlüssel',
        WORKOS_CLIENT_ID: 'WorkOS-Client-ID',
        ACCOUNT_AUTH_REQUEST_TTL_SECONDS: 'Gültigkeitsdauer der Kontoanmeldeanfrage',
        TERMINAL_AUTH_REQUEST_TTL_SECONDS: 'Gültigkeitsdauer der Terminal-Anmeldeanfrage',
        AUTH_PAIRING_TTL_SECONDS: 'Gültigkeitsdauer des Kopplungscodes',
        AUTH_TOKEN_CACHE_TTL_SECONDS: 'Gültigkeitsdauer des Sitzungstoken-Caches',
        AUTH_TOKEN_CACHE_MAX_ENTRIES: 'Größe des Sitzungstoken-Caches',
        AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: 'Gültigkeitsdauer des Berechtigungs-Caches',
        AUTH_LOGIN_ELIGIBILITY_CACHE_MAX_ENTRIES: 'Größe des Berechtigungs-Caches',
        FRIENDS_USERNAME_MIN_LEN: 'Kürzester Benutzername',
        FRIENDS_USERNAME_MAX_LEN: 'Längster Benutzername',
        FRIENDS_USERNAME_REGEX: 'Benutzername-Muster',
        HAPPIER_CANONICAL_SERVER_URL: 'Adresse der Anmeldeidentität',
        HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE: 'OAuth-Rückkehradresse der Web-App',
        PUBLIC_URL: 'Angekündigte Adresse (leicht)',
        HAPPIER_PUBLIC_SERVER_URL_INFER_TTL_MS: 'Gültigkeitsdauer der erkannten Adresse',
        HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL: 'Aus der Zugriffsmethode erkennen',
        HAPPIER_TAILSCALE_INFER_PUBLIC_URL: 'Aus Tailscale erkennen',
        HAPPIER_TAILSCALE_SERVE_STATUS_TIMEOUT_MS: 'Timeout der Tailscale-Serve-Prüfung',
        HAPPIER_TAILSCALE_FUNNEL_STATUS_TIMEOUT_MS: 'Timeout der Tailscale-Funnel-Prüfung',
        PORT: 'Listen-Port',
        HAPPIER_SERVER_HOST: 'Listen-Adresse',
        HAPPIER_SERVER_FLAVOR: 'Server-Variante',
        NODE_ENV: 'Node-Umgebung',
        SERVER_ROLE: 'Prozessrolle',
        UV_THREADPOOL_SIZE: 'Worker-Threads',
        HAPPIER_INSTANCE_ID: 'Replik-ID',
        HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: 'Shutdown-Frist',
        HAPPY_EXIT_ON_FATAL: 'Nach einem schwerwiegenden Fehler beenden',
        HAPPIER_API_CORS_MAX_AGE_SECONDS: 'Preflight-Cache des Browsers',
        HAPPIER_SERVER_IDENTITY_ID: 'Server-Identität',
        HAPPIER_MANAGED_RELAY_PURPOSE: 'Zweck des verwalteten Relays',
        HAPPIER_PERSONAL_HOME_RELOCATION_OPERATION_ID: 'Umzugsvorgang',
        HAPPIER_SERVER_STARTUP_RECEIPT_PATH: 'Startquittungsdatei',
        HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: 'Startquittungs-Nonce',
        HAPPIER_UPDATER_FORWARD_RECOVERY_CAPABILITY: 'Vorwärtswiederherstellung des Updaters',
        HAPPIER_RELEASE_SOURCE_SHA: 'Build-Commit',
        HAPPIER_FEATURE_POLICY_ENV: 'Release-Ring-Richtlinie',
        HAPPIER_BUILD_FEATURES_ALLOW: 'Erlaubte Funktionen',
        HAPPIER_BUILD_FEATURES_DENY: 'Verweigerte Funktionen',
        HAPPIER_SERVER_LOG_LEVEL: 'Protokollstufe',
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: 'Konsolidiertes Debug-Protokoll',
        HAPPIER_SELF_HOST_LOG_DIR: 'Protokollverzeichnis',
        HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS: 'Authentifizierungsdiagnose',
        HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS: 'Socket-Nachrichten-Diagnose',
        METRICS_ENABLED: 'Metriken',
        METRICS_PORT: 'Metriken-Port',
        SENTRY_DSN: 'Fehlerbericht-DSN',
        HAPPIER_SENTRY_USE_CENTRAL_DSN: 'An Happier melden',
        HAPPIER_SENTRY_CENTRAL_DSN: 'Zentrale Fehlerbericht-DSN',
        SENTRY_ENVIRONMENT: 'Fehlerbericht-Umgebung',
        SENTRY_RELEASE: 'Fehlerbericht-Release',
        SENTRY_PROFILE_LIFECYCLE: 'Profilerstellung',
        SENTRY_SEND_DEFAULT_PII: 'Persönliche Daten senden',
        SENTRY_TRACES_SAMPLE_RATE: 'Nachverfolgte Anfragen',
        SENTRY_PROFILE_SESSION_SAMPLE_RATE: 'Profilierte Sitzungen',
        SENTRY_ENABLE_LOGS: 'Protokolle senden',
        SENTRY_LOG_LEVELS: 'Gesendete Protokollstufen',
        SENTRY_MONITORS_ENABLED: 'Job-Monitore',
        HAPPIER_SERVER_UI_DIR: 'Web-App-Ordner',
        HAPPIER_SERVER_UI_PREFIX: 'Web-App-Pfad',
        HAPPIER_SERVER_UI_REQUIRED: 'Web-App erforderlich',
        HAPPIER_SERVER_UI_DEPLOYMENT_ID: 'Web-App-Deployment-ID',
        HAPPIER_SERVER_UI_DEBUG_PATH: 'Web-App-Pfad bei Fehlen anzeigen',
        HAPPIER_SOCKET_ADAPTER: 'Socket-Adapter',
        HAPPIER_SOCKET_REDIS_ADAPTER: 'Redis-Socket-Adapter (veraltet)',
        HAPPIER_SOCKET_ADAPTER_MAXLEN: 'Socket-Stream-Länge',
        HAPPIER_SOCKET_ADAPTER_READ_COUNT: 'Socket-Stream-Lesegröße',
        HAPPIER_SOCKET_MAX_HTTP_BUFFER_SIZE: 'Größte Socket-Nachricht',
        HAPPIER_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS: 'Schwellenwert für schnelle Trennung',
        HAPPIER_SOCKET_PLANNED_RESTART_RETRY_AFTER_MS: 'Reconnect-Verzögerung während eines Neustarts',
        HAPPIER_SOCKET_RECONNECT_WINDOW_MS: 'Reconnect-Fenster',
        HAPPY_SOCKET_ROOMS_ONLY: 'Strenges Socket-Fan-out',
        HAPPIER_MACHINE_SOCKET_OWNER_TTL_SECONDS: 'Socket-Eigentum der Maschine',
        HAPPIER_PRESENCE_STREAM_MAXLEN: 'Präsenz-Stream-Länge',
        HAPPIER_PRESENCE_WORKER_DB_WRITE_CONCURRENCY: 'Nebenläufigkeit der Präsenzschreibungen',
        HAPPIER_PRESENCE_WORKER_FLUSH_INTERVAL_MS: 'Präsenz-Flush-Intervall',
        HAPPIER_PRESENCE_WORKER_READ_BLOCK_MS: 'Wartezeit für Präsenzlesungen',
        HAPPIER_PRESENCE_WORKER_READ_COUNT: 'Lesegröße der Präsenz',
        HAPPIER_PRESENCE_WORKER_RECLAIM_IDLE_MS: 'Präsenz-Rückgewinnung nach',
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: 'Sitzung inaktiv nach',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: 'Maschine offline nach',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: 'Prüfintervall der Präsenz',
        HAPPIER_PRESENCE_SHUTDOWN_FLUSH_TIMEOUT_MS: 'Präsenz-Flush beim Herunterfahren',
        HAPPIER_RPC_FORWARD_TIMEOUT_MS: 'Timeout für Maschinenaufrufe',
        HAPPIER_RPC_FORWARD_CAPABILITIES_TIMEOUT_MS: 'Timeout für Capabilities-Aufrufe',
        HAPPIER_RPC_FORWARD_MAX_TIMEOUT_MS: 'Längster Aufruf-Timeout',
        HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Wartezeit auf eine Methode',
        HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS: 'Prüfintervall der Methode',
        HAPPIER_RPC_CLUSTER_FETCH_TIMEOUT_MS: 'Timeout der replikaübergreifenden Suche',
        HAPPIER_STOP_SESSION_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Wartezeit zum Stoppen einer Sitzung',
        HAPPIER_DIRECT_SESSIONS_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Wartezeit für direkte Sitzungen',
        HAPPIER_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT: 'Sitzungen, die beim ersten Laden Aufmerksamkeit brauchen',
        HAPPIER_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT: 'Für das Rollback geprüfte Turns',
        HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT: 'Aufbewahrte Einstellungshistorie',
        HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK: 'Signierten Maschinenschlüssel erfordern',
        DATABASE_URL: 'Datenbank',
        HAPPIER_DB_PROVIDER: 'Datenbank-Engine',
        HAPPIER_DB_CONNECTION_LIMIT: 'Größe des Verbindungspools',
        HAPPIER_DB_READINESS_TIMEOUT_MS: 'Timeout für Datenbankbereitschaft',
        HAPPIER_DB_TX_MAX_RETRIES: 'Transaktionswiederholungen',
        HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: 'Erste Wiederholungsverzögerung',
        HAPPIER_DB_TX_RETRY_MAX_DELAY_MS: 'Längste Wiederholungsverzögerung',
        HAPPIER_DB_TX_RETRY_JITTER_FACTOR: 'Wiederholungs-Jitter',
        HAPPIER_DB_TX_TIMEOUT_MS: 'Transaktionstimeout',
        HAPPIER_DB_TX_MAX_WAIT_MS: 'Verbindungswartezeit',
        HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS: 'Gesamtes Wiederholungsbudget',
        HAPPIER_SERVER_DB_SIZE_WARN_BYTES: 'Warnung bei Datenbankgröße',
        HAPPIER_SQLITE_AUTO_MIGRATE: 'Beim Start migrieren',
        HAPPIER_SQLITE_MIGRATIONS_DIR: 'Migrationsordner',
        HAPPIER_SQLITE_JOURNAL_MODE: 'SQLite-Journal-Modus',
        HAPPIER_SQLITE_SYNCHRONOUS: 'SQLite-Synchronmodus',
        HAPPIER_SQLITE_JOURNAL_SIZE_LIMIT_BYTES: 'SQLite-Journal-Größenlimit',
        HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: 'SQLite-Checkpoint-Intervall',
        HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: 'SQLite-Checkpoint-Wartezeit',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_INTERVAL_MS: 'SQLite-Vacuum-Intervall',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES: 'SQLite-Vacuum-Seiten',
        HAPPIER_FILES_BACKEND: 'Dateien-Backend',
        S3_HOST: 'S3-Host',
        S3_PORT: 'S3-Port',
        S3_USE_SSL: 'S3 über TLS',
        S3_REGION: 'S3-Region',
        S3_BUCKET: 'S3-Bucket',
        S3_PUBLIC_URL: 'Öffentliche S3-Adresse',
        S3_ACCESS_KEY: 'S3-Zugriffsschlüssel',
        S3_SECRET_KEY: 'S3-Geheimschlüssel',
        REDIS_URL: 'Redis-Verbindung',
        HANDY_MASTER_SECRET: 'Master-Geheimnis',
        HAPPIER_SERVER_LIGHT_DATA_DIR: 'Datenverzeichnis',
        HAPPIER_SERVER_LIGHT_DB_DIR: 'Datenbankverzeichnis',
        HAPPIER_SERVER_LIGHT_FILES_DIR: 'Dateienverzeichnis',
        HAPPIER_API_RATE_LIMITS_ENABLED: 'Ratenlimits',
        HAPPIER_API_RATE_LIMITS_GLOBAL_MAX: 'Anfragen pro Client',
        HAPPIER_API_RATE_LIMITS_GLOBAL_WINDOW: 'Ratenlimit-Zeitfenster',
        HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY: 'Anfragen zählen nach',
        HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: 'Routenanfragen zählen nach',
        HAPPIER_SERVER_TRUST_PROXY: 'Proxy-Headern vertrauen',
        HAPPIER_SERVER_RETENTION__INTERVAL_MS: 'Zeit zwischen Durchläufen',
        HAPPIER_SERVER_RETENTION__BATCH_SIZE: 'Zeilen pro Batch',
        HAPPIER_SERVER_RETENTION__MAX_DELETES_PER_RULE_PER_RUN: 'Höchste Löschungen pro Regel',
        HAPPIER_SERVER_RETENTION__SWEEP_TIME_BUDGET_MS: 'Zeitbudget für den Durchlauf',
        HAPPIER_SERVER_RETENTION__MAX_CANDIDATES_PER_RULE_PER_RUN: 'Höchste geprüfte Zeilen pro Regel',
    },
};

const homeSettingsTranslations = { de } as const;

return { homeSettingsTranslations };
})();

const Domain_homeSetupTranslations = (() => {
type HomeSetupTranslation = Shared_homeSetupTranslations.HomeSetupTranslation;

const homeSetupTranslations = { de: {
        dismiss: ({ title }) => `„${title}“ ausblenden`,
        dismissTooltip: 'Ausblenden · unter „Anpassen“ wiederherstellen',
        close: 'Schließen',
        addPhoneSubtitle: 'Verfolge Sitzungen und beantworte Freigaben von überall.',
        addPhoneAction: 'QR-Code zeigen',
        addMachineSubtitle: 'Ein Server oder Dev-Rechner, auf dem Agents laufen – per SSH oder mit einem Befehl eingerichtet.',
        installComputerTitle: 'Auf einem anderen Computer installieren',
        installComputerSubtitle: 'Installiere dort die Desktop-App und tritt diesem Home per Link bei.',
        installComputerAction: 'Link holen',
        connectComputerTitle: 'Computer verbinden',
        connectComputerSubtitle: 'Scanne den Code, den Happier im Terminal deines Computers zeigt.',
        connectComputerHint: 'Richte die Kamera auf den Code, den Happier im Terminal deines Computers zeigt.',
        phoneAddMachineSubtitle: 'Richte einen Server oder Dev-Rechner für deine Agents ein.',
        phoneAddMachineAction: 'Hinzufügen',
        thisHome: 'diesem Home',
        pairingPhoneTitle: 'Mit dem Handy scannen',
        pairingPhoneBody: ({ home }) => `Richte die Kamera deines Handys auf den Code. Happier öffnet sich und tritt ${home} bei.`,
        pairingPhoneStepInstall: 'Installiere Happier auf deinem Handy.',
        pairingPhoneStepScan: 'Öffne die Kamera und scanne den Code.',
        pairingPhoneStepJoin: 'Lass das hier offen: Dein Handy tritt bei, sobald es gescannt hat.',
        pairingComputerTitle: 'Von einem anderen Computer beitreten',
        pairingComputerBody: ({ home }) => `Schick diesen Link an deinen anderen Computer. Wird er in Happier geöffnet, tritt er ${home} bei.`,
        pairingComputerStepInstall: 'Installiere die Desktop-App auf dem anderen Computer.',
        pairingComputerStepOpen: 'Öffne dort den Link oder füge ihn in Happier ein, wenn es nach der Verbindung fragt.',
        pairingComputerStepJoin: 'Lass das hier offen: Der Computer tritt bei, sobald er den Link öffnet.',
        appStore: 'App Store',
        googlePlay: 'Google Play',
        getDesktopApp: 'Desktop-App laden',
        copyLink: 'Link kopieren',
        waitingForPhone: 'Warte auf dein Handy …',
        waitingForComputer: 'Warte auf deinen Computer …',
        newCodeIn: ({ time }) => `Neuer Code in ${time}`,
        makingCode: 'Code wird erstellt …',
        addingDevice: ({ device }) => `${device} wird hinzugefügt …`,
        deviceJoined: ({ device, home }) => `${device} ist ${home} beigetreten`,
        codeFailed: 'Für dieses Home konnte kein Code erstellt werden.',
        codeFailedUnreachable: ({ home }) => `${home} hat diesem Gerät nicht geantwortet.`,
        codeFailedIdentity: ({ home }) => `Was dieses Gerät über ${home} weiß, passt nicht zu seiner Antwort; verbinde es unter Homes neu.`,
        codeFailedSignedOut: ({ home }) => `Dieses Gerät ist bei ${home} nicht angemeldet.`,
        codeFailedTooLarge: 'Es hat zu viele Adressen für einen Code.',
        codeFailedRefused: ({ home }) => `${home} hat die Anfrage abgelehnt.`,
        codeFailedUnexpected: 'Etwas ist schiefgelaufen; versuche es erneut.',
        cancelCode: 'Code verwerfen',
        newCode: 'Neuer Code',
        qrLabel: ({ home }) => `QR-Code, der ein Gerät zu ${home} hinzufügt`,
        storeQrLabel: ({ store }) => `QR-Code für Happier im ${store}`,
        getTheApp: 'App holen',
        connectServicesTitle: ({ first, second }) => (second ? `${first} oder ${second} verbinden` : `${first} verbinden`),
        connectServicesSubtitle: 'Nutze das Abo, das du schon bezahlst, auf jedem Rechner – und sieh, was noch übrig ist.',
    } } satisfies Pick<Readonly<Record<string, HomeSetupTranslation>>, "de">;

return { homeSetupTranslations };
})();

const Domain_homeWidgetTranslations = (() => {
type HomeWidgetTranslation = Shared_homeWidgetTranslations.HomeWidgetTranslation;

const homeWidgetTranslations = { de: {
        open: ({ destination }) => `${destination} öffnen`,
        refreshFailed: 'Aktualisieren fehlgeschlagen',
        latestRunsTitle: 'Letzte Ausführungen',
        latestRunsLoading: 'Letzte Ausführungen werden geladen',
        latestRunsEmptyTitle: 'Noch keine Ausführungen',
        latestRunsEmptyReason: 'Sobald deine Automationen laufen, siehst du hier, wie jede Ausführung verlaufen ist.',
        latestRunsErrorTitle: 'Letzte Ausführungen konnten nicht geladen werden',
        latestRunsErrorReason: 'Dein Home hat nicht geantwortet. Prüfe die Verbindung und versuche es erneut.',
    } } satisfies Pick<Readonly<Record<string, HomeWidgetTranslation>>, "de">;

return { homeWidgetTranslations };
})();

const Domain_homesHubTranslations = (() => {
type HomesHubTranslation = Shared_homesHubTranslations.HomesHubTranslation;

const homesHubTranslations = { de: {
        addHomeOrSignIn: 'Home hinzufügen / Anmelden',
        sheetDescription: 'Verbinde dieses Gerät mit einem anderen Home oder finde deine.',
        continueWithService: ({ service }) => `Weiter mit ${service}`,
        continueWithThisHome: 'Mit diesem Home fortfahren',
        continueWithServiceSubtitle: 'Finde deine Homes und mach dieses auf deinen anderen Geräten verfügbar.',
        serviceUnavailable: ({ service }) => `${service} ist gerade nicht erreichbar.`,
        serviceUnsupported: ({ service }) => `${service} bietet keine Kontoanmeldung an.`,
        serviceUnavailableUnnamed: 'Dein Anmeldedienst ist gerade nicht erreichbar.',
        serviceUnsupportedUnnamed: 'Dein Anmeldedienst bietet keine Kontoanmeldung an.',
        scanOrPaste: 'Home-Link scannen oder einfügen',
        scanOrPasteSubtitle: 'Tritt einem Home per QR-Code oder Link bei.',
        createPersonalHome: 'Ein persönliches Home auf diesem Computer erstellen',
        createPersonalHomeSubtitle: 'Betreibe hier ein Home für deine eigenen Maschinen und Geräte.',
        opensFirst: 'Öffnet zuerst',
    } } as const satisfies Pick<Record<string, HomesHubTranslation>, "de">;

return { homesHubTranslations };
})();

const Domain_homesJourneysTranslations = (() => {
type Service = Shared_homesJourneysTranslations.Service;

type Home = Shared_homesJourneysTranslations.Home;

type HomesJourneysTranslation = Shared_homesJourneysTranslations.HomesJourneysTranslation;

const en = Shared_homesJourneysTranslations.en;

const ruTimes = Shared_homesJourneysTranslations.ruTimes;

const de: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "Deine Homes sind hier",
        reconcileLead: "Dieses Telefon folgt jetzt deinen Homes gemeinsam.",
        showMySessions: "Meine Sitzungen anzeigen",
        scanComputerCode: "Scanne den Code auf deinem Computer",
        serviceLead: "Nach der Anmeldung werden deine Homes gefunden. Dieses Telefon folgt dann allen.",
        serviceAsHomeLead: ({ service }) => `Deine Sitzungen liegen auf ${service} und sind jederzeit erreichbar. Füge einen Computer für Agenten hinzu, wenn du bereit bist.`,
        factAlwaysOnDetail: "Erreiche deine Sitzungen jederzeit.",
        factAgents: "Deine Computer führen die Agenten aus",
        factAgentsDetail: "Füge später einen mit einem QR-Code hinzu.",
        fromDeviceHelp: "Öffne dort Einstellungen → Telefon hinzufügen und scanne den Code mit der Kamera dieses Telefons oder füge den Home-Link ein.",
        scan: "Scannen",
    },
    happierAccount: 'Happier-Konto',
    serviceAccount: ({ service }) => `${service}-Konto`,

    alreadyUseTitle: 'Nutzt du Happier schon?',
    alreadyUseDescription: 'Finde deine Homes mit deinem Konto oder verbinde dich direkt mit einem Home, das du betreibst. Auf diesem Computer ändert sich nichts, bis du dich entscheidest.',
    signIn: 'Anmelden',
    withService: ({ service }) => `mit ${service}`,
    changeServiceLabel: ({ service }) => `Anmeldedienst: ${service}. Ändern`,
    connectToHome: 'Mit einem Home verbinden…',
    hostedPrompt: 'Lieber gehostet?',
    useServiceAsAHome: ({ service }) => `${service} als Home nutzen`,
    dismiss: 'Ausblenden',

    pathServiceTitle: ({ service }) => `Mit ${service} anmelden`,
    pathServiceSubtitle: 'Die mit deinem Konto verknüpften Homes finden',
    pathOtherServiceTitle: 'Mit einem anderen Dienst anmelden',
    pathOtherServiceSubtitle: 'Deine eigene Anmeldung oder die deiner Firma',
    pathDirectTitle: 'Direkt mit einem Home verbinden',
    pathDirectSubtitle: 'Ein Link oder eine Adresse · kein Konto',

    serviceLead: 'Nach der Anmeldung werden deine Homes gefunden und gemeinsam angezeigt. Das persönliche Home dieses Computers bleibt, bis du entscheidest.',
    defaultServiceFact: 'der Standard-Anmeldedienst',
    serviceMethodsHelp: ({ service }) => `Es werden nur die Methoden angezeigt, die ${service} anbietet. Neu hier? Dieselben Buttons legen dein Konto an.`,

    otherServiceLead: 'Wenn du oder dein Team einen eigenen Anmeldedienst betreibt, gib seine Adresse ein. Happier prüft zuerst, was er anbietet.',
    serviceAddressLabel: 'Adresse des Anmeldedienstes',
    serviceFound: 'Gefunden',
    useThisService: ({ service }) => `Mit ${service} anmelden`,
    addressIsNotAService: 'Diese Adresse bietet keine Kontoanmeldung. Wenn es ein Home ist, verbinde dich stattdessen direkt damit.',
    connectAsHome: 'Als Home verbinden',
    backToService: ({ service }) => `Zurück zu ${service}`,

    directLead: 'Für ein Home, das du selbst betreibst, mit oder ohne Kontodienst. Kein Happier-Konto nötig.',
    fromDeviceLabel: 'Von einem bereits verbundenen Gerät',
    fromDeviceHelp: 'Öffne dort Einstellungen → Telefon hinzufügen und scanne den Code mit der Kamera dieses Computers oder füge den Home-Link ein.',
    homeLinkLabel: 'Home-Link',
    homeLinkPlaceholder: 'Home-Link einfügen',
    useCamera: 'Kamera verwenden',
    openLink: 'Öffnen',
    byAddressLabel: 'Per Adresse',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: 'Verbinden',
    byAddressHelp: 'Happier prüft, ob das Home antwortet; danach meldest du dich mit den Methoden dieses Homes an.',
    notAHomeLink: 'Das ist kein Home-Link. Kopiere ihn noch einmal vom anderen Gerät.',
    homeUnreachable: 'Happier hat unter dieser Adresse kein Home erreicht. Prüfe die Adresse und ob das Home läuft.',

    anotherWay: 'Anderer Weg',
    homeReachable: 'Erreichbar',
    connected: 'Verbunden',
    signInToHomeTitle: 'Bei diesem Home anmelden',
    signInToHomeLead: 'Diese Wege bietet dieses Home an.',

    reconcileTitle: 'Deine Homes sind verbunden',
    reconcileLead: ({ count }) => count === 1
        ? 'Dieser Computer hat jetzt zwei Homes. Sie erscheinen gemeinsam unter „Alle Homes“.'
        : `Dieser Computer hat jetzt ${count + 1} Homes. Sie erscheinen gemeinsam unter „Alle Homes“.`,
    reconcileFound: 'Gefunden',
    reconcileThisComputer: 'Dieser Computer',
    runSessionsIn: 'Sitzungen dieses Computers ausführen in',
    runSessionsInDescription: 'Neue Sitzungen, die hier gestartet werden, werden in diesem Home gespeichert.',
    removeEmptyPersonalHome: 'Leeres persönliches Home entfernen',
    removeEmptyPersonalHomeDescription: 'Es wurde bei der Installation von Happier angelegt und enthält noch nichts – keine Sitzungen, Personen, Teams oder Einladungen.',
    changeLater: 'Du kannst das später unter Einstellungen → Homes ändern.',
    keepBoth: 'Beide behalten',
    useHome: ({ home }) => `${home} verwenden`,
    reconcileSetupTitle: 'Wähle, wohin die Sitzungen dieses Computers gehen',
    reconcileSetupSubtitle: ({ home }) => `Du hast ${home} verbunden. Behalte beide Homes oder führe die Sitzungen dieses Computers dort aus.`,
    reconcileSetupAction: 'Auswählen…',

    serviceAsHomeTitle: ({ service }) => `${service} als dein Home nutzen`,
    serviceAsHomeLead: ({ service }) => `Deine Sitzungen und Einstellungen liegen dann bei ${service} statt auf diesem Computer.`,
    factAlwaysOn: 'Immer erreichbar',
    factAlwaysOnDetail: 'Dein Telefon erreicht deine Sitzungen, während dieser Computer schläft.',
    factAgents: 'Dieser Computer führt weiter deine Agents aus',
    factAgentsDetail: 'Wo Code läuft, ändert sich nicht.',
    storageE2ee: 'Ende-zu-Ende-verschlüsselt',
    storageE2eeDetail: ({ service }) => `${service} speichert deine Sitzungen, kann sie aber nicht lesen.`,
    storagePlain: ({ service }) => `Gespeichert bei ${service}`,
    storagePlainDetail: 'Nicht Ende-zu-Ende-verschlüsselt: Der Dienst kann lesen, was er speichert.',
    storageE2eeByDefault: 'Standardmäßig Ende-zu-Ende-verschlüsselt',
    storagePlainByDefault: ({ service }) => `Gespeichert bei ${service}, standardmäßig lesbar`,
    storageChoiceDetail: 'Du entscheidest beim Anlegen deines Kontos.',
    removeEmptyOfferedDetail: 'Es enthält noch nichts. Wird nur angeboten, weil es leer ist.',
    signInOrCreate: ({ account }) => `Melde dich an oder lege dein ${account} an`,
    alreadyUseServiceAsHome: ({ service }) => `Nutzt du ${service} schon als Home? Die Anmeldung verbindet es direkt.`,

    addHomeTitle: 'Home hinzufügen',
    addHomeDescription: 'Ein Home speichert deine Sitzungen und Einstellungen. Verbinde eines, das du schon nutzt, oder starte ein neues an einem anderen Ort.',
    addSignIn: ({ account }) => `Mit deinem ${account} anmelden`,
    addSignInSubtitle: 'Finde die Homes, die du schon nutzt, und verbinde sie.',
    addServiceAsHomeSubtitle: 'Für dich gehostet und immer erreichbar.',
    addLinkOrQr: 'Mit Link oder QR-Code verbinden',
    addLinkOrQrSubtitle: 'Kein Konto nötig. Hol ihn dir von einem bereits verbundenen Gerät.',
    addServerHome: 'Home auf einem Server einrichten',
    addServerHomeSubtitle: 'Eine Dev-Box oder ein VPS unter deiner Kontrolle, per SSH eingerichtet.',
    haveHomeAddress: 'Hast du eine Home-Adresse?',
    enterIt: 'Eingeben',

    livesOnThisComputer: 'Liegt auf diesem Computer',
    availableWhileAwake: 'erreichbar, solange er wach ist',
    gettingReady: 'wird vorbereitet',
    noComputerYet: 'Noch kein Computer?',
    aboutYourHome: 'Über dein Home',

    nudgeTitle: ({ count }) => `Home diese Woche ${count}-mal nicht erreichbar — Home verschieben?`,
    nudgeBody: 'Wenn dieses Home auf einem Computer läuft, der in den Ruhezustand geht, kann ein ständig eingeschalteter Host helfen.',
    nudgeDismiss: 'Auf diesem Gerät dauerhaft ausblenden',
    moveHome: 'Home verschieben…',
    useService: ({ service }) => `${service} nutzen`,
};

const homesJourneysTranslations = { de } satisfies Pick<Readonly<Record<string, HomesJourneysTranslation>>, "de">;

return { homesJourneysTranslations };
})();

const Domain_identityAdministrationTranslations = (() => {
type IdentityAdministrationLanguage = Shared_identityAdministrationTranslations.IdentityAdministrationLanguage;

type Words = Shared_identityAdministrationTranslations.Words;

type GitHubAccessWords = Shared_identityAdministrationTranslations.GitHubAccessWords;

type OidcEditorWords = Shared_identityAdministrationTranslations.OidcEditorWords;

const build = Shared_identityAdministrationTranslations.build;

const en = Shared_identityAdministrationTranslations.en;

const githubAccessWords: Pick<Readonly<Record<IdentityAdministrationLanguage, GitHubAccessWords>>, "de"> = { de: {
        githubCurrentAccess: 'Aktuell erforderlicher Zugriff',
        githubCurrentAccessSubtitle: 'Erforderlich für aktivierte Verbindungen und Verzeichnisquellen, die diese Installation verwenden.',
        githubCurrentAccessEmpty: 'Aktivierte Dienste benötigen keinen Zugriff.',
        githubSetupAccess: 'Zugriff für Einrichtung und Reparatur',
        githubSetupAccessSubtitle: 'Zugriff für konfigurierte Verbindungen, einschließlich deaktivierter Verbindungen und pausierter Verzeichnisquellen. Gewähre fehlenden Zugriff auf GitHub vor dem Aktivieren oder Fortsetzen und prüfe die Installation erneut.',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `Installation für ${name} entfernen`,
    } };

const oidcEditorWords: Pick<Readonly<Record<IdentityAdministrationLanguage, OidcEditorWords>>, "de"> = { de: {
        clientAuthenticationMethod: 'Client-Authentifizierung', clientSecretPost: 'POST-Nachrichtentext', clientSecretBasic: 'HTTP Basic', storeRefreshToken: 'Aktualisierungstoken speichern', buttonColor: 'Farbe der Anmeldeschaltfläche', iconHint: 'Anmeldesymbol',
        allowRulesHint: 'Einen Wert pro Zeile eingeben. Leer lassen für keine Einschränkung.', brandingHint: 'Leer lassen, um die Standarddarstellung zu verwenden.', invalidScopes: 'Nimm openid in die angeforderten Bereiche auf.', refreshFailed: 'Diese Verbindung konnte nicht aktualisiert werden', refreshFailedHint: 'Deine Änderungen bleiben erhalten. Versuche erneut, Änderungen auf dem Home abzurufen.',
    } };

const identityAdministrationTranslations = { de: build({ ...en, homeWorkosChooseDetail: "Wähle die WorkOS-Verbindung, über die sich Personen bei diesem Home anmelden.", homeWorkosAdd: "Unternehmensanmeldung mit WorkOS", homeWorkosCompanyName: "Unternehmensname", homeWorkosPurpose: "Menschen in deinem Unternehmen können sich mit ihrem Arbeitskonto bei diesem Home anmelden.", homeWorkosEnableDetail: "Menschen können sich dann mit ihrem Unternehmenskonto bei diesem Home anmelden.", homeWorkosOffboarding: "SSO allein entfernt keine Menschen, die dein Unternehmen verlassen.", homeWorkosPlatformRequired: "Richte WorkOS zuerst unter Anmeldeplattformen ein.",  title: 'Identitätsanbieter', subtitle: 'Home-Anmeldeverbindungen für Teams.', homeConnections: 'Home-Anmeldeverbindungen', add: 'Verbindung hinzufügen', empty: 'Keine Home-Anmeldeverbindungen', active: 'Aktiv', disabled: 'Deaktiviert', configuration: 'Konfiguration', issuer: 'Aussteller-URL', clientSecret: 'Client-Geheimnis', secretSet: 'Gesetzt', secretNotSet: 'Nicht gesetzt', secretRetain: 'Leer lassen, um das aktuelle Geheimnis zu behalten.', advanced: 'Erweiterte Einstellungen anzeigen', hideAdvanced: 'Erweiterte Einstellungen ausblenden', actions: 'Aktionen', test: 'Anmeldung testen', testing: 'Anmeldetest wird geöffnet…', edit: 'Verbindung bearbeiten', save: 'Verbindung speichern', saving: 'Wird gespeichert…', enable: 'Verbindung aktivieren', disable: 'Verbindung deaktivieren', remove: 'Verbindung entfernen', createTitle: 'Identitätsanbieter hinzufügen', editTitle: 'Identitätsanbieter bearbeiten', displayName: 'Name', required: 'Pflichtfelder ausfüllen.', invalidIssuer: 'Eine gültige HTTPS-Aussteller-URL eingeben.', secretRequired: 'Client-Geheimnis eingeben.', error: 'Die Änderung wurde nicht übernommen.', accounts: 'Betroffene Accounts', connections: 'Team-Verbindungen', errorForbidden: 'Du hast dafür keine Berechtigung mehr. Es wurde nichts geändert.', errorConflict: 'Jemand anderes war schneller. Deine Änderungen bleiben erhalten – neu laden und erneut speichern.', errorMissing: 'Das gibt es nicht mehr. Möglicherweise wurde es entfernt.', errorInUse: 'Etwas hängt noch davon ab. Entferne das zuerst.', errorProviderUnavailable: 'Der Identitätsdienst hat nicht geantwortet. Es wurde nichts geändert.', errorRateLimited: 'Der Anbieter bittet darum, vor dem nächsten Versuch zu warten.', errorInvalid: 'Das Home hat diese Werte abgelehnt. Prüfe die Konfiguration und versuche es erneut.', errorImmutable: 'Dieser Wert ist nach der Nutzung fest. Lege stattdessen einen neuen Eintrag an.', errorAuthenticationRequired: 'Melde dich erneut bei diesem Team an und versuche es dann noch einmal. Nichts wurde geändert.', errorPolicyUnavailable: 'Die Authentifizierungsrichtlinie des Teams kann gerade nicht ausgewertet werden. Nichts wurde geändert.', errorPolicyInUse: 'Die Authentifizierungsrichtlinie des Teams hängt noch von dieser Verbindung ab.', errorNotAllowed: 'Dieses Home erlaubt Teams diese Konfiguration nicht. Nichts wurde geändert.', errorNeedsAttention: 'Die Verzeichnissynchronisierung braucht Aufmerksamkeit. Starte eine vollständige Synchronisierung.', errorSyncPaused: 'Diese Quelle ist pausiert. „Synchronisierung fortsetzen“ startet eine neue vollständige Synchronisierung.', alternateLogins: 'Accounts, die eine andere Anmeldemethode brauchen', recoveryAuthenticationPolicy: 'Team-Authentifizierung öffnen', recoveryAlternateLogin: 'Gib diesen Accounts zuerst eine andere Anmeldemethode', recoveryDirectory: 'Verzeichnis öffnen', recoveryGroupMappings: 'Gruppenzuordnungen öffnen', recoveryTeamAuthentication: 'Erneut anmelden', callbackUrl: 'Callback-URL', callbackUrlHint: 'Registriere diese URL bei deinem Identitätsanbieter.' , workosSetupSso: 'WorkOS-Adminportal öffnen', workosSetupDirectory: 'WorkOS-Verzeichnissynchronisierung einrichten', workosCheckSetup: 'WorkOS-Einrichtung prüfen', workosChooseConnection: 'Verbindung auswählen', workosPortalConfirmBody: 'Du schließt die Einrichtung in WorkOS ab und wählst danach hier die Verbindung aus.', workosDirectoryPortalConfirmBody: 'Du schließt die Einrichtung in WorkOS ab und wählst danach hier das Verzeichnis aus.', workosSetupSection: 'Einrichtung', workosSetupFooter: 'Du kannst gehen und zurückkommen: Die Einrichtung macht beim erreichten Schritt weiter.', workosStepPortalDetail: 'Verbinde dort deinen Identitätsanbieter. Wenn du zurückkommst, geht es hier weiter.', workosStepPortalDone: 'Adminportal', workosStepPortalDoneDetail: 'Deine Organisation ist verknüpft.', workosOpenPortal: 'Portal öffnen', workosOpenPortalAgain: 'Erneut öffnen', workosStepChooseDetail: 'Wähle, über welche WorkOS-Verbindung sich Mitglieder anmelden.', workosStepChooseDone: 'Verbindung', workosFindConnections: 'Verbindungen suchen', workosUseConnection: ({ name }: { name: string }) => `${name} verwenden`, workosCandidateDraft: 'Ein Entwurf in WorkOS. Schließe ihn zuerst dort ab.', workosStepTestDetail: 'Melde dich einmal selbst an. Für niemanden wird etwas gespeichert.', workosTestPassed: 'Deine Testanmeldung hat funktioniert.', workosTestAgain: 'Erneut testen', workosStepEnable: 'Einschalten', workosStepEnableDetail: 'Danach können sich Mitglieder darüber anmelden. Um sie vorzuschreiben, wähle sie unter „Wie sich Mitglieder anmelden“.', workosTurnOn: 'Einschalten', workosConnectionSection: 'Verbindung', workosConnectionRow: 'WorkOS-Verbindung', workosConnectionNotChosen: 'Noch nicht ausgewählt', workosChange: 'Ändern', errorWorkosPlatformUnavailable: 'WorkOS ist auf diesem Home noch nicht eingerichtet.', errorSetupRequired: 'Das muss eingerichtet werden, bevor es verwendet werden kann.', removeTitle: ({ name }: { name: string }) => `${name} entfernen?`, removeBody: ({ name }: { name: string }) => `${name} wird nicht mehr zur Anmeldung angeboten. Accounts, die es genutzt haben, bleiben erhalten.`, removeBlocked: ({ accounts, connections }: { accounts: number; connections: number }) => `Wird noch von ${connections} Team-Verbindung(en) und ${accounts} Account(s) verwendet. Entferne diese zuerst.`, disableTitle: ({ name }: { name: string }) => `${name} ausschalten?`, disableBody: ({ name }: { name: string }) => `Niemand kann sich über ${name} anmelden, bis es wieder eingeschaltet ist. Nichts wird gelöscht.`, githubRemoveInstallationTitle: ({ name }: { name: string }) => `Installation für ${name} entfernen?`, githubRemoveInstallationBody: ({ name }: { name: string }) => `Dieses Home verwendet die App für ${name} nicht mehr. Auf GitHub ändert sich nichts; deinstalliere sie dort, wenn du sie nicht mehr brauchst.`, removeBlockedTitle: ({ name }: { name: string }) => `${name} kann noch nicht entfernt werden`, removeImpactPeople: ({ count }: { count: number }) => count === 1 ? '1 Person meldet sich darüber bei diesem Team an.' : `${count} Personen melden sich darüber bei diesem Team an.`, removeImpactNobody: 'Noch niemand meldet sich darüber bei diesem Team an.', removeImpactKept: 'Ihre Accounts und Team-Mitgliedschaften bleiben erhalten.', removeBlockedAlternateLogins: ({ count }: { count: number }) => count === 1 ? '1 Person hat keine andere Anmeldemöglichkeit.' : `${count} Personen haben keine andere Anmeldemöglichkeit.`, removeBlockedDirectories: ({ count }: { count: number }) => count === 1 ? 'Eine Verzeichnisquelle verwendet sie noch.' : `${count} Verzeichnisquellen verwenden sie noch.`, removeBlockedGroups: ({ count }: { count: number }) => count === 1 ? 'Eine Gruppenzuordnung verwendet sie noch.' : `${count} Gruppenzuordnungen verwenden sie noch.`, removeBlockedMemberships: ({ count }: { count: number }) => count === 1 ? '1 Mitgliedschaft wird noch darüber verwaltet.' : `${count} Mitgliedschaften werden noch darüber verwaltet.` }, githubAccessWords.de, oidcEditorWords.de) };

return { githubAccessWords, oidcEditorWords, identityAdministrationTranslations };
})();

const Domain_inboxWorkTranslations = (() => {
const en = Shared_inboxWorkTranslations.en;

const de: typeof en = {
    pageDescription: 'Alles, was auf dich wartet, gruppiert nach der Arbeit, zu der es gehört.',
    tabs: { a11y: 'Posteingangsansicht', needsYou: 'Braucht dich', updates: 'Neuigkeiten' },
    groups: {
        unknownLead: 'Sitzung',
        leadMeta: ({ count }) => (count === 1 ? '1 Untersitzung' : `${count} Untersitzungen`),
        runMeta: 'Workflow-Ausführung',
        otherTitle: 'Weitere Sitzungen',
        otherMeta: 'Gehören zu keinem Orchestrator und keiner Ausführung',
        openSession: 'Sitzung öffnen',
        openRun: 'Ausführung öffnen',
    },
    rows: {
        step: 'Schritt',
        workflowRun: 'Workflow-Ausführung',
        review: 'Prüfen',
        stalled: 'Hängt',
        stalledReason: 'Sein Rechner ging mitten im Zug offline',
        landing: 'Wird gemergt',
        settle: 'Abschließen',
        snoozedUntil: ({ time }) => `Zurückgestellt bis ${time}`,
        more: 'Weitere Aktionen',
        approvalNeeded: 'Braucht deine Freigabe',
        approvalUntitled: 'Eine Aktion freigeben',
    },
    popover: {
        moreInOther: ({ count }) => `${count} weitere unter Weitere Sitzungen`,
        updates: ({ count }) => (count === 1 ? '1 Neuigkeit' : `${count} Neuigkeiten`),
    },
    empty: {
        title: 'Nichts braucht dich',
        description: 'Berechtigungsanfragen, Prüfungen und alles, worauf ein Orchestrator oder Workflow wartet, landen hier.',
    },
    updatesEmpty: {
        title: 'Keine Neuigkeiten',
        description: 'Fertige Sitzungen und Freundschaftsanfragen landen hier.',
    },
    stale: { reason: 'Workflow-Ausführungen konnten nicht aktualisiert werden', retry: 'Erneut versuchen' },
    settleFailed: 'Diese Sitzung konnte nicht abgeschlossen werden',
    detail: {
        openApproval: 'Anfrage öffnen',
        idle: 'Wähle einen Eintrag, um ihn hier zu sehen',
    },
};

const inboxWorkTranslations = { de };

return { inboxWorkTranslations };
})();

const Domain_inputPickerTranslations = (() => {
type InputPickerTranslation = Shared_inputPickerTranslations.InputPickerTranslation;

const inputPickerTranslations = { de: {
        browse: 'Durchsuchen…',
        browseField: ({ field }) => `${field} durchsuchen`,
        unavailable: 'Das Plugin für diese Auswahl ist nicht verfügbar. Dein aktueller Wert bleibt erhalten.',
        retired: 'Das Plugin wurde während der Auswahl aktualisiert. Versuche es erneut.',
        invalid: 'Diese Auswahl ist hier nicht möglich. Dein aktueller Wert bleibt erhalten.',
        failed: 'Die Auswahl konnte nicht geöffnet werden. Versuche es erneut.',
    } } satisfies Pick<Readonly<Record<string, InputPickerTranslation>>, "de">;

return { inputPickerTranslations };
})();

const Domain_machineAddTranslations = (() => {
type MachineAddTranslation = Shared_machineAddTranslations.MachineAddTranslation;

const machineAddTranslations = { de: { newMachine: 'Neue Maschine', waiting: 'Warten auf die Verbindung', connected: 'Verbunden', failed: 'Diese Maschine konnte nicht hinzugefügt werden', cancelled: 'Abgebrochen', cannotReachHost: 'Host nicht erreichbar. Prüfe die Adresse und den SSH-Zugang.', choosePath: 'Wähle, wie du eine Maschine hinzufügst', switchHome: 'Kehre zu diesem Home zurück, um fortzufahren' } } satisfies Pick<Record<'en' | 'ru' | 'pl' | 'es' | 'fr' | 'it' | 'pt' | 'ca' | 'de' | 'zh-Hans' | 'zh-Hant' | 'ja', MachineAddTranslation>, "de">;

return { machineAddTranslations };
})();

const Domain_machineAgentsTranslations = (() => {
type MachineAgentsTranslation = Shared_machineAgentsTranslations.MachineAgentsTranslation;

const en = Shared_machineAgentsTranslations.en;

const de: MachineAgentsTranslation = {
    signedInWith: ({ label }) => `Angemeldet mit ${label}`,
    signedInAs: ({ label }) => `Angemeldet als ${label}`,
    signedInHere: 'Auf diesem Gerät angemeldet',
    updateTo: ({ version }) => `Auf ${version} aktualisieren`,
    needsSignIn: 'Anmeldung nötig',
    waitingForSignIn: 'Warte auf Anmeldung im Terminal…',
    notInstalled: 'Nicht installiert',
    downloadSize: ({ size }) => `${size} Download`,
    installYourself: 'Selbst installieren',
    unsupportedOs: 'Läuft nicht auf diesem System',
    unsupportedArch: 'Kein Build für diesen Prozessor',
    installing: 'Wird installiert…',
    progress: ({ done, total }) => `${done} von ${total}`,
    checking: 'Wird geprüft…',
    offlineSignedIn: 'Zuletzt angemeldet · Gerät offline',
    offlineSignedOut: 'Zuletzt abgemeldet · Gerät offline',
    offlineNotInstalled: 'Zuletzt nicht installiert · Gerät offline',
    offlineUnknown: 'Gerät offline',
    unknown: 'Dieses Gerät konnte nicht geprüft werden',
    actionInstall: 'Installieren',
    actionUpdate: 'Aktualisieren',
    actionSignIn: 'Anmelden',
    actionRetry: 'Erneut versuchen',
    actionCancel: 'Abbrechen',
    actionShowTerminal: 'Terminal zeigen',
    actionGuide: 'Einrichtungsanleitung',
    installLeadManaged: ({ agent, machine }) => `Happier installiert ${agent} auf ${machine} nur für Happier. Deine Terminal-Einrichtung bleibt unverändert.`,
    installLeadVendor: ({ agent, machine }) => `Happier führt das Installationsprogramm von ${agent} auf ${machine} aus.`,
    installAlsoDownloads: ({ what }) => `Außerdem wird ${what} geladen, das Sitzungen ausführen.`,
    installThenSignIn: 'Danach meldest du dich an.',
    installAgent: ({ agent }) => `${agent} installieren`,
    installMyself: 'Ich installiere es selbst',
    manualLead: ({ agent, machine }) => `Happier kann ${agent} nicht für dich installieren. Installiere es mit der Anleitung auf ${machine} und prüfe dann erneut.`,
    checkAgain: 'Erneut prüfen',
    closeNote: ({ machine }) => `Du kannst schließen; es läuft auf ${machine} weiter.`,
    stepCheck: 'Prüfen, ob es läuft',
    stepSignIn: 'Anmelden',
    failedKept: 'Nichts Halbinstalliertes wurde behalten.',
    installedLine: ({ agent, version }) => `${agent} ${version} ist installiert`,
    nowSignIn: 'jetzt anmelden',
    signInHow: ({ agent }) => `Wie sich ${agent} anmeldet`,
    useService: ({ service }) => `${service} verwenden`,
    recommended: 'Empfohlen',
    serviceConnected: ({ profile }) => `${profile} · bereits verbunden · funktioniert auf jedem Gerät`,
    serviceNotConnected: 'Einmal verbinden – jedes Gerät kann es nutzen.',
    connect: 'Verbinden',
    signInOn: ({ machine }) => `Auf ${machine} anmelden`,
    signInOnDetail: ({ agent }) => `Startet die Anmeldung von ${agent} in einem Terminal dort. Nur dieses Gerät nutzt sie.`,
    noNativeLogin: ({ agent }) => `${agent} hat keine eigene Anmeldung: Es nutzt einen API-Schlüssel oder ein verbundenes Konto. Einmal verbinden, dann kann jedes Gerät es nutzen.`,
    openSignInTerminal: 'Anmeldung im Terminal öffnen',
    useThisAccount: 'Dieses Konto verwenden',
    waitingLead: ({ agent, machine }) => `Die Anmeldung von ${agent} ist im Terminal auf ${machine} geöffnet. Es wird bereit, sobald es die Anmeldung meldet.`,
    readyLine: ({ agent, machine }) => `${agent} ist auf ${machine} bereit`,
    startSessionWith: ({ agent }) => `Sitzung mit ${agent} starten`,
    setUpAnother: 'Weiteren Agenten einrichten',
    unsupportedLead: ({ agent, machine }) => `Für ${machine} gibt es keinen Build von ${agent}, daher läuft es dort nicht.`,
    setupTitle: ({ agent }) => `${agent} einrichten`,
    signInTitle: ({ agent }) => `Bei ${agent} anmelden`,
    readyTitle: ({ agent }) => `${agent} ist bereit`,
    notOnMachineYet: ({ machine }) => `Noch nicht auf ${machine}`,
    onMachine: ({ machine }) => `Auf ${machine}`,
    installingOn: ({ machine }) => `Wird auf ${machine} installiert`,
    cantRunOn: ({ machine }) => `Läuft nicht auf ${machine}`,
    terminalTab: ({ agent }) => `Anmelden · ${agent}`,
    panelLead: 'Schließe im geöffneten Browser ab. Anderes Gerät? Öffne den Link dort.',
    open: 'Öffnen',
    openSignInPage: 'Anmeldeseite öffnen',
    waitingEllipsis: 'Warte auf Anmeldung…',
    signedInAlready: 'Schon angemeldet?',
    closeTerminal: 'Terminal schließen',
    showTheTerminal: 'Terminal anzeigen',
    phoneLead: ({ agent, machine }) => `${agent} bittet dich, dich anzumelden. Öffne die Seite hier, schließe ab, und ${machine} übernimmt es.`,
    panelSignedInAs: ({ account }) => `Angemeldet als ${account}.`,
    panelChecked: 'Happier hat es gerade geprüft.',
    sectionTitle: 'Agenten',
    sectionDescription: 'Die Coding-Agenten auf diesem Gerät und wie sich jeder anmeldet.',
    addTitle: 'Agenten hinzufügen',
    addMore: ({ count }) => (count === 1 ? `1 weiterer läuft hier` : `${count} weitere laufen hier`),
    showAll: 'Alle anzeigen',
    showFewer: 'Weniger anzeigen',
    emptyInstalled: 'Noch kein Coding-Agent auf diesem Gerät. Wähle unten einen; Happier installiert ihn und meldet dich an.',
    offlineNote: ({ machine }) => `${machine} ist offline. Das hat es zuletzt gemeldet.`,
    firstTitle: 'Richte deinen ersten Agenten ein',
    firstLead: ({ machine }) => `${machine} ist verbunden, hat aber noch keinen Coding-Agenten. Wähle einen; Happier installiert ihn und meldet dich an.`,
    firstMore: ({ count }) => (count === 1 ? `Oder wähle aus 1 weiteren Agenten.` : `Oder wähle aus ${count} weiteren Agenten.`),
    allAgents: 'Alle Agenten',
    setUp: 'Einrichten',
    choiceUsesService: ({ service, profile }) => `Nutzt dein ${service}. Verbunden: ${profile}.`,
    choiceSignsInOn: 'Meldet sich auf dem Gerät an.',
    dismissFirst: '„Richte deinen ersten Agenten ein“ ausblenden',
    dismissTooltip: 'Ausblenden · unter Anpassen wiederherstellen',
    chooseAgent: 'Agent auswählen',
    blockNotInstalled: ({ agent, machine }) => `${agent} ist noch nicht auf ${machine}.`,
    blockSetUpToStart: 'Richte ihn ein, um zu starten.',
    blockSignedOut: ({ agent, machine }) => `${agent} muss sich auf ${machine} anmelden.`,
    spawnCliMissing: ({ agent, machine }) => `${agent} ist auf ${machine} nicht installiert.`,
    spawnSignedOut: ({ agent, machine }) => `${agent} ist auf ${machine} abgemeldet.`,
    draftKept: 'Deine Nachricht bleibt erhalten.',
    alreadySetUp: ({ machine, home }) => `${machine} ist bereits mit ${home} verbunden`,
    startSession: 'Sitzung starten',
    openMachine: ({ machine }) => `${machine} öffnen`,
};

const machineAgentsTranslations = { de: de } satisfies Pick<Readonly<Record<string, MachineAgentsTranslation>>, "de">;

return { machineAgentsTranslations };
})();

const Domain_machineDetailPageTranslations = (() => {
type MachineDetailPageTranslations = Shared_machineDetailPageTranslations.MachineDetailPageTranslations;

const english = Shared_machineDetailPageTranslations.english;

const translated = Shared_machineDetailPageTranslations.translated;

const machineDetailPageTranslations = { de: translated({
        machineDetailPage: {
            description: 'Starte hier Sessions und sieh, was auf diesem Rechner läuft.',
            placeholderTitle: 'Rechner',
            online: 'Online',
            offline: 'Offline',
            cliVersionFact: ({ version }) => `CLI ${version}`,
            replacedByFact: ({ machine }) => `Ersetzt durch ${machine}`,
            unavailableTitle: 'Dieser Rechner kann gerade keine Sessions starten',
            startAction: 'Session starten',
            tmuxSectionDescription: 'Wie neue Sessions auf diesem Rechner tmux verwenden.',
            windowsSectionDescription: 'Wie sich Remote-Sessions auf diesem Rechner öffnen.',
            clisSectionDescription: 'Agent-CLIs, die Happier auf diesem Rechner gefunden hat, und die Tools, die es installieren kann.',
            runsSectionDescription: 'Prozesse, die Sessions auf diesem Rechner gestartet haben.',
            recentSessionsTitle: 'Letzte Sessions',
            recentSessionsDescription: 'Die fünf letzten Sessions auf diesem Rechner.',
            daemonSectionDescription: 'Der Hintergrunddienst, der diesen Rechner mit Happier verbindet.',
            stopDaemonDescription: 'Laufende Sessions laufen weiter. Neue Sessions starten erst, wenn du ihn auf diesem Rechner neu startest.',
            stopDaemonAction: 'Stoppen',
            detailsTitle: 'Rechnerdetails',
        },
    }) };

return { machineDetailPageTranslations };
})();

const Domain_machinePoolTranslations = (() => {
const en = Shared_machinePoolTranslations.en;

const de = {
    machinesSection: "Maschinen",
    tierPrimaryDescription: "Wird zuerst versucht.",
    tierFallbackDescription: "Wird versucht, wenn keine frühere Maschine online ist.",
    pauseMember: "Für neue Sitzungen pausieren",
    resumeMember: "Für neue Sitzungen verwenden",
    pausedState: "Pausiert",
    memberMenu: "Maschinenoptionen",
    newPoolTitle: "Neuer Maschinenpool",
    title: "Maschinenpools",
    myTitle: "Meine Maschinenpools",
    add: "Maschinenpool hinzufügen",
    benefit: "Wählen Sie eine bevorzugte Maschine, andere stehen als Ersatz zur Verfügung.",
    placementChangeNotice: "Änderungen gelten für Sitzungen, die nach dem Speichern starten. Offene Sitzungen bleiben auf ihrer Maschine.",
    connectionSemantics: "Beim Öffnen einer Verbindung wird eine Maschine ausgewählt und bleibt für diese Verbindung ausgewählt. Eine spätere Verbindung kann eine andere Maschine wählen.",
    noMembers: "Noch keine Maschinen in diesem Pool",
    unavailable: "Nicht verfügbar",
    memberRevoked: "Widerrufen",
    memberReplaced: "Ersetzt",
    memberTemporary: "Vorübergehend",
    availabilityUnknown: "Verbindungsverfügbarkeit unbekannt",
    notVerified: "Nicht verifiziert",
    brokerUnavailable: "Kein Broker verfügbar",
    brokerAvailable: ({ count }: { count: number }) => `${count} verfügbar`,
    basics: "Allgemeines",
    name: "Bezeichnung",
    description: "Beschreibung (optional)",
    descriptionTitle: "Beschreibung",
    addMachines: "Maschinen hinzufügen",
    noMachines: "Auf diesem Home sind keine dauerhaften Maschinen verfügbar.",
    allMachinesAdded: "Jede Maschine auf diesem Home ist bereits in diesem Pool.",
    primary: "Primär",
    addFallback: "Fallback hinzufügen",
    moveTo: "Verschieben nach",
    moveTierEarlier: "Verschieben Sie diese Ebene früher",
    moveTierLater: "Verschieben Sie diese Ebene später",
    removeMember: "Aus dem Pool nehmen",
    enableMember: "Für zukünftige Auswahlen verwenden",
    save: "Änderungen speichern",
    create: "Pool erstellen",
    delete: "Maschinenpool löschen",
    deleteTitle: "Diesen Maschinenpool löschen?",
    deleteBody: "Alle Anmeldedatenressourcen, die diesen Pool verwenden, verlieren ihren Broker-Standort und müssen repariert werden. Dies wirkt sich auf zukünftige Auswahlen aus; Maschinen werden nicht gelöscht und laufende Sitzungen nicht gestoppt.",
    saveFailed: "Dieser Maschinenpool konnte nicht gespeichert werden. Ihre Änderungen sind noch vorhanden.",
    deleteFailed: "Dieser Maschinenpool konnte nicht gelöscht werden. Versuchen Sie es erneut.",
    conflictTitle: "Dieser Pool wurde an anderer Stelle geändert",
    conflictBody: "Ihre nicht gespeicherten Änderungen bleiben erhalten. Laden Sie die gespeicherte Version erneut, um die neuesten Änderungen zu überprüfen.",
    conflictNoReload: "Die Poolidentität ist nicht mehr verfügbar. Ihre nicht gespeicherten Änderungen bleiben erhalten.",
    homeOffline: "Dieses Home ist offline. Pool-Änderungen sind erst nach der erneuten Verbindung verfügbar.",
    refreshFailed: "Maschinenpools konnten nicht aktualisiert werden. Die zuletzt bekannte Liste wird angezeigt.",
    featureUnavailable: "Maschinenpools sind auf diesem Home nicht verfügbar. Aktualisieren oder aktivieren Sie sie auf dem Home, um fortzufahren.",
    openSettings: "Maschinenpool-Einstellungen",
    pickSpecificMachine: "Eine bestimmte Maschine auswählen",
    poolNotFound: "Dieser Maschinenpool ist nicht mehr verfügbar.",
    reload: "Gespeicherte Version neu laden",
    reloadTitle: "Ihre nicht gespeicherten Änderungen verwerfen?",
    reloadBody: "Beim erneuten Laden wird dieses Formular durch die zuletzt gespeicherte Version ersetzt.",
    privacy: "Der Server dieses Homes kann Poolnamen, Beschreibungen und Mitgliedschaften lesen – auch bei Ende-zu-Ende-verschlüsselten Konten.",
    nameRequired: "Geben Sie vor dem Speichern einen Namen ein.",
    memberNotEligible: "Einige Maschinen können nicht mehr zu diesem Pool gehören.",
    memberNotEligibleDetail: "Entfernen Sie diese Maschine oder wählen Sie eine andere persistente Maschine.",
    resolvingTarget: "Eine Maschine aus diesem Pool auswählen…",
    resolveEmpty: "Dieser Pool verfügt über keine aktivierten Maschinen.",
    resolveNoAvailable: "Derzeit ist keine Maschine in diesem Pool verfügbar.",
    resolvePresenceUnavailable: "Die Maschinenverfügbarkeit ist vorübergehend nicht bekannt.",
    resolveFailed: "Happier konnte aus diesem Pool keine Maschine auswählen. Versuchen Sie es erneut.",
    executionMachine: "Ausführen auf",
    chosenFrom: "Ausgewählt aus",
    aMachinePool: "Ein Maschinenpool",
    availabilityKnown: ({ connected, enabled }: { connected: number; enabled: number }) => `${connected} von ${enabled} aktivierten verbunden`,
    fallback: ({ number }: { number: number }) => `Ausweichstufe ${number}`,
};

const machinePoolTranslations = { de };

return { machinePoolTranslations };
})();

const Domain_mcpSettingsTranslations = (() => {
type McpSettingsCopy = Shared_mcpSettingsTranslations.McpSettingsCopy;

const en = Shared_mcpSettingsTranslations.en;

const de: McpSettingsCopy = {
    purpose: 'Tool-Server, die deine Agenten in Sitzungen aufrufen können. Füge einen Server einmal hinzu und wähle dann, wo er gilt.',
    add: 'MCP-Server hinzufügen',
    addConfigure: 'Server konfigurieren',
    addConfigureDescription: 'Befehl oder Adresse eingeben',
    addImportJson: 'JSON-Konfiguration einfügen',
    addImportJsonDescription: 'Aus einer README oder einer anderen App',
    addOwnCategory: 'Selbst hinzufügen',
    addPresetCategory: 'Schnellinstallation',
    addFromMachine: 'Von diesem Rechner importieren',
    addFromMachineDescription: 'Server, die andere Agenten bereits verwenden',
    searchPlaceholder: 'Server suchen',
    toolsGroup: 'Werkzeuge',
    unbound: 'Noch nirgends verwendet',
    newServer: 'Neuer MCP-Server',
    serverPurpose: 'Ein Tool-Server, den deine Agenten aufrufen können. Wähle unten, wo er gilt.',
    addByTitle: 'Hinzufügen per',
    serverSection: 'Server',
    serverSectionDescription: 'Wie der Server in Sitzungen und in dieser Liste heißt.',
    connectionSection: 'Verbindung',
    connectionSectionDescription: 'Wie Happier den Server startet oder erreicht.',
    envDescription: 'Werte, die an den Server übergeben werden. Verwende ein gespeichertes Secret für Schlüssel.',
    headersDescription: 'Werden mit jeder Anfrage gesendet. Verwende ein gespeichertes Secret für Tokens.',
    addRule: 'Regel hinzufügen',
    discardDraft: 'Verwerfen',
    landingTitle: 'Gib deinen Agenten mehr Werkzeuge',
    landingDescription: 'MCP-Server fügen Werkzeuge wie einen Browser, Doku-Suche oder GitHub hinzu. Konfiguriere einen, füge eine Konfiguration ein oder starte mit einer Vorlage.',
    onMachineTitle: 'Auf diesem Rechner gefunden',
    onMachinePurpose: 'MCP-Server, die andere Agenten auf diesem Rechner bereits konfigurieren. Importiere einen, um ihn in Happier zu nutzen.',
    onMachineSearchSection: 'Wo gesucht wird',
    onMachineSearchDescription: 'Agent-Konfigurationen in deinem Home-Ordner und optional in einem Projektordner.',
    onMachineFoundSection: 'Server',
    onMachineFoundDescription: 'Beim Import wird der Server in Happier kopiert; die ursprüngliche Konfiguration bleibt unverändert.',
    previewTitle: 'Was Sitzungen erhalten',
    previewPurpose: 'Prüfe, welche MCP-Server eine Sitzung für einen Agenten und einen Ordner erhält und was passiert, wenn einer nicht starten kann.',
    previewContextSection: 'Sitzung',
    previewContextDescription: 'Der Agent und der Ordner, mit denen eine neue Sitzung starten würde.',
    failurePolicyTitle: 'Wenn ein Server nicht starten kann',
    failurePolicyDescription: 'Zum Beispiel, wenn ein benötigtes gespeichertes Secret fehlt.',
    failurePolicySkip: 'Überspringen',
    failurePolicyStop: 'Sitzung stoppen',
    failureSection: 'Zuverlässigkeit',
    failureSectionDescription: 'Gilt für jeden MCP-Server in jeder Sitzung.',
    previewNothingTitle: 'Nichts würde bereitgestellt',
    previewNothingDescription: 'Für diesen Agenten und Ordner gilt kein MCP-Server. Füge einen Server oder eine Regel hinzu, die sie abdeckt.',
    check: 'Prüfen',
    scan: 'Suchen',
};

const mcpSettingsTranslations = { de } as const;

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

const de: DesktopTrayTranslation = {
    open: 'Happier öffnen',
    openInHappier: 'In Happier öffnen',
    settings: 'Einstellungen…',
    startAtLogin: 'Beim Anmelden starten',
    quit: 'Happier beenden',
    stopServicesAndQuit: 'Hintergrunddienste stoppen und beenden…',
    sessions: ({ count }: CountParams) => `${count} aktiv`,
    start: 'Starten',
    restart: 'Neu starten',
    stop: 'Stoppen…',
    userOwned: 'Außerhalb von Happier verwaltet',
    checking: 'Hintergrunddienste werden geprüft…',
    readFailed: 'Hintergrunddienste konnten nicht geprüft werden',
    incomplete: 'Einige Hintergrunddienste konnten nicht geprüft werden',
    noServices: 'Dieser Computer ist noch nicht eingerichtet',
    working: 'Wird ausgeführt…',
    stopConfirmTitle: ({ relay }: RelayParams) => `Happier-Hintergrunddienst für ${relay} stoppen?`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `Agent-Sitzungen, die auf diesem Computer für ${relay} laufen, werden beendet, und dein Telefon und dein Browser erreichen ihn dort erst wieder, wenn der Dienst neu startet.`,
    stopAllConfirmTitle: 'Happier-Hintergrunddienste stoppen und beenden?',
    stopAllConfirmBody: 'Agent-Sitzungen auf diesem Computer werden beendet, und dein Telefon und dein Browser erreichen ihn erst wieder, wenn seine Hintergrunddienste neu starten.',
    stopConfirmAction: 'Stoppen',
    actionFailedTitle: 'Das hat nicht geklappt',
    loginItemFailed: 'Das Anmeldeobjekt von Happier konnte nicht aktualisiert werden',
    quitStopTitle: 'Agent-Sitzungen laufen noch',
    quitStopBody: 'Beim Beenden werden die Hintergrunddienste dieses Computers gestoppt und die Sitzungen hier beendet.',
    quitStopUnknownTitle: 'Hintergrunddienste stoppen?',
    quitStopUnknownBody: 'Happier sieht nicht, welche Sitzungen auf diesem Computer laufen. Beim Beenden werden seine Hintergrunddienste gestoppt und laufende Sitzungen beendet.',
    quitStopConfirm: 'Trotzdem stoppen',
    quitStopKeep: 'Weiterlaufen lassen',
    quitStopFailedTitle: 'Einige Hintergrunddienste wurden nicht gestoppt',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier bleibt geöffnet, damit du die Hintergrunddienste prüfen und es erneut versuchen kannst.`,
};

const deLoginStart: DesktopLoginStartTranslation = {
    title: 'Beim Anmelden starten',
    subtitle: 'Hält diesen Computer für dein Telefon und deinen Browser erreichbar: Seine Hintergrunddienste starten beim Anmelden und laufen nach dem Beenden von Happier weiter. Ist dies aus, stoppt das Beenden von Happier diese Dienste.',
    unknown: 'Happier kann noch nicht erkennen, ob die Hintergrunddienste dieses Computers beim Anmelden starten.',
    notSetUp: 'Verfügbar, sobald dieser Computer eingerichtet ist.',
};

const menuBarModeTranslations = { de: { tray: de, loginStart: deLoginStart } };

return { menuBarModeTranslations };
})();

const Domain_nativePasswordTranslations = (() => {
const nativePasswordTranslations = { de: {
        email: 'E-Mail',
        password: 'Passwort',
        signIn: 'Anmelden',
        title: 'E-Mail und Passwort',
        forgotPassword: 'Passwort vergessen?',
        capsLock: 'Feststelltaste ist aktiviert',
        emailRequired: 'Gib deine E-Mail-Adresse ein.',
        passwordRequirements: 'Verwende mindestens 15 Zeichen und höchstens 1.024 UTF-8-Bytes. Leerzeichen sind erlaubt.',
        unavailable: 'Die Anmeldung mit E-Mail und Passwort ist auf diesem Home nicht verfügbar.',
        rateLimited: 'Zu viele Versuche. Warte einen Moment und versuche es erneut.',
        emailInvalid: 'Gib eine gültige E-Mail-Adresse ein.',
        passwordMalformed: 'Dieses Passwort enthält Zeichen, die wir nicht sicher speichern können. Gib es neu ein.',
        passwordMismatch: 'Diese Passwörter stimmen nicht überein.',
        currentPasswordRequired: 'Gib dein aktuelles Passwort ein.',
        currentPassword: 'Aktuelles Passwort',
        newPassword: 'Neues Passwort',
        confirmPassword: 'Passwort bestätigen',
        signInFailed: 'Diese Kombination aus E-Mail und Passwort hat nicht funktioniert.',
        accountDisabledHere: 'Dieses Konto ist auf diesem Home deaktiviert. Bitte eine Home-Administration, es wieder zu aktivieren.',
        notEligible: 'Dieses Konto kann sich derzeit nicht bei diesem Home anmelden.',
        linkExpired: 'Dieser Link ist abgelaufen oder wurde bereits verwendet. Fordere einen neuen an.',
        revisionConflict: 'Dein Passwort wurde an anderer Stelle geändert. Lade neu und versuche es erneut.',
        serverUnavailable: 'Dieses Home konnte die Anfrage nicht abschließen. Versuche es gleich noch einmal.',
        offline: 'Keine Verbindung zu diesem Home. Prüfe dein Netzwerk und versuche es erneut.',
        homeUnreachable: 'Dieses Home ist nicht erreichbar. Versuche es erneut.',
        securityFactUnavailable: 'Konnte nicht von deinem Home gelesen werden.',
        cancelled: 'Dieser Versuch wurde abgebrochen.',
        approvalPending: 'Deine Genehmigung steht aus. Prüfe sie im Genehmigungseingang und kehre dann hierher zurück.',
        outcomeUnconfirmed: 'Wir konnten nicht bestätigen, ob die Änderung übernommen wurde. Wir haben dieses Konto aktualisiert – prüfe es, bevor du es erneut versuchst.',
        recoveryKeyRequired: 'Gib deinen Wiederherstellungsschlüssel ein, um das Passwort dieses Ende-zu-Ende-verschlüsselten Kontos zu ändern. Der Schlüssel bleibt auf diesem Gerät.',
        working: 'Wird ausgeführt …',
        showPassword: 'Passwort anzeigen',
        hidePassword: 'Passwort verbergen',
        createTitle: 'Konto erstellen',
        createAccount: 'Konto erstellen',
        accountProtection: 'Kontoschutz',
        protectionPlain: 'Vom Home lesbar',
        protectionPlainDetail: 'Dein Home kann deine Daten lesen. Wenn du dein Passwort vergisst, kannst du es per E-Mail zurücksetzen.',
        protectionE2ee: 'Ende-zu-Ende-verschlüsselt',
        protectionE2eeDetail: 'Nur deine Geräte können deine Daten lesen. Sichere deinen Wiederherstellungsschlüssel: Ein Passwort-Reset allein stellt sie nicht wieder her.',
        checkYourEmail: 'Sieh in deinen E-Mails nach',
        resend: 'Erneut senden',
        resent: 'Erneut gesendet. Sieh in deinen E-Mails nach.',
        useDifferentEmail: 'Andere E-Mail verwenden',
        connectTitle: 'E-Mail und Passwort hinzufügen',
        connectFromSecurity: 'Melde dich mit einer bereits genutzten Methode an und füge E-Mail und Passwort dann unter Kontosicherheit hinzu.',
        signInFirst: 'Zuerst anmelden',
        forgotTitle: 'Passwort vergessen?',
        forgotExplanation: 'Wir können dir eine Anleitung zum Zurücksetzen mailen, oder du nutzt den Wiederherstellungsschlüssel, den du beim Erstellen des Kontos gesichert hast.',
        emailResetInstructions: 'Anleitung zum Zurücksetzen mailen',
        useRecoveryKey: 'Wiederherstellungsschlüssel verwenden',
        recoveryKeyDownload: 'Wiederherstellungsschlüssel herunterladen',
        recoveryKeyLater: 'Später erledigen',
        securitySectionTitle: 'E-Mail und Passwort',
        signInEmail: 'Anmelde-E-Mail',
        signInEmailNotSet: 'Nicht festgelegt',
        passwordEnrolled: 'Eingerichtet',
        passwordNotEnrolled: 'Nicht eingerichtet',
        passwordSetUp: 'Dein Passwort ist für dieses Home eingerichtet.',
        passwordChanged: 'Dein Passwort wurde geändert.',
        passwordRemoved: 'Dein Passwort wurde entfernt.',
        changePassword: 'Passwort ändern',
        removePassword: 'Passwort entfernen',
        removePasswordSubtitle: 'Nur noch mit deinen anderen Methoden anmelden',
        removePasswordConsequence: 'Mit E-Mail und Passwort kannst du dich bei diesem Home nicht mehr anmelden. Deine anderen Anmeldemethoden und deine Daten bleiben unverändert.',
        changeEmailExplanation: 'Wir senden eine Bestätigung an die neue Adresse. Deine aktuelle Anmelde-E-Mail funktioniert bis zur Bestätigung weiter.',
        sendVerification: 'Bestätigungs-E-Mail senden',
        verifyTitle: 'E-Mail bestätigen',
        verifyGeneric: 'Dieser Link bestätigt die Kontrolle über ein Postfach.',
        verifyReturnToCreate: 'Kehre zu diesem Home zurück, um dein Konto mit dieser Adresse fertigzustellen.',
        addressVerified: 'Diese Adresse ist bestätigt.',
        confirmEmailChange: 'Als Anmelde-E-Mail verwenden',
        signInToConfirm: 'Melde dich auf diesem Gerät an, um die Änderung zu bestätigen.',
        returnToSignIn: 'Zurück zur Anmeldung',
        continue: 'Weiter',
        resetTitle: 'Neues Passwort festlegen',
        resetChooseNew: 'Wähle ein neues Passwort für dieses Home.',
        resetComplete: 'Dein Passwort wurde geändert. Melde dich mit dem neuen Passwort erneut an.',
        resetSignsOutOtherDevices: 'Ein neues Passwort meldet dieses Konto überall sonst ab.',
        setNewPassword: 'Neues Passwort speichern',
        emailPlaceholder: 'du@beispiel.de',
        accountDisabled: ({ home }: { home: string }) => `Dieses Konto ist auf ${home} deaktiviert. Bitte eine Home-Administration, es wieder zu aktivieren.`,
        verificationSent: ({ email }: { email: string }) => `Wir haben einen Bestätigungslink an ${email} gesendet. Öffne ihn, um dein Konto fertigzustellen.`,
        resetInstructionsSent: ({ email }: { email: string }) => `Wenn sich ${email} hier anmelden kann, ist eine Anleitung zum Zurücksetzen unterwegs.`,
        verificationPending: ({ email }: { email: string }) => `Bestätigung an ${email} gesendet`,
        verifyDestination: ({ email }: { email: string }) => `Dieser Link bestätigt ${email}.`,
        passwordNeedsEmail: 'Zuerst eine Anmelde-E-Mail hinzufügen',
        passwordNeedsEmailHint: 'Beginnt mit deiner Anmelde-E-Mail',
        setupStepConfirm: 'Bestätigen',
        setupProgress: ({ step, total, label }: { step: number; total: number; label: string }) => `Schritt ${step} von ${total}: ${label}`,
        setupEmailHint: 'Anmelde-E-Mail und Passwort werden zusammen hinzugefügt. Wir senden zuerst einen Link, um die Adresse zu bestätigen.',
        setupConfirmHint: 'Öffne den Link in dieser E-Mail, um dein Passwort festzulegen.',
        setupPasswordHint: 'Gib die bestätigte E-Mail-Adresse ein und wähle dann dein Passwort.',
    } } as const;

return { nativePasswordTranslations };
})();

const Domain_navigationPlacementTranslations = (() => {
type NavigationPlacementTranslation = Shared_navigationPlacementTranslations.NavigationPlacementTranslation;

const navigationPlacementTranslations = { de: { customize: 'Anpassen…', title: 'Navigation', description: 'Wähle, was sichtbar bleibt, unter Mehr erscheint oder ausgeblendet wird. Ziehen zum Sortieren. Auf diesem Gerät gespeichert.', pinned: 'Angeheftet', overflow: 'Mehr', hidden: 'Ausgeblendet', reset: 'Zurücksetzen', appRail: 'Linke Leiste', sessionRail: 'Sitzungsleiste', workspaceRail: 'Arbeitsbereichsleiste', sessionTabBar: 'Telefon-Tableiste' } } satisfies Pick<Record<string, NavigationPlacementTranslation>, "de">;

return { navigationPlacementTranslations };
})();

const Domain_pendingNavigationTranslations = (() => {
type Count = Shared_pendingNavigationTranslations.Count;

const en = Shared_pendingNavigationTranslations.en;

const de: typeof en = {
    nextWithCount: ({ count }) => `${count} ${count === 1 ? 'braucht' : 'brauchen'} dich`,
    next: 'Weiter', answeredElsewhere: 'Bereits beantwortet',
    unavailableTitle: 'Die nächste Anfrage konnte nicht geöffnet werden',
    unavailableBody: 'Einige wartende Sitzungen sind nicht verfügbar. Verbinde dich erneut und versuche es noch einmal.',
    skippedUnavailable: ({ count }) => `${count} nicht verfügbare Sitzungen wurden übersprungen.`,
    waitsForPermission: 'braucht deine Erlaubnis', waitsForInput: 'wartet auf deine Antwort',
    sessionsWaiting: ({ count }) => `${count} Sitzungen warten`, go: 'Los', dismiss: 'Nicht jetzt',
};

const pendingNavigationTranslations = { de };

return { pendingNavigationTranslations };
})();

const Domain_personalHomeBootstrapBlockedTranslations = (() => {
type PersonalHomeBootstrapBlockedTranslation = Shared_personalHomeBootstrapBlockedTranslations.PersonalHomeBootstrapBlockedTranslation;

const personalHomeBootstrapBlockedTranslations = { de: {
        blocked: {
            runtime_unhealthy: 'Dein lokales Home braucht Aufmerksamkeit, bevor es starten kann.',
            home_auth_invalid: 'Die Anmeldung für dein Home braucht Aufmerksamkeit.',
            existing_runtime: 'Für ein vorhandenes lokales Home ist eine Entscheidung nötig, bevor die Einrichtung fortgesetzt werden kann.',
            existing_runtime_credentials: 'Dieses lokale Home gehört zu einer anderen Happier-App auf diesem Computer.',
            personal_home_erased: 'Dein persönliches Home wurde gelöscht. Versuch es erneut, um ein neues zu erstellen.',
        },
        blockedBody: { personal_home_erased: 'Die Daten deines Homes wurden gelöscht. Hier gibt es nichts wiederherzustellen – erstelle ein neues persönliches Home oder nutze ein anderes Home.' },
    } } as const satisfies Pick<Record<string, PersonalHomeBootstrapBlockedTranslation>, "de">;

return { personalHomeBootstrapBlockedTranslations };
})();

const Domain_personalHomeDecisionTranslations = (() => {
type HomeParams = Shared_personalHomeDecisionTranslations.HomeParams;

type PersonalHomeDecisionTranslation = Shared_personalHomeDecisionTranslations.PersonalHomeDecisionTranslation;

const en = Shared_personalHomeDecisionTranslations.en;

const de: PersonalHomeDecisionTranslation = {
    homeIdentityAmbiguous: 'Diese Adresse des persönlichen Homes entspricht mehreren gespeicherten Homes.',
    signedInHome: {
        status: 'Du bist bereits bei einem anderen Home angemeldet.',
        body: ({ home }: HomeParams) => `Dieser Computer ist bei ${home} angemeldet. Nutze es weiter oder richte hier ein persönliches Home ein.`,
        keep: ({ home }: HomeParams) => `${home} weiter nutzen`,
        keepDetail: 'Deine Sitzungen und Maschinen bleiben genau so, wie sie sind.',
        create: 'Persönliches Home einrichten',
        createDetail: 'Erstelle ein privates Home auf diesem Computer und wechsle dorthin.',
    },
    existingRuntimeCredentials: {
        body: 'Diese App kann es ohne den Wiederherstellungsschlüssel dieses Homes nicht öffnen. Melde dich mit dem Schlüssel an oder nutze ein anderes Home.',
        signIn: 'Mit Wiederherstellungsschlüssel anmelden',
        signInDetail: 'Nutze den für dieses lokale Home gespeicherten Wiederherstellungsschlüssel.',
    },
};

const personalHomeDecisionTranslations = { de };

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

const de = {
    standardOnlyTitle: 'Über Home-Adressen verbinden',
    standardOnlySubtitle: 'Nutze auf diesem Gerät die Adresse jeder Home statt einer Peer-to-Peer-Verbindung.',
    defaultHomeLabel: 'Persönliches Home', homeTitle: 'Home', canonicalAddress: 'Home-Adresse', identityComparison: 'Aktuelles Home', identityComparisonMatch: 'Stimmt überein', identityComparisonMismatch: 'Stimmt nicht überein', identityComparisonUnknown: 'Nicht bestätigt',
    unknownSize: 'Unbekannte Größe', unknownTimestamp: 'Zeitstempel unbekannt', restoreBackupTitle: 'Backup', identityTitle: 'Home-Identität', identityUnavailable: 'Identität nicht verfügbar', restoreBackupDate: 'Erstellt', restoreCompatibility: 'Kompatibilität', restoreCompatible: 'Kompatibel', restoreCompatibilityVerified: 'Von dieser Version verifiziert', restoreBackupSize: 'Größe', restoreReplacementNotice: 'Die aktuellen Home-Daten werden ersetzt. Ein verifiziertes Wiederherstellungs-Backup bleibt erhalten.', restoreConfirmTitle: 'Dieses persönliche Home ersetzen und wiederherstellen?', restoreConfirmAction: 'Ersetzen und wiederherstellen', relocateConfirmTitle: 'Dieses persönliche Home verschieben?', relocateConfirmBody: 'Dein aktuelles Home wird gestoppt, bevor seine verifizierte Kopie am Ziel aktiv wird.', relocateDestination: 'Ziel', relocateConfirmAction: 'Home verschieben', recoverRestoreTitle: 'Unterbrochene Wiederherstellung reparieren?', recoverRestoreBody: 'Die unterbrochene Wiederherstellung mit den aufbewahrten Wiederherstellungsdaten zurücksetzen.', recoverRestoreAction: 'Wiederherstellung reparieren', eraseDataTitle: 'Personal-Home-Daten löschen?', eraseHomeTarget: 'Home', eraseDataBody: 'Dies ist unabhängig von der Deinstallation und löscht dauerhaft nur diese aufgelösten Home-Pfade:', estimatedSize: 'Geschätzte Größe', summaryTitle: 'Persönliches Home', footer: 'Dein Home bleibt auf diesem Computer. Diese Aktionen ändern kein anderes Home.', statusTitle: 'Status', notAvailable: 'Nicht verfügbar', storageTitle: 'Speicher', masterSecretTitle: 'Home-Zugriffsgeheimnis', masterSecretPresent: 'Vorhanden', masterSecretUnavailable: 'Nicht verfügbar', inspectAction: 'Home-Details aktualisieren', actionsTitle: 'Backup & Wiederherstellung', protectionTitle: 'Schutz', backupsSectionFooter: 'Backups enthalten lesbare Unterhaltungen, Home-Daten, den Status vertrauenswürdiger Geräte und das Home-Zugriffsgeheimnis. Speichere sie nur an einem vertrauenswürdigen Ort.', lastBackupTitle: 'Letztes Backup', lastBackupUnknown: 'Letztes Backup unbekannt', backupsTitle: 'Backup-Archive', backupAction: 'Jetzt sichern', backupSubtitle: 'Erstellt und verifiziert ein unverschlüsseltes Home-Archiv.', exportBackupAction: 'Backup exportieren…', exportBackupSubtitle: 'Erstellt ein verifiziertes Backup an einem Ort deiner Wahl.', verifyAction: 'Backup verifizieren…', verifySubtitle: 'Prüft ein Archiv, ohne es wiederherzustellen.', restoreAction: 'Wiederherstellen…', restoreSubtitle: 'Validiert ein Backup, bevor Home-Daten ersetzt werden.', relocateAction: 'Home verschieben…', relocateSubtitle: 'Dieses Home auf einen verwalteten Computer verschieben.', relocationFinishAction: 'Verschieben abschließen', relocationReturnAction: 'Zum ursprünglichen Home zurückkehren', relocationFinishSubtitle: 'Das Verschieben abschließen, nachdem das Ziel verifiziert wurde.', relocationReturnSubtitle: 'Das ursprüngliche Home als aktiven Standort behalten.', recoverRestoreSubtitle: 'Eine unterbrochene Wiederherstellung kann ausdrücklich zurückgesetzt werden.', restoreRecoveryWarningTitle: 'Wiederherstellung muss repariert werden', restoreRecoveryWarningBody: 'Der Wiederherstellungsstatus ist unklar. Es wird keine automatische Änderung vorgenommen. Prüfe die Diagnose, bevor du dieses Home reparierst.', restoreCleanupWarningTitle: 'Bereinigung der Wiederherstellung erfordert Aufmerksamkeit', restoreCleanupWarningBody: 'Das Home wurde wiederhergestellt, aber die automatische Bereinigung wurde nicht abgeschlossen. Prüfe die Diagnose und wiederhole den Home-Vorgang.', backupVerified: 'Backup verifiziert', backupNeedsAttention: 'Backup verifiziert; der Neustart des Homes erfordert Aufmerksamkeit', backupHomeReady: 'Home neu gestartet', backupRevealAction: 'Backup anzeigen', restoreResultTitle: 'Ergebnis der Wiederherstellung', restoreOutcomeRecoveryRequired: 'Wiederherstellung erforderlich', restoreOutcomeRolledBack: 'Wiederherstellung zurückgesetzt', restoreOutcomeRestored: 'Home wiederhergestellt', advancedTitle: 'Erweitert', advancedFooter: 'Laufzeitsteuerung und Diagnose für diesen Computer.', installOrUpdateAction: 'Persönliches Home installieren oder aktualisieren', startAction: 'Persönliches Home starten', stopAction: 'Persönliches Home stoppen', restartAction: 'Persönliches Home neu starten', openDataLocationAction: 'Home-Datenspeicher öffnen', openLogsAction: 'Laufzeitprotokolle öffnen', removeProfileAction: 'Home aus Happier entfernen', removeProfileSubtitle: 'Entfernt dieses Profil; Laufzeitdaten bleiben auf diesem Computer.', removeProfileTitle: 'Personal-Home-Profil entfernen?', removeProfileBody: 'Das Profil wird entfernt, Laufzeit und Daten bleiben erhalten.', uninstallRuntimeAction: 'Laufzeit deinstallieren, Daten behalten', uninstallRuntimeSubtitle: 'Entfernt Dienst und Binärdateien; Home-Daten bleiben erhalten.', deleteHomeDataTitle: 'Home-Daten löschen', removeSectionFooter: 'Die Deinstallation behält Home-Daten. Dauerhaftes Löschen ist eine separate bestätigte Aktion.', eraseDataAction: 'Personal-Home-Daten dauerhaft löschen', eraseDataSubtitle: 'Unabhängig von der Deinstallation. Löscht die aufgelösten Home-Daten dauerhaft.', eraseResultTitle: 'Home-Daten gelöscht', eraseStoppedHome: 'Das laufende Home wurde gestoppt', eraseHomeAlreadyStopped: 'Das Home war bereits gestoppt', eraseRemainingPaths: 'Konnte nicht entfernen', progressTitle: 'Personal-Home-Vorgang', dismissResult: 'Schließen',
    repairSearchAction: 'Home-Suche neu aufbauen',
    repairSearchSubtitle: 'Erstellt den Suchindex aus den Unterhaltungen dieses Homes neu.',
    repairSearchCompleteTitle: 'Home-Suche neu aufgebaut',
    repairSearchCompleteBody: 'Der Suchindex wurde aus den Unterhaltungen dieses Homes neu erstellt.',
    backupCleanupRequired: 'Das Backup ist sicher; entferne den geschützten Staging-Pfad aus den Details',
    backupCleanupPath: 'Zu entfernender geschützter Staging-Pfad',
    backupCleanupError: 'Bereinigungsfehler',
    backupDestinationMismatch: 'Das Backup wurde nicht am ausgewählten Ziel erstellt. Es wurde nichts gelöscht.',
    backupDestinationUnsafe: 'Das ausgewählte Backup-Ziel liegt innerhalb der Personal-Home-Daten, die gelöscht würden. Es wurde nichts gelöscht.',
    eraseInspectionAttention: 'Home-Daten gelöscht; die Überprüfung benötigt Aufmerksamkeit',
    searchTitle: 'Suche',
    searchReady: 'Bereit',
    searchIndexing: 'Wird indexiert …',
    searchUnavailable: 'Nicht verfügbar',
    localOnlyIngressTitle: 'Nur von diesem Computer erreichbar',
    localOnlyIngressBody: 'Öffentliche Freigaben, Provider-Callbacks, Plugin-Webhooks und Benachrichtigungen im Ruhezustand dieses Computers bleiben nicht verfügbar, bis dieses Home von außen erreichbar ist.',
} satisfies PersonalHomeSettingsCopy;

const backupDisclosureBody = { de: 'Dieses Backup enthält lesbare Unterhaltungen, Home-Daten, das Home-Zugriffsgeheimnis und den Status vertrauenswürdiger Geräte. Wer das vollständige Archiv wiederherstellen kann, kann einen Klon dieses Homes betreiben. Speichere es an einem vertrauenswürdigen Ort.' } as const;

const eraseBackupOffer = { de: { title: 'Dieses Home zuerst sichern?', body: 'Das Löschen der Home-Daten kann nicht rückgängig gemacht werden. Erstelle zuerst ein geprüftes Backup oder fahre ohne Backup fort.', continueWithoutBackup: 'Ohne Backup fortfahren' } } as const;

const operationOutcome = { de: {
        erasePartialTitle: 'Einige Home-Daten konnten nicht gelöscht werden',
        eraseOutcomeSummary: ({ removed, remaining }) => `${removed} ${removed === 1 ? 'Element' : 'Elemente'} entfernt`
            + (remaining > 0 ? `; ${remaining} ${remaining === 1 ? 'konnte' : 'konnten'} nicht entfernt werden` : ''),
        eraseNotPerformed: 'Es wurde nichts gelöscht',
        eraseBlockedBackupMismatch: 'Dieses Backup stammt von einem anderen Home.',
        eraseBlockedIdentityUnknown: 'Happier konnte nicht bestätigen, dass dieses Backup zu diesem Home gehört.',
        eraseVerificationDetail: 'Überprüfung',
        operationFailed: 'Dieser Home-Vorgang wurde nicht abgeschlossen. Öffne die Details, um zu sehen, was passiert ist.',
        restorePreviousDataTitle: 'Vorherige Daten gesichert',
    } } as const satisfies Pick<Record<string, OperationOutcomeCopy>, "de">;

const personalHomeSettingsTranslations = { de: { ...de, ...operationOutcome.de, backupDisclosureBody: backupDisclosureBody.de, eraseBackupOfferTitle: eraseBackupOffer.de.title, eraseBackupOfferBody: eraseBackupOffer.de.body, eraseContinueWithoutBackup: eraseBackupOffer.de.continueWithoutBackup } } as const;

return { backupDisclosureBody, eraseBackupOffer, operationOutcome, personalHomeSettingsTranslations };
})();

const Domain_personalizeTranslations = (() => {
type PersonalizeTranslation = Shared_personalizeTranslations.PersonalizeTranslation;

const en = Shared_personalizeTranslations.en;

const pluralPl = Shared_personalizeTranslations.pluralPl;

const pluralRu = Shared_personalizeTranslations.pluralRu;

const de: PersonalizeTranslation = {
    cardTitle: 'Happier personalisieren',
    cardSubtitle: 'Sechs schnelle Entscheidungen, jede mit Live-Vorschau.',
    cardAction: 'Personalisieren',
    cardContinue: 'Fortsetzen',
    cardProgress: ({ saved, total, step }) => `${saved} von ${total} Entscheidungen gespeichert. Weiter bei ${step}.`,
    cardProgressReview: ({ saved, total }) => `${saved} von ${total} Entscheidungen gespeichert. Prüfe deine Einrichtung.`,
    inPlaceTitle: 'Mach Happier zu deinem',
    inPlaceBody: 'Sechs schnelle Entscheidungen, jede mit Live-Vorschau. Beginne mit dem Aussehen – Home ändert sich, während du wählst.',
    inPlaceContinue: ({ count }) => `Fortsetzen · noch ${count}`,
    notNow: 'Nicht jetzt',
    flowTitle: 'Happier personalisieren',
    finishLater: 'Später abschließen',
    later: 'Später',
    stepEyebrow: ({ n, total, name }) => `Schritt ${n} von ${total} · ${name}`,
    stepCounter: ({ n, total }) => `${n} von ${total}`,
    styleEyebrow: 'Optional',
    summaryEyebrow: 'Fertig',
    previewNote: 'Vorschau. Gespeichert wird erst, wenn du Weiter wählst.',
    previewNoteSummary: 'Dein Arbeitsbereich, so wie er jetzt ist.',
    next: 'Weiter',
    review: 'Überprüfen',
    useThisSetup: 'Diese Einrichtung verwenden',
    saveFailed: 'Dieser Schritt wurde nicht gespeichert. Deine Auswahl bleibt ausgewählt.',
    tryAgain: 'Erneut versuchen',
    skipThisStep: 'Diesen Schritt überspringen',
    scopeThisDevice: 'Dieses Gerät',
    scopeAllDevices: 'Alle deine Geräte',
    stepsLabel: 'Schritte',
    savedStepsNote: ({ count }) => count === 1 ? '1 Schritt ist bereits gespeichert.' : `${count} Schritte sind bereits gespeichert.`,
    lookName: 'Aussehen',
    lookTitle: 'Mach es dir angenehm',
    lookDescription: 'Hell, dunkel oder wie dein System es vorgibt – und wie viel Glas die App zeigt.',
    themeLabel: 'Theme',
    glassLabel: 'Glas',
    glassAutoDescription: 'Glas in der ganzen App, in Schichten',
    glassEverywhereDescription: 'Ein gleichmäßiges Glas überall',
    glassSolidDescription: 'Alle Flächen deckend',
    glassCustomNote: 'Du hast das Glas unter Erscheinungsbild angepasst. Wähle eine Vorgabe, um es zu ersetzen, oder behalte deine Einstellung.',
    customizeInAppearance: 'Unter Erscheinungsbild anpassen…',
    styleName: 'Stil',
    styleTitle: 'Mit einem Stil beginnen',
    styleDescription: 'Jeder Stil legt fest, wie sich Sessions lesen und wie die Liste aussieht. Er füllt nur die nächsten Schritte vor: Gespeichert wird erst, wenn du bei jedem Schritt Weiter wählst.',
    styleKeep: 'Meine aktuelle Einrichtung behalten',
    styleActivity: 'Aktivität',
    styleConversation: 'Unterhaltung',
    styleDetail: 'Detail',
    styleCustomTag: 'Eigene',
    styleDefaultTag: 'Happier-Standard',
    styleChanges: ({ style, count }) => count === 1 ? `${style} ändert 1 Einstellung` : `${style} ändert ${count} Einstellungen`,
    styleNoChanges: 'Das ist bereits deine Einrichtung.',
    styleNever: 'Theme, Benachrichtigungen, Datenschutz und Agent-Berechtigungen sind nie Teil eines Stils.',
    was: ({ value }) => `vorher ${value}`,
    conversationName: 'Unterhaltung',
    conversationTitle: 'Der Unterhaltung folgen',
    conversationDescription: 'Wie sich die Züge einer Session und das Nachdenken des Agents lesen.',
    layoutLabel: 'Layout',
    thinkingLabel: 'Nachdenken',
    toolsName: 'Tool-Aufrufe',
    toolsTitle: 'Sehen, was der Agent getan hat',
    toolsDescription: 'Wie Befehle, Änderungen und Lesezugriffe in einer Session erscheinen.',
    toolsLabel: 'Tool-Aufrufe',
    toolTapLabel: 'Klick auf ein Tool',
    toolDetailLabel: 'Tool-Details',
    toolDetailDefault: 'Standard',
    toolDetailFull: 'Vollständig',
    workName: 'Deine Arbeit',
    workTitle: 'Deine Arbeit finden',
    workDescription: 'Wie die Session-Liste geordnet ist und wie viel jede Zeile zeigt.',
    listLayoutLabel: 'Session-Liste',
    rowsLabel: 'Zeilen',
    attentionName: 'Aufmerksamkeit',
    attentionTitle: 'Sehen, was dich braucht',
    attentionDescription: 'Wo Sessions, die auf dich warten oder zur Prüfung bereit sind, in der Liste stehen.',
    attentionLabel: 'Sessions, die dich brauchen',
    attentionHomeNote: 'Home zeigt immer, was dich braucht. Das ändert nur die Session-Liste.',
    notificationsName: 'Benachrichtigungen',
    notificationsTitle: 'Auf dem Laufenden bleiben',
    notificationsDescription: 'Was dir dieses Gerät meldet, während du etwas anderes ansiehst.',
    notificationsAllowed: 'Benachrichtigungen sind auf diesem Gerät erlaubt.',
    notificationsNotAllowed: 'Happier kann auf diesem Gerät noch keine Benachrichtigungen anzeigen.',
    notificationsUnsupported: 'Benachrichtigungen sind auf diesem Gerät nicht verfügbar. Richte sie in der Desktop-App oder auf deinem Telefon ein.',
    scopeLook: 'Design auf diesem Gerät · Glas auf allen Geräten',
    notificationsNeedsYouSummary: 'Braucht dich',
    notificationsFinishedSummary: 'Abgeschlossen',
    notificationsAllow: 'Benachrichtigungen erlauben',
    notificationsTellMe: 'Benachrichtige mich, wenn',
    notificationsNeedsYou: 'Eine Session eine Freigabe oder Antwort braucht',
    notificationsFinished: 'Eine Session ihren Zug beendet',
    notificationsShowLabel: 'Benachrichtigungen zeigen',
    notificationsShowDescription: 'Befehle, Fragen und Antworten können auf deinem Sperrbildschirm erscheinen.',
    notificationsMessage: 'Die Nachricht',
    notificationsStatus: 'Nur den Status',
    notificationsPhoneNote: 'Hinweise auf dem Telefon, während Happier geschlossen ist, richtest du auf dem Telefon ein.',
    notificationsOff: 'Keine Benachrichtigungen',
    sampleNeedsYouTitle: 'Review #2481 braucht dich',
    sampleNeedsYouBody: 'Der Agent möchte yarn test:e2e in ~/happier ausführen. Erlauben?',
    sampleReadyTitle: '„Wackeligen Reconnect-Test beheben“ ist bereit',
    sampleReadyBody: 'Gefunden: Der Retry-Timer wurde nie zurückgesetzt. Das ist behoben und der Test läuft durch.',
    sampleStatusBody: 'Öffne Happier, um es zu sehen.',
    sampleSessionReconnect: 'Wackeligen Reconnect-Test beheben',
    sampleSessionCraft: 'Feinschliff-Labor',
    sampleSessionReview: 'Review #2481',
    sampleSessionPricing: 'Texte der Preisseite',
    sampleSessionDocs: 'Suchindex der Doku',
    sampleWorking: 'Arbeitet',
    sampleNeedsYou: 'Braucht dich',
    sampleReady: 'Bereit zur Prüfung',
    summaryTitle: 'Das ist deine Einrichtung',
    summaryDescription: ({ changed }) => changed === 0
        ? 'Alles unten ist bereits gespeichert. Nichts hat sich geändert.'
        : changed === 1
            ? 'Alles unten ist bereits gespeichert. Eine Entscheidung hat sich geändert, der Rest ist wie zuvor.'
            : `Alles unten ist bereits gespeichert. ${changed} Entscheidungen haben sich geändert, der Rest ist wie zuvor.`,
    summaryChange: 'Ändern',
    summaryFooter: 'Du kannst all das später in den Einstellungen ändern oder es unter Einstellungen → Erscheinungsbild erneut durchgehen.',
    replayTitle: 'Happier personalisieren',
    replaySubtitle: 'Sechs schnelle Entscheidungen, jede mit Live-Vorschau.',
    replayAction: 'Starten',
    journeyHandoff: 'Mach es zu deinem',
};

const personalizeTranslations = { de } satisfies Pick<Readonly<Record<string, PersonalizeTranslation>>, "de">;

return { personalizeTranslations };
})();

const Domain_phoneNavigationTranslations = (() => {
const en = Shared_phoneNavigationTranslations.en;

const de: typeof en = {
    phoneNav: {
        settings: {
            sectionDescription: 'Das Telefon-Layout in Sitzungen und die Gesten auf der Leiste. Jede Geste lässt sich einzeln ausschalten.',
            swipeSidewaysTitle: 'Seitlich wischen, um Sessions zu wechseln',
            swipeSidewaysScrollsDescription: 'Vorherige oder nächste, auf der Leiste. Wenn deine Tools nicht passen, scrollt das Wischen sie stattdessen.',
            swipeSidewaysAlwaysDescription: 'Vorherige oder nächste, auf der Leiste. Es bleibt ein Wischen; Tools, die nicht passen, warten unter Mehr.',
            alwaysSwipeTitle: 'Immer zwischen Sessions wischen',
            alwaysSwipeOnDescription: 'Die Leiste behält die Tools, die passen; der Rest wartet unter Mehr.',
            alwaysSwipeOffDescription: 'Aus: Zusätzliche Tools lassen die Leiste scrollen.',
            dragUpTitle: 'Nach oben ziehen zum Wechseln',
            dragUpDescription: 'Zieh die Leiste nach oben, um deine offenen Tabs und letzten Sessions zu sehen, und gleite dann zu einer.',
            dragUpSourceTitle: 'Nach oben ziehen zeigt',
            dragUpSourceRecentDescription: 'Offene Tabs, dann was du zuletzt auf diesem Gerät geöffnet hast.',
            dragUpSourceListDescription: 'Sessions in Listenreihenfolge.',
            swipeSourceTitle: 'Seitlich wischen zeigt',
            swipeSourceListDescription: 'Die nächste oder vorherige Session in deiner Liste.',
            swipeSourceRecentDescription: 'Die nächste oder vorherige nach dem Zeitpunkt, an dem du sie zuletzt geöffnet hast.',
            sourceRecent: 'Zuletzt',
            sourceList: 'Sessionliste',
            flickTitle: 'Nach oben oder unten flicken zum Wechseln',
            flickDescription: 'Ein kurzer Flick öffnet die nächste oder vorherige.',
            holdToDockTitle: 'Halten, um den Wechsler offen zu lassen',
            holdToDockDescription: 'Halte die Leiste und lass los, um per Tippen auszuwählen.',
            pullAllTabsTitle: 'Titel nach unten ziehen für alle Tabs',
            pullAllTabsDescription: 'Zieh den Sessiontitel nach unten, um jeden offenen Tab und jede letzte Session zu sehen.',
        },
        bar: {
            onTheBar: 'Auf der Leiste',
            more: 'Mehr',
            heldInMore: 'Unter Mehr, solange „Immer wischen“ an ist',
            keepOnBar: 'Auf der Leiste behalten',
            removeFromBar: 'Von der Leiste entfernen',
            openFiles: 'Dateien öffnen',
        },
        allTabs: {
            title: 'Alle Tabs',
            pullHint: 'Ziehen für alle Tabs',
            releaseHint: 'Loslassen für alle Tabs',
            openTabs: 'Offene Tabs',
            openTabsSynced: 'Offene Tabs · synchronisiert',
            recent: 'Zuletzt',
            recentOnThisDevice: 'Zuletzt auf diesem Telefon',
            here: 'Hier',
            panes: ({ count }: { count: number }) => `${count} Bereiche`,
            emptyTitle: 'Nichts anderes ist geöffnet',
            emptyDescription: 'Sessions, die du öffnest, und Tabs, die du behältst, erscheinen hier, die neuesten zuerst.',
            openTab: ({ title }: { title: string }) => `${title} öffnen`,
        },
        rail: {
            label: 'Offene Tabs',
            synced: 'Synchronisiert',
            syncedA11y: 'Offene Tabs werden über deine Geräte synchronisiert',
            notAvailableTitle: 'Auf diesem Telefon nicht verfügbar',
            notAvailableUnknown: 'Dieser Tab wurde auf einem anderen Gerät geöffnet und dieses Telefon kann ihn nicht anzeigen. Er bleibt dort geöffnet.',
            closeTab: 'Tab schließen',
            paneOf: ({ position, total }: { position: number; total: number }) => `${position} von ${total}`,
            nextPane: 'Nächster Bereich',
            chatPane: 'Chat',
        },
        switcher: {
            title: 'Wechseln zu',
            allSessions: 'Alle Sessions',
            openTabs: 'Offene Tabs',
            synced: 'synchronisiert',
            recent: 'Zuletzt',
            recentOnThisDevice: 'Zuletzt auf diesem Telefon',
            sessions: 'Sessions',
            nextInSessions: 'Nächste in Sessions',
            previousInSessions: 'Vorherige in Sessions',
            furtherBack: 'Weiter zurück',
            moreRecent: 'Neuer',
            here: 'Hier',
            stayOn: 'Bleiben bei',
            noOlderSessions: 'Keine älteren Sessions',
            noNewerSessions: 'Keine neueren Sessions',
            lastInSessions: 'Das ist die letzte in Sessions.',
            firstInSessions: 'Das ist die erste in Sessions.',
            nothingFurtherBack: 'Nichts weiter zurück.',
            mostRecent: 'Das ist die neueste.',
            nothingToSwitch: 'Nichts anderes ist geöffnet',
            nothingToSwitchDescription: 'Sessions, die du öffnest, erscheinen hier, die neuesten zuerst.',
            draft: ({ text }: { text: string }) => `Dein Entwurf: „${text}“`,
            switchSessionAction: 'Session wechseln',
            switchedTo: ({ name }: { name: string }) => `Gewechselt zu ${name}`,
            close: 'Schließen',
            positionOf: ({ position, total }: { position: number; total: number }) => `${position} von ${total}`,
        },
    },
};

const phoneNavigationTranslations = { de };

return { phoneNavigationTranslations };
})();

const Domain_pluginAccountDataEraseTranslations = (() => {
const english = Shared_pluginAccountDataEraseTranslations.english;

const pluginAccountDataEraseTranslations = { de: {
    accountDataErase: {
        installedGroupTitle: 'Kontodaten',
        installedGroupFooter: 'Das betrifft nur die aufbewahrten Daten des aktuellen Kontos. Es deinstalliert dieses Plugin auf keinem Rechner.',
        installedEntryTitle: 'Kontodaten löschen',
        installedEntrySubtitle: 'Die aufbewahrten Daten dieses Plugins dauerhaft aus dem aktuellen Konto entfernen.',
        orphanedGroupTitle: 'Aufbewahrte Plugin-Daten',
        orphanedGroupFooter: 'Nutz eine Plugin-ID, um aufbewahrte Kontodaten zu entfernen, nachdem ein Plugin entfernt wurde.',
        orphanedEntryTitle: 'Aufbewahrte Plugin-Daten löschen',
        orphanedEntrySubtitle: 'Gib die ID eines installierten oder entfernten Plugins ein, um seine aktuellen Kontodaten dauerhaft zu löschen.',
        promptTitle: 'Plugin-ID',
        promptBody: 'Gib die ID des Plugins ein, dessen aufbewahrte Daten du aus dem aktuellen Konto löschen willst.',
        promptPlaceholder: 'com.example.plugin',
        invalidTitle: 'Gib eine Plugin-ID ein',
        invalidBody: 'Nutz die exakte Plugin-ID, bevor du weitermachst.',
        confirmTitle: 'Plugin-Daten des Kontos löschen?',
        confirmBody: ({ pluginId }: { pluginId: string }) => `Damit werden die aufbewahrten Daten dauerhaft entfernt für ${pluginId} aus dem aktuellen Konto. Das Plugin wird dabei auf deinen Rechnern nicht deinstalliert.`,
        confirm: 'Daten löschen',
        completedTitle: 'Plugin-Daten des Kontos gelöscht',
        completedChanged: 'Die aufbewahrten Plugin-Daten wurden aus dem aktuellen Konto entfernt.',
        completedEmpty: 'Für dieses Plugin wurden im aktuellen Konto keine aufbewahrten Daten gefunden.',
        partialTitle: 'Einige Plugin-Daten bleiben übrig',
        partialBody: 'Ein Teil der aufbewahrten Daten ließ sich nicht löschen. Es wird nichts automatisch wiederholt; versuch es erneut, um den Rest zu löschen.',
        failedTitle: 'Die Plugin-Daten wurden nicht gelöscht',
        failedBody: 'Die aufbewahrten Daten ließen sich nicht löschen. Versuch es erneut, nachdem du die Verbindung zum aktuellen Konto geprüft hast.',
        unavailableTitle: 'Die Plugin-Daten sind nicht verfügbar',
        unavailableBody: 'Das aktuelle Konto hat sich geändert oder ist nicht verfügbar. Öffne diese Aktion erneut, sobald das Konto bereit ist.',
    },
} } as const;

return { pluginAccountDataEraseTranslations };
})();

const Domain_pluginAccountReleaseSelectionTranslations = (() => {
const english = Shared_pluginAccountReleaseSelectionTranslations.english;

const completeReleaseSelection = Shared_pluginAccountReleaseSelectionTranslations.completeReleaseSelection;

const localizedPluginAccountReleaseSelectionTranslations = { de: {
    accountReleaseSelection: {
        groupTitle: 'Konto-Release',
        groupFooter: 'Wähl einen exakten Release für dieses Konto. Das installiert, aktualisiert oder vertraut dem Plugin auf keinem Rechner.',
        entryTitle: 'Für dieses Konto nutzen',
        entrySubtitle: ({ version }: { version: string }) => `Version wählen: ${version} für das aktuelle Konto, ohne eine Installation auf einem Rechner zu ändern.`,
        selectedTitle: 'Konto-Release gewählt',
        selectedBody: 'Der gewählte Plugin-Release wird jetzt für dieses Konto genutzt.',
        conflictTitle: 'Konto-Release geändert',
        conflictBody: 'Der Konto-Release hat sich geändert, während diese Aktion offen war. Öffne sie erneut und versuch es noch einmal.',
        unavailableTitle: 'Konto-Release nicht verfügbar',
        unavailableBody: 'Der exakte Release oder seine nötige Migrationsquelle ist für das aktuelle Konto nicht verfügbar. Versuch es, sobald das Konto bereit ist.',
        rejectedTitle: 'Der Konto-Release wurde nicht gewählt',
        rejectedBody: 'Das Konto hat diese Release-Auswahl nicht angenommen. Prüf den Kontozustand und versuch es noch einmal.',
        hostedGroupFooter: 'Verwalte die Plugin-Artefakte, die dieses Konto für das Plugin hostet. Aktuell bietet kein Rechner diesen Release an, deshalb lässt er sich hier nicht auswählen.',
        hostedEnableTitle: 'Plugin-Artefakte für dieses Konto hosten',
        hostedEnableBody: "Speichert die Oberfläche und Paketressourcen dieses Plugins auf deinem Kontoserver. Bei Klartextkonten kann der Server die Daten lesen; bei E2EE-Konten speichert er verschlüsselte Daten. Release-Metadaten bleiben sichtbar. Das installiert oder vertraut dem Plugin nicht und ermöglicht keine Offline-Ausführung auf Rechnern.",
        hostedDisableTitle: 'Hosting der Plugin-Artefakte beenden',
        hostedStatusDisabled: "Deaktiviert. Aktiviere Hosting, um die Artefakte dieses Releases auch bei offline geschaltetem Quellrechner herunterzuladen.",
        hostedStatusPending: 'Aktiviert. Dieser Release wartet darauf, dass der Host seine exakten Plugin-Artefakte veröffentlicht.',
        hostedStatusReady: 'Gehostete Plugin-Artefakte sind für genau diesen Release verfügbar.',
        hostedRemoveTitle: 'Hosting deaktivieren und Artefakte entfernen',
        hostedRemoveBody: 'Beendet das Konto-Hosting und entfernt die exakten gehosteten Plugin-Artefakte dieses Releases. Das Leeren des lokalen Caches ist davon getrennt.',
        hostedClearCacheTitle: 'Lokalen Artefakt-Cache leeren',
        hostedClearCacheBody: 'Entfernt die lokal zwischengespeicherten UI-Artefakt-Bytes dieses exakten Releases, ohne das Konto-Hosting zu ändern.',
    },
} } as const;

const pluginAccountReleaseSelectionTranslations = { de: completeReleaseSelection(localizedPluginAccountReleaseSelectionTranslations.de) };

return { localizedPluginAccountReleaseSelectionTranslations, pluginAccountReleaseSelectionTranslations };
})();

const Domain_pluginInvocationLogTranslations = (() => {
const en = Shared_pluginInvocationLogTranslations.en;

const pluginInvocationLogTranslations = { de: {
    invocationLogs: {
        title: 'Aufruf-Logs',
        footer: 'Begrenzte, geschwärzte Einträge vom gewählten Plugin-Rechner.',
        correlationFilter: 'Filter nach Korrelations-ID',
        correlationFilterAll: 'Alle Aufrufe dieses Plugins',
        correlationPromptTitle: 'Nach Korrelations-ID filtern',
        correlationPromptBody: 'Nur Einträge eines einzigen exakten Plugin-Aufrufs zeigen. Leer lassen, um alle Einträge zu zeigen.',
        correlationPromptPlaceholder: 'Korrelations-ID',
        refresh: 'Logs aktualisieren',
        follow: 'Logs verfolgen',
        stopFollowing: 'Verfolgen beenden',
        loadMore: 'Nächste Einträge laden',
        loadingTitle: 'Aufruf-Logs werden geladen',
        loadingSubtitle: 'Begrenzte, geschwärzte Einträge werden vom gewählten Rechner gelesen.',
        idleTitle: 'Bereit, Aufruf-Logs zu lesen',
        idleSubtitle: 'Aktualisiere, um begrenzte, geschwärzte Einträge vom gewählten Rechner zu lesen.',
        emptyTitle: 'Keine Aufruf-Logs',
        emptySubtitle: 'Auf diesem gewählten Rechner gibt es keine passenden geschwärzten Einträge.',
        unavailableTitle: 'Aufruf-Logs nicht verfügbar',
        unavailableSubtitle: 'Der gewählte Plugin-Rechner ist nicht verfügbar oder nicht mehr aktuell.',
        readerUnavailableSubtitle: 'Der gewählte Plugin-Rechner kann gerade keine Aufruf-Logs liefern.',
        selectionRequiredTitle: 'Wähl einen Plugin-Rechner',
        selectionRequiredSubtitle: 'Wähl oben eine kompatible Plugin-Materialisierung, bevor du ihre Logs liest.',
        conflictTitle: 'Den gewählten Plugin-Rechner klären',
        conflictSubtitle: 'Wähl oben eine kompatible Plugin-Materialisierung, bevor du ihre Logs liest.',
        errorTitle: 'Die Aufruf-Logs ließen sich nicht laden',
        errorSubtitle: 'Das Lesen der Logs wurde nicht abgeschlossen. Versuch es erneut, sobald der gewählte Rechner verfügbar ist.',
        noMessage: 'Plugin-Log-Ereignis',
        level: {
            debug: 'Debug',
            info: 'Info',
            warn: 'Warnung',
            error: 'Fehler',
            diagnostic: 'Diagnose',
        },
    },
} } as const;

return { pluginInvocationLogTranslations };
})();

const Domain_pluginMachineMatrixTranslations = (() => {
const english = Shared_pluginMachineMatrixTranslations.english;

const pluginMachineMatrixTranslations = { de: {
        machineMatrix: {
            title: 'Auf deinen Rechnern',
            footer: 'Nur zur Ansicht. Installieren, Aktualisieren und alle anderen Plugin-Aktionen laufen auf dem oben gewählten Rechner.',
            empty: 'Noch kein Rechner hat eine Plugin-Installation für dieses Konto gemeldet.',
            unavailable: 'Die Plugin-Verfügbarkeit des Kontos ist noch nicht geladen, deshalb sind die Rechnerzustände unbekannt.',
            incomplete: ({ count }: { count: number }) => `Diese Liste kann unvollständig sein: ${count} Server haben ihre Rechner noch nicht gemeldet.`,
            summary: ({ installed, total }: { installed: number; total: number }) => `Installiert und aktuell auf ${installed} von ${total} Rechnern`,
            lastObserved: ({ ago }: { ago: string }) => `zuletzt gesehen: ${ago}`,
            state: {
                installedCurrent: 'Installiert und aktuell',
                disabled: 'Deaktiviert',
                untrusted: 'Nicht vertrauenswürdig',
                incompatible: 'Anderer Release',
                localOnly: 'Nur auf diesem Rechner',
                staleOffline: 'Letzter Stand, Rechner offline',
                absent: 'Nicht installiert',
                unknown: 'Unbekannt',
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

const marketplacePresentation = { de: {
        diagnosticsIssueTitle: 'Plugin-Problem', diagnosticsRecovery: 'Prüfe die Details oben und lade das Plugin oder diese Seite nach der Korrektur neu.', diagnosticsTechnicalCode: ({ code }: { code: string }) => `Technischer Code: ${code}`,
        discover: { publisherLabel: ({ displayName, id }: { displayName: string; id: string }) => `Herausgeberangabe: ${displayName} (${id})`, categories: ({ values }: { values: string }) => `Kategorien: ${values}`, runtimeSummary: ({ realms, platforms }: { realms: string; platforms: string }) => `Ausführung: ${realms} · Plattformen: ${platforms}`, reviewStatus: { curated: 'Kuratierte Empfehlung', unreviewed: 'Nicht geprüft', withdrawn: 'Zurückgezogen' }, executableRealm: { daemon: 'Hintergrunddienst', client: 'App', hostedWeb: 'gehostetes Web' }, platform: { darwin: 'macOS', linux: 'Linux', windows: 'Windows', web: 'Web', ios: 'iOS', android: 'Android' }, diagnostic: { title: 'Problem mit einer Marktplatzquelle', recovery: 'Aktualisiere „Entdecken“. Wenn das Problem bleibt, prüfe „Quellen & Registries“.', unreachableTitle: ({ source }: { source: string }) => `${source} ist nicht erreichbar`, behindTitle: ({ source }: { source: string }) => `${source} lieferte veraltete oder unvollständige Daten`, indexTitle: 'Der Plugin-Index ist unvollständig', otherSourcesShown: 'Ergebnisse anderer Quellen werden weiterhin angezeigt.' } },
    } } as const;

const localizedTechnicalReviewVocabulary = { de: { source: ({ kind, locator }: { kind: string; locator: string }) => `${kind}: ${locator}`, sourceKind: { path: 'Lokaler Pfad', archive: 'Archivdatei', npm: 'npm-Paket' }, marketplaceSource: ({ kind, source }: { kind: string; source: string }) => `${kind}: ${source}`, marketplaceSourceKind: { curated: 'Kuratierter Katalog', 'community-npm': 'Öffentlicher npm-Katalog', user: 'Benutzerkatalog' }, executableRealm: { daemon: 'Code des Hintergrunddiensts', reactNative: 'Code der App-Oberfläche', hostedWeb: 'Isolierter gehosteter Web-Code' }, uiArtifacts: ({ status, ids }: { status: string; ids: string }) => `${status}: ${ids}`, uiArtifactStatus: { verified: 'Verifizierte Oberflächenartefakte', none: 'Keine Oberflächenartefakte', unavailable: 'Oberflächenartefakte nicht verfügbar' }, authorizationClass: { cooperativeDisclosure: 'Kooperative Offenlegung', hostResourceSelection: 'Ausgewählte Hostressourcen', presentIntentOrOs: 'Aktuelle Absicht oder Betriebssystemfreigabe' }, priority: ({ priority }: { priority: number }) => `Priorität ${priority}` } } as const;

const localizedReviewVocabulary = { de: {
        installReviewSections: {
            ...localizedTechnicalReviewVocabulary.de,
            archiveUrlRetention: 'Happier speichert die vollständige Archiv-URL einschließlich möglicher Zugangsdaten auf der ausgewählten Maschine für spätere Updates. Abgelaufene oder widerrufene URLs können Updates verhindern.',
            trustedCodeTitle: 'Vertrauenswürdiger Code', trustedCodeDisclosure: 'Plugins laufen als vertrauenswürdiger Code in Happier, nicht in einer Sandbox. Ein Plugin kann die Rechte dieser App direkt nutzen – Dateien, Netzwerk, Umgebung und Prozesse – über die unten aufgeführten, von Happier vermittelten Dienste hinaus. Diese Liste ist das, was das Plugin deklariert hat und was du später abschalten kannst, keine Grenze für das, was sein Code erreichen kann.',
            identity: 'Identität und Paket', evidence: 'Technische Nachweise', executableCode: 'Ausführbarer Code und Beiträge', requiredAccess: 'Erforderlicher Hostzugriff', optionalAccess: 'Optionaler Hostzugriff', requestInterceptors: 'Anfrage-Interceptoren', rawCredentials: 'Deklarationen für direkte Zugangsdaten', compatibility: 'Kompatibilität und Aktualisierungen', none: 'Nichts deklariert',
            scope: ({ scope }: { scope: string }) => `Geltungsbereich: ${scope}`, developmentPath: ({ locator }: { locator: string }) => `${locator} · Entwicklung`, publisherUnverified: ({ displayName, id }: { displayName: string; id: string }) => `${displayName} · ${id} · nicht verifiziert`,
            integrityBasis: { expected: ({ integrity }: { integrity: string }) => `${integrity} (erwartet)`, observed: ({ integrity }: { integrity: string }) => `${integrity} (beobachtet)` },
            signatureStatus: { verified: ({ keyId }: { keyId: string }) => `Verifizierte Registry-Signatur: ${keyId}`, unsupported: ({ keyId }: { keyId: string }) => `Nicht unterstützte Registry-Signatur: ${keyId}` },
            provenanceDeclaredUnverified: ({ predicateType }: { predicateType: string }) => `Deklariert, nicht verifiziert: ${predicateType}`, provenanceRetrievedUnverified: ({ predicateTypes }: { predicateTypes: string }) => `Abgerufen, nicht verifiziert: ${predicateTypes}`, provenanceUnavailable: ({ code }: { code: string }) => `Herkunftsnachweis nicht verfügbar: ${code}`,
            curationUnreviewed: ({ sourceId }: { sourceId: string }) => `Nicht geprüfte Katalogquelle: ${sourceId}`, curationApproved: ({ sourceId, reviewedAt, reason }: { sourceId: string; reviewedAt: string; reason: string }) => `Von ${sourceId} am ${reviewedAt} geprüft${reason}`,
            savedSecret: 'Gespeichertes Geheimnis', connectedAccount: 'Verbundenes Konto', secretKinds: ({ kinds }: { kinds: string }) => `Geheimnisarten: ${kinds}`, connectedAccountService: ({ service }: { service: string }) => `Dienst: ${service}`, credentialPurpose: ({ purpose }: { purpose: string }) => `Zweck: ${purpose}`, credentialUse: ({ realm, phase }: { realm: string; phase: string }) => `Verwendung in ${realm} während ${phase}`, credentialAccess: ({ access }: { access: string }) => `Zugriff: ${access}`, credentialRequestHeaders: ({ origin, headers }: { origin: string; headers: string }) => `An ${origin} gesendete Header: ${headers}`, credentialRequestEnvironment: ({ keys }: { keys: string }) => `Umgebungsvariablen: ${keys}`, credentialRequestFiles: ({ files }: { files: string }) => `Dateien: ${files}`,
            realm: { web: 'Webbereich', ios: 'iOS-App', android: 'Android-App', daemon: 'Hintergrunddienst' }, phase: { settings: 'der Einrichtung', prepare: 'der Vorbereitung', connection: 'der Verbindung', speech: 'der Sprachnutzung' }, runtimeApi: ({ version }: { version: number }) => `Laufzeit-API ${version}`,
        },
        sourceAdministration: {
            title: 'Quellen und Registries', subtitle: 'Lege fest, wo dieser Rechner genaue npm-Pakete findet und wie er ihre Registries erreicht.', communityTitle: 'Öffentliches npm-Verzeichnis', communitySubtitle: 'Integriert · ungeprüfte Suche nach geeigneten Happier-Plugins auf öffentlichem npm, nicht nach beliebigen npm-Paketen.', configuredTitle: 'Marktplatzquellen', configuredEmpty: 'Keine zusätzlichen Marktplatzquellen konfiguriert.', add: 'Quelle hinzufügen', edit: 'Quelle bearbeiten', remove: 'Quelle entfernen', removeTitle: 'Marktplatzquelle entfernen?', removeBody: ({ name }: { name: string }) => `${name} wird auf diesem Rechner nicht mehr zur Suche verwendet. Installierte Plugins bleiben unverändert.`, sourceUrl: 'Quelladresse', displayName: 'Anzeigename', description: 'Beschreibung (optional)', enabled: 'Aktiviert', disabled: 'Deaktiviert', curated: 'Kuratierte Quelle', user: 'Eigene Quelle', loadError: 'Marktplatzquellen konnten nicht geladen werden.', retry: 'Erneut versuchen', operationFailed: 'Diese Änderung konnte nicht angewendet werden. Prüfe die Rechnerverbindung und versuche es erneut.', operationOutcomeUnknownTitle: 'Änderung muss geprüft werden', operationOutcomeUnknownBody: 'Der ausgewählte Rechner hat diese Änderung möglicherweise bereits angewendet, Happier konnte das Ergebnis aber nicht bestätigen. Prüfe die aktualisierten Einstellungen, bevor du sie erneut änderst.',
        },
        updatePolicy: {
            title: 'Aktualisierungsrichtlinie', target: ({ machine, server }: { machine: string; server: string }) => `Gilt auf ${machine} über ${server}.`, pinned: 'Fest angeheftet', pinnedSubtitle: 'Nicht aktualisieren, bis eine andere Richtlinie gewählt wird.', allowed: 'Aktualisierungen erlaubt', allowedSubtitle: 'Explizite Aktualisierungen werden ohne weitere Nachfrage ausgeführt, solange sich die deklarierte Berechtigung nicht erweitert.',
        },
    } } as const;

const pluginMarketplaceDiscoverTranslations = { de: {
        ...localizedReviewVocabulary.de,
        ...marketplacePresentation.de,
        secretFieldActions: { delete: 'Gespeichertes Geheimnis löschen', deleteHint: 'Löscht den gespeicherten Wert endgültig. Das lässt sich nicht rückgängig machen.', unbind: 'Aus diesem Plugin entfernen', unbindHint: 'Löst das gespeicherte Geheimnis von dieser Einstellung. Das Geheimnis selbst bleibt erhalten.' },
        pluginChangeOutcomeUnknownTitle: 'Ergebnis nicht bestätigt',
        pluginChangeOutcomeUnknownBody: ({ action, name, machine, server }: { action: string; name: string; machine: string; server: string }) => `Happier konnte nicht bestätigen, ob ${action} für ${name} auf ${machine} (${server}) abgeschlossen wurde. Sieh dort unter „Installiert“ nach und prüfe die aktuelle Version, bevor du es erneut versuchst.`,
        updateFromInstalledRecordSubtitle: 'Diese Installation über ihren eigenen vertrauten Update-Kanal aktualisieren.',
        discover: {
            ...marketplacePresentation.de.discover,
            status: {
                loading: 'Alle Marktplatzquellen werden durchsucht …',
                loadingSource: ({ source }: { source: string }) => `${source} wird durchsucht …`,
                results: ({ count, sources }: { count: number; sources: number }) =>
                    `${count} Plugin(s) aus ${sources} Quelle(n)`,
                empty: 'Keine Plugins passen zu dieser Suche.',
                error: ({ message }: { message: string }) => `Diese Suche konnte nicht aktualisiert werden: ${message}`,
                errorTitle: 'Diese Suche konnte nicht aktualisiert werden',
                stale: 'Diese Ergebnisse gehören zu einer früheren Suche. Suche erneut, um die Einstellungen oben anzuwenden.',
                partial: ({ count }: { count: number }) =>
                    `${count} Quelle(n) haben mit älteren oder fehlenden Daten geantwortet, die Ergebnisse können unvollständig sein.`,
                nonInstallable: ({ count }: { count: number }) =>
                    `${count} Eintrag/Einträge wurden gefunden, können auf diesem Rechner aber gerade nicht installiert werden.`,
            },
            sourceFreshness: {
                stale: 'Älter als diese Quelle',
                'stale-offline': 'Letzter bekannter Stand, Quelle offline',
                unavailable: 'Quelle nicht verfügbar',
                'auth-unavailable': 'Für diese Quelle ist eine Anmeldung nötig',
                corrupt: 'Der Quellindex konnte nicht gelesen werden',
            },
            nonInstallableReason: {
                sourceStale: 'Die Marktplatzquelle ist nicht aktuell.',
                artifactUnavailable: 'Das Paket ist mit dem Registry-Zugang dieses Rechners nicht erreichbar.',
                notApproved: 'Aus dieser Quelle ist die Installation nicht freigegeben.',
                unsupportedSourceKind: 'Diese Quellenart unterstützt diese Happier-Version nicht.',
            },
            installSubtitle: ({ source }: { source: string }) =>
                `Prüfe alles, was dieses Plugin deklariert, bevor etwas aus ${source} vertraut wird.`,
            registrySelectionRequired: ({ origin }: { origin: string }) => `Benötigt ein Registry-Profil für ${origin}`,
            registrySelection: {
                title: ({ name }: { name: string }) => `Registry für ${name} wählen`,
                body: ({ name, origin, source }: { name: string; origin: string; source: string }) =>
                    `${name} wird über ${origin} veröffentlicht. Wähle das Registry-Profil, das ${source} auf diesem Rechner nutzt, oder füge eines hinzu und melde dich an. Heruntergeladen wird erst nach der Prüfung zum Installieren und Vertrauen.`,
                continue: 'Weiter',
            },
        },
    } } as const;

return { marketplacePresentation, localizedTechnicalReviewVocabulary, localizedReviewVocabulary, pluginMarketplaceDiscoverTranslations };
})();

const Domain_pluginPermissionTranslations = (() => {
type PermissionDetailsTranslation = Shared_pluginPermissionTranslations.PermissionDetailsTranslation;

const pluginPermissionTranslations = { de: {
        fields: {
            pluginId: 'Plugin-ID',
            capability: 'Fähigkeit',
            scope: 'Bereich',
            requester: 'Anfragende Stelle',
            authority: 'Autorität',
            requestedAt: 'Zeitpunkt der Anfrage',
            reason: 'Grund',
        },
        scope: { account: 'Konto', project: 'Projekt', workspace: 'Workspace' },
        requester: { user: 'Benutzer', host: 'Host', plugin: 'Plugin' },
        authority: { bundled: 'Mitgeliefert', machineInstallation: 'Rechner-Installation' },
        identifiers: {
            session: 'Session',
            request: 'Anfrage',
            machine: 'Rechner',
            installation: 'Installation',
        },
        accessibilitySummary: ({ details }) => `Details der Berechtigungsanfrage. ${details}`,
    } } as const satisfies Pick<Readonly<Record<string, PermissionDetailsTranslation>>, "de">;

return { pluginPermissionTranslations };
})();

const Domain_pluginSettingsPresentationTranslations = (() => {
const english = Shared_pluginSettingsPresentationTranslations.english;

const pluginSettingsPresentationTranslations = { de: {
        rowStatus: { enabled: 'Aktiviert', disabled: 'Deaktiviert', incompatible: 'Nicht kompatibel', trustRemoved: 'Vertrauen entzogen', needsAttention: 'Benötigt Aufmerksamkeit' },
        developmentPhase: { observing: 'Wird beobachtet', preparingDependencies: 'Abhängigkeiten werden vorbereitet', compiling: 'Wird kompiliert', validating: 'Wird geprüft', active: 'Aktiv', retainedIncumbent: 'Vorherige Version aktiv', unavailable: 'Nicht verfügbar' },
        rowSource: { bundled: 'In Happier enthalten', npm: 'npm-Paket', archive: 'Archivdatei', localPath: 'Lokaler Ordner', other: 'Konfigurierte Quelle' },
        rowAttention: { trustRemoved: 'Dieses Plugin läuft nicht mehr. Installiere es erneut, um seinem Code wieder zu vertrauen.', incompatible: 'Diese Version kann auf dem ausgewählten Rechner nicht laufen.' },
        developerGroupTitle: 'Entwicklung',
        developerGroupFooter: 'Plugins auf dem ausgewählten Rechner bauen und ansehen, was dessen Dienst meldet.',
        developerDevelopmentSubtitle: 'Plugins aus eigenen Ordnern erstellen, bearbeiten, testen und packen.',
        developerDiagnosticsSubtitle: 'Dienst- und Katalogdiagnosen für den ausgewählten Rechner.',
        detailMissingTitle: 'Dieses Plugin ist auf dem ausgewählten Rechner nicht vorhanden',
        detailMissingBody: ({ pluginId }: { pluginId: string }) => `${pluginId} ist hier nicht installiert. Es wurde möglicherweise deinstalliert oder liegt auf einem anderen Rechner.`,
        detailMissingRetry: 'Erneut prüfen',
        surfaces: {
            purpose: 'Füge Happier Oberflächen, Befehle und Integrationen hinzu. Plugins laufen als vertrauenswürdiger Code auf deinen Rechnern.',
            navigationTitle: 'Plugins',
            updatesTitle: 'Updates',
            moreDescriptionInSettings: 'Woher Plugins kommen, eigene Plugins bauen und was dieser Rechner meldet. Diese Seiten öffnen sich in den Einstellungen.',
            fix: 'Beheben',
            allSources: 'Alle Quellen',
            shelfCurated: 'Kuratiert',
            shelfCuratedDescription: 'Von Happier geprüft und empfohlen. Jede Installation zeigt trotzdem die vollständige Prüfung.',
            shelfCommunity: 'Community',
            shelfCommunityDescription: 'Ungeprüfte npm-Pakete. Installieren & vertrauen zeigt genau, worauf jedes zugreifen kann.',
            shelfUser: 'Deine Quellen',
            shelfUserDescription: 'Einträge aus Marktplatzquellen, die auf diesem Rechner hinzugefügt wurden.',
            manage: 'Verwalten',
            installed: 'Installiert',
            notShownTitle: 'Nicht alles konnte angezeigt werden',
            listingInstallsOn: ({ machine }: { machine: string }) => `Wird auf ${machine} installiert. Du prüfst den Zugriff, bevor etwas läuft.`,
            listingChooseMachine: 'Wähle oben einen Rechner, um dieses Plugin zu installieren.',
            listingRunsIn: 'Läuft in',
            listingPlatforms: 'Plattformen',
            listingSource: 'Quelle',
            listingCategories: 'Kategorien',
            listingNotFoundTitle: 'Dieser Eintrag ist nicht verfügbar',
            listingNotFoundBody: 'Er wurde möglicherweise aus seiner Quelle entfernt, oder dieser Rechner erreicht die Quelle gerade nicht.',
            developmentSourcesTitle: 'Plugins in Entwicklung',
            chooseMachineInstalled: 'Wähle oben einen Rechner, um seine Plugins zu sehen.',
            chooseMachineBrowse: 'Wähle oben einen Rechner, um Plugins zu durchsuchen, die er installieren kann.',
            noSavedDetails: 'Für diesen Rechner sind keine Plugin-Details gespeichert.',
            projectionFailedTitle: 'Die Plugin-Registry dieses Rechners konnte nicht geladen werden',
            projectionFailedBody: 'Seine Plugin-Details konnten nicht geladen werden. Versuche es erneut, um Plugins zu verwalten.',
            machineOfflineTitle: 'Dieser Rechner ist offline',
            machineOfflineBody: 'Für Änderungen muss dieser Rechner online sein. Wähle oben einen anderen Rechner.',
            openAsPage: 'Als Seite öffnen',
            detailInstalledLabel: 'Installiertes Plugin',
            detailListingLabel: 'Plugin-Eintrag',
            viewLabel: 'Anzeigen als',
            viewGrid: 'Raster',
            viewList: 'Liste',
            installedSearchPlaceholder: 'Installierte Plugins durchsuchen',
            statusFilterLabel: 'Plugins anzeigen',
            statusAll: 'Alle Plugins',
            statusEnabled: 'Aktiviert',
            statusDisabled: 'Deaktiviert',
            statusAttention: 'Benötigt Aufmerksamkeit',
            noMatch: ({ query }: { query: string }) => `Keine Plugins passen zu „${query}“`,
            clearSearch: 'Leeren',
            emptyTitle: 'Noch keine Plugins installiert',
            emptyBody: 'Plugins fügen Bereiche, Befehle und Werkzeuge für deine Agenten hinzu. Beginne mit denen von Happier.',
            browsePlugins: 'Plugins durchsuchen',
            browseEmpty: 'Deine Quellen bieten noch keine Plugins an.',
            forDevelopers: 'Für Entwickler',
            readFailedTitle: 'Die Plugins dieses Rechners konnten nicht gelesen werden',
            readFailedBody: 'Es wurde nichts geändert. Versuche es erneut, um den Rechner noch einmal zu fragen.',
            lastKnown: ({ status }: { status: string }) => `Zuletzt bekannt · ${status}`,
            machinesTitle: 'Rechner',
            machinesDescription: 'Wo dieses Plugin installiert ist.',
            machinesCurrent: ({ current, total }: { current: number; total: number }) => `Aktuell auf ${current} von ${total} Rechnern`,
            onMachines: ({ count }: { count: number }) => `Auf ${count} Rechnern`,
            onMachine: ({ machine }: { machine: string }) => `Auf ${machine}`,
            addedGroup: 'Hinzugefügt',
            machinesRetained: 'Ein Rechner, der nicht mehr zu diesem Konto gehört',
            open: 'Öffnen',
            review: 'Prüfen',
            seeAll: 'Alle anzeigen',
            allResults: 'Alle Ergebnisse',
            categoriesLabel: 'Kategorien',
            runOnNoneChosen: 'Kein Rechner gewählt',
            runOnNoneAvailable: 'Noch kann kein Rechner es ausführen',
            runsEverywhere: 'Auf jedem Rechner mit Happier',
            kinds: {
                agent: 'Agent',
                providers: 'Modellanbieter',
                scmHostingProviders: 'Code-Hosting',
                scmBackends: 'Versionsverwaltung',
                voice: 'Sprache',
                connectedAccounts: 'Verbundener Dienst',
                inputTypes: 'Eingabetypen',
                mcp: 'MCP-Werkzeuge',
                pluginUi: 'App-Bereiche',
                pluginBrowser: 'Browser-Ansichten',
                composer: 'Composer-Werkzeuge',
            },
        },
    } } as const;

return { pluginSettingsPresentationTranslations };
})();

const Domain_pluginUpdateReviewTranslations = (() => {
const en = Shared_pluginUpdateReviewTranslations.en;

const de = {
    title: 'Update-Prüfung',
    confirmSubtitle: 'Updates, die den gewährten Zugriff erweitern, fragen zuerst nach.',
    autoApplySubtitle: 'Updates werden ohne Nachfrage angewendet, auch wenn sich ihr Zugriff erweitert.',
    confirmOption: 'Erst fragen',
    autoApplyOption: 'Automatisch',
};

const pluginUpdateReviewTranslations = { de: de };

return { pluginUpdateReviewTranslations };
})();

const Domain_pluginWebhookAdministrationTranslations = (() => {
const english = Shared_pluginWebhookAdministrationTranslations.english;

const pluginWebhookAdministrationTranslations = { de: {
    webhookAdministration: {
        title: 'Plugin-Webhooks',
        footer: 'Konto-Endpunkte, genaue Rechnerziele, Zustell-Warteschlangen und Wiederherstellung aus dem Dead-Letter-Bereich. Zustellinhalte werden hier nie gezeigt.',
        unavailableTitle: 'Plugin-Webhooks sind nicht verfügbar',
        unavailableSubtitle: 'Auf diesem Server ist der Plugin-Webhook-Eingang nicht aktiviert.',
        endpointsTitle: 'Webhook-Endpunkte',
        emptyTitle: 'Keine Plugin-Webhook-Endpunkte',
        emptySubtitle: 'Endpunkte, die installierte Plugins anlegen, bleiben hier sichtbar – auch solche, deren Ziel nicht verfügbar ist.',
        loadError: 'Der Webhook-Status ließ sich nicht laden.',
        endpointSubtitle: ({ readiness, routing, sourceInstanceId }: { readiness: string; routing: string; sourceInstanceId: string }) => `${readiness} · ${routing} · ${sourceInstanceId}`,
        targetSubtitle: ({ machineId, materializationId, status }: { machineId: string; materializationId: string; status: string }) => `${machineId} / ${materializationId} · ${status}`,
        queueSubtitle: ({ queued, retrying, claimed, deadLetter }: { queued: number; retrying: number; claimed: number; deadLetter: number }) => `In Warteschlange: ${queued} · wird wiederholt ${retrying} · übernommen ${claimed} · Dead Letter ${deadLetter}`,
        copyUrl: 'Webhook-URL kopieren',
        selectTarget: 'Zustellziel wählen',
        retarget: 'Endpunkt umleiten',
        retargetUnavailable: 'Wähl eine verfügbare exakte Plugin-Materialisierung, bevor du diesen Endpunkt umleitest.',
        originSelected: 'Die gewählte exakte Plugin-Materialisierung wird beim Weitermachen erneut geprüft.',
        originUnavailable: 'Es ist keine exakte verfügbare Plugin-Materialisierung gewählt.',
        movePendingTitle: 'Offene Zustellungen verschieben?',
        movePendingBody: 'Eingereihte und Dead-Letter-Zustellungen zum neuen exakten Ziel verschieben? Bereits übernommene Zustellungen bleiben bei ihrem aktuellen Ziel.',
        resumePendingMove: 'Verschieben offener Zustellungen fortsetzen',
        resumePendingMoveSubtitle: ({ count }: { count: number }) => `${count} eingereihte oder Dead-Letter-Zustellungen nutzen weiterhin das bisherige exakte Ziel.`,
        configureCredential: 'Signatur-Zugangsdaten einrichten',
        rotateCredential: 'Signatur-Zugangsdaten erneuern',
        finishRotation: 'Erneuerung der Zugangsdaten abschließen',
        finishRotationSubtitle: 'Die vorherigen Zugangsdaten ab jetzt nicht mehr annehmen.',
        credentialSecretTitle: 'Das neue Signatur-Secret speichern',
        credentialSecretBody: ({ secret }: { secret: string }) => `Dieses Secret wird nur einmal angezeigt. Speicher es, bevor du diese Meldung schließt.\n\n${secret}`,
        revoke: 'Endpunkt widerrufen',
        revokeTitle: 'Webhook-Endpunkt widerrufen?',
        revokeBody: 'Neue Zustellungen an diesen Endpunkt werden abgelehnt. Bestehende Zustell-Metadaten bleiben gemäß der Aufbewahrungsregel verfügbar.',
        operationFailed: 'Die Webhook-Operation wurde nicht abgeschlossen. Aktualisiere den aktuellen Status, bevor du es erneut versuchst.',
        deliveryTitle: ({ digest }: { digest: string }) => `Dead Letter ${digest}`,
        deliveryStatus: 'Zustellstatus',
        deliverySubtitle: ({ errorCode, attempts, replays, machineId, materializationId }: { errorCode: string; attempts: number; replays: number; machineId: string; materializationId: string }) => `${errorCode} · ${attempts} Versuche · ${replays} Wiederholungen · ${machineId} / ${materializationId}`,
        unresolvedAutomationAdmissionTitle: ({ totalCount }: { totalCount: number }) => `${totalCount} ungeklärte Automations-Zulassungen`,
        unresolvedAutomationAdmissionSubtitle: ({ sample, omittedCount }: { sample: string; omittedCount: number }) => `Beispiel: ${sample} · ${omittedCount} nicht gezeigt`,
        replay: 'Zustellung wiederholen',
        discardTitle: 'Zustellung verwerfen?',
        discardBody: 'Der verschlüsselt oder im Klartext gespeicherte Zustellinhalt wird entfernt und lässt sich nicht wiederherstellen.',
    },
} } as const;

return { pluginWebhookAdministrationTranslations };
})();

const Domain_profilesPageTranslations = (() => {
const english = Shared_profilesPageTranslations.english;

const translated = Shared_profilesPageTranslations.translated;

const profilesPageTranslations = { de: translated({
        profilesPage: {
            searchPlaceholder: "Startprofile suchen",
            emptyTitle: "Noch keine Startprofile",
            newProfileTitle: "Neues Startprofil",
            notFoundTitle: 'Dieses Profil gibt es nicht mehr',
            notFoundDescription: 'Es wurde vielleicht auf einem anderen Gerät gelöscht.',
            backToProfiles: "Zurück zu Startprofilen",
            discardDraft: 'Verwerfen',
            detailDescription: 'Wird verwendet, wenn eine neue Sitzung mit diesem Profil startet.',
            builtInDetailDescription: 'Ein vorgefertigtes Profil. Wenn du Änderungen speicherst, entsteht deine eigene Kopie.',
            enabledHint: 'Wird angeboten, wenn du ein Profil für eine neue Sitzung wählst.',
            pickerSection: 'Profilauswahl',
            pickerSectionDescription: 'Wo diese Wahl erscheint, wenn du eine Sitzung startest.',
            showFirst: 'Zuerst anzeigen',
            showFirstDescription: 'Zeigt die Umgebung der Maschine bei deinen Favoriten.',
            environmentDescription: 'Umgebungsvariablen, die gesetzt werden, wenn eine Sitzung mit diesem Profil startet. Werte können auf Variablen der Maschine verweisen.',
            descriptionTitle: 'Beschreibung',
            descriptionHint: 'Optional. Wird angezeigt, wenn du dieses Profil wählst.',
            modelRequiresAgent: 'Wähle zuerst einen bevorzugten Agenten, um sein Modell auszuwählen.',
        },
    }) };

return { profilesPageTranslations };
})();

const Domain_providerCollectionTranslations = (() => {
type ProviderCollectionCopy = Shared_providerCollectionTranslations.ProviderCollectionCopy;

const en = Shared_providerCollectionTranslations.en;

const de: ProviderCollectionCopy = {
    settingsProvidersCollection: {
        gateway: {
            railGroup: 'Gateways',
            managedFromConnectedServices: 'Wird unter Verbundene Dienste verwaltet',
            description: 'Lässt jeden Agenten deine Abos nutzen.',
            statusUnavailable: ({ machine }: { machine: string }) => `Nicht verfügbar · ${machine} ist offline`,
            offlineTitle: ({ machine }: { machine: string }) => `${machine} ist offline`,
            offlineDescription: ({ gateway, machine }: { gateway: string; machine: string }) => `Sitzungen können ${gateway} nicht nutzen, bis ${machine} wieder online ist oder du unten einen anderen Computer wählst. Es wird nichts anderes stattdessen versucht.`,
            modelsFromTitle: 'Modelle von',
            modelsFromDescription: 'Die Abos, auf die dieses Gateway zugreift. Wähle für jedes ein Konto oder einen Pool; sie werden nie gemischt.',
            slotUnused: ({ service }: { service: string }) => `${service}-Modelle werden über dieses Gateway nicht angeboten.`,
            slotConnect: ({ service }: { service: string }) => `Verbinde ein ${service}-Konto, um es hier zu nutzen.`,
            connect: 'Verbinden',
            runsOnTitle: 'Läuft auf',
            runsOnDescription: 'Wo das Gateway startet, wenn eine Sitzung es braucht. Anfragen gehen weiterhin an die Abos oben.',
            runsOnSession: 'Computer der jeweiligen Sitzung',
            runsOnChosen: 'Ein gewählter Computer',
            runsOnSessionDescription: 'Ein Gateway pro Computer, geteilt von allen Sitzungen dort.',
            runsOnChosenDescription: 'Ein Gateway auf dem Computer, den du wählst. Sitzungen auf deinen anderen Computern erreichen es über Happier.',
            computerTitle: 'Computer',
            computerChoose: 'Computer wählen',
            computerChooseDescription: 'Wähle, wo das Gateway läuft.',
            computerOnline: 'Online · von deinen anderen Computern noch nicht geprüft',
            computerOnlineReachable: 'Online · deine anderen Computer erreichen es',
            computerOnlineUnreachable: 'Online · deine anderen Computer erreichen es nicht',
            computerOffline: 'Offline',
            computerGone: 'Gehört nicht mehr zu deinen Computern',
            modelPickerTitle: 'Modellauswahl',
            showInPickerGateway: 'Für Gateways standardmäßig aus, damit dieselben Modelle nicht doppelt erscheinen. Sie bleiben über „Läuft über“ verfügbar.',
            modelsAvailable: ({ count }: { count: number }) => `${count} verfügbar`,
            helperTitle: 'Hilfsmodelle von Claude Code',
            helperDescription: 'Claude Code gibt Nebenaufgaben an ein schnelles, ein Standard- und ein stärkstes Modell ab. Wähle, welches Modell auf diesem Gateway jeweils verwendet wird. Agent-Definitionen mit festem Modell behalten es.',
            helperFast: 'Schnell',
            helperDefault: 'Standard',
            helperStrongest: 'Stärkstes',
            helperSameAsSession: 'Wie die Sitzung',
            detailsTitle: 'Details',
            whatToKnow: 'Gut zu wissen',
            whatToKnowTitle: 'Deine Abos, außerhalb ihrer eigenen Apps',
            whatToKnowDescription: 'Die Dienste hinter diesen Abos unterstützen diese Nutzung nicht. Anfragen können abgelehnt werden und die Bedingungen können sich ändern. Happier sendet eine Anfrage immer nur an das oben gewählte Konto oder den gewählten Pool.',
            useExternalEndpoint: 'Stattdessen einen externen Endpunkt nutzen',
            poolSectionTitle: 'In anderen Agenten nutzen',
            poolSectionDescription: ({ agents }: { agents: string }) => `${agents} meldet sich direkt bei diesem Pool an. Andere Agenten erreichen dieselben Konten über ein Gateway.`,
            poolSectionDescriptionGeneric: 'Agenten, die sich bei diesem Dienst anmelden, nutzen diesen Pool direkt. Andere Agenten erreichen dieselben Konten über ein Gateway.',
            poolSwitchVia: ({ gateway }: { gateway: string }) => `über ${gateway}`,
            poolSwitchDescription: ({ service }: { service: string }) => `Andere Agenten können ${service}-Modelle aus diesem Pool ausführen.`,
            poolSwitchHeldBy: ({ gateway, current, service }: { gateway: string; current: string; service: string }) => `${gateway} nutzt derzeit ${current} für ${service}-Modelle.`,
            poolSwitchNeedsComputer: 'Dafür muss einer deiner Computer online sein.',
            poolReplaceTitle: ({ gateway, pool }: { gateway: string; pool: string }) => `${gateway} auf ${pool} umstellen?`,
            poolReplaceDescription: ({ pool, service, current }: { pool: string; service: string; current: string }) => `Neue Sitzungen in anderen Agenten nutzen ${pool} für ${service}-Modelle. ${current} behält seine Konten und laufende Sitzungen behalten, womit sie gestartet sind.`,
            poolReplaceConfirm: 'Umstellen',
            compareNative: ({ agents }: { agents: string }) => `In ${agents}`,
            compareNativeGeneric: 'Mit eigener Anmeldung',
            compareOther: 'In anderen Agenten',
            compareRunsThrough: 'Läuft über',
            compareOwnSignIn: ({ service }: { service: string }) => `Eigene Anmeldung von ${service}`,
            compareSupported: ({ service }: { service: string }) => `Von ${service} unterstützt`,
            compareSupportedYes: 'Ja',
            compareSupportedNo: 'Nein. Experimentell; Anfragen können abgelehnt werden',
            compareLimits: 'Limits',
            compareLimitsNative: 'Die Limits dieses Pools',
            compareLimitsShared: 'Dieselben Limits, geteilt',
        },
        connectionDescription: 'In deinem Konto gespeichert. Funktioniert auf jedem Computer.',
        apiKeySavedDescription: 'Als gespeichertes Geheimnis abgelegt. Wird nie wieder angezeigt.',
        modelsShownCount: ({ count }: { count: number }) => `${count} sichtbar`,
        showInPickerTitle: 'In der Modellauswahl zeigen',
        showInPickerDirect: ({ provider }: { provider: string }) => `Für direkte Anbieter standardmäßig an. Die Modelle von ${provider} erscheinen in jedem Agenten, der sie ausführen kann.`,
        showInPickerManyModels: 'Für Anbieter mit vielen Modellen standardmäßig aus. Sie bleiben über „Läuft über“ verfügbar.',
        showInPickerLocal: 'Für Modelle, die auf deinen Computern laufen, standardmäßig an.',
        showInPickerAction: 'In der Auswahl zeigen',
        onThisComputerTitle: 'Auf diesem Computer',
        onThisComputerNoComputer: 'Kein Computer ausgewählt. Wähle einen, um diese Verbindung zu testen oder zu ändern, wie sie erreicht wird.',
        endpointAccessTitle: 'Endpunktzugriff',
        endpointAccessDirect: ({ machine, host }: { machine: string; host: string }) => `${machine} erreicht ${host} direkt.`,
        endpointAccessDirectValue: 'Direkt',
        localRuntimeTitle: 'Lokale Laufzeit',
        onMachine: ({ machine }: { machine: string }) => `Auf ${machine}`,
        onAComputerTitle: 'Auf einem Computer',
        localNoComputer: 'Wähle einen Computer, um die Modellserver darauf zu sehen.',
        localOfflineDetail: 'Seine Modellserver können nicht geprüft werden.',
        localNoneFound: 'Hier wurden keine Modellserver gefunden.',
        invitationAccountDescription: 'Verbinde einen Anbieter einmal, und seine Modelle erscheinen in jedem Agenten, der sie ausführen kann. Zum Start ist kein Computer nötig.',
        subscriptionsPointerLead: 'Abos wie Claude und ChatGPT findest du unter ',
        subscriptionsPointerLink: 'Verbundene Dienste',
        subscriptionsPointerTail: '.',
        addTitle: ({ provider }: { provider: string }) => `${provider} hinzufügen`,
        addDescription: ({ provider }: { provider: string }) => `Füge einen Schlüssel hinzu, und die Modelle von ${provider} erscheinen in jedem Agenten, der sie ausführen kann.`,
        addKeyDescription: 'Wird als gespeichertes Geheimnis in deinem Konto abgelegt.',
        connectedTitle: ({ provider }: { provider: string }) => `${provider} ist verbunden`,
        connectedHiddenCountDescription: ({ provider, count }: { provider: string; count: number }) => `${count} Modelle sind bereit. Sie sind in der Auswahl standardmäßig ausgeblendet, weil ${provider} viele Modelle anbietet, die du vielleicht schon hast. Wähle jederzeit eines über „Läuft über“ oder zeige alle.`,
        connectedHiddenDescription: ({ provider }: { provider: string }) => `Seine Modelle sind in der Auswahl standardmäßig ausgeblendet, weil ${provider} viele Modelle anbietet, die du vielleicht schon hast. Wähle jederzeit eines über „Läuft über“ oder zeige alle.`,
        description: 'Verbinde eine Modellquelle einmal und nutze ihre Modelle mit jedem kompatiblen Agenten.',
        foundOn: ({ machine }: { machine: string }) => `Gefunden auf ${machine}`,
        foundOnThisMachine: 'Auf diesem Gerät gefunden',
        connect: 'Verbinden',
        start: 'Starten',
        test: 'Testen',
        addProvider: 'Anbieter hinzufügen',
        customEndpoint: 'Eigener Endpunkt',
        menuOwnCategory: 'Eigene',
        menuCatalogCategory: 'Aus dem Katalog',
        newTitle: 'Neuer Anbieter',
        emptyDescription: 'Füge einen Anbieter aus dem Katalog oder deinen eigenen kompatiblen Endpunkt hinzu.',
        machineScopeLabel: 'Eingerichtet auf',
        invitationTitle: 'Bring deine eigenen Modelle mit',
        invitationDescription: 'Verbinde einen Anbieter einmal, und seine Modelle erscheinen in der Modellauswahl jedes kompatiblen Agenten. Lokale Server wie Ollama laufen auf deinem Gerät.',
        invitationNeedsMachine: 'Anbieter werden auf einem deiner Geräte verbunden und geprüft. Füge ein Gerät hinzu, um loszulegen.',
        setUpMachine: 'Gerät einrichten',
        duplicateAsCustom: 'Als eigenen Anbieter kopieren',
        discard: 'Verwerfen',
        enabled: 'Aktiviert',
        enabledDescription: 'Seine Modelle in der Modellauswahl der Agenten anbieten',
        saved: 'Gespeichert',
        replace: 'Ersetzen',
        addKey: 'Schlüssel wählen',
        apiKeyDefaultDescription: 'Wird auf jedem Gerät verwendet, sofern es keinen eigenen Schlüssel hat.',
        apiKeyMachineDescription: 'Wird auf diesem Gerät statt des Standardschlüssels verwendet.',
        availabilityTitle: 'Verfügbarkeit',
        availabilityDescription: 'Wo Agenten diesen Anbieter nutzen können.',
        modelsDescription: 'Wähle, welche Modelle Agenten in ihrer Modellauswahl anbieten.',
        modelsShown: ({ shown, total }: { shown: number; total: number }) => `${shown} von ${total} in der Modellauswahl sichtbar`,
        modelsFilter: ({ count }: { count: number }) => `${count} Modelle filtern`,
        connectionTitle: 'Verbindung',
        nameDescription: 'Erscheint in der Anbieterliste und in der Modellauswahl.',
        nameRequired: 'Gib einen Namen ein.',
        nameTooLong: ({ max }: { max: number }) => `Verwende höchstens ${max} Zeichen.`,
        managedTitle: 'Verwalteter lokaler Dienst',
        endpointsTitle: 'Endpunkte',
        endpointsDescription: 'Leer lassen, um die Adressen des Anbieters zu verwenden.',
        overridesDescription: 'Wohin Anfragen gehen. Ändere die Adresse für alle Geräte oder nur für dieses.',
        afterSavingTitle: 'Nach dem Speichern',
        destinationDescription: 'Wohin Happier die Anfragen dieses Anbieters sendet.',
        destinationPending: 'Erscheint, sobald alle Endpunkte ausgefüllt sind.',
    },
};

const providerCollectionTranslations = { de } as const;

return { providerCollectionTranslations };
})();

const Domain_reviewWalkthroughTranslations = (() => {
type Count = Shared_reviewWalkthroughTranslations.Count;

type ReviewWalkthroughTranslations = Shared_reviewWalkthroughTranslations.ReviewWalkthroughTranslations;

const en = Shared_reviewWalkthroughTranslations.en;

const de: ReviewWalkthroughTranslations = {
    severityCount: ({ count, severity }) => `${count} ${severity}`,
    findingRefA11y: ({ label, title }) => `${label}: ${title}. Zum Befund`,
    tag: { noFile: 'Keine Datei', outdated: 'Veraltet', unplaced: 'Nicht zuordenbar', notInStory: 'In keinem Abschnitt' },
    outdatedSummary: 'Der Code hat sich nach dem Review geändert.',
    askAboutFindingA11y: ({ title }) => `Zum Befund fragen: ${title}`,
    tailTitle: 'Befunde ohne Abschnitt',
    tailDescription: 'Bleiben hier, damit nichts verschwindet, wenn sich ihre Zeilen nicht zuordnen lassen.',
    inContext: 'im Kontext',
    fromReviewAt: ({ time }) => `aus dem Review um ${time}`,
    reviewLabel: 'Review:',
    enginesOf: ({ count, total }) => `${count} von ${total}`,
    enginesFinished: 'Engines fertig',
    enginesRunning: ({ count }) => (count === 1 ? '1 Engine prüft noch' : `${count} Engines prüfen noch`),
    fromEngines: ({ engines, inStory }) => `von ${engines} · ${inStory} im Rundgang`,
    and: ' und ',
    inStoryElsewhere: ({ inStory, elsewhere }) => `${inStory} im Rundgang, ${elsewhere} anderswo`,
    allInStory: 'alle im Rundgang',
    seeded: {
        title: 'Nach dem Review von einem neuen Lauf geschrieben.',
        body: ({ reviewers, time }) => `Der Erzähler hat den Code nicht geprüft; jeder hier zitierte Befund stammt von ${reviewers} um ${time}.`,
        changed: ({ count }) => (count === 1 ? 'Seitdem hat sich 1 Datei geändert.' : `Seitdem haben sich ${count} Dateien geändert.`),
    },
    findingsFrom: ({ count, engine }) => (count === 1 ? `1 Befund von ${engine}` : `${count} Befunde von ${engine}`),
    publishedBefore: ({ time }) => `veröffentlicht um ${time}, vor dem Rundgang`,
    steps: {
        reviewing: 'Prüft',
        engineProgress: ({ done, running }) => `${done} fertig · ${running} prüft`,
        reviewed: ({ count }) => (count === 1 ? 'Geprüft · 1 Befund' : `Geprüft · ${count} Befunde`),
        reviewedShort: ({ count }) => `Geprüft · ${count}`,
        engineReviewed: ({ engine, count }) => (count === 1 ? `${engine} · 1 Befund` : `${engine} · ${count} Befunde`),
        reviewedAt: ({ time }) => `Geprüft ${time}`,
        reviewAt: ({ time }) => `Review ${time}`,
        partial: ({ count }) => (count === 1 ? 'Teilreview · 1 Befund' : `Teilreview · ${count} Befunde`),
        ready: 'Rundgang fertig',
        readyShort: 'Rundgang',
        failed: 'Rundgang fehlgeschlagen',
        narrating: 'Erzählt',
        narratorWriting: ({ narrator }) => `${narrator} schreibt`,
        writing: 'Schreibt den Rundgang',
        writingShort: 'Schreibt',
    },
    writingWithFindings: 'Schreibt den Rundgang mit den Befunden…',
    dialog: {
        engines: 'Review-Engines',
        selected: ({ count }) => `${count} ausgewählt`,
        loadingEngines: 'Review-Engines werden gesucht…',
        noEngines: 'Auf dem Rechner dieser Sitzung kann keine Review-Engine laufen.',
        findingsOnly: 'nur Befunde',
        changes: 'Änderungen',
        instructions: 'Anweisungen',
        instructionsPlaceholder: 'Worauf soll das Review achten?',
        defaultInstructions: 'Prüfe diese Änderungen auf Korrektheit, Risiken und fehlende Tests.',
        alsoWalkthrough: 'Auch einen Rundgang schreiben',
        alsoWalkthroughBody: 'Sobald die Befunde da sind, schreibt derselbe Lauf den Rundgang mit ihnen im Kontext. Nichts liest die Änderungen zweimal.',
        narrator: 'Erzähler',
        chooseNarrator: 'Erzähler wählen',
        narratorSeveral: ({ count }) => `${count} Engines prüfen; ein Modell schreibt den Rundgang aus all ihren Befunden.`,
        narratorFindingsOnly: ({ engine }) => `${engine} liefert Befunde, keinen Text. Ein Modell schreibt den Rundgang daraus.`,
        noNarrator: 'Keine dieser Engines kann einen Rundgang schreiben. Füge eine Modell-Engine hinzu oder schalte den Rundgang aus.',
        footerReviewThenWalkthrough: 'Erst prüfen, dann den Rundgang schreiben',
        footerHandover: ({ reviewer, narrator }) => `${reviewer} prüft · ${narrator} schreibt`,
    },
    generated: {
        continues: ({ model }) => `${model} · setzt das Review fort`,
        seeded: ({ model }) => `${model} · aus den Befunden des Reviews`,
        handover: ({ narrator, engine }) => `${narrator}, aus den Befunden von ${engine}`,
    },
    partial: {
        failed: ({ engines }) => `Das Review von ${engines} wurde nicht abgeschlossen.`,
        notClean: 'Das ist ein Teilreview, kein sauberes.',
        finishedWith: ({ engines, count }) => (count === 1 ? `${engines} ist mit 1 Befund fertig.` : `${engines} ist mit ${count} Befunden fertig.`),
        retry: ({ engine }) => `${engine} erneut versuchen`,
    },
    explain: { action: 'Befunde erklären', running: 'Befunde werden erklärt', a11y: 'Eine Erklärung der Befunde im Rundgang anfordern', unknownModel: 'Unbekanntes Modell', requester: { user: 'einem Nutzer', agent: 'einem Agenten', plugin: 'einem Plugin', automation: 'einer Automatisierung', workflow: 'einem Workflow', unknown: 'einem unbekannten Anfragenden' }, header: ({ model, time, requester = 'dir' }) => `Erklärung des Reviews · ${model} · von ${requester} um ${time} angefragt · kein Urteil` },
    finished: {
        title: 'Review abgeschlossen',
        openFindings: 'Befunde öffnen',
        walkMeThrough: 'Führ mich hindurch',
        andMore: ({ count }) => `und ${count} weitere`,
        continues: 'Setzt diesen Review-Lauf fort: Der Prüfer schreibt ihn aus dem, was er schon gelesen hat. Nichts wird erneut analysiert.',
        narrates: ({ count }) => (count === 1
            ? 'Der Review-Lauf ist beendet. Ein neuer Lauf schreibt den Rundgang aus diesem Befund und den Änderungen; er prüft nicht erneut.'
            : `Der Review-Lauf ist beendet. Ein neuer Lauf schreibt den Rundgang aus diesen ${count} Befunden und den Änderungen; er prüft nicht erneut.`),
    },
    started: {
        transcript: ({ engineCount, fileCount }) => `Review gestartet · ${engineCount} ${engineCount === 1 ? 'Engine' : 'Engines'} · ${fileCount} ${fileCount === 1 ? 'Datei' : 'Dateien'}`,
        notStarted: ({ engines }) => `${engines} ist nicht gestartet. Die anderen prüfen.`,
        narrationFailed: 'Das Review läuft, aber der Rundgang konnte nicht angefordert werden. Die Befunde kommen trotzdem.',
    },
};

const reviewWalkthroughTranslations = { de: { reviewWalkthrough: de } };

return { reviewWalkthroughTranslations };
})();

const Domain_rolesTranslations = (() => {
type RolesTranslations = Shared_rolesTranslations.RolesTranslations;

const rolesTranslations = { de: {
        rail: {
            chooseEngine: 'KI-Engine wählen',
            unavailableRole: 'Nicht mehr verfügbar',
            label: 'Rollen',
            title: 'Rolle',
            searchPlaceholder: 'Rollen suchen…',
            empty: 'Noch keine Rollen.',
            emptyWithManage: 'Noch keine Rollen. Füge unter Rollen verwalten eine hinzu.',
            footer: 'Eine Rolle bringt eigene Anweisungen, Engine und Ausführungsart mit, damit Workflows portabel bleiben.',
            manage: 'Rollen verwalten',
            engineAppliesOnStart: 'Die Engine gilt beim Starten dieser Rolle',
            defaultEngine: 'Standard-Agent',
            activeAccessibilityLabel: 'Rollen, eine Rolle ist aktiv',
        },
        builtIn: {
            orchestrator: "Leitet eine Aufgabe und gibt Teile an andere Agents ab",
            planner: "Erarbeitet den Plan, bevor gebaut wird",
            builder: "Setzt die Änderung um und prüft, dass sie funktioniert",
            reviewer: "Prüft eine Änderung und zeigt, was zu beheben ist",
            judge: "Entscheidet strittige Befunde und sagt, wann ein Ziel erreicht ist",
            second_opinion: "Eine unabhängige Prüfung, bevor es weitergeht",
            scout: "Durchsucht den Code und antwortet, wo etwas liegt",
            approval_reviewer: "Beantwortet risikoarme Berechtigungsanfragen und fragt dich beim Rest",
        },
        settings: {
            duplicate: 'Duplizieren',
            duplicateName: ({ name }) => `${name} (Kopie)`,
            platformDefault: 'Plattformstandard · folgt Updates',
            runsAsThisSession: 'Diese Sitzung',
            runsAsOrchestratorDescription: 'Ein Orchestrator ist die Sitzung, in der du ihn einschaltest.',
            readOnly: 'Schreibgeschützt',
            engineChooseMigrated: 'Aus 0.2 kam keine KI-Engine mit. Wähle eine, sonst folgt die Rolle deinem Standard-Agent.',
            description: 'Wer welche Arbeit erledigt. Workflows und Orchestratoren fragen nach einer Rolle; die Rolle sagt, wie sie läuft.',
            count: ({ count }) => (count === 1 ? '1 Rolle' : `${count} Rollen`),
            newRole: 'Neue Rolle',
            groupBuiltIn: 'Integriert',
            groupYours: 'Deine',
            groupShared: 'Mit dir geteilt',
            groupPlugins: 'Aus Plugins',
            edited: 'Bearbeitet',
            sourceBuiltIn: 'Integriert',
            sourceYours: 'Deine',
            sourceShared: 'Mit dir geteilt',
            sourcePlugin: ({ plugin }) => `Von ${plugin}`,
            migrated: 'aus 0.2-Sub-Agents',
            migratedNote: ({ names }) => (names.length === 1 ? `${names[0]} stammt aus deinen 0.2-Sub-Agent-Hinweisen: Die Beschreibung ist jetzt die Anweisung, Agent und Modell sind die Engine.` : `${names.join(', ')} stammen aus deinen 0.2-Sub-Agent-Hinweisen: Jede Beschreibung ist jetzt die Anweisung, Agent und Modell sind die Engine.`),
            nameTitle: 'Bezeichnung',
            newRoleName: 'Unbenannte Rolle',
            instructionsTitle: 'Anweisungen',
            instructionsDescription: 'Was sie tut, wann man sie nutzt und wie sie berichtet. Agenten lesen das, wenn sie Arbeit verteilen.',
            resetToDefault: 'Auf Standard zurücksetzen',
            readOnlyNote: 'Die ursprüngliche Rolle ist schreibgeschützt. Passe hier deine Anweisungen an; Zurücksetzen stellt das Original wieder her.',
            howItRunsTitle: 'Wie sie läuft',
            engineTitle: 'KI-Engine',
            engineDescription: 'Agent, Modell und Aufwand.',
            engineFollowsDefault: 'Folgt deinem Standard-Agenten.',
            engineUnavailable: 'Hier nicht verfügbar. Wähle eine Engine.',
            runsAsTitle: 'Läuft in',
            runsAsSession: 'Sitzung',
            runsAsBackgroundRun: 'Hintergrundlauf',
            runsAsSessionDescription: 'Eine Sitzung, die du öffnen und steuern kannst.',
            runsAsBackgroundDescription: 'Läuft im Hintergrund und meldet sich zurück; es gibt keine Sitzung zum Steuern.',
            handsOffTitle: 'Nur delegieren',
            handsOffDescription: 'Plant und delegiert; bearbeitet selbst keine Dateien.',
            secondOpinionTitle: 'Zweitmeinung',
            secondOpinionDescription: 'Empfohlen bittet sie, vor einem Pull Request oder vor dem Abschluss eine Zweitmeinung zu erwägen.',
            secondOpinionOff: 'Aus',
            secondOpinionEncouraged: 'Empfohlen',
            enabledTitle: 'Verfügbar',
            enabledDescription: 'Wird in der Rollenleiste und Orchestratoren angeboten.',
            advancedTitle: 'Erweitert',
            launchProfileTitle: 'Startprofil',
            launchProfileDescription: 'Umgebung, Berechtigungen, Maschine',
            launchProfileNone: 'Keins',
            profileUnavailable: 'Profil nicht verfügbar',
            previewTitle: 'Was Agenten lesen',
            previewDescription: 'Der Block, der mit jedem Zug gesendet wird, genau so.',
            deleteRole: 'Rolle löschen',
            deleteConfirmTitle: 'Diese Rolle löschen?',
            deleteConfirmBody: ({ name }) => `${name} wird für dich und alle, mit denen sie geteilt ist, entfernt. Sitzungen, die sie nutzen, behalten ihre Kopie.`,
            share: 'Teilen…',
            sendCopyFailed: 'Die Kopie konnte nicht gesendet werden.',
            saveFailed: 'Die Rolle konnte nicht gespeichert werden.',
            loadFailed: 'Deine Rollen konnten nicht geladen werden.',
            emptyDetailTitle: 'Wähle eine Rolle',
            emptyDetailBody: 'Wähle eine Rolle, um ihre Anweisungen und Ausführung zu sehen.',
        },
        delegation: {
            title: 'Delegierung',
            description: 'Wie Agenten Arbeit an andere Agenten übergeben.',
            depthTitle: 'Arbeitstiefe',
            approvalReviewer: 'Freigabeprüfer',
            approvalReviewerDescription: 'Risikoarme Anfragen automatisch einmalig freigeben. Sensible Aktionen brauchen weiterhin dich. Gilt in Standard und Änderungen akzeptieren.',
            approvedByReviewer: 'Einmalig vom Freigabeprüfer erlaubt',
            depthDescription: 'Sitzungen, Hintergrundläufe und Workflows, die Agenten starten, können weitere starten. Dieses Limit stoppt ausufernde Ketten. Was du selbst startest, ist nie begrenzt.',
            depthSetting: 'Wie weit Agenten Arbeit weitergeben dürfen',
            depthSettingDescription: ({ count }) => (count === 1
                ? 'Eine Ebene. Danach soll der Agent die Arbeit selbst erledigen.'
                : `${count} Ebenen. Danach soll der Agent die Arbeit selbst erledigen.`),
            ladderRoot: 'Arbeit, die du startest',
            ladderRootDetail: 'Von dir gestartet · nie begrenzt',
            ladderLevel: ({ level }) => `Ebene ${level}`,
            ladderLevelDetail: ({ level }) => (level === 1 ? "Von einem Agenten in deiner eigenen Arbeit gestartet" : `Von einem Agenten auf Ebene ${level - 1} gestartet`),
            ladderRefused: 'Eine weitere Übergabe',
            ladderRefusedDetail: ({ level }) => `Ebene ${level} · abgelehnt; der Agent macht es selbst`,
        },
        session: {
            refusal: {
                unenforceableTitle: 'Dieser Agent kann nicht „Nur delegieren“',
                unenforceableBody: 'Die Rolle ist „Nur delegieren“, und der Agent dieser Sitzung kann seine eigenen Dateiänderungen nicht zurückhalten. Schalte „Nur delegieren“ für die Rolle aus oder starte sie in einer neuen Sitzung mit einem Agent, der das unterstützt.',
                restartRequiredTitle: 'Sitzung neu starten, um nur zu delegieren',
                restartRequiredBody: 'Dieser Agent wendet „Nur delegieren“ nur beim Start der Sitzung an. Starte die Sitzung neu und wähle die Rolle dann erneut.',
                roleUnavailableTitle: 'Diese Rolle ist nicht mehr verfügbar',
                roleUnavailableBody: 'Sie wurde entfernt, ausgeschaltet oder wird nicht mehr mit dir geteilt. Wähle eine andere Rolle.',
            },
            useDefaults: 'Standardrollen nutzen',
            crossOwnerNote: 'Rollen wurden beim Start kopiert.',
            addRole: 'Rolle für diese Sitzung hinzufügen',
            addRoleConfirm: 'Rolle hinzufügen',
            namePlaceholder: 'Rollenname',
            instructionsPlaceholder: 'Was diese Rolle tut und wann man sie nutzt',
            notesTitle: 'Notizen',
            notesPlaceholder: 'Was jede Sitzung darunter wissen sollte',
            applyToReports: 'Rollen auf Sitzungen darunter anwenden',
            handsOffTitle: 'Nur delegieren',
            handsOffDescription: 'Plant und delegiert; bearbeitet keine Dateien.',
            saveFailed: 'Diese Änderung konnte nicht gespeichert werden.',
            sectionTitle: 'Rollen',
            allRoles: 'Alle Rollen',
            inUse: ({ count }) => `${count} in Nutzung`,
            changed: 'geändert',
            thisSession: 'diese Sitzung',
            reset: 'Zurücksetzen',
            newRoleForSession: 'Neue Rolle für diese Sitzung',
            changeForSession: 'Für diese Sitzung ändern',
            editNotes: 'Notizen bearbeiten',
            more: 'Mehr',
            info: 'Rollen gelten für diese Sitzung und die Sitzungen darunter.',
            countChanged: ({ count }) => `${count} geändert`,
            countAdded: ({ count }) => `${count} hinzugefügt`,
            addNotes: 'Notizen hinzufügen, wie diese Sitzung orchestrieren soll',
        },
        profiles: {
            sharedWithYouTitle: 'Mit dir geteilt',
            sharedWithYouDescription: 'Profile, die Personen und Teams mit dir teilen. Geheime Werte bleiben bei ihren Besitzern.',
            share: 'Teilen…',
            shareFailedTitle: 'Dieses Profil konnte nicht geteilt werden',
            shareNeedsSavedSecrets: 'Geheime Werte werden nie übertragen. Verschiebe jeden Wert dieses Profils in ein gespeichertes Secret, verknüpfe es und teile dann erneut.',
            shareAwaitingApproval: 'Die Veröffentlichung dieses Profils wartet auf Freigabe. Wähle danach erneut „Teilen…“.',
        },
    } } as const satisfies Pick<Record<string, RolesTranslations>, "de">;

return { rolesTranslations };
})();

const Domain_runPageTranslations = (() => {
type Count = Shared_runPageTranslations.Count;

type Machine = Shared_runPageTranslations.Machine;

type Reviewer = Shared_runPageTranslations.Reviewer;

type RunPageTranslations = Shared_runPageTranslations.RunPageTranslations;

const runPageTranslations = { de: {
        untitledRun: 'Agent-Lauf',
        intentTitles: { review: 'Review', plan: 'Plan', delegate: 'Delegierte Aufgabe' },
        thisMachine: 'diesem Rechner',
        menu: {
            cancelResponse: 'Diese Antwort abbrechen',
            copyResult: 'Ergebnis kopieren',
            showInTranscript: 'Im Verlauf zeigen',
            runDetails: 'Details zum Lauf',
            agent: 'Agent',
            permissions: 'Berechtigungen',
            kind: 'Art',
            finishesOnItsOwn: 'Endet von selbst',
            selectionInherited: 'Von der Sitzung übernommen',
            selectionExplicit: 'Für diesen Lauf gewählt',
            selectionIndependent: 'Kontostandard',
            selectionRetained: 'Seit dem Start beibehalten',
            selectionChoose: 'Für diesen Lauf wählen',
            selectionChooseDetail: 'Ein Modell wählen und worüber es läuft',
            staysOpen: 'Bleibt offen',
            started: 'Gestartet',
            run: 'Lauf',
            process: 'Prozess',
        },
        opening: { reading: ({ machine }) => `Wird von ${machine} gelesen.` },
        gone: {
            title: ({ machine }) => `Dieser Lauf ist nicht mehr auf ${machine}`,
            reason: 'Er wird dort nicht mehr aufbewahrt, und der geladene Teil des Verlaufs enthält ihn nicht.',
            closeTab: 'Tab schließen',
        },
        stopFailed: {
            title: {
                review: 'Dieses Review konnte nicht gestoppt werden',
                plan: 'Dieser Plan konnte nicht gestoppt werden',
                delegate: 'Diese Aufgabe konnte nicht gestoppt werden',
                run: 'Dieser Lauf konnte nicht gestoppt werden',
            },
            reasonWithOthers: ({ machine, count }) => `${machine} hat den Stopp nicht bestätigt. Du kannst stattdessen die ganze Sitzung stoppen – das stoppt auch ${count === 1 ? 'den anderen Agenten' : `die ${count} anderen Agenten`}, die darin laufen.`,
            reasonAlone: ({ machine }) => `${machine} hat den Stopp nicht bestätigt. Du kannst stattdessen die ganze Sitzung stoppen.`,
            stopSession: 'Sitzung stoppen…',
        },
        steps: {
            title: 'Wie es dazu kam',
            count: ({ count }) => (count === 1 ? '1 Schritt' : `${count} Schritte`),
        },
        review: {
            findings: 'Befunde',
            findingsCount: ({ count }) => `${count}`,
            highCount: ({ count }) => `${count} hoch`,
            severity: { blocker: 'Blocker', high: 'Hoch', medium: 'Mittel', low: 'Niedrig', nit: 'Kleinigkeit' },
            triageLabel: 'Was mit diesem Befund geschehen soll',
            reviewerAsks: 'Der Reviewer fragt',
            answer: 'Antworten',
            askAboutThis: 'Dazu nachfragen',
            fixesSelected: ({ count }) => (count === 1 ? '1 Korrektur ausgewählt' : `${count} Korrekturen ausgewählt`),
            noFixesSelected: 'Wähle die Korrekturen aus',
            implementFixes: ({ count }) => (count === 1 ? '1 Korrektur umsetzen' : count > 1 ? `${count} Korrekturen umsetzen` : 'Korrekturen umsetzen'),
            couldNotSaveChoice: 'Deine Auswahl konnte nicht gespeichert werden.',
            reviewers: 'Prüfer',
            findingTotal: ({ count }) => (count === 1 ? '1 Befund' : `${count} Befunde`),
            moreFindings: ({ count }) => (count === 1 ? '1 weiterer Befund' : `${count} weitere Befunde`),
            fixesToImplement: ({ count }) => (count === 1 ? '1 Korrektur umzusetzen' : `${count} Korrekturen umzusetzen`),
            verifiedFirst: 'Jede wird erst geprüft, dann behoben',
            replies: ({ count }) => (count === 1 ? '1 Antwort' : `${count} Antworten`),
            updatedAfterQuestion: 'Nach deiner Frage aktualisiert',
            reviewerUpdated: ({ reviewer }) => `${reviewer} hat den Befund aktualisiert`,
            askPlaceholder: 'Stelle eine Rückfrage zu diesem Befund…',
            askReviewerPlaceholder: 'Stelle dem Prüfer eine Rückfrage…',
            toReviewer: ({ reviewer }) => `An ${reviewer}`,
            followUpsGoTo: ({ reviewer }) => `Rückfragen gehen an ${reviewer}`,
            waitingForAnswer: ({ reviewer }) => `Warte auf ${reviewer}…`,
            waitingForAnswers: 'Warte auf die Reviewer…',
            both: 'Beide',
            reviewerCount: ({ count }) => `${count} Reviewer`,
            askReviewersPlaceholder: 'Stelle den Reviewern eine Rückfrage…',
            followUpsGoToAll: ({ count }) => (count === 2 ? 'Rückfragen gehen an beide Reviewer' : `Rückfragen gehen an alle ${count} Reviewer`),
            stillReviewing: 'Prüft noch',
            reviewerDidNotFinish: 'Nicht abgeschlossen',
            reviewersNotStarted: ({ count }) => (count === 1 ? 'Ein Reviewer ist nicht gestartet' : `${count} Reviewer sind nicht gestartet`),
            reviewerNotStarted: ({ reviewer }) => `${reviewer} konnte nicht starten.`,
            notSaved: 'Dieser Befund wurde nicht gespeichert und kann noch keine Entscheidung aufnehmen.',
            decisionsUnavailable: 'Deine Entscheidungen konnten nicht geladen werden.',
            followUpUnavailable: {
                notResumable: 'Diese Prüfung ist beendet; Rückfragen brauchen eine Prüfung, die offen bleibt.',
                ended: 'Diese Prüfung wurde nicht abgeschlossen und nimmt keine Rückfragen an.',
                resumeUnavailable: 'Der Prüfer ist auf diesem Gerät nicht mehr erreichbar.',
                busy: 'Der Prüfer ist noch beschäftigt. Versuche es gleich noch einmal.',
                failed: 'Deine Frage konnte nicht gesendet werden.',
            },
        },
        launcher: {
            titles: { review: 'Review anfordern', plan: 'Plan anfordern', delegate: 'Aufgabe abgeben' },
            descriptions: {
                review: ({ machine }) => `Jeder Agent prüft die Änderungen auf ${machine} für sich; du bekommst hier ein Ergebnis von jedem.`,
                plan: ({ machine }) => `Der Agent liest den Code auf ${machine} und schlägt hier einen Plan vor. Er ändert nichts.`,
                delegate: ({ machine }) => `Der Agent arbeitet auf ${machine} mit den Berechtigungen unten und meldet sich hier zurück.`,
            },
            whatFor: 'Wofür',
            who: { review: 'Wer prüft', plan: 'Wer plant', delegate: 'Wer es macht' },
            selectedCount: ({ count }) => `${count} ausgewählt`,
            focus: {
                review: 'Worauf sollen sie achten?',
                plan: 'Was soll der Plan abdecken?',
                delegate: 'Was soll er tun?',
            },
            optional: 'optional',
            start: {
                review: ({ count }) => (count > 1 ? `${count} Reviews starten` : 'Review starten'),
                plan: 'Plan starten',
                delegate: 'Aufgabe starten',
            },
            runsOn: ({ machine }) => `Läuft auf ${machine}`,
            checking: 'Prüfe, welche Agenten hier laufen können',
            unavailableTitle: 'In dieser Sitzung können keine Agenten starten',
            unavailableReason: 'Ihr Rechner bietet gerade keine Reviews, Pläne oder delegierten Aufgaben an.',
        },
    } } as const satisfies Pick<Record<string, RunPageTranslations>, "de">;

return { runPageTranslations };
})();

const Domain_scmComparisonTranslations = (() => {
type ScmComparisonTranslations = Shared_scmComparisonTranslations.ScmComparisonTranslations;

const en = Shared_scmComparisonTranslations.en;

const translated = Shared_scmComparisonTranslations.translated;

const scmComparisonTranslations = { de: {
        scmComparison: translated({
            view: { files: 'Dateien', walkthrough: 'Durchgang', commits: 'Commits' },
            scope: {
                workingTree: 'Ausstehende Änderungen',
                session: 'Diese Sitzung',
                turn: 'Zug',
                latestTurn: 'Letzter Zug',
                branch: ({ head, base }) => `${head} gegen ${base}`,
                commit: ({ commit }) => `Commit ${commit}`,
            },
            tabTitle: ({ view, scope }) => `${view} · ${scope}`,
            since: ({ time }) => `seit ${time}`,
            turnsWithChanges: ({ count }) => `${count} ${count === 1 ? 'Zug' : 'Züge'} mit Änderungen`,
            scopePicker: {
                a11y: 'Anzuzeigende Änderungen',
                branchChoice: 'Branch gegen Basis',
                commitChoice: 'Commit',
                pullRequestChoice: 'Pull Request',
                headRef: 'Head-Branch oder Referenz',
                baseRef: 'Basis-Branch oder Referenz',
                parentRef: 'Übergeordnete Referenz (optional)',
                explainAndCommit: 'Erklären und committen',
                explainOnly: 'Nur erklären',
                unavailable: 'Für diese Sitzung nicht verfügbar',
                pendingDescription: 'Noch nicht committed · kann Commits vorschlagen',
                sessionDescription: 'Alles, was sich geändert hat, Start → jetzt',
                turnDescription: 'In der Reihenfolge des Agenten',
                branchDescription: 'Änderungen seit der gemeinsamen Basis',
                commitDescription: 'Änderungen durch diesen Commit',
                pullRequestDescription: 'Änderungen dieses Pull Requests',
            },
            fileCount: ({ count }) => `${count} ${count === 1 ? 'Datei' : 'Dateien'}`,
            changeCount: ({ count }) => `${count} ${count === 1 ? 'Änderung' : 'Änderungen'}`,
            changedFiles: 'Geänderte Dateien',
            startReview: 'Review starten',
            proposeCommits: 'Commits vorschlagen',
            explain: 'Erklären',
            explainA11y: 'Erklären: die Notizen des Durchgangs neben den Änderungen zeigen',
            viewA11y: 'Ansicht',
            lockfileTag: 'Lockfile',
            generatedTag: 'Generiert',
            lockfileCollapsed: 'Lockfile, eingeklappt.',
            generatedCollapsed: 'Generierte Datei, eingeklappt.',
            showDiff: 'Diff anzeigen',
            unsupportedReason: 'Dateien kann diesen Vergleich noch nicht anzeigen. Die Änderungen sind weiterhin in Git.',
            showPendingChanges: 'Ausstehende Änderungen anzeigen',
            capturedStale: 'Die Quelle hat sich geändert. Diese Dateien zeigen weiterhin den erfassten Vergleich.',
            capturedFreshnessUnknown: 'Erfasste Dateien werden angezeigt. Der aktuelle Zustand der Quelle konnte nicht geprüft werden.',
            keys: { nextFile: 'nächste Datei', nextChange: 'nächste Änderung' },
        }),
    } } as const;

return { scmComparisonTranslations };
})();

const Domain_secretsSettingsTranslations = (() => {
type SecretsSettingsCopy = Shared_secretsSettingsTranslations.SecretsSettingsCopy;

const en = Shared_secretsSettingsTranslations.en;

const de: SecretsSettingsCopy = {
    purpose: "API-Schlüssel und Tokens für Agenten und MCP-Server. Gespeicherte Werte werden nicht erneut angezeigt.",
    yoursTitle: 'Deine Secrets',
    yoursDescription: 'Secrets, die du gespeichert hast oder besitzt. Wähle sie überall dort aus, wo Happier nach einem Schlüssel fragt.',
    sharedWithYouTitle: 'Mit dir geteilt',
    sharedWithYouDescription: 'Andere erlauben dir, diese zu verwenden. Du kannst sie auswählen, aber nicht ansehen oder ändern.',
    add: 'Secret hinzufügen',
    newSecret: 'Neues Secret',
    emptyTitle: 'Noch keine Secrets',
    emptyDescription: 'Füge einen API-Schlüssel oder Token einmal hinzu und wähle ihn dann überall aus, wo Happier danach fragt.',
    staleTitle: 'Geteilte Secrets konnten nicht aktualisiert werden',
    staleDescription: 'Die zuletzt bekannte Liste wird angezeigt.',
    valueTitle: 'Wert',
    valueSaved: 'Gespeichert. Er wird nie wieder angezeigt.',
    keepTitle: 'Speichern als',
    keepPersonal: 'Persönlich',
    keepShared: 'Geteilt',
    keepPersonalDescription: 'In deinem Konto gespeichert. Nur du kannst es verwenden.',
    keepSharedDescription: 'Auf diesem Home gespeichert, damit du es mit Personen, Teams oder Gruppen teilen kannst.',
    accessTitle: 'Wer es verwenden kann',
    accessOnlyYou: 'Nur du',
    accessRecipients: ({ count }: { count: number }) => (count === 1 ? 'Du und 1 Empfänger' : `Du und ${count} Empfänger`),
    sharePersonalDescription: 'Beim Teilen wird es auf dieses Home verschoben. Es kann danach nicht mehr persönlich werden.',
    share: 'Teilen',
    manage: 'Verwalten',
    storageTitle: 'Speicherung',
    storageE2ee: 'Ende-zu-Ende-verschlüsselt',
    storageE2eeDescription: 'Nur die Personen, mit denen du es teilst, können es lesen.',
    storagePlain: 'Vom Home verwaltet',
    storagePlainDescription: 'Dieses Home speichert es und kann es lesen, um es bereitzustellen.',
    save: 'Secret speichern',
};

const secretsSettingsTranslations = { de } as const;

return { secretsSettingsTranslations };
})();

const Domain_sessionAccessTranslations = (() => {
const sessionAccessTranslations = { "de": {
        withContext: ({ context, label }: { context: string; label: string }) => `${context} · ${label}`,
        withCount: ({ label, count }: { label: string; count: number }) => `${label} +${count}`,
        accessibleSummary: ({ title, label }: { title: string; label: string }) => `${title}: ${label}`,
        accessibleControl: ({ name, control, value }: { name: string; control: string; value: string }) => `${name}, ${control}, ${value}`,
        title: "Session-Zugriff",
        context: "Sitzungskontext",
        search: "Personen, Gruppen oder Teams suchen",
        hasAccess: "Hat Zugriff",
        yourAccess: "Dein Zugriff",
        readOnly: "Du kannst sehen, wodurch du Zugriff hast. Nur Session-Administratoren können Änderungen vornehmen.",
        sourceDirect: "Direkter Zugriff",
        sourceTeam: "Zugriff über ein Team",
        sourceGroup: "Zugriff über eine Gruppe",
        people: "Personen",
        groups: "Gruppen",
        teams: "Teams",
        account: "Person",
        group: "Gruppe",
        team: "Team",
        view: "Kann ansehen",
        edit: "Kann steuern",
        admin: "Verwalten",
        owner: "Eigentümer",
        private: "Privat",
        custom: "Individueller Zugriff",
        required: "Durch Team-Richtlinie erforderlich",
        subjectNotFound: "Diese Person, Gruppe oder dieses Team ist nicht mehr verfügbar.",
        subjectIneligible: "Diese Person, Gruppe oder dieses Team kann keinen Zugriff mehr erhalten.",
        teamPolicyRequired: "Die Team-Richtlinie erfordert diesen Zugriff.",
        selfGrantManaged: "Ein anderer Zugriffsverwalter muss deinen Zugriff ändern.",
        homeUnsupported: "Dieses Home unterstützt Sitzungszugriff noch nicht. Aktualisiere es, um zu verwalten, wer diese Sitzung öffnen kann.",
        openCollaboration: "Zusammenarbeit öffnen",
        authenticationRequired: "Melde dich mit einer von diesem Team akzeptierten Methode an und versuche es erneut.",
        authenticationUnavailable: "Die von diesem Team erforderliche Anmeldemethode ist auf diesem Home nicht verfügbar.",
        delegation: "Darf Laufzeitberechtigungen genehmigen",
        remove: "Zugriff entfernen",
        confirmRemove: "Entfernen bestätigen",
        credentialsLost: ({ names }: { names: string }) => `Diese Team-Zugangsdaten funktionieren hier nicht mehr: ${names}`,
        ready: "Verschlüsselter Zugriff bereit",
        prepared: "Verschlüsselter Zugriff vorbereitet",
        recipientRepairRequired: "Diese Person muss die Verschlüsselungseinrichtung ihres Kontos reparieren.",
        pending: "Verschlüsselter Zugriff ausstehend",
        setup: "Verschlüsselungseinrichtung erforderlich",
        repair: "Verschlüsselter Zugriff muss repariert werden",
        unavailable: "Verschlüsselter Inhalt nicht verfügbar",
        notRequired: "Diese Session ist nicht verschlüsselt, es muss nichts vorbereitet werden.",
        preparing: "Verschlüsselter Zugriff wird vorbereitet…",
        preparingProgress: ({ count }: { count: number }) => `Verschlüsselter Zugriff wird vorbereitet… ${count} vorbereitet`,
        preparationPending: ({ count }: { count: number }) => `Verschlüsselter Zugriff ausstehend für ${count} Personen`,
        preparationSetup: ({ count }: { count: number }) => `${count} Personen müssen die Verschlüsselung einrichten`,
        preparationRepair: ({ count }: { count: number }) => `Verschlüsselter Zugriff muss für ${count} Personen repariert werden`,
        preparationKeyUnavailable: "Dieses Gerät kann den verschlüsselten Zugriff für diese Sitzung nicht vorbereiten.",
        preparationFailed: "Der Zugriff wurde gespeichert, aber die Vorbereitung des verschlüsselten Zugriffs ist fehlgeschlagen.",
        preparationPassFailed: "Die Vorbereitung des verschlüsselten Zugriffs ist fehlgeschlagen.",
        preparationAnnouncedComplete: "Vorbereitung des verschlüsselten Zugriffs abgeschlossen.",
        preparationAnnouncedNeedsAttention: "Der verschlüsselte Zugriff braucht noch Einrichtung oder Reparatur.",
        preparationCheckFailed: "Der verschlüsselte Zugriff konnte nicht geprüft werden.",
        outcomeUnknown: "Das Ergebnis ist unklar. Happier prüft den aktuellen Zugriff, bevor du es erneut versuchst.",
        historicalLayoutNotice: "Personen, mit denen du diese Session teilst, können sie erst öffnen, wenn sie für diese Happier-Version aktualisiert wurde.",
        historicalLayoutUpdate: "Für das Teilen aktualisieren",
        homeReconciled: "Der Session-Zugriff wurde für das neue Home zurückgesetzt.",
        lockedTitleFallback: "Verschlüsselte Session",
        encryptedAccess: "Verschlüsselter Zugriff",
        aggregatePrepared: ({ count }: { count: number }) => `${count} vorbereitet`,
        aggregatePending: ({ count }: { count: number }) => `${count} ausstehend`,
        aggregateNeedsAttention: ({ count }: { count: number }) => `${count} benötigen Einrichtung oder Reparatur`,
        prepareNow: "Jetzt vorbereiten",
        prepareAgain: "Erneut vorbereiten",
        preparingProgressOf: ({ count, total }: { count: number; total: number }) => `Verschlüsselter Zugriff wird vorbereitet… ${count} von ${total}`,
        showAllRecipients: "Alle Personen anzeigen",
        hideAllRecipients: "Personen ausblenden",
        moreRecipients: "Mehr Personen anzeigen",
        recipientPlainAccount: "Konto ohne Verschlüsselung",
        pendingBody: "Diese Session ist verschlüsselt. Eine verwaltende Person muss deinen verschlüsselten Zugriff noch vorbereiten, bevor sie sich hier öffnet.",
        setupBody: "Schließe die Verschlüsselungseinrichtung für dieses Konto ab, danach kann eine verwaltende Person deinen Zugriff auf diese Session vorbereiten.",
        setupAction: "Verschlüsselung einrichten",
        repairBody: "Der für diese Session gelieferte Schlüssel ließ sich auf diesem Gerät nicht öffnen. Versuche es erneut oder bitte eine verwaltende Person, den Zugriff erneut vorzubereiten.",
        retryAction: "Erneut versuchen",
        unavailableBody: "Der Schlüssel ließ sich öffnen, aber der Inhalt dieser Session konnte nicht entschlüsselt werden. Eine verwaltende Person kann den Zugriff erneut vorbereiten.",
        openAccessAction: "Session-Zugriff öffnen",
        removedTitle: "Zugriff entfernt",
        removedBody: "Mit deinem aktuellen Zugriff lässt sich diese Session nicht öffnen. Eine verwaltende Person kann sie erneut teilen.",
        removedAnnouncement: ({ name }: { name: string }) => `${name} aus dem Session-Zugriff entfernt`,
        browseMore: "Alle durchsuchen",
        allLoaded: "Alle Ergebnisse geladen",
        levelHelp: { view: "die Sitzung lesen", edit: "den Agenten innerhalb seiner konfigurierten Werkzeugberechtigungen steuern", admin: "den Sitzungszugriff verwalten" },
        steeringScopeNotice: "Die Steuerung ist kein isolierter Chat: Arbeitsordner und Namensanzeige begrenzen keinen Shell-, Dateisystem- oder Netzwerkzugriff.",
        help: "Kann ansehen erlaubt das Lesen. Kann steuern erlaubt die Steuerung des Agenten innerhalb seiner Werkzeugberechtigungen. Verwalten erlaubt auch die Zugriffsverwaltung. Dies ist kein isolierter Chat: Arbeitsordner und Namensanzeige begrenzen keinen Shell-, Datei- oder Netzwerkzugriff."
    } } as const;

return { sessionAccessTranslations };
})();

const Domain_sessionAgentActivityTranslations = (() => {
const en = Shared_sessionAgentActivityTranslations.en;

const de: typeof en = {
    status: {
        queued: 'In Warteschlange',
        starting: 'Wird gestartet',
        running: 'Läuft',
        waiting: 'Wartet',
        blocked: 'Blockiert',
        succeeded: 'Abgeschlossen',
        failed: 'Fehlgeschlagen',
        timedOut: 'Zeitüberschreitung',
        cancelled: 'Gestoppt',
        unknown: 'Unbekannt',
    },
    attention: {
        permission: 'Freigabe erforderlich',
        userAction: 'Antwort erforderlich',
        both: 'Benötigt Aufmerksamkeit',
        bothDescription: 'Freigabe und deine Antwort erforderlich',
    },
    runKind: {
        conversation: 'Unterhaltung',
        review: 'Review',
        plan: 'Plan',
    },
    /** The Agents pane: its "+", its states, its team groups and its live line (agents lab). */
    roster: {
        teamLabel: ({ team, count }) => `Team ${team} · ${count} ${count === 1 ? 'Agent' : 'Agents'}`,
        teamActionsA11y: 'Team-Aktionen',
        openWork: 'Öffnen',
        needsYouCount: ({ count }) => `${count} brauchen dich`,
        runningCount: ({ count }) => `${count} laufen`,
        nothingRunning: 'Nichts läuft.',
        startAgent: 'Agent starten',
        machineOffline: ({ machine }) => `${machine} antwortet nicht`,
        machineOfflineUnnamed: 'Die Maschine antwortet nicht',
        launch: {
            menuA11y: 'Agent starten',
            conversationDescription: 'Mit einem Agenten neben dieser Sitzung sprechen',
            reviewDescription: 'Die bisherigen Änderungen prüfen',
            planDescription: 'Die nächsten Schritte planen',
            delegateDescription: 'Eine Aufgabe abgeben und erledigt zurückbekommen',
            advancedDescription: 'Agenten, Berechtigungen und Profil wählen',
        },
        empty: {
            title: 'Mehr Agenten auf diese Sitzung setzen',
            reason: ({ machine }) => `Starte ein Nebengespräch oder lass prüfen oder planen, während du weiterarbeitest. Sie laufen auf ${machine} und berichten hier.`,
            reasonUnnamed: 'Starte ein Nebengespräch oder lass prüfen oder planen, während du weiterarbeitest. Sie berichten hier.',
            moreWays: 'Review, Plan oder Delegation anfragen',
        },
        unavailable: {
            notEnabled: 'Agenten können in diesem Home nicht starten.',
            machineOffline: ({ machine }) => `Zum Starten von Agenten muss ${machine} online sein.`,
            machineOfflineUnnamed: 'Zum Starten von Agenten muss diese Maschine online sein.',
            sessionInactive: 'Diese Sitzung wurde beendet. Setze sie fort, um hier Agenten zu starten.',
            externalRunnerInactive: 'Diese Sitzung wurde außerhalb von Happier gestartet. Agenten können von hier starten, solange Happier verbunden ist.',
        },
    },
    summaryA11y: ({ title, status }) => `${title}, ${status}`,
    summaryAttentionA11y: ({ title, status, attention }) => `${title}, ${status}, ${attention}`,
};

const sessionAgentActivityTranslations = { de };

return { sessionAgentActivityTranslations };
})();

const Domain_sessionBoardTranslations = (() => {
type SessionBoardStateTranslation = Shared_sessionBoardTranslations.SessionBoardStateTranslation;

type SessionBoardTranslation = Shared_sessionBoardTranslations.SessionBoardTranslation;

const sessionBoardTranslations = { de: {
        title: 'Pinnwand',
        views: {
            label: 'Pinnwand-Ansichten',
            overview: 'Übersicht',
            createTitle: 'Neue Pinnwand-Ansicht',
            renameTitle: 'Pinnwand-Ansicht umbenennen',
            reconciled: ({ title }) => `Diese Pinnwand-Ansicht wurde entfernt. ${title} wird angezeigt.`,
            empty: {
                title: 'Nichts in dieser Ansicht',
                reason: 'Füge hier ein Widget hinzu oder wechsle zu einer anderen Ansicht.',
            },
            actions: {
                create: 'Neue Ansicht',
                rename: 'Ansicht umbenennen',
                moveBefore: 'Ansicht nach vorn',
                moveAfter: 'Ansicht nach hinten',
                remove: 'Ansicht löschen',
            },
            remove: {
                title: ({ title }) => `„${title}“ löschen?`,
                moveMessage: ({ title }) => `Die Widgets wandern zu ${title}. Aus der Session wird nichts gelöscht.`,
                unpinMessage: 'Die Widgets bleiben in der Session, sind aber an keine Ansicht mehr geheftet.',
            },
        },
        add: { note: 'Notiz', interactiveView: 'Interaktive Ansicht' },
        width: { compact: 'Kompakt', medium: 'Mittel', wide: 'Breit', full: 'Volle Breite' },
        height: { auto: 'An Inhalt anpassen', compact: 'Niedrig', regular: 'Mittel', tall: 'Hoch' },
        board: {
            loading: { title: 'Pinnwand wird geöffnet', reason: 'Wir laden, was an diese Sitzung geheftet ist.' },
            locked: {
                title: 'Die Pinnwand ist noch verschlüsselt',
                reason: 'Dieses Gerät kann die Sitzung noch nicht öffnen. Es ging nichts verloren.',
            },
            unopenable: {
                title: 'Die Anordnung lässt sich nicht lesen',
                reason: 'Die gespeicherte Anordnung ließ sich nicht öffnen. Einzelne Widgets sind davon nicht betroffen.',
            },
            unsupported: {
                title: 'Diese Pinnwand braucht ein neueres Happier',
                reason: 'Alles bleibt erhalten. Öffne sie auf einem unterstützten Gerät oder aktualisiere Happier.',
            },
            unavailable: {
                title: 'Die Pinnwand ist hier noch nicht verfügbar',
                reason: 'Es ging nichts verloren. Sie erscheint, sobald dieses Home Pinnwände aktiviert.',
            },
            offline: 'Offline — du siehst den zuletzt geladenen Stand.',
            offlineEmpty: 'Offline — verbinde dich erneut, um diese Pinnwand zu laden.',
            stale: 'Du siehst den zuletzt geladenen Stand.',
        },
        empty: {
            editor: {
                title: 'Behalte den Plan neben dem Chat',
                description: 'Notizen und Live-Ansichten, die hier angeheftet sind, bleiben bei dieser Sitzung – für alle, die sie lesen dürfen.',
                askAgent: 'Den Agenten fragen',
                askAgentPrompt: 'Stelle etwas auf dieses Board, das Folgendes zeigt: ',
                addNote: 'Notiz hinzufügen',
            },
            viewer: {
                title: 'Noch nichts angeheftet',
                description: 'Was Menschen oder Agenten an diese Sitzung heften, erscheint hier.',
            },
        },
        item: {
            untitled: 'Widget ohne Titel',
            renameA11y: 'Widget-Titel',
            reorderA11y: ({ title }) => `${title} neu anordnen`,
            a11yLabelWithWidth: ({ title, width }) => `${title}, ${width}`,
            menuGroups: { content: 'Lesen und bearbeiten', movement: 'Verschieben', geometry: 'Größe', destructive: 'Entfernen' },
            loading: { title: 'Widget wird geladen', reason: 'Der Inhalt wird von diesem Home geholt.' },
            locked: {
                title: 'Verschlüsselte Inhalte nicht verfügbar',
                reason: 'Dieses Widget bleibt verschlüsselt, bis dieses Gerät die Sitzung öffnen kann.',
            },
            unopenable: {
                title: 'Dieses Widget lässt sich nicht anzeigen',
                reason: 'Der gespeicherte Inhalt ließ sich nicht lesen. Der Rest der Pinnwand bleibt nutzbar.',
            },
            unsupported: {
                title: 'Dieses Widget braucht ein neueres Happier',
                reason: 'Der Inhalt bleibt erhalten. Öffne es auf einem unterstützten Gerät oder aktualisiere Happier.',
            },
            notCopied: { title: 'Visual nicht kopiert', reason: 'Dieses Visual konnte nicht in diese Verzweigung kopiert werden.' },
            missing: {
                title: 'Dieses Widget fehlt',
                reason: 'Die Pinnwand verweist noch darauf, aber der Inhalt liegt nicht auf diesem Home.',
            },
            removed: {
                title: 'Dieses Widget wurde entfernt',
                reason: 'Jemand mit Bearbeitungsrecht hat es für alle gelöscht.',
            },
            pluginUnavailable: {
                title: 'Plugin auf diesem Gerät nicht verfügbar',
                reason: 'Das Widget bleibt erhalten. Es wird wieder angezeigt, sobald das Plugin hier verfügbar ist.',
            },
            rendererUnavailable: {
                title: 'Dieses Widget lässt sich hier nicht anzeigen',
                reason: 'Der Inhalt bleibt erhalten. Öffne es auf einem Gerät, das interaktive Ansichten unterstützt.',
            },
            provenance: {
                note: 'Notiz',
                interactiveView: 'Interaktive Ansicht',
                pluginMissing: ({ pluginId }) => `Von ${pluginId} · nicht installiert`,
                pluginSurface: ({ plugin, surface }) => `${surface} · ${plugin}`,
                pluginQualified: ({ label, pluginId }) => `${label} (${pluginId})`,
            },
            actions: {
                remove: 'Von der Pinnwand entfernen',
                openHere: 'Hier öffnen',
                managePlugin: 'Plugin verwalten',
                prepareEncryption: 'Verschlüsselung einrichten',
                readFull: 'Ganze Notiz lesen',
                rename: 'Widget umbenennen',
                unpin: 'Aus dieser Ansicht lösen',
                moveToView: ({ title }) => `Nach ${title} verschieben`,
            },
            moved: {
                before: ({ title }) => `${title} nach vorn verschoben.`,
                after: ({ title }) => `${title} nach hinten verschoben.`,
                reordered: ({ title }) => `${title} verschoben.`,
                toView: ({ title, view }) => `${title} nach ${view} verschoben.`,
            },
            movePosition: ({ position, total }) => `Position ${position} von ${total}`,
            moveTargetView: ({ title }) => `Pinnwand-Ansicht ${title}`,
            remove: {
                title: 'Dieses Widget entfernen?',
                message: 'Alle, die diese Session lesen können, verlieren es. Installierte Plugins bleiben installiert.',
            },
        },
        note: {
            titlePlaceholder: 'Titel',
            titleA11y: 'Notiztitel',
            untitled: 'Notiz ohne Titel',
            offline: 'Zum Speichern brauchst du eine Verbindung zu diesem Home.',
            unavailable: 'Änderungen an der Pinnwand sind auf diesem Home noch nicht möglich.',
            failed: 'Happier konnte diese Notiz nicht speichern. Dein Text ist noch da.',
            outcomeUnknown: 'Happier konnte nicht bestätigen, ob die Notiz gespeichert wurde. Lade neu, bevor du erneut speicherst.',
            saved: 'Notiz gespeichert',
            conflict: {
                message: 'Diese Notiz wurde auf einem anderen Gerät geändert.',
                reviewLatest: 'Neueste Fassung ansehen',
                applyMine: 'Meine Änderungen übernehmen',
                latestHeading: 'Neueste Fassung',
            },
        },
        recovered: {
            title: 'Wiederhergestellte Elemente',
            description: 'Diese Widgets gehören zur Session, liegen aber in keiner Pinnwand-Ansicht.',
            pin: 'Zu dieser Ansicht hinzufügen',
        },
        mutation: {
            conflict: 'Diese Pinnwand wurde auf einem anderen Gerät geändert. Lade neu, um den aktuellen Stand zu sehen.',
            outcomeUnknown: 'Happier konnte nicht bestätigen, ob die Änderung gespeichert wurde.',
            denied: 'Du darfst diese Pinnwand nicht mehr ändern.',
            offline: 'Änderungen an der Pinnwand brauchen eine Verbindung zu diesem Home.',
            unavailable: 'Dieses Home kann die Pinnwand noch nicht ändern.',
            updateRequired: 'Aktualisiere Happier für diese Pinnwand-Änderung.',
            noteTooLarge: 'Diese Notiz ist zu groß zum Speichern. Dein Text ist noch da.',
            invalid: 'Diese Pinnwand-Änderung ist ungültig. Prüfe sie und versuche es erneut.',
            notFound: 'Dieses Pinnwand-Element ist nicht mehr verfügbar. Lade die Pinnwand neu.',
            storageFailed: 'Happier konnte diese Pinnwand-Änderung nicht sicher speichern. Deine Arbeit ist noch da.',
            serverFailed: 'Dieses Home konnte die Pinnwand-Änderung nicht abschließen. Versuche es erneut.',
            failed: 'Happier konnte diese Pinnwand-Änderung nicht anwenden.',
        },
        hostedHtmlApproval: {
            title: 'Diese interaktive Ansicht erlauben?',
            body: 'Die Freigabe gilt für diese Ansicht in dieser Sitzung. Zum Senden einer Nachricht musst du weiterhin in die Ansicht klicken.',
            resources: ({ count }) => (count === 1 ? 'Kann 1 Sitzungsressource lesen' : `Kann ${count} Sitzungsressourcen lesen`),
            actions: ({ count }) => (count === 1 ? 'Kann 1 Aktion ausführen' : `Kann ${count} Aktionen ausführen`),
            sendMessages: 'Kann Happier bitten, Nachrichten zu senden',
            loadsFrom: ({ origin }) => `Lädt von ${origin}`,
            allow: 'Erlauben',
            notNow: 'Nicht jetzt',
            declined: {
                title: 'Interaktive Ansicht noch nicht erlaubt',
                reason: 'Sieh dir jederzeit an, was sie anfordert.',
                review: 'Prüfen',
            },
        },
        sidebar: {
            openInDetails: 'In den Details öffnen',
            openBoard: 'Pinnwand öffnen',
            sharedWithEveryone: 'Für alle hier sichtbar',
            widgetCount: ({ count }) => `${count} ${count === 1 ? 'Widget' : 'Widgets'}`,
        },
        mobile: { searchPlaceholder: 'Dieses Board durchsuchen' },
        inline: {
            openBoard: 'Pinnwand öffnen',
            openBoardA11y: ({ title }) => `„${title}“ auf der Pinnwand öffnen`,
        },
        companion: {
            title: 'Begleiter',
            inCompanionA11y: 'In deinem Begleiter',
            empty: {
                title: 'Behalte die Session im Blick',
                reason: 'Lege die Sitzungsübersicht oder ein Pinnwand-Widget neben deinen Chat: was läuft, was auf dich wartet, was sich geändert hat.',
                note: 'Nur du siehst deinen Begleiter.',
            },
            pane: {
                besideChat: 'Neben deinem Chat',
                itemCount: ({ count }: { count: number }) => count === 1 ? '1 Element' : `${count} Elemente`,
                justForYou: 'Nur für dich, neben dem Chat',
            },
            actions: {
                addSummary: 'Sitzungsübersicht hinzufügen',
                addItem: ({ title }) => `${title} hinzufügen`,
                moveToLeading: 'Nach links verschieben',
                moveToTrailing: 'Nach rechts verschieben',
                moveToFirst: 'Ganz nach oben verschieben',
                moveToLast: 'Ganz nach unten verschieben',
                compact: 'Kompakte Größe',
                comfortable: 'Komfortable Größe',
                openFull: 'Begleiter vollständig öffnen',
                openOnBoard: 'Auf der Pinnwand öffnen',
                collapse: 'Begleiter einklappen',
                expand: 'Begleiter ausklappen',
                hide: 'Begleiter ausblenden',
                addToCompanion: 'Zum Begleiter hinzufügen',
                removeFromCompanion: 'Aus Begleiter entfernen',
                undo: 'Rückgängig',
                menuA11y: 'Begleiter-Optionen',
                itemMenuA11y: ({ title }) => `Optionen für ${title}`,
            },
            a11y: {
                headerAction: ({ count }) => `Begleiter, ${count} Elemente`,
                show: ({ count }) => `Begleiter anzeigen, ${count} Elemente`,
                expand: ({ count }) => `Begleiter ausklappen, ${count} Elemente`,
            },
            summary: {
                review: 'Ansehen',
                title: 'Sitzungsübersicht',
                untitled: 'Sitzung',
                approvals: ({ count }) => `${count} warten auf dich`,
                workflows: ({ count }) => `${count} Workflows laufen`,
                changedFiles: ({ count }) => `${count} geändert`,
                tokens: ({ count }) => `${count} Tokens`,
                contextPercent: ({ percent }) => `${percent} % Kontext`,
                contextOnly: 'Kontext genutzt',
                moreDetails: 'Mehr Details',
                moreDetailsA11y: ({ count }) => `Mehr Details, ${count} weitere Zeilen`,
                partial: 'Einige Details sind von hier aus nicht sichtbar.',
            },
            notices: {
                shown: 'Begleiter eingeblendet',
                hidden: 'Begleiter ausgeblendet',
                added: 'Zum Begleiter hinzugefügt',
                removed: 'Aus Begleiter entfernt',
                reordered: 'Begleiter neu sortiert',
                moved: 'Begleiter verschoben',
                boardOpened: 'Pinnwand vom Agenten geöffnet',
                returnedToChat: 'Vom Agenten zum Chat zurückgekehrt',
                boardViewSelected: 'Pinnwand-Ansicht vom Agenten ausgewählt',
                boardItemRevealed: 'Pinnwand-Element vom Agenten geöffnet',
                fullOpened: 'Begleiter vom Agenten geöffnet',
            },
        },
    } } as const satisfies Pick<Readonly<Record<string, SessionBoardTranslation>>, "de">;

return { sessionBoardTranslations };
})();

const Domain_sessionCollaborationPaneTranslations = (() => {
type PaneCopy = Shared_sessionCollaborationPaneTranslations.PaneCopy;

const en = Shared_sessionCollaborationPaneTranslations.en;

const sessionCollaborationPaneTranslations: Pick<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', PaneCopy>, "de"> = { de: {
        hereOne: ({ name }) => `${name} ist hier`,
        hereTwo: ({ first, second }) => `${first} und ${second} sind hier`,
        hereMany: ({ first, count }) => `${first} und ${count.toLocaleString()} weitere sind hier`,
        typingOne: ({ name }) => `${name} schreibt…`,
        typingMany: ({ count }) => `${count.toLocaleString()} Personen schreiben…`,
        justYouHere: 'Nur du bist hier',
        justYouHint: 'Personen, mit denen du sie teilst, erscheinen hier',
        you: 'Du',
        presenceConnecting: 'Wird geprüft, wer hier ist…',
        presenceUnavailable: 'Die Live-Präsenz antwortet gerade nicht',
        presenceUnsupported: 'Live-Präsenz ist auf diesem Home nicht verfügbar',
        responsibleUnsupported: 'Dieses Home erfasst nicht, wer verantwortlich ist',
        inviteTitle: 'Neben der Sitzung besprechen',
        inviteBody: 'Starte eine Unterhaltung, erwähne Personen und gib die Antwort an den Agenten weiter, wenn du so weit bist.',
        readOnly: 'Du kannst sie lesen. Personen, die diese Sitzung bearbeiten dürfen, können schreiben.',
        offline: 'Du bist offline · die letzten Unterhaltungen werden angezeigt',
        lockedTitle: 'Diese Unterhaltungen lassen sich auf diesem Gerät noch nicht öffnen',
        lockedBody: 'Sie sind Ende-zu-Ende-verschlüsselt, und die Verschlüsselung dieses Geräts passt nicht zu der dieser Sitzung.',
        revokedTitle: 'Du hast keinen Zugriff mehr auf diese Unterhaltungen',
        revokedBody: 'Jemand, der diese Sitzung verwaltet, hat geändert, wer sie sehen darf. Deine Nachrichten bleiben bei der Sitzung.',
        namesTwo: ({ first, second }) => `${first} und ${second}`,
        namesThree: ({ first, second, third }) => `${first}, ${second} und ${third}`,
        namesMore: ({ first, second, count }) => `${first}, ${second} und ${count.toLocaleString()} weitere`,
        haveAccess: 'Haben Zugriff',
        hasAccess: 'Hat Zugriff',
        onlyYou: 'Nur du',
        notShared: 'Noch mit niemandem geteilt',
        publicLinkOn: 'Öffentlicher Link an',
        accessLoading: 'Wird geprüft, wer Zugriff hat…',
        accessError: 'Konnte nicht laden, wer Zugriff hat',
        shareTitle: 'Diese Sitzung teilen',
        shareBody: ({ home }) => `Personen, die du auf ${home} hinzufügst, können mitlesen und an den Unterhaltungen teilnehmen.`,
        collapse: 'Einklappen',
        linkOn: 'An',
        linkOff: 'Aus',
        linkGrants: 'Alle mit dem Link können das Transkript ansehen – ohne Konto.',
        linkExpires: ({ date }) => `Läuft am ${date} ab`,
        linkNeverExpires: 'Läuft nie ab',
        linkAsksConsent: 'fragt nach Zustimmung',
        linkNoConsent: 'ohne Zustimmungsschritt',
        linkHidden: 'Dieser Link wurde früher erstellt und kann nicht mehr angezeigt werden. Erstelle einen neuen Link, um ihn zu kopieren.',
        qrCode: 'QR-Code',
        hideQrCode: 'QR-Code ausblenden',
        newLink: 'Neuer Link…',
        turnOff: 'Ausschalten',
        turnOffTitle: 'Öffentlichen Link ausschalten?',
        turnOffBody: 'Alle, die den Link haben, verlieren sofort den Zugriff. Du kannst später einen neuen Link erstellen.',
        newLinkReplaces: 'Der aktuelle Link funktioniert nicht mehr, sobald der neue erstellt ist.',
        linkDenied: 'Nur Personen, die diese Sitzung verwalten, können einen öffentlichen Link erstellen.',
        linkLoadFailed: 'Der öffentliche Link konnte nicht geprüft werden.',
        linkNetworkOff: 'Visuelle Inhalte ohne Netzwerkzugriff teilen',
        linkNetworkConsequence: 'Visuelle Inhalte mit Netzwerkzugriff können ihren Inhalt an andere Websites senden und die IP-Adresse der Betrachtenden offenlegen. Externer Code und Ressourcen können sich ändern. Ohne Netzwerkzugriff bleiben enthaltene Inhalte interaktiv.',
        linkUnavailable: 'Öffentliche Links sind in diesem Home nicht verfügbar. Bitte die Administration, das Hosting öffentlicher Links einzurichten.',
        justYouTitle: 'Gemeinsam an dieser Sitzung arbeiten',
        justYouBody: ({ home }) => `Teile sie mit Personen auf ${home}. Sie können mitlesen, hier darüber sprechen und übernehmen, während du weg bist.`,
        share: 'Teilen',
        justYouNote: 'Oder erstelle einen öffentlichen Link, den alle ansehen können.',
        sharingOffTitle: ({ home }) => `${home} teilt keine Sitzungen mit Personen`,
        sharingOffBody: 'Du kannst trotzdem einen öffentlichen Link erstellen, den alle ansehen können.',
        sharingOffPrivateBody: 'Sitzungen auf diesem Home bleiben bei dir.',
        accessDenied: 'Nur Personen, die diese Sitzung verwalten, können ändern, wer Zugriff hat. Du kannst trotzdem an den Unterhaltungen teilnehmen.',
    } };

return { sessionCollaborationPaneTranslations };
})();

const Domain_sessionCollaborationTranslations = (() => {
const sessionCollaborationPaneTranslations = {...Domain_sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations, ...EnglishFeatures.sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations};

const en = Shared_sessionCollaborationTranslations.en;

const sessionCollaborationTranslations: Pick<Record<'en'|'ca'|'de'|'es'|'fr'|'it'|'ja'|'pl'|'pt'|'ru'|'zh-Hans'|'zh-Hant', typeof en>, "de"> = { de: { pane: sessionCollaborationPaneTranslations['de'], title: 'Zusammenarbeit', viewingNow: 'Gerade hier', justYou: 'Nur du', typing: 'Schreibt…', stale: 'Möglicherweise nicht aktuell', unavailable: 'Live-Präsenz nicht verfügbar', connecting: 'Verbindung wird hergestellt…', unnamed: 'Happier-Mitglied', open: 'Zusammenarbeit öffnen', conversations: 'Unterhaltungen', accessUnavailable: 'Sitzungszugriff nicht verfügbar', accessUnavailableReason: 'Dieses Home unterstützt das Teilen von Sitzungen mit Personen nicht.', discussion: { featureUnavailable: "Unterhaltungen sind auf diesem Home nicht aktiviert.", bindingUnavailable: "Melde dich auf diesem Home erneut an, um Unterhaltungen zu sehen.", scopeMismatch: "Diese Unterhaltungen gehören zu einem anderen Konto auf diesem Home.", modeMismatch: "Der Inhalt passt nicht zum Verschlüsselungsmodus der Sitzung. Versuche es erneut oder bitte eine verwaltende Person, den Zugriff zu prüfen.",  title: 'Unterhaltungen', newDiscussion: 'Neue Unterhaltung', create: 'Unterhaltung erstellen', titlePlaceholder: 'Titel der Unterhaltung', messagePlaceholder: 'Nachricht schreiben…', active: 'Aktiv', activeDisclosure: 'Aktive Unterhaltungen anzeigen', archived: 'Archiviert', archivedDisclosure: 'Archivierte Unterhaltungen anzeigen', emptyActive: 'Noch keine aktiven Unterhaltungen.', emptyArchived: 'Keine archivierten Unterhaltungen.', loading: 'Unterhaltungen werden geladen…', loadError: 'Unterhaltungen konnten nicht geladen werden.', retry: 'Erneut versuchen', checking: 'Nach Aktualisierungen suchen…', deliveryUnknown: 'Zustellung unklar — vor dem erneuten Versuch prüfen.', locked: 'Du kannst diese Unterhaltung lesen, aber nichts darin posten.', offline: 'Du bist offline. Verbinde dich erneut, um fortzufahren.', unavailable: 'Diese Unterhaltung ist nicht verfügbar.', unreadCount: ({ count }) => count === 1 ? '1 ungelesen' : `${count.toLocaleString()} ungelesen`, unreadMentionCount: ({ count }) => count === 1 ? '1 ungelesene Erwähnung' : `${count.toLocaleString()} ungelesene Erwähnungen`,
        mentioned: 'Du wurdest erwähnt', unreadConversations: 'Ungelesene Unterhaltungen', messageCount: ({ count }) => count === 1 ? '1 Nachricht' : `${count.toLocaleString()} Nachrichten`, viaAgent: 'Über Agent', collaborator: 'Mitwirkende Person', contentUnavailable: 'Nachricht nicht verfügbar', rename: 'Unterhaltung umbenennen', archive: 'Unterhaltung archivieren', restore: 'Unterhaltung wiederherstellen', selection: { copy: 'Kopieren', askAgent: 'Agent fragen', sendToSession: 'An Sitzung senden', handoffError: 'Die ausgewählten Nachrichten konnten dem Sitzungseditor nicht hinzugefügt werden.' }, titleRequired: 'Füge einen Titel hinzu, um diese Unterhaltung zu starten.', encryptedTitle: 'Verschlüsselte Unterhaltung', archivedNotice: 'Diese Unterhaltung ist archiviert.', sessionArchived: 'Diese Session ist archiviert.', postDenied: 'Du kannst in dieser Session nichts mehr posten.', invalidMention: 'Eine erwähnte Person kann diese Session nicht mehr lesen.', invalidContent: 'Diese Nachricht kann so nicht gesendet werden. Sie ist möglicherweise leer oder zu lang.', idempotencyConflict: 'Unter dieser Identität wurde bereits eine andere Nachricht gesendet.', sendFailed: 'Diese Nachricht konnte nicht gesendet werden.', dismiss: 'Verwerfen', loadOlder: 'Ältere Nachrichten laden', loadMore: 'Weitere Unterhaltungen laden' } } };

return { sessionCollaborationTranslations };
})();

const Domain_sessionCompanionTranslations = (() => {
type SessionCompanionTranslations = Shared_sessionCompanionTranslations.SessionCompanionTranslations;

const sessionCompanionTranslations = { de: {
        recap: { title: 'Rückblick' },
        status: {
            waitingForYou: 'Wartet auf dich',
            pausedBeforeStep: ({ agent, step, total }) => `${agent} hat vor Schritt ${step} von ${total} pausiert`,
            stepOfPlan: ({ step, total }) => `Schritt ${step} von ${total} im Plan`,
            agentFallback: 'Der Agent',
        },
        ask: {
            question: ({ summary }) => `${summary}?`,
            allow: 'Erlauben',
            deny: 'Ablehnen',
            showInChat: 'Im Chat zeigen',
            moreWaiting: ({ count }) => `${count} weitere warten`,
            allowed: ({ summary }) => `Erlaubt: ${summary}`,
            denied: ({ summary }) => `Abgelehnt: ${summary}`,
            justNow: 'gerade eben',
            failed: 'Deine Antwort hat die Sitzung nicht erreicht. Versuch es erneut.',
            answerWhenBack: ({ machine }) => `Du kannst antworten, sobald ${machine} wieder da ist.`,
            answerWhenSessionBack: 'Du kannst antworten, sobald die Sitzung wieder da ist.',
            notAllowed: 'Nur wer diese Sitzung ausführen darf, kann antworten.',
            groupA11y: 'Wartet auf dich',
        },
        facts: {
            subagents: 'Subagenten',
            changed: 'geändert',
            context: 'Kontext',
            subagentsValue: ({ live, total }) => (live > 0 ? `${live} von ${total}` : `${total}`),
            contextValue: ({ percent }) => `${percent} %`,
            opensAgents: 'Öffnet Agenten',
            opensGit: 'Öffnet Git',
            opensUsage: 'Öffnet Nutzung',
        },
        plan: {
            title: 'Plan',
            description: ({ agent }) => `Die To-do-Liste von ${agent} für diese Sitzung`,
            progress: ({ done, total }) => `${done} von ${total}`,
            progressA11y: ({ done, total }) => `${done} von ${total} erledigt`,
            emptyTitle: 'Noch kein Plan',
            emptyReason: 'Sobald der Agent eine To-do-Liste schreibt, erscheint sie hier, Schritt für Schritt.',
            stepDone: 'Erledigt',
            stepCurrent: 'Aktueller Schritt',
        },
        picker: {
            open: 'Zum Begleiter hinzufügen',
            chooseWidget: 'Widget auswählen…',
            onTheBoard: ({ source }) => `${source} · auf der Pinnwand`,
        },
        drop: { keepBesideChat: 'Neben dem Chat behalten' },
        freshness: { machineOffline: ({ machine }) => `${machine} ist offline` },
        needsYouA11y: ({ count }) => `Begleiter, ${count} warten auf dich`,
    } } as const satisfies Pick<Readonly<Record<string, SessionCompanionTranslations>>, "de">;

return { sessionCompanionTranslations };
})();

const Domain_sessionConversationSurfaceTranslations = (() => {
const en = Shared_sessionConversationSurfaceTranslations.en;

const de: typeof en = {
    discussion: {
        loadingTitle: 'Unterhaltung wird geöffnet…',
        offlineTitle: 'Diese Unterhaltung ist offline nicht verfügbar',
        offlineReason: 'Verbinde dich erneut, dann geht es dort weiter, wo du warst.',
        errorTitle: 'Unterhaltung konnte nicht geöffnet werden',
        lockedTitle: 'Diese Unterhaltung lässt sich auf diesem Gerät noch nicht öffnen',
        lockedReason: 'Sie ist Ende-zu-Ende-verschlüsselt, und die Verschlüsselung dieses Geräts passt nicht zu der dieser Sitzung.',
        revokedTitle: 'Du hast keinen Zugriff mehr auf diese Unterhaltung',
        revokedReason: 'Diese Sitzung wird nicht mehr mit dir geteilt. Deine Nachrichten bleiben in der Sitzung.',
        unavailableTitle: 'Unterhaltungen sind hier nicht verfügbar',
        closeTab: 'Tab schließen',
    },
    draft: {
        leadTitle: 'Einen Agenten dazu fragen',
        leadBody: 'Er läuft als eigene Unterhaltung neben der Sitzung, mit diesen Nachrichten als Kontext. Nichts startet, bevor du sendest.',
    },
    context: {
        fromConversation: ({ title, count }) => `Aus ${title} · ${count === 1 ? '1 Nachricht' : `${count} Nachrichten`}`,
        fromUntitled: ({ count }) => `Aus einer Unterhaltung · ${count === 1 ? '1 Nachricht' : `${count} Nachrichten`}`,
    },
    origin: {
        fromConversation: ({ title }) => `aus ${title}`,
        fromUntitled: 'aus einer Unterhaltung',
    },
    run: {
        details: 'Ausführungsdetails',
        loadingTitle: 'Agenten-Unterhaltung wird geöffnet…',
        errorTitle: 'Agenten-Unterhaltung konnte nicht geöffnet werden',
    },
};

const sessionConversationSurfaceTranslations = { de };

return { sessionConversationSurfaceTranslations };
})();

const Domain_sessionDirectoryRecoveryTranslations = (() => {
const en = Shared_sessionDirectoryRecoveryTranslations.en;

const sessionDirectoryRecoveryTranslations = { de: {
        title: ({ machine }) => `Der private Ordner dieses Chats ist nicht mehr auf ${machine}.`,
        body: 'Du kannst in einem neuen, leeren Ordner fortfahren. Dein Chatverlauf bleibt hier erhalten, lokale Dateien aus dem alten Ordner werden jedoch nicht wiederhergestellt.',
        continue: 'In einem neuen Ordner fortfahren', notNow: 'Nicht jetzt',
        offlineDelete: ({ machine }) => `Der private Ordner auf ${machine} wird gelöscht, sobald der Computer wieder online ist.`,
    } } satisfies Pick<Record<import('../../_all').SupportedLanguage, typeof en>, "de">;

return { sessionDirectoryRecoveryTranslations };
})();

const Domain_sessionDraftTranslations = (() => {
const en = Shared_sessionDraftTranslations.en;

const de: typeof en = {
    sectionTitle: 'Entwürfe',
    sectionTitleForHome: ({ home }) => `Entwürfe auf ${home}`,
    waitingSectionTitleForHome: ({ home }) => `Warten auf einen Computer auf ${home}`,
    badge: 'Entwurf',
    untitled: 'Entwurf ohne Titel',
    continueEditing: 'Weiter bearbeiten',
    startAnother: 'Weiteren starten',
    executionRunStart: {
        starting: 'Agentengespräch wird gestartet…',
        reconciling: 'Es wird geprüft, ob dieses Agentengespräch gestartet wurde…',
        unresolved: 'Wir konnten nicht bestätigen, ob dieses Agentengespräch gestartet wurde. Ein weiterer Start kann ein zweites Gespräch erzeugen.',
        targetChanged: 'Der Computer für diese Session hat sich geändert, bevor das Gespräch starten konnte. Es wurde nichts gestartet.',
        secretReferenceOverlayUpdateRequired: 'Geteilte Secrets in einem Agentengespräch brauchen einen aktualisierten Computer. Es wurde nichts gestartet.',
    },
    status: {
        offline: 'Offline — auf diesem Gerät gespeichert',
        syncing: 'Wird synchronisiert…',
        conflict: 'Muss geprüft werden',
        unsupported: 'Nicht synchronisiert — dieses Home kann diesen Entwurf nicht synchronisieren',
        startInterrupted: 'Start unterbrochen',
    },
    availability: {
        machineUnavailable: 'Maschine nicht verfügbar',
        pluginUnavailable: 'Plugin nicht verfügbar',
        attachmentNeedsAttention: 'Anhang braucht Aufmerksamkeit',
    },
    new: { action: 'Neue Session' },
    delete: {
        action: 'Entwurf löschen',
        confirmTitle: 'Diesen Entwurf löschen?',
        confirmDescription: 'Damit wird der Entwurf von deinen synchronisierten Geräten entfernt.',
    },
    conflict: {
        title: 'Widersprüchliche Änderungen prüfen',
        description: 'Wähle für jedes Feld die Version, die bleiben soll. Du kannst deine Geräteversion kopieren, bevor du sie ersetzt.',
        mine: 'Dieses Gerät',
        synced: 'Synchronisierte Version',
        useSynced: 'Synchronisierte verwenden',
        keepDevice: 'Dieses Gerät behalten',
        copyMine: 'Meine kopieren',
        copied: 'Kopiert',
        copyFailed: 'Dieser Wert konnte nicht kopiert werden.',
        field: {
            text: 'Nachricht',
            mentions: 'Erwähnungen',
            attachments: 'Anhänge',
            recipient: 'Empfänger',
            agentContinuation: 'Agenten-Fortsetzung',
            executionRunRequestedAction: 'Run-Zustellung',
        },
    },
};

const sessionDraftTranslations = { de };

return { sessionDraftTranslations };
})();

const Domain_sessionEmbeddedTranslations = (() => {
const en = Shared_sessionEmbeddedTranslations.en;

const translated = Shared_sessionEmbeddedTranslations.translated;

const sessionEmbeddedTranslations = { de: translated({
        unavailable: 'Diese Sitzung ist nicht verfügbar',
        respondInSession: 'Öffne die Sitzung, um zu antworten.',
        regionLabel: ({ title }) => `Sitzung: ${title}`,
        newChatWelcome: 'Woran arbeiten wir?',
    }) } as const;

return { sessionEmbeddedTranslations };
})();

const Domain_sessionFollowTranslations = (() => {
type SessionFollowTranslations = Shared_sessionFollowTranslations.SessionFollowTranslations;

const en = Shared_sessionFollowTranslations.en;

const sessionFollowTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionFollowTranslations
>, "de"> = { 'de': {
        "notificationBody": {"message":"Neue Nachricht in dieser Sitzung.","failed":"Der Durchlauf ist fehlgeschlagen.","cancelled":"Der Durchlauf wurde abgebrochen.","sourceUnavailable":"Die Quelle dieser Sitzung ist nicht verfügbar."},
        "follow": "Folgen",
        "unfollow": "Nicht mehr folgen",
        "following": "Gefolgt",
        "notifications": "Benachrichtigungen",
        "unavailableTitle": "Folgen ist nicht verfügbar",
        "unavailableDescription": "Dieses Home bietet kein Session-Following an.",
        "unreachableTitle": "Dieses Home ist nicht erreichbar",
        "unreachableDescription": "Happier konnte nicht prüfen, ob dieses Home Session-Following anbietet. Versuche es erneut, sobald es erreichbar ist.",
        "editor": {
            "title": "Dieser Sitzung folgen",
            "subtitle": "Erhalte die Updates, die dir wichtig sind.",
            "ownerSubtitle": "Dir gehört diese Sitzung, daher erreichen dich ihre Updates immer.",
            "externalAttachedOnly": "Die Hintergrundsynchronisierung ist aus, daher kommen Updates möglicherweise nur an, während diese Sitzung verbunden ist."
        },
        "level": {
            "none": "Keine Benachrichtigungen",
            "important": "Wichtige Updates",
            "all_messages": "Jede neue Nachricht"
        },
        "voice": {
            "title": "In Voice einbeziehen",
            "subtitle": "Voice kann diese Sitzung im Kontext behalten.",
            "waitingRuntime": "Warte auf die Verbindung mit Voice.",
            "unsupported": "Diese Laufzeit unterstützt gefolgte Sitzungen in Voice nicht.",
            "providerWithheld": "Dieser Voice-Modus kann keine gespeicherten Sitzungsupdates einbeziehen.",
            "waitingEncrypted": "Entsperre diese Sitzung, um sie in Voice einzubeziehen.",
            "initialSnapshotPending": "Beim nächsten Voice-Beitrag eine kurze Zusammenfassung des aktuellen Stands einbeziehen."
        },
        "footer": "Folgen ändert niemals, wer auf diese Sitzung zugreifen kann.",
        "settingsLink": "Benachrichtigungseinstellungen…",
        "assignedExplanation": "Du folgst, weil dir die Sitzung zugewiesen wurde",
        "assignedNotice": "Dir wurde eine Sitzung zugewiesen.",
        "sharedNotice": "Eine Sitzung wurde mit dir geteilt.",
        "wakeEventExplanation": "Der verfolgte Kontext hat sich geändert, deshalb hat Happier diesen Agenten mit der Aktualisierung geweckt.",
        "accessLost": "Du hast keinen Zugriff mehr auf diese Sitzung.",
        "offline": "Du bist offline. Verbinde dich erneut, um das Folgen zu ändern.",
        "archived": "Das Folgen ist pausiert, solange diese Sitzung archiviert ist.",
        "sources": {
            "title": "Session-Updates",
            "waitingRuntime": "Warten auf die erneute Verbindung der Ziel-Session.",
            "unsupported": "Aktualisiere die CLI auf dem Zielrechner oder verbinde sie neu, um Updates zu empfangen.",
            "pausedArchived": "Updates sind pausiert, solange die Quelle oder das Ziel archiviert ist.",
            "add": "In einer anderen Sitzung folgen…",
            "addSource": "Updates aus einer anderen Sitzung senden…",
            "chooseDestinationTitle": "In einer anderen Sitzung folgen",
            "chooseSourceTitle": "Updates aus einer anderen Sitzung senden",
            "row": ({ title }) => `Updates von „${title}“`,
            "nextTurn": "Nächster Zug",
            "wakeOnHumanChange": "Aufwecken, wenn eine Person eine Nachricht hinzufügt",
            "stop": "Updates stoppen",
            "stopForSource": ({ title }) => `Updates von „${title}“ stoppen`,
            "includeNextTurn": "Aktualisierungen beim nächsten Zug des Ziels einbeziehen.",
            "sourceKeyPreparing": "Verschlüsselten Zugriff vorbereiten…",
            "sourceKeyWaiting": "Warten auf verschlüsselten Zugriff.",
            "sourceKeyUnavailable": "Dieser Computer kann keinen verschlüsselten Zugriff bereitstellen.",
            "sourceSessionKeyUnavailable": "Der verschlüsselte Zugriff dieser Session ist hier nicht verfügbar.",
            "catchUpPending": "Nachholen ausstehend"
        },
        "preferences": {
            "title": "Automatisch folgen",
            "assigned": "Mir zugewiesene Sitzungen",
            "direct": "Direkt geteilte Sitzungen",
            "team": "Über Teams geteilte Sitzungen",
            "group": "Über Gruppen geteilte Sitzungen",
            "help": "Gilt für neue Zuweisungen und neu zugängliche Sitzungen. Bestehende Einstellungen bleiben unverändert."
        }
    } };

return { sessionFollowTranslations };
})();

const Domain_sessionGitBranchesTranslations = (() => {
type SessionGitBranchesTranslations = Shared_sessionGitBranchesTranslations.SessionGitBranchesTranslations;

const en = Shared_sessionGitBranchesTranslations.en;

const de: SessionGitBranchesTranslations = {
    openA11y: ({ branch }) => `Branch ${branch}: Branch wechseln oder Zurückgelegtes ansehen`,
    searchPlaceholder: 'Branch wechseln oder erstellen',
    category: { current: 'Aktuell', branches: 'Branches', remote: 'Remote-Branches', keptAside: 'Zurückgelegt', worktrees: 'Worktrees', start: 'Etwas Neues beginnen' },
    tracks: ({ upstream }) => `folgt ${upstream}`,
    onlyHere: 'nur auf diesem Rechner',
    changed: ({ count }) => `${count} geändert`,
    ahead: ({ count }) => `${count} zu pushen`,
    keptAsideWhen: ({ origin, when }) => `${origin} · ${when}`,
    newBranch: ({ branch }) => `Neuer Branch von ${branch}…`,
    newBranchDetached: 'Neuer Branch…',
    newBranchSubtitle: 'Gib seinen Namen ins Suchfeld ein',
    newWorktree: 'Neuer Worktree…',
    newWorktreeSubtitle: 'In einer neuen Sitzung an einem anderen Branch arbeiten',
    keepAside: 'Änderungen zurücklegen',
    keepAsideSubtitle: ({ count }) => `${count} Änderungen weglegen und sauber beginnen`,
    keepAsideNothing: 'Keine Änderungen zum Zurücklegen',
    keepAsideFailed: 'Die Änderungen konnten nicht zurückgelegt werden.',
    loadFailed: 'Branches konnten nicht geladen werden',
    notice: {
        title: ({ branch }) => `Du hast Änderungen auf ${branch} zurückgelegt`,
        reason: ({ when }) => `Zurückgelegt ${when}. Hol sie zurück, um weiterzuarbeiten.`,
        reasonUndated: 'Hol sie zurück, um weiterzuarbeiten.',
        restore: 'Änderungen wiederherstellen',
        lookFirst: 'Erst ansehen',
        dismiss: 'Nicht jetzt',
        restoreFailed: 'Die Änderungen konnten nicht wiederhergestellt werden.',
    },
};

const sessionGitBranchesTranslations = { de };

return { sessionGitBranchesTranslations };
})();

const Domain_sessionGitDisplayTranslations = (() => {
const en = Shared_sessionGitDisplayTranslations.en;

const de: typeof en = {
    settingsLayout: 'Layout des Git-Bereichs',
    settingsShowAs: 'Geänderte Dateien anzeigen als',
    trigger: 'Anzeigeoptionen',
    paneGroup: 'Bereich',
    changesGroup: 'Änderungen',
    layout: 'Layout',
    layoutUnified: 'Vereint',
    layoutTabs: 'Tabs',
    layoutDescription: 'Eine Ansicht von den Änderungen bis zum Verlauf, oder Änderungen und Verlauf als zwei Ansichten.',
    showAs: 'Anzeigen als',
    showAsList: 'Liste',
    showAsTree: 'Baum',
    showAsDescription: 'Geänderte Dateien als Liste, oder nach Ordnern gruppiert, um ganze Ordner auf einmal zu wählen.',
    density: 'Dichte',
    densityDefault: 'Standard',
    densityCompact: 'Kompakt',
    note: 'Baumzeilen sind immer kompakt. Wird für dein Konto gespeichert.',
    selectFolder: ({ folder }) => `Alle Änderungen in ${folder} auswählen`,
    selectFile: ({ file }) => `${file} für den nächsten Commit auswählen`,
};

const sessionGitDisplayTranslations = { de };

return { sessionGitDisplayTranslations };
})();

const Domain_sessionGitPaneTranslations = (() => {
const en = Shared_sessionGitPaneTranslations.en;

const fidelity = Shared_sessionGitPaneTranslations.fidelity;

const withFidelity = Shared_sessionGitPaneTranslations.withFidelity;

const de: typeof en = {
    scope: { allChanges: 'Alle Änderungen' },
    subTabs: { changes: 'Änderungen', sync: 'Sync', history: 'Verlauf' },
    header: {
        changed: ({ count }) => `${count} geändert`,
        toPush: ({ count }) => `${count} zu pushen`,
        toPull: ({ count }) => `${count} zu pullen`,
        push: ({ count }) => `${count} pushen`,
        pull: ({ count }) => `${count} pullen`,
        publish: 'Veröffentlichen',
        folderOnMachine: ({ folder, machine }) => `${folder} auf ${machine}`,
    },
    groups: {
        session: 'In dieser Sitzung geändert',
        elsewhere: ({ repo }) => `Sonst in ${repo}`,
        elsewhereUnnamed: 'Sonst in diesem Repository',
        selectGroup: ({ group }) => `Alle Dateien in „${group}“ auswählen`,
    },
    row: { renamedFrom: ({ path }) => `vorher ${path}` },
    commit: {
        toBranch: ({ branch }) => `Nach ${branch} committen`,
        selection: ({ count }) => (count === 1 ? '1 Datei' : `${count} Dateien`),
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
            dirtyTitle: ({ count, formatted }) => (count === 1 ? `Du hast 1 nicht committete Änderung` : `Du hast ${formatted} nicht committete Änderungen`),
            dirtyBody: 'Ein Pull könnte sie berühren. Lege sie während des Pulls beiseite (sie kommen gleich zurück) oder lass Git nur pullen, wenn sich nichts überschneidet.',
            keepAsideAndPull: 'Beiseitelegen und pullen',
            pullIfNoOverlap: 'Pullen, wenn nichts überlappt',
            divergedPullBody: 'Dein Branch und origin haben sich beide bewegt. Setze deine Commits auf die von origin oder führe beide zusammen.',
            divergedPushBody: 'Hol zuerst die Commits von origin (deine obendrauf oder zusammenführen) und pushe dann erneut. Deine Commits bleiben auf diesem Gerät.',
            rebase: 'Auf origin rebasen',
            merge: 'origin einmergen',
        },
        writesOff: {
            title: 'Committen aus Happier ist ausgeschaltet',
            body: 'Du kannst jede Änderung lesen und prüfen. Schalte die Operationen der Versionsverwaltung ein, um hier zu committen, zu pushen und zu pullen.',
            turnOn: 'Einschalten',
        },
        header: {
            noChanges: 'keine Änderungen',
        },
        action: {
            fetch: 'Abrufen',
            publish: 'Branch veröffentlichen',
            createPr: 'PR erstellen',
            openPr: ({ number }) => `#${number}`,
            resolve: ({ count }) => `${count} lösen`,
            upToDate: 'Aktuell',
            pushing: ({ count }) => `Pusht ${count}…`,
            pulling: ({ count }) => `Pullt ${count}…`,
            fetching: 'Ruft ab…',
            publishing: 'Veröffentlicht…',
            creatingPr: 'Wird erstellt…',
        },
        menu: {
            open: 'Weitere Sync-Aktionen',
            push: 'Push',
            pull: 'Pull',
            pushTo: ({ target }) => `nach ${target}`,
            pullFrom: ({ target }) => `von ${target}`,
            nothingToPush: 'Nichts zu pushen',
            upToDate: 'Aktuell',
            fetchHint: 'Origin auf neue Commits prüfen',
            publishHint: 'Diesen Branch auf origin bringen',
            createPr: 'Pull Request erstellen…',
            createPrInto: ({ base }) => `nach ${base}`,
            unavailable: 'Hier nicht verfügbar',
            more: 'Mehr',
        },
        running: {
            branchSwitch: 'Branch wird gewechselt…',
            branchCreate: 'Branch wird erstellt…',
            stashCreate: 'Änderungen werden beiseitegelegt…',
            discard: 'Änderungen werden verworfen…',
            revert: 'Commit wird zurückgenommen…',
            generic: 'Wird ausgeführt…',
        },
        done: {
            untouched: ({ count, formatted }) => (count === 1 ? `deine nicht committete Änderung ist unberührt` : `deine ${formatted} nicht committeten Änderungen sind unberührt`),
            commit: 'Committet',
            commitFiles: ({ count, formatted }) => (count === 1 ? `1 Datei committet` : `${formatted} Dateien committet`),
            push: 'Gepusht',
            pushCommits: ({ count, formatted }) => (count === 1 ? `1 Commit gepusht` : `${formatted} Commits gepusht`),
            upToDate: ({ target }) => `${target} ist aktuell`,
            pull: 'Gepullt',
            pullCommits: ({ count, formatted }) => (count === 1 ? `1 Commit gepullt` : `${formatted} Commits gepullt`),
            fetch: ({ target }) => `${target} auf neue Commits geprüft`,
            branchSwitch: 'Branch gewechselt',
            branchCreate: 'Branch erstellt',
            stashCreate: 'Änderungen beiseitegelegt',
            discard: 'Änderungen verworfen',
            revert: 'Commit zurückgenommen',
            pullRequest: 'Pull Request bereit',
            generic: 'Erledigt',
        },
        failed: {
            unknownTitle: 'Wir konnten nicht bestätigen, wie das ausging',
            unknownBody: 'Das Gerät hat nicht mehr geantwortet, bevor Git sich meldete. Prüfe erneut, um zu sehen, was passiert ist.',
            origin: 'origin',
            thisMachine: 'dieses Gerät',
            refreshTitle: 'Committet, aber die Liste wurde nicht aktualisiert',
            refreshBody: 'Dein Commit ist sicher. Versuche es erneut, um die aktuellen Änderungen zu sehen.',
            rejectedTitle: ({ target }) => `${target} hat Commits, die dir fehlen`,
            rejectedBody: 'Rufe sie ab, um zu sehen, was sich geändert hat. Deine Commits bleiben auf diesem Gerät, bis du erneut pushst.',
            authTitle: ({ machine, provider }) => `${provider} hat die Anmeldung von ${machine} nicht akzeptiert`,
            authBody: ({ machine }) => `Git auf ${machine} hat keine gültigen Zugangsdaten für dieses Remote. Melde dich dort an und versuche es erneut.`,
            offlineTitle: ({ machine }) => `${machine} ist offline`,
            offlineBody: 'Dort kann gerade nichts laufen. Deine Arbeit ist auf diesem Gerät sicher.',
            conflictTitle: 'Wegen widersprüchlicher Änderungen angehalten',
            conflictBody: 'Einige Dateien wurden auf beiden Seiten geändert. Löse sie und fahre dann fort.',
            networkTitle: ({ target }) => `${target} nicht erreichbar`,
            networkBody: 'Das Gerät konnte keine Verbindung zum Remote herstellen. Prüfe das Netzwerk und versuche es erneut.',
            commitTitle: 'Der Commit ist fehlgeschlagen',
            pushTitle: 'Der Push ist fehlgeschlagen',
            pullTitle: 'Der Pull ist fehlgeschlagen',
            fetchTitle: 'Neue Commits konnten nicht geprüft werden',
            pullRequestTitle: 'Der Pull Request wurde nicht erstellt',
            genericTitle: 'Das hat nicht geklappt',
        },
        recover: {
            open: 'Öffnen',
            tryAgain: 'Erneut versuchen',
            fetch: 'Abrufen',
            checkAgain: 'Erneut prüfen',
            showConflicts: 'Konflikte zeigen',
        },
        timeline: {
            title: 'Zeitleiste',
            now: 'Jetzt',
            loading: 'Verlauf wird gelesen…',
            uncommitted: ({ count, formatted }) => (count === 1 ? `1 Änderung nicht committet` : `${formatted} Änderungen nicht committet`),
            selected: ({ count, formatted }) => (count === 1 ? `1 für den nächsten Commit ausgewählt` : `${formatted} für den nächsten Commit ausgewählt`),
            nothingSelected: 'Nichts ausgewählt',
            earlierToday: 'Früher heute',
            yesterday: 'Gestern',
            older: 'Älter',
            justNow: 'gerade eben',
            toPull: 'zu pullen',
            originFurther: ({ name }) => `${name} liegt weiter zurück`,
            originA11y: ({ name }) => `${name} ist hier`,
        },
        clean: {
            titleUpToDate: 'Alles ist committet und gepusht',
            titleCommitted: 'Alles ist committet',
            bodyUpToDate: ({ branch, upstream }) => `${branch} entspricht ${upstream}. Neue Änderungen dieser Sitzung erscheinen hier.`,
            body: 'Neue Änderungen dieser Sitzung erscheinen hier.',
            createPullRequest: 'Pull Request erstellen',
            openPullRequest: ({ number }) => `Pull Request #${number} öffnen`,
            lastCommit: ({ when }) => `Letzter Commit ${when}`,
        },
        conflicts: {
            skip: 'Diesen Commit überspringen',
            askAgentTask: ({ files, operation }) => `Löse die Konflikte des ${operation} in ${files}. Bewahre die Absicht beider Seiten, bearbeite und stage die gelösten Dateien und halte dann für meine Prüfung an. Nicht fortsetzen, abbrechen, committen oder pushen und keine Seite pauschal übernehmen.`,
            revert: 'Revert',
            cherryPick: 'Cherry-Pick',
            merge: 'Merge',
            rebase: 'Rebase',
            stopped: ({ count, formatted, operation }) => (count === 1 ? `Der ${operation} wurde angehalten: 1 Datei wurde auf beiden Seiten geändert` : `Der ${operation} wurde angehalten: ${formatted} Dateien wurden auf beiden Seiten geändert`),
            readyToContinue: ({ operation }) => `Alle Konflikte sind gelöst. Setze den ${operation} fort.`,
            filesInConflict: ({ count, formatted }) => (count === 1 ? `1 Datei hat einen Konflikt` : `${formatted} Dateien haben Konflikte`),
            body: 'Öffne jede Datei unter „Braucht dich“ oder bitte den Agenten, sie zu lösen.',
            continueBody: 'Nichts wird committet, bis du fortfährst.',
            askAgent: 'Agenten lösen lassen',
            continue: ({ operation }) => `${operation} fortsetzen`,
            abort: ({ operation }) => `${operation} abbrechen`,
            abortTitle: ({ operation }) => `${operation} abbrechen?`,
            abortBody: 'Der Branch kehrt zum Stand vor dem Start zurück. Bisherige Auflösungen gehen verloren.',
            needsYou: 'Braucht dich',
            mergedCleanly: 'Sauber zusammengeführt',
        },
        commit: {
            selectFirst: 'Dateien zum Committen auswählen',
        },
        tools: {
            title: 'Remotes und Merges',
            subtitle: 'Remote hinzufügen, Branch mergen oder rebasen',
        },
    },
    paused: { reason: 'die Sitzung ist pausiert', resume: 'Fortsetzen' },
    notRepository: {
        title: 'Verfolge, was Agents hier ändern',
        body: ({ folder }) => `${folder} ist noch kein Repository. Lege eins an, um jede Änderung zu prüfen, zu committen und rückgängig zu machen.`,
        bodyUnnamed: 'Dieser Ordner ist noch kein Repository. Lege eins an, um jede Änderung zu prüfen, zu committen und rückgängig zu machen.',
    },
};

const sessionGitPaneTranslations = { de: withFidelity(de) };

return { sessionGitPaneTranslations };
})();

const Domain_sessionGitPullRequestTranslations = (() => {
type ProviderArgs = Shared_sessionGitPullRequestTranslations.ProviderArgs;

type GitPullRequestCopy = Shared_sessionGitPullRequestTranslations.GitPullRequestCopy;

const en = Shared_sessionGitPullRequestTranslations.en;

const de: GitPullRequestCopy = {
    form: {
        title: 'Neuer Pull Request', expand: 'In einem Detailbereich öffnen', moveBack: 'Zurück in die Seitenleiste',
        close: 'Formular schließen (der Entwurf bleibt erhalten)', base: 'Wird gemergt in', titlePlaceholder: 'Titel',
        bodyPlaceholder: 'Was sich geändert hat und warum', draft: 'Entwurf', create: 'Pull Request erstellen', creating: 'Wird erstellt…',
        continueOn: ({ provider }) => `Weiter auf ${provider}`, pointer: 'Der neue Pull Request ist in Details geöffnet', pointerShow: 'Zeigen',
        openedProviderPage: ({ provider }) => `${provider} ist zum Abschließen geöffnet; dein Text bleibt hier erhalten.`,
    },
    failure: {
        authFailed: ({ provider }) => `${provider} hat die Anmeldung dieses Rechners nicht akzeptiert`,
        network: ({ provider }) => `${provider} war nicht erreichbar`,
        machineOffline: 'Der Rechner ist offline; dein Entwurf bleibt erhalten',
        blocked: 'Ein anderer Git-Vorgang läuft; versuche es danach erneut',
        other: 'Der Pull Request wurde nicht erstellt',
    },
    card: {
        number: ({ number }) => `#${number}`, intoBase: ({ base }) => `in ${base}`,
        state: { open: 'Offen', draft: 'Entwurf', merged: 'Gemergt', closed: 'Geschlossen', unknown: 'Pull Request' },
        checks: { pending: 'Checks laufen', success: 'Checks bestanden', failure: 'Checks fehlgeschlagen', unknown: 'Checks' },
        openOn: ({ provider }) => `Auf ${provider} öffnen`, copyLink: 'Link kopieren', copied: 'Link kopiert',
    },
    settings: {
        placementTitle: 'Neue Pull Requests öffnen in', placementDescription: 'Auf einem Telefon öffnet sich das Formular immer als eigene Seite.',
        sidebar: 'Seitenleiste', details: 'Detailbereich',
    },
};

const sessionGitPullRequestTranslations = { de };

return { sessionGitPullRequestTranslations };
})();

const Domain_sessionHomeFreshnessTranslations = (() => {
const en = Shared_sessionHomeFreshnessTranslations.en;

const translated = Shared_sessionHomeFreshnessTranslations.translated;

const sessionHomeFreshnessTranslations = { de: translated({
        offline: 'Offline',
        stale: 'Aktualisierung fehlgeschlagen',
        lastUpdated: ({ ago }) => `Zuletzt aktualisiert vor ${ago}`,
    }) };

return { sessionHomeFreshnessTranslations };
})();

const Domain_sessionListFilterTranslations = (() => {
const en = Shared_sessionListFilterTranslations.en;

const translated = Shared_sessionListFilterTranslations.translated;

const sessionListFilterTranslations = { de: translated({
        filtersTitle: 'Session-Filter', filtersSearch: 'Filter durchsuchen…', filtersShow: 'Anzeigen',
        filtersScope: 'Bereich', filtersShowSessions: 'Sessions', filtersShowRuns: 'Läufe', filtersShowBoth: 'Beides',
        filtersShowBothSummary: 'Sessions und Läufe', filtersStartedByNone: 'Keine Starter ausgewählt',
        filtersStartedBy: 'Gestartet von', filtersStartedByYou: 'Dir', filtersStartedByTriggers: 'Triggern', filtersStartedByAgents: 'Agenten',
        filtersRunsNeedingYouAlwaysShow: 'Läufe, die dich brauchen, werden immer angezeigt',
        filtersMyWork: 'Meine Arbeit', filtersLegacyOwnerDirect: 'Meine Arbeit', filtersAssignedToMe: 'Mir zugewiesen', filtersFollowing: 'Gefolgt',
        filtersInvolvingMe: 'Mit meiner Beteiligung', filtersAllAccessible: 'Alle zugänglichen', filtersAttention: 'Aufmerksamkeit',
        filtersAttentionAny: 'Alle', filtersAttentionNeedsMe: 'Nur Sessions, die mich brauchen', filtersScopeNeedsMe: 'Braucht mich',
        filtersInactive: 'Inaktive Sessions', filtersInactiveShow: 'Anzeigen', filtersInactiveHide: 'Ausblenden',
        filtersHomes: 'Homes', filtersSharedWith: 'Geteilt mit', filtersOutsideTeams: 'Persönlich & direkt',
        filtersTags: 'Tags', filtersSource: 'Quelle', filtersSourceAll: 'Alle',
        filtersSourceDirect: 'Extern',
        filtersNoOptions: 'Keine Filter verfügbar', filtersClear: 'Filter zurücksetzen', filtersDone: 'Fertig', filtersArchived: 'Archiviert',
        filtersNeedsMeOnly: 'Nur was mich braucht', filtersNeedsMeOnlyDescription: 'Sessions, die auf dich warten', filtersSourceHappier: 'Happier',
        filtersMoreTags: ({ count }: { count: number }) => `+ ${count} weitere`,
        filtersResultCount: ({ count }: { count: number }) => count === 1 ? `1 Element` : `${count} Elemente`,
        queryInitialLoadingTitle: 'Sessions werden geladen…', queryUpdatingTitle: 'Sessions werden aktualisiert…',
        querySomeHomesUnavailableTitle: 'Einige Homes sind nicht verfügbar', querySomeHomesUnavailableDescription: 'Happier zeigt erreichbare Sessions. Versuche es erneut, sobald die Homes wieder online sind.',
        queryRefreshFailedTitle: 'Aktualisierung fehlgeschlagen', queryRefreshFailedRetainedDescription: 'Deine geladenen Sessions bleiben sichtbar. Versuche erneut, nach Aktualisierungen zu suchen.', queryRefreshFailedEmptyDescription: 'Happier konnte keine Sessions von den ausgewählten Homes laden. Versuche es erneut, wenn sie erreichbar sind.',
        queryNoMatchesLoadedTitle: 'Keine Treffer in geladenen Sessions', queryNoMatchesLoadedDescription: 'Auf einer älteren Seite können weitere passende Sessions verfügbar sein.', querySearchOlder: 'Ältere Sessions durchsuchen',
        queryMoreAvailableTitle: 'Weitere Sessions sind möglicherweise verfügbar', queryMoreAvailableDescription: 'Diese Ansicht enthält geladene Sessions. Suche in älteren Sessions, um fortzufahren.',
        queryNoMatchesTitle: 'Keine Session passt', queryNoMatchesDescription: 'Ändere die aktiven Filter.',
        queryTeamEmptyTitle: 'Dieses Team hat keine Sessions', queryTeamEmptyDescription: 'Mit diesem Team geteilte Sessions erscheinen hier.',
        queryMyWorkEmptyTitle: 'Nichts in Meine Arbeit', queryScopeEmptyDescription: 'Versuche einen breiteren Bereich oder schau später wieder vorbei.', queryBrowseAllAccessible: 'Alle Sessions anzeigen',
        queryAssignedEmptyTitle: 'Dir sind keine Sessions zugewiesen', queryFollowingEmptyTitle: 'Keine gefolgten Sessions', queryInvolvingEmptyTitle: 'Keine Sessions mit deiner Beteiligung',
        queryAttentionEmptyTitle: 'Keine Session braucht deine Aufmerksamkeit', queryReachableEmptyTitle: 'Keine Sessions verfügbar', queryReachableEmptyDescription: 'In den erreichbaren Homes passt keine Session zu dieser Ansicht.',
        queryHistoricalSharesWithheldTitle: 'Einige geteilte Sessions sind ausgeblendet', queryHistoricalSharesWithheldDescription: 'Mit dir geteilte Sessions aus einer früheren Happier-Version bleiben ausgeblendet, bis ihr Eigentümer sie in Happier aktualisiert.',
        partialHomeNotMountedTitle: ({ home }) => `${home} ist in dieser Sessions-Ansicht nicht enthalten`,
        partialHomeNotMountedDescription: 'Füge dieses Home einer sichtbaren Home-Gruppe hinzu, um die Sessions des Teams anzuzeigen, ohne den Fokus zu ändern.',
        partialShowFromHome: ({ home }) => `Sessions von ${home} anzeigen`,
        teamListingUnavailableTitle: 'Team-Sessions sind auf diesem Home nicht verfügbar',
        teamListingUnavailableDescription: 'Dieses Home kann Team-Sessions noch nicht auflisten. Aktualisiere oder konfiguriere das Home neu und versuche es erneut.',
        teamListingLoadingTitle: ({ team }) => `${team}-Sessions werden geladen…`,
        teamListingLoadingDescription: 'Happier prüft, was dieses Home auflisten kann.',
        teamListingProbeFailedTitle: 'Dieses Home ist nicht erreichbar',
        teamListingProbeFailedDescription: 'Happier konnte dieses Home nicht nach Team-Sessions fragen. Versuche es erneut, sobald es erreichbar ist.',
    }) };

return { sessionListFilterTranslations };
})();

const Domain_sessionMessageAccountActorTranslations = (() => {
type AccountActorTranslations = Shared_sessionMessageAccountActorTranslations.AccountActorTranslations;

const sessionMessageAccountActorTranslations: Pick<Record<SupportedLanguage, AccountActorTranslations>, "de"> = { de: { accountActorYou: 'Du', accountActorFormerMember: 'Ehemaliges Mitglied', accountActorUnnamedMember: 'Happier-Mitglied', accountActorSentBy: ({ name }) => `Gesendet von ${name}` } };

return { sessionMessageAccountActorTranslations };
})();

const Domain_sessionPageTranslations = (() => {
const english = Shared_sessionPageTranslations.english;

const translated = Shared_sessionPageTranslations.translated;

const sessionPageTranslations = { de: translated({
        sessionPages: {
            info: {
                continueTitle: 'Fortsetzen',
                continueDescription: 'Starte neue Arbeit vom aktuellen Stand dieser Sitzung.',
                organizeTitle: 'Organisieren',
                organizeDescription: 'Wo diese Sitzung in deinen Listen erscheint.',
                activityDescription: 'Was der Agent gerade tut und ob du davon erfährst.',
                detailsTitle: 'Details',
                detailsDescription: 'Kennungen und Verlauf, für Support und Skripte.',
                environmentTitle: 'Umgebung',
                environmentDescription: 'Die Maschine, der Ordner und der Agent dieser Sitzung.',
                agentStateDescription: 'Wer den Agenten steuert und worauf er wartet.',
                relatedTitle: 'Verwandt',
                relatedDescription: 'Weitere Seiten zu dieser Sitzung.',
                developerTitle: 'Entwickler',
                developerDescription: 'Rohdaten zur Fehlersuche, im Entwicklermodus sichtbar.',
                leaveLabel: 'Stoppen, archivieren oder löschen',
                leaveFootnote: 'Stoppen beendet den laufenden Prozess. Archivierte Sitzungen lassen sich wiederherstellen. Löschen entfernt die Sitzung und ihre Nachrichten endgültig.',
            },
            follow: {
                description: 'Lege fest, ob diese Sitzung dich benachrichtigt und per Sprache spricht.',
            },
            permissions: {
                description: 'Werkzeuge, die du von einem anderen Gerät für diese Sitzung erlaubt hast. Widerrufe, was du nicht mehr möchtest.',
            },
            automations: {
                description: 'Arbeit, die in dieser Sitzung nach Zeitplan, bei einem Ereignis oder nach einem Zug läuft.',
            },
            newRun: {
                description: 'Starte aus dieser Sitzung einen Lauf eines Sub-Agenten.',
                transcriptReadOnly: 'Dies ist ein gespeicherter Verlauf. Verbinde dich erneut mit diesem Home, um die Unterhaltung fortzusetzen.',
                daemonReadOnly: 'Dieser Verlauf stammt aus dem Agent-Prozess. Verbinde dich erneut mit diesem Home, um die Unterhaltung fortzusetzen.',
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
>, "de"> = { de: {
        due: 'Erinnerung fällig',
        title: 'Erinnere mich', inOneHour: 'In 1 Stunde', inThreeHours: 'In 3 Stunden',
        tomorrowMorning: 'Morgen früh', nextWeek: 'Nächste Woche', custom: 'Datum und Uhrzeit wählen…',
        customTitle: 'Datum und Uhrzeit wählen',
        customPlaceholder: '2026-09-08 09:00', futureTimeRequired: 'Wähle einen Zeitpunkt in der Zukunft.',
        setReminder: 'Erinnerung festlegen',
        reminderSaved: 'Erinnerung gespeichert',
        presetSaveFailedAfterReminder: 'Die Erinnerung ist gespeichert, das Speichern der Vorlage wurde jedoch nicht bestätigt. Versuche es erneut oder schließe das Fenster.',
        presetsSaveFailed: 'Das Speichern der Vorlagen wurde nicht bestätigt. Deine Änderungen bleiben hier erhalten; versuche es erneut.',
        presetsChanged: 'Die gespeicherten Vorlagen unterscheiden sich von der geöffneten Liste. Schließe und öffne sie erneut, um die aktuelle Liste zu prüfen.',
        remove: 'Erinnerung entfernen',
        dateLabel: 'Datum', timeLabel: 'Uhrzeit', addToPresets: 'Zu Vorlagen hinzufügen', presetPreviewUnavailable: 'Wähle eine gültige zukünftige Zeit für die Vorschau.', managePresets: 'Vorlagen verwalten', managePresetsMessage: 'Gespeicherte Erinnerungen umbenennen, sortieren oder entfernen.', presetName: 'Vorlagenname', movePresetUp: 'Nach oben', movePresetDown: 'Nach unten', renamePresetLabel: ({ preset }) => `„${preset}“ umbenennen`, movePresetUpLabel: ({ preset }) => `„${preset}“ nach oben verschieben`, movePresetDownLabel: ({ preset }) => `„${preset}“ nach unten verschieben`, deletePresetLabel: ({ preset }) => `„${preset}“ löschen`, noPresets: 'Keine gespeicherten Vorlagen', noPresetsMessage: 'Speichere beim nächsten benutzerdefinierten Termin eine Vorlage.',
    } };

return { sessionReminderTranslations };
})();

const Domain_sessionRemotePermissionGrantTranslations = (() => {
type SessionRemotePermissionGrantTranslations = Shared_sessionRemotePermissionGrantTranslations.SessionRemotePermissionGrantTranslations;

const sessionRemotePermissionGrantTranslations = { de: {
        title: 'Erteilte Remote-Berechtigungen',
        entryTitle: 'Erteilte Remote-Berechtigungen',
        entrySubtitle: 'Session-bezogene Remote-Freigaben prüfen und widerrufen',
        loadingTitle: 'Erteilte Remote-Berechtigungen werden geladen',
        loadingReason: 'Die Freigaben der aktuellen Session-Besitzerin bzw. des -Besitzers werden geprüft.',
        emptyTitle: 'Keine erteilten Remote-Berechtigungen',
        emptyReason: 'Diese Session hat keine Remote-Freigaben zum Prüfen.',
        unavailableTitle: 'Erteilte Remote-Berechtigungen nicht verfügbar',
        unavailableReason: 'Prüf, ob das die aktuelle Session-Besitzerin bzw. der -Besitzer ist und ob ihr Rechner verfügbar ist, und versuch es dann noch einmal.',
        ownerOnlyTitle: 'Nur die Session-Besitzerin bzw. der -Besitzer kann Remote-Freigaben verwalten',
        ownerOnlyReason: 'Geteilte Teilnehmende können auf passende Abfragen antworten, aber die Freigaben der Besitzerin bzw. des Besitzers weder prüfen noch widerrufen.',
        retry: 'Erneut versuchen',
        listTitle: 'Session-Freigaben',
        grantActive: ({ actor }) => `Aktive Freigabe von ${actor}`,
        grantRevoked: ({ actor }) => `Widerrufene Freigabe von ${actor}`,
        grantDetail: ({ grantId, sourceRef, sourceRevisionOrEpoch }) => `Freigabe ${grantId} · Quelle ${sourceRef} (${sourceRevisionOrEpoch})`,
        revoke: 'Freigabe widerrufen',
        revoking: 'Wird widerrufen…',
        revokeConfirmTitle: 'Erteilte Remote-Berechtigung widerrufen?',
        revokeConfirmBody: ({ identifier }) => `Damit wird die Remote-Freigabe sofort widerrufen für ${identifier}.`,
        revokeFailedTitle: 'Die erteilten Remote-Berechtigungen ließen sich nicht ändern',
        revokeFailedReason: 'Die Freigabe hat sich womöglich geändert oder der Rechner der Besitzerin bzw. des Besitzers ist nicht verfügbar. Versuch es noch einmal.',
        loadMore: 'Mehr Freigaben laden',
        loadingMore: 'Weitere Freigaben werden geladen…',
        loadMoreFailedReason: 'Weitere Freigaben ließen sich nicht laden. Versuch es noch einmal.',
    } } as const satisfies Pick<Readonly<Record<string, SessionRemotePermissionGrantTranslations>>, "de">;

return { sessionRemotePermissionGrantTranslations };
})();

const Domain_sessionResponsibilityTranslations = (() => {
type SessionResponsibilityTranslations = Shared_sessionResponsibilityTranslations.SessionResponsibilityTranslations;

const en = Shared_sessionResponsibilityTranslations.en;

const sessionResponsibilityTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionResponsibilityTranslations
>, "de"> = { de: {
        responsibilitySectionTitle: 'Verantwortung',
        responsibilityRowTitle: 'Verantwortlich',
        responsibilityNoOne: 'Niemand',
        responsibilityUnnamedPerson: 'Person ohne Namen',
        responsibilityPickerTitle: 'Verantwortliche Person wählen',
        responsibilitySearchPlaceholder: 'Personen mit Zugriff suchen',
        responsibilityAssignToMe: 'Mir zuweisen',
        responsibilityPeopleWithAccess: 'Personen mit Zugriff',
        responsibilityAccessHintOwner: 'Eigentümer',
        responsibilityNoCandidates: 'Bisher hat sonst niemand Zugriff auf diese Session.',
        responsibilityAccessChanged: 'Der Zugriff hat sich geändert. Diese Person kann nicht mehr verantwortlich sein.',
        responsibilityUpdateFailed: 'Happier konnte die verantwortliche Person nicht ändern. Versuch es noch einmal.',
        responsibilityApprovalPending: 'Warten auf Genehmigung. Es hat sich noch nichts geändert – die verantwortliche Person wird nach der Genehmigung aktualisiert.',
        responsibilityA11yEditable: ({ name }: { name: string }) =>
            `Verantwortliche Person, ${name}. Verantwortliche Person ändern.`,
        responsibilityA11yReadOnly: ({ name }: { name: string }) => `Verantwortliche Person, ${name}.`,
        responsibilityA11yEmpty: 'Verantwortliche Person, niemand. Verantwortliche Person ändern.',
        responsibilityAssignedToYou: 'Dir zugewiesen',
        responsibilitySharedWithYou: 'Mit dir geteilt',
    } };

return { sessionResponsibilityTranslations };
})();

const Domain_sessionWorkTranslations = (() => {
const en = Shared_sessionWorkTranslations.en;

const de: typeof en = {
    scheduled: {
        title: "Geplant",
        writesHere: "Schreibt hier",
        empty: "Keine Workflows schreiben hier nach Zeitplan.",
        step: ({ ordinal, title }) => `Schritt ${ordinal} · ${title}`,
        provenanceWorkflowStep: ({ source, step }) => `Von ${source} · Schritt ${step}`,
        notifyOnlyReported: "Nur wenn der Agent etwas berichtet hat",
        notifyOnlyReportedDescription: "Benachrichtigung überspringen, wenn der Agent keinen Text zurückgibt.",
        notifyOnlyReportedNeedsResult: "Verwende das Textergebnis eines früheren Agent-Schritts als Nachricht.",
    },
    workerUpdate: {
        state: {
            settled: "hat den Durchgang beendet",
            needsYou: "braucht dich",
            stalled: "stockt",
            published: "veröffentlicht",
            failed: "fehlgeschlagen",
            stopped: "gestoppt",
            timedOut: "Zeit abgelaufen",
            finished: "beendet",
        },
        peek: "Kurzansicht",
        truncated: "Ergebnis gekürzt.",
        wokenBy: ({ count }) => (count === 1 ? 'Durch ein Update geweckt' : `Durch ${count} Updates geweckt`),
        notFromYou: 'keine Nachricht von dir',
    },
    title: 'Arbeit',
    subtitle: {
        sessions: ({ count }) => (count === 1 ? '1 Sitzung' : `${count} Sitzungen`),
        runs: ({ count }) => (count === 1 ? '1 Lauf' : `${count} Läufe`),
        nothingStarted: 'Noch nichts gestartet',
    },
    states: {
        recent: 'Kürzlich',
    },
    view: {
        a11y: 'Arbeitsansicht',
        list: 'Liste',
        map: 'Karte',
        expandMap: 'Karte neben der Sitzung öffnen',
    },
    map: {
        folded: "Erledigte Arbeit wird eingeklappt",
        backgroundRuns: ({ count }) => (count === 1 ? "1 Hintergrundlauf" : `${count} Hintergrundläufe`),
        positionUnder: ({ position, total, parent }) => `${position} von ${total} unter ${parent}`,
    },
    actions: {
        showInTranscript: 'Im Transkript anzeigen',
        makeOrchestrator: 'Zum Orchestrator machen',
        makeOrchestratorSubtitle: 'Diese Sitzung plant, delegiert und berichtet',
        makeOrchestratorFailed: "Die Sitzung konnte nicht zum Orchestrator werden",
    },
    putUnder: {
        title: "Unterordnen…",
        subtitle: "An eine andere Sitzung berichten",
        search: "Sitzung suchen",
        topLevel: "Oberste Ebene – berichtet an niemanden",
        errors: {
            cycle: "Diese Sitzung berichtet bereits an diese",
            changed: "Die Sitzung wurde gerade verschoben. Versuche es erneut",
            forbidden: "Du kannst sie dieser Sitzung nicht unterordnen",
            failed: "Die Sitzung konnte nicht verschoben werden",
        },
    },
    kinds: {
        session: 'Sitzung',
        workflowRun: 'Workflow-Lauf',
        backgroundRun: 'Hintergrundlauf',
    },
    showMore: ({ count }) => `${count} weitere anzeigen`,
    role: {
        none: 'Keine',
        handsOff: 'nur delegieren',
        a11y: ({ role }) => `Rolle: ${role}. Rolle ändern`,
    },
    empty: {
        title: 'Noch keine Arbeit gestartet',
        reason: 'Sitzungen, Workflows und Hintergrundläufe, die diese Sitzung startet, erscheinen hier – zusammen mit allem, was dich braucht.',
    },
    row: {
        a11y: ({ title, status }) => `${title}, ${status}`,
    },
    progress: ({ completed, total }) => `${completed} von ${total}`,
    strip: {
        openInSidebar: 'In der Seitenleiste öffnen',
        stillWorking: ({ count }) => `${count} arbeiten noch`,
        needsYou: ({ count }) => `${count} braucht dich`,
        a11y: ({ summary }) => `Arbeit: ${summary}`,
    },
    leadArchived: ({ count }) => `Diese Sitzung ist archiviert · ${count} arbeiten noch`,
    runsStale: 'Workflow-Läufe sind möglicherweise nicht aktuell',
    list: {
        level: ({ level }) => `Ebene ${level}`,
        subSessions: ({ count }) => (count === 1 ? '1 Untersitzung' : `${count} Untersitzungen`),
        showReports: ({ name, count }) => (count > 0 ? `${count} Sitzungen unter ${name} anzeigen` : `Sitzungen unter ${name} anzeigen`),
        hideReports: ({ name }) => `Sitzungen unter ${name} ausblenden`,
        reportsWorking: ({ count }) => `${count} arbeiten`,
        reportsNeedYou: ({ count }) => (count === 1 ? '1 Untersitzung braucht dich' : `${count} Untersitzungen brauchen dich`),
    },
    archive: {
        alsoArchiveReports: ({ count }) => (count === 1 ? 'Auch 1 Untersitzung archivieren' : `Auch ${count} Untersitzungen archivieren`),
        someNotArchivedTitle: ({ count }) => (count === 1 ? '1 Untersitzung wurde nicht archiviert' : `${count} Untersitzungen wurden nicht archiviert`),
    },
    step: {
        drivenBy: "Von einem Workflow gesteuert",
        partOf: ({ run }) => `Teil von ${run}`,
        checkedByWorkflow: "Der Workflow prüft das Ergebnis dieses Schritts, daher laufen Auslöser, Ziele und Zweitmeinungen nicht in dieser Sitzung.",
        nothingStarted: "Dieser Schritt hat nichts gestartet.",
    },
    invite: {
        orAskFor: "Oder bitte um",
    },
    peek: {
        reportsTo: ({ lead }) => `Berichtet an ${lead}`,
        repliesGoHere: 'Antworten gehen an diese Sitzung',
    },
};

const notify = { de: { turn: 'Benachrichtige mich, wenn dieser Durchgang endet', attention: 'Benachrichtige mich, wenn ich gebraucht werde', armed: 'Du wirst benachrichtigt', cancel: 'Benachrichtigung abbrechen', failed: 'Benachrichtigung konnte nicht aktualisiert werden. Versuche es erneut.', turnFinished: 'Der Durchgang dieser Sitzung ist beendet.', needsYou: 'Diese Sitzung braucht dich.', settings: 'Benachrichtigungseinstellungen' } };

const runNotify = { de: { run: 'Benachrichtige mich, wenn dies endet', runFinished: 'Dieser Lauf ist beendet.', runNeedsYou: 'Dieser Lauf braucht dich.', setup: 'Benachrichtigungen einrichten' } };

const sessionWorkTranslations = { de: { ...de, notify: { ...notify.de, ...runNotify.de } } };

return { notify, runNotify, sessionWorkTranslations };
})();

const Domain_settingsConnectionsTranslations = (() => {
type MachineParams = Shared_settingsConnectionsTranslations.MachineParams;

const en = Shared_settingsConnectionsTranslations.en;

const de = {
    sectionTitle: 'Verbindungen',
    sectionDescription: 'Wie deine Geräte deine Maschinen erreichen.',
    directTitle: 'Wenn möglich direkt verbinden',
    directOnDescription: 'Vorschauen, Live-Ansichten und Dateiübertragungen laufen direkt zwischen deinen Geräten, wenn sie sich erreichen, sonst über Happier.',
    directOffDescription: 'Alles läuft über Happier. Nichts verbindet sich direkt mit deinen Maschinen; im selben Netzwerk ist das etwas langsamer.',
    serverDenied: 'Der Server deines Home leitet alles über Happier, daher gibt es hier nichts zu wählen.',
    machineSectionTitle: 'Verbindung',
    machineTitle: ({ machine }: MachineParams) => `Verbindung zu ${machine}`,
    machineOptionDefault: 'Standard',
    machineOptionDirect: 'Direkt',
    machineOptionRelay: 'Über Happier',
    machineDefaultDescription: ({ machine }: MachineParams) => `Folgt deinem Konto: direkt, wenn ${machine} erreichbar ist, sonst über Happier.`,
    machineDefaultOffDescription: 'Folgt deinem Konto: immer über Happier.',
    machineDirectDescription: ({ machine }: MachineParams) => `Direkt, wenn ${machine} erreichbar ist, auch wenn dein Konto etwas anderes vorgibt.`,
    machineRelayDescription: 'Immer über Happier, auch im selben Netzwerk.',
};

const settingsConnectionsTranslations = { de };

return { settingsConnectionsTranslations };
})();

const Domain_settingsMachinesTranslations = (() => {
const en = Shared_settingsMachinesTranslations.en;

const de: typeof en = {
    scopeChooseComputer: 'Computer wählen',
    scopeSetUpComputer: 'Computer einrichten',
    scopeOffline: ({ machine }: { machine: string }) => `${machine} ist offline.`,
    defaultsTitle: "Maschinenstandards",
    localVirtualMachines: "Lokale virtuelle Maschinen",
    runningOnly: "Cloud: Abrechnung nur im Betrieb",
    stoppedBilled: "Cloud: Abrechnung auch im Stillstand",
    billingUnknown: "Abrechnung unbekannt",
    pageDescription: 'Die Computer, auf denen deine Sitzungen laufen, und die Pools, die zwischen ihnen wählen.',
    thisComputerTitle: 'Dieser Computer',
    thisComputerRowSubtitle: 'Hintergrunddienst und Befehlszeile',
    thisComputerPageDescription: 'Der Happier-Hintergrunddienst und die Befehlszeile auf diesem Gerät.',
    setupSectionTitle: 'Einrichtung',
    setupRowSubtitle: 'Installiere Happier hier und verbinde es mit deinem Home.',
    addPageDescription: 'Verbinde einen Computer, damit Agents deine Sitzungen darauf ausführen können.',
    addFromComputerTitle: 'Maschinen von einem Computer aus hinzufügen',
    addFromComputerDescription: 'Öffne Happier auf dem Computer, den du hinzufügen möchtest, oder verbinde einen per SSH aus Happier auf dem Desktop oder im Browser.',
    searchPlaceholder: 'Maschinen durchsuchen',
    count: ({ count }: { count: number }) => (count === 1 ? '1 Maschine' : `${count} Maschinen`),
    daemonTitle: 'Hintergrunddienst',
    daemonDescription: 'Führt deine Sitzungen auf diesem Computer aus und hält ihn mit deinem Home verbunden.',
    unreadableTitle: ({ home }: { home: string }) => `Die Maschinen auf ${home} konnten nicht gelesen werden`,
};

const settingsMachinesTranslations = { de };

return { settingsMachinesTranslations };
})();

const Domain_settingsOverviewTranslations = (() => {
type SettingsOverviewTranslation = Shared_settingsOverviewTranslations.SettingsOverviewTranslation;

const slavicPlural = Shared_settingsOverviewTranslations.slavicPlural;

const settingsOverviewTranslations = { de: {
        attentionTitle: 'Braucht deine Aufmerksamkeit',
        agentNeedsSignIn: ({ agent, machine }) => `${agent} muss sich auf ${machine} anmelden`,
        agentNeedsSignInNoMachine: ({ agent }) => `${agent} muss sich anmelden`,
        serviceSignInExpired: ({ service }) => `Anmeldung bei ${service} abgelaufen`,
        signIn: 'Anmelden',
        signInAgain: 'Erneut anmelden',
        setupTitle: 'Einrichten',
        setupProgress: ({ done, total }) => `${done} von ${total}`,
        setupActionSaveKey: 'Schlüssel sichern',
        setupActionAddMachine: 'Maschine hinzufügen',
        setupActionShowQr: 'QR anzeigen',
        setupActionScan: 'Scannen',
        setupActionPasteLink: 'Link einfügen',
        setupActionBrowse: 'Durchsuchen',
        machineUpdateVersions: ({ current, latest }) => `Happier ${current} auf dieser Maschine · ${latest} verfügbar`,
        connectTerminalTitle: 'Terminal verbinden',
        connectTerminalSubtitle: 'Scanne den Code aus deinem Terminal oder füge seinen Link ein.',
        quickSettingsTitle: 'Schnelleinstellungen',
        notificationsPushOn: 'Push an',
        notificationsPushOff: 'Push aus',
        notificationsQuietHours: 'Ruhezeiten an',
        pluginChangesAwaitingReview: ({ count }) => count === 1 ? '1 Plugin-Änderung wartet auf deine Prüfung' : `${count} Plugin-Änderungen warten auf deine Prüfung`,
        review: 'Prüfen',
        browsePluginsTitle: 'Plugins entdecken',
        browsePluginsSubtitle: 'Erweitere Happier um Werkzeuge, Panels und Integrationen.',
        accountServiceSignedIn: ({ service }) => `Bei ${service} angemeldet`,
        aboutDescription: 'Version, Quellcode und rechtliche Bedingungen (Happier ist nicht mit Anthropic verbunden).',
        machinesTitle: 'Rechner',
        machineOnline: 'Online',
        machineOffline: ({ lastSeen }) => `Offline · zuletzt gesehen ${lastSeen}`,
        machineUpdateAvailable: 'Update verfügbar',
        machinesOnlineCount: ({ count }) => `${count} online`,
        machinesOfflineCount: ({ count }) => `${count} offline`,
        machineLastSeen: ({ lastSeen }) => `zuletzt ${lastSeen}`,
        update: 'Aktualisieren',
        asOf: ({ time }) => `Stand ${time}`,
        usageTitle: 'Nutzung',
        usageLeft: ({ percent }) => `${percent} % übrig`,
        usageResets: ({ time }) => `setzt zurück ${time}`,
        securityTitle: 'Sicherheit',
        startSessionLabel: 'Sitzung starten',
        saveRecoveryKeyTitle: 'Wiederherstellungsschlüssel speichern',
        saveRecoveryKeySubtitle: 'Der einzige Weg zurück zu verschlüsselten Daten, wenn du alle Geräte verlierst.',
        addMachineTitle: 'Rechner hinzufügen',
        addMachineSubtitle: 'Verbinde einen Computer, auf dem deine Agenten laufen.',
        homeGreetingNamed: ({ name }) => `Willkommen zurück, ${name}.`,
        homeStartSection: 'Sitzung starten',
        homeCustomize: 'Startseite anpassen',
        homeCustomizeDescription: 'Wähle, welche Bereiche deine Startseite zeigt und in welcher Reihenfolge.',
        homeAlwaysShown: 'Immer sichtbar',
        homeShowSection: 'Anzeigen',
        homeHideSection: 'Bereich ausblenden',
        homeSectionOptions: 'Bereichsoptionen',
        homeResetLayout: 'Auf Standard zurücksetzen',
        homeLayoutSectionTitle: 'Startseite',
        homeAddWidgetsTitle: 'Widgets hinzufügen',
        homeAddWidgetsDescription: 'Widgets aus deinen Plugins. Füge eines hinzu, um es auf deiner Startseite zu zeigen.',
        homeWidgetFromPlugin: ({ plugin }) => `Von ${plugin}`,
        homeRemoveWidget: 'Von der Startseite entfernen',
    } } satisfies Pick<Readonly<Record<string, SettingsOverviewTranslation>>, "de">;

return { settingsOverviewTranslations };
})();

const Domain_settingsProfilesRemoteHostsPageTranslations = (() => {
const english = Shared_settingsProfilesRemoteHostsPageTranslations.english;

const translated = Shared_settingsProfilesRemoteHostsPageTranslations.translated;

const settingsProfilesRemoteHostsPageTranslations = { de: translated({
        settingsProfilesPage: {
            pageDescription: 'Starteinstellungen für neue Sitzungen: Agent, Modell, Umgebungsvariablen und wo sie läuft.',
            useProfilesSection: 'Profilauswahl',
            useProfilesSectionDescription: 'Wähle beim Start einer Sitzung ein Profil oder starte jede Sitzung mit der Umgebung der Maschine.',
            useProfiles: 'Profile verwenden',
            useProfilesOffDescription: 'Aus. Neue Sitzungen verwenden die Umgebung der Maschine.',
            favoritesDescription: 'Werden bei der Profilauswahl zuerst angezeigt.',
            customDescription: 'Deine Profile. Wenn du ein integriertes Profil bearbeitest, wird hier deine eigene Kopie gespeichert.',
            builtInDescription: 'Fertige Profile für jeden Agent.',
        },
        settingsRemoteHostsPage: {
            pageDescription: 'SSH-Hosts, die dieser Computer als Maschinen einrichten, mit denen er sich verbinden oder auf denen er ein Relay betreiben kann.',
            savedHostsSection: 'Gespeicherte Hosts',
            savedHostsDescription: "Zuletzt verwendete zuerst. Öffne einen Host, um ihn zu nutzen oder zu ändern.",
            hostPageDescription: "Ein SSH-Host, den dieser Computer als Maschine einrichten, mit dem er sich verbinden oder auf dem er ein Relay betreiben kann.",
            newHostTitle: "Neuer Remote-Host",
            newHostDescription: "Gib dem Host einen Namen und lege fest, wie er per SSH erreichbar ist.",
            useSection: "Diesen Host nutzen",
            useSectionDescription: "Was dieses Gerät damit tun kann.",
            maintenanceSection: "Happier auf diesem Host",
            maintenanceSectionDescription: "Befehlszeile, Hintergrunddienst und Relay von Happier dort installieren, aktualisieren und ausführen.",
            discard: "Verwerfen",
            accessTitle: "Schlüssel und Verbindungen",
            accessRowSubtitle: "Vertrauenswürdige Host-Schlüssel und offene Tunnel",
            accessPageDescription: "Host-Schlüssel, denen dieses Gerät vertraut, sowie die Tunnel und Zugangswege, die zu deinen Hosts offen sind.",
            hostNotFound: "Dieser Host ist nicht mehr gespeichert.",
            unavailableDescription: 'Gespeicherte SSH-Hosts lassen sich als Maschinen einrichten oder als Relays nutzen.',
            trustedHostKeysDescription: 'Schlüssel, die dieses Gerät beim Verbinden akzeptiert hat. Entferne einen, um beim nächsten Mal erneut gefragt zu werden.',
            trustedHostKeysEmpty: 'Noch keine vertrauenswürdigen Host-Schlüssel. Sie erscheinen hier, sobald du beim Verbinden einen akzeptierst.',
            sshTunnelsDescription: 'Tunnel, die von diesem Gerät zu einem gespeicherten Host offen sind.',
        },
    }) };

return { settingsProfilesRemoteHostsPageTranslations };
})();

const Domain_settingsSearchKeywordsTranslations = (() => {
const english = Shared_settingsSearchKeywordsTranslations.english;

const translated = Shared_settingsSearchKeywordsTranslations.translated;

const settingsSearchKeywordsTranslations = { de: translated({
        settingsSearchKeywords: {
            settings: 'einstellungen, start, übersicht',
            groupProfileAndAccount: 'konto, profil, abrechnung, tarif, nutzung',
            account: 'konto, profil, abrechnung',
            accountSecurity: 'sicherheit, passwort, wiederherstellung, verschlüsselung, abmelden',
            apiTokens: 'api-token, persönliches zugriffstoken, pat, automatisierung, cli, sdk',
            teams: 'teams, mitglieder, gruppen, einladungen',
            homeAdministration: 'home, verwaltung, governance, personen, richtlinien',
            secrets: 'geheimnisse, schlüssel, env, tokens',
            usage: 'nutzung, abrechnung, limits, kontingent',
            machines: 'maschinen, geräte, computer',
            machinePoolsNew: 'maschinenpools, pools, ausweichlösung, ausführen auf',
            machinesAdd: 'hinzufügen, maschine, ssh',
            machinesThisComputer: 'dieser computer, lokal, gerät',
            remoteHosts: 'entfernt, host, hosts, ssh, server, maschinen',
            groupGeneral: 'allgemein, darstellung, sprache, experimente',
            appearance: 'darstellung, design, schrift, oberfläche, seitenleiste',
            keyboard: 'tastatur, tastenkürzel, kürzel, hotkeys, befehle',
            pets: 'begleiter, blink, gefährte, codex',
            language: 'sprache, region, übersetzung',
            features: 'funktionen, experimente, beta',
            groupAiAndAgents: 'agenten, anbieter, mcp, prompts, sprache',
            agents: 'anbieter, agenten, modelle, llm',
            providers: 'anbieter, modelle, openrouter, ollama, lm studio',
            subAgent: 'subagenten, agenten, delegierung, regeln',
            roles: 'rollen, orchestrator, builder, reviewer, anweisungen',
            delegation: 'delegierung, arbeitstiefe, übergabe, orchestrator',
            profiles: 'profile, personas',
            connectedServices: 'verbundene dienste, oauth, konten',
            mcp: 'mcp, werkzeuge, server, plugins',
            plugins: 'plugins, marktplatz, katalog, deskriptor, entdecken',
            prompts: 'prompts, vorlagen, bibliothek',
            promptsTemplates: 'vorlagen',
            promptsFolders: 'ordner',
            promptsStacks: 'stapel',
            promptsRegistries: 'registries, verzeichnisse',
            promptsLibrary: 'bibliothek',
            promptsAssets: 'assets, extern',
            voice: 'stimme, sprache, assistent, mikrofon',
            voiceConversations: 'stimme, gespräch, echtzeit, anbieter',
            voiceDictation: 'stimme, diktat, sprache, transkription',
            voicePrivacy: 'stimme, datenschutz, verlauf, aufbewahrung',
            voiceAdvanced: 'stimme, erweitert, maschine, diagnose',
            memory: 'gedächtnis, suche, index',
            groupSessionsBehavior: 'sitzungen, verlauf, berechtigungen, aktionen',
            session: 'sitzung, terminal, tmux',
            externalSessions: 'externe sitzungen, hintergrund folgen, hooks',
            actions: 'aktionen, freigaben, tastenkürzel',
            embeds: 'einbettungen, einbetten, iframe, widget, website, chat',
            transcript: 'verlauf, chat, layout',
            permissions: 'berechtigungen, freigabe, sicherheit',
            toolRendering: 'werkzeuge, darstellung',
            handoff: 'übergabe, übertragung',
            runs: 'läufe, ausführung',
            groupFilesAndSourceControl: 'dateien, versionskontrolle, anhänge',
            sourceControl: 'git, scm, versionskontrolle',
            attachments: 'anhänge, uploads, dateien',
            groupSystem: 'system, server, status, benachrichtigungen',
            servers: 'server, relay',
            systemStatus: 'systemstatus, zustand, diagnose',
            updates: 'updates, aktualisierungen, version, cli, neu starten',
            notifications: 'notif, benachrichtigung, benachrichtigungen, push',
            notificationsPush: 'push, push-benachrichtigungen',
            desktop: 'desktop, tauri, overlay, fenster',
            diagnosis: 'diagnose, debug',
            reportIssue: 'problem melden, fehler, bug',
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
>, "de"> = { de: {
        settingsSessionPages: {
            preview: {
                userMessage: 'Behebe den instabilen Reconnect-Test',
                agentReply: 'Gefunden: Der Retry-Timer wurde nie gelöscht. Behoben, der Test läuft durch.',
                thinking: 'Der Test schlägt nur nach einem Timeout fehl, also läuft der Retry-Timer vermutlich noch.',
            },
            runtime: {
                pageDescription: 'Wie Sitzungen auf deinen Rechnern laufen.',
                terminalSection: 'Terminal',
                terminalHostTitle: 'Terminal-Host für neue Sitzungen',
                terminalHostNone: 'Keiner',
                tmuxTitle: 'Sitzungen in tmux starten',
                tmuxOn: 'Neue Sitzungen öffnen sich in einem eigenen tmux-Fenster, damit du dich aus einem Terminal verbinden kannst.',
                tmuxOff: 'Neue Sitzungen laufen in einer normalen Shell.',
            },
            wizard: {
                pageDescription: 'Wie der Assistent für neue Sitzungen seine Schritte anordnet.',
                wideScreensSection: 'Breite Bildschirme',
                stepsSection: 'Wie jeder Schritt seine Auswahl zeigt',
                steps: {
                    profiles: 'Profil',
                    backends: 'Agent',
                    models: 'Modell',
                    machines: 'Rechner',
                    paths: 'Ordner',
                    permissions: 'Berechtigungen',
                },
            },
            providerLimits: {
                pageDescription: 'Was passiert, wenn das Nutzungslimit eines Kontos erreicht ist, und wie viel Kontingent dir bleibt.',
                recoveryDescription: 'Erreicht ein Agent das Nutzungslimit seines Kontos, kann die Sitzung auf den Reset warten und weitermachen.',
                resumePromptCustom: 'Eigener',
                unavailableTitle: 'In diesem Home nicht verfügbar',
                unavailableDescription: 'Wiederaufnahme nach Nutzungslimits und die Nutzungsanzeige sind in diesem Home nicht aktiviert.',
            },
            resume: {
                pageDescription: 'Wie eine inaktive Sitzung weitergeht, wenn ihr Agent sie nicht selbst fortsetzen kann.',
                strategyRecent: 'Letzte Nachrichten',
                strategySummary: 'Zusammenfassung + letzte',
                maxSeedCharsTitle: 'Größenlimit für Replay',
                summaryModelSection: 'Modell für Zusammenfassungen',
                summaryModelDescription: 'Der Agent und das Modell, die die Zusammenfassung für die neue Sitzung schreiben.',
                handoffSection: 'Sitzungen verschieben',
                handoffLinkDescription: 'Was mit einer Sitzung mitgeht, wenn du sie an einen anderen Rechner übergibst.',
            },
            permissions: {
                duringSessionSection: 'Während einer Sitzung',
                duringSessionDescription: 'Wo Freigabeanfragen erscheinen und wann eine Änderung der Berechtigungen einer laufenden Sitzung wirkt.',
                promptSurfaceComposer: 'Beim Eingabefeld',
                applyImmediately: 'Sofort',
                applyNextMessage: 'Nächste Nachricht',
                storageUseDefault: 'Standard',
            },
            handoff: {
                pageDescription: 'Was mit einer Sitzung mitgeht, wenn du sie an einen anderen Rechner übergibst.',
                workspaceSection: 'Arbeitsbereich-Dateien',
                workspaceDescription: 'Was mit dem Projektordner passiert, wenn eine Sitzung auf einen anderen Rechner wechselt.',
                keepUpdated: 'Aktuell halten',
                advancedModeDescription: 'Ersetzt die Auswahl oben. Vorsicht: Dateien können entfernt oder überschrieben werden.',
                ignoredExclude: 'Ausschließen',
                ignoredIncludeSelected: 'Ausgewählte einschließen',
            },
            toolRendering: {
                pageDescription: 'Gib einzelnen Tools mehr oder weniger Details als die Standardeinstellung des Transkripts.',
                collapsedDescription: 'Wie viel jedes Tool im Transkript zeigt, bevor du es öffnest.',
            },
            transcript: {
                advancedTitle: 'Leistung und Timing',
                advancedPageDescription: 'Streaming, Animations-Timing und Scroll-Schwellen. Die Standardwerte passen für die meisten.',
                advancedMotionOff: 'Animationen im Transkript sind aus, daher haben diese Werte keine Wirkung. Schalte sie unter Transkript › Bewegung ein.',
                toolsSection: "Tool-Aufrufe",
                toolOverridesDescription: 'Gib einzelnen Tools mehr oder weniger Details.',
                thinkingSummary: 'Zusammenfassung',
                thinkingFull: 'Vollständig',
                strategyConsecutive: 'Aufeinanderfolgend',
                strategyWholeTurn: 'Ganzer Zug',
                copyMarkdown: 'Markdown',
                copyMarkdownDescription: 'Kopierte Nachrichten behalten ihre Formatierung und zeigen, wer sie geschrieben hat.',
                copyPlainDescription: 'Kopierte Nachrichten sind reiner Text, ohne Beschriftungen.',
                motionSubtle: 'Dezent',
                advancedLinkDescription: 'Streaming, Animations-Timing und Scroll-Schwellen.',
                pageDescription: 'Wie sich ein Gespräch liest, während es wächst: Aufbau, Denken, Tools, Bewegung und Scrollen.',
            },
            composer: {
                pageDescription: 'Wie du Nachrichten schreibst und sendest, und was passiert, wenn ein Agent beschäftigt ist.',
                newSessionsSection: 'Neue Sitzungen',
                newSessionsDescription: 'Was du siehst, wenn du „Neue Sitzung“ wählst.',
                draftEntryTitle: 'Beim Öffnen einer neuen Sitzung',
                draftResume: 'Entwurf fortsetzen',
                draftFresh: 'Neu beginnen',
                typingSection: 'Tippen',
                typingDescription: 'Wie sich Enter und der Nachrichtenverlauf im Eingabefeld verhalten.',
                enterToSendTitle: 'Mit Enter senden',
                sendModeTitle: 'Während der Agent arbeitet',
                sendQueue: 'Einreihen',
                sendInterrupt: 'Unterbrechen',
                sendPending: 'Ausstehend',
                busySteerTitle: 'Wenn der Agent steuern kann',
                busySteerInactive: 'Gilt nur, wenn Nachrichten eingereiht oder zurückgehalten werden, während der Agent arbeitet.',
                nonSteerableTitle: 'Fragen, wenn eine Nachricht nicht steuern kann',
                resumeWhenPossible: 'Sobald möglich',
                resumeIfOnline: 'Wenn online',
                resumeNever: 'Nie',
                pendingSection: 'Ausstehende Nachrichten',
                pendingDescription: 'Wie wartende Nachrichten den Agenten erreichen.',
                pendingInactive: 'Mit deinen aktuellen Einstellungen wird nichts zurückgehalten. Diese gelten, sobald eine Nachricht wartet.',
                drainOne: 'Einzeln',
                drainAll: 'Alle zusammen',
                timingAfterReply: 'Nach der Antwort',
                timingWhenIdle: 'Wenn alles ruht',
                layoutSection: 'Aufbau des Eingabefelds',
                actionBarTitle: 'Aktionsleiste',
                actionBarAutoDescription: 'Steuerelemente nutzen den verfügbaren Platz und werden bei Bedarf umgebrochen.',
                actionBarWrapDescription: 'Chips brechen in eine zweite Zeile um, wenn sie nicht passen.',
                actionBarScrollDescription: 'Chips bleiben in einer Zeile; scrolle seitlich zum Rest.',
                actionBarCollapsedDescription: 'Chips wandern in ein Menü und lassen am meisten Platz zum Schreiben.',
                chipDensityTitle: 'Aktions-Chips',
                chipsAutoDescription: 'Chips, die es brauchen, behalten ihre Beschriftung; selbsterklärende zeigen nur ihr Symbol.',
                chipsLabelsDescription: 'Jeder Chip zeigt seine Beschriftung.',
                chipsIconsDescription: 'Chips zeigen nur ihre Symbole, um Platz zu sparen.',
            },
        },
    } };

return { settingsSessionPagesTranslations };
})();

const Domain_shareSheetTranslations = (() => {
type ShareSheetTranslations = Shared_shareSheetTranslations.ShareSheetTranslations;

const shareSheetTranslations = { de: {
        publicLink: { workflowDescription: "Alle mit dem Link können diesen Workflow ohne Konto lesen.", workflowGrants: "Workflow nur zum Lesen.", description: "Alle mit dem Link können dieses Dokument ohne Konto lesen.", grants: "Dokument nur zum Lesen.", audit: "Zugriffsprotokoll", auditEmpty: "Noch keine Besuche erfasst.", ownerUpdateRequired: "Der Eigentümer aktualisiert diesen Link", ownerUpdateRequiredDescription: "Bitte den Eigentümer, Happier zu öffnen, und versuche diesen Link erneut." },
        suggestions: ({ kind }: Readonly<{ kind: string }>) => `Vorschläge: ${kind}`,
        profileAgentsMore: ({ count }: Readonly<{ count: number }>) => `+${count} weitere`,
        roleRunsIn: ({ kind }: Readonly<{ kind: string }>) => `Läuft in ${kind}`,
        whoHasAccess: 'Wer Zugriff hat',
        whoHasAccessStale: 'Wer Zugriff hat · möglicherweise nicht aktuell',
        owner: 'Eigentümer',
        you: 'Du',
        addPlaceholder: 'Personen oder Teams hinzufügen',
        person: 'Person',
        group: 'Teamgruppe',
        team: 'Team',
        accessLevel: 'Zugriffsstufe',
        accessibleControl: ({ name, control, value }) => `${name}, ${control}, ${value}`,
        remove: 'Zugriff entfernen',
        confirmRemove: 'Entfernen bestätigen',
        removedAnnouncement: ({ name }) => `${name} hat keinen Zugriff mehr`,
        browseAll: 'Alle durchsuchen',
        browsePeople: 'Alle Personen durchsuchen',
        browseTeams: 'Alle Teams durchsuchen',
        browseGroups: 'Alle Teamgruppen durchsuchen',
        membersOnlyLink: 'Link kopieren ist für Personen, die bereits Zugriff haben.',
        allLoaded: 'Alle Ergebnisse geladen',
        copyLink: 'Link kopieren',
        linkCopied: 'Link kopiert',
        copyLinkFailed: 'Der Link konnte nicht kopiert werden.',
        sendCopy: 'Stattdessen eine Kopie senden',
        secrets: {
            levels: { canUse: 'Kann nutzen' },
            help: { use: 'in Läufen; der Wert wird nie angezeigt' },
            oneLevel: 'Ein gespeichertes Geheimnis wird nur von Läufen genutzt und sein Wert verlässt es nie, daher gibt es nur eine Stufe.',
        },
        documents: {
            title: 'Teilen',
            shareTitle: ({ name }) => `${name} teilen`,
            levels: { canUse: 'Kann nutzen', canRead: 'Kann lesen', canEdit: 'Kann bearbeiten', admin: 'Verwalten' },
            help: {
                workflowUse: 'ansehen und ausführen',
                roleUse: "die Rolle in eigenen Sitzungen; persönliche Änderungen bleiben in den eigenen Einstellungen",
                profileUse: 'Sitzungen damit starten',
                documentUse: 'es auf allen eigenen Geräten öffnen und kopieren',
                promptUse: "den Prompt in eigenen Sitzungen",
                boardUse: 'das Board sehen; jede Karte öffnet nur, was bereits zugänglich ist',
                dashboardUse: 'Dieses Dashboard ansehen; jedes Widget zeigt nur, was du bereits öffnen kannst.',
                editForEveryone: 'für alle ändern, mit denen es geteilt ist',
                adminOwnerShares: 'ändern und Freigaben verwalten',
            },
            notes: {
                personalRuns: 'Ausführungen und Auslöser bleiben bei der Person, die sie startet.',
                teamRuns: 'Das Team sieht jede Ausführung.',
                roleLive: 'Deine Änderungen erreichen alle, mit denen es geteilt ist.',
                profileSecrets: 'Profile verweisen auf gespeicherte Secrets; ihre Werte werden nicht übertragen.',
                dashboardAccess: 'Hinzugefügte Personen öffnen es mit ihrer eigenen Identität. Widgets, Definitionen, Verbindungen, Maschinen und Repositories benötigen jeweils eigenen Zugriff.',
            },
            privateChoices: {
                title: 'Private Verbindungsauswahl',
                account: ({ widget, service }) => `${widget} verwendet dein Konto bei ${service}`,
                letViewersPick: 'Betrachter wählen lassen',
                removeChoice: 'Auswahl entfernen',
                authoredInput: ({ widget }) => `Bearbeite ${widget} um private Eingaben vor dem Teilen zu entfernen.`,
            },
            errors: {
                unavailable: 'Teilen ist hier noch nicht verfügbar.',
                ownerOnly: 'Nur der Eigentümer oder ein Administrator kann ändern, wer Zugriff hat.',
                noAccess: 'Du hast keinen Zugriff mehr.',
                notFound: 'Das ist nicht mehr verfügbar.',
                subjectUnavailable: 'Diese Person, Gruppe oder dieses Team kann keinen Zugriff erhalten.',
                failed: 'Teilen konnte nicht aktualisiert werden. Versuche es erneut.',
            },
        },
    } } satisfies Pick<Record<string, ShareSheetTranslations>, "de">;

return { shareSheetTranslations };
})();

const Domain_sidebarFooterTranslations = (() => {
type SidebarFooterTranslation = Shared_sidebarFooterTranslations.SidebarFooterTranslation;

const sidebarFooterTranslations = { de: {
        linkToService: ({ service }) => `Mit ${service} verknüpfen`,
        addHomeOrSignIn: 'Home hinzufügen oder anmelden',
        usageNoAccounts: 'Verbinde ein Konto, um zu sehen, wie viel von seinen Limits übrig ist.',
        usageHealthy: 'In allen Limits ist noch reichlich Luft',
        homeUnreachableTitle: ({ home }) => `${home} ist nicht erreichbar`,
        homeUnreachableBody: 'Deine Maschinen und Sitzungen erscheinen hier wieder, sobald es antwortet.',
        homeUnreachableLine: ({ home }) => `${home} ist nicht erreichbar.`,
        availableWhenHomeAnswers: "Verfügbar, sobald dieses Home antwortet.",
        usageKeysWithoutLimits: ({ count }) => count === 1 ? '1 Schlüssel ohne Limits' : `${count} Schlüssel ohne Limits`,
        usageSignedOut: 'Abgemeldet',
        hideAccountIdentities: 'E-Mails und IDs der Konten ausblenden',
        accountIdentitiesHidden: 'E-Mails und IDs ausgeblendet · für Streams und Demos',
        usageThisSession: 'Diese Sitzung',
        usageAllAccounts: 'Alle Konten',
        usageMoreAccounts: ({ count }) => `${count} weitere`,
        usageSessionThroughPool: ({ agent, pool }) => `${agent} meldet sich über ${pool} an`,
        usageSessionWithAccount: ({ agent }) => `${agent} meldet sich mit diesem Konto an`,
        usageSessionOwnSignIn: ({ agent }) => `${agent} nutzt seine eigene Anmeldung`,
        usagePoolFallback: 'seinen Pool',
        usageNextInOrder: ({ account }) => `Wenn ${account} aufgebraucht ist, wechselt der nächste Zug zum nächsten Konto in der Reihenfolge`,
        usageNextMostLeft: ({ account }) => `Wenn ${account} aufgebraucht ist, wechselt der nächste Zug zum Konto mit dem meisten Rest`,
        usageNextStays: ({ pool, account }) => `${pool} bleibt bei ${account}, bis du wechselst`,
    } } as const satisfies Pick<Record<string, SidebarFooterTranslation>, "de">;

return { sidebarFooterTranslations };
})();

const Domain_surfaceStateTranslations = (() => {
type SurfaceStateTranslations = Shared_surfaceStateTranslations.SurfaceStateTranslations;

const surfaceStateTranslations = { de: {
        stillWaiting: ({ seconds }) => `Warte noch · ${seconds} s`,
        asOf: ({ time }) => `Stand ${time}`,
        howItWorks: 'So funktioniert es',
        tryAgain: 'Erneut versuchen',
        checkAgain: 'Erneut prüfen',
        paneFailedTitle: 'Dieser Bereich konnte nicht angezeigt werden',
        paneFailedReason: 'Beim Darstellen ist etwas schiefgelaufen. Deine Sitzung ist nicht betroffen.',
        opening: ({ name }) => `${name} wird geöffnet`,
        couldNotOpen: ({ name }) => `${name} konnte nicht geöffnet werden`,
    } } as const satisfies Pick<Record<string, SurfaceStateTranslations>, "de">;

return { surfaceStateTranslations };
})();

const Domain_teamsTranslations = (() => {
type TeamsTranslationRoot = Shared_teamsTranslations.TeamsTranslationRoot;

const english = Shared_teamsTranslations.english;

const german: TeamsTranslationRoot = {
    teams: {
        leave: {
            action: 'Team verlassen',
            description: 'Dein Zugriff auf das Team und seine Gruppen endet. Dein Konto auf diesem Home bleibt.',
            confirmTitle: ({ name }: { name: string }) => `${name} verlassen?`,
            confirmBody: 'Dein Zugriff auf das Team und seine Gruppen endet sofort. Deine Gruppenmitgliedschaften und an diese Mitgliedschaft gebundenen Berechtigungen werden entfernt. Deine Beiträge und bereits gesehene Inhalte bleiben erhalten. Ein späterer Beitritt beginnt eine neue Mitgliedschaft.',
            auditLeft: ({ team }: { team: string }) => `hat ${team} verlassen`,
            auditRemoved: ({ team, target }: { team: string; target: string }) => `hat ${target} aus ${team} entfernt`,
        },
        overview: {
            sharedSessions: "Geteilte Sitzungen",
            allSharedSessions: "Alle geteilten Sitzungen",
            managedBy: ({ team }: { team: string }) => `Inhaber und Admins von ${team} verwalten Mitglieder, Anmeldung und Einstellungen.`,
            attention: {
                directoryFailedTitle: ({ name }: { name: string }) => `${name} konnte nicht synchronisieren`,
                directoryFailedBody: "Mitglieder und Gruppen bleiben wie bei der letzten erfolgreichen Synchronisierung.",
                invitationUndeliveredTitle: "Eine Einladungs-E-Mail ist nicht angekommen",
                invitationUndeliveredBody: ({ recipient }: { recipient: string }) => `Für ${recipient}. Der Link funktioniert weiterhin, wenn du ihn anders teilst.`,
            },
            sessionsSubtitle: 'Mit diesem Team geteilte Sitzungen.',
            teamSection: 'Team',
            summary: {
                historyFromJoining: "Verlauf ab Beitritt",
                historyEarlier: "auch früherer Verlauf",
                groupsDirectory: ({ directory }: { directory: string }) => `abgeglichen mit ${directory}`,
                undelivered: ({ count }: { count: number }) => count === 1 ? '1 E-Mail nicht angekommen' : `${count} E-Mails nicht angekommen`,
                credentialsShared: ({ count, team }: { count: number; team: string }) => `${count} mit ${team} geteilt`,
                credentialsNone: "Noch keine geteilt",
                justYou: 'Nur du',
                people: ({ count }: { count: number }) => count === 1 ? `1 Person` : `${count} Personen`,
                suspended: ({ count }: { count: number }) => `${count} gesperrt`,
                groups: ({ count }: { count: number }) => count === 1 ? `1 Gruppe` : `${count} Gruppen`,
                noGroups: 'Noch keine Gruppen',
                waiting: ({ count }: { count: number }) => `${count} warten auf Annahme`,
                noneWaiting: 'Keine offen',
                homeSignIn: ({ home }: { home: string }) => `Anmeldung von ${home}`,
                chosenSignIn: 'Nur die gewählte Anmeldung',
                signInNeedsRepair: 'Anmelderegel muss repariert werden',
                sessionsPrivate: 'Sitzungen standardmäßig privat',
                sessionsShared: 'Sitzungen standardmäßig geteilt',
                sessionsAlwaysShared: 'Sitzungen immer geteilt',
            },
            setup: {
                title: ({ team }: { team: string }) => `${team} einrichten`,
                description: 'Jeder Schritt verschwindet aus der Liste, sobald er erledigt ist.',
                inviteBody: ({ home, team }: { home: string; team: string }) => `Alle, die du einlädst, treten ${home} als Teil von ${team} bei.`,
                signInTitle: 'Anmeldung der Mitglieder wählen',
                signInBody: 'Behalte die Anmeldung dieses Homes oder verlange die deines Unternehmens.',
                signInAction: 'Wählen',
                shareTitle: 'Eine Sitzung teilen',
                shareBody: ({ team }: { team: string }) => `Teile sie über das Menü einer Sitzung mit ${team}.`,
            },
        },
        denied: {
            askUnnamed: "Frag einen Inhaber oder Admin dieses Teams.",
            title: 'Deine Rolle in diesem Team umfasst das nicht',
            authentication: ({ team }: { team: string }) => `Inhaber und Admins von ${team} legen fest, wie sich Mitglieder anmelden.`,
            settings: ({ team }: { team: string }) => `Inhaber und Admins von ${team} ändern diese Einstellungen.`,
        },
        pages: {
            credentialCreate: 'Wähle, was du teilst, wer es nutzen darf und welche Grenzen gelten.',
            credentialDetail: 'Wer diese Zugangsdaten nutzen darf, wie und wie viel.',
            credentialEdit: 'Ändere, wer diese Zugangsdaten nutzen darf, wie und wie viel.',
            credentialActivity: 'Änderungen an diesen Zugangsdaten und wer sie vorgenommen hat.',
            credentialUsage: 'Wie viel diese Zugangsdaten genutzt wurden und von wem.',
            credentialExternalApi: 'Nutze diese Zugangsdaten aus Werkzeugen außerhalb von Happier.',
            identityProviderNew: 'Verbinde einen Identitätsanbieter, mit dem sich Mitglieder anmelden können.',
            identityProviderEdit: 'Ändere, wie sich dieser Identitätsanbieter verbindet.',
            githubApp: 'Eine GitHub App, mit der dieses Team auf Repositorys zugreift.',
            githubAppEdit: 'Ändere die Registrierung dieser GitHub App.',
            authentication: 'Wie sich Mitglieder bei diesem Team anmelden und wen es aufnimmt.',
            credentials: 'Anbieter-Zugangsdaten, die dieses Team mit seinen Mitgliedern teilt.',
            directory: 'Gruppen von Personen, die auf einem Home Sitzungen, Zugriff und Zugangsdaten teilen.',
            members: 'Wer in diesem Team ist und was jede Person darf.',
            addMember: 'Füge jemanden hinzu, der bereits ein Konto auf diesem Home hat.',
            groups: 'Benannte Mitgliedergruppen, mit denen du Sitzungen und Zugangsdaten teilst.',
            newGroup: 'Gib der Gruppe einen Namen. Mitglieder fügst du hinzu, sobald sie existiert.',
            invitations: 'Einladungen, mit denen Personen diesem Team beitreten, und für wen sie gelten.',
            settings: 'Name, Logo, Standards für Sitzungen und ob dieses Team aktiv ist.',
        },
        loading: 'Team wird geladen…',
        title: 'Teams',
        entrySubtitle: 'Teams erstellen, Mitglieder und Gruppen verwalten und Personen einladen.',
        entry: {
            heading: ({ team }: { team: string }) => `Weiter zu ${team}`,
            onHome: ({ home }: { home: string }) => `auf ${home}`,
            signInServiceOrigin: ({ service }: { service: string }) => `Melde dich über ${service} an`,
            signInServiceUnavailableOrigin: ({ service }: { service: string }) => `Die Anmeldung über ${service} ist nicht verfügbar`,
            signedInTo: ({ home, account }: { home: string; account: string }) => `Bei ${home} als ${account} angemeldet`,
            unnamedAccount: 'Happier-Account',
            continueWith: ({ method }: { method: string }) => `Weiter mit ${method}`,
            providerUnavailableTitle: ({ method }: { method: string }) => `${method} ist nicht verfügbar`,
            providerUnavailableDisabled: 'Die Administration deines Teams hat diese Anmeldung ausgeschaltet. Prüf es später noch einmal.',
            providerUnavailableSetupIncomplete: 'Die Administration deines Teams hat diese Anmeldung noch nicht fertig eingerichtet. Prüf es später noch einmal.',
            providerUnavailableUnavailable: 'Dieses Home kann diese Anmeldung gerade nicht verwenden. Prüf es später noch einmal.',
            unknownTargetTitle: 'Dieser Link nennt sein Home nicht',
            unknownTargetBody: 'Dieses Gerät kann nicht feststellen, zu welchem Home dieser Team-Anmeldelink gehört; es wurde nichts gesendet. Bitte eine Team-Verwaltung erneut um den Link.',
            ssoRequiredTitle: 'Dieses Team verlangt eine andere Anmeldung',
            ssoRequiredBody: 'Du bist bei diesem Home angemeldet, aber dieses Team akzeptiert nur die von ihm vorgegebene Anmeldemethode. Melde dich erneut mit dieser Methode an oder kehre zu deiner eigenen Arbeit zurück.',
            invitationUnavailableTitle: 'Diese Einladung kann nicht verwendet werden',
            invitationUnavailableBody: 'Sie ist möglicherweise abgelaufen, widerrufen oder bereits verwendet worden. Die Anmeldung allein macht dich nicht zum Mitglied des Teams.',
            wrongAccountTitle: 'Dieses Konto kann diese Anmeldung nicht verwenden',
            wrongAccountBody: 'Das Konto oder die Identität, mit der du dich angemeldet hast, ist nicht die, die dieses Team erwartet. Melde dich mit einem anderen Konto oder Anbieter an oder kehre zu deiner eigenen Arbeit zurück.',
            notProvisionedTitle: 'Dieses Team hat dich noch nicht aufgenommen',
            notProvisionedBody: 'Die Anmeldung allein macht dich nicht zum Mitglied dieses Teams. Wer aufgenommen wird, entscheidet die Administration; bitte dort um Zugang oder eine Einladung und versuche es dann erneut.',
            directoryDelayedTitle: 'Dein Zugang ist noch unterwegs',
            directoryDelayedBody: 'Dieses Team bezieht seine Mitglieder aus einem Verzeichnis, das deinen Zugang noch nicht übermittelt hat. Versuche es später erneut oder frage eine Team-Verwaltung.',
            accessRemovedTitle: 'Dieses Team steht dir nicht zur Verfügung',
            accessRemovedBody: 'Dein Zugang wurde möglicherweise entfernt, oder das Team ist auf diesem Home gerade nicht verfügbar. Alles andere, wo du angemeldet bist, bleibt unverändert.',
            providerChangedTitle: 'Diese Anmeldemethode hat sich während der Nutzung geändert',
            providerChangedBody: 'Eine Administration hat diese Anmeldemethode während deiner Anmeldung aktualisiert. An deinem Konto wurde nichts geändert. Beginne erneut auf der Team-Seite, um die aktuellen Methoden zu sehen.',
            returnToTeamSignIn: 'Zurück zur Team-Anmeldung',
            returnToHappier: 'Zurück zu Happier',
            signInToTeam: 'Bei diesem Team anmelden',
            readyStatus: 'Wähle, wie du dich anmelden möchtest, um fortzufahren.',
        },
        homeLabel: 'Home',
        role: {
            owner: 'Eigentümer',
            admin: 'Administrator',
            member: 'Mitglied',
            guest: 'Gast',
        },
        roleHelp: {
            owner: 'Besitzt das Team, kann es verwalten und Eigentümerrollen ändern.',
            admin: 'Erhält den Zugriff eines Mitglieds und kann das Team verwalten.',
            member: 'Erhält standardmäßig den Zugriff, der dem Team gewährt wird.',
            guest: 'Sieht nur Sessions und Ressourcen, die ausdrücklich mit diesem Account oder einer seiner Gruppen geteilt wurden.',
        },
        status: {
            active: 'Aktiv',
            suspended: 'Gesperrt',
        },
        history: {
            label: 'Session-Verlauf',
            allExisting: 'Bereits mit dem Team geteilte Sessions einbeziehen',
            fromMembership: 'Nur Sessions, die nach dem Beitritt geteilt werden',
            allExistingNamed: ({ name }) => `Bereits mit ${name} geteilte Sessions einbeziehen`,
            fromMembershipNamed: ({ name }) => `Nur Sessions, die nach dem Beitritt zu ${name} geteilt werden`,
            scopeNote: 'Dies gilt für vollständige Sessions. Es werden nicht nur die nach dem Beitritt erstellten Nachrichten sichtbar.',
        },
        unavailable: {
            title: 'Teams sind auf diesem Home nicht verfügbar',
            disabled: 'Auf diesem Home sind Teams deaktiviert.',
            updateRequired: 'Dieses Home benötigt ein Update, um Teams zu nutzen.',
            offline: 'Dieses Home ist derzeit nicht erreichbar.',
            retry: 'Erneut versuchen',
        },
        stale: {
            label: 'Es werden die zuletzt bekannten Daten dieses Homes angezeigt.',
        },
        errors: {
            generic: 'Das hat nicht geklappt. Es wurde nichts geändert.',
            outcomeUnknown: 'Das Home hat diese Änderung möglicherweise abgeschlossen. Aktualisiere das Team, bevor du es erneut versuchst.',
            forbidden: 'Dir fehlt die Berechtigung für diese Änderung.',
            notFound: 'Dieses Team ist nicht mehr verfügbar.',
            archived: 'Dieses Team ist archiviert. Stelle es wieder her, um es zu ändern.',
            conflict: 'Jemand anderes war schneller. Prüfe die aktuellen Werte und versuche es erneut.',
            offline: 'Dieses Home ist nicht erreichbar, die Änderung wurde nicht gesendet.',
            invalidName: 'Gib einen Namen mit 1 bis 80 Zeichen ein.',
            invalidDescription: 'Gib eine Beschreibung mit höchstens 500 Zeichen ein.',
        },
        directory: {
            loading: 'Teams werden geladen…',
            chooseTeamToShare: 'Wähle das Team, mit dem du es teilen möchtest.',
            noMatches: 'Keine passenden Teams',
            noLoadedMatches: 'Keine passenden geladenen Teams',
            searchLoadedPlaceholder: 'Geladene Teams filtern',
            unreachableHomes: 'Antwortet nicht',
            searchPlaceholder: 'Teams durchsuchen',
            newTeam: 'Neues Team',
            createDenied: ({ homes }: { homes: string }) => `Nur Administratoren von ${homes} können Teams erstellen. Bitte eine Person mit Adminrechten, ein Team zu erstellen oder dich hinzuzufügen.`,
            createAdministered: ({ names }: { names: string }) => `Teams auf diesem Home werden von seinen Administratoren erstellt. Bitte ${names}, ein Team für dich zu erstellen oder allen das Erstellen von Teams zu erlauben.`,
            createAdministeredUnnamed: 'Teams auf diesem Home werden von seinen Administratoren erstellt. Bitte eine Person mit Adminrechten, ein Team für dich zu erstellen oder allen das Erstellen von Teams zu erlauben.',
            createOff: 'Das Erstellen von Teams ist auf diesem Home ausgeschaltet.',
            letEveryoneCreate: 'Allen das Erstellen von Teams erlauben',
            namesAnd: ({ names, last }: { names: string; last: string }) => `${names} und ${last}`,
            namesAndOthers: ({ names, count }: { names: string; count: number }) => `${names} und ${count} weitere`,
            emptyTitle: 'Noch keine Teams',
            emptyBody: 'Ein Team gibt einer Gruppe von Personen einen gemeinsamen Ort für Sessions, Personen und Zugriff.',
            archivedSection: 'Archivierte Teams',
            archivedEmpty: 'Keine archivierten Teams',
            archivedEmptyBody: 'Ein Team, das in seinen eigenen Einstellungen archiviert wird, erscheint hier. Mitglieder, Gruppen und Verlauf bleiben erhalten.',
            showArchived: 'Archivierte anzeigen',
            hideArchived: 'Archivierte ausblenden',
            archivedBadge: 'Archiviert',
            rowAccessibilityLabel: ({ name, role, home }: { name: string; role: string; home: string }) => `${name}, ${role}, auf ${home}`,
            partialHomes: 'Einige Homes waren nicht erreichbar, deshalb fehlen deren Teams in dieser Liste.',
        },
        create: {
            loading: 'Es wird geprüft, wo du ein Team erstellen kannst…',
            discard: 'Verwerfen',
            detailsSection: 'Team',
            logoFailedBody: 'Das Team wurde erstellt, aber sein Logo wurde nicht veröffentlicht. Versuche es erneut oder fahre ohne Logo fort.',
            title: 'Neues Team',
            nameLabel: 'Name',
            namePlaceholder: 'Acme',
            descriptionLabel: 'Beschreibung',
            descriptionPlaceholder: 'Woran dieses Team arbeitet',
            homeHelp: 'Das Team wird auf diesem Home erstellt und bleibt dort.',
            duplicateNameNote: 'Zwei Teams dürfen denselben Namen tragen. Links und Zugriff nutzen immer das Team selbst.',
            managedOnlyTitle: 'Die Teamerstellung wird auf diesem Home verwaltet',
            managedOnlyBody: 'Eine Administratorin oder ein Administrator erstellt hier Teams und wählt die erste Eigentümerrolle.',
            initialOwnerLabel: 'Erste Eigentümerrolle',
            initialOwnerPlaceholder: 'Personen auf diesem Home suchen',
            initialOwnerHelp: 'Ein Team für jemand anderen zu erstellen, fügt dich selbst nicht hinzu.',
            initialOwnerRequired: 'Wähle die erste Eigentümerrolle des Teams. Auf diesem Home legt die Administration fest, wem ein neues Team gehört.',
            initialOwnerIneligible: 'Diese Person kann kein Team mehr besitzen. Wähle jemand anderen.',
            submit: 'Team erstellen',
            submitting: 'Wird erstellt…',
            outcomeUnknown: 'Es konnte nicht bestätigt werden, ob das Team erstellt wurde. Versuche es erneut, um dieselbe Anfrage wiederaufzunehmen.',
        },
        tabs: {
            overview: 'Überblick',
            sessions: 'Sessions',
            members: 'Mitglieder',
            groups: 'Gruppen',
            invitations: 'Einladungen',
            authentication: 'Authentifizierung',
            settings: 'Einstellungen',
        },
        authentication: {
            policy: {
                admissionRow: "Neue Mitglieder",
                acceptedRow: "Akzeptierte Anmeldung",
                admissionSection: 'Wer beitreten kann',
                admissionHelp: 'Wie Personen Mitglieder dieses Teams werden.',
                admissionInviteOnly: 'Nur mit Einladung',
                admissionProvisioned: 'Über ein Verzeichnis bereitgestellt',
                admissionJit: 'Automatisch bei der ersten Anmeldung',
                admissionUnavailable: 'Dieses Home kann diesen Aufnahmemodus noch nicht durchsetzen, daher wurde nichts geändert.',
                admissionUnavailableReason: {
                    homePolicyUnavailable: 'Dieses Home stellt diesen Anmeldeanbieter für Teams nicht bereit. Die Home-Administration kann das ändern.',
                    homePolicyProhibited: 'Die Home-Administration erlaubt diesen Aufnahmemodus auf diesem Home nicht.',
                    directorySourceRequired: 'Füge diesem Team zuerst ein Verzeichnis hinzu. Dieser Modus nimmt die Personen auf, die es bereitstellt.',
                    directoryProjectionRequired: 'Das Verzeichnis dieses Teams hat seine erste Synchronisierung noch nicht abgeschlossen. Danach wird dieser Modus verfügbar.',
                    teamConnectionRequired: 'Füge diesem Team zuerst eine Anmeldeverbindung hinzu. Die Aufnahme bei der ersten Anmeldung braucht eine.',
                    teamConnectionUnavailable: 'Derzeit ist keine Anmeldeverbindung dieses Teams nutzbar, daher könnte niemand bei der Anmeldung aufgenommen werden.',
                },
                acceptedSection: 'Wie sich Mitglieder anmelden',
                acceptedHelp: 'Welche Anmeldung dieses Team akzeptiert, bevor Team-Arbeit erlaubt ist.',
                acceptedInherit: 'Richtlinie des Home verwenden',
                acceptedRestricted: 'Nur die unten ausgewählte Anmeldung',
                connectionsSection: 'Akzeptierte Verbindungen',
                connectionsEmpty: 'Wähle mindestens eine Anmeldeverbindung oder verwende die Richtlinie des Home.',
                homeMethodRetained: 'Aus der gespeicherten Richtlinie übernommen',
                repairRequired: 'Die gespeicherte Anmeldebeschränkung ist nicht lesbar',
                repairRequiredHelp: 'Sie wird nicht wie geschrieben angewendet. Wähle unten eine Richtlinie, um sie zu ersetzen.',
                conflictBody: 'Die Anmelderichtlinie hat sich in diesem Home geändert. Prüfe sie und wende deine Änderung erneut an.',
                providerTestRequired: 'Teste diese Anmeldeverbindung, bevor das Team sie verlangen kann.',
                unavailable: 'Dieses Home kann diese Anmelderichtlinie nicht akzeptieren.',
                approvalPending: 'Warten auf Genehmigung',
                connectionOwnerTeam: "Team-Verbindung",
                connectionOwnerHome: "Anmeldeverfahren des Home",
            },
            subtitle: 'Wie Teammitglieder ihre Identität nachweisen.',
            memberSignIn: {
                section: 'Anmeldeseite für Mitglieder',
                open: 'Anmeldeseite für Mitglieder öffnen',
                copyLink: 'Link kopieren',
                shareLink: 'Link teilen',
                qrLabel: 'QR-Code für den Anmeldelink für Mitglieder',
                footer: 'Wer diesen Link hat, erreicht die Anmeldeseite dieses Teams. Der Link gewährt für sich genommen nichts: Der Beitritt folgt weiterhin der Aufnahmerichtlinie des Teams.',
                unavailable: 'Kein teilbarer Link',
                unavailableBody: 'Dieses Home veröffentlicht keine Webadresse, daher gibt es keinen Link, der auf einem anderen Gerät funktionieren würde. Eine Home-Administratorin oder ein Home-Administrator kann eine einrichten.',
            },
            connectionsSection: 'Anmeldeverbindungen',
            homeMethodsUnavailable: 'Die Anmeldemethoden dieses Homes konnten nicht gelesen werden.',
            connectionsDescription: 'Firmenanmeldung, die dieses Team nutzen kann.',
            add: {
                fixTurnOn: "Einschalten",
                action: 'Verbindung hinzufügen',
                askNamed: ({ names }: { names: string }) => `Frag ${names}.`,
                askUnnamed: 'Frag einen Inhaber des Homes.',
                fixInSignInProviders: 'Einrichten',
                fixInReach: 'In Erreichbarkeit festlegen',
                reason: {
                    contactHomeAdmin: ({ home }: { home: string }) => `${home} richtet das für seine Teams ein.`,
                    workosPlatform: ({ home }: { home: string }) => `WorkOS ist auf ${home} noch nicht eingerichtet.`,
                    providerDisabled: ({ home }: { home: string }) => `Von ${home}. Dort ist es ausgeschaltet.`,
                    homeProhibited: ({ home, provider }: { home: string; provider: string }) => `${home} erlaubt Teams nicht, ${provider} hinzuzufügen.`,
                    homeUnavailable: ({ home }: { home: string }) => `${home} hat das für Teams nicht freigegeben.`,
                    publicAddress: ({ home }: { home: string }) => `Dein Anbieter braucht eine öffentliche Adresse von ${home}, um Personen zurückzuschicken.`,
                },
            },
            empty: 'Keine Anmeldeverbindungen',
            status: {
                unavailable: 'Nicht verfügbar',
                prohibited: 'Durch die Home-Richtlinie blockiert',
                notConfigured: 'Nicht konfiguriert',
                settingUp: 'Wird eingerichtet',
                needsAttention: 'Aufmerksamkeit erforderlich',
            },
            mode: {
                signInOnly: 'Nur Anmeldung',
                signInTimeGroups: 'Gruppen werden bei der Anmeldung aktualisiert',
            },
            detail: {
                status: 'Zustand',
                mode: 'Modus',
                provider: 'Anbieter',
                restrictions: 'Anmeldebeschränkungen',
                allowedUsers: 'Zulässige Benutzer',
                allowedDomains: 'Zulässige E-Mail-Domains',
                none: 'Keine',
                configuration: 'Konfiguration',
                organization: 'Organisation',
                connection: 'Verbindung',
            },
            directory: {
                connect: "Verbinden",
                actions: {
                    section: 'Aktionen', sync: 'Jetzt synchronisieren', pause: 'Synchronisierung pausieren', resume: 'Synchronisierung fortsetzen', remove: 'Verzeichnis entfernen…',
                    pauseTitle: ({ source }: { source: string }) => `${source} pausieren?`, pauseBody: 'Neue Verzeichnisänderungen werden angehalten. Bekannte Team-Zugriffe und Gruppenbeiträge bleiben bis zur Fortsetzung erhalten.',
                    removeTitle: ({ source }: { source: string }) => `${source} entfernen?`, removeMembers: ({ count }: { count: number }) => count === 1 ? '1 Person, die über dieses Verzeichnis beigetreten ist, verlässt das Team.' : `${count} Personen, die über dieses Verzeichnis beigetreten sind, verlassen das Team.`, removeGroupMemberships: ({ count }: { count: number }) => count === 1 ? '1 von ihm gesetzte Gruppenmitgliedschaft wird entfernt.' : `${count} von ihm gesetzte Gruppenmitgliedschaften werden entfernt.`, removeNothing: "Keine Mitgliedschaften hängen davon ab.", removeKept: "Accounts, von ihm erstellte Gruppen und anders hinzugefügte Personen bleiben erhalten.",
                },
                section: "Verwaltete Mitgliedschaft",
                overviewSubtitle: "Verzeichnisquellen gleichen Teammitgliedschaften und Gruppen mit einer externen Organisation ab.",
                manageSubtitle: "Verbundene Verzeichnisquellen und ihren letzten Synchronisierungsstatus prüfen.",
                title: "Verzeichnissynchronisierung",
                sourcesSection: "Verzeichnisquellen",
                sourcesLoadMore: "Weitere Quellen laden",
                subtitle: "Änderungen aus dem Verzeichnis erscheinen hier nach jeder Synchronisierung.",
                purpose: "Halte Mitglieder und Gruppen dieses Teams mit deinem Firmenverzeichnis abgeglichen.",
                sourcePurpose: "Die Personen und Gruppen, die dieses Verzeichnis mit dem Team abgleicht.",
                empty: "Keine Verzeichnisquellen",
                emptyBody: "Verbinde dein Firmenverzeichnis, und das Team folgt ihm: Wer dort hinzukommt, kommt ins Team; wer geht, verliert den Zugriff.",
                setup: {
                    add: "Quelle hinzufügen",
                    options: "Verzeichnisquelle auswählen",
                    optionsFooter: "Nichts ändert sich, bevor die erste Synchronisierung abgeschlossen ist.",
                    loadMore: "Mehr laden",
                    empty: "Noch keine verifizierten Quellen verfügbar",
                    workos: "WorkOS-Verzeichnissynchronisierung einrichten",
                    workosSubtitle: "Öffne das WorkOS-Adminportal und kehre zurück, um das verifizierte Verzeichnis auszuwählen.",
                    confirmTitle: ({ source }: { source: string }) => `${source} hinzufügen?`,
                    confirmBody: "Happier beginnt nach dem Hinzufügen mit dem Import dieses Verzeichnisses.",
                },
                people: {
                    section: "Personen",
                    empty: "Keine bereitgestellten Personen",
                    provisioned: "Bereitgestellt · Noch kein Konto",
                    boundAccountCount: ({ count }: { count: number | string }) => `Verknüpfte Konten: ${count}`,
                    unboundPeopleCount: ({ count }: { count: number | string }) => `Bereitgestellte Personen ohne Konto: ${count}`,
                    member: "Teammitglied",
                    unknown: "Unbenannte Person",
                    loadMore: "Weitere Personen laden",
                    state: {
                        suspended: "Angehalten",
                        deleted: "Gelöscht",
                    },
                },
                kind: {
                    workos: "WorkOS-Verzeichnissynchronisierung",
                    github: "GitHub-Organisation",
                },
                state: {
                    setup: "Einrichtung erforderlich",
                    syncing: "Wird synchronisiert",
                    active: "Aktiv",
                    paused: "Pausiert",
                    needsAttention: "Aktion erforderlich",
                    initializing: "Wird eingerichtet",
                    failed: "Letzte Synchronisierung fehlgeschlagen",
                },
                mode: {
                    eventsAndFull: "Ereignisse und vollständiger Abgleich",
                    fullOnly: "Nur vollständiger Abgleich",
                },
                freshness: {
                    never_synced: "Nie synchronisiert",
                    fresh: "Aktuell",
                    stale: "Veraltet",
                    unknown: "Unbekannt",
                },
                detail: {
                    status: "Zustand",
                    sourceType: "Quelltyp",
                    syncSection: "Synchronisierungsstatus",
                    mode: "Synchronisierungsmodus",
                    freshness: "Aktualität",
                    lastSuccess: "Letzte erfolgreiche Synchronisierung",
                    nextScheduled: "Nächste geplante Synchronisierung",
                    attentionSection: "Aktion erforderlich",
                    attentionTitle: "Diese Verzeichnisquelle erfordert Aufmerksamkeit",
                    attentionRetryable: "Die Quelle kann sich erholen, nachdem ihre Verbindung repariert wurde. Aktualisieren Sie, um den neuesten Status zu prüfen.",
                    attentionAdmin: "Prüfen Sie die Quellkonfiguration, bevor Sie sich auf neue Verzeichnisänderungen verlassen.",
                },
                never: "Nie",
                unknown: "Unbekannt",
            },
        },
        settings: {
            archiveDescription: 'Beim Archivieren verschwindet das Team aus den aktiven Ansichten und teambasierter Zugriff endet. Mitglieder, Gruppen und Verlauf bleiben erhalten, und es kann wiederhergestellt werden.',
            logoSection: 'Logo',
            sessionDefaultsSection: 'Session-Standardwerte',
            sharingSection: 'Teilen',
            sharingDescription: 'Gilt ab jetzt. Bereits Geteiltes ändert sich nicht.',
            option: {
                private: 'Privat',
                shared: 'Geteilt',
                alwaysShared: 'Immer geteilt',
                anyone: 'Alle',
                admins: 'Administratoren',
                nobody: 'Niemand',
                fromJoining: 'Ab Beitritt',
                earlierToo: 'Auch frühere',
            },
            consequence: {
                sessionsPrivate: ({ team }: { team: string }) => `Privat starten; jede Person wählt, was sie mit ${team} teilt.`,
                sessionsShared: ({ team }: { team: string }) => `Mit ${team} geteilt starten; jede Person kann eine privat halten.`,
                sessionsAlwaysShared: ({ team }: { team: string }) => `Jede neue Sitzung wird mit ${team} geteilt.`,
                outsideAnyone: ({ team }: { team: string }) => `Wer eine Sitzung teilen kann, darf sie auch außerhalb von ${team} teilen.`,
                outsideAdmins: ({ team }: { team: string }) => `Nur Admins von ${team} können eine Sitzung außerhalb teilen.`,
                outsideNobody: ({ team }: { team: string }) => `Sitzungen können nicht außerhalb von ${team} geteilt werden.`,
                historyFromJoining: ({ team }: { team: string }) => `Mit ${team} geteilte Sitzungen ab ihrem Beitritt.`,
                historyEarlier: ({ team }: { team: string }) => `Auch Sitzungen, die vor ihrem Beitritt mit ${team} geteilt wurden.`,
            },
            externalSharingSection: 'Externes Teilen',
            historyDefaultSection: 'Verlaufsstandard',
            saved: 'Gespeichert',
        },
        policy: {
            sessionCreationPrivate: 'Standardmäßig privat',
            sessionCreationTeam: 'Standardmäßig mit dem Team geteilt',
            sessionCreationRequired: 'Immer mit dem Team geteilt',
            sessionCreationHelp: 'Dies gilt für neue Sessions. Bestehende private Sessions werden nicht offengelegt.',
            externalSharingAllowed: 'Alle, die teilen dürfen',
            externalSharingAdmins: 'Nur Team-Administration',
            externalSharingDisabled: 'Nicht erlaubt',
            externalSharingHelp: 'Dies kann künftiges Teilen verhindern. Bereits geteilte Kopien werden nicht zurückgezogen.',
            historyDefaultHelp: 'Dies wählt die Option für neue Mitglieder vor. Der Verlauf bestehender Mitglieder wird nicht überschrieben.',
        },
        logo: {
            add: 'Logo hinzufügen',
            replace: 'Logo ersetzen',
            remove: 'Logo entfernen',
            removeConfirmTitle: 'Dieses Logo entfernen?',
            removeConfirmBody: 'Das Team zeigt wieder sein Monogramm. Du kannst jederzeit ein neues Logo hochladen.',
            previewLabel: 'Logo-Vorschau',
            useAsLogo: 'Als Logo verwenden',
            monogramLabel: 'Team-Monogramm',
            tooLarge: 'Dieses Bild ist zu groß. Wähle ein kleineres.',
            invalidFormat: ({ formats }: { formats: string }) => `Diese Datei ist kein unterstütztes Bild. Unterstützte Formate: ${formats}.`,
            failed: 'Das Logo wurde nicht hochgeladen. Das aktuelle Logo bleibt unverändert.',
            retry: 'Erneut versuchen',
        },
        archive: {
            archivedTitle: ({ name }: { name: string }) => `${name} ist archiviert`,
            archivedBody: "Der Team-Zugriff ist gestoppt und hier lässt sich nichts ändern. Mitglieder, Gruppen und Verlauf bleiben erhalten.",
            confirm: {
                keptCounted: ({ members, groups }: { members: number; groups: number }) => `${members === 1 ? '1 Mitglied' : `${members} Mitglieder`}, ${groups === 1 ? '1 Gruppe' : `${groups} Gruppen`} und ihr Verlauf bleiben erhalten.`,
                kept: "Mitglieder, Gruppen und ihr Verlauf bleiben erhalten.",
                invitationsStop: ({ count }: { count: number }) => count === 1 ? '1 wartender Einladungslink funktioniert nicht mehr, auch nach dem Wiederherstellen nicht.' : `${count} wartende Einladungslinks funktionieren nicht mehr, auch nach dem Wiederherstellen nicht.`,
                restore: "Jederzeit wiederherstellbar; erhaltene Zugriffe gelten wieder, wo sie noch zutreffen.",
            },
            openSettings: 'Einstellungen öffnen',
            action: ({ name }: { name: string }) => `${name} archivieren`,
            confirmTitle: ({ name }: { name: string }) => `${name} archivieren?`,
            restoreAction: ({ name }: { name: string }) => `${name} wiederherstellen`,
            restoreTitle: ({ name }: { name: string }) => `${name} wiederherstellen?`,
            restoreBody: () => 'Aktuelle Mitgliedschaften, Gruppen und erhaltene Berechtigungen werden wieder aktiv, soweit Accounts und Ressourcen dies weiterhin zulassen. Widerrufene Einladungslinks kehren nicht zurück.',
            readOnly: 'Dieses Team ist archiviert. Stelle es wieder her, um es zu ändern.',
        },
        members: {
            roleReadOnly: ({ team }: { team: string }) => `Nur Inhaber und Admins von ${team} ändern Rollen.`,
            roleSetBy: ({ source }: { source: string }) => `Festgelegt von ${source}.`,
            accessSection: "Zugriff",
            lifecycleFootnote: "Sperren stoppt den Zugriff, bis du die Person reaktivierst. Entfernen beendet ihn; was sie geschrieben hat, bleibt, und ein erneuter Beitritt beginnt eine neue Mitgliedschaft.",
            removal: {
                title: ({ name, team }: { name: string; team: string }) => `${name} aus ${team} entfernen?`,
                action: ({ team }: { team: string }) => `Aus ${team} entfernen…`,
                ends: "Der Team- und Gruppenzugriff endet sofort.",
                leavesGroups: ({ groups }: { groups: string }) => `Die Person verlässt ${groups}.`,
                leavesGroupsAndMore: ({ groups }: { groups: string }) => `Die Person verlässt ${groups} und ihre weiteren Gruppen.`,
                kept: "Sitzungen und Nachrichten, die sie geschrieben hat, bleiben, wo sie sind.",
            },
            filterLabel: 'Anzeigen',
            searchPlaceholder: 'Mitglieder suchen',
            filterAll: 'Alle',
            filterOwnersAndAdmins: 'Eigentümer und Administration',
            addMenu: {
                existing: 'Jemanden aus diesem Home hinzufügen',
                existingBody: ({ home }: { home: string }) => `Wähle aus Personen, die bereits ein Konto auf ${home} haben.`,
                invite: 'Per Link oder E-Mail einladen',
                inviteBody: ({ team }: { team: string }) => `Für alle anderen. Sie treten ${team} bei, wenn sie annehmen.`,
            },
            filterMembers: 'Mitglieder',
            filterGuests: 'Gäste',
            filterSuspended: 'Gesperrt',
            emptyTitle: 'Keine passenden Mitglieder',
            emptyBody: 'Passe den Filter an oder lade jemanden in dieses Team ein.',
            add: 'Mitglied hinzufügen',
            addTitle: ({ team }: { team: string }) => `Zu ${team} hinzufügen`,
            personLabel: 'Person',
            roleLabel: 'Rolle',
            personPlaceholder: 'Personen auf diesem Home suchen',
            ineligible: 'Bereits in diesem Team oder kein aktives Konto auf diesem Home.',
            addSubmit: 'Mitglied hinzufügen',
            you: 'Du',
            joined: ({ when }: { when: string }) => `Beigetreten am ${when}`,
            managedBy: ({ source }: { source: string }) => `Verwaltet über ${source}`,
            managedReadOnly: 'Diese Mitgliedschaft wird an ihrer Quelle verwaltet. Ändere sie dort.',
            detailManagedBy: 'Verwaltet von',
            managementTitle: 'Verwaltungsquelle',
            managementHelp: 'Ein Wechsel der Quelle behält diese Mitgliedschaft, ihre Rolle, ihren Status und ihren Sitzungsverlauf. Nur die Zuständigkeit wechselt.',
            managementNative: 'In Happier verwaltet',
            managementConflict: 'Diese Quelle hat noch keine freie Identität für diese Person. Synchronisiere sie und versuche es erneut.',
            encryption: {
                title: 'Verschlüsselter Zugriff',
                checking: 'Verschlüsselter Zugriff wird geprüft…',
                ready: 'Vorbereitet',
                scopeBody: 'Hier werden nur die von dir verwalteten Sitzungen berücksichtigt. Andere Sitzungsmanager müssen den Zugriff möglicherweise noch vorbereiten.',
                pending: 'Vorbereitung nötig',
                prepare: 'Verschlüsselten Zugriff vorbereiten',
                preparing: ({ prepared }: { prepared: number }) => `Verschlüsselter Zugriff wird vorbereitet · ${prepared} vorbereitet`,
                setupRequired: 'Einrichtung erforderlich',
                setupRequiredBody: 'Diese Person hat die Einrichtung des verschlüsselten Zugriffs noch nicht abgeschlossen. Danach kannst du ihren Sitzungsverlauf vorbereiten.',
                notEncrypted: 'Nicht verschlüsselt',
                plainAccount: 'Das Konto dieser Person nutzt keine Ende-zu-Ende-Verschlüsselung, es gibt also nichts vorzubereiten.',
                repairRequired: 'Verschlüsselter Zugriff muss repariert werden',
                repairBody: 'Einige Sitzungen, die du verwaltest, lassen sich auf diesem Gerät nicht vorbereiten. Öffne sie, um deinen eigenen Zugriff zu reparieren.',
                nonTransferableBody: 'Einige Sitzungen nutzen ein älteres Verschlüsselungsformat, das nicht mit neuen Mitgliedern geteilt werden kann. Für Personen mit bestehendem Zugriff bleiben sie lesbar.',
                recipientChanged: 'Das Konto dieser Person hat sich geändert. Es wird neu geladen, bevor erneut vorbereitet wird.',
                retry: 'Erneut versuchen',
                failed: 'Die Vorbereitung wurde vor dem Ende gestoppt. Bereits Vorbereitetes bleibt erhalten.',
            },
            detailGroups: 'Gruppen',
            detailGroupsEmpty: 'Keine Gruppen',
            suspend: 'Mitglied sperren',
            suspendTitle: ({ name }: { name: string }) => `${name} sperren?`,
            suspendBody: 'Der Zugriff auf Team und Gruppen endet sofort. Gruppenzugehörigkeit und Ressourcenzuweisungen bleiben erhalten, und eine Entsperrung stellt nur noch gültigen Zugriff wieder her. Der Home-Account und andere Teams bleiben unberührt.',
            reactivate: 'Mitglied entsperren',
            reactivateTitle: ({ name }: { name: string }) => `${name} entsperren?`,
            reactivateBody: 'Der Zugriff wird dort fortgesetzt, wo Mitgliedschaften, Gruppen und Account-Status ihn weiterhin zulassen.',
            remove: 'Aus dem Team entfernen',
            lastOwnerBlocked: 'Ein Team behält mindestens eine aktive Eigentümerrolle. Wähle zuerst eine andere.',
            accountInactive: 'Der Account dieser Person ist nicht aktiv, daher kann sie weder hinzugefügt noch zur Eigentümerin gemacht werden.',
            ownerOnlyAction: 'Nur eine Team-Eigentümerrolle kann Eigentümer ändern.',
            ownerRequiredTitle: 'Eigentümerrolle erforderlich',
            ownerRequiredBody: ({ team }: { team: string }) => `${team} benötigt eine aktive Eigentümerrolle für Änderungen, die nur Eigentümern vorbehalten sind.`,
            chooseOwner: 'Eigentümerrolle wählen',
            ownerRequiredNoCandidate: 'Es steht kein geeignetes Mitglied bereit. Ein vorhandenes Mitglied muss hinzugefügt oder die Eigentümerschaft übergeben werden.',
        },
        groups: {
            detailsSection: 'Gruppe',
            title: 'Gruppen',
            emptyTitle: 'Noch keine Gruppen',
            emptyBody: 'Eine Gruppe ist eine flache Menge von Teammitgliedern, mit denen du gemeinsam teilen kannst.',
            emptyRosterTitle: 'Noch keine Mitglieder in dieser Gruppe',
            noEligibleCandidatesTitle: 'Niemand zum Hinzufügen',
            noEligibleCandidatesBody: 'Teammitglieder, die noch nicht in dieser Gruppe sind, erscheinen hier.',
            create: 'Neue Gruppe',
            nameLabel: 'Name',
            namePlaceholder: 'Entwicklung',
            descriptionPlaceholder: 'Wofür diese Gruppe da ist',
            submit: 'Gruppe erstellen',
            nameTaken: 'In diesem Team gibt es bereits eine Gruppe mit diesem Namen.',
            memberCount: ({ count }: { count: number }) => `${count} Mitglieder`,
            managedBy: ({ source }: { source: string }) => `Verwaltet von ${source}`,
            membersSection: 'Gruppenmitglieder',
            addMember: 'Zur Gruppe hinzufügen',
            removeNative: 'Aus der Gruppe entfernen',
            removeMemberTitle: ({ name, group }: { name: string; group: string }) => `${name} aus ${group} entfernen?`,
            removeMemberBody: ({ name, group }: { name: string; group: string }) => `${name} verliert sofort den Zugriff, der aus ${group} stammt. Die Person bleibt im Team und kann dieser Gruppe wieder hinzugefügt werden.`,
            externalOnlyTitle: 'An der Quelle verwaltet',
            externalOnlyBody: ({ source }: { source: string }) => `${source} steuert diese Person weiterhin bei, sie bleibt deshalb in der Gruppe. Ändere das in den Einstellungen dieser Quelle.`,
            archiveAction: ({ name }: { name: string }) => `${name} archivieren`,
            archiveTitle: ({ name }: { name: string }) => `${name} archivieren?`,
            archiveBody: 'Gruppenbasierter Zugriff endet sofort. Mitgliedschaft und Verlauf bleiben erhalten, und eine Wiederherstellung der Gruppe kann diese Berechtigungen wieder wirksam machen.',
            restoreAction: ({ name }: { name: string }) => `${name} wiederherstellen`,
            archivedSection: 'Archivierte Gruppen',
            archivedReadOnly: 'Diese Gruppe ist archiviert. Stelle sie wieder her, um sie zu ändern.',
            managedReadOnly: 'Name und Lebenszyklus dieser Gruppe werden an ihrer Quelle verwaltet. Mitglieder lassen sich hier trotzdem hinzufügen.',
        },
        invitations: {
            waitingSection: "Ausstehend",
            finishedSection: "Abgeschlossen",
            sendAgain: "Erneut senden",
            emptyTitle: 'Keine Einladungen',
            emptyBody: 'Lade jemanden mit einem Link ein oder füge eine Person hinzu, die bereits einen Account auf diesem Home hat.',
            invite: 'Einladen',
            inviteTitle: ({ team }: { team: string }) => `Zu ${team} einladen`,
            byLink: 'Link',
            byEmail: 'E-Mail',
            emailLabel: 'E-Mail-Adresse',
            emailPlaceholder: 'name@beispiel.de',
            create: 'Einladung erstellen',
            linkNotice: ({ team, role }: { team: string; role: string }) => `Wer auf diesem Home angemeldet ist und diesen Link hat, kann ${team} als ${role} beitreten.`,
            copyLink: 'Link kopieren',
            copied: 'Link kopiert',
            qrLabel: 'QR-Code für diesen Einladungslink',
            qrTooLargeFallback: 'Dieser Link ist zu lang für einen QR-Code. Kopiere ihn stattdessen.',
            linkRow: 'Einladungslink',
            maskedRecipient: ({ email }: { email: string }) => `Für ${email}`,
            expires: ({ when }: { when: string }) => `Läuft ab am ${when}`,
            stateActive: 'Aktiv',
            stateAccepted: 'Angenommen',
            stateRevoked: 'Widerrufen',
            stateExpired: 'Abgelaufen',
            deliverySent: 'E-Mail übermittelt',
            deliveryFailed: 'E-Mail-Zustellung fehlgeschlagen',
            deliveryUnknown: 'Zustellergebnis unbekannt',
            deliveryRetry: 'Erneut versuchen',
            deliveryChangeEmail: 'E-Mail ändern',
            emailUnavailable: 'E-Mail-Versand ist auf diesem Home nicht verfügbar. Teile stattdessen einen Link.',
            reissue: 'Neuen Link erstellen',
            reissueNotice: 'Beim Neuausstellen entsteht ein neuer Link. Der bisherige Link wird nicht mehr funktionieren.',
            revoke: 'Einladung widerrufen',
            revokeTitle: 'Diese Einladung widerrufen?',
            revokeBody: 'Der Link funktioniert sofort nicht mehr. Du kannst jederzeit einen neuen erstellen.',
            shareLink: 'Link teilen',
            shareUnavailable: 'Teilen ist auf diesem Gerät nicht verfügbar. Kopiere stattdessen den Link.',
            bearerUnavailable: 'Dieser Link wurde einmal angezeigt und wird nicht gespeichert. Erstelle einen neuen Link, um den Zugriff erneut zu teilen.',
            linkUnavailableRow: 'Kein teilbarer Link',
            linkUnavailableBody: 'Dieses Home hat keine Adresse veröffentlicht, auf die Einladungslinks verweisen können, also gibt es keinen Link zum Teilen. Bitte eine Home-Administratorin, eine zu veröffentlichen, oder füge Personen über die Personenliste der Team hinzu.',
        },
        join: {
            previewLoading: 'Diese Einladung wird geprüft…',
            joinAction: ({ team }: { team: string }) => `${team} beitreten`,
            joinWithCurrentAccount: 'Mit diesem Konto beitreten',
            addInvitedAddressNotice: ({ email }: { email: string }) => `${email} wird diesem Konto als bestätigte Adresse hinzugefügt.`,
            useAnotherAccount: 'Anderes Konto verwenden',
            useCurrentAccount: 'Aktuelles Konto verwenden',
            useAnotherAccountHint: 'Melde dich auf diesem Home an, ohne dieses Konto abzumelden.',
            hostedOn: ({ home }: { home: string }) => `Gehostet auf ${home}`,
            personalHomeNotice: 'Dieses Home läuft auf einem persönlichen Computer und kann offline nicht verfügbar sein.',
            plainStorageNotice: 'Sessions auf diesem Home werden ohne Ende-zu-Ende-Verschlüsselung gespeichert.',
            invitedBy: ({ name }: { name: string }) => `Einladung von ${name}.`,
            roleOffered: ({ role }: { role: string }) => `Du wirst als ${role} eingeladen.`,
            guestNotice: ({ team }: { team: string }) => `Ein Beitritt als Gast gibt keinen Zugriff auf die Team-Sessions von ${team}. Inhalte müssen ausdrücklich mit dir oder einer deiner Gruppen geteilt werden.`,
            joinedTitle: 'Du bist beigetreten',
            alreadyMemberTitle: 'Du bist bereits Mitglied',
            openTeam: ({ team }: { team: string }) => `${team} öffnen`,
            expiredTitle: 'Diese Einladung ist abgelaufen',
            revokedTitle: 'Diese Einladung wurde widerrufen',
            usedTitle: 'Diese Einladung wurde bereits verwendet',
            archivedTitle: 'Dieses Team ist archiviert',
            inactiveTitle: 'Dieser Account kann derzeit nicht beitreten',
            invalidTitle: 'Dieser Einladungslink ist ungültig',
            unresolvedHomeTitle: 'Dieser Link nennt sein Home nicht',
            unresolvedHomeBody: 'Dieses Gerät kann nicht feststellen, welches Home diese Einladung ausgestellt hat; es wurde nichts gesendet. Bitte eine Team-Verwaltung um einen neuen Link.',
            unknownHomeTitle: 'Dieses Home ist noch nicht auf diesem Gerät',
            askForNew: 'Bitte die Teamverwaltung um eine neue Einladung.',
            mismatchTitle: 'Diese Einladung gilt für eine andere Adresse',
            signInWithInvited: 'Mit der eingeladenen Adresse anmelden',
            verifyAddress: 'Diese Adresse bestätigen',
            updateRequiredTitle: 'Dieses Home benötigt ein Update für Team-Einladungen',
            offlineTitle: 'Dieses Home ist nicht erreichbar',
            offlineBody: 'Die Einladung bleibt erhalten. Versuche es erneut, sobald das Home wieder da ist.',
            acceptanceOutcomeUnknown: 'Es konnte nicht bestätigt werden, ob du beigetreten bist. Versuche es erneut, um dieselbe Einladung zu prüfen.',
            retry: 'Erneut versuchen',
        },
        credentials: {
            recovery: {
                openSettings: 'Zugangsdaten-Einstellungen \u00f6ffnen',
                selectBroker: 'Broker-Standort w\u00e4hlen',
                ownerHandoff: 'Bitte die Inhaberin oder den Inhaber der Quelle, diese Zugangsdaten zu reparieren',
                updateApp: 'Happier aktualisieren',
                chooseAnother: 'Andere Zugangsdaten w\u00e4hlen',
            },
            requestPolicy: {
                title: 'Anfragerichtlinie',
                subtitle: 'Grenze ein, worum diese Zugangsdaten gebeten werden dürfen.',
                summaryNone: 'Keine Einschränkungen',
                summaryActive: ({ count }: { count: number }) => `${count} Einschränkungen`,
                protocolsLabel: 'Anfrageformate',
                protocolsAny: 'Alle, die die Quelle unterstützt',
                modelsLabel: 'Modelle',
                modelsAny: 'Alle Modelle, die die Quelle anbietet',
                modelsAllowed: ({ count }: { count: number }) => `${count} erlaubt`,
                effortLabel: 'Denkaufwand',
                effortAny: 'Alle, die die Quelle unterstützt',
                catalogUnavailable: 'Auszuwählen, welche Modelle erlaubt sind, ist von diesem Home aus noch nicht möglich. Die aktuelle Auswahl bleibt gültig, bis sie entfernt wird.',
                clear: 'Alle Einschränkungen entfernen',
                activeNote: 'Eine bereits laufende Session wird nicht umgeschrieben. Ihre nächste Anfrage muss die neue Richtlinie erfüllen.',
                protocol: {
                    openaiResponses: 'OpenAI Responses',
                    openaiChatCompletions: 'OpenAI Chat Completions',
                    anthropicMessages: 'Anthropic Messages',
                },
            },
            directReadiness: {
                title: 'Bereitschaft für direkten Zugriff',
                check: 'Bereitschaft prüfen',
                summary: ({ ready, pending }: { ready: number; pending: number }) => `${ready} bereit · ${pending} in Vorbereitung`,
                allReady: 'Alle mit direktem Zugriff sind bereit.',
                automatic: 'Das Material wird auf dem Computer vorbereitet, der diese Quelle hält, sobald er online ist.',
                state: {
                    ready: 'Bereit',
                    preparing: 'Zugriff wird vorbereitet',
                    notDelivered: 'Noch nicht übermittelt',
                    recipientBindingChanged: 'Wartet auf die Einrichtung des verschlüsselten Kontos',
                    sourceChanged: 'Quelle geändert – wird aktualisiert',
                },
            },
            externalApi: {
                title: 'Externer API-Zugriff',
                subtitle: 'Nutze diesen Anbieter aus kompatiblen Tools außerhalb von Happier.',
                privateTitle: 'Happier-Sessions',
                privateDetail: 'Privat über Happier',
                unavailable: 'Externer API-Zugriff ist auf diesem Home nicht verfügbar.',
                publicHttpsRequired: 'Externe Tools benötigen eine öffentliche HTTPS-Adresse für dieses Home.',
                homeDisclosure: 'Unverarbeitete Anfrageinhalte an den Anbieter laufen über den öffentlichen HTTPS-Endpunkt dieses Homes und sind für dessen Betreiber lesbar.',
                bearerDisclosure: 'Dieser Schlüssel ist ein Bearer-Secret. Wer ihn besitzt, kann den zugewiesenen Zugriff bis zum Ablauf oder Widerruf nutzen.',
                usageDisclosure: 'Happier erfasst die Anzahl der Anfragen. Token- und Kostensummen können unvollständig sein, wenn ein Protokoll sie nicht meldet.',
                keysTitle: 'API-Schlüssel',
                authorize: 'Schlüssel autorisieren',
                authenticationRequired: 'Das zugewiesene Mitglied muss diesen Schlüssel mit seiner Team-Anmeldung autorisieren.',
                authenticationUnavailable: 'Die Team-Authentifizierung ist nicht verfügbar. Bitte einen Team-Administrator, die Anmelderichtlinie zu prüfen.',
                keysLoadFailed: 'Die API-Schlüssel konnten nicht geladen werden.',
                keysRetry: 'API-Schlüssel erneut laden',
                keysEmpty: 'Noch keine Schlüssel',
                keysEmptyBody: 'Der erste Schlüssel schaltet den externen Zugriff ein; das Widerrufen des letzten schaltet ihn aus.',
                labelPlaceholder: 'Wofür dieser Schlüssel ist',
                assignLabel: 'Zugerechnet zu',
                revealTitle: 'Sichere diesen Schlüssel jetzt',
                revealBody: 'Er wird nicht noch einmal angezeigt.',
                revealDismiss: {
                    title: 'Schließen, ohne den Schlüssel zu kopieren?',
                    body: 'Dieser Schlüssel kann nicht erneut angezeigt werden. Lass ihn sichtbar, bis du ihn gespeichert hast.',
                    confirm: 'Ich habe den Schlüssel gespeichert',
                    keepVisible: 'Schlüssel sichtbar lassen',
                },
                neverUsed: 'Nie benutzt',
                lastUsed: ({ when }: { when: string }) => `Zuletzt benutzt ${when}`,
                expiresOn: ({ when }: { when: string }) => `Läuft ab ${when}`,
                expired: 'Abgelaufen',
                revokeTitle: ({ name }: { name: string }) => `${name} widerrufen?`,
                revokeBody: 'Tools, die diesen Schlüssel benutzen, hören sofort auf zu funktionieren. Happier-Sessions bleiben unberührt.',
                revokeAll: 'Alle Schlüssel widerrufen',
                revokeAllBody: 'Der externe API-Zugriff wird ausgeschaltet, bis ein neuer Schlüssel erstellt wird. Happier-Sessions bleiben unberührt.',
            },
            title: 'Geteilte Zugangsdaten',
            subtitle: 'Lass dieses Team ein verbundenes Konto, einen Pool oder einen Anbieter nutzen, ohne es in jede Einrichtung zu kopieren.',
            emptyTitle: 'Noch keine geteilten Zugangsdaten',
            emptyBody: 'Mit diesem Team wurde noch nichts geteilt.',
            forbidden: 'Geteilte Zugangsdaten verwalten die Eigent\u00fcmer und Admins dieses Teams.',
            unavailable: 'Dieses Home bietet keine geteilten Zugangsdaten an.',
            approvalPending: 'Warten auf Freigabe. Die Änderungen bleiben erhalten, bis entschieden ist.',
            approvalDeclined: 'Diese Anfrage wurde nicht freigegeben, es hat sich also nichts geändert.',
            sessionDeniedTitle: 'Geteilte Zugangsdaten haben diese Anfrage abgelehnt',
            sharedByYou: 'Von dir geteilt',
            providedByTeams: 'Von Teams bereitgestellt',
            sharedWithYou: 'Mit dir geteilt',
            sourceAdministration: { title: 'Mit Teams geteilt', empty: 'Diese Quelle wird mit keinem Team geteilt.' },
            source: {
                connectedAccount: 'Verbundenes Konto',
                pool: 'Pool verbundener Dienste',
                providerConnection: 'Anbieterverbindung',
            },
            delivery: {
                brokered: '\u00dcber Broker',
                direct: 'Direkter Zugriff',
                both: 'Broker + direkt',
                mixed: 'Gemischte Zustellung',
            },
            state: {
                available: 'Verf\u00fcgbar',
                needsAttention: 'Ben\u00f6tigt Aufmerksamkeit',
                disabled: 'Deaktiviert',
            },
            usePolicy: {
                title: 'Diese Session mit dem Team teilen?',
                label: 'Wo Mitglieder sie nutzen d\u00fcrfen',
                personalAllowed: 'Jede erlaubte Sitzung',
                teamContextRequired: 'Sitzungen, deren Team dieses ist',
                teamVisibilityRequired: 'Sitzungen, die dieses Team sehen kann',
                visibilityNote: 'Diese Zugangsdaten zu w\u00e4hlen kann eine private Sitzung mit dem Team teilen, nachdem die Person zugestimmt hat.',
            },
            selection: {
                activeTransitionUnsupported: 'Diese Sitzung lief bereits, bevor die Änderung gespeichert wurde, daher wurde das Modell nicht geändert. Versuche es erneut.',
            },
            detail: {
                sourceLabel: 'Quelle',
                brokerLabel: 'Broker-Standort',
                brokerNone: 'Broker-Standort auswählen',
                access: 'Zugriff und Zustellung',
                activity: 'Aktivit\u00e4t',
                edit: 'Bearbeiten',
                notFound: 'Diese geteilten Zugangsdaten sind nicht mehr verf\u00fcgbar.',
                brokerUnnamedMachine: 'Unbenannter Computer',
                brokerUnnamedPool: 'Unbenannter Pool',
                brokerChosen: 'Von der Quelleneigentümerin gewählt',
                limits: 'Obergrenzen',
                usage: 'Verbrauch',
            },
            create: {
                title: 'Zugangsdaten teilen',
                action: 'Zugangsdaten teilen',
                submit: 'Geteilte Zugangsdaten erstellen',
                sourceChoose: 'Quelle wählen',
                sourceEmpty: 'Hier lässt sich noch nichts teilen.',
                sourceUnsupported: 'Verbundene Konten und Anbieterverbindungen lassen sich aus diesem Home noch nicht teilen.',
                alreadyShared: 'Bereits mit diesem Team geteilt',
                poolAccounts: ({ count }: { count: number }) => `${count} Konten`,
                notAllowed: 'In diesem Team darfst du keine eigenen Zugangsdaten anbieten.',
                reviewLabel: 'Überblick',
            },
            edit: {
                title: 'Geteilte Zugangsdaten bearbeiten',
                nameLabel: 'Bezeichnung',
                namePlaceholder: 'Benenne diese Zugangsdaten',
                ceilingLabel: 'Direkte Weitergabe',
                ceilingBrokeredOnly: 'Nur \u00fcber Broker',
                ceilingDirectAllowed: 'Direkten Zugriff erlauben',
                ceilingNote: 'Direkter Zugriff l\u00e4sst lokale Werkzeuge der Empf\u00e4nger Zugangsmaterial erhalten. Zugriff zu entziehen stoppt k\u00fcnftige Zustellungen, l\u00f6scht aber nicht, was ein externer Prozess bereits genutzt hat.',
                conflict: 'Diese Einstellungen wurden anderswo ge\u00e4ndert. Lade neu, um vor dem Speichern die aktuellen Werte zu sehen.',
            },
            audience: {
                title: 'Zugriff und Zustellung',
                none: 'Noch niemand',
                everyone: 'Alle im Team',
                everyoneOff: 'Kein teamweiter Zugriff',
                groupCount: ({ count }: { count: number }) => `${count} Gruppen`,
                memberCount: ({ count }: { count: number }) => `${count} Personen`,
                add: 'Gruppe oder Person hinzufügen',
                groupsSection: 'Gruppen',
                membersSection: 'Personen',
                remove: 'Zugriff entziehen',
                ceilingBlocked: 'Direkter Zugriff ist f\u00fcr diese Zugangsdaten nicht erlaubt. Erlaube ihn zuerst unter Bearbeiten.',
                directTitle: 'Diese Zugangsdaten direkt teilen?',
                directBody: 'Lokale Werkzeuge der gew\u00e4hlten Personen k\u00f6nnen Zugangsmaterial dieser Quelle erhalten. Zugriff zu entziehen stoppt k\u00fcnftige Zustellungen, l\u00f6scht aber nicht, was ein externer Prozess bereits genutzt hat.',
                directConfirm: 'Direkt teilen',
                keepBrokered: 'Beim Broker bleiben',
                limitsNote: 'Direkte Nutzung geschieht au\u00dferhalb von Happier und wird nicht erfasst.',
            },
            directUse: {
                title: 'Diese geteilten Zugangsdaten direkt verwenden?',
                body: 'Happier kann Zugangsmaterial an lokale Werkzeuge dieser Session weitergeben. Fahre nur fort, wenn du diesen Werkzeugen mit den Zugangsdaten vertraust.',
            },
            delete: {
                action: 'Geteilte Zugangsdaten l\u00f6schen',
                title: ({ name }: { name: string }) => `${name} l\u00f6schen?`,
                body: 'Mitglieder verlieren den Zugriff sofort und die n\u00e4chste Anfrage schl\u00e4gt fehl. Bereits direkt zugestelltes Material l\u00e4sst sich nicht l\u00f6schen.',
            },
            errors: {
                featureDisabled: 'Dieses Home bietet keine geteilten Zugangsdaten an.',
                teamAuthenticationRequired: 'Melde dich zuerst bei diesem Team an.',
                teamAuthenticationPolicyUnavailable: 'Die Anmelderichtlinie dieses Teams konnte nicht gelesen werden, daher wurde nichts ge\u00e4ndert.',
                memberNotEligible: 'Diese Person kann diese Zugangsdaten nicht verwenden.',
                sessionPolicyIncompatible: 'Diese Zugangsdaten k\u00f6nnen in dieser Sitzung unter ihrer Freigaberichtlinie nicht verwendet werden.',
                brokerUnavailable: 'Die Broker-Maschine dieser Zugangsdaten ist gerade nicht erreichbar. Versuche es erneut, sobald sie zurück ist, oder wähle einen anderen Ort.',
                sourceOwnerRequired: 'Nur wer diese Quelle besitzt, kann diese Änderung vornehmen.',
                sourceMissing: 'Diese Zugangsdaten zeigen auf keine vorhandene Quelle mehr. Ihre Eigentümerin muss die Quelle erneut wählen.',
                invalidAudience: 'Diese Personen oder Gruppen können diese Zugangsdaten nicht erhalten.',
                subjectNotInTeam: 'Diese Person oder Gruppe gehört nicht mehr zu diesem Team.',
                costUnavailable: 'Eine Kostenobergrenze braucht einen Preis für jedes erlaubte Modell, und einigen fehlt er. Begrenze stattdessen Anfragen oder Tokens.',
                invalidLimit: 'Prüfe Messgröße, Zeitraum und Maximum.',
                limitIdentityImmutable: 'Für wen eine Obergrenze gilt, was sie misst und ihr Zeitraum lassen sich nicht ändern. Entferne sie und lege eine neue an.',
            },
            limits: {
                groupShared: 'Dieses Kontingent teilen sich alle Mitglieder der Gruppe.',
                title: 'Obergrenzen',
                empty: 'Noch keine Obergrenzen',
                emptyBody: 'Bis du eine anlegst, ist jede Anfrage erlaubt.',
                overshoot: 'Neue Anfragen stoppen, sobald der erfasste Verbrauch die Obergrenze erreicht. Bereits laufende Anfragen dürfen zu Ende gehen.',
                directNote: 'Obergrenzen gelten für die Nutzung über den Broker und die externe API. Direkte Nutzung passiert auf der Maschine der empfangenden Person und wird nicht erfasst.',
                directOnly: 'Alle mit Zugriff nutzen diese Zugangsdaten direkt auf ihrer eigenen Maschine. Happier erfasst davon nichts, und keine Obergrenze kann greifen.',
                requestLimitsOnlyForPersonalUse: 'Token-Obergrenzen erscheinen, wenn diese Zugangsdaten einen Team-Kontext verlangen. Persönliche Nutzung erlaubt auch Hintergrundläufen und der externen API den Zugriff, und diese melden nur Anfragen – daher decken nur Anfrage-Obergrenzen jede Nutzung ab.',
                add: 'Obergrenze hinzufügen',
                subjectLabel: 'Gilt für',
                subject: {
                    resource: 'Gesamte geteilte Zugangsdaten',
                    eachMember: 'Jede Person einzeln',
                    group: 'Gruppe',
                    member: 'Person',
                },
                metricLabel: 'Messgröße',
                metric: {
                    requests: 'Anfragen',
                    tokens: 'Tokens',
                    cost: 'Kosten',
                },
                costNote: 'Eine Kostenobergrenze funktioniert nur, wenn jedes erlaubte Modell einen bekannten Preis hat.',
                periodLabel: 'Zeitraum',
                period: {
                    day: 'Täglich',
                    week: 'Wöchentlich',
                    month: 'Monatlich',
                },
                maximumLabel: 'Maximum',
                maximumPlaceholder: 'Maximum je Zeitraum',
                maximumInvalid: 'Gib eine ganze Zahl größer als null ein.',
                maximumInvalidCost: 'Gib einen Betrag größer als null ein.',
                recorded: ({ recorded, maximum }: { recorded: string; maximum: string }) => `${recorded} von ${maximum} erfasst`,
                resetsUtc: ({ when }: { when: string }) => `Zurückgesetzt am ${when} UTC`,
                reached: 'Obergrenze erreicht',
                disabled: 'Ausgeschaltet',
                remove: 'Obergrenze entfernen',
                removeTitle: 'Diese Obergrenze entfernen?',
                removeBody: 'Anfragen werden sofort nicht mehr dagegen geprüft. Der erfasste Verbrauch bleibt erhalten.',
                unknownSubject: 'Jemand außerhalb dieser Seite',
            },
            usage: {
                title: 'Verbrauch',
                empty: 'In diesem Zeitraum wurde nichts erfasst.',
                rangeLabel: 'Zeitraum',
                brokeredRequests: 'Vermittelte Anfragen',
                directOnlyRequests: 'Anfragen werden nur für vermittelte Nutzung gezählt.',
                recordedRequests: 'Erfasste Anfragen',
                requestIncomplete: 'Nur von Happier beobachtete Anfragen sind enthalten.',
                externalObservationsIncomplete: ({ count }: { count: number }) => `Für ${count} externe ${count === 1 ? 'Anfrage ist' : 'Anfragen ist'} noch kein Ergebnis erfasst.`,
                breakdownRestricted: 'Einige Aufschlüsselungen sehen nur Verwaltende von Anmeldedaten.',
                export: 'CSV exportieren',
                exportFailed: 'Dieses Gerät konnte den Export nicht speichern.',
                recordedByHappier: 'Von Happier erfasst.',
                directIncomplete: 'Direkte Nutzung passiert außerhalb von Happier und ist womöglich nicht enthalten.',
                costIncomplete: 'Für einige Modelle sind in diesem Zeitraum keine Kosten verfügbar.',
                tokenIncomplete: 'Die Token-Summe ist für diesen Zeitraum unvollständig.',
                tokenUnavailable: 'Für diesen Zeitraum wurde keine Token-Nutzung beobachtet.',
                costUnavailable: 'Für diesen Zeitraum wurde keine Nutzung mit Preis beobachtet.',
                costUnknown: 'Nicht verfügbar',
                breakdownLabel: 'Aufschlüsseln nach',
                breakdownNone: 'Nur Summen',
                breakdown: {
                    member: 'Person',
                    externalApiKey: 'Externer API-Schlüssel',
                    model: 'Modell',
                    session: 'Sitzung',
                    sourceMember: 'Quellkonto',
                    workerMachine: 'Ausführende Maschine',
                    brokerMachine: 'Broker-Maschine',
                    deliveryMode: 'Zustellung',
                },
                limitsTitle: 'Obergrenzen in diesem Zeitraum',
                sliceSummary: ({ requests, tokens }: { requests: string; tokens: string }) => `${requests} Anfragen · ${tokens} Tokens`,
            },
            activity: {
                title: 'Aktivit\u00e4t',
                empty: 'Noch keine administrativen \u00c4nderungen erfasst.',
                unknownActor: 'Jemand',
                kind: {
                    resourceCreated: 'Hat diese Zugangsdaten geteilt',
                    resourceUpdated: 'Hat Einstellungen ge\u00e4ndert',
                    audienceChanged: 'Hat ge\u00e4ndert, wer sie nutzen darf',
                    resourceDeleted: 'Hat diese Zugangsdaten gel\u00f6scht',
                    directDelivered: 'Hat direkten Zugriff zugestellt',
                    externalKeyCreated: 'Hat einen externen API-Schl\u00fcssel erstellt',
                    externalKeyRevoked: 'Hat einen externen API-Schl\u00fcssel widerrufen',
                    limitsChanged: 'Hat Limits ge\u00e4ndert',
                },
            },
        },
    },
};

const teamsTranslations = { de: german };

return { teamsTranslations };
})();

const Domain_terminalWorkspaceTranslations = (() => {
const en = Shared_terminalWorkspaceTranslations.en;

const terminalWorkspaceKeyboardTranslations = Shared_terminalWorkspaceTranslations.terminalWorkspaceKeyboardTranslations;

const terminalWorkspaceTranslations = { de: en };

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

const de: ThisComputerConnectionTranslation = {
    connectHome: {
        title: ({ home }: HomeParams) => `Diesen Computer mit ${home} verbinden?`,
        body: ({ home }: HomeParams) => `${home} kann Sitzungen auf diesem Computer starten. Das Home deines Terminals und andere Home-Verbindungen bleiben bestehen.`,
        connect: 'Verbinden',
        keep: 'Aktuelle Verbindungen behalten',
    },
    setupAlreadyRunning: 'Die Einrichtung läuft bereits. Warte, bis sie abgeschlossen ist.',
    title: {
        daemon_url_mismatch: 'Der Hintergrunddienst nutzt ein anderes Home',
        daemon_account_mismatch: 'Der Hintergrunddienst nutzt ein anderes Konto',
        daemon_needs_auth: 'Der Hintergrunddienst muss sich anmelden',
        daemon_not_configured: 'Der Hintergrunddienst ist noch nicht verbunden',
        daemon_not_installed: 'Der Hintergrunddienst ist nicht installiert',
        daemon_not_running: 'Der Hintergrunddienst ist gestoppt',
    },
    description: {
        daemon_url_mismatch: ({ home, daemonHome }: OtherHomeParams) => `Er ist mit ${daemonHome} verbunden, nicht mit ${home}.`,
        daemon_account_mismatch: ({ home, daemonAccount, appAccount }: AccountParams) =>
            `Er ist bei ${home} als ${daemonAccount} angemeldet, nicht als ${appAccount}.`,
        daemon_needs_auth: ({ home }: HomeParams) => `Er ist mit ${home} verbunden, wurde aber noch nicht freigegeben.`,
        daemon_not_configured: ({ home }: HomeParams) => `Die Verbindung mit ${home} ist noch nicht abgeschlossen.`,
        daemon_not_installed: ({ home }: HomeParams) => `Installiere ihn, um diesen Computer mit ${home} zu verbinden.`,
        daemon_not_running: ({ home }: HomeParams) => `Starte ihn, um dich wieder mit ${home} zu verbinden.`,
    },
    action: {
        daemon_url_mismatch: 'Mit diesem Home verbinden',
        daemon_account_mismatch: ({ appAccount }: { appAccount: string }) => `Zu ${appAccount} wechseln`,
        daemon_needs_auth: 'Anmelden',
        daemon_not_configured: 'Mit diesem Home verbinden',
        daemon_not_installed: 'Hintergrunddienst installieren',
        daemon_not_running: 'Hintergrunddienst starten',
    },
    connected: ({ home, appAccount }: { home: string; appAccount: string }) => `Mit ${home} als ${appAccount} verbunden.`,
    noComputers: ({ home, appAccount }: { home: string; appAccount: string }) => `${appAccount} hat noch keine Computer bei ${home}.`,
    openThisComputer: 'Diesen Computer prüfen',
    moveConfirm: {
        title: ({ appAccount }: { appAccount: string }) => `Diesen Computer zu ${appAccount} wechseln?`,
        body: ({ home, daemonHome, daemonAccount, appAccount }: MoveParams) =>
            `Sein Hintergrunddienst ist bei ${daemonHome} als ${daemonAccount} angemeldet. Nach dem Wechsel arbeitet er für ${appAccount} bei ${home}, und ${daemonAccount} sieht diesen Computer nicht mehr.`,
        confirm: 'Wechseln',
    },
    cli: {
        title: 'Happier CLI',
        version: ({ version }: { version: string }) => `Version ${version}`,
        updateAvailable: ({ version, latestVersion }: { version: string; latestVersion: string }) =>
            `Version ${version} · ${latestVersion} ist verfügbar`,
        update: 'Aktualisieren',
        progressTitle: 'Happier CLI wird aktualisiert',
        notManaged: ({ origin }: { origin: string }) => `Außerhalb von Happier installiert: ${origin}`,
    },
    cliChoice: {
        title: ({ version }: { version: string }) => `Happier-CLI ${version} ist bereits installiert`,
        titleUnknownVersion: 'Die Happier-CLI ist bereits installiert',
        titleMissing: 'Deine Happier-CLI ist nicht mehr installiert',
        body: ({ path }: { path: string }) => `Sie liegt unter ${path}. Happier kann eine eigene Kopie installieren, aktuell halten und im PATH an erste Stelle setzen – oder du nutzt weiter diese.`,
        bodyOutdated: ({ path }: { path: string }) => `Sie liegt unter ${path} und ist für die Einrichtung zu alt. Happier kann eine aktuelle eigene Kopie installieren und im PATH an erste Stelle setzen – oder du behältst deine und aktualisierst sie selbst.`,
        bodyMissing: ({ path }: { path: string }) => `Du wolltest die unter ${path} behalten, aber sie ist nicht mehr da. Happier kann eine eigene Kopie installieren und aktuell halten – oder du installierst deine neu und nutzt sie weiter.`,
        bodyKeepBlocked: ({ path, link }: { path: string; link: string }) => `Sie liegt unter ${path}, aber neue Terminals starten zuerst die Happier-CLI über ${link}, das Happier nicht angelegt hat. Lass Happier die Befehlszeile verwalten, oder entferne ${link} und starte die Einrichtung erneut, um deine zu behalten.`,
        notNow: 'Nicht jetzt',
        manage: 'Von Happier verwalten lassen',
        keep: 'Meine behalten',
        unanswered: 'Die Einrichtung wurde angehalten, bevor etwas geändert wurde. Wähle, wer die Befehlszeile verwaltet, um fortzufahren.',
        ownMissing: 'Die Befehlszeile, die du behalten wolltest, ist nicht mehr installiert. Installiere sie neu oder lass Happier die Befehlszeile verwalten.',
        managed: 'Von Happier verwaltet',
        own: ({ path }: { path: string }) => `Deine eigene – ${path}`,
        change: 'Ändern, wer die Befehlszeile verwaltet',
        keptUpdateTitle: 'Deine Befehlszeile aktualisieren',
        keptUpdate: ({ command }: { command: string }) => `Eine neuere Version ist verfügbar. Aktualisiere sie mit ${command}`,
        oldCopyTitle: 'Alte Befehlszeile',
        oldCopyRemove: ({ path, command }: { path: string; command: string }) => `Noch installiert unter ${path}. Entferne sie mit ${command}`,
        oldCopyPath: ({ path }: { path: string }) => `Noch installiert unter ${path}.`,
    },
    servers: {
        title: 'Homes, für die dieser Computer arbeitet',
        connected: 'Verbunden',
        offline: 'Eingerichtet · Nicht aktiv',
        attention: 'Braucht Aufmerksamkeit',
        currentHome: ({ home }: HomeParams) => `${home} · dieser Home`,
    },
    removal: {
        uninstallFailedTitle: 'Dieser Computer konnte nicht getrennt werden',
        uninstallFailedBody: ({ home }: HomeParams) => `Der Hintergrunddienst dieses Computers für ${home} konnte nicht entfernt werden, daher wurde ${home} behalten. Versuche es erneut oder entferne den Dienst unter Einstellungen › Dieser Computer.`,
        inventoryUnavailableTitle: 'Dieser Computer konnte nicht geprüft werden',
        inventoryUnavailableBody: ({ home }: HomeParams) => `Happier konnte die Hintergrunddienste dieses Computers nicht lesen und weiß daher nicht, ob dieser Computer ${home} noch bedient. Trotzdem aus Happier entfernen?`,
        removeAnyway: 'Trotzdem entfernen',
        userOwnedTitle: 'Dieser Computer bedient es weiterhin',
        userOwnedBody: ({ home, service }: RemovalServiceParams) => `${service} wurde außerhalb von Happier installiert und läuft daher für ${home} weiter. Entferne ihn im Terminal, wenn du ihn nicht mehr brauchst.`,
    },
};

const thisComputerConnectionTranslations = { de };

return { thisComputerConnectionTranslations };
})();

const Domain_transcriptFindTranslations = (() => {
const transcriptFindTranslations = { de: { searchOlder: 'Ältere Nachrichten durchsuchen', partialErrors: 'Einige Inhalte konnten nicht durchsucht werden. Die Ergebnisse sind unvollständig.', olderRemaining: 'Ältere Nachrichten wurden noch nicht durchsucht.', findOpen: 'Find öffnen', findNext: 'Nächster Suchtreffer', findPrevious: 'Vorheriger Suchtreffer' } } as const;

return { transcriptFindTranslations };
})();

const Domain_turnChangesTranslations = (() => {
type TurnChangesTranslations = Shared_turnChangesTranslations.TurnChangesTranslations;

const en = Shared_turnChangesTranslations.en;

const translated = Shared_turnChangesTranslations.translated;

const turnChangesTranslations = { de: {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `${count} ${count === 1 ? 'Datei' : 'Dateien'} bearbeitet`,
                walkThrough: 'Erklär es mir',
                openInFiles: 'In Dateien öffnen',
                fileCount: ({ count }) => `${count} ${count === 1 ? 'Datei' : 'Dateien'}`,
                fileCountInFolders: ({ count, folders }) => `${count} ${count === 1 ? 'Datei' : 'Dateien'} in ${folders} Ordnern`,
                showMore: ({ count }) => `${count} weitere anzeigen`,
                groupA11y: 'Änderungen in diesem Zug',
            }),
        },
    } } as const;

return { turnChangesTranslations };
})();

const Domain_voiceMomentsTranslations = (() => {
type VoiceMomentsTranslation = Shared_voiceMomentsTranslations.VoiceMomentsTranslation;

const voiceMomentsTranslations = { de: {
        setupTitle: 'Voice einrichten',
        setupTileSubtitle: 'Sprich laut mit deinen Sitzungen. Vier kurze Schritte.',
        setupTileProgress: ({ done, total, next }) => `${done} von ${total} erledigt · ${next}`,
        setupNextService: 'als Nächstes: wer zuhört',
        setupNextReadiness: 'als Nächstes: Dienst fertig einrichten',
        setupNextMicrophone: 'als Nächstes: Mikrofon erlauben',
        setupNextTry: 'als Nächstes: ausprobieren',
        setupNextInstalling: 'wird installiert',
        setupStart: 'Einrichten',
        setupContinue: 'Weiter',
        setupDescription: 'Sprich laut mit deinen Sitzungen: frag, was passiert, starte Arbeit, entscheide von überall. Vier Schritte; du kannst gehen und wiederkommen.',
        setupLightCaption: ({ done, total }) => `${done} von ${total} bereit`,
        setupServiceTitle: 'Wähle, wer zuhört',
        setupServiceDetail: 'Was dich hört und antwortet. Du kannst es später ändern.',
        setupChange: 'Ändern',
        setupReadinessTitle: ({ service }) => `${service} fertig einrichten`,
        setupReadinessDone: ({ service }) => `${service} ist bereit`,
        setupReadinessGeneric: 'Der Dienst',
        setupReadinessTitleGeneric: 'Dienst bereit machen',
        setupReadinessUnknown: 'Öffne die Einstellungen, um zu sehen, was noch fehlt.',
        setupReadinessCheck: 'Einrichtung prüfen',
        setupMicrophoneTitle: 'Mikrofon erlauben',
        setupMicrophoneDetail: 'Dein Gerät fragt einmal. Happier hört nur zu, solange Voice an ist, und du siehst immer, wann.',
        setupMicrophoneAction: 'Mikrofon erlauben',
        setupMicrophoneDone: 'Mikrofon erlaubt',
        setupMicrophoneDeniedTitle: 'Das Mikrofon ist für Happier aus',
        setupMicrophoneDeniedDetail: 'Schalte es in den Systemeinstellungen ein und komm dann zurück.',
        setupOpenSystemSettings: 'Einstellungen öffnen',
        setupTryTitle: 'Ausprobieren',
        setupTryDetail: 'Frag: „Was machen meine Sitzungen?“ Deine Worte landen im Gespräch wie jede Nachricht.',
        setupTryAction: 'Ausprobieren',
        setupTryDone: 'Ausprobiert',
        setupTryNeedsService: 'Verfügbar, sobald der Dienst bereit ist.',
        setupDoneTitle: 'Voice ist bereit',
        setupDoneBody: 'Tippe in jedem Chat auf die Voice-Taste, um zu sprechen, und erneut, um zu beenden. Stumm liegt neben Beenden, solange du sprichst.',
        setupGestureTap: 'Tippen',
        setupGestureStartEnd: 'starten · beenden',
        setupGestureAnywhere: 'überall starten · beenden',
        setupDoneAction: 'Fertig',
        setupSettingsAction: 'Voice-Einstellungen',
        setupClose: 'Schließen',
        needsYouEnded: 'Voice beendet. Die Freigabe wartet noch im Posteingang.',
        needsYouReview: 'Anfrage prüfen',
        needsYouTapToDecide: 'Vorgelesen · hier entscheiden, nicht per Stimme',
        briefMe: 'Bring mich auf den Stand',
        briefMeA11y: 'Bring mich auf den Stand: Voice liest vor, was dich braucht, was fehlschlug und was bereit ist',
        briefNeedsYou: 'Braucht dich',
        briefFailed: 'Fehlgeschlagen',
        briefReady: 'Bereit',
        briefIncomplete: 'Noch nicht alles ist geladen, daher fehlt vielleicht etwas.',
        briefCaughtUp: 'Gerade braucht dich nichts.',
        briefNotSpoken: 'Voice kann das gerade nicht vorlesen. Die Liste steht vollständig hier.',
        briefStop: 'Stopp',
        continueTitle: 'Hier weitersprechen',
        continueDetail: ({ device }) => `Du hast auf ${device} gesprochen`,
        continueAction: 'Weiter',
        continuedOn: ({ device }) => `Auf ${device} fortgesetzt`,
        continuedElsewhere: 'Auf einem anderen Gerät fortgesetzt',
        continuedHere: 'Auf diesem Gerät fortgesetzt',
        dismiss: 'Ausblenden',
    } } satisfies Pick<Readonly<Record<string, VoiceMomentsTranslation>>, "de">;

return { voiceMomentsTranslations };
})();

const Domain_voicePresenceTranslations = (() => {
type VoicePresenceTranslation = Shared_voicePresenceTranslations.VoicePresenceTranslation;

const voicePresenceTranslations = { de: {
        welcomeText: "Hallo, ich höre zu — was möchtest du tun?",
        customVoice: 'Eigene Stimme',
        boundWelcomeText: ({ name }: Readonly<{ name: string }>) => `Hallo, du sprichst mit ${name} — was möchtest du tun?`,
        greetingLiteralUnavailable: "Bei dieser Antwortsprache wartet der Dienst, bis du sprichst.",
        title: 'Voice',
        howYouTalk: "So sprichst du",
        holdToTalkTitle: "Zum Sprechen halten",
        holdToTalkDescription: "Halte das Voice-Zeichen für eine Äußerung; lass zum Senden los. Tippen startet und beendet Voice weiterhin.",
        holdToTalkHint: "Für einen Beitrag halten; zum Senden loslassen. Zum Abbrechen wegziehen.",
        holdToTalkUnavailable: ({ service }) => `${service} unterstützt Halten zum Sprechen nicht. Tippe stattdessen zum Sprechen.`,
        talkWithVoice: 'Mit Voice sprechen',
        dictate: 'Diktieren',
        globalVoice: 'Globales Voice',
        interrupt: 'Unterbrechen',
        options: 'Voice-Optionen',
        you: 'Du',
        showConversation: 'Gespräch anzeigen',
        dragToMove: 'Zum Verschieben ziehen',
        openConversation: 'Gespräch öffnen',
        settings: 'Voice-Einstellungen',
        ended: 'Voice beendet',
        muted: 'Stummgeschaltet',
        setUp: 'Voice einrichten',
        setUpHint: 'Öffnet die Voice-Einstellungen, um festzulegen, wie Voice spricht',
        startAgain: 'Neu starten',
        endedCaption: ({ elapsed }) => `${elapsed} · das Gespräch ist gespeichert`,
        dismiss: 'Schließen',
        mute: "Stumm",
        unmute: "Ton an",
        end: "Beenden",
        captions: { connecting: "Audiokanal wird geöffnet", listening: "Leg los", transcribing: "Wird in Text umgewandelt", thinking: "Antwort wird erarbeitet", speaking: "Du kannst jederzeit unterbrechen", interrupted: "Leg los", muted: "Stummschaltung aufheben, um zu sprechen · Voice kann weiter sprechen", reconnecting: "Verbindung verloren · neuer Versuch", blocked: "Erlaube den Mikrofonzugriff, um zu sprechen", failed: "Versuch es erneut oder prüfe die Voice-Einstellungen" },
        recovery: { allow: "Erlauben", setUp: "Einrichten" },
        containerA11y: ({ status }) => `Voice, ${status}`,
    } } satisfies Pick<Readonly<Record<string, VoicePresenceTranslation>>, "de">;

return { voicePresenceTranslations };
})();

const Domain_voiceProviderPrivacyTranslations = (() => {
const voiceProviderPrivacyTranslations = { de: {
    openai: {
      privacyDisclosure: 'Audio und Gesprächsinhalte gehen von diesem Gerät per WebRTC an OpenAI. Wenn aktiviert oder genutzt, kann OpenAI außerdem begrenzte Voice-Kontext-Updates, Definitionen von Client-Tools und delegierte Ergebnisse von diesem Gerät erhalten. Happier nutzt den gewählten gespeicherten Voice-API-Key, den verbundenen OpenAI-Dienst oder das experimentelle Codex-OAuth-Konto, um kurzlebige Client-Authentifizierung zu erzeugen; auf verbundene Konten wird über den gewählten Rechner zugegriffen. OpenAI verarbeitet das laufende Gespräch unter dem gewählten Konto und kann empfangene Daten gemäß dessen Einstellungen und den Bedingungen von OpenAI aufbewahren. Happiers Server und Relay übertragen kein Live-Audio. Die Einstellungen zum Teilen von Voice-Kontext sind von dieser Verarbeitung beim Provider getrennt.',
    },
    xai: {
      privacyDisclosure: 'Audio und Gesprächsinhalte gehen von diesem Gerät über die xAI-Realtime-Verbindung an xAI. Wenn aktiviert oder genutzt, kann xAI außerdem begrenzte Voice-Kontext-Updates, Definitionen von Client-Tools und delegierte Ergebnisse von diesem Gerät erhalten. Happier nutzt den in deinen Happier-Konto-Secrets gespeicherten xAI-API-Key nur für die begrenzten Operationen zur Client-Auth und zum Stimmenkatalog. xAI verarbeitet das laufende Gespräch unter diesem Konto und kann empfangene Daten gemäß den Kontoeinstellungen und den Bedingungen von xAI aufbewahren. Wenn das Fortsetzen aktiviert ist, speichert Happier die Gesprächs-ID des Providers; sie zu vergessen entfernt nur Happiers gespeicherte ID und löscht keine Daten bei xAI. Happiers Server und Relay übertragen kein Live-Audio. Die Einstellungen zum Teilen von Voice-Kontext sind von dieser Verarbeitung beim Provider getrennt.',
    },
    speechProcessing: {
      deviceStt: 'Audio verarbeitet der Spracherkennungsdienst des Browsers oder Betriebssystems. Je nach Plattform und eingerichtetem Dienst kann die Verarbeitung außerhalb des Geräts stattfinden.',
      deviceTts: 'Antworttext verarbeitet der Sprachausgabedienst des Browsers oder Betriebssystems. Je nach Plattform und eingerichtetem Dienst kann die Verarbeitung außerhalb des Geräts stattfinden.',
    },
    fields: {
      resumption: {
        title: 'xAI-Fortsetzungs-ID speichern',
        subtitle: 'Happier erlauben, xAIs kurzlebige Gesprächs-ID zum Wiederverbinden zu speichern.',
      },
    },
    resumption: {
      confirmTitle: 'Die xAI-Fortsetzungs-ID speichern?',
      confirmBody: 'Happier speichert xAIs Gesprächs-ID bis zu {minutes} Minuten, damit ein unterbrochenes Gespräch wieder verbinden kann. Daten bei xAI werden dadurch weder geändert noch gelöscht.',
      confirmAction: 'ID speichern',
      forgetTitle: 'Happiers Fortsetzungs-ID vergessen',
      forgetSubtitle: 'Happiers gespeicherte Gesprächs-ID entfernen. Das Gespräch und die Daten bei xAI werden dadurch nicht gelöscht.',
      forgotten: 'Happier hat seine gespeicherte Gesprächs-ID entfernt.',
      unsupported: 'Happier kann die gespeicherte Gesprächs-ID aus dieser Session nicht entfernen.',
      failed: 'Happier konnte seine gespeicherte Gesprächs-ID nicht entfernen. Versuch es noch einmal.',
    },
  } } as const;

return { voiceProviderPrivacyTranslations };
})();

const Domain_voiceReadinessTranslations = (() => {
type VoiceReadinessCopy = Shared_voiceReadinessTranslations.VoiceReadinessCopy;

const defineVoiceReadinessTranslation = Shared_voiceReadinessTranslations.defineVoiceReadinessTranslation;

const voiceReadinessTranslations = { de: defineVoiceReadinessTranslation({
    ready: 'Bereit für Voice.',
    permissionAnnouncement: ({ summary }) => `Die Coding-Session benötigt eine Berechtigung für ${summary}. Prüfe sie in der Session-Oberfläche, um sie zu genehmigen oder abzulehnen.`,
    userActionAnnouncement: ({ question }) => `Die Coding-Session benötigt deine Antwort. ${question}`,
    userActionFallback: 'Die Coding-Session benötigt deine Antwort. Beantworte die Frage, damit ich fortfahren kann.',
    requestedTool: 'das angeforderte Werkzeug',
    provider_unselected: 'Wähl einen Voice-Provider.',
    contribution_unavailable: 'Dieser Voice-Provider ist nicht mehr verfügbar.',
    role_unsupported: 'Dieser Provider unterstützt den gewählten Voice-Modus nicht.',
    platform_unsupported: 'Dieser Voice-Provider ist auf dieser Plattform nicht verfügbar.',
    settings_unsupported_version: 'Aktualisiere diesen Provider, bevor du ihn mit Voice nutzt.',
    settings_unknown: 'Die Provider-Einstellungen ließen sich nicht prüfen.',
    settings_needs_migration: 'Prüf die aktualisierten Einstellungen dieses Providers.',
    settings_invalid: 'Prüf die ungültigen Provider-Einstellungen.',
    settings_missing_required_setting: ({ service }) => `Richte ${service} fertig ein, um zu starten.`,
    provider_mode_unknown: 'Wähl einen unterstützten Modus für diesen Provider.',
    server_feature_disabled: 'Dieser Voice-Provider ist vom Server deaktiviert.',
    server_feature_installing: 'Der Server bereitet die Voice-Unterstützung gerade vor.',
    server_feature_incompatible: 'Der Server ist mit diesem Voice-Provider nicht kompatibel.',
    server_feature_unknown: 'Die Server-Unterstützung für diesen Voice-Provider ließ sich nicht prüfen.',
    execution_machine_missing: 'Wähl einen Rechner, der diesen Voice-Provider ausführen kann.',
    execution_machine_installing: 'Der gewählte Voice-Ausführungsrechner wird noch vorbereitet.',
    execution_machine_incompatible: 'Der gewählte Rechner ist mit diesem Voice-Provider nicht kompatibel.',
    execution_machine_unknown: 'Der Voice-Ausführungsrechner ließ sich nicht prüfen.',
    daemon_unreachable: 'Der gewählte Rechner hat keinen verfügbaren Weg für Voice-Audio.',
    daemon_relay_disabled: 'Der gewählte Rechner braucht das Voice-Audio-Relay, aber die Relay-Nutzung ist deaktiviert.',
    daemon_relay_capped: 'Für den gewählten Rechner ist gerade keine Kapazität im Voice-Audio-Relay verfügbar.',
    credential_missing: 'Füg die Zugangsdaten hinzu, die dieser Voice-Provider braucht.',
    credential_approval_required: 'Prüf den Zugriff auf die Zugangsdaten, bevor du diesen Voice-Provider nutzt.',
    credential_installing: 'Die Provider-Zugangsdaten werden noch vorbereitet.',
    credential_incompatible: 'Die gewählten Zugangsdaten sind mit diesem Voice-Provider nicht kompatibel.',
    credential_unknown: 'Die Provider-Zugangsdaten ließen sich nicht prüfen.',
    endpoint_missing: 'Richte den Endpunkt ein, den dieser Voice-Provider braucht.',
    endpoint_installing: 'Der Endpunkt des Voice-Providers wird noch vorbereitet.',
    endpoint_incompatible: 'Der eingerichtete Endpunkt ist mit diesem Voice-Provider nicht kompatibel.',
    endpoint_unknown: 'Der Endpunkt des Voice-Providers ließ sich nicht prüfen.',
    runtime_missing: 'Installier die Runtime, die dieser Voice-Provider braucht.',
    runtime_installing: 'Die Runtime des Voice-Providers wird noch installiert.',
    runtime_incompatible: 'Die installierte Runtime ist mit diesem Voice-Provider nicht kompatibel.',
    runtime_unknown: 'Die Runtime des Voice-Providers ließ sich nicht prüfen.',
    model_missing: 'Installier oder wähl ein Modell für diesen Voice-Provider.',
    model_installing: 'Das gewählte Voice-Modell wird noch installiert.',
    model_incompatible: 'Das gewählte Modell ist mit diesem Voice-Provider nicht kompatibel.',
    model_unknown: 'Das Modell des Voice-Providers ließ sich nicht prüfen.',
    device_stt_unavailable: 'Auf diesem Gerät gibt es keine Spracherkennung.',
    device_stt_availability_unknown: 'Die Verfügbarkeit der Spracherkennung wird noch geprüft.',
    short: {
      needsSetup: 'Einrichtung nötig',
      needsKey: 'Schlüssel nötig',
      needsApproval: 'Deine Freigabe nötig',
      offOnServer: 'Auf diesem Server aus',
      needsComputer: 'Computer nötig',
      needsAddress: 'Adresse nötig',
      needsModel: 'Modell nötig',
      installing: 'Wird installiert',
      notInstalled: 'Nicht installiert',
      unavailableHere: 'Hier nicht verfügbar',
      needsUpdate: 'Update nötig',
      cantCheck: 'Noch nicht geprüft',
    },
    actions: {
      select_provider: 'Einen Provider wählen',
      open_provider_settings: "Einrichtung abschließen",
      select_execution_machine: 'Einen Rechner wählen',
      configure_credential: 'Zugangsdaten hinzufügen',
      review_credential_access: 'Zugriff auf Zugangsdaten prüfen',
      configure_endpoint: 'Endpunkt einrichten',
      install_model: 'Ein Modell installieren',
      switch_provider: 'Einen anderen Provider wählen',
    },
  }) } as const;

return { voiceReadinessTranslations };
})();

const Domain_voiceSettingsPagesTranslations = (() => {
type VoiceSettingsPagesCopy = Shared_voiceSettingsPagesTranslations.VoiceSettingsPagesCopy;

const en = Shared_voiceSettingsPagesTranslations.en;

const de: VoiceSettingsPagesCopy = {
  pages: {
    search: {
      chooseService: 'Wähle einen Dienst, um diese Einstellung zu ändern.',
      select: ({ choice, control }) => `Wähle ${choice} unter ${control}, um diese Einstellung zu ändern.`,
    },
    hub: {
      description: 'Sprich laut mit deinen Agenten und diktiere in jede Nachricht.',
      modesTitle: 'Zwei Arten, deine Stimme zu nutzen',
      moreTitle: 'Mehr',
      dictationPurpose: 'das Mikrofon im Eingabefeld macht aus deiner Sprache bearbeitbaren Text',
      summarySessionSummaries: 'Sitzungszusammenfassungen',
      summaryRecentMessages: ({ count }) => `letzte ${count} Nachrichten`,
      summaryNothingShared: 'Beim Gesprächsbeginn wird nichts geteilt',
      summaryRemembers: 'Der Voice-Agent merkt sich frühere Gespräche',
      summaryForgets: 'Der Voice-Agent vergisst nach jedem Gespräch',
      summaryVoiceComputer: ({ machine }) => `Voice-Computer: ${machine}`,
      summaryTranscript: 'Transkript beim Sprechen',
    },
    pipeline: {
      hear: 'Hören',
      think: 'Denken',
      speak: 'Sprechen',
      write: 'Schreiben',
      ready: 'Bereit',
      oneStepNeedsYou: 'Ein Schritt braucht dich',
      stepsNeedYou: ({ count }) => `${count} Schritte brauchen dich`,
      waiting: 'Wartet',
      working: 'Läuft',
      notChecked: 'Noch nicht geprüft',
      off: 'Aus · Diktieren bleibt verfügbar',
      onMachine: ({ machine }) => `Auf ${machine}`,
      onVoiceComputer: 'Auf deinem Voice-Computer',
      inTheCloud: 'In der Cloud des Dienstes, von diesem Gerät aus',
      inTheSession: 'Ihr eigener Agent antwortet, im Transkript',
      intoYourMessage: 'Du prüfst es vor dem Senden',
      messageLanguage: ({ language }) => `Sprache: ${language}`,
      languageAutomatic: 'automatisch',
      onThisDevice: 'Auf diesem Gerät',
      needsYou: 'Braucht dich',
      voiceAgentFollowsSession: 'Voice-Agent · folgt der Sitzung',
      theSessionYoureIn: 'Die Sitzung, in der du bist',
      intoYourMessageTitle: 'In deine Nachricht',
    },
    privacy: {
      localAudio: "Dein Gerät oder Voice-Computer",
      localProcessor: "Dein ausgewähltes Sprachmodell",
      localRetention: "Vom Gerät oder der Laufzeit verwaltet. Diagnosen folgen deinen Aufnahmeeinstellungen.",
      localDisclosure: "Ausgewählte Sprachmodelle laufen auf deinem Gerät oder Voice-Computer. Voice-Verlauf und Diagnoseaufnahmen haben auf dieser Seite eigene Einstellungen.",
      audioTitle: "Audio geht an",
      processorTitle: "Verarbeitet von",
      retentionTitle: "Aufbewahrung",
      messagesUnit: "Nachrichten",
      secondsUnit: "Sekunden",
      servicePolicy: "Gemäß den Einstellungen und Bedingungen deines Dienstkontos.",
      noMicrophoneAudio: "Kein Mikrofon-Audio; nur Antworttext.",
      yourEndpoint: "Deinen konfigurierten Endpunkt",
      endpointOperator: "Den Betreiber deines Endpunkts",
      endpointPolicy: "Gemäß der Aufbewahrungsrichtlinie deines Endpunkts.",
      deviceAudio: "Den Sprachdienst deines Geräts",
      deviceProcessor: "Dein Gerät oder dessen Sprachdienst",
      devicePolicy: "Gemäß den Spracheinstellungen und Bedingungen deines Geräts.",
      description: 'Was dein Sprachdienst hört und liest und was Happier aufbewahrt.',
      whereTitle: 'Wohin deine Stimme gerade geht',
      whereDescription: 'Das ändert sich mit dem gewählten Dienst.',
      startTitle: 'Wenn ein Gespräch beginnt',
      startDescription: 'Was der Sprachdienst über deine Arbeit lesen kann.',
      screenTitle: 'Was auf deinem Bildschirm ist',
      screenDescription: 'Welche Sitzung oder Seite du gerade ansiehst.',
      screenNever: 'Nie',
      screenWhenAsked: 'Auf Nachfrage',
      screenAlways: 'Immer',
      summariesTitle: 'Sitzungszusammenfassungen',
      recentTitle: 'Deine letzten Nachrichten',
      recentDescription: 'Die letzten Nachrichten einer Sitzung, wenn er nach Kontext fragt.',
      recentCountTitle: 'Zu teilende Nachrichten',
      recentCountDescription: "",
      recentCountUnavailable: 'Schalte „Deine letzten Nachrichten“ ein, um das zu ändern.',
      toolsTitle: 'Werkzeugnamen',
      toolsDescription: 'Etwa „Datei bearbeitet“. Argumente und Dateipfade werden nie geteilt.',
      permissionsTitle: 'Berechtigungsanfragen',
      permissionsDescription: 'Damit er dir sagen kann, was dich braucht. Du bestätigst weiterhin per Tippen.',
      devicesTitle: 'Deine Maschinen und Geräte',
      devicesDescription: 'Namen und Online-Status, um Sitzungen dort zu starten, wo du willst.',
      liveTitle: 'Während du sprichst',
      liveDescription: 'Updates, die gesendet werden, wenn sich deine Sitzungen während eines Gesprächs ändern.',
      liveActiveTitle: 'Aus der Sitzung, in der du bist',
      liveOtherTitle: 'Aus deinen anderen Sitzungen',
      liveNothing: 'Nichts',
      liveActivity: 'Aktivität',
      liveSummaries: 'Zusammenfassungen',
      liveMessages: 'Nachrichten',
      livePerUpdateTitle: 'Nachrichten pro Update',
      liveIncludeMineTitle: 'Was du geschrieben hast, einbeziehen',
      liveIncludeMineDescription: 'Aus: Nur die Seite des Agenten wird gesendet.',
      liveMessagesUnavailable: 'Wähle oben „Nachrichten“ für eine Sitzung, um das zu ändern.',
      liveOtherModeTitle: 'Nachrichten aus anderen Sitzungen',
      liveOtherModeNever: 'Nie',
      liveOtherModeWhenAsked: 'Auf Nachfrage',
      liveOtherModeAutomatically: 'Automatisch',
      liveOtherModeUnavailable: 'Wähle „Nachrichten“ für andere Sitzungen, um das zu ändern.',
      memoryTitle: 'Gedächtnis des Voice-Agenten',
      memoryDescription: 'Nur für lokale Stimme mit einem Voice-Agenten.',
      rememberTitle: 'Frühere Gespräche merken',
      rememberOnDescription: 'Er macht dort weiter, wo du aufgehört hast.',
      rememberOffDescription: 'Aus: Er vergisst alles, wenn du auflegst.',
      restoreTitle: 'Gedächtnis wiederherstellen per',
      restoreRecent: 'Letzte Nachrichten',
      restoreSummary: 'Zusammenfassung + letzte',
      restoreResume: 'Fortsetzen des Agenten',
      restoreUnavailable: 'Schalte „Merken“ ein, um zu wählen.',
      restoreResumeFeatureOff: 'Fortsetzen braucht den Voice-Agenten, eingeschaltet für diesen Server.',
      restoreResumeAgentCannot: 'Dieser Agent kann kein früheres Gespräch fortsetzen.',
      fallbackTitle: 'Wenn das Fortsetzen scheitert, Nachrichten abspielen',
      fallbackDescription: 'Beginnt mit deinen letzten Nachrichten statt bei null.',
      restoreCountTitle: 'Wiederherzustellende Nachrichten',
      restoreCountDescription: "",
      forgetTitle: 'Jetzt alles vergessen',
      forgetDescription: 'Startet den Voice-Agenten neu. Deine Sitzungen bleiben unberührt.',
      forgetAction: 'Vergessen',
      moreTitle: 'Mehr',
    },
    dictation: {
      description: 'Das Mikrofon im Eingabefeld macht aus deiner Sprache Text, den du vor dem Senden bearbeiten kannst.',
      engineTitle: 'Sprach-Engine',
      engineDescription: 'Jede Engine sagt, wohin dein Audio geht.',
      sameAsConversations: 'Wie Sprachgespräche',
      sameAsConversationsUses: ({ engine }) => `Nutzt ${engine}, wie deine Sprachgespräche.`,
      languageTitle: 'Sprache',
      dictateInTitle: 'Ich diktiere auf',
      dictateInDescription: 'Automatisch nutzt die Standardsprache der Engine. Sie folgt nicht der Sprache deiner Gespräche.',
      pipelinePurpose: 'funktioniert auch, wenn Sprachgespräche aus sind',
    },
    conversations: {
      description: 'Sprich laut mit deinen Agenten, mit den Händen auf der Tastatur oder nicht.',
      serviceTitle: 'Dienst',
      serviceDescription: 'Wer dir zuhört, denkt und spricht. Du kannst jederzeit wechseln; jeder behält seine Einrichtung.',
      offDescription: 'Keine Sprachgespräche. Diktieren bleibt verfügbar.',
      serviceReady: 'Bereit',
      accountTitle: 'Konto',
      accountDescription: 'Es ist in beiden Fällen derselbe Dienst; nur wer bezahlt, ändert sich.',
      payWithTitle: 'Bezahlen mit',
      happierBillingUnavailable: "Happier-Abrechnung ist auf diesem Server nicht verfügbar.",
      turnOnVoiceAgent: "Sprachagent einschalten",
      payWithHappierDescription: 'Dein Happier-Abo deckt das ab. Kein eigenes Konto nötig.',
      payWithOwnDescription: 'Du nutzt dein eigenes Konto und deinen API-Key für diesen Dienst.',
      runsOn: 'Läuft auf',
      hearTitle: 'Hören',
      hearDescription: 'Wie deine Sprache zu Text wird, bevor sie beantwortet wird.',
      speechRecognitionTitle: 'Spracherkennung',
      handsFreeUnsupported: 'Freisprechen braucht die Spracherkennung dieses Geräts oder ein Happier-Sprachmodell.',
      handsFreeTimingUnavailable: 'Schalte Freisprechen ein, um das zu ändern.',
      interruptTitle: 'Durch Sprechen unterbrechen',
      interruptDescription: 'Wenn du in eine Antwort sprichst, stoppt sie.',
      talkToTitle: 'Sprechen mit',
      talkToSession: 'Der Sitzung',
      talkToSessionDescription: 'Du sprichst in die Sitzung, in der du bist; ihr eigener Agent antwortet.',
      talkToAgent: 'Einem Voice-Agenten',
      talkToAgentDescription: 'Ein Voice-Agent liest deine Sitzungen und handelt für dich.',
      agentFeatureRequired: ({ feature }) => `Aktiviere ${feature} unter Einstellungen → Funktionen. Experimentelle Funktionen benötigen außerdem aktivierte Experimente.`,
      itMayTitle: 'Er darf',
      itMayReadOnly: 'Nur lesen',
      itMayReadOnlyDescription: 'Er liest deine Sitzungen und Dateien und ändert nichts.',
      itMayAsk: 'Erst fragen',
      itMayAskDescription: 'Jede Änderung fragt dich zuerst. Ein gesprochenes „Ja“ bestätigt nie; du tippst.',
      itMaySafe: 'Sichere Änderungen',
      itMaySafeDescription: 'Er macht sichere Änderungen im Arbeitsbereich selbst und fragt beim Rest.',
      itMayAnything: 'Alles',
      itMayAnythingDescription: 'Er darf alles ändern, ohne dich vorher zu fragen.',
      repliesTitle: 'Antworten',
      repliesShort: 'Kurz',
      repliesBalanced: 'Ausgewogen',
      thinkTitle: 'Denken',
      thinkDescription: 'Was mit dem passiert, was du sagst.',
      advancedAgentTitle: 'Erweitertes Agentenverhalten',
      advancedAgentDescription: 'Wie der Voice-Agent startet, wartet und antwortet. Die Standardwerte passen für die meisten.',
      memoryLinkTitle: 'Gedächtnis und Wiederherstellung',
      memoryLinkDescription: 'Ob er sich frühere Gespräche merkt, stellst du unter Datenschutz & Daten ein.',
      speakTitle: 'Sprechen',
      speakDescription: 'Wie Antworten vorgelesen werden.',
      voiceEngineTitle: 'Stimm-Engine',
      languageTitle: 'Sprache',
      languageDescription: 'Was jede Sprache für den gewählten Dienst ändert.',
      iSpeakTitle: 'Ich spreche',
      iSpeakDescription: 'Hilft, dich zu verstehen. Automatisch erkennt sie jedes Mal.',
      replyInTitle: 'Antworten auf',
      replyInDescription: 'Die Antwort kommt in dieser Sprache, auch wenn du wechselst.',
      replySame: 'Wie ich spreche',
      iSpeakAutomatic: 'Automatisch',
      iSpeakEngineDescription: ({ engine }) => `Hilft ${engine}, dich zu verstehen. Einstellbar bei der Spracherkennung unter Hören.`,
      voiceTitle: 'Stimme',
      voiceDescription: ({ engine }) => `Von ${engine}, der Engine unter Sprechen.`,
      voiceDefault: 'Standard',
      voiceDevice: 'Die Stimme dieses Geräts',
      voiceInEngine: 'Unter Sprechen einstellen',
      languageServiceDescription: 'Die Sprache, in der dein Sprachdienst antwortet.',
      languageAutomaticDescription: 'Dein Sprachdienst erkennt die Sprache, die du sprichst.',
      languageEngineDefault: 'Engine-Standard',
      languageCoupledDescription: 'Dein Sprachdienst nutzt eine Sprache zum Zuhören und Antworten.',
      greetingTitle: 'Begrüßung',
      greetingOff: 'Aus',
      greetingRightAway: 'Sofort',
      greetingAfterISpeak: 'Wenn ich spreche',
      greetingOffDescription: 'Wartet, bis du zuerst sprichst.',
      greetingRightAwayDescription: 'Begrüßt dich, sobald das Gespräch beginnt.',
      greetingAfterISpeakDescription: 'Begrüßt dich in der ersten Antwort.',
      languageManagedDescription: 'Dein Sprachdienst bestimmt seine Sprache.',
      languageServiceDefault: 'Dienststandard',
    },
    advanced: {
      description: 'Wo die Stimme läuft, wie sie auf dem Bildschirm erscheint und welche Sprachmodelle sie nutzt.',
      onScreenTitle: 'Auf dem Bildschirm',
      onScreenDescription: 'Wie ein laufendes Gespräch erscheint.',
      showLiveAsTitle: 'Live-Voice anzeigen als',
      showLiveAsDescription: 'Nur auf diesem Gerät. Der Voice-Bereich im Companion bleibt in jedem Modus.',
      scopeTitle: 'Gespräche starten mit',
      scopeGlobal: 'Allen meinen Sitzungen',
      scopeGlobalDescription: 'Ein Assistent für alles.',
      scopeSession: 'Der offenen Sitzung',
      scopeSessionDescription: 'Es startet in der Sitzung, die du offen hast.',
      transcriptTitle: 'Transkript beim Sprechen anzeigen',
      transcriptDescription: 'Was du und der Agent sagen, erscheint während des Gesprächs.',
      autoOpenTitle: 'Beim Gesprächsbeginn öffnen',
      autoOpenDescription: 'Aus: Öffne es selbst aus dem Gespräch.',
      autoOpenUnavailable: 'Schalte „Transkript anzeigen“ ein, um zu wählen.',
      computerTitle: 'Voice-Computer',
      speechModelsTitle: 'Sprachmodelle',
      speechModelsNeedComputerTitle: 'Voice-Computer erforderlich',
      speechModelsNeedComputer: 'Wähle oben einen Voice-Computer, um seine Sprachmodelle zu installieren und zu verwalten.',
      computerDescription: 'Der Computer, der Sprachmodelle ausführt und sich für die Stimme bei verbundenen Konten anmeldet. Geteilt über deine Geräte.',
      connectionTitle: 'Verbindung',
      timeoutTitle: 'Sprachanfrage abbrechen nach',
      timeoutDescription: "Für Endpunkte und Sprachmodelle.",
    },
  },
};

const voiceSettingsPagesTranslations = { de } as const satisfies Pick<Record<string, VoiceSettingsPagesCopy>, "de">;

return { voiceSettingsPagesTranslations };
})();

const Domain_walkthroughProgressTranslations = (() => {
type Parts = Shared_walkthroughProgressTranslations.Parts;

const walkthroughProgressTranslations = { 'de': { parts: ({ completed, total, admitted }: Parts) => `${completed}/${total} Teile abgeschlossen · ${admitted} angenommen`, merge: 'Der Durchgang wird zusammengefügt…', titleEdited: 'Titel bearbeitet', changed: 'Geändert', moved: 'Verschoben', filesReadUnavailable: 'Fortschritt gelesener Dateien nicht verfügbar' } };

return { walkthroughProgressTranslations };
})();

const Domain_walkthroughSavedTranslations = (() => {
type SavedCopy = Shared_walkthroughSavedTranslations.SavedCopy;

const en = Shared_walkthroughSavedTranslations.en;

const walkthroughSavedTranslations = { de: { discuss: 'Besprechen', message: 'Nachricht', edit: 'Walkthrough bearbeiten', title: 'Walkthrough-Titel', stopTitle: 'Abschnittstitel', prose: 'Erklärung', refine: 'Überarbeiten', instructions: 'Was soll sich ändern?', moveUp: 'Nach oben', moveDown: 'Nach unten', mergeNext: 'Mit nächstem Abschnitt zusammenführen', addSummary: 'Zusammenfassung hinzufügen', addCommitPlan: 'Commits vorschlagen', updated: 'Gespeichertes Ergebnis aktualisiert', conflict: 'Dieser Walkthrough wurde anderswo geändert. Dein Entwurf bleibt erhalten. Lade die aktuelle Version und prüfe sie vor dem erneuten Speichern.', reload: 'Aktuelle Version laden', missingStop: "Dieser Abschnitt ist im aktuellen Walkthrough nicht mehr enthalten. Dein Entwurf bleibt erhalten; wähle einen anderen Abschnitt.", applicationLocked: 'Commits werden angewendet. Die Bearbeitung ist pausiert.' } } satisfies Pick<Record<string, SavedCopy>, "de">;

return { walkthroughSavedTranslations };
})();

const Domain_walkthroughSettingsTranslations = (() => {
type Copy = Shared_walkthroughSettingsTranslations.Copy;

const en = Shared_walkthroughSettingsTranslations.en;

const copy = Shared_walkthroughSettingsTranslations.copy;

const walkthroughSettingsTranslations = { de: copy({
        title: 'Rundgänge',
        description: 'Eine von KI erstellte Lesereihenfolge mit Erklärungen direkt neben den jeweiligen Änderungen und optionalen Commit-Vorschlägen. Läuft auf dem Rechner mit dem Code.',
        enabled: 'Änderungen erklären',
        enabledDescription: 'Ergänzt einen Vergleich um eine Lesereihenfolge und Erklärungen. Dateien bleiben auch ohne Modell verfügbar.',
        model: 'Zusammenfassungsmodell',
        modelDescription: 'Wird für Erklärungen, Rundgänge und Commit-Vorschläge verwendet.',
        chooseModel: 'Modell wählen',
        searchModels: 'Modelle suchen',
        unsupported: 'Kann keine Rundgänge schreiben',
        unavailable: 'Modell nicht verfügbar. Wähle ein anderes.',
        prefetch: 'Nach jedem Zug vorbereiten',
        prefetchDescription: 'Bereitet einen Rundgang vor, wenn der Agent einen Zug beendet.',
        saved: 'Gespeicherte Rundgänge',
        savedDescription: 'Auf diesem Rechner gespeichert, einschließlich deiner Bearbeitungen.',
        clear: 'Löschen',
        unavailableData: 'Verbinde den Rechner erneut, um gespeicherte Rundgänge und Kosten zu laden.',
        costUnavailable: 'Letzte 7 Tage · Kosten nicht verfügbar',
        clearTitle: 'Gespeicherte Rundgänge löschen?',
        clearDescription: ({ machine }) => `Gespeicherte Rundgänge und deine manuellen Bearbeitungen auf ${machine} sowie deine Prüfmarkierungen für diese Vergleiche löschen. Andere Rechner sind nicht betroffen.`,
        savedCount: ({ count, bytes }) => `${count} gespeichert · ${bytes}`,
        cost: ({ amount, partial }) => `Letzte 7 Tage · ${amount}${partial ? ' · einige Kosten nicht verfügbar' : ''}`,
        clearFailed: 'Einige Rundgänge konnten nicht gelöscht werden. Lade neu und versuche es erneut.',
    }) };

return { walkthroughSettingsTranslations };
})();

const Domain_walkthroughStartTranslations = (() => {
const walkthroughStartTranslations = { de: { walkthroughStart: { start: 'Rundgang starten', ended: 'Dieses Gespräch ist hier nicht verfügbar. Der Rundgang bleibt erhalten.', newConversation: 'Neues Gespräch starten', askSession: 'Den Sitzungsagenten fragen', unavailable: 'Verbinde den zugehörigen Rechner und wähle ein Modell für strukturierte Ausgabe.', updated: 'Rundgang aktualisiert' } } };

return { walkthroughStartTranslations };
})();

const Domain_walkthroughTranslations = (() => {
type WalkthroughTranslations = Shared_walkthroughTranslations.WalkthroughTranslations;

const walkthroughSavedTranslations = {...Domain_walkthroughSavedTranslations.walkthroughSavedTranslations, ...EnglishFeatures.walkthroughSavedTranslations.walkthroughSavedTranslations};

const walkthroughProgressTranslations = {...Domain_walkthroughProgressTranslations.walkthroughProgressTranslations, ...EnglishFeatures.walkthroughProgressTranslations.walkthroughProgressTranslations};

const en = Shared_walkthroughTranslations.en;

const translated = Shared_walkthroughTranslations.translated;

const walkthroughTranslations = { de: {
        walkthrough: translated({
            saved: walkthroughSavedTranslations.de,
            progress: walkthroughProgressTranslations.de,
            eyebrow: 'Durchgang',
            generated: 'Generiert',
            generatedBy: ({ model }) => `Generiert · ${model}`,
            generatedA11y: 'Von einem Modell geschrieben',
            readingChanges: 'Liest die Änderungen…',
            modelFallback: 'Das Modell',
            analysisAll: ({ who, count }) => `${who} hat alle ${count} gelesen`,
            analysisSome: ({ who, analysed, total }) => `${who} hat ${analysed} von ${total} gelesen`,
            analysisStopped: ({ who, analysed, total }) => `${who} hat ${analysed} von ${total} gelesen, dann gestoppt`,
            unavailableCount: ({ count }) => `${count} nicht verfügbar`,
            youReviewed: ({ count, total }) => `Du hast ${count} von ${total} geprüft`,
            contents: 'Inhalt',
            reviewedOfTotal: ({ count, total }) => `${count} von ${total} geprüft`,
            boardReadProgress: ({ count, total }) => `${count} von ${total} gelesen`,
            stopOf: ({ number, total }) => `${number} von ${total}`,
            stopA11y: ({ number, title }) => `Station ${number}: ${title}`,
            stopReviewedA11y: ({ number }) => `Station ${number}, geprüft`,
            importance: { start: 'Hier beginnen', high: 'Genau lesen', low: 'Überfliegen' },
            markReviewed: 'Als geprüft markieren',
            reviewed: 'Geprüft',
            markReviewedA11y: 'Diese Station als geprüft markieren',
            unmarkReviewedA11y: 'Geprüft. Drücken, um die Markierung zu entfernen',
            askAboutThis: 'Dazu fragen',
            askAboutStopA11y: 'Zu dieser Station fragen',
            openConversation: 'Gespräch zum Durchgang öffnen',
            andIn: ({ file }) => `und in ${file}`,
            newFile: 'Neue Datei',
            deletedFile: 'Gelöscht',
            openInFiles: ({ file }) => `${file} in Dateien öffnen`,
            otherChanges: 'Weitere Änderungen',
            otherChangesDescription: 'Nicht Teil der Geschichte, aber da. Öffne sie wie einen normalen Diff.',
            otherChangesCue: 'Mechanisch, als Diffs gezeigt',
            keys: { move: 'bewegen', reviewed: 'geprüft', ask: 'fragen' },
            overview: 'Überblick',
            codeMapOf: ({ count }) => `Code-Karte von ${count} ${count === 1 ? 'Datei' : 'Dateien'}`,
            codeMapHint: 'zeige auf eine Station, um ihre Dateien hervorzuheben',
            touchesOutlined: 'betrifft die hervorgehobenen Dateien',
            showOverviewA11y: ({ count }) => `Überblick zeigen: eine Code-Karte von ${count} Dateien`,
            inventory: { title: 'Alles in diesem Vergleich · jetzt in Dateien bereit', read: 'Gelesen', reading: 'Liest', unavailable: 'Nicht verfügbar' },
            arriving: 'Die nächsten Stationen erscheinen hier, sobald sie geschrieben sind.',
            previousStop: 'Vorherige Station',
            nextStop: 'Nächste Station',
            done: 'Fertig',
            evidence: { displayFailed: 'Der gespeicherte Code konnte nicht angezeigt werden. Die Datei bleibt unter Dateien.', binary: 'Binärdatei, aus ihren Metadaten beschrieben. Gezeigt, nicht analysiert.', unavailable: ({ reason }) => `Konnte nicht gelesen werden (${reason}). Sie bleibt in der Liste; nichts hier behauptet, sie sei geprüft.` },
            notice: {
                stale: 'Dateien haben sich geändert, nachdem dies geschrieben wurde',
                refresh: 'Durchgang aktualisieren',
                failed: ({ reason }) => `Schreiben gestoppt · ${reason}`,
                failedGeneric: 'Schreiben gestoppt',
                tryAgain: 'Erneut versuchen',
                chooseModel: 'Modell wählen',
                cancelled: 'Das Schreiben wurde gestoppt. Was geschrieben ist, bleibt.',
                rest: 'Der Rest wurde nicht geschrieben. Alle Dateien sind in Dateien; nichts wurde stillschweigend ausgelassen.',
                offline: ({ machine, time }) => `${machine} ist offline · zeigt den Durchgang und Code von ${time}. Fragen und Aktualisieren kommen zurück, sobald die Verbindung steht.`,
                offlineA11y: 'Braucht die Maschine, die offline ist',
                incomplete: 'Einige Änderungen konnten nicht aufgelistet werden. Was hier ist, ist exakt; nichts behauptet, vollständig zu sein.',
                undo: 'Rückgängig',
            },
            none: { title: 'Noch kein Durchgang', reason: 'Ein Durchgang liest diese Änderungen der Reihe nach und erklärt jede neben ihrem genauen Code. Alle Dateien sind schon in Dateien.', showFiles: 'Dateien zeigen' },
            explain: { notInStory: 'Nicht Teil der Geschichte', readInWalkthrough: 'Im Durchgang lesen' },
        }),
    } };

return { walkthroughTranslations };
})();

const Domain_widgetAddTranslations = (() => {
type WidgetAddTranslation = Shared_widgetAddTranslations.WidgetAddTranslation;

const inSentence = Shared_widgetAddTranslations.inSentence;

const widgetAddTranslations = { de: {
        added: 'Hinzugefügt',
        boardTitle: 'Zum Board hinzufügen',
        boardHint: 'Alle hier sehen, was du hinzufügst',
        companionTitle: 'Zum Begleiter hinzufügen',
        companionHint: 'Nur du siehst deinen Begleiter',
        searchWidgets: 'Widgets durchsuchen',
        searchCompanion: 'Übersichten und Bereiche durchsuchen',
        makeOne: 'Selbst erstellen',
        noteSubtitle: 'Markdown',
        interactiveViewSubtitle: 'HTML',
        findMore: 'Weitere Widgets finden',
        findMoreSubtitle: 'Plugins',
        askTitle: 'Den Agenten um ein Widget bitten',
        askNote: 'Entwurf im Eingabefeld; nichts wird gesendet, bis du es tust.',
        glances: 'Übersichten',
        glancesHint: 'live, integriert oder aus Plugins',
        onBoard: 'Auf diesem Board',
        onBoardHint: 'mit allen hier geteilt',
        panes: 'Bereiche',
        panesHint: 'als Link hinzugefügt, der in Details öffnet',
        builtIn: 'Integriert',
        nativeDescriptions: {
            session_summary: 'Aktivität und nächste Schritte der gewählten Sitzung.',
            agent_plan: 'Verfolge den Plan des Agenten für die gewählte Sitzung.',
            changes: 'Prüfe Dateiänderungen in der gewählten Sitzung.',
            local_services: 'Öffne lokale Dienste der gewählten Sitzung.',
        },
        noMatch: ({ query }) => `Keine Widgets passen zu „${query}“`,
        pickTitle: 'Wähle ein Widget, um es hier zu sehen',
        pickHint: 'Es zeigt deine eigenen Daten in der gewählten Größe, bevor etwas hinzugefügt wird.',
        pickNote: 'Wähle ein Widget, um es hinzuzufügen',
        askAction: 'Anfrage entwerfen',
        pluginTag: 'Plugin',
        pluginProvenance: ({ plugin }) => `Plugin ${plugin}`,
        readsChosenSession: 'liest die gewählte Sitzung, dort wo sie läuft',
        readsFrom: ({ source }) => `liest ${source}`,
        savedQueryOn: ({ source }) => `eine gespeicherte Abfrage auf ${source}`,
        madeByYou: ({ date }) => `von dir erstellt am ${date}`,
        madeByAgent: ({ date }) => `von deinem Agenten erstellt am ${date}`,
        madeByPlugin: ({ date }) => `von einem Plugin erstellt am ${date}`,
        previewLiveData: 'Live, mit deinen Daten',
        addsAtSize: ({ size }) => `Wird in ${size} hinzugefügt. Die Größe kannst du später ändern.`,
        backToWidgets: 'Widgets',
        editTitle: ({ widget }) => `${widget} · Eingaben`,
        editHint: 'Nur diese Kopie ändert sich. Andere Kopien behalten ihre Eingaben.',
        preview: 'Vorschau',
        previewLive: 'Vorschau · live',
        previewWaiting: ({ field }) => `Wähle ${field}, um es hier zu sehen`,
        listOnePerLine: "Eines pro Zeile",
        listCommaSeparated: "Durch Kommas getrennt",
        previewAfterAdd: 'Nach dem Hinzufügen erscheint es hier',
        needed: 'Erforderlich',
        stillNeeded: ({ field }) => `${field} fehlt noch`,
        followGroup: 'Folgen',
        pinGroup: 'Oder eines festlegen',
        another: 'Andere…',
        anotherSubtitle: 'Alles durchsuchen, worauf du Zugriff hast',
        searchChoices: ({ field }) => `${field} durchsuchen`,
        noChoices: 'Hier gibt es noch nichts zur Auswahl',
        optionsLoading: 'Auswahl wird geladen…',
        optionsFailed: 'Die Auswahl konnte nicht geladen werden',
        invalidValue: 'nicht gefunden',
        inputsInvalid: 'Überprüfe die Eingaben dieses Widgets',
        inputsUnavailable: 'Eine ausgewählte Eingabe ist nicht verfügbar',
        connectionNeeded: ({ field }) => `Verbinde dein ${field}`,
        sessionDenied: ({ session }) => `Du hast keinen Zugriff mehr auf ${session}`,
        sessionUnavailable: ({ session }) => `${session} ist nicht verfügbar oder wurde gelöscht`,
        typeUnavailable: ({ field }) => `Der Typ für ${field} ist nicht mehr verfügbar`,
        inputUnavailable: ({ field }) => `${field} ist nicht verfügbar`,
        selectedInputUnavailable: ({ field, value }) => `${field}: ${value} ist nicht mehr verfügbar`,
        invalidReason: 'Du hast keinen Zugriff mehr, oder es wurde entfernt.',
        viewerOnly: 'Alle hier sehen es mit ihrer eigenen Verbindung.',
        justAdded: ({ widget }) => `${widget} hinzugefügt`,
        saved: ({ widget }) => `${widget} gespeichert`,
        addFailed: 'Konnte nicht hinzugefügt werden. Versuche es erneut.',
        saveFailed: 'Konnte nicht gespeichert werden. Versuche es erneut.',
        homeTitle: 'Zur Startseite hinzufügen',
        homeHint: 'Nur du siehst deine Startseite · auf jedem Gerät',
        addWidgets: 'Widgets hinzufügen',
        addToHome: 'Zur Startseite hinzufügen',
        addToBoard: 'Zum Board hinzufügen',
        addToCompanion: 'Zum Begleiter hinzufügen',
        editInputs: 'Eingaben bearbeiten…',
        width: 'Breite',
        size: 'Größe',
        sizes: { small: 'Klein', medium: 'Mittel', wide: 'Breit', full: 'Voll', tall: 'Hoch', large: 'Groß' },
        widthHalf: 'Halb',
        widthFull: 'Voll',
        thisSession: 'Diese Sitzung',
        choicesCount: ({ count }) => count === 1 ? '1 Auswahl' : `${count} zur Auswahl`,
        countOnHome: ({ count }) => `${count} auf der Startseite`,
        countOnBoard: ({ count }) => `${count} auf dem Board`,
        countInCompanion: ({ count }) => `${count} im Begleiter`,
        thisPage: 'Diese Seite',
        thisProject: 'Dieses Projekt',
        thisCheckout: 'Dieser Checkout',
        areaPinned: 'Angeheftet',
        areaPinnedMeta: 'deine Widgets auf dieser Seite',
        areaProjectTitle: 'Widgets',
        areaProjectMeta: 'deine',
        areaAdd: ({ surface }) => `Widget zu ${surface} hinzufügen`,
        areaAddTo: ({ surface }) => `Zu ${surface} hinzufügen`,
        areaHint: 'Nur du siehst diese Widgets',
        countHere: ({ count }) => count === 1 ? '1 hier' : `${count} hier`,
        areaEmptyTitle: 'Noch nichts angeheftet',
        areaEmptyReason: 'Hefte ein Widget an, um es hier zu behalten – nur für dich.',
        areaEmptyAction: 'Widget hinzufügen',
        areaUnavailableTitle: 'Widgets können hier nicht geladen werden',
        projectSourceUnavailableTitle: 'Widgets erscheinen hier, sobald das Repository dieses Projekts bekannt ist',
        areaWriteFailed: 'Diese Änderung konnte nicht gespeichert werden',
        areaApprovalPending: 'Wartet auf Freigabe',
        valueNotFound: ({ value }) => `${value} wurde nicht gefunden`,
        chooseAnother: ({ field }) => `Andere Auswahl für ${field}`,
        chooseField: ({ field }) => `${field} auswählen`,
        widgetOptions: 'Widget-Optionen',
        moveTo: 'Verschieben…',
    } } satisfies Pick<Readonly<Record<string, WidgetAddTranslation>>, "de">;

return { widgetAddTranslations };
})();

const Domain_widgetDefinitionTranslations = (() => {
type WidgetDefinitionTranslation = Shared_widgetDefinitionTranslations.WidgetDefinitionTranslation;

const widgetDefinitionTranslations = { de: {
        yourWidgets: "Deine Widgets",
        yourWidgetsHint: "von dir oder deinen Agents erstellt",
        yourWidget: "Dein Widget",
        moreInSource: "Die Quelle enthält mehr, als hier zu sehen ist.",
        notCurrent: "Nicht aktuell",
        aboutMenu: "Über dieses Widget",
        aboutTitle: "Über dieses Widget",
        aboutUnavailable: "Dieses Widget lässt sich gerade nicht öffnen.",
        aboutData: "Daten",
        aboutReads: "Liest",
        aboutInputs: "Eingaben",
        aboutRefresh: "Aktualisierung",
        aboutUsedIn: "Verwendet in",
        savedFromSession: ({ session }) => `Gespeichert aus ${session}`,
        aSession: "einer Sitzung",
        madeInYourAccount: "In deinem Konto erstellt",
        edited: ({ time }) => `bearbeitet ${time}`,
        readsOnly: "Nur lesend",
        runsOn: ({ machine }) => `läuft auf ${machine}`,
        withYourConnection: "mit deiner eigenen Verbindung",
        readsResource: ({ read, plugin }) => `${read} aus ${plugin}`,
        cannotRunAnythingElse: "Das Widget kann nichts anderes ausführen.",
        inputsThisCopy: "Nur für diese Kopie",
        refreshWhenOpen: "Wenn du es öffnest",
        refreshNow: "Jetzt aktualisieren",
        refreshing: "Wird aktualisiert …",
        refreshed: "Aktualisiert",
        refreshFailed: "Aktualisieren fehlgeschlagen. Die letzten Zahlen bleiben.",
        placedOnHome: "Home",
        placedOnBoard: ({ board }) => `Board ${board}`,
        placedOnABoard: "Ein Board",
        placedInASession: "Eine Sitzung",
        placedInAProject: "Ein Projekt",
        placedOnAPluginPage: "Eine Plugin-Seite",
        placedOnACorePage: "Eine App-Seite",
        notPlacedYet: "Noch nirgends platziert",
        otherPlacesNotListed: "Orte auf anderen Geräten oder geteilten Flächen werden hier nicht aufgeführt.",
        editsChangeAll: ({ count }) => `Änderungen am Widget ändern alle ${count}`,
        editsChangeEverywhere: "Änderungen am Widget gelten überall, wo es verwendet wird",
        changeWithAgent: "Mit dem Agent ändern",
        changeDraft: ({ widget }) => `Ändere das Widget „${widget}“ so, dass `,
        duplicate: "Duplizieren",
        duplicated: ({ name }) => `Kopie „${name}“ unter Deine Widgets gespeichert`,
        duplicateFailed: "Kopie konnte nicht erstellt werden. Versuch es erneut.",
        saveMenu: "Als dein Widget speichern …",
        saveMenuSubtitle: "Eine Kopie für Home und deine Boards",
        saveTitle: "Als dein Widget speichern",
        saveHint: "Eine Kopie für Home, deine Boards und Projekte. Diese Sitzung behält ihr eigenes.",
        saveNote: "In deinem Konto gespeichert · nur für dich",
        saveWidget: "Widget speichern",
        saveFailed: "Widget konnte nicht gespeichert werden. Versuch es erneut.",
        savedButNotPlaced: "Unter Deine Widgets gespeichert, konnte aber nicht überall hinzugefügt werden.",
        savedAsYours: ({ name }) => `„${name}“ unter Deine Widgets gespeichert`,
        name: "Name",
        nameNeeded: "Gib ihm einen Namen",
        becomesViewerInput: "Wird zur Eingabe: Jeder Ort nutzt deine Verbindung",
        becomesContextInput: "Wird zur Eingabe: Jeder Ort wählt selbst",
        alsoAddTo: "Auch hinzufügen zu",
        alsoAddToNamed: ({ place }) => `Auch zu ${place} hinzufügen`,
        snapshotMenu: "Momentaufnahme auf diesem Board posten …",
        snapshotMenuSubtitle: "Alle hier sehen deine Zahlen von jetzt",
        snapshotTitle: "Momentaufnahme für alle hier posten?",
        snapshotHint: ({ widget, time }) => `Alle, die diese Sitzung öffnen können, sehen ${widget} mit Stand ${time}. Es wird nicht aktualisiert, und deine Verbindung bleibt deine.`,
        postSnapshot: "Momentaufnahme posten",
        snapshotNotCurrent: "Das Widget holt noch aktuelle Zahlen. Versuch es erneut, sobald sie da sind.",
        snapshotFailed: "Momentaufnahme konnte nicht gepostet werden. Es wurde nichts geteilt.",
        snapshotAwaitingApproval: "Wartet auf Freigabe in deinem Posteingang. Bis dahin wird nichts geteilt.",
        snapshotPosted: "Momentaufnahme gepostet",
        snapshotNote: "Eine Kopie dieser Zahlen. Sie wird nicht aktualisiert.",
        asOf: ({ time }) => `Stand ${time}`,
    } } satisfies Pick<Readonly<Record<string, WidgetDefinitionTranslation>>, "de">;

return { widgetDefinitionTranslations };
})();

const Domain_widgetFrameTranslations = (() => {
type WidgetFrameTranslation = Shared_widgetFrameTranslations.WidgetFrameTranslation;

const widgetFrameTranslations = { de: {
        styleCard: 'Karte',
        stylePlain: 'Schlicht',
        surfaceHome: 'Start',
        surfaceBoard: 'Board',
        surfaceCompanion: 'Begleiter',
        showFrame: 'Rahmen anzeigen',
        hideFrame: 'Rahmen ausblenden',
        thisWidgetOnly: 'Nur dieses Widget',
        surfaceUses: ({ surface, style }) => `${surface} nutzt ${style}`,
        useSurfaceDefault: ({ surface }) => `Standard von ${surface} verwenden`,
        likeTheOthers: ({ style }) => `${style}, wie die anderen`,
        appearanceTitle: 'Widgets',
        appearanceDescription: 'Wie Widgets auf diesem Gerät gerahmt werden. Ein einzelnes Widget änderst du über sein ⋯-Menü.',
        previewLabel: ({ surface, style }) => `${surface} · ${style}`,
        noticeChanged: 'Rahmen geändert',
        newChip: 'Neu',
        groupInputs: "Eingaben…",
        groupWidth: "Breite",
        widthHalf: "Halb",
        widthFull: "Voll",
        groupFrame: "Rahmen",
        groupDividers: "Trennlinien",
        dividersLines: "Linien",
        dividersNone: "Keine",
        groupSave: "Gruppe speichern…",
        groupSaveSubtitle: "In „Deine Widgets“ behalten, um sie überall hinzuzufügen",
        ungroup: "Gruppierung aufheben",
        ungroupSubtitle: ({ count }) => count === 1 ? 'Sein Widget bleibt hier, auf eigener Karte' : `Seine ${count} Widgets bleiben hier, jedes auf eigener Karte`,
        groupRemove: "Gruppe und ihre Widgets entfernen",
        moveToGroup: "In Gruppe verschieben",
        removeFromGroup: "Aus Gruppe entfernen",
        removeFromGroupSubtitle: "Wieder auf eigener Karte, neben der Gruppe",
        groupWith: "Gruppieren mit…",
        groupWithNew: "Eine neue Gruppe aus beiden",
        groupSlot: "Widget hier ablegen oder",
        groupSlotAdd: "eines hinzufügen",
        groupUntitled: "Gruppe ohne Titel",
        groupName: "Gruppenname",
        groupMenu: "Gruppenoptionen",
        followingGroup: "Folgt der Gruppe",
        followingGroupValue: ({ value }) => `Folgt der Gruppe · ${value}`,
        groupInputsTitle: ({ group }) => `${group} · Eingaben`,
        groupInputsHint: "Einmal festlegen. Widgets, die der Gruppe folgen, nutzen es.",
        groupFollowCount: ({ following, count }) => `${following} von ${count} Widgets folgen der Gruppe`,
        groupFollows: "Folgt",
        groupOwnValue: "Eigener Wert",
        groupGrantsNothing: "Die Gruppe gewährt nichts: Jedes Widget prüft weiter seinen eigenen Zugriff.",
        groupSaved: ({ name }) => `${name} ist in „Deine Widgets“`,
        groupSaveFailed: "Die Gruppe konnte nicht gespeichert werden. Versuch es noch einmal.",
        moveIntoGroupNamed: ({ group }) => `In ${group} verschieben`,
        intoGroupAbove: ({ target }) => `Über ${target} · erscheint in der Gruppe ohne Rahmen`,
        intoGroupBelow: ({ target }) => `Unter ${target} · erscheint in der Gruppe ohne Rahmen`,
        intoGroupEnd: "Erscheint in der Gruppe ohne Rahmen",
        reorderInGroupDetail: "Nur die Reihenfolge",
        outOfGroupDetail: ({ group }) => `Aus ${group} heraus · bekommt wieder eine eigene Karte`,
        wholeGroupDetail: ({ count }) => count === 1 ? `Ihr Widget zieht mit um` : `Ihre ${count} Widgets ziehen mit um`,
        cantPutInGroup: ({ group }) => `Passt nicht in ${group}`,
        groupRefusedWidth: "Es braucht die volle Breite, diese Gruppe ist halb. Leg es daneben ab oder mach die Gruppe voll breit.",
        groupRefusedNesting: "Gruppen können nicht in Gruppen liegen. Lege sie darüber oder darunter ab oder löse sie zuerst auf.",
        groupNeedsFullWidth: ({ widget }) => `${widget} braucht die volle Breite`,
        groupFacts: ({ width, count }) => `${width} · ${count} Widgets`,
        groupCannotTake: ({ group }) => `Braucht die volle Breite; ${group} ist halb`,
        groupA11y: ({ name }) => `Gruppe: ${name}`,
        groupCount: ({ count }) => `Gruppe · ${count}`,
        groupWidgetCount: ({ count }) => count === 1 ? 'Gruppe · 1 Widget' : `Gruppe · ${count} Widgets`,
        addsAtWidth: ({ width }) => `Fügt es mit Breite ${width} hinzu.`,
        presetEdited: "Bearbeitet",
        presetEditedTail: ({ changes }) => changes ? ` gehört jetzt dir: Du hast ${changes}. Die Vorlage bleibt erhalten.` : ' gehört jetzt dir. Die Vorlage bleibt erhalten.',
        presetChangeList: ({ first, second, more }) => more > 0 ? `${first}, ${second} und ${more} weitere ${more === 1 ? 'Änderung' : 'Änderungen'} vorgenommen` : second ? `${first} und ${second}` : first,
        presetMovedUp: ({ item }) => `${item} nach oben verschoben`,
        presetMovedDown: ({ item }) => `${item} nach unten verschoben`,
        presetAdded: ({ item }) => `${item} hinzugefügt`,
        presetRemoved: ({ item }) => `${item} entfernt`,
        presetChanged: ({ item }) => `${item} geändert`,
        presetRenamed: "den Namen geändert",
        groupProvenance: ({ origin, date, count }) => ['Deine Gruppe', origin && date ? `gespeichert von ${origin} am ${date}` : date ? `gespeichert am ${date}` : origin ? `gespeichert von ${origin}` : null, count === 1 ? '1 Widget' : `${count} Widgets`].filter(Boolean).join(' · '),
        groupAddsFollowing: ({ name, count, value }) => `Fügt ${name} mit ${count === 1 ? 'seinem Widget' : `seinen ${count} Widgets`} hinzu${value ? `, folgt ${value}` : ''}`,
        groupInputAskedOnce: ({ count }) => count === 1 ? 'Wird einmal gefragt. Das Widget folgt der Auswahl.' : `Wird einmal gefragt. Die ${count} Widgets folgen der Auswahl.`,
        presetReset: "Auf Vorlage zurücksetzen",
        presetResetDone: ({ name }) => `${name} ist wieder auf der Vorlage`,
        presetResetFailed: "Zurücksetzen auf die Vorlage fehlgeschlagen.",
        undo: "Rückgängig",
        groupAddTo: "Hinzufügen zu…",
        groupAddToSubtitle: "Eine Kopie auf einem anderen Start oder Projekt",
        groupCopied: ({ name, place }) => `${name} nach ${place} kopiert`,
        groupCopyFailed: "Die Gruppe konnte nicht kopiert werden. Versuch es noch einmal.",
        groupSaveTitle: "Gruppe speichern",
        groupSaveHint: ({ count }) => `In „Deine Widgets“ behalten, mit ${count} Widgets, um sie überall hinzuzufügen.`,
        groupSaveNote: "Eine Kopie: Diese Gruppe bleibt, wie sie ist.",
    } } satisfies Pick<Readonly<Record<string, WidgetFrameTranslation>>, "de">;

return { widgetFrameTranslations };
})();

const Domain_widgetGlanceTranslations = (() => {
type WidgetGlanceTranslation = Shared_widgetGlanceTranslations.WidgetGlanceTranslation;

const widgetGlanceTranslations = { de: {
        changesTitle: 'Änderungen',
        localServicesTitle: 'Lokale Dienste',
        changesSource: 'Git',
        reviewChanges: 'Änderungen prüfen',
        notARepo: 'Der Ordner dieser Sitzung ist kein Git-Repository.',
        noChanges: 'Noch keine Änderungen. Dateien, die der Agent bearbeitet, erscheinen hier.',
        changesLoading: 'Änderungen werden geladen',
        running: 'Läuft',
        notRunning: 'Läuft nicht',
        nothingRunning: 'Nichts läuft. Dienste, die diese Sitzung startet, erscheinen hier.',
        servicesLoading: 'Lokale Dienste werden geladen',
        servicesReadFailed: 'Lokale Dienste konnten nicht gelesen werden. Versuche es erneut.',
        noMachine: 'Diese Sitzung hat keine Maschine, die gefragt werden kann.',
        changedCount: ({ count }) => `${count} geändert`,
        moreFiles: ({ count }) => (count === 1 ? '1 weitere Datei' : `${count} weitere Dateien`),
        runningCount: ({ count }) => `${count} laufen`,
        openInBrowser: ({ name }) => `${name} im Browser öffnen`,
        paneLinkA11y: ({ pane }) => `${pane}. Öffnet sich neben dem Chat`,
    } } satisfies Pick<Readonly<Record<string, WidgetGlanceTranslation>>, "de">;

return { widgetGlanceTranslations };
})();

const Domain_workStatusTranslations = (() => {
type WorkStatusTranslations = Shared_workStatusTranslations.WorkStatusTranslations;

const en = Shared_workStatusTranslations.en;

const de: WorkStatusTranslations = {
    buckets: {
        needs_you: 'Braucht dich',
        working: 'In Arbeit',
        finished: 'Fertig',
        idle: 'Inaktiv',
        offline: 'Offline',
    },
};

const workStatusTranslations = { de: { ...de, task: { stopped: 'Gestoppt', linkFailed: 'Die Sitzung wurde erstellt, aber die Aufgabenverknüpfung wurde nicht gespeichert. Versuche erneut, dieselbe Sitzung zu verknüpfen.' } } };

return { workStatusTranslations };
})();

const Domain_workflowActionTranslations = (() => {
type Copy = Shared_workflowActionTranslations.Copy;

const en = Shared_workflowActionTranslations.en;

const workflowActionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "de"> = { de: {
        host: "Happier",
        structure: "Struktur",
        callWebhook: "Webhook aufrufen",
        runCommand: "Befehl ausführen",
        commandValuesInEnv: "Workflow-Werte werden als Umgebungsvariablen übergeben. Der Befehlstext bleibt wie geschrieben.",
        waitForWork: "Auf Arbeit warten",
        waitForWorkDescription: "Warten, bis die gewählte Arbeit den gewünschten Zustand erreicht",
        callWebhookDescription: "Eine Anfrage an eine Webadresse senden. Kein Agent-Schritt.",
        runCommandDescription: "Einen Shell-Befehl auf deiner Maschine ausführen. Kein Agent-Schritt.",
        artifactCreate: "Dokument erstellen",
        artifactGet: "Dokument lesen",
        artifactList: "Dokumente auflisten",
        artifactUpdate: "Dokument aktualisieren",
        artifactDelete: "Dokument löschen",
        artifactPublish: "Datei veröffentlichen",
        artifactRevisions: "Dokumentversionen auflisten",
        artifactRestore: "Dokumentversion wiederherstellen",
        artifactUsage: "Dokumentspeichernutzung lesen",
        artifactShare: "Dokument per Link teilen",
        artifactLinks: "Dokumentlinks auflisten",
        artifactRevoke: "Dokumentlink widerrufen",
        artifactAudit: "Dokumentlink-Aktivität lesen",
        sessionRole: "Sitzungsrolle festlegen",
        sessionRoleOverride: "Rolleneinstellungen einer Sitzung ändern",
        sessionRoleClear: "Rolleneinstellungen einer Sitzung zurücksetzen",
        sessionRoleAdd: "Sitzungsrolle hinzufügen",
        sessionRoleRemove: "Sitzungsrolle entfernen",
        sessionNotes: "Sitzungsnotizen festlegen",
        sessionRolesApply: "Rollen auf berichtende Sitzungen anwenden",
        roleList: "Rollen auflisten",
        roleGet: "Rolle lesen",
        roleCreate: "Rolle erstellen",
        roleUpdate: "Rolle aktualisieren",
        roleDelete: "Rolle löschen",
        roleOverride: "Rolleneinstellungen ändern",
        roleReset: "Rolleneinstellungen zurücksetzen",
        widgetCatalog: "Verfügbare Widgets auflisten",
        widgetInstances: "Platzierte Widgets auflisten",
        widgetAdd: "Widget hinzufügen",
        widgetRemove: "Widget entfernen",
        widgetMove: "Widget verschieben",
        widgetRename: "Widget umbenennen",
        widgetSize: "Widget-Größe festlegen",
        widgetFrame: "Widget-Rahmen festlegen",
        widgetInputs: "Widget-Eingaben lesen",
        widgetValidate: "Widget-Eingaben prüfen",
        widgetSetInputs: "Widget-Eingaben festlegen",
        widgetResetInputs: "Widget-Eingaben zurücksetzen",
        widgetLayout: "Widget-Layout lesen",
        widgetUpdateLayout: "Widget-Layout ändern",
        widgetDefinitions: "Gespeicherte Widgets auflisten",
        widgetDefinition: "Gespeichertes Widget lesen",
        widgetCreate: "Widget erstellen",
        widgetUpdate: "Gespeichertes Widget aktualisieren",
        widgetDuplicate: "Gespeichertes Widget duplizieren",
        widgetDelete: "Gespeichertes Widget löschen",
        widgetSave: "Sitzungs-Widget speichern",
    } };

return { workflowActionTranslations };
})();

const Domain_workflowAgentAuthoringTranslations = (() => {
type Edit = Shared_workflowAgentAuthoringTranslations.Edit;

type RepeatableMessage = Shared_workflowAgentAuthoringTranslations.RepeatableMessage;

type Copy = Shared_workflowAgentAuthoringTranslations.Copy;

const en = Shared_workflowAgentAuthoringTranslations.en;

const repeatable = { de: { repeatable: 'Wiederholbar machen', repeatableDescription: 'Bitte den Agenten, daraus einen wiederverwendbaren Workflow zu machen.', repeatablePrompt: 'Mache aus unserer Arbeit hier einen Workflow, den ich wieder ausführen kann. Entwirf ihn, prüfe ihn mit workflow.validate und speichere ihn, aber starte ihn nicht.', repeatableMessagePrompt: 'Mache aus unserer Arbeit in dieser Nachricht einen Workflow, den ich wieder ausführen kann. Entwirf ihn, prüfe ihn mit workflow.validate und speichere ihn, aber starte ihn nicht.', repeatableMessageSource: ({ text }: RepeatableMessage) => `“${text}”` } };

const workflowAgentAuthoringTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "de"> = { de: { ...repeatable.de, create: 'Mit einem Agenten erstellen', edit: 'Mit einem Agenten bearbeiten', agent: 'Agent', description: 'Eine neue Sitzung entwirft den Workflow mit dir, prüft ihn und speichert ihn. Erst „Jetzt starten“ führt ihn aus.', changedByAgent: 'Vom Agenten geändert', saved: 'Gerade vom Agenten gespeichert', savedAge: ({ age }) => `Vom Agenten gespeichert ${age}`, savedWorkflow: ({ name }) => `Workflow gespeichert · ${name}`, updated: 'Workflow aktualisiert', changed: ({ count }) => `Workflow aktualisiert · ${count} Schritte geändert`, openEditor: 'Im Editor öffnen', openSession: 'In Sitzungen öffnen', createPrompt: 'Entwirf mit mir einen Workflow, prüfe ihn mit workflow.validate und speichere ihn dann. Starte ihn nicht.', createLead: 'Hilf mir, einen Workflow zu erstellen, der ', editPrompt: ({ name, definitionId, headerVersion, bodyVersion }) => `Der gespeicherte Workflow „${name}“ hat die ID ${definitionId} und die Revision: Kopf ${headerVersion}, Inhalt ${bodyVersion}. Ändere ihn mit workflow.definition.edit und nutze workflow.definition.update nur, um ihn ganz zu ersetzen. Prüfe ihn vor dem Speichern mit workflow.validate. Starte ihn nicht.`, editLead: ({ name }) => `Hilf mir, ${name} zu ändern: ` } };

return { repeatable, workflowAgentAuthoringTranslations };
})();

const Domain_workflowBuiltinTranslations = (() => {
type WorkflowBuiltinTranslations = Shared_workflowBuiltinTranslations.WorkflowBuiltinTranslations;

const en = Shared_workflowBuiltinTranslations.en;

const de: WorkflowBuiltinTranslations = {
    keepGoing: { title: 'Weitermachen bis fertig', description: 'Läuft weiter, bis das Ziel erreicht ist' },
    reviewAndConverge: { title: 'Prüfen & angleichen', description: 'Prüfen, bis die Prüfer sich einig sind', apply: 'Anwenden', verifyAndFix: 'Prüfen und beheben', verifyOnly: 'Nur prüfen', rounds: 'Runden bis zum Stopp' },
    planWithAPanel: { title: 'Mit einem Gremium planen', description: 'Mehrere Agenten planen nebeneinander, dann wartet der Plan auf deine Prüfung.', inputs: { request: 'Anfrage', requestPlaceholder: 'Was soll das Gremium planen?', engines: 'Planende Agenten' } },
    openAPullRequest: { title: 'Pull-Request öffnen', description: 'Holt eine zweite Meinung ein und öffnet dann einen Pull-Request. Wenn die zweite Meinung widerspricht, wartet er auf dich.', inputs: { base: 'Basis-Branch', title: 'Titel des Pull-Requests', body: 'Beschreibung', question: 'Frage an die zweite Meinung' } },
};

const workflowBuiltinTranslations = { de } as const;

return { workflowBuiltinTranslations };
})();

const Domain_workflowFieldTranslations = (() => {
const workflowFieldTranslations = { de: {
        sessionId: "Sitzung",
        triggerId: "Auslöser",
        engineIds: "Prüfer",
        backendTargetKeys: "Planer",
        reviewCommentAuthorIntent: "Befunde",
        commentId: "Befund",
        expectedServerRevision: "Befundversion",
        clientMutationId: "Aktualisierung",
        projectId: "Projekt",
        workspace: "Arbeitsbereich",
        toState: "Status",
        expectedState: "Aktueller Status",
        disposition: "Wichtigkeit",
        allPages: "Alle Befunde",
        permissionMode: "Berechtigungen",
        target: "Läuft in",
        cwd: "Arbeitsordner",
        maxRounds: "Maximale Runden",
        strikes: "Prüfungen ohne Fortschritt",
        secondOpinion: "Zweitmeinung",
        useJudge: "Beurteiler",
        diffFingerprint: "Geprüfte Änderungen",
        url: "URL",
        body: "JSON-Inhalt",
        command: "Befehl",
        env: "Umgebungsvariablen",
    } };

return { workflowFieldTranslations };
})();

const Domain_workflowEditorPageTranslations = (() => {
type WorkflowEditorPageTranslations = Shared_workflowEditorPageTranslations.WorkflowEditorPageTranslations;

const workflowFieldTranslations = {...Domain_workflowFieldTranslations.workflowFieldTranslations, ...EnglishFeatures.workflowFieldTranslations.workflowFieldTranslations};

const en = Shared_workflowEditorPageTranslations.en;

const pluralPl = Shared_workflowEditorPageTranslations.pluralPl;

const pluralRu = Shared_workflowEditorPageTranslations.pluralRu;

const de: WorkflowEditorPageTranslations = {
    fields: workflowFieldTranslations.de,
    blocks: {
        actionSub: 'Aktion · kein Agentenzug',
        notSet: 'Nicht gesetzt',
        set: 'Setzen',
        clear: 'Leeren',
        required: 'Erforderlich',
        noFields: 'Für diese Aktion ist nichts festzulegen.',
        workflowSub: 'Führt einen anderen Workflow aus · seine Schritte erscheinen in diesem Lauf',
        builtin: 'Integriert',
        waitTitle: 'Auf dich warten',
        waitSub: 'Diese Spur wartet, bis du weitermachst',
        waitSubRoot: 'Dieser Workflow wartet, bis du fortfährst.',
        waitPlaceholder: 'Was solltest du hier prüfen oder entscheiden?',
        returnsText: 'Gibt Text zurück',
        returnsFields: ({ fields }) => `Gibt zurück: ${fields}`,
        workflowDefaults: 'Workflow-Standards',
        addNamedResults: 'Benannte Ergebnisse hinzufügen',
        menuRun: 'Einen Workflow ausführen',
        menuAction: 'Aktion',
        menuWait: 'Auf dich warten',
        actionSearch: 'Aktionen suchen',
        workflowSearch: 'Workflows suchen',
        libraryGroup: 'Deine Workflows',
        noAgentTurn: 'Benachrichtigen, prüfen, posten — ohne Agentenzug',
        agentSub: 'Eine Anweisung für einen Agenten',
        parallelSub: 'Zweige, die gleichzeitig laufen',
        loopSub: 'Für jedes Element, mehrmals oder bis…',
        ifSub: 'Nur wenn ein Ergebnis es vorgibt',
        actionSourcePhone: 'Dein Telefon',
        actionSourceReview: 'Review-Engines',
        useNumber: 'Eine Zahl verwenden',
        actionUnavailable: ({ action }: { action: string }) => `${action} ist hier nicht verfügbar.`,
        childInputs: ({ workflow }: { workflow: string }) => `Die Eingaben kommen von ${workflow}.`,
        retryLoading: "Erneut laden",
        openWorkflow: ({ workflow }) => `${workflow} öffnen`,
        selfRef: ({ workflow }: { workflow: string }) => `${workflow} führt diesen Workflow aus und kann daher nicht darin laufen.`,
        maxFromInput: ({ name }: { name: string }) => `Aus Eingabe · ${name}`,
        useInput: ({ name }: { name: string }) => `Eingabe ${name} verwenden`,
    },
    backToRun: 'Zurück zum Lauf',
    reviewedCopyTitle: 'Vor dem Speichern prüfen',
    reviewedCopyBody: 'Dies ist eine Kopie aus einem Lauf. Gespeichert werden Schritte und Einstellungen, nicht Verlauf oder Ergebnisse. Ausführungsort, Laufart und Eingabewerte gelten nur für den Lauf. Prüfe Verweise auf bestehende Sitzungen, Ordner, Profile, Modelle, Dienste und MCP-Server vor der Wiederverwendung.',
    chromeTitle: 'Workflow',
    untitled: 'Unbenannter Workflow',
    nameLabel: 'Name des Workflows',
    descriptionPlaceholder: 'Beschreibung hinzufügen',
    descriptionLabel: 'Beschreibung',
    save: 'Speichern',
    flow: 'Ablauf',
    flowSubtitle: 'Dieser Entwurf als Karte',
    settings: 'Workflow-Einstellungen',
    settingsSubtitle: 'Jeder Schritt nutzt diese, außer er ändert sie.',
    deleteWorkflow: 'Workflow löschen',
    deleteBody: 'Frühere Läufe bleiben erhalten.',
    discardChangesBody: 'Kehrt zur zuletzt gespeicherten Version zurück. Rückgängig holt deine Änderungen zurück.',
    deleteFailedTitle: 'Workflow konnte nicht gelöscht werden',
    changedForStep: 'Für diesen Schritt geändert',
    issuesToFix: ({ count }: { count: number }) => (count === 1 ? '1 Punkt ist zu beheben, bevor er laufen kann' : `${count} Punkte sind zu beheben, bevor er laufen kann`),
    readyToRun: 'Bereit',
    saveStatus: {
        notSaved: 'Noch nicht gespeichert',
        unsaved: 'Ungespeicherte Änderungen',
        saving: 'Wird gespeichert…',
        saved: 'Gespeichert',
        savedJustNow: 'Gerade gespeichert',
        savedAge: ({ age }: { age: string }) => `Gespeichert ${age}`,
        failed: 'Speichern fehlgeschlagen',
        yourEdits: 'Deine Änderungen',
        newerVersion: 'Die neuere Version',
        newerVersionRevision: ({ revision }: { revision: string }) => `Die neuere Version · ${revision}`,
    },
    where: {
        label: 'Wo er läuft',
        choose: 'Wähle, wo er läuft',
    },
    sections: {
        whereTitle: 'Wo er läuft',
        machineAndProject: 'Gerät und Projekt',
        eachStepRunsIn: 'Jeder Schritt läuft in',
        eachStepSession: 'Jeder Schritt erscheint in deiner Sitzungsliste, unter diesem Lauf.',
        eachStepBackground: 'Jeder Schritt läuft im Hintergrund, unter diesem Lauf.',
        aSession: 'Einer Sitzung',
        aBackgroundRun: 'Einem Hintergrundlauf',
        agentTitle: 'Agent und Modell',
        agentDescription: 'Schritte nutzen diese, außer sie wählen eigene.',
        rolesTitle: 'Rollen für diesen Workflow',
        conversationTitle: 'Unterhaltung und Arbeitsbereich',
        inputsTitle: 'Eingaben und Ergebnis',
    },
    unavailable: {
        machine_not_selected: 'Wähle zuerst ein Gerät.',
        capability_unknown: 'Prüfe, was dieses Gerät unterstützt.',
        machine_does_not_support_detached_runs: 'Dieses Gerät kann noch keine Hintergrundläufe ausführen.',
    },
    /** Workflow settings and Step options (U-9): group summaries and the block subject. */
    inspector: {
        stepOptions: 'Schrittoptionen',
        whereMissing: 'Kein Gerät gewählt',
        none: 'Keine',
        inputCount: ({ count }) => count === 1 ? '1 Eingabe' : `${count} Eingaben`,
        finalOutput: ({ output }) => `Endergebnis: ${output}`,
        originSession: 'Die Sitzung, die ihn gestartet hat',
        differsFromWorkflow: 'weicht vom Workflow ab',
        followsWorkflow: 'nutzt die Workflow-Einstellungen',
        advancedTitle: 'Erweitert',
        deadline: ({ ms }) => `Wartet ${ms} ms auf sein Ergebnis`,
        workflowDefault: ({ value }) => `Workflow-Standard · ${value}`,
        aSession: 'Eine Sitzung…',
        continues: ({ session }) => `Setzt ${session} fort`,
        runsIn: 'Läuft in',
        runsInBoundBySession: 'Setzt eine Sitzung fort und läuft deshalb in dieser Sitzung.',
        reviewTitle: 'Vor dem Fortfahren prüfen',
        reviewDescription: 'Spätere Schritte in dieser Spur warten, bis du das Ergebnis verwendest, bearbeitest oder neu erzeugst. Andere Arbeit läuft weiter.',
        reviewEvaluator: 'Jede Runde wartet auf deine Prüfung.',
        reviewsBeforeContinuing: 'Prüfung vor dem Fortfahren',
        resultTitle: 'Ergebnis',
        resultFromAction: ({ action }) => `Festgelegt durch ${action}`,
        resultFromWorkflow: ({ workflow }) => `Gibt zurück, was ${workflow} zurückgibt`,
        back: 'Zurück',
        options: 'Optionen',
        itemConversation: 'Eigene Unterhaltung pro Element; die Schritte darin teilen sie.',
        dropContinue: ({ session }) => `${session} in diesem Schritt fortsetzen`,
        dropRefused: ({ session, machine, where }) => `${session} ist auf ${machine}; dieser Workflow läuft auf ${where}.`,
        lanes: ({ count }) => `Nebeneinander · ${count} Spuren`,
        laneCount: ({ count }) => (count === 1 ? '1 Spur' : `${count} Spuren`),
        lane: ({ position }) => `Spur ${position}`,
        forEachIn: ({ source }) => `Für jedes Element in ${source}`,
        atATime: ({ count }) => `${count} gleichzeitig`,
        repeatTimes: ({ count }) => `${count}-mal wiederholen`,
        repeatUntil: ({ condition }) => `Wiederholen bis ${condition}`,
        repeatUntilDecided: 'Wiederholen, bis ein Schritt Stopp sagt',
        ifSentence: ({ condition }) => `Wenn ${condition}`,
        onlyWhenSentence: ({ condition }) => `Nur wenn ${condition}`,
        conditionAll: 'alle davon zutreffen',
        conditionAny: 'eines davon zutrifft',
        conditionNot: ({ condition }) => `nicht (${condition})`,
        returnsStructured: 'Gibt strukturierte Daten zurück',
        returnsDecision: 'Gibt eine Entscheidung zurück',
    },
};

const workflowEditorPageTranslations = { de } as const;

return { workflowEditorPageTranslations };
})();

const Domain_workflowExamplesTranslations = (() => {
type ExampleCopy = Shared_workflowExamplesTranslations.ExampleCopy;

type Copy = Shared_workflowExamplesTranslations.Copy;

const workflowExamplesTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "de"> = { de: {
        sessionNotifyDescription: "Eine Benachrichtigung, sobald der Agent dieser Sitzung deine Eingabe braucht.",
        sessionDailySummaryDescription: "Jeden Tag um 09:00 eine Zusammenfassung hier.",
        sessionTestDescription: "Führt nach jedem abgeschlossenen, fehlgeschlagenen oder abgebrochenen Turn einen bearbeitbaren Testbefehl aus.",
        notifyWhenAgentWaits: { title: "Benachrichtige mich, wenn ein Agent wartet", description: "Wähle eine Sitzung und erhalte eine Benachrichtigung, sobald ihr Agent deine Eingabe braucht." },
        dailySummaryInSession: { title: "Tägliche Zusammenfassung in dieser Sitzung", description: "Wähle eine Sitzung für eine Zusammenfassung jeden Tag um 09:00 Uhr." },
        memoryUpkeepInSession: { title: 'Erinnerungen pflegen', description: 'Prüfe die Erinnerungen dieser Sitzung täglich um 09:00 Uhr und halte nützliche Fakten aktuell.' },
        installDepsInWorktree: { title: "Abhängigkeiten in einem neuen Worktree installieren", description: "Erstelle einen neuen Worktree und führe dort einen bearbeitbaren Installationsbefehl aus." },
        testAfterEveryTurn: { title: "Nach jedem Zug testen", description: "Wähle eine Sitzung und führe nach jedem abgeschlossenen, fehlgeschlagenen oder abgebrochenen Zug einen bearbeitbaren Testbefehl aus." },
        noSessions: "Starte eine Arbeitssitzung, um diese Vorlage zu verwenden.",
        nodes: { ask: 'Fragen', 'review-correctness': 'Korrektheit prüfen', 'review-tests': 'Tests prüfen', summarize: 'Befunde zusammenfassen', analyze: 'Analysieren', review: 'Prüfen', fix: 'Beheben', check: 'Überprüfen', classify: 'Einordnen', reply: 'Antwort entwerfen', digest: 'Änderungen zusammenfassen' },
        title: 'Mit einem Beispiel beginnen', fromExample: 'Aus einem Beispiel', description: 'Jedes öffnet sich als Entwurf. Erst mit „Jetzt ausführen“ startet etwas.', sessionDescription: 'Jedes öffnet sich als Entwurf in dieser Sitzung. Nichts läuft, bis du es einschaltest.', use: 'Dieses verwenden', chooseSession: 'Sitzung auswählen…', builtInDescription: 'Teil von Happier. Zum Ändern duplizieren.', stepCount: ({ count }) => `${count} ${count === 1 ? 'Schritt' : 'Schritte'}`,
        askOnce: { title: 'Einmal fragen', description: 'Ein Schritt: einen Agenten fragen und seine Antwort erhalten.' },
        reviewPullRequest: { title: 'Pull-Request prüfen', description: 'Zwei Prüfer nebeneinander, dann eine Zusammenfassung aller Befunde.' },
        workThroughEachFile: { title: 'Jede Datei bearbeiten', description: 'Jede Datei der Liste einzeln analysieren und danach die Änderung prüfen.' },
        repairUntilItPasses: { title: 'Bis zum Erfolg reparieren', description: 'Reparieren und prüfen, bis die Prüfung besteht oder deine Versuche aufgebraucht sind. Dann prüfst du die letzte Reparatur.' },
        triageAnIssue: { title: 'Ein Issue einordnen', description: 'Ein Issue einordnen. Fehler beheben, sonst eine Antwort entwerfen.' },
        morningDigest: { title: 'Morgenüberblick', description: 'Projektänderungen zusammenfassen und dir senden. Für jeden Morgen einen Auslöser hinzufügen.' },
    } };

return { workflowExamplesTranslations };
})();

const Domain_workflowPluginTranslations = (() => {
type Copy = Shared_workflowPluginTranslations.Copy;

const en = Shared_workflowPluginTranslations.en;

const workflowPluginTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "de"> = { de: { fromPlugins: 'Aus Plugins', readOnly: 'Schreibgeschützt · zum Bearbeiten in deine Bibliothek kopieren', duplicateToLibrary: 'In deine Bibliothek kopieren' } };

return { workflowPluginTranslations };
})();

const Domain_workflowRunVisibilityTranslations = (() => {
type VisibilityCopy = Shared_workflowRunVisibilityTranslations.VisibilityCopy;

const workflowRunVisibilityTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', VisibilityCopy>, "de"> = { de: { title: "Sichtbarkeit", chooseTeam: "Team wählen", loadFailed: "Sichtbarkeit des Laufs konnte nicht geprüft werden", machines: "Läuft auf deinen Maschinen", transcripts: "Teammitglieder können die Schrittgespräche ansehen.", requiredSessionsEditable: "Die Sitzungen dieses Teams können von seinen Mitgliedern bearbeitet werden", visibleTo: ({ team }) => "Sichtbar für " + team } };

return { workflowRunVisibilityTranslations };
})();

const Domain_workflowRunCompositionTranslations = (() => {
const workflowRunVisibilityTranslations = {...Domain_workflowRunVisibilityTranslations.workflowRunVisibilityTranslations, ...EnglishFeatures.workflowRunVisibilityTranslations.workflowRunVisibilityTranslations};

const en = Shared_workflowRunCompositionTranslations.en;

const workflowRunCompositionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "de"> = { de: { visibility: workflowRunVisibilityTranslations.de, runWithAnotherAgent: 'Mit anderem Agenten erneut ausführen', agentForStep: ({ step }) => `Agent für ${step}`, chooseAgent: 'Agent oder Rolle wählen' } };

return { workflowRunCompositionTranslations };
})();

const Domain_workflowRunListTranslations = (() => {
type Progress = Shared_workflowRunListTranslations.Progress;

const en = Shared_workflowRunListTranslations.en;

const workflowRunListTranslations = { de: {
        observedProgress: ({ status }: { status: string }) => `Beobachtet: ${status}`,
        definitions: 'Definitionen',
        stepsProgress: ({ completed, total }: Progress) => `${completed} von ${total} Schritten`,
        loopProgress: ({ completed, total }: Progress) => `${completed} von ${total} Elementen`,
        startedByAgent: 'Von einem Agenten gestartet',
        startedByTrigger: 'Durch einen Auslöser gestartet',
    } } satisfies Pick<Record<string, typeof en>, "de">;

return { workflowRunListTranslations };
})();

const Domain_workflowRunRoleTranslations = (() => {
const en = Shared_workflowRunRoleTranslations.en;

const workflowRunRoleTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "de"> = { de: { rolesTitle: 'Rollen für diesen Lauf', rolesYour: 'Deine Rollen', rolesChanged: ({ count }) => `${count} für diesen Lauf geändert`, rolesUnchanged: 'Alles andere bleibt gleich.', useYourRole: 'Deine Rolle verwenden', targetsTitle: 'Jeder Schritt läuft in', rolesPrefillFailed: 'Die Rollen deines letzten Laufs konnten nicht gelesen werden. Versuche es erneut.' } };

return { workflowRunRoleTranslations };
})();

const Domain_workflowStartTranslations = (() => {
type Copy = Shared_workflowStartTranslations.Copy;

const workflowRunRoleTranslations = {...Domain_workflowRunRoleTranslations.workflowRunRoleTranslations, ...EnglishFeatures.workflowRunRoleTranslations.workflowRunRoleTranslations};

const workflowRunCompositionTranslations = {...Domain_workflowRunCompositionTranslations.workflowRunCompositionTranslations, ...EnglishFeatures.workflowRunCompositionTranslations.workflowRunCompositionTranslations};

const en = Shared_workflowStartTranslations.en;

const workflowStartTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "de"> = { de: { ...workflowRunRoleTranslations.de, ...workflowRunCompositionTranslations.de, shortcutStarts: 'startet', neededNamed: ({ name }) => `Eingaben · ${name} fehlt`, addToStart: ({ name }) => `Gib ${name} an, um zu starten`, workflow: 'Workflow', inputs: 'Eingaben', start: 'Starten', starting: 'Wird gestartet…', stillStarting: 'Start wird noch geprüft…', needed: ({ count }) => `Eingaben · ${count} fehlen`, required: 'Zum Starten erforderlich', preview: 'Was passiert', unsaved: 'Enthält ungespeicherte Änderungen', remove: 'Zur einfachen Sitzung zurück', search: 'Workflow suchen', builtin: 'Integriert', library: 'Deine Bibliothek', noInputs: 'Keine Eingaben nötig', asksFor: ({ names }) => `Benötigt ${names}`, optional: 'Optional — bleibt leer', defaultValue: ({ value }) => `Standard: ${value}` } };

return { workflowStartTranslations };
})();

const Domain_workflowsDestinationTranslations = (() => {
type WorkflowsDestinationTranslations = Shared_workflowsDestinationTranslations.WorkflowsDestinationTranslations;

const en = Shared_workflowsDestinationTranslations.en;

const de: WorkflowsDestinationTranslations = {
    description: 'Abläufe, die deine Agenten auf deinen Rechnern ausführen – wann du willst, nach Zeitplan oder wenn etwas passiert.',
    import: 'Importieren',
    addAccessibility: 'Workflow hinzufügen',
    moreAccessibility: 'Weitere Workflow-Optionen',
    addMenu: {
        newWorkflowSubtitle: 'Mit einem leeren Entwurf beginnen',
        importSubtitle: 'Eine Workflow-JSON-Datei',
    },
    sections: {
        needsYou: 'Braucht dich',
        running: 'Läuft',
        library: 'Bibliothek',
        sharedWithYou: 'Mit dir geteilt',
        triggers: 'Auslöser',
        history: 'Verlauf',
    },
    allRuns: 'Alle Läufe',
    lastRun: ({ age }) => `zuletzt gelaufen ${age}`,
    strip: {
        label: ({ count, parts }) => `${count === 1 ? 'Letzter Lauf' : `Letzte ${count} Läufe`}: ${parts}`,
        labelPlain: ({ count }) => (count === 1 ? 'Letzter Lauf' : `Letzte ${count} Läufe`),
        completed: ({ count }) => `${count} abgeschlossen`,
        failed: ({ count }) => `${count} fehlgeschlagen`,
        needsYou: ({ count }) => `${count} ${count === 1 ? 'braucht' : 'brauchen'} dich`,
        separator: ', ',
    },
    runSettings: 'Lauf-Einstellungen',
    libraryEmpty: 'Gespeicherte Workflows erscheinen hier.',
    waitingForYou: ({ age }) => `Wartet auf dich · ${age}`,
    stateAge: ({ state, age }) => `${state} · ${age}`,
    triggerRow: ({ when, then }) => `${when} · ${then}`,
    thenSendPrompt: 'Prompt senden',
    thenRunWorkflow: 'Workflow ausführen',
    offline: 'Offline',
    off: 'Aus',
    columnLoadFailed: 'Workflows konnten nicht geladen werden. Nichts Gespeichertes geht verloren.',
    firstVisitTitle: 'Speichere Prompts, die funktionieren, und führe sie erneut aus',
    firstVisitBody: 'Ein Workflow ist eine Folge von Schritten, die deine Agenten nacheinander, nebeneinander oder einmal pro Element ausführen – wann du willst, nach Zeitplan oder wenn etwas passiert.',
    importPrompt: 'Hast du eine Workflow-Datei?',
    loadMoreWorkflows: 'Weitere Workflows laden',
    searchPlaceholder: 'Workflows durchsuchen',
    noMatch: ({ query }) => `Keine Workflows passen zu „${query}“`,
    views: {
        all: 'Alle',
        triggered: 'Ausgelöst',
        active: 'Aktiv',
        needsYou: 'Braucht dich',
        libraryAccessibility: 'Welche Workflows angezeigt werden',
        historyAccessibility: 'Welche Läufe angezeigt werden',
    },
    history: {
        title: 'Verlauf',
        description: 'Jeder Lauf, den du gestartet hast, egal auf welchem Weg.',
        loadMore: 'Weitere Läufe laden',
        loadFailedTitle: 'Läufe konnten nicht geladen werden',
        loadFailedBody: 'Deine Arbeit ist nicht betroffen.',
        review: 'Prüfen',
        rowMeta: ({ origin, machine, age }) => `${origin} · ${machine} · ${age}`,
    },
    rowMenu: {
        accessibility: 'Workflow-Optionen',
        runNow: 'Jetzt ausführen',
        share: 'Teilen…',
    },
    deleteTitle: 'Diesen Workflow löschen?',
    deleteFailedTitle: 'Workflow konnte nicht gelöscht werden',
    exportFailedTitle: 'Workflow konnte nicht exportiert werden',
    gate: {
        localTitle: 'Automatisierungen sind auf diesem Gerät ausgeschaltet',
        localBody: 'Schalte sie ein, um Workflows und ihre Auslöser auszuführen.',
        dependencyTitle: 'Workflows brauchen Automatisierungen',
        dependencyBody: 'Schalte Automatisierungen ein, um Workflows zu erstellen und auszuführen.',
        openSettings: 'Einstellungen öffnen',
    },
    runSettingsPage: {
        title: 'Lauf-Einstellungen',
        description: 'Wie viele Läufe jeder Rechner gleichzeitig annimmt und wie lange der Laufverlauf aufbewahrt wird.',
        saveFailed: 'Lauf-Einstellungen konnten nicht gespeichert werden. Deine Änderungen sind noch da.',
    },
};

const workflowsDestinationTranslations = { de } as const;

return { workflowsDestinationTranslations };
})();

const Domain_workflowTriggersTranslations = (() => {
type Count = Shared_workflowTriggersTranslations.Count;

type WorkflowTriggersCopy = Shared_workflowTriggersTranslations.WorkflowTriggersCopy;

const en = Shared_workflowTriggersTranslations.en;

const de: WorkflowTriggersCopy = {
    activity: {
        create: "Aus diesem Ereignis einen Auslöser erstellen",
        test: "Diesen Auslöser testen",
        matched: "Dieses Ereignis passt",
        noMatch: "Dieses Ereignis passt nicht",
        sourceMismatch: "Dieses Ereignis stammt aus einer anderen Quelle",
        tooOld: "Dieses Ereignis ist für die Beobachtung zu alt",
        invalid: "Richte das Ereignis vor dem Test ein",
    },
    pullRequest: {
        label: "Pull Request",
        description: "Dieser Trigger verknüpft den Pull Request mit dieser Sitzung.",
        empty: "Keine offenen Pull Requests",
        loadFailed: "Pull Requests konnten nicht geladen werden",
    },
    summary: {
        everyDayAt: ({ time }) => `Täglich um ${time}`,
        weekdaysAt: ({ time }) => `Werktags um ${time}`,
        weeklyAt: ({ day, time }) => `Jeden ${day} um ${time}`,
        everyMinutes: ({ count }) => (count === 1 ? 'Jede Minute' : `Alle ${count} Minuten`),
        everyHours: ({ count }) => (count === 1 ? 'Jede Stunde' : `Alle ${count} Stunden`),
        cron: ({ expression }) => `Nach Zeitplan · ${expression}`,
        schedule: 'Nach Zeitplan',
        event: ({ event }) => `Wenn ${event} eintritt`,
        manual: 'Manuell',
        more: ({ first, count }) => `${first} · ${count} weitere`,
    },
    kind: {
        pluginEvent: "Plugin-Ereignis",
        sessionStarts: 'Wenn die Sitzung startet',
        sessionArchived: 'Wenn die Sitzung archiviert wird',
        schedule: 'Nach Zeitplan',
        prComment: 'Wenn jemand einen Pull Request kommentiert',
        ciFailed: 'Wenn CI bei einem Pull Request fehlschlägt',
        turnEnds: 'Wenn ein Zug endet',
        needsYou: 'Wenn die Sitzung dich braucht',
        runEnds: 'Wenn der Lauf endet',
        runNeedsYou: 'Wenn der Lauf dich braucht',
    },
    row: {
        workflowDeleted: 'Workflow gelöscht',
        legacyCreated: 'In Happier 0.2 erstellt',
        legacyUnavailable: 'Alter Auslöser nicht verfügbar',
        sessionKeyRequired: 'Sitzungsschlüssel erforderlich',
        templateRecoveryRequired: 'Auslöser unter Kontosicherheit wiederherstellen',
        templateDecryptionFailed: 'Auslöser konnte nicht entschlüsselt werden',
        machines: ({ count }: Count) => `${count} Rechner`,
        nextRun: ({ time }: { time: string }) => `Nächster Lauf: ${time}`,
        nextMinutes: ({ count }: Count) => `in ${count} Min.`,
        nextHours: ({ count }: Count) => `in ${count} Std.`,
        nextDays: ({ count }: Count) => count === 1 ? 'morgen' : `in ${count} Tagen`,
        steps: ({ count }) => (count === 1 ? `${count} Schritt` : `${count} Schritte`),
        off: 'Aus',
        running: 'Läuft',
        ran: ({ age }) => `Lief ${age}`,
        lastOutcome: ({ state, age }) => `${state} ${age}`,
        turnOn: ({ name }) => `${name} einschalten`,
        turnOff: ({ name }) => `${name} ausschalten`,
    },
    section: {
        add: 'Auslöser hinzufügen',
        emptyTitle: 'Keine Auslöser',
        emptyBody: 'Füge einen hinzu, um jeden Zug zu prüfen, auf ein Ziel hinzuarbeiten oder auf den Pull Request zu reagieren.',
        loadFailed: 'Die Auslöser dieser Sitzung konnten nicht geladen werden.',
        accountLoadFailed: 'Deine Auslöser konnten nicht geladen werden.',
        title: 'Auslöser',
        countOn: ({ count }) => `${count} an`,
        info: 'Was in dieser Sitzung läuft, wenn etwas passiert. Diese bleiben bei dieser Sitzung und erscheinen nicht in deiner Bibliothek.',
        saveFailed: 'Dieser Auslöser konnte nicht gespeichert werden. Deine Änderungen sind noch da.',
    },    kindDescription: {
        pluginEvent: "Ausführen, wenn ein Plugin ein Ereignis beobachtet.",
        turnEnds: 'Nach einem Zug von dir oder einem Agenten, mit dem du arbeitest.',
        needsYou: 'Immer wenn diese Sitzung auf dich wartet, auch während ein Workflow oder Weitermachen sie steuert.',
        sessionArchived: 'Läuft einmal, wenn du diese Sitzung archivierst.',
        sessionStarts: 'Nur beim Erstellen einer Sitzung.',
        schedule: 'Setzt diese Sitzung nach Zeitplan fort.',
        prComment: 'Nur Personen mit Schreibzugriff. Der Kommentar wird als Zitat übergeben.',
        pullRequestUnavailable: 'Pull-Request-Auslöser können hier noch nicht hinzugefügt werden.',
    },
    then: {
        runsIn: 'Läuft in',
        runsInChoice: {
            newSession: 'Einer neuen Sitzung',
            session: 'Einer Sitzung…',
            backgroundRun: 'Einem Hintergrundlauf',
        },
        noSessionOnMachine: 'Noch keine Sitzung auf diesem Gerät',
        session: 'Sitzung',
        action: 'Aktion',
        label: 'Dann',
        sendPrompt: 'Prompt senden',
        doAction: 'Aktion ausführen',
        notifyMe: 'Benachrichtige mich',
        runWorkflow: 'Workflow ausführen',
        sendPromptDescription: 'Der Agent dieser Sitzung erhält diesen Prompt in dieser Sitzung. Er unterbricht nie deinen Zug.',
        promptLabel: 'Prompt',
        promptPlaceholder: 'Was soll der Agent tun?',
        message: 'Nachricht',
        title: 'Titel',
        sendTo: 'Senden an',
        sendToDefault: 'Deine Benachrichtigungseinstellungen',
        workflow: 'Workflow',
        choose: 'Auswählen…',
    },
    popover: {
        configureEvent: "Ereignis einrichten",
        editEvent: "Ereignis bearbeiten",
        saveAsWorkflow: 'Als Workflow speichern',
        saveAsWorkflowDescription: 'Öffnet diese Schritte als neuen Workflow zur Prüfung. Dieser Auslöser behält seine eigenen Schritte.',
        when: 'Wann',
        newTrigger: 'Neuer Auslöser',
        addTrigger: 'Auslöser hinzufügen',
        cancel: 'Abbrechen',
        done: 'Fertig',
        turnOff: 'Ausschalten',
        turnOn: 'Einschalten',
        deleteTrigger: 'Auslöser löschen',
        repeat: 'Wiederholen',
        everyDay: 'Täglich',
        weekdays: 'Werktags',
        weekly: 'Wöchentlich',
        day: 'Tag',
        at: 'Um',
        expression: 'Zeitplan',
        tryAgain: 'Erneut versuchen',
    },    editor: {
        runsOn: 'Läuft auf',
        runsOnDescription: 'Alle Auslöser dieses Workflows laufen hier.',
        runsOnAccountDescription: 'Wo dieser Auslöser läuft.',
        runsOnDiffers: ({ where }) => `Jetzt ausführen nutzt stattdessen ${where}.`,
        sameForAllTriggers: 'Für alle Auslöser gleich',
        roles: 'Rollen',
        retargetFailed: 'Workflow gespeichert · Auslöser nicht aktualisiert',
        editInWorkflows: 'Ändere diesen Auslöser in Workflows. Er läuft unverändert weiter.',
        title: 'Läuft automatisch',
        runsBy: 'Läuft von selbst, wenn eines davon passiert.',
        runsByOn: ({ where }) => `Läuft von selbst, wenn eines davon passiert, auf ${where}.`,
        savedWorkflow: 'Auslöser führen den gespeicherten Workflow aus.',
        saveToInclude: 'Auslöser führen den gespeicherten Workflow aus. Speichere, um deine Änderungen einzuschließen.',
        newRow: 'Neu · noch nicht hinzugefügt',
        partialSave: 'Workflow gespeichert · Auslöser nicht aktualisiert',
    },    column: {
        newTrigger: 'Neuer Auslöser',
        newTriggerSubtitle: 'Führt eigene Schritte nach Zeitplan aus',
    },
};

const legacyTranslations = { de: {
        editNotice: 'In Happier 0.2 erstellt. Beim Öffnen ändert sich nichts.',
        conversionBoundary: 'Nach dieser Änderung läuft sie nur auf Rechnern mit Happier 0.3 oder neuer.',
        reviewRequired: 'Bitte prüfen',
        reviewConversionNotice: 'Beim Speichern wird dieser Workflow ohne Ende-zu-Ende-Verschlüsselung gespeichert und seine aktivierten Auslöser werden fortgesetzt. Die Sitzung bleibt Ende-zu-Ende-verschlüsselt.',
        channelReplyRefusal: 'Diese Automation hat eine Kanal-Antwortbindung, die nicht übernommen werden kann. Sie wurde nicht umgewandelt; ihre Einstellungen und deine Änderungen bleiben erhalten.',
        notAvailable: 'Diese Automation ist nicht mehr verfügbar.',
    } };

const creationTranslations = { de: { savedWorkflowsUnavailable: 'Wechsle zum Server dieser Sitzung, um einen gespeicherten Workflow auszuwählen. Integrierte Workflows und eigene Schritte sind weiterhin verfügbar.' } };

const workflowTriggersTranslations = { de: { ...de, legacy: legacyTranslations.de, creation: creationTranslations.de } } as const;

return { legacyTranslations, creationTranslations, workflowTriggersTranslations };
})();

const Domain_workflowValueReferenceTranslations = (() => {
const workflowValueReferenceTranslations = { de: {
        checkoutRoot: 'Checkout-Stammordner',
        unavailableValue: 'Wert nicht verfügbar', sessionContext: ({ turns }: { turns: number }) => turns === 0 ? 'Sitzungskontext' : turns === 1 ? 'Letzte Sitzungsrunde' : `Letzte ${turns} Sitzungsrunden`,
        tokensUsed: 'Verwendete Tokens', goalTokenBudget: 'Tokenbudget des Ziels',
        trailingCount: ({ source, value }: { source: string; value: string }) => `Aufeinanderfolgende ${source} mit ${value}`,
        stopCondition: 'Stoppbedingung erfüllt', stopConditionArm: ({ arm }: { arm: number }) => `Stoppbedingung ${arm} erfüllt`,
        roundLimit: ({ rounds }: { rounds: number }) => `Rundenlimit erreicht · ${rounds} Runden`, decision: 'Entscheidung',
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

const de = translated(workflowValueReferenceTranslations.de, {
    testRun: {
        title: "Testlauf",
        savedNotice: "Führt die gespeicherte Version tatsächlich aus. Ungespeicherte Änderungen bleiben hier.",
        resultsNotice: "Ergebnisse der gespeicherten Version · letzter Durchlauf. Ungespeicherte Änderungen wurden nicht ausgeführt.",
        recordedDuration: ({ seconds }) => `Aufgezeichnete Laufzeit · ${seconds} s`,
        loading: "Testergebnisse werden geladen…",
    },
    runWhen: {
        title: "Ausführen bei",
        success: "Erfolg",
        failure: "Fehler",
        always: "Immer",
        ifSuccess: "Wenn es gelingt",
        ifFailure: "Wenn es fehlschlägt",
        regardless: "In jedem Fall",
        previousStep: "Bezogen auf den vorherigen Schritt",
    },
    title: 'Workflows',
    newWorkflow: 'Neuer Workflow',
    copyName: ({ name }: { name: string }) => `${name} Kopie`,
    importJson: 'JSON importieren',
    exportJson: 'JSON exportieren',
    openCollection: 'Workflows öffnen',
    destination: workflowsDestinationTranslations.de,
    plugins: workflowPluginTranslations.de,
    authoring: workflowAgentAuthoringTranslations.de,
    page: workflowEditorPageTranslations.de,
    actionTitles: workflowActionTranslations.de,
    builtins: workflowBuiltinTranslations.de,
    examples: workflowExamplesTranslations.de,
    triggers: workflowTriggersTranslations.de,
    start: workflowStartTranslations.de,
    list: workflowRunListTranslations.de,
    review: {
        publishedByAgent: 'Vom Agenten veröffentlicht',
        publishedByYou: 'Von dir veröffentlicht',
        editedByYou: 'Von dir bearbeitet',
        editedByPerson: 'Von einer anderen Person bearbeitet',
        previousAttempt: 'Vorheriger Versuch',
        useBody: "Spätere Schritte erhalten genau das, was du siehst. Kein Agent-Turn.",
        usePlanBody: "Übernimmt genau diesen Plan. Kein Agent-Turn.",
        reportBackTitle: ({ session }) => "Bericht an " + session,
        reportBackBody: ({ session }) => session + " erhält das Ergebnis dieses Laufs, wenn er endet.",
        planRunNotice: "Führt den vorgeschlagenen Ablauf genau wie gezeigt aus und übernimmt den Plan. Er wird nicht gespeichert.",
        editedPlanBody: 'Dieser Entwurf weicht vom Vorschlag ab. Zuerst den geprüften Plan zum Bearbeiten übernehmen? Deine Änderungen bleiben hier. Erst wenn du den Entwurf erneut startest, beginnt ein Lauf.',
        title: "Ergebnis prüfen",
        planTitle: "Plan prüfen",
        waitTitle: "Wartet auf dich",
        waitBody: "Dieser Zweig wartet, bis du fortfährst.",
        editsTitle: "Deine ungespeicherten Änderungen",
        editsBody: "Das gespeicherte Ergebnis bleibt unverändert, bis du es verwendest.",
        heldBody: "Wartet auf deine Prüfung · noch nicht an spätere Schritte übergeben",
        noValue: "Noch kein gültiges Ergebnis",
        enterValues: 'Fülle die Felder aus.',
        useResult: "Dieses Ergebnis verwenden",
        usePlan: "Diesen Plan verwenden",
        useValues: "Diese Werte verwenden",
        continue: "Fortfahren",
        invalid: "Korrigiere zuerst das markierte Feld.",
        newer: "Ein neueres Ergebnis ist verfügbar.",
        showNewer: "Neueres anzeigen",
        keepMyEdits: 'Meine Änderungen behalten',
        useNewer: 'Neueres verwenden',
        showFullResult: 'Vollständiges Ergebnis anzeigen',
        showFullPlan: 'Vollständigen Plan anzeigen',
        generationRequested: "Erzeugung angefordert",
        startsResume: "Startet, wenn du den Ablauf fortsetzt.",
        generateBody: "Der Agent schreibt ein neues Ergebnis in dieser Unterhaltung. Ist es gültig, läuft der Ablauf ohne weitere Rückfrage weiter.",
        acceptedPaused: "Auch nach der Übernahme bleibt der Ablauf pausiert.",
        editResult: "Ergebnis bearbeiten",
        generate: "Ergebnis erzeugen und fortfahren",
        discuss: "Besprechen",
        discussBody: "Antworte in der Unterhaltung dieses Schritts. Der Agent kann hier ein aktualisiertes Ergebnis veröffentlichen.",
        proposal: "Vorgeschlagener Ablauf",
        planStarted: "Ein Lauf aus diesem Plan wurde gestartet",
        earlierPlanStarted: "Ein Lauf wurde bereits aus einem früheren Vorschlag gestartet",
        openEarlierPlanRun: "Diesen Lauf öffnen",
        runNewProposal: "Den neuen Vorschlag ausführen",
        runPlan: "Als Ablauf ausführen",
        runPlanBody: "Öffnet die Laufprüfung für den vorgeschlagenen Ablauf. Beim Start wird auch dieser Plan übernommen.",
        editPlan: "Ablauf zuerst bearbeiten",
        editPlanBody: "Übernimmt diesen Plan und öffnet den vorgeschlagenen Ablauf als ungespeicherten Entwurf.",
        editPlanFallback: "Übernimmt diesen Plan und öffnet einen einstufigen Ablauf mit diesem Plan als Prompt.",
        waitingMachine: ({ machine }) => "Wartet auf " + machine,
    },

    tabs: {
        saved: 'Gespeichert',
        runs: 'Läufe',
        steps: 'Schritte',
        flow: 'Ablauf',
        map: 'Karte',
        activity: 'Aktivität',
    },
    tabsAccessibility: {
        savedRuns: 'Gespeicherte Workflows oder Läufe',
        stepsFlow: 'Schritte oder Ablauf',
        activityFlow: 'Aktivität oder Ablauf',
        runViews: "Laufansichten",
    },

    filters: {
        all: 'Alle',
        active: 'Aktiv',
        needsYou: 'Braucht dich',
        clear: 'Filter zurücksetzen',
    },

    empty: {
        savedTitle: 'Noch keine gespeicherten Workflows',
        savedBody: 'Beim Speichern bleibt eine wiederverwendbare Definition erhalten, die du ausführen oder planen kannst.',
        runsTitle: 'Es ist noch nichts gelaufen',
        runsBody: 'Läufe erscheinen hier, egal ob du den Workflow speicherst oder nicht.',
        filteredTitle: 'Keine Läufe passen zu diesem Filter',
        filteredBody: 'Setz den Filter zurück, um deine übrigen Läufe zu sehen.',
        missingTitle: 'Dieser Workflow ist nicht verfügbar',
        missingBody: 'Happier konnte den Workflow, auf den dieser Link zeigt, nicht öffnen. Deine anderen Workflows, Automationen und Läufe sind davon nicht betroffen.',
        missingDraftTitle: "Diese ungespeicherte Kopie ist verloren gegangen",
        missingDraftBody: "Beim Neuladen gehen ungespeicherte Kopien verloren. Öffne den ursprünglichen Workflow, um ihn erneut zu duplizieren.",
    },

    loadFailedTitle: 'Workflows konnten nicht geladen werden',
    loadFailedBody: 'Deine Arbeit ist davon nicht betroffen. Versuch es erneut, wenn du so weit bist.',
    retry: 'Erneut versuchen',
    contentUnavailable: 'Private Inhalte sind auf diesem Gerät nicht verfügbar.',
    readState: {
        historyTitle: 'Verlauf nicht lesbar',
        historyBody: 'Dieser Lauf wurde mit einer früheren Entwicklungsversion von Happier aufgezeichnet. Sein Verlauf kann nicht geöffnet werden. Starte einen neuen Lauf, um fortzufahren.',
        encryptionTitle: 'Verschlüsselung einrichten',
        encryptionBody: 'Dieser Inhalt ist Ende-zu-Ende-verschlüsselt. Richte die Verschlüsselung für dieses Konto ein, um ihn zu öffnen.',
        keysTitle: 'Warten auf Schlüssel',
        keysBody: 'Diesem Gerät fehlen noch die Verschlüsselungsschlüssel für diesen Lauf. Versuche es erneut, sobald sie verfügbar sind.',
        storageTitle: 'Laufspeicher nicht verfügbar',
        storageBody: 'Happier konnte nicht auf den Laufspeicher zugreifen. Prüfe deine Verbindung und versuche es erneut.',
        openSettings: 'Einstellungen öffnen',
    },
    contentReasons: {
        invalidHeader: 'Die gespeicherten Informationen dieses Workflows sind ungültig.',
        revisionMismatch: 'Dieser Workflow entspricht nicht seiner gespeicherten Revision.',
        missingBody: 'Die gespeicherte Definition dieses Workflows fehlt.',
        invalidBody: 'Die gespeicherte Definition dieses Workflows ist ungültig.',
        notFound: 'Dieser Workflow ist nicht mehr verfügbar.',
    },

    sessionEntry: {
        missingTitle: 'Diese Sitzung ist nicht mehr verfügbar',
        missingBody: 'Sie wurde möglicherweise gelöscht oder liegt auf einem anderen Home. Öffne Sitzungen, um sie zu finden.',
        inaccessibleTitle: 'Du kannst diese Sitzung nicht öffnen',
        inaccessibleBody: 'Happier konnte den Zugriff nicht bestätigen. Melde dich erneut an oder frage die Eigentümerin bzw. den Eigentümer, und öffne diese Seite dann neu.',
        failedTitle: 'Diese Sitzung konnte nicht geöffnet werden',
        failedBody: 'Happier versucht es weiter. Du kannst es jetzt erneut versuchen.',
        unsupportedTitle: 'Diese Sitzung kann keinen Workflow starten',
        unsupportedBody: 'Happier konnte den Agent und die Maschine nicht lesen, auf der sie läuft. Erstelle den Workflow stattdessen unter Workflows.',
    },

    editor: {
        namePlaceholder: 'Workflow-Name',
        agentRuntime: 'Agent-Laufzeit',
        firstPromptTitle: 'Was soll zuerst passieren?',
        firstPromptBody: 'Ein einzelner Prompt ist bereits ein Workflow. Füg Schritte hinzu, wenn du sie brauchst.',
        promptPlaceholder: 'Beschreib, was dieser Schritt tun soll',
        useWorkflowDefault: 'Workflow-Standard verwenden',
        defaultsTitle: 'Standards',
        produces: 'Liefert',
        whereTitle: 'Wo',
        add: 'Hinzufügen',
        addAccessibility: 'Einen Block zu diesem Workflow hinzufügen',
        addStep: 'Agent-Schritt',
        addParallel: 'Nebeneinander',
        addLoop: 'Wiederholen',
        addIf: 'Wenn',
        targetRequired: 'Wähle den Computer und den Projektordner für diesen Workflow.',
        loadingTitle: 'Workflow wird geöffnet …',
        accountChangedTitle: 'Du hast das Konto gewechselt',
        accountChangedBody: 'Dieser Workflow wurde vom vorherigen Konto geöffnet und kann nicht übernommen werden. Öffne ihn erneut über Workflows.',
        loadFailedTitle: 'Dieser Workflow lässt sich nicht öffnen',
        loadFailedBody: 'Der gespeicherte Workflow konnte gerade nicht gelesen werden.',
        timeoutTitle: 'Wartezeit auf Ergebnis (ms)',
        noDeadline: 'Keine Frist',
        timeoutExplain: 'Millisekunden, die auf das Ergebnis dieses Schritts gewartet wird, bevor er Aufmerksamkeit braucht. Leer lassen für keine Frist.',
        wholeNumberRequired: 'Gib eine ganze Zahl von mindestens 1 ein.',
        runNow: 'Jetzt ausführen',
        save: 'Workflow speichern',
        saveAutomation: 'Automation speichern',
        schedule: 'Planen',
        savedRevision: ({ revision }) => `Gespeichert · ${revision}`,
        moveUp: 'Nach oben',
        moveDown: 'Nach unten',
        moveIn: 'In die Gruppe darüber verschieben',
        moveOut: 'Aus dieser Gruppe herausnehmen',
        remove: 'Entfernen',
        undo: 'Rückgängig',
        redo: 'Wiederholen',
        historyRestoreRequiresSetup: 'Dieses Ereignis muss erneut eingerichtet werden. Seine gespeicherte private Konfiguration kann nach dem Löschen nicht wiederhergestellt werden.',
        history: { edited: 'Workflow bearbeiten', agent: 'Agentenänderung', description: 'Beschreibung bearbeiten', where: 'Ausführungsort ändern', target: 'Schrittausführung ändern', triggers: 'Trigger bearbeiten', example: 'Beispiel einfügen', document: 'Prompt bearbeiten', renameWorkflow: 'Workflow umbenennen', renameStep: 'Schritt umbenennen', renameLane: 'Spur umbenennen' },
        undoAction: ({ change }: { change: string }) => `Rückgängig: ${change}`,
        redoAction: ({ change }: { change: string }) => `Wiederholen: ${change}`,
        removedBlock: ({ block }) => `${block} entfernt`,
        rename: 'Umbenennen',
        stepOrdinal: ({ position }) => `${position}`,
        unnamedStep: ({ position }) => `Schritt ${position}`,
        unnamedParallel: 'Parallele Gruppe',
        unnamedLoop: 'Schleife',
        unnamedIf: 'Bedingung',
        branch: 'Zweig',
        addBranch: 'Spur hinzufügen',
        ifTrue: 'Dann',
        otherwise: 'Sonst',
        addOtherwise: 'Einen Sonst-Zweig hinzufügen',
        evaluator: 'Entscheiden, ob es weitergeht',
        loopBody: 'Diese Schritte wiederholen',
        continuation: 'Nach jeder Runde',
    },

    input: {
        label: 'Eingabe',
        result: 'Ergebnis',
        change: 'Ändern',
        none: 'Keine Eingabe',
        previousResult: ({ block }) => `Ergebnis von ${block}`,
        workflowInput: ({ name }) => `Workflow-Eingabe ${name}`,
        currentItem: 'Das aktuelle Element',
        iteration: 'Diese Runde',
        unavailable: 'Diese Quelle ist nicht mehr verfügbar',
        itemField: {
            value: 'Elementwert',
            index: 'Elementindex, ab 0',
            position: 'Elementposition, ab 1',
            count: 'Anzahl der Elemente',
        },
        iterationField: {
            index: 'Rundenindex, ab 0',
            position: 'Rundennummer, ab 1',
            count: 'Anzahl der Runden',
            stopReason: 'Grund für den Stopp',
        },
        valueKindGroup: 'Wertquelle',
        inputNameGroup: 'Workflow-Eingabe',
        producerGroup: 'Quellschritt',
        workspaceFieldGroup: 'Arbeitsbereich-Feld',
        itemFieldGroup: 'Elementfeld',
        iterationFieldGroup: 'Rundenfeld',
    },

    inputs: {
        title: 'Workflow-Eingaben',
        addInput: 'Eingabe hinzufügen',
        namePlaceholder: 'Bezeichnung',
        descriptionPlaceholder: 'Wofür ist das?',
        required: 'Erforderlich',
        optional: 'Nicht erforderlich',
        defaultValue: 'Standardwert',
        typeString: 'Freitext',
        typeNumber: 'Zahl',
        typeBoolean: 'Ja oder nein',
        typeJson: 'Strukturierte Daten',
        runSheetTitle: 'Diesen Workflow ausführen',
        runSheetBody: 'Gib die Werte an, die dieser Workflow verlangt, und führ ihn dann aus.',
        missingRequired: 'Dieser Wert ist erforderlich.',
        wrongType: ({ type }) => `Dieser Wert muss vom Typ ${type} sein.`,
    },

    finalOutput: {
        title: 'Endergebnis',
        none: 'Kein Endergebnis ausgewählt',
        change: 'Ändern',
        clear: 'Auswahl aufheben',
        fieldPath: 'Feldpfad',
        explain: 'Was dieser Workflow beim Abschluss zurückgibt.',
    },

    conversation: {
        title: 'Unterhaltung',
        sharedRun: 'Dieselbe Unterhaltung',
        branchesShareAndTakeTurns: 'Die Zweige teilen eine Unterhaltung und sind nacheinander an der Reihe.',
        fresh: 'Getrennte Unterhaltungen',
        fromStep: ({ block }) => `${block} fortsetzen`,
        existingSession: 'Eine bestehende Session',
        existingSessionById: ({ sessionId }) => `Session ${sessionId}`,
        noExistingSessions: 'Auf diesem Rechner kann hier keine Session fortgesetzt werden.',
        chooseExistingSession: 'Wähle eine Session zum Fortsetzen',
        continuingKeepsAgentAndFolder: 'Beim Fortsetzen bleiben Agent und Ordner dieser Unterhaltung erhalten. Ein anderer Agent oder Ordner braucht eine getrennte Unterhaltung.',
        waitingForConversation: ({ block }) => `Wartet darauf, dass ${block} in dieser Unterhaltung fertig wird.`,
        branchesUseSeparate: 'Zweige in einer parallelen Gruppe verwenden getrennte Unterhaltungen.',
    },

    workspace: {
        title: 'Arbeitsbereich',
        inherit: 'Arbeitsbereich des Workflows',
        projectCheckout: 'Projektordner',
        fromStep: ({ block }) => `Arbeitsbereich von ${block} fortsetzen`,
        newWorktreeOriginal: 'Neuer Worktree aus dem ursprünglichen Ordner',
        newWorktreeWorkflow: 'Neuer Worktree aus dem Arbeitsbereich des Workflows',
        newWorktreeStep: ({ block }) => `Neuer Worktree aus ${block}`,
        committedOnlyNote: 'Ein neuer Worktree enthält den committeten Stand des Quellordners. Gestagte, nicht committete und nicht verfolgte Änderungen bleiben in der Quelle.',
        reuseNote: 'Wird ein Arbeitsbereich fortgesetzt, sieht er seine nicht committeten Dateien genau so, wie sie sind.',
        sharedParallelNote: 'Zweige, die sich einen Arbeitsbereich teilen, können gleichzeitig hineinschreiben.',
        unavailable: ({ block }) => `Der Arbeitsbereich für ${block} ist nicht verfügbar.`,
        unavailableBody: 'Stell ihn wieder her, um diesen Lauf fortzusetzen, oder prüf einen neuen Lauf, der bereits erledigte Arbeit wiederholen kann.',
        unavailableRestoreBody: 'Stelle ihn wieder her, um diesen Lauf mit der bereits erledigten Arbeit fortzusetzen.',
        unavailableNewRunBody: 'Er kann nicht wiederhergestellt werden. Ein geprüfter neuer Lauf beginnt von vorn, und erledigte Arbeit kann sich wiederholen.',
        restore: 'Wiederherstellen',
        inspect: 'Ansehen',
    },

    condition: {
        onlyWhen: 'Nur ausführen, wenn',
        always: 'Immer',
        stopWhen: 'Stoppen, wenn',
        ifWhen: 'Ersten Zweig ausführen, wenn',
        addCondition: 'Bedingung hinzufügen',
        removeCondition: 'Bedingung entfernen',
        allOf: 'Alle davon',
        anyOf: 'Eines davon',
        not: 'Nicht',
        exists: 'hat einen Wert',
        operatorEq: 'ist',
        operatorNeq: 'ist nicht',
        operatorLt: 'ist kleiner als',
        operatorLte: 'ist höchstens',
        operatorGt: 'ist größer als',
        operatorGte: 'ist mindestens',
        notFirstRound: 'es nicht die erste Runde ist',
        trailingCountAtLeast: ({ source, value, count }) => `${source} ${count}-mal in Folge ${value} ist`,
        loopRanOutOfRounds: ({ loop }) => `${loop} keine Runden mehr hat`,
        loopEnded: ({ loop, outcome }) => `${loop} beendet ist: ${outcome}`,
        loopStoppedBecause: ({ loop, condition }) => `${loop} angehalten hat, weil ${condition}`,
        valuePlaceholder: 'Wert',
        literalPlaceholder: 'Wert eingeben',
        skippedReason: ({ block }) => `Übersprungen, weil die Bedingung von ${block} nicht zutraf.`,
    },

    loop: {
        modeTitle: 'Wiederholen',
        modeCount: 'Eine feste Anzahl von Malen',
        modeItems: 'Einmal pro Element',
        modeUntil: 'Bis ein Ergebnis Stopp sagt',
        modeEvaluate: 'Bis ein Agent Stopp sagt',
        count: 'Anzahl der Durchläufe',
        items: 'Liste',
        sequential: 'Elemente nacheinander',
        parallel: 'Elemente parallel',
        maxConcurrentItems: 'Maximal gleichzeitige Elemente',
        maxConcurrentBranches: 'Maximal gleichzeitige Zweige',
        noWorkflowLimit: 'Kein Limit im Workflow festgelegt',
        maxIterations: 'Maximale Anzahl Runden',
        limitReached: 'Limit erreicht',
        historyTitle: 'Frühere Bewertungen',
        historyNone: 'Keine',
        historyLatest: 'Letzte',
        historyAll: 'Alle',
        historyExplain: 'Das wählt die gespeicherten Entscheidungen und Rückmeldungen aus, nicht ganze Transkripte.',
        continuingConversation: 'Dieser Bewerter behält seine bisherige Unterhaltung und fügt jede neue Runde hinzu.',
        emptyListCompletes: 'Eine leere Liste endet ohne Runden.',
    },

    failurePolicy: {
        title: 'Wenn ein Schritt fehlschlägt',
        failStop: 'Diese Gruppe bei einem Fehler stoppen',
        failStopExplain: 'Diese Gruppe startet keine neue Arbeit mehr und bittet aktive Zweige zu stoppen, auch unabhängige. Fertige Ergebnisse und Änderungen bleiben erhalten. Das ist kein Rollback.',
        collectOutcomes: 'Unabhängige Arbeit zu Ende führen',
        collectOutcomesExplain: 'Fehlerfreie Zweige durchlaufen ihre gesamte Kette, und jedes Ergebnis wird gesammelt. Schritte nach einem Fehler innerhalb eines Zweigs laufen nicht.',
    },

    runState: {
        pending: 'Wartet auf den Start',
        queued: 'Wartet auf den Start',
        claimed: 'Startet',
        running: 'Läuft',
        waiting_for_review: 'Wartet auf deine Prüfung',
        succeeded: 'Abgeschlossen',
        failed: 'Fehlgeschlagen',
        cancel_requested: 'Wird gestoppt',
        cancelled: 'Gestoppt',
        pause_requested: 'Wird pausiert',
        paused: 'Pausiert',
        interrupted: 'Unterbrochen',
        expired: 'Vor dem Start abgelaufen',
        dispatch_failed: 'Start nicht möglich',
        skipped: 'Übersprungen',
        missed: 'Verpasst',
        outcome_uncertain: 'Ergebnis unklar',
        completed: 'Abgeschlossen',
        completed_with_failures: 'Abgeschlossen, mit Fehlern',
    },

    invocationState: {
        pending: 'Wartet',
        waiting_for_capacity: 'Wartet auf Kapazität',
        admitting: 'Startet',
        running: 'Läuft',
        waiting_for_approval: 'Wartet auf Freigabe',
        waiting_for_review: 'Wartet auf deine Prüfung',
        needs_attention: 'Braucht dich',
        completed: 'Abgeschlossen',
        failed: 'Fehlgeschlagen',
        skipped: 'Übersprungen',
        cancel_requested: 'Wird gestoppt',
        cancelled: 'Gestoppt',
        outcome_uncertain: 'Ergebnis unklar',
        superseded: 'Durch einen späteren Versuch ersetzt',
    },

    run: {
        title: 'Lauf',
        frozenVersion: "Dieser Lauf nutzt die Version, mit der er gestartet wurde. Änderungen gelten nur für zukünftige Läufe.",
        selectOccurrence: 'Schritt auswählen',
        openReview: 'Ergebnis prüfen',
        open: 'Lauf öffnen',
        openExact: ({ title }) => `Lauf ${title} öffnen`,
        openExecution: 'Hintergrundlauf öffnen',
        loadMore: 'Ältere Schritte laden',
        origin: {
            direct: 'Direkt gestartet',
            automation: 'Geplant',
            fromSession: 'Aus einer Session',
        },
        needsYou: 'Braucht dich',
        needsYouLoadedCount: 'geladen',
        review: 'Prüfen',
        stop: 'Stoppen',
        stopAgain: 'Erneut stoppen',
        stopping: 'Wird gestoppt…',
        stopRequested: ({ machine }) => `Stopp angefordert. Warten auf die Bestätigung von ${machine}.`,
        evidenceStale: 'Zeigt die zuletzt bekannten Details. Happier konnte nicht bestätigen, dass sie aktuell sind.',
        pauseAtBoundary: 'An der nächsten Grenze pausieren',
        pausePending: 'Beendet die laufende Arbeit und pausiert dann.',
        paused: 'Nach der letzten abgeschlossenen Grenze pausiert.',
        resume: 'Fortsetzen',
        runAgain: 'Workflow erneut ausführen',
        retryStep: 'Schritt wiederholen',
        attempt: ({ attempt }) => `Versuch ${attempt}`,
        untitled: 'Workflow-Lauf',
        openResult: 'Ergebnis öffnen',
        inspectSteps: 'Schritte ansehen',
        seeFailures: 'Fehler ansehen',
        saveAsWorkflow: 'Als Workflow speichern',
        saveAsNewWorkflow: 'Als neuen Workflow speichern',
        showCurrentWork: 'Aktuelle Arbeit anzeigen',
        editWorkflow: 'Workflow bearbeiten',
        openWorkflow: 'Workflow öffnen',
        deleteHistory: 'Laufverlauf löschen',
        deleteHistoryConfirm: 'Eingaben und Ergebnisse werden entfernt. Arbeitsbereiche, Unterhaltungen, gespeicherte Workflows und Automationen bleiben erhalten.',
        technicalDetails: 'Technische Details',
        technical: {
            runId: 'Run-ID',
            invocationId: 'Schritt-ID',
            machine: 'Computer',
            machineId: 'Computer-ID',
            revision: 'Revision',
        },
        usageUnavailable: 'Verbrauch nicht verfügbar',
        startedAt: ({ time }: { time: string }) => `Gestartet ${time}`,
        timeRange: ({ start, end }) => `${start} – ${end}`,
        openConversation: 'Unterhaltung öffnen',
        openChildRun: 'Seinen Lauf öffnen',
        openStepDetails: 'Details öffnen',
        outcomeLine: ({ word, sentence }: { word: string; sentence: string }) => `${word} — ${sentence}`,
        attentionReviewRow: ({ step }: { step: string }) => `${step} wartet auf deine Prüfung`,
        attentionWaitRow: ({ step }: { step: string }) => `${step} wartet auf dich`,
        attentionReviewSentence: ({ step }: { step: string }) => `${step} wartet auf deine Prüfung.`,
        attentionWaitSentence: ({ step }: { step: string }) => `${step} wartet auf dich.`,
        reviewing: 'Wird geprüft',
        notStarted: 'Nicht gestartet',
        machineUnavailable: ({ machine }) => `Dieser Lauf hat den Kontakt zu ${machine} verloren.`,
        machineUnavailableBody: 'Möglichkeiten zum Fortsetzen erscheinen, sobald der aktuelle Stand bekannt ist.',
        completedCount: ({ count }) => `${count} ${count === 1 ? 'Schritt' : 'Schritte'} abgeschlossen.`,
        completedWithFailures: ({ completed, failed }) =>
            `Abgeschlossen, mit Fehlern. ${completed} abgeschlossen; ${failed} ${failed === 1 ? 'konnte' : 'konnten'} nicht beendet werden.`,
        approvalWanted: ({ block }) => `${block} möchte einen Befehl ausführen.`,
        approvalWantedBody: 'Prüf ihn, um fortzufahren.',
        capacityOccupied: 'Alle im Workflow festgelegten Plätze sind belegt.',
        openSourceSession: 'Die Session öffnen, aus der er stammt',
        observedActivity: 'Beobachtete Aktivität',
        observedActivityBody: 'Happier sieht die Phasen und Agents dieses Agents, aber er wurde nicht als verwalteter Workflow gestartet und lässt sich deshalb nicht bearbeiten, speichern oder erneut ausführen.',
    },

    recovery: {
        title: 'Wiederherstellung prüfen',
        reattach: 'Wieder verbinden',
        reattachExplain: 'Beobachtet die Arbeit, die bereits läuft. Es wird nichts Neues gestartet.',
        resumeSameConversation: 'Fortsetzen',
        resumeSameConversationExplain: ({ block }) => `${block} kann in derselben Unterhaltung weitermachen.`,
        freshAgent: 'Mit einem frischen Agent fortfahren',
        freshAgentExplain: 'Diese Unterhaltung kann nicht fortgesetzt werden. Der Arbeitsbereich steht für einen frischen Agent bereit.',
        uncertainEffects: ({ block }) => `${block} hat gestoppt, bevor es berichtet hat. Möglicherweise wurde der Arbeitsbereich bereits verändert.`,
        acknowledgeEffects: 'Mir ist klar, dass frühere Änderungen bereits passiert sein können',
        waitingForStop: 'Warten auf Stopp oder Bestätigung',
        remainingNotStarted: ({ count }) => `${count} ${count === 1 ? 'weiterer Schritt wurde' : 'weitere Schritte wurden'} noch nicht gestartet`,
        startReviewedRun: 'Einen geprüften neuen Lauf starten',
        editContinuation: 'Fortsetzung prüfen oder bearbeiten',
        continuationPlaceholder: 'Ergänze, was dieser Schritt anders machen soll',
        useReplacementInput: 'Eingabe des Schritts ersetzen',
        repeatedEffectWarning: 'Bereits erledigte Arbeit kann sich wiederholen. Der ursprüngliche Lauf behält seinen Verlauf.',
    },

    unavailable: {
        title: 'Workflows sind nicht verfügbar',
        body: 'Workflows sind auf diesem Server nicht verfügbar, deshalb lässt sich hier kein Workflow anlegen oder ausführen.',
        conversion: 'Diese Änderungen brauchen das Workflow-Format, und Workflows sind auf diesem Server nicht verfügbar. Beschränk diese Automatisierung auf einen Prompt oder versuch es erneut, sobald Workflows verfügbar sind.',
        savedAutomation: 'Diese Automatisierung läuft als Workflow. Ihre gespeicherten Schritte bleiben unverändert; Name, Beschreibung und Trigger kannst du weiterhin bearbeiten.',
    },
    conversion: {
        title: 'Diese Änderungen brauchen das Workflow-Format',
        automationTarget: 'Workflow',
        body: 'Diese Automatisierung führt weiterhin einen Prompt auf ihrem gespeicherten Ziel aus. Beim Umwandeln bleiben deine Änderungen erhalten und künftige Ausführungen laufen als Workflow auf genau einer Maschine. Bereits gelaufene Ausführungen bleiben unverändert.',
        action: 'In Workflow umwandeln',
        machineRequired: 'Wähl die Maschine und den Projektordner für künftige Ausführungen.',
    },
    save: {
        conflictTitle: 'Es wurde eine neuere Version gespeichert',
        conflictBody: 'Deine Änderungen sind weiterhin da.',
        compare: 'Vergleichen',
        saveAsCopy: 'Als Kopie speichern',
        failedTitle: 'Speichern nicht möglich',
        failedBody: 'Deine lokale Arbeit ist weiterhin da.',
        deleteTitle: 'Diesen Workflow löschen?',
        deleteBody: 'Bestehende Automationen und Läufe sind nicht betroffen und funktionieren weiter.',
        unsupportedAttachment: 'Häng Medien über eine dauerhafte Referenz an, bevor du diesen Workflow speicherst.',
        nameRequired: 'Gib diesem Workflow einen Namen, bevor du ihn speicherst.',
        runsCurrentDraft: 'Dieser Lauf verwendet den Workflow so, wie er auf dem Bildschirm steht. Er wird dabei nicht gespeichert.',
    },

    interchange: {
        importTitle: 'Einen Workflow importieren',
        importBody: 'Beim Import öffnet sich ein ungespeicherter Entwurf zum Prüfen. Es wird nichts ausgeführt oder geplant.',
        importIssuesTitle: 'Diesen Workflow prüfen',
        importIssuesBody: 'Einige Einstellungen brauchen deine Aufmerksamkeit, bevor dieser Workflow verwendet werden kann.',
        openRepairDraft: 'Entwurf zum Reparieren öffnen',
        importFailedTitle: 'Diese Datei konnte nicht gelesen werden',
        importFailedInvalidJson: 'Diese Datei ist kein gültiges JSON.',
        importFailedUnsupportedVersion: 'Diese Datei verwendet eine Workflow-Version, die diese App nicht unterstützt.',
        importFailedInvalidDocument: 'Diese Datei ist kein Happier-Workflow.',
        exportPrivacyNote: 'Die exportierte Datei enthält Prompts und Einstellungen. Sie enthält niemals Zugangsdaten oder Laufergebnisse.',
    },

    issue: {
        invalid_version: 'Dieser Workflow verwendet eine nicht unterstützte Version.',
        unknown_field: 'Dieser Block hat eine Einstellung, die dieser Workflow nicht unterstützt.',
        invalid_id: 'Dieser Block braucht eine gültige Kennung.',
        duplicate_id: 'Zwei Blöcke haben dieselbe Kennung.',
        missing_reference: 'Diese Eingabe verweist auf einen Block, den es nicht mehr gibt.',
        invalid_reference_scope: 'Diese Eingabe verweist auf einen Block, der nicht vorher fertig wird.',
        invalid_input: 'Dieser Wert ist nicht gültig.',
        missing_required_input: 'Ein erforderlicher Wert fehlt.',
        invalid_result_contract: 'Die Ergebniseinstellungen dieses Schritts sind nicht gültig.',
        invalid_condition: 'Diese Bedingung lässt sich nicht vergleichen.',
        invalid_repetition: 'Diese Schleife kann sich mit dieser Konfiguration nicht wiederholen.',
        invalid_max_concurrent: 'Maximale Gleichzeitigkeit braucht eine ganze Zahl von mindestens 1 und gilt nur für parallele Arbeit.',
        unsupported_persisted_attachment: 'Angehängte Medien brauchen vor dem Speichern eine dauerhafte Referenz.',
        conversation_workspace_mismatch: 'Diese Unterhaltung und dieser Arbeitsbereich können nicht gemeinsam fortgesetzt werden.',
        target_unavailable: 'Wähl einen Agent für diesen Workflow, bevor du ihn ausführst.',
        emptyPrompt: 'Schreib, was dieser Schritt tun soll.',
        emptyWaitPrompt: 'Schreib, was du hier prüfen oder entscheiden sollst.',
        fieldMissing: ({ field }) => `${field} ist erforderlich.`,
        fieldInvalid: ({ field }) => `${field} braucht einen gültigen Wert.`,
    },

    problem: {
        title: 'Das hat nicht geklappt',
        waitingTitle: 'Noch nicht möglich',
        subtreeDenied: 'Ein Agent kann Arbeit nur in seiner eigenen Sitzung oder in Sitzungen starten, die er leitet.',
        roleTargetUnavailable: 'Diese Rolle kann hier nicht verwendet werden.',
        roleRunsAsMismatch: 'Die Ausführungsart dieser Rolle passt nicht zu diesem Schritt. Wähle eine andere Rolle oder ändere, wie der Schritt ausgeführt wird.',
        policyDeniedField: 'Deine Agenteneinstellungen erlauben die angeforderte Einstellung nicht für Arbeit, die ein Agent startet.',
        permissionExceedsCeiling: 'Das erfordert mehr Berechtigungen, als der Agent hat, der es gestartet hat.',
        workDepthExceeded: 'Das würde dein Delegationslimit überschreiten. Erledige es in dieser Sitzung oder erhöhe das Limit unter Einstellungen › Delegation.',
        definitionExceedsAuthority: 'Der Agent kann keinen Workflow speichern, der mehr tun könnte, als der Agent selbst starten darf.',
        sourceUnavailable: 'Dieser Workflow ist nicht verfügbar, deshalb können seine Trigger nicht ausgeführt werden.',
        legacyConversionUnsupported: 'Diese Automation kann hier noch nicht geändert werden. Sie läuft unverändert weiter.',
        nativeGoalOwner: 'Der Agent arbeitet in dieser Sitzung bereits selbstständig weiter an Zielen.',
        sessionAlreadyStarted: 'Diese Sitzung hat bereits begonnen. Trigger für den Sitzungsstart können nur beim Erstellen einer Sitzung hinzugefügt werden.',
        generic: 'Happier konnte diese Workflow-Anfrage nicht abschließen. Deine Arbeit ist davon nicht betroffen.',
        needsRepair: 'Dieser Workflow hat Einstellungen, die vor dem Ausführen korrigiert werden müssen.',
        targetUnavailable: 'Die Maschine oder der Agent, die dieser Workflow braucht, ist gerade nicht verfügbar.',
        notFound: 'Diesen Lauf gibt es nicht mehr.',
        accessDenied: 'Du hast keinen Zugriff auf diesen Lauf.',
        conflict: 'Das wurde woanders geändert. Aktualisiere, um die aktuelle Version zu sehen; deine lokale Arbeit bleibt erhalten.',
        inputTooLarge: 'Diese Eingabe ist zu groß zum Senden. Es wurde nichts geändert.',
        unresolvedOutcome: 'Happier kann noch nicht bestätigen, dass die vorherige Arbeit gestoppt ist, deshalb kann sie nicht ersetzt werden.',
        interactionCapacity: 'In dieser Unterhaltung wartet gerade zu viel, um noch mehr anzunehmen.',
        conversationUnavailable: 'Diese Unterhaltung kann nicht fortgesetzt werden.',
        workspaceRestore: 'Der Arbeitsbereich konnte nicht wiederhergestellt werden. Es wurde nichts geändert.',
        waitSelfDependency: 'Damit würde der Workflow auf die Unterhaltung warten, die ihn gestartet hat.',
        updateRequired: 'Die Maschine, die das ausführt, braucht ein neueres Happier, bevor sie diesen Schritt annehmen kann.',
        ineligible: 'Dieser Lauf ist weitergelaufen, deshalb ist das nicht mehr möglich.',
        custodyPending: 'Happier wartet noch auf die Bestätigung der Maschine.',
        runFinished: 'Dieser Lauf ist beendet.',
        checkpointUnavailable: 'Es gibt keinen gespeicherten Punkt zum Fortsetzen.',
        recoveryEvidenceRequired: 'Öffne diesen Lauf, um seine Wiederherstellungsoptionen zu sehen.',
        executionNotStarted: 'Es wurde noch kein Schritt gestartet.',
        custodySettled: 'Dieser Lauf ist bereits abgeschlossen.',
        unavailableHere: 'Das ist gerade nicht verfügbar.',
    },

    a11y: {
        blockList: 'Workflow-Blöcke',
        stepContext: ({ block, position, total }) => `${block}, Schritt ${position} von ${total}`,
        groupContext: ({ group, block }) => `${block}, innerhalb von ${group}`,
        inherited: 'verwendet die Workflow-Einstellung',
        overridden: 'für diesen Schritt festgelegt',
        inserted: ({ block, position, total }) =>
            `${block} an Position ${position} von ${total} hinzugefügt`,
        removed: ({ block, total }) =>
            `${block} entfernt. ${total} ${total === 1 ? 'Block bleibt' : 'Blöcke bleiben'}`,
        reordered: ({ block, position, total }) =>
            `${block} auf Position ${position} von ${total} verschoben`,
        validation: ({ reason }) => reason,
        validationInBlock: ({ block, reason }) => `${block}: ${reason}`,
        needsYou: ({ count }) =>
            `${count} ${count === 1 ? 'Schritt braucht' : 'Schritte brauchen'} dich`,
        needsYouLoaded: 'geladen',
        terminal: ({ state }) => state,
        terminalWithAttention: ({ state, count }) =>
            `${state}. ${count} ${count === 1 ? 'Schritt braucht' : 'Schritte brauchen'} dich`,
        selectedRowUpdated: ({ block }) => `${block} aktualisiert`,
        progress: ({ count }) =>
            `${count} ${count === 1 ? 'Schritt' : 'Schritte'} aktualisiert`,
        progressLoaded: ({ count }) =>
            `${count} ${count === 1 ? 'Schritt' : 'Schritte'} bisher aktualisiert`,
        progressWithAttention: ({ count, attention }) =>
            `${count} ${count === 1 ? 'Schritt' : 'Schritte'} aktualisiert; ${attention} ${attention === 1 ? 'braucht' : 'brauchen'} dich`,
        flowNode: ({ node, state }) => `${node}, ${state}`,
        editStep: 'Schritt bearbeiten',
        editBlock: 'Block bearbeiten',
        commandRefused: ({ reason }) => `Noch nicht möglich. ${reason}`,
    },
});

const workflowTranslations = { de } as const;

return { workflowTranslations };
})();

const Domain_workspaceBarTranslations = (() => {
type WorkspaceBarTranslation = Shared_workspaceBarTranslations.WorkspaceBarTranslation;

const en = Shared_workspaceBarTranslations.en;

const workspaceBarTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', WorkspaceBarTranslation>>, "de"> = { de: { workspaceBar: { tabsLabel: 'Offene Tabs', tabMenuLabel: 'Tab-Optionen', pinTab: 'Tab anheften', unpinTab: 'Tab lösen', splitRight: 'Rechts teilen', splitDown: 'Unten teilen', maximizePane: 'Bereich maximieren', restorePane: 'Bereich wiederherstellen', closeTab: 'Tab schließen', closeOtherTabs: 'Andere Tabs schließen', closeTabsToRight: 'Tabs rechts schließen', moreTabs: ({ count }) => (count === 1 ? '1 weiterer Tab' : `${count} weitere Tabs`), searchTabs: 'Tabs durchsuchen', splitPane: 'Aktiven Bereich teilen', openInNewTab: 'In neuem Tab öffnen', openToRight: 'Rechts öffnen', openBelow: 'Unten öffnen', newTab: 'Neuer Tab' } } };

return { workspaceBarTranslations };
})();

const Domain_workspaceSyncDiagnosticTranslations = (() => {
type WorkspaceSyncDiagnosticTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncDiagnosticTranslation;

type WorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslation;

type WorkspaceSyncLocale = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncLocale;

type WorkspaceSyncTranslationCore = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslationCore;

type WorkspaceSyncReviewBase = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncReviewBase;

const completeWorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.completeWorkspaceSyncTranslation;

const workspaceSyncDiagnosticTranslations = { de: {
        diagnostics: { title: 'Diagnose', relationshipId: 'Beziehungs-ID', controllerMachineId: 'ID des steuernden Computers', alphaMachineId: 'ID des Quellcomputers', betaMachineId: 'ID des Zielcomputers', alphaRoot: 'Aktueller Quellordner', betaRoot: 'Aktueller Zielordner', engineMode: 'Engine-Modus', engineState: 'Engine-Status', errorCode: 'Fehlercode' },
        error: { updateRequired: 'Aktualisiere Happier auf dem Quellcomputer, bevor du diese Workspace-Übergabe erneut versuchst. Andere Sitzungs- und Computeraktionen sind weiterhin verfügbar.' },
        resolve: { title: 'Workspace-Konflikt lösen?', body: ({ path, side }) => `Version „${side}“ des Ordners ${path} behalten? Der andere Ordner und alle Inhalte, die nur dort vorhanden sind, werden nach der Prüfung seines aktuellen Zustands entfernt.`, unverifiedFile: 'Eine Version ohne aktuellen Datei-Fingerabdruck kann nicht sicher entfernt werden. Aktualisiere den Konflikt und versuch es erneut.' },
    } } as const satisfies Pick<Record<string, WorkspaceSyncDiagnosticTranslation>, "de">;

const workspaceSyncSetAttentionTranslations = { de: { attention: { conflictedLinks: ({ count }) => `${count} ${count === 1 ? 'Verbindung hat' : 'Verbindungen haben'} Konflikte`, unavailableLinks: ({ count }) => `${count} ${count === 1 ? 'Verbindung benötigt' : 'Verbindungen benötigen'} eine Statusprüfung` } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'attention'>>, "de">;

const workspaceSyncAddMachineTranslations = { de: { availableOn: 'Verfügbar auf', addMachine: { replica: 'Replikat', exactReplica: 'Exaktes Replikat', editableCopy: 'Bearbeitbare Kopie', editableCopyHint: 'Änderungen auf verknüpften Computern können für Agents auf den anderen sichtbar werden. Unterschiedliche Versionen müssen geprüft werden. Verwende separate Worktrees, wenn du isoliert arbeiten möchtest.' } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'availableOn' | 'addMachine'>>, "de">;

const workspaceSyncReviewOutcomeTranslations = { de: { keepBoth: 'Beide Versionen behalten', preserveAt: ({ path }) => `Weitere Version unter ${path} behalten`, notReviewed: 'Nicht geprüft; hier wird nichts geändert', confirmScope: 'Nur die aufgeführten geprüften Arbeitsbereiche werden geändert. Nicht verfügbare Arbeitsbereiche bleiben unverändert.', preserved: 'Erhalten', alreadyPresent: 'Bereits vorhanden', notStarted: 'Nicht begonnen', askAgent: 'Agent fragen', askAgentPrompt: ({ path, versions }) => `Hilf mir, die Konfliktversionen von ${path} in diesen verknüpften Arbeitsbereichen zu prüfen:\n${versions}\nPrüfe die aktuellen Dateien und schlage eine sichere Lösung vor. Ändere oder löse den Konflikt nicht ohne meine Zustimmung.` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'keepBoth' | 'preserveAt' | 'notReviewed' | 'confirmScope' | 'preserved' | 'alreadyPresent' | 'notStarted' | 'askAgent' | 'askAgentPrompt'>>, "de">;

const workspaceSyncCoverageIncompleteTranslations = { de: 'Einige Verbindungen oder Endpunkte wurden nicht geprüft. Geladene Konflikte bleiben sichtbar; nur ausdrücklich geprüfte, verfügbare Versionen können gelöst werden.' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['coverageIncomplete']>, "de">;

const workspaceSyncReviewLifecycleTranslations = { de: { requestingApproval: 'Genehmigung wird angefordert…', applying: 'Geprüfte Änderungen werden angewendet…', propagationExpected: ({ names }) => `Voraussichtlich weitergegeben an ${names}`, propagationUnverified: ({ names }) => `Weitergabe an ${names} kann noch nicht bestätigt werden` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'requestingApproval' | 'applying' | 'propagationExpected' | 'propagationUnverified'>>, "de">;

const workspaceSyncLocalOnlyTranslations = { de: 'Dieser alternative Ort bleibt auf seinen Arbeitsbereich beschränkt' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['localOnly']>, "de">;

const workspaceSyncKeepAlternativesTranslations = { de: 'Alternativen behalten' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['keepAlternatives']>, "de">;

const workspaceSyncReviewDecisionTranslations = { de: { chooseTargets: 'Zu ersetzende Arbeitsbereiche auswählen', notSelected: 'Für diese Lösung nicht ausgewählt', inspectCurrentVersions: 'Aktuelle Versionen prüfen' } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'chooseTargets' | 'notSelected' | 'inspectCurrentVersions'>>, "de">;

const workspaceSyncReviewTranslations: Pick<Record<WorkspaceSyncLocale, WorkspaceSyncReviewBase>, "de"> = { de: {
        executable: 'Ausführbar', regular: 'Nicht ausführbar', applied: 'Angewendet', appliedPaused: 'Angewendet; Synchronisierung pausiert', changed: 'Vor dem Anwenden geändert', offline: 'Offline; nicht angewendet', cancelled: 'Abgebrochen', unknown: 'Ergebnis unbekannt; diesen Endpunkt prüfen', failed: 'Fehlgeschlagen; nicht angewendet', recoveryNeeded: 'Wiederherstellung an diesem Ort nötig', inspectionUnavailable: 'Aktuelle Versionen konnten nicht geprüft werden. Aktualisiere, sobald der steuernde Computer erreichbar ist.', coverageIncomplete: 'Einige Verbindungen oder Endpunkte wurden nicht geprüft. Geladene Konflikte bleiben sichtbar; eine Lösung ist noch nicht möglich.', versions: 'Versionen', comparison: 'Ausgewählte Versionen vergleichen', linkDecisions: 'Auswahl je Verbindung', result: 'Ergebnis', confirmTitle: 'Diese Version verwenden?', confirmBody: ({ path, source, count }) => `Version von ${source} für ${path} in ${count} weiteren Arbeitsbereichen verwenden? Happier prüft alle Versionen vor der Änderung.`, useVersion: 'Version verwenden', useNamedVersion: ({ name }) => `${name} verwenden`, compareNamedVersion: ({ name }) => `${name} vergleichen`, linkCount: ({ count }) => `${count} Verbindungen melden diesen Pfad`, moreOnLink: ({ name }) => `Weitere Einträge von ${name} laden`,
    } };

const workspaceSyncReviewSelectionTranslations = { de: { selectionIncluded: 'Von dieser Verbindung eingeschlossen', selectionExcluded: 'Von dieser Verbindung ausgeschlossen', selectionUnknown: 'Auswahl unbekannt', reasonRepositoryMetadata: 'Repository-Metadaten', reasonSubmodule: 'Git-Submodul', reasonConfiguredRule: 'Konfigurierte Regel', reasonGitIgnore: 'Git-Ignore-Regel', reasonEndpointUnavailable: 'Endpunkt nicht erreichbar', reasonSelectionUnavailable: 'Auswahlprüfung nicht verfügbar', configuredInclude: ({ pattern }) => `Einschlussmuster: ${pattern}`, configuredExclude: ({ pattern }) => `Ausschlussmuster: ${pattern}`, completedLinks: ({ count }) => `${count} Verbindungen vor der Blockierung abgeschlossen` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'selectionIncluded' | 'selectionExcluded' | 'selectionUnknown' | 'reasonRepositoryMetadata' | 'reasonSubmodule' | 'reasonConfiguredRule' | 'reasonGitIgnore' | 'reasonEndpointUnavailable' | 'reasonSelectionUnavailable' | 'configuredInclude' | 'configuredExclude' | 'completedLinks'>>, "de">;

const de = completeWorkspaceSyncTranslation({
    diagnostic: workspaceSyncDiagnosticTranslations["de"],
    review: workspaceSyncReviewTranslations["de"],
    selection: workspaceSyncReviewSelectionTranslations["de"],
    outcome: workspaceSyncReviewOutcomeTranslations["de"],
    lifecycle: workspaceSyncReviewLifecycleTranslations["de"],
    decision: workspaceSyncReviewDecisionTranslations["de"],
    coverage: workspaceSyncCoverageIncompleteTranslations["de"],
    localOnly: workspaceSyncLocalOnlyTranslations["de"],
    alternatives: workspaceSyncKeepAlternativesTranslations["de"],
    addMachine: workspaceSyncAddMachineTranslations["de"],
    attention: workspaceSyncSetAttentionTranslations["de"],
}, {
    title: 'Arbeitsbereich synchronisieren',
    footer: 'Der Status stammt von dem Computer, der diese Verbindung verwaltet. Änderungen erscheinen erst, nachdem dieser Computer sie bestätigt hat.',
    legacyRecovery: {
        title: 'Daten der eingestellten Arbeitsbereichssynchronisierung',
        footer: 'Happier prüft diese eingestellten Daten nur und verschiebt sie in Quarantäne. Die App löscht sie niemals.',
        checking: 'Computer werden geprüft…',
        inspectFailed: 'Einige Computer konnten nicht geprüft werden. Bereits gefundene Quarantäneordner bleiben sichtbar; versuche es erneut, sobald die Computer erreichbar sind.',
        outdatedTitle: ({ machine }) => `${machine} verwendet eine ältere Happier-Version`,
        outdatedBody: 'Diese Version kann nicht nach eingestellten Synchronisierungsdaten suchen. Aktualisiere Happier auf diesem Computer und prüfe hier erneut.',
        explanation: 'Dieser Computer enthält Daten der eingestellten Arbeitsbereichsreplikation. Happier hat die erkannten Daten in eine private Quarantäne verschoben und die Synchronisierung deaktiviert, damit die alte Komponente nicht ausgeführt wird.',
        quarantinePath: 'Quarantäneordner',
        openFolder: 'Ordner öffnen',
        offlineTitle: 'Entfernen, während Happier offline ist',
        offlineSteps: ({ path }) => `1. Beende alle Happier-Hintergrunddienste, die diese Daten verwenden können.\n2. Entferne mit deinem Betriebssystem genau diesen Ordner: ${path}\n3. Starte die Hintergrunddienste neu und prüfe hier erneut.`,
        unknown: ({ path, reason }) => `Happier konnte den alten Zustand unter ${path} nicht sicher einordnen (${reason}). Die Synchronisierung bleibt deaktiviert. Prüfe diesen Pfad manuell und lösche ihn nicht in der App.`,
        reinspect: 'Erneut prüfen',
    },
    none: 'Keine Synchronisierungsverbindung',
    conflictsTitle: 'Arbeitsbereichskonflikte',
    openConflicts: ({ count }) => `Arbeitsbereichssynchronisierung auf ${count} Verbindungen prüfen`,
    noConflicts: 'Keine Konflikte',
    previewUnavailable: 'Der steuernde Computer konnte keine sichere Vorschau bereitstellen. Aktualisiere den Konflikt, bevor du es erneut versuchst.',
    truncated: ({ count }) => `${count} weitere ${count === 1 ? 'Konflikt wird' : 'Konflikte werden'} nicht angezeigt`,
    unknownMode: 'Nicht unterstützter Synchronisierungsmodus',
    conflictCount: ({ count }) => `${count} ${count === 1 ? 'Konflikt' : 'Konflikte'}`,
    conflictKind: { file: 'Datei', directory: 'Ordner', symlink: 'Symbolischer Link', missing: 'Fehlt', unsupported: 'Nicht unterstützter Eintrag' },
    mode: { copyOnce: 'Einmal kopieren', keepSynced: 'Aktuell halten – empfohlen', mirrorExactly: 'Exakt spiegeln', keepBothInSync: 'Beide synchron halten' },
    state: { loading: 'Status wird geprüft…', starting: 'Wird vorbereitet', watching: 'Überwacht', flushing: 'Wird synchronisiert', paused: 'Pausiert', peerOffline: 'Offline', conflicted: 'Konflikte', controllerUnavailable: 'Aufmerksamkeit erforderlich', engineUnavailable: 'Komponente nicht verfügbar', error: 'Aufmerksamkeit erforderlich', stopped: 'Beendet', working: 'In Arbeit…' },
    lastChecked: ({ at }) => `Zuletzt geprüft: ${at}`,
    endpoint: { source: ({ label }) => `Quelle · ${label}`, destination: ({ label }) => `Ziel · ${label}`, synced: ({ label }) => `Synchronisierter Endpunkt · ${label}` },
    error: {
        componentUnavailable: 'Die Arbeitsbereichssynchronisierung ist in diesem Build nicht verfügbar. Installiere die erforderliche Komponente und versuche es erneut.',
        machineOffline: 'Der Zielcomputer ist nicht verfügbar. Verbinde ihn erneut und versuche es noch einmal.',
        destinationNeedsPreparation: 'Der Zielordner muss vorbereitet werden, bevor die Synchronisierung beginnen kann.',
        gitPreparationFailed: 'Happier konnte diesen Git-Arbeitsbereich nicht vorbereiten. Prüfe das Ziel und versuche es erneut.',
        authorizationExpired: 'Die Berechtigung für den Arbeitsbereich ist abgelaufen. Starte den Vorgang erneut.',
        rootNoLongerAuthorized: 'Der Arbeitsbereichsordner wurde geändert und ist nicht mehr autorisiert. Prüfe die Verbindung, bevor du es erneut versuchst.',
        conflictNeedsAttention: 'Dieser Konflikt hat sich geändert. Aktualisiere ihn, bevor du eine Version auswählst.',
        needsAttention: 'Die Arbeitsbereichssynchronisierung benötigt Aufmerksamkeit. Aktualisiere den Status und versuche es erneut.',
    },
    start: { blocked: {
        targetMachine: 'Wähle einen Zielcomputer aus, um fortzufahren.',
        targetMachineOffline: 'Dieser Computer ist derzeit nicht verfügbar. Verbinde ihn erneut und versuche es noch einmal.',
        relationshipUnavailable: 'Diese Synchronisierungsverbindung umfasst diese beiden Ordner nicht mehr. Wähle eine andere Arbeitsbereichsoption.',
        sourceFolder: 'Der Ordner dieser Sitzung kann nicht sicher synchronisiert werden. Wähle „Dateien nicht verschieben“, um nur die Sitzung zu übergeben.',
        destinationFolder: 'Wähle einen gültigen Zielordner aus.',
        workspaceOptions: 'Prüfe die Arbeitsbereichsoptionen, bevor du beginnst.',
    } },
    engine: { checking: 'Arbeitsbereichssynchronisierung wird auf diesem Computer geprüft…' },
    actions: { refresh: 'Status aktualisieren', syncNow: 'Jetzt synchronisieren', more: 'Synchronisierungsaktionen', pause: 'Pausieren', resume: 'Fortsetzen', terminate: 'Synchronisierung beenden', openOnMachine: ({ machine }) => `Auf ${machine} öffnen`, openFolder: ({ label }) => `${label}-Ordner öffnen`, keepLocal: 'Lokale Version behalten', keepRemote: 'Entfernte Version behalten', keepNamed: ({ side }) => `Version von ${side} behalten` },
    terminate: { title: 'Arbeitsbereichssynchronisierung entfernen?', body: 'Die Synchronisierung wird beendet und die Verbindung entfernt. Die Dateien bleiben in beiden Arbeitsbereichen erhalten.' },
    resolve: {
        changedTitle: 'Konflikt geändert',
        changedBody: 'Dieser Konflikt hat sich seit dem Öffnen geändert. Die Liste wurde aktualisiert. Prüfe die neuesten Versionen, bevor du erneut auswählst.',
        consequence: 'Die andere Version wird erst entfernt, nachdem Happier geprüft hat, dass die Datei unverändert ist.',
        unsupported: 'Dieser Konflikt enthält einen nicht unterstützten Dateisystemeintrag und kann in Happier nicht gelöst werden. Entferne oder ersetze ihn auf dem betroffenen Computer und aktualisiere dann die Ansicht.',
        keepHint: ({ side }) => `Version von ${side} behalten und die andere geprüfte Version entfernen.`,
    },
    fileState: { text: 'Textvorschau', binary: 'Binärdatei – Vorschau nicht verfügbar', tooLarge: 'Datei ist zu groß für eine Vorschau', missing: 'Datei fehlt', changed: 'Datei wurde geändert, seit dieser Konflikt aufgeführt wurde' },
});

const workspaceSyncTranslations = { de } as const satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation>, "de">;

return { workspaceSyncDiagnosticTranslations, workspaceSyncSetAttentionTranslations, workspaceSyncAddMachineTranslations, workspaceSyncReviewOutcomeTranslations, workspaceSyncCoverageIncompleteTranslations, workspaceSyncReviewLifecycleTranslations, workspaceSyncLocalOnlyTranslations, workspaceSyncKeepAlternativesTranslations, workspaceSyncReviewDecisionTranslations, workspaceSyncReviewTranslations, workspaceSyncReviewSelectionTranslations, workspaceSyncTranslations };
})();

const Domain_workspaceTabTranslations = (() => {
const en = Shared_workspaceTabTranslations.en;

const workspaceTabKeyboardTranslations = Shared_workspaceTabTranslations.workspaceTabKeyboardTranslations;

const workspaceTabTranslations = { de: en };

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
    Domain_voiceMomentsTranslations as voiceMomentsTranslations,
    Domain_voicePresenceTranslations as voicePresenceTranslations,
    Domain_voiceProviderPrivacyTranslations as voiceProviderPrivacyTranslations,
    Domain_voiceReadinessTranslations as voiceReadinessTranslations,
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
