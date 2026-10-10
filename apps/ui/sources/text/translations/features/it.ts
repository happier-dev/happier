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

const accountDisplayTranslations = { it: { unnamed: 'Account senza nome', yours: 'Il tuo account', shortId: ({ id }) => `ID …${id}` } } as const satisfies Pick<Record<string, AccountDisplayTranslation>, "it">;

return { accountDisplayTranslations };
})();

const Domain_accountEncryptionRecoveryTranslations = (() => {
type Copy = Shared_accountEncryptionRecoveryTranslations.Copy;

const en = Shared_accountEncryptionRecoveryTranslations.en;

const it: Copy = {
    recoverAutomationTemplates: 'Recupera i trigger precedenti',
    recoverAutomationTemplatesDescription: 'Usa le chiavi su questo dispositivo per recuperare i trigger precedenti. Vengono conservate finché sessioni crittografate o trigger bloccati ne hanno bisogno.',
    recoverAutomationTemplatesAction: 'Recupera',
    recoverAutomationTemplatesComplete: 'Trigger recuperati. La vecchia chiave rimane su questo dispositivo finché non scegli di dimenticarla.',
    recoverAutomationTemplatesRetained: 'Recupero verificato. Alcuni trigger restano crittografati, bloccati o modificati. La vecchia chiave rimane su questo dispositivo.',
    forgetEncryptionKey: 'Dimentica la vecchia chiave di crittografia',
    forgetEncryptionKeyDescription: 'Le vecchie sessioni crittografate diventano bloccate su questo dispositivo.',
    forgetEncryptionKeyAction: 'Dimentica',
    forgetEncryptionKeyConfirm: 'Dimenticare la vecchia chiave di crittografia?',
    forgetEncryptionKeyWarning: ({ items }) => `Le vecchie sessioni crittografate diventano bloccate su questo dispositivo. Questa cronologia crittografata può diventare inaccessibile:\n\n${items}\n\nL’elenco mostra la cronologia attuale. Anche le sessioni crittografate create in seguito su un altro dispositivo vengono bloccate. Ripristina la vecchia chiave per sbloccarle. Nulla viene eliminato dall’account.`,
    forgetEncryptionKeySession: ({ name, id }) => `Sessione: ${name} (${id})`,
    forgetEncryptionKeyTrigger: ({ id }) => `Trigger: ${id}`,
    forgetEncryptionKeyRun: ({ id }) => `Cronologia esecuzione: ${id}`,
    forgetEncryptionKeyEmpty: 'Nessuna cronologia crittografata trovata.',
    forgetEncryptionKeyComplete: 'La vecchia chiave è stata dimenticata su questo dispositivo.',
    forgetEncryptionKeyFailed: 'Impossibile dimenticare la chiave. Riconnettiti e riprova; prima occorre elencare la cronologia crittografata.',
};

const accountEncryptionRecoveryTranslations = { it } as const;

return { accountEncryptionRecoveryTranslations };
})();

const Domain_accountPopoverTranslations = (() => {
type AccountPopoverTranslation = Shared_accountPopoverTranslations.AccountPopoverTranslation;

const accountPopoverTranslations = { it: {
        pageTitle: 'Account e Home',
        homesTitle: 'Home',
        notLinkedTo: ({ service }) => `Non collegato a ${service}`,
        serviceUnavailable: ({ service }) => `Impossibile raggiungere ${service}`,
        signedInToThisHome: 'Accesso eseguito a questa Home',
        checkingSignIn: 'Verifica dell’accesso…',
        signInStatusUnavailable: 'Stato di accesso non disponibile',
        machinesOnline: ({ online, total }) => `${online} di ${total} ${total === 1 ? 'macchina' : 'macchine'} online`,
        noMachines: 'Ancora nessuna macchina',
        connectedNoMachinesOnline: 'Connessa · nessuna macchina online',
        cantReach: 'Non raggiungibile',
        signedOut: 'Disconnesso',
        signIn: 'Accedi',
        link: 'Collega',
        linkSubtitle: 'Trova le tue Home su ogni dispositivo',
        manageHomes: 'Gestisci le Home',
        connectionDetails: 'Dettagli connessione',
        allHomes: 'Tutte le Home',
        allHomesSubtitle: ({ count }) => `${count} Home · un unico elenco`,
        addHome: 'Aggiungi una Home…',
        addDevice: 'Aggiungi un dispositivo',
    } } as const satisfies Pick<Record<string, AccountPopoverTranslation>, "it">;

return { accountPopoverTranslations };
})();

const Domain_accountServiceOAuthTranslations = (() => {
const en = Shared_accountServiceOAuthTranslations.en;

const it = {
    title: 'Accedi per trovare i tuoi Home',
    cancelNote: 'L’annullamento non disconnetterà gli Home esistenti.', focusedHomePreserved: 'L’Home attivo non cambierà.',
    stages: { signingIn: 'Accesso in corso', findingHomes: 'Ricerca dei tuoi Home', waitingApproval: 'In attesa dell’approvazione dell’Home' },
    errors: { provider: { title: 'Il provider non ha completato l’accesso', body: 'Avvia di nuovo l’accesso.' }, expired: { title: 'Questa richiesta di accesso è scaduta', body: 'Avvia di nuovo l’accesso.' }, identityChanged: { title: 'L’identità del servizio di accesso è cambiata', body: 'Verifica che sia il servizio di accesso che intendevi usare prima di riconnetterti.' }, unavailable: { title: 'Il servizio di accesso non è disponibile', body: 'Controlla il servizio e riprova. Gli Home esistenti non cambieranno.' }, exchange: { title: 'Impossibile completare l’accesso', body: 'Non sono state salvate credenziali del servizio di accesso. Avvia di nuovo l’accesso.' }, storage: { title: 'Impossibile salvare l’accesso', body: 'Le credenziali degli Home esistenti non cambieranno. Avvia di nuovo l’accesso.' }, homeLink: { title: 'Accesso completato, ma non è stato possibile collegare questo Home', body: 'Il tuo accesso è salvato. Prova di nuovo a collegare questo Home.' }, directoryRefresh: { title: 'Accesso completato, ma non è stato possibile aggiornare l’elenco degli Home', body: 'La connessione del servizio di accesso è pronta. Prova di nuovo ad aggiornare l’elenco degli Home.' }, homeEnrollment: { title: 'Accesso completato, ma il tuo Home personale non è stato aggiunto', body: 'Il tuo accesso è salvato. Prova di nuovo ad aggiungere l’Home.' }, invalid: { title: 'Questa richiesta di accesso non è più valida', body: 'Avvia di nuovo l’accesso.' }, accountDisabled: { title: 'Questo account è disattivato', body: 'Contatta chi amministra il tuo servizio di accesso. I tuoi Home esistenti restano invariati.' } },
    actions: { startAgain: 'Ricomincia', openHome: ({ homeName }: { homeName: string }) => `Apri ${homeName}` },
    success: { title: ({ homeName }: { homeName: string }) => `${homeName} è connesso`, body: 'Il tuo accesso è salvato e questo Home è pronto per essere usato.' },
    notLinked: { title: ({ homeName }: { homeName: string }) => `${homeName} non è ancora collegato a questo account`, signInAction: ({ homeName }: { homeName: string }) => `Accedi a ${homeName}`, body: ({ homeName }: { homeName: string }) => `Accedi direttamente a ${homeName}, oppure scansiona il suo codice QR o incolla il suo link Home.`, scanBody: ({ homeName }: { homeName: string }) => `Scansiona il codice QR di ${homeName} o incolla il suo link Home per collegarlo.` },
    noHomes: { body: 'Questo account non ha ancora Home. Aggiorna dopo averne aggiunto uno altrove, oppure scansiona il codice QR di un Home o incolla il suo link Home.' },
    approvalWait: { waitingBody: 'Approva questo accesso dall’altro dispositivo su cui hai effettuato l’accesso.', cancelledTitle: 'Attesa dell’approvazione terminata', cancelledBody: 'L’accesso rimane salvato e gli Home esistenti non cambiano.' },
} as const;

const accountServiceOAuthTranslations = { it } as const;

return { accountServiceOAuthTranslations };
})();

const Domain_actionConfirmationTranslations = (() => {
type ActionConfirmationTranslations = Shared_actionConfirmationTranslations.ActionConfirmationTranslations;

const actionConfirmationTranslations = { it: {
        requestedByAgent: 'Azione richiesta dall’agente della sessione',
        homeTarget: ({ serverId }) => `Home: ${serverId}`,
        sessionTarget: ({ sessionId }) => `Sessione di destinazione: ${sessionId}`,
        oneShotConsequence: 'L’approvazione vale solo per questa richiesta. Non concede autorizzazioni future per Action né permessi nativi.',
        homeUnavailable: 'Questa approvazione appartiene a un Home non disponibile su questo dispositivo. Riconnetti quel Home per decidere.',
    } } as const satisfies Pick<Record<string, ActionConfirmationTranslations>, "it">;

return { actionConfirmationTranslations };
})();

const Domain_fileContentSearchTranslations = (() => {
const fileContentSearchTranslations = { "it": {
        allMatches: ({ matches, files }: { matches: number; files: number }) => `Tutte le ${matches} corrispondenze in ${files} file`,
        moreMatches: "Tutte le corrispondenze",
        textInFiles: "Testo nei file",
        everything: "Tutto",
        refineSearch: "Affina la ricerca",
        partial: "Non è stato possibile cercare in alcuni file. I risultati sono incompleti.",
        updateRequired: "Aggiorna Happier su questa macchina per cercare testo nei file.",
        invalidPattern: "L’espressione regolare non è valida. Modifica il modello e riprova.",
        unavailable: "La ricerca di testo non è disponibile. Controlla la connessione della macchina e riprova.",
        placeholder: "Cerca file, messaggi, commit, sessioni, impostazioni e azioni",
        matchCase: "Distingui maiuscole",
        regex: "Espressione regolare",
    } };

return { fileContentSearchTranslations };
})();

const Domain_promptPickerTranslations = (() => {
const promptPickerTranslations = { "it": {
        "partialHistory": "Inviati prima include solo le sessioni note.",
        "loadedHistory": "Inviati prima mostra solo i messaggi caricati.",
        "open": "Apri prompt",
        "menu": "Prompt…",
        "placeholder": "Cerca prompt e messaggi inviati",
        "favorites": "Preferiti",
        "library": "Libreria",
        "sentBefore": "Inviati prima",
        "builtIn": "Integrato",
        "readError": "Impossibile leggere questo prompt. Riprova.",
        "libraryError": "Impossibile caricare la libreria.",
        "partialLibrary": "Impossibile leggere alcuni prompt.",
        "loadOlder": "Cerca messaggi precedenti",
        "stop": "Interrompi",
        "insert": "Inserisci",
        "send": "Invia ora",
        "addFavorite": "Aggiungi ai preferiti",
        "removeFavorite": "Rimuovi dai preferiti",
        "empty": "Salva un messaggio come prompt per riutilizzarlo qui.",
        "applyError": "Impossibile applicare il prompt. Riprova.",
        "historyError": "Impossibile caricare i messaggi precedenti. Riprova.",
        "title": "Prompt",
        "clear": "Cancella",
        "favorite": "Preferito",
        "favoritesInvite": "Aggiungi una stella a un prompt o a un messaggio inviato per tenerlo qui.",
        "saveAsFavorite": "Salva come prompt preferito",
        "saveInPlaceStarred": ({ time }: { time: string }) => `Dal tuo messaggio di ${time} · va nella libreria, con stella`,
        "saveInPlace": ({ time }: { time: string }) => `Dal tuo messaggio di ${time} · va nella libreria`,
        "noMatchesFor": ({ query }: { query: string }) => `Nessun prompt o messaggio caricato corrisponde a «${query}»`,
        "previewInserts": "viene inserito, poi invii tu",
        "previewSent": "inviato prima",
        "previewEdited": ({ time }: { time: string }) => `Modificato ${time}`,
        "searchingOlder": ({ searched, total }: { searched: number; total: number }) => `Ricerca nei messaggi precedenti… ${searched} di ${total} sessioni`
    } } as const;

return { promptPickerTranslations };
})();

const Domain_actionFamilyTranslations = (() => {
const fileContentSearchTranslations = {...Domain_fileContentSearchTranslations.fileContentSearchTranslations, ...EnglishFeatures.fileContentSearchTranslations.fileContentSearchTranslations};

const promptPickerTranslations = {...Domain_promptPickerTranslations.promptPickerTranslations, ...EnglishFeatures.promptPickerTranslations.promptPickerTranslations};

const surfaceFamilyLabels = Shared_actionFamilyTranslations.surfaceFamilyLabels;

const english = Shared_actionFamilyTranslations.english;

const translated = Shared_actionFamilyTranslations.translated;

const actionFamilyTranslations = { it: translated({
        actionFamilies: {
            ...surfaceFamilyLabels,
            workspace_file_search: fileContentSearchTranslations.it.textInFiles,
            find: 'Trova',
            app_shell: 'Workspace',
            roles: 'Ruoli',
            launch_profiles: 'Profili di avvio',
            discovery: 'Scoperta delle azioni',
            computer: 'Controllo del computer',
            artifact_access: 'Condivisione degli artefatti',
            workflows: 'Flussi di lavoro',
            workflow_effects: 'Webhook e comandi',
            notifications: 'Notifiche',
            machine_agent_install: 'Installazioni degli agenti',
            machine_agent_sign_in: 'Accesso degli agenti',
            session_access: 'Condivisione delle sessioni',
            session_lifecycle: 'Ciclo di vita delle sessioni',
            inventory: 'Inventario dei computer',
            messaging: 'Messaggistica',
            session_control: 'Controlli di sessione',
            intent_start: 'Revisioni e delega',
            review_comments: 'Commenti di revisione',
            subagent_registry: 'Subagenti',
            execution_run_control: 'Esecuzioni in background',
            session_targeting: 'Selezione delle sessioni',
            session_follow: 'Sessioni seguite',
            session_transcripts: 'Trascrizioni delle sessioni',
            session_read_state: 'Stato di lettura',
            session_attention: 'Attenzione',
            session_board: 'Bacheca delle sessioni',
            session_discussion: 'Discussioni',
            session_permissions: 'Permessi di sessione',
            external_sessions: 'Sessioni esterne',
            voice_controls: 'Controlli vocali',
            current_ui_context: 'Schermata attuale',
            companion_controls: 'Assistente',
            memory: 'Memoria',
            agent_acp_catalog: 'Agenti ACP',
            prompt_library: 'Libreria di prompt',
            daemon_admin: 'Amministrazione del daemon',
            browser_control: 'Controllo del browser',
            browser_diagnostics: 'Diagnostica del browser',
            browser_context: 'Contesto del browser',
            browser_automation: 'Automazione del browser',
            browser_recording: 'Registrazione del browser',
            local_services_inventory: 'Servizi locali',
            local_services_launcher: 'Avvio dei servizi',
            local_services_preview: 'Anteprime dei servizi',
            local_services_public_preview: 'Anteprime pubbliche',
            local_services_actions: 'Azioni dei servizi',
            peer_mediation_observability: 'Diagnostica delle connessioni',
            devices_simulator: 'Simulatori',
            approvals: 'Approvazioni',
            plugin_dev_loop: 'Sviluppo di plugin',
            plugin_settings_administration: 'Impostazioni dei plugin',
            plugin_permission_grants: 'Permessi dei plugin',
            plugin_webhooks: 'Webhook dei plugin',
            account_plugin_data: 'Dati dei plugin',
            account_sessions: 'Dispositivi connessi',
            account_security: 'Sicurezza dell’Account',
            account_api_tokens: 'Token API',
            identity_github_apps: 'App GitHub',
            identity_providers: 'Provider di accesso',
            machine_pools: 'Pool di computer',
            ephemeral_runner: 'Esecutori',
            automation_events: 'Eventi di automazione',
            automation_conversation: 'Conversazioni di automazione',
            scm_git: 'Git',
            scm_pull_request: 'Pull request',
            scm_repository: 'Repository',
            scm_diff_summary: 'Riepiloghi delle modifiche',
            home_governance: 'Amministrazione dell’Home',
            teams: 'Team di lavoro',
            saved_secret_sharing: 'Segreti condivisi',
        },
    }) } as const;

return { actionFamilyTranslations };
})();

const Domain_addFlowsTranslations = (() => {
type AddFlowsTranslation = Shared_addFlowsTranslations.AddFlowsTranslation;

const addFlowsTranslations = { it: {
        addHome: 'Aggiungi un Home',
        addHomeSubtitle: 'Accedi, collegati tramite indirizzo o usane uno ospitato',
        addHomeDescription: 'Collega un Home che usi già, oppure usane uno ospitato per te.',
        newGroup: 'Nuovo gruppo',
        newGroupSubtitle: 'Vedi insieme le sessioni di più Home',
        groupsTitle: 'Gruppi',
        homesInUse: 'In uso qui',
        thisDeviceTitle: 'Questo dispositivo',
        thisDeviceSubtitle: 'Come raggiunge i suoi Home',
        thisDeviceDescription: 'Come questo dispositivo raggiunge i suoi Home: dispositivi in attesa, la connessione usata e l’Home che esegue.',
        newHomeDraft: 'Nuovo Home',
        homeMissingTitle: 'Questo Home non è su questo dispositivo',
        homeMissingDescription: 'È stato rimosso oppure salvato su un altro dispositivo.',
        homeManageTitle: 'Gestisci',
        homeAdministrationSubtitle: 'Persone, accesso, raggiungibilità e dati di questo Home',
        groupMissingTitle: 'Questo gruppo non esiste più',
        groupMissingDescription: 'È stato rimosso. I tuoi Home non sono cambiati.',
        discard: 'Scarta',
        sshSignInAgent: 'Il tuo agente SSH su questo computer',
        sshSignInKeyFile: 'Un file di chiave privata su questo computer',
        sshSignInPassword: 'Usata una volta per collegarsi; mai salvata',
        addMachineMenuSubtitle: 'Un computer o un server',
        addMachineDescription: 'Aggiungi un computer o un server perché gli agenti vi eseguano le tue sessioni.',
        machineJoinsHome: ({ home }) => `Si unisce a ${home}`,
        pathThisComputerTitle: 'Questo computer',
        pathThisComputerTask: 'Configuralo in un passaggio',
        pathThisComputerCommand: 'Un comando nel terminale',
        pathSshTitle: 'Un server via SSH',
        pathSshChip: 'Via SSH',
        pathSshSubtitle: 'Una macchina di sviluppo, VM o server cloud',
        pathAnotherTitle: 'Un altro computer',
        pathAnotherSubtitle: 'Apri un link alla Home su quel computer',
        machinePoolPrompt: 'Vuoi che le sessioni passino da una macchina all’altra?',
        thisComputerCommandLead: ({ home }) => `Esegui questo in un terminale di questo computer. Installa Happier e si unisce a ${home}; questa pagina se ne accorge appena è pronto.`,
        thisComputerTaskLead: ({ machine, home }) => `${machine} esegue gli agenti per ${home}. Happier installa un piccolo servizio in background che si avvia con il computer.`,
        setUpThisComputer: 'Configura questo computer',
        desktopAppHint: 'Preferisci cliccare invece di scrivere?',
        desktopAppLink: 'Scarica l’app desktop: configura questo computer da sola.',
        thisComputerRunningLead: ({ machine }) => `Configurazione di ${machine}. Puoi continuare a usare Happier.`,
        onAnotherHomeTitle: ({ machine }) => `${machine} è collegato a un altro Home`,
        onAnotherHomeBody: ({ home }) => `Il suo servizio Happier esegue le sessioni di un altro Home. Spostarlo su ${home} mantiene le impostazioni; le sessioni già lì restano lì.`,
        moveToHome: ({ home }) => `Spostalo su ${home}`,
        keepOnOtherHome: 'Lascialo dov’è',
        sshLeadTask: ({ home }) => `Una macchina di sviluppo, VM o server cloud che raggiungi già via SSH. Questo computer si collega, installa Happier e si unisce a ${home}.`,
        sshLeadCommand: ({ home }) => `Una macchina di sviluppo, VM o server cloud raggiungibile via SSH. Esegui il comando su un computer che la raggiunge; installa Happier e si unisce a ${home}.`,
        setUpHost: ({ host }) => `Configura ${host}`,
        sshSavedNote: 'L’host viene salvato in Host remoti; le password mai.',
        sshRunningTitle: ({ host }) => `Configurazione di ${host}`,
        sshRunningLead: 'Gira via SSH da questo computer. Puoi uscire; l’elenco macchine mostra l’avanzamento e ti avvisa alla fine.',
        anotherLead: ({ home }) => `Esegui questo in un terminale di quel computer. Installa Happier e si unisce a ${home}.`,
        anotherTerminalAction: 'Usa invece un comando nel terminale',
        machineWatching: ({ subject }) => `In attesa di ${subject} su `,
        subjectThisComputer: 'questo computer',
        subjectAnotherComputer: 'il computer',
        machineNotSeeingTitle: ({ subject }) => `Ancora nessuna traccia di ${subject}?`,
        machineNotSeeingBody: ({ home }) => `Happier sta ancora aspettando. Di solito la configurazione si è fermata con un errore, la macchina non raggiunge ${home} o è stata configurata per un altro Home.`,
        machineArrived: ({ machine }) => `${machine} è collegato`,
        machineConnectedJustNow: 'collegato ora',
        machineStartSession: ({ machine }) => `Avvia una sessione su ${machine}`,
        machineAddAnother: 'Aggiungine un’altra',
        cancelSetup: 'Annulla',
        detectedOs: 'Rilevato',
        sshSuggestionsTitle: 'Dalla tua configurazione SSH e dagli host salvati',
        connectingToHome: ({ address }) => `Connessione a ${address}…`,
        pathThisComputerConnected: 'Collegato · vedi i suoi agenti',
    } } satisfies Pick<Readonly<Record<string, AddFlowsTranslation>>, "it">;

return { addFlowsTranslations };
})();

const Domain_agentInstallJobTranslations = (() => {
const en = Shared_agentInstallJobTranslations.en;

const agentInstallJobTranslations = { it: { ...en } };

return { agentInstallJobTranslations };
})();

const Domain_agentStartTranslations = (() => {
const en = Shared_agentStartTranslations.en;

const it: typeof en = {
    titles: {
        conversation: 'Una conversazione a parte',
    },
    descriptions: {
        conversation: ({ machine }) => `Chiedi qualsiasi cosa senza interrompere questa sessione. Gira su ${machine} accanto; non torna nulla finché non lo invii.`,
    },
    chips: {
        engineTitle: 'Chi risponde',
        addReviewer: 'Aggiungi revisore',
        removeReviewer: ({ name }) => `Rimuovi ${name}`,
        scope: 'Cosa rivedere',
        advanced: 'Avanzate',
    },
    reportToSession: 'Riferisci a questa sessione',
    startsWhenYouSend: ({ count }) => count > 1 ? `${count} revisioni partono all’invio` : 'Parte all’invio',
    offline: ({ machine }) => `${machine} è offline. L’agente parte lì; la bozza resta qui finché non torna.`,
    menu: {
        askSection: 'Chiedi a un agente',
        secondOpinionTitle: 'Secondo parere',
        secondOpinionSubtitle: 'Un controllo indipendente prima di chiudere',
        keepGoingTitle: 'Continua fino alla fine…',
        keepGoingSubtitle: 'Imposta un obiettivo nel controllo obiettivo',
        runWorkflowTitle: 'Esegui un workflow',
        runWorkflowSubtitle: 'Dalla tua libreria o integrato',
        searchWorkflows: 'Cerca workflow…',
        yourLibrary: 'La tua libreria',
        noWorkflows: 'Nessun workflow salvato',
        addTriggerTitle: 'Aggiungi un trigger…',
        addTriggerSubtitle: 'Parte qui ogni volta che succede qualcosa',
        advancedTitle: 'Avanzate…',
        advancedSubtitle: 'Più agenti, permessi, profilo',
        builtIn: 'Integrati',
        allWorkflows: 'Tutti i workflow…',
    },
    role: {
        replaces: ({ agent }) => `Sostituisce ${agent}`,
    },
    startRow: {
        subtitle: 'Bozza · parte all’invio',
        conversation: 'Nuova conversazione',
        review: 'Nuova revisione',
        plan: 'Nuovo piano',
        delegate: 'Nuova attività',
    },
    pane: {
        cancelRun: 'Annulla esecuzione',
        whenItFinishes: 'Quando finisce',
        sendToSession: ({ session }) => `Invia a ${session}`,
        replyTo: ({ agent }) => `Rispondi a ${agent}…`,
        repliesGoTo: ({ session }) => `Le risposte vanno a questo agente, non a ${session}`,
    },
};

const agentStartTranslations = { it };

return { agentStartTranslations };
})();

const Domain_apiTokenSettingsTranslations = (() => {
const english = Shared_apiTokenSettingsTranslations.english;

const translated = Shared_apiTokenSettingsTranslations.translated;

const apiTokenSettingsTranslations = { it: translated({
        settingsApiTokens: {
            encryption: {
                choice: "Accesso alla crittografia",
                consequence: "Concede accesso alla crittografia dell’intero account. La revoca interrompe le future autorizzazioni API; le chiavi o i dati già ottenuti non possono essere richiamati.",
                enabled: "Accesso alla crittografia attivo",
                bearerOnly: "Solo accesso API",
                unknown: "Accesso alla crittografia sconosciuto",
                outcomeUnknown: "La creazione potrebbe essere stata completata. Aggiorna l’elenco e revoca questo token prima di crearne deliberatamente un altro.",
                unsupported: "Questo Home non supporta ancora i token API crittografati. Aggiornalo o crea un token ordinario.",
                notReady: "Ripristina l’accesso alla crittografia su questo Home prima di creare un token crittografato.",
                stale: "La chiave di crittografia dell’account è cambiata. Ripristina l’accesso su questo Home.",
                idConflict: "Questo ID token esiste già. Revoca quel token esatto prima di crearne un altro.",
            },
            unattended: {
                choice: "Accesso non presidiato al team",
                consequence: "Copia in questo token i metodi di autenticazione attualmente verificati di questa credenziale per il lavoro limitato del team. L’accesso alla crittografia è indipendente.",
                authorized: "Accesso non presidiato al team autorizzato",
                notAuthorized: "Nessun accesso non presidiato al team",
                evidenceLimit: "Questa credenziale ha troppi metodi di autenticazione verificati da copiare. Non è stato creato alcun token.",
                evidenceUnavailable: "Questa credenziale con accesso effettuato non ha prove di autenticazione attuali da copiare. Autenticati di nuovo con il metodo richiesto; non è stato creato alcun token.",
            },
            title: 'Token API',
            entrySubtitle: 'Consenti a script, server e app incorporate di agire per te, solo con l’accesso che concedi loro.',
            tokens: 'Token API',
            refreshing: 'Aggiornamento…',
            emptyTitle: 'Nessun token API ancora',
            emptyBody: 'I token consentono a script e strumenti attendibili di eseguire le azioni automatizzate che autorizzi. Crea un token quando un’integrazione ha bisogno di accedere al tuo Account attuale.',
            created: 'Creato',
            lastUsed: 'Ultimo utilizzo',
            neverUsed: 'Mai utilizzato',
            securityTitle: 'Sicurezza',
            securityFooter: 'Queste azioni hanno effetto sull’intero Account attuale.',
            status: {
                active: 'Attivo',
                expiresInMinutes: ({ count }) => `Scade tra ${count} min`,
                expiresInHours: ({ count }) => `Scade tra ${count} h`,
                expiresInDays: ({ count }) => `Scade tra ${count} g`,
                expired: 'Scaduto',
            },
            rowAccessibilityLabel: ({ label, state }) => `${label}, stato: ${state}`,
            moreActionsAccessibilityLabel: ({ label }) => `Altre azioni per ${label}`,
            create: {
                button: 'Crea token',
                title: 'Crea token API',
                subtitle: 'Dai un nome all’integrazione e scegli quando scade questo token. Il tuo Home può leggere richieste e risultati dell’API ordinaria; l’accesso alla crittografia può proteggere le chiamate SDK supportate.',
                submit: 'Crea token',
                label: 'Etichetta',
                labelPlaceholder: 'Automazione delle release',
                expiry: 'Scade',
                expiryOptions: {
                    '30d': '30 giorni',
                    '90d': '90 giorni',
                    '1y': '1 anno',
                    none: 'Nessuna scadenza',
                },
                access: 'Accesso',
                accessFull: 'Accesso completo',
                accessLimited: 'Limitato',
                accessLimitedDescription: 'Poi scegli azioni, sessioni, modelli e siti web.',
                accessTitle: 'Scegli l’accesso',
                continue: 'Continua',
                back: 'Indietro',
                actionSettingsPrefix: 'Questo token può eseguire qualsiasi operazione abilitata per API esterna e SDK nelle tue',
                actionSettingsLink: 'Impostazioni azioni.',
            },
            reveal: {
                title: 'Salva il tuo token API',
                accessibilityAnnouncement: 'Copia ora il tuo token: viene mostrato una sola volta.',
                successTitle: 'Token creato',
                shownOnce: 'Copia questo token ora. Per la tua sicurezza, Happier non può mostrarlo di nuovo.',
                copy: 'Copia token',
                copied: 'Copiato',
                dismissTitle: 'Uscire senza confermare?',
                dismissBody: 'Questo token non verrà mostrato di nuovo. Copialo prima oppure conferma di averlo salvato in un luogo sicuro.',
                copyFirst: 'Mantieni visibile il token',
                savedIt: 'L’ho salvato',
            },
            revoke: {
                title: ({ label }) => `Revocare «${label}»?`,
                body: 'L’accesso al server e all’API si interromperà alla prossima verifica. Un daemon locale che ha verificato di recente questo token API potrebbe continuare ad accettarlo fino a un minuto. Questa azione non può essere annullata.',
                confirm: 'Revoca token',
            },
            revokeAll: {
                title: 'Revoca tutti i token API',
                subtitle: 'Disabilita ogni token API di questo Account.',
                body: 'L’accesso al server e all’API si interromperà alla prossima verifica. Gli incorporamenti che usano questi token smettono di funzionare e le loro credenziali incorporate vengono disconnesse. I daemon locali che hanno verificato di recente questi token API potrebbero continuare ad accettarli fino a un minuto. Questa azione non può essere annullata.',
                confirm: 'Revoca tutti',
                railAction: 'Revoca tutti i token API…',
            },
            signOutEverywhere: {
                title: 'Esci ovunque',
                subtitle: 'Termina tutte le sessioni connesse di questo Account.',
                body: 'Tutte le sessioni connesse nei browser e sui dispositivi verranno terminate. I token API restano attivi; revocali separatamente da questa schermata.',
                confirm: 'Esci ovunque',
            },
            errors: {
                labelRequired: 'Inserisci un’etichetta prima di creare il token.',
                accountChanged: 'Il tuo account o Home attivo è cambiato, quindi non è stato modificato nulla. Riaprilo per continuare.',
                presentUserRequired: 'Conferma la tua identità nella richiesta di accesso, poi riprova.',
                offline: 'Happier non è riuscito a raggiungere il tuo Account. Controlla la connessione e riprova.',
                unavailable: 'Questa azione non è disponibile in questo momento. Riprova tra poco.',
                copyFailed: 'Non è stato possibile copiare il token. Selezionalo e copialo manualmente prima di chiudere.',
                listTitle: 'Token API non disponibili',
                grantIncomplete: 'Completa la scelta dell’accesso prima di creare il token.',
            },
            embedPill: 'Incorporato',
            embedRowHint: 'Apre questo incorporamento in Impostazioni, Incorporamenti.',
            summary: {
                full: 'Accesso completo',
                allActions: 'Ogni azione',
                namesAndMore: ({ names, count }) => `${names} +${count}`,
                sessions: ({ count }) => (count === 1 ? '1 sessione' : `${count} sessioni`),
                computers: ({ count }) => (count === 1 ? '1 computer' : `${count} computer`),
                approve: 'Può approvare',
                models: ({ count }) => (count === 1 ? '1 modello' : `${count} modelli`),
                websites: ({ count }) => (count === 1 ? '1 sito web' : `${count} siti web`),
                content: 'Accesso ai contenuti',
                noExpiry: 'Nessuna scadenza',
                expires: ({ date }) => `Scade il ${date}`,
                expired: ({ date }) => `Scaduto il ${date}`,
            },
            grant: {
                accessTitle: 'Accesso',
                back: 'Accesso',
                onlyThese: 'Solo questi',
                selectedCount: ({ count }) => (count === 1 ? '1 selezionato' : `${count} selezionati`),
                reviewUnnamed: 'Questo token',
                actions: {
                    title: 'Azioni',
                    all: 'Ogni azione',
                    none: 'Scegli almeno un’azione',
                    search: 'Cerca azioni',
                    noMatches: ({ query }) => `Nessuna azione corrisponde a «${query}»`,
                    groupDescription: 'Un intero gruppo include anche le azioni aggiunte in seguito.',
                    familyCount: ({ count }) => (count === 1 ? 'Gruppo · 1 azione' : `Gruppo · ${count} azioni`),
                    includedByFamily: ({ family }) => `Inclusa in ${family}`,
                },
                targets: {
                    title: 'Sessioni e computer',
                    all: 'Ogni sessione e computer',
                    none: 'Scegli almeno una sessione o un computer',
                    computers: 'Computer',
                    computersDescription: 'Un computer include ogni sua sessione, ora e in futuro.',
                    sessions: 'Sessioni',
                    searchSessions: 'Cerca sessioni',
                    noSessions: 'Ancora nessuna sessione',
                    noSessionMatches: ({ query }) => `Nessuna sessione corrisponde a «${query}»`,
                    noComputers: 'Ancora nessun computer',
                },
                models: {
                    title: 'Modelli',
                    any: 'Qualsiasi modello',
                    onlyThese: 'Solo questi modelli',
                    none: 'Scegli almeno un modello',
                    pickerDescription: 'Gli altri modelli vengono rifiutati, non solo nascosti. «Automatico» non viene offerto quando scegli dei modelli.',
                    noModels: 'Ancora nessun modello da scegliere',
                },
                approve: {
                    title: 'Approva richieste',
                    on: 'Può approvare l’uso degli strumenti e le richieste nelle sessioni sopra, comprese quelle avviate da lui stesso. Non può mai modificare token, sicurezza o plugin.',
                    off: 'Le richieste ti aspettano in Happier.',
                },
                websites: {
                    title: 'Siti web',
                    description: 'Le pagine di questi siti possono usare il token da un browser. Lascia vuoto per script e server.',
                    inputLabel: 'Aggiungi un sito web',
                    placeholder: 'https://app.example.com',
                    add: 'Aggiungi',
                    invalid: 'Inizia con https://, oppure http:// per localhost.',
                    duplicate: 'Questo sito web è già in elenco.',
                    remove: ({ origin }) => `Rimuovi ${origin}`,
                },
            },
            detail: {
                whatItCanDo: 'Cosa può fare',
                whatItCanDoDescription: 'Azioni che questo token può eseguire per te. Tutto il resto viene rifiutato.',
                everyAction: 'Ogni azione abilitata per API esterna e SDK',
                wholeGroup: 'Intero gruppo',
                where: 'Dove',
                whereDescription: 'Sessioni e computer che può raggiungere.',
                computerCovers: 'Ogni sessione su questo computer',
                unknownComputer: 'Un computer non più in elenco',
                unknownSession: 'Una sessione non più in elenco',
                modelsDescription: 'Gli altri modelli vengono rifiutati, non solo nascosti.',
                approvals: 'Approvazioni',
                approvesOn: 'Approva le richieste',
                approvesOff: 'Non approva le richieste',
                websitesDescription: 'Le pagine di questi siti possono usarlo dal browser.',
                noWebsites: 'Solo script e server',
                content: 'Accesso ai contenuti',
                contentOn: 'Può leggere contenuti crittografati end-to-end tramite chiamate SDK supportate.',
                contentOff: 'Non può leggere contenuti crittografati end-to-end.',
                children: 'Credenziali incorporate',
                childrenDescription: 'Chiavi di breve durata che la tua app ha generato da questo token per le sue pagine.',
                childrenCount: ({ count }) => (count === 1 ? '1 attiva' : `${count} attive`),
                childrenConsequence: 'Vengono disconnesse quando modifichi l’accesso o revochi questo token.',
                sessionLimits: 'Sessioni',
                sessionLimitsDescription: 'Le sessioni che può avviare e le modalità di autorizzazione che i suoi messaggi possono usare.',
                createsSessions: 'Avvia sessioni',
                createsSessionsOn: ({ computer }: { computer: string }) => `Su ${computer}, in una cartella privata gestita da Happier.`,
                editAccess: 'Modifica accesso',
                revokeFootnote: 'Script e incorporamenti che lo usano smettono di funzionare alla richiesta successiva.',
                created: ({ date }) => `Creato il ${date}`,
                lastUsed: ({ date }) => `Ultimo utilizzo il ${date}`,
                missingTitle: 'Questo token non esiste più',
                missingBody: 'È stato revocato o è scaduto ed è stato rimosso. Gli altri token sono ancora in elenco.',
                backToTokens: 'Mostra token API',
            },
            edit: {
                title: 'Modifica accesso',
                save: 'Salva',
                signsOut: 'Le credenziali incorporate attive verranno disconnesse.',
            },
            cliPolicy: {
                sectionTitle: 'CLI e daemon',
                sectionDescription: 'Cosa possono fare i comandi sui tuoi computer con il tuo accesso.',
                title: 'Consenti approvazioni e modifiche all’Account da CLI e daemon',
                description: 'Consente ai comandi sui tuoi computer di approvare richieste e modificare le impostazioni dell’Account. Disattivalo se gli agenti vengono eseguiti con accesso alla shell. Un computer può anche escludersi con HAPPIER_CLI_PRESENT_USER=disallowed. La modifica riconnette brevemente i tuoi computer.',
                unavailable: 'Impossibile leggere questa impostazione. Riprova tra un momento.',
                saveFailed: 'Impossibile modificare questa impostazione. Riprova tra un momento.',
            },
            notices: {
                revoked: 'Token API revocato.',
                revokedAll: 'Tutti i token API sono stati revocati.',
                signedOutEverywhere: 'Sei uscito ovunque. I token API restano attivi.',
            },
        },
    }) } as const;

return { apiTokenSettingsTranslations };
})();

const Domain_artifactsBrowserTranslations = (() => {
type ArtifactsBrowserTranslations = Shared_artifactsBrowserTranslations.ArtifactsBrowserTranslations;

const artifactsBrowserTranslations = { it: {
        description: 'Ciò che tu e i tuoi agenti avete salvato, pronto da leggere, riutilizzare e condividere.',
        newDocument: 'Nuovo documento',
        searchPlaceholder: 'Cerca artefatti',
        kindLabel: 'Tipo',
        sourceLabel: 'Origine',
        kinds: {
            all: 'Tutti i tipi',
            document: 'Documenti',
            prompt: 'Prompt',
            memory: 'Memorie',
            board: 'Bacheche',
            workflow: 'Workflow',
            role: 'Ruoli',
            launchProfile: 'Profili di avvio',
        },
        kindOne: {
            document: 'Documento',
            prompt: 'Prompt',
            memory: 'Memoria',
            board: 'Bacheca',
            workflow: 'Workflow',
            role: 'Ruolo',
            launchProfile: 'Profilo di avvio',
        },
        sort: {
            label: 'Ordina',
            updated_desc: 'Aggiornati di recente',
            created_desc: 'Creati di recente',
            title_asc: 'Titolo',
        },
        view: {
            label: 'Vista',
            grid: 'Griglia',
            list: 'Elenco',
            folders: 'Cartelle',
        },
        folders: {
            newFolder: 'Nuova cartella',
            newFolderInside: 'Nuova cartella all’interno',
            rename: 'Rinomina',
            moveTo: 'Sposta nella cartella…',
            moveItemTo: ({ name }) => `Sposta «${name}» in`,
            newFolderEllipsis: 'Nuova cartella…',
            moveVerb: 'Sposta in',
            topLevel: 'Livello superiore',
            moveToTopLevel: 'Sposta al livello superiore',
            deleteFolder: 'Elimina cartella',
            deleteTitle: ({ name }) => `Eliminare «${name}»?`,
            deleteBody: 'I suoi elementi e le sue cartelle salgono di un livello. Non viene eliminato nulla.',
            nameHelp: 'Le cartelle sono solo tue. Archiviare qualcosa non lo cambia mai per le persone con cui è condiviso.',
            namePlaceholder: 'Nome della cartella',
            create: 'Crea',
            options: ({ name }) => `Opzioni di ${name}`,
            expand: ({ name }) => `Espandi ${name}`,
            collapse: ({ name }) => `Comprimi ${name}`,
            columnName: 'Nome',
            columnEdited: 'Modificato',
            emptyInvite: 'Ancora nessuna cartella. Raggruppa ciò che va insieme; solo tu vedi come archivi.',
            unavailable: 'Impossibile caricare le cartelle da questo Home. Tutto è elencato senza di esse.',
            saveFailed: 'La modifica non è stata salvata. Riprova.',
            refusedCycle: 'Una cartella non può essere spostata dentro se stessa',
            refusedUnavailable: 'Le cartelle non sono disponibili al momento',
            refusedOther: 'Non può essere spostato lì',
            showAllKinds: 'Mostra tutti i tipi in Artefatti',
            promptSearch: 'Cerca prompt e skill',
        },
        provenance: {
            savedByYou: 'Salvato da te',
            sharedWithYou: 'Condiviso con te',
            fromFile: ({ name }) => `Da ${name}`,
            openSession: ({ session }) => `Apri ${session}`,
        },
        emptyTitle: 'Conserva ciò che creano i tuoi agenti',
        emptyBody: 'Piani, note, codice e bacheche che tu o i tuoi agenti salvate arrivano qui, leggibili su ogni dispositivo e pronti da condividere con i tuoi team.',
        emptyHint: 'Oppure chiedi a un agente “salvalo come artefatto”.',
        loadFailedTitle: 'Impossibile caricare i tuoi artefatti',
        loadFailedBody: 'Controlla la connessione e riprova. Non è andato perso nulla.',
        retainedBody: "Aggiornamento non riuscito. Sono mostrati gli ultimi artefatti caricati.",
        quota: {
            accountTitle: 'Lo spazio per gli artefatti è pieno',
            documentTitle: 'Troppo grande per essere salvato',
            accountBody: ({ used, limit }) => `${used} di ${limit} usati, versioni incluse. Elimina o esporta gli artefatti che non ti servono più per salvarne di nuovi.`,
            documentBody: ({ size, limit }) => `Occuperebbe ${size}; ogni artefatto può contenere fino a ${limit}. Le tue modifiche sono ancora qui.`,
        },
        open: {
            document: 'Apri documento',
            prompt: 'Apri prompt',
            memory: 'Apri memoria',
            board: 'Apri bacheca',
            workflow: 'Apri workflow',
            role: 'Apri ruolo',
            launchProfile: 'Apri profilo di avvio',
        },
        openAsPage: 'Apri come pagina',
        actions: {
            edit: 'Modifica',
            history: 'Cronologia',
            share: 'Condividi',
            more: 'Altre azioni',
            copyLink: 'Copia link',
            linkCopied: 'Link copiato',
        },
        history: {
            title: 'Cronologia',
            current: 'Attuale',
            now: 'Ora',
            restoreNote: 'Il ripristino la aggiunge come nuova versione. Non si perde nulla.',
            loadFailed: 'Impossibile caricare la cronologia. Riprova.',
            empty: 'Nessuna versione precedente. Ogni salvataggio ne conserva una.',
            versionsLabel: 'Versioni',
            restoreFailed: 'Impossibile ripristinare questa versione. Riprova.',
            savedByUser: 'Salvato da un utente',
            savedByAgentSession: 'Salvato da una sessione agente',
            restoredVersion: ({ n }) => `Ripristinato dalla versione ${n}`,
            version: ({ n }) => `Versione ${n}`,
            keeps: ({ count }) => `Conserva le ultime ${count} versioni.`,
            restore: ({ n }) => `Ripristina versione ${n}`,
        },
        savedToday: ({ count }) => `${count} salvati oggi`,
        noMatch: ({ query }) => `Nessun artefatto corrisponde a “${query}”`,
        storage: {
            meter: ({ used, limit }) => `${used} di ${limit}`,
            a11y: ({ used, limit }) => `Spazio artefatti, ${used} di ${limit} usati`,
        },
        facts: {
            edited: ({ age }) => `Modificato ${age}`,
        },
    } } satisfies Pick<Record<'en' | 'fr' | 'de' | 'es' | 'it' | 'pt' | 'ca' | 'ru' | 'pl' | 'ja' | 'zh-Hans' | 'zh-Hant', ArtifactsBrowserTranslations>, "it">;

return { artifactsBrowserTranslations };
})();

const Domain_automationPageTranslations = (() => {
const english = Shared_automationPageTranslations.english;

const translated = Shared_automationPageTranslations.translated;

const slavicPlural = Shared_automationPageTranslations.slavicPlural;

const automationPageTranslations = { it: translated({
        automationPages: {
            index: {
                description: 'Lavoro che parte da solo: secondo una pianificazione, da un Event o quando termina un turno di una sessione.',
            },
            settings: {
                description: 'Quanto lavoro di automazione accetta ogni macchina e per quanto tempo vengono conservate le esecuzioni terminate.',
                capacityTitle: 'Capacità',
                capacityDescription: 'Vale per ogni macchina che esegue automazioni.',
                historyTitle: 'Cronologia esecuzioni',
                historyDescription: 'Esecuzioni terminate che puoi ancora aprire da un’automazione.',
            },
            detail: {
                description: 'Avvia lavoro da sola ogni volta che scatta uno dei suoi trigger.',
                triggerCount: ({ count }: { count: number }) => (count === 1 ? '1 trigger' : `${count} trigger`),
                overviewDescription: 'Cosa esegue e come avviarla o modificarla.',
                runNowSubtitle: 'Avvia un’esecuzione ora, senza aspettare un trigger.',
                editSubtitle: 'Cambia nome, cosa esegue e i trigger.',
                machineAssignmentsDescription: 'Macchine che possono prendere le esecuzioni di questa automazione.',
            },
            run: {
                description: 'Cosa ha avviato questa esecuzione, dove è stata eseguita e cosa ha prodotto.',
                statusTitle: 'Stato',
                statusDescription: 'A che punto è questa esecuzione e cosa puoi ancora farne.',
                causeTitle: 'Cosa l’ha avviata',
                causeDescription: 'Il trigger e l’evento che hanno ammesso questa esecuzione. Non cambiano mai dopo.',
            },
            gate: {
                serverTitle: 'Le automazioni sono disattivate in questo Home',
                serverBody: 'Gli amministratori di questo Home hanno disattivato le automazioni. Chiedi a uno di loro di riattivarle.',
                openFeatures: 'Apri le impostazioni delle funzionalità',
                unknownTitle: 'Impossibile verificare le automazioni in questo momento',
                unknownBody: 'Happier non è riuscito a raggiungere questo Home per verificare se le automazioni sono attive. Verifica di nuovo quando torna online.',
                unsupportedTitle: 'Questo Home non supporta ancora le automazioni',
                unsupportedBody: 'Il suo server è precedente alle automazioni. Aggiorna il server del Home per usarle.',
                unsupportedContextTitle: 'Le automazioni non sono disponibili qui',
                unsupportedContextBody: 'Non tutti gli Home che stai visualizzando supportano le automazioni.',
            },
            editor: {
                description: 'Dalle un nome, scegli cosa esegue, poi aggiungi i trigger che la avviano.',
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

const automationTriggerSetTranslations = { it: {
        pluralEditor: {
            ...expandedLifecycleEnglish,
            lifecycleEvent: {
                ...expandedLifecycleEnglish.lifecycleEvent,
                sessionStarted: 'Quando inizia la sessione',
                sessionArchived: 'Quando la sessione viene archiviata',
            },
            triggersTitle: 'Trigger',
            emptyBody: 'Nessun trigger automatico. Puoi comunque avviare questa automazione manualmente.',
            orSemantics: 'Aggiungi tutti i trigger che vuoi. Funzionano in modo indipendente: l’automazione parte quando ne corrisponde uno qualsiasi.',
            enabledSubtitle: 'Metti in pausa l’intera automazione senza modificare i trigger.', addTrigger: 'Aggiungi trigger',
            addTriggerSubtitle: 'Pianificala, collega un evento o attendi la fine di un turno preciso.', scheduleTitle: 'Pianificazione', eventTitle: 'Evento del plugin',
            turnCompletedTitle: 'Al termine di questo turno', turnCompletedSubtitle: 'Viene eseguita una volta dopo il completamento del turno principale selezionato.', selectedSession: 'Sessione selezionata',
            turnCompletedSource: ({ session, ordinal }: { session: string; ordinal: number }) => `${session} · trigger una tantum ${ordinal}`,
            scheduleInterval: ({ minutes, timezone }: { minutes: number; timezone: string | null }) => `Ogni ${minutes} min${timezone ? ` · ${timezone}` : ''}`,
            scheduleCron: ({ expression, timezone }: { expression: string; timezone: string | null }) => `${expression}${timezone ? ` · ${timezone}` : ''}`,
            eventSubtitle: ({ pluginId, eventId }: { pluginId: string; eventId: string }) => `${pluginId} · ${eventId}`,
            triggerEnabledLabel: ({ title }: { title: string }) => `Abilita ${title}`, editScheduleTitle: 'Modifica pianificazione', scheduleType: 'Tipo di pianificazione',
            chooseSession: 'Scegli una sessione attiva', eventEditorUnavailable: 'La configurazione dell’evento non è disponibile sulla macchina corrente.',
            removeTitle: 'Rimuovere questo trigger?', removeBody: 'Le corrispondenze future di questo trigger non avvieranno più l’automazione. La cronologia delle esecuzioni resterà invariata.',
        },
        exactTurn: {
            eventSearchPlaceholder: 'Cerca eventi',
            refreshFailedTitle: 'Impossibile aggiornare le automazioni',
            refreshFailedBody: 'Al momento non è stato possibile leggere l’elenco delle automazioni. Riprova per caricare l’elenco attuale.',
            actionTitle: 'Al termine di questo turno…', createNew: 'Crea una nuova automazione', createNewSubtitle: 'Inizia con questo turno preciso già selezionato.',
            addToExistingSubtitle: 'Aggiungi questo turno preciso a un’automazione esistente.', searchPlaceholder: 'Cerca automazioni',
            eventListA11y: 'Scegli l’evento del ciclo di vita della sessione',
            destinationA11y: 'Scegli dove aggiungere il trigger di questo turno', staleTitle: 'Questo turno è cambiato',
            staleBody: 'Il turno selezionato non è più il turno principale attivo. Aggiorna e scegli esplicitamente il turno corrente.',
            useCurrentTurn: 'Usa il turno corrente', unavailable: 'Al momento non è disponibile un turno principale attivo.',
            resolvingRowSubtitle: 'Verifica delle automazioni che puoi usare…',
            unavailableRowSubtitle: 'Dettagli non disponibili: questa automazione non può essere verificata per questa sessione.',
            incompleteNoticeTitle: 'Impossibile leggere alcune automazioni',
        },
    } } as const;

return { automationTriggerSetTranslations };
})();

const Domain_boardsTranslations = (() => {
type Count = Shared_boardsTranslations.Count;

type BoardsTranslations = Shared_boardsTranslations.BoardsTranslations;

const en = Shared_boardsTranslations.en;

const it: BoardsTranslations = {
    title: 'Bacheche',
    newBoard: 'Nuova bacheca',
    defaultName: 'Bacheca senza nome',
    index: {
        title: 'Le tue bacheche',
        body: 'Una bacheca tiene sessioni, esecuzioni, workflow e macchine in diretta in un unico posto, disposti a modo tuo.',
    },
    notFound: {
        title: 'Questa bacheca non c\'è più',
        body: 'È stata eliminata, oppure appartiene a una Home non connessa qui.',
    },
    meta: {
        needYou: ({ count }) => `${count} ha${count === 1 ? '' : 'nno'} bisogno di te`,
        items: ({ count }) => (count === 1 ? '1 elemento' : `${count} elementi`),
        handPicked: 'Scelti a mano',
        empty: 'Vuota',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: 'Ha bisogno di te', description: 'Tutto ciò che ti aspetta' },
        running: { title: 'In esecuzione', description: 'Esecuzioni di workflow in corso' },
        my_machines: { title: 'Le mie macchine', description: 'Presenza e cosa gira su ciascuna' },
        filter: { title: 'Sessioni', description: 'Tutte le sessioni attive' },
    },
    header: {
        layoutA11y: 'Disposizione della bacheca',
        canvas: 'Canvas',
        byStatus: 'Per stato',
        add: 'Aggiungi alla bacheca',
        settings: 'Impostazioni della bacheca',
    },
    kinds: {
        session: 'Sessione',
        workflow_run: 'Esecuzione di workflow',
        workflow: 'Workflow',
        machine: 'Macchina',
    },
    card: {
        untitled: 'Elemento non disponibile',
        unavailable: 'Non disponibile',
        unavailableBody: 'La sua Home non è connessa su questo dispositivo. Resta sulla bacheca.',
        notLoaded: 'Non ancora caricato',
        remove: 'Rimuovi dalla bacheca',
        moveHint: 'I tasti freccia spostano questa scheda sulla griglia.',
        moved: ({ x, y }) => `Spostata in ${x}, ${y}`,
        moveActions: { up: 'Sposta in su', down: 'Sposta in giù', left: 'Sposta a sinistra', right: 'Sposta a destra' },
        machine: {
            online: 'Online',
            offline: 'Offline',
            running: ({ count }) => (count === 1 ? '1 sessione in corso' : `${count} sessioni in corso`),
            needYou: ({ count }) => `${count} ha${count === 1 ? '' : 'nno'} bisogno di te`,
            idle: 'Nessuna sessione in corso',
            offlineBody: 'Le sue sessioni aspettano che torni.',
        },
        workflow: {
            noRuns: 'Ancora nessuna esecuzione',
            lastRun: ({ word, age }) => `Ultima esecuzione ${age} · ${word}`,
            needYou: ({ count }) => `${count} ha${count === 1 ? '' : 'nno'} bisogno di te`,
        },
        run: {
            waitingForYou: 'In attesa della tua revisione',
            started: ({ age }) => `Avviata ${age}`,
        },
    },
    canvas: {
        snapsHere: 'Si aggancia qui',
        snapOnceHint: 'Tieni premuto ⇧ per agganciare una volta',
    },
    settings: {
        title: 'Impostazioni della bacheca',
        name: 'Nome',
        whatsOn: 'Cosa c\'è su questa bacheca',
        whichSessions: 'Quali sessioni',
        addedByHand: 'Aggiunti a mano',
        addedByHandNone: 'Ancora niente',
        add: 'Aggiungi',
        layout: 'Disposizione',
        layoutDescription: 'Canvas mantiene la tua disposizione quando cambi.',
        snap: 'Aggancia alla griglia',
        pin: 'Mostra nell\'elenco delle sessioni',
        pinDescription: 'Fissa questa bacheca sopra le tue sessioni.',
        delete: 'Elimina bacheca',
        deleteConfirmTitle: 'Eliminare questa bacheca?',
        deleteConfirmBody: 'Sparisce solo la bacheca. Le sue sessioni, esecuzioni, workflow e macchine restano come sono.',
    },
    add: {
        title: 'Aggiungi alla bacheca',
        search: 'Cerca elementi',
        groups: { sessions: 'Sessioni', workflows: 'Workflow', runs: 'Esecuzioni di workflow', machines: 'Macchine' },
        onBoard: 'Su questa bacheca',
        addHint: 'Aggiungi',
        addAndPlaceHint: 'Aggiungi e posiziona',
        empty: 'Nessun risultato.',
    },
    empty: {
        title: 'Scegli cosa mostra questa bacheca',
        body: 'Aggiungi a mano sessioni, workflow, esecuzioni o macchine, oppure mostra una sezione come Ha bisogno di te. Le disponi tu; la bacheca le tiene in diretta.',
        action: 'Aggiungi alla bacheca',
    },
    widgets: {
        group: 'Widget',
        kind: 'Widget',
        gallery: 'Apri la galleria',
        galleryHint: 'Tutti i widget, con anteprima dal vivo',
        addHint: 'Solo tu vedi le tue bacheche',
        widthOne: 'Una scheda',
        widthTwo: 'Due schede',
        moveEarlier: 'Sposta prima',
        moveLater: 'Sposta dopo',
        remove: 'Rimuovi dalla bacheca',
        menuA11y: ({ widget }) => `Opzioni di ${widget}`,
        arrived: ({ count }) => (count === 1 ? 'È appena arrivato 1 widget' : `Sono appena arrivati ${count} widget`),
        undo: 'Annulla',
        dismiss: 'Ignora',
    },
    saveFailed: {
        tooLarge: 'Questa bacheca supera il limite di archiviazione delle bacheche. Rimuovi qualche elemento e riprova.',
        notFound: 'Questa bacheca è stata eliminata su un altro dispositivo.',
        generic: 'La tua modifica non è arrivata al tuo account, quindi la bacheca è rimasta com\'era.',
        retry: 'Riprova',
        dismiss: 'Chiudi',
        createTitle: 'Questa bacheca non è stata creata',
    },
};

const boardsTranslations = { it };

return { boardsTranslations };
})();

const Domain_browserPresenceTranslations = (() => {
type AgentParams = Shared_browserPresenceTranslations.AgentParams;

type BrowserPresenceTranslations = Shared_browserPresenceTranslations.BrowserPresenceTranslations;

const browserPresenceTranslations = { it: {
        agentFallbackName: 'L’agente',
        agentBrowsing: ({ agent }) => `${agent} sta navigando`,
        clickTarget: ({ target }) => `Fa clic su «${target}»`,
        doing: {
            click: 'Fa clic sulla pagina',
            type: 'Sta scrivendo',
            fill: 'Compila un campo',
            scroll: 'Scorre',
            navigate: 'Apre una pagina',
            history: 'Si muove nella cronologia',
            reload: 'Ricarica la pagina',
            press: 'Preme un tasto',
            select: 'Sceglie un’opzione',
            drag: 'Trascina',
            upload: 'Carica un file',
            look: 'Guarda la pagina',
            other: 'Lavora nella pagina',
        },
        takeControl: 'Prendi il controllo',
        stopping: ({ agent }) => `Arresto di ${agent}…`,
        stoppingDetail: 'Termina la sua ultima azione',
        lastActionMayHaveLanded: ({ agent }) => `L’ultima azione di ${agent} potrebbe essere andata a segno`,
        youHaveControl: 'Hai il controllo',
        stopUnconfirmed: 'Impossibile confermare l’arresto',
        checkAgain: 'Controlla di nuovo',
        pausedUntilHandBack: ({ agent }) => `${agent} è in pausa finché non restituisci il controllo`,
        handBack: 'Restituisci',
        stream: {
            connectingTitle: ({ agent }) => `Connessione al browser di ${agent}`,
            connectingBody: ({ machine }) => `Viene eseguito su ${machine}. La pagina compare qui appena arriva il primo fotogramma.`,
            stalled: 'Ultimo fotogramma · riconnessione',
            endedTitle: ({ agent }) => `${agent} ha chiuso questo browser`,
            endedBody: 'La pagina non viene più mostrata qui.',
            openPageHere: "Apri la pagina qui",
            unavailableTitle: ({ agent }) => `Impossibile mostrare qui il browser di ${agent}`,
            unavailableBody: ({ agent }) => `${agent} continua a navigare; le sue azioni compaiono ancora nella chat.`,
            tryAgain: 'Riprova',
            inputA11y: 'La pagina. Tocca, scorri o scrivi per prendere il controllo.',
        },
        recording: {
            elapsedA11y: ({ elapsed }) => `Registrazione, ${elapsed}`,
            discard: 'Scarta registrazione',
        },
        openInYourBrowser: 'Apri nel tuo browser',
        slowPage: 'Questa pagina ci sta mettendo un po’',
        confidentialHeld: ({ agent }) => `Inserimento privato qui · nascosto a ${agent} finché la pagina non viene chiusa`,
        closePage: 'Chiudi pagina',
    } } satisfies Pick<Record<string, BrowserPresenceTranslations>, "it">;

return { browserPresenceTranslations };
})();

const Domain_browserToolTranslations = (() => {
type TargetParams = Shared_browserToolTranslations.TargetParams;

type BrowserToolTranslations = Shared_browserToolTranslations.BrowserToolTranslations;

const browserToolTranslations = { it: {
        opened: ({ page }) => `Ha aperto ${page}`,
        openedPage: 'Ha aperto una pagina',
        reloaded: 'Ha ricaricato la pagina',
        wentBack: 'È tornato indietro',
        wentForward: 'È andato avanti',
        clicked: ({ target }) => `Ha fatto clic su ${target}`,
        clickedPage: 'Ha fatto clic sulla pagina',
        typedInto: ({ target }) => `Ha scritto in ${target}`,
        typed: 'Ha scritto nella pagina',
        filledIn: ({ target }) => `Ha compilato ${target}`,
        filled: 'Ha compilato un campo',
        pressed: ({ key }) => `Ha premuto ${key}`,
        pressedKey: 'Ha premuto un tasto',
        scrolled: 'Ha scorso la pagina',
        pointedAt: ({ target }) => `Ha indicato ${target}`,
        pointed: 'Ha indicato la pagina',
        choseIn: ({ target }) => `Ha scelto un’opzione in ${target}`,
        chose: 'Ha scelto un’opzione',
        uploadedTo: ({ target }) => `Ha caricato un file in ${target}`,
        uploaded: 'Ha caricato un file',
        dragged: ({ target }) => `Ha trascinato ${target}`,
        draggedPage: 'Ha trascinato nella pagina',
        looked: 'Ha guardato la pagina',
        screenshot: 'Ha fatto uno screenshot',
        recordingStarted: 'Ha iniziato a registrare la pagina',
        recordingStopped: 'Ha interrotto la registrazione',
        other: 'Ha usato il browser',
        watch: 'Guarda',
        watchA11y: 'Apri questa pagina nel browser',
    } } satisfies Pick<Record<string, BrowserToolTranslations>, "it">;

return { browserToolTranslations };
})();

const Domain_changedFileEvidenceTranslations = (() => {
type ChangedFileEvidenceTranslations = Shared_changedFileEvidenceTranslations.ChangedFileEvidenceTranslations;

const en = Shared_changedFileEvidenceTranslations.en;

const translated = Shared_changedFileEvidenceTranslations.translated;

const changedFileEvidenceTranslations = { it: {
        changedFileEvidence: translated({
            before: 'Prima',
            after: 'Dopo',
            binary: 'File binario',
            truncated: 'Il contenuto della prova è stato limitato; la dimensione originale e le statistiche delle modifiche vengono conservate quando disponibili.',
            truncatedOldBytes: ({ count }) => `Contenuto originale prima: ${count} byte`,
            truncatedNewBytes: ({ count }) => `Contenuto originale dopo: ${count} byte`,
            truncatedDiffBytes: ({ count }) => `Diff originale: ${count} byte`,
            truncatedAddedLines: ({ count }) => `Righe aggiunte: ${count}`,
            truncatedRemovedLines: ({ count }) => `Righe rimosse: ${count}`,
            kind: {
                added: 'Aggiunto',
                modified: 'Modificato',
                deleted: 'Eliminato',
                renamed: 'Rinominato',
                copied: 'Copiato',
                unknown: 'Tipo di modifica non disponibile',
            },
            howDetermined: 'Come è stato determinato',
            howDeterminedForFile: ({ path }) => `Come è stato determinato ${path}`,
            content: {
                exact: 'Modifica esatta del repository',
                strong: 'Prova di contenuto solida',
                best_effort: 'Prova di contenuto approssimativa',
            },
            attribution: {
                session_exact: 'Collegato a questa sessione',
                session_likely: 'Probabilmente modificato da questa sessione',
                session_possible: 'Forse modificato da questa sessione',
                unknown: 'Attribuzione della sessione non disponibile',
            },
            reason: {
                provider_correlated: 'L’agente ha segnalato questa modifica per questo turno.',
                canonical_tool_correlated: 'Uno strumento di diff o patch ha collegato questa modifica a questo turno.',
                checkpoint_no_happier_overlap_observed: 'Il checkpoint non ha registrato alcun turno Happier sovrapposto in questo processo.',
                checkpoint_overlap_observed: 'Un altro turno Happier si è sovrapposto all’intervallo di acquisizione del checkpoint.',
                workspace_touched_path: 'Questo percorso è stato toccato nel workspace; questo non identifica la sessione che lo ha modificato.',
                unavailable: 'Le prove non stabiliscono quale sessione abbia fatto questa modifica.',
            },
            overlap: {
                observed: 'Un altro turno Happier si è sovrapposto a questo checkout durante l’acquisizione. Le osservazioni coprono solo questo processo; altri processi e scrittori esterni non vengono tracciati.',
                not_observed: 'In questo processo non è stato osservato alcun turno Happier sovrapposto. Altri processi e scrittori esterni non vengono tracciati; questo non stabilisce una paternità esclusiva.',
                unknown: 'La sovrapposizione del checkpoint è sconosciuta. Altri processi e scrittori esterni non vengono tracciati.',
            },
            sources: {
                provider_native: 'Rapporto di modifiche nativo dell’agente',
                provider_tool: 'Rapporto di uno strumento dell’agente',
                canonical_diff_tool: 'Prova di uno strumento di diff',
                canonical_patch_tool: 'Prova di uno strumento di patch',
                scm_checkpoint: 'Checkpoint del repository',
                scm_reconciled: 'Snapshot riconciliato del repository',
                inferred: 'Percorso toccato nel workspace',
            },
        }),
    } } as const;

return { changedFileEvidenceTranslations };
})();

const Domain_cliPathExposureTranslations = (() => {
const en = Shared_cliPathExposureTranslations.en;

const it = {
    title: 'Riga di comando',
    footer: 'Happier Desktop aggiunge o rimuove solo le voci PATH che ha creato. Le voci scritte dall’installer della shell restano intatte.',
    addTitle: 'Aggiungi happier al PATH',
    addSubtitle: 'Rendi il comando happier disponibile nei nuovi terminali.',
    removeTitle: 'Rimuovi happier dal PATH',
    removeSubtitle: 'Rimuove solo le voci PATH aggiunte da Happier Desktop.',
    working: 'Aggiornamento del profilo della shell…',
    added: 'Aggiunto. Apri un nuovo terminale per usare happier.',
    alreadyPresent: 'happier è già nel tuo PATH.',
    removed: 'Le voci PATH aggiunte da Happier Desktop sono state rimosse.',
    nothingToRemove: 'Happier Desktop non ha aggiunto nessuna voce PATH.',
};

const cliPathExposureTranslations = { it: it };

return { cliPathExposureTranslations };
})();

const Domain_cliTrustPromptTranslations = (() => {
const en = Shared_cliTrustPromptTranslations.en;

const it = {
    title: 'Approvare questa riga di comando?',
    body: ({ command }: { command: string }) => `Happier non ha installato la riga di comando in ${command}. Approvarla le consente di leggere e scrivere le sessioni di questo account. Approva solo quella che hai messo tu.`,
    bodyUnknownCommand: 'Happier non ha installato questa riga di comando. Approvarla le consente di leggere e scrivere le sessioni di questo account. Approva solo quella che hai messo tu.',
    approve: 'Approva',
};

const cliTrustPromptTranslations = { it: it };

return { cliTrustPromptTranslations };
})();

const Domain_commitProposalTranslations = (() => {
type Count = Shared_commitProposalTranslations.Count;

type CommitProposalCopy = Shared_commitProposalTranslations.CommitProposalCopy;

const en = Shared_commitProposalTranslations.en;

const commitProposalTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', { commitProposal: CommitProposalCopy }>>, "it"> = { it: { commitProposal: {
        title: ({ count }) => (count === 1 ? 'Un commit per le tue modifiche in sospeso' : `${count} commit per le tue modifiche in sospeso`),
        titlePhone: ({ count }) => (count === 1 ? 'Un commit' : `${count} commit`),
        proposedBy: ({ who, committed, total }) => `Proposto da ${who} · ${committed} di ${total} file · ordinati perché ogni commit parta dal precedente.`,
        proposedByPhone: ({ committed, total }) => `${committed} di ${total} file in sospeso · tocca una modifica per spostarla.`,
        moveHint: ({ max }) => `Sposta qualsiasi modifica con ⌥1–${max} o dal suo menu.`,
        modelFallback: 'il modello',
        regenerate: 'Rigenera',
        conflict: 'La proposta è cambiata altrove. Questa è la più recente; ripeti la modifica.',
        approvalPending: 'In attesa di approvazione per creare questi commit.',
        discardBody: 'La proposta viene rimossa. Le modifiche in sospeso restano come sono.', askFix: ({ hook, number, message }) => `L’hook ${hook} ha fermato il commit ${number}, «${message}». Correggi ciò che segnala perché il commit possa passare:`, askFixGeneric: ({ number, message }) => `Un hook ha fermato il commit ${number}, «${message}». Correggi ciò che segnala perché il commit possa passare:`, discarded: 'Proposta scartata.', undo: 'Annulla',
        fileCount: ({ count }) => (count === 1 ? '1 file' : `${count} file`),
        part: ({ count, of }) => `${count} di ${of} modifiche`,
        move: { a11y: ({ file }) => `Sposta ${file} in un altro commit`, title: ({ file }) => `Sposta ${file} in`, newCommitAfter: ({ number }) => `Nuovo commit dopo il ${number}`, newCommitMessage: ({ file }) => `Aggiorna ${file}`, leaveOut: 'Lascia fuori da questi commit', leaveOutHint: 'Resta nel tuo albero di lavoro' },
        group: { a11y: ({ number, message }) => `Commit ${number}: ${message}`, editMessage: 'Modifica messaggio', messageA11y: ({ number }) => `Messaggio del commit ${number}`, more: 'Altro', moveUp: 'Sposta su', moveDown: 'Sposta giù', mergeWithNext: 'Unisci al commit successivo', empty: 'Ancora nessuna modifica. Spostane una qui o uniscilo al successivo.' },
        leftOut: { title: 'Lasciate fuori · restano nel tuo albero di lavoro', description: 'Queste modifiche restano in sospeso. Fanne un commit a parte se era tua intenzione.' },
        footer: { commits: ({ count }) => (count === 1 ? '1 commit' : `${count} commit`), onBranch: ({ branch }) => ` su ${branch} · hook e firma funzionano come per ogni commit`, detached: ' su un HEAD scollegato · hook e firma funzionano come per ogni commit', phone: 'Hook e firma come sempre', discard: 'Scarta la proposta', create: ({ count }) => (count === 1 ? 'Crea 1 commit' : `Crea ${count} commit`), createShort: ({ count }) => `Crea ${count}`, emptyGroupReason: 'Un commit non ha modifiche. Spostane una dentro o uniscilo.' },
        applying: { title: ({ count }) => (count === 1 ? 'Creazione di 1 commit' : `Creazione di ${count} commit`), body: 'Uno alla volta tramite il normale percorso di commit, così hook e firma funzionano come sempre. La modifica è in pausa finché non finisce.', bodyPhone: 'La modifica è in pausa finché non finisce.', created: ({ landed, total }) => `${landed} di ${total}`, createdRest: ' creati · nulla viene annullato se uno successivo si ferma', createdRestPhone: ' creati', stopAfterThis: 'Fermati dopo questo commit', stopAfterThisShort: 'Fermati dopo questo', stopping: 'Si fermerà dopo questo commit' },
        state: { waiting: 'In attesa', writing: 'Hook in esecuzione, creazione del commit', landed: 'eseguito', landedAt: ({ time }) => `eseguito alle ${time}`, signed: 'firmato', pausedBy: ({ hook, count }) => `${hook} ha modificato ${count} file · non ancora in commit`, hookFailedBy: ({ hook }) => `${hook} non riuscito · nessun commit`, rewritten: 'un hook ha riscritto il messaggio', notCreated: 'Non creato · ancora modificabile', notCreatedShort: 'Non creato', unknown: 'Non ancora confermato', paused: ({ count }) => (count === 1 ? 'Un hook ha modificato 1 file · non ancora in commit' : `Un hook ha modificato ${count} file · non ancora in commit`), failed: 'Fermato qui · nessun commit' },
        outcome: { signingTitle: 'Al momento i tuoi commit non possono essere firmati.', signingBody: 'Questo repository firma ogni commit. Non è stato fatto alcun commit.', signingHint: 'Prima sblocca il tuo agente GPG o SSH', tryAgain: 'Riprova', cancel: 'Annulla', hookChanged: ({ files }) => `L’hook ha modificato ${files}.`, waitsAfterLanded: ({ count }) => (count === 1 ? 'Il commit 1 è arrivato; questo ti aspetta.' : `${count} commit sono arrivati; questo ti aspetta.`), waits: 'Questo ti aspetta.', include: 'Includi le modifiche dell’hook', includePhone: 'Includi e fai commit', cancelCommit: 'Annulla questo commit', hookFailed: 'Un hook ha fermato questo commit.', hookChangedBy: ({ hook, files }) => `${hook} ha modificato ${files}.`, hookFailedBy: ({ hook }) => `${hook} ha fermato questo commit.`, hookFailedBody: 'I commit precedenti restano. Il resto è ancora modificabile.', headMoved: ({ branch }) => `${branch} si è spostato durante i commit.`, headMovedBody: 'Il commit successivo è stato rifiutato e nulla è stato annullato.', proposeAgain: 'Riproponi ciò che resta', keepEditing: 'Continua a modificare', askSessionToFix: 'Chiedi a questa sessione di correggerlo', showInGit: 'Mostra in Git', unknownTitle: 'Non siamo riusciti a confermare se questo commit è arrivato.', unknownBody: 'Nulla viene ritentato finché non lo sappiamo. Ricontrolla il branch.', checkAgain: 'Ricontrolla', stoppedTitle: ({ landed, total }) => `${landed} di ${total} commit creati`, stoppedBody: ({ count }) => (count === 1 ? 'L’ultimo non è stato creato. Le sue modifiche sono ancora nel tuo albero di lavoro, come prima.' : `${count} non sono stati creati. Le loro modifiche sono ancora nel tuo albero di lavoro, come prima.`), createRest: ({ count }) => (count === 1 ? 'Crea l’ultimo' : `Crea i ${count} rimanenti`), completeTitle: ({ count }) => (count === 1 ? '1 commit creato' : `${count} commit creati`), completeBody: 'Nulla è stato inviato.', onBranch: ({ branch }) => `su ${branch}`, failed: { staging_conflict: 'Qualcos’altro ha cambiato ciò che è in stage.', selection_conflict: 'Queste modifiche non si possono dividere così.', source_changed: 'Le modifiche in sospeso sono cambiate dalla proposta.', writer_failed: 'Impossibile creare il commit.', publication_warning: 'Il commit è arrivato, ma i file in stage non sono stati aggiornati.', cancelled: 'Questo commit è stato annullato.' }, failedBody: 'I commit precedenti restano. Nulla è stato annullato.' },
        none: { title: 'Nessuna proposta di commit', workingTreeOnly: 'I piani di commit possono essere applicati solo alle modifiche locali attuali.', reason: 'Una proposta raggruppa le tue modifiche in sospeso in commit che puoi modificare, poi li crea uno alla volta tramite il normale percorso di commit.', propose: 'Proponi commit', writing: 'Raggruppamento delle modifiche in sospeso…' },
        gitPane: { title: 'Commit proposti', meta: ({ count, files }) => `${count} · ${files} file`, inCommit: ({ count, number }) => `${count} nel commit ${number}`, open: 'Apri', review: 'Rivedi', reviewInWalkthrough: 'Rivedi nel percorso', more: 'Scarta o rigenera', selectedHint: 'Selezionato. Tocca di nuovo per aprirlo in Commit', tapHint: 'Tocca per vederne le modifiche' },
    } } };

return { commitProposalTranslations };
})();

const Domain_committedMessageActionTranslations = (() => {
const committedMessageActionTranslations = { "it": {
        "committedMessageActions": {
            "copy": "Copia",
            "fork": "Crea diramazione",
            "rollback": "Ripristina",
            "pin": "Fissa",
            "savePrompt": "Salva come prompt",
            "plugins": "Azioni dei plugin",
            "composerButton": "Pulsante della libreria di prompt",
            "composerHint": "I tuoi prompt e ciò che hai inviato, accanto alla dettatura. Il menu / offre ancora Prompt… se è disattivato.",
            "name": "Nome",
            "shortcut": "/ scorciatoia",
            "savedOpen": "Salvato nella libreria · Apri",
            "shortcutNotSaved": "Il prompt è stato salvato, ma la scorciatoia no. Aprilo nella libreria per aggiungerne una.",
            "wrongAccount": "Passa al Home di questa sessione prima di salvarne il prompt.",
            "savedHintFavorite": "Va nella tua libreria, con la stella.",
            "savedHint": "Va nella tua libreria.",
            "addShortcut": "Aggiungi una scorciatoia /",
            "shortcutPlaceholder": "/scorciatoia",
            "savedToLibrary": "Salvato nella libreria",
            "savePromptHint": "Riutilizzalo dalla libreria dei prompt",
            "copyHint": "Copia il testo di un messaggio.",
            "forkHint": "Avvia una nuova sessione da un messaggio.",
            "rollbackHint": "Riporta lo spazio di lavoro a com’era prima di un messaggio.",
            "pinHint": "Fissa i messaggi per tornarci. Quelli fissati restano fissati.",
            "savePromptSettingHint": "Conserva un messaggio inviato come prompt della libreria.",
            "pluginsHint": "Azioni che i tuoi plugin aggiungono sotto i messaggi."
        }
    } };

return { committedMessageActionTranslations };
})();

const Domain_computerUseTranslations = (() => {
type MachineParams = Shared_computerUseTranslations.MachineParams;

type ComputerUseTranslations = Shared_computerUseTranslations.ComputerUseTranslations;

const computerUseTranslations = { it: {
        approval: {
            sectionTitle: 'Sul computer',
            act: {
                list: 'Vedere quali finestre sono aperte',
                see: 'Fare uno screenshot',
                read: 'Leggere testo e controlli',
                click: 'Fare clic',
                press: 'Premere un tasto',
                type: 'Scrivere',
                share: 'Condividere una finestra',
            },
            windowOn: ({ machine }) => `Una finestra su ${machine}`,
            screenOf: ({ machine }) => `L’intero schermo di ${machine}`,
            windowsOn: ({ machine }) => `Le finestre aperte su ${machine}`,
            window: 'Una finestra',
            screen: 'L’intero schermo',
            windows: 'Le finestre aperte',
            typedLabel: 'Testo',
            keyLabel: 'Tasto',
            listConsequence: 'Vengono condivisi solo i nomi delle finestre aperte, non il loro contenuto.',
            seeConsequence: 'Gli screenshot vengono condivisi con questa sessione. Niente clic né scrittura.',
            useConsequence: 'L’input che raggiunge il computer non si può annullare. Puoi fermarlo in qualsiasi momento.',
            targetOn: ({ machine, target }) => `${target} su ${machine}`,
            chooseFirst: 'Scegli prima la finestra',
            cropA11y: ({ target }) => `L’ultima immagine di ${target}`,
            suggestsWindow: ({ agent, target }) => `${agent} suggerisce «${target}»`,
        },
        request: {
            title: ({ agent, machine }) => `${agent} vuole usare una finestra su ${machine}`,
            body: 'Scegli tu la finestra. Non viene condiviso nulla finché non lo fai.',
            choose: 'Scegli una finestra',
            change: 'Cambia finestra',
            shared: ({ target }) => `Hai condiviso ${target}`,
            watch: 'Guarda',
        },
        picker: {
            title: ({ agent }) => `Lascia che ${agent} usi una finestra`,
            description: ({ agent }) => `Scegli cosa condividere con ${agent}.`,
            windows: 'Finestre',
            screens: 'Schermo intero',
            untitledWindow: 'Finestra senza titolo',
            screenLabel: ({ index }) => `Schermo ${index}`,
            share: 'Condividi finestra',
            shareScreen: 'Condividi schermo',
            shareApp: ({ app }) => `Condividi la finestra di ${app}`,
            stopSharing: 'Interrompi condivisione',
            loadingTitle: ({ machine }) => `Cerco le finestre su ${machine}`,
            noScreenTitle: ({ machine }) => `${machine} non ha uno schermo da condividere`,
            noScreenBody: 'Funziona senza un desktop che Happier possa vedere. Usa una macchina con uno schermo.',
            unsupportedTitle: ({ machine }) => `Happier non può ancora usare lo schermo di ${machine}`,
            unsupportedBody: 'Per ora la condivisione di una finestra funziona sui desktop Linux.',
            failedTitle: ({ machine }) => `Impossibile elencare le finestre di ${machine}`,
            failedBody: 'Controlla che Happier sia in esecuzione lì, poi riprova.',
            emptyTitle: ({ machine }) => `Nessuna finestra aperta su ${machine}`,
            emptyBody: 'Apri la finestra da condividere, poi controlla di nuovo.',
            tryAgain: 'Riprova',
            inUse: 'Un’altra sessione sta usando questa finestra. Scegline un’altra.',
            closed: 'La finestra è stata chiusa. Scegline un’altra.',
            selectFailed: 'Impossibile condividere la finestra. Riprova.',
            otherMachineTitle: ({ machine }) => `${machine} non è la macchina di questa sessione`,
            otherMachineBody: 'Le finestre si possono condividere solo sulla macchina su cui gira questa sessione.',
            purpose: ({ session }) => `Per «${session}».`,
            purposeIn: ({ project, session }) => `Per «${session}» in ${project}.`,
            access: ({ agent }) => `${agent} può`,
            accessValue: 'Vederla e usarla',
            accessSee: 'Solo vedere',
            displayUnavailable: 'Non è possibile condividere l’intero schermo di questo computer.',
            wholeDisplayBody: ({ display }) => `Tutto ciò che è visibile su ${display} può essere visto, incluse altre app e notifiche.`,
            policyBoth: ({ agent }) => `${agent} chiede prima di ogni screenshot, clic e tasto.`,
            policyInput: ({ agent }) => `${agent} chiede prima di ogni clic e tasto.`,
            policyCapture: ({ agent }) => `${agent} chiede prima di ogni screenshot.`,
            policyNone: ({ agent }) => `${agent} non chiede prima di screenshot, clic o tasti.`,
            policyChange: 'Cambia',
            suggests: ({ agent }) => `${agent} suggerisce`,
            usingIt: 'l’agente lo sta usando',
            displayShared: 'tutto ciò che contiene è condiviso',
            refresh: 'Aggiorna sorgenti',
            footnote: 'Per elencare le finestre ti viene chiesto prima; condividere un intero schermo lo richiede di nuovo.',
            wholeDisplayTitle: 'Condividere l’intero schermo?',
            allowSee: 'Consenti la visione',
            allowUse: 'Consenti mouse e tastiera',
            allowUseHint: ({ agent }) => `${agent} può usare questo schermo. Puoi riprendere il controllo in qualsiasi momento.`,
            shareDisplay: 'Condividi schermo',
        },
        permission: {
            input: 'Accessibilità',
            denied: 'Non consentito',
            opened: ({ machine }) => `Aperto su ${machine}. Consenti Happier lì, poi controlla di nuovo.`,
            openFailed: 'Impossibile aprire Impostazioni di Sistema lì. Aprile su quel computer.',
            checkAgain: 'Controlla di nuovo',
            captureTitle: ({ machine }) => `Consenti la registrazione dello schermo su ${machine} per guardarne le finestre o lo schermo.`,
            inputTitle: ({ machine }) => `Consenti l’accessibilità su ${machine} per usarne mouse e tastiera.`,
            unknownTitle: ({ machine }) => `Impossibile verificare i permessi dello schermo su ${machine}. Ricontrolla prima di condividere.`,
            separateBody: ({ machine }) => `L’accessibilità è separata: ti permette di usare lì mouse e tastiera. Ognuna si concede su ${machine}, non su questo dispositivo.`,
            onMachineBody: ({ machine }) => `Si concede su ${machine}, non su questo dispositivo.`,
            openPrivacy: ({ machine }) => `Apri le impostazioni sulla privacy su ${machine}`,
        },
        viewer: {
            agentUsing: ({ agent, target }) => `${agent} sta usando ${target}`,
            agentCanUse: ({ agent, target }) => `${agent} può usare ${target}`,
            agentCanSee: ({ agent, target }) => `${agent} può vedere ${target}`,
            onMachine: ({ machine }) => `Su ${machine}`,
            connectingTitle: ({ target }) => `Connessione a ${target}`,
            unavailableTitle: 'Impossibile mostrare questa finestra ora',
            unavailableBody: ({ agent }) => `Puoi comunque fermare ${agent} da qui.`,
            endedTitle: ({ target }) => `${target} è stata chiusa`,
            endedBody: ({ agent }) => `${agent} non può più vederla né usarla. Scegli un’altra finestra per continuare.`,
            stalled: 'Ultima immagine · riconnessione',
            inputA11y: ({ target }) => `${target}, dal vivo. Fai clic o scrivi per prendere il controllo.`,
            notSharedTitle: 'Nessuna finestra condivisa',
            notSharedBody: ({ agent }) => `Scegli una finestra che ${agent} possa usare.`,
            moreA11y: 'Opzioni della finestra',
            tabFallback: 'Computer',
            sourceComputer: 'Computer',
            sourceBrowser: 'Browser',
            sourceA11y: 'Origine',
            watchingA11y: ({ source, machine }) => `Guardi ${source} su ${machine}`,
            expandView: 'Espandi vista',
            restoreView: 'Ripristina vista',
            dockView: 'Aggancia vista',
            closeView: 'Chiudi vista',
            moveView: 'Sposta vista',
            resizeView: 'Ridimensiona vista',
            moveTopLeft: 'Sposta in alto a sinistra',
            moveTopRight: 'Sposta in alto a destra',
            moveBottomLeft: 'Sposta in basso a sinistra',
            moveBottomRight: 'Sposta in basso a destra',
            larger: 'Più grande',
            smaller: 'Più piccola',
            viewOptions: 'Opzioni vista',
            presentedElsewhereTitle: 'Mostrata nella vista mobile',
            presentedElsewhereBody: 'Agganciala qui per tenerla accanto al tuo lavoro.',
            closeHint: 'Chiude questa vista. La sessione continua.',
            agentWorkingOn: ({ agent, machine }) => `${agent} sta lavorando su ${machine}`,
            watchingSourceA11y: ({ source }) => `Stai guardando ${source}`,
            controlNotAllowed: 'Il controllo di mouse e tastiera non è consentito',
            paused: ({ time }) => `Streaming in pausa · ultimo fotogramma ${time}`,
            offlineTitle: ({ machine }) => `${machine} non risponde`,
            offlineBody: 'Riconnettila per guardarla. Guardare non la avvia.',
            openingTitle: ({ target, machine }) => `Apertura di ${target} su ${machine}…`,
        },
        strip: {
            using: ({ target }) => `Usa ${target}`,
            on: ({ machine }) => `su ${machine}`,
            stop: 'Ferma',
            paused: ({ agent }) => `${agent} è in pausa`,
            pausedDetail: ({ target }) => `Hai il controllo di ${target}`,
        },
        tool: {
            capture: 'Ha fatto uno screenshot',
            captureRunning: 'Sta facendo uno screenshot',
            query: 'Ha letto testo e controlli della finestra',
            queryRunning: 'Sta leggendo la finestra',
            click: 'Ha fatto clic nella finestra',
            clickRunning: 'Sta facendo clic nella finestra',
            clickTarget: ({ target }) => `Ha fatto clic su “${target}”`,
            type: 'Ha scritto nella finestra',
            typeRunning: 'Sta scrivendo nella finestra',
            typeTarget: ({ target }) => `Ha scritto in “${target}”`,
            pressKey: ({ key }) => `Ha premuto ${key}`,
            press: 'Ha premuto un tasto',
            pressRunning: 'Sta premendo un tasto',
            mayHaveLanded: 'potrebbe essere andato a segno',
            failed: 'Non è andato a buon fine',
        },
    } } satisfies Pick<Record<string, ComputerUseTranslations>, "it">;

return { computerUseTranslations };
})();

const Domain_connectedServicesCollectionTranslations = (() => {
type ConnectedServicesCollectionCopy = Shared_connectedServicesCollectionTranslations.ConnectedServicesCollectionCopy;

const en = Shared_connectedServicesCollectionTranslations.en;

const it: ConnectedServicesCollectionCopy = {
    accountLabel: ({ service }) => `Account ${service}`,
    accountLabelNumbered: ({ service, number }) => `Account ${service} ${number}`,
    meterResetsIn: ({ time }) => `tra ${time}`,
    meterNextResetIn: ({ time }) => `il prossimo tra ${time}`,
    meterResetsAt: ({ countdown, time }) => `${countdown} · ${time}`,
    meterNotReported: 'Non riportato',
    meterEstimated: ({ value }) => `~${value}`,
    indexTitle: 'Tutti i servizi',
    indexDescription: 'Gli account con cui accedono i tuoi agenti e quanto resta a ciascuno.',
    viewList: 'Elenco',
    viewGrid: 'Griglia',
    viewLabel: 'Mostra gli account come',
    refreshAll: 'Aggiorna tutto',
    refreshUsage: 'Aggiorna l’utilizzo',
    signedOutConsequence: 'Le sessioni non possono usarlo finché non accedi di nuovo.',
    poolsGroup: 'Pool',
    poolsDescription: 'Account tra cui un agente alterna. Il pool ne sceglie uno all’avvio di una sessione e passa al successivo quando si esaurisce.',
    newPool: 'Nuovo pool',
    poolUsing: ({ account }) => `Usa ${account}`,
    poolPosition: ({ position, count }) => position === 1 ? `Primo di ${count}` : `${position} di ${count}`,
    poolInUseNow: 'in uso ora',
    inUse: 'In uso',
    connectService: 'Collega un servizio',
    searchAccounts: 'Cerca account',
    servicesGroup: 'Servizi',
    railEmpty: 'Ancora nessun account',
    railKey: 'chiave',
    railAccountLabel: ({ service, account }) => `${service} · ${account}`,
    agentSignInTitle: 'Come accedono gli agenti',
    subscriptionTitle: 'Abbonamento',
    subscriptionNone: 'Nessun abbonamento',
    subscriptionRenewsIn: ({ days }) => days === 0 ? 'Si rinnova oggi' : days === 1 ? 'Si rinnova domani' : `Si rinnova tra ${days} giorni`,
    subscriptionEndsIn: ({ days }) => days === 0 ? 'Non si rinnova · termina oggi' : `Non si rinnova · termina tra ${days} giorni`,
    subscriptionPeriodEndsIn: ({ days }) => days === 0 ? 'Il periodo termina oggi' : `Il periodo termina tra ${days} giorni`,
    subscriptionRenewsOn: ({ date, days }) => `Si rinnova il ${date} · tra ${days} giorni`,
    subscriptionEndsOn: ({ date, days }) => `Non si rinnova · termina il ${date}, tra ${days} giorni. Poi le sessioni smetteranno di usarlo.`,
    subscriptionPeriodEndsOn: ({ date, days }) => `Il periodo termina il ${date} · tra ${days} giorni`,
    renewalOn: 'Attivo',
    renewalOff: 'Disattivo',
    renewalUnknown: 'Sconosciuto',
    checkedAt: ({ time }) => `Controllato ${time}`,
    checkedMayBeOutOfDate: ({ time }) => `Controllato ${time} · potrebbe non essere aggiornato`,
    usageCheckedMayBeOutOfDate: ({ time }) => `Controllato ${time} · potrebbe non essere aggiornato`,
    daysAgo: ({ count }) => count === 1 ? '1 giorno fa' : `${count} giorni fa`,
    hoursAgo: ({ count }) => count === 1 ? '1 ora fa' : `${count} ore fa`,
    usageResetsCount: ({ count }) => count === 1 ? '1 reset di utilizzo' : `${count} reset di utilizzo`,
    usageResetsFirstExpires: ({ date }) => `il primo scade ${date}`,
    usageResetExpires: ({ date }) => `scade ${date}`,
    useOne: 'Usane uno',
    useOneReset: 'Usa un reset di utilizzo',
    usageResetsTitle: 'Reset di utilizzo',
    usageResetsDescription: 'Ognuno avvia subito una nuova finestra. Tienili per quando un limite ti blocca; quelli non usati scadono.',
    usageResetTitle: 'Reset di utilizzo',
    usageResetExpiresOn: ({ date }) => `Scade il ${date}`,
    use: 'Usa',
    usedByDefault: 'Predefinito · le nuove sessioni usano questo account',
    accountIdFact: ({ id }) => `ID ${id}`,
    hideIdentitiesTitle: 'Nascondi email e ID degli account',
    hideIdentitiesDescription: 'Per streaming e demo. Maschera email e ID degli account ovunque su questo dispositivo; i nomi che hai dato agli account restano.',
    privacyTitle: 'Privacy',
    renameTitle: 'Dai un nome a questo account',
    renameBody: ({ service }) => `Cambia solo il nome in Happier. ${service} mantiene il proprio nome per l’account.`,
    identityHidden: 'Email o ID nascosti',
};

const connectedServicesCollectionTranslations = { it };

return { connectedServicesCollectionTranslations };
})();

const Domain_connectedServicesPoolTranslations = (() => {
type ConnectedServicesPoolCopy = Shared_connectedServicesPoolTranslations.ConnectedServicesPoolCopy;

const en = Shared_connectedServicesPoolTranslations.en;

const it: ConnectedServicesPoolCopy = {
    strategyExpiryFirst: "Scade prima",
    strategyExpiryFirstDescription: "Preferisci una quota sufficiente con un ripristino del periodo lungo o una scadenza dell’abbonamento senza rinnovo più vicini.",
    leadExpiryFirst: "Prima ciò che scade prima.",
    membersOn: ({ service, on, total }) => `${service} · ${on} di ${total} membri attivi`,
    rename: 'Rinomina',
    moreActions: 'Altre azioni',
    defaultFor: ({ agent }) => `Predefinito per ${agent}`,
    defaultForMore: ({ agent, count }) => `Predefinito per ${agent} +${count}`,
    makeDefault: 'Rendi predefinito',
    makeDefaultA11y: 'Rendilo predefinito per un agente',
    usingSince: ({ name, time }) => `In uso ${name} dalle ${time}`,
    using: ({ name }) => `In uso ${name}`,
    noActive: 'Nessun membro ancora in uso',
    noActiveDetail: 'Il gruppo ne sceglie uno quando inizia una sessione.',
    leadLeastLimited: 'Prima il meno limitato.',
    leadInOrder: 'In ordine.',
    fallbackOff: ({ name }) => `Il cambio automatico è disattivato: le sessioni restano su ${name} quando si esaurisce.`,
    manualStays: ({ name }) => `Manuale: il gruppo resta su ${name} finché non scegli un altro membro.`,
    switchTo: ({ name }) => `Passa a ${name}`,
    onlyOneOn: ({ name }) => `Solo ${name} è attivo, quindi non c'è alternativa.`,
    turnOn: ({ name }) => `Attiva ${name}`,
    allWaitingTitle: 'Tutti i membri attendono un ripristino',
    allWaitingFirst: ({ name, time, countdown }) => `${name} si ripristina per primo, alle ${time} (${countdown}).`,
    sessionsWait: 'Le sessioni attendono, poi riprendono da sole.',
    sessionsStop: 'Le sessioni si fermano finché un membro non ha margine.',
    leftTitle: 'Rimanente nel gruppo',
    leftDescription: 'La media dei membri attivi; ognuno si ripristina per conto suo.',
    roomCount: ({ count, total }) => `${count} di ${total} hanno margine ora`,
    notReported: ({ count }) => count === 1 ? '1 senza dati' : `${count} senza dati`,
    nothingReported: 'Nessun membro attivo segnala ancora i suoi limiti.',
    membersTitle: 'Membri',
    membersDescription: "Trascina per impostare l'ordine. Il membro selezionato è quello attivo; un membro disattivato viene saltato.",
    membersCompactDescription: 'Tieni premuto e trascina per riordinare.',
    manage: 'Gestisci',
    connectAnotherAccount: ({ service }) => `Collega un altro account ${service}`,
    membersSelectionSummary: ({ count, total, service }) => `${count} di ${total} account ${service}`,
    manageMembers: 'Gestisci membri',
    searchAccounts: ({ service }) => `Cerca account ${service}`,
    active: 'Attivo',
    offNotUsed: 'Non usato dal gruppo mentre è disattivato',
    autoOffModel: 'Disattivato automaticamente · questo piano non può usare il modello scelto',
    checkedAt: ({ time }) => `Controllato ${time}`,
    makeActiveA11y: ({ name }) => `Rendi ${name} il membro attivo`,
    memberOnA11y: ({ name }) => `Usa ${name} in questo gruppo`,
    openA11y: ({ name }) => `Apri ${name}`,
    dragA11y: 'Trascina per riordinare',
    behaviorTitle: 'Comportamento',
    strategyTitle: 'Strategia di selezione',
    strategyLeastLimited: 'Meno limitato',
    strategyInOrder: 'In ordine',
    strategyManual: 'Manuale',
    strategyLeastLimitedDescription: 'Preferisci il membro con più quota utilizzabile.',
    strategyInOrderDescription: "Prova i membri nell'ordine sopra.",
    strategyManualDescription: 'Usa solo il membro attivo finché non lo cambi.',
    fallbackTitle: 'Cambio automatico',
    fallbackDescription: "Passa a un altro membro quando l'account attivo deve essere ripristinato.",
    switchEarlyTitle: 'Cambia prima',
    switchEarlyDescription: 'Percentuale rimanente sotto la quale il gruppo passa a un membro con quota più fresca. 0 lo disattiva.',
    autoResetsTitle: 'Usa automaticamente i ripristini di quota',
    autoResetsDescription: 'Spendi un ripristino accantonato solo quando nessun membro è pronto.',
    autoOffTitle: 'Disattiva gli account che non possono usare il modello scelto',
    autoOffDescription: 'Puoi riattivarli tu.',
    advancedTitle: 'Avanzate',
    advancedCount: ({ count }) => `${count} impostazioni`,
    restoreFirstTitle: 'Torna al primo membro quando si ripristina',
    restoreFirstDescription: 'Dopo un cambio, torna al membro messo per primo quando il suo limite si ripristina.',
    switchWhenTitle: 'Cambia quando',
    switchWhenDescription: 'Eventi che spostano il gruppo al membro successivo.',
    staleAfterTitle: "Controlla l'uso vecchio dopo",
    staleAfterDescription: "Minuti. Richiedi di nuovo al provider quando l'uso è più vecchio di così prima di scegliere un membro.",
    switchesPerTurnTitle: 'Cambi automatici per turno',
    switchesPerHourTitle: 'Cambi automatici per ora di sessione',
    switchLimitsDescription: 'Evita che un gruppo rimbalzi tra i membri.',
    recoveryTitle: 'Quando un limite ferma una sessione',
    recoveryDescription: 'Cosa fa il gruppo per la sessione in attesa.',
    recoveryPromptsTitle: 'Messaggi di ripresa',
    recoveryPromptsDescription: 'Happier invia il suo messaggio standard quando riprende una sessione dopo un cambio o un ripristino.',
    usedByTitle: 'Usato da',
    usedByDefault: 'Predefinito · le nuove sessioni accedono tramite questo gruppo',
    usedByNone: 'Nessun agente accede ancora tramite questo gruppo per impostazione predefinita.',
    deleteNote: ({ agents }) => `I membri restano collegati. ${agents} torna al proprio accesso finché non scegli un altro predefinito.`,
    deleteNoteNoAgent: 'I membri restano collegati.',
    emptyTitle: 'Aggiungi gli account tra cui passare',
    emptyReason: ({ service }) => `Un gruppo sceglie un account quando inizia una sessione e cambia quando si esaurisce. Aggiungi almeno due account ${service}.`,
    usageNotAnswering: ({ service }) => `${service} non ha risposto`,
    newPoolTitle: 'Nuovo gruppo',
    newPoolDescription: ({ service }) => `Account ${service} tra cui un agente passa.`,
    nameTitle: 'Nome',
    namePlaceholder: 'Gruppo lavoro',
    draftMembersDescription: 'Scegli gli account tra cui passare. Puoi cambiarli in seguito.',
    create: 'Crea gruppo',
    discard: 'Scarta',
};

const connectedServicesPoolTranslations = { it };

return { connectedServicesPoolTranslations };
})();

const Domain_connectedServicesSettingsTranslations = (() => {
type ConnectedServicesSettingsCopy = Shared_connectedServicesSettingsTranslations.ConnectedServicesSettingsCopy;

const setupFidelityCopy = Shared_connectedServicesSettingsTranslations.setupFidelityCopy;

const en = Shared_connectedServicesSettingsTranslations.en;

const it: ConnectedServicesSettingsCopy = {
    ...setupFidelityCopy,
    accountCount: ({ count }) => count === 1 ? '1 account' : `${count} account`,
    defaultAccount: ({ name }) => `Predefinito: ${name}`,
    poolCount: ({ count }) => count === 1 ? '1 pool' : `${count} pool`,
    noAccountsYet: 'Ancora nessun account',
    needsSignIn: 'Accesso richiesto',
    signInAgain: 'Accedi di nuovo',
    addAccount: 'Aggiungi account',
    connectAnotherTitle: 'Collega un altro servizio',
    connectFirstTitle: 'Collega un servizio',
    connectNames: ({ names }) => `${names}.`,
    connectNamesMore: ({ names, count }) => `${names} e altri ${count}.`,
    connect: 'Collega',
    emptyTitle: 'Ancora nessun servizio da collegare',
    servicesTitle: 'Servizi',
    emptyNoServiceOnMachine: ({ machine }: { machine: string }) => `Nessun agente su ${machine} offre ancora un servizio con cui accedere. Gli agenti che usano un abbonamento aggiungono qui il proprio.`,
    emptyNoMachineOnline: 'Nessuna delle tue macchine è online. I servizi compaiono quando una lo è, dagli agenti che esegue.',
    emptyOpenAgents: 'Apri gli agenti',
    emptyAction: 'Apri le macchine',
    projectionErrorTitle: 'Impossibile caricare i servizi dalle tue macchine',
    projectionErrorDescription: 'I tuoi account restano in elenco. I servizi che puoi aggiungere compaiono quando una macchina risponde.',
    loadingServices: 'Ricerca dei servizi sulle tue macchine…',
    usageTitle: 'Come vengono usati gli account',
    usageDescription: 'Con quale account accede ogni agente quando inizia una sessione e cosa condividono le sessioni.',
    sharingTitle: 'Condivisione dello stato',
    sharingSummary: ({ config, state }) => `${config} · ${state}`,
    configLinkedShort: 'Collegata',
    configCopiedShort: 'Copiata',
    configIsolatedShort: 'Isolata',
    stateSharedShort: 'Sessioni condivise',
    stateIsolatedShort: 'Sessioni separate',
    perAgentTitle: 'Condivisione per agente',
    perAgentDescription: 'Sostituisci queste impostazioni per un agente.',
    perAgentPurpose: 'Scegli, per ogni agente, cosa condividono le sessioni degli account collegati con il tuo accesso.',
    servicePurpose: ({ service }) => `Gli account con cui accedi a ${service} e i pool che li condividono.`,
    chooseMachineTitle: 'Scegli una macchina',
    chooseMachineDescription: 'Aggiungere, accedere e rimuovere account avviene su una delle tue macchine. I tuoi account restano elencati in Servizi collegati.',
    newAccountTitle: 'Nuovo account',
    newAccountDescription: 'Scegli come accedere.',
    newAccountInProgress: 'Completa l’accesso qui sotto.',
    modeBrowser: 'Accedi con un browser',
    modeDeviceCode: 'Accedi con un codice',
    modeManual: 'Inserisci un token',
    serviceSettingsTitle: 'Impostazioni del servizio',
    serviceSettingsDescription: 'Impostazioni con cui accede ogni account di questo servizio.',
    noAccountsDescription: 'Aggiungi un account perché i tuoi agenti possano accedere con esso.',
    accountDetailsTitle: 'Dettagli dell’account',
    poolEmptyTitle: 'Aggiungi account a questo pool',
    poolEmptyDescription: 'Un pool sposta le sessioni sull’account successivo quando uno raggiunge il limite. Scegli i suoi account qui sotto.',
    agentDefaultsTitle: 'Account predefinito per agente',
    agentDefaultsDescription: 'L’account con cui ogni agente accede all’avvio di una sessione.',
    agentDefaultsKeywords: 'account predefinito',
    namesAnd: ({ names, last }) => `${names} e ${last}`,
    usedBy: ({ names }) => `Usato da ${names}`,
    poolRuleMostLeft: 'usa quello con più margine',
    poolRuleInOrder: 'li usa in ordine',
    poolRuleManual: 'lo cambi tu',
    poolInUse: ({ pool }) => `${pool} · in uso`,
    agentDefault: ({ agent }) => `Predefinito di ${agent}`,
    signedOutBy: ({ service }) => `Disconnesso da ${service}`,
    usageReadFailed: 'Impossibile leggere l’utilizzo',
    usageWindowPin: ({ meter }: { meter: string }) => `Mostra ${meter} accanto al compositore`,
    noLimitsBilledPerUse: 'Nessun limite segnalato · fatturato a consumo',
    needsYouCount: ({ count }) => count === 1 ? '1 ha bisogno di te' : `${count} hanno bisogno di te`,
    connectToolsTitle: 'Collega un host di codice o uno strumento',
    inviteTitle: ({ names }) => `I tuoi agenti possono usare anche ${names}`,
    inviteWhoOne: ({ agents }) => `${agents} può accedere con esso.`,
    inviteWhoMany: ({ agents }) => `${agents} possono accedere con essi.`,
    inviteTools: 'Oppure collega un host di codice e strumenti.',
    firstRunTitle: 'Usa i piani che già paghi',
    firstRunPromise: 'Collega una volta il tuo account Claude o ChatGPT. I tuoi agenti lo usano su ogni macchina e Happier mostra quanto resta prima del limite.',
    connectAnAccount: 'Collega un account',
    firstRunMeanwhile: 'Nel frattempo ogni agente usa il proprio accesso su ogni macchina.',
    agentAccountsTitle: 'Account degli agenti',
    agentAccountsDescription: 'Abbonamenti e chiavi usati dai tuoi agenti. Salvati nel tuo account, così ogni macchina può usarli.',
    codeAndToolsTitle: 'Codice e strumenti',
    setupChooseMachine: 'Scegli una macchina su cui accedere. Poi l’account funziona su tutte le tue macchine.',
    setupHowToSignIn: 'Come accedere',
    setupRecommendedMethod: ({ method }) => `${method} · Consigliato`,
    setupCatalogTitle: 'Collega un servizio',
    setupCatalogPurpose: 'L’accesso avviene sulla macchina che scegli. Poi l’account funziona su tutte le tue macchine.',
    setupServiceTitle: ({ service }) => `Collega ${service}`,
    setupReconnectTitle: ({ service }) => `Accedi di nuovo a ${service}`,
    setupServicePurpose: ({ agents, service }) => `${agents} useranno il tuo account ${service} su ogni macchina.`,
    setupServicePurposeNoAgents: 'L’account funziona su ogni macchina.',
    setupForYourAgents: 'Per i tuoi agenti',
    setupOwnLoginTitle: 'Hai già effettuato l’accesso su una macchina?',
    setupOwnLoginBody: 'Continua a usare l’accesso dell’agente. Sceglilo in Come vengono usati gli account.',
    setupToolsTitle: 'Host di codice e strumenti',
    setupProvidersPointer: 'I provider di modelli come OpenRouter e Ollama si configurano in Provider.',
    setupOpenProviders: 'Apri Provider',
    setupTrust: 'Salvato nel tuo account e usato solo dalle tue macchine. Happier mantiene l’accesso aggiornato per te.',
    setupConnectedCount: ({ count }) => `${count} collegati`,
    settleConnectedAs: ({ identity }) => `Collegato ora come ${identity}.`,
    settleConnected: 'Collegato ora.',
    settleUseFor: ({ agent }) => `Usarlo per ${agent}?`,
    settleUseForAction: ({ agent }) => `Usa per ${agent}`,
    notNow: 'Non ora',
    homeInvitePromise: 'Collega Claude o ChatGPT una volta. Ogni macchina può usarlo e qui vedrai quanto resta.',
    homeInviteHide: 'Nascondi',
    homeNextWho: ({ agents }) => `Anche ${agents} può usarlo`,
    oauthStepOpen: 'Apri la pagina di accesso nel browser',
    oauthStepApprove: 'Approva, poi copia il codice mostrato (o l’indirizzo della pagina finale)',
    oauthStepPaste: 'Incollalo qui',
    oauthPastePlaceholder: 'Incolla il codice o l’indirizzo',
    oauthShapeOk: 'Sembra un codice di accesso',
    deviceEnterAt: ({ where }) => `Inserisci questo codice su ${where}`,
    deviceExpired: 'Il codice è scaduto. Non è stato salvato nulla.',
    deviceExpiresIn: ({ time }) => `Il codice scade tra ${time}`,
    deviceNewCode: 'Ottieni un nuovo codice',
    detailSignedOutTitle: ({ service }) => `${service} ha disconnesso questo account`,
    detailSignedOutBody: 'L’accesso è stato revocato o modificato, ad esempio dopo un cambio password. Le sessioni non possono usare l’account finché non accedi di nuovo.',
    detailSignInTitle: 'Accesso',
    detailSignInNeeded: 'Serve un nuovo accesso',
    detailSignInKeptFresh: 'Happier la mantiene aggiornata',
    detailLastUsed: ({ time }) => `ultimo uso ${time}`,
    detailLeavePool: ({ pool }) => `Rimuovi da ${pool}…`,
    detailRemovePooledNote: ({ pool }) => `${pool} usa questo account; rimuovilo prima dal gruppo. Rimuoverlo lo elimina dal tuo account e da ogni macchina.`,
    detailUsageSignedOut: 'Ultimo valore noto · non aggiornabile senza accesso',
    detailUsageSignedOutAt: ({ time }: { time: string }) => `Ultimo valore noto alle ${time} · non aggiornabile senza accesso`,
    detailResetsIn: ({ countdown }) => `tra ${countdown}`,
    detailUsedByTitle: 'Usato da',
    detailUsedByDefault: 'Il suo account predefinito',
    detailUsedByPool: ({ pool }) => `Tramite ${pool}`,
    detailUsedByPoolInUse: ({ pool }) => `Tramite ${pool} · in uso ora`,
    detailUsedByCould: 'Possono usarlo · oggi accedono a modo loro',
    detailWorksOnTitle: 'Funziona su',
    detailWorksOnDescription: 'Salvato nel tuo account. Una macchina lo usa quando vi inizia una sessione; nulla viene copiato in anticipo.',
    detailSignedInWithCode: 'Accesso con un codice',
    detailSignedInWithBrowser: 'Accesso con il browser',
    detailAddedWithKey: 'Aggiunto con una chiave',
    nearLimitTitle: ({ account, percent, window }) => `A ${account} resta il ${percent}% del limite ${window}`,
    nearLimitTitleNoAccount: ({ percent, window }) => `Resta il ${percent}% del limite ${window}`,
    nearLimitBodyWithReset: ({ time }) => `Si azzera alle ${time}. Applica un azzeramento per continuare subito.`,
    nearLimitBody: 'Applica un azzeramento per continuare subito.',
    nearLimitApplyReset: 'Applica un azzeramento',
    catalogSignInBrowserOrCode: 'Accesso con browser o codice',
    catalogSignInBrowserOrKey: 'Accesso con browser o incolla un token',
    catalogSignInBrowser: 'Accesso con browser',
    catalogSignInCode: 'Accesso con codice',
    catalogPasteKey: 'Incolla una chiave',
    deviceOpenService: ({ service }) => `Apri ${service}`,
    deviceWaitingFor: ({ service }) => `In attesa della tua approvazione in ${service}…`,
};

const connectedServicesSettingsTranslations = { it };

return { connectedServicesSettingsTranslations };
})();

const Domain_connectedServicesSetupTranslations = (() => {
type ConnectedServicesSetupTranslation = Shared_connectedServicesSetupTranslations.ConnectedServicesSetupTranslation;

const connectedServicesSetupTranslations = { it: {
        connectMoreTitle: 'Collega altro',
        connectMoreDescription: 'Servizi accettati dagli agenti sulle tue macchine che non hai ancora collegato.',
        connectMoreNothingNew: 'Aggiungi un altro account, un hosting di codice o uno strumento.',
        serviceSignInInstead: ({ agents }) => `${agents} può accedere con questo invece dell’accesso di ogni macchina.`,
        serviceCanUse: ({ agents }) => `${agents} può usarlo.`,
        moreServicesTitle: 'Altri servizi',
        moreServicesTools: ({ names }) => `${names} e altri, per codice e strumenti.`,
        moreServicesAll: 'Tutto ciò che accettano i tuoi agenti e strumenti.',
        browse: 'Sfoglia',
        notNow: ({ service }) => `Non ora: ${service}`,
        notNowTooltip: 'Non ora · resta in Sfoglia',
        back: 'Tutti i servizi',
        homeCatalogTitle: 'Collega un account',
        homeCatalogPurpose: 'I tuoi agenti lo usano su ogni macchina e Home mostra quanto resta.',
        homeNextSubtitle: ({ agents }) => `${agents} può usarlo invece dell’accesso di ogni macchina.`,
        firstRunMore: 'Chiavi API, hosting di codice e strumenti',
        settleAddToPoolWhy: ({ pool, agent, active }) => `Aggiungerlo a ${pool}, così ${agent} passa a questo quando ${active} si esaurisce?`,
        settleAddToPoolShort: ({ pool }) => `Aggiungerlo a ${pool}?`,
        settleAddToPool: ({ pool }) => `Aggiungi a ${pool}`,
        deviceStepCopy: 'Copia questo codice',
        deviceStepOpen: ({ service }) => `Apri ${service} e inseriscilo`,
        deviceStepOpenWhere: ({ where }) => `${where}, con l’accesso all’account che vuoi usare`,
        deviceStepApprove: ({ service }) => `Approva Happier in ${service}`,
        deviceCheckNow: 'Controlla ora',
    } } satisfies Pick<Readonly<Record<string, ConnectedServicesSetupTranslation>>, "it">;

return { connectedServicesSetupTranslations };
})();

const Domain_detailPageTranslations = (() => {
type DetailPageTranslations = Shared_detailPageTranslations.DetailPageTranslations;

const detailPageTranslations = { it: {
        approval: {
            requestTitle: 'Richiesta',
            requestDescription: 'Cosa è stato chiesto e a che punto è.',
            failureTitle: 'Perché non è riuscita',
            homeUnavailableTitle: 'Home non disponibile',
            contextTitle: 'Richiesto da',
            contextDescription: 'La sessione e l’agente che l’hanno chiesto.',
            sessionOnHome: ({ home }) => `Una sessione su ${home}`,
            sessionElsewhere: 'Una sessione che non è su questo dispositivo',
            origin: {
                voice: 'Richiesto a voce',
                agent: 'Richiesto da un agente',
                mcp: 'Richiesto tramite uno strumento collegato',
                cli: 'Richiesto dalla riga di comando',
                ui: 'Richiesto nell’app',
                api: 'Richiesto tramite l’API',
                plugin: 'Richiesto da un plugin',
                system: 'Richiesto da Happier',
            },
            proposalsDescription: 'Pubblicati nella revisione se approvi.',
        },
        runs: {
            description: 'Esecuzioni in background sulle tue macchine.',
            filterLabel: 'Esecuzioni mostrate',
            filterRunning: 'In corso',
            filterAll: 'Tutte',
            onHome: ({ home }) => `Su ${home}`,
        },
        person: {
            placeholderTitle: 'Persona',
            friendshipTitle: 'Amicizia',
            sharedSessionsDescription: 'Sessioni che questo amico condivide con te, sola lettura.',
            linkedAccountsTitle: 'Account collegati',
            linkedAccountsDescription: 'Dove altro accede. Si apre nel browser.',
        },
        friendsManage: {
            description: 'Le persone con cui lavori su Happier e le richieste tra voi.',
            requestsTitle: 'Richieste di amicizia',
            requestsDescription: 'Apri una richiesta per accettarla o rifiutarla.',
            sentTitle: 'Richieste inviate',
            sentDescription: 'In attesa che accettino.',
            friendsTitle: 'Amici',
            friendsDescription: 'Apri un amico per vedere cosa condivide con te.',
        },
    } } as const satisfies Pick<Record<string, DetailPageTranslations>, "it">;

return { detailPageTranslations };
})();

const Domain_detailsChromeTranslations = (() => {
type DetailsChromeTranslations = Shared_detailsChromeTranslations.DetailsChromeTranslations;

const detailsChromeTranslations = { it: {
        closeUnsavedTabA11y: 'Chiudi scheda, modifiche non salvate',
        emptyTitle: 'File, modifiche e commit si aprono qui',
        browseFiles: 'Sfoglia i file',
        previewHint: 'Un clic apre un’anteprima; aprila di nuovo per conservarla.',
        emptyReason: 'File, modifiche e commit che apri compaiono qui, accanto a dove li hai aperti.',
        reviewChanges: ({ count }) => (count === 1 ? 'Rivedi 1 modifica' : `Rivedi ${count} modifiche`),
        reviewChangesReason: ({ count }) => (count === 1
            ? 'In questa sessione è cambiato 1 file. Leggilo qui senza lasciare la conversazione.'
            : `In questa sessione sono cambiati ${count} file. Leggili qui senza lasciare la conversazione.`),
        splitNeedsWiderPane: 'Il confronto affiancato richiede un pannello più largo. Allarga Dettagli o usa Focus.',
    } } satisfies Pick<Record<string, DetailsChromeTranslations>, "it">;

return { detailsChromeTranslations };
})();

const Domain_detailsFileTranslations = (() => {
type DetailsFileTranslations = Shared_detailsFileTranslations.DetailsFileTranslations;

const detailsFileTranslations = { it: {
        areaUnstaged: 'Non in stage',
        areaStaged: 'In stage',
        areaBoth: 'Entrambi',
        areaLabel: 'Modifiche',
        preview: 'Anteprima',
        viewLabel: 'Vista',
        compare: 'Confronta',
        stage: 'Metti in stage',
        unstage: 'Togli dallo stage',
        addToCommit: 'Aggiungi al commit',
        removeFromCommit: 'Rimuovi dal commit',
        editing: 'In modifica',
        editingUnsaved: 'In modifica · modifiche non salvate',
        statusModified: 'Modificato',
        statusAdded: 'Aggiunto',
        statusDeleted: 'Eliminato',
        statusRenamed: 'Rinominato',
        statusCopied: 'Copiato',
        statusUntracked: 'Nuovo, non ancora tracciato',
        statusConflicted: 'Ha conflitti',
        noChanges: 'Nessuna modifica',
        lines: ({ count }) => (count === 1 ? '1 riga' : `${count} righe`),
    } } satisfies Pick<Record<string, DetailsFileTranslations>, "it">;

return { detailsFileTranslations };
})();

const Domain_detailsHistoryTranslations = (() => {
type Count = Shared_detailsHistoryTranslations.Count;

type Branch = Shared_detailsHistoryTranslations.Branch;

type Folder = Shared_detailsHistoryTranslations.Folder;

type DetailsHistoryTranslations = Shared_detailsHistoryTranslations.DetailsHistoryTranslations;

const detailsHistoryTranslations = { it: {
        copyCommitSha: 'Copia lo SHA del commit',
        filesChanged: ({ count }) => (count === 1 ? '1 file modificato' : `${count} file modificati`),
        files: ({ count }) => (count === 1 ? '1 file' : `${count} file`),
        revertEllipsis: 'Annulla commit…',
        stashKeptOn: ({ branch }) => `Messo da parte su ${branch}`,
        stashOriginBranch: ({ branch }) => `Salvato quando hai lasciato ${branch}`,
        stashOriginBranchShort: 'Al cambio di branch',
        stashOriginTransient: 'Salvato da Happier',
        stashOriginUnmanaged: 'Creato fuori da Happier',
        stashRestoreExplains: ({ folder }) => `Ripristinando, queste modifiche tornano in ${folder} e lo stash viene rimosso. Nient’altro cambia nella cartella.`,
        stashApply: 'Applica',
        stashApplyA11y: 'Applica queste modifiche e conserva lo stash',
        stashDiscardEllipsis: 'Elimina…',
        stashSwitcherA11y: 'Scegli uno stash',
        stashCount: ({ count }) => (count === 1 ? '1 stash' : `${count} stash`),
    } } satisfies Pick<Record<string, DetailsHistoryTranslations>, "it">;

return { detailsHistoryTranslations };
})();

const Domain_detailsReviewTranslations = (() => {
type Count = Shared_detailsReviewTranslations.Count;

type DetailsReviewTranslations = Shared_detailsReviewTranslations.DetailsReviewTranslations;

const detailsReviewTranslations = { it: {
        title: 'Revisione',
        files: ({ count }) => (count === 1 ? `1 file` : `${count} file`),
        nextCommit: ({ count }) => `${count} nel prossimo commit`,
        changedFiles: 'File modificati',
        commitColumn: 'Commit',
        jumpA11y: 'Vai a un file',
        comments: ({ count }) => (count === 1 ? `1 commento` : `${count} commenti`),
        goesWithNext: ({ count }) => (count === 1 ? `va con il tuo prossimo messaggio` : `vanno con il tuo prossimo messaggio`),
        askForChanges: 'Chiedi modifiche',
        detachCommentA11y: 'Escludi questo commento dal prossimo messaggio',
        trayExpandedHint: 'Vanno con il tuo prossimo messaggio all’agente.',
        askPlaceholder: 'Di all’agente cosa cambiare…',
        send: 'Invia',
        draftAuthor: 'Tu', draftStatus: 'bozza', includeComment: 'Va con il tuo prossimo messaggio',
    } } satisfies Pick<Record<string, DetailsReviewTranslations>, "it">;

return { detailsReviewTranslations };
})();

const Domain_embedSettingsTranslations = (() => {
const english = Shared_embedSettingsTranslations.english;

const translated = Shared_embedSettingsTranslations.translated;

const embedSettingsTranslations = { it: translated({
        settingsEmbeds: {
            title: "Incorporamenti",
            newTitle: "Nuovo incorporamento",
            purpose: "Lascia che altre app mostrino chat di Happier, solo con l’accesso che scegli.",
            yourEmbeds: "I tuoi incorporamenti",
            newEmbed: "Nuovo incorporamento",
            listError: "Impossibile caricare gli incorporamenti",
            emptyTitle: "Porta una chat di Happier nella tua app",
            emptyBody: "La tua app mostra conversazioni reali, solo con l’accesso che scegli: quali siti, chi può inviare o approvare e quali modelli.",
            createDescription: "Scegli cosa possono fare altre app con le tue chat e come appaiono.",
            name: "Nome",
            nameDescription: "Visibile solo a te, in questo elenco.",
            namePlaceholder: "Per esempio, dashboard dei lead",
            create: "Crea incorporamento",
            summary: {
                sites: ({ count }: { count: number }) => count === 1 ? '1 sito' : `${count} siti`,
                send: "Può inviare",
                sendAndApprove: "Può inviare e approvare",
                approve: "Può approvare",
                viewOnly: "Solo visualizzazione",
                modelOnly: ({ name }: { name: string }) => `solo ${name}`,
                models: ({ count }: { count: number }) => count === 1 ? '1 modello' : `${count} modelli`,
            },
            sites: {
                title: "Dove può apparire",
                description: "Le chat si aprono solo su questi siti.",
            },
            capabilities: {
                title: "Cosa possono fare le persone",
                view: "Vedere la conversazione",
                always: "Sempre",
                send: "Inviare messaggi",
                sendDescription: "Include fermare l’agente e allegare file.",
                changeModel: "Cambiare modello",
                permissionModes: "Modalità di autorizzazione",
                permissionModesDescription: "Le chat mostrano un selettore di modalità solo se è consentita più di una modalità.",
                anyMode: "Qualsiasi modalità",
                anyModeDescription: "Le persone possono cambiare quanto fa l’agente senza chiedere.",
                modeOnly: ({ name }: { name: string }) => `solo ${name}`,
                modes: ({ count }: { count: number }) => `${count} modalità`,
                approveOn: "Le persone su questi siti possono approvare l’uso degli strumenti e le richieste in queste chat.",
            },
            models: {
                title: "Modelli",
                description: "Gli altri modelli vengono rifiutati, non solo nascosti. Le chat iniziano con il primo modello consentito.",
                allowed: "Modelli consentiti",
                any: "Qualsiasi modello",
            },
            organization: {
                title: "Organizzazione",
                description: "La tua app elenca da qui le chat di questo incorporamento (con uno qualsiasi di questi tag). Anche le nuove chat arrivano qui.",
                folder: "Cartella",
                tags: "Tag",
                none: "Nessuno",
            },
            composer: {
                title: "Composizione",
                attachments: "Allegati",
                attachmentsDescription: "Nasconde il pulsante allega. Chi può inviare può comunque allegare file tramite l’API.",
            },
            sessions: {
                title: "Sessioni",
                description: "Le sessioni create da questa chiave, dal tuo server o dalla chat, girano su questo computer con questo agente e finiscono nella cartella e nei tag sopra.",
                allow: "Consenti a questa chiave di creare sessioni",
                offConsequence: "Questa chiave non può creare sessioni. La tua app può mostrare solo chat esistenti.",
                computer: "Computer",
                agent: "Agente",
                newChat: "Avvia nuove chat nell’incorporamento",
                appSetting: "Per la tua app",
                newChatDescription: "Mostra una casella per una nuova chat quando la tua app apre l’incorporamento senza chat. È un’impostazione per la tua app, non un limite di sicurezza: il tuo server può sempre creare chat con questa chiave.",
            },
            appearance: {
                title: "Aspetto",
                description: "L’anteprima segue ogni modifica. Le chat aperte si aggiornano senza ricaricare.",
                mode: "Modalità",
                modeSystem: "Sistema",
                modeLight: "Chiaro",
                modeDark: "Scuro",
                theme: "Tema",
                presetHappier: "Happier",
                colors: "Colori",
                colorsDefault: "Colori di Happier",
                colorsCustomized: ({ count }: { count: number }) => count === 1 ? '1 personalizzato' : `${count} personalizzati`,
                colorsFor: "Colori per",
                colorGroups: {
                    surface: "Superfici",
                    text: "Testo",
                    accent: "Accento",
                    messages: "Messaggi",
                    composer: "Composizione",
                    approvals: "Approvazioni",
                },
                fontFamily: "Carattere",
                fontFamilyPlaceholder: "Carattere di Happier",
                fontFile: "File del carattere",
                fontFileDescription: "Un link https a un file .woff2 o .woff.",
                fontFileRefused: "Usa un link a un file .woff2 o .woff, non un foglio di stile.",
                textSize: "Dimensione del testo",
                textSizeCompact: "Compatta",
                textSizeDefault: "Predefinita",
                textSizeLarge: "Grande",
                corners: "Angoli",
                cornersSharp: "Netti",
                cornersSoft: "Morbidi",
                cornersRound: "Arrotondati",
                density: "Densità",
                densityCompact: "Compatta",
                densityComfortable: "Comoda",
                reset: "Ripristina l’aspetto",
            },
            preview: {
                title: "Anteprima dal vivo",
                phone: "Telefono",
                desktop: "Desktop",
                reduceMotion: "Riduci il movimento",
                note: "La vera chat incorporata con messaggi di esempio. Qui non viene inviato nulla.",
                rowDescription: "Guarda la chat con queste impostazioni.",
                unavailable: "Anteprima non disponibile",
            },
            snippets: {
                title: "Frammenti di codice",
                description: "Incollali nella tua app. Usano già le impostazioni di questo incorporamento.",
                steps: "1 Salva la chiave come HAPPIER_EMBED_KEY · 2 Scrivi canOpenSession: chi può aprire quale chat · 3 Mostra la chat",
                backend: "Server",
                react: "React",
            },
            detail: {
                created: ({ date }: { date: string }) => `Creato il ${date}`,
                lastUsed: ({ date }: { date: string }) => `Ultimo uso ${date}`,
                expires: ({ date }: { date: string }) => `Scade il ${date}`,
                reconnect: "Le chat aperte si riconnettono con il nuovo accesso. Le bozze vengono conservate.",
                e2eeTrust: "Questa chiave può leggere le chat cifrate di questo account. Usa un account dedicato per la tua app.",
                keyReach: "La chiave resta sul tuo server e può raggiungere tutte le chat di questo account. I browser non la vedono mai: ricevono chiavi di breve durata limitate alle chat che il tuo server consente.",
                expiry: "La chiave scade",
                expiryDescription: "Quando la chiave scade, le chat smettono di aprirsi. Non si può prolungare dopo.",
                encryptionChecking: "Verifica della cifratura di questo account…",
                encryptionUnavailable: "Questo dispositivo non può ancora leggere le chat cifrate di questo account. Ripristina la tua chiave segreta per creare l’incorporamento.",
                encryptionStale: "Le chiavi di questo dispositivo per le chat cifrate non sono aggiornate. Ripristina la tua chiave segreta per creare l’incorporamento.",
                encryptionUnreadable: "Non è stato possibile verificare la cifratura di questo account.",
                missingTitle: "Questo incorporamento non esiste più",
                backToEmbeds: "Torna agli incorporamenti",
            },
            delete: {
                button: "Elimina incorporamento",
                title: ({ label }: { label: string }) => `Eliminare «${label}»?`,
                body: "Le chat aperte vengono disconnesse. Le chiavi già usate per leggere chat cifrate non possono essere richiamate.",
                confirm: "Elimina",
            },
            reveal: {
                copyEnv: "Copia come riga .env",
            },
        },
    }) };

return { embedSettingsTranslations };
})();

const Domain_embedTranslations = (() => {
const english = Shared_embedTranslations.english;

const translated = Shared_embedTranslations.translated;

const embedTranslations = { it: translated({
        embed: {
            errors: {
                originNotAllowed: 'Questa pagina non può mostrare questa conversazione.',
                originNotAllowedReason: 'Aggiungi questo sito ai siti consentiti dell’incorporamento in Happier.',
                unavailable: 'Questa conversazione non è disponibile qui.',
                encrypted: 'Questa conversazione è cifrata e non può essere aperta qui.',
                createNotGranted: 'Questa app non può avviare nuove chat.',
                unsupportedVersion: 'Questa chat richiede un incorporamento più recente.',
                unsupportedVersionReason: 'Aggiorna @happier-dev/embed in questa app.',
            },
            nothingToShow: 'Ancora niente da mostrare',
            nothingToShowReason: 'Questa app non ha aperto nessuna conversazione.',
            reconnecting: 'Riconnessione…',
            previewUnavailable: 'Anteprima non disponibile',
            previewUser: "Analizza questo lead e registra il risultato: Acme Robotics, 40 postazioni, valutazione nel quarto trimestre.",
            previewAgent: "Ottima corrispondenza. Il budget è confermato e il promotore decide. Ho registrato l’analisi:",
            previewFollowUp: "Spostiamo questo lead a qualificato?",
        },
    }) };

return { embedTranslations };
})();

const Domain_entityDragDropTranslations = (() => {
type EntityDragDropTranslations = Shared_entityDragDropTranslations.EntityDragDropTranslations;

const en = Shared_entityDragDropTranslations.en;

const it: EntityDragDropTranslations = {
    files: { attach: "Allega", uploadHere: "Carica qui" },
    composer: { addContext: "Aggiungi contesto", consequence: "Inviato con il tuo prossimo messaggio · per ora non si invia nulla", target: "Compositore", readOnly: "Questo compositore è di sola lettura", otherWorkspace: "Non fa parte di questo spazio di lavoro", unavailable: "Questo riferimento non è disponibile" },
    surface: {
        scopeMismatch: 'Si trova in un’altra Home o in un altro account',
        widgetMoveUnavailable: 'Questo widget non può essere spostato su questa superficie',
        widgetReadOnly: 'Puoi vedere questo layout ma non modificarlo. Chiedi l’accesso in modifica al proprietario',
        widgetAlreadyHere: 'È già su questa superficie. Riordinalo lì',
        widgetCantLiveHere: 'Questo widget non può stare su questa superficie. Aggiungilo qui da Aggiungi widget',
        widgetNeedsInputs: 'I suoi input non possono essere compilati qui. Aggiungilo qui da Aggiungi widget e sceglili',
        widgetLayoutChanged: 'Questo layout è appena cambiato. Rilascialo di nuovo',
        readOnly: 'Questa bacheca è di sola lettura',
        copyDetail: 'Mantiene un riferimento · la bacheca resta invariata',
    },
    preview: {
        putUnder: ({ target }) => `Metti sotto ${target}`,
        putUnderDetail: 'Le riferisce · entrambe continuano',
        moveAbove: ({ target }) => `Sposta sopra ${target}`,
        moveBelow: ({ target }) => `Sposta sotto ${target}`,
        orderDetail: 'Solo l’ordine · nessuno riferisce a nessuno',
        moveToFolder: ({ folder }) => `Sposta in ${folder}`,
        folderDetail: 'Solo la cartella · non riferisce a nessuno',
        moveToTopLevel: 'Sposta al livello principale',
        topLevelDetail: 'Fuori dalla cartella · nient’altro cambia',
        cantPutUnder: ({ target }) => `Impossibile mettere sotto ${target}`,
        cantMoveHere: 'Impossibile spostarla qui',
        pendingPutUnder: ({ target }) => `La metto sotto ${target}…`,
        pendingDetail: 'In attesa della conferma della Home',
        unknownTitle: 'Non è certo che sia stata spostata',
        unknownDetail: 'Controlla l’elenco tra un momento prima di riprovare',
    },
    settled: {
        refusedPutUnder: ({ item, target }) => `Impossibile mettere ${item} sotto ${target}`,
        refused: ({ verb }) => `${verb}: non è andato a buon fine`,
        unknown: ({ verb }) => `Non è chiaro se «${verb}» sia andato a buon fine`,
        dismiss: 'Ignora',
    },
    reasons: {
        read: 'È condivisa con te in sola lettura, quindi non può ricevere resoconti',
        input: 'Non puoi inviarle nulla, quindi non può ricevere resoconti',
        pairwise: 'Queste due sessioni non possono condividere il contesto',
        cycle: 'Quella sessione riferisce già a questa',
        alreadyUnder: 'Riferisce già a questa',
        archived: 'È archiviata',
        differentHome: 'È in un’altra Home. Le sessioni riferiscono all’interno di una sola Home',
        unavailable: 'Impossibile verificare questa sessione al momento',
        dateOrder: 'Questo elenco è ordinato per data. Passa all’ordine personalizzato per posizionarla',
        noChange: 'È già qui',
        descendantCycle: 'Una cartella non può stare dentro sé stessa',
        maxDepth: 'Le cartelle sarebbero annidate troppo in profondità',
        foldersOff: 'Le cartelle sono disattivate per questa Home',
        gone: 'Quel posto è appena scomparso',
        generic: 'Questo posto non può accoglierla',
    },
    chooser: { putUnderTitle: ({ item }) => `Metti ${item} sotto…`, checking: 'Verifica delle sessioni che possono ricevere resoconti…', cantTakeReports: 'Non possono ricevere resoconti', unavailable: 'Non disponibile' },
    keyboard: {
        choose: 'Scegli un posto', putUnder: 'Metti sotto', topLevel: 'Livello principale', drop: 'Rilascia', cancel: 'Annulla', escapeKey: 'Esc',
        hintsA11y: 'Le frecce scelgono un posto, Invio rilascia, Esc annulla',
    },
    organize: { enter: 'Organizza l’elenco', title: 'Organizza', done: 'Fine', grip: ({ item }) => `Sposta ${item}` },
    pane: {
        openHere: 'Apri qui come scheda',
        nextTo: ({ target }) => `Accanto a ${target} · non si chiude nulla`,
        nothingCloses: 'Si apre come scheda · non si chiude nulla',
        tooNarrow: 'Questo riquadro è troppo stretto per dividerlo',
        moveHere: 'Sposta qui come scheda',
        openBefore: ({ target }) => `Apri prima di ${target}`,
        moveBefore: ({ target }) => `Sposta prima di ${target}`,
        placeOnly: 'Cambia solo la posizione',
        splitLeft: 'Dividi a sinistra',
        splitRight: 'Dividi a destra',
        splitUp: 'Dividi in alto',
        splitDown: 'Dividi in basso',
        opensBeside: ({ target }) => `Si apre accanto a ${target}`,
        movesBeside: ({ target }) => `Si sposta accanto a ${target}`,
        goTo: ({ target }) => `Vai a ${target}`,
        openInThisPane: 'Già aperta in questo riquadro · non si apre nulla di nuovo',
        openInAnotherPane: 'Già aperta in un altro riquadro · non si apre nulla di nuovo',
        alreadyHere: 'È già qui',
        leaveIt: 'Rilascia per lasciarla dov’è',
        cantOpenHere: 'Non si può aprire qui',
        sessionsOnly: 'Questo riquadro mostra solo sessioni',
        otherWorkspace: 'Non fa parte di questo spazio di lavoro',
    },
};

const entityDragDropTranslations = { it };

return { entityDragDropTranslations };
})();

const Domain_eventAutomationComposerTranslations = (() => {
const english = Shared_eventAutomationComposerTranslations.english;

const it = {
    eventAutomationComposer: {
        available: 'Disponibile',
        payloadFields: 'CAMPI DI CARICO UTILE',
        payloadSample: 'Carico utile del campione',
        noFilterableFields: 'Questo evento non dichiara campi di payload filtrabili.',
        addFilterClause: 'Aggiungi condizione',
        filterField: 'Campo filtro',
        filterOperator: 'Operatore di filtro',
        filterEquals: 'Uguali',
        filterOneOf: 'È uno di',
        filterValue: 'Valore del filtro',
        filterValuePlaceholder: '"valore" o ["valore"]',
        storedContentUnavailableTitle: 'Contenuto di automazione archiviato non disponibile',
        storedContentUnavailableBody: 'Questa automazione dell\'evento non può essere salvata perché il suo contenuto archiviato non è disponibile.',
        historyGapRecoveryTitle: 'Il divario storico necessita di attenzione',
        historyGapRecoverySubtitle: 'Reimposta la linea di base di origine per riprendere a osservare nuovi eventi.',
        historyGapRecoveryUnavailable: 'L\'azione di ripristino dell\'origine non è disponibile sul relativo osservatore corrente.',
        historyGapRecoveryFailureTitle: 'Il ripristino della fonte richiede un altro tentativo',
        historyGapRecoveryFailureBody: 'Il recupero non è stato confermato. La fonte necessita ancora di attenzione.',
        sourceStatusTitle: 'Sorgente di osservazione',
        sourceStatusState: {
            uninitialized: 'Non avviata',
            baselined: 'Baseline pronta',
            observing: 'Osservazione in corso',
            backingOff: 'In attesa di riprovare',
            attention: 'Richiede attenzione',
        },
        sourceStatusCode: {
            credentialMissing: 'Credenziali richieste',
            credentialRevoked: 'Credenziali revocate',
            rateLimited: 'Limite di frequenza raggiunto',
            historyGap: 'Lacuna nella cronologia',
            capacityBlocked: 'Capacità esaurita',
            definitionStale: 'Definizione modificata',
            sourceContractIncompatible: 'La sorgente deve essere aggiornata',
            admissionUnavailable: 'Ammissione non disponibile',
        },
        sourceStatusNextRetry: ({ time }: { time: string }) => `Prossimo tentativo: ${time}`,
        sourceStatusObservedCount: ({ count }: { count: number }) => `Eventi osservati: ${count}`,
        sourceStatusAdmittedCount: ({ count }: { count: number }) => `Eventi ammessi: ${count}`,
        sourceStatusSkippedCount: ({ count }: { count: number }) => `Eventi ignorati: ${count}`,
        sourceStatusLastObserved: ({ time }: { time: string }) => `Ultima osservazione: ${time}`,
        sourceCatalogStatusTitle: 'Riconciliazione del catalogo',
        sourceCatalogStatusState: {
            current: 'Aggiornato',
            reconciling: 'Riconciliazione in corso',
            reconciliationLate: 'Riconciliazione in ritardo',
        },
        sourceCatalogStatusObservedRevision: ({ revision }: { revision: string }) => `Revisione osservata: ${revision}`,
        sourceCatalogStatusAdoptedRevision: ({ revision }: { revision: string }) => `Revisione adottata: ${revision}`,
        sourceCatalogStatusNoAdoptedRevision: 'Nessuna revisione adottata',
        sourceCatalogStatusScanStarted: ({ time }: { time: string }) => `Scansione avviata: ${time}`,
    },
};

const eventAutomationComposerTranslations = { it } as const;

return { eventAutomationComposerTranslations };
})();

const Domain_externalSessionOperationTranslations = (() => {
const en = Shared_externalSessionOperationTranslations.en;

const translated = Shared_externalSessionOperationTranslations.translated;

const externalSessionOperationTranslations = { it: {
    browseLinked: 'Collegata',
    browseImported: 'Importata',
    browseAgentUnavailable: 'Happier non è riuscito ad avviare o raggiungere l’Agent selezionato su questa macchina. Verifica che la sua CLI sia installata e riprova.',
    browseAgentTimedOut: 'L’Agent selezionato su questa macchina non ha risposto in tempo. Potrebbe essere occupato o ancora in indicizzazione, quindi riprova.',
    browseAgentFailed: 'Happier non è riuscito a leggere le sessioni dell’Agent selezionato su questa macchina. Riprova; se continua a non funzionare, aggiorna Happier su quella macchina.',
    operationTitleMaterialize: 'Importa in Happier',
    operationTitleTakeoverLinked: 'Assumi il controllo e continua collegata',
    operationTitleTakeoverPersisted: 'Importa e assumi il controllo',
    operationMaterializeAvailable: 'Importa questa sessione collegata per usare la trascrizione offline o condividerla.',
    externalAgentStatusOnMachine: ({ agent, machine, status }: { agent: string; machine: string; status: string }) =>
        `${agent} su ${machine}: ${status}`,
    operationStatusRunning: 'In corso',
    operationStatusCancelling: 'Annullamento…',
    operationStatusCancelled: 'Annullata',
    operationStatusCompleted: 'Completata',
    operationStatusDiscarded: 'Sessione parziale eliminata',
    operationStatusNeedsResume: 'In attesa che tu riprenda',
    operationStatusNeedsReview: 'Richiede una verifica prima di continuare',
    operationStatusFailed: 'Impossibile continuare',
    operationStatusImportIncomplete: 'Importazione incompleta — Riprendi o elimina la sessione parziale',
    operationStatusUpdateIncomplete: 'Aggiornamento incompleto — Riprendi',
    operationStatusOriginOffline: 'Avanzamento salvato — il computer di origine è offline',
    operationStatusOriginUnknown: 'Avanzamento salvato — Happier non può sapere se il computer di origine è online',
    operationStatusExternalWriter: 'Rilevata una scrittura esterna',
    operationStatusSpawnFailedAfterImport: 'Importata, ma impossibile avviare l’Agent — Riprova avvio',
    operationStatusSpawnFailedAfterTakeover: 'Controllo assunto, ma impossibile avviare l’Agent — Riprova avvio',
    operationErrorSourceUnavailable: 'La sorgente non è disponibile. Riconnetti il computer di origine, quindi riprendi.',
    operationErrorSourceChanged: 'La sorgente è cambiata durante la lettura. Verificala prima di riprendere.',
    operationErrorCapacity: 'Questo computer non dispone di capacità temporanea sufficiente per continuare.',
    operationErrorRequiredItems: 'Non è stato possibile importare alcuni elementi obbligatori della sessione.',
    operationErrorImport: 'L’importazione dei messaggi è stata interrotta.',
    operationErrorPublication: 'Non è stato possibile pubblicare l’istantanea importata.',
    operationErrorAdmission: 'Happier non ha potuto assumere il controllo della sessione in sicurezza.',
    operationErrorExternalWriter: 'Arresta l’Agent esterno prima di riprovare. Happier non lo unirà né lo arresterà automaticamente.',
    operationErrorInternal: 'L’operazione si è interrotta a causa di un errore interno.',
    operationPhaseValidating: 'Convalida',
    operationPhaseWaitingForAgent: 'In attesa dell’arresto dell’Agent esterno',
    operationPhaseReadingSource: 'Lettura della sorgente',
    operationPhaseImporting: 'Importazione dei messaggi',
    operationPhaseCatchingUp: 'Allineamento con la sorgente',
    operationPhasePreparingRuntime: 'Preparazione del runtime',
    operationPhaseStartingRuntime: 'Avvio del runtime',
    operationPhaseFinalizing: 'Finalizzazione',
    operationPhasePublishing: 'Pubblicazione della sessione importata',
    operationActionResume: 'Riprendi',
    operationActionRetryStart: 'Riprova avvio',
    operationActionCancel: 'Annulla',
    operationActionDiscard: 'Elimina sessione parziale',
    operationActionDismiss: 'Chiudi',
    operationStatusOwnerReadFailed: 'Happier non è riuscito a leggere l’avanzamento attuale di questa operazione.',
    operationActionCheckAgain: 'Controlla di nuovo',
    operationComposerImporting: 'Importazione…',
    operationComposerTakingOver: 'Assunzione del controllo…',
    operationActionErrorUpgradeRequired: 'Aggiorna Happier sul computer di origine per usare questa azione.',
    operationActionErrorNotFound: 'Questa operazione non è più disponibile.',
    operationActionErrorConflict: 'Un’altra operazione sta già controllando questa sessione.',
    operationActionErrorStaleRevision: 'L’operazione è cambiata. Verifica l’avanzamento più recente e riprova.',
    operationActionErrorInvalidState: 'Questa azione non è disponibile nello stato attuale dell’operazione.',
    operationActionErrorNotAllowed: 'Non disponi dell’autorizzazione per controllare questa operazione.',
    operationActionErrorUnavailable: 'Non è stato possibile completare l’azione. Riprova dall’avanzamento più recente.',
    operationImportProgress: 'Avanzamento importazione',
    operationImportCountUnknown: ({ imported }: { imported: number }) => `${imported} messaggi importati`,
    operationImportCountEstimated: ({ imported, total }: { imported: number; total: number }) => `${imported} di ~${total} messaggi`,
    operationPublishedSnapshot: 'Istantanea pubblicata conservata',
    operationPublishedThrough: ({ sequence }: { sequence: number }) => `Disponibile fino al messaggio ${sequence}`,
    operationDiscardConfirmTitle: 'Eliminare la sessione parziale?',
    operationDiscardConfirmBody: 'Questa operazione elimina l’intera sessione parziale e non può essere annullata.',
    sharingTranscriptOnMachine: ({ machine }: { machine: string }) =>
        `La trascrizione di questa sessione si trova su ${machine}. Importala in Happier per condividerla.`,
    sharingImportIncomplete: 'L’importazione è in corso o incompleta. Riprendila prima di condividere.',
    sharingTranscriptUnavailableTitle: 'Trascrizione non disponibile',
    transcriptRetainedRefreshFailedTitle: 'Viene mostrata l’ultima trascrizione nota',
    transcriptLoadFailed: 'Happier non è riuscito a caricare questa trascrizione.',
    sharingTranscriptUnavailable: 'Trascrizione non disponibile. Questa sessione collegata precedente non dispone di una trascrizione persistente sicura.',
    sharingSharedUpTo: ({ time }: { time: string }) => `Condivisa fino a ${time}`,
    sharingSnapshotFrom: ({ time }: { time: string }) => `Istantanea del ${time}`,
    sharingUpdateSharedCopy: 'Aggiorna copia condivisa',
    sharingUpdateSharedCopyDescription: 'Aggiorna l’istantanea condivisa con la trascrizione più recente della sorgente.',
    sharingSourceMachineMissing: 'Il computer di origine non è disponibile. Riconnettilo a Happier prima di riprovare.',
    sharingSourceMachineOffline: 'Il computer di origine è offline. Riportalo online prima di riprovare.',
    sharingActionAwaitingAvailability: 'Questa azione sarà disponibile quando il flusso di materializzazione sarà collegato.',
} } as const;

return { externalSessionOperationTranslations };
})();

const Domain_externalSessionSettingsTranslations = (() => {
const en = Shared_externalSessionSettingsTranslations.en;

const translated = Shared_externalSessionSettingsTranslations.translated;

const externalSessionSettingsTranslations = { it: {
    settingsIntegrationStatusNotInstalled: 'Non installata',
    settingsIntegrationStatusEnabled: 'Installata e attiva',
    settingsIntegrationStatusDisabled: 'Installata e disattivata',
    settingsIntegrationStatusNeedsAttention: 'Richiede attenzione',
    settingsIntegrationStatusUnsupported: 'Non supportata da questa versione dell’Agent',
    settingsIntegrationStatusUnavailable: 'Agent non disponibile',
    settingsIntegrationInventoryLoadingTitle: 'Verifica dello stato delle integrazioni',
    settingsIntegrationInventoryLoadingSubtitle: 'Lettura dell’inventario completo delle integrazioni da questo computer.',
    settingsIntegrationInventoryPartialTitle: 'Stato delle integrazioni incompleto',
    settingsIntegrationInventoryPartialSubtitle: 'Non è stato possibile leggere alcuni record di installazione. Controlla di nuovo prima di apportare modifiche.',
    settingsIntegrationInventoryErrorTitle: 'Stato delle integrazioni non disponibile',
    settingsIntegrationInventoryErrorSubtitle: 'L’ultimo stato noto potrebbe non essere aggiornato. Controlla di nuovo prima di apportare modifiche.',
    settingsIntegrationTitle: 'Monitoraggio delle sessioni esterne',
    settingsIntegrationNeedsAttentionTitle: 'Richiede attenzione',
    settingsIntegrationDiagnosticMessageUnavailable: 'Questa installazione richiede attenzione prima che il monitoraggio possa continuare.',
    settingsIntegrationRemediationRetry: 'Controlla di nuovo dopo aver risolto il problema.',
    settingsIntegrationRemediationOpenSettings: ({ path }: { path: string }) => `Controlla l’impostazione in ${path}.`,
    settingsIntegrationRemediationSelectAccount: ({ service }: { service: string }) => `Seleziona un account per ${service}.`,
    settingsIntegrationRemediationInstallDependency: ({ dependency }: { dependency: string }) => `Installa la dipendenza richiesta: ${dependency}.`,
    settingsIntegrationRemediationOpenUrl: ({ url }: { url: string }) => `Consulta le istruzioni in ${url}.`,
    settingsIntegrationActionReviewInstall: 'Verifica e installa',
    settingsIntegrationActionDisable: 'Disattiva',
    settingsIntegrationActionEnable: 'Attiva',
    settingsIntegrationActionUninstall: 'Disinstalla',
    settingsIntegrationActionCheckAgain: 'Controlla di nuovo',
    settingsIntegrationReviewTitle: ({ agent }: { agent: string }) => `Verifica l’integrazione di ${agent}`,
    settingsIntegrationReviewBody: ({ entries }: { entries: string }) =>
        `Happier gestirà solo queste voci: ${entries}.`,
    settingsIntegrationReviewBodyUnavailable: 'Verifica le modifiche gestite dall’Agent prima dell’installazione.',
    settingsIntegrationPreviewNoMatcher: 'Tutte le sessioni corrispondenti',
    settingsIntegrationActionInstall: 'Installa',
    settingsIntegrationUninstallTitle: ({ agent }: { agent: string }) => `Disinstallare l’integrazione di ${agent}?`,
    settingsIntegrationUninstallBody: 'Vengono rimosse solo le voci gestite da Happier. Il resto della configurazione dell’Agent rimane invariato.',
    settingsIntegrationActionFailed: 'Happier non ha potuto aggiornare questa integrazione. Controlla il computer e riprova.',
    settingsAutoLinkUpdateFailed: 'Happier non ha potuto aggiornare il collegamento automatico. Riprova.',
    settingsRestoreUpdateFailed: 'Happier non ha potuto aggiornare la preferenza di sincronizzazione dopo il riavvio. Riprova.',
    settingsIntegrationsGroupTitle: 'Monitoraggio delle sessioni esterne',
    settingsIntegrationsFooter: 'Happier modifica la configurazione dell’Agent solo dopo un’azione esplicita. L’apertura di questa pagina è di sola lettura.',
    settingsIntegrationsUnavailableTitle: 'Nessuna integrazione disponibile',
    settingsIntegrationsUnavailableSubtitle: 'Collega un’integrazione Agent supportata per verificarne lo stato e le azioni disponibili.',
    settingsAgentAutoLinkTitle: ({ agent }: { agent: string }) => `Aggiungi automaticamente le nuove sessioni di ${agent}`,
    settingsAutoLinkTitle: 'Aggiungi automaticamente nuove sessioni esterne',
    browseAutoLinkTitle: 'Aggiungi automaticamente nuove sessioni',
    settingsAutoLinkGroupTitle: 'Collegamento automatico',
    settingsAutoLinkGroupFooter: 'Il collegamento automatico è disattivato per impostazione predefinita ed è separato dalla configurazione dell’integrazione Agent e dalla sincronizzazione in background.',
    settingsAutoLinkUnavailableTitle: 'Nessuna sorgente per il collegamento automatico',
    settingsAutoLinkUnavailableSubtitle: 'Su questo computer non sono disponibili ambiti di sorgente supportati.',
    settingsAutoLinkSubtitle: 'Quando è attivo, Happier collega le nuove sessioni supportate da questa sorgente senza aprire o riprendere l’Agent.',
    settingsAutoLinkHint: 'Attiva o disattiva il collegamento automatico per questa sorgente.',
    settingsPrivacyGroupTitle: 'Privacy',
    settingsPrivacyTitle: 'Osservazioni limitate e senza contenuti',
    settingsPrivacySubtitle: 'Le integrazioni Agent attendibili possono esaminare dati nativi limitati degli hook su questo computer. Happier ammette e sincronizza solo osservazioni senza contenuti; payload grezzi, percorsi, credenziali, prompt, testo delle trascrizioni e argomenti degli strumenti non vengono mai salvati, sincronizzati o registrati dall’host.',
    settingsAgentActionsGroupTitle: 'Sessioni esterne',
    settingsAgentBrowseTitle: ({ agent }: { agent: string }) => `Sfoglia le sessioni esterne di ${agent}`,
    settingsManageAllTitle: 'Gestisci tutte le impostazioni delle Sessioni esterne',
    settingsManageAllSubtitle: 'Verifica le integrazioni e la sincronizzazione in background sui computer collegati.',
    settingsMachineOnline: 'In linea',
    settingsMachineOffline: 'Non in linea',
    settingsMachineTitle: 'Computer',
    settingsMachineUnavailable: 'Nessun computer collegato',
    browseSearchIncomplete: ({ count }: { count: number }) =>
        `Visualizzazione dei primi ${count} risultati — affina la ricerca`,
    browseAnnotationsIncomplete: 'Non è stato possibile confermare alcuni stati. Aprire una sessione lo verifica.',
    browseRouteUnavailableTitle: 'Le sessioni esterne non sono disponibili qui',
    browseRouteUnavailableSubtitle: 'Questo server non offre l’esplorazione delle sessioni esterne. Torna indietro e scegli un altro server, oppure riprova più tardi.',
    browseRouteAvailabilityUnknownTitle: 'Impossibile confermare il supporto alle sessioni esterne',
    browseRouteAvailabilityUnknownSubtitle: 'Happier non è riuscito a verificare se questo server offre l’esplorazione delle sessioni esterne. Torna indietro e riprova tra poco.',
    browseHeaderTitle: 'Sessioni esterne',
    browseSettingsLink: 'Impostazioni delle sessioni esterne',
    browseChooseMachineTitle: 'Scegli una macchina',
    browseChooseMachineBody: 'Le sessioni esterne vivono sulla macchina che le ha eseguite. Scegline una per vederne le sessioni.',
    browseMachineGoneBody: 'È stata rimossa o sostituita. Scegli un’altra macchina per vederne le sessioni.',
    browseHomeUnreachableBody: 'Le sue macchine e sessioni appariranno quando sarà raggiungibile. Nel frattempo scegli un’altra macchina.',
    browseMachineOfflineTitle: ({ machine }: { machine: string }) => `${machine} è offline`,
    browseThisMachineOfflineTitle: 'Questa macchina è offline',
    browseMachineOfflineBody: 'Le sue sessioni compariranno quando si riconnetterà.',
    browseChooseAnotherMachine: 'Scegli un’altra macchina',
    browseCantReachTitle: ({ machine }: { machine: string }) => `Impossibile raggiungere Happier su ${machine}`,
    browseCantReachBody: 'La macchina è online, ma il suo servizio Happier non risponde. Potrebbe essere ancora in avvio.',
    browseNothingToBrowseTitle: ({ machine }: { machine: string }) => `Niente da sfogliare su ${machine}`,
    browseNothingToBrowseBody: 'Nessuno degli agenti su questa macchina può ancora condividere le proprie sessioni.',
    browseEmptyTitle: ({ agent, machine }: { agent: string; machine: string }) => `Nessuna sessione di ${agent} su ${machine}`,
    browseEmptyBody: 'Le sessioni che avvii su questa macchina compaiono qui, pronte da aprire in Happier.',
    browseTryAgent: ({ agent }: { agent: string }) => `Prova ${agent}`,
    browseNoMatches: ({ query }: { query: string }) => `Nessuna sessione corrisponde a “${query}”`,
    browseErrorTitle: 'Impossibile caricare le sessioni',
    browseThisMachine: 'questa macchina',
    browseIndexingStop: 'Interrompi',
    browseThreadsFilter: 'Thread dei sotto-agenti',
    browseThreadsHidden: 'Solo sessioni principali',
    browseThreadsShown: 'Con thread dei sub-agenti',
    browseThreadReviewer: 'Revisore',
    browseThreadSubagent: 'Sotto-agente',
    browseThreadReviewerOf: ({ parent }: { parent: string }) => `Revisore di ${parent}`,
    browseThreadSubagentOf: ({ parent }: { parent: string }) => `Sotto-agente di ${parent}`,
} };

return { externalSessionSettingsTranslations };
})();

const Domain_filesPaneTranslations = (() => {
type FilesPaneTranslations = Shared_filesPaneTranslations.FilesPaneTranslations;

const filesPaneTranslations = { it: {
        changedOnly: 'Solo modificati',
        showAllFiles: 'Mostra tutti i file',
        viewOptions: 'Opzioni di visualizzazione',
        sizeAndDate: 'Dimensione e data',
        newMenu: 'Nuovo file, nuova cartella o caricamento',
        newFile: 'Nuovo file',
        newFolder: 'Nuova cartella',
        noChangedFilesTitle: 'Non è cambiato nulla',
        noChangedFilesReason: 'La copia di lavoro corrisponde all’ultimo commit.',
        rootErrorTitle: ({ machine }) => `Impossibile elencare i file su ${machine}`,
        rootErrorTitleUnnamed: 'Impossibile elencare i file',
        workspaceUnavailableReason: 'Happier non ha potuto individuare un computer e una cartella per questa sessione.',
    } } as const satisfies Pick<Record<string, FilesPaneTranslations>, "it">;

return { filesPaneTranslations };
})();

const Domain_findTranslations = (() => {
type FindTranslations = Shared_findTranslations.FindTranslations;

const slavicPlural = Shared_findTranslations.slavicPlural;

const russianPlural = Shared_findTranslations.russianPlural;

const en = Shared_findTranslations.en;

const it: FindTranslations = {
    open: 'Trova…',
    openedForMatch: 'Aperto per una corrispondenza', foldAgain: 'Comprimi di nuovo', showHiddenLines: ({ count }) => `Mostra ${count} righe nascoste`,
    surface: {
        chat: 'Trova nella chat',
        changes: 'Trova nelle modifiche',
        file: 'Trova nel file',
        terminal: ({ name }) => `Trova in ${name}`,
    },
    previous: 'Corrispondenza precedente',
    next: 'Corrispondenza successiva',
    matchCase: 'Maiuscole/minuscole',
    regex: 'Usa espressione regolare',
    regexShort: 'Espressione regolare',
    options: 'Opzioni di ricerca',
    close: 'Chiudi ricerca',
    done: 'Fine',
    stop: 'Interrompi',
    noMatches: 'Nessuna corrispondenza',
    noneFound: 'Nessun risultato',
    invalidPattern: 'Modello non valido',
    offline: 'Non in linea',
    unsupported: 'Qui non è possibile cercare',
    count: ({ current, total }) => (current === null ? `${total} ${total === 1 ? 'corrispondenza' : 'corrispondenze'}` : `${current} di ${total}`),
    files: ({ count }) => `${count} file`,
    soFar: 'finora',
    loaded: 'caricate',
    note: {
        searchingOlder: 'Ricerca nei messaggi meno recenti, decifrati su questo dispositivo',
        offlineOlder: 'Potrai cercare nei messaggi meno recenti quando tornerai online.',
        terminalKept: ({ lines }) => `Cercato nelle ultime ${lines} righe conservate da questo terminale.`,
    },
};

const findTranslations = { it };

return { findTranslations };
})();

const Domain_folderlessSessionTranslations = (() => {
type FolderlessSessionTranslations = Shared_folderlessSessionTranslations.FolderlessSessionTranslations;

const en = Shared_folderlessSessionTranslations.en;

const it: FolderlessSessionTranslations = {
    composer: {
        addFolder: 'Aggiungi cartella',
        noFolder: 'Nessuna cartella',
        noFolderDescription: 'Happier tiene una cartella privata per questa chat',
        removeFolder: 'Rimuovi cartella',
        a11y: {
            folder: ({ path }) => `Cartella: ${path}. Apre la scelta della cartella.`,
            none: 'Nessuna cartella. Happier tiene una cartella privata per questa chat. Aggiungi cartella.',
            loading: 'Caricamento cartella',
            noFolderRow: 'Nessuna cartella, cartella privata per questa chat',
            removed: 'Cartella rimossa',
            set: ({ path }) => `Cartella impostata su ${path}`,
        },
    },
    display: {
        chats: 'Chat',
        untitledChat: 'Nuova chat',
        folder: 'Cartella',
        privateToSession: 'Solo per questa sessione',
        sessionFiles: 'File della sessione',
        privateFolderOn: ({ machine }) => `Cartella privata su ${machine}`,
    },
};

const folderlessSessionTranslations = { it: it };

return { folderlessSessionTranslations };
})();

const Domain_glassAppearanceTranslations = (() => {
const englishTranslations = Shared_glassAppearanceTranslations.englishTranslations;

const effectiveTranslations = { "it": {
        "effectiveBrowserSolid": "Menu e controlli mobili opachi. Un browser non può mostrare il desktop.",
        "effectiveFloatingSolid": "Controlli mobili opachi su questo dispositivo.",
        "effectiveSolid": "Superfici opache su questo dispositivo.",
        "effectiveBrowser": "Vetro su menu e controlli mobili. Un browser non può mostrare il desktop.",
        "effectiveBrowserCustom": "Il tuo materiale su menu e controlli mobili. Un browser non può mostrare il desktop.",
        "effectivePhone": "Vetro su controlli mobili e pannelli.",
        "effectiveLayered": "Vetro a strati in tutta questa finestra.",
        "effectiveUniform": "Vetro uniforme in tutta questa finestra.",
        "effectiveCustom": "Vetro in questa finestra secondo le tue impostazioni.",
        "effectiveUnavailable": "Il vetro della finestra non è disponibile. I controlli mobili usano il materiale scelto.",
        "effectiveInactive": "Opaco mentre questa finestra è inattiva.",
        "effectiveTint": "Controlli mobili colorati; la sfocatura di sfondo non è disponibile.",
        "description": "Lascia vedere il desktop attraverso la finestra e la pagina sotto i controlli mobili.",
        "descriptionBrowser": "Lascia vedere la pagina sotto menu e controlli mobili.",
        "descriptionPhone": "Lascia vedere la pagina sotto controlli mobili e pannelli.",
        "chromeDescription": "Barra del titolo, navigazione e sfondo",
        "sidebarDescription": "La colonna delle sessioni",
        "contentDescription": "Conversazione, compositore e pannelli di lavoro",
        "floatingDescription": "Menu, popup, pannelli e controlli mobili",
        "clear": "Trasparente",
        "shortcutHint": ({ modifier }: { modifier: string }) => `${modifier}-clic · ${modifier}⇧L alterna chiaro e scuro`
    } } as const;

const glassAppearanceTranslations = { it: { iosReduceTransparencyPath: "Impostazioni › Accessibilità › Schermo e dimensioni del testo › Riduci trasparenza", title: 'Vetro', material: 'Materiale', solid: 'Opaco', auto: 'Automatico', everywhere: 'Ovunque', custom: 'Personalizzato', blur: 'Sfocatura', off: 'Disattivata', opacity: 'Opacità', customize: 'Personalizza', chrome: 'Cornice della finestra', sidebar: 'Barra laterale', content: 'Contenuto', floating: 'Superfici mobili', appearance: 'Aspetto', moreSettings: 'Altre impostazioni dell’aspetto…', customizeLink: 'Personalizza…', toolbarTitle: 'Pulsante Aspetto', toolbarDescription: 'Mostra Aspetto nella barra. Un clic con modificatore alterna chiaro e scuro.', reduceTransparency: 'Opaco perché Riduci trasparenza è attivo', osSettings: 'Apri le impostazioni di accessibilità', themeCommand: 'Alterna chiaro e scuro', autoDescription: "Si adatta al dispositivo: vetro a strati nelle finestre compatibili e sulle superfici mobili del telefono.", osSettingsUnavailable: "Non è stato possibile aprire le impostazioni di accessibilità. Aprile nelle impostazioni del dispositivo.", ...effectiveTranslations["it"] } } satisfies Pick<Record<string, Record<keyof typeof englishTranslations, string | ((params: { modifier: string }) => string)>>, "it">;

return { effectiveTranslations, glassAppearanceTranslations };
})();

const Domain_goalControlTranslations = (() => {
const en = Shared_goalControlTranslations.en;

const it: typeof en = {
    row: {
        notSet: 'Non impostato',
    },
    keepGoing: {
        title: 'Continua fino alla fine',
        nativeDescription: ({ agent }) => `${agent} continua a lavorare all’obiettivo in autonomia.`,
        description: ({ rounds }) => `Dopo ogni tuo turno, un agente controlla l’obiettivo e continua finché non è raggiunto, il budget è esaurito o non fa più progressi, per al massimo ${rounds} round.`,
        roundsPrefix: 'Fermati dopo',
        roundsSuffix: 'round',
        roundsLabel: 'Round prima di fermarsi',
        strikesPrefix: 'Fermati dopo',
        strikesSuffix: 'controlli senza progressi',
        strikesLabel: 'Controlli senza progressi prima di fermarsi',
        secondOpinionTitle: 'Chiedi un secondo parere prima di finire',
        secondOpinionDescription: 'Prima che l’obiettivo sia segnato come raggiunto, un secondo agente lo controlla. Se non è d’accordo, ricevi una notifica e l’obiettivo resta aperto.',
        budgetUnreported: ({ agent }) => `${agent} non riporta l’uso dei token, quindi valgono solo i round e i controlli di avanzamento.`,
    },
};

const goalControlTranslations = { it };

return { goalControlTranslations };
})();

const Domain_homeAddTranslations = (() => {
type HomeAddTranslation = Shared_homeAddTranslations.HomeAddTranslation;

const en = Shared_homeAddTranslations.en;

const homeAddTranslations = { it: {
        addressIsSignInService: 'Questo indirizzo appartiene a un servizio di accesso. Accedi tramite questo servizio per trovare i tuoi Home.',
        mixedContent: 'Questo browser non può connettersi a un Home HTTP da una pagina HTTPS. Apri Happier tramite HTTP oppure usa un indirizzo HTTPS per il Home.',
        connectedToHome: ({ home }) => `${home} è connesso a questo dispositivo.`,
        openHome: ({ home }) => `Apri ${home}`,
        showAllHomes: 'Mostra tutti i Home',
        otherSignInService: 'Altro servizio di accesso',
        otherSignInServiceSubtitle: 'Un servizio self-hosted o aziendale',
        signInServiceAddress: 'Indirizzo del servizio',
    } } satisfies Pick<Record<string, HomeAddTranslation>, "it">;

return { homeAddTranslations };
})();

const Domain_homeComposerTranslations = (() => {
type HomeComposerTranslation = Shared_homeComposerTranslations.HomeComposerTranslation;

const starterPrompts = Shared_homeComposerTranslations.starterPrompts;

const homeComposerTranslations = { it: {
        ...starterPrompts,
        suggestionsLabel: 'Suggerimenti',
        summarizeProjectSince: ({ project, day }) => `Riassumi cosa è cambiato in ${project} da ${day}`,
        summarizeProjectToday: ({ project }) => `Riassumi cosa è cambiato oggi in ${project}`,
        sessionsSince: ({ count, day }) => (count === 1 ? `1 sessione da ${day}` : `${count} sessioni da ${day}`),
        sessionsToday: ({ count }) => (count === 1 ? '1 sessione oggi' : `${count} sessioni oggi`),
    } } satisfies Pick<Readonly<Record<string, HomeComposerTranslation>>, "it">;

return { homeComposerTranslations };
})();

const Domain_homeDeviceApprovalTranslations = (() => {
type HomeDeviceApprovalTranslation = Shared_homeDeviceApprovalTranslations.HomeDeviceApprovalTranslation;

const homeDeviceApprovalTranslations = { it: {
        title: 'Approvazioni dei dispositivi', deviceFallback: 'Nuovo dispositivo',
        homeLabel: ({ home }) => `Home: ${home}`, expiresLabel: ({ expiry }) => `Scade: ${expiry}`,
        requestDetails: 'Dettagli della richiesta', requestDetailsHint: 'Mostra l’identificatore della chiave di richiesta',
        fingerprintLabel: 'Impronta della chiave di richiesta', requestDetailsHelp: 'Identifica la chiave della richiesta. Non è un codice da confrontare.',
        approve: 'Approva', reject: 'Rifiuta', loadError: 'Impossibile caricare le approvazioni dei dispositivi.',
        loadErrorUnreachable: ({ homes }) => `${homes} non ha risposto.`, loadErrorFailed: ({ homes }) => `${homes} ha risposto con un errore.`,
        decisionError: 'Impossibile aggiornare questa richiesta.', decisionRecovery: 'Scegli Approva o Rifiuta per riprovare.',
        approved: 'Dispositivo approvato', rejected: 'Dispositivo rifiutato', expired: 'Scaduta', stopWaiting: 'Smetti di attendere',
    } } as const satisfies Pick<Record<string, HomeDeviceApprovalTranslation>, "it">;

return { homeDeviceApprovalTranslations };
})();

const Domain_homeFeatureTranslations = (() => {
const en = Shared_homeFeatureTranslations.en;

const it: typeof en = {
    teams: {
        title: 'Team',
        description: 'Gruppi con sessioni, macchine e accessi condivisi.',
        credentialResources: {
            title: 'Credenziali del team',
            description: 'Credenziali che un team condivide con le sue sessioni.',
            externalApi: {
                title: 'API delle credenziali del team',
                description: 'Strumenti esterni usano le credenziali di un team tramite l’API.',
            },
        },
    },
    automations: {
        title: 'Automazioni',
        description: 'Lavoro degli agenti pianificato e attivato da eventi.',
    },
    workflows: {
        title: 'Flussi di lavoro',
        description: 'Pipeline di agenti in più passaggi.',
    },
    pets: {
        sync: {
            title: 'Sincronizzazione dei pet',
            description: 'Mantiene i pet di ogni persona su tutti i suoi dispositivi.',
        },
    },
    voice: {
        title: 'Voce',
        description: 'Parla con i tuoi agenti.',
        happierVoice: {
            title: 'Voce Happier',
            description: 'La voce tramite il servizio vocale fornito da questo Home.',
        },
    },
    connectedServices: {
        group: 'Servizi collegati',
        quotas: {
            title: 'Indicatori di quota',
            description: 'Mostra quanta quota resta a ogni account collegato.',
        },
        subscription: {
            title: 'Stato dell’abbonamento',
            description: 'Mostra piano e stato di ogni account collegato.',
        },
        accountGroups: {
            title: 'Gruppi di account',
            description: 'Raggruppa gli account collegati in pool.',
        },
        accountFallback: {
            title: 'Account di riserva',
            description: 'Passa all’account successivo del pool quando uno si esaurisce.',
        },
        autoQuotaReset: {
            title: 'Ripristino automatico della quota',
            description: 'Usa i ripristini di quota accumulati quando tutti gli account di un pool sono esauriti.',
        },
        autoDisablePlanInvalid: {
            title: 'Salta gli account inutilizzabili',
            description: 'Disattiva gli account del pool che non possono usare il modello scelto.',
        },
        poolQuotaLimitSelection: {
            title: 'Limiti di quota del pool',
            description: 'Scegli quale quota del provider segue ogni pool.',
        },
    },
    updates: {
        ota: {
            title: 'Aggiornamenti over-the-air',
            description: 'Le app installano aggiornamenti senza passare dallo store.',
        },
    },
    attachments: {
        uploads: {
            title: 'Allegati',
            description: 'Invia file e immagini agli agenti di una sessione.',
        },
    },
    sharing: {
        group: 'Condivisione',
        session: {
            title: 'Condivisione delle sessioni',
            description: 'Condividi una sessione con qualcuno su questo Home.',
        },
        public: {
            title: 'Link pubblici',
            description: 'Condividi il contenuto di una sessione con un link pubblico.',
        },
        contentKeys: {
            title: 'Condivisione cifrata',
            description: 'Scambia chiavi perché le sessioni condivise restino cifrate end-to-end.',
        },
        pendingQueueV2: {
            title: 'Coda di messaggi condivisa',
            description: 'Mette in coda i messaggi di una sessione condivisa mentre il suo agente è occupato.',
        },
        pendingDeliveryState: {
            title: 'Tracciamento della consegna in coda',
            description: 'Ricorda quali messaggi in coda hanno raggiunto l’agente.',
        },
    },
    sessions: {
        title: 'Sessioni',
        description: 'Le sessioni e i loro controlli.',
        group: 'Sessioni',
        handoff: {
            title: 'Passaggio di sessione',
            description: 'Sposta una sessione in corso su un’altra macchina.',
        },
        ephemeralRunner: {
            title: 'Runner temporanei',
            description: 'Avvia una sessione su una macchina usa e getta.',
        },
        agentSwitching: {
            title: 'Cambio di agente',
            description: 'Continua una sessione con un altro agente di coding.',
        },
        folders: {
            title: 'Cartelle delle sessioni',
            description: 'Organizza le sessioni in cartelle.',
        },
        drafts: {
            title: 'Bozze sincronizzate',
            description: 'Conserva i messaggi non inviati e le bozze di sessione su ogni dispositivo.',
        },
        following: {
            title: 'Seguire',
            description: 'Segui una sessione per riceverne aggiornamenti e notifiche.',
        },
        conversations: {
            title: 'Conversazioni',
            description: 'Le persone parlano e si menzionano all’interno di una sessione condivisa.',
        },
        board: {
            title: 'Bacheca delle sessioni',
            description: 'Disponi le sessioni e i loro elementi su bacheche condivise.',
        },
        filteredListing: {
            title: 'Elenco filtrato',
            description: 'Filtra l’elenco delle sessioni su questo Home prima della paginazione.',
        },
        usageLimitRecovery: {
            title: 'Ripresa dopo limite d’uso',
            description: 'Attendi e riprendi, o riprova, quando un agente raggiunge un limite d’uso.',
        },
    },
    machines: {
        title: 'Macchine',
        description: 'La connessione alle tue macchine.',
        group: 'Macchine',
        pools: {
            title: 'Pool di macchine',
            description: 'Passa alla macchina successiva quando una è offline.',
        },
        transfer: {
            title: 'Trasferimenti tra macchine',
            description: 'Trasferire dati tra macchine.',
            directPeer: {
                title: 'Trasferimenti diretti',
                description: 'Trasferisce dati direttamente tra macchine.',
            },
            serverRouted: {
                title: 'Trasferimenti tramite questo Home',
                description: 'Trasferisce dati tramite questo Home quando le macchine non riescono a collegarsi direttamente.',
            },
        },
        peerMediation: {
            title: 'Connessioni tra macchine',
            description: 'Tunnel, stream e accessi tra macchine.',
            observability: {
                title: 'Diagnostica delle connessioni',
                description: 'Mostra come sono collegati tunnel, stream e anteprime tra macchine.',
            },
        },
        tunnel: {
            title: 'Tunnel tra macchine',
            description: 'Aprire porte tra macchine.',
            directPeer: {
                title: 'Tunnel diretti',
                description: 'Apre porte direttamente tra macchine.',
            },
            serverRouted: {
                title: 'Tunnel tramite questo Home',
                description: 'Apre porte tramite questo Home quando le macchine non riescono a collegarsi direttamente.',
            },
        },
        liveStream: {
            title: 'Stream in diretta',
            description: 'Trasmettere lo schermo di una macchina.',
            directPeer: {
                title: 'Stream diretti',
                description: 'Trasmette lo schermo di una macchina direttamente al tuo dispositivo.',
            },
            serverRouted: {
                title: 'Stream tramite questo Home',
                description: 'Trasmette lo schermo di una macchina tramite questo Home quando lo stream diretto non riesce.',
            },
        },
        rpc: {
            title: 'Chiamate alle macchine',
            description: 'Raggiungere le macchine direttamente.',
            directPeer: {
                title: 'Chiamate dirette alle macchine',
                description: 'Raggiunge una macchina direttamente anziché tramite questo Home.',
            },
        },
    },
    localServices: {
        title: 'Servizi locali',
        description: 'Vedi e apri i servizi in esecuzione sulle tue macchine.',
        group: 'Servizi locali',
        inventory: {
            title: 'Inventario dei servizi',
            description: 'Elenca porte e servizi attivi su ogni macchina.',
        },
        managed: {
            title: 'Servizi gestiti',
            description: 'Avvia, nomina e monitora servizi da Happier.',
        },
        launcher: {
            title: 'Avvio dei servizi',
            description: 'Suggerisce servizi da aprire e visualizzare in anteprima.',
        },
        actions: {
            title: 'Azioni sui servizi',
            description: 'Copia, visualizza in anteprima e dimentica servizi.',
            terminate: {
                title: 'Arresta servizi',
                description: 'Arresta il processo di un servizio rilevato.',
            },
        },
        preview: {
            title: 'Anteprime dei servizi',
            description: 'Mostra in privato l’anteprima di un servizio locale in una sessione.',
        },
        publicPreview: {
            title: 'Anteprime pubbliche',
            description: 'Condividi l’anteprima di un servizio a un indirizzo pubblico.',
        },
    },
    browser: {
        title: 'Browser',
        description: 'Apri pagine, anteprime e viste ospitate in Happier.',
        group: 'Browser',
        viewTargets: {
            title: 'Viste del browser',
            description: 'Apre anteprime, pagine dei plugin e link nella vista giusta.',
        },
        internal: {
            title: 'Browser integrato',
            description: 'Naviga in Happier con sessioni e profili propri.',
        },
        sidecar: {
            title: 'Browser affiancato',
            description: 'Un browser gestito a parte per l’automazione intensiva.',
        },
        diagnostics: {
            title: 'Strumenti per sviluppatori',
            description: 'Console, rete ed eventi devtools del browser integrato.',
        },
        context: {
            title: 'Contesto del browser',
            description: 'Allega il contenuto di una pagina a un messaggio o a un agente.',
        },
        automation: {
            title: 'Automazione del browser',
            description: 'Gli agenti cliccano, scrivono e navigano nel browser integrato.',
        },
        recording: {
            title: 'Registrazioni del browser',
            description: 'Registra le sessioni del browser come prova.',
        },
    },
    plugins: {
        title: 'Plugin esterni a Happier',
        description: 'Installa plugin da npm e dalle tue fonti.',
        group: 'Plugin',
        webhooks: {
            title: 'Webhook dei plugin',
            description: 'I plugin ricevono webhook da servizi esterni.',
        },
        ui: {
            title: 'Schermate dei plugin',
            description: 'Mostra le schermate e i pannelli forniti dai plugin.',
            hostedWeb: {
                title: 'Schermate web dei plugin',
                description: 'Mostra schermate dei plugin create per il web.',
            },
            reactNativeBundles: {
                title: 'Schermate native dei plugin',
                description: 'Esegue schermate di plugin attendibili create con React Native.',
            },
        },
    },
    devices: {
        title: 'Dispositivi',
        description: 'Simulatori e dispositivi collegati.',
        simulatorPreview: {
            title: 'Anteprime dei simulatori',
            description: 'Mostra simulatori ed emulatori delle tue macchine.',
        },
    },
    social: {
        friends: {
            title: 'Amici',
            description: 'Aggiungi amici e guarda cosa condividono.',
        },
    },
    auth: {
        group: 'Accesso',
        recovery: {
            providerReset: {
                title: 'Ripristino tramite provider',
                description: 'Recupera un account accedendo con il suo provider di identità.',
            },
        },
        login: {
            keyChallenge: {
                title: 'Accesso con chiave',
                description: 'Accedi dimostrando la chiave di un dispositivo.',
            },
        },
        mtls: {
            title: 'Certificati client',
            description: 'Accedi con un certificato client (mTLS).',
        },
        ui: {
            recoveryKeyReminder: {
                title: 'Promemoria della chiave di recupero',
                description: 'Ricorda alle persone di salvare la chiave di recupero.',
            },
        },
        pairing: {
            desktopQrMobileScan: {
                title: 'Accesso tramite scansione',
                description: 'Accedi su un telefono scansionando un codice su un computer.',
            },
            boundQrV2: {
                title: 'Codici di abbinamento più sicuri',
                description: 'Codici di abbinamento validi solo per questo Home e questa direzione.',
            },
        },
    },
    encryption: {
        group: 'Cifratura',
        plaintextStorage: {
            title: 'Archiviazione non cifrata',
            description: 'Archivia le sessioni senza cifratura end-to-end.',
        },
        accountOptOut: {
            title: 'Rinuncia alla cifratura',
            description: 'Ogni persona può disattivare la cifratura end-to-end.',
        },
    },
    remoteHosts: {
        group: 'Host remoti',
        management: {
            title: 'Host remoti',
            description: 'Salva host SSH su cui eseguire sessioni.',
        },
        secretMaterial: {
            title: 'Segreti degli host salvati',
            description: 'Salva password e chiavi degli host SSH.',
        },
    },
    e2ee: {
        keylessAccounts: {
            title: 'Account senza chiavi',
            description: 'Account senza chiavi di cifratura end-to-end.',
        },
    },
    bugReports: {
        title: 'Segnalazioni di bug',
        description: 'Invia segnalazioni di bug con dati diagnostici.',
    },
    terminal: {
        group: 'Terminale',
        embeddedPty: {
            title: 'Terminale',
            description: 'Apri un terminale su una macchina dentro Happier.',
        },
        transport: {
            byteStream: {
                title: 'Terminale in streaming',
                description: 'Una connessione più veloce per il terminale integrato.',
            },
        },
    },
    search: {
        title: 'Ricerca',
        description: 'Cerca in sessioni e trascrizioni.',
    },
    providers: {
        title: 'Provider di modelli',
        description: 'Collega provider di modelli e scegli i modelli per gli agenti.',
        group: 'Provider di modelli',
        localDiscovery: {
            title: 'Trova provider locali',
            description: 'Trova server di modelli in esecuzione sulle tue macchine.',
        },
        localModelManagement: {
            title: 'Gestione dei modelli locali',
            description: 'Scarica e gestisci modelli locali.',
        },
    },
    keys: {
        HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: {
            title: 'Indirizzo del servizio di segnalazione',
            description: 'Dove vengono inviate le segnalazioni di bug. Se vuoto, non viene offerto alcun servizio di segnalazione.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__DEFAULT_INCLUDE_DIAGNOSTICS: {
            title: 'Includi la diagnostica per impostazione predefinita',
            description: 'Il modulo di segnalazione include i dati diagnostici, a meno che chi segnala non li escluda.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__MAX_ARTIFACT_BYTES: {
            title: 'Allegato più grande',
            description: 'File più grande che una segnalazione di bug può allegare, in byte.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__UPLOAD_TIMEOUT_MS: {
            title: 'Tempo limite di caricamento',
            description: 'Quanto può durare il caricamento di una segnalazione di bug, in millisecondi.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__ACCEPTED_ARTIFACT_KINDS: {
            title: 'Tipi di allegato accettati',
            description: 'Tipi di allegato accettati dalle segnalazioni di bug. Vuoto accetta i tipi consueti.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__CONTEXT_WINDOW_MS: {
            title: 'Finestra di contesto',
            description: 'Fino a quanto indietro nel tempo una segnalazione di bug raccoglie il contesto, in millisecondi.',
        },
        HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: {
            title: 'La voce richiede un abbonamento',
            description: 'Solo gli abbonati possono usare la voce. Se non impostato, in produzione è richiesto e nelle altre configurazioni no.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_MANIFEST_BYTES: {
            title: 'Manifest del pet più grande',
            description: 'Manifest del pet più grande accettato, in byte.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_SPRITESHEET_BYTES: {
            title: 'Spritesheet del pet più grande',
            description: 'Spritesheet del pet più grande accettato, in byte.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_PACKAGE_BYTES: {
            title: 'Pacchetto del pet più grande',
            description: 'Pacchetto del pet più grande accettato, in byte.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PETS_PER_ACCOUNT: {
            title: 'Pet importati per persona',
            description: 'Numero massimo di pet importati che una persona può tenere.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PET_BYTES_PER_ACCOUNT: {
            title: 'Spazio per pet importati per persona',
            description: 'Numero massimo di byte di pet importati che una persona può tenere.',
        },
        HAPPIER_FEATURE_PETS_SYNC__ENCRYPTED_CUSTOM_PET_SYNC_POLICY: {
            title: 'Pet personalizzati cifrati',
            description: 'Riservato per il futuro. I pet personalizzati cifrati non vengono ancora sincronizzati, quindi l’opzione resta disattivata.',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES: {
            title: 'Trasferimento più grande tramite questo Home',
            description: 'File più grande che un trasferimento tramite questo Home trasporta, in byte.',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_ACTIVE_TRANSFERS_PER_SOCKET: {
            title: 'Trasferimenti simultanei per connessione',
            description: 'Numero massimo di trasferimenti tramite questo Home che una connessione esegue contemporaneamente.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES: {
            title: 'Dati per tunnel',
            description: 'Numero massimo di byte che un tunnel tramite questo Home trasporta.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_ACTIVE_TUNNELS_PER_SOCKET: {
            title: 'Tunnel per connessione',
            description: 'Numero massimo di tunnel tramite questo Home che una connessione tiene aperti.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: 'Frame di tunnel più grande',
            description: 'Frame più grande che un tunnel tramite questo Home trasporta, in byte.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__SUPPORTED_ENCODINGS: {
            title: 'Codifiche dei tunnel',
            description: 'Codifiche dei frame accettate dai tunnel tramite questo Home. Vuoto usa quelle standard.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__PREFERRED_ENCODING: {
            title: 'Codifica di tunnel preferita',
            description: 'La codifica dei frame da usare per prima. Deve essere tra le codifiche accettate.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BINARY_HEADER_BYTES: {
            title: 'Intestazione di frame più grande',
            description: 'Intestazione binaria di frame più grande, in byte.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_RAW_PAYLOAD_BYTES: {
            title: 'Payload di frame più grande',
            description: 'Payload grezzo più grande in un frame, in byte.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAMED_MESSAGE_BYTES: {
            title: 'Messaggio in frame più grande',
            description: 'Messaggio in frame più grande, in byte.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_CONCURRENT_SUBSTREAMS: {
            title: 'Stream simultanei per tunnel',
            description: 'Numero massimo di stream che un tunnel esegue contemporaneamente.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_TOTAL_SUBSTREAMS: {
            title: 'Stream per tunnel',
            description: 'Numero massimo di stream che un tunnel apre nel corso della sua vita.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES_PER_SUBSTREAM: {
            title: 'Dati per stream',
            description: 'Numero massimo di byte che uno stream trasporta.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_AGGREGATE_BYTES: {
            title: 'Dati per tunnel, tutti gli stream',
            description: 'Numero massimo di byte che tutti gli stream di un tunnel trasportano insieme.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SUBSTREAM_IDLE_MS: {
            title: 'Tempo limite di inattività dello stream',
            description: 'Quanto uno stream può restare inattivo prima di chiudersi, in millisecondi.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SESSION_IDLE_MS: {
            title: 'Tempo limite di inattività del tunnel',
            description: 'Quanto un tunnel tramite questo Home può restare inattivo prima di chiudersi, in millisecondi.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_IDLE_MS: {
            title: 'Limite di inattività dei tunnel',
            description: 'Quanto un tunnel può restare inattivo prima di chiudersi, in millisecondi.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_DURATION_MS: {
            title: 'Tunnel più lungo',
            description: 'Tempo massimo per cui un tunnel resta aperto, in millisecondi.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: {
            title: 'Porte raggiungibili dai tunnel',
            description: 'Porte che i tunnel possono aprire. Vuoto consente solo quelle predefinite.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__TOKEN_TTL_MS: {
            title: 'Durata del link di anteprima',
            description: 'Per quanto tempo funziona un link di anteprima privato, in millisecondi.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: {
            title: 'Dominio delle anteprime',
            description: 'Dominio che serve ogni anteprima al proprio indirizzo. Vuoto serve le anteprime sotto l’indirizzo di questo Home.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: {
            title: 'Modalità di anteprima pubblica',
            description: 'Modi in cui un’anteprima può essere resa pubblica.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: {
            title: 'Anteprima pubblica più lunga',
            description: 'Tempo massimo per cui un’anteprima resta pubblica, in millisecondi. Vuoto mantiene il limite standard.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_CONCURRENT_EXPOSURES: {
            title: 'Anteprime pubbliche simultanee',
            description: 'Numero massimo di anteprime pubbliche contemporaneamente. Vuoto mantiene il limite standard.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: {
            title: 'Richiedi DNS e TLS',
            description: 'Le anteprime pubbliche richiedono DNS e TLS.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_SINK: {
            title: 'Log di audit delle anteprime pubbliche',
            description: 'Dove vengono registrate le anteprime pubbliche. Le anteprime pubbliche ne richiedono uno.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_LOG_PATH: {
            title: 'File del log di audit',
            description: 'File in cui viene scritto il log di audit delle anteprime pubbliche.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: {
            title: 'Consenti il log di audit di test',
            description: 'Solo per lo sviluppo: accetta il log di audit di test in memoria. Ignorato in produzione.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: {
            title: 'Limiti di frequenza delle anteprime pubbliche',
            description: 'Profili di limite di frequenza che le anteprime pubbliche possono usare.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER: {
            title: 'Controllo dei limiti di frequenza',
            description: 'Come vengono limitate le richieste alle anteprime pubbliche. Le anteprime pubbliche ne richiedono uno.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS: {
            title: 'Richieste per finestra',
            description: 'Richieste che un’anteprima pubblica consente in ogni finestra.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS: {
            title: 'Finestra del limite di frequenza',
            description: 'Durata di ogni finestra del limite di frequenza, in millisecondi.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: {
            title: 'Consenti il limitatore di test',
            description: 'Solo per lo sviluppo: accetta il limitatore di frequenza di test in memoria. Ignorato in produzione.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_REQUESTS: {
            title: 'Webhook in corso',
            description: 'Numero massimo di richieste webhook che questo server gestisce contemporaneamente.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_WORKING_BYTES: {
            title: 'Memoria dei webhook',
            description: 'Memoria massima che le richieste webhook in corso possono usare, in byte. Vuoto consente quanto già permesso dal limite di richieste.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_RATE_PER_MINUTE: {
            title: 'Webhook al minuto per percorso',
            description: 'Richieste webhook al minuto su un percorso.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_CONCURRENCY: {
            title: 'Webhook simultanei per percorso',
            description: 'Richieste webhook in corso su un percorso.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_RATE_PER_MINUTE: {
            title: 'Webhook al minuto per endpoint',
            description: 'Richieste webhook al minuto su un endpoint.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_CONCURRENCY: {
            title: 'Webhook simultanei per endpoint',
            description: 'Richieste webhook in corso su un endpoint.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_RATE_PER_MINUTE: {
            title: 'Webhook al minuto per persona',
            description: 'Richieste webhook al minuto per una persona.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_CONCURRENCY: {
            title: 'Webhook simultanei per persona',
            description: 'Richieste webhook in corso per una persona.',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES: {
            title: 'Bundle di schermata plugin più grande',
            description: 'Bundle di schermata plugin più grande ospitato da questo Home, in byte.',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES: {
            title: 'Spazio per schermate dei plugin per persona',
            description: 'Numero massimo di byte di bundle di schermate dei plugin che una persona può archiviare.',
        },
        HAPPIER_COLLECTION_MAX_ROW_ENCODED_BYTES: {
            title: 'Riga di dati plugin più grande',
            description: 'Riga più grande che un plugin archivia, in byte.',
        },
        HAPPIER_COLLECTION_MAX_BATCH_BYTES: {
            title: 'Batch di dati plugin più grande',
            description: 'Batch più grande di modifiche ai dati dei plugin, in byte.',
        },
        HAPPIER_COLLECTION_MAX_BATCH_ROWS: {
            title: 'Righe per batch di dati plugin',
            description: 'Numero massimo di righe in un batch di modifiche ai dati dei plugin.',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: {
            title: 'Righe di dati plugin per persona',
            description: 'Numero massimo di righe di dati dei plugin che una persona può archiviare.',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_BYTES: {
            title: 'Spazio per dati plugin per persona',
            description: 'Numero massimo di byte di dati dei plugin che una persona può archiviare.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_BITRATE_BPS: {
            title: 'Bitrate massimo dello stream',
            description: 'Bitrate massimo di uno stream in diretta tramite questo Home, in bit al secondo.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAMES_PER_SECOND: {
            title: 'Frame rate massimo dello stream',
            description: 'Frame rate massimo di uno stream in diretta tramite questo Home.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: 'Frame di stream più grande',
            description: 'Frame più grande di uno stream in diretta tramite questo Home, in byte.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_DURATION_MS: {
            title: 'Stream in diretta più lungo',
            description: 'Durata massima di uno stream in diretta tramite questo Home, in millisecondi.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_TOTAL_BYTES: {
            title: 'Dati per stream in diretta',
            description: 'Numero massimo di byte che uno stream in diretta tramite questo Home trasporta.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_ACCOUNT: {
            title: 'Stream in diretta simultanei per persona',
            description: 'Numero massimo di stream in diretta tramite questo Home che una persona esegue contemporaneamente.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_SOCKET: {
            title: 'Stream in diretta simultanei per connessione',
            description: 'Numero massimo di stream in diretta tramite questo Home che una connessione esegue contemporaneamente.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_MACHINE: {
            title: 'Stream in diretta simultanei per macchina',
            description: 'Numero massimo di stream in diretta tramite questo Home che una macchina esegue contemporaneamente.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: {
            title: 'ID della chiave di firma delle connessioni',
            description: 'Identifica la chiave che firma le connessioni tra macchine. Senza chiave di firma, queste connessioni sono disattivate.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: {
            title: 'Chiave privata di firma delle connessioni',
            description: 'Chiave privata che firma le connessioni tra macchine.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: {
            title: 'Chiave pubblica di firma delle connessioni',
            description: 'Chiave pubblica corrispondente alla chiave di firma. Se vuota, viene ricavata dalla chiave privata.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: {
            title: 'Scadenza della chiave di firma',
            description: 'Quando scade la chiave di firma, come timestamp in millisecondi.',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: {
            title: 'Trova amici per nome utente',
            description: 'Le persone possono trovare amici per nome utente oltre che per account collegato.',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__IDENTITY_PROVIDER: {
            title: 'Provider per l’abbinamento degli amici',
            description: 'Il provider di accesso usato per abbinare gli amici.',
        },
    },
};

const homeFeatureTranslations = { it } as const;

return { homeFeatureTranslations };
})();

const Domain_homeGovernanceTranslations = (() => {
const en = Shared_homeGovernanceTranslations.en;

const it: typeof en = {
    title: 'Amministrazione Home',
    pages: {
        features: 'Cosa offre questo Home. Una modifica vale ovunque al prossimo aggiornamento.',
        data: 'Cosa conserva questo Home e per quanto tempo.',
        homes: 'Account, ruoli, team e regole di accesso per ogni Home che amministri.',
        overview: 'Chi amministra questo Home e cosa puoi modificare qui.',
        people: 'Gli account di questo Home, i loro ruoli e se possono accedere.',
        policies: 'Chi può accedere, come vengono creati gli account e come sono protetti i dati.',
        teams: 'Tutti i team di questo Home. Amministrare un team non ti dà accesso alle sue sessioni.',
        identityProvider: 'Un servizio di identità con cui accedere a questo Home.',
        identityProviderEditor: 'Come si collega questo servizio di identità e chi ammette.',
        githubApp: 'Una GitHub App che questo Home usa per accedere ai repository.',
        githubAppEditor: 'Registra o modifica una GitHub App per questo Home.',
        email: 'Come questo Home invia le email.',
        reach: 'Come dispositivi, link di invito ed email trovano questo Home.',
        runtime: 'Il server su cui gira questo Home.',
        activity: 'Chi ha cambiato cosa in questo Home, e quando.',
    },
    overview: 'Panoramica',
    people: 'Persone',
    teams: 'Team',
    policies: 'Criteri',
    console: {
        serverSettings: 'Impostazioni del server',
        serverSettingsDescription: 'Ogni impostazione letta dal server e quando una modifica si applica.',
        allHomes: 'Tutte le Home',
        backToHomes: 'Torna alle Home',
        viewerOwner: 'Sei il proprietario',
        viewerAdmin: 'Sei un amministratore',
        noOwnerYet: 'Ancora nessun proprietario',
        administer: 'Amministra',
        navigation: 'Pagine di amministrazione della Home',
    },
    /** The console Overview (lab `hcOverview-A`): what needs the owner, who owns the Home, and its facts. */
    overviewPage: {
        description: 'Chi gestisce questo Home e cosa richiede la tua attenzione.',
        attention: 'Richiede la tua attenzione',
        emailNotSetUpTitle: 'L’email non è configurata',
        emailNotSetUpBody: 'Nessuno può verificare il proprio indirizzo, reimpostare una password o ricevere inviti via email.',
        emailNoLinkTitle: 'Le email non possono ancora contenere link',
        emailNoLinkBody: 'L’invio è configurato, ma questo Home non ha un indirizzo della web app per i link.',
        emailPasswordTitle: 'La password della posta non è leggibile',
        emailPasswordBody: 'Inserisci di nuovo la password SMTP perché questo Home possa inviare email.',
        setUpEmail: 'Configura email',
        openEmail: 'Apri Email',
        noAddressTitle: 'Nessun indirizzo pubblico',
        noAddressBody: 'I dispositivi su altre reti e i link di invito non raggiungono questo Home.',
        setUpReach: 'Configura',
        githubPartlySetUp: 'L’accesso con GitHub è configurato solo in parte',
        workosPartlySetUp: 'WorkOS è configurato solo in parte',
        workosNeedsClientIdBody: 'Serve un ID client prima che i team possano collegare l’accesso aziendale.',
        workosNeedsApiKeyBody: 'Serve una chiave API prima che i team possano collegare l’accesso aziendale.',
        githubNeedsClientIdBody: 'Serve un ID client prima che si possa accedere con GitHub.',
        githubNeedsClientSecretBody: 'Serve un client secret prima che si possa accedere con GitHub.',
        finish: 'Completa',
        nameDescription: 'Mostrato nell’app e negli inviti.',
        review: 'Rivedi',
        settingsFailed: 'Impossibile controllare le impostazioni di questo Home',
        emailFailed: 'Impossibile leggere lo stato della posta di questo Home',
        reachFailed: 'Impossibile leggere come si raggiunge questo Home',
        ownership: 'Proprietà',
        ownerYou: 'Proprietario · tu',
        peopleFailed: 'Impossibile leggere le persone di questo Home',
        thisHome: 'Questo Home',
        version: 'Versione',
        signIn: 'Accesso',
        signInOpen: 'chiunque può creare un account',
        signInInvited: 'solo su invito',
        signInNone: 'Nessun metodo di accesso è attivo',
        /** People · owners · admins; `more` while the Home has further pages, `admins` null when unknown. */
        peopleSummary: ({ people, more, owners, admins }: { people: number; more: boolean; owners: number; admins: number | null }) => [`${people}${more ? '+' : ''} ${people === 1 && !more ? 'persona' : 'persone'}`, `${owners} ${owners === 1 ? 'proprietario' : 'proprietari'}`, admins === null ? null : `${admins} admin`].filter((part) => part !== null).join(' · '),
    },
    /** "Invite people" on Overview, People and Teams: one dialog over the Team invitation form. */
    invite: {
        action: 'Invita persone',
        description: 'Si entra in questo Home unendosi a uno dei suoi team.',
        team: 'Team',
        noTeams: 'Non c’è ancora un team a cui puoi invitare',
        noTeamsBody: 'Si entra in un Home unendosi a un team. Creane prima uno.',
        notAdministered: 'Non puoi invitare nei team di questo Home',
        notAdministeredBody: 'Sono i proprietari e gli admin di ogni team a invitare. Chiedi a uno di loro o crea un team tuo.',
        createTeam: 'Crea un team',
        notAdministeredAskBody: 'Sono i proprietari e gli admin di ogni team a invitare; chiedi a uno di loro.',
        joinByTeam: 'Si entra in un Home unendosi a un team.',
        teamsFailed: 'Impossibile leggere i team di questo Home',
    },

    yourRole: 'Il tuo ruolo',
    roleOwner: 'Proprietario',
    roleAdmin: 'Amministratore',
    roleMember: 'Membro',
    activeOwners: 'Proprietari attivi',
    accountSection: 'Account',
    accountAccessSection: 'Accesso',
    homeAddress: 'Indirizzo dell’Home',

    setupRequiredTitle: 'Configurazione dell’amministrazione richiesta',
    setupRequiredBody: 'Questo Home non ha ancora un proprietario attivo. Chi ha accesso al server assegna il primo proprietario dalla macchina che lo esegue.',

    manageTeams: 'Gestisci i team',
    manageTeamsSubtitle: 'Amministra i team di questo Home. Questo non ti dà accesso alle loro sessioni.',
    teamsDisabled: 'I team non sono abilitati su questo Home.',
    teamsEmpty: 'Nessun team su questo Home per ora.',

    loading: 'Caricamento dell’Home…',
    refreshing: 'Aggiornamento…',
    updating: 'Aggiornamento…',
    staleNotice: 'Viene mostrato l’ultimo stato noto di questo Home. Le modifiche non sono possibili finché non risponde di nuovo.',
    offlineNotice: 'Questo Home non risponde. Puoi continuare a leggere, ma non modificare.',
    unavailableTitle: 'Questo Home non è disponibile',
    unavailableBody: 'Happier non è riuscito a leggere lo stato di amministrazione di questo Home.',
    forbiddenTitle: 'Non puoi amministrare questo Home',
    forbiddenBody: 'Il tuo account non ha autorità di amministrazione qui.',
    retry: 'Riprova',
    loadMore: 'Carica altro',
    unsupportedBody: 'Questo Home non offre l’amministrazione. Potrebbe eseguire una versione precedente.',
    notObservedTitle: 'Non ancora caricato',
    notObservedBody: 'Questo Home non ha ancora comunicato il suo stato di amministrazione a questo dispositivo.',
    lastUpdated: ({ time }: { time: string }) => `Aggiornato ${time}`,

    chooseHome: 'Scegli un Home',
    chooseHomeFooter: 'Ogni Home ha i propri account, ruoli e criteri.',
    homesEmpty: 'Nessun Home per ora',
    homesEmptyBody: 'Aggiungi un Home a questo dispositivo per amministrarlo qui.',
    homesNoneAdministrable: 'Nessun Home da amministrare',
    homesNoneAdministrableBody: 'Nessuno degli Home visualizzati dà a questo account autorità di amministrazione.',
    homeNotAnswering: ({ home }: { home: string }) => `${home} non risponde`,
    signedOutTitle: 'Disconnesso da questo Home',
    signedOutBody: 'Accedi di nuovo a questo Home per amministrarlo.',
    credentialUnreadableTitle: 'Impossibile leggere l’accesso salvato su questo dispositivo',
    credentialUnreadableBody: 'Il problema riguarda questo dispositivo, non l’Home, e non sei stato disconnesso. Riprova.',
    credentialUnreadableInviteBody: 'Il problema riguarda questo dispositivo, non l’Home. Il tuo link di invito funziona ancora, quindi puoi riprovare ora o tornarci più tardi.',

    peopleEmpty: 'Ancora nessun account su questo Home.',
    rosterUnavailableTitle: 'L’elenco delle persone non è ancora disponibile',
    rosterUnavailableBody: 'Questo Home non fornisce ancora l’elenco degli account a Happier. Ruoli e stato appariranno qui quando lo farà.',
    accountUnavailableBody: 'Questo account non è ancora disponibile da questo Home.',
    searchPlaceholder: 'Cerca account',
    searchResults: 'Risultati della ricerca',
    searchResultsFooter: 'Apri un account per vederne ruolo e stato.',
    searchEmpty: 'Nessun account corrisponde a questa ricerca.',
    searchUnsupported: 'La ricerca non è disponibile su questo Home',
    searchUnsupportedBody: 'Questo Home non offre la ricerca degli account. Potrebbe usare una versione precedente.',
    searchFailed: 'Non è stato possibile completare la ricerca',
    searchFailedBody: 'Questo Home non ha risposto alla ricerca. Modifica il testo per riprovare.',

    statusActive: 'Attivo',
    statusDisabled: 'Disattivato',
    statusRetired: 'Ritirato',
    statusDisabledDetail: 'Disconnesso ovunque. Può essere riattivato.',
    statusRetiredDetail: 'Accesso revocato definitivamente.',

    changeRole: 'Cambia ruolo',
    disable: 'Disattiva account',
    enable: 'Riattiva account',
    deleteAccount: 'Elimina account e dati…',
    retryDeletion: 'Riprova l’eliminazione',

    reasonLastActiveOwner: 'Questo Home ha bisogno di almeno un proprietario attivo. Rendi prima proprietario un altro account.',
    reasonTargetInactive: 'Solo un account attivo può avere un ruolo nell’Home.',
    reasonHomeUnreachable: 'Questo Home non risponde. Le modifiche saranno possibili dopo la riconnessione.',

    roleSheetTitle: 'Ruolo nell’Home',
    roleOwnerDescription: 'Può amministrare tutto in questo Home, inclusa l’eliminazione degli account.',
    roleAdminDescription: 'Può amministrare account e team, ma non cambiare i proprietari.',
    roleMemberDescription: 'Nessuna autorità di amministrazione dell’Home.',

    disableTitle: ({ account }: { account: string }) => `Disattivare ${account}?`,
    disableBody: 'Verrà disconnesso su tutti i dispositivi e le sue macchine si scollegheranno. I token di accesso personali vengono revocati definitivamente, la responsabilità delle sessioni viene rimossa e, in ogni sessione a cui perde l’accesso, le sue bozze non inviate vengono eliminate e il suo Segui viene rimosso. Riattivandolo torna l’accesso, ma non quelle bozze, il Segui o la responsabilità. L’appartenenza ai team e le chiavi di cifratura vengono mantenute.',
    disableConfirm: 'Disattiva',
    enableTitle: ({ account }: { account: string }) => `Riattivare ${account}?`,
    enableBody: 'Potrà accedere di nuovo dai suoi dispositivi. I token di accesso revocati restano revocati.',
    enableConfirm: 'Riattiva',
    deleteTitle: ({ account }: { account: string }) => `Eliminare ${account} e tutti i suoi dati?`,
    deleteBody: ({ home }: { home: string }) => `Questo elimina definitivamente l’account e i suoi dati su ${home}. Non è reversibile. La proprietà di Home o team va trasferita prima.`,
    deleteConfirm: 'Elimina',

    deleteIncompleteTitle: 'L’eliminazione non è stata completata',
    deleteIncompleteBody: 'L’accesso è stato revocato e questo account ora è ritirato, ma la pulizia non è terminata. Riprova l’eliminazione per completarla.',
    deleteIncompleteMemberBody: 'L’accesso è stato revocato, ma la pulizia non è terminata. Un proprietario dell’Home o l’operatore del server può completarla.',

    errorForbidden: 'Non hai più l’autorità per questa modifica su questo Home.',
    errorOwnerTransferRequired: 'Questo Home ha bisogno di almeno un proprietario attivo. Rendi prima proprietario un altro account.',
    errorTeamOwnerTransferRequired: 'Un team ha ancora bisogno di questo account come proprietario. Assegna prima un altro proprietario a quel team.',
    errorAccountNotFound: 'Questo account non esiste più su questo Home.',
    errorAccountInactive: 'Questo account non è attivo, quindi non può ricevere questa autorità.',
    errorErasureTransitionCleanupPending: 'L’eliminazione dell’account attende la pulizia della crittografia. Prova a eliminare di nuovo l’account.',
    errorGeneric: 'Questo Home non ha potuto completare la modifica. Non è stato cambiato nulla.',
    errorConflict: 'Qui è stato modificato prima qualcos’altro. Aggiorna questo Home e riprova.',
    changeFailedTitle: 'La modifica non è andata a buon fine',
    errorOutcomeUnknownTitle: 'Questa modifica non è stata confermata',
    errorOutcomeUnknown: 'La richiesta ha raggiunto questo Home, ma la risposta è andata persa. Potrebbe essere stata applicata. Aggiorna questo Home e controlla prima di riprovare.',

    teamCreation: 'Creazione dei team',
    teamCreationSelfService: 'Chiunque può creare team',
    teamCreationSelfServiceDescription: 'I membri attivi di questo Home possono creare un team e diventarne proprietari.',
    teamCreationManagedOnly: 'Gli amministratori creano i team',
    teamCreationManagedOnlyDescription: 'Proprietari e amministratori creano i team e scelgono il proprietario iniziale.',
    teamCreationDisabled: 'Creazione dei team disattivata',
    teamCreationDisabledDescription: 'Nessun nuovo team. I team esistenti restano invariati.',
    teamCreationWho: 'Chi può creare team',
    teamCreationAnyone: 'Chiunque',
    teamCreationAdmins: 'Amministratori',
    teamCreationNobody: 'Nessuno',
    teamsVisibility: 'Chi vede i team',
    teamsVisibleToMembers: 'Mostra i team ai membri',
    teamsVisibleToMembersDescription: 'Se disattivato, solo i membri di un team e gli amministratori vedono i team.',
    teamJit: 'Adesione automatica al team all’accesso',
    teamJitDescription: 'Accedere tramite il provider di identità collegato a un team fa entrare automaticamente in quel team, senza invito né approvazione.',
    githubEnterpriseOrigins: 'Host GitHub Enterprise approvati',
    githubEnterpriseOriginsDescription: 'Un’origine HTTPS canonica per riga. I team possono collegare le GitHub App solo a questi host.',
    githubEnterpriseOriginsInvalid: 'Usa origini HTTPS univoche senza percorsi, query, credenziali o frammenti.',

    signInTitle: 'Accesso e ammissione',
    authActionLogin: 'Accesso',
    authActionProvision: 'Nuovi account',
    authActionConnect: 'Collegamento account',
    authReasonMethodNotEnabled: 'Il metodo di accesso è disattivato',
    authReasonProvisioningNotEnabled: 'La creazione di account è disattivata',
    authReasonAccountModeUnavailable: 'Il tipo di account non è disponibile',
    authReasonEmailDeliveryUnavailable: 'L’invio di email non è disponibile',
    authInherited: 'Vengono usati i valori del server',
    authInheritedDescription: 'Questo Home non restringe i metodi di accesso né i tipi di account.',
    authNarrowed: 'Ristretto da questo Home',
    authUnreadable: 'La configurazione richiede attenzione',
    authUnreadableDescription: 'Questo Home memorizza una configurazione di accesso che questa versione del server non riesce a leggere. L’accesso non è disponibile finché l’operatore non la ripara.',
    signInMethods: 'Metodi di accesso',
    accountModes: 'Tipi di account',
    accountModePlain: 'Semplice',
    accountModeE2ee: 'Cifrato end-to-end',
    recommendedMode: 'Consigliato per i nuovi account',
    recommendedModeDescription: 'Imposta il valore predefinito per i nuovi account. Gli account esistenti non vengono modificati.',
    admissionSelfService: 'Chiunque',
    admissionInvitationOnly: 'Solo su invito',
    admissionClosed: 'Nessuno',

    deploymentServices: 'Servizi del deployment',
    deploymentServicesDescription: 'Servizi di identità che l’operatore configura per questo server. Non si cambiano dall’amministrazione dell’Home.',
    privateEndpoints: 'Endpoint di identità privati',
    privateEndpointsDescription: 'Consenti all’accesso gestito di raggiungere provider di identità su reti private. Sono raggiungibili solo host, reti e porte elencati qui.',
    privateEndpointsPublicOnly: 'Solo endpoint pubblici',
    privateEndpointsAllowlist: 'Elenco privato consentito',
    privateEndpointsHostnames: 'Nomi host consentiti',
    privateEndpointsCidrs: 'Reti consentite (CIDR)',
    privateEndpointsPorts: 'Porte consentite',
    privateEndpointsSave: 'Salva criterio di rete',
    privateEndpointsInvalid: 'Indica almeno un nome host o una rete e una porta tra 1 e 65535.',
    privateEndpointsUnreadable: 'Questo Home conserva un criterio di rete che questa versione del server non sa leggere. L’accesso gestito resta sugli endpoint pubblici.',

    policyReadOnly: 'Solo un proprietario dell’Home può modificarlo.',
    policyEditingUnavailable: 'Non è ancora possibile modificare i criteri da questo dispositivo.',
    revisionConflictTitle: 'Questo criterio è cambiato altrove',
    revisionConflictBody: 'Qualcun altro ha salvato una modifica mentre stavi modificando. La tua scelta è conservata: ricarica questo Home e applicala di nuovo.',
    reload: 'Ricarica',
    person: {
        you: 'tu',
        roleDescription: 'I membri usano la Home; gli admin gestiscono anche persone e Team.',
        roleChangeTitle: ({ account, role }: { account: string; role: string }) => `Rendere ${account} ${role}?`,
        roleChangeBody: 'Il suo accesso a questa Home cambia subito. Viene registrato in Attività con il tuo nome.',
        roleChangeConfirm: 'Cambia ruolo',
        signIn: 'Accesso',
        signInDescription: 'Con cosa può accedere. Lo gestisce nel proprio account.',
        methods: 'Metodi',
        linkedProviders: 'Provider collegati',
        none: 'Nessuno',
        teams: 'Team',
        noTeams: 'In nessun Team',
        teamArchived: 'Team archiviato',
        teamSuspended: 'sospeso',
        access: 'Accesso ai dispositivi',
        accessDescription: 'Accesso eseguito sui suoi dispositivi — le sessioni non sono tracciate singolarmente.',
        machines: 'Macchine',
        apiTokens: 'Token API',
        apiTokensLastUsed: ({ time }: { time: string }) => `Ultimo uso ${time}`,
        apiTokensNeverUsed: 'Mai usato',
        signOutEverywhere: 'Disconnetti ovunque',
        signOutEverywhereDescription: 'Chiude ogni sessione aperta su tutti i suoi dispositivi. I token API continuano a funzionare finché l’account non viene disattivato.',
        signOutEverywhereTitle: ({ account }: { account: string }) => `Disconnettere ${account} ovunque?`,
        signOutEverywhereBody: 'Ogni dispositivo su cui ha eseguito l’accesso dovrà accedere di nuovo. I suoi token API continuano a funzionare finché non disattivi l’account. Viene registrato in Attività con il tuo nome.',
        signOutEverywhereDone: 'Disconnesso ovunque',
        recentActivity: 'Attività recente',
        noRecentActivity: 'Ancora nessuna modifica amministrativa che la riguardi.',
        showAllActivity: 'Mostra tutto',
        disableOrDelete: 'Disattiva o elimina',
        dangerFootnote: 'Disattivare la disconnette e ferma i suoi token API; si può annullare. Eliminare rimuove per sempre il suo account e i suoi dati da questa Home.',
    },
    email: {
        title: 'Email',
        status: 'Stato',
        sendingMail: 'Invio email',
        sendingReady: ({ host }: { host: string }) => `Pronto · invia tramite ${host}`,
        sendingNotSetUp: 'Non configurato',
        links: 'Link nelle email',
        linksReady: 'Si aprono nell’app web di questo Home',
        linksOpenAt: ({ host }: { host: string }) => `Si aprono su ${host}`,
        setInReach: 'Imposta in Raggiungibilità',
        linksMissing: 'Nessun indirizzo dell’app web, quindi i link non possono essere creati',
        mailServer: 'Server di posta',
        mailServerDescription: 'Il server SMTP che invia le email di verifica, di reimpostazione della password e di invito.',
        server: 'Server',
        port: 'Porta',
        portAndSecurity: 'Porta e sicurezza',
        security: 'Sicurezza della connessione',
        tls: 'TLS',
        starttls: 'STARTTLS',
        username: 'Nome utente',
        password: 'Password',
        passwordDescription: 'Salvata cifrata sul server. Non viene più mostrata.',
        saved: 'Salvata',
        replace: 'Sostituisci',
        clear: 'Rimuovi',
        keep: 'Mantieni',
        clearPending: 'La password salvata verrà rimossa al salvataggio.',
        valueSet: 'Impostata',
        valueNotSet: 'Non impostata',
        sender: 'Mittente',
        fromAddress: 'Indirizzo del mittente',
        fromName: 'Nome del mittente',
        test: 'Invia un’email di prova',
        testDescription: 'Invia un breve messaggio senza link.',
        testTo: 'A',
        testToPlaceholder: 'Un indirizzo che puoi controllare',
        testSend: 'Invia',
        testSaveFirst: 'Salva le modifiche prima di inviare una prova.',
        testSent: ({ to }: { to: string }) => `Inviata a ${to}`,
        testSentDetail: 'Controlla la posta in arrivo e, se non c’è, la cartella spam.',
        testFailed: 'Invio non riuscito',
        testNotConfigured: 'L’email non è ancora configurata.',
        testPasswordUnreadable: 'La password salvata non è leggibile. Inseriscila di nuovo.',
        testRenderFailed: 'Non è stato possibile preparare il messaggio di prova.',
        testTransportFailed: 'Il server di posta non è raggiungibile o ha rifiutato il messaggio.',
        adminTitle: 'Solo i proprietari possono cambiare le impostazioni email',
        adminBody: 'Le vedi perché sei admin di questo Home.',
        notSetUpTitle: 'L’email non è configurata',
        notSetUpBody: 'Reimpostazione della password, verifica email e inviti via email sono disattivati finché non lo è.',
        unreadableTitle: 'La password salvata non è leggibile',
        unreadableBody: 'Il segreto principale del server è cambiato da quando è stata salvata. Inserisci di nuovo la password.',
        invalidValue: 'Inserisci un valore valido.',
        invalidPort: 'Usa una porta da 1 a 65535.',
        invalidEmail: 'Inserisci un indirizzo email.',
        conflictTitle: 'Le impostazioni email sono cambiate altrove',
        conflictBody: 'Qualcuno ha salvato una modifica mentre stavi modificando. Le tue modifiche sono mantenute: controllale e salva di nuovo.',
        loadFailed: 'Questo Home non ha restituito le sue impostazioni email.',
    },
    signInProviders: {
        title: 'Provider di accesso',
        description: 'Come le persone accedono a questo Home e cosa possono collegare i suoi team.',
        ownersOnlyTitle: 'Solo i proprietari possono modificare i provider di accesso',
        ownersOnlyBody: 'Chiedi a un proprietario di questo Home di aggiungere o modificare provider di identità e GitHub App.',
        fromDeploymentReadOnly: 'Dal tuo deployment · sola lettura',
        platformsDescriptionReadOnly: ({ home }: { home: string }) => `Le app con cui ${home} fa accedere le persone. Solo i proprietari di ${home} possono modificarle.`,
        fieldClientId: 'ID client',
        fieldClientSecret: 'Client secret',
        fieldApiKey: 'Chiave API',
        workosClientIdHint: 'In WorkOS, sotto Chiavi API.',
        githubClientIdHint: 'Nella pagina delle impostazioni della tua app OAuth di GitHub.',
        secretHintUnset: 'Salvato cifrato e mai più mostrato.',
        secretHintSet: 'Salvato cifrato, mai mostrato.',
        neededWorkos: 'Necessario prima che i team possano connettersi',
        neededGithub: 'Necessario prima di poter attivare l’accesso con GitHub',
        secretPlaceholder: 'Incolla la chiave',
        lockedFootnote: 'I valori impostati dal tuo deployment si possono cambiare solo dove gira il server.',
        ignoredBannerTitle: 'Un’impostazione di accesso è stata ignorata all’ultimo avvio',
        showMe: 'Mostra',
        callbackAddress: 'Indirizzo di callback',
        callbackAddressHint: 'Registralo nell’app OAuth di GitHub.',
        whoCanSignInGithub: 'Chi può accedere con GitHub',
        companySignIn: 'Accesso aziendale',
        companySignInDescription: 'I provider OpenID Connect con cui persone e team possono accedere.',
        addProvider: 'Aggiungi provider',
        privateEndpointsTitle: 'Endpoint privati',
        privateEndpointsPublicOnlyShort: 'Solo pubblici',
        privateEndpointsAllowlistShort: 'Lista consentita',
        privateEndpointsPublicOnlyHint: 'I provider devono trovarsi a un indirizzo pubblico.',
        privateEndpointsAllowlistHint: 'Solo gli host qui sotto possono essere privati.',
        platforms: 'Piattaforme di accesso',
        platformsDescription: ({ home }: { home: string }) => `Le app con cui ${home} fa accedere le persone: GitHub per tutti, WorkOS per l’accesso aziendale di ogni team.`,
        githubSignIn: 'Accesso con GitHub',
        githubPurpose: ({ home }: { home: string }) => `L’app OAuth di GitHub con cui le persone accedono a ${home}. Attiva o disattiva l’accesso con GitHub in Criteri.`,
        workosPurpose: ({ home }: { home: string }) => `Consente a ogni team di ${home} di collegare il proprio accesso aziendale e la propria directory tramite WorkOS, dalla pagina Autenticazione del team.`,
        notSetGithub: 'Non configurato · l’accesso con GitHub resta disattivato fino ad allora',
        notSetWorkos: 'Non configurato · i team non possono ancora usare WorkOS',
        needsClientId: 'Serve un ID client',
        needsClientSecret: 'Serve un segreto client',
        needsApiKey: 'Serve una chiave API',
        pendingSummaryWorkos: 'Salvato · i team potranno connettersi dopo il prossimo riavvio',
        pendingSummaryGithub: 'Salvato · usato dopo il prossimo riavvio',
        lockedSummary: 'Impostato dal tuo deployment',
        readyPartlyLocked: ({ setting }: { setting: string }) => `Pronto · ${setting} impostato dal tuo deployment`,
        readyWorkos: 'Pronto · i team possono collegarsi tramite esso',
        readyGithubOn: 'Pronto · le persone possono accedere con GitHub',
        readyGithubOff: 'Pronto · attiva l’accesso con GitHub in Criteri',
        advanced: 'Avanzate',
        appliesAfterRestart: 'Le modifiche qui si applicano al riavvio del server.',
        privateEndpointsOffHere: 'Disattivato per questo Home',
        teamRules: 'Regole di accesso dei Team',
        teamRulesDescription: 'Cosa possono aggiungere i Team ai provider dell’Home.',
        activity: {
            addedProvider: ({ name }: { name: string }) => `ha aggiunto il provider di identità ${name}`,
            changedProvider: ({ name }: { name: string }) => `ha modificato il provider di identità ${name}`,
            replacedProviderSecret: ({ name }: { name: string }) => `ha sostituito il client secret di ${name}`,
            enabledProvider: ({ name }: { name: string }) => `ha attivato ${name}`,
            disabledProvider: ({ name }: { name: string }) => `ha disattivato ${name}`,
            removedProvider: ({ name }: { name: string }) => `ha rimosso il provider di identità ${name}`,
            addedGitHubApp: ({ name }: { name: string }) => `ha aggiunto la GitHub App ${name}`,
            changedGitHubApp: ({ name }: { name: string }) => `ha modificato la GitHub App ${name}`,
            replacedGitHubAppSecrets: ({ name }: { name: string }) => `ha sostituito i secret della GitHub App ${name}`,
            verifiedGitHubApp: ({ name, organization }: { name: string; organization: string }) => `ha verificato ${name} su ${organization}`,
            removedGitHubAppInstallation: ({ name, organization }: { name: string; organization: string }) => `ha rimosso ${name} da ${organization}`,
        },
    },
    reach: {
        title: 'Raggiungibilità',
        diagramTitle: ({ home }: { home: string }) => `Come un nuovo dispositivo raggiunge ${home}`,
        yourDevices: 'I tuoi dispositivi',
        noAddress: 'Nessun indirizzo pubblico',
        plusDirect: '+ diretto (Iroh) quando possibile',
        noDirect: 'Nessuna connessione diretta',
        thisComputer: 'Questo computer',
        homeServer: 'Server di questo Home',
        diagramDeployment: 'Fissato dal tuo deployment',
        diagramHere: 'Impostato qui',
        diagramInferred: ({ method }: { method: string }) => `${method} · dedotto`,
        addresses: 'Indirizzi',
        addressesDescription: 'Cambiare un indirizzo non disconnette mai nessuno.',
        publicAddress: 'Indirizzo pubblico',
        webAppAddress: 'Indirizzo dell’app web',
        accessMethod: 'Metodo di accesso',
        publicAddressHome: 'Impostato qui',
        publicAddressNone: 'Non impostato. I dispositivi di altre reti non possono raggiungere questo Home.',
        inferredFrom: ({ method }: { method: string }) => `Dedotto da ${method} sul computer che ospita questo Home`,
        inferredFromHost: 'Dedotto sul computer che ospita questo Home',
        webAppDescription: 'I link di email e inviti si aprono qui.',
        webAppServed: 'I link si aprono nell’app web servita da questo Home.',
        webAppDefault: 'I link si aprono nell’app web di Happier. Predefinito',
        change: 'Cambia',
        setAddress: 'Imposta indirizzo',
        httpsRequired: 'Usa un indirizzo https://.',
        invalidAddress: 'Inserisci un indirizzo completo, come https://home.example.com.',
        conflict: 'Le impostazioni di questo Home sono cambiate. Riprova.',
        methodLocalOnly: 'Solo questo computer',
        methodLan: 'Rete locale',
        methodTailscaleServe: 'Tailscale Serve',
        methodTailscaleFunnel: 'Tailscale Funnel',
        methodCloudflare: 'Cloudflare Tunnel',
        accessMethodHere: 'Come questo computer espone l’Home.',
        accessMethodRemoteHost: ({ host }: { host: string }) => `Si imposta su ${host}. Aprilo in Host remoti.`,
        accessMethodElsewhereNamed: ({ host }: { host: string }) => `Si imposta sul computer che ospita questo Home (${host}). Apri Happier lì o aggiungilo come host remoto.`,
        accessMethodElsewhere: 'Si imposta sul computer che ospita questo Home. Apri Happier lì o aggiungilo come host remoto.',
        accessMethodDeployment: 'Gestito dal tuo deployment.',
        directConnections: 'Connessioni dirette',
        directConnectionsDescription: 'I dispositivi si collegano direttamente a questo Home quando possono, altrimenti usano l’indirizzo pubblico.',
        directConnectionsRow: 'Connessioni dirette (Iroh)',
        irohActive: 'Attive · i dispositivi si collegano peer-to-peer quando possono',
        irohStarting: 'Avvio…',
        irohOff: 'Disattivate · i dispositivi si collegano tramite l’indirizzo pubblico',
        irohFailed: 'Non in esecuzione su questo computer. I dispositivi si collegano tramite l’indirizzo pubblico.',
        irohNotAvailable: 'Non disponibile su questo deployment. I dispositivi si collegano tramite l’indirizzo pubblico.',
        irohNeedsAddressHint: 'Imposta un indirizzo pubblico prima di disattivarle',
        irohOffTitle: 'Disattivare le connessioni dirette?',
        irohOffBody: 'I dispositivi si collegheranno solo tramite l’indirizzo pubblico. L’attuale identità di connessione diretta di questo Home viene ritirata per sempre; riattivarle ne crea una nuova, che i dispositivi adottano alla prossima connessione. L’indirizzo pubblico e gli accessi restano invariati.',
        irohOffConfirm: 'Disattiva',
        irohNeedsAddressTitle: 'Imposta prima un indirizzo pubblico',
        irohNeedsAddressBody: 'Senza un indirizzo pubblico, i dispositivi non potrebbero più raggiungere questo Home dopo aver disattivato le connessioni dirette.',
        relay: 'Relay per le connessioni dirette',
        relayAutomatic: 'Automatico',
        relayOff: 'Disattivato',
        relayCustom: ({ count }: { count: number }) => `I tuoi relay (${count}) · Si applica dopo il riavvio`,
        appliesAfterRestart: 'Si applica dopo il riavvio',
        appliesAfterRestartPending: 'Si applica dopo il riavvio · In attesa',
        exposureInternetTitle: ({ method }: { method: string }) => `Raggiungibile da internet tramite ${method}`,
        exposureAddressTitle: 'Il tuo indirizzo pubblico è aperto alle registrazioni',
        exposureOpenSignup: 'Chiunque raggiunga questo Home può creare un account. Controlla chi può registrarsi in Criteri.',
        exposureInvitationOnly: 'I nuovi account richiedono un invito, quindi gli estranei non possono registrarsi.',
        loadFailed: 'Impossibile caricare come si raggiunge questo Home.',
    },
    runtime: {
        title: 'Runtime',
        version: 'Versione',
        versionValue: ({ version }: { version: string }) => `Happier ${version}`,
        versionUnknown: 'Questo Home non indica la sua versione',
        flavorLight: 'Server leggero',
        flavorFull: 'Server completo',
        server: 'Server',
        restart: 'Riavvia',
        restartNow: 'Riavvia ora',
        restartFailed: 'Impossibile riavviare il server',
        waitingForHome: 'Riavvio in corso, in attesa che il Home torni disponibile.',
        restartToApply: 'Riavvia il server per applicarle.',
        restartFromDeployment: 'Riavvia dal tuo deployment per applicarle.',
        restartFromHost: ({ host }: { host: string }) => `Riavvia da ${host}, il computer che ospita questo Home.`,
        restartFromHostingComputer: 'Riavvia dal computer che ospita questo Home.',
        managedFrom: ({ host }: { host: string }) => `Gestito da ${host}`,
        managedFromBody: 'Apri Happier sul computer che ospita questo Home per aggiornarlo, riavviarlo o fermarlo.',
        managedElsewhere: 'Gestito dal computer che ospita questo Home',
        deploymentTitle: 'Gestito dal tuo deployment',
        deploymentBody: 'Aggiornamenti, riavvii e backup di questo server li gestisce chi lo distribuisce.',
        backups: 'Backup',
        backupsHere: 'Esegui backup, ripristina o sposta questo Home dalla sua pagina Runtime.',
        backupsFromHost: ({ host }: { host: string }) => `Esegui il backup da ${host}, il computer che ospita questo Home.`,
        backupsFromHostingComputer: 'Esegui il backup dal computer che ospita questo Home.',
        backupsDeployment: 'I backup sono gestiti dal tuo deployment.',
        hostedHere: ({ home }: { home: string }) => `Questo computer ospita ${home}`,
        hostedHereSubtitle: 'Aggiornalo, riavvialo, esegui backup e spostalo dalla sua console Home.',
        pendingRestart: ({ count }: { count: number }) => (count === 1 ? '1 modifica si applica dopo il riavvio' : `${count} modifiche si applicano dopo il riavvio`),
    },
    activity: {
        title: 'Attività',
        emptyTitle: 'Ancora nessuna attività',
        emptyBody: 'Le modifiche ad accesso, email, persone, criteri e proprietà compaiono qui man mano che avvengono.',
        showOlder: 'Mostra precedenti',
        footnote: 'Le azioni eseguite con Happier direttamente sul computer host, come backup e riavvii, non sono elencate.',
        loadFailed: 'Questo Home non ha restituito la sua attività.',
        deploymentCommand: 'Comando di deployment',
        personalHomeSetup: 'Configurazione del Personal Home',
        someone: 'Qualcuno',
        removedAccount: 'un account rimosso',
        claimed: 'ha rivendicato la proprietà di questo Home',
        madeOwner: ({ target }: { target: string }) => `ha reso ${target} proprietario`,
        assignedOwner: 'ha assegnato il primo proprietario',
        changedPolicies: 'ha cambiato i criteri',
        changedEmailSetting: 'ha aggiornato le impostazioni email',
        changedServerSetting: 'ha cambiato le impostazioni del server',
        changedRole: ({ target }: { target: string }) => `ha cambiato il ruolo di ${target}`,
        disabled: ({ target }: { target: string }) => `ha disattivato ${target}`,
        reenabled: ({ target }: { target: string }) => `ha riattivato ${target}`,
        changedStatus: ({ target }: { target: string }) => `ha cambiato lo stato di ${target}`,
        deleted: ({ target }: { target: string }) => `ha eliminato ${target}`,
        deletionStarted: ({ target }: { target: string }) => `ha iniziato a eliminare ${target}`,
        signedOutEverywhere: ({ target }: { target: string }) => `ha disconnesso ${target} ovunque`,
        areaOwnership: 'Proprietà',
        areaPolicies: 'Criteri',
        areaEmail: 'Email',
        areaServerSettings: 'Impostazioni del server',
        areaPeople: 'Persone',
        fieldRole: 'Ruolo',
        fieldStatus: 'Stato',
        fieldTeamProviders: 'Provider di accesso dei Team',
        valueEmpty: '—',
        valueChanged: 'modificato',
        valueOn: 'Attivo',
        valueOff: 'Disattivo',
        secretSet: 'impostata',
        secretUnset: 'non impostata',
    },
    signInPolicy: {
        methodsDescription: ({ home }: { home: string }) => `Come si accede a ${home}. Almeno un metodo resta attivo e nessuno perde il suo ultimo accesso.`,
        methodUnavailable: 'Non disponibile — il tuo deployment non può offrirlo',
        needsGithubApp: 'Serve prima un’app di accesso GitHub.',
        needsWorkos: 'Serve prima configurare WorkOS.',
        setUp: 'Configura',
        signInService: 'Servizio di accesso della Home',
        signInServiceDescription: 'Accedi tramite il servizio di accesso di questa Home.',
        admissionTitle: 'Chi può creare un account',
        newAccounts: 'Nuovi account',
        admissionAnyoneDescription: 'Chiunque possa raggiungere questa Home',
        admissionInvitationDescription: 'Solo chi ha un invito a un team',
        admissionNobodyDescription: 'Nessuno può creare un account',
        anonymousSignup: 'Registrazione anonima',
        anonymousSignupDescription: 'Crea un account solo con una chiave di recupero, senza email.',
        encryptionTitle: 'Crittografia',
        encryptionDescription: 'Si applica ad account e sessioni creati da ora in poi. Quelli esistenti non cambiano mai.',
        storagePolicy: 'Criterio di archiviazione',
        storageRequired: 'E2EE obbligatoria',
        storageOptional: 'Facoltativa',
        storagePlaintext: 'Solo testo in chiaro',
        storageRequiredDescription: 'Ogni account mantiene la crittografia end-to-end',
        storageOptionalDescription: 'Ogni account sceglie se cifrare',
        storagePlaintextDescription: 'Gli account salvano i dati senza crittografia end-to-end',
        storageAppliesAfterRestart: ({ running }: { running: string }) => `Si applica dopo il riavvio · fino ad allora ${running}`,
        allowE2ee: 'Account con crittografia end-to-end',
        allowPlain: 'Account senza crittografia end-to-end',
        recommendedInherited: 'Predefinito del server',
        recommendedE2ee: 'E2EE',
        errorWideningUnconfirmed: 'Questa modifica fa entrare più persone e richiede la tua conferma. Non è stato cambiato nulla.',
        widening: {
            titleAnyone: 'Consentire a chiunque di creare un account?',
            titleInvited: 'Consentire agli invitati di creare account?',
            titleMethod: ({ method }: { method: string }) => `Attivare ${method}?`,
            titleAnonymous: 'Consentire la registrazione anonima?',
            titleUnencrypted: 'Consentire l’archiviazione non cifrata?',
            titleOther: 'Far entrare più persone?',
            exposureAnyone: ({ host }: { host: string }) => `Chiunque raggiunga questa Home su ${host} potrà registrarsi senza invito.`,
            exposureInvited: ({ host }: { host: string }) => `Chiunque abbia un invito e raggiunga questa Home su ${host} potrà creare un account.`,
            exposureMethod: ({ host, method }: { host: string; method: string }) => `Chiunque raggiunga questa Home su ${host} potrà accedere con ${method}.`,
            exposureAnonymous: ({ host }: { host: string }) => `Chiunque raggiunga questa Home su ${host} potrà creare un account solo con una chiave di recupero.`,
            exposureUnencrypted: ({ host }: { host: string }) => `Chiunque raggiunga questa Home su ${host} potrà conservare qui i propri dati senza crittografia end-to-end.`,
            exposureOther: ({ host }: { host: string }) => `Chiunque raggiunga questa Home su ${host} potrà accedere o unirsi con le regole più ampie.`,
            unchanged: 'Gli account e gli inviti esistenti non cambiano.',
            recorded: 'La modifica viene registrata in Attività con il tuo nome.',
            confirmAnyone: 'Consenti a chiunque di registrarsi',
            confirmInvited: 'Consenti gli inviti',
            confirmMethod: ({ method }: { method: string }) => `Attiva ${method}`,
            confirmAnonymous: 'Consenti la registrazione anonima',
            confirmUnencrypted: 'Consenti l’archiviazione non cifrata',
            confirmOther: 'Applica la modifica',
        },
    },
    claim: {
        pageDescription: 'Rivendica la proprietà di questo Home.',
        emptyTitle: 'Questa Home non ha ancora un proprietario',
        emptyBody: 'Un proprietario gestisce accesso, email, raggiungibilità e persone. Finché qualcuno non la rivendica, nessuno può amministrare questa Home.',
        codeTitle: 'Rivendica con un codice monouso',
        codeDescription: 'Chi ha accesso al server stampa un codice. Funziona una volta e scade dopo 15 minuti.',
        printStep: '1 · Stampa un codice sul server',
        pasteStep: '2 · Incollalo qui',
        codeLabel: 'Codice di rivendicazione',
        codePlaceholder: 'XXXX-XXXX-XXXX-XXXX-…',
        claim: 'Rivendica',
        refused: 'Questo codice non ha funzionato. Potrebbe essere scritto male, già usato o scaduto — stampane uno nuovo.',
        hostTitle: ({ home }: { home: string }) => `Questo computer ospita ${home}`,
        hostBody: 'Puoi rendere il tuo account proprietario da qui. Solo questo computer può farlo in questo modo.',
        makeOwner: 'Rendimi proprietario',
        hostFailed: 'Questo computer non è riuscito a renderti proprietario. Riprova.',
    },
    fixedByDeployment: ({ key }: { key: string }) => `Impostato dal tuo deployment · ${key}`,
    fixedByDeploymentLead: 'Impostato dal tuo deployment',
    deploymentNotSetLead: 'Non disponibile finché il tuo deployment non imposta',
    features: {
        title: 'Funzionalità',
        common: 'Comuni',
        advanced: 'Avanzate',
        advancedDescription: ({ count }: { count: number }) => `Altre ${count}, raggruppate per area.`,
        other: 'Altro',
        familyCount_one: '1 funzionalità',
        familyCount_other: ({ count }: { count: number }) => `${count} funzionalità`,
        offHome: 'Disattivata per questo Home.',
        notInBuild: 'Non inclusa in questa build.',
        needs: ({ feature }: { feature: string }) => `Richiede ${feature}.`,
        unavailable: 'Non disponibile su questo Home.',
        noHomeSwitchOn: 'Sempre attiva su questo Home · solo la build di Happier può disattivarla',
        noHomeSwitchOff: 'Disattivata su questo Home · solo la build di Happier può attivarla',
        unavailableByDeployment: 'Non disponibile su questo Home · decide la configurazione del tuo deployment',
        dependentsTitle_one: ({ feature }: { feature: string }) => `Disattivare ${feature} disattiva anche 1 funzionalità`,
        dependentsTitle_other: ({ feature, count }: { feature: string; count: number }) => `Disattivare ${feature} disattiva anche ${count} funzionalità`,
        dependentNeeds: ({ feature, parent }: { feature: string; parent: string }) => `${feature} richiede ${parent}.`,
        turnOff: 'Disattiva',
        deviceTitle: 'Funzionalità di questo dispositivo',
        deviceBody: 'Le funzionalità che riguardano solo questo dispositivo sono in Impostazioni.',
        adminTitle: 'Solo i proprietari possono modificare le funzionalità',
        adminBody: 'Vedi cosa offre questo Home perché ne sei admin.',
        loadFailed: 'Questo Home non ha restituito le sue funzionalità.',
        conflictTitle: 'Funzionalità modificate altrove',
        conflictBody: 'Qualcuno ha modificato le impostazioni di questo Home mentre le guardavi. Ora la pagina mostra ciò che il Home contiene.',
        rangeBetween: ({ min, max }: { min: number; max: number }) => `${min}–${max}`,
        rangeAtLeast: ({ min }: { min: number }) => `${min} o più`,
        rangeAtMost: ({ max }: { max: number }) => `Fino a ${max}`,
        limitInvalid: 'Inserisci un numero nell’intervallo.',
        appliesAfterRestart: 'Si applica dopo il riavvio',
        onAfterRestart: 'Attiva dopo il riavvio',
        offAfterRestart: 'Disattiva dopo il riavvio',
        ignoredAtLastStart: ({ reason }: { reason: string }) => `Ignorato all’ultimo avvio: ${reason}`,
        ignoredInvalidType: 'il valore salvato è del tipo sbagliato',
        ignoredOutOfBounds: 'il valore salvato è fuori intervallo',
        ignoredSecretUnreadable: 'il segreto salvato non è leggibile',
        dependentsAfterRestartTitle_one: ({ feature }: { feature: string }) => `Dopo il prossimo riavvio, disattivare ${feature} disattiva anche 1 funzionalità`,
        dependentsAfterRestartTitle_other: ({ feature, count }: { feature: string; count: number }) => `Dopo il prossimo riavvio, disattivare ${feature} disattiva anche ${count} funzionalità`,
    },
    data: {
        title: 'Dati',
        deletion: 'Eliminazione automatica',
        deletionDescription: 'Le modifiche valgono dalla prossima pulizia.',
        dryRunMode: 'Modalità di prova',
        dryRunModeDescription: 'La pulizia conta invece di eliminare finché non la disattivi.',
        tryRules: 'Prova le regole attuali',
        tryRulesDescription: 'Esegue ora una pulizia senza eliminare nulla.',
        runDryRun: 'Esegui una prova',
        runAgain: 'Esegui di nuovo',
        ranAt: ({ time }: { time: string }) => `Eseguita alle ${time} · non è stato eliminato nulla`,
        sweepInProgress: 'È in corso una pulizia — riprova quando termina.',
        wouldDelete: ({ count, examined }: { count: string; examined: string }) => `Eliminerebbe ${count} · ${examined} esaminati`,
        nothingToDelete: 'Niente da eliminare',
        stopTimeBudget: 'interrotta: limite di tempo',
        stopRowBudget: 'interrotta: limite di eliminazione',
        stopCandidateBudget: 'interrotta: limite di esame',
        stopStalled: 'interrotta: nessun progresso',
        keep: 'Conserva',
        deleteAfter: 'Elimina dopo',
        days: 'giorni',
        daysFor: ({ domain }: { domain: string }) => `Giorni di conservazione per ${domain}`,
        daysRequired: 'Indica quanti giorni.',
        daysInvalid: 'Usa un numero intero di giorni, 1 o più.',
        defaultEffect: ({ effect }: { effect: string }) => `Predefinito · ${effect}`,
        alwaysRuns: 'Viene eseguita anche quando l’eliminazione automatica è disattivata.',
        expiresAutomatically: 'Scade automaticamente',
        systemRecords: 'Record di sistema',
        systemRecordsSummary_one: '1 tipo di record che questo Home conserva per sé',
        systemRecordsSummary_other: ({ count }: { count: number }) => `${count} tipi di record che questo Home conserva per sé`,
        adminTitle: 'Solo i proprietari possono cambiare ciò che questo Home conserva',
        adminBody: 'Vedi le regole perché ne sei admin.',
        loadFailed: 'Questo Home non ha restituito le sue impostazioni dei dati.',
        conflictTitle: 'Impostazioni dei dati modificate altrove',
        conflictBody: 'Qualcuno ha modificato le impostazioni di questo Home mentre le guardavi. Ora la pagina mostra ciò che il Home contiene.',
    },
};

const homeGovernanceTranslations = { it } as const;

return { homeGovernanceTranslations };
})();

const Domain_homeIndexTranslations = (() => {
type HomeIndexTranslation = Shared_homeIndexTranslations.HomeIndexTranslation;

const homeIndexTranslations = { it: {
        greetingMorning: ({ name }) => `Buongiorno, ${name}`,
        greetingAfternoon: ({ name }) => `Buon pomeriggio, ${name}`,
        greetingEvening: ({ name }) => `Buonasera, ${name}`,
        greetingMorningAnonymous: 'Buongiorno',
        greetingAfternoonAnonymous: 'Buon pomeriggio',
        greetingEveningAnonymous: 'Buonasera',
        sessionsWorking: ({ count }) => (count === 1 ? '1 sessione al lavoro' : `${count} sessioni al lavoro`),
        sessionsNeedYou: ({ count }) => `${count} ha${count === 1 ? '' : 'nno'} bisogno di te`,
        sessionsAwaitingResponse: ({ count }) => count === 1 ? '1 sessione attende la tua risposta' : `${count} sessioni attendono la tua risposta`,
        nothingRunning: 'Ancora niente in esecuzione',
        customize: 'Personalizza',
        customizeTitle: 'Personalizza la home',
        customizeDescription: 'Trascina per riordinare. Salvato nel tuo account, così ogni dispositivo mostra la stessa home.',
        customizing: "Personalizzazione della Home",
        customizingHint: "Trascina i widget dentro, fuori e tra i gruppi",
        sections: "Sezioni",
        newRow: "Rilascia qui per iniziare una nuova riga",
        newRowVerb: "Sposta in una nuova riga",
        addWidget: "Aggiungi widget",
        reset: 'Ripristina',
        alwaysShown: 'Sempre visibile',
        builtIn: 'Integrato',
        startDescription: 'Compositore e suggerimenti',
        attentionDescription: 'Visibile quando qualcosa ha bisogno di te',
        machinesDescription: 'Integrato · una griglia delle tue macchine',
        hiddenSetupSteps: 'Passaggi di configurazione nascosti',
        showAgain: ({ count }) => `${count} · Mostra di nuovo`,
        reorderHandle: ({ section }) => `Riordina ${section}`,
    } } satisfies Pick<Readonly<Record<string, HomeIndexTranslation>>, "it">;

return { homeIndexTranslations };
})();

const Domain_homeSettingsTranslations = (() => {
const en = Shared_homeSettingsTranslations.en;

const it: typeof en = {
    page: {
        title: 'Impostazioni del server',
        description: 'Ogni impostazione letta dal server che non ha una pagina propria.',
        searchPlaceholder: 'Cerca impostazioni o variabili d’ambiente',
        changed: 'Modificate',
        changedA11y: ({ count }: { count: number }) => (count === 1 ? 'Mostra solo l’impostazione modificata' : `Mostra solo le ${count} impostazioni modificate`),
        noMatches: 'Nessuna impostazione corrisponde alla ricerca.',
        noChanges: 'Nessuna impostazione di questo Home è diversa dal valore predefinito.',
        filterLabel: 'Mostra',
        filterAll: 'Tutte le impostazioni',
        filterChanged: ({ count }: { count: number }) => `Modificate · ${count}`,
        more: 'Altro',
        readOnlyTitle: 'Sola lettura all’avvio',
        readOnlyDescription: 'Il server ne ha bisogno prima di poter leggere qualsiasi impostazione salvata, quindi si impostano dove viene eseguito.',
        note: 'Le impostazioni si applicano appena le modifichi, salvo quelle contrassegnate con “Si applica dopo il riavvio”. In attesa significa che il valore salvato è diverso da quello con cui il server è stato avviato. Ogni modifica viene registrata in Attività; i valori segreti mai.',
        adminTitle: 'Solo i proprietari modificano le impostazioni del server',
        adminBody: 'Puoi vedere ogni impostazione e da dove proviene il suo valore.',
        loadFailed: 'Impossibile caricare le impostazioni del server.',
        saveFailed: 'L’impostazione non è stata salvata.',
        conflictTitle: 'Impostazioni modificate altrove',
        conflictBody: 'Qualcuno ha modificato le impostazioni di questo Home mentre le stavi modificando. La pagina ora mostra i suoi valori; la tua modifica è ancora nel campo.',
    },
    row: {
        appliesAfterRestart: 'Si applica dopo il riavvio',
        pending: 'In attesa',
        defaultValue: ({ value }: { value: string }) => `Predefinito: ${value}`,
        runningWith: ({ value }: { value: string }) => `in esecuzione con ${value} dall’ultimo avvio`,
        runningWithout: 'in esecuzione senza dall’ultimo avvio',
        ignored: ({ reason }: { reason: string }) => `Ignorata all’ultimo avvio: ${reason}`,
        runningOn: ({ value }: { value: string }) => `in esecuzione su ${value}`,
        notSet: 'Non impostato',
        outOfBounds: ({ bounds }: { bounds: string }) => `Deve essere ${bounds}`,
        invalid: 'Questo valore non è valido qui',
        storedEncrypted: 'salvato cifrato, mai mostrato',
    },
    banner: {
        pendingNames: ({ names }: { names: string }) => `${names}.`,
        andMore: ({ count }: { count: number }) => (count === 1 ? 'un’altra' : `altre ${count}`),
        discard: 'Scarta',
        discarded: 'Modifiche in attesa scartate',
        ignoredTitle: 'Un’impostazione è stata ignorata all’ultimo avvio',
        ignoredTitleMany: ({ count }: { count: number }) => `${count} impostazioni sono state ignorate all’ultimo avvio`,
        ignoredBody: ({ setting, reason }: { setting: string; reason: string }) => `${setting}: ${reason}. Il server è stato avviato senza.`,
        fix: 'Correggi',
    },
    readOnly: {
        before_database: 'Letta prima dell’apertura del database',
        per_process_identity: 'Diversa per ogni processo del server',
        invariant: 'Protegge l’accesso e i limiti della build, quindi non si può modificare qui',
        other: 'Impostata dove viene eseguito il server',
        set: 'Impostata',
    },
    secret: {
        saved: 'Salvato',
        replace: 'Sostituisci',
        clear: 'Rimuovi',
        keep: 'Mantieni',
        clearPending: 'Il valore salvato verrà rimosso al salvataggio.',
        valueSet: 'Impostato',
        valueNotSet: 'Non impostato',
        setAction: 'Imposta',
    },
    groupSummary: ({ count }: { count: number }) => (count === 1 ? '1 impostazione · predefinita' : `${count} impostazioni · predefinite`),
    groupSummaryChanged: ({ count, changed }: { count: number; changed: number }) => `${count} impostazioni · ${changed} modificate`,
    units: {
        ms: 'ms',
        seconds: 's',
        minutes: 'min',
        bytes: 'byte',
        megabytes: 'MB',
    },
    activity: {
        discarded: 'Ha scartato un’impostazione del server in attesa',
    },
    choices: {
        hosted_happier_relay: 'Relay Happier',
        direct_apns: 'Push Apple',
        background_wake_best_effort: 'Riattivazione in background',
        local_only: 'Solo questo dispositivo',
        disabled: 'Disattivato',
        enabled: 'Attivato',
        automatic: 'Automatico',
        sandbox: 'Sandbox',
        production: 'Produzione',
        owner: 'Proprietari del server',
        authenticated: 'Chiunque abbia effettuato l’accesso',
        self: 'Questo server',
        external: 'Servizio esterno',
        '0': 'Disattivato',
        '1': 'Attivato',
        any: 'Qualsiasi',
        all: 'Tutte',
        github_app: 'GitHub App',
        oauth_user_token: 'Token della persona',
        light: 'Leggero',
        full: 'Completo',
        api: 'Solo API',
        worker: 'Solo worker',
        fatal: 'Fatale',
        error: 'Errori',
        warn: 'Avvisi',
        info: 'Informazioni',
        debug: 'Debug',
        trace: 'Traccia',
        silent: 'Silenzioso',
        manual: 'Manuale',
        default: 'Valore del server',
    },
    rateLimit: {
        max: ({ route }: { route: string }) => `${route}: richieste per finestra`,
        window: ({ route }: { route: string }) => `${route}: finestra`,
    },
    groups: {
        api: 'API e rete',
        storage: 'Archiviazione e file',
        monitoring: 'Monitoraggio',
        process: 'Processo',
        ui: 'Distribuzione dell’app web',
        realtime: 'Presenza e socket',
        retentionCaps: 'Limiti di risorse per la conservazione',
        rpc: 'Chiamate alle macchine',
        liveActivity: 'Live Activities',
        voice: 'Voce',
        connectedServices: 'Servizi collegati',
        localServices: 'Servizi locali',
        plugins: 'Plugin',
        reviews: 'Revisioni',
        bugReports: 'Segnalazioni di bug',
        releases: 'Release',
        authCaches: 'Cache di accesso',
        limits: 'Limiti',
        rateLimits: 'Limiti di frequenza per route',
        github: 'Accesso con GitHub',
        oauth: 'Accesso con OAuth',
        oidc: 'Provider OIDC dalla configurazione',
        workos: 'WorkOS',
        signInRequests: 'Richieste di accesso',
        offboarding: 'Revoca degli accessi',
        friends: 'Amici',
        accountService: 'Servizio account',
        devices: 'Dispositivi',
        diagnostics: 'Diagnostica',
        reachInference: 'Rilevamento dell’indirizzo',
        addresses: 'Indirizzi',
        other: 'Altro',
    },
    keys: {
        HAPPIER_HOME_DISPLAY_NAME: 'Nome di Home',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: 'Aggiornamenti in background',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: 'Modalità di consegna',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_ALLOW_FALLBACK: 'Ripiega su un’altra modalità',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_DEDUPE_WINDOW_MS: 'Finestra per aggiornamenti duplicati',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_ENABLED: 'Push di risveglio in background',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_MIN_INTERVAL_MS: 'Intervallo minimo tra push di risveglio',
        HAPPIER_LIVE_ACTIVITY_EXPO_WIDGETS_PUSH_NOTIFICATIONS_ENABLED: 'La build dei widget riceve push',
        HAPPIER_LIVE_ACTIVITY_TARGET_TRANSIENT_FAILURE_BUDGET: 'Errori prima di escludere un dispositivo',
        HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT: 'Ambiente push di Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID: 'ID team Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID: 'ID chiave push Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY: 'Chiave di firma push Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY_FILE: 'File della chiave di firma push Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS: 'Bundle ID delle app consentiti',
        HAPPIER_LIVE_ACTIVITY_APNS_ACTIVITY_NAMES: 'Nomi di Live Activity consentiti',
        HAPPIER_LIVE_ACTIVITY_APNS_REQUEST_TIMEOUT_MS: 'Timeout delle richieste push Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_RECONNECT_BACKOFF_MS: 'Attesa di riconnessione push Apple',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED: 'Usa un relay ospitato',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL: 'Indirizzo del relay ospitato',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEY: 'Chiave di accesso al relay ospitato',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_SERVICE_ENABLED: 'Funziona da relay ospitato',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEYS: 'Chiavi di accesso al relay per altri server',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_MAX_SKEW_MS: 'Tolleranza dell’orologio del relay',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_TTL_MS: 'Memoria dei duplicati del relay',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_CACHE_MAX_ENTRIES: 'Dimensione cache duplicati del relay',
        ELEVENLABS_API_KEY: 'Chiave API ElevenLabs',
        ELEVENLABS_AGENT_ID: 'Agente ElevenLabs',
        ELEVENLABS_AGENT_ID_PROD: 'Agente ElevenLabs di produzione',
        ELEVENLABS_API_BASE_URL: 'Indirizzo API ElevenLabs',
        REVENUECAT_SECRET_KEY: 'Chiave segreta RevenueCat',
        VOICE_FREE_SESSIONS_PER_MONTH: 'Sessioni vocali gratuite al mese',
        VOICE_FREE_MINUTES_PER_MONTH: 'Minuti vocali gratuiti al mese',
        VOICE_MAX_CONCURRENT_SESSIONS: 'Sessioni vocali simultanee',
        VOICE_MAX_SESSION_SECONDS: 'Sessione vocale più lunga',
        VOICE_MAX_MINUTES_PER_DAY: 'Minuti vocali al giorno',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_ENABLED: 'Backfill dell’identità vocale',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE: 'Dimensione dei lotti di backfill',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS: 'Tempo massimo di backfill',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_DELAY_MS: 'Pausa tra lotti di backfill',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_INTERVAL_MS: 'Intervallo tra esecuzioni di backfill',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID: 'Client ID OAuth di OpenAI Codex',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL: 'Endpoint token di OpenAI Codex',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID: 'Client ID OAuth dell’abbonamento Claude',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL: 'Endpoint token dell’abbonamento Claude',
        HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS: 'Timeout dello scambio token',
        CONNECTED_SERVICE_CREDENTIAL_MAX_LEN: 'Credenziale salvata più grande',
        CONNECTED_SERVICE_REFRESH_LEASE_MAX_MS: 'Lease di aggiornamento più lungo',
        VENDOR_TOKEN_MAX_LEN: 'Token del fornitore più grande',
        HAPPIER_LOCAL_SERVICES_TOKEN_SECRET: 'Segreto dei token di anteprima',
        HAPPIER_LOCAL_SERVICES_PREVIEW_TOKEN_SECRET: 'Segreto dei token di anteprima privata',
        HAPPIER_LOCAL_SERVICES_PUBLIC_PREVIEW_TOKEN_SECRET: 'Segreto dei token di anteprima pubblica',
        HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN: 'Origine dell’interfaccia dei plugin',
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_MAX_AGE_MS: 'Validità della prova dell’editore',
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_CLOCK_SKEW_MS: 'Tolleranza orologio della prova dell’editore',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_MAX_AGE_MS: 'Validità della prova di revisione',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_CLOCK_SKEW_MS: 'Tolleranza orologio della prova di revisione',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: 'Includi i log del server',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: 'Chi può leggere i log del server',
        HAPPIER_BUG_REPORTS_SERVER_LOG_PATH: 'File di log del server',
        HAPPIER_BUG_REPORTS_SERVER_LOG_MAX_BYTES: 'Dimensione del log inclusa',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'Canale di rilascio',
        HAPPIER_GITHUB_REPO: 'Repository delle release',
        AUTH_OFFBOARDING_ENABLED: 'Ricontrolla l’idoneità all’accesso',
        AUTH_OFFBOARDING_STRICT: 'Rifiuta se un ricontrollo fallisce',
        AUTH_OFFBOARDING_INTERVAL_SECONDS: 'Intervallo tra i ricontrolli',
        AUTH_PROVIDERS_CONFIG_PATH: 'File dei provider',
        AUTH_PROVIDERS_CONFIG_JSON: 'JSON dei provider',
        HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: 'Servizio di accesso',
        HAPPIER_AUTH_SIGN_IN_SERVICE_URL: 'Indirizzo del servizio account',
        HAPPIER_AUTH_SIGN_IN_SERVICE_SERVER_IDENTITY_ID: 'Identità del servizio account',
        HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME: 'Nome del servizio account',
        HAPPIER_SERVER_OWNER_USER_IDS: 'Account proprietari del server',
        HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED: 'I nuovi dispositivi richiedono approvazione',
        GITHUB_CLIENT_ID: 'Client ID OAuth di GitHub',
        GITHUB_CLIENT_SECRET: 'Client secret OAuth di GitHub',
        GITHUB_REDIRECT_URL: 'Indirizzo di callback GitHub',
        GITHUB_HTTP_TIMEOUT_SECONDS: 'Timeout delle richieste GitHub',
        GITHUB_STORE_ACCESS_TOKEN: 'Conserva il token di accesso GitHub',
        OAUTH_PENDING_TTL_SECONDS: 'Validità degli accessi in attesa',
        OAUTH_STATE_TTL_SECONDS: 'Validità dello stato OAuth',
        HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES: 'Schemi di ritorno all’app consentiti',
        AUTH_GITHUB_ALLOWED_USERS: 'Utenti GitHub consentiti',
        AUTH_GITHUB_ALLOWED_ORGS: 'Organizzazioni GitHub consentite',
        AUTH_GITHUB_ORG_MATCH: 'Organizzazioni richieste',
        AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: 'Verifica dell’appartenenza',
        AUTH_GITHUB_APP_ID: 'ID GitHub App per l’appartenenza',
        AUTH_GITHUB_APP_PRIVATE_KEY: 'Chiave GitHub App per l’appartenenza',
        AUTH_GITHUB_APP_INSTALLATION_ID_BY_ORG: 'Installazioni dell’app per organizzazione',
        WORKOS_API_KEY: 'Chiave API WorkOS',
        WORKOS_CLIENT_ID: 'Client ID WorkOS',
        ACCOUNT_AUTH_REQUEST_TTL_SECONDS: 'Validità delle richieste di accesso all’account',
        TERMINAL_AUTH_REQUEST_TTL_SECONDS: 'Validità delle richieste di accesso dal terminale',
        AUTH_PAIRING_TTL_SECONDS: 'Validità del codice di abbinamento',
        AUTH_TOKEN_CACHE_TTL_SECONDS: 'Validità della cache dei token di sessione',
        AUTH_TOKEN_CACHE_MAX_ENTRIES: 'Dimensione della cache dei token di sessione',
        AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: 'Validità della cache di idoneità',
        AUTH_LOGIN_ELIGIBILITY_CACHE_MAX_ENTRIES: 'Dimensione della cache di idoneità',
        FRIENDS_USERNAME_MIN_LEN: 'Nome utente più corto',
        FRIENDS_USERNAME_MAX_LEN: 'Nome utente più lungo',
        FRIENDS_USERNAME_REGEX: 'Formato del nome utente',
        HAPPIER_CANONICAL_SERVER_URL: 'Indirizzo dell’identità di accesso',
        HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE: 'Indirizzo di ritorno OAuth dell’app web',
        PUBLIC_URL: 'Indirizzo annunciato (light)',
        HAPPIER_PUBLIC_SERVER_URL_INFER_TTL_MS: 'Validità dell’indirizzo rilevato',
        HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL: 'Rileva dal metodo di accesso',
        HAPPIER_TAILSCALE_INFER_PUBLIC_URL: 'Rileva da Tailscale',
        HAPPIER_TAILSCALE_SERVE_STATUS_TIMEOUT_MS: 'Timeout del controllo di Tailscale Serve',
        HAPPIER_TAILSCALE_FUNNEL_STATUS_TIMEOUT_MS: 'Timeout del controllo di Tailscale Funnel',
        PORT: 'Porta di ascolto',
        HAPPIER_SERVER_HOST: 'Indirizzo di ascolto',
        HAPPIER_SERVER_FLAVOR: 'Variante del server',
        NODE_ENV: 'Ambiente Node',
        SERVER_ROLE: 'Ruolo del processo',
        UV_THREADPOOL_SIZE: 'Thread di lavoro',
        HAPPIER_INSTANCE_ID: 'ID replica',
        HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: 'Scadenza dell’arresto',
        HAPPY_EXIT_ON_FATAL: 'Esci dopo un errore fatale',
        HAPPIER_API_CORS_MAX_AGE_SECONDS: 'Cache delle richieste preflight del browser',
        HAPPIER_SERVER_IDENTITY_ID: 'Identità del server',
        HAPPIER_MANAGED_RELAY_PURPOSE: 'Scopo del relay gestito',
        HAPPIER_PERSONAL_HOME_RELOCATION_OPERATION_ID: 'Operazione di trasferimento',
        HAPPIER_SERVER_STARTUP_RECEIPT_PATH: 'File della ricevuta di avvio',
        HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: 'Nonce della ricevuta di avvio',
        HAPPIER_UPDATER_FORWARD_RECOVERY_CAPABILITY: 'Ripristino in avanti dell’updater',
        HAPPIER_RELEASE_SOURCE_SHA: 'Commit della build',
        HAPPIER_FEATURE_POLICY_ENV: 'Criterio del canale di rilascio',
        HAPPIER_BUILD_FEATURES_ALLOW: 'Funzionalità consentite',
        HAPPIER_BUILD_FEATURES_DENY: 'Funzionalità negate',
        HAPPIER_SERVER_LOG_LEVEL: 'Livello di log',
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: 'Log di debug unificato',
        HAPPIER_SELF_HOST_LOG_DIR: 'Cartella dei log',
        HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS: 'Diagnostica dell’autenticazione',
        HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS: 'Diagnostica dei messaggi socket',
        METRICS_ENABLED: 'Metriche',
        METRICS_PORT: 'Porta delle metriche',
        SENTRY_DSN: 'DSN per la segnalazione degli errori',
        HAPPIER_SENTRY_USE_CENTRAL_DSN: 'Segnala a Happier',
        HAPPIER_SENTRY_CENTRAL_DSN: 'DSN centrale per la segnalazione degli errori',
        SENTRY_ENVIRONMENT: 'Ambiente di segnalazione errori',
        SENTRY_RELEASE: 'Release di segnalazione errori',
        SENTRY_PROFILE_LIFECYCLE: 'Profilazione',
        SENTRY_SEND_DEFAULT_PII: 'Invia dati personali',
        SENTRY_TRACES_SAMPLE_RATE: 'Richieste tracciate',
        SENTRY_PROFILE_SESSION_SAMPLE_RATE: 'Sessioni profilate',
        SENTRY_ENABLE_LOGS: 'Invia i log',
        SENTRY_LOG_LEVELS: 'Livelli di log inviati',
        SENTRY_MONITORS_ENABLED: 'Monitoraggio dei job',
        HAPPIER_SERVER_UI_DIR: 'Cartella dell’app web',
        HAPPIER_SERVER_UI_PREFIX: 'Percorso dell’app web',
        HAPPIER_SERVER_UI_REQUIRED: 'Richiedi l’app web',
        HAPPIER_SERVER_UI_DEPLOYMENT_ID: 'ID di deployment dell’app web',
        HAPPIER_SERVER_UI_DEBUG_PATH: 'Mostra il percorso dell’app web se manca',
        HAPPIER_SOCKET_ADAPTER: 'Adattatore socket',
        HAPPIER_SOCKET_REDIS_ADAPTER: 'Adattatore socket Redis (legacy)',
        HAPPIER_SOCKET_ADAPTER_MAXLEN: 'Lunghezza dello stream socket',
        HAPPIER_SOCKET_ADAPTER_READ_COUNT: 'Dimensione di lettura dello stream socket',
        HAPPIER_SOCKET_MAX_HTTP_BUFFER_SIZE: 'Messaggio socket più grande',
        HAPPIER_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS: 'Soglia di disconnessione rapida',
        HAPPIER_SOCKET_PLANNED_RESTART_RETRY_AFTER_MS: 'Attesa di riconnessione durante un riavvio',
        HAPPIER_SOCKET_RECONNECT_WINDOW_MS: 'Finestra di riconnessione',
        HAPPY_SOCKET_ROOMS_ONLY: 'Distribuzione socket rigorosa',
        HAPPIER_MACHINE_SOCKET_OWNER_TTL_SECONDS: 'Proprietà del socket della macchina',
        HAPPIER_PRESENCE_STREAM_MAXLEN: 'Lunghezza dello stream di presenza',
        HAPPIER_PRESENCE_WORKER_DB_WRITE_CONCURRENCY: 'Scritture di presenza simultanee',
        HAPPIER_PRESENCE_WORKER_FLUSH_INTERVAL_MS: 'Intervallo di scrittura della presenza',
        HAPPIER_PRESENCE_WORKER_READ_BLOCK_MS: 'Attesa di lettura della presenza',
        HAPPIER_PRESENCE_WORKER_READ_COUNT: 'Dimensione di lettura della presenza',
        HAPPIER_PRESENCE_WORKER_RECLAIM_IDLE_MS: 'Recupero della presenza dopo',
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: 'Sessione inattiva dopo',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: 'Macchina offline dopo',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: 'Intervallo di controllo della presenza',
        HAPPIER_PRESENCE_SHUTDOWN_FLUSH_TIMEOUT_MS: 'Scrittura della presenza all’arresto',
        HAPPIER_RPC_FORWARD_TIMEOUT_MS: 'Timeout delle chiamate alle macchine',
        HAPPIER_RPC_FORWARD_CAPABILITIES_TIMEOUT_MS: 'Timeout della chiamata sulle capacità',
        HAPPIER_RPC_FORWARD_MAX_TIMEOUT_MS: 'Timeout di chiamata più lungo',
        HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Attesa di un metodo',
        HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS: 'Intervallo di controllo dei metodi',
        HAPPIER_RPC_CLUSTER_FETCH_TIMEOUT_MS: 'Timeout della ricerca tra repliche',
        HAPPIER_STOP_SESSION_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Attesa per arrestare una sessione',
        HAPPIER_DIRECT_SESSIONS_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Attesa per le sessioni dirette',
        HAPPIER_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT: 'Sessioni che richiedono attenzione al primo caricamento',
        HAPPIER_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT: 'Turni controllati per il rollback',
        HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT: 'Cronologia delle impostazioni conservata',
        HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK: 'Richiedi una chiave della macchina firmata',
        DATABASE_URL: 'Base di dati',
        HAPPIER_DB_PROVIDER: 'Motore del database',
        HAPPIER_DB_CONNECTION_LIMIT: 'Dimensione del pool di connessioni',
        HAPPIER_DB_READINESS_TIMEOUT_MS: 'Timeout di disponibilità del database',
        HAPPIER_DB_TX_MAX_RETRIES: 'Tentativi di transazione',
        HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: 'Attesa del primo tentativo',
        HAPPIER_DB_TX_RETRY_MAX_DELAY_MS: 'Attesa più lunga tra tentativi',
        HAPPIER_DB_TX_RETRY_JITTER_FACTOR: 'Variazione casuale dei tentativi',
        HAPPIER_DB_TX_TIMEOUT_MS: 'Timeout delle transazioni',
        HAPPIER_DB_TX_MAX_WAIT_MS: 'Attesa di connessione',
        HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS: 'Tempo totale per i tentativi',
        HAPPIER_SERVER_DB_SIZE_WARN_BYTES: 'Avviso sulla dimensione del database',
        HAPPIER_SQLITE_AUTO_MIGRATE: 'Migra all’avvio',
        HAPPIER_SQLITE_MIGRATIONS_DIR: 'Cartella delle migrazioni',
        HAPPIER_SQLITE_JOURNAL_MODE: 'Modalità journal di SQLite',
        HAPPIER_SQLITE_SYNCHRONOUS: 'Modalità sincrona di SQLite',
        HAPPIER_SQLITE_JOURNAL_SIZE_LIMIT_BYTES: 'Limite di dimensione del journal SQLite',
        HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: 'Intervallo di checkpoint SQLite',
        HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: 'Attesa del checkpoint SQLite',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_INTERVAL_MS: 'Intervallo di vacuum SQLite',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES: 'Pagine di vacuum SQLite',
        HAPPIER_FILES_BACKEND: 'Backend dei file',
        S3_HOST: 'Host S3',
        S3_PORT: 'Porta S3',
        S3_USE_SSL: 'S3 su TLS',
        S3_REGION: 'Regione S3',
        S3_BUCKET: 'Bucket S3',
        S3_PUBLIC_URL: 'Indirizzo pubblico S3',
        S3_ACCESS_KEY: 'Chiave di accesso S3',
        S3_SECRET_KEY: 'Chiave segreta S3',
        REDIS_URL: 'Connessione Redis',
        HANDY_MASTER_SECRET: 'Segreto principale',
        HAPPIER_SERVER_LIGHT_DATA_DIR: 'Cartella dei dati',
        HAPPIER_SERVER_LIGHT_DB_DIR: 'Cartella del database',
        HAPPIER_SERVER_LIGHT_FILES_DIR: 'Cartella dei file',
        HAPPIER_API_RATE_LIMITS_ENABLED: 'Limiti di frequenza',
        HAPPIER_API_RATE_LIMITS_GLOBAL_MAX: 'Richieste per client',
        HAPPIER_API_RATE_LIMITS_GLOBAL_WINDOW: 'Finestra del limite di frequenza',
        HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY: 'Conta le richieste per',
        HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: 'Conta le richieste per route in base a',
        HAPPIER_SERVER_TRUST_PROXY: 'Considera attendibili gli header del proxy',
        HAPPIER_SERVER_RETENTION__INTERVAL_MS: 'Intervallo tra le pulizie',
        HAPPIER_SERVER_RETENTION__BATCH_SIZE: 'Righe per lotto',
        HAPPIER_SERVER_RETENTION__MAX_DELETES_PER_RULE_PER_RUN: 'Eliminazioni massime per regola',
        HAPPIER_SERVER_RETENTION__SWEEP_TIME_BUDGET_MS: 'Tempo massimo di pulizia',
        HAPPIER_SERVER_RETENTION__MAX_CANDIDATES_PER_RULE_PER_RUN: 'Righe esaminate al massimo per regola',
    },
};

const homeSettingsTranslations = { it } as const;

return { homeSettingsTranslations };
})();

const Domain_homeSetupTranslations = (() => {
type HomeSetupTranslation = Shared_homeSetupTranslations.HomeSetupTranslation;

const homeSetupTranslations = { it: {
        dismiss: ({ title }) => `Nascondi «${title}»`,
        dismissTooltip: 'Nascondi · ripristina da Personalizza',
        close: 'Chiudi',
        addPhoneSubtitle: 'Segui le sessioni e rispondi alle approvazioni ovunque tu sia.',
        addPhoneAction: 'Mostra codice QR',
        addMachineSubtitle: 'Un server o una macchina di sviluppo che esegue agenti, configurata via SSH o con un comando.',
        installComputerTitle: 'Installa su un altro computer',
        installComputerSubtitle: 'Installa lì l’app desktop e unisciti a questo Home con un link.',
        installComputerAction: 'Ottieni il link',
        connectComputerTitle: 'Collega un computer',
        connectComputerSubtitle: 'Scansiona il codice che Happier mostra nel terminale del computer.',
        connectComputerHint: 'Inquadra il codice che Happier mostra nel terminale del computer.',
        phoneAddMachineSubtitle: 'Configura un server o una macchina di sviluppo per i tuoi agenti.',
        phoneAddMachineAction: 'Aggiungi',
        thisHome: 'questo Home',
        pairingPhoneTitle: 'Scansiona con il telefono',
        pairingPhoneBody: ({ home }) => `Inquadra il codice con la fotocamera del telefono. Happier si apre e si unisce a ${home}.`,
        pairingPhoneStepInstall: 'Installa Happier sul telefono.',
        pairingPhoneStepScan: 'Apri la fotocamera e scansiona il codice.',
        pairingPhoneStepJoin: 'Tieni aperto: il telefono si unisce appena scansiona.',
        pairingComputerTitle: 'Unisciti da un altro computer',
        pairingComputerBody: ({ home }) => `Invia questo link all’altro computer. Aprendolo in Happier si unisce a ${home}.`,
        pairingComputerStepInstall: 'Installa l’app desktop sull’altro computer.',
        pairingComputerStepOpen: 'Apri lì il link, oppure incollalo in Happier quando chiede come collegarsi.',
        pairingComputerStepJoin: 'Tieni aperto: il computer si unisce appena apre il link.',
        appStore: 'App Store',
        googlePlay: 'Google Play',
        getDesktopApp: 'Scarica l’app',
        copyLink: 'Copia link',
        waitingForPhone: 'In attesa del telefono…',
        waitingForComputer: 'In attesa del computer…',
        newCodeIn: ({ time }) => `Nuovo codice tra ${time}`,
        makingCode: 'Creazione del codice…',
        addingDevice: ({ device }) => `Aggiunta di ${device}…`,
        deviceJoined: ({ device, home }) => `${device} si è unito a ${home}`,
        codeFailed: 'Impossibile creare un codice per questo Home.',
        codeFailedUnreachable: ({ home }) => `${home} non ha risposto a questo dispositivo.`,
        codeFailedIdentity: ({ home }) => `I dati di ${home} su questo dispositivo non corrispondono alla sua risposta; ricollegalo in Homes.`,
        codeFailedSignedOut: ({ home }) => `Questo dispositivo non ha eseguito l’accesso a ${home}.`,
        codeFailedTooLarge: 'Ha troppi indirizzi per stare in un codice.',
        codeFailedRefused: ({ home }) => `${home} ha rifiutato la richiesta.`,
        codeFailedUnexpected: 'Qualcosa è andato storto; riprova.',
        cancelCode: 'Annulla codice',
        newCode: 'Nuovo codice',
        qrLabel: ({ home }) => `Codice QR che aggiunge un dispositivo a ${home}`,
        storeQrLabel: ({ store }) => `Codice QR di Happier su ${store}`,
        getTheApp: 'Scarica l’app',
        connectServicesTitle: ({ first, second }) => (second ? `Collega ${first} o ${second}` : `Collega ${first}`),
        connectServicesSubtitle: 'Usa il piano che paghi già, su ogni macchina, e vedi quanto ti resta.',
    } } satisfies Pick<Readonly<Record<string, HomeSetupTranslation>>, "it">;

return { homeSetupTranslations };
})();

const Domain_homeWidgetTranslations = (() => {
type HomeWidgetTranslation = Shared_homeWidgetTranslations.HomeWidgetTranslation;

const homeWidgetTranslations = { it: {
        open: ({ destination }) => `Apri ${destination}`,
        refreshFailed: 'Impossibile aggiornare',
        latestRunsTitle: 'Ultime esecuzioni',
        latestRunsLoading: 'Caricamento delle ultime esecuzioni',
        latestRunsEmptyTitle: 'Ancora nessuna esecuzione',
        latestRunsEmptyReason: 'Quando le tue automazioni vengono eseguite, qui vedrai com’è andata ogni esecuzione.',
        latestRunsErrorTitle: 'Impossibile caricare le ultime esecuzioni',
        latestRunsErrorReason: 'La tua Home non ha risposto. Controlla la connessione e riprova.',
    } } satisfies Pick<Readonly<Record<string, HomeWidgetTranslation>>, "it">;

return { homeWidgetTranslations };
})();

const Domain_homesHubTranslations = (() => {
type HomesHubTranslation = Shared_homesHubTranslations.HomesHubTranslation;

const homesHubTranslations = { it: {
        addHomeOrSignIn: 'Aggiungi una Home / Accedi',
        sheetDescription: 'Collega questo dispositivo a un’altra Home o trova le tue.',
        continueWithService: ({ service }) => `Continua con ${service}`,
        continueWithThisHome: 'Continua con questa Home',
        continueWithServiceSubtitle: 'Trova le tue Home e rendi questa disponibile sugli altri tuoi dispositivi.',
        serviceUnavailable: ({ service }) => `${service} non è disponibile in questo momento.`,
        serviceUnsupported: ({ service }) => `${service} non offre l’accesso con account.`,
        serviceUnavailableUnnamed: 'Il tuo servizio di accesso non è disponibile in questo momento.',
        serviceUnsupportedUnnamed: 'Il tuo servizio di accesso non offre l’accesso con account.',
        scanOrPaste: 'Scansiona o incolla un link di Home',
        scanOrPasteSubtitle: 'Entra in una Home con un codice QR o un link.',
        createPersonalHome: 'Crea una Home personale su questo computer',
        createPersonalHomeSubtitle: 'Esegui qui una Home per le tue macchine e i tuoi dispositivi.',
        opensFirst: 'Si apre per prima',
    } } as const satisfies Pick<Record<string, HomesHubTranslation>, "it">;

return { homesHubTranslations };
})();

const Domain_homesJourneysTranslations = (() => {
type Service = Shared_homesJourneysTranslations.Service;

type Home = Shared_homesJourneysTranslations.Home;

type HomesJourneysTranslation = Shared_homesJourneysTranslations.HomesJourneysTranslation;

const en = Shared_homesJourneysTranslations.en;

const ruTimes = Shared_homesJourneysTranslations.ruTimes;

const it: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "I tuoi Home sono qui",
        reconcileLead: "Questo telefono ora segue tutti i tuoi Home.",
        showMySessions: "Mostra le mie sessioni",
        scanComputerCode: "Scansiona il codice sul tuo computer",
        serviceLead: "I tuoi Home vengono trovati dopo l’accesso. Questo telefono li segue tutti.",
        serviceAsHomeLead: ({ service }) => `Le tue sessioni sono su ${service}, sempre raggiungibili. Aggiungi un computer per eseguire gli agenti quando vuoi.`,
        factAlwaysOnDetail: "Accedi alle tue sessioni in qualsiasi momento.",
        factAgents: "I tuoi computer eseguono gli agenti",
        factAgentsDetail: "Aggiungine uno più tardi con un codice QR.",
        fromDeviceHelp: "Su quel dispositivo apri Impostazioni → Aggiungi il tuo telefono, poi scansiona il codice con la fotocamera di questo telefono o incolla il link Home.",
        scan: "Scansiona",
    },
    happierAccount: 'account Happier',
    serviceAccount: ({ service }) => `account ${service}`,

    alreadyUseTitle: 'Usi già Happier?',
    alreadyUseDescription: 'Trova i tuoi Home con il tuo account oppure collegati direttamente a un Home che gestisci. Su questo computer non cambia nulla finché non scegli.',
    signIn: 'Accedi',
    withService: ({ service }) => `con ${service}`,
    changeServiceLabel: ({ service }) => `Servizio di accesso: ${service}. Cambia`,
    connectToHome: 'Collegati a un Home…',
    hostedPrompt: 'Preferisci un Home ospitato?',
    useServiceAsAHome: ({ service }) => `Usa ${service} come Home`,
    dismiss: 'Nascondi',

    pathServiceTitle: ({ service }) => `Accedi con ${service}`,
    pathServiceSubtitle: 'Trova gli Home collegati al tuo account',
    pathOtherServiceTitle: 'Accedi con un altro servizio',
    pathOtherServiceSubtitle: 'Il tuo accesso o quello della tua azienda',
    pathDirectTitle: 'Collegati direttamente a un Home',
    pathDirectSubtitle: 'Un link o un indirizzo · senza account',

    serviceLead: 'I tuoi Home vengono trovati dopo l’accesso e compaiono insieme. Il Home personale di questo computer resta finché non decidi.',
    defaultServiceFact: 'il servizio di accesso predefinito',
    serviceMethodsHelp: ({ service }) => `Sono mostrati solo i metodi offerti da ${service}. Sei nuovo? Gli stessi pulsanti creano il tuo account.`,

    otherServiceLead: 'Se tu o il tuo team gestite un vostro servizio di accesso, inserisci il suo indirizzo. Happier verifica prima cosa offre.',
    serviceAddressLabel: 'Indirizzo del servizio di accesso',
    serviceFound: 'Trovato',
    useThisService: ({ service }) => `Accedi con ${service}`,
    addressIsNotAService: 'Questo indirizzo non offre l’accesso con account. Se è un Home, collegati direttamente.',
    connectAsHome: 'Collegati come Home',
    backToService: ({ service }) => `Torna a ${service}`,

    directLead: 'Per un Home che gestisci tu, con o senza servizio di account. Non serve un account Happier.',
    fromDeviceLabel: 'Da un dispositivo già collegato',
    fromDeviceHelp: 'Su quel dispositivo apri Impostazioni → Aggiungi il tuo telefono, poi scansiona il codice con la fotocamera di questo computer o incolla il link del Home.',
    homeLinkLabel: 'Link del Home',
    homeLinkPlaceholder: 'Incolla un link di Home',
    useCamera: 'Usa la fotocamera',
    openLink: 'Apri',
    byAddressLabel: 'Tramite indirizzo',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: 'Collega',
    byAddressHelp: 'Happier verifica che il Home risponda, poi accedi con i metodi di quel Home.',
    notAHomeLink: 'Questo non è un link di Home. Copialo di nuovo dall’altro dispositivo.',
    homeUnreachable: 'Happier non ha raggiunto nessun Home a quell’indirizzo. Controlla l’indirizzo e che il Home sia in esecuzione.',

    anotherWay: 'Un altro modo',
    homeReachable: 'Raggiungibile',
    connected: 'Collegato',
    signInToHomeTitle: 'Accedi a questo Home',
    signInToHomeLead: 'Questi sono i modi offerti da questo Home.',

    reconcileTitle: 'I tuoi Home sono collegati',
    reconcileLead: ({ count }) => count === 1
        ? 'Ora questo computer ha due Home. Compaiono insieme in Tutte le Home.'
        : `Ora questo computer ha ${count + 1} Home. Compaiono insieme in Tutte le Home.`,
    reconcileFound: 'Trovati',
    reconcileThisComputer: 'Questo computer',
    runSessionsIn: 'Esegui le sessioni di questo computer in',
    runSessionsInDescription: 'Le nuove sessioni avviate qui vengono salvate in questo Home.',
    removeEmptyPersonalHome: 'Rimuovi il Home personale vuoto',
    removeEmptyPersonalHomeDescription: 'È stato creato quando hai installato Happier e non contiene ancora nulla: né sessioni, né persone, né team, né inviti.',
    changeLater: 'Puoi cambiarlo più tardi in Impostazioni → Home.',
    keepBoth: 'Tienili entrambi',
    useHome: ({ home }) => `Usa ${home}`,
    reconcileSetupTitle: 'Scegli dove vanno le sessioni di questo computer',
    reconcileSetupSubtitle: ({ home }) => `Hai collegato ${home}. Tieni entrambi gli Home oppure esegui lì le sessioni di questo computer.`,
    reconcileSetupAction: 'Scegli…',

    serviceAsHomeTitle: ({ service }) => `Usa ${service} come tuo Home`,
    serviceAsHomeLead: ({ service }) => `Le tue sessioni e impostazioni restano su ${service} invece che su questo computer.`,
    factAlwaysOn: 'Sempre attivo',
    factAlwaysOnDetail: 'Il tuo telefono raggiunge le sessioni mentre questo computer è in stop.',
    factAgents: 'Questo computer continua a eseguire i tuoi agenti',
    factAgentsDetail: 'Non cambia nulla su dove viene eseguito il codice.',
    storageE2ee: 'Crittografia end-to-end',
    storageE2eeDetail: ({ service }) => `${service} conserva le tue sessioni ma non può leggerle.`,
    storagePlain: ({ service }) => `Conservate da ${service}`,
    storagePlainDetail: 'Senza crittografia end-to-end: il servizio può leggere ciò che conserva.',
    storageE2eeByDefault: 'Crittografia end-to-end predefinita',
    storagePlainByDefault: ({ service }) => `Conservate da ${service}, leggibili per impostazione predefinita`,
    storageChoiceDetail: 'Lo scegli quando crei il tuo account.',
    removeEmptyOfferedDetail: 'Non contiene ancora nulla. Proposto solo perché è vuoto.',
    signInOrCreate: ({ account }) => `Accedi o crea il tuo ${account}`,
    alreadyUseServiceAsHome: ({ service }) => `Usi già ${service} come Home? L’accesso lo collega direttamente.`,

    addHomeTitle: 'Aggiungi un Home',
    addHomeDescription: 'Un Home conserva le tue sessioni e impostazioni. Collegane uno che usi già o avviane uno nuovo altrove.',
    addSignIn: ({ account }) => `Accedi con il tuo ${account}`,
    addSignInSubtitle: 'Trova gli Home che usi già e collegali.',
    addServiceAsHomeSubtitle: 'Ospitato per te e sempre attivo.',
    addLinkOrQr: 'Collegati con un link o un codice QR',
    addLinkOrQrSubtitle: 'Non serve un account. Ottienilo da un dispositivo già collegato.',
    addServerHome: 'Configura un Home su un server',
    addServerHomeSubtitle: 'Una macchina di sviluppo o una VPS che controlli, configurata via SSH.',
    haveHomeAddress: 'Hai l’indirizzo di un Home?',
    enterIt: 'Inseriscilo',

    livesOnThisComputer: 'Si trova su questo computer',
    availableWhileAwake: 'disponibile finché è attivo',
    gettingReady: 'in preparazione',
    noComputerYet: 'Non hai ancora un computer?',
    aboutYourHome: 'Informazioni sul tuo Home',

    nudgeTitle: ({ count }) => `Home non raggiungibile ${count} volte questa settimana — spostarlo?`,
    nudgeBody: 'Se questo Home funziona su un computer che va in stop, spostarlo su un server sempre acceso può aiutare.',
    nudgeDismiss: 'Nascondi per sempre su questo dispositivo',
    moveHome: 'Sposta Home…',
    useService: ({ service }) => `Usa ${service}`,
};

const homesJourneysTranslations = { it } satisfies Pick<Readonly<Record<string, HomesJourneysTranslation>>, "it">;

return { homesJourneysTranslations };
})();

const Domain_identityAdministrationTranslations = (() => {
type IdentityAdministrationLanguage = Shared_identityAdministrationTranslations.IdentityAdministrationLanguage;

type Words = Shared_identityAdministrationTranslations.Words;

type GitHubAccessWords = Shared_identityAdministrationTranslations.GitHubAccessWords;

type OidcEditorWords = Shared_identityAdministrationTranslations.OidcEditorWords;

const build = Shared_identityAdministrationTranslations.build;

const en = Shared_identityAdministrationTranslations.en;

const githubAccessWords: Pick<Readonly<Record<IdentityAdministrationLanguage, GitHubAccessWords>>, "it"> = { it: {
        githubCurrentAccess: 'Accesso attuale',
        githubCurrentAccessSubtitle: 'Richiesto dalle connessioni e dalle fonti di directory abilitate che usano questa installazione.',
        githubCurrentAccessEmpty: 'I servizi abilitati non richiedono accesso.',
        githubSetupAccess: 'Accesso per configurazione e riparazione',
        githubSetupAccessSubtitle: 'Accesso per le connessioni configurate, incluse quelle disabilitate e le fonti di directory in pausa. Concedi gli accessi mancanti su GitHub prima di abilitarle o riprenderle, poi verifica di nuovo l’installazione.',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `Rimuovi l’installazione per ${name}`,
    } };

const oidcEditorWords: Pick<Readonly<Record<IdentityAdministrationLanguage, OidcEditorWords>>, "it"> = { it: {
        clientAuthenticationMethod: 'Autenticazione del client', clientSecretPost: 'Corpo POST', clientSecretBasic: 'HTTP Basic', storeRefreshToken: 'Conserva il token di rinnovo', buttonColor: 'Colore del pulsante di accesso', iconHint: 'Icona di accesso',
        allowRulesHint: 'Inserisci un valore per riga. Lascia vuoto per non applicare restrizioni.', brandingHint: 'Lascia vuoto per usare l’aspetto di accesso predefinito.', invalidScopes: 'Includi openid negli ambiti richiesti.', refreshFailed: 'Impossibile aggiornare questa connessione', refreshFailedHint: 'Le tue modifiche sono conservate. Riprova per controllare le modifiche sul Home.',
    } };

const identityAdministrationTranslations = { it: build({ ...en, homeWorkosChooseDetail: "Scegli la connessione WorkOS con cui le persone accedono a questo Home.", homeWorkosAdd: "Accesso aziendale tramite WorkOS", homeWorkosCompanyName: "Nome dell’azienda", homeWorkosPurpose: "Le persone della tua azienda possono accedere a questo Home con il loro account di lavoro.", homeWorkosEnableDetail: "Le persone potranno accedere a questo Home con il loro account aziendale.", homeWorkosOffboarding: "Il solo SSO non rimuove le persone che lasciano la tua azienda.", homeWorkosPlatformRequired: "Configura prima WorkOS nelle piattaforme di accesso.",  title: 'Provider di identità', subtitle: 'Connessioni di accesso del Home disponibili ai Team.', homeConnections: 'Connessioni del Home', add: 'Aggiungi connessione', empty: 'Nessuna connessione del Home', active: 'Attivo', disabled: 'Disattivato', configuration: 'Configurazione', issuer: 'URL emittente', clientSecret: 'Segreto client', secretSet: 'Impostato', secretNotSet: 'Non impostato', secretRetain: 'Lascia vuoto per mantenere il segreto corrente.', advanced: 'Mostra impostazioni avanzate', hideAdvanced: 'Nascondi impostazioni avanzate', actions: 'Azioni', test: 'Prova accesso', testing: 'Apertura della prova…', edit: 'Modifica connessione', save: 'Salva connessione', saving: 'Salvataggio…', enable: 'Attiva connessione', disable: 'Disattiva connessione', remove: 'Rimuovi connessione', createTitle: 'Aggiungi provider di identità', editTitle: 'Modifica provider di identità', displayName: 'Nome', required: 'Completa i campi obbligatori.', invalidIssuer: 'Inserisci un URL HTTPS valido.', secretRequired: 'Inserisci un segreto client.', error: 'La modifica non è riuscita.', accounts: 'Account interessati', connections: 'Connessioni Team', errorForbidden: 'Non hai più l’autorizzazione. Non è stato modificato nulla.', errorConflict: 'Qualcun altro l’ha modificato prima. Le tue modifiche sono conservate: ricarica e riprova.', errorMissing: 'Non esiste più. Potrebbe essere stato rimosso.', errorInUse: 'Qualcosa dipende ancora da questo. Rimuovilo prima.', errorProviderUnavailable: 'Il servizio di identità non ha risposto. Non è stato modificato nulla.', errorRateLimited: 'Il provider ha chiesto di attendere prima di riprovare.', errorInvalid: 'Il Home ha rifiutato questi valori. Controlla la configurazione e riprova.', errorImmutable: 'Questo valore è fisso quando il record è in uso. Creane uno nuovo.', errorAuthenticationRequired: 'Accedi di nuovo a questo Team, poi riprova. Nulla è stato modificato.', errorPolicyUnavailable: 'Il criterio di autenticazione del Team non può essere valutato al momento. Nulla è stato modificato.', errorPolicyInUse: 'Il criterio di autenticazione del Team dipende ancora da questa connessione.', errorNotAllowed: 'Questo Home non consente ai Team di configurare questo. Nulla è stato modificato.', errorNeedsAttention: 'La sincronizzazione della directory richiede attenzione. Esegui una sincronizzazione completa.', errorSyncPaused: 'Questa sorgente è in pausa. «Riprendi sincronizzazione» avvia una nuova sincronizzazione completa.', alternateLogins: 'Account che necessitano di un altro metodo di accesso', recoveryAuthenticationPolicy: 'Apri autenticazione del Team', recoveryAlternateLogin: 'Assegna prima un altro metodo di accesso a questi Account', recoveryDirectory: 'Apri directory', recoveryGroupMappings: 'Apri mappature dei Gruppi', recoveryTeamAuthentication: 'Accedi di nuovo', callbackUrl: 'URL di callback', callbackUrlHint: 'Registra questo URL presso il tuo provider di identità.' , workosSetupSso: 'Apri il portale di amministrazione WorkOS', workosSetupDirectory: 'Configura WorkOS Directory Sync', workosCheckSetup: 'Controlla la configurazione WorkOS', workosChooseConnection: 'Scegli la connessione', workosPortalConfirmBody: 'Completerai la configurazione in WorkOS, poi tornerai qui per scegliere la connessione.', workosDirectoryPortalConfirmBody: 'Completerai la configurazione in WorkOS, poi tornerai qui per scegliere la directory.', workosSetupSection: 'Configurazione', workosSetupFooter: 'Puoi uscire e tornare: la configurazione riprende dal passaggio raggiunto.', workosStepPortalDetail: 'Collega lì il tuo provider di identità. Al ritorno, la configurazione continua qui.', workosStepPortalDone: 'Portale di amministrazione', workosStepPortalDoneDetail: 'La tua organizzazione è collegata.', workosOpenPortal: 'Apri portale', workosOpenPortalAgain: 'Riapri', workosStepChooseDetail: 'Scegli quale connessione WorkOS usano i membri per accedere.', workosStepChooseDone: 'Connessione', workosFindConnections: 'Cerca connessioni', workosUseConnection: ({ name }: { name: string }) => `Usa ${name}`, workosCandidateDraft: 'Una bozza in WorkOS. Completala prima lì.', workosStepTestDetail: 'Accedi una volta tu stesso. Non viene salvato nulla nell’account di nessuno.', workosTestPassed: 'Il tuo accesso di prova ha funzionato.', workosTestAgain: 'Prova di nuovo', workosStepEnable: 'Attivala', workosStepEnableDetail: 'Poi i membri potranno accedere con essa. Per renderla obbligatoria, sceglila in Come accedono i membri.', workosTurnOn: 'Attiva', workosConnectionSection: 'Connessione', workosConnectionRow: 'Connessione WorkOS', workosConnectionNotChosen: 'Non ancora scelta', workosChange: 'Cambia', errorWorkosPlatformUnavailable: 'WorkOS non è ancora configurato su questo Home.', errorSetupRequired: 'Va configurato prima di poterlo usare.', removeTitle: ({ name }: { name: string }) => `Rimuovere ${name}?`, removeBody: ({ name }: { name: string }) => `${name} non viene più offerto per l’accesso. Gli account che lo usavano vengono conservati.`, removeBlocked: ({ accounts, connections }: { accounts: number; connections: number }) => `Ancora usato da ${connections} connessioni del team e ${accounts} account. Rimuovile prima.`, disableTitle: ({ name }: { name: string }) => `Disattivare ${name}?`, disableBody: ({ name }: { name: string }) => `Nessuno può accedere con ${name} finché non viene riattivato. Non viene eliminato nulla.`, githubRemoveInstallationTitle: ({ name }: { name: string }) => `Rimuovere l’installazione su ${name}?`, githubRemoveInstallationBody: ({ name }: { name: string }) => `Questo Home smette di usare l’App su ${name}. Su GitHub non cambia nulla; disinstallala lì se non ti serve più.`, removeBlockedTitle: ({ name }: { name: string }) => `${name} non può ancora essere rimosso`, removeImpactPeople: ({ count }: { count: number }) => count === 1 ? '1 persona accede a questo team con essa.' : `${count} persone accedono a questo team con essa.`, removeImpactNobody: 'Nessuno accede ancora a questo team con essa.', removeImpactKept: 'I loro account e le iscrizioni al team vengono conservati.', removeBlockedAlternateLogins: ({ count }: { count: number }) => count === 1 ? '1 persona non ha altri modi per accedere.' : `${count} persone non hanno altri modi per accedere.`, removeBlockedDirectories: ({ count }: { count: number }) => count === 1 ? 'Una fonte di directory la usa ancora.' : `${count} fonti di directory la usano ancora.`, removeBlockedGroups: ({ count }: { count: number }) => count === 1 ? 'Una mappatura di gruppo la usa ancora.' : `${count} mappature di gruppo la usano ancora.`, removeBlockedMemberships: ({ count }: { count: number }) => count === 1 ? '1 iscrizione è ancora gestita da essa.' : `${count} iscrizioni sono ancora gestite da essa.` }, githubAccessWords.it, oidcEditorWords.it) };

return { githubAccessWords, oidcEditorWords, identityAdministrationTranslations };
})();

const Domain_inboxWorkTranslations = (() => {
const en = Shared_inboxWorkTranslations.en;

const it: typeof en = {
    pageDescription: 'Tutto ciò che ti aspetta, raggruppato per il lavoro a cui appartiene.',
    tabs: { a11y: 'Vista della posta in arrivo', needsYou: 'Ti aspetta', updates: 'Novità' },
    groups: {
        unknownLead: 'Sessione',
        leadMeta: ({ count }) => (count === 1 ? '1 sottosessione' : `${count} sottosessioni`),
        runMeta: 'Esecuzione di workflow',
        otherTitle: 'Altre sessioni',
        otherMeta: 'Non fanno parte di un orchestratore né di un’esecuzione',
        openSession: 'Apri sessione',
        openRun: 'Apri esecuzione',
    },
    rows: {
        step: 'Passaggio',
        workflowRun: 'Esecuzione di workflow',
        review: 'Rivedi',
        stalled: 'Bloccata',
        stalledReason: 'La sua macchina è andata offline a metà turno',
        landing: 'Da unire',
        settle: 'Chiudi',
        snoozedUntil: ({ time }) => `Rimandata fino a ${time}`,
        more: 'Altre azioni',
        approvalNeeded: 'Richiede la tua approvazione',
        approvalUntitled: 'Approva un’azione',
    },
    popover: {
        moreInOther: ({ count }) => `Altre ${count} in Altre sessioni`,
        updates: ({ count }) => (count === 1 ? '1 novità' : `${count} novità`),
    },
    empty: {
        title: 'Niente ti aspetta',
        description: 'Qui arrivano le richieste di autorizzazione, le revisioni e tutto ciò che un orchestratore o un workflow aspetta da te.',
    },
    updatesEmpty: {
        title: 'Nessuna novità',
        description: 'Qui arrivano le sessioni terminate e le richieste di amicizia.',
    },
    stale: { reason: 'Impossibile aggiornare le esecuzioni dei workflow', retry: 'Riprova' },
    settleFailed: 'Impossibile chiudere questa sessione',
    detail: {
        openApproval: 'Apri la richiesta',
        idle: 'Scegli un elemento per vederlo qui',
    },
};

const inboxWorkTranslations = { it };

return { inboxWorkTranslations };
})();

const Domain_inputPickerTranslations = (() => {
type InputPickerTranslation = Shared_inputPickerTranslations.InputPickerTranslation;

const inputPickerTranslations = { it: {
        browse: 'Sfoglia…',
        browseField: ({ field }) => `Sfoglia per ${field}`,
        unavailable: 'Il plugin che fornisce questa scelta non è disponibile. Il valore attuale resta invariato.',
        retired: 'Il plugin è stato aggiornato mentre sceglievi. Riprova.',
        invalid: 'Questa scelta non può essere usata qui. Il valore attuale resta invariato.',
        failed: 'Impossibile aprire il selettore. Riprova.',
    } } satisfies Pick<Readonly<Record<string, InputPickerTranslation>>, "it">;

return { inputPickerTranslations };
})();

const Domain_machineAddTranslations = (() => {
type MachineAddTranslation = Shared_machineAddTranslations.MachineAddTranslation;

const machineAddTranslations = { it: { newMachine: 'Nuova macchina', waiting: 'In attesa della connessione', connected: 'Connessa', failed: 'Impossibile aggiungere questa macchina', cancelled: 'Annullato', cannotReachHost: 'Host non raggiungibile. Controlla l’indirizzo e l’accesso SSH.', choosePath: 'Scegli come aggiungere una macchina', switchHome: 'Torna a questa Home per continuare' } } satisfies Pick<Record<'en' | 'ru' | 'pl' | 'es' | 'fr' | 'it' | 'pt' | 'ca' | 'de' | 'zh-Hans' | 'zh-Hant' | 'ja', MachineAddTranslation>, "it">;

return { machineAddTranslations };
})();

const Domain_machineAgentsTranslations = (() => {
type MachineAgentsTranslation = Shared_machineAgentsTranslations.MachineAgentsTranslation;

const en = Shared_machineAgentsTranslations.en;

const it: MachineAgentsTranslation = {
    signedInWith: ({ label }) => `Accesso con ${label}`,
    signedInAs: ({ label }) => `Accesso come ${label}`,
    signedInHere: 'Accesso eseguito su questa macchina',
    updateTo: ({ version }) => `Aggiorna a ${version}`,
    needsSignIn: 'Accesso richiesto',
    waitingForSignIn: 'In attesa dell’accesso nel terminale…',
    notInstalled: 'Non installato',
    downloadSize: ({ size }) => `Download di ${size}`,
    installYourself: 'Da installare manualmente',
    unsupportedOs: 'Non funziona su questo sistema',
    unsupportedArch: 'Nessuna build per questo processore',
    installing: 'Installazione…',
    progress: ({ done, total }) => `${done} di ${total}`,
    checking: 'Verifica…',
    offlineSignedIn: 'Ultimo stato: accesso eseguito · macchina offline',
    offlineSignedOut: 'Ultimo stato: disconnesso · macchina offline',
    offlineNotInstalled: 'Non installato all’ultimo controllo · macchina offline',
    offlineUnknown: 'Macchina offline',
    unknown: 'Impossibile verificare questa macchina',
    actionInstall: 'Installa',
    actionUpdate: 'Aggiorna',
    actionSignIn: 'Accedi',
    actionRetry: 'Riprova',
    actionCancel: 'Annulla',
    actionShowTerminal: 'Mostra terminale',
    actionGuide: 'Guida',
    installLeadManaged: ({ agent, machine }) => `Happier installa ${agent} su ${machine} solo per Happier. La tua configurazione del terminale non cambia.`,
    installLeadVendor: ({ agent, machine }) => `Happier esegue l’installer di ${agent} su ${machine}.`,
    installAlsoDownloads: ({ what }) => `Scarica anche ${what}, usato dalle sessioni.`,
    installThenSignIn: 'Poi accedi.',
    installAgent: ({ agent }) => `Installa ${agent}`,
    installMyself: 'Lo installo io',
    manualLead: ({ agent, machine }) => `Happier non può installare ${agent} per te. Installalo su ${machine} con la sua guida, poi verifica di nuovo.`,
    checkAgain: 'Verifica di nuovo',
    closeNote: ({ machine }) => `Puoi chiudere; continua su ${machine}.`,
    stepCheck: 'Verifica che funzioni',
    stepSignIn: 'Accesso',
    failedKept: 'Non è rimasto nulla di installato a metà.',
    installedLine: ({ agent, version }) => `${agent} ${version} è installato`,
    nowSignIn: 'ora accedi',
    signInHow: ({ agent }) => `Come accede ${agent}`,
    useService: ({ service }) => `Usa il tuo ${service}`,
    recommended: 'Consigliato',
    serviceConnected: ({ profile }) => `${profile} · già collegato · funziona su ogni macchina`,
    serviceNotConnected: 'Collegalo una volta; ogni macchina può usarlo.',
    connect: 'Collega',
    signInOn: ({ machine }) => `Accedi su ${machine}`,
    signInOnDetail: ({ agent }) => `Avvia l’accesso di ${agent} in un terminale lì. Lo usa solo quella macchina.`,
    noNativeLogin: ({ agent }) => `${agent} non ha un accesso proprio: usa una chiave API o un account collegato. Collegane uno una volta e ogni macchina potrà usarlo.`,
    openSignInTerminal: 'Apri l’accesso nel terminale',
    useThisAccount: 'Usa questo account',
    waitingLead: ({ agent, machine }) => `L’accesso di ${agent} è aperto nel terminale su ${machine}. Sarà pronto appena segnala che hai eseguito l’accesso.`,
    readyLine: ({ agent, machine }) => `${agent} è pronto su ${machine}`,
    startSessionWith: ({ agent }) => `Avvia una sessione con ${agent}`,
    setUpAnother: 'Configura un altro agente',
    unsupportedLead: ({ agent, machine }) => `${agent} non ha una build per ${machine}, quindi non può funzionare lì.`,
    setupTitle: ({ agent }) => `Configura ${agent}`,
    signInTitle: ({ agent }) => `Accedi a ${agent}`,
    readyTitle: ({ agent }) => `${agent} è pronto`,
    notOnMachineYet: ({ machine }) => `Non ancora su ${machine}`,
    onMachine: ({ machine }) => `Su ${machine}`,
    installingOn: ({ machine }) => `Installazione su ${machine}`,
    cantRunOn: ({ machine }) => `Non funziona su ${machine}`,
    terminalTab: ({ agent }) => `Accesso · ${agent}`,
    panelLead: 'Completa nel browser che si è aperto. Un altro dispositivo? Apri lì il link.',
    open: 'Apri',
    openSignInPage: 'Apri la pagina di accesso',
    waitingEllipsis: 'In attesa dell’accesso…',
    signedInAlready: 'Hai già eseguito l’accesso?',
    closeTerminal: 'Chiudi terminale',
    showTheTerminal: 'Mostra il terminale',
    phoneLead: ({ agent, machine }) => `${agent} ti chiede di accedere. Apri la pagina qui, completa e ${machine} lo rileverà.`,
    panelSignedInAs: ({ account }) => `Accesso come ${account}.`,
    panelChecked: 'Happier lo ha appena verificato.',
    sectionTitle: 'Agenti',
    sectionDescription: 'Gli agenti di programmazione su questa macchina e come accede ciascuno.',
    addTitle: 'Aggiungi un agente',
    addMore: ({ count }) => (count === 1 ? `Ancora 1 funziona qui` : `Altri ${count} funzionano qui`),
    showAll: 'Mostra tutti',
    showFewer: 'Mostra meno',
    emptyInstalled: 'Nessun agente su questa macchina per ora. Scegline uno qui sotto; Happier lo installa e ti fa accedere.',
    offlineNote: ({ machine }) => `${machine} è offline. Ecco l’ultimo stato segnalato.`,
    firstTitle: 'Configura il tuo primo agente',
    firstLead: ({ machine }) => `${machine} è collegato, ma non ha ancora un agente. Scegline uno; Happier lo installa e ti fa accedere.`,
    firstMore: ({ count }) => (count === 1 ? `Oppure scegli tra 1 altro agente.` : `Oppure scegli tra altri ${count} agenti.`),
    allAgents: 'Tutti gli agenti',
    setUp: 'Configura',
    choiceUsesService: ({ service, profile }) => `Usa il tuo ${service}. Collegato: ${profile}.`,
    choiceSignsInOn: 'Accede sulla macchina.',
    dismissFirst: 'Nascondi «Configura il tuo primo agente»',
    dismissTooltip: 'Nascondi · ripristina da Personalizza',
    chooseAgent: 'Scegli un agente',
    blockNotInstalled: ({ agent, machine }) => `${agent} non è ancora su ${machine}.`,
    blockSetUpToStart: 'Configuralo per iniziare.',
    blockSignedOut: ({ agent, machine }) => `${agent} richiede l’accesso su ${machine}.`,
    spawnCliMissing: ({ agent, machine }) => `${agent} non è installato su ${machine}.`,
    spawnSignedOut: ({ agent, machine }) => `${agent} è disconnesso su ${machine}.`,
    draftKept: 'Il tuo messaggio è stato conservato.',
    alreadySetUp: ({ machine, home }) => `${machine} è già collegato a ${home}`,
    startSession: 'Avvia una sessione',
    openMachine: ({ machine }) => `Apri ${machine}`,
};

const machineAgentsTranslations = { it: it } satisfies Pick<Readonly<Record<string, MachineAgentsTranslation>>, "it">;

return { machineAgentsTranslations };
})();

const Domain_machineDetailPageTranslations = (() => {
type MachineDetailPageTranslations = Shared_machineDetailPageTranslations.MachineDetailPageTranslations;

const english = Shared_machineDetailPageTranslations.english;

const translated = Shared_machineDetailPageTranslations.translated;

const machineDetailPageTranslations = { it: translated({
        machineDetailPage: {
            description: 'Avvia sessioni qui e guarda cosa è in esecuzione su questa macchina.',
            placeholderTitle: 'Macchina',
            online: 'Online',
            offline: 'Offline',
            cliVersionFact: ({ version }) => `CLI ${version}`,
            replacedByFact: ({ machine }) => `Sostituita da ${machine}`,
            unavailableTitle: 'Questa macchina non può avviare sessioni in questo momento',
            startAction: 'Avvia sessione',
            tmuxSectionDescription: 'Come le nuove sessioni su questa macchina usano tmux.',
            windowsSectionDescription: 'Come si aprono le sessioni remote su questa macchina.',
            clisSectionDescription: 'Le CLI degli agenti che Happier ha trovato su questa macchina e gli strumenti che può installare.',
            runsSectionDescription: 'Processi avviati dalle sessioni su questa macchina.',
            recentSessionsTitle: 'Sessioni recenti',
            recentSessionsDescription: 'Le cinque sessioni più recenti su questa macchina.',
            daemonSectionDescription: 'Il servizio in background che collega questa macchina a Happier.',
            stopDaemonDescription: 'Le sessioni in corso continuano. Non se ne possono avviare di nuove finché non lo riavvii su questa macchina.',
            stopDaemonAction: 'Arresta',
            detailsTitle: 'Dettagli della macchina',
        },
    }) };

return { machineDetailPageTranslations };
})();

const Domain_machinePoolTranslations = (() => {
const en = Shared_machinePoolTranslations.en;

const it = {
    machinesSection: "Macchine",
    tierPrimaryDescription: "Provato per primo.",
    tierFallbackDescription: "Provato quando nessuna macchina precedente è online.",
    pauseMember: "Sospendi per le nuove sessioni",
    resumeMember: "Usa per le nuove sessioni",
    pausedState: "In pausa",
    memberMenu: "Opzioni della macchina",
    newPoolTitle: "Nuovo pool di macchine",
    title: "Pool di macchine",
    myTitle: "I miei pool di macchine",
    add: "Aggiungi pool di macchine",
    benefit: "Scegli una macchina preferita, con altre disponibili come fallback.",
    placementChangeNotice: "Le modifiche si applicano alle sessioni avviate dopo il salvataggio. Le sessioni aperte restano sulla loro macchina.",
    connectionSemantics: "All’apertura di una connessione viene scelta una macchina, che resta selezionata per quella connessione. Una connessione successiva può scegliere un’altra macchina.",
    noMembers: "Nessuna macchina in questo pool",
    unavailable: "Non disponibile",
    memberRevoked: "Revocato",
    memberReplaced: "Sostituito",
    memberTemporary: "Temporaneo",
    availabilityUnknown: "Disponibilità della connessione sconosciuta",
    notVerified: "Non verificato",
    brokerUnavailable: "Nessun broker disponibile",
    brokerAvailable: ({ count }: { count: number }) => `${count} disponibili`,
    basics: "Dettagli",
    name: "Nome",
    description: "Descrizione (facoltativa)",
    descriptionTitle: "Descrizione",
    addMachines: "Aggiungi macchine",
    noMachines: "Nessuna macchina persistente è disponibile su questo Home.",
    allMachinesAdded: "Tutte le macchine di questo Home sono già in questo pool.",
    primary: "Primario",
    addFallback: "Aggiungi riserva",
    moveTo: "Sposta in",
    moveTierEarlier: "Sposta questo livello prima",
    moveTierLater: "Sposta questo livello più tardi",
    removeMember: "Rimuovi dal pool",
    enableMember: "Utilizzare per selezioni future",
    save: "Salva modifiche",
    create: "Crea pool",
    delete: "Elimina pool di macchine",
    deleteTitle: "Eliminare questo pool di macchine?",
    deleteBody: "Le eventuali risorse credenziali che usano questo pool perderanno la posizione del broker e dovranno essere riparate. Ciò influisce sulle selezioni future, ma non elimina le macchine né interrompe le sessioni in esecuzione.",
    saveFailed: "Impossibile salvare questo pool di macchine. Le tue modifiche sono ancora qui.",
    deleteFailed: "Impossibile eliminare questo pool di macchine. Riprova.",
    conflictTitle: "Questo pool è stato modificato altrove",
    conflictBody: "Le modifiche non salvate verranno conservate. Ricarica la versione salvata per rivedere le ultime modifiche.",
    conflictNoReload: "L'identità del pool non è più disponibile. Le modifiche non salvate verranno conservate.",
    homeOffline: "Questo Home è offline. Le modifiche al pool saranno disponibili dopo la riconnessione.",
    refreshFailed: "Impossibile aggiornare i pool di macchine. Viene mostrato l’ultimo elenco noto.",
    featureUnavailable: "I pool di macchine non sono disponibili su questo Home. Aggiornali o abilitali nell’Home per continuare.",
    openSettings: "Impostazioni del pool di macchine",
    pickSpecificMachine: "Scegli una macchina specifica",
    poolNotFound: "Questo pool di macchine non è più disponibile.",
    reload: "Ricarica la versione salvata",
    reloadTitle: "Eliminare le modifiche non salvate?",
    reloadBody: "Il ricaricamento sostituisce questo modulo con l'ultima versione salvata.",
    privacy: "Il server di questo Home può leggere nomi, descrizioni e membri dei pool, anche per gli account con crittografia end-to-end.",
    nameRequired: "Inserisci un nome prima di salvare.",
    memberNotEligible: "Alcune macchine non possono più appartenere a questo pool.",
    memberNotEligibleDetail: "Rimuovi questa macchina o scegli un'altra macchina persistente.",
    resolvingTarget: "Scegliere una macchina da questo pool…",
    resolveEmpty: "Questo pool non ha macchine abilitate.",
    resolveNoAvailable: "Nessuna macchina in questo pool è attualmente disponibile.",
    resolvePresenceUnavailable: "La disponibilità della macchina è temporaneamente sconosciuta.",
    resolveFailed: "Happier non è riuscito a scegliere una macchina da questo pool. Riprova.",
    executionMachine: "Esegui su",
    chosenFrom: "Scelto da",
    aMachinePool: "Un pool di macchine",
    availabilityKnown: ({ connected, enabled }: { connected: number; enabled: number }) => `${connected} di ${enabled} macchine abilitate connesse`,
    fallback: ({ number }: { number: number }) => `Alternativa ${number}`,
};

const machinePoolTranslations = { it };

return { machinePoolTranslations };
})();

const Domain_mcpSettingsTranslations = (() => {
type McpSettingsCopy = Shared_mcpSettingsTranslations.McpSettingsCopy;

const en = Shared_mcpSettingsTranslations.en;

const it: McpSettingsCopy = {
    purpose: 'Server di strumenti che i tuoi agenti possono usare nelle sessioni. Aggiungi un server una volta, poi scegli dove si applica.',
    add: 'Aggiungi server MCP',
    addConfigure: 'Configura un server',
    addConfigureDescription: 'Inserisci il comando o l’indirizzo',
    addImportJson: 'Incolla una configurazione JSON',
    addImportJsonDescription: 'Da un README o da un’altra app',
    addOwnCategory: 'Aggiungi il tuo',
    addPresetCategory: 'Installazione rapida',
    addFromMachine: 'Importa da questa macchina',
    addFromMachineDescription: 'Server già usati da altri agenti',
    searchPlaceholder: 'Cerca server',
    toolsGroup: 'Strumenti',
    unbound: 'Non ancora usato da nessuna parte',
    newServer: 'Nuovo server MCP',
    serverPurpose: 'Un server di strumenti che i tuoi agenti possono usare. Scegli qui sotto dove si applica.',
    addByTitle: 'Aggiungi tramite',
    serverSection: 'Server',
    serverSectionDescription: 'Come si chiama il server nelle sessioni e in questo elenco.',
    connectionSection: 'Connessione',
    connectionSectionDescription: 'Come Happier avvia o raggiunge il server.',
    envDescription: 'Valori passati al server. Usa un segreto salvato per le chiavi.',
    headersDescription: 'Inviati con ogni richiesta. Usa un segreto salvato per i token.',
    addRule: 'Aggiungi regola',
    discardDraft: 'Scarta',
    landingTitle: 'Dai più strumenti ai tuoi agenti',
    landingDescription: 'I server MCP aggiungono strumenti come un browser, la ricerca nella documentazione o GitHub. Configurane uno, incolla una configurazione o parti da un preset.',
    onMachineTitle: 'Trovati su questa macchina',
    onMachinePurpose: 'Server MCP che altri agenti configurano già su questa macchina. Importane uno per usarlo da Happier.',
    onMachineSearchSection: 'Dove cercare',
    onMachineSearchDescription: 'Le configurazioni degli agenti nella tua cartella home e, se ne scegli una, in una cartella di progetto.',
    onMachineFoundSection: 'Server',
    onMachineFoundDescription: 'L’importazione copia il server in Happier; la configurazione originale non cambia.',
    previewTitle: 'Cosa ricevono le sessioni',
    previewPurpose: 'Controlla quali server MCP riceve una sessione per un agente e una cartella, e cosa succede quando uno non si avvia.',
    previewContextSection: 'Sessione',
    previewContextDescription: 'L’agente e la cartella con cui partirebbe una nuova sessione.',
    failurePolicyTitle: 'Quando un server non si avvia',
    failurePolicyDescription: 'Per esempio, quando manca un segreto salvato di cui ha bisogno.',
    failurePolicySkip: 'Saltalo',
    failurePolicyStop: 'Ferma la sessione',
    failureSection: 'Affidabilità',
    failureSectionDescription: 'Vale per ogni server MCP in ogni sessione.',
    previewNothingTitle: 'Non verrebbe fornito nulla',
    previewNothingDescription: 'Nessun server MCP si applica a questo agente e a questa cartella. Aggiungi un server o una regola che li copra.',
    check: 'Verifica',
    scan: 'Cerca',
};

const mcpSettingsTranslations = { it } as const;

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

const it: DesktopTrayTranslation = {
    open: 'Apri Happier',
    openInHappier: 'Apri in Happier',
    settings: 'Impostazioni…',
    startAtLogin: 'Avvia all’accesso',
    quit: 'Esci da Happier',
    stopServicesAndQuit: 'Arresta i servizi in background ed esci…',
    sessions: ({ count }: CountParams) => `${count} in corso`,
    start: 'Avvia',
    restart: 'Riavvia',
    stop: 'Arresta…',
    userOwned: 'Gestito fuori da Happier',
    checking: 'Controllo dei servizi in background…',
    readFailed: 'Impossibile controllare i servizi in background',
    incomplete: 'Alcuni servizi in background non sono stati controllati',
    noServices: 'Questo computer non è ancora configurato',
    working: 'In corso…',
    stopConfirmTitle: ({ relay }: RelayParams) => `Arrestare il servizio in background di Happier per ${relay}?`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `Le sessioni degli agenti in esecuzione su questo computer per ${relay} termineranno, e telefono e browser non potranno raggiungerlo lì finché il servizio non ripartirà.`,
    stopAllConfirmTitle: 'Arrestare i servizi in background di Happier e uscire?',
    stopAllConfirmBody: 'Le sessioni degli agenti su questo computer termineranno, e telefono e browser non potranno raggiungerlo finché i suoi servizi in background non ripartiranno.',
    stopConfirmAction: 'Arresta',
    actionFailedTitle: 'Non è andata a buon fine',
    loginItemFailed: 'Impossibile aggiornare l’elemento di avvio di Happier',
    quitStopTitle: 'Ci sono ancora sessioni degli agenti in esecuzione',
    quitStopBody: 'Uscendo si arrestano i servizi in background di questo computer e terminano le sessioni in esecuzione qui.',
    quitStopUnknownTitle: 'Arrestare i servizi in background?',
    quitStopUnknownBody: 'Happier non vede quali sessioni sono in esecuzione su questo computer. Uscendo si arrestano i suoi servizi in background e terminano quelle in corso.',
    quitStopConfirm: 'Arresta comunque',
    quitStopKeep: 'Lasciali attivi',
    quitStopFailedTitle: 'Alcuni servizi in background non si sono arrestati',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier resta aperto così puoi controllare i servizi in background e riprovare.`,
};

const itLoginStart: DesktopLoginStartTranslation = {
    title: 'Avvia all’accesso',
    subtitle: 'Mantiene questo computer raggiungibile da telefono e browser: i suoi servizi in background si avviano all’accesso e continuano dopo l’uscita da Happier. Se è disattivato, uscire da Happier li arresta.',
    unknown: 'Happier non sa ancora se i servizi in background di questo computer si avviano all’accesso.',
    notSetUp: 'Disponibile quando questo computer sarà configurato.',
};

const menuBarModeTranslations = { it: { tray: it, loginStart: itLoginStart } };

return { menuBarModeTranslations };
})();

const Domain_nativePasswordTranslations = (() => {
const nativePasswordTranslations = { it: {
        email: 'Email',
        password: 'Password',
        signIn: 'Accedi',
        title: 'Email e password',
        forgotPassword: 'Password dimenticata?',
        capsLock: 'Blocco maiuscole è attivo',
        emailRequired: 'Inserisci il tuo indirizzo email.',
        passwordRequirements: 'Usa almeno 15 caratteri, fino a 1.024 byte UTF-8. Gli spazi sono consentiti.',
        unavailable: 'L’accesso con email e password non è disponibile su questo Home.',
        rateLimited: 'Troppi tentativi. Attendi un momento e riprova.',
        emailInvalid: 'Inserisci un indirizzo email valido.',
        passwordMalformed: 'Questa password contiene caratteri che non possiamo memorizzare in sicurezza. Riscrivila.',
        passwordMismatch: 'Le password non coincidono.',
        currentPasswordRequired: 'Inserisci la password attuale.',
        currentPassword: 'Password attuale',
        newPassword: 'Nuova password',
        confirmPassword: 'Conferma password',
        signInFailed: 'Questa combinazione di email e password non ha funzionato.',
        accountDisabledHere: 'Questo account è disattivato su questo Home. Chiedi a un’amministrazione del Home di riattivarlo.',
        notEligible: 'Questo account non può accedere a questo Home in questo momento.',
        linkExpired: 'Questo link è scaduto o è già stato usato. Richiedine uno nuovo.',
        revisionConflict: 'La tua password è cambiata altrove. Ricarica e riprova.',
        serverUnavailable: 'Questo Home non ha potuto completare la richiesta. Riprova tra poco.',
        offline: 'Nessuna connessione a questo Home. Controlla la rete e riprova.',
        homeUnreachable: 'Impossibile raggiungere questo Home. Riprova.',
        securityFactUnavailable: 'Impossibile leggerlo dal tuo Home.',
        cancelled: 'Il tentativo è stato annullato.',
        approvalPending: 'In attesa della tua approvazione. Controllala nella casella delle approvazioni, poi torna qui.',
        outcomeUnconfirmed: 'Non siamo riusciti a confermare se la modifica è stata applicata. Abbiamo aggiornato questo account: controllalo prima di riprovare.',
        recoveryKeyRequired: 'Inserisci la tua chiave di recupero per cambiare la password di questo account crittografato end-to-end. La chiave resta su questo dispositivo.',
        working: 'In corso…',
        showPassword: 'Mostra password',
        hidePassword: 'Nascondi password',
        createTitle: 'Crea il tuo account',
        createAccount: 'Crea account',
        accountProtection: 'Protezione dell’account',
        protectionPlain: 'Leggibile dal Home',
        protectionPlainDetail: 'Il tuo Home può leggere i tuoi dati. Se dimentichi la password, puoi reimpostarla via email.',
        protectionE2ee: 'Crittografia end-to-end',
        protectionE2eeDetail: 'Solo i tuoi dispositivi possono leggere i tuoi dati. Conserva la chiave di recupero: reimpostare la password da sola non li ripristina.',
        checkYourEmail: 'Controlla la tua email',
        resend: 'Invia di nuovo',
        resent: 'Inviato di nuovo. Controlla la tua email.',
        useDifferentEmail: 'Usa un’altra email',
        connectTitle: 'Aggiungi email e password',
        connectFromSecurity: 'Accedi con un metodo che già usi, poi aggiungi email e password da Sicurezza account.',
        signInFirst: 'Accedi prima',
        forgotTitle: 'Password dimenticata?',
        forgotExplanation: 'Possiamo inviarti istruzioni via email, oppure puoi usare la chiave di recupero salvata alla creazione dell’account.',
        emailResetInstructions: 'Inviami le istruzioni via email',
        useRecoveryKey: 'Usa la chiave di recupero',
        recoveryKeyDownload: 'Scarica la chiave di recupero',
        recoveryKeyLater: 'Fallo più tardi',
        securitySectionTitle: 'Email e password',
        signInEmail: 'Email di accesso',
        signInEmailNotSet: 'Non impostata',
        passwordEnrolled: 'Configurata',
        passwordNotEnrolled: 'Non configurata',
        passwordSetUp: 'La tua password è configurata per questo Home.',
        passwordChanged: 'La tua password è stata modificata.',
        passwordRemoved: 'La tua password è stata rimossa.',
        changePassword: 'Cambia password',
        removePassword: 'Rimuovi password',
        removePasswordSubtitle: 'Accedi solo con gli altri metodi',
        removePasswordConsequence: 'Email e password non ti faranno più accedere a questo Home. Gli altri metodi e i tuoi dati restano invariati.',
        changeEmailExplanation: 'Invieremo un’email al nuovo indirizzo per confermarlo. L’email attuale continua a funzionare fino alla conferma.',
        sendVerification: 'Invia email di conferma',
        verifyTitle: 'Conferma la tua email',
        verifyGeneric: 'Questo link conferma il controllo di una casella di posta.',
        verifyReturnToCreate: 'Torna a questo Home per completare la creazione dell’account con questo indirizzo.',
        addressVerified: 'Questo indirizzo è confermato.',
        confirmEmailChange: 'Usa come email di accesso',
        signInToConfirm: 'Accedi su questo dispositivo per confermare la modifica.',
        returnToSignIn: 'Torna all’accesso',
        continue: 'Continua',
        resetTitle: 'Imposta una nuova password',
        resetChooseNew: 'Scegli una nuova password per questo Home.',
        resetComplete: 'La tua password è stata cambiata. Accedi di nuovo con la nuova password.',
        resetSignsOutOtherDevices: 'Impostare una nuova password disconnette questo account ovunque.',
        setNewPassword: 'Salva nuova password',
        emailPlaceholder: 'tu@esempio.it',
        accountDisabled: ({ home }: { home: string }) => `Questo account è disattivato su ${home}. Chiedi a un’amministrazione del Home di riattivarlo.`,
        verificationSent: ({ email }: { email: string }) => `Abbiamo inviato un link di conferma a ${email}. Aprilo per completare la creazione dell’account.`,
        resetInstructionsSent: ({ email }: { email: string }) => `Se ${email} può accedere qui, le istruzioni per la reimpostazione sono in arrivo.`,
        verificationPending: ({ email }: { email: string }) => `Conferma inviata a ${email}`,
        verifyDestination: ({ email }: { email: string }) => `Questo link conferma ${email}.`,
        passwordNeedsEmail: 'Aggiungi prima un’email di accesso',
        passwordNeedsEmailHint: 'Inizia dalla tua email di accesso',
        setupStepConfirm: 'Conferma',
        setupProgress: ({ step, total, label }: { step: number; total: number; label: string }) => `Passaggio ${step} di ${total}: ${label}`,
        setupEmailHint: 'Email di accesso e password si aggiungono insieme. Prima inviamo un link per confermare l’indirizzo.',
        setupConfirmHint: 'Apri il link in quell’email per scegliere la password.',
        setupPasswordHint: 'Inserisci l’email che hai confermato, poi scegli la password.',
    } } as const;

return { nativePasswordTranslations };
})();

const Domain_navigationPlacementTranslations = (() => {
type NavigationPlacementTranslation = Shared_navigationPlacementTranslations.NavigationPlacementTranslation;

const navigationPlacementTranslations = { it: { customize: 'Personalizza…', title: 'Navigazione', description: 'Scegli cosa resta visibile, va in Altro o viene nascosto. Trascina per riordinare. Salvato su questo dispositivo.', pinned: 'Fissato', overflow: 'Altro', hidden: 'Nascosto', reset: 'Ripristina', appRail: 'Barra sinistra', sessionRail: 'Barra della sessione', workspaceRail: 'Barra dello spazio di lavoro', sessionTabBar: 'Schede del telefono' } } satisfies Pick<Record<string, NavigationPlacementTranslation>, "it">;

return { navigationPlacementTranslations };
})();

const Domain_pendingNavigationTranslations = (() => {
type Count = Shared_pendingNavigationTranslations.Count;

const en = Shared_pendingNavigationTranslations.en;

const it: typeof en = {
    nextWithCount: ({ count }) => `${count} ${count === 1 ? 'ha' : 'hanno'} bisogno di te`,
    next: 'Avanti', answeredElsewhere: 'Già risposto',
    unavailableTitle: 'Impossibile aprire la prossima richiesta',
    unavailableBody: 'Alcune sessioni in attesa non sono disponibili. Riconnettiti e riprova.',
    skippedUnavailable: ({ count }) => `${count} sessioni non disponibili sono state saltate.`,
    waitsForPermission: 'chiede il tuo permesso', waitsForInput: 'aspetta la tua risposta',
    sessionsWaiting: ({ count }) => `${count} sessioni in attesa`, go: 'Vai', dismiss: 'Non ora',
};

const pendingNavigationTranslations = { it };

return { pendingNavigationTranslations };
})();

const Domain_personalHomeBootstrapBlockedTranslations = (() => {
type PersonalHomeBootstrapBlockedTranslation = Shared_personalHomeBootstrapBlockedTranslations.PersonalHomeBootstrapBlockedTranslation;

const personalHomeBootstrapBlockedTranslations = { it: {
        blocked: {
            runtime_unhealthy: 'Il tuo Home locale richiede attenzione prima di potersi avviare.',
            home_auth_invalid: 'L’autenticazione del tuo Home richiede attenzione.',
            existing_runtime: 'Devi decidere cosa fare dell’Home locale esistente prima di continuare la configurazione.',
            existing_runtime_credentials: 'Questo Home locale appartiene a un’altra app Happier su questo computer.',
            personal_home_erased: 'Il tuo Home personale è stato cancellato. Riprova per crearne uno nuovo.',
        },
        blockedBody: { personal_home_erased: 'I dati del tuo Home sono stati eliminati. Qui non c’è più nulla da recuperare: crea un nuovo Home personale o usa un altro Home.' },
    } } as const satisfies Pick<Record<string, PersonalHomeBootstrapBlockedTranslation>, "it">;

return { personalHomeBootstrapBlockedTranslations };
})();

const Domain_personalHomeDecisionTranslations = (() => {
type HomeParams = Shared_personalHomeDecisionTranslations.HomeParams;

type PersonalHomeDecisionTranslation = Shared_personalHomeDecisionTranslations.PersonalHomeDecisionTranslation;

const en = Shared_personalHomeDecisionTranslations.en;

const it: PersonalHomeDecisionTranslation = {
    homeIdentityAmbiguous: 'Questo indirizzo dell’Home personale corrisponde a più Home salvati.',
    signedInHome: {
        status: 'Hai già effettuato l’accesso a un altro Home.',
        body: ({ home }: HomeParams) => `Questo computer ha effettuato l’accesso a ${home}. Continua a usarlo o configura qui un Home personale.`,
        keep: ({ home }: HomeParams) => `Continua con ${home}`,
        keepDetail: 'Le tue sessioni e le tue macchine restano esattamente come sono.',
        create: 'Configura un Home personale',
        createDetail: 'Crea un Home privato su questo computer e passa a quello.',
    },
    existingRuntimeCredentials: {
        body: 'Questa app non può aprirlo senza la chiave di recupero di quell’Home. Accedi con la chiave o usa un altro Home.',
        signIn: 'Accedi con una chiave di recupero',
        signInDetail: 'Usa la chiave di recupero salvata per questo Home locale.',
    },
};

const personalHomeDecisionTranslations = { it };

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

const it = {
    standardOnlyTitle: 'Connetti tramite gli indirizzi delle Home',
    standardOnlySubtitle: 'Su questo dispositivo, usa l’indirizzo di ogni Home anziché una connessione peer-to-peer.',
    installOrUpdateAction: 'Installa o aggiorna l’Home personale', startAction: 'Avvia l’Home personale', stopAction: 'Arresta l’Home personale',
    defaultHomeLabel: 'Home personale', homeTitle: 'Home', canonicalAddress: 'Indirizzo Home', identityComparison: 'Home attuale', identityComparisonMatch: 'Corrisponde', identityComparisonMismatch: 'Non corrisponde', identityComparisonUnknown: 'Impossibile confermare',
    unknownSize: 'Dimensione sconosciuta', unknownTimestamp: 'Timestamp sconosciuto', restoreBackupTitle: 'Backup', identityTitle: 'Identità dell’Home', identityUnavailable: 'Identità non disponibile', restoreBackupDate: 'Creato', restoreCompatibility: 'Compatibilità', restoreCompatible: 'Compatibile', restoreCompatibilityVerified: 'Verificato da questa versione', restoreBackupSize: 'Dimensione', restoreReplacementNotice: 'I dati attuali dell’Home verranno sostituiti. Verrà conservato un backup di recupero verificato.', restoreConfirmTitle: 'Sostituire e ripristinare questo Home personale?', restoreConfirmAction: 'Sostituisci e ripristina', relocateConfirmTitle: 'Spostare questo Home personale?', relocateConfirmBody: 'L’Home attuale verrà arrestato prima che la sua copia verificata diventi attiva nella destinazione.', relocateDestination: 'Destinazione', relocateConfirmAction: 'Sposta Home', recoverRestoreTitle: 'Recuperare il ripristino interrotto?', recoverRestoreBody: 'Annulla il ripristino interrotto usando il materiale di recupero conservato.', recoverRestoreAction: 'Recupera ripristino', eraseDataTitle: 'Eliminare i dati dell’Home personale?', eraseHomeTarget: 'Home', eraseDataBody: 'È separato dalla disinstallazione ed elimina definitivamente solo questi percorsi Home risolti:', estimatedSize: 'Dimensione stimata', summaryTitle: 'Home personale', footer: 'Il tuo Home resta su questo computer. Queste azioni non modificano altri Home.', statusTitle: 'Stato', notAvailable: 'Non disponibile', storageTitle: 'Archiviazione', masterSecretTitle: 'Segreto di accesso dell’Home', masterSecretPresent: 'Presente', masterSecretUnavailable: 'Non disponibile', inspectAction: 'Aggiorna dettagli Home', actionsTitle: 'Backup e ripristino', protectionTitle: 'Protezione', backupsSectionFooter: 'I backup contengono conversazioni leggibili, dati Home, stato dei dispositivi attendibili e il segreto di accesso dell’Home. Conservali solo in una posizione affidabile.', lastBackupTitle: 'Ultimo backup', lastBackupUnknown: 'Ultimo backup sconosciuto', backupsTitle: 'Archivi di backup', backupAction: 'Esegui backup ora', backupSubtitle: 'Crea e verifica un archivio Home in chiaro.', exportBackupAction: 'Esporta backup…', exportBackupSubtitle: 'Crea un backup verificato in una posizione a tua scelta.', verifyAction: 'Verifica backup…', verifySubtitle: 'Controlla un archivio senza ripristinarlo.', restoreAction: 'Ripristina…', restoreSubtitle: 'Convalida un backup prima di sostituire i dati Home.', relocateAction: 'Sposta Home…', relocateSubtitle: 'Sposta questo Home su un computer gestito.', relocationFinishAction: 'Completa spostamento', relocationReturnAction: 'Torna all’Home originale', relocationFinishSubtitle: 'Completa lo spostamento dopo aver verificato la destinazione.', relocationReturnSubtitle: 'Mantieni l’Home originale come posizione attiva.', recoverRestoreSubtitle: 'Un ripristino interrotto può essere annullato esplicitamente.', restoreRecoveryWarningTitle: 'Il ripristino richiede una correzione', restoreRecoveryWarningBody: 'Lo stato di recupero è ambiguo. Non verrà apportata alcuna modifica automatica. Esamina la diagnostica prima di correggere questo Home.', restoreCleanupWarningTitle: 'La pulizia del ripristino richiede attenzione', restoreCleanupWarningBody: 'L’Home è stato ripristinato, ma la pulizia automatica non è terminata. Controlla la diagnostica e riprova l’operazione dell’Home.', backupVerified: 'Backup verificato', backupNeedsAttention: 'Backup verificato; il riavvio dell’Home richiede attenzione', backupHomeReady: 'Home riavviato', backupRevealAction: 'Mostra backup', restoreResultTitle: 'Risultato del ripristino', restoreOutcomeRecoveryRequired: 'Recupero necessario', restoreOutcomeRolledBack: 'Ripristino annullato', restoreOutcomeRestored: 'Home ripristinato', advancedTitle: 'Avanzate', advancedFooter: 'Controlli runtime e diagnostica per questo computer.', restartAction: 'Riavvia l’Home personale', openDataLocationAction: 'Apri posizione dati Home', openLogsAction: 'Apri log runtime', removeProfileAction: 'Rimuovi Home da Happier', removeProfileSubtitle: 'Rimuove questo profilo; i dati runtime restano su questo computer.', removeProfileTitle: 'Rimuovere il profilo dell’Home personale?', removeProfileBody: 'Rimuove il profilo, ma conserva runtime e dati.', uninstallRuntimeAction: 'Disinstalla runtime, conserva i dati', uninstallRuntimeSubtitle: 'Rimuove servizio e binari; i dati Home vengono conservati.', deleteHomeDataTitle: 'Elimina dati Home', removeSectionFooter: 'La disinstallazione conserva i dati Home. L’eliminazione permanente è un’azione confermata separata.', eraseDataAction: 'Elimina definitivamente i dati dell’Home personale', eraseDataSubtitle: 'Separata dalla disinstallazione. Elimina definitivamente i dati Home risolti.', eraseResultTitle: 'Dati Home eliminati', eraseStoppedHome: 'L’Home in esecuzione è stato arrestato', eraseHomeAlreadyStopped: 'L’Home era già arrestato', eraseRemainingPaths: 'Impossibile rimuovere', progressTitle: 'Operazione dell’Home personale', dismissResult: 'Chiudi',
    repairSearchAction: 'Ricostruisci la ricerca dell’Home',
    repairSearchSubtitle: 'Ricrea l’indice di ricerca dalle conversazioni di questo Home.',
    repairSearchCompleteTitle: 'Ricerca dell’Home ricostruita',
    repairSearchCompleteBody: 'L’indice di ricerca è stato ricreato dalle conversazioni di questo Home.',
    backupCleanupRequired: 'Il backup è al sicuro; rimuovi il percorso di staging protetto mostrato nei dettagli',
    backupCleanupPath: 'Percorso di staging protetto da rimuovere',
    backupCleanupError: 'Errore di pulizia',
    backupDestinationMismatch: 'Il backup non è stato creato nella destinazione selezionata. Non è stato eliminato nulla.',
    backupDestinationUnsafe: 'La destinazione di backup selezionata si trova all’interno dei dati dell’Home personale che verrebbero eliminati. Non è stato eliminato nulla.',
    eraseInspectionAttention: 'Dati dell’Home eliminati; la verifica richiede attenzione',
    searchTitle: 'Ricerca',
    searchReady: 'Pronta',
    searchIndexing: 'Indicizzazione…',
    searchUnavailable: 'Non disponibile',
    localOnlyIngressTitle: 'Raggiungibile solo da questo computer',
    localOnlyIngressBody: 'Le condivisioni pubbliche, i callback dei provider, i webhook dei plugin e le notifiche mentre questo computer è in sospensione restano non disponibili finché questo Home non è raggiungibile dall’esterno.',
} satisfies PersonalHomeSettingsCopy;

const backupDisclosureBody = { it: 'Questo backup contiene conversazioni leggibili, dati dell’Home, il segreto di accesso dell’Home e lo stato dei dispositivi attendibili. Chiunque possa ripristinare l’archivio completo può gestire un clone di questo Home. Salvalo in un luogo attendibile.' } as const;

const eraseBackupOffer = { it: { title: 'Eseguire prima il backup di questo Home?', body: 'L’eliminazione dei dati dell’Home non può essere annullata. Crea prima un backup verificato oppure continua senza backup.', continueWithoutBackup: 'Continua senza backup' } } as const;

const operationOutcome = { it: {
        erasePartialTitle: 'Non è stato possibile eliminare alcuni dati dell’Home',
        eraseOutcomeSummary: ({ removed, remaining }) => `${removed} ${removed === 1 ? 'elemento rimosso' : 'elementi rimossi'}`
            + (remaining > 0 ? `; ${remaining} ${remaining === 1 ? 'non è stato rimosso' : 'non sono stati rimossi'}` : ''),
        eraseNotPerformed: 'Non è stato eliminato nulla',
        eraseBlockedBackupMismatch: 'Questo backup proviene da un altro Home.',
        eraseBlockedIdentityUnknown: 'Happier non è riuscito a confermare che questo backup corrisponda a questo Home.',
        eraseVerificationDetail: 'Verifica',
        operationFailed: 'Questa operazione dell’Home non è stata completata. Apri Dettagli per vedere cos’è successo.',
        restorePreviousDataTitle: 'Dati precedenti salvati',
    } } as const satisfies Pick<Record<string, OperationOutcomeCopy>, "it">;

const personalHomeSettingsTranslations = { it: { ...it, ...operationOutcome.it, backupDisclosureBody: backupDisclosureBody.it, eraseBackupOfferTitle: eraseBackupOffer.it.title, eraseBackupOfferBody: eraseBackupOffer.it.body, eraseContinueWithoutBackup: eraseBackupOffer.it.continueWithoutBackup } } as const;

return { backupDisclosureBody, eraseBackupOffer, operationOutcome, personalHomeSettingsTranslations };
})();

const Domain_personalizeTranslations = (() => {
type PersonalizeTranslation = Shared_personalizeTranslations.PersonalizeTranslation;

const en = Shared_personalizeTranslations.en;

const pluralPl = Shared_personalizeTranslations.pluralPl;

const pluralRu = Shared_personalizeTranslations.pluralRu;

const it: PersonalizeTranslation = {
    cardTitle: 'Personalizza Happier',
    cardSubtitle: 'Sei scelte rapide, ognuna con anteprima dal vivo.',
    cardAction: 'Personalizza',
    cardContinue: 'Continua',
    cardProgress: ({ saved, total, step }) => `Scelte salvate: ${saved} di ${total}. Riprendi da ${step}.`,
    cardProgressReview: ({ saved, total }) => `Scelte salvate: ${saved} di ${total}. Rivedi la tua configurazione.`,
    inPlaceTitle: 'Rendi Happier tuo',
    inPlaceBody: 'Sei scelte rapide, ognuna con anteprima dal vivo. Inizia dal look: Home cambia mentre scegli.',
    inPlaceContinue: ({ count }) => `Continua · ancora ${count}`,
    notNow: 'Non ora',
    flowTitle: 'Personalizza Happier',
    finishLater: 'Finisci più tardi',
    later: 'Più tardi',
    stepEyebrow: ({ n, total, name }) => `Passo ${n} di ${total} · ${name}`,
    stepCounter: ({ n, total }) => `${n} di ${total}`,
    styleEyebrow: 'Facoltativo',
    summaryEyebrow: 'Tutto pronto',
    previewNote: 'Anteprima. Non viene salvato nulla finché non premi Avanti.',
    previewNoteSummary: 'Il tuo spazio di lavoro, com’è adesso.',
    next: 'Avanti',
    review: 'Rivedi',
    useThisSetup: 'Usa questa configurazione',
    saveFailed: 'Questo passo non è stato salvato. La tua scelta è ancora selezionata.',
    tryAgain: 'Riprova',
    skipThisStep: 'Salta questo passo',
    scopeThisDevice: 'Questo dispositivo',
    scopeAllDevices: 'Tutti i tuoi dispositivi',
    stepsLabel: 'Passi',
    savedStepsNote: ({ count }) => count === 1 ? '1 passo è già salvato.' : `${count} passi sono già salvati.`,
    lookName: 'Look',
    lookTitle: 'Rendilo comodo',
    lookDescription: 'Chiaro, scuro o come il tuo sistema, e quanto vetro mostra l’app.',
    themeLabel: 'Tema',
    glassLabel: 'Vetro',
    glassAutoDescription: 'Vetro in tutta l’app, a strati',
    glassEverywhereDescription: 'Un unico vetro uniforme ovunque',
    glassSolidDescription: 'Tutte le superfici opache',
    glassCustomNote: 'Hai regolato il vetro in Aspetto. Scegli un preset per sostituirlo o mantieni il tuo.',
    customizeInAppearance: 'Personalizza in Aspetto…',
    styleName: 'Stile',
    styleTitle: 'Parti da uno stile',
    styleDescription: 'Ogni stile definisce come si leggono le sessioni e come appare l’elenco. Compila solo i passi successivi: non viene salvato nulla finché non premi Avanti in ciascuno.',
    styleKeep: 'Mantieni la mia configurazione attuale',
    styleActivity: 'Attività',
    styleConversation: 'Conversazione',
    styleDetail: 'Dettaglio',
    styleCustomTag: 'Personalizzato',
    styleDefaultTag: 'Predefinito di Happier',
    styleChanges: ({ style, count }) => count === 1 ? `${style} cambia 1 cosa` : `${style} cambia ${count} cose`,
    styleNoChanges: 'Questa è già la tua configurazione.',
    styleNever: 'Tema, notifiche, privacy e permessi degli agenti non fanno mai parte di uno stile.',
    was: ({ value }) => `prima: ${value}`,
    conversationName: 'Conversazione',
    conversationTitle: 'Segui la conversazione',
    conversationDescription: 'Come si leggono i turni di una sessione e il pensiero dell’agente.',
    layoutLabel: 'Layout',
    thinkingLabel: 'Pensiero',
    toolsName: 'Chiamate agli strumenti',
    toolsTitle: 'Guarda cosa ha fatto l’agente',
    toolsDescription: 'Come compaiono comandi, modifiche e letture in una sessione.',
    toolsLabel: 'Chiamate agli strumenti',
    toolTapLabel: 'Clic su uno strumento',
    toolDetailLabel: 'Dettaglio strumenti',
    toolDetailDefault: 'Predefinito',
    toolDetailFull: 'Completo',
    workName: 'Il tuo lavoro',
    workTitle: 'Ritrova il tuo lavoro',
    workDescription: 'Come è organizzato l’elenco delle sessioni e quanto mostra ogni riga.',
    listLayoutLabel: 'Elenco sessioni',
    rowsLabel: 'Righe',
    attentionName: 'Attenzione',
    attentionTitle: 'Nota ciò che ti aspetta',
    attentionDescription: 'Dove compaiono nell’elenco le sessioni che ti aspettano o sono pronte da rivedere.',
    attentionLabel: 'Sessioni che ti aspettano',
    attentionHomeNote: 'Home mostra sempre ciò che ti aspetta. Questo cambia solo l’elenco delle sessioni.',
    notificationsName: 'Notifiche',
    notificationsTitle: 'Resta aggiornato',
    notificationsDescription: 'Cosa ti segnala questo dispositivo mentre guardi altro.',
    notificationsAllowed: 'Le notifiche sono consentite su questo dispositivo.',
    notificationsNotAllowed: 'Happier non può ancora mostrare notifiche su questo dispositivo.',
    notificationsUnsupported: 'Le notifiche non sono disponibili su questo dispositivo. Configurale nell’app desktop o sul telefono.',
    scopeLook: 'Tema su questo dispositivo · vetro su tutti i dispositivi',
    notificationsNeedsYouSummary: 'Ha bisogno di te',
    notificationsFinishedSummary: 'Completato',
    notificationsAllow: 'Consenti notifiche',
    notificationsTellMe: 'Avvisami quando',
    notificationsNeedsYou: 'Una sessione richiede un’approvazione o una risposta',
    notificationsFinished: 'Una sessione termina il suo turno',
    notificationsShowLabel: 'Le notifiche mostrano',
    notificationsShowDescription: 'Comandi, domande e risposte possono comparire sulla schermata di blocco.',
    notificationsMessage: 'Il messaggio',
    notificationsStatus: 'Solo lo stato',
    notificationsPhoneNote: 'Gli avvisi sul telefono mentre Happier è chiuso si configurano sul telefono.',
    notificationsOff: 'Nessuna notifica',
    sampleNeedsYouTitle: 'Revisione #2481 ti aspetta',
    sampleNeedsYouBody: 'L’agente vuole eseguire yarn test:e2e in ~/happier. Consentire?',
    sampleReadyTitle: '«Correggi test di riconnessione instabile» è pronto',
    sampleReadyBody: 'Trovato: il timer dei tentativi non veniva mai azzerato. È corretto e il test passa.',
    sampleStatusBody: 'Apri Happier per vederlo.',
    sampleSessionReconnect: 'Correggi test di riconnessione instabile',
    sampleSessionCraft: 'Laboratorio di rifinitura',
    sampleSessionReview: 'Revisione #2481',
    sampleSessionPricing: 'Testi della pagina prezzi',
    sampleSessionDocs: 'Indice di ricerca della documentazione',
    sampleWorking: 'Al lavoro',
    sampleNeedsYou: 'Ti aspetta',
    sampleReady: 'Pronto da rivedere',
    summaryTitle: 'Ecco la tua configurazione',
    summaryDescription: ({ changed }) => changed === 0
        ? 'Tutto ciò che segue è già salvato. Non è cambiato nulla.'
        : changed === 1
            ? 'Tutto ciò che segue è già salvato. È cambiata una scelta; il resto è rimasto com’era.'
            : `Tutto ciò che segue è già salvato. Sono cambiate ${changed} scelte; il resto è rimasto com’era.`,
    summaryChange: 'Cambia',
    summaryFooter: 'Puoi cambiare tutto questo più tardi in Impostazioni, o ripercorrerlo da Impostazioni → Aspetto.',
    replayTitle: 'Personalizza Happier',
    replaySubtitle: 'Sei scelte rapide, ognuna con anteprima dal vivo.',
    replayAction: 'Inizia',
    journeyHandoff: 'Rendilo tuo',
};

const personalizeTranslations = { it } satisfies Pick<Readonly<Record<string, PersonalizeTranslation>>, "it">;

return { personalizeTranslations };
})();

const Domain_phoneNavigationTranslations = (() => {
const en = Shared_phoneNavigationTranslations.en;

const it: typeof en = {
    phoneNav: {
        settings: {
            sectionDescription: 'Il layout telefono dentro le sessioni e i gesti sulla sua barra. Ogni gesto si può disattivare da solo.',
            swipeSidewaysTitle: 'Scorri di lato per cambiare sessione',
            swipeSidewaysScrollsDescription: 'Precedente o successiva, sulla barra. Quando i tuoi strumenti non entrano, scorrere li fa scorrere.',
            swipeSidewaysAlwaysDescription: 'Precedente o successiva, sulla barra. Resta uno scorrimento; gli strumenti che non entrano aspettano in Altro.',
            alwaysSwipeTitle: 'Scorri sempre tra le sessioni',
            alwaysSwipeOnDescription: 'La barra tiene gli strumenti che entrano; il resto aspetta in Altro.',
            alwaysSwipeOffDescription: 'Disattivato: gli strumenti extra fanno scorrere la barra.',
            dragUpTitle: 'Trascina in alto per cambiare',
            dragUpDescription: 'Trascina la barra in alto per vedere le schede aperte e le sessioni recenti, poi scorri fino a una.',
            dragUpSourceTitle: 'Trascina in alto mostra',
            dragUpSourceRecentDescription: 'Schede aperte, poi ciò che hai aperto di recente su questo dispositivo.',
            dragUpSourceListDescription: 'Sessioni nell’ordine dell’elenco.',
            swipeSourceTitle: 'Scorri di lato mostra',
            swipeSourceListDescription: 'La sessione successiva o precedente nel tuo elenco.',
            swipeSourceRecentDescription: 'La successiva o precedente in base a quando l’hai aperta l’ultima volta.',
            sourceRecent: 'Recenti',
            sourceList: 'Elenco sessioni',
            flickTitle: 'Scatta in alto o in basso per cambiare',
            flickDescription: 'Un gesto rapido apre la successiva o la precedente.',
            holdToDockTitle: 'Tieni premuto per lasciare aperto il selettore',
            holdToDockDescription: 'Tieni premuta la barra e rilascia per scegliere con un tocco.',
            pullAllTabsTitle: 'Tira giù il titolo per tutte le schede',
            pullAllTabsDescription: 'Trascina in basso il titolo della sessione per vedere ogni scheda aperta e sessione recente.',
        },
        bar: {
            onTheBar: 'Sulla barra',
            more: 'Altro',
            heldInMore: 'In Altro finché “Scorri sempre” è attivo',
            keepOnBar: 'Tieni sulla barra',
            removeFromBar: 'Rimuovi dalla barra',
            openFiles: 'Apri file',
        },
        allTabs: {
            title: 'Tutte le schede',
            pullHint: 'Tira per tutte le schede',
            releaseHint: 'Rilascia per tutte le schede',
            openTabs: 'Schede aperte',
            openTabsSynced: 'Schede aperte · sincronizzate',
            recent: 'Recenti',
            recentOnThisDevice: 'Recenti su questo telefono',
            here: 'Qui',
            panes: ({ count }: { count: number }) => `${count} pannelli`,
            emptyTitle: 'Nient’altro è aperto',
            emptyDescription: 'Le sessioni che apri e le schede che tieni compaiono qui, le più recenti per prime.',
            openTab: ({ title }: { title: string }) => `Apri ${title}`,
        },
        rail: {
            label: 'Schede aperte',
            synced: 'Sincronizzate',
            syncedA11y: 'Le schede aperte si sincronizzano tra i tuoi dispositivi',
            notAvailableTitle: 'Non disponibile su questo telefono',
            notAvailableUnknown: 'Questa scheda è stata aperta su un altro dispositivo e questo telefono non può mostrarla. Lì resta aperta.',
            closeTab: 'Chiudi scheda',
            paneOf: ({ position, total }: { position: number; total: number }) => `${position} di ${total}`,
            nextPane: 'Pannello successivo',
            chatPane: 'Chat',
        },
        switcher: {
            title: 'Passa a',
            allSessions: 'Tutte le sessioni',
            openTabs: 'Schede aperte',
            synced: 'sincronizzate',
            recent: 'Recenti',
            recentOnThisDevice: 'Recenti su questo telefono',
            sessions: 'Sessioni',
            nextInSessions: 'Successiva in Sessioni',
            previousInSessions: 'Precedente in Sessioni',
            furtherBack: 'Più indietro',
            moreRecent: 'Più recente',
            here: 'Qui',
            stayOn: 'Resta su',
            noOlderSessions: 'Nessuna sessione più vecchia',
            noNewerSessions: 'Nessuna sessione più recente',
            lastInSessions: 'Questa è l’ultima in Sessioni.',
            firstInSessions: 'Questa è la prima in Sessioni.',
            nothingFurtherBack: 'Niente più indietro.',
            mostRecent: 'Questa è la più recente.',
            nothingToSwitch: 'Nient’altro è aperto',
            nothingToSwitchDescription: 'Le sessioni che apri compaiono qui, le più recenti per prime.',
            draft: ({ text }: { text: string }) => `La tua bozza: “${text}”`,
            switchSessionAction: 'Cambia sessione',
            switchedTo: ({ name }: { name: string }) => `Passato a ${name}`,
            close: 'Chiudi',
            positionOf: ({ position, total }: { position: number; total: number }) => `${position} di ${total}`,
        },
    },
};

const phoneNavigationTranslations = { it };

return { phoneNavigationTranslations };
})();

const Domain_pluginAccountDataEraseTranslations = (() => {
const english = Shared_pluginAccountDataEraseTranslations.english;

const pluginAccountDataEraseTranslations = { it: {
    accountDataErase: {
        installedGroupTitle: 'Dati del conto',
        installedGroupFooter: 'Ciò influisce sui dati conservati solo per l\'account corrente. Non disinstalla questo plugin da nessun computer.',
        installedEntryTitle: 'Cancella i dati dell\'account',
        installedEntrySubtitle: 'Rimuovi permanentemente i dati conservati di questo plugin dall\'account corrente.',
        orphanedGroupTitle: 'Dati del plugin conservati',
        orphanedGroupFooter: 'Utilizza un ID plug-in per rimuovere i dati dell\'account conservati dopo la rimozione di un plug-in.',
        orphanedEntryTitle: 'Cancella i dati del plugin conservati',
        orphanedEntrySubtitle: 'Inserisci un ID plug-in installato o rimosso per cancellare permanentemente i dati dell\'account corrente.',
        promptTitle: 'ID del plug-in',
        promptBody: 'Inserisci l\'ID del plugin di cui desideri cancellare i dati conservati dall\'account corrente.',
        promptPlaceholder: 'com.esempio.plugin',
        invalidTitle: 'Inserisci un ID plug-in',
        invalidBody: 'Utilizza l\'ID plug-in esatto prima di continuare.',
        confirmTitle: 'Cancellare i dati del plug-in dell\'account?',
        confirmBody: ({ pluginId }: { pluginId: string }) => `Ciò rimuove permanentemente i dati conservati per ${pluginId} dal Conto Corrente. Non disinstalla il plugin dai tuoi computer.`,
        confirm: 'Cancellare i dati',
        completedTitle: 'Dati del plug-in dell\'account cancellati',
        completedChanged: 'I dati del plugin conservati sono stati rimossi dall\'account corrente.',
        completedEmpty: 'Nessun dato del plugin conservato è stato trovato per questo plugin nell\'Account corrente.',
        partialTitle: 'Rimangono alcuni dati del plugin',
        partialBody: 'Non è stato possibile cancellare alcuni dati conservati. Niente verrà riprovato automaticamente; riprovare a cancellare i dati rimanenti.',
        failedTitle: 'I dati del plugin non sono stati cancellati',
        failedBody: 'I dati conservati non possono essere cancellati. Riprova dopo aver verificato la connessione dell\'account corrente.',
        unavailableTitle: 'I dati del plugin non sono disponibili',
        unavailableBody: 'L\'account corrente è cambiato o non è disponibile. Riapri questa azione quando l\'account sarà pronto.',
    },
} } as const;

return { pluginAccountDataEraseTranslations };
})();

const Domain_pluginAccountReleaseSelectionTranslations = (() => {
const english = Shared_pluginAccountReleaseSelectionTranslations.english;

const completeReleaseSelection = Shared_pluginAccountReleaseSelectionTranslations.completeReleaseSelection;

const localizedPluginAccountReleaseSelectionTranslations = { it: {
    accountReleaseSelection: {
        groupTitle: 'Rilascio del conto',
        groupFooter: 'Seleziona una versione esatta per questo account. Questo non installa, aggiorna o considera attendibile il plug-in su nessun computer.',
        entryTitle: 'Utilizzare per questo account',
        entrySubtitle: ({ version }: { version: string }) => `Seleziona la versione ${version} per il Conto corrente senza modificare alcuna installazione della macchina.`,
        selectedTitle: 'Rilascio dell\'account selezionato',
        selectedBody: 'La versione del plugin selezionata verrà ora utilizzata per questo account.',
        conflictTitle: 'La versione dell\'account è cambiata',
        conflictBody: 'La versione dell\'account è cambiata mentre questa azione era aperta. Riaprilo e riprova.',
        unavailableTitle: 'Rilascio dell\'account non disponibile',
        unavailableBody: 'La versione esatta o la fonte di migrazione richiesta non sono disponibili per l\'account corrente. Riprova quando l\'account è pronto.',
        rejectedTitle: 'Il rilascio dell\'account non è stato selezionato',
        rejectedBody: 'L\'account non ha accettato questa selezione di rilascio. Controlla lo stato dell\'account e riprova.',
        hostedGroupFooter: 'Gestisci gli artefatti del plugin che questo account ospita per il plugin. Nessuna macchina offre al momento questa versione, quindi non è selezionabile qui.',
        hostedEnableTitle: 'Ospita gli artefatti del plugin per questo account',
        hostedEnableBody: "Salva l’interfaccia e le risorse del pacchetto sul server del tuo account. Per gli account in chiaro, il server può leggere i dati; con E2EE, memorizza dati cifrati. I metadati della versione restano visibili. Questo non installa il plugin, non gli accorda fiducia e non consente l’esecuzione su una macchina offline.",
        hostedDisableTitle: 'Smetti di ospitare gli artefatti del plugin',
        hostedStatusDisabled: "Disattivato. Attiva l’hosting per scaricare gli artefatti di questa versione quando la macchina di origine è offline.",
        hostedStatusPending: 'Attivato. Questa versione attende che l\'host pubblichi gli artefatti esatti del plugin.',
        hostedStatusReady: 'Gli artefatti del plugin ospitati sono disponibili per questa versione esatta.',
        hostedRemoveTitle: 'Disattiva l\'hosting e rimuovi gli artefatti',
        hostedRemoveBody: 'Interrompe l\'hosting dell\'account e rimuove gli artefatti del plugin ospitati di questa versione. La pulizia della cache locale è separata.',
        hostedClearCacheTitle: 'Svuota la cache locale degli artefatti',
        hostedClearCacheBody: 'Rimuove i byte degli artefatti di interfaccia memorizzati localmente per questa versione esatta senza modificare l\'hosting dell\'account.',
    },
} } as const;

const pluginAccountReleaseSelectionTranslations = { it: completeReleaseSelection(localizedPluginAccountReleaseSelectionTranslations.it) };

return { localizedPluginAccountReleaseSelectionTranslations, pluginAccountReleaseSelectionTranslations };
})();

const Domain_pluginInvocationLogTranslations = (() => {
const en = Shared_pluginInvocationLogTranslations.en;

const it = {
    invocationLogs: {
        title: 'Registri delle invocazioni',
        footer: 'Record limitati e redatti dalla macchina del plugin selezionata.',
        correlationFilter: 'Filtro ID di correlazione',
        correlationFilterAll: 'Tutte le invocazioni di questo plugin',
        correlationPromptTitle: 'Filtra per ID di correlazione',
        correlationPromptBody: 'Mostra solo i record di una singola invocazione esatta del plugin. Lascia vuoto per mostrare tutti i record.',
        correlationPromptPlaceholder: 'ID di correlazione',
        refresh: 'Aggiorna registri',
        follow: 'Segui registri',
        stopFollowing: 'Interrompi il monitoraggio',
        loadMore: 'Carica i record successivi',
        loadingTitle: 'Caricamento dei registri delle invocazioni',
        loadingSubtitle: 'Lettura di record limitati e redatti dalla macchina selezionata.',
        idleTitle: 'Pronto a leggere i registri delle invocazioni',
        idleSubtitle: 'Aggiorna per leggere record limitati e redatti dalla macchina selezionata.',
        emptyTitle: 'Nessun registro delle invocazioni',
        emptySubtitle: 'Non sono disponibili record redatti corrispondenti su questa macchina selezionata.',
        unavailableTitle: 'Registri delle invocazioni non disponibili',
        unavailableSubtitle: 'La macchina del plugin selezionata non è disponibile o non è più attuale.',
        readerUnavailableSubtitle: 'La macchina del plugin selezionata non può fornire registri delle invocazioni in questo momento.',
        selectionRequiredTitle: 'Seleziona una macchina del plugin',
        selectionRequiredSubtitle: 'Scegli sopra una materializzazione compatibile del plugin prima di leggere i relativi registri.',
        conflictTitle: 'Risolvi la macchina del plugin selezionata',
        conflictSubtitle: 'Scegli sopra una materializzazione compatibile del plugin prima di leggere i relativi registri.',
        errorTitle: 'Impossibile caricare i registri delle invocazioni',
        errorSubtitle: 'La lettura dei registri non è stata completata. Riprova quando la macchina selezionata è disponibile.',
        noMessage: 'Evento del registro del plugin',
        level: {
            debug: 'Modalità debug',
            info: 'Informazioni',
            warn: 'Avviso',
            error: 'Errore',
            diagnostic: 'Diagnostica',
        },
    },
};

const pluginInvocationLogTranslations = { it } as const;

return { pluginInvocationLogTranslations };
})();

const Domain_pluginMachineMatrixTranslations = (() => {
const english = Shared_pluginMachineMatrixTranslations.english;

const pluginMachineMatrixTranslations = { it: {
        machineMatrix: {
            title: 'Sulle tue macchine',
            footer: 'Sola lettura. Installazione, aggiornamento e ogni altra azione del plugin vengono eseguite sulla macchina selezionata sopra.',
            empty: 'Nessuna macchina ha ancora segnalato un’installazione di plugin per questo account.',
            unavailable: 'La disponibilità dei plugin dell’account non è ancora stata caricata, quindi gli stati delle macchine sono sconosciuti.',
            incomplete: ({ count }: { count: number }) => `Questo elenco può essere incompleto: ${count} server non hanno ancora segnalato le loro macchine.`,
            summary: ({ installed, total }: { installed: number; total: number }) => `Installato e aggiornato su ${installed} macchine su ${total}`,
            lastObserved: ({ ago }: { ago: string }) => `visto l’ultima volta: ${ago}`,
            state: {
                installedCurrent: 'Installato e aggiornato',
                disabled: 'Disattivato',
                untrusted: 'Non attendibile',
                incompatible: 'Release diversa',
                localOnly: 'Locale a questa macchina',
                staleOffline: 'Ultimo stato noto, macchina offline',
                absent: 'Non installato',
                unknown: 'Sconosciuto',
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

const marketplacePresentation = { it: {
        diagnosticsIssueTitle: 'Problema del plugin', diagnosticsRecovery: 'Controlla i dettagli sopra, quindi ricarica il plugin o questa pagina dopo la correzione.', diagnosticsTechnicalCode: ({ code }: { code: string }) => `Codice tecnico: ${code}`,
        discover: { publisherLabel: ({ displayName, id }: { displayName: string; id: string }) => `Etichetta editore: ${displayName} (${id})`, categories: ({ values }: { values: string }) => `Categorie: ${values}`, runtimeSummary: ({ realms, platforms }: { realms: string; platforms: string }) => `Esecuzione: ${realms} · Piattaforme: ${platforms}`, reviewStatus: { curated: 'Suggerimento selezionato', unreviewed: 'Non verificato', withdrawn: 'Ritirato' }, executableRealm: { daemon: 'servizio in background', client: 'app', hostedWeb: 'web ospitato' }, platform: { darwin: 'macOS', linux: 'Linux', windows: 'Windows', web: 'Web', ios: 'iOS', android: 'Android' }, diagnostic: { title: 'Problema con una fonte del marketplace', recovery: 'Aggiorna Scopri. Se continua, controlla Fonti e registri.', unreachableTitle: ({ source }: { source: string }) => `Impossibile raggiungere ${source}`, behindTitle: ({ source }: { source: string }) => `${source} ha risposto con dati vecchi o incompleti`, indexTitle: 'L’indice dei plugin è incompleto', otherSourcesShown: 'I risultati delle altre fonti restano visibili.' } },
    } } as const;

const localizedTechnicalReviewVocabulary = { it: { source: ({ kind, locator }: { kind: string; locator: string }) => `${kind}: ${locator}`, sourceKind: { path: 'Percorso locale', archive: 'File di archivio', npm: 'Pacchetto npm' }, marketplaceSource: ({ kind, source }: { kind: string; source: string }) => `${kind}: ${source}`, marketplaceSourceKind: { curated: 'Catalogo selezionato', 'community-npm': 'Catalogo npm pubblico', user: 'Catalogo personale' }, executableRealm: { daemon: 'Codice del servizio in background', reactNative: 'Codice dell’interfaccia dell’app', hostedWeb: 'Codice web ospitato isolato' }, uiArtifacts: ({ status, ids }: { status: string; ids: string }) => `${status}: ${ids}`, uiArtifactStatus: { verified: 'Risorse dell’interfaccia verificate', none: 'Nessuna risorsa dell’interfaccia', unavailable: 'Risorse dell’interfaccia non disponibili' }, authorizationClass: { cooperativeDisclosure: 'Divulgazione cooperativa', hostResourceSelection: 'Risorse host selezionate', presentIntentOrOs: 'Intento corrente o autorizzazione del sistema' }, priority: ({ priority }: { priority: number }) => `Priorità ${priority}` } } as const;

const localizedReviewVocabulary = { it: {
        installReviewSections: {
            ...localizedTechnicalReviewVocabulary.it,
            archiveUrlRetention: 'Happier salva l’URL completo dell’archivio sulla macchina selezionata, incluse eventuali credenziali, per gli aggiornamenti futuri. Gli URL scaduti o revocati possono far fallire gli aggiornamenti.',
            trustedCodeTitle: 'Codice attendibile', trustedCodeDisclosure: 'I plugin vengono eseguiti come codice attendibile dentro Happier, non in una sandbox. Un plugin può usare direttamente i permessi di questa app — file, rete, ambiente e processi — oltre ai servizi mediati da Happier elencati qui sotto. Quell’elenco è ciò che il plugin ha dichiarato e ciò che potrai disattivare in seguito, non un limite a ciò che il suo codice può raggiungere.', identity: 'Identità e pacchetto', evidence: 'Dettagli tecnici', executableCode: 'Codice eseguibile e contributi', requiredAccess: 'Accesso obbligatorio all’host', optionalAccess: 'Accesso facoltativo all’host', requestInterceptors: 'Intercettori delle richieste', rawCredentials: 'Dichiarazioni di accesso diretto alle credenziali', compatibility: 'Compatibilità e aggiornamenti', none: 'Nessuna dichiarazione', scope: ({ scope }: { scope: string }) => `Ambito: ${scope}`, developmentPath: ({ locator }: { locator: string }) => `${locator} · sviluppo`, publisherUnverified: ({ displayName, id }: { displayName: string; id: string }) => `${displayName} · ${id} · non verificato`, integrityBasis: { expected: ({ integrity }: { integrity: string }) => `${integrity} (prevista)`, observed: ({ integrity }: { integrity: string }) => `${integrity} (osservata)` }, signatureStatus: { verified: ({ keyId }: { keyId: string }) => `Firma del registro verificata: ${keyId}`, unsupported: ({ keyId }: { keyId: string }) => `Firma del registro non supportata: ${keyId}` }, provenanceDeclaredUnverified: ({ predicateType }: { predicateType: string }) => `Dichiarata, non verificata: ${predicateType}`, provenanceRetrievedUnverified: ({ predicateTypes }: { predicateTypes: string }) => `Recuperata, non verificata: ${predicateTypes}`, provenanceUnavailable: ({ code }: { code: string }) => `Provenienza non disponibile: ${code}`, curationUnreviewed: ({ sourceId }: { sourceId: string }) => `Fonte del catalogo non esaminata: ${sourceId}`, curationApproved: ({ sourceId, reviewedAt, reason }: { sourceId: string; reviewedAt: string; reason: string }) => `Esaminata da ${sourceId} il ${reviewedAt}${reason}`, savedSecret: 'Segreto salvato', connectedAccount: 'Account collegato', secretKinds: ({ kinds }: { kinds: string }) => `Tipi di segreto: ${kinds}`, connectedAccountService: ({ service }: { service: string }) => `Servizio: ${service}`, credentialPurpose: ({ purpose }: { purpose: string }) => `Scopo: ${purpose}`, credentialUse: ({ realm, phase }: { realm: string; phase: string }) => `Usato in ${realm} durante ${phase}`, credentialAccess: ({ access }: { access: string }) => `Accesso: ${access}`, credentialRequestHeaders: ({ origin, headers }: { origin: string; headers: string }) => `Header inviati a ${origin}: ${headers}`, credentialRequestEnvironment: ({ keys }: { keys: string }) => `Variabili d’ambiente: ${keys}`, credentialRequestFiles: ({ files }: { files: string }) => `File: ${files}`, realm: { web: 'il browser', ios: 'l’app iOS', android: 'l’app Android', daemon: 'il servizio in background' }, phase: { settings: 'la configurazione', prepare: 'la preparazione', connection: 'la connessione', speech: 'l’uso vocale' }, runtimeApi: ({ version }: { version: number }) => `API di esecuzione ${version}`,
        },
        sourceAdministration: { title: 'Fonti e registri', subtitle: 'Scegli dove questa macchina trova i pacchetti npm esatti e come raggiunge i relativi registri.', communityTitle: 'Elenco npm pubblico', communitySubtitle: 'Integrato · ricerca non verificata di plugin Happier idonei su npm pubblico, non di pacchetti npm generici.', configuredTitle: 'Fonti del marketplace', configuredEmpty: 'Nessuna fonte aggiuntiva configurata.', add: 'Aggiungi fonte', edit: 'Modifica fonte', remove: 'Rimuovi fonte', removeTitle: 'Rimuovere la fonte del marketplace?', removeBody: ({ name }: { name: string }) => `${name} non verrà più usata per la ricerca su questa macchina. I plugin installati non cambiano.`, sourceUrl: 'Indirizzo della fonte', displayName: 'Nome visualizzato', description: 'Descrizione facoltativa', enabled: 'Attivata', disabled: 'Disattivata', curated: 'Fonte selezionata', user: 'La tua fonte', loadError: 'Impossibile caricare le fonti del marketplace.', retry: 'Riprova', operationFailed: 'Impossibile applicare la modifica. Controlla la connessione alla macchina e riprova.', operationOutcomeUnknownTitle: 'Modifica da verificare', operationOutcomeUnknownBody: 'La macchina selezionata potrebbe avere già applicato questa modifica, ma Happier non ha potuto confermare il risultato. Controlla le impostazioni aggiornate prima di modificarle di nuovo.' },
        updatePolicy: { title: 'Regola di aggiornamento', target: ({ machine, server }: { machine: string; server: string }) => `Si applica su ${machine} tramite ${server}.`, pinned: 'Versione bloccata', pinnedSubtitle: 'Non aggiornare finché non scegli un’altra regola.', allowed: 'Aggiornamenti consentiti', allowedSubtitle: 'Gli aggiornamenti espliciti procedono senza un’altra conferma, salvo un aumento delle autorizzazioni dichiarate.' },
    } } as const;

const pluginMarketplaceDiscoverTranslations = { it: {
        ...localizedReviewVocabulary.it,
        ...marketplacePresentation.it,
        secretFieldActions: { delete: 'Elimina il segreto salvato', deleteHint: 'Cancella il valore salvato. L’operazione non è reversibile.', unbind: 'Rimuovi da questo plugin', unbindHint: 'Scollega il segreto salvato da questa impostazione. Il segreto viene conservato.' },
        pluginChangeOutcomeUnknownTitle: 'Esito non confermato',
        pluginChangeOutcomeUnknownBody: ({ action, name, machine, server }: { action: string; name: string; machine: string; server: string }) => `Happier non ha potuto confermare se ${action} per ${name} sia stata completata su ${machine} (${server}). Controlla l’elenco Installati di quella macchina e la versione attuale prima di riprovare.`,
        updateFromInstalledRecordSubtitle: 'Aggiorna questa installazione tramite il suo canale di aggiornamento attendibile.',
        discover: {
            ...marketplacePresentation.it.discover,
            status: {
                loading: 'Ricerca in tutte le fonti del marketplace…',
                loadingSource: ({ source }: { source: string }) => `Ricerca in ${source}…`,
                results: ({ count, sources }: { count: number; sources: number }) =>
                    `${count} plugin da ${sources} fonte/i`,
                empty: 'Nessun plugin corrisponde a questa ricerca.',
                error: ({ message }: { message: string }) => `Non è stato possibile aggiornare la ricerca: ${message}`,
                errorTitle: 'Non è stato possibile aggiornare la ricerca',
                stale: 'Questi risultati rispondono a una ricerca precedente. Cerca di nuovo per applicare i controlli qui sopra.',
                partial: ({ count }: { count: number }) =>
                    `${count} fonte/i hanno risposto con dati vecchi o mancanti, quindi i risultati possono essere incompleti.`,
                nonInstallable: ({ count }: { count: number }) =>
                    `Sono state trovate ${count} voci che al momento non possono essere installate su questa macchina.`,
            },
            sourceFreshness: {
                stale: 'Più vecchio di questa fonte',
                'stale-offline': 'Ultimi risultati noti, fonte offline',
                unavailable: 'Fonte non disponibile',
                'auth-unavailable': 'Per questa fonte serve l’accesso',
                corrupt: 'Non è stato possibile leggere l’indice della fonte',
            },
            nonInstallableReason: {
                sourceStale: 'La sua fonte del marketplace non è aggiornata.',
                artifactUnavailable: 'Il suo pacchetto non è raggiungibile con l’accesso al registro di questa macchina.',
                notApproved: 'L’installazione da questa fonte non è approvata.',
                unsupportedSourceKind: 'Questo tipo di fonte non è supportato da questa versione di Happier.',
            },
            installSubtitle: ({ source }: { source: string }) =>
                `Controlla tutto ciò che questo plugin dichiara prima di dare fiducia a qualcosa proveniente da ${source}.`,
            registrySelectionRequired: ({ origin }: { origin: string }) => `Richiede un profilo di registro per ${origin}`,
            registrySelection: {
                title: ({ name }: { name: string }) => `Scegli un registro per ${name}`,
                body: ({ name, origin, source }: { name: string; origin: string; source: string }) =>
                    `${name} è pubblicato su ${origin}. Scegli il profilo di registro che ${source} usa su questa macchina, oppure aggiungine uno e accedi. Nulla viene scaricato prima della revisione di installazione e fiducia.`,
                continue: 'Continua',
            },
        },
    } } as const;

return { marketplacePresentation, localizedTechnicalReviewVocabulary, localizedReviewVocabulary, pluginMarketplaceDiscoverTranslations };
})();

const Domain_pluginPermissionTranslations = (() => {
type PermissionDetailsTranslation = Shared_pluginPermissionTranslations.PermissionDetailsTranslation;

const pluginPermissionTranslations = { it: {
        fields: {
            pluginId: 'ID dell’estensione',
            capability: 'Funzionalità',
            scope: 'Ambito',
            requester: 'Richiedente',
            authority: 'Autorità',
            requestedAt: 'Ora della richiesta',
            reason: 'Motivo',
        },
        scope: { account: 'Profilo account', project: 'Progetto', workspace: 'Area di lavoro' },
        requester: { user: 'Utente', host: 'Sistema host', plugin: 'Estensione' },
        authority: { bundled: 'Inclusa', machineInstallation: 'Installazione sulla macchina' },
        identifiers: {
            session: 'Sessione',
            request: 'Richiesta',
            machine: 'Macchina',
            installation: 'Installazione',
        },
        accessibilitySummary: ({ details }) => `Dettagli della richiesta di autorizzazione. ${details}`,
    } } as const satisfies Pick<Readonly<Record<string, PermissionDetailsTranslation>>, "it">;

return { pluginPermissionTranslations };
})();

const Domain_pluginSettingsPresentationTranslations = (() => {
const english = Shared_pluginSettingsPresentationTranslations.english;

const pluginSettingsPresentationTranslations = { it: {
        rowStatus: { enabled: 'Attivo', disabled: 'Disattivato', incompatible: 'Non compatibile', trustRemoved: 'Fiducia revocata', needsAttention: 'Richiede attenzione' },
        developmentPhase: { observing: 'In osservazione', preparingDependencies: 'Preparazione dipendenze', compiling: 'Compilazione', validating: 'Convalida', active: 'Attivo', retainedIncumbent: 'Versione precedente attiva', unavailable: 'Non disponibile' },
        rowSource: { bundled: 'Incluso in Happier', npm: 'Pacchetto npm', archive: 'File di archivio', localPath: 'Cartella locale', other: 'Origine configurata' },
        rowAttention: { trustRemoved: 'Questo plugin non viene più eseguito. Reinstallalo per fidarti di nuovo del suo codice.', incompatible: 'Questa versione non può essere eseguita sulla macchina selezionata.' },
        developerGroupTitle: 'Sviluppo',
        developerGroupFooter: 'Crea plugin sulla macchina selezionata e consulta ciò che il suo servizio segnala.',
        developerDevelopmentSubtitle: 'Crea, modifica, testa e impacchetta plugin da cartelle tue.',
        developerDiagnosticsSubtitle: 'Diagnostica del servizio e del catalogo per la macchina selezionata.',
        detailMissingTitle: 'Questo plugin non è sulla macchina selezionata',
        detailMissingBody: ({ pluginId }: { pluginId: string }) => `${pluginId} non è installato qui. Potrebbe essere stato disinstallato oppure trovarsi su un’altra macchina.`,
        detailMissingRetry: 'Controlla di nuovo',
        surfaces: {
            purpose: 'Aggiungi a Happier superfici, comandi e integrazioni. I plugin vengono eseguiti come codice attendibile sulle tue macchine.',
            navigationTitle: 'Plugin',
            updatesTitle: 'Aggiornamenti',
            moreDescriptionInSettings: 'Da dove arrivano i plugin, crearne di tuoi e cosa segnala questa macchina. Si aprono nelle Impostazioni.',
            fix: 'Correggi',
            allSources: 'Tutte le fonti',
            shelfCurated: 'Selezione',
            shelfCuratedDescription: 'Verificati e consigliati da Happier. Ogni installazione mostra comunque la revisione completa.',
            shelfCommunity: 'Community',
            shelfCommunityDescription: 'Pacchetti npm non verificati. Installa e considera attendibile mostra esattamente a cosa può accedere ciascuno.',
            shelfUser: 'Le tue fonti',
            shelfUserDescription: 'Voci dalle fonti del marketplace aggiunte su questa macchina.',
            manage: 'Gestisci',
            installed: 'Installato',
            notShownTitle: 'Non è stato possibile mostrare tutto',
            listingInstallsOn: ({ machine }: { machine: string }) => `Si installa su ${machine}. Esamini i suoi accessi prima che venga eseguito qualcosa.`,
            listingChooseMachine: 'Scegli una macchina nell’intestazione per installare questo plugin.',
            listingRunsIn: 'Eseguito in',
            listingPlatforms: 'Piattaforme',
            listingSource: 'Fonte',
            listingCategories: 'Categorie',
            listingNotFoundTitle: 'Questa voce non è disponibile',
            listingNotFoundBody: 'Potrebbe essere stata rimossa dalla sua fonte, oppure questa macchina non riesce a raggiungere la fonte in questo momento.',
            developmentSourcesTitle: 'Plugin in sviluppo',
            chooseMachineInstalled: 'Scegli una macchina nell’intestazione per vederne i plugin.',
            chooseMachineBrowse: 'Scegli una macchina nell’intestazione per sfogliare i plugin che può installare.',
            openAsPage: 'Apri come pagina',
            detailInstalledLabel: 'Plugin installato',
            detailListingLabel: 'Scheda del plugin',
            viewLabel: 'Mostra come',
            viewGrid: 'Griglia',
            viewList: 'Elenco',
            installedSearchPlaceholder: 'Cerca tra i plugin installati',
            statusFilterLabel: 'Mostra plugin',
            statusAll: 'Tutti i plugin',
            statusEnabled: 'Attivi',
            statusDisabled: 'Disattivati',
            statusAttention: 'Da verificare',
            noMatch: ({ query }: { query: string }) => `Nessun plugin corrisponde a «${query}»`,
            clearSearch: 'Cancella',
            emptyTitle: 'Ancora nessun plugin installato',
            emptyBody: 'I plugin aggiungono pannelli, comandi e strumenti per i tuoi agenti. Inizia da quelli creati da Happier.',
            browsePlugins: 'Sfoglia i plugin',
            browseEmpty: 'Le tue fonti non offrono ancora alcun plugin.',
            forDevelopers: 'Per sviluppatori',
            readFailedTitle: 'Impossibile leggere i plugin di questa macchina',
            readFailedBody: 'Non è stato modificato nulla. Riprova per interrogare di nuovo la macchina.',
            lastKnown: ({ status }: { status: string }) => `Ultimo stato noto · ${status}`,
            machinesTitle: 'Macchine',
            machinesDescription: 'Dove è installato questo plugin.',
            machinesCurrent: ({ current, total }: { current: number; total: number }) => `Aggiornato su ${current} di ${total} macchine`,
            onMachines: ({ count }: { count: number }) => `Su ${count} macchine`,
            onMachine: ({ machine }: { machine: string }) => `Su ${machine}`,
            addedGroup: 'Aggiunti',
            machinesRetained: 'Una macchina non più presente in questo account',
            open: 'Apri',
            review: 'Esamina',
            seeAll: 'Vedi tutto',
            allResults: 'Tutti i risultati',
            categoriesLabel: 'Categorie',
            runOnNoneChosen: 'Nessuna macchina scelta',
            runOnNoneAvailable: 'Nessuna macchina può ancora eseguirlo',
            runsEverywhere: 'Su ogni macchina che esegue Happier',
            kinds: {
                agent: 'Agente',
                providers: 'Fornitore di modelli',
                scmHostingProviders: 'Hosting del codice',
                scmBackends: 'Controllo versione',
                voice: 'Voce',
                connectedAccounts: 'Servizio collegato',
                inputTypes: 'Tipi di input',
                mcp: 'Strumenti MCP',
                pluginUi: 'Pannelli dell’app',
                pluginBrowser: 'Viste browser',
                composer: 'Strumenti del compositore',
            },
        },
    } } as const;

return { pluginSettingsPresentationTranslations };
})();

const Domain_pluginUpdateReviewTranslations = (() => {
const en = Shared_pluginUpdateReviewTranslations.en;

const it = {
    title: 'Revisione aggiornamenti',
    confirmSubtitle: 'Gli aggiornamenti che ampliano l’accesso concesso chiedono prima conferma.',
    autoApplySubtitle: 'Gli aggiornamenti si applicano senza chiedere, anche se ampliano l’accesso.',
    confirmOption: 'Chiedi',
    autoApplyOption: 'Automatico',
};

const pluginUpdateReviewTranslations = { it: it };

return { pluginUpdateReviewTranslations };
})();

const Domain_pluginWebhookAdministrationTranslations = (() => {
const english = Shared_pluginWebhookAdministrationTranslations.english;

const pluginWebhookAdministrationTranslations = { it: {
    webhookAdministration: {
        title: 'Webhook plug-in',
        footer: 'Endpoint dell\'account, target macchina esatti, code di consegna e recupero dei messaggi non recapitabili. I corpi di consegna non vengono mai mostrati qui.',
        unavailableTitle: 'I webhook dei plugin non sono disponibili',
        unavailableSubtitle: 'Questo server non ha abilitato la ricezione dei webhook dei plugin.',
        endpointsTitle: 'Endpoint del webhook',
        emptyTitle: 'Nessun endpoint webhook plug-in',
        emptySubtitle: 'Gli endpoint creati dai plugin installati rimarranno visibili qui, inclusi gli endpoint la cui destinazione non è disponibile.',
        loadError: 'Impossibile caricare lo stato del webhook.',
        endpointSubtitle: ({ readiness, routing, sourceInstanceId }: { readiness: string; routing: string; sourceInstanceId: string }) => `${readiness} · ${routing} · ${sourceInstanceId}`,
        targetSubtitle: ({ machineId, materializationId, status }: { machineId: string; materializationId: string; status: string }) => `${machineId} / ${materializationId} · ${status}`,
        queueSubtitle: ({ queued, retrying, claimed, deadLetter }: { queued: number; retrying: number; claimed: number; deadLetter: number }) => `In coda ${queued} · riprovare ${retrying} · affermato ${claimed} · lettera morta ${deadLetter}`,
        copyUrl: 'Copia l\'URL del webhook',
        selectTarget: 'Seleziona l\'obiettivo di consegna',
        retarget: 'Endpoint di nuova destinazione',
        retargetUnavailable: 'Seleziona una materializzazione esatta del plug-in disponibile prima di effettuare il retargeting di questo endpoint.',
        originSelected: 'L\'esatta materializzazione del plugin selezionata verrà ricontrollata quando continui.',
        originUnavailable: 'Non è stata selezionata alcuna materializzazione esatta del plug-in disponibile.',
        movePendingTitle: 'Spostare le consegne in sospeso?',
        movePendingBody: 'Spostare le consegne in coda e con lettere non consegnate al nuovo target esatto? Le consegne attivamente rivendicate rimangono sul loro obiettivo attuale.',
        resumePendingMove: 'Riprendi lo spostamento in attesa di consegna',
        resumePendingMoveSubtitle: ({ count }: { count: number }) => `${count} le consegne in coda o con messaggi non recapitabili utilizzano ancora l'obiettivo esatto precedente.`,
        configureCredential: 'Configura credenziale di firma',
        rotateCredential: 'Ruota credenziale di firma',
        finishRotation: 'Completa la rotazione delle credenziali',
        finishRotationSubtitle: 'Smetti di accettare la credenziale precedente ora.',
        credentialSecretTitle: 'Salvare il nuovo segreto di firma',
        credentialSecretBody: ({ secret }: { secret: string }) => `Questo segreto viene mostrato una volta. Salvalo prima di chiudere questo messaggio.\n\n${secret}`,
        revoke: 'Revocare l\'endpoint',
        revokeTitle: 'Revocare l\'endpoint webhook?',
        revokeBody: 'Le nuove consegne a questo endpoint verranno rifiutate. I metadati di consegna esistenti rimangono disponibili in base ai criteri di conservazione.',
        operationFailed: 'L\'operazione webhook non è stata completata. Aggiorna lo stato corrente prima di riprovare.',
        deliveryTitle: ({ digest }: { digest: string }) => `Lettera morta ${digest}`,
        deliveryStatus: 'Stato di consegna',
        deliverySubtitle: ({ errorCode, attempts, replays, machineId, materializationId }: { errorCode: string; attempts: number; replays: number; machineId: string; materializationId: string }) => `${errorCode} · ${attempts} tentativi · ${replays} replay · ${machineId} / ${materializationId}`,
        unresolvedAutomationAdmissionTitle: ({ totalCount }: { totalCount: number }) => `${totalCount} Ammissioni di automazione irrisolte`,
        unresolvedAutomationAdmissionSubtitle: ({ sample, omittedCount }: { sample: string; omittedCount: number }) => `Esempio: ${sample} · ${omittedCount} non mostrato`,
        replay: 'Riproduci la consegna',
        discardTitle: 'Eliminare la consegna?',
        discardBody: 'Il corpo di consegna crittografato o archiviato in chiaro verrà rimosso e non potrà essere recuperato.',
    },
} } as const;

return { pluginWebhookAdministrationTranslations };
})();

const Domain_profilesPageTranslations = (() => {
const english = Shared_profilesPageTranslations.english;

const translated = Shared_profilesPageTranslations.translated;

const profilesPageTranslations = { it: translated({
        profilesPage: {
            searchPlaceholder: "Cerca profili di avvio",
            emptyTitle: "Ancora nessun profilo di avvio",
            newProfileTitle: "Nuovo profilo di avvio",
            notFoundTitle: 'Questo profilo non esiste più',
            notFoundDescription: 'Potrebbe essere stato eliminato da un altro dispositivo.',
            backToProfiles: "Torna ai profili di avvio",
            discardDraft: 'Scarta',
            detailDescription: 'Usato quando una nuova sessione parte con questo profilo.',
            builtInDetailDescription: 'Un profilo già pronto. Salvando le modifiche crei una tua copia.',
            enabledHint: 'Proposto quando scegli un profilo per una nuova sessione.',
            pickerSection: 'Selettore di profilo',
            pickerSectionDescription: 'Dove compare questa scelta quando avvii una sessione.',
            showFirst: 'Mostra per primo',
            showFirstDescription: 'Mostra l\'ambiente della macchina tra i tuoi preferiti.',
            environmentDescription: 'Variabili d\'ambiente impostate quando una sessione parte con questo profilo. I valori possono riferirsi alle variabili della macchina.',
            descriptionTitle: 'Descrizione',
            descriptionHint: 'Facoltativa. Mostrata quando scegli questo profilo.',
            modelRequiresAgent: 'Scegli prima un agente preferito per scegliere il suo modello.',
        },
    }) };

return { profilesPageTranslations };
})();

const Domain_providerCollectionTranslations = (() => {
type ProviderCollectionCopy = Shared_providerCollectionTranslations.ProviderCollectionCopy;

const en = Shared_providerCollectionTranslations.en;

const it: ProviderCollectionCopy = {
    settingsProvidersCollection: {
        gateway: {
            railGroup: 'Gateway',
            managedFromConnectedServices: 'Gestito da Servizi connessi',
            description: 'Permette a qualsiasi agente di usare i tuoi abbonamenti.',
            statusUnavailable: ({ machine }: { machine: string }) => `Non disponibile · ${machine} è offline`,
            offlineTitle: ({ machine }: { machine: string }) => `${machine} è offline`,
            offlineDescription: ({ gateway, machine }: { gateway: string; machine: string }) => `Le sessioni non possono usare ${gateway} finché ${machine} non torna online, o finché non scegli un altro computer qui sotto. Non viene provato nient’altro al suo posto.`,
            modelsFromTitle: 'Modelli da',
            modelsFromDescription: 'Gli abbonamenti a cui attinge questo gateway. Scegli un account o un pool per ciascuno; non vengono mai mescolati.',
            slotUnused: ({ service }: { service: string }) => `I modelli ${service} non sono offerti tramite questo gateway.`,
            slotConnect: ({ service }: { service: string }) => `Collega un account ${service} per usarlo qui.`,
            connect: 'Collega',
            runsOnTitle: 'Viene eseguito su',
            runsOnDescription: 'Dove si avvia il gateway quando una sessione ne ha bisogno. Le richieste vanno comunque agli abbonamenti qui sopra.',
            runsOnSession: 'Il computer di ogni sessione',
            runsOnChosen: 'Un computer scelto',
            runsOnSessionDescription: 'Un gateway per computer, condiviso da tutte le sessioni su quel computer.',
            runsOnChosenDescription: 'Un gateway sul computer che scegli. Le sessioni sugli altri tuoi computer lo raggiungono tramite Happier.',
            computerTitle: 'Computer',
            computerChoose: 'Scegli un computer',
            computerChooseDescription: 'Scegli dove viene eseguito il gateway.',
            computerOnline: 'Online · non ancora verificato dagli altri tuoi computer',
            computerOnlineReachable: 'Online · gli altri tuoi computer possono raggiungerlo',
            computerOnlineUnreachable: 'Online · gli altri tuoi computer non possono raggiungerlo',
            computerOffline: 'Offline',
            computerGone: 'Non è più uno dei tuoi computer',
            modelPickerTitle: 'Selettore dei modelli',
            showInPickerGateway: 'Disattivato per impostazione predefinita per i gateway, così gli stessi modelli non compaiono due volte. Restano disponibili da «Passa da».',
            modelsAvailable: ({ count }: { count: number }) => `${count} disponibili`,
            helperTitle: 'Modelli di supporto di Claude Code',
            helperDescription: 'Claude Code affida i compiti secondari a un modello veloce, uno predefinito e uno più potente. Scegli quale usare per ciascuno su questo gateway. Le definizioni di agente che indicano un modello lo mantengono.',
            helperFast: 'Veloce',
            helperDefault: 'Predefinito',
            helperStrongest: 'Più potente',
            helperSameAsSession: 'Come la sessione',
            detailsTitle: 'Dettagli',
            whatToKnow: 'Da sapere',
            whatToKnowTitle: 'I tuoi abbonamenti, fuori dalle loro app',
            whatToKnowDescription: 'I servizi dietro questi abbonamenti non supportano questo uso. Le richieste possono essere rifiutate e le loro condizioni possono cambiare. Happier invia una richiesta solo all’account o al pool scelto qui sopra.',
            useExternalEndpoint: 'Usa invece un endpoint esterno',
            poolSectionTitle: 'Usa in altri agenti',
            poolSectionDescription: ({ agents }: { agents: string }) => `${agents} accede direttamente a questo pool. Gli altri agenti raggiungono gli stessi account tramite un gateway.`,
            poolSectionDescriptionGeneric: 'Gli agenti che accedono con questo servizio usano direttamente questo pool. Gli altri agenti raggiungono gli stessi account tramite un gateway.',
            poolSwitchVia: ({ gateway }: { gateway: string }) => `tramite ${gateway}`,
            poolSwitchDescription: ({ service }: { service: string }) => `Altri agenti possono eseguire modelli ${service} da questo pool.`,
            poolSwitchHeldBy: ({ gateway, current, service }: { gateway: string; current: string; service: string }) => `${gateway} usa ${current} per i modelli ${service} al momento.`,
            poolSwitchNeedsComputer: 'Per cambiarlo, uno dei tuoi computer deve essere online.',
            poolReplaceTitle: ({ gateway, pool }: { gateway: string; pool: string }) => `Passare ${gateway} a ${pool}?`,
            poolReplaceDescription: ({ pool, service, current }: { pool: string; service: string; current: string }) => `Le nuove sessioni in altri agenti useranno ${pool} per i modelli ${service}. ${current} mantiene i suoi account e le sessioni in corso conservano ciò con cui sono partite.`,
            poolReplaceConfirm: 'Passa',
            compareNative: ({ agents }: { agents: string }) => `In ${agents}`,
            compareNativeGeneric: 'Con il suo accesso',
            compareOther: 'In altri agenti',
            compareRunsThrough: 'Passa da',
            compareOwnSignIn: ({ service }: { service: string }) => `L’accesso di ${service}`,
            compareSupported: ({ service }: { service: string }) => `Supportato da ${service}`,
            compareSupportedYes: 'Sì',
            compareSupportedNo: 'No. Sperimentale; le richieste possono essere rifiutate',
            compareLimits: 'Limiti',
            compareLimitsNative: 'I limiti di questo pool',
            compareLimitsShared: 'Gli stessi limiti, condivisi',
        },
        connectionDescription: 'Salvato nel tuo account. Funziona su ogni computer.',
        apiKeySavedDescription: 'Conservata come segreto salvato. Non viene più mostrata.',
        modelsShownCount: ({ count }: { count: number }) => `${count} visibili`,
        showInPickerTitle: 'Mostra nel selettore dei modelli',
        showInPickerDirect: ({ provider }: { provider: string }) => `Attivo per impostazione predefinita per i provider diretti. I modelli di ${provider} compaiono in ogni agente che può eseguirli.`,
        showInPickerManyModels: 'Disattivato per impostazione predefinita per i provider con molti modelli. Restano disponibili da «Passa da».',
        showInPickerLocal: 'Attivo per impostazione predefinita per i modelli che girano sui tuoi computer.',
        showInPickerAction: 'Mostra nel selettore',
        onThisComputerTitle: 'Su questo computer',
        onThisComputerNoComputer: 'Nessun computer selezionato. Scegline uno per provare questa connessione o cambiare come viene raggiunta.',
        endpointAccessTitle: 'Accesso all’endpoint',
        endpointAccessDirect: ({ machine, host }: { machine: string; host: string }) => `${machine} raggiunge ${host} direttamente.`,
        endpointAccessDirectValue: 'Diretto',
        localRuntimeTitle: 'Runtime locale',
        onMachine: ({ machine }: { machine: string }) => `Su ${machine}`,
        onAComputerTitle: 'Su un computer',
        localNoComputer: 'Scegli un computer per vedere i server di modelli in esecuzione.',
        localOfflineDetail: 'Non è possibile controllare i suoi server di modelli.',
        localNoneFound: 'Nessun server di modelli trovato qui.',
        invitationAccountDescription: 'Collega un provider una volta e i suoi modelli compaiono in ogni agente che può eseguirli. Non serve un computer per iniziare.',
        subscriptionsPointerLead: 'Gli abbonamenti come Claude e ChatGPT si trovano in ',
        subscriptionsPointerLink: 'Servizi connessi',
        subscriptionsPointerTail: '.',
        addTitle: ({ provider }: { provider: string }) => `Aggiungi ${provider}`,
        addDescription: ({ provider }: { provider: string }) => `Aggiungi una chiave e i modelli di ${provider} compaiono in ogni agente che può eseguirli.`,
        addKeyDescription: 'Conservata come segreto salvato nel tuo account.',
        connectedTitle: ({ provider }: { provider: string }) => `${provider} è collegato`,
        connectedHiddenCountDescription: ({ provider, count }: { provider: string; count: number }) => `${count} modelli pronti. Sono nascosti dal selettore per impostazione predefinita, perché ${provider} offre molti modelli che potresti già avere. Scegline uno quando vuoi da «Passa da», oppure mostrali tutti.`,
        connectedHiddenDescription: ({ provider }: { provider: string }) => `I suoi modelli sono nascosti dal selettore per impostazione predefinita, perché ${provider} offre molti modelli che potresti già avere. Scegline uno quando vuoi da «Passa da», oppure mostrali tutti.`,
        description: 'Collega una fonte di modelli una volta e usa i suoi modelli con ogni agente compatibile.',
        foundOn: ({ machine }: { machine: string }) => `Trovato su ${machine}`,
        foundOnThisMachine: 'Trovato su questa macchina',
        connect: 'Collega',
        start: 'Avvia',
        test: 'Verifica',
        addProvider: 'Aggiungi un provider',
        customEndpoint: 'Endpoint personalizzato',
        menuOwnCategory: 'Tuo',
        menuCatalogCategory: 'Dal catalogo',
        newTitle: 'Nuovo provider',
        emptyDescription: 'Aggiungi un provider dal catalogo o il tuo endpoint compatibile.',
        machineScopeLabel: 'Configurato su',
        invitationTitle: 'Porta i tuoi modelli',
        invitationDescription: 'Collega un provider una volta e i suoi modelli compaiono nel selettore di modelli di ogni agente compatibile. I server locali come Ollama girano sulla tua macchina.',
        invitationNeedsMachine: 'I provider vengono collegati e verificati su una delle tue macchine. Aggiungi una macchina per iniziare.',
        setUpMachine: 'Configura una macchina',
        duplicateAsCustom: 'Copia come provider personalizzato',
        discard: 'Scarta',
        enabled: 'Attivo',
        enabledDescription: 'Offri i suoi modelli nei selettori di modelli degli agenti',
        saved: 'Salvata',
        replace: 'Sostituisci',
        addKey: 'Scegli chiave',
        apiKeyDefaultDescription: 'Usata su ogni macchina, a meno che una non abbia la propria chiave.',
        apiKeyMachineDescription: 'Usata su questa macchina al posto della chiave predefinita.',
        availabilityTitle: 'Disponibilità',
        availabilityDescription: 'Dove gli agenti possono usare questo provider.',
        modelsDescription: 'Scegli quali modelli gli agenti offrono nei loro selettori di modelli.',
        modelsShown: ({ shown, total }: { shown: number; total: number }) => `${shown} di ${total} visibili nei selettori di modelli`,
        modelsFilter: ({ count }: { count: number }) => `Filtra ${count} modelli`,
        connectionTitle: 'Connessione',
        nameDescription: 'Mostrato nell’elenco dei provider e nei selettori di modelli.',
        nameRequired: 'Aggiungi un nome.',
        nameTooLong: ({ max }: { max: number }) => `Usa al massimo ${max} caratteri.`,
        managedTitle: 'Servizio locale gestito',
        endpointsTitle: 'Endpoint',
        endpointsDescription: 'Lascia vuoto per usare gli indirizzi forniti dal provider.',
        overridesDescription: 'Dove vanno le richieste. Cambia l’indirizzo per tutte le macchine o solo per questa.',
        afterSavingTitle: 'Dopo il salvataggio',
        destinationDescription: 'Dove Happier invierà le richieste di questo provider.',
        destinationPending: 'Compare quando tutti gli endpoint sono compilati.',
    },
};

const providerCollectionTranslations = { it } as const;

return { providerCollectionTranslations };
})();

const Domain_providerSessionTranslations = (() => {
const providerSessionTranslations = { it: {
        launchDefaultLabel: ({ provider }: { provider: string }) => `Provider: ${provider}`,
        launchNamedLabel: ({ provider, connection }: { provider: string; connection: string }) => `Provider: ${provider} · ${connection}`,
        changedTitle: 'Le impostazioni del provider sono cambiate', changedBody: ({ provider, connection }: { provider: string; connection: string }) => `Questa sessione usa ancora la configurazione ${provider} · ${connection} con cui è stata avviata.`,
        unavailableTitle: 'Il provider non è più disponibile', unavailableBody: ({ provider, connection }: { provider: string; connection: string }) => `${provider} · ${connection} non è più disponibile per riprendere questa sessione.`,
        disabledTitle: 'Il provider è disattivato', disabledBody: ({ provider, connection }: { provider: string; connection: string }) => `Abilita ${provider} · ${connection} prima di riprendere questa sessione.`,
        incompatibleTitle: 'Il provider non è più compatibile', incompatibleBody: ({ provider, connection }: { provider: string; connection: string }) => `${provider} · ${connection} non è più compatibile con l’agente di questa sessione.`,
        restartAction: 'Riavvia sessione', chooseModelAction: 'Scegli modello',
    } } as const;

return { providerSessionTranslations };
})();

const Domain_reviewWalkthroughTranslations = (() => {
type Count = Shared_reviewWalkthroughTranslations.Count;

type ReviewWalkthroughTranslations = Shared_reviewWalkthroughTranslations.ReviewWalkthroughTranslations;

const en = Shared_reviewWalkthroughTranslations.en;

const it: ReviewWalkthroughTranslations = {
    severityCount: ({ count, severity }) => `${count} ${severity}`,
    findingRefA11y: ({ label, title }) => `${label}: ${title}. Vai al rilievo`,
    tag: { noFile: 'Nessun file', outdated: 'Superato', unplaced: 'Non collocabile', notInStory: 'Fuori dalle tappe' },
    outdatedSummary: 'Il codice è cambiato dopo la revisione.',
    askAboutFindingA11y: ({ title }) => `Chiedi del rilievo: ${title}`,
    tailTitle: 'Rilievi senza tappa',
    tailDescription: 'Restano qui perché nulla sparisca quando le loro righe non si possono collocare.',
    inContext: 'nel contesto',
    fromReviewAt: ({ time }) => `dalla revisione delle ${time}`,
    reviewLabel: 'Revisione:',
    enginesOf: ({ count, total }) => `${count} di ${total}`,
    enginesFinished: 'motori hanno finito',
    enginesRunning: ({ count }) => (count === 1 ? '1 motore sta ancora rivedendo' : `${count} motori stanno ancora rivedendo`),
    fromEngines: ({ engines, inStory }) => `da ${engines} · ${inStory} nel percorso`,
    and: ' e ',
    inStoryElsewhere: ({ inStory, elsewhere }) => `${inStory} nel percorso, ${elsewhere} altrove`,
    allInStory: 'tutti nel percorso',
    seeded: {
        title: 'Scritto dopo la revisione, da una nuova esecuzione.',
        body: ({ reviewers, time }) => `Il narratore non ha rivisto il codice; ogni rilievo citato qui viene da ${reviewers} alle ${time}.`,
        changed: ({ count }) => (count === 1 ? 'Da allora è cambiato 1 file.' : `Da allora sono cambiati ${count} file.`),
    },
    findingsFrom: ({ count, engine }) => (count === 1 ? `1 rilievo da ${engine}` : `${count} rilievi da ${engine}`),
    publishedBefore: ({ time }) => `pubblicati alle ${time}, prima del percorso`,
    steps: {
        reviewing: 'Revisione in corso',
        engineProgress: ({ done, running }) => `${done} ha finito · ${running} in revisione`,
        reviewed: ({ count }) => (count === 1 ? 'Rivisto · 1 rilievo' : `Rivisto · ${count} rilievi`),
        reviewedShort: ({ count }) => `Rivisto · ${count}`,
        engineReviewed: ({ engine, count }) => (count === 1 ? `${engine} · 1 rilievo` : `${engine} · ${count} rilievi`),
        reviewedAt: ({ time }) => `Rivisto alle ${time}`,
        reviewAt: ({ time }) => `Revisione delle ${time}`,
        partial: ({ count }) => (count === 1 ? 'Revisione parziale · 1 rilievo' : `Revisione parziale · ${count} rilievi`),
        ready: 'Percorso pronto',
        readyShort: 'Percorso',
        failed: 'Percorso non riuscito',
        narrating: 'Narrazione',
        narratorWriting: ({ narrator }) => `${narrator} scrive`,
        writing: 'Scrittura del percorso',
        writingShort: 'Scrittura',
    },
    writingWithFindings: 'Scrittura del percorso con i rilievi…',
    dialog: {
        engines: 'Motori di revisione',
        selected: ({ count }) => `${count} selezionati`,
        loadingEngines: 'Ricerca dei motori di revisione…',
        noEngines: 'Nessun motore di revisione può essere eseguito sulla macchina di questa sessione.',
        findingsOnly: 'solo rilievi',
        changes: 'Modifiche',
        instructions: 'Istruzioni',
        instructionsPlaceholder: 'Su cosa deve concentrarsi la revisione?',
        defaultInstructions: 'Rivedi queste modifiche per correttezza, rischi e test mancanti.',
        alsoWalkthrough: 'Scrivi anche un percorso',
        alsoWalkthroughBody: 'Quando arrivano i rilievi, la stessa esecuzione scrive il percorso con loro nel contesto. Nulla legge le modifiche due volte.',
        narrator: 'Narratore',
        chooseNarrator: 'Scegli un narratore',
        narratorSeveral: ({ count }) => `${count} motori rivedono; un modello scrive il percorso da tutti i loro rilievi.`,
        narratorFindingsOnly: ({ engine }) => `${engine} restituisce rilievi, non testo. Un modello scrive il percorso a partire da questi.`,
        noNarrator: 'Nessuno di questi motori può scrivere un percorso. Aggiungi un motore con modello o disattiva il percorso.',
        footerReviewThenWalkthrough: 'Revisione, poi scrittura del percorso',
        footerHandover: ({ reviewer, narrator }) => `${reviewer} rivede · ${narrator} scrive`,
    },
    generated: {
        continues: ({ model }) => `${model} · prosegue la revisione`,
        seeded: ({ model }) => `${model} · dai rilievi della revisione`,
        handover: ({ narrator, engine }) => `${narrator}, dai rilievi di ${engine}`,
    },
    partial: {
        failed: ({ engines }) => `La revisione di ${engines} non è terminata.`,
        notClean: 'È una revisione parziale, non una revisione pulita.',
        finishedWith: ({ engines, count }) => (count === 1 ? `${engines} ha finito con 1 rilievo.` : `${engines} ha finito con ${count} rilievi.`),
        retry: ({ engine }) => `Riprova ${engine}`,
    },
    explain: { action: 'Spiega i rilievi', running: 'Spiegazione dei rilievi', a11y: 'Chiedi una spiegazione dei rilievi nel percorso', unknownModel: 'Modello sconosciuto', requester: { user: 'un utente', agent: 'un agente', plugin: 'un plugin', automation: 'un’automazione', workflow: 'un flusso di lavoro', unknown: 'un richiedente sconosciuto' }, header: ({ model, time, requester = 'te' }) => `Spiegazione della revisione · ${model} · chiesta da ${requester} alle ${time} · non è un verdetto` },
    finished: {
        title: 'Revisione terminata',
        openFindings: 'Apri i rilievi',
        walkMeThrough: 'Accompagnami',
        andMore: ({ count }) => `e altri ${count}`,
        continues: 'Prosegue questa esecuzione di revisione: il revisore lo scrive da ciò che ha già letto. Nulla viene analizzato di nuovo.',
        narrates: ({ count }) => (count === 1
            ? 'L’esecuzione di revisione è terminata. Una nuova esecuzione scrive il percorso da questo rilievo e dalle modifiche; non rivedrà di nuovo.'
            : `L’esecuzione di revisione è terminata. Una nuova esecuzione scrive il percorso da questi ${count} rilievi e dalle modifiche; non rivedrà di nuovo.`),
    },
    started: {
        transcript: ({ engineCount, fileCount }) => `Revisione avviata · ${engineCount} ${engineCount === 1 ? 'motore' : 'motori'} · ${fileCount} file`,
        notStarted: ({ engines }) => `${engines} non è partito. Gli altri stanno rivedendo.`,
        narrationFailed: 'La revisione è partita, ma non è stato possibile richiedere il percorso. I rilievi arriveranno comunque.',
    },
};

const reviewWalkthroughTranslations = { it: { reviewWalkthrough: it } };

return { reviewWalkthroughTranslations };
})();

const Domain_rolesTranslations = (() => {
type RolesTranslations = Shared_rolesTranslations.RolesTranslations;

const rolesTranslations = { it: {
        rail: {
            chooseEngine: 'Scegli un motore',
            unavailableRole: 'Non più disponibile',
            label: 'Ruoli',
            title: 'Ruolo',
            searchPlaceholder: 'Cerca ruoli…',
            empty: 'Ancora nessun ruolo.',
            emptyWithManage: 'Ancora nessun ruolo. Aggiungine uno in Gestisci ruoli.',
            footer: 'Un ruolo porta con sé istruzioni, motore e modalità di esecuzione, così i workflow restano portabili.',
            manage: 'Gestisci ruoli',
            engineAppliesOnStart: 'Il motore si applica all’avvio di questo ruolo',
            defaultEngine: 'Agente predefinito',
            activeAccessibilityLabel: 'Ruoli, un ruolo è in uso',
        },
        builtIn: {
            orchestrator: "Guida un lavoro e ne affida parti ad altri agenti",
            planner: "Prepara il piano prima di costruire",
            builder: "Fa la modifica e verifica che funzioni",
            reviewer: "Rivede una modifica e indica cosa correggere",
            judge: "Decide i rilievi contestati e dice quando un obiettivo è raggiunto",
            second_opinion: "Un controllo indipendente prima di procedere",
            scout: "Esplora il codice e risponde dove si trovano le cose",
            approval_reviewer: "Risponde alle richieste di permesso a basso rischio e ti chiede il resto",
        },
        settings: {
            duplicate: 'Duplica',
            duplicateName: ({ name }) => `Copia di ${name}`,
            platformDefault: 'Predefinito della piattaforma · segue gli aggiornamenti',
            runsAsThisSession: 'Questa sessione',
            runsAsOrchestratorDescription: 'Un orchestratore è la sessione in cui lo attivi.',
            readOnly: 'Sola lettura',
            engineChooseMigrated: 'Dalla 0.2 non è arrivato alcun motore. Scegline uno, altrimenti segue il tuo agente predefinito.',
            description: 'Chi fa ogni tipo di lavoro. Workflow e orchestratori chiedono un ruolo; il ruolo dice come eseguirlo.',
            count: ({ count }) => (count === 1 ? '1 ruolo' : `${count} ruoli`),
            newRole: 'Nuovo ruolo',
            groupBuiltIn: 'Integrati',
            groupYours: 'Tuoi',
            groupShared: 'Condivisi con te',
            groupPlugins: 'Dai plugin',
            edited: 'Modificato',
            sourceBuiltIn: 'Integrato',
            sourceYours: 'Tuo',
            sourceShared: 'Condiviso con te',
            sourcePlugin: ({ plugin }) => `Da ${plugin}`,
            migrated: 'dai sub-agent 0.2',
            migratedNote: ({ names }) => (names.length === 1 ? `${names[0]} viene dalle tue indicazioni per i sub-agent 0.2: la descrizione ora è l’istruzione, agente e modello il motore.` : `${names.join(', ')} vengono dalle tue indicazioni per i sub-agent 0.2: ogni descrizione ora è l’istruzione, agente e modello il motore.`),
            nameTitle: 'Nome',
            newRoleName: 'Ruolo senza titolo',
            instructionsTitle: 'Istruzioni',
            instructionsDescription: 'Cosa fa, quando usarlo e come riferire. Gli agenti lo leggono quando distribuiscono il lavoro.',
            resetToDefault: 'Ripristina predefinito',
            readOnlyNote: 'Il ruolo originale è di sola lettura. Personalizza qui le tue istruzioni; Reimposta ripristina l’originale.',
            howItRunsTitle: 'Come viene eseguito',
            engineTitle: 'Motore',
            engineDescription: 'Agente, modello e impegno.',
            engineFollowsDefault: 'Segue il tuo agente predefinito.',
            engineUnavailable: 'Non disponibile qui. Scegli un motore.',
            runsAsTitle: 'Eseguito in',
            runsAsSession: 'Sessione',
            runsAsBackgroundRun: 'Esecuzione in background',
            runsAsSessionDescription: 'Una sessione che puoi aprire e guidare.',
            runsAsBackgroundDescription: 'Gira in background e riferisce; non c’è una sessione da guidare.',
            handsOffTitle: 'Senza modifiche',
            handsOffDescription: 'Pianifica e delega; non modifica file da solo.',
            secondOpinionTitle: 'Secondo parere',
            secondOpinionDescription: 'Consigliato gli chiede di valutare un secondo parere prima di una pull request o prima di chiudere il lavoro.',
            secondOpinionOff: 'Disattivato',
            secondOpinionEncouraged: 'Consigliato',
            enabledTitle: 'Disponibile',
            enabledDescription: 'Offerto nel pannello Ruoli e agli orchestratori.',
            advancedTitle: 'Avanzate',
            launchProfileTitle: 'Profilo di avvio',
            launchProfileDescription: 'Ambiente, permessi, macchina',
            launchProfileNone: 'Nessuno',
            profileUnavailable: 'Profilo non disponibile',
            previewTitle: 'Cosa leggono gli agenti',
            previewDescription: 'Il blocco inviato a ogni turno, esattamente.',
            deleteRole: 'Elimina ruolo',
            deleteConfirmTitle: 'Eliminare questo ruolo?',
            deleteConfirmBody: ({ name }) => `${name} viene rimosso per te e per chiunque lo condivida. Le sessioni che lo usano mantengono la loro copia.`,
            share: 'Condividi…',
            sendCopyFailed: 'Impossibile inviare una copia.',
            saveFailed: 'Impossibile salvare il ruolo.',
            loadFailed: 'Impossibile caricare i tuoi ruoli.',
            emptyDetailTitle: 'Scegli un ruolo',
            emptyDetailBody: 'Scegli un ruolo per vederne istruzioni ed esecuzione.',
        },
        delegation: {
            title: 'Delega',
            description: 'Come gli agenti passano il lavoro ad altri agenti.',
            depthTitle: 'Profondità del lavoro',
            approvalReviewer: 'Revisore dei permessi',
            approvalReviewerDescription: 'Esamina automaticamente le richieste a basso rischio, una sola volta. Le azioni sensibili richiedono il tuo consenso. Solo nelle modalità Predefinita e Accetta modifiche.',
            approvedByReviewer: 'Consentito una volta dal revisore',
            depthDescription: 'Sessioni, esecuzioni in background e workflow avviati dagli agenti possono avviarne altri. Questo limite ferma le catene fuori controllo. Ciò che avvii tu non è mai limitato.',
            depthSetting: 'Fin dove gli agenti possono delegare',
            depthSettingDescription: ({ count }) => (count === 1
                ? 'Un livello. Oltre, l’agente deve fare il lavoro da solo.'
                : `${count} livelli. Oltre, l’agente deve fare il lavoro da solo.`),
            ladderRoot: 'Lavoro che avvii tu',
            ladderRootDetail: 'Avviato da te · mai limitato',
            ladderLevel: ({ level }) => `Livello ${level}`,
            ladderLevelDetail: ({ level }) => (level === 1 ? "Avviato da un agente del lavoro che avvii" : `Avviato da un agente del livello ${level - 1}`),
            ladderRefused: 'Un’altra delega',
            ladderRefusedDetail: ({ level }) => `Livello ${level} · rifiutato; l’agente lo fa da solo`,
        },
        session: {
            refusal: {
                unenforceableTitle: 'Questo agente non può lavorare senza modifiche',
                unenforceableBody: 'Il ruolo è «Senza modifiche» e l’agente di questa sessione non può trattenere le proprie modifiche ai file. Disattiva «Senza modifiche» per il ruolo oppure avvialo in una nuova sessione con un agente che lo supporta.',
                restartRequiredTitle: 'Riavvia la sessione per passare a «Senza modifiche»',
                restartRequiredBody: 'Questo agente applica «Senza modifiche» solo all’avvio della sessione. Riavvia la sessione, poi scegli di nuovo il ruolo.',
                roleUnavailableTitle: 'Quel ruolo non è più disponibile',
                roleUnavailableBody: 'È stato rimosso, disattivato o non è più condiviso con te. Scegli un altro ruolo.',
            },
            useDefaults: 'Usa i ruoli predefiniti',
            crossOwnerNote: 'I ruoli sono stati copiati all’avvio.',
            addRole: 'Aggiungi un ruolo a questa sessione',
            addRoleConfirm: 'Aggiungi ruolo',
            namePlaceholder: 'Nome del ruolo',
            instructionsPlaceholder: 'Cosa fa questo ruolo e quando usarlo',
            notesTitle: 'Note',
            notesPlaceholder: 'Cosa deve sapere ogni sessione sottostante',
            applyToReports: 'Applica i ruoli alle sessioni sottostanti',
            handsOffTitle: 'Senza modifiche',
            handsOffDescription: 'Pianifica e delega; non modifica file.',
            saveFailed: 'Impossibile salvare questa modifica.',
            sectionTitle: 'Ruoli',
            allRoles: 'Tutti i ruoli',
            inUse: ({ count }) => `${count} in uso`,
            changed: 'modificato',
            thisSession: 'questa sessione',
            reset: 'Ripristina',
            newRoleForSession: 'Nuovo ruolo per questa sessione',
            changeForSession: 'Modifica per questa sessione',
            editNotes: 'Modifica note',
            more: 'Altro',
            info: 'I ruoli valgono per questa sessione e per le sessioni sotto di essa.',
            countChanged: ({ count }) => `${count} modificati`,
            countAdded: ({ count }) => `${count} aggiunti`,
            addNotes: 'Aggiungi note su come questa sessione deve orchestrare',
        },
        profiles: {
            sharedWithYouTitle: 'Condivisi con te',
            sharedWithYouDescription: 'Profili che persone e team condividono con te. I valori segreti restano ai proprietari.',
            share: 'Condividi…',
            shareFailedTitle: 'Impossibile condividere questo profilo',
            shareNeedsSavedSecrets: 'I valori segreti non viaggiano mai. Sposta ogni valore di questo profilo in un Secret salvato, collegalo e condividi di nuovo.',
            shareAwaitingApproval: 'La pubblicazione di questo profilo è in attesa di approvazione. Dopo l’approvazione, scegli di nuovo «Condividi…».',
        },
    } } as const satisfies Pick<Record<string, RolesTranslations>, "it">;

return { rolesTranslations };
})();

const Domain_runPageTranslations = (() => {
type Count = Shared_runPageTranslations.Count;

type Machine = Shared_runPageTranslations.Machine;

type Reviewer = Shared_runPageTranslations.Reviewer;

type RunPageTranslations = Shared_runPageTranslations.RunPageTranslations;

const runPageTranslations = { it: {
        untitledRun: 'Esecuzione agente',
        intentTitles: { review: 'Revisione', plan: 'Piano', delegate: 'Attività delegata' },
        thisMachine: 'questa macchina',
        menu: {
            cancelResponse: 'Annulla questa risposta',
            copyResult: 'Copia risultato',
            showInTranscript: 'Mostra nella trascrizione',
            runDetails: 'Dettagli esecuzione',
            agent: 'Agente',
            permissions: 'Permessi',
            kind: 'Tipo',
            finishesOnItsOwn: 'Termina da sola',
            selectionInherited: 'Ereditato dalla sessione',
            selectionExplicit: 'Scelto per questa esecuzione',
            selectionIndependent: 'Predefinito dell’account',
            selectionRetained: 'Mantenuto dall’avvio',
            selectionChoose: 'Scegli per questa esecuzione',
            selectionChooseDetail: 'Scegli un modello e da dove passa',
            staysOpen: 'Resta aperta',
            started: 'Avvio',
            run: 'Esecuzione',
            process: 'Processo',
        },
        opening: { reading: ({ machine }) => `Lettura da ${machine}.` },
        gone: {
            title: ({ machine }) => `Questa esecuzione non è più su ${machine}`,
            reason: 'Non viene più conservata lì, e la parte caricata della trascrizione non la include.',
            closeTab: 'Chiudi scheda',
        },
        stopFailed: {
            title: {
                review: 'Impossibile fermare questa revisione',
                plan: 'Impossibile fermare questo piano',
                delegate: 'Impossibile fermare questa attività',
                run: 'Impossibile fermare questa esecuzione',
            },
            reasonWithOthers: ({ machine, count }) => `${machine} non ha confermato l’arresto. Puoi fermare l’intera sessione: così si ferma anche ${count === 1 ? 'l’altro agente' : `gli altri ${count} agenti`} in esecuzione.`,
            reasonAlone: ({ machine }) => `${machine} non ha confermato l’arresto. Puoi fermare l’intera sessione.`,
            stopSession: 'Ferma sessione…',
        },
        steps: {
            title: 'Come ci è arrivato',
            count: ({ count }) => (count === 1 ? '1 passaggio' : `${count} passaggi`),
        },
        review: {
            findings: 'Rilievi',
            findingsCount: ({ count }) => `${count}`,
            highCount: ({ count }) => `${count} alti`,
            severity: { blocker: 'Bloccante', high: 'Alta', medium: 'Media', low: 'Bassa', nit: 'Dettaglio' },
            triageLabel: 'Cosa fare con questo rilievo',
            reviewerAsks: 'Il revisore chiede',
            answer: 'Rispondi',
            askAboutThis: 'Chiedi su questo',
            fixesSelected: ({ count }) => (count === 1 ? '1 correzione scelta' : `${count} correzioni scelte`),
            noFixesSelected: 'Scegli le correzioni da applicare',
            implementFixes: ({ count }) => (count === 1 ? 'Applica 1 correzione' : count > 1 ? `Applica ${count} correzioni` : 'Applica correzioni'),
            couldNotSaveChoice: 'Impossibile salvare la tua scelta.',
            reviewers: 'Revisori',
            findingTotal: ({ count }) => (count === 1 ? '1 rilievo' : `${count} rilievi`),
            moreFindings: ({ count }) => (count === 1 ? '1 altro rilievo' : `${count} altri rilievi`),
            fixesToImplement: ({ count }) => (count === 1 ? '1 correzione da applicare' : `${count} correzioni da applicare`),
            verifiedFirst: 'Ognuna viene prima verificata, poi corretta',
            replies: ({ count }) => (count === 1 ? '1 risposta' : `${count} risposte`),
            updatedAfterQuestion: 'Aggiornato dopo la tua domanda',
            reviewerUpdated: ({ reviewer }) => `${reviewer} ha aggiornato il rilievo`,
            askPlaceholder: 'Fai una domanda su questo rilievo…',
            askReviewerPlaceholder: 'Fai una domanda al revisore…',
            toReviewer: ({ reviewer }) => `A ${reviewer}`,
            followUpsGoTo: ({ reviewer }) => `Le domande vanno a ${reviewer}`,
            waitingForAnswer: ({ reviewer }) => `In attesa di ${reviewer}…`,
            waitingForAnswers: 'In attesa dei revisori…',
            both: 'Entrambi',
            reviewerCount: ({ count }) => `${count} revisori`,
            askReviewersPlaceholder: 'Fai una domanda ai revisori…',
            followUpsGoToAll: ({ count }) => (count === 2 ? 'Le domande vanno a entrambi i revisori' : `Le domande vanno a tutti i ${count} revisori`),
            stillReviewing: 'Revisione in corso',
            reviewerDidNotFinish: 'Non ha finito',
            reviewersNotStarted: ({ count }) => (count === 1 ? 'Un revisore non è partito' : `${count} revisori non sono partiti`),
            reviewerNotStarted: ({ reviewer }) => `${reviewer} non è riuscito a partire.`,
            notSaved: 'Questo rilievo non è stato salvato, quindi non può ancora ricevere una decisione.',
            decisionsUnavailable: 'Impossibile caricare le tue decisioni.',
            followUpUnavailable: {
                notResumable: 'Questa revisione è terminata; le domande richiedono una revisione che resti aperta.',
                ended: 'Questa revisione non è terminata, quindi non accetta domande.',
                resumeUnavailable: 'Il revisore non è più raggiungibile su questa macchina.',
                busy: 'Il revisore è ancora occupato. Riprova tra poco.',
                failed: 'Impossibile inviare la domanda.',
            },
        },
        launcher: {
            titles: { review: 'Chiedi una revisione', plan: 'Chiedi un piano', delegate: 'Affida un’attività' },
            descriptions: {
                review: ({ machine }) => `Ogni agente rivede per conto suo le modifiche su ${machine}; qui ricevi un risultato da ciascuno.`,
                plan: ({ machine }) => `L’agente legge il codice su ${machine} e propone qui un piano. Non modifica nulla.`,
                delegate: ({ machine }) => `L’agente lavora su ${machine} con i permessi qui sotto e riferisce qui.`,
            },
            whatFor: 'Per cosa',
            who: { review: 'Chi rivede', plan: 'Chi pianifica', delegate: 'Chi lo fa' },
            selectedCount: ({ count }) => `${count} selezionati`,
            focus: {
                review: 'Su cosa devono concentrarsi?',
                plan: 'Cosa deve coprire il piano?',
                delegate: 'Cosa deve fare?',
            },
            optional: 'facoltativo',
            start: {
                review: ({ count }) => (count > 1 ? `Avvia ${count} revisioni` : 'Avvia revisione'),
                plan: 'Avvia piano',
                delegate: 'Avvia attività',
            },
            runsOn: ({ machine }) => `Gira su ${machine}`,
            checking: 'Verifica degli agenti disponibili qui',
            unavailableTitle: 'Gli agenti non possono partire in questa sessione',
            unavailableReason: 'La sua macchina al momento non offre revisioni, piani o attività delegate.',
        },
    } } as const satisfies Pick<Record<string, RunPageTranslations>, "it">;

return { runPageTranslations };
})();

const Domain_scmComparisonTranslations = (() => {
type ScmComparisonTranslations = Shared_scmComparisonTranslations.ScmComparisonTranslations;

const en = Shared_scmComparisonTranslations.en;

const translated = Shared_scmComparisonTranslations.translated;

const scmComparisonTranslations = { it: {
        scmComparison: translated({
            view: { files: 'File', walkthrough: 'Percorso', commits: 'Commit' },
            scope: {
                workingTree: 'Modifiche in sospeso',
                session: 'Questa sessione',
                turn: 'Turno',
                latestTurn: 'Ultimo turno',
                branch: ({ head, base }) => `${head} rispetto a ${base}`,
                commit: ({ commit }) => `Commit ${commit}`,
            },
            tabTitle: ({ view, scope }) => `${view} · ${scope}`,
            since: ({ time }) => `dalle ${time}`,
            turnsWithChanges: ({ count }) => `${count} ${count === 1 ? 'turno' : 'turni'} con modifiche`,
            scopePicker: {
                a11y: 'Modifiche da mostrare',
                branchChoice: 'Branch rispetto alla base',
                commitChoice: 'Commit',
                pullRequestChoice: 'Pull request',
                headRef: 'Branch o riferimento di testa',
                baseRef: 'Branch o riferimento di base',
                parentRef: 'Riferimento padre (facoltativo)',
                explainAndCommit: 'Spiega e fai commit',
                explainOnly: 'Solo spiegazione',
                unavailable: 'Non disponibile per questa sessione',
                pendingDescription: 'Senza commit · può proporre commit',
                sessionDescription: 'Tutto ciò che è cambiato, inizio → ora',
                turnDescription: 'In ordine, come ha fatto l’agente',
                branchDescription: 'Modifiche dalla base comune',
                commitDescription: 'Modifiche introdotte da questo commit',
                pullRequestDescription: 'Modifiche proposte da questa pull request',
            },
            fileCount: ({ count }) => `${count} file`,
            changeCount: ({ count }) => `${count} ${count === 1 ? 'modifica' : 'modifiche'}`,
            changedFiles: 'File modificati',
            startReview: 'Avvia revisione',
            proposeCommits: 'Proponi commit',
            explain: 'Spiega',
            explainA11y: 'Spiega: mostra le note del percorso accanto alle modifiche',
            viewA11y: 'Vista',
            lockfileTag: 'Lockfile',
            generatedTag: 'Generato',
            lockfileCollapsed: 'Lockfile, compresso.',
            generatedCollapsed: 'File generato, compresso.',
            showDiff: 'Mostra diff',
            unsupportedReason: 'File non può ancora mostrare questo confronto. Le modifiche restano in Git.',
            showPendingChanges: 'Mostra le modifiche in sospeso',
            capturedStale: 'L’origine è cambiata. Questi file mantengono il confronto acquisito.',
            capturedFreshnessUnknown: 'Visualizzazione dei file acquisiti. Non è stato possibile verificare lo stato attuale dell’origine.',
            keys: { nextFile: 'file successivo', nextChange: 'modifica successiva' },
        }),
    } } as const;

return { scmComparisonTranslations };
})();

const Domain_secretsSettingsTranslations = (() => {
type SecretsSettingsCopy = Shared_secretsSettingsTranslations.SecretsSettingsCopy;

const en = Shared_secretsSettingsTranslations.en;

const it: SecretsSettingsCopy = {
    purpose: "Chiavi API e token per agenti e server MCP. I valori salvati non vengono più mostrati.",
    yoursTitle: 'I tuoi segreti',
    yoursDescription: 'Segreti che hai salvato o che possiedi. Sceglili ovunque Happier chieda una chiave.',
    sharedWithYouTitle: 'Condivisi con te',
    sharedWithYouDescription: 'Altre persone ti permettono di usarli. Puoi sceglierli, ma non vederli né modificarli.',
    add: 'Aggiungi segreto',
    newSecret: 'Nuovo segreto',
    emptyTitle: 'Ancora nessun segreto',
    emptyDescription: 'Aggiungi una chiave API o un token una volta, poi sceglilo ovunque Happier lo chieda.',
    staleTitle: 'Impossibile aggiornare i segreti condivisi',
    staleDescription: 'Viene mostrato l’ultimo elenco noto.',
    valueTitle: 'Valore',
    valueSaved: 'Salvato. Non viene più mostrato.',
    keepTitle: 'Conservalo come',
    keepPersonal: 'Personale',
    keepShared: 'Condiviso',
    keepPersonalDescription: 'Salvato nel tuo account. Solo tu puoi usarlo.',
    keepSharedDescription: 'Salvato su questo Home, così puoi condividerlo con persone, Team o Gruppi.',
    accessTitle: 'Chi può usarlo',
    accessOnlyYou: 'Solo tu',
    accessRecipients: ({ count }: { count: number }) => (count === 1 ? 'Tu e 1 destinatario' : `Tu e ${count} destinatari`),
    sharePersonalDescription: 'Condividerlo lo sposta su questo Home. Non potrà tornare personale.',
    share: 'Condividi',
    manage: 'Gestisci',
    storageTitle: 'Archiviazione',
    storageE2ee: 'Crittografato end-to-end',
    storageE2eeDescription: 'Solo le persone con cui lo condividi possono leggerlo.',
    storagePlain: 'Gestito dall’Home',
    storagePlainDescription: 'Questo Home lo conserva e può leggerlo per consegnarlo.',
    save: 'Salva segreto',
};

const secretsSettingsTranslations = { it } as const;

return { secretsSettingsTranslations };
})();

const Domain_sessionAccessTranslations = (() => {
const sessionAccessTranslations = { "it": {
        withContext: ({ context, label }: { context: string; label: string }) => `${context} · ${label}`,
        withCount: ({ label, count }: { label: string; count: number }) => `${label} +${count}`,
        accessibleSummary: ({ title, label }: { title: string; label: string }) => `${title}: ${label}`,
        accessibleControl: ({ name, control, value }: { name: string; control: string; value: string }) => `${name}, ${control}, ${value}`,
        title: "Accesso alla sessione",
        context: "Contesto della sessione",
        search: "Cerca persone, gruppi o team",
        hasAccess: "Ha accesso",
        yourAccess: "Il tuo accesso",
        readOnly: "Puoi verificare come hai ottenuto l’accesso. Solo gli amministratori della sessione possono apportare modifiche.",
        sourceDirect: "Accesso diretto",
        sourceTeam: "Accesso tramite un team",
        sourceGroup: "Accesso tramite un gruppo",
        people: "Persone",
        groups: "Gruppi",
        teams: "Team",
        account: "Persona",
        group: "Gruppo",
        team: "Team",
        view: "Può vedere",
        edit: "Può guidare",
        admin: "Amministra",
        owner: "Proprietario",
        private: "Privata",
        custom: "Accesso personalizzato",
        required: "Richiesto dalla politica del team",
        subjectNotFound: "Questa persona, questo gruppo o questo team non è più disponibile.",
        subjectIneligible: "Questa persona, questo gruppo o questo team non può più ricevere l’accesso.",
        teamPolicyRequired: "La politica del team richiede questo accesso.",
        selfGrantManaged: "Un altro gestore degli accessi deve modificare il tuo accesso.",
        homeUnsupported: "Questo Home non supporta ancora l’accesso alle sessioni. Aggiornalo per gestire chi può aprire questa sessione.",
        openCollaboration: "Apri Collaborazione",
        authenticationRequired: "Accedi con un metodo accettato da questo team, quindi riprova.",
        authenticationUnavailable: "Il metodo di accesso richiesto da questo team non è disponibile su questo Home.",
        delegation: "Può approvare richieste di autorizzazione di esecuzione",
        remove: "Rimuovi accesso",
        confirmRemove: "Conferma rimozione",
        credentialsLost: ({ names }: { names: string }) => `Queste credenziali del team smetteranno di funzionare qui: ${names}`,
        ready: "Accesso cifrato pronto",
        prepared: "Accesso cifrato preparato",
        recipientRepairRequired: "Questa persona deve riparare la configurazione della cifratura del proprio account.",
        pending: "Accesso cifrato in attesa",
        setup: "Configurazione della cifratura necessaria",
        repair: "L’accesso cifrato richiede una riparazione",
        unavailable: "Contenuto cifrato non disponibile",
        notRequired: "Questa sessione non è cifrata, quindi non c’è nulla da preparare.",
        preparing: "Preparazione dell’accesso cifrato…",
        preparingProgress: ({ count }: { count: number }) => `Preparazione dell’accesso cifrato… ${count} preparati`,
        preparationPending: ({ count }: { count: number }) => `Accesso cifrato in attesa per ${count} persone`,
        preparationSetup: ({ count }: { count: number }) => `${count} persone devono configurare la cifratura`,
        preparationRepair: ({ count }: { count: number }) => `L’accesso cifrato richiede una riparazione per ${count} persone`,
        preparationKeyUnavailable: "Questo dispositivo non può preparare l’accesso cifrato per questa sessione.",
        preparationFailed: "L’accesso è stato salvato, ma la preparazione dell’accesso cifrato non è riuscita.",
        preparationPassFailed: "La preparazione dell’accesso cifrato non è riuscita.",
        preparationAnnouncedComplete: "Preparazione dell’accesso cifrato completata.",
        preparationAnnouncedNeedsAttention: "L’accesso cifrato richiede ancora configurazione o riparazione.",
        preparationCheckFailed: "Impossibile verificare l’accesso cifrato.",
        outcomeUnknown: "L’esito è incerto. Happier sta verificando l’accesso attuale prima di un nuovo tentativo.",
        historicalLayoutNotice: "Le persone con cui condividi questa sessione non possono aprirla finché non viene aggiornata per questa versione di Happier.",
        historicalLayoutUpdate: "Aggiorna per la condivisione",
        homeReconciled: "L’accesso alla sessione è stato reimpostato per il nuovo Home.",
        lockedTitleFallback: "Sessione cifrata",
        encryptedAccess: "Accesso cifrato",
        aggregatePrepared: ({ count }: { count: number }) => `${count} preparati`,
        aggregatePending: ({ count }: { count: number }) => `${count} in attesa`,
        aggregateNeedsAttention: ({ count }: { count: number }) => `${count} richiedono configurazione o riparazione`,
        prepareNow: "Prepara ora",
        prepareAgain: "Prepara di nuovo",
        preparingProgressOf: ({ count, total }: { count: number; total: number }) => `Preparazione dell’accesso cifrato… ${count} di ${total}`,
        showAllRecipients: "Mostra tutte le persone",
        hideAllRecipients: "Nascondi persone",
        moreRecipients: "Mostra altre persone",
        recipientPlainAccount: "Account senza cifratura",
        pendingBody: "Questa sessione è cifrata. Chi la amministra deve ancora preparare il tuo accesso cifrato prima che si apra qui.",
        setupBody: "Completa la configurazione della cifratura su questo account, poi chi amministra potrà preparare il tuo accesso a questa sessione.",
        setupAction: "Configura la cifratura",
        repairBody: "La chiave consegnata per questa sessione non si è aperta su questo dispositivo. Riprova oppure chiedi a chi amministra la sessione di preparare di nuovo l’accesso.",
        retryAction: "Riprova",
        unavailableBody: "La chiave si è aperta, ma il contenuto di questa sessione non è stato decifrato. Chi amministra la sessione può preparare di nuovo l’accesso.",
        openAccessAction: "Apri l’accesso alla sessione",
        removedTitle: "Accesso rimosso",
        removedBody: "Non puoi aprire questa sessione con il tuo accesso attuale. Chi amministra la sessione può condividerla di nuovo.",
        removedAnnouncement: ({ name }: { name: string }) => `${name} rimosso dall’accesso alla sessione`,
        browseMore: "Sfoglia tutto",
        allLoaded: "Tutti i risultati caricati",
        levelHelp: { view: "leggere la sessione", edit: "guidare l’Agente entro i permessi configurati dei suoi strumenti", admin: "gestire l’accesso alla sessione" },
        steeringScopeNotice: "Guidare non è una chat isolata: la cartella di lavoro e il nome dell’autore non limitano l’accesso a shell, filesystem o rete.",
        help: "Può vedere consente di leggere. Può guidare consente di guidare l’Agente entro i permessi dei suoi strumenti. Amministra gestisce anche l’accesso. Non è una chat isolata: la cartella di lavoro e il nome dell’autore non limitano l’accesso a shell, file o rete."
    } } as const;

return { sessionAccessTranslations };
})();

const Domain_sessionAgentActivityTranslations = (() => {
const en = Shared_sessionAgentActivityTranslations.en;

const it: typeof en = {
    status: {
        queued: 'In coda',
        starting: 'Avvio',
        running: 'In esecuzione',
        waiting: 'In attesa',
        blocked: 'Bloccato',
        succeeded: 'Completato',
        failed: 'Non riuscito',
        timedOut: 'Tempo scaduto',
        cancelled: 'Interrotto',
        unknown: 'Sconosciuto',
    },
    attention: {
        permission: 'Richiede approvazione',
        userAction: 'Richiede la tua risposta',
        both: 'Richiede attenzione',
        bothDescription: 'Richiede approvazione e la tua risposta',
    },
    runKind: {
        conversation: 'Conversazione',
        review: 'Revisione',
        plan: 'Piano',
    },
    /** The Agents pane: its "+", its states, its team groups and its live line (agents lab). */
    roster: {
        teamLabel: ({ team, count }) => `Team ${team} · ${count} ${count === 1 ? 'agente' : 'agenti'}`,
        teamActionsA11y: 'Azioni del team',
        openWork: 'Apri',
        needsYouCount: ({ count }) => `${count} hanno bisogno di te`,
        runningCount: ({ count }) => `${count} in esecuzione`,
        nothingRunning: 'Niente in esecuzione.',
        startAgent: 'Avvia un agente',
        machineOffline: ({ machine }) => `${machine} non risponde`,
        machineOfflineUnnamed: 'La macchina non risponde',
        launch: {
            menuA11y: 'Avvia un agente',
            conversationDescription: 'Parla con un agente accanto a questa sessione',
            reviewDescription: 'Controlla le modifiche fatte finora',
            planDescription: 'Pianifica i prossimi passi',
            delegateDescription: 'Affida un compito e ricevilo completato',
            advancedDescription: 'Scegli agenti, permessi e profilo',
        },
        empty: {
            title: 'Metti più agenti su questa sessione',
            reason: ({ machine }) => `Avvia una conversazione parallela, o chiedi una revisione o un piano mentre continui a lavorare. Girano su ${machine} e riferiscono qui.`,
            reasonUnnamed: 'Avvia una conversazione parallela, o chiedi una revisione o un piano mentre continui a lavorare. Riferiscono qui.',
            moreWays: 'Chiedi una revisione, un piano o una delega',
        },
        unavailable: {
            notEnabled: 'Gli agenti non possono avviarsi in questo Home.',
            machineOffline: ({ machine }) => `Per avviare agenti ${machine} deve essere online.`,
            machineOfflineUnnamed: 'Per avviare agenti questa macchina deve essere online.',
            sessionInactive: 'Questa sessione è stata fermata. Riprendila per avviare agenti qui.',
            externalRunnerInactive: 'Questa sessione è stata avviata fuori da Happier. Gli agenti possono avviarsi da qui finché Happier è collegato.',
        },
    },
    summaryA11y: ({ title, status }) => `${title}, ${status}`,
    summaryAttentionA11y: ({ title, status, attention }) => `${title}, ${status}, ${attention}`,
};

const sessionAgentActivityTranslations = { it };

return { sessionAgentActivityTranslations };
})();

const Domain_sessionBoardTranslations = (() => {
type SessionBoardStateTranslation = Shared_sessionBoardTranslations.SessionBoardStateTranslation;

type SessionBoardTranslation = Shared_sessionBoardTranslations.SessionBoardTranslation;

const sessionBoardTranslations = { it: {
        title: 'Bacheca',
        views: {
            label: 'Viste della bacheca',
            overview: 'Panoramica',
            createTitle: 'Nuova vista della bacheca',
            renameTitle: 'Rinomina la vista della bacheca',
            reconciled: ({ title }) => `Quella vista della bacheca è stata rimossa. Mostriamo ${title}.`,
            empty: {
                title: 'Niente in questa vista',
                reason: 'Aggiungi qui un widget oppure passa a un’altra vista della bacheca.',
            },
            actions: {
                create: 'Nuova vista',
                rename: 'Rinomina la vista',
                moveBefore: 'Sposta la vista prima',
                moveAfter: 'Sposta la vista dopo',
                remove: 'Elimina la vista',
            },
            remove: {
                title: ({ title }) => `Eliminare «${title}»?`,
                moveMessage: ({ title }) => `I suoi widget passano in ${title}. Dalla sessione non viene eliminato nulla.`,
                unpinMessage: 'I suoi widget restano nella sessione ma non sono più fissati a una vista.',
            },
        },
        add: { note: 'Nota', interactiveView: 'Vista interattiva' },
        width: { compact: 'Stretto', medium: 'Medio', wide: 'Largo', full: 'Larghezza piena' },
        height: { auto: 'Adatta al contenuto', compact: 'Bassa', regular: 'Media', tall: 'Alta' },
        board: {
            loading: { title: 'Apertura della bacheca', reason: 'Carichiamo ciò che è fissato a questa sessione.' },
            locked: {
                title: 'La bacheca è ancora cifrata',
                reason: 'Questo dispositivo non può ancora aprire la sessione. Non è andato perso nulla.',
            },
            unopenable: {
                title: 'Impossibile leggere la disposizione della bacheca',
                reason: 'La disposizione salvata non si è aperta. I singoli widget non sono toccati.',
            },
            unsupported: {
                title: 'Questa bacheca richiede un Happier più recente',
                reason: 'Tutto è conservato. Aprila su un dispositivo compatibile o aggiorna Happier.',
            },
            unavailable: {
                title: 'La bacheca non è ancora disponibile qui',
                reason: 'Non è andato perso nulla. Comparirà quando questo Home abiliterà le bacheche.',
            },
            offline: 'Offline: stai vedendo l’ultima versione caricata.',
            offlineEmpty: 'Offline: riconnettiti per caricare questa bacheca.',
            stale: 'Stai vedendo l’ultima versione caricata.',
        },
        empty: {
            editor: {
                title: 'Tieni il piano accanto alla chat',
                description: 'Note e viste dal vivo fissate qui restano con questa sessione, per chiunque possa leggerla.',
                askAgent: 'Chiedi all’agente',
                askAgentPrompt: 'Metti su questa bacheca qualcosa che mostri ',
                addNote: 'Aggiungi una nota',
            },
            viewer: {
                title: 'Ancora niente in bacheca',
                description: 'Qui comparirà tutto ciò che persone o agenti fissano a questa sessione.',
            },
        },
        item: {
            untitled: 'Widget senza titolo',
            renameA11y: 'Titolo del widget',
            reorderA11y: ({ title }) => `Riordina ${title}`,
            a11yLabelWithWidth: ({ title, width }) => `${title}, ${width}`,
            menuGroups: { content: 'Leggi e modifica', movement: 'Spostamento', geometry: 'Dimensioni', destructive: 'Rimuovi' },
            loading: { title: 'Caricamento del widget', reason: 'Recuperiamo il contenuto da questo Home.' },
            locked: {
                title: 'Contenuto cifrato non disponibile',
                reason: 'Questo widget resta cifrato finché il dispositivo non può aprire la sessione.',
            },
            unopenable: {
                title: 'Impossibile mostrare questo widget',
                reason: 'Il contenuto salvato non è leggibile. Il resto della bacheca resta utilizzabile.',
            },
            unsupported: {
                title: 'Questo widget richiede un Happier più recente',
                reason: 'Il contenuto è conservato. Aprilo su un dispositivo compatibile o aggiorna Happier.',
            },
            notCopied: { title: 'Visuale non copiato', reason: 'Non è stato possibile copiare questo visuale in questa diramazione.' },
            missing: {
                title: 'Widget non trovato',
                reason: 'La bacheca lo indica ancora, ma il contenuto non è su questo Home.',
            },
            removed: {
                title: 'Questo widget è stato tolto dalla bacheca',
                reason: 'Qualcuno con permessi di modifica lo ha eliminato per tutti.',
            },
            pluginUnavailable: {
                title: 'Plugin non disponibile su questo dispositivo',
                reason: 'Il widget è conservato. Tornerà visibile quando il plugin sarà disponibile qui.',
            },
            rendererUnavailable: {
                title: 'Impossibile mostrare questo widget su questo dispositivo',
                reason: 'Il contenuto è conservato. Aprilo dove le viste interattive sono supportate.',
            },
            provenance: {
                note: 'Nota',
                interactiveView: 'Vista interattiva',
                pluginMissing: ({ pluginId }) => `Da ${pluginId} · non installato`,
                pluginSurface: ({ plugin, surface }) => `${surface} · ${plugin}`,
                pluginQualified: ({ label, pluginId }) => `${label} (${pluginId})`,
            },
            actions: {
                remove: 'Togli dalla bacheca',
                openHere: 'Apri qui',
                managePlugin: 'Gestisci il plugin',
                prepareEncryption: 'Configura la cifratura',
                readFull: 'Leggi tutta la nota',
                rename: 'Rinomina il widget',
                unpin: 'Togli da questa vista',
                moveToView: ({ title }) => `Sposta in ${title}`,
            },
            moved: {
                before: ({ title }) => `${title} spostato prima.`,
                after: ({ title }) => `${title} spostato dopo.`,
                reordered: ({ title }) => `${title} spostato.`,
                toView: ({ title, view }) => `${title} spostato in ${view}.`,
            },
            movePosition: ({ position, total }) => `Posizione ${position} di ${total}`,
            moveTargetView: ({ title }) => `Vista della bacheca ${title}`,
            remove: {
                title: 'Togliere questo widget?',
                message: 'Lo perde chiunque possa leggere questa sessione. I plugin installati restano installati.',
            },
        },
        note: {
            titlePlaceholder: 'Titolo',
            titleA11y: 'Titolo della nota',
            untitled: 'Nota senza titolo',
            offline: 'Per salvare serve una connessione a questo Home.',
            unavailable: 'Le modifiche alla bacheca non sono ancora disponibili su questo Home.',
            failed: 'Happier non è riuscito a salvare questa nota. Il tuo testo è ancora qui.',
            outcomeUnknown: 'Happier non ha potuto confermare il salvataggio. Aggiorna prima di salvare di nuovo.',
            saved: 'Nota salvata',
            conflict: {
                message: 'Questa nota è cambiata su un altro dispositivo.',
                reviewLatest: 'Vedi l’ultima versione',
                applyMine: 'Applica le mie modifiche',
                latestHeading: 'Ultima versione',
            },
        },
        recovered: {
            title: 'Elementi recuperati',
            description: 'Questi widget sono nella sessione ma non compaiono in nessuna vista della bacheca.',
            pin: 'Aggiungi a questa vista',
        },
        mutation: {
            conflict: 'Questa bacheca è cambiata su un altro dispositivo. Aggiorna per vedere l’ultima versione.',
            outcomeUnknown: 'Happier non ha potuto confermare se la modifica è stata salvata.',
            denied: 'Non hai più il permesso di modificare questa bacheca.',
            offline: 'Modificare la bacheca richiede una connessione a questo Home.',
            unavailable: 'Questo Home non può ancora modificare la bacheca.',
            updateRequired: 'Aggiorna Happier per applicare questa modifica alla bacheca.',
            noteTooLarge: 'Questa nota è troppo grande per essere salvata. Il testo è ancora qui.',
            invalid: 'Questa modifica alla bacheca non è valida. Controllala e riprova.',
            notFound: 'Questo elemento non è più disponibile. Aggiorna la bacheca.',
            storageFailed: 'Happier non ha potuto proteggere questa modifica. Il tuo lavoro è ancora qui.',
            serverFailed: 'Questo Home non ha potuto completare la modifica. Riprova.',
            failed: 'Happier non ha potuto applicare quella modifica alla bacheca.',
        },
        hostedHtmlApproval: {
            title: 'Consentire questa vista interattiva?',
            body: 'L’approvazione vale per questa vista in questa sessione. Per inviare un messaggio devi comunque fare clic nella vista.',
            resources: ({ count }) => (count === 1 ? 'Può leggere 1 risorsa della sessione' : `Può leggere ${count} risorse della sessione`),
            actions: ({ count }) => (count === 1 ? 'Può eseguire 1 azione' : `Può eseguire ${count} azioni`),
            sendMessages: 'Può chiedere a Happier di inviare messaggi',
            loadsFrom: ({ origin }) => `Carica da ${origin}`,
            allow: 'Consenti',
            notNow: 'Non ora',
            declined: {
                title: 'Vista interattiva non ancora consentita',
                reason: 'Controlla cosa richiede quando vuoi.',
                review: 'Controlla',
            },
        },
        sidebar: {
            openInDetails: 'Apri nei dettagli',
            openBoard: 'Apri la bacheca',
            sharedWithEveryone: 'Condiviso con tutti qui',
            widgetCount: ({ count }) => `${count} widget`,
        },
        mobile: { searchPlaceholder: 'Cerca in questa bacheca' },
        inline: {
            openBoard: 'Apri la bacheca',
            openBoardA11y: ({ title }) => `Apri “${title}” nella bacheca`,
        },
        companion: {
            title: 'Compagno',
            inCompanionA11y: 'Nel tuo compagno',
            empty: {
                title: 'Tieni la sessione sott’occhio',
                reason: 'Metti il riepilogo della sessione o un widget della bacheca accanto alla chat: cosa è in esecuzione, cosa ti aspetta, cosa è cambiato.',
                note: 'Solo tu vedi il tuo compagno.',
            },
            pane: {
                besideChat: 'Accanto alla tua chat',
                itemCount: ({ count }: { count: number }) => count === 1 ? '1 elemento' : `${count} elementi`,
                justForYou: 'Solo per te, accanto alla chat',
            },
            actions: {
                addSummary: 'Aggiungi riepilogo sessione',
                addItem: ({ title }) => `Aggiungi ${title}`,
                moveToLeading: 'Sposta a sinistra',
                moveToTrailing: 'Sposta a destra',
                moveToFirst: 'Sposta in cima',
                moveToLast: 'Sposta in fondo',
                compact: 'Dimensione compatta',
                comfortable: 'Dimensione comoda',
                openFull: 'Apri compagno completo',
                openOnBoard: 'Apri nella bacheca',
                collapse: 'Comprimi compagno',
                expand: 'Espandi compagno',
                hide: 'Nascondi compagno',
                addToCompanion: 'Aggiungi al compagno',
                removeFromCompanion: 'Rimuovi dal compagno',
                undo: 'Annulla',
                menuA11y: 'Opzioni compagno',
                itemMenuA11y: ({ title }) => `Opzioni per ${title}`,
            },
            a11y: {
                headerAction: ({ count }) => `Compagno, ${count} elementi`,
                show: ({ count }) => `Mostra compagno, ${count} elementi`,
                expand: ({ count }) => `Espandi compagno, ${count} elementi`,
            },
            summary: {
                review: 'Rivedi',
                title: 'Riepilogo sessione',
                untitled: 'Sessione',
                approvals: ({ count }) => `${count} in attesa di te`,
                workflows: ({ count }) => `${count} flussi in corso`,
                changedFiles: ({ count }) => `${count} modificati`,
                tokens: ({ count }) => `${count} token`,
                contextPercent: ({ percent }) => `${percent}% di contesto`,
                contextOnly: 'Contesto usato',
                moreDetails: 'Altri dettagli',
                moreDetailsA11y: ({ count }) => `Altri dettagli, ${count} righe in più`,
                partial: 'Alcuni dettagli non sono visibili da qui.',
            },
            notices: {
                shown: 'Compagno mostrato',
                hidden: 'Compagno nascosto',
                added: 'Aggiunto al compagno',
                removed: 'Rimosso dal compagno',
                reordered: 'Compagno riordinato',
                moved: 'Compagno spostato',
                boardOpened: 'Bacheca aperta dall’agente',
                returnedToChat: 'L’agente è tornato alla chat',
                boardViewSelected: 'Vista della bacheca selezionata dall’agente',
                boardItemRevealed: 'Elemento della bacheca aperto dall’agente',
                fullOpened: 'Compagno aperto dall’agente',
            },
        },
    } } as const satisfies Pick<Readonly<Record<string, SessionBoardTranslation>>, "it">;

return { sessionBoardTranslations };
})();

const Domain_sessionCollaborationPaneTranslations = (() => {
type PaneCopy = Shared_sessionCollaborationPaneTranslations.PaneCopy;

const en = Shared_sessionCollaborationPaneTranslations.en;

const sessionCollaborationPaneTranslations: Pick<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', PaneCopy>, "it"> = { it: {
        hereOne: ({ name }) => `${name} è qui`,
        hereTwo: ({ first, second }) => `${first} e ${second} sono qui`,
        hereMany: ({ first, count }) => `${first} e altre ${count.toLocaleString()} persone sono qui`,
        typingOne: ({ name }) => `${name} sta scrivendo…`,
        typingMany: ({ count }) => `${count.toLocaleString()} persone stanno scrivendo…`,
        justYouHere: 'Ci sei solo tu',
        justYouHint: 'Le persone con cui la condividi compariranno qui',
        you: 'Tu',
        presenceConnecting: 'Verifica di chi è presente…',
        presenceUnavailable: 'La presenza in tempo reale non risponde al momento',
        presenceUnsupported: 'La presenza in tempo reale non è disponibile su questa Home',
        responsibleUnsupported: 'Questa Home non registra chi è responsabile',
        inviteTitle: 'Parlatene accanto alla sessione',
        inviteBody: 'Avvia una conversazione, menziona le persone e passa la risposta all’agente quando sei pronto.',
        readOnly: 'Puoi leggerle. Chi può modificare questa sessione può scrivere.',
        offline: 'Sei offline · vengono mostrate le ultime conversazioni',
        lockedTitle: 'Non è ancora possibile aprire queste conversazioni su questo dispositivo',
        lockedBody: 'Sono crittografate end-to-end e la configurazione di crittografia di questo dispositivo non corrisponde a quella della sessione.',
        revokedTitle: 'Non hai più accesso a queste conversazioni',
        revokedBody: 'Qualcuno che gestisce questa sessione ha cambiato chi può vederla. I messaggi che hai scritto restano con la sessione.',
        namesTwo: ({ first, second }) => `${first} e ${second}`,
        namesThree: ({ first, second, third }) => `${first}, ${second} e ${third}`,
        namesMore: ({ first, second, count }) => `${first}, ${second} e altri ${count.toLocaleString()}`,
        haveAccess: 'Hanno accesso',
        hasAccess: 'Ha accesso',
        onlyYou: 'Solo tu',
        notShared: 'Non ancora condivisa',
        publicLinkOn: 'Link pubblico attivo',
        accessLoading: 'Verifica di chi ha accesso…',
        accessError: 'Impossibile caricare chi ha accesso',
        shareTitle: 'Condividi questa sessione',
        shareBody: ({ home }) => `Le persone che aggiungi su ${home} possono seguirla e partecipare alle conversazioni.`,
        collapse: 'Comprimi',
        linkOn: 'Attivo',
        linkOff: 'Disattivo',
        linkGrants: 'Chiunque abbia il link può vedere la trascrizione, senza account.',
        linkExpires: ({ date }) => `Scade il ${date}`,
        linkNeverExpires: 'Non scade mai',
        linkAsksConsent: 'chiede il consenso',
        linkNoConsent: 'senza passaggio di consenso',
        linkHidden: 'Questo link è stato creato in precedenza e non può essere mostrato di nuovo. Creane uno nuovo per copiarlo.',
        qrCode: 'Codice QR',
        hideQrCode: 'Nascondi codice QR',
        newLink: 'Nuovo link…',
        turnOff: 'Disattiva',
        turnOffTitle: 'Disattivare il link pubblico?',
        turnOffBody: 'Chi ha il link perde subito l’accesso. Potrai crearne uno nuovo in seguito.',
        newLinkReplaces: 'Il link attuale smetterà di funzionare quando verrà creato quello nuovo.',
        linkDenied: 'Solo chi gestisce questa sessione può creare un link pubblico.',
        linkLoadFailed: 'Impossibile verificare il link pubblico.',
        linkNetworkOff: 'Condividi i contenuti visivi senza accesso alla rete',
        linkNetworkConsequence: 'I contenuti visivi con accesso alla rete possono inviare il loro contenuto ad altri siti e rivelare l’indirizzo IP di chi li visualizza. Codice e risorse remoti possono cambiare. Disattivarlo mantiene interattivo il contenuto incluso senza richieste esterne.',
        linkUnavailable: 'I link pubblici non sono disponibili su questa Home. Chiedi all’amministratore di configurare il loro hosting.',
        justYouTitle: 'Lavorate insieme a questa sessione',
        justYouBody: ({ home }) => `Condividila con persone su ${home}. Potranno seguirla, parlarne qui e subentrare mentre sei via.`,
        share: 'Condividi',
        justYouNote: 'Oppure crea un link pubblico che chiunque può vedere.',
        sharingOffTitle: ({ home }) => `${home} non condivide sessioni con altre persone`,
        sharingOffBody: 'Puoi comunque creare un link pubblico che chiunque può vedere.',
        sharingOffPrivateBody: 'Le sessioni su questa Home restano con te.',
        accessDenied: 'Solo chi gestisce questa sessione può cambiare chi ha accesso. Puoi comunque partecipare alle conversazioni.',
    } };

return { sessionCollaborationPaneTranslations };
})();

const Domain_sessionCollaborationTranslations = (() => {
const sessionCollaborationPaneTranslations = {...Domain_sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations, ...EnglishFeatures.sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations};

const en = Shared_sessionCollaborationTranslations.en;

const sessionCollaborationTranslations: Pick<Record<'en'|'ca'|'de'|'es'|'fr'|'it'|'ja'|'pl'|'pt'|'ru'|'zh-Hans'|'zh-Hant', typeof en>, "it"> = { it: { pane: sessionCollaborationPaneTranslations['it'], title: 'Collaborazione', viewingNow: 'Presenti ora', justYou: 'Solo tu', typing: 'Sta scrivendo…', stale: 'Potrebbe non essere aggiornato', unavailable: 'Presenza in tempo reale non disponibile', connecting: 'Connessione…', unnamed: 'Membro di Happier', open: 'Apri collaborazione', conversations: 'Conversazioni', accessUnavailable: 'Accesso alla sessione non disponibile', accessUnavailableReason: 'Questo Home non supporta la condivisione delle sessioni con altre persone.', discussion: { featureUnavailable: "Le conversazioni non sono abilitate su questo Home.", bindingUnavailable: "Accedi di nuovo a questo Home per vedere le conversazioni.", scopeMismatch: "Queste conversazioni appartengono a un altro account su questo Home.", modeMismatch: "Il contenuto non corrisponde alla modalità di crittografia della sessione. Riprova o chiedi a chi gestisce la sessione di verificare l’accesso.",  title: 'Conversazioni', newDiscussion: 'Nuova conversazione', create: 'Crea conversazione', titlePlaceholder: 'Titolo della conversazione', messagePlaceholder: 'Scrivi un messaggio…', active: 'Attive', activeDisclosure: 'Mostra le conversazioni attive', archived: 'Archiviate', archivedDisclosure: 'Mostra le conversazioni archiviate', emptyActive: 'Non ci sono ancora conversazioni attive.', emptyArchived: 'Nessuna conversazione archiviata.', loading: 'Caricamento conversazioni…', loadError: 'Impossibile caricare conversazioni.', retry: 'Riprova', checking: 'Ricerca aggiornamenti…', deliveryUnknown: 'Consegna incerta — controlla prima di riprovare.', locked: 'Puoi leggere questa conversazione, ma non puoi pubblicare.', offline: 'Sei offline. Riconnettiti per continuare.', unavailable: 'Questa conversazione non è disponibile.', unreadCount: ({ count }) => count === 1 ? '1 non letto' : `${count.toLocaleString()} non letti`, unreadMentionCount: ({ count }) => count === 1 ? '1 menzione non letta' : `${count.toLocaleString()} menzioni non lette`,
        mentioned: 'Sei stato menzionato', unreadConversations: 'Conversazioni non lette', messageCount: ({ count }) => count === 1 ? '1 messaggio' : `${count.toLocaleString()} messaggi`, viaAgent: 'Tramite Agent', collaborator: 'Collaboratore', contentUnavailable: 'Messaggio non disponibile', rename: 'Rinomina conversazione', archive: 'Archivia conversazione', restore: 'Ripristina conversazione', selection: { copy: 'Copia', askAgent: 'Chiedi all’Agent', sendToSession: 'Invia alla sessione', handoffError: 'Non è stato possibile aggiungere i messaggi selezionati all’editor della sessione.' }, titleRequired: 'Aggiungi un titolo per avviare questa conversazione.', encryptedTitle: 'Conversazione cifrata', archivedNotice: 'Questa conversazione è archiviata.', sessionArchived: 'Questa sessione è archiviata.', postDenied: 'Non puoi più pubblicare in questa sessione.', invalidMention: 'Una persona menzionata non può più leggere questa sessione.', invalidContent: 'Questo messaggio non può essere inviato così com’è. Potrebbe essere vuoto o troppo lungo.', idempotencyConflict: 'Un messaggio diverso è già stato inviato con questa identità.', sendFailed: 'Impossibile inviare questo messaggio.', dismiss: 'Ignora', loadOlder: 'Carica messaggi precedenti', loadMore: 'Carica altre conversazioni' } } };

return { sessionCollaborationTranslations };
})();

const Domain_sessionCompanionTranslations = (() => {
type SessionCompanionTranslations = Shared_sessionCompanionTranslations.SessionCompanionTranslations;

const sessionCompanionTranslations = { it: {
        recap: { title: 'Riepilogo' },
        status: {
            waitingForYou: 'Aspetta te',
            pausedBeforeStep: ({ agent, step, total }) => `${agent} si è fermato prima del passo ${step} di ${total}`,
            stepOfPlan: ({ step, total }) => `Passo ${step} di ${total} del piano`,
            agentFallback: 'L’agente',
        },
        ask: {
            question: ({ summary }) => `${summary}?`,
            allow: 'Consenti',
            deny: 'Nega',
            showInChat: 'Mostra nella chat',
            moreWaiting: ({ count }) => `Altri ${count} in attesa`,
            allowed: ({ summary }) => `Consentito: ${summary}`,
            denied: ({ summary }) => `Negato: ${summary}`,
            justNow: 'proprio ora',
            failed: 'La tua risposta non ha raggiunto la sessione. Riprova.',
            answerWhenBack: ({ machine }) => `Potrai rispondere quando ${machine} tornerà.`,
            answerWhenSessionBack: 'Potrai rispondere quando la sessione tornerà.',
            notAllowed: 'Solo chi può eseguire questa sessione può rispondere.',
            groupA11y: 'Aspetta te',
        },
        facts: {
            subagents: 'subagenti',
            changed: 'modificati',
            context: 'contesto',
            subagentsValue: ({ live, total }) => (live > 0 ? `${live} di ${total}` : `${total}`),
            contextValue: ({ percent }) => `${percent}%`,
            opensAgents: 'Apre Agenti',
            opensGit: 'Apre Git',
            opensUsage: 'Apre l’utilizzo',
        },
        plan: {
            title: 'Piano',
            description: ({ agent }) => `La lista di cose da fare di ${agent} per questa sessione`,
            progress: ({ done, total }) => `${done} di ${total}`,
            progressA11y: ({ done, total }) => `${done} di ${total} completati`,
            emptyTitle: 'Ancora nessun piano',
            emptyReason: 'Quando l’agente scrive una lista di cose da fare, compare qui, passo dopo passo.',
            stepDone: 'Fatto',
            stepCurrent: 'Passo attuale',
        },
        picker: {
            open: 'Aggiungi al Compagno',
            chooseWidget: 'Scegli un widget…',
            onTheBoard: ({ source }) => `${source} · sulla bacheca`,
        },
        drop: { keepBesideChat: 'Tieni accanto alla chat' },
        freshness: { machineOffline: ({ machine }) => `${machine} è offline` },
        needsYouA11y: ({ count }) => `Compagno, ${count} aspettano te`,
    } } as const satisfies Pick<Readonly<Record<string, SessionCompanionTranslations>>, "it">;

return { sessionCompanionTranslations };
})();

const Domain_sessionConversationSurfaceTranslations = (() => {
const en = Shared_sessionConversationSurfaceTranslations.en;

const it: typeof en = {
    discussion: {
        loadingTitle: 'Apertura della conversazione…',
        offlineTitle: 'Questa conversazione non è disponibile offline',
        offlineReason: 'Riconnettiti e si riaprirà da dove l’hai lasciata.',
        errorTitle: 'Impossibile aprire questa conversazione',
        lockedTitle: 'Non è ancora possibile aprire questa conversazione su questo dispositivo',
        lockedReason: 'È crittografata end-to-end e la configurazione di crittografia di questo dispositivo non corrisponde a quella della sessione.',
        revokedTitle: 'Non hai più accesso a questa conversazione',
        revokedReason: 'Questa sessione non è più condivisa con te. I messaggi che hai scritto restano nella sessione.',
        unavailableTitle: 'Le conversazioni non sono disponibili qui',
        closeTab: 'Chiudi scheda',
    },
    draft: {
        leadTitle: 'Chiedi a un agente',
        leadBody: 'Viene eseguito come conversazione a sé accanto alla sessione, con questi messaggi come contesto. Non parte nulla finché non invii.',
    },
    context: {
        fromConversation: ({ title, count }) => `Da ${title} · ${count === 1 ? '1 messaggio' : `${count} messaggi`}`,
        fromUntitled: ({ count }) => `Da una conversazione · ${count === 1 ? '1 messaggio' : `${count} messaggi`}`,
    },
    origin: {
        fromConversation: ({ title }) => `da ${title}`,
        fromUntitled: 'da una conversazione',
    },
    run: {
        details: 'Dettagli dell’esecuzione',
        loadingTitle: 'Apertura della conversazione con l’agente…',
        errorTitle: 'Impossibile aprire questa conversazione con l’agente',
    },
};

const sessionConversationSurfaceTranslations = { it };

return { sessionConversationSurfaceTranslations };
})();

const Domain_sessionDirectoryRecoveryTranslations = (() => {
const en = Shared_sessionDirectoryRecoveryTranslations.en;

const sessionDirectoryRecoveryTranslations = { it: {
        title: ({ machine }) => `La cartella privata di questa chat non è più su ${machine}.`,
        body: 'Puoi continuare in una cartella nuova e vuota. La cronologia della chat resterà qui, ma i file locali della vecchia cartella non verranno ripristinati.',
        continue: 'Continua in una nuova cartella', notNow: 'Non ora',
        offlineDelete: ({ machine }) => `La sua cartella privata su ${machine} verrà rimossa quando quel computer tornerà online.`,
    } } satisfies Pick<Record<import('../../_all').SupportedLanguage, typeof en>, "it">;

return { sessionDirectoryRecoveryTranslations };
})();

const Domain_sessionDraftTranslations = (() => {
const en = Shared_sessionDraftTranslations.en;

const it: typeof en = {
    sectionTitle: 'Bozze',
    sectionTitleForHome: ({ home }) => `Bozze su ${home}`,
    waitingSectionTitleForHome: ({ home }) => `In attesa di un computer su ${home}`,
    badge: 'Bozza',
    untitled: 'Bozza senza titolo',
    continueEditing: 'Continua a modificare',
    startAnother: 'Avviane un’altra',
    executionRunStart: {
        starting: 'Avvio della conversazione con l’agente…',
        reconciling: 'Verifica se questa conversazione con l’agente è stata avviata…',
        unresolved: 'Non siamo riusciti a confermare se questa conversazione con l’agente è stata avviata. Avviarne un’altra può crearne una seconda.',
        targetChanged: 'Il computer di questa sessione è cambiato prima che la conversazione potesse avviarsi. Non è stato avviato nulla.',
        secretReferenceOverlayUpdateRequired: 'Usare segreti condivisi in una conversazione con l’agente richiede un computer aggiornato. Non è stato avviato nulla.',
    },
    status: {
        offline: 'Offline — salvata su questo dispositivo',
        syncing: 'Sincronizzazione…',
        conflict: 'Da rivedere',
        unsupported: 'Non sincronizzata — questo Home non può sincronizzare questa bozza',
        startInterrupted: 'Avvio interrotto',
    },
    availability: {
        machineUnavailable: 'Macchina non disponibile',
        pluginUnavailable: 'Plugin non disponibile',
        attachmentNeedsAttention: 'L’allegato richiede attenzione',
    },
    new: { action: 'Nuova sessione' },
    delete: {
        action: 'Elimina bozza',
        confirmTitle: 'Eliminare questa bozza?',
        confirmDescription: 'La bozza viene rimossa dai tuoi dispositivi sincronizzati.',
    },
    conflict: {
        title: 'Rivedi le modifiche in conflitto',
        description: 'Scegli quale versione mantenere per ogni campo. Puoi copiare la versione del tuo dispositivo prima di sostituirla.',
        mine: 'Questo dispositivo',
        synced: 'Versione sincronizzata',
        useSynced: 'Usa la sincronizzata',
        keepDevice: 'Mantieni questo dispositivo',
        copyMine: 'Copia la mia',
        copied: 'Copiato',
        copyFailed: 'Impossibile copiare questo valore.',
        field: {
            text: 'Messaggio',
            mentions: 'Menzioni',
            attachments: 'Allegati',
            recipient: 'Destinatario',
            agentContinuation: 'Continuazione dell’agente',
            executionRunRequestedAction: 'Consegna dell’esecuzione',
        },
    },
};

const sessionDraftTranslations = { it };

return { sessionDraftTranslations };
})();

const Domain_sessionEmbeddedTranslations = (() => {
const en = Shared_sessionEmbeddedTranslations.en;

const translated = Shared_sessionEmbeddedTranslations.translated;

const sessionEmbeddedTranslations = { it: translated({
        unavailable: 'Questa sessione non è disponibile',
        respondInSession: 'Apri la sessione per rispondere.',
        regionLabel: ({ title }) => `Sessione: ${title}`,
        newChatWelcome: 'Su cosa lavoriamo?',
    }) } as const;

return { sessionEmbeddedTranslations };
})();

const Domain_sessionFollowTranslations = (() => {
type SessionFollowTranslations = Shared_sessionFollowTranslations.SessionFollowTranslations;

const en = Shared_sessionFollowTranslations.en;

const sessionFollowTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionFollowTranslations
>, "it"> = { 'it': {
        "notificationBody": {"message":"Nuovo messaggio in questa sessione.","failed":"Il turno non è riuscito.","cancelled":"Il turno è stato annullato.","sourceUnavailable":"La fonte di questa sessione non è disponibile."},
        "follow": "Segui",
        "unfollow": "Smetti di seguire",
        "following": "Seguita",
        "notifications": "Notifiche",
        "unavailableTitle": "Il following non è disponibile",
        "unavailableDescription": "Questo Home non offre il following delle sessioni.",
        "unreachableTitle": "Impossibile raggiungere questo Home",
        "unreachableDescription": "Happier non è riuscito a verificare se questo Home offre il following delle sessioni. Riprova quando sarà raggiungibile.",
        "editor": {
            "title": "Segui questa sessione",
            "subtitle": "Ricevi gli aggiornamenti che ti interessano.",
            "ownerSubtitle": "Questa sessione è tua, quindi i suoi aggiornamenti ti raggiungono sempre.",
            "externalAttachedOnly": "La sincronizzazione in background è disattivata, quindi gli aggiornamenti potrebbero arrivare solo mentre questa sessione è collegata."
        },
        "level": {
            "none": "Nessuna notifica",
            "important": "Aggiornamenti importanti",
            "all_messages": "Ogni nuovo messaggio"
        },
        "voice": {
            "title": "Includi in Voice",
            "subtitle": "Voice può mantenere questa sessione nel contesto.",
            "waitingRuntime": "In attesa che Voice si connetta.",
            "unsupported": "Questo ambiente non supporta le sessioni seguite in Voice.",
            "providerWithheld": "Questa modalità Voice non può includere gli aggiornamenti delle sessioni salvate.",
            "waitingEncrypted": "Sblocca questa sessione per includerla in Voice.",
            "initialSnapshotPending": "Al prossimo turno di Voice, includi un breve riepilogo dello stato attuale."
        },
        "footer": "Seguire non cambia mai chi può accedere a questa sessione.",
        "settingsLink": "Impostazioni notifiche…",
        "assignedExplanation": "Segui questa sessione perché ti è stata assegnata",
        "assignedNotice": "Ti è stata assegnata una sessione.",
        "sharedNotice": "Una sessione è stata condivisa con te.",
        "wakeEventExplanation": "Il contesto seguito è cambiato, quindi Happier ha risvegliato questo agente con l’aggiornamento.",
        "accessLost": "Non hai più accesso a questa sessione.",
        "offline": "Sei offline. Riconnettiti per modificare il seguito.",
        "archived": "Il seguito è sospeso mentre questa sessione è archiviata.",
        "sources": {
            "title": "Aggiornamenti delle sessioni",
            "waitingRuntime": "In attesa che la sessione di destinazione si riconnetta.",
            "unsupported": "Aggiorna o riconnetti la CLI sulla macchina di destinazione per ricevere gli aggiornamenti.",
            "pausedArchived": "Gli aggiornamenti sono in pausa mentre la sorgente o la destinazione è archiviata.",
            "add": "Segui in un'altra sessione…",
            "addSource": "Invia aggiornamenti da un’altra sessione…",
            "chooseDestinationTitle": "Segui in un'altra sessione",
            "chooseSourceTitle": "Invia aggiornamenti da un’altra sessione",
            "row": ({ title }) => `Aggiornamenti da “${title}”`,
            "nextTurn": "Prossimo turno",
            "wakeOnHumanChange": "Riattiva quando una persona aggiunge un messaggio",
            "stop": "Interrompi gli aggiornamenti",
            "stopForSource": ({ title }) => `Interrompi gli aggiornamenti da «${title}»`,
            "includeNextTurn": "Includi gli aggiornamenti nel prossimo turno della destinazione.",
            "sourceKeyPreparing": "Preparazione dell’accesso crittografato…",
            "sourceKeyWaiting": "In attesa dell’accesso crittografato.",
            "sourceKeyUnavailable": "Questo computer non può fornire l’accesso crittografato.",
            "sourceSessionKeyUnavailable": "L’accesso crittografato di questa sessione non è disponibile qui.",
            "catchUpPending": "Recupero in sospeso"
        },
        "preferences": {
            "title": "Segui automaticamente",
            "assigned": "Sessioni assegnate a me",
            "direct": "Sessioni condivise direttamente",
            "team": "Sessioni condivise tramite team",
            "group": "Sessioni condivise tramite gruppi",
            "help": "Si applica alle nuove assegnazioni e alle sessioni appena accessibili. Le scelte esistenti restano invariate."
        }
    } };

return { sessionFollowTranslations };
})();

const Domain_sessionGitBranchesTranslations = (() => {
type SessionGitBranchesTranslations = Shared_sessionGitBranchesTranslations.SessionGitBranchesTranslations;

const en = Shared_sessionGitBranchesTranslations.en;

const it: SessionGitBranchesTranslations = {
    openA11y: ({ branch }) => `Branch ${branch}: cambia branch o guarda cosa è stato messo da parte`,
    searchPlaceholder: 'Cambia o crea un branch',
    category: { current: 'Attuale', branches: 'Branch', remote: 'Branch remoti', keptAside: 'Messo da parte', worktrees: 'Worktree', start: 'Inizia qualcosa di nuovo' },
    tracks: ({ upstream }) => `segue ${upstream}`,
    onlyHere: 'solo su questa macchina',
    changed: ({ count }) => `${count} modificati`,
    ahead: ({ count }) => `${count} da inviare`,
    keptAsideWhen: ({ origin, when }) => `${origin} · ${when}`,
    newBranch: ({ branch }) => `Nuovo branch da ${branch}…`,
    newBranchDetached: 'Nuovo branch…',
    newBranchSubtitle: 'Scrivi il nome nel campo di ricerca',
    newWorktree: 'Nuovo worktree…',
    newWorktreeSubtitle: 'Lavora su un altro branch in una nuova sessione',
    keepAside: 'Metti da parte le modifiche',
    keepAsideSubtitle: ({ count }) => `Metti via ${count} modifiche e riparti pulito`,
    keepAsideNothing: 'Nessuna modifica da tenere',
    keepAsideFailed: 'Impossibile mettere da parte le modifiche.',
    loadFailed: 'Impossibile caricare i branch',
    notice: {
        title: ({ branch }) => `Hai messo da parte modifiche su ${branch}`,
        reason: ({ when }) => `Messe da parte ${when}. Riprendile per continuare.`,
        reasonUndated: 'Riprendile per continuare.',
        restore: 'Ripristina le modifiche',
        lookFirst: 'Guarda prima',
        dismiss: 'Non ora',
        restoreFailed: 'Impossibile ripristinare le modifiche.',
    },
};

const sessionGitBranchesTranslations = { it };

return { sessionGitBranchesTranslations };
})();

const Domain_sessionGitDisplayTranslations = (() => {
const en = Shared_sessionGitDisplayTranslations.en;

const it: typeof en = {
    settingsLayout: 'Layout del pannello Git',
    settingsShowAs: 'Mostra i file modificati come',
    trigger: 'Opzioni di visualizzazione',
    paneGroup: 'Pannello',
    changesGroup: 'Modifiche',
    layout: 'Layout',
    layoutUnified: 'Unificato',
    layoutTabs: 'Schede',
    layoutDescription: 'Un solo scorrimento dalle modifiche alla cronologia, o Modifiche e Cronologia come due viste.',
    showAs: 'Mostra come',
    showAsList: 'Elenco',
    showAsTree: 'Albero',
    showAsDescription: 'I file modificati in un elenco, o raggruppati per cartella per prendere cartelle intere.',
    density: 'Densità',
    densityDefault: 'Predefinita',
    densityCompact: 'Compatta',
    note: 'Le righe dell’albero sono sempre compatte. Ricordato per il tuo account.',
    selectFolder: ({ folder }) => `Seleziona tutte le modifiche in ${folder}`,
    selectFile: ({ file }) => `Seleziona ${file} per il prossimo commit`,
};

const sessionGitDisplayTranslations = { it };

return { sessionGitDisplayTranslations };
})();

const Domain_sessionGitPaneTranslations = (() => {
const en = Shared_sessionGitPaneTranslations.en;

const fidelity = Shared_sessionGitPaneTranslations.fidelity;

const withFidelity = Shared_sessionGitPaneTranslations.withFidelity;

const it: typeof en = {
    scope: { allChanges: 'Tutte le modifiche' },
    subTabs: { changes: 'Modifiche', sync: 'Sincronizza', history: 'Cronologia' },
    header: {
        changed: ({ count }) => `${count} modificati`,
        toPush: ({ count }) => `${count} da inviare`,
        toPull: ({ count }) => `${count} da ricevere`,
        push: ({ count }) => `Invia ${count}`,
        pull: ({ count }) => `Ricevi ${count}`,
        publish: 'Pubblica',
        folderOnMachine: ({ folder, machine }) => `${folder} su ${machine}`,
    },
    groups: {
        session: 'Modificato in questa sessione',
        elsewhere: ({ repo }) => `Altrove in ${repo}`,
        elsewhereUnnamed: 'Altrove in questo repository',
        selectGroup: ({ group }) => `Seleziona tutti i file in «${group}»`,
    },
    row: { renamedFrom: ({ path }) => `prima ${path}` },
    commit: {
        toBranch: ({ branch }) => `Commit su ${branch}`,
        selection: ({ count }) => (count === 1 ? '1 file' : `${count} file`),
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
            dirtyTitle: ({ count, formatted }) => (count === 1 ? `Hai 1 modifica non nel commit` : `Hai ${formatted} modifiche non nel commit`),
            dirtyBody: 'Il pull potrebbe toccarle. Mettile da parte durante il pull (tornano subito dopo) o lascia che Git faccia il pull solo se nulla si sovrappone.',
            keepAsideAndPull: 'Metti da parte e fai pull',
            pullIfNoOverlap: 'Pull se nulla si sovrappone',
            divergedPullBody: 'Il tuo branch e origin sono andati avanti entrambi. Metti i tuoi commit sopra quelli di origin o uniscili.',
            divergedPushBody: 'Porta prima i commit di origin (i tuoi sopra o con un merge), poi fai di nuovo push. I tuoi commit restano su questa macchina.',
            rebase: 'Rebase su origin',
            merge: 'Merge di origin',
        },
        writesOff: {
            title: 'Il commit da Happier è disattivato',
            body: 'Puoi leggere e rivedere ogni modifica. Attiva le operazioni di controllo versione per fare commit, push e pull da qui.',
            turnOn: 'Attiva',
        },
        header: {
            noChanges: 'nessuna modifica',
        },
        action: {
            fetch: 'Recupera',
            publish: 'Pubblica branch',
            createPr: 'Crea PR',
            openPr: ({ number }) => `#${number}`,
            resolve: ({ count }) => `Risolvi ${count}`,
            upToDate: 'Aggiornato',
            pushing: ({ count }) => `Invio di ${count}…`,
            pulling: ({ count }) => `Recupero di ${count}…`,
            fetching: 'Recupero…',
            publishing: 'Pubblicazione…',
            creatingPr: 'Creazione…',
        },
        menu: {
            open: 'Altre azioni di sincronizzazione',
            push: 'Push',
            pull: 'Pull',
            pushTo: ({ target }) => `su ${target}`,
            pullFrom: ({ target }) => `da ${target}`,
            nothingToPush: 'Niente da inviare',
            upToDate: 'Aggiornato',
            fetchHint: 'Controlla se origin ha nuovi commit',
            publishHint: 'Porta questo branch su origin',
            createPr: 'Crea pull request…',
            createPrInto: ({ base }) => `verso ${base}`,
            unavailable: 'Non disponibile qui',
            more: 'Altro',
        },
        running: {
            branchSwitch: 'Cambio branch…',
            branchCreate: 'Creazione del branch…',
            stashCreate: 'Metto da parte le modifiche…',
            discard: 'Scarto le modifiche…',
            revert: 'Annullo il commit…',
            generic: 'In corso…',
        },
        done: {
            untouched: ({ count, formatted }) => (count === 1 ? `la tua modifica non nel commit è intatta` : `le tue ${formatted} modifiche non nel commit sono intatte`),
            commit: 'Commit eseguito',
            commitFiles: ({ count, formatted }) => (count === 1 ? `1 file nel commit` : `${formatted} file nel commit`),
            push: 'Inviato',
            pushCommits: ({ count, formatted }) => (count === 1 ? `1 commit inviato` : `${formatted} commit inviati`),
            upToDate: ({ target }) => `${target} è aggiornato`,
            pull: 'Recuperato',
            pullCommits: ({ count, formatted }) => (count === 1 ? `1 commit recuperato` : `${formatted} commit recuperati`),
            fetch: ({ target }) => `${target} controllato`,
            branchSwitch: 'Branch cambiato',
            branchCreate: 'Branch creato',
            stashCreate: 'Modifiche messe da parte',
            discard: 'Modifiche scartate',
            revert: 'Commit annullato',
            pullRequest: 'Pull request pronta',
            generic: 'Fatto',
        },
        failed: {
            unknownTitle: 'Non siamo riusciti a confermare com’è finita',
            unknownBody: 'La macchina ha smesso di rispondere prima che Git riferisse. Controlla di nuovo per vedere cosa è successo.',
            origin: 'origin',
            thisMachine: 'questa macchina',
            refreshTitle: 'Commit eseguito, ma l’elenco non si è aggiornato',
            refreshBody: 'Il commit è al sicuro. Riprova per vedere le modifiche attuali.',
            rejectedTitle: ({ target }) => `${target} ha commit che tu non hai`,
            rejectedBody: 'Recuperali per vedere cosa è cambiato. I tuoi commit restano su questa macchina fino al prossimo invio.',
            authTitle: ({ machine, provider }) => `${provider} non ha accettato l’accesso da ${machine}`,
            authBody: ({ machine }) => `Git su ${machine} non ha credenziali valide per questo remoto. Accedi lì e riprova.`,
            offlineTitle: ({ machine }) => `${machine} è offline`,
            offlineBody: 'Lì non può essere eseguito nulla ora. Il tuo lavoro è al sicuro su quella macchina.',
            conflictTitle: 'Interrotto per modifiche in conflitto',
            conflictBody: 'Alcuni file sono cambiati da entrambe le parti. Risolvili, poi continua.',
            networkTitle: ({ target }) => `Impossibile raggiungere ${target}`,
            networkBody: 'La macchina non è riuscita a collegarsi al remoto. Controlla la rete e riprova.',
            commitTitle: 'Il commit non è andato a buon fine',
            pushTitle: 'Il push non è andato a buon fine',
            pullTitle: 'Il pull non è andato a buon fine',
            fetchTitle: 'Impossibile controllare i nuovi commit',
            pullRequestTitle: 'La pull request non è stata creata',
            genericTitle: 'Non è andato a buon fine',
        },
        recover: {
            open: 'Apri',
            tryAgain: 'Riprova',
            fetch: 'Recupera',
            checkAgain: 'Controlla di nuovo',
            showConflicts: 'Mostra conflitti',
        },
        timeline: {
            title: 'Cronologia',
            now: 'Ora',
            loading: 'Lettura della cronologia…',
            uncommitted: ({ count, formatted }) => (count === 1 ? `1 modifica non nel commit` : `${formatted} modifiche non nel commit`),
            selected: ({ count, formatted }) => (count === 1 ? `1 selezionata per il prossimo commit` : `${formatted} selezionate per il prossimo commit`),
            nothingSelected: 'Niente selezionato',
            earlierToday: 'Oggi, prima',
            yesterday: 'Ieri',
            older: 'Meno recenti',
            justNow: 'adesso',
            toPull: 'da recuperare',
            originFurther: ({ name }) => `${name} è più indietro`,
            originA11y: ({ name }) => `${name} è qui`,
        },
        clean: {
            titleUpToDate: 'Tutto è nel commit e inviato',
            titleCommitted: 'Tutto è nel commit',
            bodyUpToDate: ({ branch, upstream }) => `${branch} corrisponde a ${upstream}. Le nuove modifiche di questa sessione appariranno qui.`,
            body: 'Le nuove modifiche di questa sessione appariranno qui.',
            createPullRequest: 'Crea pull request',
            openPullRequest: ({ number }) => `Apri la pull request #${number}`,
            lastCommit: ({ when }) => `Ultimo commit ${when}`,
        },
        conflicts: {
            skip: 'Salta questo commit',
            askAgentTask: ({ files, operation }) => `Risolvi i conflitti del ${operation} in ${files}. Mantieni l’intento di entrambe le parti, modifica e aggiungi all’area di stage i file risolti, poi fermati per la mia revisione. Non continuare, non annullare, non fare commit né push e non scegliere una parte in blocco.`,
            revert: 'revert',
            cherryPick: 'cherry-pick',
            merge: 'merge',
            rebase: 'rebase',
            stopped: ({ count, formatted, operation }) => (count === 1 ? `Il ${operation} si è fermato: 1 file è cambiato da entrambe le parti` : `Il ${operation} si è fermato: ${formatted} file sono cambiati da entrambe le parti`),
            readyToContinue: ({ operation }) => `Tutti i conflitti sono risolti. Continua il ${operation}.`,
            filesInConflict: ({ count, formatted }) => (count === 1 ? `1 file in conflitto` : `${formatted} file in conflitto`),
            body: 'Apri ogni file in «Serve te» o chiedi all’agente di risolverli.',
            continueBody: 'Nulla va nel commit finché non continui.',
            askAgent: 'Chiedi all’agente di risolvere',
            continue: ({ operation }) => `Continua il ${operation}`,
            abort: ({ operation }) => `Annulla il ${operation}`,
            abortTitle: ({ operation }) => `Annullare il ${operation}?`,
            abortBody: 'Il branch torna com’era prima di iniziare. Le risoluzioni fatte finora vanno perse.',
            needsYou: 'Serve te',
            mergedCleanly: 'Unito senza conflitti',
        },
        commit: {
            selectFirst: 'Seleziona i file per il commit',
        },
        tools: {
            title: 'Remoti e merge',
            subtitle: 'Aggiungi un remoto, fai merge o rebase di un branch',
        },
    },
    paused: { reason: 'la sessione è in pausa', resume: 'Riprendi' },
    notRepository: {
        title: 'Tieni traccia di ciò che gli agenti cambiano qui',
        body: ({ folder }) => `${folder} non è ancora un repository. Creane uno per rivedere, fare commit e annullare ogni modifica.`,
        bodyUnnamed: 'Questa cartella non è ancora un repository. Creane uno per rivedere, fare commit e annullare ogni modifica.',
    },
};

const sessionGitPaneTranslations = { it: withFidelity(it) };

return { sessionGitPaneTranslations };
})();

const Domain_sessionGitPullRequestTranslations = (() => {
type ProviderArgs = Shared_sessionGitPullRequestTranslations.ProviderArgs;

type GitPullRequestCopy = Shared_sessionGitPullRequestTranslations.GitPullRequestCopy;

const en = Shared_sessionGitPullRequestTranslations.en;

const it: GitPullRequestCopy = {
    form: {
        title: 'Nuova pull request', expand: 'Apri in un pannello dei dettagli', moveBack: 'Riporta nella barra laterale',
        close: 'Chiudi il modulo (la bozza resta)', base: 'Si unisce a', titlePlaceholder: 'Titolo',
        bodyPlaceholder: 'Cosa è cambiato e perché', draft: 'Bozza', create: 'Crea pull request', creating: 'Creazione…',
        continueOn: ({ provider }) => `Continua su ${provider}`, pointer: 'La nuova pull request è aperta in Dettagli', pointerShow: 'Mostra',
        openedProviderPage: ({ provider }) => `${provider} è aperto per completarla; il tuo testo resta qui.`,
    },
    failure: {
        authFailed: ({ provider }) => `${provider} non ha accettato l’accesso da questa macchina`,
        network: ({ provider }) => `Impossibile raggiungere ${provider}`,
        machineOffline: 'La macchina è offline; la bozza resta',
        blocked: 'È in corso un’altra operazione Git; riprova quando finisce',
        other: 'La pull request non è stata creata',
    },
    card: {
        number: ({ number }) => `#${number}`, intoBase: ({ base }) => `in ${base}`,
        state: { open: 'Aperta', draft: 'Bozza', merged: 'Unita', closed: 'Chiusa', unknown: 'Pull request' },
        checks: { pending: 'Controlli in corso', success: 'Controlli superati', failure: 'Controlli non superati', unknown: 'Controlli' },
        openOn: ({ provider }) => `Apri su ${provider}`, copyLink: 'Copia link', copied: 'Link copiato',
    },
    settings: {
        placementTitle: 'Apri le nuove pull request in', placementDescription: 'Su un telefono il modulo si apre sempre come pagina a sé.',
        sidebar: 'Barra laterale', details: 'Pannello dei dettagli',
    },
};

const sessionGitPullRequestTranslations = { it };

return { sessionGitPullRequestTranslations };
})();

const Domain_sessionHomeFreshnessTranslations = (() => {
const en = Shared_sessionHomeFreshnessTranslations.en;

const translated = Shared_sessionHomeFreshnessTranslations.translated;

const sessionHomeFreshnessTranslations = { it: translated({
        offline: 'Offline',
        stale: 'Aggiornamento non riuscito',
        lastUpdated: ({ ago }) => `Aggiornato ${ago} fa`,
    }) };

return { sessionHomeFreshnessTranslations };
})();

const Domain_sessionListFilterTranslations = (() => {
const en = Shared_sessionListFilterTranslations.en;

const translated = Shared_sessionListFilterTranslations.translated;

const sessionListFilterTranslations = { it: translated({
        filtersTitle: 'Filtri sessioni', filtersSearch: 'Cerca filtri…', filtersShow: 'Mostra',
        filtersScope: 'Ambito', filtersShowSessions: 'Sessioni', filtersShowRuns: 'Esecuzioni', filtersShowBoth: 'Entrambe',
        filtersShowBothSummary: 'Sessioni ed esecuzioni', filtersStartedByNone: 'Nessun iniziatore selezionato',
        filtersStartedBy: 'Avviato da', filtersStartedByYou: 'Te', filtersStartedByTriggers: 'Trigger', filtersStartedByAgents: 'Agenti',
        filtersRunsNeedingYouAlwaysShow: 'Le esecuzioni che richiedono il tuo intervento restano visibili',
        filtersMyWork: 'Il mio lavoro', filtersLegacyOwnerDirect: 'Il mio lavoro', filtersAssignedToMe: 'Assegnate a me', filtersFollowing: 'Seguite',
        filtersInvolvingMe: 'Che mi coinvolgono', filtersAllAccessible: 'Tutte le accessibili', filtersAttention: 'Attenzione',
        filtersAttentionAny: 'Qualsiasi', filtersAttentionNeedsMe: 'Solo sessioni che hanno bisogno di me', filtersScopeNeedsMe: 'Ha bisogno di me',
        filtersInactive: 'Sessioni inattive', filtersInactiveShow: 'Mostra', filtersInactiveHide: 'Nascondi',
        filtersHomes: 'Home', filtersSharedWith: 'Condivise con', filtersOutsideTeams: 'Personali e dirette',
        filtersTags: 'Tag', filtersSource: 'Origine', filtersSourceAll: 'Tutte',
        filtersSourceDirect: 'Esterne',
        filtersNoOptions: 'Nessun filtro disponibile', filtersClear: 'Cancella filtri', filtersDone: 'Fine', filtersArchived: 'Archiviate',
        filtersNeedsMeOnly: 'Solo ciò che mi serve', filtersNeedsMeOnlyDescription: 'Sessioni in attesa di te', filtersSourceHappier: 'Happier',
        filtersMoreTags: ({ count }: { count: number }) => `+ ${count} altri`,
        filtersResultCount: ({ count }: { count: number }) => count === 1 ? `1 elemento` : `${count} elementi`,
        queryInitialLoadingTitle: 'Caricamento sessioni…', queryUpdatingTitle: 'Aggiornamento sessioni…',
        querySomeHomesUnavailableTitle: 'Alcuni Home non sono disponibili', querySomeHomesUnavailableDescription: 'Happier mostra ciò che può raggiungere. Riprova quando gli Home saranno di nuovo online.',
        queryRefreshFailedTitle: 'Impossibile aggiornare', queryRefreshFailedRetainedDescription: 'Le sessioni caricate restano visibili. Riprova per verificare gli aggiornamenti.', queryRefreshFailedEmptyDescription: 'Happier non ha potuto caricare le sessioni dagli Home selezionati. Riprova quando saranno raggiungibili.',
        queryNoMatchesLoadedTitle: 'Nessun risultato nelle sessioni caricate', queryNoMatchesLoadedDescription: 'Altre sessioni corrispondenti potrebbero trovarsi in una pagina precedente.', querySearchOlder: 'Cerca nelle sessioni precedenti',
        queryMoreAvailableTitle: 'Potrebbero essere disponibili altre sessioni', queryMoreAvailableDescription: 'Questa vista include le sessioni caricate. Cerca nelle sessioni precedenti per continuare.',
        queryNoMatchesTitle: 'Nessuna sessione corrisponde', queryNoMatchesDescription: 'Prova a modificare i filtri attivi.',
        queryTeamEmptyTitle: 'Questo Team non ha sessioni', queryTeamEmptyDescription: 'Le sessioni condivise con questo Team appariranno qui.',
        queryMyWorkEmptyTitle: 'Niente in Il mio lavoro', queryScopeEmptyDescription: 'Prova un ambito più ampio o torna più tardi.', queryBrowseAllAccessible: 'Mostra tutte le sessioni',
        queryAssignedEmptyTitle: 'Nessuna sessione ti è assegnata', queryFollowingEmptyTitle: 'Nessuna sessione seguita', queryInvolvingEmptyTitle: 'Nessuna sessione ti coinvolge',
        queryAttentionEmptyTitle: 'Nessuna sessione richiede la tua attenzione', queryReachableEmptyTitle: 'Nessuna sessione disponibile', queryReachableEmptyDescription: 'Nessuna sessione corrisponde a questa vista negli Home raggiungibili.',
        queryHistoricalSharesWithheldTitle: 'Alcune sessioni condivise sono nascoste', queryHistoricalSharesWithheldDescription: 'Le sessioni condivise con te da una versione precedente di Happier restano nascoste finché il proprietario non le aggiorna in Happier.',
        partialHomeNotMountedTitle: ({ home }) => `${home} non è in questa vista Sessioni`,
        partialHomeNotMountedDescription: 'Aggiungi questo Home a un gruppo di Home visibile per mostrare le sessioni del Team senza cambiare il focus.',
        partialShowFromHome: ({ home }) => `Mostra sessioni da ${home}`,
        teamListingUnavailableTitle: 'L’elenco delle sessioni del Team non è disponibile su questo Home',
        teamListingUnavailableDescription: 'Questo Home non può ancora elencare le sessioni del Team. Aggiornalo o riconfiguralo, quindi riprova.',
        teamListingLoadingTitle: ({ team }) => `Caricamento delle sessioni di ${team}…`,
        teamListingLoadingDescription: 'Happier sta verificando cosa può elencare questo Home.',
        teamListingProbeFailedTitle: 'Impossibile raggiungere questo Home',
        teamListingProbeFailedDescription: 'Happier non è riuscito a interrogare questo Home per le sessioni del Team. Riprova quando sarà raggiungibile.',
    }) };

return { sessionListFilterTranslations };
})();

const Domain_sessionMessageAccountActorTranslations = (() => {
type AccountActorTranslations = Shared_sessionMessageAccountActorTranslations.AccountActorTranslations;

const sessionMessageAccountActorTranslations: Pick<Record<SupportedLanguage, AccountActorTranslations>, "it"> = { it: { accountActorYou: 'Tu', accountActorFormerMember: 'Ex membro', accountActorUnnamedMember: 'Membro di Happier', accountActorSentBy: ({ name }) => `Inviato da ${name}` } };

return { sessionMessageAccountActorTranslations };
})();

const Domain_sessionPageTranslations = (() => {
const english = Shared_sessionPageTranslations.english;

const translated = Shared_sessionPageTranslations.translated;

const sessionPageTranslations = { it: translated({
        sessionPages: {
            info: {
                continueTitle: 'Continua',
                continueDescription: 'Avvia nuovo lavoro dal punto in cui si trova questa sessione.',
                organizeTitle: 'Organizza',
                organizeDescription: 'Dove compare questa sessione nei tuoi elenchi.',
                activityDescription: 'Cosa sta facendo l’agente e se ne vieni avvisato.',
                detailsTitle: 'Dettagli',
                detailsDescription: 'Identificatori e cronologia, per supporto e script.',
                environmentTitle: 'Ambiente',
                environmentDescription: 'La macchina, la cartella e l’agente con cui gira questa sessione.',
                agentStateDescription: 'Chi guida l’agente e cosa sta aspettando.',
                relatedTitle: 'Correlati',
                relatedDescription: 'Altre pagine di questa sessione.',
                developerTitle: 'Sviluppatore',
                developerDescription: 'Dati grezzi per il debug, visibili in modalità sviluppatore.',
                leaveLabel: 'Ferma, archivia o elimina',
                leaveFootnote: 'Fermare termina il processo in esecuzione. Le sessioni archiviate si possono ripristinare. Eliminare rimuove la sessione e i suoi messaggi per sempre.',
            },
            follow: {
                description: 'Scegli se questa sessione ti avvisa e parla tramite voce.',
            },
            permissions: {
                description: 'Strumenti che hai consentito da un altro dispositivo per questa sessione. Revoca quelli che non vuoi più.',
            },
            automations: {
                description: 'Lavoro eseguito in questa sessione secondo un programma, un evento o al termine di un turno.',
            },
            newRun: {
                description: 'Avvia un’esecuzione di un sub-agente da questa sessione.',
                transcriptReadOnly: 'Questa è una cronologia salvata. Riconnettiti a questo Home per continuare la conversazione.',
                daemonReadOnly: 'Questa cronologia proviene dal processo dell’Agent. Riconnettiti a questo Home per continuare la conversazione.',
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
>, "it"> = { it: {
        due: 'Promemoria attivo',
        title: 'Ricordamelo', inOneHour: 'Tra 1 ora', inThreeHours: 'Tra 3 ore',
        tomorrowMorning: 'Domani mattina', nextWeek: 'La prossima settimana', custom: 'Scegli data e ora…',
        customTitle: 'Scegli data e ora',
        customPlaceholder: '2026-09-08 09:00', futureTimeRequired: 'Scegli un orario futuro.',
        setReminder: 'Imposta promemoria',
        reminderSaved: 'Promemoria salvato',
        presetSaveFailedAfterReminder: 'Il promemoria è salvato, ma il salvataggio del preset non è stato confermato. Riprova oppure chiudi.',
        presetsSaveFailed: 'Il salvataggio dei preset non è stato confermato. Le modifiche sono conservate qui; riprova.',
        presetsChanged: 'I preset salvati differiscono dall’elenco aperto. Chiudi e riapri per controllare l’elenco attuale.',
        remove: 'Rimuovi promemoria',
        dateLabel: 'Data', timeLabel: 'Ora', addToPresets: 'Aggiungi ai preset', presetPreviewUnavailable: 'Scegli un orario futuro valido per vedere l’anteprima.', managePresets: 'Gestisci preset', managePresetsMessage: 'Rinomina, riordina o rimuovi i promemoria salvati.', presetName: 'Nome del preset', movePresetUp: 'Sposta in alto', movePresetDown: 'Sposta in basso', renamePresetLabel: ({ preset }) => `Rinomina «${preset}»`, movePresetUpLabel: ({ preset }) => `Sposta «${preset}» in alto`, movePresetDownLabel: ({ preset }) => `Sposta «${preset}» in basso`, deletePresetLabel: ({ preset }) => `Elimina «${preset}»`, noPresets: 'Nessun preset salvato', noPresetsMessage: 'Salvane uno quando scegli un promemoria personalizzato.',
    } };

return { sessionReminderTranslations };
})();

const Domain_sessionRemotePermissionGrantTranslations = (() => {
type SessionRemotePermissionGrantTranslations = Shared_sessionRemotePermissionGrantTranslations.SessionRemotePermissionGrantTranslations;

const sessionRemotePermissionGrantTranslations = { it: {
        title: 'Concessioni di autorizzazioni remote',
        entryTitle: 'Concessioni di autorizzazioni remote',
        entrySubtitle: 'Esamina e revoca le concessioni remote della sessione',
        loadingTitle: 'Caricamento delle concessioni remote',
        loadingReason: 'Verifica delle concessioni del proprietario attuale della sessione.',
        emptyTitle: 'Nessuna concessione remota',
        emptyReason: 'Questa sessione non ha concessioni remote da esaminare.',
        unavailableTitle: 'Concessioni remote non disponibili',
        unavailableReason: 'Verifica che questo sia il proprietario attuale della sessione e che la sua macchina sia disponibile, quindi riprova.',
        ownerOnlyTitle: 'Solo il proprietario della sessione può gestire le concessioni remote',
        ownerOnlyReason: 'I partecipanti condivisi possono rispondere alle richieste idonee, ma non possono esaminare o revocare le concessioni del proprietario della sessione.',
        retry: 'Riprova',
        listTitle: 'Concessioni della sessione',
        grantActive: ({ actor }) => `Concessione attiva da ${actor}`,
        grantRevoked: ({ actor }) => `Concessione revocata da ${actor}`,
        grantDetail: ({ grantId, sourceRef, sourceRevisionOrEpoch }) => `Concessione ${grantId} · Origine ${sourceRef} (${sourceRevisionOrEpoch})`,
        revoke: 'Revoca concessione',
        revoking: 'Revoca in corso…',
        revokeConfirmTitle: 'Revocare la concessione remota?',
        revokeConfirmBody: ({ identifier }) => `Questa azione revocherà immediatamente la concessione remota per ${identifier}.`,
        revokeFailedTitle: 'Impossibile aggiornare le concessioni remote',
        revokeFailedReason: 'La concessione potrebbe essere cambiata oppure la macchina del proprietario non è disponibile. Riprova.',
        loadMore: 'Carica altre concessioni',
        loadingMore: 'Caricamento di altre concessioni…',
        loadMoreFailedReason: 'Impossibile caricare altre concessioni. Riprova.',
    } } as const satisfies Pick<Readonly<Record<string, SessionRemotePermissionGrantTranslations>>, "it">;

return { sessionRemotePermissionGrantTranslations };
})();

const Domain_sessionResponsibilityTranslations = (() => {
type SessionResponsibilityTranslations = Shared_sessionResponsibilityTranslations.SessionResponsibilityTranslations;

const en = Shared_sessionResponsibilityTranslations.en;

const sessionResponsibilityTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionResponsibilityTranslations
>, "it"> = { it: {
        responsibilitySectionTitle: 'Responsabilità',
        responsibilityRowTitle: 'Responsabile',
        responsibilityNoOne: 'Nessuno',
        responsibilityUnnamedPerson: 'Persona senza nome',
        responsibilityPickerTitle: 'Scegli la persona responsabile',
        responsibilitySearchPlaceholder: 'Cerca persone con accesso',
        responsibilityAssignToMe: 'Assegna a me',
        responsibilityPeopleWithAccess: 'Persone con accesso',
        responsibilityAccessHintOwner: 'Proprietario',
        responsibilityNoCandidates: 'Per ora nessun altro può accedere a questa sessione.',
        responsibilityAccessChanged: 'L’accesso è cambiato. Questa persona non può più essere responsabile.',
        responsibilityUpdateFailed: 'Happier non è riuscito ad aggiornare la persona responsabile. Riprova.',
        responsibilityApprovalPending: 'In attesa di approvazione. Non è ancora cambiato nulla: la persona responsabile verrà aggiornata dopo l’approvazione.',
        responsibilityA11yEditable: ({ name }: { name: string }) =>
            `Persona responsabile, ${name}. Cambia la persona responsabile.`,
        responsibilityA11yReadOnly: ({ name }: { name: string }) => `Persona responsabile, ${name}.`,
        responsibilityA11yEmpty: 'Persona responsabile, nessuno. Cambia la persona responsabile.',
        responsibilityAssignedToYou: 'Assegnata a te',
        responsibilitySharedWithYou: 'Condivisa con te',
    } };

return { sessionResponsibilityTranslations };
})();

const Domain_sessionWorkTranslations = (() => {
const en = Shared_sessionWorkTranslations.en;

const it: typeof en = {
    scheduled: {
        title: "Programmato",
        writesHere: "Scrive qui",
        empty: "Nessun workflow è programmato per scrivere qui.",
        step: ({ ordinal, title }) => `passaggio ${ordinal} · ${title}`,
        provenanceWorkflowStep: ({ source, step }) => `Da ${source} · passaggio ${step}`,
        notifyOnlyReported: "Solo se l’agente ha segnalato qualcosa",
        notifyOnlyReportedDescription: "Salta la notifica quando l’agente non restituisce testo.",
        notifyOnlyReportedNeedsResult: "Usa come messaggio il risultato testuale di un passaggio Agent precedente.",
    },
    workerUpdate: {
        state: {
            settled: "ha finito il turno",
            needsYou: "ha bisogno di te",
            stalled: "in stallo",
            published: "pubblicato",
            failed: "non riuscito",
            stopped: "interrotto",
            timedOut: "tempo scaduto",
            finished: "terminato",
        },
        peek: "Anteprima",
        truncated: "Risultato abbreviato.",
        wokenBy: ({ count }) => (count === 1 ? 'Risvegliato da un aggiornamento' : `Risvegliato da ${count} aggiornamenti`),
        notFromYou: 'non è un tuo messaggio',
    },
    title: 'Lavoro',
    subtitle: {
        sessions: ({ count }) => (count === 1 ? '1 sessione' : `${count} sessioni`),
        runs: ({ count }) => (count === 1 ? '1 esecuzione' : `${count} esecuzioni`),
        nothingStarted: 'Ancora niente avviato',
    },
    states: {
        recent: 'Recenti',
    },
    view: {
        a11y: 'Vista del lavoro',
        list: 'Elenco',
        map: 'Mappa',
        expandMap: 'Apri la mappa accanto alla sessione',
    },
    map: {
        folded: "Il lavoro finito viene compresso",
        backgroundRuns: ({ count }) => (count === 1 ? "1 esecuzione in background" : `${count} esecuzioni in background`),
        positionUnder: ({ position, total, parent }) => `${position} di ${total} sotto ${parent}`,
    },
    actions: {
        showInTranscript: 'Mostra nella trascrizione',
        makeOrchestrator: 'Rendila un orchestratore',
        makeOrchestratorSubtitle: 'Questa sessione pianifica, delega e riferisce',
        makeOrchestratorFailed: "Impossibile rendere la sessione un orchestratore",
    },
    putUnder: {
        title: "Metti sotto…",
        subtitle: "Riferisci a un’altra sessione",
        search: "Trova una sessione",
        topLevel: "Livello superiore — non riferisce a nessuno",
        errors: {
            cycle: "Quella sessione riferisce già a questa",
            changed: "La sessione è appena stata spostata. Riprova",
            forbidden: "Non puoi metterla sotto quella sessione",
            failed: "Impossibile spostare la sessione",
        },
    },
    kinds: {
        session: 'Sessione',
        workflowRun: 'Esecuzione del workflow',
        backgroundRun: 'Esecuzione in background',
    },
    showMore: ({ count }) => `Mostra altri ${count}`,
    role: {
        none: 'Nessuno',
        handsOff: 'senza modifiche',
        a11y: ({ role }) => `Ruolo: ${role}. Cambia ruolo`,
    },
    empty: {
        title: 'Nessun lavoro avviato',
        reason: 'Le sessioni, i workflow e le esecuzioni in background avviati da questa sessione appariranno qui, insieme a tutto ciò che ha bisogno di te.',
    },
    row: {
        a11y: ({ title, status }) => `${title}, ${status}`,
    },
    progress: ({ completed, total }) => `${completed} di ${total}`,
    strip: {
        openInSidebar: 'Apri nella barra laterale',
        stillWorking: ({ count }) => `${count} ancora al lavoro`,
        needsYou: ({ count }) => `${count} ha${count === 1 ? '' : 'nno'} bisogno di te`,
        a11y: ({ summary }) => `Lavoro: ${summary}`,
    },
    leadArchived: ({ count }) => `Questa sessione è archiviata · ${count} ancora al lavoro`,
    runsStale: 'Le esecuzioni dei workflow potrebbero non essere aggiornate',
    list: {
        level: ({ level }) => `Livello ${level}`,
        subSessions: ({ count }) => (count === 1 ? '1 sottosessione' : `${count} sottosessioni`),
        showReports: ({ name, count }) => (count > 0 ? `Mostra ${count} sessioni sotto ${name}` : `Mostra le sessioni sotto ${name}`),
        hideReports: ({ name }) => `Nascondi le sessioni sotto ${name}`,
        reportsWorking: ({ count }) => `${count} al lavoro`,
        reportsNeedYou: ({ count }) => (count === 1 ? '1 sottosessione ha bisogno di te' : `${count} sottosessioni hanno bisogno di te`),
    },
    archive: {
        alsoArchiveReports: ({ count }) => (count === 1 ? 'Archivia anche 1 sottosessione' : `Archivia anche ${count} sottosessioni`),
        someNotArchivedTitle: ({ count }) => (count === 1 ? '1 sottosessione non è stata archiviata' : `${count} sottosessioni non sono state archiviate`),
    },
    step: {
        drivenBy: "Guidata da un workflow",
        partOf: ({ run }) => `Parte di ${run}`,
        checkedByWorkflow: "Il workflow controlla il risultato di questo passaggio, quindi trigger, obiettivi e secondi pareri non vengono eseguiti in questa sessione.",
        nothingStarted: "Questo passaggio non ha avviato nulla.",
    },
    invite: {
        orAskFor: "Oppure chiedi",
    },
    peek: {
        reportsTo: ({ lead }) => `Riferisce a ${lead}`,
        repliesGoHere: 'Le risposte vanno a questa sessione',
    },
};

const notify = { it: { turn: 'Avvisami quando termina questo turno', attention: 'Avvisami quando serve il mio intervento', armed: 'Riceverai una notifica', cancel: 'Annulla notifica', failed: 'Impossibile aggiornare la notifica. Riprova.', turnFinished: 'Il turno di questa sessione è terminato.', needsYou: 'Questa sessione ha bisogno di te.', settings: 'Impostazioni notifiche' } };

const runNotify = { it: { run: 'Avvisami quando termina', runFinished: 'Questa esecuzione è terminata.', runNeedsYou: 'Questa esecuzione ha bisogno di te.', setup: 'Configura notifiche' } };

const sessionWorkTranslations = { it: { ...it, notify: { ...notify.it, ...runNotify.it } } };

return { notify, runNotify, sessionWorkTranslations };
})();

const Domain_settingsConnectionsTranslations = (() => {
type MachineParams = Shared_settingsConnectionsTranslations.MachineParams;

const en = Shared_settingsConnectionsTranslations.en;

const it = {
    sectionTitle: 'Connessioni',
    sectionDescription: 'Come i tuoi dispositivi raggiungono le tue macchine.',
    directTitle: 'Connetti direttamente quando possibile',
    directOnDescription: 'Anteprime, viste dal vivo e trasferimenti di file passano direttamente tra i tuoi dispositivi quando si raggiungono, altrimenti attraverso Happier.',
    directOffDescription: 'Tutto passa attraverso Happier. Niente si connette direttamente alle tue macchine; sulla stessa rete è un po’ più lento.',
    serverDenied: 'Il server della tua Home fa passare tutto attraverso Happier, quindi qui non c’è nulla da scegliere.',
    machineSectionTitle: 'Connessione',
    machineTitle: ({ machine }: MachineParams) => `Connessione a ${machine}`,
    machineOptionDefault: 'Predefinito',
    machineOptionDirect: 'Direttamente',
    machineOptionRelay: 'Tramite Happier',
    machineDefaultDescription: ({ machine }: MachineParams) => `Segue il tuo account: direttamente quando ${machine} è raggiungibile, altrimenti tramite Happier.`,
    machineDefaultOffDescription: 'Segue il tuo account: sempre tramite Happier.',
    machineDirectDescription: ({ machine }: MachineParams) => `Direttamente quando ${machine} è raggiungibile, anche se il tuo account dice diversamente.`,
    machineRelayDescription: 'Sempre tramite Happier, anche sulla stessa rete.',
};

const settingsConnectionsTranslations = { it };

return { settingsConnectionsTranslations };
})();

const Domain_settingsMachinesTranslations = (() => {
const en = Shared_settingsMachinesTranslations.en;

const it: typeof en = {
    scopeChooseComputer: 'Scegli un computer',
    scopeSetUpComputer: 'Configura un computer',
    scopeOffline: ({ machine }: { machine: string }) => `${machine} è offline.`,
    defaultsTitle: "Impostazioni predefinite delle macchine",
    localVirtualMachines: "Macchine virtuali locali",
    runningOnly: "Cloud fatturato solo in esecuzione",
    stoppedBilled: "Cloud fatturato anche da fermo",
    billingUnknown: "Fatturazione sconosciuta",
    pageDescription: 'I computer su cui girano le tue sessioni e i pool che scelgono tra di essi.',
    thisComputerTitle: 'Questo computer',
    thisComputerRowSubtitle: 'Servizio in background e riga di comando',
    thisComputerPageDescription: 'Il servizio in background e la riga di comando di Happier su questo dispositivo.',
    setupSectionTitle: 'Configurazione',
    setupRowSubtitle: 'Installa Happier qui e collegalo alla tua Home.',
    addPageDescription: 'Collega un computer così gli agenti possono eseguirvi le tue sessioni.',
    addFromComputerTitle: 'Aggiungi macchine da un computer',
    addFromComputerDescription: 'Apri Happier sul computer da aggiungere, oppure collegane uno via SSH da Happier su desktop o nel browser.',
    searchPlaceholder: 'Cerca macchine',
    count: ({ count }: { count: number }) => (count === 1 ? '1 macchina' : `${count} macchine`),
    daemonTitle: 'Servizio in background',
    daemonDescription: 'Esegue le tue sessioni su questo computer e lo mantiene collegato alla tua Home.',
    unreadableTitle: ({ home }: { home: string }) => `Impossibile leggere le macchine di ${home}`,
};

const settingsMachinesTranslations = { it };

return { settingsMachinesTranslations };
})();

const Domain_settingsOverviewTranslations = (() => {
type SettingsOverviewTranslation = Shared_settingsOverviewTranslations.SettingsOverviewTranslation;

const slavicPlural = Shared_settingsOverviewTranslations.slavicPlural;

const settingsOverviewTranslations = { it: {
        attentionTitle: 'Richiede la tua attenzione',
        agentNeedsSignIn: ({ agent, machine }) => `${agent} richiede l'accesso su ${machine}`,
        agentNeedsSignInNoMachine: ({ agent }) => `${agent} richiede l'accesso`,
        serviceSignInExpired: ({ service }) => `L'accesso a ${service} è scaduto`,
        signIn: 'Accedi',
        signInAgain: 'Accedi di nuovo',
        setupTitle: 'Per iniziare',
        setupProgress: ({ done, total }) => `${done} di ${total}`,
        setupActionSaveKey: 'Salva chiave',
        setupActionAddMachine: 'Aggiungi macchina',
        setupActionShowQr: 'Mostra QR',
        setupActionScan: 'Scansiona',
        setupActionPasteLink: 'Incolla link',
        setupActionBrowse: 'Sfoglia',
        machineUpdateVersions: ({ current, latest }) => `Happier ${current} su questa macchina · ${latest} disponibile`,
        connectTerminalTitle: 'Collega un terminale',
        connectTerminalSubtitle: 'Scansiona il codice mostrato dal terminale o incolla il suo link.',
        quickSettingsTitle: 'Impostazioni rapide',
        notificationsPushOn: 'Push attive',
        notificationsPushOff: 'Push disattivate',
        notificationsQuietHours: 'Ore di silenzio attive',
        pluginChangesAwaitingReview: ({ count }) => count === 1 ? '1 modifica di plugin attende la tua revisione' : `${count} modifiche di plugin attendono la tua revisione`,
        review: 'Rivedi',
        browsePluginsTitle: 'Sfoglia i plugin',
        browsePluginsSubtitle: 'Aggiungi strumenti, pannelli e integrazioni a Happier.',
        accountServiceSignedIn: ({ service }) => `Accesso eseguito a ${service}`,
        aboutDescription: 'Versione, codice sorgente e termini legali (Happier non è affiliato ad Anthropic).',
        machinesTitle: 'Macchine',
        machineOnline: 'Online',
        machineOffline: ({ lastSeen }) => `Offline · visto ${lastSeen}`,
        machineUpdateAvailable: 'Aggiornamento disponibile',
        machinesOnlineCount: ({ count }) => `${count} online`,
        machinesOfflineCount: ({ count }) => `${count} offline`,
        machineLastSeen: ({ lastSeen }) => `visto ${lastSeen}`,
        update: 'Aggiorna',
        asOf: ({ time }) => `Alle ${time}`,
        usageTitle: 'Utilizzo',
        usageLeft: ({ percent }) => `${percent}% rimasto`,
        usageResets: ({ time }) => `si azzera ${time}`,
        securityTitle: 'Sicurezza',
        startSessionLabel: 'Avvia una sessione',
        saveRecoveryKeyTitle: 'Salva la chiave di recupero',
        saveRecoveryKeySubtitle: 'L’unico modo per tornare ai dati cifrati se perdi tutti i dispositivi.',
        addMachineTitle: 'Aggiungi una macchina',
        addMachineSubtitle: 'Collega un computer su cui girano i tuoi agenti.',
        homeGreetingNamed: ({ name }) => `Bentornato, ${name}.`,
        homeStartSection: 'Avvia una sessione',
        homeCustomize: 'Personalizza la home',
        homeCustomizeDescription: 'Scegli quali sezioni mostra la tua home e in che ordine.',
        homeAlwaysShown: 'Sempre visibile',
        homeShowSection: 'Mostra',
        homeHideSection: 'Nascondi sezione',
        homeSectionOptions: 'Opzioni della sezione',
        homeResetLayout: 'Ripristina predefiniti',
        homeLayoutSectionTitle: 'Home',
        homeAddWidgetsTitle: 'Aggiungi widget',
        homeAddWidgetsDescription: 'I widget offerti dai tuoi plugin. Aggiungine uno per mostrarlo nella tua home.',
        homeWidgetFromPlugin: ({ plugin }) => `Da ${plugin}`,
        homeRemoveWidget: 'Rimuovi dalla home',
    } } satisfies Pick<Readonly<Record<string, SettingsOverviewTranslation>>, "it">;

return { settingsOverviewTranslations };
})();

const Domain_settingsProfilesRemoteHostsPageTranslations = (() => {
const english = Shared_settingsProfilesRemoteHostsPageTranslations.english;

const translated = Shared_settingsProfilesRemoteHostsPageTranslations.translated;

const settingsProfilesRemoteHostsPageTranslations = { it: translated({
        settingsProfilesPage: {
            pageDescription: "Impostazioni di avvio per una nuova sessione: l'agente, il modello, le variabili d'ambiente e dove viene eseguita.",
            useProfilesSection: 'Scelta del profilo',
            useProfilesSectionDescription: "Scegli un profilo quando avvii una sessione, oppure avvia ogni sessione con l'ambiente della macchina.",
            useProfiles: 'Usa i profili',
            useProfilesOffDescription: "Disattivato. Le nuove sessioni usano l'ambiente della macchina.",
            favoritesDescription: 'Mostrati per primi quando scegli un profilo.',
            customDescription: 'I profili che hai creato. Modificando un profilo integrato qui viene salvata una tua copia.',
            builtInDescription: 'Profili pronti per ogni agente.',
        },
        settingsRemoteHostsPage: {
            pageDescription: 'Host SSH che questo computer può configurare come macchine, a cui può connettersi o su cui può eseguire un relay.',
            savedHostsSection: 'Host salvati',
            savedHostsDescription: "Prima i più usati di recente. Apri un host per usarlo o modificarlo.",
            hostPageDescription: "Un host SSH che questo computer può configurare come macchina, a cui può connettersi o su cui può eseguire un relay.",
            newHostTitle: "Nuovo host remoto",
            newHostDescription: "Dai un nome all'host e indica come raggiungerlo via SSH.",
            useSection: "Usa questo host",
            useSectionDescription: "Cosa può farci questo dispositivo.",
            maintenanceSection: "Happier su questo host",
            maintenanceSectionDescription: "Installa, aggiorna ed esegui lì la riga di comando, il servizio in background e il relay di Happier.",
            discard: "Scarta",
            accessTitle: "Chiavi e connessioni",
            accessRowSubtitle: "Chiavi host attendibili e tunnel aperti",
            accessPageDescription: "Le chiavi host di cui questo dispositivo si fida, e i tunnel e i percorsi di accesso aperti verso i tuoi host.",
            hostNotFound: "Questo host non è più salvato.",
            unavailableDescription: 'Gli host SSH salvati possono essere configurati come macchine o usati come relay.',
            trustedHostKeysDescription: 'Chiavi accettate da questo dispositivo durante la connessione. Rimuovine una per ricevere di nuovo la domanda la prossima volta.',
            trustedHostKeysEmpty: 'Nessuna chiave host attendibile per ora. Compaiono qui quando ne accetti una durante la connessione.',
            sshTunnelsDescription: 'Tunnel aperti da questo dispositivo verso un host salvato.',
        },
    }) };

return { settingsProfilesRemoteHostsPageTranslations };
})();

const Domain_settingsProvidersTranslations = (() => {


const withProviderSharedFields = Shared_settingsProvidersTranslations.withProviderSharedFields;

const it = {
    title: 'Provider', entrySubtitle: 'Collega fonti di modelli cloud e locali', detailTitle: 'Connessione provider', configuredTitle: 'I tuoi provider', configuredFooter: 'I modelli dei provider abilitati compaiono nei selettori degli agenti compatibili.', availableTitle: 'Disponibili', availableFooter: 'Aggiungi un provider una volta e usa i suoi modelli con ogni agente compatibile.', customTitle: 'Provider personalizzato', customFooter: 'Collega un gateway aziendale o un altro endpoint di modelli compatibile.', addCustom: 'Aggiungi provider personalizzato', addCustomDescription: 'Usa un endpoint compatibile con OpenAI o Anthropic', emptyTitle: 'Nessun provider ancora collegato', emptyDescription: 'Scegli un provider disponibile oppure aggiungi il tuo endpoint.', unavailable: 'I provider non sono disponibili', unavailableDescription: 'Questo server non ha abilitato le connessioni dei provider.', noMachine: 'Nessuna macchina disponibile', noMachineDescription: 'Collega una macchina per configurare e provare i provider.', problemTitle: 'Il provider richiede attenzione', searchPlaceholder: 'Cerca provider',
    status: { available: 'Collegato', notChecked: 'Non verificato', needsAttention: 'Richiede attenzione', unreachable: 'Non raggiungibile', disabled: 'Disattivato', sourceUnavailable: 'Plugin non disponibile' }, kind: { frontier: 'Provider di modelli', aggregator: 'Catalogo di modelli', cloud: 'Provider cloud', local: 'In esecuzione su questa macchina' },
    detail: { pickSecretTitle: 'Scegli una chiave API', notFoundTitle: 'Provider non trovato', notFoundDescription: 'Questa connessione del provider non esiste più.', deletedDescription: 'Questo provider è stato rimosso. Scegli un altro modello prima di riprendere le sessioni che lo usavano.', sourceAvailable: 'Plugin del provider disponibile', connectionTitle: 'Connessione', connectionFooter: 'Controlla dove usare questo provider e verificane lo stato.', accountAccess: 'Usa su tutte le macchine', accountAccessDescription: 'Disponibile ovunque il provider si risolva in un endpoint pubblico', testConnection: 'Verifica connessione', testDescription: 'Verifica l’endpoint e aggiorna il catalogo dei modelli', testSucceeded: 'Connessione riuscita', testNotSupported: 'Questo provider non supporta una verifica automatica della connessione', machinesTitle: 'Macchine', machinesFooter: 'Gli endpoint locali e privati vanno abilitati separatamente su ogni macchina.', currentMachine: 'Macchina attuale', selectMachineToManage: 'Seleziona questa macchina per controllarne e modificarne l’accesso', targetMachine: 'Macchina di destinazione', machineOnline: 'Online', machineOffline: 'Offline', apiKeyTitle: 'Chiave API', apiKeyFooter: 'Le chiavi restano nei Segreti salvati e non vengono mai mostrate qui.', accountApiKey: 'Chiave API predefinita', machineApiKey: 'Chiave API su questa macchina', apiKeyConfigured: 'Configurata', apiKeyMissing: 'Aggiungi una chiave per collegarti', apiKeySelected: 'Chiave salvata selezionata', useAccountApiKey: 'Usa la chiave predefinita se non è impostata una chiave per la macchina', modelsTitle: 'Modelli', manageModels: 'Gestisci modelli', modelsUnknown: 'I modelli compariranno dopo la connessione', modelCount: ({ count }: { count: number }) => `${count} ${count === 1 ? 'modello' : 'modelli'}`, actionsTitle: 'Azioni', duplicateTitle: 'Aggiungi un’altra connessione', duplicateDescription: 'Crea una connessione con un nome distinto allo stesso provider', deleteTitle: 'Rimuovi provider', deleteDescription: 'Le sessioni esistenti conservano la cronologia, ma non possono riprendere con questo provider.', advancedTitle: 'Avanzate', endpointDefault: 'Endpoint predefinito', endpointMachine: 'Endpoint su questa macchina', endpointMachineDescription: 'Sostituisci il valore predefinito solo dove questa macchina esegue il provider', endpointPrompt: 'Inserisci l’URL di base completo del provider.', resetEndpoint: 'Ripristina endpoint', resetMachineEndpoint: 'Usa l’endpoint predefinito su questa macchina', resetDefaultEndpoint: 'Usa l’endpoint fornito dal plugin del provider' },
    authoring: { providerTitle: 'Provider', builtInDescription: 'Scegli un Segreto salvato, poi collega il provider.', compatibilityTitle: 'Compatibilità', compatibilityFooter: 'Scegli lo stile API documentato dal provider.', protocolTitle: 'Compatibilità API', protocol: { 'openai-responses': { title: 'Compatibile con OpenAI Responses', description: 'Per gateway che implementano l’API Responses' }, 'openai-chat': { title: 'Compatibile con OpenAI Chat', description: 'Per gateway che implementano Chat Completions' }, anthropic: { title: 'Compatibile con Anthropic', description: 'Per gateway che implementano l’API Messages' } }, detailsTitle: 'Dettagli del provider', name: 'Nome', namePlaceholder: 'Gateway aziendale', baseUrl: 'URL di base', baseUrlPlaceholder: 'https://gateway.example.com/v1', modelsPath: 'Percorso dei modelli', credentialsTitle: 'Credenziali', credentialsFooter: 'Seleziona un Segreto salvato. Non incollare mai una chiave API nell’URL o nelle intestazioni.', requiresApiKey: 'Richiede una chiave API', requiresApiKeyYes: 'Usa un Segreto salvato per le richieste', requiresApiKeyNo: 'Collega senza credenziali', apiKey: 'Chiave API', apiKeyDescription: 'Scegli o crea un Segreto salvato', credentialStyleTitle: 'Formato della chiave API', credentialHeader: 'Nome intestazione', credentialStyle: { bearer: 'Token bearer Authorization', xApiKey: 'Intestazione x-api-key', apiKey: 'Intestazione api-key', customHeader: 'Intestazione personalizzata' }, catalogTitle: 'Catalogo dei modelli', catalogFooter: 'Recupera automaticamente i modelli quando l’endpoint lo consente, oppure aggiungili manualmente in seguito.', fetchModels: 'Recupera automaticamente i modelli', fetchModelsYes: 'Usa l’endpoint con l’elenco dei modelli del provider', fetchModelsNo: 'Aggiungi manualmente gli ID dei modelli', verifyTitle: 'Collega', verifyFooter: 'Quando possibile, verifica prima e poi salva il provider.', save: 'Salva provider', connect: 'Collega provider' },
    errors: { machineOfflineTitle: "Questa macchina è offline", machineOfflineDescription: "I provider vengono verificati su una macchina. Scegline un’altra o avviala, poi riprova.", machineTimeoutTitle: "Questa macchina non ha risposto", machineTimeoutDescription: "Questa macchina non ha risposto durante la verifica dei provider. Riprova.", runCredentialRequiredTitle: "Scegli una credenziale per questo Run", runCredentialRequiredDescription: "Questo Run non può ereditare la credenziale diretta della sessione. Scegli una credenziale del Team per il Run.", secretMissingTitle: 'Chiave API necessaria', secretMissingDescription: 'Scegli un Segreto salvato prima di abilitare questo provider.', notEnabledOnMachineTitle: 'Non abilitato su questa macchina', notEnabledOnMachineDescription: 'Abilita il provider sulla macchina in cui verrà eseguita la sessione.', disabledTitle: 'Il provider è disattivato', disabledDescription: 'Abilita il provider prima di usarne i modelli.', unreachableTitle: 'Il provider non è raggiungibile', unreachableDescription: 'Controlla che il servizio sia in esecuzione e che l’endpoint sia corretto, poi riprova.', notFoundTitle: 'Provider non trovato', notFoundDescription: 'Questo provider è stato rimosso. Scegli un altro provider o modello.', sourceUnavailableTitle: 'Plugin del provider non disponibile', sourceUnavailableDescription: 'Riabilita o reinstalla il plugin che fornisce questa connessione.', featureDisabledTitle: 'I provider non sono disponibili', featureDisabledDescription: 'Questo server non ha abilitato le connessioni dei provider.', unauthorizedTitle: 'Chiave API rifiutata', unauthorizedDescription: 'Sostituisci il Segreto salvato con una chiave valida, poi verifica di nuovo la connessione.', rateLimitedTitle: 'Limite di richieste del provider', rateLimitedDescription: 'Attendi un momento, poi verifica di nuovo la connessione.', probeCapacityTitle: 'Troppe verifiche del provider contemporaneamente', probeCapacityDescription: 'Happier non è ancora riuscito ad avviare questa verifica sulla macchina selezionata. Attendi un momento, poi riprova.', genericTitle: 'Il provider richiede attenzione', genericDescription: 'Controlla le impostazioni del provider e riprova.' },
    models: { builtIn: 'Integrato', experimental: 'Sperimentale', experimentalConfirmTitle: 'Usare un modello sperimentale?', experimentalConfirmBody: ({ provider, model }: { provider: string; model: string }) => `${model} di ${provider} non è ancora stato verificato completamente con questo agente. Se non funziona come previsto, potrebbe essere necessario riavviare o scegliere un altro modello.`, experimentalConfirmAction: 'Usa modello', stale: 'Potrebbe non essere disponibile', hidden: 'Nascosto', manage: 'Gestisci modelli', empty: 'Non sono ancora disponibili modelli per questo provider.', add: 'Aggiungi modelli', addPlaceholder: 'Inserisci un ID modello per riga', resetVisibility: 'Ripristina visibilità', showHidden: 'Mostra modelli nascosti', hideHidden: 'Nascondi modelli nascosti', remove: 'Rimuovi modello', removeConfirmation: 'Rimuovere questo modello aggiunto manualmente?', enable: 'Mostra modello', disable: 'Nascondi modello', load: 'Carica modello', retry: 'Riprova', connectionUnavailable: 'Questo provider non è disponibile sulla macchina selezionata.' },
};

const localTranslations = { it: { title: 'Su questa macchina', footer: 'Servizi trovati su questa macchina. Il luogo di esecuzione dei modelli dipende dal servizio.', detected: 'Rilevato', possible: 'Possibile servizio', detectedAtPort: ({ port }: { port: string }) => `Rilevato · Porta ${port}`, possibleAtPort: ({ provider, port }: { provider: string; port: string }) => `Possibile servizio ${provider} · Porta ${port}`, addConnectionTitle: 'Aggiungi un’altra connessione locale', addConnectionDescription: 'Assegna un nome per distinguerla dagli altri endpoint locali.', defaultConnectionName: ({ provider }: { provider: string }) => `${provider} locale` } } as const;

const providerManagedDeploymentTranslations = { it: {
        configureManaged: 'Esegui sessioni con un servizio locale gestito',
        configureManagedDescription: 'Scegli l’account connesso o il gruppo per le sessioni future. Happier avvia il servizio quando serve.',
        subscriptionPolicyTitle: 'L’instradamento degli abbonamenti è sperimentale',
        subscriptionPolicyDescription: 'Le politiche o l’applicazione del provider originale possono cambiare e interromperne il funzionamento. Happier mostra il rifiuto e non usa silenziosamente un’altra credenziale.',
        accountScopeMismatchTitle: 'Gli account collegati sono sul server attivo',
        accountScopeMismatchDescription: 'Questo provider è gestito su una macchina di un altro server. Passa a quel server per sceglierne l’account collegato o il gruppo.',
        editManagedDefaults: 'Modifica valori delle sessioni gestite',
        editManagedDefaultsDescription: 'Cambia l’account connesso o il gruppo per le sessioni future. Le sessioni esistenti conservano la selezione.',
        purposeTargetTitle: 'Destinazione account connesso',
        purposeTargetDescription: 'Scegli un account connesso o un gruppo disponibile per questo scopo.',
        invalidPurposeTargetTitle: 'Destinazione account non valida',
        invalidPurposeTargetDescription: 'Scegli un account connesso o un gruppo disponibile prima di salvare.',
        useExternal: 'Usa un servizio esterno',
        useExternalDescription: 'Interrompi la gestione del provider per le sessioni future e usa la configurazione endpoint esterna.',
        useExternalConfirmTitle: 'Usare un servizio esterno?',
        useExternalConfirmDescription: 'I valori gestiti vengono rimossi. Le sessioni esistenti conservano le selezioni.',
    } } as const;

const copyNameTranslations = { it: ({ name }: { name: string }) => `Copia di ${name}` } as const;

const providerSharedFieldTranslations = { it: {
        local: { installedNotRunning: 'Installato, ma non in esecuzione', appRunningServerOff: 'L’app è aperta, ma il server locale è disattivato', startManaged: ({ provider }: { provider: string }) => `Avvia ${provider}`, startedByHappier: 'Avviato da Happier', runningOutsideHappier: 'In esecuzione fuori da Happier' },
        apiKeyOptionalDescription: 'Facoltativa: scegli un Segreto salvato se questo provider ne richiede uno',
        models: { addDescription: 'Aggiungi ID modello che il provider non elenca automaticamente', addHelp: 'Inserisci un ID modello esatto per riga. I modelli esistenti vengono ignorati.', addFieldLabel: 'ID modello', invalidModelIds: ({ ids }: { ids: string }) => `Questi ID modello non sono validi: ${ids}`, noNewModels: 'Nessun nuovo ID modello da aggiungere.', providerManagedTitle: 'I modelli sono gestiti da questo provider', providerManagedDescription: 'Aggiorna il catalogo del provider per rinnovare l’elenco. Gli ID modello manuali non sono supportati.', showAll: 'Mostra tutti i modelli', hideAll: 'Nascondi tutti i modelli', hideAllConfirmation: 'Nascondere tutti i modelli in questo elenco? Puoi mostrarli di nuovo in qualsiasi momento.', showOnly: 'Mostra solo questo modello', showOnlyConfirmation: 'Nascondere tutti gli altri modelli in questo elenco? Puoi ripristinarli in qualsiasi momento.' },
    } } as const;

const providerFirstSessionValidationTranslations = { it: 'Happier verificherà la connessione in modo sicuro all’avvio della prima sessione che la usa.' } as const;

const providerMigrationTranslations = { it: { reviewTitle: 'Rivedi migrazione provider', reviewFooter: 'Controlla endpoint, formato API, credenziale e modelli prima di applicare le modifiche.', legacyProfileDescription: 'Questo profilo mantiene il routing precedente finché non confermi la revisione.', credentialTitle: 'Credenziale', credentialFooter: 'Viene spostato solo il riferimento al Segreto salvato; il valore non viene mostrato o copiato.', noCredential: 'Nessuna chiave API', credentialMoveDescription: 'Sposta questa credenziale nella nuova connessione', noCredentialDescription: 'Crea la connessione senza credenziali', actionsTitle: 'Migrazione', preview: 'Rivedi modifiche', previewDescription: 'Convalida la configurazione senza modificare le impostazioni', confirm: 'Crea connessione provider', confirmDescription: 'Applica le modifiche in modo atomico e conserva le preferenze di avvio', reviewAction: 'Rivedi migrazione provider', reviewActionDescription: 'Sposta endpoint e modelli precedenti in una connessione', retainedTitle: 'Configurazione precedente mantenuta', retainedDescription: 'Rimane disponibile finché non potrà essere migrata senza perdere funzionalità.' } } as const;

const providerMigrationPreviewTranslations = { it: { willMoveTitle: 'Verrà spostato nel provider', willMoveFooter: 'Vengono spostati solo questi nomi di routing e credenziali. I valori segreti non vengono mai mostrati.', willKeepTitle: 'Rimarrà nel profilo di avvio', willKeepFooter: 'Queste impostazioni riservate all’avvio rimangono nel profilo dopo la migrazione.', permissionDefaults: 'Autorizzazioni predefinite', persistenceDefaults: 'Archiviazione sessione predefinita' } } as const;

const providerMigrationConflictTranslations = { it: { conflictReviewTitle: 'Risolvi conflitto di migrazione', conflictReviewFooter: 'Scegli se mantenere la connessione esistente o salvare questo profilo come connessione separata. I valori segreti non vengono mostrati.', conflictCredential: 'La credenziale salvata è diversa', conflictModels: 'Le impostazioni dei modelli sono diverse', conflictEditedConnection: 'La connessione esistente è stata modificata', keepExisting: 'Mantieni connessione esistente', keepExistingDescription: 'Mantieni credenziali e modelli attuali e completa la migrazione senza sostituirli.', modelOutcomeTitle: 'Scegli quale modello mantenere', modelOutcomeFooter: 'Controlla il modello esatto prima di completare la migrazione. Nulla cambia finché non scegli.', useExistingModel: 'Usa il modello attuale della connessione', useExistingModelDescription: 'Mantieni il modello già selezionato per questa connessione provider.', preserveLegacyModel: 'Usa il modello del profilo', preserveLegacyModelDescription: 'Sposta la scelta esatta del profilo nella connessione esistente.', discardLegacyModel: 'Rimuovi la scelta del modello del profilo', discardLegacyModelDescription: 'Completa la migrazione senza la selezione o il preferito del modello di questo profilo.', createNamed: 'Crea connessione separata', createNamedDescription: 'Conserva le impostazioni provider di questo profilo in una nuova connessione.', separateConnectionName: 'Nome connessione', conflictReviewAction: 'Risolvi conflitto provider', conflictReviewActionDescription: 'Scegli come conservare credenziali o modelli in conflitto' } } as const;

const providerCredentialSelectionRequiredTranslations = { it: 'Scegli quale credenziale salvata deve usare questa connessione provider' } as const;

const providerLinkTranslations = { it: { providerWebsite: 'Sito web del provider', getApiKey: 'Ottieni chiave API', failedToOpen: 'Happier non è riuscito ad aprire questo link.' } } as const;

const providerCredentialFormatSelectionRequiredTranslations = { it: 'Scegli come inviare questa credenziale' } as const;

const providerReservedEnvironmentValidationUnavailableTranslations = { it: 'Collega questo editor di profili a una macchina disponibile prima di modificare le variabili di ambiente.' } as const;

const providerAdvancedAuthoringTranslations = { it: { advancedSetup: 'Configurazione avanzata', advancedSetupEnabled: 'Configura più stili API, intestazioni e verifiche sicure dei modelli', advancedSetupDisabled: 'Usa un comune endpoint compatibile', endpointEnabled: 'Usa questo stile API', endpointEnabledDescription: 'Rendi disponibile questo endpoint agli agenti compatibili', endpointDisabledDescription: 'Questo stile API non verrà usato', publicHeaders: 'Intestazioni pubbliche della richiesta', publicHeadersPlaceholder: 'X-Tenant: engineering', optionalProbePath: 'Percorso elenco modelli (facoltativo)', probeParserTitle: 'Formato risposta', probeParser: { openaiModels: 'Elenco modelli compatibile OpenAI', ollamaTags: 'Tag Ollama', lmStudioNative: 'Elenco modelli nativo LM Studio' } } } as const;

const providerCustomBearerHeaderTranslations = { it: 'Intestazione personalizzata (token Bearer)' } as const;

const providerNonSecretHeaderTranslations = { it: 'Intestazioni non segrete' } as const;

const providerProbePathsTranslations = { it: 'Percorsi elenco modelli (facoltativi, uno per riga)' } as const;

const providerLocalAuthoringTranslations = { it: { enableAfterSaving: 'Abilita questo provider', enableOnCurrentMachine: 'Abilita solo su questa macchina dopo il salvataggio', enableAccountWide: 'Abilita dopo il salvataggio', localAddressTitle: 'Indirizzo locale', localAddressDescription: ({ machine, endpoint }: { machine: string; endpoint: string }) => `Abilita separatamente su ogni macchina. ${machine} userà ${endpoint}.` } } as const;

const providerAuthoringReviewTranslations = { it: { destinationReview: 'Destinazione della connessione', destinationLoading: 'Risoluzione della destinazione esatta nel daemon…', destinationSelection: 'Scegli una destinazione', destinationSelectionDescription: 'Controlla l’indirizzo esatto prima di connetterti.', destinationScope: 'Ambito della destinazione', destinationMachine: 'Questa macchina', destinationAccount: 'Account' } } as const;

const providerCompatibilityTranslations = { it: { title: 'Compatibile con', footer: 'La compatibilità è verificata da ogni integrazione agente e può variare per modello.', verified: 'Verificato', experimental: 'Sperimentale', incompatible: 'Incompatibile', verifiedDescription: 'Testato con questa integrazione agente', experimentalDescription: 'Potrebbe funzionare, ma va verificato prima del primo utilizzo', incompatibleDescription: 'Questo agente non può usare la connessione in sicurezza' } } as const;

const providerModelNotLoadedTranslations = { it: 'Non caricato · potrebbe caricarsi al primo utilizzo' } as const;

const providerModelLoadCancellationTranslations = { it: { cancelLoad: 'Annulla caricamento', loadCancelled: 'Attesa del modello interrotta', loadCancelledProviderMayContinue: 'Il provider potrebbe continuare a caricarlo. Aggiorna il catalogo più tardi per verificare un eventuale completamento; Happier non ripeterà il caricamento.' } } as const;

const providerPartialStatusTranslations = { it: 'Parzialmente disponibile' } as const;

const providerConnectedServiceSuppressedTranslations = { it: 'L’accesso nativo dell’agente non viene usato con questo provider. La selezione salvata non cambia.' } as const;

const providerMachineCleanupPendingTranslations = { it: 'La macchina è stata rimossa, ma non è stato possibile salvare la pulizia dell’accesso ai provider. Controlla la connessione e rimuovi di nuovo la macchina per riprovare.' } as const;

const providerConnectionChangedTranslations = { it: { title: 'La connessione del provider è cambiata', description: 'Ricarica le impostazioni attuali del provider e riprova.' } } as const;

const providerModelSectionTranslations = { it: { available: 'Disponibili', manual: 'Manuale' } } as const;

const providerCompletenessTranslations = { it: {
        searchEmptyTitle: 'Nessun provider corrisponde alla ricerca',
        searchEmptyDescription: 'Prova un altro nome di provider o connessione.',
        compatibilityReasons: {
            noCompatibleProtocol: 'Questo agente e il provider non condividono alcun protocollo API supportato.',
            noAuthUnsupported: 'Questo agente richiede l’invio di una chiave API per questo provider.',
            credentialTransportUnavailable: 'Questo agente non supporta il metodo configurato per inviare la chiave API.',
            optionalCredentialNoAuthUnsupported: 'Questo agente non può usare il provider senza la chiave API facoltativa.',
            capabilityUnsupported: 'Una funzionalità obbligatoria del provider non è supportata.',
            capabilityUnknown: 'Una funzionalità obbligatoria del provider non è ancora stata verificata.',
            modelEvidenceRequired: 'Scegli un modello per verificarne le funzionalità richieste.',
            modelCapabilityUnsupported: 'Il modello non supporta una funzionalità obbligatoria.',
            modelCapabilityUnknown: 'Una funzionalità obbligatoria del modello non è ancora stata verificata.',
            overrideIncompatible: 'La verifica del provider indica che questa integrazione è incompatibile.',
            overrideExperimental: 'La verifica del provider indica che questa integrazione è sperimentale.',
            evidenceMissing: 'Non sono ancora state registrate prove di compatibilità.',
            agentUnsupported: 'Questo agente non supporta provider di modelli esterni.',
            adapterInvalid: 'Non è stato possibile convalidare l’adattatore del provider dell’agente.',
            unknown: 'Una condizione di compatibilità più recente richiede una verifica.',
        },
        unsavedDescription: 'Eliminare questa bozza del provider? I Segreti salvati sono oggetti condivisi dell’account e resteranno disponibili.',
        recoveryActions: {
            reviewFeatures: 'Controlla la disponibilità dei provider',
            chooseConnection: 'Scegli provider',
            restorePlugin: 'Controlla plugin',
            enableConnection: 'Abilita provider',
            reviewAccountGrant: 'Controlla accesso account',
            enableOnMachine: 'Abilita sulla macchina',
            reviewMachineGrant: 'Controlla accesso macchina',
            reviewCompatibility: 'Controlla compatibilità',
            addSecret: 'Aggiungi chiave API',
            reviewCredentialTransport: 'Controlla supporto credenziali',
            reviewConnection: 'Controlla connessione',
            retry: 'Riprova',
            replaceSecret: 'Sostituisci chiave API',
            chooseModel: 'Scegli modello',
            loadModel: 'Carica modello',
            reviewAndRestart: 'Controlla e riavvia',
            restartProbe: 'Verifica di nuovo',
            reduceProviderSettings: 'Gestisci impostazioni provider',
            reviewProfileMigration: 'Controlla migrazione profilo',
            reviewCurrentState: 'Controlla impostazioni attuali',
        },
        hiddenForAllAgents: 'Nascosto per tutti gli agenti · Gestisci nelle impostazioni Provider',
    } } as const;

const providerAvailabilityTranslations = { it: {
        availabilityChecking: 'Verifica della disponibilità dei provider', availabilityCheckingDescription: 'Happier sta verificando se questo server supporta le connessioni ai provider.',
        availabilityProblem: 'Impossibile verificare la disponibilità dei provider', availabilityProblemDescription: 'Happier riproverà automaticamente. Se il problema persiste, controlla la connessione al server.',
        availabilityUnsupported: 'I provider richiedono un aggiornamento del server', availabilityUnsupportedDescription: 'Questa versione del server non supporta le connessioni ai provider.',
        availabilityContextUnsupported: 'I provider non sono supportati in questo contesto', availabilityContextUnsupportedDescription: 'La configurazione o selezione corrente del server non supporta le connessioni ai provider.',
        availabilityPolicyDisabled: 'I provider sono disattivati da una policy', availabilityPolicyDisabledDescription: 'Una policy locale o di build ha disattivato le connessioni ai provider.',
    } } as const;

const settingsProvidersTranslations = { it: withProviderSharedFields(it, {
        providerAvailabilityTranslations: providerAvailabilityTranslations.it,
        providerLinkTranslations: providerLinkTranslations.it,
        providerCompletenessTranslations: providerCompletenessTranslations.it,
        providerPartialStatusTranslations: providerPartialStatusTranslations.it,
        providerMachineCleanupPendingTranslations: providerMachineCleanupPendingTranslations.it,
        providerConnectionChangedTranslations: providerConnectionChangedTranslations.it,
        providerCompatibilityTranslations: providerCompatibilityTranslations.it,
        providerMigrationTranslations: providerMigrationTranslations.it,
        providerMigrationPreviewTranslations: providerMigrationPreviewTranslations.it,
        providerMigrationConflictTranslations: providerMigrationConflictTranslations.it,
        providerCredentialSelectionRequiredTranslations: providerCredentialSelectionRequiredTranslations.it,
        providerCredentialFormatSelectionRequiredTranslations: providerCredentialFormatSelectionRequiredTranslations.it,
        providerReservedEnvironmentValidationUnavailableTranslations: providerReservedEnvironmentValidationUnavailableTranslations.it,
        localTranslations: localTranslations.it,
        providerSharedFieldTranslations: providerSharedFieldTranslations.it,
        providerManagedDeploymentTranslations: providerManagedDeploymentTranslations.it,
        copyNameTranslations: copyNameTranslations.it,
        providerFirstSessionValidationTranslations: providerFirstSessionValidationTranslations.it,
        providerAdvancedAuthoringTranslations: providerAdvancedAuthoringTranslations.it,
        providerLocalAuthoringTranslations: providerLocalAuthoringTranslations.it,
        providerAuthoringReviewTranslations: providerAuthoringReviewTranslations.it,
        providerNonSecretHeaderTranslations: providerNonSecretHeaderTranslations.it,
        providerProbePathsTranslations: providerProbePathsTranslations.it,
        providerCustomBearerHeaderTranslations: providerCustomBearerHeaderTranslations.it,
        providerModelSectionTranslations: providerModelSectionTranslations.it,
        providerModelLoadCancellationTranslations: providerModelLoadCancellationTranslations.it,
        providerModelNotLoadedTranslations: providerModelNotLoadedTranslations.it,
        providerConnectedServiceSuppressedTranslations: providerConnectedServiceSuppressedTranslations.it,
    }) } as const;

return { localTranslations, providerManagedDeploymentTranslations, copyNameTranslations, providerSharedFieldTranslations, providerFirstSessionValidationTranslations, providerMigrationTranslations, providerMigrationPreviewTranslations, providerMigrationConflictTranslations, providerCredentialSelectionRequiredTranslations, providerLinkTranslations, providerCredentialFormatSelectionRequiredTranslations, providerReservedEnvironmentValidationUnavailableTranslations, providerAdvancedAuthoringTranslations, providerCustomBearerHeaderTranslations, providerNonSecretHeaderTranslations, providerProbePathsTranslations, providerLocalAuthoringTranslations, providerAuthoringReviewTranslations, providerCompatibilityTranslations, providerModelNotLoadedTranslations, providerModelLoadCancellationTranslations, providerPartialStatusTranslations, providerConnectedServiceSuppressedTranslations, providerMachineCleanupPendingTranslations, providerConnectionChangedTranslations, providerModelSectionTranslations, providerCompletenessTranslations, providerAvailabilityTranslations, settingsProvidersTranslations };
})();

const Domain_settingsSearchKeywordsTranslations = (() => {
const english = Shared_settingsSearchKeywordsTranslations.english;

const translated = Shared_settingsSearchKeywordsTranslations.translated;

const settingsSearchKeywordsTranslations = { it: translated({
        settingsSearchKeywords: {
            settings: 'impostazioni, home, panoramica',
            groupProfileAndAccount: 'account, profilo, fatturazione, piano, utilizzo',
            account: 'account, profilo, fatturazione',
            accountSecurity: 'sicurezza, password, recupero, crittografia, esci',
            apiTokens: 'token api, token di accesso personale, pat, automazione, cli, sdk',
            teams: 'team, membri, gruppi, inviti',
            homeAdministration: 'home, amministrazione, governance, persone, criteri',
            secrets: 'segreti, chiavi, env, token',
            usage: 'utilizzo, fatturazione, limiti, quota',
            machines: 'macchine, dispositivi, computer',
            machinePoolsNew: 'pool di macchine, pool, riserva, esegui su',
            machinesAdd: 'aggiungi, macchina, ssh',
            machinesThisComputer: 'questo computer, locale, dispositivo',
            remoteHosts: 'remoto, host, ssh, server, macchine',
            groupGeneral: 'generale, aspetto, lingua, esperimenti',
            appearance: 'aspetto, tema, carattere, interfaccia, barra laterale',
            keyboard: 'tastiera, scorciatoia, scorciatoie, tasti rapidi, comandi',
            pets: 'animali, blink, compagno, codex',
            language: 'lingua, località, traduzione',
            features: 'funzionalità, esperimenti, beta',
            groupAiAndAgents: 'agenti, provider, mcp, prompt, voce',
            agents: 'provider, agenti, modelli, llm',
            providers: 'provider, fornitori, modelli, openrouter, ollama, lm studio',
            subAgent: 'sottoagenti, agenti, delega, regole',
            roles: 'ruoli, orchestratore, costruttore, revisore, istruzioni',
            delegation: 'delega, profondità, passaggio, orchestratore',
            profiles: 'profili, personaggi',
            connectedServices: 'servizi collegati, oauth, account',
            mcp: 'mcp, strumenti, server, plugin',
            plugins: 'plugin, marketplace, catalogo, descrittore, scoperta',
            prompts: 'prompt, modelli, libreria',
            promptsTemplates: 'modelli',
            promptsFolders: 'cartelle',
            promptsStacks: 'pile',
            promptsRegistries: 'registri',
            promptsLibrary: 'libreria',
            promptsAssets: 'risorse, esterno',
            voice: 'voce, assistente, microfono',
            voiceConversations: 'voce, conversazione, tempo reale, provider',
            voiceDictation: 'voce, dettatura, parlato, trascrizione',
            voicePrivacy: 'voce, privacy, cronologia, conservazione',
            voiceAdvanced: 'voce, avanzate, macchina, diagnostica',
            memory: 'memoria, ricerca, indice',
            groupSessionsBehavior: 'sessioni, trascrizione, permessi, azioni',
            session: 'sessione, terminale, tmux',
            externalSessions: 'sessioni esterne, segui in background, hook',
            actions: 'azioni, approvazioni, scorciatoie',
            embeds: 'incorporamenti, incorporare, iframe, widget, sito web, chat',
            transcript: 'trascrizione, chat, layout',
            permissions: 'permessi, approvazione, sicurezza',
            toolRendering: 'strumenti, visualizzazione',
            handoff: 'passaggio, trasferimento',
            runs: 'esecuzioni, esecuzione',
            groupFilesAndSourceControl: 'file, controllo versione, allegati',
            sourceControl: 'git, scm, controllo versione',
            attachments: 'allegati, caricamenti, file',
            groupSystem: 'sistema, server, stato, notifiche',
            servers: 'server, relay',
            systemStatus: 'stato del sistema, salute, diagnostica',
            updates: 'aggiornamenti, aggiornare, versione, cli, riavviare',
            notifications: 'notif, notifica, notifiche, push',
            notificationsPush: 'push, notifiche push',
            desktop: 'desktop, tauri, overlay, finestra',
            diagnosis: 'diagnosi, debug',
            reportIssue: 'segnala un problema, bug',
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
>, "it"> = { it: {
        settingsSessionPages: {
            preview: {
                userMessage: 'Sistema il test di riconnessione instabile',
                agentReply: 'Trovato: il timer dei tentativi non veniva mai azzerato. Sistemato, il test passa.',
                thinking: 'Il test fallisce solo dopo un timeout, quindi il timer dei tentativi è probabilmente ancora attivo.',
            },
            runtime: {
                pageDescription: 'Come vengono eseguite le sessioni sulle tue macchine.',
                terminalSection: 'Terminale',
                terminalHostTitle: 'Host terminale per le nuove sessioni',
                terminalHostNone: 'Nessuno',
                tmuxTitle: 'Avvia le sessioni in tmux',
                tmuxOn: 'Le nuove sessioni si aprono in una finestra tmux dedicata, così puoi collegarti da un terminale.',
                tmuxOff: 'Le nuove sessioni girano in una shell normale.',
            },
            wizard: {
                pageDescription: 'Come la procedura guidata per le nuove sessioni dispone i suoi passaggi.',
                wideScreensSection: 'Schermi larghi',
                stepsSection: 'Come ogni passaggio mostra le sue scelte',
                steps: {
                    profiles: 'Profilo',
                    backends: 'Agente',
                    models: 'Modello',
                    machines: 'Macchina',
                    paths: 'Cartella',
                    permissions: 'Permessi',
                },
            },
            providerLimits: {
                pageDescription: 'Cosa succede quando si raggiunge il limite di utilizzo di un account e quanta quota ti resta.',
                recoveryDescription: 'Quando un agente raggiunge il limite di utilizzo, la sessione può attendere il ripristino e continuare.',
                resumePromptCustom: 'Personalizzato',
                unavailableTitle: 'Non disponibile in questo Home',
                unavailableDescription: 'Il recupero dopo il limite di utilizzo e l’indicatore di utilizzo non sono attivi in questo Home.',
            },
            resume: {
                pageDescription: 'Come prosegue una sessione inattiva quando il suo agente non riesce a riprenderla da solo.',
                strategyRecent: 'Messaggi recenti',
                strategySummary: 'Riepilogo + recenti',
                maxSeedCharsTitle: 'Limite di dimensione del replay',
                summaryModelSection: 'Modello per il riepilogo',
                summaryModelDescription: 'L’agente e il modello che scrivono il riepilogo riproposto nella nuova sessione.',
                handoffSection: 'Spostare le sessioni',
                handoffLinkDescription: 'Cosa si sposta con una sessione quando la passi a un’altra macchina.',
            },
            permissions: {
                duringSessionSection: 'Durante una sessione',
                duringSessionDescription: 'Dove compaiono le richieste di approvazione e quando una modifica ai permessi di una sessione in corso ha effetto.',
                promptSurfaceComposer: 'Vicino al compositore',
                applyImmediately: 'Subito',
                applyNextMessage: 'Messaggio successivo',
                storageUseDefault: 'Predefinito',
            },
            handoff: {
                pageDescription: 'Cosa si sposta con una sessione quando la passi a un’altra macchina.',
                workspaceSection: 'File dello spazio di lavoro',
                workspaceDescription: 'Cosa succede alla cartella del progetto quando una sessione passa a un’altra macchina.',
                keepUpdated: 'Mantieni aggiornato',
                advancedModeDescription: 'Sostituisce la scelta qui sopra. Attenzione: i file possono essere rimossi o sovrascritti.',
                ignoredExclude: 'Escludi',
                ignoredIncludeSelected: 'Includi selezionati',
            },
            toolRendering: {
                pageDescription: 'Dai a singoli strumenti più o meno dettagli rispetto al valore predefinito della trascrizione.',
                collapsedDescription: 'Quanto mostra ogni strumento nella trascrizione prima di aprirlo.',
            },
            transcript: {
                advancedTitle: 'Prestazioni e tempi',
                advancedPageDescription: 'Streaming, tempi delle animazioni e soglie di scorrimento. I valori predefiniti vanno bene per quasi tutti.',
                advancedMotionOff: 'Le animazioni della trascrizione sono disattivate, quindi questi valori non hanno effetto. Attivale in Trascrizione › Movimento.',
                toolsSection: "Chiamate strumento",
                toolOverridesDescription: 'Dai a singoli strumenti più o meno dettagli.',
                thinkingSummary: 'Riepilogo',
                thinkingFull: 'Completo',
                strategyConsecutive: 'Consecutivi',
                strategyWholeTurn: 'Turno intero',
                copyMarkdown: 'Markdown',
                copyMarkdownDescription: 'I messaggi copiati mantengono la formattazione e indicano chi li ha scritti.',
                copyPlainDescription: 'I messaggi copiati sono testo semplice, senza etichette.',
                motionSubtle: 'Discreto',
                advancedLinkDescription: 'Streaming, tempi delle animazioni e soglie di scorrimento.',
                pageDescription: 'Come si legge una conversazione mentre cresce: layout, ragionamento, strumenti, movimento e scorrimento.',
            },
            composer: {
                pageDescription: 'Come scrivi e invii i messaggi, e cosa succede quando un agente è occupato.',
                newSessionsSection: 'Nuove sessioni',
                newSessionsDescription: 'Cosa vedi quando scegli Nuova sessione.',
                draftEntryTitle: 'Quando apri Nuova sessione',
                draftResume: 'Riprendi bozza',
                draftFresh: 'Ricomincia',
                typingSection: 'Scrittura',
                typingDescription: 'Come si comportano Invio e la cronologia dei messaggi nel compositore.',
                enterToSendTitle: 'Invio per inviare',
                sendModeTitle: 'Mentre l’agente lavora',
                sendQueue: 'In coda',
                sendInterrupt: 'Interrompi',
                sendPending: 'In attesa',
                busySteerTitle: 'Se l’agente accetta indicazioni',
                busySteerInactive: 'Vale solo quando i messaggi vengono messi in coda o in attesa mentre l’agente lavora.',
                nonSteerableTitle: 'Chiedi quando un messaggio non può guidare',
                resumeWhenPossible: 'Appena possibile',
                resumeIfOnline: 'Se online',
                resumeNever: 'Mai',
                pendingSection: 'Messaggi in attesa',
                pendingDescription: 'Come i messaggi in attesa raggiungono l’agente.',
                pendingInactive: 'Con le scelte attuali nulla resta in attesa. Queste impostazioni valgono appena un messaggio lo è.',
                drainOne: 'Uno alla volta',
                drainAll: 'Tutti insieme',
                timingAfterReply: 'Dopo la risposta',
                timingWhenIdle: 'Quando tutto è inattivo',
                layoutSection: 'Layout del compositore',
                actionBarTitle: 'Barra delle azioni',
                actionBarAutoDescription: 'I controlli usano lo spazio disponibile e vanno a capo quando necessario.',
                actionBarWrapDescription: 'I chip vanno a capo quando non ci stanno.',
                actionBarScrollDescription: 'I chip restano su una riga; scorri per vedere il resto.',
                actionBarCollapsedDescription: 'I chip finiscono in un menu, lasciando più spazio per scrivere.',
                chipDensityTitle: 'Chip delle azioni',
                chipsAutoDescription: 'I chip che ne hanno bisogno mantengono l’etichetta; quelli ovvi mostrano solo l’icona.',
                chipsLabelsDescription: 'Ogni chip mostra la sua etichetta.',
                chipsIconsDescription: 'I chip mostrano solo l’icona, per risparmiare spazio.',
            },
        },
    } };

return { settingsSessionPagesTranslations };
})();

const Domain_shareSheetTranslations = (() => {
type ShareSheetTranslations = Shared_shareSheetTranslations.ShareSheetTranslations;

const shareSheetTranslations = { it: {
        publicLink: { workflowDescription: "Chiunque abbia il link può leggere questo workflow senza un account.", workflowGrants: "Workflow di sola lettura.", description: "Chiunque abbia il link può leggere questo documento senza un account.", grants: "Documento di sola lettura.", audit: "Registro degli accessi", auditEmpty: "Nessuna visita registrata.", ownerUpdateRequired: "Il proprietario sta aggiornando questo link", ownerUpdateRequiredDescription: "Chiedi al proprietario di aprire Happier, poi riprova questo link." },
        suggestions: ({ kind }: Readonly<{ kind: string }>) => `Suggerimenti: ${kind}`,
        profileAgentsMore: ({ count }: Readonly<{ count: number }>) => `+${count} altri`,
        roleRunsIn: ({ kind }: Readonly<{ kind: string }>) => `Si esegue in ${kind}`,
        whoHasAccess: 'Chi ha accesso',
        whoHasAccessStale: 'Chi ha accesso · potrebbe non essere aggiornato',
        owner: 'Proprietario',
        you: 'Tu',
        addPlaceholder: 'Aggiungi persone o Team',
        person: 'Persona',
        group: 'Gruppo del Team',
        team: 'Team',
        accessLevel: 'Livello di accesso',
        accessibleControl: ({ name, control, value }) => `${name}, ${control}, ${value}`,
        remove: 'Rimuovi accesso',
        confirmRemove: 'Conferma rimozione',
        removedAnnouncement: ({ name }) => `${name} non ha più accesso`,
        browseAll: 'Sfoglia tutto',
        browsePeople: 'Sfoglia tutte le persone',
        browseTeams: 'Sfoglia tutti i team',
        browseGroups: 'Sfoglia tutti i gruppi dei team',
        membersOnlyLink: 'Copia link è per chi ha già accesso.',
        allLoaded: 'Tutti i risultati caricati',
        copyLink: 'Copia link',
        linkCopied: 'Link copiato',
        copyLinkFailed: 'Impossibile copiare il link.',
        sendCopy: 'Invia invece una copia',
        secrets: {
            levels: { canUse: 'Può usare' },
            help: { use: 'nelle esecuzioni; il valore non viene mai mostrato' },
            oneLevel: 'Un segreto salvato è usato solo dalle esecuzioni e il suo valore non esce mai, quindi ha un solo livello.',
        },
        documents: {
            title: 'Condivisione',
            shareTitle: ({ name }) => `Condividi ${name}`,
            levels: { canUse: 'Può usare', canRead: 'Può leggere', canEdit: 'Può modificare', admin: 'Amministra' },
            help: {
                workflowUse: 'vederlo ed eseguirlo',
                roleUse: "il ruolo nelle proprie sessioni; le modifiche personali restano nelle proprie Impostazioni",
                profileUse: 'avviare sessioni con esso',
                documentUse: 'aprirlo e copiarlo su qualsiasi suo dispositivo',
                promptUse: "il prompt nelle proprie sessioni",
                boardUse: 'vedere la bacheca; ogni scheda apre solo ciò che può già aprire',
                dashboardUse: 'Vedi questa dashboard; ogni widget mostra solo ciò che puoi già aprire.',
                editForEveryone: 'modificarlo per tutti quelli con cui è condiviso',
                adminOwnerShares: 'modificarlo e gestire la condivisione',
            },
            notes: {
                personalRuns: 'Esecuzioni e trigger restano a chi li avvia.',
                teamRuns: 'Il Team vede ogni esecuzione.',
                roleLive: 'Le tue modifiche raggiungono tutti quelli con cui è condiviso.',
                profileSecrets: 'I profili fanno riferimento ai Secret salvati; i valori non vengono trasmessi.',
                dashboardAccess: 'Le persone aggiunte la aprono con la propria identità. Widget, definizioni, connessioni, macchine e repository richiedono ciascuno il proprio accesso.',
            },
            privateChoices: {
                title: 'Scelte di connessione private',
                account: ({ widget, service }) => `${widget} usa il tuo account ${service}`,
                letViewersPick: 'Lascia scegliere ai lettori',
                removeChoice: 'Rimuovi la scelta',
                authoredInput: ({ widget }) => `Modifica ${widget} per rimuovere gli input privati prima della condivisione.`,
            },
            errors: {
                unavailable: 'La condivisione non è ancora disponibile qui.',
                ownerOnly: 'Solo il proprietario o un amministratore può cambiare chi ha accesso.',
                noAccess: 'Non hai più accesso.',
                notFound: 'Non è più disponibile.',
                subjectUnavailable: 'Questa persona, gruppo o Team non può ricevere l’accesso.',
                failed: 'Impossibile aggiornare la condivisione. Riprova.',
            },
        },
    } } satisfies Pick<Record<string, ShareSheetTranslations>, "it">;

return { shareSheetTranslations };
})();

const Domain_sidebarFooterTranslations = (() => {
type SidebarFooterTranslation = Shared_sidebarFooterTranslations.SidebarFooterTranslation;

const sidebarFooterTranslations = { it: {
        linkToService: ({ service }) => `Collega a ${service}`,
        addHomeOrSignIn: 'Aggiungi una Home o accedi',
        usageNoAccounts: 'Collega un account per vedere quanto resta dei suoi limiti.',
        usageHealthy: 'Ampio margine in tutti i limiti',
        homeUnreachableTitle: ({ home }) => `Impossibile raggiungere ${home}`,
        homeUnreachableBody: 'Le tue macchine e sessioni torneranno qui appena risponde.',
        homeUnreachableLine: ({ home }) => `Impossibile raggiungere ${home}.`,
        availableWhenHomeAnswers: "Disponibile quando questo Home risponde.",
        usageKeysWithoutLimits: ({ count }) => count === 1 ? '1 chiave senza limiti' : `${count} chiavi senza limiti`,
        usageSignedOut: 'Disconnesso',
        hideAccountIdentities: 'Nascondi email e ID degli account',
        accountIdentitiesHidden: 'Email e ID nascosti · per dirette e demo',
        usageThisSession: 'Questa sessione',
        usageAllAccounts: 'Tutti gli account',
        usageMoreAccounts: ({ count }) => `altri ${count}`,
        usageSessionThroughPool: ({ agent, pool }) => `${agent} accede tramite ${pool}`,
        usageSessionWithAccount: ({ agent }) => `${agent} accede con questo account`,
        usageSessionOwnSignIn: ({ agent }) => `${agent} usa il proprio accesso`,
        usagePoolFallback: 'il suo gruppo',
        usageNextInOrder: ({ account }) => `Quando ${account} si esaurisce, il turno successivo passa all'account successivo in ordine`,
        usageNextMostLeft: ({ account }) => `Quando ${account} si esaurisce, il turno successivo passa all'account con più margine`,
        usageNextStays: ({ pool, account }) => `${pool} resta su ${account} finché non cambi`,
    } } as const satisfies Pick<Record<string, SidebarFooterTranslation>, "it">;

return { sidebarFooterTranslations };
})();

const Domain_surfaceStateTranslations = (() => {
type SurfaceStateTranslations = Shared_surfaceStateTranslations.SurfaceStateTranslations;

const surfaceStateTranslations = { it: {
        stillWaiting: ({ seconds }) => `Ancora in attesa · ${seconds} s`,
        asOf: ({ time }) => `Alle ${time}`,
        howItWorks: 'Come funziona',
        tryAgain: 'Riprova',
        checkAgain: 'Controlla di nuovo',
        paneFailedTitle: 'Impossibile mostrare questo pannello',
        paneFailedReason: 'Qualcosa è andato storto durante la visualizzazione. La tua sessione non è interessata.',
        opening: ({ name }) => `Apertura di ${name}`,
        couldNotOpen: ({ name }) => `Impossibile aprire ${name}`,
    } } as const satisfies Pick<Record<string, SurfaceStateTranslations>, "it">;

return { surfaceStateTranslations };
})();

const Domain_teamsTranslations = (() => {
type TeamsTranslationRoot = Shared_teamsTranslations.TeamsTranslationRoot;

const english = Shared_teamsTranslations.english;

const italian: TeamsTranslationRoot = {
    teams: {
        leave: {
            action: 'Lascia il team',
            description: 'Il tuo accesso al team e ai gruppi termina. Il tuo account su questo Home rimane.',
            confirmTitle: ({ name }: { name: string }) => `Lasciare ${name}?`,
            confirmBody: 'Il tuo accesso al team e ai gruppi termina subito. Le tue appartenenze ai gruppi e le autorizzazioni legate a questa adesione vengono rimosse. I tuoi contributi e i contenuti già visti restano. Rientrare in seguito crea una nuova adesione.',
            auditLeft: ({ team }: { team: string }) => `ha lasciato ${team}`,
            auditRemoved: ({ team, target }: { team: string; target: string }) => `ha rimosso ${target} da ${team}`,
        },
        overview: {
            sharedSessions: "Sessioni condivise",
            allSharedSessions: "Tutte le sessioni condivise",
            managedBy: ({ team }: { team: string }) => `I proprietari e gli admin di ${team} gestiscono membri, accesso e impostazioni.`,
            attention: {
                directoryFailedTitle: ({ name }: { name: string }) => `${name} non è riuscita a sincronizzarsi`,
                directoryFailedBody: "Membri e gruppi restano com’erano all’ultima sincronizzazione riuscita.",
                invitationUndeliveredTitle: "Un’email di invito non è arrivata",
                invitationUndeliveredBody: ({ recipient }: { recipient: string }) => `Per ${recipient}. Il link funziona ancora se lo condividi in un altro modo.`,
            },
            sessionsSubtitle: 'Le sessioni condivise con questo team.',
            teamSection: 'Team',
            summary: {
                historyFromJoining: "cronologia dall’ingresso",
                historyEarlier: "anche la cronologia precedente",
                groupsDirectory: ({ directory }: { directory: string }) => `allineati con ${directory}`,
                undelivered: ({ count }: { count: number }) => count === 1 ? '1 email non arrivata' : `${count} email non arrivate`,
                credentialsShared: ({ count, team }: { count: number; team: string }) => `${count} condivise con ${team}`,
                credentialsNone: "Nessuna condivisa per ora",
                justYou: 'Solo tu',
                people: ({ count }: { count: number }) => count === 1 ? `1 persona` : `${count} persone`,
                suspended: ({ count }: { count: number }) => `${count} sospese`,
                groups: ({ count }: { count: number }) => count === 1 ? `1 gruppo` : `${count} gruppi`,
                noGroups: 'Ancora nessun gruppo',
                waiting: ({ count }: { count: number }) => `${count} in attesa di accettazione`,
                noneWaiting: 'Nessuno in attesa',
                homeSignIn: ({ home }: { home: string }) => `Accesso di ${home}`,
                chosenSignIn: 'Solo l’accesso scelto',
                signInNeedsRepair: 'La regola di accesso va riparata',
                sessionsPrivate: 'Sessioni private per impostazione predefinita',
                sessionsShared: 'Sessioni condivise per impostazione predefinita',
                sessionsAlwaysShared: 'Sessioni sempre condivise',
            },
            setup: {
                title: ({ team }: { team: string }) => `Prepara ${team}`,
                description: 'Ogni passaggio esce da questo elenco quando è fatto.',
                inviteBody: ({ home, team }: { home: string; team: string }) => `Chiunque inviti entra in ${home} come parte di ${team}.`,
                signInTitle: 'Scegli come accedono i membri',
                signInBody: 'Mantieni l’accesso di questo Home o richiedi quello della tua azienda.',
                signInAction: 'Scegli',
                shareTitle: 'Condividi una sessione',
                shareBody: ({ team }: { team: string }) => `Dal menu di una sessione, condividila con ${team}.`,
            },
        },
        denied: {
            askUnnamed: "Chiedi a un proprietario o admin di questo team.",
            title: 'Il tuo ruolo in questo team non lo include',
            authentication: ({ team }: { team: string }) => `I proprietari e gli admin di ${team} decidono come accedono i membri.`,
            settings: ({ team }: { team: string }) => `I proprietari e gli admin di ${team} modificano queste impostazioni.`,
        },
        pages: {
            credentialCreate: 'Scegli cosa condividere, chi può usarlo e i suoi limiti.',
            credentialDetail: 'Chi può usare questa credenziale, come e quanto.',
            credentialEdit: 'Cambia chi può usare questa credenziale, come e quanto.',
            credentialActivity: 'Le modifiche a questa credenziale e chi le ha fatte.',
            credentialUsage: 'Quanto è stata usata questa credenziale e da chi.',
            credentialExternalApi: 'Usa questa credenziale da strumenti esterni a Happier.',
            identityProviderNew: 'Collega un provider di identità con cui i membri possono accedere.',
            identityProviderEdit: 'Cambia come si collega questo provider di identità.',
            githubApp: 'Una GitHub App che questo team usa per accedere ai repository.',
            githubAppEdit: 'Modifica la registrazione di questa GitHub App.',
            authentication: 'Come i membri accedono a questo team e chi ammette.',
            credentials: 'Le credenziali dei provider che questo team condivide con i membri.',
            directory: 'Gruppi di persone che condividono sessioni, accessi e credenziali su un Home.',
            members: 'Chi fa parte di questo team e cosa può fare ciascuno.',
            addMember: 'Aggiungi qualcuno che ha già un account su questo Home.',
            groups: 'Insiemi di membri con un nome, con cui condividere sessioni e credenziali.',
            newGroup: 'Dai un nome al gruppo. Aggiungi i membri quando esiste.',
            invitations: 'Gli inviti che permettono di unirsi a questo team e a chi sono destinati.',
            settings: 'Nome, logo, impostazioni predefinite delle sessioni e stato attivo del team.',
        },
        loading: 'Caricamento del team…',
        title: 'Team',
        entrySubtitle: 'Crea team, gestisci membri e gruppi e invita persone.',
        entry: {
            heading: ({ team }: { team: string }) => `Continua con ${team}`,
            onHome: ({ home }: { home: string }) => `su ${home}`,
            signInServiceOrigin: ({ service }: { service: string }) => `Accedi tramite ${service}`,
            signInServiceUnavailableOrigin: ({ service }: { service: string }) => `L’accesso tramite ${service} non è disponibile`,
            signedInTo: ({ home, account }: { home: string; account: string }) => `Accesso a ${home} come ${account}`,
            unnamedAccount: 'Account Happier',
            continueWith: ({ method }: { method: string }) => `Continua con ${method}`,
            providerUnavailableTitle: ({ method }: { method: string }) => `${method} non è disponibile`,
            providerUnavailableDisabled: 'L’amministratore del tuo Team ha disattivato questo accesso. Controlla più tardi.',
            providerUnavailableSetupIncomplete: 'L’amministratore del tuo Team non ha ancora finito di configurare questo accesso. Controlla più tardi.',
            providerUnavailableUnavailable: 'Questo Home non può usare questo accesso in questo momento. Controlla più tardi.',
            unknownTargetTitle: 'Questo link non identifica il suo Home',
            unknownTargetBody: 'Questo dispositivo non riesce a capire a quale Home appartiene questo link di accesso al team, quindi non è stato inviato nulla. Chiedi di nuovo il link a chi gestisce il team.',
            ssoRequiredTitle: 'Questo Team richiede un altro metodo di accesso',
            ssoRequiredBody: 'Hai effettuato l’accesso a questo Home, ma questo Team accetta solo il metodo di accesso che richiede. Accedi di nuovo con quel metodo, oppure torna al tuo lavoro.',
            invitationUnavailableTitle: 'Questo invito non può essere usato',
            invitationUnavailableBody: 'Potrebbe essere scaduto, revocato o già usato. Accedere da solo non ti fa entrare nel Team.',
            wrongAccountTitle: 'Questo account non può usare questo accesso',
            wrongAccountBody: 'L’account o l’identità con cui hai effettuato l’accesso non è quello che questo Team si aspetta. Accedi con un altro account o provider, oppure torna al tuo lavoro.',
            notProvisionedTitle: 'Questo Team non ti ha ancora ammesso',
            notProvisionedBody: 'Accedere da solo non ti fa entrare in questo Team. Il suo amministratore decide chi viene ammesso; chiedigli l’accesso o un invito, poi riprova.',
            directoryDelayedTitle: 'Il tuo accesso è ancora in arrivo',
            directoryDelayedBody: 'Questo Team riceve i suoi membri da una directory che non ha ancora consegnato il tuo accesso. Riprova tra un po’, oppure chiedi a un responsabile del Team.',
            accessRemovedTitle: 'Questo Team non è disponibile per te',
            accessRemovedBody: 'Il tuo accesso potrebbe essere stato rimosso, oppure il Team non è disponibile su questo Home in questo momento. Tutto il resto a cui hai accesso non cambia.',
            providerChangedTitle: 'Questo metodo di accesso è cambiato mentre lo usavi',
            providerChangedBody: 'Un amministratore ha aggiornato questo metodo di accesso durante il tuo accesso. Nulla è stato cambiato sul tuo account. Ricomincia dalla pagina del Team per vedere i metodi attuali.',
            returnToTeamSignIn: 'Torna all’accesso del Team',
            returnToHappier: 'Torna a Happier',
            signInToTeam: 'Accedi a questo team',
            readyStatus: 'Scegli come accedere per continuare.',
        },
        homeLabel: 'Home',
        role: {
            owner: 'Proprietario',
            admin: 'Amministratore',
            member: 'Membro',
            guest: 'Ospite',
        },
        roleHelp: {
            owner: 'Possiede il team, può gestirlo e cambiare i proprietari.',
            admin: 'Ha l’accesso da Membro e può gestire il team.',
            member: 'Riceve per impostazione predefinita l’accesso concesso al team.',
            guest: 'Vede solo le sessioni e le risorse condivise esplicitamente con questo account o con un gruppo a cui appartiene.',
        },
        status: {
            active: 'Attivo',
            suspended: 'Sospeso',
        },
        history: {
            label: 'Cronologia delle sessioni',
            allExisting: 'Includi le sessioni già condivise con il team',
            fromMembership: 'Solo le sessioni condivise dopo il suo ingresso',
            allExistingNamed: ({ name }) => `Includi le sessioni già condivise con ${name}`,
            fromMembershipNamed: ({ name }) => `Solo le sessioni condivise dopo il suo ingresso in ${name}`,
            scopeNote: 'Vale per sessioni intere. Non rivela soltanto i messaggi creati dopo l’ingresso.',
        },
        unavailable: {
            title: 'I team non sono disponibili su questo Home',
            disabled: 'Su questo Home i team sono disattivati.',
            updateRequired: 'Questo Home richiede un aggiornamento per usare i team.',
            offline: 'Questo Home non è raggiungibile in questo momento.',
            retry: 'Riprova',
        },
        stale: {
            label: 'Vengono mostrati gli ultimi dati noti di questo Home.',
        },
        errors: {
            generic: 'Operazione non riuscita. Non è stato modificato nulla.',
            outcomeUnknown: 'L’Home potrebbe aver completato questa modifica. Aggiorna il team prima di riprovare.',
            forbidden: 'Non hai l’autorizzazione per questa modifica.',
            notFound: 'Questo team non è più disponibile.',
            archived: 'Questo team è archiviato. Ripristinalo per modificarlo.',
            conflict: 'Qualcun altro ha modificato prima. Controlla i valori attuali e riprova.',
            offline: 'Questo Home non è raggiungibile, quindi la modifica non è stata inviata.',
            invalidName: 'Inserisci un nome da 1 a 80 caratteri.',
            invalidDescription: 'Inserisci una descrizione di massimo 500 caratteri.',
        },
        directory: {
            loading: 'Caricamento dei team…',
            chooseTeamToShare: 'Scegli il team con cui condividerlo.',
            noMatches: 'Nessun team corrisponde',
            noLoadedMatches: 'Nessun team caricato corrisponde',
            searchLoadedPlaceholder: 'Filtra i team caricati',
            unreachableHomes: 'Non rispondono',
            searchPlaceholder: 'Cerca team',
            newTeam: 'Nuovo team',
            createDenied: ({ homes }: { homes: string }) => `Solo gli amministratori di ${homes} possono creare team. Chiedi a uno di loro di crearne uno o di aggiungerti.`,
            createAdministered: ({ names }: { names: string }) => `I team su questo Home vengono creati dai suoi amministratori. Chiedi a ${names} di creare un team per te o di consentire a tutti di creare team.`,
            createAdministeredUnnamed: 'I team su questo Home vengono creati dai suoi amministratori. Chiedi a uno di loro di creare un team per te o di consentire a tutti di creare team.',
            createOff: 'La creazione di team è disattivata su questo Home.',
            letEveryoneCreate: 'Consenti a tutti di creare team',
            namesAnd: ({ names, last }: { names: string; last: string }) => `${names} e ${last}`,
            namesAndOthers: ({ names, count }: { names: string; count: number }) => `${names} e altri ${count}`,
            emptyTitle: 'Ancora nessun team',
            emptyBody: 'Un team offre a un gruppo di persone un unico spazio condiviso per sessioni, persone e accessi.',
            archivedSection: 'Team archiviati',
            archivedEmpty: 'Nessun team archiviato',
            archivedEmptyBody: 'Archiviare un team dalle sue impostazioni lo sposta qui. Membri, gruppi e cronologia vengono conservati.',
            showArchived: 'Mostra archiviati',
            hideArchived: 'Nascondi archiviati',
            archivedBadge: 'Archiviato',
            rowAccessibilityLabel: ({ name, role, home }: { name: string; role: string; home: string }) => `${name}, ${role}, su ${home}`,
            partialHomes: 'Alcuni Home non sono raggiungibili, perciò i loro team mancano da questo elenco.',
        },
        create: {
            loading: 'Verifica dei Home in cui puoi creare un team…',
            discard: 'Scarta',
            detailsSection: 'Team',
            logoFailedBody: 'Il team è stato creato, ma il logo non è stato pubblicato. Riprova o continua senza.',
            title: 'Nuovo team',
            nameLabel: 'Nome',
            namePlaceholder: 'Acme',
            descriptionLabel: 'Descrizione',
            descriptionPlaceholder: 'Di cosa si occupa questo team',
            homeHelp: 'Il team viene creato su questo Home e vi rimane.',
            duplicateNameNote: 'Due team possono avere lo stesso nome. I link e gli accessi usano sempre il team stesso.',
            managedOnlyTitle: 'La creazione dei team è amministrata su questo Home',
            managedOnlyBody: 'Un amministratore crea qui i team e sceglie il primo proprietario.',
            initialOwnerLabel: 'Primo proprietario',
            initialOwnerPlaceholder: 'Cerca persone su questo Home',
            initialOwnerHelp: 'Creare un team per qualcun altro non ti aggiunge al team.',
            initialOwnerRequired: 'Scegli il primo proprietario del team. Su questo Home un amministratore indica chi possiede un nuovo team.',
            initialOwnerIneligible: 'Questa persona non può più possedere un team. Scegli qualcun altro.',
            submit: 'Crea team',
            submitting: 'Creazione…',
            outcomeUnknown: 'Non è stato possibile confermare se il team è stato creato. Riprova per recuperare la stessa richiesta.',
        },
        tabs: {
            overview: 'Panoramica',
            sessions: 'Sessioni',
            members: 'Membri',
            groups: 'Gruppi',
            invitations: 'Inviti',
            authentication: 'Autenticazione',
            settings: 'Impostazioni',
        },
        authentication: {
            policy: {
                admissionRow: "Nuovi membri",
                acceptedRow: "Accesso accettato",
                admissionSection: 'Chi può entrare',
                admissionHelp: 'Come le persone diventano membri di questo team.',
                admissionInviteOnly: 'Solo su invito',
                admissionProvisioned: 'Fornito da una directory',
                admissionJit: 'Automaticamente al primo accesso',
                admissionUnavailable: 'Questo Home non può ancora applicare quella modalità di ammissione, quindi nulla è cambiato.',
                admissionUnavailableReason: {
                    homePolicyUnavailable: 'Questo Home non ha reso disponibile ai team quel provider di accesso. Un amministratore dell’Home può cambiarlo.',
                    homePolicyProhibited: 'Un amministratore dell’Home non consente questa modalità di ammissione su questo Home.',
                    directorySourceRequired: 'Aggiungi prima una directory a questo team. Questa modalità ammette le persone che essa fornisce.',
                    directoryProjectionRequired: 'La directory di questo team non ha ancora completato la prima sincronizzazione. Questa modalità sarà disponibile al termine.',
                    teamConnectionRequired: 'Aggiungi prima una connessione di accesso a questo team. L’ammissione al primo accesso ne ha bisogno.',
                    teamConnectionUnavailable: 'Al momento nessuna connessione di accesso di questo team è utilizzabile, quindi nessuno potrebbe essere ammesso all’accesso.',
                },
                acceptedSection: 'Come accedono i membri',
                acceptedHelp: 'Quale accesso accetta questo team prima di consentire il lavoro del team.',
                acceptedInherit: 'Usa i criteri dell’Home',
                acceptedRestricted: 'Solo l\'accesso selezionato qui sotto',
                connectionsSection: 'Connessioni accettate',
                connectionsEmpty: 'Seleziona almeno una connessione di accesso, oppure usa i criteri dell’Home.',
                homeMethodRetained: 'Mantenuto dai criteri memorizzati',
                repairRequired: 'La restrizione di accesso memorizzata non è leggibile',
                repairRequiredHelp: 'Non viene applicata come scritta. Scegli qui sotto un criterio per sostituirla.',
                conflictBody: 'I criteri di accesso sono cambiati in questo Home. Controllali, poi applica di nuovo la tua modifica.',
                providerTestRequired: 'Testa questa connessione prima che il team possa richiederla.',
                unavailable: 'Questo Home non può accettare quei criteri di accesso.',
                approvalPending: 'In attesa di approvazione',
                connectionOwnerTeam: "Connessione del team",
                connectionOwnerHome: "Metodo di accesso dell’Home",
            },
            subtitle: 'Come i membri del team dimostrano la propria identità.',
            memberSignIn: {
                section: 'Pagina di accesso per i membri',
                open: 'Apri la pagina di accesso per i membri',
                copyLink: 'Copia link',
                shareLink: 'Condividi link',
                qrLabel: 'Codice QR del link di accesso per i membri',
                footer: 'Chiunque abbia questo link raggiunge la pagina di accesso di questo Team. Il link da solo non concede nulla: l’adesione segue comunque la politica di ammissione del Team.',
                unavailable: 'Nessun link condivisibile',
                unavailableBody: 'Questo Home non pubblica alcun indirizzo web, quindi non esiste un link che funzioni su un altro dispositivo. Un amministratore del Home può configurarne uno.',
            },
            connectionsSection: 'Connessioni di accesso',
            homeMethodsUnavailable: 'Non è stato possibile leggere i metodi di accesso di questo Home.',
            connectionsDescription: 'L’accesso aziendale che questo team può usare.',
            add: {
                fixTurnOn: "Attivalo",
                action: 'Aggiungi connessione',
                askNamed: ({ names }: { names: string }) => `Chiedi a ${names}.`,
                askUnnamed: 'Chiedi a un proprietario del Home.',
                fixInSignInProviders: 'Configura',
                fixInReach: 'Impostane uno in Raggiungibilità',
                reason: {
                    contactHomeAdmin: ({ home }: { home: string }) => `${home} lo configura per i suoi team.`,
                    workosPlatform: ({ home }: { home: string }) => `WorkOS non è ancora configurato su ${home}.`,
                    providerDisabled: ({ home }: { home: string }) => `Da ${home}. Lì è disattivato.`,
                    homeProhibited: ({ home, provider }: { home: string; provider: string }) => `${home} non consente ai team di aggiungere ${provider}.`,
                    homeUnavailable: ({ home }: { home: string }) => `${home} non l’ha reso disponibile ai team.`,
                    publicAddress: ({ home }: { home: string }) => `Il tuo provider ha bisogno di un indirizzo pubblico di ${home} per rimandare indietro le persone.`,
                },
            },
            empty: 'Nessuna connessione di accesso',
            status: {
                unavailable: 'Non disponibile',
                prohibited: 'Bloccata dai criteri del Home',
                notConfigured: 'Non configurata',
                settingUp: 'Configurazione in corso',
                needsAttention: 'Richiede attenzione',
            },
            mode: {
                signInOnly: 'Solo accesso',
                signInTimeGroups: 'I gruppi si aggiornano all’accesso',
            },
            detail: {
                status: 'Stato',
                mode: 'Modalità',
                provider: 'Fornitore',
                restrictions: 'Limitazioni di accesso',
                allowedUsers: 'Utenti consentiti',
                allowedDomains: 'Domini email consentiti',
                none: 'Nessuno',
                configuration: 'Configurazione',
                organization: 'Organizzazione',
                connection: 'Connessione',
            },
            directory: {
                connect: "Collega",
                actions: {
                    section: 'Azioni', sync: 'Sincronizza ora', pause: 'Sospendi sincronizzazione', resume: 'Riprendi sincronizzazione', remove: 'Rimuovi directory…',
                    pauseTitle: ({ source }: { source: string }) => `Sospendere ${source}?`, pauseBody: 'Le nuove modifiche della directory si fermeranno. Gli accessi al Team e i contributi ai Gruppi noti restano fino alla ripresa.',
                    removeTitle: ({ source }: { source: string }) => `Rimuovere ${source}?`, removeMembers: ({ count }: { count: number }) => count === 1 ? '1 persona entrata tramite questa directory lascia il team.' : `${count} persone entrate tramite questa directory lasciano il team.`, removeGroupMemberships: ({ count }: { count: number }) => count === 1 ? 'Viene rimossa 1 appartenenza a gruppo impostata da essa.' : `Vengono rimosse ${count} appartenenze a gruppi impostate da essa.`, removeNothing: "Nessuna iscrizione dipende da essa.", removeKept: "Account, gruppi creati da essa e persone aggiunte in altro modo vengono conservati.",
                },
                section: "Appartenenza gestita",
                overviewSubtitle: "Le origini directory mantengono membri e gruppi del Team allineati con un’organizzazione esterna.",
                manageSubtitle: "Controlla le origini directory connesse e il loro ultimo stato di sincronizzazione.",
                title: "Sincronizzazione directory",
                sourcesSection: "Origini directory",
                sourcesLoadMore: "Carica altre origini",
                subtitle: "Le modifiche dalla directory compaiono qui dopo ogni sincronizzazione.",
                purpose: "Mantieni membri e gruppi di questo team allineati alla directory aziendale.",
                sourcePurpose: "Le persone e i gruppi che questa directory mantiene allineati al team.",
                empty: "Nessuna origine directory",
                emptyBody: "Collega la directory aziendale e il team la segue: chi entra si unisce al team, chi esce perde l’accesso.",
                setup: {
                    add: "Aggiungi fonte",
                    options: "Scegli una fonte di directory",
                    optionsFooter: "Non cambia nulla finché non termina la prima sincronizzazione.",
                    loadMore: "Carica altro",
                    empty: "Nessuna fonte verificata disponibile",
                    workos: "Configura la sincronizzazione directory WorkOS",
                    workosSubtitle: "Apri il portale di amministrazione WorkOS e torna per scegliere la directory verificata.",
                    confirmTitle: ({ source }: { source: string }) => `Add ${source}?`,
                    confirmBody: "Happier inizierà a importare questa directory dopo averla aggiunta.",
                },
                people: {
                    section: "Persone",
                    empty: "Nessuna persona fornita",
                    provisioned: "Fornita · Nessun account ancora",
                    boundAccountCount: ({ count }: { count: number | string }) => `Account collegati: ${count}`,
                    unboundPeopleCount: ({ count }: { count: number | string }) => `Persone predisposte senza account: ${count}`,
                    member: "Membro del team",
                    unknown: "Persona senza nome",
                    loadMore: "Carica altre persone",
                    state: {
                        suspended: "Sospesa",
                        deleted: "Eliminata",
                    },
                },
                kind: {
                    workos: "Sincronizzazione directory WorkOS",
                    github: "Organizzazione GitHub",
                },
                state: {
                    setup: "Configurazione necessaria",
                    syncing: "Sincronizzazione",
                    active: "Attiva",
                    paused: "In pausa",
                    needsAttention: "Richiede attenzione",
                    initializing: "Configurazione in corso",
                    failed: "Ultima sincronizzazione non riuscita",
                },
                mode: {
                    eventsAndFull: "Eventi e riconciliazione completa",
                    fullOnly: "Solo riconciliazione completa",
                },
                freshness: {
                    never_synced: "Mai sincronizzata",
                    fresh: "Aggiornata",
                    stale: "Non aggiornata",
                    unknown: "Sconosciuta",
                },
                detail: {
                    status: "Stato",
                    sourceType: "Tipo di origine",
                    syncSection: "Stato sincronizzazione",
                    mode: "Modalità di sincronizzazione",
                    freshness: "Aggiornamento",
                    lastSuccess: "Ultima sincronizzazione riuscita",
                    nextScheduled: "Prossima sincronizzazione pianificata",
                    attentionSection: "Attenzione richiesta",
                    attentionTitle: "Questa origine directory richiede attenzione",
                    attentionRetryable: "L’origine può ripristinarsi dopo la riparazione della connessione. Aggiorna per verificarne lo stato.",
                    attentionAdmin: "Controlla la configurazione dell’origine prima di fare affidamento su nuove modifiche della directory.",
                },
                never: "Mai",
                unknown: "Sconosciuto",
            },
        },
        settings: {
            archiveDescription: 'L’archiviazione toglie il team dalle viste attive e interrompe l’accesso basato sul team. Membri, gruppi e cronologia vengono conservati ed è possibile ripristinarlo.',
            logoSection: 'Logo',
            sessionDefaultsSection: 'Impostazioni predefinite delle sessioni',
            sharingSection: 'Condivisione',
            sharingDescription: 'Si applica da ora. Nulla di già condiviso cambia.',
            option: {
                private: 'Privata',
                shared: 'Condivisa',
                alwaysShared: 'Sempre condivisa',
                anyone: 'Chiunque',
                admins: 'Admin',
                nobody: 'Nessuno',
                fromJoining: 'Dall’ingresso',
                earlierToo: 'Anche prima',
            },
            consequence: {
                sessionsPrivate: ({ team }: { team: string }) => `Partono private; ognuno sceglie cosa condividere con ${team}.`,
                sessionsShared: ({ team }: { team: string }) => `Partono condivise con ${team}; ognuno può tenerne una privata.`,
                sessionsAlwaysShared: ({ team }: { team: string }) => `Ogni nuova sessione è condivisa con ${team}.`,
                outsideAnyone: ({ team }: { team: string }) => `Chi può condividere una sessione può condividerla anche fuori da ${team}.`,
                outsideAdmins: ({ team }: { team: string }) => `Solo gli admin di ${team} possono condividere una sessione all’esterno.`,
                outsideNobody: ({ team }: { team: string }) => `Le sessioni non possono essere condivise fuori da ${team}.`,
                historyFromJoining: ({ team }: { team: string }) => `Sessioni condivise con ${team} dal loro ingresso.`,
                historyEarlier: ({ team }: { team: string }) => `Anche le sessioni condivise con ${team} prima del loro ingresso.`,
            },
            externalSharingSection: 'Condivisione esterna',
            historyDefaultSection: 'Cronologia predefinita',
            saved: 'Salvato',
        },
        policy: {
            sessionCreationPrivate: 'Privata per impostazione predefinita',
            sessionCreationTeam: 'Condivisa con il team per impostazione predefinita',
            sessionCreationRequired: 'Sempre condivisa con il team',
            sessionCreationHelp: 'Vale per le nuove sessioni. Le sessioni private esistenti non vengono esposte.',
            externalSharingAllowed: 'Chiunque possa condividere',
            externalSharingAdmins: 'Solo amministratori del team',
            externalSharingDisabled: 'Non consentito',
            externalSharingHelp: 'Può bloccare condivisioni future. Non ritira le copie già condivise.',
            historyDefaultHelp: 'Preseleziona la scelta per i nuovi membri. Non riscrive la cronologia dei membri esistenti.',
        },
        logo: {
            add: 'Aggiungi logo',
            replace: 'Sostituisci logo',
            remove: 'Rimuovi logo',
            removeConfirmTitle: 'Rimuovere questo logo?',
            removeConfirmBody: 'Il team tornerà a mostrare il suo monogramma. Puoi caricare un nuovo logo quando vuoi.',
            previewLabel: 'Anteprima del logo',
            useAsLogo: 'Usa come logo',
            monogramLabel: 'Monogramma del team',
            tooLarge: 'Questa immagine è troppo grande. Scegline una più piccola.',
            invalidFormat: ({ formats }: { formats: string }) => `Questo file non è un’immagine supportata. Formati supportati: ${formats}.`,
            failed: 'Il logo non è stato caricato. Il logo attuale resta invariato.',
            retry: 'Riprova',
        },
        archive: {
            archivedTitle: ({ name }: { name: string }) => `${name} è archiviato`,
            archivedBody: "L’accesso al team è interrotto e qui non si può cambiare nulla. Membri, gruppi e cronologia sono conservati.",
            confirm: {
                keptCounted: ({ members, groups }: { members: number; groups: number }) => `${members === 1 ? '1 membro' : `${members} membri`}, ${groups === 1 ? '1 gruppo' : `${groups} gruppi`} e la loro cronologia sono conservati.`,
                kept: "Membri, gruppi e la loro cronologia sono conservati.",
                invitationsStop: ({ count }: { count: number }) => count === 1 ? '1 link di invito in attesa smette di funzionare, anche dopo il ripristino.' : `${count} link di invito in attesa smettono di funzionare, anche dopo il ripristino.`,
                restore: "Puoi ripristinarlo quando vuoi; gli accessi conservati tornano dove sono ancora validi.",
            },
            openSettings: 'Apri impostazioni',
            action: ({ name }: { name: string }) => `Archivia ${name}`,
            confirmTitle: ({ name }: { name: string }) => `Archiviare ${name}?`,
            restoreAction: ({ name }: { name: string }) => `Ripristina ${name}`,
            restoreTitle: ({ name }: { name: string }) => `Ripristinare ${name}?`,
            restoreBody: () => 'Iscrizioni, gruppi e autorizzazioni conservate torneranno attivi dove account e risorse lo consentono ancora. I link di invito revocati non torneranno.',
            readOnly: 'Questo team è archiviato. Ripristinalo per modificarlo.',
        },
        members: {
            roleReadOnly: ({ team }: { team: string }) => `Solo i proprietari e gli admin di ${team} cambiano i ruoli.`,
            roleSetBy: ({ source }: { source: string }) => `Impostato da ${source}.`,
            accessSection: "Accesso ai contenuti",
            lifecycleFootnote: "La sospensione ferma l’accesso finché non lo riattivi. La rimozione lo termina; ciò che ha scritto resta, e rientrare avvia una nuova appartenenza.",
            removal: {
                title: ({ name, team }: { name: string; team: string }) => `Rimuovere ${name} da ${team}?`,
                action: ({ team }: { team: string }) => `Rimuovi da ${team}…`,
                ends: "Il suo accesso al team e ai gruppi termina ora.",
                leavesGroups: ({ groups }: { groups: string }) => `Lascia ${groups}.`,
                leavesGroupsAndMore: ({ groups }: { groups: string }) => `Lascia ${groups} e gli altri suoi gruppi.`,
                kept: "Le sessioni e i messaggi che ha scritto restano dove sono.",
            },
            filterLabel: 'Mostra',
            searchPlaceholder: 'Cerca membri',
            filterAll: 'Tutti',
            filterOwnersAndAdmins: 'Proprietari e amministratori',
            addMenu: {
                existing: 'Aggiungi qualcuno di questo Home',
                existingBody: ({ home }: { home: string }) => `Scegli tra le persone che hanno già un account su ${home}.`,
                invite: 'Invita con link o email',
                inviteBody: ({ team }: { team: string }) => `Per chiunque altro. Entra in ${team} quando accetta.`,
            },
            filterMembers: 'Membri',
            filterGuests: 'Ospiti',
            filterSuspended: 'Sospesi',
            emptyTitle: 'Nessun membro corrisponde',
            emptyBody: 'Modifica il filtro oppure invita qualcuno in questo team.',
            add: 'Aggiungi membro',
            addTitle: ({ team }: { team: string }) => `Aggiungi a ${team}`,
            personLabel: 'Persona',
            roleLabel: 'Ruolo',
            personPlaceholder: 'Cerca persone su questo Home',
            ineligible: 'Già in questo team, oppure non è un account attivo su questo Home.',
            addSubmit: 'Aggiungi membro',
            you: 'Tu',
            joined: ({ when }: { when: string }) => `Iscritto il ${when}`,
            managedBy: ({ source }: { source: string }) => `Gestito tramite ${source}`,
            managedReadOnly: 'Questa iscrizione è gestita alla sua origine. Modificala lì.',
            detailManagedBy: 'Gestito da',
            managementTitle: 'Origine di gestione',
            managementHelp: 'Cambiare origine mantiene questa iscrizione, il ruolo, lo stato e la cronologia delle sessioni. Cambia solo chi può modificarli.',
            managementNative: 'Gestito in Happier',
            managementConflict: 'Questa origine non ha ancora un’identità disponibile per questa persona. Sincronizzala e riprova.',
            encryption: {
                title: 'Accesso cifrato',
                checking: 'Verifica dell’accesso cifrato…',
                ready: 'Preparato',
                scopeBody: 'Qui sono incluse solo le sessioni che gestisci. Altri responsabili delle sessioni potrebbero dover preparare ancora l’accesso.',
                pending: 'Da preparare',
                prepare: 'Prepara l’accesso cifrato',
                preparing: ({ prepared }: { prepared: number }) => `Preparazione dell’accesso cifrato · ${prepared} preparate`,
                setupRequired: 'Configurazione necessaria',
                setupRequiredBody: 'Questa persona non ha completato la configurazione dell’accesso cifrato. Potrai preparare la sua cronologia delle sessioni in seguito.',
                notEncrypted: 'Non cifrato',
                plainAccount: 'L’account di questa persona non usa la cifratura end-to-end, quindi non c’è nulla da preparare.',
                repairRequired: 'L’accesso cifrato va riparato',
                repairBody: 'Alcune sessioni che gestisci non possono essere preparate da questo dispositivo. Aprile per riparare il tuo accesso.',
                nonTransferableBody: 'Alcune sessioni usano un formato di cifratura precedente che non può essere condiviso con nuovi membri. Restano leggibili per chi vi ha già accesso.',
                recipientChanged: 'L’account di questa persona è cambiato. Ricaricamento prima di preparare di nuovo.',
                retry: 'Riprova',
                failed: 'La preparazione si è interrotta prima della fine. Quanto già preparato è stato mantenuto.',
            },
            detailGroups: 'Gruppi',
            detailGroupsEmpty: 'Nessun gruppo',
            suspend: 'Sospendi membro',
            suspendTitle: ({ name }: { name: string }) => `Sospendere ${name}?`,
            suspendBody: 'L’accesso a team e gruppi si interrompe subito. L’appartenenza ai gruppi e le assegnazioni di risorse vengono conservate, e la riattivazione ripristina solo l’accesso ancora valido. L’account del Home e gli altri team non sono interessati.',
            reactivate: 'Riattiva membro',
            reactivateTitle: ({ name }: { name: string }) => `Riattivare ${name}?`,
            reactivateBody: 'L’accesso riprende dove iscrizioni, gruppi e stato dell’account lo consentono ancora.',
            remove: 'Rimuovi dal team',
            lastOwnerBlocked: 'Un team mantiene almeno un proprietario attivo. Scegline prima un altro.',
            accountInactive: 'L’account di questa persona non è attivo, quindi non può essere aggiunta né nominata proprietaria.',
            ownerOnlyAction: 'Solo un proprietario del team può cambiare i proprietari.',
            ownerRequiredTitle: 'Serve un proprietario',
            ownerRequiredBody: ({ team }: { team: string }) => `${team} ha bisogno di un proprietario attivo per le modifiche riservate al proprietario.`,
            chooseOwner: 'Scegli proprietario',
            ownerRequiredNoCandidate: 'Non è disponibile alcun membro idoneo. Occorre aggiungere un membro esistente o concordare un passaggio di proprietà.',
        },
        groups: {
            detailsSection: 'Gruppo',
            title: 'Gruppi',
            emptyTitle: 'Ancora nessun gruppo',
            emptyBody: 'Un gruppo è un insieme piatto di membri del team con cui condividere in una volta sola.',
            emptyRosterTitle: 'Ancora nessun membro in questo gruppo',
            noEligibleCandidatesTitle: 'Nessuno da aggiungere',
            noEligibleCandidatesBody: 'Qui compaiono i membri del team che non fanno già parte di questo gruppo.',
            create: 'Nuovo gruppo',
            nameLabel: 'Nome',
            namePlaceholder: 'Sviluppo',
            descriptionPlaceholder: 'A cosa serve questo gruppo',
            submit: 'Crea gruppo',
            nameTaken: 'In questo team esiste già un gruppo con questo nome.',
            memberCount: ({ count }: { count: number }) => `${count} membri`,
            managedBy: ({ source }: { source: string }) => `Gestito da ${source}`,
            membersSection: 'Membri del gruppo',
            addMember: 'Aggiungi al gruppo',
            removeNative: 'Rimuovi dal gruppo',
            removeMemberTitle: ({ name, group }: { name: string; group: string }) => `Rimuovere ${name} dal gruppo ${group}?`,
            removeMemberBody: ({ name, group }: { name: string; group: string }) => `${name} perde subito l’accesso che deriva da ${group}. Resta nel Team e puoi aggiungerla di nuovo a questo gruppo.`,
            externalOnlyTitle: 'Gestito alla sua origine',
            externalOnlyBody: ({ source }: { source: string }) => `${source} continua a fornire questa persona, che resta quindi nel gruppo. Modificalo nelle impostazioni di quell’origine.`,
            archiveAction: ({ name }: { name: string }) => `Archivia ${name}`,
            archiveTitle: ({ name }: { name: string }) => `Archiviare ${name}?`,
            archiveBody: 'L’accesso basato sul gruppo si interrompe subito. Appartenenza e cronologia vengono conservate, e ripristinare il gruppo può rendere di nuovo efficaci quelle autorizzazioni.',
            restoreAction: ({ name }: { name: string }) => `Ripristina ${name}`,
            archivedSection: 'Gruppi archiviati',
            archivedReadOnly: 'Questo gruppo è archiviato. Ripristinalo per modificarlo.',
            managedReadOnly: 'Il nome e il ciclo di vita di questo gruppo sono gestiti alla sua origine. Puoi comunque aggiungere membri qui.',
        },
        invitations: {
            waitingSection: "In attesa",
            finishedSection: "Concluse",
            sendAgain: "Invia di nuovo",
            emptyTitle: 'Nessun invito',
            emptyBody: 'Invita qualcuno con un link oppure aggiungi una persona che ha già un account su questo Home.',
            invite: 'Invita',
            inviteTitle: ({ team }: { team: string }) => `Invita in ${team}`,
            byLink: 'Collegamento',
            byEmail: 'E-mail',
            emailLabel: 'Indirizzo e-mail',
            emailPlaceholder: 'nome@esempio.com',
            create: 'Crea invito',
            linkNotice: ({ team, role }: { team: string; role: string }) => `Chiunque abbia effettuato l’accesso a questo Home e possieda questo link può entrare in ${team} come ${role}.`,
            copyLink: 'Copia collegamento',
            copied: 'Collegamento copiato',
            qrLabel: 'Codice QR di questo collegamento di invito',
            qrTooLargeFallback: 'Questo collegamento è troppo lungo per un codice QR. Copialo invece.',
            linkRow: 'Collegamento di invito',
            maskedRecipient: ({ email }: { email: string }) => `Per ${email}`,
            expires: ({ when }: { when: string }) => `Scade il ${when}`,
            stateActive: 'Attivo',
            stateAccepted: 'Accettato',
            stateRevoked: 'Revocato',
            stateExpired: 'Scaduto',
            deliverySent: 'E-mail inoltrata',
            deliveryFailed: 'Invio dell’e-mail non riuscito',
            deliveryUnknown: 'Esito dell’invio sconosciuto',
            deliveryRetry: 'Riprova',
            deliveryChangeEmail: 'Cambia e-mail',
            emailUnavailable: 'L’invio di e-mail non è disponibile su questo Home. Condividi un collegamento.',
            reissue: 'Crea un nuovo collegamento',
            reissueNotice: 'La riemissione crea un nuovo collegamento. Il collegamento precedente smetterà di funzionare.',
            revoke: 'Revoca invito',
            revokeTitle: 'Revocare questo invito?',
            revokeBody: 'Il collegamento smette subito di funzionare. Puoi crearne uno nuovo quando vuoi.',
            shareLink: 'Condividi collegamento',
            shareUnavailable: 'La condivisione non è disponibile su questo dispositivo. Copia invece il collegamento.',
            bearerUnavailable: 'Questo collegamento è stato mostrato una sola volta e non viene conservato. Creane uno nuovo per condividere di nuovo l’accesso.',
            linkUnavailableRow: 'Nessun collegamento condivisibile',
            linkUnavailableBody: 'Questo Home non ha pubblicato alcun indirizzo a cui i collegamenti d’invito possano puntare, quindi non c’è nulla da condividere. Chiedi a un amministratore del Home di pubblicarne uno, oppure aggiungi persone dall’elenco Persone della Team.',
        },
        join: {
            previewLoading: 'Verifica di questo invito…',
            joinAction: ({ team }: { team: string }) => `Entra in ${team}`,
            joinWithCurrentAccount: 'Entra con questo account',
            addInvitedAddressNotice: ({ email }: { email: string }) => `${email} verrà aggiunto a questo account come indirizzo verificato.`,
            useAnotherAccount: 'Usa un altro account',
            useCurrentAccount: 'Usa l’account attuale',
            useAnotherAccountHint: 'Accedi a questo Home senza disconnettere questo account.',
            hostedOn: ({ home }: { home: string }) => `Ospitato su ${home}`,
            personalHomeNotice: 'Questo Home funziona su un computer personale e può non essere disponibile mentre è offline.',
            plainStorageNotice: 'Le sessioni di questo Home sono archiviate senza cifratura end-to-end.',
            invitedBy: ({ name }: { name: string }) => `Invito inviato da ${name}.`,
            roleOffered: ({ role }: { role: string }) => `Sei invitato come ${role}.`,
            guestNotice: ({ team }: { team: string }) => `Entrare come ospite non dà accesso alle sessioni di team di ${team}. Gli elementi devono essere condivisi con te o con uno dei tuoi gruppi.`,
            joinedTitle: 'Hai aderito',
            alreadyMemberTitle: 'Sei già un membro',
            openTeam: ({ team }: { team: string }) => `Apri ${team}`,
            expiredTitle: 'Questo invito è scaduto',
            revokedTitle: 'Questo invito è stato revocato',
            usedTitle: 'Questo invito è già stato usato',
            archivedTitle: 'Questo team è archiviato',
            inactiveTitle: 'Questo account non può entrare in questo momento',
            invalidTitle: 'Questo collegamento di invito non è valido',
            unresolvedHomeTitle: 'Questo link non identifica il suo Home',
            unresolvedHomeBody: 'Questo dispositivo non riesce a capire quale Home ha emesso l’invito, quindi non è stato inviato nulla. Chiedi un nuovo link a chi gestisce il team.',
            unknownHomeTitle: 'Questo Home non è ancora su questo dispositivo',
            askForNew: 'Chiedi un nuovo invito a un responsabile del team.',
            mismatchTitle: 'Questo invito è per un altro indirizzo',
            signInWithInvited: 'Accedi con l’indirizzo invitato',
            verifyAddress: 'Verifica questo indirizzo',
            updateRequiredTitle: 'Questo Home richiede un aggiornamento per gli inviti ai team',
            offlineTitle: 'Questo Home non è raggiungibile',
            offlineBody: 'L’invito viene conservato. Riprova quando il Home sarà di nuovo disponibile.',
            acceptanceOutcomeUnknown: 'Non è stato possibile confermare la tua adesione. Riprova per verificare lo stesso invito.',
            retry: 'Riprova',
        },
        credentials: {
            recovery: {
                openSettings: 'Apri le impostazioni della credenziale',
                selectBroker: 'Scegli una posizione del broker',
                ownerHandoff: 'Chiedi al proprietario della fonte di riparare questa credenziale',
                updateApp: 'Aggiorna Happier',
                chooseAnother: 'Scegli un\u2019altra credenziale',
            },
            requestPolicy: {
                title: 'Criteri di richiesta',
                subtitle: 'Limita ciò che si può chiedere a questa credenziale.',
                summaryNone: 'Nessuna restrizione',
                summaryActive: ({ count }: { count: number }) => `${count} restrizioni`,
                protocolsLabel: 'Formati di richiesta',
                protocolsAny: 'Tutti quelli supportati dalla fonte',
                modelsLabel: 'Modelli',
                modelsAny: 'Tutti i modelli offerti dalla fonte',
                modelsAllowed: ({ count }: { count: number }) => `${count} consentiti`,
                effortLabel: 'Sforzo di ragionamento',
                effortAny: 'Tutti quelli supportati dalla fonte',
                catalogUnavailable: 'Scegliere quali modelli sono consentiti non è ancora possibile da questo Home. Le scelte attuali restano valide finché non vengono rimosse.',
                clear: 'Rimuovi tutte le restrizioni',
                activeNote: 'Una sessione già in corso non viene riscritta. La sua prossima richiesta dovrà rispettare i nuovi criteri.',
                protocol: {
                    openaiResponses: 'OpenAI Responses',
                    openaiChatCompletions: 'OpenAI Chat Completions',
                    anthropicMessages: 'Anthropic Messages',
                },
            },
            directReadiness: {
                title: 'Preparazione dell’accesso diretto',
                check: 'Verifica la preparazione',
                summary: ({ ready, pending }: { ready: number; pending: number }) => `${ready} pronti · ${pending} in preparazione`,
                allReady: 'Tutte le persone con accesso diretto sono pronte.',
                automatic: 'Il materiale viene preparato sul computer che detiene questa fonte, non appena è online.',
                state: {
                    ready: 'Pronto',
                    preparing: 'Preparazione dell’accesso',
                    notDelivered: 'Non ancora consegnato',
                    recipientBindingChanged: 'In attesa della configurazione dell’account cifrato',
                    sourceChanged: 'Fonte cambiata: aggiornamento in corso',
                },
            },
            externalApi: {
                title: 'Accesso API esterno',
                subtitle: 'Usa questo provider da strumenti compatibili fuori da Happier.',
                privateTitle: 'Sessioni Happier',
                privateDetail: 'Privato tramite Happier',
                unavailable: 'L’accesso API esterno non è disponibile su questo Home.',
                publicHttpsRequired: 'Gli strumenti esterni richiedono un indirizzo HTTPS pubblico per questo Home.',
                homeDisclosure: 'I corpi non elaborati delle richieste al provider passano dall’endpoint HTTPS pubblico di questo Home e possono essere letti dal suo operatore.',
                bearerDisclosure: 'Questa chiave è un segreto bearer. Chiunque la possieda può usare l’accesso assegnato finché non scade o viene revocata.',
                usageDisclosure: 'Happier registra il numero di richieste. I totali di token e costi possono essere incompleti se un protocollo non li comunica.',
                keysTitle: 'Chiavi API',
                authorize: 'Autorizza chiave',
                authenticationRequired: 'Il membro assegnato deve autorizzare questa chiave con il proprio accesso al team.',
                authenticationUnavailable: 'L’autenticazione del team non è disponibile. Chiedi a un amministratore di verificare i criteri di accesso.',
                keysLoadFailed: 'Impossibile caricare le chiavi API.',
                keysRetry: 'Riprova a caricare le chiavi',
                keysEmpty: 'Ancora nessuna chiave',
                keysEmptyBody: 'Creare la prima chiave attiva l’accesso esterno; revocare l’ultima lo disattiva.',
                labelPlaceholder: 'A cosa serve questa chiave',
                assignLabel: 'Attribuita a',
                revealTitle: 'Salva subito questa chiave',
                revealBody: 'Non verrà mostrata di nuovo.',
                revealDismiss: {
                    title: 'Chiudere senza copiare la chiave?',
                    body: 'Questa chiave non potrà essere mostrata di nuovo. Lasciala visibile finché non l’hai salvata.',
                    confirm: 'Ho salvato la chiave',
                    keepVisible: 'Mantieni visibile la chiave',
                },
                neverUsed: 'Mai usata',
                lastUsed: ({ when }: { when: string }) => `Ultimo uso ${when}`,
                expiresOn: ({ when }: { when: string }) => `Scade ${when}`,
                expired: 'Scaduta',
                revokeTitle: ({ name }: { name: string }) => `Revocare ${name}?`,
                revokeBody: 'Gli strumenti che usano questa chiave smettono subito di funzionare. Le sessioni Happier non sono interessate.',
                revokeAll: 'Revoca tutte le chiavi',
                revokeAllBody: 'L’accesso API esterno si disattiva finché non viene creata una nuova chiave. Le sessioni Happier non sono interessate.',
            },
            title: 'Credenziali condivise',
            subtitle: 'Consenti a questo team di usare un account collegato, un pool o un provider senza copiarlo nella configurazione di ogni persona.',
            emptyTitle: 'Nessuna credenziale condivisa',
            emptyBody: 'Non \u00e8 ancora stato condiviso nulla con questo team.',
            forbidden: 'Le credenziali condivise sono gestite dai proprietari e dagli amministratori del team.',
            unavailable: 'Questo Home non offre credenziali condivise.',
            approvalPending: 'In attesa di approvazione. Le modifiche restano salvate fino alla decisione.',
            approvalDeclined: 'La richiesta non è stata approvata, quindi non è cambiato nulla.',
            sessionDeniedTitle: 'Una credenziale condivisa ha rifiutato questa richiesta',
            sharedByYou: 'Condivisa da te',
            providedByTeams: 'Fornito dai team',
            sharedWithYou: 'Condiviso con te',
            sourceAdministration: { title: 'Condiviso con i team', empty: 'Questa origine non \u00e8 condivisa con alcun team.' },
            source: {
                connectedAccount: 'Account collegato',
                pool: 'Pool di servizi connessi',
                providerConnection: 'Connessione provider',
            },
            delivery: {
                brokered: 'Tramite broker',
                direct: 'Accesso diretto',
                both: 'Broker + diretto',
                mixed: 'Consegna mista',
            },
            state: {
                available: 'Disponibile',
                needsAttention: 'Richiede attenzione',
                disabled: 'Disattivata',
            },
            usePolicy: {
                title: 'Condividere questa sessione con il Team?',
                label: 'Dove i membri possono usarla',
                personalAllowed: 'Qualsiasi sessione consentita',
                teamContextRequired: 'Sessioni il cui team \u00e8 questo',
                teamVisibilityRequired: 'Sessioni che questo team pu\u00f2 vedere',
                visibilityNote: 'Scegliere questa credenziale pu\u00f2 condividere una sessione privata con il team dopo la conferma della persona.',
            },
            selection: {
                activeTransitionUnsupported: 'Questa sessione è partita prima che la modifica venisse salvata, quindi il modello non è cambiato. Riprova.',
            },
            detail: {
                sourceLabel: 'Origine',
                brokerLabel: 'Posizione del broker',
                brokerNone: 'Scegli una posizione del broker',
                access: 'Accesso e consegna',
                activity: 'Attivit\u00e0',
                edit: 'Modifica',
                notFound: 'Questa credenziale condivisa non \u00e8 pi\u00f9 disponibile.',
                brokerUnnamedMachine: 'Computer senza nome',
                brokerUnnamedPool: 'Pool senza nome',
                brokerChosen: 'Scelta da chi possiede la fonte',
                limits: 'Massimali',
                usage: 'Consumo',
            },
            create: {
                title: 'Condividi una credenziale',
                action: 'Condividi credenziale',
                submit: 'Crea credenziale condivisa',
                sourceChoose: 'Scegli una fonte',
                sourceEmpty: 'Non c’è ancora nulla da condividere.',
                sourceUnsupported: 'Gli account collegati e le connessioni di provider non si possono ancora condividere da questo Home.',
                alreadyShared: 'Già condivisa con questo team',
                poolAccounts: ({ count }: { count: number }) => `${count} account collegati`,
                notAllowed: 'Questo team non ti permette di offrire una credenziale tua.',
                reviewLabel: 'Riepilogo',
            },
            edit: {
                title: 'Modifica credenziale condivisa',
                nameLabel: 'Nome',
                namePlaceholder: 'Dai un nome a questa credenziale',
                ceilingLabel: 'Divulgazione diretta',
                ceilingBrokeredOnly: 'Solo tramite broker',
                ceilingDirectAllowed: 'Consenti accesso diretto',
                ceilingNote: 'L\u2019accesso diretto permette agli strumenti locali di chi riceve di ottenere materiale di credenziale. Rimuovere l\u2019accesso ferma le consegne future, ma non cancella ci\u00f2 che un processo esterno ha gi\u00e0 usato.',
                conflict: 'Queste impostazioni sono cambiate altrove. Ricarica per vedere i valori attuali prima di salvare.',
            },
            audience: {
                title: 'Accesso e consegna',
                none: 'Ancora nessuno',
                everyone: 'Tutto il team',
                everyoneOff: 'Nessun accesso per tutto il team',
                groupCount: ({ count }: { count: number }) => `${count} gruppi`,
                memberCount: ({ count }: { count: number }) => `${count} persone`,
                add: 'Aggiungi un gruppo o una persona',
                groupsSection: 'Gruppi',
                membersSection: 'Persone',
                remove: 'Rimuovi accesso',
                ceilingBlocked: 'L\u2019accesso diretto non \u00e8 consentito per questa credenziale. Consentilo prima in Modifica.',
                directTitle: 'Condividere direttamente questa credenziale?',
                directBody: 'Gli strumenti locali delle persone che scegli possono ricevere materiale di credenziale di questa origine. Rimuovere l\u2019accesso ferma le consegne future, ma non cancella ci\u00f2 che un processo esterno ha gi\u00e0 usato.',
                directConfirm: 'Condividi direttamente',
                keepBrokered: 'Mantieni tramite broker',
                limitsNote: 'L\u2019uso diretto avviene fuori da Happier e non viene registrato.',
            },
            directUse: {
                title: 'Usare direttamente questa credenziale condivisa?',
                body: 'Happier pu\u00f2 fornire il materiale della credenziale agli strumenti locali usati da questa sessione. Continua solo se ti fidi di questi strumenti con questa credenziale.',
            },
            delete: {
                action: 'Elimina credenziale condivisa',
                title: ({ name }: { name: string }) => `Eliminare ${name}?`,
                body: 'I membri perdono subito l\u2019accesso e la richiesta successiva fallisce. Il materiale gi\u00e0 consegnato direttamente non pu\u00f2 essere cancellato.',
            },
            errors: {
                featureDisabled: 'Questo Home non offre credenziali condivise.',
                teamAuthenticationRequired: 'Accedi a questo team prima di continuare.',
                teamAuthenticationPolicyUnavailable: 'Non \u00e8 stato possibile leggere la politica di accesso di questo team, quindi non \u00e8 cambiato nulla.',
                memberNotEligible: 'Questa persona non pu\u00f2 usare questa credenziale.',
                sessionPolicyIncompatible: 'Questa credenziale non pu\u00f2 essere usata in questa sessione con la sua politica di condivisione.',
                brokerUnavailable: 'La macchina broker di questa credenziale non è raggiungibile in questo momento. Riprova quando torna oppure scegli un’altra posizione.',
                sourceOwnerRequired: 'Solo chi possiede questa fonte può fare questa modifica.',
                sourceMissing: 'Questa credenziale non punta più a una fonte esistente. Chi la possiede deve sceglierla di nuovo.',
                invalidAudience: 'Quelle persone o quei gruppi non possono ricevere questa credenziale.',
                subjectNotInTeam: 'Quella persona o quel gruppo non fa più parte di questo team.',
                costUnavailable: 'Un massimale di costo richiede un prezzo per ogni modello consentito e ad alcuni manca. Limita invece le richieste o i token.',
                invalidLimit: 'Controlla la misura, il periodo e il massimo.',
                limitIdentityImmutable: 'A chi si applica un massimale, che cosa misura e il suo periodo non si possono cambiare. Rimuovilo e creane uno nuovo.',
            },
            limits: {
                groupShared: 'Questa quantit\u00e0 \u00e8 condivisa da tutti nel Gruppo.',
                title: 'Massimali',
                empty: 'Nessun massimale',
                emptyBody: 'Ogni richiesta è consentita finché non ne aggiungi uno.',
                overshoot: 'Le nuove richieste si fermano quando il consumo registrato raggiunge il massimale. Quelle già in corso possono concludersi.',
                directNote: 'I massimali coprono l’uso tramite broker e l’API esterna. L’uso diretto avviene sulla macchina di chi riceve e non viene registrato.',
                directOnly: 'Tutte le persone con accesso usano questa credenziale in modo diretto, sulla propria macchina: Happier non ne registra nulla e nessun massimale può valere.',
                requestLimitsOnlyForPersonalUse: 'I massimali di token compaiono quando questa credenziale richiede un contesto di team. L’uso personale la apre anche alle esecuzioni in background e all’API esterna, che riportano solo le richieste: solo i massimali di richieste coprono quindi ogni uso.',
                add: 'Aggiungi massimale',
                subjectLabel: 'Si applica a',
                subject: {
                    resource: 'Intera credenziale condivisa',
                    eachMember: 'Ogni persona separatamente',
                    group: 'Gruppo',
                    member: 'Persona',
                },
                metricLabel: 'Misura',
                metric: {
                    requests: 'Richieste',
                    tokens: 'Token',
                    cost: 'Costo',
                },
                costNote: 'Un massimale di costo funziona solo se ogni modello consentito ha un prezzo noto.',
                periodLabel: 'Periodo',
                period: {
                    day: 'Giornaliero',
                    week: 'Settimanale',
                    month: 'Mensile',
                },
                maximumLabel: 'Massimo',
                maximumPlaceholder: 'Massimo per periodo',
                maximumInvalid: 'Inserisci un numero intero maggiore di zero.',
                maximumInvalidCost: 'Inserisci un importo maggiore di zero.',
                recorded: ({ recorded, maximum }: { recorded: string; maximum: string }) => `${recorded} su ${maximum} registrato`,
                resetsUtc: ({ when }: { when: string }) => `Si azzera il ${when} UTC`,
                reached: 'Massimale raggiunto',
                disabled: 'Disattivato',
                remove: 'Rimuovi massimale',
                removeTitle: 'Rimuovere questo massimale?',
                removeBody: 'Le richieste smettono subito di essere confrontate con esso. Il consumo registrato viene conservato.',
                unknownSubject: 'Qualcuno fuori da questa pagina',
            },
            usage: {
                title: 'Consumo',
                empty: 'Nessun dato registrato in questo periodo.',
                rangeLabel: 'Periodo',
                brokeredRequests: 'Richieste intermediate',
                directOnlyRequests: 'Le richieste vengono conteggiate solo per l’uso intermediato.',
                recordedRequests: 'Richieste registrate',
                requestIncomplete: 'Sono incluse solo le richieste osservate da Happier.',
                externalObservationsIncomplete: ({ count }: { count: number }) => `${count} ${count === 1 ? 'richiesta esterna non ha' : 'richieste esterne non hanno'} ancora un risultato registrato.`,
                breakdownRestricted: 'Alcune suddivisioni sono visibili solo a chi gestisce le credenziali.',
                export: 'Esporta CSV',
                exportFailed: 'Questo dispositivo non è riuscito a salvare l’esportazione.',
                recordedByHappier: 'Registrato da Happier.',
                directIncomplete: 'L’uso diretto avviene fuori da Happier e potrebbe non essere incluso.',
                costIncomplete: 'Il costo non è disponibile per alcuni modelli in questo periodo.',
                tokenIncomplete: 'Il totale dei token è incompleto per questo periodo.',
                tokenUnavailable: 'Non è stato osservato alcun uso di token in questo periodo.',
                costUnavailable: 'Non è stato osservato alcun uso con prezzo in questo periodo.',
                costUnknown: 'Non disponibile',
                breakdownLabel: 'Suddividi per',
                breakdownNone: 'Solo totali',
                breakdown: {
                    member: 'Persona',
                    externalApiKey: 'Chiave API esterna',
                    model: 'Modello',
                    session: 'Sessione',
                    sourceMember: 'Account di origine',
                    workerMachine: 'Macchina di lavoro',
                    brokerMachine: 'Macchina broker',
                    deliveryMode: 'Consegna',
                },
                limitsTitle: 'Massimali in questo periodo',
                sliceSummary: ({ requests, tokens }: { requests: string; tokens: string }) => `${requests} richieste · ${tokens} token`,
            },
            activity: {
                title: 'Attivit\u00e0',
                empty: 'Nessuna modifica amministrativa registrata.',
                unknownActor: 'Qualcuno',
                kind: {
                    resourceCreated: 'Ha condiviso questa credenziale',
                    resourceUpdated: 'Ha cambiato le impostazioni',
                    audienceChanged: 'Ha cambiato chi pu\u00f2 usarla',
                    resourceDeleted: 'Ha eliminato questa credenziale',
                    directDelivered: 'Ha consegnato l\u2019accesso diretto',
                    externalKeyCreated: 'Ha creato una chiave API esterna',
                    externalKeyRevoked: 'Ha revocato una chiave API esterna',
                    limitsChanged: 'Ha cambiato i limiti',
                },
            },
        },
    },
};

const teamsTranslations = { it: italian };

return { teamsTranslations };
})();

const Domain_terminalWorkspaceTranslations = (() => {
const en = Shared_terminalWorkspaceTranslations.en;

const terminalWorkspaceKeyboardTranslations = Shared_terminalWorkspaceTranslations.terminalWorkspaceKeyboardTranslations;

const terminalWorkspaceTranslations = { it: en };

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

const it: ThisComputerConnectionTranslation = {
    connectHome: {
        title: ({ home }: HomeParams) => `Collegare questo computer a ${home}?`,
        body: ({ home }: HomeParams) => `${home} potrà avviare sessioni su questo computer. Il Home del terminale e le altre connessioni restano attivi.`,
        connect: 'Collega',
        keep: 'Mantieni le connessioni attuali',
    },
    setupAlreadyRunning: 'È già in corso una configurazione. Attendi che termini.',
    title: {
        daemon_url_mismatch: 'Il servizio in background è su un altro Home',
        daemon_account_mismatch: 'Il servizio in background usa un altro account',
        daemon_needs_auth: 'Il servizio in background deve accedere',
        daemon_not_configured: 'Il servizio in background non è ancora connesso',
        daemon_not_installed: 'Il servizio in background non è installato',
        daemon_not_running: 'Il servizio in background è fermo',
    },
    description: {
        daemon_url_mismatch: ({ home, daemonHome }: OtherHomeParams) => `È connesso a ${daemonHome}, non a ${home}.`,
        daemon_account_mismatch: ({ home, daemonAccount, appAccount }: AccountParams) =>
            `Ha effettuato l’accesso a ${home} come ${daemonAccount}, non come ${appAccount}.`,
        daemon_needs_auth: ({ home }: HomeParams) => `È connesso a ${home} ma non è ancora stato approvato.`,
        daemon_not_configured: ({ home }: HomeParams) => `Non ha ancora finito di connettersi a ${home}.`,
        daemon_not_installed: ({ home }: HomeParams) => `Installalo per connettere questo computer a ${home}.`,
        daemon_not_running: ({ home }: HomeParams) => `Avvialo per riconnetterti a ${home}.`,
    },
    action: {
        daemon_url_mismatch: 'Connetti a questo Home',
        daemon_account_mismatch: ({ appAccount }: { appAccount: string }) => `Passa a ${appAccount}`,
        daemon_needs_auth: 'Accedi',
        daemon_not_configured: 'Connetti a questo Home',
        daemon_not_installed: 'Installa il servizio in background',
        daemon_not_running: 'Avvia il servizio in background',
    },
    connected: ({ home, appAccount }: { home: string; appAccount: string }) => `Connesso a ${home} come ${appAccount}.`,
    noComputers: ({ home, appAccount }: { home: string; appAccount: string }) => `${appAccount} non ha ancora computer su ${home}.`,
    openThisComputer: 'Controlla questo computer',
    moveConfirm: {
        title: ({ appAccount }: { appAccount: string }) => `Passare questo computer a ${appAccount}?`,
        body: ({ home, daemonHome, daemonAccount, appAccount }: MoveParams) =>
            `Il suo servizio in background ha effettuato l’accesso a ${daemonHome} come ${daemonAccount}. Dopo il passaggio lavorerà per ${appAccount} su ${home} e ${daemonAccount} non vedrà più questo computer.`,
        confirm: 'Passa',
    },
    cli: {
        title: 'CLI di Happier',
        version: ({ version }: { version: string }) => `Versione ${version}`,
        updateAvailable: ({ version, latestVersion }: { version: string; latestVersion: string }) =>
            `Versione ${version} · ${latestVersion} disponibile`,
        update: 'Aggiorna',
        progressTitle: 'Aggiornamento della CLI di Happier',
        notManaged: ({ origin }: { origin: string }) => `Installata al di fuori di Happier: ${origin}`,
    },
    cliChoice: {
        title: ({ version }: { version: string }) => `La CLI di Happier ${version} è già installata`,
        titleUnknownVersion: 'La CLI di Happier è già installata',
        titleMissing: 'La tua CLI di Happier non è più installata',
        body: ({ path }: { path: string }) => `Si trova in ${path}. Happier può installare una propria copia, tenerla aggiornata e metterla per prima nel PATH, oppure puoi continuare a usare questa.`,
        bodyOutdated: ({ path }: { path: string }) => `Si trova in ${path} ed è troppo vecchia per la configurazione. Happier può installare una propria copia aggiornata e metterla per prima nel PATH, oppure puoi tenere la tua e aggiornarla tu.`,
        bodyMissing: ({ path }: { path: string }) => `Avevi scelto di tenere quella in ${path}, ma non c’è più. Happier può installare una propria copia e tenerla aggiornata, oppure puoi reinstallare la tua e continuare a usarla.`,
        bodyKeepBlocked: ({ path, link }: { path: string; link: string }) => `Si trova in ${path}, ma i nuovi terminali eseguono prima la CLI di Happier tramite ${link}, che Happier non ha aggiunto. Lascia che la gestisca Happier, oppure rimuovi ${link} e riavvia la configurazione per tenere la tua.`,
        notNow: 'Non ora',
        manage: 'Lascia che la gestisca Happier',
        keep: 'Tieni la mia',
        unanswered: 'La configurazione si è fermata prima di modificare qualcosa. Scegli chi gestisce la riga di comando per continuare.',
        ownMissing: 'La riga di comando che hai tenuto non è più installata. Reinstallala oppure lascia che sia Happier a gestire la riga di comando.',
        managed: 'Gestita da Happier',
        own: ({ path }: { path: string }) => `La tua — ${path}`,
        change: 'Cambia chi gestisce la riga di comando',
        keptUpdateTitle: 'Aggiorna la tua riga di comando',
        keptUpdate: ({ command }: { command: string }) => `È disponibile una versione più recente. Aggiornala con ${command}`,
        oldCopyTitle: 'Vecchia riga di comando',
        oldCopyRemove: ({ path, command }: { path: string; command: string }) => `Ancora installata in ${path}. Rimuovila con ${command}`,
        oldCopyPath: ({ path }: { path: string }) => `Ancora installata in ${path}.`,
    },
    servers: {
        title: 'Home serviti da questo computer',
        connected: 'Connesso',
        offline: 'Configurato · Non attivo',
        attention: 'Richiede attenzione',
        currentHome: ({ home }: HomeParams) => `${home} · questo Home`,
    },
    removal: {
        uninstallFailedTitle: 'Impossibile scollegare questo computer',
        uninstallFailedBody: ({ home }: HomeParams) => `Non è stato possibile rimuovere il servizio in background di questo computer per ${home}, quindi ${home} è stato mantenuto. Riprova oppure rimuovi il servizio da Impostazioni › Questo computer.`,
        inventoryUnavailableTitle: 'Impossibile controllare questo computer',
        inventoryUnavailableBody: ({ home }: HomeParams) => `Happier non è riuscito a leggere i servizi in background di questo computer, quindi non sa se questo computer serve ancora ${home}. Rimuoverlo comunque da Happier?`,
        removeAnyway: 'Rimuovi comunque',
        userOwnedTitle: 'Questo computer continua a servirlo',
        userOwnedBody: ({ home, service }: RemovalServiceParams) => `${service} è stato installato fuori da Happier, quindi continua a funzionare per ${home}. Rimuovilo dal terminale se non ti serve più.`,
    },
};

const thisComputerConnectionTranslations = { it };

return { thisComputerConnectionTranslations };
})();

const Domain_transcriptFindTranslations = (() => {
const transcriptFindTranslations = { it: { searchOlder: 'Cerca nei messaggi precedenti', partialErrors: 'Non è stato possibile cercare in alcuni contenuti. I risultati sono incompleti.', olderRemaining: 'Restano messaggi precedenti da cercare.', findOpen: 'Apri ricerca', findNext: 'Corrispondenza successiva', findPrevious: 'Corrispondenza precedente' } } as const;

return { transcriptFindTranslations };
})();

const Domain_turnChangesTranslations = (() => {
type TurnChangesTranslations = Shared_turnChangesTranslations.TurnChangesTranslations;

const en = Shared_turnChangesTranslations.en;

const translated = Shared_turnChangesTranslations.translated;

const turnChangesTranslations = { it: {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `${count} ${count === 1 ? 'file modificato' : 'file modificati'}`,
                walkThrough: 'Spiegamelo',
                openInFiles: 'Apri in File',
                fileCount: ({ count }) => `${count} file`,
                fileCountInFolders: ({ count, folders }) => `${count} file in ${folders} cartelle`,
                showMore: ({ count }) => `Mostra altri ${count}`,
                groupA11y: 'Modifiche in questo turno',
            }),
        },
    } } as const;

return { turnChangesTranslations };
})();

const Domain_voiceDiagnosticsConsentTranslations = (() => {
type VoiceDiagnosticsConsentCopy = Shared_voiceDiagnosticsConsentTranslations.VoiceDiagnosticsConsentCopy;

const defineVoiceDiagnosticsConsentTranslation = Shared_voiceDiagnosticsConsentTranslations.defineVoiceDiagnosticsConsentTranslation;

const voiceDiagnosticsConsentTranslations = { it: defineVoiceDiagnosticsConsentTranslation({
    consentTitle: 'Registrare l’audio vocale su questo dispositivo?',
    consentBody: 'L’audio vocale può contenere conversazioni private e suoni di sottofondo. I file restano sul dispositivo, usano autorizzazioni private, scadono automaticamente e non vengono mai sincronizzati né allegati ad analisi o segnalazioni di arresti anomali.',
    consentAction: 'Attiva registrazione',
  }) } as const;

return { voiceDiagnosticsConsentTranslations };
})();

const Domain_voiceDiagnosticsTranslations = (() => {

type VoiceDiagnosticsCopy = Shared_voiceDiagnosticsTranslations.VoiceDiagnosticsCopy;

const voiceDiagnosticsConsentTranslations = {...Domain_voiceDiagnosticsConsentTranslations.voiceDiagnosticsConsentTranslations};

const defineVoiceDiagnostics = Shared_voiceDiagnosticsTranslations.defineVoiceDiagnostics;

const voiceDiagnosticsTranslations = { it: defineVoiceDiagnostics(voiceDiagnosticsConsentTranslations["it"].diagnostics, {
    title: 'Diagnostica vocale locale',
    footer: 'Disattivata per impostazione predefinita. L’audio resta sulla macchina selezionata finché non lo esporti esplicitamente.',
    enabled: 'Registra audio diagnostico locale',
    enabledSubtitle: 'Conserva localmente input STT e output TTS limitati per la risoluzione dei problemi',
    sttInput: 'Registra l’input del riconoscimento vocale',
    ttsOutput: 'Registra la voce sintetizzata',
    location: 'Percorso di archiviazione',
    unavailable: 'Macchina selezionata non disponibile',
    retention: 'Limiti di conservazione',
    retentionDetail: ({ hours, files, megabytes }) => `${hours} ore · ${files} file · ${megabytes} MB`,
    deleteAll: 'Elimina tutto l’audio diagnostico',
    deleteAllSubtitle: 'Rimuove subito audio e metadati dalla macchina selezionata',
    deleteConfirmTitle: 'Eliminare tutta la diagnostica vocale locale?',
    deleteConfirmBody: 'Questa azione rimuove definitivamente ogni artefatto di diagnostica vocale sulla macchina selezionata.',
    deleteAction: 'Elimina tutto',
    deleteFailed: 'Non è stato possibile eliminare le registrazioni diagnostiche locali. Potrebbero essere ancora sulla macchina selezionata.',
    cleanupRequired: 'La pulizia della diagnostica locale richiede attenzione',
    cleanupRequiredSubtitle: 'Alcuni file diagnostici privati potrebbero essere rimasti oppure non è stato possibile leggere il catalogo locale. Riprova la pulizia o elimina tutto l’audio diagnostico.',
    captureFailed: 'L’acquisizione diagnostica richiede attenzione',
    captureFailedSubtitle: 'Non è stato possibile leggere o salvare l’ultima acquisizione audio diagnostica. Non è stato rilevato alcun file diagnostico residuo; lo stato verrà verificato di nuovo alla prossima acquisizione vocale idonea.',
    retryCleanup: 'Riprova la pulizia diagnostica',
    retryCleanupSubtitle: 'Ricontrolla l’archivio privato e riapplica i suoi limiti di conservazione',
    cleanupRetryFailed: 'Non è stato possibile completare la pulizia. I file diagnostici potrebbero essere ancora sulla macchina selezionata; riprova o elimina tutto dopo che si è riconnessa.',
    exportTitle: 'Esporta la diagnostica selezionata',
    noArtifacts: 'Nessuna registrazione diagnostica conservata sulla macchina selezionata.',
    exportSttArtifact: 'Esporta l’input del riconoscimento vocale',
    exportTtsArtifact: 'Esporta la voce sintetizzata',
    exportArtifactAccessibility: 'Esporta questa registrazione diagnostica vocale locale',
    exportConfirmTitle: 'Esportare questa registrazione privata?',
    exportConfirmBody: 'La registrazione selezionata viene copiata dalla macchina selezionata a questo dispositivo tramite un trasferimento cifrato una tantum. Non viene mai caricata automaticamente.',
    exportAction: 'Esporta registrazione',
    exportFailed: 'Non è stato possibile esportare la registrazione privata. Non è stato caricato nulla.',
    backupPolicy: 'Esclusione dai backup',
    backupPolicyBestEffort: 'Archiviato nella cache privata della macchina selezionata e contrassegnato per gli strumenti di backup che rispettano lo standard delle directory di cache. Non è implementato alcun caricamento o sincronizzazione automatica; l’esclusione dai backup del sistema operativo non è garantita.',
    activeIndicator: 'Diagnostica vocale attiva',
    checkingIndicator: 'Verifica dello stato della diagnostica vocale',
    statusUnknownIndicator: 'Lo stato della diagnostica vocale è sconosciuto',
    shutdownPendingIndicator: 'Arresto della diagnostica vocale',
    shutdownFailedIndicator: 'Non è stato possibile confermare la disattivazione della diagnostica vocale',
    retryShutdown: 'Riprova ad arrestare la diagnostica',
    sessionOptOut: 'Non registrare questa sessione',
    sessionOptOutConfirmTitle: 'Interrompere la registrazione di questa sessione?',
    sessionOptOutConfirmBody: 'La diagnostica vocale resta attiva per le altre sessioni, ma non verrà registrato nuovo audio di questa sessione fino al riavvio dell’app.',
    sessionOptOutFailed: 'Non è stato possibile interrompere la registrazione sulla macchina attiva. Questa sessione potrebbe essere ancora registrata; riprova dopo la riconnessione della macchina.',
    sessionOptOutRetry: 'Riprova a interrompere la registrazione',
  }) } as const;

return { voiceDiagnosticsTranslations };
})();

const Domain_voiceExternalCredentialApprovalTranslations = (() => {
type VoiceExternalCredentialApprovalCopy = Shared_voiceExternalCredentialApprovalTranslations.VoiceExternalCredentialApprovalCopy;

const defineVoiceExternalCredentialApproval = Shared_voiceExternalCredentialApprovalTranslations.defineVoiceExternalCredentialApproval;

const voiceExternalCredentialApprovalTranslations = { it: defineVoiceExternalCredentialApproval({
    reviewRequired: 'Verifica l’accesso alle credenziali',
    recipientApprovalTitle: 'Consentire a questo provider di usare la tua credenziale?',
    recipientApprovalBody: 'Verifica e approva gli endpoint e le operazioni dichiarati dal provider. Se quel contratto del destinatario cambia, Happier mantiene la tua selezione ma blocca l’uso della credenziale finché non la approvi di nuovo.',
    recipientApprovalPackage: ({ title, pluginId, sourceKind, sourceLocator }) =>
      `Pacchetto: ${title} (${pluginId}); origine: ${sourceKind} ${sourceLocator}`,
    recipientApprovalPublisher: ({ trust, identity }) => `Editore: ${identity} (${trust})`,
    recipientApprovalPackageSignature: ({ status, keyId }) => `Firma del pacchetto: ${keyId} (${status})`,
    recipientApprovalContribution: ({ pluginId, localId }) => `Contributo: ${pluginId}/${localId}`,
    recipientApprovalOperations: 'Operazioni dichiarate:',
    recipientApprovalOperation: ({ id, purpose, effect }) =>
      `Operazione ${id}: finalità ${purpose}; effetto ${effect}`,
    recipientApprovalRequest: ({ method, origin, pathTemplate }) => `Richiesta: ${method} ${origin}${pathTemplate}`,
    recipientApprovalCredential: ({ headerName, format }) =>
      `Intestazione della credenziale: ${headerName}; formato: ${format}`,
    recipientApprovalBounds: ({ requestMaxBytes, responseMaxBytes }) =>
      `Limiti di byte: richiesta ${requestMaxBytes}; risposta ${responseMaxBytes}`,
    recipientApprovalTrust: { bundled: 'integrato', verified: 'verificato' },
    recipientApprovalEffect: { read: 'lettura', mutation: 'modifica' },
    recipientApprovalCredentialFormat: { raw: 'grezzo', bearer: 'bearer' },
    recipientApprovalConfirm: 'Approva e salva',
  }) } as const;

return { voiceExternalCredentialApprovalTranslations };
})();

const Domain_voiceLocalCredentialTranslations = (() => {
type VoiceLocalCredentialCopy = Shared_voiceLocalCredentialTranslations.VoiceLocalCredentialCopy;

const defineVoiceLocalCredential = Shared_voiceLocalCredentialTranslations.defineVoiceLocalCredential;

const voiceLocalCredentialTranslations = { it: defineVoiceLocalCredential({
    voiceCredential: {
      setOnAccount: 'Salvata nel tuo account',
      notSetOnAccount: 'Non salvata nel tuo account',
      setOnMachineOverride: ({ machine }) => `Per ${machine} è in uso una sostituzione della credenziale dell’account`,
      notSetWithFallback: ({ machine }) => `Non impostata per ${machine}; quando disponibile verrà usata una credenziale dell’account`,
      plainStorageTitle: 'Salvare la chiave API senza crittografia end-to-end?',
      plainStorageBody: 'Questo account archivia le impostazioni senza crittografia end-to-end. Salvando questa chiave API il suo testo in chiaro sarà visibile al server.',
      plainStorageConfirm: 'Salva chiave API',
      deleteAccountBody: 'Rimuovere questa chiave API salvata? Gli altri collegamenti che fanno riferimento allo stesso segreto salvato la mantengono.',
      machineUnavailable: 'Seleziona una macchina di esecuzione vocale online',
      machineUnavailableTitle: 'Macchina vocale non disponibile',
      machineUnavailableBody: 'Scegli una macchina di esecuzione vocale online prima di salvare o usare questa credenziale.',
      statusUnavailable: ({ machine }) => `Stato della credenziale non disponibile su ${machine}. Tocca per riprovare.`,
      importAvailable: ({ machine }) => `Chiave precedente disponibile per l’importazione su ${machine}`,
      notSetOnMachine: ({ machine }) => `Non impostata su ${machine}`,
      setOnMachine: ({ machine, protection }) => `Impostata su ${machine} · ${protection}`,
      protection: { osProtected: 'Protetta dal sistema operativo', filePermissions: 'Protetta dai permessi dei file' },
      importTitle: 'Importare la chiave API esistente?',
      importBody: ({ machine }) => `Copia l’impostazione dell’account cifrata esistente su ${machine}. L’originale resta disponibile per i tuoi altri dispositivi.`,
      importAction: 'Importa',
      enterNewAction: 'Inserisci nuova',
      useSavedSecretTitle: 'Usa un segreto salvato',
      useSavedSecretSubtitle: 'Scegli una chiave già memorizzata in questo account.',
      replaceOrRemoveBody: 'Inserisci una nuova chiave API oppure lascia il campo vuoto per rimuovere la chiave da questa macchina.',
      deleteTitle: 'Rimuovere la chiave API?',
      deleteBody: ({ machine }) => `Rimuovere questa chiave API da ${machine}? Il vecchio valore condiviso tra dispositivi, se presente, non viene modificato.`,
      operationFailed: 'La macchina selezionata non è riuscita ad aggiornare questa credenziale. Verifica che sia online e riprova.',
      newCredentialRequired: ({ machine }) => `Su ${machine} è richiesta una nuova credenziale della macchina`,
    },
    openAiCompatEndpoint: {
      executionMachine: ({ machine }) => `Le richieste vengono eseguite su ${machine}. Localhost si riferisce a quella macchina.`,
      insecureTitle: 'Consentire HTTP locale non sicuro?',
      insecureBody: ({ origin, machine }) => `Consentire l’invio di credenziali via HTTP a ${origin} da ${machine}? Localhost si riferisce a ${machine}. Sono accettati solo indirizzi di loopback e di rete privata; l’HTTP pubblico viene rifiutato.`,
      allowAction: 'Consenti HTTP',
      invalidBody: 'Inserisci un URL HTTPS oppure un URL HTTP di loopback o rete privata senza nome utente, password o stringa di query.',
    },
  }) } as const;

return { voiceLocalCredentialTranslations };
})();

const Domain_voiceMomentsTranslations = (() => {
type VoiceMomentsTranslation = Shared_voiceMomentsTranslations.VoiceMomentsTranslation;

const voiceMomentsTranslations = { it: {
        setupTitle: 'Configura la voce',
        setupTileSubtitle: 'Parla ad alta voce con le tue sessioni. Quattro brevi passaggi.',
        setupTileProgress: ({ done, total, next }) => `${done} di ${total} fatti · ${next}`,
        setupNextService: 'ora scegli chi ascolta',
        setupNextReadiness: 'ora completa il servizio',
        setupNextMicrophone: 'ora consenti il microfono',
        setupNextTry: 'ora provalo',
        setupNextInstalling: 'installazione in corso',
        setupStart: 'Configura',
        setupContinue: 'Continua',
        setupDescription: 'Parla ad alta voce con le tue sessioni: chiedi cosa succede, avvia lavoro, decidi ovunque. Quattro passaggi; puoi uscire e tornare.',
        setupLightCaption: ({ done, total }) => `${done} di ${total} pronti`,
        setupServiceTitle: 'Scegli chi ascolta',
        setupServiceDetail: 'Cosa ti ascolta e ti risponde. Puoi cambiarlo più tardi.',
        setupChange: 'Cambia',
        setupReadinessTitle: ({ service }) => `Completa la configurazione di ${service}`,
        setupReadinessDone: ({ service }) => `${service} è pronto`,
        setupReadinessGeneric: 'Il servizio',
        setupReadinessTitleGeneric: 'Prepara il servizio',
        setupReadinessUnknown: 'Apri le impostazioni per vedere cosa manca.',
        setupReadinessCheck: 'Verifica configurazione',
        setupMicrophoneTitle: 'Consenti il microfono',
        setupMicrophoneDetail: 'Il dispositivo lo chiede una volta. Happier ascolta solo mentre la voce è attiva, e puoi sempre vederlo.',
        setupMicrophoneAction: 'Consenti microfono',
        setupMicrophoneDone: 'Microfono consentito',
        setupMicrophoneDeniedTitle: 'Il microfono è disattivato per Happier',
        setupMicrophoneDeniedDetail: 'Attivalo nelle impostazioni di sistema, poi torna qui.',
        setupOpenSystemSettings: 'Apri impostazioni',
        setupTryTitle: 'Provalo',
        setupTryDetail: 'Chiedi «Cosa stanno facendo le mie sessioni?». Le tue parole arrivano nella conversazione come ogni messaggio.',
        setupTryAction: 'Prova',
        setupTryDone: 'Provato',
        setupTryNeedsService: 'Disponibile quando il servizio è pronto.',
        setupDoneTitle: 'La voce è pronta',
        setupDoneBody: 'Tocca il pulsante voce in qualsiasi chat per parlare e toccalo di nuovo per terminare. Silenzia è accanto a Termina mentre parli.',
        setupGestureTap: 'Tocca',
        setupGestureStartEnd: 'avvia · termina',
        setupGestureAnywhere: 'avvia · termina ovunque',
        setupDoneAction: 'Fatto',
        setupSettingsAction: 'Impostazioni voce',
        setupClose: 'Chiudi',
        needsYouEnded: 'La voce è terminata. L’approvazione è ancora in attesa nella Posta.',
        needsYouReview: 'Rivedi richiesta',
        needsYouTapToDecide: 'Letto ad alta voce · decidi qui, non a voce',
        briefMe: 'Aggiornami',
        briefMeA11y: 'Aggiornami: la voce legge cosa ti serve, cosa è fallito e cosa è pronto',
        briefNeedsYou: 'Ti aspetta',
        briefFailed: 'Non riuscito',
        briefReady: 'Pronto',
        briefIncomplete: 'Non tutto il lavoro è stato caricato, quindi potrebbe mancare qualcosa.',
        briefCaughtUp: 'Al momento non c’è nulla per te.',
        briefNotSpoken: 'La voce non può leggerlo ora. L’elenco è tutto qui.',
        briefStop: 'Ferma',
        continueTitle: 'Continua a parlare qui',
        continueDetail: ({ device }) => `Stavi parlando su ${device}`,
        continueAction: 'Continua',
        continuedOn: ({ device }) => `Continuato su ${device}`,
        continuedElsewhere: 'Continuato su un altro dispositivo',
        continuedHere: 'Continuato su questo dispositivo',
        dismiss: 'Ignora',
    } } satisfies Pick<Readonly<Record<string, VoiceMomentsTranslation>>, "it">;

return { voiceMomentsTranslations };
})();

const Domain_voicePresenceTranslations = (() => {
type VoicePresenceTranslation = Shared_voicePresenceTranslations.VoicePresenceTranslation;

const voicePresenceTranslations = { it: {
        welcomeText: "Ciao, ti ascolto — cosa vorresti fare?",
        customVoice: 'Voce personalizzata',
        boundWelcomeText: ({ name }: Readonly<{ name: string }>) => `Ciao, stai parlando con ${name} — cosa vorresti fare?`,
        greetingLiteralUnavailable: "Con questa lingua di risposta, il servizio aspetta che tu parli.",
        title: 'Voce',
        howYouTalk: "Come parli",
        holdToTalkTitle: "Tieni premuto per parlare",
        holdToTalkDescription: "Tieni premuto il simbolo Voice per dire una cosa; rilascia per inviare. Un tocco continua ad avviare e terminare Voice.",
        holdToTalkHint: "Tieni premuto per un turno; rilascia per inviare. Trascina per annullare.",
        holdToTalkUnavailable: ({ service }) => `${service} non supporta la pressione prolungata per parlare. Tocca per parlare.`,
        talkWithVoice: 'Parla con Voce',
        dictate: 'Detta',
        globalVoice: 'Voce globale',
        interrupt: 'Interrompi',
        options: 'Opzioni di Voce',
        you: 'Tu',
        showConversation: 'Mostra la conversazione',
        dragToMove: 'Trascina per spostare',
        openConversation: 'Apri la conversazione',
        settings: 'Impostazioni di Voce',
        ended: 'Voce terminata',
        muted: 'Silenziato',
        setUp: 'Configura Voce',
        setUpHint: 'Apre le impostazioni di Voce per scegliere come parla',
        startAgain: 'Ricomincia',
        endedCaption: ({ elapsed }) => `${elapsed} · la conversazione è salvata`,
        dismiss: 'Chiudi',
        mute: "Silenzia",
        unmute: "Riattiva",
        end: "Termina",
        captions: { connecting: "Apertura del canale audio", listening: "Vai pure", transcribing: "Conversione in testo", thinking: "Sto preparando una risposta", speaking: "Puoi interrompere in qualsiasi momento", interrupted: "Vai pure", muted: "Riattiva il microfono per parlare · Voce può ancora parlare", reconnecting: "Connessione persa · nuovo tentativo", blocked: "Consenti l'accesso al microfono per parlare", failed: "Riprova o controlla le impostazioni di Voce" },
        recovery: { allow: "Consenti", setUp: "Configura" },
        containerA11y: ({ status }) => `Voce, ${status}`,
    } } satisfies Pick<Readonly<Record<string, VoicePresenceTranslation>>, "it">;

return { voicePresenceTranslations };
})();

const Domain_voiceProviderPrivacyTranslations = (() => {
const voiceProviderPrivacyTranslations = { it: {
    openai: {
      privacyDisclosure: 'L’audio e il contenuto della conversazione vengono inviati da questo dispositivo a OpenAI tramite WebRTC. Quando le funzioni corrispondenti sono abilitate o utilizzate, OpenAI può ricevere da questo dispositivo anche aggiornamenti limitati del contesto Voice, chiamate agli strumenti client e i relativi risultati. Happier usa la chiave Voice API salvata, il servizio connesso OpenAI o l’account sperimentale Codex OAuth selezionati per ottenere un’autenticazione client di breve durata; gli account connessi vengono usati tramite la macchina selezionata. OpenAI elabora la conversazione nell’account selezionato e può conservare i dati ricevuti secondo le impostazioni dell’account e i termini di OpenAI. Il server e il relay di Happier non trasportano l’audio in tempo reale. I controlli di condivisione del contesto Voice sono separati da questo trattamento del provider.',
    },
    xai: {
      privacyDisclosure: 'L’audio e il contenuto della conversazione vengono inviati da questo dispositivo a xAI tramite la connessione xAI Realtime. Quando le funzioni corrispondenti sono abilitate o utilizzate, xAI può ricevere da questo dispositivo anche aggiornamenti limitati del contesto Voice, chiamate agli strumenti client e i relativi risultati. Happier usa la chiave API xAI salvata nei segreti del tuo account Happier solo per le operazioni limitate di autenticazione client e catalogo voci. xAI elabora la conversazione in tale account e può conservare i dati ricevuti secondo le impostazioni dell’account e i termini di xAI. Se la ripresa è attiva, Happier salva l’identificatore della conversazione del provider; dimenticarlo rimuove l’identificatore salvato da Happier e non elimina i dati conservati da xAI. Il server e il relay di Happier non trasportano l’audio in tempo reale. I controlli di condivisione del contesto Voice sono separati da questo trattamento del provider.',
    },
    speechProcessing: {
      deviceStt: 'L’audio viene elaborato dal servizio di riconoscimento vocale del browser o del sistema operativo. A seconda della piattaforma e del servizio configurato, l’elaborazione può avvenire fuori dal dispositivo.',
      deviceTts: 'Il testo della risposta viene elaborato dal servizio di sintesi vocale del browser o del sistema operativo. A seconda della piattaforma e del servizio configurato, l’elaborazione può avvenire fuori dal dispositivo.',
    },
    fields: {
      resumption: {
        title: 'Salva l’identificatore di ripresa xAI',
        subtitle: 'Consenti a Happier di salvare l’identificatore temporaneo della conversazione xAI per la riconnessione.',
      },
    },
    resumption: {
      confirmTitle: 'Salvare l’identificatore di ripresa xAI?',
      confirmBody: 'Happier salverà l’identificatore della conversazione xAI per un massimo di {minutes} minuti, così una conversazione interrotta potrà riconnettersi. Questo non modifica né elimina i dati conservati da xAI.',
      confirmAction: 'Salva identificatore',
      forgetTitle: 'Dimentica l’identificatore di ripresa di Happier',
      forgetSubtitle: 'Rimuove l’identificatore della conversazione del provider salvato da Happier. Questo non elimina la conversazione né i dati conservati da xAI.',
      forgotten: 'Happier ha rimosso l’identificatore della conversazione del provider salvato.',
      unsupported: 'Happier non può rimuovere da questa sessione l’identificatore della conversazione del provider salvato.',
      failed: 'Happier non ha potuto rimuovere l’identificatore della conversazione del provider salvato. Riprova.',
    },
  } } as const;

return { voiceProviderPrivacyTranslations };
})();

const Domain_voiceReadinessTranslations = (() => {
type VoiceReadinessCopy = Shared_voiceReadinessTranslations.VoiceReadinessCopy;

const defineVoiceReadinessTranslation = Shared_voiceReadinessTranslations.defineVoiceReadinessTranslation;

const voiceReadinessTranslations = { it: defineVoiceReadinessTranslation({
    ready: 'La funzione Voce è pronta.',
    permissionAnnouncement: ({ summary }) => `La sessione di codice richiede l’autorizzazione per ${summary}. Controllala nell’interfaccia della sessione per approvare o rifiutare.`,
    userActionAnnouncement: ({ question }) => `La sessione di codice ha bisogno della tua risposta. ${question}`,
    userActionFallback: 'La sessione di codice ha bisogno della tua risposta. Rispondi alla domanda per permettermi di continuare.',
    requestedTool: 'lo strumento richiesto',
    provider_unselected: 'Scegli un provider vocale.',
    contribution_unavailable: 'Questo provider vocale non è più disponibile.',
    role_unsupported: 'Questo provider non supporta la modalità Voce selezionata.',
    platform_unsupported: 'Questo provider vocale non è disponibile su questa piattaforma.',
    settings_unsupported_version: 'Aggiorna questo provider prima di usarlo con la funzione Voce.',
    settings_unknown: 'Non è stato possibile controllare le impostazioni del provider.',
    settings_needs_migration: 'Controlla le impostazioni aggiornate del provider.',
    settings_invalid: 'Controlla le impostazioni non valide del provider.',
    settings_missing_required_setting: ({ service }) => `Completa la configurazione di ${service} per iniziare.`,
    provider_mode_unknown: 'Scegli una modalità supportata da questo provider.',
    server_feature_disabled: 'Il server ha disabilitato questo provider vocale.',
    server_feature_installing: 'Il server sta preparando il supporto per la funzione Voce.',
    server_feature_incompatible: 'Il server non è compatibile con questo provider vocale.',
    server_feature_unknown: 'Non è stato possibile verificare il supporto del server per questo provider vocale.',
    execution_machine_missing: 'Scegli una macchina in grado di eseguire questo provider vocale.',
    execution_machine_installing: 'La macchina di esecuzione Voce selezionata è ancora in preparazione.',
    execution_machine_incompatible: 'La macchina selezionata non è compatibile con questo provider vocale.',
    execution_machine_unknown: 'Non è stato possibile controllare la macchina di esecuzione Voce.',
    daemon_unreachable: 'La macchina selezionata non ha un percorso disponibile per l’audio vocale.',
    daemon_relay_disabled: 'La macchina selezionata richiede il relay audio vocale, ma il suo utilizzo è disabilitato.',
    daemon_relay_capped: 'La capacità del relay audio vocale non è attualmente disponibile per la macchina selezionata.',
    credential_missing: 'Aggiungi la credenziale richiesta da questo provider vocale.',
    credential_approval_required: 'Controlla l’accesso alla credenziale prima di usare questo provider vocale.',
    credential_installing: 'La credenziale del provider è ancora in preparazione.',
    credential_incompatible: 'La credenziale selezionata non è compatibile con questo provider vocale.',
    credential_unknown: 'Non è stato possibile controllare la credenziale del provider.',
    endpoint_missing: 'Configura l’endpoint richiesto da questo provider vocale.',
    endpoint_installing: 'L’endpoint del provider vocale è ancora in preparazione.',
    endpoint_incompatible: 'L’endpoint configurato non è compatibile con questo provider vocale.',
    endpoint_unknown: 'Non è stato possibile controllare l’endpoint del provider vocale.',
    runtime_missing: 'Installa il runtime richiesto da questo provider vocale.',
    runtime_installing: 'Il runtime del provider vocale è ancora in fase di installazione.',
    runtime_incompatible: 'Il runtime installato non è compatibile con questo provider vocale.',
    runtime_unknown: 'Non è stato possibile controllare il runtime del provider vocale.',
    model_missing: 'Installa o scegli un modello per questo provider vocale.',
    model_installing: 'Il modello vocale selezionato è ancora in fase di installazione.',
    model_incompatible: 'Il modello selezionato non è compatibile con questo provider vocale.',
    model_unknown: 'Non è stato possibile controllare il modello del provider vocale.',
    device_stt_unavailable: 'Il riconoscimento vocale non è disponibile su questo dispositivo.',
    device_stt_availability_unknown: 'La disponibilità del riconoscimento vocale è ancora in fase di verifica.',
    short: {
      needsSetup: 'Da configurare',
      needsKey: 'Serve una chiave',
      needsApproval: 'Serve la tua approvazione',
      offOnServer: 'Disattivato su questo server',
      needsComputer: 'Serve un computer',
      needsAddress: 'Serve un indirizzo',
      needsModel: 'Serve un modello',
      installing: 'Installazione…',
      notInstalled: 'Non installato',
      unavailableHere: 'Non disponibile qui',
      needsUpdate: 'Serve un aggiornamento',
      cantCheck: 'Non ancora verificato',
    },
    actions: {
      select_provider: 'Scegli un provider',
      open_provider_settings: "Completa configurazione",
      select_execution_machine: 'Scegli una macchina',
      configure_credential: 'Aggiungi credenziali',
      review_credential_access: 'Controlla l’accesso alla credenziale',
      configure_endpoint: 'Configura l’endpoint',
      install_model: 'Installa un modello',
      switch_provider: 'Scegli un altro provider',
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

const voiceRealtimeProviderSetupTranslations = { it: defineVoiceRealtimeProviderSetup(voiceProviderPrivacyTranslations["it"], {
    xai: {
      setup: { footer: 'La tua chiave API xAI è archiviata come segreto salvato sincronizzato nei segreti del tuo account Happier. Viene materializzata solo per l’operazione xAI Realtime delimitata.' },
      credential: { promptBody: 'Incolla una chiave API xAI. Happier la protegge come segreto salvato sincronizzato e la materializza solo per l’operazione xAI Realtime delimitata.' },
    },
    setup: {
      title: 'Configurazione della voce in tempo reale',
      footer: 'La tua chiave API è archiviata sulla macchina di esecuzione selezionata e non viene mai inclusa nelle impostazioni vocali sincronizzate.',
    },
    credential: {
      title: 'Chiave API salvata',
      promptTitle: 'Collega la voce in tempo reale',
      promptBody: 'Incolla una chiave API di OpenAI Platform. È protetta nei segreti sincronizzati del tuo account e viene materializzata solo per emettere credenziali client Realtime di breve durata.',
    },
    authentication: {
      sectionTitle: 'Autenticazione OpenAI Realtime',
      title: 'Origine dell’autenticazione',
      subtitle: 'Scegli esattamente un’origine. Happier non ripiega mai su un’altra chiave o un altro account.',
      footer: 'L’uso dell’API OpenAI Realtime è fatturato da OpenAI Platform. Un abbonamento ChatGPT o Codex non implica la fatturazione né l’accesso all’API Realtime. Alla conversazione WebRTC vengono passate solo credenziali client di breve durata.',
      savedSecret: {
        title: 'Chiave API vocale salvata',
        subtitle: 'Usa la chiave API archiviata nei segreti dell’account Happier Voice. Non serve alcun demone.',
      },
      openAiApiKey: {
        title: 'Servizio connesso OpenAI',
        subtitle: 'Usa il profilo o il gruppo di account con chiave API OpenAI standard selezionato tramite la macchina scelta e il suo demone connesso.',
      },
      openAiCodex: {
        title: 'OpenAI Codex OAuth (sperimentale)',
        subtitle: 'Usa il profilo o il gruppo di account Codex OAuth selezionato tramite la macchina scelta e il suo demone connesso. Happier non ripiega mai su un’altra chiave o un altro account.',
      },
      account: {
        title: 'Account connesso',
        subtitle: 'Scegli il profilo o il gruppo di account esatto usato per la prossima conversazione.',
      },
      chooseAccount: 'Scegli un account',
      referenceRequired: 'Scegli un profilo o un gruppo di account connesso.',
      connected: 'Account connesso pronto',
      unavailable: 'Account selezionato non disponibile o da riconnettere',
    },
    invalidValue: 'Questo provider non supporta quel valore.',
    advanced: { show: 'Mostra impostazioni avanzate', hide: 'Nascondi impostazioni avanzate' },
    fields: {
      model: { title: 'Modello', subtitle: 'Scegli il modello vocale in tempo reale.' },
      voice: { title: 'Voce', subtitle: 'Scegli la voce usata per le risposte.' },
      instructions: {
        title: 'Istruzioni vocali',
        subtitle: 'Istruzioni facoltative su comportamento e personalità.',
        promptTitle: 'Istruzioni vocali',
        promptBody: 'Inserisci istruzioni facoltative per questa sessione vocale.',
      },
      turnDetection: {
        title: 'Rilevamento del turno',
        subtitle: 'Scegli come il provider rileva la fine del tuo turno.',
        threshold: {
          title: 'Soglia VAD',
          subtitle: 'Sensibilità all’attività vocale; lascia vuoto per il valore del provider.',
          promptTitle: 'Soglia VAD',
          promptBody: 'Inserisci un valore da 0.1 a 0.9 oppure lascia vuoto.',
        },
        silenceDurationMs: {
          title: 'Durata del silenzio',
          subtitle: 'Millisecondi di silenzio prima di terminare un turno.',
          promptTitle: 'Durata del silenzio',
          promptBody: 'Inserisci da 0 a 10000 millisecondi oppure lascia vuoto.',
        },
        prefixPaddingMs: {
          title: 'Margine prima del parlato',
          subtitle: 'Millisecondi conservati prima del parlato rilevato.',
          promptTitle: 'Margine prima del parlato',
          promptBody: 'Inserisci da 0 a 10000 millisecondi oppure lascia vuoto.',
        },
        idleTimeoutMs: {
          title: 'Timeout di risposta in inattività',
          subtitle: 'Puoi chiedere a xAI di avviare una risposta dopo questo silenzio.',
          promptTitle: 'Timeout di risposta in inattività',
          promptBody: 'Inserisci da 1 a 600000 millisecondi oppure lascia vuoto per disattivare le risposte automatiche in inattività.',
          confirmTitle: 'Attivare le risposte automatiche in inattività?',
          confirmBody: 'Dopo il silenzio configurato, xAI può creare una risposta di propria iniziativa e consumare utilizzo API.',
          confirmAction: 'Attiva',
        },
      },
      transcriptionModel: {
        title: 'Modello di trascrizione',
        subtitle: 'Modello facoltativo per la trascrizione dell’input.',
        promptTitle: 'Modello di trascrizione',
        promptBody: 'Inserisci un id di modello oppure lascia vuoto per il valore del provider.',
      },
      reasoning: { title: 'Ragionamento', subtitle: 'Scegli il livello di ragionamento per i modelli supportati.' },
      outputSpeed: {
        title: 'Velocità di lettura',
        subtitle: 'Regola la velocità con cui parla il provider.',
        promptTitle: 'Velocità di lettura',
        promptBody: 'Inserisci un valore da 0.7 a 1.5.',
      },
      languageHint: {
        title: 'Suggerimento di lingua',
        subtitle: 'Puoi aiutare la trascrizione a identificare la tua lingua.',
        promptTitle: 'Suggerimento di lingua',
        promptBody: 'Scegli una lingua supportata.',
      },
      keyterms: {
        title: 'Termini chiave',
        subtitle: 'Nomi e termini di dominio che la trascrizione dovrebbe riconoscere.',
        promptTitle: 'Termini chiave',
        promptBody: 'Inserisci fino a 100 termini separati da virgole o da a capo.',
      },
    },
    options: {
      pinned: 'Versione bloccata',
      movingAlias: 'Segue automaticamente gli aggiornamenti del provider',
      automatic: 'Automatico',
      custom: 'Personalizzato…',
      server_vad: 'Rilevamento dell’attività vocale sul server',
      semantic_vad: 'Rilevamento semantico del turno',
      manual: 'Manuale',
      high: 'Alto',
      none: 'Nessuno',
    },
    catalog: {
      credentialRequired: 'Aggiungi una chiave API per caricare le voci',
      retry: 'Impossibile caricare le voci — riprova',
      empty: 'Per questo account non è disponibile alcuna voce',
      preview: ({ voice }) => `Ascolta ${voice}`,
    },
    movingAlias: {
      confirmTitle: 'Seguire il modello più recente?',
      confirmBody: 'Un alias di modello mobile può cambiare comportamento quando il provider lo aggiorna. Puoi tornare a una versione bloccata in qualsiasi momento.',
      confirmAction: 'Usa il più recente',
    },
    links: {
      title: 'Risorse del provider',
      account: { title: 'Apri l’account del provider', subtitle: 'Gestisci il tuo account presso il provider.' },
      apiKeys: { title: 'Apri le chiavi API', subtitle: 'Crea, ruota o revoca le chiavi API del provider.' },
      privacy: { title: 'Informativa sulla privacy del provider', subtitle: 'Consulta come il provider tratta i dati vocali.' },
    },
    disconnect: {
      title: 'Disconnetti la voce in tempo reale',
      subtitle: 'Rimuovi la chiave API di questo provider dalla macchina selezionata.',
      confirmTitle: 'Disconnettere il provider?',
      confirmBody: 'Questa azione rimuove la chiave API archiviata dalla macchina di esecuzione selezionata.',
    },
    unavailable: {
      title: 'Voce in tempo reale non disponibile',
      rowTitle: 'Impossibile caricare le impostazioni',
      provider: 'Il contributo del provider non è disponibile o non è compatibile.',
      invalid: 'Le impostazioni salvate del provider non sono valide.',
      needs_migration: 'Queste impostazioni richiedono una migrazione supportata prima di poter essere modificate.',
      unsupported_version: 'Queste impostazioni sono state scritte da una versione più recente di Happier.',
    },
  }) } as const;

return { voiceRealtimeProviderSetupTranslations };
})();

const Domain_voiceSettingsPagesTranslations = (() => {
type VoiceSettingsPagesCopy = Shared_voiceSettingsPagesTranslations.VoiceSettingsPagesCopy;

const en = Shared_voiceSettingsPagesTranslations.en;

const it: VoiceSettingsPagesCopy = {
  pages: {
    search: {
      chooseService: 'Scegli un servizio per modificare questa impostazione.',
      select: ({ choice, control }) => `Seleziona ${choice} in ${control} per modificare questa impostazione.`,
    },
    hub: {
      description: 'Parla ad alta voce con i tuoi agenti e detta in qualsiasi messaggio.',
      modesTitle: 'Due modi di usare la tua voce',
      moreTitle: 'Altro',
      dictationPurpose: 'il microfono del campo di testo trasforma la tua voce in testo modificabile',
      summarySessionSummaries: 'Riepiloghi della sessione',
      summaryRecentMessages: ({ count }) => `ultimi ${count} messaggi`,
      summaryNothingShared: 'Nulla viene condiviso all’inizio di una conversazione',
      summaryRemembers: 'L’agente Voice ricorda le conversazioni passate',
      summaryForgets: 'L’agente Voice dimentica dopo ogni conversazione',
      summaryVoiceComputer: ({ machine }) => `Computer Voice: ${machine}`,
      summaryTranscript: 'trascrizione mentre parli',
    },
    pipeline: {
      hear: 'Ascoltare',
      think: 'Pensare',
      speak: 'Parlare',
      write: 'Scrivere',
      ready: 'Pronto',
      oneStepNeedsYou: 'Un passaggio ha bisogno di te',
      stepsNeedYou: ({ count }) => `${count} passaggi hanno bisogno di te`,
      waiting: 'In attesa',
      working: 'In corso',
      notChecked: 'Non ancora verificato',
      off: 'Disattivato · la dettatura resta disponibile',
      onMachine: ({ machine }) => `Su ${machine}`,
      onVoiceComputer: 'Sul tuo computer Voice',
      inTheCloud: 'Nel cloud del servizio, da questo dispositivo',
      inTheSession: 'Risponde il suo agente, nella trascrizione',
      intoYourMessage: 'Lo rivedi prima di inviare',
      messageLanguage: ({ language }) => `Lingua: ${language}`,
      languageAutomatic: 'automatica',
      onThisDevice: 'Su questo dispositivo',
      needsYou: 'Ha bisogno di te',
      voiceAgentFollowsSession: 'Agente Voice · segue la sessione',
      theSessionYoureIn: 'La sessione in cui sei',
      intoYourMessageTitle: 'Nel tuo messaggio',
    },
    privacy: {
      localAudio: "Il dispositivo o computer Voice",
      localProcessor: "Il modello vocale selezionato",
      localRetention: "Gestito dal dispositivo o ambiente di esecuzione. La diagnostica segue le impostazioni di registrazione.",
      localDisclosure: "I modelli vocali selezionati vengono eseguiti sul dispositivo o computer Voice. La cronologia Voice e le registrazioni diagnostiche hanno impostazioni separate in questa pagina.",
      audioTitle: "Audio inviato a",
      processorTitle: "Elaborato da",
      retentionTitle: "Conservazione",
      messagesUnit: "messaggi",
      secondsUnit: "secondi",
      servicePolicy: "Secondo le impostazioni e i termini del tuo account del servizio.",
      noMicrophoneAudio: "Nessun audio del microfono; solo testo della risposta.",
      yourEndpoint: "Il tuo endpoint configurato",
      endpointOperator: "Il gestore del tuo endpoint",
      endpointPolicy: "Secondo la politica di conservazione del tuo endpoint.",
      deviceAudio: "Il servizio vocale del dispositivo",
      deviceProcessor: "Il dispositivo o il suo servizio vocale",
      devicePolicy: "Secondo le impostazioni e i termini vocali del dispositivo.",
      description: 'Cosa sente e legge il tuo servizio vocale e cosa conserva Happier.',
      whereTitle: 'Dove va la tua voce adesso',
      whereDescription: 'Cambia con il servizio che scegli.',
      startTitle: 'All’inizio di una conversazione',
      startDescription: 'Cosa può leggere del tuo lavoro il servizio vocale.',
      screenTitle: 'Cosa c’è sul tuo schermo',
      screenDescription: 'Quale sessione o pagina stai guardando.',
      screenNever: 'Mai',
      screenWhenAsked: 'Su richiesta',
      screenAlways: 'Sempre',
      summariesTitle: 'Riepiloghi della sessione',
      recentTitle: 'I tuoi messaggi recenti',
      recentDescription: 'Gli ultimi messaggi di una sessione, quando chiede contesto.',
      recentCountTitle: 'Messaggi da condividere',
      recentCountDescription: "",
      recentCountUnavailable: 'Attiva «I tuoi messaggi recenti» per cambiarlo.',
      toolsTitle: 'Nomi degli strumenti',
      toolsDescription: 'Come «File modificato». Argomenti e percorsi dei file non vengono mai condivisi.',
      permissionsTitle: 'Richieste di autorizzazione',
      permissionsDescription: 'Per dirti cosa ha bisogno di te. Approvi sempre con un tocco.',
      devicesTitle: 'Le tue macchine e i tuoi dispositivi',
      devicesDescription: 'Nomi e stato online, per avviare sessioni dove chiedi.',
      liveTitle: 'Mentre parli',
      liveDescription: 'Aggiornamenti inviati quando le tue sessioni cambiano durante una conversazione.',
      liveActiveTitle: 'Dalla sessione in cui sei',
      liveOtherTitle: 'Dalle tue altre sessioni',
      liveNothing: 'Niente',
      liveActivity: 'Attività',
      liveSummaries: 'Riepiloghi',
      liveMessages: 'Messaggi',
      livePerUpdateTitle: 'Messaggi per aggiornamento',
      liveIncludeMineTitle: 'Includi ciò che hai scritto',
      liveIncludeMineDescription: 'Disattivato: viene inviata solo la parte dell’agente.',
      liveMessagesUnavailable: 'Scegli «Messaggi» per una sessione qui sopra per cambiarlo.',
      liveOtherModeTitle: 'Messaggi dalle altre sessioni',
      liveOtherModeNever: 'Mai',
      liveOtherModeWhenAsked: 'Su richiesta',
      liveOtherModeAutomatically: 'Automaticamente',
      liveOtherModeUnavailable: 'Scegli «Messaggi» per le altre sessioni per cambiarlo.',
      memoryTitle: 'Memoria dell’agente Voice',
      memoryDescription: 'Solo per la voce locale con un agente Voice.',
      rememberTitle: 'Ricorda le conversazioni passate',
      rememberOnDescription: 'Riprende da dove avevi lasciato.',
      rememberOffDescription: 'Disattivato: dimentica tutto quando riattacchi.',
      restoreTitle: 'Ripristina la memoria con',
      restoreRecent: 'Messaggi recenti',
      restoreSummary: 'Riepilogo + recenti',
      restoreResume: 'Ripresa dell’agente',
      restoreUnavailable: 'Attiva «Ricorda» per scegliere.',
      restoreResumeFeatureOff: 'La ripresa richiede l’agente Voice attivo su questo server.',
      restoreResumeAgentCannot: 'Questo agente non può riprendere una conversazione passata.',
      fallbackTitle: 'Se la ripresa fallisce, riproduci i messaggi',
      fallbackDescription: 'Riparte dai tuoi messaggi recenti invece che da zero.',
      restoreCountTitle: 'Messaggi da ripristinare',
      restoreCountDescription: "",
      forgetTitle: 'Dimentica tutto ora',
      forgetDescription: 'Riavvia l’agente Voice da zero. Le tue sessioni non vengono toccate.',
      forgetAction: 'Dimentica',
      moreTitle: 'Altro',
    },
    dictation: {
      description: 'Il microfono del campo di testo trasforma la tua voce in testo da modificare prima di inviare.',
      engineTitle: 'Motore vocale',
      engineDescription: 'Ogni motore dice dove va il tuo audio.',
      sameAsConversations: 'Come le conversazioni vocali',
      sameAsConversationsUses: ({ engine }) => `Usa ${engine}, come le tue conversazioni vocali.`,
      languageTitle: 'Lingua',
      dictateInTitle: 'Detto in',
      dictateInDescription: 'Automatico usa la lingua predefinita del motore. Non segue la lingua delle conversazioni.',
      pipelinePurpose: 'funziona anche quando le conversazioni vocali sono disattivate',
    },
    conversations: {
      description: 'Parla ad alta voce con i tuoi agenti, con le mani sulla tastiera o no.',
      serviceTitle: 'Servizio',
      serviceDescription: 'Chi ti ascolta, pensa e parla. Puoi cambiare quando vuoi; ognuno mantiene la sua configurazione.',
      offDescription: 'Nessuna conversazione vocale. La dettatura resta disponibile.',
      serviceReady: 'Pronto',
      accountTitle: 'Account',
      accountDescription: 'È lo stesso servizio in entrambi i casi; cambia solo chi paga.',
      payWithTitle: 'Paga con',
      happierBillingUnavailable: "La fatturazione Happier non è disponibile su questo server.",
      turnOnVoiceAgent: "Attiva agente vocale",
      payWithHappierDescription: 'È incluso nel tuo piano Happier. Non serve un account tuo.',
      payWithOwnDescription: 'Usi il tuo account e la tua chiave API di questo servizio.',
      runsOn: 'Gira su',
      hearTitle: 'Ascoltare',
      hearDescription: 'Come la tua voce diventa testo prima della risposta.',
      speechRecognitionTitle: 'Riconoscimento vocale',
      handsFreeUnsupported: 'Il vivavoce richiede il riconoscimento vocale di questo dispositivo o un modello vocale Happier.',
      handsFreeTimingUnavailable: 'Attiva il vivavoce per cambiarlo.',
      interruptTitle: 'Interrompi parlando',
      interruptDescription: 'Parlare sopra una risposta la ferma.',
      talkToTitle: 'Parla con',
      talkToSession: 'La sessione',
      talkToSessionDescription: 'Parli nella sessione in cui sei; risponde il suo agente.',
      talkToAgent: 'Un agente Voice',
      talkToAgentDescription: 'Un agente Voice legge le tue sessioni e agisce per te.',
      agentFeatureRequired: ({ feature }) => `Attiva ${feature} in Impostazioni → Funzionalità. Le funzionalità sperimentali richiedono anche l’attivazione di Esperimenti.`,
      itMayTitle: 'Può',
      itMayReadOnly: 'Solo lettura',
      itMayReadOnlyDescription: 'Legge sessioni e file e non cambia nulla.',
      itMayAsk: 'Chiedi prima',
      itMayAskDescription: 'Ogni modifica ti chiede prima. Un «sì» detto a voce non approva mai; approvi con un tocco.',
      itMaySafe: 'Modifiche sicure',
      itMaySafeDescription: 'Fa da solo le modifiche sicure all’area di lavoro e chiede per il resto.',
      itMayAnything: 'Tutto',
      itMayAnythingDescription: 'Può fare qualsiasi modifica senza chiederti prima.',
      repliesTitle: 'Risposte',
      repliesShort: 'Brevi',
      repliesBalanced: 'Bilanciate',
      thinkTitle: 'Pensare',
      thinkDescription: 'Cosa succede a ciò che dici.',
      advancedAgentTitle: 'Comportamento avanzato dell’agente',
      advancedAgentDescription: 'Come l’agente Voice si avvia, attende e risponde. I valori predefiniti vanno bene per quasi tutti.',
      memoryLinkTitle: 'Memoria e ripristino',
      memoryLinkDescription: 'Se ricorda le conversazioni passate si imposta in Privacy e dati.',
      speakTitle: 'Parlare',
      speakDescription: 'Come vengono lette ad alta voce le risposte.',
      voiceEngineTitle: 'Motore della voce',
      languageTitle: 'Lingua',
      languageDescription: 'Cosa cambia ogni lingua per il servizio scelto.',
      iSpeakTitle: 'Parlo',
      iSpeakDescription: 'Aiuta a capirti. Automatico la rileva ogni volta.',
      replyInTitle: 'Rispondi in',
      replyInDescription: 'La risposta arriva in questa lingua, anche se cambi.',
      replySame: 'Come parlo',
      iSpeakAutomatic: 'Automatico',
      iSpeakEngineDescription: ({ engine }) => `Aiuta ${engine} a capirti. Si imposta con il riconoscimento vocale in Ascoltare.`,
      voiceTitle: 'Voce',
      voiceDescription: ({ engine }) => `Da ${engine}, il motore di Parlare.`,
      voiceDefault: 'Predefinita',
      voiceDevice: 'La voce di questo dispositivo',
      voiceInEngine: 'Si imposta in Parlare',
      languageServiceDescription: 'La lingua in cui risponde il tuo servizio vocale.',
      languageAutomaticDescription: 'Il servizio vocale rileva la lingua che parli.',
      languageEngineDefault: 'Predefinita del motore',
      languageCoupledDescription: 'Il servizio vocale usa una sola lingua per ascoltare e rispondere.',
      greetingTitle: 'Saluto',
      greetingOff: 'No',
      greetingRightAway: 'Subito',
      greetingAfterISpeak: 'Quando parlo',
      greetingOffDescription: 'Aspetta che sia tu a parlare per primo.',
      greetingRightAwayDescription: 'Saluta appena inizia la conversazione.',
      greetingAfterISpeakDescription: 'Ti saluta nella prima risposta.',
      languageManagedDescription: 'Il servizio vocale gestisce la propria lingua.',
      languageServiceDefault: 'Predefinita del servizio',
    },
    advanced: {
      description: 'Dove gira la voce, come appare sullo schermo e quali modelli vocali usa.',
      onScreenTitle: 'Sullo schermo',
      onScreenDescription: 'Come appare una conversazione in corso.',
      showLiveAsTitle: 'Mostra Voice dal vivo come',
      showLiveAsDescription: 'Solo su questo dispositivo. La sezione Voice del Companion resta in ogni modalità.',
      scopeTitle: 'Avvia le conversazioni con',
      scopeGlobal: 'Tutte le mie sessioni',
      scopeGlobalDescription: 'Un solo assistente per tutto.',
      scopeSession: 'La sessione aperta',
      scopeSessionDescription: 'Si avvia nella sessione che hai aperto.',
      transcriptTitle: 'Mostra la trascrizione mentre parli',
      transcriptDescription: 'Ciò che dite tu e l’agente compare mentre parlate.',
      autoOpenTitle: 'Aprila all’inizio di una conversazione',
      autoOpenDescription: 'Disattivato: aprila tu dalla conversazione.',
      autoOpenUnavailable: 'Attiva «Mostra la trascrizione» per scegliere.',
      computerTitle: 'Computer Voice',
      speechModelsTitle: 'Modelli vocali',
      speechModelsNeedComputerTitle: 'Serve un computer Voice',
      speechModelsNeedComputer: 'Scegli sopra un computer Voice per installare e gestire i suoi modelli vocali.',
      computerDescription: 'Il computer che esegue i modelli vocali e accede agli account collegati per la voce. Condiviso tra i tuoi dispositivi.',
      connectionTitle: 'Connessione',
      timeoutTitle: 'Rinuncia a una richiesta vocale dopo',
      timeoutDescription: "Per endpoint e modelli vocali.",
    },
  },
};

const voiceSettingsPagesTranslations = { it } as const satisfies Pick<Record<string, VoiceSettingsPagesCopy>, "it">;

return { voiceSettingsPagesTranslations };
})();

const Domain_walkthroughProgressTranslations = (() => {
type Parts = Shared_walkthroughProgressTranslations.Parts;

const walkthroughProgressTranslations = { 'it': { parts: ({ completed, total, admitted }: Parts) => `${completed}/${total} parti completate · ${admitted} ammesse`, merge: 'Composizione del percorso…', titleEdited: 'Titolo modificato', changed: 'Modificato', moved: 'Spostato', filesReadUnavailable: 'Avanzamento della lettura dei file non disponibile' } };

return { walkthroughProgressTranslations };
})();

const Domain_walkthroughSavedTranslations = (() => {
type SavedCopy = Shared_walkthroughSavedTranslations.SavedCopy;

const en = Shared_walkthroughSavedTranslations.en;

const walkthroughSavedTranslations = { it: { discuss: 'Discuti', message: 'Messaggio', edit: 'Modifica il percorso', title: 'Titolo del percorso', stopTitle: 'Titolo della tappa', prose: 'Spiegazione', refine: 'Perfeziona', instructions: 'Cosa deve cambiare?', moveUp: 'Sposta su', moveDown: 'Sposta giù', mergeNext: 'Unisci alla tappa successiva', addSummary: 'Aggiungi riepilogo', addCommitPlan: 'Proponi commit', updated: 'Risultato salvato aggiornato', conflict: 'Questo percorso è cambiato altrove. La tua bozza è conservata. Carica l’ultima versione e controllala prima di salvare di nuovo.', reload: 'Carica l’ultima versione', missingStop: "Questa tappa non è più nell’ultimo percorso. La bozza è conservata; seleziona un’altra tappa per continuare.", applicationLocked: 'Applicazione dei commit in corso. Le modifiche sono sospese.' } } satisfies Pick<Record<string, SavedCopy>, "it">;

return { walkthroughSavedTranslations };
})();

const Domain_walkthroughSettingsTranslations = (() => {
type Copy = Shared_walkthroughSettingsTranslations.Copy;

const en = Shared_walkthroughSettingsTranslations.en;

const copy = Shared_walkthroughSettingsTranslations.copy;

const walkthroughSettingsTranslations = { it: copy({
        title: 'Percorsi',
        description: 'Un ordine di lettura creato dall’IA, con spiegazioni accanto alle modifiche esatte e proposte di commit facoltative. Viene eseguito sulla macchina che contiene il codice.',
        enabled: 'Spiega le modifiche',
        enabledDescription: 'Aggiunge un ordine di lettura e spiegazioni a un confronto. I file restano disponibili anche senza un modello.',
        model: 'Modello di riepilogo',
        modelDescription: 'Usato per spiegazioni, percorsi e proposte di commit.',
        chooseModel: 'Scegli un modello',
        searchModels: 'Cerca modelli',
        unsupported: 'Non può scrivere percorsi',
        unavailable: 'Modello non disponibile. Scegline un altro.',
        prefetch: 'Prepara dopo ogni turno',
        prefetchDescription: 'Prepara un percorso quando l’agente termina un turno.',
        saved: 'Percorsi salvati',
        savedDescription: 'Salvati su questa macchina, incluse le tue modifiche.',
        clear: 'Cancella',
        unavailableData: 'Riconnetti la macchina per caricare i percorsi salvati e i costi.',
        costUnavailable: 'Ultimi 7 giorni · costo non disponibile',
        clearTitle: 'Cancellare i percorsi salvati?',
        clearDescription: ({ machine }) => `Elimina i percorsi salvati e le tue modifiche manuali su ${machine}, insieme ai tuoi contrassegni di revisione per quei confronti. Le altre macchine non sono interessate.`,
        savedCount: ({ count, bytes }) => `${count} salvati · ${bytes}`,
        cost: ({ amount, partial }) => `Ultimi 7 giorni · ${amount}${partial ? ' · alcuni costi non sono disponibili' : ''}`,
        clearFailed: 'Non è stato possibile cancellare alcuni percorsi. Ricarica e riprova.',
    }) };

return { walkthroughSettingsTranslations };
})();

const Domain_walkthroughStartTranslations = (() => {
const walkthroughStartTranslations = { it: { walkthroughStart: { start: 'Avvia il percorso', ended: 'Questa conversazione non è disponibile qui. Il percorso rimane.', newConversation: 'Avvia una nuova conversazione', askSession: 'Chiedi all’agente della sessione', unavailable: 'Collega la macchina e scegli un modello con output strutturato.', updated: 'Percorso aggiornato' } } };

return { walkthroughStartTranslations };
})();

const Domain_walkthroughTranslations = (() => {
type WalkthroughTranslations = Shared_walkthroughTranslations.WalkthroughTranslations;

const walkthroughSavedTranslations = {...Domain_walkthroughSavedTranslations.walkthroughSavedTranslations, ...EnglishFeatures.walkthroughSavedTranslations.walkthroughSavedTranslations};

const walkthroughProgressTranslations = {...Domain_walkthroughProgressTranslations.walkthroughProgressTranslations, ...EnglishFeatures.walkthroughProgressTranslations.walkthroughProgressTranslations};

const en = Shared_walkthroughTranslations.en;

const translated = Shared_walkthroughTranslations.translated;

const walkthroughTranslations = { it: {
        walkthrough: translated({
            saved: walkthroughSavedTranslations.it,
            progress: walkthroughProgressTranslations.it,
            eyebrow: 'Percorso',
            generated: 'Generato',
            generatedBy: ({ model }) => `Generato · ${model}`,
            generatedA11y: 'Scritto da un modello',
            readingChanges: 'Lettura delle modifiche…',
            modelFallback: 'Il modello',
            analysisAll: ({ who, count }) => `${who} ha letto tutte le ${count}`,
            analysisSome: ({ who, analysed, total }) => `${who} ha letto ${analysed} di ${total}`,
            analysisStopped: ({ who, analysed, total }) => `${who} ha letto ${analysed} di ${total} prima di fermarsi`,
            unavailableCount: ({ count }) => `${count} non disponibili`,
            youReviewed: ({ count, total }) => `Hai rivisto ${count} di ${total}`,
            contents: 'Sommario',
            reviewedOfTotal: ({ count, total }) => `${count} di ${total} riviste`,
            boardReadProgress: ({ count, total }) => `${count} di ${total} lette`,
            stopOf: ({ number, total }) => `${number} di ${total}`,
            stopA11y: ({ number, title }) => `Tappa ${number}: ${title}`,
            stopReviewedA11y: ({ number }) => `Tappa ${number}, rivista`,
            importance: { start: 'Inizia qui', high: 'Leggi con attenzione', low: 'Scorri' },
            markReviewed: 'Segna come rivista',
            reviewed: 'Rivista',
            markReviewedA11y: 'Segna questa tappa come rivista',
            unmarkReviewedA11y: 'Rivista. Premi per togliere il segno',
            askAboutThis: 'Chiedi su questo',
            askAboutStopA11y: 'Chiedi su questa tappa',
            openConversation: 'Apri la conversazione del percorso',
            andIn: ({ file }) => `e in ${file}`,
            newFile: 'Nuovo file',
            deletedFile: 'Eliminato',
            openInFiles: ({ file }) => `Apri ${file} in File`,
            otherChanges: 'Altre modifiche',
            otherChangesDescription: 'Fuori dalla storia, ma ancora qui. Aprile come un diff normale.',
            otherChangesCue: 'Meccaniche, mostrate come diff',
            keys: { move: 'sposta', reviewed: 'rivista', ask: 'chiedi' },
            overview: 'Panoramica',
            codeMapOf: ({ count }) => `Mappa del codice di ${count} ${count === 1 ? 'file' : 'file'}`,
            codeMapHint: 'punta una tappa per evidenziarne i file',
            touchesOutlined: 'tocca i file evidenziati',
            showOverviewA11y: ({ count }) => `Mostra la panoramica: una mappa del codice di ${count} file`,
            inventory: { title: 'Tutto in questo confronto · già pronto in File', read: 'Letto', reading: 'In lettura', unavailable: 'Non disponibile' },
            arriving: 'Le prossime tappe compariranno qui man mano che vengono scritte.',
            previousStop: 'Tappa precedente',
            nextStop: 'Tappa successiva',
            done: 'Fine',
            evidence: { displayFailed: 'Impossibile mostrare il codice salvato. Il file resta in File.', binary: 'File binario, descritto dai metadati. Mostrato, non analizzato.', unavailable: ({ reason }) => `Impossibile leggerlo (${reason}). Resta nell’elenco; niente qui afferma che sia stato rivisto.` },
            notice: {
                stale: 'Alcuni file sono cambiati dopo la stesura',
                refresh: 'Aggiorna il percorso',
                failed: ({ reason }) => `Scrittura interrotta · ${reason}`,
                failedGeneric: 'Scrittura interrotta',
                tryAgain: 'Riprova',
                chooseModel: 'Scegli modello',
                cancelled: 'La scrittura è stata fermata. Ciò che è scritto resta.',
                rest: 'Il resto non è stato scritto. Tutti i file sono in File; nulla è stato saltato in silenzio.',
                offline: ({ machine, time }) => `${machine} è offline · percorso e codice delle ${time}. Domande e aggiornamenti tornano alla riconnessione.`,
                offlineA11y: 'Richiede la macchina, che è offline',
                incomplete: 'Alcune modifiche non sono state elencate. Ciò che c’è è esatto; nulla dice di essere completo.',
                undo: 'Annulla',
            },
            none: { title: 'Ancora nessun percorso', reason: 'Un percorso legge queste modifiche in ordine e spiega ciascuna accanto al suo codice esatto. Tutti i file sono già in File.', showFiles: 'Mostra i file' },
            explain: { notInStory: 'Fuori dalla storia', readInWalkthrough: 'Leggi nel percorso' },
        }),
    } };

return { walkthroughTranslations };
})();

const Domain_widgetAddTranslations = (() => {
type WidgetAddTranslation = Shared_widgetAddTranslations.WidgetAddTranslation;

const inSentence = Shared_widgetAddTranslations.inSentence;

const widgetAddTranslations = { it: {
        added: 'Aggiunto',
        boardTitle: 'Aggiungi alla bacheca',
        boardHint: 'Tutti qui vedono ciò che aggiungi',
        companionTitle: 'Aggiungi al compagno',
        companionHint: 'Solo tu vedi il tuo compagno',
        searchWidgets: 'Cerca widget',
        searchCompanion: 'Cerca anteprime e pannelli',
        makeOne: 'Creane uno',
        noteSubtitle: 'Markdown',
        interactiveViewSubtitle: 'HTML',
        findMore: 'Trova altri widget',
        findMoreSubtitle: 'Plugin',
        askTitle: 'Chiedi un widget all’agente',
        askNote: 'Lo scrive nel compositore; non viene inviato nulla finché non lo fai tu.',
        glances: 'Anteprime',
        glancesHint: 'dal vivo, integrate o dai plugin',
        onBoard: 'Su questa bacheca',
        onBoardHint: 'condiviso con tutti qui',
        panes: 'Pannelli',
        panesHint: 'aggiunto come link che si apre in Dettagli',
        builtIn: 'Integrato',
        nativeDescriptions: {
            session_summary: 'Attività e prossimi passi della sessione scelta.',
            agent_plan: 'Segui il piano dell’agente per la sessione scelta.',
            changes: 'Rivedi le modifiche ai file della sessione scelta.',
            local_services: 'Apri i servizi locali della sessione scelta.',
        },
        noMatch: ({ query }) => `Nessun widget corrisponde a “${query}”`,
        pickTitle: 'Scegli un widget per vederlo qui',
        pickHint: 'Mostra i tuoi dati, alla dimensione che scegli, prima di aggiungere qualsiasi cosa.',
        pickNote: 'Scegli un widget per aggiungerlo',
        askAction: 'Scrivi la richiesta',
        pluginTag: 'plugin',
        pluginProvenance: ({ plugin }) => `Plugin ${plugin}`,
        readsChosenSession: 'legge la sessione che scegli, dove è in esecuzione',
        readsFrom: ({ source }) => `legge ${source}`,
        savedQueryOn: ({ source }) => `una query salvata su ${source}`,
        madeByYou: ({ date }) => `creato da te il ${date}`,
        madeByAgent: ({ date }) => `creato dal tuo agente il ${date}`,
        madeByPlugin: ({ date }) => `creato da un plugin il ${date}`,
        previewLiveData: 'Dal vivo, con i tuoi dati',
        addsAtSize: ({ size }) => `Lo aggiunge in formato ${size}. Puoi cambiarlo più tardi.`,
        backToWidgets: 'Widget',
        editTitle: ({ widget }) => `${widget} · input`,
        editHint: 'Cambia solo questa copia. Le altre mantengono i loro input.',
        preview: 'Anteprima',
        previewLive: 'Anteprima · dal vivo',
        previewWaiting: ({ field }) => `Scegli ${field} per vederlo qui`,
        listOnePerLine: "Uno per riga",
        listCommaSeparated: "Separati da virgole",
        previewAfterAdd: 'Comparirà qui una volta aggiunto',
        needed: 'Obbligatorio',
        stillNeeded: ({ field }) => `Manca ancora ${field}`,
        followGroup: 'Segui',
        pinGroup: 'Oppure fissane uno',
        another: 'Altro…',
        anotherSubtitle: 'Cerca tra tutto ciò a cui hai accesso',
        searchChoices: ({ field }) => `Cerca ${field}`,
        noChoices: 'Ancora niente da scegliere',
        optionsLoading: 'Caricamento delle scelte…',
        optionsFailed: 'Impossibile caricare le scelte',
        invalidValue: 'non trovato',
        inputsInvalid: 'Controlla gli input di questo widget',
        inputsUnavailable: 'Un input selezionato non è disponibile',
        connectionNeeded: ({ field }) => `Collega il tuo ${field}`,
        sessionDenied: ({ session }) => `Non hai più accesso a ${session}`,
        sessionUnavailable: ({ session }) => `${session} non è disponibile o è stata eliminata`,
        typeUnavailable: ({ field }) => `Il tipo di ${field} non è più disponibile`,
        inputUnavailable: ({ field }) => `${field} non è disponibile`,
        selectedInputUnavailable: ({ field, value }) => `${field}: ${value} non è più disponibile`,
        invalidReason: 'Non hai più accesso, oppure è stato rimosso.',
        viewerOnly: 'Qui ognuno lo vede con la propria connessione.',
        justAdded: ({ widget }) => `${widget} aggiunto`,
        saved: ({ widget }) => `${widget} salvato`,
        addFailed: 'Impossibile aggiungerlo. Riprova.',
        saveFailed: 'Impossibile salvare. Riprova.',
        homeTitle: 'Aggiungi alla Home',
        homeHint: 'Solo tu vedi la tua Home · su ogni dispositivo',
        addWidgets: 'Aggiungi widget',
        addToHome: 'Aggiungi alla Home',
        addToBoard: 'Aggiungi alla bacheca',
        addToCompanion: 'Aggiungi al compagno',
        editInputs: 'Modifica input…',
        width: 'Larghezza',
        size: 'Dimensione',
        sizes: { small: 'Piccolo', medium: 'Medio', wide: 'Largo', full: 'Completo', tall: 'Alto', large: 'Grande' },
        widthHalf: 'Metà',
        widthFull: 'Intera',
        thisSession: 'Questa sessione',
        choicesCount: ({ count }) => count === 1 ? '1 scelta' : `${count} scelte`,
        countOnHome: ({ count }) => `${count} nella Home`,
        countOnBoard: ({ count }) => `${count} sulla bacheca`,
        countInCompanion: ({ count }) => `${count} nel compagno`,
        thisPage: 'Questa pagina',
        thisProject: 'Questo progetto',
        thisCheckout: 'Questa copia di lavoro',
        areaPinned: 'Fissati',
        areaPinnedMeta: 'i tuoi widget in questa pagina',
        areaProjectTitle: 'Widget',
        areaProjectMeta: 'tuoi',
        areaAdd: ({ surface }) => `Aggiungi un widget a ${surface}`,
        areaAddTo: ({ surface }) => `Aggiungi a ${surface}`,
        areaHint: 'Solo tu vedi questi widget',
        countHere: ({ count }) => count === 1 ? '1 qui' : `${count} qui`,
        areaEmptyTitle: 'Ancora niente di fissato',
        areaEmptyReason: 'Fissa un widget per tenerlo qui, solo per te.',
        areaEmptyAction: 'Aggiungi un widget',
        areaUnavailableTitle: 'I widget non possono caricarsi qui',
        projectSourceUnavailableTitle: 'I widget compariranno qui quando il repository di questo progetto sarà noto',
        areaWriteFailed: 'Impossibile salvare questa modifica',
        areaApprovalPending: 'In attesa di approvazione',
        valueNotFound: ({ value }) => `Impossibile trovare ${value}`,
        chooseAnother: ({ field }) => `Scegli un altro valore per ${field}`,
        chooseField: ({ field }) => `Scegli ${field}`,
        widgetOptions: 'Opzioni del widget',
        moveTo: 'Sposta…',
    } } satisfies Pick<Readonly<Record<string, WidgetAddTranslation>>, "it">;

return { widgetAddTranslations };
})();

const Domain_widgetDefinitionTranslations = (() => {
type WidgetDefinitionTranslation = Shared_widgetDefinitionTranslations.WidgetDefinitionTranslation;

const widgetDefinitionTranslations = { it: {
        yourWidgets: "I tuoi widget",
        yourWidgetsHint: "creati da te o dai tuoi agenti",
        yourWidget: "Il tuo widget",
        moreInSource: "La fonte contiene più di quanto mostrato.",
        notCurrent: "Non aggiornato",
        aboutMenu: "Informazioni su questo widget",
        aboutTitle: "Informazioni su questo widget",
        aboutUnavailable: "Impossibile aprire questo widget ora.",
        aboutData: "Dati",
        aboutReads: "Legge",
        aboutInputs: "Input",
        aboutRefresh: "Aggiornamento",
        aboutUsedIn: "Usato in",
        savedFromSession: ({ session }) => `Salvato da ${session}`,
        aSession: "una sessione",
        madeInYourAccount: "Creato nel tuo account",
        edited: ({ time }) => `modificato ${time}`,
        readsOnly: "Solo lettura",
        runsOn: ({ machine }) => `gira su ${machine}`,
        withYourConnection: "con la tua connessione",
        readsResource: ({ read, plugin }) => `${read} da ${plugin}`,
        cannotRunAnythingElse: "Il widget non può eseguire nient’altro.",
        inputsThisCopy: "Solo per questa copia",
        refreshWhenOpen: "Quando lo apri",
        refreshNow: "Aggiorna ora",
        refreshing: "Aggiornamento…",
        refreshed: "Aggiornato",
        refreshFailed: "Impossibile aggiornare. Restano gli ultimi numeri.",
        placedOnHome: "Home",
        placedOnBoard: ({ board }) => `Bacheca ${board}`,
        placedOnABoard: "Una bacheca",
        placedInASession: "Una sessione",
        placedInAProject: "Un progetto",
        placedOnAPluginPage: "Una pagina di plugin",
        placedOnACorePage: "Una pagina dell’app",
        notPlacedYet: "Non ancora inserito da nessuna parte",
        otherPlacesNotListed: "I posti su altri dispositivi o superfici condivise non sono elencati qui.",
        editsChangeAll: ({ count }) => `Le modifiche al widget cambiano tutti e ${count}`,
        editsChangeEverywhere: "Le modifiche al widget lo cambiano ovunque sia usato",
        changeWithAgent: "Modifica con l’agente",
        changeDraft: ({ widget }) => `Modifica il widget «${widget}» in modo che `,
        duplicate: "Duplica",
        duplicated: ({ name }) => `Copia «${name}» salvata in I tuoi widget`,
        duplicateFailed: "Impossibile creare una copia. Riprova.",
        deleteSavedGroupNote: "Viene eliminato solo il gruppo salvato. Le copie già aggiunte restano dove sono.",
        saveMenu: "Salva come tuo widget…",
        saveMenuSubtitle: "Una copia per Home e le tue bacheche",
        saveTitle: "Salva come tuo widget",
        saveHint: "Una copia da mettere in Home, nelle tue bacheche e nei progetti. Questa sessione tiene la sua.",
        saveNote: "Salvato nel tuo account · solo tu",
        saveWidget: "Salva widget",
        saveFailed: "Impossibile salvare il widget. Riprova.",
        savedButNotPlaced: "Salvato in I tuoi widget, ma non aggiunto ovunque avevi scelto.",
        savedAsYours: ({ name }) => `«${name}» salvato in I tuoi widget`,
        name: "Nome",
        nameNeeded: "Dagli un nome",
        becomesViewerInput: "Diventa un input: ogni posto usa la tua connessione",
        becomesContextInput: "Diventa un input: ogni posto sceglie il suo",
        alsoAddTo: "Aggiungi anche a",
        alsoAddToNamed: ({ place }) => `Aggiungi anche a ${place}`,
        snapshotMenu: "Pubblica un’istantanea su questa bacheca…",
        snapshotMenuSubtitle: "Tutti qui vedono i tuoi numeri di adesso",
        snapshotTitle: "Pubblicare un’istantanea per tutti?",
        snapshotHint: ({ widget, time }) => `Chiunque possa aprire questa sessione vedrà ${widget} alle ${time}. Non si aggiornerà e la tua connessione resta tua.`,
        postSnapshot: "Pubblica istantanea",
        snapshotNotCurrent: "Il widget sta ancora ottenendo numeri aggiornati. Riprova quando li avrà.",
        snapshotFailed: "Impossibile pubblicare l’istantanea. Non è stato condiviso nulla.",
        snapshotAwaitingApproval: "In attesa di approvazione nella posta in arrivo. Nulla viene condiviso finché non è approvato.",
        snapshotPosted: "Istantanea pubblicata",
        snapshotNote: "Una copia di questi numeri. Non si aggiorna.",
        asOf: ({ time }) => `alle ${time}`,
    } } satisfies Pick<Readonly<Record<string, WidgetDefinitionTranslation>>, "it">;

return { widgetDefinitionTranslations };
})();

const Domain_widgetFrameTranslations = (() => {
type WidgetFrameTranslation = Shared_widgetFrameTranslations.WidgetFrameTranslation;

const widgetFrameTranslations = { it: {
        styleCard: 'Scheda',
        stylePlain: 'Semplice',
        surfaceHome: 'Home',
        surfaceBoard: 'Bacheca',
        surfaceCompanion: 'Compagno',
        showFrame: 'Mostra cornice',
        hideFrame: 'Nascondi cornice',
        thisWidgetOnly: 'Solo questo widget',
        surfaceUses: ({ surface, style }) => `${surface} usa ${style}`,
        useSurfaceDefault: ({ surface }) => `Usa l’impostazione di ${surface}`,
        likeTheOthers: ({ style }) => `${style}, come gli altri`,
        appearanceTitle: 'Widget',
        appearanceDescription: 'Come sono incorniciati i widget su questo dispositivo. Per cambiarne uno, usa il suo menu ⋯.',
        previewLabel: ({ surface, style }) => `${surface} · ${style}`,
        noticeChanged: 'Cornice cambiata',
        newChip: 'Nuovo',
        groupInputs: "Input…",
        groupWidth: "Larghezza",
        widthHalf: "Metà",
        widthFull: "Intera",
        groupFrame: "Cornice",
        groupDividers: "Divisori",
        dividersLines: "Linee",
        dividersNone: "Nessuno",
        groupSave: "Salva gruppo…",
        groupSaveSubtitle: "Tienilo nei Tuoi widget, per aggiungerlo ovunque",
        ungroup: "Separa",
        ungroupSubtitle: ({ count }) => count === 1 ? 'Il suo widget resta qui, sulla propria scheda' : `I suoi ${count} widget restano qui, ognuno sulla propria scheda`,
        groupRemove: "Rimuovi il gruppo e i suoi widget",
        moveToGroup: "Sposta in un gruppo",
        removeFromGroup: "Rimuovi dal gruppo",
        removeFromGroupSubtitle: "Di nuovo sulla propria scheda, accanto al gruppo",
        groupWith: "Raggruppa con…",
        groupWithNew: "Un nuovo gruppo con i due",
        groupSlot: "Trascina qui un widget o",
        groupSlotAdd: "aggiungine uno",
        groupUntitled: "Gruppo senza titolo",
        groupName: "Nome del gruppo",
        groupMenu: "Opzioni del gruppo",
        followingGroup: "Segue il gruppo",
        followingGroupValue: ({ value }) => `Segue il gruppo · ${value}`,
        groupInputsTitle: ({ group }) => `${group} · input`,
        groupInputsHint: "Si imposta una volta. I widget che seguono il gruppo lo usano.",
        groupFollowCount: ({ following, count }) => `${following} widget su ${count} seguono il gruppo`,
        groupFollows: "Segue",
        groupOwnValue: "Valore proprio",
        groupGrantsNothing: "Il gruppo non concede nulla: ogni widget controlla sempre il proprio accesso.",
        groupSaved: ({ name }) => `${name} è nei Tuoi widget`,
        groupSaveFailed: "Impossibile salvare il gruppo. Riprova.",
        moveIntoGroupNamed: ({ group }) => `Sposta in ${group}`,
        intoGroupAbove: ({ target }) => `Sopra ${target} · appare senza cornice nel gruppo`,
        intoGroupBelow: ({ target }) => `Sotto ${target} · appare senza cornice nel gruppo`,
        intoGroupEnd: "Appare senza cornice nel gruppo",
        reorderInGroupDetail: "Solo l’ordine",
        outOfGroupDetail: ({ group }) => `Fuori da ${group} · torna ad avere la sua scheda`,
        wholeGroupDetail: ({ count }) => count === 1 ? `Il suo widget si sposta con lui` : `I suoi ${count} widget si spostano con lui`,
        cantPutInGroup: ({ group }) => `Non si può mettere in ${group}`,
        groupRefusedWidth: "Serve tutta la larghezza e questo gruppo è a metà. Rilascialo accanto o rendi il gruppo a larghezza intera.",
        groupRefusedNesting: "Un gruppo non può stare dentro un gruppo. Rilascialo sopra o sotto, oppure separalo prima.",
        groupNeedsFullWidth: ({ widget }) => `${widget} ha bisogno di tutta la larghezza`,
        groupFacts: ({ width, count }) => `${width} · ${count} widget`,
        groupCannotTake: ({ group }) => `Serve tutta la larghezza; ${group} è a metà`,
        groupA11y: ({ name }) => `Gruppo: ${name}`,
        groupCount: ({ count }) => `Gruppo · ${count}`,
        groupWidgetCount: ({ count }) => `Gruppo · ${count} widget`,
        addsAtWidth: ({ width }) => `Lo aggiunge con larghezza ${width}.`,
        presetEdited: "Modificato",
        presetEditedTail: ({ changes }) => changes ? ` ora è tuo: hai ${changes}. Il modello resta disponibile.` : ' ora è tuo. Il modello resta disponibile.',
        presetChangeList: ({ first, second, more }) => more > 0 ? `${first}, ${second} e fatto ${more === 1 ? "un'altra modifica" : `altre ${more} modifiche`}` : second ? `${first} e ${second}` : first,
        presetMovedUp: ({ item }) => `spostato ${item} in alto`,
        presetMovedDown: ({ item }) => `spostato ${item} in basso`,
        presetAdded: ({ item }) => `aggiunto ${item}`,
        presetRemoved: ({ item }) => `rimosso ${item}`,
        presetChanged: ({ item }) => `modificato ${item}`,
        presetRenamed: "cambiato il nome",
        groupProvenance: ({ origin, date, count }) => ['Il tuo gruppo', origin && date ? `salvato da ${origin} il ${date}` : date ? `salvato il ${date}` : origin ? `salvato da ${origin}` : null, count === 1 ? '1 widget' : `${count} widget`].filter(Boolean).join(' · '),
        groupAddsFollowing: ({ name, count, value }) => `Aggiunge ${name} con ${count === 1 ? 'il suo widget' : `i suoi ${count} widget`}${value ? `, seguendo ${value}` : ''}`,
        groupInputAskedOnce: ({ count }) => count === 1 ? 'Chiesto una volta. Il widget lo segue.' : `Chiesto una volta. I ${count} widget lo seguono.`,
        presetReset: "Torna al modello",
        presetResetDone: ({ name }) => `${name} è tornato al modello`,
        presetResetFailed: "Impossibile tornare al modello.",
        undo: "Annulla",
        groupAddTo: "Aggiungi a…",
        groupAddToSubtitle: "Una copia in un’altra Home o progetto",
        groupCopied: ({ name, place }) => `${name} copiato in ${place}`,
        groupCopyFailed: "Impossibile copiare il gruppo. Riprova.",
        groupSaveTitle: "Salva gruppo",
        groupSaveHint: ({ count }) => `Tienilo nei Tuoi widget, con i suoi ${count} widget, per aggiungerlo ovunque.`,
        groupSaveNote: "Una copia: questo gruppo resta com’è.",
    } } satisfies Pick<Readonly<Record<string, WidgetFrameTranslation>>, "it">;

return { widgetFrameTranslations };
})();

const Domain_widgetGlanceTranslations = (() => {
type WidgetGlanceTranslation = Shared_widgetGlanceTranslations.WidgetGlanceTranslation;

const widgetGlanceTranslations = { it: {
        changesTitle: 'Modifiche',
        localServicesTitle: 'Servizi locali',
        changesSource: 'Git',
        reviewChanges: 'Rivedi le modifiche',
        notARepo: 'La cartella di questa sessione non è un repository Git.',
        noChanges: 'Ancora nessuna modifica. Qui compaiono i file modificati dall’agente.',
        changesLoading: 'Caricamento delle modifiche',
        running: 'In esecuzione',
        notRunning: 'Non in esecuzione',
        nothingRunning: 'Niente in esecuzione. Qui compaiono i servizi avviati da questa sessione.',
        servicesLoading: 'Caricamento dei servizi locali',
        servicesReadFailed: 'Impossibile leggere i servizi locali. Riprova.',
        noMachine: 'Questa sessione non ha una macchina da interrogare.',
        changedCount: ({ count }) => `${count} modificati`,
        moreFiles: ({ count }) => (count === 1 ? '1 altro file' : `altri ${count} file`),
        runningCount: ({ count }) => `${count} in esecuzione`,
        openInBrowser: ({ name }) => `Apri ${name} nel browser`,
        paneLinkA11y: ({ pane }) => `${pane}. Si apre accanto alla chat`,
    } } satisfies Pick<Readonly<Record<string, WidgetGlanceTranslation>>, "it">;

return { widgetGlanceTranslations };
})();

const Domain_workStatusTranslations = (() => {
type WorkStatusTranslations = Shared_workStatusTranslations.WorkStatusTranslations;

const en = Shared_workStatusTranslations.en;

const it: WorkStatusTranslations = {
    buckets: {
        needs_you: 'Ha bisogno di te',
        working: 'In corso',
        finished: 'Concluso',
        idle: 'Inattivo',
        offline: 'Offline',
    },
};

const workStatusTranslations = { it: { ...it, task: { stopped: 'Interrotta', linkFailed: 'La sessione è stata creata, ma il collegamento all’attività non è stato salvato. Riprova per collegare la stessa sessione.' } } };

return { workStatusTranslations };
})();

const Domain_workflowActionTranslations = (() => {
type Copy = Shared_workflowActionTranslations.Copy;

const en = Shared_workflowActionTranslations.en;

const workflowActionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "it"> = { it: {
        host: "Happier",
        structure: "Struttura",
        callWebhook: "Chiama un webhook",
        runCommand: "Esegui un comando",
        commandValuesInEnv: "Passa i valori del workflow tramite variabili d’ambiente. Il testo del comando resta come lo hai scritto.",
        waitForWork: "Attendi il lavoro",
        waitForWorkDescription: "Attendi che il lavoro scelto raggiunga lo stato indicato",
        callWebhookDescription: "Invia una richiesta a un indirizzo web. Nessun turno agente.",
        runCommandDescription: "Esegui un comando shell sulla tua macchina. Nessun turno agente.",
        artifactCreate: "Crea un documento",
        artifactGet: "Leggi un documento",
        artifactList: "Elenca documenti",
        artifactUpdate: "Aggiorna un documento",
        artifactDelete: "Elimina un documento",
        artifactPublish: "Pubblica un file",
        artifactRevisions: "Elenca versioni del documento",
        artifactRestore: "Ripristina una versione del documento",
        artifactUsage: "Leggi l’utilizzo dello spazio per i documenti",
        artifactShare: "Condividi un documento tramite link",
        artifactLinks: "Elenca link del documento",
        artifactRevoke: "Revoca un link del documento",
        artifactAudit: "Leggi l’attività dei link del documento",
        sessionRole: "Imposta il ruolo di una sessione",
        sessionRoleOverride: "Modifica le impostazioni del ruolo di una sessione",
        sessionRoleClear: "Ripristina le impostazioni del ruolo di una sessione",
        sessionRoleAdd: "Aggiungi un ruolo alla sessione",
        sessionRoleRemove: "Rimuovi un ruolo dalla sessione",
        sessionNotes: "Imposta note della sessione",
        sessionRolesApply: "Applica i ruoli alle sessioni subordinate",
        roleList: "Elenca ruoli",
        roleGet: "Leggi un ruolo",
        roleCreate: "Crea un ruolo",
        roleUpdate: "Aggiorna un ruolo",
        roleDelete: "Elimina un ruolo",
        roleOverride: "Modifica impostazioni del ruolo",
        roleReset: "Ripristina impostazioni del ruolo",
        widgetCatalog: "Elenca widget disponibili",
        widgetInstances: "Elenca widget posizionati",
        widgetAdd: "Aggiungi un widget",
        widgetRemove: "Rimuovi un widget",
        widgetMove: "Sposta un widget",
        widgetRename: "Rinomina un widget",
        widgetSize: "Imposta la dimensione di un widget",
        widgetFrame: "Imposta la cornice di un widget",
        widgetInputs: "Leggi gli input di un widget",
        widgetValidate: "Verifica gli input di un widget",
        widgetSetInputs: "Imposta gli input di un widget",
        widgetResetInputs: "Ripristina gli input di un widget",
        widgetLayout: "Leggi la disposizione dei widget",
        widgetUpdateLayout: "Modifica la disposizione dei widget",
        widgetDefinitions: "Elenca widget salvati",
        widgetDefinition: "Leggi un widget salvato",
        widgetCreate: "Crea un widget",
        widgetUpdate: "Aggiorna un widget salvato",
        widgetDuplicate: "Duplica un widget salvato",
        widgetDelete: "Elimina un widget salvato",
        widgetSave: "Salva un widget della sessione",
    } };

return { workflowActionTranslations };
})();

const Domain_workflowAgentAuthoringTranslations = (() => {
type Edit = Shared_workflowAgentAuthoringTranslations.Edit;

type RepeatableMessage = Shared_workflowAgentAuthoringTranslations.RepeatableMessage;

type Copy = Shared_workflowAgentAuthoringTranslations.Copy;

const en = Shared_workflowAgentAuthoringTranslations.en;

const repeatable = { it: { repeatable: 'Rendi ripetibile', repeatableDescription: 'Chiedi all’agente di trasformare ciò che ha funzionato in un workflow riutilizzabile.', repeatablePrompt: 'Trasforma ciò che abbiamo fatto qui in un workflow che posso rieseguire. Progettalo, verificalo con workflow.validate e salvalo, ma non eseguirlo.', repeatableMessagePrompt: 'Trasforma ciò che abbiamo fatto in questo messaggio in un workflow che posso rieseguire. Progettalo, verificalo con workflow.validate e salvalo, ma non eseguirlo.', repeatableMessageSource: ({ text }: RepeatableMessage) => `“${text}”` } };

const workflowAgentAuthoringTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "it"> = { it: { ...repeatable.it, create: 'Crea con un agente', edit: 'Modifica con un agente', agent: 'Agente', description: 'Una nuova sessione progetta il workflow con te, lo verifica e lo salva. Nulla viene eseguito finché non scegli Esegui ora.', changedByAgent: 'Modificato dall’agente', saved: 'Salvato dall’agente ora', savedAge: ({ age }) => `Salvato dall’agente ${age}`, savedWorkflow: ({ name }) => `Workflow salvato · ${name}`, updated: 'Workflow aggiornato', changed: ({ count }) => `Workflow aggiornato · ${count} passi modificati`, openEditor: 'Apri nell’editor', openSession: 'Apri in Sessioni', createPrompt: 'Progetta con me un workflow, verificalo con workflow.validate e poi salvalo. Non eseguirlo.', createLead: 'Aiutami a creare un workflow che ', editPrompt: ({ name, definitionId, headerVersion, bodyVersion }) => `Il workflow salvato “${name}” ha id ${definitionId} e revisione: intestazione ${headerVersion}, corpo ${bodyVersion}. Modificalo con workflow.definition.edit e usa workflow.definition.update solo per sostituirlo interamente. Verificalo con workflow.validate prima di salvare. Non eseguirlo.`, editLead: ({ name }) => `Aiutami a modificare ${name}: ` } };

return { repeatable, workflowAgentAuthoringTranslations };
})();

const Domain_workflowBuiltinTranslations = (() => {
type WorkflowBuiltinTranslations = Shared_workflowBuiltinTranslations.WorkflowBuiltinTranslations;

const en = Shared_workflowBuiltinTranslations.en;

const it: WorkflowBuiltinTranslations = {
    keepGoing: { title: 'Continua fino alla fine', description: 'Continua finché l’obiettivo non è raggiunto' },
    reviewAndConverge: { title: 'Revisiona e converge', description: 'Rivedi finché i revisori non sono d’accordo', apply: 'Applica', verifyAndFix: 'Verifica e correggi', verifyOnly: 'Solo verifica', rounds: 'Cicli prima di fermarsi' },
    planWithAPanel: { title: 'Pianifica con un panel', description: 'Più agenti pianificano affiancati, poi il piano attende la tua revisione.', inputs: { request: 'Richiesta', requestPlaceholder: 'Cosa deve pianificare il panel?', engines: 'Pianificatori' } },
    openAPullRequest: { title: 'Apri una pull request', description: 'Chiede un secondo parere, poi apre una pull request. Se il secondo parere non è d’accordo, ti aspetta.', inputs: { base: 'Branch di base', title: 'Titolo della pull request', body: 'Descrizione', question: 'Domanda per il secondo parere' } },
};

const workflowBuiltinTranslations = { it } as const;

return { workflowBuiltinTranslations };
})();

const Domain_workflowFieldTranslations = (() => {
const workflowFieldTranslations = { it: {
        sessionId: "Sessione",
        triggerId: "Attivazione",
        engineIds: "Revisori",
        backendTargetKeys: "Pianificatori",
        reviewCommentAuthorIntent: "Riscontri",
        commentId: "Riscontro",
        expectedServerRevision: "Versione del riscontro",
        clientMutationId: "Aggiornamento",
        projectId: "Progetto",
        workspace: "Area di lavoro",
        toState: "Stato",
        expectedState: "Stato attuale",
        disposition: "Importanza",
        allPages: "Tutti i riscontri",
        permissionMode: "Permessi",
        target: "Esegue in",
        cwd: "Cartella di lavoro",
        maxRounds: "Numero massimo di cicli",
        strikes: "Verifiche senza progressi",
        secondOpinion: "Seconda opinione",
        useJudge: "Giudice",
        diffFingerprint: "Modifiche esaminate",
        url: "URL",
        body: "Corpo JSON",
        command: "Comando",
        env: "Variabili d’ambiente",
    } };

return { workflowFieldTranslations };
})();

const Domain_workflowEditorPageTranslations = (() => {
type WorkflowEditorPageTranslations = Shared_workflowEditorPageTranslations.WorkflowEditorPageTranslations;

const workflowFieldTranslations = {...Domain_workflowFieldTranslations.workflowFieldTranslations, ...EnglishFeatures.workflowFieldTranslations.workflowFieldTranslations};

const en = Shared_workflowEditorPageTranslations.en;

const pluralPl = Shared_workflowEditorPageTranslations.pluralPl;

const pluralRu = Shared_workflowEditorPageTranslations.pluralRu;

const it: WorkflowEditorPageTranslations = {
    fields: workflowFieldTranslations.it,
    blocks: {
        actionSub: 'Azione · nessun turno dell’agente',
        notSet: 'Non impostato',
        set: 'Imposta',
        clear: 'Cancella',
        required: 'Obbligatorio',
        noFields: 'Niente da impostare per questa azione.',
        workflowSub: 'Esegue un altro workflow · i suoi passaggi compaiono in questa esecuzione',
        builtin: 'Integrato',
        waitTitle: 'Attendere te',
        waitSub: 'Questa corsia attende finché non continui',
        waitSubRoot: 'Questo flusso di lavoro attende finché non continui.',
        waitPlaceholder: 'Cosa dovresti controllare o decidere qui?',
        returnsText: 'Restituisce testo',
        returnsFields: ({ fields }) => `Restituisce ${fields}`,
        workflowDefaults: 'Impostazioni del flusso di lavoro',
        addNamedResults: 'Aggiungi risultati con nome',
        menuRun: 'Esegui un workflow',
        menuAction: 'Azione',
        menuWait: 'Attendere te',
        actionSearch: 'Cerca azioni',
        workflowSearch: 'Cerca workflow',
        libraryGroup: 'I tuoi workflow',
        noAgentTurn: 'Notifica, rivedi, pubblica — senza turno dell’agente',
        agentSub: 'Un’istruzione per un agente',
        parallelSub: 'Rami eseguiti contemporaneamente',
        loopSub: 'Per ogni elemento, più volte o fino a…',
        ifSub: 'Solo quando lo indica un risultato',
        actionSourcePhone: 'Il tuo telefono',
        actionSourceReview: 'Motori di revisione',
        useNumber: 'Usa un numero',
        actionUnavailable: ({ action }: { action: string }) => `${action} non è disponibile qui.`,
        childInputs: ({ workflow }: { workflow: string }) => `Gli input arrivano da ${workflow}.`,
        retryLoading: "Riprova a caricare",
        openWorkflow: ({ workflow }) => `Apri ${workflow}`,
        selfRef: ({ workflow }: { workflow: string }) => `${workflow} esegue questo workflow, quindi non può essere eseguito al suo interno.`,
        maxFromInput: ({ name }: { name: string }) => `Dall’input · ${name}`,
        useInput: ({ name }: { name: string }) => `Usa l’input ${name}`,
    },
    backToRun: 'Torna all’esecuzione',
    reviewedCopyTitle: 'Controlla prima di salvare',
    reviewedCopyBody: 'Questa è una copia di un’esecuzione. Si salvano i passaggi e le impostazioni, non la cronologia o i risultati. Posizione, modalità di esecuzione e valori di input riguardano solo l’esecuzione. Controlla i riferimenti a sessioni esistenti, cartelle, profili, modelli, servizi e server MCP prima di riutilizzarli.',
    chromeTitle: 'Workflow',
    untitled: 'Workflow senza titolo',
    nameLabel: 'Nome del workflow',
    descriptionPlaceholder: 'Aggiungi una descrizione',
    descriptionLabel: 'Descrizione',
    save: 'Salva',
    flow: 'Flusso',
    flowSubtitle: 'Questa bozza come mappa',
    settings: 'Impostazioni del workflow',
    settingsSubtitle: 'Ogni passaggio le usa a meno che non le cambi.',
    deleteWorkflow: 'Elimina workflow',
    deleteBody: 'Le esecuzioni passate vengono conservate.',
    discardChangesBody: 'Torna all’ultima versione salvata. Annulla ripristina le modifiche.',
    deleteFailedTitle: 'Impossibile eliminare il workflow',
    changedForStep: 'Modificato per questo passaggio',
    issuesToFix: ({ count }: { count: number }) => (count === 1 ? '1 cosa da correggere prima di eseguire' : `${count} cose da correggere prima di eseguire`),
    readyToRun: 'Pronto',
    saveStatus: {
        notSaved: 'Non ancora salvato',
        unsaved: 'Modifiche non salvate',
        saving: 'Salvataggio…',
        saved: 'Salvato',
        savedJustNow: 'Salvato ora',
        savedAge: ({ age }: { age: string }) => `Salvato ${age}`,
        failed: 'Impossibile salvare',
        yourEdits: 'Le tue modifiche',
        newerVersion: 'La versione più recente',
        newerVersionRevision: ({ revision }: { revision: string }) => `La versione più recente · ${revision}`,
    },
    where: {
        label: 'Dove viene eseguito',
        choose: 'Scegli dove viene eseguito',
    },
    sections: {
        whereTitle: 'Dove viene eseguito',
        machineAndProject: 'Macchina e progetto',
        eachStepRunsIn: 'Ogni passaggio viene eseguito in',
        eachStepSession: 'Ogni passaggio compare nell’elenco delle sessioni, sotto questa esecuzione.',
        eachStepBackground: 'Ogni passaggio viene eseguito in background, sotto questa esecuzione.',
        aSession: 'Una sessione',
        aBackgroundRun: 'Un’esecuzione in background',
        agentTitle: 'Agente e modello',
        agentDescription: 'I passaggi li usano a meno che non scelgano i propri.',
        rolesTitle: 'Ruoli per questo workflow',
        conversationTitle: 'Conversazione e spazio di lavoro',
        inputsTitle: 'Input e risultato',
    },
    unavailable: {
        machine_not_selected: 'Scegli prima una macchina.',
        capability_unknown: 'Verifica di ciò che questa macchina supporta.',
        machine_does_not_support_detached_runs: 'Questa macchina non può ancora eseguire in background.',
    },
    /** Workflow settings and Step options (U-9): group summaries and the block subject. */
    inspector: {
        stepOptions: 'Opzioni del passaggio',
        whereMissing: 'Nessuna macchina scelta',
        none: 'Nessuno',
        inputCount: ({ count }) => count === 1 ? '1 input' : `${count} input`,
        finalOutput: ({ output }) => `Risultato finale: ${output}`,
        originSession: 'La sessione che l’ha avviato',
        differsFromWorkflow: 'diverso dal workflow',
        followsWorkflow: 'usa le impostazioni del workflow',
        advancedTitle: 'Avanzate',
        deadline: ({ ms }) => `Attende il risultato per ${ms} ms`,
        workflowDefault: ({ value }) => `Predefinito del workflow · ${value}`,
        aSession: 'Una sessione…',
        continues: ({ session }) => `Continua ${session}`,
        runsIn: 'Viene eseguito in',
        runsInBoundBySession: 'Continua una sessione, quindi viene eseguito in quella sessione.',
        reviewTitle: 'Rivedi prima di continuare',
        reviewDescription: 'I passaggi successivi di questa corsia attendono che tu usi, modifichi o rigeneri il risultato. Il resto del lavoro prosegue.',
        reviewEvaluator: 'Ogni iterazione attende la tua revisione.',
        reviewsBeforeContinuing: 'Revisione prima di continuare',
        resultTitle: 'Risultato',
        resultFromAction: ({ action }) => `Definito da ${action}`,
        resultFromWorkflow: ({ workflow }) => `Restituisce ciò che restituisce ${workflow}`,
        back: 'Indietro',
        options: 'Opzioni',
        itemConversation: 'Una conversazione per elemento; i passaggi interni la condividono.',
        dropContinue: ({ session }) => `Continua ${session} in questo passaggio`,
        dropRefused: ({ session, machine, where }) => `${session} è su ${machine}; questo workflow viene eseguito su ${where}.`,
        lanes: ({ count }) => `In parallelo · ${count} corsie`,
        laneCount: ({ count }) => (count === 1 ? '1 corsia' : `${count} corsie`),
        lane: ({ position }) => `Corsia ${position}`,
        forEachIn: ({ source }) => `Per ogni elemento in ${source}`,
        atATime: ({ count }) => `${count} alla volta`,
        repeatTimes: ({ count }) => `Ripeti ${count} volte`,
        repeatUntil: ({ condition }) => `Ripeti finché ${condition}`,
        repeatUntilDecided: 'Ripeti finché un passaggio dice di fermarsi',
        ifSentence: ({ condition }) => `Se ${condition}`,
        onlyWhenSentence: ({ condition }) => `Solo quando ${condition}`,
        conditionAll: 'valgono tutte',
        conditionAny: 'ne vale almeno una',
        conditionNot: ({ condition }) => `non (${condition})`,
        returnsStructured: 'Restituisce dati strutturati',
        returnsDecision: 'Restituisce una decisione',
    },
};

const workflowEditorPageTranslations = { it } as const;

return { workflowEditorPageTranslations };
})();

const Domain_workflowExamplesTranslations = (() => {
type ExampleCopy = Shared_workflowExamplesTranslations.ExampleCopy;

type Copy = Shared_workflowExamplesTranslations.Copy;

const workflowExamplesTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "it"> = { it: {
        sessionNotifyDescription: "Una notifica ogni volta che l’agente di questa sessione ha bisogno del tuo intervento.",
        sessionDailySummaryDescription: "Un riepilogo qui ogni giorno alle 09:00.",
        sessionTestDescription: "Esegue un comando di test modificabile dopo ogni turno completato, fallito o annullato.",
        notifyWhenAgentWaits: { title: "Avvisami quando un agente attende", description: "Scegli una sessione e ricevi una notifica quando il suo agente ha bisogno del tuo intervento." },
        dailySummaryInSession: { title: "Riepilogo giornaliero in questa sessione", description: "Scegli una sessione per un riepilogo ogni giorno alle 09:00." },
        memoryUpkeepInSession: { title: 'Manutenzione della memoria', description: 'Rivedi la memoria di questa sessione ogni giorno alle 09:00 e mantieni aggiornati i fatti utili.' },
        installDepsInWorktree: { title: "Installa le dipendenze in un nuovo albero di lavoro", description: "Crea un nuovo albero di lavoro ed esegui lì un comando di installazione modificabile." },
        testAfterEveryTurn: { title: "Prova dopo ogni turno", description: "Scegli una sessione ed esegui un comando di prova modificabile dopo ogni turno completato, fallito o annullato." },
        noSessions: "Avvia una sessione di lavoro per usare questo modello.",
        nodes: { ask: 'Chiedi', 'review-correctness': 'Verifica la correttezza', 'review-tests': 'Rivedi i test', summarize: 'Riassumi i risultati', analyze: 'Analizza', review: 'Rivedi', fix: 'Correggi', check: 'Verifica', classify: 'Classifica', reply: 'Prepara una risposta', digest: 'Riassumi le modifiche' },
        title: 'Inizia da un esempio', fromExample: 'Da un esempio', description: 'Ognuno si apre come bozza. Nulla parte finché non scegli Esegui ora.', sessionDescription: 'Ognuno si apre come bozza in questa sessione. Nulla parte finché non lo attivi.', use: 'Usa questo', chooseSession: 'Scegli una sessione…', builtInDescription: 'Parte di Happier. Duplica per modificarlo.', stepCount: ({ count }) => `${count} ${count === 1 ? 'passo' : 'passi'}`,
        askOnce: { title: 'Chiedi una volta', description: 'Un passo: chiedi qualcosa a un agente e ricevi la risposta.' },
        reviewPullRequest: { title: 'Rivedi una pull request', description: 'Due revisori in parallelo, poi un riepilogo di tutti i risultati.' },
        workThroughEachFile: { title: 'Lavora su ogni file', description: 'Per ogni file di una lista, uno alla volta: analizzalo, poi rivedi la modifica.' },
        repairUntilItPasses: { title: 'Ripara fino al successo', description: 'Ripara e verifica fino al successo o all’esaurimento dei tentativi consentiti. Poi rivedi l’ultima correzione.' },
        triageAnIssue: { title: 'Classifica una issue', description: 'Classifica una issue. Se è un bug, correggilo; altrimenti prepara una risposta.' },
        morningDigest: { title: 'Riepilogo mattutino', description: 'Riassumi le modifiche del progetto e inviatele. Aggiungi un trigger per ogni mattina.' },
    } };

return { workflowExamplesTranslations };
})();

const Domain_workflowPluginTranslations = (() => {
type Copy = Shared_workflowPluginTranslations.Copy;

const en = Shared_workflowPluginTranslations.en;

const workflowPluginTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "it"> = { it: { fromPlugins: 'Dai plugin', readOnly: 'Sola lettura · duplica nella tua libreria per modificare', duplicateToLibrary: 'Duplica nella tua libreria' } };

return { workflowPluginTranslations };
})();

const Domain_workflowRunVisibilityTranslations = (() => {
type VisibilityCopy = Shared_workflowRunVisibilityTranslations.VisibilityCopy;

const workflowRunVisibilityTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', VisibilityCopy>, "it"> = { it: { title: "Visibilità", chooseTeam: "Scegli un team", loadFailed: "Impossibile verificare chi può vedere questa esecuzione", machines: "Viene eseguito sulle tue macchine", transcripts: "I membri del team possono vedere le conversazioni dei passaggi.", requiredSessionsEditable: "Le sessioni di questo team possono essere modificate dai suoi membri", visibleTo: ({ team }) => "Visibile a " + team } };

return { workflowRunVisibilityTranslations };
})();

const Domain_workflowRunCompositionTranslations = (() => {
const workflowRunVisibilityTranslations = {...Domain_workflowRunVisibilityTranslations.workflowRunVisibilityTranslations, ...EnglishFeatures.workflowRunVisibilityTranslations.workflowRunVisibilityTranslations};

const en = Shared_workflowRunCompositionTranslations.en;

const workflowRunCompositionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "it"> = { it: { visibility: workflowRunVisibilityTranslations.it, runWithAnotherAgent: 'Esegui di nuovo con un altro agente', agentForStep: ({ step }) => `Agente per ${step}`, chooseAgent: 'Scegli un agente o un ruolo' } };

return { workflowRunCompositionTranslations };
})();

const Domain_workflowRunListTranslations = (() => {
type Progress = Shared_workflowRunListTranslations.Progress;

const en = Shared_workflowRunListTranslations.en;

const workflowRunListTranslations = { it: {
        observedProgress: ({ status }: { status: string }) => `Osservato: ${status}`,
        definitions: 'Definizioni',
        stepsProgress: ({ completed, total }: Progress) => `${completed} di ${total} passaggi`,
        loopProgress: ({ completed, total }: Progress) => `${completed} di ${total} elementi`,
        startedByAgent: 'Avviato da un agente',
        startedByTrigger: 'Avviato da un trigger',
    } } satisfies Pick<Record<string, typeof en>, "it">;

return { workflowRunListTranslations };
})();

const Domain_workflowRunRoleTranslations = (() => {
const en = Shared_workflowRunRoleTranslations.en;

const workflowRunRoleTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "it"> = { it: { rolesTitle: 'Ruoli per questa esecuzione', rolesYour: 'I tuoi ruoli', rolesChanged: ({ count }) => `${count} modificati per questa esecuzione`, rolesUnchanged: 'Tutto il resto rimane invariato.', useYourRole: 'Usa il tuo ruolo', targetsTitle: 'Ogni passaggio viene eseguito in', rolesPrefillFailed: 'Impossibile leggere i ruoli della tua ultima esecuzione. Riprova.' } };

return { workflowRunRoleTranslations };
})();

const Domain_workflowStartTranslations = (() => {
type Copy = Shared_workflowStartTranslations.Copy;

const workflowRunRoleTranslations = {...Domain_workflowRunRoleTranslations.workflowRunRoleTranslations, ...EnglishFeatures.workflowRunRoleTranslations.workflowRunRoleTranslations};

const workflowRunCompositionTranslations = {...Domain_workflowRunCompositionTranslations.workflowRunCompositionTranslations, ...EnglishFeatures.workflowRunCompositionTranslations.workflowRunCompositionTranslations};

const en = Shared_workflowStartTranslations.en;

const workflowStartTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "it"> = { it: { ...workflowRunRoleTranslations.it, ...workflowRunCompositionTranslations.it, shortcutStarts: 'avvia', neededNamed: ({ name }) => `Input · manca ${name}`, addToStart: ({ name }) => `Aggiungi ${name} per avviare`, workflow: 'Workflow', inputs: 'Input', start: 'Avvia', starting: 'Avvio…', stillStarting: 'Avvio ancora in corso…', needed: ({ count }) => `Input · ne mancano ${count}`, required: 'Necessario per avviare', preview: 'Cosa farà', unsaved: 'Include modifiche non salvate', remove: 'Torna a una sessione normale', search: 'Trova un workflow', builtin: 'Integrati', library: 'La tua libreria', noInputs: 'Nessun input necessario', asksFor: ({ names }) => `Richiede ${names}`, optional: 'Facoltativo — lasciato vuoto', defaultValue: ({ value }) => `Predefinito: ${value}` } };

return { workflowStartTranslations };
})();

const Domain_workflowsDestinationTranslations = (() => {
type WorkflowsDestinationTranslations = Shared_workflowsDestinationTranslations.WorkflowsDestinationTranslations;

const en = Shared_workflowsDestinationTranslations.en;

const it: WorkflowsDestinationTranslations = {
    description: 'Ricette che i tuoi agenti eseguono sulle tue macchine: quando vuoi tu, secondo una pianificazione o quando succede qualcosa.',
    import: 'Importa',
    addAccessibility: 'Aggiungi un flusso di lavoro',
    moreAccessibility: 'Altre opzioni dei flussi di lavoro',
    addMenu: {
        newWorkflowSubtitle: 'Parti da una bozza vuota',
        importSubtitle: 'Un file JSON di flusso di lavoro',
    },
    sections: {
        needsYou: 'Ti aspetta',
        running: 'In esecuzione',
        library: 'Libreria',
        sharedWithYou: 'Condivisi con te',
        triggers: 'Attivatori',
        history: 'Cronologia',
    },
    allRuns: 'Tutte le esecuzioni',
    lastRun: ({ age }) => `ultima esecuzione ${age}`,
    strip: {
        label: ({ count, parts }) => `${count === 1 ? 'Ultima esecuzione' : `Ultime ${count} esecuzioni`}: ${parts}`,
        labelPlain: ({ count }) => (count === 1 ? 'Ultima esecuzione' : `Ultime ${count} esecuzioni`),
        completed: ({ count }) => `${count} ${count === 1 ? 'completata' : 'completate'}`,
        failed: ({ count }) => `${count} ${count === 1 ? 'non riuscita' : 'non riuscite'}`,
        needsYou: ({ count }) => `${count} ti ${count === 1 ? 'aspetta' : 'aspettano'}`,
        separator: ', ',
    },
    runSettings: 'Impostazioni di esecuzione',
    libraryEmpty: 'I flussi di lavoro che salvi compaiono qui.',
    waitingForYou: ({ age }) => `Ti aspetta · ${age}`,
    stateAge: ({ state, age }) => `${state} · ${age}`,
    triggerRow: ({ when, then }) => `${when} · ${then}`,
    thenSendPrompt: 'Invia un prompt',
    thenRunWorkflow: 'Esegui un flusso di lavoro',
    offline: 'Offline',
    off: 'Disattivato',
    columnLoadFailed: 'Impossibile caricare i flussi di lavoro. Nulla di ciò che hai salvato va perso.',
    firstVisitTitle: 'Salva i prompt che funzionano e rieseguili',
    firstVisitBody: 'Un flusso di lavoro è un insieme di passaggi che i tuoi agenti eseguono in ordine, in parallelo o una volta per elemento: quando vuoi tu, secondo una pianificazione o quando succede qualcosa.',
    importPrompt: 'Hai un file di flusso di lavoro?',
    loadMoreWorkflows: 'Carica altri flussi di lavoro',
    searchPlaceholder: 'Cerca flussi di lavoro',
    noMatch: ({ query }) => `Nessun flusso di lavoro corrisponde a «${query}»`,
    views: {
        all: 'Tutti',
        triggered: 'Con attivatore',
        active: 'Attive',
        needsYou: 'Ti aspetta',
        libraryAccessibility: 'Quali flussi di lavoro mostrare',
        historyAccessibility: 'Quali esecuzioni mostrare',
    },
    history: {
        title: 'Cronologia',
        description: 'Ogni esecuzione che hai avviato, in qualunque modo sia partita.',
        loadMore: 'Carica altre esecuzioni',
        loadFailedTitle: 'Impossibile caricare le esecuzioni',
        loadFailedBody: 'Il tuo lavoro non è interessato.',
        review: 'Rivedi',
        rowMeta: ({ origin, machine, age }) => `${origin} · ${machine} · ${age}`,
    },
    rowMenu: {
        accessibility: 'Opzioni del flusso di lavoro',
        runNow: 'Esegui ora',
        share: 'Condividi…',
    },
    deleteTitle: 'Eliminare questo flusso di lavoro?',
    deleteFailedTitle: 'Impossibile eliminare il flusso di lavoro',
    exportFailedTitle: 'Impossibile esportare il flusso di lavoro',
    gate: {
        localTitle: 'Le automazioni sono disattivate su questo dispositivo',
        localBody: 'Attivale per eseguire i flussi di lavoro e i loro attivatori.',
        dependencyTitle: 'I flussi di lavoro richiedono le automazioni',
        dependencyBody: 'Attiva le automazioni per creare ed eseguire flussi di lavoro.',
        openSettings: 'Apri Impostazioni',
    },
    runSettingsPage: {
        title: 'Impostazioni di esecuzione',
        description: 'Quante esecuzioni accetta ogni macchina contemporaneamente e per quanto tempo viene conservata la cronologia.',
        saveFailed: 'Impossibile salvare le impostazioni di esecuzione. Le tue modifiche sono ancora qui.',
    },
};

const workflowsDestinationTranslations = { it } as const;

return { workflowsDestinationTranslations };
})();

const Domain_workflowTriggersTranslations = (() => {
type Count = Shared_workflowTriggersTranslations.Count;

type WorkflowTriggersCopy = Shared_workflowTriggersTranslations.WorkflowTriggersCopy;

const en = Shared_workflowTriggersTranslations.en;

const it: WorkflowTriggersCopy = {
    activity: {
        create: "Crea un trigger da questo evento",
        test: "Prova questo trigger",
        matched: "Questo evento corrisponde",
        noMatch: "Questo evento non corrisponde",
        sourceMismatch: "Questo evento proviene da un’altra fonte",
        tooOld: "Questo evento è troppo vecchio per l’osservazione",
        invalid: "Configura l’evento prima di provarlo",
    },
    pullRequest: {
        label: "Pull request",
        description: "Aggiungere questo trigger collega la pull request a questa sessione.",
        empty: "Nessuna pull request aperta",
        loadFailed: "Impossibile caricare le pull request",
    },
    summary: {
        everyDayAt: ({ time }) => `Ogni giorno alle ${time}`,
        weekdaysAt: ({ time }) => `Nei giorni feriali alle ${time}`,
        weeklyAt: ({ day, time }) => `Ogni ${day} alle ${time}`,
        everyMinutes: ({ count }) => (count === 1 ? 'Ogni minuto' : `Ogni ${count} minuti`),
        everyHours: ({ count }) => (count === 1 ? 'Ogni ora' : `Ogni ${count} ore`),
        cron: ({ expression }) => `Secondo un orario · ${expression}`,
        schedule: 'Secondo un orario',
        event: ({ event }) => `Quando si verifica ${event}`,
        manual: 'Manuale',
        more: ({ first, count }) => `${first} · altri ${count}`,
    },
    kind: {
        pluginEvent: "Evento del plugin",
        sessionStarts: 'Quando la sessione inizia',
        sessionArchived: 'Quando la sessione viene archiviata',
        schedule: 'Secondo un orario',
        prComment: 'Quando qualcuno commenta una pull request',
        ciFailed: 'Quando la CI fallisce su una pull request',
        turnEnds: 'Quando termina un turno',
        needsYou: 'Quando la sessione ha bisogno di te',
        runEnds: 'Quando termina l’esecuzione',
        runNeedsYou: 'Quando l’esecuzione ha bisogno di te',
    },
    row: {
        workflowDeleted: 'Workflow eliminato',
        legacyCreated: 'Creato in Happier 0.2',
        legacyUnavailable: 'Trigger precedente non disponibile',
        sessionKeyRequired: 'Chiave della sessione necessaria',
        templateRecoveryRequired: 'Recupera questo trigger in Sicurezza account',
        templateDecryptionFailed: 'Impossibile decifrare il trigger',
        machines: ({ count }: Count) => `${count} macchine`,
        nextRun: ({ time }: { time: string }) => `Prossima esecuzione: ${time}`,
        nextMinutes: ({ count }: Count) => `tra ${count} min`,
        nextHours: ({ count }: Count) => `tra ${count} h`,
        nextDays: ({ count }: Count) => count === 1 ? 'domani' : `tra ${count} giorni`,
        steps: ({ count }) => (count === 1 ? `${count} passaggio` : `${count} passaggi`),
        off: 'Disattivato',
        running: 'In esecuzione',
        ran: ({ age }) => `Eseguito ${age}`,
        lastOutcome: ({ state, age }) => `${state} ${age}`,
        turnOn: ({ name }) => `Attiva ${name}`,
        turnOff: ({ name }) => `Disattiva ${name}`,
    },
    section: {
        add: 'Aggiungi un trigger',
        emptyTitle: 'Nessun trigger',
        emptyBody: 'Aggiungine uno per rivedere ogni turno, continuare verso un obiettivo o reagire alla pull request.',
        loadFailed: 'Impossibile caricare i trigger di questa sessione.',
        accountLoadFailed: 'Impossibile caricare i tuoi trigger.',
        title: 'Trigger',
        countOn: ({ count }) => `${count} attivi`,
        info: 'Cosa viene eseguito in questa sessione quando succede qualcosa. Restano con questa sessione e non compaiono nella tua libreria.',
        saveFailed: 'Impossibile salvare questo trigger. Le tue modifiche sono ancora qui.',
    },    kindDescription: {
        pluginEvent: "Esegui quando un plugin osserva un evento.",
        turnEnds: 'Dopo un turno tuo o di un agente con cui lavori.',
        needsYou: 'Ogni volta che questa sessione ti aspetta, anche mentre la guida un workflow o Continua fino alla fine.',
        sessionArchived: 'Viene eseguito una volta, quando archivi questa sessione.',
        sessionStarts: 'Solo quando si crea una sessione.',
        schedule: 'Continua questa sessione secondo un orario.',
        prComment: 'Solo chi ha accesso in scrittura. Il commento viene passato come testo citato.',
        pullRequestUnavailable: 'I trigger delle pull request non si possono ancora aggiungere qui.',
    },
    then: {
        runsIn: 'Viene eseguito in',
        runsInChoice: {
            newSession: 'Una nuova sessione',
            session: 'Una sessione…',
            backgroundRun: 'Un’esecuzione in background',
        },
        noSessionOnMachine: 'Ancora nessuna sessione su questa macchina',
        session: 'Sessione',
        action: 'Azione',
        label: 'Poi',
        sendPrompt: 'Invia un prompt',
        doAction: "Esegui un'azione",
        notifyMe: 'Avvisami',
        runWorkflow: 'Esegui un workflow',
        sendPromptDescription: "L'agente di questa sessione riceve questo prompt in questa sessione. Non interrompe mai il tuo turno.",
        promptLabel: 'Prompt',
        promptPlaceholder: "Cosa deve fare l'agente?",
        message: 'Messaggio',
        title: 'Titolo',
        sendTo: 'Invia a',
        sendToDefault: 'Le tue impostazioni di notifica',
        workflow: 'Workflow',
        choose: 'Scegli…',
    },
    popover: {
        configureEvent: "Configura evento",
        editEvent: "Modifica evento",
        saveAsWorkflow: 'Salva come workflow',
        saveAsWorkflowDescription: 'Apre questi passaggi come nuovo workflow da rivedere. Questo trigger mantiene i propri passaggi.',
        when: 'Quando',
        newTrigger: 'Nuovo trigger',
        addTrigger: 'Aggiungi trigger',
        cancel: 'Annulla',
        done: 'Fine',
        turnOff: 'Disattiva',
        turnOn: 'Attiva',
        deleteTrigger: 'Elimina trigger',
        repeat: 'Ripeti',
        everyDay: 'Ogni giorno',
        weekdays: 'Giorni feriali',
        weekly: 'Ogni settimana',
        day: 'Giorno',
        at: 'Alle',
        expression: 'Orario',
        tryAgain: 'Riprova',
    },    editor: {
        runsOn: 'Viene eseguito su',
        runsOnDescription: 'Tutti i trigger di questo workflow vengono eseguiti qui.',
        runsOnAccountDescription: 'Dove viene eseguito questo trigger.',
        runsOnDiffers: ({ where }) => `Esegui ora usa invece ${where}.`,
        sameForAllTriggers: 'Uguale per tutti i trigger',
        roles: 'Ruoli',
        retargetFailed: 'Workflow salvato · Trigger non aggiornato',
        editInWorkflows: 'Modifica questo trigger in Workflow. Continua a funzionare così com’è.',
        title: 'Si esegue automaticamente',
        runsBy: 'Si esegue da solo quando succede una di queste cose.',
        runsByOn: ({ where }) => `Si esegue da solo quando succede una di queste cose, su ${where}.`,
        savedWorkflow: 'I trigger eseguono il workflow salvato.',
        saveToInclude: 'I trigger eseguono il workflow salvato. Salva per includere le modifiche.',
        newRow: 'Nuovo · non ancora aggiunto',
        partialSave: 'Workflow salvato · Trigger non aggiornati',
    },    column: {
        newTrigger: 'Nuovo trigger',
        newTriggerSubtitle: 'Esegue i propri passaggi secondo un orario',
    },
};

const legacyTranslations = { it: {
        editNotice: 'Creato in Happier 0.2. Aprirlo non cambia nulla.',
        conversionBoundary: 'Dopo questa modifica funziona solo su macchine con Happier 0.3 o successivo.',
        reviewRequired: 'Da rivedere',
        reviewConversionNotice: 'Il salvataggio memorizza il workflow senza crittografia end-to-end e riprende i suoi trigger abilitati. La sessione rimane crittografata end-to-end.',
        channelReplyRefusal: 'Questa automazione ha un collegamento di risposta a un canale che non può essere trasferito. Non è stata convertita; le impostazioni e le tue modifiche restano intatte.',
        notAvailable: 'Questa automazione non è più disponibile.',
    } };

const creationTranslations = { it: { savedWorkflowsUnavailable: 'Passa al server di questa sessione per scegliere un flusso salvato. I flussi integrati e i passaggi personalizzati restano disponibili.' } };

const workflowTriggersTranslations = { it: { ...it, legacy: legacyTranslations.it, creation: creationTranslations.it } } as const;

return { legacyTranslations, creationTranslations, workflowTriggersTranslations };
})();

const Domain_workflowValueReferenceTranslations = (() => {
const workflowValueReferenceTranslations = { it: {
        checkoutRoot: 'Cartella radice del checkout',
        unavailableValue: 'Valore non disponibile', sessionContext: ({ turns }: { turns: number }) => turns === 0 ? 'Contesto della sessione' : turns === 1 ? 'Ultimo turno della sessione' : `Ultimi ${turns} turni della sessione`,
        tokensUsed: 'Token utilizzati', goalTokenBudget: 'Budget di token dell’obiettivo',
        trailingCount: ({ source, value }: { source: string; value: string }) => `${source} consecutivi corrispondenti a ${value}`,
        stopCondition: 'Condizione di arresto soddisfatta', stopConditionArm: ({ arm }: { arm: number }) => `Condizione di arresto ${arm} soddisfatta`,
        roundLimit: ({ rounds }: { rounds: number }) => `Limite raggiunto · ${rounds} turni`, decision: 'Decisione',
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

const it = translated(workflowValueReferenceTranslations.it, {
    testRun: {
        title: "Esecuzione di prova",
        savedNotice: "Esegue davvero la versione salvata. Le modifiche non salvate restano qui.",
        resultsNotice: "Risultati della versione salvata · ultima esecuzione. Le modifiche non salvate non sono state eseguite.",
        recordedDuration: ({ seconds }) => `Tempo trascorso registrato · ${seconds} s`,
        loading: "Caricamento dei risultati della prova…",
    },
    runWhen: {
        title: "Esegui in caso di",
        success: "Successo",
        failure: "Errore",
        always: "Sempre",
        ifSuccess: "Se riesce",
        ifFailure: "Se fallisce",
        regardless: "In ogni caso",
        previousStep: "Rispetto al passaggio precedente",
    },
    title: 'Flussi di lavoro',
    newWorkflow: 'Nuovo flusso di lavoro',
    copyName: ({ name }: { name: string }) => `${name} copia`,
    importJson: 'Importa JSON',
    exportJson: 'Esporta JSON',
    openCollection: 'Apri i flussi di lavoro',
    destination: workflowsDestinationTranslations.it,
    plugins: workflowPluginTranslations.it,
    authoring: workflowAgentAuthoringTranslations.it,
    page: workflowEditorPageTranslations.it,
    actionTitles: workflowActionTranslations.it,
    builtins: workflowBuiltinTranslations.it,
    examples: workflowExamplesTranslations.it,
    triggers: workflowTriggersTranslations.it,
    start: workflowStartTranslations.it,
    list: workflowRunListTranslations.it,
    review: {
        publishedByAgent: 'Pubblicato dall’agente',
        publishedByYou: 'Pubblicato da te',
        editedByYou: 'Modificato da te',
        editedByPerson: 'Modificato da un’altra persona',
        previousAttempt: 'Tentativo precedente',
        useBody: "I passi successivi ricevono esattamente ciò che vedi. Nessun turno dell’agente.",
        usePlanBody: "Accetta esattamente questo piano. Nessun turno dell’agente.",
        reportBackTitle: ({ session }) => "Riporta a " + session,
        reportBackBody: ({ session }) => session + " riceve il risultato di questa esecuzione al termine.",
        planRunNotice: "Esegue il workflow proposto esattamente come mostrato e accetta il piano. Non lo salva.",
        editedPlanBody: 'Questa bozza è diversa dalla proposta. Accettare prima il piano esaminato per modificarlo? Le modifiche restano qui e nulla parte finché non esegui di nuovo la bozza.',
        title: "Risultato da verificare",
        planTitle: "Piano da verificare",
        waitTitle: "In attesa di te",
        waitBody: "Questo ramo attende finché non continui.",
        editsTitle: "Le tue modifiche non salvate",
        editsBody: "Il risultato salvato resta invariato finché non lo usi.",
        heldBody: "In attesa della tua verifica · non ancora passato ai passi successivi",
        noValue: "Ancora nessun risultato valido",
        enterValues: 'Compila i campi.',
        useResult: "Usa questo risultato",
        usePlan: "Usa questo piano",
        useValues: "Usa questi valori",
        continue: "Continua",
        invalid: "Correggi prima il campo evidenziato.",
        newer: "È disponibile un risultato più recente.",
        showNewer: "Mostra il nuovo",
        keepMyEdits: 'Mantieni le mie modifiche',
        useNewer: 'Usa il nuovo',
        showFullResult: 'Mostra il risultato completo',
        showFullPlan: 'Mostra il piano completo',
        generationRequested: "Generazione richiesta",
        startsResume: "Inizia quando riprendi l’esecuzione.",
        generateBody: "L’agente scrive un nuovo risultato in questa conversazione. Se è valido, l’esecuzione continua senza chiedere di nuovo.",
        acceptedPaused: "Usare questo risultato mantiene il workflow in pausa.",
        editResult: "Modifica risultato",
        generate: "Genera risultato e continua",
        discuss: "Discuti",
        discussBody: "Rispondi nella conversazione di questo passo. L’agente può pubblicare qui un risultato aggiornato.",
        proposal: "Workflow proposto",
        planStarted: "È iniziata un’esecuzione di questo piano",
        earlierPlanStarted: "È già stata avviata un’esecuzione da una proposta precedente",
        openEarlierPlanRun: "Apri quell’esecuzione",
        runNewProposal: "Esegui la nuova proposta",
        runPlan: "Eseguilo come workflow",
        runPlanBody: "Apre la verifica del workflow proposto. Avviarlo accetta anche questo piano.",
        editPlan: "Modifica prima il workflow",
        editPlanBody: "Accetta questo piano e apre il workflow proposto come bozza non salvata.",
        editPlanFallback: "Accetta questo piano e apre un workflow di un passo con questo piano come istruzione.",
        waitingMachine: ({ machine }) => "In attesa di " + machine,
    },

    tabs: {
        saved: 'Salvati',
        runs: 'Esecuzioni',
        steps: 'Passaggi',
        flow: 'Flusso',
        map: 'Mappa',
        activity: 'Attività',
    },
    tabsAccessibility: {
        savedRuns: 'Flussi di lavoro salvati o esecuzioni',
        stepsFlow: 'Passaggi o flusso',
        activityFlow: 'Attività o flusso',
        runViews: "Viste dell’esecuzione",
    },

    filters: {
        all: 'Tutto',
        active: 'Attivi',
        needsYou: 'Ha bisogno di te',
        clear: 'Rimuovi il filtro',
    },

    empty: {
        savedTitle: 'Ancora nessun flusso di lavoro salvato',
        savedBody: 'Salvando un flusso di lavoro conservi una definizione riutilizzabile che puoi eseguire o pianificare.',
        runsTitle: 'Non è ancora stato eseguito nulla',
        runsBody: 'Le esecuzioni compaiono qui, che tu salvi il flusso di lavoro o no.',
        filteredTitle: 'Nessuna esecuzione corrisponde a questo filtro',
        filteredBody: 'Rimuovi il filtro per vedere le altre esecuzioni.',
        missingTitle: 'Questo workflow non è disponibile',
        missingBody: 'Happier non è riuscito ad aprire il workflow a cui punta questo link. Gli altri workflow, le Automazioni e le esecuzioni non sono interessati.',
        missingDraftTitle: "Questa copia non salvata è andata persa",
        missingDraftBody: "Ricaricando si perdono le copie non salvate. Apri il workflow originale per duplicarlo di nuovo.",
    },

    loadFailedTitle: 'Impossibile caricare i flussi di lavoro',
    loadFailedBody: 'Il tuo lavoro non è stato toccato. Riprova quando vuoi.',
    retry: 'Riprova',
    contentUnavailable: 'I contenuti privati non sono disponibili su questo dispositivo.',
    readState: {
        historyTitle: 'Cronologia non leggibile',
        historyBody: 'Questa esecuzione è stata registrata con una precedente versione di sviluppo di Happier, quindi la cronologia non può essere aperta. Avvia una nuova esecuzione per continuare.',
        encryptionTitle: 'Configurazione della crittografia necessaria',
        encryptionBody: 'Questo contenuto è crittografato end-to-end. Configura la crittografia di questo account per aprirlo.',
        keysTitle: 'In attesa delle chiavi',
        keysBody: 'Questo dispositivo non ha ancora le chiavi di crittografia di questa esecuzione. Riprova quando saranno disponibili.',
        storageTitle: 'Archivio delle esecuzioni non disponibile',
        storageBody: 'Happier non ha potuto accedere all’archivio delle esecuzioni. Controlla la connessione e riprova.',
        openSettings: 'Apri le impostazioni',
    },
    contentReasons: {
        invalidHeader: 'Le informazioni salvate di questo flusso di lavoro non sono valide.',
        revisionMismatch: 'Questo flusso di lavoro non corrisponde alla revisione salvata.',
        missingBody: 'Manca la definizione salvata di questo flusso di lavoro.',
        invalidBody: 'La definizione salvata di questo flusso di lavoro non è valida.',
        notFound: 'Questo flusso di lavoro non è più disponibile.',
    },

    sessionEntry: {
        missingTitle: 'Questa sessione non è più disponibile',
        missingBody: 'Potrebbe essere stata eliminata o trovarsi su un altro Home. Apri Sessioni per ritrovarla.',
        inaccessibleTitle: 'Non puoi aprire questa sessione',
        inaccessibleBody: 'Happier non ha potuto confermare l’accesso. Accedi di nuovo o chiedi a chi la possiede, poi riapri questa pagina.',
        failedTitle: 'Non è stato possibile aprire questa sessione',
        failedBody: 'Happier continua a provare. Puoi riprovare subito.',
        unsupportedTitle: 'Questa sessione non può avviare un flusso di lavoro',
        unsupportedBody: 'Happier non ha potuto leggere l’agente e la macchina su cui gira. Crea il flusso di lavoro da Flussi di lavoro.',
    },

    editor: {
        namePlaceholder: 'Nome del flusso di lavoro',
        agentRuntime: 'Runtime dell’agente',
        firstPromptTitle: 'Che cosa deve succedere per primo?',
        firstPromptBody: 'Un solo prompt è già un flusso di lavoro. Aggiungi passaggi quando ti servono.',
        promptPlaceholder: 'Descrivi che cosa deve fare questo passaggio',
        useWorkflowDefault: 'Usa il valore del flusso di lavoro',
        defaultsTitle: 'Impostazioni predefinite',
        produces: 'Produce',
        whereTitle: 'Dove',
        add: 'Aggiungi',
        addAccessibility: 'Aggiungi un blocco a questo flusso di lavoro',
        addStep: 'Passaggio dell’agente',
        addParallel: 'Affiancati',
        addLoop: 'Ripeti',
        addIf: 'Se',
        targetRequired: 'Scegli il computer e la cartella del progetto per questo flusso di lavoro.',
        loadingTitle: 'Apertura del flusso di lavoro…',
        accountChangedTitle: 'Hai cambiato account',
        accountChangedBody: 'Questo flusso di lavoro è stato aperto dall’account precedente e non può essere trasferito. Riaprilo da Flussi di lavoro.',
        loadFailedTitle: 'Impossibile aprire questo flusso di lavoro',
        loadFailedBody: 'Per ora non è stato possibile leggere il flusso di lavoro salvato.',
        timeoutTitle: 'Attesa del risultato (ms)',
        noDeadline: 'Nessuna scadenza',
        timeoutExplain: 'Millisecondi di attesa del risultato di questo passaggio prima che richieda attenzione. Lascia vuoto per nessuna scadenza.',
        wholeNumberRequired: 'Inserisci un numero intero di almeno 1.',
        runNow: 'Esegui ora',
        save: 'Salva il flusso di lavoro',
        saveAutomation: 'Salva l’Automazione',
        schedule: 'Pianifica',
        savedRevision: ({ revision }) => `Salvato · ${revision}`,
        moveUp: 'Sposta su',
        moveDown: 'Sposta giù',
        moveIn: 'Sposta nel gruppo sopra',
        moveOut: 'Porta fuori da questo gruppo',
        remove: 'Rimuovi',
        undo: 'Annulla',
        redo: 'Ripristina',
        historyRestoreRequiresSetup: 'Questo evento deve essere configurato di nuovo. La configurazione privata salvata non può essere ripristinata dopo l’eliminazione.',
        history: { edited: 'Modifica workflow', agent: 'Modifica dell’agente', description: 'Modifica descrizione', where: 'Cambia luogo di esecuzione', target: 'Cambia esecuzione dei passi', triggers: 'Modifica trigger', example: 'Inserisci esempio', document: 'Modifica prompt', renameWorkflow: 'Rinomina workflow', renameStep: 'Rinomina passo', renameLane: 'Rinomina ramo' },
        undoAction: ({ change }: { change: string }) => `Annulla: ${change}`,
        redoAction: ({ change }: { change: string }) => `Ripristina: ${change}`,
        removedBlock: ({ block }) => `${block} rimosso`,
        rename: 'Rinomina',
        stepOrdinal: ({ position }) => `${position}`,
        unnamedStep: ({ position }) => `Passaggio ${position}`,
        unnamedParallel: 'Gruppo parallelo',
        unnamedLoop: 'Ciclo',
        unnamedIf: 'Condizione',
        branch: 'Ramo',
        addBranch: 'Aggiungi una corsia',
        ifTrue: 'Allora',
        otherwise: 'Altrimenti',
        addOtherwise: 'Aggiungi un ramo «altrimenti»',
        evaluator: 'Decidere se continuare',
        loopBody: 'Ripeti questi passaggi',
        continuation: 'Dopo ogni giro',
    },

    input: {
        label: 'Ingresso',
        result: 'Risultato',
        change: 'Cambia',
        none: 'Nessun ingresso',
        previousResult: ({ block }) => `Risultato di ${block}`,
        workflowInput: ({ name }) => `Ingresso del flusso di lavoro ${name}`,
        currentItem: 'L’elemento corrente',
        iteration: 'Questo giro',
        unavailable: 'Questa sorgente non è più disponibile',
        itemField: {
            value: 'Valore dell’elemento',
            index: 'Indice dell’elemento, da 0',
            position: 'Posizione dell’elemento, da 1',
            count: 'Numero di elementi',
        },
        iterationField: {
            index: 'Indice del giro, da 0',
            position: 'Numero del giro, da 1',
            count: 'Numero di giri',
            stopReason: 'Motivo dell’arresto',
        },
        valueKindGroup: 'Origine del valore',
        inputNameGroup: 'Input del flusso',
        producerGroup: 'Passaggio di origine',
        workspaceFieldGroup: 'Campo dell’area di lavoro',
        itemFieldGroup: 'Campo dell’elemento',
        iterationFieldGroup: 'Campo del giro',
    },

    inputs: {
        title: 'Ingressi del flusso di lavoro',
        addInput: 'Aggiungi un ingresso',
        namePlaceholder: 'Nome',
        descriptionPlaceholder: 'A che cosa serve?',
        required: 'Obbligatorio',
        optional: 'Facoltativo',
        defaultValue: 'Valore predefinito',
        typeString: 'Testo',
        typeNumber: 'Numero',
        typeBoolean: 'Sì o no',
        typeJson: 'Dati strutturati',
        runSheetTitle: 'Esegui questo flusso di lavoro',
        runSheetBody: 'Fornisci i valori dichiarati da questo flusso di lavoro, poi eseguilo.',
        missingRequired: 'Questo valore è obbligatorio.',
        wrongType: ({ type }) => `Questo valore deve essere di tipo ${type}.`,
    },

    finalOutput: {
        title: 'Risultato finale',
        none: 'Nessun risultato finale selezionato',
        change: 'Cambia',
        clear: 'Annulla la selezione',
        fieldPath: 'Percorso del campo',
        explain: 'Ciò che questo flusso di lavoro restituisce quando finisce.',
    },

    conversation: {
        title: 'Conversazione',
        sharedRun: 'La stessa conversazione',
        branchesShareAndTakeTurns: 'I rami condividono una conversazione e procedono a turno.',
        fresh: 'Conversazioni separate',
        fromStep: ({ block }) => `Continua ${block}`,
        existingSession: 'Una sessione esistente',
        existingSessionById: ({ sessionId }) => `Sessione ${sessionId}`,
        noExistingSessions: 'Nessuna sessione di questa macchina può essere continuata qui.',
        chooseExistingSession: 'Scegli una sessione da continuare',
        continuingKeepsAgentAndFolder: 'Continuare mantiene l’Agente e la cartella di quella conversazione. Un Agente o una cartella diversi richiedono una conversazione separata.',
        waitingForConversation: ({ block }) => `In attesa che ${block} finisca in questa conversazione.`,
        branchesUseSeparate: 'I rami di un gruppo parallelo usano conversazioni separate.',
    },

    workspace: {
        title: 'Area di lavoro',
        inherit: 'Area di lavoro del flusso',
        projectCheckout: 'Cartella del progetto',
        fromStep: ({ block }) => `Continua nell’area di lavoro di ${block}`,
        newWorktreeOriginal: 'Nuovo worktree dalla cartella originale',
        newWorktreeWorkflow: 'Nuovo worktree dall’area di lavoro del flusso',
        newWorktreeStep: ({ block }) => `Nuovo worktree da ${block}`,
        committedOnlyNote: 'Un nuovo worktree contiene lo stato committato della cartella di origine. Le modifiche in staging, non committate e non tracciate restano nell’origine.',
        reuseNote: 'Quando un’area di lavoro viene ripresa, vede i suoi file non committati esattamente come sono.',
        sharedParallelNote: 'I rami che condividono un’area di lavoro possono scriverci contemporaneamente.',
        unavailable: ({ block }) => `L’area di lavoro di ${block} non è disponibile.`,
        unavailableBody: 'Ripristinala per continuare questa esecuzione, oppure valuta una nuova esecuzione che potrebbe ripetere lavoro già completato.',
        unavailableRestoreBody: 'Ripristinalo per continuare questa esecuzione con il lavoro già completato intatto.',
        unavailableNewRunBody: 'Non può essere ripristinato. Una nuova esecuzione rivista riparte da capo e il lavoro già completato può ripetersi.',
        restore: 'Ripristina',
        inspect: 'Ispeziona',
    },

    condition: {
        onlyWhen: 'Esegui solo quando',
        always: 'Sempre',
        stopWhen: 'Ferma quando',
        ifWhen: 'Esegui il primo ramo quando',
        addCondition: 'Aggiungi una condizione',
        removeCondition: 'Rimuovi la condizione',
        allOf: 'Tutte queste',
        anyOf: 'Una qualsiasi di queste',
        not: 'Non',
        exists: 'ha un valore',
        operatorEq: 'è',
        operatorNeq: 'non è',
        operatorLt: 'è minore di',
        operatorLte: 'è al massimo',
        operatorGt: 'è maggiore di',
        operatorGte: 'è almeno',
        notFirstRound: 'non è il primo giro',
        trailingCountAtLeast: ({ source, value, count }) => `${source} è ${value} ${count} volte di fila`,
        loopRanOutOfRounds: ({ loop }) => `${loop} ha esaurito i giri`,
        loopEnded: ({ loop, outcome }) => `${loop} è terminato: ${outcome}`,
        loopStoppedBecause: ({ loop, condition }) => `${loop} si è fermato perché ${condition}`,
        valuePlaceholder: 'Valore',
        literalPlaceholder: 'Scrivi un valore',
        skippedReason: ({ block }) => `Saltato perché la condizione di ${block} era falsa.`,
    },

    loop: {
        modeTitle: 'Ripeti',
        modeCount: 'Un numero fisso di volte',
        modeItems: 'Una volta per ogni elemento',
        modeUntil: 'Finché un risultato non dice di fermarsi',
        modeEvaluate: 'Finché un Agente non dice di fermarsi',
        count: 'Numero di volte',
        items: 'Elenco',
        sequential: 'Elementi in sequenza',
        parallel: 'Elementi in parallelo',
        maxConcurrentItems: 'Numero massimo di elementi in parallelo',
        maxConcurrentBranches: 'Numero massimo di rami in parallelo',
        noWorkflowLimit: 'Nessun limite fissato dal flusso di lavoro',
        maxIterations: 'Numero massimo di giri',
        limitReached: 'Limite raggiunto',
        historyTitle: 'Valutazioni precedenti',
        historyNone: 'Nessuna',
        historyLatest: 'L’ultima',
        historyAll: 'Tutte',
        historyExplain: 'Questo seleziona le decisioni e i riscontri salvati, non le trascrizioni complete.',
        continuingConversation: 'Questo valutatore mantiene la conversazione precedente e vi aggiunge ogni nuovo giro.',
        emptyListCompletes: 'Un elenco vuoto finisce senza alcun giro.',
    },

    failurePolicy: {
        title: 'Se un passaggio fallisce',
        failStop: 'Ferma questo gruppo in caso di errore',
        failStopExplain: 'Questo gruppo smette di avviare lavoro e chiede ai rami attivi di fermarsi, compresi quelli indipendenti. I risultati e le modifiche già completati restano. Non è un rollback.',
        collectOutcomes: 'Completa il lavoro indipendente',
        collectOutcomesExplain: 'I rami senza errori completano tutta la loro catena e ogni esito viene raccolto. I passaggi successivi a un errore all’interno di un ramo non vengono eseguiti.',
    },

    runState: {
        pending: 'In attesa di iniziare',
        queued: 'In attesa di iniziare',
        claimed: 'In avvio',
        running: 'In esecuzione',
        waiting_for_review: 'In attesa della tua revisione',
        succeeded: 'Completato',
        failed: 'Non riuscito',
        cancel_requested: 'In arresto',
        cancelled: 'Fermato',
        pause_requested: 'Messa in pausa',
        paused: 'In pausa',
        interrupted: 'Interrotto',
        expired: 'Scaduto prima di iniziare',
        dispatch_failed: 'Avvio non riuscito',
        skipped: 'Saltato',
        missed: 'Perso',
        outcome_uncertain: 'Esito incerto',
        completed: 'Completato',
        completed_with_failures: 'Completato, con errori',
    },

    invocationState: {
        pending: 'In attesa',
        waiting_for_capacity: 'In attesa di capacità',
        admitting: 'Avvio',
        running: 'In esecuzione',
        waiting_for_approval: 'In attesa di approvazione',
        waiting_for_review: 'In attesa della tua revisione',
        needs_attention: 'Ha bisogno di te',
        completed: 'Completato',
        failed: 'Non riuscito',
        skipped: 'Saltato',
        cancel_requested: 'In arresto',
        cancelled: 'Fermato',
        outcome_uncertain: 'Esito incerto',
        superseded: 'Sostituito da un tentativo successivo',
    },

    run: {
        title: 'Esecuzione',
        frozenVersion: "Questa esecuzione usa la versione con cui è iniziata. Le modifiche valgono solo per le esecuzioni future.",
        selectOccurrence: 'Scegli un passaggio',
        openReview: 'Rivedi il risultato',
        open: 'Apri esecuzione',
        openExact: ({ title }) => `Apri l’esecuzione ${title}`,
        openExecution: 'Apri l’esecuzione in background',
        loadMore: 'Carica passaggi precedenti',
        origin: {
            direct: 'Avviata direttamente',
            automation: 'Pianificata',
            fromSession: 'Da una sessione',
        },
        needsYou: 'Ha bisogno di te',
        needsYouLoadedCount: 'caricati',
        review: 'Controlla',
        stop: 'Ferma',
        stopAgain: 'Ferma di nuovo',
        stopping: 'Arresto in corso…',
        stopRequested: ({ machine }) => `Arresto richiesto. In attesa della conferma di ${machine}.`,
        evidenceStale: 'Mostra gli ultimi dettagli noti. Happier non ha potuto confermare che siano aggiornati.',
        pauseAtBoundary: 'Metti in pausa al prossimo confine',
        pausePending: 'Completa il lavoro in corso, poi va in pausa.',
        paused: 'In pausa dopo l’ultimo confine completato.',
        resume: 'Riprendi',
        runAgain: 'Esegui di nuovo il flusso di lavoro',
        retryStep: 'Riprova il passaggio',
        attempt: ({ attempt }) => `Tentativo ${attempt}`,
        untitled: 'Esecuzione del workflow',
        openResult: 'Apri il risultato',
        inspectSteps: 'Esamina i passaggi',
        seeFailures: 'Vedi gli errori',
        saveAsWorkflow: 'Salva come flusso di lavoro',
        saveAsNewWorkflow: 'Salva come nuovo flusso di lavoro',
        showCurrentWork: 'Mostra il lavoro attuale',
        editWorkflow: 'Modifica flusso di lavoro',
        openWorkflow: 'Apri flusso di lavoro',
        deleteHistory: 'Elimina la cronologia delle esecuzioni',
        deleteHistoryConfirm: 'Ingressi e risultati vengono rimossi. Aree di lavoro, conversazioni, flussi di lavoro salvati e Automazioni restano.',
        technicalDetails: 'Dettagli tecnici',
        technical: {
            runId: 'ID esecuzione',
            invocationId: 'ID passaggio',
            machine: 'Computer',
            machineId: 'ID del computer',
            revision: 'Revisione',
        },
        usageUnavailable: 'Consumo non disponibile',
        startedAt: ({ time }: { time: string }) => `Avviato ${time}`,
        timeRange: ({ start, end }) => `${start} – ${end}`,
        openConversation: 'Apri conversazione',
        openChildRun: 'Apri la sua esecuzione',
        openStepDetails: 'Apri dettagli',
        outcomeLine: ({ word, sentence }: { word: string; sentence: string }) => `${word} — ${sentence}`,
        attentionReviewRow: ({ step }: { step: string }) => `${step} attende la tua revisione`,
        attentionWaitRow: ({ step }: { step: string }) => `${step} ti sta aspettando`,
        attentionReviewSentence: ({ step }: { step: string }) => `${step} attende la tua revisione.`,
        attentionWaitSentence: ({ step }: { step: string }) => `${step} ti sta aspettando.`,
        reviewing: 'In revisione',
        notStarted: 'Non avviato',
        machineUnavailable: ({ machine }) => `Questa esecuzione ha perso il contatto con ${machine}.`,
        machineUnavailableBody: 'Le opzioni per riprendere compariranno quando lo stato attuale sarà noto.',
        completedCount: ({ count }) => `${count} ${count === 1 ? 'passo completato' : 'passi completati'}.`,
        completedWithFailures: ({ completed, failed }) =>
            `Completato, con errori. ${completed} ${completed === 1 ? 'completato' : 'completati'}; ${failed} non ${failed === 1 ? 'è riuscito' : 'sono riusciti'} a finire.`,
        approvalWanted: ({ block }) => `${block} vuole eseguire un comando.`,
        approvalWantedBody: 'Controllalo per continuare.',
        capacityOccupied: 'Tutti i posti previsti dal flusso di lavoro sono occupati.',
        openSourceSession: 'Apri la sessione da cui proviene',
        observedActivity: 'Attività osservata',
        observedActivityBody: 'Happier vede le fasi e gli agenti di questo agente, ma non è stato avviato come flusso di lavoro gestito, quindi non può essere modificato, salvato o rieseguito.',
    },

    recovery: {
        title: 'Controlla il ripristino',
        reattach: 'Ricollega',
        reattachExplain: 'Osserva il lavoro già in corso. Non avvia nulla di nuovo.',
        resumeSameConversation: 'Riprendi',
        resumeSameConversationExplain: ({ block }) => `${block} può continuare nella stessa conversazione.`,
        freshAgent: 'Continua con un Agente nuovo',
        freshAgentExplain: 'Questa conversazione non può essere continuata. L’area di lavoro è disponibile per un Agente nuovo.',
        uncertainEffects: ({ block }) => `${block} si è fermato prima di riferire. Potrebbe aver già modificato l’area di lavoro.`,
        acknowledgeEffects: 'Ho capito che le modifiche precedenti potrebbero essere già avvenute',
        waitingForStop: 'In attesa dell’arresto o di una conferma',
        remainingNotStarted: ({ count }) => `${count} ${count === 1 ? 'passaggio correlato non è ancora iniziato' : 'passaggi correlati non sono ancora iniziati'}`,
        startReviewedRun: 'Avvia una nuova esecuzione controllata',
        editContinuation: 'Controlla o modifica la continuazione',
        continuationPlaceholder: 'Aggiungi cosa deve fare diversamente questo passaggio',
        useReplacementInput: 'Sostituisci l’input del passaggio',
        repeatedEffectWarning: 'Il lavoro già completato può ripetersi. L’esecuzione originale mantiene la sua cronologia.',
    },

    unavailable: {
        title: 'I workflow non sono disponibili',
        body: 'I workflow non sono disponibili su questo server, quindi qui non se ne può creare o eseguire uno.',
        conversion: 'Queste modifiche richiedono il formato workflow e i workflow non sono disponibili su questo server. Mantieni questa automazione su un solo prompt oppure riprova quando i workflow saranno disponibili.',
        savedAutomation: 'Questa automazione viene eseguita come workflow. I passaggi salvati restano invariati; puoi comunque modificarne nome, descrizione e trigger.',
    },
    conversion: {
        title: 'Queste modifiche richiedono il formato workflow',
        automationTarget: 'Workflow',
        body: 'Questa automazione esegue ancora un solo prompt sulla destinazione salvata. Convertendola mantieni le tue modifiche e le prossime esecuzioni funzioneranno come workflow su una macchina precisa. Le esecuzioni già avvenute restano invariate.',
        action: 'Converti in workflow',
        machineRequired: 'Scegli la macchina e la cartella del progetto per le prossime esecuzioni.',
    },
    save: {
        conflictTitle: 'È stata salvata una versione più recente',
        conflictBody: 'Le tue modifiche sono ancora qui.',
        compare: 'Confronta',
        saveAsCopy: 'Salva come copia',
        failedTitle: 'Impossibile salvare',
        failedBody: 'Il tuo lavoro locale è ancora qui.',
        deleteTitle: 'Eliminare questo flusso di lavoro?',
        deleteBody: 'Le Automazioni e le esecuzioni esistenti non vengono toccate e continuano a funzionare.',
        unsupportedAttachment: 'Allega i media tramite un riferimento durevole prima di salvare questo flusso di lavoro.',
        nameRequired: 'Dai un nome a questo flusso di lavoro prima di salvarlo.',
        runsCurrentDraft: 'Questa esecuzione usa il flusso di lavoro così com’è sullo schermo. Non lo salva.',
    },

    interchange: {
        importTitle: 'Importa un flusso di lavoro',
        importBody: 'L’importazione apre una bozza non salvata da controllare. Non esegue né pianifica nulla.',
        importIssuesTitle: 'Controlla questo flusso di lavoro',
        importIssuesBody: 'Alcune impostazioni richiedono la tua attenzione prima di poter usare questo flusso di lavoro.',
        openRepairDraft: 'Apri la bozza da correggere',
        importFailedTitle: 'Impossibile leggere quel file',
        importFailedInvalidJson: 'Quel file non è JSON valido.',
        importFailedUnsupportedVersion: 'Quel file usa una versione di flusso di lavoro che questa app non supporta.',
        importFailedInvalidDocument: 'Quel file non è un flusso di lavoro di Happier.',
        exportPrivacyNote: 'Il file esportato contiene prompt e impostazioni. Non contiene mai credenziali né risultati delle esecuzioni.',
    },

    issue: {
        invalid_version: 'Questo flusso di lavoro usa una versione non supportata.',
        unknown_field: 'Questo blocco ha un’impostazione che questo flusso di lavoro non supporta.',
        invalid_id: 'Questo blocco ha bisogno di un identificatore valido.',
        duplicate_id: 'Due blocchi hanno lo stesso identificatore.',
        missing_reference: 'Questo ingresso punta a un blocco che non esiste più.',
        invalid_reference_scope: 'Questo ingresso punta a un blocco che non finisce prima.',
        invalid_input: 'Questo valore non è valido.',
        missing_required_input: 'Manca un valore obbligatorio.',
        invalid_result_contract: 'Le impostazioni del risultato di questo passaggio non sono valide.',
        invalid_condition: 'Questa condizione non può essere confrontata.',
        invalid_repetition: 'Questo ciclo non può ripetersi con questa configurazione.',
        invalid_max_concurrent: 'La concorrenza massima richiede un numero intero di almeno 1 e vale solo per il lavoro in parallelo.',
        unsupported_persisted_attachment: 'I media allegati devono avere un riferimento durevole prima del salvataggio.',
        conversation_workspace_mismatch: 'Questa conversazione e questo spazio di lavoro non possono continuare insieme.',
        target_unavailable: 'Scegli un Agente per questo flusso di lavoro prima di eseguirlo.',
        emptyPrompt: 'Scrivi cosa deve fare questo passaggio.',
        emptyWaitPrompt: 'Scrivi cosa devi verificare o decidere qui.',
        fieldMissing: ({ field }) => `${field} è obbligatorio.`,
        fieldInvalid: ({ field }) => `${field} richiede un valore valido.`,
    },

    problem: {
        title: 'Non ha funzionato',
        waitingTitle: 'Non ancora possibile',
        subtreeDenied: 'Un agente può avviare lavoro solo nella propria sessione o nelle sessioni che coordina.',
        roleTargetUnavailable: 'Questo ruolo non può essere usato qui.',
        roleRunsAsMismatch: 'La modalità di esecuzione di questo ruolo non è compatibile con questo passaggio. Scegli un altro ruolo o cambia come viene eseguito il passaggio.',
        policyDeniedField: 'Le impostazioni del tuo agente non consentono l’impostazione richiesta per il lavoro avviato da un agente.',
        permissionExceedsCeiling: 'Servono più autorizzazioni di quelle possedute dall’agente che lo ha avviato.',
        workDepthExceeded: 'Questo supererebbe il tuo limite di delega. Fallo in questa sessione oppure aumenta il limite in Impostazioni › Delega.',
        definitionExceedsAuthority: 'L’agente non può salvare un flusso di lavoro che potrebbe fare più di quanto l’agente stesso può avviare.',
        sourceUnavailable: 'Questo flusso di lavoro non è disponibile, quindi i suoi trigger non possono essere eseguiti.',
        legacyConversionUnsupported: 'Questa automazione non può ancora essere modificata qui. Continua a funzionare così com’è.',
        nativeGoalOwner: 'L’agente continua già a lavorare autonomamente verso gli obiettivi in questa sessione.',
        sessionAlreadyStarted: 'Questa sessione è già iniziata. I trigger di avvio sessione possono essere aggiunti solo durante la creazione della sessione.',
        generic: 'Happier non è riuscito a completare quella richiesta del flusso di lavoro. Il tuo lavoro non è stato toccato.',
        needsRepair: 'Questo flusso di lavoro ha impostazioni da sistemare prima di poter essere eseguito.',
        targetUnavailable: 'La macchina o l’agente che serve a questo flusso di lavoro non è disponibile in questo momento.',
        notFound: 'Questa esecuzione non esiste più.',
        accessDenied: 'Non hai accesso a questa esecuzione.',
        conflict: 'Questo è cambiato altrove. Aggiorna per vedere la versione attuale; il tuo lavoro locale resta.',
        inputTooLarge: 'Quell’input è troppo grande da inviare. Non è stato cambiato nulla.',
        unresolvedOutcome: 'Happier non può ancora confermare che il lavoro precedente si sia fermato, quindi non può essere sostituito.',
        interactionCapacity: 'Questa conversazione ha troppe cose in attesa per accettarne altre adesso.',
        conversationUnavailable: 'Quella conversazione non può essere continuata.',
        workspaceRestore: 'Non è stato possibile ripristinare lo spazio di lavoro. Non è stato cambiato nulla.',
        waitSelfDependency: 'Così il flusso di lavoro resterebbe in attesa della conversazione che lo ha avviato.',
        updateRequired: 'La macchina che lo esegue ha bisogno di un Happier più recente per accettare questo passaggio.',
        ineligible: 'Questa esecuzione è andata avanti, quindi non è più possibile.',
        custodyPending: 'Happier sta ancora aspettando la conferma della macchina.',
        runFinished: 'Questa esecuzione è terminata.',
        checkpointUnavailable: 'Non c’è nessun punto salvato da cui riprendere.',
        recoveryEvidenceRequired: 'Apri questa esecuzione per vedere le sue opzioni di recupero.',
        executionNotStarted: 'Nessun passaggio è ancora partito.',
        custodySettled: 'Questa esecuzione è già chiusa.',
        unavailableHere: 'Non è disponibile in questo momento.',
    },

    a11y: {
        blockList: 'Blocchi del flusso di lavoro',
        stepContext: ({ block, position, total }) => `${block}, passaggio ${position} di ${total}`,
        groupContext: ({ group, block }) => `${block}, dentro ${group}`,
        inherited: 'usa l’impostazione del flusso di lavoro',
        overridden: 'impostato per questo passaggio',
        inserted: ({ block, position, total }) =>
            `${block} aggiunto in posizione ${position} di ${total}`,
        removed: ({ block, total }) =>
            `${block} rimosso. ${total === 1 ? 'Resta 1 blocco' : `Restano ${total} blocchi`}`,
        reordered: ({ block, position, total }) =>
            `${block} spostato in posizione ${position} di ${total}`,
        validation: ({ reason }) => reason,
        validationInBlock: ({ block, reason }) => `${block}: ${reason}`,
        needsYou: ({ count }) =>
            `${count} ${count === 1 ? 'passaggio ha' : 'passaggi hanno'} bisogno di te`,
        needsYouLoaded: 'caricati',
        terminal: ({ state }) => state,
        terminalWithAttention: ({ state, count }) =>
            `${state}. ${count} ${count === 1 ? 'passaggio ha' : 'passaggi hanno'} bisogno di te`,
        selectedRowUpdated: ({ block }) => `${block} aggiornato`,
        progress: ({ count }) =>
            `${count} ${count === 1 ? 'passaggio aggiornato' : 'passaggi aggiornati'}`,
        progressLoaded: ({ count }) =>
            `${count} ${count === 1 ? 'passaggio aggiornato' : 'passaggi aggiornati'} finora`,
        progressWithAttention: ({ count, attention }) =>
            `${count} ${count === 1 ? 'passaggio aggiornato' : 'passaggi aggiornati'}; ${attention} ${attention === 1 ? 'ha' : 'hanno'} bisogno di te`,
        flowNode: ({ node, state }) => `${node}, ${state}`,
        editStep: 'Modifica il passaggio',
        editBlock: 'Modifica il blocco',
        commandRefused: ({ reason }) => `Non ancora possibile. ${reason}`,
    },
});

const workflowTranslations = { it } as const;

return { workflowTranslations };
})();

const Domain_workspaceBarTranslations = (() => {
type WorkspaceBarTranslation = Shared_workspaceBarTranslations.WorkspaceBarTranslation;

const en = Shared_workspaceBarTranslations.en;

const workspaceBarTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', WorkspaceBarTranslation>>, "it"> = { it: { workspaceBar: { tabsLabel: 'Schede aperte', tabMenuLabel: 'Opzioni della scheda', pinTab: 'Fissa scheda', unpinTab: 'Sblocca scheda', splitRight: 'Dividi a destra', splitDown: 'Dividi in basso', maximizePane: 'Massimizza riquadro', restorePane: 'Ripristina riquadro', closeTab: 'Chiudi scheda', closeOtherTabs: 'Chiudi le altre schede', closeTabsToRight: 'Chiudi le schede a destra', moreTabs: ({ count }) => (count === 1 ? '1 altra scheda' : `Altre ${count} schede`), searchTabs: 'Cerca schede', splitPane: 'Dividi il riquadro attivo', openInNewTab: 'Apri in una nuova scheda', openToRight: 'Apri a destra', openBelow: 'Apri sotto', newTab: 'Nuova scheda' } } };

return { workspaceBarTranslations };
})();

const Domain_workspaceSyncDiagnosticTranslations = (() => {
type WorkspaceSyncDiagnosticTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncDiagnosticTranslation;

type WorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslation;

type WorkspaceSyncLocale = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncLocale;

type WorkspaceSyncTranslationCore = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslationCore;

type WorkspaceSyncReviewBase = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncReviewBase;

const completeWorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.completeWorkspaceSyncTranslation;

const workspaceSyncDiagnosticTranslations = { it: {
        diagnostics: { title: 'Diagnostica', relationshipId: 'ID relazione', controllerMachineId: 'ID computer di controllo', alphaMachineId: 'ID computer di origine', betaMachineId: 'ID computer di destinazione', alphaRoot: 'Cartella sorgente attuale', betaRoot: 'Cartella di destinazione attuale', engineMode: 'Modalità motore', engineState: 'Stato motore', errorCode: 'Codice errore' },
        error: { updateRequired: 'Aggiorna Happier sul computer di origine prima di riprovare questo passaggio dell’area di lavoro. Le altre azioni per sessioni e computer restano disponibili.' },
        resolve: { title: 'Risolvere il conflitto dell’area di lavoro?', body: ({ path, side }) => `Mantenere la versione “${side}” della cartella ${path}? L’altra cartella e tutto ciò che esiste solo al suo interno verranno rimossi dopo averne verificato lo stato attuale.`, unverifiedFile: 'Una versione senza un’impronta attuale del file non può essere rimossa in sicurezza. Aggiorna il conflitto e riprova.' },
    } } as const satisfies Pick<Record<string, WorkspaceSyncDiagnosticTranslation>, "it">;

const workspaceSyncSetAttentionTranslations = { it: { attention: { conflictedLinks: ({ count }) => `${count} ${count === 1 ? 'collegamento presenta' : 'collegamenti presentano'} conflitti`, unavailableLinks: ({ count }) => `Controlla lo stato di ${count} ${count === 1 ? 'collegamento' : 'collegamenti'}` } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'attention'>>, "it">;

const workspaceSyncAddMachineTranslations = { it: { availableOn: 'Disponibile su', addMachine: { replica: 'Replica', exactReplica: 'Replica esatta', editableCopy: 'Copia modificabile', editableCopyHint: 'Le modifiche sui computer collegati possono essere visibili agli agenti sugli altri computer. Le versioni in conflitto richiedono una verifica. Usa worktree separati quando vuoi lavorare in isolamento.' } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'availableOn' | 'addMachine'>>, "it">;

const workspaceSyncReviewOutcomeTranslations = { it: { keepBoth: 'Conserva entrambe le versioni', preserveAt: ({ path }) => `Conserva un’altra versione in ${path}`, notReviewed: 'Non verificato; qui non verrà modificato nulla', confirmScope: 'Saranno modificati solo gli spazi di lavoro verificati elencati. Quelli non disponibili resteranno invariati.', preserved: 'Conservato', alreadyPresent: 'Già presente', notStarted: 'Non avviato', askAgent: 'Chiedi a un agente', askAgentPrompt: ({ path, versions }) => `Aiutami a esaminare le versioni in conflitto di ${path} in questi spazi di lavoro collegati:\n${versions}\nControlla i file attuali e suggerisci una soluzione sicura. Non modificare o risolvere il conflitto senza la mia approvazione.` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'keepBoth' | 'preserveAt' | 'notReviewed' | 'confirmScope' | 'preserved' | 'alreadyPresent' | 'notStarted' | 'askAgent' | 'askAgentPrompt'>>, "it">;

const workspaceSyncCoverageIncompleteTranslations = { it: 'Alcuni collegamenti o punti non sono stati verificati. I conflitti caricati restano visibili; solo le versioni disponibili e verificate esplicitamente possono essere risolte.' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['coverageIncomplete']>, "it">;

const workspaceSyncReviewLifecycleTranslations = { it: { requestingApproval: 'Richiesta di approvazione…', applying: 'Applicazione delle modifiche verificate…', propagationExpected: ({ names }) => `Propagazione prevista a ${names}`, propagationUnverified: ({ names }) => `La propagazione a ${names} non può ancora essere verificata` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'requestingApproval' | 'applying' | 'propagationExpected' | 'propagationUnverified'>>, "it">;

const workspaceSyncLocalOnlyTranslations = { it: 'Questa posizione alternativa resta locale al suo spazio di lavoro' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['localOnly']>, "it">;

const workspaceSyncKeepAlternativesTranslations = { it: 'Conserva le alternative' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['keepAlternatives']>, "it">;

const workspaceSyncReviewDecisionTranslations = { it: { chooseTargets: 'Scegli gli spazi di lavoro da sostituire', notSelected: 'Non selezionato per questa risoluzione', inspectCurrentVersions: 'Esamina le versioni attuali' } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'chooseTargets' | 'notSelected' | 'inspectCurrentVersions'>>, "it">;

const workspaceSyncReviewTranslations: Pick<Record<WorkspaceSyncLocale, WorkspaceSyncReviewBase>, "it"> = { it: {
        executable: 'Eseguibile', regular: 'Non eseguibile', applied: 'Applicato', appliedPaused: 'Applicato; sincronizzazione in pausa', changed: 'Modificato prima dell’applicazione', offline: 'Offline; non applicato', cancelled: 'Annullato', unknown: 'Esito sconosciuto; controlla questo punto', failed: 'Non riuscito; non applicato', recoveryNeeded: 'Recupero necessario in questa posizione', inspectionUnavailable: 'Impossibile controllare le versioni attuali. Aggiorna quando il computer di controllo è disponibile.', coverageIncomplete: 'Alcuni collegamenti o punti non sono stati controllati. I conflitti caricati restano visibili, ma non possono ancora essere risolti.', versions: 'Versioni', comparison: 'Confronta le versioni selezionate', linkDecisions: 'Selezione per collegamento', result: 'Risultato', confirmTitle: 'Usare questa versione?', confirmBody: ({ path, source, count }) => `Usare la versione di ${source} di ${path} su altri ${count} spazi di lavoro? Happier verificherà tutte le versioni prima di modificarle.`, useVersion: 'Usa versione', useNamedVersion: ({ name }) => `Usa ${name}`, compareNamedVersion: ({ name }) => `Confronta ${name}`, linkCount: ({ count }) => `${count} collegamenti segnalano questo percorso`, moreOnLink: ({ name }) => `Carica altri da ${name}`,
    } };

const workspaceSyncReviewSelectionTranslations = { it: { selectionIncluded: 'Incluso da questo collegamento', selectionExcluded: 'Escluso da questo collegamento', selectionUnknown: 'Selezione sconosciuta', reasonRepositoryMetadata: 'Metadati del repository', reasonSubmodule: 'Sottomodulo Git', reasonConfiguredRule: 'Regola configurata', reasonGitIgnore: 'Regola Git ignore', reasonEndpointUnavailable: 'Punto non disponibile', reasonSelectionUnavailable: 'Valutazione selezione non disponibile', configuredInclude: ({ pattern }) => `Schema di inclusione: ${pattern}`, configuredExclude: ({ pattern }) => `Schema di esclusione: ${pattern}`, completedLinks: ({ count }) => `${count} collegamenti completati prima del blocco` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'selectionIncluded' | 'selectionExcluded' | 'selectionUnknown' | 'reasonRepositoryMetadata' | 'reasonSubmodule' | 'reasonConfiguredRule' | 'reasonGitIgnore' | 'reasonEndpointUnavailable' | 'reasonSelectionUnavailable' | 'configuredInclude' | 'configuredExclude' | 'completedLinks'>>, "it">;

const it = completeWorkspaceSyncTranslation({
    diagnostic: workspaceSyncDiagnosticTranslations["it"],
    review: workspaceSyncReviewTranslations["it"],
    selection: workspaceSyncReviewSelectionTranslations["it"],
    outcome: workspaceSyncReviewOutcomeTranslations["it"],
    lifecycle: workspaceSyncReviewLifecycleTranslations["it"],
    decision: workspaceSyncReviewDecisionTranslations["it"],
    coverage: workspaceSyncCoverageIncompleteTranslations["it"],
    localOnly: workspaceSyncLocalOnlyTranslations["it"],
    alternatives: workspaceSyncKeepAlternativesTranslations["it"],
    addMachine: workspaceSyncAddMachineTranslations["it"],
    attention: workspaceSyncSetAttentionTranslations["it"],
}, {
    title: 'Sincronizzazione dell’area di lavoro',
    footer: 'Lo stato proviene dal computer che gestisce questa relazione. Le modifiche vengono mostrate solo dopo la conferma di quel computer.',
    legacyRecovery: {
        title: 'Dati della sincronizzazione ritirata',
        footer: 'Happier si limita a ispezionare e mettere in quarantena questi dati ritirati. Non li elimina mai dall’app.',
        checking: 'Controllo dei computer…',
        inspectFailed: 'Non è stato possibile controllare alcuni computer. Le cartelle di quarantena già trovate restano visibili; riprova quando i computer sono raggiungibili.',
        outdatedTitle: ({ machine }) => `${machine} usa una versione precedente di Happier`,
        outdatedBody: 'Questa versione non può cercare i dati della sincronizzazione ritirata. Aggiorna Happier su quel computer e ripeti il controllo qui.',
        explanation: 'Questo computer contiene dati del motore di replica ritirato. Happier ha spostato i dati riconosciuti in una quarantena privata e disattivato la sincronizzazione per impedire l’avvio del vecchio motore.',
        quarantinePath: 'Cartella di quarantena',
        openFolder: 'Apri cartella',
        offlineTitle: 'Rimuovi mentre Happier è offline',
        offlineSteps: ({ path }) => `1. Arresta tutti i servizi in background di Happier che possono usare questi dati.\n2. Rimuovi esattamente questa cartella con il sistema operativo: ${path}\n3. Riavvia i servizi e ripeti il controllo qui.`,
        unknown: ({ path, reason }) => `Happier non ha potuto classificare in sicurezza lo stato precedente in ${path} (${reason}). La sincronizzazione resta disattivata. Controlla manualmente il percorso; non eliminarlo dall’app.`,
        reinspect: 'Controlla di nuovo',
    },
    none: 'Nessuna relazione di sincronizzazione',
    conflictsTitle: 'Conflitti dell’area di lavoro',
    openConflicts: ({ count }) => `Controlla la sincronizzazione su ${count} collegamenti`,
    noConflicts: 'Nessun conflitto',
    previewUnavailable: 'Il computer di controllo non ha fornito un’anteprima sicura. Aggiorna il conflitto prima di riprovare.',
    truncated: ({ count }) => `${count} ${count === 1 ? 'conflitto aggiuntivo non mostrato' : 'conflitti aggiuntivi non mostrati'}`,
    unknownMode: 'Modalità di sincronizzazione non supportata',
    conflictCount: ({ count }) => `${count} ${count === 1 ? 'conflitto' : 'conflitti'}`,
    conflictKind: { file: 'File', directory: 'Cartella', symlink: 'Collegamento simbolico', missing: 'Mancante', unsupported: 'Elemento non supportato' },
    mode: { copyOnce: 'Copia una volta', keepSynced: 'Mantieni aggiornato — consigliato', mirrorExactly: 'Rispecchia esattamente', keepBothInSync: 'Mantieni entrambi sincronizzati' },
    state: { loading: 'Controllo dello stato…', starting: 'Preparazione', watching: 'Monitoraggio', flushing: 'Sincronizzazione', paused: 'In pausa', peerOffline: 'Offline', conflicted: 'Conflitti', controllerUnavailable: 'Richiede attenzione', engineUnavailable: 'Componente non disponibile', error: 'Richiede attenzione', stopped: 'Arrestato', working: 'Operazione in corso…' },
    lastChecked: ({ at }) => `Ultimo controllo: ${at}`,
    endpoint: { source: ({ label }) => `Origine · ${label}`, destination: ({ label }) => `Destinazione · ${label}`, synced: ({ label }) => `Estremità sincronizzata · ${label}` },
    error: {
        componentUnavailable: 'La sincronizzazione dell’area di lavoro non è disponibile in questa build. Installa il componente richiesto e riprova.',
        machineOffline: 'Il computer di destinazione non è disponibile. Ricollegalo e riprova.',
        destinationNeedsPreparation: 'La cartella di destinazione deve essere preparata prima di avviare la sincronizzazione.',
        gitPreparationFailed: 'Happier non ha potuto preparare questa area di lavoro Git. Controlla la destinazione e riprova.',
        authorizationExpired: 'L’autorizzazione dell’area di lavoro è scaduta. Avvia di nuovo l’operazione.',
        rootNoLongerAuthorized: 'La cartella dell’area di lavoro è cambiata e non è più autorizzata. Controlla la relazione prima di riprovare.',
        conflictNeedsAttention: 'Questo conflitto è cambiato. Aggiornalo prima di scegliere una versione.',
        needsAttention: 'La sincronizzazione dell’area di lavoro richiede attenzione. Aggiorna lo stato e riprova.',
    },
    start: { blocked: {
        targetMachine: 'Scegli un computer di destinazione per continuare.',
        targetMachineOffline: 'Quel computer non è disponibile in questo momento. Ricollegalo e riprova.',
        relationshipUnavailable: 'Questa relazione di sincronizzazione non include più queste due cartelle. Scegli un’altra opzione per l’area di lavoro.',
        sourceFolder: 'La cartella di questa sessione non può essere sincronizzata in sicurezza. Scegli “Non spostare i file” per trasferire solo la sessione.',
        destinationFolder: 'Scegli una cartella di destinazione valida.',
        workspaceOptions: 'Controlla le opzioni dell’area di lavoro prima di iniziare.',
    } },
    engine: { checking: 'Controllo della sincronizzazione su questo computer…' },
    actions: { refresh: 'Aggiorna stato', syncNow: 'Sincronizza ora', more: 'Azioni di sincronizzazione', pause: 'Metti in pausa', resume: 'Riprendi', terminate: 'Interrompi sincronizzazione', openOnMachine: ({ machine }) => `Apri su ${machine}`, openFolder: ({ label }) => `Apri la cartella ${label}`, keepLocal: 'Mantieni la versione locale', keepRemote: 'Mantieni la versione remota', keepNamed: ({ side }) => `Mantieni la versione di ${side}` },
    terminate: { title: 'Rimuovere la sincronizzazione dell’area di lavoro?', body: 'La sincronizzazione verrà interrotta e la relazione rimossa. I file resteranno in entrambe le aree di lavoro.' },
    resolve: {
        changedTitle: 'Il conflitto è cambiato',
        changedBody: 'Questo conflitto è cambiato da quando è stato aperto. L’elenco è stato aggiornato. Controlla le versioni più recenti prima di scegliere di nuovo.',
        consequence: 'L’altra versione verrà rimossa solo dopo che Happier avrà verificato che il file non è cambiato.',
        unsupported: 'Questo conflitto contiene un elemento del file system non supportato e non può essere risolto in Happier. Rimuovilo o sostituiscilo sul computer interessato, quindi aggiorna.',
        keepHint: ({ side }) => `Mantieni la versione di ${side} e rimuovi l’altra versione verificata.`,
    },
    fileState: { text: 'Anteprima del testo', binary: 'File binario — anteprima non disponibile', tooLarge: 'Il file è troppo grande per l’anteprima', missing: 'File mancante', changed: 'Il file è cambiato da quando è stato elencato questo conflitto' },
});

const workspaceSyncTranslations = { it } as const satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation>, "it">;

return { workspaceSyncDiagnosticTranslations, workspaceSyncSetAttentionTranslations, workspaceSyncAddMachineTranslations, workspaceSyncReviewOutcomeTranslations, workspaceSyncCoverageIncompleteTranslations, workspaceSyncReviewLifecycleTranslations, workspaceSyncLocalOnlyTranslations, workspaceSyncKeepAlternativesTranslations, workspaceSyncReviewDecisionTranslations, workspaceSyncReviewTranslations, workspaceSyncReviewSelectionTranslations, workspaceSyncTranslations };
})();

const Domain_workspaceTabTranslations = (() => {
const en = Shared_workspaceTabTranslations.en;

const workspaceTabKeyboardTranslations = Shared_workspaceTabTranslations.workspaceTabKeyboardTranslations;

const workspaceTabTranslations = { it: en };

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
