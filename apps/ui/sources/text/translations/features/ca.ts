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

const accountDisplayTranslations = { ca: { unnamed: 'Compte sense nom', yours: 'El teu compte', shortId: ({ id }) => `ID …${id}` } } as const satisfies Pick<Record<string, AccountDisplayTranslation>, "ca">;

return { accountDisplayTranslations };
})();

const Domain_accountEncryptionRecoveryTranslations = (() => {
type Copy = Shared_accountEncryptionRecoveryTranslations.Copy;

const en = Shared_accountEncryptionRecoveryTranslations.en;

const ca: Copy = {
    recoverAutomationTemplates: 'Recupera els activadors anteriors',
    recoverAutomationTemplatesDescription: 'Fes servir les claus d’aquest dispositiu per recuperar activadors anteriors. Es conserven mentre les sessions xifrades o els activadors bloquejats les necessitin.',
    recoverAutomationTemplatesAction: 'Recupera',
    recoverAutomationTemplatesComplete: 'Activadors recuperats. La clau antiga es queda en aquest dispositiu fins que decideixis oblidar-la.',
    recoverAutomationTemplatesRetained: 'Recuperació comprovada. Alguns activadors continuen xifrats, bloquejats o modificats. La clau antiga es queda en aquest dispositiu.',
    forgetEncryptionKey: 'Oblida la clau de xifratge antiga',
    forgetEncryptionKeyDescription: 'Les sessions xifrades antigues queden bloquejades en aquest dispositiu.',
    forgetEncryptionKeyAction: 'Oblida',
    forgetEncryptionKeyConfirm: 'Vols oblidar la clau de xifratge antiga?',
    forgetEncryptionKeyWarning: ({ items }) => `Les sessions xifrades antigues queden bloquejades en aquest dispositiu. Aquest historial xifrat pot quedar inaccessible:\n\n${items}\n\nLa llista mostra l’historial actual. Les sessions xifrades creades després en un altre dispositiu també queden bloquejades. Restaura la clau antiga per desbloquejar-les. No s’elimina res del compte.`,
    forgetEncryptionKeySession: ({ name, id }) => `Sessió: ${name} (${id})`,
    forgetEncryptionKeyTrigger: ({ id }) => `Activador: ${id}`,
    forgetEncryptionKeyRun: ({ id }) => `Historial d’execució: ${id}`,
    forgetEncryptionKeyEmpty: 'No s’ha trobat historial xifrat.',
    forgetEncryptionKeyComplete: 'La clau antiga s’ha oblidat en aquest dispositiu.',
    forgetEncryptionKeyFailed: 'No s’ha pogut oblidar la clau. Torna a connectar i prova-ho de nou; primer cal llistar l’historial xifrat.',
};

const accountEncryptionRecoveryTranslations = { ca } as const;

return { accountEncryptionRecoveryTranslations };
})();

const Domain_accountPopoverTranslations = (() => {
type AccountPopoverTranslation = Shared_accountPopoverTranslations.AccountPopoverTranslation;

const accountPopoverTranslations = { ca: {
        pageTitle: 'Compte i Homes',
        homesTitle: 'Homes',
        notLinkedTo: ({ service }) => `No vinculat amb ${service}`,
        serviceUnavailable: ({ service }) => `No es pot connectar amb ${service}`,
        signedInToThisHome: 'Sessió iniciada en aquesta Home',
        checkingSignIn: 'Comprovant l’inici de sessió…',
        signInStatusUnavailable: 'Estat d’inici de sessió no disponible',
        machinesOnline: ({ online, total }) => `${online} de ${total} ${total === 1 ? 'màquina' : 'màquines'} en línia`,
        noMachines: 'Encara no hi ha màquines',
        connectedNoMachinesOnline: 'Connectada · cap màquina en línia',
        cantReach: 'No es pot connectar',
        signedOut: 'Sessió tancada',
        signIn: 'Inicia sessió',
        link: 'Vincula',
        linkSubtitle: 'Troba les teves Homes a tots els dispositius',
        manageHomes: 'Gestiona les Homes',
        connectionDetails: 'Detalls de connexió',
        allHomes: 'Totes les Homes',
        allHomesSubtitle: ({ count }) => `${count} Homes · una sola llista`,
        addHome: 'Afegeix una Home…',
        addDevice: 'Afegeix un dispositiu',
    } } as const satisfies Pick<Record<string, AccountPopoverTranslation>, "ca">;

return { accountPopoverTranslations };
})();

const Domain_accountServiceOAuthTranslations = (() => {
const en = Shared_accountServiceOAuthTranslations.en;

const ca = {
    title: 'Inicia la sessió per trobar els teus Homes',
    cancelNote: 'La cancel·lació no tancarà la sessió dels Homes existents.', focusedHomePreserved: 'El Home actiu no canviarà.',
    stages: { signingIn: 'Iniciant sessió', findingHomes: 'Cercant els teus Homes', waitingApproval: 'Esperant l’aprovació del Home' },
    errors: { provider: { title: 'El proveïdor no ha completat l’inici de sessió', body: 'Torna a iniciar la sessió.' }, expired: { title: 'Aquesta sol·licitud d’inici de sessió ha caducat', body: 'Torna a iniciar la sessió.' }, identityChanged: { title: 'La identitat del servei d’inici de sessió ha canviat', body: 'Comprova que és el servei d’inici de sessió que volies fer servir abans de tornar-te a connectar.' }, unavailable: { title: 'El servei d’inici de sessió no està disponible', body: 'Comprova el servei i torna-ho a provar. Els Homes existents no canviaran.' }, exchange: { title: 'No s’ha pogut completar l’inici de sessió', body: 'No s’han desat credencials del servei d’inici de sessió. Torna a iniciar la sessió.' }, storage: { title: 'No s’ha pogut desar l’inici de sessió', body: 'Les credencials dels Homes existents no canviaran. Torna a iniciar la sessió.' }, homeLink: { title: 'Sessió iniciada, però no s’ha pogut enllaçar aquest Home', body: 'El teu inici de sessió està desat. Torna a provar d’enllaçar aquest Home.' }, directoryRefresh: { title: 'Sessió iniciada, però no hem pogut actualitzar la llista de Homes', body: 'La connexió del servei d’inici de sessió està preparada. Torna a provar d’actualitzar la llista de Homes.' }, homeEnrollment: { title: 'Sessió iniciada, però el teu Home personal no s’ha afegit', body: 'El teu inici de sessió està desat. Torna a provar d’afegir el Home.' }, invalid: { title: 'Aquesta sol·licitud d’inici de sessió ja no és vàlida', body: 'Torna a iniciar la sessió.' }, accountDisabled: { title: 'Aquest compte està desactivat', body: 'Contacta amb qui administra el teu servei d’inici de sessió. Els teus Homes existents no canvien.' } },
    actions: { startAgain: 'Torna a començar', openHome: ({ homeName }: { homeName: string }) => `Obre ${homeName}` },
    success: { title: ({ homeName }: { homeName: string }) => `${homeName} està connectat`, body: 'La sessió està desada i aquest Home està llest per utilitzar-se.' },
    notLinked: { title: ({ homeName }: { homeName: string }) => `${homeName} encara no està vinculat a aquest compte`, signInAction: ({ homeName }: { homeName: string }) => `Inicia la sessió a ${homeName}`, body: ({ homeName }: { homeName: string }) => `Inicia la sessió directament a ${homeName}, o escaneja’n el codi QR o enganxa’n l’enllaç de Home.`, scanBody: ({ homeName }: { homeName: string }) => `Escaneja el codi QR de ${homeName} o enganxa’n l’enllaç de Home per connectar-lo.` },
    noHomes: { body: 'Aquest compte encara no té Homes. Actualitza després d’afegir-ne un en un altre lloc, o escaneja el codi QR d’un Home o enganxa’n l’enllaç de Home.' },
    approvalWait: { waitingBody: 'Aprova aquest inici de sessió des del teu altre dispositiu amb sessió iniciada.', cancelledTitle: 'Has deixat d’esperar l’aprovació', cancelledBody: 'El teu inici de sessió continua desat i els Homes existents no canvien.' },
} as const;

const accountServiceOAuthTranslations = { ca } as const;

return { accountServiceOAuthTranslations };
})();

const Domain_actionConfirmationTranslations = (() => {
type ActionConfirmationTranslations = Shared_actionConfirmationTranslations.ActionConfirmationTranslations;

const actionConfirmationTranslations = { ca: {
        requestedByAgent: 'Acció sol·licitada per l’agent de la sessió',
        homeTarget: ({ serverId }) => `Home: ${serverId}`,
        sessionTarget: ({ sessionId }) => `Sessió de destinació: ${sessionId}`,
        oneShotConsequence: 'L’aprovació només s’aplica a aquesta sol·licitud. No concedeix permisos futurs d’Action ni permisos natius.',
        homeUnavailable: 'Aquesta aprovació pertany a un Home que no està disponible en aquest dispositiu. Torna a connectar aquest Home per decidir.',
    } } as const satisfies Pick<Record<string, ActionConfirmationTranslations>, "ca">;

return { actionConfirmationTranslations };
})();

const Domain_fileContentSearchTranslations = (() => {
const fileContentSearchTranslations = { "ca": {
        textInFiles: "Text als fitxers",
        everything: "Tot",
        refineSearch: "Refina la cerca",
        partial: "No s’han pogut cercar alguns fitxers. Els resultats són incomplets.",
        updateRequired: "Actualitza Happier en aquesta màquina per cercar text als fitxers.",
        invalidPattern: "L’expressió regular no és vàlida. Edita el patró i torna-ho a provar.",
        unavailable: "La cerca de text no està disponible. Comprova la connexió de la màquina i torna-ho a provar.",
        placeholder: "Cerca fitxers, missatges, commits, sessions, configuració i accions",
        matchCase: "Distingeix majúscules",
        regex: "Expressió regular",
    } };

return { fileContentSearchTranslations };
})();

const Domain_promptPickerTranslations = (() => {
const promptPickerTranslations = { "ca": {
        "partialHistory": "Enviats abans només inclou sessions conegudes.",
        "loadedHistory": "Enviats abans només mostra missatges carregats.",
        "open": "Obre els prompts",
        "menu": "Prompts…",
        "placeholder": "Cerca prompts i missatges enviats",
        "favorites": "Preferits",
        "library": "Biblioteca",
        "sentBefore": "Enviats abans",
        "builtIn": "Integrat",
        "readError": "No s’ha pogut llegir aquest prompt. Torna-ho a provar.",
        "libraryError": "No s’ha pogut carregar la biblioteca.",
        "partialLibrary": "No s’han pogut llegir alguns prompts.",
        "loadOlder": "Cerca missatges anteriors",
        "stop": "Atura",
        "insert": "Insereix",
        "send": "Envia ara",
        "addFavorite": "Afegeix als preferits",
        "removeFavorite": "Treu dels preferits",
        "empty": "Desa un missatge com a prompt per reutilitzar-lo aquí.",
        "applyError": "No s’ha pogut aplicar el prompt. Torna-ho a provar.",
        "historyError": "No s’han pogut carregar els missatges anteriors. Torna-ho a provar.",
        "title": "Prompts",
        "clear": "Esborra",
        "favorite": "Preferit",
        "favoritesInvite": "Marca un prompt o un missatge enviat amb una estrella per tenir-lo aquí.",
        "saveAsFavorite": "Desa com a prompt preferit",
        "saveInPlaceStarred": ({ time }: { time: string }) => `Del teu missatge de ${time} · va a la biblioteca, amb estrella`,
        "saveInPlace": ({ time }: { time: string }) => `Del teu missatge de ${time} · va a la biblioteca`,
        "noMatchesFor": ({ query }: { query: string }) => `Cap prompt ni missatge carregat coincideix amb «${query}»`,
        "previewInserts": "s’insereix i després l’envies",
        "previewSent": "enviat abans",
        "previewEdited": ({ time }: { time: string }) => `Editat ${time}`,
        "searchingOlder": ({ searched, total }: { searched: number; total: number }) => `Cercant missatges anteriors… ${searched} de ${total} sessions`
    } } as const;

return { promptPickerTranslations };
})();

const Domain_actionFamilyTranslations = (() => {
const fileContentSearchTranslations = {...Domain_fileContentSearchTranslations.fileContentSearchTranslations, ...EnglishFeatures.fileContentSearchTranslations.fileContentSearchTranslations};

const promptPickerTranslations = {...Domain_promptPickerTranslations.promptPickerTranslations, ...EnglishFeatures.promptPickerTranslations.promptPickerTranslations};

const surfaceFamilyLabels = Shared_actionFamilyTranslations.surfaceFamilyLabels;

const english = Shared_actionFamilyTranslations.english;

const translated = Shared_actionFamilyTranslations.translated;

const actionFamilyTranslations = { ca: translated({
        actionFamilies: {
            ...surfaceFamilyLabels,
            workspace_file_search: fileContentSearchTranslations.ca.textInFiles,
            find: 'Cerca',
            app_shell: 'Workspace',
            roles: 'Rols',
            launch_profiles: 'Perfils d’inici',
            discovery: 'Descobriment d’accions',
            computer: 'Control de l’ordinador',
            artifact_access: 'Compartició d’artefactes',
            workflows: 'Fluxos de treball',
            notifications: 'Notificacions',
            machine_agent_install: 'Instal·lacions d’agents',
            machine_agent_sign_in: 'Inici de sessió d’agents',
            session_access: 'Compartició de sessions',
            session_lifecycle: 'Cicle de vida de les sessions',
            inventory: 'Inventari d’ordinadors',
            messaging: 'Missatgeria',
            session_control: 'Controls de sessió',
            intent_start: 'Revisions i delegació',
            review_comments: 'Comentaris de revisió',
            subagent_registry: 'Agents subordinats',
            execution_run_control: 'Execucions en segon pla',
            session_targeting: 'Selecció de sessions',
            session_follow: 'Seguiment de sessions',
            session_transcripts: 'Transcripcions de sessions',
            session_read_state: 'Estat de lectura',
            session_attention: 'Atenció',
            session_board: 'Tauler de sessions',
            session_discussion: 'Debats',
            session_permissions: 'Permisos de sessió',
            external_sessions: 'Sessions externes',
            voice_controls: 'Controls de veu',
            current_ui_context: 'Pantalla actual',
            companion_controls: 'Acompanyant',
            memory: 'Memòria',
            agent_acp_catalog: 'Agents ACP',
            prompt_library: 'Biblioteca d’indicacions',
            daemon_admin: 'Administració del dimoni',
            browser_control: 'Control del navegador',
            browser_diagnostics: 'Diagnòstic del navegador',
            browser_context: 'Context del navegador',
            browser_automation: 'Automatització del navegador',
            browser_recording: 'Enregistrament del navegador',
            local_services_inventory: 'Serveis locals',
            local_services_launcher: 'Llançador de serveis',
            local_services_preview: 'Previsualitzacions de serveis',
            local_services_public_preview: 'Previsualitzacions públiques',
            local_services_actions: 'Accions de serveis',
            peer_mediation_observability: 'Diagnòstic de connexions',
            devices_simulator: 'Simuladors',
            approvals: 'Aprovacions',
            plugin_dev_loop: 'Desenvolupament de connectors',
            plugin_settings_administration: 'Configuració de connectors',
            plugin_permission_grants: 'Permisos de connectors',
            plugin_webhooks: 'Webhooks de connectors',
            account_plugin_data: 'Dades de connectors',
            account_sessions: 'Dispositius connectats',
            account_security: 'Seguretat del compte',
            account_api_tokens: 'Tokens d’API',
            identity_github_apps: 'Aplicacions de GitHub',
            identity_providers: 'Proveïdors d’inici de sessió',
            machine_pools: 'Grups d’ordinadors',
            ephemeral_runner: 'Executors',
            automation_events: 'Esdeveniments d’automatització',
            automation_conversation: 'Converses d’automatització',
            scm_git: 'Git',
            scm_pull_request: 'Sol·licituds d’incorporació',
            scm_repository: 'Repositoris',
            scm_diff_summary: 'Resums de canvis',
            home_governance: 'Administració del Home',
            teams: 'Equips',
            saved_secret_sharing: 'Secrets compartits',
        },
    }) } as const;

return { actionFamilyTranslations };
})();

const Domain_addFlowsTranslations = (() => {
type AddFlowsTranslation = Shared_addFlowsTranslations.AddFlowsTranslation;

const addFlowsTranslations = { ca: {
        addHome: 'Afegeix un Home',
        addHomeSubtitle: 'Inicia la sessió, connecta per adreça o fes-ne servir un d’allotjat',
        addHomeDescription: 'Connecta un Home que ja fas servir o fes-ne servir un d’allotjat per a tu.',
        newGroup: 'Grup nou',
        newGroupSubtitle: 'Veure juntes les sessions de diversos Homes',
        groupsTitle: 'Grups',
        homesInUse: 'En ús aquí',
        thisDeviceTitle: 'Aquest dispositiu',
        thisDeviceSubtitle: 'Com arriba als seus Homes',
        thisDeviceDescription: 'Com arriba aquest dispositiu als seus Homes: dispositius en espera, la connexió que fa servir i el Home que executa.',
        newHomeDraft: 'Home nou',
        homeMissingTitle: 'Aquest Home no és en aquest dispositiu',
        homeMissingDescription: 'S’ha eliminat o es va desar en un altre dispositiu.',
        homeManageTitle: 'Gestiona',
        homeAdministrationSubtitle: 'Persones, inici de sessió, abast i dades d’aquest Home',
        groupMissingTitle: 'Aquest grup ja no existeix',
        groupMissingDescription: 'S’ha eliminat. Els teus Homes no han canviat.',
        discard: 'Descarta',
        sshSignInAgent: 'El teu agent SSH en aquest ordinador',
        sshSignInKeyFile: 'Un fitxer de clau privada en aquest ordinador',
        sshSignInPassword: 'S’usa un cop per connectar; mai no es desa',
        addMachineMenuSubtitle: 'Un ordinador o un servidor',
        addMachineDescription: 'Afegeix un ordinador o un servidor perquè els agents hi executin les teves sessions.',
        machineJoinsHome: ({ home }) => `S’uneix a ${home}`,
        pathThisComputerTitle: 'Aquest ordinador',
        pathThisComputerTask: 'Configura’l en un pas',
        pathThisComputerCommand: 'Una ordre al teu terminal',
        pathSshTitle: 'Un servidor per SSH',
        pathSshChip: 'Servidor SSH',
        pathSshSubtitle: 'Una màquina de desenvolupament, VM o servidor al núvol',
        pathAnotherTitle: 'Un altre ordinador',
        pathAnotherSubtitle: 'Obre un enllaç a la Llar en aquell ordinador',
        machinePoolPrompt: 'Vols que les sessions passin d’una màquina a una altra?',
        thisComputerCommandLead: ({ home }) => `Executa això en un terminal d’aquest ordinador. Instal·la Happier i s’uneix a ${home}; aquesta pàgina ho detecta tan bon punt estigui a punt.`,
        thisComputerTaskLead: ({ machine, home }) => `${machine} executa els agents per a ${home}. Happier instal·la un petit servei en segon pla que s’inicia amb l’ordinador.`,
        setUpThisComputer: 'Configura aquest ordinador',
        desktopAppHint: 'Prefereixes fer clic que escriure?',
        desktopAppLink: 'Baixa l’app d’escriptori: configura aquest ordinador tota sola.',
        thisComputerRunningLead: ({ machine }) => `S’està configurant ${machine}. Pots continuar fent servir Happier.`,
        onAnotherHomeTitle: ({ machine }) => `${machine} està connectat a un altre Home`,
        onAnotherHomeBody: ({ home }) => `El seu servei Happier executa sessions d’un altre Home. Moure’l a ${home} en conserva la configuració; les sessions que ja hi són s’hi queden.`,
        moveToHome: ({ home }) => `Mou-lo a ${home}`,
        keepOnOtherHome: 'Deixa’l on és',
        sshLeadTask: ({ home }) => `Una màquina de desenvolupament, VM o servidor al núvol on ja arribes per SSH. Aquest ordinador s’hi connecta, instal·la Happier i s’uneix a ${home}.`,
        sshLeadCommand: ({ home }) => `Una màquina de desenvolupament, VM o servidor al núvol accessible per SSH. Executa l’ordre en un ordinador que hi arribi; instal·la Happier i s’uneix a ${home}.`,
        setUpHost: ({ host }) => `Configura ${host}`,
        sshSavedNote: 'L’amfitrió es desa a Amfitrions remots; les contrasenyes mai.',
        sshRunningTitle: ({ host }) => `S’està configurant ${host}`,
        sshRunningLead: 'S’executa per SSH des d’aquest ordinador. Pots marxar; la llista de màquines en mostra el progrés i t’avisa quan acabi.',
        anotherLead: ({ home }) => `Executa això en un terminal d’aquell ordinador. Instal·la Happier i s’uneix a ${home}.`,
        anotherTerminalAction: 'Fes servir una ordre de terminal en lloc seu',
        machineWatching: ({ subject }) => `Esperant ${subject} a `,
        subjectThisComputer: 'aquest ordinador',
        subjectAnotherComputer: 'l’ordinador',
        machineNotSeeingTitle: ({ subject }) => `Encara no apareix ${subject}?`,
        machineNotSeeingBody: ({ home }) => `Happier encara espera. Normalment la configuració s’ha aturat amb un error, la màquina no arriba a ${home} o es va configurar per a un altre Home.`,
        machineArrived: ({ machine }) => `${machine} està connectat`,
        machineConnectedJustNow: 'connectat ara mateix',
        machineStartSession: ({ machine }) => `Inicia una sessió a ${machine}`,
        machineAddAnother: 'Afegeix-ne una altra',
        cancelSetup: 'Cancel·la',
        detectedOs: 'Detectat',
        sshSuggestionsTitle: 'De la teva configuració SSH i amfitrions desats',
        connectingToHome: ({ address }) => `S’està connectant a ${address}…`,
        pathThisComputerConnected: 'Connectat · veure’n els agents',
    } } satisfies Pick<Readonly<Record<string, AddFlowsTranslation>>, "ca">;

return { addFlowsTranslations };
})();

const Domain_agentInstallJobTranslations = (() => {
const en = Shared_agentInstallJobTranslations.en;

const agentInstallJobTranslations = { ca: { ...en } };

return { agentInstallJobTranslations };
})();

const Domain_agentStartTranslations = (() => {
const en = Shared_agentStartTranslations.en;

const ca: typeof en = {
    titles: {
        conversation: 'Una conversa al costat',
    },
    descriptions: {
        conversation: ({ machine }) => `Pregunta el que vulguis sense interrompre aquesta sessió. S’executa a ${machine} al seu costat; no hi torna res si no ho envies.`,
    },
    chips: {
        engineTitle: 'Qui respon',
        addReviewer: 'Afegeix un revisor',
        removeReviewer: ({ name }) => `Treu ${name}`,
        scope: 'Què cal revisar',
        advanced: 'Avançat',
    },
    reportToSession: 'Informa aquesta sessió',
    startsWhenYouSend: ({ count }) => count > 1 ? `${count} revisions comencen quan envies` : 'Comença quan envies',
    offline: ({ machine }) => `${machine} està fora de línia. L’agent hi comença; el teu esborrany es queda aquí fins que torni.`,
    menu: {
        askSection: 'Demana a un agent',
        secondOpinionTitle: 'Segona opinió',
        secondOpinionSubtitle: 'Una comprovació independent abans d’acabar',
        keepGoingTitle: 'Continua fins acabar…',
        keepGoingSubtitle: 'Defineix un objectiu al control d’objectiu',
        runWorkflowTitle: 'Executa un flux de treball',
        runWorkflowSubtitle: 'De la teva biblioteca o un d’integrat',
        searchWorkflows: 'Cerca fluxos de treball…',
        yourLibrary: 'La teva biblioteca',
        noWorkflows: 'Encara no hi ha fluxos desats',
        addTriggerTitle: 'Afegeix un activador…',
        addTriggerSubtitle: 'S’executa aquí cada cop que passa alguna cosa',
        advancedTitle: 'Avançat…',
        advancedSubtitle: 'Diversos agents, permisos, perfil',
        builtIn: 'Integrats',
        allWorkflows: 'Tots els fluxos de treball…',
    },
    role: {
        replaces: ({ agent }) => `Substitueix ${agent}`,
    },
    startRow: {
        subtitle: 'Esborrany · comença quan envies',
        conversation: 'Conversa nova',
        review: 'Revisió nova',
        plan: 'Pla nou',
        delegate: 'Tasca nova',
    },
    pane: {
        cancelRun: 'Cancel·la l’execució',
        whenItFinishes: 'Quan acabi',
        sendToSession: ({ session }) => `Envia a ${session}`,
        replyTo: ({ agent }) => `Respon a ${agent}…`,
        repliesGoTo: ({ session }) => `Les respostes van a aquest agent, no a ${session}`,
    },
};

const agentStartTranslations = { ca };

return { agentStartTranslations };
})();

const Domain_apiTokenSettingsTranslations = (() => {
const english = Shared_apiTokenSettingsTranslations.english;

const translated = Shared_apiTokenSettingsTranslations.translated;

const apiTokenSettingsTranslations = { ca: translated({
        settingsApiTokens: {
            encryption: {
                choice: "Accés al xifratge",
                consequence: "Concedeix accés al xifratge de tot el compte. La revocació atura futures autoritzacions d’API; les claus o dades ja obtingudes no es poden recuperar.",
                enabled: "Accés al xifratge activat",
                bearerOnly: "Només accés API",
                unknown: "Accés al xifratge no disponible",
                outcomeUnknown: "La creació pot haver finalitzat. Actualitza la llista i revoca aquest token abans de crear-ne un de nou.",
                unsupported: "Aquest Home encara no admet tokens d’API xifrats. Actualitza’l o crea un token ordinari.",
                notReady: "Restaura l’accés al xifratge en aquest Home abans de crear un token xifrat.",
                stale: "La clau de xifratge del compte ha canviat. Restaura l’accés en aquest Home.",
                idConflict: "Aquest identificador de token ja existeix. Revoca aquest token abans de crear-ne un altre.",
            },
            unattended: {
                choice: "Accés desatès a l’equip",
                consequence: "Copia en aquest token els mètodes d’autenticació verificats actualment d’aquesta credencial per al treball restringit de l’equip. L’accés al xifratge és independent.",
                authorized: "Accés desatès a l’equip autoritzat",
                notAuthorized: "Sense accés desatès a l’equip",
                evidenceLimit: "Aquesta credencial té massa mètodes d’autenticació verificats per copiar-los. No s’ha creat cap token.",
                evidenceUnavailable: "Aquesta credencial iniciada no té cap evidència d’autenticació actual per copiar. Torna a autenticar-te amb el mètode requerit; no s’ha creat cap token.",
            },
            title: "Tokens d'API",
            entrySubtitle: 'Permet que scripts, servidors i aplicacions incrustades actuïn en nom teu, només amb l’accés que els donis.',
            tokens: "Tokens d'API",
            refreshing: 'S’està actualitzant…',
            emptyTitle: "Encara no hi ha tokens d'API",
            emptyBody: 'Els tokens permeten que els scripts i les eines de confiança executin les accions automatitzades que permets. Crea’n un quan una integració necessiti accés al teu compte actual.',
            created: 'Creat',
            lastUsed: 'Últim ús',
            neverUsed: 'No s’ha utilitzat mai',
            securityTitle: 'Seguretat',
            securityFooter: 'Aquestes accions s’apliquen a tot el compte actual.',
            status: {
                active: 'Actiu',
                expiresInMinutes: ({ count }) => `Caduca en ${count} min`,
                expiresInHours: ({ count }) => `Caduca en ${count} h`,
                expiresInDays: ({ count }) => `Caduca en ${count} d`,
                expired: 'Caducat',
            },
            rowAccessibilityLabel: ({ label, state }) => `${label}, estat: ${state}`,
            moreActionsAccessibilityLabel: ({ label }) => `Més accions per a ${label}`,
            create: {
                button: 'Crea un token',
                title: "Crea un token d'API",
                subtitle: "Anomena la integració i tria quan caduca aquest token. El teu Home pot llegir les sol·licituds i els resultats de l’API ordinària; l’accés al xifratge pot protegir les crides de l’SDK compatibles.",
                submit: 'Crea un token',
                label: 'Etiqueta',
                labelPlaceholder: 'Automatització de llançaments',
                expiry: 'Caduca',
                expiryOptions: {
                    '30d': '30 dies',
                    '90d': '90 dies',
                    '1y': '1 any',
                    none: 'Sense caducitat',
                },
                access: 'Accés',
                accessFull: 'Accés complet',
                accessLimited: 'Limitat',
                accessLimitedDescription: 'A continuació, tria accions, sessions, models i llocs web.',
                accessTitle: 'Tria l’accés',
                continue: 'Continua',
                back: 'Enrere',
                actionSettingsPrefix: 'Aquest token pot executar qualsevol operació habilitada per a l’API externa i l’SDK a la teva',
                actionSettingsLink: 'Configuració d’accions.',
            },
            reveal: {
                title: "Desa el teu token d'API",
                accessibilityAnnouncement: 'Copia el token ara: només es mostra una vegada.',
                successTitle: 'Token creat',
                shownOnce: 'Copia aquest token ara. Per seguretat, Happier no el pot tornar a mostrar.',
                copy: 'Copia el token',
                copied: 'Copiat',
                dismissTitle: 'Vols sortir sense confirmar-ho?',
                dismissBody: 'Aquest token no es tornarà a mostrar. Copia’l primer o confirma que l’has desat en un lloc segur.',
                copyFirst: 'Mantén el token visible',
                savedIt: 'L’he desat',
            },
            revoke: {
                title: ({ label }) => `Vols revocar «${label}»?`,
                body: 'L’accés al servidor i a l’API s’aturarà en la verificació següent. Un dimoni local que hagi verificat recentment aquest token d’API encara el podria acceptar durant un minut. Aquesta acció no es pot desfer.',
                confirm: 'Revoca el token',
            },
            revokeAll: {
                title: "Revoca tots els tokens d'API",
                subtitle: "Desactiva tots els tokens d'API d'aquest compte.",
                body: 'L’accés al servidor i a l’API s’aturarà en la verificació següent. Les incrustacions que utilitzin aquests tokens deixaran de funcionar i se’n tancarà la sessió de les credencials incrustades. Els dimonis locals que hagin verificat recentment aquests tokens d’API encara els podrien acceptar durant un minut. Aquesta acció no es pot desfer.',
                confirm: 'Revoca’ls tots',
                railAction: 'Revoca tots els tokens d’API…',
            },
            signOutEverywhere: {
                title: 'Tanca la sessió a tot arreu',
                subtitle: 'Finalitza totes les sessions iniciades en aquest compte.',
                body: 'Totes les sessions iniciades al navegador i als dispositius acabaran. Els tokens d’API continuaran actius; revoca’ls per separat des d’aquesta pantalla.',
                confirm: 'Tanca la sessió a tot arreu',
            },
            errors: {
                labelRequired: 'Introdueix una etiqueta abans de crear el token.',
                accountChanged: 'El teu compte o Home actiu ha canviat, així que no s’ha canviat res. Torna-ho a obrir per continuar.',
                presentUserRequired: 'Confirma la teva identitat al missatge d’inici de sessió i torna-ho a provar.',
                offline: 'Happier no ha pogut arribar al teu compte. Comprova la connexió i torna-ho a provar.',
                unavailable: 'Aquesta acció no està disponible ara mateix. Torna-ho a provar d’aquí a un moment.',
                copyFailed: 'No s’ha pogut copiar el token. Selecciona’l i copia’l manualment abans de tancar.',
                listTitle: "Els tokens d'API no estan disponibles",
                grantIncomplete: 'Acaba de triar l’accés abans de crear el token.',
            },
            embedPill: 'Incrustació',
            embedRowHint: 'Obre aquesta incrustació a Configuració, Incrustacions.',
            summary: {
                full: 'Accés complet',
                allActions: 'Totes les accions',
                namesAndMore: ({ names, count }) => `${names} +${count}`,
                sessions: ({ count }) => (count === 1 ? '1 sessió' : `${count} sessions`),
                computers: ({ count }) => (count === 1 ? '1 ordinador' : `${count} ordinadors`),
                approve: 'Pot aprovar',
                models: ({ count }) => (count === 1 ? '1 model' : `${count} models`),
                websites: ({ count }) => (count === 1 ? '1 lloc web' : `${count} llocs web`),
                content: 'Accés al contingut',
                noExpiry: 'Sense caducitat',
                expires: ({ date }) => `Caduca el ${date}`,
                expired: ({ date }) => `Va caducar el ${date}`,
            },
            grant: {
                accessTitle: 'Accés',
                back: 'Accés',
                onlyThese: 'Només aquests',
                selectedCount: ({ count }) => (count === 1 ? '1 seleccionat' : `${count} seleccionats`),
                reviewUnnamed: 'Aquest token',
                actions: {
                    title: 'Accions',
                    all: 'Totes les accions',
                    none: 'Tria almenys una acció',
                    search: 'Cerca accions',
                    noMatches: ({ query }) => `Cap acció coincideix amb «${query}»`,
                    groupDescription: 'Un grup sencer també inclou les accions que s’hi afegeixin més endavant.',
                    familyCount: ({ count }) => (count === 1 ? 'Grup · 1 acció' : `Grup · ${count} accions`),
                    includedByFamily: ({ family }) => `Inclosa a ${family}`,
                },
                targets: {
                    title: 'Sessions i ordinadors',
                    all: 'Totes les sessions i ordinadors',
                    none: 'Tria almenys una sessió o un ordinador',
                    computers: 'Ordinadors',
                    computersDescription: 'Un ordinador inclou totes les seves sessions, ara i en el futur.',
                    sessions: 'Sessions individuals',
                    searchSessions: 'Cerca sessions',
                    noSessions: 'Encara no hi ha sessions',
                    noSessionMatches: ({ query }) => `Cap sessió coincideix amb «${query}»`,
                    noComputers: 'Encara no hi ha ordinadors',
                },
                models: {
                    title: 'Models permesos',
                    any: 'Qualsevol model',
                    onlyThese: 'Només aquests models',
                    none: 'Tria almenys un model',
                    pickerDescription: 'Els altres models es rebutgen, no només s’amaguen. «Automàtic» no s’ofereix un cop tries models.',
                    noModels: 'Encara no hi ha models per triar',
                },
                approve: {
                    title: 'Aprova sol·licituds',
                    on: 'Pot aprovar l’ús d’eines i les sol·licituds a les sessions anteriors, incloses les que ha iniciat ell mateix. Mai no pot canviar tokens, seguretat ni connectors.',
                    off: 'Les sol·licituds t’esperen a Happier.',
                },
                websites: {
                    title: 'Llocs web',
                    description: 'Les pàgines d’aquests llocs poden utilitzar el token des d’un navegador. Deixa-ho buit per a scripts i servidors.',
                    inputLabel: 'Afegeix un lloc web',
                    placeholder: 'https://app.example.com',
                    add: 'Afegeix',
                    invalid: 'Comença amb https://, o http:// per a localhost.',
                    duplicate: 'Aquest lloc web ja és a la llista.',
                    remove: ({ origin }) => `Elimina ${origin}`,
                },
            },
            detail: {
                whatItCanDo: 'Què pot fer',
                whatItCanDoDescription: 'Accions que aquest token pot executar per tu. Tota la resta es rebutja.',
                everyAction: 'Totes les accions habilitades per a l’API externa i l’SDK',
                wholeGroup: 'Grup sencer',
                where: 'On',
                whereDescription: 'Sessions i ordinadors als quals pot accedir.',
                computerCovers: 'Totes les sessions d’aquest ordinador',
                unknownComputer: 'Un ordinador que ja no apareix a la llista',
                unknownSession: 'Una sessió que ja no apareix a la llista',
                modelsDescription: 'Els altres models es rebutgen, no només s’amaguen.',
                approvals: 'Aprovacions',
                approvesOn: 'Aprova sol·licituds',
                approvesOff: 'No aprova sol·licituds',
                websitesDescription: 'Les pàgines del navegador d’aquests llocs el poden utilitzar.',
                noWebsites: 'Només scripts i servidors',
                content: 'Accés al contingut',
                contentOn: 'Pot llegir contingut xifrat d’extrem a extrem mitjançant crides de l’SDK compatibles.',
                contentOff: 'No pot llegir contingut xifrat d’extrem a extrem.',
                children: 'Credencials incrustades',
                childrenDescription: 'Claus de curta durada que la teva aplicació ha generat a partir d’aquest token per a les seves pàgines.',
                childrenCount: ({ count }) => (count === 1 ? '1 activa' : `${count} actives`),
                childrenConsequence: 'Se’n tanca la sessió quan edites l’accés o revoques aquest token.',
                sessionLimits: 'Sessions',
                sessionLimitsDescription: 'Les sessions que pot iniciar i els modes de permís que poden fer servir els seus missatges.',
                createsSessions: 'Inicia sessions',
                createsSessionsOn: ({ computer }: { computer: string }) => `A ${computer}, en una carpeta privada que gestiona Happier.`,
                editAccess: 'Edita l’accés',
                revokeFootnote: 'Els scripts i les incrustacions que l’utilitzen deixaran de funcionar a la sol·licitud següent.',
                created: ({ date }) => `Creat el ${date}`,
                lastUsed: ({ date }) => `Últim ús: ${date}`,
                missingTitle: 'Aquest token ja no hi és',
                missingBody: 'S’ha revocat o ha caducat i s’ha eliminat. Els altres tokens continuen a la llista.',
                backToTokens: 'Mostra els tokens d’API',
            },
            edit: {
                title: 'Edita l’accés',
                save: 'Desa',
                signsOut: 'Es tancarà la sessió de les credencials incrustades actives.',
            },
            cliPolicy: {
                sectionTitle: 'CLI i dimoni',
                sectionDescription: 'Què poden fer les ordres dels teus ordinadors amb el teu inici de sessió.',
                title: 'Permet aprovacions i canvis al compte des de la CLI i el dimoni',
                description: 'Permet que les ordres dels teus ordinadors aprovin sol·licituds i canviïn la configuració del compte. Desactiva-ho si hi ha agents que s’executen amb accés a l’intèrpret d’ordres. Un ordinador també pot excloure-se’n amb HAPPIER_CLI_PRESENT_USER=disallowed. Canviar-ho reconnecta breument els teus ordinadors.',
                unavailable: 'No s’ha pogut llegir aquesta opció. Torna-ho a provar d’aquí a un moment.',
                saveFailed: 'No s’ha pogut canviar aquesta opció. Torna-ho a provar d’aquí a un moment.',
            },
            notices: {
                revoked: "S'ha revocat el token d'API.",
                revokedAll: "S'han revocat tots els tokens d'API.",
                signedOutEverywhere: "S'ha tancat la sessió a tot arreu. Els tokens d'API continuen actius.",
            },
        },
    }) } as const;

return { apiTokenSettingsTranslations };
})();

const Domain_artifactsBrowserTranslations = (() => {
type ArtifactsBrowserTranslations = Shared_artifactsBrowserTranslations.ArtifactsBrowserTranslations;

const artifactsBrowserTranslations = { ca: {
        description: 'El que tu i els teus agents heu desat, a punt per llegir, reutilitzar i compartir.',
        newDocument: 'Document nou',
        searchPlaceholder: 'Cerca artefactes',
        kindLabel: 'Tipus',
        kinds: {
            all: 'Tots els tipus',
            document: 'Documents',
            prompt: 'Prompts',
            board: 'Taulers',
            workflow: 'Fluxos de treball',
            role: 'Rols',
            launchProfile: 'Perfils d’inici',
        },
        kindOne: {
            document: 'Document',
            prompt: 'Prompt',
            board: 'Tauler',
            workflow: 'Flux de treball',
            role: 'Rol',
            launchProfile: 'Perfil d’inici',
        },
        sort: {
            label: 'Ordena',
            updated_desc: 'Actualitzats recentment',
            created_desc: 'Creats recentment',
            title_asc: 'Títol',
        },
        view: {
            label: 'Vista',
            grid: 'Quadrícula',
            list: 'Llista',
        },
        provenance: {
            savedByYou: 'Desat per tu',
            sharedWithYou: 'Compartit amb tu',
            fromFile: ({ name }) => `De ${name}`,
            openSession: ({ session }) => `Obre ${session}`,
        },
        emptyTitle: 'Conserva el que creen els teus agents',
        emptyBody: 'Els plans, notes, codi i taulers que tu o els teus agents deseu arriben aquí, llegibles a tots els dispositius i a punt per compartir amb els teus equips.',
        emptyHint: 'O demana a un agent “desa-ho com a artefacte”.',
        loadFailedTitle: 'No s’han pogut carregar els teus artefactes',
        loadFailedBody: 'Comprova la connexió i torna-ho a provar. No s’ha perdut res.',
        quota: {
            accountTitle: 'L’emmagatzematge d’artefactes és ple',
            documentTitle: 'Massa gran per desar',
            accountBody: ({ used, limit }) => `${used} de ${limit} usats, versions incloses. Suprimeix o exporta els artefactes que ja no necessitis per desar-ne de nous.`,
            documentBody: ({ size, limit }) => `Ocuparia ${size}; cada artefacte admet fins a ${limit}. Els teus canvis encara hi són.`,
        },
        open: {
            document: 'Obre el document',
            prompt: 'Obre el prompt',
            board: 'Obre el tauler',
            workflow: 'Obre el flux de treball',
            role: 'Obre el rol',
            launchProfile: 'Obre el perfil d’inici',
        },
        openAsPage: 'Obre com a pàgina',
        actions: {
            edit: 'Edita',
            history: 'Historial',
            share: 'Comparteix',
            more: 'Més accions',
            copyLink: 'Copia l’enllaç',
            linkCopied: 'Enllaç copiat',
        },
        history: {
            title: 'Historial',
            current: 'Actual',
            now: 'Ara',
            restoreNote: 'Restaurar-la l’afegeix com a versió nova. No es perd res.',
            loadFailed: 'No s’ha pogut carregar l’historial. Torna-ho a provar.',
            empty: 'Encara no hi ha versions anteriors. Cada desament en conserva una.',
            versionsLabel: 'Versions',
            restoreFailed: 'No s’ha pogut restaurar aquesta versió. Torna-ho a provar.',
            savedByUser: 'Desat per un usuari',
            savedByAgentSession: 'Desat per una sessió d’agent',
            restoredVersion: ({ n }) => `Restaurat des de la versió ${n}`,
            version: ({ n }) => `Versió ${n}`,
            keeps: ({ count }) => `Conserva les últimes ${count} versions.`,
            restore: ({ n }) => `Restaura la versió ${n}`,
        },
        savedToday: ({ count }) => `${count} desats avui`,
        noMatch: ({ query }) => `Cap artefacte coincideix amb “${query}”`,
        storage: {
            meter: ({ used, limit }) => `${used} de ${limit}`,
            a11y: ({ used, limit }) => `Emmagatzematge d’artefactes, ${used} de ${limit} usats`,
        },
        facts: {
            edited: ({ age }) => `Editat ${age}`,
        },
    } } satisfies Pick<Record<'en' | 'fr' | 'de' | 'es' | 'it' | 'pt' | 'ca' | 'ru' | 'pl' | 'ja' | 'zh-Hans' | 'zh-Hant', ArtifactsBrowserTranslations>, "ca">;

return { artifactsBrowserTranslations };
})();

const Domain_automationPageTranslations = (() => {
const english = Shared_automationPageTranslations.english;

const translated = Shared_automationPageTranslations.translated;

const slavicPlural = Shared_automationPageTranslations.slavicPlural;

const automationPageTranslations = { ca: translated({
        automationPages: {
            index: {
                description: 'Feina que comença sola: amb una programació, des d’un Event o quan acaba un torn d’una sessió.',
            },
            settings: {
                description: 'Quanta feina d’automatització accepta cada màquina i quant de temps es conserven les execucions acabades.',
                capacityTitle: 'Capacitat',
                capacityDescription: 'S’aplica a totes les màquines que executen automatitzacions.',
                historyTitle: 'Historial d’execucions',
                historyDescription: 'Execucions acabades que encara pots obrir des d’una automatització.',
            },
            detail: {
                description: 'Comença feina sola sempre que s’activa un dels seus activadors.',
                triggerCount: ({ count }: { count: number }) => (count === 1 ? '1 activador' : `${count} activadors`),
                overviewDescription: 'Què executa i com iniciar-la o canviar-la.',
                runNowSubtitle: 'Inicia una execució ara, sense esperar cap activador.',
                editSubtitle: 'Canvia’n el nom, què executa i els activadors.',
                machineAssignmentsDescription: 'Màquines que poden agafar les execucions d’aquesta automatització.',
            },
            run: {
                description: 'Què ha iniciat aquesta execució, on s’ha executat i què ha produït.',
                statusTitle: 'Estat',
                statusDescription: 'On és ara aquesta execució i què encara hi pots fer.',
                causeTitle: 'Què l’ha iniciat',
                causeDescription: 'L’activador i l’event que van admetre aquesta execució. No canvien mai després.',
            },
            gate: {
                serverTitle: 'Les automatitzacions estan desactivades en aquest Home',
                serverBody: 'Els administradors d’aquest Home han desactivat les automatitzacions. Demana a un d’ells que les torni a activar.',
                openFeatures: 'Obre la configuració de funcions',
                unknownTitle: 'No es poden comprovar les automatitzacions ara mateix',
                unknownBody: 'Happier no ha pogut contactar amb aquest Home per comprovar si les automatitzacions estan activades. Torna-ho a comprovar quan torni a estar en línia.',
                unsupportedTitle: 'Aquest Home encara no admet automatitzacions',
                unsupportedBody: 'El seu servidor és anterior a les automatitzacions. Actualitza el servidor del Home per utilitzar-les.',
                unsupportedContextTitle: 'Les automatitzacions no estan disponibles aquí',
                unsupportedContextBody: 'No tots els Homes que estàs veient admeten automatitzacions.',
            },
            editor: {
                description: 'Posa-li nom, tria què executa i afegeix els activadors que la inicien.',
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

const automationTriggerSetTranslations = { ca: {
        pluralEditor: {
            ...expandedLifecycleEnglish,
            lifecycleEvent: {
                ...expandedLifecycleEnglish.lifecycleEvent,
                sessionStarted: 'Quan comença la sessió',
                sessionArchived: 'Quan s’arxiva la sessió',
            },
            triggersTitle: 'Activadors',
            emptyBody: 'No hi ha activadors automàtics. Encara pots executar aquesta automatització manualment.',
            orSemantics: 'Afegeix tants activadors com vulguis. Funcionen independentment: l’automatització s’executa quan qualsevol coincideix.',
            enabledSubtitle: 'Posa en pausa tota l’automatització sense canviar els activadors.', addTrigger: 'Afegeix un activador',
            addTriggerSubtitle: 'Programa-la, connecta un esdeveniment o espera que acabi un torn concret.', scheduleTitle: 'Programació', eventTitle: 'Esdeveniment del connector',
            turnCompletedTitle: 'Quan acabi aquest torn', turnCompletedSubtitle: 'S’executa una vegada quan acaba exactament el torn principal seleccionat.', selectedSession: 'Sessió seleccionada',
            turnCompletedSource: ({ session, ordinal }: { session: string; ordinal: number }) => `${session} · activador d’un sol ús ${ordinal}`,
            scheduleInterval: ({ minutes, timezone }: { minutes: number; timezone: string | null }) => `Cada ${minutes} min${timezone ? ` · ${timezone}` : ''}`,
            scheduleCron: ({ expression, timezone }: { expression: string; timezone: string | null }) => `${expression}${timezone ? ` · ${timezone}` : ''}`,
            eventSubtitle: ({ pluginId, eventId }: { pluginId: string; eventId: string }) => `${pluginId} · ${eventId}`,
            triggerEnabledLabel: ({ title }: { title: string }) => `Habilita ${title}`, editScheduleTitle: 'Edita la programació', scheduleType: 'Tipus de programació',
            chooseSession: 'Tria una sessió activa', eventEditorUnavailable: 'La configuració de l’esdeveniment no està disponible a la màquina actual.',
            removeTitle: 'Vols eliminar aquest activador?', removeBody: 'Les coincidències futures d’aquest activador deixaran d’iniciar l’automatització. L’historial d’execucions no canviarà.',
        },
        exactTurn: {
            eventSearchPlaceholder: 'Cerca esdeveniments',
            refreshFailedTitle: 'No s’han pogut actualitzar les automatitzacions',
            refreshFailedBody: 'Ara mateix no s’ha pogut llegir la llista d’automatitzacions. Torna-ho a provar per carregar la llista actual.',
            actionTitle: 'Quan acabi aquest torn…', createNew: 'Crea una automatització', createNewSubtitle: 'Comença amb aquest torn exacte ja seleccionat.',
            addToExistingSubtitle: 'Afegeix aquest torn exacte a una automatització existent.', searchPlaceholder: 'Cerca automatitzacions',
            eventListA11y: 'Tria l’esdeveniment del cicle de vida de la sessió',
            destinationA11y: 'Tria on afegir l’activador d’aquest torn', staleTitle: 'Aquest torn ha canviat',
            staleBody: 'El torn seleccionat ja no és el torn principal actiu. Actualitza i tria explícitament el torn actual.',
            useCurrentTurn: 'Fes servir el torn actual', unavailable: 'Ara mateix no hi ha cap torn principal actiu.',
            resolvingRowSubtitle: 'Comprovant quines automatitzacions pots fer servir…',
            unavailableRowSubtitle: 'Detalls no disponibles: no es pot verificar aquesta automatització en aquesta sessió.',
            incompleteNoticeTitle: 'No s’han pogut llegir algunes automatitzacions',
        },
    } } as const;

return { automationTriggerSetTranslations };
})();

const Domain_boardsTranslations = (() => {
type Count = Shared_boardsTranslations.Count;

type BoardsTranslations = Shared_boardsTranslations.BoardsTranslations;

const en = Shared_boardsTranslations.en;

const ca: BoardsTranslations = {
    title: 'Taulers',
    newBoard: 'Tauler nou',
    defaultName: 'Tauler sense nom',
    index: {
        title: 'Els teus taulers',
        body: 'Un tauler manté sessions, execucions, fluxos de treball i màquines en viu en un sol lloc, organitzats a la teva manera.',
    },
    notFound: {
        title: 'Aquest tauler ja no hi és',
        body: 'S\'ha eliminat, o pertany a una Home que no està connectada aquí.',
    },
    meta: {
        needYou: ({ count }) => `${count} et necessita${count === 1 ? '' : 'n'}`,
        items: ({ count }) => (count === 1 ? '1 element' : `${count} elements`),
        handPicked: 'Triats a mà',
        empty: 'Buit',
        moreSources: ({ count }) => `+ ${count}`,
    },
    sections: {
        needs_you: { title: 'Et necessita', description: 'Tot el que t\'espera' },
        running: { title: 'En marxa', description: 'Execucions de fluxos de treball en curs' },
        my_machines: { title: 'Les meves màquines', description: 'Presència i què s\'executa a cadascuna' },
        filter: { title: 'Sessions', description: 'Totes les sessions actives' },
    },
    header: {
        layoutA11y: 'Disposició del tauler',
        canvas: 'Llenç',
        byStatus: 'Per estat',
        add: 'Afegeix al tauler',
        settings: 'Configuració del tauler',
    },
    kinds: {
        session: 'Sessió',
        workflow_run: 'Execució de flux de treball',
        workflow: 'Flux de treball',
        machine: 'Màquina',
    },
    card: {
        untitled: 'Element no disponible',
        unavailable: 'No disponible',
        unavailableBody: 'La seva Home no està connectada en aquest dispositiu. Es queda al tauler.',
        notLoaded: 'Encara no s\'ha carregat',
        remove: 'Treu del tauler',
        moveHint: 'Les tecles de fletxa mouen aquesta targeta per la graella.',
        moved: ({ x, y }) => `Mogut a ${x}, ${y}`,
        moveActions: { up: 'Mou amunt', down: 'Mou avall', left: 'Mou a l’esquerra', right: 'Mou a la dreta' },
        machine: {
            online: 'En línia',
            offline: 'Sense connexió',
            running: ({ count }) => (count === 1 ? '1 sessió en marxa' : `${count} sessions en marxa`),
            needYou: ({ count }) => `${count} et necessita${count === 1 ? '' : 'n'}`,
            idle: 'Cap sessió en marxa',
            offlineBody: 'Les seves sessions esperen que torni.',
        },
        workflow: {
            noRuns: 'Encara no hi ha execucions',
            lastRun: ({ word, age }) => `Última execució ${age} · ${word}`,
            needYou: ({ count }) => `${count} et necessita${count === 1 ? '' : 'n'}`,
        },
        run: {
            waitingForYou: 'Esperant la teva revisió',
            started: ({ age }) => `Iniciada ${age}`,
        },
    },
    canvas: {
        snapsHere: 'S\'ajusta aquí',
        snapOnceHint: 'Mantén ⇧ per ajustar un cop',
    },
    settings: {
        title: 'Configuració del tauler',
        name: 'Nom',
        whatsOn: 'Què hi ha en aquest tauler',
        whichSessions: 'Quines sessions',
        addedByHand: 'Afegit a mà',
        addedByHandNone: 'Encara res',
        add: 'Afegeix',
        layout: 'Disposició',
        layoutDescription: 'El llenç conserva la teva distribució quan canvies.',
        snap: 'Ajusta a la graella',
        pin: 'Mostra a la llista de sessions',
        pinDescription: 'Fixa aquest tauler damunt de les teves sessions.',
        delete: 'Elimina el tauler',
        deleteConfirmTitle: 'Vols eliminar aquest tauler?',
        deleteConfirmBody: 'Només s\'elimina el tauler. Les seves sessions, execucions, fluxos de treball i màquines es queden tal com estan.',
    },
    add: {
        title: 'Afegeix al tauler',
        search: 'Cerca elements',
        groups: { sessions: 'Sessions', workflows: 'Fluxos de treball', runs: 'Execucions de fluxos de treball', machines: 'Màquines' },
        onBoard: 'En aquest tauler',
        addHint: 'Afegeix',
        addAndPlaceHint: 'Afegeix i col·loca',
        empty: 'No hi ha coincidències.',
    },
    empty: {
        title: 'Tria què mostra aquest tauler',
        body: 'Afegeix sessions, fluxos de treball, execucions o màquines a mà, o mostra una secció com Et necessita. Tu els organitzes; el tauler els manté en viu.',
        action: 'Afegeix al tauler',
    },
    widgets: {
        group: 'Ginys',
        kind: 'Giny',
        gallery: 'Obre la galeria',
        galleryHint: 'Tots els ginys, amb una vista prèvia en directe',
        addHint: 'Només tu veus els teus taulers',
        widthOne: 'Una targeta',
        widthTwo: 'Dues targetes',
        moveEarlier: 'Mou abans',
        moveLater: 'Mou després',
        remove: 'Treu del tauler',
        menuA11y: ({ widget }) => `Opcions de ${widget}`,
        arrived: ({ count }) => (count === 1 ? 'Ha arribat 1 giny ara mateix' : `Han arribat ${count} ginys ara mateix`),
        undo: 'Desfés',
        dismiss: 'Descarta',
    },
    saveFailed: {
        tooLarge: 'Aquest tauler supera el límit d’emmagatzematge dels taulers. Treu alguns elements i torna-ho a provar.',
        notFound: 'Aquest tauler s\'ha eliminat en un altre dispositiu.',
        generic: 'El canvi no ha arribat al teu compte, així que el tauler es queda com estava.',
        retry: 'Torna-ho a provar',
        dismiss: 'Descarta',
        createTitle: 'Aquest tauler no s’ha creat',
    },
};

const boardsTranslations = { ca };

return { boardsTranslations };
})();

const Domain_browserPresenceTranslations = (() => {
type AgentParams = Shared_browserPresenceTranslations.AgentParams;

type BrowserPresenceTranslations = Shared_browserPresenceTranslations.BrowserPresenceTranslations;

const browserPresenceTranslations = { ca: {
        agentFallbackName: 'L’agent',
        agentBrowsing: ({ agent }) => `${agent} està navegant`,
        clickTarget: ({ target }) => `Fent clic a «${target}»`,
        doing: {
            click: 'Fent clic a la pàgina',
            type: 'Escrivint',
            fill: 'Omplint un camp',
            scroll: 'Desplaçant-se',
            navigate: 'Obrint una pàgina',
            history: 'Movent-se per l’historial',
            reload: 'Recarregant la pàgina',
            press: 'Prement una tecla',
            select: 'Triant una opció',
            drag: 'Arrossegant',
            upload: 'Pujant un fitxer',
            look: 'Mirant la pàgina',
            other: 'Treballant a la pàgina',
        },
        takeControl: 'Pren el control',
        stopping: ({ agent }) => `Aturant ${agent}…`,
        stoppingDetail: 'Acabant la seva darrera acció',
        lastActionMayHaveLanded: ({ agent }) => `La darrera acció de ${agent} potser s’ha fet`,
        youHaveControl: 'Tens el control',
        stopUnconfirmed: 'No s’ha pogut confirmar l’aturada',
        checkAgain: 'Torna-ho a comprovar',
        pausedUntilHandBack: ({ agent }) => `${agent} està en pausa fins que li tornis el control`,
        handBack: 'Torna el control',
        stream: {
            connectingTitle: ({ agent }) => `Connectant amb el navegador de ${agent}`,
            connectingBody: ({ machine }) => `S’executa a ${machine}. La pàgina apareixerà aquí quan arribi el primer fotograma.`,
            stalled: 'Mostrant l’últim fotograma · reconnectant',
            endedTitle: ({ agent }) => `${agent} ha tancat aquest navegador`,
            endedBody: 'La pàgina ja no es mostra aquí.',
            unavailableTitle: ({ agent }) => `No es pot mostrar el navegador de ${agent} aquí`,
            unavailableBody: ({ agent }) => `${agent} continua navegant; les seves accions encara apareixen al xat.`,
            tryAgain: 'Torna-ho a provar',
            inputA11y: 'La pàgina. Toca, desplaça’t o escriu per prendre el control.',
        },
        recording: {
            elapsedA11y: ({ elapsed }) => `Enregistrant, ${elapsed}`,
            discard: 'Descarta l’enregistrament',
        },
        openInYourBrowser: 'Obre al teu navegador',
        slowPage: 'Aquesta pàgina triga una mica',
    } } satisfies Pick<Record<string, BrowserPresenceTranslations>, "ca">;

return { browserPresenceTranslations };
})();

const Domain_browserToolTranslations = (() => {
type TargetParams = Shared_browserToolTranslations.TargetParams;

type BrowserToolTranslations = Shared_browserToolTranslations.BrowserToolTranslations;

const browserToolTranslations = { ca: {
        opened: ({ page }) => `Ha obert ${page}`,
        openedPage: 'Ha obert una pàgina',
        reloaded: 'Ha recarregat la pàgina',
        wentBack: 'Ha tornat enrere',
        wentForward: 'Ha anat endavant',
        clicked: ({ target }) => `Ha fet clic a ${target}`,
        clickedPage: 'Ha fet clic a la pàgina',
        typedInto: ({ target }) => `Ha escrit a ${target}`,
        typed: 'Ha escrit a la pàgina',
        filledIn: ({ target }) => `Ha omplert ${target}`,
        filled: 'Ha omplert un camp',
        pressed: ({ key }) => `Ha premut ${key}`,
        pressedKey: 'Ha premut una tecla',
        scrolled: 'Ha desplaçat la pàgina',
        pointedAt: ({ target }) => `Ha assenyalat ${target}`,
        pointed: 'Ha assenyalat la pàgina',
        choseIn: ({ target }) => `Ha triat una opció a ${target}`,
        chose: 'Ha triat una opció',
        uploadedTo: ({ target }) => `Ha pujat un fitxer a ${target}`,
        uploaded: 'Ha pujat un fitxer',
        dragged: ({ target }) => `Ha arrossegat ${target}`,
        draggedPage: 'Ha arrossegat a la pàgina',
        looked: 'Ha mirat la pàgina',
        screenshot: 'Ha fet una captura de pantalla',
        recordingStarted: 'Ha començat a enregistrar la pàgina',
        recordingStopped: 'Ha aturat l’enregistrament',
        other: 'Ha fet servir el navegador',
        watch: 'Mira',
        watchA11y: 'Obre aquesta pàgina al navegador',
    } } satisfies Pick<Record<string, BrowserToolTranslations>, "ca">;

return { browserToolTranslations };
})();

const Domain_changedFileEvidenceTranslations = (() => {
type ChangedFileEvidenceTranslations = Shared_changedFileEvidenceTranslations.ChangedFileEvidenceTranslations;

const en = Shared_changedFileEvidenceTranslations.en;

const translated = Shared_changedFileEvidenceTranslations.translated;

const changedFileEvidenceTranslations = { ca: {
        changedFileEvidence: translated({
            before: 'Abans',
            after: 'Després',
            binary: 'Fitxer binari',
            truncated: 'El contingut de l’evidència s’ha limitat; la mida original i les estadístiques de canvis es conserven quan estan disponibles.',
            truncatedOldBytes: ({ count }) => `Contingut original d’abans: ${count} bytes`,
            truncatedNewBytes: ({ count }) => `Contingut original de després: ${count} bytes`,
            truncatedDiffBytes: ({ count }) => `Diferència original: ${count} bytes`,
            truncatedAddedLines: ({ count }) => `Línies afegides: ${count}`,
            truncatedRemovedLines: ({ count }) => `Línies eliminades: ${count}`,
            kind: {
                added: 'Afegit',
                modified: 'Modificat',
                deleted: 'Suprimit',
                renamed: 'Reanomenat',
                copied: 'Copiat',
                unknown: 'Tipus de canvi no disponible',
            },
            howDetermined: 'Com s’ha determinat',
            howDeterminedForFile: ({ path }) => `Com s’ha determinat ${path}`,
            content: {
                exact: 'Canvi exacte del repositori',
                strong: 'Evidència de contingut sòlida',
                best_effort: 'Evidència de contingut aproximada',
            },
            attribution: {
                session_exact: 'Vinculat a aquesta sessió',
                session_likely: 'Probablement modificat per aquesta sessió',
                session_possible: 'Possiblement modificat per aquesta sessió',
                unknown: 'Atribució de sessió no disponible',
            },
            reason: {
                provider_correlated: 'L’agent ha informat d’aquest canvi per a aquest torn.',
                canonical_tool_correlated: 'Una eina de diferències o de pedaços ha vinculat aquest canvi amb aquest torn.',
                checkpoint_no_happier_overlap_observed: 'El punt de control no ha registrat cap torn de Happier superposat en aquest procés.',
                checkpoint_overlap_observed: 'Un altre torn de Happier s’ha superposat a l’interval de captura del punt de control.',
                workspace_touched_path: 'Aquesta ruta s’ha tocat a l’espai de treball; això no identifica la sessió que l’ha modificada.',
                unavailable: 'L’evidència no estableix quina sessió ha fet aquest canvi.',
            },
            overlap: {
                observed: 'Un altre torn de Happier s’ha superposat a aquesta còpia de treball durant la captura. Les observacions només cobreixen aquest procés; altres processos i escriptors externs no es registren.',
                not_observed: 'No s’ha observat cap torn de Happier superposat en aquest procés. Altres processos i escriptors externs no es registren; això no estableix una autoria exclusiva.',
                unknown: 'La superposició del punt de control és desconeguda. Altres processos i escriptors externs no es registren.',
            },
            sources: {
                provider_native: 'Informe de canvis natiu de l’agent',
                provider_tool: 'Informe d’una eina de l’agent',
                canonical_diff_tool: 'Evidència d’una eina de diferències',
                canonical_patch_tool: 'Evidència d’una eina de pedaços',
                scm_checkpoint: 'Punt de control del repositori',
                scm_reconciled: 'Instantània reconciliada del repositori',
                inferred: 'Ruta tocada a l’espai de treball',
            },
        }),
    } } as const;

return { changedFileEvidenceTranslations };
})();

const Domain_cliPathExposureTranslations = (() => {
const en = Shared_cliPathExposureTranslations.en;

const ca = {
    title: 'Línia d’ordres',
    footer: 'El Happier Desktop només afegeix o elimina les entrades del PATH que ha creat. Les entrades escrites per l’instal·lador de l’intèrpret d’ordres no es toquen.',
    addTitle: 'Afegeix happier al PATH',
    addSubtitle: 'Fes que l’ordre happier estigui disponible als terminals nous.',
    removeTitle: 'Treu happier del PATH',
    removeSubtitle: 'Només elimina les entrades del PATH que ha afegit el Happier Desktop.',
    working: 'S’està actualitzant el perfil de l’intèrpret d’ordres…',
    added: 'Afegit. Obre un terminal nou per fer servir happier.',
    alreadyPresent: 'happier ja és al teu PATH.',
    removed: 'S’han eliminat les entrades del PATH que havia afegit el Happier Desktop.',
    nothingToRemove: 'El Happier Desktop no ha afegit cap entrada al PATH.',
};

const cliPathExposureTranslations = { ca: ca };

return { cliPathExposureTranslations };
})();

const Domain_cliTrustPromptTranslations = (() => {
const en = Shared_cliTrustPromptTranslations.en;

const ca = {
    title: 'Voleu aprovar aquesta línia d’ordres?',
    body: ({ command }: { command: string }) => `El Happier no ha instal·lat la línia d’ordres a ${command}. Aprovar-la li permet llegir i escriure les sessions d’aquest compte. Aproveu només la que hi hàgiu posat vosaltres.`,
    bodyUnknownCommand: 'El Happier no ha instal·lat aquesta línia d’ordres. Aprovar-la li permet llegir i escriure les sessions d’aquest compte. Aproveu només la que hi hàgiu posat vosaltres.',
    approve: 'Aprova',
};

const cliTrustPromptTranslations = { ca: ca };

return { cliTrustPromptTranslations };
})();

const Domain_commitProposalTranslations = (() => {
type Count = Shared_commitProposalTranslations.Count;

type CommitProposalCopy = Shared_commitProposalTranslations.CommitProposalCopy;

const en = Shared_commitProposalTranslations.en;

const commitProposalTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', { commitProposal: CommitProposalCopy }>>, "ca"> = { ca: { commitProposal: {
        title: ({ count }) => (count === 1 ? 'Un commit per als teus canvis pendents' : `${count} commits per als teus canvis pendents`),
        titlePhone: ({ count }) => (count === 1 ? 'Un commit' : `${count} commits`),
        proposedBy: ({ who, committed, total }) => `Proposat per ${who} · ${committed} de ${total} fitxers · ordenats perquè cada commit parteixi de l’anterior.`,
        proposedByPhone: ({ committed, total }) => `${committed} de ${total} fitxers pendents · toca un canvi per moure’l.`,
        moveHint: ({ max }) => `Mou qualsevol canvi amb ⌥1–${max} o amb el seu menú.`,
        modelFallback: 'el model',
        regenerate: 'Torna a generar',
        conflict: 'La proposta ha canviat en un altre lloc. Aquesta és la darrera; torna a fer el canvi.',
        approvalPending: 'Esperant l’aprovació per crear aquests commits.',
        discardBody: 'La proposta s’elimina. Els teus canvis pendents es queden com estan.', askFix: ({ hook, number, message }) => `El hook ${hook} ha aturat el commit ${number}, «${message}». Arregla el que indica perquè el commit pugui passar:`, askFixGeneric: ({ number, message }) => `Un hook ha aturat el commit ${number}, «${message}». Arregla el que indica perquè el commit pugui passar:`, discarded: 'Proposta descartada.', undo: 'Desfés',
        fileCount: ({ count }) => (count === 1 ? '1 fitxer' : `${count} fitxers`),
        part: ({ count, of }) => `${count} de ${of} canvis`,
        move: { a11y: ({ file }) => `Mou ${file} a un altre commit`, title: ({ file }) => `Mou ${file} a`, newCommitAfter: ({ number }) => `Commit nou després del ${number}`, newCommitMessage: ({ file }) => `Actualitza ${file}`, leaveOut: 'Deixa’l fora d’aquests commits', leaveOutHint: 'Es queda al teu arbre de treball' },
        group: { a11y: ({ number, message }) => `Commit ${number}: ${message}`, editMessage: 'Edita el missatge', messageA11y: ({ number }) => `Missatge del commit ${number}`, more: 'Més', moveUp: 'Puja', moveDown: 'Baixa', mergeWithNext: 'Fusiona amb el commit següent', empty: 'Encara no té canvis. Mou-n’hi un o fusiona’l amb el següent.' },
        leftOut: { title: 'Deixats fora · es queden al teu arbre de treball', description: 'Aquests canvis queden pendents. Fes-ne un commit a part si ho volies.' },
        footer: { commits: ({ count }) => (count === 1 ? '1 commit' : `${count} commits`), onBranch: ({ branch }) => ` a ${branch} · els hooks i la signatura funcionen com en qualsevol commit`, detached: ' en un HEAD separat · els hooks i la signatura funcionen com en qualsevol commit', phone: 'Hooks i signatura com sempre', discard: 'Descarta la proposta', create: ({ count }) => (count === 1 ? 'Crea 1 commit' : `Crea ${count} commits`), createShort: ({ count }) => `Crea ${count}`, emptyGroupReason: 'Un commit no té canvis. Mou-n’hi un o fusiona’l.' },
        applying: { title: ({ count }) => (count === 1 ? 'Creant 1 commit' : `Creant ${count} commits`), body: 'Un per un pel camí de commit habitual, així els hooks i la signatura funcionen com sempre. L’edició s’atura fins que acabi.', bodyPhone: 'L’edició s’atura fins que acabi.', created: ({ landed, total }) => `${landed} de ${total}`, createdRest: ' creats · no es desfà res si un de posterior s’atura', createdRestPhone: ' creats', stopAfterThis: 'Atura després d’aquest commit', stopAfterThisShort: 'Atura després d’aquest', stopping: 'S’aturarà després d’aquest commit' },
        state: { waiting: 'En espera', writing: 'Executant hooks i creant el commit', landed: 'fet', landedAt: ({ time }) => `fet a les ${time}`, signed: 'signat', pausedBy: ({ hook, count }) => `${hook} ha canviat ${count} fitxer${count === 1 ? '' : 's'} · encara sense commit`, hookFailedBy: ({ hook }) => `${hook} ha fallat · sense commit`, rewritten: 'un hook ha reescrit el missatge', notCreated: 'No creat · encara pots editar-lo', notCreatedShort: 'No creat', unknown: 'Encara no confirmat', paused: ({ count }) => (count === 1 ? 'Un hook ha canviat 1 fitxer · encara sense commit' : `Un hook ha canviat ${count} fitxers · encara sense commit`), failed: 'Aturat aquí · sense commit' },
        outcome: { signingTitle: 'Ara mateix no es poden signar els teus commits.', signingBody: 'Aquest repositori signa cada commit. No s’ha fet cap commit.', signingHint: 'Primer desbloqueja l’agent GPG o SSH', tryAgain: 'Torna-ho a provar', cancel: 'Cancel·la', hookChanged: ({ files }) => `El hook ha canviat ${files}.`, waitsAfterLanded: ({ count }) => (count === 1 ? 'El commit 1 ja hi és; aquest t’espera.' : `${count} commits ja hi són; aquest t’espera.`), waits: 'Aquest t’espera.', include: 'Inclou els canvis del hook', includePhone: 'Inclou i fes commit', cancelCommit: 'Cancel·la aquest commit', hookFailed: 'Un hook ha aturat aquest commit.', hookChangedBy: ({ hook, files }) => `${hook} ha canviat ${files}.`, hookFailedBy: ({ hook }) => `${hook} ha aturat aquest commit.`, hookFailedBody: 'Els commits anteriors es queden. La resta encara els pots editar.', headMoved: ({ branch }) => `${branch} s’ha mogut mentre es feien els commits.`, headMovedBody: 'S’ha rebutjat el commit següent i no s’ha desfet res.', proposeAgain: 'Torna a proposar el que queda', keepEditing: 'Continua editant', askSessionToFix: 'Demana a la sessió que ho arregli', showInGit: 'Mostra a Git', unknownTitle: 'No hem pogut confirmar si aquest commit hi és.', unknownBody: 'No es torna a provar res fins que ho sapiguem. Torna a comprovar la branca.', checkAgain: 'Torna a comprovar', stoppedTitle: ({ landed, total }) => `${landed} de ${total} commits creats`, stoppedBody: ({ count }) => (count === 1 ? 'L’últim no s’ha creat. Els seus canvis segueixen al teu arbre de treball, com abans.' : `${count} no s’han creat. Els seus canvis segueixen al teu arbre de treball, com abans.`), createRest: ({ count }) => (count === 1 ? 'Crea l’últim' : `Crea els ${count} restants`), completeTitle: ({ count }) => (count === 1 ? '1 commit creat' : `${count} commits creats`), completeBody: 'No s’ha pujat res.', onBranch: ({ branch }) => `a ${branch}`, failed: { staging_conflict: 'Una altra cosa ha canviat el que hi ha preparat.', selection_conflict: 'Aquests canvis no es poden separar així.', source_changed: 'Els canvis pendents han canviat des de la proposta.', writer_failed: 'No s’ha pogut crear el commit.', publication_warning: 'El commit hi és, però els fitxers preparats no s’han actualitzat.', cancelled: 'S’ha cancel·lat aquest commit.' }, failedBody: 'Els commits anteriors es queden. No s’ha desfet res.' },
        none: { title: 'Encara no hi ha cap proposta de commits', reason: 'Una proposta agrupa els teus canvis pendents en commits que pots editar i després els crea un per un pel camí de commit habitual.', propose: 'Proposa commits', writing: 'Agrupant els teus canvis pendents…' },
        gitPane: { title: 'Commits proposats', meta: ({ count, files }) => `${count} · ${files} fitxers`, inCommit: ({ count, number }) => `${count} al commit ${number}`, open: 'Obre', review: 'Revisa', reviewInWalkthrough: 'Revisa al recorregut', more: 'Descarta o torna a generar', selectedHint: 'Seleccionat. Toca de nou per obrir-lo a Commits', tapHint: 'Toca per veure’n els canvis' },
    } } };

return { commitProposalTranslations };
})();

const Domain_committedMessageActionTranslations = (() => {
const committedMessageActionTranslations = { "ca": {
        "committedMessageActions": {
            "copy": "Copia",
            "fork": "Bifurca",
            "rollback": "Reverteix",
            "pin": "Fixa",
            "savePrompt": "Desa com a prompt",
            "plugins": "Accions dels connectors",
            "composerButton": "Botó de la biblioteca de prompts",
            "composerHint": "Els teus prompts i el que has enviat, al costat del dictat. El menú / continua oferint Prompts… si està desactivat.",
            "name": "Nom",
            "shortcut": "/ drecera",
            "savedOpen": "Desat a la biblioteca · Obre",
            "shortcutNotSaved": "El prompt s’ha desat, però la drecera no. Obre’l a la biblioteca per afegir-hi una drecera.",
            "wrongAccount": "Canvia al Home d’aquesta sessió abans de desar-ne el prompt.",
            "savedHintFavorite": "Es desa a la biblioteca, amb estrella.",
            "savedHint": "Es desa a la biblioteca.",
            "addShortcut": "Afegeix una drecera /",
            "shortcutPlaceholder": "/drecera",
            "savedToLibrary": "Desat a la biblioteca",
            "savePromptHint": "Reutilitza’l des de la biblioteca de prompts",
            "copyHint": "Copia el text d’un missatge.",
            "forkHint": "Comença una sessió nova des d’un missatge.",
            "rollbackHint": "Torna l’espai de treball a com era abans d’un missatge.",
            "pinHint": "Fixa missatges per tornar-hi. Els missatges fixats es mantenen.",
            "savePromptSettingHint": "Desa un missatge enviat com a prompt de la biblioteca.",
            "pluginsHint": "Accions que els connectors afegeixen sota els missatges."
        }
    } };

return { committedMessageActionTranslations };
})();

const Domain_computerUseTranslations = (() => {
type MachineParams = Shared_computerUseTranslations.MachineParams;

type ComputerUseTranslations = Shared_computerUseTranslations.ComputerUseTranslations;

const computerUseTranslations = { ca: {
        approval: {
            sectionTitle: 'A l’ordinador',
            act: {
                list: 'Veure quines finestres hi ha obertes',
                see: 'Fer una captura de pantalla',
                read: 'Llegir el text i els controls',
                click: 'Fer clic',
                press: 'Prémer una tecla',
                type: 'Escriure',
                share: 'Compartir una finestra',
            },
            windowOn: ({ machine }) => `Una finestra a ${machine}`,
            screenOf: ({ machine }) => `Tota la pantalla de ${machine}`,
            windowsOn: ({ machine }) => `Les finestres obertes a ${machine}`,
            window: 'Una finestra',
            screen: 'Tota la pantalla',
            windows: 'Les finestres obertes',
            typedLabel: 'Text',
            keyLabel: 'Tecla',
            listConsequence: 'Només es comparteixen els noms de les finestres obertes, no el seu contingut.',
            seeConsequence: 'Les captures es comparteixen amb aquesta sessió. Sense clics ni escriptura.',
            useConsequence: 'L’entrada que arriba a la màquina no es pot desfer. Ho pots aturar en qualsevol moment.',
            targetOn: ({ machine, target }) => `${target} a ${machine}`,
            chooseFirst: 'Primer tria la finestra',
            cropA11y: ({ target }) => `La darrera imatge de ${target}`,
            suggestsWindow: ({ agent, target }) => `${agent} suggereix «${target}»`,
        },
        request: {
            title: ({ agent, machine }) => `${agent} vol fer servir una finestra a ${machine}`,
            body: 'Tu tries la finestra. No es comparteix res fins que ho facis.',
            choose: 'Tria una finestra',
            change: 'Canvia la finestra',
            shared: ({ target }) => `Has compartit ${target}`,
            watch: 'Mira',
        },
        picker: {
            title: ({ agent }) => `Deixa que ${agent} faci servir una finestra`,
            description: ({ agent }) => `Tries què compartir amb ${agent}.`,
            windows: 'Finestres',
            screens: 'Tota la pantalla',
            untitledWindow: 'Finestra sense títol',
            screenLabel: ({ index }) => `Pantalla ${index}`,
            share: 'Comparteix la finestra',
            shareScreen: 'Comparteix la pantalla',
            shareApp: ({ app }) => `Compartir la finestra de ${app}`,
            stopSharing: 'Deixa de compartir',
            loadingTitle: ({ machine }) => `Cercant finestres a ${machine}`,
            noScreenTitle: ({ machine }) => `${machine} no té cap pantalla per compartir`,
            noScreenBody: 'Funciona sense un escriptori que Happier pugui veure. Fes servir una màquina amb pantalla.',
            unsupportedTitle: ({ machine }) => `Happier encara no pot fer servir la pantalla de ${machine}`,
            unsupportedBody: 'De moment, compartir una finestra funciona en escriptoris Linux.',
            failedTitle: ({ machine }) => `No s’han pogut llistar les finestres de ${machine}`,
            failedBody: 'Comprova que Happier s’hi executa i torna-ho a provar.',
            emptyTitle: ({ machine }) => `No hi ha cap finestra oberta a ${machine}`,
            emptyBody: 'Obre la finestra que vols compartir i torna-ho a comprovar.',
            tryAgain: 'Torna-ho a provar',
            inUse: 'Una altra sessió fa servir aquesta finestra. Tria’n una altra.',
            closed: 'Aquesta finestra s’ha tancat. Tria’n una altra.',
            selectFailed: 'No s’ha pogut compartir aquesta finestra. Torna-ho a provar.',
            otherMachineTitle: ({ machine }) => `${machine} no és la màquina d’aquesta sessió`,
            otherMachineBody: 'Només es poden compartir finestres a la màquina on s’executa aquesta sessió.',
            purpose: ({ session }) => `Per a «${session}».`,
            purposeIn: ({ project, session }) => `Per a «${session}» a ${project}.`,
            access: ({ agent }) => `${agent} pot`,
            accessValue: 'Veure-la i fer-la servir',
            accessSee: 'Veure-la',
            displayUnavailable: 'No es pot compartir tota la pantalla d’aquest ordinador.',
            policyBoth: ({ agent }) => `${agent} pregunta abans de cada captura, clic i tecla.`,
            policyInput: ({ agent }) => `${agent} pregunta abans de cada clic i tecla.`,
            policyCapture: ({ agent }) => `${agent} pregunta abans de cada captura.`,
            policyNone: ({ agent }) => `${agent} no pregunta abans de captures, clics ni tecles.`,
            policyChange: 'Canvia',
            suggests: ({ agent }) => `${agent} suggereix`,
        },
        permission: {
            title: ({ machine }) => `${machine} primer necessita el teu permís`,
            body: 'Happier només pot veure i fer servir finestres quan ho permets a la Configuració del Sistema, en aquell ordinador.',
            capture: 'Gravació de pantalla',
            captureHint: 'Per veure finestres',
            input: 'Accessibilitat',
            inputHint: 'Per fer clic i escriure',
            allowed: 'Permès',
            denied: 'No permès',
            unknown: 'Sense comprovar',
            open: ({ machine }) => `Obre la Configuració del Sistema a ${machine}`,
            opened: ({ machine }) => `S’ha obert a ${machine}. Permet-hi Happier i torna-ho a comprovar.`,
            openFailed: 'No s’ha pogut obrir la Configuració del Sistema. Obre-la en aquell ordinador.',
            checkAgain: 'Torna-ho a comprovar',
        },
        viewer: {
            agentUsing: ({ agent, target }) => `${agent} fa servir ${target}`,
            agentCanUse: ({ agent, target }) => `${agent} pot fer servir ${target}`,
            agentCanSee: ({ agent, target }) => `${agent} pot veure ${target}`,
            onMachine: ({ machine }) => `A ${machine}`,
            connectingTitle: ({ target }) => `Connectant amb ${target}`,
            connectingBody: ({ machine }) => `La finestra apareix aquí tan aviat com arriba la primera imatge de ${machine}.`,
            unavailableTitle: 'Ara no es pot mostrar aquesta finestra',
            unavailableBody: ({ agent }) => `Encara pots aturar ${agent} des d’aquí.`,
            endedTitle: ({ target }) => `${target} s’ha tancat`,
            endedBody: ({ agent }) => `${agent} ja no la pot veure ni fer servir. Tria una altra finestra per continuar.`,
            stalled: 'Es mostra la darrera imatge · reconnectant',
            inputA11y: ({ target }) => `${target}, en directe. Fes clic o escriu per prendre el control.`,
            notSharedTitle: 'No hi ha cap finestra compartida',
            notSharedBody: ({ agent }) => `Tria una finestra perquè ${agent} la faci servir.`,
            moreA11y: 'Opcions de la finestra',
            tabFallback: 'Ordinador',
        },
        strip: {
            using: ({ target }) => `Fent servir ${target}`,
            on: ({ machine }) => `a ${machine}`,
            stop: 'Atura',
            paused: ({ agent }) => `${agent} està en pausa`,
            pausedDetail: ({ target }) => `Tens el control de ${target}`,
        },
        tool: {
            capture: 'Ha fet una captura',
            captureRunning: 'Fent una captura',
            query: 'Ha llegit el text i els controls de la finestra',
            queryRunning: 'Llegint la finestra',
            click: 'Ha fet clic a la finestra',
            clickRunning: 'Fent clic a la finestra',
            clickTarget: ({ target }) => `Ha fet clic a «${target}»`,
            type: 'Ha escrit a la finestra',
            typeRunning: 'Escrivint a la finestra',
            typeTarget: ({ target }) => `Ha escrit a «${target}»`,
            pressKey: ({ key }) => `Ha premut ${key}`,
            press: 'Ha premut una tecla',
            pressRunning: 'Prement una tecla',
            mayHaveLanded: 'pot haver-se aplicat',
            failed: 'No s’ha completat',
        },
    } } satisfies Pick<Record<string, ComputerUseTranslations>, "ca">;

return { computerUseTranslations };
})();

const Domain_connectedServicesCollectionTranslations = (() => {
type ConnectedServicesCollectionCopy = Shared_connectedServicesCollectionTranslations.ConnectedServicesCollectionCopy;

const en = Shared_connectedServicesCollectionTranslations.en;

const ca: ConnectedServicesCollectionCopy = {
    accountLabel: ({ service }) => `Compte de ${service}`,
    meterResetsIn: ({ time }) => `d'aquí a ${time}`,
    meterNextResetIn: ({ time }) => `el proper d'aquí a ${time}`,
    meterResetsAt: ({ countdown, time }) => `${countdown} · ${time}`,
    meterNotReported: 'No informat',
    meterEstimated: ({ value }) => `~${value}`,
    indexTitle: 'Tots els serveis',
    indexDescription: 'Els comptes amb què inicien sessió els teus agents i quant els en queda.',
    viewList: 'Llista',
    viewGrid: 'Quadrícula',
    viewLabel: 'Mostra els comptes com a',
    refreshAll: 'Actualitza-ho tot',
    refreshUsage: 'Actualitza l’ús',
    signedOutConsequence: 'Les sessions no el poden fer servir fins que tornis a iniciar sessió.',
    poolsGroup: 'Grups',
    poolsDescription: 'Comptes entre els quals canvia un agent. El grup en tria un quan comença una sessió i en passa a un altre quan s’esgota.',
    newPool: 'Grup nou',
    poolUsing: ({ account }) => `Fa servir ${account}`,
    poolPosition: ({ position, count }) => position === 1 ? `Primer de ${count}` : `${position} de ${count}`,
    poolInUseNow: 'en ús ara',
    inUse: 'En ús',
    connectService: 'Connecta un servei',
    searchAccounts: 'Cerca comptes',
    servicesGroup: 'Serveis',
    railEmpty: 'Encara no hi ha comptes',
    railKey: 'clau',
    railAccountLabel: ({ service, account }) => `${service} · ${account}`,
    agentSignInTitle: 'Com inicien sessió els agents',
    subscriptionTitle: 'Subscripció',
    subscriptionNone: 'Sense subscripció',
    subscriptionRenewsIn: ({ days }) => days === 0 ? 'Es renova avui' : days === 1 ? 'Es renova demà' : `Es renova d’aquí a ${days} dies`,
    subscriptionEndsIn: ({ days }) => days === 0 ? 'No es renova · acaba avui' : `No es renova · acaba d’aquí a ${days} dies`,
    subscriptionPeriodEndsIn: ({ days }) => days === 0 ? 'El període acaba avui' : `El període acaba d’aquí a ${days} dies`,
    subscriptionRenewsOn: ({ date, days }) => `Es renova el ${date} · d’aquí a ${days} dies`,
    subscriptionEndsOn: ({ date, days }) => `No es renova · acaba el ${date}, d’aquí a ${days} dies. Aleshores les sessions el deixaran de fer servir.`,
    subscriptionPeriodEndsOn: ({ date, days }) => `El període acaba el ${date} · d’aquí a ${days} dies`,
    renewalOn: 'Activa',
    renewalOff: 'Desactivada',
    renewalUnknown: 'Desconegut',
    checkedAt: ({ time }) => `Comprovat ${time}`,
    checkedMayBeOutOfDate: ({ time }) => `Comprovat ${time} · pot estar desactualitzat`,
    usageCheckedMayBeOutOfDate: ({ time }) => `Comprovat ${time} · pot estar desactualitzat`,
    daysAgo: ({ count }) => count === 1 ? 'fa 1 dia' : `fa ${count} dies`,
    hoursAgo: ({ count }) => count === 1 ? 'fa 1 hora' : `fa ${count} hores`,
    usageResetsCount: ({ count }) => count === 1 ? '1 reinici d’ús' : `${count} reinicis d’ús`,
    usageResetsFirstExpires: ({ date }) => `el primer caduca ${date}`,
    usageResetExpires: ({ date }) => `caduca ${date}`,
    useOne: 'Fes-ne servir un',
    useOneReset: 'Fes servir un reinici d’ús',
    usageResetsTitle: 'Reinicis d’ús',
    usageResetsDescription: 'Cadascun comença una finestra nova al moment. Guarda’ls per quan un límit et bloquegi; els que no facis servir caduquen.',
    usageResetTitle: 'Reinici d’ús',
    usageResetExpiresOn: ({ date }) => `Caduca el ${date}`,
    use: 'Fes servir',
    usedByDefault: 'Per defecte · les sessions noves fan servir aquest compte',
    accountIdFact: ({ id }) => `ID ${id}`,
    hideIdentitiesTitle: 'Amaga els correus i identificadors dels comptes',
    hideIdentitiesDescription: 'Per a retransmissions i demostracions. Emmascara correus i identificadors a tot arreu en aquest dispositiu; els noms que has posat als comptes es mantenen.',
    privacyTitle: 'Privadesa',
    renameTitle: 'Posa nom a aquest compte',
    renameBody: ({ service }) => `Només canvia el nom a Happier. ${service} manté el seu propi nom per al compte.`,
    identityHidden: 'Correu o identificador amagat',
};

const connectedServicesCollectionTranslations = { ca };

return { connectedServicesCollectionTranslations };
})();

const Domain_connectedServicesPoolTranslations = (() => {
type ConnectedServicesPoolCopy = Shared_connectedServicesPoolTranslations.ConnectedServicesPoolCopy;

const en = Shared_connectedServicesPoolTranslations.en;

const ca: ConnectedServicesPoolCopy = {
    strategyExpiryFirst: "Caduca abans",
    strategyExpiryFirstDescription: "Prioritza una quota suficient amb un reinici del període llarg o un final de subscripció sense renovació més proper.",
    leadExpiryFirst: "Primer el que caduca abans.",
    membersOn: ({ service, on, total }) => `${service} · ${on} de ${total} membres actius`,
    rename: 'Canvia el nom',
    moreActions: 'Més accions',
    defaultFor: ({ agent }) => `Per defecte per a ${agent}`,
    defaultForMore: ({ agent, count }) => `Per defecte per a ${agent} +${count}`,
    makeDefault: 'Fes-lo per defecte',
    makeDefaultA11y: 'Fes-lo per defecte per a un agent',
    usingSince: ({ name, time }) => `S'utilitza ${name} des de les ${time}`,
    using: ({ name }) => `S'utilitza ${name}`,
    noActive: 'Encara no hi ha cap membre en ús',
    noActiveDetail: "El grup en tria un quan comença una sessió.",
    leadLeastLimited: 'Primer el menys limitat.',
    leadInOrder: 'En ordre.',
    fallbackOff: ({ name }) => `El canvi automàtic està desactivat; les sessions es queden a ${name} quan s'esgoti.`,
    manualStays: ({ name }) => `Manual: el grup es queda a ${name} fins que triïs un altre membre.`,
    switchTo: ({ name }) => `Canvia a ${name}`,
    onlyOneOn: ({ name }) => `Només ${name} està actiu, així que no hi ha alternativa.`,
    turnOn: ({ name }) => `Activa ${name}`,
    allWaitingTitle: 'Tots els membres esperen un reinici',
    allWaitingFirst: ({ name, time, countdown }) => `${name} es reinicia primer, a les ${time} (${countdown}).`,
    sessionsWait: 'Les sessions esperen i després es reprenen soles.',
    sessionsStop: 'Les sessions s\'aturen fins que un membre tingui marge.',
    leftTitle: 'Disponible al grup',
    leftDescription: 'La mitjana dels membres actius; cadascun es reinicia pel seu compte.',
    roomCount: ({ count, total }) => `${count} de ${total} tenen marge ara`,
    notReported: ({ count }) => count === 1 ? '1 sense dades' : `${count} sense dades`,
    nothingReported: 'Cap membre actiu informa encara dels seus límits.',
    membersTitle: 'Membres',
    membersDescription: "Arrossega per definir l'ordre. El membre seleccionat és l'actiu; un membre desactivat s'omet.",
    membersCompactDescription: 'Mantén premut i arrossega per reordenar.',
    manage: 'Gestiona',
    connectAnotherAccount: ({ service }) => `Connecta un altre compte de ${service}`,
    membersSelectionSummary: ({ count, total, service }) => `${count} de ${total} comptes de ${service}`,
    manageMembers: 'Gestiona els membres',
    searchAccounts: ({ service }) => `Cerca comptes de ${service}`,
    active: 'Actiu',
    offNotUsed: 'El grup no el fa servir mentre està desactivat',
    autoOffModel: 'Desactivat automàticament · aquest pla no pot usar el model seleccionat',
    checkedAt: ({ time }) => `Comprovat ${time}`,
    makeActiveA11y: ({ name }) => `Fes que ${name} sigui el membre actiu`,
    memberOnA11y: ({ name }) => `Utilitza ${name} en aquest grup`,
    openA11y: ({ name }) => `Obre ${name}`,
    dragA11y: 'Arrossega per reordenar',
    behaviorTitle: 'Comportament',
    strategyTitle: 'Estratègia de selecció',
    strategyLeastLimited: 'Menys limitat',
    strategyInOrder: 'En ordre',
    strategyManual: 'Manual',
    strategyLeastLimitedDescription: 'Prefereix el membre amb més quota utilitzable.',
    strategyInOrderDescription: "Prova els membres en l'ordre de dalt.",
    strategyManualDescription: 'Utilitza només el membre actiu fins que el canviïs.',
    fallbackTitle: 'Canvi automàtic',
    fallbackDescription: "Canvia a un altre membre quan el compte actiu necessiti recuperar-se.",
    switchEarlyTitle: "Canvia abans d'hora",
    switchEarlyDescription: 'Percentatge restant per sota del qual el grup passa a un membre amb quota més fresca. 0 ho desactiva.',
    autoResetsTitle: 'Usa automàticament els reinicis de quota',
    autoResetsDescription: 'Gasta un reinici guardat només quan cap membre estigui llest.',
    autoOffTitle: 'Desactiva els comptes que no poden usar el model seleccionat',
    autoOffDescription: 'Els pots tornar a activar tu mateix.',
    advancedTitle: 'Avançat',
    advancedCount: ({ count }) => `${count} opcions`,
    restoreFirstTitle: 'Torna al primer membre quan es reiniciï',
    restoreFirstDescription: 'Després d\'un canvi, torna al primer membre de la llista quan es reiniciï el seu límit.',
    switchWhenTitle: 'Canvia quan',
    switchWhenDescription: 'Esdeveniments que fan passar el grup al membre següent.',
    staleAfterTitle: "Comprova l'ús antic després de",
    staleAfterDescription: "Minuts. Torna a preguntar al proveïdor quan l'ús és més antic que això abans de triar un membre.",
    switchesPerTurnTitle: 'Canvis automàtics per torn',
    switchesPerHourTitle: 'Canvis automàtics per hora de sessió',
    switchLimitsDescription: 'Evita que el grup salti entre membres.',
    recoveryTitle: 'Quan un límit atura una sessió',
    recoveryDescription: 'Què fa el grup per la sessió que espera.',
    recoveryPromptsTitle: 'Missatges de represa',
    recoveryPromptsDescription: "Happier envia el seu missatge estàndard quan reprèn una sessió després d'un canvi o un reinici.",
    usedByTitle: 'Utilitzat per',
    usedByDefault: 'Per defecte · les sessions noves inicien sessió amb aquest grup',
    usedByNone: 'Encara cap agent inicia sessió amb aquest grup per defecte.',
    deleteNote: ({ agents }) => `Els membres continuen connectats. ${agents} torna al seu propi inici de sessió fins que triïs un altre valor per defecte.`,
    deleteNoteNoAgent: 'Els membres continuen connectats.',
    emptyTitle: 'Afegeix els comptes entre els quals canviar',
    emptyReason: ({ service }) => `Un grup tria un compte quan comença una sessió i en canvia quan s'esgota. Afegeix almenys dos comptes de ${service}.`,
    usageNotAnswering: ({ service }) => `${service} no ha respost`,
    newPoolTitle: 'Grup nou',
    newPoolDescription: ({ service }) => `Comptes de ${service} entre els quals canvia un agent.`,
    nameTitle: 'Nom',
    namePlaceholder: 'Grup de feina',
    draftMembersDescription: 'Tria els comptes entre els quals canviar. Els pots canviar més tard.',
    create: 'Crea el grup',
    discard: 'Descarta',
};

const connectedServicesPoolTranslations = { ca };

return { connectedServicesPoolTranslations };
})();

const Domain_connectedServicesSettingsTranslations = (() => {
type ConnectedServicesSettingsCopy = Shared_connectedServicesSettingsTranslations.ConnectedServicesSettingsCopy;

const setupFidelityCopy = Shared_connectedServicesSettingsTranslations.setupFidelityCopy;

const en = Shared_connectedServicesSettingsTranslations.en;

const ca: ConnectedServicesSettingsCopy = {
    ...setupFidelityCopy,
    accountCount: ({ count }) => count === 1 ? '1 compte' : `${count} comptes`,
    defaultAccount: ({ name }) => `Per defecte: ${name}`,
    poolCount: ({ count }) => count === 1 ? '1 grup' : `${count} grups`,
    noAccountsYet: 'Encara no hi ha comptes',
    needsSignIn: 'Cal iniciar sessió',
    signInAgain: 'Torna a iniciar sessió',
    addAccount: 'Afegeix un compte',
    connectAnotherTitle: 'Connecta un altre servei',
    connectFirstTitle: 'Connecta un servei',
    connectNames: ({ names }) => `${names}.`,
    connectNamesMore: ({ names, count }) => `${names} i ${count} més.`,
    connect: 'Connecta',
    emptyTitle: 'Encara no hi ha serveis per connectar',
    servicesTitle: 'Serveis',
    emptyNoServiceOnMachine: ({ machine }: { machine: string }) => `Cap agent de ${machine} encara no ofereix cap servei per iniciar sessió. Els agents que fan servir una subscripció hi afegeixen el seu.`,
    emptyNoMachineOnline: 'Cap de les teves màquines està en línia. Els serveis apareixen quan n\'hi ha una, a partir dels agents que executa.',
    emptyOpenAgents: 'Obre els agents',
    emptyAction: 'Obre les màquines',
    projectionErrorTitle: "No s'han pogut carregar els serveis de les teves màquines",
    projectionErrorDescription: 'Els teus comptes continuen a la llista. Els serveis que pots afegir apareixen quan una màquina respon.',
    loadingServices: 'Cercant serveis a les teves màquines…',
    usageTitle: 'Com es fan servir els comptes',
    usageDescription: 'Amb quin compte inicia sessió cada agent quan comença una sessió, i què comparteixen les sessions.',
    sharingTitle: "Compartició d'estat",
    sharingSummary: ({ config, state }) => `${config} · ${state}`,
    configLinkedShort: 'Enllaçada',
    configCopiedShort: 'Copiada',
    configIsolatedShort: 'Aïllada',
    stateSharedShort: 'Sessions compartides',
    stateIsolatedShort: 'Sessions separades',
    perAgentTitle: 'Compartició per agent',
    perAgentDescription: 'Substitueix aquests valors per a un agent.',
    perAgentPurpose: 'Tria, per a cada agent, què comparteixen les sessions de comptes connectats amb el teu propi inici de sessió.',
    servicePurpose: ({ service }) => `Els comptes amb què inicies sessió a ${service} i els grups que els comparteixen.`,
    chooseMachineTitle: 'Tria una màquina',
    chooseMachineDescription: "Afegir, iniciar sessió i eliminar comptes es fa en una de les teves màquines. Els teus comptes continuen llistats a Serveis connectats.",
    newAccountTitle: 'Compte nou',
    newAccountDescription: 'Tria com vols iniciar sessió.',
    newAccountInProgress: 'Acaba d’iniciar sessió a continuació.',
    modeBrowser: 'Inicia sessió amb un navegador',
    modeDeviceCode: 'Inicia sessió amb un codi',
    modeManual: 'Introdueix un testimoni',
    serviceSettingsTitle: 'Configuració del servei',
    serviceSettingsDescription: 'Configuració amb què inicien sessió tots els comptes d’aquest servei.',
    noAccountsDescription: 'Afegeix un compte perquè els teus agents hi puguin iniciar sessió.',
    accountDetailsTitle: 'Detalls del compte',
    poolEmptyTitle: 'Afegeix comptes a aquest grup',
    poolEmptyDescription: 'Un grup passa les sessions al compte següent quan un arriba al límit. Tria\'n els comptes a continuació.',
    agentDefaultsTitle: 'Compte per defecte de cada agent',
    agentDefaultsDescription: 'El compte amb què inicia sessió cada agent quan comença una sessió.',
    agentDefaultsKeywords: 'compte per defecte',
    namesAnd: ({ names, last }) => `${names} i ${last}`,
    usedBy: ({ names }) => `L’utilitzen ${names}`,
    poolRuleMostLeft: 'fa servir el que en té més',
    poolRuleInOrder: 'els fa servir en ordre',
    poolRuleManual: 'el canvies tu',
    poolInUse: ({ pool }) => `${pool} · en ús`,
    agentDefault: ({ agent }) => `Predeterminat de ${agent}`,
    signedOutBy: ({ service }) => `${service} ha tancat la sessió`,
    usageReadFailed: 'No s’ha pogut llegir l’ús',
    usageWindowPin: ({ meter }: { meter: string }) => `Mostra ${meter} al costat del compositor`,
    noLimitsBilledPerUse: 'Sense límits informats · es factura per ús',
    needsYouCount: ({ count }) => count === 1 ? '1 et necessita' : `${count} et necessiten`,
    connectToolsTitle: 'Connecta un allotjament de codi o una eina',
    inviteTitle: ({ names }) => `Els teus agents també poden fer servir ${names}`,
    inviteWhoOne: ({ agents }) => `${agents} hi pot iniciar sessió.`,
    inviteWhoMany: ({ agents }) => `${agents} hi poden iniciar sessió.`,
    inviteTools: 'O connecta un allotjament de codi i eines.',
    firstRunTitle: 'Fes servir els plans que ja pagues',
    firstRunPromise: 'Connecta el teu compte de Claude o ChatGPT una sola vegada. Els teus agents el fan servir a totes les màquines i Happier et mostra quant et queda abans d’arribar al límit.',
    connectAnAccount: 'Connecta un compte',
    firstRunMeanwhile: 'Mentrestant, cada agent fa servir el seu propi inici de sessió a cada màquina.',
    agentAccountsTitle: 'Comptes dels agents',
    agentAccountsDescription: 'Subscripcions i claus que fan servir els teus agents. Es desen al teu compte perquè totes les màquines les puguin fer servir.',
    codeAndToolsTitle: 'Codi i eines',
    setupChooseMachine: 'Tria una màquina on iniciar la sessió. Després el compte funciona a totes les teves màquines.',
    setupHowToSignIn: 'Com iniciar la sessió',
    setupRecommendedMethod: ({ method }) => `${method} · Recomanat`,
    setupCatalogTitle: 'Connecta un servei',
    setupCatalogPurpose: 'L’inici de sessió s’executa a la màquina que triïs. Després el compte funciona a totes les teves màquines.',
    setupServiceTitle: ({ service }) => `Connecta ${service}`,
    setupReconnectTitle: ({ service }) => `Torna a iniciar la sessió a ${service}`,
    setupServicePurpose: ({ agents, service }) => `${agents} faran servir el teu compte de ${service} a totes les màquines.`,
    setupServicePurposeNoAgents: 'El compte funciona a totes les màquines.',
    setupForYourAgents: 'Per als teus agents',
    setupOwnLoginTitle: 'Ja has iniciat la sessió en una màquina?',
    setupOwnLoginBody: 'Continua fent servir l’inici de sessió propi de l’agent. Tria’l a Com es fan servir els comptes.',
    setupToolsTitle: 'Allotjaments de codi i eines',
    setupProvidersPointer: 'Els proveïdors de models com OpenRouter i Ollama es configuren a Proveïdors.',
    setupOpenProviders: 'Obre Proveïdors',
    setupTrust: 'Es desa al teu compte i només el fan servir les teves màquines. Happier manté la sessió activa per tu.',
    setupConnectedCount: ({ count }) => `${count} connectats`,
    settleConnectedAs: ({ identity }) => `Connectat ara mateix com a ${identity}.`,
    settleConnected: 'Connectat ara mateix.',
    settleUseFor: ({ agent }) => `El vols fer servir per a ${agent}?`,
    settleUseForAction: ({ agent }) => `Fes-lo servir per a ${agent}`,
    notNow: 'Ara no',
    homeInvitePromise: 'Connecta Claude o ChatGPT una sola vegada. Totes les màquines el poden fer servir i aquí veuràs quant et queda.',
    homeInviteHide: 'Amaga',
    homeNextWho: ({ agents }) => `${agents} també el pot fer servir`,
    oauthStepOpen: 'Obre la pàgina d’inici de sessió al navegador',
    oauthStepApprove: 'Aprova-ho i copia el codi que mostra la pàgina (o l’adreça on arribis)',
    oauthStepPaste: 'Enganxa’l aquí',
    oauthPastePlaceholder: 'Enganxa el codi o l’adreça',
    oauthShapeOk: 'Sembla un codi d’inici de sessió',
    deviceEnterAt: ({ where }) => `Introdueix aquest codi a ${where}`,
    deviceExpired: 'El codi ha caducat. No s’ha desat res.',
    deviceExpiresIn: ({ time }) => `El codi caduca d’aquí a ${time}`,
    deviceNewCode: 'Obtén un codi nou',
    detailSignedOutTitle: ({ service }) => `${service} ha tancat la sessió d’aquest compte`,
    detailSignedOutBody: 'L’inici de sessió s’ha revocat o ha canviat, per exemple després d’un canvi de contrasenya. Les sessions no poden fer servir aquest compte fins que hi tornis a iniciar la sessió.',
    detailSignInTitle: 'Inici de sessió',
    detailSignInNeeded: 'Cal tornar a iniciar la sessió',
    detailSignInKeptFresh: 'Happier la manté activa',
    detailLastUsed: ({ time }) => `últim ús ${time}`,
    detailLeavePool: ({ pool }) => `Treu-lo de ${pool}…`,
    detailRemovePooledNote: ({ pool }) => `${pool} fa servir aquest compte; primer treu-lo del conjunt. Suprimir-lo l’esborra del teu compte i de totes les màquines.`,
    detailUsageSignedOut: 'Últim valor conegut · no es pot actualitzar sense sessió',
    detailUsageSignedOutAt: ({ time }: { time: string }) => `Últim valor conegut a les ${time} · no es pot actualitzar sense sessió`,
    detailResetsIn: ({ countdown }) => `d’aquí a ${countdown}`,
    detailUsedByTitle: 'El fan servir',
    detailUsedByDefault: 'El seu compte predeterminat',
    detailUsedByPool: ({ pool }) => `A través de ${pool}`,
    detailUsedByPoolInUse: ({ pool }) => `A través de ${pool} · en ús ara`,
    detailUsedByCould: 'El poden fer servir · avui inicien la sessió pel seu compte',
    detailWorksOnTitle: 'Funciona a',
    detailWorksOnDescription: 'Desat al teu compte. Una màquina el fa servir quan hi comença una sessió; no es copia res per endavant.',
    detailSignedInWithCode: 'Sessió iniciada amb un codi',
    detailSignedInWithBrowser: 'Sessió iniciada amb un navegador',
    detailAddedWithKey: 'Afegit amb una clau',
    nearLimitTitle: ({ account, percent, window }) => `A ${account} li queda un ${percent}% del límit de ${window}`,
    nearLimitTitleNoAccount: ({ percent, window }) => `Queda un ${percent}% del límit de ${window}`,
    nearLimitBodyWithReset: ({ time }) => `Es restableix a les ${time}. Aplica un restabliment d’ús per continuar ara.`,
    nearLimitBody: 'Aplica un restabliment d’ús per continuar ara.',
    nearLimitApplyReset: 'Aplica un restabliment',
    catalogSignInBrowserOrCode: 'Inicia sessió amb un navegador o un codi',
    catalogSignInBrowserOrKey: 'Inicia sessió amb un navegador o enganxa un testimoni',
    catalogSignInBrowser: 'Inicia sessió amb un navegador',
    catalogSignInCode: 'Inicia sessió amb un codi',
    catalogPasteKey: 'Enganxa una clau',
    deviceOpenService: ({ service }) => `Obre ${service}`,
    deviceWaitingFor: ({ service }) => `Esperant que ho aprovis a ${service}…`,
};

const connectedServicesSettingsTranslations = { ca };

return { connectedServicesSettingsTranslations };
})();

const Domain_connectedServicesSetupTranslations = (() => {
type ConnectedServicesSetupTranslation = Shared_connectedServicesSetupTranslations.ConnectedServicesSetupTranslation;

const connectedServicesSetupTranslations = { ca: {
        connectMoreTitle: 'Connecta’n més',
        connectMoreDescription: 'Serveis que accepten els agents de les teves màquines i que encara no has connectat.',
        connectMoreNothingNew: 'Afegeix un altre compte, un allotjament de codi o una eina.',
        serviceSignInInstead: ({ agents }) => `${agents} hi pot iniciar sessió en lloc de l’inici de sessió de cada màquina.`,
        serviceCanUse: ({ agents }) => `${agents} el pot fer servir.`,
        moreServicesTitle: 'Més serveis',
        moreServicesTools: ({ names }) => `${names} i més, per al codi i les eines.`,
        moreServicesAll: 'Tot el que accepten els teus agents i eines.',
        browse: 'Explora',
        notNow: ({ service }) => `Ara no: ${service}`,
        notNowTooltip: 'Ara no · continua a Explora',
        back: 'Tots els serveis',
        homeCatalogTitle: 'Connecta un compte',
        homeCatalogPurpose: 'Els teus agents el fan servir a totes les màquines i Home mostra quant en queda.',
        homeNextSubtitle: ({ agents }) => `${agents} el pot fer servir en lloc de l’inici de sessió de cada màquina.`,
        firstRunMore: 'Claus d’API, allotjaments de codi i eines',
        settleAddToPoolWhy: ({ pool, agent, active }) => `L’afegeixes a ${pool}, perquè ${agent} hi passi quan s’esgoti ${active}?`,
        settleAddToPoolShort: ({ pool }) => `L’afegeixes a ${pool}?`,
        settleAddToPool: ({ pool }) => `Afegeix a ${pool}`,
        deviceStepCopy: 'Copia aquest codi',
        deviceStepOpen: ({ service }) => `Obre ${service} i introdueix-lo`,
        deviceStepOpenWhere: ({ where }) => `${where}, amb la sessió iniciada al compte que vols fer servir`,
        deviceStepApprove: ({ service }) => `Aprova Happier a ${service}`,
        deviceCheckNow: 'Comprova-ho ara',
    } } satisfies Pick<Readonly<Record<string, ConnectedServicesSetupTranslation>>, "ca">;

return { connectedServicesSetupTranslations };
})();

const Domain_detailPageTranslations = (() => {
type DetailPageTranslations = Shared_detailPageTranslations.DetailPageTranslations;

const detailPageTranslations = { ca: {
        approval: {
            requestTitle: 'Sol·licitud',
            requestDescription: 'Què s’ha demanat i en quin estat està.',
            failureTitle: 'Per què ha fallat',
            homeUnavailableTitle: 'Home no disponible',
            contextTitle: 'Sol·licitat per',
            contextDescription: 'La sessió i l’agent que ho han demanat.',
            proposalsDescription: 'Es publiquen a la revisió si ho aproves.',
        },
        runs: {
            description: 'Execucions en segon pla a les teves màquines.',
            filterLabel: 'Execucions que es mostren',
            filterRunning: 'En curs',
            filterAll: 'Totes',
            onHome: ({ home }) => `A ${home}`,
        },
        person: {
            placeholderTitle: 'Persona',
            friendshipTitle: 'Amistat',
            sharedSessionsDescription: 'Sessions que aquest amic comparteix amb tu, només lectura.',
            linkedAccountsTitle: 'Comptes vinculats',
            linkedAccountsDescription: 'On més inicia sessió. S’obre al navegador.',
        },
        friendsManage: {
            description: 'Les persones amb qui treballes a Happier i les sol·licituds entre vosaltres.',
            requestsTitle: 'Sol·licituds d’amistat',
            requestsDescription: 'Obre una sol·licitud per acceptar-la o rebutjar-la.',
            sentTitle: 'Sol·licituds enviades',
            sentDescription: 'Esperant que acceptin.',
            friendsTitle: 'Amics',
            friendsDescription: 'Obre un amic per veure què comparteix amb tu.',
        },
    } } as const satisfies Pick<Record<string, DetailPageTranslations>, "ca">;

return { detailPageTranslations };
})();

const Domain_detailsChromeTranslations = (() => {
type DetailsChromeTranslations = Shared_detailsChromeTranslations.DetailsChromeTranslations;

const detailsChromeTranslations = { ca: {
        closeUnsavedTabA11y: 'Tanca la pestanya, té canvis sense desar',
        emptyTitle: 'Els fitxers, canvis i commits s’obren aquí',
        browseFiles: 'Explora els fitxers',
        previewHint: 'Un clic obre una previsualització; torna a obrir-la per conservar-la.',
        emptyReason: 'Els fitxers, canvis i commits que obris apareixen aquí, al costat d’on els has obert.',
        reviewChanges: ({ count }) => (count === 1 ? 'Revisa 1 canvi' : `Revisa ${count} canvis`),
        reviewChangesReason: ({ count }) => (count === 1
            ? 'Ha canviat 1 fitxer en aquesta sessió. Llegeix-lo aquí sense sortir de la conversa.'
            : `Han canviat ${count} fitxers en aquesta sessió. Llegeix-los aquí sense sortir de la conversa.`),
        splitNeedsWiderPane: 'La vista en paral·lel necessita un panell més ample. Amplia Detalls o fes servir Focus.',
    } } satisfies Pick<Record<string, DetailsChromeTranslations>, "ca">;

return { detailsChromeTranslations };
})();

const Domain_detailsFileTranslations = (() => {
type DetailsFileTranslations = Shared_detailsFileTranslations.DetailsFileTranslations;

const detailsFileTranslations = { ca: {
        areaUnstaged: 'Sense preparar',
        areaStaged: 'Preparats',
        areaBoth: 'Tots dos',
        areaLabel: 'Canvis',
        preview: 'Previsualització',
        viewLabel: 'Vista',
        compare: 'Compara',
        stage: 'Prepara',
        unstage: 'Treu de la preparació',
        addToCommit: 'Afegeix al commit',
        removeFromCommit: 'Treu del commit',
        editing: 'Editant',
        editingUnsaved: 'Editant · canvis sense desar',
        statusModified: 'Modificat',
        statusAdded: 'Afegit',
        statusDeleted: 'Eliminat',
        statusRenamed: 'Canviat de nom',
        statusCopied: 'Copiat',
        statusUntracked: 'Nou, encara sense seguiment',
        statusConflicted: 'Té conflictes',
        noChanges: 'Sense canvis',
        lines: ({ count }) => (count === 1 ? '1 línia' : `${count} línies`),
    } } satisfies Pick<Record<string, DetailsFileTranslations>, "ca">;

return { detailsFileTranslations };
})();

const Domain_detailsHistoryTranslations = (() => {
type Count = Shared_detailsHistoryTranslations.Count;

type Branch = Shared_detailsHistoryTranslations.Branch;

type Folder = Shared_detailsHistoryTranslations.Folder;

type DetailsHistoryTranslations = Shared_detailsHistoryTranslations.DetailsHistoryTranslations;

const detailsHistoryTranslations = { ca: {
        copyCommitSha: 'Copia el SHA del commit',
        filesChanged: ({ count }) => (count === 1 ? '1 fitxer canviat' : `${count} fitxers canviats`),
        files: ({ count }) => (count === 1 ? '1 fitxer' : `${count} fitxers`),
        revertEllipsis: 'Reverteix…',
        stashKeptOn: ({ branch }) => `Desat a ${branch}`,
        stashOriginBranch: ({ branch }) => `Desat quan vas sortir de ${branch}`,
        stashOriginBranchShort: 'Quan vas canviar de branca',
        stashOriginTransient: 'Desat per Happier',
        stashOriginUnmanaged: 'Fet fora de Happier',
        stashRestoreExplains: ({ folder }) => `En restaurar, aquests canvis tornen a ${folder} i el stash s’elimina. No canvia res més a la carpeta.`,
        stashApply: 'Aplica',
        stashApplyA11y: 'Aplica aquests canvis i conserva el stash',
        stashDiscardEllipsis: 'Descarta…',
        stashSwitcherA11y: 'Tria un stash',
        stashCount: ({ count }) => (count === 1 ? '1 stash' : `${count} stashes`),
    } } satisfies Pick<Record<string, DetailsHistoryTranslations>, "ca">;

return { detailsHistoryTranslations };
})();

const Domain_detailsReviewTranslations = (() => {
type Count = Shared_detailsReviewTranslations.Count;

type DetailsReviewTranslations = Shared_detailsReviewTranslations.DetailsReviewTranslations;

const detailsReviewTranslations = { ca: {
        title: 'Revisió',
        files: ({ count }) => (count === 1 ? `1 fitxer` : `${count} fitxers`),
        nextCommit: ({ count }) => `${count} al proper commit`,
        changedFiles: 'Fitxers canviats',
        commitColumn: 'Commit',
        jumpA11y: 'Salta a un fitxer',
        comments: ({ count }) => (count === 1 ? `1 comentari` : `${count} comentaris`),
        goesWithNext: ({ count }) => (count === 1 ? `va amb el teu proper missatge` : `van amb el teu proper missatge`),
        askForChanges: 'Demana canvis',
        detachCommentA11y: 'Deixa aquest comentari fora del proper missatge',
        trayExpandedHint: 'Van amb el teu proper missatge a l’agent.',
        askPlaceholder: 'Digues a l’agent què ha de canviar…',
        send: 'Envia',
        draftAuthor: 'Tu', draftStatus: 'esborrany', includeComment: 'Va amb el teu proper missatge',
    } } satisfies Pick<Record<string, DetailsReviewTranslations>, "ca">;

return { detailsReviewTranslations };
})();

const Domain_embedSettingsTranslations = (() => {
const english = Shared_embedSettingsTranslations.english;

const translated = Shared_embedSettingsTranslations.translated;

const embedSettingsTranslations = { ca: translated({
        settingsEmbeds: {
            title: "Incrustacions",
            newTitle: "Nova incrustació",
            purpose: "Deixa que altres aplicacions mostrin xats de Happier, només amb l’accés que triïs.",
            yourEmbeds: "Les teves incrustacions",
            newEmbed: "Nova incrustació",
            listError: "No s’han pogut carregar les incrustacions",
            emptyTitle: "Posa un xat de Happier dins la teva aplicació",
            emptyBody: "La teva aplicació mostra converses reals, només amb l’accés que triïs: quins llocs, qui pot enviar o aprovar i quins models.",
            createDescription: "Tria què poden fer altres aplicacions amb els teus xats i com es veuen.",
            name: "Nom",
            nameDescription: "Només el veus tu, en aquesta llista.",
            namePlaceholder: "Per exemple, tauler de contactes",
            create: "Crea la incrustació",
            summary: {
                sites: ({ count }: { count: number }) => count === 1 ? '1 lloc' : `${count} llocs`,
                send: "Pot enviar",
                sendAndApprove: "Pot enviar i aprovar",
                viewOnly: "Només lectura",
                modelOnly: ({ name }: { name: string }) => `només ${name}`,
                models: ({ count }: { count: number }) => count === 1 ? '1 model' : `${count} models`,
            },
            sites: {
                title: "On pot aparèixer",
                description: "Els xats només s’obren en aquests llocs.",
            },
            capabilities: {
                title: "Què pot fer la gent",
                view: "Veure la conversa",
                always: "Sempre",
                send: "Enviar missatges",
                sendDescription: "Inclou aturar l’agent i adjuntar fitxers.",
                changeModel: "Canviar de model",
                permissionModes: "Modes de permís",
                permissionModesDescription: "Els xats només mostren un selector de mode si es permet més d’un mode.",
                anyMode: "Qualsevol mode",
                anyModeDescription: "La gent pot canviar quant fa l’agent sense demanar permís.",
                modeOnly: ({ name }: { name: string }) => `només ${name}`,
                modes: ({ count }: { count: number }) => `${count} modes`,
                approveOn: "La gent d’aquests llocs pot aprovar l’ús d’eines i les sol·licituds en aquests xats.",
            },
            models: {
                title: "Models",
                description: "Els altres models es rebutgen, no només s’amaguen. Els xats comencen amb el primer model permès.",
                allowed: "Models permesos",
                any: "Qualsevol model",
            },
            organization: {
                title: "Organització",
                description: "La teva aplicació llista des d’aquí els xats d’aquesta incrustació (amb qualsevol d’aquestes etiquetes). Els xats nous també arriben aquí.",
                folder: "Carpeta",
                tags: "Etiquetes",
                none: "Cap",
            },
            composer: {
                title: "Redacció",
                attachments: "Adjunts",
                attachmentsDescription: "Amaga el botó d’adjuntar. Qui pot enviar encara pot adjuntar fitxers per l’API.",
            },
            sessions: {
                title: "Sessions",
                description: "Les sessions que crea aquesta clau, des del teu servidor o el xat, s’executen en aquest ordinador amb aquest agent i arriben a la carpeta i les etiquetes de dalt.",
                allow: "Permet que aquesta clau creï sessions",
                offConsequence: "Aquesta clau no pot crear sessions. La teva aplicació només pot mostrar xats existents.",
                computer: "Ordinador",
                agent: "Agent",
                newChat: "Començar xats nous a la incrustació",
                appSetting: "Per a la teva aplicació",
                newChatDescription: "Mostra un quadre de xat nou quan la teva aplicació obre la incrustació sense xat. És un ajust per a la teva aplicació, no un límit de seguretat: el teu servidor sempre pot crear xats amb aquesta clau.",
            },
            appearance: {
                title: "Aparença",
                description: "La previsualització segueix cada canvi. Els xats oberts s’actualitzen sense recarregar.",
                mode: "Mode",
                modeSystem: "Sistema",
                modeLight: "Clar",
                modeDark: "Fosc",
                theme: "Tema",
                presetHappier: "Happier",
                colors: "Colors",
                colorsDefault: "Colors de Happier",
                colorsCustomized: ({ count }: { count: number }) => count === 1 ? '1 personalitzat' : `${count} personalitzats`,
                colorsFor: "Colors per a",
                colorGroups: {
                    surface: "Superfícies",
                    text: "Text",
                    accent: "Accent",
                    messages: "Missatges",
                    composer: "Redacció",
                    approvals: "Aprovacions",
                },
                fontFamily: "Tipus de lletra",
                fontFamilyPlaceholder: "Tipus de Happier",
                fontFile: "Fitxer de lletra",
                fontFileDescription: "Un enllaç https a un fitxer .woff2 o .woff.",
                fontFileRefused: "Fes servir un enllaç a un fitxer .woff2 o .woff, no un full d’estils.",
                textSize: "Mida del text",
                textSizeCompact: "Compacta",
                textSizeDefault: "Per defecte",
                textSizeLarge: "Gran",
                corners: "Cantonades",
                cornersSharp: "Rectes",
                cornersSoft: "Suaus",
                cornersRound: "Rodones",
                density: "Densitat",
                densityCompact: "Compacta",
                densityComfortable: "Còmoda",
                reset: "Restableix l’aparença",
            },
            preview: {
                title: "Previsualització en directe",
                phone: "Telèfon",
                desktop: "Escriptori",
                reduceMotion: "Redueix el moviment",
                note: "El xat incrustat real amb missatges d’exemple. Aquí no s’envia res.",
                rowDescription: "Mira el xat amb aquests ajustos.",
                unavailable: "Previsualització no disponible",
            },
            snippets: {
                title: "Fragments de codi",
                description: "Enganxa’ls a la teva aplicació. Ja fan servir els ajustos d’aquesta incrustació.",
                steps: "1 Desa la clau com a HAPPIER_EMBED_KEY · 2 Escriu canOpenSession: qui pot obrir quin xat · 3 Mostra el xat",
                backend: "Servidor",
                react: "React",
            },
            detail: {
                created: ({ date }: { date: string }) => `Creada el ${date}`,
                lastUsed: ({ date }: { date: string }) => `Últim ús ${date}`,
                expires: ({ date }: { date: string }) => `Caduca el ${date}`,
                reconnect: "Els xats oberts es tornen a connectar amb el nou accés. Els esborranys es conserven.",
                e2eeTrust: "Aquesta clau pot llegir els xats xifrats d’aquest compte. Fes servir un compte dedicat per a la teva aplicació.",
                keyReach: "La clau es queda al teu servidor i pot arribar a tots els xats d’aquest compte. Els navegadors no la veuen mai: reben claus de curta durada limitades als xats que el teu servidor permet.",
                expiry: "La clau caduca",
                expiryDescription: "Quan la clau caduca, els xats deixen d’obrir-se. No es pot allargar després.",
                encryptionChecking: "S’està comprovant el xifratge d’aquest compte…",
                encryptionUnavailable: "Aquest dispositiu encara no pot llegir els xats xifrats d’aquest compte. Restaura la clau secreta per crear la incrustació.",
                encryptionStale: "Les claus d’aquest dispositiu per als xats xifrats estan desactualitzades. Restaura la clau secreta per crear la incrustació.",
                encryptionUnreadable: "No s’ha pogut comprovar el xifratge d’aquest compte.",
                missingTitle: "Aquesta incrustació ja no existeix",
                backToEmbeds: "Torna a les incrustacions",
            },
            delete: {
                button: "Suprimeix la incrustació",
                title: ({ label }: { label: string }) => `Vols suprimir «${label}»?`,
                body: "Els xats oberts es desconnecten. Les claus ja usades per llegir xats xifrats no es poden recuperar.",
                confirm: "Suprimeix",
            },
            reveal: {
                copyEnv: "Copia com a línia .env",
            },
        },
    }) };

return { embedSettingsTranslations };
})();

const Domain_embedTranslations = (() => {
const english = Shared_embedTranslations.english;

const translated = Shared_embedTranslations.translated;

const embedTranslations = { ca: translated({
        embed: {
            errors: {
                originNotAllowed: 'Aquesta pàgina no pot mostrar aquesta conversa.',
                originNotAllowedReason: 'Afegeix aquest lloc als llocs permesos de la incrustació a Happier.',
                unavailable: 'Aquesta conversa no està disponible aquí.',
                encrypted: 'Aquesta conversa està xifrada i no es pot obrir aquí.',
                createNotGranted: 'Aquesta aplicació no pot iniciar xats nous.',
                unsupportedVersion: 'Aquest xat necessita una incrustació més nova.',
                unsupportedVersionReason: 'Actualitza @happier-dev/embed en aquesta aplicació.',
            },
            nothingToShow: 'Encara no hi ha res a mostrar',
            nothingToShowReason: 'Aquesta aplicació no ha obert cap conversa.',
            reconnecting: 'S’està reconnectant…',
            previewUnavailable: 'Previsualització no disponible',
            previewUser: "Analitza aquest contacte i desa el resultat: Acme Robotics, 40 llicències, avaluant al quart trimestre.",
            previewAgent: "Molt bon encaix. El pressupost està confirmat i el promotor decideix. He desat l’anàlisi:",
            previewFollowUp: "Passem aquest contacte a qualificat?",
        },
    }) };

return { embedTranslations };
})();

const Domain_entityDragDropTranslations = (() => {
type EntityDragDropTranslations = Shared_entityDragDropTranslations.EntityDragDropTranslations;

const en = Shared_entityDragDropTranslations.en;

const ca: EntityDragDropTranslations = {
    files: { attach: "Adjunta", uploadHere: "Puja aquí" },
    composer: { addContext: "Afegeix context", consequence: "S’envia amb el teu proper missatge · encara no s’envia res", target: "Redactor", readOnly: "Aquest redactor és de només lectura", otherWorkspace: "No forma part d’aquest espai de treball", unavailable: "Aquesta referència no està disponible" },
    surface: {
        scopeMismatch: 'És en un altre Home o compte',
        widgetMoveUnavailable: 'Aquest giny no es pot moure a aquesta superfície',
        readOnly: 'Aquest tauler és de només lectura',
        copyDetail: 'Manté una referència · el tauler no canvia',
    },
    preview: {
        putUnder: ({ target }) => `Posa sota ${target}`,
        putUnderDetail: 'Hi informa · totes dues continuen en marxa',
        moveAbove: ({ target }) => `Mou damunt de ${target}`,
        moveBelow: ({ target }) => `Mou sota de ${target}`,
        orderDetail: 'Només l’ordre · ningú informa a ningú',
        moveToFolder: ({ folder }) => `Mou a ${folder}`,
        folderDetail: 'Només la carpeta · no informa a ningú',
        moveToTopLevel: 'Mou al nivell superior',
        topLevelDetail: 'Fora de la carpeta · res més no canvia',
        cantPutUnder: ({ target }) => `No es pot posar sota ${target}`,
        cantMoveHere: 'No es pot moure aquí',
        pendingPutUnder: ({ target }) => `Posant-la sota ${target}…`,
        pendingDetail: 'Esperant que el Home ho confirmi',
        unknownTitle: 'No és segur que s’hagi mogut',
        unknownDetail: 'Revisa la llista d’aquí a un moment abans de tornar-ho a provar',
    },
    settled: {
        refusedPutUnder: ({ item, target }) => `No s’ha pogut posar ${item} sota ${target}`,
        refused: ({ verb }) => `${verb}: no s’ha completat`,
        unknown: ({ verb }) => `No és segur que «${verb}» s’hagi completat`,
        dismiss: 'Descarta',
    },
    reasons: {
        read: 'La comparteixen amb tu només per llegir, així que no pot rebre informes',
        input: 'No hi pots enviar res, així que no pot rebre informes',
        pairwise: 'Aquestes dues sessions no poden compartir context',
        cycle: 'Aquesta sessió ja informa a aquesta',
        alreadyUnder: 'Ja informa a aquesta',
        archived: 'Està arxivada',
        differentHome: 'És en un altre Home. Les sessions informen dins d’un mateix Home',
        unavailable: 'Ara mateix no s’ha pogut comprovar aquesta sessió',
        dateOrder: 'Aquesta llista s’ordena per data. Canvia a l’ordre personalitzat per col·locar-la',
        noChange: 'Ja és aquí',
        descendantCycle: 'Una carpeta no pot anar dins de si mateixa',
        maxDepth: 'Les carpetes quedarien massa niades',
        foldersOff: 'Les carpetes estan desactivades en aquest Home',
        gone: 'Aquest lloc acaba de desaparèixer',
        generic: 'Aquest lloc no ho pot acceptar',
    },
    chooser: { putUnderTitle: ({ item }) => `Posa ${item} sota…`, checking: 'Comprovant quines sessions poden rebre informes…', cantTakeReports: 'No poden rebre informes', unavailable: 'No disponible' },
    keyboard: {
        choose: 'Tria un lloc', putUnder: 'Posa sota', topLevel: 'Nivell superior', drop: 'Deixa anar', cancel: 'Cancel·la', escapeKey: 'Esc',
        hintsA11y: 'Les fletxes trien un lloc, Retorn el deixa anar, Escapada cancel·la',
    },
    organize: { enter: 'Organitza la llista', title: 'Organitza', done: 'Fet', grip: ({ item }) => `Mou ${item}` },
    pane: {
        openHere: 'Obre aquí com a pestanya',
        nextTo: ({ target }) => `Al costat de ${target} · no es tanca res`,
        nothingCloses: 'S’obre com a pestanya · no es tanca res',
        tooNarrow: 'Aquest panell és massa estret per dividir-lo',
        moveHere: 'Mou aquí com a pestanya',
        openBefore: ({ target }) => `Obre abans de ${target}`,
        moveBefore: ({ target }) => `Mou abans de ${target}`,
        placeOnly: 'Només canvia de lloc',
        splitLeft: 'Divideix a l’esquerra',
        splitRight: 'Divideix a la dreta',
        splitUp: 'Divideix a dalt',
        splitDown: 'Divideix a baix',
        opensBeside: ({ target }) => `S’obre al costat de ${target}`,
        movesBeside: ({ target }) => `Es mou al costat de ${target}`,
        goTo: ({ target }) => `Vés a ${target}`,
        openInThisPane: 'Ja és oberta en aquest panell · no s’obre res de nou',
        openInAnotherPane: 'Ja és oberta en un altre panell · no s’obre res de nou',
        alreadyHere: 'Ja és aquí',
        leaveIt: 'Deixa-la anar per mantenir-la on és',
        cantOpenHere: 'No es pot obrir aquí',
        sessionsOnly: 'Aquest panell només mostra sessions',
        otherWorkspace: 'No forma part d’aquest espai de treball',
    },
};

const entityDragDropTranslations = { ca };

return { entityDragDropTranslations };
})();

const Domain_eventAutomationComposerTranslations = (() => {
const english = Shared_eventAutomationComposerTranslations.english;

const ca = {
    eventAutomationComposer: {
        available: 'Disponible',
        payloadFields: 'CAMPS DE CÀRREGA ÚTIL',
        payloadSample: 'Càrrega útil de mostra',
        noFilterableFields: 'Aquest esdeveniment no declara camps de càrrega útil filtrables.',
        addFilterClause: 'Afegeix condició',
        filterField: 'Camp de filtre',
        filterOperator: 'Operador de filtre',
        filterEquals: 'Iguals',
        filterOneOf: 'És un dels',
        filterValue: 'Valor del filtre',
        filterValuePlaceholder: '"valor" o ["valor"]',
        storedContentUnavailableTitle: 'El contingut d\'automatització emmagatzemat no està disponible',
        storedContentUnavailableBody: 'Aquesta automatització d\'esdeveniments no es pot desar perquè el seu contingut emmagatzemat no està disponible.',
        historyGapRecoveryTitle: 'La bretxa històrica necessita atenció',
        historyGapRecoverySubtitle: 'Restableix la línia de base d\'origen per reprendre l\'observació d\'esdeveniments nous.',
        historyGapRecoveryUnavailable: 'L\'acció de recuperació de la font no està disponible al seu observador actual.',
        historyGapRecoveryFailureTitle: 'La recuperació de la font necessita un altre intent',
        historyGapRecoveryFailureBody: 'La recuperació no es va confirmar. La font encara necessita atenció.',
        sourceStatusTitle: 'Font d\'observació',
        sourceStatusState: {
            uninitialized: 'No iniciada',
            baselined: 'Línia de base preparada',
            observing: 'Observació en curs',
            backingOff: 'Esperant per tornar-ho a provar',
            attention: 'Requereix atenció',
        },
        sourceStatusCode: {
            credentialMissing: 'Calen credencials',
            credentialRevoked: 'Credencial revocada',
            rateLimited: 'Límit de freqüència assolit',
            historyGap: 'Buit a l\'historial',
            capacityBlocked: 'Capacitat esgotada',
            definitionStale: 'La definició ha canviat',
            sourceContractIncompatible: 'Cal actualitzar la font',
            admissionUnavailable: 'Admissió no disponible',
        },
        sourceStatusNextRetry: ({ time }: { time: string }) => `Proper intent: ${time}`,
        sourceStatusObservedCount: ({ count }: { count: number }) => `Esdeveniments observats: ${count}`,
        sourceStatusAdmittedCount: ({ count }: { count: number }) => `Esdeveniments admesos: ${count}`,
        sourceStatusSkippedCount: ({ count }: { count: number }) => `Esdeveniments omesos: ${count}`,
        sourceStatusLastObserved: ({ time }: { time: string }) => `Última observació: ${time}`,
        sourceCatalogStatusTitle: 'Conciliació del catàleg',
        sourceCatalogStatusState: {
            current: 'Actual',
            reconciling: 'S’està conciliant',
            reconciliationLate: 'La conciliació està endarrerida',
        },
        sourceCatalogStatusObservedRevision: ({ revision }: { revision: string }) => `Revisió observada: ${revision}`,
        sourceCatalogStatusAdoptedRevision: ({ revision }: { revision: string }) => `Revisió adoptada: ${revision}`,
        sourceCatalogStatusNoAdoptedRevision: 'Encara no s’ha adoptat cap revisió',
        sourceCatalogStatusScanStarted: ({ time }: { time: string }) => `Escaneig iniciat: ${time}`,
    },
};

const eventAutomationComposerTranslations = { ca } as const;

return { eventAutomationComposerTranslations };
})();

const Domain_externalSessionOperationTranslations = (() => {
const en = Shared_externalSessionOperationTranslations.en;

const translated = Shared_externalSessionOperationTranslations.translated;

const externalSessionOperationTranslations = { ca: {
    browseLinked: 'Enllaçada',
    browseImported: 'Importada',
    browseAgentUnavailable: 'Happier no ha pogut iniciar ni connectar amb l’Agent seleccionat en aquesta màquina. Comprova que la seva CLI hi estigui instal·lada i torna-ho a provar.',
    browseAgentTimedOut: 'L’Agent seleccionat en aquesta màquina no ha respost a temps. Potser està ocupat o encara indexa, així que torna-ho a provar.',
    browseAgentFailed: 'Happier no ha pogut llegir les sessions de l’Agent seleccionat en aquesta màquina. Torna-ho a provar; si continua fallant, actualitza Happier en aquesta màquina.',
    operationTitleMaterialize: 'Importa a Happier',
    operationTitleTakeoverLinked: 'Pren el control i continua enllaçada',
    operationTitleTakeoverPersisted: 'Importa i pren el control',
    operationMaterializeAvailable: 'Importa aquesta sessió enllaçada per utilitzar-ne la transcripció sense connexió o compartir-la.',
    externalAgentStatusOnMachine: ({ agent, machine, status }: { agent: string; machine: string; status: string }) =>
        `${agent} a ${machine}: ${status}`,
    operationStatusRunning: 'En curs',
    operationStatusCancelling: 'S’està cancel·lant…',
    operationStatusCancelled: 'Cancel·lada',
    operationStatusCompleted: 'Completada',
    operationStatusDiscarded: 'Sessió parcial descartada',
    operationStatusNeedsResume: 'Esperant que la reprenguis',
    operationStatusNeedsReview: 'Cal revisar-la abans de continuar',
    operationStatusFailed: 'No s’ha pogut continuar',
    operationStatusImportIncomplete: 'Importació incompleta — Reprèn-la o descarta la sessió parcial',
    operationStatusUpdateIncomplete: 'Actualització incompleta — Reprèn-la',
    operationStatusOriginOffline: 'Progrés desat — la màquina d’origen està fora de línia',
    operationStatusOriginUnknown: 'Progrés desat — Happier no pot saber si la màquina d’origen està en línia',
    operationStatusExternalWriter: 'S’ha detectat un escriptor extern',
    operationStatusSpawnFailedAfterImport: 'S’ha importat, però no s’ha pogut iniciar l’Agent — Torna a provar l’inici',
    operationStatusSpawnFailedAfterTakeover: 'Se n’ha pres el control, però no s’ha pogut iniciar l’Agent — Torna a provar l’inici',
    operationErrorSourceUnavailable: 'La font no està disponible. Torna a connectar la màquina d’origen i reprèn l’operació.',
    operationErrorSourceChanged: 'La font ha canviat mentre es llegia. Revisa-la abans de reprendre.',
    operationErrorCapacity: 'Aquesta màquina no té prou capacitat d’emmagatzematge temporal per continuar.',
    operationErrorRequiredItems: 'Alguns elements obligatoris de la sessió no s’han pogut importar.',
    operationErrorImport: 'La importació dels missatges s’ha interromput.',
    operationErrorPublication: 'No s’ha pogut publicar la instantània importada.',
    operationErrorAdmission: 'Happier no ha pogut prendre el control d’aquesta sessió de manera segura.',
    operationErrorExternalWriter: 'Atura l’Agent extern abans de tornar-ho a provar. Happier no el combinarà ni l’aturarà automàticament.',
    operationErrorInternal: 'L’operació s’ha aturat a causa d’un error intern.',
    operationPhaseValidating: 'Validació',
    operationPhaseWaitingForAgent: 'Esperant que s’aturi l’Agent extern',
    operationPhaseReadingSource: 'Lectura de la font',
    operationPhaseImporting: 'Importació de missatges',
    operationPhaseCatchingUp: 'Sincronització amb la font',
    operationPhasePreparingRuntime: 'Preparació del runtime',
    operationPhaseStartingRuntime: 'Inici del runtime',
    operationPhaseFinalizing: 'Finalització',
    operationPhasePublishing: 'Publicació de la sessió importada',
    operationActionResume: 'Reprèn',
    operationActionRetryStart: 'Torna a provar l’inici',
    operationActionCancel: 'Cancel·la',
    operationActionDiscard: 'Descarta la sessió parcial',
    operationActionDismiss: 'Tanca',
    operationStatusOwnerReadFailed: 'Happier no ha pogut llegir el progrés actual d’aquesta operació.',
    operationActionCheckAgain: 'Torna-ho a comprovar',
    operationComposerImporting: 'S’està important…',
    operationComposerTakingOver: 'S’està prenent el control…',
    operationActionErrorUpgradeRequired: 'Actualitza Happier a la màquina d’origen per utilitzar aquesta acció.',
    operationActionErrorNotFound: 'Aquesta operació ja no està disponible.',
    operationActionErrorConflict: 'Una altra operació ja controla aquesta sessió.',
    operationActionErrorStaleRevision: 'L’operació ha canviat. Revisa el progrés més recent i torna-ho a provar.',
    operationActionErrorInvalidState: 'Aquesta acció no està disponible en l’estat actual de l’operació.',
    operationActionErrorNotAllowed: 'No tens permís per controlar aquesta operació.',
    operationActionErrorUnavailable: 'No s’ha pogut completar l’acció. Torna-ho a provar des del progrés més recent.',
    operationImportProgress: 'Progrés de la importació',
    operationImportCountUnknown: ({ imported }: { imported: number }) => `${imported} missatges importats`,
    operationImportCountEstimated: ({ imported, total }: { imported: number; total: number }) => `${imported} de ~${total} missatges`,
    operationPublishedSnapshot: 'S’ha conservat la instantània publicada',
    operationPublishedThrough: ({ sequence }: { sequence: number }) => `Disponible fins al missatge ${sequence}`,
    operationDiscardConfirmTitle: 'Vols descartar la sessió parcial?',
    operationDiscardConfirmBody: 'Això elimina tota la sessió parcial. Aquesta acció no es pot desfer.',
    sharingTranscriptOnMachine: ({ machine }: { machine: string }) =>
        `La transcripció d’aquesta sessió és a ${machine}. Importa-la a Happier per compartir-la.`,
    sharingImportIncomplete: 'La importació està en curs o incompleta. Reprèn-la abans de compartir.',
    sharingTranscriptUnavailableTitle: 'Transcripció no disponible',
    transcriptRetainedRefreshFailedTitle: 'Es mostra la darrera transcripció coneguda',
    transcriptLoadFailed: 'Happier no ha pogut carregar aquesta transcripció.',
    sharingTranscriptUnavailable: 'La transcripció no està disponible. Aquesta sessió enllaçada antiga no té cap transcripció persistent segura.',
    sharingSharedUpTo: ({ time }: { time: string }) => `Compartida fins a ${time}`,
    sharingSnapshotFrom: ({ time }: { time: string }) => `Instantània de ${time}`,
    sharingUpdateSharedCopy: 'Actualitza la còpia compartida',
    sharingUpdateSharedCopyDescription: 'Actualitza la instantània compartida amb la transcripció més recent de la font.',
    sharingSourceMachineMissing: 'La màquina d’origen no està disponible. Torna-la a connectar a Happier abans de tornar-ho a provar.',
    sharingSourceMachineOffline: 'La màquina d’origen està fora de línia. Connecta-la abans de tornar-ho a provar.',
    sharingActionAwaitingAvailability: 'Aquesta acció estarà disponible quan es connecti el flux de materialització.',
} } as const;

return { externalSessionOperationTranslations };
})();

const Domain_externalSessionSettingsTranslations = (() => {
const en = Shared_externalSessionSettingsTranslations.en;

const translated = Shared_externalSessionSettingsTranslations.translated;

const externalSessionSettingsTranslations = { ca: {
    settingsIntegrationStatusNotInstalled: 'No instal·lada',
    settingsIntegrationStatusEnabled: 'Instal·lada i activada',
    settingsIntegrationStatusDisabled: 'Instal·lada i desactivada',
    settingsIntegrationStatusNeedsAttention: 'Requereix atenció',
    settingsIntegrationStatusUnsupported: 'Aquesta versió de l’Agent no és compatible',
    settingsIntegrationStatusUnavailable: 'Agent no disponible',
    settingsIntegrationInventoryLoadingTitle: 'S’està comprovant l’estat de les integracions',
    settingsIntegrationInventoryLoadingSubtitle: 'S’està llegint l’inventari complet d’integracions d’aquesta màquina.',
    settingsIntegrationInventoryPartialTitle: 'L’estat de les integracions és incomplet',
    settingsIntegrationInventoryPartialSubtitle: 'No s’han pogut llegir alguns registres d’instal·lació. Torna-ho a comprovar abans de fer canvis.',
    settingsIntegrationInventoryErrorTitle: 'L’estat de les integracions no està disponible',
    settingsIntegrationInventoryErrorSubtitle: 'És possible que l’últim estat conegut no estigui actualitzat. Torna-ho a comprovar abans de fer canvis.',
    settingsIntegrationTitle: 'Supervisió de sessions externes',
    settingsIntegrationNeedsAttentionTitle: 'Requereix atenció',
    settingsIntegrationDiagnosticMessageUnavailable: 'Cal revisar aquesta instal·lació abans que la supervisió pugui continuar.',
    settingsIntegrationRemediationRetry: 'Torna-ho a comprovar després de resoldre el problema.',
    settingsIntegrationRemediationOpenSettings: ({ path }: { path: string }) => `Revisa l’ajust a ${path}.`,
    settingsIntegrationRemediationSelectAccount: ({ service }: { service: string }) => `Selecciona un compte per a ${service}.`,
    settingsIntegrationRemediationInstallDependency: ({ dependency }: { dependency: string }) => `Instal·la la dependència necessària: ${dependency}.`,
    settingsIntegrationRemediationOpenUrl: ({ url }: { url: string }) => `Consulta les indicacions a ${url}.`,
    settingsIntegrationActionReviewInstall: 'Revisa i instal·la',
    settingsIntegrationActionDisable: 'Desactiva',
    settingsIntegrationActionEnable: 'Activa',
    settingsIntegrationActionUninstall: 'Desinstal·la',
    settingsIntegrationActionCheckAgain: 'Torna-ho a comprovar',
    settingsIntegrationReviewTitle: ({ agent }: { agent: string }) => `Revisa la integració de ${agent}`,
    settingsIntegrationReviewBody: ({ entries }: { entries: string }) =>
        `Happier només gestionarà aquestes entrades: ${entries}.`,
    settingsIntegrationReviewBodyUnavailable: 'Revisa els canvis gestionats per l’Agent abans d’instal·lar.',
    settingsIntegrationPreviewNoMatcher: 'Totes les sessions coincidents',
    settingsIntegrationActionInstall: 'Instal·la',
    settingsIntegrationUninstallTitle: ({ agent }: { agent: string }) => `Vols desinstal·lar la integració de ${agent}?`,
    settingsIntegrationUninstallBody: 'Això només elimina les entrades gestionades per Happier. La resta de la configuració de l’Agent no canvia.',
    settingsIntegrationActionFailed: 'Happier no ha pogut actualitzar aquesta integració. Comprova la màquina i torna-ho a provar.',
    settingsAutoLinkUpdateFailed: 'Happier no ha pogut actualitzar l’enllaç automàtic. Torna-ho a provar.',
    settingsRestoreUpdateFailed: 'Happier no ha pogut actualitzar la preferència de sincronització després de reiniciar. Torna-ho a provar.',
    settingsIntegrationsGroupTitle: 'Supervisió de sessions externes',
    settingsIntegrationsFooter: 'Happier només canvia la configuració de l’Agent després d’una acció explícita. Obrir aquesta pàgina és de només lectura.',
    settingsIntegrationsUnavailableTitle: 'No hi ha integracions disponibles',
    settingsIntegrationsUnavailableSubtitle: 'Connecta una integració d’Agent compatible per revisar-ne l’estat i les accions disponibles.',
    settingsAgentAutoLinkTitle: ({ agent }: { agent: string }) => `Afegeix automàticament les sessions noves de ${agent}`,
    settingsAutoLinkTitle: 'Afegeix automàticament sessions externes noves',
    browseAutoLinkTitle: 'Afegeix automàticament les sessions noves',
    settingsAutoLinkGroupTitle: 'Enllaç automàtic',
    settingsAutoLinkGroupFooter: 'L’enllaç automàtic està desactivat per defecte i és independent de la configuració de la integració de l’Agent i de la sincronització en segon pla.',
    settingsAutoLinkUnavailableTitle: 'No hi ha fonts d’enllaç automàtic disponibles',
    settingsAutoLinkUnavailableSubtitle: 'No hi ha cap àmbit de font compatible disponible en aquesta màquina.',
    settingsAutoLinkSubtitle: 'Quan està activat, Happier enllaça les sessions noves compatibles d’aquesta font sense obrir ni reprendre l’Agent.',
    settingsAutoLinkHint: 'Activa o desactiva l’enllaç automàtic per a aquesta font.',
    settingsPrivacyGroupTitle: 'Privadesa',
    settingsPrivacyTitle: 'Observacions limitades i sense contingut',
    settingsPrivacySubtitle: 'Les integracions d’Agent de confiança poden inspeccionar dades natives limitades dels hooks en aquesta màquina. Happier només admet i sincronitza observacions sense contingut; l’amfitrió mai no desa, sincronitza ni registra càrregues útils, camins, credencials, instruccions, text de transcripcions ni arguments d’eines.',
    settingsAgentActionsGroupTitle: 'Sessions externes',
    settingsAgentBrowseTitle: ({ agent }: { agent: string }) => `Explora les sessions externes de ${agent}`,
    settingsManageAllTitle: 'Gestiona tots els ajustos de Sessions externes',
    settingsManageAllSubtitle: 'Revisa les integracions i la sincronització en segon pla de les màquines connectades.',
    settingsMachineOnline: 'En línia',
    settingsMachineOffline: 'Fora de línia',
    settingsMachineTitle: 'Màquina',
    settingsMachineUnavailable: 'No hi ha cap màquina connectada',
    browseSearchIncomplete: ({ count }: { count: number }) =>
        `Es mostren les primeres ${count} — afina la cerca`,
    browseAnnotationsIncomplete: 'No s’han pogut confirmar alguns estats. Obrir una sessió ho comprova.',
    browseRouteUnavailableTitle: 'Les sessions externes no estan disponibles aquí',
    browseRouteUnavailableSubtitle: 'Aquest servidor no ofereix la navegació de sessions externes. Torna enrere i tria un altre servidor, o prova-ho més tard.',
    browseRouteAvailabilityUnknownTitle: 'No s’ha pogut confirmar la compatibilitat amb sessions externes',
    browseRouteAvailabilityUnknownSubtitle: 'Happier no ha pogut comprovar si aquest servidor ofereix la navegació de sessions externes. Torna enrere i prova-ho d’aquí a un moment.',
    browseHeaderTitle: 'Sessions externes',
    browseSettingsLink: 'Configuració de les sessions externes',
    browseChooseMachineTitle: 'Tria una màquina',
    browseChooseMachineBody: 'Les sessions externes viuen a la màquina que les va executar. Tria’n una per veure’n les sessions.',
    browseMachineGoneBody: 'S’ha eliminat o substituït. Tria una altra màquina per veure’n les sessions.',
    browseHomeUnreachableBody: 'Les seves màquines i sessions apareixeran quan s’hi pugui accedir. Mentrestant, tria una altra màquina.',
    browseMachineOfflineTitle: ({ machine }: { machine: string }) => `${machine} està fora de línia`,
    browseThisMachineOfflineTitle: 'Aquesta màquina està fora de línia',
    browseMachineOfflineBody: 'Les seves sessions apareixeran quan es torni a connectar.',
    browseChooseAnotherMachine: 'Tria una altra màquina',
    browseCantReachTitle: ({ machine }: { machine: string }) => `No es pot contactar amb Happier a ${machine}`,
    browseCantReachBody: 'La màquina està en línia, però el servei de Happier no respon. Potser encara s’està iniciant.',
    browseNothingToBrowseTitle: ({ machine }: { machine: string }) => `No hi ha res per explorar a ${machine}`,
    browseNothingToBrowseBody: 'Cap dels agents d’aquesta màquina no pot compartir encara les seves sessions.',
    browseEmptyTitle: ({ agent, machine }: { agent: string; machine: string }) => `No hi ha sessions de ${agent} a ${machine}`,
    browseEmptyBody: 'Les sessions que iniciïs en aquesta màquina apareixen aquí, a punt per obrir-les a Happier.',
    browseTryAgent: ({ agent }: { agent: string }) => `Prova ${agent}`,
    browseNoMatches: ({ query }: { query: string }) => `Cap sessió coincideix amb «${query}»`,
    browseErrorTitle: 'No s’han pogut carregar les sessions',
    browseThisMachine: 'aquesta màquina',
    browseIndexingStop: 'Atura',
    browseThreadsFilter: 'Fils de subagents',
    browseThreadsHidden: 'Només sessions principals',
    browseThreadsShown: 'Amb fils de subagents',
    browseThreadReviewer: 'Revisor',
    browseThreadSubagent: 'Subagent',
    browseThreadReviewerOf: ({ parent }: { parent: string }) => `Revisor de ${parent}`,
    browseThreadSubagentOf: ({ parent }: { parent: string }) => `Subagent de ${parent}`,
} };

return { externalSessionSettingsTranslations };
})();

const Domain_filesPaneTranslations = (() => {
type FilesPaneTranslations = Shared_filesPaneTranslations.FilesPaneTranslations;

const filesPaneTranslations = { ca: {
        changedOnly: 'Només canviats',
        showAllFiles: 'Mostra tots els fitxers',
        viewOptions: 'Opcions de visualització',
        sizeAndDate: 'Mida i data',
        newMenu: 'Fitxer nou, carpeta nova o pujada',
        newFile: 'Fitxer nou',
        newFolder: 'Carpeta nova',
        noChangedFilesTitle: 'No ha canviat res',
        noChangedFilesReason: 'La còpia de treball coincideix amb l’últim commit.',
        rootErrorTitle: ({ machine }) => `No s’han pogut llistar els fitxers a ${machine}`,
        rootErrorTitleUnnamed: 'No s’han pogut llistar els fitxers',
    } } as const satisfies Pick<Record<string, FilesPaneTranslations>, "ca">;

return { filesPaneTranslations };
})();

const Domain_findTranslations = (() => {
type FindTranslations = Shared_findTranslations.FindTranslations;

const slavicPlural = Shared_findTranslations.slavicPlural;

const russianPlural = Shared_findTranslations.russianPlural;

const en = Shared_findTranslations.en;

const ca: FindTranslations = {
    open: 'Cerca…',
    openedForMatch: 'Obert per una coincidència', foldAgain: 'Torna a plegar', showHiddenLines: ({ count }) => `Mostra ${count} línies ocultes`,
    surface: {
        chat: 'Cerca al xat',
        changes: 'Cerca als canvis',
        file: 'Cerca al fitxer',
        terminal: ({ name }) => `Cerca a ${name}`,
    },
    previous: 'Coincidència anterior',
    next: 'Coincidència següent',
    matchCase: 'Distingeix majúscules',
    regex: 'Usa una expressió regular',
    regexShort: 'Expressió regular',
    options: 'Opcions de cerca',
    close: 'Tanca la cerca',
    done: 'Fet',
    stop: 'Atura',
    noMatches: 'Cap coincidència',
    noneFound: 'No s’ha trobat res',
    invalidPattern: 'Patró no vàlid',
    offline: 'Sense connexió',
    unsupported: 'Aquí no es pot cercar',
    count: ({ current, total }) => (current === null ? `${total} ${total === 1 ? 'coincidència' : 'coincidències'}` : `${current} de ${total}`),
    files: ({ count }) => `${count} ${count === 1 ? 'fitxer' : 'fitxers'}`,
    soFar: 'de moment',
    loaded: 'carregades',
    note: {
        searchingOlder: 'Revisant missatges anteriors, desxifrats en aquest dispositiu',
        offlineOlder: 'Podràs cercar els missatges anteriors quan tornis a estar en línia.',
        terminalKept: ({ lines }) => `S’han cercat les últimes ${lines} línies que conserva aquest terminal.`,
    },
};

const findTranslations = { ca };

return { findTranslations };
})();

const Domain_folderlessSessionTranslations = (() => {
type FolderlessSessionTranslations = Shared_folderlessSessionTranslations.FolderlessSessionTranslations;

const en = Shared_folderlessSessionTranslations.en;

const ca: FolderlessSessionTranslations = {
    composer: {
        addFolder: 'Afegeix una carpeta',
        noFolder: 'Sense carpeta',
        noFolderDescription: 'El Happier manté una carpeta privada per a aquest xat',
        removeFolder: 'Treu la carpeta',
        a11y: {
            folder: ({ path }) => `Carpeta: ${path}. Obre les opcions de carpeta.`,
            none: 'Sense carpeta. El Happier manté una carpeta privada per a aquest xat. Afegeix una carpeta.',
            loading: 'S’està carregant la carpeta',
            noFolderRow: 'Sense carpeta, carpeta privada per a aquest xat',
            removed: 'S’ha tret la carpeta',
            set: ({ path }) => `Carpeta establerta a ${path}`,
        },
    },
    display: {
        chats: 'Xats',
        untitledChat: 'Xat nou',
        folder: 'Carpeta',
        privateToSession: 'Només d’aquesta sessió',
        sessionFiles: 'Fitxers de la sessió',
        privateFolderOn: ({ machine }) => `Carpeta privada a ${machine}`,
    },
};

const folderlessSessionTranslations = { ca: ca };

return { folderlessSessionTranslations };
})();

const Domain_glassAppearanceTranslations = (() => {
const englishTranslations = Shared_glassAppearanceTranslations.englishTranslations;

const effectiveTranslations = { "ca": {
        "effectiveBrowserSolid": "Menús i controls flotants sòlids. El navegador no pot mostrar l’escriptori.",
        "effectiveFloatingSolid": "Controls flotants sòlids en aquest dispositiu.",
        "effectiveSolid": "Superfícies sòlides en aquest dispositiu.",
        "effectiveBrowser": "Vidre als menús i controls flotants. El navegador no pot mostrar l’escriptori.",
        "effectiveBrowserCustom": "El teu material als menús i controls flotants. El navegador no pot mostrar l’escriptori.",
        "effectivePhone": "Vidre als controls flotants i fulls.",
        "effectiveLayered": "Vidre en capes a tota la finestra.",
        "effectiveUniform": "Vidre uniforme a tota la finestra.",
        "effectiveCustom": "Vidre a la finestra tal com l’has personalitzat.",
        "effectiveUnavailable": "El vidre de finestra no està disponible. Els controls flotants mantenen el material triat.",
        "effectiveInactive": "Sòlid mentre la finestra és inactiva.",
        "effectiveTint": "Controls flotants tenyits; el desenfocament del fons no està disponible.",
        "description": "Deixa veure l’escriptori a través de la finestra i la pàgina sota els controls flotants.",
        "descriptionBrowser": "Deixa veure la pàgina sota els menús i controls flotants.",
        "descriptionPhone": "Deixa veure la pàgina sota els controls flotants i fulls.",
        "chromeDescription": "Barra de títol, navegació i fons de finestra",
        "sidebarDescription": "La columna de sessions",
        "contentDescription": "Conversa, editor de missatges i panells",
        "floatingDescription": "Menús, finestres emergents, fulls i controls flotants",
        "clear": "Transparent",
        "shortcutHint": ({ modifier }: { modifier: string }) => `${modifier}-clic · ${modifier}⇧L per canviar entre clar i fosc`
    } } as const;

const glassAppearanceTranslations = { ca: { iosReduceTransparencyPath: "Ajustos › Accessibilitat › Pantalla i mida del text › Reduir transparència", title: 'Vidre', material: 'Material', solid: 'Sòlid', auto: 'Automàtic', everywhere: 'A tot arreu', custom: 'Personalitzat', blur: 'Desenfocament', off: 'Desactivat', opacity: 'Opacitat', customize: 'Personalitza', chrome: 'Marc de la finestra', sidebar: 'Barra lateral', content: 'Contingut', floating: 'Superfícies flotants', appearance: 'Aparença', moreSettings: 'Més opcions d’aparença…', customizeLink: 'Personalitza…', toolbarTitle: 'Botó d’aparença', toolbarDescription: 'Mostra Aparença a la barra d’eines. Un clic amb modificador canvia entre clar i fosc.', reduceTransparency: 'Sòlid perquè Reduir transparència està activat', osSettings: 'Obre els ajustos d’accessibilitat', themeCommand: 'Canvia entre clar i fosc', autoDescription: "S’adapta al dispositiu: vidre en capes a les finestres compatibles i a les superfícies flotants del telèfon.", osSettingsUnavailable: "No s’han pogut obrir els ajustos d’accessibilitat. Obre’ls als ajustos del dispositiu.", ...effectiveTranslations["ca"] } } satisfies Pick<Record<string, Record<keyof typeof englishTranslations, string | ((params: { modifier: string }) => string)>>, "ca">;

return { effectiveTranslations, glassAppearanceTranslations };
})();

const Domain_goalControlTranslations = (() => {
const en = Shared_goalControlTranslations.en;

const ca: typeof en = {
    row: {
        notSet: 'Sense definir',
    },
    keepGoing: {
        title: 'Continua fins acabar',
        nativeDescription: ({ agent }) => `${agent} continua treballant cap a l’objectiu pel seu compte.`,
        description: ({ rounds }) => `Després de cadascun dels teus torns, un agent revisa l’objectiu i continua fins que s’acaba, s’esgota el pressupost o deixa d’avançar, com a màxim ${rounds} ${rounds === 1 ? 'ronda' : 'rondes'}.`,
        roundsPrefix: 'Atura després de',
        roundsSuffix: 'rondes',
        roundsLabel: 'Rondes abans d’aturar-se',
        strikesPrefix: 'Atura després de',
        strikesSuffix: 'revisions sense avenç',
        strikesLabel: 'Revisions sense avenç abans d’aturar-se',
        secondOpinionTitle: 'Demana una segona opinió abans d’acabar',
        secondOpinionDescription: 'Abans de marcar l’objectiu com a fet, un segon agent el revisa. Si no hi està d’acord, reps una notificació i l’objectiu continua obert.',
        budgetUnreported: ({ agent }) => `${agent} no informa de l’ús de tokens, així que només s’apliquen les rondes i les revisions d’avenç.`,
    },
};

const goalControlTranslations = { ca };

return { goalControlTranslations };
})();

const Domain_homeAddTranslations = (() => {
type HomeAddTranslation = Shared_homeAddTranslations.HomeAddTranslation;

const en = Shared_homeAddTranslations.en;

const homeAddTranslations = { ca: {
        addressIsSignInService: 'Aquesta adreça és un servei d’inici de sessió. Inicia-hi la sessió per trobar els teus Homes.',
        mixedContent: 'Aquest navegador no pot connectar-se a un Home HTTP des d’una pàgina HTTPS. Obre Happier amb HTTP o fes servir una adreça HTTPS per al Home.',
        connectedToHome: ({ home }) => `${home} està connectat a aquest dispositiu.`,
        openHome: ({ home }) => `Obre ${home}`,
        showAllHomes: 'Mostra tots els Homes',
        otherSignInService: 'Un altre servei d’inici de sessió',
        otherSignInServiceSubtitle: 'Un servei autoallotjat o d’empresa',
        signInServiceAddress: 'Adreça del servei',
    } } satisfies Pick<Record<string, HomeAddTranslation>, "ca">;

return { homeAddTranslations };
})();

const Domain_homeComposerTranslations = (() => {
type HomeComposerTranslation = Shared_homeComposerTranslations.HomeComposerTranslation;

const starterPrompts = Shared_homeComposerTranslations.starterPrompts;

const homeComposerTranslations = { ca: {
        ...starterPrompts,
        suggestionsLabel: 'Suggeriments',
        summarizeProjectSince: ({ project, day }) => `Resumeix què ha canviat a ${project} des de ${day}`,
        summarizeProjectToday: ({ project }) => `Resumeix què ha canviat avui a ${project}`,
        sessionsSince: ({ count, day }) => (count === 1 ? `1 sessió des de ${day}` : `${count} sessions des de ${day}`),
        sessionsToday: ({ count }) => (count === 1 ? '1 sessió avui' : `${count} sessions avui`),
    } } satisfies Pick<Readonly<Record<string, HomeComposerTranslation>>, "ca">;

return { homeComposerTranslations };
})();

const Domain_homeDeviceApprovalTranslations = (() => {
type HomeDeviceApprovalTranslation = Shared_homeDeviceApprovalTranslations.HomeDeviceApprovalTranslation;

const homeDeviceApprovalTranslations = { ca: {
        title: 'Aprovacions de dispositius', deviceFallback: 'Dispositiu nou',
        homeLabel: ({ home }) => `Home: ${home}`, expiresLabel: ({ expiry }) => `Caduca: ${expiry}`,
        requestDetails: 'Detalls de la sol·licitud', requestDetailsHint: 'Mostra l’identificador de la clau de sol·licitud',
        fingerprintLabel: 'Empremta de la clau de sol·licitud', requestDetailsHelp: 'Això identifica la clau de sol·licitud. No és un codi que hagis de comparar.',
        approve: 'Aprova', reject: 'Rebutja', loadError: 'No s’han pogut carregar les aprovacions de dispositius.',
        loadErrorUnreachable: ({ homes }) => `${homes} no ha respost.`, loadErrorFailed: ({ homes }) => `${homes} ha respost amb un error.`,
        decisionError: 'No s’ha pogut actualitzar aquesta sol·licitud.', decisionRecovery: 'Tria Aprova o Rebutja per tornar-ho a provar.',
        approved: 'Dispositiu aprovat', rejected: 'Dispositiu rebutjat', expired: 'Caducada', stopWaiting: 'Deixa d’esperar',
    } } as const satisfies Pick<Record<string, HomeDeviceApprovalTranslation>, "ca">;

return { homeDeviceApprovalTranslations };
})();

const Domain_homeFeatureTranslations = (() => {
const en = Shared_homeFeatureTranslations.en;

const ca: typeof en = {
    teams: {
        title: 'Equips',
        description: 'Grups amb sessions, màquines i accés compartits.',
        credentialResources: {
            title: 'Credencials de l’equip',
            description: 'Credencials que un equip comparteix amb les seves sessions.',
            externalApi: {
                title: 'API de credencials de l’equip',
                description: 'Eines externes fan servir les credencials d’un equip mitjançant l’API.',
            },
        },
    },
    automations: {
        title: 'Automatitzacions',
        description: 'Feina d’agents programada i activada per esdeveniments.',
    },
    workflows: {
        title: 'Fluxos de treball',
        description: 'Pipelines d’agents de diversos passos.',
    },
    pets: {
        sync: {
            title: 'Sincronització de mascotes',
            description: 'Manté les mascotes de cada persona a tots els seus dispositius.',
        },
    },
    voice: {
        title: 'Veu',
        description: 'Parla amb els teus agents.',
        happierVoice: {
            title: 'Veu de Happier',
            description: 'Veu mitjançant el servei de veu que ofereix aquest Home.',
        },
    },
    connectedServices: {
        group: 'Serveis connectats',
        quotas: {
            title: 'Indicadors de quota',
            description: 'Mostra quanta quota li queda a cada compte connectat.',
        },
        subscription: {
            title: 'Estat de la subscripció',
            description: 'Mostra el pla i l’estat de cada compte connectat.',
        },
        accountGroups: {
            title: 'Grups de comptes',
            description: 'Agrupa els comptes connectats en pools.',
        },
        accountFallback: {
            title: 'Compte de reserva',
            description: 'Passa al compte següent del pool quan un s’esgota.',
        },
        autoQuotaReset: {
            title: 'Restabliment automàtic de quota',
            description: 'Fa servir els restabliments de quota acumulats quan tots els comptes d’un pool s’esgoten.',
        },
        autoDisablePlanInvalid: {
            title: 'Omet els comptes inservibles',
            description: 'Desactiva els comptes del pool que no poden fer servir el model triat.',
        },
        poolQuotaLimitSelection: {
            title: 'Límits de quota del pool',
            description: 'Tria quina quota del proveïdor segueix cada pool.',
        },
    },
    updates: {
        ota: {
            title: 'Actualitzacions remotes',
            description: 'Les apps instal·len actualitzacions sense passar per la botiga.',
        },
    },
    attachments: {
        uploads: {
            title: 'Adjunts',
            description: 'Envia fitxers i imatges als agents d’una sessió.',
        },
    },
    sharing: {
        group: 'Compartició',
        session: {
            title: 'Compartir sessions',
            description: 'Comparteix una sessió amb algú d’aquest Home.',
        },
        public: {
            title: 'Enllaços públics',
            description: 'Comparteix el contingut d’una sessió amb un enllaç públic.',
        },
        contentKeys: {
            title: 'Compartició xifrada',
            description: 'Intercanvia claus perquè les sessions compartides continuïn xifrades d’extrem a extrem.',
        },
        pendingQueueV2: {
            title: 'Cua de missatges compartida',
            description: 'Posa en cua els missatges d’una sessió compartida mentre el seu agent està ocupat.',
        },
        pendingDeliveryState: {
            title: 'Seguiment del lliurament de la cua',
            description: 'Recorda quins missatges en cua han arribat a l’agent.',
        },
    },
    sessions: {
        title: 'Sessions',
        description: 'Les sessions i els seus controls.',
        group: 'Sessions',
        handoff: {
            title: 'Traspàs de sessió',
            description: 'Mou una sessió en curs a una altra màquina.',
        },
        ephemeralRunner: {
            title: 'Runners efímers',
            description: 'Inicia una sessió en una màquina d’un sol ús.',
        },
        agentSwitching: {
            title: 'Canvi d’agent',
            description: 'Continua una sessió amb un altre agent de codi.',
        },
        folders: {
            title: 'Carpetes de sessions',
            description: 'Organitza les sessions en carpetes.',
        },
        drafts: {
            title: 'Esborranys sincronitzats',
            description: 'Conserva els missatges no enviats i els esborranys de sessió a cada dispositiu.',
        },
        following: {
            title: 'Seguiment',
            description: 'Segueix una sessió per rebre’n les novetats i notificacions.',
        },
        conversations: {
            title: 'Converses',
            description: 'Les persones conversen i es mencionen dins d’una sessió compartida.',
        },
        board: {
            title: 'Tauler de sessions',
            description: 'Organitza les sessions i els seus elements en taulers compartits.',
        },
        filteredListing: {
            title: 'Llista filtrada',
            description: 'Filtra la llista de sessions d’aquest Home abans de paginar-la.',
        },
        usageLimitRecovery: {
            title: 'Represa després d’un límit d’ús',
            description: 'Esperar i reprendre, o tornar-ho a provar, quan un agent arriba a un límit d’ús.',
        },
    },
    machines: {
        title: 'Màquines',
        description: 'La connexió amb les teves màquines.',
        group: 'Màquines',
        pools: {
            title: 'Pools de màquines',
            description: 'Passa a la màquina següent quan una està fora de línia.',
        },
        transfer: {
            title: 'Transferències entre màquines',
            description: 'Transferir dades entre màquines.',
            directPeer: {
                title: 'Transferències directes',
                description: 'Transfereix dades directament entre màquines.',
            },
            serverRouted: {
                title: 'Transferències a través d’aquest Home',
                description: 'Transfereix dades a través d’aquest Home quan les màquines no es poden connectar directament.',
            },
        },
        peerMediation: {
            title: 'Connexions entre màquines',
            description: 'Túnels, transmissions i accés entre màquines.',
            observability: {
                title: 'Diagnòstic de connexions',
                description: 'Mostra com es connecten túnels, transmissions i previsualitzacions entre màquines.',
            },
        },
        tunnel: {
            title: 'Túnels entre màquines',
            description: 'Obrir ports entre màquines.',
            directPeer: {
                title: 'Túnels directes',
                description: 'Obre ports directament entre màquines.',
            },
            serverRouted: {
                title: 'Túnels a través d’aquest Home',
                description: 'Obre ports a través d’aquest Home quan les màquines no es poden connectar directament.',
            },
        },
        liveStream: {
            title: 'Transmissions en directe',
            description: 'Transmetre la pantalla d’una màquina.',
            directPeer: {
                title: 'Transmissions directes',
                description: 'Transmet la pantalla d’una màquina directament al teu dispositiu.',
            },
            serverRouted: {
                title: 'Transmissions a través d’aquest Home',
                description: 'Transmet la pantalla d’una màquina a través d’aquest Home quan la transmissió directa falla.',
            },
        },
        rpc: {
            title: 'Crides a màquines',
            description: 'Arribar a les màquines directament.',
            directPeer: {
                title: 'Crides directes a màquines',
                description: 'Arriba a una màquina directament en lloc de fer-ho a través d’aquest Home.',
            },
        },
    },
    localServices: {
        title: 'Serveis locals',
        description: 'Veu i obre els serveis que s’executen a les teves màquines.',
        group: 'Serveis locals',
        inventory: {
            title: 'Inventari de serveis',
            description: 'Llista els ports i serveis actius a cada màquina.',
        },
        managed: {
            title: 'Serveis gestionats',
            description: 'Inicia, anomena i vigila serveis des de Happier.',
        },
        launcher: {
            title: 'Llançador de serveis',
            description: 'Suggereix serveis per obrir i previsualitzar.',
        },
        actions: {
            title: 'Accions de serveis',
            description: 'Copiar, previsualitzar i oblidar serveis.',
            terminate: {
                title: 'Aturar serveis',
                description: 'Atura el procés d’un servei detectat.',
            },
        },
        preview: {
            title: 'Previsualitzacions de serveis',
            description: 'Previsualitza un servei local en privat dins d’una sessió.',
        },
        publicPreview: {
            title: 'Previsualitzacions públiques',
            description: 'Comparteix la previsualització d’un servei en una adreça pública.',
        },
    },
    browser: {
        title: 'Navegador',
        description: 'Obre pàgines, previsualitzacions i vistes allotjades dins de Happier.',
        group: 'Navegador',
        viewTargets: {
            title: 'Vistes del navegador',
            description: 'Obre previsualitzacions, pàgines de plugins i enllaços a la vista adequada.',
        },
        internal: {
            title: 'Navegador integrat',
            description: 'Navega dins de Happier amb sessions i perfils propis.',
        },
        sidecar: {
            title: 'Navegador auxiliar',
            description: 'Un navegador gestionat a part per a automatització intensiva.',
        },
        diagnostics: {
            title: 'Eines de desenvolupament',
            description: 'Consola, xarxa i esdeveniments devtools del navegador integrat.',
        },
        context: {
            title: 'Context del navegador',
            description: 'Adjunta el contingut d’una pàgina a un missatge o a un agent.',
        },
        automation: {
            title: 'Automatització del navegador',
            description: 'Els agents fan clic, escriuen i naveguen al navegador integrat.',
        },
        recording: {
            title: 'Enregistraments del navegador',
            description: 'Enregistra les sessions del navegador com a prova.',
        },
    },
    plugins: {
        title: 'Plugins de fora de Happier',
        description: 'Instal·la plugins des de npm i des de les teves fonts.',
        group: 'Plugins',
        webhooks: {
            title: 'Webhooks de plugins',
            description: 'Els plugins reben webhooks de serveis externs.',
        },
        ui: {
            title: 'Pantalles de plugins',
            description: 'Mostra les pantalles i els panells que ofereixen els plugins.',
            hostedWeb: {
                title: 'Pantalles web de plugins',
                description: 'Mostra pantalles de plugins creades per al web.',
            },
            reactNativeBundles: {
                title: 'Pantalles natives de plugins',
                description: 'Executa pantalles de plugins de confiança creades amb React Native.',
            },
        },
    },
    devices: {
        title: 'Dispositius',
        description: 'Simuladors i dispositius connectats.',
        simulatorPreview: {
            title: 'Previsualitzacions de simuladors',
            description: 'Mostra simuladors i emuladors de les teves màquines.',
        },
    },
    social: {
        friends: {
            title: 'Amics',
            description: 'Afegeix amics i mira què comparteixen.',
        },
    },
    auth: {
        group: 'Inici de sessió',
        recovery: {
            providerReset: {
                title: 'Restabliment amb un proveïdor',
                description: 'Recupera un compte iniciant la sessió amb el seu proveïdor d’identitat.',
            },
        },
        login: {
            keyChallenge: {
                title: 'Inici de sessió amb clau',
                description: 'Inicia la sessió demostrant la clau d’un dispositiu.',
            },
        },
        mtls: {
            title: 'Certificats de client',
            description: 'Inicia la sessió amb un certificat de client (mTLS).',
        },
        ui: {
            recoveryKeyReminder: {
                title: 'Recordatori de la clau de recuperació',
                description: 'Recorda a les persones que desin la clau de recuperació.',
            },
        },
        pairing: {
            desktopQrMobileScan: {
                title: 'Inici de sessió escanejant',
                description: 'Inicia la sessió en un telèfon escanejant un codi en un ordinador.',
            },
            boundQrV2: {
                title: 'Codis de vinculació més segurs',
                description: 'Codis de vinculació que només serveixen per a aquest Home i aquesta direcció.',
            },
        },
    },
    encryption: {
        group: 'Xifratge',
        plaintextStorage: {
            title: 'Emmagatzematge sense xifrar',
            description: 'Desa les sessions sense xifratge d’extrem a extrem.',
        },
        accountOptOut: {
            title: 'Desactivar el xifratge',
            description: 'Cada persona pot desactivar el xifratge d’extrem a extrem.',
        },
    },
    remoteHosts: {
        group: 'Amfitrions remots',
        management: {
            title: 'Amfitrions remots',
            description: 'Desa amfitrions SSH on executar sessions.',
        },
        secretMaterial: {
            title: 'Secrets d’amfitrions desats',
            description: 'Desa contrasenyes i claus d’amfitrions SSH.',
        },
    },
    e2ee: {
        keylessAccounts: {
            title: 'Comptes sense claus',
            description: 'Comptes sense claus de xifratge d’extrem a extrem.',
        },
    },
    bugReports: {
        title: 'Informes d’errors',
        description: 'Envia informes d’errors amb diagnòstics.',
    },
    terminal: {
        group: 'Terminal',
        embeddedPty: {
            title: 'Terminal',
            description: 'Obre un terminal en una màquina dins de Happier.',
        },
        transport: {
            byteStream: {
                title: 'Terminal per flux',
                description: 'Una connexió més ràpida per al terminal integrat.',
            },
        },
    },
    search: {
        title: 'Cerca',
        description: 'Cerca en sessions i transcripcions.',
    },
    providers: {
        title: 'Proveïdors de models',
        description: 'Connecta proveïdors de models i tria models per als agents.',
        group: 'Proveïdors de models',
        localDiscovery: {
            title: 'Troba proveïdors locals',
            description: 'Troba servidors de models que s’executen a les teves màquines.',
        },
        localModelManagement: {
            title: 'Gestió de models locals',
            description: 'Baixa i gestiona models locals.',
        },
    },
    keys: {
        HAPPIER_FEATURE_BUG_REPORTS__PROVIDER_URL: {
            title: 'Adreça del servei d’informes',
            description: 'On s’envien els informes d’errors. Si es deixa en blanc, no s’ofereix cap servei d’informes.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__DEFAULT_INCLUDE_DIAGNOSTICS: {
            title: 'Inclou diagnòstics per defecte',
            description: 'El formulari d’informe inclou diagnòstics tret que qui informa ho desactivi.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__MAX_ARTIFACT_BYTES: {
            title: 'Adjunt màxim',
            description: 'Fitxer més gran que pot adjuntar un informe d’errors, en bytes.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__UPLOAD_TIMEOUT_MS: {
            title: 'Temps límit de pujada',
            description: 'Quant pot trigar la pujada d’un informe d’errors, en mil·lisegons.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__ACCEPTED_ARTIFACT_KINDS: {
            title: 'Tipus d’adjunt acceptats',
            description: 'Tipus d’adjunt que accepten els informes d’errors. Buit accepta els tipus habituals.',
        },
        HAPPIER_FEATURE_BUG_REPORTS__CONTEXT_WINDOW_MS: {
            title: 'Finestra de context',
            description: 'Fins a quin punt enrere recull context un informe d’errors, en mil·lisegons.',
        },
        HAPPIER_FEATURE_VOICE__REQUIRE_SUBSCRIPTION: {
            title: 'La veu requereix subscripció',
            description: 'Només els subscriptors poden fer servir la veu. Si no es defineix, producció ho exigeix i la resta de configuracions no.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_MANIFEST_BYTES: {
            title: 'Manifest de mascota màxim',
            description: 'Manifest de mascota més gran acceptat, en bytes.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_SPRITESHEET_BYTES: {
            title: 'Spritesheet de mascota màxim',
            description: 'Spritesheet de mascota més gran acceptat, en bytes.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_CANONICAL_PACKAGE_BYTES: {
            title: 'Paquet de mascota màxim',
            description: 'Paquet de mascota més gran acceptat, en bytes.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PETS_PER_ACCOUNT: {
            title: 'Mascotes importades per persona',
            description: 'Nombre màxim de mascotes importades que pot conservar una persona.',
        },
        HAPPIER_FEATURE_PETS_SYNC__MAX_IMPORTED_PET_BYTES_PER_ACCOUNT: {
            title: 'Emmagatzematge de mascotes importades per persona',
            description: 'Màxim de bytes de mascotes importades que pot conservar una persona.',
        },
        HAPPIER_FEATURE_PETS_SYNC__ENCRYPTED_CUSTOM_PET_SYNC_POLICY: {
            title: 'Mascotes personalitzades xifrades',
            description: 'Reservat per al futur. Les mascotes personalitzades xifrades encara no se sincronitzen, així que queda desactivat.',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES: {
            title: 'Transferència màxima a través d’aquest Home',
            description: 'Fitxer més gran que porta una transferència a través d’aquest Home, en bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_ACTIVE_TRANSFERS_PER_SOCKET: {
            title: 'Transferències simultànies per connexió',
            description: 'Màxim de transferències a través d’aquest Home que una connexió executa alhora.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES: {
            title: 'Dades per túnel',
            description: 'Màxim de bytes que porta un túnel a través d’aquest Home.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_ACTIVE_TUNNELS_PER_SOCKET: {
            title: 'Túnels per connexió',
            description: 'Màxim de túnels a través d’aquest Home que una connexió manté oberts.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: 'Trama de túnel màxima',
            description: 'Trama més gran que porta un túnel a través d’aquest Home, en bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__SUPPORTED_ENCODINGS: {
            title: 'Codificacions de túnel',
            description: 'Codificacions de trama que accepten els túnels a través d’aquest Home. Buit fa servir les estàndard.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__PREFERRED_ENCODING: {
            title: 'Codificació de túnel preferida',
            description: 'La codificació de trama que s’ha de fer servir primer. Ha de ser una de les codificacions acceptades.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BINARY_HEADER_BYTES: {
            title: 'Capçalera de trama màxima',
            description: 'Capçalera binària de trama més gran, en bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_RAW_PAYLOAD_BYTES: {
            title: 'Càrrega útil de trama màxima',
            description: 'Càrrega útil en brut més gran d’una trama, en bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_FRAMED_MESSAGE_BYTES: {
            title: 'Missatge en trames màxim',
            description: 'Missatge dividit en trames més gran, en bytes.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_CONCURRENT_SUBSTREAMS: {
            title: 'Fluxos simultanis per túnel',
            description: 'Màxim de fluxos que un túnel executa alhora.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_TOTAL_SUBSTREAMS: {
            title: 'Fluxos per túnel',
            description: 'Màxim de fluxos que un túnel obre al llarg de la seva vida.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_BYTES_PER_SUBSTREAM: {
            title: 'Dades per flux',
            description: 'Màxim de bytes que porta un flux.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_AGGREGATE_BYTES: {
            title: 'Dades per túnel, tots els fluxos',
            description: 'Màxim de bytes que porten junts tots els fluxos d’un túnel.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SUBSTREAM_IDLE_MS: {
            title: 'Temps límit de flux inactiu',
            description: 'Quant temps pot estar inactiu un flux abans de tancar-se, en mil·lisegons.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_SERVER_ROUTED__MAX_SESSION_IDLE_MS: {
            title: 'Temps límit de túnel inactiu',
            description: 'Quant temps pot estar inactiu un túnel a través d’aquest Home abans de tancar-se, en mil·lisegons.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_IDLE_MS: {
            title: 'Temps límit d’inactivitat del túnel',
            description: 'Quant temps pot estar inactiu un túnel abans de tancar-se, en mil·lisegons.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL__MAX_DURATION_MS: {
            title: 'Durada màxima del túnel',
            description: 'Temps màxim que un túnel està obert, en mil·lisegons.',
        },
        HAPPIER_FEATURE_MACHINES_TUNNEL_ALLOWED_PORTS: {
            title: 'Ports accessibles pels túnels',
            description: 'Ports que poden obrir els túnels. Buit només permet els predeterminats.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__TOKEN_TTL_MS: {
            title: 'Durada de l’enllaç de previsualització',
            description: 'Quant temps funciona un enllaç de previsualització privat, en mil·lisegons.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PREVIEW__HOST_ORIGIN_DOMAIN: {
            title: 'Domini de previsualització',
            description: 'Domini que serveix cada previsualització a la seva pròpia adreça. Buit serveix les previsualitzacions sota l’adreça d’aquest Home.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOWED_MODES: {
            title: 'Modes de previsualització pública',
            description: 'Maneres de fer pública una previsualització.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_TTL_MS: {
            title: 'Previsualització pública més llarga',
            description: 'Temps màxim que una previsualització és pública, en mil·lisegons. Buit manté el límit estàndard.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__MAX_CONCURRENT_EXPOSURES: {
            title: 'Previsualitzacions públiques simultànies',
            description: 'Màxim de previsualitzacions públiques alhora. Buit manté el límit estàndard.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__DNS_TLS_REQUIRED: {
            title: 'Exigeix DNS i TLS',
            description: 'Les previsualitzacions públiques necessiten DNS i TLS.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_SINK: {
            title: 'Registre d’auditoria de previsualitzacions públiques',
            description: 'On es registren les previsualitzacions públiques. Les previsualitzacions públiques en necessiten un.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__AUDIT_LOG_PATH: {
            title: 'Fitxer del registre d’auditoria',
            description: 'Fitxer on s’escriu el registre d’auditoria de les previsualitzacions públiques.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_AUDIT_SINK: {
            title: 'Permet el registre d’auditoria de prova',
            description: 'Només per a desenvolupament: accepta el registre d’auditoria de prova en memòria. S’ignora en producció.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_PROFILE_IDS: {
            title: 'Límits de peticions de previsualitzacions públiques',
            description: 'Perfils de límit de peticions que poden fer servir les previsualitzacions públiques.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_CHECKER: {
            title: 'Verificador de límit de peticions',
            description: 'Com es limiten les peticions a les previsualitzacions públiques. Les previsualitzacions públiques en necessiten un.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_MAX_REQUESTS: {
            title: 'Peticions per finestra',
            description: 'Peticions que permet una previsualització pública en cada finestra.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__RATE_LIMIT_WINDOW_MS: {
            title: 'Finestra de límit de peticions',
            description: 'Durada de cada finestra de límit de peticions, en mil·lisegons.',
        },
        HAPPIER_FEATURE_LOCAL_SERVICES_PUBLIC_PREVIEW__ALLOW_TEST_RATE_LIMIT_CHECKER: {
            title: 'Permet el limitador de peticions de prova',
            description: 'Només per a desenvolupament: accepta el limitador de peticions de prova en memòria. S’ignora en producció.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_REQUESTS: {
            title: 'Webhooks en curs',
            description: 'Màxim de peticions de webhook que aquest servidor gestiona alhora.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__PROCESS_MAX_WORKING_BYTES: {
            title: 'Memòria de webhooks',
            description: 'Màxim de memòria que poden fer servir les peticions de webhook en curs, en bytes. Buit permet el que ja permet el límit de peticions.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_RATE_PER_MINUTE: {
            title: 'Webhooks per minut per ruta',
            description: 'Peticions de webhook per minut en una ruta.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ROUTE_CONCURRENCY: {
            title: 'Webhooks simultanis per ruta',
            description: 'Peticions de webhook en curs en una ruta.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_RATE_PER_MINUTE: {
            title: 'Webhooks per minut per endpoint',
            description: 'Peticions de webhook per minut en un endpoint.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ENDPOINT_CONCURRENCY: {
            title: 'Webhooks simultanis per endpoint',
            description: 'Peticions de webhook en curs en un endpoint.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_RATE_PER_MINUTE: {
            title: 'Webhooks per minut per persona',
            description: 'Peticions de webhook per minut per a una persona.',
        },
        HAPPIER_FEATURE_PLUGINS_WEBHOOKS__ACCOUNT_CONCURRENCY: {
            title: 'Webhooks simultanis per persona',
            description: 'Peticions de webhook en curs per a una persona.',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES: {
            title: 'Paquet de pantalla de plugin màxim',
            description: 'Paquet de pantalla de plugin més gran que allotja aquest Home, en bytes.',
        },
        HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES: {
            title: 'Emmagatzematge de pantalles de plugins per persona',
            description: 'Màxim de bytes de paquets de pantalles de plugins que pot desar una persona.',
        },
        HAPPIER_COLLECTION_MAX_ROW_ENCODED_BYTES: {
            title: 'Fila de dades de plugin màxima',
            description: 'Fila més gran que desa un plugin, en bytes.',
        },
        HAPPIER_COLLECTION_MAX_BATCH_BYTES: {
            title: 'Lot de dades de plugin màxim',
            description: 'Lot més gran de canvis de dades de plugins, en bytes.',
        },
        HAPPIER_COLLECTION_MAX_BATCH_ROWS: {
            title: 'Files per lot de dades de plugin',
            description: 'Màxim de files en un lot de canvis de dades de plugins.',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: {
            title: 'Files de dades de plugins per persona',
            description: 'Màxim de files de dades de plugins que pot desar una persona.',
        },
        HAPPIER_COLLECTION_MAX_ACCOUNT_BYTES: {
            title: 'Emmagatzematge de dades de plugins per persona',
            description: 'Màxim de bytes de dades de plugins que pot desar una persona.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_BITRATE_BPS: {
            title: 'Taxa de bits màxima de la transmissió',
            description: 'Taxa de bits màxima d’una transmissió en directe a través d’aquest Home, en bits per segon.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAMES_PER_SECOND: {
            title: 'Fotogrames per segon màxims de la transmissió',
            description: 'Fotogrames per segon màxims d’una transmissió en directe a través d’aquest Home.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_FRAME_BYTES: {
            title: 'Fotograma de transmissió màxim',
            description: 'Fotograma més gran d’una transmissió en directe a través d’aquest Home, en bytes.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_DURATION_MS: {
            title: 'Transmissió en directe més llarga',
            description: 'Temps màxim que dura una transmissió en directe a través d’aquest Home, en mil·lisegons.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_TOTAL_BYTES: {
            title: 'Dades per transmissió en directe',
            description: 'Màxim de bytes que porta una transmissió en directe a través d’aquest Home.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_ACCOUNT: {
            title: 'Transmissions simultànies per persona',
            description: 'Màxim de transmissions en directe a través d’aquest Home que una persona executa alhora.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_SOCKET: {
            title: 'Transmissions simultànies per connexió',
            description: 'Màxim de transmissions en directe a través d’aquest Home que una connexió executa alhora.',
        },
        HAPPIER_FEATURE_MACHINES_LIVE_STREAM_SERVER_ROUTED__MAX_CONCURRENT_STREAMS_PER_MACHINE: {
            title: 'Transmissions simultànies per màquina',
            description: 'Màxim de transmissions en directe a través d’aquest Home que una màquina executa alhora.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: {
            title: 'ID de la clau de signatura de connexions',
            description: 'Identifica la clau que signa les connexions entre màquines. Sense clau de signatura, aquestes connexions queden desactivades.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: {
            title: 'Clau privada de signatura de connexions',
            description: 'Clau privada que signa les connexions entre màquines.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PUBLIC_KEY: {
            title: 'Clau pública de signatura de connexions',
            description: 'Clau pública que correspon a la clau de signatura. Si és buida, s’obté de la clau privada.',
        },
        HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_EXPIRES_AT: {
            title: 'Caducitat de la clau de signatura',
            description: 'Quan caduca la clau de signatura, com a marca de temps en mil·lisegons.',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__ALLOW_USERNAME: {
            title: 'Troba amics pel nom d’usuari',
            description: 'Les persones poden trobar amics pel nom d’usuari, a més de pel compte vinculat.',
        },
        HAPPIER_FEATURE_SOCIAL_FRIENDS__IDENTITY_PROVIDER: {
            title: 'Proveïdor per identificar amics',
            description: 'El proveïdor d’inici de sessió que s’utilitza per identificar amics.',
        },
    },
};

const homeFeatureTranslations = { ca } as const;

return { homeFeatureTranslations };
})();

const Domain_homeGovernanceTranslations = (() => {
const en = Shared_homeGovernanceTranslations.en;

const ca: typeof en = {
    title: 'Administració del Home',
    pages: {
        features: 'Què ofereix aquest Home. Un canvi s’aplica arreu a la propera actualització.',
        data: 'Què conserva aquest Home i durant quant de temps.',
        homes: 'Comptes, rols, equips i regles d’inici de sessió de cada Home que administres.',
        overview: 'Qui administra aquest Home i què hi pots canviar.',
        people: 'Els comptes d’aquest Home, els seus rols i si poden iniciar sessió.',
        policies: 'Qui pot iniciar sessió, qui pot crear comptes i equips, i com es protegeixen les dades.',
        teams: 'Tots els equips d’aquest Home. Administrar un equip no et dona accés a les seves sessions.',
        identityProvider: 'Un servei d’identitat amb què es pot iniciar sessió en aquest Home.',
        identityProviderEditor: 'Com es connecta aquest servei d’identitat i a qui admet.',
        githubApp: 'Una GitHub App que aquest Home fa servir per accedir als repositoris.',
        githubAppEditor: 'Registra o canvia una GitHub App per a aquest Home.',
        email: 'Com envia correus aquest Home.',
        reach: 'Com troben aquest Home els dispositius, els enllaços d’invitació i els correus.',
        runtime: 'El servidor que executa aquest Home.',
        activity: 'Qui ha canviat què en aquest Home, i quan.',
    },
    overview: 'Resum',
    people: 'Persones',
    teams: 'Equips',
    policies: 'Polítiques',
    console: {
        serverSettings: 'Configuració del servidor',
        serverSettingsDescription: 'Cada paràmetre que llegeix el servidor i quan s’aplica un canvi.',
        allHomes: 'Tots els Homes',
        backToHomes: 'Torna als Homes',
        viewerOwner: 'Ets el propietari',
        viewerAdmin: 'Ets administrador',
        noOwnerYet: 'Encara sense propietari',
        administer: 'Administra',
        navigation: 'Pàgines d’administració del Home',
    },
    /** The console Overview (lab `hcOverview-A`): what needs the owner, who owns the Home, and its facts. */
    overviewPage: {
        description: 'Qui gestiona aquest Home i què necessita de tu.',
        attention: 'Requereix la teva atenció',
        emailNotSetUpTitle: 'El correu no està configurat',
        emailNotSetUpBody: 'Ningú pot verificar la seva adreça, restablir una contrasenya ni rebre invitacions per correu.',
        emailNoLinkTitle: 'Els correus encara no poden incloure enllaços',
        emailNoLinkBody: 'L’enviament està configurat, però aquest Home no té cap adreça de l’app web per als enllaços.',
        emailPasswordTitle: 'No es pot llegir la contrasenya del correu',
        emailPasswordBody: 'Torna a introduir la contrasenya SMTP perquè aquest Home pugui enviar correus.',
        setUpEmail: 'Configura el correu',
        openEmail: 'Obre Correu',
        noAddressTitle: 'Sense adreça pública',
        noAddressBody: 'Els dispositius d’altres xarxes i els enllaços d’invitació no poden arribar a aquest Home.',
        setUpReach: 'Configura',
        pendingBody: 'Desat, a l’espera que el servidor es reiniciï.',
        fixedBody: 'Definits a l’entorn del servidor; canvia’ls allà.',
        review: 'Revisa',
        settingsFailed: 'No s’han pogut comprovar els ajustos d’aquest Home',
        emailFailed: 'No s’ha pogut llegir l’estat del correu d’aquest Home',
        reachFailed: 'No s’ha pogut llegir com s’arriba a aquest Home',
        ownership: 'Propietat',
        ownerYou: 'Propietari · tu',
        peopleFailed: 'No s’han pogut llegir les persones d’aquest Home',
        thisHome: 'Aquest Home',
        version: 'Versió',
        signIn: 'Inici de sessió',
        signInOpen: 'qualsevol pot crear un compte',
        signInInvited: 'només amb invitació',
        signInNone: 'No hi ha cap mètode d’inici de sessió actiu',
        fixedTitle: ({ count }: { count: number }) => (count === 1 ? '1 ajust el fixa el teu desplegament' : `${count} ajustos els fixa el teu desplegament`),
        /** People · owners · admins; `more` while the Home has further pages, `admins` null when unknown. */
        peopleSummary: ({ people, more, owners, admins }: { people: number; more: boolean; owners: number; admins: number | null }) => [`${people}${more ? '+' : ''} ${people === 1 && !more ? 'persona' : 'persones'}`, `${owners} ${owners === 1 ? 'propietari' : 'propietaris'}`, admins === null ? null : `${admins} ${admins === 1 ? 'admin' : 'admins'}`].filter((part) => part !== null).join(' · '),
    },
    /** "Invite people" on Overview, People and Teams: one dialog over the Team invitation form. */
    invite: {
        action: 'Convida persones',
        description: 'Les persones s’uneixen a aquest Home unint-se a un dels seus equips.',
        team: 'Equip',
        noTeams: 'Encara no hi ha cap equip al qual puguis convidar',
        noTeamsBody: 'Les persones s’uneixen a un Home a través d’un equip. Crea’n un primer.',
        notAdministered: 'No pots convidar als equips d’aquest Home',
        notAdministeredBody: 'Els propietaris i admins de cada equip hi conviden les persones. Demana-ho a algun d’ells o crea el teu propi equip.',
        createTeam: 'Crea un equip',
        notAdministeredAskBody: 'Els propietaris i admins de cada equip hi conviden les persones; demana-ho a algun d’ells.',
        joinByTeam: 'Les persones s’uneixen a un Home a través d’un equip.',
        teamsFailed: 'No s’han pogut llegir els equips d’aquest Home',
    },

    yourRole: 'El teu rol',
    roleOwner: 'Propietari',
    roleAdmin: 'Administrador',
    roleMember: 'Membre',
    activeOwners: 'Propietaris actius',
    accountSection: 'Compte',
    accountAccessSection: 'Accés',
    homeAddress: 'Adreça del Home',

    setupRequiredTitle: 'Cal configurar l’administració del Home',
    setupRequiredBody: 'Aquest Home encara no té cap propietari actiu. Algú amb accés al servidor assigna el primer propietari des de la màquina que l’executa.',

    manageTeams: 'Gestiona els equips',
    manageTeamsSubtitle: 'Administra els equips d’aquest Home. Això no et dona accés a les seves sessions.',
    teamsDisabled: 'Els equips no estan habilitats en aquest Home.',
    teamsEmpty: 'Encara no hi ha equips en aquest Home.',

    loading: 'S’està carregant aquest Home…',
    refreshing: 'S’està actualitzant…',
    updating: 'Actualitzant…',
    staleNotice: 'Es mostra l’últim estat conegut d’aquest Home. No es poden fer canvis fins que torni a respondre.',
    offlineNotice: 'Aquest Home no respon. Pots continuar llegint, però no fer canvis.',
    unavailableTitle: 'Aquest Home no està disponible',
    unavailableBody: 'El Happier no ha pogut llegir l’estat d’administració d’aquest Home.',
    forbiddenTitle: 'No pots administrar aquest Home',
    forbiddenBody: 'El teu compte no té autoritat d’administració aquí.',
    retry: 'Torna-ho a provar',
    loadMore: 'Carrega’n més',
    unsupportedBody: 'Aquest Home no ofereix administració. Pot estar executant una versió anterior.',
    notObservedTitle: 'Encara no s’ha carregat',
    notObservedBody: 'Aquest Home encara no ha comunicat el seu estat d’administració a aquest dispositiu.',
    lastUpdated: ({ time }: { time: string }) => `Actualitzat ${time}`,

    chooseHome: 'Tria un Home',
    chooseHomeFooter: 'Cada Home té els seus propis comptes, rols i polítiques.',
    homesEmpty: 'Encara no hi ha Homes',
    homesEmptyBody: 'Afegeix un Home a aquest dispositiu per administrar-lo aquí.',
    homesNoneAdministrable: 'Cap Home per administrar',
    homesNoneAdministrableBody: 'Cap dels Homes que estàs veient dóna autoritat d’administració a aquest compte.',
    homeNotAnswering: ({ home }: { home: string }) => `${home} no respon`,
    signedOutTitle: 'Sessió tancada en aquest Home',
    signedOutBody: 'Torna a iniciar la sessió en aquest Home per administrar-lo.',
    credentialUnreadableTitle: 'No s’ha pogut llegir l’inici de sessió desat en aquest dispositiu',
    credentialUnreadableBody: 'El problema és d’aquest dispositiu, no del Home, i no s’ha tancat la teva sessió. Torna-ho a provar.',
    credentialUnreadableInviteBody: 'El problema és d’aquest dispositiu, no del Home. El teu enllaç d’invitació continua funcionant, així que pots tornar-ho a provar ara o més tard.',

    peopleEmpty: 'Encara no hi ha comptes en aquest Home.',
    rosterUnavailableTitle: 'La llista de persones encara no està disponible',
    rosterUnavailableBody: 'Aquest Home encara no proporciona la llista de comptes al Happier. Els rols i els estats hi apareixeran quan ho faci.',
    accountUnavailableBody: 'Aquest compte encara no està disponible des d’aquest Home.',
    searchPlaceholder: 'Cerca comptes',
    searchResults: 'Resultats de la cerca',
    searchResultsFooter: 'Obre un compte per veure’n el rol i l’estat.',
    searchEmpty: 'Cap compte no coincideix amb aquesta cerca.',
    searchUnsupported: 'La cerca no està disponible en aquest Home',
    searchUnsupportedBody: 'Aquest Home no ofereix cerca de comptes. Pot ser que faci servir una versió anterior.',
    searchFailed: 'No s’ha pogut completar la cerca',
    searchFailedBody: 'Aquest Home no ha respost a la cerca. Canvia el text per tornar-ho a provar.',

    statusActive: 'Actiu',
    statusDisabled: 'Desactivat',
    statusRetired: 'Retirat',
    statusDisabledDetail: 'Sessió tancada a tot arreu. Es pot tornar a activar.',
    statusRetiredDetail: 'Accés revocat permanentment.',

    changeRole: 'Canvia el rol',
    disable: 'Desactiva el compte',
    enable: 'Torna a activar el compte',
    deleteAccount: 'Elimina el compte i les dades…',
    retryDeletion: 'Torna a provar l’eliminació',

    reasonLastActiveOwner: 'Aquest Home necessita almenys un propietari actiu. Fes propietari un altre compte primer.',
    reasonTargetInactive: 'Només un compte actiu pot tenir un rol al Home.',
    reasonHomeUnreachable: 'Aquest Home no respon. Els canvis seran possibles després de reconnectar.',

    roleSheetTitle: 'Rol al Home',
    roleOwnerDescription: 'Pot administrar-ho tot en aquest Home, inclosa l’eliminació de comptes.',
    roleAdminDescription: 'Pot administrar comptes i equips, però no canviar propietaris.',
    roleMemberDescription: 'Sense autoritat d’administració del Home.',

    disableTitle: ({ account }: { account: string }) => `Vols desactivar ${account}?`,
    disableBody: 'Se li tancarà la sessió a tots els dispositius i les seves màquines es desconnectaran. Els tokens d’accés personal es revoquen permanentment, s’elimina la responsabilitat de les sessions i, a cada sessió a la qual perdi l’accés, els seus esborranys sense enviar es descarten i el seu seguiment s’elimina. Tornar a activar-lo recupera l’accés, però no aquests esborranys, el seguiment ni la responsabilitat. La pertinença als equips i les claus de xifratge es mantenen.',
    disableConfirm: 'Desactiva',
    enableTitle: ({ account }: { account: string }) => `Vols tornar a activar ${account}?`,
    enableBody: 'Podrà iniciar la sessió de nou als seus dispositius. Els testimonis d’accés revocats continuen revocats.',
    enableConfirm: 'Torna a activar',
    deleteTitle: ({ account }: { account: string }) => `Vols eliminar ${account} i totes les seves dades?`,
    deleteBody: ({ home }: { home: string }) => `Això elimina permanentment el compte i les seves dades a ${home}. No es pot desfer. La propietat del Home o d’equips s’ha de transferir abans.`,
    deleteConfirm: 'Elimina',

    deleteIncompleteTitle: 'L’eliminació no s’ha completat',
    deleteIncompleteBody: 'L’accés s’ha revocat i aquest compte ara està retirat, però la neteja no ha acabat. Torna a provar l’eliminació per completar-la.',
    deleteIncompleteMemberBody: 'L’accés s’ha revocat, però la neteja no ha acabat. Un propietari del Home o l’operador del servidor la pot completar.',

    errorForbidden: 'Ja no tens autoritat per a aquest canvi en aquest Home.',
    errorOwnerTransferRequired: 'Aquest Home necessita almenys un propietari actiu. Fes propietari un altre compte primer.',
    errorTeamOwnerTransferRequired: 'Un equip encara necessita aquest compte com a propietari. Dona primer un altre propietari a aquest equip.',
    errorAccountNotFound: 'Aquest compte ja no existeix en aquest Home.',
    errorAccountInactive: 'Aquest compte no està actiu, així que no pot rebre aquesta autoritat.',
    errorErasureTransitionCleanupPending: 'La supressió del compte espera la neteja del xifratge. Torna a provar de suprimir el compte.',
    errorGeneric: 'Aquest Home no ha pogut completar el canvi. No s’ha canviat res.',
    errorConflict: 'Aquí s’ha canviat una altra cosa abans. Actualitza aquest Home i torna-ho a provar.',
    changeFailedTitle: 'El canvi no s’ha dut a terme',
    errorOutcomeUnknownTitle: 'Aquest canvi no s’ha confirmat',
    errorOutcomeUnknown: 'La sol·licitud ha arribat a aquest Home, però se n’ha perdut la resposta. Pot ser que s’hagi aplicat. Actualitza aquest Home i comprova-ho abans de tornar-ho a provar.',

    teamCreation: 'Creació d’equips',
    teamCreationSelfService: 'Tothom pot crear equips',
    teamCreationSelfServiceDescription: 'Els membres actius d’aquest Home poden crear un equip i ser-ne propietaris.',
    teamCreationManagedOnly: 'Els administradors creen els equips',
    teamCreationManagedOnlyDescription: 'Els propietaris i administradors creen equips i trien el propietari inicial.',
    teamCreationDisabled: 'Creació d’equips desactivada',
    teamCreationDisabledDescription: 'Cap equip nou. Els equips existents no canvien.',
    teamsVisibility: 'Qui veu els equips',
    teamsVisibleToMembers: 'Mostra els equips als membres',
    teamsVisibleToMembersDescription: 'Si està desactivat, només els membres d’un equip i els administradors veuen els equips.',
    teamJit: 'Pertinença automàtica a l’equip en iniciar la sessió',
    teamJitDescription: 'Iniciar la sessió a través del proveïdor d’identitat connectat d’un equip incorpora aquesta persona a l’equip automàticament, sense invitació ni aprovació.',
    githubEnterpriseOrigins: 'Hosts de GitHub Enterprise aprovats',
    githubEnterpriseOriginsDescription: 'Un origen HTTPS canònic per línia. Els equips només poden connectar GitHub Apps a aquests hosts.',
    githubEnterpriseOriginsInvalid: 'Utilitza orígens HTTPS únics sense camins, consultes, credencials ni fragments.',

    signInTitle: 'Inici de sessió i admissió',
    authActionLogin: 'Inici de sessió',
    authActionProvision: 'Comptes nous',
    authActionConnect: 'Vinculació de comptes',
    authReasonMethodNotEnabled: 'El mètode d’inici de sessió està desactivat',
    authReasonProvisioningNotEnabled: 'La creació de comptes està desactivada',
    authReasonAccountModeUnavailable: 'El tipus de compte no està disponible',
    authReasonEmailDeliveryUnavailable: 'L’enviament de correu no està disponible',
    authInherited: 'S’usen els valors del servidor',
    authInheritedDescription: 'Aquest Home no restringeix els mètodes d’inici de sessió ni els tipus de compte.',
    authNarrowed: 'Restringit per aquest Home',
    authUnreadable: 'La configuració necessita atenció',
    authUnreadableDescription: 'Aquest Home desa una configuració d’inici de sessió que aquesta versió del servidor no pot llegir. L’inici de sessió no estarà disponible fins que l’operador la repari.',
    signInMethods: 'Mètodes d’inici de sessió',
    accountModes: 'Tipus de compte',
    accountModePlain: 'Simple',
    accountModeE2ee: 'Xifrat d’extrem a extrem',
    recommendedMode: 'Recomanat per als comptes nous',
    recommendedModeDescription: 'Defineix el valor predeterminat per als comptes nous. Els comptes existents no canvien.',
    admissionSelfService: 'Qualsevol',
    admissionInvitationOnly: 'Només amb invitació',
    admissionClosed: 'Ningú',

    deploymentServices: 'Serveis del desplegament',
    deploymentServicesDescription: 'Serveis d’identitat que l’operador configura per a aquest servidor. No es poden canviar des de l’administració del Home.',
    deploymentWorkosConfigured: 'Configurat',
    deploymentWorkosPartial: 'Configuració incompleta',
    deploymentWorkosNotConfigured: 'Sense configurar',
    privateEndpoints: 'Punts d’identitat privats',
    privateEndpointsDescription: 'Permet que l’inici de sessió gestionat arribi a proveïdors d’identitat en xarxes privades. Només són accessibles els amfitrions, xarxes i ports d’aquesta llista.',
    privateEndpointsPublicOnly: 'Només punts públics',
    privateEndpointsAllowlist: 'Llista privada permesa',
    privateEndpointsHostnames: 'Amfitrions permesos',
    privateEndpointsCidrs: 'Xarxes permeses (CIDR)',
    privateEndpointsPorts: 'Ports permesos',
    privateEndpointsSave: 'Desa la política de xarxa',
    privateEndpointsInvalid: 'Indica com a mínim un amfitrió o xarxa, i un port entre 1 i 65535.',
    privateEndpointsUnreadable: 'Aquest Home desa una política de xarxa que aquesta versió del servidor no pot llegir. L’inici de sessió gestionat es queda només amb punts públics.',

    policyReadOnly: 'Només un propietari del Home ho pot canviar.',
    policyEditingUnavailable: 'Encara no es poden canviar les polítiques des d’aquest dispositiu.',
    revisionConflictTitle: 'Aquesta política ha canviat en un altre lloc',
    revisionConflictBody: 'Algú altre ha desat un canvi mentre editaves. La teva tria es manté: torna a carregar aquest Home i aplica-la de nou.',
    reload: 'Torna a carregar',
    person: {
        you: 'tu',
        roleDescription: 'Els membres fan servir el Home; els administradors també gestionen persones i Teams.',
        roleChangeTitle: ({ account, role }: { account: string; role: string }) => `Fer ${account} ${role}?`,
        roleChangeBody: 'El seu accés a aquest Home canvia immediatament. Queda registrat a l’Activitat amb el teu nom.',
        roleChangeConfirm: 'Canvia el rol',
        signIn: 'Inici de sessió',
        signInDescription: 'Amb què pot iniciar la sessió. Ho gestiona al seu propi compte.',
        methods: 'Mètodes',
        linkedProviders: 'Proveïdors vinculats',
        none: 'Cap',
        teams: 'Teams',
        noTeams: 'No és a cap Team',
        teamArchived: 'Team arxivat',
        teamSuspended: 'suspès',
        access: 'Accés',
        accessDescription: 'Sessió iniciada als seus dispositius — les sessions no es registren una a una.',
        machines: 'Màquines',
        apiTokens: 'Tokens d’API',
        apiTokensLastUsed: ({ time }: { time: string }) => `Darrer ús ${time}`,
        apiTokensNeverUsed: 'Mai utilitzat',
        signOutEverywhere: 'Tanca la sessió a tot arreu',
        signOutEverywhereDescription: 'Tanca totes les sessions obertes a tots els seus dispositius. Els tokens d’API continuen funcionant fins que es desactiva el compte.',
        signOutEverywhereTitle: ({ account }: { account: string }) => `Vols tancar la sessió de ${account} a tot arreu?`,
        signOutEverywhereBody: 'Cada dispositiu on tingui la sessió iniciada l’haurà de tornar a iniciar. Els seus tokens d’API continuen funcionant fins que desactivis el compte. Queda registrat a l’Activitat amb el teu nom.',
        signOutEverywhereDone: 'Sessió tancada a tot arreu',
        recentActivity: 'Activitat recent',
        noRecentActivity: 'Encara no hi ha canvis d’administració sobre aquesta persona.',
        showAllActivity: 'Mostra-ho tot',
        disableOrDelete: 'Desactiva o elimina',
        dangerFootnote: 'Desactivar-lo tanca la sessió i atura els tokens d’API; es pot desfer. Eliminar-lo esborra per sempre el compte i les dades d’aquest Home.',
    },
    email: {
        title: 'Correu',
        status: 'Estat',
        sendingMail: 'Enviament de correu',
        sendingReady: ({ host }: { host: string }) => `A punt · envia a través de ${host}`,
        sendingNotSetUp: 'Sense configurar',
        links: 'Enllaços als correus',
        linksReady: 'S’obren a l’app web d’aquest Home',
        linksOpenAt: ({ host }: { host: string }) => `S’obren a ${host}`,
        setInReach: 'Defineix-ho a Accés',
        linksMissing: 'No hi ha adreça de l’app web, així que no es poden crear enllaços',
        mailServer: 'Servidor de correu',
        mailServerDescription: 'El servidor SMTP que envia els correus de verificació, de restabliment de contrasenya i d’invitació.',
        server: 'Servidor',
        port: 'Port',
        portAndSecurity: 'Port i seguretat',
        security: 'Seguretat de la connexió',
        tls: 'TLS',
        starttls: 'STARTTLS',
        username: 'Nom d’usuari',
        password: 'Contrasenya',
        passwordDescription: 'Es desa xifrada al servidor. No es torna a mostrar mai.',
        saved: 'Desada',
        replace: 'Substitueix',
        clear: 'Treu',
        keep: 'Conserva',
        clearPending: 'La contrasenya desada es traurà en desar.',
        valueSet: 'Definida',
        valueNotSet: 'Sense definir',
        sender: 'Remitent',
        fromAddress: 'Adreça del remitent',
        fromName: 'Nom del remitent',
        test: 'Envia un correu de prova',
        testDescription: 'Envia un missatge curt sense enllaços.',
        testTo: 'Per a',
        testToPlaceholder: 'Qualsevol adreça que puguis revisar',
        testSend: 'Envia',
        testSaveFirst: 'Desa els canvis abans d’enviar una prova.',
        testSent: ({ to }: { to: string }) => `Enviat a ${to}`,
        testSentDetail: 'Mira la safata d’entrada i, si no hi és, la carpeta de correu brossa.',
        testFailed: 'No s’ha pogut enviar',
        testNotConfigured: 'El correu encara no està configurat.',
        testPasswordUnreadable: 'No es pot llegir la contrasenya desada. Torna-la a introduir.',
        testRenderFailed: 'No s’ha pogut preparar el missatge de prova.',
        testTransportFailed: 'No s’ha pogut contactar amb el servidor de correu o ha rebutjat el missatge.',
        adminTitle: 'Només els propietaris poden canviar la configuració de correu',
        adminBody: 'La pots veure perquè ets admin d’aquest Home.',
        notSetUpTitle: 'El correu no està configurat',
        notSetUpBody: 'El restabliment de contrasenyes, la verificació per correu i les invitacions per correu estan desactivats fins que ho estigui.',
        unreadableTitle: 'No es pot llegir la contrasenya desada',
        unreadableBody: 'El secret mestre del servidor ha canviat des que es va desar. Torna a introduir la contrasenya.',
        invalidValue: 'Introdueix un valor vàlid.',
        invalidPort: 'Fes servir un port de l’1 al 65535.',
        invalidEmail: 'Introdueix una adreça de correu.',
        conflictTitle: 'La configuració de correu ha canviat en un altre lloc',
        conflictBody: 'Algú ha desat un canvi mentre editaves. Els teus canvis es conserven: revisa’ls i torna a desar.',
        loadFailed: 'Aquest Home no ha retornat la seva configuració de correu.',
    },
    signInProviders: {
        title: 'Proveïdors d’inici de sessió',
        description: 'Inici de sessió corporatiu, GitHub Apps i les regles que fan servir els Teams. Activa un proveïdor per iniciar sessió a Polítiques.',
        ownersOnlyTitle: 'Només els propietaris poden canviar els proveïdors d’inici de sessió',
        ownersOnlyBody: 'Demana a un propietari d’aquest Home que afegeixi o canviï proveïdors d’identitat i GitHub Apps.',
        fromDeployment: ({ key }: { key: string }) => `Del teu desplegament · ${key} · només lectura`,
        workosSetByDeployment: ({ keys }: { keys: string }) => `Definit pel teu desplegament (${keys})`,
        workosSetInServerSettings: ({ keys }: { keys: string }) => `Definit a Configuració del servidor (${keys})`,
        privateEndpointsFixed: ({ key }: { key: string }) => `Fixat pel teu desplegament · ${key}`,
        privateEndpointsOff: ({ key }: { key: string }) => `Desactivat en aquest Home · ${key}`,
        teamRules: 'Regles d’inici de sessió dels Teams',
        teamRulesDescription: 'El que els Teams poden afegir als proveïdors del Home.',
        activity: {
            addedProvider: ({ name }: { name: string }) => `ha afegit el proveïdor d’identitat ${name}`,
            changedProvider: ({ name }: { name: string }) => `ha canviat el proveïdor d’identitat ${name}`,
            replacedProviderSecret: ({ name }: { name: string }) => `ha substituït el secret de client de ${name}`,
            enabledProvider: ({ name }: { name: string }) => `ha activat ${name}`,
            disabledProvider: ({ name }: { name: string }) => `ha desactivat ${name}`,
            removedProvider: ({ name }: { name: string }) => `ha eliminat el proveïdor d’identitat ${name}`,
            addedGitHubApp: ({ name }: { name: string }) => `ha afegit la GitHub App ${name}`,
            changedGitHubApp: ({ name }: { name: string }) => `ha canviat la GitHub App ${name}`,
            replacedGitHubAppSecrets: ({ name }: { name: string }) => `ha substituït els secrets de la GitHub App ${name}`,
            verifiedGitHubApp: ({ name, organization }: { name: string; organization: string }) => `ha verificat ${name} a ${organization}`,
            removedGitHubAppInstallation: ({ name, organization }: { name: string; organization: string }) => `ha tret ${name} de ${organization}`,
        },
    },
    reach: {
        title: 'Accés',
        diagramTitle: ({ home }: { home: string }) => `Com arriba un dispositiu nou a ${home}`,
        yourDevices: 'Els teus dispositius',
        noAddress: 'Sense adreça pública',
        plusDirect: '+ directe (Iroh) quan és possible',
        noDirect: 'Sense connexions directes',
        thisComputer: 'Aquest ordinador',
        homeServer: 'Servidor d’aquest Home',
        diagramDeployment: 'Fixada pel teu desplegament',
        diagramHere: 'Definida aquí',
        diagramInferred: ({ method }: { method: string }) => `${method} · deduïda`,
        addresses: 'Adreces',
        addressesDescription: 'Canviar una adreça no tanca mai la sessió de ningú.',
        publicAddress: 'Adreça pública',
        webAppAddress: 'Adreça de l’app web',
        accessMethod: 'Mètode d’accés',
        publicAddressHome: 'Definida aquí',
        publicAddressNone: 'Sense definir. Els dispositius d’altres xarxes no poden arribar a aquest Home.',
        inferredFrom: ({ method }: { method: string }) => `Deduïda de ${method} a l’ordinador que allotja aquest Home`,
        inferredFromHost: 'Deduïda a l’ordinador que allotja aquest Home',
        webAppDescription: 'Els enllaços dels correus i les invitacions s’obren aquí.',
        webAppServed: 'Els enllaços s’obren a l’app web que serveix aquest Home.',
        webAppDefault: 'Els enllaços s’obren a l’app web de Happier. Predeterminat',
        change: 'Canvia',
        setAddress: 'Defineix l’adreça',
        httpsRequired: 'Fes servir una adreça https://.',
        invalidAddress: 'Escriu una adreça completa, com ara https://home.example.com.',
        conflict: 'La configuració d’aquest Home ha canviat. Torna-ho a provar.',
        methodLocalOnly: 'Només aquest ordinador',
        methodLan: 'Xarxa local',
        methodTailscaleServe: 'Tailscale Serve',
        methodTailscaleFunnel: 'Tailscale Funnel',
        methodCloudflare: 'Cloudflare Tunnel',
        accessMethodHere: 'Com exposa aquest ordinador el Home.',
        accessMethodRemoteHost: ({ host }: { host: string }) => `Es defineix a ${host}. Obre’l a Amfitrions remots.`,
        accessMethodElsewhereNamed: ({ host }: { host: string }) => `Es defineix a l’ordinador que allotja aquest Home (${host}). Obre-hi Happier o afegeix-lo com a amfitrió remot.`,
        accessMethodElsewhere: 'Es defineix a l’ordinador que allotja aquest Home. Obre-hi Happier o afegeix-lo com a amfitrió remot.',
        accessMethodDeployment: 'El gestiona el teu desplegament.',
        directConnections: 'Connexions directes',
        directConnectionsDescription: 'Els dispositius es connecten directament a aquest Home quan poden i, si no, fan servir l’adreça pública.',
        directConnectionsRow: 'Connexions directes (Iroh)',
        irohActive: 'Actives · els dispositius es connecten d’igual a igual quan poden',
        irohStarting: 'S’està iniciant…',
        irohOff: 'Desactivades · els dispositius es connecten per l’adreça pública',
        irohFailed: 'No s’executa en aquest ordinador. Els dispositius es connecten per l’adreça pública.',
        irohNotAvailable: 'No disponible en aquest desplegament. Els dispositius es connecten per l’adreça pública.',
        irohNeedsAddressHint: 'Defineix una adreça pública abans de desactivar-les',
        irohOffTitle: 'Vols desactivar les connexions directes?',
        irohOffBody: 'Els dispositius només es connectaran per l’adreça pública. La identitat de connexió directa actual d’aquest Home es retira per sempre; tornar-les a activar en crea una de nova, que els dispositius adopten en la connexió següent. L’adreça pública i els inicis de sessió no canvien.',
        irohOffConfirm: 'Desactiva',
        irohNeedsAddressTitle: 'Defineix primer una adreça pública',
        irohNeedsAddressBody: 'Sense una adreça pública, els dispositius no podrien arribar a aquest Home un cop desactivades les connexions directes.',
        relay: 'Relé per a connexions directes',
        relayAutomatic: 'Automàtic',
        relayOff: 'Desactivat',
        relayCustom: ({ count }: { count: number }) => `Els teus relés (${count}) · S’aplica després de reiniciar`,
        appliesAfterRestart: 'S’aplica després de reiniciar',
        appliesAfterRestartPending: 'S’aplica després de reiniciar · Pendent',
        exposureInternetTitle: ({ method }: { method: string }) => `Accessible des d’internet mitjançant ${method}`,
        exposureAddressTitle: 'La teva adreça pública està oberta a registres',
        exposureOpenSignup: 'Qualsevol que arribi a aquest Home pot crear un compte. Revisa qui s’hi pot registrar a Polítiques.',
        exposureInvitationOnly: 'Els comptes nous necessiten una invitació, així que els desconeguts no s’hi poden registrar.',
        loadFailed: 'No s’ha pogut carregar com s’accedeix a aquest Home.',
    },
    runtime: {
        title: 'Execució',
        version: 'Versió',
        versionValue: ({ version }: { version: string }) => `Happier ${version}`,
        versionUnknown: 'Aquest Home no informa de la seva versió',
        flavorLight: 'Servidor lleuger',
        flavorFull: 'Servidor complet',
        server: 'Servidor',
        restart: 'Reinicia',
        restartNow: 'Reinicia ara',
        restartFailed: 'No s’ha pogut reiniciar el servidor',
        restartToApply: 'Reinicia el servidor per aplicar-los.',
        restartFromDeployment: 'Reinicia des del teu desplegament per aplicar-los.',
        restartFromHost: ({ host }: { host: string }) => `Reinicia des de ${host}, l’ordinador que allotja aquest Home.`,
        restartFromHostingComputer: 'Reinicia des de l’ordinador que allotja aquest Home.',
        managedFrom: ({ host }: { host: string }) => `Es gestiona des de ${host}`,
        managedFromBody: 'Obre Happier a l’ordinador que allotja aquest Home per actualitzar-lo, reiniciar-lo o aturar-lo.',
        managedElsewhere: 'Es gestiona des de l’ordinador que allotja aquest Home',
        deploymentTitle: 'El gestiona el teu desplegament',
        deploymentBody: 'Les actualitzacions, els reinicis i les còpies de seguretat d’aquest servidor les fa qui el desplega.',
        backups: 'Còpies de seguretat',
        backupsHere: 'Fes còpies, restaura o mou aquest Home des de la seva pàgina d’Execució.',
        backupsFromHost: ({ host }: { host: string }) => `Fes la còpia des de ${host}, l’ordinador que allotja aquest Home.`,
        backupsFromHostingComputer: 'Fes la còpia des de l’ordinador que allotja aquest Home.',
        backupsDeployment: 'Les còpies de seguretat les gestiona el teu desplegament.',
        hostedHere: ({ home }: { home: string }) => `Aquest ordinador allotja ${home}`,
        hostedHereSubtitle: 'Actualitza’l, reinicia’l, fes-ne còpies i mou-lo des de la consola del Home.',
        pendingRestart: ({ count }: { count: number }) => (count === 1 ? '1 canvi s’aplica després de reiniciar' : `${count} canvis s’apliquen després de reiniciar`),
    },
    activity: {
        title: 'Activitat',
        emptyTitle: 'Encara no hi ha activitat',
        emptyBody: 'Els canvis a l’inici de sessió, el correu, les persones, les polítiques i la propietat apareixen aquí a mesura que passen.',
        showOlder: 'Mostra els anteriors',
        footnote: 'No es mostren les accions fetes amb Happier directament a l’ordinador amfitrió, com ara còpies de seguretat i reinicis.',
        loadFailed: 'Aquest Home no ha retornat la seva activitat.',
        deploymentCommand: 'Ordre de desplegament',
        personalHomeSetup: 'Configuració del Personal Home',
        someone: 'Algú',
        removedAccount: 'un compte eliminat',
        claimed: 'ha reclamat la propietat d’aquest Home',
        madeOwner: ({ target }: { target: string }) => `ha fet propietari ${target}`,
        assignedOwner: 'ha assignat el primer propietari',
        changedPolicies: 'ha canviat les polítiques',
        changedEmailSetting: 'ha actualitzat la configuració de correu',
        changedServerSetting: 'ha canviat la configuració del servidor',
        changedRole: ({ target }: { target: string }) => `ha canviat el rol de ${target}`,
        disabled: ({ target }: { target: string }) => `ha desactivat ${target}`,
        reenabled: ({ target }: { target: string }) => `ha reactivat ${target}`,
        changedStatus: ({ target }: { target: string }) => `ha canviat l’estat de ${target}`,
        deleted: ({ target }: { target: string }) => `ha eliminat ${target}`,
        deletionStarted: ({ target }: { target: string }) => `ha començat a eliminar ${target}`,
        signedOutEverywhere: ({ target }: { target: string }) => `ha tancat la sessió de ${target} a tot arreu`,
        areaOwnership: 'Propietat',
        areaPolicies: 'Polítiques',
        areaEmail: 'Correu',
        areaServerSettings: 'Configuració del servidor',
        areaPeople: 'Persones',
        fieldRole: 'Rol',
        fieldStatus: 'Estat',
        fieldTeamProviders: 'Proveïdors d’inici de sessió dels Teams',
        valueEmpty: '—',
        valueChanged: 'canviat',
        valueOn: 'Activat',
        valueOff: 'Desactivat',
        secretSet: 'definida',
        secretUnset: 'sense definir',
    },
    signInPolicy: {
        methodsDescription: ({ home }: { home: string }) => `Com s’inicia la sessió a ${home}. Com a mínim un mètode continua actiu i ningú perd el seu últim accés.`,
        methodUnavailable: 'No disponible — el teu desplegament no el pot oferir',
        signInService: 'Servei d’inici de sessió del Home',
        signInServiceDescription: 'Inicia la sessió amb el servei propi d’aquest Home.',
        admissionTitle: 'Qui pot crear un compte',
        newAccounts: 'Comptes nous',
        admissionAnyoneDescription: 'Qualsevol que pugui arribar a aquest Home',
        admissionInvitationDescription: 'Només persones amb una invitació d’equip',
        admissionNobodyDescription: 'Ningú pot crear un compte',
        anonymousSignup: 'Registre anònim',
        anonymousSignupDescription: 'Crea un compte només amb una clau de recuperació, sense correu.',
        encryptionTitle: 'Xifratge',
        encryptionDescription: 'S’aplica als comptes i sessions creats a partir d’ara. Els existents no canvien mai.',
        storagePolicy: 'Política d’emmagatzematge',
        storageRequired: 'E2EE obligatori',
        storageOptional: 'Opcional',
        storagePlaintext: 'Només text pla',
        storageRequiredDescription: 'Tots els comptes mantenen el xifratge d’extrem a extrem',
        storageOptionalDescription: 'Cada compte tria si xifra',
        storagePlaintextDescription: 'Els comptes desen dades sense xifratge d’extrem a extrem',
        storageAppliesAfterRestart: ({ running }: { running: string }) => `S’aplica després de reiniciar · fins llavors ${running}`,
        allowE2ee: 'Comptes amb xifratge d’extrem a extrem',
        allowPlain: 'Comptes sense xifratge d’extrem a extrem',
        recommendedInherited: 'Predeterminat del servidor',
        recommendedE2ee: 'E2EE',
        errorWideningUnconfirmed: 'Aquest canvi deixa entrar més persones i necessita la teva confirmació. No s’ha canviat res.',
        widening: {
            titleAnyone: 'Permetre que qualsevol creï un compte?',
            titleInvited: 'Permetre que les persones convidades creïn comptes?',
            titleMethod: ({ method }: { method: string }) => `Activar ${method}?`,
            titleAnonymous: 'Permetre el registre anònim?',
            titleUnencrypted: 'Permetre l’emmagatzematge sense xifrar?',
            titleOther: 'Deixar entrar més persones?',
            exposureAnyone: ({ host }: { host: string }) => `Qualsevol que arribi a aquest Home a ${host} es podrà registrar sense invitació.`,
            exposureInvited: ({ host }: { host: string }) => `Qualsevol amb una invitació que arribi a aquest Home a ${host} podrà crear un compte.`,
            exposureMethod: ({ host, method }: { host: string; method: string }) => `Qualsevol que arribi a aquest Home a ${host} podrà iniciar la sessió amb ${method}.`,
            exposureAnonymous: ({ host }: { host: string }) => `Qualsevol que arribi a aquest Home a ${host} podrà crear un compte només amb una clau de recuperació.`,
            exposureUnencrypted: ({ host }: { host: string }) => `Qualsevol que arribi a aquest Home a ${host} podrà desar-hi les dades sense xifratge d’extrem a extrem.`,
            exposureOther: ({ host }: { host: string }) => `Qualsevol que arribi a aquest Home a ${host} podrà iniciar la sessió o unir-s’hi amb les regles ampliades.`,
            unchanged: 'Els comptes i les invitacions existents no canvien.',
            recorded: 'El canvi queda registrat a Activitat amb el teu nom.',
            confirmAnyone: 'Permetre que qualsevol es registri',
            confirmInvited: 'Permetre invitacions',
            confirmMethod: ({ method }: { method: string }) => `Activar ${method}`,
            confirmAnonymous: 'Permetre el registre anònim',
            confirmUnencrypted: 'Permetre l’emmagatzematge sense xifrar',
            confirmOther: 'Aplicar el canvi',
        },
    },
    claim: {
        pageDescription: 'Reclama la propietat d’aquest Home.',
        emptyTitle: 'Aquest Home encara no té propietari',
        emptyBody: 'Un propietari gestiona l’inici de sessió, el correu, l’abast i les persones. Fins que algú el reclami, ningú pot administrar aquest Home.',
        codeTitle: 'Reclama’l amb un codi d’un sol ús',
        codeDescription: 'Algú amb accés al servidor imprimeix un codi. Funciona una vegada i caduca als 15 minuts.',
        printStep: '1 · Imprimeix un codi al servidor',
        pasteStep: '2 · Enganxa’l aquí',
        codeLabel: 'Codi de reclamació',
        codePlaceholder: 'XXXX-XXXX-XXXX-XXXX-…',
        claim: 'Reclamar',
        refused: 'Aquest codi no ha funcionat. Pot estar mal escrit, usat o caducat — imprimeix-ne un de nou.',
        hostTitle: ({ home }: { home: string }) => `Aquest ordinador allotja ${home}`,
        hostBody: 'Pots fer que el teu compte en sigui el propietari des d’aquí. Només aquest ordinador ho pot fer així.',
        makeOwner: 'Fes-me propietari',
        hostFailed: 'Aquest ordinador no t’ha pogut fer propietari. Torna-ho a provar.',
    },
    fixedByDeployment: ({ key }: { key: string }) => `Fixat pel teu desplegament · ${key}`,
    fixedByDeploymentLead: 'Fixat pel teu desplegament',
    deploymentNotSetLead: 'No disponible fins que el teu desplegament defineixi',
    features: {
        title: 'Funcions',
        common: 'Habituals',
        advanced: 'Avançades',
        advancedDescription: ({ count }: { count: number }) => `${count} més, agrupades per àrea.`,
        other: 'Altres',
        familyCount_one: '1 funció',
        familyCount_other: ({ count }: { count: number }) => `${count} funcions`,
        offHome: 'Desactivada per a aquest Home.',
        notInBuild: 'No inclosa en aquesta compilació.',
        needs: ({ feature }: { feature: string }) => `Necessita ${feature}.`,
        unavailable: 'No disponible en aquest Home.',
        noHomeSwitchOn: 'Sempre activada en aquest Home · només la compilació de Happier la pot desactivar',
        noHomeSwitchOff: 'Desactivada en aquest Home · només la compilació de Happier la pot activar',
        unavailableByDeployment: 'No disponible en aquest Home · ho decideix la configuració del teu desplegament',
        dependentsTitle_one: ({ feature }: { feature: string }) => `Desactivar ${feature} també desactiva 1 funció`,
        dependentsTitle_other: ({ feature, count }: { feature: string; count: number }) => `Desactivar ${feature} també desactiva ${count} funcions`,
        dependentNeeds: ({ feature, parent }: { feature: string; parent: string }) => `${feature} necessita ${parent}.`,
        turnOff: 'Desactiva',
        deviceTitle: 'Funcions d’aquest dispositiu',
        deviceBody: 'Les funcions que només afecten aquest dispositiu són a Configuració.',
        adminTitle: 'Només els propietaris poden canviar les funcions',
        adminBody: 'Pots veure què ofereix aquest Home perquè n’ets admin.',
        loadFailed: 'Aquest Home no ha retornat les seves funcions.',
        conflictTitle: 'Les funcions han canviat en un altre lloc',
        conflictBody: 'Algú ha canviat la configuració d’aquest Home mentre la miraves. Ara la pàgina mostra el que conté el Home.',
        rangeBetween: ({ min, max }: { min: number; max: number }) => `${min}–${max}`,
        rangeAtLeast: ({ min }: { min: number }) => `${min} o més`,
        rangeAtMost: ({ max }: { max: number }) => `Fins a ${max}`,
        limitInvalid: 'Introdueix un nombre dins de l’interval.',
        appliesAfterRestart: 'S’aplica després de reiniciar',
        onAfterRestart: 'Activada després de reiniciar',
        offAfterRestart: 'Desactivada després de reiniciar',
        ignoredAtLastStart: ({ reason }: { reason: string }) => `Ignorat a l’últim inici: ${reason}`,
        ignoredInvalidType: 'el valor desat té un tipus incorrecte',
        ignoredOutOfBounds: 'el valor desat és fora de l’interval',
        ignoredSecretUnreadable: 'no es pot llegir el secret desat',
        dependentsAfterRestartTitle_one: ({ feature }: { feature: string }) => `Després del proper reinici, desactivar ${feature} també desactiva 1 funció`,
        dependentsAfterRestartTitle_other: ({ feature, count }: { feature: string; count: number }) => `Després del proper reinici, desactivar ${feature} també desactiva ${count} funcions`,
    },
    data: {
        title: 'Dades',
        deletion: 'Eliminació automàtica',
        deletionDescription: 'Els canvis s’apliquen a partir de la propera neteja.',
        dryRunMode: 'Mode de prova',
        dryRunModeDescription: 'La neteja compta en lloc d’eliminar fins que ho desactivis.',
        tryRules: 'Prova les regles actuals',
        tryRulesDescription: 'Executa ara una neteja sense eliminar res.',
        runDryRun: 'Executa una prova',
        runAgain: 'Torna-ho a executar',
        ranAt: ({ time }: { time: string }) => `Executada a les ${time} · no s’ha eliminat res`,
        sweepInProgress: 'Hi ha una neteja en curs — torna-ho a provar quan acabi.',
        wouldDelete: ({ count, examined }: { count: string; examined: string }) => `Eliminaria ${count} · ${examined} examinats`,
        nothingToDelete: 'Res a eliminar',
        stopTimeBudget: 'aturada: límit de temps',
        stopRowBudget: 'aturada: límit d’eliminació',
        stopCandidateBudget: 'aturada: límit d’examen',
        stopStalled: 'aturada: sense progrés',
        keep: 'Conserva',
        deleteAfter: 'Elimina després de',
        days: 'dies',
        daysFor: ({ domain }: { domain: string }) => `Dies de conservació de ${domain}`,
        daysRequired: 'Indica quants dies.',
        daysInvalid: 'Fes servir un nombre enter de dies, 1 o més.',
        defaultEffect: ({ effect }: { effect: string }) => `Per defecte · ${effect}`,
        alwaysRuns: 'S’executa fins i tot amb l’eliminació automàtica desactivada.',
        expiresAutomatically: 'Caduca automàticament',
        systemRecords: 'Registres del sistema',
        systemRecordsSummary_one: '1 tipus de registre que aquest Home desa per a si mateix',
        systemRecordsSummary_other: ({ count }: { count: number }) => `${count} tipus de registres que aquest Home desa per a si mateix`,
        adminTitle: 'Només els propietaris poden canviar què conserva aquest Home',
        adminBody: 'Pots veure les regles perquè n’ets admin.',
        loadFailed: 'Aquest Home no ha retornat la seva configuració de dades.',
        conflictTitle: 'La configuració de dades ha canviat en un altre lloc',
        conflictBody: 'Algú ha canviat la configuració d’aquest Home mentre la miraves. Ara la pàgina mostra el que conté el Home.',
    },
};

const homeGovernanceTranslations = { ca } as const;

return { homeGovernanceTranslations };
})();

const Domain_homeIndexTranslations = (() => {
type HomeIndexTranslation = Shared_homeIndexTranslations.HomeIndexTranslation;

const homeIndexTranslations = { ca: {
        greetingMorning: ({ name }) => `Bon dia, ${name}`,
        greetingAfternoon: ({ name }) => `Bona tarda, ${name}`,
        greetingEvening: ({ name }) => `Bon vespre, ${name}`,
        greetingMorningAnonymous: 'Bon dia',
        greetingAfternoonAnonymous: 'Bona tarda',
        greetingEveningAnonymous: 'Bon vespre',
        sessionsWorking: ({ count }) => (count === 1 ? '1 sessió treballant' : `${count} sessions treballant`),
        sessionsNeedYou: ({ count }) => `${count} et necessita${count === 1 ? '' : 'n'}`,
        nothingRunning: 'Encara no hi ha res en marxa',
        customize: 'Personalitza',
        customizeTitle: 'Personalitza l’inici',
        customizeDescription: 'Arrossega per reordenar. Es desa al teu compte, així tots els dispositius mostren el mateix inici.',
        reset: 'Restableix',
        alwaysShown: 'Sempre visible',
        builtIn: 'Integrat',
        startDescription: 'Compositor i suggeriments',
        attentionDescription: 'Apareix quan alguna cosa et necessita',
        machinesDescription: 'Integrat · una graella de les teves màquines',
        hiddenSetupSteps: 'Passos de configuració amagats',
        showAgain: ({ count }) => `${count} · Torna a mostrar`,
        reorderHandle: ({ section }) => `Reordena ${section}`,
    } } satisfies Pick<Readonly<Record<string, HomeIndexTranslation>>, "ca">;

return { homeIndexTranslations };
})();

const Domain_homeSettingsTranslations = (() => {
const en = Shared_homeSettingsTranslations.en;

const ca: typeof en = {
    page: {
        title: 'Configuració del servidor',
        description: 'Cada paràmetre que llegeix el servidor i que no té una pàgina pròpia.',
        searchPlaceholder: 'Cerca paràmetres o variables d’entorn',
        changed: 'Canviats',
        changedA11y: ({ count }: { count: number }) => (count === 1 ? 'Mostra només el paràmetre canviat' : `Mostra només els ${count} paràmetres canviats`),
        noMatches: 'Cap paràmetre coincideix amb aquesta cerca.',
        noChanges: 'Cap paràmetre d’aquest Home no difereix del valor predeterminat.',
        filterLabel: 'Mostra',
        filterAll: 'Tots els paràmetres',
        filterChanged: ({ count }: { count: number }) => `Canviats · ${count}`,
        more: 'Més',
        readOnlyTitle: 'Només lectura en iniciar',
        readOnlyDescription: 'El servidor els necessita abans de poder llegir cap paràmetre desat, així que es defineixen on s’executa.',
        note: 'Els paràmetres s’apliquen tan bon punt els canvies, tret dels marcats amb “S’aplica després de reiniciar”. Pendent vol dir que el valor desat és diferent del valor amb què va iniciar el servidor. Cada canvi queda registrat a Activitat; els valors secrets, mai.',
        adminTitle: 'Només els propietaris canvien la configuració del servidor',
        adminBody: 'Pots veure cada paràmetre i d’on ve el seu valor.',
        loadFailed: 'No s’ha pogut carregar la configuració del servidor.',
        saveFailed: 'El paràmetre no s’ha desat.',
        conflictTitle: 'La configuració ha canviat en un altre lloc',
        conflictBody: 'Algú ha canviat la configuració d’aquest Home mentre l’editaves. La pàgina ara mostra els seus valors; la teva edició continua al camp.',
    },
    row: {
        appliesAfterRestart: 'S’aplica després de reiniciar',
        pending: 'Pendent',
        defaultValue: ({ value }: { value: string }) => `Per defecte: ${value}`,
        runningWith: ({ value }: { value: string }) => `en execució amb ${value} des de l’últim inici`,
        runningWithout: 'en execució sense aquest valor des de l’últim inici',
        ignored: ({ reason }: { reason: string }) => `Ignorat en l’últim inici: ${reason}`,
        runningOn: ({ value }: { value: string }) => `en execució a ${value}`,
        notSet: 'Sense definir',
        outOfBounds: ({ bounds }: { bounds: string }) => `Ha de ser ${bounds}`,
        invalid: 'Aquest valor no és vàlid aquí',
        storedEncrypted: 'desat xifrat, mai no es mostra',
    },
    banner: {
        pendingNames: ({ names }: { names: string }) => `${names}.`,
        andMore: ({ count }: { count: number }) => (count === 1 ? '1 més' : `${count} més`),
        discard: 'Descarta',
        discardA11y: 'Descarta els canvis que s’apliquen després de reiniciar',
        discarded: 'Canvis pendents descartats',
        ignoredTitle: 'Un paràmetre es va ignorar en l’últim inici',
        ignoredTitleMany: ({ count }: { count: number }) => `${count} paràmetres es van ignorar en l’últim inici`,
        ignoredBody: ({ setting, reason }: { setting: string; reason: string }) => `${setting}: ${reason}. El servidor va iniciar sense aquest valor.`,
        fix: 'Corregeix',
    },
    readOnly: {
        before_database: 'Es llegeix abans d’obrir la base de dades',
        per_process_identity: 'És diferent per a cada procés del servidor',
        invariant: 'Protegeix l’inici de sessió i els límits de la build, així que no es pot canviar aquí',
        other: 'Es defineix on s’executa el servidor',
        set: 'Definit',
    },
    secret: {
        saved: 'Desat',
        replace: 'Substitueix',
        clear: 'Treu',
        keep: 'Conserva',
        clearPending: 'El valor desat es traurà en desar.',
        valueSet: 'Definit',
        valueNotSet: 'Sense definir',
        setAction: 'Defineix',
    },
    groupSummary: ({ count }: { count: number }) => (count === 1 ? '1 paràmetre · predeterminat' : `${count} paràmetres · predeterminats`),
    groupSummaryChanged: ({ count, changed }: { count: number; changed: number }) => `${count} paràmetres · ${changed} canviats`,
    units: {
        ms: 'ms',
        seconds: 's',
        minutes: 'min',
        bytes: 'bytes',
        megabytes: 'MB',
    },
    activity: {
        discarded: 'Ha descartat un paràmetre del servidor pendent',
    },
    choices: {
        hosted_happier_relay: 'Relay de Happier',
        direct_apns: 'Push d’Apple',
        background_wake_best_effort: 'Activació en segon pla',
        local_only: 'Només aquest dispositiu',
        disabled: 'Desactivat',
        enabled: 'Activat',
        automatic: 'Automàtic',
        sandbox: 'Sandbox',
        production: 'Producció',
        owner: 'Propietaris del servidor',
        authenticated: 'Qualsevol persona amb sessió',
        self: 'Aquest servidor',
        external: 'Servei extern',
        '0': 'Desactivat',
        '1': 'Activat',
        any: 'Qualsevol',
        all: 'Totes',
        github_app: 'GitHub App',
        oauth_user_token: 'Token de la persona',
        light: 'Lleuger',
        full: 'Complet',
        api: 'Només API',
        worker: 'Només worker',
        fatal: 'Fatal',
        error: 'Errors',
        warn: 'Avisos',
        info: 'Informació',
        debug: 'Depuració',
        trace: 'Traça',
        silent: 'Silenciós',
        manual: 'Manual',
        default: 'Valor del servidor',
    },
    rateLimit: {
        max: ({ route }: { route: string }) => `${route}: sol·licituds per finestra`,
        window: ({ route }: { route: string }) => `${route}: finestra`,
    },
    groups: {
        api: 'API i xarxa',
        storage: 'Emmagatzematge i fitxers',
        monitoring: 'Supervisió',
        process: 'Procés',
        ui: 'Servei de l’app web',
        realtime: 'Presència i sockets',
        retentionCaps: 'Límits de recursos de la retenció',
        rpc: 'Crides a les màquines',
        liveActivity: 'Live Activities',
        voice: 'Veu',
        connectedServices: 'Serveis connectats',
        localServices: 'Serveis locals',
        plugins: 'Connectors',
        reviews: 'Revisions',
        bugReports: 'Informes d’errors',
        releases: 'Versions',
        authCaches: 'Memòries cau d’inici de sessió',
        limits: 'Límits',
        rateLimits: 'Límits de sol·licituds per ruta',
        github: 'Inici de sessió amb GitHub',
        oauth: 'Inici de sessió amb OAuth',
        oidc: 'Proveïdors OIDC de la configuració',
        workos: 'WorkOS',
        signInRequests: 'Sol·licituds d’inici de sessió',
        offboarding: 'Baixa d’usuaris',
        friends: 'Amics',
        accountService: 'Servei de comptes',
        devices: 'Dispositius',
        diagnostics: 'Diagnòstic',
        reachInference: 'Detecció de l’adreça',
        addresses: 'Adreces',
        other: 'Altres',
    },
    keys: {
        HAPPIER_HOME_DISPLAY_NAME: 'Nom de Home',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATES_ENABLED: 'Actualitzacions en segon pla',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_MODE: 'Mode de lliurament',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_ALLOW_FALLBACK: 'Recorre a un altre mode',
        HAPPIER_LIVE_ACTIVITY_REMOTE_UPDATE_DEDUPE_WINDOW_MS: 'Finestra d’actualitzacions duplicades',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_ENABLED: 'Pushes de despertada en segon pla',
        HAPPIER_LIVE_ACTIVITY_BACKGROUND_WAKE_MIN_INTERVAL_MS: 'Temps mínim entre pushes de despertada',
        HAPPIER_LIVE_ACTIVITY_EXPO_WIDGETS_PUSH_NOTIFICATIONS_ENABLED: 'La build de widgets rep pushes',
        HAPPIER_LIVE_ACTIVITY_TARGET_TRANSIENT_FAILURE_BUDGET: 'Errors abans de descartar un dispositiu',
        HAPPIER_LIVE_ACTIVITY_APNS_ENVIRONMENT: 'Entorn de push d’Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_TEAM_ID: 'ID d’equip d’Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_KEY_ID: 'ID de la clau de push d’Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY: 'Clau de signatura de push d’Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_PRIVATE_KEY_FILE: 'Fitxer de la clau de signatura de push d’Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_BUNDLE_IDS: 'Bundle IDs d’apps permesos',
        HAPPIER_LIVE_ACTIVITY_APNS_ACTIVITY_NAMES: 'Noms de Live Activity permesos',
        HAPPIER_LIVE_ACTIVITY_APNS_REQUEST_TIMEOUT_MS: 'Temps d’espera de les sol·licituds de push d’Apple',
        HAPPIER_LIVE_ACTIVITY_APNS_RECONNECT_BACKOFF_MS: 'Espera de reconnexió de push d’Apple',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ALLOWED: 'Fes servir un relay allotjat',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_BASE_URL: 'Adreça del relay allotjat',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEY: 'Clau d’accés al relay allotjat',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_SERVICE_ENABLED: 'Actua com a relay allotjat',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_ACCESS_KEYS: 'Claus d’accés al relay per a altres servidors',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_MAX_SKEW_MS: 'Tolerància de rellotge del relay',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_TTL_MS: 'Memòria de duplicats del relay',
        HAPPIER_LIVE_ACTIVITY_HOSTED_RELAY_DUPLICATE_CACHE_MAX_ENTRIES: 'Mida de la memòria cau de duplicats del relay',
        ELEVENLABS_API_KEY: 'Clau d’API d’ElevenLabs',
        ELEVENLABS_AGENT_ID: 'Agent d’ElevenLabs',
        ELEVENLABS_AGENT_ID_PROD: 'Agent de producció d’ElevenLabs',
        ELEVENLABS_API_BASE_URL: 'Adreça de l’API d’ElevenLabs',
        REVENUECAT_SECRET_KEY: 'Clau secreta de RevenueCat',
        VOICE_FREE_SESSIONS_PER_MONTH: 'Sessions de veu gratuïtes al mes',
        VOICE_FREE_MINUTES_PER_MONTH: 'Minuts de veu gratuïts al mes',
        VOICE_MAX_CONCURRENT_SESSIONS: 'Sessions de veu simultànies',
        VOICE_MAX_SESSION_SECONDS: 'Sessió de veu més llarga',
        VOICE_MAX_MINUTES_PER_DAY: 'Minuts de veu al dia',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_ENABLED: 'Emplenament retroactiu de la identitat de veu',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE: 'Mida dels lots d’emplenament',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS: 'Temps màxim d’emplenament',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_DELAY_MS: 'Pausa entre lots d’emplenament',
        HAPPIER_VOICE_PROVIDER_IDENTITY_BACKFILL_INTERVAL_MS: 'Temps entre execucions d’emplenament',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_CLIENT_ID: 'ID de client OAuth d’OpenAI Codex',
        HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_OAUTH_TOKEN_URL: 'Endpoint de tokens d’OpenAI Codex',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID: 'ID de client OAuth de la subscripció a Claude',
        HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL: 'Endpoint de tokens de la subscripció a Claude',
        HAPPIER_CONNECTED_SERVICES_OAUTH_EXCHANGE_TIMEOUT_MS: 'Temps d’espera de l’intercanvi de tokens',
        CONNECTED_SERVICE_CREDENTIAL_MAX_LEN: 'Credencial desada més gran',
        CONNECTED_SERVICE_REFRESH_LEASE_MAX_MS: 'Concessió d’actualització més llarga',
        VENDOR_TOKEN_MAX_LEN: 'Token de proveïdor més gran',
        HAPPIER_LOCAL_SERVICES_TOKEN_SECRET: 'Secret dels tokens de previsualització',
        HAPPIER_LOCAL_SERVICES_PREVIEW_TOKEN_SECRET: 'Secret dels tokens de previsualització privada',
        HAPPIER_LOCAL_SERVICES_PUBLIC_PREVIEW_TOKEN_SECRET: 'Secret dels tokens de previsualització pública',
        HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN: 'Origen de la interfície dels connectors',
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_MAX_AGE_MS: 'Validesa de la prova de l’editor',
        HAPPIER_PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_PROOF_CLOCK_SKEW_MS: 'Tolerància de rellotge de la prova de l’editor',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_MAX_AGE_MS: 'Validesa de la prova de revisió',
        HAPPIER_REVIEW_COMMENT_PRINCIPAL_PROOF_CLOCK_SKEW_MS: 'Tolerància de rellotge de la prova de revisió',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ENABLED: 'Inclou els registres del servidor',
        HAPPIER_BUG_REPORTS_SERVER_DIAGNOSTICS_ACCESS_MODE: 'Qui pot llegir els registres del servidor',
        HAPPIER_BUG_REPORTS_SERVER_LOG_PATH: 'Fitxer de registre del servidor',
        HAPPIER_BUG_REPORTS_SERVER_LOG_MAX_BYTES: 'Mida del registre inclosa',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'Canal de versions',
        HAPPIER_GITHUB_REPO: 'Repositori de versions',
        AUTH_OFFBOARDING_ENABLED: 'Torna a comprovar l’elegibilitat d’inici de sessió',
        AUTH_OFFBOARDING_STRICT: 'Rebutja si una comprovació falla',
        AUTH_OFFBOARDING_INTERVAL_SECONDS: 'Temps entre comprovacions',
        AUTH_PROVIDERS_CONFIG_PATH: 'Fitxer de proveïdors',
        AUTH_PROVIDERS_CONFIG_JSON: 'JSON de proveïdors',
        HAPPIER_AUTH_SIGN_IN_SERVICE_MODE: 'Servei d’inici de sessió',
        HAPPIER_AUTH_SIGN_IN_SERVICE_URL: 'Adreça del servei de comptes',
        HAPPIER_AUTH_SIGN_IN_SERVICE_SERVER_IDENTITY_ID: 'Identitat del servei de comptes',
        HAPPIER_ACCOUNT_SERVICE_DISPLAY_NAME: 'Nom del servei de comptes',
        HAPPIER_SERVER_OWNER_USER_IDS: 'Comptes propietaris del servidor',
        HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED: 'Els dispositius nous necessiten aprovació',
        GITHUB_CLIENT_ID: 'ID de client OAuth de GitHub',
        GITHUB_CLIENT_SECRET: 'Secret de client OAuth de GitHub',
        GITHUB_REDIRECT_URL: 'Adreça de retorn de GitHub',
        GITHUB_HTTP_TIMEOUT_SECONDS: 'Temps d’espera de les sol·licituds a GitHub',
        GITHUB_STORE_ACCESS_TOKEN: 'Conserva el token d’accés de GitHub',
        OAUTH_PENDING_TTL_SECONDS: 'Validesa dels inicis de sessió pendents',
        OAUTH_STATE_TTL_SECONDS: 'Validesa de l’estat OAuth',
        HAPPIER_OAUTH_RETURN_ALLOWED_SCHEMES: 'Esquemes de retorn a l’app permesos',
        AUTH_GITHUB_ALLOWED_USERS: 'Usuaris de GitHub permesos',
        AUTH_GITHUB_ALLOWED_ORGS: 'Organitzacions de GitHub permeses',
        AUTH_GITHUB_ORG_MATCH: 'Organitzacions requerides',
        AUTH_GITHUB_ORG_MEMBERSHIP_SOURCE: 'Comprovació de pertinença',
        AUTH_GITHUB_APP_ID: 'ID de la GitHub App de pertinença',
        AUTH_GITHUB_APP_PRIVATE_KEY: 'Clau de la GitHub App de pertinença',
        AUTH_GITHUB_APP_INSTALLATION_ID_BY_ORG: 'Instal·lacions de l’app per organització',
        WORKOS_API_KEY: 'Clau d’API de WorkOS',
        WORKOS_CLIENT_ID: 'ID de client de WorkOS',
        ACCOUNT_AUTH_REQUEST_TTL_SECONDS: 'Validesa de les sol·licituds d’inici de sessió del compte',
        TERMINAL_AUTH_REQUEST_TTL_SECONDS: 'Validesa de les sol·licituds d’inici de sessió del terminal',
        AUTH_PAIRING_TTL_SECONDS: 'Validesa del codi d’emparellament',
        AUTH_TOKEN_CACHE_TTL_SECONDS: 'Validesa de la memòria cau de tokens de sessió',
        AUTH_TOKEN_CACHE_MAX_ENTRIES: 'Mida de la memòria cau de tokens de sessió',
        AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: 'Validesa de la memòria cau d’elegibilitat',
        AUTH_LOGIN_ELIGIBILITY_CACHE_MAX_ENTRIES: 'Mida de la memòria cau d’elegibilitat',
        FRIENDS_USERNAME_MIN_LEN: 'Nom d’usuari més curt',
        FRIENDS_USERNAME_MAX_LEN: 'Nom d’usuari més llarg',
        FRIENDS_USERNAME_REGEX: 'Patró del nom d’usuari',
        HAPPIER_CANONICAL_SERVER_URL: 'Adreça de la identitat d’inici de sessió',
        HAPPIER_WEBAPP_OAUTH_RETURN_URL_BASE: 'Adreça de retorn OAuth de l’app web',
        PUBLIC_URL: 'Adreça anunciada (light)',
        HAPPIER_PUBLIC_SERVER_URL_INFER_TTL_MS: 'Validesa de l’adreça detectada',
        HAPPIER_RELAY_ACCESS_INFER_PUBLIC_URL: 'Detecta a partir del mètode d’accés',
        HAPPIER_TAILSCALE_INFER_PUBLIC_URL: 'Detecta a partir de Tailscale',
        HAPPIER_TAILSCALE_SERVE_STATUS_TIMEOUT_MS: 'Temps d’espera de la comprovació de Tailscale Serve',
        HAPPIER_TAILSCALE_FUNNEL_STATUS_TIMEOUT_MS: 'Temps d’espera de la comprovació de Tailscale Funnel',
        PORT: 'Port d’escolta',
        HAPPIER_SERVER_HOST: 'Adreça d’escolta',
        HAPPIER_SERVER_FLAVOR: 'Variant del servidor',
        NODE_ENV: 'Entorn de Node',
        SERVER_ROLE: 'Rol del procés',
        UV_THREADPOOL_SIZE: 'Fils de treball',
        HAPPIER_INSTANCE_ID: 'ID de rèplica',
        HAPPIER_SERVER_SHUTDOWN_DEADLINE_MS: 'Termini d’aturada',
        HAPPY_EXIT_ON_FATAL: 'Surt després d’un error greu',
        HAPPIER_API_CORS_MAX_AGE_SECONDS: 'Memòria cau de preflight del navegador',
        HAPPIER_SERVER_IDENTITY_ID: 'Identitat del servidor',
        HAPPIER_MANAGED_RELAY_PURPOSE: 'Finalitat del relay gestionat',
        HAPPIER_PERSONAL_HOME_RELOCATION_OPERATION_ID: 'Operació de trasllat',
        HAPPIER_SERVER_STARTUP_RECEIPT_PATH: 'Fitxer del rebut d’inici',
        HAPPIER_SERVER_STARTUP_RECEIPT_NONCE: 'Nonce del rebut d’inici',
        HAPPIER_UPDATER_FORWARD_RECOVERY_CAPABILITY: 'Recuperació cap endavant de l’actualitzador',
        HAPPIER_RELEASE_SOURCE_SHA: 'Commit de la build',
        HAPPIER_FEATURE_POLICY_ENV: 'Política del canal de versions',
        HAPPIER_BUILD_FEATURES_ALLOW: 'Funcions permeses',
        HAPPIER_BUILD_FEATURES_DENY: 'Funcions denegades',
        HAPPIER_SERVER_LOG_LEVEL: 'Nivell de registre',
        DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: 'Registre de depuració consolidat',
        HAPPIER_SELF_HOST_LOG_DIR: 'Carpeta de registres',
        HAPPIER_AUTH_DECORATOR_DIAGNOSTIC_LOGS: 'Diagnòstic d’autenticació',
        HAPPIER_SOCKET_MESSAGE_DIAGNOSTIC_LOGS: 'Diagnòstic de missatges de socket',
        METRICS_ENABLED: 'Mètriques',
        METRICS_PORT: 'Port de mètriques',
        SENTRY_DSN: 'DSN d’informes d’errors',
        HAPPIER_SENTRY_USE_CENTRAL_DSN: 'Informa a Happier',
        HAPPIER_SENTRY_CENTRAL_DSN: 'DSN central d’informes d’errors',
        SENTRY_ENVIRONMENT: 'Entorn d’informes d’errors',
        SENTRY_RELEASE: 'Versió d’informes d’errors',
        SENTRY_PROFILE_LIFECYCLE: 'Perfilat',
        SENTRY_SEND_DEFAULT_PII: 'Envia dades personals',
        SENTRY_TRACES_SAMPLE_RATE: 'Sol·licituds traçades',
        SENTRY_PROFILE_SESSION_SAMPLE_RATE: 'Sessions perfilades',
        SENTRY_ENABLE_LOGS: 'Envia registres',
        SENTRY_LOG_LEVELS: 'Nivells de registre enviats',
        SENTRY_MONITORS_ENABLED: 'Monitors de tasques',
        HAPPIER_SERVER_UI_DIR: 'Carpeta de l’app web',
        HAPPIER_SERVER_UI_PREFIX: 'Camí de l’app web',
        HAPPIER_SERVER_UI_REQUIRED: 'Requereix l’app web',
        HAPPIER_SERVER_UI_DEPLOYMENT_ID: 'ID de desplegament de l’app web',
        HAPPIER_SERVER_UI_DEBUG_PATH: 'Mostra el camí de l’app web si falta',
        HAPPIER_SOCKET_ADAPTER: 'Adaptador de sockets',
        HAPPIER_SOCKET_REDIS_ADAPTER: 'Adaptador de sockets Redis (antic)',
        HAPPIER_SOCKET_ADAPTER_MAXLEN: 'Longitud del flux de sockets',
        HAPPIER_SOCKET_ADAPTER_READ_COUNT: 'Mida de lectura del flux de sockets',
        HAPPIER_SOCKET_MAX_HTTP_BUFFER_SIZE: 'Missatge de socket més gran',
        HAPPIER_SOCKET_FAST_DISCONNECT_LOG_THRESHOLD_MS: 'Llindar de desconnexió ràpida',
        HAPPIER_SOCKET_PLANNED_RESTART_RETRY_AFTER_MS: 'Espera de reconnexió durant un reinici',
        HAPPIER_SOCKET_RECONNECT_WINDOW_MS: 'Finestra de reconnexió',
        HAPPY_SOCKET_ROOMS_ONLY: 'Distribució de sockets estricta',
        HAPPIER_MACHINE_SOCKET_OWNER_TTL_SECONDS: 'Propietat del socket de la màquina',
        HAPPIER_PRESENCE_STREAM_MAXLEN: 'Longitud del flux de presència',
        HAPPIER_PRESENCE_WORKER_DB_WRITE_CONCURRENCY: 'Escriptures de presència simultànies',
        HAPPIER_PRESENCE_WORKER_FLUSH_INTERVAL_MS: 'Interval d’escriptura de la presència',
        HAPPIER_PRESENCE_WORKER_READ_BLOCK_MS: 'Espera de lectura de la presència',
        HAPPIER_PRESENCE_WORKER_READ_COUNT: 'Mida de lectura de la presència',
        HAPPIER_PRESENCE_WORKER_RECLAIM_IDLE_MS: 'Recupera la presència després de',
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: 'Sessió inactiva després de',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: 'Màquina fora de línia després de',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: 'Interval de comprovació de la presència',
        HAPPIER_PRESENCE_SHUTDOWN_FLUSH_TIMEOUT_MS: 'Escriptura de la presència en aturar',
        HAPPIER_RPC_FORWARD_TIMEOUT_MS: 'Temps d’espera de les crides a màquines',
        HAPPIER_RPC_FORWARD_CAPABILITIES_TIMEOUT_MS: 'Temps d’espera de la crida de capacitats',
        HAPPIER_RPC_FORWARD_MAX_TIMEOUT_MS: 'Temps d’espera de crida més llarg',
        HAPPIER_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Espera un mètode',
        HAPPIER_RPC_METHOD_AVAILABILITY_POLL_MS: 'Interval de comprovació de mètodes',
        HAPPIER_RPC_CLUSTER_FETCH_TIMEOUT_MS: 'Temps d’espera de la cerca entre rèpliques',
        HAPPIER_STOP_SESSION_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Espera per aturar una sessió',
        HAPPIER_DIRECT_SESSIONS_RPC_METHOD_AVAILABILITY_GRACE_MS: 'Espera les sessions directes',
        HAPPIER_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT: 'Sessions que requereixen atenció en la primera càrrega',
        HAPPIER_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT: 'Torns comprovats per a la reversió',
        HAPPIER_ACCOUNT_SETTINGS_HISTORY_LIMIT: 'Historial de configuració conservat',
        HAPPIER_MACHINES_REQUIRE_CONTENT_PUBLIC_KEY_FOR_DEK: 'Requereix una clau de màquina signada',
        DATABASE_URL: 'Base de dades',
        HAPPIER_DB_PROVIDER: 'Motor de base de dades',
        HAPPIER_DB_CONNECTION_LIMIT: 'Mida del grup de connexions',
        HAPPIER_DB_READINESS_TIMEOUT_MS: 'Temps d’espera de disponibilitat de la base de dades',
        HAPPIER_DB_TX_MAX_RETRIES: 'Reintents de transacció',
        HAPPIER_DB_TX_RETRY_BASE_DELAY_MS: 'Espera del primer reintent',
        HAPPIER_DB_TX_RETRY_MAX_DELAY_MS: 'Espera més llarga entre reintents',
        HAPPIER_DB_TX_RETRY_JITTER_FACTOR: 'Variació aleatòria dels reintents',
        HAPPIER_DB_TX_TIMEOUT_MS: 'Temps d’espera de les transaccions',
        HAPPIER_DB_TX_MAX_WAIT_MS: 'Espera de connexió',
        HAPPIER_DB_TX_TOTAL_RETRY_BUDGET_MS: 'Temps total de reintents',
        HAPPIER_SERVER_DB_SIZE_WARN_BYTES: 'Avís de mida de la base de dades',
        HAPPIER_SQLITE_AUTO_MIGRATE: 'Migra en iniciar',
        HAPPIER_SQLITE_MIGRATIONS_DIR: 'Carpeta de migracions',
        HAPPIER_SQLITE_JOURNAL_MODE: 'Mode de diari de SQLite',
        HAPPIER_SQLITE_SYNCHRONOUS: 'Mode síncron de SQLite',
        HAPPIER_SQLITE_JOURNAL_SIZE_LIMIT_BYTES: 'Límit de mida del diari de SQLite',
        HAPPIER_SQLITE_WAL_CHECKPOINT_INTERVAL_MS: 'Interval de checkpoint de SQLite',
        HAPPIER_SQLITE_WAL_CHECKPOINT_BUSY_TIMEOUT_MS: 'Espera del checkpoint de SQLite',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_INTERVAL_MS: 'Interval de vacuum de SQLite',
        HAPPIER_SQLITE_INCREMENTAL_VACUUM_PAGES: 'Pàgines de vacuum de SQLite',
        HAPPIER_FILES_BACKEND: 'Backend de fitxers',
        S3_HOST: 'Host d’S3',
        S3_PORT: 'Port d’S3',
        S3_USE_SSL: 'S3 amb TLS',
        S3_REGION: 'Regió d’S3',
        S3_BUCKET: 'Bucket d’S3',
        S3_PUBLIC_URL: 'Adreça pública d’S3',
        S3_ACCESS_KEY: 'Clau d’accés d’S3',
        S3_SECRET_KEY: 'Clau secreta d’S3',
        REDIS_URL: 'Connexió a Redis',
        HANDY_MASTER_SECRET: 'Secret mestre',
        HAPPIER_SERVER_LIGHT_DATA_DIR: 'Carpeta de dades',
        HAPPIER_SERVER_LIGHT_DB_DIR: 'Carpeta de la base de dades',
        HAPPIER_SERVER_LIGHT_FILES_DIR: 'Carpeta de fitxers',
        HAPPIER_API_RATE_LIMITS_ENABLED: 'Límits de sol·licituds',
        HAPPIER_API_RATE_LIMITS_GLOBAL_MAX: 'Sol·licituds per client',
        HAPPIER_API_RATE_LIMITS_GLOBAL_WINDOW: 'Finestra del límit de sol·licituds',
        HAPPIER_API_RATE_LIMITS_GLOBAL_KEY_STRATEGY: 'Compta les sol·licituds per',
        HAPPIER_API_RATE_LIMITS_ROUTE_KEY_STRATEGY: 'Compta les sol·licituds de ruta per',
        HAPPIER_SERVER_TRUST_PROXY: 'Confia en les capçaleres del proxy',
        HAPPIER_SERVER_RETENTION__INTERVAL_MS: 'Temps entre neteges',
        HAPPIER_SERVER_RETENTION__BATCH_SIZE: 'Files per lot',
        HAPPIER_SERVER_RETENTION__MAX_DELETES_PER_RULE_PER_RUN: 'Màxim de supressions per regla',
        HAPPIER_SERVER_RETENTION__SWEEP_TIME_BUDGET_MS: 'Temps màxim de neteja',
        HAPPIER_SERVER_RETENTION__MAX_CANDIDATES_PER_RULE_PER_RUN: 'Màxim de files examinades per regla',
    },
};

const homeSettingsTranslations = { ca } as const;

return { homeSettingsTranslations };
})();

const Domain_homeSetupTranslations = (() => {
type HomeSetupTranslation = Shared_homeSetupTranslations.HomeSetupTranslation;

const homeSetupTranslations = { ca: {
        dismiss: ({ title }) => `Amaga «${title}»`,
        dismissTooltip: 'Amaga · recupera-ho a Personalitza',
        close: 'Tanca',
        addPhoneSubtitle: 'Segueix les sessions i respon aprovacions des de qualsevol lloc.',
        addPhoneAction: 'Mostra el codi QR',
        addMachineSubtitle: 'Un servidor o un equip de desenvolupament que executa agents, configurat per SSH o amb una ordre.',
        installComputerTitle: 'Instal·la en un altre ordinador',
        installComputerSubtitle: 'Instal·la-hi l’app d’escriptori i uneix-te a aquest Home amb un enllaç.',
        installComputerAction: 'Obtén l’enllaç',
        connectComputerTitle: 'Connecta un ordinador',
        connectComputerSubtitle: 'Escaneja el codi que Happier mostra al terminal de l’ordinador.',
        connectComputerHint: 'Apunta la càmera al codi que Happier mostra al terminal de l’ordinador.',
        phoneAddMachineSubtitle: 'Configura un servidor o un equip de desenvolupament per als teus agents.',
        phoneAddMachineAction: 'Afegeix',
        thisHome: 'aquest Home',
        pairingPhoneTitle: 'Escaneja amb el telèfon',
        pairingPhoneBody: ({ home }) => `Apunta la càmera del telèfon al codi. Happier s’obre i s’uneix a ${home}.`,
        pairingPhoneStepInstall: 'Instal·la Happier al telèfon.',
        pairingPhoneStepScan: 'Obre la càmera i escaneja el codi.',
        pairingPhoneStepJoin: 'Deixa-ho obert: el telèfon s’uneix tan bon punt escaneja.',
        pairingComputerTitle: 'Uneix-te des d’un altre ordinador',
        pairingComputerBody: ({ home }) => `Envia aquest enllaç a l’altre ordinador. Obrir-lo a Happier l’uneix a ${home}.`,
        pairingComputerStepInstall: 'Instal·la l’app d’escriptori a l’altre ordinador.',
        pairingComputerStepOpen: 'Obre-hi l’enllaç, o enganxa’l a Happier quan pregunti com connectar-se.',
        pairingComputerStepJoin: 'Deixa-ho obert: l’ordinador s’uneix tan bon punt obre l’enllaç.',
        appStore: 'App Store',
        googlePlay: 'Google Play',
        getDesktopApp: 'Baixa l’app',
        copyLink: 'Copia l’enllaç',
        waitingForPhone: 'Esperant el telèfon…',
        waitingForComputer: 'Esperant l’ordinador…',
        newCodeIn: ({ time }) => `Codi nou d’aquí a ${time}`,
        makingCode: 'Creant un codi…',
        addingDevice: ({ device }) => `Afegint ${device}…`,
        deviceJoined: ({ device, home }) => `${device} s’ha unit a ${home}`,
        codeFailed: 'No s’ha pogut crear un codi per a aquest Home.',
        codeFailedUnreachable: ({ home }) => `${home} no ha respost a aquest dispositiu.`,
        codeFailedIdentity: ({ home }) => `El que aquest dispositiu sap de ${home} no coincideix amb la seva resposta; torna’l a connectar a Homes.`,
        codeFailedSignedOut: ({ home }) => `Aquest dispositiu no ha iniciat sessió a ${home}.`,
        codeFailedTooLarge: 'Té massa adreces per cabre en un codi.',
        codeFailedRefused: ({ home }) => `${home} ha rebutjat la sol·licitud.`,
        codeFailedUnexpected: 'Alguna cosa ha fallat; torna-ho a provar.',
        cancelCode: 'Cancel·la el codi',
        newCode: 'Codi nou',
        qrLabel: ({ home }) => `Codi QR que afegeix un dispositiu a ${home}`,
        storeQrLabel: ({ store }) => `Codi QR de Happier a ${store}`,
        getTheApp: 'Baixa l’app',
        connectServicesTitle: ({ first, second }) => (second ? `Connecta ${first} o ${second}` : `Connecta ${first}`),
        connectServicesSubtitle: 'Fes servir el pla que ja pagues, a cada màquina, i mira quant et queda.',
    } } satisfies Pick<Readonly<Record<string, HomeSetupTranslation>>, "ca">;

return { homeSetupTranslations };
})();

const Domain_homeWidgetTranslations = (() => {
type HomeWidgetTranslation = Shared_homeWidgetTranslations.HomeWidgetTranslation;

const homeWidgetTranslations = { ca: {
        open: ({ destination }) => `Obre ${destination}`,
        refreshFailed: 'No s’ha pogut actualitzar',
        latestRunsTitle: 'Darreres execucions',
        latestRunsLoading: 'S’estan carregant les darreres execucions',
        latestRunsEmptyTitle: 'Encara no hi ha execucions',
        latestRunsEmptyReason: 'Quan les teves automatitzacions s’executin, aquí veuràs com ha anat cada execució.',
        latestRunsErrorTitle: 'No s’han pogut carregar les darreres execucions',
        latestRunsErrorReason: 'La teva Home no ha respost. Comprova la connexió i torna-ho a provar.',
    } } satisfies Pick<Readonly<Record<string, HomeWidgetTranslation>>, "ca">;

return { homeWidgetTranslations };
})();

const Domain_homesHubTranslations = (() => {
type HomesHubTranslation = Shared_homesHubTranslations.HomesHubTranslation;

const homesHubTranslations = { ca: {
        addHomeOrSignIn: 'Afegeix una Home / Inicia sessió',
        sheetDescription: 'Connecta aquest dispositiu a una altra Home o troba les teves.',
        continueWithService: ({ service }) => `Continua amb ${service}`,
        continueWithThisHome: 'Continua amb aquesta Home',
        continueWithServiceSubtitle: 'Troba les teves Homes i fes que aquesta estigui disponible als teus altres dispositius.',
        serviceUnavailable: ({ service }) => `${service} no està disponible ara mateix.`,
        serviceUnsupported: ({ service }) => `${service} no ofereix inici de sessió amb compte.`,
        serviceUnavailableUnnamed: 'El teu servei d’inici de sessió no està disponible ara mateix.',
        serviceUnsupportedUnnamed: 'El teu servei d’inici de sessió no ofereix inici de sessió amb compte.',
        scanOrPaste: 'Escaneja o enganxa un enllaç de Home',
        scanOrPasteSubtitle: 'Uneix-te a una Home amb un codi QR o un enllaç.',
        createPersonalHome: 'Crea una Home personal en aquest ordinador',
        createPersonalHomeSubtitle: 'Executa aquí una Home per a les teves màquines i dispositius.',
        opensFirst: 'S’obre primer',
    } } as const satisfies Pick<Record<string, HomesHubTranslation>, "ca">;

return { homesHubTranslations };
})();

const Domain_homesJourneysTranslations = (() => {
type Service = Shared_homesJourneysTranslations.Service;

type Home = Shared_homesJourneysTranslations.Home;

type HomesJourneysTranslation = Shared_homesJourneysTranslations.HomesJourneysTranslation;

const en = Shared_homesJourneysTranslations.en;

const ruTimes = Shared_homesJourneysTranslations.ruTimes;

const ca: HomesJourneysTranslation = {
    phone: {
        reconcileTitle: "Els teus Homes són aquí",
        reconcileLead: "Aquest telèfon ara segueix els teus Homes junts.",
        showMySessions: "Mostra les meves sessions",
        scanComputerCode: "Escaneja el codi del teu ordinador",
        serviceLead: "Els teus Homes es troben quan inicies sessió. Aquest telèfon els segueix tots.",
        serviceAsHomeLead: ({ service }) => `Les teves sessions són a ${service}, sempre accessibles. Afegeix un ordinador per executar agents quan vulguis.`,
        factAlwaysOnDetail: "Accedeix a les teves sessions en qualsevol moment.",
        factAgents: "Els teus ordinadors executen els agents",
        factAgentsDetail: "Afegeix-ne un més tard amb un codi QR.",
        fromDeviceHelp: "Obre-hi Configuració → Afegeix el teu telèfon i escaneja’n el codi amb la càmera d’aquest telèfon o enganxa’n l’enllaç del Home.",
        scan: "Escaneja",
    },
    happierAccount: 'compte de Happier',
    serviceAccount: ({ service }) => `compte de ${service}`,

    alreadyUseTitle: 'Ja fas servir Happier?',
    alreadyUseDescription: 'Troba els teus Homes amb el teu compte o connecta’t directament a un Home que gestiones. No canvia res en aquest ordinador fins que triïs.',
    signIn: 'Inicia sessió',
    withService: ({ service }) => `amb ${service}`,
    changeServiceLabel: ({ service }) => `Servei d’inici de sessió: ${service}. Canvia’l`,
    connectToHome: 'Connecta’t a un Home…',
    hostedPrompt: 'Prefereixes que te l’allotgin?',
    useServiceAsAHome: ({ service }) => `Fes servir ${service} com a Home`,
    dismiss: 'Descarta',

    pathServiceTitle: ({ service }) => `Inicia sessió amb ${service}`,
    pathServiceSubtitle: 'Troba els Homes enllaçats al teu compte',
    pathOtherServiceTitle: 'Inicia sessió amb un altre servei',
    pathOtherServiceSubtitle: 'El teu propi inici de sessió o el de la teva empresa',
    pathDirectTitle: 'Connecta’t directament a un Home',
    pathDirectSubtitle: 'Un enllaç o una adreça · sense compte',

    serviceLead: 'Els teus Homes apareixen junts quan inicies sessió. El Home personal d’aquest ordinador es manté fins que decideixis.',
    defaultServiceFact: 'el servei d’inici de sessió predeterminat',
    serviceMethodsHelp: ({ service }) => `Només es mostren els mètodes que ofereix ${service}. Ets nou? Els mateixos botons creen el teu compte.`,

    otherServiceLead: 'Si tu o el teu equip gestioneu el vostre propi servei d’inici de sessió, introdueix-ne l’adreça. Happier comprova què ofereix abans de res.',
    serviceAddressLabel: 'Adreça del servei d’inici de sessió',
    serviceFound: 'Trobat',
    useThisService: ({ service }) => `Inicia sessió amb ${service}`,
    addressIsNotAService: 'Aquesta adreça no ofereix inici de sessió amb compte. Si és un Home, connecta-t’hi directament.',
    connectAsHome: 'Connecta-t’hi com a Home',
    backToService: ({ service }) => `Torna a ${service}`,

    directLead: 'Per a un Home que gestiones tu mateix, amb servei de comptes o sense. No cal cap compte de Happier.',
    fromDeviceLabel: 'Des d’un dispositiu que ja està connectat',
    fromDeviceHelp: 'Obre-hi Configuració → Afegeix el teu telèfon i escaneja’n el codi amb la càmera d’aquest ordinador o enganxa’n l’enllaç del Home.',
    homeLinkLabel: 'Enllaç del Home',
    homeLinkPlaceholder: 'Enganxa un enllaç de Home',
    useCamera: 'Fes servir la càmera',
    openLink: 'Obre',
    byAddressLabel: 'Per adreça',
    homeAddressPlaceholder: 'https://home.example.com',
    connect: 'Connecta',
    byAddressHelp: 'Happier comprova que el Home respon i després inicies sessió amb els mètodes d’aquell Home.',
    notAHomeLink: 'Això no és un enllaç de Home. Torna’l a copiar de l’altre dispositiu.',
    homeUnreachable: 'Happier no ha pogut arribar a cap Home en aquesta adreça. Comprova l’adreça i que el Home estigui en marxa.',

    anotherWay: 'Una altra manera',
    homeReachable: 'Accessible',
    connected: 'Connectat',
    signInToHomeTitle: 'Inicia sessió en aquest Home',
    signInToHomeLead: 'Aquestes són les maneres que ofereix aquest Home.',

    reconcileTitle: 'Els teus Homes estan connectats',
    reconcileLead: ({ count }) => count === 1
        ? 'Ara aquest ordinador té dos Homes. Es mostren junts a Totes les Homes.'
        : `Ara aquest ordinador té ${count + 1} Homes. Es mostren junts a Totes les Homes.`,
    reconcileFound: 'Trobats',
    reconcileThisComputer: 'Aquest ordinador',
    runSessionsIn: 'Executa les sessions d’aquest ordinador a',
    runSessionsInDescription: 'Les sessions noves iniciades aquí es desen en aquest Home.',
    removeEmptyPersonalHome: 'Elimina el Home personal buit',
    removeEmptyPersonalHomeDescription: 'Es va crear quan vas instal·lar Happier i encara no conté res: ni sessions, ni persones, ni equips, ni invitacions.',
    changeLater: 'Pots canviar-ho més tard a Configuració → Homes.',
    keepBoth: 'Conserva’ls tots dos',
    useHome: ({ home }) => `Fes servir ${home}`,
    reconcileSetupTitle: 'Tria on van les sessions d’aquest ordinador',
    reconcileSetupSubtitle: ({ home }) => `Has connectat ${home}. Conserva els dos Homes o executa-hi les sessions d’aquest ordinador.`,
    reconcileSetupAction: 'Tria…',

    serviceAsHomeTitle: ({ service }) => `Fes servir ${service} com a Home`,
    serviceAsHomeLead: ({ service }) => `Les teves sessions i la configuració es desen a ${service} en lloc d’aquest ordinador.`,
    factAlwaysOn: 'Sempre disponible',
    factAlwaysOnDetail: 'El teu telèfon arriba a les sessions mentre aquest ordinador dorm.',
    factAgents: 'Aquest ordinador continua executant els teus agents',
    factAgentsDetail: 'No canvia res d’on s’executa el codi.',
    storageE2ee: 'Xifrat d’extrem a extrem',
    storageE2eeDetail: ({ service }) => `${service} desa les teves sessions però no les pot llegir.`,
    storagePlain: ({ service }) => `Desat per ${service}`,
    storagePlainDetail: 'Sense xifratge d’extrem a extrem: el servei pot llegir el que desa.',
    storageE2eeByDefault: 'Xifrat d’extrem a extrem per defecte',
    storagePlainByDefault: ({ service }) => `Desat per ${service}, llegible per defecte`,
    storageChoiceDetail: 'Ho tries en crear el compte.',
    removeEmptyOfferedDetail: 'Encara no conté res. Només s’ofereix perquè és buit.',
    signInOrCreate: ({ account }) => `Inicia sessió o crea el teu ${account}`,
    alreadyUseServiceAsHome: ({ service }) => `Ja fas servir ${service} com a Home? En iniciar sessió s’hi connecta directament.`,

    addHomeTitle: 'Afegeix un Home',
    addHomeDescription: 'Un Home desa les teves sessions i la configuració. Connecta’n un que ja facis servir o comença’n un en un altre lloc.',
    addSignIn: ({ account }) => `Inicia sessió amb el teu ${account}`,
    addSignInSubtitle: 'Troba els Homes que ja fas servir i connecta’ls.',
    addServiceAsHomeSubtitle: 'Allotjat per a tu i sempre disponible.',
    addLinkOrQr: 'Connecta’t amb un enllaç o un codi QR',
    addLinkOrQrSubtitle: 'No cal cap compte. Obtén-lo d’un dispositiu que ja estigui connectat.',
    addServerHome: 'Configura un Home en un servidor',
    addServerHomeSubtitle: 'Un entorn de desenvolupament o un VPS que controles, configurat per SSH.',
    haveHomeAddress: 'Tens l’adreça d’un Home?',
    enterIt: 'Introdueix-la',

    livesOnThisComputer: 'És en aquest ordinador',
    availableWhileAwake: 'disponible mentre està despert',
    gettingReady: 's’està preparant',
    noComputerYet: 'Encara no tens ordinador?',
    aboutYourHome: 'Quant al teu Home',

    nudgeTitle: ({ count }) => `Home inaccessible ${count} vegades aquesta setmana — el vols moure?`,
    nudgeBody: 'Si aquest Home funciona en un ordinador que dorm, moure’l a un servidor sempre encès pot ajudar.',
    nudgeDismiss: 'Descarta-ho per sempre en aquest dispositiu',
    moveHome: 'Mou el Home…',
    useService: ({ service }) => `Fes servir ${service}`,
};

const homesJourneysTranslations = { ca } satisfies Pick<Readonly<Record<string, HomesJourneysTranslation>>, "ca">;

return { homesJourneysTranslations };
})();

const Domain_identityAdministrationTranslations = (() => {
type IdentityAdministrationLanguage = Shared_identityAdministrationTranslations.IdentityAdministrationLanguage;

type Words = Shared_identityAdministrationTranslations.Words;

type GitHubAccessWords = Shared_identityAdministrationTranslations.GitHubAccessWords;

type OidcEditorWords = Shared_identityAdministrationTranslations.OidcEditorWords;

const build = Shared_identityAdministrationTranslations.build;

const en = Shared_identityAdministrationTranslations.en;

const githubAccessWords: Pick<Readonly<Record<IdentityAdministrationLanguage, GitHubAccessWords>>, "ca"> = { ca: {
        githubCurrentAccess: 'Accés actual',
        githubCurrentAccessSubtitle: 'Necessari per a les connexions i les fonts de directori activades que fan servir aquesta instal·lació.',
        githubCurrentAccessEmpty: 'Els serveis activats no requereixen accés.',
        githubSetupAccess: 'Accés per a configuració i reparació',
        githubSetupAccessSubtitle: 'Accés per a les connexions configurades, incloses les desactivades i les fonts de directori en pausa. Concedeix l’accés que falta a GitHub abans d’activar-les o reprendre-les i torna a verificar la instal·lació.',
        githubRemoveInstallationFor: ({ name }: { name: string }) => `Elimina la instal·lació de ${name}`,
    } };

const oidcEditorWords: Pick<Readonly<Record<IdentityAdministrationLanguage, OidcEditorWords>>, "ca"> = { ca: {
        clientAuthenticationMethod: 'Autenticació del client', clientSecretPost: 'Cos POST', clientSecretBasic: 'HTTP Basic', storeRefreshToken: 'Desa el testimoni de renovació', buttonColor: 'Color del botó d’accés', iconHint: 'Icona d’accés',
        allowRulesHint: 'Introdueix un valor per línia. Deixa-ho buit per no restringir.', brandingHint: 'Deixa-ho buit per utilitzar l’aparença d’accés predeterminada.', invalidScopes: 'Inclou openid en els àmbits sol·licitats.', refreshFailed: 'No s’ha pogut actualitzar aquesta connexió', refreshFailedHint: 'Els canvis es conserven. Torna-ho a provar per comprovar els canvis al Home.',
    } };

const identityAdministrationTranslations = { ca: build({ ...en, title: 'Proveïdors d’identitat', subtitle: 'Connexions d’accés del Home disponibles per als Teams.', homeConnections: 'Connexions del Home', add: 'Afegeix una connexió', empty: 'No hi ha connexions del Home', active: 'Activa', disabled: 'Desactivada', configuration: 'Configuració', issuer: 'URL de l’emissor', clientSecret: 'Secret del client', secretSet: 'Definit', secretNotSet: 'No definit', secretRetain: 'Deixa-ho buit per conservar el secret actual.', advanced: 'Mostra opcions avançades', hideAdvanced: 'Amaga opcions avançades', actions: 'Accions', test: 'Prova l’accés', testing: 'S’està obrint la prova…', edit: 'Edita la connexió', save: 'Desa la connexió', saving: 'S’està desant…', enable: 'Activa la connexió', disable: 'Desactiva la connexió', remove: 'Elimina la connexió', createTitle: 'Afegeix un proveïdor d’identitat', editTitle: 'Edita el proveïdor d’identitat', displayName: 'Nom', required: 'Completa els camps obligatoris.', invalidIssuer: 'Introdueix un URL HTTPS vàlid.', secretRequired: 'Introdueix un secret del client.', error: 'El canvi no s’ha aplicat.', accounts: 'Accounts afectats', connections: 'Connexions del Team', errorForbidden: 'Ja no tens permís per a això. No s’ha canviat res.', errorConflict: 'Algú altre ho ha canviat abans. Els teus canvis es conserven: torna a carregar i prova-ho de nou.', errorMissing: 'Això ja no existeix. Pot ser que algú ho hagi eliminat.', errorInUse: 'Encara hi ha coses que en depenen. Elimina-les primer.', errorProviderUnavailable: 'El servei d’identitat no ha respost. No s’ha canviat res.', errorRateLimited: 'El proveïdor demana esperar abans de tornar-ho a provar.', errorInvalid: 'El Home ha rebutjat aquests valors. Revisa la configuració i torna-ho a provar.', errorImmutable: 'Aquest valor queda fix quan el registre s’usa. Crea’n un de nou.', errorAuthenticationRequired: 'Torna a iniciar la sessió en aquest Team i torna-ho a provar. No s’ha canviat res.', errorPolicyUnavailable: 'La política d’autenticació del Team no es pot avaluar ara mateix. No s’ha canviat res.', errorPolicyInUse: 'La política d’autenticació del Team encara depèn d’aquesta connexió.', errorNotAllowed: 'Aquest Home no permet que els Teams configurin això. No s’ha canviat res.', errorNeedsAttention: 'La sincronització del directori requereix atenció. Executa una sincronització completa.', errorSyncPaused: 'Aquesta font està en pausa. «Reprèn la sincronització» inicia una sincronització completa nova.', alternateLogins: 'Accounts que necessiten un altre mètode d’accés', recoveryAuthenticationPolicy: 'Obre l’autenticació del Team', recoveryAlternateLogin: 'Dona primer un altre mètode d’accés a aquests Accounts', recoveryDirectory: 'Obre el directori', recoveryGroupMappings: 'Obre les assignacions de Grups', recoveryTeamAuthentication: 'Torna a iniciar la sessió', callbackUrl: 'URL de retorn', callbackUrlHint: 'Registra aquesta URL al teu proveïdor d’identitat.' }, githubAccessWords.ca, oidcEditorWords.ca) };

return { githubAccessWords, oidcEditorWords, identityAdministrationTranslations };
})();

const Domain_inboxWorkTranslations = (() => {
const en = Shared_inboxWorkTranslations.en;

const ca: typeof en = {
    pageDescription: 'Tot el que t’espera, agrupat per la feina a què pertany.',
    tabs: { a11y: 'Vista de la safata', needsYou: 'Et necessita', updates: 'Novetats' },
    groups: {
        unknownLead: 'Sessió',
        leadMeta: ({ count }) => (count === 1 ? '1 subsessió' : `${count} subsessions`),
        runMeta: 'Execució de flux de treball',
        otherTitle: 'Altres sessions',
        otherMeta: 'No formen part d’un orquestrador ni d’una execució',
        openSession: 'Obre la sessió',
        openRun: 'Obre l’execució',
    },
    rows: {
        step: 'Pas',
        workflowRun: 'Execució de flux de treball',
        review: 'Revisa',
        stalled: 'Aturada',
        stalledReason: 'La màquina s’ha desconnectat enmig del torn',
        landing: 'Pendent de fusionar',
        settle: 'Tanca',
        snoozedUntil: ({ time }) => `Posposada fins ${time}`,
        more: 'Més accions',
    },
    popover: {
        moreInOther: ({ count }) => `${count} més a Altres sessions`,
        updates: ({ count }) => (count === 1 ? '1 novetat' : `${count} novetats`),
    },
    empty: {
        title: 'Res no et necessita',
        description: 'Aquí arriben les sol·licituds de permís, les revisions i tot el que un orquestrador o un flux de treball espera de tu.',
    },
    updatesEmpty: {
        title: 'Cap novetat',
        description: 'Aquí arriben les sessions acabades i les sol·licituds d’amistat.',
    },
    stale: { reason: 'No s’han pogut actualitzar les execucions de fluxos de treball', retry: 'Torna-ho a provar' },
    settleFailed: 'No s’ha pogut tancar aquesta sessió',
};

const inboxWorkTranslations = { ca };

return { inboxWorkTranslations };
})();

const Domain_inputPickerTranslations = (() => {
type InputPickerTranslation = Shared_inputPickerTranslations.InputPickerTranslation;

const inputPickerTranslations = { ca: {
        browse: 'Explora…',
        browseField: ({ field }) => `Explora per a ${field}`,
        unavailable: 'El connector que ofereix aquesta opció no està disponible. Es conserva el valor actual.',
        retired: 'El connector s’ha actualitzat mentre triaves. Torna-ho a provar.',
        invalid: 'Aquesta opció no es pot fer servir aquí. Es conserva el valor actual.',
        failed: 'El selector no s’ha pogut obrir. Torna-ho a provar.',
    } } satisfies Pick<Readonly<Record<string, InputPickerTranslation>>, "ca">;

return { inputPickerTranslations };
})();

const Domain_machineAddTranslations = (() => {
type MachineAddTranslation = Shared_machineAddTranslations.MachineAddTranslation;

const machineAddTranslations = { ca: { newMachine: 'Màquina nova', waiting: 'Esperant que es connecti', connected: 'Connectada', failed: 'No s’ha pogut afegir aquesta màquina', cancelled: 'Cancel·lat', cannotReachHost: 'No es pot accedir a l’amfitrió. Comprova l’adreça i l’accés SSH.', choosePath: 'Tria com afegir una màquina', switchHome: 'Torna a aquesta llar per continuar' } } satisfies Pick<Record<'en' | 'ru' | 'pl' | 'es' | 'fr' | 'it' | 'pt' | 'ca' | 'de' | 'zh-Hans' | 'zh-Hant' | 'ja', MachineAddTranslation>, "ca">;

return { machineAddTranslations };
})();

const Domain_machineAgentsTranslations = (() => {
type MachineAgentsTranslation = Shared_machineAgentsTranslations.MachineAgentsTranslation;

const en = Shared_machineAgentsTranslations.en;

const ca: MachineAgentsTranslation = {
    signedInWith: ({ label }) => `Sessió iniciada amb ${label}`,
    signedInAs: ({ label }) => `Sessió iniciada com a ${label}`,
    signedInHere: 'Sessió iniciada en aquesta màquina',
    updateTo: ({ version }) => `Actualitza a ${version}`,
    needsSignIn: 'Cal iniciar sessió',
    waitingForSignIn: 'Esperant l’inici de sessió al terminal…',
    notInstalled: 'No instal·lat',
    downloadSize: ({ size }) => `Baixada de ${size}`,
    installYourself: 'Instal·la’l tu mateix',
    unsupportedOs: 'No funciona en aquest sistema',
    unsupportedArch: 'No hi ha versió per a aquest processador',
    installing: 'Instal·lant…',
    progress: ({ done, total }) => `${done} de ${total}`,
    checking: 'Comprovant…',
    offlineSignedIn: 'Darrer estat: sessió iniciada · màquina fora de línia',
    offlineSignedOut: 'Darrer estat: sense sessió · màquina fora de línia',
    offlineNotInstalled: 'No instal·lat el darrer cop · màquina fora de línia',
    offlineUnknown: 'Màquina fora de línia',
    unknown: 'No s’ha pogut comprovar aquesta màquina',
    actionInstall: 'Instal·la',
    actionUpdate: 'Actualitza',
    actionSignIn: 'Inicia sessió',
    actionRetry: 'Torna-ho a provar',
    actionCancel: 'Cancel·la',
    actionShowTerminal: 'Mostra el terminal',
    actionGuide: 'Guia d’instal·lació',
    installLeadManaged: ({ agent, machine }) => `Happier instal·la ${agent} a ${machine} només per a Happier. La teva configuració del terminal no canvia.`,
    installLeadVendor: ({ agent, machine }) => `Happier executa l’instal·lador de ${agent} a ${machine}.`,
    installAlsoDownloads: ({ what }) => `També baixa ${what}, que fan servir les sessions.`,
    installThenSignIn: 'Després inicies sessió.',
    installAgent: ({ agent }) => `Instal·la ${agent}`,
    installMyself: 'L’instal·laré jo',
    manualLead: ({ agent, machine }) => `Happier no pot instal·lar ${agent} per tu. Instal·la’l a ${machine} amb la guia i torna a comprovar.`,
    checkAgain: 'Torna a comprovar',
    closeNote: ({ machine }) => `Pots tancar-ho; continua a ${machine}.`,
    stepCheck: 'Comprova que funciona',
    stepSignIn: 'Inici de sessió',
    failedKept: 'No s’ha deixat res mig instal·lat.',
    installedLine: ({ agent, version }) => `${agent} ${version} està instal·lat`,
    nowSignIn: 'ara inicia sessió',
    signInHow: ({ agent }) => `Com inicia sessió ${agent}`,
    useService: ({ service }) => `Fes servir el teu ${service}`,
    recommended: 'Recomanat',
    serviceConnected: ({ profile }) => `${profile} · ja connectat · funciona a totes les màquines`,
    serviceNotConnected: 'Connecta’l un cop; totes les màquines el poden fer servir.',
    connect: 'Connecta',
    signInOn: ({ machine }) => `Inicia sessió a ${machine}`,
    signInOnDetail: ({ agent }) => `Executa l’inici de sessió de ${agent} en un terminal allà. Només el fa servir aquesta màquina.`,
    noNativeLogin: ({ agent }) => `${agent} no té inici de sessió propi: fa servir una clau d’API o un compte connectat. Connecta’n un cop i totes les màquines el podran fer servir.`,
    openSignInTerminal: 'Obre l’inici de sessió al terminal',
    useThisAccount: 'Fes servir aquest compte',
    waitingLead: ({ agent, machine }) => `L’inici de sessió de ${agent} és obert al terminal de ${machine}. Quedarà a punt tan bon punt informi que has iniciat sessió.`,
    readyLine: ({ agent, machine }) => `${agent} està a punt a ${machine}`,
    startSessionWith: ({ agent }) => `Inicia una sessió amb ${agent}`,
    setUpAnother: 'Configura un altre agent',
    unsupportedLead: ({ agent, machine }) => `${agent} no té versió per a ${machine}, així que no hi pot funcionar.`,
    setupTitle: ({ agent }) => `Configura ${agent}`,
    signInTitle: ({ agent }) => `Inicia sessió a ${agent}`,
    readyTitle: ({ agent }) => `${agent} està a punt`,
    notOnMachineYet: ({ machine }) => `Encara no és a ${machine}`,
    onMachine: ({ machine }) => `A ${machine}`,
    installingOn: ({ machine }) => `Instal·lant a ${machine}`,
    cantRunOn: ({ machine }) => `No funciona a ${machine}`,
    terminalTab: ({ agent }) => `Inici de sessió · ${agent}`,
    panelLead: 'Acaba al navegador que s’ha obert. Un altre dispositiu? Obre-hi l’enllaç.',
    open: 'Obre',
    openSignInPage: 'Obre la pàgina d’inici de sessió',
    waitingEllipsis: 'Esperant l’inici de sessió…',
    signedInAlready: 'Ja has iniciat sessió?',
    closeTerminal: 'Tanca el terminal',
    showTheTerminal: 'Mostra el terminal',
    phoneLead: ({ agent, machine }) => `${agent} et demana que iniciïs sessió. Obre la pàgina aquí, acaba i ${machine} ho detectarà.`,
    panelSignedInAs: ({ account }) => `Sessió iniciada com a ${account}.`,
    panelChecked: 'Happier ho ha comprovat fa un moment.',
    sectionTitle: 'Agents',
    sectionDescription: 'Els agents de programació d’aquesta màquina i com inicia sessió cadascun.',
    addTitle: 'Afegeix un agent',
    addMore: ({ count }) => (count === 1 ? `1 més funciona aquí` : `${count} més funcionen aquí`),
    showAll: 'Mostra-ho tot',
    showFewer: 'Mostra’n menys',
    emptyInstalled: 'Aquesta màquina encara no té cap agent. Tria’n un a sota; Happier l’instal·la i t’hi connecta.',
    offlineNote: ({ machine }) => `${machine} és fora de línia. Això és el darrer que va informar.`,
    firstTitle: 'Configura el teu primer agent',
    firstLead: ({ machine }) => `${machine} està connectat, però encara no té cap agent. Tria’n un; Happier l’instal·la i t’hi connecta.`,
    firstMore: ({ count }) => (count === 1 ? `O tria entre 1 agent més.` : `O tria entre ${count} agents més.`),
    allAgents: 'Tots els agents',
    setUp: 'Configura',
    choiceUsesService: ({ service, profile }) => `Fa servir el teu ${service}. Connectat: ${profile}.`,
    choiceSignsInOn: 'Inicia sessió a la màquina.',
    dismissFirst: 'Amaga «Configura el teu primer agent»',
    dismissTooltip: 'Amaga · restaura-ho des de Personalitza',
    chooseAgent: 'Tria un agent',
    blockNotInstalled: ({ agent, machine }) => `${agent} encara no és a ${machine}.`,
    blockSetUpToStart: 'Configura’l per començar.',
    blockSignedOut: ({ agent, machine }) => `${agent} ha d’iniciar sessió a ${machine}.`,
    spawnCliMissing: ({ agent, machine }) => `${agent} no està instal·lat a ${machine}.`,
    spawnSignedOut: ({ agent, machine }) => `${agent} no té sessió a ${machine}.`,
    draftKept: 'El teu missatge es conserva.',
    alreadySetUp: ({ machine, home }) => `${machine} ja està connectat a ${home}`,
    startSession: 'Inicia una sessió',
    openMachine: ({ machine }) => `Obre ${machine}`,
};

const machineAgentsTranslations = { ca: ca } satisfies Pick<Readonly<Record<string, MachineAgentsTranslation>>, "ca">;

return { machineAgentsTranslations };
})();

const Domain_machineDetailPageTranslations = (() => {
type MachineDetailPageTranslations = Shared_machineDetailPageTranslations.MachineDetailPageTranslations;

const english = Shared_machineDetailPageTranslations.english;

const translated = Shared_machineDetailPageTranslations.translated;

const machineDetailPageTranslations = { ca: translated({
        machineDetailPage: {
            description: 'Inicia sessions aquí i mira què s’executa en aquesta màquina.',
            placeholderTitle: 'Màquina',
            online: 'En línia',
            offline: 'Fora de línia',
            cliVersionFact: ({ version }) => `CLI ${version}`,
            replacedByFact: ({ machine }) => `Substituïda per ${machine}`,
            unavailableTitle: 'Aquesta màquina no pot iniciar sessions ara mateix',
            startAction: 'Inicia la sessió',
            tmuxSectionDescription: 'Com fan servir tmux les sessions noves d’aquesta màquina.',
            windowsSectionDescription: 'Com s’obren les sessions remotes en aquesta màquina.',
            clisSectionDescription: 'CLI d’agents que Happier ha trobat en aquesta màquina, i les eines que pot instal·lar.',
            runsSectionDescription: 'Processos que les sessions han iniciat en aquesta màquina.',
            recentSessionsTitle: 'Sessions recents',
            recentSessionsDescription: 'Les cinc sessions més recents d’aquesta màquina.',
            daemonSectionDescription: 'El servei en segon pla que connecta aquesta màquina amb Happier.',
            stopDaemonDescription: 'Les sessions en curs continuen. No se’n poden iniciar de noves fins que el tornis a iniciar en aquesta màquina.',
            stopDaemonAction: 'Atura',
            detailsTitle: 'Detalls de la màquina',
        },
    }) };

return { machineDetailPageTranslations };
})();

const Domain_machinePoolTranslations = (() => {
const en = Shared_machinePoolTranslations.en;

const ca = {
    machinesSection: "Màquines",
    tierPrimaryDescription: "Es prova primer.",
    tierFallbackDescription: "Es prova quan cap màquina anterior no és en línia.",
    pauseMember: "Posa en pausa per a sessions noves",
    resumeMember: "Fes servir per a sessions noves",
    pausedState: "En pausa",
    memberMenu: "Opcions de la màquina",
    newPoolTitle: "Nou grup de màquines",
    title: "Pools de màquines",
    myTitle: "Els meus pools de màquines",
    add: "Afegeix un grup de màquines",
    benefit: "Trieu una màquina preferida, amb altres disponibles com a alternativa.",
    placementChangeNotice: "Els canvis s’apliquen a les sessions que comencin després de desar. Les sessions obertes es queden a la seva màquina.",
    connectionSemantics: "Es tria una màquina quan s’obre una connexió i queda seleccionada per a aquella connexió. Una connexió posterior pot triar una altra màquina.",
    noMembers: "Encara no hi ha màquines en aquest pool",
    unavailable: "No disponible",
    memberRevoked: "Revocat",
    memberReplaced: "Substituït",
    memberTemporary: "Temporal",
    availabilityUnknown: "Disponibilitat de connexió desconeguda",
    notVerified: "No verificat",
    brokerUnavailable: "No hi ha cap intermediari disponible",
    brokerAvailable: ({ count }: { count: number }) => `${count} disponibles`,
    basics: "Detalls",
    name: "Nom",
    description: "Descripció (opcional)",
    descriptionTitle: "Descripció",
    addMachines: "Afegeix màquines",
    noMachines: "No hi ha màquines persistents disponibles en aquest Home.",
    allMachinesAdded: "Totes les màquines d’aquest Home ja són en aquest pool.",
    primary: "primària",
    addFallback: "Afegeix una alternativa",
    moveTo: "Mou a",
    moveTierEarlier: "Mou aquest nivell abans",
    moveTierLater: "Mou aquest nivell més tard",
    removeMember: "Elimina del pool",
    enableMember: "Utilitzeu-lo per a futures seleccions",
    save: "Desa els canvis",
    create: "Crea un pool",
    delete: "Suprimeix l'agrupació de màquines",
    deleteTitle: "Vols suprimir aquest grup de màquines?",
    deleteBody: "Qualsevol recurs de credencials que utilitzi aquest pool perdrà la ubicació del broker i caldrà reparar-los. Això afecta les seleccions futures, però no elimina màquines ni atura sessions en execució.",
    saveFailed: "No s'ha pogut desar aquest grup de màquines. Els vostres canvis encara són aquí.",
    deleteFailed: "No s'ha pogut suprimir aquest grup de màquines. Torna-ho a provar.",
    conflictTitle: "Aquest pool s’ha modificat en un altre lloc",
    conflictBody: "Els vostres canvis no desats es conserven. Torneu a carregar la versió desada per revisar els darrers canvis.",
    conflictNoReload: "La identitat del pool ja no està disponible. Els vostres canvis no desats es conserven.",
    homeOffline: "Aquest Home està fora de línia. Els canvis del pool estaran disponibles quan es torni a connectar.",
    refreshFailed: "No s’han pogut actualitzar els pools de màquines. Es mostra l’última llista coneguda.",
    featureUnavailable: "Els pools de màquines no estan disponibles en aquest Home. Actualitza’ls o activa’ls al Home per continuar.",
    openSettings: "Configuració del grup de màquines",
    pickSpecificMachine: "Tria una màquina específica",
    poolNotFound: "Aquest grup de màquines ja no està disponible.",
    reload: "Torna a carregar la versió desada",
    reloadTitle: "Vols descartar els canvis no desats?",
    reloadBody: "Tornar a carregar substitueix aquest formulari per la darrera versió desada.",
    privacy: "El servidor d’aquest Home pot llegir els noms, les descripcions i els membres dels pools, fins i tot en comptes amb xifratge d’extrem a extrem.",
    nameRequired: "Introduïu un nom abans de desar.",
    memberNotEligible: "Algunes màquines ja no poden pertànyer a aquest grup.",
    memberNotEligibleDetail: "Elimineu aquesta màquina o trieu una altra màquina persistent.",
    resolvingTarget: "Escollint una màquina d’aquest pool…",
    resolveEmpty: "Aquest grup no té màquines habilitats.",
    resolveNoAvailable: "Actualment no hi ha cap màquina disponible en aquest pool.",
    resolvePresenceUnavailable: "La disponibilitat de la màquina es desconeix temporalment.",
    resolveFailed: "Happier no ha pogut triar una màquina d’aquest pool. Torna-ho a provar.",
    executionMachine: "Executa a",
    chosenFrom: "Escollit entre",
    aMachinePool: "Un pool de màquines",
    availabilityKnown: ({ connected, enabled }: { connected: number; enabled: number }) => `${connected} de ${enabled} d’activades connectades`,
    fallback: ({ number }: { number: number }) => `Alternativa ${number}`,
};

const machinePoolTranslations = { ca };

return { machinePoolTranslations };
})();

const Domain_mcpSettingsTranslations = (() => {
type McpSettingsCopy = Shared_mcpSettingsTranslations.McpSettingsCopy;

const en = Shared_mcpSettingsTranslations.en;

const ca: McpSettingsCopy = {
    purpose: 'Servidors d’eines que els teus agents poden fer servir a les sessions. Afegeix un servidor una vegada i tria on s’aplica.',
    add: 'Afegeix un servidor MCP',
    addConfigure: 'Configura un servidor',
    addConfigureDescription: 'Introdueix-ne l’ordre o l’adreça',
    addImportJson: 'Enganxa una configuració JSON',
    addImportJsonDescription: 'D’un README o d’una altra app',
    addOwnCategory: 'Afegeix el teu',
    addPresetCategory: 'Instal·lació ràpida',
    addFromMachine: 'Importa des d’aquesta màquina',
    addFromMachineDescription: 'Servidors que ja fan servir altres agents',
    searchPlaceholder: 'Cerca servidors',
    toolsGroup: 'Eines',
    unbound: 'Encara no es fa servir enlloc',
    newServer: 'Servidor MCP nou',
    serverPurpose: 'Un servidor d’eines que els teus agents poden fer servir. Tria a sota on s’aplica.',
    addByTitle: 'Afegeix mitjançant',
    serverSection: 'Servidor',
    serverSectionDescription: 'Com es diu el servidor a les sessions i en aquesta llista.',
    connectionSection: 'Connexió',
    connectionSectionDescription: 'Com Happier inicia o arriba al servidor.',
    envDescription: 'Valors que es passen al servidor. Fes servir un secret desat per a les claus.',
    headersDescription: 'S’envien amb cada sol·licitud. Fes servir un secret desat per als tokens.',
    addRule: 'Afegeix una regla',
    discardDraft: 'Descarta',
    landingTitle: 'Dona més eines als teus agents',
    landingDescription: 'Els servidors MCP afegeixen eines com un navegador, cerca de documentació o GitHub. Configura’n un, enganxa una configuració o comença amb una configuració predefinida.',
    onMachineTitle: 'Trobats en aquesta màquina',
    onMachinePurpose: 'Servidors MCP que altres agents ja configuren en aquesta màquina. Importa’n un per fer-lo servir des de Happier.',
    onMachineSearchSection: 'On buscar',
    onMachineSearchDescription: 'Configuracions d’agents a la teva carpeta personal i, si en tries una, a una carpeta de projecte.',
    onMachineFoundSection: 'Servidors',
    onMachineFoundDescription: 'Importar copia el servidor a Happier; la configuració original no canvia.',
    previewTitle: 'Què reben les sessions',
    previewPurpose: 'Comprova quins servidors MCP rep una sessió per a un agent i una carpeta, i què passa quan un no es pot iniciar.',
    previewContextSection: 'Sessió',
    previewContextDescription: 'L’agent i la carpeta amb què començaria una sessió nova.',
    failurePolicyTitle: 'Quan un servidor no es pot iniciar',
    failurePolicyDescription: 'Per exemple, quan falta un secret desat que necessita.',
    failurePolicySkip: 'Omet-lo',
    failurePolicyStop: 'Atura la sessió',
    failureSection: 'Fiabilitat',
    failureSectionDescription: 'S’aplica a tots els servidors MCP de totes les sessions.',
    previewNothingTitle: 'No es lliuraria res',
    previewNothingDescription: 'Cap servidor MCP s’aplica a aquest agent i carpeta. Afegeix un servidor o una regla que els cobreixi.',
    check: 'Comprova',
    scan: 'Cerca',
};

const mcpSettingsTranslations = { ca } as const;

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

const ca: DesktopTrayTranslation = {
    open: 'Obre Happier',
    openInHappier: 'Obre a Happier',
    settings: 'Configuració…',
    startAtLogin: 'Inicia en entrar',
    quit: 'Surt de Happier',
    stopServicesAndQuit: 'Atura els serveis en segon pla i surt…',
    sessions: ({ count }: CountParams) => `${count} en curs`,
    start: 'Inicia',
    restart: 'Reinicia',
    stop: 'Atura…',
    userOwned: 'Gestionat fora de Happier',
    checking: 'Comprovant els serveis en segon pla…',
    readFailed: 'No s’han pogut comprovar els serveis en segon pla',
    incomplete: 'Alguns serveis en segon pla no s’han pogut comprovar',
    noServices: 'Aquest ordinador encara no està configurat',
    working: 'Treballant…',
    stopConfirmTitle: ({ relay }: RelayParams) => `Vols aturar el servei en segon pla de Happier per a ${relay}?`,
    stopConfirmBody: ({ relay }: RelayParams) =>
        `Les sessions d’agent que s’executen en aquest ordinador per a ${relay} acabaran, i el telèfon i el navegador no hi podran accedir allà fins que el servei torni a iniciar-se.`,
    stopAllConfirmTitle: 'Vols aturar els serveis en segon pla de Happier i sortir?',
    stopAllConfirmBody: 'Les sessions d’agent d’aquest ordinador acabaran, i el telèfon i el navegador no hi podran accedir fins que els seus serveis en segon pla tornin a iniciar-se.',
    stopConfirmAction: 'Atura',
    actionFailedTitle: 'No s’ha pogut completar',
    loginItemFailed: 'No s’ha pogut actualitzar l’element d’inici de Happier',
    quitStopTitle: 'Encara hi ha sessions d’agent en execució',
    quitStopBody: 'En sortir s’aturen els serveis en segon pla d’aquest ordinador i acaben les sessions que s’hi executen.',
    quitStopUnknownTitle: 'Vols aturar els serveis en segon pla?',
    quitStopUnknownBody: 'Happier no veu quines sessions s’executen en aquest ordinador. En sortir s’aturen els seus serveis en segon pla i acaben les que hi hagi.',
    quitStopConfirm: 'Atura igualment',
    quitStopKeep: 'Deixa’ls en marxa',
    quitStopFailedTitle: 'Alguns serveis en segon pla no s’han aturat',
    quitStopFailedBody: ({ detail }: DetailParams) => `${detail} Happier es manté obert perquè puguis comprovar els serveis en segon pla i tornar-ho a provar.`,
};

const caLoginStart: DesktopLoginStartTranslation = {
    title: 'Inicia en entrar',
    subtitle: 'Manté aquest ordinador accessible des del telèfon i el navegador: els seus serveis en segon pla s’inicien quan entres i continuen després de sortir de Happier. Si està desactivat, sortir de Happier els atura.',
    unknown: 'Happier encara no sap si els serveis en segon pla d’aquest ordinador s’inicien en entrar.',
    notSetUp: 'Disponible quan aquest ordinador estigui configurat.',
};

const menuBarModeTranslations = { ca: { tray: ca, loginStart: caLoginStart } };

return { menuBarModeTranslations };
})();

const Domain_nativePasswordTranslations = (() => {
const nativePasswordTranslations = { ca: {
        email: 'Correu electrònic',
        password: 'Contrasenya',
        signIn: 'Inicia la sessió',
        title: 'Correu i contrasenya',
        forgotPassword: 'Has oblidat la contrasenya?',
        capsLock: 'El bloqueig de majúscules està activat',
        emailRequired: 'Introdueix la teva adreça de correu electrònic.',
        passwordRequirements: 'Fes servir almenys 15 caràcters, fins a 1.024 bytes UTF-8. Es permeten espais.',
        unavailable: 'L’inici de sessió amb correu i contrasenya no està disponible en aquest Home.',
        rateLimited: 'Massa intents. Espera un moment i torna-ho a provar.',
        emailInvalid: 'Introdueix una adreça de correu vàlida.',
        passwordMalformed: 'Aquesta contrasenya conté caràcters que no podem desar de manera segura. Torna a escriure-la.',
        passwordMismatch: 'Les contrasenyes no coincideixen.',
        currentPasswordRequired: 'Introdueix la contrasenya actual.',
        currentPassword: 'Contrasenya actual',
        newPassword: 'Contrasenya nova',
        confirmPassword: 'Confirma la contrasenya',
        signInFailed: 'Aquesta combinació de correu i contrasenya no ha funcionat.',
        accountDisabledHere: 'Aquest compte està desactivat en aquest Home. Demana a una administració del Home que el torni a activar.',
        notEligible: 'Aquest compte no pot iniciar la sessió en aquest Home ara mateix.',
        linkExpired: 'Aquest enllaç ha caducat o ja s’ha fet servir. Demana’n un de nou.',
        revisionConflict: 'La teva contrasenya ha canviat en un altre lloc. Torna a carregar i prova-ho de nou.',
        serverUnavailable: 'Aquest Home no ha pogut completar la sol·licitud. Torna-ho a provar aviat.',
        offline: 'Sense connexió amb aquest Home. Comprova la xarxa i torna-ho a provar.',
        homeUnreachable: 'No s\'ha pogut contactar amb aquest Home. Torna-ho a provar.',
        securityFactUnavailable: 'No s\'ha pogut llegir des del teu Home.',
        cancelled: 'S’ha cancel·lat aquest intent.',
        approvalPending: 'Pendent de la teva aprovació. Revisa-la a la safata d’aprovacions i torna aquí.',
        outcomeUnconfirmed: 'No hem pogut confirmar si el canvi s’ha aplicat. Hem actualitzat aquest compte: comprova’l abans de tornar-ho a provar.',
        recoveryKeyRequired: 'Introdueix la teva clau de recuperació per canviar la contrasenya d’aquest compte xifrat d’extrem a extrem. La clau es queda en aquest dispositiu.',
        working: 'S’està processant…',
        showPassword: 'Mostra la contrasenya',
        hidePassword: 'Amaga la contrasenya',
        createTitle: 'Crea el teu compte',
        createAccount: 'Crea el compte',
        accountProtection: 'Protecció del compte',
        protectionPlain: 'Llegible pel Home',
        protectionPlainDetail: 'El teu Home pot llegir les teves dades. Si oblides la contrasenya, la pots restablir per correu.',
        protectionE2ee: 'Xifrat d’extrem a extrem',
        protectionE2eeDetail: 'Només els teus dispositius poden llegir les teves dades. Desa la clau de recuperació: restablir la contrasenya sola no les recupera.',
        checkYourEmail: 'Comprova el teu correu',
        resend: 'Torna-ho a enviar',
        resent: 'Enviat de nou. Comprova el teu correu.',
        useDifferentEmail: 'Fes servir un altre correu',
        connectTitle: 'Afegeix correu i contrasenya',
        connectFromSecurity: 'Inicia la sessió amb un mètode que ja facis servir i després afegeix correu i contrasenya des de Seguretat del compte.',
        signInFirst: 'Inicia la sessió primer',
        forgotTitle: 'Has oblidat la contrasenya?',
        forgotExplanation: 'Et podem enviar instruccions per correu, o pots fer servir la clau de recuperació que vas desar en crear el compte.',
        emailResetInstructions: 'Envia’m les instruccions per correu',
        useRecoveryKey: 'Fes servir la clau de recuperació',
        recoveryKeyDownload: 'Baixa la clau de recuperació',
        recoveryKeyLater: 'Fes-ho més tard',
        securitySectionTitle: 'Correu i contrasenya',
        signInEmail: 'Correu d’inici de sessió',
        signInEmailNotSet: 'Sense definir',
        passwordEnrolled: 'Configurada',
        passwordNotEnrolled: 'Sense configurar',
        passwordSetUp: 'La teva contrasenya està configurada per a aquest Home.',
        passwordChanged: 'La teva contrasenya s’ha canviat.',
        passwordRemoved: 'La teva contrasenya s’ha eliminat.',
        changePassword: 'Canvia la contrasenya',
        removePassword: 'Elimina la contrasenya',
        removePasswordSubtitle: 'Inicia la sessió només amb els altres mètodes',
        removePasswordConsequence: 'El teu correu i contrasenya ja no et permetran iniciar la sessió en aquest Home. Els altres mètodes i les teves dades no canvien.',
        changeEmailExplanation: 'Enviarem un correu a la nova adreça per confirmar-la. El teu correu actual continua funcionant fins que la confirmis.',
        sendVerification: 'Envia el correu de confirmació',
        verifyTitle: 'Confirma el teu correu',
        verifyGeneric: 'Aquest enllaç confirma el control d’una bústia.',
        verifyReturnToCreate: 'Torna a aquest Home per acabar de crear el compte amb aquesta adreça.',
        addressVerified: 'Aquesta adreça està confirmada.',
        confirmEmailChange: 'Fes-la servir com a correu d’inici de sessió',
        signInToConfirm: 'Inicia la sessió en aquest dispositiu per confirmar el canvi.',
        returnToSignIn: 'Torna a l’inici de sessió',
        continue: 'Continua',
        resetTitle: 'Estableix una contrasenya nova',
        resetChooseNew: 'Tria una contrasenya nova per a aquest Home.',
        resetComplete: 'La teva contrasenya s’ha canviat. Torna a iniciar la sessió amb la nova contrasenya.',
        resetSignsOutOtherDevices: 'Establir una contrasenya nova tanca la sessió d’aquest compte a tota la resta de llocs.',
        setNewPassword: 'Desa la contrasenya nova',
        emailPlaceholder: 'tu@exemple.cat',
        accountDisabled: ({ home }: { home: string }) => `Aquest compte està desactivat a ${home}. Demana a una administració del Home que el torni a activar.`,
        verificationSent: ({ email }: { email: string }) => `Hem enviat un enllaç de confirmació a ${email}. Obre’l per acabar de crear el compte.`,
        resetInstructionsSent: ({ email }: { email: string }) => `Si ${email} pot iniciar la sessió aquí, les instruccions per restablir-la ja són en camí.`,
        verificationPending: ({ email }: { email: string }) => `Confirmació enviada a ${email}`,
        verifyDestination: ({ email }: { email: string }) => `Aquest enllaç confirma ${email}.`,
        passwordNeedsEmail: 'Primer afegeix un correu d’inici de sessió',
        passwordNeedsEmailHint: 'Comença pel teu correu d’inici de sessió',
        setupStepConfirm: 'Confirma',
        setupProgress: ({ step, total, label }: { step: number; total: number; label: string }) => `Pas ${step} de ${total}: ${label}`,
        setupEmailHint: 'El correu d’inici de sessió i la contrasenya s’afegeixen junts. Primer enviarem un enllaç per confirmar l’adreça.',
        setupConfirmHint: 'Obre l’enllaç d’aquest correu per triar la contrasenya.',
        setupPasswordHint: 'Introdueix el correu que has confirmat i tria la contrasenya.',
    } } as const;

return { nativePasswordTranslations };
})();

const Domain_navigationPlacementTranslations = (() => {
type NavigationPlacementTranslation = Shared_navigationPlacementTranslations.NavigationPlacementTranslation;

const navigationPlacementTranslations = { ca: { customize: 'Personalitza…', title: 'Navegació', description: 'Tria què és visible, va a Més o queda ocult. Arrossega per ordenar. Es desa en aquest dispositiu.', pinned: 'Fixat', overflow: 'Més', hidden: 'Ocult', reset: 'Restableix', appRail: 'Barra esquerra', sessionRail: 'Barra de sessió', workspaceRail: 'Barra de l’espai de treball', sessionTabBar: 'Pestanyes del telèfon' } } satisfies Pick<Record<string, NavigationPlacementTranslation>, "ca">;

return { navigationPlacementTranslations };
})();

const Domain_pendingNavigationTranslations = (() => {
type Count = Shared_pendingNavigationTranslations.Count;

const en = Shared_pendingNavigationTranslations.en;

const ca: typeof en = {
    nextWithCount: ({ count }) => `${count} et necessiten`,
    next: 'Següent', answeredElsewhere: 'Ja s’ha respost',
    unavailableTitle: 'No s’ha pogut obrir la sol·licitud següent',
    unavailableBody: 'Algunes sessions pendents no estan disponibles. Torna a connectar-te i prova-ho de nou.',
    skippedUnavailable: ({ count }) => `S’han omès ${count} sessions no disponibles.`,
    waitsForPermission: 'demana el teu permís', waitsForInput: 'espera la teva resposta',
    sessionsWaiting: ({ count }) => `${count} sessions esperen`, go: 'Ves-hi', dismiss: 'Ara no',
};

const pendingNavigationTranslations = { ca };

return { pendingNavigationTranslations };
})();

const Domain_personalHomeBootstrapBlockedTranslations = (() => {
type PersonalHomeBootstrapBlockedTranslation = Shared_personalHomeBootstrapBlockedTranslations.PersonalHomeBootstrapBlockedTranslation;

const personalHomeBootstrapBlockedTranslations = { ca: {
        blocked: {
            runtime_unhealthy: 'El teu Home local necessita atenció abans de poder iniciar-se.',
            home_auth_invalid: 'L’autenticació del teu Home necessita atenció.',
            existing_runtime: 'Has de decidir què fer amb el Home local existent abans de continuar la configuració.',
            existing_runtime_credentials: 'Aquest Home local pertany a una altra app de Happier en aquest ordinador.',
            personal_home_erased: 'El teu Home personal s’ha esborrat. Torna-ho a provar per crear-ne un de nou.',
        },
        blockedBody: { personal_home_erased: 'Les dades del teu Home s’han suprimit. Aquí no queda res per recuperar: crea un Home personal nou o utilitza un altre Home.' },
    } } as const satisfies Pick<Record<string, PersonalHomeBootstrapBlockedTranslation>, "ca">;

return { personalHomeBootstrapBlockedTranslations };
})();

const Domain_personalHomeDecisionTranslations = (() => {
type HomeParams = Shared_personalHomeDecisionTranslations.HomeParams;

type PersonalHomeDecisionTranslation = Shared_personalHomeDecisionTranslations.PersonalHomeDecisionTranslation;

const en = Shared_personalHomeDecisionTranslations.en;

const ca: PersonalHomeDecisionTranslation = {
    homeIdentityAmbiguous: 'Aquesta adreça del Home personal correspon a més d’un Home desat.',
    signedInHome: {
        status: 'Ja tens la sessió iniciada en un altre Home.',
        body: ({ home }: HomeParams) => `Aquest ordinador té la sessió iniciada a ${home}. Continua fent-lo servir o configura-hi un Home personal.`,
        keep: ({ home }: HomeParams) => `Continua amb ${home}`,
        keepDetail: 'Les teves sessions i màquines es queden exactament com estan.',
        create: 'Configura un Home personal',
        createDetail: 'Crea un Home privat en aquest ordinador i canvia-hi.',
    },
    existingRuntimeCredentials: {
        body: 'Aquesta app no el pot obrir sense la clau de recuperació d’aquest Home. Inicia la sessió amb la clau o utilitza un altre Home.',
        signIn: 'Inicia la sessió amb una clau de recuperació',
        signInDetail: 'Utilitza la clau de recuperació desada per a aquest Home local.',
    },
};

const personalHomeDecisionTranslations = { ca };

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

const ca = {
    standardOnlyTitle: 'Només connexió estàndard',
    standardOnlySubtitle: 'Les connexions noves en aquest dispositiu fan servir rutes estàndard. Les transferències en curs mantenen la ruta actual.',
    installOrUpdateAction: 'Instal·la o actualitza el Home personal', startAction: 'Inicia el Home personal', stopAction: 'Atura el Home personal',
    defaultHomeLabel: 'Home personal', homeTitle: 'Home', canonicalAddress: 'Adreça del Home', identityComparison: 'Home actual', identityComparisonMatch: 'Coincideix', identityComparisonMismatch: 'No coincideix', identityComparisonUnknown: 'No s’ha pogut confirmar',
    unknownSize: 'Mida desconeguda', unknownTimestamp: 'Marca de temps desconeguda', restoreBackupTitle: 'Còpia de seguretat', identityTitle: 'Identitat del Home', identityUnavailable: 'Identitat no disponible', restoreBackupDate: 'Creat', restoreCompatibility: 'Compatibilitat', restoreCompatible: 'Compatible', restoreCompatibilityVerified: 'Verificat per aquesta versió', restoreBackupSize: 'Mida', restoreReplacementNotice: 'Les dades actuals del Home se substituiran. Es conservarà una còpia de recuperació verificada.', restoreConfirmTitle: 'Vols substituir i restaurar aquest Home personal?', restoreConfirmAction: 'Substitueix i restaura', relocateConfirmTitle: 'Vols moure aquest Home personal?', relocateConfirmBody: 'El Home actual s’aturarà abans que la còpia verificada s’activi a la destinació.', relocateDestination: 'Destinació', relocateConfirmAction: 'Mou el Home', recoverRestoreTitle: 'Vols recuperar la restauració interrompuda?', recoverRestoreBody: 'Reverteix la restauració interrompuda amb el material de recuperació conservat.', recoverRestoreAction: 'Recupera la restauració', eraseDataTitle: 'Vols eliminar les dades del Home personal?', eraseHomeTarget: 'Home', eraseDataBody: 'Això és independent de la desinstal·lació i elimina definitivament només aquests camins resolts del Home:', estimatedSize: 'Mida estimada', summaryTitle: 'Home personal', footer: 'El teu Home es manté en aquest ordinador. Aquestes accions no canvien cap altre Home.', statusTitle: 'Estat', notAvailable: 'No disponible', storageTitle: 'Emmagatzematge', masterSecretTitle: 'Secret d’accés del Home', masterSecretPresent: 'Present', masterSecretUnavailable: 'No disponible', inspectAction: 'Actualitza els detalls del Home', actionsTitle: 'Còpia i restauració', protectionTitle: 'Protecció', backupsSectionFooter: 'Les còpies contenen converses llegibles, dades del Home, l’estat dels dispositius de confiança i el secret d’accés del Home. Desa-les només en una ubicació de confiança.', lastBackupTitle: 'Última còpia', lastBackupUnknown: 'Última còpia desconeguda', backupsTitle: 'Arxius de còpia', backupAction: 'Fes una còpia ara', backupSubtitle: 'Crea i verifica un arxiu Home en text pla.', exportBackupAction: 'Exporta la còpia…', exportBackupSubtitle: 'Crea una còpia verificada en una ubicació que triïs.', verifyAction: 'Verifica la còpia…', verifySubtitle: 'Comprova un arxiu sense restaurar-lo.', restoreAction: 'Restaura…', restoreSubtitle: 'Valida una còpia abans de substituir les dades del Home.', relocateAction: 'Mou el Home…', relocateSubtitle: 'Mou aquest Home a un ordinador gestionat.', relocationFinishAction: 'Acaba el trasllat', relocationReturnAction: 'Torna al Home original', relocationFinishSubtitle: 'Acaba de moure aquest Home després de verificar la destinació.', relocationReturnSubtitle: 'Mantén el Home original com a ubicació activa.', recoverRestoreSubtitle: 'Una restauració interrompuda es pot revertir explícitament.', restoreRecoveryWarningTitle: 'La restauració necessita reparació', restoreRecoveryWarningBody: 'L’estat de recuperació és ambigu. No es farà cap canvi automàtic. Revisa el diagnòstic abans de reparar aquest Home.', restoreCleanupWarningTitle: 'La neteja de la restauració requereix atenció', restoreCleanupWarningBody: 'El Home s’ha restaurat, però la neteja automàtica no ha acabat. Revisa els diagnòstics i torna a provar l’operació del Home.', backupVerified: 'Còpia verificada', backupNeedsAttention: 'Còpia verificada; el reinici del Home requereix atenció', backupHomeReady: 'Home reiniciat', backupRevealAction: 'Mostra la còpia', restoreResultTitle: 'Resultat de la restauració', restoreOutcomeRecoveryRequired: 'Cal recuperar', restoreOutcomeRolledBack: 'Restauració revertida', restoreOutcomeRestored: 'Home restaurat', advancedTitle: 'Avançat', advancedFooter: 'Controls del runtime i diagnòstic d’aquest ordinador.', restartAction: 'Reinicia el Home personal', openDataLocationAction: 'Obre la ubicació de dades del Home', openLogsAction: 'Obre els registres del runtime', removeProfileAction: 'Treu el Home de Happier', removeProfileSubtitle: 'Treu aquest perfil; les dades del runtime es mantenen en aquest ordinador.', removeProfileTitle: 'Vols treure el perfil del Home personal?', removeProfileBody: 'Això treu el perfil, però conserva el runtime i les dades.', uninstallRuntimeAction: 'Desinstal·la el runtime i conserva les dades', uninstallRuntimeSubtitle: 'Treu el servei i els binaris; les dades del Home es conserven.', deleteHomeDataTitle: 'Elimina les dades del Home', removeSectionFooter: 'La desinstal·lació conserva les dades del Home. L’eliminació permanent és una acció confirmada separada.', eraseDataAction: 'Elimina definitivament les dades del Home personal', eraseDataSubtitle: 'Separada de la desinstal·lació. Elimina definitivament les dades resoltes del Home.', eraseResultTitle: 'Dades del Home eliminades', eraseStoppedHome: 'El Home en execució s’ha aturat', eraseHomeAlreadyStopped: 'El Home ja estava aturat', eraseRemainingPaths: 'No s’ha pogut eliminar', progressTitle: 'Operació del Home personal', dismissResult: 'Descarta',
    repairSearchAction: 'Reconstrueix la cerca del Home',
    repairSearchSubtitle: 'Recrea l’índex de cerca a partir de les converses d’aquest Home.',
    repairSearchCompleteTitle: 'Cerca del Home reconstruïda',
    repairSearchCompleteBody: 'L’índex de cerca s’ha recreat a partir de les converses d’aquest Home.',
    backupCleanupRequired: 'La còpia és segura; elimina el camí de preparació protegit que es mostra als detalls',
    backupCleanupPath: 'Camí de preparació protegit per eliminar',
    backupCleanupError: 'Error de neteja',
    backupDestinationMismatch: 'La còpia no s’ha creat a la destinació seleccionada. No s’ha eliminat res.',
    backupDestinationUnsafe: 'La destinació de còpia seleccionada és dins de les dades del Home personal que s’eliminarien. No s’ha eliminat res.',
    eraseInspectionAttention: 'Dades del Home eliminades; la verificació necessita atenció',
    searchTitle: 'Cerca',
    searchReady: 'A punt',
    searchIndexing: 'S’està indexant…',
    searchUnavailable: 'No disponible',
    localOnlyIngressTitle: 'Accessible només des d’aquest ordinador',
    localOnlyIngressBody: 'Els recursos compartits públics, les crides de retorn de proveïdors, els webhooks de connectors i les notificacions mentre aquest ordinador dorm no estaran disponibles fins que aquest Home sigui accessible des de fora.',
} satisfies PersonalHomeSettingsCopy;

const backupDisclosureBody = { ca: 'Aquesta còpia conté converses llegibles, dades del Home, el secret d’accés del Home i l’estat dels dispositius de confiança. Qualsevol persona que pugui restaurar l’arxiu complet pot operar un clon d’aquest Home. Desa-la en una ubicació de confiança.' } as const;

const eraseBackupOffer = { ca: { title: 'Vols fer primer una còpia d’aquest Home?', body: 'La supressió de les dades del Home no es pot desfer. Crea primer una còpia verificada o continua sense còpia.', continueWithoutBackup: 'Continua sense còpia' } } as const;

const operationOutcome = { ca: {
        erasePartialTitle: 'No s’han pogut suprimir algunes dades del Home',
        eraseOutcomeSummary: ({ removed, remaining }) => `${removed === 1 ? 'S’ha' : 'S’han'} suprimit ${removed} ${removed === 1 ? 'element' : 'elements'}`
            + (remaining > 0 ? `; ${remaining} no ${remaining === 1 ? 's’ha' : 's’han'} pogut suprimir` : ''),
        eraseNotPerformed: 'No s’ha suprimit res',
        eraseBlockedBackupMismatch: 'Aquesta còpia és d’un altre Home.',
        eraseBlockedIdentityUnknown: 'Happier no ha pogut confirmar que aquesta còpia correspon a aquest Home.',
        eraseVerificationDetail: 'Verificació',
        operationFailed: 'Aquesta operació del Home no s’ha acabat. Obre Detalls per veure què ha passat.',
        restorePreviousDataTitle: 'Dades anteriors desades',
    } } as const satisfies Pick<Record<string, OperationOutcomeCopy>, "ca">;

const personalHomeSettingsTranslations = { ca: { ...ca, ...operationOutcome.ca, backupDisclosureBody: backupDisclosureBody.ca, eraseBackupOfferTitle: eraseBackupOffer.ca.title, eraseBackupOfferBody: eraseBackupOffer.ca.body, eraseContinueWithoutBackup: eraseBackupOffer.ca.continueWithoutBackup } } as const;

return { backupDisclosureBody, eraseBackupOffer, operationOutcome, personalHomeSettingsTranslations };
})();

const Domain_personalizeTranslations = (() => {
type PersonalizeTranslation = Shared_personalizeTranslations.PersonalizeTranslation;

const en = Shared_personalizeTranslations.en;

const pluralPl = Shared_personalizeTranslations.pluralPl;

const pluralRu = Shared_personalizeTranslations.pluralRu;

const ca: PersonalizeTranslation = {
    cardTitle: 'Personalitza Happier',
    cardSubtitle: 'Sis tries ràpides, cadascuna amb vista prèvia en directe.',
    cardAction: 'Personalitza',
    cardContinue: 'Continua',
    cardProgress: ({ saved, total, step }) => `${saved} de ${total} tries desades. Reprèn-ho a ${step}.`,
    cardProgressReview: ({ saved, total }) => `${saved} de ${total} tries desades. Revisa la teva configuració.`,
    inPlaceTitle: 'Fes que Happier sigui teu',
    inPlaceBody: 'Sis tries ràpides, cadascuna amb vista prèvia en directe. Comença per l’aspecte: Home canvia mentre tries.',
    inPlaceContinue: ({ count }) => `Continua · ${count} més`,
    notNow: 'Ara no',
    flowTitle: 'Personalitza Happier',
    finishLater: 'Acaba més tard',
    later: 'Més tard',
    stepEyebrow: ({ n, total, name }) => `Pas ${n} de ${total} · ${name}`,
    stepCounter: ({ n, total }) => `${n} de ${total}`,
    styleEyebrow: 'Opcional',
    summaryEyebrow: 'Tot a punt',
    previewNote: 'Vista prèvia. No es desa res fins que premis Següent.',
    previewNoteSummary: 'El teu espai de treball, tal com és ara.',
    next: 'Següent',
    review: 'Revisa',
    useThisSetup: 'Fes servir aquesta configuració',
    saveFailed: 'Aquest pas no s’ha desat. La teva tria continua seleccionada.',
    tryAgain: 'Torna-ho a provar',
    skipThisStep: 'Omet aquest pas',
    scopeThisDevice: 'Aquest dispositiu',
    scopeAllDevices: 'Tots els teus dispositius',
    stepsLabel: 'Passos',
    savedStepsNote: ({ count }) => count === 1 ? 'Ja hi ha 1 pas desat.' : `Ja hi ha ${count} passos desats.`,
    lookName: 'Aspecte',
    lookTitle: 'Fes-la còmoda',
    lookDescription: 'Clar, fosc o el que faci servir el sistema, i quant vidre mostra l’app.',
    themeLabel: 'Tema',
    glassLabel: 'Vidre',
    glassAutoDescription: 'Vidre per tota l’app, en capes',
    glassEverywhereDescription: 'Un mateix vidre a tot arreu',
    glassSolidDescription: 'Totes les superfícies opaques',
    glassCustomNote: 'Has ajustat el vidre a Aparença. Tria un predefinit per substituir-lo o conserva el teu.',
    customizeInAppearance: 'Personalitza a Aparença…',
    styleName: 'Estil',
    styleTitle: 'Comença amb un estil',
    styleDescription: 'Cada estil defineix com es llegeixen les sessions i com es veu la llista. Només omple els passos següents: no es desa res fins que premis Següent a cadascun.',
    styleKeep: 'Mantén la meva configuració actual',
    styleActivity: 'Activitat',
    styleConversation: 'Conversa',
    styleDetail: 'Detall',
    styleCustomTag: 'Personalitzat',
    styleDefaultTag: 'Predeterminat de Happier',
    styleChanges: ({ style, count }) => count === 1 ? `${style} canvia 1 cosa` : `${style} canvia ${count} coses`,
    styleNoChanges: 'Aquesta ja és la teva configuració.',
    styleNever: 'El tema, les notificacions, la privadesa i els permisos dels agents mai formen part d’un estil.',
    was: ({ value }) => `abans: ${value}`,
    conversationName: 'Conversa',
    conversationTitle: 'Segueix la conversa',
    conversationDescription: 'Com es llegeixen els torns d’una sessió i el pensament de l’agent.',
    layoutLabel: 'Disposició',
    thinkingLabel: 'Pensament',
    toolsName: 'Crides d’eines',
    toolsTitle: 'Mira què ha fet l’agent',
    toolsDescription: 'Com apareixen les ordres, les edicions i les lectures en una sessió.',
    toolsLabel: 'Crides d’eines',
    toolTapLabel: 'En fer clic en una eina',
    toolDetailLabel: 'Detall de les eines',
    toolDetailDefault: 'Predeterminat',
    toolDetailFull: 'Complet',
    workName: 'La teva feina',
    workTitle: 'Troba la teva feina',
    workDescription: 'Com s’organitza la llista de sessions i quanta informació mostra cada fila.',
    listLayoutLabel: 'Llista de sessions',
    rowsLabel: 'Files',
    attentionName: 'Atenció',
    attentionTitle: 'Detecta el que et necessita',
    attentionDescription: 'On se situen a la llista les sessions que t’esperen o que estan llestes per revisar.',
    attentionLabel: 'Sessions que et necessiten',
    attentionHomeNote: 'Home sempre mostra el que et necessita. Això només canvia la llista de sessions.',
    notificationsName: 'Notificacions',
    notificationsTitle: 'Estigues al dia',
    notificationsDescription: 'Què t’avisa aquest dispositiu quan estàs mirant una altra cosa.',
    notificationsAllowed: 'Les notificacions estan permeses en aquest dispositiu.',
    notificationsNotAllowed: 'Happier encara no pot mostrar notificacions en aquest dispositiu.',
    notificationsUnsupported: 'Les notificacions no estan disponibles en aquest dispositiu. Configura-les a l’aplicació d’escriptori o al telèfon.',
    scopeLook: 'Tema en aquest dispositiu · vidre en tots els dispositius',
    notificationsNeedsYouSummary: 'Et necessita',
    notificationsFinishedSummary: 'Finalitzat',
    notificationsAllow: 'Permet les notificacions',
    notificationsTellMe: 'Avisa’m quan',
    notificationsNeedsYou: 'Una sessió necessita una aprovació o una resposta',
    notificationsFinished: 'Una sessió acaba el seu torn',
    notificationsShowLabel: 'Les notificacions mostren',
    notificationsShowDescription: 'Les ordres, preguntes i respostes poden aparèixer a la pantalla de bloqueig.',
    notificationsMessage: 'El missatge',
    notificationsStatus: 'Només l’estat',
    notificationsPhoneNote: 'Els avisos al telèfon mentre Happier està tancat es configuren al telèfon.',
    notificationsOff: 'Sense notificacions',
    sampleNeedsYouTitle: 'Revisió #2481 et necessita',
    sampleNeedsYouBody: 'L’agent vol executar yarn test:e2e a ~/happier. Ho permets?',
    sampleReadyTitle: '«Corregir el test de reconnexió inestable» està llest',
    sampleReadyBody: 'Trobat: el temporitzador de reintents no es netejava mai. Ja està corregit i el test passa.',
    sampleStatusBody: 'Obre Happier per veure-ho.',
    sampleSessionReconnect: 'Corregir el test de reconnexió inestable',
    sampleSessionCraft: 'Laboratori de polit',
    sampleSessionReview: 'Revisió #2481',
    sampleSessionPricing: 'Textos de la pàgina de preus',
    sampleSessionDocs: 'Índex de cerca de la documentació',
    sampleWorking: 'Treballant',
    sampleNeedsYou: 'Et necessita',
    sampleReady: 'Llest per revisar',
    summaryTitle: 'Aquesta és la teva configuració',
    summaryDescription: ({ changed }) => changed === 0
        ? 'Tot el que hi ha a sota ja està desat. No ha canviat res.'
        : changed === 1
            ? 'Tot el que hi ha a sota ja està desat. Ha canviat una tria; la resta s’ha quedat igual.'
            : `Tot el que hi ha a sota ja està desat. Han canviat ${changed} tries; la resta s’ha quedat igual.`,
    summaryChange: 'Canvia',
    summaryFooter: 'Pots canviar tot això més tard a Configuració, o tornar-ho a recórrer des de Configuració → Aparença.',
    replayTitle: 'Personalitza Happier',
    replaySubtitle: 'Sis tries ràpides, cadascuna amb vista prèvia en directe.',
    replayAction: 'Comença',
    journeyHandoff: 'Fes-lo teu',
};

const personalizeTranslations = { ca } satisfies Pick<Readonly<Record<string, PersonalizeTranslation>>, "ca">;

return { personalizeTranslations };
})();

const Domain_phoneNavigationTranslations = (() => {
const en = Shared_phoneNavigationTranslations.en;

const ca: typeof en = {
    phoneNav: {
        settings: {
            sectionDescription: 'El disseny de telèfon dins de les sessions i els gestos de la barra. Cada gest es pot desactivar per separat.',
            swipeSidewaysTitle: 'Llisca cap als costats per canviar de sessió',
            swipeSidewaysScrollsDescription: 'Anterior o següent, a la barra. Quan les teves eines no hi caben, lliscar les desplaça.',
            swipeSidewaysAlwaysDescription: 'Anterior o següent, a la barra. Continua sent un lliscament; les eines que no hi caben esperen a Més.',
            alwaysSwipeTitle: 'Llisca sempre entre sessions',
            alwaysSwipeOnDescription: 'La barra manté les eines que hi caben; la resta espera a Més.',
            alwaysSwipeOffDescription: 'Desactivat: les eines extra fan que la barra es desplaci.',
            dragUpTitle: 'Arrossega cap amunt per canviar',
            dragUpDescription: 'Arrossega la barra cap amunt per veure les pestanyes obertes i les sessions recents, i llisca fins a una.',
            dragUpSourceTitle: 'Arrossegar cap amunt mostra',
            dragUpSourceRecentDescription: 'Pestanyes obertes i després el que has obert recentment en aquest dispositiu.',
            dragUpSourceListDescription: 'Sessions en l’ordre de la llista.',
            swipeSourceTitle: 'Lliscar cap als costats mostra',
            swipeSourceListDescription: 'La sessió següent o anterior de la teva llista.',
            swipeSourceRecentDescription: 'La següent o l’anterior segons quan la vas obrir per última vegada.',
            sourceRecent: 'Recents',
            sourceList: 'Llista de sessions',
            flickTitle: 'Fes un cop ràpid amunt o avall per canviar',
            flickDescription: 'Un cop ràpid obre la següent o l’anterior.',
            holdToDockTitle: 'Mantén premut per deixar obert el selector',
            holdToDockDescription: 'Mantén la barra i deixa anar per triar amb un toc.',
            pullAllTabsTitle: 'Baixa el títol per veure totes les pestanyes',
            pullAllTabsDescription: 'Arrossega el títol de la sessió cap avall per veure totes les pestanyes obertes i les sessions recents.',
        },
        bar: {
            onTheBar: 'A la barra',
            more: 'Més',
            heldInMore: 'A Més mentre “Llisca sempre” està activat',
            keepOnBar: 'Mantén a la barra',
            removeFromBar: 'Treu de la barra',
            openFiles: 'Obre fitxers',
        },
        allTabs: {
            title: 'Totes les pestanyes',
            pullHint: 'Estira per veure totes les pestanyes',
            releaseHint: 'Deixa anar per veure totes les pestanyes',
            openTabs: 'Pestanyes obertes',
            openTabsSynced: 'Pestanyes obertes · sincronitzades',
            recent: 'Recents',
            recentOnThisDevice: 'Recents en aquest telèfon',
            here: 'Aquí',
            panes: ({ count }: { count: number }) => `${count} panells`,
            emptyTitle: 'No hi ha res més obert',
            emptyDescription: 'Les sessions que obres i les pestanyes que mantens apareixen aquí, les més recents primer.',
            openTab: ({ title }: { title: string }) => `Obre ${title}`,
        },
        rail: {
            label: 'Pestanyes obertes',
            synced: 'Sincronitzades',
            syncedA11y: 'Les pestanyes obertes se sincronitzen entre els teus dispositius',
            notAvailableTitle: 'No disponible en aquest telèfon',
            notAvailableUnknown: 'Aquesta pestanya es va obrir en un altre dispositiu i aquest telèfon no la pot mostrar. Hi continua oberta.',
            closeTab: 'Tanca la pestanya',
            paneOf: ({ position, total }: { position: number; total: number }) => `${position} de ${total}`,
            nextPane: 'Panell següent',
            chatPane: 'Chat',
        },
        switcher: {
            title: 'Canvia a',
            allSessions: 'Totes les sessions',
            openTabs: 'Pestanyes obertes',
            synced: 'sincronitzades',
            recent: 'Recents',
            recentOnThisDevice: 'Recents en aquest telèfon',
            sessions: 'Sessions',
            nextInSessions: 'Següent a Sessions',
            previousInSessions: 'Anterior a Sessions',
            furtherBack: 'Més enrere',
            moreRecent: 'Més recent',
            here: 'Aquí',
            stayOn: 'Queda’t a',
            noOlderSessions: 'No hi ha sessions més antigues',
            noNewerSessions: 'No hi ha sessions més recents',
            lastInSessions: 'Aquesta és l’última de Sessions.',
            firstInSessions: 'Aquesta és la primera de Sessions.',
            nothingFurtherBack: 'No hi ha res més enrere.',
            mostRecent: 'Aquesta és la més recent.',
            nothingToSwitch: 'No hi ha res més obert',
            nothingToSwitchDescription: 'Les sessions que obres apareixen aquí, les més recents primer.',
            draft: ({ text }: { text: string }) => `El teu esborrany: “${text}”`,
            switchSessionAction: 'Canvia de sessió',
            switchedTo: ({ name }: { name: string }) => `Has canviat a ${name}`,
            close: 'Tanca',
            positionOf: ({ position, total }: { position: number; total: number }) => `${position} de ${total}`,
        },
    },
};

const phoneNavigationTranslations = { ca };

return { phoneNavigationTranslations };
})();

const Domain_pluginAccountDataEraseTranslations = (() => {
const english = Shared_pluginAccountDataEraseTranslations.english;

const pluginAccountDataEraseTranslations = { ca: {
    accountDataErase: {
        installedGroupTitle: 'Dades del compte',
        installedGroupFooter: 'Això només afecta les dades conservades per al compte actual. No desinstal·la aquest connector de cap màquina.',
        installedEntryTitle: 'Esborra les dades del compte',
        installedEntrySubtitle: 'Elimineu permanentment les dades conservades d\'aquest connector del compte actual.',
        orphanedGroupTitle: 'Dades del connector conservades',
        orphanedGroupFooter: 'Utilitzeu un ID de connector per eliminar les dades del compte conservades després d\'haver eliminat un connector.',
        orphanedEntryTitle: 'Esborra les dades del connector retinguts',
        orphanedEntrySubtitle: 'Introduïu un ID de connector instal·lat o eliminat per esborrar permanentment les dades del seu compte actual.',
        promptTitle: 'ID del connector',
        promptBody: 'Introduïu l\'identificador del connector les dades conservades del qual voleu esborrar del compte actual.',
        promptPlaceholder: 'com.example.plugin',
        invalidTitle: 'Introduïu un ID de connector',
        invalidBody: 'Feu servir l\'identificador exacte del connector abans de continuar.',
        confirmTitle: 'Vols esborrar les dades del connector del compte?',
        confirmBody: ({ pluginId }: { pluginId: string }) => `D'aquesta manera s'eliminen permanentment les dades conservades per a ${pluginId} del compte corrent. No desinstal·la el connector de les vostres màquines.`,
        confirm: 'Esborra les dades',
        completedTitle: 'S\'han esborrat les dades del connector del compte',
        completedChanged: 'Les dades del connector retinguts s\'han eliminat del compte actual.',
        completedEmpty: 'No s\'han trobat dades del connector retinguts per a aquest connector al compte actual.',
        partialTitle: 'Queden algunes dades del connector',
        partialBody: 'Algunes dades conservades no s\'han pogut esborrar. Res no tornarà a intentar automàticament; torna a intentar esborrar les dades restants.',
        failedTitle: 'Les dades del connector no s\'han esborrat',
        failedBody: 'Les dades conservades no s\'han pogut esborrar. Torneu-ho a provar després de comprovar la connexió actual del compte.',
        unavailableTitle: 'Les dades del connector no estan disponibles',
        unavailableBody: 'El compte actual ha canviat o no està disponible. Torneu a obrir aquesta acció quan el compte estigui a punt.',
    },
} } as const;

return { pluginAccountDataEraseTranslations };
})();

const Domain_pluginAccountReleaseSelectionTranslations = (() => {
const english = Shared_pluginAccountReleaseSelectionTranslations.english;

const completeReleaseSelection = Shared_pluginAccountReleaseSelectionTranslations.completeReleaseSelection;

const localizedPluginAccountReleaseSelectionTranslations = { ca: {
    accountReleaseSelection: {
        groupTitle: 'Alliberament del compte',
        groupFooter: 'Seleccioneu una versió exacta per a aquest compte. Això no instal·la, actualitza ni confia en el connector a cap màquina.',
        entryTitle: 'Utilitzeu-lo per a aquest compte',
        entrySubtitle: ({ version }: { version: string }) => `Seleccioneu la versió ${version} per al compte corrent sense canviar cap instal·lació de la màquina.`,
        selectedTitle: 'Alliberament del compte seleccionat',
        selectedBody: 'La versió del connector seleccionada s\'utilitzarà ara per a aquest compte.',
        conflictTitle: 'L\'alliberament del compte ha canviat',
        conflictBody: 'La versió del compte ha canviat mentre aquesta acció estava oberta. Torneu-lo a obrir i torneu-ho a provar.',
        unavailableTitle: 'Alliberament del compte no disponible',
        unavailableBody: 'La versió exacta o la seva font de migració necessària no estan disponibles per al compte actual. Torna-ho a provar quan el compte estigui llest.',
        rejectedTitle: 'No s\'ha seleccionat l\'alliberament del compte',
        rejectedBody: 'El compte no va acceptar aquesta selecció de llançament. Comproveu l\'estat del compte i torneu-ho a provar.',
        hostedGroupFooter: 'Gestioneu els artefactes del connector que aquest compte allotja per al connector. Cap màquina no ofereix ara aquesta versió, així que no es pot seleccionar aquí.',
        hostedEnableTitle: 'Allotja els artefactes del connector per a aquest compte',
        hostedEnableBody: "Desa la interfície i els recursos del paquet al servidor del compte. En comptes sense xifratge, el servidor pot llegir les dades; amb E2EE, emmagatzema dades xifrades. Les metadades de versió continuen visibles. Això no instal·la el connector, no hi atorga confiança ni permet executar-lo en una màquina desconnectada.",
        hostedDisableTitle: 'Deixa d\'allotjar els artefactes del connector',
        hostedStatusDisabled: "Desactivat. Activeu l’allotjament per descarregar els artefactes d’aquesta versió quan la màquina d’origen estigui desconnectada.",
        hostedStatusPending: 'Activat. Aquesta versió espera que l\'amfitrió publiqui els artefactes exactes del connector.',
        hostedStatusReady: 'Els artefactes del connector allotjats estan disponibles per a aquesta versió exacta.',
        hostedRemoveTitle: 'Desactiva l\'allotjament i elimina els artefactes',
        hostedRemoveBody: 'Atura l\'allotjament del compte i elimina els artefactes del connector allotjats d\'aquesta versió. La neteja de la memòria cau local és a part.',
        hostedClearCacheTitle: 'Buida la memòria cau local d\'artefactes',
        hostedClearCacheBody: 'Elimina els bytes d\'artefactes d\'interfície desats localment per a aquesta versió exacta sense canviar l\'allotjament del compte.',
    },
} } as const;

const pluginAccountReleaseSelectionTranslations = { ca: completeReleaseSelection(localizedPluginAccountReleaseSelectionTranslations.ca) };

return { localizedPluginAccountReleaseSelectionTranslations, pluginAccountReleaseSelectionTranslations };
})();

const Domain_pluginInvocationLogTranslations = (() => {
const en = Shared_pluginInvocationLogTranslations.en;

const ca = {
    invocationLogs: {
        title: 'Registres d’invocacions',
        footer: 'Registres limitats i redactats de la màquina de connector seleccionada.',
        correlationFilter: 'Filtre d’ID de correlació',
        correlationFilterAll: 'Totes les invocacions d’aquest connector',
        correlationPromptTitle: 'Filtra per ID de correlació',
        correlationPromptBody: 'Mostra només els registres d’una invocació exacta del connector. Deixa-ho buit per mostrar tots els registres.',
        correlationPromptPlaceholder: 'ID de correlació',
        refresh: 'Actualitza els registres',
        follow: 'Segueix els registres',
        stopFollowing: 'Atura el seguiment',
        loadMore: 'Carrega els registres següents',
        loadingTitle: 'S’estan carregant els registres d’invocacions',
        loadingSubtitle: 'S’estan llegint registres limitats i redactats de la màquina seleccionada.',
        idleTitle: 'Els registres d’invocacions estan a punt per llegir-se',
        idleSubtitle: 'Actualitza per llegir registres limitats i redactats de la màquina seleccionada.',
        emptyTitle: 'No hi ha registres d’invocacions',
        emptySubtitle: 'No hi ha registres redactats coincidents en aquesta màquina seleccionada.',
        unavailableTitle: 'Els registres d’invocacions no estan disponibles',
        unavailableSubtitle: 'La màquina de connector seleccionada no està disponible o ja no és actual.',
        readerUnavailableSubtitle: 'La màquina de connector seleccionada no pot proporcionar registres d’invocacions ara mateix.',
        selectionRequiredTitle: 'Selecciona una màquina de connector',
        selectionRequiredSubtitle: 'Tria més amunt una materialització compatible del connector abans de llegir-ne els registres.',
        conflictTitle: 'Resol la màquina de connector seleccionada',
        conflictSubtitle: 'Tria més amunt una materialització compatible del connector abans de llegir-ne els registres.',
        errorTitle: 'No s’han pogut carregar els registres d’invocacions',
        errorSubtitle: 'La lectura dels registres no s’ha completat. Torna-ho a provar quan la màquina seleccionada estigui disponible.',
        noMessage: 'Esdeveniment de registre del connector',
        level: {
            debug: 'Depuració',
            info: 'Informació',
            warn: 'Avís',
            error: 'Error detectat',
            diagnostic: 'Diagnòstic',
        },
    },
};

const pluginInvocationLogTranslations = { ca } as const;

return { pluginInvocationLogTranslations };
})();

const Domain_pluginMachineMatrixTranslations = (() => {
const english = Shared_pluginMachineMatrixTranslations.english;

const pluginMachineMatrixTranslations = { ca: {
        machineMatrix: {
            title: 'A les teves màquines',
            footer: 'Només lectura. Instal·lar, actualitzar i la resta d’accions del connector s’executen a la màquina seleccionada a dalt.',
            empty: 'Cap màquina no ha informat encara d’una instal·lació de connectors per a aquest compte.',
            unavailable: 'La disponibilitat de connectors del compte encara no s’ha carregat, així que els estats de les màquines són desconeguts.',
            incomplete: ({ count }: { count: number }) => `Aquesta llista pot ser incompleta: ${count} servidor(s) encara no han informat de les seves màquines.`,
            summary: ({ installed, total }: { installed: number; total: number }) => `Instal·lat i actualitzat a ${installed} de ${total} màquines`,
            lastObserved: ({ ago }: { ago: string }) => `vist per última vegada: ${ago}`,
            state: {
                installedCurrent: 'Instal·lat i actualitzat',
                disabled: 'Desactivat',
                untrusted: 'Sense confiança',
                incompatible: 'Versió diferent',
                localOnly: 'Local a aquesta màquina',
                staleOffline: 'Últim estat conegut, màquina fora de línia',
                absent: 'No instal·lat',
                unknown: 'Desconegut',
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

const marketplacePresentation = { ca: {
        diagnosticsIssueTitle: 'Problema del connector', diagnosticsRecovery: 'Revisa els detalls anteriors i, després de corregir-ho, torna a carregar el connector o aquesta pàgina.', diagnosticsTechnicalCode: ({ code }: { code: string }) => `Codi tècnic: ${code}`,
        discover: { publisherLabel: ({ displayName, id }: { displayName: string; id: string }) => `Etiqueta de l’editor: ${displayName} (${id})`, categories: ({ values }: { values: string }) => `Categories: ${values}`, runtimeSummary: ({ realms, platforms }: { realms: string; platforms: string }) => `S’executa a: ${realms} · Plataformes: ${platforms}`, reviewStatus: { curated: 'Recomanació seleccionada', unreviewed: 'Sense revisar', withdrawn: 'Retirat' }, executableRealm: { daemon: 'servei en segon pla', client: 'aplicació', hostedWeb: 'web allotjat' }, platform: { darwin: 'macOS', linux: 'Linux', windows: 'Windows', web: 'Web', ios: 'iOS', android: 'Android' }, diagnostic: { title: 'Problema amb una font del mercat', recovery: 'Actualitza Descobreix. Si continua, revisa Fonts i registres.', unreachableTitle: ({ source }: { source: string }) => `No s’ha pogut contactar amb ${source}`, behindTitle: ({ source }: { source: string }) => `${source} ha respost amb dades antigues o incompletes`, indexTitle: 'L’índex de connectors és incomplet', otherSourcesShown: 'Els resultats de les altres fonts es continuen mostrant.' } },
    } } as const;

const localizedTechnicalReviewVocabulary = { ca: { source: ({ kind, locator }: { kind: string; locator: string }) => `${kind}: ${locator}`, sourceKind: { path: 'Camí local', archive: 'Fitxer d’arxiu', npm: 'Paquet npm' }, marketplaceSource: ({ kind, source }: { kind: string; source: string }) => `${kind}: ${source}`, marketplaceSourceKind: { curated: 'Catàleg seleccionat', 'community-npm': 'Catàleg npm públic', user: 'Catàleg personal' }, executableRealm: { daemon: 'Codi del servei en segon pla', reactNative: 'Codi de la interfície de l’aplicació', hostedWeb: 'Codi web allotjat aïllat' }, uiArtifacts: ({ status, ids }: { status: string; ids: string }) => `${status}: ${ids}`, uiArtifactStatus: { verified: 'Recursos d’interfície verificats', none: 'Sense recursos d’interfície', unavailable: 'Recursos d’interfície no disponibles' }, authorizationClass: { cooperativeDisclosure: 'Divulgació cooperativa', hostResourceSelection: 'Recursos del sistema seleccionats', presentIntentOrOs: 'Intenció actual o permís del sistema' }, priority: ({ priority }: { priority: number }) => `Prioritat ${priority}` } } as const;

const localizedReviewVocabulary = { ca: {
        installReviewSections: {
            ...localizedTechnicalReviewVocabulary.ca,
            archiveUrlRetention: 'Happier desa l’URL complet de l’arxiu a la màquina seleccionada, incloses les credencials que contingui, per a futures actualitzacions. Els URL caducats o revocats poden fer que les actualitzacions fallin.',
            trustedCodeTitle: 'Codi de confiança', trustedCodeDisclosure: 'Els plugins s’executen com a codi de confiança dins de Happier, no en un entorn aïllat. Un plugin pot fer servir directament els permisos d’aquesta aplicació —fitxers, xarxa, entorn i processos— més enllà dels serveis intermediats per Happier que es mostren a sota. Aquesta llista és el que el plugin ha declarat i el que podràs desactivar més endavant, no un límit del que el seu codi pot arribar a fer.', identity: 'Identitat i paquet', evidence: 'Detalls tècnics', executableCode: 'Codi executable i contribucions', requiredAccess: 'Accés obligatori al sistema', optionalAccess: 'Accés opcional al sistema', requestInterceptors: 'Interceptors de sol·licituds', rawCredentials: 'Declaracions d’accés directe a credencials', compatibility: 'Compatibilitat i actualitzacions', none: 'No s’ha declarat res', scope: ({ scope }: { scope: string }) => `Àmbit: ${scope}`, developmentPath: ({ locator }: { locator: string }) => `${locator} · desenvolupament`, publisherUnverified: ({ displayName, id }: { displayName: string; id: string }) => `${displayName} · ${id} · sense verificar`, integrityBasis: { expected: ({ integrity }: { integrity: string }) => `${integrity} (esperada)`, observed: ({ integrity }: { integrity: string }) => `${integrity} (observada)` }, signatureStatus: { verified: ({ keyId }: { keyId: string }) => `Signatura del registre verificada: ${keyId}`, unsupported: ({ keyId }: { keyId: string }) => `Signatura del registre no compatible: ${keyId}` }, provenanceDeclaredUnverified: ({ predicateType }: { predicateType: string }) => `Declarada sense verificar: ${predicateType}`, provenanceRetrievedUnverified: ({ predicateTypes }: { predicateTypes: string }) => `Obtinguda sense verificar: ${predicateTypes}`, provenanceUnavailable: ({ code }: { code: string }) => `Procedència no disponible: ${code}`, curationUnreviewed: ({ sourceId }: { sourceId: string }) => `Origen de catàleg sense revisar: ${sourceId}`, curationApproved: ({ sourceId, reviewedAt, reason }: { sourceId: string; reviewedAt: string; reason: string }) => `Revisada per ${sourceId} el ${reviewedAt}${reason}`, savedSecret: 'Secret desat', connectedAccount: 'Compte connectat', secretKinds: ({ kinds }: { kinds: string }) => `Tipus de secret: ${kinds}`, connectedAccountService: ({ service }: { service: string }) => `Servei: ${service}`, credentialPurpose: ({ purpose }: { purpose: string }) => `Finalitat: ${purpose}`, credentialUse: ({ realm, phase }: { realm: string; phase: string }) => `S’utilitza a ${realm} durant ${phase}`, credentialAccess: ({ access }: { access: string }) => `Accés: ${access}`, credentialRequestHeaders: ({ origin, headers }: { origin: string; headers: string }) => `Capçaleres enviades a ${origin}: ${headers}`, credentialRequestEnvironment: ({ keys }: { keys: string }) => `Variables d’entorn: ${keys}`, credentialRequestFiles: ({ files }: { files: string }) => `Fitxers: ${files}`, realm: { web: 'el navegador', ios: 'l’aplicació per a iOS', android: 'l’aplicació per a Android', daemon: 'el servei en segon pla' }, phase: { settings: 'la configuració', prepare: 'la preparació', connection: 'la connexió', speech: 'l’ús de veu' }, runtimeApi: ({ version }: { version: number }) => `API d’execució ${version}`,
        },
        sourceAdministration: { title: 'Orígens i registres', subtitle: 'Tria on descobreix aquesta màquina els paquets npm exactes i com accedeix als seus registres.', communityTitle: 'Directori npm públic', communitySubtitle: 'Integrat · cerca sense revisar de connectors Happier aptes a npm públic, no de qualsevol paquet npm.', configuredTitle: 'Orígens del marketplace', configuredEmpty: 'No hi ha orígens addicionals configurats.', add: 'Afegeix un origen', edit: 'Edita l’origen', remove: 'Elimina l’origen', removeTitle: 'Vols eliminar l’origen del marketplace?', removeBody: ({ name }: { name: string }) => `${name} deixarà d’utilitzar-se per cercar en aquesta màquina. Els connectors instal·lats no canviaran.`, sourceUrl: 'Adreça de l’origen', displayName: 'Nom visible', description: 'Descripció opcional', enabled: 'Activat', disabled: 'Desactivat', curated: 'Origen seleccionat', user: 'El teu origen', loadError: 'No s’han pogut carregar els orígens del marketplace.', retry: 'Torna-ho a provar', operationFailed: 'No s’ha pogut aplicar el canvi. Comprova la connexió amb la màquina i torna-ho a provar.', operationOutcomeUnknownTitle: 'Canvi pendent de revisió', operationOutcomeUnknownBody: 'És possible que la màquina seleccionada ja hagi aplicat aquest canvi, però el Happier no ha pogut confirmar el resultat. Revisa la configuració actualitzada abans de tornar-la a canviar.' },
        updatePolicy: { title: 'Regla d’actualització', target: ({ machine, server }: { machine: string; server: string }) => `S’aplica a ${machine} mitjançant ${server}.`, pinned: 'Versió fixada', pinnedSubtitle: 'No actualitzis fins que triïs una altra regla.', allowed: 'Actualitzacions permeses', allowedSubtitle: 'Les actualitzacions explícites continuen sense una altra confirmació, tret que augmentin els permisos declarats.' },
    } } as const;

const pluginMarketplaceDiscoverTranslations = { ca: {
        ...localizedReviewVocabulary.ca,
        ...marketplacePresentation.ca,
        secretFieldActions: { delete: 'Elimina el secret desat', deleteHint: 'Esborra el valor desat. No es pot desfer.', unbind: 'Treu-lo d’aquest plugin', unbindHint: 'Desvincula el secret desat d’aquesta opció. El secret es conserva.' },
        pluginChangeOutcomeUnknownTitle: 'Resultat no confirmat',
        pluginChangeOutcomeUnknownBody: ({ action, name, machine, server }: { action: string; name: string; machine: string; server: string }) => `Happier no ha pogut confirmar si ${action} per a ${name} ha acabat a ${machine} (${server}). Consulta la llista d’instal·lats d’aquesta màquina i la versió actual abans de tornar-ho a provar.`,
        updateFromInstalledRecordSubtitle: 'Fes avançar aquesta instal·lació pel seu propi canal d’actualització de confiança.',
        discover: {
            ...marketplacePresentation.ca.discover,
            status: {
                loading: 'S’està cercant a totes les fonts del mercat…',
                loadingSource: ({ source }: { source: string }) => `S’està cercant a ${source}…`,
                results: ({ count, sources }: { count: number; sources: number }) =>
                    `${count} connector(s) de ${sources} font(s)`,
                empty: 'Cap connector coincideix amb aquesta cerca.',
                error: ({ message }: { message: string }) => `No s’ha pogut actualitzar la cerca: ${message}`,
                errorTitle: 'No s’ha pogut actualitzar la cerca',
                stale: 'Aquests resultats responen a una cerca anterior. Torna a cercar per aplicar els controls de dalt.',
                partial: ({ count }: { count: number }) =>
                    `${count} font(s) han respost amb dades antigues o absents, així que els resultats poden ser incomplets.`,
                nonInstallable: ({ count }: { count: number }) =>
                    `S’han trobat ${count} entrada(es) que ara mateix no es poden instal·lar en aquesta màquina.`,
            },
            sourceFreshness: {
                stale: 'Més antic que aquesta font',
                'stale-offline': 'Darrers resultats coneguts, font fora de línia',
                unavailable: 'Font no disponible',
                'auth-unavailable': 'Aquesta font requereix iniciar la sessió',
                corrupt: 'No s’ha pogut llegir l’índex de la font',
            },
            nonInstallableReason: {
                sourceStale: 'La seva font del mercat no és actual.',
                artifactUnavailable: 'El seu paquet no és accessible amb l’accés al registre d’aquesta màquina.',
                notApproved: 'La instal·lació des d’aquesta font no està aprovada.',
                unsupportedSourceKind: 'Aquesta versió de Happier no admet aquest tipus de font.',
            },
            installSubtitle: ({ source }: { source: string }) =>
                `Revisa tot el que declara aquest connector abans de confiar en res que vingui de ${source}.`,
            registrySelectionRequired: ({ origin }: { origin: string }) => `Necessita un perfil de registre per a ${origin}`,
            registrySelection: {
                title: ({ name }: { name: string }) => `Tria un registre per a ${name}`,
                body: ({ name, origin, source }: { name: string; origin: string; source: string }) =>
                    `${name} es publica a ${origin}. Tria el perfil de registre que ${source} fa servir en aquesta màquina, o afegeix-ne un i inicia la sessió. No es baixa res fins a la revisió d’instal·lació i confiança.`,
                continue: 'Continua',
            },
        },
    } } as const;

return { marketplacePresentation, localizedTechnicalReviewVocabulary, localizedReviewVocabulary, pluginMarketplaceDiscoverTranslations };
})();

const Domain_pluginPermissionTranslations = (() => {
type PermissionDetailsTranslation = Shared_pluginPermissionTranslations.PermissionDetailsTranslation;

const pluginPermissionTranslations = { ca: {
        fields: {
            pluginId: 'ID del complement',
            capability: 'Capacitat',
            scope: 'Àmbit',
            requester: 'Sol·licitant',
            authority: 'Autoritat',
            requestedAt: 'Hora de la sol·licitud',
            reason: 'Motiu',
        },
        scope: { account: 'Compte', project: 'Projecte', workspace: 'Espai de treball' },
        requester: { user: 'Usuari', host: 'Amfitrió', plugin: 'Complement' },
        authority: { bundled: 'Inclòs', machineInstallation: 'Instal·lació a la màquina' },
        identifiers: {
            session: 'Sessió',
            request: 'Sol·licitud',
            machine: 'Màquina',
            installation: 'Instal·lació',
        },
        accessibilitySummary: ({ details }) => `Detalls de la sol·licitud de permís. ${details}`,
    } } as const satisfies Pick<Readonly<Record<string, PermissionDetailsTranslation>>, "ca">;

return { pluginPermissionTranslations };
})();

const Domain_pluginSettingsPresentationTranslations = (() => {
const english = Shared_pluginSettingsPresentationTranslations.english;

const pluginSettingsPresentationTranslations = { ca: {
        rowStatus: { enabled: 'Activat', disabled: 'Desactivat', incompatible: 'No compatible', trustRemoved: 'Confiança retirada', needsAttention: 'Requereix atenció' },
        developmentPhase: { observing: 'Observant', preparingDependencies: 'Preparant dependències', compiling: 'Compilant', validating: 'Validant', active: 'Actiu', retainedIncumbent: 'Versió anterior activa', unavailable: 'No disponible' },
        rowSource: { bundled: 'Inclòs amb Happier', npm: 'Paquet npm', archive: 'Fitxer d’arxiu', localPath: 'Carpeta local', other: 'Font configurada' },
        rowAttention: { trustRemoved: 'Aquest connector ja no s’executa. Torna’l a instal·lar per confiar de nou en el seu codi.', incompatible: 'Aquesta versió no es pot executar a la màquina seleccionada.' },
        developerGroupTitle: 'Desenvolupament',
        developerGroupFooter: 'Crea connectors a la màquina seleccionada i consulta què informa el seu servei.',
        developerDevelopmentSubtitle: 'Crea, edita, prova i empaqueta connectors des de carpetes teves.',
        developerDiagnosticsSubtitle: 'Diagnòstics del servei i del catàleg per a la màquina seleccionada.',
        detailMissingTitle: 'Aquest connector no és a la màquina seleccionada',
        detailMissingBody: ({ pluginId }: { pluginId: string }) => `${pluginId} no està instal·lat aquí. Pot ser que s’hagi desinstal·lat o que sigui en una altra màquina.`,
        detailMissingRetry: 'Torna-ho a comprovar',
        surfaces: {
            purpose: 'Afegeix superfícies, ordres i integracions a Happier. Els connectors s’executen com a codi de confiança a les teves màquines.',
            navigationTitle: 'Connectors',
            updatesTitle: 'Actualitzacions',
            moreDescriptionInSettings: 'D’on venen els connectors, crear-ne de propis i el que informa aquesta màquina. S’obren a Configuració.',
            fix: 'Corregeix',
            allSources: 'Totes les fonts',
            shelfCurated: 'Selecció',
            shelfCuratedDescription: 'Revisats i recomanats per Happier. Cada instal·lació continua mostrant la revisió completa.',
            shelfCommunity: 'Comunitat',
            shelfCommunityDescription: 'Paquets npm sense revisar. Instal·la i confia mostra exactament a què pot accedir cadascun.',
            shelfUser: 'Les teves fonts',
            shelfUserDescription: 'Entrades de fonts del mercat afegides en aquesta màquina.',
            manage: 'Gestiona',
            installed: 'Instal·lat',
            notShownTitle: 'No s’ha pogut mostrar tot',
            listingInstallsOn: ({ machine }: { machine: string }) => `S’instal·la a ${machine}. En revises l’accés abans que s’executi res.`,
            listingChooseMachine: 'Tria una màquina a la capçalera per instal·lar aquest connector.',
            listingRunsIn: 'S’executa a',
            listingPlatforms: 'Plataformes',
            listingSource: 'Font',
            listingCategories: 'Categories',
            listingNotFoundTitle: 'Aquesta entrada no està disponible',
            listingNotFoundBody: 'Potser s’ha retirat de la font, o aquesta màquina no pot arribar a la font ara mateix.',
            developmentSourcesTitle: 'Connectors en desenvolupament',
            chooseMachineInstalled: 'Tria una màquina a la capçalera per veure’n els connectors.',
            chooseMachineBrowse: 'Tria una màquina a la capçalera per explorar els connectors que pot instal·lar.',
            openAsPage: 'Obre com a pàgina',
            detailInstalledLabel: 'Connector instal·lat',
            detailListingLabel: 'Fitxa del connector',
            viewLabel: 'Mostra com a',
            viewGrid: 'Graella',
            viewList: 'Llista',
            installedSearchPlaceholder: 'Cerca als connectors instal·lats',
            statusFilterLabel: 'Mostra els connectors',
            statusAll: 'Tots els connectors',
            statusEnabled: 'Activats',
            statusDisabled: 'Desactivats',
            statusAttention: 'Cal revisar-los',
            noMatch: ({ query }: { query: string }) => `Cap connector coincideix amb «${query}»`,
            clearSearch: 'Esborra',
            emptyTitle: 'Encara no hi ha cap connector instal·lat',
            emptyBody: 'Els connectors afegeixen panells, ordres i eines per als teus agents. Comença pels que fa Happier.',
            browsePlugins: 'Explora els connectors',
            browseEmpty: 'Les teves fonts encara no ofereixen cap connector.',
            forDevelopers: 'Per a desenvolupadors',
            readFailedTitle: 'No s’han pogut llegir els connectors d’aquesta màquina',
            readFailedBody: 'No s’ha canviat res. Torna-ho a provar per consultar de nou la màquina.',
            lastKnown: ({ status }: { status: string }) => `Darrer estat conegut · ${status}`,
            machinesTitle: 'Màquines',
            machinesDescription: 'On està instal·lat aquest connector.',
            machinesCurrent: ({ current, total }: { current: number; total: number }) => `Actualitzat a ${current} de ${total} màquines`,
            onMachines: ({ count }: { count: number }) => `En ${count} màquines`,
            onMachine: ({ machine }: { machine: string }) => `A ${machine}`,
            addedGroup: 'Afegits',
            machinesRetained: 'Una màquina que ja no és en aquest compte',
            open: 'Obre',
            review: 'Revisa',
            seeAll: 'Mostra-ho tot',
            allResults: 'Tots els resultats',
            categoriesLabel: 'Categories',
            runOnNoneChosen: 'Cap màquina triada',
            runOnNoneAvailable: 'Encara cap màquina no el pot executar',
            runsEverywhere: 'A cada màquina que executa Happier',
            kinds: {
                agent: 'Agent',
                providers: 'Proveïdor de models',
                scmHostingProviders: 'Allotjament de codi',
                scmBackends: 'Control de versions',
                voice: 'Veu',
                connectedAccounts: 'Servei connectat',
                inputTypes: 'Tipus d’entrada',
                mcp: 'Eines MCP',
                pluginUi: 'Panells de l’app',
                pluginBrowser: 'Vistes del navegador',
                composer: 'Eines del compositor',
            },
        },
    } } as const;

return { pluginSettingsPresentationTranslations };
})();

const Domain_pluginUpdateReviewTranslations = (() => {
const en = Shared_pluginUpdateReviewTranslations.en;

const ca = {
    title: 'Revisió d’actualitzacions',
    confirmSubtitle: 'Les actualitzacions que amplien l’accés que vas concedir pregunten primer.',
    autoApplySubtitle: 'Les actualitzacions s’apliquen sense preguntar, encara que amplien l’accés.',
    confirmOption: 'Preguntar',
    autoApplyOption: 'Automàtic',
};

const pluginUpdateReviewTranslations = { ca: ca };

return { pluginUpdateReviewTranslations };
})();

const Domain_pluginWebhookAdministrationTranslations = (() => {
const english = Shared_pluginWebhookAdministrationTranslations.english;

const pluginWebhookAdministrationTranslations = { ca: {
    webhookAdministration: {
        title: 'Connectors webhooks',
        footer: 'Punts finals del compte, objectius exactes de la màquina, cues de lliurament i recuperació de missatges no lliurats. Els cossos de lliurament mai es mostren aquí.',
        unavailableTitle: 'Els webhooks de connector no estan disponibles',
        unavailableSubtitle: 'Aquest servidor no ha habilitat la recepció de webhooks de connector.',
        endpointsTitle: 'Punts finals del webhook',
        emptyTitle: 'No hi ha cap punt final de connectors webhook',
        emptySubtitle: 'Els punts finals creats pels connectors instal·lats romandran visibles aquí, inclosos els punts finals l\'objectiu dels quals no està disponible.',
        loadError: 'No s\'ha pogut carregar l\'estat del webhook.',
        endpointSubtitle: ({ readiness, routing, sourceInstanceId }: { readiness: string; routing: string; sourceInstanceId: string }) => `${readiness} · ${routing} · ${sourceInstanceId}`,
        targetSubtitle: ({ machineId, materializationId, status }: { machineId: string; materializationId: string; status: string }) => `${machineId} / ${materializationId} · ${status}`,
        queueSubtitle: ({ queued, retrying, claimed, deadLetter }: { queued: number; retrying: number; claimed: number; deadLetter: number }) => `En cua ${queued} · tornar a provar ${retrying} · reclamat ${claimed} · lletra morta ${deadLetter}`,
        copyUrl: 'Copia l\'URL del webhook',
        selectTarget: 'Seleccioneu l\'objectiu de lliurament',
        retarget: 'Reorientar el punt final',
        retargetUnavailable: 'Seleccioneu una materialització exacta del connector disponible abans de reorientar aquest punt final.',
        originSelected: 'La materialització exacta del connector seleccionada es tornarà a comprovar quan continueu.',
        originUnavailable: 'No s\'ha seleccionat cap materialització exacta del connector disponible.',
        movePendingTitle: 'Moure les entregues pendents?',
        movePendingBody: 'Voleu moure els lliuraments en cua i sense lliurament al nou objectiu exacte? Els lliuraments reclamats activament es mantenen en el seu objectiu actual.',
        resumePendingMove: 'Reprèn el moviment pendent de lliurament',
        resumePendingMoveSubtitle: ({ count }: { count: number }) => `${count} els lliuraments en cua o sense lliurament segueixen utilitzant l'objectiu exacte anterior.`,
        configureCredential: 'Configura la credencial de signatura',
        rotateCredential: 'Gira la credencial de signatura',
        finishRotation: 'Finalitzar la rotació de credencials',
        finishRotationSubtitle: 'Deixeu d\'acceptar la credencial anterior ara.',
        credentialSecretTitle: 'Deseu el nou secret de signatura',
        credentialSecretBody: ({ secret }: { secret: string }) => `Aquest secret es mostra una vegada. Deseu-lo abans de tancar aquest missatge.\n\n${secret}`,
        revoke: 'Revoca el punt final',
        revokeTitle: 'Voleu revocar el punt final del webhook?',
        revokeBody: 'Es rebutjaran els nous lliuraments a aquest punt final. Les metadades de lliurament existents continuen disponibles segons la política de retenció.',
        operationFailed: 'L\'operació del webhook no s\'ha completat. Actualitza l\'estat actual abans de tornar-ho a provar.',
        deliveryTitle: ({ digest }: { digest: string }) => `Carta morta ${digest}`,
        deliveryStatus: 'Estat de lliurament',
        deliverySubtitle: ({ errorCode, attempts, replays, machineId, materializationId }: { errorCode: string; attempts: number; replays: number; machineId: string; materializationId: string }) => `${errorCode} · ${attempts} intents · ${replays} repeticions · ${machineId} / ${materializationId}`,
        unresolvedAutomationAdmissionTitle: ({ totalCount }: { totalCount: number }) => `${totalCount} admissions d'automatització no resoltes`,
        unresolvedAutomationAdmissionSubtitle: ({ sample, omittedCount }: { sample: string; omittedCount: number }) => `Mostra: ${sample} · ${omittedCount} no es mostra`,
        replay: 'Entrega de reproducció',
        discardTitle: 'Descartar el lliurament?',
        discardBody: 'El cos de lliurament xifrat o emmagatzemat normal s\'eliminarà i no es podrà recuperar.',
    },
} } as const;

return { pluginWebhookAdministrationTranslations };
})();

const Domain_profilesPageTranslations = (() => {
const english = Shared_profilesPageTranslations.english;

const translated = Shared_profilesPageTranslations.translated;

const profilesPageTranslations = { ca: translated({
        profilesPage: {
            searchPlaceholder: 'Cerca perfils',
            emptyTitle: 'Encara no hi ha perfils',
            newProfileTitle: 'Perfil nou',
            notFoundTitle: 'Aquest perfil ja no existeix',
            notFoundDescription: 'Potser s\'ha suprimit des d\'un altre dispositiu.',
            backToProfiles: 'Torna als perfils',
            discardDraft: 'Descarta',
            detailDescription: 'S\'utilitza quan una sessió nova comença amb aquest perfil.',
            builtInDetailDescription: 'Un perfil ja preparat. Si deses els canvis, se\'n crea una còpia teva.',
            enabledHint: 'S\'ofereix quan tries un perfil per a una sessió nova.',
            pickerSection: 'Selector de perfil',
            pickerSectionDescription: 'On apareix aquesta opció quan comences una sessió.',
            showFirst: 'Mostra primer',
            showFirstDescription: 'Mostra l\'entorn de la màquina entre els teus preferits.',
            environmentDescription: 'Variables d\'entorn que es defineixen quan una sessió comença amb aquest perfil. Els valors poden fer referència a les variables de la màquina.',
            descriptionTitle: 'Descripció',
            descriptionHint: 'Opcional. Es mostra quan tries aquest perfil.',
        },
    }) };

return { profilesPageTranslations };
})();

const Domain_providerCollectionTranslations = (() => {
type ProviderCollectionCopy = Shared_providerCollectionTranslations.ProviderCollectionCopy;

const en = Shared_providerCollectionTranslations.en;

const ca: ProviderCollectionCopy = {
    settingsProvidersCollection: {
        description: 'Connecta una font de models una vegada i fes servir els seus models amb tots els agents compatibles.',
        foundOn: ({ machine }: { machine: string }) => `Trobat a ${machine}`,
        foundOnThisMachine: 'Trobat en aquesta màquina',
        connect: 'Connecta',
        start: 'Inicia',
        test: 'Prova',
        addProvider: 'Afegeix un proveïdor',
        customEndpoint: 'Endpoint personalitzat',
        menuOwnCategory: 'El teu',
        menuCatalogCategory: 'Del catàleg',
        newTitle: 'Proveïdor nou',
        emptyDescription: 'Afegeix un proveïdor del catàleg o el teu propi endpoint compatible.',
        machineScopeLabel: 'Configurat a',
        invitationTitle: 'Porta els teus models',
        invitationDescription: 'Connecta un proveïdor una vegada i els seus models apareixen al selector de models de tots els agents compatibles. Els servidors locals com Ollama s’executen a la teva màquina.',
        invitationNeedsMachine: 'Els proveïdors es connecten i es comproven en una de les teves màquines. Afegeix una màquina per començar.',
        setUpMachine: 'Configura una màquina',
        duplicateAsCustom: 'Copia com a proveïdor personalitzat',
        discard: 'Descarta',
        enabled: 'Activat',
        enabledDescription: 'Ofereix els seus models als selectors de models dels agents',
        saved: 'Desada',
        replace: 'Substitueix',
        addKey: 'Tria una clau',
        apiKeyDefaultDescription: 'Es fa servir a totes les màquines tret que una tingui la seva pròpia clau.',
        apiKeyMachineDescription: 'Es fa servir en aquesta màquina en lloc de la clau per defecte.',
        availabilityTitle: 'Disponibilitat',
        availabilityDescription: 'On poden fer servir aquest proveïdor els agents.',
        modelsDescription: 'Tria quins models ofereixen els agents als seus selectors de models.',
        modelsShown: ({ shown, total }: { shown: number; total: number }) => `${shown} de ${total} visibles als selectors de models`,
        modelsFilter: ({ count }: { count: number }) => `Filtra ${count} models`,
        connectionTitle: 'Connexió',
        nameDescription: 'Es mostra a la llista de proveïdors i als selectors de models.',
        nameRequired: 'Afegeix un nom.',
        nameTooLong: ({ max }: { max: number }) => `Fes servir ${max} caràcters o menys.`,
        managedTitle: 'Servei local gestionat',
        endpointsTitle: 'Endpoints',
        endpointsDescription: 'Deixa-ho buit per fer servir les adreces que proporciona el proveïdor.',
        overridesDescription: 'On van les sol·licituds. Canvia l’adreça per a totes les màquines o només per a aquesta.',
        afterSavingTitle: 'Després de desar',
        destinationDescription: 'On enviarà Happier les sol·licituds d’aquest proveïdor.',
        destinationPending: 'Apareix quan tots els endpoints estan emplenats.',
    },
};

const providerCollectionTranslations = { ca } as const;

return { providerCollectionTranslations };
})();

const Domain_providerSessionTranslations = (() => {
const providerSessionTranslations = { ca: {
        launchDefaultLabel: ({ provider }: { provider: string }) => `Proveïdor: ${provider}`,
        launchNamedLabel: ({ provider, connection }: { provider: string; connection: string }) => `Proveïdor: ${provider} · ${connection}`,
        changedTitle: 'La configuració del proveïdor ha canviat', changedBody: ({ provider, connection }: { provider: string; connection: string }) => `Aquesta sessió continua utilitzant la configuració de ${provider} · ${connection} amb què es va iniciar.`,
        unavailableTitle: 'El proveïdor ja no està disponible', unavailableBody: ({ provider, connection }: { provider: string; connection: string }) => `${provider} · ${connection} ja no està disponible per reprendre aquesta sessió.`,
        disabledTitle: 'El proveïdor està desactivat', disabledBody: ({ provider, connection }: { provider: string; connection: string }) => `Habilita ${provider} · ${connection} abans de reprendre aquesta sessió.`,
        incompatibleTitle: 'El proveïdor ja no és compatible', incompatibleBody: ({ provider, connection }: { provider: string; connection: string }) => `${provider} · ${connection} ja no és compatible amb l’agent d’aquesta sessió.`,
        restartAction: 'Reinicia la sessió', chooseModelAction: 'Tria un model',
    } } as const;

return { providerSessionTranslations };
})();

const Domain_reviewWalkthroughTranslations = (() => {
type Count = Shared_reviewWalkthroughTranslations.Count;

type ReviewWalkthroughTranslations = Shared_reviewWalkthroughTranslations.ReviewWalkthroughTranslations;

const en = Shared_reviewWalkthroughTranslations.en;

const ca: ReviewWalkthroughTranslations = {
    severityCount: ({ count, severity }) => `${count} ${severity}`,
    findingRefA11y: ({ label, title }) => `${label}: ${title}. Ves a la troballa`,
    tag: { noFile: 'Sense fitxer', outdated: 'Desfasada', unplaced: 'No es pot situar', notInStory: 'Fora de les parades' },
    outdatedSummary: 'El codi ha canviat després de la revisió.',
    askAboutFindingA11y: ({ title }) => `Pregunta sobre la troballa: ${title}`,
    tailTitle: 'Troballes sense parada',
    tailDescription: 'Es queden aquí perquè res no desaparegui quan les seves línies no es poden situar.',
    inContext: 'en context',
    fromReviewAt: ({ time }) => `de la revisió de les ${time}`,
    reviewLabel: 'Revisió:',
    enginesOf: ({ count, total }) => `${count} de ${total}`,
    enginesFinished: 'motors han acabat',
    enginesRunning: ({ count }) => (count === 1 ? '1 motor encara revisa' : `${count} motors encara revisen`),
    fromEngines: ({ engines, inStory }) => `de ${engines} · ${inStory} al recorregut`,
    and: ' i ',
    inStoryElsewhere: ({ inStory, elsewhere }) => `${inStory} al recorregut, ${elsewhere} en altres llocs`,
    allInStory: 'totes al recorregut',
    seeded: {
        title: 'Escrit després de la revisió, per una execució nova.',
        body: ({ reviewers, time }) => `El narrador no ha revisat el codi; cada troballa citada aquí ve de ${reviewers} a les ${time}.`,
        changed: ({ count }) => (count === 1 ? 'Des de llavors ha canviat 1 fitxer.' : `Des de llavors han canviat ${count} fitxers.`),
    },
    findingsFrom: ({ count, engine }) => (count === 1 ? `1 troballa de ${engine}` : `${count} troballes de ${engine}`),
    publishedBefore: ({ time }) => `publicades a les ${time}, abans del recorregut`,
    steps: {
        reviewing: 'Revisant',
        engineProgress: ({ done, running }) => `${done} ha acabat · ${running} revisa`,
        reviewed: ({ count }) => (count === 1 ? 'Revisat · 1 troballa' : `Revisat · ${count} troballes`),
        reviewedShort: ({ count }) => `Revisat · ${count}`,
        engineReviewed: ({ engine, count }) => (count === 1 ? `${engine} · 1 troballa` : `${engine} · ${count} troballes`),
        reviewedAt: ({ time }) => `Revisat a les ${time}`,
        reviewAt: ({ time }) => `Revisió de les ${time}`,
        partial: ({ count }) => (count === 1 ? 'Revisió parcial · 1 troballa' : `Revisió parcial · ${count} troballes`),
        ready: 'Recorregut a punt',
        readyShort: 'Recorregut',
        failed: 'El recorregut ha fallat',
        narrating: 'Narrant',
        narratorWriting: ({ narrator }) => `${narrator} escriu`,
        writing: 'Escrivint el recorregut',
        writingShort: 'Escrivint',
    },
    writingWithFindings: 'Escrivint el recorregut amb les troballes…',
    dialog: {
        engines: 'Motors de revisió',
        selected: ({ count }) => `${count} seleccionats`,
        loadingEngines: 'Cercant motors de revisió…',
        noEngines: 'Cap motor de revisió no pot funcionar a la màquina d’aquesta sessió.',
        findingsOnly: 'només troballes',
        changes: 'Canvis',
        instructions: 'Instruccions',
        instructionsPlaceholder: 'Què ha de mirar la revisió?',
        defaultInstructions: 'Revisa aquests canvis pel que fa a correcció, risc i proves que falten.',
        alsoWalkthrough: 'Escriu també un recorregut',
        alsoWalkthroughBody: 'Quan arriben les troballes, la mateixa execució escriu el recorregut amb elles en context. Res no llegeix els canvis dues vegades.',
        narrator: 'Narrador',
        chooseNarrator: 'Tria un narrador',
        narratorSeveral: ({ count }) => `${count} motors revisen; un model escriu el recorregut a partir de totes les seves troballes.`,
        narratorFindingsOnly: ({ engine }) => `${engine} retorna troballes, no text. Un model escriu el recorregut a partir d’elles.`,
        noNarrator: 'Cap d’aquests motors no pot escriure un recorregut. Afegeix un motor amb model o desactiva el recorregut.',
        footerReviewThenWalkthrough: 'Revisant i després escrivint el recorregut',
        footerHandover: ({ reviewer, narrator }) => `${reviewer} revisa · ${narrator} escriu`,
    },
    generated: {
        continues: ({ model }) => `${model} · continua la revisió`,
        seeded: ({ model }) => `${model} · a partir de les troballes de la revisió`,
        handover: ({ narrator, engine }) => `${narrator}, a partir de les troballes de ${engine}`,
    },
    partial: {
        failed: ({ engines }) => `La revisió de ${engines} no ha acabat.`,
        notClean: 'És una revisió parcial, no una revisió neta.',
        finishedWith: ({ engines, count }) => (count === 1 ? `${engines} ha acabat amb 1 troballa.` : `${engines} ha acabat amb ${count} troballes.`),
        retry: ({ engine }) => `Torna-ho a provar amb ${engine}`,
    },
    explain: { action: 'Explica les troballes', running: 'Explicant les troballes', a11y: 'Demana una explicació de les troballes al recorregut', unknownModel: 'Model desconegut', requester: { user: 'un usuari', agent: 'un agent', plugin: 'un connector', automation: 'una automatització', workflow: 'un flux de treball', unknown: 'un sol·licitant desconegut' }, header: ({ model, time, requester = 'tu' }) => `Explicació de la revisió · ${model} · demanada per ${requester} a les ${time} · no és un veredicte` },
    finished: {
        title: 'Revisió acabada',
        openFindings: 'Obre les troballes',
        walkMeThrough: 'Fes-me el recorregut',
        andMore: ({ count }) => `i ${count} més`,
        continues: 'Continua aquesta execució de revisió: el revisor l’escriu a partir del que ja ha llegit. No s’analitza res de nou.',
        narrates: ({ count }) => (count === 1
            ? 'L’execució de revisió ha acabat. Una execució nova escriu el recorregut a partir d’aquesta troballa i dels canvis; no tornarà a revisar.'
            : `L’execució de revisió ha acabat. Una execució nova escriu el recorregut a partir d’aquestes ${count} troballes i dels canvis; no tornarà a revisar.`),
    },
    started: {
        transcript: ({ engineCount, fileCount }) => `Revisió iniciada · ${engineCount} ${engineCount === 1 ? 'motor' : 'motors'} · ${fileCount} ${fileCount === 1 ? 'fitxer' : 'fitxers'}`,
        notStarted: ({ engines }) => `${engines} no ha començat. Els altres revisen.`,
        narrationFailed: 'La revisió ha començat, però no s’ha pogut demanar el recorregut. Les troballes arribaran igualment.',
    },
};

const reviewWalkthroughTranslations = { ca: { reviewWalkthrough: ca } };

return { reviewWalkthroughTranslations };
})();

const Domain_rolesTranslations = (() => {
type RolesTranslations = Shared_rolesTranslations.RolesTranslations;

const rolesTranslations = { ca: {
        rail: {
            label: 'Rols',
            title: 'Rol',
            searchPlaceholder: 'Cerca rols…',
            empty: 'Cap rol coincideix.',
            footer: 'Un rol porta les seves instruccions, motor i manera d’executar-se, perquè els fluxos siguin portables.',
            manage: 'Gestiona els rols',
            engineAppliesOnStart: 'El motor s’aplica en iniciar aquest rol',
            defaultEngine: 'Agent predeterminat',
            activeAccessibilityLabel: 'Rols, hi ha un rol en ús',
        },
        settings: {
            description: 'Qui fa cada tipus de feina. Els fluxos i els orquestradors demanen un rol; el rol diu com executar-la.',
            count: ({ count }) => (count === 1 ? '1 rol' : `${count} rols`),
            newRole: 'Rol nou',
            groupBuiltIn: 'Integrats',
            groupYours: 'Teus',
            groupShared: 'Compartits amb tu',
            groupPlugins: 'De connectors',
            edited: 'Editat',
            sourceBuiltIn: 'Integrat',
            sourceYours: 'Teu',
            sourceShared: 'Compartit amb tu',
            sourcePlugin: ({ plugin }) => `De ${plugin}`,
            migrated: 'dels subagents 0.2',
            migratedNote: 'Els rols marcats «dels subagents 0.2» vénen de la teva guia de subagents: la descripció ara és la instrucció, l’agent i el model són el motor.',
            nameTitle: 'Nom',
            newRoleName: 'Rol sense títol',
            instructionsTitle: 'Instruccions',
            instructionsDescription: 'Què fa, quan fer-lo servir i com informar. Els agents ho llegeixen quan reparteixen feina.',
            resetToDefault: 'Restableix el predeterminat',
            readOnlyNote: 'Compartit amb tu per veure’l. Les teves tries de motor i perfil continuen sent teves.',
            howItRunsTitle: 'Com s’executa',
            engineTitle: 'Motor',
            engineDescription: 'Agent, model i esforç.',
            engineFollowsDefault: 'Segueix el teu agent predeterminat.',
            engineUnavailable: 'No disponible aquí. Tria un motor.',
            runsAsTitle: 'S’executa en',
            runsAsSession: 'Sessió',
            runsAsBackgroundRun: 'Execució en segon pla',
            runsAsSessionDescription: 'Una sessió que pots obrir i dirigir.',
            runsAsBackgroundDescription: 'S’executa en segon pla i informa; no hi ha sessió per dirigir.',
            handsOffTitle: 'Sense editar',
            handsOffDescription: 'Planifica i delega; no edita fitxers pel seu compte.',
            secondOpinionTitle: 'Segona opinió',
            secondOpinionDescription: 'Recomanada li demana que consideri una segona opinió abans d’una pull request o de donar la feina per acabada.',
            secondOpinionOff: 'Desactivada',
            secondOpinionEncouraged: 'Recomanada',
            enabledTitle: 'Disponible',
            enabledDescription: 'S’ofereix al tauler de rols i als orquestradors.',
            advancedTitle: 'Avançat',
            launchProfileTitle: 'Perfil d’inici',
            launchProfileDescription: 'Entorn, permisos, màquina',
            launchProfileNone: 'Cap',
            profileUnavailable: 'Perfil no disponible',
            previewTitle: 'El que llegeixen els agents',
            previewDescription: 'El bloc que s’envia a cada torn, exactament.',
            deleteRole: 'Suprimeix el rol',
            deleteConfirmTitle: 'Vols suprimir aquest rol?',
            deleteConfirmBody: ({ name }) => `${name} se suprimeix per a tu i per a tothom amb qui es comparteix. Les sessions que el fan servir en conserven la còpia.`,
            share: 'Comparteix…',
            sendCopyFailed: 'No s’ha pogut enviar una còpia.',
            saveFailed: 'No s’ha pogut desar el rol.',
            loadFailed: 'No s’han pogut carregar els teus rols.',
            emptyDetailTitle: 'Tria un rol',
            emptyDetailBody: 'Tria un rol per veure’n les instruccions i com s’executa.',
        },
        delegation: {
            title: 'Delegació',
            description: 'Com els agents passen feina a altres agents.',
            depthTitle: 'Profunditat de treball',
            approvalReviewer: 'Revisor de permisos',
            approvalReviewerDescription: 'Revisa automàticament les peticions de baix risc, una sola vegada. Les accions sensibles necessiten el teu acord. Només en modes Predeterminat i Acceptar canvis.',
            approvedByReviewer: 'Permès una vegada pel revisor',
            depthDescription: 'Les sessions, execucions en segon pla i fluxos que inicien els agents en poden iniciar més. Aquest límit atura cadenes descontrolades. El que inicies tu no té mai límit.',
            depthSetting: 'Fins on poden delegar els agents',
            depthSettingDescription: ({ count }) => (count === 1
                ? 'Un nivell. Després, l’agent ha de fer la feina ell mateix.'
                : `${count} nivells. Després, l’agent ha de fer la feina ell mateix.`),
            ladderRoot: 'Feina que inicies tu',
            ladderRootDetail: 'Iniciat per tu · sense límit',
            ladderLevel: ({ level }) => `Nivell ${level}`,
            ladderLevelDetail: 'Iniciat per un agent',
            ladderRefused: 'Una delegació més',
            ladderRefusedDetail: ({ level }) => `Nivell ${level} · rebutjat; l’agent ho fa ell mateix`,
        },
        session: {
            useDefaults: 'Fes servir els predeterminats',
            crossOwnerNote: 'Els rols es van copiar en iniciar-se.',
            addRole: 'Afegeix un rol a aquesta sessió',
            addRoleConfirm: 'Afegeix el rol',
            namePlaceholder: 'Nom del rol',
            instructionsPlaceholder: 'Què fa aquest rol i quan fer-lo servir',
            notesTitle: 'Notes',
            notesPlaceholder: 'El que ha de saber cada sessió de sota',
            applyToReports: 'Aplica a les sessions de sota',
            handsOffTitle: 'Sense editar',
            handsOffDescription: 'Planifica i delega; no edita fitxers.',
            saveFailed: 'No s’ha pogut desar aquest canvi.',
            sectionTitle: 'Rols',
            allRoles: 'Tots els rols',
            inUse: ({ count }) => `${count} en ús`,
            changed: 'canviat',
            thisSession: 'aquesta sessió',
            reset: 'Restableix',
            newRoleForSession: 'Rol nou per a aquesta sessió',
            changeForSession: 'Canvia per a aquesta sessió',
            editNotes: 'Edita les notes',
            more: 'Més',
            info: 'Els rols s’apliquen a aquesta sessió i a les sessions que en depenen.',
            countChanged: ({ count }) => `${count} canviats`,
            countAdded: ({ count }) => `${count} afegits`,
            addNotes: 'Afegeix notes sobre com ha d’orquestrar aquesta sessió',
        },
        profiles: {
            sharedWithYouTitle: 'Compartits amb tu',
            sharedWithYouDescription: 'Perfils que persones i equips comparteixen amb tu. Els valors secrets es queden amb els propietaris.',
            share: 'Comparteix…',
            shareFailedTitle: 'No s’ha pogut compartir aquest perfil',
            shareNeedsSavedSecrets: 'Els valors secrets no viatgen mai. Mou cada valor d’aquest perfil a un Secret desat, enllaça’l i torna a compartir.',
            shareAwaitingApproval: 'La publicació d’aquest perfil espera aprovació. Un cop aprovada, torna a triar «Comparteix…».',
        },
    } } as const satisfies Pick<Record<string, RolesTranslations>, "ca">;

return { rolesTranslations };
})();

const Domain_runPageTranslations = (() => {
type Count = Shared_runPageTranslations.Count;

type Machine = Shared_runPageTranslations.Machine;

type Reviewer = Shared_runPageTranslations.Reviewer;

type RunPageTranslations = Shared_runPageTranslations.RunPageTranslations;

const runPageTranslations = { ca: {
        untitledRun: 'Execució d’agent',
        intentTitles: { review: 'Revisió', plan: 'Pla', delegate: 'Tasca delegada' },
        thisMachine: 'aquesta màquina',
        menu: {
            cancelResponse: 'Cancel·la aquesta resposta',
            copyResult: 'Copia el resultat',
            showInTranscript: 'Mostra a la transcripció',
            runDetails: 'Detalls de l’execució',
            agent: 'Agent',
            permissions: 'Permisos',
            kind: 'Tipus',
            finishesOnItsOwn: 'Acaba tot sol',
            staysOpen: 'Es manté obert',
            started: 'Inici',
            run: 'Execució',
            process: 'Procés',
        },
        opening: { reading: ({ machine }) => `S’està llegint des de ${machine}.` },
        gone: {
            title: ({ machine }) => `Aquesta execució ja no és a ${machine}`,
            reason: 'Ja no s’hi conserva, i la part de la transcripció carregada no la inclou.',
            closeTab: 'Tanca la pestanya',
        },
        stopFailed: {
            title: {
                review: 'No s’ha pogut aturar aquesta revisió',
                plan: 'No s’ha pogut aturar aquest pla',
                delegate: 'No s’ha pogut aturar aquesta tasca',
                run: 'No s’ha pogut aturar aquesta execució',
            },
            reasonWithOthers: ({ machine, count }) => `${machine} no ha confirmat l’aturada. Pots aturar tota la sessió; això també atura ${count === 1 ? 'l’altre agent' : `els altres ${count} agents`} que s’hi executen.`,
            reasonAlone: ({ machine }) => `${machine} no ha confirmat l’aturada. Pots aturar tota la sessió.`,
            stopSession: 'Atura la sessió…',
        },
        steps: {
            title: 'Com hi ha arribat',
            count: ({ count }) => (count === 1 ? '1 pas' : `${count} passos`),
        },
        review: {
            findings: 'Troballes',
            findingsCount: ({ count }) => `${count}`,
            highCount: ({ count }) => `${count} altes`,
            severity: { blocker: 'Bloquejant', high: 'Alta', medium: 'Mitjana', low: 'Baixa', nit: 'Detall' },
            triageLabel: 'Què fer amb aquesta troballa',
            reviewerAsks: 'El revisor pregunta',
            answer: 'Respon',
            askAboutThis: 'Pregunta sobre això',
            fixesSelected: ({ count }) => (count === 1 ? '1 correcció seleccionada' : `${count} correccions seleccionades`),
            noFixesSelected: 'Tria les correccions a implementar',
            implementFixes: ({ count }) => (count === 1 ? 'Implementa 1 correcció' : count > 1 ? `Implementa ${count} correccions` : 'Implementa correccions'),
            couldNotSaveChoice: 'No s’ha pogut desar la teva tria.',
            reviewers: 'Revisors',
            findingTotal: ({ count }) => (count === 1 ? '1 troballa' : `${count} troballes`),
            moreFindings: ({ count }) => (count === 1 ? '1 troballa més' : `${count} troballes més`),
            fixesToImplement: ({ count }) => (count === 1 ? '1 correcció per aplicar' : `${count} correccions per aplicar`),
            verifiedFirst: 'Cadascuna es verifica primer i després es corregeix',
            replies: ({ count }) => (count === 1 ? '1 resposta' : `${count} respostes`),
            updatedAfterQuestion: 'Actualitzada després de la teva pregunta',
            reviewerUpdated: ({ reviewer }) => `${reviewer} ha actualitzat la troballa`,
            askPlaceholder: 'Fes una pregunta sobre aquesta troballa…',
            askReviewerPlaceholder: 'Fes una pregunta al revisor…',
            toReviewer: ({ reviewer }) => `Per a ${reviewer}`,
            followUpsGoTo: ({ reviewer }) => `Les preguntes van a ${reviewer}`,
            waitingForAnswer: ({ reviewer }) => `Esperant ${reviewer}…`,
            waitingForAnswers: 'Esperant els revisors…',
            both: 'Tots dos',
            reviewerCount: ({ count }) => `${count} revisors`,
            askReviewersPlaceholder: 'Fes una pregunta als revisors…',
            followUpsGoToAll: ({ count }) => (count === 2 ? 'Les preguntes van als dos revisors' : `Les preguntes van als ${count} revisors`),
            stillReviewing: 'Encara revisant',
            reviewerDidNotFinish: 'No ha acabat',
            reviewersNotStarted: ({ count }) => (count === 1 ? 'Un revisor no ha començat' : `${count} revisors no han començat`),
            reviewerNotStarted: ({ reviewer }) => `${reviewer} no ha pogut començar.`,
            notSaved: 'Aquesta troballa no s’ha desat, així que encara no pot rebre cap decisió.',
            decisionsUnavailable: 'No s’han pogut carregar les teves decisions.',
            followUpUnavailable: {
                notResumable: 'Aquesta revisió ha acabat; les preguntes necessiten una revisió que es mantingui oberta.',
                ended: 'Aquesta revisió no ha acabat bé, així que no admet preguntes.',
                resumeUnavailable: 'El revisor ja no és accessible en aquesta màquina.',
                busy: 'El revisor encara està ocupat. Torna-ho a provar d’aquí a un moment.',
                failed: 'No s’ha pogut enviar la pregunta.',
            },
        },
        launcher: {
            titles: { review: 'Demana una revisió', plan: 'Demana un pla', delegate: 'Delega una tasca' },
            descriptions: {
                review: ({ machine }) => `Cada agent revisa pel seu compte els canvis a ${machine}; aquí reps un resultat de cadascun.`,
                plan: ({ machine }) => `L’agent llegeix el codi a ${machine} i proposa un pla aquí. No canvia res.`,
                delegate: ({ machine }) => `L’agent treballa a ${machine} amb els permisos de sota i en dona compte aquí.`,
            },
            whatFor: 'Per a què',
            who: { review: 'Qui revisa', plan: 'Qui planifica', delegate: 'Qui ho fa' },
            selectedCount: ({ count }) => `${count} seleccionats`,
            focus: {
                review: 'En què s’han de centrar?',
                plan: 'Què ha de cobrir el pla?',
                delegate: 'Què ha de fer?',
            },
            optional: 'opcional',
            start: {
                review: ({ count }) => (count > 1 ? `Inicia ${count} revisions` : 'Inicia la revisió'),
                plan: 'Inicia el pla',
                delegate: 'Inicia la tasca',
            },
            runsOn: ({ machine }) => `S’executa a ${machine}`,
            checking: 'S’està comprovant quins agents poden funcionar aquí',
            unavailableTitle: 'Els agents no poden començar en aquesta sessió',
            unavailableReason: 'La seva màquina ara no ofereix revisions, plans ni tasques delegades.',
        },
    } } as const satisfies Pick<Record<string, RunPageTranslations>, "ca">;

return { runPageTranslations };
})();

const Domain_scmComparisonTranslations = (() => {
type ScmComparisonTranslations = Shared_scmComparisonTranslations.ScmComparisonTranslations;

const en = Shared_scmComparisonTranslations.en;

const translated = Shared_scmComparisonTranslations.translated;

const scmComparisonTranslations = { ca: {
        scmComparison: translated({
            view: { files: 'Fitxers', walkthrough: 'Recorregut', commits: 'Commits' },
            scope: {
                workingTree: 'Canvis pendents',
                session: 'Aquesta sessió',
                turn: 'Torn',
                latestTurn: 'Darrer torn',
                branch: ({ head, base }) => `${head} contra ${base}`,
                commit: ({ commit }) => `Commit ${commit}`,
            },
            tabTitle: ({ view, scope }) => `${view} · ${scope}`,
            since: ({ time }) => `des de les ${time}`,
            turnsWithChanges: ({ count }) => `${count} ${count === 1 ? 'torn' : 'torns'} amb canvis`,
            scopePicker: {
                a11y: 'Canvis a mostrar',
                branchChoice: 'Branca contra base',
                commitChoice: 'Commit',
                pullRequestChoice: 'Pull request',
                headRef: 'Branca o referència de capçalera',
                baseRef: 'Branca o referència base',
                parentRef: 'Referència pare (opcional)',
                explainAndCommit: 'Explicar i fer commit',
                explainOnly: 'Només explicar',
                unavailable: 'No disponible per a aquesta sessió',
                pendingDescription: 'Sense commit · pot proposar commits',
                sessionDescription: 'Tot el que ha canviat, inici → ara',
                turnDescription: 'En ordre, tal com ho ha fet l’agent',
                branchDescription: 'Canvis des de la base compartida',
                commitDescription: 'Canvis introduïts per aquest commit',
                pullRequestDescription: 'Canvis proposats per aquesta pull request',
            },
            fileCount: ({ count }) => `${count} ${count === 1 ? 'fitxer' : 'fitxers'}`,
            changeCount: ({ count }) => `${count} ${count === 1 ? 'canvi' : 'canvis'}`,
            changedFiles: 'Fitxers modificats',
            startReview: 'Inicia la revisió',
            proposeCommits: 'Proposa commits',
            explain: 'Explica',
            explainA11y: 'Explica: mostra les notes del recorregut al costat dels canvis',
            viewA11y: 'Vista',
            lockfileTag: 'Fitxer de bloqueig',
            generatedTag: 'Generat',
            lockfileCollapsed: 'Fitxer de bloqueig, plegat.',
            generatedCollapsed: 'Fitxer generat, plegat.',
            showDiff: 'Mostra les diferències',
            unsupportedReason: 'Fitxers encara no pot mostrar aquesta comparació. Els canvis continuen a Git.',
            showPendingChanges: 'Mostra els canvis pendents',
            capturedStale: 'L’origen ha canviat. Aquests fitxers conserven la comparació capturada.',
            capturedFreshnessUnknown: 'Es mostren els fitxers capturats. No s’ha pogut comprovar l’estat actual de l’origen.',
            keys: { nextFile: 'fitxer següent', nextChange: 'canvi següent' },
        }),
    } } as const;

return { scmComparisonTranslations };
})();

const Domain_secretsSettingsTranslations = (() => {
type SecretsSettingsCopy = Shared_secretsSettingsTranslations.SecretsSettingsCopy;

const en = Shared_secretsSettingsTranslations.en;

const ca: SecretsSettingsCopy = {
    purpose: 'Claus API i tokens que fan servir els teus agents i servidors MCP. Un valor no es torna a mostrar després de desar-lo.',
    yoursTitle: 'Els teus secrets',
    yoursDescription: 'Secrets que has desat o que són teus. Tria’ls allà on Happier demani una clau.',
    sharedWithYouTitle: 'Compartits amb tu',
    sharedWithYouDescription: 'Altres persones et permeten fer-los servir. Els pots triar, però no veure’ls ni canviar-los.',
    add: 'Afegeix un secret',
    newSecret: 'Secret nou',
    emptyTitle: 'Encara no hi ha secrets',
    emptyDescription: 'Afegeix una clau API o un token una vegada i tria’l allà on Happier en demani un.',
    staleTitle: 'No s’han pogut actualitzar els secrets compartits',
    staleDescription: 'Es mostra l’última llista coneguda.',
    valueTitle: 'Valor',
    valueSaved: 'Desat. No es torna a mostrar mai.',
    keepTitle: 'Desa’l com a',
    keepPersonal: 'Personal',
    keepShared: 'Compartit',
    keepPersonalDescription: 'Es desa al teu compte. Només tu el pots fer servir.',
    keepSharedDescription: 'Es desa en aquest Home perquè el puguis compartir amb persones, Teams o Grups.',
    accessTitle: 'Qui el pot fer servir',
    accessOnlyYou: 'Només tu',
    accessRecipients: ({ count }: { count: number }) => (count === 1 ? 'Tu i 1 destinatari' : `Tu i ${count} destinataris`),
    sharePersonalDescription: 'Compartir-lo el mou a aquest Home. No pot tornar a ser personal.',
    share: 'Comparteix',
    manage: 'Gestiona',
    storageTitle: 'Emmagatzematge',
    storageE2ee: 'Xifrat d’extrem a extrem',
    storageE2eeDescription: 'Només les persones amb qui el comparteixes el poden llegir.',
    storagePlain: 'Gestionat pel Home',
    storagePlainDescription: 'Aquest Home el desa i el pot llegir per lliurar-lo.',
    save: 'Desa el secret',
};

const secretsSettingsTranslations = { ca } as const;

return { secretsSettingsTranslations };
})();

const Domain_sessionAccessTranslations = (() => {
const sessionAccessTranslations = { "ca": {
        withContext: ({ context, label }: { context: string; label: string }) => `${context} · ${label}`,
        withCount: ({ label, count }: { label: string; count: number }) => `${label} +${count}`,
        accessibleSummary: ({ title, label }: { title: string; label: string }) => `${title}: ${label}`,
        accessibleControl: ({ name, control, value }: { name: string; control: string; value: string }) => `${name}, ${control}, ${value}`,
        title: "Accés a la sessió",
        search: "Cerca persones, grups o equips",
        hasAccess: "Té accés",
        yourAccess: "El teu accés",
        readOnly: "Pots consultar com tens accés. Només els administradors de la sessió poden fer canvis.",
        sourceDirect: "Accés directe",
        sourceTeam: "Accés mitjançant un equip",
        sourceGroup: "Accés mitjançant un grup",
        people: "Persones",
        groups: "Grups",
        teams: "Equips",
        account: "Persona",
        group: "Grup",
        team: "Equip",
        view: "Pot veure",
        edit: "Pot dirigir",
        admin: "Administrar",
        owner: "Propietari",
        private: "Privada",
        custom: "Accés personalitzat",
        required: "Obligatori per la política de l’equip",
        subjectNotFound: "Aquesta persona, grup o equip ja no està disponible.",
        subjectIneligible: "Aquesta persona, grup o equip ja no pot rebre accés.",
        teamPolicyRequired: "La política de l’equip exigeix aquest accés.",
        selfGrantManaged: "Un altre gestor d’accés ha de canviar el teu accés.",
        homeUnsupported: "Aquest Home encara no admet l’accés a sessions. Actualitza’l per gestionar qui pot obrir aquesta sessió.",
        openCollaboration: "Obre Col·laboració",
        authenticationRequired: "Inicia la sessió amb un mètode acceptat per aquest equip i torna-ho a provar.",
        authenticationUnavailable: "El mètode d’inici de sessió exigit per aquest equip no està disponible en aquest Home.",
        delegation: "Pot aprovar sol·licituds de permisos d’execució",
        remove: "Retira l’accés",
        confirmRemove: "Confirma la retirada",
        credentialsLost: ({ names }: { names: string }) => `Aquestes credencials de l’equip deixaran de funcionar aquí: ${names}`,
        ready: "Accés xifrat preparat",
        prepared: "Accés xifrat preparat",
        recipientRepairRequired: "Aquesta persona ha de reparar la configuració del xifratge del seu compte.",
        pending: "Accés xifrat pendent",
        setup: "Cal configurar el xifratge",
        repair: "Cal reparar l’accés xifrat",
        unavailable: "Contingut xifrat no disponible",
        notRequired: "Aquesta sessió no està xifrada, així que no cal preparar res.",
        preparing: "S’està preparant l’accés xifrat…",
        preparingProgress: ({ count }: { count: number }) => `S’està preparant l’accés xifrat… ${count} preparats`,
        preparationPending: ({ count }: { count: number }) => `Accés xifrat pendent per a ${count} persones`,
        preparationSetup: ({ count }: { count: number }) => `${count} persones han de configurar el xifratge`,
        preparationRepair: ({ count }: { count: number }) => `L’accés xifrat necessita reparació per a ${count} persones`,
        preparationKeyUnavailable: "Aquest dispositiu no pot preparar l’accés xifrat per a aquesta sessió.",
        preparationFailed: "L’accés s’ha desat, però la preparació de l’accés xifrat ha fallat.",
        preparationPassFailed: "La preparació de l’accés xifrat ha fallat.",
        preparationAnnouncedComplete: "Preparació de l’accés xifrat completada.",
        preparationAnnouncedNeedsAttention: "L’accés xifrat encara necessita configuració o reparació.",
        preparationCheckFailed: "No s’ha pogut comprovar l’accés xifrat.",
        outcomeUnknown: "El resultat és incert. Happier està comprovant l’accés actual abans que ho torneu a provar.",
        historicalLayoutNotice: "Les persones amb qui compartiu aquesta sessió no la poden obrir fins que s’actualitzi per a aquesta versió de Happier.",
        historicalLayoutUpdate: "Actualitza per compartir",
        homeReconciled: "S’ha restablert l’accés a la sessió per al Home nou.",
        lockedTitleFallback: "Sessió xifrada",
        encryptedAccess: "Accés xifrat",
        aggregatePrepared: ({ count }: { count: number }) => `${count} preparats`,
        aggregatePending: ({ count }: { count: number }) => `${count} pendents`,
        aggregateNeedsAttention: ({ count }: { count: number }) => `${count} necessiten configuració o reparació`,
        prepareNow: "Prepara ara",
        prepareAgain: "Prepara-ho de nou",
        preparingProgressOf: ({ count, total }: { count: number; total: number }) => `S’està preparant l’accés xifrat… ${count} de ${total}`,
        showAllRecipients: "Mostra totes les persones",
        hideAllRecipients: "Amaga les persones",
        moreRecipients: "Mostra més persones",
        recipientPlainAccount: "Compte sense xifratge",
        pendingBody: "Aquesta sessió és xifrada. Qui l’administra encara ha de preparar el teu accés xifrat abans que s’obri aquí.",
        setupBody: "Acaba la configuració del xifratge en aquest compte i després qui l’administra podrà preparar el teu accés a aquesta sessió.",
        setupAction: "Configura el xifratge",
        repairBody: "La clau lliurada per a aquesta sessió no s’ha pogut obrir en aquest dispositiu. Torna-ho a provar o demana a qui administra la sessió que prepari l’accés una altra vegada.",
        retryAction: "Torna-ho a provar",
        unavailableBody: "La clau s’ha obert, però el contingut d’aquesta sessió no s’ha pogut desxifrar. Qui administra la sessió pot preparar l’accés una altra vegada.",
        openAccessAction: "Obre l’accés a la sessió",
        removedTitle: "Accés retirat",
        removedBody: "No pots obrir aquesta sessió amb el teu accés actual. Qui administra la sessió pot compartir-la una altra vegada.",
        removedAnnouncement: ({ name }: { name: string }) => `${name} retirat de l’accés a la sessió`,
        browseMore: "Explora-ho tot",
        allLoaded: "Tots els resultats carregats",
        help: "Pot veure permet llegir. Pot dirigir permet dirigir l’Agent segons els permisos de les eines. Administrar també gestiona l’accés. No és un xat aïllat: la carpeta de treball i el nom de l’autor no limiten l’accés a l’intèrpret d’ordres, als fitxers o a la xarxa."
    } } as const;

return { sessionAccessTranslations };
})();

const Domain_sessionAgentActivityTranslations = (() => {
const en = Shared_sessionAgentActivityTranslations.en;

const ca: typeof en = {
    status: {
        queued: 'En cua',
        starting: 'Iniciant',
        running: 'En execució',
        waiting: 'Esperant',
        blocked: 'Bloquejat',
        succeeded: 'Completat',
        failed: 'Ha fallat',
        timedOut: 'Temps esgotat',
        cancelled: 'Aturat',
        unknown: 'Desconegut',
    },
    attention: {
        permission: 'Cal aprovació',
        userAction: 'Cal la teva resposta',
        both: 'Necessita atenció',
        bothDescription: 'Cal aprovació i cal la teva resposta',
    },
    runKind: {
        conversation: 'Conversa',
        review: 'Revisió',
        plan: 'Pla',
    },
    /** The Agents pane: its "+", its states, its team groups and its live line (agents lab). */
    roster: {
        teamLabel: ({ team, count }) => `Equip ${team} · ${count} ${count === 1 ? 'agent' : 'agents'}`,
        teamActionsA11y: 'Accions de l’equip',
        openWork: 'Obre',
        needsYouCount: ({ count }) => `${count} et necessiten`,
        runningCount: ({ count }) => `${count} en execució`,
        nothingRunning: 'No hi ha res en execució.',
        startAgent: 'Inicia un agent',
        machineOffline: ({ machine }) => `${machine} no respon`,
        machineOfflineUnnamed: 'La màquina no respon',
        launch: {
            menuA11y: 'Inicia un agent',
            conversationDescription: 'Parla amb un agent al costat d’aquesta sessió',
            reviewDescription: 'Revisa els canvis fins ara',
            planDescription: 'Planifica els passos següents',
            delegateDescription: 'Delega una tasca i recupera-la feta',
            advancedDescription: 'Tria agents, permisos i perfil',
        },
        empty: {
            title: 'Posa més agents en aquesta sessió',
            reason: ({ machine }) => `Comença una conversa paral·lela, o demana una revisió o un pla mentre continues treballant. S’executen a ${machine} i t’informen aquí.`,
            reasonUnnamed: 'Comença una conversa paral·lela, o demana una revisió o un pla mentre continues treballant. T’informen aquí.',
            moreWays: 'Demana una revisió, un pla o una delegació',
        },
        unavailable: {
            notEnabled: 'Els agents no es poden iniciar en aquesta Home.',
            machineOffline: ({ machine }) => `Per iniciar agents cal que ${machine} estigui en línia.`,
            machineOfflineUnnamed: 'Per iniciar agents cal que aquesta màquina estigui en línia.',
            sessionInactive: 'Aquesta sessió s’ha aturat. Reprèn-la per iniciar agents aquí.',
            externalRunnerInactive: 'Aquesta sessió es va iniciar fora de Happier. Els agents es poden iniciar des d’aquí mentre Happier hi estigui connectat.',
        },
    },
    summaryA11y: ({ title, status }) => `${title}, ${status}`,
    summaryAttentionA11y: ({ title, status, attention }) => `${title}, ${status}, ${attention}`,
};

const sessionAgentActivityTranslations = { ca };

return { sessionAgentActivityTranslations };
})();

const Domain_sessionBoardTranslations = (() => {
type SessionBoardStateTranslation = Shared_sessionBoardTranslations.SessionBoardStateTranslation;

type SessionBoardTranslation = Shared_sessionBoardTranslations.SessionBoardTranslation;

const sessionBoardTranslations = { ca: {
        title: 'Tauler',
        views: {
            label: 'Vistes del tauler',
            overview: 'Resum',
            createTitle: 'Nova vista del tauler',
            renameTitle: 'Canvia el nom de la vista del tauler',
            reconciled: ({ title }) => `Aquesta vista del tauler s’ha eliminat. Es mostra ${title}.`,
            empty: {
                title: 'Res en aquesta vista',
                reason: 'Afegeix-hi un widget o canvia a una altra vista del tauler.',
            },
            actions: {
                create: 'Nova vista',
                rename: 'Canvia el nom de la vista',
                moveBefore: 'Mou la vista abans',
                moveAfter: 'Mou la vista després',
                remove: 'Elimina la vista',
            },
            remove: {
                title: ({ title }) => `Vols eliminar «${title}»?`,
                moveMessage: ({ title }) => `Els seus widgets passen a ${title}. No s’elimina res de la sessió.`,
                unpinMessage: 'Els seus widgets continuen a la sessió, però ja no estan fixats a cap vista.',
            },
        },
        add: { note: 'Nota', interactiveView: 'Vista interactiva' },
        width: { compact: 'Estret', medium: 'Mitjà', wide: 'Ample', full: 'Amplada completa' },
        height: { auto: 'Ajusta al contingut', compact: 'Baixa', regular: 'Mitjana', tall: 'Alta' },
        board: {
            loading: { title: 'Obrint el tauler', reason: 'Carregant el que hi ha fixat en aquesta sessió.' },
            locked: {
                title: 'El tauler encara està xifrat',
                reason: 'Aquest dispositiu encara no pot obrir la sessió. No s’ha perdut res.',
            },
            unopenable: {
                title: 'No es pot llegir l’organització del tauler',
                reason: 'L’organització desada no s’ha pogut obrir. Els ginys no en queden afectats.',
            },
            unsupported: {
                title: 'Aquest tauler necessita un Happier més recent',
                reason: 'Tot es conserva. Obre’l en un dispositiu compatible o actualitza el Happier.',
            },
            unavailable: {
                title: 'El tauler encara no està disponible aquí',
                reason: 'No s’ha perdut res. Apareixerà quan aquest Home activi els taulers.',
            },
            offline: 'Sense connexió: veus l’última versió que has carregat.',
            offlineEmpty: 'Sense connexió: torna a connectar-te per carregar aquest tauler.',
            stale: 'Veus l’última versió que has carregat.',
        },
        empty: {
            editor: {
                title: 'Tingues el pla al costat del xat',
                description: 'Les notes i vistes en directe fixades aquí es queden amb aquesta sessió, per a tothom qui la pugui llegir.',
                askAgent: 'Demana-ho a l’agent',
                askAgentPrompt: 'Posa en aquest tauler alguna cosa que mostri ',
                addNote: 'Afegeix una nota',
            },
            viewer: {
                title: 'Encara no hi ha res al tauler',
                description: 'Aquí apareixerà tot el que les persones o els agents fixin en aquesta sessió.',
            },
        },
        item: {
            untitled: 'Giny sense títol',
            renameA11y: 'Títol del giny',
            reorderA11y: ({ title }) => `Reordena ${title}`,
            a11yLabelWithWidth: ({ title, width }) => `${title}, ${width}`,
            menuGroups: { content: 'Llegeix i edita', movement: 'Moviment', geometry: 'Mida', destructive: 'Elimina' },
            loading: { title: 'Carregant aquest giny', reason: 'Obtenint-ne el contingut d’aquest Home.' },
            locked: {
                title: 'Contingut xifrat no disponible',
                reason: 'Aquest giny continua xifrat fins que el dispositiu pugui obrir la sessió.',
            },
            unopenable: {
                title: 'No es pot mostrar aquest giny',
                reason: 'No s’ha pogut llegir el contingut desat. La resta del tauler continua disponible.',
            },
            unsupported: {
                title: 'Aquest giny necessita un Happier més recent',
                reason: 'El contingut es conserva. Obre’l en un dispositiu compatible o actualitza el Happier.',
            },
            missing: {
                title: 'No es troba aquest giny',
                reason: 'El tauler encara hi apunta, però el contingut no és en aquest Home.',
            },
            removed: {
                title: 'Aquest giny s’ha tret del tauler',
                reason: 'Algú amb permís d’edició l’ha esborrat per a tothom.',
            },
            pluginUnavailable: {
                title: 'Plugin no disponible en aquest dispositiu',
                reason: 'El giny es conserva. Tornarà a mostrar-se quan el plugin hi sigui disponible.',
            },
            rendererUnavailable: {
                title: 'No es pot mostrar aquest giny en aquest dispositiu',
                reason: 'El contingut es conserva. Obre’l on les vistes interactives siguin compatibles.',
            },
            provenance: {
                note: 'Nota',
                interactiveView: 'Vista interactiva',
                pluginMissing: ({ pluginId }) => `De ${pluginId} · no instal·lat`,
                pluginSurface: ({ plugin, surface }) => `${surface} · ${plugin}`,
                pluginQualified: ({ label, pluginId }) => `${label} (${pluginId})`,
            },
            actions: {
                remove: 'Treu del tauler',
                openHere: 'Obre aquí',
                managePlugin: 'Gestiona el plugin',
                prepareEncryption: 'Configura el xifratge',
                readFull: 'Llegeix tota la nota',
                rename: 'Canvia el nom del giny',
                unpin: 'Treu d’aquesta vista',
                moveToView: ({ title }) => `Mou a ${title}`,
            },
            moved: {
                before: ({ title }) => `${title} s’ha mogut abans.`,
                after: ({ title }) => `${title} s’ha mogut després.`,
                reordered: ({ title }) => `${title} s’ha mogut.`,
                toView: ({ title, view }) => `${title} s’ha mogut a ${view}.`,
            },
            movePosition: ({ position, total }) => `Posició ${position} de ${total}`,
            moveTargetView: ({ title }) => `Vista del tauler ${title}`,
            remove: {
                title: 'Vols treure aquest widget?',
                message: 'El perd tothom que pugui llegir aquesta sessió. Els plugins instal·lats continuen instal·lats.',
            },
        },
        note: {
            titlePlaceholder: 'Títol',
            titleA11y: 'Títol de la nota',
            untitled: 'Nota sense títol',
            offline: 'Per desar cal connexió amb aquest Home.',
            unavailable: 'Els canvis al tauler encara no estan disponibles en aquest Home.',
            failed: 'El Happier no ha pogut desar aquesta nota. El teu text continua aquí.',
            outcomeUnknown: 'El Happier no ha pogut confirmar si la nota s’ha desat. Actualitza abans de tornar-hi.',
            saved: 'Nota desada',
            conflict: {
                message: 'Aquesta nota ha canviat en un altre dispositiu.',
                reviewLatest: 'Mira l’última versió',
                applyMine: 'Aplica els meus canvis',
                latestHeading: 'Última versió',
            },
        },
        recovered: {
            title: 'Elements recuperats',
            description: 'Aquests widgets són a la sessió però no apareixen en cap vista del tauler.',
            pin: 'Afegeix a aquesta vista',
        },
        mutation: {
            conflict: 'Aquest tauler ha canviat en un altre dispositiu. Actualitza per veure’n la darrera versió.',
            outcomeUnknown: 'Happier no ha pogut confirmar si el canvi s’ha desat.',
            denied: 'Ja no tens permís per canviar aquest tauler.',
            offline: 'Canviar el tauler necessita connexió amb aquest Home.',
            unavailable: 'Aquest Home encara no pot canviar el tauler.',
            updateRequired: 'Actualitza Happier per fer aquest canvi al tauler.',
            hostedHtmlSourceTooLarge: 'Aquesta vista interactiva és massa gran per desar-la. El teu esborrany continua aquí.',
            noteTooLarge: 'Aquesta nota és massa gran per desar-la. El teu text continua aquí.',
            invalid: 'Aquest canvi al tauler no és vàlid. Revisa’l i torna-ho a provar.',
            notFound: 'Aquest element ja no està disponible. Actualitza el tauler.',
            storageFailed: 'Happier no ha pogut protegir aquest canvi. La teva feina continua aquí.',
            serverFailed: 'Aquest Home no ha pogut completar el canvi. Torna-ho a provar.',
            failed: 'Happier no ha pogut aplicar aquest canvi al tauler.',
        },
        hostedHtmlApproval: {
            title: 'Voleu permetre aquesta vista interactiva?',
            body: 'L’aprovació s’aplica a aquesta vista en aquesta sessió. Per enviar un missatge encara cal fer clic dins de la vista.',
            resources: ({ count }) => (count === 1 ? 'Pot llegir 1 recurs de la sessió' : `Pot llegir ${count} recursos de la sessió`),
            actions: ({ count }) => (count === 1 ? 'Pot executar 1 acció' : `Pot executar ${count} accions`),
            sendMessages: 'Pot demanar a Happier que enviï missatges',
            loadsFrom: ({ origin }) => `Es carrega des de ${origin}`,
            allow: 'Permet',
            notNow: 'Ara no',
            declined: {
                title: 'Vista interactiva encara no permesa',
                reason: 'Revisa què demana quan vulguis.',
                review: 'Revisa',
            },
        },
        sidebar: {
            openInDetails: 'Obre als detalls',
            openBoard: 'Obre el tauler',
            sharedWithEveryone: 'Compartit amb tothom aquí',
            widgetCount: ({ count }) => `${count} giny${count === 1 ? '' : 's'}`,
        },
        mobile: { searchPlaceholder: 'Cerca en aquest tauler' },
        inline: {
            openBoard: 'Obre el tauler',
            openBoardA11y: ({ title }) => `Obre «${title}» al tauler`,
        },
        companion: {
            title: 'Acompanyant',
            inCompanionA11y: 'Al teu acompanyant',
            empty: {
                title: 'Mantén la sessió a la vista',
                reason: 'Posa el resum de la sessió o un widget del tauler al costat del xat: què s’executa, què t’espera, què ha canviat.',
                note: 'Només tu veus el teu acompanyant.',
            },
            pane: {
                besideChat: 'Al costat del teu xat',
                itemCount: ({ count }: { count: number }) => count === 1 ? '1 element' : `${count} elements`,
                justForYou: 'Només per a tu, al costat del xat',
            },
            actions: {
                addSummary: 'Afegeix el resum de la sessió',
                addItem: ({ title }) => `Afegeix ${title}`,
                moveToLeading: 'Mou a la banda esquerra',
                moveToTrailing: 'Mou a la banda dreta',
                moveToFirst: 'Mou al principi',
                moveToLast: 'Mou al final',
                compact: 'Mida compacta',
                comfortable: 'Mida còmoda',
                openFull: 'Obre l’acompanyant complet',
                openOnBoard: 'Obre al tauler',
                collapse: 'Replega l’acompanyant',
                expand: 'Desplega l’acompanyant',
                hide: 'Amaga l’acompanyant',
                addToCompanion: 'Afegeix a l’acompanyant',
                removeFromCompanion: 'Treu de l’acompanyant',
                undo: 'Desfés',
                menuA11y: 'Opcions de l’acompanyant',
                itemMenuA11y: ({ title }) => `Opcions per a ${title}`,
            },
            a11y: {
                headerAction: ({ count }) => `Acompanyant, ${count} elements`,
                show: ({ count }) => `Mostra l’acompanyant, ${count} elements`,
                expand: ({ count }) => `Desplega l’acompanyant, ${count} elements`,
            },
            summary: {
                review: 'Revisa',
                title: 'Resum de la sessió',
                untitled: 'Sessió',
                approvals: ({ count }) => `${count} t’esperen`,
                workflows: ({ count }) => `${count} fluxos en curs`,
                changedFiles: ({ count }) => `${count} canviats`,
                tokens: ({ count }) => `${count} tokens`,
                contextPercent: ({ percent }) => `${percent} % de context`,
                contextOnly: 'Context utilitzat',
                moreDetails: 'Més detalls',
                moreDetailsA11y: ({ count }) => `Més detalls, ${count} files més`,
                partial: 'Alguns detalls no es veuen des d’aquí.',
            },
            notices: {
                shown: 'Acompanyant mostrat',
                hidden: 'Acompanyant amagat',
                added: 'Afegit a l’acompanyant',
                removed: 'Tret de l’acompanyant',
                reordered: 'Acompanyant reordenat',
                moved: 'Acompanyant mogut',
                boardOpened: 'L’agent ha obert el tauler',
                returnedToChat: 'L’agent ha tornat al xat',
                boardViewSelected: 'L’agent ha seleccionat una vista del tauler',
                boardItemRevealed: 'L’agent ha obert un element del tauler',
                fullOpened: 'L’agent ha obert l’acompanyant',
            },
        },
    } } as const satisfies Pick<Readonly<Record<string, SessionBoardTranslation>>, "ca">;

return { sessionBoardTranslations };
})();

const Domain_sessionCollaborationPaneTranslations = (() => {
type PaneCopy = Shared_sessionCollaborationPaneTranslations.PaneCopy;

const en = Shared_sessionCollaborationPaneTranslations.en;

const sessionCollaborationPaneTranslations: Pick<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', PaneCopy>, "ca"> = { ca: {
        hereOne: ({ name }) => `${name} és aquí`,
        hereTwo: ({ first, second }) => `${first} i ${second} són aquí`,
        hereMany: ({ first, count }) => `${first} i ${count.toLocaleString()} persones més són aquí`,
        typingOne: ({ name }) => `${name} està escrivint…`,
        typingMany: ({ count }) => `${count.toLocaleString()} persones estan escrivint…`,
        justYouHere: 'Només hi ets tu',
        justYouHint: 'Les persones amb qui el comparteixis apareixeran aquí',
        you: 'Tu',
        presenceConnecting: 'Comprovant qui hi ha…',
        presenceUnavailable: 'La presència en directe no respon ara mateix',
        presenceUnsupported: 'La presència en directe no està disponible en aquesta Home',
        responsibleUnsupported: 'Aquesta Home no registra qui n’és responsable',
        inviteTitle: 'Parleu-ne al costat de la sessió',
        inviteBody: 'Comença una conversa, menciona persones i passa la resposta a l’agent quan estiguis a punt.',
        readOnly: 'Pots llegir-les. Les persones que poden editar aquesta sessió hi poden escriure.',
        offline: 'Estàs fora de línia · es mostren les últimes converses',
        lockedTitle: 'Encara no es poden obrir aquestes converses en aquest dispositiu',
        lockedBody: 'Estan xifrades d’extrem a extrem, i la configuració de xifratge d’aquest dispositiu no coincideix amb la de la sessió.',
        revokedTitle: 'Ja no tens accés a aquestes converses',
        revokedBody: 'Algú que gestiona aquesta sessió ha canviat qui la pot veure. Els missatges que vas escriure es queden amb la sessió.',
        namesTwo: ({ first, second }) => `${first} i ${second}`,
        namesThree: ({ first, second, third }) => `${first}, ${second} i ${third}`,
        namesMore: ({ first, second, count }) => `${first}, ${second} i ${count.toLocaleString()} més`,
        haveAccess: 'Hi tenen accés',
        hasAccess: 'Hi té accés',
        onlyYou: 'Només tu',
        notShared: 'Encara no s’ha compartit amb ningú',
        publicLinkOn: 'Enllaç públic activat',
        accessLoading: 'Comprovant qui hi té accés…',
        accessError: 'No s’ha pogut carregar qui hi té accés',
        shareTitle: 'Comparteix aquesta sessió',
        shareBody: ({ home }) => `Les persones que afegeixis a ${home} poden seguir-la i unir-se a les converses.`,
        collapse: 'Redueix',
        linkOn: 'Activat',
        linkOff: 'Desactivat',
        linkGrants: 'Qualsevol persona amb l’enllaç pot veure la transcripció, sense compte.',
        linkExpires: ({ date }) => `Caduca el ${date}`,
        linkNeverExpires: 'No caduca mai',
        linkAsksConsent: 'demana consentiment',
        linkNoConsent: 'sense pas de consentiment',
        linkHidden: 'Aquest enllaç es va crear abans i no es pot tornar a mostrar. Crea’n un de nou per copiar-lo.',
        qrCode: 'Codi QR',
        hideQrCode: 'Amaga el codi QR',
        newLink: 'Enllaç nou…',
        turnOff: 'Desactiva',
        turnOffTitle: 'Vols desactivar l’enllaç públic?',
        turnOffBody: 'Qui tingui l’enllaç en perdrà l’accés immediatament. Més endavant pots crear-ne un de nou.',
        newLinkReplaces: 'L’enllaç actual deixarà de funcionar quan es creï el nou.',
        linkDenied: 'Només les persones que gestionen aquesta sessió poden crear un enllaç públic.',
        linkLoadFailed: 'No s’ha pogut comprovar l’enllaç públic.',
        justYouTitle: 'Treballeu junts en aquesta sessió',
        justYouBody: ({ home }) => `Comparteix-la amb persones de ${home}. Podran seguir-la, parlar-ne aquí i continuar-la mentre no hi siguis.`,
        share: 'Comparteix',
        justYouNote: 'O crea un enllaç públic que pugui veure qualsevol.',
        sharingOffTitle: ({ home }) => `${home} no comparteix sessions amb persones`,
        sharingOffBody: 'Encara pots crear un enllaç públic que pugui veure qualsevol.',
        sharingOffPrivateBody: 'Les sessions d’aquesta Home es queden amb tu.',
        accessDenied: 'Només les persones que gestionen aquesta sessió poden canviar qui hi té accés. Tu encara pots unir-te a les converses.',
    } };

return { sessionCollaborationPaneTranslations };
})();

const Domain_sessionCollaborationTranslations = (() => {
const sessionCollaborationPaneTranslations = {...Domain_sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations, ...EnglishFeatures.sessionCollaborationPaneTranslations.sessionCollaborationPaneTranslations};

const en = Shared_sessionCollaborationTranslations.en;

const sessionCollaborationTranslations: Pick<Record<'en'|'ca'|'de'|'es'|'fr'|'it'|'ja'|'pl'|'pt'|'ru'|'zh-Hans'|'zh-Hant', typeof en>, "ca"> = { ca: { pane: sessionCollaborationPaneTranslations['ca'], title: 'Col·laboració', viewingNow: 'Veient ara', justYou: 'Només tu', typing: 'Escrivint…', stale: 'Pot estar desactualitzat', unavailable: 'Presència en directe no disponible', connecting: 'Connectant…', unnamed: 'Membre de Happier', open: 'Obre la col·laboració', conversations: 'Converses', accessUnavailable: 'Accés a la sessió no disponible', accessUnavailableReason: 'Aquest Home no admet compartir sessions amb persones.', discussion: { featureUnavailable: "Les converses no estan activades en aquest Home.", bindingUnavailable: "Torna a iniciar sessió en aquest Home per veure les converses.", scopeMismatch: "Aquestes converses pertanyen a un altre compte d’aquest Home.", modeMismatch: "El contingut no coincideix amb el mode de xifratge de la sessió. Torna-ho a provar o demana a qui la gestiona que revisi l’accés.",  title: 'Converses', newDiscussion: 'Conversa nova', create: 'Crea la conversa', titlePlaceholder: 'Títol de la conversa', messagePlaceholder: 'Escriu un missatge…', active: 'Actives', activeDisclosure: 'Mostra les converses actives', archived: 'Arxivades', archivedDisclosure: 'Mostra les converses arxivades', emptyActive: 'Encara no hi ha converses actives.', emptyArchived: 'No hi ha converses arxivades.', loading: 'Carregant les converses…', loadError: 'No s’han pogut carregar les converses.', retry: 'Torna-ho a provar', checking: 'Comprovant si hi ha novetats…', deliveryUnknown: 'No se sap si s’ha lliurat — comprova-ho abans de tornar-ho a provar.', locked: 'Pots llegir aquesta conversa, però no hi pots publicar.', offline: 'No tens connexió. Torna a connectar-te per continuar.', unavailable: 'Aquesta conversa no està disponible.', unreadCount: ({ count }) => count === 1 ? '1 sense llegir' : `${count.toLocaleString()} sense llegir`, unreadMentionCount: ({ count }) => count === 1 ? '1 menció sense llegir' : `${count.toLocaleString()} mencions sense llegir`,
        mentioned: 'T’han mencionat', unreadConversations: 'Converses sense llegir', messageCount: ({ count }) => count === 1 ? '1 missatge' : `${count.toLocaleString()} missatges`, viaAgent: 'Via Agent', collaborator: 'Col·laborador', contentUnavailable: 'Missatge no disponible', rename: 'Canvia el nom de la conversa', archive: 'Arxiva la conversa', restore: 'Restaura la conversa', selection: { copy: 'Copia', askAgent: 'Pregunta a l’Agent', sendToSession: 'Envia a la sessió', handoffError: 'No s’han pogut afegir els missatges seleccionats al redactor de la sessió.' }, titleRequired: 'Afegeix un títol per començar aquesta conversa.', encryptedTitle: 'Conversa xifrada', archivedNotice: 'Aquesta conversa està arxivada.', sessionArchived: 'Aquesta sessió està arxivada.', postDenied: 'Ja no pots publicar en aquesta sessió.', invalidMention: 'Algú que has mencionat ja no pot llegir aquesta sessió.', invalidContent: 'Aquest missatge no es pot enviar tal com està. Pot ser buit o massa llarg.', idempotencyConflict: 'Ja s’ha enviat un missatge diferent amb aquesta identitat.', sendFailed: 'No s’ha pogut enviar aquest missatge.', dismiss: 'Descarta', loadOlder: 'Carrega missatges anteriors', loadMore: 'Carrega més converses' } } };

return { sessionCollaborationTranslations };
})();

const Domain_sessionCompanionTranslations = (() => {
type SessionCompanionTranslations = Shared_sessionCompanionTranslations.SessionCompanionTranslations;

const sessionCompanionTranslations = { ca: {
        status: {
            waitingForYou: 'Et toca a tu',
            pausedBeforeStep: ({ agent, step, total }) => `${agent} s’ha aturat abans del pas ${step} de ${total}`,
            stepOfPlan: ({ step, total }) => `Pas ${step} de ${total} del pla`,
            agentFallback: 'L’agent',
        },
        ask: {
            question: ({ summary }) => `${summary}?`,
            allow: 'Permet',
            deny: 'Denega',
            showInChat: 'Mostra al xat',
            moreWaiting: ({ count }) => `${count} més en espera`,
            allowed: ({ summary }) => `Permès: ${summary}`,
            denied: ({ summary }) => `Denegat: ${summary}`,
            justNow: 'ara mateix',
            failed: 'La teva resposta no ha arribat a la sessió. Torna-ho a provar.',
            answerWhenBack: ({ machine }) => `Podràs respondre quan ${machine} torni.`,
            answerWhenSessionBack: 'Podràs respondre quan la sessió torni.',
            notAllowed: 'Només qui pot executar aquesta sessió pot respondre.',
            groupA11y: 'Et toca a tu',
        },
        facts: {
            subagents: 'subagents',
            changed: 'canviats',
            context: 'context',
            subagentsValue: ({ live, total }) => (live > 0 ? `${live} de ${total}` : `${total}`),
            contextValue: ({ percent }) => `${percent}%`,
            opensAgents: 'Obre Agents',
            opensGit: 'Obre Git',
            opensUsage: 'Obre l’ús',
        },
        plan: {
            title: 'Pla',
            description: ({ agent }) => `La llista de tasques de ${agent} per a aquesta sessió`,
            progress: ({ done, total }) => `${done} de ${total}`,
            progressA11y: ({ done, total }) => `${done} de ${total} fets`,
            emptyTitle: 'Encara no hi ha pla',
            emptyReason: 'Quan l’agent escrigui una llista de tasques, apareixerà aquí, pas a pas.',
            stepDone: 'Fet',
            stepCurrent: 'Pas actual',
        },
        picker: {
            open: 'Afegeix a l’Acompanyant',
            chooseWidget: 'Tria un giny…',
            onTheBoard: ({ source }) => `${source} · al tauler`,
        },
        drop: { keepBesideChat: 'Tingues-ho al costat del xat' },
        freshness: { machineOffline: ({ machine }) => `${machine} està fora de línia` },
        needsYouA11y: ({ count }) => `Acompanyant, ${count} t’esperen`,
    } } as const satisfies Pick<Readonly<Record<string, SessionCompanionTranslations>>, "ca">;

return { sessionCompanionTranslations };
})();

const Domain_sessionConversationSurfaceTranslations = (() => {
const en = Shared_sessionConversationSurfaceTranslations.en;

const ca: typeof en = {
    discussion: {
        loadingTitle: 'Obrint aquesta conversa…',
        offlineTitle: 'Aquesta conversa no està disponible sense connexió',
        offlineReason: 'Torna a connectar-te i s’obrirà on la vas deixar.',
        errorTitle: 'No s’ha pogut obrir aquesta conversa',
        lockedTitle: 'Encara no es pot obrir aquesta conversa en aquest dispositiu',
        lockedReason: 'Està xifrada d’extrem a extrem, i la configuració de xifratge d’aquest dispositiu no coincideix amb la de la sessió.',
        revokedTitle: 'Ja no tens accés a aquesta conversa',
        revokedReason: 'Aquesta sessió ja no es comparteix amb tu. Els missatges que vas escriure es queden a la sessió.',
        unavailableTitle: 'Les converses no estan disponibles aquí',
        closeTab: 'Tanca la pestanya',
    },
    draft: {
        leadTitle: 'Pregunta-ho a un agent',
        leadBody: 'S’executa com una conversa pròpia al costat de la sessió, amb aquests missatges com a context. No comença res fins que no l’enviïs.',
    },
    context: {
        fromConversation: ({ title, count }) => `De ${title} · ${count === 1 ? '1 missatge' : `${count} missatges`}`,
        fromUntitled: ({ count }) => `D’una conversa · ${count === 1 ? '1 missatge' : `${count} missatges`}`,
    },
    origin: {
        fromConversation: ({ title }) => `de ${title}`,
        fromUntitled: 'd’una conversa',
    },
    run: {
        details: 'Detalls de l’execució',
        loadingTitle: 'Obrint aquesta conversa amb l’agent…',
        errorTitle: 'No s’ha pogut obrir aquesta conversa amb l’agent',
    },
};

const sessionConversationSurfaceTranslations = { ca };

return { sessionConversationSurfaceTranslations };
})();

const Domain_sessionDirectoryRecoveryTranslations = (() => {
const en = Shared_sessionDirectoryRecoveryTranslations.en;

const sessionDirectoryRecoveryTranslations = { ca: {
        title: ({ machine }) => `La carpeta privada d’aquest xat ja no és a ${machine}.`,
        body: 'Pots continuar en una carpeta nova i buida. L’historial del xat es conservarà aquí, però no es restauraran els fitxers locals de la carpeta anterior.',
        continue: 'Continua en una carpeta nova', notNow: 'Ara no',
        offlineDelete: ({ machine }) => `La seva carpeta privada a ${machine} s’eliminarà quan l’ordinador torni a estar en línia.`,
    } } satisfies Pick<Record<import('../../_all').SupportedLanguage, typeof en>, "ca">;

return { sessionDirectoryRecoveryTranslations };
})();

const Domain_sessionDraftTranslations = (() => {
const en = Shared_sessionDraftTranslations.en;

const ca: typeof en = {
    sectionTitle: 'Esborranys',
    sectionTitleForHome: ({ home }) => `Esborranys a ${home}`,
    waitingSectionTitleForHome: ({ home }) => `S’espera un ordinador a ${home}`,
    badge: 'Esborrany',
    untitled: 'Esborrany sense títol',
    continueEditing: 'Continua editant',
    startAnother: 'Comença’n un altre',
    executionRunStart: {
        starting: 'S’està iniciant la conversa amb l’agent…',
        reconciling: 'S’està comprovant si aquesta conversa amb l’agent s’ha iniciat…',
        unresolved: 'No hem pogut confirmar si aquesta conversa amb l’agent s’ha iniciat. Iniciar-ne una altra en pot crear una segona.',
        targetChanged: 'L’ordinador d’aquesta sessió ha canviat abans que la conversa pogués començar. No s’ha iniciat res.',
        secretReferenceOverlayUpdateRequired: 'Per usar secrets compartits en una conversa amb l’agent cal un ordinador actualitzat. No s’ha iniciat res.',
    },
    status: {
        offline: 'Fora de línia — desat en aquest dispositiu',
        syncing: 'S’està sincronitzant…',
        conflict: 'Cal revisar-ho',
        unsupported: 'Sense sincronitzar — aquest Home no pot sincronitzar aquest esborrany',
        startInterrupted: 'Inici interromput',
    },
    availability: {
        machineUnavailable: 'Ordinador no disponible',
        pluginUnavailable: 'Connector no disponible',
        attachmentNeedsAttention: 'L’adjunt necessita atenció',
    },
    new: { action: 'Sessió nova' },
    delete: {
        action: 'Suprimeix l’esborrany',
        confirmTitle: 'Voleu suprimir aquest esborrany?',
        confirmDescription: 'Això elimina l’esborrany dels vostres dispositius sincronitzats.',
    },
    conflict: {
        title: 'Reviseu els canvis en conflicte',
        description: 'Trieu quina versió voleu conservar per a cada camp. Podeu copiar la versió del dispositiu abans de substituir-la.',
        mine: 'Aquest dispositiu',
        synced: 'Versió sincronitzada',
        useSynced: 'Usa la sincronitzada',
        keepDevice: 'Conserva la d’aquest dispositiu',
        copyMine: 'Copia la meva',
        copied: 'Copiat',
        copyFailed: 'No s’ha pogut copiar aquest valor.',
        field: {
            text: 'Missatge',
            mentions: 'Mencions',
            attachments: 'Adjunts',
            recipient: 'Destinatari',
            agentContinuation: 'Continuació de l’agent',
            executionRunRequestedAction: 'Lliurament de l’execució',
        },
    },
};

const sessionDraftTranslations = { ca };

return { sessionDraftTranslations };
})();

const Domain_sessionEmbeddedTranslations = (() => {
const en = Shared_sessionEmbeddedTranslations.en;

const translated = Shared_sessionEmbeddedTranslations.translated;

const sessionEmbeddedTranslations = { ca: translated({
        unavailable: 'Aquesta sessió no està disponible',
        respondInSession: 'Obre la sessió per respondre.',
        regionLabel: ({ title }) => `Sessió: ${title}`,
        newChatWelcome: 'En què treballem?',
    }) } as const;

return { sessionEmbeddedTranslations };
})();

const Domain_sessionFollowTranslations = (() => {
type SessionFollowTranslations = Shared_sessionFollowTranslations.SessionFollowTranslations;

const en = Shared_sessionFollowTranslations.en;

const sessionFollowTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionFollowTranslations
>, "ca"> = { 'ca': {
        "notificationBody": {"message":"Missatge nou en aquesta sessió.","failed":"El torn ha fallat.","cancelled":"El torn s'ha cancel·lat.","sourceUnavailable":"La font d'aquesta sessió no està disponible."},
        "follow": "Segueix",
        "unfollow": "Deixa de seguir",
        "following": "Seguint",
        "notifications": "Notificacions",
        "unavailableTitle": "El seguiment no està disponible",
        "unavailableDescription": "Aquest Home no ofereix el seguiment de sessions.",
        "unreachableTitle": "No s’ha pogut contactar amb aquest Home",
        "unreachableDescription": "Happier no ha pogut comprovar si aquest Home ofereix el seguiment de sessions. Torna-ho a provar quan sigui accessible.",
        "editor": {
            "title": "Segueix aquesta sessió",
            "subtitle": "Rep les actualitzacions que t’importen.",
            "ownerSubtitle": "Ets propietari d’aquesta sessió, així que sempre en rebràs les novetats.",
            "externalAttachedOnly": "La sincronització en segon pla està desactivada, així que les actualitzacions poden arribar només mentre aquesta sessió estigui connectada."
        },
        "level": {
            "none": "Sense notificacions",
            "important": "Actualitzacions importants",
            "all_messages": "Cada missatge nou"
        },
        "voice": {
            "title": "Inclou a Voice",
            "subtitle": "Voice pot mantenir aquesta sessió en context.",
            "waitingRuntime": "Esperant que Voice es connecti.",
            "unsupported": "Aquest entorn no admet incloure sessions seguides a Voice.",
            "providerWithheld": "Aquest mode de Voice no pot incloure actualitzacions de sessions desades.",
            "waitingEncrypted": "Desbloqueja aquesta sessió per incloure-la a Voice.",
            "initialSnapshotPending": "Al proper torn de Voice, inclou un resum breu de l’estat actual."
        },
        "footer": "Seguir no canvia mai qui pot accedir a aquesta sessió.",
        "settingsLink": "Configuració de notificacions…",
        "assignedExplanation": "La segueixes perquè te l’han assignat",
        "assignedNotice": "T’han assignat una sessió.",
        "sharedNotice": "Han compartit una sessió amb tu.",
        "wakeEventExplanation": "El context seguit ha canviat, així que Happier ha despertat aquest agent amb l’actualització.",
        "accessLost": "Ja no tens accés a aquesta sessió.",
        "offline": "No tens connexió. Torna a connectar-te per canviar el seguiment.",
        "archived": "El seguiment està pausat mentre la sessió està arxivada.",
        "sources": {
            "title": "Actualitzacions de Sessions",
            "waitingRuntime": "Esperant que la Sessió de destinació es torni a connectar.",
            "unsupported": "Actualitza o torna a connectar la CLI de la màquina de destinació per rebre actualitzacions.",
            "pausedArchived": "Les actualitzacions estan en pausa mentre la font o la destinació estiguin arxivades.",
            "add": "Segueix en una altra sessió…",
            "addSource": "Envia actualitzacions des d’una altra sessió…",
            "chooseDestinationTitle": "Segueix en una altra sessió",
            "chooseSourceTitle": "Envia actualitzacions des d’una altra sessió",
            "row": ({ title }) => `Actualitzacions de «${title}»`,
            "nextTurn": "Proper torn",
            "wakeOnHumanChange": "Activa quan una persona afegeixi un missatge",
            "stop": "Atura les actualitzacions",
            "stopForSource": ({ title }) => `Atura les actualitzacions de «${title}»`,
            "includeNextTurn": "Inclou les actualitzacions al proper torn de la destinació.",
            "sourceKeyPreparing": "Preparant l’accés xifrat…",
            "sourceKeyWaiting": "Esperant l’accés xifrat.",
            "sourceKeyUnavailable": "Aquest ordinador no pot proporcionar accés xifrat.",
            "sourceSessionKeyUnavailable": "L’accés xifrat d’aquesta sessió no està disponible aquí.",
            "catchUpPending": "Actualitzacions pendents"
        },
        "preferences": {
            "title": "Segueix automàticament",
            "assigned": "Sessions assignades a mi",
            "direct": "Sessions compartides directament",
            "team": "Sessions compartides a través d’equips",
            "group": "Sessions compartides a través de grups",
            "help": "S’aplica a noves assignacions i sessions accessibles per primer cop. Les opcions existents no canvien."
        }
    } };

return { sessionFollowTranslations };
})();

const Domain_sessionGitBranchesTranslations = (() => {
type SessionGitBranchesTranslations = Shared_sessionGitBranchesTranslations.SessionGitBranchesTranslations;

const en = Shared_sessionGitBranchesTranslations.en;

const ca: SessionGitBranchesTranslations = {
    openA11y: ({ branch }) => `Branca ${branch}: canvia de branca o mira què s’ha apartat`,
    searchPlaceholder: 'Canvia o crea una branca',
    category: { current: 'Actual', branches: 'Branques', remote: 'Branques remotes', keptAside: 'Apartat', worktrees: 'Worktrees', start: 'Comença una cosa nova' },
    tracks: ({ upstream }) => `segueix ${upstream}`,
    onlyHere: 'només en aquesta màquina',
    changed: ({ count }) => `${count} canviats`,
    ahead: ({ count }) => `${count} per pujar`,
    keptAsideWhen: ({ origin, when }) => `${origin} · ${when}`,
    newBranch: ({ branch }) => `Branca nova des de ${branch}…`,
    newBranchDetached: 'Branca nova…',
    newBranchSubtitle: 'Escriu-ne el nom al camp de cerca',
    newWorktree: 'Worktree nou…',
    newWorktreeSubtitle: 'Treballa en una altra branca en una sessió nova',
    keepAside: 'Aparta els canvis',
    keepAsideSubtitle: ({ count }) => `Guarda ${count} canvis i comença de zero`,
    keepAsideNothing: 'No hi ha canvis per guardar',
    keepAsideFailed: 'No s’han pogut apartar els canvis.',
    loadFailed: 'No s’han pogut carregar les branques',
    notice: {
        title: ({ branch }) => `Vas apartar canvis a ${branch}`,
        reason: ({ when }) => `Apartats ${when}. Recupera’ls per continuar treballant.`,
        reasonUndated: 'Recupera’ls per continuar treballant.',
        restore: 'Restaura els canvis',
        lookFirst: 'Mira-ho primer',
        dismiss: 'Ara no',
        restoreFailed: 'No s’han pogut restaurar els canvis.',
    },
};

const sessionGitBranchesTranslations = { ca };

return { sessionGitBranchesTranslations };
})();

const Domain_sessionGitDisplayTranslations = (() => {
const en = Shared_sessionGitDisplayTranslations.en;

const ca: typeof en = {
    settingsLayout: 'Disposició del panell Git',
    settingsShowAs: 'Mostra els fitxers canviats com a',
    trigger: 'Opcions de visualització',
    paneGroup: 'Panell',
    changesGroup: 'Canvis',
    layout: 'Disposició',
    layoutUnified: 'Unificada',
    layoutTabs: 'Pestanyes',
    layoutDescription: 'Un sol desplaçament dels canvis a l’historial, o Canvis i Historial com a dues vistes.',
    showAs: 'Mostra com',
    showAsList: 'Llista',
    showAsTree: 'Arbre',
    showAsDescription: 'Els fitxers canviats en una llista, o agrupats per carpeta per agafar carpetes senceres.',
    density: 'Densitat',
    densityDefault: 'Per defecte',
    densityCompact: 'Compacta',
    note: 'Les files de l’arbre sempre són compactes. Es recorda al teu compte.',
    selectFolder: ({ folder }) => `Selecciona tots els canvis de ${folder}`,
    selectFile: ({ file }) => `Selecciona ${file} per a la propera confirmació`,
};

const sessionGitDisplayTranslations = { ca };

return { sessionGitDisplayTranslations };
})();

const Domain_sessionGitPaneTranslations = (() => {
const en = Shared_sessionGitPaneTranslations.en;

const fidelity = Shared_sessionGitPaneTranslations.fidelity;

const withFidelity = Shared_sessionGitPaneTranslations.withFidelity;

const ca: typeof en = {
    scope: { allChanges: 'Tots els canvis' },
    subTabs: { changes: 'Canvis', sync: 'Sincronitza', history: 'Historial' },
    header: {
        changed: ({ count }) => `${count} canviats`,
        toPush: ({ count }) => `${count} per pujar`,
        toPull: ({ count }) => `${count} per baixar`,
        push: ({ count }) => `Puja ${count}`,
        pull: ({ count }) => `Baixa ${count}`,
        publish: 'Publica',
        folderOnMachine: ({ folder, machine }) => `${folder} a ${machine}`,
    },
    groups: {
        session: 'Canviat en aquesta sessió',
        elsewhere: ({ repo }) => `En altres llocs de ${repo}`,
        elsewhereUnnamed: 'En altres llocs d’aquest repositori',
        selectGroup: ({ group }) => `Selecciona tots els fitxers de «${group}»`,
    },
    row: { renamedFrom: ({ path }) => `abans ${path}` },
    commit: {
        toBranch: ({ branch }) => `Confirma a ${branch}`,
        selection: ({ count }) => (count === 1 ? '1 fitxer' : `${count} fitxers`),
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
            dirtyTitle: ({ count, formatted }) => (count === 1 ? `Tens 1 canvi sense confirmar` : `Tens ${formatted} canvis sense confirmar`),
            dirtyBody: 'Baixar-los els podria tocar. Desa’ls a part mentre baixes (tornen de seguida) o deixa que Git baixi només si res no se solapa.',
            keepAsideAndPull: 'Desa a part i baixa',
            pullIfNoOverlap: 'Baixa si res no se solapa',
            divergedPullBody: 'La teva branca i origin s’han mogut. Posa els teus commits sobre els d’origin o fusiona’ls.',
            divergedPushBody: 'Porta primer els commits d’origin (posa els teus a sobre o fusiona) i torna a pujar. Els teus commits es queden en aquesta màquina.',
            rebase: 'Rebase sobre origin',
            merge: 'Fusiona origin',
        },
        writesOff: {
            title: 'Fer commits des de Happier està desactivat',
            body: 'Pots llegir i revisar cada canvi. Activa les operacions de control de versions per confirmar, pujar i baixar des d\'aquí.',
            turnOn: 'Activa',
        },
        header: {
            noChanges: 'cap canvi',
        },
        action: {
            fetch: 'Obtén',
            publish: 'Publica la branca',
            createPr: 'Crea PR',
            openPr: ({ number }) => `#${number}`,
            resolve: ({ count }) => `Resol ${count}`,
            upToDate: 'Al dia',
            pushing: ({ count }) => `Pujant ${count}…`,
            pulling: ({ count }) => `Baixant ${count}…`,
            fetching: 'Obtenint…',
            publishing: 'Publicant…',
            creatingPr: 'Creant…',
        },
        menu: {
            open: 'Més accions de sincronització',
            push: 'Puja',
            pull: 'Baixa',
            pushTo: ({ target }) => `a ${target}`,
            pullFrom: ({ target }) => `de ${target}`,
            nothingToPush: 'Res per pujar',
            upToDate: 'Al dia',
            fetchHint: 'Comprova si origin té commits nous',
            publishHint: 'Posa aquesta branca a origin',
            createPr: 'Crea una pull request…',
            createPrInto: ({ base }) => `cap a ${base}`,
            unavailable: 'No disponible aquí',
            more: 'Més',
        },
        running: {
            branchSwitch: 'Canviant de branca…',
            branchCreate: 'Creant la branca…',
            stashCreate: 'Desant els canvis a part…',
            discard: 'Descartant els canvis…',
            revert: 'Revertint el commit…',
            generic: 'Treballant…',
        },
        done: {
            untouched: ({ count, formatted }) => (count === 1 ? `el teu canvi sense confirmar no s’ha tocat` : `els teus ${formatted} canvis sense confirmar no s’han tocat`),
            commit: 'Confirmat',
            commitFiles: ({ count, formatted }) => (count === 1 ? `1 fitxer confirmat` : `${formatted} fitxers confirmats`),
            push: 'Pujat',
            pushCommits: ({ count, formatted }) => (count === 1 ? `1 commit pujat` : `${formatted} commits pujats`),
            upToDate: ({ target }) => `${target} està al dia`,
            pull: 'Baixat',
            pullCommits: ({ count, formatted }) => (count === 1 ? `1 commit baixat` : `${formatted} commits baixats`),
            fetch: ({ target }) => `S'ha comprovat ${target}`,
            branchSwitch: 'Branca canviada',
            branchCreate: 'Branca creada',
            stashCreate: 'Canvis desats a part',
            discard: 'Canvis descartats',
            revert: 'Commit revertit',
            pullRequest: 'Pull request a punt',
            generic: 'Fet',
        },
        failed: {
            unknownTitle: 'No hem pogut confirmar com ha acabat',
            unknownBody: 'La màquina ha deixat de respondre abans que Git informés. Torna a comprovar-ho per veure què ha passat.',
            origin: 'origin',
            thisMachine: 'aquesta màquina',
            refreshTitle: 'Confirmat, però la llista no s\'ha actualitzat',
            refreshBody: 'El commit està a salvo. Torna-ho a provar per veure els canvis actuals.',
            rejectedTitle: ({ target }) => `${target} té commits que tu no tens`,
            rejectedBody: 'Obtén-los per veure què ha canviat. Els teus commits es queden en aquesta màquina fins que tornis a pujar.',
            authTitle: ({ machine, provider }) => `${provider} no ha acceptat l'inici de sessió des de ${machine}`,
            authBody: ({ machine }) => `Git a ${machine} no té credencials vàlides per a aquest remot. Inicia sessió allà i torna-ho a provar.`,
            offlineTitle: ({ machine }) => `${machine} està fora de línia`,
            offlineBody: 'Ara no s\'hi pot executar res. La teva feina és a salvo en aquella màquina.',
            conflictTitle: 'S\'ha aturat per canvis en conflicte',
            conflictBody: 'Alguns fitxers han canviat a tots dos costats. Resol-los i continua.',
            networkTitle: ({ target }) => `No s'ha pogut arribar a ${target}`,
            networkBody: 'La màquina no s\'ha pogut connectar al remot. Comprova\'n la xarxa i torna-ho a provar.',
            commitTitle: 'El commit no s\'ha fet',
            pushTitle: 'La pujada no s\'ha fet',
            pullTitle: 'La baixada no s\'ha fet',
            fetchTitle: 'No s\'han pogut comprovar els commits nous',
            pullRequestTitle: 'No s\'ha creat la pull request',
            genericTitle: 'No s\'ha pogut fer',
        },
        recover: {
            open: 'Obre',
            tryAgain: 'Torna-ho a provar',
            fetch: 'Obtén',
            checkAgain: 'Torna a comprovar',
            showConflicts: 'Mostra els conflictes',
        },
        timeline: {
            title: 'Cronologia',
            now: 'Ara',
            loading: 'Llegint l\'historial…',
            uncommitted: ({ count, formatted }) => (count === 1 ? `1 canvi sense confirmar` : `${formatted} canvis sense confirmar`),
            selected: ({ count, formatted }) => (count === 1 ? `1 seleccionat per al proper commit` : `${formatted} seleccionats per al proper commit`),
            nothingSelected: 'Res seleccionat',
            earlierToday: 'Avui, abans',
            yesterday: 'Ahir',
            older: 'Més antic',
            justNow: 'ara mateix',
            toPull: 'per baixar',
            originFurther: ({ name }) => `${name} és més enrere`,
            originA11y: ({ name }) => `${name} és aquí`,
        },
        clean: {
            titleUpToDate: 'Tot està confirmat i pujat',
            titleCommitted: 'Tot està confirmat',
            bodyUpToDate: ({ branch, upstream }) => `${branch} coincideix amb ${upstream}. Els canvis nous d'aquesta sessió apareixeran aquí.`,
            body: 'Els canvis nous d\'aquesta sessió apareixeran aquí.',
            createPullRequest: 'Crea una pull request',
            openPullRequest: ({ number }) => `Obre la pull request #${number}`,
            lastCommit: ({ when }) => `Últim commit ${when}`,
        },
        conflicts: {
            skip: 'Omet aquest commit',
            askAgentTask: ({ files, operation }) => `Resol els conflictes de la ${operation} a ${files}. Mantén la intenció de tots dos costats, edita i prepara els fitxers resolts i atura’t perquè ho revisi. No continuïs, no avortis, no facis commit ni push, i no triïs un costat sencer.`,
            revert: 'reversió',
            cherryPick: 'cherry-pick',
            merge: 'fusió',
            rebase: 'rebase',
            stopped: ({ count, formatted, operation }) => (count === 1 ? `La ${operation} s'ha aturat: 1 fitxer ha canviat a tots dos costats` : `La ${operation} s'ha aturat: ${formatted} fitxers han canviat a tots dos costats`),
            readyToContinue: ({ operation }) => `Tots els conflictes estan resolts. Continua la ${operation}.`,
            filesInConflict: ({ count, formatted }) => (count === 1 ? `1 fitxer en conflicte` : `${formatted} fitxers en conflicte`),
            body: 'Obre cada fitxer de «Et necessita» o demana a l\'agent que els resolgui.',
            continueBody: 'No es confirma res fins que continuïs.',
            askAgent: 'Demana a l\'agent que ho resolgui',
            continue: ({ operation }) => `Continua la ${operation}`,
            abort: ({ operation }) => `Avorta la ${operation}`,
            abortTitle: ({ operation }) => `Vols avortar la ${operation}?`,
            abortBody: 'La branca torna on era abans de començar. Es perden les resolucions fetes fins ara.',
            needsYou: 'Et necessita',
            mergedCleanly: 'Fusionat sense problemes',
        },
        commit: {
            selectFirst: 'Selecciona fitxers per confirmar',
        },
        tools: {
            title: 'Remots i fusions',
            subtitle: 'Afegeix un remot, fusiona o fes rebase d\'una branca',
        },
    },
    paused: { reason: 'la sessió està en pausa', resume: 'Reprèn' },
    notRepository: {
        title: 'Segueix el que canvien els agents aquí',
        body: ({ folder }) => `${folder} encara no és un repositori. Crea’n un per revisar, confirmar i desfer cada canvi.`,
        bodyUnnamed: 'Aquesta carpeta encara no és un repositori. Crea’n un per revisar, confirmar i desfer cada canvi.',
    },
};

const sessionGitPaneTranslations = { ca: withFidelity(ca) };

return { sessionGitPaneTranslations };
})();

const Domain_sessionGitPullRequestTranslations = (() => {
type ProviderArgs = Shared_sessionGitPullRequestTranslations.ProviderArgs;

type GitPullRequestCopy = Shared_sessionGitPullRequestTranslations.GitPullRequestCopy;

const en = Shared_sessionGitPullRequestTranslations.en;

const ca: GitPullRequestCopy = {
    form: {
        title: 'Nova pull request', expand: 'Obre en un panell de detalls', moveBack: 'Torna-la a la barra lateral',
        close: 'Tanca el formulari (l’esborrany es conserva)', base: 'Es fusiona a', titlePlaceholder: 'Títol',
        bodyPlaceholder: 'Què ha canviat i per què', draft: 'Esborrany', create: 'Crea la pull request', creating: 'Creant…',
        continueOn: ({ provider }) => `Continua a ${provider}`, pointer: 'La nova pull request és oberta a Detalls', pointerShow: 'Mostra',
        openedProviderPage: ({ provider }) => `${provider} és obert per acabar-la; el teu text es conserva aquí.`,
    },
    failure: {
        authFailed: ({ provider }) => `${provider} no ha acceptat l’inici de sessió d’aquesta màquina`,
        network: ({ provider }) => `No s’ha pogut connectar amb ${provider}`,
        machineOffline: 'La màquina està fora de línia; l’esborrany es conserva',
        blocked: 'Hi ha una altra operació de Git en curs; torna-ho a provar quan acabi',
        other: 'No s’ha creat la pull request',
    },
    card: {
        number: ({ number }) => `#${number}`, intoBase: ({ base }) => `a ${base}`,
        state: { open: 'Oberta', draft: 'Esborrany', merged: 'Fusionada', closed: 'Tancada', unknown: 'Pull request' },
        checks: { pending: 'Comprovacions en curs', success: 'Comprovacions correctes', failure: 'Comprovacions fallides', unknown: 'Comprovacions' },
        openOn: ({ provider }) => `Obre a ${provider}`, copyLink: 'Copia l’enllaç', copied: 'Enllaç copiat',
    },
    settings: {
        placementTitle: 'Obre les noves pull requests a', placementDescription: 'En un telèfon el formulari sempre s’obre com a pàgina pròpia.',
        sidebar: 'Barra lateral', details: 'Panell de detalls',
    },
};

const sessionGitPullRequestTranslations = { ca };

return { sessionGitPullRequestTranslations };
})();

const Domain_sessionHomeFreshnessTranslations = (() => {
const en = Shared_sessionHomeFreshnessTranslations.en;

const translated = Shared_sessionHomeFreshnessTranslations.translated;

const sessionHomeFreshnessTranslations = { ca: translated({
        offline: 'Sense connexió',
        stale: 'No s’ha pogut actualitzar',
        lastUpdated: ({ ago }) => `Actualitzat fa ${ago}`,
    }) };

return { sessionHomeFreshnessTranslations };
})();

const Domain_sessionListFilterTranslations = (() => {
const en = Shared_sessionListFilterTranslations.en;

const translated = Shared_sessionListFilterTranslations.translated;

const sessionListFilterTranslations = { ca: translated({
        filtersTitle: 'Filtres de sessions', filtersSearch: 'Cerca filtres…', filtersShow: 'Mostra',
        filtersScope: 'Àmbit', filtersShowSessions: 'Sessions', filtersShowRuns: 'Execucions', filtersShowBoth: 'Ambdues',
        filtersShowBothSummary: 'Sessions i execucions', filtersStartedByNone: 'Cap iniciador seleccionat',
        filtersStartedBy: 'Iniciat per', filtersStartedByYou: 'Tu', filtersStartedByTriggers: 'Activadors', filtersStartedByAgents: 'Agents',
        filtersRunsNeedingYouAlwaysShow: 'Les execucions que et necessiten sempre es mostren',
        filtersMyWork: 'La meva feina', filtersLegacyOwnerDirect: 'Pròpies i compartides directament', filtersAssignedToMe: 'Assignades a mi', filtersFollowing: 'Seguides',
        filtersInvolvingMe: 'On participo', filtersAllAccessible: 'Totes les accessibles', filtersAttention: 'Atenció',
        filtersAttentionAny: 'Qualsevol', filtersAttentionNeedsMe: 'Només sessions que em necessiten', filtersScopeNeedsMe: 'Em necessiten',
        filtersInactive: 'Sessions inactives', filtersInactiveShow: 'Mostra', filtersInactiveHide: 'Amaga',
        filtersHomes: 'Homes', filtersSharedWith: 'Compartides amb', filtersOutsideTeams: 'Personal i directe',
        filtersTags: 'Etiquetes', filtersSource: 'Origen', filtersSourceAll: 'Totes',
        filtersSourceDirect: 'Externes',
        filtersNoOptions: 'No hi ha filtres disponibles', filtersClear: 'Neteja els filtres', filtersDone: 'Fet', filtersArchived: 'Arxivades',
        filtersNeedsMeOnly: 'Només el que em necessita', filtersNeedsMeOnlyDescription: 'Sessions que t\'esperen', filtersSourceHappier: 'Happier',
        filtersMoreTags: ({ count }: { count: number }) => `+ ${count} més`,
        filtersResultCount: ({ count }: { count: number }) => count === 1 ? `1 element` : `${count} elements`,
        queryInitialLoadingTitle: 'S’estan carregant les sessions…', queryUpdatingTitle: 'S’estan actualitzant les sessions…',
        querySomeHomesUnavailableTitle: 'Alguns Homes no estan disponibles', querySomeHomesUnavailableDescription: 'Happier mostra allò que pot trobar. Torna-ho a provar quan aquests Homes estiguin en línia.',
        queryRefreshFailedTitle: 'No s’ha pogut actualitzar', queryRefreshFailedRetainedDescription: 'Les sessions carregades continuen aquí. Torna-ho a provar per comprovar si hi ha actualitzacions.', queryRefreshFailedEmptyDescription: 'Happier no ha pogut carregar sessions dels Homes seleccionats. Torna-ho a provar quan siguin accessibles.',
        queryNoMatchesLoadedTitle: 'Cap coincidència a les sessions carregades', queryNoMatchesLoadedDescription: 'Pot haver-hi més sessions coincidents en una pàgina anterior.', querySearchOlder: 'Cerca en sessions anteriors',
        queryMoreAvailableTitle: 'Pot haver-hi més sessions disponibles', queryMoreAvailableDescription: 'Aquesta vista inclou les sessions carregades. Cerca en sessions anteriors per continuar.',
        queryNoMatchesTitle: 'Cap sessió coincideix', queryNoMatchesDescription: 'Prova de canviar els filtres actius.',
        queryTeamEmptyTitle: 'Aquest Equip no té sessions', queryTeamEmptyDescription: 'Les sessions compartides amb aquest Equip apareixeran aquí.',
        queryMyWorkEmptyTitle: 'Res a La meva feina', queryScopeEmptyDescription: 'Prova un àmbit més ampli o torna més tard.', queryBrowseAllAccessible: 'Mostra totes les sessions',
        queryAssignedEmptyTitle: 'No tens cap sessió assignada', queryFollowingEmptyTitle: 'No hi ha sessions seguides', queryInvolvingEmptyTitle: 'No hi ha sessions on participis',
        queryAttentionEmptyTitle: 'Cap sessió necessita la teva atenció', queryReachableEmptyTitle: 'No hi ha sessions disponibles', queryReachableEmptyDescription: 'Cap sessió coincideix amb aquesta vista als Homes accessibles.',
        queryHistoricalSharesWithheldTitle: 'Algunes sessions compartides estan amagades', queryHistoricalSharesWithheldDescription: 'Les sessions compartides amb tu des d’una versió anterior de Happier romanen amagades fins que el propietari les actualitzi a Happier.',
        partialHomeNotMountedTitle: ({ home }) => `${home} no és en aquesta vista de Sessions`,
        partialHomeNotMountedDescription: 'Afegeix aquest Home a un grup de Homes visible per mostrar les sessions de l’Equip sense canviar el focus.',
        partialShowFromHome: ({ home }) => `Mostra sessions de ${home}`,
        teamListingUnavailableTitle: 'La llista de sessions de l’Equip no està disponible en aquest Home',
        teamListingUnavailableDescription: 'Aquest Home encara no pot mostrar les sessions de l’Equip. Actualitza’l o torna’l a configurar i prova-ho de nou.',
        teamListingLoadingTitle: ({ team }) => `S’estan carregant les sessions de ${team}…`,
        teamListingLoadingDescription: 'Happier està comprovant què pot mostrar aquest Home.',
        teamListingProbeFailedTitle: 'No s’ha pogut contactar amb aquest Home',
        teamListingProbeFailedDescription: 'Happier no ha pogut consultar les sessions de l’Equip en aquest Home. Torna-ho a provar quan sigui accessible.',
    }) };

return { sessionListFilterTranslations };
})();

const Domain_sessionMessageAccountActorTranslations = (() => {
type AccountActorTranslations = Shared_sessionMessageAccountActorTranslations.AccountActorTranslations;

const sessionMessageAccountActorTranslations: Pick<Record<SupportedLanguage, AccountActorTranslations>, "ca"> = { ca: { accountActorYou: 'Tu', accountActorFormerMember: 'Antic membre', accountActorUnnamedMember: 'Membre de Happier', accountActorSentBy: ({ name }) => `Enviat per ${name}` } };

return { sessionMessageAccountActorTranslations };
})();

const Domain_sessionPageTranslations = (() => {
const english = Shared_sessionPageTranslations.english;

const translated = Shared_sessionPageTranslations.translated;

const sessionPageTranslations = { ca: translated({
        sessionPages: {
            info: {
                continueTitle: 'Continua',
                continueDescription: 'Comença feina nova des d’on és aquesta sessió.',
                organizeTitle: 'Organitza',
                organizeDescription: 'On apareix aquesta sessió a les teves llistes.',
                activityDescription: 'Què fa l’agent i si te n’assabentes.',
                detailsTitle: 'Detalls',
                detailsDescription: 'Identificadors i historial, per a suport i scripts.',
                environmentTitle: 'Entorn',
                environmentDescription: 'La màquina, la carpeta i l’agent amb què s’executa aquesta sessió.',
                agentStateDescription: 'Qui dirigeix l’agent i què està esperant.',
                relatedTitle: 'Relacionat',
                relatedDescription: 'Altres pàgines d’aquesta sessió.',
                developerTitle: 'Desenvolupador',
                developerDescription: 'Registres en brut per depurar, visibles en mode desenvolupador.',
                leaveLabel: 'Atura, arxiva o elimina',
                leaveFootnote: 'Aturar acaba el procés en execució. Les sessions arxivades es poden restaurar. Eliminar esborra la sessió i els seus missatges per sempre.',
            },
            follow: {
                description: 'Tria si aquesta sessió t’avisa i si parla per veu.',
            },
            permissions: {
                description: 'Eines que has permès des d’un altre dispositiu per a aquesta sessió. Revoca les que ja no vulguis.',
            },
            automations: {
                description: 'Feina que s’executa en aquesta sessió segons un horari, un esdeveniment o quan acaba un torn.',
            },
            newRun: {
                description: 'Inicia una execució d’un subagent des d’aquesta sessió.',
                transcriptReadOnly: 'Aquest és un historial desat. Torna a connectar-te a aquest Home per continuar la conversa.',
                daemonReadOnly: 'Aquest historial prové del procés de l’agent. Torna a connectar-te a aquest Home per continuar la conversa.',
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
>, "ca"> = { ca: {
        due: 'Recordatori pendent',
        title: 'Recorda-m’ho', inOneHour: 'D’aquí a 1 hora', inThreeHours: 'D’aquí a 3 hores',
        tomorrowMorning: 'Demà al matí', nextWeek: 'La setmana vinent', custom: 'Tria data i hora…',
        customTitle: 'Tria data i hora',
        customPlaceholder: '2026-09-08 09:00', futureTimeRequired: 'Tria una hora futura.',
        setReminder: 'Defineix el recordatori',
        reminderSaved: 'Recordatori desat',
        presetSaveFailedAfterReminder: 'El recordatori està desat, però no s’ha confirmat el desament del predefinit. Torna-ho a provar o tanca.',
        presetsSaveFailed: 'No s’ha confirmat el desament dels predefinits. Els canvis es conserven aquí; torna-ho a provar.',
        presetsChanged: 'Els predefinits desats difereixen de la llista que has obert. Tanca i torna a obrir per revisar la llista actual.',
        remove: 'Elimina el recordatori',
        dateLabel: 'Data', timeLabel: 'Hora', addToPresets: 'Afegeix als predefinits', presetPreviewUnavailable: 'Tria una hora futura vàlida per previsualitzar el predefinit.', managePresets: 'Gestiona els predefinits', managePresetsMessage: 'Canvia el nom, l’ordre o elimina les opcions desades.', presetName: 'Nom del predefinit', movePresetUp: 'Mou amunt', movePresetDown: 'Mou avall', renamePresetLabel: ({ preset }) => `Canvia el nom de «${preset}»`, movePresetUpLabel: ({ preset }) => `Mou «${preset}» amunt`, movePresetDownLabel: ({ preset }) => `Mou «${preset}» avall`, deletePresetLabel: ({ preset }) => `Elimina «${preset}»`, noPresets: 'Cap predefinit desat', noPresetsMessage: 'Desa’n un quan triïs un recordatori personalitzat.',
    } };

return { sessionReminderTranslations };
})();

const Domain_sessionRemotePermissionGrantTranslations = (() => {
type SessionRemotePermissionGrantTranslations = Shared_sessionRemotePermissionGrantTranslations.SessionRemotePermissionGrantTranslations;

const sessionRemotePermissionGrantTranslations = { ca: {
        title: 'Concessions de permisos remots',
        entryTitle: 'Concessions de permisos remots',
        entrySubtitle: 'Reviseu i revoqueu les concessions remotes de la sessió',
        loadingTitle: 'S’estan carregant les concessions de permisos remots',
        loadingReason: 'S’estan comprovant les concessions del propietari actual de la sessió.',
        emptyTitle: 'No hi ha concessions de permisos remots',
        emptyReason: 'Aquesta sessió no té concessions remotes per revisar.',
        unavailableTitle: 'Les concessions de permisos remots no estan disponibles',
        unavailableReason: 'Comproveu que aquest sigui el propietari actual de la sessió i que la seva màquina estigui disponible i torneu-ho a provar.',
        ownerOnlyTitle: 'Només el propietari de la sessió pot gestionar les concessions remotes',
        ownerOnlyReason: 'Els participants compartits poden respondre a sol·licituds aptes, però no poden revisar ni revocar les concessions del propietari de la sessió.',
        retry: 'Torna-ho a provar',
        listTitle: 'Concessions de la sessió',
        grantActive: ({ actor }) => `Concessió activa de ${actor}`,
        grantRevoked: ({ actor }) => `Concessió revocada de ${actor}`,
        grantDetail: ({ grantId, sourceRef, sourceRevisionOrEpoch }) => `Concessió ${grantId} · Origen ${sourceRef} (${sourceRevisionOrEpoch})`,
        revoke: 'Revoca la concessió',
        revoking: 'S’està revocant…',
        revokeConfirmTitle: 'Voleu revocar la concessió de permís remot?',
        revokeConfirmBody: ({ identifier }) => `Això revocarà immediatament la concessió remota per a ${identifier}.`,
        revokeFailedTitle: 'No s’han pogut actualitzar les concessions remotes',
        revokeFailedReason: 'La concessió pot haver canviat o la màquina del propietari pot no estar disponible. Torneu-ho a provar.',
        loadMore: 'Carrega més concessions',
        loadingMore: 'S’estan carregant més concessions…',
        loadMoreFailedReason: 'No s’han pogut carregar més concessions. Torneu-ho a provar.',
    } } as const satisfies Pick<Readonly<Record<string, SessionRemotePermissionGrantTranslations>>, "ca">;

return { sessionRemotePermissionGrantTranslations };
})();

const Domain_sessionResponsibilityTranslations = (() => {
type SessionResponsibilityTranslations = Shared_sessionResponsibilityTranslations.SessionResponsibilityTranslations;

const en = Shared_sessionResponsibilityTranslations.en;

const sessionResponsibilityTranslations: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionResponsibilityTranslations
>, "ca"> = { ca: {
        responsibilitySectionTitle: 'Responsabilitat',
        responsibilityRowTitle: 'Responsable',
        responsibilityNoOne: 'Ningú',
        responsibilityUnnamedPerson: 'Persona sense nom',
        responsibilityPickerTitle: 'Tria la persona responsable',
        responsibilitySearchPlaceholder: 'Cerca persones amb accés',
        responsibilityAssignToMe: 'Assigna-m’ho',
        responsibilityPeopleWithAccess: 'Persones amb accés',
        responsibilityAccessHintOwner: 'Propietari',
        responsibilityNoCandidates: 'Encara no hi ha ningú més amb accés a aquesta sessió.',
        responsibilityAccessChanged: 'L’accés ha canviat. Aquesta persona ja no pot ser responsable.',
        responsibilityUpdateFailed: 'Happier no ha pogut actualitzar la persona responsable. Torna-ho a provar.',
        responsibilityApprovalPending: 'Pendent d’aprovació. Encara no ha canviat res: la persona responsable s’actualitzarà quan s’aprovi.',
        responsibilityA11yEditable: ({ name }: { name: string }) =>
            `Persona responsable, ${name}. Canvia la persona responsable.`,
        responsibilityA11yReadOnly: ({ name }: { name: string }) => `Persona responsable, ${name}.`,
        responsibilityA11yEmpty: 'Persona responsable, ningú. Canvia la persona responsable.',
        responsibilityAssignedToYou: 'Assignada a tu',
        responsibilitySharedWithYou: 'Compartida amb tu',
    } };

return { sessionResponsibilityTranslations };
})();

const Domain_sessionWorkTranslations = (() => {
const en = Shared_sessionWorkTranslations.en;

const ca: typeof en = {
    workerUpdate: {
        settled: "Resolut",
        stalled: "Aturat",
        published: "Publicat",
        truncated: "Resultat escurçat.",
        wokenBy: ({ count }) => (count === 1 ? 'Despertat per una actualització' : `Despertat per ${count} actualitzacions`),
        notFromYou: 'no és un missatge teu',
    },
    title: 'Feina',
    subtitle: {
        sessions: ({ count }) => (count === 1 ? '1 sessió' : `${count} sessions`),
        runs: ({ count }) => (count === 1 ? '1 execució' : `${count} execucions`),
        nothingStarted: 'Encara no s’ha iniciat res',
    },
    states: {
        recent: 'Recents',
    },
    view: {
        a11y: 'Vista de la feina',
        list: 'Llista',
        map: 'Mapa',
        expandMap: 'Obre el mapa al costat de la sessió',
    },
    map: {
        positionUnder: ({ position, total, parent }) => `${position} de ${total} sota ${parent}`,
    },
    actions: {
        makeOrchestrator: 'Converteix-la en orquestradora',
        makeOrchestratorSubtitle: 'Aquesta sessió planifica, delega i informa',
        makeOrchestratorFailed: "No s’ha pogut convertir la sessió en orquestradora",
    },
    putUnder: {
        title: "Posa sota…",
        subtitle: "Informa a una altra sessió",
        search: "Cerca una sessió",
        topLevel: "Nivell superior — no informa a ningú",
        errors: {
            cycle: "Aquella sessió ja informa a aquesta",
            changed: "La sessió s’acaba de moure. Torna-ho a provar",
            forbidden: "No la pots posar sota aquella sessió",
            failed: "No s’ha pogut moure la sessió",
        },
    },
    kinds: {
        session: 'Sessió',
        workflowRun: 'Execució de flux',
        backgroundRun: 'Execució en segon pla',
    },
    showMore: ({ count }) => `Mostra ${count} més`,
    role: {
        none: 'Cap',
        handsOff: 'sense editar',
        a11y: ({ role }) => `Rol: ${role}. Canvia el rol`,
    },
    empty: {
        title: 'Encara no hi ha feina',
        reason: 'Les sessions, els fluxos de treball i les execucions en segon pla que iniciï aquesta sessió apareixeran aquí, amb tot allò que et necessita.',
    },
    row: {
        a11y: ({ title, status }) => `${title}, ${status}`,
    },
    progress: ({ completed, total }) => `${completed} de ${total}`,
    strip: {
        openInSidebar: 'Obre a la barra lateral',
        stillWorking: ({ count }) => `${count} encara treballant`,
        needsYou: ({ count }) => `${count} et necessita${count === 1 ? '' : 'n'}`,
        a11y: ({ summary }) => `Feina: ${summary}`,
    },
    leadArchived: ({ count }) => `Aquesta sessió està arxivada · ${count} encara treballant`,
    runsStale: 'Les execucions de fluxos de treball poden no estar al dia',
    list: {
        level: ({ level }) => `Nivell ${level}`,
        subSessions: ({ count }) => (count === 1 ? '1 subsessió' : `${count} subsessions`),
        reportsWorking: ({ count }) => `${count} treballant`,
        reportsNeedYou: ({ count }) => (count === 1 ? '1 subsessió et necessita' : `${count} subsessions et necessiten`),
    },
    archive: {
        alsoArchiveReports: ({ count }) => (count === 1 ? 'Arxiva també 1 subsessió' : `Arxiva també ${count} subsessions`),
        someNotArchivedTitle: ({ count }) => (count === 1 ? '1 subsessió no s’ha arxivat' : `${count} subsessions no s’han arxivat`),
    },
    peek: {
        reportsTo: ({ lead }) => `Informa a ${lead}`,
        repliesGoHere: 'Les respostes van a aquesta sessió',
    },
};

const notify = { ca: { turn: 'Avisa’m quan acabi aquest torn', attention: 'Avisa’m quan em necessiti', armed: 'Rebràs un avís', cancel: 'Cancel·la l’avís', failed: 'No s’ha pogut actualitzar l’avís. Torna-ho a provar.', turnFinished: 'El torn d’aquesta sessió ha acabat.', needsYou: 'Aquesta sessió et necessita.', settings: 'Configuració de notificacions' } };

const runNotify = { ca: { run: 'Avisa’m quan acabi', runFinished: 'Aquesta execució ha acabat.', runNeedsYou: 'Aquesta execució et necessita.', setup: 'Configura les notificacions' } };

const sessionWorkTranslations = { ca: { ...ca, notify: { ...notify.ca, ...runNotify.ca } } };

return { notify, runNotify, sessionWorkTranslations };
})();

const Domain_settingsConnectionsTranslations = (() => {
type MachineParams = Shared_settingsConnectionsTranslations.MachineParams;

const en = Shared_settingsConnectionsTranslations.en;

const ca = {
    sectionTitle: 'Connexions',
    sectionDescription: 'Com arriben els teus dispositius a les teves màquines.',
    directTitle: 'Connecta directament quan sigui possible',
    directOnDescription: 'Les previsualitzacions, les vistes en directe i les transferències de fitxers van directament entre els teus dispositius quan s’arriben, i a través de Happier quan no.',
    directOffDescription: 'Tot passa per Happier. Res no es connecta directament a les teves màquines; a la mateixa xarxa és una mica més lent.',
    serverDenied: 'El servidor del teu Home ho fa passar tot per Happier, així que aquí no hi ha res a triar.',
    machineSectionTitle: 'Connexió',
    machineTitle: ({ machine }: MachineParams) => `Connexió amb ${machine}`,
    machineOptionDefault: 'Per defecte',
    machineOptionDirect: 'Directament',
    machineOptionRelay: 'A través de Happier',
    machineDefaultDescription: ({ machine }: MachineParams) => `Segueix el teu compte: directament quan ${machine} és accessible, si no a través de Happier.`,
    machineDefaultOffDescription: 'Segueix el teu compte: sempre a través de Happier.',
    machineDirectDescription: ({ machine }: MachineParams) => `Directament quan ${machine} és accessible, encara que el teu compte digui el contrari.`,
    machineRelayDescription: 'Sempre a través de Happier, fins i tot a la mateixa xarxa.',
};

const settingsConnectionsTranslations = { ca };

return { settingsConnectionsTranslations };
})();

const Domain_settingsMachinesTranslations = (() => {
const en = Shared_settingsMachinesTranslations.en;

const ca: typeof en = {
    pageDescription: 'Els ordinadors on s’executen les teves sessions i els grups que trien entre ells.',
    thisComputerTitle: 'Aquest ordinador',
    thisComputerRowSubtitle: 'Servei en segon pla i línia d’ordres',
    thisComputerPageDescription: 'El servei en segon pla i la línia d’ordres de Happier en aquest dispositiu.',
    setupSectionTitle: 'Configuració',
    setupRowSubtitle: 'Instal·la Happier aquí i connecta’l al teu Home.',
    addPageDescription: 'Connecta un ordinador perquè els agents hi executin les teves sessions.',
    addFromComputerTitle: 'Afegeix màquines des d’un ordinador',
    addFromComputerDescription: 'Obre Happier a l’ordinador que vulguis afegir, o connecta’n un per SSH des de Happier a l’escriptori o en un navegador.',
    searchPlaceholder: 'Cerca màquines',
    count: ({ count }: { count: number }) => (count === 1 ? '1 màquina' : `${count} màquines`),
    daemonTitle: 'Servei en segon pla',
    daemonDescription: 'Executa les teves sessions en aquest ordinador i el manté connectat al teu Home.',
    unreadableTitle: ({ home }: { home: string }) => `No s’han pogut llegir les màquines de ${home}`,
};

const settingsMachinesTranslations = { ca };

return { settingsMachinesTranslations };
})();

const Domain_settingsOverviewTranslations = (() => {
type SettingsOverviewTranslation = Shared_settingsOverviewTranslations.SettingsOverviewTranslation;

const slavicPlural = Shared_settingsOverviewTranslations.slavicPlural;

const settingsOverviewTranslations = { ca: {
        attentionTitle: 'Requereix la teva atenció',
        agentNeedsSignIn: ({ agent, machine }) => `${agent} necessita iniciar sessió a ${machine}`,
        agentNeedsSignInNoMachine: ({ agent }) => `${agent} necessita iniciar sessió`,
        serviceSignInExpired: ({ service }) => `La sessió de ${service} ha caducat`,
        signIn: 'Inicia sessió',
        signInAgain: 'Torna a iniciar sessió',
        setupTitle: 'Primers passos',
        setupProgress: ({ done, total }) => `${done} de ${total}`,
        setupActionSaveKey: 'Desa la clau',
        setupActionAddMachine: 'Afegeix una màquina',
        setupActionShowQr: 'Mostra el QR',
        setupActionScan: 'Escaneja',
        setupActionPasteLink: 'Enganxa l’enllaç',
        setupActionBrowse: 'Explora',
        machineUpdateVersions: ({ current, latest }) => `Happier ${current} en aquesta màquina · ${latest} disponible`,
        connectTerminalTitle: 'Connecta un terminal',
        connectTerminalSubtitle: 'Escaneja el codi que mostra el terminal o enganxa’n l’enllaç.',
        quickSettingsTitle: 'Configuració ràpida',
        notificationsPushOn: 'Push activades',
        notificationsPushOff: 'Push desactivades',
        notificationsQuietHours: 'Hores de silenci activades',
        pluginChangesAwaitingReview: ({ count }) => count === 1 ? '1 canvi de connector espera la teva revisió' : `${count} canvis de connectors esperen la teva revisió`,
        review: 'Revisa',
        browsePluginsTitle: 'Explora els connectors',
        browsePluginsSubtitle: 'Afegeix eines, panells i integracions a Happier.',
        accountServiceSignedIn: ({ service }) => `Sessió iniciada a ${service}`,
        aboutDescription: 'Versió, codi font i termes legals (Happier no està afiliat amb Anthropic).',
        machinesTitle: 'Màquines',
        machineOnline: 'En línia',
        machineOffline: ({ lastSeen }) => `Fora de línia · vist ${lastSeen}`,
        machineUpdateAvailable: 'Actualització disponible',
        machinesOnlineCount: ({ count }) => `${count} en línia`,
        machinesOfflineCount: ({ count }) => `${count} fora de línia`,
        machineLastSeen: ({ lastSeen }) => `vist ${lastSeen}`,
        update: 'Actualitza',
        asOf: ({ time }) => `A les ${time}`,
        usageTitle: 'Ús',
        usageLeft: ({ percent }) => `Queda un ${percent} %`,
        usageResets: ({ time }) => `es restableix ${time}`,
        securityTitle: 'Seguretat',
        startSessionLabel: 'Inicia una sessió',
        saveRecoveryKeyTitle: 'Desa la teva clau de recuperació',
        saveRecoveryKeySubtitle: 'L’única manera de tornar a les dades xifrades si perds tots els dispositius.',
        addMachineTitle: 'Afegeix una màquina',
        addMachineSubtitle: 'Connecta un ordinador on s’executin els teus agents.',
        homeGreetingNamed: ({ name }) => `Benvingut de nou, ${name}.`,
        homeStartSection: 'Inicia una sessió',
        homeCustomize: 'Personalitza l’inici',
        homeCustomizeDescription: 'Tria quines seccions mostra el teu inici i en quin ordre.',
        homeAlwaysShown: 'Sempre visible',
        homeShowSection: 'Mostra',
        homeHideSection: 'Amaga la secció',
        homeSectionOptions: 'Opcions de la secció',
        homeResetLayout: 'Restableix els valors per defecte',
        homeLayoutSectionTitle: 'Inici',
        homeAddWidgetsTitle: 'Afegeix ginys',
        homeAddWidgetsDescription: 'Els ginys que ofereixen els teus connectors. Afegeix-ne un per mostrar-lo a l’inici.',
        homeWidgetFromPlugin: ({ plugin }) => `De ${plugin}`,
        homeRemoveWidget: 'Treu de l’inici',
    } } satisfies Pick<Readonly<Record<string, SettingsOverviewTranslation>>, "ca">;

return { settingsOverviewTranslations };
})();

const Domain_settingsProfilesRemoteHostsPageTranslations = (() => {
const english = Shared_settingsProfilesRemoteHostsPageTranslations.english;

const translated = Shared_settingsProfilesRemoteHostsPageTranslations.translated;

const settingsProfilesRemoteHostsPageTranslations = { ca: translated({
        settingsProfilesPage: {
            pageDescription: "Configuració d'inici amb què pot començar una sessió nova: l'agent, el model, les variables d'entorn i on s'executa.",
            useProfilesSection: 'Selecció de perfil',
            useProfilesSectionDescription: "Tria un perfil quan comencis una sessió, o comença totes les sessions amb l'entorn de la màquina.",
            useProfiles: 'Fes servir perfils',
            useProfilesOffDescription: "Desactivat. Les sessions noves fan servir l'entorn de la màquina.",
            favoritesDescription: 'Es mostren primer quan tries un perfil.',
            customDescription: "Perfils que has creat. Si edites un perfil integrat, se'n desa aquí una còpia teva.",
            builtInDescription: 'Perfils preparats per a cada agent.',
        },
        settingsRemoteHostsPage: {
            pageDescription: 'Amfitrions SSH que aquest ordinador pot configurar com a màquines, als quals es pot connectar o on pot executar un relay.',
            savedHostsSection: 'Amfitrions desats',
            savedHostsDescription: "Primer els utilitzats més recentment. Obre un amfitrió per fer-lo servir o canviar-lo.",
            hostPageDescription: "Un amfitrió SSH que aquest ordinador pot configurar com a màquina, al qual es pot connectar o on pot executar un relay.",
            newHostTitle: "Nou amfitrió remot",
            newHostDescription: "Posa nom a l'amfitrió i indica com arribar-hi per SSH.",
            useSection: "Fes servir aquest amfitrió",
            useSectionDescription: "Què pot fer aquest dispositiu amb ell.",
            maintenanceSection: "Happier en aquest amfitrió",
            maintenanceSectionDescription: "Instal·la, actualitza i executa la línia d'ordres, el servei en segon pla i el relay de Happier allà.",
            discard: "Descarta",
            accessTitle: "Claus i connexions",
            accessRowSubtitle: "Claus d'amfitrió de confiança i túnels oberts",
            accessPageDescription: "Claus d'amfitrió en què confia aquest dispositiu, i els túnels i les rutes d'accés oberts als teus amfitrions.",
            hostNotFound: "Aquest amfitrió ja no està desat.",
            unavailableDescription: 'Els amfitrions SSH desats es poden configurar com a màquines o fer servir com a relays.',
            trustedHostKeysDescription: "Claus que aquest dispositiu ha acceptat en connectar-se. Elimina'n una perquè t'ho torni a preguntar la propera vegada.",
            trustedHostKeysEmpty: 'Encara no hi ha claus d\'amfitrió de confiança. Apareixen aquí quan n\'acceptes una en connectar-te.',
            sshTunnelsDescription: 'Túnels oberts des d’aquest dispositiu cap a un amfitrió desat.',
        },
    }) };

return { settingsProfilesRemoteHostsPageTranslations };
})();

const Domain_settingsProvidersTranslations = (() => {


const withProviderSharedFields = Shared_settingsProvidersTranslations.withProviderSharedFields;

const ca = {
    title: 'Proveïdors', entrySubtitle: 'Connecta fonts de models locals i al núvol', detailTitle: 'Connexió del proveïdor',
    configuredTitle: 'Els teus proveïdors', configuredFooter: 'Els models dels proveïdors habilitats apareixen als selectors de models dels agents compatibles.',
    availableTitle: 'Disponibles', availableFooter: 'Afegeix un proveïdor una vegada i utilitza els seus models amb tots els agents compatibles.', customTitle: 'Proveïdor personalitzat',
    customFooter: 'Connecta una passarel·la de l’empresa o un altre endpoint de models compatible.', addCustom: 'Afegeix un proveïdor personalitzat', addCustomDescription: 'Utilitza un endpoint compatible amb OpenAI o Anthropic',
    emptyTitle: 'Encara no hi ha proveïdors connectats', emptyDescription: 'Tria un proveïdor disponible o afegeix el teu propi endpoint.', unavailable: 'Els proveïdors no estan disponibles',
    unavailableDescription: 'Aquest servidor no ha habilitat les connexions de proveïdors.', noMachine: 'No hi ha cap màquina disponible', noMachineDescription: 'Connecta una màquina per configurar i provar proveïdors.', problemTitle: 'El proveïdor necessita atenció', searchPlaceholder: 'Cerca proveïdors',
    status: { available: 'Connectat', notChecked: 'Sense comprovar', needsAttention: 'Necessita atenció', unreachable: 'Inaccessible', disabled: 'Desactivat', sourceUnavailable: 'Connector no disponible' },
    kind: { frontier: 'Proveïdor de models', aggregator: 'Catàleg de models', cloud: 'Proveïdor al núvol', local: 'S’executa en aquesta màquina' },
    detail: {
        pickSecretTitle: 'Tria una clau API', notFoundTitle: 'No s’ha trobat el proveïdor', notFoundDescription: 'Aquesta connexió de proveïdor ja no existeix.', deletedDescription: 'Aquest proveïdor s’ha eliminat. Tria un altre model abans de reprendre les sessions que el feien servir.', sourceAvailable: 'Connector del proveïdor disponible',
        connectionTitle: 'Connexió', connectionFooter: 'Controla on es pot utilitzar aquest proveïdor i comprova’n l’estat actual.', accountAccess: 'Utilitza a totes les màquines', accountAccessDescription: 'Disponible allà on aquest proveïdor es resolgui a un endpoint públic',
        testConnection: 'Prova la connexió', testDescription: 'Comprova l’endpoint i actualitza’n el catàleg de models', testSucceeded: 'Connexió correcta', testNotSupported: 'Aquest proveïdor no admet una prova de connexió automàtica', machinesTitle: 'Màquines', machinesFooter: 'Els endpoints locals i privats s’han d’habilitar per separat a cada màquina.',
        currentMachine: 'Màquina actual', selectMachineToManage: 'Selecciona aquesta màquina per revisar i canviar-ne l’accés', targetMachine: 'Màquina de destinació', machineOnline: 'En línia', machineOffline: 'Fora de línia', apiKeyTitle: 'Clau API', apiKeyFooter: 'Les claus es desen a Secrets desats i mai no es mostren aquí.',
        accountApiKey: 'Clau API predeterminada', machineApiKey: 'Clau API en aquesta màquina', apiKeyConfigured: 'Configurada', apiKeyMissing: 'Afegeix una clau per connectar', apiKeySelected: 'Clau desada seleccionada', useAccountApiKey: 'Utilitza la clau predeterminada si no hi ha cap clau per a la màquina', modelsTitle: 'Models', manageModels: 'Gestiona els models', modelsUnknown: 'Els models apareixeran després de connectar', modelCount: ({ count }: { count: number }) => `${count} ${count === 1 ? 'model' : 'models'}`,
        actionsTitle: 'Accions', duplicateTitle: 'Afegeix una altra connexió', duplicateDescription: 'Crea una connexió amb un altre nom per al mateix proveïdor', deleteTitle: 'Elimina el proveïdor', deleteDescription: 'Les sessions existents conserven l’historial, però no es podran reprendre amb aquest proveïdor.', advancedTitle: 'Avançat', endpointDefault: 'Endpoint predeterminat', endpointMachine: 'Endpoint en aquesta màquina', endpointMachineDescription: 'Substitueix el valor predeterminat només on aquesta màquina executi el proveïdor', endpointPrompt: 'Introdueix l’URL base complet del proveïdor.', resetEndpoint: 'Restableix l’endpoint', resetMachineEndpoint: 'Utilitza l’endpoint predeterminat en aquesta màquina', resetDefaultEndpoint: 'Utilitza l’endpoint proporcionat pel connector del proveïdor',
    },
    authoring: {
        providerTitle: 'Proveïdor', builtInDescription: 'Tria un Secret desat i connecta aquest proveïdor.', compatibilityTitle: 'Compatibilitat', compatibilityFooter: 'Tria l’estil d’API documentat pel proveïdor.', protocolTitle: 'Compatibilitat de l’API',
        protocol: { 'openai-responses': { title: 'Compatible amb OpenAI Responses', description: 'Per a passarel·les que implementen l’API Responses' }, 'openai-chat': { title: 'Compatible amb OpenAI Chat', description: 'Per a passarel·les que implementen Chat Completions' }, anthropic: { title: 'Compatible amb Anthropic', description: 'Per a passarel·les que implementen l’API Messages' } },
        detailsTitle: 'Detalls del proveïdor', name: 'Nom', namePlaceholder: 'Passarel·la de l’empresa', baseUrl: 'URL base', baseUrlPlaceholder: 'https://gateway.example.com/v1', modelsPath: 'Camí dels models', credentialsTitle: 'Credencials', credentialsFooter: 'Selecciona un Secret desat. No enganxis mai una clau API a l’URL ni a les capçaleres.', requiresApiKey: 'Requereix una clau API', requiresApiKeyYes: 'Utilitza un Secret desat per a les sol·licituds', requiresApiKeyNo: 'Connecta sense credencials', apiKey: 'Clau API', apiKeyDescription: 'Tria o crea un Secret desat', credentialStyleTitle: 'Format de la clau API', credentialHeader: 'Nom de la capçalera', credentialStyle: { bearer: 'Token bearer d’autorització', xApiKey: 'Capçalera x-api-key', apiKey: 'Capçalera api-key', customHeader: 'Capçalera personalitzada' }, catalogTitle: 'Catàleg de models', catalogFooter: 'Obtén els models automàticament quan l’endpoint ho permeti o afegeix-los manualment més tard.', fetchModels: 'Obtén els models automàticament', fetchModelsYes: 'Utilitza l’endpoint de llista de models del proveïdor', fetchModelsNo: 'Afegeix els ID de model manualment', verifyTitle: 'Connecta', verifyFooter: 'Prova primer quan sigui possible i després desa el proveïdor.', save: 'Desa el proveïdor', connect: 'Connecta el proveïdor',
    },
    errors: {
        secretMissingTitle: 'Cal una clau API', secretMissingDescription: 'Tria un Secret desat abans d’habilitar aquest proveïdor.', notEnabledOnMachineTitle: 'No està habilitat en aquesta màquina', notEnabledOnMachineDescription: 'Habilita aquest proveïdor a la màquina on s’executarà la sessió.', disabledTitle: 'El proveïdor està desactivat', disabledDescription: 'Habilita aquest proveïdor abans d’utilitzar-ne els models.', unreachableTitle: 'No es pot accedir al proveïdor', unreachableDescription: 'Comprova que el servei estigui en execució i que l’endpoint sigui correcte i torna-ho a provar.', notFoundTitle: 'No s’ha trobat el proveïdor', notFoundDescription: 'Aquest proveïdor s’ha eliminat. Tria un altre proveïdor o model.', sourceUnavailableTitle: 'Connector del proveïdor no disponible', sourceUnavailableDescription: 'Torna a habilitar o instal·lar el connector que ofereix aquesta connexió.', featureDisabledTitle: 'Els proveïdors no estan disponibles', featureDisabledDescription: 'Aquest servidor no ha habilitat les connexions de proveïdors.', unauthorizedTitle: 'Clau API rebutjada', unauthorizedDescription: 'Substitueix el Secret desat per una clau vàlida i torna a provar la connexió.', rateLimitedTitle: 'El proveïdor ha limitat les sol·licituds', rateLimitedDescription: 'Espera un moment i torna a provar la connexió.', probeCapacityTitle: 'Massa comprovacions de proveïdor alhora', probeCapacityDescription: 'Happier encara no ha pogut iniciar aquesta comprovació a la màquina seleccionada. Espera un moment i torna-ho a provar.', genericTitle: 'El proveïdor necessita atenció', genericDescription: 'Revisa la configuració del proveïdor i torna-ho a provar.',
    },
    models: { builtIn: 'Integrat', experimental: 'Experimental', experimentalConfirmTitle: 'Vols utilitzar un model experimental?', experimentalConfirmBody: ({ provider, model }: { provider: string; model: string }) => `${model} de ${provider} encara no s’ha verificat completament amb aquest agent. Si no funciona com esperes, potser hauràs de reiniciar o triar un altre model.`, experimentalConfirmAction: 'Utilitza el model', stale: 'Pot no estar disponible', hidden: 'Ocult', manage: 'Gestiona els models', empty: 'Aquest proveïdor encara no té models disponibles.', add: 'Afegeix models', addPlaceholder: 'Introdueix un ID de model per línia', resetVisibility: 'Restableix la visibilitat', showHidden: 'Mostra els models ocults', hideHidden: 'Amaga els models ocults', remove: 'Elimina el model', removeConfirmation: 'Vols eliminar aquest model afegit manualment?', enable: 'Mostra el model', disable: 'Amaga el model', load: 'Carrega el model', retry: 'Torna-ho a provar', connectionUnavailable: 'Aquest proveïdor no està disponible a la màquina seleccionada.' },
};

const localTranslations = { ca: { title: 'En aquesta màquina', footer: 'Servidors de models locals trobats en aquesta màquina. Els models s’executen de manera privada al teu equip.', detected: 'Detectat', possible: 'Possible servei', detectedAtPort: ({ port }: { port: string }) => `Detectat · Port ${port}`, possibleAtPort: ({ provider, port }: { provider: string; port: string }) => `Possible servei de ${provider} · Port ${port}`, addConnectionTitle: 'Afegeix una altra connexió local', addConnectionDescription: 'Posa-li un nom per distingir-la dels altres endpoints locals.', defaultConnectionName: ({ provider }: { provider: string }) => `${provider} local` } } as const;

const providerManagedDeploymentTranslations = { ca: {
        configureManaged: 'Executa sessions amb un servei local gestionat',
        configureManagedDescription: 'Tria el compte connectat o el grup per a sessions futures. Happier inicia el servei quan cal.',
        subscriptionPolicyTitle: 'L’encaminament de subscripcions és experimental',
        subscriptionPolicyDescription: 'La política o l’aplicació del proveïdor original pot canviar i fer que deixi de funcionar. Happier mostra el rebuig i no utilitza silenciosament una altra credencial.',
        accountScopeMismatchTitle: 'Els comptes connectats són al servidor actiu',
        accountScopeMismatchDescription: 'Aquest proveïdor es gestiona en una màquina d’un altre servidor. Canvia a aquest servidor per triar-ne el compte connectat o el grup.',
        editManagedDefaults: 'Edita els valors de sessions gestionades',
        editManagedDefaultsDescription: 'Canvia el compte connectat o el grup per a sessions futures. Les sessions existents conserven la selecció.',
        purposeTargetTitle: 'Destí del compte connectat',
        purposeTargetDescription: 'Tria un compte connectat o un grup disponible per a aquest propòsit.',
        invalidPurposeTargetTitle: 'Destí de compte no vàlid',
        invalidPurposeTargetDescription: 'Tria un compte connectat o un grup disponible abans de desar.',
        useExternal: 'Usa un servei extern',
        useExternalDescription: 'Deixa de gestionar aquest proveïdor per a sessions futures i usa la configuració de l’endpoint extern.',
        useExternalConfirmTitle: 'Vols usar un servei extern?',
        useExternalConfirmDescription: 'S’eliminen els valors gestionats. Les sessions existents conserven les seleccions.',
    } } as const;

const copyNameTranslations = { ca: ({ name }: { name: string }) => `Còpia de ${name}` } as const;

const providerSharedFieldTranslations = { ca: {
        local: { installedNotRunning: 'Instal·lat, però no s’està executant', appRunningServerOff: 'L’aplicació és oberta, però el servidor local està desactivat', startManaged: ({ provider }: { provider: string }) => `Inicia ${provider}`, startedByHappier: 'Iniciat per Happier', runningOutsideHappier: 'S’executa fora de Happier' },
        apiKeyOptionalDescription: 'Opcional: tria un Secret desat si aquest proveïdor en requereix un',
        models: { addDescription: 'Afegeix ID de model que el proveïdor no enumera automàticament', addHelp: 'Introdueix un ID de model exacte per línia. Els models existents s’ometen.', addFieldLabel: 'ID de model', invalidModelIds: ({ ids }: { ids: string }) => `Aquests ID de model no són vàlids: ${ids}`, noNewModels: 'No hi ha cap ID de model nou per afegir.', providerManagedTitle: 'Aquest proveïdor gestiona els models', providerManagedDescription: 'Actualitza el catàleg del proveïdor per renovar aquesta llista. No s’admeten ID de model manuals.', showAll: 'Mostra tots els models', hideAll: 'Amaga tots els models', hideAllConfirmation: 'Vols amagar tots els models de la llista? Els pots tornar a mostrar en qualsevol moment.', showOnly: 'Mostra només aquest model', showOnlyConfirmation: 'Vols amagar tots els altres models de la llista? Els pots restaurar en qualsevol moment.' },
    } } as const;

const providerFirstSessionValidationTranslations = { ca: 'Happier validarà la connexió de manera segura quan iniciïs la primera sessió que la faci servir.' } as const;

const providerMigrationTranslations = { ca: { reviewTitle: 'Revisa la migració del proveïdor', reviewFooter: 'Comprova l’endpoint, el format de l’API, la credencial i els models abans d’aplicar canvis.', legacyProfileDescription: 'Aquest perfil conserva l’encaminament antic fins que confirmis la revisió.', credentialTitle: 'Credencial', credentialFooter: 'Només es mou la referència al Secret desat; el valor no es mostra ni es copia.', noCredential: 'Sense clau API', credentialMoveDescription: 'Mou aquesta credencial a la connexió nova', noCredentialDescription: 'Crea la connexió sense credencials', actionsTitle: 'Migració', preview: 'Revisa els canvis', previewDescription: 'Valida aquesta configuració sense canviar els ajustos', confirm: 'Crea la connexió del proveïdor', confirmDescription: 'Aplica els canvis atòmicament i conserva les preferències d’inici', reviewAction: 'Revisa la migració del proveïdor', reviewActionDescription: 'Mou l’endpoint i els models antics a una connexió', retainedTitle: 'Configuració antiga conservada', retainedDescription: 'Aquesta configuració continuarà disponible fins que es pugui migrar sense perdre comportament.' } } as const;

const providerMigrationPreviewTranslations = { ca: { willMoveTitle: 'Es mourà al proveïdor', willMoveFooter: 'Només es mouen aquests noms d’encaminament i credencials. Els valors secrets no es mostren mai.', willKeepTitle: 'Es mantindrà al perfil d’inici', willKeepFooter: 'Aquests ajustos exclusius de l’inici es mantenen al perfil després de la migració.', permissionDefaults: 'Permisos predeterminats', persistenceDefaults: 'Emmagatzematge de sessió predeterminat' } } as const;

const providerMigrationConflictTranslations = { ca: { conflictReviewTitle: 'Resol el conflicte de migració', conflictReviewFooter: 'Tria si vols conservar la connexió existent o desar aquest perfil com una connexió independent. No es mostren valors secrets.', conflictCredential: 'La credencial desada és diferent', conflictModels: 'Els ajustos dels models són diferents', conflictEditedConnection: 'La connexió existent s’ha modificat', keepExisting: 'Conserva la connexió existent', keepExistingDescription: 'Mantén les credencials i els models actuals i completa la migració sense substituir-los.', modelOutcomeTitle: 'Tria quin model vols conservar', modelOutcomeFooter: 'Revisa el model exacte abans de completar la migració. No canvia res fins que triïs.', useExistingModel: 'Usa el model actual de la connexió', useExistingModelDescription: 'Conserva el model ja seleccionat per a aquesta connexió del proveïdor.', preserveLegacyModel: 'Usa el model del perfil', preserveLegacyModelDescription: 'Mou la selecció exacta d’aquest perfil a la connexió existent.', discardLegacyModel: 'Elimina la selecció de model del perfil', discardLegacyModelDescription: 'Completa la migració sense la selecció de model ni el favorit d’aquest perfil.', createNamed: 'Crea una connexió independent', createNamedDescription: 'Conserva els ajustos del proveïdor d’aquest perfil en una connexió nova.', separateConnectionName: 'Nom de la connexió', conflictReviewAction: 'Resol el conflicte del proveïdor', conflictReviewActionDescription: 'Tria com conservar les credencials o els models en conflicte' } } as const;

const providerCredentialSelectionRequiredTranslations = { ca: 'Tria quina credencial desada ha d’utilitzar aquesta connexió del proveïdor' } as const;

const providerLinkTranslations = { ca: { providerWebsite: 'Lloc web del proveïdor', getApiKey: 'Obtén una clau API', failedToOpen: 'Happier no ha pogut obrir aquest enllaç.' } } as const;

const providerCredentialFormatSelectionRequiredTranslations = { ca: 'Tria com s’envia aquesta credencial' } as const;

const providerReservedEnvironmentValidationUnavailableTranslations = { ca: 'Connecta aquest editor de perfils a una màquina disponible abans de canviar variables d’entorn.' } as const;

const providerAdvancedAuthoringTranslations = { ca: { advancedSetup: 'Configuració avançada', advancedSetupEnabled: 'Configura diversos estils d’API, capçaleres i comprovacions segures de models', advancedSetupDisabled: 'Utilitza un endpoint compatible habitual', endpointEnabled: 'Utilitza aquest estil d’API', endpointEnabledDescription: 'Ofereix aquest endpoint als agents compatibles', endpointDisabledDescription: 'Aquest estil d’API no s’utilitzarà', publicHeaders: 'Capçaleres públiques de sol·licitud', publicHeadersPlaceholder: 'X-Tenant: enginyeria', optionalProbePath: 'Camí de llista de models (opcional)', probeParserTitle: 'Format de resposta', probeParser: { openaiModels: 'Llista de models compatible amb OpenAI', ollamaTags: 'Etiquetes d’Ollama', lmStudioNative: 'Llista de models nativa de LM Studio' } } } as const;

const providerCustomBearerHeaderTranslations = { ca: 'Capçalera personalitzada (testimoni Bearer)' } as const;

const providerNonSecretHeaderTranslations = { ca: 'Capçaleres no secretes' } as const;

const providerProbePathsTranslations = { ca: 'Camins de llista de models (opcionals, un per línia)' } as const;

const providerLocalAuthoringTranslations = { ca: { enableAfterSaving: 'Activa aquest proveïdor', enableOnCurrentMachine: 'Activa només en aquesta màquina després de desar', enableAccountWide: 'Activa després de desar', localAddressTitle: 'Adreça local', localAddressDescription: ({ machine, endpoint }: { machine: string; endpoint: string }) => `Activa-la per separat a cada màquina. ${machine} utilitzarà ${endpoint}.` } } as const;

const providerAuthoringReviewTranslations = { ca: { destinationReview: 'Destinació de la connexió', destinationLoading: 'S’està resolent la destinació exacta al daemon…', destinationSelection: 'Tria una destinació', destinationSelectionDescription: 'Revisa l’adreça exacta abans de connectar.', destinationScope: 'Àmbit de la destinació', destinationMachine: 'Aquesta màquina', destinationAccount: 'Compte' } } as const;

const providerCompatibilityTranslations = { ca: { title: 'Funciona amb', footer: 'Cada integració d’agent verifica la compatibilitat, que pot variar segons el model.', verified: 'Verificat', experimental: 'Experimental', incompatible: 'Incompatible', verifiedDescription: 'Provat amb aquesta integració d’agent', experimentalDescription: 'Pot funcionar, però cal revisar-ho abans del primer ús', incompatibleDescription: 'Aquest agent no pot utilitzar la connexió de manera segura' } } as const;

const providerModelNotLoadedTranslations = { ca: 'No carregat · es pot carregar en el primer ús' } as const;

const providerModelLoadCancellationTranslations = { ca: { cancelLoad: 'Cancel·la la càrrega', loadCancelled: 'S’ha deixat d’esperar el model', loadCancelledProviderMayContinue: 'El proveïdor pot continuar carregant-lo. Actualitza el catàleg més tard per comprovar si ha acabat; Happier no repetirà la càrrega.' } } as const;

const providerPartialStatusTranslations = { ca: 'Disponible parcialment' } as const;

const providerConnectedServiceSuppressedTranslations = { ca: 'L’inici de sessió natiu de l’agent no s’utilitza amb aquest proveïdor. La selecció desada no canvia.' } as const;

const providerMachineCleanupPendingTranslations = { ca: 'La màquina s’ha eliminat, però no s’ha pogut desar la neteja de l’accés als proveïdors. Comprova la connexió i torna a eliminar la màquina per reintentar-ho.' } as const;

const providerConnectionChangedTranslations = { ca: { title: 'La connexió del proveïdor ha canviat', description: 'Torna a carregar la configuració actual del proveïdor i prova-ho de nou.' } } as const;

const providerModelSectionTranslations = { ca: { available: 'Disponibles', manual: 'Manual' } } as const;

const providerCompletenessTranslations = { ca: {
        searchEmptyTitle: 'Cap proveïdor coincideix amb aquesta cerca',
        searchEmptyDescription: 'Prova un altre nom de proveïdor o de connexió.',
        compatibilityReasons: {
            noCompatibleProtocol: 'Aquest agent i el proveïdor no comparteixen cap protocol d’API compatible.',
            noAuthUnsupported: 'Aquest agent requereix enviar una clau API per a aquest proveïdor.',
            credentialTransportUnavailable: 'Aquest agent no admet el mètode configurat per enviar la clau API.',
            optionalCredentialNoAuthUnsupported: 'Aquest agent no pot utilitzar el proveïdor sense la clau API opcional.',
            capabilityUnsupported: 'No s’admet una capacitat obligatòria del proveïdor.',
            capabilityUnknown: 'Encara no s’ha verificat una capacitat obligatòria del proveïdor.',
            modelEvidenceRequired: 'Tria un model per verificar les capacitats que requereix.',
            modelCapabilityUnsupported: 'El model no admet una capacitat obligatòria.',
            modelCapabilityUnknown: 'Encara no s’ha verificat una capacitat obligatòria del model.',
            overrideIncompatible: 'La verificació del proveïdor marca aquesta integració com a incompatible.',
            overrideExperimental: 'La verificació del proveïdor marca aquesta integració com a experimental.',
            evidenceMissing: 'Encara no s’han registrat proves de compatibilitat.',
            agentUnsupported: 'Aquest agent no admet proveïdors de models externs.',
            adapterInvalid: 'No s’ha pogut validar l’adaptador de proveïdor de l’agent.',
            unknown: 'Cal revisar una condició de compatibilitat més recent.',
        },
        unsavedDescription: 'Vols descartar aquest esborrany de proveïdor? Els Secrets desats són objectes compartits del compte i continuaran disponibles.',
        recoveryActions: {
            reviewFeatures: 'Revisa la disponibilitat dels proveïdors',
            chooseConnection: 'Tria un proveïdor',
            restorePlugin: 'Revisa el connector',
            enableConnection: 'Habilita el proveïdor',
            reviewAccountGrant: 'Revisa l’accés del compte',
            enableOnMachine: 'Habilita a la màquina',
            reviewMachineGrant: 'Revisa l’accés de la màquina',
            reviewCompatibility: 'Revisa la compatibilitat',
            addSecret: 'Afegeix una clau API',
            reviewCredentialTransport: 'Revisa la compatibilitat de les credencials',
            reviewConnection: 'Revisa la connexió',
            retry: 'Torna-ho a provar',
            replaceSecret: 'Substitueix la clau API',
            chooseModel: 'Tria un model',
            loadModel: 'Carrega el model',
            reviewAndRestart: 'Revisa i reinicia',
            restartProbe: 'Torna a provar la connexió',
            reduceProviderSettings: 'Gestiona la configuració dels proveïdors',
            reviewProfileMigration: 'Revisa la migració del perfil',
            reviewCurrentState: 'Revisa la configuració actual',
        },
        hiddenForAllAgents: 'Ocult per a tots els agents · Gestiona-ho a la configuració de Proveïdors',
    } } as const;

const providerAvailabilityTranslations = { ca: {
        availabilityChecking: 'S’està comprovant la disponibilitat dels proveïdors', availabilityCheckingDescription: 'Happier està confirmant si aquest servidor admet connexions de proveïdors.',
        availabilityProblem: 'No s’ha pogut comprovar la disponibilitat dels proveïdors', availabilityProblemDescription: 'Happier ho tornarà a provar automàticament. Comprova la connexió del servidor si el problema continua.',
        availabilityUnsupported: 'Els proveïdors requereixen una actualització del servidor', availabilityUnsupportedDescription: 'Aquesta versió del servidor no admet connexions de proveïdors.',
        availabilityContextUnsupported: 'Els proveïdors no són compatibles en aquest context', availabilityContextUnsupportedDescription: 'La configuració o selecció actual del servidor no admet connexions de proveïdors.',
        availabilityPolicyDisabled: 'Els proveïdors estan desactivats per una política', availabilityPolicyDisabledDescription: 'Una política local o de compilació ha desactivat les connexions de proveïdors.',
    } } as const;

const settingsProvidersTranslations = { ca: withProviderSharedFields(ca, {
        providerAvailabilityTranslations: providerAvailabilityTranslations.ca,
        providerLinkTranslations: providerLinkTranslations.ca,
        providerCompletenessTranslations: providerCompletenessTranslations.ca,
        providerPartialStatusTranslations: providerPartialStatusTranslations.ca,
        providerMachineCleanupPendingTranslations: providerMachineCleanupPendingTranslations.ca,
        providerConnectionChangedTranslations: providerConnectionChangedTranslations.ca,
        providerCompatibilityTranslations: providerCompatibilityTranslations.ca,
        providerMigrationTranslations: providerMigrationTranslations.ca,
        providerMigrationPreviewTranslations: providerMigrationPreviewTranslations.ca,
        providerMigrationConflictTranslations: providerMigrationConflictTranslations.ca,
        providerCredentialSelectionRequiredTranslations: providerCredentialSelectionRequiredTranslations.ca,
        providerCredentialFormatSelectionRequiredTranslations: providerCredentialFormatSelectionRequiredTranslations.ca,
        providerReservedEnvironmentValidationUnavailableTranslations: providerReservedEnvironmentValidationUnavailableTranslations.ca,
        localTranslations: localTranslations.ca,
        providerSharedFieldTranslations: providerSharedFieldTranslations.ca,
        providerManagedDeploymentTranslations: providerManagedDeploymentTranslations.ca,
        copyNameTranslations: copyNameTranslations.ca,
        providerFirstSessionValidationTranslations: providerFirstSessionValidationTranslations.ca,
        providerAdvancedAuthoringTranslations: providerAdvancedAuthoringTranslations.ca,
        providerLocalAuthoringTranslations: providerLocalAuthoringTranslations.ca,
        providerAuthoringReviewTranslations: providerAuthoringReviewTranslations.ca,
        providerNonSecretHeaderTranslations: providerNonSecretHeaderTranslations.ca,
        providerProbePathsTranslations: providerProbePathsTranslations.ca,
        providerCustomBearerHeaderTranslations: providerCustomBearerHeaderTranslations.ca,
        providerModelSectionTranslations: providerModelSectionTranslations.ca,
        providerModelLoadCancellationTranslations: providerModelLoadCancellationTranslations.ca,
        providerModelNotLoadedTranslations: providerModelNotLoadedTranslations.ca,
        providerConnectedServiceSuppressedTranslations: providerConnectedServiceSuppressedTranslations.ca,
    }) } as const;

return { localTranslations, providerManagedDeploymentTranslations, copyNameTranslations, providerSharedFieldTranslations, providerFirstSessionValidationTranslations, providerMigrationTranslations, providerMigrationPreviewTranslations, providerMigrationConflictTranslations, providerCredentialSelectionRequiredTranslations, providerLinkTranslations, providerCredentialFormatSelectionRequiredTranslations, providerReservedEnvironmentValidationUnavailableTranslations, providerAdvancedAuthoringTranslations, providerCustomBearerHeaderTranslations, providerNonSecretHeaderTranslations, providerProbePathsTranslations, providerLocalAuthoringTranslations, providerAuthoringReviewTranslations, providerCompatibilityTranslations, providerModelNotLoadedTranslations, providerModelLoadCancellationTranslations, providerPartialStatusTranslations, providerConnectedServiceSuppressedTranslations, providerMachineCleanupPendingTranslations, providerConnectionChangedTranslations, providerModelSectionTranslations, providerCompletenessTranslations, providerAvailabilityTranslations, settingsProvidersTranslations };
})();

const Domain_settingsSearchKeywordsTranslations = (() => {
const english = Shared_settingsSearchKeywordsTranslations.english;

const translated = Shared_settingsSearchKeywordsTranslations.translated;

const settingsSearchKeywordsTranslations = { ca: translated({
        settingsSearchKeywords: {
            settings: 'configuració, ajustos, inici, resum',
            groupProfileAndAccount: 'compte, perfil, facturació, pla, ús',
            account: 'compte, perfil, facturació',
            accountSecurity: 'seguretat, contrasenya, recuperació, xifratge, tancar sessió',
            apiTokens: 'token d’api, token d’accés personal, pat, automatització, cli, sdk',
            teams: 'equips, membres, grups, invitacions',
            homeAdministration: 'home, administració, governança, persones, polítiques',
            secrets: 'secrets, claus, env, tokens',
            usage: 'ús, facturació, límits, quota',
            machines: 'màquines, dispositius, ordinador',
            machinePoolsNew: 'grups de màquines, pools, alternativa, executar a',
            machinesAdd: 'afegir, màquina, ssh',
            machinesThisComputer: 'aquest ordinador, local, dispositiu',
            remoteHosts: 'remot, amfitrió, hosts, ssh, servidor, màquines',
            groupGeneral: 'general, aparença, idioma, experiments',
            appearance: 'aparença, tema, tipus de lletra, interfície, barra lateral',
            keyboard: 'teclat, drecera, dreceres, tecles ràpides, ordres',
            pets: 'mascotes, blink, company, codex',
            language: 'idioma, regió, traducció',
            features: 'funcions, experiments, beta',
            groupAiAndAgents: 'agents, proveïdors, mcp, prompts, veu',
            agents: 'proveïdors, agents, models, llm',
            providers: 'proveïdors, models, openrouter, ollama, lm studio',
            subAgent: 'subagents, agents, delegació, regles',
            roles: 'rols, orquestrador, constructor, revisor, instruccions',
            delegation: 'delegació, profunditat, traspàs, orquestrador',
            profiles: 'perfils, personatges',
            connectedServices: 'serveis connectats, oauth, comptes',
            mcp: 'mcp, eines, servidors, plugins',
            plugins: 'plugins, mercat, catàleg, descriptor, descobriment',
            prompts: 'prompts, plantilles, biblioteca',
            promptsTemplates: 'plantilles',
            promptsFolders: 'carpetes',
            promptsStacks: 'piles',
            promptsRegistries: 'registres',
            promptsLibrary: 'biblioteca',
            promptsAssets: 'recursos, extern',
            voice: 'veu, assistent, micròfon',
            voiceConversations: 'veu, conversa, temps real, proveïdor',
            voiceDictation: 'veu, dictat, parla, transcripció',
            voicePrivacy: 'veu, privadesa, historial, retenció',
            voiceAdvanced: 'veu, avançat, màquina, diagnòstic',
            memory: 'memòria, cerca, índex',
            groupSessionsBehavior: 'sessions, transcripció, permisos, accions',
            session: 'sessió, terminal, tmux',
            externalSessions: 'sessions externes, seguiment en segon pla, hooks',
            actions: 'accions, aprovacions, dreceres',
            embeds: 'incrustacions, incrustar, iframe, giny, lloc web, xat',
            transcript: 'transcripció, xat, disposició',
            permissions: 'permisos, aprovació, seguretat',
            toolRendering: 'eines, visualització',
            handoff: 'traspàs, transferència',
            runs: 'execucions, execució',
            groupFilesAndSourceControl: 'fitxers, control de versions, adjunts',
            sourceControl: 'git, scm, control de versions',
            attachments: 'adjunts, pujades, fitxers',
            groupSystem: 'sistema, servidors, estat, notificacions',
            servers: 'servidors, relé',
            systemStatus: 'estat del sistema, salut, diagnòstic',
            updates: 'actualitzacions, actualitzar, versió, cli, reiniciar',
            notifications: 'notif, notificació, notificacions, push',
            notificationsPush: 'push, notificacions push',
            desktop: 'escriptori, tauri, superposició, finestra',
            diagnosis: 'diagnòstic, depuració',
            reportIssue: 'informar d’un problema, error, bug',
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
>, "ca"> = { ca: {
        settingsSessionPages: {
            preview: {
                userMessage: 'Arregla la prova de reconnexió inestable',
                agentReply: 'Trobat: el temporitzador de reintents no es netejava mai. Ja està arreglat i la prova passa.',
                thinking: 'La prova només falla després d’un temps d’espera, així que el temporitzador de reintents deu seguir actiu.',
            },
            runtime: {
                pageDescription: 'Com s’executen les sessions a les teves màquines.',
                terminalSection: 'Terminal',
                terminalHostTitle: 'Amfitrió de terminal per a sessions noves',
                terminalHostNone: 'Cap',
                tmuxTitle: 'Inicia les sessions a tmux',
                tmuxOn: 'Les sessions noves s’obren en una finestra de tmux pròpia, perquè t’hi puguis connectar des d’un terminal.',
                tmuxOff: 'Les sessions noves s’executen en un shell normal.',
            },
            wizard: {
                pageDescription: 'Com organitza els passos l’assistent de sessió nova.',
                wideScreensSection: 'Pantalles amples',
                stepsSection: 'Com mostra cada pas les opcions',
                steps: {
                    profiles: 'Perfil',
                    backends: 'Agent',
                    models: 'Model',
                    machines: 'Màquina',
                    paths: 'Carpeta',
                    permissions: 'Permisos',
                },
            },
            providerLimits: {
                pageDescription: 'Què passa quan s’arriba al límit d’ús d’un proveïdor i quanta quota et queda.',
                recoveryDescription: 'Quan un agent arriba al límit d’ús del proveïdor, la sessió pot esperar el reinici i continuar.',
                resumePromptCustom: 'Personalitzat',
                unavailableTitle: 'No disponible en aquest Home',
                unavailableDescription: 'La recuperació després del límit d’ús i l’indicador d’ús del proveïdor no estan activats en aquest Home.',
            },
            resume: {
                pageDescription: 'Com continua una sessió inactiva quan el seu agent no la pot reprendre tot sol.',
                strategyRecent: 'Missatges recents',
                strategySummary: 'Resum + recents',
                maxSeedCharsTitle: 'Límit de mida de la repetició',
                summaryModelSection: 'Model de resum',
                summaryModelDescription: 'L’agent i el model que escriuen el resum que es repeteix a la sessió nova.',
                handoffSection: 'Moure sessions',
                handoffLinkDescription: 'Què es mou amb una sessió quan la passes a una altra màquina.',
            },
            permissions: {
                duringSessionSection: 'Durant una sessió',
                duringSessionDescription: 'On apareixen les sol·licituds d’aprovació i quan té efecte un canvi de permisos en una sessió en curs.',
                promptSurfaceComposer: 'Al costat del compositor',
                applyImmediately: 'Immediatament',
                applyNextMessage: 'Missatge següent',
                storageUseDefault: 'Per defecte',
            },
            handoff: {
                pageDescription: 'Què es mou amb una sessió quan la passes a una altra màquina.',
                workspaceSection: 'Fitxers de l’espai de treball',
                workspaceDescription: 'Què passa amb la carpeta del projecte quan una sessió es mou a una altra màquina.',
                keepUpdated: 'Mantén actualitzat',
                advancedModeDescription: 'Substitueix l’opció de dalt. Amb compte: es poden eliminar o sobreescriure fitxers.',
                ignoredExclude: 'Exclou',
                ignoredIncludeSelected: 'Inclou els seleccionats',
            },
            toolRendering: {
                pageDescription: 'Dona a eines concretes més o menys detall que el valor per defecte de la transcripció.',
                collapsedDescription: 'Quant mostra cada eina a la transcripció abans d’obrir-la.',
            },
            transcript: {
                advancedTitle: 'Rendiment i temps',
                advancedPageDescription: 'Streaming, temps d’animació i llindars de desplaçament. Els valors per defecte serveixen a gairebé tothom.',
                advancedMotionOff: 'Les animacions de la transcripció estan desactivades, així que això no té cap efecte. Activa-les a Transcripció › Moviment.',
                toolsSection: 'Eines',
                toolOverridesDescription: 'Dona a eines concretes més o menys detall.',
                thinkingSummary: 'Resum',
                thinkingFull: 'Complet',
                strategyConsecutive: 'Consecutives',
                strategyWholeTurn: 'Torn sencer',
                copyMarkdown: 'Markdown',
                copyMarkdownDescription: 'Els missatges copiats conserven el format i indiquen qui els ha escrit.',
                copyPlainDescription: 'Els missatges copiats són text pla, sense etiquetes.',
                motionSubtle: 'Subtil',
                advancedLinkDescription: 'Streaming, temps d’animació i llindars de desplaçament.',
                pageDescription: 'Com es llegeix una conversa a mesura que creix: disseny, raonament, eines, moviment i desplaçament.',
            },
            composer: {
                pageDescription: 'Com escrius i envies missatges, i què passa quan un agent està ocupat.',
                newSessionsSection: 'Sessions noves',
                newSessionsDescription: 'El que veus quan tries Sessió nova.',
                draftEntryTitle: 'En obrir Sessió nova',
                draftResume: 'Reprèn l’esborrany',
                draftFresh: 'Comença de nou',
                typingSection: 'Escriptura',
                typingDescription: 'Com es comporten Retorn i l’historial de missatges al compositor.',
                enterToSendTitle: 'Retorn per enviar',
                sendModeTitle: 'Mentre l’agent treballa',
                sendQueue: 'A la cua',
                sendInterrupt: 'Interromp',
                sendPending: 'Pendent',
                busySteerTitle: 'Si l’agent admet direcció',
                busySteerInactive: 'Només s’aplica quan els missatges es posen a la cua o queden pendents mentre l’agent treballa.',
                nonSteerableTitle: 'Pregunta si un missatge no pot dirigir',
                resumeWhenPossible: 'Quan es pugui',
                resumeIfOnline: 'Si està en línia',
                resumeNever: 'Mai',
                pendingSection: 'Missatges pendents',
                pendingDescription: 'Com arriben a l’agent els missatges pendents.',
                pendingInactive: 'Amb les teves opcions actuals no queda res pendent. Això s’aplica tan bon punt un missatge ho estigui.',
                drainOne: 'D’un en un',
                drainAll: 'Tots alhora',
                timingAfterReply: 'Després de la resposta',
                timingWhenIdle: 'Amb tot inactiu',
                layoutSection: 'Disseny del compositor',
                actionBarTitle: 'Barra d’accions',
                actionBarAutoDescription: 'Els xips passen a una segona línia en pantalles amples i es desplacen en horitzontal al telèfon.',
                actionBarWrapDescription: 'Els xips passen a una segona línia quan no hi caben.',
                actionBarScrollDescription: 'Els xips es queden en una línia; desplaça’t per veure la resta.',
                actionBarCollapsedDescription: 'Els xips s’agrupen en un menú i deixen més espai per escriure.',
                chipDensityTitle: 'Xips d’acció',
                chipsAutoDescription: 'Els xips que ho necessiten conserven l’etiqueta; els evidents només mostren la icona.',
                chipsLabelsDescription: 'Cada xip mostra la seva etiqueta.',
                chipsIconsDescription: 'Els xips només mostren la icona, per estalviar espai.',
            },
        },
    } };

return { settingsSessionPagesTranslations };
})();

const Domain_shareSheetTranslations = (() => {
type ShareSheetTranslations = Shared_shareSheetTranslations.ShareSheetTranslations;

const shareSheetTranslations = { ca: {
        publicLink: { description: "Qualsevol persona amb l’enllaç pot llegir aquest document sense un compte.", grants: "Document només de lectura.", audit: "Registre d’accés", auditEmpty: "Encara no hi ha visites registrades.", ownerUpdateRequired: "El propietari està actualitzant aquest enllaç", ownerUpdateRequiredDescription: "Demana al propietari que obri Happier i torna a provar aquest enllaç." },
        whoHasAccess: 'Qui hi té accés',
        whoHasAccessStale: 'Qui hi té accés · pot estar desactualitzat',
        owner: 'Propietari',
        you: 'Tu',
        addPlaceholder: 'Afegeix persones o equips',
        person: 'Persona',
        group: 'Grup d’equip',
        team: 'Equip',
        accessLevel: 'Nivell d’accés',
        accessibleControl: ({ name, control, value }) => `${name}, ${control}, ${value}`,
        remove: 'Treu l’accés',
        confirmRemove: 'Confirma',
        removedAnnouncement: ({ name }) => `${name} ja no hi té accés`,
        browseAll: 'Mostra-ho tot',
        allLoaded: 'S’han carregat tots els resultats',
        copyLink: 'Copia l’enllaç',
        linkCopied: 'Enllaç copiat',
        copyLinkFailed: 'No s’ha pogut copiar l’enllaç.',
        sendCopy: 'Envia’n una còpia',
        secrets: {
            levels: { canUse: 'Pot fer servir' },
            help: { use: 'en execucions; el valor no es mostra mai' },
            oneLevel: 'Un secret desat només el fan servir les execucions i el valor no surt mai, així que té un sol nivell.',
        },
        documents: {
            title: 'Compartició',
            shareTitle: ({ name }) => `Comparteix ${name}`,
            levels: { canUse: 'Pot fer servir', canRead: 'Pot llegir', canEdit: 'Pot editar', admin: 'Administrar' },
            help: {
                workflowUse: 'veure’l i executar-lo',
                roleUse: 'fer-lo servir; els seus canvis queden a la seva Configuració',
                profileUse: 'iniciar sessions amb ell',
                documentUse: 'obrir-lo i copiar-lo a qualsevol dels seus dispositius',
                promptUse: 'fer-lo servir a les seves sessions',
                boardUse: 'veure el tauler; cada targeta obre només el que ja pot obrir',
                editForEveryone: 'canviar-lo per a tothom amb qui es comparteix',
                adminOwnerShares: 'canviar-lo i gestionar la compartició; només el propietari pot assignar Admin',
            },
            notes: {
                personalRuns: 'Les execucions i els activadors queden amb qui els inicia.',
                teamRuns: 'L’equip veu cada execució.',
                roleLive: 'Els teus canvis arriben a tothom amb qui es comparteix.',
                profileSecrets: 'Els valors secrets no viatgen mai · enllaça un Secret desat',
            },
            errors: {
                unavailable: 'Compartir encara no està disponible aquí.',
                ownerOnly: 'Només el propietari o un administrador pot canviar qui hi té accés.',
                noAccess: 'Ja no hi tens accés.',
                notFound: 'Ja no està disponible.',
                subjectUnavailable: 'Aquesta persona, grup o equip no pot rebre accés.',
                failed: 'No s’ha pogut actualitzar la compartició. Torna-ho a provar.',
            },
        },
    } } satisfies Pick<Record<string, ShareSheetTranslations>, "ca">;

return { shareSheetTranslations };
})();

const Domain_sidebarFooterTranslations = (() => {
type SidebarFooterTranslation = Shared_sidebarFooterTranslations.SidebarFooterTranslation;

const sidebarFooterTranslations = { ca: {
        linkToService: ({ service }) => `Vincula amb ${service}`,
        addHomeOrSignIn: 'Afegeix una Home o inicia sessió',
        usageNoAccounts: 'Connecta un compte per veure quant li queda dels seus límits.',
        usageHealthy: 'Queda marge de sobres a tots els límits',
        homeUnreachableTitle: ({ home }) => `No es pot connectar amb ${home}`,
        homeUnreachableBody: 'Les teves màquines i sessions tornaran a aparèixer aquí quan respongui.',
        homeUnreachableLine: ({ home }) => `No es pot connectar amb ${home}.`,
        availableWhenHomeAnswers: "Disponible quan aquest Home respongui.",
        usageKeysWithoutLimits: ({ count }) => count === 1 ? '1 clau sense límits' : `${count} claus sense límits`,
        usageSignedOut: 'Sessió tancada',
        hideAccountIdentities: 'Amaga els correus i els ID dels comptes',
        accountIdentitiesHidden: 'Correus i ID amagats · per a directes i demostracions',
        usageThisSession: 'Aquesta sessió',
        usageAllAccounts: 'Tots els comptes',
        usageMoreAccounts: ({ count }) => `${count} més`,
        usageSessionThroughPool: ({ agent, pool }) => `${agent} inicia sessió a través de ${pool}`,
        usageSessionWithAccount: ({ agent }) => `${agent} inicia sessió amb aquest compte`,
        usageSessionOwnSignIn: ({ agent }) => `${agent} fa servir el seu propi inici de sessió`,
        usagePoolFallback: 'el seu grup',
        usageNextInOrder: ({ account }) => `Quan ${account} s'esgoti, el torn següent passarà al compte següent en ordre`,
        usageNextMostLeft: ({ account }) => `Quan ${account} s'esgoti, el torn següent passarà al compte amb més marge`,
        usageNextStays: ({ pool, account }) => `${pool} es queda amb ${account} fins que canviïs`,
    } } as const satisfies Pick<Record<string, SidebarFooterTranslation>, "ca">;

return { sidebarFooterTranslations };
})();

const Domain_surfaceStateTranslations = (() => {
type SurfaceStateTranslations = Shared_surfaceStateTranslations.SurfaceStateTranslations;

const surfaceStateTranslations = { ca: {
        stillWaiting: ({ seconds }) => `Encara esperant · ${seconds} s`,
        asOf: ({ time }) => `A les ${time}`,
        howItWorks: 'Com funciona',
        tryAgain: 'Torna-ho a provar',
        checkAgain: 'Torna a comprovar',
        paneFailedTitle: 'No s’ha pogut mostrar aquest panell',
        paneFailedReason: 'Alguna cosa ha fallat en dibuixar-lo. La teva sessió no se’n veu afectada.',
        opening: ({ name }) => `Obrint ${name}`,
        couldNotOpen: ({ name }) => `No s’ha pogut obrir ${name}`,
    } } as const satisfies Pick<Record<string, SurfaceStateTranslations>, "ca">;

return { surfaceStateTranslations };
})();

const Domain_teamsTranslations = (() => {
type TeamsTranslationRoot = Shared_teamsTranslations.TeamsTranslationRoot;

const english = Shared_teamsTranslations.english;

const catalan: TeamsTranslationRoot = {
    teams: {
        overview: {
            sessionsSubtitle: 'Les sessions compartides amb aquest equip.',
        },
        pages: {
            credentialCreate: 'Tria què comparteixes, qui ho pot fer servir i els seus límits.',
            credentialDetail: 'Qui pot fer servir aquesta credencial, com i quant.',
            credentialEdit: 'Canvia qui pot fer servir aquesta credencial, com i quant.',
            credentialActivity: 'Els canvis en aquesta credencial i qui els ha fet.',
            credentialUsage: 'Quant s’ha fet servir aquesta credencial i qui l’ha feta servir.',
            credentialExternalApi: 'Fes servir aquesta credencial des d’eines de fora de Happier.',
            identityProviderNew: 'Connecta un proveïdor d’identitat amb què els membres puguin iniciar sessió.',
            identityProviderEdit: 'Canvia com es connecta aquest proveïdor d’identitat.',
            githubApp: 'Una GitHub App que aquest equip fa servir per accedir als repositoris.',
            githubAppEdit: 'Canvia el registre d’aquesta GitHub App.',
            authentication: 'Com inicien sessió els membres en aquest equip i a qui admet.',
            credentials: 'Les credencials de proveïdor que aquest equip comparteix amb els membres.',
            directory: 'Grups de persones que comparteixen sessions, accessos i credencials en un Home.',
            members: 'Qui forma part d’aquest equip i què pot fer cada persona.',
            addMember: 'Afegeix algú que ja tingui un compte en aquest Home.',
            groups: 'Conjunts de membres amb nom per compartir sessions i credencials.',
            newGroup: 'Posa nom al grup i tria qui en forma part.',
            invitations: 'Les invitacions que permeten unir-se a aquest equip i per a qui són.',
            newInvitation: 'Convida algú a unir-se a aquest equip.',
            settings: 'Nom, logotip, valors per defecte de les sessions i si l’equip està actiu.',
        },
        loading: 'S’està carregant l’equip…',
        title: 'Equips',
        entrySubtitle: 'Crea equips, gestiona membres i grups i convida persones.',
        entry: {
            heading: ({ team }: { team: string }) => `Continua a ${team}`,
            onHome: ({ home }: { home: string }) => `a ${home}`,
            signInServiceOrigin: ({ service }: { service: string }) => `Inicia la sessió a través de ${service}`,
            signInServiceUnavailableOrigin: ({ service }: { service: string }) => `L’inici de sessió a través de ${service} no està disponible`,
            signedInTo: ({ home, account }: { home: string; account: string }) => `Sessió iniciada a ${home} com a ${account}`,
            unnamedAccount: 'Compte de Happier',
            continueWith: ({ method }: { method: string }) => `Continua amb ${method}`,
            providerUnavailableTitle: ({ method }: { method: string }) => `${method} no està disponible`,
            providerUnavailableDisabled: 'L’administrador del teu Team ha desactivat aquest inici de sessió. Torna-ho a comprovar més tard.',
            providerUnavailableSetupIncomplete: 'L’administrador del teu Team encara no ha acabat de configurar aquest inici de sessió. Torna-ho a comprovar més tard.',
            providerUnavailableUnavailable: 'Aquest Home no pot fer servir aquest inici de sessió ara mateix. Torna-ho a comprovar més tard.',
            unknownTargetTitle: 'Aquest enllaç no identifica el seu Home',
            unknownTargetBody: 'Aquest dispositiu no pot saber a quin Home pertany aquest enllaç d’accés a l’equip, així que no s’ha enviat res. Demana l’enllaç de nou a qui gestioni l’equip.',
            ssoRequiredTitle: 'Aquest Team necessita un altre mètode d’inici de sessió',
            ssoRequiredBody: 'Has iniciat sessió en aquest Home, però aquest Team només accepta el mètode d’inici de sessió que exigeix. Torna a iniciar sessió amb aquest mètode o torna a la teva feina.',
            invitationUnavailableTitle: 'Aquesta invitació no es pot fer servir',
            invitationUnavailableBody: 'Pot haver caducat, haver estat revocada o ja haver-se fet servir. Iniciar sessió per si sol no t’afegeix al Team.',
            wrongAccountTitle: 'Aquest compte no pot fer servir aquest inici de sessió',
            wrongAccountBody: 'El compte o la identitat amb què has iniciat sessió no és la que aquest Team espera. Inicia sessió amb un altre compte o proveïdor, o torna a la teva feina.',
            notProvisionedTitle: 'Aquest Team encara no t’ha admès',
            notProvisionedBody: 'Iniciar sessió per si sol no t’afegeix a aquest Team. L’administrador decideix qui és admès; demana-li accés o una invitació i torna-ho a provar.',
            directoryDelayedTitle: 'El teu accés encara està de camí',
            directoryDelayedBody: 'Aquest Team rep els seus membres d’un directori que encara no ha lliurat el teu accés. Torna-ho a provar més tard o pregunta a un responsable del Team.',
            accessRemovedTitle: 'Aquest Team no està disponible per a tu',
            accessRemovedBody: 'És possible que el teu accés s’hagi retirat o que el Team no estigui disponible en aquest Home ara mateix. Tota la resta on tens sessió iniciada es manté igual.',
            providerChangedTitle: 'Aquest mètode d’inici de sessió ha canviat mentre el feies servir',
            providerChangedBody: 'Un administrador ha actualitzat aquest mètode d’inici de sessió durant el teu inici de sessió. No s’ha canviat res al teu compte. Torna a començar des de la pàgina del Team per veure els mètodes actuals.',
            returnToTeamSignIn: 'Torna a l’inici de sessió del Team',
            returnToHappier: 'Torna a Happier',
            signInToTeam: 'Inicia la sessió en aquest equip',
            readyStatus: 'Tria com vols iniciar la sessió per continuar.',
        },
        homeLabel: 'Home',
        role: {
            owner: 'Propietari',
            admin: 'Administrador',
            member: 'Membre',
            guest: 'Convidat',
        },
        roleHelp: {
            owner: 'És propietari de l’equip, el pot gestionar i canviar propietaris.',
            admin: 'Té l’accés de Membre i pot gestionar l’equip.',
            member: 'Rep per defecte l’accés concedit a l’equip.',
            guest: 'Només veu les sessions i els recursos compartits explícitament amb aquest compte o amb un grup al qual pertany.',
        },
        status: {
            active: 'Actiu',
            suspended: 'Suspès',
        },
        history: {
            label: 'Historial de sessions',
            allExisting: 'Inclou les sessions ja compartides amb l’equip',
            fromMembership: 'Només les sessions compartides després que s’hi incorpori',
            allExistingNamed: ({ name }) => `Inclou les sessions ja compartides amb ${name}`,
            fromMembershipNamed: ({ name }) => `Només les sessions compartides després que s’incorpori a ${name}`,
            scopeNote: 'Això s’aplica a sessions senceres. No revela només els missatges creats després de la incorporació.',
        },
        unavailable: {
            title: 'Els equips no estan disponibles en aquest Home',
            disabled: 'Aquest Home té els equips desactivats.',
            updateRequired: 'Aquest Home necessita una actualització per fer servir equips.',
            offline: 'Aquest Home no és accessible en aquest moment.',
            retry: 'Torna-ho a provar',
        },
        stale: {
            label: 'Es mostren les darreres dades conegudes d’aquest Home.',
        },
        errors: {
            generic: 'No s’ha pogut completar. No s’ha canviat res.',
            outcomeUnknown: 'És possible que el Home hagi completat aquest canvi. Actualitza l’equip abans de tornar-ho a provar.',
            forbidden: 'No tens permís per a aquest canvi.',
            notFound: 'Aquest equip ja no està disponible.',
            archived: 'Aquest equip està arxivat. Restaura’l per fer-hi canvis.',
            conflict: 'Algú altre ho ha canviat abans. Revisa els valors actuals i torna-ho a provar.',
            offline: 'Aquest Home no és accessible, així que el canvi no s’ha enviat.',
            invalidName: 'Introdueix un nom d’entre 1 i 80 caràcters.',
            invalidDescription: 'Introdueix una descripció de 500 caràcters com a màxim.',
        },
        directory: {
            loading: 'S’estan carregant els equips…',
            chooseTeamToShare: 'Tria l’equip amb qui compartir-ho.',
            noMatches: 'Cap equip coincideix',
            noLoadedMatches: 'Cap equip carregat coincideix',
            searchLoadedPlaceholder: 'Filtra els equips carregats',
            unreachableHomes: 'Sense resposta',
            searchPlaceholder: 'Cerca equips',
            newTeam: 'Equip nou',
            createDenied: ({ homes }: { homes: string }) => `Només els administradors de ${homes} poden crear equips. Demana a un d’ells que en creï un o que t’hi afegeixi.`,
            createAdministered: ({ names }: { names: string }) => `En aquest Home, els equips els creen els seus administradors. Demana a ${names} un equip per a tu, o que tothom pugui crear equips.`,
            createAdministeredUnnamed: 'En aquest Home, els equips els creen els seus administradors. Demana a un d’ells un equip per a tu, o que tothom pugui crear equips.',
            createOff: 'La creació d’equips està desactivada en aquest Home.',
            letEveryoneCreate: 'Permet que tothom creï equips',
            namesAnd: ({ names, last }: { names: string; last: string }) => `${names} i ${last}`,
            namesAndOthers: ({ names, count }: { names: string; count: number }) => `${names} i ${count} més`,
            emptyTitle: 'Encara no hi ha equips',
            emptyBody: 'Un equip ofereix a un grup de persones un espai compartit per a sessions, persones i accessos.',
            archivedSection: 'Equips arxivats',
            archivedEmpty: 'Cap equip arxivat',
            archivedEmptyBody: 'Arxivar un equip des dels seus paràmetres el mou aquí. Els membres, els grups i l’historial es conserven.',
            showArchived: 'Mostra els arxivats',
            hideArchived: 'Amaga els arxivats',
            archivedBadge: 'Arxivat',
            rowAccessibilityLabel: ({ name, role, home }: { name: string; role: string; home: string }) => `${name}, ${role}, a ${home}`,
            partialHomes: 'No s’ha pogut contactar amb alguns Homes, per això falten els seus equips en aquesta llista.',
        },
        create: {
            loading: 'S’està comprovant on pots crear un equip…',
            discard: 'Descarta',
            detailsSection: 'Equip',
            logoFailedBody: 'L’equip s’ha creat, però el logotip no s’ha publicat. Torna-ho a provar o continua sense.',
            title: 'Equip nou',
            nameLabel: 'Nom',
            namePlaceholder: 'Acme',
            descriptionLabel: 'Descripció',
            descriptionPlaceholder: 'En què treballa aquest equip',
            homeHelp: 'L’equip es crea en aquest Home i s’hi queda.',
            duplicateNameNote: 'Dos equips poden compartir nom. Els enllaços i els accessos sempre fan servir l’equip mateix.',
            managedOnlyTitle: 'La creació d’equips s’administra en aquest Home',
            managedOnlyBody: 'Un administrador crea aquí els equips i tria el primer propietari.',
            initialOwnerLabel: 'Primer propietari',
            initialOwnerPlaceholder: 'Cerca persones en aquest Home',
            initialOwnerHelp: 'Crear un equip per a una altra persona no t’hi afegeix.',
            initialOwnerRequired: 'Tria el primer propietari de l’equip. En aquest Home, un administrador designa qui és propietari d’un equip nou.',
            initialOwnerIneligible: 'Aquesta persona ja no pot ser propietària d’un equip. Tria una altra persona.',
            submit: 'Crea l’equip',
            submitting: 'S’està creant…',
            outcomeUnknown: 'No s’ha pogut confirmar si l’equip s’ha creat. Torna-ho a provar per recuperar la mateixa sol·licitud.',
        },
        tabs: {
            overview: 'Resum',
            sessions: 'Sessions',
            members: 'Membres',
            groups: 'Grups',
            invitations: 'Invitacions',
            authentication: 'Autenticació',
            settings: 'Configuració',
        },
        authentication: {
            policy: {
                admissionSection: 'Admissió',
                admissionHelp: 'Com les persones esdevenen membres d\'aquest equip.',
                admissionInviteOnly: 'Només per invitació',
                admissionProvisioned: 'Proveït per un directori',
                admissionJit: 'Automàticament en el primer inici de sessió',
                admissionUnavailable: 'Aquest Home encara no pot aplicar aquest mode d\'admissió, així que no ha canviat res.',
                admissionUnavailableReason: {
                    homePolicyUnavailable: 'Aquest Home no ha posat aquest proveïdor d’inici de sessió a disposició dels equips. Un administrador del Home ho pot canviar.',
                    homePolicyProhibited: 'Un administrador del Home no permet aquest mode d’admissió en aquest Home.',
                    directorySourceRequired: 'Afegeix primer un directori a aquest equip. Aquest mode admet les persones que hi aporta.',
                    directoryProjectionRequired: 'El directori d’aquest equip encara no ha acabat la primera sincronització. Aquest mode estarà disponible quan acabi.',
                    teamConnectionRequired: 'Afegeix primer una connexió d’inici de sessió a aquest equip. L’admissió en el primer inici de sessió en necessita una.',
                    teamConnectionUnavailable: 'Ara mateix cap connexió d’inici de sessió d’aquest equip no es pot fer servir, així que ningú no podria ser admès en iniciar sessió.',
                },
                acceptedSection: 'Inici de sessió acceptat',
                acceptedHelp: 'Quin inici de sessió accepta aquest equip abans de permetre feina de l\'equip.',
                acceptedInherit: 'Fes servir la política del Home',
                acceptedRestricted: 'Només l\'inici de sessió seleccionat a sota',
                connectionsSection: 'Connexions acceptades',
                connectionsEmpty: 'Selecciona almenys una connexió d\'inici de sessió, o fes servir la política del Home.',
                homeMethodRetained: 'Conservat de la política desada',
                repairRequired: 'La restricció d\'inici de sessió desada no es pot llegir',
                repairRequiredHelp: 'No s\'aplica tal com està escrita. Tria una política a sota per substituir-la.',
                conflictBody: 'La política d\'inici de sessió ha canviat en aquest Home. Revisa-la i torna a aplicar el teu canvi.',
                providerTestRequired: 'Prova aquesta connexió abans que l\'equip la pugui exigir.',
                unavailable: 'Aquest Home no pot acceptar aquesta política d\'inici de sessió.',
                approvalPending: 'Esperant aprovació',
                connectionOwnerTeam: "Connexió de l'equip",
                connectionOwnerHome: "Mètode d'inici de sessió del Home",
            },
            subtitle: 'Com demostren la identitat els membres de l’equip.',
            memberSignIn: {
                section: 'Pàgina d’inici de sessió per a membres',
                open: 'Obre la pàgina d’inici de sessió per a membres',
                copyLink: 'Copia l’enllaç',
                shareLink: 'Comparteix l’enllaç',
                qrLabel: 'Codi QR de l’enllaç d’inici de sessió per a membres',
                footer: 'Qualsevol persona amb aquest enllaç arriba a la pàgina d’inici de sessió d’aquest equip. L’enllaç no concedeix res per si mateix: unir-s’hi continua seguint la política d’admissió de l’equip.',
                unavailable: 'Cap enllaç compartible',
                unavailableBody: 'Aquest Home no publica cap adreça web, de manera que no hi ha cap enllaç que funcioni en un altre dispositiu. Un administrador del Home en pot configurar una.',
            },
            connectionsSection: 'Connexions d’inici de sessió',
            empty: 'No hi ha connexions d’inici de sessió',
            status: {
                unavailable: 'No disponible',
                prohibited: 'Bloquejada per la política del Home',
                notConfigured: 'No configurada',
                settingUp: 'S’està configurant',
                connected: 'Activa',
                needsAttention: 'Requereix atenció',
                disabled: 'Desactivada',
            },
            mode: {
                signInOnly: 'Només inici de sessió',
                signInTimeGroups: 'Els grups s’actualitzen en iniciar sessió',
            },
            detail: {
                status: 'Estat',
                mode: 'Modalitat',
                provider: 'Proveïdor',
                restrictions: 'Restriccions d’inici de sessió',
                allowedUsers: 'Usuaris permesos',
                allowedDomains: 'Dominis de correu permesos',
                none: 'Cap',
                configuration: 'Configuració',
                organization: 'Organització',
                connection: 'Connexió',
            },
            directory: {
                actions: {
                    section: 'Accions', sync: 'Sincronitza ara', pause: 'Pausa la sincronització', resume: 'Reprèn la sincronització', remove: 'Elimina el directori…',
                    pauseTitle: ({ source }: { source: string }) => `Vols pausar ${source}?`, pauseBody: 'Els canvis nous del directori s’aturaran. L’accés al Team i les contribucions als Grups coneguts es conserven fins que es reprengui.',
                    removeTitle: ({ source }: { source: string }) => `Vols eliminar ${source}?`, removeBody: ({ teamMembershipsRemoved, groupMembershipsRemoved, groupContributionsRemoved, directoryCreatedGroupsRetained, nativeMembershipsPreserved, nativeGroupContributionsPreserved }: { teamMembershipsRemoved: number; groupMembershipsRemoved: number; groupContributionsRemoved: number; directoryCreatedGroupsRetained: number; nativeMembershipsPreserved: number; nativeGroupContributionsPreserved: number }) => `S’eliminaran ${teamMembershipsRemoved} membres gestionats, ${groupMembershipsRemoved} pertinences efectives als Grups i ${groupContributionsRemoved} contribucions de la font. Es conservaran ${directoryCreatedGroupsRetained} Grups creats pel directori, ${nativeMembershipsPreserved} membres natius i ${nativeGroupContributionsPreserved} contribucions natives. No s’elimina cap Account.`,
                },
                section: "Pertinença gestionada",
                overviewSubtitle: "Les fonts de directori mantenen els membres i els grups de l’Equip alineats amb una organització externa.",
                manageSubtitle: "Revisa les fonts de directori connectades i el seu darrer estat de sincronització.",
                title: "Sincronització de directori",
                sourcesSection: "Fonts de directori",
                sourcesLoadMore: "Carrega més fonts",
                subtitle: "Els canvis de membres només s’apliquen des de projeccions completes del servidor.",
                empty: "No hi ha fonts de directori",
                setup: {
                    section: "Afegeix una font",
                    add: "Tria una font de directori",
                    options: "Configuració de la font",
                    optionsFooter: "Tria un directori o una organització de proveïdor verificat i exacte.",
                    loadMore: "Carrega'n més",
                    empty: "Encara no hi ha opcions de fonts verificades",
                    workos: "Configura la sincronització de directori de WorkOS",
                    workosSubtitle: "Obre el portal d’administració de WorkOS i torna per triar el directori verificat.",
                    confirmTitle: ({ source }: { source: string }) => `Add ${source}?`,
                    confirmBody: "Happier començarà a importar aquest directori després d’afegir-lo.",
                },
                people: {
                    section: "Persones",
                    empty: "No hi ha persones provisionades",
                    provisioned: "Provisionada · Encara sense compte",
                    boundAccountCount: ({ count }: { count: number | string }) => `Comptes vinculats: ${count}`,
                    unboundPeopleCount: ({ count }: { count: number | string }) => `Persones provisionades sense compte: ${count}`,
                    member: "Membre de l’equip",
                    unknown: "Persona sense nom",
                    loadMore: "Carrega més persones",
                    state: {
                        suspended: "Suspesa",
                        deleted: "Suprimida",
                    },
                },
                kind: {
                    workos: "Sincronització de directori WorkOS",
                    github: "Organització de GitHub",
                },
                state: {
                    setup: "Cal configurar-la",
                    syncing: "Sincronitzant",
                    active: "Activa",
                    paused: "En pausa",
                    needsAttention: "Requereix atenció",
                    initializing: "S’està configurant",
                    failed: "L’última sincronització ha fallat",
                },
                mode: {
                    eventsAndFull: "Esdeveniments i reconciliació completa",
                    fullOnly: "Només reconciliació completa",
                },
                freshness: {
                    never_synced: "Mai sincronitzada",
                    fresh: "Actualitzada",
                    stale: "Obsoleta",
                    unknown: "Desconeguda",
                },
                detail: {
                    status: "Estat",
                    sourceType: "Tipus de font",
                    syncSection: "Estat de sincronització",
                    mode: "Mode de sincronització",
                    freshness: "Actualització",
                    lastSuccess: "Darrera sincronització correcta",
                    nextScheduled: "Propera sincronització programada",
                    attentionSection: "Cal atenció",
                    attentionTitle: "Aquesta font de directori requereix atenció",
                    attentionRetryable: "La font es pot recuperar després de reparar-ne la connexió. Actualitza per comprovar-ne l’estat.",
                    attentionAdmin: "Revisa la configuració de la font abans de confiar en nous canvis del directori.",
                },
                never: "Mai",
                unknown: "Desconegut",
            },
        },
        settings: {
            archiveDescription: 'Arxivar treu l’equip de les vistes actives i atura l’accés basat en l’equip. Es conserven els membres, els grups i l’historial, i es pot restaurar.',
            logoSection: 'Logo',
            sessionDefaultsSection: 'Valors per defecte de les sessions',
            externalSharingSection: 'Compartició externa',
            historyDefaultSection: 'Historial per defecte',
            lifecycleSection: 'Cicle de vida de l’equip',
            saved: 'Desat',
        },
        policy: {
            sessionCreationPrivate: 'Privada per defecte',
            sessionCreationTeam: 'Compartida amb l’equip per defecte',
            sessionCreationRequired: 'Sempre compartida amb l’equip',
            sessionCreationHelp: 'Això s’aplica a les sessions noves. Les sessions privades existents no queden exposades.',
            externalSharingAllowed: 'Qualsevol que pugui compartir',
            externalSharingAdmins: 'Només administradors de l’equip',
            externalSharingDisabled: 'No permès',
            externalSharingHelp: 'Pot blocar comparticions futures. No retira les còpies ja compartides.',
            historyDefaultHelp: 'Preselecciona l’opció per als membres nous. No reescriu l’historial dels membres existents.',
        },
        logo: {
            add: 'Afegeix un logotip',
            replace: 'Substitueix el logotip',
            remove: 'Elimina el logotip',
            removeConfirmTitle: 'Vols eliminar aquest logotip?',
            removeConfirmBody: 'L’equip tornarà a mostrar el seu monograma. Pots pujar un logotip nou quan vulguis.',
            previewLabel: 'Previsualització del logotip',
            useAsLogo: 'Fes servir com a logotip',
            monogramLabel: 'Monograma de l’equip',
            tooLarge: 'Aquesta imatge és massa gran. Tria’n una de més petita.',
            invalidFormat: ({ formats }: { formats: string }) => `Aquest fitxer no és una imatge admesa. Formats admesos: ${formats}.`,
            failed: 'El logotip no s’ha pujat. El logotip actual no ha canviat.',
            retry: 'Torna-ho a provar',
        },
        archive: {
            openSettings: 'Obre la configuració',
            action: ({ name }: { name: string }) => `Arxiva ${name}`,
            confirmTitle: ({ name }: { name: string }) => `Vols arxivar ${name}?`,
            confirmBody: ({ name }: { name: string }) => `${name} sortirà de les vistes actives. L’accés basat en l’equip i els grups s’aturarà, i els enllaços d’invitació pendents es revocaran. Les afiliacions, els grups, les polítiques i els permisos existents es conserven. Restaurar ${name} pot tornar a fer efectius aquests permisos conservats.`,
            restoreAction: ({ name }: { name: string }) => `Restaura ${name}`,
            restoreTitle: ({ name }: { name: string }) => `Vols restaurar ${name}?`,
            restoreBody: () => 'Les afiliacions, els grups i els permisos conservats tornaran a ser actius allà on els comptes i els recursos encara ho permetin. Els enllaços d’invitació revocats no tornaran.',
            readOnly: 'Aquest equip està arxivat. Restaura’l per fer-hi canvis.',
        },
        members: {
            membershipSection: 'Pertinença',
            filterLabel: 'Mostra',
            searchPlaceholder: 'Cerca membres',
            filterAll: 'Tots',
            filterOwnersAndAdmins: 'Propietaris i administradors',
            filterMembers: 'Membres',
            filterGuests: 'Convidats',
            filterSuspended: 'Suspesos',
            emptyTitle: 'Cap membre coincideix',
            emptyBody: 'Ajusta el filtre o convida algú a aquest equip.',
            add: 'Afegeix un membre',
            addTitle: ({ team }: { team: string }) => `Afegeix a ${team}`,
            personLabel: 'Persona',
            roleLabel: 'Rol',
            personPlaceholder: 'Cerca persones en aquest Home',
            ineligible: 'Ja és en aquest equip, o no és un compte actiu en aquest Home.',
            addSubmit: 'Afegeix el membre',
            you: 'Tu',
            joined: ({ when }: { when: string }) => `S’hi va incorporar el ${when}`,
            managedBy: ({ source }: { source: string }) => `Gestionat mitjançant ${source}`,
            managedReadOnly: 'Aquesta afiliació es gestiona al seu origen. Canvia-la allà.',
            detailManagedBy: 'Gestionat per',
            managementTitle: 'Origen de gestió',
            managementHelp: 'Canviar l’origen manté aquesta afiliació, el rol, l’estat i l’historial de sessions. Només canvia qui els pot modificar.',
            managementNative: 'Gestionat a Happier',
            managementConflict: 'Aquest origen encara no té cap identitat disponible per a aquesta persona. Sincronitza’l i torna-ho a provar.',
            detailOpenSource: 'Obre la configuració de l’origen',
            encryption: {
                title: 'Accés xifrat',
                checking: 'S’està comprovant l’accés xifrat…',
                ready: 'Preparat',
                scopeBody: 'Això només inclou les sessions que gestiones. És possible que altres responsables encara hagin de preparar l’accés.',
                pending: 'Cal preparar-lo',
                prepare: 'Prepara l’accés xifrat',
                preparing: ({ prepared }: { prepared: number }) => `S’està preparant l’accés xifrat · ${prepared} preparades`,
                setupRequired: 'Cal configuració',
                setupRequiredBody: 'Aquesta persona encara no ha acabat de configurar l’accés xifrat. Podràs preparar-li l’historial de sessions quan ho faci.',
                notEncrypted: 'Sense xifrar',
                plainAccount: 'El compte d’aquesta persona no fa servir xifratge d’extrem a extrem, per tant no hi ha res a preparar.',
                repairRequired: 'L’accés xifrat necessita reparació',
                repairBody: 'Algunes sessions que gestiones no es poden preparar des d’aquest dispositiu. Obre-les per reparar el teu propi accés.',
                nonTransferableBody: 'Algunes sessions fan servir un format de xifratge antic que no es pot compartir amb membres nous. Continuen sent llegibles per a qui ja hi té accés.',
                recipientChanged: 'El compte d’aquesta persona ha canviat. S’està tornant a carregar abans de preparar de nou.',
                retry: 'Torna-ho a provar',
                failed: 'La preparació s’ha aturat abans d’acabar. S’ha conservat tot el que ja estava preparat.',
            },
            detailGroups: 'Grups',
            detailGroupsEmpty: 'Cap grup',
            suspend: 'Suspèn el membre',
            suspendTitle: ({ name }: { name: string }) => `Vols suspendre ${name}?`,
            suspendBody: 'L’accés a l’equip i als grups s’atura immediatament. La pertinença als grups i les assignacions de recursos es conserven, i la reactivació només restaura l’accés que continuï sent vàlid. El compte del Home i els altres equips no es veuen afectats.',
            reactivate: 'Reactiva el membre',
            reactivateTitle: ({ name }: { name: string }) => `Vols reactivar ${name}?`,
            reactivateBody: 'L’accés es reprèn allà on les afiliacions, els grups i l’estat del compte encara ho permetin.',
            remove: 'Treu de l’equip',
            removeTitle: ({ name }: { name: string }) => `Vols treure ${name}?`,
            removeBody: 'L’accés actual a l’equip i als grups s’acaba. S’eliminen les pertinences als grups i els permisos lligats a aquesta afiliació. L’autoria anterior i el contingut ja vist no s’esborren. Tornar-hi més endavant inicia una afiliació nova.',
            lastOwnerBlocked: 'Un equip manté com a mínim un propietari actiu. Tria abans un altre propietari.',
            accountInactive: 'El compte d’aquesta persona no està actiu, així que no es pot afegir ni fer propietària.',
            ownerOnlyAction: 'Només un propietari de l’equip pot canviar els propietaris.',
            ownerRequiredTitle: 'Cal un propietari',
            ownerRequiredBody: ({ team }: { team: string }) => `${team} necessita un propietari actiu per als canvis reservats al propietari.`,
            chooseOwner: 'Tria un propietari',
            ownerRequiredNoCandidate: 'No hi ha cap membre elegible. Cal afegir un membre existent o acordar un traspàs de propietat.',
        },
        groups: {
            detailsSection: 'Grup',
            title: 'Grups',
            emptyTitle: 'Encara no hi ha grups',
            emptyBody: 'Un grup és un conjunt pla de membres de l’equip amb qui pots compartir alhora.',
            emptyRosterTitle: 'Encara no hi ha membres en aquest grup',
            noEligibleCandidatesTitle: 'No hi ha ningú per afegir',
            noEligibleCandidatesBody: 'Aquí apareixen els membres de l’equip que encara no són en aquest grup.',
            create: 'Grup nou',
            nameLabel: 'Nom',
            namePlaceholder: 'Desenvolupament',
            descriptionPlaceholder: 'Per a què serveix aquest grup',
            submit: 'Crea el grup',
            nameTaken: 'Ja hi ha un grup amb aquest nom en aquest equip.',
            memberCount: ({ count }: { count: number }) => `${count} membres`,
            managedBy: ({ source }: { source: string }) => `Gestionat per ${source}`,
            membersSection: 'Membres del grup',
            addMember: 'Afegeix al grup',
            removeNative: 'Treu del grup',
            removeMemberTitle: ({ name, group }: { name: string; group: string }) => `Vols treure ${name} del grup ${group}?`,
            removeMemberBody: ({ name, group }: { name: string; group: string }) => `${name} perd immediatament l’accés que prové de ${group}. Continua al Team i la pots tornar a afegir a aquest grup.`,
            externalOnlyTitle: 'Gestionat al seu origen',
            externalOnlyBody: ({ source }: { source: string }) => `${source} continua aportant aquesta persona, per això es manté al grup. Canvia-ho a la configuració d’aquest origen.`,
            archiveAction: ({ name }: { name: string }) => `Arxiva ${name}`,
            archiveTitle: ({ name }: { name: string }) => `Vols arxivar ${name}?`,
            archiveBody: 'L’accés basat en el grup s’atura immediatament. La pertinença i l’historial es conserven, i restaurar el grup pot tornar a fer efectius aquests permisos.',
            restoreAction: ({ name }: { name: string }) => `Restaura ${name}`,
            archivedSection: 'Grups arxivats',
            archivedReadOnly: 'Aquest grup està arxivat. Restaura’l per fer-hi canvis.',
            managedReadOnly: 'El nom i el cicle de vida d’aquest grup es gestionen al seu origen. Encara hi pots afegir membres.',
        },
        invitations: {
            emptyTitle: 'Cap invitació',
            emptyBody: 'Convida algú amb un enllaç o afegeix una persona que ja tingui compte en aquest Home.',
            invite: 'Convida',
            inviteTitle: ({ team }: { team: string }) => `Convida a ${team}`,
            byLink: 'Enllaç',
            byEmail: 'Correu',
            emailLabel: 'Adreça de correu',
            emailPlaceholder: 'nom@exemple.com',
            create: 'Crea la invitació',
            linkNotice: ({ team, role }: { team: string; role: string }) => `Qualsevol persona amb la sessió iniciada en aquest Home que tingui aquest enllaç pot unir-se a ${team} com a ${role}.`,
            copyLink: 'Copia l’enllaç',
            copied: 'Enllaç copiat',
            qrLabel: 'Codi QR d’aquest enllaç d’invitació',
            qrTooLargeFallback: 'Aquest enllaç és massa llarg per a un codi QR. Copia’l en lloc d’això.',
            linkRow: 'Enllaç d’invitació',
            maskedRecipient: ({ email }: { email: string }) => `Per a ${email}`,
            expires: ({ when }: { when: string }) => `Caduca el ${when}`,
            stateActive: 'Activa',
            stateAccepted: 'Acceptada',
            stateRevoked: 'Revocada',
            stateExpired: 'Caducada',
            deliverySent: 'Correu lliurat al proveïdor',
            deliveryFailed: 'Ha fallat l’enviament del correu',
            deliveryUnknown: 'Resultat de l’enviament desconegut',
            deliveryRetry: 'Torna-ho a provar',
            deliveryChangeEmail: 'Canvia el correu',
            emailUnavailable: 'L’enviament de correu no està disponible en aquest Home. Comparteix un enllaç en lloc d’això.',
            reissue: 'Crea un enllaç nou',
            reissueNotice: 'Reemetre crea un enllaç nou. L’enllaç anterior deixarà de funcionar.',
            revoke: 'Revoca la invitació',
            revokeTitle: 'Vols revocar aquesta invitació?',
            revokeBody: 'L’enllaç deixa de funcionar immediatament. Pots crear-ne un de nou quan vulguis.',
            shareLink: 'Comparteix l’enllaç',
            shareUnavailable: 'Compartir no està disponible en aquest dispositiu. Copia l’enllaç.',
            bearerUnavailable: 'Aquest enllaç s’ha mostrat una sola vegada i no es desa. Crea un enllaç nou per tornar a compartir l’accés.',
            linkUnavailableRow: 'Cap enllaç per compartir',
            linkUnavailableBody: 'Aquest Home no ha publicat cap adreça a la qual puguin apuntar els enllaços d’invitació, així que no hi ha cap enllaç per compartir. Demana a un administrador del Home que en publiqui una, o afegeix persones des de la llista Persones de la Team.',
        },
        join: {
            previewLoading: 'S’està comprovant aquesta invitació…',
            joinAction: ({ team }: { team: string }) => `Uneix-te a ${team}`,
            joinWithCurrentAccount: 'Uneix-te amb aquest compte',
            addInvitedAddressNotice: ({ email }: { email: string }) => `${email} s’afegirà com a adreça verificada a aquest compte.`,
            useAnotherAccount: 'Fes servir un altre compte',
            useCurrentAccount: 'Fes servir el compte actual',
            useAnotherAccountHint: 'Inicia la sessió en aquest Home sense tancar la sessió d’aquest compte.',
            hostedOn: ({ home }: { home: string }) => `Allotjat a ${home}`,
            personalHomeNotice: 'Aquest Home s’executa en un ordinador personal i pot no estar disponible mentre estigui fora de línia.',
            plainStorageNotice: 'Les sessions d’aquest Home es desen sense xifratge d’extrem a extrem.',
            invitedBy: ({ name }: { name: string }) => `Invitació enviada per ${name}.`,
            roleOffered: ({ role }: { role: string }) => `Se t’ha convidat com a ${role}.`,
            guestNotice: ({ team }: { team: string }) => `Unir-se com a convidat no dona accés a les sessions d’equip de ${team}. Els elements s’han de compartir amb tu o amb un dels teus grups.`,
            joinedTitle: 'T’hi has unit',
            alreadyMemberTitle: 'Ja en ets membre',
            openTeam: ({ team }: { team: string }) => `Obre ${team}`,
            expiredTitle: 'Aquesta invitació ha caducat',
            revokedTitle: 'Aquesta invitació s’ha revocat',
            usedTitle: 'Aquesta invitació ja s’ha fet servir',
            archivedTitle: 'Aquest equip està arxivat',
            inactiveTitle: 'Aquest compte no s’hi pot unir ara mateix',
            invalidTitle: 'Aquest enllaç d’invitació no és vàlid',
            unresolvedHomeTitle: 'Aquest enllaç no identifica el seu Home',
            unresolvedHomeBody: 'Aquest dispositiu no pot saber quin Home ha emès aquesta invitació, així que no s’ha enviat res. Demana un enllaç nou a qui gestioni l’equip.',
            unknownHomeTitle: 'Aquest Home encara no és en aquest dispositiu',
            askForNew: 'Demana una invitació nova a un responsable de l’equip.',
            mismatchTitle: 'Aquesta invitació és per a una altra adreça',
            signInWithInvited: 'Inicia la sessió amb l’adreça convidada',
            verifyAddress: 'Verifica aquesta adreça',
            updateRequiredTitle: 'Aquest Home necessita una actualització per fer servir invitacions d’equip',
            offlineTitle: 'Aquest Home no és accessible',
            offlineBody: 'La invitació es conserva. Torna-ho a provar quan el Home torni a estar disponible.',
            acceptanceOutcomeUnknown: 'No s’ha pogut confirmar si t’has unit. Torna-ho a provar per comprovar la mateixa invitació.',
            retry: 'Torna-ho a provar',
        },
        credentials: {
            recovery: {
                openSettings: 'Obre la configuraci\u00f3 de la credencial',
                selectBroker: 'Tria una ubicaci\u00f3 de broker',
                ownerHandoff: 'Demana al propietari de la font que repari aquesta credencial',
                updateApp: 'Actualitza Happier',
                chooseAnother: 'Tria una altra credencial',
            },
            requestPolicy: {
                title: 'Política de sol·licituds',
                subtitle: 'Limita què es pot demanar a aquesta credencial.',
                summaryNone: 'Sense restriccions',
                summaryActive: ({ count }: { count: number }) => `${count} restriccions`,
                protocolsLabel: 'Formats de sol·licitud',
                protocolsAny: 'Tots els que admeti la font',
                modelsLabel: 'Models',
                modelsAny: 'Tots els models que ofereix la font',
                modelsAllowed: ({ count }: { count: number }) => `${count} permesos`,
                effortLabel: 'Esforç de raonament',
                effortAny: 'Tots els que admeti la font',
                catalogUnavailable: 'Triar quins models es permeten encara no es pot fer des d’aquest Home. Les opcions actuals continuen vigents fins que s’eliminin.',
                clear: 'Treu totes les restriccions',
                activeNote: 'Una sessió que ja s’està executant no es reescriu. La seva propera sol·licitud haurà de complir la nova política.',
                protocol: {
                    openaiResponses: 'OpenAI Responses',
                    openaiChatCompletions: 'OpenAI Chat Completions',
                    anthropicMessages: 'Anthropic Messages',
                },
            },
            directReadiness: {
                title: 'Preparació de l’accés directe',
                check: 'Comprova la preparació',
                summary: ({ ready, pending }: { ready: number; pending: number }) => `${ready} a punt · ${pending} preparant-se`,
                allReady: 'Tothom qui té accés directe està a punt.',
                automatic: 'El material es prepara a l’ordinador que té aquesta font, tan bon punt està en línia.',
                state: {
                    ready: 'A punt',
                    preparing: 'Preparant l’accés',
                    notDelivered: 'Encara no lliurat',
                    recipientBindingChanged: 'Esperant la configuració del compte xifrat',
                    sourceChanged: 'La font ha canviat: s’està actualitzant',
                },
            },
            externalApi: {
                title: 'Accés a l’API externa',
                subtitle: 'Fes servir aquest proveïdor des d’eines compatibles fora de Happier.',
                privateTitle: 'Sessions de Happier',
                privateDetail: 'Privat a través de Happier',
                unavailable: 'L’accés a l’API externa no està disponible en aquest Home.',
                publicHttpsRequired: 'Les eines externes necessiten una adreça HTTPS pública per a aquest Home.',
                homeDisclosure: 'Els cossos sense processar de les sol·licituds al proveïdor passen pel punt final HTTPS públic d’aquest Home i el seu operador els pot llegir.',
                bearerDisclosure: 'Aquesta clau és un secret al portador. Qui la tingui pot utilitzar l’accés assignat fins que caduqui o es revoqui.',
                usageDisclosure: 'Happier registra el nombre de sol·licituds. Els totals de tokens i costos poden ser incomplets si un protocol no els informa.',
                keysTitle: 'Claus d’API',
                authorize: 'Autoritza la clau',
                authenticationRequired: 'El membre assignat ha d’autoritzar aquesta clau amb l’inici de sessió de l’equip.',
                authenticationUnavailable: 'L’autenticació de l’equip no està disponible. Demana a un administrador que revisi la política d’inici de sessió.',
                keysLoadFailed: 'No s’han pogut carregar les claus d’API.',
                keysRetry: 'Torna a carregar les claus',
                keysEmpty: 'Encara no hi ha claus',
                keysEmptyBody: 'Crear la primera clau activa l’accés extern; revocar l’última el desactiva.',
                labelPlaceholder: 'Per a què serveix aquesta clau',
                assignLabel: 'Atribuïda a',
                revealTitle: 'Desa aquesta clau ara',
                revealBody: 'No es tornarà a mostrar.',
                revealDismiss: {
                    title: 'Voleu tancar sense copiar la clau?',
                    body: 'Aquesta clau no es podrà tornar a mostrar. Manteniu-la visible fins que l’hàgiu desat.',
                    confirm: 'He desat la clau',
                    keepVisible: 'Mantén la clau visible',
                },
                neverUsed: 'No s’ha fet servir mai',
                lastUsed: ({ when }: { when: string }) => `Últim ús ${when}`,
                expiresOn: ({ when }: { when: string }) => `Caduca ${when}`,
                expired: 'Caducada',
                revokeTitle: ({ name }: { name: string }) => `Voleu revocar ${name}?`,
                revokeBody: 'Les eines que fan servir aquesta clau deixen de funcionar immediatament. Les sessions de Happier no es veuen afectades.',
                revokeAll: 'Revoca totes les claus',
                revokeAllBody: 'L’accés a l’API externa es desactiva fins que es creï una clau nova. Les sessions de Happier no es veuen afectades.',
            },
            title: 'Credencials compartides',
            subtitle: 'Permet que aquest equip faci servir un compte connectat, un pool o un prove\u00efdor sense copiar-lo a la configuraci\u00f3 de cada persona.',
            emptyTitle: 'Encara no hi ha credencials compartides',
            emptyBody: 'Encara no s\u2019ha compartit res amb aquest equip.',
            forbidden: 'Les credencials compartides les gestionen els propietaris i administradors d\u2019aquest equip.',
            unavailable: 'Aquest Home no ofereix credencials compartides.',
            approvalPending: 'A l’espera d’aprovació. Els canvis es conserven fins que es decideixi.',
            approvalDeclined: 'Aquesta sol·licitud no s’ha aprovat, així que no ha canviat res.',
            sessionDeniedTitle: 'Una credencial compartida ha rebutjat aquesta sol·licitud',
            sharedByYou: 'Compartida per tu',
            providedByTeams: 'Proporcionat pels equips',
            sharedWithYou: 'Compartit amb tu',
            sourceAdministration: { title: 'Compartit amb equips', empty: 'Aquesta font no es comparteix amb cap equip.' },
            source: {
                connectedAccount: 'Compte connectat',
                pool: 'Pool de serveis connectats',
                providerConnection: 'Connexi\u00f3 de prove\u00efdor',
            },
            delivery: {
                brokered: 'Amb intermediari',
                direct: 'Acc\u00e9s directe',
                both: 'Intermediari + directe',
                mixed: 'Lliurament mixt',
            },
            state: {
                available: 'Disponible',
                needsAttention: 'Necessita atenci\u00f3',
                disabled: 'Desactivada',
            },
            usePolicy: {
                title: 'Vols compartir aquesta sessió amb l’Equip?',
                label: 'On la poden fer servir els membres',
                personalAllowed: 'Qualsevol sessi\u00f3 permesa',
                teamContextRequired: 'Sessions l\u2019equip de les quals \u00e9s aquest',
                teamVisibilityRequired: 'Sessions que aquest equip pot veure',
                visibilityNote: 'Triar aquesta credencial pot compartir una sessi\u00f3 privada amb l\u2019equip despr\u00e9s que la persona ho confirmi.',
            },
            selection: {
                activeTransitionUnsupported: 'Aquesta sessió s’ha iniciat abans que el canvi es desés, així que el model no ha canviat. Torna-ho a provar.',
            },
            detail: {
                sourceLabel: 'Origen',
                brokerLabel: 'Ubicaci\u00f3 de l\u2019intermediari',
                brokerNone: 'Tria una ubicació de l’intermediari',
                access: 'Acc\u00e9s i lliurament',
                activity: 'Activitat',
                edit: 'Edita',
                notFound: 'Aquesta credencial compartida ja no est\u00e0 disponible.',
                brokerUnnamedMachine: 'Ordinador sense nom',
                brokerUnnamedPool: 'Grup sense nom',
                brokerChosen: 'Triada per qui posseeix la font',
                limits: 'Límits d’ús',
                usage: 'Consum',
            },
            create: {
                title: 'Comparteix una credencial',
                action: 'Comparteix credencial',
                submit: 'Crea la credencial compartida',
                sourceChoose: 'Tria una font',
                sourceEmpty: 'Encara no hi ha res per compartir.',
                sourceUnsupported: 'Els comptes connectats i les connexions de proveïdor encara no es poden compartir des d’aquest Home.',
                alreadyShared: 'Ja es comparteix amb aquest equip',
                poolAccounts: ({ count }: { count: number }) => `${count} comptes`,
                notAllowed: 'Aquest equip no et deixa oferir una credencial teva.',
                reviewLabel: 'Resum',
            },
            edit: {
                title: 'Edita la credencial compartida',
                nameLabel: 'Nom',
                namePlaceholder: 'Posa nom a aquesta credencial',
                ceilingLabel: 'Divulgaci\u00f3 directa',
                ceilingBrokeredOnly: 'Nom\u00e9s amb intermediari',
                ceilingDirectAllowed: 'Permet l\u2019acc\u00e9s directe',
                ceilingNote: 'L\u2019acc\u00e9s directe permet que les eines locals de qui la rep obtinguin material de credencial. Treure l\u2019acc\u00e9s atura els lliuraments futurs, per\u00f2 no esborra el que un proc\u00e9s extern ja ha fet servir.',
                conflict: 'Aquests par\u00e0metres han canviat en un altre lloc. Torna a carregar per veure\u2019n els valors actuals abans de desar.',
            },
            audience: {
                title: 'Acc\u00e9s i lliurament',
                none: 'Encara ning\u00fa',
                everyone: 'Tot l\u2019equip',
                everyoneOff: 'Sense acc\u00e9s per a tot l\u2019equip',
                groupCount: ({ count }: { count: number }) => `${count} grups`,
                memberCount: ({ count }: { count: number }) => `${count} persones`,
                add: 'Afegeix un grup o una persona',
                groupsSection: 'Grups',
                membersSection: 'Persones',
                remove: 'Treu l\u2019acc\u00e9s',
                ceilingBlocked: 'L\u2019acc\u00e9s directe no est\u00e0 perm\u00e8s per a aquesta credencial. Permet-lo abans a Edita.',
                directTitle: 'Vols compartir aquesta credencial directament?',
                directBody: 'Les eines locals de les persones que triïs poden rebre material de credencial d\u2019aquest origen. Treure l\u2019acc\u00e9s atura els lliuraments futurs, per\u00f2 no esborra el que un proc\u00e9s extern ja ha fet servir.',
                directConfirm: 'Comparteix directament',
                keepBrokered: 'Mant\u00e9n amb intermediari',
                limitsNote: 'L\u2019\u00fas directe passa fora de Happier i no queda registrat.',
            },
            directUse: {
                title: 'Vols fer servir directament aquesta credencial compartida?',
                body: 'Happier pot proporcionar material de la credencial a les eines locals que utilitza aquesta sessi\u00f3. Continua nom\u00e9s si confies aquestes credencials a les eines.',
            },
            delete: {
                action: 'Elimina la credencial compartida',
                title: ({ name }: { name: string }) => `Vols eliminar ${name}?`,
                body: 'Els membres perden l\u2019acc\u00e9s immediatament i la petici\u00f3 seg\u00fcent falla. El material ja lliurat directament no es pot esborrar.',
            },
            errors: {
                featureDisabled: 'Aquest Home no ofereix credencials compartides.',
                teamAuthenticationRequired: 'Inicia la sessi\u00f3 en aquest equip abans de continuar.',
                teamAuthenticationPolicyUnavailable: 'No s\u2019ha pogut llegir la pol\u00edtica d\u2019acc\u00e9s d\u2019aquest equip, aix\u00ed que no s\u2019ha canviat res.',
                memberNotEligible: 'Aquesta persona no pot fer servir aquesta credencial.',
                sessionPolicyIncompatible: 'Aquesta credencial no es pot fer servir en aquesta sessi\u00f3 amb la seva pol\u00edtica de compartici\u00f3.',
                brokerUnavailable: 'La màquina intermediària d’aquesta credencial no és accessible ara mateix. Torna-ho a provar quan torni o tria una altra ubicació.',
                sourceOwnerRequired: 'Només qui posseeix aquesta font pot fer aquest canvi.',
                sourceMissing: 'Aquesta credencial ja no apunta a cap font existent. Qui la posseeix ha de tornar a triar-la.',
                invalidAudience: 'Aquestes persones o grups no poden rebre aquesta credencial.',
                subjectNotInTeam: 'Aquesta persona o grup ja no és en aquest equip.',
                costUnavailable: 'Un límit de cost necessita un preu per a cada model permès, i a alguns els en falta. Limita sol·licituds o tokens.',
                invalidLimit: 'Revisa la mesura, el període i el màxim.',
                limitIdentityImmutable: 'A qui s’aplica un límit, què mesura i el seu període no es poden canviar. Elimina’l i afegeix-ne un de nou.',
            },
            limits: {
                groupShared: 'Aquesta quantitat la comparteixen tots els membres del Grup.',
                title: 'Límits d’ús',
                empty: 'Encara no hi ha límits',
                emptyBody: 'Totes les sol·licituds es permeten fins que n’afegeixis un.',
                overshoot: 'Les sol·licituds noves s’aturen quan el consum registrat arriba al límit. Les que ja s’estan executant poden acabar.',
                directNote: 'Els límits cobreixen l’ús amb intermediari i l’API externa. L’ús directe passa a la màquina de qui el rep i no es registra.',
                directOnly: 'Tothom qui hi té accés fa servir aquesta credencial de manera directa, a la seva pròpia màquina, així que Happier no en registra res i cap límit no s’hi pot aplicar.',
                requestLimitsOnlyForPersonalUse: 'Els límits de tokens apareixen quan aquesta credencial exigeix un context d’equip. L’ús personal també l’obre a execucions en segon pla i a l’API externa, que només informen de sol·licituds, així que només els límits de sol·licituds cobreixen tot l’ús.',
                add: 'Afegeix un límit',
                subjectLabel: 'S’aplica a',
                subject: {
                    resource: 'Tota la credencial compartida',
                    eachMember: 'Cada persona per separat',
                    group: 'Grup',
                    member: 'Persona',
                },
                metricLabel: 'Mesura',
                metric: {
                    requests: 'Sol·licituds',
                    tokens: 'Tokens',
                    cost: 'Cost',
                },
                costNote: 'Un límit de cost només funciona si cada model permès té un preu conegut.',
                periodLabel: 'Període',
                period: {
                    day: 'Diari',
                    week: 'Setmanal',
                    month: 'Mensual',
                },
                maximumLabel: 'Màxim',
                maximumPlaceholder: 'Màxim per període',
                maximumInvalid: 'Introdueix un nombre enter més gran que zero.',
                maximumInvalidCost: 'Introdueix un import més gran que zero.',
                recorded: ({ recorded, maximum }: { recorded: string; maximum: string }) => `${recorded} de ${maximum} registrat`,
                resetsUtc: ({ when }: { when: string }) => `Es reinicia el ${when} UTC`,
                reached: 'Límit assolit',
                disabled: 'Desactivat',
                remove: 'Elimina el límit',
                removeTitle: 'Vols eliminar aquest límit?',
                removeBody: 'Les sol·licituds deixen de comparar-s’hi immediatament. El consum registrat es conserva.',
                unknownSubject: 'Algú fora d’aquesta pàgina',
            },
            usage: {
                title: 'Consum',
                empty: 'No hi ha res registrat en aquest període.',
                rangeLabel: 'Període',
                brokeredRequests: 'Sol·licituds intermediades',
                directOnlyRequests: 'Les sol·licituds només es compten en l’ús intermediat.',
                recordedRequests: 'Sol·licituds registrades',
                requestIncomplete: 'Només s’inclouen les sol·licituds observades per Happier.',
                externalObservationsIncomplete: ({ count }: { count: number }) => `${count} ${count === 1 ? 'sol·licitud externa encara no té' : 'sol·licituds externes encara no tenen'} cap resultat registrat.`,
                breakdownRestricted: 'Algunes desagregacions només es mostren a qui gestiona credencials.',
                export: 'Exporta CSV',
                exportFailed: 'Aquest dispositiu no ha pogut desar l’exportació.',
                recordedByHappier: 'Registrat per Happier.',
                directIncomplete: 'L’ús directe passa fora de Happier i pot no estar inclòs.',
                costIncomplete: 'El cost no està disponible per a alguns models en aquest període.',
                tokenIncomplete: 'El total de tokens és incomplet per a aquest període.',
                tokenUnavailable: 'No s’ha observat cap ús de tokens en aquest període.',
                costUnavailable: 'No s’ha observat cap ús amb preu en aquest període.',
                costUnknown: 'No disponible',
                breakdownLabel: 'Desglossa per',
                breakdownNone: 'Només totals',
                breakdown: {
                    member: 'Persona',
                    externalApiKey: 'Clau d’API externa',
                    model: 'Model',
                    session: 'Sessió',
                    sourceMember: 'Compte d’origen',
                    workerMachine: 'Màquina d’execució',
                    brokerMachine: 'Màquina intermediària',
                    deliveryMode: 'Lliurament',
                },
                limitsTitle: 'Límits en aquest període',
                sliceSummary: ({ requests, tokens }: { requests: string; tokens: string }) => `${requests} sol·licituds · ${tokens} tokens`,
            },
            activity: {
                title: 'Activitat',
                empty: 'Encara no hi ha canvis administratius registrats.',
                unknownActor: 'Alg\u00fa',
                kind: {
                    resourceCreated: 'Ha compartit aquesta credencial',
                    resourceUpdated: 'Ha canviat els par\u00e0metres',
                    audienceChanged: 'Ha canviat qui la pot fer servir',
                    resourceDeleted: 'Ha eliminat aquesta credencial',
                    directDelivered: 'Ha lliurat acc\u00e9s directe',
                    externalKeyCreated: 'Ha creat una clau d\u2019API externa',
                    externalKeyRevoked: 'Ha revocat una clau d\u2019API externa',
                    limitsChanged: 'Ha canviat els l\u00edmits',
                },
            },
        },
    },
};

const teamsTranslations = { ca: catalan };

return { teamsTranslations };
})();

const Domain_terminalWorkspaceTranslations = (() => {
const en = Shared_terminalWorkspaceTranslations.en;

const terminalWorkspaceKeyboardTranslations = Shared_terminalWorkspaceTranslations.terminalWorkspaceKeyboardTranslations;

const terminalWorkspaceTranslations = { ca: en };

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

const ca: ThisComputerConnectionTranslation = {
    connectHome: {
        title: ({ home }: HomeParams) => `Vols connectar aquest ordinador a ${home}?`,
        body: ({ home }: HomeParams) => `${home} podrà iniciar sessions en aquest ordinador. El Home del terminal i les altres connexions es mantenen.`,
        connect: 'Connecta',
        keep: 'Mantén les connexions actuals',
    },
    setupAlreadyRunning: 'Ja hi ha una configuració en curs. Espera que acabi.',
    title: {
        daemon_url_mismatch: 'El servei en segon pla és en un altre Home',
        daemon_account_mismatch: 'El servei en segon pla fa servir un altre compte',
        daemon_needs_auth: 'El servei en segon pla ha d’iniciar la sessió',
        daemon_not_configured: 'El servei en segon pla encara no està connectat',
        daemon_not_installed: 'El servei en segon pla no està instal·lat',
        daemon_not_running: 'El servei en segon pla està aturat',
    },
    description: {
        daemon_url_mismatch: ({ home, daemonHome }: OtherHomeParams) => `Està connectat a ${daemonHome}, no a ${home}.`,
        daemon_account_mismatch: ({ home, daemonAccount, appAccount }: AccountParams) =>
            `Té la sessió iniciada a ${home} com a ${daemonAccount}, no com a ${appAccount}.`,
        daemon_needs_auth: ({ home }: HomeParams) => `Està connectat a ${home}, però encara no s’ha aprovat.`,
        daemon_not_configured: ({ home }: HomeParams) => `Encara no ha acabat de connectar-se a ${home}.`,
        daemon_not_installed: ({ home }: HomeParams) => `Instal·la’l per connectar aquest ordinador a ${home}.`,
        daemon_not_running: ({ home }: HomeParams) => `Inicia’l per tornar a connectar-te a ${home}.`,
    },
    action: {
        daemon_url_mismatch: 'Connecta a aquest Home',
        daemon_account_mismatch: ({ appAccount }: { appAccount: string }) => `Canvia a ${appAccount}`,
        daemon_needs_auth: 'Inicia la sessió',
        daemon_not_configured: 'Connecta a aquest Home',
        daemon_not_installed: 'Instal·la el servei en segon pla',
        daemon_not_running: 'Inicia el servei en segon pla',
    },
    connected: ({ home, appAccount }: { home: string; appAccount: string }) => `Connectat a ${home} com a ${appAccount}.`,
    noComputers: ({ home, appAccount }: { home: string; appAccount: string }) => `${appAccount} encara no té cap ordinador a ${home}.`,
    openThisComputer: 'Revisa aquest ordinador',
    moveConfirm: {
        title: ({ appAccount }: { appAccount: string }) => `Vols canviar aquest ordinador a ${appAccount}?`,
        body: ({ home, daemonHome, daemonAccount, appAccount }: MoveParams) =>
            `El seu servei en segon pla té la sessió iniciada a ${daemonHome} com a ${daemonAccount}. Després del canvi treballarà per a ${appAccount} a ${home}, i ${daemonAccount} deixarà de veure aquest ordinador.`,
        confirm: 'Canvia',
    },
    cli: {
        title: 'CLI de Happier',
        version: ({ version }: { version: string }) => `Versió ${version}`,
        updateAvailable: ({ version, latestVersion }: { version: string; latestVersion: string }) =>
            `Versió ${version} · ${latestVersion} disponible`,
        update: 'Actualitza',
        progressTitle: 'S’està actualitzant la CLI de Happier',
        notManaged: ({ origin }: { origin: string }) => `Instal·lada fora de Happier: ${origin}`,
    },
    cliChoice: {
        title: ({ version }: { version: string }) => `La CLI de Happier ${version} ja està instal·lada`,
        titleUnknownVersion: 'La CLI de Happier ja està instal·lada',
        titleMissing: 'La teva CLI de Happier ja no està instal·lada',
        body: ({ path }: { path: string }) => `És a ${path}. Happier pot instal·lar-ne la seva pròpia còpia, mantenir-la al dia i posar-la la primera al PATH, o pots continuar fent servir aquesta.`,
        bodyOutdated: ({ path }: { path: string }) => `És a ${path} i és massa antiga per a la configuració. Happier pot instal·lar-ne una còpia actualitzada i posar-la la primera al PATH, o pots conservar la teva i actualitzar-la tu mateix.`,
        bodyMissing: ({ path }: { path: string }) => `Vas triar conservar la que hi havia a ${path}, i ja no hi és. Happier pot instal·lar-ne la seva pròpia còpia i mantenir-la al dia, o pots reinstal·lar la teva i continuar fent-la servir.`,
        bodyKeepBlocked: ({ path, link }: { path: string; link: string }) => `És a ${path}, però els terminals nous executen primer la CLI de Happier a través de ${link}, que Happier no va afegir. Deixa que Happier gestioni la línia d’ordres, o elimina ${link} i torna a executar la configuració per conservar la teva.`,
        notNow: 'Ara no',
        manage: 'Deixa que Happier la gestioni',
        keep: 'Conserva la meva',
        unanswered: 'La configuració s’ha aturat abans de canviar res. Tria qui gestiona la línia d’ordres per continuar.',
        ownMissing: 'La línia d’ordres que vas conservar ja no està instal·lada. Torna-la a instal·lar o deixa que Happier gestioni la línia d’ordres.',
        managed: 'Gestionada per Happier',
        own: ({ path }: { path: string }) => `La teva — ${path}`,
        change: 'Canvia qui gestiona la línia d’ordres',
        keptUpdateTitle: 'Actualitza la teva línia d’ordres',
        keptUpdate: ({ command }: { command: string }) => `Hi ha una versió més recent. Actualitza-la amb ${command}`,
        oldCopyTitle: 'Línia d’ordres antiga',
        oldCopyRemove: ({ path, command }: { path: string; command: string }) => `Encara instal·lada a ${path}. Elimina-la amb ${command}`,
        oldCopyPath: ({ path }: { path: string }) => `Encara instal·lada a ${path}.`,
    },
    servers: {
        title: 'Homes als quals dona servei aquest ordinador',
        connected: 'Connectat',
        offline: 'Configurat · Sense connexió',
        attention: 'Necessita atenció',
        currentHome: ({ home }: HomeParams) => `${home} · aquest Home`,
    },
    removal: {
        uninstallFailedTitle: 'No s’ha pogut desconnectar aquest ordinador',
        uninstallFailedBody: ({ home }: HomeParams) => `No s’ha pogut treure el servei en segon pla d’aquest ordinador per a ${home}, així que s’ha conservat ${home}. Torna-ho a provar o treu el servei a Configuració › Aquest ordinador.`,
        inventoryUnavailableTitle: 'No s’ha pogut comprovar aquest ordinador',
        inventoryUnavailableBody: ({ home }: HomeParams) => `Happier no ha pogut llegir els serveis en segon pla d’aquest ordinador, així que no sap si aquest ordinador encara serveix ${home}. Vols treure’l de Happier igualment?`,
        removeAnyway: 'Treu igualment',
        userOwnedTitle: 'Aquest ordinador el continua servint',
        userOwnedBody: ({ home, service }: RemovalServiceParams) => `${service} es va instal·lar fora de Happier, així que continua funcionant per a ${home}. Treu-lo des del terminal si ja no el necessites.`,
    },
};

const thisComputerConnectionTranslations = { ca };

return { thisComputerConnectionTranslations };
})();

const Domain_transcriptFindTranslations = (() => {
const transcriptFindTranslations = { ca: { searchOlder: 'Cerca missatges anteriors', partialErrors: 'No s’ha pogut cercar en part del contingut. Els resultats són incomplets.', olderRemaining: 'Queden missatges anteriors sense cercar.', findOpen: 'Obre la cerca', findNext: 'Coincidència següent', findPrevious: 'Coincidència anterior' } } as const;

return { transcriptFindTranslations };
})();

const Domain_turnChangesTranslations = (() => {
type TurnChangesTranslations = Shared_turnChangesTranslations.TurnChangesTranslations;

const en = Shared_turnChangesTranslations.en;

const translated = Shared_turnChangesTranslations.translated;

const turnChangesTranslations = { ca: {
        turnChanges: {
            card: translated({
                edited: ({ count }) => `${count === 1 ? 'Fitxer editat' : 'Fitxers editats'}: ${count}`,
                walkThrough: 'Explica-m’ho',
                openInFiles: 'Obre a Fitxers',
                fileCount: ({ count }) => `${count} ${count === 1 ? 'fitxer' : 'fitxers'}`,
                fileCountInFolders: ({ count, folders }) => `${count} ${count === 1 ? 'fitxer' : 'fitxers'} en ${folders} carpetes`,
                showMore: ({ count }) => `Mostra’n ${count} més`,
                groupA11y: 'Canvis en aquest torn',
            }),
        },
    } } as const;

return { turnChangesTranslations };
})();

const Domain_voiceDiagnosticsConsentTranslations = (() => {
type VoiceDiagnosticsConsentCopy = Shared_voiceDiagnosticsConsentTranslations.VoiceDiagnosticsConsentCopy;

const defineVoiceDiagnosticsConsentTranslation = Shared_voiceDiagnosticsConsentTranslations.defineVoiceDiagnosticsConsentTranslation;

const voiceDiagnosticsConsentTranslations = { ca: defineVoiceDiagnosticsConsentTranslation({
    consentTitle: 'Vols enregistrar àudio de veu en aquest dispositiu?',
    consentBody: 'L’àudio de veu pot contenir converses privades i sons de fons. Els fitxers es mantenen al dispositiu, utilitzen permisos privats, caduquen automàticament i mai se sincronitzen ni s’adjunten a analítiques o informes d’errors.',
    consentAction: 'Activa l’enregistrament',
  }) } as const;

return { voiceDiagnosticsConsentTranslations };
})();

const Domain_voiceDiagnosticsTranslations = (() => {

type VoiceDiagnosticsCopy = Shared_voiceDiagnosticsTranslations.VoiceDiagnosticsCopy;

const voiceDiagnosticsConsentTranslations = {...Domain_voiceDiagnosticsConsentTranslations.voiceDiagnosticsConsentTranslations};

const defineVoiceDiagnostics = Shared_voiceDiagnosticsTranslations.defineVoiceDiagnostics;

const voiceDiagnosticsTranslations = { ca: defineVoiceDiagnostics(voiceDiagnosticsConsentTranslations["ca"].diagnostics, {
    title: 'Diagnòstics de veu locals',
    footer: 'Desactivat per defecte. L’àudio es manté a la màquina seleccionada fins que l’exportis explícitament.',
    enabled: 'Enregistra àudio de diagnòstic local',
    enabledSubtitle: 'Conserva localment entrades d’STT i sortides de TTS acotades per a la resolució de problemes',
    sttInput: 'Enregistra l’entrada de reconeixement de veu',
    ttsOutput: 'Enregistra la veu sintetitzada',
    location: 'Ubicació d’emmagatzematge',
    unavailable: 'Màquina seleccionada no disponible',
    retention: 'Límits de retenció',
    retentionDetail: ({ hours, files, megabytes }) => `${hours} hores · ${files} fitxers · ${megabytes} MB`,
    deleteAll: 'Suprimeix tot l’àudio de diagnòstic',
    deleteAllSubtitle: 'Elimina immediatament l’àudio i les metadades de la màquina seleccionada',
    deleteConfirmTitle: 'Vols suprimir tots els diagnòstics de veu locals?',
    deleteConfirmBody: 'Això elimina permanentment tots els artefactes de diagnòstic de veu de la màquina seleccionada.',
    deleteAction: 'Suprimeix-ho tot',
    deleteFailed: 'No s’han pogut suprimir els enregistraments de diagnòstic locals. És possible que encara siguin a la màquina seleccionada.',
    cleanupRequired: 'La neteja de diagnòstics locals necessita atenció',
    cleanupRequiredSubtitle: 'És possible que quedin fitxers de diagnòstic privats o que no s’hagi pogut llegir el catàleg local. Torna a provar la neteja o suprimeix tot l’àudio de diagnòstic.',
    captureFailed: 'La captura de diagnòstic necessita atenció',
    captureFailedSubtitle: 'No s’ha pogut llegir ni desar l’última captura d’àudio de diagnòstic. No s’ha detectat cap fitxer de diagnòstic residual; la propera captura de veu elegible tornarà a comprovar l’estat.',
    retryCleanup: 'Torna a provar la neteja de diagnòstics',
    retryCleanupSubtitle: 'Torna a comprovar el magatzem privat i hi aplica de nou els límits de retenció',
    cleanupRetryFailed: 'No s’ha pogut completar la neteja. És possible que encara hi hagi fitxers de diagnòstic a la màquina seleccionada; torna-ho a provar o suprimeix-ho tot quan es torni a connectar.',
    exportTitle: 'Exporta els diagnòstics seleccionats',
    noArtifacts: 'No hi ha enregistraments de diagnòstic conservats a la màquina seleccionada.',
    exportSttArtifact: 'Exporta l’entrada de reconeixement de veu',
    exportTtsArtifact: 'Exporta la veu sintetitzada',
    exportArtifactAccessibility: 'Exporta aquest enregistrament de diagnòstic de veu local',
    exportConfirmTitle: 'Vols exportar aquest enregistrament privat?',
    exportConfirmBody: 'Això copia l’enregistrament seleccionat de la màquina seleccionada a aquest dispositiu mitjançant una transferència xifrada d’un sol ús. Mai no es puja automàticament.',
    exportAction: 'Exporta l’enregistrament',
    exportFailed: 'No s’ha pogut exportar l’enregistrament privat. No s’ha pujat res.',
    backupPolicy: 'Exclusió de les còpies de seguretat',
    backupPolicyBestEffort: 'Es desa a la memòria cau privada de la màquina seleccionada i es marca per a les eines de còpia de seguretat que respecten l’estàndard de directori de memòria cau. No s’implementa cap pujada ni sincronització automàtica; l’exclusió de les còpies de seguretat del sistema operatiu no està garantida.',
    activeIndicator: 'Diagnòstics de veu activats',
    checkingIndicator: 'S’està comprovant l’estat dels diagnòstics de veu',
    statusUnknownIndicator: 'L’estat dels diagnòstics de veu es desconeix',
    shutdownPendingIndicator: 'S’estan aturant els diagnòstics de veu',
    shutdownFailedIndicator: 'No s’ha pogut confirmar que els diagnòstics de veu estiguin desactivats',
    retryShutdown: 'Torna a provar d’aturar els diagnòstics',
    sessionOptOut: 'No enregistris aquesta sessió',
    sessionOptOutConfirmTitle: 'Vols deixar d’enregistrar aquesta sessió?',
    sessionOptOutConfirmBody: 'Els diagnòstics de veu continuen activats per a altres sessions, però no s’enregistrarà cap àudio nou d’aquesta sessió fins que es reiniciï l’app.',
    sessionOptOutFailed: 'No s’ha pogut aturar l’enregistrament a la màquina activa. És possible que aquesta sessió encara s’estigui enregistrant; torna-ho a provar quan la màquina es torni a connectar.',
    sessionOptOutRetry: 'Torna a provar d’aturar l’enregistrament',
  }) } as const;

return { voiceDiagnosticsTranslations };
})();

const Domain_voiceExternalCredentialApprovalTranslations = (() => {
type VoiceExternalCredentialApprovalCopy = Shared_voiceExternalCredentialApprovalTranslations.VoiceExternalCredentialApprovalCopy;

const defineVoiceExternalCredentialApproval = Shared_voiceExternalCredentialApprovalTranslations.defineVoiceExternalCredentialApproval;

const voiceExternalCredentialApprovalTranslations = { ca: defineVoiceExternalCredentialApproval({
    reviewRequired: 'Revisa l’accés a les credencials',
    recipientApprovalTitle: 'Vols permetre que aquest proveïdor utilitzi la teva credencial?',
    recipientApprovalBody: 'Revisa i aprova els punts finals i les operacions declarats del proveïdor. Si aquest contracte del destinatari canvia, Happier manté la teva selecció però bloqueja l’ús de la credencial fins que la tornis a aprovar.',
    recipientApprovalPackage: ({ title, pluginId, sourceKind, sourceLocator }) =>
      `Paquet: ${title} (${pluginId}); font: ${sourceKind} ${sourceLocator}`,
    recipientApprovalPublisher: ({ trust, identity }) => `Editor: ${identity} (${trust})`,
    recipientApprovalPackageSignature: ({ status, keyId }) => `Signatura del paquet: ${keyId} (${status})`,
    recipientApprovalContribution: ({ pluginId, localId }) => `Contribució: ${pluginId}/${localId}`,
    recipientApprovalOperations: 'Operacions declarades:',
    recipientApprovalOperation: ({ id, purpose, effect }) =>
      `Operació ${id}: finalitat ${purpose}; efecte ${effect}`,
    recipientApprovalRequest: ({ method, origin, pathTemplate }) => `Sol·licitud: ${method} ${origin}${pathTemplate}`,
    recipientApprovalCredential: ({ headerName, format }) =>
      `Capçalera de la credencial: ${headerName}; format: ${format}`,
    recipientApprovalBounds: ({ requestMaxBytes, responseMaxBytes }) =>
      `Límits de bytes: sol·licitud ${requestMaxBytes}; resposta ${responseMaxBytes}`,
    recipientApprovalTrust: { bundled: 'integrat', verified: 'verificat' },
    recipientApprovalEffect: { read: 'lectura', mutation: 'mutació' },
    recipientApprovalCredentialFormat: { raw: 'en brut', bearer: 'bearer' },
    recipientApprovalConfirm: 'Aprova i desa',
  }) } as const;

return { voiceExternalCredentialApprovalTranslations };
})();

const Domain_voiceLocalCredentialTranslations = (() => {
type VoiceLocalCredentialCopy = Shared_voiceLocalCredentialTranslations.VoiceLocalCredentialCopy;

const defineVoiceLocalCredential = Shared_voiceLocalCredentialTranslations.defineVoiceLocalCredential;

const voiceLocalCredentialTranslations = { ca: defineVoiceLocalCredential({
    voiceCredential: {
      setOnAccount: 'Desada al teu compte',
      notSetOnAccount: 'No desada al teu compte',
      setOnMachineOverride: ({ machine }) => `S’utilitza una substitució de credencial del compte per a ${machine}`,
      notSetWithFallback: ({ machine }) => `No definida per a ${machine}; s’utilitzarà una credencial del compte quan estigui disponible`,
      plainStorageTitle: 'Vols desar la clau de l’API sense xifratge d’extrem a extrem?',
      plainStorageBody: 'Aquest compte desa la configuració sense xifratge d’extrem a extrem. Si deses aquesta clau de l’API, el seu text en clar serà visible per al servidor.',
      plainStorageConfirm: 'Desa la clau de l’API',
      deleteAccountBody: 'Vols suprimir aquesta clau de l’API desada? Els altres enllaços que fan referència al mateix secret desat la conservaran.',
      machineUnavailable: 'Selecciona una màquina d’execució de veu en línia',
      machineUnavailableTitle: 'Màquina de veu no disponible',
      machineUnavailableBody: 'Tria una màquina d’execució de veu en línia abans de desar o utilitzar aquesta credencial.',
      statusUnavailable: ({ machine }) => `L’estat de la credencial no està disponible a ${machine}. Toca per tornar-ho a provar.`,
      importAvailable: ({ machine }) => `Hi ha una clau anterior per importar a ${machine}`,
      notSetOnMachine: ({ machine }) => `No definida a ${machine}`,
      setOnMachine: ({ machine, protection }) => `Definida a ${machine} · ${protection}`,
      protection: { osProtected: 'Protegida pel sistema operatiu', filePermissions: 'Protegida pels permisos de fitxer' },
      importTitle: 'Vols importar la clau de l’API existent?',
      importBody: ({ machine }) => `Copia la configuració del compte xifrada existent a ${machine}. L’original continua disponible per als teus altres dispositius.`,
      importAction: 'Importa',
      enterNewAction: 'Introdueix-ne una de nova',
      useSavedSecretTitle: 'Utilitza un secret desat',
      useSavedSecretSubtitle: 'Tria una clau ja emmagatzemada en aquest compte.',
      replaceOrRemoveBody: 'Introdueix una clau de l’API nova o deixa-ho en blanc per suprimir la clau d’aquesta màquina.',
      deleteTitle: 'Vols suprimir la clau de l’API?',
      deleteBody: ({ machine }) => `Vols suprimir aquesta clau de l’API de ${machine}? L’antic valor compartit entre dispositius, si n’hi ha, no es modifica.`,
      operationFailed: 'La màquina seleccionada no ha pogut actualitzar aquesta credencial. Comprova que estigui en línia i torna-ho a provar.',
      newCredentialRequired: ({ machine }) => `Cal una credencial de màquina nova a ${machine}`,
    },
    openAiCompatEndpoint: {
      executionMachine: ({ machine }) => `Les sol·licituds s’executen a ${machine}. Localhost fa referència a aquesta màquina.`,
      insecureTitle: 'Vols permetre HTTP local no segur?',
      insecureBody: ({ origin, machine }) => `Vols permetre que s’enviïn credencials per HTTP a ${origin} des de ${machine}? Localhost fa referència a ${machine}. Només s’accepten adreces de bucle local i de xarxa privada; l’HTTP públic es rebutja.`,
      allowAction: 'Permet HTTP',
      invalidBody: 'Introdueix un URL HTTPS, o bé un URL HTTP de bucle local o de xarxa privada sense nom d’usuari, contrasenya ni cadena de consulta.',
    },
  }) } as const;

return { voiceLocalCredentialTranslations };
})();

const Domain_voiceMomentsTranslations = (() => {
type VoiceMomentsTranslation = Shared_voiceMomentsTranslations.VoiceMomentsTranslation;

const voiceMomentsTranslations = { ca: {
        setupTitle: 'Configura la veu',
        setupTileSubtitle: 'Parla en veu alta amb les teves sessions. Quatre passos curts.',
        setupTileProgress: ({ done, total, next }) => `${done} de ${total} fets · ${next}`,
        setupNextService: 'ara tria qui escolta',
        setupNextReadiness: 'ara acaba el servei',
        setupNextMicrophone: 'ara permet el micròfon',
        setupNextTry: 'ara prova-ho',
        setupNextInstalling: 'instal·lant',
        setupStart: 'Configura',
        setupContinue: 'Continua',
        setupDescription: 'Parla en veu alta amb les teves sessions: pregunta què passa, comença feina, decideix des d’on sigui. Quatre passos; pots marxar i tornar.',
        setupLightCaption: ({ done, total }) => `${done} de ${total} a punt`,
        setupServiceTitle: 'Tria qui escolta',
        setupServiceDetail: 'Què t’escolta i et respon. Ho pots canviar més tard.',
        setupChange: 'Canvia',
        setupReadinessTitle: ({ service }) => `Acaba de configurar ${service}`,
        setupReadinessDone: ({ service }) => `${service} està a punt`,
        setupReadinessGeneric: 'El servei',
        setupReadinessTitleGeneric: 'Prepara el servei',
        setupReadinessUnknown: 'Obre’n la configuració per veure què li falta.',
        setupReadinessCheck: 'Comprova la configuració',
        setupMicrophoneTitle: 'Permet el micròfon',
        setupMicrophoneDetail: 'El dispositiu ho pregunta un cop. Happier només escolta mentre la veu està activa, i sempre ho pots veure.',
        setupMicrophoneAction: 'Permet el micròfon',
        setupMicrophoneDone: 'Micròfon permès',
        setupMicrophoneDeniedTitle: 'El micròfon està desactivat per a Happier',
        setupMicrophoneDeniedDetail: 'Activa’l a la configuració del sistema i torna aquí.',
        setupOpenSystemSettings: 'Obre la configuració',
        setupTryTitle: 'Prova-ho',
        setupTryDetail: 'Pregunta «Què fan les meves sessions?». Les teves paraules arriben a la conversa com qualsevol missatge.',
        setupTryAction: 'Prova-ho',
        setupTryDone: 'Provat',
        setupTryNeedsService: 'Disponible quan el servei estigui a punt.',
        setupDoneTitle: 'La veu està a punt',
        setupDoneBody: 'Toca el botó de veu en qualsevol xat per començar a parlar i torna’l a tocar per acabar. Silenciar és al costat de Finalitzar mentre parles.',
        setupGestureTap: 'Toca',
        setupGestureStartEnd: 'inicia · acaba',
        setupGestureAnywhere: 'inicia · acaba des d’on sigui',
        setupDoneAction: 'Fet',
        setupSettingsAction: 'Configuració de la veu',
        setupClose: 'Tanca',
        needsYouEnded: 'La veu ha acabat. L’aprovació encara és pendent a la Safata.',
        needsYouReview: 'Revisa la sol·licitud',
        needsYouTapToDecide: 'Llegit en veu alta · decideix aquí, no amb la veu',
        briefMe: 'Posa’m al dia',
        briefMeA11y: 'Posa’m al dia: la veu llegeix què et necessita, què ha fallat i què està a punt',
        briefNeedsYou: 'Et necessita',
        briefFailed: 'Ha fallat',
        briefReady: 'A punt',
        briefIncomplete: 'Encara no s’ha carregat tota la feina, així que potser no hi és tot.',
        briefCaughtUp: 'Ara mateix res no et necessita.',
        briefNotSpoken: 'La veu no ho pot llegir ara mateix. La llista és tota aquí.',
        briefStop: 'Atura',
        continueTitle: 'Continua parlant aquí',
        continueDetail: ({ device }) => `Parlaves des de ${device}`,
        continueAction: 'Continua',
        continuedOn: ({ device }) => `Ha continuat a ${device}`,
        continuedElsewhere: 'Ha continuat en un altre dispositiu',
        continuedHere: 'Ha continuat en aquest dispositiu',
        dismiss: 'Descarta',
    } } satisfies Pick<Readonly<Record<string, VoiceMomentsTranslation>>, "ca">;

return { voiceMomentsTranslations };
})();

const Domain_voicePresenceTranslations = (() => {
type VoicePresenceTranslation = Shared_voicePresenceTranslations.VoicePresenceTranslation;

const voicePresenceTranslations = { ca: {
        welcomeText: "Hola, t'escolto — què t'agradaria fer?",
        greetingLiteralUnavailable: "Amb aquest idioma de resposta, el servei espera que parlis.",
        title: 'Veu',
        howYouTalk: "Com parles",
        holdToTalkTitle: "Mantén premut per parlar",
        holdToTalkDescription: "Mantén premuda la marca de Voice per dir una cosa; deixa-la anar per enviar. Tocar continua iniciant i acabant Voice.",
        holdToTalkHint: "Mantén premut per a un torn; deixa anar per enviar. Arrossega per cancel·lar.",
        holdToTalkUnavailable: ({ service }) => `${service} no permet mantenir premut per parlar. Toca per parlar.`,
        talkWithVoice: 'Parla amb la Veu',
        dictate: 'Dicta',
        globalVoice: 'Veu global',
        interrupt: 'Interromp',
        options: 'Opcions de Veu',
        you: 'Tu',
        showConversation: 'Mostra la conversa',
        dragToMove: 'Arrossega per moure',
        openConversation: 'Obre la conversa',
        settings: 'Configuració de la Veu',
        ended: 'La Veu ha acabat',
        muted: 'Silenciat',
        setUp: 'Configura la Veu',
        setUpHint: 'Obre la configuració de la Veu per triar com parla',
        startAgain: 'Torna a començar',
        endedCaption: ({ elapsed }) => `${elapsed} · la conversa s'ha desat`,
        dismiss: 'Descarta',
        mute: "Silencia",
        unmute: "Activa el so",
        end: "Acaba",
        captions: { connecting: "Obrint el canal d'àudio", listening: "Endavant", transcribing: "Passant-ho a text", thinking: "Pensant una resposta", speaking: "Pots interrompre quan vulguis", interrupted: "Endavant", muted: "Activa el so per parlar · la Veu encara pot parlar", reconnecting: "S'ha perdut la connexió · tornant-ho a provar", blocked: "Permet l'accés al micròfon per parlar", failed: "Torna-ho a provar o revisa la configuració de la Veu" },
        recovery: { allow: "Permet", setUp: "Configura" },
        containerA11y: ({ status }) => `Veu, ${status}`,
    } } satisfies Pick<Readonly<Record<string, VoicePresenceTranslation>>, "ca">;

return { voicePresenceTranslations };
})();

const Domain_voiceProviderPrivacyTranslations = (() => {
const voiceProviderPrivacyTranslations = { ca: {
    openai: {
      privacyDisclosure: 'L’àudio i el contingut de la conversa s’envien des d’aquest dispositiu a OpenAI mitjançant WebRTC. Quan les funcions corresponents estan activades o s’utilitzen, OpenAI també pot rebre des d’aquest dispositiu actualitzacions acotades del context de Voice, crides a eines del client i els seus resultats. Happier utilitza la clau de Voice API desada, el servei connectat d’OpenAI o el compte experimental Codex OAuth seleccionats per obtenir autenticació de client de curta durada; els comptes connectats s’utilitzen mitjançant la màquina seleccionada. OpenAI processa la conversa al compte seleccionat i pot conservar les dades rebudes segons la configuració del compte i els termes d’OpenAI. El servidor i el relay de Happier no transporten l’àudio en directe. Els controls per compartir context de Voice són independents d’aquest tractament del proveïdor.',
    },
    xai: {
      privacyDisclosure: 'L’àudio i el contingut de la conversa s’envien des d’aquest dispositiu a xAI mitjançant la connexió xAI Realtime. Quan les funcions corresponents estan activades o s’utilitzen, xAI també pot rebre des d’aquest dispositiu actualitzacions acotades del context de Voice, crides a eines del client i els seus resultats. Happier utilitza la clau API d’xAI desada als secrets del teu compte de Happier només per a les operacions acotades d’autenticació de client i catàleg de veus. xAI processa la conversa en aquest compte i pot conservar les dades rebudes segons la configuració del compte i els termes d’xAI. Si la represa està activada, Happier desa l’identificador de conversa del proveïdor; oblidar-lo elimina l’identificador desat per Happier i no elimina les dades conservades per xAI. El servidor i el relay de Happier no transporten l’àudio en directe. Els controls per compartir context de Voice són independents d’aquest tractament del proveïdor.',
    },
    speechProcessing: {
      deviceStt: 'L’àudio és processat pel servei de reconeixement de veu del navegador o del sistema operatiu. Segons la plataforma i el servei configurat, el processament pot tenir lloc fora del dispositiu.',
      deviceTts: 'El text de la resposta és processat pel servei de síntesi de veu del navegador o del sistema operatiu. Segons la plataforma i el servei configurat, el processament pot tenir lloc fora del dispositiu.',
    },
    fields: {
      resumption: {
        title: 'Desa l’identificador de represa d’xAI',
        subtitle: 'Permet que Happier desi l’identificador temporal de conversa d’xAI per tornar a connectar.',
      },
    },
    resumption: {
      confirmTitle: 'Vols desar l’identificador de represa d’xAI?',
      confirmBody: 'Happier desarà l’identificador de conversa d’xAI durant un màxim de {minutes} minuts per poder reprendre una conversa interrompuda. Això no modifica ni elimina les dades conservades per xAI.',
      confirmAction: 'Desa l’identificador',
      forgetTitle: 'Oblida l’identificador de represa de Happier',
      forgetSubtitle: 'Elimina l’identificador de conversa del proveïdor desat per Happier. Això no elimina la conversa ni les dades conservades per xAI.',
      forgotten: 'Happier ha eliminat l’identificador de conversa del proveïdor desat.',
      unsupported: 'Happier no pot eliminar d’aquesta sessió l’identificador de conversa del proveïdor desat.',
      failed: 'Happier no ha pogut eliminar l’identificador de conversa del proveïdor desat. Torna-ho a provar.',
    },
  } } as const;

return { voiceProviderPrivacyTranslations };
})();

const Domain_voiceReadinessTranslations = (() => {
type VoiceReadinessCopy = Shared_voiceReadinessTranslations.VoiceReadinessCopy;

const defineVoiceReadinessTranslation = Shared_voiceReadinessTranslations.defineVoiceReadinessTranslation;

const voiceReadinessTranslations = { ca: defineVoiceReadinessTranslation({
    ready: 'La funció de veu està a punt.',
    permissionAnnouncement: ({ summary }) => `La sessió de codi necessita permís per a ${summary}. Revisa-ho a la interfície de la sessió per aprovar-ho o denegar-ho.`,
    userActionAnnouncement: ({ question }) => `La sessió de codi necessita la teva resposta. ${question}`,
    userActionFallback: 'La sessió de codi necessita la teva resposta. Respon la pregunta perquè pugui continuar.',
    requestedTool: 'l’eina sol·licitada',
    provider_unselected: 'Tria un proveïdor de veu.',
    contribution_unavailable: 'Aquest proveïdor de veu ja no està disponible.',
    role_unsupported: 'Aquest proveïdor no admet el mode de veu seleccionat.',
    platform_unsupported: 'Aquest proveïdor de veu no està disponible en aquesta plataforma.',
    settings_unsupported_version: 'Actualitza aquest proveïdor abans de fer-lo servir amb la funció de veu.',
    settings_unknown: 'No s’ha pogut comprovar la configuració del proveïdor.',
    settings_needs_migration: 'Revisa la configuració actualitzada del proveïdor.',
    settings_invalid: 'Revisa la configuració no vàlida del proveïdor.',
    settings_missing_required_setting: ({ service }) => `Acaba de configurar ${service} per començar.`,
    provider_mode_unknown: 'Tria un mode compatible amb aquest proveïdor.',
    server_feature_disabled: 'El servidor ha desactivat aquest proveïdor de veu.',
    server_feature_installing: 'El servidor està preparant la compatibilitat amb la funció de veu.',
    server_feature_incompatible: 'El servidor no és compatible amb aquest proveïdor de veu.',
    server_feature_unknown: 'No s’ha pogut comprovar si el servidor admet aquest proveïdor de veu.',
    execution_machine_missing: 'Tria una màquina que pugui executar aquest proveïdor de veu.',
    execution_machine_installing: 'La màquina d’execució de veu seleccionada encara s’està preparant.',
    execution_machine_incompatible: 'La màquina seleccionada no és compatible amb aquest proveïdor de veu.',
    execution_machine_unknown: 'No s’ha pogut comprovar la màquina d’execució de veu.',
    daemon_unreachable: 'La màquina seleccionada no té cap ruta disponible per a l’àudio de veu.',
    daemon_relay_disabled: 'La màquina seleccionada necessita el relé d’àudio de veu, però el seu ús està desactivat.',
    daemon_relay_capped: 'La capacitat del relé d’àudio de veu no està disponible ara per a la màquina seleccionada.',
    credential_missing: 'Afegeix la credencial que necessita aquest proveïdor de veu.',
    credential_approval_required: 'Revisa l’accés a la credencial abans d’utilitzar aquest proveïdor de veu.',
    credential_installing: 'La credencial del proveïdor encara s’està preparant.',
    credential_incompatible: 'La credencial seleccionada no és compatible amb aquest proveïdor de veu.',
    credential_unknown: 'No s’ha pogut comprovar la credencial del proveïdor.',
    endpoint_missing: 'Configura el punt final que necessita aquest proveïdor de veu.',
    endpoint_installing: 'El punt final del proveïdor de veu encara s’està preparant.',
    endpoint_incompatible: 'El punt final configurat no és compatible amb aquest proveïdor de veu.',
    endpoint_unknown: 'No s’ha pogut comprovar el punt final del proveïdor de veu.',
    runtime_missing: 'Instal·la l’entorn d’execució que necessita aquest proveïdor de veu.',
    runtime_installing: 'L’entorn d’execució del proveïdor de veu encara s’està instal·lant.',
    runtime_incompatible: 'L’entorn d’execució instal·lat no és compatible amb aquest proveïdor de veu.',
    runtime_unknown: 'No s’ha pogut comprovar l’entorn d’execució del proveïdor de veu.',
    model_missing: 'Instal·la o tria un model per a aquest proveïdor de veu.',
    model_installing: 'El model de veu seleccionat encara s’està instal·lant.',
    model_incompatible: 'El model seleccionat no és compatible amb aquest proveïdor de veu.',
    model_unknown: 'No s’ha pogut comprovar el model del proveïdor de veu.',
    device_stt_unavailable: 'El reconeixement de veu no està disponible en aquest dispositiu.',
    device_stt_availability_unknown: 'Encara s’està comprovant la disponibilitat del reconeixement de veu.',
    short: {
      needsSetup: 'Cal configurar',
      needsKey: 'Cal una clau',
      needsApproval: 'Cal la teva aprovació',
      offOnServer: 'Desactivat en aquest servidor',
      needsComputer: 'Cal un ordinador',
      needsAddress: 'Cal una adreça',
      needsModel: 'Cal un model',
      installing: 'S\'està instal·lant',
      notInstalled: 'No instal·lat',
      unavailableHere: 'No disponible aquí',
      needsUpdate: 'Cal actualitzar',
      cantCheck: 'Encara sense comprovar',
    },
    actions: {
      select_provider: 'Triar un proveïdor',
      open_provider_settings: "Acaba la configuració",
      select_execution_machine: 'Triar una màquina',
      configure_credential: 'Afegir credencials',
      review_credential_access: 'Revisar l’accés a la credencial',
      configure_endpoint: 'Configurar el punt final',
      install_model: 'Instal·lar un model',
      switch_provider: 'Triar un altre proveïdor',
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

const voiceRealtimeProviderSetupTranslations = { ca: defineVoiceRealtimeProviderSetup(voiceProviderPrivacyTranslations["ca"], {
    xai: {
      setup: { footer: 'La teva clau de l’API d’xAI es desa com a secret desat sincronitzat als secrets del teu compte de Happier. Només es materialitza per a l’operació acotada d’xAI Realtime.' },
      credential: { promptBody: 'Enganxa una clau de l’API d’xAI. Happier la protegeix com a secret desat sincronitzat i només la materialitza per a l’operació acotada d’xAI Realtime.' },
    },
    setup: {
      title: 'Configuració de la veu en temps real',
      footer: 'La teva clau de l’API es desa a la màquina d’execució seleccionada i mai no s’inclou a la configuració de veu sincronitzada.',
    },
    credential: {
      title: 'Clau de l’API desada',
      promptTitle: 'Connecta la veu en temps real',
      promptBody: 'Enganxa una clau de l’API d’OpenAI Platform. Es protegeix als secrets sincronitzats del teu compte i només es materialitza en emetre credencials de client de Realtime de curta durada.',
    },
    authentication: {
      sectionTitle: 'Autenticació d’OpenAI Realtime',
      title: 'Font d’autenticació',
      subtitle: 'Tria exactament una font. Happier mai no recorre a una altra clau ni a un altre compte.',
      footer: 'L’ús de l’API d’OpenAI Realtime el factura OpenAI Platform. Una subscripció a ChatGPT o Codex no implica facturació ni accés a l’API de Realtime. A la conversa per WebRTC només s’hi passen credencials de client de curta durada.',
      savedSecret: {
        title: 'Clau de l’API de veu desada',
        subtitle: 'Utilitza la clau de l’API desada als secrets del compte de Happier Voice. No cal cap dimoni.',
      },
      openAiApiKey: {
        title: 'Servei connectat d’OpenAI',
        subtitle: 'Utilitza el perfil o grup de comptes amb clau de l’API d’OpenAI estàndard seleccionat mitjançant la màquina triada i el seu dimoni connectat.',
      },
      openAiCodex: {
        title: 'OpenAI Codex OAuth (experimental)',
        subtitle: 'Utilitza el perfil o grup de comptes de Codex OAuth seleccionat mitjançant la màquina triada i el seu dimoni connectat. Happier mai no recorre a una altra clau ni a un altre compte.',
      },
      account: {
        title: 'Compte connectat',
        subtitle: 'Tria el perfil o grup de comptes exacte que s’utilitzarà a la propera conversa.',
      },
      chooseAccount: 'Tria un compte',
      referenceRequired: 'Tria un perfil o grup de comptes connectat.',
      connected: 'Compte connectat a punt',
      unavailable: 'El compte seleccionat no està disponible o cal tornar-lo a connectar',
    },
    invalidValue: 'Aquest proveïdor no admet aquest valor.',
    advanced: { show: 'Mostra la configuració avançada', hide: 'Amaga la configuració avançada' },
    fields: {
      model: { title: 'Model', subtitle: 'Tria el model de veu en temps real.' },
      voice: { title: 'Veu', subtitle: 'Tria la veu que s’utilitza a les respostes.' },
      instructions: {
        title: 'Instruccions de veu',
        subtitle: 'Instruccions opcionals de comportament i personalitat.',
        promptTitle: 'Instruccions de veu',
        promptBody: 'Escriu instruccions opcionals per a aquesta sessió de veu.',
      },
      turnDetection: {
        title: 'Detecció de torn',
        subtitle: 'Tria com detecta el proveïdor el final del teu torn.',
        threshold: {
          title: 'Llindar de VAD',
          subtitle: 'Sensibilitat a l’activitat de veu; deixa-ho en blanc per al valor del proveïdor.',
          promptTitle: 'Llindar de VAD',
          promptBody: 'Introdueix un valor de 0.1 a 0.9, o deixa-ho en blanc.',
        },
        silenceDurationMs: {
          title: 'Durada del silenci',
          subtitle: 'Mil·lisegons de silenci abans d’acabar un torn.',
          promptTitle: 'Durada del silenci',
          promptBody: 'Introdueix de 0 a 10000 mil·lisegons, o deixa-ho en blanc.',
        },
        prefixPaddingMs: {
          title: 'Marge abans de la parla',
          subtitle: 'Mil·lisegons que es conserven abans de la parla detectada.',
          promptTitle: 'Marge abans de la parla',
          promptBody: 'Introdueix de 0 a 10000 mil·lisegons, o deixa-ho en blanc.',
        },
        idleTimeoutMs: {
          title: 'Temps d’espera de resposta per inactivitat',
          subtitle: 'Si vols, demana a xAI que iniciï una resposta després d’aquest silenci.',
          promptTitle: 'Temps d’espera de resposta per inactivitat',
          promptBody: 'Introdueix de 1 a 600000 mil·lisegons, o deixa-ho en blanc per desactivar les respostes automàtiques per inactivitat.',
          confirmTitle: 'Vols activar les respostes automàtiques per inactivitat?',
          confirmBody: 'Després del silenci configurat, xAI pot crear una resposta per iniciativa pròpia i consumir ús de l’API.',
          confirmAction: 'Activa',
        },
      },
      transcriptionModel: {
        title: 'Model de transcripció',
        subtitle: 'Model opcional de transcripció de l’entrada.',
        promptTitle: 'Model de transcripció',
        promptBody: 'Introdueix un id de model, o deixa-ho en blanc per al valor del proveïdor.',
      },
      reasoning: { title: 'Raonament', subtitle: 'Tria l’esforç de raonament per als models compatibles.' },
      outputSpeed: {
        title: 'Velocitat de parla',
        subtitle: 'Ajusta la velocitat de parla del proveïdor.',
        promptTitle: 'Velocitat de parla',
        promptBody: 'Introdueix un valor de 0.7 a 1.5.',
      },
      languageHint: {
        title: 'Pista d’idioma',
        subtitle: 'Si vols, ajuda la transcripció a identificar el teu idioma.',
        promptTitle: 'Pista d’idioma',
        promptBody: 'Tria un idioma compatible.',
      },
      keyterms: {
        title: 'Termes clau',
        subtitle: 'Noms i termes del domini que la transcripció hauria de reconèixer.',
        promptTitle: 'Termes clau',
        promptBody: 'Introdueix fins a 100 termes separats per comes o salts de línia.',
      },
    },
    options: {
      pinned: 'Versió fixada',
      movingAlias: 'Segueix automàticament les actualitzacions del proveïdor',
      automatic: 'Automàtic',
      custom: 'Personalitzat…',
      server_vad: 'Detecció d’activitat de veu al servidor',
      semantic_vad: 'Detecció semàntica de torn',
      manual: 'Manual',
      high: 'Alt',
      none: 'Cap',
    },
    catalog: {
      credentialRequired: 'Afegeix una clau de l’API per carregar les veus',
      retry: 'No s’han pogut carregar les veus: torna-ho a provar',
      empty: 'No hi ha cap veu disponible per a aquest compte',
      preview: ({ voice }) => `Escolta ${voice}`,
    },
    movingAlias: {
      confirmTitle: 'Vols seguir el model més recent?',
      confirmBody: 'Un àlies de model mòbil pot canviar de comportament quan el proveïdor l’actualitzi. Pots tornar a una versió fixada en qualsevol moment.',
      confirmAction: 'Usa el més recent',
    },
    links: {
      title: 'Recursos del proveïdor',
      account: { title: 'Obre el compte del proveïdor', subtitle: 'Gestiona el teu compte al proveïdor.' },
      apiKeys: { title: 'Obre les claus de l’API', subtitle: 'Crea, renova o revoca claus de l’API del proveïdor.' },
      privacy: { title: 'Política de privadesa del proveïdor', subtitle: 'Consulta com tracta el proveïdor les dades de veu.' },
    },
    disconnect: {
      title: 'Desconnecta la veu en temps real',
      subtitle: 'Suprimeix la clau de l’API d’aquest proveïdor de la màquina seleccionada.',
      confirmTitle: 'Vols desconnectar el proveïdor?',
      confirmBody: 'Això suprimeix la clau de l’API desada de la màquina d’execució seleccionada.',
    },
    unavailable: {
      title: 'Veu en temps real no disponible',
      rowTitle: 'No s’ha pogut carregar la configuració',
      provider: 'La contribució del proveïdor no està disponible o no és compatible.',
      invalid: 'La configuració desada del proveïdor no és vàlida.',
      needs_migration: 'Aquesta configuració necessita una migració compatible abans de poder-se editar.',
      unsupported_version: 'Aquesta configuració l’ha escrita una versió més recent de Happier.',
    },
  }) } as const;

return { voiceRealtimeProviderSetupTranslations };
})();

const Domain_voiceSettingsPagesTranslations = (() => {
type VoiceSettingsPagesCopy = Shared_voiceSettingsPagesTranslations.VoiceSettingsPagesCopy;

const en = Shared_voiceSettingsPagesTranslations.en;

const ca: VoiceSettingsPagesCopy = {
  pages: {
    search: {
      chooseService: 'Tria un servei per canviar aquest ajust.',
      select: ({ choice, control }) => `Selecciona ${choice} a ${control} per canviar aquest ajust.`,
    },
    hub: {
      description: 'Parla en veu alta amb els teus agents i dicta en qualsevol missatge.',
      modesTitle: 'Dues maneres de fer servir la veu',
      moreTitle: 'Més',
      dictationPurpose: 'el micròfon del quadre de redacció converteix la teva veu en text editable',
      summarySessionSummaries: 'Resums de sessió',
      summaryRecentMessages: ({ count }) => `últims ${count} missatges`,
      summaryNothingShared: 'No es comparteix res en començar una conversa',
      summaryRemembers: 'L’agent de Voice recorda les converses passades',
      summaryForgets: 'L’agent de Voice oblida després de cada conversa',
      summaryVoiceComputer: ({ machine }) => `Ordinador de Voice: ${machine}`,
      summaryTranscript: 'transcripció mentre parles',
    },
    pipeline: {
      hear: 'Escoltar',
      think: 'Pensar',
      speak: 'Parlar',
      write: 'Escriure',
      ready: 'A punt',
      oneStepNeedsYou: 'Un pas et necessita',
      stepsNeedYou: ({ count }) => `${count} passos et necessiten`,
      waiting: 'En espera',
      working: 'En curs',
      notChecked: 'Encara no comprovat',
      off: 'Desactivat · el dictat continua disponible',
      onMachine: ({ machine }) => `A ${machine}`,
      onVoiceComputer: 'Al teu ordinador de Voice',
      inTheCloud: 'Al núvol del servei, des d’aquest dispositiu',
      inTheSession: 'Respon el seu propi agent, a la transcripció',
      intoYourMessage: 'Ho revises abans d’enviar',
      messageLanguage: ({ language }) => `Llengua: ${language}`,
      languageAutomatic: 'automàtica',
      onThisDevice: 'En aquest dispositiu',
      needsYou: 'Et necessita',
      voiceAgentFollowsSession: 'Agent de Voice · segueix la sessió',
      theSessionYoureIn: 'La sessió on ets',
      intoYourMessageTitle: 'Al teu missatge',
    },
    privacy: {
      localAudio: "El dispositiu o ordinador de Voice",
      localProcessor: "El model de veu seleccionat",
      localRetention: "Ho gestiona el dispositiu o entorn d’execució. Els diagnòstics segueixen els ajustos d’enregistrament.",
      localDisclosure: "Els models de veu seleccionats s’executen al dispositiu o ordinador de Voice. L’historial i els enregistraments de diagnòstic tenen ajustos separats en aquesta pàgina.",
      audioTitle: "L’àudio va a",
      processorTitle: "Processat per",
      retentionTitle: "Retenció",
      messagesUnit: "missatges",
      secondsUnit: "segons",
      servicePolicy: "Segons els ajustos i les condicions del teu compte del servei.",
      noMicrophoneAudio: "Sense àudio del micròfon; només text de resposta.",
      yourEndpoint: "El teu endpoint configurat",
      endpointOperator: "L’operador del teu endpoint",
      endpointPolicy: "Segons la política de retenció del teu endpoint.",
      deviceAudio: "El servei de veu del dispositiu",
      deviceProcessor: "El dispositiu o el seu servei de veu",
      devicePolicy: "Segons els ajustos i les condicions de veu del dispositiu.",
      description: 'Què sent i llegeix el teu servei de veu, i què conserva Happier.',
      whereTitle: 'On va la teva veu ara',
      whereDescription: 'Canvia amb el servei que triïs.',
      startTitle: 'Quan comença una conversa',
      startDescription: 'Què pot llegir de la teva feina el servei de veu.',
      screenTitle: 'Què hi ha a la pantalla',
      screenDescription: 'Quina sessió o pàgina estàs mirant.',
      screenNever: 'Mai',
      screenWhenAsked: 'Quan ho demani',
      screenAlways: 'Sempre',
      summariesTitle: 'Resums de sessió',
      recentTitle: 'Els teus missatges recents',
      recentDescription: 'Els últims missatges d’una sessió, quan demana context.',
      recentCountTitle: 'Missatges per compartir',
      recentCountDescription: "",
      recentCountUnavailable: 'Activa «Els teus missatges recents» per canviar-ho.',
      toolsTitle: 'Noms de les eines',
      toolsDescription: 'Com ara «Fitxer editat». Els arguments i els camins de fitxer no es comparteixen mai.',
      permissionsTitle: 'Sol·licituds de permís',
      permissionsDescription: 'Perquè et digui què et necessita. Continues aprovant amb un toc.',
      devicesTitle: 'Les teves màquines i dispositius',
      devicesDescription: 'Noms i estat en línia, per començar sessions on demanis.',
      liveTitle: 'Mentre parles',
      liveDescription: 'Actualitzacions enviades quan les teves sessions canvien durant una conversa.',
      liveActiveTitle: 'De la sessió on ets',
      liveOtherTitle: 'De les teves altres sessions',
      liveNothing: 'Res',
      liveActivity: 'Activitat',
      liveSummaries: 'Resums',
      liveMessages: 'Missatges',
      livePerUpdateTitle: 'Missatges per actualització',
      liveIncludeMineTitle: 'Inclou el que has escrit',
      liveIncludeMineDescription: 'Desactivat: només s’envia la part de l’agent.',
      liveMessagesUnavailable: 'Tria «Missatges» per a una sessió aquí dalt per canviar-ho.',
      liveOtherModeTitle: 'Missatges d’altres sessions',
      liveOtherModeNever: 'Mai',
      liveOtherModeWhenAsked: 'Quan ho demani',
      liveOtherModeAutomatically: 'Automàticament',
      liveOtherModeUnavailable: 'Tria «Missatges» per a les altres sessions per canviar-ho.',
      memoryTitle: 'Memòria de l’agent de Voice',
      memoryDescription: 'Només per a la veu local amb un agent de Voice.',
      rememberTitle: 'Recorda les converses passades',
      rememberOnDescription: 'Continua on ho vas deixar.',
      rememberOffDescription: 'Desactivat: ho oblida tot quan penges.',
      restoreTitle: 'Restaura la memòria amb',
      restoreRecent: 'Missatges recents',
      restoreSummary: 'Resum + recents',
      restoreResume: 'Represa de l’agent',
      restoreUnavailable: 'Activa «Recorda» per triar.',
      restoreResumeFeatureOff: 'La represa necessita l’agent de Voice activat en aquest servidor.',
      restoreResumeAgentCannot: 'Aquest agent no pot reprendre una conversa passada.',
      fallbackTitle: 'Si la represa falla, reprodueix els missatges',
      fallbackDescription: 'Comença pels teus missatges recents en lloc de des de zero.',
      restoreCountTitle: 'Missatges per restaurar',
      restoreCountDescription: "",
      forgetTitle: 'Oblida-ho tot ara',
      forgetDescription: 'Torna a començar l’agent de Voice de zero. Les teves sessions no es toquen.',
      forgetAction: 'Oblida',
      moreTitle: 'Més',
    },
    dictation: {
      description: 'El micròfon del quadre de redacció converteix la teva veu en text que pots editar abans d’enviar.',
      engineTitle: 'Motor de veu',
      engineDescription: 'Cada motor diu on va el teu àudio.',
      sameAsConversations: 'Igual que les converses de veu',
      sameAsConversationsUses: ({ engine }) => `Fa servir ${engine}, com les teves converses de veu.`,
      languageTitle: 'Idioma',
      dictateInTitle: 'Dicto en',
      dictateInDescription: 'Automàtic fa servir l’idioma per defecte del motor. No segueix l’idioma de les converses.',
      pipelinePurpose: 'funciona fins i tot amb les converses de veu desactivades',
    },
    conversations: {
      description: 'Parla en veu alta amb els teus agents, amb les mans al teclat o no.',
      serviceTitle: 'Servei',
      serviceDescription: 'Qui t’escolta, pensa i parla. Pots canviar quan vulguis; cadascun conserva la seva configuració.',
      offDescription: 'Sense converses de veu. El dictat continua disponible.',
      serviceReady: 'A punt',
      accountTitle: 'Compte',
      accountDescription: 'És el mateix servei en tots dos casos; només canvia qui paga.',
      payWithTitle: 'Paga amb',
      happierBillingUnavailable: "La facturació de Happier no està disponible en aquest servidor.",
      turnOnVoiceAgent: "Activa l’agent de veu",
      payWithHappierDescription: 'Ho cobreix el teu pla de Happier. No cal cap compte propi.',
      payWithOwnDescription: 'Fas servir el teu compte i la teva clau API d\'aquest servei.',
      runsOn: 'S’executa a',
      hearTitle: 'Escoltar',
      hearDescription: 'Com la teva veu es converteix en text abans de respondre-la.',
      speechRecognitionTitle: 'Reconeixement de veu',
      handsFreeUnsupported: 'El mode mans lliures necessita el reconeixement de veu d’aquest dispositiu o un model de veu de Happier.',
      handsFreeTimingUnavailable: 'Activa mans lliures per canviar-ho.',
      interruptTitle: 'Interromp parlant',
      interruptDescription: 'Parlar per sobre d’una resposta l’atura.',
      talkToTitle: 'Parla amb',
      talkToSession: 'La sessió',
      talkToSessionDescription: 'Parles a la sessió on ets; respon el seu propi agent.',
      talkToAgent: 'Un agent de Voice',
      talkToAgentDescription: 'Un agent de Voice llegeix les teves sessions i actua per tu.',
      agentFeatureRequired: ({ feature }) => `Activa ${feature} a Configuració → Funcions. Les funcions experimentals també requereixen activar Experiments.`,
      itMayTitle: 'Pot',
      itMayReadOnly: 'Només llegir',
      itMayReadOnlyDescription: 'Llegeix les teves sessions i fitxers i no canvia res.',
      itMayAsk: 'Preguntar abans',
      itMayAskDescription: 'Cada canvi et pregunta abans. Un «sí» dit en veu alta no aprova mai; aproves amb un toc.',
      itMaySafe: 'Canvis segurs',
      itMaySafeDescription: 'Fa pel seu compte els canvis segurs a l’espai de treball i pregunta per la resta.',
      itMayAnything: 'Qualsevol cosa',
      itMayAnythingDescription: 'Pot fer qualsevol canvi sense preguntar-te abans.',
      repliesTitle: 'Respostes',
      repliesShort: 'Breus',
      repliesBalanced: 'Equilibrades',
      thinkTitle: 'Pensar',
      thinkDescription: 'Què passa amb el que dius.',
      advancedAgentTitle: 'Comportament avançat de l’agent',
      advancedAgentDescription: 'Com l’agent de Voice comença, espera i respon. Els valors per defecte serveixen a la majoria.',
      memoryLinkTitle: 'Memòria i restauració',
      memoryLinkDescription: 'Si recorda les converses passades es configura a Privadesa i dades.',
      speakTitle: 'Parlar',
      speakDescription: 'Com es llegeixen en veu alta les respostes.',
      voiceEngineTitle: 'Motor de veu',
      languageTitle: 'Idioma',
      languageDescription: 'Què canvia cada idioma per al servei triat.',
      iSpeakTitle: 'Parlo',
      iSpeakDescription: 'Ajuda a entendre’t. Automàtic el detecta cada vegada.',
      replyInTitle: 'Respon en',
      replyInDescription: 'La resposta arriba en aquesta llengua, encara que canviïs.',
      replySame: 'Igual que parlo',
      iSpeakAutomatic: 'Automàtic',
      iSpeakEngineDescription: ({ engine }) => `Ajuda ${engine} a entendre’t. Es configura amb el reconeixement de veu a Escoltar.`,
      voiceTitle: 'Veu',
      voiceDescription: ({ engine }) => `De ${engine}, el motor de Parlar.`,
      voiceDefault: 'Per defecte',
      voiceDevice: 'La veu d’aquest dispositiu',
      voiceInEngine: 'Es configura a Parlar',
      languageServiceDescription: 'La llengua en què respon el teu servei de veu.',
      languageAutomaticDescription: 'El servei de veu detecta la llengua que parles.',
      languageEngineDefault: 'Predeterminada del motor',
      languageCoupledDescription: 'El servei de veu fa servir una mateixa llengua per escoltar i respondre.',
      greetingTitle: 'Salutació',
      greetingOff: 'No',
      greetingRightAway: 'De seguida',
      greetingAfterISpeak: 'Quan jo parli',
      greetingOffDescription: 'Espera que parlis primer.',
      greetingRightAwayDescription: 'Saluda tan bon punt comença la conversa.',
      greetingAfterISpeakDescription: 'Et saluda a la primera resposta.',
      languageManagedDescription: 'El servei de veu controla la seva llengua.',
      languageServiceDefault: 'Predeterminada del servei',
    },
    advanced: {
      description: 'On s’executa la veu, com es mostra a la pantalla i quins models de veu fa servir.',
      onScreenTitle: 'A la pantalla',
      onScreenDescription: 'Com apareix una conversa en curs.',
      showLiveAsTitle: 'Mostra Voice en directe com a',
      showLiveAsDescription: 'Només en aquest dispositiu. La secció Voice del Companion es manté en tots els modes.',
      scopeTitle: 'Comença les converses amb',
      scopeGlobal: 'Totes les meves sessions',
      scopeGlobalDescription: 'Un sol assistent per a tot.',
      scopeSession: 'La sessió oberta',
      scopeSessionDescription: 'Comença dins la sessió que tens oberta.',
      transcriptTitle: 'Mostra la transcripció mentre parles',
      transcriptDescription: 'El que dieu tu i l’agent apareix mentre parleu.',
      autoOpenTitle: 'Obre-la quan comença una conversa',
      autoOpenDescription: 'Desactivat: obre-la tu des de la conversa.',
      autoOpenUnavailable: 'Activa «Mostra la transcripció» per triar.',
      computerTitle: 'Ordinador de Voice',
      speechModelsTitle: 'Models de veu',
      speechModelsNeedComputerTitle: 'Cal un ordinador de Voice',
      speechModelsNeedComputer: 'Tria a dalt un ordinador de Voice per instal·lar i gestionar els seus models de veu.',
      computerDescription: 'L’ordinador que executa els models de veu i inicia sessió als comptes connectats per a la veu. Compartit entre els teus dispositius.',
      connectionTitle: 'Connexió',
      timeoutTitle: 'Abandona una sol·licitud de veu després de',
      timeoutDescription: "Per a punts de connexió i models de veu.",
    },
  },
};

const voiceSettingsPagesTranslations = { ca } as const satisfies Pick<Record<string, VoiceSettingsPagesCopy>, "ca">;

return { voiceSettingsPagesTranslations };
})();

const Domain_walkthroughProgressTranslations = (() => {
type Parts = Shared_walkthroughProgressTranslations.Parts;

const walkthroughProgressTranslations = { 'ca': { parts: ({ completed, total, admitted }: Parts) => `${completed}/${total} parts completades · ${admitted} admeses`, merge: 'S’està integrant el recorregut…', titleEdited: 'Títol editat', changed: 'Canviat', moved: 'Mogut', filesReadUnavailable: 'Progrés de lectura de fitxers no disponible' } };

return { walkthroughProgressTranslations };
})();

const Domain_walkthroughSavedTranslations = (() => {
type SavedCopy = Shared_walkthroughSavedTranslations.SavedCopy;

const en = Shared_walkthroughSavedTranslations.en;

const walkthroughSavedTranslations = { ca: { edit: 'Edita el recorregut', title: 'Títol del recorregut', stopTitle: 'Títol de la parada', prose: 'Explicació', refine: 'Refina', instructions: 'Què ha de canviar?', moveUp: 'Mou amunt', moveDown: 'Mou avall', mergeNext: 'Fusiona amb la parada següent', addSummary: 'Afegeix un resum', addCommitPlan: 'Proposa commits', updated: 'Resultat desat actualitzat', conflict: 'Aquest recorregut ha canviat en un altre lloc. Es conserva l’esborrany. Carrega la versió més recent i revisa-la abans de tornar a desar.', reload: 'Carrega la versió més recent', missingStop: "Aquesta parada ja no és al recorregut més recent. Es conserva l’esborrany; tria una altra parada per continuar.", applicationLocked: 'S’estan aplicant commits. L’edició està en pausa.' } } satisfies Pick<Record<string, SavedCopy>, "ca">;

return { walkthroughSavedTranslations };
})();

const Domain_walkthroughSettingsTranslations = (() => {
type Copy = Shared_walkthroughSettingsTranslations.Copy;

const en = Shared_walkthroughSettingsTranslations.en;

const copy = Shared_walkthroughSettingsTranslations.copy;

const walkthroughSettingsTranslations = { ca: copy({
        title: 'Guies de canvis',
        description: 'Un ordre de lectura creat amb IA, amb explicacions al costat dels canvis exactes i propostes de commits opcionals. S’executa a la màquina que té el codi.',
        enabled: 'Explica els canvis',
        enabledDescription: 'Afegeix un ordre de lectura i explicacions a una comparació. Els fitxers continuen disponibles sense cap model.',
        model: 'Model de resum',
        modelDescription: 'S’utilitza per a explicacions, guies de canvis i propostes de commits.',
        chooseModel: 'Tria un model',
        unsupported: 'No pot escriure guies de canvis',
        unavailable: 'Model no disponible. Tria’n un altre.',
        prefetch: 'Prepara després de cada torn',
        prefetchDescription: 'Prepara una guia de canvis quan l’agent acaba un torn.',
        saved: 'Guies desades',
        savedDescription: 'Desades en aquesta màquina, incloent-hi les teves edicions.',
        clear: 'Esborra',
        unavailableData: 'Torna a connectar la màquina per carregar les guies desades i els costos.',
        costUnavailable: 'Últims 7 dies · cost no disponible',
        clearTitle: 'Vols esborrar les guies desades?',
        clearDescription: ({ machine }) => `Esborra les guies desades i les teves edicions manuals a ${machine}, així com les teves marques de revisió d’aquestes comparacions. Les altres màquines no es veuen afectades.`,
        savedCount: ({ count, bytes }) => `${count} desades · ${bytes}`,
        cost: ({ amount, partial }) => `Últims 7 dies · ${amount}${partial ? ' · alguns costos no estan disponibles' : ''}`,
        clearFailed: 'No s’han pogut esborrar algunes guies. Torna a carregar i prova-ho de nou.',
    }) };

return { walkthroughSettingsTranslations };
})();

const Domain_walkthroughStartTranslations = (() => {
const walkthroughStartTranslations = { ca: { walkthroughStart: { start: 'Inicia el recorregut', ended: 'Aquesta conversa no està disponible aquí. El recorregut es conserva.', newConversation: 'Inicia una conversa nova', askSession: 'Pregunta a l’agent de la sessió', unavailable: 'Connecta la màquina i tria un model que retorni una resposta estructurada.', updated: 'Recorregut actualitzat' } } };

return { walkthroughStartTranslations };
})();

const Domain_walkthroughTranslations = (() => {
type WalkthroughTranslations = Shared_walkthroughTranslations.WalkthroughTranslations;

const walkthroughSavedTranslations = {...Domain_walkthroughSavedTranslations.walkthroughSavedTranslations, ...EnglishFeatures.walkthroughSavedTranslations.walkthroughSavedTranslations};

const walkthroughProgressTranslations = {...Domain_walkthroughProgressTranslations.walkthroughProgressTranslations, ...EnglishFeatures.walkthroughProgressTranslations.walkthroughProgressTranslations};

const en = Shared_walkthroughTranslations.en;

const translated = Shared_walkthroughTranslations.translated;

const walkthroughTranslations = { ca: {
        walkthrough: translated({
            saved: walkthroughSavedTranslations.ca,
            progress: walkthroughProgressTranslations.ca,
            eyebrow: 'Recorregut',
            generated: 'Generat',
            generatedBy: ({ model }) => `Generat · ${model}`,
            generatedA11y: 'Escrit per un model',
            readingChanges: 'Llegint els canvis…',
            modelFallback: 'El model',
            analysisAll: ({ who, count }) => `${who} ha llegit tots ${count}`,
            analysisSome: ({ who, analysed, total }) => `${who} ha llegit ${analysed} de ${total}`,
            analysisStopped: ({ who, analysed, total }) => `${who} ha llegit ${analysed} de ${total} abans d’aturar-se`,
            unavailableCount: ({ count }) => `${count} no disponibles`,
            youReviewed: ({ count, total }) => `Has revisat ${count} de ${total}`,
            contents: 'Contingut',
            reviewedOfTotal: ({ count, total }) => `${count} de ${total} revisats`,
            boardReadProgress: ({ count, total }) => `${count} de ${total} llegits`,
            stopOf: ({ number, total }) => `${number} de ${total}`,
            stopA11y: ({ number, title }) => `Parada ${number}: ${title}`,
            stopReviewedA11y: ({ number }) => `Parada ${number}, revisada`,
            importance: { start: 'Comença aquí', high: 'Llegeix amb atenció', low: 'Llegeix per sobre' },
            markReviewed: 'Marca com a revisat',
            reviewed: 'Revisat',
            markReviewedA11y: 'Marca aquesta parada com a revisada',
            unmarkReviewedA11y: 'Revisat. Prem per treure la marca',
            askAboutThis: 'Pregunta sobre això',
            askAboutStopA11y: 'Pregunta sobre aquesta parada',
            openConversation: 'Obre la conversa del recorregut',
            andIn: ({ file }) => `i a ${file}`,
            newFile: 'Fitxer nou',
            deletedFile: 'Suprimit',
            openInFiles: ({ file }) => `Obre ${file} a Fitxers`,
            otherChanges: 'Altres canvis',
            otherChangesDescription: 'No formen part de la història, però hi són. Obre’ls com un diff normal.',
            otherChangesCue: 'Mecànics, mostrats com a diffs',
            keys: { move: 'moure', reviewed: 'revisat', ask: 'preguntar' },
            overview: 'Visió general',
            codeMapOf: ({ count }) => `Mapa del codi de ${count} ${count === 1 ? 'fitxer' : 'fitxers'}`,
            codeMapHint: 'assenyala una parada per destacar-ne els fitxers',
            touchesOutlined: 'toca els fitxers destacats',
            showOverviewA11y: ({ count }) => `Mostra la visió general: un mapa del codi de ${count} fitxers`,
            inventory: { title: 'Tot el que hi ha en aquesta comparació · ja disponible a Fitxers', read: 'Llegit', reading: 'Llegint', unavailable: 'No disponible' },
            arriving: 'Les parades següents apareixeran aquí a mesura que s’escriguin.',
            previousStop: 'Parada anterior',
            nextStop: 'Parada següent',
            done: 'Fet',
            evidence: { displayFailed: 'No s’ha pogut mostrar el codi desat. El fitxer continua a Fitxers.', binary: 'Fitxer binari, descrit a partir de les metadades. Es mostra, no s’analitza.', unavailable: ({ reason }) => `No s’ha pogut llegir (${reason}). Continua a la llista; res d’aquí diu que s’hagi revisat.` },
            notice: {
                stale: 'Hi ha fitxers que han canviat després d’escriure això',
                refresh: 'Actualitza el recorregut',
                failed: ({ reason }) => `L’escriptura s’ha aturat · ${reason}`,
                failedGeneric: 'L’escriptura s’ha aturat',
                tryAgain: 'Torna-ho a provar',
                chooseModel: 'Tria un model',
                cancelled: 'S’ha aturat l’escriptura. El que s’ha escrit es manté.',
                rest: 'La resta no s’ha escrit. Tots els fitxers són a Fitxers; no s’ha omès res en silenci.',
                offline: ({ machine, time }) => `${machine} està fora de línia · es mostren el recorregut i el codi de les ${time}. Preguntar i actualitzar tornaran quan es reconnecti.`,
                offlineA11y: 'Necessita la màquina, que està fora de línia',
                incomplete: 'Alguns canvis no s’han pogut llistar. El que hi ha és exacte; res no diu que sigui complet.',
                undo: 'Desfés',
            },
            none: { title: 'Encara no hi ha recorregut', reason: 'Un recorregut llegeix aquests canvis en ordre i explica cadascun al costat del seu codi exacte. Tots els fitxers ja són a Fitxers.', showFiles: 'Mostra els fitxers' },
            explain: { notInStory: 'No forma part de la història', readInWalkthrough: 'Llegeix-ho al recorregut' },
        }),
    } };

return { walkthroughTranslations };
})();

const Domain_widgetAddTranslations = (() => {
type WidgetAddTranslation = Shared_widgetAddTranslations.WidgetAddTranslation;

const inSentence = Shared_widgetAddTranslations.inSentence;

const widgetAddTranslations = { ca: {
        viewGallery: 'Galeria',
        viewList: 'Llista',
        viewLabel: 'Vista',
        added: 'Afegit',
        boardTitle: 'Afegeix al tauler',
        boardHint: 'Tothom aquí veu el que afegeixes',
        companionTitle: 'Afegeix a l’acompanyant',
        companionHint: 'Només tu veus el teu acompanyant',
        searchWidgets: 'Cerca ginys',
        searchCompanion: 'Cerca resums i panells',
        fromPlugins: 'De connectors',
        fromPluginsHint: 'en directe, amb les dades d’aquesta sessió',
        makeOne: 'Crea’n un',
        noteSubtitle: 'Markdown',
        interactiveViewSubtitle: 'HTML',
        findMore: 'Troba més ginys',
        findMoreSubtitle: 'Connectors',
        askTitle: 'Demana un giny a l’agent',
        askNote: 'Ho redacta al compositor; no s’envia res fins que tu ho facis.',
        glances: 'Resums',
        glancesHint: 'en directe, integrats o de connectors',
        onBoard: 'En aquest tauler',
        onBoardHint: 'compartit amb tothom aquí',
        panes: 'Panells',
        panesHint: 's’afegeix com un enllaç que s’obre a Detalls',
        builtIn: 'Integrat',
        nativeDescriptions: {
            session_summary: 'Activitat i propers passos de la sessió que triïs.',
            agent_plan: 'Segueix el pla de l’agent per a la sessió que triïs.',
            changes: 'Revisa els canvis als fitxers de la sessió que triïs.',
            local_services: 'Obre els serveis locals de la sessió que triïs.',
        },
        noMatch: ({ query }) => `Cap giny coincideix amb «${query}»`,
        setupTitle: ({ widget }) => `Configura ${widget}`,
        editTitle: ({ widget }) => `${widget} · entrades`,
        editHint: 'Només canvia aquesta còpia. Les altres mantenen les seves entrades.',
        preview: 'Previsualització',
        previewLive: 'Previsualització · en directe',
        previewWaiting: ({ field }) => `Tria ${field} per veure-ho aquí`,
        previewAfterAdd: 'Es veurà aquí un cop afegit',
        backToGallery: 'Torna a la galeria',
        needed: 'Cal',
        stillNeeded: ({ field }) => `Encara cal ${field}`,
        followGroup: 'Segueix',
        pinGroup: 'O fixa’n un',
        another: 'Un altre…',
        anotherSubtitle: 'Cerca tot el que pots consultar',
        searchChoices: ({ field }) => `Cerca ${field}`,
        noChoices: 'Encara no hi ha res per triar',
        optionsLoading: 'Carregant opcions…',
        optionsFailed: 'No s’han pogut carregar les opcions',
        invalidValue: 'no trobat',
        inputsInvalid: 'Revisa les entrades d’aquest giny',
        inputsUnavailable: 'Una entrada seleccionada no està disponible',
        connectionNeeded: ({ field }) => `Connecta el teu ${field}`,
        sessionDenied: ({ session }) => `Ja no tens accés a ${session}`,
        sessionUnavailable: ({ session }) => `${session} no està disponible o s’ha suprimit`,
        typeUnavailable: ({ field }) => `El tipus de ${field} ja no està disponible`,
        inputUnavailable: ({ field }) => `${field} no està disponible`,
        selectedInputUnavailable: ({ field, value }) => `${field}: ${value} ja no està disponible`,
        invalidReason: 'Ja no hi tens accés, o s’ha eliminat.',
        viewerOnly: 'Cadascú aquí ho veu amb la seva pròpia connexió.',
        justAdded: ({ widget }) => `${widget} afegit`,
        saved: ({ widget }) => `${widget} desat`,
        addFailed: 'No s’ha pogut afegir. Torna-ho a provar.',
        saveFailed: 'No s’ha pogut desar. Torna-ho a provar.',
        homeTitle: 'Afegeix a l’inici',
        homeHint: 'Només tu veus el teu inici · a tots els dispositius',
        homeFromPluginsHint: 'en directe, amb les teves dades',
        addWidgets: 'Afegeix ginys',
        addToHome: 'Afegeix a l’inici',
        addToBoard: 'Afegeix al tauler',
        addToCompanion: 'Afegeix a l’acompanyant',
        editInputs: 'Edita les entrades…',
        width: 'Amplada',
        size: 'Mida',
        sizes: { small: 'Petita', medium: 'Mitjana', wide: 'Ampla', full: 'Completa', tall: 'Alta', large: 'Gran' },
        widthHalf: 'Meitat',
        widthFull: 'Completa',
        thisSession: 'Aquesta sessió',
        choicesCount: ({ count }) => count === 1 ? '1 opció' : `${count} opcions`,
        countOnHome: ({ count }) => `${count} a l’inici`,
        countOnBoard: ({ count }) => `${count} al tauler`,
        countInCompanion: ({ count }) => `${count} a l’acompanyant`,
        thisPage: 'Aquesta pàgina',
        thisProject: 'Aquest projecte',
        thisCheckout: 'Aquesta còpia de treball',
        areaPinned: 'Fixats',
        areaPinnedMeta: 'els teus ginys en aquesta pàgina',
        areaProjectTitle: 'Ginys',
        areaProjectMeta: 'teus',
        areaAdd: ({ surface }) => `Afegeix un giny a ${surface}`,
        areaAddTo: ({ surface }) => `Afegeix a ${surface}`,
        areaHint: 'Només tu veus aquests ginys',
        countHere: ({ count }) => count === 1 ? '1 aquí' : `${count} aquí`,
        areaEmptyTitle: 'Encara no hi ha res fixat',
        areaEmptyReason: 'Fixa un giny per tenir-lo aquí, només per a tu.',
        areaEmptyAction: 'Afegeix un giny',
        areaUnavailableTitle: 'Els ginys no es poden carregar aquí',
        projectSourceUnavailableTitle: 'Els ginys apareixeran aquí quan se sàpiga el repositori d’aquest projecte',
        areaWriteFailed: 'No s’ha pogut desar aquest canvi',
        areaApprovalPending: 'Esperant l’aprovació',
        valueNotFound: ({ value }) => `No es troba ${value}`,
        chooseAnother: ({ field }) => `Tria un altre valor per a ${field}`,
        chooseField: ({ field }) => `Tria ${field}`,
        widgetOptions: 'Opcions del giny',
        moveTo: 'Mou…',
    } } satisfies Pick<Readonly<Record<string, WidgetAddTranslation>>, "ca">;

return { widgetAddTranslations };
})();

const Domain_widgetDefinitionTranslations = (() => {
type WidgetDefinitionTranslation = Shared_widgetDefinitionTranslations.WidgetDefinitionTranslation;

const widgetDefinitionTranslations = { ca: {
        yourWidgets: "Els teus ginys",
        yourWidgetsHint: "fets per tu o pels teus agents",
        yourWidget: "El teu giny",
        moreInSource: "La font té més dades de les que es mostren.",
        notCurrent: "No actualitzat",
        aboutMenu: "Sobre aquest giny",
        aboutTitle: "Sobre aquest giny",
        aboutUnavailable: "Ara mateix no es pot obrir aquest giny.",
        aboutData: "Dades",
        aboutReads: "Llegeix",
        aboutInputs: "Entrades",
        aboutRefresh: "Actualització",
        aboutUsedIn: "S’usa a",
        savedFromSession: ({ session }) => `Desat de ${session}`,
        aSession: "una sessió",
        madeInYourAccount: "Fet al teu compte",
        edited: ({ time }) => `editat ${time}`,
        readsOnly: "Només lectura",
        runsOn: ({ machine }) => `s’executa a ${machine}`,
        withYourConnection: "amb la teva pròpia connexió",
        readsResource: ({ read, plugin }) => `${read} de ${plugin}`,
        cannotRunAnythingElse: "El giny no pot executar res més.",
        inputsThisCopy: "Només per a aquesta còpia",
        refreshWhenOpen: "Quan l’obres",
        refreshNow: "Actualitza ara",
        refreshing: "S’està actualitzant…",
        refreshed: "Actualitzat",
        refreshFailed: "No s’ha pogut actualitzar. Es mantenen les últimes xifres.",
        placedOnHome: "Inici",
        placedOnBoard: ({ board }) => `Tauler ${board}`,
        placedOnABoard: "Un tauler",
        placedInASession: "Una sessió",
        placedInAProject: "Un projecte",
        placedOnAPluginPage: "Una pàgina d’un connector",
        notPlacedYet: "Encara no és enlloc",
        otherPlacesNotListed: "Els llocs d’altres dispositius o superfícies compartides no surten aquí.",
        editsChangeAll: ({ count }) => `Els canvis al giny afecten tots ${count}`,
        editsChangeEverywhere: "Els canvis al giny l’afecten a tot arreu on s’usa",
        changeWithAgent: "Canvia-ho amb l’agent",
        changeDraft: ({ widget }) => `Canvia el giny «${widget}» perquè `,
        duplicate: "Duplica",
        duplicated: ({ name }) => `S’ha desat una còpia, «${name}», a Els teus ginys`,
        duplicateFailed: "No s’ha pogut fer una còpia. Torna-ho a provar.",
        saveMenu: "Desa com a giny teu…",
        saveMenuSubtitle: "Una còpia per a l’inici i els teus taulers",
        saveTitle: "Desa com a giny teu",
        saveHint: "Una còpia que pots posar a l’inici, als teus taulers i projectes. Aquesta sessió es queda la seva.",
        saveNote: "Desat al teu compte · només tu",
        saveWidget: "Desa el giny",
        saveFailed: "No s’ha pogut desar el giny. Torna-ho a provar.",
        savedButNotPlaced: "Desat a Els teus ginys, però no s’ha pogut afegir a tots els llocs triats.",
        savedAsYours: ({ name }) => `S’ha desat «${name}» a Els teus ginys`,
        name: "Nom",
        nameNeeded: "Posa-li un nom",
        becomesViewerInput: "Passa a ser una entrada: cada lloc usa la teva connexió",
        becomesContextInput: "Passa a ser una entrada: cada lloc tria la seva",
        alsoAddTo: "Afegeix-lo també a",
        alsoAddToNamed: ({ place }) => `Afegeix-lo també a ${place}`,
        snapshotMenu: "Publica una instantània en aquest tauler…",
        snapshotMenuSubtitle: "Tothom aquí veu les teves xifres d’ara",
        snapshotTitle: "Vols publicar una instantània per a tothom?",
        snapshotHint: ({ widget, time }) => `Qualsevol que pugui obrir aquesta sessió veurà ${widget} a les ${time}. No s’actualitzarà i la teva connexió continua sent teva.`,
        postSnapshot: "Publica la instantània",
        snapshotNotCurrent: "El giny encara està obtenint xifres actuals. Torna-ho a provar quan les tingui.",
        snapshotFailed: "No s’ha pogut publicar la instantània. No s’ha compartit res.",
        snapshotAwaitingApproval: "Esperant aprovació a la safata. No es comparteix res fins que s’aprovi.",
        snapshotPosted: "Instantània publicada",
        snapshotNote: "Una còpia d’aquestes xifres. No s’actualitza.",
        asOf: ({ time }) => `a les ${time}`,
    } } satisfies Pick<Readonly<Record<string, WidgetDefinitionTranslation>>, "ca">;

return { widgetDefinitionTranslations };
})();

const Domain_widgetFrameTranslations = (() => {
type WidgetFrameTranslation = Shared_widgetFrameTranslations.WidgetFrameTranslation;

const widgetFrameTranslations = { ca: {
        styleCard: 'Targeta',
        stylePlain: 'Simple',
        surfaceHome: 'Inici',
        surfaceBoard: 'Tauler',
        surfaceCompanion: 'Acompanyant',
        showFrame: 'Mostra el marc',
        hideFrame: 'Amaga el marc',
        thisWidgetOnly: 'Només aquest giny',
        surfaceUses: ({ surface, style }) => `${surface} fa servir ${style}`,
        useSurfaceDefault: ({ surface }) => `Fes servir el valor per defecte de ${surface}`,
        likeTheOthers: ({ style }) => `${style}, com els altres`,
        appearanceTitle: 'Ginys',
        appearanceDescription: 'Com s’emmarquen els ginys en aquest dispositiu. Per canviar-ne un, fes servir el seu menú ⋯.',
        previewLabel: ({ surface, style }) => `${surface} · ${style}`,
        noticeChanged: 'Marc canviat',
        addViewTitle: 'Afegir ginys',
        addViewDescription: 'Com s’obre el menú Afegeix. Si el canvies allà, també canvia aquí.',
        newChip: 'Nou',
    } } satisfies Pick<Readonly<Record<string, WidgetFrameTranslation>>, "ca">;

return { widgetFrameTranslations };
})();

const Domain_widgetGlanceTranslations = (() => {
type WidgetGlanceTranslation = Shared_widgetGlanceTranslations.WidgetGlanceTranslation;

const widgetGlanceTranslations = { ca: {
        changesTitle: 'Canvis',
        localServicesTitle: 'Serveis locals',
        changesSource: 'Git',
        reviewChanges: 'Revisa els canvis',
        notARepo: 'La carpeta d’aquesta sessió no és un repositori Git.',
        noChanges: 'Encara no hi ha canvis. Els fitxers que editi l’agent apareixeran aquí.',
        changesLoading: 'Carregant els canvis',
        running: 'En execució',
        notRunning: 'No s’executa',
        nothingRunning: 'No s’executa res. Els serveis que iniciï aquesta sessió apareixeran aquí.',
        servicesLoading: 'Carregant els serveis locals',
        servicesReadFailed: 'No s’han pogut llegir els serveis locals. Torna-ho a provar.',
        noMachine: 'Aquesta sessió no té cap màquina a qui preguntar.',
        changedCount: ({ count }) => `${count} canviats`,
        moreFiles: ({ count }) => (count === 1 ? '1 fitxer més' : `${count} fitxers més`),
        runningCount: ({ count }) => `${count} en execució`,
        openInBrowser: ({ name }) => `Obre ${name} al navegador`,
        paneLinkA11y: ({ pane }) => `${pane}. S’obre al costat del xat`,
    } } satisfies Pick<Readonly<Record<string, WidgetGlanceTranslation>>, "ca">;

return { widgetGlanceTranslations };
})();

const Domain_workStatusTranslations = (() => {
type WorkStatusTranslations = Shared_workStatusTranslations.WorkStatusTranslations;

const en = Shared_workStatusTranslations.en;

const ca: WorkStatusTranslations = {
    buckets: {
        needs_you: 'Et necessita',
        working: 'Treballant',
        finished: 'Acabat',
        idle: 'En repòs',
        offline: 'Sense connexió',
    },
};

const workStatusTranslations = { ca: { ...ca, task: { stopped: 'Aturada', linkFailed: 'La sessió s’ha creat, però no s’ha desat l’enllaç amb la tasca. Torna-ho a provar per enllaçar la mateixa sessió.' } } };

return { workStatusTranslations };
})();

const Domain_workflowActionTranslations = (() => {
type Copy = Shared_workflowActionTranslations.Copy;

const en = Shared_workflowActionTranslations.en;

const workflowActionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "ca"> = { ca: {
        host: "Happier",
        structure: "Estructura",
        artifactCreate: "Crea un document",
        artifactGet: "Llegeix un document",
        artifactList: "Llista documents",
        artifactUpdate: "Actualitza un document",
        artifactDelete: "Elimina un document",
        artifactPublish: "Publica un fitxer",
        artifactRevisions: "Llista versions del document",
        artifactRestore: "Restaura una versió del document",
        artifactUsage: "Consulta l’ús d’emmagatzematge dels documents",
        artifactShare: "Comparteix un document per enllaç",
        artifactLinks: "Llista enllaços del document",
        artifactRevoke: "Revoca un enllaç de document",
        artifactAudit: "Consulta l’activitat dels enllaços del document",
        sessionRole: "Estableix el rol d’una sessió",
        sessionRoleOverride: "Canvia la configuració del rol d’una sessió",
        sessionRoleClear: "Restableix la configuració del rol d’una sessió",
        sessionRoleAdd: "Afegeix un rol de sessió",
        sessionRoleRemove: "Elimina un rol de sessió",
        sessionNotes: "Estableix notes de sessió",
        sessionRolesApply: "Aplica rols a les sessions subordinades",
        roleList: "Llista rols",
        roleGet: "Llegeix un rol",
        roleCreate: "Crea un rol",
        roleUpdate: "Actualitza un rol",
        roleDelete: "Elimina un rol",
        roleOverride: "Canvia la configuració del rol",
        roleReset: "Restableix la configuració del rol",
        widgetCatalog: "Llista ginys disponibles",
        widgetInstances: "Llista ginys col·locats",
        widgetAdd: "Afegeix un giny",
        widgetRemove: "Elimina un giny de la vista",
        widgetMove: "Mou un giny",
        widgetRename: "Canvia el nom d’un giny",
        widgetSize: "Estableix la mida d’un giny",
        widgetFrame: "Estableix el marc d’un giny",
        widgetInputs: "Llegeix les entrades d’un giny",
        widgetValidate: "Comprova les entrades d’un giny",
        widgetSetInputs: "Estableix les entrades d’un giny",
        widgetResetInputs: "Restableix les entrades d’un giny",
        widgetLayout: "Llegeix la disposició dels ginys",
        widgetUpdateLayout: "Canvia la disposició dels ginys",
        widgetDefinitions: "Llista ginys desats",
        widgetDefinition: "Llegeix un giny desat",
        widgetCreate: "Crea un giny",
        widgetUpdate: "Actualitza un giny desat",
        widgetDuplicate: "Duplica un giny desat",
        widgetDelete: "Elimina un giny desat",
        widgetSave: "Desa un giny de sessió",
    } };

return { workflowActionTranslations };
})();

const Domain_workflowAgentAuthoringTranslations = (() => {
type Edit = Shared_workflowAgentAuthoringTranslations.Edit;

type RepeatableMessage = Shared_workflowAgentAuthoringTranslations.RepeatableMessage;

type Copy = Shared_workflowAgentAuthoringTranslations.Copy;

const en = Shared_workflowAgentAuthoringTranslations.en;

const repeatable = { ca: { repeatable: 'Fes-ho repetible', repeatableDescription: 'Demana a l’agent que converteixi el que ha funcionat en un workflow reutilitzable.', repeatablePrompt: 'Converteix el que hem fet aquí en un workflow que pugui tornar a executar. Dissenya’l, comprova’l amb workflow.validate i desa’l, però no l’executis.', repeatableMessagePrompt: 'Converteix el que hem fet en aquest missatge en un workflow que pugui tornar a executar. Dissenya’l, comprova’l amb workflow.validate i desa’l, però no l’executis.', repeatableMessageSource: ({ text }: RepeatableMessage) => `“${text}”` } };

const workflowAgentAuthoringTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "ca"> = { ca: { ...repeatable.ca, create: 'Crea amb un agent', edit: 'Edita amb un agent', agent: 'Agent', description: 'Una sessió nova dissenya el workflow amb tu, el comprova i el desa. No s’executa res fins que triïs Executa ara.', changedByAgent: 'Canviat per l’agent', saved: 'Desat per l’agent ara mateix', savedAge: ({ age }) => `Desat per l’agent ${age}`, savedWorkflow: ({ name }) => `Workflow desat · ${name}`, updated: 'Workflow actualitzat', changed: ({ count }) => `Workflow actualitzat · ${count} passos canviats`, openEditor: 'Obre a l’editor', openSession: 'Obre a Sessions', createPrompt: 'Dissenya amb mi un workflow, comprova’l amb workflow.validate i després desa’l. No l’executis.', createLead: 'Ajuda’m a crear un workflow que ', editPrompt: ({ name, definitionId, headerVersion, bodyVersion }) => `El workflow desat «${name}» té l’id ${definitionId} i la revisió: capçalera ${headerVersion}, cos ${bodyVersion}. Canvia’l amb workflow.definition.edit i usa workflow.definition.update només per substituir-lo sencer. Comprova’l amb workflow.validate abans de desar. No l’executis.`, editLead: ({ name }) => `Ajuda’m a canviar ${name}: ` } };

return { repeatable, workflowAgentAuthoringTranslations };
})();

const Domain_workflowBuiltinTranslations = (() => {
type WorkflowBuiltinTranslations = Shared_workflowBuiltinTranslations.WorkflowBuiltinTranslations;

const en = Shared_workflowBuiltinTranslations.en;

const ca: WorkflowBuiltinTranslations = {
    runsInsideSession: 'S’executa dins d’una sessió',
    keepGoing: { title: 'Continua fins acabar' },
    reviewAndConverge: { title: 'Revisa i convergeix', apply: 'Aplica', verifyAndFix: 'Verifica i corregeix', verifyOnly: 'Només verifica', rounds: 'Rondes abans d’aturar-se' },
    planWithAPanel: { title: 'Planifica amb un panell', description: 'Diversos agents planifiquen en paral·lel i el pla espera la teva revisió.', inputs: { request: 'Petició', requestPlaceholder: 'Què ha de planificar el panell?', engines: 'Planificadors' } },
    openAPullRequest: { title: 'Obre una pull request', description: 'Demana una segona opinió i després obre una pull request. Si la segona opinió no hi està d’acord, t’espera.', inputs: { base: 'Branca base', title: 'Títol de la pull request', body: 'Descripció', question: 'Pregunta per a la segona opinió' } },
};

const workflowBuiltinTranslations = { ca } as const;

return { workflowBuiltinTranslations };
})();

const Domain_workflowFieldTranslations = (() => {
const workflowFieldTranslations = { ca: {
        sessionId: "Sessió",
        triggerId: "Activador",
        engineIds: "Revisors",
        backendTargetKeys: "Planificadors",
        reviewCommentAuthorIntent: "Troballes",
        commentId: "Troballa",
        expectedServerRevision: "Versió de la troballa",
        clientMutationId: "Actualització",
        projectId: "Projecte",
        workspace: "Espai de treball",
        toState: "Estat",
        expectedState: "Estat actual",
        disposition: "Importància",
        allPages: "Totes les troballes",
        permissionMode: "Permisos",
        target: "S'executa a",
        cwd: "Carpeta de treball",
        maxRounds: "Rondes màximes",
        strikes: "Comprovacions sense progrés",
        secondOpinion: "Segona opinió",
        useJudge: "Jutge",
        diffFingerprint: "Canvis revisats",
    } };

return { workflowFieldTranslations };
})();

const Domain_workflowEditorPageTranslations = (() => {
type WorkflowEditorPageTranslations = Shared_workflowEditorPageTranslations.WorkflowEditorPageTranslations;

const workflowFieldTranslations = {...Domain_workflowFieldTranslations.workflowFieldTranslations, ...EnglishFeatures.workflowFieldTranslations.workflowFieldTranslations};

const en = Shared_workflowEditorPageTranslations.en;

const pluralPl = Shared_workflowEditorPageTranslations.pluralPl;

const pluralRu = Shared_workflowEditorPageTranslations.pluralRu;

const ca: WorkflowEditorPageTranslations = {
    fields: workflowFieldTranslations.ca,
    blocks: {
        actionSub: 'Acció · sense torn d’agent',
        notSet: 'Sense definir',
        set: 'Defineix',
        clear: 'Esborra',
        required: 'Obligatori',
        noFields: 'No hi ha res a definir per a aquesta acció.',
        workflowSub: 'Executa un altre flux · els seus passos apareixen en aquesta execució',
        builtin: 'Integrat',
        waitTitle: 'Esperar-te',
        waitSub: 'Aquest carril espera fins que continuïs.',
        waitPlaceholder: 'Què hauries de revisar o decidir aquí?',
        returnsText: 'Retorna text',
        returnsFields: ({ fields }) => `Retorna ${fields}`,
        workflowDefaults: 'Valors del flux de treball',
        addNamedResults: 'Afegeix resultats amb nom',
        menuRun: 'Executa un flux',
        menuAction: 'Acció',
        menuWait: 'Esperar-te',
        actionSearch: 'Cerca accions',
        workflowSearch: 'Cerca fluxos',
        libraryGroup: 'Els teus fluxos',
        noAgentTurn: 'Sense torn d’agent.',
        useNumber: 'Fes servir un número',
        actionUnavailable: ({ action }: { action: string }) => `${action} no està disponible aquí.`,
        childInputs: ({ workflow }: { workflow: string }) => `Les entrades vénen de ${workflow}.`,
        retryLoading: "Torna a carregar",
        selfRef: ({ workflow }: { workflow: string }) => `${workflow} executa aquest flux, així que no s’hi pot executar a dins.`,
        maxFromInput: ({ name }: { name: string }) => `Des de l’entrada · ${name}`,
        useInput: ({ name }: { name: string }) => `Fes servir l’entrada ${name}`,
    },
    backToRun: 'Torna a l’execució',
    reviewedCopyTitle: 'Revisa abans de desar',
    reviewedCopyBody: 'Aquesta és una còpia d’una execució. Es desen els passos i ajustos, no l’historial ni els resultats. El lloc, el tipus d’execució i els valors d’entrada són opcions de cada execució. Revisa les referències a sessions existents, carpetes, perfils, models, serveis i servidors MCP abans de reutilitzar-les.',
    chromeTitle: 'Flux de treball',
    untitled: 'Flux sense títol',
    nameLabel: 'Nom del flux',
    descriptionPlaceholder: 'Afegeix una descripció',
    descriptionLabel: 'Descripció',
    save: 'Desa',
    flow: 'Flux',
    flowSubtitle: 'Aquest esborrany com a mapa',
    settings: 'Configuració del flux',
    settingsSubtitle: 'Cada pas les fa servir tret que les canviï.',
    deleteWorkflow: 'Suprimeix el flux',
    deleteBody: 'Les execucions anteriors es queden a l’historial.',
    deleteFailedTitle: 'No s’ha pogut suprimir el flux',
    changedForStep: 'Canviat per a aquest pas',
    issuesToFix: ({ count }: { count: number }) => (count === 1 ? '1 cosa per corregir abans de poder executar' : `${count} coses per corregir abans de poder executar`),
    saveStatus: {
        notSaved: 'Encara no desat',
        unsaved: 'Canvis sense desar',
        saving: 'Desant…',
        saved: 'Desat',
        savedJustNow: 'Desat ara mateix',
        savedAge: ({ age }: { age: string }) => `Desat ${age}`,
        failed: 'No s’ha pogut desar',
        yourEdits: 'Els teus canvis',
        newerVersion: 'La versió més recent',
        newerVersionRevision: ({ revision }: { revision: string }) => `La versió més recent · ${revision}`,
    },
    where: {
        label: 'On s’executa',
        choose: 'Tria on s’executa',
    },
    sections: {
        whereTitle: 'On s’executa',
        machineAndProject: 'Màquina i projecte',
        eachStepRunsIn: 'Cada pas s’executa en',
        eachStepSession: 'Cada pas apareix a la teva llista de sessions, sota aquesta execució.',
        eachStepBackground: 'Cada pas s’executa en segon pla, sota aquesta execució.',
        aSession: 'Una sessió',
        aBackgroundRun: 'Una execució en segon pla',
        agentTitle: 'Agent i model',
        agentDescription: 'Els passos els fan servir tret que en triïn uns de propis.',
        rolesTitle: 'Rols per a aquest flux de treball',
        conversationTitle: 'Conversa i espai de treball',
        inputsTitle: 'Entrades i resultat',
    },
    unavailable: {
        machine_not_selected: 'Tria primer una màquina.',
        capability_unknown: 'Comprovant què admet aquesta màquina.',
        machine_does_not_support_detached_runs: 'Aquesta màquina encara no pot fer execucions en segon pla.',
    },
    /** Workflow settings and Step options (U-9): group summaries and the block subject. */
    inspector: {
        stepOptions: 'Opcions del pas',
        whereMissing: 'Cap màquina triada',
        none: 'Cap',
        inputCount: ({ count }) => count === 1 ? '1 entrada' : `${count} entrades`,
        finalOutput: ({ output }) => `Resultat final: ${output}`,
        originSession: 'La sessió que el va iniciar',
        differsFromWorkflow: 'difereix del flux de treball',
        followsWorkflow: 'fa servir la configuració del flux de treball',
        advancedTitle: 'Avançat',
        deadline: ({ ms }) => `Espera el resultat ${ms} ms`,
        workflowDefault: ({ value }) => `Valor del flux · ${value}`,
        aSession: 'Una sessió…',
        continues: ({ session }) => `Continua ${session}`,
        runsIn: 'S’executa a',
        runsInBoundBySession: 'Continua una sessió, així que s’executa en aquella sessió.',
        reviewTitle: 'Revisa abans de continuar',
        reviewDescription: 'Els passos següents d’aquest carril esperen fins que facis servir, editis o regeneris el resultat. La resta de la feina continua.',
        reviewEvaluator: 'Cada iteració espera la teva revisió.',
        reviewsBeforeContinuing: 'Revisa abans de continuar',
        resultTitle: 'Resultat',
        resultFromAction: ({ action }) => `Definit per ${action}`,
        resultFromWorkflow: ({ workflow }) => `Retorna el que retorna ${workflow}`,
        back: 'Enrere',
        options: 'Opcions',
        itemConversation: 'Una conversa per element; els passos de dins la comparteixen.',
        dropContinue: ({ session }) => `Continua ${session} en aquest pas`,
        dropRefused: ({ session, machine, where }) => `${session} és a ${machine}; aquest flux s’executa a ${where}.`,
        lanes: ({ count }) => `En paral·lel · ${count} carrils`,
        lane: ({ position }) => `Carril ${position}`,
        forEachIn: ({ source }) => `Per a cada element de ${source}`,
        atATime: ({ count }) => `${count} alhora`,
        repeatTimes: ({ count }) => `Repeteix ${count} vegades`,
        repeatUntil: ({ condition }) => `Repeteix fins que ${condition}`,
        repeatUntilDecided: 'Repeteix fins que un pas digui prou',
        ifSentence: ({ condition }) => `Si ${condition}`,
        onlyWhenSentence: ({ condition }) => `Només quan ${condition}`,
        conditionAll: 'es compleixen totes',
        conditionAny: 'se’n compleix alguna',
        conditionNot: ({ condition }) => `no (${condition})`,
        returnsStructured: 'Retorna dades estructurades',
        returnsDecision: 'Retorna una decisió',
    },
};

const workflowEditorPageTranslations = { ca } as const;

return { workflowEditorPageTranslations };
})();

const Domain_workflowExamplesTranslations = (() => {
type ExampleCopy = Shared_workflowExamplesTranslations.ExampleCopy;

type Copy = Shared_workflowExamplesTranslations.Copy;

const workflowExamplesTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "ca"> = { ca: {
        nodes: { ask: 'Preguntar', 'review-correctness': 'Revisar la correcció', 'review-tests': 'Revisar proves', summarize: 'Resumir troballes', analyze: 'Analitzar', review: 'Revisar', fix: 'Corregir', check: 'Comprovar', classify: 'Classificar', reply: 'Redactar una resposta', digest: 'Resumir canvis' },
        title: 'Comença amb un exemple', fromExample: 'D’un exemple', description: 'Cadascun s’obre com a esborrany. Res no s’executa fins que triïs Executa ara.', use: 'Fes servir aquest', chooseSession: 'Tria una sessió…', builtInDescription: 'Part de Happier. Duplica’l per canviar-lo.', stepCount: ({ count }) => `${count} ${count === 1 ? 'pas' : 'passos'}`,
        askOnce: { title: 'Pregunta una vegada', description: 'Un pas: pregunta alguna cosa a un agent i rep-ne la resposta.' },
        reviewPullRequest: { title: 'Revisa un pull request', description: 'Dos revisors en paral·lel i després un resum amb totes les troballes.' },
        workThroughEachFile: { title: 'Treballa en cada fitxer', description: 'Per a cada fitxer d’una llista, un a un: analitza’l i revisa el canvi.' },
        repairUntilItPasses: { title: 'Repara fins que passi', description: 'Repara i comprova fins que passi o s’esgotin els intents permesos. Després revises l’última reparació.' },
        triageAnIssue: { title: 'Classifica una incidència', description: 'Classifica una incidència. Si és un error, corregeix-lo; si no, redacta una resposta.' },
        morningDigest: { title: 'Resum del matí', description: 'Resumeix els canvis del projecte i envia-te’ls. Afegeix un activador per rebre’l cada matí.' },
    } };

return { workflowExamplesTranslations };
})();

const Domain_workflowPluginTranslations = (() => {
type Copy = Shared_workflowPluginTranslations.Copy;

const en = Shared_workflowPluginTranslations.en;

const workflowPluginTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "ca"> = { ca: { fromPlugins: 'Dels connectors', readOnly: 'Només lectura · duplica a la teva biblioteca per editar', duplicateToLibrary: 'Duplica a la teva biblioteca' } };

return { workflowPluginTranslations };
})();

const Domain_workflowRunVisibilityTranslations = (() => {
type VisibilityCopy = Shared_workflowRunVisibilityTranslations.VisibilityCopy;

const workflowRunVisibilityTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', VisibilityCopy>, "ca"> = { ca: { title: "Visibilitat", chooseTeam: "Tria un equip", loadFailed: "No s’ha pogut comprovar qui pot veure aquesta execució", machines: "S’executa a les teves màquines", transcripts: "Els membres de l’equip poden veure les converses dels passos.", requiredSessionsEditable: "Els membres d’aquest equip poden editar-ne les sessions", visibleTo: ({ team }) => "Visible per a " + team } };

return { workflowRunVisibilityTranslations };
})();

const Domain_workflowRunCompositionTranslations = (() => {
const workflowRunVisibilityTranslations = {...Domain_workflowRunVisibilityTranslations.workflowRunVisibilityTranslations, ...EnglishFeatures.workflowRunVisibilityTranslations.workflowRunVisibilityTranslations};

const en = Shared_workflowRunCompositionTranslations.en;

const workflowRunCompositionTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "ca"> = { ca: { visibility: workflowRunVisibilityTranslations.ca, runWithAnotherAgent: 'Torna a executar amb un altre agent', agentForStep: ({ step }) => `Agent per a ${step}`, chooseAgent: 'Tria un agent o rol' } };

return { workflowRunCompositionTranslations };
})();

const Domain_workflowRunListTranslations = (() => {
type Progress = Shared_workflowRunListTranslations.Progress;

const en = Shared_workflowRunListTranslations.en;

const workflowRunListTranslations = { ca: {
        definitions: 'Definicions',
        stepsProgress: ({ completed, total }: Progress) => `${completed} de ${total} passos`,
        loopProgress: ({ completed, total }: Progress) => `${completed} de ${total} elements`,
        startedByAgent: 'Iniciat per un agent',
        startedByTrigger: 'Iniciat per un activador',
    } } satisfies Pick<Record<string, typeof en>, "ca">;

return { workflowRunListTranslations };
})();

const Domain_workflowRunRoleTranslations = (() => {
const en = Shared_workflowRunRoleTranslations.en;

const workflowRunRoleTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', typeof en>, "ca"> = { ca: { rolesTitle: 'Rols per a aquesta execució', rolesYour: 'Els teus rols', rolesChanged: ({ count }) => `${count} canviats per a aquesta execució`, rolesUnchanged: 'Tota la resta continua igual.', useYourRole: 'Fes servir el teu rol', targetsTitle: 'Cada pas s’executa en', rolesPrefillFailed: 'No s’han pogut llegir els rols de la teva última execució. Torna-ho a provar.' } };

return { workflowRunRoleTranslations };
})();

const Domain_workflowStartTranslations = (() => {
type Copy = Shared_workflowStartTranslations.Copy;

const workflowRunRoleTranslations = {...Domain_workflowRunRoleTranslations.workflowRunRoleTranslations, ...EnglishFeatures.workflowRunRoleTranslations.workflowRunRoleTranslations};

const workflowRunCompositionTranslations = {...Domain_workflowRunCompositionTranslations.workflowRunCompositionTranslations, ...EnglishFeatures.workflowRunCompositionTranslations.workflowRunCompositionTranslations};

const en = Shared_workflowStartTranslations.en;

const workflowStartTranslations: Pick<Record<'en'|'de'|'es'|'fr'|'it'|'pt'|'ca'|'pl'|'ru'|'ja'|'zhHans'|'zhHant', Copy>, "ca"> = { ca: { ...workflowRunRoleTranslations.ca, ...workflowRunCompositionTranslations.ca, neededNamed: ({ name }) => `Entrades · falta ${name}`, addToStart: ({ name }) => `Afegeix ${name} per iniciar`, workflow: 'Flux de treball', inputs: 'Entrades', start: 'Inicia', starting: 'S’està iniciant…', stillStarting: 'Encara s’està iniciant…', needed: ({ count }) => `Entrades · en falten ${count}`, required: 'Necessari per iniciar', preview: 'Què farà', unsaved: 'Inclou canvis sense desar', remove: 'Torna a una sessió normal', search: 'Cerca un flux', builtin: 'Integrats', library: 'La teva biblioteca', noInputs: 'No calen entrades', asksFor: ({ names }) => `Demana ${names}`, optional: 'Opcional — es deixa buit', defaultValue: ({ value }) => `Per defecte: ${value}` } };

return { workflowStartTranslations };
})();

const Domain_workflowsDestinationTranslations = (() => {
type WorkflowsDestinationTranslations = Shared_workflowsDestinationTranslations.WorkflowsDestinationTranslations;

const en = Shared_workflowsDestinationTranslations.en;

const ca: WorkflowsDestinationTranslations = {
    description: 'Receptes que els teus agents executen a les teves màquines: quan tu vulguis, segons un horari o quan passi alguna cosa.',
    import: 'Importa',
    addAccessibility: 'Afegeix un flux de treball',
    moreAccessibility: 'Més opcions dels fluxos de treball',
    addMenu: {
        newWorkflowSubtitle: 'Comença amb un esborrany en blanc',
        importSubtitle: 'Un fitxer JSON de flux de treball',
    },
    sections: {
        needsYou: 'Et necessita',
        running: 'En curs',
        library: 'Biblioteca',
        sharedWithYou: 'Compartits amb tu',
        triggers: 'Activadors',
        history: 'Historial',
    },
    allRuns: 'Totes les execucions',
    lastRun: ({ age }) => `darrera execució ${age}`,
    strip: {
        label: ({ count, parts }) => `${count === 1 ? 'Darrera execució' : `Darreres ${count} execucions`}: ${parts}`,
        labelPlain: ({ count }) => (count === 1 ? 'Darrera execució' : `Darreres ${count} execucions`),
        completed: ({ count }) => `${count} ${count === 1 ? 'completada' : 'completades'}`,
        failed: ({ count }) => `${count} amb error`,
        needsYou: ({ count }) => `${count} et ${count === 1 ? 'necessita' : 'necessiten'}`,
        separator: ', ',
    },
    runSettings: 'Configuració d’execució',
    libraryEmpty: 'Els fluxos de treball que desis apareixen aquí.',
    waitingForYou: ({ age }) => `T’espera · ${age}`,
    stateAge: ({ state, age }) => `${state} · ${age}`,
    triggerRow: ({ when, then }) => `${when} · ${then}`,
    thenSendPrompt: 'Envia una instrucció',
    thenRunWorkflow: 'Executa un flux de treball',
    offline: 'Sense connexió',
    off: 'Desactivat',
    columnLoadFailed: 'No s’han pogut carregar els fluxos de treball. No es perd res del que has desat.',
    firstVisitTitle: 'Desa les instruccions que funcionen i torna-les a executar',
    firstVisitBody: 'Un flux de treball és un conjunt de passos que els teus agents executen en ordre, en paral·lel o un cop per element: quan tu vulguis, segons un horari o quan passi alguna cosa.',
    importPrompt: 'Tens un fitxer de flux de treball?',
    loadMoreWorkflows: 'Carrega més fluxos de treball',
    searchPlaceholder: 'Cerca fluxos de treball',
    noMatch: ({ query }) => `Cap flux de treball coincideix amb «${query}»`,
    views: {
        all: 'Tots',
        triggered: 'Amb activador',
        active: 'Actives',
        needsYou: 'Et necessita',
        libraryAccessibility: 'Quins fluxos de treball mostrar',
        historyAccessibility: 'Quines execucions mostrar',
    },
    history: {
        title: 'Historial',
        description: 'Cada execució que has iniciat, sigui com sigui que va començar.',
        loadMore: 'Carrega més execucions',
        loadFailedTitle: 'No s’han pogut carregar les execucions',
        loadFailedBody: 'La teva feina no es veu afectada.',
        review: 'Revisa',
        rowMeta: ({ origin, machine, age }) => `${origin} · ${machine} · ${age}`,
    },
    rowMenu: {
        accessibility: 'Opcions del flux de treball',
        runNow: 'Executa ara',
        share: 'Comparteix…',
    },
    deleteTitle: 'Vols suprimir aquest flux de treball?',
    deleteBody: 'Les execucions anteriors es queden a l’Historial.',
    deleteFailedTitle: 'No s’ha pogut suprimir el flux de treball',
    exportFailedTitle: 'No s’ha pogut exportar el flux de treball',
    gate: {
        localTitle: 'Les automatitzacions estan desactivades en aquest dispositiu',
        localBody: 'Activa-les per executar fluxos de treball i els seus activadors.',
        dependencyTitle: 'Els fluxos de treball necessiten automatitzacions',
        dependencyBody: 'Activa les automatitzacions per crear i executar fluxos de treball.',
        openSettings: 'Obre la configuració',
    },
    runSettingsPage: {
        title: 'Configuració d’execució',
        description: 'Quantes execucions accepta cada màquina alhora i quant de temps es conserva l’historial.',
        saveFailed: 'No s’ha pogut desar la configuració d’execució. Els teus canvis encara hi són.',
    },
};

const workflowsDestinationTranslations = { ca } as const;

return { workflowsDestinationTranslations };
})();

const Domain_workflowTriggersTranslations = (() => {
type Count = Shared_workflowTriggersTranslations.Count;

type WorkflowTriggersCopy = Shared_workflowTriggersTranslations.WorkflowTriggersCopy;

const en = Shared_workflowTriggersTranslations.en;

const ca: WorkflowTriggersCopy = {
    pullRequest: {
        label: "Pull request",
        description: "Afegir aquest activador vincula la pull request a aquesta sessió.",
        empty: "Cap pull request oberta",
        loadFailed: "No s'han pogut carregar les pull requests",
    },
    summary: {
        everyDayAt: ({ time }) => `Cada dia a les ${time}`,
        weekdaysAt: ({ time }) => `Els dies feiners a les ${time}`,
        weeklyAt: ({ day, time }) => `Cada ${day} a les ${time}`,
        everyMinutes: ({ count }) => (count === 1 ? 'Cada minut' : `Cada ${count} minuts`),
        everyHours: ({ count }) => (count === 1 ? 'Cada hora' : `Cada ${count} hores`),
        cron: ({ expression }) => `Segons un horari · ${expression}`,
        schedule: 'Segons un horari',
        event: ({ event }) => `Quan passa ${event}`,
        manual: 'Manual',
        more: ({ first, count }) => `${first} · ${count} més`,
    },
    kind: {
        sessionStarts: 'Quan comença la sessió',
        sessionArchived: "Quan s'arxiva la sessió",
        schedule: 'Segons un horari',
        prComment: 'Quan algú comenta una pull request',
        ciFailed: 'Quan falla la CI en una pull request',
        turnEnds: 'Quan acaba un torn',
        needsYou: 'Quan la sessió et necessita',
        runEnds: 'Quan acaba l’execució',
        runNeedsYou: 'Quan l’execució et necessita',
    },
    row: {
        workflowDeleted: 'Flux eliminat',
        legacyCreated: 'Creat a Happier 0.2',
        legacyUnavailable: 'Activador antic no disponible',
        sessionKeyRequired: 'Cal la clau de la sessió',
        templateRecoveryRequired: 'Recupera aquest activador a Seguretat del compte',
        templateDecryptionFailed: 'No s’ha pogut desxifrar l’activador',
        machines: ({ count }: Count) => `${count} màquines`,
        nextRun: ({ time }: { time: string }) => `Propera execució: ${time}`,
        steps: ({ count }) => (count === 1 ? `${count} pas` : `${count} passos`),
        off: 'Desactivat',
        running: 'En curs',
        ran: ({ age }) => `S'ha executat ${age}`,
        turnOn: ({ name }) => `Activa ${name}`,
        turnOff: ({ name }) => `Desactiva ${name}`,
    },
    section: {
        add: 'Afegeix un activador',
        emptyTitle: 'Cap activador',
        emptyBody: 'Afegeix-ne un per revisar cada torn, continuar cap a un objectiu o reaccionar a la pull request.',
        loadFailed: "No s'han pogut carregar els activadors d'aquesta sessió.",
        title: 'Activadors',
        countOn: ({ count }) => `${count} actius`,
        info: 'El que s\'executa en aquesta sessió quan passa alguna cosa. Es queden amb aquesta sessió i no apareixen a la teva biblioteca.',
        saveFailed: 'No s\'ha pogut desar aquest activador. Els teus canvis encara hi són.',
    },    kindDescription: {
        turnEnds: "Després d'un torn teu o d'un agent amb qui treballes.",
        needsYou: "Sempre que aquesta sessió t'espera, també mentre la guia un flux o Continua fins acabar.",
        sessionArchived: "S'executa un cop, quan arxives aquesta sessió.",
        sessionStarts: 'Només en crear una sessió.',
        schedule: 'Continua aquesta sessió segons un horari.',
        prComment: "Només persones amb accés d'escriptura. El comentari es passa com a text citat.",
        pullRequestUnavailable: 'Encara no es poden afegir aquí activadors de pull requests.',
    },
    then: {
        runsIn: 'S\'executa a',
        runsInChoice: {
            newSession: 'Una sessió nova',
            session: 'Una sessió…',
            backgroundRun: 'Una execució en segon pla',
        },
        noSessionOnMachine: 'Encara no hi ha cap sessió en aquesta màquina',
        session: 'Sessió',
        action: 'Acció',
        label: 'Després',
        sendPrompt: 'Envia un prompt',
        doAction: 'Fes una acció',
        notifyMe: "Avisa'm",
        runWorkflow: 'Executa un flux',
        sendPromptDescription: "L'agent d'aquesta sessió rep aquest prompt en aquesta sessió. Mai no interromp el teu torn.",
        promptLabel: 'Prompt',
        promptPlaceholder: "Què ha de fer l'agent?",
        message: 'Missatge',
        title: 'Títol',
        sendTo: 'Envia a',
        sendToDefault: 'La teva configuració de notificacions',
        workflow: 'Flux',
        choose: 'Tria…',
    },
    popover: {
        saveAsWorkflow: 'Desa com a flux',
        saveAsWorkflowDescription: 'Obre aquests passos com un flux nou per revisar. Aquest activador conserva els seus passos.',
        when: 'Quan',
        newTrigger: 'Nou activador',
        addTrigger: "Afegeix l'activador",
        cancel: 'Cancel·la',
        done: 'Fet',
        turnOff: 'Desactiva',
        turnOn: 'Activa',
        deleteTrigger: "Elimina l'activador",
        repeat: 'Repeteix',
        everyDay: 'Cada dia',
        weekdays: 'Dies feiners',
        weekly: 'Setmanal',
        day: 'Dia',
        at: 'A les',
        expression: 'Horari',
        tryAgain: 'Torna-ho a provar',
    },    editor: {
        runsOn: 'S\'executa a',
        runsOnDescription: 'Tots els activadors d\'aquest flux s\'executen aquí.',
        runsOnAccountDescription: 'On s\'executa aquest activador.',
        runsOnDiffers: ({ where }) => `Executa ara fa servir ${where}.`,
        sameForAllTriggers: 'Igual per a tots els activadors',
        roles: 'Rols',
        retargetFailed: 'Flux desat · Activador no actualitzat',
        editInWorkflows: 'Canvia aquest activador a Fluxos. Continua funcionant tal com està.',
        title: 'S\'executa automàticament',
        runsBy: 'S\'executa sol quan passa una d\'aquestes coses.',
        runsByOn: ({ where }) => `S'executa sol quan passa una d'aquestes coses, a ${where}.`,
        savedWorkflow: 'Els activadors executen el flux desat.',
        saveToInclude: 'Els activadors executen el flux desat. Desa per incloure els teus canvis.',
        newRow: 'Nou · encara no afegit',
        partialSave: 'Flux desat · Activadors no actualitzats',
    },    column: {
        newTrigger: 'Nou activador',
        newTriggerSubtitle: 'Executa els seus passos segons un horari',
    },
};

const legacyTranslations = { ca: {
        editNotice: 'Creat a Happier 0.2. Obrir-lo no canvia res.',
        conversionBoundary: 'Després d’aquest canvi només s’executa en màquines amb Happier 0.3 o posterior.',
        channelReplyRefusal: 'Aquesta automatització té un vincle de resposta a un canal que no es pot transferir. No s’ha convertit; els ajustos i els teus canvis es conserven.',
        notAvailable: 'Aquesta automatització ja no està disponible.',
    } };

const creationTranslations = { ca: { savedWorkflowsUnavailable: 'Canvia al servidor d’aquesta sessió per triar un flux desat. Els fluxos integrats i els passos propis continuen disponibles.' } };

const workflowTriggersTranslations = { ca: { ...ca, legacy: legacyTranslations.ca, creation: creationTranslations.ca } } as const;

return { legacyTranslations, creationTranslations, workflowTriggersTranslations };
})();

const Domain_workflowValueReferenceTranslations = (() => {
const workflowValueReferenceTranslations = { ca: {
        checkoutRoot: 'Carpeta arrel del checkout',
        unavailableValue: 'Valor no disponible', sessionContext: ({ turns }: { turns: number }) => turns === 0 ? 'Context de la sessió' : `Últims ${turns} torns de la sessió`,
        tokensUsed: 'Tokens utilitzats', goalTokenBudget: 'Pressupost de tokens de l’objectiu',
        trailingCount: ({ source, value }: { source: string; value: string }) => `${source} consecutius amb ${value}`,
        stopCondition: 'Condició d’aturada complerta', stopConditionArm: ({ arm }: { arm: number }) => `Condició d’aturada ${arm} complerta`,
        roundLimit: ({ rounds }: { rounds: number }) => `Límit assolit · ${rounds} rondes`, decision: 'Decisió',
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

const ca = translated(workflowValueReferenceTranslations.ca, {
    title: 'Fluxos de treball',
    newWorkflow: 'Nou flux de treball',
    copyName: ({ name }: { name: string }) => `${name} còpia`,
    importJson: 'Importa JSON',
    exportJson: 'Exporta JSON',
    openCollection: 'Obre els fluxos de treball',
    destination: workflowsDestinationTranslations.ca,
    plugins: workflowPluginTranslations.ca,
    authoring: workflowAgentAuthoringTranslations.ca,
    page: workflowEditorPageTranslations.ca,
    actionTitles: workflowActionTranslations.ca,
    builtins: workflowBuiltinTranslations.ca,
    examples: workflowExamplesTranslations.ca,
    triggers: workflowTriggersTranslations.ca,
    start: workflowStartTranslations.ca,
    list: workflowRunListTranslations.ca,
    review: {
        publishedByAgent: 'Publicat per l’agent',
        publishedByYou: 'Publicat per tu',
        editedByYou: 'Editat per tu',
        editedByPerson: 'Editat per una altra persona',
        previousAttempt: 'Intent anterior',
        useBody: "Els passos següents reben exactament el que veus. Sense un torn de l’agent.",
        usePlanBody: "Accepta exactament aquest pla. Sense un torn de l’agent.",
        reportBackTitle: ({ session }) => "Informa a " + session,
        reportBackBody: ({ session }) => session + " rep el resultat d’aquesta execució quan acaba.",
        planRunNotice: "Executa el flux proposat tal com es mostra i accepta el pla. No el desa.",
        editedPlanBody: 'Aquest esborrany és diferent de la proposta. Vols acceptar primer el pla revisat per editar-lo? Els canvis es conserven aquí i no s’inicia res fins que tornis a executar l’esborrany.',
        title: "Resultat per revisar",
        planTitle: "Pla per revisar",
        waitTitle: "Esperant-te",
        waitBody: "Aquesta branca espera fins que continuïs.",
        editsTitle: "Els teus canvis sense desar",
        editsBody: "El resultat desat no canvia fins que l’utilitzis.",
        heldBody: "Esperant la teva revisió · encara no passat als passos següents",
        noValue: "Encara no hi ha cap resultat vàlid",
        useResult: "Utilitza aquest resultat",
        usePlan: "Utilitza aquest pla",
        useValues: "Utilitza aquests valors",
        continue: "Continua",
        invalid: "Corregeix primer el camp marcat.",
        newer: "Hi ha un resultat més recent.",
        showNewer: "Mostra el nou",
        keepMyEdits: 'Conserva els meus canvis',
        useNewer: 'Fes servir el nou',
        showFullResult: 'Mostra el resultat complet',
        showFullPlan: 'Mostra el pla complet',
        generationRequested: "Generació sol·licitada",
        startsResume: "Comença quan reprenguis l’execució.",
        generateBody: "L’agent escriu un resultat nou en aquesta conversa. Si és vàlid, l’execució continua sense tornar a preguntar.",
        acceptedPaused: "Utilitzar aquest resultat manté el flux en pausa.",
        editResult: "Edita el resultat",
        generate: "Genera el resultat i continua",
        discuss: "Conversa",
        discussBody: "Respon a la conversa d’aquest pas. L’agent pot publicar-hi un resultat actualitzat.",
        proposal: "Flux proposat",
        planStarted: "S’ha iniciat una execució d’aquest pla",
        earlierPlanStarted: "Ja s’ha iniciat una execució d’una proposta anterior",
        openEarlierPlanRun: "Obre aquella execució",
        runNewProposal: "Executa la nova proposta",
        runPlan: "Executa’l com a flux",
        runPlanBody: "Obre la revisió del flux proposat. Iniciar-lo també accepta aquest pla.",
        editPlan: "Edita primer el flux",
        editPlanBody: "Accepta aquest pla i obre el flux proposat com a esborrany sense desar.",
        editPlanFallback: "Accepta aquest pla i obre un flux d’un pas amb aquest pla com a instrucció.",
        waitingMachine: ({ machine }) => "Esperant " + machine,
    },

    tabs: {
        saved: 'Desats',
        runs: 'Execucions',
        steps: 'Passos',
        flow: 'Flux',
        map: 'Mapa',
        activity: 'Activitat',
    },
    tabsAccessibility: {
        savedRuns: 'Fluxos de treball desats o execucions',
        stepsFlow: 'Passos o flux',
        activityFlow: 'Activitat o flux',
        runViews: "Vistes de l’execució",
    },

    filters: {
        all: 'Tot',
        active: 'Actius',
        needsYou: 'Et necessita',
        clear: 'Esborra el filtre',
    },

    empty: {
        savedTitle: 'Encara no hi ha cap flux de treball desat',
        savedBody: 'En desar un flux de treball conserves una definició reutilitzable que pots executar o programar.',
        runsTitle: 'Encara no s’ha executat res',
        runsBody: 'Les execucions apareixen aquí tant si deses el flux de treball com si no.',
        filteredTitle: 'Cap execució coincideix amb aquest filtre',
        filteredBody: 'Esborra el filtre per veure la resta d’execucions.',
        missingTitle: 'Aquest flux de treball no està disponible',
        missingBody: 'Happier no ha pogut obrir el flux de treball al qual apunta aquest enllaç. La resta de fluxos, Automatitzacions i execucions no es veuen afectats.',
    },

    loadFailedTitle: 'No s’han pogut carregar els fluxos de treball',
    loadFailedBody: 'La teva feina no s’ha vist afectada. Torna-ho a provar quan vulguis.',
    retry: 'Torna-ho a provar',
    contentUnavailable: 'El contingut privat no està disponible en aquest dispositiu.',
    contentReasons: {
        invalidHeader: 'La informació desada d’aquest flux de treball no és vàlida.',
        revisionMismatch: 'Aquest flux de treball no coincideix amb la revisió desada.',
        missingBody: 'Falta la definició desada d’aquest flux de treball.',
        invalidBody: 'La definició desada d’aquest flux de treball no és vàlida.',
        notFound: 'Aquest flux de treball ja no està disponible.',
    },

    sessionEntry: {
        missingTitle: 'Aquesta sessió ja no està disponible',
        missingBody: 'Pot haver-se eliminat o ser en un altre Home. Obre Sessions per trobar-la.',
        inaccessibleTitle: 'No pots obrir aquesta sessió',
        inaccessibleBody: 'Happier no ha pogut confirmar l’accés. Torna a iniciar la sessió o demana-ho a qui n’és propietari i torna a obrir aquesta pàgina.',
        failedTitle: 'No s’ha pogut obrir aquesta sessió',
        failedBody: 'Happier continua provant-ho. Pots tornar-ho a provar ara.',
        unsupportedTitle: 'Aquesta sessió no pot iniciar un flux de treball',
        unsupportedBody: 'Happier no ha pogut llegir l’agent ni la màquina on s’executa. Crea el flux de treball des de Fluxos de treball.',
    },

    editor: {
        namePlaceholder: 'Nom del flux de treball',
        agentRuntime: 'Entorn d’execució de l’agent',
        firstPromptTitle: 'Què ha de passar primer?',
        firstPromptBody: 'Un sol prompt ja és un flux de treball. Afegeix passos quan els necessitis.',
        promptPlaceholder: 'Descriu què ha de fer aquest pas',
        useWorkflowDefault: 'Fes servir el valor del flux de treball',
        defaultsTitle: 'Valors per defecte',
        produces: 'Produeix',
        whereTitle: 'On',
        add: 'Afegeix',
        addAccessibility: 'Afegeix un bloc a aquest flux de treball',
        addStep: 'Pas d’agent',
        addParallel: 'En paral·lel',
        addLoop: 'Repeteix',
        addIf: 'Si',
        targetRequired: 'Tria la màquina i la carpeta del projecte per a aquest flux de treball.',
        loadingTitle: 'S’està obrint el flux de treball…',
        accountChangedTitle: 'Has canviat de compte',
        accountChangedBody: 'Aquest flux de treball el va obrir el compte anterior i no es pot traslladar. Torna a obrir-lo des de Fluxos de treball.',
        loadFailedTitle: 'No s’ha pogut obrir aquest flux de treball',
        loadFailedBody: 'Ara mateix no s’ha pogut llegir el flux de treball desat.',
        timeoutTitle: 'Espera del resultat (ms)',
        noDeadline: 'Sense termini',
        timeoutExplain: 'Mil·lisegons d’espera del resultat d’aquest pas abans que necessiti atenció. Deixa-ho buit per no fixar termini.',
        wholeNumberRequired: 'Introdueix un nombre enter d’almenys 1.',
        runNow: 'Executa ara',
        save: 'Desa el flux de treball',
        saveAutomation: 'Desa l’Automatització',
        schedule: 'Programa',
        savedRevision: ({ revision }) => `Desat · ${revision}`,
        moveUp: 'Mou amunt',
        moveDown: 'Mou avall',
        moveIn: 'Mou dins del grup de sobre',
        moveOut: 'Treu d’aquest grup',
        remove: 'Elimina',
        undo: 'Desfés',
        redo: 'Refés',
        historyRestoreRequiresSetup: 'Cal configurar aquest esdeveniment de nou. La configuració privada desada no es pot restaurar després d’eliminar-lo.',
        history: { edited: 'Edita el workflow', agent: 'Canvi de l’agent', description: 'Edita la descripció', where: 'Canvia on s’executa', target: 'Canvia l’execució dels passos', triggers: 'Edita els activadors', example: 'Insereix un exemple', document: 'Edita la petició' },
        undoAction: ({ change }: { change: string }) => `Desfés: ${change}`,
        redoAction: ({ change }: { change: string }) => `Refés: ${change}`,
        removedBlock: ({ block }) => `${block} eliminat`,
        rename: 'Canvia el nom',
        stepOrdinal: ({ position }) => `${position}`,
        unnamedStep: ({ position }) => `Pas ${position}`,
        unnamedParallel: 'Grup paral·lel',
        unnamedLoop: 'Bucle',
        unnamedIf: 'Condició',
        branch: 'Branca',
        addBranch: 'Afegeix una branca',
        ifTrue: 'Si es compleix',
        otherwise: 'Si no',
        addOtherwise: 'Afegeix una branca «si no»',
        evaluator: 'Decidir si continuar',
        loopBody: 'Repeteix aquests passos',
        continuation: 'Després de cada ronda',
    },

    input: {
        label: 'Entrada',
        result: 'Resultat',
        change: 'Canvia',
        none: 'Sense entrada',
        previousResult: ({ block }) => `Resultat de ${block}`,
        workflowInput: ({ name }) => `Entrada del flux de treball ${name}`,
        currentItem: 'L’element actual',
        iteration: 'Aquesta ronda',
        unavailable: 'Aquesta font ja no està disponible',
        itemField: {
            value: 'Valor de l’element',
            index: 'Índex de l’element, des de 0',
            position: 'Posició de l’element, des d’1',
            count: 'Nombre d’elements',
        },
        iterationField: {
            index: 'Índex de la ronda, des de 0',
            position: 'Número de la ronda, des d’1',
            count: 'Nombre de rondes',
            stopReason: 'Motiu de l’aturada',
        },
        valueKindGroup: 'Origen del valor',
        inputNameGroup: 'Entrada del flux',
        producerGroup: 'Pas d’origen',
        workspaceFieldGroup: 'Camp de l’espai de treball',
        itemFieldGroup: 'Camp de l’element',
        iterationFieldGroup: 'Camp de la ronda',
    },

    inputs: {
        title: 'Entrades del flux de treball',
        addInput: 'Afegeix una entrada',
        namePlaceholder: 'Nom',
        descriptionPlaceholder: 'Per a què serveix?',
        required: 'Obligatori',
        optional: 'Opcional',
        defaultValue: 'Valor per defecte',
        typeString: 'Text lliure',
        typeNumber: 'Nombre',
        typeBoolean: 'Sí o no',
        typeJson: 'Dades estructurades',
        runSheetTitle: 'Executa aquest flux de treball',
        runSheetBody: 'Dona els valors que declara aquest flux de treball i executa’l.',
        missingRequired: 'Aquest valor és obligatori.',
        wrongType: ({ type }) => `Aquest valor ha de ser de tipus ${type}.`,
    },

    finalOutput: {
        title: 'Resultat final',
        none: 'No s’ha seleccionat cap resultat final',
        change: 'Canvia',
        clear: 'Esborra la selecció',
        fieldPath: 'Camí del camp',
        explain: 'El resultat final és el que retorna aquest flux de treball quan acaba. L’ordre en què s’acaben les coses no el canvia mai.',
    },

    conversation: {
        title: 'Conversa',
        sharedRun: 'La mateixa conversa',
        branchesShareAndTakeTurns: 'Les branques comparteixen una conversa i s’alternen.',
        fresh: 'Converses separades',
        fromStep: ({ block }) => `Continua ${block}`,
        existingSession: 'Una sessió existent',
        existingSessionById: ({ sessionId }) => `Sessió ${sessionId}`,
        noExistingSessions: 'Cap sessió d’aquesta màquina es pot continuar aquí.',
        chooseExistingSession: 'Tria una sessió per continuar',
        continuingKeepsAgentAndFolder: 'Continuar manté l’Agent i la carpeta d’aquesta conversa. Un altre Agent o una altra carpeta necessita una conversa separada.',
        waitingForConversation: ({ block }) => `S’espera que ${block} acabi en aquesta conversa.`,
        branchesUseSeparate: 'Les branques d’un grup paral·lel fan servir converses separades.',
    },

    workspace: {
        title: 'Espai de treball',
        inherit: 'Espai de treball del flux',
        projectCheckout: 'Carpeta del projecte',
        fromStep: ({ block }) => `Continua a l’espai de treball de ${block}`,
        newWorktreeOriginal: 'Arbre de treball nou a partir de la carpeta original',
        newWorktreeWorkflow: 'Arbre de treball nou a partir de l’espai de treball del flux',
        newWorktreeStep: ({ block }) => `Arbre de treball nou a partir de ${block}`,
        committedOnlyNote: 'Un arbre de treball nou conté l’estat validat de la carpeta d’origen. Els canvis preparats, no validats i no seguits es queden a l’origen.',
        reuseNote: 'Quan es continua en un espai de treball, aquest hi veu els fitxers no validats exactament tal com són.',
        sharedParallelNote: 'Les branques que comparteixen un espai de treball hi poden escriure alhora.',
        unavailable: ({ block }) => `L’espai de treball de ${block} no està disponible.`,
        unavailableBody: 'Restaura’l per continuar aquesta execució, o revisa una execució nova que pot repetir feina ja acabada.',
        unavailableRestoreBody: 'Restaura’l per continuar aquesta execució amb la feina ja acabada intacta.',
        unavailableNewRunBody: 'No es pot restaurar. Una execució nova revisada comença de zero i la feina ja acabada es pot repetir.',
        restore: 'Restaura',
        inspect: 'Inspecciona',
    },

    condition: {
        onlyWhen: 'Executa només quan',
        always: 'Sempre',
        stopWhen: 'Atura quan',
        ifWhen: 'Executa la primera branca quan',
        addCondition: 'Afegeix una condició',
        removeCondition: 'Elimina la condició',
        allOf: 'Totes aquestes',
        anyOf: 'Qualsevol d’aquestes',
        not: 'No',
        exists: 'té un valor',
        operatorEq: 'és',
        operatorNeq: 'no és',
        operatorLt: 'és menor que',
        operatorLte: 'és com a màxim',
        operatorGt: 'és major que',
        operatorGte: 'és com a mínim',
        valuePlaceholder: 'Valor',
        skippedReason: ({ block }) => `Omès perquè la condició de ${block} era falsa.`,
    },

    loop: {
        modeTitle: 'Repeteix',
        modeCount: 'Un nombre fix de vegades',
        modeItems: 'Un cop per cada element',
        modeUntil: 'Fins que un resultat digui que pari',
        modeEvaluate: 'Fins que un Agent digui que pari',
        count: 'Nombre de vegades',
        items: 'Llista',
        sequential: 'Elements en seqüència',
        parallel: 'Elements en paral·lel',
        maxConcurrentItems: 'Màxim d’elements simultanis',
        maxConcurrentBranches: 'Màxim de branques simultànies',
        noWorkflowLimit: 'El flux de treball no fixa cap límit',
        maxIterations: 'Màxim de rondes',
        limitReached: 'Límit assolit',
        historyTitle: 'Avaluacions anteriors',
        historyNone: 'Cap',
        historyLatest: 'L’última',
        historyAll: 'Totes',
        historyExplain: 'Això selecciona les decisions i els comentaris desats, no les transcripcions senceres.',
        continuingConversation: 'Aquest avaluador manté la conversa anterior i hi afegeix cada ronda nova.',
        emptyListCompletes: 'Una llista buida acaba sense cap ronda.',
    },

    failurePolicy: {
        title: 'Si un pas falla',
        failStop: 'Atura aquest grup si hi ha un error',
        failStopExplain: 'Aquest grup deixa d’iniciar feina i demana a les branques actives que s’aturin, també les independents. Els resultats i els canvis ja acabats es conserven. Això no és una reversió.',
        collectOutcomes: 'Acaba la feina independent',
        collectOutcomesExplain: 'Les branques sanes completen tota la seva cadena i es recull cada resultat. Els passos posteriors a un error dins d’una branca no s’executen.',
    },

    runState: {
        pending: 'Esperant per començar',
        queued: 'Esperant per començar',
        claimed: 'Començant',
        running: 'En execució',
        waiting_for_review: 'Esperant la teva revisió',
        succeeded: 'Completat',
        failed: 'Ha fallat',
        cancel_requested: 'Aturant-se',
        cancelled: 'Aturat',
        pause_requested: 'Posant-se en pausa',
        paused: 'En pausa',
        interrupted: 'Interromput',
        expired: 'Caducat abans de començar',
        dispatch_failed: 'No s’ha pogut començar',
        skipped: 'Omès',
        missed: 'Perdut',
        outcome_uncertain: 'Resultat incert',
        completed: 'Completat',
        completed_with_failures: 'Completat amb errors',
    },

    invocationState: {
        pending: 'Esperant',
        waiting_for_capacity: 'Esperant capacitat',
        admitting: 'Iniciant',
        running: 'En execució',
        waiting_for_approval: 'Esperant aprovació',
        waiting_for_review: 'Esperant la teva revisió',
        needs_attention: 'Et necessita',
        completed: 'Completat',
        failed: 'Ha fallat',
        skipped: 'Omès',
        cancel_requested: 'Aturant-se',
        cancelled: 'Aturat',
        outcome_uncertain: 'Resultat incert',
        superseded: 'Substituït per un intent posterior',
    },

    run: {
        title: 'Execució',
        frozenVersion: "Aquesta execució utilitza la versió amb què va començar. Els canvis només afecten execucions futures.",
        selectOccurrence: 'Tria un pas',
        openReview: 'Revisa el resultat',
        open: 'Obre l’execució',
        openExact: ({ title }) => `Obre l’execució ${title}`,
        openExecution: 'Obre l’execució en segon pla',
        loadMore: 'Carrega passos anteriors',
        origin: {
            direct: 'Iniciada directament',
            automation: 'Programada',
            fromSession: 'Des d’una sessió',
        },
        needsYou: 'Et necessita',
        needsYouLoadedCount: 'carregats',
        review: 'Revisa',
        stop: 'Atura',
        stopAgain: 'Atura de nou',
        stopping: 'Aturant-se…',
        stopRequested: ({ machine }) => `S’ha demanat l’aturada. S’espera la confirmació de ${machine}.`,
        evidenceStale: 'Es mostren els darrers detalls coneguts. Happier no ha pogut confirmar que siguin actuals.',
        pauseAtBoundary: 'Fes una pausa al proper límit',
        pausePending: 'Acaba la feina en curs i després es posa en pausa.',
        paused: 'En pausa després de l’últim límit completat.',
        resume: 'Reprèn',
        runAgain: 'Torna a executar el flux de treball',
        retryStep: 'Torna a provar el pas',
        attempt: ({ attempt }) => `Intent ${attempt}`,
        untitled: 'Execució del flux',
        openResult: 'Obre el resultat',
        inspectSteps: 'Inspecciona els passos',
        seeFailures: 'Mostra els errors',
        saveAsWorkflow: 'Desa com a flux de treball',
        saveAsNewWorkflow: 'Desa com a flux de treball nou',
        showCurrentWork: 'Mostra el treball actual',
        editWorkflow: 'Edita el flux de treball',
        openWorkflow: 'Obre el flux de treball',
        deleteHistory: 'Elimina l’historial d’execucions',
        deleteHistoryConfirm: 'Les entrades i els resultats s’eliminen. Els espais de treball, les converses, els fluxos de treball desats i les Automatitzacions es conserven.',
        technicalDetails: 'Detalls tècnics',
        technical: {
            runId: 'ID d’execució',
            invocationId: 'ID del pas',
            machine: 'Màquina',
            machineId: 'ID de la màquina',
            revision: 'Revisió',
        },
        usageUnavailable: 'Ús no disponible',
        startedAt: ({ time }: { time: string }) => `Iniciat ${time}`,
        timeRange: ({ start, end }) => `${start} – ${end}`,
        openConversation: 'Obre la conversa',
        openChildRun: 'Obre la seva execució',
        openStepDetails: 'Obre els detalls',
        outcomeLine: ({ word, sentence }: { word: string; sentence: string }) => `${word} — ${sentence}`,
        attentionReviewRow: ({ step }: { step: string }) => `${step} espera la teva revisió`,
        attentionWaitRow: ({ step }: { step: string }) => `${step} t’està esperant`,
        attentionReviewSentence: ({ step }: { step: string }) => `${step} espera la teva revisió.`,
        attentionWaitSentence: ({ step }: { step: string }) => `${step} t’està esperant.`,
        reviewing: 'Revisant',
        notStarted: 'Sense iniciar',
        machineUnavailable: ({ machine }) => `Aquesta execució ha perdut el contacte amb ${machine}.`,
        machineUnavailableBody: 'Les opcions per reprendre apareixeran quan se sàpiga l’estat actual.',
        completedCount: ({ count }) => `${count} ${count === 1 ? 'pas completat' : 'passos completats'}.`,
        completedWithFailures: ({ completed, failed }) =>
            `Completat amb errors. ${completed} ${completed === 1 ? 'completat' : 'completats'}; ${failed} no ${failed === 1 ? 'ha pogut' : 'han pogut'} acabar.`,
        approvalWanted: ({ block }) => `${block} vol executar una ordre.`,
        approvalWantedBody: 'Revisa-la per continuar.',
        capacityOccupied: 'Totes les places previstes al flux de treball estan ocupades.',
        openSourceSession: 'Obre la sessió d’on ve',
        observedActivity: 'Activitat observada',
        observedActivityBody: 'Happier pot veure les fases i els agents d’aquest agent, però no es va iniciar com un flux de treball gestionat, així que no es pot editar, desar ni tornar a executar.',
    },

    recovery: {
        title: 'Revisa la recuperació',
        reattach: 'Torna a connectar',
        reattachExplain: 'Observa la feina que ja s’està fent. No inicia res de nou.',
        resumeSameConversation: 'Reprèn',
        resumeSameConversationExplain: ({ block }) => `${block} pot continuar a la mateixa conversa.`,
        freshAgent: 'Continua amb un Agent nou',
        freshAgentExplain: 'Aquesta conversa no es pot continuar. L’espai de treball està disponible per a un Agent nou.',
        uncertainEffects: ({ block }) => `${block} s’ha aturat abans d’informar. Pot ser que ja hagi canviat l’espai de treball.`,
        acknowledgeEffects: 'Entenc que els canvis anteriors ja poden haver passat',
        waitingForStop: 'Esperant l’aturada o la confirmació',
        remainingNotStarted: ({ count }) => `${count} ${count === 1 ? 'pas relacionat encara no ha començat' : 'passos relacionats encara no han començat'}`,
        startReviewedRun: 'Inicia una execució nova revisada',
        editContinuation: 'Revisa o edita la continuació',
        continuationPlaceholder: 'Afegeix què ha de fer diferent aquest pas',
        useReplacementInput: 'Substitueix l’entrada del pas',
        repeatedEffectWarning: 'La feina ja acabada es pot repetir. L’execució original conserva el seu historial.',
    },

    unavailable: {
        title: 'Els fluxos de treball no estan disponibles',
        body: 'Els fluxos de treball no estan disponibles en aquest servidor, així que aquí no se’n pot crear ni executar cap.',
        conversion: 'Aquests canvis necessiten el format de flux de treball, i els fluxos de treball no estan disponibles en aquest servidor. Mantén aquesta automatització en un sol prompt o torna-ho a provar quan estiguin disponibles.',
        savedAutomation: 'Aquesta automatització s’executa com a flux de treball. Els passos desats no canvien; encara en pots editar el nom, la descripció i els activadors.',
    },
    conversion: {
        title: 'Aquests canvis necessiten el format de flux de treball',
        automationTarget: 'Flux de treball',
        body: 'Aquesta automatització encara executa un sol prompt al seu destí desat. En convertir-la es conserven les teves edicions i les properes execucions funcionaran com a flux de treball en una màquina concreta. Les execucions anteriors no canvien.',
        action: 'Converteix en flux de treball',
        machineRequired: 'Tria la màquina i la carpeta del projecte per a les properes execucions.',
    },
    save: {
        conflictTitle: 'S’ha desat una versió més nova',
        conflictBody: 'Les teves edicions continuen aquí.',
        compare: 'Compara',
        saveAsCopy: 'Desa’n una còpia',
        failedTitle: 'No s’ha pogut desar',
        failedBody: 'La teva feina local continua aquí.',
        deleteTitle: 'Vols eliminar aquest flux de treball?',
        deleteBody: 'Les Automatitzacions i les execucions existents no es veuen afectades i continuen funcionant.',
        unsupportedAttachment: 'Adjunta els fitxers amb una referència duradora abans de desar aquest flux de treball.',
        nameRequired: 'Posa un nom a aquest flux de treball abans de desar-lo.',
        runsCurrentDraft: 'Aquesta execució fa servir el flux de treball tal com és a la pantalla. No el desa.',
    },

    interchange: {
        importTitle: 'Importa un flux de treball',
        importBody: 'En importar s’obre un esborrany sense desar perquè el revisis. No executa ni programa res.',
        importIssuesTitle: 'Revisa aquest flux de treball',
        importIssuesBody: 'Algunes opcions necessiten la teva atenció abans de poder fer servir aquest flux de treball.',
        openRepairDraft: 'Obre l’esborrany per corregir',
        importFailedTitle: 'No s’ha pogut llegir aquest fitxer',
        importFailedInvalidJson: 'Aquest fitxer no és JSON vàlid.',
        importFailedUnsupportedVersion: 'Aquest fitxer fa servir una versió de flux de treball que aquesta aplicació no admet.',
        importFailedInvalidDocument: 'Aquest fitxer no és un flux de treball de Happier.',
        exportPrivacyNote: 'El fitxer exportat conté prompts i configuració. Mai no conté credencials ni resultats d’execucions.',
    },

    issue: {
        invalid_version: 'Aquest flux de treball fa servir una versió no admesa.',
        unknown_field: 'Aquest bloc té una opció que aquest flux de treball no admet.',
        invalid_id: 'Aquest bloc necessita un identificador vàlid.',
        duplicate_id: 'Dos blocs comparteixen el mateix identificador.',
        missing_reference: 'Aquesta entrada apunta a un bloc que ja no existeix.',
        invalid_reference_scope: 'Aquesta entrada apunta a un bloc que no acaba abans.',
        invalid_input: 'Aquest valor no és vàlid.',
        missing_required_input: 'Falta un valor obligatori.',
        invalid_result_contract: 'La configuració del resultat d’aquest pas no és vàlida.',
        invalid_condition: 'Aquesta condició no es pot comparar.',
        invalid_repetition: 'Aquest bucle no es pot repetir amb aquesta configuració.',
        invalid_max_concurrent: 'La concurrència màxima necessita un nombre enter d’almenys 1 i només s’aplica a la feina en paral·lel.',
        unsupported_persisted_attachment: 'Els fitxers adjunts han de tenir una referència duradora abans de desar.',
        conversation_workspace_mismatch: 'Aquesta conversa i aquest espai de treball no es poden continuar junts.',
        target_unavailable: 'Tria un Agent per a aquest flux de treball abans d’executar-lo.',
    },

    problem: {
        title: 'Això no ha funcionat',
        waitingTitle: 'Encara no és possible',
        subtreeDenied: 'Un agent només pot iniciar feina a la seva pròpia sessió o a les sessions que dirigeix.',
        roleTargetUnavailable: 'Aquest rol no es pot fer servir aquí.',
        roleRunsAsMismatch: 'La manera d’executar aquest rol no és compatible amb aquest pas. Tria un altre rol o canvia com s’executa el pas.',
        policyDeniedField: 'La configuració del teu agent no permet el paràmetre demanat per a la feina que inicia un agent.',
        permissionExceedsCeiling: 'Això necessita més permisos dels que té l’agent que ho ha iniciat.',
        workDepthExceeded: 'Això superaria el teu límit de delegació. Fes-ho en aquesta sessió o augmenta el límit a Configuració › Delegació.',
        definitionExceedsAuthority: 'L’agent no pot desar un flux de treball que pugui fer més del que l’agent mateix pot iniciar.',
        sourceUnavailable: 'Aquest flux de treball no està disponible, de manera que els seus activadors no es poden executar.',
        legacyConversionUnsupported: 'Aquesta automatització encara no es pot canviar aquí. Continua funcionant tal com està.',
        nativeGoalOwner: 'L’agent ja continua treballant cap als objectius pel seu compte en aquesta sessió.',
        sessionAlreadyStarted: 'Aquesta sessió ja ha començat. Els activadors d’inici de sessió només es poden afegir en crear una sessió.',
        generic: 'Happier no ha pogut completar aquesta petició del flux de treball. La teva feina no s’ha vist afectada.',
        needsRepair: 'Aquest flux de treball té paràmetres que cal arreglar abans de poder executar-lo.',
        targetUnavailable: 'La màquina o l’agent que necessita aquest flux de treball no està disponible ara mateix.',
        notFound: 'Aquesta execució ja no existeix.',
        accessDenied: 'No tens accés a aquesta execució.',
        conflict: 'Això ha canviat en un altre lloc. Actualitza per veure la versió actual; la teva feina local es conserva.',
        inputTooLarge: 'Aquesta entrada és massa gran per enviar-la. No s’ha canviat res.',
        unresolvedOutcome: 'Happier encara no pot confirmar que la feina anterior s’hagi aturat, així que no es pot substituir.',
        interactionCapacity: 'Aquesta conversa té massa coses en espera per acceptar-ne més ara mateix.',
        conversationUnavailable: 'Aquesta conversa no es pot continuar.',
        workspaceRestore: 'No s’ha pogut restaurar l’espai de treball. No s’ha canviat res.',
        waitSelfDependency: 'Això deixaria el flux de treball esperant la conversa que el va iniciar.',
        updateRequired: 'La màquina que ho executa necessita un Happier més nou per acceptar aquest pas.',
        ineligible: 'Aquesta execució ha avançat, així que ja no és possible.',
        custodyPending: 'Happier encara espera la confirmació de la màquina.',
        runFinished: 'Aquesta execució ha acabat.',
        checkpointUnavailable: 'No hi ha cap punt desat des d’on reprendre.',
        recoveryEvidenceRequired: 'Obre aquesta execució per veure’n les opcions de recuperació.',
        executionNotStarted: 'Encara no ha començat cap pas.',
        custodySettled: 'Aquesta execució ja està tancada.',
        unavailableHere: 'Això no està disponible ara mateix.',
    },

    a11y: {
        blockList: 'Blocs del flux de treball',
        stepContext: ({ block, position, total }) => `${block}, pas ${position} de ${total}`,
        groupContext: ({ group, block }) => `${block}, dins de ${group}`,
        inherited: 'fa servir la configuració del flux de treball',
        overridden: 'definit per a aquest pas',
        inserted: ({ block, position, total }) =>
            `${block} afegit a la posició ${position} de ${total}`,
        removed: ({ block, total }) =>
            `${block} eliminat. ${total === 1 ? 'Queda 1 bloc' : `Queden ${total} blocs`}`,
        reordered: ({ block, position, total }) =>
            `${block} mogut a la posició ${position} de ${total}`,
        validation: ({ reason }) => reason,
        validationInBlock: ({ block, reason }) => `${block}: ${reason}`,
        needsYou: ({ count }) =>
            `${count} ${count === 1 ? 'pas et necessita' : 'passos et necessiten'}`,
        needsYouLoaded: 'carregats',
        terminal: ({ state }) => state,
        terminalWithAttention: ({ state, count }) =>
            `${state}. ${count} ${count === 1 ? 'pas et necessita' : 'passos et necessiten'}`,
        selectedRowUpdated: ({ block }) => `${block} actualitzat`,
        progress: ({ count }) =>
            `${count} ${count === 1 ? 'pas actualitzat' : 'passos actualitzats'}`,
        progressLoaded: ({ count }) =>
            `${count} ${count === 1 ? 'pas actualitzat' : 'passos actualitzats'} fins ara`,
        progressWithAttention: ({ count, attention }) =>
            `${count} ${count === 1 ? 'pas actualitzat' : 'passos actualitzats'}; ${attention} ${attention === 1 ? 'et necessita' : 'et necessiten'}`,
        flowNode: ({ node, state }) => `${node}, ${state}`,
        editStep: 'Edita el pas',
        editBlock: 'Edita el bloc',
        commandRefused: ({ reason }) => `Encara no és possible. ${reason}`,
    },
});

const workflowTranslations = { ca } as const;

return { workflowTranslations };
})();

const Domain_workspaceBarTranslations = (() => {
type WorkspaceBarTranslation = Shared_workspaceBarTranslations.WorkspaceBarTranslation;

const en = Shared_workspaceBarTranslations.en;

const workspaceBarTranslations: Pick<Readonly<Record<'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant', WorkspaceBarTranslation>>, "ca"> = { ca: { workspaceBar: { tabsLabel: 'Pestanyes obertes', tabMenuLabel: 'Opcions de la pestanya', pinTab: 'Fixa la pestanya', unpinTab: 'Deixa de fixar la pestanya', splitRight: 'Divideix a la dreta', splitDown: 'Divideix cap avall', maximizePane: 'Maximitza el panell', restorePane: 'Restaura el panell', closeTab: 'Tanca la pestanya', closeOtherTabs: 'Tanca les altres pestanyes', closeTabsToRight: 'Tanca les pestanyes de la dreta', moreTabs: ({ count }) => (count === 1 ? '1 pestanya més' : `${count} pestanyes més`), searchTabs: 'Cerca pestanyes', splitPane: 'Divideix el panell actiu', openInNewTab: 'Obre en una pestanya nova', openToRight: 'Obre a la dreta', openBelow: 'Obre a sota', newTab: 'Pestanya nova' } } };

return { workspaceBarTranslations };
})();

const Domain_workspaceSyncDiagnosticTranslations = (() => {
type WorkspaceSyncDiagnosticTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncDiagnosticTranslation;

type WorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslation;

type WorkspaceSyncLocale = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncLocale;

type WorkspaceSyncTranslationCore = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncTranslationCore;

type WorkspaceSyncReviewBase = Shared_workspaceSyncDiagnosticTranslations.WorkspaceSyncReviewBase;

const completeWorkspaceSyncTranslation = Shared_workspaceSyncDiagnosticTranslations.completeWorkspaceSyncTranslation;

const workspaceSyncDiagnosticTranslations = { ca: {
        diagnostics: { title: 'Diagnòstic', relationshipId: 'ID de la relació', controllerMachineId: 'ID de l’ordinador controlador', alphaMachineId: 'ID de l’ordinador d’origen', betaMachineId: 'ID de l’ordinador de destinació', alphaRoot: 'Carpeta d’origen actual', betaRoot: 'Carpeta de destinació actual', engineMode: 'Mode del motor', engineState: 'Estat del motor', errorCode: 'Codi d’error' },
        error: { updateRequired: 'Actualitza Happier a l’ordinador d’origen abans de tornar a provar aquest traspàs de l’espai de treball. Les altres accions de sessions i ordinadors continuen disponibles.' },
        resolve: { title: 'Vols resoldre el conflicte de l’espai de treball?', body: ({ path, side }) => `Vols conservar la versió «${side}» de la carpeta ${path}? L’altra carpeta i tot el que només existeixi dins seu s’eliminaran després de verificar-ne l’estat actual.`, unverifiedFile: 'No es pot eliminar de manera segura una versió sense una empremta actual del fitxer. Actualitza el conflicte i torna-ho a provar.' },
    } } as const satisfies Pick<Record<string, WorkspaceSyncDiagnosticTranslation>, "ca">;

const workspaceSyncSetAttentionTranslations = { ca: { attention: { conflictedLinks: ({ count }) => `${count} ${count === 1 ? 'enllaç té' : 'enllaços tenen'} conflictes`, unavailableLinks: ({ count }) => `Revisa l’estat de ${count} ${count === 1 ? 'enllaç' : 'enllaços'}` } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'attention'>>, "ca">;

const workspaceSyncAddMachineTranslations = { ca: { availableOn: 'Disponible a', addMachine: { replica: 'Rèplica', exactReplica: 'Rèplica exacta', editableCopy: 'Còpia editable', editableCopyHint: 'Els canvis als ordinadors enllaçats poden ser visibles per als agents dels altres. Cal revisar les versions en conflicte. Fes servir arbres de treball separats quan vulguis aïllament.' } } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation, 'availableOn' | 'addMachine'>>, "ca">;

const workspaceSyncReviewOutcomeTranslations = { ca: { keepBoth: 'Conserva les dues versions', preserveAt: ({ path }) => `Conserva una altra versió a ${path}`, notReviewed: 'Sense revisar; aquí no es farà cap canvi', confirmScope: 'Només es canviaran els espais de treball revisats de la llista. Els no disponibles quedaran intactes.', preserved: 'Conservat', alreadyPresent: 'Ja existeix', notStarted: 'No iniciat', askAgent: 'Pregunta a un agent', askAgentPrompt: ({ path, versions }) => `Ajuda’m a revisar les versions en conflicte de ${path} en aquests espais de treball enllaçats:\n${versions}\nExamina els fitxers actuals i suggereix una solució segura. No canviïs ni resolguis el conflicte sense la meva aprovació.` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'keepBoth' | 'preserveAt' | 'notReviewed' | 'confirmScope' | 'preserved' | 'alreadyPresent' | 'notStarted' | 'askAgent' | 'askAgentPrompt'>>, "ca">;

const workspaceSyncCoverageIncompleteTranslations = { ca: 'Hi ha enllaços o extrems sense revisar. Els conflictes carregats continuen visibles; només es poden resoldre les versions disponibles revisades explícitament.' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['coverageIncomplete']>, "ca">;

const workspaceSyncReviewLifecycleTranslations = { ca: { requestingApproval: 'Sol·licitant l’aprovació…', applying: 'Aplicant els canvis revisats…', propagationExpected: ({ names }) => `S’espera la propagació a ${names}`, propagationUnverified: ({ names }) => `Encara no es pot verificar la propagació a ${names}` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'requestingApproval' | 'applying' | 'propagationExpected' | 'propagationUnverified'>>, "ca">;

const workspaceSyncLocalOnlyTranslations = { ca: 'Aquesta ubicació alternativa es manté local al seu espai de treball' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['localOnly']>, "ca">;

const workspaceSyncKeepAlternativesTranslations = { ca: 'Conserva les alternatives' } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation['review']['keepAlternatives']>, "ca">;

const workspaceSyncReviewDecisionTranslations = { ca: { chooseTargets: 'Tria els espais de treball que vols substituir', notSelected: 'No seleccionat per a aquesta resolució', inspectCurrentVersions: 'Inspecciona les versions actuals' } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'chooseTargets' | 'notSelected' | 'inspectCurrentVersions'>>, "ca">;

const workspaceSyncReviewTranslations: Pick<Record<WorkspaceSyncLocale, WorkspaceSyncReviewBase>, "ca"> = { ca: {
        executable: 'Executable', regular: 'No executable', applied: 'Aplicat', appliedPaused: 'Aplicat; sincronització en pausa', changed: 'Modificat abans d’aplicar', offline: 'Sense connexió; no aplicat', cancelled: 'Cancel·lat', unknown: 'Resultat desconegut; revisa aquest extrem', failed: 'Ha fallat; no aplicat', recoveryNeeded: 'Cal recuperar en aquesta ubicació', inspectionUnavailable: 'No s’han pogut revisar les versions actuals. Actualitza quan l’ordinador controlador estigui disponible.', coverageIncomplete: 'Hi ha enllaços o extrems sense revisar. Els conflictes carregats continuen visibles, però encara no es poden resoldre.', versions: 'Versions', comparison: 'Compara les versions seleccionades', linkDecisions: 'Selecció per enllaç', result: 'Resultat', confirmTitle: 'Vols fer servir aquesta versió?', confirmBody: ({ path, source, count }) => `Vols fer servir la versió de ${source} de ${path} en ${count} espais de treball més? Happier comprovarà totes les versions abans de canviar-les.`, useVersion: 'Fes servir la versió', useNamedVersion: ({ name }) => `Fes servir ${name}`, compareNamedVersion: ({ name }) => `Compara ${name}`, linkCount: ({ count }) => `${count} enllaços han indicat aquest camí`, moreOnLink: ({ name }) => `Carrega més de ${name}`,
    } };

const workspaceSyncReviewSelectionTranslations = { ca: { selectionIncluded: 'Inclòs per aquest enllaç', selectionExcluded: 'Exclòs per aquest enllaç', selectionUnknown: 'Selecció desconeguda', reasonRepositoryMetadata: 'Metadades del repositori', reasonSubmodule: 'Submòdul Git', reasonConfiguredRule: 'Regla configurada', reasonGitIgnore: 'Regla Git ignore', reasonEndpointUnavailable: 'Extrem no disponible', reasonSelectionUnavailable: 'Avaluador de selecció no disponible', configuredInclude: ({ pattern }) => `Patró d’inclusió: ${pattern}`, configuredExclude: ({ pattern }) => `Patró d’exclusió: ${pattern}`, completedLinks: ({ count }) => `${count} enllaços completats abans del bloqueig` } } satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, Pick<WorkspaceSyncTranslation['review'], 'selectionIncluded' | 'selectionExcluded' | 'selectionUnknown' | 'reasonRepositoryMetadata' | 'reasonSubmodule' | 'reasonConfiguredRule' | 'reasonGitIgnore' | 'reasonEndpointUnavailable' | 'reasonSelectionUnavailable' | 'configuredInclude' | 'configuredExclude' | 'completedLinks'>>, "ca">;

const ca = completeWorkspaceSyncTranslation({
    diagnostic: workspaceSyncDiagnosticTranslations["ca"],
    review: workspaceSyncReviewTranslations["ca"],
    selection: workspaceSyncReviewSelectionTranslations["ca"],
    outcome: workspaceSyncReviewOutcomeTranslations["ca"],
    lifecycle: workspaceSyncReviewLifecycleTranslations["ca"],
    decision: workspaceSyncReviewDecisionTranslations["ca"],
    coverage: workspaceSyncCoverageIncompleteTranslations["ca"],
    localOnly: workspaceSyncLocalOnlyTranslations["ca"],
    alternatives: workspaceSyncKeepAlternativesTranslations["ca"],
    addMachine: workspaceSyncAddMachineTranslations["ca"],
    attention: workspaceSyncSetAttentionTranslations["ca"],
}, {
    title: 'Sincronització de l’espai de treball',
    footer: 'L’estat prové de l’ordinador que gestiona aquesta relació. Els canvis només apareixen després que aquest ordinador els confirmi.',
    legacyRecovery: {
        title: 'Dades de sincronització retirades',
        footer: 'Happier només inspecciona i posa en quarantena aquestes dades retirades. No les elimina mai des de l’aplicació.',
        checking: 'S’estan comprovant els ordinadors…',
        inspectFailed: 'No s’han pogut comprovar alguns ordinadors. Les carpetes de quarantena ja trobades continuen visibles; torna-ho a provar quan aquests ordinadors siguin accessibles.',
        outdatedTitle: ({ machine }) => `${machine} utilitza una versió antiga de Happier`,
        outdatedBody: 'Aquesta versió no pot comprovar dades de sincronització retirades. Actualitza Happier en aquest ordinador i torna a inspeccionar aquí.',
        explanation: 'Aquest ordinador conté dades del motor de replicació retirat. Happier ha mogut les dades reconegudes a una quarantena privada i ha desactivat la sincronització per evitar que s’executi el motor antic.',
        quarantinePath: 'Carpeta de quarantena',
        openFolder: 'Obre la carpeta',
        offlineTitle: 'Elimina-les mentre Happier està fora de línia',
        offlineSteps: ({ path }) => `1. Atura tots els serveis en segon pla de Happier que puguin utilitzar aquestes dades.\n2. Elimina exactament aquesta carpeta amb el sistema operatiu: ${path}\n3. Reinicia els serveis i torna a inspeccionar aquí.`,
        unknown: ({ path, reason }) => `Happier no ha pogut classificar amb seguretat l’estat antic a ${path} (${reason}). La sincronització continua desactivada. Inspecciona aquest camí manualment; no l’eliminis des de l’aplicació.`,
        reinspect: 'Torna a inspeccionar',
    },
    none: 'No hi ha cap relació de sincronització',
    conflictsTitle: 'Conflictes de l’espai de treball',
    openConflicts: ({ count }) => `Revisa la sincronització en ${count} enllaços`,
    noConflicts: 'Cap conflicte',
    previewUnavailable: 'L’ordinador controlador no ha pogut proporcionar una previsualització segura. Actualitza el conflicte abans de tornar-ho a provar.',
    truncated: ({ count }) => `${count} ${count === 1 ? 'conflicte addicional no es mostra' : 'conflictes addicionals no es mostren'}`,
    unknownMode: 'Mode de sincronització no compatible',
    conflictCount: ({ count }) => `${count} ${count === 1 ? 'conflicte' : 'conflictes'}`,
    conflictKind: { file: 'Fitxer', directory: 'Carpeta', symlink: 'Enllaç simbòlic', missing: 'Absent', unsupported: 'Entrada no compatible' },
    mode: { copyOnce: 'Copia una vegada', keepSynced: 'Mantén actualitzat — recomanat', mirrorExactly: 'Reflecteix exactament', keepBothInSync: 'Mantén tots dos sincronitzats' },
    state: { loading: 'S’està comprovant l’estat…', starting: 'S’està preparant', watching: 'En vigilància', flushing: 'S’està sincronitzant', paused: 'En pausa', peerOffline: 'Fora de línia', conflicted: 'Conflictes', controllerUnavailable: 'Necessita atenció', engineUnavailable: 'Component no disponible', error: 'Necessita atenció', stopped: 'Aturat', working: 'S’està processant…' },
    lastChecked: ({ at }) => `Darrera comprovació: ${at}`,
    endpoint: { source: ({ label }) => `Origen · ${label}`, destination: ({ label }) => `Destinació · ${label}`, synced: ({ label }) => `Extrem sincronitzat · ${label}` },
    error: {
        componentUnavailable: 'La sincronització de l’espai de treball no està disponible en aquesta compilació. Instal·la el component necessari i torna-ho a provar.',
        machineOffline: 'L’ordinador de destinació no està disponible. Torna’l a connectar i torna-ho a provar.',
        destinationNeedsPreparation: 'Cal preparar la carpeta de destinació abans d’iniciar la sincronització.',
        gitPreparationFailed: 'Happier no ha pogut preparar aquest espai de treball Git. Revisa la destinació i torna-ho a provar.',
        authorizationExpired: 'L’autorització de l’espai de treball ha caducat. Torna a iniciar l’operació.',
        rootNoLongerAuthorized: 'La carpeta de l’espai de treball ha canviat i ja no està autoritzada. Revisa la relació abans de tornar-ho a provar.',
        conflictNeedsAttention: 'Aquest conflicte ha canviat. Actualitza’l abans de triar una versió.',
        needsAttention: 'La sincronització de l’espai de treball necessita atenció. Actualitza’n l’estat i torna-ho a provar.',
    },
    start: { blocked: {
        targetMachine: 'Tria un ordinador de destinació per continuar.',
        targetMachineOffline: 'Aquest ordinador no està disponible ara mateix. Torna’l a connectar i torna-ho a provar.',
        relationshipUnavailable: 'Aquesta relació de sincronització ja no inclou aquestes dues carpetes. Tria una altra opció per a l’espai de treball.',
        sourceFolder: 'La carpeta d’aquesta sessió no es pot sincronitzar amb seguretat. Tria «No moguis els fitxers» per transferir només la sessió.',
        destinationFolder: 'Tria una carpeta de destinació que es pugui sincronitzar amb seguretat.',
        workspaceOptions: 'Revisa les opcions de l’espai de treball abans de començar.',
    } },
    engine: { checking: 'S’està comprovant la sincronització en aquest ordinador…' },
    actions: { refresh: 'Actualitza l’estat', syncNow: 'Sincronitza ara', more: 'Accions de sincronització', pause: 'Posa en pausa', resume: 'Reprèn', terminate: 'Atura la sincronització', openOnMachine: ({ machine }) => `Obre a ${machine}`, openFolder: ({ label }) => `Obre la carpeta ${label}`, keepLocal: 'Conserva la versió local', keepRemote: 'Conserva la versió remota', keepNamed: ({ side }) => `Conserva la versió de ${side}` },
    terminate: { title: 'Vols eliminar la sincronització de l’espai de treball?', body: 'La sincronització s’aturarà i se n’eliminarà la relació. Els fitxers es mantindran als dos espais de treball.' },
    resolve: {
        changedTitle: 'El conflicte ha canviat',
        changedBody: 'Aquest conflicte ha canviat des que es va obrir. La llista s’ha actualitzat. Revisa les versions més recents abans de tornar a triar.',
        consequence: 'L’altra versió només s’eliminarà després que Happier verifiqui que el fitxer no ha canviat.',
        unsupported: 'Aquest conflicte conté una entrada del sistema de fitxers no compatible i no es pot resoldre a Happier. Elimina-la o substitueix-la a l’ordinador afectat i després actualitza.',
        keepHint: ({ side }) => `Conserva la versió de ${side} i elimina l’altra versió verificada.`,
    },
    fileState: { text: 'Previsualització del text', binary: 'Fitxer binari — previsualització no disponible', tooLarge: 'El fitxer és massa gran per previsualitzar-lo', missing: 'Falta el fitxer', changed: 'El fitxer ha canviat des que es va mostrar aquest conflicte' },
});

const workspaceSyncTranslations = { ca } as const satisfies Pick<Record<keyof typeof workspaceSyncDiagnosticTranslations, WorkspaceSyncTranslation>, "ca">;

return { workspaceSyncDiagnosticTranslations, workspaceSyncSetAttentionTranslations, workspaceSyncAddMachineTranslations, workspaceSyncReviewOutcomeTranslations, workspaceSyncCoverageIncompleteTranslations, workspaceSyncReviewLifecycleTranslations, workspaceSyncLocalOnlyTranslations, workspaceSyncKeepAlternativesTranslations, workspaceSyncReviewDecisionTranslations, workspaceSyncReviewTranslations, workspaceSyncReviewSelectionTranslations, workspaceSyncTranslations };
})();

const Domain_workspaceTabTranslations = (() => {
const en = Shared_workspaceTabTranslations.en;

const workspaceTabKeyboardTranslations = Shared_workspaceTabTranslations.workspaceTabKeyboardTranslations;

const workspaceTabTranslations = { ca: en };

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
